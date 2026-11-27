import { afterEach, expect, test } from "bun:test";
import { parseMoney } from "../src/money.ts";
import {
  acceptAndPost,
  journals,
  ONLINE_BOOK_WITH_ADJUSTMENTS,
  UNTAGGED_BOOK,
  uuid,
  type World,
  world,
} from "./stripe/slice-support.ts";

// biome-ignore lint/suspicious/noExplicitAny: test code reads replies by shape
type Json = any;

/** The sales-tax summary against a real book: the online-business chart (the sales tax account carries
 * the tax.sales role key), Stripe payouts synced from the fake Stripe and booked through the real
 * Inbox, and entries typed in. Every expected figure is read back through the public operations
 * (the journal register and the Inbox's own events) and summed in the test, not by the compiler. */

const open: World[] = [];
afterEach(() => {
  for (const w of open.splice(0)) w.close();
});

async function fresh(options: Parameters<typeof world>[0] = {}): Promise<World> {
  const w = await world({ realPort: true, ...options });
  open.push(w);
  return w;
}

const ok = (response: { status: number; body: Json }): Json => {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data;
};

/** Post one balanced entry the way a person does: save a draft, prepare it, commit the plan. */
async function post(
  w: World,
  date: string,
  lines: readonly (readonly [account: string, debit: string, credit: string])[],
  narration: string,
): Promise<void> {
  const draft = ok(
    await w.call(
      "drafts.create",
      {
        data: {
          date,
          reference: narration.slice(0, 40),
          narration,
          lines: lines.map(([accountId, debit, credit]) => ({ accountId, debit, credit })),
        },
      },
      uuid(),
    ),
  );
  const planId = uuid();
  const prepared = ok(
    await w.call("journal.prepare", { draftId: draft.id, expectedVersion: draft.version }, planId),
  );
  const committed = await w.call("operations.commit", { planId, planHash: prepared.planHash });
  expect(committed.body.data.disposition, JSON.stringify(committed.body)).toBe("committed");
}

/** A book with sales tax typed in (February), a payment to the state, and every Stripe payout of the
 * fixture booked through the Inbox (all in March). */
async function stripeBook(): Promise<World> {
  const w = await fresh({ book: ONLINE_BOOK_WITH_ADJUSTMENTS });
  await post(
    w,
    "2026-02-10",
    [
      ["1000", "112.00", ""],
      ["4000", "", "100.00"],
      ["2500", "", "12.00"],
    ],
    "Sale typed in",
  );
  await w.call("stripe.configure", {}, uuid());
  ok(await w.call("stripe.sync", {}, uuid()));
  const { posted } = await acceptAndPost(w);
  expect(posted.data).toMatchObject({ applied: 6, failed: 0 });
  await post(
    w,
    "2026-03-12",
    [
      ["2500", "5.00", ""],
      ["1000", "", "5.00"],
    ],
    "Payment to the state",
  );
  return w;
}

const month = (isoDate: string) => isoDate.slice(0, 7);

/** What the register shows on the sales tax account, by month, in cents: credits and debits. */
async function registerByMonth(w: World) {
  const byMonth = new Map<string, { collected: bigint; paid: bigint }>();
  const dateOf = new Map<string, string>();
  for (const entry of await journals(w)) {
    dateOf.set(entry.id, entry.isoDate);
    for (const line of entry.lines) {
      if (line.accountId !== "2500") continue;
      const slot = byMonth.get(month(entry.isoDate)) ?? { collected: 0n, paid: 0n };
      slot.collected += line.credit ? parseMoney(line.credit) : 0n;
      slot.paid += line.debit ? parseMoney(line.debit) : 0n;
      byMonth.set(month(entry.isoDate), slot);
    }
  }
  return { byMonth, dateOf };
}

/** The tax Stripe reported on each payout the Inbox booked, from the events' own legs, by month of
 * the journal that booked it, in cents with a credit negative. */
async function stripeLegsByMonth(w: World, dateOf: ReadonlyMap<string, string>) {
  const byMonth = new Map<string, bigint>();
  let payouts = 0;
  const page = ok(
    await w.call("inbox.list", {
      pageSize: 200,
      filter: { provider: "stripe", covered: false, status: ["posted"] },
    }),
  );
  for (const item of page.items) {
    payouts += 1;
    const date = dateOf.get(item.journalId);
    if (!date) throw new Error("a posted payout has no journal");
    let cents = 0n;
    for (const leg of item.line.legs ?? [])
      if (leg.role === "tax.sales") cents += parseMoney(leg.amount);
    byMonth.set(month(date), (byMonth.get(month(date)) ?? 0n) + cents);
  }
  return { byMonth, payouts };
}

const money = (cents: bigint): string => {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `${negative ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
};

test("the summary of a Stripe book is what the journals and Stripe's own tax figures say, month by month", async () => {
  const w = await stripeBook();
  const summary = ok(await w.call("taxSales.get", { taxYear: 2026 }));
  const { byMonth, dateOf } = await registerByMonth(w);
  const legs = await stripeLegsByMonth(w, dateOf);

  expect(summary.accounts).toEqual([
    expect.objectContaining({ code: "2500", name: "Sales tax payable" }),
  ]);
  expect(summary.period).toBe("month");
  expect(summary.periods).toHaveLength(12);

  let running = 0n;
  let collectedTotal = 0n;
  let paidTotal = 0n;
  for (const period of summary.periods) {
    const key = period.key as string;
    const slot = byMonth.get(key) ?? { collected: 0n, paid: 0n };
    expect(period.opening, key).toBe(money(running));
    expect(period.collected, key).toBe(money(slot.collected));
    expect(period.remitted, key).toBe(money(slot.paid));
    running += slot.collected - slot.paid;
    collectedTotal += slot.collected;
    paidTotal += slot.paid;
    expect(period.closing, key).toBe(money(running));
    // Stripe reported the tax on each payout it booked; the legs carry a credit as a negative.
    expect(period.stripeReported, key).toBe(money(-(legs.byMonth.get(key) ?? 0n)));
    // Nothing was changed after booking, so the account took exactly what Stripe reported.
    expect(period.stripeDifference, key).toBe("0.00");
  }
  expect([summary.opening, summary.collected, summary.remitted, summary.closing]).toEqual([
    "0.00",
    money(collectedTotal),
    money(paidTotal),
    money(running),
  ]);
  // The fixture has a charge with sales tax: the test exercises real figures.
  expect(collectedTotal).toBeGreaterThan(1200n);
  expect(summary.stripe).toMatchObject({ read: true, payouts: legs.payouts, salesTax: "stripe" });
  expect(summary.stripe.reported).toBe(
    money(-[...legs.byMonth.values()].reduce((a, b) => a + b, 0n)),
  );
  expect(summary.stripe.booked).toBe(summary.stripe.reported);

  // The balance is the account's balance on the balance sheet for the last day, and the figures are
  // from the same ledger population the statements of the same dates read.
  const report = ok(await w.call("reports.get", { asOf: "2026-12-31", from: "2026-01-01" }));
  const row = report.balanceSheet.rows.find((candidate: Json) => candidate.code === "2500");
  expect(row.amount).toBe(summary.closing);
  expect(report.populationHash).toBe(summary.ledgerPopulationHash);

  // What a person is told: no rates, no filing dates, nothing owed.
  expect(summary.statement).toContain("does not know your sales tax rates");
  expect(summary.disclaimer).toContain("does not give tax advice");
  expect(summary.warnings.map((warning: Json) => warning.code)).toContain("year_not_ended");
});

test("quarters and months of the same book add up, and each answer carries its population", async () => {
  const w = await stripeBook();
  const months = ok(await w.call("taxSales.get", { taxYear: 2026, period: "month" }));
  const quarters = ok(await w.call("taxSales.get", { taxYear: 2026, period: "quarter" }));
  expect(quarters.periods.map((period: Json) => period.key)).toEqual([
    "2026-Q1",
    "2026-Q2",
    "2026-Q3",
    "2026-Q4",
  ]);
  const sum = (periods: Json[], field: string, keys: string[]) =>
    periods
      .filter((period) => keys.includes(period.key))
      .reduce((total, period) => total + parseMoney(period[field]), 0n);
  expect(parseMoney(quarters.periods[0].collected)).toBe(
    sum(months.periods, "collected", ["2026-01", "2026-02", "2026-03"]),
  );
  expect(parseMoney(quarters.periods[0].remitted)).toBe(
    sum(months.periods, "remitted", ["2026-01", "2026-02", "2026-03"]),
  );
  expect(quarters.closing).toBe(months.closing);
  expect(quarters.populationHash).not.toBe(months.populationHash);
  // The same ledger population the statements of the same dates read, so an amount drills through.
  const report = ok(await w.call("reports.get", { asOf: "2026-12-31", from: "2026-01-01" }));
  expect(months.ledgerPopulationHash).toBe(report.populationHash);
});

test("the export is the same figures as a file, and the year-end pack carries the same two files", async () => {
  const w = await stripeBook();
  const summary = ok(await w.call("taxSales.get", { taxYear: 2026 }));
  const file = ok(await w.call("taxSales.export", { taxYear: 2026 }));
  expect(file.filename).toBe("sales-tax-2026.csv");
  expect(file.populationHash).toBe(summary.populationHash);
  expect(file.content).toContain(summary.populationHash);
  expect(file.content).toContain("2026-03");
  const postings = ok(await w.call("taxSales.export", { taxYear: 2026, file: "postings" }));
  expect(postings.filename).toBe("sales-tax-postings-2026.csv");
  // Every posting on the account is a row: the two typed entries (a credit and a debit) and the
  // payouts that carried tax.
  expect(
    postings.content.split("\r\n").filter((line: string) => line.includes("Payment to the state")),
  ).toHaveLength(1);
  expect(postings.content).toContain("Stripe payout");

  const pack = ok(await w.call("taxPack.build", { taxYear: 2026 }));
  const files = new Map<string, Json>(pack.files.map((entry: Json) => [entry.path, entry]));
  expect(files.get("tax/sales-tax.csv")?.content).toBe(file.content);
  expect(files.get("tax/sales-tax-postings.csv")?.content).toBe(postings.content);
  expect(files.get("tax/sales-tax.csv")?.population).toBe(summary.populationHash);
  // The manifest lists both with their hashes.
  const manifest = JSON.parse(files.get("manifest.json")?.content ?? "{}");
  expect(manifest.files.map((entry: Json) => entry.path)).toEqual(
    expect.arrayContaining(["tax/sales-tax.csv", "tax/sales-tax-postings.csv"]),
  );
  const check = pack.checks.find((entry: Json) => entry.key === "sales");
  expect(check).toMatchObject({ href: "/tax?tab=sales" });
  expect(["ok", "attention"]).toContain(check.status);
  expect(check.detail).toContain(summary.collected);
  expect(check.detail).toContain("does not know your rates");
  // The same check is on the checks screen.
  const checks = ok(await w.call("taxChecks.get", { taxYear: 2026 }));
  expect(checks.checks.find((entry: Json) => entry.key === "sales")).toEqual(check);
});

test("a book that does not tag the sales tax account is told what to do, and nothing is guessed", async () => {
  const w = await fresh({ book: UNTAGGED_BOOK });
  const summary = ok(await w.call("taxSales.get", { taxYear: 2026 }));
  expect(summary.accounts).toEqual([]);
  expect(summary.candidates).toEqual(
    expect.arrayContaining([
      { accountId: "2500", code: "2500", name: "Sales tax payable", suggested: true },
    ]),
  );
  expect([summary.opening, summary.collected, summary.remitted, summary.closing]).toEqual([
    "0.00",
    "0.00",
    "0.00",
    "0.00",
  ]);
  const pack = ok(await w.call("taxPack.build", { taxYear: 2026 }));
  const paths = pack.files.map((entry: Json) => entry.path);
  expect(paths).not.toContain("tax/sales-tax.csv");
  expect(paths).not.toContain("tax/sales-tax-postings.csv");
  const check = pack.checks.find((entry: Json) => entry.key === "sales");
  expect(check).toMatchObject({ status: "unknown", href: "/accounts" });
  expect(check.detail).toContain("tax.sales");
  // The README still lists the check, in the words a person reads.
  const readme = pack.files.find((entry: Json) => entry.path === "README.md").content as string;
  expect(readme).toContain("**Sales tax** (could not be checked)");
});

test("a pinned book revision rebuilds the earlier summary exactly after the book changes", async () => {
  const w = await stripeBook();
  const first = ok(await w.call("taxSales.get", { taxYear: 2026 }));
  await post(
    w,
    "2026-03-13",
    [
      ["1000", "21.60", ""],
      ["4000", "", "20.00"],
      ["2500", "", "1.60"],
    ],
    "Another sale typed in",
  );
  const later = ok(await w.call("taxSales.get", { taxYear: 2026 }));
  expect(later.collected).not.toBe(first.collected);
  expect(later.bookRevision).not.toBe(first.bookRevision);
  const pinned = ok(await w.call("taxSales.get", { taxYear: 2026, revision: first.bookRevision }));
  expect(pinned).toEqual(first);
});

test("a change to the tags moves the population and a pinned tags revision restores it", async () => {
  const w = await stripeBook();
  const first = ok(await w.call("taxSales.get", { taxYear: 2026 }));
  // Move the role key off the account: nothing is tagged any more.
  ok(
    await w.call(
      "accounts.setTags",
      { accountId: "2500", effectiveOn: "2026-01-01", tags: { roleKey: null } },
      uuid(),
    ),
  );
  const after = ok(await w.call("taxSales.get", { taxYear: 2026 }));
  expect(after.accounts).toEqual([]);
  expect(after.populationHash).not.toBe(first.populationHash);
  const pinned = ok(
    await w.call("taxSales.get", { taxYear: 2026, tagsRevision: first.tagsRevision }),
  );
  expect(pinned).toEqual(first);
});

test("only supported years, real periods and real dates are accepted, and a reader needs only read permission", async () => {
  const w = await stripeBook();
  const refusal = await w.call("taxSales.get", { taxYear: 2024 });
  expect(refusal.status).toBe(400);
  expect(refusal.body.error.code).toBe("tax_year_unsupported");
  expect((await w.call("taxSales.get", { taxYear: 2026, period: "week" })).status).toBe(400);
  expect((await w.call("taxSales.get", { taxYear: 2026, from: "2026-02-30" })).status).toBe(400);
  expect(
    (await w.call("taxSales.get", { taxYear: 2026, from: "2026-06-01", to: "2026-05-01" })).status,
  ).toBe(400);
  expect((await w.call("taxSales.get", { taxYear: 2026 }, undefined, ["read"])).status).toBe(200);
  expect((await w.call("taxSales.export", { taxYear: 2026, file: "everything" })).status).toBe(400);
});

import { afterEach, expect, test } from "bun:test";
import {
  chartCsv,
  type LedgerRow,
  type Transaction,
  transactionsCsv,
  trialBalanceCsv,
} from "../shadow-xero-fixtures.ts";
import { closeShadowFixtures, type Json, type ShadowFixture, shadowFixture } from "./support.ts";

afterEach(closeShadowFixtures);

/** A book that cut over on 2026-10-01 with a checking account, a card and some equipment, and has an
 * October of four entries, as the checklist's tests have. */
async function october(f: ShadowFixture) {
  await f.ok("cutover.set", { cutoverDate: "2026-10-01", accountIds: ["1000", "2000"] });
  const plan = await f.ok("opening.plan", {
    cutoverDate: "2026-10-01",
    balances: [
      { accountId: "1000", balance: "10000.00" },
      { accountId: "2000", balance: "500.00" },
      { accountId: "1500", balance: "2000.00" },
    ],
  });
  await f.ok(
    "operations.commit",
    { planId: plan.plan.planId, planHash: plan.plan.planHash },
    plan.plan.planId,
  );
  await f.post("2026-10-05", "Customer payment", [
    ["1000", "1000.00", ""],
    ["4000", "", "1000.00"],
  ]);
  await f.post("2026-10-12", "Hosting", [
    ["6000", "250.00", ""],
    ["1000", "", "250.00"],
  ]);
  await f.post("2026-10-20", "Domain", [
    ["6000", "49.99", ""],
    ["1000", "", "49.99"],
  ]);
  await f.post("2026-10-10", "Software on the card", [
    ["6000", "80.00", ""],
    ["2000", "", "80.00"],
  ]);
}

/** Xero's ledger for the same business, with names the book's chart has so the mapping finds them.
 * Amounts are debit-positive cents. A card is a bank account in Xero. */
function ledgerAt(
  month: "september" | "october",
  overrides: Readonly<Record<string, bigint>> = {},
): LedgerRow[] {
  const october = month === "october";
  const values: Record<string, bigint> = {
    "090": october ? 1_070_001n : 1_000_000n,
    "092": october ? -58_000n : -50_000n,
    "710": 200_000n,
    "200": october ? -100_000n : 0n,
    "469": october ? 37_999n : 0n,
    ...overrides,
  };
  const rows: LedgerRow[] = [
    {
      code: "090",
      name: "Business checking",
      type: "Bank",
      section: "Assets",
      month: 0n,
      ytd: values["090"] ?? 0n,
      bank: true,
    },
    {
      code: "710",
      name: "Equipment",
      type: "Fixed Asset",
      section: "Assets",
      month: 0n,
      ytd: values["710"] ?? 0n,
    },
    {
      code: "092",
      name: "Business credit card",
      type: "Bank",
      section: "Liabilities",
      month: 0n,
      ytd: values["092"] ?? 0n,
      bank: true,
    },
    {
      code: "200",
      name: "Sales",
      type: "Revenue",
      section: "Revenue",
      month: 0n,
      ytd: values["200"] ?? 0n,
    },
    {
      code: "469",
      name: "Software and subscriptions",
      type: "Expense",
      section: "Expenses",
      month: 0n,
      ytd: values["469"] ?? 0n,
    },
  ];
  const ytd = rows.reduce((sum, row) => sum + row.ytd, 0n);
  rows.push({
    code: "960",
    name: "Retained Earnings",
    type: "Retained Earnings",
    section: "Equity",
    month: 0n,
    ytd: -ytd,
  });
  return rows;
}

const tx = (date: string, source: string, description: string, net: bigint): Transaction => ({
  date,
  source,
  description,
  reference: "",
  net,
});

/** October's account transactions as Xero lists them; `without` drops a line from every account it is on. */
function transactions(without: readonly string[] = []): string {
  const keep = (lines: Transaction[]) =>
    lines.filter((line) => !without.includes(line.description));
  return transactionsCsv(
    [
      {
        heading: "Business checking (090)",
        lines: keep([
          tx("05 Oct 2026", "Receive Money", "Customer payment", 100_000n),
          tx("12 Oct 2026", "Spend Money", "Hosting", -25_000n),
          tx("20 Oct 2026", "Spend Money", "Domain", -4_999n),
        ]),
      },
      {
        heading: "Business credit card (092)",
        lines: keep([tx("10 Oct 2026", "Spend Money", "Software on the card", -8_000n)]),
      },
      {
        heading: "Sales (200)",
        lines: keep([tx("05 Oct 2026", "Receivable Invoice", "Customer payment", -100_000n)]),
      },
      {
        heading: "Software and subscriptions (469)",
        lines: keep([
          tx("12 Oct 2026", "Spend Money", "Hosting", 25_000n),
          tx("20 Oct 2026", "Spend Money", "Domain", 4_999n),
          tx("10 Oct 2026", "Spend Money", "Software on the card", 8_000n),
        ]),
      },
    ],
    { period: "1 October 2026 to 31 October 2026" },
  );
}

/** Import Xero's chart (mapped by name), its trial balances and the transactions. */
async function importXero(
  f: ShadowFixture,
  options: {
    without?: readonly string[];
    closing?: Readonly<Record<string, bigint>>;
    opening?: Readonly<Record<string, bigint>>;
  } = {},
) {
  await f.ok("xero.chart.import", { text: chartCsv(ledgerAt("october")), accept: "likely" });
  await f.ok("xero.trialBalance.import", {
    text: trialBalanceCsv({
      rows: ledgerAt("september", options.opening),
      asAt: "30 September 2026",
    }),
  });
  await f.ok("xero.trialBalance.import", {
    text: trialBalanceCsv({ rows: ledgerAt("october", options.closing), asAt: "31 October 2026" }),
  });
  await f.ok("xero.transactions.import", { text: transactions(options.without) });
}

const reconciledThrough = (f: ShadowFixture, date: string) =>
  f.ok("xero.reconciled.set", {
    choices: [
      { code: "090", through: date },
      { code: "092", through: date },
    ],
  });

const rowOf = (report: Json, code: string, period = 0): Json =>
  report.periods[period].accounts.find((account: { code: string }) => account.code === code);

test("books that agree match where Xero was reconciled, every account in its normal orientation", async () => {
  const f = await shadowFixture({ today: "2026-11-05" });
  await october(f);
  await importXero(f);
  await reconciledThrough(f, "2026-10-31");
  const report = await f.ok("tieout.report", {});
  expect(report.cutoverDate).toBe("2026-10-01");
  expect(report.periods).toHaveLength(1);
  const period = report.periods[0];
  expect([period.from, period.to, period.xeroReconciled]).toEqual([
    "2026-10-01",
    "2026-10-31",
    true,
  ]);
  // The opening entry is the book's starting point, not an event of the month, and Xero has no line
  // for it: it does not show as a difference.
  expect(rowOf(report, "1000")).toMatchObject({
    status: "matches",
    basis: "closing",
    xero: "10700.01",
    rastrata: "10700.01",
    difference: "0.00",
    carried: "0.00",
    matched: 3,
    unmatched: [],
    explained: false,
  });
  // A card is a liability: what it owes is positive, as the book shows it.
  expect(rowOf(report, "2000")).toMatchObject({
    status: "matches",
    xero: "580.00",
    rastrata: "580.00",
  });
  expect(rowOf(report, "4000")).toMatchObject({
    status: "matches",
    basis: "movement",
    xero: "1000.00",
  });
  expect(rowOf(report, "6000")).toMatchObject({ status: "matches", xero: "379.99", matched: 3 });
  expect(report.summary).toMatchObject({
    matches: 5,
    differs: 0,
    unexplained: 0,
    notComparable: 0,
  });
  // The equipment has no change in the month and the same balance: it matches too.
  expect(rowOf(report, "1500")).toMatchObject({ status: "matches", xero: "2000.00" });
});

test("a line in one book is the difference, listed, explained to the cent, and recorded once as a gap", async () => {
  const f = await shadowFixture({ today: "2026-11-05" });
  await october(f);
  // Xero is missing the Domain line (49.99) in its bank, its expense and its balances.
  await importXero(f, {
    without: ["Domain"],
    closing: { "090": 1_075_000n, "469": 33_000n },
  });
  await reconciledThrough(f, "2026-10-31");
  const report = await f.ok("tieout.report", {});
  const bank = rowOf(report, "1000");
  expect(bank).toMatchObject({
    status: "differs",
    xero: "10750.00",
    rastrata: "10700.01",
    difference: "-49.99",
    carried: "0.00",
    residual: "0.00",
    explained: true,
    matched: 2,
    unmatchedCount: 1,
  });
  expect(bank.unmatched).toEqual([
    {
      side: "rastrata",
      date: "2026-10-20",
      description: "Domain",
      reference: expect.any(String),
      source: "",
      debit: "0.00",
      credit: "49.99",
    },
  ]);
  expect(rowOf(report, "6000")).toMatchObject({
    status: "differs",
    difference: "49.99",
    explained: true,
  });
  expect(report.summary).toMatchObject({
    differs: 2,
    explained: 2,
    unexplained: 0,
    linesOnlyInRastrata: 2,
  });

  // Recording adds each line once; again adds nothing; a closed gap stays closed.
  const first = await f.ok("tieout.record", {});
  expect(first.added).toBe(2);
  expect(first.gaps.map((gap: { title: string }) => gap.title).sort()).toEqual([
    "Rastrata only: 2026-10-20 49.99 credit on 1000 Business checking",
    "Rastrata only: 2026-10-20 49.99 debit on 6000 Software and subscriptions",
  ]);
  const again = await f.ok("tieout.record", {});
  expect(again).toMatchObject({ added: 0, existing: 2 });
  const gap = first.gaps[0];
  const refused = await f.call(
    "gaps.update",
    { id: gap.id, status: "closed" },
    crypto.randomUUID(),
  );
  expect(refused.body.error.code).toBe("resolution_required");
  const closed = await f.ok("gaps.update", {
    id: gap.id,
    status: "closed",
    resolution: "Xero never got the bank line; Rastrata is right (statement line 14).",
  });
  expect(closed).toMatchObject({ status: "closed", closedBy: expect.any(String) });
  await f.ok("tieout.record", {});
  const open = await f.ok("gaps.list", {});
  expect(open.open).toBe(1);
  expect(open.closed).toBe(1);
  expect(open.gaps.map((item: { id: number }) => item.id)).toEqual([first.gaps[1].id]);
  const all = await f.ok("gaps.list", { status: "all" });
  expect(all.gaps).toHaveLength(2);
  const reopened = await f.ok("gaps.update", { id: gap.id, status: "open" });
  expect(reopened).toMatchObject({ status: "open", closedAt: null });
});

test("what the books already disagreed about when the month began is carried, not blamed on a line", async () => {
  const f = await shadowFixture({ today: "2026-11-05" });
  await october(f);
  // Xero's book was 126.80 behind the statement the opening balance was taken from.
  await importXero(f, {
    opening: { "090": 987_320n },
    closing: { "090": 1_057_321n },
  });
  await reconciledThrough(f, "2026-10-31");
  const report = await f.ok("tieout.report", {});
  expect(rowOf(report, "1000")).toMatchObject({
    status: "differs",
    xero: "10573.21",
    rastrata: "10700.01",
    difference: "126.80",
    carried: "126.80",
    residual: "0.00",
    explained: true,
    unmatchedCount: 0,
  });
});

test("where Xero was not reconciled through the month, nothing in it is compared, and why", async () => {
  const f = await shadowFixture({ today: "2026-11-05" });
  await october(f);
  await importXero(f);
  await reconciledThrough(f, "2026-10-15");
  const report = await f.ok("tieout.report", {});
  const period = report.periods[0];
  expect(period.xeroReconciled).toBe(false);
  expect(period.notReconciled.map((bank: { code: string }) => bank.code)).toEqual(["090", "092"]);
  for (const account of period.accounts) {
    expect(account).toMatchObject({
      status: "not_comparable",
      reason: { code: "xero_not_reconciled" },
    });
    expect(account.xero).toBeNull();
    expect(account.difference).toBeNull();
  }
  expect(rowOf(report, "1000").reason.message).toContain("through 2026-10-15");
  expect(rowOf(report, "4000").reason.message).toContain("not all reconciled through 2026-10-31");
  expect(report.summary).toMatchObject({ comparable: 0, notComparable: 5 });
  // Not recorded as gaps: not comparable is not a difference.
  expect((await f.ok("tieout.record", {})).added).toBe(0);
  // With no date given at all, it says so.
  await f.ok("xero.reconciled.set", { choices: [], clear: ["090", "092"] });
  expect(rowOf(await f.ok("tieout.report", {}), "1000").reason.message).toContain(
    "no date that was given",
  );
});

test("a Xero account nothing maps is reported with its balance, and an account with no Xero counterpart is not comparable", async () => {
  const f = await shadowFixture({ today: "2026-11-05" });
  await october(f);
  await importXero(f);
  await reconciledThrough(f, "2026-10-31");
  // Leave the card's Xero account out of the mapping and map nothing to the software account.
  await f.ok("xero.mapping.set", { choices: [{ xeroCode: "092", skip: true }], clear: ["469"] });
  const report = await f.ok("tieout.report", {});
  expect(rowOf(report, "6000")).toMatchObject({
    status: "not_comparable",
    reason: { code: "no_xero_counterpart" },
  });
  expect(report.periods[0].unmapped).toEqual([
    { code: "469", name: "Software and subscriptions", net: "379.99" },
  ]);
  const recorded = await f.ok("tieout.record", {});
  expect(recorded.gaps.map((gap: { kind: string }) => gap.kind)).toContain("unmapped");
});

test("periods with nothing from Xero are left out, a chart is required, and the report reads only", async () => {
  const f = await shadowFixture({ today: "2026-11-05" });
  await october(f);
  const none = await f.call("tieout.report", {});
  expect(none.body.error.code).toBe("xero_chart_missing");
  await f.ok("xero.chart.import", { text: chartCsv(ledgerAt("october")), accept: "likely" });
  const empty = await f.ok("tieout.report", {});
  expect(empty.periods).toEqual([]);
  expect(empty.notes.join(" ")).toContain("No period has anything from Xero");
  // A read-only caller can read the report and cannot record from it.
  const read = await f.call("tieout.report", {}, undefined, ["read"]);
  expect(read.status).toBe(200);
  const record = await f.call("tieout.record", {}, crypto.randomUUID(), ["read"]);
  expect(record.status).toBe(403);
  // A caller who may draft may note a gap and may not close one.
  const added = await f.call(
    "gaps.add",
    { title: "Xero tracks a project we do not" },
    crypto.randomUUID(),
    ["read", "draft"],
  );
  expect(added.status).toBe(200);
  const closed = await f.call(
    "gaps.update",
    { id: added.body.data.id, status: "closed", resolution: "ok" },
    crypto.randomUUID(),
    ["read", "draft"],
  );
  expect(closed.status).toBe(403);
});

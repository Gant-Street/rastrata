import { afterEach, expect, test } from "bun:test";
import { baseSetup, fixture } from "./calendar-support.ts";

/** What an account's register needs from the service: each line numbered like the entry it came from,
 * and the general ledger's file narrowed to one account. Both are additive to what reports already
 * return. */
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function post(
  f: Fixture,
  date: string,
  narration: string,
  debit: string,
  credit: string,
  amount: string,
): Promise<void> {
  const draft = (
    await f.call(
      "drafts.create",
      {
        data: {
          date,
          reference: narration.slice(0, 40),
          narration,
          lines: [
            { accountId: debit, debit: amount, credit: "" },
            { accountId: credit, debit: "", credit: amount },
          ],
        },
      },
      crypto.randomUUID(),
    )
  ).body.data;
  const plan = (
    await f.call(
      "journal.prepare",
      { draftId: draft.id, expectedVersion: draft.version },
      crypto.randomUUID(),
    )
  ).body.data;
  const receipt = await f.call("operations.commit", {
    planId: plan.planId,
    planHash: plan.planHash,
  });
  expect(receipt.body.data.disposition).toBe("committed");
}

async function seeded(): Promise<Fixture> {
  const f = await fixture({ cleanup: (work) => cleanup.push(work) });
  expect((await f.call("book.setup", baseSetup, crypto.randomUUID())).body.ok).toBe(true);
  await post(f, "2026-01-05", "Owner put money in", "1000", "3000", "1000.00");
  await post(f, "2026-01-09", "Customer paid", "1000", "4000", "250.00");
  await post(f, "2026-01-12", "Printer paper", "5000", "1000", "37.50");
  return f;
}

test("each line of an account's activity carries the number of the entry it came from", async () => {
  const f = await seeded();
  const report = (await f.call("reports.get", { asOf: "2026-01-31" })).body.data;
  const activity = (
    await f.call("activity.get", {
      accountId: "1000",
      asOf: "2026-01-31",
      populationHash: report.populationHash,
      from: "2026-01-01",
      to: "2026-01-31",
    })
  ).body.data;
  expect(
    activity.rows.map(
      (row: { postingSequence: string; narration: string; runningBalance: string }) => [
        row.postingSequence,
        row.narration,
        row.runningBalance,
      ],
    ),
  ).toEqual([
    ["1", "Owner put money in", "1000.00"],
    ["2", "Customer paid", "1250.00"],
    ["3", "Printer paper", "1212.50"],
  ]);
  // The number is the one the entry's own page shows.
  for (const row of activity.rows) {
    const entry = (await f.call("journal.get", { journalId: row.journalId })).body.data;
    expect(row.postingSequence).toBe(entry.postingSequence);
  }
  // And the whole general ledger's lines carry it too.
  const ledger = (await f.call("reports.generalLedger", { asOf: "2026-01-31" })).body.data;
  expect(
    ledger.lines.every((line: { postingSequence?: string }) =>
      /^[1-3]$/.test(line.postingSequence ?? ""),
    ),
  ).toBe(true);
});

test("the general ledger's file can be of one account, and is not for any other statement", async () => {
  const f = await seeded();
  const whole = (
    await f.call("reports.export", { statement: "general-ledger", asOf: "2026-01-31" })
  ).body.data;
  const one = (
    await f.call("reports.export", {
      statement: "general-ledger",
      asOf: "2026-01-31",
      accountId: "1000",
    })
  ).body.data;
  // The same population: the file says which book state it came from either way.
  expect(one.populationHash).toBe(whole.populationHash);
  expect(one.mediaType).toContain("text/csv");
  // Its three lines are the cash account's, and the sales and expense lines are not in it.
  expect(one.content).toContain("Owner put money in");
  expect(one.content).toContain("Customer paid");
  expect(one.content).toContain("Printer paper");
  expect(one.content).toContain("1212.50");
  expect(whole.content).toContain("Printer paper");
  expect(one.content.split("\n").length).toBeLessThan(whole.content.split("\n").length);
  // Its name is fixed words and dates: no part of the book is in it.
  expect(one.filename).toBe("account-register-2026-01-01-to-2026-01-31.csv");
  expect(whole.filename).toBe("general-ledger-2026-01-01-to-2026-01-31.csv");
  // Another statement is of the whole book, and says so.
  const refused = await f.call("reports.export", {
    statement: "trial-balance",
    asOf: "2026-01-31",
    accountId: "1000",
  });
  expect(refused.status).toBe(400);
  expect(refused.body.error.code).toBe("invalid_input");
});

test("an account's activity can be read as the book stands, and the reply names the population to pin the next page", async () => {
  const f = await seeded();
  const unpinned = (
    await f.call("activity.get", {
      accountId: "1000",
      asOf: "2026-01-31",
      from: "2026-01-01",
      to: "2026-01-31",
    })
  ).body.data;
  expect(unpinned.rows).toHaveLength(3);
  expect(unpinned.closingBalance).toBe("1212.50");
  // The reply says which population it read: the one a report of the same date and range names.
  const report = (await f.call("reports.get", { asOf: "2026-01-31" })).body.data;
  expect(unpinned.populationHash).toBe(report.populationHash);
  // Passed back, it pins the next read to the same book...
  const pinned = (
    await f.call("activity.get", {
      accountId: "1000",
      asOf: "2026-01-31",
      populationHash: unpinned.populationHash,
      from: "2026-01-01",
      to: "2026-01-31",
      page: 1,
    })
  ).body.data;
  expect(pinned.rows).toEqual(unpinned.rows);
  // ...and a population that is not the book's is still refused, as it always was.
  const refused = await f.call("activity.get", {
    accountId: "1000",
    asOf: "2026-01-31",
    populationHash: "0".repeat(64),
    from: "2026-01-01",
    to: "2026-01-31",
  });
  expect(refused.body.ok).toBe(false);
  expect(refused.body.error.code).toBe("report_population_changed");
});

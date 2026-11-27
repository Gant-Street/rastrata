/** A book that runs for five fiscal years and is closed year by year, built the way a real one is
 * used: an October fiscal year, the calendar extended to cover every year, journals spread across all
 * of them, a posting and a reversal that cross a fiscal year boundary, a year-end for each ended year,
 * and a reopening that reaches back across a year. The same scenario runs at two sizes: a few hundred
 * journals in the ordinary suite, thousands behind `test:slow`.
 *
 * Every expected figure is computed here from the journals the scenario itself posted (exact cents in a
 * bigint), never read back from the service, so the statements are checked against an independent sum. */
import { expect } from "bun:test";
import { addDays, fiscalYearOf } from "../../src/calendar/fiscal-calendar.ts";
import { formatMoney } from "../../src/money.ts";
import { type Fixture, fixture } from "../calendar-support.ts";
import { type BulkEntry, postBulk } from "./bulk-book.ts";

export const FIRST_YEAR = 2026;
export const START_MONTH = 10;
/** The last day of the fiscal year `year` (October start). */
export const yearEnd = (year: number) => `${year + 1}-09-30`;
export const yearStart = (year: number) => `${year}-10-01`;
const DAYS_IN_FIVE_YEARS = 1826; // 2026-10-01 to 2031-09-30 inclusive

/** The scenario's `n`th journal (counting from 1): a sale or an expense, dated somewhere in the five
 * fiscal years, in whole cents. Pure, so the expected statements can be recomputed from it. */
export function entryFor(n: number): BulkEntry {
  const expense = n % 5 === 0;
  return {
    date: addDays(yearStart(FIRST_YEAR), (n * 7919) % DAYS_IN_FIVE_YEARS),
    debit: expense ? "5000" : "1000",
    credit: expense ? "1000" : "4000",
    cents: 100n + BigInt((n * 37) % 90_000),
  };
}

/** What the bulk journals add up to in one fiscal year, in cents. */
export function bulkTotals(count: number, extra: readonly BulkEntry[] = []) {
  // postBulk numbers its journals from the book's journal count plus one, and the opening journal is
  // posted first, so they are journals 2 to count + 1.
  const years = new Map<number, { revenue: bigint; expenses: bigint }>();
  for (let year = FIRST_YEAR; year < FIRST_YEAR + 5; year++)
    years.set(year, { revenue: 0n, expenses: 0n });
  const add = (entry: BulkEntry, sign: bigint) => {
    const totals = years.get(fiscalYearOf(entry.date, START_MONTH));
    if (!totals) throw new Error(`${entry.date} is outside the five fiscal years`);
    if (entry.credit === "4000") totals.revenue += sign * entry.cents;
    if (entry.debit === "4000") totals.revenue -= sign * entry.cents;
    if (entry.debit === "5000") totals.expenses += sign * entry.cents;
    if (entry.credit === "5000") totals.expenses -= sign * entry.cents;
  };
  for (let n = 2; n <= count + 1; n++) add(entryFor(n), 1n);
  for (const entry of extra) add(entry, 1n);
  return years;
}

export interface Timing {
  readonly step: string;
  readonly ms: number;
}

export interface FiveYearResult {
  readonly journals: number;
  readonly timings: readonly Timing[];
  readonly f: Fixture;
}

const money = (cents: bigint) => formatMoney(cents);

/** Run the scenario against a book of `count` bulk journals and check it as it goes. Returns the timings. */
export async function runFiveYears(
  count: number,
  cleanup: (work: () => void) => void,
  limits: { readonly operationMs: number },
): Promise<FiveYearResult> {
  const timings: Timing[] = [];
  const time = async <T>(step: string, work: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    const value = await work();
    const ms = Math.round(performance.now() - started);
    timings.push({ step, ms });
    return value;
  };
  // Today is in the middle of fiscal year 2029: the years 2026 to 2028 have ended, 2029 is under way
  // and 2030 has not begun.
  const f = await fixture({ cleanup, now: () => new Date(2029, 10, 15, 12, 0, 0) });
  await f.setup({
    name: "Five Year Co",
    currency: "USD",
    fiscalYear: FIRST_YEAR,
    fiscalYearStartMonth: START_MONTH,
    periodModel: "monthly",
    accounts: [
      { code: "1000", name: "Cash", role: "asset" },
      { code: "3000", name: "Capital", role: "equity" },
      { code: "4000", name: "Sales", role: "income" },
      { code: "5000", name: "Expense", role: "expense" },
    ],
  });
  await f.extend(FIRST_YEAR + 4);
  const calendar = (await f.periods()).calendar;
  expect(calendar).toMatchObject({
    firstDate: yearStart(FIRST_YEAR),
    lastDate: yearEnd(FIRST_YEAR + 4),
    canExtend: true,
  });
  expect((await f.periods()).periods.length).toBe(60);

  // Opening money, then the bulk journals straight through the ledger.
  await f.postOk(yearStart(FIRST_YEAR), "1000000.00", ["1000", "3000"], "OPEN");
  await time(`build ${count} journals`, () => postBulk(f.service, count, { entry: entryFor }));

  // The first read of a freshly built book is the one slow replay; every read after it is incremental.
  await time("first read (full replay)", () => f.service.readAggregate());

  // A journal on the last day of fiscal year 2027 and its reversal on the first day of 2028, so one
  // journal and its correction sit in different fiscal years.
  const lastDay = yearEnd(FIRST_YEAR + 1);
  const crossing = await f.postOk(lastDay, "250.00", ["5000", "1000"], "CROSSING");
  const reversalDate = addDays(lastDay, 1);
  const reversed = await f.prepareCommit("journal.prepareReverse", {
    journalId: crossing,
    accountingDate: reversalDate,
    reason: "Entered in the wrong year",
  });
  expect(reversed.receipt?.body.data.disposition).toBe("committed");
  // The original expense stays in 2027; the reversal is income-side in 2028 (a credit to the expense).
  const extra: BulkEntry[] = [
    { date: lastDay, debit: "5000", credit: "1000", cents: 25_000n },
    { date: reversalDate, debit: "1000", credit: "5000", cents: 25_000n },
  ];
  const totals = bulkTotals(count, extra);

  // Statements for every fiscal year: the independent sum, the roll-forward, and the equation.
  let prior = 0n;
  for (let year = FIRST_YEAR; year < FIRST_YEAR + 5; year++) {
    const t = totals.get(year);
    if (!t) throw new Error("year missing");
    const expected = {
      revenue: t.revenue,
      expenses: t.expenses,
      net: t.revenue - t.expenses,
    };
    const reply = await time(`reports ${year}`, () =>
      f.call("reports.get", { asOf: yearEnd(year) }),
    );
    expect(reply.body.ok).toBe(true);
    const report = reply.body.data;
    expect(report.profitAndLoss.revenue).toBe(money(expected.revenue));
    // The reversal credits the expense account, so its year shows the expense net of it.
    expect(report.profitAndLoss.expenses).toBe(money(expected.expenses));
    expect(report.profitAndLoss.netIncome).toBe(money(expected.net));
    expect(report.balanceSheet.priorEarnings).toBe(money(prior));
    expect(report.balanceSheet.currentEarnings).toBe(money(expected.net));
    expect(report.balanceSheet.balanced).toBe(true);
    expect(report.trialBalance.balanced).toBe(true);
    expect(report.periodStart).toBe(yearStart(year));
    prior += expected.net;
  }
  // Cash at the end of the last year: the opening money plus every year's earnings, exactly.
  const last = (await f.call("reports.get", { asOf: yearEnd(FIRST_YEAR + 4) })).body.data;
  expect(last.balanceSheet.assets).toBe(money(100_000_000n + prior));

  // Close the three ended years, in order, each as its own guided year-end.
  for (const year of [FIRST_YEAR, FIRST_YEAR + 1, FIRST_YEAR + 2]) {
    const review = await time(`review ${year}`, () =>
      f.call("periods.yearEndReview", { fiscalYear: year }),
    );
    expect(review.body.data.openCount).toBe(12);
    const prepared = await time(`prepare year-end ${year}`, () =>
      f.call(
        "periods.yearEnd",
        { fiscalYear: year, reason: `Reviewed fiscal year ${year}` },
        crypto.randomUUID(),
      ),
    );
    expect(prepared.body.data.valid).toBe(true);
    expect(prepared.body.data.steps.length).toBe(12);
    const committed = await time(`commit year-end ${year}`, () =>
      f.call(
        "periods.commitYearEnd",
        { planId: prepared.body.data.planId, planHash: prepared.body.data.planHash },
        crypto.randomUUID(),
      ),
    );
    expect(committed.body.data).toMatchObject({ disposition: "committed", closedCount: 12 });
  }
  const closed = await f.periods();
  expect(
    closed.calendar.fiscalYears.map((y: { fiscalYear: number; status: string }) => [
      y.fiscalYear,
      y.status,
    ]),
  ).toEqual([
    [2026, "closed"],
    [2027, "closed"],
    [2028, "closed"],
    [2029, "open"],
    [2030, "open"],
  ]);

  // Closing posted nothing: the same statements as before the closes.
  const afterClose = (await f.call("reports.get", { asOf: yearEnd(FIRST_YEAR + 2) })).body.data;
  expect(afterClose.balanceSheet.priorEarnings).toBe(
    money(
      [FIRST_YEAR, FIRST_YEAR + 1].reduce((sum, year) => {
        const t = totals.get(year);
        return sum + (t ? t.revenue - t.expenses : 0n);
      }, 0n),
    ),
  );

  // A late posting into a closed year is refused; the open years are unaffected.
  const refused = await f.post(addDays(yearStart(FIRST_YEAR + 1), 40), "9.00");
  expect(refused.plan.ok ? refused.plan.data.valid : false).toBe(false);
  expect((await f.post(yearStart(FIRST_YEAR + 3), "9.00")).receipt?.data.disposition).toBe(
    "committed",
  );

  // Reopen mid-way through fiscal year 2027. The kernel supersedes the close of every later closed
  // period, which stays locked: the rest of 2027 and all of 2028.
  const reopenPlan = await time("prepare reopening", () =>
    f.call(
      "periods.prepare",
      { periodId: "period-2027-06", operation: "reopen", reason: "A supplier restated March" },
      crypto.randomUUID(),
    ),
  );
  // Fiscal year 2027's seventh period onwards (6 periods) and all of fiscal year 2028 (12).
  expect(reopenPlan.body.data.effects.periods[0].supersededPeriodIds.length).toBe(18);
  expect(reopenPlan.body.data.warnings.map((w: { code: string }) => w.code)).toContain(
    "reopen_supersedes_closes",
  );
  const reopened = await f.call("operations.commit", {
    planId: reopenPlan.body.data.planId,
    planHash: reopenPlan.body.data.planHash,
  });
  expect(reopened.body.data.disposition).toBe("committed");
  const afterReopen = await f.periods();
  // 60 periods: 17 locked with a current close (2026, and the first five of 2027), 18 locked with a
  // superseded close, the reopened one and the 24 of 2029 and 2030 open.
  const count_ = (test: (p: { status: string; closeSuperseded: boolean }) => boolean) =>
    afterReopen.periods.filter(test).length;
  expect(count_((p) => p.status === "open")).toBe(25);
  expect(count_((p) => p.status === "closed" && !p.closeSuperseded)).toBe(17);
  expect(count_((p) => p.closeSuperseded)).toBe(18);
  expect(
    afterReopen.calendar.fiscalYears.map((y: { fiscalYear: number; status: string }) => [
      y.fiscalYear,
      y.status,
    ]),
  ).toEqual([
    [2026, "closed"],
    [2027, "partlyClosed"],
    [2028, "partlyClosed"],
    [2029, "open"],
    [2030, "open"],
  ]);
  // A posting into a superseded period is still refused; the reopened one takes the correction.
  const stillLocked = await f.post(addDays(yearStart(FIRST_YEAR + 1), 200), "40.00");
  expect(stillLocked.plan.ok ? stillLocked.plan.data.valid : false).toBe(false);
  await f.postOk(addDays(yearStart(FIRST_YEAR + 1), 160), "40.00", ["5000", "1000"], "RESTATED");

  // The two years are brought back to a current close, each its own year-end: 2027 closes the
  // reopened period and reopens then closes the six superseded ones; 2028 does that for all twelve.
  for (const [year, closes, commands] of [
    [FIRST_YEAR + 1, 7, 13],
    [FIRST_YEAR + 2, 12, 24],
  ] as const) {
    const prepared = await time(`prepare year-end ${year} again`, () =>
      f.call(
        "periods.yearEnd",
        { fiscalYear: year, reason: `Closed again after the restatement (${year})` },
        crypto.randomUUID(),
      ),
    );
    expect(prepared.body.data.valid).toBe(true);
    expect(prepared.body.data.openCount).toBe(closes);
    const committed = await time(`commit year-end ${year} again`, () =>
      f.call(
        "periods.commitYearEnd",
        { planId: prepared.body.data.planId, planHash: prepared.body.data.planHash },
        crypto.randomUUID(),
      ),
    );
    expect(committed.body.data.disposition).toBe("committed");
    expect(committed.body.data.steps.length).toBe(commands);
  }
  expect((await f.periods()).calendar.fiscalYears.map((y: { status: string }) => y.status)).toEqual(
    ["closed", "closed", "closed", "open", "open"],
  );
  expect(
    (await f.periods()).periods.filter((p: { closeSuperseded: boolean }) => p.closeSuperseded),
  ).toEqual([]);

  // Nothing is slower than the bound: a regression in the read path shows here, not in production.
  for (const { step, ms } of timings)
    if (!step.startsWith("build") && !step.startsWith("first read"))
      expect(ms).toBeLessThan(limits.operationMs);
  return { journals: count + 5, timings, f };
}

/** One readable line for the lane doc and the test log. */
export const timingLine = (result: FiveYearResult) =>
  `${result.journals} journals over five fiscal years: ${result.timings
    .map(({ step, ms }) => `${step} ${(ms / 1000).toFixed(1)}s`)
    .join(", ")}`;

import { describe, expect, test } from "bun:test";
import { formatMoney, parseMoney } from "../src/money.ts";
import { compileReports } from "../src/reports.ts";
import {
  GENERAL_LEDGER_PAGE_SIZE,
  accountActivity,
  compileGeneralLedger,
  verifyPopulation,
} from "../src/reports/activity.ts";
import { addDays } from "../src/reports/dates.ts";
import { BEGINNING, failure, isProfitLoss, shown } from "./support/helpers.ts";
import { KernelBook } from "./support/kernel-book.ts";
import { CHART, type Scenario, generate } from "./support/scenario.ts";

const m = formatMoney;

let cached: Scenario | undefined;
const threeYears = (): Scenario => {
  cached ??= generate(7, { firstYear: 2024, years: 3 });
  return cached;
};

/** Every line of a general ledger, read page by page. */
function allLines(state: Scenario["book"]["state"], asOf: string, from?: string) {
  const first = compileGeneralLedger(state, { asOf, ...(from ? { from } : {}), page: 1 });
  const lines = [...first.lines];
  const pages = Math.max(1, Math.ceil(first.count / first.pageSize));
  for (let page = 2; page <= pages; page++)
    lines.push(...compileGeneralLedger(state, { asOf, ...(from ? { from } : {}), page }).lines);
  return { first, lines, pages };
}

describe("the general ledger", () => {
  test("its closing balances are the trial balance, account by account", () => {
    const scenario = threeYears();
    const state = scenario.book.state;
    for (const asOf of ["2024-06-30", "2025-12-31", "2026-04-15", "2026-12-31"]) {
      const ledger = compileGeneralLedger(state, { asOf, page: 1 });
      const report = compileReports(state, asOf);
      expect(ledger.populationHash).toBe(report.populationHash);
      expect(ledger.periodStart).toBe(report.periodStart);
      const listed = new Set(ledger.accounts.map((account) => account.code));
      for (const line of report.trialBalance.rows) {
        const account = ledger.accounts.find((item) => item.code === line.code);
        if (!account) {
          // An account with no activity in the range and no balance is left out, and only then.
          expect(line.signedBalance, `${asOf} ${line.code}`).toBe("0.00");
          continue;
        }
        expect(account.closingBalance, `${asOf} ${line.code}`).toBe(line.signedBalance);
        expect(account.balanceKind).toBe(
          isProfitLoss(line.code) ? "fiscalYearToDate" : "cumulative",
        );
      }
      expect(listed.size).toBeGreaterThan(8);
    }
  });

  test("opening, activity and closing agree with an independent summation for any range", () => {
    const scenario = threeYears();
    const state = scenario.book.state;
    for (const [from, to] of [
      ["2025-03-15", "2025-09-10"],
      ["2024-01-01", "2026-12-31"],
      ["2025-01-01", "2025-12-31"],
      ["2024-12-31", "2025-01-01"],
      ["2026-07-04", "2026-07-04"],
    ] as const) {
      const ledger = compileGeneralLedger(state, { asOf: to, from, page: 1 });
      for (const account of ledger.accounts) {
        const code = account.code;
        const profitLoss = isProfitLoss(code);
        const yearOfFrom = from.slice(0, 4);
        const floor = profitLoss ? `${yearOfFrom}-01-01` : BEGINNING;
        const closingFloor = profitLoss ? `${to.slice(0, 4)}-01-01` : BEGINNING;
        const debits = scenario.entries.filter(
          (entry) =>
            entry.code === code && entry.date >= from && entry.date <= to && entry.cents > 0n,
        );
        const credits = scenario.entries.filter(
          (entry) =>
            entry.code === code && entry.date >= from && entry.date <= to && entry.cents < 0n,
        );
        const label = `${code} ${from}..${to}`;
        expect(account.openingBalance, label).toBe(m(scenario.sum(code, floor, addDays(from, -1))));
        expect(account.closingBalance, label).toBe(m(scenario.sum(code, closingFloor, to)));
        expect(account.totalDebit, label).toBe(
          m(debits.reduce((sum, entry) => sum + entry.cents, 0n)),
        );
        expect(account.totalCredit, label).toBe(
          m(-credits.reduce((sum, entry) => sum + entry.cents, 0n)),
        );
        expect(account.netChange, label).toBe(m(scenario.sum(code, from, to)));
        expect(account.lineCount, label).toBe(debits.length + credits.length);
        if (!profitLoss)
          expect(parseMoney(account.openingBalance) + parseMoney(account.netChange), label).toBe(
            parseMoney(account.closingBalance),
          );
      }
    }
  });

  test("pages hold every posting exactly once, in account then date order, and balance", () => {
    const scenario = threeYears();
    const { first, lines, pages } = allLines(scenario.book.state, "2026-12-31", "2024-01-01");
    expect(first.pageSize).toBe(GENERAL_LEDGER_PAGE_SIZE);
    expect(pages).toBeGreaterThan(3);
    expect(first.lines).toHaveLength(GENERAL_LEDGER_PAGE_SIZE);
    expect(lines).toHaveLength(first.count);
    expect(first.count).toBe(first.accounts.reduce((sum, account) => sum + account.lineCount, 0));
    expect(first.count).toBe(scenario.entries.length);
    expect(new Set(lines.map((line) => line.postingId)).size).toBe(lines.length);
    // Every journal balances, so debits and credits across the whole ledger are equal.
    const debit = lines.reduce((sum, line) => sum + parseMoney(line.debit), 0n);
    const credit = lines.reduce((sum, line) => sum + parseMoney(line.credit), 0n);
    expect(debit).toBe(credit);
    const order = first.accounts.map((account) => account.accountId);
    let position = 0;
    let previous = "";
    for (const line of lines) {
      const at = order.indexOf(line.accountId);
      expect(at).toBeGreaterThanOrEqual(position);
      if (at !== position) previous = "";
      position = at;
      expect(line.date >= previous).toBe(true);
      previous = line.date;
    }
    // A page past the end is empty, not an error.
    const beyond = compileGeneralLedger(scenario.book.state, {
      asOf: "2026-12-31",
      from: "2024-01-01",
      page: pages + 1,
    });
    expect(beyond.lines).toHaveLength(0);
    expect(beyond.count).toBe(first.count);
  });

  test("a balance-sheet account keeps one running balance; an income or expense account starts each fiscal year again", () => {
    const scenario = threeYears();
    const { lines } = allLines(scenario.book.state, "2026-12-31", "2024-01-01");
    for (const code of ["1000", "4000", "6000"]) {
      const own = lines.filter((line) => line.accountId === code);
      expect(own.length, code).toBeGreaterThan(20);
      let running = 0n;
      let year = "";
      for (const line of own) {
        if (isProfitLoss(code) && line.date.slice(0, 4) !== year) {
          running = 0n;
          year = line.date.slice(0, 4);
        }
        running += parseMoney(line.debit) - parseMoney(line.credit);
        expect(parseMoney(line.runningBalance), `${code} ${line.date}`).toBe(running);
      }
    }
    // The first sales line of 2025 starts again from zero: it does not include 2024.
    const sales = lines.filter((line) => line.accountId === "4000" && line.date >= "2025-01-01");
    const firstOf2025 = sales[0];
    expect(firstOf2025).toBeDefined();
    if (!firstOf2025) return;
    expect(parseMoney(firstOf2025.runningBalance)).toBe(
      parseMoney(firstOf2025.debit) - parseMoney(firstOf2025.credit),
    );
  });

  test("a reversal and its original both appear and net to zero", () => {
    const book = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART });
    const original = book.post("2025-03-03", [
      ["6000", 75_00n],
      ["1000", -75_00n],
    ]);
    const reversal = book.reverse(original, "2025-03-04");
    const { first, lines } = allLines(book.state, "2025-03-31", "2025-03-01");
    const rent = lines.filter((line) => line.accountId === "6000");
    expect(rent.map((line) => [line.journalId, line.debit, line.credit])).toEqual([
      [original, "75.00", "0.00"],
      [reversal, "0.00", "75.00"],
    ]);
    expect(rent.at(-1)?.runningBalance).toBe("0.00");
    expect(first.accounts.find((account) => account.code === "6000")).toMatchObject({
      totalDebit: "75.00",
      totalCredit: "75.00",
      netChange: "0.00",
      closingBalance: "0.00",
      lineCount: 2,
    });
  });

  test("it refuses what a report refuses", () => {
    const state = threeYears().book.state;
    expect(failure(() => compileGeneralLedger(state, { asOf: "2027-01-01", page: 1 })).code).toBe(
      "calendar_not_configured",
    );
    expect(failure(() => compileGeneralLedger(state, { asOf: "2025-06-30", page: 0 })).code).toBe(
      "invalid_input",
    );
    expect(
      failure(() =>
        compileGeneralLedger(state, { asOf: "2025-06-30", from: "2025-07-01", page: 1 }),
      ).code,
    ).toBe("invalid_input");
    expect(
      failure(() => compileGeneralLedger(state, { asOf: "2025-06-30", basis: "cash", page: 1 }))
        .code,
    ).toBe("basis_unavailable");
  });
});

describe("drill-through from a report to account activity", () => {
  const scope = (asOf: string, from?: string) => {
    const state = threeYears().book.state;
    const report = compileReports(state, asOf, from ? { from } : {});
    return { state, report };
  };

  /** Read every page of one account's activity. */
  const lines = (
    state: Scenario["book"]["state"],
    report: ReturnType<typeof compileReports>,
    accountId: string,
    range: { from: string; to: string },
    reportFrom?: string,
  ) => {
    const query = {
      accountId,
      asOf: report.asOf,
      from: range.from,
      to: range.to,
      populationHash: report.populationHash,
      ...(reportFrom ? { reportFrom } : {}),
    };
    const first = accountActivity(state, { ...query, page: 1 });
    const rows = [...first.rows];
    for (let page = 2; page <= Math.ceil(first.count / first.pageSize); page++)
      rows.push(...accountActivity(state, { ...query, page }).rows);
    return { first, rows };
  };

  test("the activity behind a statement amount adds up to that amount", () => {
    for (const [asOf, from] of [
      ["2026-09-30", undefined],
      ["2025-11-30", "2025-04-01"],
      ["2026-12-31", "2024-07-01"],
    ] as const) {
      const { state, report } = scope(asOf, from);
      for (const entry of report.profitAndLoss.rows) {
        const { first, rows } = lines(
          state,
          report,
          entry.accountId,
          { from: report.periodStart, to: report.asOf },
          report.periodStart,
        );
        // The lines in the range sum to the amount on the statement.
        const net = rows.reduce(
          (sum, line) => sum + parseMoney(line.debit) - parseMoney(line.credit),
          0n,
        );
        expect(m(shown(entry.code, net)), `${asOf} ${entry.code}`).toBe(entry.amount);
        expect(first.count).toBe(rows.length);
        expect(first.netChange).toBe(m(net));
      }
      for (const entry of report.balanceSheet.rows) {
        const { first } = lines(
          state,
          report,
          entry.accountId,
          { from: report.fiscalYear.startsOn, to: report.asOf },
          report.periodStart,
        );
        expect(
          m(shown(entry.code, parseMoney(first.closingBalance))),
          `${asOf} ${entry.code}`,
        ).toBe(entry.amount);
      }
      for (const entry of report.trialBalance.rows) {
        const { first } = lines(
          state,
          report,
          entry.accountId,
          { from: report.fiscalYear.startsOn, to: report.asOf },
          report.periodStart,
        );
        expect(first.closingBalance, `${asOf} ${entry.code}`).toBe(entry.signedBalance);
      }
    }
  });

  test("running balances follow the lines and the opening balance, and an income account starts its year at zero", () => {
    const { state, report } = scope("2026-06-30");
    const sales = report.profitAndLoss.rows.find((entry) => entry.code === "4000");
    if (!sales) throw new Error("No sales row");
    const { first, rows } = lines(state, report, sales.accountId, {
      from: "2026-01-01",
      to: "2026-06-30",
    });
    expect(first.balanceKind).toBe("fiscalYearToDate");
    expect(first.openingBalance).toBe("0.00");
    let running = parseMoney(first.openingBalance);
    for (const line of rows) {
      running += parseMoney(line.debit) - parseMoney(line.credit);
      expect(parseMoney(line.runningBalance)).toBe(running);
    }
    expect(first.closingBalance).toBe(m(running));
    // Mid-year, the opening balance is the year to date before the range, never earlier years.
    const mid = lines(state, report, sales.accountId, {
      from: "2026-03-01",
      to: "2026-06-30",
    }).first;
    expect(mid.openingBalance).toBe(m(threeYears().sum("4000", "2026-01-01", "2026-02-28")));
    // A balance-sheet account carries its balance from the start of the book.
    const cash = report.balanceSheet.rows.find((entry) => entry.code === "1000");
    if (!cash) throw new Error("No cash row");
    const cashActivity = lines(state, report, cash.accountId, {
      from: "2026-03-01",
      to: "2026-06-30",
    }).first;
    expect(cashActivity.balanceKind).toBe("cumulative");
    expect(cashActivity.openingBalance).toBe(m(threeYears().sum("1000", BEGINNING, "2026-02-28")));
    expect(cashActivity.reportFrom).toBe(report.periodStart);
  });

  test("a hash from another report, range, basis or book state does not verify", () => {
    const { state, report } = scope("2025-06-30", "2025-04-01");
    const base = {
      accountId: "1000",
      asOf: report.asOf,
      from: "2025-04-01",
      to: "2025-06-30",
      populationHash: report.populationHash,
      page: 1,
    };
    // Without the report's custom start, the population is the default one and does not match.
    const missingStart = failure(() => accountActivity(state, base));
    expect(missingStart.code).toBe("report_population_changed");
    expect(missingStart.status).toBe(409);
    expect(missingStart.message).toContain("Report population has changed");
    expect(accountActivity(state, { ...base, reportFrom: "2025-04-01" }).count).toBeGreaterThan(0);
    expect(failure(() => accountActivity(state, { ...base, reportFrom: "2025-04-02" })).code).toBe(
      "report_population_changed",
    );
    expect(
      failure(() =>
        accountActivity(state, {
          ...base,
          populationHash: "0".repeat(64),
          reportFrom: "2025-04-01",
        }),
      ).code,
    ).toBe("report_population_changed");
    // A population from a different book state never verifies against this one.
    const other = generate(99, { firstYear: 2025, years: 1 }).book.state;
    expect(failure(() => accountActivity(other, { ...base, reportFrom: "2025-04-01" })).code).toBe(
      "report_population_changed",
    );
    // The default population verifies without a start.
    const defaulted = compileReports(state, "2025-06-30");
    expect(
      verifyPopulation(state, { asOf: "2025-06-30", populationHash: defaulted.populationHash })
        .range.from,
    ).toBe("2025-01-01");
  });

  test("ranges and accounts outside the report are refused", () => {
    const { state, report } = scope("2025-06-30");
    const base = {
      accountId: "1000",
      asOf: report.asOf,
      from: "2025-01-01",
      to: "2025-06-30",
      populationHash: report.populationHash,
      page: 1,
    };
    expect(
      failure(() => accountActivity(state, { ...base, from: "2025-07-01", to: "2025-06-30" })).code,
    ).toBe("invalid_input");
    expect(failure(() => accountActivity(state, { ...base, to: "2025-07-01" })).code).toBe(
      "invalid_input",
    );
    expect(failure(() => accountActivity(state, { ...base, from: "2025-02-30" })).code).toBe(
      "invalid_input",
    );
    expect(failure(() => accountActivity(state, { ...base, page: 0 })).code).toBe("invalid_input");
    const unknown = failure(() => accountActivity(state, { ...base, accountId: "9999" }));
    expect(unknown.code).toBe("account_not_in_report");
    expect(unknown.status).toBe(404);
    const early = failure(() => accountActivity(state, { ...base, from: "2023-12-31" }));
    expect(early.code).toBe("calendar_not_configured");
  });
});

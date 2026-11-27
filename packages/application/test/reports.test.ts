import { describe, expect, test } from "bun:test";
import { formatMoney, parseMoney } from "../src/money.ts";
import {
  compileCoreReports,
  compileReports,
  reportCalendar,
  reportingWindow,
} from "../src/reports.ts";
import { PROFIT_LOSS_ROLES } from "../src/reports/chart.ts";
import { addDays } from "../src/reports/dates.ts";
import { ledgerView } from "../src/reports/ledger.ts";
import { BEGINNING, failure, isProfitLoss, monthEnds, row, shown } from "./support/helpers.ts";
import { KernelBook } from "./support/kernel-book.ts";
import { CHART, Scenario, generate } from "./support/scenario.ts";

const m = formatMoney;

let cached: Scenario | undefined;
/** Three calendar years, built once from the kernel and shared by the tests that only read it. */
const threeYears = (): Scenario => {
  cached ??= generate(7, { firstYear: 2024, years: 3 });
  return cached;
};

describe("statements over several fiscal years", () => {
  test("the scenario is a real multi-year book with activity every year", () => {
    const { entries } = threeYears();
    expect(entries.length).toBeGreaterThan(300);
    for (const year of ["2024", "2025", "2026"]) {
      const net = threeYears().sumRoles(PROFIT_LOSS_ROLES, `${year}-01-01`, `${year}-12-31`);
      expect(net, year).not.toBe(0n);
    }
  });

  test("every statement agrees with an independent summation at every month end", () => {
    const scenario = threeYears();
    const state = scenario.book.state;
    for (const asOf of monthEnds(2024, 36)) {
      const report = compileReports(state, asOf);
      const yearStart = `${asOf.slice(0, 4)}-01-01`;
      expect(report.fiscalYear, asOf).toEqual({
        year: Number(asOf.slice(0, 4)),
        startsOn: yearStart,
        endsOn: `${asOf.slice(0, 4)}-12-31`,
      });
      expect(report.periodStart).toBe(yearStart);

      // Trial balance: balance-sheet accounts cumulative, income and expense the fiscal year to date.
      const trial = report.trialBalance;
      expect(trial.balanced).toBe(true);
      expect(trial.debit).toBe(trial.credit);
      for (const line of trial.rows) {
        const expected = isProfitLoss(line.code)
          ? scenario.sum(line.code, yearStart, asOf)
          : scenario.sum(line.code, BEGINNING, asOf);
        expect(line.signedBalance, `${asOf} ${line.code}`).toBe(m(expected));
        expect(line.debit).toBe(m(expected > 0n ? expected : 0n));
        expect(line.credit).toBe(m(expected < 0n ? -expected : 0n));
      }
      const earlier = scenario.sumRoles(PROFIT_LOSS_ROLES, BEGINNING, addDays(yearStart, -1));
      expect(trial.retainedEarnings?.signedBalance ?? "0.00", asOf).toBe(m(earlier));
      expect(trial.fiscalYearStart).toBe(yearStart);

      // Profit and loss for the fiscal year to date.
      for (const line of report.profitAndLoss.rows)
        expect(line.amount, `${asOf} ${line.code}`).toBe(
          m(shown(line.code, scenario.sum(line.code, yearStart, asOf))),
        );
      const net = -scenario.sumRoles(PROFIT_LOSS_ROLES, yearStart, asOf);
      expect(report.profitAndLoss.netIncome).toBe(m(net));
      expect(
        parseMoney(report.profitAndLoss.revenue) - parseMoney(report.profitAndLoss.expenses),
      ).toBe(net);

      // Balance sheet: cumulative balances, with earnings of earlier years rolled forward.
      for (const line of report.balanceSheet.rows)
        expect(line.amount, `${asOf} ${line.code}`).toBe(
          m(shown(line.code, scenario.sum(line.code, BEGINNING, asOf))),
        );
      const sheet = report.balanceSheet;
      expect(sheet.priorEarnings).toBe(m(-earlier));
      expect(sheet.currentEarnings).toBe(m(net));
      expect(sheet.difference).toBe("0.00");
      expect(sheet.balanced).toBe(true);
      expect(parseMoney(sheet.assets)).toBe(
        parseMoney(sheet.liabilities) + parseMoney(sheet.equity),
      );
      expect(sheet.equity).toBe(
        m(
          parseMoney(sheet.contributedEquity) +
            parseMoney(sheet.priorEarnings) +
            parseMoney(sheet.currentEarnings),
        ),
      );
    }
  });

  test("earnings roll forward at a year boundary without any closing entry", () => {
    const state = threeYears().book.state;
    const endOfFirstYear = compileReports(state, "2024-12-31");
    const startOfSecond = compileReports(state, "2025-01-31");
    expect(endOfFirstYear.balanceSheet.priorEarnings).toBe("0.00");
    expect(endOfFirstYear.trialBalance.retainedEarnings).toBeNull();
    expect(parseMoney(endOfFirstYear.balanceSheet.currentEarnings)).not.toBe(0n);
    // The first year's earnings become retained earnings, exactly, and the new year starts again at zero.
    expect(startOfSecond.balanceSheet.priorEarnings).toBe(
      endOfFirstYear.balanceSheet.currentEarnings,
    );
    expect(startOfSecond.trialBalance.retainedEarnings?.signedBalance).toBe(
      m(-parseMoney(endOfFirstYear.balanceSheet.currentEarnings)),
    );
    expect(startOfSecond.balanceSheet.currentEarnings).toBe(startOfSecond.profitAndLoss.netIncome);
    // No journal in the book is a closing journal: the roll-forward is arithmetic, not an entry.
    expect(state.journals.filter((booked) => booked.journal.kind === "closing")).toHaveLength(0);
    // Total equity is continuous across the boundary except for what the year itself added.
    const decEquity = parseMoney(endOfFirstYear.balanceSheet.equity);
    const janEquity = parseMoney(startOfSecond.balanceSheet.equity);
    const janContributions = threeYears().sum("3000", "2025-01-01", "2025-01-31");
    const janDraws = threeYears().sum("3100", "2025-01-01", "2025-01-31");
    expect(janEquity - decEquity).toBe(
      parseMoney(startOfSecond.profitAndLoss.netIncome) - janContributions - janDraws,
    );
  });

  test("profit and loss equals the change in earnings between any two dates", () => {
    const state = threeYears().book.state;
    const ends = monthEnds(2024, 36);
    const earnings = (asOf: string) => {
      const sheet = compileReports(state, asOf).balanceSheet;
      return parseMoney(sheet.priorEarnings) + parseMoney(sheet.currentEarnings);
    };
    for (const [first, second] of [
      [0, 5],
      [3, 20],
      [11, 12],
      [10, 14],
      [0, 35],
      [23, 35],
      [17, 18],
    ] as const) {
      const earlier = ends[first] as string;
      const later = ends[second] as string;
      const period = compileReports(state, later, { from: addDays(earlier, 1) });
      expect(earnings(later) - earnings(earlier), `${earlier} to ${later}`).toBe(
        parseMoney(period.profitAndLoss.netIncome),
      );
    }
  });

  test("a range is the sum of its postings, adds up across splits and crosses fiscal years", () => {
    const scenario = threeYears();
    const state = scenario.book.state;
    const whole = compileReports(state, "2026-12-31", { from: "2024-01-01" });
    expect(whole.periodStart).toBe("2024-01-01");
    expect(whole.profitAndLoss.netIncome).toBe(
      m(-scenario.sumRoles(PROFIT_LOSS_ROLES, "2024-01-01", "2026-12-31")),
    );
    // Three whole years, and the same range split in two, give the same account amounts.
    const parts = [
      compileReports(state, "2024-12-31", { from: "2024-01-01" }),
      compileReports(state, "2025-12-31", { from: "2025-01-01" }),
      compileReports(state, "2026-12-31", { from: "2026-01-01" }),
    ];
    for (const line of whole.profitAndLoss.rows)
      expect(line.amount, line.code).toBe(
        m(
          parts.reduce(
            (sum, part) => sum + parseMoney(row(part.profitAndLoss.rows, line.code).amount),
            0n,
          ),
        ),
      );
    const first = compileReports(state, "2025-05-31", { from: "2025-03-15" });
    const second = compileReports(state, "2025-09-10", { from: "2025-06-01" });
    const joined = compileReports(state, "2025-09-10", { from: "2025-03-15" });
    for (const line of joined.profitAndLoss.rows)
      expect(line.amount, line.code).toBe(
        m(
          parseMoney(row(first.profitAndLoss.rows, line.code).amount) +
            parseMoney(row(second.profitAndLoss.rows, line.code).amount),
        ),
      );
    // The balance sheet does not depend on where the profit and loss range starts.
    expect(joined.balanceSheet).toEqual(second.balanceSheet);
    expect(joined.trialBalance).toEqual(second.trialBalance);
  });

  test("a mid-year start does not move the trial balance or the balance sheet", () => {
    const state = threeYears().book.state;
    const defaulted = compileReports(state, "2025-08-31");
    const custom = compileReports(state, "2025-08-31", { from: "2025-06-01" });
    expect(custom.periodStart).toBe("2025-06-01");
    expect(custom.trialBalance).toEqual(defaulted.trialBalance);
    expect(custom.balanceSheet).toEqual(defaulted.balanceSheet);
    expect(custom.profitAndLoss.netIncome).not.toBe(defaulted.profitAndLoss.netIncome);
  });
});

describe("comparison columns", () => {
  const state = () => threeYears().book.state;

  for (const kind of ["previousPeriod", "previousYear"] as const) {
    test(`${kind}: each comparison column is exactly the report that range has on its own`, () => {
      const withComparison = compileReports(state(), "2025-06-30", {
        from: "2025-04-01",
        compare: kind,
      });
      const alone = compileReports(state(), "2025-06-30", { from: "2025-04-01" });
      const comparison = withComparison.comparison;
      expect(comparison).not.toBeNull();
      if (!comparison) return;
      expect(comparison.kind).toBe(kind);
      expect([comparison.periodStart, comparison.asOf]).toEqual(
        kind === "previousYear" ? ["2024-04-01", "2024-06-30"] : ["2025-01-01", "2025-03-31"],
      );
      const standalone = compileReports(state(), comparison.asOf, { from: comparison.periodStart });
      // The population is the one the range would have alone; asking for a comparison does not
      // change the current column at all.
      expect(comparison.populationHash).toBe(standalone.populationHash);
      expect(withComparison.populationHash).toBe(alone.populationHash);
      expect(withComparison.trialBalance).toEqual(alone.trialBalance);
      expect(withComparison.warnings).toEqual([]);

      for (const line of withComparison.profitAndLoss.rows) {
        const earlier = row(standalone.profitAndLoss.rows, line.code).amount;
        expect(line.comparative, line.code).toBe(earlier);
        expect(line.change, line.code).toBe(m(parseMoney(line.amount) - parseMoney(earlier)));
      }
      for (const line of withComparison.balanceSheet.rows) {
        const earlier = row(standalone.balanceSheet.rows, line.code).amount;
        expect(line.comparative, line.code).toBe(earlier);
        expect(line.change, line.code).toBe(m(parseMoney(line.amount) - parseMoney(earlier)));
      }
      const net = withComparison.profitAndLoss.totals.find((item) => item.key === "netIncome");
      expect(net?.comparative).toBe(standalone.profitAndLoss.netIncome);
      expect(net?.change).toBe(
        m(
          parseMoney(alone.profitAndLoss.netIncome) -
            parseMoney(standalone.profitAndLoss.netIncome),
        ),
      );
      const equity = withComparison.balanceSheet.totals.find((item) => item.key === "totalEquity");
      expect(equity?.comparative).toBe(standalone.balanceSheet.equity);
      // The totals line up with the rows they summarise.
      for (const key of ["asset", "liability", "liabilitiesAndEquity"]) {
        const line = withComparison.balanceSheet.totals.find((item) => item.key === key);
        expect(line?.comparative, key).toBeDefined();
      }
    });
  }

  test("a statement without a comparison carries no comparison fields", () => {
    const report = compileReports(state(), "2025-06-30");
    expect(report.comparison).toBeNull();
    for (const line of [...report.profitAndLoss.rows, ...report.balanceSheet.rows]) {
      expect(line.comparative).toBeUndefined();
      expect(line.change).toBeUndefined();
    }
    for (const total of [...report.profitAndLoss.totals, ...report.balanceSheet.totals])
      expect(total.comparative).toBeUndefined();
  });

  test("a comparison before the book began is reported as unavailable, not as a column of zeros", () => {
    for (const [asOf, from, kind] of [
      ["2024-06-30", "2024-04-01", "previousYear"],
      ["2024-03-31", "2024-01-01", "previousPeriod"],
      ["2024-12-31", undefined, "previousYear"],
    ] as const) {
      const report = compileReports(state(), asOf, {
        ...(from ? { from } : {}),
        compare: kind,
      });
      expect(report.comparison, `${asOf} ${kind}`).toBeNull();
      expect(report.warnings.map((warning) => warning.code)).toEqual(["comparison_unavailable"]);
      expect(report.warnings[0]?.message).toContain("2024-01-01");
      expect(report.profitAndLoss.rows.every((line) => line.comparative === undefined)).toBe(true);
    }
    // A comparison that only partly precedes the book is also unavailable.
    const partial = new KernelBook({ firstYear: 2025, years: 2, startMonth: 2, accounts: CHART });
    const report = compileReports(partial.state, "2025-02-28", { compare: "previousPeriod" });
    expect(report.comparison).toBeNull();
  });
});

describe("report populations", () => {
  test("the same inputs reproduce the same population, and any difference changes it", () => {
    const state = threeYears().book.state;
    const base = compileReports(state, "2025-06-30");
    expect(compileReports(state, "2025-06-30").populationHash).toBe(base.populationHash);
    expect(compileCoreReports(state, "2025-06-30").populationHash).toBe(base.populationHash);
    expect(base.populationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(base.compilerVersion).toBe("rastrata-core-report-v2");
    const hashes = new Set([
      base.populationHash,
      compileReports(state, "2025-06-29").populationHash,
      compileReports(state, "2025-07-31").populationHash,
      compileReports(state, "2025-06-30", { from: "2025-02-01" }).populationHash,
      compileReports(state, "2025-06-30", { from: "2025-01-02" }).populationHash,
      compileReports(state, "2024-06-30").populationHash,
    ]);
    expect(hashes.size).toBe(6);
    // The default start is the start of the fiscal year, so naming it changes nothing.
    expect(compileReports(state, "2025-06-30", { from: "2025-01-01" }).populationHash).toBe(
      base.populationHash,
    );
  });

  test("rebuilding the same book from the kernel reproduces the report, another book does not", () => {
    const first = generate(21, { firstYear: 2025, years: 1 });
    const again = generate(21, { firstYear: 2025, years: 1 });
    const other = generate(22, { firstYear: 2025, years: 1 });
    const hash = (scenario: Scenario) =>
      compileReports(scenario.book.state, "2025-12-31").populationHash;
    expect(hash(again)).toBe(hash(first));
    expect(hash(other)).not.toBe(hash(first));
  });

  test("a later posting changes the population, and the earlier revision still reproduces it", () => {
    const scenario = generate(5, { firstYear: 2025, years: 1 });
    const before = scenario.book.state;
    const reportBefore = compileReports(before, "2025-06-30");
    scenario.post("2025-03-10", [
      ["1000", 12_34n],
      ["4000", -12_34n],
    ]);
    const after = scenario.book.state;
    const reportAfter = compileReports(after, "2025-06-30");
    expect(reportAfter.populationHash).not.toBe(reportBefore.populationHash);
    expect(reportAfter.bookRevision).not.toBe(reportBefore.bookRevision);
    expect(compileReports(before, "2025-06-30")).toEqual(reportBefore);
    expect(
      parseMoney(reportAfter.profitAndLoss.revenue) -
        parseMoney(reportBefore.profitAndLoss.revenue),
    ).toBe(12_34n);
  });
});

describe("fiscal years that do not start in January", () => {
  test("an October fiscal year rolls earnings forward at October, not at January", () => {
    const scenario = generate(11, { firstYear: 2024, years: 3, startMonth: 10 });
    const state = scenario.book.state;
    const report = compileReports(state, "2026-03-31");
    expect(report.fiscalYear).toEqual({ year: 2025, startsOn: "2025-10-01", endsOn: "2026-09-30" });
    expect(report.periodStart).toBe("2025-10-01");
    expect(report.profitAndLoss.netIncome).toBe(
      m(-scenario.sumRoles(PROFIT_LOSS_ROLES, "2025-10-01", "2026-03-31")),
    );
    expect(report.balanceSheet.currentEarnings).toBe(report.profitAndLoss.netIncome);
    expect(report.balanceSheet.priorEarnings).toBe(
      m(-scenario.sumRoles(PROFIT_LOSS_ROLES, BEGINNING, "2025-09-30")),
    );
    expect(parseMoney(report.balanceSheet.priorEarnings)).not.toBe(0n);
    // The last day of the fiscal year and the first of the next sit on opposite sides.
    const lastDay = compileReports(state, "2026-09-30");
    const firstDay = compileReports(state, "2026-10-01");
    expect(lastDay.fiscalYear.year).toBe(2025);
    expect(firstDay.fiscalYear.year).toBe(2026);
    expect(firstDay.balanceSheet.currentEarnings).toBe(firstDay.profitAndLoss.netIncome);
    expect(firstDay.balanceSheet.priorEarnings).toBe(
      m(
        parseMoney(lastDay.balanceSheet.priorEarnings) +
          parseMoney(lastDay.balanceSheet.currentEarnings),
      ),
    );
    for (const asOf of monthEnds(2024, 36, 10)) {
      const dated = compileReports(state, asOf);
      expect(dated.balanceSheet.difference, asOf).toBe("0.00");
      expect(dated.trialBalance.debit).toBe(dated.trialBalance.credit);
    }
  });

  test("quarterly periods give the same fiscal years", () => {
    const quarterly = new KernelBook({
      firstYear: 2025,
      years: 2,
      startMonth: 4,
      periodModel: "quarterly",
      accounts: CHART,
    });
    quarterly.post("2025-05-10", [
      ["1000", 100_00n],
      ["4000", -100_00n],
    ]);
    quarterly.post("2026-02-10", [
      ["1000", 50_00n],
      ["4000", -50_00n],
    ]);
    quarterly.post("2026-05-10", [
      ["1000", 7_00n],
      ["4000", -7_00n],
    ]);
    const report = compileReports(quarterly.state, "2026-06-30");
    expect(report.fiscalYear).toEqual({ year: 2026, startsOn: "2026-04-01", endsOn: "2027-03-31" });
    expect(report.profitAndLoss.netIncome).toBe("7.00");
    expect(report.balanceSheet.priorEarnings).toBe("150.00");
    expect(compileReports(quarterly.state, "2026-03-31").balanceSheet.currentEarnings).toBe(
      "150.00",
    );
  });
});

describe("basis", () => {
  test("a cash-basis book compiles every statement and carries its own basis", () => {
    const scenario = generate(3, { firstYear: 2025, years: 2, basis: "cash" });
    const report = compileReports(scenario.book.state, "2026-06-30");
    expect(report.basis).toBe("cash");
    expect(report.balanceSheet.difference).toBe("0.00");
    expect(compileReports(scenario.book.state, "2026-06-30", { basis: "cash" })).toEqual(report);
    expect(reportCalendar(scenario.book.state).basis).toBe("cash");
  });

  test("a basis the book does not keep is refused, with the reason, in both directions", () => {
    const cash = generate(3, { firstYear: 2025, years: 1, basis: "cash" }).book.state;
    const accrual = generate(3, { firstYear: 2025, years: 1 }).book.state;
    const fromCash = failure(() => compileReports(cash, "2025-06-30", { basis: "accrual" }));
    expect(fromCash.code).toBe("basis_unavailable");
    expect(fromCash.status).toBe(409);
    expect(fromCash.message).toMatch(/cash basis/);
    expect(fromCash.message).toMatch(/receivables, payables and accruals/);
    const fromAccrual = failure(() => compileReports(accrual, "2025-06-30", { basis: "cash" }));
    expect(fromAccrual.code).toBe("basis_unavailable");
    expect(fromAccrual.message).toMatch(/accrual basis/);
    expect(fromAccrual.message).toMatch(/date each receivable and payable was settled/);
    expect(compileReports(accrual, "2025-06-30", { basis: "accrual" }).basis).toBe("accrual");
  });
});

describe("the fiscal calendar bounds every report", () => {
  const state = () => generate(9, { firstYear: 2025, years: 1 }).book.state;

  test("a date outside the periods names the date, the covered range and how to extend", () => {
    for (const [asOf, field] of [
      ["2024-12-31", "asOf"],
      ["2026-01-01", "asOf"],
      ["2030-06-30", "asOf"],
    ] as const) {
      const error = failure(() => compileReports(state(), asOf));
      expect(error.code, asOf).toBe("calendar_not_configured");
      expect(error.status).toBe(409);
      expect(error.message).toContain(asOf);
      expect(error.message).toContain("2025-01-01 to 2025-12-31");
      expect(error.message).toMatch(/Extend the calendar/);
      expect(error.details[0]?.path).toBe(field);
    }
    const early = failure(() => compileReports(state(), "2025-06-30", { from: "2024-06-01" }));
    expect(early.code).toBe("calendar_not_configured");
    expect(early.details[0]?.path).toBe("from");
  });

  test("malformed or impossible input is invalid, not silently corrected", () => {
    for (const bad of ["2025-02-30", "2025-13-01", "June 30", "2025-6-30", ""]) {
      const error = failure(() => compileReports(state(), bad));
      expect(error.code, bad).toBe("invalid_input");
      expect(error.status).toBe(400);
    }
    expect(failure(() => compileReports(state(), "2025-06-30", { from: "2025-02-31" })).code).toBe(
      "invalid_input",
    );
    const backwards = failure(() => compileReports(state(), "2025-06-30", { from: "2025-07-01" }));
    expect(backwards.code).toBe("invalid_input");
    expect(backwards.message).toMatch(/from must not be after asOf/);
    // One day is a valid range.
    expect(compileReports(state(), "2025-06-30", { from: "2025-06-30" }).periodStart).toBe(
      "2025-06-30",
    );
  });

  test("extending the calendar and adding accounts changes only what the date calls for", () => {
    const book = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART });
    const scenario = new Scenario(book);
    scenario.post("2025-02-10", [
      ["1000", 1_000_00n],
      ["3000", -1_000_00n],
    ]);
    scenario.post("2025-03-10", [
      ["1000", 500_00n],
      ["4000", -500_00n],
    ]);
    const beforeExtension = book.state;
    expect(reportingWindow(beforeExtension)).toEqual({
      firstDate: "2025-01-01",
      lastDate: "2025-12-31",
    });
    book.addAccount({ code: "7000", role: "expense", name: "Software" }, "2025-07-01");
    scenario.post("2025-07-15", [
      ["7000", 20_00n],
      ["1000", -20_00n],
    ]);
    book.extendYears(1);
    scenario.post("2026-01-20", [
      ["1000", 300_00n],
      ["4000", -300_00n],
    ]);
    scenario.post("2026-02-20", [
      ["6000", 40_00n],
      ["1000", -40_00n],
    ]);
    const state = book.state;
    expect(reportingWindow(state)).toEqual({ firstDate: "2025-01-01", lastDate: "2026-12-31" });
    expect(reportCalendar(state).fiscalYears).toEqual([
      { year: 2025, startsOn: "2025-01-01", endsOn: "2025-12-31" },
      { year: 2026, startsOn: "2026-01-01", endsOn: "2026-12-31" },
    ]);

    // The chart in force on a date decides which accounts a report lists.
    const june = compileReports(state, "2025-06-30");
    const july = compileReports(state, "2025-07-31");
    expect(june.trialBalance.rows.some((line) => line.code === "7000")).toBe(false);
    expect(july.trialBalance.rows.some((line) => line.code === "7000")).toBe(true);
    expect(june.trialBalance.rows).toHaveLength(CHART.length);
    expect(july.trialBalance.rows).toHaveLength(CHART.length + 1);
    expect(row(july.profitAndLoss.rows, "7000").amount).toBe("20.00");

    // Dates in the extension have a fiscal year, and the first year's earnings have rolled forward.
    const second = compileReports(state, "2026-02-28");
    expect(second.fiscalYear).toEqual({ year: 2026, startsOn: "2026-01-01", endsOn: "2026-12-31" });
    expect(second.balanceSheet.priorEarnings).toBe("480.00");
    expect(second.balanceSheet.currentEarnings).toBe("260.00");
    expect(second.balanceSheet.equity).toBe("1740.00");
    expect(second.balanceSheet.difference).toBe("0.00");
    // The same date was beyond the calendar before it was extended.
    const early = failure(() => compileReports(beforeExtension, "2026-02-28"));
    expect(early.code).toBe("calendar_not_configured");
    expect(early.message).toContain("2025-01-01 to 2025-12-31");
  });
});

describe("the ledger view", () => {
  test("a comparison with the kernel's own balances catches a report that disagrees", () => {
    const state = generate(13, { firstYear: 2025, years: 1 }).book.state;
    const view = ledgerView(state);
    const included = view.included("2025-12-31");
    expect(included.complete).toBe(true);
    expect(view.included("2025-06-30").complete).toBe(false);
    const balances = new Map<string, bigint>();
    for (const booked of included.journals)
      for (const posting of booked.journal.postings)
        balances.set(
          posting.accountId,
          (balances.get(posting.accountId) ?? 0n) + posting.bookValue.amount.coefficient,
        );
    // A fresh view per state, so each check below runs.
    const fresh = () => ledgerView(generate(13, { firstYear: 2025, years: 1 }).book.state);
    expect(() => fresh().verifyAgainstKernel(balances)).not.toThrow();
    const drifted = new Map(balances);
    drifted.set("1000", (drifted.get("1000") ?? 0n) + 1n);
    const mismatch = failure(() => fresh().verifyAgainstKernel(drifted));
    expect(mismatch.code).toBe("report_integrity_failure");
    const missing = new Map(balances);
    missing.delete("1000");
    expect(failure(() => fresh().verifyAgainstKernel(missing)).code).toBe(
      "report_integrity_failure",
    );
  });

  test("journals are read in accounting-date order whatever order they were posted in", () => {
    const book = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART });
    const may = book.post("2025-05-01", [
      ["1000", 5n],
      ["4000", -5n],
    ]);
    const march = book.post("2025-03-01", [
      ["1000", 3n],
      ["4000", -3n],
    ]);
    const april = book.post("2025-04-01", [
      ["1000", 4n],
      ["4000", -4n],
    ]);
    const ordered = ledgerView(book.state)
      .included("2025-12-31")
      .journals.map((booked) => booked.journal.id as string);
    expect(ordered).toEqual([march, april, may]);
    expect(ledgerView(book.state).included("2025-04-01").journals).toHaveLength(2);
    expect(ledgerView(book.state).latestJournalDate).toBe("2025-05-01");
  });
});

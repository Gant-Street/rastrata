import { describe, expect, test } from "bun:test";
import { shown } from "../tests/support/shown";
import { defaultMessages } from "../src/messages";
import type { CoreReportsData, ReportHrefs } from "../src/reports/data";
import { amountDifference, amountCents } from "../src/reports/format";
import { describeRange } from "../src/reports/period";
import {
  balanceSheetLines,
  balanceSheetMonthlyLines,
  cashFlowLines,
  monthsAddUp,
  profitLossLines,
  profitLossMonthlyLines,
  shareColumns,
  trialBalanceLines,
} from "../src/reports/view-model";
import type { StatementLine } from "../src/reports/statement-table";
import {
  accounts,
  cashFlow,
  coreReports,
  generalLedger,
  hostileNames,
  hrefs,
  manyAccounts,
  monthlyReports,
} from "../stories/reports/fixtures";

const m = defaultMessages.reports;
const options = { showZero: false };
/** The dates of the fixtures' profit and loss, and of the six months before them, as a column says them. */
const thisRange = shown.range("2025-10-01", "2026-03-31");
const earlierRange = shown.range("2025-04-01", "2025-09-30");
const row = (lines: readonly StatementLine[], code: string) => {
  const found = lines.find((line) => line.code === code);
  if (!found) throw new Error(`No line for ${code}`);
  return found;
};
const values = (line: StatementLine | undefined) => line?.figures?.map((figure) => figure?.value);

describe("the fixtures are books that tie, exactly", () => {
  test("assets equal liabilities plus equity, and debits equal credits, with and without a comparison", () => {
    for (const compare of [false, true]) {
      const data = coreReports({ compare });
      const sheet = data.balanceSheet;
      expect(amountDifference(sheet.assets, [sheet.liabilities, sheet.equity])).toBe("0.00");
      expect(sheet.difference).toBe("0.00");
      expect(amountDifference(data.trialBalance.debit, [data.trialBalance.credit])).toBe("0.00");
      expect(data.trialBalance.retainedEarnings?.credit).toBe("18650.00");
      const net = data.profitAndLoss.totals.find((item) => item.key === "netIncome");
      expect(net?.amount).toBe("13039.60");
      if (compare) {
        expect(net?.comparative).toBe("10190.00");
        const equity = sheet.totals.find((item) => item.key === "totalEquity");
        const assets = sheet.totals.find((item) => item.key === "asset");
        const liabilities = sheet.totals.find((item) => item.key === "liability");
        expect(
          amountDifference(assets?.comparative ?? "", [
            liabilities?.comparative ?? "",
            equity?.comparative ?? "",
          ]),
        ).toBe("0.00");
      }
    }
  });

  test("the cash flow ties, tagged or not", () => {
    for (const untagged of [false, true]) {
      const flow = cashFlow({ untagged });
      const sections = flow.sections.reduce((all, item) => all + amountCents(item.total), 0n);
      expect(sections).toBe(amountCents(flow.netChange ?? "0.00"));
      expect(
        amountDifference(flow.closingCash ?? "", [flow.openingCash ?? "", flow.netChange ?? ""]),
      ).toBe("0.00");
      const accountsChange = flow.cashAccounts.reduce(
        (all, item) => all + amountCents(item.change),
        0n,
      );
      expect(accountsChange).toBe(amountCents(flow.netChange ?? "0.00"));
      for (const item of flow.sections)
        expect(item.lines.reduce((all, entry) => all + amountCents(entry.amount), 0n)).toBe(
          amountCents(item.total),
        );
    }
  });
});

/** The studio's income is 24,400.00 (Design fees 18,400.00 and Retainers 6,000.00), and the six months before
 * had 21,100.00 (15,100.00 and 6,000.00). Worked by hand, tenths of a percent, ties away from zero:
 * 18,400 / 24,400 = 75.409 -> 75.4; 6,000 / 24,400 = 24.590 -> 24.6; 200 / 24,400 = 0.819 -> 0.8;
 * Software 1,260.40 / 24,400 = 5.165 -> 5.2; Contractors 5,200 = 21.311 -> 21.3; Rent 4,500 = 18.442 -> 18.4;
 * Depreciation 600 = 2.459 -> 2.5; expenses 11,560.40 = 47.379 -> 47.4; income and gains 24,600 = 100.819 ->
 * 100.8; net income 13,039.60 = 53.441 -> 53.4. The earlier period: 15,100 / 21,100 = 71.563 -> 71.6;
 * 6,000 / 21,100 = 28.436 -> 28.4; Software 1,010 = 4.786 -> 4.8; Contractors 4,800 = 22.748 -> 22.7;
 * Rent 4,500 = 21.327 -> 21.3; Depreciation 600 = 2.843 -> 2.8. */
describe("profit and loss lines with shares of income", () => {
  const shares = (line: StatementLine | undefined) =>
    line?.figures?.filter((figure) => figure?.kind === "share").map((figure) => figure?.value);

  test("a share column follows the amount, set by the service and never worked out here", () => {
    const {
      lines,
      columns,
      hints,
      shares: hasShares,
    } = profitLossLines(coreReports({ share: true }), hrefs, m, options);
    expect(hasShares).toBe(true);
    expect(columns).toEqual([`${thisRange} · USD`, "% of income"]);
    expect(hints).toEqual([undefined, thisRange]);
    expect(values(row(lines, "4000"))).toEqual(["18400.00", "75.4"]);
    expect(values(row(lines, "4100"))).toEqual(["6000.00", "24.6"]);
    expect(values(row(lines, "4900"))).toEqual(["200.00", "0.8"]);
    expect(values(row(lines, "5000"))).toEqual(["1260.40", "5.2"]);
    expect(values(row(lines, "5100"))).toEqual(["5200.00", "21.3"]);
    expect(values(row(lines, "5200"))).toEqual(["4500.00", "18.4"]);
    expect(values(row(lines, "6100"))).toEqual(["600.00", "2.5"]);
    // The totals carry theirs: income is all of itself, and net income is the line the statement exists for.
    const totals = lines.filter((line) => line.kind === "subtotal" || line.kind === "total");
    expect(totals.map((line) => [line.label, values(line)])).toEqual([
      ["Total income", ["24400.00", "100.0"]],
      ["Total gains", ["200.00", "0.8"]],
      ["Total expenses", ["11560.40", "47.4"]],
      ["Total income and gains", ["24600.00", "100.8"]],
      ["Net income", ["13039.60", "53.4"]],
    ]);
    // Only the shares are share cells; an amount is an amount, with its link.
    expect(shares(row(lines, "4000"))).toEqual(["75.4"]);
    expect(row(lines, "4000").figures?.[0]).toMatchObject({
      value: "18400.00",
      href: "/ledger?accountId=4000&span=range&column=current",
    });
    expect(row(lines, "4000").figures?.[0]?.kind).toBeUndefined();
  });

  test("a comparison has a share of its own beside its amount, and the change closes the row", () => {
    const { lines, columns, hints } = profitLossLines(
      coreReports({ share: true, compare: true }),
      hrefs,
      m,
      options,
    );
    expect(columns).toEqual([
      `${thisRange} · USD`,
      "% of income",
      `${earlierRange} · USD`,
      "% of income",
      `Change · USD`,
    ]);
    // A screen reader hears which period each share is for.
    expect(hints).toEqual([undefined, thisRange, undefined, earlierRange, undefined]);
    expect(values(row(lines, "4000"))).toEqual(["18400.00", "75.4", "15100.00", "71.6", "3300.00"]);
    expect(values(row(lines, "5100"))).toEqual(["5200.00", "21.3", "4800.00", "22.7", "400.00"]);
    // The comparison is divided by its own period's income: 4,800 / 21,100, and not 4,800 / 24,400 (19.7).
    expect(values(row(lines, "5100"))?.[3]).not.toBe("19.7");
    const net = lines.at(-1);
    expect(net).toMatchObject({ kind: "total", label: "Net income" });
    expect(values(net)).toEqual(["13039.60", "53.4", "10190.00", "48.3", "2849.60"]);
  });

  test("a period with no income has the column and a dash in every cell, and the warning says why", () => {
    const data = coreReports({
      share: true,
      accounts: accounts.map((account) =>
        account.role === "income" || account.role === "gain"
          ? { ...account, now: 0n, earlier: 0n }
          : account,
      ),
      totalsFromAccounts: true,
    });
    expect(data.warnings.map((warning) => warning.code)).toEqual(["share_unavailable"]);
    const {
      lines,
      columns,
      shares: hasShares,
    } = profitLossLines(data, hrefs, m, {
      showZero: true,
    });
    expect(hasShares).toBe(true);
    expect(columns).toHaveLength(2);
    for (const line of lines.filter((entry) => entry.figures)) {
      const cells = line.figures ?? [];
      expect(cells[1]?.kind, line.label).toBe("share");
      expect(cells[1]?.value, line.label).toBe("");
    }
  });

  test("a comparison period with no income has dashes beside its amounts while the period keeps its shares", () => {
    const data = coreReports({
      share: true,
      compare: true,
      accounts: accounts.map((account) =>
        account.role === "income" || account.role === "gain"
          ? { ...account, earlier: 0n }
          : account,
      ),
      totalsFromAccounts: true,
    });
    expect(data.warnings.map((warning) => warning.code)).toEqual(["comparison_share_unavailable"]);
    expect(shareColumns(data)).toEqual({ current: true, comparison: true });
    const { lines } = profitLossLines(data, hrefs, m, options);
    const software = values(row(lines, "5000"));
    expect(software?.[1]).toBe("5.2");
    expect(software?.[3]).toBe("");
    expect(row(lines, "5000").figures?.[3]).toEqual({ value: "", kind: "share" });
  });

  test("a loss is a negative share of income", () => {
    const data = coreReports({
      share: true,
      accounts: accounts.map((account) =>
        account.role === "expense" ? { ...account, now: account.now * 3n } : account,
      ),
      totalsFromAccounts: true,
    });
    // Expenses 34,681.20 on income 24,400.00 and gains 200.00: net income -10,081.20 = -41.316 -> -41.3.
    const { lines } = profitLossLines(data, hrefs, m, options);
    expect(values(lines.at(-1))).toEqual(["-10081.20", "-41.3"]);
  });

  test("a report read without shares has none of this: the columns are what they always were", () => {
    const plain = profitLossLines(coreReports(), hrefs, m, options);
    expect(plain.shares).toBe(false);
    expect(plain.columns).toEqual([`${thisRange} · USD`]);
    expect(plain.hints).toEqual([undefined]);
    for (const line of plain.lines.filter((entry) => entry.figures))
      expect(line.figures).toHaveLength(1);
    const compared = profitLossLines(coreReports({ compare: true }), hrefs, m, options);
    expect(compared.columns).toHaveLength(3);
    expect(shareColumns(coreReports())).toEqual({ current: false, comparison: false });
    expect(shareColumns(coreReports({ compare: true }))).toEqual({
      current: false,
      comparison: false,
    });
  });

  test("the balance sheet and the cash flow ignore shares even when the report has them", () => {
    const data = coreReports({ share: true, compare: true });
    const sheet = balanceSheetLines(data, hrefs, m, options);
    expect(sheet.columns).toHaveLength(3);
    for (const line of sheet.lines.filter((entry) => entry.figures))
      expect(line.figures?.every((figure) => figure?.kind === undefined)).toBe(true);
  });
});

describe("profit and loss lines", () => {
  test("income, gains and expenses each close with their total, and net income is the total", () => {
    const { lines, columns, hidden } = profitLossLines(coreReports(), hrefs, m, options);
    expect(lines.filter((line) => line.kind === "heading").map((line) => line.label)).toEqual([
      "Income",
      "Gains",
      "Expenses",
    ]);
    expect(lines.filter((line) => line.kind === "subtotal").map((line) => line.label)).toEqual([
      "Total income",
      "Total gains",
      "Total expenses",
      "Total income and gains",
    ]);
    expect(lines.at(-1)).toMatchObject({ kind: "total", label: "Net income" });
    expect(values(lines.at(-1))).toEqual(["13039.60"]);
    expect(columns).toEqual([`${shown.range("2025-10-01", "2026-03-31")} · USD`]);
    // The account with no activity is left out, and counted.
    expect(hidden).toBe(1);
    expect(lines.some((line) => line.code === "6900")).toBe(false);
  });

  test("showing accounts with no activity brings them back and the count to zero", () => {
    const revealed = profitLossLines(coreReports(), hrefs, m, { showZero: true });
    expect(revealed.hidden).toBe(0);
    expect(values(row(revealed.lines, "6900"))).toEqual(["0.00"]);
  });

  test("every amount links to the activity behind it, and says where it goes", () => {
    const { lines } = profitLossLines(coreReports(), hrefs, m, options);
    const fees = row(lines, "4000");
    expect(fees.figures?.[0]).toEqual({
      value: "18400.00",
      href: "/ledger?accountId=4000&span=range&column=current",
      context: "activity for 4000 Design fees",
    });
  });

  test("a comparison adds its own period, the change, and its own links", () => {
    const { lines, columns } = profitLossLines(coreReports({ compare: true }), hrefs, m, options);
    expect(columns).toEqual([
      `${shown.range("2025-10-01", "2026-03-31")} · USD`,
      `${shown.range("2025-04-01", "2025-09-30")} · USD`,
      "Change · USD",
    ]);
    const fees = row(lines, "4000");
    expect(values(fees)).toEqual(["18400.00", "15100.00", "3300.00"]);
    expect(fees.figures?.[1]?.href).toBe("/ledger?accountId=4000&span=range&column=comparison");
    expect(fees.figures?.[1]?.context).toBe(
      `activity for 4000 Design fees, ${shown.range("2025-04-01", "2025-09-30")}`,
    );
    expect(fees.figures?.[2]?.href).toBeUndefined();
    // An account with no activity in either period stays hidden; one with activity in only one stays.
    expect(lines.some((line) => line.code === "6900")).toBe(false);
    expect(values(row(lines, "4900"))).toEqual(["200.00", "0.00", "200.00"]);
  });

  test("a book with no gains shows no gains group and no combined total", () => {
    const data = coreReports({ accounts: accounts.filter((account) => account.role !== "gain") });
    const { lines } = profitLossLines(data, hrefs, m, options);
    expect(lines.filter((line) => line.kind === "heading").map((line) => line.label)).toEqual([
      "Income",
      "Expenses",
    ]);
    expect(lines.some((line) => line.key === "total-revenue")).toBe(false);
  });

  test("an empty group says so rather than showing nothing", () => {
    const data = coreReports({
      accounts: accounts.filter((account) => account.role !== "expense"),
    });
    const { lines } = profitLossLines(data, hrefs, m, options);
    expect(lines.find((line) => line.key === "none-expense")?.label).toBe(
      "No activity in these dates.",
    );
  });
});

describe("balance sheet lines", () => {
  test("assets, liabilities and equity, with the computed earnings marked as calculated", () => {
    const { lines, columns, hidden } = balanceSheetLines(coreReports(), hrefs, m, options);
    expect(lines.filter((line) => line.kind === "heading").map((line) => line.label)).toEqual([
      "Assets",
      "Liabilities",
      "Equity",
    ]);
    const calculated = lines.filter((line) => line.kind === "calculated");
    expect(calculated.map((line) => line.label)).toEqual([
      "Retained earnings from earlier fiscal years (calculated)",
      "Earnings this fiscal year to date (calculated)",
    ]);
    expect(calculated[0]?.note).toBe(m.views.earningsNote);
    expect(values(calculated[0])).toEqual(["18650.00"]);
    expect(values(calculated[1])).toEqual(["13039.60"]);
    expect(lines.at(-1)).toMatchObject({ kind: "total", label: "Total liabilities and equity" });
    expect(values(lines.at(-1))).toEqual(["39300.00"]);
    expect(columns).toEqual([`As of ${shown.date("2026-03-31")} · USD`]);
    expect(hidden).toBe(1);
    expect(lines.some((line) => line.code === "2300")).toBe(false);
  });

  test("a contra account and a draw show as negative figures, never as a different sign convention", () => {
    const { lines } = balanceSheetLines(coreReports(), hrefs, m, options);
    expect(values(row(lines, "1600"))).toEqual(["-1800.00"]);
    expect(values(row(lines, "3100"))).toEqual(["-3600.00"]);
  });

  test("balance-sheet amounts drill into the fiscal year, where the balance is carried from", () => {
    const { lines } = balanceSheetLines(coreReports(), hrefs, m, options);
    expect(row(lines, "1000").figures?.[0]?.href).toBe(
      "/ledger?accountId=1000&span=fiscalYear&column=current",
    );
  });

  test("the comparison column is the balance sheet as of the earlier date", () => {
    const { lines, columns } = balanceSheetLines(coreReports({ compare: true }), hrefs, m, options);
    expect(columns[1]).toBe(`As of ${shown.date("2025-09-30")} · USD`);
    expect(values(row(lines, "1000"))).toEqual(["29800.00", "18000.00", "11800.00"]);
  });
});

describe("trial balance lines", () => {
  test("debits and credits sit in their own columns, a zero side is left blank, and the totals agree", () => {
    const { lines, columns } = trialBalanceLines(coreReports(), hrefs, m, options);
    expect(columns).toEqual(["Debit · USD", "Credit · USD"]);
    expect(values(row(lines, "1000"))).toEqual(["29800.00", undefined]);
    expect(values(row(lines, "2000"))).toEqual([undefined, "1210.40"]);
    const earlier = lines.find((line) => line.kind === "calculated");
    expect(values(earlier)).toEqual([undefined, "18650.00"]);
    const totals = lines.at(-1);
    expect(totals).toMatchObject({ kind: "total", label: "Total" });
    expect(totals?.figures?.[0]?.value).toBe(totals?.figures?.[1]?.value);
  });
});

describe("cash flow lines", () => {
  test("sections open with a heading, group their adjustments, and close with their totals", () => {
    const { lines } = cashFlowLines(cashFlow(), hrefs, m);
    expect(lines.filter((line) => line.kind === "heading").map((line) => line.label)).toEqual([
      "Operating activities",
      "Investing activities",
      "Financing activities",
    ]);
    expect(lines.filter((line) => line.kind === "subheading").map((line) => line.label)).toEqual([
      "Adjustments for non-cash items",
      "Changes in working capital",
    ]);
    expect(lines.filter((line) => line.kind === "subtotal").map((line) => line.label)).toEqual([
      "Net cash from operating activities",
      "Net cash from investing activities",
      "Net cash from financing activities",
      "Net change in cash",
    ]);
    // It ends as a cash flow statement does: what changed, then the cash it started and ended with.
    expect(lines.slice(-3).map((line) => line.label)).toEqual([
      "Net change in cash",
      "Cash at the start of the period",
      "Cash at the end of the period",
    ]);
    expect(lines.at(-1)).toMatchObject({ kind: "total", label: "Cash at the end of the period" });
    expect(values(lines.at(-3))).toEqual(["11800.00"]);
    expect(values(lines.at(-2))).toEqual(["23000.00"]);
    expect(values(lines.at(-1))).toEqual(["34800.00"]);
    // Net income has no account to drill into; an account line does.
    expect(
      lines.find((line) => line.key === "operating-netIncome")?.figures?.[0]?.href,
    ).toBeUndefined();
    expect(row(lines, "1500").figures?.[0]?.href).toBe(
      "/ledger?accountId=1500&span=range&column=current",
    );
  });

  test("an account without a tag is flagged in words, in its own section", () => {
    const { lines } = cashFlowLines(cashFlow({ untagged: true }), hrefs, m);
    const flagged = lines.filter((line) => line.flag);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ code: "2300", flag: "Needs a tag" });
    expect(lines.some((line) => line.label === "Not classified")).toBe(true);
    expect(values(lines.at(-3))).toEqual(["12120.00"]);
  });

  test("a comparison carries its own figures and links for each line", () => {
    const { lines, columns } = cashFlowLines(cashFlow({ compare: true }), hrefs, m);
    expect(columns).toHaveLength(3);
    expect(values(lines.at(-3))).toEqual(["11800.00", "9440.00", "2360.00"]);
    expect(values(row(lines, "2000"))).toEqual(["860.40", "-150.00", "1010.40"]);
  });
});

describe("the mapping never changes a figure, whatever the accounts are called", () => {
  test("every amount on every line is an amount the service sent, byte for byte", () => {
    const data = coreReports({
      compare: true,
      accounts: [...accounts, ...hostileNames, ...manyAccounts(60)],
    });
    const sent = new Set<string>();
    const collect = (value: unknown) => {
      if (typeof value === "string" && /^-?\d+\.\d{2}$/.test(value)) sent.add(value);
      else if (value && typeof value === "object") Object.values(value).forEach(collect);
    };
    collect(data);
    for (const build of [profitLossLines, balanceSheetLines, trialBalanceLines]) {
      const { lines } = build(data, hrefs, m, { showZero: true });
      for (const line of lines)
        for (const figure of line.figures ?? [])
          if (figure) expect(sent.has(figure.value), `${line.label}: ${figure.value}`).toBe(true);
    }
    // Hostile text arrives as plain labels, never as markup or a link target.
    const { lines } = profitLossLines(data, hrefs, m, { showZero: true });
    const hostile = row(lines, "7002");
    expect(hostile.label).toBe("<script>alert(1)</script> & \"quotes\" 'apostrophes'");
    expect(hostile.figures?.[0]?.href).toBe("/ledger?accountId=7002&span=range&column=current");
  });

  test("a general ledger fixture pages like the service: a hundred lines a page", () => {
    const ledger = generalLedger({ lines: 100 });
    expect(ledger.lines).toHaveLength(100);
    expect(ledger.count).toBe(340);
    expect(ledger.pageSize).toBe(100);
    expect(generalLedger().lines).toHaveLength(8);
  });
});

describe("a report by month", () => {
  const reports = monthlyReports();
  /** Where an amount leads, as the application builds it: the dates and population of its own column. */
  const hrefsFor = (data: CoreReportsData): ReportHrefs => ({
    account: (accountId, span) =>
      `/ledger?accountId=${accountId}&asOf=${data.asOf}&from=${data.periodStart}&span=${span}&population=${data.populationHash}`,
  });
  const cents = (line: StatementLine | undefined, from: number, to: number): bigint =>
    (line?.figures ?? [])
      .slice(from, to)
      .reduce((all, figure) => all + amountCents(figure?.value ?? "0.00"), 0n);

  test("the fixture's months add up to its total, and each month's sheet balances, to the cent", () => {
    expect(monthsAddUp(reports)).toBeNull();
    for (const column of reports.months) {
      const sheet = column.data.balanceSheet;
      expect(amountDifference(sheet.assets, [sheet.liabilities, sheet.equity])).toBe("0.00");
    }
    // March is the book as the single-period fixture has it at the end of March.
    expect(reports.months.at(-1)?.data.balanceSheet.assets).toBe(coreReports().balanceSheet.assets);
  });

  describe("profit and loss", () => {
    const { lines, columns, hidden } = profitLossMonthlyLines(reports, hrefsFor, m, options);

    test("a column for each month, in order, and one for the whole range", () => {
      expect(columns).toEqual([
        "Oct 2025",
        "Nov 2025",
        "Dec 2025",
        "Jan 2026",
        "Feb 2026",
        "Mar 2026",
        "Total · USD",
      ]);
    });

    test("every account's months add up to its total, and so do the totals", () => {
      for (const line of lines.filter(
        (item) => item.kind !== "heading" && item.kind !== "subheading",
      )) {
        const total = line.figures?.at(-1)?.value;
        expect(cents(line, 0, columns.length - 1), line.label).toBe(amountCents(total ?? "0.00"));
      }
      const net = lines.at(-1);
      expect(net).toMatchObject({ kind: "total", label: "Net income" });
      expect(net?.figures?.at(-1)?.value).toBe("13039.60");
    });

    test("the groups and their totals are the single period's", () => {
      const single = profitLossLines(coreReports(), hrefs, m, options).lines;
      expect(lines.map((line) => [line.kind, line.label])).toEqual(
        single.map((line) => [line.kind, line.label]),
      );
      // The total column is the single-period statement, figure for figure.
      for (const [index, line] of single.entries())
        expect(lines[index]?.figures?.at(-1)?.value).toBe(line.figures?.[0]?.value);
    });

    test("each figure leads to the activity of its own month, in that month's population", () => {
      const fees = row(lines, "4000");
      const month = reports.months[2];
      expect(fees.figures?.[2]?.href).toBe(
        `/ledger?accountId=4000&asOf=${month?.to}&from=${month?.from}&span=range&population=${month?.data.populationHash}`,
      );
      expect(fees.figures?.[2]?.context).toBe(
        `activity for 4000 Design fees, ${describeRange({ from: month?.from ?? "", to: month?.to ?? "" })}`,
      );
      // The total column leads to the whole range.
      expect(fees.figures?.at(-1)?.href).toContain(`asOf=${reports.total.asOf}`);
      expect(fees.figures?.at(-1)?.href).toContain(`from=${reports.total.periodStart}`);
      // Every month has its own fingerprint.
      const hashes = new Set(reports.months.map((column) => column.data.populationHash));
      expect(hashes.size).toBe(reports.months.length);
    });

    test("an account with no activity in any column is hidden and counted, and shown on request", () => {
      expect(hidden).toBe(1);
      expect(lines.some((line) => line.code === "6900")).toBe(false);
      const shownAll = profitLossMonthlyLines(reports, hrefsFor, m, { showZero: true });
      expect(shownAll.hidden).toBe(0);
      expect(values(row(shownAll.lines, "6900"))).toEqual(Array(7).fill("0.00"));
    });

    test("a month the range covers only part of says which days", () => {
      const partial = {
        ...reports,
        months: reports.months.map((column, index) =>
          index === reports.months.length - 1
            ? { ...column, to: "2026-03-05", partial: true, endsMonth: false }
            : column,
        ),
      };
      const headings = profitLossMonthlyLines(partial, hrefsFor, m, options).columns;
      expect(headings.at(-2)).toBe(describeRange({ from: "2026-03-01", to: "2026-03-05" }));
      expect(headings[0]).toBe("Oct 2025");
    });

    test("an account that appears only in some months is still one row, with zeros elsewhere", () => {
      const lateAccount = {
        accountId: "4900-late",
        code: "4950",
        name: "Opened in March",
        role: "income",
        amount: "75.00",
      };
      const withLate = {
        ...reports,
        months: reports.months.map((column, index) =>
          index === reports.months.length - 1
            ? {
                ...column,
                data: {
                  ...column.data,
                  profitAndLoss: {
                    ...column.data.profitAndLoss,
                    rows: [...column.data.profitAndLoss.rows, lateAccount],
                  },
                },
              }
            : column,
        ),
      };
      const built = profitLossMonthlyLines(withLate, hrefsFor, m, options);
      const late = row(built.lines, "4950");
      expect(values(late)).toEqual(["0.00", "0.00", "0.00", "0.00", "0.00", "75.00", "0.00"]);
      // A cell the read did not have is not a link.
      expect(late.figures?.[0]?.href).toBeUndefined();
      expect(late.figures?.[5]?.href).toBeDefined();
      expect(built.lines.filter((line) => line.code === "4950")).toHaveLength(1);
    });

    test("the months are checked against the total, not assumed to agree with it", () => {
      expect(monthsAddUp(reports)).toBeNull();
      const wrong = {
        ...reports,
        total: {
          ...reports.total,
          profitAndLoss: {
            ...reports.total.profitAndLoss,
            totals: reports.total.profitAndLoss.totals.map((total) =>
              total.key === "netIncome" ? { ...total, amount: "13039.61" } : total,
            ),
          },
        },
      };
      expect(monthsAddUp(wrong)).toBe("netIncome");
    });
  });

  describe("balance sheet", () => {
    const { lines, columns } = balanceSheetMonthlyLines(reports, hrefsFor, m, options);

    test("a column for the end of each month and none for a total", () => {
      expect(columns).toEqual([
        "Oct 2025",
        "Nov 2025",
        "Dec 2025",
        "Jan 2026",
        "Feb 2026",
        "Mar 2026",
      ]);
    });

    test("every column balances: total assets equal total liabilities and equity", () => {
      const assets = lines.find((line) => line.key === "total-asset");
      const both = lines.find((line) => line.key === "liabilities-and-equity");
      expect(both?.kind).toBe("total");
      expect(values(both)).toEqual(values(assets));
      expect(values(both)).not.toEqual(Array(6).fill(values(both)?.[0]));
    });

    test("earnings to date grow month by month and the last column is the single-period sheet", () => {
      const earnings = lines.find((line) => line.key === "current-earnings");
      const figures = (earnings?.figures ?? []).map((figure) => amountCents(figure?.value ?? "0"));
      expect(figures).toEqual([...figures].sort((left, right) => (left < right ? -1 : 1)));
      const single = balanceSheetLines(coreReports(), hrefs, m, options).lines;
      for (const [index, line] of single.entries())
        expect(lines[index]?.figures?.at(-1)?.value).toBe(line.figures?.[0]?.value);
    });

    test("balance-sheet amounts drill into the fiscal year of their own column", () => {
      const cash = row(lines, "1000");
      expect(cash.figures?.[0]?.href).toContain("span=fiscalYear");
      expect(cash.figures?.[0]?.href).toContain(`asOf=${reports.months[0]?.to}`);
    });
  });
});

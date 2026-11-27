import { formatMonthShort, moneyToCents } from "../format";
import type {
  CashFlowData,
  CoreReportsData,
  MonthlyReports,
  ReportHrefs,
  ScopeData,
  StatementRowData,
  StatementTotalData,
} from "./data";
import type { Figure, StatementLine } from "./statement-table";
import type { reportsMessages } from "./messages";
import { describeDate, describeRange } from "./period";

type Messages = typeof reportsMessages;

/** Turning a service result into the lines a statement table shows. Everything here is a function
 * of the data it is given: no figure is computed (the service computed them), no row is invented,
 * and an account that has nothing to show is hidden only when the caller says so and is always
 * counted, so nothing disappears silently. Pure and exact: amounts stay wire strings. */

const ZERO = "0.00";
const isZero = (value: string | undefined): boolean => value === undefined || value === ZERO;

export interface LinesResult {
  readonly lines: StatementLine[];
  /** Column headings after the account column, in order. */
  readonly columns: string[];
  /** Accounts left out because they had no activity. */
  readonly hidden: number;
  /** More for a screen reader after a heading, one entry per column: which period a share is for. */
  readonly hints?: (string | undefined)[];
  /** The profit and loss was read with shares of income, so it has share columns. */
  readonly shares?: boolean;
}

/** The headings of the figure columns: the period, and with a comparison, the comparison's own
 * period and the change between them. */
function periodColumns(
  scope: ScopeData & { comparison: CoreReportsData["comparison"] },
  m: Messages,
  asOf: boolean,
): string[] {
  const name = (from: string, to: string) =>
    asOf ? m.columns.asOf(to) : describeRange({ from, to });
  const current = m.columns.currency(name(scope.periodStart, scope.asOf), scope.currency);
  if (!scope.comparison) return [current];
  return [
    current,
    m.columns.currency(name(scope.comparison.periodStart, scope.comparison.asOf), scope.currency),
    m.columns.currency(m.table.change, scope.currency),
  ];
}

/** Which share columns a profit and loss has: one beside the period's amount, and one beside the
 * comparison's. */
export interface ShareColumns {
  readonly current: boolean;
  readonly comparison: boolean;
}

const NO_SHARES: ShareColumns = { current: false, comparison: false };

/** The warning codes with which the service says a period had no income to take a share of. */
const SHARE_UNAVAILABLE = "share_unavailable";
const COMPARISON_SHARE_UNAVAILABLE = "comparison_share_unavailable";

/** The share columns a profit and loss was read with. They follow what the service sent and not the choice
 * that asked for them, so a report read before the choice was made has none and the figures on screen are
 * never dressed up as something they were not read as: a period with income has a share on every line, and a
 * period with none has the column and an empty cell on every line, with the service's warning saying why. */
export function shareColumns(data: CoreReportsData): ShareColumns {
  const { rows, totals } = data.profitAndLoss;
  const lines: readonly { share?: string | undefined; comparativeShare?: string | undefined }[] = [
    ...rows,
    ...totals,
  ];
  const warned = (code: string) => data.warnings.some((warning) => warning.code === code);
  const current = lines.some((line) => line.share !== undefined) || warned(SHARE_UNAVAILABLE);
  const comparison =
    current &&
    data.comparison !== null &&
    (lines.some((line) => line.comparativeShare !== undefined) ||
      warned(COMPARISON_SHARE_UNAVAILABLE));
  return { current, comparison };
}

/** A share as a cell: the share when the line has one, and an empty share (a dash) when it has none. */
const shareFigure = (value: string | undefined): Figure => ({
  value: value ?? "",
  kind: "share",
});

/** One row's figures for a period column, its share when there is a share column, a comparison column with
 * its share, and the change. */
function rowFigures(
  row: {
    amount: string;
    comparative?: string | undefined;
    change?: string | undefined;
    share?: string | undefined;
    comparativeShare?: string | undefined;
  },
  comparing: boolean,
  links: { current?: string | undefined; comparison?: string | undefined },
  context: { current?: string | undefined; comparison?: string | undefined },
  shares: ShareColumns = NO_SHARES,
): (Figure | undefined)[] {
  const current: Figure = { value: row.amount, href: links.current, context: context.current };
  const figures: (Figure | undefined)[] = [current];
  if (shares.current) figures.push(shareFigure(row.share));
  if (!comparing) return figures;
  figures.push(
    row.comparative === undefined
      ? undefined
      : { value: row.comparative, href: links.comparison, context: context.comparison },
  );
  if (shares.comparison) figures.push(shareFigure(row.comparativeShare));
  figures.push(row.change === undefined ? undefined : { value: row.change });
  return figures;
}

function accountLine(
  row: StatementRowData,
  scope: ScopeData & { comparison: CoreReportsData["comparison"] },
  hrefs: ReportHrefs,
  m: Messages,
  span: "range" | "fiscalYear",
  shares: ShareColumns = NO_SHARES,
): StatementLine {
  const name = `${row.code} ${row.name}`;
  const comparing = scope.comparison !== null;
  return {
    key: row.accountId,
    kind: "account",
    label: row.name,
    code: row.code,
    figures: rowFigures(
      row,
      comparing,
      {
        current: hrefs.account(row.accountId, span, "current"),
        comparison: comparing ? hrefs.account(row.accountId, span, "comparison") : undefined,
      },
      {
        current: m.table.drill(name),
        comparison: scope.comparison
          ? m.table.drillComparative(
              name,
              describeRange({ from: scope.comparison.periodStart, to: scope.comparison.asOf }),
            )
          : undefined,
      },
      shares,
    ),
  };
}

function totalLine(
  key: string,
  kind: StatementLine["kind"],
  total: StatementTotalData | undefined,
  comparing: boolean,
  extra: Partial<StatementLine> = {},
  shares: ShareColumns = NO_SHARES,
): StatementLine[] {
  if (!total) return [];
  return [
    {
      key,
      kind,
      label: total.label,
      figures: rowFigures(total, comparing, {}, {}, shares),
      ...extra,
    },
  ];
}

const hidden = (row: { amount: string; comparative?: string | undefined }): boolean =>
  isZero(row.amount) && isZero(row.comparative);

/** The headings of the profit and loss's figure columns, and what a screen reader hears after each: the
 * period, its share, the comparison period, its share, and the change. A share column is headed "% of
 * income" and says in the hint which period it belongs to. */
function profitLossColumns(
  scope: ScopeData & { comparison: CoreReportsData["comparison"] },
  m: Messages,
  shares: ShareColumns,
): { columns: string[]; hints: (string | undefined)[] } {
  const period = describeRange({ from: scope.periodStart, to: scope.asOf });
  const columns = [m.columns.currency(period, scope.currency)];
  const hints: (string | undefined)[] = [undefined];
  if (shares.current) {
    columns.push(m.share.heading);
    hints.push(period);
  }
  if (scope.comparison) {
    const earlier = describeRange({
      from: scope.comparison.periodStart,
      to: scope.comparison.asOf,
    });
    columns.push(m.columns.currency(earlier, scope.currency));
    hints.push(undefined);
    if (shares.comparison) {
      columns.push(m.share.heading);
      hints.push(earlier);
    }
    columns.push(m.columns.currency(m.table.change, scope.currency));
    hints.push(undefined);
  }
  return { columns, hints };
}

/** The profit and loss: income, gains, expenses, each with its total, then net income. When it was read
 * with shares of income, each amount is followed by its share (and the comparison's by its own). */
export function profitLossLines(
  data: CoreReportsData,
  hrefs: ReportHrefs,
  m: Messages,
  options: { showZero: boolean },
): LinesResult {
  const comparing = data.comparison !== null;
  const shares = shareColumns(data);
  const totals = new Map(data.profitAndLoss.totals.map((item) => [item.key, item]));
  const lines: StatementLine[] = [];
  let skipped = 0;
  const groups = ["income", "gain", "unrealizedGain", "expense"] as const;
  for (const role of groups) {
    const rows = data.profitAndLoss.rows.filter((row) => row.role === role);
    if (rows.length === 0 && role !== "income" && role !== "expense") continue;
    lines.push({ key: `heading-${role}`, kind: "heading", label: m.groups[role] });
    const shown = rows.filter((row) => options.showZero || !hidden(row));
    skipped += rows.length - shown.length;
    for (const row of shown) lines.push(accountLine(row, data, hrefs, m, "range", shares));
    if (shown.length === 0)
      lines.push({ key: `none-${role}`, kind: "subheading", label: m.cashFlow.noActivity });
    lines.push(...totalLine(`total-${role}`, "subtotal", totals.get(role), comparing, {}, shares));
  }
  if (data.profitAndLoss.rows.some((row) => row.role === "gain" || row.role === "unrealizedGain"))
    lines.push(
      ...totalLine("total-revenue", "subtotal", totals.get("revenue"), comparing, {}, shares),
    );
  lines.push(...totalLine("net-income", "total", totals.get("netIncome"), comparing, {}, shares));
  const { columns, hints } = profitLossColumns(data, m, shares);
  return { lines, columns, hidden: skipped, hints, shares: shares.current };
}

/** The balance sheet: assets, liabilities, and equity with the earnings the book computes. */
export function balanceSheetLines(
  data: CoreReportsData,
  hrefs: ReportHrefs,
  m: Messages,
  options: { showZero: boolean },
): LinesResult {
  const comparing = data.comparison !== null;
  const totals = new Map(data.balanceSheet.totals.map((item) => [item.key, item]));
  const lines: StatementLine[] = [];
  let skipped = 0;
  for (const role of ["asset", "liability", "equity"] as const) {
    const rows = data.balanceSheet.rows.filter((row) => row.role === role);
    lines.push({ key: `heading-${role}`, kind: "heading", label: m.groups[role] });
    const shown = rows.filter((row) => options.showZero || !hidden(row));
    skipped += rows.length - shown.length;
    for (const row of shown) lines.push(accountLine(row, data, hrefs, m, "fiscalYear"));
    if (role === "equity") {
      // The earnings are worked out from the postings, not held in an account, and the statement says so.
      lines.push(
        ...totalLine("prior-earnings", "calculated", totals.get("priorEarnings"), comparing, {
          note: m.views.earningsNote,
        }),
        ...totalLine("current-earnings", "calculated", totals.get("currentEarnings"), comparing),
        ...totalLine("total-equity", "subtotal", totals.get("totalEquity"), comparing),
      );
    } else {
      if (shown.length === 0)
        lines.push({ key: `none-${role}`, kind: "subheading", label: m.cashFlow.noActivity });
      lines.push(...totalLine(`total-${role}`, "subtotal", totals.get(role), comparing));
    }
  }
  lines.push(
    ...totalLine("liabilities-and-equity", "total", totals.get("liabilitiesAndEquity"), comparing),
  );
  return { lines, columns: periodColumns(data, m, true), hidden: skipped };
}

/** The trial balance: every account's debit or credit, the earnings of earlier years as a
 * calculated line, and the totals that must agree. */
export function trialBalanceLines(
  data: CoreReportsData,
  hrefs: ReportHrefs,
  m: Messages,
  options: { showZero: boolean },
): LinesResult {
  const lines: StatementLine[] = [];
  let skipped = 0;
  const side = (value: string): Figure | undefined => (isZero(value) ? undefined : { value });
  for (const row of data.trialBalance.rows) {
    const empty = isZero(row.debit) && isZero(row.credit);
    if (empty && !options.showZero) {
      skipped += 1;
      continue;
    }
    const name = `${row.code} ${row.name}`;
    const link = {
      href: hrefs.account(row.accountId, "fiscalYear", "current"),
      context: m.table.drill(name),
    };
    lines.push({
      key: row.accountId,
      kind: "account",
      label: row.name,
      code: row.code,
      figures: [
        isZero(row.debit)
          ? empty
            ? { value: ZERO, ...link }
            : undefined
          : { value: row.debit, ...link },
        isZero(row.credit) ? undefined : { value: row.credit, ...link },
      ],
    });
  }
  const earlier = data.trialBalance.retainedEarnings;
  if (earlier)
    lines.push({
      key: "retained-earnings",
      kind: "calculated",
      label: earlier.label,
      figures: [side(earlier.debit), side(earlier.credit)],
      note: m.views.earningsNote,
    });
  lines.push({
    key: "total",
    kind: "total",
    label: m.table.total,
    figures: [{ value: data.trialBalance.debit }, { value: data.trialBalance.credit }],
  });
  return {
    lines,
    columns: [
      m.columns.currency(m.columns.debit, data.currency),
      m.columns.currency(m.columns.credit, data.currency),
    ],
    hidden: skipped,
  };
}

/** The cash flow: each section with its lines and total, then the net change in cash. */
export function cashFlowLines(data: CashFlowData, hrefs: ReportHrefs, m: Messages): LinesResult {
  const comparing = data.comparison !== null;
  const lines: StatementLine[] = [];
  for (const section of data.sections) {
    lines.push({
      key: `heading-${section.key}`,
      kind: "heading",
      label: m.cashFlow.section[section.key],
    });
    let previousGroup = "";
    for (const entry of section.lines) {
      if (entry.group === "nonCash" && previousGroup !== "nonCash")
        lines.push({ key: "sub-noncash", kind: "subheading", label: m.cashFlow.adjustments });
      if (entry.group === "workingCapital" && previousGroup !== "workingCapital")
        lines.push({ key: "sub-working", kind: "subheading", label: m.cashFlow.workingCapital });
      previousGroup = entry.group;
      const name = entry.code ? `${entry.code} ${entry.label}` : entry.label;
      lines.push({
        key: `${section.key}-${entry.key}`,
        kind: "account",
        label: entry.group === "netIncome" ? m.cashFlow.netIncome : entry.label,
        code: entry.code ?? undefined,
        figures: rowFigures(
          entry,
          comparing,
          entry.accountId
            ? {
                current: hrefs.account(entry.accountId, "range", "current"),
                comparison: comparing
                  ? hrefs.account(entry.accountId, "range", "comparison")
                  : undefined,
              }
            : {},
          { current: m.table.drill(name), comparison: m.table.drill(name) },
        ),
        ...(section.key === "unclassified" ? { flag: m.cashFlow.notClassifiedFlag } : {}),
      });
    }
    if (section.lines.length === 0)
      lines.push({ key: `none-${section.key}`, kind: "subheading", label: m.cashFlow.noActivity });
    lines.push({
      key: `total-${section.key}`,
      kind: "subtotal",
      label: m.cashFlow.sectionTotal[section.key],
      figures: rowFigures(
        { amount: section.total, comparative: section.comparative, change: section.change },
        comparing,
        {},
        {},
      ),
    });
  }
  // The statement ends where a cash flow statement does: what changed, and the cash it started and ended with.
  // That the three agree is the service's to prove (it will not make a statement that does not tie).
  const net = data.totals.find((item) => item.key === "netChange");
  const start = data.totals.find((item) => item.key === "openingCash");
  const end = data.totals.find((item) => item.key === "closingCash");
  lines.push(
    ...totalLine("net-change", "subtotal", net, comparing, { label: m.cashFlow.netChange }),
  );
  lines.push(
    ...totalLine("opening-cash", "account", start, comparing, { label: m.cashFlow.startOfPeriod }),
  );
  lines.push(
    ...totalLine("closing-cash", "total", end, comparing, { label: m.cashFlow.endOfPeriod }),
  );
  return { lines, columns: periodColumns(data, m, false), hidden: 0 };
}

// ---- By month ---------------------------------------------------------------------------------
// A by-month statement is several reads of the service laid side by side: one for each month and, for
// the profit and loss, one for the whole range. Nothing is added up here: every figure on screen is a
// figure the service made for exactly the dates of its column. The columns are read at one book
// revision, and `monthsAddUp` checks that they agree with the total rather than assuming it.

/** One column of a by-month statement: its heading, the report it was read from, and the dates it
 * covers in words (what a link to a figure in it says about where it goes). */
interface MonthlyColumn {
  readonly heading: string;
  readonly data: CoreReportsData;
  readonly span: string;
}

/** The heading of a month's column. A profit and loss column is a stretch of days, so a month the
 * range covers only part of says which days; a balance sheet column is one day, so it is called by
 * the month when the day is the month's last, and by the day when the range ends inside the month. */
function monthHeading(
  column: MonthlyReports<CoreReportsData>["months"][number],
  m: Messages,
  asOf: boolean,
): string {
  if (asOf) return column.endsMonth ? formatMonthShort(column.month) : m.columns.asOf(column.to);
  return column.partial
    ? describeRange({ from: column.from, to: column.to })
    : formatMonthShort(column.month);
}

function monthColumns(
  reports: MonthlyReports<CoreReportsData>,
  m: Messages,
  asOf: boolean,
): MonthlyColumn[] {
  return reports.months.map((column) => ({
    heading: monthHeading(column, m, asOf),
    data: column.data,
    span: asOf ? describeDate(column.to) : describeRange({ from: column.from, to: column.to }),
  }));
}

/** The accounts of several reads in one list: in the order of the first read that has each. A chart
 * that changed between reads (an account opened in March) still lists every account once. */
export function unionRows(lists: readonly (readonly StatementRowData[])[]): StatementRowData[] {
  const seen = new Set<string>();
  const result: StatementRowData[] = [];
  for (const list of lists)
    for (const row of list)
      if (!seen.has(row.accountId)) {
        seen.add(row.accountId);
        result.push(row);
      }
  return result;
}

const byAccount = (rows: readonly StatementRowData[]): Map<string, StatementRowData> =>
  new Map(rows.map((row) => [row.accountId, row]));

function monthlyAccountLine(
  row: StatementRowData,
  columns: readonly MonthlyColumn[],
  maps: readonly Map<string, StatementRowData>[],
  hrefsFor: (data: CoreReportsData) => ReportHrefs,
  m: Messages,
  span: "range" | "fiscalYear",
): StatementLine {
  const name = `${row.code} ${row.name}`;
  return {
    key: row.accountId,
    kind: "account",
    label: row.name,
    code: row.code,
    figures: columns.map((column, index): Figure => {
      const found = maps[index]?.get(row.accountId);
      return {
        value: found?.amount ?? ZERO,
        href: found ? hrefsFor(column.data).account(row.accountId, span, "current") : undefined,
        context: m.table.drillComparative(name, column.span),
      };
    }),
  };
}

/** A total row across the columns, with the service's own label for it. Nothing when no column has it. */
function monthlyTotalLine(
  key: string,
  kind: StatementLine["kind"],
  columns: readonly MonthlyColumn[],
  totalsOf: (data: CoreReportsData) => readonly StatementTotalData[],
  totalKey: string,
  extra: Partial<StatementLine> = {},
): StatementLine[] {
  const found = columns.map((column) =>
    totalsOf(column.data).find((total) => total.key === totalKey),
  );
  const label = found.find((total) => total !== undefined)?.label;
  if (label === undefined) return [];
  return [
    {
      key,
      kind,
      label,
      figures: found.map((total): Figure | undefined =>
        total ? { value: total.amount } : undefined,
      ),
      ...extra,
    },
  ];
}

/** The profit and loss by month: a column for each month and one for the whole range. */
export function profitLossMonthlyLines(
  reports: MonthlyReports<CoreReportsData>,
  hrefsFor: (data: CoreReportsData) => ReportHrefs,
  m: Messages,
  options: { showZero: boolean },
): LinesResult {
  const columns: MonthlyColumn[] = [
    ...monthColumns(reports, m, false),
    {
      heading: m.columns.currency(m.table.total, reports.total.currency),
      data: reports.total,
      span: describeRange({ from: reports.total.periodStart, to: reports.total.asOf }),
    },
  ];
  const rowsOf = (data: CoreReportsData) => data.profitAndLoss.rows;
  const totalsOf = (data: CoreReportsData) => data.profitAndLoss.totals;
  const everyRow = unionRows([reports.total, ...reports.months.map((c) => c.data)].map(rowsOf));
  const maps = columns.map((column) => byAccount(rowsOf(column.data)));
  const quiet = (row: StatementRowData) =>
    maps.every((map) => isZero(map.get(row.accountId)?.amount));
  const lines: StatementLine[] = [];
  let skipped = 0;
  for (const role of ["income", "gain", "unrealizedGain", "expense"] as const) {
    const rows = everyRow.filter((row) => row.role === role);
    if (rows.length === 0 && role !== "income" && role !== "expense") continue;
    lines.push({ key: `heading-${role}`, kind: "heading", label: m.groups[role] });
    const shown = rows.filter((row) => options.showZero || !quiet(row));
    skipped += rows.length - shown.length;
    for (const row of shown)
      lines.push(monthlyAccountLine(row, columns, maps, hrefsFor, m, "range"));
    if (shown.length === 0)
      lines.push({ key: `none-${role}`, kind: "subheading", label: m.cashFlow.noActivity });
    lines.push(...monthlyTotalLine(`total-${role}`, "subtotal", columns, totalsOf, role));
  }
  if (everyRow.some((row) => row.role === "gain" || row.role === "unrealizedGain"))
    lines.push(...monthlyTotalLine("total-revenue", "subtotal", columns, totalsOf, "revenue"));
  lines.push(...monthlyTotalLine("net-income", "total", columns, totalsOf, "netIncome"));
  return { lines, columns: columns.map((column) => column.heading), hidden: skipped };
}

/** The balance sheet by month: the book's position at the end of each month. */
export function balanceSheetMonthlyLines(
  reports: MonthlyReports<CoreReportsData>,
  hrefsFor: (data: CoreReportsData) => ReportHrefs,
  m: Messages,
  options: { showZero: boolean },
): LinesResult {
  const columns = monthColumns(reports, m, true);
  const rowsOf = (data: CoreReportsData) => data.balanceSheet.rows;
  const totalsOf = (data: CoreReportsData) => data.balanceSheet.totals;
  const everyRow = unionRows(reports.months.map((column) => rowsOf(column.data)));
  const maps = columns.map((column) => byAccount(rowsOf(column.data)));
  const quiet = (row: StatementRowData) =>
    maps.every((map) => isZero(map.get(row.accountId)?.amount));
  const lines: StatementLine[] = [];
  let skipped = 0;
  for (const role of ["asset", "liability", "equity"] as const) {
    const rows = everyRow.filter((row) => row.role === role);
    lines.push({ key: `heading-${role}`, kind: "heading", label: m.groups[role] });
    const shown = rows.filter((row) => options.showZero || !quiet(row));
    skipped += rows.length - shown.length;
    for (const row of shown)
      lines.push(monthlyAccountLine(row, columns, maps, hrefsFor, m, "fiscalYear"));
    if (role === "equity") {
      lines.push(
        ...monthlyTotalLine("prior-earnings", "calculated", columns, totalsOf, "priorEarnings", {
          note: m.views.earningsNote,
        }),
        ...monthlyTotalLine("current-earnings", "calculated", columns, totalsOf, "currentEarnings"),
        ...monthlyTotalLine("total-equity", "subtotal", columns, totalsOf, "totalEquity"),
      );
    } else {
      if (shown.length === 0)
        lines.push({ key: `none-${role}`, kind: "subheading", label: m.cashFlow.noActivity });
      lines.push(...monthlyTotalLine(`total-${role}`, "subtotal", columns, totalsOf, role));
    }
  }
  lines.push(
    ...monthlyTotalLine(
      "liabilities-and-equity",
      "total",
      columns,
      totalsOf,
      "liabilitiesAndEquity",
    ),
  );
  return { lines, columns: columns.map((column) => column.heading), hidden: skipped };
}

/** Whether the months add up to the total, to the cent, for the figures that must: income, gains,
 * expenses and net income. They always do when every column was read at one book revision; the screen
 * checks, because a statement that does not agree with itself must say so and not be relied on. The
 * result is the key of the first total that does not add up, or null when everything does. */
export function monthsAddUp(reports: MonthlyReports<CoreReportsData>): string | null {
  for (const key of ["income", "gain", "expense", "netIncome"] as const) {
    const total = reports.total.profitAndLoss.totals.find((item) => item.key === key);
    if (!total) continue;
    const sum = reports.months.reduce((all, column) => {
      const part = column.data.profitAndLoss.totals.find((item) => item.key === key);
      return all + (part ? moneyToCents(part.amount) : 0n);
    }, 0n);
    if (sum !== moneyToCents(total.amount)) return key;
  }
  return null;
}

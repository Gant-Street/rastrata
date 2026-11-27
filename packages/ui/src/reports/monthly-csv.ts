import type { CoreReportsData, MonthlyReports, StatementRowData } from "./data";
import { unionRows } from "./view-model";

/** A report by month as a CSV file for a spreadsheet or an accountant: the same figures as the screen,
 * a column for each month, headed by the facts that identify it (the book revision every column was
 * read at, the fingerprint of the whole range, and the dates and fingerprint of each column). The
 * service writes the CSV of a single period; this is the same file for the months laid side by side, and
 * it follows the service's rules for a spreadsheet:
 *
 * - An account name, a book name and every other text cell is attacker-controlled text, and a
 *   spreadsheet runs a cell that begins `=`, `+`, `-` or `@` as a formula, so a text cell that does is
 *   given a single quote in front, which a spreadsheet shows as nothing and treats as text.
 * - A money cell is never text: it is checked to be a plain decimal with two places and written as it
 *   is, so a negative figure stays a number.
 * - Lines end with CRLF, and a cell with a comma, a quote or a line break is quoted.
 *
 * Every account is in the file, whether or not the screen shows the ones with no activity: a file is
 * the whole report, not a view of it. Pure and exact: amounts are the wire strings the service made. */

const FORMULA_START = /^[=+\-@\t\r\n]/;
const MONEY = /^-?(?:0|[1-9]\d*)\.\d{2}$/;

const neutralize = (value: string): string => (FORMULA_START.test(value) ? `'${value}` : value);
const quote = (value: string): string =>
  /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
const text = (value: string): string => quote(neutralize(value));

function amount(value: string): string {
  if (!MONEY.test(value)) throw new TypeError("A money cell must be a decimal with two places");
  return value;
}

const render = (rows: readonly (readonly string[])[]): string =>
  `${rows.map((row) => row.join(",")).join("\r\n")}\r\n`;

export interface MonthlyCsv {
  readonly filename: string;
  readonly mediaType: string;
  readonly content: string;
}

type Statement = "profit-loss" | "balance-sheet";

const TITLE: Readonly<Record<Statement, string>> = {
  "profit-loss": "Profit and loss by month",
  "balance-sheet": "Balance sheet by month",
};

/** One column of the file: what to call it, the dates it covers and the report it was read from. */
interface Column {
  readonly label: string;
  readonly from: string;
  readonly to: string;
  readonly data: CoreReportsData;
}

const rowsOf = (statement: Statement, data: CoreReportsData): readonly StatementRowData[] =>
  statement === "profit-loss" ? data.profitAndLoss.rows : data.balanceSheet.rows;
const totalsOf = (statement: Statement, data: CoreReportsData) =>
  statement === "profit-loss" ? data.profitAndLoss.totals : data.balanceSheet.totals;

export function monthlyCsv(input: {
  statement: Statement;
  bookName: string;
  reports: MonthlyReports<CoreReportsData>;
}): MonthlyCsv {
  const { statement, reports } = input;
  const total = reports.total;
  // A profit and loss has a column for the whole range after the months; a balance sheet is a position
  // on the last day of each month and has none.
  const columns: Column[] = [
    ...reports.months.map((month) => ({
      label: month.month,
      from: month.from,
      to: month.to,
      data: month.data,
    })),
    ...(statement === "profit-loss"
      ? [{ label: "Total", from: total.periodStart, to: total.asOf, data: total }]
      : []),
  ];
  const everyRow = unionRows(columns.map((column) => rowsOf(statement, column.data)));
  const maps = columns.map(
    (column) => new Map(rowsOf(statement, column.data).map((row) => [row.accountId, row])),
  );
  const figures = (accountId: string): string[] =>
    maps.map((map) => amount(map.get(accountId)?.amount ?? "0.00"));
  const roleOrder = (role: string): number => {
    const order =
      statement === "profit-loss"
        ? ["income", "gain", "unrealizedGain", "expense"]
        : ["asset", "liability", "equity"];
    const at = order.indexOf(role);
    return at < 0 ? order.length : at;
  };
  const accountRows = [...everyRow]
    .sort((left, right) => roleOrder(left.role) - roleOrder(right.role))
    .map((row) => [
      text(row.accountId),
      text(row.code),
      text(row.name),
      text(row.role),
      ...figures(row.accountId),
    ]);
  // The totals, with the service's own labels, in the order the service lists them.
  const totalKeys = [
    ...new Set(columns.flatMap((c) => totalsOf(statement, c.data).map((t) => t.key))),
  ];
  const totalRows = totalKeys.map((key) => {
    const found = columns.map((column) =>
      totalsOf(statement, column.data).find((t) => t.key === key),
    );
    const label = found.find((entry) => entry !== undefined)?.label ?? key;
    return ["", "", text(label), "", ...found.map((entry) => amount(entry?.amount ?? "0.00"))];
  });
  const rows: string[][] = [
    [text("Report"), text(TITLE[statement])],
    [text("Book"), text(input.bookName)],
    [text("Currency"), text(total.currency)],
    [text("Basis"), text(total.basis)],
    [text("Period start"), text(total.periodStart)],
    [text("Period end"), text(total.asOf)],
    [text("Book revision"), text(total.bookRevision)],
    [text("Population hash"), text(total.populationHash)],
    [],
    ["Column", "From", "To", "Population hash"].map(text),
    ...columns.map((column) => [
      text(column.label),
      text(column.from),
      text(column.to),
      text(column.data.populationHash),
    ]),
    [],
    ["Account ID", "Code", "Account", "Type", ...columns.map((column) => column.label)].map(text),
    ...accountRows,
    [],
    ...totalRows,
  ];
  // A file is data: its cells and its name keep the dates in the form the service sent them.
  const { periodStart, asOf } = total;
  return {
    filename: `${statement}-by-month-${periodStart}-to-${asOf}.csv`,
    mediaType: "text/csv; charset=utf-8",
    content: render(rows),
  };
}

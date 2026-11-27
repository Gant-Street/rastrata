import type {
  BalanceSheet,
  CashFlow,
  GeneralLedgerAccount,
  GeneralLedgerLine,
  ProfitLoss,
  ReportWarning,
  StatementRow,
  StatementTotal,
  TrialBalance,
} from "../client-contracts.gen.ts";
import { isMoney } from "../money.ts";
import { COMPARISON_SHARE_UNAVAILABLE, SHARE_UNAVAILABLE } from "./statements.ts";

/** CSV for spreadsheets and accountants. Bank memos, merchant names, account names and book names are
 * attacker-controlled text, and a spreadsheet runs a cell that begins `=`, `+`, `-` or `@` as a
 * formula. Every text cell is therefore neutralised (a single quote is put in front of it, which a
 * spreadsheet shows as nothing and treats as text); a money cell is never text, it is validated to be
 * a plain decimal and written as is, so negative figures stay numbers. Pure and portable. */

/** First characters that make a spreadsheet read a cell as a formula or a command (OWASP CSV
 * injection): `=`, `+`, `-`, `@`, tab, carriage return, and line feed. */
const FORMULA_START = /^[=+\-@\t\r\n]/;

/** Make a text cell safe to open in a spreadsheet. */
export const neutralize = (value: string): string =>
  FORMULA_START.test(value) ? `'${value}` : value;

/** Quote a cell the way RFC 4180 asks: when it holds a comma, a quote or a line break. */
const quote = (value: string): string =>
  /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

/** A text cell: neutralised, then quoted if it needs it. */
export const text = (value: string): string => quote(neutralize(value));

/** A money cell. Only a well-formed decimal string is accepted, so a figure that is not money cannot
 * be smuggled into a column the spreadsheet will read as a number. */
export function amount(value: string): string {
  if (!isMoney(value)) throw new TypeError("A money cell must be a decimal with two places");
  return value;
}

/** A share cell: a percentage with one decimal ("30.2", "-29.4"), written as is so a spreadsheet reads a
 * number, or an empty cell where the line has none (its period had no income). Anything else is
 * refused, as a money cell is, so only a share can sit in a column of shares. */
export function share(value: string | undefined): string {
  if (value === undefined) return "";
  if (!/^-?(0|[1-9][0-9]*)\.[0-9]$/.test(value))
    throw new TypeError("A share cell must be a percentage with one decimal");
  return value;
}

const line = (cells: readonly string[]): string => cells.join(",");

/** Rows of already-rendered cells, joined with CRLF and ended with one. */
export const render = (rows: readonly (readonly string[])[]): string =>
  `${rows.map(line).join("\r\n")}\r\n`;

/** What every export states about itself: the same facts the JSON statement carries, so a file can be
 * traced to the book revision and population it came from. */
export interface ExportHeader {
  readonly title: string;
  readonly book: string;
  readonly currency: string;
  readonly basis: string;
  readonly asOf: string;
  readonly periodStart?: string;
  readonly bookRevision: string;
  readonly populationHash: string;
  readonly compilerVersion: string;
  readonly extra?: readonly (readonly [string, string])[];
}

function header(h: ExportHeader): string[][] {
  const rows: string[][] = [
    [text("Report"), text(h.title)],
    [text("Book"), text(h.book)],
    [text("Currency"), text(h.currency)],
    [text("Basis"), text(h.basis)],
  ];
  if (h.periodStart) rows.push([text("Period start"), text(h.periodStart)]);
  rows.push(
    [text(h.periodStart ? "Period end" : "As of"), text(h.asOf)],
    [text("Book revision"), text(h.bookRevision)],
    [text("Population hash"), text(h.populationHash)],
    [text("Compiler version"), text(h.compilerVersion)],
  );
  for (const [key, value] of h.extra ?? []) rows.push([text(key), text(value)]);
  rows.push([]);
  return rows;
}

const comparing = (rows: readonly { comparative?: string }[]): boolean =>
  rows.some((item) => item.comparative !== undefined);

/** The columns after the account's: its amount, and with shares its share of income; with a comparison
 * the comparison's amount, with shares its share, and the change. Each share sits beside its amount. */
function columns(base: readonly string[], withComparison: boolean, withShare = false): string[] {
  return [
    ...base,
    ...(withShare ? ["% of income"] : []),
    ...(withComparison
      ? ["Comparative", ...(withShare ? ["Comparative % of income"] : []), "Change"]
      : []),
  ].map(text);
}

function figures(
  item: {
    amount: string;
    comparative?: string;
    change?: string;
    share?: string;
    comparativeShare?: string;
  },
  withComparison: boolean,
  withShare = false,
): string[] {
  return [
    amount(item.amount),
    ...(withShare ? [share(item.share)] : []),
    ...(withComparison
      ? [
          amount(item.comparative ?? "0.00"),
          ...(withShare ? [share(item.comparativeShare)] : []),
          amount(item.change ?? item.amount),
        ]
      : []),
  ];
}

function accountRow(entry: StatementRow, withComparison: boolean, withShare: boolean): string[] {
  return [
    text(entry.accountId),
    text(entry.code),
    text(entry.name),
    text(entry.role),
    ...figures(entry, withComparison, withShare),
  ];
}

function totalRow(entry: StatementTotal, withComparison: boolean, withShare: boolean): string[] {
  return ["", "", text(entry.label), "", ...figures(entry, withComparison, withShare)];
}

function statementCsv(
  h: ExportHeader,
  rows: readonly StatementRow[],
  totals: readonly StatementTotal[],
  withShare = false,
  notes: readonly ReportWarning[] = [],
): string {
  const withComparison = comparing(rows) || comparing(totals);
  return render([
    ...header(h),
    columns(["Account ID", "Code", "Account", "Type", "Amount"], withComparison, withShare),
    ...rows.map((entry) => accountRow(entry, withComparison, withShare)),
    [],
    ...totals.map((entry) => totalRow(entry, withComparison, withShare)),
    ...(notes.length > 0
      ? [[], ...notes.map((note) => [text("Warning"), text(note.message)])]
      : []),
  ]);
}

export function trialBalanceCsv(h: ExportHeader, statement: TrialBalance): string {
  const rows: string[][] = [
    columns(["Account ID", "Code", "Account", "Type", "Balance", "Debit", "Credit"], false),
    ...statement.rows.map((entry) => [
      text(entry.accountId),
      text(entry.code),
      text(entry.name),
      text(entry.role),
      amount(entry.signedBalance),
      amount(entry.debit),
      amount(entry.credit),
    ]),
  ];
  const earlier = statement.retainedEarnings;
  if (earlier)
    rows.push([
      "",
      "",
      text(earlier.label),
      "",
      amount(earlier.signedBalance),
      amount(earlier.debit),
      amount(earlier.credit),
    ]);
  rows.push([], ["", "", text("Total"), "", "", amount(statement.debit), amount(statement.credit)]);
  return render([
    ...header({
      ...h,
      extra: [["Fiscal year start", statement.fiscalYearStart], ...(h.extra ?? [])],
    }),
    ...rows,
  ]);
}

/** The profit and loss as a file. With `share` the share columns are there whatever the figures are,
 * so a file asked for shares always has the same columns; a line whose period had no income has an
 * empty cell, and the report's warnings about shares are written under the table to say why. */
export function profitLossCsv(
  h: ExportHeader,
  statement: ProfitLoss,
  options: { share?: boolean; warnings?: readonly ReportWarning[] } = {},
): string {
  const withShare = options.share === true;
  const notes = withShare
    ? (options.warnings ?? []).filter(
        (warning) =>
          warning.code === SHARE_UNAVAILABLE || warning.code === COMPARISON_SHARE_UNAVAILABLE,
      )
    : [];
  return statementCsv(h, statement.rows, statement.totals, withShare, notes);
}

export function balanceSheetCsv(h: ExportHeader, statement: BalanceSheet): string {
  const totals = [
    ...statement.totals,
    {
      key: "difference",
      label: "Difference (assets less liabilities and equity)",
      amount: statement.difference,
    },
  ];
  return statementCsv(h, statement.rows, totals);
}

export function cashFlowCsv(h: ExportHeader, statement: CashFlow): string {
  const head = header({
    ...h,
    extra: [
      ["Tag map hash", statement.tagMapHash],
      ["Tags revision", statement.tagsRevision],
      ["Ledger population hash", statement.ledgerPopulationHash],
      ...(h.extra ?? []),
    ],
  });
  const warnings = statement.warnings.map((item) => [text("Warning"), text(item.message)]);
  if (!statement.available)
    return render([...head, [text("Not available"), text(statement.reason ?? "")], ...warnings]);
  const withComparison =
    statement.comparison !== null ||
    comparing(statement.sections) ||
    comparing(statement.sections.flatMap((item) => item.lines)) ||
    comparing(statement.totals);
  const rows: string[][] = [
    columns(["Section", "Kind", "Code", "Account", "Amount"], withComparison),
  ];
  for (const item of statement.sections) {
    for (const entry of item.lines)
      rows.push([
        text(item.label),
        text(entry.group),
        text(entry.code ?? ""),
        text(entry.label),
        ...figures(entry, withComparison),
      ]);
    rows.push([
      text(item.label),
      text("total"),
      "",
      text(`Net cash from ${item.label.toLowerCase()}`),
      ...figures(
        {
          amount: item.total,
          ...(item.comparative !== undefined ? { comparative: item.comparative } : {}),
          ...(item.change !== undefined ? { change: item.change } : {}),
        },
        withComparison,
      ),
    ]);
  }
  rows.push([]);
  for (const entry of statement.totals)
    rows.push([text("Total"), "", "", text(entry.label), ...figures(entry, withComparison)]);
  rows.push(
    [],
    [text("Cash accounts")],
    columns(["Code", "Account", "Opening", "Closing", "Change"], false),
  );
  for (const entry of statement.cashAccounts)
    rows.push([
      text(entry.code),
      text(entry.name),
      amount(entry.opening),
      amount(entry.closing),
      amount(entry.change),
    ]);
  if (warnings.length > 0) rows.push([], ...warnings);
  return render([...head, ...rows]);
}

export function generalLedgerCsv(
  h: ExportHeader,
  accounts: readonly GeneralLedgerAccount[],
  lines: readonly GeneralLedgerLine[],
): string {
  const rows: string[][] = [
    columns(
      ["Row", "Code", "Account", "Date", "Journal ID", "Description", "Debit", "Credit", "Balance"],
      false,
    ),
  ];
  const byAccount = new Map<string, GeneralLedgerLine[]>();
  for (const entry of lines) {
    const list = byAccount.get(entry.accountId);
    if (list) list.push(entry);
    else byAccount.set(entry.accountId, [entry]);
  }
  for (const account of accounts) {
    const head = [text(account.code), text(account.name)];
    rows.push([
      text("opening"),
      ...head,
      text(h.periodStart ?? ""),
      "",
      text("Opening balance"),
      "",
      "",
      amount(account.openingBalance),
    ]);
    for (const entry of byAccount.get(account.accountId) ?? [])
      rows.push([
        text("line"),
        ...head,
        text(entry.date),
        text(entry.journalId),
        text(entry.narration),
        amount(entry.debit),
        amount(entry.credit),
        amount(entry.runningBalance),
      ]);
    rows.push([
      text("closing"),
      ...head,
      text(h.asOf),
      "",
      text("Closing balance"),
      "",
      "",
      amount(account.closingBalance),
    ]);
  }
  return render([...header(h), ...rows]);
}

/** Reading a Xero Trial Balance export.
 *
 * Xero's Trial Balance report (Accounting, Reports, Trial Balance, Export) lists the accounts down
 * the page and, across, a Debit and a Credit column for the period of the report and a Debit and a
 * Credit column for the year to date ("YTD Debit", "YTD Credit"). The year-to-date pair is the trial
 * balance as at the report date: for a balance sheet account it is the whole balance, for an income or
 * expense account it is the amount since the start of the financial year. The export starts with title
 * lines (the report name, the organisation, "As at <date>"), may group the accounts under section
 * titles, and ends with a Total row.
 *
 * Because the layout is read from the page and not documented as a file format, this reader asks the
 * file what it is: it finds the header, reads each column by its name (an account may be one cell,
 * "Sales (200)", or a Code cell and a name cell), takes the date from the title lines, and checks
 * what it read: each pair of columns must balance to the cent, and must agree with the file's own
 * Total row. A file it cannot read, or that does not balance, says why on its row.
 *
 * Amounts are exact cents. An account's balance is the debit less the credit; which sign is "normal"
 * depends on the account's role in the book, which is decided where the mapping is. */
import { formatMoney } from "../../money.ts";
import type { DateOrder } from "../../statements/dates.ts";
import {
  type XeroIssue,
  Issues,
  amountOf,
  clean,
  datesIn,
  isBlank,
  isLabelOnly,
  norm,
  quoted,
  readTable,
  titleLines,
} from "./report.ts";

export interface TrialBalanceRow {
  readonly row: number;
  readonly section: string | null;
  /** The account's code when the file gives one, as text. */
  readonly code: string | null;
  readonly name: string;
  /** The Account Type column, when there is one. */
  readonly type: string | null;
  /** Debit and credit for the period of the report, in cents. Zero when the file has no such column. */
  readonly debit: bigint;
  readonly credit: bigint;
  /** Debit and credit year to date: the trial balance as at the report date. */
  readonly ytdDebit: bigint;
  readonly ytdCredit: bigint;
}

export type TrialBalanceLayout = "period_and_ytd" | "ytd" | "period" | "single_balance";

export interface TrialBalanceTotals {
  readonly debit: bigint;
  readonly credit: bigint;
  readonly ytdDebit: bigint;
  readonly ytdCredit: bigint;
}

export interface TrialBalance {
  readonly organisation: string | null;
  /** The date the report says it is as at, `YYYY-MM-DD`, or null when no title line says. */
  readonly asOf: string | null;
  readonly layout: TrialBalanceLayout | null;
  readonly rows: readonly TrialBalanceRow[];
  /** The Total row of the file, when there is one. */
  readonly fileTotals: TrialBalanceTotals | null;
  /** The totals of the rows read, which is what the checks use. */
  readonly sums: TrialBalanceTotals;
  /** Debits equal credits on every pair of columns the file has. */
  readonly balanced: boolean;
  readonly issues: readonly XeroIssue[];
  /** The columns found, by what they mean, for showing how the file was read. */
  readonly columns: Readonly<Record<string, string>>;
}

type Column =
  | "code"
  | "account"
  | "type"
  | "debit"
  | "credit"
  | "ytdDebit"
  | "ytdCredit"
  | "balance"
  | "ytdBalance";

const AMOUNTS: readonly Column[] = [
  "debit",
  "credit",
  "ytdDebit",
  "ytdCredit",
  "balance",
  "ytdBalance",
];

/** What a header cell means. A pair of amount columns is the period's unless the header says "YTD"
 * or "year to date". */
function classify(cell: string): Column | null {
  const key = norm(cell);
  if (key === "") return null;
  const parts = key.split(/[^a-z]+/).filter(Boolean);
  const has = (word: string) => parts.includes(word);
  const ytd = has("ytd") || key.includes("year to date") || key.includes("year-to-date");
  if (["account code", "code", "account no", "account number", "acct code"].includes(key))
    return "code";
  if (["account", "account name", "name", "accounts"].includes(key)) return "account";
  if (["account type", "type"].includes(key)) return "type";
  if (has("debit") || has("debits") || key === "dr") return ytd ? "ytdDebit" : "debit";
  if (has("credit") || has("credits") || key === "cr") return ytd ? "ytdCredit" : "credit";
  if (has("balance") || key === "net") return ytd ? "ytdBalance" : "balance";
  return null;
}

/** The second Debit, Credit or Balance column with no "YTD" in its header is the year-to-date one,
 * as in a report that writes "Debit, Credit, Debit, Credit" under two group headings. */
const SECOND: Readonly<Partial<Record<Column, Column>>> = {
  debit: "ytdDebit",
  credit: "ytdCredit",
  balance: "ytdBalance",
};

function readHeader(fields: readonly string[]): Map<Column, number> | null {
  const found = new Map<Column, number>();
  fields.forEach((cell, index) => {
    const column = classify(cell);
    if (column === null) return;
    if (found.has(column)) {
      const later = SECOND[column];
      if (later && !found.has(later)) found.set(later, index);
      return;
    }
    found.set(column, index);
  });
  // A lone Balance column is the balance as at the report date: the year-to-date pair.
  const balance = found.get("balance");
  if (
    balance !== undefined &&
    !["ytdBalance", "debit", "credit", "ytdDebit", "ytdCredit"].some((column) =>
      found.has(column as Column),
    )
  ) {
    found.delete("balance");
    found.set("ytdBalance", balance);
  }
  const amounts = AMOUNTS.filter((column) => found.has(column)).length;
  // The first header cell is sometimes empty: the account names have no heading of their own.
  if (
    !found.has("account") &&
    !found.has("code") &&
    amounts >= 2 &&
    (fields[0] ?? "").trim() === ""
  )
    found.set("account", 0);
  const named = found.has("account") || found.has("code");
  const single = found.has("ytdBalance") || found.has("balance");
  return named && (amounts >= 2 || (amounts === 1 && single)) ? found : null;
}

/** Codes in a chart are short and have a digit; anything else in brackets is part of the name. */
const CODE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,9}$/;
const looksLikeCode = (text: string): boolean => CODE.test(text) && /\d/.test(text);

/** Split "Sales (200)", "200 - Sales" or "Sales" into its code and name. */
export function splitAccount(label: string): { code: string | null; name: string } {
  const text = clean(label, 300);
  const trailing = /^(.*\S)\s*\(([^()]{1,10})\)$/.exec(text);
  if (trailing && looksLikeCode((trailing[2] ?? "").trim()))
    return { code: (trailing[2] ?? "").trim(), name: (trailing[1] ?? "").trim() };
  const leading = /^([A-Za-z0-9][A-Za-z0-9._/-]{0,9})\s*[-–:]\s*(\S.*)$/.exec(text);
  if (leading && looksLikeCode(leading[1] ?? ""))
    return { code: leading[1] ?? null, name: (leading[2] ?? "").trim() };
  return { code: null, name: text };
}

/** A trial balance has a row for each account with a balance; a chart is at most about 1000. */
export const MAX_TB_ROWS = 1200;

export interface TrialBalanceOptions {
  readonly decimal?: "." | ",";
  /** How a numeric date in a title line reads. Month names need no order. */
  readonly dateOrder?: DateOrder;
}

const ZERO: TrialBalanceTotals = { debit: 0n, credit: 0n, ytdDebit: 0n, ytdCredit: 0n };

export function parseXeroTrialBalance(
  text: string,
  options: TrialBalanceOptions = {},
): TrialBalance {
  const issues = new Issues();
  const { records } = readTable(text, issues);
  const decimal = options.decimal ?? ".";
  const order = options.dateOrder ?? "dmy";
  const nothing = (): TrialBalance => ({
    organisation: null,
    asOf: null,
    layout: null,
    rows: [],
    fileTotals: null,
    sums: ZERO,
    balanced: false,
    issues: issues.done(),
    columns: {},
  });

  // The header: within the first 40 records, the first that names an account and has amount columns.
  let headerAt = -1;
  let columns = new Map<Column, number>();
  for (let at = 0; at < Math.min(records.length, 40); at++) {
    const found = readHeader(records[at]?.fields ?? []);
    if (found) {
      headerAt = at;
      columns = found;
      break;
    }
  }
  if (headerAt === -1) {
    issues.add({
      severity: "error",
      code: "no_header",
      message:
        "No header row was found in the first 40 rows. A Xero Trial Balance export has the columns Account, Debit, Credit, YTD Debit and YTD Credit under a few title lines.",
    });
    return nothing();
  }

  // The title lines: the organisation, and the date the report is as at.
  const lines = titleLines(records, headerAt);
  const asAtLine = lines.find((line) => /\bas\s+(at|of)\b/i.test(line));
  const dated = asAtLine ?? lines.find((line) => datesIn(line, order).length > 0) ?? null;
  const dates = dated ? datesIn(dated, order) : [];
  const asOf = dates.length > 0 ? (dates[dates.length - 1] ?? null) : null;
  const organisation =
    lines.find((line) => line !== dated && !norm(line).startsWith("trial balance")) ?? null;
  if (!lines.some((line) => norm(line).startsWith("trial balance")))
    issues.add({
      severity: "info",
      code: "no_title",
      message: "The file does not say it is a Trial Balance report. It was read as one.",
    });
  if (asOf === null)
    issues.add({
      severity: "warning",
      code: "no_date",
      message:
        "No title line says what date the report is as at. Give the date the trial balance is as at.",
    });

  const has = (column: Column) => columns.has(column);
  const layout: TrialBalanceLayout =
    has("balance") || has("ytdBalance")
      ? "single_balance"
      : (has("ytdDebit") || has("ytdCredit")) && (has("debit") || has("credit"))
        ? "period_and_ytd"
        : has("ytdDebit") || has("ytdCredit")
          ? "ytd"
          : "period";
  const cell = (fields: readonly string[], column: Column): string => {
    const index = columns.get(column);
    return index === undefined ? "" : (fields[index] ?? "");
  };
  const signed = (value: bigint | undefined): [bigint, bigint] => {
    const cents = value ?? 0n;
    return cents >= 0n ? [cents, 0n] : [0n, -cents];
  };

  const rows: TrialBalanceRow[] = [];
  let fileTotals: TrialBalanceTotals | null = null;
  let section: string | null = null;
  let debit = 0n;
  let credit = 0n;
  let ytdDebit = 0n;
  let ytdCredit = 0n;

  for (const record of records.slice(headerAt + 1)) {
    if (isBlank(record)) continue;
    const fields = record.fields;
    const label = (cell(fields, "account") || cell(fields, "code")).trim();
    const lowered = norm(label);

    // The amounts of the row, as cents; a cell that is not an amount spoils the row.
    const read = new Map<Column, bigint>();
    let spoiled = false;
    for (const column of AMOUNTS) {
      if (!has(column)) continue;
      const raw = cell(fields, column);
      const amount = amountOf(raw, decimal);
      if (amount.kind === "ok") read.set(column, amount.cents);
      else if (amount.kind === "bad") {
        spoiled = true;
        issues.add({
          severity: "error",
          code: "amount_unreadable",
          message: `Row ${record.number}: the ${column.replace(/([A-Z])/g, " $1").toLowerCase()} ${quoted(raw)} is not an amount (${amount.why}), so the row was left out.`,
          row: record.number,
        });
      }
    }
    const [periodDebit, periodCredit] = has("balance")
      ? signed(read.get("balance"))
      : [read.get("debit") ?? 0n, read.get("credit") ?? 0n];
    const [yearDebit, yearCredit] = has("ytdBalance")
      ? signed(read.get("ytdBalance"))
      : [read.get("ytdDebit") ?? 0n, read.get("ytdCredit") ?? 0n];

    if (lowered === "total" || lowered === "totals" || lowered === "grand total") {
      if (!spoiled)
        fileTotals = {
          debit: periodDebit,
          credit: periodCredit,
          ytdDebit: yearDebit,
          ytdCredit: yearCredit,
        };
      continue;
    }
    // A subtotal ("Total Revenue") is not an account and is not added again.
    if (lowered.startsWith("total ")) continue;
    if (spoiled) continue;
    if (read.size === 0) {
      // A title with no amounts is a section: Revenue, Expenses, Assets.
      if (label !== "" && isLabelOnly(record)) section = clean(label, 80);
      continue;
    }
    if (label === "") {
      issues.add({
        severity: "warning",
        code: "amount_without_account",
        message: `Row ${record.number} has amounts and no account, so it was left out.`,
        row: record.number,
      });
      continue;
    }

    if (rows.length >= MAX_TB_ROWS) {
      issues.add({
        severity: "error",
        code: "too_many_accounts",
        message: `The file has more than ${MAX_TB_ROWS} accounts with balances, which is more than a Xero chart holds.`,
      });
      break;
    }
    const split = has("code")
      ? { code: clean(cell(fields, "code"), 40) || null, name: clean(cell(fields, "account"), 300) }
      : splitAccount(label);
    const name = split.name || split.code || "";
    if (name === "") continue;
    const typeText = has("type") ? clean(cell(fields, "type"), 60) : "";
    rows.push({
      row: record.number,
      section,
      code: split.code,
      name,
      type: typeText === "" ? null : typeText,
      debit: periodDebit,
      credit: periodCredit,
      ytdDebit: yearDebit,
      ytdCredit: yearCredit,
    });
    debit += periodDebit;
    credit += periodCredit;
    ytdDebit += yearDebit;
    ytdCredit += yearCredit;
  }
  const sums: TrialBalanceTotals = { debit, credit, ytdDebit, ytdCredit };

  if (rows.length === 0)
    issues.add({
      severity: "error",
      code: "no_accounts",
      message: "The file has a header and no accounts with amounts under it.",
    });

  const hasPeriod = has("debit") || has("credit") || has("balance");
  const hasYear = has("ytdDebit") || has("ytdCredit") || has("ytdBalance");
  let balanced = rows.length > 0;
  for (const [present, name, left, right] of [
    [hasPeriod, "period", debit, credit],
    [hasYear, "year to date", ytdDebit, ytdCredit],
  ] as const) {
    if (!present || rows.length === 0 || left === right) continue;
    balanced = false;
    issues.add({
      severity: "error",
      code: "unbalanced",
      message: `The ${name} columns do not balance: debits ${formatMoney(left)}, credits ${formatMoney(right)}, a difference of ${formatMoney(left - right)}. A trial balance always balances, so rows are missing or were left out.`,
    });
  }
  if (fileTotals) {
    const agrees =
      (!hasPeriod || (fileTotals.debit === debit && fileTotals.credit === credit)) &&
      (!hasYear || (fileTotals.ytdDebit === ytdDebit && fileTotals.ytdCredit === ytdCredit));
    if (!agrees) {
      balanced = false;
      issues.add({
        severity: "error",
        code: "total_differs",
        message: `The Total row of the file is not the sum of the accounts read (debits ${formatMoney(hasYear ? ytdDebit : debit)}, credits ${formatMoney(hasYear ? ytdCredit : credit)} read; the file says ${formatMoney(hasYear ? fileTotals.ytdDebit : fileTotals.debit)} and ${formatMoney(hasYear ? fileTotals.ytdCredit : fileTotals.credit)}), so rows are missing or were left out.`,
      });
    }
  } else if (rows.length > 0)
    issues.add({
      severity: "info",
      code: "no_total_row",
      message: "The file has no Total row, so the columns were checked against each other only.",
    });

  const named: Record<string, string> = {};
  for (const [column, index] of columns)
    named[column] = clean(records[headerAt]?.fields[index], 60);
  return {
    organisation,
    asOf,
    layout,
    rows,
    fileTotals,
    sums,
    balanced,
    issues: issues.done(),
    columns: named,
  };
}

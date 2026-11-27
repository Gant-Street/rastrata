/** Reading a Xero Account Transactions export.
 *
 * Xero's Account Transactions report lists, account by account, every transaction in a date range.
 * As observed in an export, it starts with title lines ("Account Transactions", the organisation, "For
 * the period 1 July 2025 to 30 June 2026"), then one header row, `Date, Source, Description,
 * Reference, Debit, Credit, Running Balance, Gross` and a tax column (named for the edition: GST,
 * Tax, Sales Tax), then a block for each account: a row with the account's name (and code), an
 * "Opening Balance" row, one row for each transaction with a date, a "Total <account>" row with the
 * debits and credits of the block, and a "Closing Balance" row.
 *
 * Two things in the report are not to be trusted, and are not used. The Running Balance is debits
 * less credits shown the other way round (a debit balance is bracketed), and Xero has said it will not
 * change it; so it is read past and ignored, and every figure here comes from the Debit and Credit
 * columns. The Gross and tax columns are another view of the same amounts.
 *
 * What a block's rows add up to must be what its Total row says, to the cent; a block that does not
 * add up is reported, because a row was lost on the way out of Xero or on the way in here. */
import { formatMoney } from "../../money.ts";
import {
  type DateOrder,
  analyzeDateOrder,
  formatDate,
  isDateLike,
  parseDate,
} from "../../statements/dates.ts";
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
import { splitAccount } from "./trial-balance.ts";

export interface TransactionLine {
  readonly row: number;
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly source: string;
  readonly description: string;
  readonly reference: string;
  /** Cents. A line is a debit or a credit: the other is zero. */
  readonly debit: bigint;
  readonly credit: bigint;
}

export interface TransactionBlock {
  /** The account's heading as the block wrote it, cleaned. */
  readonly heading: string;
  readonly code: string | null;
  readonly name: string;
  readonly row: number;
  readonly lines: readonly TransactionLine[];
  readonly debit: bigint;
  readonly credit: bigint;
  /** The block's Total row, when it has one. */
  readonly fileDebit: bigint | null;
  readonly fileCredit: bigint | null;
}

export interface Transactions {
  readonly organisation: string | null;
  readonly periodFrom: string | null;
  readonly periodTo: string | null;
  readonly blocks: readonly TransactionBlock[];
  readonly lineCount: number;
  readonly issues: readonly XeroIssue[];
  readonly columns: Readonly<Record<string, string>>;
}

type Column = "date" | "source" | "description" | "reference" | "debit" | "credit";

const NAMES: Readonly<Record<Column, readonly string[]>> = {
  date: ["date", "transaction date"],
  source: ["source", "type"],
  description: ["description", "details", "narration"],
  reference: ["reference", "ref", "reference number"],
  debit: ["debit", "debits", "dr"],
  credit: ["credit", "credits", "cr"],
};

function columnOf(cell: string): Column | null {
  const key = norm(cell);
  for (const column of Object.keys(NAMES) as Column[])
    if (NAMES[column].includes(key)) return column;
  return null;
}

/** Rows of a block that are not transactions. */
/** The most accounts one report may have: a chart is at most about 1000, and a month rarely uses 400. */
export const MAX_BLOCKS = 400;

const LABEL = /^(opening balance|closing balance|net movement|total|totals)\b/;

export interface TransactionsOptions {
  readonly decimal?: "." | ",";
  /** How a numeric date reads: the report writes dates as the organisation's region does. */
  readonly dateOrder?: DateOrder;
}

interface Open {
  heading: string;
  code: string | null;
  name: string;
  row: number;
  lines: TransactionLine[];
  debit: bigint;
  credit: bigint;
  fileDebit: bigint | null;
  fileCredit: bigint | null;
}

export function parseXeroTransactions(
  text: string,
  options: TransactionsOptions = {},
): Transactions {
  const issues = new Issues();
  const { records } = readTable(text, issues);
  const decimal = options.decimal ?? ".";

  let headerAt = -1;
  let columns = new Map<Column, number>();
  for (let at = 0; at < Math.min(records.length, 40); at++) {
    const found = new Map<Column, number>();
    (records[at]?.fields ?? []).forEach((cell, index) => {
      const column = columnOf(cell);
      if (column && !found.has(column)) found.set(column, index);
    });
    if (found.has("date") && found.has("debit") && found.has("credit")) {
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
        "No header row with Date, Debit and Credit columns was found in the first 40 rows. A Xero Account Transactions export has the columns Date, Source, Description, Reference, Debit, Credit.",
    });
    return {
      organisation: null,
      periodFrom: null,
      periodTo: null,
      blocks: [],
      lineCount: 0,
      issues: issues.done(),
      columns: {},
    };
  }
  const cell = (fields: readonly string[], column: Column): string => {
    const index = columns.get(column);
    return index === undefined ? "" : (fields[index] ?? "");
  };
  const dateColumn = columns.get("date") ?? 0;
  const dateOf = (fields: readonly string[]): string => (fields[dateColumn] ?? "").trim();

  // Dates: every date cell in the table decides whether numeric dates are month-first or day-first.
  const body = records.slice(headerAt + 1);
  let order: DateOrder = options.dateOrder ?? "dmy";
  if (options.dateOrder === undefined) {
    const analysis = analyzeDateOrder(
      body.map((record) => dateOf(record.fields)).filter((value) => isDateLike(value)),
    );
    if (analysis.order) order = analysis.order;
    else if (analysis.ambiguous)
      issues.add({
        severity: "error",
        code: "dates_ambiguous",
        message:
          "Every date in the file reads both as month-first and as day-first (03/04/2026 is March 4 or April 3). Say which: month-first for a US organisation.",
      });
    else if (analysis.conflicting)
      issues.add({
        severity: "error",
        code: "dates_conflicting",
        message:
          "The dates in the file cannot all be read the same way round. Check the file, or say whether they are month-first or day-first.",
      });
  }

  const lines = titleLines(records, headerAt);
  const periodLine =
    lines.find((line) => /\bperiod\b/i.test(line) && datesIn(line, order).length >= 1) ??
    lines.find((line) => datesIn(line, order).length >= 2) ??
    null;
  const dates = periodLine ? datesIn(periodLine, order) : [];
  const periodFrom = dates[0] ?? null;
  const periodTo = dates.length > 1 ? (dates[dates.length - 1] ?? null) : null;
  const organisation =
    lines.find((line) => line !== periodLine && !norm(line).startsWith("account transactions")) ??
    null;
  if (periodFrom === null || periodTo === null)
    issues.add({
      severity: "warning",
      code: "no_period",
      message:
        "No title line gives the period, so lines could not be checked against it. The report says it as 'For the period 1 July 2025 to 31 July 2025'.",
    });

  const blocks: TransactionBlock[] = [];
  let open: Open | null = null;
  const close = () => {
    const block = open;
    if (!block) return;
    open = null;
    blocks.push({ ...block });
    if (block.fileDebit !== null && block.fileCredit !== null) {
      if (block.fileDebit !== block.debit || block.fileCredit !== block.credit)
        issues.add({
          severity: "error",
          code: "block_total_differs",
          message: `${quoted(block.heading)}: the Total row says debits ${formatMoney(block.fileDebit)} and credits ${formatMoney(block.fileCredit)}, and the rows read add up to ${formatMoney(block.debit)} and ${formatMoney(block.credit)}. A row is missing or was left out.`,
          row: block.row,
        });
    } else
      issues.add({
        severity: "info",
        code: "block_no_total",
        message: `${quoted(block.heading)} has no Total row, so its rows could not be checked against one.`,
        row: block.row,
      });
  };

  let lineCount = 0;
  for (const record of body) {
    if (isBlank(record)) continue;
    const fields = record.fields;
    const first = dateOf(fields);
    const label = norm(first);
    const onlyLabel = isLabelOnly(record);

    // "Total <account>": the block's own Total row. A heading that merely starts with the word
    // has nothing else on its row.
    if (/^totals?\b/.test(label) && !onlyLabel) {
      const block = open as Open | null;
      if (block) {
        const debit = amountOf(cell(fields, "debit"), decimal);
        const credit = amountOf(cell(fields, "credit"), decimal);
        if (debit.kind === "ok" || credit.kind === "ok") {
          block.fileDebit = debit.kind === "ok" ? debit.cents : 0n;
          block.fileCredit = credit.kind === "ok" ? credit.cents : 0n;
        }
        close();
      }
      continue;
    }
    if (LABEL.test(label) && !/^totals?\b/.test(label)) continue;

    const parts = onlyLabel ? null : parseDate(first, order);
    if (onlyLabel && !isDateLike(first)) {
      // A new block: the account's heading.
      close();
      if (blocks.length >= MAX_BLOCKS) {
        issues.add({
          severity: "error",
          code: "too_many_accounts",
          message: `The file has more than ${MAX_BLOCKS} accounts. Export fewer accounts, or one month at a time.`,
        });
        break;
      }
      const split = splitAccount(first);
      open = {
        heading: clean(first, 300),
        code: split.code,
        name: split.name,
        row: record.number,
        lines: [],
        debit: 0n,
        credit: 0n,
        fileDebit: null,
        fileCredit: null,
      };
      continue;
    }
    if (!parts) {
      issues.add({
        severity: "warning",
        code: "row_unrecognised",
        message: `Row ${record.number}: ${quoted(first)} is neither a date nor a heading, so the row was left out.`,
        row: record.number,
      });
      continue;
    }
    const block = open as Open | null;
    if (!block) {
      issues.add({
        severity: "warning",
        code: "line_outside_block",
        message: `Row ${record.number}: a transaction before any account heading was left out.`,
        row: record.number,
      });
      continue;
    }
    const date = formatDate(parts);
    const debitRaw = cell(fields, "debit");
    const creditRaw = cell(fields, "credit");
    const debit = amountOf(debitRaw, decimal);
    const credit = amountOf(creditRaw, decimal);
    let bad = false;
    for (const [name, amount, raw] of [
      ["debit", debit, debitRaw],
      ["credit", credit, creditRaw],
    ] as const)
      if (amount.kind === "bad") {
        bad = true;
        issues.add({
          severity: "error",
          code: "amount_unreadable",
          message: `Row ${record.number}: the ${name} ${quoted(raw)} is not an amount (${amount.why}), so the row was left out.`,
          row: record.number,
        });
      }
    if (bad) continue;
    const d = debit.kind === "ok" ? debit.cents : 0n;
    const c = credit.kind === "ok" ? credit.cents : 0n;
    if (d === 0n && c === 0n) {
      issues.add({
        severity: "info",
        code: "line_without_amount",
        message: `Row ${record.number}: a transaction with no debit and no credit was left out.`,
        row: record.number,
      });
      continue;
    }
    if (d !== 0n && c !== 0n)
      issues.add({
        severity: "warning",
        code: "debit_and_credit",
        message: `Row ${record.number}: the row has both a debit and a credit; both were kept.`,
        row: record.number,
      });
    if (periodFrom !== null && periodTo !== null && (date < periodFrom || date > periodTo))
      issues.add({
        severity: "warning",
        code: "outside_period",
        message: `Row ${record.number}: ${date} is outside the report's period (${periodFrom} to ${periodTo}).`,
        row: record.number,
      });
    block.lines.push({
      row: record.number,
      date,
      source: clean(cell(fields, "source"), 60),
      description: clean(cell(fields, "description"), 300),
      reference: clean(cell(fields, "reference"), 120),
      debit: d,
      credit: c,
    });
    block.debit += d;
    block.credit += c;
    lineCount++;
  }
  close();
  if (blocks.length === 0)
    issues.add({
      severity: "error",
      code: "no_accounts",
      message: "The file has a header and no account blocks with transactions under it.",
    });
  const named: Record<string, string> = {};
  for (const [column, index] of columns)
    named[column] = clean(records[headerAt]?.fields[index], 60);
  return {
    organisation,
    periodFrom,
    periodTo,
    blocks,
    lineCount,
    issues: issues.done(),
    columns: named,
  };
}

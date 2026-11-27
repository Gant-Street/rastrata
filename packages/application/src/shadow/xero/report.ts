/** Reading the files Xero exports, apart from what each file says: the table, the title lines above
 * it, the header, the dates and the amounts.
 *
 * Xero's exports are made for a person reading a spreadsheet, so they are not tidy data: a report
 * starts with title lines (its name, the organisation, the date or period), then a header, then rows
 * mixed with section titles and totals. The readers here find the header instead of assuming where it
 * is, and read columns by what they are called, so a file with a column more or less, or in another
 * order, still reads. What a reader cannot read it says, row by row; it never guesses silently.
 *
 * Every cell is hostile text. A cell appears in a message only quoted and bounded (`quoteCell`), and
 * text kept from a file is cleaned (`sanitizeText`). Money is exact: integer cents in a `bigint`
 * through `parseAmount`, never a float; more than two decimals is an error, never rounded. */
import { sanitizeText } from "../../ingest/text.ts";
import { amountProblem, parseAmount } from "../../statements/amounts.ts";
import { type CsvRecord, sniffDelimiter, tokenizeCsv } from "../../statements/csv.ts";
import { type DateOrder, formatDate, parseDate } from "../../statements/dates.ts";
import { quoteCell } from "../../statements/hostile.ts";

export type XeroSeverity = "error" | "warning" | "info";

/** One finding about a file: what, and where. `row` counts the way a spreadsheet does. */
export interface XeroIssue {
  readonly severity: XeroSeverity;
  readonly code: string;
  readonly message: string;
  readonly row?: number;
}

/** The most records one file may hold. A request carries about 120,000 characters, so a real file
 * is a few thousand rows at most; this keeps a hostile one from using memory. */
export const MAX_XERO_RECORDS = 6000;
/** The most findings of one kind that are listed; the rest are counted. */
const MAX_PER_CODE = 25;
/** The most findings listed in all: the answer to a request carries at most 300. */
const MAX_ISSUES = 270;

/** The findings of one reading. A file with a thousand bad rows would otherwise bury what matters:
 * each kind is listed up to a limit and then counted, and the count is said at the end. */
export class Issues {
  readonly list: XeroIssue[] = [];
  private readonly counts = new Map<string, number>();
  private readonly kept = new Map<string, XeroIssue>();
  private dropped = 0;

  add(issue: XeroIssue): void {
    const seen = (this.counts.get(issue.code) ?? 0) + 1;
    this.counts.set(issue.code, seen);
    if (seen > MAX_PER_CODE) return;
    this.kept.set(issue.code, issue);
    if (this.list.length >= MAX_ISSUES) this.dropped++;
    else this.list.push(issue);
  }

  /** The list, with a line for each kind that was cut off. */
  done(): XeroIssue[] {
    const out = [...this.list];
    for (const [code, seen] of this.counts) {
      if (seen <= MAX_PER_CODE || out.length >= MAX_ISSUES + 10) continue;
      const first = this.kept.get(code);
      out.push({
        severity: first?.severity ?? "warning",
        code: `${code}_more`,
        message: `${seen - MAX_PER_CODE} more rows had the same problem as above (${code}); they are not listed.`,
      });
    }
    if (this.dropped > 0)
      out.push({
        severity: "info",
        code: "problems_more",
        message: `${this.dropped} more problems are not listed.`,
      });
    return out;
  }

  /** Whether any error was found, for the readers' own checks. */
  get failed(): boolean {
    return this.list.some((issue) => issue.severity === "error");
  }
}

export interface XeroTable {
  readonly delimiter: string;
  readonly records: readonly CsvRecord[];
}

export function readTable(text: string, issues: Issues): XeroTable {
  const body = text.replace(/^﻿/, "");
  const delimiter = sniffDelimiter(body);
  const table = tokenizeCsv(body, delimiter);
  if (table.truncated || table.records.length > MAX_XERO_RECORDS)
    issues.add({
      severity: "error",
      code: "file_too_long",
      message: `The file has more than ${MAX_XERO_RECORDS} rows. Export a shorter date range.`,
    });
  if (table.fieldsCut > 0)
    issues.add({
      severity: "warning",
      code: "columns_cut",
      message: `${table.fieldsCut} rows had more columns than can be read; the extra columns were ignored.`,
    });
  return { delimiter, records: table.records.slice(0, MAX_XERO_RECORDS) };
}

/** A header cell in the form columns are compared in: lower case, without the asterisk Xero puts
 * on required columns, dashes made plain, spaces collapsed. */
export const norm = (cell: string): string =>
  cell
    .replace(/^﻿/, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/^[\s*]+|[\s*:]+$/g, "")
    .replace(/\s+/g, " ");

/** Text kept from a cell: cleaned and bounded. */
export const clean = (cell: string | undefined, max = 200): string => sanitizeText(cell ?? "", max);

export const isBlank = (record: CsvRecord): boolean =>
  record.fields.every((field) => field.trim() === "");

/** A record with exactly one cell filled in, and it is the first: a section title or a total label. */
export const isLabelOnly = (record: CsvRecord): boolean => {
  const [first = "", ...rest] = record.fields;
  return first.trim() !== "" && rest.every((field) => field.trim() === "");
};

export type Amount =
  | { readonly kind: "empty" }
  | { readonly kind: "ok"; readonly cents: bigint }
  | { readonly kind: "bad"; readonly why: string };

/** One amount cell. An empty cell is not zero, it is nothing: the caller decides what that means. */
export function amountOf(cell: string | undefined, decimal: "." | ","): Amount {
  const text = (cell ?? "").trim();
  if (text === "" || text === "-" || text === "–") return { kind: "empty" };
  const result = parseAmount(text, { decimal });
  if (result.ok) return { kind: "ok", cents: result.cents };
  return { kind: "bad", why: amountProblem(result.error) };
}

/** A cell for a message: quoted, bounded, with control and direction characters made visible. */
export const quoted = (cell: string | undefined): string => quoteCell(cell ?? "");

// ---- Dates ------------------------------------------------------------------------------------

const DATE_SHAPES: readonly RegExp[] = [
  // 30 September 2026, 1 Jul 2025, 05-Jul-2025
  /\b\d{1,2}[\s-]+[A-Za-z]{3,9}\.?,?[\s-]+\d{2,4}\b/g,
  // September 30, 2026, Sep 30 2026
  /\b[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}\b/g,
  // 2026-09-30
  /\b\d{4}-\d{2}-\d{2}\b/g,
  // 09/30/2026, 30/09/2026, 30.09.2026
  /\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g,
];

/** Every date written in a line of title text, in the order they appear, as `YYYY-MM-DD`. A month
 * name settles the day and month; a numeric date uses `order`. */
export function datesIn(text: string, order: DateOrder): string[] {
  const found: { at: number; end: number; iso: string }[] = [];
  for (const shape of DATE_SHAPES)
    for (const match of text.matchAll(shape)) {
      const parts = parseDate(match[0], order);
      const at = match.index ?? 0;
      if (parts) found.push({ at, end: at + match[0].length, iso: formatDate(parts) });
    }
  found.sort((a, b) => a.at - b.at || b.end - a.end);
  const dates: string[] = [];
  let covered = -1;
  for (const item of found) {
    // A date inside the text of one already taken is the same date read another way.
    if (item.at < covered) continue;
    covered = item.end;
    dates.push(item.iso);
  }
  return dates;
}

/** The title lines above a table: the cells of each record before the header, joined and cleaned. */
export function titleLines(records: readonly CsvRecord[], headerAt: number): string[] {
  const lines: string[] = [];
  for (const record of records.slice(0, headerAt)) {
    const text = record.fields
      .map((field) => field.trim())
      .filter((field) => field !== "")
      .join(" ");
    if (text !== "") lines.push(clean(text, 160));
  }
  return lines;
}

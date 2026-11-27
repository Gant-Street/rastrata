/** The reconciliation reports as files a spreadsheet opens: the accountant pack's two (one row for each
 * reconciliation, and every line behind those rows) and the one a person downloads for a single
 * reconciliation. Every text cell goes through the same neutraliser as the other exports (a cell that
 * begins `=`, `+`, `-` or `@` is text, not a formula), money is a plain decimal that is validated before
 * it is written, and nothing in a file is a clock reading: the same records give the same bytes.
 * Pure and portable. */
import type { ReconcileReport } from "../client-contracts.gen.ts";
import { sanitizeText } from "../ingest/text.ts";
import { amount, render, text } from "../reports/csv.ts";

export const RECONCILIATIONS_PATH = "reconciliations.csv";
export const RECONCILIATION_LINES_PATH = "reconciliation-lines.csv";
export const RECONCILIATION_REPORT_VERSION = "rastrata-reconciliation-report-v1";

export const RECONCILIATION_COLUMNS = [
  "Reconciliation",
  "Account code",
  "Account",
  "Statement date",
  "Statement balance",
  "Opening balance",
  "Cleared total",
  "Outstanding total",
  "Difference",
  "Record hash",
  "Book revision",
  "Voided",
  "Voided at",
  "Void reason",
] as const;

export const RECONCILIATION_LINE_COLUMNS = [
  "Reconciliation",
  "Account code",
  "Statement date",
  "State",
  "Date",
  "Journal ID",
  "Posting ID",
  "Description",
  "Amount",
] as const;

/** Words a bank, a person or an agent wrote: reduced to plain one-line text and cut, then neutralised by
 * `text`. */
const word = (value: string, max: number): string => sanitizeText(value, max);

/** Rows of the file with one row for each reconciliation. `head` is the rows the file begins with (the
 * pack's own header for a figure file), already rendered. */
export function reconciliationsCsv(
  head: readonly (readonly string[])[],
  reports: readonly ReconcileReport[],
): string {
  const rows: string[][] = [RECONCILIATION_COLUMNS.map(text)];
  for (const report of reports)
    rows.push([
      text(report.id),
      text(report.account.code),
      text(word(report.account.name, 200)),
      text(report.statementDate),
      amount(report.statementBalance),
      amount(report.openingBalance),
      amount(report.cleared.total),
      amount(report.outstanding.total),
      amount(report.difference),
      text(report.recordHash),
      text(report.bookRevision),
      text(report.void === null ? "no" : "yes"),
      text(report.void?.voidedAt ?? ""),
      text(word(report.void?.reason ?? "", 500)),
    ]);
  return render([...head, ...rows]);
}

/** One row for each line a reconciliation cleared and each that was outstanding on its statement date. */
export function reconciliationLinesCsv(
  head: readonly (readonly string[])[],
  reports: readonly ReconcileReport[],
): string {
  const rows: string[][] = [RECONCILIATION_LINE_COLUMNS.map(text)];
  for (const report of reports)
    for (const [state, lines] of [
      ["cleared", report.cleared.lines],
      ["outstanding", report.outstanding.lines],
    ] as const)
      for (const line of lines)
        rows.push([
          text(report.id),
          text(report.account.code),
          text(report.statementDate),
          text(state),
          text(line.date),
          text(line.journalId),
          text(line.postingId),
          text(word(line.narration, 240)),
          amount(line.amount),
        ]);
  return render([...head, ...rows]);
}

/** A name for the downloaded file, built only from fixed words, a validated date and an account code
 * reduced to letters, digits, hyphens and underscores. */
export function reconciliationFileName(report: ReconcileReport): string {
  const code = report.account.code.replace(/[^A-Za-z0-9_-]/g, "") || "account";
  return `reconciliation-${code}-${report.statementDate}.csv`;
}

/** The report on one reconciliation as a single file: what it is at the top, then every line with its
 * state. */
export function reconciliationReportCsv(report: ReconcileReport, bookName: string): string {
  const voided = report.void;
  const head: string[][] = [
    [text("Report"), text("Reconciliation report")],
    [text("Book"), text(word(bookName, 200))],
    [text("Currency"), text(report.currency)],
    [text("Account"), text(word(`${report.account.code} ${report.account.name}`, 220))],
    [text("Statement date"), text(report.statementDate)],
    [text("Statement balance"), amount(report.statementBalance)],
    [text("Opening balance"), amount(report.openingBalance)],
    [text("Cleared total"), amount(report.cleared.total)],
    [text("Outstanding total"), amount(report.outstanding.total)],
    [text("Books on the statement date"), amount(report.bookBalance)],
    [text("Difference"), amount(report.difference)],
    [text("Status"), text(voided === null ? "completed" : "voided")],
    ...(voided === null
      ? []
      : [
          [text("Voided at"), text(voided.voidedAt)],
          [text("Void reason"), text(word(voided.reason, 500))],
        ]),
    [text("Finished at"), text(report.completedAt)],
    [text("Book revision"), text(report.bookRevision)],
    [text("Record hash"), text(report.recordHash)],
    [text("Report version"), text(RECONCILIATION_REPORT_VERSION)],
    [],
  ];
  const rows: string[][] = [
    ["State", "Date", "Journal ID", "Posting ID", "Description", "Amount"].map(text),
  ];
  for (const [state, lines] of [
    ["cleared", report.cleared.lines],
    ["outstanding", report.outstanding.lines],
  ] as const)
    for (const line of lines)
      rows.push([
        text(state),
        text(line.date),
        text(line.journalId),
        text(line.postingId),
        text(word(line.narration, 240)),
        amount(line.amount),
      ]);
  return render([...head, ...rows]);
}

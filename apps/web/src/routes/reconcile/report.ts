import type { ApplicationOutputs } from "@rastrata/application/client-contracts";
import type { ReconcileOutstandingView } from "@rastrata/ui/reconcile/types";

/** The pure parts of the report on a finished reconciliation: what the page shows of it, and the file a person
 * saves. The report itself is the application's; nothing here works a figure out. */
export type ReconcileReport = ApplicationOutputs["reconcile.report"];

/** Where the entry behind a transaction is read: at the revision the reconciliation finished at, which is
 * the books the report was worked out from. */
export const entryHref = (journalId: string, revision: string): string =>
  `/journal/${encodeURIComponent(journalId)}?revision=${encodeURIComponent(revision)}`;

/** What is shown under "Not yet on the statement": the statement balance, the transactions not yet on it
 * and the books' balance, as the report gives them. */
export function outstandingView(report: ReconcileReport): ReconcileOutstandingView {
  return {
    statementDate: report.statementDate,
    statementBalance: report.statementBalance,
    bookBalance: report.bookBalance,
    total: report.outstanding.total,
    lines: report.outstanding.lines.map((line) => ({
      id: line.postingId,
      date: line.date,
      description: line.narration,
      amount: line.amount,
      href: entryHref(line.journalId, report.bookRevision),
    })),
  };
}

/** A name for the saved file that is only letters, digits, dots, hyphens and underscores, whatever the
 * service sent: the file's name is the one thing in a download the browser takes from the page. */
export function reportFileName(name: string): string {
  const plain = name
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, 100);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\.csv$/.test(plain) ? plain : "reconciliation-report.csv";
}

/** The file as bytes: UTF-8 with a byte order mark, so a spreadsheet reads accented names correctly. The
 * service's own file has none; this is only for the download. */
export const reportBlob = (file: { readonly mediaType: string; readonly content: string }): Blob =>
  new Blob(["﻿", file.content], { type: file.mediaType });

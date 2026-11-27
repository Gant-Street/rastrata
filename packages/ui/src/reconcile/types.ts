/** Display contracts for the reconcile components. Amounts are exact decimal strings with two
 * places, supplied by the application; the components format them for reading and never calculate
 * with them. Descriptions are bank memos and a person's notes: untrusted text, shown as text only. */

export type ReconcileLine = {
  id: string;
  /** YYYY-MM-DD. */
  date: string;
  description: string;
  /** Signed, in statement terms: negative lowers the statement balance (money out, a payment). */
  amount: string;
  /** A link back to the entry the line belongs to. */
  href?: string;
};

export type ReconcileFigures = {
  statementBalance: string;
  /** What earlier statements have already cleared. */
  openingBalance: string;
  selectedCount: number;
  selectedTotal: string;
  clearedBalance: string;
  /** statementBalance - clearedBalance. Exactly "0.00" means balanced. */
  difference: string;
};

export type ReconcileAccountInfo = {
  code: string;
  name: string;
  /** An asset is money you have; a liability is money you owe. It sets the words for the columns. */
  kind: "asset" | "liability";
};

/** Whether the person's last change is safely stored. `uncertain` means the reply was lost and the
 * original request must be resumed; it is never shown as saved. */
export type SaveState = "saved" | "saving" | "uncertain" | "failed";

export type ReconcileFinish = {
  disabled: boolean;
  /** Why Finish is unavailable, in words, or what it will do. */
  hint: string;
  onFinish: () => void;
};

/** What the report on a finished reconciliation says about the statement: the transactions in the books on
 * or before its date that it did not show yet, and the books' balance that results. Amounts come from the
 * application, already worked out and checked; the components format them and calculate nothing. */
export type ReconcileOutstandingView = {
  /** YYYY-MM-DD. */
  statementDate: string;
  statementBalance: string;
  /** The books' balance on the statement date, as the books stood when the reconciliation was finished. */
  bookBalance: string;
  /** What the transactions not yet on the statement add up to. */
  total: string;
  lines: readonly ReconcileLine[];
};

/** Where the downloadable report is. `saved` is only ever shown once the file has been handed to the
 * browser. */
export type ReportFileState = "idle" | "preparing" | "saved" | "failed";

export type ReconciliationRow = {
  id: string;
  href: string;
  account: string;
  statementDate: string;
  statementBalance: string;
  lineCount: number;
  status: "draft" | "completed" | "voided";
  /** When it was completed (or last changed, for a draft), for reading, e.g. "2026-02-03". */
  on: string;
};

export type AccountStatusRow = {
  id: string;
  account: string;
  tracked: boolean;
  lastReconciledDate: string | null;
  lastReconciledBalance: string | null;
  unclearedCount: number;
  unclearedTotal: string;
  oldestUnclearedDate: string | null;
  /** The draft in progress, if any. */
  draftHref: string | null;
};

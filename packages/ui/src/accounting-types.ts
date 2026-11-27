/** Display contracts: exact strings are supplied by the application, never recalculated here. */
export type AccountChoice = {
  label: string;
  value: string;
  path: string;
  group: string;
  disabled?: boolean;
  reason?: string;
  /** The account's code and name on their own, when the application has them. A list names an account
   * by `name` (falling back to `label`); the code is for the chart, the pickers and the reports. */
  code?: string;
  name?: string;
};
export type JournalLine = {
  id: string;
  accountId: string;
  debit: string | null;
  credit: string | null;
};
export type RegisterEntry = {
  id: string;
  date: string;
  isoDate: string;
  reference: string;
  /** What the entry says in words (its narration). Shown as the entry's description when present; the
   * `reference` is then the short name a person gave it. */
  description?: string;
  /** The entry's number in the book, shown as "No. 23". Posted entries only. */
  postingSequence?: string;
  /** Where the entry came from, for the Type filter. */
  type?: "bank" | "stripe" | "manual" | "opening";
  amount: string;
  status: "Draft" | "Posted";
  lines: JournalLine[];
  debitTotal: string;
  creditTotal: string;
  /** `isoAt` makes the timestamp machine-readable; `at` is the display text. */
  history: { at: string; isoAt?: string; description: string }[];
};
/** A reversal links an entry to the entry that cancels it. The numbers let a row say "Reversed by No. 29"
 * without reading the other entry. */
export type RegisterCorrection = {
  originalJournalId: string;
  correctionJournalId: string;
  originalPostingSequence?: string;
  correctionPostingSequence?: string;
  kind?: string;
};
/** Something a person can do to one entry, offered on its row and in its side sheet. */
export type RowAction = {
  id: string;
  label: string;
  onSelect: () => void;
};
export type DraftSaveResult =
  | { status: "saved"; entry: RegisterEntry }
  | { status: "rejected" | "unknown" };
export type JournalContext = {
  bookName: string;
  currency: string;
  description: string;
  savedMessage: string;
};

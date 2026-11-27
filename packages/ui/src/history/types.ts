export type HistoryRole = "asset" | "liability" | "equity" | "income" | "expense";
export const HISTORY_ROLES: readonly HistoryRole[] = [
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
];

/** What the review needs of a preview. The service's own answer has more; this is what is shown. */
export interface HistoryPreviewView {
  readonly entries: number;
  readonly lines: number;
  readonly firstDate: string | null;
  readonly lastDate: string | null;
  readonly dateOrderAssumed: boolean;
  readonly years: readonly {
    readonly fiscalYear: number;
    readonly entries: number;
    readonly total: string;
  }[];
  readonly accounts: readonly {
    readonly label: string;
    readonly lines: number;
    /** The code of the book's account it is posted to, or null when it has none yet. */
    readonly account: string | null;
    readonly accountName: string | null;
    /** The kind it is added as, when the person chose to add it to the book. */
    readonly add: HistoryRole | null;
    /** The kind the file's number or name suggests, when the book does not have it. */
    readonly suggestedRole: HistoryRole | null;
    /** The code of the book's account this is probably the same as, by its name. */
    readonly suggestedAccount?: string | null;
  }[];
  readonly unmapped: number;
  readonly problems: readonly { readonly row: number; readonly message: string }[];
  readonly problemCount: number;
  readonly conflicts: readonly string[];
  readonly alreadyImported: number;
  readonly remaining: number;
  readonly ready: boolean;
}

export type HistoryStage = "review" | "importing" | "stopped" | "done";

/** What a comparison with the old books' trial balance says, as the review shows it. */
export interface TieOutView {
  readonly asOf: string;
  readonly tied: boolean;
  readonly differing: number;
  /** The accounts that differ, each with the old books' figure, the book's and the difference. */
  readonly accounts: readonly {
    readonly account: string;
    readonly name: string;
    readonly file: string;
    readonly book: string;
    readonly difference: string;
  }[];
  /** Accounts of the file the book has none for, with the balance the file gives each. */
  readonly unmapped: readonly string[];
  readonly problems: readonly { readonly row: number; readonly message: string }[];
  readonly problemCount: number;
}

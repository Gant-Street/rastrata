import type { AccountTags } from "./account-tags.ts";

export type AccountRole =
  | "asset"
  | "liability"
  | "equity"
  | "income"
  | "expense"
  | "gain"
  | "unrealizedGain";

export interface InitialAccount {
  readonly code: string;
  readonly name: string;
  readonly role: AccountRole;
  readonly parentCode?: string;
  /** Tags the account starts with: cash-flow class, tax line and role key (see account-tags.ts). */
  readonly tags?: AccountTags;
}
/** The accounting basis a book is kept on. It is fixed when the book is created. */
export type BookBasis = "cash" | "accrual";

export interface BookSetup {
  readonly name: string;
  readonly currency: "USD" | "EUR" | "GBP";
  /** The calendar year in which the book's first fiscal year starts. The calendar is built from
   * here through the fiscal year the book is created in, and it can only grow forward after that,
   * so a book that may one day take in earlier years starts early (the web setup uses 2000). */
  readonly fiscalYear: number;
  readonly periodModel: "monthly" | "quarterly";
  /** The month, 1 to 12, in which each fiscal year starts. Omitted means 1 (January). */
  readonly fiscalYearStartMonth?: number;
  /** Omitted means accrual, which is what every book created before this field was. */
  readonly basis?: BookBasis;
  /** The last fiscal year to build the calendar through, from `fiscalYear`. Omitted means the fiscal
   * year the book is created in, so a book that starts early has every year since. After that the
   * calendar only grows forward (`periods.extend`). */
  readonly calendarThrough?: number;
  /** The day the books begin, `YYYY-MM-DD`: where the opening balances stand and from where
   * periods are counted. It is a fact about the books, apart from the calendar, which may start
   * earlier. Periods that end before it are marked `beforeBooks` and left out of every count. A
   * recorded cutover date, when there is one, replaces it. Omitted means the first day of the
   * first fiscal year. */
  readonly booksStartOn?: string;
  readonly accounts: readonly InitialAccount[];
}

export interface SourceEvent {
  readonly id: string;
  readonly description: string;
  readonly evidenceReference?: string;
}

export interface JournalDraftData {
  readonly date: string;
  readonly reference: string;
  readonly narration: string;
  readonly source?: SourceEvent;
  readonly lines: readonly {
    readonly accountId: string;
    readonly debit: string;
    readonly credit: string;
  }[];
}

export interface SavedDraft {
  readonly id: string;
  readonly version: number;
  readonly status: "draft" | "posting" | "rejected" | "posted";
  readonly data: JournalDraftData;
  readonly journalId?: string;
  readonly postingOperationId?: string;
  readonly outcomeSequence?: string;
  readonly recoveredFromOperationId?: string;
}

export interface MutationReceipt {
  readonly disposition: string;
  readonly operationId: string;
  readonly outcomeSequence: string | null;
  readonly diagnostics: readonly string[];
  readonly problems: readonly { code: string; message: string }[];
}

export interface PreparedOperation extends MutationReceipt {
  /** Advisory notes from the lanes; they never block a commit or change `valid`. */
  readonly warnings?: readonly { code: string; message: string }[];
  readonly planId: string;
  readonly planHash: string;
  readonly bookRevision: string;
  readonly valid: boolean;
  readonly kind: string;
  readonly effects: {
    readonly journals: readonly {
      id: string;
      date: string;
      narration: string;
      lines: readonly { accountId: string; debit: string; credit: string }[];
    }[];
    readonly accounts: readonly {
      id: string;
      code: string;
      name: string;
      closedOn: string | null;
    }[];
    readonly periods: readonly {
      periodId: string;
      kind: string;
      reason: string;
      closePackageId?: string;
      reportPopulationHash?: string;
      /** For a reopening: the other periods whose closes it supersedes. */
      supersededPeriodIds?: readonly string[];
    }[];
    /** Periods a configuration change adds to the fiscal calendar (a calendar extension). */
    readonly calendar?: readonly {
      periodId: string;
      fiscalYear: number;
      label: string;
      startsOn: string;
      endsOn: string;
    }[];
  };
}

/** Report shapes come from the operation contract, so they cannot drift from what the service returns
 * (see slices/reports/schema.ts). `StatementAccountRow` is the long-standing name of `StatementRow`. */
export type {
  CoreReports,
  ReportRow,
  StatementRow as StatementAccountRow,
} from "./client-contracts.gen.ts";

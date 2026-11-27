import type { IssueView } from "./types";

/** What the Xero import, comparison and gap log screens are given. Plain data: every figure is the
 * wire amount the service wrote ("-1150.00"), and the components set it through the shared
 * formatter. Text that came from a file or from Xero is data, shown as text and never followed. */

/** A file the person chose for a step. Only its name is kept in the view; the text lives in the
 * controller for as long as the step needs it. */
export interface FileStepView {
  readonly fileName: string | null;
  /** The file is being read, or the service is being asked about it. */
  readonly busy: boolean;
  /** Why the file could not be used (too large, not text); the preview's own problems are listed
   * in the preview. */
  readonly fileError?: string | undefined;
  readonly onFile: (file: File) => void;
}

// ---- The gap log ----------------------------------------------------------------------------------

export type GapKind = "difference" | "unmapped" | "feature" | "data" | "other";
export type GapFilter = "open" | "closed" | "all";

export interface GapView {
  readonly id: number;
  readonly kind: GapKind;
  readonly title: string;
  readonly detail: string;
  readonly source: "tieout" | "manual";
  readonly status: "open" | "closed";
  readonly openedAt: string;
  readonly openedBy: string;
  readonly closedAt: string | null;
  readonly closedBy: string | null;
  readonly resolution: string | null;
}

export interface GapsScreenProps {
  state: "loading" | "error" | "ready";
  /** There is no book yet: the screen says so, in place of the rest. */
  noBook?: boolean | undefined;
  onRetry?: (() => void) | undefined;
  focusTitle?: boolean | undefined;
  /** A request failed in a way no field can show. Nothing was changed. */
  error?: string | undefined;
  /** An earlier write was not confirmed: resuming it is the only thing offered. */
  uncertain: { readonly resuming: boolean } | null;
  onResume?: (() => void) | undefined;
  filter: GapFilter;
  counts: { readonly open: number; readonly closed: number };
  onFilter: (filter: GapFilter) => void;
  gaps: readonly GapView[];
  /** The gap a write is under way for. */
  busyId: number | null;
  /** A write on one gap failed. */
  actionError: { readonly id: number; readonly message: string } | null;
  onClose: (id: number, resolution: string) => void;
  onReopen: (id: number) => void;
  add: {
    readonly title: string;
    readonly detail: string;
    readonly kind: GapKind;
    readonly titleError?: string | undefined;
    readonly pending: boolean;
    /** The last gap was added: said once, in words. */
    readonly done: boolean;
    readonly error?: string | undefined;
    readonly onTitle: (value: string) => void;
    readonly onDetail: (value: string) => void;
    readonly onKind: (value: GapKind) => void;
    readonly onSubmit: () => void;
  };
}

// ---- The comparison -------------------------------------------------------------------------------

export interface TieoutLineView {
  readonly side: "xero" | "rastrata";
  readonly date: string;
  readonly description: string;
  readonly reference: string;
  readonly source: string;
  readonly debit: string;
  readonly credit: string;
}

export interface TieoutAccountView {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly basis: "closing" | "movement";
  readonly status: "matches" | "differs" | "not_comparable";
  /** Why it cannot be compared, in the service's words. */
  readonly reason: string | null;
  readonly xero: string | null;
  readonly rastrata: string | null;
  readonly difference: string | null;
  /** What the books already disagreed about when the period began. */
  readonly carried: string | null;
  /** What the lines leave unexplained of the difference. */
  readonly residual: string | null;
  readonly explained: boolean;
  readonly matched: number;
  readonly unmatchedCount: number | null;
  readonly unmatched: readonly TieoutLineView[];
}

export interface TieoutPeriodView {
  readonly from: string;
  readonly to: string;
  readonly xeroReconciled: boolean;
  readonly notReconciled: readonly {
    readonly code: string;
    readonly name: string;
    readonly through: string | null;
  }[];
  readonly accounts: readonly TieoutAccountView[];
  readonly unmapped: readonly {
    readonly code: string;
    readonly name: string;
    readonly net: string;
  }[];
}

export interface TieoutSummaryView {
  readonly periods: number;
  readonly comparable: number;
  readonly matches: number;
  readonly differs: number;
  readonly explained: number;
  readonly unexplained: number;
  readonly notComparable: number;
  readonly linesOnlyInXero: number;
  readonly linesOnlyInRastrata: number;
}

export interface TieoutReportView {
  readonly currency: string;
  readonly basis: string;
  readonly cutoverDate: string | null;
  readonly summary: TieoutSummaryView;
  readonly periods: readonly TieoutPeriodView[];
  readonly notes: readonly string[];
}

export interface TieoutScreenProps {
  state: "loading" | "error" | "ready";
  /** There is no book yet: the screen says so, in place of the rest. */
  noBook?: boolean | undefined;
  /** Nothing has been imported from Xero yet, so there is nothing to compare: the screen says to import
   * first (an empty state with the way to do it), not that something failed. */
  noXero?: boolean | undefined;
  onRetry?: (() => void) | undefined;
  focusTitle?: boolean | undefined;
  error?: string | undefined;
  uncertain: { readonly resuming: boolean } | null;
  onResume?: (() => void) | undefined;
  range: {
    readonly from: string;
    readonly to: string;
    readonly tolerance: string;
    readonly toleranceError?: string | undefined;
    readonly running: boolean;
    readonly onFrom: (value: string) => void;
    readonly onTo: (value: string) => void;
    readonly onTolerance: (value: string) => void;
    readonly onRun: () => void;
  };
  report: TieoutReportView | null;
  record: {
    readonly pending: boolean;
    readonly result: { readonly added: number; readonly existing: number } | null;
    readonly error?: string | undefined;
    readonly onRecord: () => void;
  };
  links: { readonly gaps: string; readonly xero: string };
}

// ---- The Xero import ------------------------------------------------------------------------------

export type XeroConfidence = "certain" | "likely" | "check" | "none";
export type DateOrder = "mdy" | "dmy";

export interface XeroStatusView {
  readonly chartImportedAt: string | null;
  readonly counts: {
    readonly accounts: number;
    readonly mapped: number;
    readonly skipped: number;
    readonly unmapped: number;
    readonly unmappedWithBalance: number;
  };
  readonly trialBalances: readonly string[];
  readonly transactions: readonly {
    readonly from: string;
    readonly to: string;
    readonly accounts: number;
    readonly lines: number;
  }[];
  readonly reconciled: readonly {
    readonly code: string;
    readonly name: string | null;
    readonly through: string;
  }[];
  readonly notes: readonly string[];
}

/** A column of a file as it was read: the header the file used, and what it was taken to be. */
export interface ColumnView {
  readonly header: string;
  readonly field: string;
}

export interface MappingChoiceView {
  readonly value: string;
  readonly label: string;
}

export interface XeroAccountView {
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly balance: string | null;
  readonly tags: readonly ("archived" | "system" | "bank")[];
  readonly confidence: XeroConfidence;
  readonly basis: "override" | "saved" | "code" | "name" | "similar" | "none";
  readonly problems: readonly string[];
  /** What to create when nothing resembles the account, in words. */
  readonly suggestion: string | null;
  /** What the choice shows: "" (not decided: the match stands), "skip", or an account id. */
  readonly value: string;
  /** The account it maps to now, in words, or null. */
  readonly mapsTo: string | null;
  readonly skip: boolean;
  /** Possible matches, shown first in the choice. */
  readonly candidates: readonly MappingChoiceView[];
}

/** What keeping a file needs and says. A file with rows that could not be read is kept only if the
 * person agrees to leave them out. */
export interface KeepView {
  readonly pending: boolean;
  readonly canKeep: boolean;
  readonly message?: string | undefined;
  readonly error?: string | undefined;
  readonly unreadable: number;
  readonly skipUnreadable: boolean;
  readonly onSkipUnreadable: (value: boolean) => void;
  readonly onKeep: () => void;
}

export interface ChartStepView extends FileStepView {
  readonly preview: {
    readonly source: "file" | "stored";
    readonly counts: {
      readonly accounts: number;
      readonly certain: number;
      readonly likely: number;
      readonly check: number;
    };
    readonly rows: readonly XeroAccountView[];
    readonly issues: readonly IssueView[];
    readonly columns: readonly ColumnView[];
  } | null;
  readonly choices: readonly MappingChoiceView[];
  readonly onChoose: (code: string, value: string) => void;
  readonly acceptLikely: boolean;
  readonly onAcceptLikely: (value: boolean) => void;
  readonly keep: KeepView;
}

export interface TbRowView {
  readonly row: number;
  readonly xeroCode: string | null;
  readonly name: string;
  readonly net: string;
  readonly status: "mapped" | "skipped" | "unmapped" | "zero" | "profit_loss" | "retained_earnings";
  readonly mapsTo: string | null;
  readonly balance: string | null;
}

export interface TbStepView extends FileStepView {
  readonly dateOrder: DateOrder;
  readonly onDateOrder: (value: DateOrder) => void;
  readonly includeProfitLoss: boolean;
  readonly onIncludeProfitLoss: (value: boolean) => void;
  readonly preview: {
    readonly asOf: string | null;
    readonly balanced: boolean;
    readonly rows: readonly TbRowView[];
    readonly issues: readonly IssueView[];
    readonly leftOut: {
      readonly profitLoss: number;
      readonly unmapped: number;
      readonly skipped: number;
      readonly retainedEarnings: string;
    };
    /** What the date means for the cutover, in words. */
    readonly cutoverNote: string | null;
    readonly asOfIsDayBefore: boolean;
    readonly columns: readonly ColumnView[];
  } | null;
  readonly keep: KeepView;
  readonly canUseAsOpening: boolean;
  readonly onUseAsOpening: () => void;
}

export interface AtBlockView {
  readonly heading: string;
  readonly xeroCode: string | null;
  readonly name: string;
  readonly status: "mapped" | "skipped" | "unmapped";
  readonly mapsTo: string | null;
  readonly lines: number;
  readonly debit: string;
  readonly credit: string;
  /** The file's own total row, when it has one. */
  readonly fileDebit: string | null;
  readonly fileCredit: string | null;
  readonly agrees: boolean | null;
  readonly sample: readonly {
    readonly date: string;
    readonly description: string;
    readonly reference: string;
    readonly debit: string;
    readonly credit: string;
  }[];
}

export interface AtStepView extends FileStepView {
  readonly dateOrder: DateOrder;
  readonly onDateOrder: (value: DateOrder) => void;
  readonly preview: {
    readonly periodFrom: string | null;
    readonly periodTo: string | null;
    readonly lineCount: number;
    readonly blocks: readonly AtBlockView[];
    readonly issues: readonly IssueView[];
    readonly columns: readonly ColumnView[];
  } | null;
  readonly keep: KeepView;
}

export interface ReconciledStepView {
  readonly rows: readonly {
    readonly code: string;
    readonly name: string;
    /** The date typed ("" for not reconciled). */
    readonly through: string;
    readonly error?: string | undefined;
  }[];
  readonly onThrough: (code: string, value: string) => void;
  readonly save: {
    readonly pending: boolean;
    readonly canSave: boolean;
    readonly message?: string | undefined;
    readonly error?: string | undefined;
    readonly onSave: () => void;
  };
}

export interface XeroScreenProps {
  state: "loading" | "error" | "ready";
  /** There is no book yet: the screen says so, in place of the rest. */
  noBook?: boolean | undefined;
  onRetry?: (() => void) | undefined;
  focusTitle?: boolean | undefined;
  error?: string | undefined;
  uncertain: { readonly resuming: boolean } | null;
  onResume?: (() => void) | undefined;
  status: XeroStatusView | null;
  chart: ChartStepView;
  trialBalance: TbStepView;
  transactions: AtStepView;
  reconciled: ReconciledStepView;
  links: { readonly tieout: string; readonly opening: string };
}

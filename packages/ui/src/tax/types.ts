/** What the tax components are given. These mirror the shapes the service returns for the tax
 * operations (the same field names and value sets), kept here so the component package depends on
 * nothing else: the web application passes what it read, and TypeScript checks it fits. Every amount
 * is a wire amount ("-12.34"); a component never turns one into a number. */

export interface TaxSourceView {
  readonly title: string;
  readonly url: string;
  readonly readOn?: string | undefined;
}

export interface TaxNoteView {
  readonly key: string;
  readonly text: string;
  readonly sources?: readonly TaxSourceView[] | undefined;
}

export interface TaxWarningView {
  readonly code: string;
  readonly message: string;
}

export type TaxCheckStatus = "ok" | "attention" | "unknown";

export interface TaxCheckView {
  readonly key: string;
  readonly status: TaxCheckStatus;
  readonly title: string;
  readonly detail: string;
  /** A screen where it is fixed, as a path: "/inbox". */
  readonly href?: string | undefined;
  /** How many things the check found, when it counts something and found some: the lines waiting in the
   * Inbox, the accounts with no tax line, the months not closed. */
  readonly count?: number | undefined;
}

export interface TaxFormView {
  readonly id: string;
  readonly name: string;
  readonly subject: string;
  readonly taxYear: number;
  readonly status: "final" | "draft";
  readonly sources: readonly TaxSourceView[];
}

export type TaxFormId = "scheduleC" | "form1120S" | "form1065";

export interface TaxLineAccountView {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly amount: string;
  readonly from: string;
  readonly to: string;
  readonly postings: number;
}

export interface TaxLineAdjustmentView {
  readonly kind: "meals";
  readonly percent: number;
  readonly removed: string;
  readonly reason: string;
}

export interface TaxWorksheetLineView {
  readonly key: string;
  readonly number: string;
  readonly label: string;
  readonly kind: "tagged" | "computed" | "untracked";
  readonly booked: string;
  readonly amount: string;
  readonly formula?: string | undefined;
  readonly note?: string | undefined;
  readonly adjustment?: TaxLineAdjustmentView | undefined;
  /** The worksheet's last computed line: net profit, or ordinary business income. */
  readonly net?: boolean | undefined;
  readonly accounts: readonly TaxLineAccountView[];
}

export interface TaxWorksheetPartView {
  readonly key: string;
  readonly label: string;
  readonly lines: readonly TaxWorksheetLineView[];
}

export type TaxUnmappedReason =
  | "no_tax_line"
  | "other_form"
  | "not_on_this_year"
  | "role_not_accepted";

export interface TaxUnmappedView {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly role: string;
  readonly amount: string;
  readonly reason: TaxUnmappedReason;
  readonly taxLine: string | null;
  readonly from: string;
  readonly to: string;
  readonly postings: number;
}

export interface TaxReconciliationView {
  readonly rows: readonly {
    readonly key: string;
    readonly label: string;
    readonly amount: string;
  }[];
  readonly netIncomeBooks: string;
  readonly netProfit: string;
  readonly ties: boolean;
}

export interface TaxWorksheetData {
  readonly taxYear: number;
  readonly form: TaxFormView;
  readonly from: string;
  readonly to: string;
  readonly mealsPercent: number;
  readonly parts: readonly TaxWorksheetPartView[];
  readonly unmapped: readonly TaxUnmappedView[];
  readonly unmappedIncome: string;
  readonly unmappedExpenses: string;
  readonly reconciliation: TaxReconciliationView;
  readonly notes: readonly TaxNoteView[];
  readonly warnings: readonly TaxWarningView[];
  readonly disclaimer: string;
}

/** A file of a pack, as the service returns it. */
export interface TaxPackFileView {
  readonly path: string;
  readonly mediaType: string;
  readonly description: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly content: string;
}

export interface TaxPackView {
  readonly format: string;
  readonly folder: string;
  readonly taxYear: number;
  readonly from: string;
  readonly to: string;
  readonly bookRevision: string;
  readonly files: readonly TaxPackFileView[];
  readonly manifestSha256: string;
  readonly disclaimer: string;
  readonly checks?: readonly TaxCheckView[] | undefined;
  readonly warnings?: readonly TaxWarningView[] | undefined;
  /** Whether the books for the range are closed, in the calendar lane's words, and the last current
   * close the pack is tied to. */
  readonly close?:
    | {
        readonly state: "closed" | "partly_closed" | "open";
        readonly statement: string;
      }
    | undefined;
}

// ---- 1099 vendors ----------------------------------------------------------------------------

export type TaxVendorReporting = "yes" | "no" | "undecided";
export type TaxVendorReason =
  | "corporation"
  | "employee"
  | "personal"
  | "merchandise"
  | "exempt_organization"
  | "card_or_network"
  | "other";
export type TaxVendorW9 = "not_requested" | "requested" | "received";
export type TaxVendorClassification =
  | "individual"
  | "c_corporation"
  | "s_corporation"
  | "partnership"
  | "trust_estate"
  | "llc_c"
  | "llc_s"
  | "llc_p"
  | "other";
export type TaxVendorPaidBy = "unknown" | "bank" | "card_or_network";
export type TaxVendorAttention = "undecided" | "w9_missing" | "method_unconfirmed";

export interface TaxVendorView {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly payeeKeys: readonly string[];
  readonly reporting: TaxVendorReporting;
  readonly reason: TaxVendorReason | null;
  readonly w9: TaxVendorW9;
  readonly w9On: string | null;
  readonly classification: TaxVendorClassification | null;
  readonly paidBy: TaxVendorPaidBy;
  readonly notes: string;
  readonly recordedAt: string;
  readonly principal: string;
}

export interface TaxVendorRowView {
  readonly vendor: TaxVendorView;
  readonly payments: number;
  readonly counted: string;
  readonly card: string;
  readonly other: string;
  readonly meetsThreshold: boolean;
  readonly attention: readonly TaxVendorAttention[];
}

export interface TaxPayeeRowView {
  readonly payee: string;
  readonly payments: number;
  readonly counted: string;
  readonly card: string;
  readonly other: string;
  readonly ambiguous: boolean;
  readonly firstOn: string;
  readonly lastOn: string;
}

export interface TaxReportableAccountView {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly marked: boolean;
  readonly suggested: boolean;
}

export interface TaxThresholdView {
  readonly taxYear: number;
  readonly amount: string;
  readonly note?: string | undefined;
  readonly sources: readonly TaxSourceView[];
}

export interface TaxVendorsData {
  readonly taxYear: number;
  readonly from: string;
  readonly to: string;
  readonly threshold: TaxThresholdView;
  readonly accounts: readonly TaxReportableAccountView[];
  readonly vendors: readonly TaxVendorRowView[];
  readonly payees: readonly TaxPayeeRowView[];
  readonly totals: {
    readonly payments: number;
    readonly counted: string;
    readonly card: string;
    readonly other: string;
  };
  readonly overThreshold: number;
  readonly needW9: number;
  readonly undecided: number;
  readonly notes: readonly TaxNoteView[];
  readonly warnings: readonly TaxWarningView[];
  readonly disclaimer: string;
}

export interface TaxPaymentView {
  readonly date: string;
  readonly journalId: string;
  readonly payee: string;
  readonly accounts: string;
  readonly amount: string;
  readonly paidFrom: string;
  readonly counted: boolean;
  readonly reason: string;
}

export interface TaxVendorDetailView {
  readonly vendor: TaxVendorRowView;
  readonly history: readonly TaxVendorView[];
  readonly payments: readonly TaxPaymentView[];
  readonly truncated: boolean;
}

/** What the vendor form holds: text as typed, turned into the service's fields on save. */
export interface TaxVendorFormValues {
  readonly name: string;
  /** Payee texts, one per line or separated by semicolons. */
  readonly payees: string;
  readonly reporting: TaxVendorReporting;
  readonly reason: TaxVendorReason | "";
  readonly w9: TaxVendorW9;
  readonly w9On: string;
  readonly classification: TaxVendorClassification | "";
  readonly paidBy: TaxVendorPaidBy;
  readonly notes: string;
}

export interface TaxVendorFormErrors {
  readonly form?: string | undefined;
  readonly name?: string | undefined;
  readonly payees?: string | undefined;
  readonly reason?: string | undefined;
  readonly w9On?: string | undefined;
  readonly notes?: string | undefined;
}

// ---- Sales tax -------------------------------------------------------------------------------

export type TaxSalesPeriodKind = "month" | "quarter" | "year";

export interface TaxSalesPeriodView {
  readonly key: string;
  readonly from: string;
  readonly to: string;
  readonly opening: string;
  readonly collected: string;
  readonly remitted: string;
  readonly closing: string;
  readonly postings: number;
  readonly stripeBooked: string;
  readonly stripeReported: string;
  readonly stripeDifference: string;
}

export interface TaxSalesData {
  readonly taxYear: number;
  readonly from: string;
  readonly to: string;
  readonly period: TaxSalesPeriodKind;
  readonly ledgerPopulationHash: string;
  readonly accounts: readonly {
    readonly accountId: string;
    readonly code: string;
    readonly name: string;
    readonly balance: string;
  }[];
  readonly candidates: readonly {
    readonly accountId: string;
    readonly code: string;
    readonly name: string;
    readonly suggested: boolean;
  }[];
  readonly opening: string;
  readonly collected: string;
  readonly remitted: string;
  readonly closing: string;
  readonly periods: readonly TaxSalesPeriodView[];
  readonly stripe: {
    readonly read: boolean;
    readonly payouts: number;
    readonly booked: string;
    readonly reported: string;
    readonly salesTax: "stripe" | "none" | null;
    readonly taxNotReported: number | null;
    readonly refundsWithoutTaxSplit: number | null;
  };
  readonly statement: string;
  readonly notes: readonly TaxNoteView[];
  readonly warnings: readonly TaxWarningView[];
  readonly disclaimer: string;
}

// ---- Adjusting entries -----------------------------------------------------------------------

export type TaxAdjustmentStatus = "new" | "already_imported" | "conflict" | "invalid";

export interface TaxAdjustmentProblemView {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
  readonly row?: number | null | undefined;
  readonly entry?: string | null | undefined;
  readonly column?: string | null | undefined;
}

export interface TaxAdjustmentEntryView {
  readonly entry: string;
  readonly firstRow: number;
  readonly date: string | null;
  readonly narration: string;
  readonly lines: readonly {
    readonly row: number;
    readonly account: string;
    readonly accountName: string | null;
    readonly debit: string;
    readonly credit: string;
  }[];
  readonly debit: string;
  readonly credit: string;
  readonly status: TaxAdjustmentStatus;
  readonly draft: { readonly id: string; readonly version: number; readonly status: string } | null;
  readonly problems: readonly TaxAdjustmentProblemView[];
}

export interface TaxAdjustmentPreviewView {
  readonly fileName: string;
  readonly rows: number;
  readonly entries: readonly TaxAdjustmentEntryView[];
  readonly counts: {
    readonly entries: number;
    readonly lines: number;
    readonly new: number;
    readonly alreadyImported: number;
    readonly conflict: number;
    readonly invalid: number;
  };
  readonly problems: readonly TaxAdjustmentProblemView[];
  readonly canImport: boolean;
  readonly previewHash: string;
  readonly notice: string;
}

export interface TaxAdjustmentImportedView {
  readonly fileName: string;
  readonly created: readonly { readonly entry: string; readonly draftId: string }[];
  readonly skipped: readonly { readonly entry: string }[];
  readonly nextStep: string;
}

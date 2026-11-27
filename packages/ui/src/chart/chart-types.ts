/** Shapes the chart components share. They describe a chart as a person edits it, so they are
 * structural and know nothing about the application's wire types: the route maps between them. */

export type ChartRole = "asset" | "liability" | "equity" | "income" | "expense";
export type CashFlowClass = "cash" | "operating" | "investing" | "financing" | "noncash";
/** What a bank or card account is to the person; the tag `kind` carries it, and its codes are the 1000s and 2000s. */
export type SlotKind = "bank" | "card";

export interface ChartTags {
  cashFlowClass?: CashFlowClass | undefined;
  /** A tax form line such as "scheduleC.line8". A suggestion; nothing is filed. */
  taxLine?: string | undefined;
  /** A key other parts of Rastrata use to find the account, such as "stripe.balance". */
  roleKey?: string | undefined;
  /** "bank" on an asset that is a bank account, "card" on a liability that is a card. */
  kind?: SlotKind | undefined;
}

/** One account row while a chart is being edited. */
export interface ChartAccount {
  /** Identity of the row while editing. Never sent anywhere; it keeps focus in the right input. */
  readonly key: string;
  code: string;
  name: string;
  readonly role: ChartRole;
  tags: ChartTags;
  /** What belongs in the account, in a sentence. */
  readonly note?: string | undefined;
}

export interface TaxLineChoice {
  readonly id: string;
  readonly number: string;
  readonly label: string;
  readonly part: string;
  readonly roles: readonly string[];
  readonly note?: string | undefined;
}

export interface TaxFormChoice {
  readonly id: string;
  /** For example "Schedule C (Form 1040)". */
  readonly name: string;
  readonly taxYear: number;
  /** "draft" is an IRS early-release draft, not the form that is filed. */
  readonly status: "final" | "draft";
  readonly lines: readonly TaxLineChoice[];
}

export interface TemplateChoice {
  readonly id: string;
  readonly name: string;
}

export interface AddOnChoice {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export type Currency = "USD" | "EUR" | "GBP";
export type Basis = "cash" | "accrual";
export type PeriodModel = "monthly" | "quarterly";

/** What the first three steps decide. */
export interface SetupChoices {
  name: string;
  currency: Currency;
  /** The calendar year in which the first fiscal year starts. */
  firstYear: number;
  /** 1 to 12. */
  startMonth: number;
  periodModel: PeriodModel;
  basis: Basis;
  templateId: string;
  addOns: readonly string[];
}

/** A chart built for a set of choices. */
export interface BuiltChart {
  readonly accounts: readonly ChartAccount[];
  readonly taxForms: readonly TaxFormChoice[];
  /** The year the tax lines were resolved for; null for a chart with no tax lines. */
  readonly taxYear: number | null;
  readonly notes: readonly string[];
  /** The not-tax-advice notice. Empty for a chart with no tax lines. */
  readonly disclaimer: string;
}

/** What `book.setup` takes. */
export interface SetupDocument {
  readonly name: string;
  readonly currency: Currency;
  /** The first fiscal year of the calendar, not the day the books begin (`booksStartOn`). */
  readonly fiscalYear: number;
  readonly fiscalYearStartMonth: number;
  /** The first day of the books, `YYYY-MM-DD`. */
  readonly booksStartOn: string;
  readonly periodModel: PeriodModel;
  readonly basis: Basis;
  readonly accounts: readonly {
    readonly code: string;
    readonly name: string;
    readonly role: ChartRole;
    readonly tags?: {
      readonly cashFlowClass?: CashFlowClass;
      readonly taxLine?: string;
      readonly roleKey?: string;
      readonly kind?: SlotKind;
    };
  }[];
}

/** A problem a person can fix: where it is (an element id) and what to do. */
export interface ChartProblem {
  readonly id: string;
  readonly message: string;
  /** A few words for beside the field itself, where the full message would not fit. */
  readonly short?: string;
}

/** One account as the Accounts screen shows it: the application's row, with the tags in force. */
export interface AccountView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  /** Any kernel account type; only asset, liability and equity are balance-sheet types. */
  readonly role: string;
  readonly parentCode: string | null;
  readonly openedOn: string;
  readonly closedOn: string | null;
  /** A signed decimal string with exactly two places. Never converted to a number. */
  readonly balance: string;
  readonly tags: ChartTags;
}

/** One recorded change to an account's tags. */
export interface TagEvent {
  readonly tag: "cashFlowClass" | "taxLine" | "roleKey";
  readonly effectiveOn: string;
  /** null means the tag was cleared from that date. */
  readonly value: string | null;
  readonly source: "setup" | "change";
  readonly recordedAt: string;
}

export interface ClosedPeriod {
  readonly label: string;
  readonly startsOn: string;
  readonly endsOn: string;
}

/** What the tag editor sends: each tag is a value, or null to clear it. A tag that is left out is
 * untouched. */
export interface TagChange {
  readonly effectiveOn: string;
  readonly tags: {
    readonly cashFlowClass?: CashFlowClass | null;
    readonly taxLine?: string | null;
    readonly roleKey?: string | null;
  };
}

/** What the service said about a change that was saved. */
export interface TagResult {
  readonly changed: boolean;
  readonly effectiveOn: string;
  readonly warnings: readonly string[];
}

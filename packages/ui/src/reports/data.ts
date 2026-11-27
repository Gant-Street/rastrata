/** The shapes the report views read. They are the fields of the service's report operations that the
 * views use, written structurally so this package does not depend on the application: a service
 * result is passed in as it is, and the web application's type check proves each result still fits
 * (a changed contract fails to compile there, not silently on screen). Money is always a decimal
 * string and is never turned into a number. */

export interface FiscalYearData {
  readonly year: number;
  readonly startsOn: string;
  readonly endsOn: string;
}

export interface ComparisonData {
  readonly kind: "previousPeriod" | "previousYear";
  readonly periodStart: string;
  readonly asOf: string;
  readonly populationHash: string;
}

export interface WarningData {
  readonly code: string;
  readonly message: string;
}

/** What every statement says about the population it was built from. */
export interface ScopeData {
  readonly asOf: string;
  readonly periodStart: string;
  readonly currency: string;
  readonly basis: "cash" | "accrual";
  readonly fiscalYear: FiscalYearData;
  readonly bookRevision: string;
  readonly populationHash: string;
}

export interface StatementRowData {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly role: string;
  readonly amount: string;
  readonly comparative?: string | undefined;
  readonly change?: string | undefined;
  /** The share of the period's total income, when the profit and loss was read with shares: text with one
   * decimal ("30.2"). Absent where the period had no income to take a share of. */
  readonly share?: string | undefined;
  /** The same for the comparison period, against that period's own income. */
  readonly comparativeShare?: string | undefined;
}

export interface StatementTotalData {
  readonly key: string;
  readonly label: string;
  readonly amount: string;
  readonly comparative?: string | undefined;
  readonly change?: string | undefined;
  readonly share?: string | undefined;
  readonly comparativeShare?: string | undefined;
}

export interface CoreReportsData extends ScopeData {
  readonly comparison: ComparisonData | null;
  readonly warnings: readonly WarningData[];
  readonly trialBalance: {
    readonly rows: readonly {
      readonly accountId: string;
      readonly code: string;
      readonly name: string;
      readonly role: string;
      readonly signedBalance: string;
      readonly debit: string;
      readonly credit: string;
    }[];
    readonly debit: string;
    readonly credit: string;
    readonly balanced: boolean;
    readonly fiscalYearStart: string;
    readonly retainedEarnings: null | {
      readonly label: string;
      readonly signedBalance: string;
      readonly debit: string;
      readonly credit: string;
    };
  };
  readonly profitAndLoss: {
    readonly rows: readonly StatementRowData[];
    readonly revenue: string;
    readonly expenses: string;
    readonly netIncome: string;
    readonly totals: readonly StatementTotalData[];
  };
  readonly balanceSheet: {
    readonly rows: readonly StatementRowData[];
    readonly assets: string;
    readonly liabilities: string;
    readonly equity: string;
    readonly currentEarnings: string;
    readonly priorEarnings: string;
    readonly contributedEquity: string;
    readonly difference: string;
    readonly balanced: boolean;
    readonly totals: readonly StatementTotalData[];
  };
}

export interface CashFlowLineData {
  readonly key: string;
  readonly group: "netIncome" | "nonCash" | "workingCapital" | "account";
  readonly label: string;
  readonly code: string | null;
  readonly accountId: string | null;
  readonly amount: string;
  readonly comparative?: string | undefined;
  readonly change?: string | undefined;
}

export interface CashFlowData extends ScopeData {
  /** The hash of the ledger population the statement is built from: what drill-through verifies
   * (`populationHash` also covers the account tags). */
  readonly ledgerPopulationHash: string;
  readonly comparison: ComparisonData | null;
  readonly warnings: readonly WarningData[];
  readonly available: boolean;
  readonly reason: string | null;
  readonly tagsRevision: string;
  readonly sections: readonly {
    readonly key: "operating" | "investing" | "financing" | "unclassified";
    readonly label: string;
    readonly lines: readonly CashFlowLineData[];
    readonly total: string;
    readonly comparative?: string | undefined;
    readonly change?: string | undefined;
  }[];
  readonly cashAccounts: readonly {
    readonly accountId: string;
    readonly code: string;
    readonly name: string;
    readonly opening: string;
    readonly closing: string;
    readonly change: string;
  }[];
  readonly openingCash: string | null;
  readonly netChange: string | null;
  readonly closingCash: string | null;
  readonly totals: readonly StatementTotalData[];
}

export interface GeneralLedgerData extends ScopeData {
  readonly accounts: readonly {
    readonly accountId: string;
    readonly code: string;
    readonly name: string;
    readonly balanceKind: "cumulative" | "fiscalYearToDate";
    readonly openingBalance: string;
    readonly totalDebit: string;
    readonly totalCredit: string;
    readonly closingBalance: string;
    readonly lineCount: number;
  }[];
  readonly count: number;
  readonly page: number;
  readonly pageSize: number;
  readonly lines: readonly {
    readonly accountId: string;
    readonly journalId: string;
    readonly postingId: string;
    readonly date: string;
    readonly narration: string;
    /** The entry's number in the book ("No. 23"): what a line is called on screen. */
    readonly postingSequence?: string | undefined;
    readonly debit: string;
    readonly credit: string;
    readonly runningBalance: string;
  }[];
}

export interface AccountActivityData {
  readonly account: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly role: string;
    readonly normalSide: "debit" | "credit";
  };
  readonly currency: string;
  readonly basis: "cash" | "accrual";
  readonly asOf: string;
  readonly from: string;
  readonly to: string;
  readonly reportFrom: string;
  readonly revision: string;
  readonly populationHash: string;
  readonly balanceKind: "cumulative" | "fiscalYearToDate";
  readonly openingBalance: string;
  readonly closingBalance: string;
  readonly totalDebit: string;
  readonly totalCredit: string;
  readonly netChange: string;
  readonly count: number;
  readonly page: number;
  readonly pageSize: number;
  readonly rows: readonly {
    readonly journalId: string;
    readonly postingId: string;
    readonly date: string;
    readonly narration: string;
    readonly debit: string;
    readonly credit: string;
    readonly runningBalance: string;
  }[];
}

/** One month of a by-month report: the dates it covers (the range's own at either end, when the range
 * starts or ends inside a month) and the report the service made for exactly those dates. */
export interface MonthColumn<T> {
  /** "2026-03". */
  readonly month: string;
  readonly from: string;
  readonly to: string;
  /** True when the range covers only part of the month. */
  readonly partial: boolean;
  /** True when `to` is the month's last day. */
  readonly endsMonth: boolean;
  readonly data: T;
}

/** A report by month: one read for the whole range and one for each month in it, all of them read at
 * the same book revision, so the columns and the total agree to the cent. */
export interface MonthlyReports<T> {
  readonly total: T;
  readonly months: readonly MonthColumn<T>[];
}

/** Where an amount links to. The application owns its addresses; the views only ask. `span` says
 * which dates the activity covers: the report's own range, or the whole fiscal year to the as-of
 * date (what a balance carried forward is made of). `column` picks the current period or the
 * comparison period. */
export interface ReportHrefs {
  account(
    accountId: string,
    span: "range" | "fiscalYear",
    column: "current" | "comparison",
  ): string;
  entry?(journalId: string): string;
  /** Where to tag accounts, when the application has such a screen. */
  tagAccounts?: string | undefined;
}

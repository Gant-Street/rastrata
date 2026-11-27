/** What the calendar components show. Plain data: the app turns the service's answers into these, so
 * the components never read a response and a story never needs a service. Money is an exact decimal
 * string and is only ever displayed; dates are `YYYY-MM-DD`. */

export type YearStatus = "open" | "partlyClosed" | "closed";

/** One period of the fiscal year being looked at. */
export interface PeriodView {
  readonly id: string;
  readonly label: string;
  readonly startsOn: string;
  readonly endsOn: string;
  /** "closed" means locked: nothing can be posted into the period. */
  readonly status: "open" | "closed";
  /** Locked, but its close was superseded when an earlier period was reopened. */
  readonly closeSuperseded: boolean;
  /** The period's last day is before today. */
  readonly ended: boolean;
  /** Where to read the report the close recorded; null when there is no current close. */
  readonly closingReportHref: string | null;
  readonly closingRevision: string | null;
  /** The other periods whose closes reopening this one would supersede, named for a person
   * ("March 2028"). They stay locked. */
  readonly supersedes: readonly string[];
  /** The period ends before the day the books began: it holds none of the books' own activity and is
   * not counted as open anywhere. */
  readonly beforeBooks: boolean;
  /** Nothing is recorded in the period: no entry and no bank transaction is dated in it. */
  readonly empty: boolean;
}

/** One fiscal year in the picker. */
export interface FiscalYearView {
  readonly fiscalYear: number;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly periodCount: number;
  readonly closedCount: number;
  readonly supersededCount: number;
  readonly status: YearStatus;
  readonly ended: boolean;
  /** Every period of the year ends before the books began: nothing in it needs closing. */
  readonly beforeBooks: boolean;
  /** How many periods of the year end before the books began; the counts above leave them out. */
  readonly periodsBeforeBooks: number;
}

/** The calendar as a whole: what it covers. It grows itself when a posting needs a later year, so the
 * screens have nothing to say about extending it. */
export interface CalendarView {
  readonly firstDate: string;
  readonly lastDate: string;
  readonly fiscalYearStartMonth: number;
  readonly today: string;
  /** The day the books began (the recorded cutover date), or null when none is recorded. */
  readonly booksBegan: string | null;
}

export type ChecklistState = "ready" | "attention" | "unavailable" | "loading";

/** One line of the year-end checklist: a fact the books or another part of the product can state. */
export interface ChecklistItem {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly state: ChecklistState;
  /** Where to look or fix it, when there is somewhere to go. */
  readonly href?: string;
  readonly hrefLabel?: string;
}

/** The year's figures at its last day, as strings the books produced. */
export interface StatementsView {
  readonly currency: string;
  readonly basis: "cash" | "accrual";
  readonly asOf: string;
  readonly periodStart: string;
  readonly revenue: string;
  readonly expenses: string;
  readonly netIncome: string;
  readonly assets: string;
  readonly liabilities: string;
  readonly equity: string;
  readonly priorEarnings: string;
  readonly reportHref: string;
}

/** One command of a prepared year-end: a close, or the reopening before it. */
export interface YearEndCommandView {
  readonly kind: "close" | "reopen";
  readonly valid: boolean;
  readonly warnings: readonly string[];
  readonly problems: readonly string[];
}

export interface YearEndStepView {
  readonly order: number;
  readonly label: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status: "open" | "closed";
  readonly closeSuperseded: boolean;
  /** Empty for a period that already has a current close. */
  readonly commands: readonly YearEndCommandView[];
}

export interface YearEndPlanView {
  readonly fiscalYear: number;
  readonly valid: boolean;
  /** The periods the plan closes. */
  readonly closes: number;
  readonly superseded: number;
  readonly reason: string;
  readonly problems: readonly string[];
  readonly steps: readonly YearEndStepView[];
}

export interface YearEndReceiptView {
  readonly disposition: "committed" | "rejected";
  readonly closed: number;
  readonly total: number;
  readonly message: string;
}

/** Where the guided year-end is. */
export type YearEndStage =
  /** The checklist is being read. */
  | "checking"
  /** The person is choosing a reason. */
  | "reason"
  /** The plan is being prepared. */
  | "preparing"
  /** The plan is on screen, waiting for a decision. */
  | "plan"
  /** The commit has been sent. */
  | "committing"
  /** The commit finished (see the receipt). */
  | "done";

/** A write that was sent and not answered. It must be resumed with the same identity, never redone. */
export type Uncertain = boolean;

/** The facts of a prepared close or reopening that the review shows. The app reads them from the
 * plan the service prepared; nothing here is computed in the browser. */
export interface ChangePlanView {
  readonly bookRevision: string;
  readonly valid: boolean;
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
  /** For a reopening: the later periods whose closes it supersedes, named for a person. */
  readonly supersedes: readonly string[];
  /** Where to read the report the close will record, when there is one. */
  readonly reportHref?: string | undefined;
}

export type ChangeStage = "compose" | "preparing" | "review";

/** One close or reopening in the book's history. */
export interface HistoryEntry {
  readonly periodLabel: string;
  readonly kind: "close" | "reopen";
  readonly recordedAt: string;
  readonly bookRevision: string;
  readonly reason: string;
  /** The other periods whose closes this reopening superseded, named for a person. */
  readonly superseded: readonly string[];
}

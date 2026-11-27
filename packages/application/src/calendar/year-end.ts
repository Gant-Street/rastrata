import { hashCanonical } from "@rastrata/kernel";
import type { PeriodView } from "./periods.ts";

/** Pure parts of the year-end close: identities, wording and the checklist. The orchestration, which
 * needs the service, is in slices/calendar/year-end.ts. */

/** The action identity of one command of a year-end request: the close of one period, or the
 * reopening that comes before it when the period's close was superseded. It is a function of the
 * request identity, the period and the kind, so the same request always means the same commands:
 * asking again after an interruption finds the commands already retained instead of making new ones.
 * The result is a name-based UUID (version 5 layout) because every identity in the application is a
 * UUID. */
export function yearEndStepId(
  yearEndId: string,
  periodId: string,
  kind: "close" | "reopen" = "close",
): string {
  const hex = hashCanonical({
    type: "CalendarYearEndStep",
    yearEnd: yearEndId,
    periodId,
    ...(kind === "close" ? {} : { kind }),
  }).digest;
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The reason recorded on one period's close: what the person wrote, framed so the period history
 * shows the close belongs to a year-end and which period it was. */
export function yearEndStepReason(fiscalYear: number, label: string, reason: string): string {
  return `Year end FY${fiscalYear}, ${label}: ${reason.trim()}`;
}

/** The reason recorded on the reopening that comes before closing a period again. */
export function yearEndReopenReason(fiscalYear: number, label: string, reason: string): string {
  return `Reopened to close again, year end FY${fiscalYear}, ${label}: ${reason.trim()}`;
}

export interface YearEndCheck {
  readonly id: string;
  readonly label: string;
  readonly status: "pass" | "attention";
  readonly detail: string;
}

export interface YearEndFacts {
  readonly fiscalYear: number;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly today: string;
  /** The periods this year-end will close, in order: open ones and locked ones whose close was
   * superseded. */
  readonly open: readonly PeriodView[];
  /** Periods of earlier fiscal years that are open or whose close was superseded, leaving out the
   * ones before the books began. */
  readonly earlierOpen: readonly PeriodView[];
  /** Periods of this year that end before the books began, and the day the books began. They are
   * closed with the rest and never counted as open. */
  readonly beforeBooks: readonly PeriodView[];
  readonly booksBegan: string | null;
  /** Drafts dated inside the fiscal year that are not posted. */
  readonly drafts: number;
  readonly currency: string;
  readonly debit: string;
  readonly credit: string;
  readonly balanced: boolean;
  readonly revenue: string;
  readonly expenses: string;
  readonly netIncome: string;
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** What the person should know before closing the year. Every item is a fact the book can state; none
 * blocks the close (the kernel's own rules do that), and none claims more than it checked. Checks that
 * depend on other parts of the product (reconciliation, the inbox) are made by the screen or the agent
 * through those parts' own operations; the plan's per-period warnings carry what reconciliation says. */
export function yearEndChecks(facts: YearEndFacts): YearEndCheck[] {
  const checks: YearEndCheck[] = [];
  checks.push({
    id: "trial-balance",
    label: "The trial balance balances",
    status: facts.balanced ? "pass" : "attention",
    detail: facts.balanced
      ? `Debits and credits are both ${facts.debit} ${facts.currency} as of ${facts.endsOn}.`
      : `Debits are ${facts.debit} and credits are ${facts.credit} ${facts.currency}. They should be equal; do not close until they are.`,
  });
  checks.push({
    id: "profit-loss",
    label: `Profit and loss for fiscal year ${facts.fiscalYear}`,
    status: "pass",
    detail: `Income ${facts.revenue}, expenses ${facts.expenses}, net income ${facts.netIncome} ${facts.currency}. These carry into the next year by computation: closing posts no entries and moves no balances.`,
  });
  const notEnded = facts.open.filter((period) => !period.ended);
  checks.push({
    id: "periods-ended",
    label: "Every period has ended",
    status: notEnded.length === 0 ? "pass" : "attention",
    detail:
      notEnded.length === 0
        ? `The last day of the year, ${facts.endsOn}, is before today (${facts.today}).`
        : `${notEnded.length} of the ${facts.open.length} ${plural(facts.open.length, "period", "periods")} to close ${plural(notEnded.length, "has", "have")} not ended; the year runs to ${facts.endsOn} and today is ${facts.today}. Closing a period stops new postings dated in it.`,
  });
  const superseded = facts.open.filter((period) => period.closeSuperseded);
  checks.push({
    id: "closes-current",
    label: "Every close is current",
    status: superseded.length === 0 ? "pass" : "attention",
    detail:
      superseded.length === 0
        ? "No close of this year was superseded by reopening an earlier period."
        : `${superseded.length} ${plural(superseded.length, "period of this year was", "periods of this year were")} closed before an earlier period was reopened, so ${plural(superseded.length, "its recorded close no longer matches", "their recorded closes no longer match")} the books. ${plural(superseded.length, "It is", "They are")} still locked. This year-end reopens and closes ${plural(superseded.length, "it", "each")} again.`,
  });
  const earliest = facts.earlierOpen[0];
  checks.push({
    id: "earlier-years",
    label: "Earlier years are closed",
    status: earliest ? "attention" : "pass",
    detail: earliest
      ? `${facts.earlierOpen.length} ${plural(facts.earlierOpen.length, "period", "periods")} of earlier fiscal years ${plural(facts.earlierOpen.length, "is", "are")} still open or ${plural(facts.earlierOpen.length, "needs", "need")} closing again, the oldest ${earliest.label} (${earliest.startsOn} to ${earliest.endsOn}). Closing this year first leaves a gap in the locked books.`
      : "Every period of an earlier fiscal year has a current close.",
  });
  if (facts.beforeBooks.length > 0 && facts.booksBegan !== null)
    checks.push({
      id: "before-books",
      label: "Periods before the books began",
      status: "pass",
      detail: `${facts.beforeBooks.map((period) => `${period.label} ${period.startsOn.slice(0, 4)}`).join(", ")} ${plural(facts.beforeBooks.length, "ends", "end")} before the books began on ${facts.booksBegan}, the cutover date. ${plural(facts.beforeBooks.length, "It holds", "They hold")} none of the books' own activity, so ${plural(facts.beforeBooks.length, "it is", "they are")} not counted as open, and the year-end closes ${plural(facts.beforeBooks.length, "it", "them")} with the rest.`,
    });
  checks.push({
    id: "drafts",
    label: "No unposted drafts dated in the year",
    status: facts.drafts === 0 ? "pass" : "attention",
    detail:
      facts.drafts === 0
        ? "Every journal dated in this year is posted or discarded."
        : `${facts.drafts} unposted ${plural(facts.drafts, "draft is", "drafts are")} dated in fiscal year ${facts.fiscalYear}. Drafts are not in the books, so they are not in these statements, and they cannot be posted into a closed period.`,
  });
  return checks;
}

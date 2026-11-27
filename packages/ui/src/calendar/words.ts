/** Every word the calendar components own, in one place, in plain terms: say what happened and what
 * to do next, and never claim an outcome that is not confirmed. Data (period labels, dates, amounts,
 * reasons a person typed) is never in this file. */
import { formatDate, formatDateRange, monthName } from "../format";

export { monthName };

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

export const words = {
  // Page
  eyebrow: "Accounting",
  title: "Close the books",
  lead: "Closing a period stops new postings dated in it. It posts no entries and moves no balances: each year's earnings carry forward by computation. Reopening a period lets you correct it. Rastrata books and reports; it does not give tax advice.",
  loading: "Loading periods…",
  failedTitle: "Periods unavailable",
  requestFailedTitle: "The request did not go through",
  failedBody:
    "The periods could not be read, so nothing here is current. Your books have not been changed. Try again.",
  retry: "Try again",
  staleTitle: "The periods could not be read again",
  staleBody:
    "What you see is from the last successful read and may be out of date. Your books have not been changed.",
  noBookTitle: "No book connected",
  noBookBody: "Set up a book first.",

  // Calendar
  calendar: "Calendar",
  coverage: (first: string, last: string) => `Covers ${formatDateRange(first, last)}.`,
  /** The calendar grows itself: an entry dated after its last day adds the years it needs. */
  grows: "Later years are added as your entries need them.",
  /** Said only for a year that does not start in January: January is what everyone expects. */
  yearStarts: (month: number) =>
    month === 1
      ? ""
      : `Each fiscal year starts in ${monthName(month)}, and is named by the year it starts in.`,

  // Year
  fiscalYear: "Fiscal year",
  yearOption: (year: number, status: string) => `Fiscal year ${year} · ${status}`,
  yearTitle: (year: number) => `Fiscal year ${year}`,
  yearDates: (starts: string, ends: string) => formatDateRange(starts, ends),
  status: { open: "Open", partlyClosed: "Partly closed", closed: "Closed" },
  progress: (closed: number, total: number) =>
    `${closed} of ${total} ${plural(total, "period", "periods")} closed`,
  supersededCount: (count: number) =>
    `${count} ${plural(count, "close was", "closes were")} superseded by a reopening and ${plural(count, "needs", "need")} closing again. Close the year again to do it in order, or reopen and close each period.`,
  /** The button names the year: it sits under a fold called "Close the year", and opens the page of this
   * name. */
  closeYear: (year: number) => `Close fiscal year ${year}`,
  closeYearAgain: (year: number) => `Close fiscal year ${year} again`,
  nothingToClose: "Every period of this year has a current close.",
  beforeBooksNote: (count: number, began: string | null) =>
    `${count} ${plural(count, "period ends", "periods end")} before the books began${began ? ` on ${formatDate(began)}` : ""}. Closing the year closes ${plural(count, "it", "them")} with the rest.`,
  yearBeforeBooks: (began: string | null) =>
    `This year ended before the books began${began ? ` on ${formatDate(began)}` : ""}. Nothing in it needs closing.`,
  /** Said instead of the button until the year's last day has passed. */
  yearEnds: (date: string) => `This year ends on ${formatDate(date)}.`,

  // Table
  periodsOf: (year: number) => `Periods of fiscal year ${year}`,
  period: "Period",
  state: "Status",
  closing: "Closing",
  action: "Action",
  open: "Open",
  closed: "Closed",
  superseded: "Closed, close superseded",
  ended: "Ended",
  notEnded: "Not ended",
  beforeBooks: "Before the books began",
  /** The row's buttons say what they do; each one's name for assistive technology says which period ("Review October close"). */
  closeShort: "Close",
  reopenShort: "Reopen",
  reviewClose: (label: string) => `Review ${label} close`,
  reviewReopen: (label: string) => `Review ${label} reopening`,
  closingReport: "Review closing report",
  supersededNote: "Locked, but the figures recorded when it closed no longer match the books.",
  noPeriods: "This fiscal year has no periods.",

  // Change review (one period)
  changeReview: "Change review",
  reviewTitle: "Review change",
  reasonForChange: "Reason for change",
  reasonHint: "Kept in the book's history with the change.",
  reasonRequired: "Say why you are making this change.",
  reasonLong: "Use at most 500 characters.",
  changeClose: (label: string) => `Close ${label}`,
  changeReopen: (label: string) => `Reopen ${label}`,
  closeEffect:
    "Closing stops new postings and corrections dated in this period until it is reopened. It posts no entries and moves no balances.",
  reopenEffect:
    "Reopening lets you post and correct entries dated in this period. It posts no entries and moves no balances.",
  supersedesTitle: (count: number) =>
    `Reopening this period supersedes the ${plural(count, "close", "closes")} of ${count} later ${plural(count, "period", "periods")}`,
  supersedesBody: (count: number) =>
    `${plural(count, "That period stays", "Those periods stay")} locked, but ${plural(count, "its recorded close no longer matches", "their recorded closes no longer match")} the books once you correct this one. Close ${plural(count, "it", "them")} again afterwards: the year-end does that in order.`,
  preparingReview: "Preparing the review…",
  warningsTitle: "Check before you commit",
  invalidTitle: "This change cannot be made",
  commitChange: "Commit period change",
  cancel: "Cancel",
  inputsChanged: "Inputs changed. Review a new plan before committing.",
  recorded: "Period change recorded in the book history.",
  recordedAfterResume: "The original request went through and is recorded in the book.",

  // Year-end flow
  yearEndTitle: (year: number) => `Close fiscal year ${year}`,
  yearEndLead: (count: number | null) =>
    count === null
      ? "This closes the periods of the year that still need it, in order. Each close is checked on its own. Nothing is posted and no balance moves."
      : `This closes ${count} ${plural(count, "period", "periods")} in order. Each close is checked on its own. Nothing is posted and no balance moves.`,
  nothingToCloseTitle: "Nothing to close",
  yearEndNothing:
    "Every period of this year already has a current close, so there is nothing to close.",
  steps: ["Check the books", "Say why", "Review and close"],
  stepsLabel: "Close the year, in three steps",
  stepDone: "done",
  back: "Back to the periods",
  checklist: "Before you close",
  checklistLead:
    "Each item is a fact the books or another part of Rastrata can state. None of them blocks the close: you decide.",
  checking: "Checking…",
  ready: "Ready",
  attention: "Needs attention",
  unavailable: "Could not be read",
  unavailableNote: "This could not be checked, so it is not assumed to be fine.",
  statements: "The year's figures",
  statementsLead: (basis: string, asOf: string) =>
    `As of ${formatDate(asOf)}, on the ${basis} basis. They do not change when you close.`,
  income: "Income",
  expenses: "Expenses",
  netIncome: "Net income",
  assets: "Assets",
  liabilities: "Liabilities",
  equity: "Equity",
  priorEarnings: "Earnings of earlier years",
  reviewStatements: "Review the year's statements",
  yearEndReason: "Reason for closing the year",
  yearEndReasonHint:
    "One reason for the whole year. Kept in the history of every period it closes.",
  yearEndReasonRequired: "Say why you are closing the year.",
  yearEndReasonLong: "Use at most 400 characters.",
  reviewYearEnd: "Review the year-end",
  preparing: "Preparing the year-end…",
  planTitle: "The year-end, in order",
  planLead: (closes: number) =>
    `${closes} ${plural(closes, "period closes", "periods close")}. Review it, then close the year.`,
  planReopen: (count: number) =>
    `${count} ${plural(count, "period was", "periods were")} closed before an earlier reopening, so ${plural(count, "it is", "they are")} reopened first and closed again.`,
  stepClose: "Close",
  stepReopenClose: "Reopen, then close",
  stepKeep: "Already closed",
  stepColumn: "Period",
  commandColumn: "What happens",
  warningsColumn: "Notes",
  noNotes: "None",
  noteCount: (count: number) => `${count} ${plural(count, "note", "notes")}`,
  planNotes: (count: number) =>
    `${count} ${plural(count, "period has", "periods have")} notes from the books or from other parts of Rastrata. Open a row's notes to read them before you close. None of them blocks the close.`,
  planInvalid: "This plan cannot be committed",
  confirmClose: (year: number) => `Close fiscal year ${year}`,
  committing: "Closing the periods in order…",
  doneTitle: (year: number) => `Fiscal year ${year} is closed`,
  doneBody: (closed: number) =>
    `${closed} ${plural(closed, "period", "periods")} closed, each with its own record of the figures at that moment.`,
  partialTitle: "The year was not closed completely",
  partialBody: (closed: number, total: number) =>
    `${closed} of ${total} ${plural(total, "period", "periods")} closed before the book rejected the next. The periods that closed stay closed. Review the year again to see what is left.`,
  reviewAgain: "Review the year again",
  retained: "An original request is retained. Resume it before making another change.",
  resume: "Resume original request",
  retainedBody:
    "A change was sent and no answer arrived. Resume the original request: it is sent again with the same identity, so it cannot be applied twice. Do not make the change again to find out.",
  yearEndWaiting:
    "A year-end request was sent and no answer arrived. Resume it before changing anything else.",
  yearEndOpenRetained: "Open the year-end",
  uncertainTitle: "The result is uncertain",
  uncertainBody:
    "The request was sent and no answer arrived. Resume it with the same identity; never start a new year-end to find out.",
} as const;

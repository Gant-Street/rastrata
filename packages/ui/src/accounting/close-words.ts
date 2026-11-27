/** Every word the Close the books page says, in the product's vocabulary. Data (dates, month names,
 * account names, amounts) is never in this file.
 *
 * A book's periods are months or quarters. The sentences that name the kind of period take it (`unit`, a
 * month unless it is told otherwise), so a quarterly book never reads "month". */

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** What a book's periods are called: "month" or "quarter". */
export type PeriodUnit = "month" | "quarter";
export const unitOf = (model: "monthly" | "quarterly" | undefined): PeriodUnit =>
  model === "quarterly" ? "quarter" : "month";

export const closeWords = {
  title: "Close the books",
  closedThrough: (date: string) => `Books are closed through ${date}.`,
  /** Said while nothing is closed, with what closing is: the one time a person needs telling. */
  nothingClosed: "Nothing is closed yet.",
  nothingToClose: "Nothing to close yet.",
  explanation: (unit: PeriodUnit = "month") =>
    `Closing a ${unit} stops new entries dated in it. You can reopen it.`,
  checking: "Checking…",
  checkFailed: (unit: PeriodUnit = "month") =>
    `This ${unit} could not be checked, so nothing here is current. Your books have not been changed.`,
  retry: "Try again",
  loading: (unit: PeriodUnit = "month") => `Loading the ${unit}s…`,
  noBookTitle: "No book connected",
  noBookBody: "Set up a book first.",
  failedTitle: "Closing the books is unavailable",
  failedBody: (unit: PeriodUnit = "month") =>
    `The ${unit}s could not be read, so nothing here is current. Your books have not been changed. Try again.`,

  /** The card: the months that can be closed now, named by the last of them. */
  through: (label: string) => `Through ${label}`,
  closeThrough: (label: string) => `Close through ${label}`,
  /** For a person who may not close: said in place of the button. */
  ownerCloses: "An owner or an administrator of the workspace closes the books.",
  /** What does not stand in the way and is worth a look: "2 things to look at first". */
  look: (count: number) => `${count} ${plural(count, "thing", "things")} to look at first`,

  /** What is left before the books can be closed through a month: one sentence a line, in the words Home
   * uses, each with the one place that deals with it. */
  left: {
    review: (count: number) =>
      `${count} ${plural(count, "transaction", "transactions")} to review.`,
    reviewAction: "Review",
    reviewName: "Review transactions",
    reconcile: (account: string, date: string) => `${account} is not reconciled through ${date}.`,
    reconcileAction: "Reconcile",
    reconcileName: (account: string) => `Reconcile ${account}`,
    opening: "Your opening balances are not posted.",
    openingAction: "Post opening balances",
    stripeNotCompared: "Stripe's balance has not been compared with your books.",
    stripeDiffers: "Stripe holds money that is not in your books.",
    stripeAction: "Open Stripe",
    payouts: (count: number) =>
      `${count} ${plural(count, "Stripe payout does", "Stripe payouts do")} not add up.`,
    payoutsAction: "Look at payouts",
    backupNever: "No backup of your books has been checked yet.",
    backupOld: (date: string) => `Your last checked backup was on ${date}.`,
    backupDrill: "The last restore drill failed.",
    backupAction: "Back up now",
    backupsAction: "Open backups",
  },

  /** Closing and reopening (the reason is kept with each month, for you and your accountant). */
  closing: {
    working: (label: string) => `Closing through ${label}…`,
    reasonPrefill: (label: string) => `${label} reviewed`,
    done: (label: string) => `${label} is closed.`,
    /** A run closed together: "January to September 2026 are closed." */
    doneRun: (range: string) => `${range} are closed.`,
    /** A run that stopped: which month would not close, and that the ones before it stayed closed. */
    stoppedAt: (label: string, closed: string | null) =>
      closed ? `${label} was not closed. ${closed} stayed closed.` : `${label} was not closed.`,
    reopened: (label: string) => `${label} is open again.`,
  },

  /** Periods that are closed. */
  closedMonths: {
    title: (count: number, unit: PeriodUnit = "month") => `Closed ${unit}s (${count})`,
    /** Beside the fold while it is shut, when a close needs making again. */
    stale: (count: number) =>
      `${count} ${plural(count, "close no longer matches", "closes no longer match")} the books`,
    reopen: "Reopen",
    reopenNamed: (label: string) => `Reopen ${label}`,
    superseded: "Its close no longer matches the books",
    closeAgainHint: "Close the fiscal year again to put it right.",
    report: "Closing report",
  },

  /** The fiscal year, a fold until it has ended. */
  year: {
    title: "Close the year",
    ends: (year: number, date: string) => `Fiscal year ${year} ends ${date}`,
    ended: (year: number) => `Fiscal year ${year} has ended`,
    closed: (year: number) => `Fiscal year ${year} is closed`,
  },

  /** The calendar and what changed. */
  calendar: {
    title: "Calendar and history",
  },
};

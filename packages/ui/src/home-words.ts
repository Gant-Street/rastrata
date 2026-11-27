/** The words of the Home screen: the start of a new book, "Needs you", "Money in and out" and the accounts. One file, in the
 * plan's vocabulary (transactions, review, Close the books), so a wording change is one edit and the
 * glossary test reads it. Names, figures and dates are data and are never in this file: the callers
 * pass them through the formatter. */

const count = (value: number, one: string, many: string): string =>
  `${value} ${value === 1 ? one : many}`;

export const homeWords = {
  title: "Today",

  /** The page before its book is read: still opening, or it could not be. */
  book: {
    opening: "Opening your book…",
    unavailable: "Book unavailable",
    unreadable: "The book could not be read.",
    retry: "Try again",
    /** A person who may not set the books up (an accountant, a member) comes to a workspace whose books are not set up yet. */
    notSetUp: "The books are not set up yet",
    notSetUpBody: "An owner of this workspace sets them up first. Once they have, they are here.",
  },

  /** A new book, with nothing in it yet: the one thing to do, and two quiet lines under it. */
  start: {
    /** Where a bank can be connected: connecting is the way in, and a statement file is the other. */
    connect: {
      title: "Add your bank to start",
      text: "Its transactions come in for you to review.",
      action: "Connect a bank",
      alt: "Import a statement",
    },
    /** Where none can: the statement file is the way in. */
    statement: {
      title: "Import a statement to start",
      text: "Its transactions come in for you to review.",
      action: "Import a statement",
    },
    /** For a person moving from another system, until their history or their opening balances are in. */
    mover: {
      text: "Moving from another system",
      action: "Bring in your books",
    },
    agent: {
      text: "For the agent you already use",
      action: "Connect an agent",
    },
  },

  /** "Needs you": at most five rows, each one sentence and one verb. */
  needs: {
    heading: "Needs you",
    listLabel: "Things that need you",
    checking: "Checking…",
    /** Every check was read and none found anything. */
    none: "Nothing needs you right now.",
    /** A new book has nothing to check yet, and is not a list of warnings. */
    noneYet: "Nothing needs you yet.",
    more: (hidden: number): string => `${count(hidden, "more thing", "more things")} after these.`,
    /** A check that could not be read says so; it never reads as "nothing". */
    unread: (names: readonly string[]): string => {
      const joined =
        names.length <= 1
          ? (names[0] ?? "")
          : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
      return `${joined.charAt(0).toUpperCase()}${joined.slice(1)} could not be checked.`;
    },
    unreadVerb: "Try again",
    /** What each check is called when it could not be read. */
    sources: {
      all: "what needs you",
      inbox: "transactions to review",
      backup: "backups",
      periods: "the books' calendar",
      checklist: "what stands in the way of closing a month",
      stripe: "Stripe",
      bankfeed: "the bank connection",
      tokens: "the agents",
      changes: "what changed",
    },

    review: {
      text: (toReview: number, readyToPost: number): string => {
        if (toReview === 0)
          return `${count(readyToPost, "transaction is", "transactions are")} ready to post.`;
        const first = `${count(toReview, "transaction", "transactions")} to review.`;
        return readyToPost > 0 ? `${first} ${readyToPost} ready to post.` : first;
      },
      reviewVerb: "Review",
      postVerb: "Post",
    },

    /** An account whose transactions are all decided, and whose month has ended: it can be checked
     * against the bank's statement. A month is named by its own name ("October"); any other period by
     * the day it ends. */
    reconcile: {
      one: (account: string, month: string | null, through: string): string =>
        month === null
          ? `${account} is ready to reconcile through ${through}.`
          : `${account} is ready to check against its ${month} statement.`,
      many: (accounts: number, month: string | null, through: string): string =>
        month === null
          ? `${accounts} accounts are ready to reconcile through ${through}.`
          : `${accounts} accounts are ready to check against their ${month} statements.`,
      verb: "Reconcile",
    },

    close: {
      /** The month is named as the app names it: "March 2026". Said only for what no other row says. */
      blocked: (things: number, month: string): string =>
        `${count(things, "thing stands", "things stand")} in the way of closing ${month}.`,
      blockedVerb: "See what's left",
      ready: (month: string): string => `${month} is ready to close.`,
      readyVerb: (month: string): string => `Close ${month}`,
    },

    backup: {
      never: "Your books have never been backed up.",
      neverVerb: "Back up now",
      notVerified: "No backup of your books has been checked yet.",
      notVerifiedVerb: "Check a backup",
      stale: (age: string): string => `Your last checked backup was ${age}.`,
      staleVerb: "Back up now",
      failed: "Your newest backup did not pass its check.",
      failedVerb: "Back up again",
    },

    stripe: {
      syncFailed: "The last Stripe sync did not finish.",
      syncFailedVerb: "Check Stripe",
      mismatched: (payouts: number): string =>
        `${count(payouts, "Stripe payout does", "Stripe payouts do")} not add up.`,
      mismatchedVerb: "Look at payouts",
      overdue: (payouts: number): string =>
        `${count(payouts, "Stripe payout has", "Stripe payouts have")} no matching bank deposit.`,
      overdueVerb: "Look at payouts",
    },

    bankfeed: {
      attention: "Your bank connection needs attention.",
      verb: "Fix it",
    },

    year: {
      toClose: (year: number): string => `${year} has ended and is not closed.`,
      verb: (year: number): string => `Close ${year}`,
    },

    tokens: {
      expiring: (tokens: number, days: number): string =>
        `${count(tokens, "agent stops", "agents stop")} working within ${days} days.`,
      verb: "See agents",
    },

    /** What others changed since you last looked: the makers are named, most first. */
    changes: {
      text: (changes: number, makers: readonly string[]): string =>
        `${count(changes, "change was", "changes were")} made by others since you last looked: ${makers.join(", ")}.`,
      /** One maker's share of them: "5 by the agent weekly-run". */
      by: (changes: number, maker: string): string => `${changes} by ${maker}`,
      more: (makers: number): string => `and ${count(makers, "other", "others")}`,
      verb: (changes: number): string => (changes === 1 ? "Look at it" : "Look at them"),
    },
  },

  /** The bank, card and Stripe accounts: Home holds the heading, the tiles say the rest. */
  tiles: {
    heading: "Accounts",
  },

  /** "Money in and out": six months, drawn and as a table. */
  money: {
    heading: (cash: boolean): string => (cash ? "Money in and out" : "Income and expenses"),
    in: (cash: boolean): string => (cash ? "Money in" : "Income"),
    out: (cash: boolean): string => (cash ? "Money out" : "Expenses"),
    inShort: (cash: boolean): string => (cash ? "In" : "Income"),
    outShort: (cash: boolean): string => (cash ? "Out" : "Expenses"),
    yearSoFar: "This year so far",
    profit: "Profit",
    chartLabel: (cash: boolean, months: number): string =>
      `Bar chart of ${cash ? "money in and money out" : "income and expenses"} for each of the last ${months} months. The table after it has the figures.`,
    tableCaption: (cash: boolean): string =>
      `${cash ? "Money in and out" : "Income and expenses"} by month`,
    month: "Month",
    nothing: "Nothing recorded in these months yet.",
    beforeBooks: "Before your books began",
    notRead: "Could not be read",
    loading: "Reading the last six months…",
    failedTitle: "Money in and out could not be read",
    failedBody: "Nothing in your books has changed.",
    retry: "Try again",
  },
} as const;

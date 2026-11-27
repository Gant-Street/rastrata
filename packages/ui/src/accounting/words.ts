/** Every word the accounting lane's own components say, in one place and in the product's vocabulary
 * (transactions, Description, Chart of accounts, Close the books). Data (names, dates, amounts, what a
 * person typed) is never in this file. */

export const accountingWords = {
  /** The Transactions page: the list of every entry in the book. */
  transactions: {
    title: "Transactions",
    loading: "Reading your transactions…",
    failedTitle: "Transactions are unavailable",
    failedBody: "The book could not be read. No entries have been changed.",
    retry: "Try again",
    noBookTitle: "No book connected",
    noBookBody:
      "Your transactions will appear here once a book is connected. No sample transactions are shown.",
    draftsTitle: "Saved drafts",
    draftsLabel: "Saved drafts",
    untitledDraft: "Untitled draft",
    draftPosting: "Posting pending",
    draftRejected: "Rejected attempt",
    draftUnposted: "Unposted",
    editDraft: "Edit draft",
    reverseAction: "Reverse",
    reversed: (label: string) =>
      `Reversed ${label}. The original stays in your books, linked to its reversal.`,
    reversedPlain: "Reversal posted. The original stays in your books, linked to its reversal.",
    detailsSummary: "Details",
    detailsRevision: "Book revision",
    detailsBasis: "Basis",
    detailsPopulation: "Population",
    openStatements: "Open statements at this revision",
  },

  /** One entry's page. */
  entry: {
    back: "Transactions",
    titleWhileLoading: "Entry",
    loading: "Reading the entry…",
    failedTitle: "This entry could not be opened",
    failedBody: "It may not exist, or the service could not be reached. Nothing was changed.",
    retry: "Try again",
    backToList: "Back to the transactions",
    noBookTitle: "No book connected",
    noBookBody: "Set up a book first.",
    reverse: "Reverse",
    reversedBy: "Reversed by",
    reversal: "Reversal of",
    otherEntry: "its other entry",
    reversedToast: "Reversed. The original stays in your books, linked to its reversal.",
    linesLabel: "Entry lines",
    columnAccount: "Account",
    columnDebit: "Debit",
    columnCredit: "Credit",
    total: "Total",
    detailsSummary: "Details",
    revision: "Book revision",
    sequence: "Sequence",
    viewedAt: "Viewed at revision",
    recorded: "Recorded",
    sourceEvent: "Source event",
    sourceFingerprint: "Source fingerprint",
    inspectSource: "Inspect source event",
    sourceLabel: "Source provenance",
  },

  reverse: {
    title: (label: string) => `Reverse ${label}`,
    intro:
      "This posts a new transaction that cancels the original. The original stays in your books, linked to its reversal.",
    date: "Reversal date",
    dateHint: "The day the reversal counts in your books.",
    reason: "Reason",
    reasonHint: "Kept with the reversal, for you and your accountant.",
    reasonRequired: "Enter a reason.",
    dateRequired: "Enter a date.",
    submit: "Reverse transaction",
    working: "Reversing…",
    confirmWarnings: "Reverse anyway",
    cancel: "Cancel",
    checkTitle: "Check before you reverse",
    problemTitle: "This reversal cannot be posted",
    waitingTitle: "A reversal is waiting",
    retained: "An original request is retained. Resume it before making another change.",
    resume: "Resume original request",
    close: "Close",
    action: "Reverse",
  },
};

export type AccountingWords = typeof accountingWords;

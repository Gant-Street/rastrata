/** Every word the new-entry form says, in the product's vocabulary (Description, transactions, Where this
 * entry came from). Data (accounts, amounts, what a person typed) is never in this file. */

export const entryWords = {
  title: "New journal entry",
  openingTitle: "Record opening balances",
  draftTitle: "Edit draft",
  back: "Transactions",
  description: "Record an entry that balances. Save a draft to finish it later, or post it.",
  openingDescription:
    "Enter each opening amount and show its offset account on the other side. This posts an ordinary entry; it never edits stored balances directly.",
  help: [
    "An entry moves money between accounts. Every line is a debit or a credit, and the debits must equal the credits before it can be posted.",
    "A draft keeps what you typed without touching your balances. Posting adds the entry to your books; to correct it afterwards, reverse it.",
  ],
  loading: "Reading your accounts…",
  bookFailedTitle: "The book could not be read",
  bookFailedBody: "Nothing was changed.",
  retry: "Try again",
  noBookTitle: "No book connected",
  noBookBody: "Set up a book before creating entries.",
  draftChip: "Draft",

  fields: {
    date: "Date",
    dateHint: "The day it counts in your books.",
    description: "Description",
    descriptionHint: "What the entry is for.",
    reference: "Reference (optional)",
    referenceHint: "A short name to find it by, such as an invoice number.",
  },

  lines: {
    title: "Entry lines",
    group: (number: number) => `Line ${number}`,
    columnAccount: "Account",
    columnDebit: "Debit",
    columnCredit: "Credit",
    accountFor: (number: number) => `Account for line ${number}`,
    debitFor: (number: number) => `Debit for line ${number}`,
    creditFor: (number: number) => `Credit for line ${number}`,
    removeLine: (number: number) => `Remove line ${number}`,
    removeShort: "Remove",
    addLine: "Add line",
    amountPlaceholder: "0.00",
    accountsLoading: "Reading your accounts…",
    newAccount: "New account",
  },

  bar: {
    label: "Entry totals and actions",
    debits: "Debits",
    credits: "Credits",
    differenceLabel: "Difference",
    unreadable: "Fix the amounts to see the totals.",
    balancedFlag: "Balanced",
    unbalancedFlag: "Out of balance",
    balanced: "The entry balances.",
    outOfBalance: (difference: string) => `Out of balance by ${difference}.`,
    cancel: "Cancel",
    discard: "Discard draft",
    saveDraft: "Save draft",
    post: "Post",
    working: "Working…",
  },

  /** What is wrong with an amount box, said beside it. */
  amount: {
    notAnAmount: "Enter an amount such as 125.50.",
    tooPrecise: "Use at most two decimal places.",
    negative: "Enter a positive amount. Use the other column for money going the other way.",
    zero: "Enter an amount above zero.",
  },

  /** What is wrong with the entry as a whole, listed when Save draft or Post is refused. A line's problem is
   * said short beside its own control and in full ("Line 2: ...") in the list. */
  problems: {
    title: "This entry is not ready",
    dateRequired: "Enter a date.",
    descriptionRequired: "Enter a description.",
    sourceDescriptionRequired: "The source of this entry has no description.",
    chooseAccount: "Choose an account.",
    enterAmount: "Enter a debit or a credit.",
    oneSide: "Use a debit or a credit, not both.",
    line: (number: number, problem: string) => `Line ${number}: ${problem}`,
    needTwo: "An entry needs at least two lines with an amount.",
    outOfBalance: (difference: string) =>
      `The entry is out of balance by ${difference}. Debits and credits must be equal.`,
  },

  /** What happened, said once and politely. */
  done: {
    draftSaved: "Draft saved. It has not affected your balances.",
    draftRecovered:
      "Draft recovered for editing. Post it again when it is right; the original rejection stays in the record.",
    posted: (label: string) => `Posted ${label}.`,
    postedPlain: "Posted.",
    view: "View",
    uncertainRemains: "The posting remains uncertain. Resume its original retained request.",
  },

  review: {
    title: "Check before you post",
    problemTitle: "This entry cannot be posted",
    warningsTitle: "Check before you post",
    table: "Entry to post",
    columnAccount: "Account",
    columnDebit: "Debit",
    columnCredit: "Credit",
    changed: "The entry changed. Post it again to review the new version.",
    postAnyway: "Post anyway",
    back: "Keep editing",
  },

  retained: {
    title: "A request is waiting",
    body: "An original request is retained. Resume it before making another change.",
    resume: "Resume original request",
  },

  recovery: {
    recovered: (operation: string) =>
      `Recovered from rejected operation ${operation}. Its original outcome remains in the book record.`,
    recover: "Recover for editing",
    resolve: "Resolve original posting",
  },

  /** Where the entry came from: the event it records (a bank transaction, an invoice), by which the
   * ledger refuses to book the same event twice. Shown under a disclosure only when the form is
   * opened for a source or for a draft that carries one; an entry typed by hand has no fold. */
  source: {
    summary: "Where this entry came from",
    sourceId: "Source ID",
    description: "What happened",
    evidence: "Evidence",
    inspect: "Inspect source",
    recordLabel: "Source record",
    status: (status: string, drafts: number) =>
      `Source status: ${status} · Linked drafts: ${drafts}`,
    operation: (id: string) => `Posting operation: ${id}`,
    draftLink: (id: string) => `Draft ${id}`,
    draftState: (status: string, version: number) => `${status} · version ${version}`,
    draftsPage: (page: number) => `Linked drafts page ${page}`,
    previous: "Previous draft page",
    next: "Next draft page",
    outcome: (sequence: string) => `Retained outcome sequence: ${sequence}`,
    reversal: "Reversal:",
    viewEntry: "View the entry from this source",
  },
};

export type EntryWords = typeof entryWords;

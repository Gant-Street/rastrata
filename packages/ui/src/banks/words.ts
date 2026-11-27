/** The words of Bank accounts. Short, and only what is permanent. A sentence never names a screen or a control (see stripe/words.ts): it says the thing in plain words. */
export const bankWords = {
  title: "Bank accounts",
  lead: "New transactions are imported as your bank posts them.",
  connect: "Connect a bank",
  importStatement: "Import a statement",
  empty: "Import your bank transactions automatically.",
  emptyMember: "An owner can connect a bank.",
  columns: {
    account: "Account",
    books: "In your books",
    review: "To review",
    balance: (currency: string) => `Balance, ${currency}`,
  },
  ending: "ending",
  /** After a count, where the column's heading is not shown (a phone). */
  countWords: "to review",
  waitingForAnswer: "Waiting for your answer",
  toReview: (count: number, name: string) =>
    count === 1
      ? `1 transaction to review in ${name}`
      : `${count} transactions to review in ${name}`,
  same: (account: string) => `Your books already have ${account}. Is this the same account?`,
  yesUse: (account: string) => `Yes, use ${account}`,
  noSeparate: "No, keep it separate",
  actionsFor: (name: string) => `Actions for ${name}`,
  actions: {
    change: "Change account in books",
    disconnect: "Disconnect",
  },
  updated: (when: string) => `Updated ${when}`,
  lastUpdated: (when: string) => `Last updated ${when}`,
  waiting: "Waiting for the bank",
  disconnected: "Disconnected",
  signInAgain: "Needs you to sign in again",
  signIn: (bank: string) => `Sign in to ${bank}`,
  newAccount: (name: string) => `New account: ${name}`,
  change: {
    title: (name: string) => `Change where ${name} goes`,
    account: "Account in your books",
    from: "Bring in transactions from",
    save: "Save",
    cancel: "Cancel",
  },
};

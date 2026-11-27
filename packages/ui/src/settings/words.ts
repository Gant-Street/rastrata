/** The words of the Settings screens the shell owns: Business, Connections, Bring in your books and Move
 * from Xero. (Backups and export, Agents, Start date and opening balances and the two connection pages are
 * their own lanes'.) */
export const settingsWords = {
  business: {
    title: "Business",
    facts: "About this book",
    factsHint: "Set when the books were created.",
    name: "Business name",
    fiscalYear: "Fiscal year starts",
    booksBegan: "Books began",
    yearStart: {
      title: "Fiscal year",
      intro: (month: string) =>
        `Your fiscal year starts in ${month}. You can change it until you post your first entry.`,
      change: "Change fiscal year",
      choose: "Fiscal year starts in",
      review: "Review",
      reviewTitle: (month: string) => `Fiscal years will start in ${month}`,
      reviewBody: (from: string, to: string, years: number) =>
        `The calendar will run from ${from} to ${to}, ${years} fiscal ${years === 1 ? "year" : "years"}. Nothing you have recorded changes.`,
      commit: "Change fiscal year",
      cancel: "Cancel",
      done: (month: string) => `Your fiscal year now starts in ${month}.`,
      failed: "The fiscal year was not changed.",
    },
    method: "Accounting method",
    currency: "Currency",
    periods: "Periods",
    cash: "Cash basis",
    accrual: "Accrual basis",
    monthly: "Monthly",
    quarterly: "Quarterly",
    readOnly: "Only an owner or an administrator changes these",
    readOnlyBody:
      "You can see how this business is set up. To change its name or how things are shown, ask an owner or an administrator of the workspace.",
    loading: "Reading the book…",
    none: "No book yet",
    noneBody: "Set up your books first.",
    failed: "The book could not be read",
    retry: "Try again",
    workspace: "Export or delete this workspace",
  },
  bringIn: {
    title: "Bring in your books",
    groups: { date: "Start from a date", history: "Past years", xero: "Moving from Xero" },
    opening: {
      label: "Start date and opening balances",
      note: "The day your books begin here, and what each account held on it.",
    },
    history: {
      label: "Bring in history",
      note: "Your past years from another system, as entries dated as they were.",
    },
    xeroImport: {
      label: "Import from Xero",
      note: "Your chart of accounts, trial balance and account transactions.",
    },
    xeroCompare: {
      label: "Compare with Xero",
      note: "Rastrata's reports against Xero's, account by account.",
    },
    xeroCheck: {
      label: "Things to check",
      note: "Everything that does not match yet.",
    },
  },
  connections: {
    title: "Connections",
    description: "Where transactions can come from besides files you import.",
    help: "A connection imports transactions by itself, so you do not download and import a file each time. Nothing is posted by a connection: everything it brings waits for you to review it.",
    bank: "Bank connection",
    stripe: "Stripe",
    notConnected: "Not connected",
    connected: "Connected",
    checking: "Checking…",
    failed: "Could not be read",
    needsAttention: "Needs attention",
    set: "Set up",
    open: "Open",
    bankBody: "Reads your bank's transactions through SimpleFIN Bridge, on this computer.",
    stripeBody: "Reads every charge, fee, refund and payout from Stripe, on this computer.",
    accountsLinked: (count: number) =>
      count === 1 ? "1 account linked" : `${count} accounts linked`,
    lastRead: (when: string) => `Last read ${when}`,
    neverRead: "Not read yet",
    keyMode: (mode: string) => `${mode} key`,
  },
} as const;

/** Every word the shadow lane's components own, in one place, in plain terms: say what happened and
 * what to do next, and never claim an outcome that is not confirmed. Data (account names, amounts,
 * dates) is never in this file. The product books and reports; it gives no tax advice. */
import { formatDate } from "../format";

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

export const words = {
  // ---- The opening balances screen ----------------------------------------------------------
  openingTitle: "Opening balances",
  openingEyebrow: "Moving to Rastrata",
  openingIntro:
    "Start the books from what the business holds on the day you leave your old system.",
  loading: "Loading your accounts…",
  noBookTitle: "There is no book yet",
  noBookBody: "These screens work on your books. Set up your books first, then come back.",
  noBookLink: "Set up your books",
  loadFailed: "Your accounts could not be loaded. Nothing has been changed.",
  requestFailed: "That request did not complete. Nothing was changed.",
  retry: "Try again",
  noAccounts: "This book has no accounts yet.",

  // Step 1: the cutover date
  stepDate: "1. Start date",
  dateIntro:
    "The first day that belongs in these books. The opening entry stands at the start of this day (it is dated the day before), and bank history from before it is set aside: you can still see it and bring it back.",
  dateLabel: "Start date",
  dateNeeded: "Choose the start date.",
  statementsLegend: "Accounts that have statements",
  statementsNone:
    "This book has no bank or card account yet. A statement you import later begins on the start date.",
  suggestedBecause: (why: string) => `Suggested: ${why}`,
  notSuggested: "Not suggested",
  becauseReconciled: "you have reconciled it before",
  becauseImported: "it has a statement import",
  becauseCash: "it is tagged as a cash account",
  becauseCard: "it looks like a credit card",
  becauseStripe: "it is the Stripe balance",
  kind: { bank: "Bank", card: "Card", stripe: "Stripe" },
  stripeNotHere: "Stripe starts on its own first day",
  record: "Record start date",
  recording: "Recording…",
  recorded: (date: string) => `Start date recorded: ${formatDate(date)}.`,
  recordedBy: (by: string, at: string) => `Recorded by ${by} on ${formatDate(at)}.`,
  changeDate: "Change the start date",
  setAside: "Set aside",
  noneSetAside: "None",
  recordFailed: "The start date could not be recorded.",
  sourcesCaption: "Where each statement starts",
  source: "Source",
  startsNow: "Starts now",
  startsAfter: "Starts on",
  whatHappens: "What happens",
  notSet: "Not set",
  actions: {
    set: "Begins on the start date.",
    move_later: "Moves later.",
    move_earlier: "Moves earlier.",
    create: "Created, so your first import begins on the start date.",
    unchanged: "No change.",
    managed: "Its first day is set in its own settings.",
    unmapped: "Choose its account first.",
  },
  wouldExclude: (count: number) =>
    `${count} queued ${plural(count, "transaction", "transactions")} before it will be set aside.`,
  wouldRestore: (count: number) =>
    `${count} ${plural(count, "transaction", "transactions")} set aside before come back.`,
  alreadyExcluded: (count: number) =>
    `${count} ${plural(count, "transaction is", "transactions are")} already set aside as before the start date.`,
  previewing: "Working out what the date does…",
  stripeMatches: "Stripe imports from the start date.",

  // Step 2: balances
  stepBalances: "2. Balances",
  balancesIntro:
    "Enter each account's balance at the end of the day before the start date, the way you read it.",
  balancesCaption: "Opening balances by account",
  account: "Account",
  balance: "Balance",
  debit: "Debit",
  credit: "Credit",
  balanceFor: (account: string) => `Balance for ${account}`,
  amountProblem:
    "Enter an amount such as 1,234.56. Use a minus sign or brackets for the unusual side. Amounts are never rounded: use two decimal places at most.",
  sectionAssets: "Assets",
  sectionLiabilities: "Liabilities",
  sectionEquity: "Equity",
  sectionProfitLoss: "Income and expenses, year to date (optional)",
  profitLossHint:
    "Leave these empty unless you want the profit and loss from before the start date in these books. They are dated with the opening entry, so the month that date falls in shows them.",
  showProfitLoss: "Show income and expense accounts",
  hideProfitLoss: "Hide income and expense accounts",
  entered: "Entered balances",
  offsetRow: (name: string) => `${name} (offset, calculated)`,
  offsetNote:
    "The offset is worked out for you so the entry balances. It is everything the balances do not explain.",
  offsetNone: "The balances balance on their own: no offset is needed.",
  offsetMissing:
    "Choose the equity account that carries the difference. Your chart has no account named for opening balances.",
  offsetChoice: "Offset account",
  offsetAuto: "Use the account named for opening balances",
  offsetAmount: (side: "debit" | "credit", amount: string, account: string) =>
    `Offset: ${amount} ${side} to ${account}.`,
  total: "Total",
  totalsBalanced: "Debits and credits agree.",
  importCsv: "Import balances from a CSV file",
  importHint: "A file with a Code or Name column and a Balance, or a Debit and a Credit, column.",
  importReading: "Reading the file…",
  importDone: (count: number, name: string) =>
    `Read ${count} ${plural(count, "balance", "balances")} from ${name}.`,
  importFailed: "The file could not be read.",
  importTooLarge:
    "That file is too large. Opening balances are one row per account, and a request carries about 120,000 characters.",
  importNotText: "That file is not a CSV or text file.",
  clearAll: "Clear all balances",

  // Step 3: review and post
  stepReview: "3. Review and post",
  reviewButton: "Review the entry",
  reviewing: "Reviewing…",
  needCutover: "Record the start date first.",
  fixAmounts: (count: number) =>
    `Fix ${count} ${plural(count, "amount", "amounts")} before reviewing.`,
  nothingEntered: "Enter at least one balance to review.",
  stale: "The balances changed after this review. Review the entry again before preparing it.",
  entryCaption: (date: string) => `Opening entry dated ${formatDate(date)}`,
  entryEmpty: "The entry has no lines yet.",
  offsetLine: "Offset (calculated)",
  entryBalanced: "Balanced: debits and credits agree exactly.",
  entryUnbalanced: "Debits and credits do not agree.",
  errorsTitle: "Fix these before the entry can be prepared",
  warningsTitle: "Check before you post",
  notesTitle: "Notes",
  prepare: "Prepare the entry",
  preparing: "Preparing…",
  prepared: "Prepared. This is the exact entry the ledger will post.",
  preparedDetails: "Details",
  preparedRevision: "Book revision",
  preparedPlan: "Plan",
  preparedInvalid:
    "The ledger would refuse this entry. Read the problems, change the balances and review again.",
  post: "Post opening balances",
  posting: "Posting…",
  postNote:
    "Posting makes one entry, dated as shown. It cannot be edited afterwards; a mistake is corrected by reversing it.",
  posted: "Opening balances posted.",
  postedDetail: (date: string) => `The entry is dated ${formatDate(date)}.`,
  postedNote:
    "It cannot be edited. A mistake is corrected by reversing it and entering the balances again.",
  postRejected: "The ledger refused the entry.",
  entryLink: "Open the entry",
  nextTitle: "What to do next",
  nextImport: "Import your bank and card statements",
  nextReconcile: "Reconcile each account to its statement",
  nextChecklist: "Close the books",
  alreadyPosted: "Opening balances are already posted.",
  alreadyPostedBody: (date: string) =>
    `The opening entry is dated ${formatDate(date)}. To change it, reverse it, then come back and plan a new one.`,
  handoffDone: (count: number, asOf: string | null) =>
    `Filled ${count} ${plural(count, "balance", "balances")} from the Xero trial balance${asOf ? ` as at ${formatDate(asOf)}` : ""}. Xero's bank, card and Stripe figures are Xero's books, not your statements: replace each with the balance on its statement before you review the entry.`,
  handoffNeedsCutover:
    "Record the start date first, then bring the balances from Xero again: they are checked against it.",
  handoffFailed: "The balances from Xero could not be read.",
  alreadyByHand: "Opening balances were already entered by hand.",
  alreadyByHandBody: (date: string) =>
    `The entry dated ${formatDate(date)} against Opening balance equity is the opening entry, so a second one is not offered: the balances would count twice. To use these tools instead, reverse that entry, then come back.`,
  plannedWaiting:
    "An opening entry has been prepared and not posted. Prepare it again from your balances to continue, or leave it.",
  reversedNote:
    "The opening entry was reversed. You can enter the balances again and post a corrected entry.",

  // Writes that were not confirmed
  uncertainTitle: "An earlier request was not confirmed",
  uncertainBody:
    "The reply was lost, so Rastrata cannot say whether it was applied. Resume the original request before changing anything else; nothing is sent twice.",
  resume: "Resume original request",
  resuming: "Resuming…",
} as const;

import { formatDate } from "../format";
/** Every word the reconcile components own, in one place, in plain terms: say what happened and
 * what to do next, and never claim an outcome that is not confirmed. Data (account names,
 * descriptions, amounts) is never in this file. The app says "transactions"; the terminal and the API
 * keep "lines". */
const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);
const transactions = (count: number) => `${count} ${plural(count, "transaction", "transactions")}`;

export const words = {
  // The page
  pageLine: "Check an account against the statement your bank sent.",

  // Columns and transactions
  date: "Date",
  description: "Description",
  amount: "Amount",
  moneyOut: { asset: "Money out", liability: "Payments and credits" },
  moneyIn: { asset: "Money in", liability: "Charges" },
  noun: {
    out: { asset: "money out", liability: "payments and credits" },
    in: { asset: "money in", liability: "charges" },
  },
  columnCount: (selected: number, total: number) => `${selected} of ${total} selected`,
  columnLoading: "Loading transactions…",
  columnFailed: "The transactions could not be loaded. Your books have not been changed.",
  empty: (noun: string) => `No ${noun} to reconcile.`,
  noMatches: (noun: string) => `No ${noun} match your search.`,
  tableCaption: (title: string, count: number) => `${title}: ${transactions(count)}`,
  selectAll: (noun: string) => `Select all ${noun} shown`,
  viewEntry: "View entry",
  recordCount: (count: number) => transactions(count),
  recordNone: (noun: string) => `No ${noun} on this reconciliation.`,

  // Summary
  difference: "Difference",
  statementBalance: "Statement balance",
  opening: "Cleared by earlier statements",
  selected: (count: number) => `Selected (${transactions(count)})`,
  clearedBalance: "Cleared balance",
  figures: "Reconciliation figures",
  balanced: "Balanced. Ready to finish.",
  balancedRecord: "Balanced: the transactions add up to the statement exactly.",
  higher: (amount: string) => `The statement is ${amount} higher than your selected transactions.`,
  lower: (amount: string) => `The statement is ${amount} lower than your selected transactions.`,

  // Workspace
  find: "Find a transaction",
  findHint:
    "Type an amount or part of a description. With one match, Enter ticks it. With several, Enter moves to the first.",
  findNone: "No transaction matches.",
  findTicked: (what: string) => `Ticked ${what}.`,
  findUnticked: (what: string) => `Unticked ${what}.`,
  findCount: (shown: number, total: number) =>
    `Showing ${shown} of ${total} ${plural(total, "transaction", "transactions")}.`,
  selectEvery: "Select all transactions",
  clearEvery: "Clear all",
  editStatement: "Edit statement",
  refresh: "Refresh transactions",
  saved: "All changes saved.",
  saving: "Saving…",
  uncertainTitle: "The last change may not have been saved",
  uncertainBody:
    "The reply was lost. Resume the original request before changing anything else; nothing is sent twice.",
  resume: "Resume original request",
  failed: "The last change could not be saved. Reload this reconciliation to see what is stored.",
  staleTitle: "The books changed after these transactions were loaded",
  staleBody:
    "New entries may be missing from the lists. Refresh the transactions; your ticks are kept.",
  finish: "Finish reconciliation",
  discard: "Discard draft",
  finishReady: "Ready: the difference is 0.00.",
  finishNeedsZero: "You can finish when the difference is exactly 0.00.",
  finishNeedsSave: "You can finish when your changes are saved.",
  finishNeedsFresh: "Refresh the transactions first; the books changed.",
  keyboard:
    "Keyboard: j and k or the arrow keys move between transactions, space or x ticks one, shift with an arrow ticks a run, / finds a transaction.",
  warningsTitle: "Check before finishing",

  // Starting one: a small form, over the page
  startAction: "Reconcile an account",
  startTitle: "Reconcile an account",
  startTitleFor: (account: string) => `Reconcile ${account}`,
  startIntro:
    "Enter the date the statement ends and the balance it ends with, exactly as printed. Then tick the transactions that are on it until the difference is 0.00.",
  account: "Account",
  required: "required",
  statementDate: "Statement end date",
  statementDateHint: "The last day the statement covers.",
  statementBalanceField: "Statement ending balance",
  statementBalanceHint:
    "Exactly as printed, with two decimal places. A card's balance owed is positive; an overdrawn bank account is negative.",
  start: "Start reconciling",
  starting: "Starting…",
  startErrors: "Check the statement details",
  needAccount: "Choose an account.",
  needDate: "Enter the date the statement ends.",
  needBalance: "Enter the statement ending balance, for example 1234.56.",
  hintFromImport: (balance: string, date: string) =>
    `An imported statement ends ${formatDate(date)} with ${balance}.`,
  useHint: "Use these",
  filledFromImport: (balance: string, date: string) =>
    `Filled in from the statement file you imported, which ends ${formatDate(date)} with ${balance}. Check it against your statement and change it if it differs.`,
  startFailed: "The reconciliation could not be started.",
  retainedTitle: "An original request is retained",
  retainedBody:
    "The reply to starting a reconciliation was lost. Resume it; nothing is sent twice.",

  // Lists
  statusCaption: "Accounts",
  account2: "Account",
  lastReconciled: "Last reconciled",
  notOnStatement: "Not yet on a statement",
  never: "Never",
  reconcile: "Reconcile",
  continueDraft: "Continue",
  noAccountsTitle: "No accounts to reconcile yet",
  noAccountsBody:
    "Import a statement or connect a bank, and its account is listed here to check against its statement.",
  importStatement: "Import statement",
  unavailableTitle: "Reconciliation is unavailable",
  unavailableBody: "The accounts could not be read. Your books have not been changed.",
  unclearedSummary: (count: number, total: string, oldest: string | null) =>
    `${transactions(count)}, ${total}${oldest ? `, from ${formatDate(oldest)}` : ""}`,
  allOnStatements: "Everything is on a statement.",
  /** An account nothing has reached yet: no posting, no statement, no reconciliation. */
  nothingYet: "Nothing to reconcile yet.",
  historyCaption: "Earlier reconciliations",
  statementCol: "Statement",
  linesCol: "Transactions",
  statusCol: "Status",
  open: "Open",
  noHistory: "No reconciliations yet. Reconcile an account to start one.",
  historyFailed: "The history could not be loaded",
  inProgress: "In progress",
  completed: "Completed",
  voided: "Voided",

  // The report on a finished reconciliation
  reportAction: "Download report",
  reportPreparing: "Preparing the report…",
  reportSaved: (name: string) => `Saved ${name}. It opens in any spreadsheet.`,
  reportFailedTitle: "The report could not be made",
  reportFailedBody: "Nothing in your books has changed. Try again.",
  outstandingTitle: "Not yet on the statement",
  outstandingCaption: (count: number) => `Not yet on the statement: ${transactions(count)}`,
  outstandingLoading: "Working out what was not yet on the statement…",
  outstandingFailedTitle: "What was not yet on the statement could not be worked out",
  outstandingFailedBody: "Nothing in your books has changed.",
  outstandingExplain:
    "Transactions in your books dated on or before the statement date that the statement does not show: a check not yet cashed, a deposit still on its way. They are worked out from the books as they were when this was finished, so a transaction entered later is not here.",
  outstandingNone: (date: string) =>
    `Nothing was outstanding: every transaction in your books on or before ${formatDate(date)} is on this statement.`,
  tieStatement: "Statement balance",
  tieNotYet: (count: number) => `Plus ${transactions(count)} not yet on it`,
  tieBooks: (date: string) => `Your books on ${formatDate(date)}`,
  tieSentence:
    "The statement balance plus the transactions not yet on it is the balance in your books on that day.",
  tryAgain: "Try again",

  // Dialogs
  finishTitle: "Finish this reconciliation?",
  finishBody:
    "Once finished it cannot be edited. If it was wrong, void it with a reason and reconcile again.",
  finishSummary: (account: string, date: string, count: number, balance: string) =>
    `${account}, statement ending ${formatDate(date)}. ${count} ${plural(count, "transaction adds", "transactions add")} up to the statement balance of ${balance}.`,
  cancel: "Cancel",
  finishing: "Finishing…",
  voidTitle: "Void this reconciliation?",
  voidSummary: (account: string, date: string) =>
    `${account}, statement ending ${formatDate(date)}. Its transactions become unreconciled again. The record stays in the history, with your reason.`,
  reason: "Reason",
  reasonHint: "Say why it is being voided, for example: wrong statement balance.",
  needReason: "Enter a reason.",
  void: "Void reconciliation",
  voiding: "Voiding…",
  discardTitle: "Discard this draft?",
  discardBody: "The transactions you ticked are not kept. Nothing in your books changes.",
  keepEditing: "Keep editing",
  discarding: "Discarding…",
  dialogError: "It could not be done",
} as const;

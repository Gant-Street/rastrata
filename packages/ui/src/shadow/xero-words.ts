/** Every word the Xero, comparison and gap log screens own, in one place, in plain terms: say what
 * happened and what to do next, and never claim an outcome that is not confirmed. Data (account
 * names, descriptions, amounts, dates) is never in this file. The product books and reports; it
 * gives no tax advice, and nothing here writes to Xero. */
import { formatCount, formatDate, formatDateRange, formatInstant } from "../format";

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);
const n = formatCount;

/** What each column a reader can find is called on screen, by the name the reader gives it. */
const COLUMN_FIELDS: Readonly<Record<string, string>> = {
  code: "Code",
  name: "Name",
  account: "Account",
  type: "Type",
  taxCode: "Tax code",
  description: "Description",
  balance: "Balance",
  ytdBalance: "Year-to-date balance",
  status: "Status",
  dashboard: "Dashboard",
  expenseClaims: "Expense claims",
  enablePayments: "Enable payments",
  reportingName: "Reporting name",
  date: "Date",
  source: "Source",
  reference: "Reference",
  debit: "Debit",
  credit: "Credit",
  ytdDebit: "Year-to-date debit",
  ytdCredit: "Year-to-date credit",
};
export const columnLabel = (field: string): string => COLUMN_FIELDS[field] ?? field;

export const xeroWords = {
  eyebrow: "Moving to Rastrata",
  loading: "Loading…",
  retry: "Try again",
  requestFailed: "That request did not complete. Nothing was changed.",
  uncertainTitle: "An earlier request was not confirmed",
  uncertainBody:
    "The reply was lost, so it is not known whether it was saved. Resume it: the same request is sent again, and it is never done twice.",
  resume: "Resume original request",
  resuming: "Resuming…",

  checklistXeroTitle: "Moving from Xero",
  checklistXeroIntro:
    "Read Xero's exports, compare the books with Xero where Xero was itself reconciled, and keep a log of what is not yet right. The proof that the move is right is the reconciliations.",

  // ---- The gap log ------------------------------------------------------------------------------
  gapsTitle: "Things to check",
  gapsIntro: "What the move found that is not yet right.",
  gapsLoadFailed: "The list of things to check could not be loaded. Nothing has been changed.",
  filterLegend: "Show",
  filterOpen: (count: number) => `Open (${count})`,
  filterClosed: (count: number) => `Closed (${count})`,
  filterAll: "All",
  gapsNone: {
    open: "No gap is open.",
    closed: "No gap has been closed yet.",
    all: "Nothing to check yet.",
  },
  gapCount: (count: number) => `${n(count)} ${plural(count, "gap", "gaps")}`,
  kind: {
    difference: "Difference",
    unmapped: "Unmapped account",
    feature: "Missing feature",
    data: "Data",
    other: "Other",
  },
  sourceTieout: "Found by the comparison with Xero",
  sourceManual: "Added by hand",
  opened: (by: string, at: string) => `Opened by ${by}, ${formatInstant(at)}`,
  closed: (by: string, at: string) => `Closed by ${by}, ${formatInstant(at)}`,
  resolutionHeading: "What was found",
  closeGap: "Close this gap",
  closeFormTitle: (title: string) => `Close: ${title}`,
  resolutionLabel: "What was found",
  resolutionHint:
    "A gap is closed only with a note, so the list says what was looked at. For example: Xero entered the same fee twice; Rastrata is right (statement line 14).",
  resolutionNeeded: "Say what was found before closing the gap (at least three characters).",
  confirmClose: "Close gap",
  closingGap: "Closing…",
  cancel: "Cancel",
  reopen: "Reopen",
  reopening: "Reopening…",
  addTitle: "Add a gap",
  titleLabel: "Title",
  titleNeeded: "Give the gap a title.",
  detailLabel: "Detail",
  detailHint: "What you saw, where, and what you expected.",
  kindLabel: "Kind",
  addButton: "Add gap",
  addingGap: "Adding…",
  added: "Gap added.",
  actionFailed: "That gap could not be changed.",

  // ---- The comparison ---------------------------------------------------------------------------
  tieNoXeroTitle: "Import your Xero files first",
  tieNoXero: "Import the Xero chart of accounts and map it to your accounts.",
  tieNoXeroAction: "Import Xero files",
  tieTitle: "Compare with Xero",
  tieIntro:
    "Rastrata's books against what Xero says, account by account and month by month, and only where Xero was itself reconciled.",
  tieLoadFailed: "The comparison could not be loaded. Nothing has been changed.",
  rangeLegend: "Which months",
  rangeFrom: "From",
  rangeTo: "To",
  rangeHint:
    "Leave both empty to compare every month after the start date that Xero has figures for.",
  toleranceLabel: "Days apart",
  toleranceHint:
    "How many days apart a transaction in each book may be and still be the same transaction.",
  toleranceProblem: "Use a whole number of days from 0 to 14.",
  compare: "Compare",
  comparing: "Comparing…",
  summaryHeading: "What the comparison found",
  nothingComparable:
    "Nothing could be compared. Xero has to be reconciled through the end of a month, and its trial balance and account transactions imported, before that month can be checked.",
  comparisons: (matches: number, comparable: number) =>
    `${n(matches)} of ${n(comparable)} ${plural(comparable, "comparison matches", "comparisons match")} to the cent.`,
  differences: (differs: number, explained: number, unexplained: number) =>
    `${n(differs)} ${plural(differs, "differs", "differ")}: ${n(explained)} explained to the cent, ${n(unexplained)} not explained.`,
  notComparableCount: (count: number) => `${n(count)} not comparable.`,
  onlyInXero: (count: number) =>
    `${n(count)} ${plural(count, "transaction is", "transactions are")} only in Xero.`,
  onlyInRastrata: (count: number) =>
    `${n(count)} ${plural(count, "transaction is", "transactions are")} only in Rastrata.`,
  cutoverWas: (date: string) => `Start date: ${formatDate(date)}.`,
  basisNote: (basis: string, currency: string) =>
    `Books kept on the ${basis} basis, in ${currency}.`,
  periodHeading: (from: string, to: string) => formatDateRange(from, to),
  xeroReconciledYes: "Xero was reconciled through the end of this period.",
  xeroReconciledNo: "Xero was not reconciled through the end of this period for:",
  throughWord: (date: string | null) =>
    date ? `reconciled through ${formatDate(date)}` : "no date recorded",
  accountsCaption: (period: string) => `Accounts compared, ${period}`,
  colAccount: "Account",
  colCompared: "Compared",
  colResult: "Result",
  colXero: "Xero",
  colRastrata: "Rastrata",
  colDifference: "Difference",
  colUnexplained: "Not explained",
  comparedAs: { closing: "Balance at the end", movement: "Movement in the period" },
  result: { matches: "Matches", differs: "Differs", not_comparable: "Not comparable" },
  explainedYes: "Explained to the cent",
  explainedNo: "Not explained",
  detailsFor: (code: string) => `Transactions for ${code}`,
  carriedLabel: "The books already disagreed when the period began by",
  matchedLabel: (count: number) =>
    `${n(count)} ${plural(count, "transaction matches", "transactions match")} in both books.`,
  unmatchedHeading: "Transactions in one book and not the other",
  unmatchedMore: (shown: number, total: number) =>
    `Showing ${n(shown)} of ${n(total)} transactions. Recording the differences adds every one to your things to check.`,
  lineCaption: (account: string) => `Transactions in one book and not the other, ${account}`,
  colSide: "Book",
  colDate: "Date",
  colDescription: "Description",
  colReference: "Reference",
  colDebit: "Debit",
  colCredit: "Credit",
  side: { xero: "Only in Xero", rastrata: "Only in Rastrata" },
  unmappedHeading: "Xero accounts with a balance and no account here",
  unmappedHint: "Map each one to an account of the book, or leave it out on purpose.",
  colXeroAccount: "Xero account",
  colBalance: "Balance",
  noPeriods: "No period has figures from Xero yet.",
  noAmount: "No figure",
  recordHeading: "Record what was found",
  recordIntro:
    "Adds each transaction in one book and not the other, each difference the transactions could not explain, and each unmapped Xero account with a balance to your things to check. A gap is added once: recording again adds only what is new, and never reopens one that was closed.",
  record: "Add to Things to check",
  recording: "Adding…",
  recorded: (added: number, existing: number) =>
    `${n(added)} ${plural(added, "gap was", "gaps were")} added; ${n(existing)} ${plural(existing, "was", "were")} already in the log.`,
  openGaps: "Open Things to check",
  openXero: "Open the Xero import",

  // ---- The Xero import --------------------------------------------------------------------------
  importTitle: "Import from Xero",
  importIntro:
    "Read Xero's exports and check them against your books. Nothing here writes to Xero or needs its login: you choose a file, it is read and shown to you, and only then is it kept. What proves the move is that every account reconciles to its statement; Xero is a second check.",
  importLoadFailed: "What has been imported could not be loaded. Nothing has been changed.",
  statusHeading: "What has been imported",
  /** The one sentence under the title. */
  importLine: "Four files from Xero, one at a time.",
  stepsLabel: "Files from Xero",
  change: "Change",
  /** A finished step, in a few words. */
  saidChart: (accounts: number, unmapped: number, withBalance: number) =>
    `${n(accounts)} ${plural(accounts, "account", "accounts")}, ${
      withBalance > 0
        ? `${n(withBalance)} with a balance to decide`
        : unmapped > 0
          ? `${n(unmapped)} not matched`
          : "all matched"
    }`,
  saidReconciled: (accounts: number, through: string) =>
    `${n(accounts)} ${plural(accounts, "account", "accounts")}, through ${through}`,
  statusChart: (when: string) => `Chart of accounts imported ${when}.`,
  statusMapping: (mapped: number, accounts: number) =>
    `${n(mapped)} of ${n(accounts)} Xero accounts are mapped or left out on purpose.`,
  statusUnmapped: (count: number) =>
    `${n(count)} ${plural(count, "account with a balance has", "accounts with a balance have")} no account here yet.`,
  statusTrialBalances: "Trial balances stored, as at",
  statusTransactions: "Account transactions stored",
  statusRange: (from: string, to: string, lines: number) =>
    `${formatDateRange(from, to)}, ${n(lines)} transactions`,
  statusReconciled: "Where Xero was reconciled",
  statusNone: "None yet.",
  fileLegend: "Choose the file",
  chooseFile: "Choose a file",
  chooseAnother: "Choose another file",
  fileTooLarge:
    "That file is larger than one request carries (about 120,000 characters). Export a shorter period, such as one month.",
  fileUnreadable: "That file could not be read as text.",
  fileNotRead: "That file could not be read.",
  columnsRead: (count: number) => `How the columns were read (${n(count)})`,
  columnsHint:
    "The header each column had in your file, and what it was taken to be. A column you expected that is not here was not found: read the problems before keeping anything.",
  columnsCaption: "How the columns of the file were read",
  colYourColumn: "Column in your file",
  colReadAs: "Read as",
  reading: "Reading the file…",
  readFile: (name: string) => `Read ${name}.`,
  nothingKept: "Nothing has been kept yet.",

  chartTitle: "Chart of accounts",
  chartIntro: "Each Xero account is matched to an account of your book.",
  chartKind: "Xero's chart of accounts (Accounting, Chart of accounts, Export)",
  chartCounts: (accounts: number, certain: number, likely: number, check: number) =>
    `${n(accounts)} ${plural(accounts, "account", "accounts")}: ${n(certain)} certain, ${n(likely)} likely, ${n(check)} to check.`,
  groupDecide: "Needs your decision",
  groupLikely: "Likely matches",
  groupCertain: "Certain matches",
  groupLeftOut: "Left out on purpose",
  groupSummary: (name: string, count: number, decided: number) =>
    `${name} (${n(count)}${decided > 0 ? `, ${n(decided)} decided` : ""})`,
  decidedTag: "Decided by you",
  colXeroCode: "Xero",
  colXeroName: "Name",
  colXeroType: "Type",
  colMapsTo: "Maps to",
  colHow: "How sure",
  autoChoice: "Not decided",
  skipChoice: "Leave out",
  possibleChoice: (label: string) => `Possible: ${label}`,
  chooseFor: (code: string) => `Account for Xero account ${code}`,
  confidence: {
    certain: "Certain",
    likely: "Likely",
    check: "Check",
    none: "No match",
  },
  basis: {
    override: "You chose it",
    saved: "Saved earlier",
    code: "Same code and name",
    name: "Same name",
    similar: "Similar name or code",
    none: "Nothing resembles it",
  },
  skipUnreadable: (count: number) =>
    `Leave out the ${n(count)} ${plural(count, "row", "rows")} that could not be read`,
  skipUnreadableHint: "A file with unreadable rows is kept only if you agree to leave them out.",
  acceptLikely: "Also keep the likely matches as shown",
  keepMapping: "Keep the mapping",
  keepingMapping: "Keeping…",
  mappingKept: (saved: number) =>
    `Mapping kept: ${n(saved)} ${plural(saved, "choice", "choices")} saved.`,
  archivedTag: "Archived in Xero",
  systemTag: "System account",
  bankTag: "Bank account",

  tbTitle: "Trial balance",
  tbIntro: "A trial balance as at the day before the start date gives the opening balances.",
  tbKind: "Xero's Trial Balance report (Reporting, Trial Balance, Export, CSV)",
  tbOrder: "How dates read",
  tbOrderMdy: "Month first (a US organization)",
  tbOrderDmy: "Day first",
  tbOrderHint: "Only needed when the file has a numeric date that could be read either way.",
  tbIncludePl: "Carry income and expense balances into the opening balances",
  tbIncludePlHint:
    "They are year-to-date amounts that would show in the month the start date falls in. Leave them out unless you want them there; the difference lands in the offset.",
  tbAsOf: (date: string) => `As at ${formatDate(date)}.`,
  tbBalanced: "Debits and credits balance on every column the file has.",
  tbNotBalanced:
    "The columns do not balance, so rows are missing. Export the report again; do not edit it. Nothing can be kept from this file.",
  tbCutoverYes: (date: string) =>
    `That is the day before the start date, ${formatDate(date)}: right for opening balances.`,
  tbCutoverNo: (asOf: string, dayBefore: string) =>
    `The start date is one day after ${formatDate(dayBefore)}, but this trial balance is as at ${formatDate(asOf)}. It is right for the comparison, not for opening balances.`,
  tbCaption: "Accounts in the trial balance",
  colTbAccount: "Xero account",
  colTbNet: "Debit less credit",
  colTbStatus: "Used as",
  colTbMapsTo: "Maps to",
  colTbBalance: "Opening balance",
  status: {
    mapped: "Opening balance",
    skipped: "Left out",
    unmapped: "Not mapped",
    zero: "Zero",
    profit_loss: "Income or expense",
    retained_earnings: "Retained earnings",
  },
  leftOutHeading: "Left out of the opening balances",
  leftOutProfitLoss: (count: number) =>
    `${n(count)} income and expense ${plural(count, "account", "accounts")}: year-to-date amounts.`,
  leftOutUnmapped: (count: number) =>
    `${n(count)} ${plural(count, "account", "accounts")} not mapped.`,
  leftOutSkipped: (count: number) =>
    `${n(count)} ${plural(count, "account", "accounts")} left out on purpose.`,
  leftOutRetained: "Xero's retained earnings.",
  leftOutNote: "The offset account carries what the balances do not explain.",
  statementHeading: "Statement balances",
  statementIntro:
    "Type each bank, card and Stripe account's balance from its statement at the end of the day before the start date. It replaces Xero's figure in the opening balances.",
  statementLabel: (name: string) => `Statement balance for ${name}`,
  statementKept: "Xero's figure is used until you type the statement's.",
  useAsOpening: "Use as opening balances",
  useAsOpeningHint: "The entry is reviewed before anything is posted.",
  keepForComparison: "Keep for the comparison",
  keepingFile: "Keeping…",
  fileKept: (name: string) => `${name} is kept for the comparison.`,

  atTitle: "Account transactions",
  atIntro:
    "Account transactions for one month, all accounts, give the comparison its line by line explanations.",
  atKind: "Xero's Account Transactions report (Reporting, Account Transactions, Export, CSV)",
  atPeriod: (from: string, to: string) => `${formatDateRange(from, to)}.`,
  atCaption: "Accounts in the file",
  colAtAccount: "Xero account",
  colAtLines: "Transactions",
  colAtDebit: "Debit",
  colAtCredit: "Credit",
  colAtTotals: "Total row",
  atTotalsAgree: "Agrees",
  atTotalsDiffer: "Does not agree",
  atTotalsNone: "None in the file",
  atSample: "First transactions",
  atBlocksNote: (blocks: number, lines: number) =>
    `${n(blocks)} ${plural(blocks, "account", "accounts")}, ${n(lines)} ${plural(lines, "transaction", "transactions")}.`,

  reconciledTitle: "Where Xero was reconciled",
  reconciledIntro:
    "The comparison trusts Xero only through the date each of its bank and card accounts was reconciled to its statement.",
  reconciledThrough: (name: string) => `Reconciled through, ${name}`,
  reconciledHint: "Leave empty when it was not reconciled.",
  reconciledNone: "Import the chart first: the bank and card accounts are listed from it.",
  saveReconciled: "Save the dates",
  savingReconciled: "Saving…",
  reconciledSaved: "The dates are saved.",
  compareNow: "Compare with Xero",
} as const;

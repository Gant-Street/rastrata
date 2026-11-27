import { formatCount, formatDate, formatDateRange } from "../format";

/** The words the payees screens use, in one place. A payee is anyone the book pays or is paid by. The
 * screens say "payee" (the 1099 tab says "vendor", the tax word), "received" for money in on income
 * accounts and "spent" for money out on expense accounts, and "transactions" for what the bank wrote.
 * Nothing here says what a payee is owed or owes: the report is the books, grouped. */

const transactions = (count: number): string =>
  count === 1 ? "1 transaction" : `${formatCount(count)} transactions`;

export const words = {
  // The page
  title: "Money by payee",
  reportTitle: "Income and expenses by payee",
  description: "Who you paid and who paid you, with one name for each.",
  helpWhat:
    "A payee is a person or a business you pay or are paid by. This report takes your income and your expenses for the dates you choose and groups them by payee, so you can see what you spent with each and who paid you the most.",
  helpNaming:
    "A bank writes the same payee in many ways (COFFEE SHOP 1234, COFFEE SHOP 5678). The words you give a payee find them: they must appear whole and in order in what the bank wrote, with no patterns and no guessing. What no payee finds is listed as not named yet, where numbers count as one, and each row has a button that names a payee from it.",
  helpTies:
    "Every transaction in your profit and loss is in exactly one place on this page: with a payee, not named yet, matched equally by more than one payee, or with no payee. Together they equal your total income and your total expenses to the cent; if they ever did not, the report would not be shown. Transfers between your own accounts, loan principal, equipment you bought and money you took out for yourself are not income or expenses, so they are not here. A refund takes away from the side it belongs to.",
  helpNothingPosted:
    "Naming a payee changes which row a transaction is in. It never changes the transaction, its account or your profit and loss.",
  loading: "the report by payee",
  loadingBook: "the book",
  chooseDates: "Choose the dates to read.",
  pinned:
    "This report shows the book as it stood at an earlier version, so its figures can differ from today's. Remove “revision” from the address to see the current book.",
  openFailed: "The payee could not be read.",
  payeeNotFound: "This book has no payee with that address. The link may be from another book.",
  changedMeanwhile:
    "This payee was changed since you opened it, so nothing was saved. Close this and open it again to change the current version.",
  payeeFallback: "Payee",
  retry: "Try again",
  emptyTitle: "No income or expenses",
  emptyBody:
    "There is no income and no expense in these dates, so no payee has money to show. Choose other dates.",

  // The controls
  controlsGroup: "Choose the dates and what to show",
  showLabel: "Show",
  showBoth: "Money received and spent",
  showSpent: "Money spent",
  showReceived: "Money received",
  export: "Export",
  exportSummary: "Download the report (CSV)",
  exportTransactions: "Download every transaction (CSV)",
  print: "Print or save as PDF",
  exporting: "Preparing the file",
  exported: (name: string) => `Saved ${name}.`,
  exportFailed: "The file could not be made. Your books have not been changed.",

  // The figures above the tables
  summaryLabel: "Totals for these dates",
  summaryReceived: "Received",
  summarySpent: "Spent",
  summaryNet: "Net",
  summaryTransactions: "Transactions",

  // Payees
  payeesTitle: "Payees",
  payeesNone: "No payee has a transaction in these dates.",
  payeesNoneName: "No payee has a transaction in these dates yet. Name one from the list.",
  columnPayee: "Payee",
  columnReceived: "Received",
  columnSpent: "Spent",
  columnNet: "Net",
  columnWrote: "What the bank wrote",
  columnKind: "Kind of entry",
  columnMatchedBy: "Matched by",
  columnAction: "Action",
  retired: "Retired",
  openPayee: (name: string) => `Open ${name}`,
  rowMeta: (count: number, from: string, to: string) =>
    `${transactions(count)}, ${formatDateRange(from, to)}`,
  payeesShown: (shown: number, total: number) =>
    `${formatCount(shown)} of ${formatCount(total)} payees`,
  transactionsShown: (shown: number, total: number) =>
    `${formatCount(shown)} of ${formatCount(total)} transactions`,
  tableScroll: (caption: string) => `${caption}. Scrolls sideways on a narrow screen.`,

  // Not named yet
  unnamedTitle: "Not named yet",
  unnamedIntro: "What the bank wrote for these matches no payee.",
  nameThis: "Name this payee",
  nameThisFor: (text: string) => `Name this payee, ${text}`,
  seeTransactions: "See transactions",
  seeTransactionsFor: (text: string) => `See transactions, ${text}`,
  unnamedRest: (groups: number, received: string, spent: string, count: number) =>
    `${formatCount(groups)} smaller ${groups === 1 ? "row is" : "rows are"} not listed: ${transactions(count)}, ${received} received and ${spent} spent. Name the larger ones, or choose fewer dates.`,

  // More than one payee
  ambiguousTitle: "Matched by more than one payee",
  ambiguousIntro:
    "These match more than one payee equally well. Change the words of one payee so that they are longer than the others'.",
  ambiguousRest: (groups: number, count: number) =>
    `${formatCount(groups)} more ${groups === 1 ? "row is" : "rows are"} not listed: ${transactions(count)}.`,
  matchedBy: (names: string) => `Matched by ${names}`,
  changePayee: (name: string) => `Change ${name}`,

  // No payee
  noPayeeTitle: "No payee",
  noPayeeIntro: "Entries you typed in yourself, and transactions the bank sent with no name.",
  byHandName: "Entered by hand",
  byHandNote: "Entries you typed in yourself whose own description names no payee.",
  noBankTextName: "No name from the bank",
  noBankTextNote: "Transactions that came with no name and no description.",

  // The proof
  tieIncomeTitle: "Income adds up",
  tieExpensesTitle: "Expenses add up",
  tieIncome: "Total income",
  tieExpenses: "Total expenses",
  tiePayees: "Payees",
  tieUnnamed: "Not named yet",
  tieAmbiguous: "More than one payee",
  tieNoPayee: "No payee",
  tieHolds: "Adds up.",
  tieBroken: "Does not add up",
  tieBrokenBody:
    "These figures should always agree. If you see this, do not rely on this report. Read it again, and tell whoever looks after your books.",
  detailsPayees: "Payees revision",

  // A warning the service attached
  warningInboxTitle: "Names from the bank may be missing",
  warningInboxBody:
    "What the bank wrote could not be read, so every entry was matched on its own description. Some payees may be missing from the rows, and more may be listed as not named yet.",
  warningFallback: "Please note",

  // A payee's transactions
  sheetLoading: "Reading the transactions",
  sheetFailed: "The transactions could not be read.",
  sheetNone: "No transactions in these dates.",
  sheetClose: "Close",
  sheetDates: (from: string, to: string) => formatDateRange(from, to),
  sheetTotals: (count: number) => transactions(count),
  sheetChange: "Change this payee",
  sheetWords: "Words that find this payee",
  sheetNoWords: "No words yet, so nothing is matched to this payee.",
  sheetNote: "Note",
  sheetTax: "This payee is also a 1099 vendor.",
  sheetTaxLink: "Open the 1099 vendors",
  sheetHistory: "Earlier versions",
  sheetHistoryNone: "No earlier version.",
  sheetHistoryRow: (version: number, when: string, who: string, name: string) =>
    `Version ${version}, ${when}, by ${who}: ${name}`,
  sheetUnnamedTitle: "Not named yet",
  sheetAmbiguousTitle: "Matched by more than one payee",
  sheetByHandTitle: "Entered by hand",
  sheetNoBankTextTitle: "No name from the bank",
  sheetUnnamedNote: "Numbers in the text count as one.",
  columnDate: "Date",
  columnAccounts: "Account",
  openEntry: "Open entry",
  openEntryFor: (date: string, text: string) => `Open the entry of ${formatDate(date)}, ${text}`,
  reversal: "A reversal: it is counted with the transaction it undoes.",
  textFromConnector: "From the payment service",
  textFromNarration: "From the entry's own description",
  noText: "No text",
  matchedWords: (key: string) => `Found by “${key}”`,

  // Naming and changing a payee
  nameTitle: "Name this payee",
  changeTitle: "Change this payee",
  nameFrom: "From what the bank wrote",
  fieldName: "Name",
  fieldNameHint: "How you know them. This is what the report shows.",
  fieldWords: "Words that find them",
  fieldWordsHint:
    "Put each set of words on its own row. Each must appear whole and in order in what the bank wrote, with at least three letters or digits: jane doe finds ZELLE PAYMENT TO JANE DOE 4411, but not JANE Q DOE. Never an account number.",
  fieldNote: "Note",
  fieldNoteHint: "Only for you. Never a taxpayer identification number or an account number.",
  formTax: "This payee is also a 1099 vendor, so a change to its name or words is made there too.",
  fieldRetired: "Retired",
  fieldRetiredHint:
    "A retired payee is left out of lists. Its words still find its transactions, so no report changes.",
  nameRequired: "Give the payee a name.",
  wordsRequired: "Give the words that find this payee, or nothing will be matched to it.",
  wordsShort: "Each set of words needs at least 3 letters or digits, or it would match too much.",
  wordsLong: "Each set of words may be at most 120 characters.",
  wordsMany: "A payee has at most 20 sets of words.",
  errorsTitle: "Fix these before saving",
  save: "Save",
  saveAndName: "Name this payee",
  saving: "Saving",
  cancel: "Cancel",
  closeDialog: "Close",
  saved: (name: string) => `Named ${name}.`,
  savedChanged: (name: string) => `Saved ${name}.`,
  savedMoved: (name: string, count: number) =>
    `${name} is a payee now, with ${transactions(count)} in these dates.`,
  uncertain:
    "The reply to the save was lost, so it is not known whether it was saved. Save again: the same request is sent, and it is saved once.",
  saveFailed: "The payee could not be saved. Nothing was changed.",
  testTitle: "What these words find",
  testIdle: "Type the words to see what they find.",
  testReading: "Checking what these words find",
  testFailed: "What these words find could not be checked. You can still save.",
  testNothing: "These words find nothing in these dates. Check them against what the bank wrote.",
  testFinds: (count: number, spent: string, received: string) => {
    const money = [
      spent === "0.00" ? undefined : `${spent} spent`,
      received === "0.00" ? undefined : `${received} received`,
    ].filter((part): part is string => part !== undefined);
    return `These words find ${transactions(count)}${money.length > 0 ? `: ${money.join(" and ")}` : ""}.`;
  },
  testUnnamed: (count: number) =>
    count === 1 ? "1 transaction is not named yet." : `${transactions(count)} are not named yet.`,
  testStays: (count: number) =>
    count === 1
      ? "1 transaction already belongs to this payee."
      : `${transactions(count)} already belong to this payee.`,
  testTaken: (count: number, name: string) =>
    count === 1
      ? `1 transaction belongs to ${name} now and would move to this payee.`
      : `${transactions(count)} belong to ${name} now and would move to this payee.`,
  testAmbiguous: (count: number) =>
    count === 1
      ? "1 transaction matches more than one payee equally now. These words would settle it."
      : `${transactions(count)} match more than one payee equally now. These words would settle them.`,
  testNowhere: (count: number) =>
    count === 1
      ? "1 transaction is an entry with no bank text to tell it apart by."
      : `${transactions(count)} are entries with no bank text to tell them apart by.`,
  testLost: (count: number) =>
    count === 1
      ? "1 transaction that belongs to this payee now would no longer, because the words changed."
      : `${transactions(count)} that belong to this payee now would no longer, because the words changed.`,
  testTied: (count: number, names: string) =>
    count === 1
      ? `1 transaction matches these words as well as ${names}. It would be given to none of them. Make one set of words longer.`
      : `${transactions(count)} match these words as well as ${names}. They would be given to none of them. Make one set of words longer.`,
  testBeaten: (count: number, name: string) =>
    count === 1
      ? `1 transaction contains these words but stays with ${name}, whose words are longer.`
      : `${transactions(count)} contain these words but stay with ${name}, whose words are longer.`,
} as const;

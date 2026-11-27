/** The words of Bring in history. Plain and short: what a person does, in the order they do it. */
export const historyWords = {
  title: "Bring in history",
  description: "Your past years from another system, as entries dated as they were.",
  drop: {
    title: "Drop your file of entries here",
    hint: "A CSV or an Excel file (.xlsx). A longer history goes in parts, oldest first.",
    accept:
      ".csv,.txt,.tsv,.xlsx,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  summary: (entries: string, from: string, to: string) =>
    `${entries} entries, from ${from} to ${to}.`,
  alreadyIn: (count: string) => `${count} of them are already in your books.`,
  dateOrder: "How the dates are written",
  dateOrderHint: "A date like 03/04/2019 can be read either way.",
  dateOrders: { mdy: "Month first (03/14/2019)", dmy: "Day first (14/03/2019)" },
  years: "Years",
  year: "Fiscal year",
  entries: "Entries",
  debits: "Debits",
  accounts: "Accounts",
  accountsHint: "Check the ones chosen for you.",
  addAs: {
    asset: "Add as an asset account",
    liability: "Add as a liability account",
    equity: "Add as an equity account",
    income: "Add as an income account",
    expense: "Add as an expense account",
  },
  fileAccount: "In the file",
  uses: "Times used",
  postedTo: "Posted to",
  notInBook: "Choose an account",
  stillToChoose: (count: number, shown: string) =>
    `${shown} ${count === 1 ? "account still needs" : "accounts still need"} a choice.`,
  problems: "What needs fixing in the file",
  problem: (row: number, message: string) => `Row ${row}: ${message}`,
  moreProblems: (count: number) => `And ${count} more.`,
  fixFile: "Fix the file and choose it again.",
  conflicts: "What stands in the way",
  import: (count: string) => `Import ${count} entries`,
  importAgain: (count: string) => `Import the other ${count}`,
  nothingToDo: "Every entry of this file is already in your books.",
  importing: (done: string, total: string) => `Posting ${done} of ${total}…`,
  stopped: (key: string, date: string, message: string) =>
    `Stopped at entry ${key}, dated ${date}: ${message} Everything before it is posted. Fix the cause, then import again: nothing is posted twice.`,
  doneTitle: (count: string) => `${count} entries are in your books`,
  doneBody: (date: string | null) =>
    date === null
      ? "Compare each year with your old books, then close it."
      : `Your books begin on ${date}. Compare each year with your old books, then close it.`,
  next: { reports: "Open Reports", close: "Close the books" },
  startOver: "Choose another file",
  compare: {
    title: "Compare with your old books",
    drop: {
      title: "Drop your old trial balance here",
      hint: "A CSV or an Excel file (.xlsx) with each account and its debit and credit.",
      accept:
        ".csv,.txt,.tsv,.xlsx,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    date: "As at",
    action: "Compare",
    comparing: "Comparing…",
    tied: (date: string) => `Every account agrees with your old books as at ${date}.`,
    compared: (count: number, shown: string) =>
      `${shown} ${count === 1 ? "account" : "accounts"} compared.`,
    differ: (count: number, shown: string) =>
      `${shown} ${count === 1 ? "account differs" : "accounts differ"} from your old books.`,
    differTable: "Accounts that differ",
    account: "Account",
    oldBooks: "Old books",
    yourBooks: "Your books",
    gap: "Difference",
    notInBooks: "In the file and not in your books",
    problems: "What needs fixing in the file",
    next: "Close the year",
  },
} as const;

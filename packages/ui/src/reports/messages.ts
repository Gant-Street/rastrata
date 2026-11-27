import { formatDate } from "../format";
/** Copy for the report components. It joins the shared message table (see ../messages.ts), so an
 * application can reword or translate it through `UiProvider` without forking. Plain and specific:
 * what a figure is, what it is not, and what to do next. Names, amounts and dates are data and are
 * never in this file. */
export const reportsMessages = {
  statements: {
    profitLoss: "Profit and loss",
    balanceSheet: "Balance sheet",
    cashFlow: "Cash flow",
    trialBalance: "Trial balance",
    generalLedger: "General ledger",
  },
  /** The list of reports: its three groups, and the reports that are pages of their own. */
  index: {
    statements: "Statements",
    detail: "Detail",
    taxTime: "Tax time",
    byPayee: "Money by payee",
    taxWorksheet: "Tax worksheet",
    yearEndPack: "Year-end pack",
    vendors: "1099 vendors",
    salesTax: "Sales tax",
    accountantPack: "Pack for your accountant",
  },
  /** The top of the page: its title, one line, and what "How this works" says. */
  page: {
    title: "Reports",
    description:
      "Your books as statements for any dates. A figure opens the transactions behind it.",
    helpFigures:
      "Every figure is made from the transactions you posted, for the dates you choose, on the basis your book is kept on. Press a figure to see the transactions behind it.",
    helpCompare:
      "A comparison sets the same statement for the period before, or the same period a year earlier, beside this one, with the change. A report by month gives a column for each month of the dates and one for the whole range, so you can see how the months add up.",
    helpByMonth:
      "Every month is read from the same version of your books, so the columns agree with each other and with the total. A comparison and months in columns do not combine.",
    helpShare:
      "A column can show each amount of the profit and loss as a share of total income for the same dates, to one decimal. A comparison is divided by its own dates' income, not this period's. When there is no income there is nothing to compare with, and the page says so. With months in columns it is off.",
    helpDetails:
      "Each report holds what it was built from: the book revision and a fingerprint of the figures. The same books, dates and basis always give the same fingerprint, so anyone can check that a report is the one that was made. The CSV file holds the same facts.",
  },
  groups: {
    income: "Income",
    gain: "Gains",
    unrealizedGain: "Unrealised gains",
    expense: "Expenses",
    asset: "Assets",
    liability: "Liabilities",
    equity: "Equity",
  },
  columns: {
    debit: "Debit",
    credit: "Credit",
    asOf: (date: string) => `As of ${formatDate(date)}`,
    currency: (heading: string, currency: string) => `${heading} · ${currency}`,
  },
  views: {
    loadingBook: "your reports",
    comparedWith: (range: string) => `Compared with ${range}.`,
    equation: "The accounting equation",
    debitsEqualCredits: "Debits equal credits",
    cashTie: "Cash ties out",
    cashAccountsNote: (names: string) => `Cash is the accounts tagged cash: ${names}.`,
    earningsNote:
      "Worked out from each year's postings and carried forward; no closing entry is posted.",
    asOfPeriod: (date: string) => `As of ${formatDate(date)}`,
    heroNetIncome: "Net income",
    heroAssets: "Total assets",
    heroDebits: "Total debits",
    heroNetCash: "Net change in cash",
  },
  /** Said above a report whose address pins an earlier version of the book (`revision=`), which is how a
   * report is reproduced exactly. The version itself is under Report details. */
  pinned:
    "This report shows the book as it stood at an earlier version, so its figures can differ from today's. Remove “revision” from the address to see the current book.",
  period: {
    /** Said where a statement waits for usable dates: the date range names what is wrong with them. */
    chooseDates: "Choose valid dates to see this statement.",
  },
  compare: {
    label: "Compare",
    none: "None",
    previousPeriod: "Previous period",
    previousYear: "Previous year",
    unavailable: "There is nothing to compare with before the book's first fiscal period.",
    /** Why the Compare control is off while months are in columns. */
    offByMonth: "Not available with months in columns.",
  },
  /** The % of income choice on the profit and loss, and its column. */
  share: {
    label: "% of income",
    /** The heading of a share column. */
    heading: "% of income",
    /** What a cell with no share says to a screen reader. */
    none: "No share of income",
    /** Said politely, after the statement and its dates, when a statement arrives with the shares on. */
    announce: "with % of income",
    /** Under the table, whenever a share column is on it. */
    note: "% of income is each amount divided by total income for the same dates, to one decimal. A comparison is divided by its own dates' income.",
  },
  /** The one row of choices above a report: the statements, the dates, the comparison, how the figures
   * are laid out, and Export. */
  toolbar: {
    group: "Report options",
    view: "View",
    byMonth: "By month",
    /** A choice in View: the accounts with nothing in them, which a statement leaves out unless it is asked to show them. */
    emptyAccounts: "Accounts with no activity",
    export: "Export",
  },
  /** The proof a report carries, behind "Report details" at the foot. */
  details: {
    summary: "Report details",
    revision: "Book revision",
    fingerprint: "Fingerprint",
    fingerprintHelp:
      "A fingerprint of exactly what this report was built from: the book at this revision, the dates, the basis and, for the cash flow, the account tags. It is the population hash in the CSV file. The same inputs always give the same fingerprint, so anyone can check that a report is the one that was made.",
    /** What the Copy button next to the name copies ("Copy fingerprint"). */
    fingerprintName: "fingerprint",
    basis: "Basis",
    basisCash: "Cash basis",
    basisAccrual: "Accrual basis",
    currency: "Currency",
    fiscalYear: "Fiscal year",
    columnsSummary: "The fingerprint of each column",
    columnsHelp:
      "Each month was read at the same book revision, so the columns agree with each other and with the total. Each has the fingerprint of its own dates.",
    columnLabel: "Column",
    /** The line a printed report carries in place of the disclosure. */
    printLine: (revision: string, fingerprint: string) =>
      `Book revision ${revision}. Fingerprint ${fingerprint}.`,
  },
  /** A report with a column for each month. */
  monthly: {
    tooMany: (limit: number) =>
      `A report by month shows up to ${limit} months at a time. Choose a shorter range, or show the total.`,
    loading: "the monthly figures",
    notAvailable: "A report by month is not available for this statement.",
    tooManyTitle: "That is too many months to lay out",
    doNotAddTitle: "The months do not add up to the total",
    doNotAdd:
      "The monthly figures do not add up to the total. Do not rely on this report: read it again.",
    notBalancedTitle: "A month does not balance",
  },
  header: {
    basisCash: "Cash basis",
    basisAccrual: "Accrual basis",
    basisHelpTopic: "the basis of this report",
    basisCashHelp:
      "The cash basis counts money when it moves in or out of your accounts. This book is kept on the cash basis, so a report on the accrual basis is not available: it would need the receivables and payables that a cash-basis book does not record.",
    basisAccrualHelp:
      "The accrual basis counts income and expenses when they are recorded, not when money moves. This book is kept on the accrual basis, so a report on the cash basis is not available: it would need the date each receivable and payable was settled, which this book does not record.",
  },
  table: {
    account: "Account",
    amount: "Amount",
    comparative: "Comparative",
    change: "Change",
    drill: (account: string) => `activity for ${account}`,
    drillComparative: (account: string, range: string) => `activity for ${account}, ${range}`,
    /** The tooltip on a figure that leads to the transactions behind it. */
    viewTransactions: "View transactions",
    scroll: (title: string) => `${title}, scroll horizontally on narrow screens`,
    nothing: "Nothing to show for these dates.",
    calculated: "Calculated, not posted",
    total: "Total",
  },
  /** The check a statement makes on itself, as one quiet line under its figures: the result in words
   * when it holds, and the difference with a warning when it does not. */
  tie: {
    balanced: "Balanced.",
    notBalanced: "Does not balance",
    difference: "Difference",
    equals: "equals",
    plus: "plus",
    notBalancedBody:
      "These figures should always agree. If you see this, do not rely on the report: the book or the report compiler has a fault.",
  },
  actions: {
    print: "Print or save as PDF",
    exportCsv: "Download CSV",
    exporting: "Preparing the file…",
    exported: (filename: string) => `Downloaded ${filename}.`,
    exportFailed: "The file could not be created. Your books have not been changed.",
  },
  states: {
    loading: (what: string) => `Loading ${what}…`,
    updating: "Updating the report for the new dates…",
    failedTitle: "The report could not be compiled",
    failedBody: "Your books have not been changed. Try again.",
    retry: "Try again",
    noBookTitle: "No book connected",
    noBookBody: "Set up a book to see its reports.",
    noBookAction: "Go to Home",
    calendarTitle: "Those dates are outside the book's fiscal calendar",
    staleTitle: "The book has changed",
    staleBody: "This report is older than the book. Read it again to see the current figures.",
    reread: "Read the report again",
    uncertainTitle: "The report may be out of date",
  },
  warningTitles: {
    unclassified_accounts: "Some accounts need a tag",
    comparison_unavailable: "There is nothing to compare with",
    share_unavailable: "No income to compare with",
    comparison_share_unavailable: "No income in the comparison period",
    cash_tag_not_an_asset: "A cash tag was set aside",
    tag_ignored: "A tag was ignored",
    fallback: "Please note",
  } as Record<string, string>,
  cashFlow: {
    cashAccounts: "Cash accounts",
    opening: "At the start",
    closing: "At the end",
    change: "Change",
    startOfPeriod: "Cash at the start of the period",
    endOfPeriod: "Cash at the end of the period",
    netChange: "Net change in cash",
    tiesToBalanceSheet: "Equals the cash on the balance sheet",
    unavailableTitle: "The cash flow cannot be shown yet",
    tagAccounts: "Tag accounts",
    notClassifiedFlag: "Needs a tag",
    adjustments: "Adjustments for non-cash items",
    workingCapital: "Changes in working capital",
    netIncome: "Net income",
    section: {
      operating: "Operating activities",
      investing: "Investing activities",
      financing: "Financing activities",
      unclassified: "Not classified",
    },
    sectionTotal: {
      operating: "Net cash from operating activities",
      investing: "Net cash from investing activities",
      financing: "Net cash from financing activities",
      unclassified: "Net cash not classified",
    },
    noActivity: "No activity in these dates.",
  },
  activity: {
    title: "Account activity",
    back: "Back to the report",
    opening: "Opening balance",
    closing: "Closing balance",
    totals: "Totals for these dates",
    postings: (count: number) => (count === 1 ? "1 posting" : `${count} postings`),
    tableCaption: "Account activity table",
  },
  ledger: {
    accounts: "Accounts",
    lines: "Ledger lines",
    code: "Account",
    date: "Date",
    entry: "Entry",
    description: "Description",
    debit: "Debit",
    credit: "Credit",
    balance: "Balance",
    opening: "Opening",
    closing: "Closing",
    postings: (count: number) => (count === 1 ? "1 posting" : `${count} postings`),
    cumulative: "Balance carried forward from the start of the book.",
    fiscalYearToDate:
      "Starts each fiscal year at zero: earnings of earlier years are in retained earnings.",
    position: (from: number, to: number, total: number) =>
      `Showing ${from} to ${to} of ${total} transactions.`,
    none: "No postings in these dates.",
  },
};

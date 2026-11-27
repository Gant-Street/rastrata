import { formatDate } from "../format";
/** Every word the statements components say. Plain and specific: no marketing tone, no claim the
 * product cannot back. Text from a bank file is never in here; it is data and is always shown as
 * plain text by the component that shows it. */
export const words = {
  title: "Import a statement",
  /** The one sentence of the page, while no file has been chosen. */
  intro: "Download your account's activity from your bank as a CSV, OFX, QFX or QBO file.",
  back: "Transactions",

  accountTitle: "Which account is this for?",
  accountLabel: "Account",
  /** The books have no bank or card account yet: the picker's "New account…" makes the first. */
  firstAccountHint: "Your first import makes the account.",
  noAccountsTitle: "No bank or card account yet",
  noAccounts: "The first statement an owner or an administrator imports makes it.",
  accountsFailed: "Your accounts could not be loaded. Try again.",

  fileTitle: "Choose the file",
  dropTitle: "Drop the file here",
  dropOr: "or",
  choose: "Choose a file",
  chooseAnother: "Choose a different file",
  dropActive: "Release to use this file",
  dropLabel: "Statement file",
  dropOne: "Drop one file at a time.",
  tooLarge:
    "That file is larger than 16 MiB. Download a shorter date range and import it in parts.",
  empty: "That file is empty.",
  notStatement: (kind: string) =>
    `That looks like ${kind}, which cannot be imported. Download the statement as CSV, OFX, QFX or QBO from your bank instead.`,
  uploading: (name: string) => `Uploading ${name}…`,
  reading: (name: string) => `Reading ${name}…`,
  uploaded: (name: string, size: string) => `${name} (${size})`,
  uploadFailed: "The file could not be uploaded. Try again.",
  needAccountFirst: "Choose the account first.",

  checkTitle: "Check what was found",
  /** Between the file's name and the account it is for. */
  into: "into",
  /** What was found, in one sentence made of the file's own figures. */
  found: (found: {
    fresh: number;
    already: number;
    keptOut: number;
    leftOut: number;
    range: string;
    endsAt: string;
  }) =>
    [
      found.fresh === 0
        ? "Every transaction in this file was already imported."
        : `${found.fresh} new ${found.fresh === 1 ? "transaction" : "transactions"}${found.range ? `, ${found.range}` : ""}.`,
      found.fresh > 0 && found.already > 0 ? `${found.already} already imported.` : "",
      found.keptOut > 0 ? `${found.keptOut} kept out.` : "",
      found.leftOut > 0 ? `${found.leftOut} ${found.leftOut === 1 ? "row" : "rows"} left out.` : "",
      found.endsAt ? `The statement ends at ${found.endsAt}.` : "",
    ]
      .filter(Boolean)
      .join(" "),
  details: "Details",
  /** Beside "Details" while it is shut: what is inside, in a few words. */
  detailsPreview: (how: string, csv: boolean) =>
    [how, "balance check", csv ? "columns" : ""].filter(Boolean).join(" · "),
  readAs: "How the file was read",
  totals: "In this file",
  presetNote: (name: string) => `Read as the ${name} layout.`,
  profileNote: (name: string) => `Read with your saved profile “${name}”.`,
  detectedNote: "The columns were chosen from the file's header.",
  mappingNote: "Read with the columns you chose.",
  ofxNote: (institution: string, version: string) =>
    `Read as an OFX file${institution ? ` from ${institution}` : ""} (OFX ${version}).`,
  noneNote: "Choose which column holds the date, the amount and the description.",
  accountsInFile: "This file holds more than one account. Choose the one to import.",
  fileAccount: "Account in the file",
  refreshing: "Updating the preview…",
  previewFailed: "The file could not be read. Nothing was imported. Try again.",
  stale: "This preview is out of date. Updating…",

  newLines: "New transactions",
  alreadyImported: "Already imported",
  keptOut: "Kept out on purpose",
  rowsLeftOut: "Rows left out",
  moneyIn: "Money in",
  moneyOut: "Money out",
  net: "Net",
  dateRange: "Dates",
  to: "to",
  linesInFile: (count: number) =>
    `${count} ${count === 1 ? "transaction" : "transactions"} in this file`,
  inCount: (count: number) => `${count} ${count === 1 ? "transaction" : "transactions"}`,

  balanceTitle: "Statement balance",
  balanceReported: (date: string) => `The file says the balance was on ${formatDate(date)}`,
  balanceBooks: "Your books show",
  balanceWaiting: "Waiting for review",
  balanceKept: "Kept out of the books",
  balanceDifference: "Difference",
  balanceDiffers: "Until your opening balance is entered, a difference of that size is expected.",
  balanceUnmapped: "Not compared yet: this account has not been matched to a bank account.",
  balanceNone: "This file does not state a balance, so nothing could be compared.",
  balanceCard: "A card that owes money has a negative balance here.",

  problems: "Problems",
  /** The heading when the reader noticed only notes: nothing is wrong, so nothing is called a problem. */
  notesOnly: "Notes",
  severityError: "Error",
  severityWarning: "Warning",
  severityNote: "Note",
  row: (row: number) => `Row ${row}`,
  showAll: (count: number) => `Show all ${count} problems`,
  showFewer: "Show fewer",
  problemsLabel: "Problems found in the file",

  hints: "Things to check",

  presetTitle: "Bank or card layout",
  presetAuto: "Work it out from the file",
  presetMine: "The columns you chose",
  presetBanks: "Bank accounts",
  presetCards: "Credit cards",
  presetOption: (name: string, _verified: boolean) => name,
  presetExpects: (summary: string) => `This layout expects: ${summary}.`,
  columnsTitle: "Change how the columns are read",
  dateColumn: "Date column",
  dateOrder: "Date order",
  dateOrderAuto: "Work it out from the dates",
  dateOrderMdy: "Month/day/year (03/25/2026)",
  dateOrderDmy: "Day/month/year (25/03/2026)",
  dateOrderYmd: "Year-month-day (2026-03-25)",
  amountStyle: "How are the amounts written?",
  amountSigned: "One column, negative for money out",
  amountSplit: "Two columns: money out and money in",
  amountDirection: "An amount column and a column that says debit or credit",
  amountColumn: "Amount column",
  debitColumn: "Money out column",
  creditColumn: "Money in column",
  directionColumn: "Debit or credit column",
  outValues: "Values that mean money out",
  inValues: "Values that mean money in",
  valuesHint: "Separate values with commas, for example Debit, DR.",
  flip: "Flip the sign of every amount",
  flipHint: "For a card issuer that shows charges as positive numbers.",
  descriptionColumn: "Description column",
  descriptionExtra: "Second description column (optional)",
  referenceColumn: "Reference or check number column (optional)",
  balanceColumn: "Running balance column (optional)",
  none: "None",
  headerRow: "Header row",
  headerRowHint: "The row number that holds the column names. 0 means the file has none.",
  decimalComma: "Amounts use a decimal comma (1.234,56)",
  delimiter: "Column separator",
  delimiterComma: "Comma",
  delimiterSemicolon: "Semicolon",
  delimiterTab: "Tab",
  delimiterPipe: "Pipe",
  chooseColumn: "Choose a column",
  stillToChoose: (parts: string) => `Still to choose: ${parts}.`,
  columnOption: (index: number, header: string, sample: string) =>
    `${index}. ${header || "(no header)"}${sample ? ` · ${sample}` : ""}`,
  saveProfile: "Save these choices for this account",
  profileName: "Name for these choices",
  profileSaved: (name: string) => `Saved as “${name}”.`,
  profileFailed: "The choices could not be saved. Try again.",
  profileNeedsName: "Give these choices a name.",

  startOn: "Start date",
  startOnHint: "Transactions dated before this day are kept out.",
  catchUp: "Adopt this file as history",
  catchUpHint: "For months you entered by hand: nothing waits for review.",
  moreOptions: "More options",
  startOptions: "Start date and history",
  ignoreIds: "Ignore the bank's transaction ids",
  ignoreIdsHint: "Only for a bank that repeats an id on different transactions.",
  flipBalance: "Flip the sign of the statement balance",
  flipBalanceHint: "Only for a card issuer that shows what you owe as a positive balance.",

  sample: "Transactions in this file",
  show: "Show",
  showAll_: "All transactions",
  showNew: "New transactions",
  showDuplicate: "Already imported",
  showOverlap: "Same date, amount and text as an earlier transaction",
  showExcluded: "Kept out on purpose",
  showProblems: "Transactions to look at",
  columnRow: "Row",
  columnDate: "Date",
  columnDescription: "Description",
  columnAmount: "Amount",
  columnStatus: "Status",
  statusDuplicate: "Already imported",
  statusOverlap: "Already imported",
  statusExcluded: "Kept out",
  statusInvalid: "Refused",
  noLinesFilter: "No transactions match this filter.",
  sampleScroll: "Transactions in this file, scroll horizontally on narrow screens",
  flagFormula: "Looks like a formula",
  flagControl: "Has control characters",
  flagDirection: "Has hidden characters",
  flagMarkup: "Looks like HTML",
  flagLink: "Has a script link",
  flagInstruction: "Reads like an instruction",
  flagLineBreak: "Has a line break",
  /** Under the first rows: how many more the file holds, and the button that lists them. */
  moreLines: (count: number) => `${count} more.`,
  showLines: (count: number) => `Show all ${count}`,

  importButton: (count: number) =>
    count === 0
      ? "Nothing new to import"
      : `Import ${count} ${count === 1 ? "transaction" : "transactions"}`,
  importing: "Importing…",
  skipRows: (count: number) =>
    `Leave out the ${count} ${count === 1 ? "row" : "rows"} that cannot be read and import the rest`,
  startOver: "Choose a different file",
  commitFailed: "The import did not go through. Nothing was imported.",

  resultTitle: (count: number) =>
    count === 0
      ? "Nothing new was imported"
      : `${count} ${count === 1 ? "transaction is" : "transactions are"} waiting for review`,
  openInbox: "Open For review",
  importAnother: "Import another file",
  uncertainTitle: "The result is uncertain",
  uncertainBody: "Your import may or may not have gone through. Resume it: do not start a new one.",
  resume: "Resume original request",
  resultCounts: "What the import did",

  historyTitle: "Recent imports",
  historyCaption: "Recent statement imports",
  historyScroll: "Recent imports, scroll horizontally on narrow screens",
  historyDate: "Date",
  historyFile: "File",
  historyAccount: "Account",
  historyNew: "New",
  historyAlready: "Already imported",
  historyKept: "Kept out",
  unnamedFile: "(unnamed file)",
  historyFailed: "The import history could not be loaded.",
};

import { formatDate } from "../format";
/** Every user-facing string the chart components own. Like the core catalogue in ../messages.ts,
 * components read their copy from here and accept partial overrides, so an application can
 * reword or translate without forking. Data (account names, codes, form lines) is never in this
 * file. Copy is plain and specific; it never promises more than the book does. */

export const chartMessages = {
  wizard: {
    title: "Set up your books",
    stepsLabel: "Setup steps",
    stepOf: (step: number, total: number, title: string) => `Step ${step} of ${total}: ${title}`,
    back: "Back",
    continue: "Continue",
    create: "Create book",
    creating: "Creating book…",
    cannotChange: "The currency and basis cannot be changed after the book is created.",
    steps: {
      business: "Your business",
      kind: "Type of business",
      books: "Accounting method",
      review: "Review and create",
    },
  },
  business: {
    name: "Business name",
    nameHint: "Shown on your reports. Use your legal name or the name you trade under.",
    nameRequired: "Enter your business name.",
    nameShort: "Enter at least two characters.",
    nameTooLong: "Use 120 characters or fewer.",
    currency: "Currency",
    currencyHint: "This cannot be changed after the book is created.",
    currencyChoices: {
      USD: "USD · US dollar",
      EUR: "EUR · Euro",
      GBP: "GBP · British pound",
    } as Record<string, string>,
  },
  kind: {
    loading: "Loading the types of business…",
    legend: "What kind of business is this?",
    help: "This chooses your starting chart of accounts.",
    addOnLegend: "Add accounts for",
    stripe: "I take payments through Stripe",
    required: "Choose the type of business.",
  },
  books: {
    basisLegend: "How do you keep your books?",
    cash: "Cash",
    cashHelp: "Income counts when money arrives and expenses when money leaves.",
    accrual: "Accrual",
    accrualHelp:
      "Income counts when you earn it and expenses when you owe them. You record invoices and bills yourself, as journal entries.",
    basisWarningTitle: "This cannot be changed after the book is created",
    basisWarning: "Not sure which your tax return uses? Ask whoever prepares your taxes.",
    basisRequired: "Choose cash or accrual.",
  },
  review: {
    heading: "Review your chart",
    summaryHeading: "Your choices",
    business: "Business",
    currency: "Currency",
    booksStart: "Books start",
    basis: "Basis",
    kind: "Type of business",
    addOns: "Add-ons",
    none: "None",
    chartHeading: (count: number) => `Chart of accounts (${count} accounts)`,
    loading: "Building your chart…",
    loadFailedTitle: "The chart could not be built",
    loadFailedBody: "Nothing has been created. Check your connection and try again.",
    retry: "Try again",
    fixFirst: "Fix these before creating the book.",
    createFailedTitle: "The book was not created",
    /** The whole of what the opened chart says: which form the lines are on, and that nothing here is
     * final. The form's year and whether the IRS has finished it are for the Taxes page, where a person
     * can act on them. */
    taxNotice: (form: string) => `Tax lines are from ${form}.`,
    chartChange: "You can change any account later.",
  },
  editor: {
    caption: "Chart of accounts",
    scrollLabel: "Chart of accounts, scroll horizontally on narrow screens",
    columnCode: "Code",
    columnName: "Name",
    columnClass: "Cash flow",
    columnTaxLine: "Tax line",
    columnActions: "Actions",
    code: (name: string) => `Code for ${name}`,
    name: (code: string) => `Name of account ${code}`,
    cashFlow: (name: string) => `Cash-flow class for ${name}`,
    taxLine: (name: string) => `Tax line for ${name}`,
    noTaxLine: "No tax line",
    notSet: "Not set",
    taxLineHelp:
      "A line of the IRS form for the tax year shown, offered where the line takes this kind of account. Rastrata files nothing.",
    remove: (name: string) => `Remove ${name}`,
    add: (group: string) => `Add an account to ${group}`,
    newAccount: "New account",
    roleKey: (key: string) => `Role: ${key}`,
    groups: {
      asset: "Assets",
      liability: "Liabilities",
      equity: "Equity",
      income: "Income",
      expense: "Expenses",
    } as Record<string, string>,
    classes: {
      cash: "Cash",
      operating: "Operating",
      investing: "Investing",
      financing: "Financing",
      noncash: "Non-cash",
    } as Record<string, string>,
    classHelp:
      "Cash accounts are where money sits. The others say which part of the cash-flow statement an account's changes belong to.",
    empty: "There are no accounts. Add one to each group you need.",
    shortRequired: "Required",
    shortDuplicate: "Already used",
    shortInvalid: "Not a valid code",
    shortTooLong: "Too long",
    noAccounts: "No accounts in this group.",
    codeInvalid: (code: string) =>
      `Code "${code}" must be 2 to 20 letters, digits, hyphens or underscores, starting with a letter or digit.`,
    codeMissing: "Enter a code for every account.",
    codeDuplicate: (code: string) =>
      `Code ${code} is used twice. Every account needs its own code.`,
    nameMissing: (code: string) => `Enter a name for account ${code}.`,
    nameTooLong: (code: string) => `The name of account ${code} is longer than 120 characters.`,
    needAsset: "Keep at least one asset account.",
    tooMany: "A chart can have at most 200 accounts.",
  },
  accounts: {
    caption: "Chart of accounts",
    columnAccount: "Name",
    columnBalance: "Balance",
    closed: (date: string) => `Closed ${formatDate(date)}`,
    types: {
      bank: "Bank",
      card: "Card",
      asset: "Asset",
      liability: "Liability",
      equity: "Equity",
      income: "Income",
      expense: "Expense",
      gain: "Gain",
      unrealizedGain: "Unrealized gain",
    } as Record<string, string>,
    classes: {
      cash: "Cash",
      operating: "Operating",
      investing: "Investing",
      financing: "Financing",
      noncash: "Non-cash",
    } as Record<string, string>,
    /** The chart's five kinds, as the folded chart names them. */
    groups: {
      asset: "Assets",
      liability: "Liabilities",
      equity: "Equity",
      income: "Income",
      expense: "Expenses",
    } as Record<string, string>,
    /** How many accounts a kind has, said after its name to a screen reader ("Expenses, 24 accounts"). */
    groupCount: (count: number) => `, ${count} ${count === 1 ? "account" : "accounts"}`,
    /** The accounts of a kind that are not listed at rest: a zero balance, or closed. */
    restCount: (count: number) => `${count} more with nothing in ${count === 1 ? "it" : "them"}.`,
    restShow: (count: number) => (count === 1 ? "Show it" : "Show them"),
    restHide: (count: number) => (count === 1 ? "Hide the empty one" : "Hide the empty ones"),
    search: "Search accounts",
    searchHint: "Code, name, type or tax line. Press / to search from anywhere.",
    emptyTitle: "No accounts match",
    emptyBody: "Try another search.",
  },
  tagEditor: {
    types: {
      asset: "Asset",
      liability: "Liability",
      equity: "Equity",
      income: "Income",
      expense: "Expense",
      gain: "Gain",
      unrealizedGain: "Unrealized gain",
    } as Record<string, string>,
    classes: {
      cash: "Cash",
      operating: "Operating",
      investing: "Investing",
      financing: "Financing",
      noncash: "Non-cash",
    } as Record<string, string>,
    tagNames: {
      cashFlowClass: "Cash-flow class",
      taxLine: "Tax line",
      roleKey: "Role key",
    } as Record<string, string>,
    effectiveOn: "Effective from",
    effectiveOnHint:
      "Reports from this date on use the new tags. Earlier dates keep what they had. Nothing in your books changes.",
    dateInvalid: "Enter a real date from 2000 to 2100.",
    dateBeforeOpened: (date: string) =>
      `This account opened on ${formatDate(date)}. Choose that date or later.`,
    fromOpening: (date: string) => `Use the date the account opened (${formatDate(date)})`,
    fromToday: "Use today",
    closedTitle: (count: number) =>
      count === 1 ? "This date reaches a closed period" : "This date reaches closed periods",
    closedBody: (periods: readonly string[]) =>
      `${periods.join("; ")}. Saving changes how reports for ${
        periods.length === 1 ? "it group" : "them group"
      } this account, so they will differ from the reports recorded when ${
        periods.length === 1 ? "it was" : "they were"
      } closed. Choose a date after the last closed period to leave ${
        periods.length === 1 ? "it" : "them"
      } as it was.`,
    cashFlow: "Cash-flow class",
    cashFlowHint:
      "Where this account's changes belong in the cash-flow statement. Cash accounts are where money sits.",
    notSet: "Not set",
    taxLine: "Tax line",
    taxLineHint: "Leave it empty if none fits.",
    noForms: "No tax lines are available for this book.",
    noTaxLine: "No tax line",
    unknownLine: (line: string) =>
      `The current tag, ${line}, is not a line on the form shown. It is kept unless you choose another.`,
    roleKey: "Role key",
    roleKeyHint:
      "Optional. A short key other parts of Rastrata use to find this account, such as stripe.balance. Each key belongs to one account. Leave it empty to clear it.",
    roleKeyInvalid: (max: number) =>
      `Use lower-case words joined by dots or hyphens, such as stripe.balance (at most ${max} characters).`,
    save: "Save tags",
    saving: "Saving…",
    close: "Close",
    savedTitle: "Tags saved",
    saved: (date: string) =>
      `The tags apply from ${formatDate(date)}. Earlier dates keep what they had.`,
    unchangedTitle: "Nothing changed",
    unchanged: (date: string) =>
      `The account already had these tags on ${formatDate(date)}. Choose a different value, or a different date, to change them.`,
    errorTitle: "The tags were not saved",
    uncertainTitle: "The result of the last save is not known",
    uncertain:
      "The reply was lost, so the change may have been saved. Resume the original request to find out; do not make the change again.",
    resume: "Resume original request",
    historyTitle: "History of this account's tags",
    historyLoading: "Loading the history…",
    historyEmpty: "No tags have ever been set on this account.",
    eventSetup: "Set when the book was created.",
    eventRecorded: (date: string) => `Recorded on ${formatDate(date)}.`,
    eventSet: (name: string, value: string) => `${name}: ${value}`,
    eventCleared: (name: string) => `${name}: cleared`,
  },
};

export type ChartMessages = typeof chartMessages;
export type ChartMessageOverrides = {
  [K in keyof ChartMessages]?: Partial<ChartMessages[K]>;
};

/** Overrides win key by key, so a translation can be partial and fall back to English. */
export function mergeChartMessages(overrides?: ChartMessageOverrides): ChartMessages {
  if (!overrides) return chartMessages;
  const result: Record<string, unknown> = { ...chartMessages };
  for (const [group, patch] of Object.entries(overrides))
    result[group] = { ...(chartMessages as Record<string, object>)[group], ...patch };
  return result as ChartMessages;
}

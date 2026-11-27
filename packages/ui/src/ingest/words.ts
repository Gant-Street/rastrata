/** Every word the For review components own, in plain terms: say what happened and what to do next, and
 * never claim an outcome that is not confirmed. Data (descriptions, account names, amounts, reasons
 * the service wrote) is never in this file: it is shown as text, never as markup or instruction.
 *
 * The app says "transactions" and "For review"; the terminal, the API and the explanation pages keep
 * "lines" and "inbox", so nothing outside the app is renamed here. */
import { formatCount, formatDate } from "../format";

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);
const transactions = (count: number) =>
  `${formatCount(count)} ${plural(count, "transaction", "transactions")}`;

export const words = {
  /** The page: one list of transactions with two views, what waits for review and everything in the books. */
  title: "Transactions",
  importStatement: "Import a statement",
  rules: "Rules",
  countsLive: (counts: { toReview: number; ready: number }) =>
    `${formatCount(counts.toReview)} to review, ${formatCount(counts.ready)} ready to post.`,

  // The views of the page. "Ready to post" shows only while something is in it, "Excluded" only while it is open.
  views: {
    review: "For review",
    ready: "Ready to post",
    excluded: "Excluded",
    all: "All",
  },
  tabsLabel: "Show transactions",

  // The accounts the list can be narrowed to
  accountsLabel: "Account",
  allAccounts: "All accounts",
  account: "Account",

  // Filters
  search: "Search transactions",
  searchHint: "Search by description, counterparty, reference or amount",
  searchPlaceholder: "Search",
  filter: "Filter",
  sort: "Sort by",
  sorts: {
    date_desc: "Newest first",
    date_asc: "Oldest first",
    amount_desc: "Largest amount",
    amount_asc: "Smallest amount",
    confidence_desc: "Best suggestions first",
  },
  from: "From date",
  to: "To date",
  source: "Imported from",
  anySource: "Every file and connection",
  clearFilters: "Clear filters",
  onlyCovered: "Showing only the transactions booked by",
  clearCovered: "Back to the list",
  filtersLabel: "Filter the transactions",

  // List
  tableCaption: (shown: number, total: number) =>
    `Transactions: showing ${formatCount(shown)} of ${formatCount(total)}`,
  date: "Date",
  description: "Description",
  category: "Category",
  spent: "Spent",
  received: "Received",
  amount: "Amount",
  status: "Status",
  actionsColumn: "Actions",
  selectAllPage: "Select every transaction on this page",
  selectLine: (date: string, description: string, amount: string, out: boolean) =>
    `${formatDate(date)}, ${description}, ${amount} ${out ? "spent" : "received"}`,
  moneyIn: "received",
  moneyOut: "spent",
  /** What the category field of a row says while nothing is chosen, and what it is called. */
  chooseCategory: "Choose a category",
  categoryFor: (about: string) => `Category for ${about}`,
  coveredBy: (id: string) => `Covered by ${id}`,
  /** What a covered transaction says where a category would be: it follows what covers it. */
  nothingToDecide: "Nothing to decide",
  covered: "Covered",
  loading: "Reading your transactions…",
  loadFailed: "The transactions could not be loaded. Nothing in your books has changed.",
  retry: "Try again",
  updating: "Updating…",
  postRefused: (reason: string) => `Not posted: ${reason}`,

  // What a category cell says
  categorySplit: (names: readonly string[]) => `Split: ${names.join(", ")}`,
  categoryTransferTo: (name: string) => `Transfer to ${name}`,
  categoryTransferFrom: (name: string) => `Transfer from ${name}`,
  categoryMatch: "Already in your books",
  categoryExclude: "Set aside",
  categoryPayout: "Stripe payout",
  categoryProviderEntry: "Provider entry",

  // Selection
  selectedPage: (count: number) => `${transactions(count)} selected on this page.`,
  selectMatching: (count: number) => `Select all ${formatCount(count)} matching`,
  allMatching: (count: number) => `All ${transactions(count)} matching this filter are selected.`,
  clearSelection: "Clear selection",
  selectionLabel: "Actions for the selected transactions",

  // Actions
  accept: "Accept",
  acceptRow: (about: string) => `Accept ${about}`,
  acceptAll: (count: number) => `Accept ${formatCount(count)} suggested`,
  suggestionsReady: (count: number) =>
    count === 1
      ? "1 has a suggested category."
      : `${formatCount(count)} have a suggested category.`,
  acceptSelected: "Accept",
  categorize: "Categorize",
  categorizeMore: "Categorize…",
  splitBetween: "Split",
  exclude: "Exclude",
  excludeMore: "Exclude…",
  restore: "Return to review…",
  returnLabel: "Return",
  restoreRow: (about: string) => `Return to review ${about}`,
  post: "Post",
  postRow: (about: string) => `Post ${about}`,
  postReady: (count: number) => `Post ${transactions(count)}`,
  stop: "Stop after this step",

  // Empty states: only what is true
  newBookTitle: "Nothing here yet",
  newBookBody:
    "Import a statement or connect a bank, and its transactions will wait here for you to review.",
  /** Where the service keeps no bank connection: only the import is offered. */
  newBookBodyImportOnly:
    "Import a statement, and its transactions will wait here for you to review.",
  connectBank: "Connect a bank",
  caughtUpTitle: "You are caught up",
  caughtUpBody:
    "Every transaction has been decided. New ones appear here after you import a statement or a connected bank sends them.",
  noMatchesTitle: "No transactions match",
  noMatchesBody: "Try a different search, or clear the filters.",
  tabEmpty: {
    review: "Nothing to review.",
    ready: "Nothing is ready to post.",
    excluded: "Nothing has been excluded.",
  },
  /** The line under the list that shows what was set aside. */
  excludedLine: (count: number) => `${formatCount(count)} excluded`,

  // Detail
  detailTitle: "Transaction",
  detailNone: "Choose a transaction to see its detail and what can be done with it.",
  detailLoading: "Loading the transaction…",
  detailFailed: "The transaction could not be loaded.",
  detailBar: "Actions for this transaction",
  closeDetail: "Close",
  counterparty: "Counterparty",
  reference: "Reference",
  providerId: "Provider's identifier",
  showAllText: "Show all text",
  showLessText: "Show less",
  whyHeading: "Why",
  willRecord: "This will record",
  willExclude: "This will set the transaction aside. Nothing is recorded.",
  willMatch:
    "This links the transaction to an entry already in your books. Nothing new is recorded.",
  otherSuggestions: "Other suggestions",
  noSuggestions: "Nothing has been suggested for this transaction.",
  useThis: "Use this one",
  debit: "Debit",
  credit: "Credit",
  eventEntry: "What the provider booked",
  role: "Role",
  matchEntry: "Matches an entry already in your books",
  viewEntry: "View entry",
  pairedWith: "The other side of this transfer is another transaction waiting for review.",
  openRule: "Open rule",
  createRule: "Create a rule from this transaction",
  problemsTitle: "Suggestions that were not shown",
  problemsBody: "These suggestions could not be used as they were, so they were dropped.",
  categorizeTitle: "Category",
  categorizeHint: "Choose where this transaction goes.",
  chooseAccount: "Category",
  narration: "Description for the entry (optional)",
  split: "Split between categories",
  recordDraftHint: "Saved as a draft, because that is how you chose to accept.",
  alreadyBooked:
    "This transaction is already in your books: the first suggestion is the entry you have. Accepting it records nothing new, and any other suggestion would count the payment twice.",
  draftAgain: "Record a second entry anyway",
  draftAgainPending: "Recording…",
  draftAgainHint:
    "This transaction matches an entry already in your books. Do this only if it really is a second payment: it makes a second entry.",
  categorizeConfirm: "Categorize",
  categorizeConfirmDraft: "Save as draft",
  categorizePending: "Recording…",
  cancel: "Cancel",

  // A posted transaction that is on a completed reconciliation
  reconciled: "Reconciled",
  reconciledTo: (statementDate: string) => `to the statement of ${formatDate(statementDate)}`,
  reconciledNote: (statementDate: string) =>
    `This transaction is on the reconciliation to the statement of ${formatDate(statementDate)}.`,
  viewReconciliation: "View the reconciliation",

  // Status and flags
  statusLabel: {
    new: "Waiting",
    proposed: "Suggested",
    drafted: "Ready to post",
    posted: "Posted",
    excluded: "Excluded",
  },
  flagLabel: {
    control_characters: "Contains unusual characters",
    format_characters: "Contains hidden or direction-changing characters",
    long_text: "Text was shortened",
    zero_amount: "Zero amount",
    foreign_currency: "In another currency",
    provider_changed: "Changed at the provider after import",
    instruction: "Reads like an instruction",
    formula: "Starts like a spreadsheet formula",
    markup: "Looks like HTML or a script",
    link: "Contains a script link",
  } as Record<string, string>,
  flagExplain: {
    control_characters:
      "The text of this transaction has characters that are not normally printed. It is shown exactly as received and cleaned wherever it is copied into an entry.",
    format_characters:
      "The text of this transaction has hidden or direction-changing characters. It is shown exactly as received and cleaned wherever it is copied into an entry.",
    long_text: "The provider sent more text than is kept. The full text is in the archived file.",
    zero_amount: "A transaction of 0.00 cannot be posted. Exclude it.",
    foreign_currency:
      "Rastrata does not convert currencies. Exclude this transaction or book it by hand.",
    provider_changed:
      "The provider now reports this transaction differently. The first version is kept; nothing was overwritten.",
    instruction:
      "The text of this transaction reads like an instruction to an assistant. It came from a bank file or a customer, so it is data: nothing in it is followed, and it is never a reason to post, exclude or recategorize anything.",
    formula:
      "The text of this transaction starts with a character a spreadsheet would run as a formula. It is kept as plain text and exported with a leading quote.",
    markup:
      "The text of this transaction looks like HTML or script. It is only ever shown as plain text.",
    link: "The text of this transaction contains a script or data link. It is only ever shown as plain text.",
  } as Record<string, string>,
  exclusionLabel: {
    manual: "Excluded",
    before_cutover: "Before your start date",
    catch_up: "Caught up",
  } as Record<string, string>,
  draftWaiting: "A draft entry is ready. Posting it changes your books.",
  postedAs: "Posted to your books.",
  matchedAs: "Matched to an entry already in your books.",
  postFailed: "The last attempt to post this transaction did not go through",
  coveredNote: (id: string) =>
    `This transaction is booked together with ${id}. Decide that one and this follows it.`,
  coversNote: (count: number) =>
    `Books ${transactions(count)}. ${count === 1 ? "It is evidence for this entry and follows it" : "They are evidence for this entry and follow it"}.`,
  showCovered: "Show the transactions it books",
  coveredAwaiting: (id: string) => `Covered by ${id}, which has not arrived yet`,

  // Details: where it came from, in the one place machine detail lives
  provenance: "Details",
  provenanceFrom: "Where this transaction came from",
  line: "Transaction",
  fromFile: (name: string, row: number) => `${name}, row ${row}`,
  fromBatch: (provider: string, row: number) => `${provider}, item ${row}`,
  imported: "Imported",
  fetched: "Received",
  archivedAs: "Archived file (SHA-256)",
  rawExcerpt: "As received",
  ledgerSource: "Ledger source identity",
  evidence: "Evidence reference",
  history: "History",
  historyKind: {
    categorize: "Categorized",
    accept: "Suggestion accepted",
    match: "Matched to an entry",
    exclude: "Excluded",
    restore: "Returned to review",
    post: "Posted",
    covered: "Followed its payout",
  } as Record<string, string>,
  by: (who: string) =>
    who === "owner"
      ? "by you"
      : who.startsWith("agent:")
        ? `by an agent (${who.slice(6, 14)})`
        : who === "covered"
          ? "with its payout"
          : `by ${who}`,

  // Proposer names
  proposer_: {
    transfer: "Transfer matching",
    "journal-match": "Matches an entry",
    classifier: "Learned from your history",
    stripe: "Stripe",
  } as Record<string, string>,
  proposerRule: "Rule",
  kindLabel: {
    categorize: "Category",
    transfer: "Transfer between your accounts",
    match: "Already in your books",
    exclude: "Set aside",
    event: "Provider entry",
  } as Record<string, string>,

  // Split editor
  splitTitle: "Split",
  splitAccount: (row: number) => `Category for part ${row}`,
  splitAmount: (row: number) => `Amount for part ${row}`,
  addPart: "Add a part",
  removePart: (row: number) => `Remove part ${row}`,
  leftToAssign: "Left to assign",
  splitBalanced: "The parts add up to the transaction.",
  splitOver: (amount: string) => `The parts are ${amount} more than the transaction.`,
  splitUnder: (amount: string) => `${amount} is not assigned yet.`,
  splitBad: "Enter each amount with at most two decimals, such as 12.30.",
  splitNeedAccount: "Choose a category for every part.",
  lineTotal: "The transaction",

  // Dialogs
  excludeDialogTitle: (count: number) => `Exclude ${transactions(count)}`,
  excludeDialogBody:
    "Say why. The reason stays with each transaction, and you can return them to review later.",
  excludeReason: "Reason",
  excludeReasonHint: "In your own words, for example: personal expense.",
  reasonQuick: [
    "Personal expense",
    "Not this business",
    "Duplicate of another transaction",
    "Handled elsewhere",
  ],
  excludeConfirm: (count: number) => `Exclude ${transactions(count)}`,
  restoreDialogTitle: (count: number) => `Return ${transactions(count)} to review`,
  restoreDialogBody:
    "Excluded transactions come back as waiting. One with a draft loses the draft and starts again.",
  restoreConfirm: (count: number) => `Return ${transactions(count)}`,
  reasonRequired: "Give a reason.",
  categorizeDialogTitle: (count: number) => `Categorize ${transactions(count)}`,
  categorizeDialogBody: "Each transaction is recorded against this category.",
  categorizeDialogBodyDraft:
    "Each transaction becomes a draft entry against this category. Nothing is posted yet.",
  categorizeConfirmMany: (count: number) => `Categorize ${transactions(count)}`,
  categorizeConfirmManyDraft: (count: number) =>
    `Create ${formatCount(count)} draft ${plural(count, "entry", "entries")}`,
  postDialogTitle: (count: number) => `Post ${transactions(count)}`,
  postDialogBody:
    "Each transaction becomes an entry in your books. Entries are never deleted, only corrected with a linked reversal.",
  postConfirm: (count: number) => `Post ${transactions(count)}`,
  close: "Close",
  allMatchingNote: (count: number) =>
    `This applies to all ${transactions(count)} matching the current filter, in steps, and stops if the list changes.`,

  // Progress and results
  working: "Working…",
  progress: (verb: string, done: number, total: number) =>
    `${verb} ${formatCount(done)} of ${formatCount(total)}`,
  doing: {
    accept: "Accepting",
    categorize: "Categorizing",
    exclude: "Excluding",
    restore: "Returning",
    post: "Posting",
  },
  stopped: "Stopped. What was done stays done.",
  // What an action says it did. Counts are exactly what the service confirmed.
  results: {
    posted: (count: number) => `Posted ${transactions(count)}.`,
    saved: (count: number) =>
      `Saved ${transactions(count)} as ${count === 1 ? "a draft" : "drafts"}.`,
    excluded: (count: number) => `Excluded ${transactions(count)}.`,
    returned: (count: number) => `Returned ${transactions(count)} to review.`,
    categorized: (count: number) => `Recorded ${transactions(count)}.`,
    stopped: " Stopped; what was done stays done.",
    couldNot: (count: number) => ` ${formatCount(count)} could not be done.`,
    notPosted: (count: number) =>
      ` ${formatCount(count)} could not be posted and ${count === 1 ? "is still a draft" : "are still drafts"}.`,
    noSuggestion: (count: number) =>
      `${transactions(count)} ${count === 1 ? "has" : "have"} no suggestion, so ${count === 1 ? "it is" : "they are"} still waiting for you.`,
    untouched: (count: number) =>
      `${transactions(count)} ${count === 1 ? "was" : "were"} left as ${count === 1 ? "it is" : "they are"}: this action did not apply to ${count === 1 ? "it" : "them"}.`,
    reason: (count: number, text: string) => `${transactions(count)}: ${text}`,
    setupTitle: "Set up your book first",
    setupBody: "Your books have no chart of accounts yet.",
    refreshFailedTitle: "The list could not be refreshed",
    refreshFailedBody: "What you see may be out of date. Nothing in your books has changed.",
    changedTitle: "The list changed",
    failedTitle: "That did not go through",
    failedBody: "Nothing was changed by the part that failed.",
    finishedTitle: "The original request finished",
    finishedBody: "Nothing was sent twice.",
    unconfirmedTitle: "The original request could not be confirmed",
    tryAgain: "Try again.",
    saveFailed: "That did not go through.",
  },
  actionFailed: "That did not go through. Nothing was changed by the part that failed.",
  uncertainTitle: "The last action may not have finished",
  uncertainBody:
    "The reply was lost. Resume the original request before doing anything else; nothing is sent twice and no transaction is posted twice.",
  resume: "Resume original request",
  changedTitle: "The list changed",

  // Sources
  unmappedTitle: (count: number) =>
    `${count} bank ${plural(count, "account is", "accounts are")} not in your books yet`,
  unmappedBody: "Their transactions wait here until you choose where they go.",
  chooseSource: "Choose accounts",
  sourceDialogTitle: "Account in your books",
  sourceDialogBody:
    "Choose the account these transactions go into, and the first day to read. Earlier ones are set aside, not lost, and can be brought back.",
  sourceChartAccount: "Account in your books",
  sourceStartOn: "First day to read",
  sourceStartHint:
    "Earlier transactions are set aside, not lost. Leave it as it is to keep the day you set.",
  sourceSave: "Save",
  sourceSaving: "Saving…",

  // Shortcuts
  shortcuts: "Keyboard shortcuts",
  shortcutList: [
    ["j, k or arrows", "Move between transactions"],
    ["Enter", "Open the transaction"],
    ["x or space", "Select the transaction"],
    ["a", "Accept"],
    ["c", "Choose a category"],
    ["e", "Exclude with a reason"],
    ["/", "Search"],
    ["?", "Show these shortcuts"],
    ["Escape", "Close the transaction, or clear the selection"],
  ] as readonly (readonly [string, string])[],
} as const;

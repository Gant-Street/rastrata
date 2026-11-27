import { dateInputOrder, formatDate } from "./format";
import { kitMessages } from "./kit/messages";
import { reportsMessages } from "./reports/messages";

/**
 * Every user-facing string the components own. Components never hard-code copy: they read it
 * from here, so an application can translate or reword it through `UiProvider` without forking.
 *
 * Wording follows the heuristics that matter most for accounting software: plain language that
 * says what happened and what to do next (match with the real world; recognize, diagnose and
 * recover from errors). Data such as account names, references and amounts is never in this file.
 */

export const defaultMessages = {
  field: {
    required: "required",
    error: "Error",
    help: (topic: string) => `Help: ${topic}`,
    closeHelp: "Close help",
  },
  pager: {
    label: "Pagination",
    previous: "Previous page",
    next: "Next page",
    position: (page: number, pages: number) => `Page ${page} of ${pages}`,
  },
  password: { show: "Show", hide: "Hide" },
  pin: { digit: (index: number, count: number) => `Digit ${index} of ${count}` },
  select: { placeholder: "Select an option" },
  account: {
    label: "Account",
    placeholder: "Search by name or code",
    show: "Show accounts",
    choose: "Choose a posting account. Group accounts cannot receive entries.",
    unavailable: (id: string) =>
      `Account ${id} is unavailable. Its ID is retained; choose a replacement explicitly.`,
    loading: "Loading accounts…",
    loadError: "Accounts could not be loaded. Try again.",
    noMatch: "No matching accounts. Try another name or code.",
    // The kit's picker (kit/account-picker.tsx) adds these.
    none: "There are no accounts yet.",
    create: "New account…",
    chooseAny: "Choose an account.",
    closed: "Closed account",
    /** The heading each kind of account is listed under. */
    headings: {
      asset: "Assets",
      liability: "Liabilities",
      equity: "Equity",
      income: "Income",
      expense: "Expenses",
      gain: "Gains",
      unrealizedGain: "Unrealized gains",
    } as Record<string, string>,
  },
  date: {
    posting: "Posting date",
    period: "Reporting period",
    start: "Start date",
    end: "End date",
    startOf: (label: string) => `${label} start`,
    endOf: (label: string) => `${label} end`,
    open: "Open calendar",
    previousMonth: "Previous month",
    nextMonth: "Next month",
    format: (locale: string) => `${dateInputOrder(locale)} · Date only, no time zone conversion`,
  },
  dialog: { close: "Close" },
  summary: { title: "There is a problem" },
  breadcrumbs: { label: "Breadcrumb" },
  status: { Draft: "Draft", Posted: "Posted" } as Record<string, string>,
  register: {
    caption: "Transactions",
    scrollLabel: "Transactions, scroll horizontally on narrow screens",
    searchLabel: "Search transactions",
    searchPlaceholder: "Search",
    searchHint: "Search by description, number or amount",
    filtersLabel: "Filter the transactions",
    newEntry: "New journal entry",
    dates: "Posting dates",
    accountFilter: "Account",
    statusFilter: "Status",
    allAccounts: "All accounts",
    allStatuses: "All statuses",
    endDatePrompt: "Choose an end date to apply the date filter.",
    appliedFilters: "Applied filters",
    activeFilters: "Active filters",
    removeSearch: (query: string) => `Remove search: ${query}`,
    removeFilter: (label: string) => `Remove ${label}`,
    filterAccount: (label: string) => `Account: ${label}`,
    filterDates: (from: string, to: string) => `Dates: ${formatDate(from)} – ${formatDate(to)}`,
    filterStatus: (status: string) => `Status: ${status}`,
    clearAll: "Clear all filters",
    refreshing: "Refreshing transactions… The ones shown stay until the new ones are read.",
    selectedAcross: (count: number) => `${count} selected across pages`,
    outsideFilters: (count: number) => `${count} outside current filters`,
    reviewSelected: "Review selected",
    clearSelection: "Clear selection",
    loadFailedTitle: "Transactions could not be loaded",
    loadFailedBody: "Your books have not been changed.",
    retry: "Try again",
    loadingLabel: "Loading transactions",
    loadingText: "Reading your transactions…",
    noMatchesTitle: "No transactions match",
    noEntriesTitle: "No transactions yet",
    noMatchesBody: "Try other words, or take a filter off.",
    noEntriesBody:
      "Entries you post, transactions you accept from your bank and your opening balances will appear here.",
    resetFilters: "Reset filters",
    clearSearch: "Clear search",
    createFirst: "New journal entry",
    selectPage: "Select page",
    selectRow: (id: string) => `Select ${id}`,
    inspect: (id: string) => `Inspect ${id}`,
    inspectDraft: (description: string) => `Inspect draft ${description}`,
    columnEntry: "Entry",
    columnNumber: "No.",
    columnDate: "Date",
    columnReference: "Reference",
    columnDescription: "Description",
    columnAccounts: "Accounts",
    // The accounts of an entry, read as where the money went: the column a person calls its category.
    columnCategory: "Category",
    columnStatus: "Status",
    columnAmount: "Amount",
    columnActions: "Actions",
    // An entry's number is its place in the book: "No. 23". A draft has none until it is posted.
    entryNumber: (sequence: string) => `No. ${sequence}`,
    draftNumber: "Draft",
    referenceNote: (reference: string) => `Ref. ${reference}`,
    // "Business checking → Software" reads aloud as "Business checking to Software".
    accountsTo: "to",
    moreAccounts: (count: number) => `${count} more`,
    // The Type filter: where an entry came from.
    typeFilter: "Type",
    allTypes: "All types",
    types: {
      bank: "Bank",
      stripe: "Stripe",
      manual: "Manual",
      opening: "Opening balances",
    } as Record<string, string>,
    filterType: (type: string) => `Type: ${type}`,
    // What can be done to one entry (the menu at the end of its row).
    actionsFor: (label: string) => `Actions for ${label}`,
    // A reversal and the entry it cancels name each other by number.
    reversedBy: (number: string | undefined) => (number ? `Reversed by ${number}` : "Reversed"),
    reverses: (number: string | undefined) => (number ? `Reverses ${number}` : "A reversal"),
    // The state a list says of an entry that was reversed (a posted entry says nothing).
    reversed: "Reversed",
    summary: (count: number, currency: string) =>
      `${count} ${count === 1 ? "transaction" : "transactions"} · Amounts in ${currency}`,
    announceResults: (from: number, to: number, total: number, page: number, pages: number) =>
      `Showing ${from} to ${to} of ${total} transactions. Page ${page} of ${pages}.`,
    announceNone: "No transactions match.",
    announceSort: (ascending: boolean) =>
      `Sorted by date, ${ascending ? "oldest first" : "newest first"}.`,
  },
  inspector: {
    back: "Back to entries",
    postingDate: "Posting date",
    currency: "Currency",
    totalAmount: "Total amount",
    postedReadOnly:
      "This entry is posted and cannot be edited here. Corrections must preserve the original record.",
    draftReadOnly: "Draft editing is not available here.",
    reference: "Reference",
    referenceHelp: "A name you can find later. It appears in the register and in reports.",
    referenceRequired: "Enter a reference.",
    saving: "Saving draft…",
    saveUnknown: "Save status unknown",
    unsaved: "Unsaved changes",
    noUnsaved: "No unsaved changes",
    saveDraft: "Save draft",
    revert: "Revert to saved",
    saveFailedTitle: "Draft could not be saved",
    saveFailedBody: "Your changes are still here. Try saving again.",
    unknownTitle: "Save outcome not confirmed",
    unknownBody:
      "Your reference is preserved here. Check the entry’s saved state before trying again; this request may have succeeded.",
    viewEntry: "View journal entry",
    editDraft: "Edit draft",
    details: "Details",
    entryId: "Entry ID",
    draftLines: (currency: string) => `Draft entry lines · ${currency}`,
    postedLines: (currency: string) => `Posted entry lines · ${currency}`,
    selectAccount: "Select an account to inspect",
    linesScroll: "Entry lines, scroll horizontally on narrow screens",
    columnAccount: "Account",
    columnDebit: "Debit",
    columnCredit: "Credit",
    total: "Total",
    history: "History",
    historyRegion: "Entry history",
    auditTrail: "Audit trail",
    backToEntry: "Back to entry",
    accountContext: "Account ledger context",
    accountId: (id: string) => `Account ID: ${id}`,
    accountNote: (entry: string) =>
      `This account is used in ${entry}. Your register filters, page and selections have not changed.`,
    leaveTitle: "Save changes before leaving?",
    leaveBody: (entry: string) =>
      `The reference for ${entry} has unsaved changes. Discarding restores the last saved reference, not the whole draft.`,
    leaveFailedBody: "Your changes are preserved. Try again or keep editing.",
    leaveUnknownBody:
      "Check the saved entry before trying again. Discarding local edits does not undo a save.",
    keepEditing: "Keep editing",
    discard: "Discard changes",
    saveAndLeave: "Save and leave",
  },
  // One namespace per lane, each written in the lane's own folder.
  kit: kitMessages,
  reports: reportsMessages,
};

export type Messages = typeof defaultMessages;
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (...args: never[]) => unknown
    ? T[K]
    : T[K] extends Record<string, unknown>
      ? DeepPartial<T[K]>
      : T[K];
};

/** Overrides win key by key, so a translation can be partial and fall back to English. */
export function mergeMessages(overrides?: DeepPartial<Messages>): Messages {
  const merge = (base: unknown, patch: unknown): unknown => {
    if (!patch || typeof patch !== "object") return base;
    const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(patch)) {
      const current = result[key];
      result[key] =
        value && typeof value === "object" && current && typeof current === "object"
          ? merge(current, value)
          : (value ?? current);
    }
    return result;
  };
  return merge(defaultMessages, overrides) as Messages;
}

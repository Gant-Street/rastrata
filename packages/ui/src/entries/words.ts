/** The words of the entry screens: Spend money, Receive money, Transfer, Undo and the Business
 * settings. Copy lives here, not in the components, so it can be read and changed in one place. */

export const quickWords = {
  /** The one form "+ New, Transaction" opens: its title, and the name of the switch that says which kind. */
  transaction: { title: "New transaction", kind: "Kind of transaction" },
  spend: {
    title: "Spend money",
    intro: "Record money you paid out. Choose where it came from and what it was for.",
    fromLabel: "Paid from",
    toLabel: "Category",
    toHint: "Type to search your accounts.",
    partyLabel: "Paid to",
    partyHint: "What the bank or the receipt calls it. Optional.",
  },
  receive: {
    title: "Receive money",
    intro: "Record money you were paid. Choose where it went and what it was for.",
    fromLabel: "Category",
    toLabel: "Deposit to",
    fromHint: "Type to search your accounts.",
    partyLabel: "Received from",
    partyHint: "Who paid you. Optional.",
  },
  transfer: {
    title: "Transfer",
    intro: "Move money between two of your own accounts.",
    fromLabel: "From",
    toLabel: "To",
  },
  dateLabel: "Date",
  amountLabel: "Amount",
  amountHint: "Dollars and cents, such as 25.00.",
  descriptionLabel: "Description",
  descriptionHint: "Optional. It shows on the transaction.",
  previewTitle: "This will record",
  previewEmpty: "Choose the accounts and an amount to see what this records.",
  cancel: "Cancel",
  saveDraft: "Save draft",
  savingDraft: "Saving…",
  post: "Post",
  posting: "Posting…",
  fixErrors: "Fix these before you continue",
  /** The choices a preset sets, named as the owner would say them. */
  presetsLabel: "Common choices",
  ownerOut: "Owner took money out",
  ownerIn: "Owner put money in",
  ownerOutHint: "Recorded against your owner's draw account, not as an expense.",
  ownerInHint: "Recorded against your owner's investment account, not as income.",
  presetMissing: "Choose the account for this yourself: none of your accounts is named for it.",
  bankGroup: "Bank, card and cash accounts",
  otherBalanceGroup: "Other assets and liabilities",
  expenseGroup: "Expenses",
  incomeGroup: "Income",
  otherGroup: "Other accounts",
  noAccounts: "There are no accounts to choose from yet.",
  loading: "Loading your accounts…",
  loadFailed: "Your accounts could not be read. Nothing was changed.",
  retry: "Try again",
  /** A request whose reply was lost. */
  uncertain: "The last request may not have finished. Resume it before you start another.",
  resume: "Resume original request",
  /** Why a field is wrong, and what to do. */
  errors: {
    date: "Choose the date.",
    from: {
      spend: "Choose the account you paid from.",
      receive: "Choose a category.",
      transfer: "Choose the account to move money from.",
    },
    to: {
      spend: "Choose a category.",
      receive: "Choose the account to deposit to.",
      transfer: "Choose the account to move money to.",
    },
    same: "Choose two different accounts.",
    amountMissing: "Enter an amount.",
    amountFormat: "Use dollars and cents, such as 25.00, without a minus sign.",
    amountDecimals: "Use at most two decimal places.",
    amountZero: "The amount must be more than 0.00.",
    amountLarge: "That amount is too large.",
  },
  /** What the Transactions list reads for an entry made here. */
  entry: {
    spend: (party: string) => (party ? `Paid ${party}` : "Spend money"),
    receive: (party: string) => (party ? `Received from ${party}` : "Receive money"),
    transfer: (from: string, to: string) => `Transfer from ${from} to ${to}`,
    reference: { spend: "Spend money", receive: "Receive money", transfer: "Transfer" },
  },
  /** What the toast says after a save: the amount, and the accounts it moved between. */
  posted: {
    spend: (amount: string, category: string) => `Posted: ${amount} spent on ${category}.`,
    receive: (amount: string, bank: string) => `Posted: ${amount} received into ${bank}.`,
    transfer: (amount: string, from: string, to: string) =>
      `Posted: ${amount} moved from ${from} to ${to}.`,
  },
  /** After a post whose reply was lost and has now been found: the form it came from is gone. */
  postedPlain: "Posted.",
  draftSaved: "Draft saved. Nothing in your books has changed.",
  viewEntry: "View",
  openDraft: "Open draft",
  /** Why a post was refused, when the books gave no reason of their own. */
  postRefused: "The books did not accept this entry. Nothing was posted.",
} as const;

/** What Undo says. The words follow the vocabulary: lines are transactions, the Inbox is For review. */
export const undoWords = {
  action: "Undo",
  rowAction: "Undo",
  /** The accessible name of a row's Undo button, so each one in a list says which transaction it is for. */
  rowLabel: (description: string) => `Undo ${description}`,
  undoing: "Undoing…",
  done: (count: number) =>
    count === 1
      ? "Undone. The transaction is waiting for review again."
      : `Undone. ${count} transactions are waiting for review again.`,
  doneFrom: (count: number) =>
    count === 1
      ? "The transaction is waiting for review again."
      : `${count} transactions are waiting for review again.`,
  linkOnly: "The transaction is waiting for review again. The entry it matched was left as it was.",
  nothing: "There was nothing to undo.",
  notPosted: "That transaction is not posted, so there is nothing to undo.",
  failed: (count: number) =>
    count === 1
      ? "One transaction could not be undone."
      : `${count} transactions could not be undone.`,
  remaining: (count: number) =>
    count === 1
      ? "One more transaction is still to undo."
      : `${count} more transactions are still to undo.`,
  continue: "Undo the rest",
  /** Said after an undo when the entry had been on a finished reconciliation: the books are not wrong, they
   * differ from that statement until the transaction is posted again. */
  afterReconciled:
    "It was already on a reconciliation, so your books differ from that statement until it is posted again.",
  uncertain: "The last undo may not have finished. Resume it: nothing is done twice.",
  /** The reason recorded when drafts are taken back to For review with Undo (a draft has nothing to reverse). */
  restoreReason: "Undone.",
} as const;

export const businessWords = {
  title: "Business",
  /** The form's heading on the Business page, for a screen reader's outline (the page's own title is what shows). */
  sectionTitle: "Name and preferences",
  loading: "Loading your settings…",
  nameLabel: "Business name",
  nameRequired: "Enter a name of at least two characters.",
  nameTooLong: (max: number) => `Use at most ${max} characters.`,
  dateLabel: "Date format",
  dateOptions: {
    medium: "Month, day, year",
    numeric: "Numbers: month/day/year",
    iso: "Year first: year-month-day",
  },
  accountNumbersLabel: "Show account numbers beside account names in lists",
  acceptLabel: "When I accept a suggestion",
  acceptOptions: {
    post: "Post it (I can undo it)",
    draft: "Save it as a draft to post later",
  },
  entitySummary: "Legal entity details",
  entityLegalNameLabel: "Legal name",
  entityLegalNameHint:
    "Optional. Used on exports and year-end packets if different from your business name.",
  entityEinLabel: "EIN",
  entityEinHint: "Nine digits, such as 12-3456789.",
  entityEinBad: "Enter a nine-digit EIN, such as 12-3456789, or leave it blank.",
  entityTypeLabel: "Entity type",
  entityTypeNone: "Not set",
  entityTypes: {
    sole_proprietorship: "Sole proprietorship",
    single_member_llc: "Single-member LLC",
    multi_member_llc: "Multi-member LLC",
    s_corp: "S corporation",
    c_corp: "C corporation",
    partnership: "Partnership",
    nonprofit: "Nonprofit",
    other: "Other",
  },
  entityStateLabel: "Formation state",
  entityStateHint: "Two-letter state code, such as DE or TX.",
  entityStateBad: "Use a two-letter US state code, such as DE, or leave it blank.",
  entityEmailLabel: "Contact email",
  entityEmailBad: "Enter a valid email address, or leave it blank.",
  entityAddressLine1Label: "Street address",
  entityAddressLine2Label: "Suite or unit",
  entityAddressCityLabel: "City",
  entityAddressStateLabel: "State",
  entityAddressPostalLabel: "ZIP code",
  save: "Save changes",
  saving: "Saving…",
  saved: "Saved.",
  nothingChanged: "Nothing to save: these are already your settings.",
  failed: "Your changes could not be saved. Nothing was changed.",
  loadFailed: "Your settings could not be read.",
  retry: "Try again",
  uncertain: "The last save may not have finished. Resume it: nothing is saved twice.",
  resume: "Resume original request",
} as const;

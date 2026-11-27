import { formatDate } from "../format";
/** The words the tax components use, in one place. Rastrata books and reports: nothing here gives tax
 * advice, files a return or says what anyone owes. A component never writes its own sentence about the
 * law; it shows the service's own text (which carries its sources) or one of these. A page says the least
 * that lets a person act: what a tool is, in one sentence under its title, and the rest is in Help. */

export const words = {
  title: "Taxes",
  /** The one sentence under each tool's title: what the tool is. */
  describe: {
    worksheet: "Your books arranged by the lines of your return, for whoever prepares it.",
    pack: "The year's statements, the worksheet and where every figure came from, in one download.",
    vendors:
      "Who was paid how much, from the accounts you mark as holding payments that may need a 1099.",
    sales: "What your books recorded as sales tax, by period.",
    accountant:
      "What you send to whoever prepares the return, and the adjusting entries they send back.",
  },

  // The year
  yearLabel: "Tax year",
  /** Each tool is a page of its own under Reports, named as the list of reports names it. */
  pageWorksheet: "Tax worksheet",
  pagePack: "Year-end pack",
  pageVendors: "1099 vendors",
  pageSales: "Sales tax",
  pageAccountant: "Pack for your accountant",
  backToReports: "Reports",
  loading: "Reading the books",
  failed: "This could not be read.",
  retry: "Try again",
  noBook: "No book is connected.",
  noBookTitle: "No book connected",
  noBookBody:
    "Set up a book first. The tax tools read a book's accounts, tags and postings, so there is nothing for them to work from until one exists.",
  noBookLink: "Go to Home",
  calendarTitle: "The calendar does not cover this tax year",
  calendarBody:
    "The tax tools work on a whole calendar year that the book's calendar covers. Choose another year; a later one is covered once something is recorded in it.",
  calendarChoose: "Let Rastrata choose the year",
  checksStale:
    "The checks could not be read again, so what is listed is from the last time they were read.",

  // The checks. A check is one of three kinds, and the kind says what it asks of the person: orange when
  // acting would change the figures on the page, grey for good practice, and a plain note for a fact about
  // the figures that nobody can act on.
  checksRegion: "Checks on these figures",
  checksLoading: "Checking the books",
  checksFailed: "The checks could not be read.",
  notesLabel: "About these figures",
  goodPractice: "Good practice before you file",
  goodPracticeDone: (done: number, total: number) => `${done} of ${total} done`,
  checkDone: "Done",
  checkNotYet: "Not yet",
  checkUnknown: "Could not be checked",
  // What each check is called, in the words the rest of the app uses.
  checkTitles: {
    periods: "Months closed",
    inbox: "Transactions waiting for review",
    reconcile: "Accounts reconciled",
    unmapped: "Accounts with no tax line",
    vendors: "1099 vendors",
    sales: "Sales tax",
    draft: "The form is an early release",
    books_start: "The books start part-way through the year",
    year_not_ended: "The year is not over",
  } as Readonly<Record<string, string>>,
  // What the check about the transactions waiting for review says, from its count.
  inboxWaiting: (count: number, year: number) =>
    count === 1
      ? `1 transaction dated in ${year} is waiting for review, so it is not in these figures.`
      : `${count} transactions dated in ${year} are waiting for review, so they are not in these figures.`,
  inboxClear: (year: number) => `Nothing dated in ${year} is waiting for review.`,
  inboxUnknown: (year: number) =>
    `The transactions waiting for review could not be read, so it is not known whether any dated in ${year} are still waiting.`,
  // What each link names: the thing it fixes, never "fix it".
  fixClose: "Close the books",
  fixReview: (count: number | undefined) =>
    count === undefined
      ? "Review the transactions"
      : count === 1
        ? "Review 1 transaction"
        : `Review ${count} transactions`,
  fixReconcile: (count: number | undefined) =>
    count === undefined || count === 1 ? "Reconcile the account" : `Reconcile ${count} accounts`,
  fixTaxLines: (count: number | undefined) =>
    count === undefined || count === 1
      ? "Add the missing tax line"
      : `Add the missing tax lines to ${count} accounts`,
  fixMarkVendorAccounts: "Mark the accounts that hold contractor payments",
  fixVendors: "Decide on the 1099 vendors",
  fixTagSalesTax: "Tag the sales tax account",
  fixSalesTax: "Look at the sales tax figures",
  fixOther: (title: string) => `Open ${title.toLowerCase()}`,

  // The worksheet
  worksheetTitle: (form: string, year: number) => `${form}, ${year}`,
  formLabel: "Form",
  formScheduleC: "Schedule C (sole proprietor)",
  form1120S: "Form 1120-S (S corporation)",
  form1065: "Form 1065 (partnership)",
  mealsLabel: "Business meals taken",
  mealsHint:
    "The IRS instructions give 50% in most cases and 80% under the Department of Transportation's hours-of-service limits.",
  meals50: "50% (most cases)",
  meals80: "80% (hours-of-service limits)",
  draftForm: (year: number) =>
    `The ${year} form is an IRS early-release draft, not the final form. Confirm the line numbers against the final form.`,
  columnLine: "Line",
  columnBooked: "As booked",
  columnForm: "On the form",
  columnAmount: "Amount",
  tableScroll: (caption: string) => `${caption}. Scrolls sideways on a narrow screen.`,
  accountsCount: (count: number) => (count === 1 ? "1 account" : `${count} accounts`),
  accountsShow: (label: string) => `Show the accounts behind ${label}`,
  accountsHide: (label: string) => `Hide the accounts behind ${label}`,
  accountActivity: (code: string, name: string) => `activity for ${code} ${name}`,
  notInBooks: "Not in the books",
  netLine: "Net",
  mealsTaken: (percent: number, removed: string) =>
    `${percent}% taken. ${removed} of the booked cost is left off the form; the books keep the full cost.`,
  unmappedTitle: "Accounts with no line on this form",
  unmappedColumnAccount: "Account",
  unmappedColumnAmount: "Amount",
  unmappedColumnWhy: "Why it has no form line",
  unmappedFix: "Tag it in your chart of accounts",
  reasonNoLine: "It has no tax line.",
  reasonOtherForm: (line: string) => `It is tagged ${line}, a line of another form.`,
  reasonNotThisYear: (line: string) => `${line} is not a line on this year's form.`,
  reasonRole: (line: string) => `${line} does not take this kind of account.`,
  reconciliationTitle: "Ties to the profit and loss",
  reconciliationNet: "Net income per the profit and loss, same dates",
  /** The fold at the foot of a tool: the notes the service wrote about its figures, each with the IRS
   * page it was read from. Closed until a person asks. */
  notesFold: "Notes and sources",
  notesCount: (count: number) => (count === 1 ? "1 note" : `${count} notes`),
  sourceRead: (title: string, on: string | undefined) =>
    on ? `${title}, read on ${formatDate(on)}` : title,
  exportWorksheet: "Download the worksheet (CSV)",
  exportAccounts: "Download the accounts (CSV)",
  exportPostings: "Download every posting (CSV)",
  exporting: "Preparing the file",
  exported: (name: string) => `Saved ${name}.`,
  exportFailed: "The file could not be made.",

  // The year-end pack
  packTitle: "Year-end pack",
  packBuild: "Build the pack",
  packBuilding: "Building the pack",
  packDownload: "Download the pack (zip)",
  packBuilt: (files: string) => `${files} files, all from one version of your books.`,
  packFileColumn: "File",
  packWhatColumn: "What it is",
  packSizeColumn: "Size",
  packHashColumn: "SHA-256",
  packManifest: "Manifest SHA-256",
  // What proves a pack, under "Pack details" at the foot.
  packDetails: "Pack details",
  packManifestName: "manifest SHA-256",
  packRevision: "Book revision",
  packFilesSummary: "The SHA-256 of each file",
  packFinalTitle: "How final it is",
  packStale: "The books have changed since this pack was built. Build it again.",
  packSaved: (name: string) => `Saved ${name}.`,
  packFailed: "The pack could not be built.",

  // 1099 vendors
  vendorsTitle: "1099 vendors",
  thresholdLabel: (year: number) => `Reporting threshold for payments made in ${year}`,
  thresholdSources: "Where this comes from",
  accountsTitle: "Accounts that hold these payments",
  accountSuggested: "Suggested",
  accountsNone: "No expense account has been marked yet.",
  accountsMarkError: "The accounts could not be changed. Nothing was changed.",
  vendorsList: "Vendors",
  vendorsNone: "No vendor has been recorded yet.",
  vendorColumn: "Vendor",
  vendorReporting: "1099",
  vendorW9: "W-9",
  vendorCounted: "Counted",
  vendorCard: "By card or app",
  vendorOther: "Other",
  vendorAttention: "Needs",
  vendorAdd: "Add a vendor",
  vendorEdit: (name: string) => `Edit ${name}`,
  /** A vendor is a payee: Money by payee shows every transaction it was paid, under the same name. */
  vendorPayeeLink: "Money by payee",
  vendorPayeeLinkFor: (name: string) => `See ${name} in Money by payee`,
  reportingYes: "Needs a 1099",
  reportingNo: "No 1099",
  reportingUndecided: "Not decided",
  w9NotRequested: "Not requested",
  w9Requested: "Requested",
  w9Received: "Received",
  attentionUndecided: "Decide whether it needs a 1099",
  attentionW9: "No W-9 on file",
  attentionMethod: "Payment method not confirmed",
  atOrOver: "At or over the threshold",
  underThreshold: "Under the threshold",
  payeesTitle: "Paid, and not a vendor yet",
  payeeColumn: "Payee",
  payeePayments: "Payments",
  payeeDates: "Dates",
  payeeAmbiguous: "Matches more than one vendor, so it is given to none",
  payeeMakeVendor: (payee: string) => `Make ${payee} a vendor`,
  totalsLine: (counted: string, card: string, other: string) =>
    `In the marked accounts, counted ${counted}. By card or payment app ${card}, which the processor reports. Other ${other}.`,
  exportVendors: "Download the vendor list (CSV)",
  exportPayments: "Download every payment (CSV)",

  // The vendor form
  formVendorNew: "Add a vendor",
  formVendorEdit: "Edit a vendor",
  formName: "Name",
  formPayees: "Payee texts",
  formPayeesHint:
    "Words that appear whole and in order in a bank transaction's name or description, one per line: jane doe. At least three characters each. Never a taxpayer identification number or an account number.",
  formReporting: "Does it need a 1099?",
  formReason: "Why not",
  formW9: "W-9",
  formW9On: "W-9 date",
  formW9OnHint: "YYYY-MM-DD",
  formClassification: "Tax classification on the W-9",
  formClassificationNone: "Not recorded",
  formPaidBy: "How it is paid",
  formNotes: "Notes",
  formNotesHint: "Never a taxpayer identification number.",
  formSave: "Save",
  formSaving: "Saving",
  formCancel: "Cancel",
  formHistory: "History",
  formHistoryNone: "No earlier version.",
  formSaved: (name: string) => `Saved ${name}.`,
  formUncertain: "The result is uncertain. Save again to resume the original request.",
  formFailed: "The vendor could not be saved. Nothing was changed.",
  formNameRequired: "Give the vendor a name.",
  formPayeeShort: "Each payee text needs at least three characters.",
  formReasonRequired: "Say why it does not need a 1099.",
  formW9OnBad: "Use a date as YYYY-MM-DD, or leave it empty.",
  formDialogClose: "Close",
  reasonCorporation: "A corporation (but not for legal services or medical payments)",
  reasonEmployee: "An employee",
  reasonPersonal: "Personal, not for the business",
  reasonMerchandise: "Merchandise, freight, storage or similar",
  reasonExempt: "A tax-exempt organization or government",
  reasonCard: "Paid by card or payment app",
  reasonOther: "Other",
  classificationIndividual: "Individual or sole proprietor",
  classificationC: "C corporation",
  classificationS: "S corporation",
  classificationPartnership: "Partnership",
  classificationTrust: "Trust or estate",
  classificationLlcC: "LLC taxed as a C corporation",
  classificationLlcS: "LLC taxed as an S corporation",
  classificationLlcP: "LLC taxed as a partnership",
  classificationOther: "Other",
  paidByUnknown: "Not confirmed",
  paidByBank: "Bank transfer, check or cash",
  paidByCard: "Card or payment app",

  // Sales tax
  salesTitle: "Sales tax",
  salesPeriodLabel: "Periods",
  periodMonth: "Months",
  periodQuarter: "Quarters",
  periodYear: "Whole range",
  salesColumnPeriod: "Period",
  salesColumnOpening: "At the start",
  salesColumnCollected: "Collected",
  salesColumnRemitted: "Paid or returned",
  salesColumnClosing: "At the end",
  salesColumnStripeBooked: "From Stripe payouts",
  salesColumnStripeReported: "Stripe reported",
  salesColumnDifference: "Difference",
  salesTotalRow: "Whole range",
  salesNoAccountTitle: "No account is tagged as the sales tax account",
  salesNoAccount: "If you collect sales tax, tag the liability account that holds it tax.sales.",
  salesCandidates: "Liability accounts that could be the one",
  salesCandidateSuggested: "Its name says sales tax",
  salesStripeSummary: (payouts: number) =>
    payouts === 1
      ? "1 Stripe payout booked in the range."
      : `${payouts} Stripe payouts booked in the range.`,
  salesStripeNotRead:
    "The transactions waiting for review could not be read, so Stripe's figures are not compared.",
  salesStripeTaxNotReported: (count: number) =>
    count === 1
      ? "Stripe gave no tax figure for 1 charge, as of today."
      : `Stripe gave no tax figure for ${count} charges, as of today.`,
  salesActivity: (code: string, name: string) => `activity for ${code} ${name}`,
  exportSales: "Download the summary (CSV)",
  exportSalesPostings: "Download every posting (CSV)",
  salesAccounts: "The account",

  // The accountant
  accountantTitle: "Your accountant",
  accountantSendTitle: "Send them your books",
  accountantBuild: "Build the accountant pack",
  accountantBuilding: "Building the pack",
  accountantDownload: "Download the accountant pack (zip)",
  accountantTemplate: "Download the template (CSV)",
  accountantBringTitle: "Bring their adjusting entries in",
  fileLabel: "Adjusting entries file (CSV)",
  fileHint:
    "One row for each line of an entry. Columns: Entry, Date, Narration, Account, Debit, Credit.",
  fileChoose: "Choose a file",
  fileCheck: "Check the file",
  fileChecking: "Checking the file",
  fileTooLarge: "This file is too large to import. Split it into several files.",
  fileUnreadable: "The file could not be read.",
  previewTitle: "What importing would do",
  previewCounts: (entries: number, lines: number) =>
    `${entries === 1 ? "1 entry" : `${entries} entries`}, ${lines === 1 ? "1 line" : `${lines} lines`}.`,
  previewNew: (count: number) => `${count} new`,
  previewAlready: (count: number) => `${count} already imported`,
  previewConflict: (count: number) => `${count} in conflict`,
  previewInvalid: (count: number) => `${count} with a problem`,
  previewNothingNew:
    "Everything in this file was imported before, so there is nothing new to import.",
  previewBlocked:
    "Nothing can be imported until every problem is fixed: an accountant's entries are a set, and half a set can be worse than none.",
  statusNew: "New",
  statusAlready: "Already imported",
  statusConflict: "In conflict",
  statusInvalid: "Has a problem",
  entryColumn: "Entry",
  entryDate: "Date",
  entryNarration: "Description",
  entryStatus: "Status",
  lineAccount: "Account",
  lineDebit: "Debit",
  lineCredit: "Credit",
  problemWhere: (
    row: number | null | undefined,
    entry: string | null | undefined,
    column: string | null | undefined,
  ) =>
    [row != null ? `Row ${row}` : "", entry ? `entry ${entry}` : "", column ?? ""]
      .filter(Boolean)
      .join(", ") || "The file",
  problemError: "Problem",
  problemWarning: "Warning",
  importButton: (count: number) =>
    count === 1 ? "Import 1 entry as a draft" : `Import ${count} entries as drafts`,
  importing: "Importing",
  imported: (count: number) => (count === 1 ? "1 draft was saved." : `${count} drafts were saved.`),
  importedNext: "Read each draft, then post it or discard it. Nothing has been posted.",
  openJournal: "Open Transactions",
  importStale: "The file or the book changed since it was checked. Check the file again.",
  importFailed: "The entries could not be imported. Nothing was changed.",
  importUncertain: "The result is uncertain. Resume the original import to find out.",
  importUncertainTitle: "An import was interrupted",
  importUncertainBody:
    "Its result is uncertain: the reply was lost, so it is not known whether the drafts were saved. Resuming sends the same request again, and nothing is imported twice.",
  importResume: "Resume the import",
  draftLink: (entry: string) => `Draft for ${entry}`,
} as const;

export const reasonText = (
  reason: "no_tax_line" | "other_form" | "not_on_this_year" | "role_not_accepted",
  taxLine: string | null,
): string => {
  const line = taxLine ?? "a tax line";
  switch (reason) {
    case "no_tax_line":
      return words.reasonNoLine;
    case "other_form":
      return words.reasonOtherForm(line);
    case "not_on_this_year":
      return words.reasonNotThisYear(line);
    default:
      return words.reasonRole(line);
  }
};

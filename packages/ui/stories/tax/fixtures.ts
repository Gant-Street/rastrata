import type {
  TaxAdjustmentPreviewView,
  TaxCheckView,
  TaxPackView,
  TaxSalesData,
  TaxVendorsData,
  TaxVendorView,
  TaxWorksheetData,
} from "../../src";

/** Invented data for the tax stories: a fictional design studio. Nothing here is real; names, payees and
 * amounts are made up, and the payee texts show the shape of what a bank writes with the numbers
 * masked. The figures are chosen so the stories show the interesting states (a line that is booked at one
 * amount and goes on the form at another, an account with no line, a payee that is not a vendor yet). */

/** The checks of a book at the end of a year with things to do: two are orange (transactions waiting for
 * review and accounts with no tax line, which both change the figures), the months and the 1099 list are
 * good practice, and the three facts about the figures are notes. */
export const checks: readonly TaxCheckView[] = [
  {
    key: "periods",
    status: "attention",
    title: "Periods closed",
    detail:
      "2 of 12 periods that have ended in this range are not closed (November 2026, December 2026). A closed period cannot change by accident.",
    href: "/periods",
    count: 2,
  },
  {
    key: "inbox",
    status: "attention",
    title: "Inbox lines",
    detail:
      "3 lines dated in this range are still in the Inbox and not posted, so they are not in these figures.",
    href: "/inbox",
    count: 3,
  },
  {
    key: "reconcile",
    status: "ok",
    title: "Accounts reconciled",
    detail: "Every tracked account is reconciled to 2026-12-31 or later.",
  },
  {
    key: "unmapped",
    status: "attention",
    title: "Tax lines",
    detail:
      "2 accounts have activity and no line from Schedule C (income 400.00, expenses 1,150.00). They are listed as not mapped on the worksheet.",
    href: "/accounts",
    count: 2,
  },
  {
    key: "vendors",
    status: "unknown",
    title: "1099 vendors",
    detail:
      "No account is marked as holding payments that may need a 1099, so this could not be checked.",
    href: "/tax?tab=vendors",
  },
  {
    key: "sales",
    status: "ok",
    title: "Sales tax",
    detail:
      "The sales tax account collected 95.50 and paid or returned 82.00 in this range and holds 43.50 at the end. Rastrata does not know your rates or filing dates.",
    href: "/tax?tab=sales",
  },
  {
    key: "draft",
    status: "attention",
    title: "Form status",
    detail:
      "The 2026 Schedule C (Form 1040) is an IRS early-release draft. Confirm the line numbers against the final form.",
  },
  {
    key: "books_start",
    status: "attention",
    title: "Start of the books",
    detail:
      "The books start on 2026-03-01. Activity from 2026-01-01 until then is in your earlier system, not here.",
  },
];

/** A year in which everything that can be done has been: every check passed, so there are no notes. */
export const allClear: readonly TaxCheckView[] = checks
  .filter((check) => check.key !== "draft" && check.key !== "books_start")
  .map((check) => ({ ...check, status: "ok" as const, href: undefined, count: undefined }));

/** An ordinary book in the middle of its first year: nothing is closed yet, no account has been
 * reconciled, no 1099 account is marked, the form is an early release and the year is not over. The
 * service says "attention" for most of it; none of it changes a figure, so none of it is orange. */
export const normalMidYear: readonly TaxCheckView[] = [
  {
    key: "periods",
    status: "attention",
    title: "Periods closed",
    detail:
      "9 of 9 periods that have ended in this range are not closed (January, February, March, April, and more). A closed period cannot change by accident.",
    href: "/periods",
    count: 9,
  },
  {
    key: "inbox",
    status: "ok",
    title: "Inbox lines",
    detail: "No line dated in this range is waiting in the Inbox.",
  },
  {
    key: "reconcile",
    status: "attention",
    title: "Accounts reconciled",
    detail:
      "No bank or card account has been reconciled to a statement. A statement balance is the best evidence that a year's figures are complete.",
    href: "/reconcile",
  },
  {
    key: "unmapped",
    status: "ok",
    title: "Tax lines",
    detail: "Every income and expense account with activity has a line on Schedule C (Form 1040).",
  },
  {
    key: "vendors",
    status: "unknown",
    title: "1099 vendors",
    detail:
      "No account is marked as holding payments that may need a 1099, so this could not be checked.",
    href: "/tax?tab=vendors",
  },
  {
    key: "sales",
    status: "unknown",
    title: "Sales tax",
    detail:
      "No liability account is tagged tax.sales, so sales tax could not be checked. If you collect sales tax, tag the account that holds it in your chart of accounts.",
    href: "/accounts",
  },
  {
    key: "draft",
    status: "attention",
    title: "Form status",
    detail:
      "The 2026 Schedule C (Form 1040) is an IRS early-release draft. Confirm the line numbers against the final form.",
  },
  {
    key: "books_start",
    status: "attention",
    title: "Start of the books",
    detail:
      "The books start on 2026-03-01. Activity from 2026-01-01 until then is in your earlier system, not here.",
  },
  {
    key: "year_not_ended",
    status: "attention",
    title: "Year not over",
    detail: "The range ends on 2026-12-31, after today (2026-10-04). These are the figures so far.",
  },
];

const source = (title: string, url: string, readOn = "2026-10-04") => ({ title, url, readOn });
const SCHEDULE_C_SOURCES = [
  source(
    "Instructions for Schedule C (Form 1040) 2025",
    "https://www.irs.gov/instructions/i1040sc",
  ),
  source("Schedule C (Form 1040) 2025", "https://www.irs.gov/pub/irs-pdf/f1040sc.pdf"),
];

const account = (code: string, name: string, amount: string, postings: number) => ({
  accountId: code,
  code,
  name,
  amount,
  from: "2026-02-10",
  to: "2026-11-30",
  postings,
});

export const worksheet: TaxWorksheetData = {
  taxYear: 2026,
  form: {
    id: "scheduleC",
    name: "Schedule C (Form 1040)",
    subject: "Profit or Loss From Business",
    taxYear: 2026,
    status: "final",
    sources: SCHEDULE_C_SOURCES,
  },
  from: "2026-01-01",
  to: "2026-12-31",
  mealsPercent: 50,
  parts: [
    {
      key: "income",
      label: "Part I: Income",
      lines: [
        {
          key: "scheduleC.line1",
          number: "1",
          label: "Gross receipts or sales",
          kind: "tagged",
          booked: "48250.00",
          amount: "48250.00",
          accounts: [
            account("4000", "Design fees", "46000.00", 14),
            account("4010", "Licensing", "2250.00", 3),
          ],
        },
        {
          key: "scheduleC.line2",
          number: "2",
          label: "Returns and allowances",
          kind: "tagged",
          booked: "150.00",
          amount: "150.00",
          accounts: [account("4100", "Refunds to clients", "150.00", 1)],
        },
        {
          key: "scheduleC.line3",
          number: "3",
          label: "Subtract line 2 from line 1",
          kind: "computed",
          booked: "48100.00",
          amount: "48100.00",
          formula: "Line 1 minus line 2",
          accounts: [],
        },
        {
          key: "scheduleC.line4",
          number: "4",
          label: "Cost of goods sold (from line 42)",
          kind: "computed",
          booked: "900.00",
          amount: "900.00",
          formula: "From line 42",
          accounts: [],
        },
        {
          key: "scheduleC.line7",
          number: "7",
          label: "Gross income",
          kind: "computed",
          booked: "47200.00",
          amount: "47200.00",
          formula: "Line 3 minus line 4 plus line 6",
          accounts: [],
        },
      ],
    },
    {
      key: "expenses",
      label: "Part II: Expenses",
      lines: [
        {
          key: "scheduleC.line8",
          number: "8",
          label: "Advertising",
          kind: "tagged",
          booked: "400.00",
          amount: "400.00",
          accounts: [account("6000", "Advertising", "400.00", 2)],
        },
        {
          key: "scheduleC.line11",
          number: "11",
          label: "Contract labor",
          kind: "tagged",
          booked: "2500.00",
          amount: "2500.00",
          note: "You must file Form 1099-NEC to report certain contract labor payments.",
          accounts: [account("6030", "Contract labor", "2500.00", 1)],
        },
        {
          key: "scheduleC.line24b",
          number: "24b",
          label: "Deductible meals",
          kind: "tagged",
          booked: "171.00",
          amount: "85.50",
          adjustment: {
            kind: "meals",
            percent: 50,
            removed: "85.50",
            reason:
              "50% of the cost booked to this line is taken; the instructions give 50% in most cases.",
          },
          accounts: [account("6170", "Meals with clients", "171.00", 2)],
        },
        {
          key: "scheduleC.line27a",
          number: "27a",
          label: "Other expenses",
          kind: "tagged",
          booked: "0.00",
          amount: "0.00",
          accounts: [],
        },
        {
          key: "scheduleC.line28",
          number: "28",
          label: "Total expenses",
          kind: "computed",
          booked: "3071.00",
          amount: "2985.50",
          formula: "Add lines 8 through 27a",
          accounts: [],
        },
        {
          key: "scheduleC.line31",
          number: "31",
          label: "Net profit or (loss)",
          kind: "computed",
          booked: "44129.00",
          amount: "44214.50",
          formula: "Line 7 minus line 28 minus line 30",
          net: true,
          accounts: [],
        },
      ],
    },
    {
      key: "inventory",
      label: "Part III: Cost of goods sold",
      lines: [
        {
          key: "scheduleC.line35",
          number: "35",
          label: "Inventory at beginning of year",
          kind: "untracked",
          booked: "0.00",
          amount: "0.00",
          note: "Inventory counts are not in the books. Enter them from your own count.",
          accounts: [],
        },
      ],
    },
  ],
  unmapped: [
    {
      accountId: "4900",
      code: "4900",
      name: "Miscellaneous income",
      role: "income",
      amount: "400.00",
      reason: "no_tax_line",
      taxLine: null,
      from: "2026-03-01",
      to: "2026-09-15",
      postings: 2,
    },
    {
      accountId: "6990",
      code: "6990",
      name: "Home studio costs",
      role: "expense",
      amount: "1150.00",
      reason: "other_form",
      taxLine: "form8829.line1",
      from: "2026-01-31",
      to: "2026-12-01",
      postings: 7,
    },
  ],
  unmappedIncome: "400.00",
  unmappedExpenses: "1150.00",
  reconciliation: {
    rows: [
      { key: "netProfit", label: "Net profit or (loss), line 31", amount: "44214.50" },
      { key: "meals", label: "Add: the meals limit on line 24b", amount: "-85.50" },
      {
        key: "unmappedIncome",
        label: "Add: income on accounts with no line from this form",
        amount: "400.00",
      },
      {
        key: "unmappedExpenses",
        label: "Less: expenses on accounts with no line from this form",
        amount: "-1150.00",
      },
    ],
    netIncomeBooks: "43378.00",
    netProfit: "44214.50",
    ties: true,
  },
  notes: [
    {
      key: "meals",
      text: "Schedule C line 24b: in general you can deduct only 50% of business meal expenses, unless an exception applies. The books keep the full cost; the percentage is applied here and what it took off is shown.",
      sources: SCHEDULE_C_SOURCES,
    },
    {
      key: "salesTax",
      text: "Sales tax collected from buyers and paid over is not part of gross receipts and is not a deduction.",
      sources: [
        source(
          "Instructions for Schedule C (Form 1040) 2025",
          "https://www.irs.gov/instructions/i1040sc",
        ),
      ],
    },
  ],
  warnings: [
    {
      code: "unmapped_accounts",
      message:
        "2 accounts have activity in this range and no line from Schedule C (Form 1040) for 2026: income of 400.00 and expenses of 1,150.00 are not on any line above. They are listed below, never guessed.",
    },
    {
      code: "year_not_ended",
      message:
        "This range ends on 2026-12-31, after today (2026-10-04), so these are the figures so far.",
    },
  ],
  disclaimer:
    "Rastrata books and reports. It does not give tax advice, choose a tax line for you, file anything or predict what you owe. Verify every figure against the current IRS form and instructions, or with whoever prepares your return.",
};

export const worksheetPlain: TaxWorksheetData = {
  ...worksheet,
  parts: worksheet.parts.map((part) => ({
    ...part,
    lines: part.lines.map((line) => ({
      ...line,
      booked: line.amount,
      adjustment: undefined,
    })),
  })),
  unmapped: [],
  warnings: [],
};

export const draftWorksheet: TaxWorksheetData = {
  ...worksheet,
  form: { ...worksheet.form, status: "draft" },
  warnings: [
    {
      code: "draft_form",
      message:
        "The 2026 Schedule C (Form 1040) is an IRS early-release draft, not the final form. Confirm the line numbers against the final form before relying on them.",
    },
  ],
};

const file = (path: string, description: string, bytes: number, hash: string) => ({
  path,
  mediaType: "text/csv; charset=utf-8",
  description,
  bytes,
  sha256: hash.repeat(64).slice(0, 64),
  content: "",
});

export const pack: TaxPackView = {
  format: "rastrata-year-end-pack-v1",
  folder: "rastrata-year-end-2026",
  taxYear: 2026,
  from: "2026-01-01",
  to: "2026-12-31",
  bookRevision: "138",
  manifestSha256: "9e83837b9c9144443f53eba9275800838cadeadfaa610a16e42b7918089ec04d",
  disclaimer: worksheet.disclaimer,
  files: [
    file(
      "README.md",
      "What this pack is, what is and is not in it, and the checks to look at first.",
      4210,
      "a1",
    ),
    file(
      "statements/profit-and-loss.csv",
      "Profit and loss for the dates of the tax year.",
      2160,
      "b2",
    ),
    file("statements/balance-sheet.csv", "Balance sheet as of the last day.", 1832, "c3"),
    file("statements/cash-flow.csv", "Cash-flow statement for the dates.", 1544, "d4"),
    file("statements/trial-balance.csv", "Trial balance as of the last day.", 1998, "e5"),
    file(
      "statements/general-ledger.csv",
      "General ledger for the dates: every posting with running balances.",
      48210,
      "f6",
    ),
    file(
      "tax/schedule-c-worksheet.csv",
      "Schedule C worksheet: every line in the order of the form.",
      3120,
      "01",
    ),
    file(
      "tax/schedule-c-accounts.csv",
      "The accounts behind each line, and those not mapped.",
      2480,
      "12",
    ),
    file(
      "tax/schedule-c-postings.csv",
      "Every posting behind the worksheet, with its journal.",
      19840,
      "23",
    ),
    file("tax/1099-vendors.csv", "The 1099 vendor list.", 1210, "34"),
    file("tax/1099-payments.csv", "Every payment behind the 1099 totals.", 2610, "45"),
    file(
      "manifest.json",
      "Every file with its size, SHA-256 and the population it was built from.",
      3930,
      "56",
    ),
  ],
};

const vendor = (
  over: Partial<TaxVendorView> & Pick<TaxVendorView, "id" | "name">,
): TaxVendorView => ({
  version: 1,
  payeeKeys: [],
  reporting: "undecided",
  reason: null,
  w9: "not_requested",
  w9On: null,
  classification: null,
  paidBy: "unknown",
  notes: "",
  recordedAt: "2026-03-01T10:15:00.000Z",
  principal: "owner",
  ...over,
});

export const vendorJane = vendor({
  id: "ven_jane",
  name: "Jane Doe Design",
  payeeKeys: ["jane doe"],
  reporting: "yes",
  w9: "received",
  w9On: "2026-02-10",
  classification: "individual",
  paidBy: "bank",
  version: 3,
  recordedAt: "2026-04-02T09:00:00.000Z",
});

export const vendors: TaxVendorsData = {
  taxYear: 2026,
  from: "2026-01-01",
  to: "2026-12-31",
  threshold: {
    taxYear: 2026,
    amount: "2000.00",
    note: "For payments made in 2026, the reporting threshold is $2,000.",
    sources: [
      source(
        "Am I required to file a Form 1099 or other information return?",
        "https://www.irs.gov/businesses/small-businesses-self-employed/am-i-required-to-file-a-form-1099-or-other-information-return",
      ),
      source(
        "Instructions for Forms 1099-MISC and 1099-NEC (12/2026)",
        "https://www.irs.gov/instructions/i1099mec",
      ),
    ],
  },
  accounts: [
    {
      accountId: "6020",
      code: "6020",
      name: "Commissions and fees",
      marked: false,
      suggested: true,
    },
    { accountId: "6030", code: "6030", name: "Contract labor", marked: true, suggested: true },
    {
      accountId: "6080",
      code: "6080",
      name: "Legal and professional services",
      marked: true,
      suggested: true,
    },
    {
      accountId: "6110",
      code: "6110",
      name: "Rent: vehicles and equipment",
      marked: false,
      suggested: true,
    },
    { accountId: "6140", code: "6140", name: "Supplies", marked: false, suggested: false },
  ],
  vendors: [
    {
      vendor: vendorJane,
      payments: 5,
      counted: "2200.00",
      card: "500.00",
      other: "0.00",
      meetsThreshold: true,
      attention: ["method_unconfirmed"],
    },
    {
      vendor: vendor({
        id: "ven_acme",
        name: "Acme Law LLP",
        payeeKeys: ["acme law"],
        reporting: "undecided",
        w9: "requested",
      }),
      payments: 2,
      counted: "3250.00",
      card: "0.00",
      other: "400.00",
      meetsThreshold: true,
      attention: ["undecided", "w9_missing", "method_unconfirmed"],
    },
    {
      vendor: vendor({
        id: "ven_big",
        name: "Big Corp Inc",
        payeeKeys: ["big corp"],
        reporting: "no",
        reason: "corporation",
      }),
      payments: 1,
      counted: "900.00",
      card: "0.00",
      other: "0.00",
      meetsThreshold: false,
      attention: [],
    },
  ],
  payees: [
    {
      payee: "SOMEONE NEW LLC 0042",
      payments: 2,
      counted: "850.00",
      card: "0.00",
      other: "0.00",
      ambiguous: false,
      firstOn: "2026-08-01",
      lastOn: "2026-08-02",
    },
    {
      payee: "JANE DOE ACME LAW",
      payments: 1,
      counted: "300.00",
      card: "0.00",
      other: "0.00",
      ambiguous: true,
      firstOn: "2026-09-04",
      lastOn: "2026-09-04",
    },
  ],
  totals: { payments: 10, counted: "7200.00", card: "500.00", other: "400.00" },
  overThreshold: 2,
  needW9: 1,
  undecided: 1,
  notes: [
    {
      key: "cardNetwork",
      text: "Payments made with a credit card or payment card and certain other types of payments, including third-party network transactions, are reported by the payment settlement entity on Form 1099-K and not on Form 1099-NEC or 1099-MISC.",
      sources: [
        source(
          "Instructions for Forms 1099-MISC and 1099-NEC (12/2026)",
          "https://www.irs.gov/instructions/i1099mec",
        ),
      ],
    },
  ],
  warnings: [],
  disclaimer: worksheet.disclaimer,
};

export const vendorsEmpty: TaxVendorsData = {
  ...vendors,
  accounts: vendors.accounts.map((entry) => ({ ...entry, marked: false })),
  vendors: [],
  payees: [],
  totals: { payments: 0, counted: "0.00", card: "0.00", other: "0.00" },
  overThreshold: 0,
  needW9: 0,
  undecided: 0,
  warnings: [
    {
      code: "no_accounts_marked",
      message:
        "No account is marked as holding payments that may need a 1099, so no payment is counted. Mark the accounts that hold payments to contractors, lawyers or landlords.",
    },
  ],
};

export const vendorHistory: readonly TaxVendorView[] = [
  vendor({ id: "ven_jane", name: "Jane Doe Design", payeeKeys: ["jane doe"], version: 1 }),
  vendor({
    id: "ven_jane",
    name: "Jane Doe Design",
    payeeKeys: ["jane doe"],
    reporting: "yes",
    w9: "requested",
    version: 2,
    recordedAt: "2026-03-20T10:00:00.000Z",
  }),
  vendorJane,
];

const period = (
  key: string,
  from: string,
  to: string,
  opening: string,
  collected: string,
  remitted: string,
  closing: string,
  stripe: readonly [string, string, string] = ["0.00", "0.00", "0.00"],
  postings = 1,
) => ({
  key,
  from,
  to,
  opening,
  collected,
  remitted,
  closing,
  postings,
  stripeBooked: stripe[0],
  stripeReported: stripe[1],
  stripeDifference: stripe[2],
});

export const sales: TaxSalesData = {
  taxYear: 2026,
  from: "2026-01-01",
  to: "2026-06-30",
  period: "month",
  ledgerPopulationHash: "ebc23fe0309fd55a8d3ea6072a650267a6877885b0d289eeff6c3ddb31f50483",
  accounts: [{ accountId: "2500", code: "2500", name: "Sales tax payable", balance: "33.50" }],
  candidates: [],
  opening: "30.00",
  collected: "69.50",
  remitted: "82.00",
  closing: "17.50",
  periods: [
    period(
      "2026-01",
      "2026-01-01",
      "2026-01-31",
      "30.00",
      "45.50",
      "0.00",
      "75.50",
      ["37.50", "37.50", "0.00"],
      2,
    ),
    period(
      "2026-02",
      "2026-02-01",
      "2026-02-28",
      "75.50",
      "16.00",
      "80.00",
      "11.50",
      ["16.00", "16.00", "0.00"],
      2,
    ),
    period("2026-03", "2026-03-01", "2026-03-31", "11.50", "0.00", "2.00", "9.50", [
      "-2.00",
      "-2.00",
      "0.00",
    ]),
    period("2026-04", "2026-04-01", "2026-04-30", "9.50", "4.00", "0.00", "13.50", undefined, 1),
    period("2026-05", "2026-05-01", "2026-05-31", "13.50", "0.00", "0.00", "13.50", undefined, 0),
    period("2026-06", "2026-06-01", "2026-06-30", "13.50", "20.00", "0.00", "33.50", [
      "20.00",
      "22.00",
      "-2.00",
    ]),
  ],
  stripe: {
    read: true,
    payouts: 4,
    booked: "71.50",
    reported: "73.50",
    salesTax: "stripe",
    taxNotReported: 2,
    refundsWithoutTaxSplit: 0,
  },
  statement:
    "Rastrata does not know your sales tax rates, which of your sales are taxable, which states or cities you must collect in or file with, or when a return is due. These figures are only what your books recorded in the liability account tagged tax.sales: a credit is tax collected, a debit is tax paid or returned. You or your accountant decide what is owed and file the return.",
  notes: [
    {
      key: "account",
      text: "The summary reads the liability account tagged tax.sales. A credit to it is tax collected and a debit is tax paid or returned. The books cannot tell a payment to a state from a refund of tax to a customer or a correction, so every debit is listed with its journal.",
    },
  ],
  warnings: [
    {
      code: "stripe_differs",
      message:
        "In 2026-06 the account took a different amount from Stripe payouts than Stripe reported on them. A journal may have been changed or reversed after the payout was booked. Look at the postings.",
    },
  ],
  disclaimer: worksheet.disclaimer,
};

export const salesNoAccount: TaxSalesData = {
  ...sales,
  accounts: [],
  candidates: [
    { accountId: "2000", code: "2000", name: "Credit card", suggested: false },
    { accountId: "2500", code: "2500", name: "Sales tax payable", suggested: true },
  ],
  opening: "0.00",
  collected: "0.00",
  remitted: "0.00",
  closing: "0.00",
  periods: [],
  stripe: { ...sales.stripe, payouts: 0, booked: "0.00", reported: "0.00", taxNotReported: null },
  warnings: [],
};

export const salesQuarters: TaxSalesData = {
  ...sales,
  period: "quarter",
  periods: [
    period(
      "2026-Q1",
      "2026-01-01",
      "2026-03-31",
      "30.00",
      "61.50",
      "82.00",
      "9.50",
      ["51.50", "51.50", "0.00"],
      5,
    ),
    period(
      "2026-Q2",
      "2026-04-01",
      "2026-06-30",
      "9.50",
      "24.00",
      "0.00",
      "33.50",
      ["20.00", "22.00", "-2.00"],
      2,
    ),
  ],
};

export const salesNoStripe: TaxSalesData = {
  ...sales,
  stripe: {
    read: true,
    payouts: 0,
    booked: "0.00",
    reported: "0.00",
    salesTax: null,
    taxNotReported: null,
    refundsWithoutTaxSplit: null,
  },
  warnings: [],
};

export const previewNew: TaxAdjustmentPreviewView = {
  fileName: "year-end-adjustments.csv",
  rows: 4,
  entries: [
    {
      entry: "AJE-1",
      firstRow: 2,
      date: "2026-12-31",
      narration: "Accrue the year-end legal fee",
      lines: [
        {
          row: 2,
          account: "6080",
          accountName: "Legal and professional services",
          debit: "250.00",
          credit: "0.00",
        },
        {
          row: 3,
          account: "2100",
          accountName: "Accrued expenses",
          debit: "0.00",
          credit: "250.00",
        },
      ],
      debit: "250.00",
      credit: "250.00",
      status: "new",
      draft: null,
      problems: [],
    },
    {
      entry: "AJE-2",
      firstRow: 4,
      date: "2026-12-31",
      narration: "Owner paid a contractor personally",
      lines: [
        { row: 4, account: "6030", accountName: "Contract labor", debit: "100.00", credit: "0.00" },
        {
          row: 5,
          account: "3000",
          accountName: "Owner's investment",
          debit: "0.00",
          credit: "100.00",
        },
      ],
      debit: "100.00",
      credit: "100.00",
      status: "new",
      draft: null,
      problems: [
        {
          severity: "warning",
          code: "date_in_closed_period",
          message:
            "2026-12-31 is in a closed period. The draft can be made, but it cannot be posted until the period is reopened or the date is changed.",
          row: 4,
          entry: "AJE-2",
          column: "Date",
        },
      ],
    },
  ],
  counts: { entries: 2, lines: 4, new: 2, alreadyImported: 0, conflict: 0, invalid: 0 },
  problems: [
    {
      severity: "warning",
      code: "columns_ignored",
      message: 'Not used, and ignored: "Prepared by".',
      row: 1,
    },
  ],
  canImport: true,
  previewHash: "a".repeat(64),
  notice:
    "Importing saves drafts for the owner to review. Nothing is posted. Rastrata books and reports; it does not give tax advice.",
};

export const previewProblems: TaxAdjustmentPreviewView = {
  fileName: "from-the-accountant.csv",
  rows: 6,
  entries: [
    {
      entry: "B1",
      firstRow: 2,
      date: "2026-12-31",
      narration: "No such account",
      lines: [
        { row: 2, account: "9999", accountName: null, debit: "50.00", credit: "0.00" },
        { row: 3, account: "1000", accountName: "Checking", debit: "0.00", credit: "50.00" },
      ],
      debit: "50.00",
      credit: "50.00",
      status: "invalid",
      draft: null,
      problems: [
        {
          severity: "error",
          code: "account_unknown",
          message:
            '"9999" is not an account code in the chart on 2026-12-31. Use a code from chart-of-accounts.csv.',
          row: 2,
          entry: "B1",
          column: "Account",
        },
      ],
    },
    {
      entry: "B2",
      firstRow: 4,
      date: null,
      narration: "Wrong date format",
      lines: [
        {
          row: 4,
          account: "6080",
          accountName: "Legal and professional services",
          debit: "50.00",
          credit: "0.00",
        },
        { row: 5, account: "1000", accountName: "Checking", debit: "0.00", credit: "50.00" },
      ],
      debit: "50.00",
      credit: "50.00",
      status: "invalid",
      draft: null,
      problems: [
        {
          severity: "error",
          code: "date_invalid",
          message: '"31/12/2026" is not a date. Use YYYY-MM-DD, for example 2026-12-31.',
          row: 4,
          entry: "B2",
          column: "Date",
        },
      ],
    },
    {
      entry: "AJE-1",
      firstRow: 6,
      date: "2026-12-31",
      narration: "Accrue the year-end legal fee (corrected)",
      lines: [],
      debit: "260.00",
      credit: "260.00",
      status: "conflict",
      draft: null,
      problems: [
        {
          severity: "error",
          code: "entry_conflict",
          message:
            "Entry AJE-1 was imported before with different figures (date, narration or lines). Nothing was changed. To import the new version, give it a new entry id.",
          row: 6,
          entry: "AJE-1",
          column: null,
        },
      ],
    },
  ],
  counts: { entries: 3, lines: 4, new: 0, alreadyImported: 0, conflict: 1, invalid: 2 },
  problems: [],
  canImport: false,
  previewHash: "b".repeat(64),
  notice: "Importing saves drafts for the owner to review. Nothing is posted.",
};

export const previewAlready: TaxAdjustmentPreviewView = {
  ...previewNew,
  entries: previewNew.entries.map((entry) => ({
    ...entry,
    status: "already_imported" as const,
    draft: { id: `draft-${entry.entry}`, version: 1, status: "draft" },
    problems: [],
  })),
  counts: { entries: 2, lines: 4, new: 0, alreadyImported: 2, conflict: 0, invalid: 0 },
  problems: [],
  canImport: false,
};

export const previewFileProblem: TaxAdjustmentPreviewView = {
  fileName: "notes.csv",
  rows: 0,
  entries: [],
  counts: { entries: 0, lines: 0, new: 0, alreadyImported: 0, conflict: 0, invalid: 0 },
  problems: [
    {
      severity: "error",
      code: "columns_missing",
      message:
        "The header row has no Narration, Credit column. The columns are Entry, Date, Narration, Account, Debit, Credit.",
      row: 1,
    },
  ],
  canImport: false,
  previewHash: "c".repeat(64),
  notice: "Importing saves drafts for the owner to review. Nothing is posted.",
};

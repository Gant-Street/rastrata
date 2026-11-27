/** Synthetic data for the shadow lane's stories: a fictional online business with a checking
 * account, a savings account, a card and Stripe. Nothing here is a real name or balance. */
import type {
  ChecklistAccountView,
  ChecklistView,
  CutoverAccountView,
  CutoverSourceView,
  OpeningBalanceSection,
  OpeningEntryView,
  OpeningIssueView,
  OpeningScreenProps,
} from "../../src";

const noop = () => {};

export const accounts: CutoverAccountView[] = [
  {
    id: "1000",
    code: "1000",
    name: "Business checking",
    kind: "bank",
    chosen: true,
    suggested: "cash",
    selectable: true,
  },
  {
    id: "1010",
    code: "1010",
    name: "Business savings",
    kind: "bank",
    chosen: true,
    suggested: "cash",
    selectable: true,
  },
  {
    id: "2000",
    code: "2000",
    name: "Business credit card",
    kind: "card",
    chosen: false,
    suggested: "",
    selectable: true,
  },
  {
    id: "1100",
    code: "1100",
    name: "Stripe balance",
    kind: "stripe",
    chosen: false,
    suggested: "stripe",
    selectable: false,
  },
];

export const sources: CutoverSourceView[] = [
  {
    key: "csv:1000",
    provider: "csv",
    accountKey: "csv:1000",
    account: "1000 Business checking",
    startOn: null,
    after: "2026-11-01",
    action: "set",
    excluded: 0,
    wouldExclude: 183,
    wouldRestore: 0,
  },
  {
    key: "csv:1010",
    provider: "csv",
    accountKey: "csv:1010",
    account: "1010 Business savings",
    startOn: "2026-10-15",
    after: "2026-11-01",
    action: "move_later",
    excluded: 4,
    wouldExclude: 12,
    wouldRestore: 0,
  },
  {
    key: "csv:2000",
    provider: "csv",
    accountKey: "csv:2000",
    account: "2000 Business credit card",
    startOn: null,
    after: "2026-11-01",
    action: "create",
    excluded: 0,
    wouldExclude: 0,
    wouldRestore: 0,
  },
  {
    key: "ofx:acct-88",
    provider: "ofx",
    accountKey: "ofx:acct-88",
    account: "1000 Business checking",
    startOn: "2026-11-01",
    after: null,
    action: "unchanged",
    excluded: 31,
    wouldExclude: 0,
    wouldRestore: 0,
  },
  {
    key: "ofx:acct-90",
    provider: "ofx",
    accountKey: "ofx:acct-90",
    account: "1010 Business savings",
    startOn: "2026-12-01",
    after: "2026-11-01",
    action: "move_earlier",
    excluded: 9,
    wouldExclude: 0,
    wouldRestore: 6,
  },
  {
    key: "stripe:acct_1:usd",
    provider: "stripe",
    accountKey: "stripe:acct_1:usd",
    account: "1100 Stripe balance",
    startOn: "2026-06-01",
    after: null,
    action: "managed",
    excluded: 0,
    wouldExclude: 0,
    wouldRestore: 0,
    note: "Stripe's first day is Jun 1, 2026 and nothing has been imported from it yet.",
  },
  {
    key: "ofx:unmapped",
    provider: "ofx",
    accountKey: "ofx:unmapped",
    account: null,
    startOn: null,
    after: null,
    action: "unmapped",
    excluded: 0,
    wouldExclude: 0,
    wouldRestore: 0,
  },
];

export const sections = (values: Record<string, string> = {}): OpeningBalanceSection[] => {
  const row = (
    id: string,
    code: string,
    name: string,
    role: "asset" | "liability" | "equity" | "income" | "expense",
    debit: string,
    credit: string,
    error?: string,
  ) => ({
    id,
    code,
    name,
    role,
    value: values[id] ?? "",
    debit: values[id] ? debit : "",
    credit: values[id] ? credit : "",
    ...(error ? { error } : {}),
  });
  return [
    {
      id: "assets",
      title: "Assets",
      rows: [
        row("1000", "1000", "Business checking", "asset", "12000.00", "0.00"),
        row("1010", "1010", "Business savings", "asset", "2500.25", "0.00"),
        row("1100", "1100", "Stripe balance", "asset", "1300.50", "0.00"),
        row("1500", "1500", "Equipment and computers", "asset", "2000.00", "0.00"),
      ],
    },
    {
      id: "liabilities",
      title: "Liabilities",
      rows: [
        row("2000", "2000", "Business credit card", "liability", "0.00", "523.10"),
        row("2500", "2500", "Sales tax payable", "liability", "0.00", "75.00"),
      ],
    },
    {
      id: "equity",
      title: "Equity",
      rows: [row("3000", "3000", "Owner's investment", "equity", "0.00", "0.00")],
    },
    {
      id: "profit",
      title: "Income and expenses, year to date (optional)",
      hint: "Leave these empty unless you want the profit and loss from before the start date in these books.",
      collapsible: true,
      collapsed: true,
      rows: [
        row("4000", "4000", "Sales", "income", "0.00", "0.00"),
        row("6000", "6000", "Software and subscriptions", "expense", "0.00", "0.00"),
      ],
    },
  ];
};

export const entry: OpeningEntryView = {
  date: "2026-10-31",
  currency: "USD",
  lines: [
    { code: "1000", name: "Business checking", debit: "12000.00", credit: "0.00" },
    { code: "1010", name: "Business savings", debit: "2500.25", credit: "0.00" },
    { code: "1100", name: "Stripe balance", debit: "1300.50", credit: "0.00" },
    { code: "2000", name: "Business credit card", debit: "0.00", credit: "523.10" },
    { code: "2500", name: "Sales tax payable", debit: "0.00", credit: "75.00" },
    {
      code: "3900",
      name: "Opening balance equity",
      debit: "0.00",
      credit: "15202.65",
      offset: true,
    },
  ],
  debit: "15800.75",
  credit: "15800.75",
  balanced: true,
};

export const issues: OpeningIssueView[] = [
  {
    severity: "error",
    code: "duplicate_account",
    message: "1000 Business checking is listed twice. Give each account one balance.",
    accountId: "1000",
    row: 6,
  },
  {
    severity: "error",
    code: "account_not_found",
    message: 'No account has the code "9999". Add the account, or fix the code.',
    row: 9,
  },
  {
    severity: "warning",
    code: "journals_before_cutover",
    message:
      "The book already has 3 entries dated before Nov 1, 2026. Opening balances are the balances at the start of Nov 1, 2026, so those entries would be counted twice.",
  },
  {
    severity: "info",
    code: "offset_carries_difference",
    message:
      "3900 Opening balance equity carries 15,202.65 as a credit: everything the balances you entered do not explain.",
  },
];

const base: OpeningScreenProps = {
  state: "ready",
  uncertain: null,
  opening: { status: "none" },
  cutover: {
    date: "2026-11-01",
    accounts,
    sources,
    recorded: { date: "2026-11-01", recordedAt: "2026-11-02T09:15:00.000Z", by: "owner" },
    locked: false,
    unchanged: true,
    onDate: noop,
    onToggle: noop,
    onSubmit: noop,
  },
  balances: {
    sections: sections(),
    entered: { debit: "0.00", credit: "0.00" },
    totals: { debit: "0.00", credit: "0.00" },
    offset: { code: "3900", name: "Opening balance equity", side: "none", amount: "0.00" },
    offsetChoices: [],
    offsetValue: "",
    offsetRequired: false,
    file: { reading: false },
    problems: 0,
    anyEntered: false,
    onInput: noop,
    onBlur: noop,
    onToggleSection: noop,
    onOffset: noop,
    onFile: noop,
    onClear: noop,
  },
  review: { stage: "none", stale: false, entry: null, issues: [], valid: false, onReview: noop },
  plan: {
    stage: "none",
    entry: null,
    valid: false,
    revision: "",
    hash: "",
    warnings: [],
    problems: [],
    onPrepare: noop,
  },
  post: { pending: false, done: false, onPost: noop },
  nextSteps: [
    {
      id: "import",
      href: "/import",
      title: "Import your bank and card statements",
    },
    {
      id: "reconcile",
      href: "/reconcile",
      title: "Reconcile each account to its statement",
    },
    {
      id: "checklist",
      href: "/cutover",
      title: "Close the books",
    },
  ],
};

const typed = {
  "1000": "12,000.00",
  "1010": "2,500.25",
  "1100": "1300.50",
  "2000": "523.10",
  "2500": "75.00",
};

export const screen = {
  empty: base,
  typing: {
    ...base,
    balances: {
      ...base.balances,
      sections: sections(typed),
      entered: { debit: "15800.75", credit: "598.10" },
      totals: { debit: "15800.75", credit: "15800.75" },
      offset: {
        code: "3900",
        name: "Opening balance equity",
        side: "credit" as const,
        amount: "15202.65",
      },
      anyEntered: true,
    },
  },
} satisfies Record<string, OpeningScreenProps>;

export const reviewed: OpeningScreenProps = {
  ...screen.typing,
  review: {
    stage: "reviewed",
    stale: false,
    entry,
    issues: issues.slice(2),
    valid: true,
    onReview: noop,
  },
};

export const prepared: OpeningScreenProps = {
  ...reviewed,
  plan: {
    stage: "prepared",
    entry,
    valid: true,
    revision: "27",
    hash: "9f2c1d7a4be08c3e5a61d0f4b7a8c9d2e1f30a4b5c6d7e8f9012a3b4c5d6e7f8",
    warnings: [],
    problems: [],
    onPrepare: noop,
  },
};

// ---- The checklist ---------------------------------------------------------------------------

const checking: ChecklistAccountView = {
  id: "1000",
  code: "1000",
  name: "Business checking",
  kind: "bank",
  status: "ready",
  bookBalance: "10700.01",
  last: { date: "2026-10-31", balance: "10700.01" },
  throughPeriodEnd: true,
  draft: null,
  waiting: { count: 0, oldestOn: null },
  uncleared: { count: 0, total: "0.00", oldestOn: null },
  reasons: [],
};

const card: ChecklistAccountView = {
  id: "2000",
  code: "2000",
  name: "Business credit card",
  kind: "card",
  status: "ready",
  bookBalance: "580.00",
  last: { date: "2026-10-31", balance: "580.00" },
  throughPeriodEnd: true,
  draft: null,
  waiting: { count: 0, oldestOn: null },
  uncleared: { count: 0, total: "0.00", oldestOn: null },
  reasons: [],
};

const period = {
  id: "period-10",
  label: "October 2026",
  startsOn: "2026-10-01",
  endsOn: "2026-10-31",
  status: "open" as const,
  ended: true,
};

export const readyChecklist: ChecklistView = {
  asOf: "2026-11-05",
  currency: "USD",
  cutover: { date: "2026-10-01", basis: "recorded" },
  opening: "posted",
  period,
  verdict: {
    state: "ready",
    summary: "Ready to close October 2026. 1 thing to look at first.",
    blocking: [],
    attention: [
      {
        code: "drill_never_run",
        section: "backups",
        message: "A restore drill has not been run. It proves a backup restores to the same books.",
      },
    ],
  },
  accounts: [checking, card],
  otherAccounts: [
    {
      id: "1500",
      code: "1500",
      name: "Equipment and computers",
      role: "asset",
      balance: "2000.00",
    },
    { id: "2100", code: "2100", name: "Equipment loan", role: "liability", balance: "850.00" },
  ],
  stripe: {
    status: "ready",
    compared: true,
    ties: true,
    difference: "0.00",
    unpaid: "19.12",
    inTransit: "93.31",
    readAt: "2026-11-05T10:02:00.000Z",
    stale: false,
    explanation: "Stripe holds 19.12 and it is all imported. They agree to the cent.",
    payouts: { known: 6, booked: 6, waiting: 0, mismatched: 0, held: 0, unmatched: 1 },
    reasons: [],
  },
  inbox: { available: true, waiting: 0, oldestOn: null, toReview: 3 },
  backups: {
    available: true,
    reason: null,
    verifiedAt: "2026-11-04T09:00:00.000Z",
    ageHours: 20,
    limitHours: 48,
    drill: null,
  },
  openPeriods: [
    period,
    {
      id: "period-11",
      label: "November 2026",
      startsOn: "2026-11-01",
      endsOn: "2026-11-30",
      status: "open",
      ended: false,
    },
  ],
  shadowRun: {
    required: 2,
    provenCount: 0,
    provenThrough: "2026-10-31",
    complete: false,
    months: [
      { id: "period-10", label: "October 2026", endsOn: "2026-10-31", closed: false, proven: true },
    ],
  },
  unavailable: [],
};

export const notYetChecklist: ChecklistView = {
  ...readyChecklist,
  verdict: {
    state: "not_yet",
    summary: "Not yet: 4 things stand in the way of closing October 2026.",
    blocking: [
      {
        code: "never_reconciled",
        section: "accounts",
        message: "2000 Business credit card has not been reconciled to a statement yet.",
        accountId: "2000",
      },
      {
        code: "not_through_period",
        section: "accounts",
        message:
          "1000 Business checking is reconciled through Sep 30, 2026. Reconcile a statement dated on or after Oct 31, 2026.",
        accountId: "1000",
      },
      {
        code: "inbox_waiting",
        section: "inbox",
        message:
          "12 transactions for review dated through Oct 31, 2026 still need a decision or a posting (oldest Oct 2, 2026).",
      },
      {
        code: "no_verified_backup",
        section: "backups",
        message:
          "No backup of your books has been verified. Back up and verify before closing a month.",
      },
    ],
    attention: [],
  },
  accounts: [
    {
      ...checking,
      status: "blocked",
      last: { date: "2026-09-30", balance: "9900.00" },
      throughPeriodEnd: false,
      draft: { href: "/reconcile/draft-1", statementDate: "2026-10-31", difference: "12.00" },
      waiting: { count: 9, oldestOn: "2026-10-02" },
      uncleared: { count: 14, total: "800.01", oldestOn: "2026-10-01" },
      reasons: [
        {
          code: "not_through_period",
          section: "accounts",
          message:
            "1000 Business checking is reconciled through Sep 30, 2026. Reconcile a statement dated on or after Oct 31, 2026. A draft for Oct 31, 2026 is open with a difference of 12.00.",
          accountId: "1000",
        },
      ],
    },
    {
      ...card,
      status: "blocked",
      last: null,
      throughPeriodEnd: false,
      waiting: { count: 3, oldestOn: "2026-10-20" },
      uncleared: { count: 5, total: "580.00", oldestOn: "2026-10-01" },
      reasons: [
        {
          code: "never_reconciled",
          section: "accounts",
          message: "2000 Business credit card has not been reconciled to a statement yet.",
          accountId: "2000",
        },
      ],
    },
  ],
  stripe: {
    ...(readyChecklist.stripe as NonNullable<ChecklistView["stripe"]>),
    status: "blocked",
    ties: false,
    difference: "5.00",
    explanation:
      "Stripe holds 24.12 and Rastrata expects 19.12: 5.00 is not imported (older than the first day, or newer than the last sync).",
    reasons: [
      {
        code: "stripe_differs",
        section: "stripe",
        message: "Stripe holds 5.00 that has not been imported.",
      },
    ],
  },
  inbox: { available: true, waiting: 12, oldestOn: "2026-10-02", toReview: 15 },
  backups: { ...readyChecklist.backups, verifiedAt: null, ageHours: null },
  shadowRun: {
    required: 2,
    provenCount: 0,
    provenThrough: null,
    complete: false,
    months: [
      {
        id: "period-10",
        label: "October 2026",
        endsOn: "2026-10-31",
        closed: false,
        proven: false,
      },
    ],
  },
};

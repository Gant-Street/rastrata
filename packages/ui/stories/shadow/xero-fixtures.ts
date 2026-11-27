import type {
  AtBlockView,
  AtStepView,
  ChartStepView,
  GapView,
  GapsScreenProps,
  KeepView,
  MappingChoiceView,
  ReconciledStepView,
  TbStepView,
  TieoutReportView,
  TieoutScreenProps,
  XeroAccountView,
  XeroScreenProps,
  XeroStatusView,
} from "../../src/shadow/xero-types";

/** Everything here is made up: a studio that sells to US customers, a Xero organisation with its
 * books a month or two behind, and the figures that fall out. No real name, account or amount. */

const noop = () => {};

// ---- The gap log ----------------------------------------------------------------------------------

export const gaps: readonly GapView[] = [
  {
    id: 7,
    kind: "difference",
    title: "1000 Business checking: a transaction in Xero and not in Rastrata, Aug 14, 2026",
    detail:
      'Xero has a payment of 49.99 dated 2026-08-14, "Hosting", and Rastrata has nothing for that amount within 3 days. Check the statement for that day.',
    source: "tieout",
    status: "open",
    openedAt: "2026-09-02T14:05:00.000Z",
    openedBy: "owner",
    closedAt: null,
    closedBy: null,
    resolution: null,
  },
  {
    id: 8,
    kind: "unmapped",
    title: "Xero account 470 Other Revenue has a balance and no account here",
    detail: "",
    source: "tieout",
    status: "open",
    openedAt: "2026-09-02T14:05:00.000Z",
    openedBy: "owner",
    closedAt: null,
    closedBy: null,
    resolution: null,
  },
  {
    id: 9,
    kind: "feature",
    title: "Xero's repeating invoices have no home here yet",
    detail: "Two customers are billed every month from Xero's repeating invoice list.",
    source: "manual",
    status: "open",
    openedAt: "2026-09-03T09:30:00.000Z",
    openedBy: "agent:tok-4417",
    closedAt: null,
    closedBy: null,
    resolution: null,
  },
  {
    id: 3,
    kind: "difference",
    title: "2000 Business credit card: 1 transaction only in Xero, Jul 28, 2026",
    detail: "Xero entered the same fee twice.",
    source: "tieout",
    status: "closed",
    openedAt: "2026-08-02T10:12:00.000Z",
    openedBy: "owner",
    closedAt: "2026-08-04T16:40:00.000Z",
    closedBy: "owner",
    resolution:
      "Xero entered the same fee twice; Rastrata is right (statement line 14). Left alone in Xero.",
  },
];

const openGaps = gaps.filter((gap) => gap.status === "open");
const closedGaps = gaps.filter((gap) => gap.status === "closed");

const gapsBase: GapsScreenProps = {
  state: "ready",
  uncertain: null,
  filter: "open",
  counts: { open: openGaps.length, closed: closedGaps.length },
  onFilter: noop,
  gaps: openGaps,
  busyId: null,
  actionError: null,
  onClose: noop,
  onReopen: noop,
  add: {
    title: "",
    detail: "",
    kind: "other",
    pending: false,
    done: false,
    onTitle: noop,
    onDetail: noop,
    onKind: noop,
    onSubmit: noop,
  },
};

export const gapsScreen = {
  open: gapsBase,
  closed: { ...gapsBase, filter: "closed", gaps: closedGaps },
  all: { ...gapsBase, filter: "all", gaps },
  none: { ...gapsBase, counts: { open: 0, closed: 0 }, gaps: [] },
  allClear: { ...gapsBase, counts: { open: 0, closed: 4 }, gaps: [] },
  adding: {
    ...gapsBase,
    add: {
      ...gapsBase.add,
      title: "Xero's inventory items have no home here",
      kind: "feature",
      detail: "The studio sells prints; Xero tracks them as inventory items.",
    },
  },
  titleMissing: { ...gapsBase, add: { ...gapsBase.add, titleError: "Give the gap a title." } },
  closeFailed: {
    ...gapsBase,
    actionError: { id: 7, message: "A gap is closed only with a resolution." },
  },
  busy: { ...gapsBase, busyId: 8 },
  uncertain: { ...gapsBase, uncertain: { resuming: false } },
  loading: { ...gapsBase, state: "loading", gaps: [] },
  failed: { ...gapsBase, state: "error", gaps: [], onRetry: noop },
  noBook: { ...gapsBase, state: "error", noBook: true, gaps: [] },
} satisfies Record<string, GapsScreenProps>;

// ---- The comparison -------------------------------------------------------------------------------

export const tieout: TieoutReportView = {
  currency: "USD",
  basis: "cash",
  cutoverDate: "2026-07-01",
  summary: {
    periods: 2,
    comparable: 4,
    matches: 2,
    differs: 2,
    explained: 1,
    unexplained: 1,
    notComparable: 2,
    linesOnlyInXero: 2,
    linesOnlyInRastrata: 1,
  },
  periods: [
    {
      from: "2026-07-01",
      to: "2026-07-31",
      xeroReconciled: true,
      notReconciled: [],
      accounts: [
        {
          accountId: "1000",
          code: "1000",
          name: "Business checking",
          basis: "closing",
          status: "matches",
          reason: null,
          xero: "12840.37",
          rastrata: "12840.37",
          difference: "0.00",
          carried: "0.00",
          residual: "0.00",
          explained: true,
          matched: 41,
          unmatchedCount: 0,
          unmatched: [],
        },
        {
          accountId: "2000",
          code: "2000",
          name: "Business credit card",
          basis: "closing",
          status: "matches",
          reason: null,
          xero: "580.00",
          rastrata: "580.00",
          difference: "0.00",
          carried: "0.00",
          residual: "0.00",
          explained: true,
          matched: 12,
          unmatchedCount: 0,
          unmatched: [],
        },
        {
          accountId: "4000",
          code: "4000",
          name: "Sales",
          basis: "movement",
          status: "not_comparable",
          reason:
            "A cash-basis book against Xero's accrual figures: unpaid invoices and bills make them differ by design.",
          xero: null,
          rastrata: null,
          difference: null,
          carried: null,
          residual: null,
          explained: false,
          matched: 0,
          unmatchedCount: null,
          unmatched: [],
        },
      ],
      unmapped: [{ code: "470", name: "Other Revenue", net: "-125.00" }],
    },
    {
      from: "2026-08-01",
      to: "2026-08-31",
      xeroReconciled: false,
      notReconciled: [
        { code: "090", name: "Business Savings", through: "2026-07-31" },
        { code: "091", name: "Studio Card", through: null },
      ],
      accounts: [
        {
          accountId: "1000",
          code: "1000",
          name: "Business checking",
          basis: "closing",
          status: "differs",
          reason: null,
          xero: "13190.36",
          rastrata: "13140.37",
          difference: "-49.99",
          carried: "0.00",
          residual: "0.00",
          explained: true,
          matched: 38,
          unmatchedCount: 1,
          unmatched: [
            {
              side: "xero",
              date: "2026-08-14",
              description: "Hosting",
              reference: "INV-2217",
              source: "Spend Money",
              debit: "0.00",
              credit: "49.99",
            },
          ],
        },
        {
          accountId: "2000",
          code: "2000",
          name: "Business credit card",
          basis: "closing",
          status: "differs",
          reason: null,
          xero: "910.20",
          rastrata: "898.20",
          difference: "-12.00",
          carried: "0.00",
          residual: "-7.00",
          explained: false,
          matched: 17,
          unmatchedCount: 2,
          unmatched: [
            {
              side: "xero",
              date: "2026-08-03",
              description: "Domain renewal",
              reference: "",
              source: "Spend Money",
              debit: "0.00",
              credit: "12.00",
            },
            {
              side: "rastrata",
              date: "2026-08-21",
              description: "COFFEE ROASTERS",
              reference: "",
              source: "Bank transaction",
              debit: "7.00",
              credit: "0.00",
            },
          ],
        },
        {
          accountId: "1010",
          code: "1010",
          name: "Business savings",
          basis: "closing",
          status: "not_comparable",
          reason: "Xero was not reconciled through Aug 31, 2026 for this account.",
          xero: null,
          rastrata: null,
          difference: null,
          carried: null,
          residual: null,
          explained: false,
          matched: 0,
          unmatchedCount: null,
          unmatched: [],
        },
      ],
      unmapped: [],
    },
  ],
  notes: [
    "A cash-basis book differs from Xero's accrual figures by the unpaid invoices and bills.",
  ],
};

const tieoutBase: TieoutScreenProps = {
  state: "ready",
  uncertain: null,
  range: {
    from: "",
    to: "",
    tolerance: "",
    running: false,
    onFrom: noop,
    onTo: noop,
    onTolerance: noop,
    onRun: noop,
  },
  report: tieout,
  record: { pending: false, result: null, onRecord: noop },
  links: { gaps: "/gaps", xero: "/xero" },
};

export const tieoutScreen = {
  report: tieoutBase,
  recorded: { ...tieoutBase, record: { ...tieoutBase.record, result: { added: 4, existing: 1 } } },
  nothingComparable: {
    ...tieoutBase,
    report: {
      ...tieout,
      summary: {
        periods: 0,
        comparable: 0,
        matches: 0,
        differs: 0,
        explained: 0,
        unexplained: 0,
        notComparable: 0,
        linesOnlyInXero: 0,
        linesOnlyInRastrata: 0,
      },
      periods: [],
    },
  },
  toleranceProblem: {
    ...tieoutBase,
    range: {
      ...tieoutBase.range,
      tolerance: "20",
      toleranceError: "Use a whole number of days from 0 to 14.",
    },
  },
  running: { ...tieoutBase, range: { ...tieoutBase.range, running: true } },
  recordFailed: {
    ...tieoutBase,
    record: { ...tieoutBase.record, error: "The findings could not be added." },
  },
  uncertain: { ...tieoutBase, uncertain: { resuming: false } },
  loading: { ...tieoutBase, state: "loading", report: null },
  failed: { ...tieoutBase, state: "error", report: null, onRetry: noop },
  noBook: { ...tieoutBase, state: "error", noBook: true, report: null },
} satisfies Record<string, TieoutScreenProps>;

// ---- The Xero import ------------------------------------------------------------------------------

export const choices: readonly MappingChoiceView[] = [
  { value: "1000", label: "1000 · Business checking" },
  { value: "1010", label: "1010 · Business savings" },
  { value: "2000", label: "2000 · Business credit card" },
  { value: "2500", label: "2500 · Sales tax payable" },
  { value: "4000", label: "4000 · Sales" },
  { value: "6000", label: "6000 · Software and subscriptions" },
];

const account = (
  row: Partial<XeroAccountView> & Pick<XeroAccountView, "code" | "name" | "type">,
): XeroAccountView => ({
  balance: null,
  tags: [],
  confidence: "none",
  basis: "none",
  problems: [],
  suggestion: null,
  value: "",
  mapsTo: null,
  skip: false,
  candidates: [],
  ...row,
});

export const chartRows: readonly XeroAccountView[] = [
  account({
    code: "090",
    name: "Business checking",
    type: "Bank",
    tags: ["bank"],
    balance: "12840.37",
    confidence: "certain",
    basis: "name",
    mapsTo: "1000 · Business checking",
  }),
  account({
    code: "091",
    name: "Studio card",
    type: "Bank",
    tags: ["bank"],
    balance: "-580.00",
    confidence: "likely",
    basis: "similar",
    mapsTo: "2000 · Business credit card",
  }),
  account({
    code: "200",
    name: "Sales",
    type: "Revenue",
    confidence: "certain",
    basis: "code",
    mapsTo: "4000 · Sales",
  }),
  account({
    code: "470",
    name: "Other Revenue",
    type: "Revenue",
    balance: "-125.00",
    suggestion:
      "Nothing in your book resembles it. Create an income account like Other income, then choose it here.",
  }),
  account({
    code: "489",
    name: "Software",
    type: "Overhead",
    confidence: "check",
    basis: "similar",
    candidates: [{ value: "6000", label: "6000 · Software and subscriptions" }],
  }),
  account({
    code: "820",
    name: "Sales Tax",
    type: "Current Liability",
    tags: ["system"],
    problems: ["Another Xero account is already mapped there."],
  }),
  account({
    code: "999",
    name: "Suspense",
    type: "Current Asset",
    tags: ["archived"],
    skip: true,
    value: "skip",
    basis: "override",
  }),
];

const noKeep: KeepView = {
  pending: false,
  canKeep: false,
  unreadable: 0,
  skipUnreadable: false,
  onSkipUnreadable: noop,
  onKeep: noop,
};

export const chartStep: ChartStepView = {
  fileName: "chart-of-accounts.csv",
  busy: false,
  onFile: noop,
  preview: {
    source: "file",
    counts: { accounts: 7, certain: 2, likely: 1, check: 1 },
    rows: chartRows,
    issues: [
      {
        severity: "warning",
        code: "archived_account",
        message: "999 Suspense is archived in Xero.",
        row: 8,
      },
    ],
    columns: [
      { header: "*Code", field: "code" },
      { header: "*Name", field: "name" },
      { header: "*Type", field: "type" },
      { header: "*Tax Code", field: "taxCode" },
      { header: "Balance", field: "balance" },
    ],
  },
  choices,
  onChoose: noop,
  acceptLikely: true,
  onAcceptLikely: noop,
  keep: { ...noKeep, canKeep: true },
};

export const tbStep: TbStepView = {
  fileName: "trial-balance-2026-06-30.csv",
  busy: false,
  onFile: noop,
  dateOrder: "mdy",
  onDateOrder: noop,
  includeProfitLoss: false,
  onIncludeProfitLoss: noop,
  preview: {
    asOf: "2026-06-30",
    balanced: true,
    rows: [
      {
        row: 6,
        xeroCode: "090",
        name: "Business checking",
        net: "12840.37",
        status: "mapped",
        mapsTo: "1000 · Business checking",
        balance: "12840.37",
      },
      {
        row: 7,
        xeroCode: "091",
        name: "Studio card",
        net: "-580.00",
        status: "mapped",
        mapsTo: "2000 · Business credit card",
        balance: "580.00",
      },
      {
        row: 8,
        xeroCode: "200",
        name: "Sales",
        net: "-9100.00",
        status: "profit_loss",
        mapsTo: "4000 · Sales",
        balance: null,
      },
      {
        row: 9,
        xeroCode: "470",
        name: "Other Revenue",
        net: "-125.00",
        status: "unmapped",
        mapsTo: null,
        balance: null,
      },
      {
        row: 10,
        xeroCode: "960",
        name: "Retained Earnings",
        net: "-2300.00",
        status: "retained_earnings",
        mapsTo: null,
        balance: null,
      },
    ],
    issues: [],
    leftOut: { profitLoss: 1, unmapped: 1, skipped: 0, retainedEarnings: "-2300.00" },
    cutoverNote: "That is the day before the start date, Jul 1, 2026: right for opening balances.",
    asOfIsDayBefore: true,
    columns: [
      { header: "Account", field: "account" },
      { header: "Debit", field: "debit" },
      { header: "Credit", field: "credit" },
      { header: "YTD Debit", field: "ytdDebit" },
      { header: "YTD Credit", field: "ytdCredit" },
    ],
  },
  keep: { ...noKeep, canKeep: true },
  canUseAsOpening: true,
  onUseAsOpening: noop,
};

export const atBlocks: readonly AtBlockView[] = [
  {
    heading: "Business checking",
    xeroCode: "090",
    name: "Business checking",
    status: "mapped",
    mapsTo: "1000 · Business checking",
    lines: 41,
    debit: "9120.55",
    credit: "7432.10",
    fileDebit: "9120.55",
    fileCredit: "7432.10",
    agrees: true,
    sample: [
      {
        date: "2026-07-02",
        description: "Customer payment",
        reference: "INV-2201",
        debit: "480.00",
        credit: "0.00",
      },
      {
        date: "2026-07-03",
        description: "Hosting",
        reference: "",
        debit: "0.00",
        credit: "49.99",
      },
    ],
  },
  {
    heading: "Other Revenue",
    xeroCode: "470",
    name: "Other Revenue",
    status: "unmapped",
    mapsTo: null,
    lines: 2,
    debit: "0.00",
    credit: "125.00",
    fileDebit: "0.00",
    fileCredit: "130.00",
    agrees: false,
    sample: [],
  },
];

export const atStep: AtStepView = {
  fileName: "account-transactions-july.csv",
  busy: false,
  onFile: noop,
  dateOrder: "mdy",
  onDateOrder: noop,
  preview: {
    periodFrom: "2026-07-01",
    periodTo: "2026-07-31",
    lineCount: 43,
    blocks: atBlocks,
    issues: [
      {
        severity: "error",
        code: "block_total_differs",
        message:
          "Other Revenue: the lines add up to 125.00 and the Total row says 130.00. A row is missing or was left out.",
        row: 61,
      },
    ],
    columns: [
      { header: "Date", field: "date" },
      { header: "Source", field: "source" },
      { header: "Description", field: "description" },
      { header: "Reference", field: "reference" },
      { header: "Debit", field: "debit" },
      { header: "Credit", field: "credit" },
    ],
  },
  keep: { ...noKeep, unreadable: 1 },
};

export const reconciledStep: ReconciledStepView = {
  rows: [
    { code: "090", name: "Business checking", through: "2026-07-31" },
    { code: "091", name: "Studio card", through: "" },
  ],
  onThrough: noop,
  save: { pending: false, canSave: true, onSave: noop },
};

export const status: XeroStatusView = {
  chartImportedAt: "2026-09-01T10:00:00.000Z",
  counts: { accounts: 7, mapped: 3, skipped: 1, unmapped: 3, unmappedWithBalance: 1 },
  trialBalances: ["2026-06-30", "2026-07-31"],
  transactions: [{ from: "2026-07-01", to: "2026-07-31", accounts: 12, lines: 143 }],
  reconciled: [{ code: "090", name: "Business checking", through: "2026-07-31" }],
  notes: [],
};

const empty: XeroScreenProps = {
  state: "ready",
  uncertain: null,
  status: {
    chartImportedAt: null,
    counts: { accounts: 0, mapped: 0, skipped: 0, unmapped: 0, unmappedWithBalance: 0 },
    trialBalances: [],
    transactions: [],
    reconciled: [],
    notes: [],
  },
  chart: {
    fileName: null,
    busy: false,
    onFile: noop,
    preview: null,
    choices,
    onChoose: noop,
    acceptLikely: true,
    onAcceptLikely: noop,
    keep: noKeep,
  },
  trialBalance: {
    fileName: null,
    busy: false,
    onFile: noop,
    preview: null,
    dateOrder: "mdy",
    onDateOrder: noop,
    includeProfitLoss: false,
    onIncludeProfitLoss: noop,
    keep: noKeep,
    canUseAsOpening: false,
    onUseAsOpening: noop,
  },
  transactions: {
    fileName: null,
    busy: false,
    onFile: noop,
    preview: null,
    dateOrder: "mdy",
    onDateOrder: noop,
    keep: noKeep,
  },
  reconciled: { rows: [], onThrough: noop, save: { pending: false, canSave: false, onSave: noop } },
  links: { tieout: "/tie-out", opening: "/opening" },
};

export const xeroScreen = {
  empty,
  imported: {
    ...empty,
    status,
    chart: chartStep,
    trialBalance: tbStep,
    transactions: atStep,
    reconciled: reconciledStep,
  },
  uncertain: { ...empty, uncertain: { resuming: false } },
  noBook: { ...empty, state: "error", noBook: true, status: null },
  decided: {
    ...empty,
    status,
    chart: {
      ...chartStep,
      preview: chartStep.preview && {
        ...chartStep.preview,
        rows: chartRows.map((row) =>
          row.code === "470"
            ? { ...row, value: "4000", mapsTo: "4000 · Sales", basis: "override" as const }
            : row,
        ),
      },
    },
  },
} satisfies Record<string, XeroScreenProps>;

import type {
  StripeAccountOption,
  StripeBalanceView,
  StripeKeyInfo,
  StripePayoutView,
  StripeRoleKey,
  StripeRoleView,
  StripeRun,
  StripeSettingsValues,
} from "../../src";

/** Invented data for the Stripe stories: a fictional business. Nothing here is real and no key is
 * present anywhere; the key information is only the description Rastrata is allowed to show. */

export const accounts: readonly StripeAccountOption[] = [
  { value: "1000", label: "1000 · Checking", kind: "asset", closed: false },
  { value: "1100", label: "1100 · Stripe balance", kind: "asset", closed: false },
  { value: "1110", label: "1110 · Stripe payouts in transit", kind: "asset", closed: false },
  { value: "2500", label: "2500 · Sales tax payable", kind: "liability", closed: false },
  { value: "4000", label: "4000 · Sales", kind: "income", closed: false },
  { value: "4010", label: "4010 · Other sales", kind: "income", closed: false },
  { value: "4100", label: "4100 · Returns and allowances", kind: "income", closed: false },
  { value: "6025", label: "6025 · Stripe fees", kind: "expense", closed: false },
  { value: "6026", label: "6026 · Chargebacks and disputes", kind: "expense", closed: false },
  { value: "6040", label: "6040 · Other Stripe adjustments", kind: "expense", closed: false },
  { value: "6030", label: "6030 · Old payment fees", kind: "expense", closed: true },
];

/** The accounts the chart's role keys name, as the online business template tags them. */
export const taggedAccounts: Readonly<Partial<Record<StripeRoleKey, string>>> = {
  "stripe.balance": "1100",
  "payouts.in-transit": "1110",
  "revenue.sales": "4000",
  "tax.sales": "2500",
  refunds: "4100",
  chargebacks: "6026",
  "stripe.fees": "6025",
};

const view = (
  role: StripeRoleKey,
  state: StripeRoleView["state"],
  accountId: string | null,
  problem: string | null = null,
): StripeRoleView => ({
  role,
  required: role !== "stripe.adjustments",
  state,
  accountId,
  code: accountId,
  problem,
});

const ALL_ROLES: readonly StripeRoleKey[] = [
  "payouts.in-transit",
  "revenue.sales",
  "tax.sales",
  "refunds",
  "chargebacks",
  "stripe.fees",
  "stripe.adjustments",
  "stripe.balance",
];

const adjustmentsMissing = view(
  "stripe.adjustments",
  "missing",
  null,
  "No account is chosen for Other Stripe adjustments, and no open account carries the role key stripe.adjustments. Choose one here, or give an account that role key in your chart of accounts.",
);

/** Every required role found through the chart's keys; the optional one has none. */
export const rolesFromChart: readonly StripeRoleView[] = ALL_ROLES.map((role) =>
  role === "stripe.adjustments"
    ? adjustmentsMissing
    : view(role, "tagged", taggedAccounts[role] ?? null),
);

/** The owner chose the fees account and the optional adjustments account. */
export const rolesChosen: readonly StripeRoleView[] = ALL_ROLES.map((role) =>
  role === "stripe.fees"
    ? view(role, "chosen", "6025")
    : role === "stripe.adjustments"
      ? view(role, "chosen", "6040")
      : view(role, "tagged", taggedAccounts[role] ?? null),
);

/** A book whose accounts carry no role keys: nothing can be settled until the owner chooses. */
export const rolesUntagged: readonly StripeRoleView[] = ALL_ROLES.map((role) =>
  role === "stripe.adjustments"
    ? adjustmentsMissing
    : view(
        role,
        "missing",
        null,
        `No account is chosen for ${role}, and no open account carries the role key ${role}. Choose one here, or give an account that role key in your chart of accounts.`,
      ),
);

/** Two accounts carry one key; one carries a key but is the wrong kind of account. */
export const rolesTrouble: readonly StripeRoleView[] = ALL_ROLES.map((role) =>
  role === "revenue.sales"
    ? view(
        role,
        "ambiguous",
        null,
        "Accounts 4000, 4010 all carry the role key revenue.sales, so Rastrata cannot tell which is Sales. Choose one here, or leave the key on one account.",
      )
    : role === "tax.sales"
      ? view(
          role,
          "unusable",
          null,
          "Sales tax payable must be a liability account; 6025 is expense. It carries the role key tax.sales: choose another account here, or move the key.",
        )
      : role === "stripe.adjustments"
        ? adjustmentsMissing
        : view(role, "tagged", taggedAccounts[role] ?? null),
);

export const emptyValues: StripeSettingsValues = {
  mapping: {},
  syncFrom: "2026-01-01",
  timeZone: "UTC",
  salesTax: "stripe",
  overlapDays: "3",
  matchWindowDays: "2",
};

export const savedValues: StripeSettingsValues = {
  ...emptyValues,
  timeZone: "America/Denver",
};

export const chosenValues: StripeSettingsValues = {
  ...savedValues,
  mapping: { "stripe.fees": "6025", "stripe.adjustments": "6040" },
};

export const keyFound: StripeKeyInfo = {
  present: true,
  source: "environment",
  mode: "live",
  restricted: true,
  problem: null,
  warning: null,
};
export const keyTest: StripeKeyInfo = { ...keyFound, source: "file", mode: "test" };
export const keyUnrestricted: StripeKeyInfo = {
  ...keyFound,
  restricted: false,
  warning:
    "This is an unrestricted secret key. Rastrata only reads from Stripe; a restricted read-only key (rk_...) means a leak could not move money.",
};
export const keyMissing: StripeKeyInfo = {
  present: false,
  source: null,
  mode: null,
  restricted: null,
  problem: null,
  warning: null,
};
export const keyBroken: StripeKeyInfo = {
  ...keyMissing,
  problem:
    "/Users/example/rastrata/data/stripe.key can be read by other users. Run: chmod 600 /Users/example/rastrata/data/stripe.key",
};

export const account = {
  id: "acct_1ExampleAccount001",
  defaultCurrency: "usd",
  timeZone: "America/Denver",
};

const run = (over: Partial<StripeRun>): StripeRun => ({
  id: "run-1",
  startedAt: "2026-03-20T12:00:00.000Z",
  finishedAt: "2026-03-20T12:00:03.000Z",
  disposition: "complete",
  requests: 41,
  transactions: 126,
  newLines: 126,
  duplicateLines: 0,
  heldLines: 0,
  payouts: 18,
  through: "2026-03-20",
  errorCode: null,
  errorMessage: null,
  notes: [
    "18 payouts booked, each as one entry waiting in the Inbox with its transactions as evidence.",
    "1 movement Rastrata does not book by itself (an adjustment, a top-up, a reserve) is inside payouts. Choose an adjustments account in the settings so those payouts can be proposed.",
    "9 charges had no sales tax figure from Stripe (not paid through Checkout or an invoice), so all of them were booked as sales.",
  ],
  ...over,
});

export const lastRun = run({});
export const quietRun = run({
  id: "run-2",
  newLines: 0,
  payouts: 0,
  notes: [],
  requests: 3,
  transactions: 0,
  startedAt: "2026-03-21T09:00:00.000Z",
  finishedAt: "2026-03-21T09:00:01.000Z",
});
export const heldRun = run({
  id: "run-5",
  heldLines: 1,
  payouts: 17,
  notes: [
    "1 payout was made by hand, so Stripe does not say which transactions it paid out. It is held for you to categorise.",
  ],
});
export const stoppedRun = run({
  id: "run-3",
  disposition: "more",
  newLines: 340,
  payouts: 40,
  notes: [],
});
export const failedRun = run({
  id: "run-4",
  disposition: "failed",
  errorCode: "stripe_permission_denied",
  errorMessage:
    "Stripe refused a request because the key lacks a permission. Add read access for it, or use a key that has it.",
  newLines: 0,
  payouts: 0,
  notes: [],
});

export const history: readonly StripeRun[] = [
  quietRun,
  failedRun,
  stoppedRun,
  lastRun,
  ...Array.from({ length: 6 }, (_, i) =>
    run({
      id: `run-h${i}`,
      startedAt: `2026-03-${String(10 - i).padStart(2, "0")}T08:00:00.000Z`,
      newLines: 12 + i,
      payouts: 2 + i,
      requests: 9 + i,
      notes: [],
    }),
  ),
];

export const balanceTies: StripeBalanceView = {
  readAt: "2026-03-21T09:00:01.000Z",
  currency: "USD",
  stripeTotal: "81.40",
  available: "62.37",
  pending: "19.03",
  unpaid: "81.40",
  unpaidCount: 5,
  difference: "0.00",
  inTransit: "1256.94",
  ties: true,
  stale: false,
  explanation:
    "Stripe holds 81.40 (62.37 available, 19.03 pending): every transaction not yet paid out. Rastrata knows of 5 transactions not yet in a payout, 81.40 in all. They agree to the cent. Your books show 1256.94 in payouts in transit: payouts booked whose bank deposit has not been matched yet.",
};

export const balanceMoreInStripe: StripeBalanceView = {
  ...balanceTies,
  unpaid: "62.37",
  unpaidCount: 4,
  difference: "19.03",
  ties: false,
  explanation:
    "Stripe holds 81.40 (62.37 available, 19.03 pending): every transaction not yet paid out. Rastrata knows of 4 transactions not yet in a payout, 62.37 in all. The other 19.03 is in transactions Rastrata has not imported: older than 2026-01-01 (the first payouts after it carry them, and are booked with them), or newer than the last sync.",
};

export const balanceMoreInRastrata: StripeBalanceView = {
  ...balanceTies,
  unpaid: "100.00",
  unpaidCount: 6,
  difference: "-18.60",
  ties: false,
  explanation:
    "Stripe holds 81.40 and Rastrata knows of 6 transactions not yet in a payout, 100.00 in all. Rastrata knows of 18.60 more than Stripe holds. Check that no payout was imported twice.",
};

export const balanceStale: StripeBalanceView = {
  ...balanceMoreInStripe,
  stale: true,
  readAt: "2026-03-14T09:00:01.000Z",
};
export const balanceNotRead: StripeBalanceView = {
  readAt: null,
  currency: "USD",
  stripeTotal: null,
  available: null,
  pending: null,
  unpaid: null,
  unpaidCount: 0,
  difference: null,
  inTransit: null,
  ties: false,
  stale: true,
  explanation: "",
};
export const balanceBooksUnreadable: StripeBalanceView = {
  ...balanceTies,
  inTransit: null,
};
export const balanceBig: StripeBalanceView = {
  ...balanceMoreInStripe,
  stripeTotal: "98765432.10",
  available: "98700000.00",
  pending: "65432.10",
  unpaid: "1234.56",
  difference: "98764197.54",
  inTransit: "12345678.90",
};

const payout = (n: number, over: Partial<StripePayoutView> = {}): StripePayoutView => {
  const memberCount = 1 + (n % 7);
  const amount = n % 3 === 0 ? "19.12" : n % 3 === 1 ? "93.31" : "1256.94";
  return {
    id: `po_1Example${String(n).padStart(8, "0")}`,
    arrivalOn: `2026-03-${String(20 - (n % 18)).padStart(2, "0")}`,
    amount,
    currency: "usd",
    status: "paid",
    automatic: true,
    booking: "booked",
    memberCount,
    memberNet: amount,
    difference: "0.00",
    deposit: "unmatched",
    reason: null,
    ...over,
  };
};

export const payouts: readonly StripePayoutView[] = [
  payout(1, { deposit: "matched" }),
  payout(2),
  payout(3, {
    booking: "mismatch",
    difference: "3.00",
    memberCount: 4,
    memberNet: "16.12",
    reason:
      "Payout po_1Example00000003: the 4 transactions Stripe says it paid out add up to 16.12, not the payout's 19.12.",
  }),
  payout(4, {
    booking: "waiting",
    memberCount: 0,
    memberNet: null,
    difference: null,
    reason: "Waiting for Stripe to finish itemising this payout; it is booked on a later sync.",
  }),
  payout(5, {
    status: "failed",
    deposit: "reversed",
    reason: "Stripe returned this payout to the balance, so no deposit is expected.",
  }),
  payout(6, {
    booking: "held",
    automatic: false,
    memberCount: 0,
    memberNet: null,
    difference: null,
    deposit: "unchecked",
    reason:
      "Payout po_1Example00000006 was made by hand, so Stripe does not say which transactions it paid out. It is held for you to categorise.",
  }),
];

export const manyPayouts: readonly StripePayoutView[] = Array.from({ length: 25 }, (_, i) =>
  payout(i + 10),
);

export const longPayout: StripePayoutView = payout(99, {
  status:
    "in_transit_with_a_very_long_status_word_that_should_wrap_instead_of_stretching_the_table",
  amount: "12345678.90",
});

export const arabicAccounts: readonly StripeAccountOption[] = accounts.map((a, i) =>
  i === 4 ? { ...a, label: "4000 · المبيعات عبر الإنترنت" } : a,
);

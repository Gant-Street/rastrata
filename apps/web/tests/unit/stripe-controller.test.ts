import { expect, test } from "bun:test";
import type {
  StripePayoutRow,
  StripeRoleStatus,
  StripeStatus,
} from "@rastrata/application/client-contracts";
import {
  cardSummary,
  fiscalYearStart,
  payoutView,
  roleView,
  settingsErrors,
  settingsValues,
  openRoles,
} from "../../src/routes/stripe/controller";

const role = (
  over: Partial<StripeRoleStatus> & Pick<StripeRoleStatus, "role">,
): StripeRoleStatus => ({
  label: over.role,
  required: true,
  state: "tagged",
  accountId: "1100",
  code: "1100",
  problem: null,
  ...over,
});

const LABELS: Record<string, string> = {
  "payouts.in-transit": "Payouts in transit",
  "revenue.sales": "Sales",
  "tax.sales": "Sales tax payable",
  refunds: "Refunds",
  chargebacks: "Chargebacks and disputes",
  "stripe.fees": "Stripe fees",
  "stripe.adjustments": "Other Stripe adjustments",
  "stripe.balance": "Stripe balance",
};
const allRoles: StripeRoleStatus[] = Object.entries(LABELS).map(([key, label]) =>
  role({ role: key as StripeRoleStatus["role"], label }),
);

const status = (over: Partial<StripeStatus> = {}): StripeStatus => ({
  configured: true,
  bookCurrency: "USD",
  key: {
    present: true,
    source: "environment",
    mode: "live",
    restricted: true,
    problem: null,
    warning: null,
  },
  settings: {
    mapping: [{ role: "stripe.fees", accountId: "6025" }],
    syncFrom: "2026-01-01",
    timeZone: "America/Denver",
    salesTax: "stripe",
    overlapDays: 3,
    matchWindowDays: 2,
    accountKey: "stripe:acct_1",
  },
  roles: [role({ role: "stripe.balance" })],
  account: { id: "acct_1", defaultCurrency: "USD", timeZone: "America/Denver" },
  lastSync: null,
  history: [],
  through: null,
  balance: {
    snapshot: null,
    unpaid: null,
    unpaidCount: 0,
    difference: null,
    inTransit: null,
    ties: false,
    stale: true,
    explanation: "",
  },
  payouts: {
    known: 6,
    booked: 5,
    waiting: 1,
    mismatched: 2,
    held: 3,
    reversed: 1,
    unmatched: 4,
    overdue: 0,
    oldestOverdueOn: null,
  },
  held: {
    lines: 0,
    otherCurrency: 0,
    manualPayouts: 0,
    adjustments: 0,
    taxNotReported: 0,
    refundsWithoutTaxSplit: 0,
  },
  ...over,
});

test("a refusal lands on the role it names, and Sales tax payable is never taken for Sales", () => {
  expect(
    settingsErrors("Stripe fees must be an expense account; 2500 is liability.", allRoles),
  ).toEqual({
    mapping: { "stripe.fees": "Stripe fees must be an expense account; 2500 is liability." },
  });
  expect(
    settingsErrors("Sales tax payable must be a liability account; 6025 is expense.", allRoles),
  ).toEqual({
    mapping: {
      "tax.sales": "Sales tax payable must be a liability account; 6025 is expense.",
    },
  });
  expect(settingsErrors("Sales must be an income account; 6025 is expense.", allRoles)).toEqual({
    mapping: { "revenue.sales": "Sales must be an income account; 6025 is expense." },
  });
  expect(
    settingsErrors("The account chosen for Refunds is no longer in the chart.", allRoles),
  ).toEqual({
    mapping: { refunds: "The account chosen for Refunds is no longer in the chart." },
  });
  expect(
    settingsErrors("Account 4010, chosen for Chargebacks and disputes, is closed.", allRoles),
  ).toEqual({
    mapping: { chargebacks: "Account 4010, chosen for Chargebacks and disputes, is closed." },
  });
  expect(
    settingsErrors(
      "Payouts in transit cannot use account 1100: it is the Stripe balance.",
      allRoles,
    ),
  ).toEqual({
    mapping: {
      "payouts.in-transit": "Payouts in transit cannot use account 1100: it is the Stripe balance.",
    },
  });
});

test("a refusal about an option lands on its field, and anything else on the form", () => {
  expect(
    settingsErrors("syncFrom must be a real date no later than today.", allRoles).syncFrom,
  ).toBeDefined();
  expect(
    settingsErrors("timeZone must be an IANA time zone such as UTC.", allRoles).timeZone,
  ).toBeDefined();
  expect(settingsErrors("overlapDays must be at most 30", allRoles).overlapDays).toBeDefined();
  expect(
    settingsErrors("matchWindowDays must be at most 14", allRoles).matchWindowDays,
  ).toBeDefined();
  expect(settingsErrors("The service is unavailable", allRoles)).toEqual({
    form: "The service is unavailable",
  });
});

test("the form starts from what was saved, else from defaults, and holds only chosen accounts", () => {
  const saved = settingsValues(status(), "2026-01-01");
  expect(saved.saved).toBe(true);
  expect(saved.values.mapping).toEqual({ "stripe.fees": "6025" });
  expect(saved.values).toMatchObject({
    syncFrom: "2026-01-01",
    timeZone: "America/Denver",
    salesTax: "stripe",
    overlapDays: "3",
    matchWindowDays: "2",
  });
  const fresh = settingsValues(status({ settings: null, account: null }), "2026-04-01");
  expect(fresh.saved).toBe(false);
  expect(fresh.values).toEqual({
    mapping: {},
    syncFrom: "2026-04-01",
    timeZone: "UTC",
    salesTax: "stripe",
    overlapDays: "3",
    matchWindowDays: "2",
  });
  // Stripe's own time zone is offered when it is known.
  expect(settingsValues(status({ settings: null }), "2026-04-01").values.timeZone).toBe(
    "America/Denver",
  );
});

test("the first day of the fiscal year, for the default", () => {
  expect(fiscalYearStart({ fiscalYear: 2026 })).toBe("2026-01-01");
  expect(fiscalYearStart({ fiscalYear: 2026, fiscalYearStartMonth: 7 })).toBe("2026-07-01");
});

test("the accounts Stripe needs and has none for are named, and nothing else stands in the way of a reading: not a first save, and never the optional one", () => {
  expect(openRoles(status())).toEqual([]);
  // Nothing saved yet: the defaults are in use, and nothing is asked.
  expect(openRoles(status({ settings: null }))).toEqual([]);
  expect(
    openRoles(
      status({
        configured: false,
        roles: [
          role({ role: "revenue.sales", label: "Sales", state: "missing", accountId: null }),
          role({
            role: "tax.sales",
            label: "Sales tax payable",
            state: "ambiguous",
            accountId: null,
          }),
          role({
            role: "stripe.adjustments",
            label: "Other Stripe adjustments",
            required: false,
            state: "missing",
            accountId: null,
          }),
        ],
      }),
    ),
  ).toEqual(["Sales", "Sales tax payable"]);
});

test("the home card says which stage the connection is at and counts what needs a look", () => {
  expect(cardSummary(status()).stage).toBe("ready");
  expect(cardSummary(status({ configured: false })).stage).toBe("unconfigured");
  expect(
    cardSummary(status({ key: { ...status().key, present: false, source: null, mode: null } }))
      .stage,
  ).toBe("no-key");
  const synced = cardSummary(
    status({
      lastSync: {
        id: "r",
        startedAt: "2026-03-20T12:00:00.000Z",
        finishedAt: "2026-03-20T12:00:03.000Z",
        disposition: "complete",
        requests: 3,
        pages: 1,
        transactions: 9,
        newLines: 9,
        duplicateLines: 0,
        heldLines: 0,
        payouts: 4,
        through: "2026-03-20",
        errorCode: null,
        errorMessage: null,
        notes: [],
      },
    }),
  );
  expect(synced).toEqual({
    stage: "ready",
    lastSync: { at: "2026-03-20T12:00:03.000Z", ok: true, payouts: 4 },
    held: 3,
    mismatched: 2,
    waiting: 1,
    unmatched: 4,
  });
});

test("a payout and a role keep the service's own words", () => {
  const row: StripePayoutRow = {
    id: "po_1",
    amount: "93.31",
    currency: "USD",
    createdOn: "2026-03-06",
    arrivalOn: "2026-03-09",
    status: "paid",
    automatic: true,
    itemised: "completed",
    booking: "booked",
    memberCount: 6,
    memberNet: "93.31",
    difference: "0.00",
    deposit: "matched",
    reason: "Booked as one entry in the Inbox.",
  };
  expect(payoutView(row)).toMatchObject({
    id: "po_1",
    booking: "booked",
    memberCount: 6,
    deposit: "matched",
    reason: "Booked as one entry in the Inbox.",
  });
  expect(roleView(role({ role: "refunds", problem: "nothing" }))).toEqual({
    role: "refunds",
    required: true,
    state: "tagged",
    accountId: "1100",
    code: "1100",
    problem: "nothing",
  });
});

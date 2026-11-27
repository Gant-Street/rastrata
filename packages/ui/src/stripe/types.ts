/** What the Stripe components show. Plain data, in the shapes the Stripe operations return, so a
 * story needs no service and the route stays a thin loader. Money is always a decimal string with
 * two places and is never converted to a number. */

export type StripeRoleKey =
  | "stripe.balance"
  | "stripe.fees"
  | "payouts.in-transit"
  | "refunds"
  | "chargebacks"
  | "tax.sales"
  | "revenue.sales"
  | "stripe.adjustments";

/** The order the roles are listed in: the accounts of a payout's entry, top to bottom, and the
 * Stripe balance last. */
export const STRIPE_ROLE_ORDER: readonly StripeRoleKey[] = [
  "payouts.in-transit",
  "revenue.sales",
  "tax.sales",
  "refunds",
  "chargebacks",
  "stripe.fees",
  "stripe.adjustments",
  "stripe.balance",
];

/** How a role came to have an account, or why it has none. `chosen`: the owner picked it here.
 * `tagged`: the owner picked none and exactly one open account carries the role key in the chart.
 * `missing`, `ambiguous` and `unusable` say why there is none. */
export type StripeRoleState = "chosen" | "tagged" | "missing" | "ambiguous" | "unusable";

export type StripeRoleView = {
  role: StripeRoleKey;
  required: boolean;
  state: StripeRoleState;
  accountId: string | null;
  code: string | null;
  /** What is wrong and what to do about it, in the service's words; null when the role has its account. */
  problem: string | null;
};

export type StripeKeyInfo = {
  present: boolean;
  source: "environment" | "file" | null;
  mode: "live" | "test" | null;
  /** True for a restricted key (rk_), false for an unrestricted secret key (sk_). */
  restricted: boolean | null;
  /** Why the key cannot be used; null when it can. */
  problem: string | null;
  /** Something to know about a usable key. */
  warning: string | null;
};

export type StripeAccountInfo = {
  id: string;
  defaultCurrency: string;
  timeZone: string | null;
};

export type StripeAccountOption = {
  value: string;
  /** "6025 · Stripe fees". Chart names are the owner's own text and are shown isolated. */
  label: string;
  /** The account's kind: asset, liability, equity, income or expense. */
  kind: string;
  closed: boolean;
};

export type StripeSettingsValues = {
  /** Only the accounts the owner chose. A role not listed uses the account its chart role key names. */
  mapping: Partial<Record<StripeRoleKey, string>>;
  syncFrom: string;
  timeZone: string;
  salesTax: "stripe" | "none";
  overlapDays: string;
  matchWindowDays: string;
};

export type StripeSettingsErrors = {
  /** A problem with the request as a whole, for example a failed connection. */
  form?: string;
  mapping?: Partial<Record<StripeRoleKey, string>>;
  syncFrom?: string;
  timeZone?: string;
  overlapDays?: string;
  matchWindowDays?: string;
};

export type StripeRun = {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  disposition: "running" | "complete" | "more" | "interrupted" | "failed";
  requests: number;
  transactions: number;
  newLines: number;
  duplicateLines: number;
  heldLines: number;
  /** Payouts this run booked as one entry each. */
  payouts: number;
  /** The date everything before which has been applied. */
  through: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  notes: readonly string[];
};

export type StripeSyncState = "idle" | "running" | "failed" | "uncertain";

/** The Stripe account an owner connected with the button, in the shape the card draws. `unavailable`: this service cannot connect Stripe; `none`: nothing is connected yet; `connected`:
 * the account is being read every day; `stopped`: it was connected and is not now (the owner stopped it, or took the app out of Stripe, or the books would not take it). */
export type StripeAppView = {
  stage: "unavailable" | "none" | "connected" | "stopped";
  accountId: string | null;
  /** Real sales (Stripe's live mode) or practice data (its test mode). */
  live: boolean;
  connectedAt: string | null;
  /** When a reading last finished; null when none has. */
  syncedAt: string | null;
  /** A reading is waiting or under way. */
  reading: boolean;
  /** What went wrong, in words, or null. */
  problem: string | null;
  canConnect: boolean;
  canReadNow: boolean;
  canDisconnect: boolean;
};

/** What the person is told on coming back from Stripe. */
export type StripeAppNotice = { tone: "ok" | "problem" | "info"; text: string };

/** What the card is waiting for the control plane to do. */
export type StripeAppBusy = "connect" | "readNow" | "disconnect" | null;

export type StripeBalanceView = {
  /** When Stripe's balance was read; null when it never was. */
  readAt: string | null;
  currency: string;
  /** Stripe's balance, available plus pending. */
  stripeTotal: string | null;
  available: string | null;
  pending: string | null;
  /** What Rastrata knows is in Stripe and not yet paid out: the imported transactions no payout
   * has carried. */
  unpaid: string | null;
  unpaidCount: number;
  /** Stripe's balance minus `unpaid`: money Rastrata has not seen. */
  difference: string | null;
  /** The books' payouts in transit: payouts booked whose bank deposit is not matched yet. */
  inTransit: string | null;
  /** True when the two figures agree to the cent. */
  ties: boolean;
  /** True when the reading is old or the last sync did not finish. */
  stale: boolean;
  explanation: string;
};

export type StripePayoutBooking = "booked" | "waiting" | "mismatch" | "invalid" | "empty" | "held";

export type StripePayoutView = {
  id: string;
  arrivalOn: string;
  amount: string;
  currency: string;
  status: string;
  automatic: boolean;
  booking: StripePayoutBooking;
  /** How many transactions Stripe lists for it, and what they add up to. */
  memberCount: number;
  memberNet: string | null;
  /** The payout amount minus what its transactions add up to; zero when they agree. */
  difference: string | null;
  deposit: "matched" | "unmatched" | "reversed" | "unchecked";
  /** Why, in the service's own words; null when there is nothing to add. */
  reason: string | null;
};

export type StripePayoutFilter = "all" | "unmatched" | "waiting" | "mismatch" | "held";

export type StripeListState = "ready" | "loading" | "error";

export type StripeCardSummary = {
  /** `unconfigured`: the settings are not saved or an account is not settled; `no-key`: no usable
   * key; `ready`: syncing is possible. */
  stage: "unconfigured" | "no-key" | "ready";
  lastSync: { at: string; ok: boolean; payouts: number } | null;
  /** Payouts held for a person to categorise. */
  held: number;
  /** Payouts whose transactions do not add up to the payout. */
  mismatched: number;
  /** Payouts waiting for Stripe to finish itemising them. */
  waiting: number;
  /** Booked payouts with no bank deposit matched yet. */
  unmatched: number;
};

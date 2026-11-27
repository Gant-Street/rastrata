import type { StripeRoleKey, StripeRoleState } from "./types";

/** Every sentence the Stripe screen says, in one place. A sentence says the thing in plain words and never names a
 * screen or a control: the name of a place is its link or its button, and nowhere else (the founder, 2026-11-22, of
 * "each payout arrives in For review": "You can't just reference UI components in the middle of a sentence, it's
 * really hard to read."). The empty page is written as such pages are (Shopify's Polaris, QuickBooks's Stripe
 * connector): what the person gets, in a plain sentence, and a button that is a verb and a noun. */

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export const roleLabels: Readonly<Record<StripeRoleKey, string>> = {
  "payouts.in-transit": "Payouts in transit",
  "revenue.sales": "Sales",
  "tax.sales": "Sales tax payable",
  refunds: "Refunds",
  chargebacks: "Chargebacks and disputes",
  "stripe.fees": "Stripe fees",
  "stripe.adjustments": "Other Stripe adjustments",
  "stripe.balance": "Stripe balance",
};

export const words = {
  title: "Stripe",
  /** Once connected, where Rastrata reads Stripe itself. */
  lead: "New payouts are imported every day.",
  /** Before anything is connected: the one sentence, and the button. */
  empty: "Import your Stripe payouts automatically.",
  emptyMember: "An owner can connect Stripe.",
  appUnavailable: "Connecting Stripe is not available here yet.",
  appConnect: "Connect Stripe",
  appConnecting: "Taking you to Stripe…",
  checking: "Checking the connection…",
  connectionFailed: "Stripe could not be read. Your books have not been changed.",
  unavailableTitle: "Stripe is unavailable",

  // The key, where the service is given one (a service a person runs themselves)
  connectionTitle: "Stripe key",
  keyLabel: "Stripe key",
  keyFound: (source: string, mode: string, restricted: boolean | null) =>
    `Found in ${source === "file" ? "the key file" : "the service's settings"} (${restricted === false ? "unrestricted secret key" : "restricted key"}, ${mode} mode)`,
  keyMissing: "No key found",
  keyUnusable: "A key was found but cannot be used",
  keyReview: "Review this key",
  howTitle: "How to connect",
  howSteps: [
    "In the Stripe dashboard open Developers, API keys, and create a restricted key with Read access to Balance, Charges and refunds, Disputes, Payouts, Checkout Sessions, Invoices and Connected accounts.",
    "Set RASTRATA_STRIPE_KEY for the Rastrata service, or save the key in a file named stripe.key in the service's data folder, readable only by you.",
  ] as readonly string[],
  /** The page's button while there is no key that works: the service is asked again. */
  checkAgain: "Check again",

  // The account and its payouts
  payoutsTitle: "Payouts",
  payoutCaption: "Stripe payouts",
  actionsLabel: "Actions for Stripe",
  practice: "Practice data",
  disconnected: "Disconnected",
  updated: (when: string) => `Updated ${when}`,
  lastUpdated: (when: string) => `Last updated ${when}`,
  reading: "Reading now",
  readNow: "Read now",
  syncNow: "Sync now",
  syncing: "Syncing…",
  syncProgress: (payouts: number) => `${plural(payouts, "payout", "payouts")} booked so far…`,
  disconnect: "Disconnect",
  disconnectTitle: "Disconnect Stripe?",
  disconnectBody: "Rastrata stops reading Stripe. What is in your books stays.",
  keep: "Keep it",
  payoutColumns: {
    arrives: "Arrives",
    status: "Bank deposit",
    amount: (currency: string) => `Amount, ${currency}`,
  },
  depositMatched: "Matched",
  depositReversed: "Returned to Stripe",
  depositInbox: "Match",
  payoutWaiting: "Waiting for Stripe",
  payoutHeld: "Needs review",
  payoutOff: (difference: string) => `Off by ${difference}`,
  payoutNotBooked: "Not booked",
  payoutsEmpty: "No payouts yet.",
  payoutsLoading: "Loading payouts…",
  payoutsFailed: "Payouts could not be read.",
  tryAgain: "Try again",

  // What needs the person
  needAccounts: "Choose the accounts Stripe is booked to.",
  needAccountsNamed: (roles: string) => `Choose an account for ${roles}.`,
  offPayouts: (count: number) =>
    count === 1 ? "1 payout does not add up." : `${count} payouts do not add up.`,
  showThem: "Show",
  showAll: "Show all",
  moreInStripe: (difference: string) => `Stripe holds ${difference} more than Rastrata has read.`,
  moreInRastrata: (difference: string) => `Rastrata has read ${difference} more than Stripe holds.`,
  syncFailed: "The sync stopped. Nothing was posted.",
  syncUncertain: "The last sync did not answer, so its result is not known.",
  resume: "Resume",
  /** What Stripe sent the person back with, where there is something to say: a connection that worked says nothing (the page shows it), and neither does a person who changed their mind. */
  appBack: {
    failed: { tone: "problem", text: "Stripe could not be connected. Nothing was changed." },
    expired: { tone: "info", text: "The connection timed out. Try again." },
    signin: { tone: "info", text: "Sign in and try again." },
    other_account: {
      tone: "problem",
      text: "These books read a different Stripe account, and never switch to another.",
    },
    other_mode: {
      tone: "problem",
      text: "These books hold the other kind of Stripe data, real sales or practice data, and never mix the two.",
    },
    unavailable: { tone: "info", text: "Connecting Stripe is not available here yet." },
  } as Readonly<Record<string, { tone: "ok" | "problem" | "info"; text: string }>>,
  /** What the code of a reading that did not work means to a person; null when there is nothing for them to do or know. */
  appProblem: (code: string | null): string | null => {
    switch (code) {
      case null:
        return null;
      case "stripe_not_configured":
        return "Choose the accounts Stripe is booked to.";
      case "workspace_read_only":
        return "This workspace is read-only until it is subscribed, so Stripe is not being read.";
      case "app_removed":
        return "The Rastrata app was removed in Stripe. Reconnect to continue.";
      case "stripe_mode_changed":
      case "mode_changed":
      case "stripe_mode_mismatch":
        return "These books hold the other kind of Stripe data, real sales or practice data, and never mix the two.";
      case "stripe_account_changed":
      case "account_changed":
        return "These books read a different Stripe account, and never switch to another.";
      case "stripe_permission_denied":
      case "stripe_key_rejected":
        return "Stripe refused access to this account. Reconnect to continue.";
      case "no_sandbox_key":
        return "A practice account cannot be read here yet.";
      default:
        return "Stripe could not be read. Rastrata is trying again.";
    }
  },

  // Options
  settingsTitle: "Options",
  /** Under Advanced: the account each of Stripe's eight roles is booked to. */
  rolesTitle: "Accounts",
  /** The first choice of a role's field: the account the chart names for it, or that there is none. */
  fromChart: (account: string) => `${account} (from your chart)`,
  noAccount: "No account",
  optional: "Optional",
  roleState: (_state: StripeRoleState, _account: string): string => "No account yet.",
  syncFrom: "First day to import",
  syncFromHint: "It cannot change once transactions are imported.",
  timeZone: "Time zone",
  timeZoneShow: "List of zones",
  timeZoneHint: "Decides the day a payout falls on.",
  salesTax: "Sales tax",
  salesTaxStripe: "Take it from Stripe",
  salesTaxStripeHint: "Only where Stripe reported it on Checkout or an invoice.",
  salesTaxNone: "Do not split sales tax",
  salesTaxNoneHint: "Every sale is booked whole to Sales.",
  advanced: "Advanced",
  overlapDays: "Days to read again",
  overlapDaysHint: "Each reading re-reads this many days, so a late movement is not missed.",
  matchWindowDays: "Days a deposit may differ from the payout date",
  matchWindowDaysHint: "A bank deposit matches a payout of the same amount this close to its date.",
  save: "Save",
  saving: "Saving…",
  saved: "Saved.",
  errorsTitle: "Fix these before saving",
  saveFailed: "The options could not be saved",
  saveUncertain: "The result is uncertain. Save again to resume the original request.",
  saveNothing: "The options could not be saved. Nothing was changed.",
  needDate: "Enter the first day as a date.",
  needZone: "Enter a time zone such as America/Denver or UTC.",
  needWhole: (low: number, high: number) => `Enter a whole number from ${low} to ${high}.`,
  optionsLoading: "Loading your accounts…",
} as const;

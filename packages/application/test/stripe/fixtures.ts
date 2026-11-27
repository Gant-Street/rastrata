/** Fixtures for the Stripe lane: a small fictional business ("Example Co") whose Stripe account
 * settles in USD, and the objects Stripe's API returns for it, in the documented shapes
 * (spec3.json 2026-09-30.endive; test/stripe/conformance.test.ts checks every one against it).
 *
 * Nothing here is real: identifiers, names and amounts are invented, and the only key-shaped string
 * is assembled at run time so no key-like literal exists in the repository.
 *
 * The story (all instants UTC, March 2026):
 *   P1  five charges (one with sales tax, one international), a partial refund, a Stripe fee.
 *   P2  four charges, a subscription invoice, a lost dispute, a dispute opened (later won), and a
 *       Stripe adjustment (an "other adjustment" a person must categorise).
 *   P3  the won dispute is returned, three charges, a charge with network (interchange) costs, and a
 *       tax-on-fees line.
 *   P4, P5  two equal payouts on neighbouring days (a single $20 charge each): the case that must
 *       stay ambiguous when one deposit of that amount arrives.
 *   P6  a payout that fails and returns to the balance.
 * plus a EUR charge on a EUR balance, which a USD book must hold for review, never convert. */

export type Json = Record<string, unknown>;

export const ACCOUNT_ID = "acct_1FixtureAccount0001";
/** The fictional "now" of the scenario. */
export const NOW = Date.parse("2026-03-20T12:00:00Z") / 1000;

/** A key-shaped string that is not a key. Built at run time on purpose. */
export const fakeKey = (tag = "FIXTURE"): string =>
  ["rk", "live", `${tag}ThisIsNotARealKey000000`].join("_");

export const ts = (iso: string): number => Date.parse(iso) / 1000;
const sid = (prefix: string, n: number): string =>
  `${prefix}_1Fixture${String(n).padStart(14, "0")}`;

/** Stripe's standard US card pricing: 2.9% + 30 cents, rounded to the cent. */
export const cardFee = (amount: number): number => Math.round((amount * 29) / 1000) + 30;

/** Funds become available two days after the charge, at the start of that UTC day. */
const availableAfter = (created: number): number =>
  Math.floor((created + 2 * 86_400) / 86_400) * 86_400;

export interface Entry {
  /** The balance transaction as the list returns it, with `source` as an identifier. */
  readonly bt: Json;
  /** The object `source` expands to, when there is one. */
  readonly source: Json | null;
  /** The payout this transaction was paid out in, when it was. */
  readonly payout: string | null;
}

export interface Scenario {
  readonly account: Json;
  readonly entries: readonly Entry[];
  readonly payouts: readonly Json[];
  readonly sessions: readonly Json[];
  readonly invoicePayments: readonly Json[];
  /** P1 to P6 and so on: the story's names for its payouts, mapped to Stripe identifiers. */
  readonly labels: Readonly<Record<string, string>>;
  readonly now: number;
}

// ----- builders for the objects the lane reads --------------------------------------------------

export function balanceTransaction(
  n: number,
  o: {
    readonly category: string;
    readonly type: string;
    readonly amount: number;
    readonly fee?: number;
    readonly created: number;
    readonly source: string | null;
    readonly currency?: string;
    readonly description?: string | null;
    readonly feeDetails?: readonly Json[];
    readonly balanceType?: string;
    readonly exchangeRate?: number | null;
    readonly now?: number;
  },
): Json {
  const fee = o.fee ?? 0;
  const availableOn = availableAfter(o.created);
  const feeDetails =
    o.feeDetails ??
    (fee === 0
      ? []
      : [
          {
            amount: fee,
            application: null,
            currency: o.currency ?? "usd",
            description: "Stripe processing fees",
            type: "stripe_fee",
          },
        ]);
  return {
    id: sid("txn", n),
    object: "balance_transaction",
    amount: o.amount,
    available_on: availableOn,
    balance_type: o.balanceType ?? "payments",
    created: o.created,
    currency: o.currency ?? "usd",
    description: o.description ?? null,
    exchange_rate: o.exchangeRate ?? null,
    fee,
    fee_details: feeDetails,
    net: o.amount - fee,
    reporting_category: o.category,
    source: o.source,
    status: availableOn <= (o.now ?? NOW) ? "available" : "pending",
    type: o.type,
  };
}

const billing = (): Json => ({
  address: {
    city: null,
    country: "US",
    line1: null,
    line2: null,
    postal_code: "80202",
    state: null,
  },
  email: null,
  name: null,
  phone: null,
});

export function chargeObject(
  n: number,
  o: {
    readonly amount: number;
    readonly created: number;
    readonly paymentIntent: string | null;
    readonly btId?: string;
    readonly currency?: string;
    readonly description?: string | null;
    readonly metadata?: Json;
    readonly refunded?: number;
    readonly disputed?: boolean;
  },
): Json {
  return {
    id: sid("ch", n),
    object: "charge",
    amount: o.amount,
    amount_captured: o.amount,
    amount_refunded: o.refunded ?? 0,
    balance_transaction: o.btId ?? null,
    billing_details: billing(),
    captured: true,
    created: o.created,
    currency: o.currency ?? "usd",
    description: o.description ?? null,
    disputed: o.disputed ?? false,
    livemode: true,
    metadata: o.metadata ?? {},
    paid: true,
    payment_intent: o.paymentIntent,
    refunded: (o.refunded ?? 0) >= o.amount,
    status: "succeeded",
  };
}

export function refundObject(
  n: number,
  o: {
    readonly amount: number;
    readonly created: number;
    readonly charge: string;
    readonly paymentIntent: string | null;
    readonly btId: string;
    readonly metadata?: Json;
  },
): Json {
  return {
    id: sid("re", n),
    object: "refund",
    amount: o.amount,
    balance_transaction: o.btId,
    charge: o.charge,
    created: o.created,
    currency: "usd",
    metadata: o.metadata ?? {},
    payment_intent: o.paymentIntent,
    reason: "requested_by_customer",
    status: "succeeded",
  };
}

export function disputeObject(
  n: number,
  o: {
    readonly amount: number;
    readonly created: number;
    readonly charge: string;
    readonly paymentIntent: string | null;
    readonly status: string;
    readonly balanceTransactions: readonly Json[];
    readonly reason?: string;
  },
): Json {
  return {
    id: sid("du", n),
    object: "dispute",
    amount: o.amount,
    balance_transactions: o.balanceTransactions,
    charge: o.charge,
    created: o.created,
    currency: "usd",
    enhanced_eligibility_types: [],
    evidence: {
      access_activity_log: null,
      customer_name: null,
      product_description: null,
      uncategorized_text: null,
    },
    evidence_details: {
      due_by: o.created + 14 * 86_400,
      has_evidence: false,
      past_due: false,
      submission_count: 0,
    },
    is_charge_refundable: false,
    livemode: true,
    metadata: {},
    payment_intent: o.paymentIntent,
    reason: o.reason ?? "general",
    status: o.status,
  };
}

export function payoutObject(
  n: number,
  o: {
    readonly amount: number;
    readonly created: number;
    readonly arrival: string;
    readonly btId: string | null;
    readonly status?: string;
    readonly automatic?: boolean;
    readonly reconciliation?: string;
    readonly failureBtId?: string;
    readonly currency?: string;
  },
): Json {
  return {
    id: sid("po", n),
    object: "payout",
    amount: o.amount,
    arrival_date: ts(`${o.arrival}T00:00:00Z`),
    automatic: o.automatic ?? true,
    balance_transaction: o.btId,
    created: o.created,
    currency: o.currency ?? "usd",
    description: "STRIPE PAYOUT",
    destination: "ba_1FixtureBank0000000001",
    ...(o.failureBtId
      ? {
          failure_balance_transaction: o.failureBtId,
          failure_code: "account_closed",
          failure_message: "The bank account has been closed.",
        }
      : {}),
    livemode: true,
    metadata: {},
    method: "standard",
    reconciliation_status: o.reconciliation ?? "completed",
    source_type: "card",
    statement_descriptor: null,
    status: o.status ?? "paid",
    type: "bank_account",
  };
}

export function sessionObject(
  n: number,
  o: {
    readonly paymentIntent: string;
    readonly total: number;
    readonly tax: number;
    readonly created: number;
  },
): Json {
  return {
    id: sid("cs_live", n),
    object: "checkout.session",
    amount_subtotal: o.total - o.tax,
    amount_total: o.total,
    automatic_tax: { enabled: true, liability: null, provider: "stripe", status: "complete" },
    created: o.created,
    currency: "usd",
    custom_fields: [],
    custom_text: {
      after_submit: null,
      shipping_address: null,
      submit: null,
      terms_of_service_acceptance: null,
    },
    expires_at: o.created + 86_400,
    livemode: true,
    mode: "payment",
    payment_intent: o.paymentIntent,
    payment_method_types: ["card"],
    payment_status: "paid",
    shipping_options: [],
    status: "complete",
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: o.tax },
  };
}

export function invoiceObject(
  n: number,
  o: { readonly total: number; readonly tax: number; readonly created: number },
): Json {
  return {
    id: sid("in", n),
    object: "invoice",
    amount_due: 0,
    amount_overpaid: 0,
    amount_paid: o.total,
    amount_paid_off_stripe: o.total,
    amount_remaining: 0,
    amount_shipping: 0,
    attempt_count: 1,
    attempted: true,
    auto_advance: false,
    automatic_tax: { enabled: true, liability: null, provider: "stripe", status: "complete" },
    collection_method: "charge_automatically",
    created: o.created,
    currency: "usd",
    customer: sid("cus", n),
    default_tax_rates: [],
    discounts: [],
    issuer: { type: "self" },
    lines: { object: "list", data: [], has_more: false, url: `/v1/invoices/${sid("in", n)}/lines` },
    livemode: true,
    payment_settings: { default_mandate: null, payment_method_options: null },
    period_end: o.created,
    period_start: o.created,
    post_payment_credit_notes_amount: 0,
    pre_payment_credit_notes_amount: 0,
    starting_balance: 0,
    status: "paid",
    status_transitions: { finalized_at: o.created, paid_at: o.created },
    subtotal: o.total - o.tax,
    total: o.total,
    total_taxes: [
      {
        amount: o.tax,
        tax_behavior: "exclusive",
        tax_rate_details: { tax_rate: sid("txr", n) },
        taxability_reason: o.tax === 0 ? "not_collecting" : "standard_rated",
        taxable_amount: o.total - o.tax,
        type: "tax_rate_details",
      },
    ],
  };
}

export function invoicePaymentObject(
  n: number,
  o: { readonly paymentIntent: string; readonly invoice: Json; readonly paid?: number },
): Json {
  const total = Number(o.invoice.total);
  return {
    id: sid("inpay", n),
    object: "invoice_payment",
    amount_paid: o.paid ?? total,
    amount_requested: total,
    created: Number(o.invoice.created),
    currency: "usd",
    invoice: o.invoice,
    is_default: true,
    livemode: true,
    payment: { type: "payment_intent", payment_intent: o.paymentIntent },
    status: "paid",
    status_transitions: { canceled_at: null, paid_at: Number(o.invoice.created) },
  };
}

export function accountObject(timeZone = "America/Denver"): Json {
  return {
    id: ACCOUNT_ID,
    object: "account",
    country: "US",
    default_currency: "usd",
    settings: {
      branding: { icon: null, logo: null, primary_color: null, secondary_color: null },
      card_payments: { decline_on: { avs_failure: false, cvc_failure: false } },
      dashboard: { display_name: "Example Co", timezone: timeZone },
      payments: { statement_descriptor: "EXAMPLE CO" },
    },
  };
}

export function listOf(path: string, data: readonly unknown[], hasMore: boolean): Json {
  return { object: "list", data, has_more: hasMore, url: path };
}

// ----- the scenario -----------------------------------------------------------------------------

interface Spec {
  readonly key: string;
  readonly n: number;
  readonly category: string;
  readonly type: string;
  readonly amount: number;
  readonly fee?: number;
  readonly created: string;
  readonly payout: string | null;
  readonly currency?: string;
  readonly description?: string | null;
  readonly feeDetails?: readonly Json[];
}

export function buildScenario(): Scenario {
  const entries: Entry[] = [];
  const sessions: Json[] = [];
  const invoicePayments: Json[] = [];
  const payouts: Json[] = [];
  const btIdOf = new Map<string, string>();
  const labels = new Map<string, string>();

  const add = (spec: Spec, source: Json | null): Entry => {
    const bt = balanceTransaction(spec.n, {
      category: spec.category,
      type: spec.type,
      amount: spec.amount,
      ...(spec.fee !== undefined ? { fee: spec.fee } : {}),
      created: ts(spec.created),
      source: source ? String(source.id) : null,
      ...(spec.currency ? { currency: spec.currency } : {}),
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      ...(spec.feeDetails ? { feeDetails: spec.feeDetails } : {}),
    });
    btIdOf.set(spec.key, String(bt.id));
    const entry = { bt, source, payout: spec.payout };
    entries.push(entry);
    return entry;
  };

  let seq = 100;
  const next = (): number => ++seq;

  /** A card charge settled to the USD balance, optionally through Checkout or an invoice. */
  const charge = (
    key: string,
    created: string,
    amount: number,
    payout: string,
    via: { readonly session?: number; readonly invoice?: boolean } = {},
    fee = cardFee(amount),
    feeDetails?: readonly Json[],
  ): { chargeId: string; paymentIntent: string } => {
    const n = next();
    const paymentIntent = sid("pi", n);
    const c = chargeObject(n, {
      amount,
      created: ts(created),
      paymentIntent,
      btId: sid("txn", n),
    });
    add(
      {
        key,
        n,
        category: "charge",
        type: "charge",
        amount,
        fee,
        created,
        payout,
        description: "Payment for Invoice",
        ...(feeDetails ? { feeDetails } : {}),
      },
      c,
    );
    if (via.session !== undefined)
      sessions.push(
        sessionObject(n, { paymentIntent, total: amount, tax: via.session, created: ts(created) }),
      );
    if (via.invoice)
      invoicePayments.push(
        invoicePaymentObject(n, {
          paymentIntent,
          invoice: invoiceObject(n, { total: amount, tax: 0, created: ts(created) }),
        }),
      );
    return { chargeId: String(c.id), paymentIntent };
  };

  const dispute = (
    key: string,
    created: string,
    amount: number,
    payout: string,
    status: string,
    against: { chargeId: string; paymentIntent: string },
  ): Json => {
    const n = next();
    const bt = balanceTransaction(n, {
      category: "dispute",
      type: "adjustment",
      amount: -amount,
      fee: 1500,
      created: ts(created),
      source: sid("du", n),
      description: "Chargeback withdrawal",
      feeDetails: [
        {
          amount: 1500,
          application: null,
          currency: "usd",
          description: "Dispute fee",
          type: "stripe_fee",
        },
      ],
    });
    const d = disputeObject(n, {
      amount,
      created: ts(created),
      charge: against.chargeId,
      paymentIntent: against.paymentIntent,
      status,
      balanceTransactions: [bt],
    });
    entries.push({ bt, source: d, payout });
    btIdOf.set(key, String(bt.id));
    return d;
  };

  /** A payout of everything paid out under `key` so far: its amount is the sum of the members' net,
   * to the cent, by construction. */
  const payoutFor = (
    key: string,
    created: string,
    arrival: string,
    o: { status?: string; failureKey?: string; reconciliation?: string } = {},
  ): void => {
    const amount = entries
      .filter((e) => e.payout === key)
      .reduce((sum, e) => sum + Number(e.bt.net), 0);
    const n = next();
    const btId = sid("txn", n);
    const failureBtId = o.failureKey ? sid("txn", n + 1) : undefined;
    labels.set(key, sid("po", n));
    const po = payoutObject(n, {
      amount,
      created: ts(created),
      arrival,
      btId,
      ...(o.status ? { status: o.status } : {}),
      ...(failureBtId ? { failureBtId } : {}),
      ...(o.reconciliation ? { reconciliation: o.reconciliation } : {}),
    });
    payouts.push(po);
    const bt = balanceTransaction(n, {
      category: "payout",
      type: "payout",
      amount: -amount,
      created: ts(created),
      source: String(po.id),
      description: "STRIPE PAYOUT",
    });
    entries.push({ bt, source: po, payout: null });
    btIdOf.set(key, btId);
    if (failureBtId) {
      next(); // keep the sequence aligned with n + 1
      const failure = balanceTransaction(n + 1, {
        category: "payout_reversal",
        type: "payout_failure",
        amount,
        created: ts(created) + 86_400 * 2,
        source: String(po.id),
        description: "Payout failure",
      });
      entries.push({ bt: failure, source: po, payout: null });
    }
  };

  // P1: five charges, a partial refund, a Stripe fee.
  const a = charge("A", "2026-03-02T14:05:00Z", 2000, "P1", { session: 0 });
  charge("C", "2026-03-02T18:30:00Z", 2165, "P1", { session: 165 });
  charge("D", "2026-03-03T09:12:00Z", 4200, "P1", {}, 215, [
    {
      amount: 152,
      application: null,
      currency: "usd",
      description: "Stripe processing fees",
      type: "stripe_fee",
    },
    {
      amount: 63,
      application: null,
      currency: "usd",
      description: "International card fee",
      type: "stripe_fee",
    },
  ]);
  const rn = next();
  add(
    {
      key: "R1",
      n: rn,
      category: "refund",
      type: "refund",
      amount: -500,
      created: "2026-03-03T11:47:00Z",
      payout: "P1",
      description: "REFUND FOR CHARGE",
    },
    refundObject(rn, {
      amount: 500,
      created: ts("2026-03-03T11:47:00Z"),
      charge: a.chargeId,
      paymentIntent: a.paymentIntent,
      btId: sid("txn", rn),
    }),
  );
  charge("E", "2026-03-04T02:30:00Z", 2000, "P1", { session: 0 });
  add(
    {
      key: "FEE1",
      n: next(),
      category: "fee",
      type: "stripe_fee",
      amount: -50,
      created: "2026-03-04T06:00:00Z",
      payout: "P1",
      description: "Stripe Tax - transaction fee",
      feeDetails: [],
    },
    null,
  );
  payoutFor("P1", "2026-03-06T06:00:00Z", "2026-03-09");

  // P2: four charges, a subscription invoice, a lost dispute, an open dispute, an adjustment.
  const g1 = charge("G1", "2026-03-05T10:00:00Z", 2000, "P2", { session: 0 });
  charge("G2", "2026-03-05T15:00:00Z", 2000, "P2", { session: 0 });
  charge("G3", "2026-03-06T09:30:00Z", 2000, "P2", { session: 0 });
  charge("G4", "2026-03-06T16:45:00Z", 2000, "P2", { session: 0 });
  charge("F", "2026-03-06T08:00:00Z", 2900, "P2", { invoice: true });
  dispute("DISP1", "2026-03-06T20:00:00Z", 2000, "P2", "lost", g1);
  const g5 = charge("G5", "2026-03-04T12:00:00Z", 2500, "P2", { session: 0 });
  const disp2 = dispute("DISP2", "2026-03-07T05:00:00Z", 2500, "P2", "won", g5);
  add(
    {
      key: "ADJ",
      n: next(),
      category: "other_adjustment",
      type: "adjustment",
      amount: 300,
      created: "2026-03-07T07:00:00Z",
      payout: "P2",
      description: "Adjustment for incorrect fee",
    },
    null,
  );
  payoutFor("P2", "2026-03-10T06:00:00Z", "2026-03-11");

  // P3: the won dispute comes back, three charges, interchange costs, a tax-on-fees line.
  const rv = next();
  add(
    {
      key: "DISP2R",
      n: rv,
      category: "dispute_reversal",
      type: "adjustment",
      amount: 2500,
      fee: -1500,
      created: "2026-03-10T05:00:00Z",
      payout: "P3",
      description: "Chargeback reversal",
      feeDetails: [
        {
          amount: -1500,
          application: null,
          currency: "usd",
          description: "Dispute fee refund",
          type: "stripe_fee",
        },
      ],
    },
    disp2,
  );
  charge("H1", "2026-03-09T10:00:00Z", 2000, "P3", { session: 0 });
  charge("H2", "2026-03-09T11:00:00Z", 2000, "P3", { session: 0 });
  charge("H3", "2026-03-10T10:00:00Z", 2000, "P3", { session: 0 });
  charge("IC", "2026-03-10T13:20:00Z", 3000, "P3", {}, 130, [
    {
      amount: 90,
      application: null,
      currency: "usd",
      description: "Stripe processing fees",
      type: "stripe_fee",
    },
    {
      amount: 40,
      application: null,
      currency: "usd",
      description: "Network cost",
      type: "payment_method_passthrough_fee",
    },
  ]);
  add(
    {
      key: "TAXFEE",
      n: next(),
      category: "tax",
      type: "tax_fee",
      amount: -12,
      created: "2026-03-10T21:00:00Z",
      payout: "P3",
      description: "Tax on Stripe fees",
      feeDetails: [],
    },
    null,
  );
  payoutFor("P3", "2026-03-13T06:00:00Z", "2026-03-16");

  // P4 and P5: equal payouts on neighbouring days. P6: a payout that fails.
  charge("Q1", "2026-03-13T10:00:00Z", 2000, "P4", { session: 0 });
  payoutFor("P4", "2026-03-15T06:00:00Z", "2026-03-16");
  charge("Q2", "2026-03-14T10:00:00Z", 2000, "P5", { session: 0 });
  payoutFor("P5", "2026-03-16T06:00:00Z", "2026-03-17");
  charge("Q3", "2026-03-15T10:00:00Z", 2000, "P6", { session: 0 });
  payoutFor("P6", "2026-03-17T06:00:00Z", "2026-03-18", {
    status: "failed",
    failureKey: "P6F",
  });

  // A EUR charge on a EUR balance.
  const en = next();
  const ec = chargeObject(en, {
    amount: 2000,
    created: ts("2026-03-12T09:00:00Z"),
    paymentIntent: sid("pi", en),
    currency: "eur",
  });
  add(
    {
      key: "EUR1",
      n: en,
      category: "charge",
      type: "charge",
      amount: 2000,
      fee: 90,
      created: "2026-03-12T09:00:00Z",
      payout: null,
      currency: "eur",
      description: "Payment from a customer in Berlin",
    },
    ec,
  );

  return {
    account: accountObject(),
    entries,
    payouts,
    sessions,
    invoicePayments,
    labels: Object.fromEntries(labels),
    now: NOW,
  };
}

/** The transactions Stripe says were paid out in `payoutId`, newest first like the list endpoint. */
export function membersOf(scenario: Scenario, payoutId: string): Json[] {
  const label = Object.entries(scenario.labels).find(([, id]) => id === payoutId)?.[0];
  return scenario.entries.filter((e) => label !== undefined && e.payout === label).map((e) => e.bt);
}

/** Stripe's reporting categories with a balance transaction type that produces each (Stripe's
 * reporting-category reference, checked 2026-10-03). Used to prove every category is handled. */
export const CATEGORY_TYPES: Readonly<Record<string, string>> = {
  charge: "charge",
  charge_failure: "payment_failure_refund",
  dispute: "adjustment",
  dispute_reversal: "adjustment",
  partial_capture_reversal: "refund",
  refund: "refund",
  refund_failure: "refund_failure",
  anticipation_repayment: "anticipation_repayment",
  climate_order_purchase: "climate_order_purchase",
  climate_order_refund: "climate_order_refund",
  contribution: "contribution",
  currency_conversion: "adjustment",
  fee: "stripe_fee",
  other_adjustment: "adjustment",
  payment_network_reserve_hold: "payment_network_reserve_hold",
  payment_network_reserve_release: "payment_network_reserve_release",
  payout: "payout",
  payout_minimum_balance_hold: "payout_minimum_balance_hold",
  payout_minimum_balance_release: "payout_minimum_balance_release",
  payout_reversal: "payout_failure",
  revenue_share: "adjustment",
  reward: "adjustment",
  risk_reserved_funds: "reserved_funds",
  stripe_balance_payment_debit: "stripe_balance_payment_debit",
  stripe_balance_payment_debit_reversal: "stripe_balance_payment_debit_reversal",
  tax: "tax_fee",
  tax_fund: "tax_fund",
  tax_withholding: "adjustment",
  topup: "topup",
  topup_reversal: "topup_reversal",
  unreconciled_customer_funds: "payment_unreconciled",
  issuing_authorization_hold: "issuing_authorization_hold",
  issuing_authorization_release: "issuing_authorization_release",
  issuing_disbursement: "adjustment",
  issuing_dispute: "issuing_dispute",
  issuing_dispute_fraud_liability_debit: "adjustment",
  issuing_dispute_provisional_credit: "issuing_dispute_provisional_credit",
  issuing_dispute_provisional_credit_reversal: "issuing_dispute_provisional_credit_reversal",
  issuing_transaction: "issuing_transaction",
  advance: "advance",
  advance_funding: "advance_funding",
  connect_collection_transfer: "connect_collection_transfer",
  connect_reserved_funds: "reserve_transaction",
  platform_earning: "application_fee",
  platform_earning_refund: "application_fee_refund",
  transfer: "transfer",
  transfer_reversal: "transfer_cancel",
  fee_credit_funding: "fee_credit_funding",
};

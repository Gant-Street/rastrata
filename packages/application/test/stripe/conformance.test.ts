import { expect, test } from "bun:test";
import { fakeStripe } from "./fake-stripe.ts";
import {
  CATEGORY_TYPES,
  type Json,
  NOW,
  accountObject,
  buildScenario,
  fakeKey,
  listOf,
  membersOf,
} from "./fixtures.ts";
import { SPEC_VERSION, conformance, listConformance } from "./openapi.ts";

/** Every reporting category Stripe documents (reporting-categories reference, 2026-10-03). */
const DOCUMENTED_CATEGORIES = [
  "charge",
  "charge_failure",
  "dispute",
  "dispute_reversal",
  "partial_capture_reversal",
  "refund",
  "refund_failure",
  "anticipation_repayment",
  "climate_order_purchase",
  "climate_order_refund",
  "contribution",
  "currency_conversion",
  "fee",
  "other_adjustment",
  "payment_network_reserve_hold",
  "payment_network_reserve_release",
  "payout",
  "payout_minimum_balance_hold",
  "payout_minimum_balance_release",
  "payout_reversal",
  "revenue_share",
  "reward",
  "risk_reserved_funds",
  "stripe_balance_payment_debit",
  "stripe_balance_payment_debit_reversal",
  "tax",
  "tax_fund",
  "tax_withholding",
  "topup",
  "topup_reversal",
  "unreconciled_customer_funds",
  "issuing_authorization_hold",
  "issuing_authorization_release",
  "issuing_disbursement",
  "issuing_dispute",
  "issuing_dispute_fraud_liability_debit",
  "issuing_dispute_provisional_credit",
  "issuing_dispute_provisional_credit_reversal",
  "issuing_transaction",
  "advance",
  "advance_funding",
  "connect_collection_transfer",
  "connect_reserved_funds",
  "platform_earning",
  "platform_earning_refund",
  "transfer",
  "transfer_reversal",
  "fee_credit_funding",
];

const scenario = buildScenario();

test("the fixtures are checked against Stripe's own published schema", () => {
  expect(SPEC_VERSION).toBe("2026-09-30.endive");
});

test("every balance transaction in the story is a valid Stripe balance_transaction", () => {
  const problems = scenario.entries.flatMap((e) =>
    conformance("balance_transaction", e.bt).map((p) => `${e.bt.id} ${p}`),
  );
  expect(problems).toEqual([]);
  expect(scenario.entries.length).toBeGreaterThan(30);
});

test("every expanded source is a valid Stripe object of its own kind", () => {
  const problems: string[] = [];
  for (const e of scenario.entries) {
    if (!e.source) continue;
    const kind = String(e.source.object);
    for (const p of conformance(kind, e.source)) problems.push(`${e.bt.id} ${p}`);
  }
  expect(problems).toEqual([]);
  const kinds = new Set(scenario.entries.map((e) => e.source?.object).filter(Boolean));
  expect([...kinds].sort()).toEqual(["charge", "dispute", "payout", "refund"]);
});

test("payouts, Checkout Sessions, invoice payments, the account and the balance conform", () => {
  const problems = [
    ...scenario.payouts.flatMap((po) => conformance("payout", po)),
    ...scenario.sessions.flatMap((s) => conformance("checkout.session", s)),
    ...scenario.invoicePayments.flatMap((p) => conformance("invoice_payment", p)),
    ...conformance("account", scenario.account),
    ...conformance("account", accountObject("UTC")),
  ];
  expect(problems).toEqual([]);
});

test("the fake server answers in Stripe's list and balance shapes, newest first", async () => {
  const key = fakeKey();
  const stripe = fakeStripe(scenario, { key });
  const get = async (path: string): Promise<unknown> =>
    (
      await stripe.fetch(`https://api.stripe.com${path}`, {
        headers: { authorization: `Bearer ${key}` },
      })
    ).json();
  const list = (await get("/v1/balance_transactions?limit=100")) as Json;
  expect(listConformance("balance_transaction", list)).toEqual([]);
  const created = (list.data as Json[]).map((bt) => Number(bt.created));
  expect(created).toEqual([...created].sort((a, b) => b - a));
  expect(listConformance("payout", await get("/v1/payouts?limit=100"))).toEqual([]);
  const balance = (await get("/v1/balance")) as Json;
  expect(conformance("balance", balance)).toEqual([]);
  const usd = scenario.entries
    .filter((e) => e.bt.currency === "usd")
    .reduce((sum, e) => sum + Number(e.bt.net), 0);
  const amounts = [...(balance.available as Json[]), ...(balance.pending as Json[])];
  expect(amounts.reduce((sum, a) => sum + Number(a.amount), 0)).toBe(usd);
  // A list that paged, and the envelope around other objects, stay valid.
  expect(
    listConformance("checkout.session", listOf("/v1/checkout/sessions", scenario.sessions, false)),
  ).toEqual([]);
});

test("the documented reporting categories are exactly the ones the fixtures cover", () => {
  expect(Object.keys(CATEGORY_TYPES).sort()).toEqual([...DOCUMENTED_CATEGORIES].sort());
});

test("a payout's members add up, to the cent, to the payout amount", () => {
  for (const po of scenario.payouts) {
    const net = membersOf(scenario, String(po.id)).reduce((sum, bt) => sum + Number(bt.net), 0);
    expect(net).toBe(Number(po.amount));
  }
  expect(scenario.payouts.map((po) => Number(po.amount))).toEqual([
    9331, 5631, 12594, 1912, 1912, 1912,
  ]);
  expect(NOW).toBe(scenario.now);
});

test("no key-shaped literal is stored in the fixtures", () => {
  const text = JSON.stringify(scenario);
  expect(/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/.test(text)).toBe(false);
});

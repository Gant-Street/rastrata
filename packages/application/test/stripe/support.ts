import type { EventLeg, LedgerEvent } from "../../src/ingest-types.ts";
import { addMoney, parseMoney } from "../../src/money.ts";
import {
  decodeBalanceTransaction,
  decodeCheckoutSessionPage,
  decodeInvoicePaymentPage,
  decodePayout,
} from "../../src/stripe/decode.ts";
import { needsTaxFigure, paymentIntentOf } from "../../src/stripe/normalise.ts";
import {
  type PayoutMember,
  type PayoutOutcome,
  type SummaryContext,
  summarisePayout,
} from "../../src/stripe/payout-summary.ts";
import {
  type TaxResolution,
  notReported,
  taxFromCheckoutSessions,
  taxFromInvoicePayments,
} from "../../src/stripe/tax.ts";
import type { BalanceTransaction, Payout } from "../../src/stripe/types.ts";
import { type Json, type Scenario, listOf } from "./fixtures.ts";

/** The balance transaction a scenario entry decodes to, with its source expanded as the connector
 * asks Stripe for it. Throws when the fixture does not decode, which would be a bug in the fixture
 * or the decoder. */
export function decoded(bt: Json, source: Json | null): BalanceTransaction {
  const result = decodeBalanceTransaction(source ? { ...bt, source } : bt);
  if (!result.ok) throw new Error(`fixture did not decode: ${result.problems.join("; ")}`);
  return result.value;
}

export function allDecoded(scenario: Scenario): BalanceTransaction[] {
  return scenario.entries.map((e) => decoded(e.bt, e.source));
}

/** The tax figure the way the connector resolves it: from the Checkout Session, else the invoice
 * payment, for the payment intent a charge or refund belongs to. */
export function taxResolver(scenario: Scenario): (t: BalanceTransaction) => TaxResolution {
  const sessions = decodeCheckoutSessionPage(
    listOf("/v1/checkout/sessions", scenario.sessions, false),
  );
  const invoices = decodeInvoicePaymentPage(
    listOf("/v1/invoice_payments", scenario.invoicePayments, false),
  );
  if (!sessions.ok || !invoices.ok) throw new Error("tax fixtures did not decode");
  return (t) => {
    if (!needsTaxFigure(t)) return { state: "none" };
    const pi = paymentIntentOf(t);
    if (!pi) return notReported("no_payment_intent");
    return (
      taxFromCheckoutSessions(sessions.value.items, pi) ??
      taxFromInvoicePayments(invoices.value.items, pi) ??
      notReported("no_checkout_session_or_invoice")
    );
  };
}

export const context = (
  scenario: Scenario,
  overrides: Partial<SummaryContext> = {},
): SummaryContext => ({
  accountKeyBase: "stripe:acct_1FixtureAccount0001",
  bookCurrency: "USD",
  taxFor: taxResolver(scenario),
  ...overrides,
});

export function payoutObjectOf(scenario: Scenario, label: string): Payout {
  const id = scenario.labels[label];
  const json = scenario.payouts.find((po) => po.id === id);
  if (!json) throw new Error(`no payout ${label}`);
  const result = decodePayout(json);
  if (!result.ok) throw new Error(`payout did not decode: ${result.problems.join("; ")}`);
  return result.value;
}

/** The transactions Stripe lists for a payout, with their sources expanded, in one page. */
export function payoutMembers(scenario: Scenario, label: string): PayoutMember[] {
  return scenario.entries
    .filter((e) => e.payout === label)
    .map((e, rawIndex) => ({ transaction: decoded(e.bt, e.source), page: 0, rawIndex }));
}

export function summarise(
  scenario: Scenario,
  label: string,
  overrides: Partial<SummaryContext> = {},
): PayoutOutcome {
  return summarisePayout(
    payoutObjectOf(scenario, label),
    payoutMembers(scenario, label),
    context(scenario, overrides),
  );
}

export const LABELS = ["P1", "P2", "P3", "P4", "P5", "P6"] as const;

export function summary(outcome: PayoutOutcome) {
  if (outcome.kind !== "summary") throw new Error(`expected a summary, got ${outcome.kind}`);
  return outcome;
}

/** The legs of an event as role to amount, adding legs that share a role. */
export function legsByRole(event: LedgerEvent): Record<string, string> {
  const out: Record<string, string> = {};
  for (const leg of event.legs as readonly EventLeg[])
    out[leg.role] = addMoney(out[leg.role] ?? "0.00", leg.amount);
  return out;
}

export const sumLegs = (event: LedgerEvent): bigint =>
  event.legs.reduce((sum, leg) => sum + parseMoney(leg.amount), 0n);

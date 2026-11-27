import type { EventLeg, ParseDiagnostic } from "../ingest-types.ts";
import { formatMoney } from "../money.ts";
import { minorToCents } from "./amounts.ts";
import type { StripeRole } from "./roles.ts";
import { TAX_REASON_TEXT, type TaxResolution } from "./tax.ts";
import type { BalanceTransaction, FeeDetail } from "./types.ts";

/** One Stripe balance transaction, split by its `reporting_category` using Stripe's own `amount`,
 * `fee` and `net`: what it contributes to the entry of the payout that paid it out.
 *
 * Rastrata books Stripe the way A2X does, one entry per payout: the legs of the transactions in a
 * payout, added role by role, are that payout's entry. So a transaction's net goes to *payouts in
 * transit* (the payout's own leg, which the bank deposit later clears), and the rest of its split
 * goes to the accounts below:
 *
 *   charge        fee to Stripe fees; the gross to Sales, with sales tax split out when Stripe
 *                 reported it
 *   refund        the gross to Refunds (contra revenue)
 *   dispute       the disputed amount to Chargebacks; the dispute fee to Stripe fees
 *   fee, tax      to Stripe fees
 *   payout_reversal  clears the payouts in transit entry of a payout that failed
 *   anything else the net to the optional adjustments account (a person decides what it is)
 *
 * Every split balances to exactly 0.00 or the function throws: that is a programming error, not a
 * data problem. Free text from Stripe (descriptions, metadata, customer names) never enters a leg,
 * a summary or a memo: they are built from identifiers, fixed words and Stripe's own figures. */

export type MemberInvalid = "inconsistent" | "other_currency" | "other_balance" | "unusable_amount";

export interface MemberLeg {
  readonly role: StripeRole;
  /** Hundredths, signed from the book's view: positive is a debit. */
  readonly cents: bigint;
  readonly memo?: string;
}

export type MemberSplit =
  | {
      readonly kind: "ok";
      /** True when the category is one Rastrata does not book by itself (the net goes to adjustments). */
      readonly adjustment: boolean;
      /** Empty for a transaction that moves no money. */
      readonly legs: readonly MemberLeg[];
      readonly netCents: bigint;
      /** A charge for which Stripe reported no tax figure, so all of it was booked as sales. */
      readonly taxNotReported: boolean;
      /** A partial refund of a taxed charge: all of it was booked to Refunds, tax not split. */
      readonly refundTaxNotSplit: boolean;
      readonly diagnostics: readonly ParseDiagnostic[];
    }
  | {
      readonly kind: "invalid";
      readonly reason: MemberInvalid;
      readonly message: string;
    };

export interface SplitContext {
  /** The book's currency, upper case. */
  readonly bookCurrency: string;
  /** The tax figure for the payment a transaction belongs to, resolved by the caller. */
  readonly taxFor: (transaction: BalanceTransaction) => TaxResolution;
}

interface CategorySpec {
  readonly role: StripeRole;
  readonly label: string;
  readonly split: "charge" | "refund" | null;
}

/** The reporting categories booked by name, from Stripe's reporting-category reference. */
const CATEGORIES: Readonly<Record<string, CategorySpec>> = {
  charge: { role: "revenue.sales", label: "charge", split: "charge" },
  charge_failure: { role: "revenue.sales", label: "charge failure", split: "charge" },
  refund: { role: "refunds", label: "refund", split: "refund" },
  refund_failure: { role: "refunds", label: "refund failure", split: "refund" },
  partial_capture_reversal: {
    role: "revenue.sales",
    label: "partial capture reversal",
    split: null,
  },
  dispute: { role: "chargebacks", label: "dispute", split: null },
  dispute_reversal: { role: "chargebacks", label: "dispute reversal", split: null },
  fee: { role: "stripe.fees", label: "fee", split: null },
  tax: { role: "stripe.fees", label: "tax on Stripe fees", split: null },
  payout_reversal: { role: "payouts.in-transit", label: "payout reversal", split: null },
};

export const BOOKED_CATEGORIES: readonly string[] = Object.keys(CATEGORIES);

const FEE_WORDS: Readonly<Record<string, string>> = {
  stripe_fee: "Stripe fees",
  payment_method_passthrough_fee: "payment network costs",
  tax: "tax on Stripe fees",
  application_fee: "platform fee",
  withheld_tax: "withheld tax",
};

const abs = (n: bigint): bigint => (n < 0n ? -n : n);
const sign = (n: bigint): bigint => (n < 0n ? -1n : 1n);

/** The payment a transaction belongs to, which is where its tax figure lives. */
export function paymentIntentOf(transaction: BalanceTransaction): string | null {
  const source = transaction.source;
  if (!source) return null;
  if (source.object === "charge" || source.object === "refund" || source.object === "dispute")
    return source.paymentIntent;
  return null;
}

/** True for the categories whose gross is split into revenue (or refunds) and tax. */
export function needsTaxFigure(transaction: BalanceTransaction): boolean {
  return CATEGORIES[transaction.reportingCategory]?.split != null;
}

/** The identifier a transaction is known by in a sentence: its Stripe object, else itself. */
export function primaryId(transaction: BalanceTransaction): string {
  const source = transaction.source;
  if (
    source &&
    (source.object === "charge" ||
      source.object === "refund" ||
      source.object === "dispute" ||
      source.object === "payout" ||
      source.object === "bare" ||
      source.object === "other")
  )
    return source.id;
  return transaction.id;
}

/** Words for a transaction in a summary: the category's own label, or the plain reporting category. */
export function labelOf(transaction: BalanceTransaction): string {
  return (
    CATEGORIES[transaction.reportingCategory]?.label ?? `movement ${transaction.reportingCategory}`
  );
}

function feeMemo(details: readonly FeeDetail[], cents: (amount: bigint) => string): string {
  if (details.length === 0) return "Stripe fees";
  const totals = new Map<string, bigint>();
  for (const detail of details)
    totals.set(detail.type, (totals.get(detail.type) ?? 0n) + detail.amount);
  return [...totals]
    .map(([type, amount]) => `${FEE_WORDS[type] ?? "other fees"} ${cents(amount)}`)
    .join(", ");
}

/** Split one transaction into its legs. Pure and deterministic. */
export function splitMember(transaction: BalanceTransaction, context: SplitContext): MemberSplit {
  const amount = minorToCents(transaction.amount, transaction.currency);
  const fee = minorToCents(transaction.fee, transaction.currency);
  const net = minorToCents(transaction.net, transaction.currency);
  const id = transaction.id;
  if (amount === null || fee === null || net === null)
    return {
      kind: "invalid",
      reason: "unusable_amount",
      message: `Balance transaction ${id} has an amount that cannot be written with two decimals in ${transaction.currency}.`,
    };
  if (transaction.currency !== context.bookCurrency.toUpperCase())
    return {
      kind: "invalid",
      reason: "other_currency",
      message: `Balance transaction ${id} is in ${transaction.currency}, not the book's ${context.bookCurrency}.`,
    };
  if (transaction.balanceType !== null && transaction.balanceType !== "payments")
    return {
      kind: "invalid",
      reason: "other_balance",
      message: `Balance transaction ${id} affects Stripe's ${transaction.balanceType} balance, not the payments balance.`,
    };
  if (net !== amount - fee)
    return {
      kind: "invalid",
      reason: "inconsistent",
      message: `Balance transaction ${id}: Stripe's net does not equal amount minus fee.`,
    };

  const diagnostics: ParseDiagnostic[] = [];
  if (amount === 0n && fee === 0n && net === 0n)
    return {
      kind: "ok",
      adjustment: false,
      legs: [],
      netCents: 0n,
      taxNotReported: false,
      refundTaxNotSplit: false,
      diagnostics,
    };

  const money = (cents: bigint): string => formatMoney(abs(cents));
  const spec = CATEGORIES[transaction.reportingCategory];
  const raw: MemberLeg[] = [];
  let taxNotReported = false;
  let refundTaxNotSplit = false;

  if (net !== 0n) raw.push({ role: "payouts.in-transit", cents: net });
  if (fee !== 0n)
    raw.push({
      role: "stripe.fees",
      cents: fee,
      memo: feeMemo(transaction.feeDetails, (a) =>
        money(minorToCents(a, transaction.currency) ?? 0n),
      ),
    });

  if (!spec) {
    // Not a category Rastrata books by itself: the gross goes where the owner says adjustments go
    // (the fee, if there is one, still goes to Stripe fees).
    if (amount !== 0n)
      raw.push({
        role: "stripe.adjustments",
        cents: -amount,
        memo: `Stripe movement of a kind Rastrata does not book by itself (${transaction.reportingCategory})`,
      });
    const legs = settle(raw, transaction.id);
    return {
      kind: "ok",
      adjustment: true,
      legs,
      netCents: net,
      taxNotReported,
      refundTaxNotSplit,
      diagnostics,
    };
  }

  // The gross splits into the category account and, for charges and full refunds, sales tax.
  let taxPart = 0n; // signed like `amount`
  const tax = spec.split ? context.taxFor(transaction) : ({ state: "none" } as const);
  if (spec.split) {
    if (tax.state === "known") {
      const magnitude = abs(amount);
      if (tax.currency !== transaction.currency) {
        taxNotReported = spec.split === "charge";
      } else if (tax.amount === 0n) {
        // Stripe reported no tax on this payment: nothing to split, and nothing missing.
      } else if (tax.gross === magnitude) {
        taxPart = sign(amount) * tax.amount;
      } else if (spec.split === "charge") taxNotReported = true;
      else refundTaxNotSplit = true;
    } else if (tax.state === "not_reported") {
      taxNotReported = spec.split === "charge";
      if (taxNotReported)
        diagnostics.push({
          severity: "info",
          message: `No sales tax figure for ${transaction.id}: ${TAX_REASON_TEXT[tax.reason]}. All of it is booked as sales.`,
        });
    }
  }
  if (taxPart !== 0n) {
    raw.push({
      role: "tax.sales",
      cents: -taxPart,
      memo: `Sales tax ${money(taxPart)} as reported by Stripe`,
    });
    raw.push({
      role: spec.role,
      cents: -(amount - taxPart),
      memo: `${spec.label} excluding tax ${money(amount - taxPart)}`,
    });
  } else if (amount !== 0n) {
    raw.push({ role: spec.role, cents: -amount, memo: `${spec.label} ${money(amount)}` });
  }
  if (refundTaxNotSplit)
    diagnostics.push({
      severity: "info",
      message: `Refund ${transaction.id} is partial, so its share of sales tax is not reported by Stripe. All of it is booked to refunds; adjust the tax by hand if the tax was refunded.`,
    });
  const feeSum = transaction.feeDetails.reduce((sum, d) => sum + d.amount, 0n);
  if (transaction.feeDetails.length > 0 && feeSum !== transaction.fee)
    diagnostics.push({
      severity: "warning",
      message: `Balance transaction ${transaction.id}: the fee details do not add up to the fee. The fee is booked as Stripe reports it.`,
    });

  return {
    kind: "ok",
    adjustment: false,
    legs: settle(raw, transaction.id),
    netCents: net,
    taxNotReported,
    refundTaxNotSplit,
    diagnostics,
  };
}

/** One leg per role where that leaves at least two; otherwise the legs as they are (a payout
 * reversal's two legs on payouts in transit cancel when added, and still tell the story apart). The
 * total is checked: an unbalanced split never leaves this module. */
function settle(raw: readonly MemberLeg[], id: string): MemberLeg[] {
  const total = raw.reduce((sum, leg) => sum + leg.cents, 0n);
  if (total !== 0n) throw new Error(`Stripe movement ${id} does not balance`);
  const merged = new Map<StripeRole, { cents: bigint; memo: string | undefined }>();
  for (const leg of raw) {
    const previous = merged.get(leg.role);
    merged.set(leg.role, {
      cents: (previous?.cents ?? 0n) + leg.cents,
      memo: previous?.memo ?? leg.memo,
    });
  }
  const combined: MemberLeg[] = [...merged]
    .filter(([, value]) => value.cents !== 0n)
    .map(([role, value]) => ({
      role,
      cents: value.cents,
      ...(value.memo ? { memo: value.memo } : {}),
    }));
  return combined.length >= 2 ? combined : [...raw];
}

/** The provenance shown beside a line: Stripe's own figures and identifiers, no free text. The
 * archived raw page holds the full object. */
export function excerptOf(transaction: BalanceTransaction): string {
  return JSON.stringify({
    id: transaction.id,
    type: transaction.type,
    reporting_category: transaction.reportingCategory,
    amount: Number(transaction.amount),
    fee: Number(transaction.fee),
    net: Number(transaction.net),
    currency: transaction.currency.toLowerCase(),
    created: transaction.created,
    available_on: transaction.availableOn,
    status: transaction.status,
    source: transaction.source?.id ?? null,
  });
}

/** The related identifiers kept on a line, for matching and for a person following the trail. */
export function linksOf(
  transaction: BalanceTransaction,
  tax: TaxResolution | null,
  payoutId: string,
): Record<string, string> {
  const out: Record<string, string> = { balanceTransaction: transaction.id, payout: payoutId };
  const source = transaction.source;
  if (source?.object === "charge") {
    out.charge = source.id;
    if (source.paymentIntent) out.paymentIntent = source.paymentIntent;
  } else if (source?.object === "refund") {
    out.refund = source.id;
    if (source.charge) out.charge = source.charge;
    if (source.paymentIntent) out.paymentIntent = source.paymentIntent;
  } else if (source?.object === "dispute") {
    out.dispute = source.id;
    if (source.charge) out.charge = source.charge;
    if (source.paymentIntent) out.paymentIntent = source.paymentIntent;
  }
  if (tax?.state === "known")
    out[tax.source === "invoice" ? "invoice" : "checkoutSession"] = tax.reference;
  return out;
}

export const toLegs = (legs: readonly MemberLeg[]): EventLeg[] =>
  legs.map((leg) => ({
    role: leg.role,
    amount: formatMoney(leg.cents),
    ...(leg.memo ? { memo: leg.memo } : {}),
  }));

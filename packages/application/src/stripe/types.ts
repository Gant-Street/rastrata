/** The parts of Stripe's objects this lane reads, decoded and validated. Amounts are bigint (Stripe
 * sends integers in a currency's smallest unit), timestamps are Unix seconds, currencies are upper
 * case. Anything a hostile counterparty can write (descriptions, metadata, names) is kept only
 * where it is needed to show a person and is never used to build an entry.
 *
 * Shapes follow Stripe's OpenAPI spec 2026-09-30.endive; the tests check the fixtures against a
 * subset of it. */

export interface FeeDetail {
  readonly amount: bigint;
  readonly currency: string;
  /** `application_fee`, `payment_method_passthrough_fee`, `stripe_fee`, `tax` or `withheld_tax`. */
  readonly type: string;
}

export interface ChargeSource {
  readonly object: "charge";
  readonly id: string;
  readonly paymentIntent: string | null;
}
export interface RefundSource {
  readonly object: "refund";
  readonly id: string;
  readonly charge: string | null;
  readonly paymentIntent: string | null;
}
export interface DisputeSource {
  readonly object: "dispute";
  readonly id: string;
  readonly charge: string | null;
  readonly paymentIntent: string | null;
  readonly reason: string | null;
}
export interface Payout {
  readonly object: "payout";
  readonly id: string;
  readonly amount: bigint;
  readonly currency: string;
  readonly created: number;
  /** A date, not an instant: midnight UTC of the expected arrival day. */
  readonly arrivalDate: number;
  readonly automatic: boolean;
  /** `paid`, `pending`, `in_transit`, `canceled` or `failed`. */
  readonly status: string;
  readonly method: string;
  readonly type: string;
  /** `completed`, `in_progress` or `not_applicable`. */
  readonly reconciliationStatus: string;
  readonly balanceTransaction: string | null;
  readonly failureBalanceTransaction: string | null;
  /** Stripe's own label of the mode this payout is in (`livemode`), when the answer carried one. */
  readonly livemode?: boolean;
}
export interface OtherSource {
  readonly object: "other";
  readonly id: string;
  /** Stripe's own `object` name, validated to a short identifier. */
  readonly stripeObject: string;
}
/** A bare identifier: the balance transaction's `source` was not expanded. */
export interface BareSource {
  readonly object: "bare";
  readonly id: string;
}
export type Source =
  | ChargeSource
  | RefundSource
  | DisputeSource
  | Payout
  | OtherSource
  | BareSource;

export interface BalanceTransaction {
  readonly id: string;
  readonly amount: bigint;
  readonly fee: bigint;
  readonly net: bigint;
  readonly currency: string;
  readonly created: number;
  readonly availableOn: number;
  readonly status: string;
  readonly type: string;
  readonly reportingCategory: string;
  /** `payments`, `issuing`, `refund_and_dispute_prefunding` or `risk_reserved`; null when absent. */
  readonly balanceType: string | null;
  /** Stripe's free-text description, scrubbed and bounded. Untrusted: shown to a person on a line
   * that needs review, never used to build an entry. */
  readonly description: string | null;
  readonly hasExchangeRate: boolean;
  readonly feeDetails: readonly FeeDetail[];
  readonly source: Source | null;
}

export interface BalanceTransactionPage {
  readonly items: readonly BalanceTransaction[];
  readonly hasMore: boolean;
}

export interface PayoutPage {
  readonly items: readonly Payout[];
  readonly hasMore: boolean;
}

export interface BalanceAmount {
  readonly amount: bigint;
  readonly currency: string;
}
export interface Balance {
  readonly available: readonly BalanceAmount[];
  readonly pending: readonly BalanceAmount[];
  /** Stripe's own label of the mode this balance is in (`livemode`), when the answer carried one. */
  readonly livemode?: boolean;
}

export interface Account {
  readonly id: string;
  readonly defaultCurrency: string | null;
  readonly dashboardTimeZone: string | null;
}

export interface CheckoutSession {
  readonly id: string;
  readonly paymentIntent: string | null;
  readonly paymentStatus: string;
  readonly status: string | null;
  readonly amountTotal: bigint | null;
  readonly currency: string | null;
  readonly amountTax: bigint | null;
}

export interface InvoiceTax {
  readonly amount: bigint;
  readonly behavior: string;
}
export interface Invoice {
  readonly id: string;
  readonly total: bigint;
  readonly amountPaid: bigint;
  readonly currency: string;
  readonly status: string | null;
  /** null when Stripe did not report taxes at all; empty when it reported none. */
  readonly taxes: readonly InvoiceTax[] | null;
}
export interface InvoicePayment {
  readonly id: string;
  readonly status: string;
  readonly paymentIntent: string | null;
  readonly amountPaid: bigint | null;
  readonly amountRequested: bigint;
  readonly currency: string;
  readonly invoice: Invoice | null;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly hasMore: boolean;
}

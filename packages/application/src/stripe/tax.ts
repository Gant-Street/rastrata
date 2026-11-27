import type { CheckoutSession, InvoicePayment } from "./types.ts";

/** Sales tax, taken only from figures Stripe itself reports on the object that collected it: a
 * Checkout Session's `total_details.amount_tax`, or an invoice's `total_taxes`. Rastrata does not
 * calculate, discover or file tax. When Stripe reports no figure the whole amount is revenue and
 * the transaction is counted as "tax not reported", never guessed. */

export type TaxSource = "checkout_session" | "invoice";

export type TaxReason =
  | "no_payment_intent"
  | "source_not_expanded"
  | "no_checkout_session_or_invoice"
  | "several_checkout_sessions"
  | "several_invoices"
  | "invoice_paid_in_parts"
  | "invoice_not_paid"
  | "tax_not_reported"
  | "currency_differs"
  | "amount_differs"
  | "inconsistent";

export type TaxResolution =
  /** Stripe reported the tax on the payment: `amount` of the `gross` the customer paid. */
  | {
      readonly state: "known";
      readonly amount: bigint;
      readonly gross: bigint;
      readonly currency: string;
      readonly source: TaxSource;
      readonly reference: string;
    }
  /** Sales tax is switched off for this book: nothing is split and nothing is flagged. */
  | { readonly state: "none" }
  /** Stripe reported no usable figure; all of the amount is booked as sales. */
  | { readonly state: "not_reported"; readonly reason: TaxReason };

export const notReported = (reason: TaxReason): TaxResolution => ({
  state: "not_reported",
  reason,
});

/** The plain-language reason a person reads next to a "tax not reported" count. */
export const TAX_REASON_TEXT: Readonly<Record<TaxReason, string>> = {
  no_payment_intent: "the charge has no payment to look up",
  source_not_expanded: "Stripe's balance transaction did not include the charge",
  no_checkout_session_or_invoice:
    "the payment was not made through Checkout or an invoice, so Stripe reports no tax figure",
  several_checkout_sessions: "more than one Checkout Session claims the payment",
  several_invoices: "more than one invoice claims the payment",
  invoice_paid_in_parts:
    "the invoice was paid in several parts, so its tax cannot be split exactly",
  invoice_not_paid: "the invoice is not shown as paid by this payment",
  tax_not_reported: "Stripe reported no tax amount",
  currency_differs: "the tax is in a different currency from the settlement",
  amount_differs: "the tax figure belongs to a different amount than this payment",
  inconsistent: "Stripe's tax figure is inconsistent with the payment",
};

const valid = (tax: bigint, gross: bigint): boolean => tax >= 0n && gross >= 0n && tax <= gross;

/** From the Checkout Sessions Stripe lists for one payment intent. Null when none is found, so the
 * caller can look at invoices next. */
export function taxFromCheckoutSessions(
  sessions: readonly CheckoutSession[],
  paymentIntent: string,
): TaxResolution | null {
  const mine = sessions.filter((s) => s.paymentIntent === paymentIntent);
  if (mine.length === 0) return null;
  const [first] = mine;
  if (mine.length > 1 || !first) return notReported("several_checkout_sessions");
  if (first.amountTax === null || first.amountTotal === null || first.currency === null)
    return notReported("tax_not_reported");
  if (!valid(first.amountTax, first.amountTotal)) return notReported("inconsistent");
  return {
    state: "known",
    amount: first.amountTax,
    gross: first.amountTotal,
    currency: first.currency,
    source: "checkout_session",
    reference: first.id,
  };
}

/** From the invoice payments Stripe lists for one payment intent, each with its invoice expanded.
 * The tax is the invoice's only when this one payment paid the invoice's whole total; an invoice
 * paid in parts (a credit balance plus a card, say) cannot be split exactly from here. */
export function taxFromInvoicePayments(
  payments: readonly InvoicePayment[],
  paymentIntent: string,
): TaxResolution | null {
  const mine = payments.filter((p) => p.paymentIntent === paymentIntent);
  if (mine.length === 0) return null;
  const [first] = mine;
  if (!first || new Set(mine.map((p) => p.invoice?.id ?? p.id)).size > 1)
    return notReported("several_invoices");
  const invoice = first.invoice;
  if (!invoice) return notReported("source_not_expanded");
  if (first.amountPaid === null || first.status !== "paid") return notReported("invoice_not_paid");
  if (first.amountPaid !== invoice.total || invoice.amountPaid !== invoice.total)
    return notReported("invoice_paid_in_parts");
  if (invoice.taxes === null) return notReported("tax_not_reported");
  const tax = invoice.taxes.reduce((sum, t) => sum + t.amount, 0n);
  if (!valid(tax, invoice.total)) return notReported("inconsistent");
  return {
    state: "known",
    amount: tax,
    gross: invoice.total,
    currency: invoice.currency,
    source: "invoice",
    reference: invoice.id,
  };
}

/** The logical accounts Stripe movements are booked against: the cross-lane contract with the chart
 * lane (an account carries `tags.roleKey`) and with the ingestion pipeline (`EventLeg.role`).
 * Roles are this connector's vocabulary; the owner maps each to a chart account.
 *
 * Seven are the contract. The eighth, `stripe.adjustments`, is optional and the Stripe lane's own:
 * where the net of movements Rastrata does not book by itself (a Stripe adjustment, a top-up, a
 * reserve) goes when they are inside a payout. Without it, such a payout is shown but not proposed,
 * so nothing is guessed. */
export const STRIPE_ROLES = [
  "stripe.balance",
  "stripe.fees",
  "payouts.in-transit",
  "refunds",
  "chargebacks",
  "tax.sales",
  "revenue.sales",
  "stripe.adjustments",
] as const;

export type StripeRole = (typeof STRIPE_ROLES)[number];

export type AccountKind = "asset" | "liability" | "equity" | "income" | "expense";

/** The kinds of chart account each role may be mapped to, the first being the expected one. */
export const ROLE_KINDS: Readonly<Record<StripeRole, readonly AccountKind[]>> = {
  "stripe.balance": ["asset"],
  "payouts.in-transit": ["asset"],
  "stripe.fees": ["expense"],
  chargebacks: ["expense", "income"],
  "tax.sales": ["liability"],
  "revenue.sales": ["income"],
  refunds: ["income", "expense"],
  "stripe.adjustments": ["expense", "income"],
};

/** Words for each role in sentences a person reads. */
export const ROLE_LABELS: Readonly<Record<StripeRole, string>> = {
  "stripe.balance": "Stripe balance",
  "stripe.fees": "Stripe fees",
  "payouts.in-transit": "Payouts in transit",
  refunds: "Refunds",
  chargebacks: "Chargebacks and disputes",
  "tax.sales": "Sales tax payable",
  "revenue.sales": "Sales",
  "stripe.adjustments": "Other Stripe adjustments",
};

/** The order a payout's entry lists its accounts in. */
export const ROLE_ORDER: readonly StripeRole[] = [
  "payouts.in-transit",
  "revenue.sales",
  "tax.sales",
  "refunds",
  "chargebacks",
  "stripe.fees",
  "stripe.adjustments",
  "stripe.balance",
];

export function isStripeRole(value: unknown): value is StripeRole {
  return typeof value === "string" && (STRIPE_ROLES as readonly string[]).includes(value);
}

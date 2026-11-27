import {
  type BalanceCheck,
  definePlugin,
  type EventLeg,
  type GuardedHttp,
  type IngestLine,
  isPluginError,
  money,
  PluginError,
} from "@rastrata/plugin-sdk";

/** Official MIT-licensed Stripe payout & clearing plugin for Rastrata.
 *
 * Proves the `LedgerEvent` + `coveredBy` + `clearing` side of `@rastrata/plugin-sdk`:
 * - Books one balanced entry per automatic payout (A2X convention) dated on `arrival_date`
 * - Supports restricted read-only keys even when Account or Balance read is omitted
 * - Optional Stripe Tax split from Checkout Sessions (`total_details.amount_tax`) and
 *   Invoice Payments (`invoice.total_taxes`), never guessing when Stripe reports no tax
 * - Preserves every underlying balance transaction as `coveredBy` evidence (never double-booked)
 * - Verifies exact cent-for-cent tie-out between member transactions and payout net; refuses to
 *   guess on mismatches or foreign currencies (holds them as plain BankLines for human review)
 * - Declares `clearing: { role: "payouts.in-transit", windowDays: 7 }` so Rastrata's generic
 *   plugin proposer pairs bank deposits to payouts automatically */

const STRIPE_API = "https://api.stripe.com/v1";
const STRIPE_VERSION = "2025-03-31.basil";
const CURSOR_OVERLAP_SECONDS = 3 * 86_400;

const ROLE_ORDER = [
  "payouts.in-transit",
  "revenue.sales",
  "tax.sales",
  "refunds",
  "chargebacks",
  "stripe.fees",
  "stripe.adjustments",
] as const;

export type StripePluginRole = (typeof ROLE_ORDER)[number];

interface StripeAccount {
  readonly id: string;
  readonly default_currency?: string;
}

interface StripePayout {
  readonly id: string;
  readonly amount: number;
  readonly currency: string;
  readonly arrival_date: number;
  readonly created: number;
  readonly status: string;
  readonly automatic?: boolean;
  readonly reconciliation_status?: string;
}

interface StripeExpandedSource {
  readonly id?: string;
  readonly payment_intent?: string | { readonly id?: string } | null;
  readonly metadata?: Record<string, string>;
}

interface StripeBalanceTransaction {
  readonly id: string;
  readonly amount: number;
  readonly fee: number;
  readonly net: number;
  readonly currency: string;
  readonly created: number;
  readonly reporting_category: string;
  readonly type?: string;
  readonly source?: string | StripeExpandedSource | null;
  readonly metadata?: Record<string, string>;
}

interface StripeCheckoutSession {
  readonly id: string;
  readonly payment_intent?: string | { readonly id?: string } | null;
  readonly currency?: string | null;
  readonly amount_total?: number | null;
  readonly total_details?: { readonly amount_tax?: number | null } | null;
}

interface StripeInvoicePayment {
  readonly id: string;
  readonly status?: string;
  readonly amount_paid?: number | null;
  readonly payment?: {
    readonly payment_intent?: string | { readonly id?: string } | null;
  } | null;
  readonly invoice?:
    | string
    | {
        readonly id?: string;
        readonly currency?: string | null;
        readonly total?: number | null;
        readonly amount_paid?: number | null;
        readonly total_taxes?: readonly { readonly amount?: number | null }[] | null;
      }
    | null;
}

interface StripeBalance {
  readonly available?: readonly { readonly amount: number; readonly currency: string }[];
  readonly pending?: readonly { readonly amount: number; readonly currency: string }[];
}

interface StripeList<T> {
  readonly data: readonly T[];
  readonly has_more: boolean;
}

function unixToUtcDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function isForbidden(error: unknown): boolean {
  return isPluginError(error) && error.code === "auth_error" && error.message.includes("(403)");
}

function idOf(ref: string | { readonly id?: string } | null | undefined): string | null {
  if (typeof ref === "string" && ref.length > 0) return ref;
  if (ref && typeof ref === "object" && typeof ref.id === "string" && ref.id.length > 0) {
    return ref.id;
  }
  return null;
}

function paymentIntentOf(tx: StripeBalanceTransaction): string | null {
  if (!tx.source || typeof tx.source !== "object") return null;
  return idOf(tx.source.payment_intent);
}

function parseMetadataTaxCents(tx: StripeBalanceTransaction): bigint {
  const raw =
    tx.metadata?.tax_amount ??
    (tx.source && typeof tx.source === "object" ? tx.source.metadata?.tax_amount : undefined);
  if (!raw || !/^\d+$/.test(raw)) return 0n;
  const parsed = BigInt(raw);
  const gross = BigInt(tx.amount);
  return parsed > 0n && parsed <= gross ? parsed : 0n;
}

/** Look up Stripe-reported sales tax on a charge's PaymentIntent (Checkout Session or Invoice).
 * Returns exact tax cents when Stripe unambiguously reports it for this payment; 0n otherwise. */
async function resolveStripeTaxCents(
  tx: StripeBalanceTransaction,
  bookCurrency: string,
  http: GuardedHttp,
  headers: Record<string, string>,
  cache: Map<string, bigint>,
): Promise<bigint> {
  const pi = paymentIntentOf(tx);
  if (!pi) return 0n;
  const cached = cache.get(pi);
  if (cached !== undefined) return cached;

  const grossCents = BigInt(tx.amount);
  let resolved = 0n;

  // 1. Checkout Sessions (`total_details.amount_tax`)
  let foundCheckout = false;
  try {
    const params = new URLSearchParams({ payment_intent: pi, limit: "5" });
    const res = await http.getJson<StripeList<StripeCheckoutSession>>(
      `${STRIPE_API}/checkout/sessions?${params.toString()}`,
      { headers },
    );
    const matching = res.data.data.filter((s) => idOf(s.payment_intent) === pi);
    if (matching.length === 1 && matching[0]) {
      foundCheckout = true;
      const s = matching[0];
      const tax = s.total_details?.amount_tax;
      const total = s.amount_total;
      if (
        typeof tax === "number" &&
        Number.isSafeInteger(tax) &&
        typeof total === "number" &&
        Number.isSafeInteger(total) &&
        s.currency?.toUpperCase() === bookCurrency &&
        BigInt(total) === grossCents &&
        tax >= 0 &&
        BigInt(tax) <= grossCents
      ) {
        resolved = BigInt(tax);
      }
    } else if (matching.length > 1) {
      foundCheckout = true; // ambiguous: never guess
    }
  } catch (error) {
    if (!isForbidden(error)) throw error;
  }

  // 2. Invoice Payments (`invoice.total_taxes`) when not paid through Checkout
  if (!foundCheckout) {
    try {
      const params = new URLSearchParams({
        "payment[type]": "payment_intent",
        "payment[payment_intent]": pi,
        limit: "10",
      });
      params.append("expand[]", "data.invoice");
      const res = await http.getJson<StripeList<StripeInvoicePayment>>(
        `${STRIPE_API}/invoice_payments?${params.toString()}`,
        { headers },
      );
      const matching = res.data.data.filter(
        (p) => !p.payment?.payment_intent || idOf(p.payment.payment_intent) === pi,
      );
      const uniqueInvoices = new Set(
        matching.map((p) => (typeof p.invoice === "object" ? p.invoice?.id : p.invoice) ?? p.id),
      );
      if (matching.length >= 1 && uniqueInvoices.size === 1) {
        const first = matching[0];
        const inv = first?.invoice;
        if (
          first &&
          inv &&
          typeof inv === "object" &&
          first.status === "paid" &&
          typeof first.amount_paid === "number" &&
          typeof inv.total === "number" &&
          typeof inv.amount_paid === "number" &&
          first.amount_paid === inv.total &&
          inv.amount_paid === inv.total &&
          inv.currency?.toUpperCase() === bookCurrency &&
          BigInt(inv.total) === grossCents &&
          Array.isArray(inv.total_taxes)
        ) {
          let sum = 0n;
          let valid = true;
          for (const entry of inv.total_taxes) {
            if (typeof entry.amount !== "number" || !Number.isSafeInteger(entry.amount)) {
              valid = false;
              break;
            }
            sum += BigInt(entry.amount);
          }
          if (valid && sum >= 0n && sum <= grossCents) {
            resolved = sum;
          }
        }
      }
    } catch (error) {
      if (!isForbidden(error)) throw error;
    }
  }

  cache.set(pi, resolved);
  return resolved;
}

interface SplitLeg {
  readonly role: StripePluginRole;
  readonly cents: bigint;
  readonly memo?: string;
}

/** Split one Stripe balance transaction into balanced double-entry legs (sum === 0n). */
function splitBalanceTransaction(
  tx: StripeBalanceTransaction,
  taxCents: bigint,
):
  | { readonly ok: true; readonly legs: readonly SplitLeg[]; readonly netCents: bigint }
  | {
      readonly ok: false;
      readonly reason: string;
    } {
  if (
    !Number.isSafeInteger(tx.amount) ||
    !Number.isSafeInteger(tx.fee) ||
    !Number.isSafeInteger(tx.net)
  ) {
    return { ok: false, reason: `Non-integer minor units on ${tx.id}` };
  }
  const amount = BigInt(tx.amount);
  const fee = BigInt(tx.fee);
  const net = BigInt(tx.net);
  if (amount - fee !== net) {
    return {
      ok: false,
      reason: `Inconsistent Stripe balance transaction ${tx.id}: amount(${amount}) - fee(${fee}) !== net(${net})`,
    };
  }
  if (amount === 0n && fee === 0n && net === 0n) {
    return { ok: true, legs: [], netCents: 0n };
  }

  const legs: SplitLeg[] = [];
  const cat = tx.reporting_category;

  if (cat === "charge" || cat === "charge_failure") {
    const appliedTax = cat === "charge" && taxCents > 0n && taxCents <= amount ? taxCents : 0n;
    const salesCents = amount - appliedTax;
    if (salesCents !== 0n) legs.push({ role: "revenue.sales", cents: -salesCents, memo: cat });
    if (appliedTax !== 0n) legs.push({ role: "tax.sales", cents: -appliedTax, memo: "sales tax" });
    if (fee !== 0n) legs.push({ role: "stripe.fees", cents: fee, memo: "Stripe fees" });
    if (net !== 0n) legs.push({ role: "payouts.in-transit", cents: net, memo: "net to payout" });
  } else if (cat === "refund" || cat === "refund_failure") {
    if (amount !== 0n) legs.push({ role: "refunds", cents: -amount, memo: cat });
    if (fee !== 0n) legs.push({ role: "stripe.fees", cents: fee, memo: "fee adjustment" });
    if (net !== 0n) legs.push({ role: "payouts.in-transit", cents: net, memo: "net to payout" });
  } else if (cat === "dispute" || cat === "dispute_reversal") {
    if (amount !== 0n) legs.push({ role: "chargebacks", cents: -amount, memo: cat });
    if (fee !== 0n) legs.push({ role: "stripe.fees", cents: fee, memo: "dispute fee" });
    if (net !== 0n) legs.push({ role: "payouts.in-transit", cents: net, memo: "net to payout" });
  } else if (cat === "fee" || cat === "tax") {
    if (net !== 0n) {
      legs.push({ role: "stripe.fees", cents: -net, memo: cat });
      legs.push({ role: "payouts.in-transit", cents: net, memo: "net to payout" });
    }
  } else {
    if (net !== 0n) {
      legs.push({ role: "stripe.adjustments", cents: -net, memo: cat });
      legs.push({ role: "payouts.in-transit", cents: net, memo: "net to payout" });
    }
  }

  const check = legs.reduce((acc, l) => acc + l.cents, 0n);
  if (check !== 0n) {
    throw new PluginError({
      code: "unbalanced_event",
      message: `Internal split error on ${tx.id}: legs summed to ${money.fromCents(check)} instead of 0.00.`,
      hint: "Every split transaction must balance to exact 0.00.",
    });
  }
  return { ok: true, legs, netCents: net };
}

function toWireLegs(legs: readonly SplitLeg[]): EventLeg<StripePluginRole>[] {
  const totals = new Map<StripePluginRole, bigint>();
  for (const leg of legs) {
    totals.set(leg.role, (totals.get(leg.role) ?? 0n) + leg.cents);
  }
  const ordered: EventLeg<StripePluginRole>[] = [];
  for (const role of ROLE_ORDER) {
    const cents = totals.get(role) ?? 0n;
    if (cents !== 0n) {
      ordered.push({ role, amount: money.fromCents(cents) });
    }
  }
  return ordered;
}

export const stripeManifest = {
  id: "stripe",
  version: "1.0.0",
  name: "Stripe",
  description:
    "Imports Stripe payouts as balanced multi-leg entries (sales, tax, refunds, disputes, fees) with automatic bank-deposit clearing.",
  capabilities: ["ingest"],
  domains: ["api.stripe.com"],
  auth: {
    kind: "api_key",
    label: "Stripe restricted read-only key",
    envVar: "RASTRATA_PLUGIN_STRIPE_KEY",
    hint: "Create a restricted read-only key in Stripe Developers -> API keys.",
  },
  fields: [
    {
      key: "startDate",
      label: "Start importing payouts from",
      kind: "date",
      hint: "Optional earliest payout arrival date (YYYY-MM-DD).",
    },
    {
      key: "salesTax",
      label: "Sales tax split",
      kind: "select",
      options: [
        { value: "none", label: "Book full gross to Sales" },
        { value: "stripe", label: "Split Stripe Tax (Checkout & Invoices)" },
        { value: "metadata", label: "Split metadata.tax_amount (cents) to Sales Tax" },
      ],
      default: "none",
    },
  ],
  roles: [
    {
      key: "payouts.in-transit",
      label: "Payouts in transit",
      kind: "asset",
      required: true,
      defaultRoleKey: "payouts.in-transit",
    },
    {
      key: "revenue.sales",
      label: "Sales",
      kind: "income",
      required: true,
      defaultRoleKey: "revenue.sales",
    },
    {
      key: "tax.sales",
      label: "Sales tax payable",
      kind: "liability",
      required: true,
      defaultRoleKey: "tax.sales",
    },
    {
      key: "refunds",
      label: "Refunds",
      kind: "income",
      required: true,
      defaultRoleKey: "refunds",
    },
    {
      key: "chargebacks",
      label: "Chargebacks and disputes",
      kind: "expense",
      required: true,
      defaultRoleKey: "chargebacks",
    },
    {
      key: "stripe.fees",
      label: "Stripe fees",
      kind: "expense",
      required: true,
      defaultRoleKey: "stripe.fees",
    },
    {
      key: "stripe.adjustments",
      label: "Other Stripe adjustments",
      kind: "expense",
      required: false,
      defaultRoleKey: "stripe.adjustments",
    },
  ],
  clearing: {
    role: "payouts.in-transit",
    windowDays: 7,
  },
} as const;

export const stripePlugin = definePlugin({
  manifest: stripeManifest,

  async *pull(ctx) {
    const headers = {
      authorization: `Bearer ${ctx.auth.apiKey}`,
      "stripe-version": STRIPE_VERSION,
      accept: "application/json",
    };

    let accountId = "default";
    try {
      const accountRes = await ctx.http.getJson<StripeAccount>(`${STRIPE_API}/account`, {
        headers,
      });
      if (accountRes.data.id) accountId = accountRes.data.id;
    } catch (error) {
      // Restricted read-only keys that omit Account:Read receive HTTP 403; fall back cleanly.
      // Invalid or revoked keys receive HTTP 401 and must fail immediately.
      if (!isForbidden(error)) throw error;
    }
    const bookCurrency = ctx.bookCurrency.toUpperCase();
    const accountKey = `stripe:${accountId}:${bookCurrency.toLowerCase()}`;

    // Resolve earliest arrival timestamp from cursor (with 3-day overlap for late arrivals) or config.startDate.
    let minArrivalUnix: number | undefined;
    if (ctx.cursor && /^\d+$/.test(ctx.cursor)) {
      minArrivalUnix = Math.max(0, Number(ctx.cursor) - CURSOR_OVERLAP_SECONDS);
    } else if (ctx.config.startDate) {
      minArrivalUnix = Math.floor(Date.parse(`${ctx.config.startDate}T00:00:00Z`) / 1000);
    }

    const payouts: StripePayout[] = [];
    let startingAfter: string | undefined;
    for (;;) {
      const params = new URLSearchParams({ status: "paid", limit: "100" });
      if (minArrivalUnix !== undefined) params.set("arrival_date[gte]", String(minArrivalUnix));
      if (startingAfter) params.set("starting_after", startingAfter);

      const page = await ctx.http.getJson<StripeList<StripePayout>>(
        `${STRIPE_API}/payouts?${params.toString()}`,
        { headers },
      );
      payouts.push(...page.data.data);
      if (!page.data.has_more || page.data.data.length === 0) break;
      startingAfter = page.data.data.at(-1)?.id;
    }

    // Oldest-first deterministic order.
    payouts.sort((a, b) =>
      a.arrival_date !== b.arrival_date
        ? a.arrival_date - b.arrival_date
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
    );

    const asOfDate = ctx.now().slice(0, 10);
    let balanceCheck: BalanceCheck | undefined;
    try {
      const balRes = await ctx.http.getJson<StripeBalance>(`${STRIPE_API}/balance`, { headers });
      const avail = (balRes.data.available ?? [])
        .filter((b) => b.currency.toUpperCase() === bookCurrency)
        .reduce((sum, b) => sum + BigInt(b.amount), 0n);
      const pend = (balRes.data.pending ?? [])
        .filter((b) => b.currency.toUpperCase() === bookCurrency)
        .reduce((sum, b) => sum + BigInt(b.amount), 0n);
      balanceCheck = {
        accountKey,
        asOf: asOfDate,
        balance: money.fromCents(avail + pend),
      };
    } catch {
      // Optional balance endpoint: proceed with payouts even if restricted key omitted Balance read.
    }

    const taxMode = ctx.config.salesTax;
    const taxCache = new Map<string, bigint>();
    let blockedByInProgress = false;

    for (let pIdx = 0; pIdx < payouts.length; pIdx += 1) {
      const payout = payouts[pIdx];
      if (!payout) continue;
      // Wait for Stripe to finish itemising a payout rather than holding it prematurely as a mismatch.
      if (payout.reconciliation_status === "in_progress") {
        blockedByInProgress = true;
        continue;
      }
      const arrivalOn = unixToUtcDate(payout.arrival_date);
      const payoutCurrency = payout.currency.toUpperCase();
      const isLastPayout = pIdx === payouts.length - 1;
      const nextCursor = blockedByInProgress ? undefined : String(payout.arrival_date);

      // Hold foreign-currency or manual payouts as plain BankLines; never silently convert.
      if (payoutCurrency !== bookCurrency || payout.automatic === false) {
        const reason =
          payoutCurrency !== bookCurrency
            ? `Stripe payout ${payout.id} in ${payoutCurrency} (book is ${bookCurrency}): held for review`
            : `Manual Stripe payout ${payout.id}: held for review`;
        const heldLine = ctx.emit.bankLine({
          accountKey: `stripe:${accountId}:${payoutCurrency.toLowerCase()}`,
          providerId: payout.id,
          rawIndex: 0,
          postedOn: arrivalOn,
          amount: money.fromMinorUnits(-payout.amount, payoutCurrency),
          currency: payoutCurrency,
          description: reason,
          counterparty: "Stripe (payout)",
          reference: payout.id,
          excerpt: JSON.stringify({
            id: payout.id,
            amount: payout.amount,
            currency: payout.currency,
            arrival_date: payout.arrival_date,
            automatic: payout.automatic ?? true,
          }),
        });
        yield {
          sourceKey: accountKey,
          raw: {
            bytes: new TextEncoder().encode(JSON.stringify(payout)),
            mediaType: "application/json",
            name: `stripe-payout-${payout.id}-held.json`,
          },
          lines: [heldLine],
          ...(isLastPayout && balanceCheck ? { balances: [balanceCheck] } : {}),
          ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
        };
        continue;
      }

      // Fetch all balance transactions belonging to this payout.
      const members: StripeBalanceTransaction[] = [];
      const rawPages: Uint8Array[] = [];
      let txAfter: string | undefined;
      for (;;) {
        const params = new URLSearchParams({ payout: payout.id, limit: "100" });
        if (taxMode === "stripe") params.append("expand[]", "data.source");
        if (txAfter) params.set("starting_after", txAfter);
        const page = await ctx.http.getJson<StripeList<StripeBalanceTransaction>>(
          `${STRIPE_API}/balance_transactions?${params.toString()}`,
          { headers },
        );
        rawPages.push(page.raw.bytes);
        for (const tx of page.data.data) {
          if (tx.reporting_category !== "payout") members.push(tx);
        }
        if (!page.data.has_more || page.data.data.length === 0) break;
        txAfter = page.data.data.at(-1)?.id;
      }

      members.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

      // Combine raw pages into one archive payload (verbatim single page when 1 page).
      let rawBytes: Uint8Array;
      if (rawPages.length === 1 && rawPages[0]) {
        rawBytes = rawPages[0];
      } else {
        const merged = rawPages.map((b) => new TextDecoder().decode(b)).join("\n");
        rawBytes = new TextEncoder().encode(merged);
      }

      const allLegs: SplitLeg[] = [];
      const memberLines: IngestLine<StripePluginRole>[] = [];
      let memberNetSum = 0n;
      let tieOutProblem: string | null = null;

      for (let mIdx = 0; mIdx < members.length; mIdx += 1) {
        const tx = members[mIdx];
        if (!tx) continue;
        if (tx.currency.toUpperCase() !== bookCurrency) {
          tieOutProblem = `Transaction ${tx.id} currency ${tx.currency.toUpperCase()} differs from ${bookCurrency}`;
          break;
        }
        let taxCents = 0n;
        if (tx.reporting_category === "charge") {
          if (taxMode === "metadata") {
            taxCents = parseMetadataTaxCents(tx);
          } else if (taxMode === "stripe") {
            taxCents = await resolveStripeTaxCents(tx, bookCurrency, ctx.http, headers, taxCache);
          }
        }
        const split = splitBalanceTransaction(tx, taxCents);
        if (!split.ok) {
          tieOutProblem = split.reason;
          break;
        }
        memberNetSum += split.netCents;
        allLegs.push(...split.legs);

        const wireMemberLegs = toWireLegs(split.legs);
        if (wireMemberLegs.length >= 2) {
          memberLines.push(
            ctx.emit.event({
              accountKey,
              providerId: tx.id,
              rawIndex: mIdx + 1,
              eventOn: unixToUtcDate(tx.created),
              summary: `Stripe ${tx.reporting_category} ${tx.id}`,
              currency: bookCurrency,
              amount: money.fromCents(split.netCents),
              legs: wireMemberLegs,
              links: { payout: payout.id, category: tx.reporting_category },
              coveredBy: payout.id,
              evidence: `Included in Stripe payout ${payout.id} (${arrivalOn})`,
              excerpt: JSON.stringify({
                id: tx.id,
                amount: tx.amount,
                fee: tx.fee,
                net: tx.net,
                category: tx.reporting_category,
              }),
            }),
          );
        }
      }

      const expectedPayoutCents = BigInt(payout.amount);
      if (!tieOutProblem && (members.length === 0 || memberNetSum !== expectedPayoutCents)) {
        tieOutProblem = `Member net ${money.fromCents(memberNetSum)} does not equal payout ${payout.id} (${money.fromCents(expectedPayoutCents)})`;
      }

      const payoutWireLegs = toWireLegs(allLegs);
      if (tieOutProblem || payoutWireLegs.length < 2) {
        const heldLine = ctx.emit.bankLine({
          accountKey,
          providerId: payout.id,
          rawIndex: 0,
          postedOn: arrivalOn,
          amount: money.fromCents(-expectedPayoutCents),
          currency: bookCurrency,
          description: `Stripe payout ${payout.id} held for review: ${tieOutProblem ?? "no itemised legs"}`,
          counterparty: "Stripe (payout)",
          reference: payout.id,
        });
        yield {
          sourceKey: accountKey,
          raw: {
            bytes: rawBytes,
            mediaType: "application/json",
            name: `stripe-payout-${payout.id}-held.json`,
          },
          lines: [heldLine],
          ...(isLastPayout && balanceCheck ? { balances: [balanceCheck] } : {}),
          ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
        };
        continue;
      }

      const payoutEvent = ctx.emit.event({
        accountKey,
        providerId: payout.id,
        rawIndex: 0,
        eventOn: arrivalOn,
        summary: `Stripe payout ${payout.id} (${members.length} ${members.length === 1 ? "transaction" : "transactions"})`,
        currency: bookCurrency,
        amount: money.fromCents(expectedPayoutCents),
        legs: payoutWireLegs,
        links: {
          payout: payout.id,
          members: String(members.length),
        },
        excerpt: JSON.stringify({
          id: payout.id,
          amount: payout.amount,
          currency: payout.currency,
          arrival_date: payout.arrival_date,
          members: members.length,
        }),
      });

      yield {
        sourceKey: accountKey,
        raw: {
          bytes: rawBytes,
          mediaType: "application/json",
          name: `stripe-payout-${payout.id}.json`,
        },
        lines: [payoutEvent, ...memberLines],
        ...(isLastPayout && balanceCheck ? { balances: [balanceCheck] } : {}),
        ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
      };
    }
  },
});

export default stripePlugin;

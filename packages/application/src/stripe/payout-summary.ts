import { hashCanonical } from "@rastrata/kernel";
import type { BankLine, EventLeg, LedgerEvent, ParseDiagnostic } from "../ingest-types.ts";
import { formatMoney } from "../money.ts";
import { minorToCents } from "./amounts.ts";
import { utcDate } from "./dates.ts";
import {
  type MemberLeg,
  type SplitContext,
  excerptOf,
  labelOf,
  linksOf,
  primaryId,
  splitMember,
  toLegs,
} from "./normalise.ts";
import { isPayoutItself } from "./payout-verify.ts";
import { ROLE_ORDER, type StripeRole } from "./roles.ts";
import type { TaxResolution } from "./tax.ts";
import type { BalanceTransaction, Payout } from "./types.ts";

/** One entry per payout, the convention A2X made standard for Stripe: the transactions Stripe says
 * a payout paid out are added up role by role into a single balanced entry dated on the payout's
 * arrival date, with the payout's net against payouts in transit, which the bank deposit clears.
 *
 * Each transaction stays a line of its own, as evidence, covered by the payout's entry: its legs are
 * the part it contributes, so the covered lines' legs added role by role are exactly the payout
 * entry (a check the tests make). Why one entry per payout and not per transaction: the book's cost
 * grows with the number of journals, and a business with a couple of thousand Stripe transactions a
 * year would exhaust it; a payout a day is about 250 a year, and the books still carry every
 * figure, because the evidence lines and the archived pages carry the rest.
 *
 * Tie-out, in this order, and the entry is made only if every one holds:
 *   1. the payout is in the book's currency and is an automatic payout Stripe itemises;
 *   2. every transaction can be split exactly (no inconsistent net, no unusable amount);
 *   3. the transactions' net adds up to the payout amount to the cent;
 *   4. the legs add up to exactly 0.00.
 * Otherwise nothing is made up: the payout is reported with what is wrong. */

export interface PayoutMember {
  readonly transaction: BalanceTransaction;
  /** Which page of the payout's transaction list this came from, and where in it. */
  readonly page: number;
  readonly rawIndex: number;
}

export interface SummaryContext extends SplitContext {
  /** "stripe:acct_1ABC"; the currency is appended per line. */
  readonly accountKeyBase: string;
}

export interface PayoutCounts {
  readonly members: number;
  readonly taxNotReported: number;
  readonly refundTaxNotSplit: number;
  readonly adjustments: number;
}

export type PayoutOutcome =
  | {
      readonly kind: "summary";
      /** The payout's entry: aggregated legs, balanced to 0.00. */
      readonly payout: LedgerEvent;
      /** The transactions, as evidence, each covered by the payout. */
      readonly members: readonly { readonly page: number; readonly event: LedgerEvent }[];
      readonly counts: PayoutCounts;
      readonly diagnostics: readonly ParseDiagnostic[];
      readonly membersSha256: string;
    }
  /** A payout Rastrata does not itemise: a plain line on the Stripe balance for a person. */
  | {
      readonly kind: "held";
      readonly reason: "other_currency" | "manual";
      readonly line: BankLine;
      readonly message: string;
    }
  | {
      readonly kind: "mismatch";
      readonly memberNetCents: bigint;
      readonly differenceCents: bigint;
      readonly memberCount: number;
      readonly message: string;
    }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "empty"; readonly message: string };

const signedAmount = (cents: bigint): string => formatMoney(cents);

/** SHA-256 over the transactions' identifiers and nets, sorted, so the entry can say exactly which
 * transactions it stands for and anyone can recompute it from the archived pages. */
export function membersHash(payoutId: string, members: readonly BalanceTransaction[]): string {
  const lines = members
    .map((m) => [m.id, m.net.toString()] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([id, net]) => `${id}:${net}`);
  return hashCanonical({ type: "StripePayoutMembers", payout: payoutId, members: lines }).digest;
}

/** The held line for a payout Rastrata does not itemise: Stripe's own debit of the balance. */
function heldPayoutLine(
  payout: Payout,
  accountKeyBase: string,
  postedOn: string,
  description: string,
): BankLine | null {
  const cents = minorToCents(payout.amount, payout.currency);
  if (cents === null) return null;
  return {
    kind: "bankLine",
    provider: "stripe",
    accountKey: `${accountKeyBase}:${payout.currency.toLowerCase()}`,
    providerId: payout.id,
    rawIndex: 0,
    excerpt: JSON.stringify({
      id: payout.id,
      amount: Number(payout.amount),
      currency: payout.currency.toLowerCase(),
      arrival_date: payout.arrivalDate,
      status: payout.status,
      automatic: payout.automatic,
    }),
    postedOn,
    amount: signedAmount(-cents),
    currency: payout.currency,
    description,
    counterparty: "Stripe (payout)",
    reference: payout.id,
  };
}

export function summarisePayout(
  payout: Payout,
  listed: readonly PayoutMember[],
  context: SummaryContext,
): PayoutOutcome {
  const arrival = utcDate(payout.arrivalDate);
  const amount = minorToCents(payout.amount, payout.currency);
  if (amount === null)
    return {
      kind: "invalid",
      message: `Payout ${payout.id} has an amount that cannot be written exactly.`,
    };

  if (payout.currency !== context.bookCurrency.toUpperCase()) {
    const line = heldPayoutLine(
      payout,
      context.accountKeyBase,
      arrival,
      `Stripe payout in ${payout.currency}, not the book's ${context.bookCurrency}: held for review, never converted`,
    );
    return line
      ? {
          kind: "held",
          reason: "other_currency",
          line,
          message: `Payout ${payout.id} is in ${payout.currency}, not the book's ${context.bookCurrency}. It is held for review and never converted.`,
        }
      : {
          kind: "invalid",
          message: `Payout ${payout.id} has an amount that cannot be written exactly.`,
        };
  }
  if (!payout.automatic || payout.reconciliationStatus === "not_applicable") {
    const line = heldPayoutLine(
      payout,
      context.accountKeyBase,
      arrival,
      "Manual Stripe payout: Stripe does not say which transactions it contains, so it cannot be split",
    );
    return line
      ? {
          kind: "held",
          reason: "manual",
          line,
          message: `Payout ${payout.id} was made by hand, so Stripe does not say which transactions it paid out. It is held for you to categorise.`,
        }
      : {
          kind: "invalid",
          message: `Payout ${payout.id} has an amount that cannot be written exactly.`,
        };
  }

  // The payout's own debit of the balance is not something it paid out.
  const members = listed.filter((m) => !isPayoutItself(payout, m.transaction));
  if (members.length === 0)
    return {
      kind: "empty",
      message: `Stripe lists no transactions for payout ${payout.id}, so there is nothing to book.`,
    };

  const splits: {
    member: PayoutMember;
    legs: readonly MemberLeg[];
    netCents: bigint;
    adjustment: boolean;
  }[] = [];
  const diagnostics: ParseDiagnostic[] = [];
  let taxNotReported = 0;
  let refundTaxNotSplit = 0;
  let adjustments = 0;
  let net = 0n;
  for (const member of members) {
    const split = splitMember(member.transaction, context);
    if (split.kind === "invalid")
      return { kind: "invalid", message: `Payout ${payout.id} cannot be booked: ${split.message}` };
    net += split.netCents;
    if (split.taxNotReported) taxNotReported++;
    if (split.refundTaxNotSplit) refundTaxNotSplit++;
    if (split.adjustment) adjustments++;
    for (const d of split.diagnostics) diagnostics.push(d);
    splits.push({
      member,
      legs: split.legs,
      netCents: split.netCents,
      adjustment: split.adjustment,
    });
  }
  if (net !== amount)
    return {
      kind: "mismatch",
      memberNetCents: net,
      differenceCents: amount - net,
      memberCount: members.length,
      message: `Payout ${payout.id}: the ${members.length} transactions Stripe says it paid out add up to ${formatMoney(net)}, not the payout's ${formatMoney(amount)}.`,
    };

  // The payout's entry is the transactions' legs added role by role.
  const totals = new Map<StripeRole, { cents: bigint; count: number; memo: string | null }>();
  for (const { legs } of splits)
    for (const leg of legs) {
      const entry = totals.get(leg.role) ?? { cents: 0n, count: 0, memo: null };
      entry.cents += leg.cents;
      entry.count += 1;
      totals.set(leg.role, entry);
    }
  const summaryLegs: EventLeg[] = ROLE_ORDER.flatMap((role) => {
    const entry = totals.get(role);
    if (!entry || entry.cents === 0n) return [];
    let memo = `${entry.count === 1 ? "1 line" : `${entry.count} lines`} in this payout`;
    if (role === "payouts.in-transit") {
      // A payout that carries the return of a failed one clears that payout's entry too.
      const cleared = amount - entry.cents;
      memo =
        cleared === 0n
          ? `Payout of ${formatMoney(amount)} to the bank`
          : `Payout of ${formatMoney(amount)} to the bank, less ${formatMoney(cleared)} that clears a failed payout`;
    }
    return [{ role, amount: formatMoney(entry.cents), memo }];
  });
  const total = summaryLegs.reduce((sum, leg) => sum + BigInt(leg.amount.replace(".", "")), 0n);
  if (total !== 0n) throw new Error(`Stripe payout ${payout.id} does not balance`);
  if (summaryLegs.length < 2)
    return { kind: "invalid", message: `Payout ${payout.id} has nothing to book.` };

  const hash = membersHash(
    payout.id,
    members.map((m) => m.transaction),
  );
  const accountKey = `${context.accountKeyBase}:${payout.currency.toLowerCase()}`;
  const summary: LedgerEvent = {
    kind: "event",
    provider: "stripe",
    accountKey,
    providerId: payout.id,
    rawIndex: 0,
    excerpt: JSON.stringify({
      id: payout.id,
      amount: Number(payout.amount),
      currency: payout.currency.toLowerCase(),
      created: payout.created,
      arrival_date: payout.arrivalDate,
      status: payout.status,
      automatic: payout.automatic,
      transactions: members.length,
    }),
    eventOn: arrival,
    summary: `Stripe payout ${payout.id}${members.length > 0 ? ` (${members.length} ${members.length === 1 ? "transaction" : "transactions"})` : ""}`,
    currency: payout.currency,
    amount: formatMoney(amount),
    legs: summaryLegs,
    links: { payout: payout.id, members: String(members.length), membersSha256: hash },
    // The posted journal says which transactions it stands for, and can be found by this identity.
    evidence: `stripe:payout:${payout.id}:members=${members.length}:sha256=${hash}`,
    sourceId: `stripe-payout-${payout.id}`,
  };

  const events = splits.flatMap(({ member, legs }) => {
    if (legs.length === 0) return [];
    const t = member.transaction;
    const event: LedgerEvent = {
      kind: "event",
      provider: "stripe",
      accountKey,
      providerId: t.id,
      rawIndex: member.rawIndex,
      excerpt: excerptOf(t),
      eventOn: arrival,
      summary: `Stripe ${labelOf(t)} ${primaryId(t)}`,
      currency: t.currency,
      amount: formatMoney(minorToCents(t.net, t.currency) ?? 0n),
      legs: toLegs(legs),
      links: linksOf(t, context.taxFor(t), payout.id),
      coveredBy: payout.id,
    };
    return [{ page: member.page, event }];
  });

  return {
    kind: "summary",
    payout: summary,
    members: events,
    counts: { members: members.length, taxNotReported, refundTaxNotSplit, adjustments },
    diagnostics,
    membersSha256: hash,
  };
}

export type { TaxResolution };

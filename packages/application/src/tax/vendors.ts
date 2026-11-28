/** 1099 vendor totals: what each vendor was paid in a calendar year, from the accounts a person marked
 * 1099-reportable, split into what counts toward the IRS threshold and what the rules leave out.
 *
 * What counts. A payment is the part of a journal, dated in the range, that is on marked accounts. Who
 * it went to comes from the Inbox line that booked it (its counterparty, then its description); a
 * journal with no Inbox line (an entry typed by hand) is matched on its narration. Where the money came
 * from comes from the other side of the journal:
 *
 *  - every other leg is on a bank account (an asset tagged as cash, or any asset when the book tags no
 *    cash account at all): it counts, unless the vendor is recorded as paid by card or payment app;
 *  - every other leg is on a liability account (a card, or anything owed): it is a card payment, which
 *    the IRS says the payment settlement entity reports on Form 1099-K, so it is left out;
 *  - anything else (owner money, another asset, a move between expense accounts, a mix of bank and
 *    card): left out and said why, because a total that guessed would be worse than one that says it
 *    cannot tell.
 *
 * A bank payment may still have been made by debit card or through a payment app, which a bank line
 * does not say. The vendor's `paidBy` records what the person knows; until it says so, the vendor is
 * flagged as unconfirmed. Nothing here files a form or gives tax advice.
 *
 * Pure and portable: a function of the book, the tags, the vendors and the Inbox's payees. */
import { hashCanonical, type BookState } from "@rastrata/kernel";

import type { AccountTagMap } from "../account-tags.ts";
import { type ChartAccount, compareCodes, isProfitLossRole } from "../reports/chart.ts";
import { reportContext, resolveRange } from "../reports/columns.ts";
import { postingCents } from "../reports/ledger.ts";
import { groupKey, matchVendor, payeeKey, payeeText } from "./payees.ts";

export const VENDOR_REPORTING = ["yes", "no", "undecided"] as const;
export type VendorReporting = (typeof VENDOR_REPORTING)[number];
export const EXEMPT_REASONS = [
  "corporation",
  "employee",
  "personal",
  "merchandise",
  "exempt_organization",
  "card_or_network",
  "other",
] as const;
export type ExemptReason = (typeof EXEMPT_REASONS)[number];
export const W9_STATES = ["not_requested", "requested", "received"] as const;
export type W9State = (typeof W9_STATES)[number];
/** The boxes of line 3a of Form W-9 (Rev. March 2024); the LLC box carries a C, S or P. */
export const CLASSIFICATIONS = [
  "individual",
  "c_corporation",
  "s_corporation",
  "partnership",
  "trust_estate",
  "llc_c",
  "llc_s",
  "llc_p",
  "other",
] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
export const PAID_BY = ["unknown", "bank", "card_or_network"] as const;
export type PaidBy = (typeof PAID_BY)[number];
/** Whether a contractor's TIN is on file (Act 2 e-filing seam; Rastrata stores zero raw TINs in Act 1). */
export const TIN_STATUSES = ["not_collected", "on_file", "verified"] as const;
export type TinStatus = (typeof TIN_STATUSES)[number];

export interface VendorAddress {
  readonly line1?: string;
  readonly line2?: string;
  readonly city?: string;
  readonly state?: string;
  readonly postalCode?: string;
}

/** One vendor as it stands: the newest version of what was recorded about it. */
export interface Vendor {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  /** Plain words, lower case, single-spaced: what a bank line's text is matched against. */
  readonly payeeKeys: readonly string[];
  readonly reporting: VendorReporting;
  readonly reason: ExemptReason | null;
  readonly w9: W9State;
  readonly w9On: string | null;
  readonly classification: Classification | null;
  readonly paidBy: PaidBy;
  readonly notes: string;
  /** Optional legal name from Form W-9 when different from the DBA/display name. */
  readonly legalName?: string | null;
  /** Optional mailing address for 1099-NEC filing. */
  readonly address?: VendorAddress | null;
  /** Optional contractor email for 1099 delivery or W-9 collection. */
  readonly email?: string | null;
  /** TIN collection status (Act 2 seam; never stores a raw SSN or EIN). */
  readonly tinStatus?: TinStatus;
  readonly recordedAt: string;
  readonly principal: string;
}

/** What the Inbox knows of the line that booked a journal. */
export interface PayeeSource {
  readonly counterparty: string;
  readonly description: string;
}

export interface VendorInputs {
  readonly state: BookState;
  readonly tags: AccountTagMap;
  readonly from: string;
  readonly to: string;
  /** Accounts whose payments are counted (accounts the person marked reportable). */
  readonly reportable: ReadonlySet<string>;
  readonly vendors: readonly Vendor[];
  /** The Inbox line behind a journal, by journal id. */
  readonly payees: ReadonlyMap<string, PayeeSource>;
  /** In cents. */
  readonly threshold: bigint;
}

export type PaidFrom = "bank" | "card" | "mixed" | "owner" | "other_asset" | "reclass";

export type PaymentReason =
  | "counted"
  | "card"
  | "vendor_card_or_network"
  | "owner"
  | "other_asset"
  | "reclass"
  | "mixed";

/** One payment: the part of one journal that is on marked accounts. */
export interface Payment {
  readonly date: string;
  readonly journalId: string;
  readonly narration: string;
  /** Ledger-signed on the marked accounts: a payment is positive, a refund from the vendor negative. */
  readonly cents: bigint;
  /** The marked accounts it is on. */
  readonly accounts: readonly ChartAccount[];
  readonly paidFrom: PaidFrom;
  /** Where the payee text came from: the Inbox line's counterparty or description, or the entry's own
   * narration. */
  readonly payeeFrom: "counterparty" | "description" | "narration";
  readonly payee: string;
  /** The vendor it belongs to, or why it belongs to none. */
  readonly vendorId: string | null;
  readonly unmatched: "none" | "ambiguous";
  /** What the rules do with it. */
  readonly counts: boolean;
  readonly reason: PaymentReason;
}

export interface Tally {
  readonly payments: number;
  /** Payments from bank accounts that count toward the threshold. */
  readonly counted: bigint;
  /** Paid by card, or by a vendor recorded as paid by card or payment app. */
  readonly card: bigint;
  /** Owner money, another asset, a reclassification or a mixed payment: left out, and listed. */
  readonly other: bigint;
}

export type Attention = "undecided" | "w9_missing" | "method_unconfirmed";

export interface VendorTotal extends Tally {
  readonly vendor: Vendor;
  readonly meetsThreshold: boolean;
  readonly attention: readonly Attention[];
}

export interface PayeeTotal extends Tally {
  readonly payee: string;
  readonly ambiguous: boolean;
  readonly firstOn: string;
  readonly lastOn: string;
}

export interface VendorTotals {
  readonly from: string;
  readonly to: string;
  readonly vendors: readonly VendorTotal[];
  readonly payees: readonly PayeeTotal[];
  readonly payments: readonly Payment[];
  readonly totals: Tally;
  readonly markedAccounts: readonly ChartAccount[];
  /** True when no asset account is tagged as cash, so every asset is read as a bank account. */
  readonly noCashTags: boolean;
  /** A hash of what the Inbox contributed, so a population changes when an attribution does. */
  readonly payeesHash: string;
}

interface Mutable {
  payments: number;
  counted: bigint;
  card: bigint;
  other: bigint;
}
const empty = (): Mutable => ({ payments: 0, counted: 0n, card: 0n, other: 0n });

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const compareDescending = (a: bigint, b: bigint) => (b > a ? 1 : b < a ? -1 : 0);

/** The kind of account a leg is on, for judging how a payment was made. */
function legKind(
  account: ChartAccount,
  date: string,
  tags: AccountTagMap,
  noCashTags: boolean,
): PaidFrom {
  if (account.role === "asset")
    return noCashTags || tags.tagsFor(account.id, date).cashFlowClass === "cash"
      ? "bank"
      : "other_asset";
  if (account.role === "liability") return "card";
  if (account.role === "equity") return "owner";
  return "reclass";
}

export function compileVendorTotals(input: VendorInputs): VendorTotals {
  const { state, tags, from, to } = input;
  const context = reportContext(state, to);
  resolveRange(context, to, from);
  const accounts = new Map(context.accounts.map((account) => [account.id, account]));
  const noCashTags = !context.accounts.some(
    (account) => account.role === "asset" && tags.tagsFor(account.id, to).cashFlowClass === "cash",
  );
  const marked = context.accounts
    .filter((account) => input.reportable.has(account.id) && isProfitLossRole(account.role))
    .sort((a, b) => compareCodes(a.code, b.code));
  const markedIds = new Set(marked.map((account) => account.id));
  const keyed = input.vendors.map((vendor) => ({ id: vendor.id, keys: vendor.payeeKeys }));
  const byId = new Map(input.vendors.map((vendor) => [vendor.id, vendor]));
  const payments: Payment[] = [];
  const used: [string, string][] = [];

  for (const booked of context.view.included(to).journals) {
    const date = booked.journal.accountingDate as string;
    if (date < from) continue;
    let cents = 0n;
    const onMarked: ChartAccount[] = [];
    const legs: { account: ChartAccount; cents: bigint }[] = [];
    for (const posting of booked.journal.postings) {
      const account = accounts.get(posting.accountId as string);
      if (!account) throw new Error("Journal references an unknown account");
      const amount = postingCents(posting);
      if (markedIds.has(account.id)) {
        cents += amount;
        if (!onMarked.includes(account)) onMarked.push(account);
      } else legs.push({ account, cents: amount });
    }
    if (onMarked.length === 0 || cents === 0n) continue;
    // A payment is a debit on a marked account, paid from the credits beside it. A refund from the
    // vendor is the other way round, and went to the debits beside it.
    const sides = new Set<PaidFrom>();
    for (const leg of legs)
      if (cents > 0n ? leg.cents < 0n : leg.cents > 0n)
        sides.add(legKind(leg.account, date, tags, noCashTags));
    let paidFrom: PaidFrom;
    if (sides.size === 0) paidFrom = "reclass";
    else if (sides.size > 1) paidFrom = "mixed";
    else paidFrom = [...sides][0] as PaidFrom;

    const journalId = booked.journal.id as string;
    const source = input.payees.get(journalId);
    const candidates: { text: string; from: Payment["payeeFrom"] }[] = [];
    if (source) {
      if (payeeKey(source.counterparty) !== "")
        candidates.push({ text: source.counterparty, from: "counterparty" });
      if (payeeKey(source.description) !== "")
        candidates.push({ text: source.description, from: "description" });
    }
    if (candidates.length === 0)
      candidates.push({ text: booked.journal.narration, from: "narration" });
    const found = matchVendor(
      candidates.map((candidate) => candidate.text),
      keyed,
    );
    const shown = candidates[0] as (typeof candidates)[number];
    const vendor = found.kind === "vendor" ? byId.get(found.vendorId) : undefined;
    let reason: PaymentReason;
    if (vendor?.paidBy === "card_or_network") reason = "vendor_card_or_network";
    else if (paidFrom === "bank") reason = "counted";
    else if (paidFrom === "card") reason = "card";
    else if (paidFrom === "owner") reason = "owner";
    else if (paidFrom === "other_asset") reason = "other_asset";
    else if (paidFrom === "reclass") reason = "reclass";
    else reason = "mixed";
    const payee = payeeText(shown.text);
    used.push([journalId, payee]);
    payments.push({
      date,
      journalId,
      narration: booked.journal.narration,
      cents,
      accounts: onMarked.sort((a, b) => compareCodes(a.code, b.code)),
      paidFrom,
      payeeFrom: shown.from,
      payee,
      vendorId: vendor?.id ?? null,
      unmatched: found.kind === "ambiguous" ? "ambiguous" : "none",
      counts: reason === "counted",
      reason,
    });
  }

  const add = (tally: Mutable, payment: Payment) => {
    tally.payments += 1;
    if (payment.counts) tally.counted += payment.cents;
    else if (payment.reason === "card" || payment.reason === "vendor_card_or_network")
      tally.card += payment.cents;
    else tally.other += payment.cents;
  };
  const perVendor = new Map<string, Mutable>();
  const perPayee = new Map<
    string,
    { tally: Mutable; payee: string; ambiguous: boolean; first: string; last: string }
  >();
  const totals = empty();
  for (const payment of payments) {
    add(totals, payment);
    if (payment.vendorId !== null) {
      const tally = perVendor.get(payment.vendorId) ?? empty();
      perVendor.set(payment.vendorId, tally);
      add(tally, payment);
      continue;
    }
    const key = groupKey(payment.payee) || payment.payee;
    const group = perPayee.get(key) ?? {
      tally: empty(),
      payee: payment.payee,
      ambiguous: false,
      first: payment.date,
      last: payment.date,
    };
    perPayee.set(key, group);
    add(group.tally, payment);
    if (payment.unmatched === "ambiguous") group.ambiguous = true;
    if (payment.date < group.first) group.first = payment.date;
    if (payment.date > group.last) group.last = payment.date;
  }

  const vendors: VendorTotal[] = input.vendors
    .map((vendor): VendorTotal => {
      const tally = perVendor.get(vendor.id) ?? empty();
      const meetsThreshold = tally.counted >= input.threshold;
      const attention: Attention[] = [];
      if (vendor.reporting !== "no" && meetsThreshold) {
        if (vendor.reporting === "undecided") attention.push("undecided");
        if (vendor.w9 !== "received") attention.push("w9_missing");
        if (vendor.paidBy === "unknown") attention.push("method_unconfirmed");
      }
      return { vendor, ...tally, meetsThreshold, attention };
    })
    .sort(
      (a, b) =>
        compareDescending(a.counted, b.counted) ||
        compareText(a.vendor.name.toLowerCase(), b.vendor.name.toLowerCase()) ||
        compareText(a.vendor.id, b.vendor.id),
    );
  const sum = (tally: Tally) => tally.counted + tally.card + tally.other;
  const payees: PayeeTotal[] = [...perPayee.values()]
    .map((group) => ({
      payee: group.payee,
      ambiguous: group.ambiguous,
      firstOn: group.first,
      lastOn: group.last,
      ...group.tally,
    }))
    .sort((a, b) => compareDescending(sum(a), sum(b)) || compareText(a.payee, b.payee));
  return {
    from,
    to,
    vendors,
    payees,
    payments,
    totals,
    markedAccounts: marked,
    noCashTags,
    payeesHash: hashCanonical({
      type: "TaxPayees",
      payees: used.sort(([a], [b]) => compareText(a, b)),
    }).digest,
  };
}

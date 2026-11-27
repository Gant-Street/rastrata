import type {
  IngestItem,
  Proposal,
  ProposalContext,
  ProposedLeg,
  Proposer,
} from "../../ingest-types.ts";
import { absMoney, formatMoney, negateMoney, parseMoney } from "../../money.ts";
import { addDays } from "../../stripe/dates.ts";
import { ROLE_LABELS, type StripeRole, isStripeRole } from "../../stripe/roles.ts";
import { readAccountTags } from "../../account-tags.ts";
import { type ProposerRegistration, registerProposer } from "../ingest/proposers.ts";
import { countsByStatus } from "../ingest/read.ts";
import { tagsRevision } from "./chart.ts";
import {
  type DepositFact,
  type MatchingPlan,
  matchWindow,
  planForBook,
  planMatching,
} from "./matching.ts";
import {
  type RoleKeyOf,
  type RoleResolution,
  type StripeSettings,
  accountOf,
  isReady,
  parseSettings,
  resolveRoles,
} from "./settings.ts";
import { type PayoutRow, stripeStore } from "./store.ts";

/** The Stripe proposer, registered with the Inbox's proposer registry. It suggests; nothing it
 * returns is posted. It does two jobs:
 *
 *  1. For a Stripe payout (the one entry that books it, aggregated from the transactions Stripe says
 *     it paid out) it proposes the complete entry with the owner's accounts filled in. The
 *     transactions themselves are covered evidence: the Inbox never offers them to this proposer.
 *  2. For a bank deposit it looks for the Stripe payout with exactly that amount near its arrival
 *     date and proposes the entry that clears payouts in transit. Equal payouts are the normal case
 *     (a business whose charges cost the same gets payouts that net the same, daily), so every payout
 *     and every deposit of an amount are paired together, one to one, the closest dates first (see
 *     `planMatching`), and the proposal names the payout its deposit is paired with and says how the
 *     equal ones around it were paired. A pairing with a doubt (another deposit or payout of the
 *     amount is just as close and has nothing of its own) is still made, at a low confidence. */

export const STRIPE_PROPOSER = "stripe";

/** The version of the rule that pairs deposits with payouts, so a change to it makes the Inbox suggest
 * again for the deposits still open instead of leaving suggestions made the old way on screen. */
const MATCHING = 2;

/** Confidence is an ordering and a threshold, never money. */
export const CONFIDENCE = {
  event: 1,
  payoutSameDay: 0.97,
  payoutNearDay: 0.9,
  payoutUnreconciled: 0.7,
  payoutContested: 0.6,
} as const;

const label = (role: string): string => (isStripeRole(role) ? ROLE_LABELS[role] : role);

/** The Inbox shows at most eight reasons of at most 300 characters each; a longer one would make the
 * whole item unreadable on the wire, so reasons are bounded here, never left to chance. */
const MAX_REASONS = 8;
const MAX_REASON_LENGTH = 300;
export function boundedReasons(reasons: readonly string[]): string[] {
  return reasons
    .filter((r) => r.trim().length > 0)
    .slice(0, MAX_REASONS)
    .map((r) => (r.length > MAX_REASON_LENGTH ? `${r.slice(0, MAX_REASON_LENGTH - 1)}…` : r));
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function proposeEvent(item: IngestItem, roles: readonly RoleResolution[]): readonly Proposal[] {
  const line = item.line;
  // Only a payout's own entry is proposed. A line that is not one (it cannot reach here covered)
  // is never offered as an entry of its own: that would book it twice.
  if (line.kind !== "event" || line.links?.payout !== line.providerId) return [];
  const merged = new Map<string, bigint>();
  for (const leg of line.legs) {
    const accountId = isStripeRole(leg.role) ? accountOf(roles, leg.role) : null;
    if (!accountId) return [];
    merged.set(accountId, (merged.get(accountId) ?? 0n) + parseMoney(leg.amount));
  }
  const legs: ProposedLeg[] = [...merged]
    .filter(([, cents]) => cents !== 0n)
    .map(([accountId, cents]) => ({ accountId, amount: formatMoney(cents) }));
  if (legs.length < 2 || legs.reduce((sum, leg) => sum + parseMoney(leg.amount), 0n) !== 0n)
    return [];
  const members = line.links?.members ? Number(line.links.members) : null;
  const reasons = [
    `One entry for Stripe payout ${line.providerId}${members ? `: the ${plural(members, "transaction", "transactions")} Stripe says it paid out, added up` : ""}. Their figures are Stripe's own and nothing is estimated; the transactions are listed with it as evidence.`,
    ...line.legs.map((leg) => {
      const cents = parseMoney(leg.amount);
      return `${label(leg.role)}: ${cents < 0n ? "credit" : "debit"} ${absMoney(leg.amount)}${leg.memo ? ` (${leg.memo})` : ""}`;
    }),
  ];
  return [
    {
      proposer: STRIPE_PROPOSER,
      kind: "event",
      confidence: CONFIDENCE.event,
      reasons: boundedReasons(reasons),
      legs,
      narration: line.summary,
      ...(line.links ? { links: line.links } : {}),
    },
  ];
}

/** What the deposit's proposal says about the payout it clears, and how sure it may be. A deposit
 * clears payouts in transit whenever its payout is (or will be) booked as an entry; when the payout
 * cannot be booked, the match may still be right but a person must look first. */
function reconciliationReason(payout: PayoutRow): { text: string; cap: number } {
  if (payout.booking === "summarised")
    return {
      text: `Stripe lists ${plural(payout.memberCount ?? 0, "transaction", "transactions")} in this payout and they add up to the payout amount to the cent.`,
      cap: 1,
    };
  if (payout.booking === "waiting")
    return {
      text: "Stripe has not finished itemising this payout, so its entry is not made yet. It is made on a later sync; this deposit's entry does not depend on it.",
      cap: 1,
    };
  if (payout.booking === "mismatch")
    return {
      text: "Stripe's own transactions for this payout do not add up to its amount, so its entry is not made. Check the payout in Stripe before accepting.",
      cap: CONFIDENCE.payoutUnreconciled,
    };
  return {
    text: "This payout's entry could not be made from what Stripe lists for it. Check the payout in Stripe before accepting.",
    cap: CONFIDENCE.payoutUnreconciled,
  };
}

/** The pairing for one deposit worked out from the deposits near it alone, for a caller that has no
 * view of the whole book (a unit test, an agent's what-if). The book's own proposals use the pairing
 * of the whole book, which is the same rule over every deposit. */
function localPlan(
  item: IngestItem,
  context: ProposalContext,
  settings: StripeSettings,
  payouts: readonly PayoutRow[],
): MatchingPlan {
  const line = item.line;
  if (line.kind !== "bankLine") return planMatching(payouts, [], settings.matchWindowDays);
  const window = settings.matchWindowDays;
  const cents = parseMoney(line.amount);
  const currency = line.currency.toUpperCase();
  const nearby =
    context.nearby?.({
      amount: line.amount,
      from: addDays(line.postedOn, -2 * window),
      to: addDays(line.postedOn, 2 * window),
      kind: "bankLine",
      limit: 200,
    }) ?? [];
  const everyone = nearby.some((n) => n.id === item.id) ? nearby : [...nearby, item];
  const facts: DepositFact[] = [];
  for (const n of everyone) {
    if (
      n.line.kind !== "bankLine" ||
      n.line.provider === "stripe" ||
      n.status === "excluded" ||
      n.line.currency.toUpperCase() !== currency ||
      parseMoney(n.line.amount) !== cents
    )
      continue;
    facts.push({
      id: n.id,
      date: n.line.postedOn,
      cents,
      currency,
      // Already accepted: it has a payout of its own, whichever one.
      settled: n.status === "drafted" || n.status === "posted",
      link: null,
    });
  }
  return planMatching(payouts, facts, window);
}

function proposeDeposit(
  item: IngestItem,
  context: ProposalContext,
  settings: StripeSettings,
  roles: readonly RoleResolution[],
  payouts: readonly PayoutRow[],
  plan: (() => MatchingPlan) | undefined,
): readonly Proposal[] {
  const line = item.line;
  if (line.kind !== "bankLine" || line.provider === "stripe") return [];
  const cents = parseMoney(line.amount);
  const bankAccountId = item.ledgerAccountId;
  const transitId = accountOf(roles, "payouts.in-transit");
  if (cents <= 0n || !bankAccountId || !transitId) return [];
  const bank = context.accounts.find((a) => a.id === bankAccountId);
  if (!bank || (bank.closedOn !== null && bank.closedOn <= line.postedOn)) return [];
  // The pairing of the whole book when the line is in it, else of the lines near it.
  const book = plan?.();
  const pairing = (
    book?.known.has(item.id) ? book : localPlan(item, context, settings, payouts)
  ).forDeposit.get(item.id);
  // No payout of exactly this amount is near it (or every one that is has a deposit of its own):
  // nothing to suggest, and a person categorises it.
  if (!pairing) return [];
  const legs: ProposedLeg[] = [
    { accountId: bankAccountId, amount: formatMoney(cents) },
    { accountId: transitId, amount: negateMoney(formatMoney(cents)) },
  ];
  const payout = payouts.find((p) => p.id === pairing.payout);
  const checked = payout ? reconciliationReason(payout) : null;
  const base = pairing.contested
    ? CONFIDENCE.payoutContested
    : pairing.tier === "exact"
      ? CONFIDENCE.payoutSameDay
      : CONFIDENCE.payoutNearDay;
  return [
    {
      proposer: STRIPE_PROPOSER,
      kind: "categorize",
      confidence: Math.min(base, checked?.cap ?? 1),
      reasons: boundedReasons([...pairing.reasons, ...(checked ? [checked.text] : [])]),
      legs,
      narration: `Stripe payout ${pairing.payout} deposited`,
      links: { payout: pairing.payout },
    },
  ];
}

/** Pure: the proposals for one item given the owner's settings and the known payouts. The accounts
 * each Stripe role uses are those in force on the date the entry would carry: the day a payout
 * arrives, the day a deposit posts. */
export function proposeStripe(
  item: IngestItem,
  context: ProposalContext,
  settings: StripeSettings | null,
  payouts: readonly PayoutRow[],
  roleKeyOf: RoleKeyOf,
  plan?: () => MatchingPlan,
): readonly Proposal[] {
  if (!settings) return [];
  const line = item.line;
  const asOf = line.kind === "event" ? line.eventOn : line.postedOn;
  const roles = resolveRoles(
    settings,
    context.accounts.map((a) => ({ id: a.id, code: a.code, role: a.role, closedOn: a.closedOn })),
    roleKeyOf,
    asOf,
  );
  if (!isReady(roles)) return [];
  if (line.kind === "event") return line.provider === "stripe" ? proposeEvent(item, roles) : [];
  return proposeDeposit(item, context, settings, roles, payouts, plan);
}

/** A short, cheap, stable string of a settings body, for the registry's revision. */
function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export const stripeProposer: ProposerRegistration = {
  name: STRIPE_PROPOSER,
  create(service): Proposer {
    const store = stripeStore(service);
    const settings = parseSettings(store.settingsBody());
    const payouts = store.payouts();
    const tags = readAccountTags(service.store);
    const roleKeyOf: RoleKeyOf = (accountId, asOf) => tags.tagsFor(accountId, asOf).roleKey;
    // Every payout and every deposit of an amount are paired together, once per run, when the first
    // deposit asks (a run of payouts alone never pays for it).
    let book: MatchingPlan | null = null;
    const plan = (): MatchingPlan =>
      (book ??= planForBook(service, payouts, settings?.matchWindowDays ?? matchWindow(service)));
    return {
      name: STRIPE_PROPOSER,
      propose: (item, context) => proposeStripe(item, context, settings, payouts, roleKeyOf, plan),
    };
  },
  revision(service): string {
    const store = stripeStore(service);
    // Settings, payouts and the chart's role keys change what is proposed; so does a bank line
    // arriving, because a deposit that fitted two payouts may now have its twin and an ambiguity may
    // have gone.
    const lines = countsByStatus(service, {}).total;
    return `${fingerprint(store.settingsBody() ?? "")}.${store.payoutRevision()}.${lines}.t${tagsRevision(service)}.m${MATCHING}`;
  },
};

registerProposer(stripeProposer);

export type { StripeRole };

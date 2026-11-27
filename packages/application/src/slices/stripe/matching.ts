import { parseMoney } from "../../money.ts";
import type { ApplicationService } from "../../service.ts";
import {
  type DepositCandidate,
  type PayoutCandidate,
  type Pairing,
  matchPayouts,
} from "../../stripe/payout-match.ts";
import { readAccountTags } from "../../account-tags.ts";
import { ingestRuntime } from "../ingest/store.ts";
import { DEFAULT_MATCH_WINDOW_DAYS, parseSettings, type RoleKeyOf } from "./settings.ts";
import { type PayoutRow, stripeStore } from "./store.ts";

/** Which Stripe payout each bank deposit cleared, for the whole book at once.
 *
 * Matching one deposit at a time, against the deposits near it, cannot be right for the daily payouts
 * of a small business: two neighbours would each think they were the one a payout belonged to, and a
 * payout would be claimed twice or not at all. So the pairing is made once, for every payout and every
 * deposit of the same amount together (see `matchPayouts`), and each deposit's proposal and each
 * payout's state are read from that one pairing.
 *
 * What counts as a deposit is a bank line that came in and was not set aside. One that is still open
 * is paired and suggested. One that has been accepted (drafted or posted) with a suggestion that named
 * its payout stays paired with that payout, whatever would be chosen now: the person's choice is
 * history. One that was accepted so that it clears Payouts in transit, without naming a payout, is
 * paired like an open one and settles the payout it is paired with. A deposit that was booked
 * elsewhere (to Sales, to a transfer) is not a deposit Stripe made and takes no payout. */

/** A bank line of the amount a payout may have, as the pairing sees it. */
export interface DepositFact {
  readonly id: string;
  readonly date: string;
  readonly cents: bigint;
  readonly currency: string;
  /** Accepted and clearing Payouts in transit: it settles the payout it is paired with. */
  readonly settled: boolean;
  /** The payout the accepted suggestion named, when it named one. */
  readonly link: string | null;
}

export interface MatchingPlan {
  /** The pairing of each deposit that is still open and has a payout. */
  readonly forDeposit: ReadonlyMap<string, Pairing>;
  /** The payouts whose deposit has been accepted: matched. */
  readonly settled: ReadonlySet<string>;
  /** Every deposit this pairing was made over, so a caller can tell a line it knows from one it was
   * never shown (a line not in the Inbox is paired from the lines near it instead). */
  readonly known: ReadonlySet<string>;
}

/** A payout that has a deposit to expect and an entry to clear: not held for a person, not returned,
 * not canceled or failed. */
export const expectsDeposit = (payout: PayoutRow): boolean =>
  payout.booking !== "held" &&
  !payout.reversed &&
  payout.status !== "canceled" &&
  payout.status !== "failed";

export function planMatching(
  payouts: readonly PayoutRow[],
  deposits: readonly DepositFact[],
  windowDays: number,
): MatchingPlan {
  const settled = new Set<string>();
  // A deposit accepted with a named payout keeps it, and that payout is spoken for.
  const named = new Set<string>();
  const pool: DepositFact[] = [];
  for (const deposit of deposits) {
    if (deposit.settled && deposit.link !== null) {
      settled.add(deposit.link);
      named.add(deposit.id);
    } else pool.push(deposit);
  }
  const candidates: PayoutCandidate[] = payouts
    .filter((payout) => expectsDeposit(payout) && !settled.has(payout.id))
    .map((payout) => ({
      id: payout.id,
      amount: payout.amountCents,
      currency: payout.currency.toUpperCase(),
      arrivalOn: payout.arrivalOn,
    }));
  const open: DepositCandidate[] = pool.map((deposit) => ({
    ref: deposit.id,
    amount: deposit.cents,
    currency: deposit.currency.toUpperCase(),
    date: deposit.date,
  }));
  const result = matchPayouts(candidates, open, windowDays);
  const byId = new Map(pool.map((deposit) => [deposit.id, deposit]));
  const forDeposit = new Map<string, Pairing>();
  for (const pairing of result.pairs) {
    const deposit = byId.get(pairing.deposit);
    if (!deposit) continue;
    if (deposit.settled) settled.add(pairing.payout);
    else forDeposit.set(deposit.id, pairing);
  }
  return { forDeposit, settled, known: new Set(deposits.map((deposit) => deposit.id)) };
}

/** The deposits of the Inbox, as the pairing needs them: every bank line that came in and was not
 * set aside, with what the person decided about it, read in one query. `roleKeyOf` tells which
 * account is Payouts in transit. */
export function depositFacts(service: ApplicationService, roleKeyOf: RoleKeyOf): DepositFact[] {
  const rows = ingestRuntime(service)
    .store.query(
      `SELECT id, posted_on, amount, currency, status, decision FROM app_ingest_items
       WHERE kind = 'bankLine' AND provider <> 'stripe' AND status <> 'excluded'
         AND substr(amount, 1, 1) <> '-' AND amount <> '0.00'`,
    )
    .all() as {
    id: string;
    posted_on: string;
    amount: string;
    currency: string;
    status: string;
    decision: string | null;
  }[];
  const facts: DepositFact[] = [];
  for (const row of rows) {
    const cents = parseMoney(row.amount);
    const base = { id: row.id, date: row.posted_on, cents, currency: row.currency };
    if (row.status === "new" || row.status === "proposed") {
      facts.push({ ...base, settled: false, link: null });
      continue;
    }
    // Decided: it counts only when it is what clears Payouts in transit.
    type Decision = { kind?: unknown; links?: unknown; legs?: unknown };
    let decision: Decision | null = null;
    try {
      decision = row.decision ? (JSON.parse(row.decision) as Decision) : null;
    } catch {
      decision = null;
    }
    if (!decision) continue;
    const link = payoutLink(decision.links);
    const legs = Array.isArray(decision.legs) ? (decision.legs as { accountId?: unknown }[]) : [];
    const clears = legs.some(
      (leg) =>
        typeof leg.accountId === "string" &&
        roleKeyOf(leg.accountId, row.posted_on) === "payouts.in-transit",
    );
    if (decision.kind === "accept" && link !== null) facts.push({ ...base, settled: true, link });
    else if (clears) facts.push({ ...base, settled: true, link: null });
  }
  return facts;
}

function payoutLink(links: unknown): string | null {
  if (Array.isArray(links)) {
    for (const link of links as { key?: unknown; value?: unknown }[])
      if (link.key === "payout" && typeof link.value === "string") return link.value;
    return null;
  }
  if (links && typeof links === "object") {
    const value = (links as Record<string, unknown>).payout;
    return typeof value === "string" ? value : null;
  }
  return null;
}

/** The pairing for the whole book as it stands. */
export function planForBook(
  service: ApplicationService,
  payouts: readonly PayoutRow[],
  windowDays: number,
): MatchingPlan {
  const tags = readAccountTags(service.store);
  const roleKeyOf: RoleKeyOf = (accountId, asOf) => tags.tagsFor(accountId, asOf).roleKey;
  return planMatching(payouts, depositFacts(service, roleKeyOf), windowDays);
}

/** The window the owner chose, or the default before Stripe is set up. */
export function matchWindow(service: ApplicationService): number {
  return (
    parseSettings(stripeStore(service).settingsBody())?.matchWindowDays ?? DEFAULT_MATCH_WINDOW_DAYS
  );
}

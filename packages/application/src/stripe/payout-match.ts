import { formatMoney } from "../money.ts";
import { dayNumber } from "./dates.ts";

/** Matching Stripe payouts to bank deposits: exact amount, near the arrival date, one to one.
 *
 * Stripe pays out daily, and a small business has many payouts of exactly the same amount (most of
 * its charges cost the same, so most of its payouts net the same). Equal amounts on nearby days are
 * therefore the normal case, not a doubt, and the rule has to pair them rather than give up:
 *
 *  - A payout and a deposit of the same currency and exactly the same amount are candidates when
 *    their dates are within `windowDays` of each other. There is no tolerance on the amount.
 *  - Candidates are paired one to one: every payout and every deposit is used at most once, as many
 *    as possible are paired, and among the ways to pair as many, the one whose dates are closest
 *    overall (the sum of the days between each payout's arrival and its deposit) wins. So a run of
 *    daily payouts pairs day to day, and a steady lag pairs each payout with the deposit a day
 *    later, without anything being picked at random.
 *  - Ties are broken the same way every time, and the reason says so: when two pairings are equally
 *    close, the earlier payout takes the earlier deposit (payouts arrive in the order they are sent).
 *  - A pairing is *contested* when another payout or deposit of the same amount, with nothing of its
 *    own to pair with, is just as close: a deposit that is not Stripe's, or a payout whose deposit
 *    is missing, could be the one. The pairing is still made (the entry is the same whichever
 *    payout a deposit cleared) but it says so and its confidence is lower.
 *  - A payout with no deposit within the window is unmatched (not arrived yet, or booked elsewhere),
 *    and so is a deposit with no payout.
 *
 * Pure and deterministic: no clocks, no randomness, nothing read but the arguments, and the result
 * does not depend on the order the arguments arrive in. */

export interface PayoutCandidate {
  readonly id: string;
  /** Hundredths of the currency paid into the bank: positive. */
  readonly amount: bigint;
  readonly currency: string;
  /** The date the payout is expected to arrive, YYYY-MM-DD. */
  readonly arrivalOn: string;
}

export interface DepositCandidate {
  /** An opaque reference chosen by the caller (an inbox item, a posting). */
  readonly ref: string;
  readonly amount: bigint;
  readonly currency: string;
  readonly date: string;
}

export type MatchTier = "exact" | "near";

export interface Pairing {
  readonly payout: string;
  readonly deposit: string;
  /** `exact`: same date; `near`: within the window but not the same day. */
  readonly tier: MatchTier;
  /** Another payout or deposit of this amount with no partner of its own is just as close. */
  readonly contested: boolean;
  /** Why, in sentences a person can read: the match, how the equal ones around it were paired, and
   * the doubt when there is one. */
  readonly reasons: readonly string[];
  /** The same sentences as one text. */
  readonly reason: string;
}

export interface MatchResult {
  readonly pairs: readonly Pairing[];
  readonly unmatchedPayouts: readonly string[];
  readonly unmatchedDeposits: readonly string[];
}

/** The most cells of the pairing table spent on one run of nearby payouts and deposits. A run that
 * dense (about 1,500 payouts and as many deposits within a few days of each other, years of daily
 * payouts) is paired greedily, the closest first, and every pairing in it is contested. */
const TABLE_BUDGET = 2_500_000;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const days = (n: number): string => plural(n, "day", "days");

const sorted = <T>(items: readonly T[], key: (item: T) => string): T[] =>
  [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

/** Is there a value in `ascending` within `radius` of `center`? Binary search. */
function anyWithin(ascending: readonly number[], center: number, radius: number): boolean {
  let low = 0;
  let high = ascending.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((ascending[middle] as number) < center - radius) low = middle + 1;
    else high = middle;
  }
  const found = ascending[low];
  return found !== undefined && found <= center + radius;
}

/** How many of `ascending` are within `radius` of `center`, `center`'s own element included. */
function countWithin(ascending: readonly number[], center: number, radius: number): number {
  let low = 0;
  let high = ascending.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((ascending[middle] as number) < center - radius) low = middle + 1;
    else high = middle;
  }
  let end = low;
  while (end < ascending.length && (ascending[end] as number) <= center + radius) end++;
  return end - low;
}

/** Maximal runs of payouts and deposits where each is within the window of the one before, in date
 * order: nothing in one run can pair with anything in another, so each is paired on its own. */
function runs(
  payouts: readonly PayoutCandidate[],
  deposits: readonly DepositCandidate[],
  windowDays: number,
): { payouts: PayoutCandidate[]; deposits: DepositCandidate[] }[] {
  const timeline = [
    ...payouts.map((payout) => ({ at: dayNumber(payout.arrivalOn), payout })),
    ...deposits.map((deposit) => ({ at: dayNumber(deposit.date), deposit })),
  ].sort((a, b) => a.at - b.at);
  const out: { payouts: PayoutCandidate[]; deposits: DepositCandidate[] }[] = [];
  let current: { payouts: PayoutCandidate[]; deposits: DepositCandidate[] } | null = null;
  let last = Number.NEGATIVE_INFINITY;
  for (const entry of timeline) {
    if (current === null || entry.at - last > windowDays) {
      current = { payouts: [], deposits: [] };
      out.push(current);
    }
    last = entry.at;
    if ("payout" in entry) current.payouts.push(entry.payout);
    else current.deposits.push(entry.deposit);
  }
  return out;
}

/** The pairs of one run, as indexes into its sorted payouts and deposits. The most pairs; among those
 * the least total distance in days; among those, the earlier payout takes the earlier deposit. The
 * search is a table over the two sorted lists, which are never crossed: crossing two pairs never
 * makes the total distance shorter. */
function pair(
  payouts: readonly PayoutCandidate[],
  deposits: readonly DepositCandidate[],
  windowDays: number,
): { pairs: [number, number][]; greedy: boolean } {
  const n = payouts.length;
  const m = deposits.length;
  const at = payouts.map((payout) => dayNumber(payout.arrivalOn));
  const on = deposits.map((deposit) => dayNumber(deposit.date));
  if ((n + 1) * (m + 1) > TABLE_BUDGET)
    return { pairs: greedyPairs(at, on, windowDays), greedy: true };

  const width = m + 1;
  const count = new Int32Array((n + 1) * width);
  const cost = new Int32Array((n + 1) * width);
  /** 1: pair i with j, 2: leave payout i without one, 3: leave deposit j without one. */
  const choice = new Uint8Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const here = i * width + j;
      const gap = Math.abs((at[i] as number) - (on[j] as number));
      let bestCount = -1;
      let bestCost = 0;
      let bestChoice = 0;
      const consider = (nextCount: number, nextCost: number, which: number): void => {
        if (nextCount > bestCount || (nextCount === bestCount && nextCost < bestCost)) {
          bestCount = nextCount;
          bestCost = nextCost;
          bestChoice = which;
        }
      };
      // In this order, so that a tie keeps the earlier payout and the earlier deposit.
      if (gap <= windowDays)
        consider(
          (count[(i + 1) * width + j + 1] as number) + 1,
          (cost[(i + 1) * width + j + 1] as number) + gap,
          1,
        );
      consider(count[(i + 1) * width + j] as number, cost[(i + 1) * width + j] as number, 2);
      consider(count[here + 1] as number, cost[here + 1] as number, 3);
      count[here] = bestCount;
      cost[here] = bestCost;
      choice[here] = bestChoice;
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const which = choice[i * width + j];
    if (which === 1) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (which === 2) i++;
    else j++;
  }
  return { pairs, greedy: false };
}

/** The fallback for a run too dense for the table: the closest pairs first, the earlier payout and
 * the earlier deposit first among equals. */
function greedyPairs(
  at: readonly number[],
  on: readonly number[],
  windowDays: number,
): [number, number][] {
  const edges: [number, number, number][] = [];
  let low = 0;
  for (let i = 0; i < at.length; i++) {
    while (low < on.length && (on[low] as number) < (at[i] as number) - windowDays) low++;
    for (let j = low; j < on.length && (on[j] as number) <= (at[i] as number) + windowDays; j++)
      edges.push([Math.abs((at[i] as number) - (on[j] as number)), i, j]);
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const payoutUsed = new Set<number>();
  const depositUsed = new Set<number>();
  const pairs: [number, number][] = [];
  for (const [, i, j] of edges) {
    if (payoutUsed.has(i) || depositUsed.has(j)) continue;
    payoutUsed.add(i);
    depositUsed.add(j);
    pairs.push([i, j]);
  }
  return pairs.sort((a, b) => a[0] - b[0]);
}

export function matchPayouts(
  payouts: readonly PayoutCandidate[],
  deposits: readonly DepositCandidate[],
  windowDays: number,
): MatchResult {
  const pairs: Pairing[] = [];
  const unmatchedPayouts: string[] = [];
  const unmatchedDeposits: string[] = [];

  const buckets = new Map<string, { p: PayoutCandidate[]; d: DepositCandidate[] }>();
  const bucket = (currency: string, amount: bigint) => {
    const key = `${currency}|${amount}`;
    let found = buckets.get(key);
    if (!found) {
      found = { p: [], d: [] };
      buckets.set(key, found);
    }
    return found;
  };
  for (const payout of payouts) bucket(payout.currency, payout.amount).p.push(payout);
  for (const deposit of deposits) bucket(deposit.currency, deposit.amount).d.push(deposit);

  for (const key of [...buckets.keys()].sort()) {
    const { p, d } = buckets.get(key) as { p: PayoutCandidate[]; d: DepositCandidate[] };
    const sortedPayouts = sorted(p, (x) => `${x.arrivalOn}|${x.id}`);
    const sortedDeposits = sorted(d, (x) => `${x.date}|${x.ref}`);
    // The days of every payout and deposit of the amount, ascending, to say how crowded a date is.
    const payoutDays = sortedPayouts.map((x) => dayNumber(x.arrivalOn));
    const depositDays = sortedDeposits.map((x) => dayNumber(x.date));
    const amount = formatMoney(sortedPayouts[0]?.amount ?? sortedDeposits[0]?.amount ?? 0n);
    const currency = sortedPayouts[0]?.currency ?? sortedDeposits[0]?.currency ?? "";

    for (const run of runs(sortedPayouts, sortedDeposits, windowDays)) {
      const found = pair(run.payouts, run.deposits, windowDays);
      const takenPayouts = new Set(found.pairs.map(([i]) => i));
      const takenDeposits = new Set(found.pairs.map(([, j]) => j));
      const freePayoutDays = run.payouts
        .filter((_, i) => !takenPayouts.has(i))
        .map((x) => dayNumber(x.arrivalOn));
      const freeDepositDays = run.deposits
        .filter((_, j) => !takenDeposits.has(j))
        .map((x) => dayNumber(x.date));
      run.payouts.forEach((x, i) => {
        if (!takenPayouts.has(i)) unmatchedPayouts.push(x.id);
      });
      run.deposits.forEach((y, j) => {
        if (!takenDeposits.has(j)) unmatchedDeposits.push(y.ref);
      });

      for (const [i, j] of found.pairs) {
        const x = run.payouts[i] as PayoutCandidate;
        const y = run.deposits[j] as DepositCandidate;
        const arrival = dayNumber(x.arrivalOn);
        const date = dayNumber(y.date);
        const gap = Math.abs(arrival - date);
        const contested =
          found.greedy ||
          anyWithin(freeDepositDays, arrival, gap) ||
          anyWithin(freePayoutDays, date, gap);
        const nearPayouts = countWithin(payoutDays, arrival, windowDays);
        const nearDeposits = countWithin(depositDays, date, windowDays);
        const alone = nearPayouts === 1 && nearDeposits === 1;
        const how =
          gap === 0
            ? `Same amount and date as Stripe payout ${x.id}`
            : `Same amount as Stripe payout ${x.id}, ${days(gap)} from its arrival date`;
        const reasons = [
          alone
            ? `${how}; no other payout or deposit of ${amount} ${currency} is within ${days(windowDays)}.`
            : `${how}.`,
        ];
        if (!alone)
          reasons.push(
            `There are ${plural(nearPayouts, "payout", "payouts")} and ${plural(nearDeposits, "deposit", "deposits")} of ${amount} ${currency} within ${days(windowDays)}; they are paired one to one, the closest dates first, and when two are equally close the earlier payout takes the earlier deposit.`,
          );
        if (found.greedy)
          reasons.push(
            "There are too many payouts and deposits of this amount close together to weigh every pairing, so the closest were paired first.",
          );
        else if (contested)
          reasons.push(
            "Another payout or deposit of this amount with nothing of its own to pair with is just as close, so this is a choice between equals: check the bank line before accepting.",
          );
        pairs.push({
          payout: x.id,
          deposit: y.ref,
          tier: gap === 0 ? "exact" : "near",
          contested,
          reasons,
          reason: reasons.join(" "),
        });
      }
    }
  }

  return {
    pairs: sorted(pairs, (x) => `${x.payout}|${x.deposit}`),
    unmatchedPayouts: [...unmatchedPayouts].sort(),
    unmatchedDeposits: [...unmatchedDeposits].sort(),
  };
}

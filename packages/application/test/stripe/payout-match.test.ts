import { expect, test } from "bun:test";
import { addDays, daysBetween } from "../../src/stripe/dates.ts";
import {
  type DepositCandidate,
  type PayoutCandidate,
  matchPayouts,
} from "../../src/stripe/payout-match.ts";

const payout = (
  id: string,
  arrivalOn: string,
  amount = 1912n,
  currency = "USD",
): PayoutCandidate => ({
  id,
  arrivalOn,
  amount,
  currency,
});
const deposit = (
  ref: string,
  date: string,
  amount = 1912n,
  currency = "USD",
): DepositCandidate => ({
  ref,
  date,
  amount,
  currency,
});

const pairsOf = (result: ReturnType<typeof matchPayouts>) =>
  result.pairs.map((p) => [p.payout, p.deposit, p.tier] as const);

test("one payout and one deposit of exactly the same amount on the same day match", () => {
  const result = matchPayouts([payout("po_1", "2026-03-16")], [deposit("d1", "2026-03-16")], 2);
  expect(result.pairs).toHaveLength(1);
  expect(result.pairs[0]).toMatchObject({
    payout: "po_1",
    deposit: "d1",
    tier: "exact",
    contested: false,
  });
  expect(result.pairs[0]?.reason).toContain("Same amount and date as Stripe payout po_1");
  expect(result.pairs[0]?.reason).toContain(
    "no other payout or deposit of 19.12 USD is within 2 days",
  );
});

test("a deposit a day or two after the arrival date is a near match, with the reason in words", () => {
  const result = matchPayouts([payout("po_1", "2026-03-16")], [deposit("d1", "2026-03-18")], 2);
  expect(result.pairs[0]).toMatchObject({ tier: "near", contested: false });
  expect(result.pairs[0]?.reason).toContain("2 days from its arrival date");
});

test("a difference of one cent, another currency or a date outside the window is no match", () => {
  const cases: DepositCandidate[] = [
    deposit("cents", "2026-03-16", 1913n),
    deposit("euro", "2026-03-16", 1912n, "EUR"),
    deposit("late", "2026-03-20"),
  ];
  const result = matchPayouts([payout("po_1", "2026-03-16")], cases, 2);
  expect(result.pairs).toEqual([]);
  expect(result.unmatchedPayouts).toEqual(["po_1"]);
  expect(result.unmatchedDeposits).toEqual(["cents", "euro", "late"]);
});

test("equal payouts pair with their deposits one to one, the closest dates first", () => {
  // The two payouts net the same; the deposits arrive on the days the payouts did. Either pairing
  // fits the window, but one has every pair on its own day.
  const result = matchPayouts(
    [payout("po_1", "2026-03-16"), payout("po_2", "2026-03-17")],
    [deposit("d1", "2026-03-16"), deposit("d2", "2026-03-17")],
    2,
  );
  expect(pairsOf(result)).toEqual([
    ["po_1", "d1", "exact"],
    ["po_2", "d2", "exact"],
  ]);
  expect(result.pairs[0]?.reason).toContain("2 payouts and 2 deposits of 19.12 USD within 2 days");
  expect(result.pairs[0]?.reason).toContain("the earlier payout takes the earlier deposit");
  expect(result.pairs.every((p) => !p.contested)).toBe(true);
});

test("a steady bank lag pairs each payout with the deposit a day later", () => {
  const result = matchPayouts(
    [payout("po_1", "2026-03-16"), payout("po_2", "2026-03-17")],
    [deposit("d1", "2026-03-17"), deposit("d2", "2026-03-18")],
    2,
  );
  expect(pairsOf(result)).toEqual([
    ["po_1", "d1", "near"],
    ["po_2", "d2", "near"],
  ]);
});

test("a long run of equal daily payouts with a steady lag pairs exactly and quickly", () => {
  const payouts: PayoutCandidate[] = [];
  const deposits: DepositCandidate[] = [];
  for (let i = 0; i < 400; i++) {
    payouts.push(payout(`po_${String(i).padStart(3, "0")}`, addDays("2025-04-01", i)));
    deposits.push(deposit(`d_${String(i).padStart(3, "0")}`, addDays("2025-04-02", i)));
  }
  const started = performance.now();
  const result = matchPayouts(payouts, deposits, 2);
  expect(performance.now() - started).toBeLessThan(2000);
  expect(result.pairs).toHaveLength(400);
  expect(result.pairs.every((p) => p.payout.slice(3) === p.deposit.slice(2))).toBe(true);
  expect(result.pairs.every((p) => p.tier === "near")).toBe(true);
  expect(result.unmatchedPayouts).toEqual([]);
  expect(result.unmatchedDeposits).toEqual([]);
});

test("thirty-two equal payouts over sixty days, one deposit a day late: all paired one to one", () => {
  // A payout every other day for sixty-three days; every deposit lands on the arrival date but the
  // eleventh, which lands the day after.
  const payouts: PayoutCandidate[] = [];
  const deposits: DepositCandidate[] = [];
  for (let i = 0; i < 32; i++) {
    const arrival = addDays("2026-01-01", i * 2);
    payouts.push(payout(`po_${String(i).padStart(2, "0")}`, arrival));
    deposits.push(
      deposit(`d_${String(i).padStart(2, "0")}`, i === 10 ? addDays(arrival, 1) : arrival),
    );
  }
  const result = matchPayouts(payouts, deposits, 3);
  expect(result.pairs).toHaveLength(32);
  expect(result.unmatchedPayouts).toEqual([]);
  expect(result.unmatchedDeposits).toEqual([]);
  // Each deposit clears the payout with its own number, the late one a day from its arrival date.
  for (const pair of result.pairs) expect(pair.payout.slice(3)).toBe(pair.deposit.slice(2));
  const late = result.pairs.find((p) => p.payout === "po_10");
  expect(late).toMatchObject({ tier: "near", contested: false });
  expect(late?.reason).toContain("1 day from its arrival date");
  expect(result.pairs.filter((p) => p.tier === "exact")).toHaveLength(31);
  // Nothing about one pair is in doubt: no equal payout or deposit is left without a partner.
  expect(result.pairs.some((p) => p.contested)).toBe(false);
});

test("daily payouts with one deposit a day late: the late deposit and the next on-time one are interchangeable", () => {
  const payouts: PayoutCandidate[] = [];
  const deposits: DepositCandidate[] = [];
  for (let i = 0; i < 30; i++) {
    const arrival = addDays("2026-03-01", i);
    payouts.push(payout(`po_${String(i).padStart(2, "0")}`, arrival));
    deposits.push(
      deposit(`d_${String(i).padStart(2, "0")}`, i === 9 ? addDays(arrival, 1) : arrival),
    );
  }
  const result = matchPayouts(payouts, deposits, 2);
  expect(result.pairs).toHaveLength(30);
  // Two deposits land on the 11th, none on the 10th: the earlier payout takes the earlier deposit.
  expect(result.pairs.find((p) => p.payout === "po_09")).toMatchObject({
    deposit: "d_09",
    tier: "near",
  });
  expect(result.pairs.find((p) => p.payout === "po_10")).toMatchObject({
    deposit: "d_10",
    tier: "exact",
  });
  expect(result.pairs.filter((p) => p.tier === "near")).toHaveLength(1);
});

test("two payouts and one deposit: the closer payout takes it, and the pairing is not in doubt when the other is farther", () => {
  const result = matchPayouts(
    [payout("po_1", "2026-03-14"), payout("po_2", "2026-03-17")],
    [deposit("d1", "2026-03-17")],
    3,
  );
  expect(pairsOf(result)).toEqual([["po_2", "d1", "exact"]]);
  expect(result.unmatchedPayouts).toEqual(["po_1"]);
});

test("equally close payouts: the earlier payout takes the deposit, the pairing says it is a choice", () => {
  const result = matchPayouts(
    [payout("po_1", "2026-03-16"), payout("po_2", "2026-03-18")],
    [deposit("d1", "2026-03-17")],
    2,
  );
  expect(pairsOf(result)).toEqual([["po_1", "d1", "near"]]);
  expect(result.pairs[0]?.contested).toBe(true);
  expect(result.pairs[0]?.reason).toContain("choice between equals");
  expect(result.unmatchedPayouts).toEqual(["po_2"]);
});

test("one payout and two deposits: the closer deposit is used and the other is left, with nothing in doubt", () => {
  const result = matchPayouts(
    [payout("po_1", "2026-03-16")],
    [deposit("d1", "2026-03-16"), deposit("d2", "2026-03-18")],
    2,
  );
  expect(pairsOf(result)).toEqual([["po_1", "d1", "exact"]]);
  expect(result.pairs[0]?.contested).toBe(false);
  expect(result.unmatchedDeposits).toEqual(["d2"]);
});

test("one payout and two equally close deposits: the earlier deposit is used, and it is flagged as a choice", () => {
  const result = matchPayouts(
    [payout("po_1", "2026-03-17")],
    [deposit("d1", "2026-03-16"), deposit("d2", "2026-03-18")],
    2,
  );
  expect(pairsOf(result)).toEqual([["po_1", "d1", "near"]]);
  expect(result.pairs[0]?.contested).toBe(true);
});

test("deposits on the same day are interchangeable: the earlier reference is paired with the earlier payout", () => {
  const result = matchPayouts(
    [payout("po_1", "2026-03-16"), payout("po_2", "2026-03-16")],
    [deposit("d_b", "2026-03-16"), deposit("d_a", "2026-03-16")],
    2,
  );
  expect(pairsOf(result)).toEqual([
    ["po_1", "d_a", "exact"],
    ["po_2", "d_b", "exact"],
  ]);
  expect(result.pairs.some((p) => p.contested)).toBe(false);
});

test("a dense run is paired without searching forever, and says it was paired greedily", () => {
  // 1,600 payouts and deposits on two days: too many to weigh every pairing.
  const payouts = Array.from({ length: 1600 }, (_, i) =>
    payout(`po_${String(i).padStart(4, "0")}`, i < 800 ? "2026-03-16" : "2026-03-17"),
  );
  const deposits = Array.from({ length: 1600 }, (_, i) =>
    deposit(`d_${String(i).padStart(4, "0")}`, i < 800 ? "2026-03-16" : "2026-03-17"),
  );
  const started = performance.now();
  const result = matchPayouts(payouts, deposits, 3);
  expect(performance.now() - started).toBeLessThan(3000);
  expect(result.pairs).toHaveLength(1600);
  expect(result.pairs[0]?.reason).toContain("too many payouts and deposits");
  expect(result.pairs.every((p) => p.tier === "exact")).toBe(true);
});

test("different amounts never interfere with each other", () => {
  const result = matchPayouts(
    [payout("po_a", "2026-03-16", 1912n), payout("po_b", "2026-03-16", 9331n)],
    [
      deposit("d_a", "2026-03-16", 1912n),
      deposit("d_b", "2026-03-17", 9331n),
      deposit("d_c", "2026-03-16", 5000n),
    ],
    2,
  );
  expect(result.pairs.map((p) => [p.payout, p.deposit])).toEqual([
    ["po_a", "d_a"],
    ["po_b", "d_b"],
  ]);
  expect(result.unmatchedDeposits).toEqual(["d_c"]);
});

/** Every way to pair some payouts with some deposits, within the window, each used once: the best of
 * them as (pairs, total days apart), the most pairs and then the fewest days. An oracle that shares
 * nothing with the matcher. */
function best(
  payouts: readonly PayoutCandidate[],
  deposits: readonly DepositCandidate[],
  window: number,
): { count: number; cost: number } {
  let top = { count: 0, cost: 0 };
  const used = new Set<number>();
  const walk = (row: number, count: number, cost: number): void => {
    if (row === payouts.length) {
      if (count > top.count || (count === top.count && cost < top.cost)) top = { count, cost };
      return;
    }
    walk(row + 1, count, cost);
    deposits.forEach((candidate, column) => {
      const first = payouts[row] as PayoutCandidate;
      const gap = Math.abs(daysBetween(first.arrivalOn, candidate.date));
      if (used.has(column) || first.amount !== candidate.amount || gap > window) return;
      used.add(column);
      walk(row + 1, count + 1, cost + gap);
      used.delete(column);
    });
  };
  walk(0, 0, 0);
  return top;
}

test("the pairing is as large as it can be and as close as it can be (against every pairing, property)", () => {
  let seed = 424_242;
  const random = (limit: number): number => {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) & 0x7fffffff;
    return seed % limit;
  };
  for (let round = 0; round < 300; round++) {
    const payouts = Array.from({ length: random(6) }, (_, i) =>
      payout(`po_${i}`, addDays("2026-03-01", random(9)), random(5) === 0 ? 500n : 1912n),
    );
    const deposits = Array.from({ length: random(6) }, (_, i) =>
      deposit(`d_${i}`, addDays("2026-03-01", random(9)), random(5) === 0 ? 500n : 1912n),
    );
    const window = random(4);
    const result = matchPayouts(payouts, deposits, window);
    const byId = new Map(payouts.map((p) => [p.id, p]));
    const byRef = new Map(deposits.map((d) => [d.ref, d]));
    let cost = 0;
    for (const pair of result.pairs) {
      const p = byId.get(pair.payout) as PayoutCandidate;
      const d = byRef.get(pair.deposit) as DepositCandidate;
      expect(p.amount).toBe(d.amount);
      const gap = Math.abs(daysBetween(p.arrivalOn, d.date));
      expect(gap).toBeLessThanOrEqual(window);
      expect(pair.tier).toBe(gap === 0 ? "exact" : "near");
      cost += gap;
    }
    const oracle = best(payouts, deposits, window);
    expect(
      { count: result.pairs.length, cost },
      JSON.stringify({ payouts, deposits, window }, (_, v) =>
        typeof v === "bigint" ? String(v) : v,
      ),
    ).toEqual(oracle);
    // Each payout and each deposit is used once, or is left, never both.
    const usedPayouts = result.pairs.map((p) => p.payout);
    const usedDeposits = result.pairs.map((p) => p.deposit);
    expect(new Set(usedPayouts).size).toBe(usedPayouts.length);
    expect(new Set(usedDeposits).size).toBe(usedDeposits.length);
    expect([...usedPayouts, ...result.unmatchedPayouts].sort()).toEqual(
      payouts.map((p) => p.id).sort(),
    );
    expect([...usedDeposits, ...result.unmatchedDeposits].sort()).toEqual(
      deposits.map((d) => d.ref).sort(),
    );
  }
});

test("the result does not depend on the order the inputs arrive in (property)", () => {
  let seed = 7_654_321;
  const random = (limit: number): number => {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) & 0x7fffffff;
    return seed % limit;
  };
  const shuffle = <T>(items: readonly T[]): T[] => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = random(i + 1);
      [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
    }
    return copy;
  };
  for (let round = 0; round < 80; round++) {
    const amounts = [1912n, 1912n, 9331n, 500n];
    const payouts = Array.from({ length: random(12) }, (_, i) =>
      payout(
        `po_${i}`,
        addDays("2026-03-01", random(10)),
        amounts[random(amounts.length)] ?? 1912n,
      ),
    );
    const deposits = Array.from({ length: random(12) }, (_, i) =>
      deposit(
        `d_${i}`,
        addDays("2026-03-01", random(10)),
        amounts[random(amounts.length)] ?? 1912n,
      ),
    );
    const window = random(4);
    const first = matchPayouts(payouts, deposits, window);
    const second = matchPayouts(shuffle(payouts), shuffle(deposits), window);
    expect(second).toEqual(first);
  }
});

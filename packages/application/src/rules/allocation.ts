import { formatMoney, parseMoney } from "../money.ts";

/** Splitting one bank line across accounts, exact to the cent. Money is bigint cents throughout;
 * there is no floating point and no tolerance. The parts always add up to the line amount, or the
 * split is refused.
 *
 * Rules, in order:
 *  1. Fixed amounts are taken first, exactly.
 *  2. What remains is divided by percentage. Percentages are in hundredths of a percent
 *     ("33.33"), so 33.33 + 33.33 + 33.34 is a valid 100.00.
 *  3. If one allocation is marked `rest`, it takes exactly what is left after the fixed amounts
 *     and the (rounded-down) percentages. The cents lost to rounding land there, visibly.
 *  4. With no `rest`, percentages must total 100.00 and the cents lost to rounding go one each to
 *     the largest fractional remainders (largest remainder method), ties to the earlier
 *     allocation. */

export interface AllocationSpec {
  readonly accountId: string;
  /** Percent of what remains after fixed amounts, "0.01" to "100.00" (at most two decimals). */
  readonly percent?: string;
  /** A fixed amount, "12.00". */
  readonly amount?: string;
  /** Takes whatever is left. At most one per split. */
  readonly rest?: boolean;
}

export interface AllocationPart {
  readonly accountId: string;
  /** Positive cents. Zero-cent parts are omitted. */
  readonly cents: bigint;
}

export type AllocationResult =
  | { readonly ok: true; readonly parts: readonly AllocationPart[] }
  | { readonly ok: false; readonly reason: string };

const BASIS = 10000n;

/** "33.33" to hundredths of a percent (3333n), or null when it is not a percentage between 0.01
 * and 100.00 with at most two decimals. */
export function parsePercent(value: string): bigint | null {
  const dot = value.indexOf(".");
  const whole = dot < 0 ? value : value.slice(0, dot);
  const fraction = dot < 0 ? "" : value.slice(dot + 1);
  if (
    whole.length === 0 ||
    whole.length > 3 ||
    fraction.length > 2 ||
    (dot >= 0 && fraction === "")
  )
    return null;
  for (const digit of whole + fraction) if (digit < "0" || digit > "9") return null;
  const basis = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
  return basis >= 1n && basis <= BASIS ? basis : null;
}

/** Format hundredths of a percent as "33.33" (always two decimals). */
export function formatPercent(basis: bigint): string {
  return `${basis / 100n}.${(basis % 100n).toString().padStart(2, "0")}`;
}

/** Problems with a set of allocations that can be found without knowing the line amount. An empty
 * list means every line can be split, unless fixed amounts exceed it. */
export function checkAllocations(specs: readonly AllocationSpec[]): string[] {
  const problems: string[] = [];
  if (specs.length < 2) problems.push("A split needs at least two accounts");
  const accounts = new Set<string>();
  let rest = 0;
  let percentTotal = 0n;
  let percents = 0;
  let fixed = 0;
  for (const spec of specs) {
    if (accounts.has(spec.accountId)) problems.push("An account appears twice in the split");
    accounts.add(spec.accountId);
    const kinds =
      (spec.percent !== undefined ? 1 : 0) +
      (spec.amount !== undefined ? 1 : 0) +
      (spec.rest === true ? 1 : 0);
    if (kinds !== 1) {
      problems.push(
        "Each part of a split needs exactly one of a percentage, an amount or the rest",
      );
      continue;
    }
    if (spec.rest === true) rest++;
    if (spec.amount !== undefined) {
      fixed++;
      let cents: bigint | null = null;
      try {
        cents = parseMoney(spec.amount);
      } catch {
        cents = null;
      }
      if (cents === null || cents <= 0n)
        problems.push("A fixed amount must be a positive amount with two decimals");
    }
    if (spec.percent !== undefined) {
      percents++;
      const basis = parsePercent(spec.percent);
      if (basis === null) problems.push("A percentage must be from 0.01 to 100.00");
      else percentTotal += basis;
    }
  }
  if (rest > 1) problems.push("Only one part of a split can take the rest");
  if (percents > 0 && rest === 0 && percentTotal !== BASIS)
    problems.push(
      `The percentages add up to ${formatPercent(percentTotal)}; they must total 100.00, or one part must take the rest`,
    );
  if (percents > 0 && rest === 1 && percentTotal >= BASIS)
    problems.push("The percentages leave nothing for the part that takes the rest");
  if (percents === 0 && rest === 0 && fixed === 0)
    problems.push("A split needs at least two parts");
  return problems;
}

/** Split `total` (positive cents) by the specs. Refuses, with a reason, rather than guessing. */
export function allocate(total: bigint, specs: readonly AllocationSpec[]): AllocationResult {
  if (total <= 0n) return { ok: false, reason: "There is nothing to split" };
  const problems = checkAllocations(specs);
  if (problems.length > 0) return { ok: false, reason: problems[0] as string };
  let fixedTotal = 0n;
  for (const spec of specs) if (spec.amount !== undefined) fixedTotal += parseMoney(spec.amount);
  if (fixedTotal > total)
    return {
      ok: false,
      reason: `The fixed amounts (${formatMoney(fixedTotal)}) are more than the line (${formatMoney(total)})`,
    };
  const remaining = total - fixedTotal;
  const hasRest = specs.some((spec) => spec.rest === true);
  const hasPercent = specs.some((spec) => spec.percent !== undefined);
  if (!hasRest && !hasPercent && fixedTotal !== total)
    return {
      ok: false,
      reason: `The fixed amounts (${formatMoney(fixedTotal)}) do not add up to the line (${formatMoney(total)})`,
    };
  const cents = specs.map((spec) => (spec.amount !== undefined ? parseMoney(spec.amount) : 0n));
  const basis = specs.map((spec) =>
    spec.percent !== undefined ? (parsePercent(spec.percent) ?? 0n) : 0n,
  );
  const remainders = specs.map(() => 0n);
  let assigned = fixedTotal;
  for (const [index, points] of basis.entries()) {
    if (points === 0n) continue;
    const exact = remaining * points;
    cents[index] = exact / BASIS;
    remainders[index] = exact % BASIS;
    assigned += cents[index] as bigint;
  }
  const leftover = total - assigned;
  if (hasRest) {
    const index = specs.findIndex((spec) => spec.rest === true);
    cents[index] = (cents[index] as bigint) + leftover;
  } else if (leftover > 0n) {
    // Largest remainder: one cent each to the biggest fractional parts, earlier part first on ties.
    const order = [...basis.keys()]
      .filter((index) => (basis[index] as bigint) > 0n)
      .sort((a, b) => {
        const difference = (remainders[b] as bigint) - (remainders[a] as bigint);
        return difference > 0n ? 1 : difference < 0n ? -1 : a - b;
      });
    for (let step = 0n; step < leftover; step++) {
      const index = order[Number(step)] as number;
      cents[index] = (cents[index] as bigint) + 1n;
    }
  }
  const parts: AllocationPart[] = [];
  let sum = 0n;
  for (const [index, spec] of specs.entries()) {
    const amount = cents[index] as bigint;
    sum += amount;
    if (amount > 0n) parts.push({ accountId: spec.accountId, cents: amount });
  }
  // The invariant the whole split exists to keep.
  if (sum !== total) throw new Error("A split must add up to the line amount exactly");
  return { ok: true, parts };
}

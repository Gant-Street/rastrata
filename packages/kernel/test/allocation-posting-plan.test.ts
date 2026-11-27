import { expect, test } from "bun:test";
import {
  ExactDecimal as D, ExactRational as R, planAllocationPostings, localDate,
  hashCanonical, canonicalAccountingValue, ACCOUNTING_LIMITS, type RoundingMode,
} from "../src/index.ts";
import { quantizationPolicy } from "./fixtures.ts";

const zero = R.zero();
const modes: readonly RoundingMode[] = ["halfEven", "halfAwayFromZero", "towardZero", "floor", "ceiling"];
function input(weights = [1n, 1n, 1n], coefficient = 10000n, scale = 2n, roundingMode: RoundingMode = "halfEven") {
  const source = D.of(coefficient, scale);
  const total = weights.reduce((a, b) => a + b, 0n);
  return {
    exactSourceBasis: source.toRational(), exactResidualValue: zero, postedSourceBasis: source,
    quantizationPolicy: { ...quantizationPolicy, targetScale: scale, roundingMode },
    installments: weights.map((weight, i) => ({ ordinal: BigInt(i + 1),
      accountingDate: localDate(`2026-${String(i + 1).padStart(2, "0")}-01`),
      amount: source.toRational().multiply(R.of(weight, total)) })),
  };
}
function planned(value: Parameters<typeof planAllocationPostings>[0]) {
  const result = planAllocationPostings(value);
  if (result.disposition !== "planned") throw new Error(JSON.stringify(result.diagnostics));
  return result.plan;
}
// Independent nonnegative integer oracle; never calls the production quantizer.
function integerRound(n: bigint, d: bigint, mode: RoundingMode) {
  const q = n / d, r = n % d;
  if (mode === "floor" || mode === "towardZero" || r === 0n) return q;
  if (mode === "ceiling") return q + 1n;
  if (2n * r > d || (2n * r === d && (mode === "halfAwayFromZero" || q % 2n === 1n))) return q + 1n;
  return q;
}

test("prospective posting plan conserves cents and fixes ordinal amounts before recognition", () => {
  const plan = planned(input());
  expect(plan.installments.map((i) => i.postedAmount.coefficient)).toEqual([3333n, 3334n, 3333n]);
  expect(plan.installments.map((i) => i.exactToPostedDifference.toString())).toEqual(["1/300", "-1/150", "1/300"]);
  expect(plan.installments.map((i) => i.cumulativeTarget.toString())).toEqual(["100/3", "200/3", "100/1"]);
  for (const order of [[0, 1, 2], [2, 0, 1], [1, 2, 0]]) {
    expect(order.reduce((sum, i) => sum + plan.installments[i]!.postedAmount.coefficient, 0n)).toBe(10000n);
  }
  const { contentHash, ...body } = plan;
  expect(contentHash).toEqual(hashCanonical({ type: "AllocationPostingPlan", value: canonicalAccountingValue(body) }));
  const request = input();
  const captured = planned(request);
  request.installments.reverse();
  request.quantizationPolicy.targetScale = 0n;
  expect(captured).toEqual(plan);
  expect(Object.isFrozen(captured.quantizationPolicy)).toBeTrue();
  expect(Object.isFrozen(captured.installments)).toBeTrue();
  expect(Object.isFrozen(captured.installments[0])).toBeTrue();
});

test("prospective successor distributes authenticated posted carrying basis, not the old exact total", () => {
  const request = input([1n, 1n], 6667n);
  const result = planned({ ...request, exactSourceBasis: R.of(200n, 3n), exactResidualValue: R.of(10n, 1n),
    installments: request.installments.map((i) => ({ ...i, amount: R.of(85n, 3n) })) });
  expect(result.installments.map((i) => i.postedAmount.coefficient)).toEqual([2834n, 2833n]);
  expect(result.installments.reduce((s, i) => s + i.postedAmount.coefficient, 0n)).toBe(5667n);
  expect(result.residualQuantization.amount.coefficient).toBe(1000n);
  expect(result.installments.reduce((s, i) => s.add(i.exactToPostedDifference), zero).toString()).toBe("-1/300");
  // A coarse policy rounds the residual explicitly; it does not round each row.
  const coarse = input([1n], 1n, 0n);
  const coarsePlan = planned({ ...coarse, exactResidualValue: R.of(1n, 2n),
    installments: [{ ...coarse.installments[0]!, amount: R.of(1n, 2n) }] });
  expect(coarsePlan.residualQuantization.residual.toString()).toBe("1/2");
  expect(coarsePlan.installments[0]!.postedAmount.coefficient).toBe(1n);
});

test("cumulative targets agree with an independent integer oracle across weights, modes and scales", () => {
  for (const [mode, expected] of [
    ["halfEven", [0n, 1n]], ["halfAwayFromZero", [1n, 0n]],
    ["towardZero", [0n, 1n]], ["floor", [0n, 1n]], ["ceiling", [1n, 0n]],
  ] as const) {
    expect(planned(input([1n, 1n], 1n, 2n, mode)).installments.map((i) => i.postedAmount.coefficient)).toEqual([...expected]);
  }
  for (const mode of modes) for (const scale of [0n, 2n, 6n]) {
    for (let seed = 1n; seed <= 60n; seed++) {
      const weights = [seed % 7n, seed % 11n + 1n, seed % 5n + 1n];
      const coefficient = seed * 13n + seed % 3n;
      const plan = planned(input(weights, coefficient, scale, mode));
      const denominator = weights.reduce((a, b) => a + b, 0n);
      let cumulative = 0n, prior = 0n;
      for (const [i, row] of plan.installments.entries()) {
        cumulative += weights[i]!;
        const target = integerRound(coefficient * cumulative, denominator, mode);
        expect(row.postedAmount.coefficient).toBe(target - prior);
        expect(row.cumulativeQuantization.amount.coefficient).toBe(target);
        expect(row.cumulativeQuantization.amount.toRational().add(row.cumulativeQuantization.residual).equals(row.cumulativeTarget)).toBeTrue();
        expect(row.postedAmount.toRational().add(row.exactToPostedDifference).equals(row.exactAmount)).toBeTrue();
        expect(row.postedAmount.coefficient >= 0n).toBeTrue();
        prior = target;
      }
      expect(prior).toBe(coefficient);
    }
  }
});

test("zero schedules are explicit and malformed or unrepresentable plans fail closed", () => {
  const base = input();
  const zeros = { ...base, exactSourceBasis: zero, postedSourceBasis: D.of(0n, 2n),
    installments: base.installments.map((i) => ({ ...i, amount: zero })) };
  expect(planned(zeros).installments.map((i) => i.postedAmount.coefficient)).toEqual([0n, 0n, 0n]);
  const bad: Parameters<typeof planAllocationPostings>[0][] = [
    { ...base, installments: [] },
    { ...base, exactSourceBasis: R.of(-1n, 1n) },
    { ...base, exactResidualValue: R.of(-1n, 1n) },
    { ...base, exactResidualValue: R.of(101n, 1n) },
    { ...base, postedSourceBasis: D.of(-100n, 2n) },
    { ...base, exactResidualValue: R.of(50n, 1n), postedSourceBasis: D.of(1n, 2n) },
    { ...base, postedSourceBasis: D.of(100001n, 3n) },
    { ...base, installments: base.installments.map((i) => ({ ...i, ordinal: 2n })) },
    { ...base, installments: base.installments.map((i) => ({ ...i, amount: R.of(-1n, 1n) })) },
    { ...base, installments: base.installments.map((i) => ({ ...i, accountingDate: localDate("2026-01-01") })) },
    { ...base, installments: [...base.installments].reverse().map((i, index) => ({ ...i, ordinal: BigInt(index + 1) })) },
    { ...base, exactSourceBasis: R.of(99n, 1n) },
    { ...zeros, postedSourceBasis: D.of(1n, 2n) },
  ];
  for (const request of bad) {
    const result = planAllocationPostings(request);
    expect(result.disposition).toBe("rejected");
    if (result.disposition !== "rejected") throw new Error("Malformed plan admitted");
    expect(result.diagnostics[0]!.code).toBe("allocation_schedule_violation");
    expect(result.diagnostics[0]!.path).toBe("schedule.postingPlan");
  }
  const atLimit = { ...zeros, installments: Array.from({ length: ACCOUNTING_LIMITS.maxScheduleInstallments }, (_, index) => ({
    ordinal: BigInt(index + 1), accountingDate: localDate(`${String(2026 + Math.floor(index / 12))}-${String(index % 12 + 1).padStart(2, "0")}-01`), amount: zero,
  })) };
  expect(planned(atLimit).installments).toHaveLength(1200);
  expect(planAllocationPostings({ ...atLimit, installments: [...atLimit.installments, atLimit.installments[0]!] }).disposition).toBe("rejected");
});

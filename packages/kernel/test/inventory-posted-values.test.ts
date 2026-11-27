import { expect, test } from "bun:test";
import { ExactDecimal as D, ExactRational as R } from "../src/numeric.ts";
import { adjustInventoryPostedAllowance, allocateInventoryPostedValue, type InventoryPostedValueBudget } from "../src/inventory-posted-values.ts";
import { quantizeCumulativePostedShare, type RoundingMode } from "../src/quantization.ts";
import { quantizationPolicy as policy } from "./fixtures.ts";

const q = (n: bigint, d = 1n) => R.of(n, d);
const budget = (basis: string, allowance = "0.00"): InventoryPostedValueBudget => ({ basis: D.parse(basis), allowance: D.parse(allowance) });
const economic = (basis: bigint, allowance = 0n, denominator = 100n) => ({ basis: q(basis, denominator), allowance: q(allowance, denominator) });
function allocated(value: ReturnType<typeof allocateInventoryPostedValue>) {
  expect(value.disposition).toBe("allocated");
  if (value.disposition !== "allocated") throw new Error(JSON.stringify(value.diagnostics));
  return value;
}
function adjusted(value: ReturnType<typeof adjustInventoryPostedAllowance>) {
  expect(value.disposition).toBe("adjusted");
  if (value.disposition !== "adjusted") throw new Error(JSON.stringify(value.diagnostics));
  return value;
}

test("posted allowance shares cannot become positive between cumulative rounding boundaries", () => {
  // Independently rounded basis: Q(.03*.3)-Q(.03*.2) = .01-.01 = 0.
  // Existing net rule: Q(.02*.3)-Q(.02*.2) = .01-0 = .01.
  // Subtracting those would invent a POSITIVE .01 allowance at the destination.
  const result = allocated(allocateInventoryPostedValue(budget("0.03", "-0.01"), q(2n, 10n), q(3n, 10n), policy));
  expect(result.consumed.basis.toString()).toBe("0.01");
  expect(result.consumed.allowance.toString()).toBe("0.00");
  expect(result.carryingConsumed.toString()).toBe("0.01");
  expect(result.remaining.basis.toString()).toBe("0.02");
  expect(result.remaining.allowance.toString()).toBe("-0.01");
  expect(result.carryingRemaining.toString()).toBe("0.01");
});

test("posted components conserve the original budget across every rounding mode and depletion", () => {
  const modes: RoundingMode[] = ["halfEven", "halfAwayFromZero", "towardZero", "floor", "ceiling"];
  for (const roundingMode of modes) for (let basis = 0n; basis <= 12n; basis++) for (let allowance = 0n; allowance <= basis; allowance++) {
    const original = { basis: D.of(basis, 2n), allowance: D.of(-allowance, 2n) };
    let usedBasis = 0n, usedAllowance = 0n, usedCarrying = 0n;
    for (let index = 0n; index < 12n; index++) {
      const selected = allocated(allocateInventoryPostedValue(original, q(index, 12n), q(index + 1n, 12n), { ...policy, roundingMode }));
      usedBasis += selected.consumed.basis.coefficient;
      usedAllowance += selected.consumed.allowance.coefficient;
      usedCarrying += selected.carryingConsumed.coefficient;
      expect(selected.consumed.basis.coefficient >= 0n).toBe(true);
      expect(selected.consumed.allowance.coefficient <= 0n).toBe(true);
      expect(selected.carryingConsumed.coefficient >= 0n).toBe(true);
      expect(selected.remaining.allowance.coefficient <= 0n).toBe(true);
      expect(selected.remaining.basis.coefficient + selected.remaining.allowance.coefficient).toBe(selected.carryingRemaining.coefficient);
      expect(usedBasis + selected.remaining.basis.coefficient).toBe(basis);
      expect(usedAllowance + selected.remaining.allowance.coefficient).toBe(-allowance);
      expect(usedCarrying + selected.carryingRemaining.coefficient).toBe(basis - allowance);
      const originalNetRule = quantizeCumulativePostedShare(D.of(basis - allowance, 2n), q(index, 12n), q(index + 1n, 12n), { ...policy, roundingMode });
      if (originalNetRule.disposition !== "quantized") throw new Error("Invalid comparison fixture");
      expect(selected.carryingConsumed).toEqual(originalNetRule.share.postedAmount);
    }
    expect([usedBasis, usedAllowance, usedCarrying]).toEqual([basis, -allowance, basis - allowance]);
  }
});

test("write-downs consume actual posted carrying, including zero-cent holdings", () => {
  const zero = adjusted(adjustInventoryPostedAllowance(budget("0.00"), economic(6n, 0n, 1000n), "writeDown", q(-6n, 1000n), policy));
  expect(zero.postedChange.toString()).toBe("0.00");
  expect(zero.after).toEqual(budget("0.00"));
  expect(zero.economicChange.toString()).toBe("-3/500");
  expect(zero.postedMinusEconomic.toString()).toBe("3/500");
  const one = adjusted(adjustInventoryPostedAllowance(budget("0.01"), economic(5n, 0n, 1000n), "writeDown", q(-5n, 1000n), policy));
  expect(one.postedChange.toString()).toBe("-0.01");
  expect(one.after).toEqual(budget("0.01", "-0.01"));
  expect(one.postedMinusEconomic.toString()).toBe("-1/200");
  const restored = adjusted(adjustInventoryPostedAllowance(one.after, economic(5n, -5n, 1000n), "writeDownReversal", q(5n, 1000n), policy));
  expect(restored.postedChange.toString()).toBe("0.01");
  expect(restored.after).toEqual(budget("0.01"));
});

test("partial disposal and later reversal cannot restore already-consumed posted allowance", () => {
  const original = budget("100.00");
  const down = adjusted(adjustInventoryPostedAllowance(original, economic(10_000n), "writeDown", q(-40n), policy));
  expect(down.after).toEqual(budget("100.00", "-40.00"));
  const issued = allocated(allocateInventoryPostedValue(down.after, q(0n), q(1n, 4n), policy));
  expect(issued.consumed).toEqual(budget("25.00", "-10.00"));
  expect(issued.carryingConsumed.toString()).toBe("15.00");
  expect(issued.remaining).toEqual(budget("75.00", "-30.00"));
  const partial = adjusted(adjustInventoryPostedAllowance(issued.remaining, economic(7_500n, -3_000n), "writeDownReversal", q(15n), policy));
  expect(partial.after).toEqual(budget("75.00", "-15.00"));
  const final = adjusted(adjustInventoryPostedAllowance(partial.after, economic(7_500n, -1_500n), "writeDownReversal", q(15n), policy));
  expect(final.after).toEqual(budget("75.00"));
  expect(original).toEqual(budget("100.00"));
  expect(adjustInventoryPostedAllowance(issued.remaining, economic(7_500n, -3_000n), "writeDownReversal", q(40n), policy).disposition).toBe("rejected");
});

test("posted value arithmetic rejects invalid sources, policies, fractions and economic signs", () => {
  for (const bad of [budget("-1.00"), budget("1.00", "0.01"), budget("1.00", "-1.01"), budget("1.00", "-0.001"), budget("0.001")])
    expect(allocateInventoryPostedValue(bad, q(0n), q(1n), policy).disposition).toBe("rejected");
  for (const [from, to] of [[q(-1n), q(1n)], [q(1n), q(0n)], [q(0n), q(2n)]])
    expect(allocateInventoryPostedValue(budget("1.00"), from!, to!, policy).disposition).toBe("rejected");
  expect(allocateInventoryPostedValue(budget("1.00"), q(0n), q(1n), { ...policy, targetScale: -1n }).disposition).toBe("rejected");
  expect(adjustInventoryPostedAllowance(budget("-1.00"), economic(100n), "writeDown", q(-1n), policy).disposition).toBe("rejected");
  for (const [values, kind, delta] of [
    [economic(-100n), "writeDown", q(-1n)], [economic(100n, 1n), "writeDown", q(-1n)],
    [economic(100n, -101n), "writeDownReversal", q(1n)], [economic(100n), "writeDown", q(-2n)],
    [economic(100n), "writeDown", q(0n)], [economic(100n), "writeDown", q(1n)],
    [economic(100n, -50n), "writeDownReversal", q(-1n)], [economic(100n, -50n), "writeDownReversal", q(0n)],
    [economic(100n, -50n), "writeDownReversal", q(1n)], [economic(0n), "writeDown", q(-1n)],
    [economic(100n), "writeDownReversal", q(1n)],
  ] as const) expect(adjustInventoryPostedAllowance(budget("1.00"), values, kind, delta, policy).disposition).toBe("rejected");
  expect(adjustInventoryPostedAllowance(budget("1.00"), economic(100n), "unknown" as "writeDown", q(-1n), policy).disposition).toBe("rejected");
});

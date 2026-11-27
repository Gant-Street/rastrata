import { expect, test } from "bun:test";
import { ExactDecimal as D, ExactRational as R, quantizeCumulativePostedShare, quantizationPolicyId, semanticVersion, localDate, type QuantizationPolicy, type RoundingMode } from "../src/index.ts";
import { IDS } from "./fixtures.ts";
import examples from "../spec/inventory-posted-transition-examples.json";

function rational(value: string): R {
  const [numerator, denominator] = value.split("/");
  if (numerator === undefined || denominator === undefined) throw new Error("Invalid exact example");
  return R.of(BigInt(numerator), BigInt(denominator));
}

// These are prospective design vectors evaluated by the actual arithmetic
// primitive, NOT a substitute for future canonical command/storage executors.
test("prospective inventory movement vectors preserve quantity, actual posted budget and separate economic differences", () => {
  expect(examples.status).toBe("prospective-design-not-command-executable");
  expect(new Set(examples.examples.map((example) => example.id)).size).toBe(examples.examples.length);
  for (const example of examples.examples) {
    const policy: QuantizationPolicy = { id: quantizationPolicyId("inventory-design"), bookId: IDS.book, version: semanticVersion("1.0.0"), functionalCommodityId: IDS.usd, validFrom: localDate("2020-01-01"), targetScale: 2n, roundingMode: example.roundingMode as RoundingMode, roundingAccountId: IDS.cash };
    const sourceBudgets = example.postedSourceBudgets.map((source) => D.parse(source));
    expect(sourceBudgets.every((source) => source.scale === 2n)).toBe(true);
    const posted = D.of(sourceBudgets.reduce((sum, source) => sum + source.coefficient, 0n), 2n);
    const quantity = rational(example.quantity), carrying = rational(example.exactCarrying);
    let consumed = R.zero(), consumedPosted = R.zero();
    const observed = [];
    for (const value of example.reductions) {
      const reduction = rational(value);
      const after = consumed.add(reduction);
      const planned = quantizeCumulativePostedShare(posted, consumed.divide(quantity), after.divide(quantity), policy);
      expect(planned.disposition, example.id).toBe("quantized");
      if (planned.disposition !== "quantized") throw new Error("Valid example rejected");
      consumed = after;
      consumedPosted = consumedPosted.add(planned.share.postedAmount.toRational());
      const exactEconomicAllocation = carrying.multiply(reduction).divide(quantity);
      observed.push({ posted: planned.share.postedAmount.toString(), cumulative: planned.share.afterQuantization.amount.toString(), remainingQuantity: quantity.subtract(consumed).toString(), difference: planned.share.postedAmount.toRational().subtract(exactEconomicAllocation).toString(), kind: planned.share.postedAmount.isZero() ? "quantityOnly" : "journalLinked" });
      expect(consumedPosted.equals(planned.share.afterQuantization.amount.toRational()), example.id).toBe(true);
    }
    expect(observed.map((step) => step.posted), example.id).toEqual(example.expectedPosted);
    expect(observed.map((step) => step.cumulative), example.id).toEqual(example.expectedConsumedPosted);
    expect(observed.map((step) => step.remainingQuantity), example.id).toEqual(example.expectedRemainingQuantity);
    expect(observed.map((step) => step.difference), example.id).toEqual(example.expectedPostedMinusEconomic);
    expect(observed.map((step) => step.kind), example.id).toEqual(example.expectedMovementKinds);
    expect(consumed.equals(quantity), example.id).toBe(true);
    expect(consumedPosted.equals(posted.toRational()), example.id).toBe(true);
  }
});

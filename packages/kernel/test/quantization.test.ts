import { describe, expect, test } from "bun:test";
import {
  ExactRational,
  quantizationPolicyId,
  quantize,
  quantizeBalancedBookValues,
  localDate,
  semanticVersion,
} from "../src/index.ts";
import { IDS } from "./fixtures.ts";

const policy = Object.freeze({
  id: quantizationPolicyId("quantization-usd"),
  version: semanticVersion("1.0.0"),
  bookId: IDS.book,
  functionalCommodityId: IDS.usd,
  validFrom: localDate("2020-01-01"),
  targetScale: 2n,
  roundingMode: "halfEven" as const,
  roundingAccountId: IDS.revenue,
});

describe("explicit quantization", () => {
  test("implements every declared directed and nearest rounding mode", () => {
    const cases = [
      ["towardZero", "1.2"], ["floor", "1.2"], ["ceiling", "1.3"],
      ["halfAwayFromZero", "1.3"], ["halfEven", "1.2"],
    ] as const;
    for (const [roundingMode, expected] of cases) {
      expect(quantize(ExactRational.of(5n, 4n), { ...policy, targetScale: 1n, roundingMode }).amount.toString()).toBe(expected);
    }
    expect(quantize(ExactRational.of(-5n, 4n), { ...policy, targetScale: 1n, roundingMode: "floor" }).amount.toString()).toBe("-1.3");
    expect(quantize(ExactRational.of(-5n, 4n), { ...policy, targetScale: 1n, roundingMode: "ceiling" }).amount.toString()).toBe("-1.2");
    expect(quantize(ExactRational.of(6n, 5n), { ...policy, targetScale: 1n, roundingMode: "halfEven" }).amount.toString()).toBe("1.2");
    expect(quantize(ExactRational.of(5n, 4n), { ...policy, targetScale: 1n, roundingMode: "halfEven" }).amount.toString()).toBe("1.2");
    expect(quantize(ExactRational.of(27n, 20n), { ...policy, targetScale: 1n, roundingMode: "halfEven" }).amount.toString()).toBe("1.4");
    expect(quantize(ExactRational.of(-27n, 20n), { ...policy, targetScale: 1n, roundingMode: "halfEven" }).amount.toString()).toBe("-1.4");
    expect(quantize(ExactRational.of(124n, 100n), { ...policy, targetScale: 1n, roundingMode: "halfAwayFromZero" }).amount.toString()).toBe("1.2");
    expect(quantize(ExactRational.of(-5n, 4n), { ...policy, targetScale: 1n, roundingMode: "halfAwayFromZero" }).amount.toString()).toBe("-1.3");
    expect(quantize(ExactRational.of(12n, 10n), { ...policy, targetScale: 1n, roundingMode: "halfEven" }).amount.toString()).toBe("1.2");
    expect(quantize(ExactRational.of(1n, 2n), { ...policy, targetScale: 0n, roundingMode: "ceiling" }).amount.toString()).toBe("1");
  });

  test("rejects invalid scale and cross-book quantization policy", () => {
    expect(() => quantize(ExactRational.of(1n, 1n), { ...policy, targetScale: -1n })).toThrow();
    expect(quantizeBalancedBookValues([], IDS.book, IDS.usd, { ...policy, targetScale: -1n }).disposition).toBe("rejected");
    expect(quantizeBalancedBookValues([], IDS.book, IDS.usd, { ...policy, bookId: ("other-book" as typeof IDS.book) }).disposition).toBe("rejected");
    expect(quantize(ExactRational.zero(), { ...policy, targetScale: 1_000n }).amount.scale).toBe(1_000n);
    expect(quantizeBalancedBookValues([], IDS.book, IDS.usd, { ...policy, targetScale: 1_000n }).disposition).toBe("quantized");
    expect(quantizeBalancedBookValues([], IDS.book, IDS.usd, { ...policy, targetScale: 0n }).disposition).toBe("quantized");
  });
  test("uses deterministic half-even rounding with an exact residual (ACC-001, ACC-003)", () => {
    const result = quantize(ExactRational.of(1_005n, 1_000n), policy);
    expect(result.amount.toString()).toBe("1.00");
    expect(result.residual.equals(ExactRational.of(1n, 200n))).toBeTrue();
  });

  test("creates a nonzero explicit rounding posting when independently rounded values drift", () => {
    const result = quantizeBalancedBookValues(
      [ExactRational.of(1n, 3n), ExactRational.of(1n, 3n), ExactRational.of(-2n, 3n)],
      IDS.book,
      IDS.usd,
      policy,
    );
    expect(result.disposition).toBe("quantized");
    if (result.disposition === "quantized") {
      expect(result.roundingPosting?.bookValue.amount.toString()).toBe("0.01");
      const total = [...result.bookValues, result.roundingPosting!.bookValue].reduce(
        (sum, value) => sum.add(value.amount.toRational()),
        ExactRational.zero(),
      );
      expect(total.isZero()).toBeTrue();
    }
  });

  test("rejects values that were not exactly balanced before quantization", () => {
    const result = quantizeBalancedBookValues([ExactRational.of(1n, 3n)], IDS.book, IDS.usd, policy);
    expect(result.disposition).toBe("rejected");
  });
});

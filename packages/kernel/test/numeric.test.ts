import { describe, expect, test } from "bun:test";

import {
  ExactDecimal,
  ExactNumberError,
  ExactRational,
  MAX_DECIMAL_SCALE,
} from "../src/index.ts";

describe("exact arithmetic (ACC-001)", () => {
  test("returns exact absolute values without decimal conversion", () => {
    expect(ExactRational.of(-2n, 3n).abs().equals(ExactRational.of(2n, 3n))).toBeTrue();
    expect(ExactRational.of(2n, 3n).abs().equals(ExactRational.of(2n, 3n))).toBeTrue();
  });
  test("preserves source decimal coefficient and scale", () => {
    const value = ExactDecimal.parse("-00123.4500");

    expect(value.coefficient).toBe(-1_234_500n);
    expect(value.scale).toBe(4n);
    expect(value.toString()).toBe("-123.4500");
    expect(value.toRational()).toEqual(ExactRational.of(-2_469n, 20n));
    expect(ExactDecimal.of(0n, 0n).isZero()).toBeTrue();
    expect(ExactDecimal.of(1n, 0n).isZero()).toBeFalse();
    expect(ExactDecimal.of(0n, 0n).toString()).toBe("0");
    expect(ExactDecimal.of(1n, 0n).toString()).toBe("1");
  });

  test("normalizes common factors while retaining a positive denominator", () => {
    expect(ExactRational.of(-12n, 18n)).toEqual(ExactRational.of(-2n, 3n));
    expect(ExactRational.of(0n, 999n)).toEqual(ExactRational.zero());
  });

  test("performs exact repeating arithmetic without decimal feedback", () => {
    const oneThird = ExactRational.of(1n, 3n);
    const result = oneThird.add(oneThird).add(oneThird);

    expect(result).toEqual(ExactRational.of(1n, 1n));
  });

  test("rejects invalid rationals and excessive representation before use", () => {
    expect(() => ExactRational.of(1n, 0n)).toThrow(ExactNumberError);
    expect(() => ExactRational.of(1n, -2n)).toThrow("Rational denominator must be positive");
    expect(() => ExactDecimal.of(1n, MAX_DECIMAL_SCALE + 1n)).toThrow(
      "Decimal scale exceeds the admitted limit",
    );
    expect(ExactDecimal.of(1n, MAX_DECIMAL_SCALE).scale).toBe(MAX_DECIMAL_SCALE);
    expect(() => ExactDecimal.parse("1e3")).toThrow("Invalid source decimal");
    expect(() => ExactRational.of(1n << 16_384n, 1n)).toThrow(
      "exact-integer limit",
    );
    expect(ExactRational.of(1n << 16_383n, 1n).numerator).toBe(1n << 16_383n);
  });
});

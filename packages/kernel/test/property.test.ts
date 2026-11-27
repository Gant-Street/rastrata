import { describe, expect, test } from "bun:test";
import { ExactDecimal, ExactRational, quantize, quantizeBalancedBookValues, type QuantizationPolicy } from "../src/index.ts";
import { IDS, quantizationPolicy } from "./fixtures.ts";

/** Deterministic xorshift32 PRNG: same seed, same sequence, on every runtime. */
function makeRng(seed: number): () => number {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

interface Generator<T> { readonly generate: (rng: () => number) => T; readonly shrink: (value: T) => readonly T[] }

const rational = (maxMagnitude: bigint): Generator<ExactRational> => ({
  generate: (rng) => {
    const denominator = 1n + BigInt(Math.floor(rng() * 24));
    const numerator = BigInt(Math.floor(rng() * Number(maxMagnitude * 2n + 1n))) - maxMagnitude;
    const candidate = ExactRational.of(numerator, denominator);
    return candidate;
  },
  shrink: (value) => {
    const towardZero = ExactRational.of(value.numerator / 2n, value.denominator === 0n ? 1n : value.denominator);
    return value.isZero() ? [] : [towardZero, ExactRational.zero()].filter((candidate) => !candidate.equals(value));
  },
});

function forAll<T>(property: string, generator: Generator<T>, runs: number, check: (value: T) => void) {
  const rng = makeRng(0x5eed + property.length);
  for (let run = 0; run < runs; run += 1) {
    const value = generator.generate(rng);
    try {
      check(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Minimal shrinking: keep shrinking the current best until no candidate fails.
      let best = value;
      let bestFails = true;
      for (let depth = 0; depth < 16; depth += 1) {
        const candidates = bestFails ? generator.shrink(best) : [];
        let progressed = false;
        for (const candidate of candidates) {
          try {
            check(candidate);
          } catch {
            best = candidate;
            bestFails = true;
            progressed = true;
            break;
          }
        }
        if (!progressed) break;
      }
      throw new Error(`${property}: minimal failing example ${String(best)} (${message})`);
    }
  }
}

const quantization: QuantizationPolicy = quantizationPolicy;

describe("property-based kernel laws (deterministic seeds with shrinking)", () => {
  test("exact rationals obey field laws across the generated domain", () => {
    forAll("addition commutes", rational(1_000n), 200, (value) => {
      const other = ExactRational.of(37n, 3n);
      expect(value.add(other).equals(other.add(value))).toBeTrue();
    });
    forAll("addition associates", rational(1_000n), 150, (value) => {
      const left = ExactRational.of(5n, 7n);
      const right = ExactRational.of(-11n, 13n);
      expect(value.add(left).add(right).equals(value.add(left.add(right)))).toBeTrue();
    });
    forAll("multiplication distributes over addition", rational(500n), 150, (value) => {
      const left = ExactRational.of(3n, 4n);
      const right = ExactRational.of(-9n, 5n);
      expect(value.multiply(left.add(right)).equals(value.multiply(left).add(value.multiply(right)))).toBeTrue();
    });
    forAll("negation is an exact inverse", rational(1_000n), 200, (value) => {
      expect(value.add(value.negate()).isZero()).toBeTrue();
    });
    forAll("division by nonzero self is one", rational(1_000n), 200, (value) => {
      if (value.isZero()) return;
      expect(value.divide(value).equals(ExactRational.of(1n, 1n))).toBeTrue();
    });
  });

  test("exact decimals round-trip through their string form", () => {
    const decimalGenerator: Generator<ExactDecimal> = {
      generate: (rng) => ExactDecimal.of(BigInt(Math.floor(rng() * 1_000_000)) - 500_000n, 2n),
      shrink: (value) => (value.isZero() ? [] : [ExactDecimal.of(0n, 2n)]),
    };
    forAll("decimal string round-trip", decimalGenerator, 200, (value) => {
      expect(ExactDecimal.parse(value.toString()).toString()).toBe(value.toString());
    });
  });

  test("quantization is bounded, monotone, and idempotent", () => {
    forAll("quantized value stays within half a cent of scale 2", rational(100_000n), 200, (value) => {
      const quantized = quantize(value, quantization);
      const quantizedRational = quantized.amount.toRational();
      const error = value.subtract(quantizedRational).abs();
      const halfCent = ExactRational.of(5n, 1000n);
      expect(error.compare(halfCent) <= 0).toBeTrue();
    });
    forAll("quantization is monotone", rational(10_000n), 150, (value) => {
      const low = quantize(value, quantization).amount.toRational();
      const high = quantize(value.add(ExactRational.of(1n, 1n)), quantization).amount.toRational();
      expect(low.compare(high) <= 0).toBeTrue();
    });
    forAll("quantization is idempotent", rational(10_000n), 150, (value) => {
      const once = quantize(value, quantization).amount.toRational();
      const twice = quantize(once, quantization).amount.toRational();
      expect(once.equals(twice)).toBeTrue();
    });
  });

  test("quantizeBalancedBookValues conserves the input total exactly", () => {
    const rng = makeRng(0xbeef);
    for (let run = 0; run < 60; run += 1) {
      const count = 1 + Math.floor(rng() * 6);
      const amounts: ExactRational[] = [];
      let running = ExactRational.zero();
      for (let index = 0; index < count - 1; index += 1) {
        const amount = ExactRational.of(BigInt(Math.floor(rng() * 400) - 200), 100n);
        amounts.push(amount);
        running = running.add(amount);
      }
      const residual = running.negate();
      amounts.push(residual);
      const total = amounts.reduce((total, amount) => total.add(amount), ExactRational.zero());
      const balanced = quantizeBalancedBookValues(amounts, IDS.book, IDS.usd, quantization);
      if (balanced.disposition !== "quantized") throw new Error(`balanced quantization rejected: ${balanced.diagnostics[0]?.message}`);
      const quantizedTotal = balanced.bookValues.reduce((total, item) => total.add(item.amount.toRational()), ExactRational.zero());
      expect(quantizedTotal.equals(total)).toBeTrue();
    }
  });

  test("quantization residual is explicit and bounded", () => {
    forAll("quantization carries an explicit residual", rational(50_000n), 200, (value) => {
      const quantized = quantize(value, quantization);
      expect(quantized.residual).toBeDefined();
      expect(quantized.amount.toRational().add(quantized.residual).equals(value)).toBeTrue();
    });
  });
});

/**
 * What the quantization tests share (`quantization.test.ts` and `balanced.test.ts`): the policy the
 * TypeScript is given, and the generators of values, scales, fractions and totals that put the
 * rounding on its ties, its edges and the size limit.
 *
 * Every source character in this file is ASCII: a code point is written as a number.
 */
import fc from "fast-check";

import {
  ExactDecimal,
  ExactRational,
  type QuantizationPolicy,
  type RoundingMode,
  accountId,
  bookId,
  commodityId,
  localDate,
  quantizationPolicyId,
  semanticVersion,
} from "../src/index.ts";
import {
  MAX_MAGNITUDE,
  ONE_PAST_LIMIT,
  ROUNDING_MODES,
  arbBadScale,
  arbMagnitude,
  arbMode,
  arbRational,
  arbSmallRational,
  arbValidScale,
  decimalOrUndefined,
  isDefined,
} from "./wave2a-wire.ts";

// ---------------------------------------------------------------------------------------------
// The policy the TypeScript is given
// ---------------------------------------------------------------------------------------------

export const FIXED = {
  id: quantizationPolicyId("quantization-1"),
  version: semanticVersion("1.0.0"),
  bookId: bookId("book"),
  functionalCommodityId: commodityId("USD"),
  validFrom: localDate("2000-01-01"),
  roundingAccountId: accountId("rounding"),
} as const;

/** A policy with the scale and the mode; its other fields are not read by the arithmetic. */
export const policyOf = (targetScale: bigint, roundingMode: RoundingMode): QuantizationPolicy => ({
  ...FIXED,
  targetScale,
  roundingMode,
});

export const ruleOf = (scale: bigint, mode: RoundingMode) => ({
  targetScale: scale.toString(),
  roundingMode: mode,
});

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

export const ZERO = ExactRational.zero();
export const ONE = ExactRational.of(1n, 1n);
export const HALF = ExactRational.of(1n, 2n);
export const rational = (numerator: bigint, denominator: bigint): ExactRational =>
  ExactRational.of(numerator, denominator);

/** Values at the edge of the size limit: where the rounded coefficient, or the subtraction that
 * makes the residual, goes beyond 16,384 bits. */
export const LIMIT_VALUES: ExactRational[] = [
  rational(MAX_MAGNITUDE, 1n),
  rational(-MAX_MAGNITUDE, 1n),
  rational(MAX_MAGNITUDE - 1n, 1n),
  rational(MAX_MAGNITUDE, 2n),
  rational(MAX_MAGNITUDE, 3n),
  rational(-MAX_MAGNITUDE, 7n),
  rational(1n, MAX_MAGNITUDE),
  rational(-1n, MAX_MAGNITUDE),
  rational(1n, 1n << 16383n),
  rational(-1n, 1n << 16383n),
  rational(3n, 1n << 16383n),
  rational((1n << 16383n) + 1n, 1n << 16383n),
  rational(MAX_MAGNITUDE, MAX_MAGNITUDE - 1n),
  rational(1n << 16383n, 3n),
  rational(10n ** 4000n, 3n),
  rational(10n ** 4900n, 7n),
  rational(1n, 10n ** 4900n),
  rational(1n, 3n ** 10000n),
  rational(2n ** 16000n + 1n, 3n),
];

/** A value for a scale: a tie at that scale, next to a tie, exact, repeating, tiny, or any. */
export function arbValueFor(scale: bigint): fc.Arbitrary<ExactRational> {
  const unit = 10n ** scale;
  const tie = fc.bigInt({ min: -2000n, max: 2000n }).map((k) => rational(2n * k + 1n, 2n * unit));
  const nearTie = fc
    .tuple(
      fc.bigInt({ min: -300n, max: 300n }),
      fc.integer({ min: 1, max: 4 }),
      fc.constantFrom(-1n, 1n, 2n, -2n),
    )
    .map(([k, j, shift]) => {
      const spread = 10n ** BigInt(j);
      return rational((2n * k + 1n) * spread + shift, 2n * unit * spread);
    });
  const exact = fc.bigInt({ min: -2000n, max: 2000n }).map((c) => rational(c, unit));
  const repeating = fc
    .tuple(fc.bigInt({ min: -5000n, max: 5000n }), fc.constantFrom(3n, 7n, 9n, 11n, 13n, 37n, 101n))
    .map(([n, d]) => rational(n, d));
  const tiny = fc
    .tuple(fc.constantFrom(-1n, 1n, 3n, -7n), fc.integer({ min: 0, max: 5 }))
    .map(([n, extra]) => rational(n, unit * 10n ** BigInt(extra)));
  const whole = fc.bigInt({ min: -3000n, max: 3000n }).map((n) => rational(n, 1n));
  return fc.oneof(
    { weight: 5, arbitrary: tie },
    { weight: 3, arbitrary: nearTie },
    { weight: 2, arbitrary: exact },
    { weight: 3, arbitrary: repeating },
    { weight: 2, arbitrary: tiny },
    { weight: 1, arbitrary: whole },
    { weight: 3, arbitrary: arbSmallRational },
    { weight: 2, arbitrary: arbRational },
    { weight: 1, arbitrary: fc.constantFrom(...LIMIT_VALUES) },
    { weight: 1, arbitrary: fc.constant(ZERO) },
  );
}

export interface QuantizeCase {
  readonly value: ExactRational;
  readonly scale: bigint;
  readonly mode: RoundingMode;
}

export const arbScale: fc.Arbitrary<bigint> = fc.oneof(
  { weight: 9, arbitrary: arbValidScale },
  { weight: 1, arbitrary: arbBadScale },
);

export const arbQuantizeCase: fc.Arbitrary<QuantizeCase> = fc
  .tuple(arbScale, arbMode)
  .chain(([scale, mode]) =>
    // A bad scale gets values for scale 2: they are never rounded.
    arbValueFor(scale >= 0n && scale <= 1000n ? scale : 2n).map((value) => ({
      value,
      scale,
      mode,
    })),
  );

/** A case whose scale is one `quantize` admits. */
export const arbAdmittedCase: fc.Arbitrary<QuantizeCase> = fc
  .tuple(arbValidScale, arbMode)
  .chain(([scale, mode]) => arbValueFor(scale).map((value) => ({ value, scale, mode })));

export const describeCase = (c: QuantizeCase) =>
  `${c.value.numerator}/${c.value.denominator} at scale ${c.scale}, ${c.mode}`;

export const quantizeExamples: [QuantizeCase][] = [
  ...ROUNDING_MODES.flatMap((mode) =>
    [
      rational(1n, 2n),
      rational(-1n, 2n),
      rational(3n, 2n),
      rational(-3n, 2n),
      rational(5n, 2n),
      rational(-5n, 2n),
      rational(1n, 3n),
      rational(-1n, 3n),
      rational(2n, 3n),
      rational(-2n, 3n),
      ZERO,
      ONE,
    ].map((value): [QuantizeCase] => [{ value, scale: 0n, mode }]),
  ),
  ...ROUNDING_MODES.flatMap((mode) =>
    [-1n, 1001n, 1000n, 0n].map((scale): [QuantizeCase] => [
      { value: rational(7n, 3n), scale, mode },
    ]),
  ),
  ...LIMIT_VALUES.flatMap((value) =>
    [0n, 1n, 2n, 5n, 1000n].map((scale): [QuantizeCase] => [{ value, scale, mode: "halfEven" }]),
  ),
  ...ROUNDING_MODES.map((mode): [QuantizeCase] => [
    { value: rational(1n, 1n << 16383n), scale: 2n, mode },
  ]),
  [{ value: rational(MAX_MAGNITUDE, 1n), scale: 0n, mode: "floor" }],
  [{ value: rational(-MAX_MAGNITUDE, 1n), scale: 0n, mode: "ceiling" }],
  [{ value: ZERO, scale: ONE_PAST_LIMIT, mode: "floor" }],
  [{ value: ZERO, scale: -ONE_PAST_LIMIT, mode: "floor" }],
];

export interface ShareCase {
  readonly total: ExactDecimal;
  readonly before: ExactRational;
  readonly after: ExactRational;
  readonly scale: bigint;
  readonly mode: RoundingMode;
}

export const describeShare = (c: ShareCase) =>
  `total ${c.total.coefficient}e-${c.total.scale}, fractions ${c.before.numerator}/${c.before.denominator} to ${c.after.numerator}/${c.after.denominator}, scale ${c.scale}, ${c.mode}`;

// ---------------------------------------------------------------------------------------------
// Shares
// ---------------------------------------------------------------------------------------------

export const arbBigDenominator: fc.Arbitrary<bigint> = fc.oneof(
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      1n << 16383n,
      1n << 16382n,
      1n << 16000n,
      3n ** 10000n,
      MAX_MAGNITUDE,
    ),
  },
  {
    weight: 1,
    arbitrary: fc.integer({ min: 1, max: 16384 }).map((bits) => 1n << BigInt(bits - 1)),
  },
);

/** A fraction from zero through one: halves, thirds and the like, the ends, and now and then one
 * whose denominator is large. */
export const arbUnitFraction: fc.Arbitrary<ExactRational> = fc.oneof(
  { weight: 2, arbitrary: fc.constantFrom(ZERO, ONE, HALF) },
  {
    weight: 7,
    arbitrary: fc
      .tuple(fc.bigInt({ min: 0n, max: 40n }), fc.bigInt({ min: 1n, max: 40n }))
      .filter(([numerator, denominator]) => numerator <= denominator)
      .map(([numerator, denominator]) => rational(numerator, denominator)),
  },
  {
    weight: 1,
    arbitrary: fc
      .tuple(arbBigDenominator, fc.bigInt({ min: 0n, max: 100n }))
      .map(([denominator, numerator]) =>
        rational(numerator <= denominator ? numerator : 1n, denominator),
      ),
  },
);

export const arbFractions: fc.Arbitrary<[ExactRational, ExactRational]> = fc.oneof(
  // In order, from zero through one.
  {
    weight: 7,
    arbitrary: fc
      .tuple(arbUnitFraction, arbUnitFraction)
      .map(([left, right]): [ExactRational, ExactRational] =>
        left.compare(right) <= 0 ? [left, right] : [right, left],
      ),
  },
  // The first fraction below zero.
  {
    weight: 1,
    arbitrary: fc
      .tuple(fc.bigInt({ min: 1n, max: 30n }), fc.bigInt({ min: 1n, max: 30n }), arbUnitFraction)
      .map(([n, d, after]): [ExactRational, ExactRational] => [rational(-n, d), after]),
  },
  // The second fraction below the first.
  {
    weight: 1,
    arbitrary: fc
      .tuple(arbUnitFraction, arbUnitFraction)
      .filter(([left, right]) => left.compare(right) > 0)
      .map(([left, right]): [ExactRational, ExactRational] => [left, right]),
  },
  // The second fraction above one.
  {
    weight: 1,
    arbitrary: fc
      .tuple(arbUnitFraction, fc.bigInt({ min: 1n, max: 30n }), fc.bigInt({ min: 1n, max: 30n }))
      .map(([before, n, d]): [ExactRational, ExactRational] => [before, rational(d + n, d)]),
  },
);

/** A total at a scale: representable in it (fewer places, as many, or more places that are
 * zeros), not representable (a digit beyond), negative, zero, or large. */
export function arbTotalFor(scale: bigint): fc.Arbitrary<ExactDecimal> {
  const place = scale >= 0n && scale <= 1000n ? scale : 2n;
  const make = (coefficient: bigint, at: bigint) => decimalOrUndefined(coefficient, at);
  return fc
    .oneof(
      {
        weight: 4,
        arbitrary: fc.bigInt({ min: 0n, max: 100_000n }).map((c) => make(c, place)),
      },
      {
        weight: 2,
        arbitrary: fc
          .tuple(fc.bigInt({ min: 0n, max: 100_000n }), fc.bigInt({ min: 0n, max: place }))
          .map(([c, at]) => make(c * 10n ** (place - at), at)),
      },
      {
        weight: 2,
        arbitrary: fc
          .tuple(fc.bigInt({ min: 0n, max: 100_000n }), fc.bigInt({ min: 1n, max: 4n }))
          .map(([c, extra]) => make(c * 10n ** extra, place + extra)),
      },
      {
        weight: 3,
        arbitrary: fc
          .tuple(
            fc.bigInt({ min: 0n, max: 100_000n }),
            fc.bigInt({ min: 1n, max: 4n }),
            fc.bigInt({ min: 1n, max: 9999n }),
          )
          .map(([c, extra, tail]) => {
            const spread = 10n ** extra;
            return make(c * spread + (tail % (spread - 1n)) + 1n, place + extra);
          }),
      },
      {
        weight: 1,
        arbitrary: fc.bigInt({ min: -100_000n, max: -1n }).map((c) => make(c, place)),
      },
      { weight: 1, arbitrary: fc.constant(make(0n, place)) },
      {
        weight: 1,
        arbitrary: arbMagnitude.map((c) => make(c, place > 6n ? 6n : place)),
      },
      {
        weight: 1,
        arbitrary: fc.constantFrom(
          make(MAX_MAGNITUDE, 0n),
          make(5n, 1n),
          make(1n, 1000n),
          make(1n << 16383n, 1n),
        ),
      },
    )
    .filter(isDefined);
}

export const arbShareCase: fc.Arbitrary<ShareCase> = fc
  .tuple(arbScale, arbMode)
  .chain(([scale, mode]) =>
    fc
      .tuple(arbTotalFor(scale), arbFractions)
      .map(([total, [before, after]]) => ({ total, before, after, scale, mode })),
  );

export const shareExamples: [ShareCase][] = [
  ...ROUNDING_MODES.map((mode): [ShareCase] => [
    {
      total: ExactDecimal.of(1000n, 2n),
      before: rational(1n, 3n),
      after: rational(2n, 3n),
      scale: 2n,
      mode,
    },
  ]),
  [
    {
      total: ExactDecimal.of(5n, 1n),
      before: ZERO,
      after: rational(1n, 1n << 16383n),
      scale: 1n,
      mode: "halfEven",
    },
  ],
  [
    {
      total: ExactDecimal.of(5n, 1n),
      before: rational(1n, 1n << 16383n),
      after: HALF,
      scale: 1n,
      mode: "halfEven",
    },
  ],
  [{ total: ExactDecimal.of(12345n, 4n), before: ZERO, after: ONE, scale: 2n, mode: "floor" }],
  [{ total: ExactDecimal.of(12300n, 4n), before: ZERO, after: ONE, scale: 2n, mode: "floor" }],
  [{ total: ExactDecimal.of(-1n, 2n), before: ZERO, after: ONE, scale: 2n, mode: "floor" }],
  [
    {
      total: ExactDecimal.of(1n, 2n),
      before: rational(-1n, 2n),
      after: ONE,
      scale: 2n,
      mode: "floor",
    },
  ],
  [
    {
      total: ExactDecimal.of(1n, 2n),
      before: HALF,
      after: rational(1n, 3n),
      scale: 2n,
      mode: "floor",
    },
  ],
  [
    {
      total: ExactDecimal.of(1n, 2n),
      before: ZERO,
      after: rational(3n, 2n),
      scale: 2n,
      mode: "floor",
    },
  ],
  [{ total: ExactDecimal.of(1n, 2n), before: ZERO, after: ONE, scale: -1n, mode: "floor" }],
  [{ total: ExactDecimal.of(1n, 2n), before: ZERO, after: ONE, scale: 1001n, mode: "floor" }],
  [{ total: ExactDecimal.of(0n, 0n), before: ZERO, after: ZERO, scale: 0n, mode: "ceiling" }],
  [
    {
      total: ExactDecimal.of(MAX_MAGNITUDE, 0n),
      before: ZERO,
      after: ONE,
      scale: 0n,
      mode: "towardZero",
    },
  ],
  [
    {
      total: ExactDecimal.of(MAX_MAGNITUDE, 0n),
      before: ZERO,
      after: HALF,
      scale: 0n,
      mode: "towardZero",
    },
  ],
];

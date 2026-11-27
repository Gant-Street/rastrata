import { afterAll, beforeAll, describe, test } from "bun:test";
import fc from "fast-check";

import {
  ExactDecimal,
  ExactNumberError,
  ExactRational,
  MAX_DECIMAL_SCALE,
  MAX_EXACT_INTEGER_BITS,
} from "../src/index.ts";
import {
  type DecimalWire,
  OracleClient,
  type OracleOutcome,
  type RationalWire,
} from "./oracle-client.ts";

const SEED = 20261125;
const NUM_RUNS = 2000;
const TEST_TIMEOUT_MS = 120_000;

const MAX_MAGNITUDE = (1n << BigInt(MAX_EXACT_INTEGER_BITS)) - 1n; // 2^16384 - 1
const ONE_PAST_LIMIT = 1n << BigInt(MAX_EXACT_INTEGER_BITS); // 2^16384

type RationalSpec = {
  readonly numerator: bigint;
  readonly denominator: bigint;
  readonly negate: boolean;
};

type DecimalSpec = {
  readonly coefficient: bigint;
  readonly scale: bigint;
  readonly negate: boolean;
};

function toRationalWire(r: ExactRational): RationalWire {
  return {
    numerator: r.numerator.toString(),
    denominator: r.denominator.toString(),
  };
}

function toDecimalWire(d: ExactDecimal): DecimalWire {
  return {
    coefficient: d.coefficient.toString(),
    scale: d.scale.toString(),
  };
}

function buildRational(spec: RationalSpec): ExactRational {
  const base = ExactRational.of(spec.numerator, spec.denominator);
  return spec.negate ? base.negate() : base;
}

function buildDecimal(spec: DecimalSpec): ExactDecimal {
  const base = ExactDecimal.of(spec.coefficient, spec.scale);
  return spec.negate ? base.negate() : base;
}

function runTs<T>(fn: () => T): OracleOutcome<T> {
  try {
    return { kind: "ok", value: fn() };
  } catch (err) {
    if (err instanceof ExactNumberError) {
      return { kind: "error", code: err.code };
    }
    throw err;
  }
}

function assertOutcomesEqual<T>(
  fnName: string,
  inputDesc: string,
  tsOutcome: OracleOutcome<T>,
  leanOutcome: OracleOutcome<T>,
): void {
  if (tsOutcome.kind !== leanOutcome.kind) {
    throw new Error(
      `Mismatch in ${fnName} for ${inputDesc}:\n  TS:   ${JSON.stringify(tsOutcome)}\n  Lean: ${JSON.stringify(leanOutcome)}`,
    );
  }
  if (tsOutcome.kind === "error" && leanOutcome.kind === "error") {
    if (tsOutcome.code !== leanOutcome.code) {
      throw new Error(
        `Error code mismatch in ${fnName} for ${inputDesc}:\n  TS:   ${tsOutcome.code}\n  Lean: ${leanOutcome.code}`,
      );
    }
    return;
  }
  if (tsOutcome.kind === "ok" && leanOutcome.kind === "ok") {
    if (!Bun.deepEquals(tsOutcome.value, leanOutcome.value)) {
      throw new Error(
        `Value mismatch in ${fnName} for ${inputDesc}:\n  TS:   ${JSON.stringify(tsOutcome.value)}\n  Lean: ${JSON.stringify(leanOutcome.value)}`,
      );
    }
  }
}

const arbEdgeInt = fc.constantFrom(
  0n,
  1n,
  -1n,
  2n,
  -2n,
  3n,
  -3n,
  5n,
  -5n,
  10n,
  -10n,
  10n ** 10n,
  -(10n ** 10n),
  10n ** 1000n,
  -(10n ** 1000n),
  (1n << 64n) - 1n,
  -(1n << 64n),
  MAX_MAGNITUDE - 1n,
  MAX_MAGNITUDE,
  -MAX_MAGNITUDE,
  -(MAX_MAGNITUDE - 1n),
  ONE_PAST_LIMIT,
  -ONE_PAST_LIMIT,
  ONE_PAST_LIMIT + 1n,
  -(ONE_PAST_LIMIT + 1n),
);

const arbAnyInt = fc.oneof(
  { weight: 3, arbitrary: arbEdgeInt },
  { weight: 3, arbitrary: fc.bigInt(-1000n, 1000n) },
  { weight: 2, arbitrary: fc.bigInt(-(1n << 128n), 1n << 128n) },
  { weight: 1, arbitrary: fc.bigInt(MAX_MAGNITUDE - 16n, ONE_PAST_LIMIT + 16n) },
  { weight: 1, arbitrary: fc.bigInt(-(ONE_PAST_LIMIT + 16n), -(MAX_MAGNITUDE - 16n)) },
  { weight: 2, arbitrary: fc.bigInt(-(ONE_PAST_LIMIT * 2n), ONE_PAST_LIMIT * 2n) },
);

const arbDenominator = fc.oneof(
  { weight: 3, arbitrary: arbEdgeInt },
  { weight: 2, arbitrary: fc.bigInt(-20n, 20n) },
  { weight: 2, arbitrary: fc.bigInt(1n, 1000n) },
  { weight: 1, arbitrary: fc.bigInt(1n, 1n << 128n) },
  { weight: 1, arbitrary: fc.bigInt(1n, ONE_PAST_LIMIT * 2n) },
);

const arbAdmittedSignedInt = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.constantFrom(
      0n,
      1n,
      -1n,
      2n,
      -2n,
      3n,
      -3n,
      10n,
      -10n,
      10n ** 500n,
      10n ** 1000n,
      (1n << 63n) - 1n,
      -(1n << 63n),
      1n << 8192n,
      -(1n << 8192n),
      MAX_MAGNITUDE - 1n,
      MAX_MAGNITUDE,
      -MAX_MAGNITUDE,
    ),
  },
  { weight: 3, arbitrary: fc.bigInt(-1000n, 1000n) },
  { weight: 2, arbitrary: fc.bigInt(-(1n << 128n), 1n << 128n) },
  { weight: 1, arbitrary: fc.bigInt(MAX_MAGNITUDE - 32n, MAX_MAGNITUDE) },
  { weight: 1, arbitrary: fc.bigInt(-MAX_MAGNITUDE, -(MAX_MAGNITUDE - 32n)) },
  { weight: 2, arbitrary: fc.bigInt(-MAX_MAGNITUDE, MAX_MAGNITUDE) },
);

const arbAdmittedPositiveInt = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.constantFrom(
      1n,
      2n,
      3n,
      5n,
      10n,
      100n,
      10n ** 500n,
      10n ** 1000n,
      (1n << 63n) - 1n,
      1n << 8192n,
      MAX_MAGNITUDE - 1n,
      MAX_MAGNITUDE,
    ),
  },
  { weight: 3, arbitrary: fc.bigInt(1n, 1000n) },
  { weight: 2, arbitrary: fc.bigInt(1n, 1n << 128n) },
  { weight: 1, arbitrary: fc.bigInt(MAX_MAGNITUDE - 32n, MAX_MAGNITUDE) },
  { weight: 2, arbitrary: fc.bigInt(1n, MAX_MAGNITUDE) },
);

const arbRationalSpec: fc.Arbitrary<RationalSpec> = fc.record({
  numerator: arbAdmittedSignedInt,
  denominator: arbAdmittedPositiveInt,
  negate: fc.boolean(),
});

const arbAnyScale = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.constantFrom(
      -1000n,
      -2n,
      -1n,
      0n,
      1n,
      2n,
      10n,
      999n,
      MAX_DECIMAL_SCALE,
      MAX_DECIMAL_SCALE + 1n,
      MAX_DECIMAL_SCALE + 2n,
      MAX_MAGNITUDE,
      -MAX_MAGNITUDE,
      ONE_PAST_LIMIT,
      -ONE_PAST_LIMIT,
    ),
  },
  { weight: 3, arbitrary: fc.bigInt(-20n, MAX_DECIMAL_SCALE + 20n) },
  { weight: 1, arbitrary: fc.bigInt(-10000n, 10000n) },
);

const arbValidScale = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.constantFrom(0n, 1n, 2n, 4n, 10n, 100n, 999n, MAX_DECIMAL_SCALE),
  },
  { weight: 3, arbitrary: fc.bigInt(0n, MAX_DECIMAL_SCALE) },
);

const arbDecimalSpec: fc.Arbitrary<DecimalSpec> = fc.record({
  coefficient: arbAdmittedSignedInt,
  scale: arbValidScale,
  negate: fc.boolean(),
});

const rationalUnaryExamples: [RationalSpec][] = [
  [{ numerator: 0n, denominator: 1n, negate: false }],
  [{ numerator: 0n, denominator: 1n, negate: true }],
  [{ numerator: 1n, denominator: 1n, negate: true }],
  [{ numerator: -1n, denominator: 2n, negate: false }],
  [{ numerator: MAX_MAGNITUDE, denominator: 1n, negate: false }],
  [{ numerator: MAX_MAGNITUDE, denominator: 1n, negate: true }],
  [{ numerator: 1n, denominator: MAX_MAGNITUDE, negate: true }],
];

const rationalBinaryExamples: [RationalSpec, RationalSpec][] = [
  [
    { numerator: 0n, denominator: 1n, negate: false },
    { numerator: 0n, denominator: 1n, negate: false },
  ],
  [
    { numerator: 1n, denominator: 3n, negate: false },
    { numerator: 0n, denominator: 1n, negate: false },
  ],
  [
    { numerator: 1n, denominator: 1n << 10000n, negate: false },
    { numerator: 1n, denominator: 1n << 10000n, negate: false },
  ],
  [
    { numerator: 1n, denominator: 1n << 10000n, negate: false },
    { numerator: 1n, denominator: 1n << 10000n, negate: true },
  ],
  [
    { numerator: 1n << 10000n, denominator: 3n ** 10000n, negate: false },
    { numerator: 3n ** 10000n, denominator: 1n << 10000n, negate: false },
  ],
  [
    { numerator: 1n << 10000n, denominator: 3n ** 10000n, negate: false },
    { numerator: 1n << 10000n, denominator: 3n ** 10000n, negate: true },
  ],
  [
    { numerator: MAX_MAGNITUDE, denominator: 1n, negate: false },
    { numerator: 1n, denominator: 2n, negate: false },
  ],
  [
    { numerator: MAX_MAGNITUDE, denominator: MAX_MAGNITUDE - 1n, negate: true },
    { numerator: MAX_MAGNITUDE, denominator: MAX_MAGNITUDE - 1n, negate: false },
  ],
];

const decimalUnaryExamples: [DecimalSpec][] = [
  [{ coefficient: 0n, scale: 0n, negate: false }],
  [{ coefficient: 0n, scale: MAX_DECIMAL_SCALE, negate: true }],
  [{ coefficient: 1n, scale: MAX_DECIMAL_SCALE, negate: false }],
  [{ coefficient: -1234500n, scale: 4n, negate: false }],
  [{ coefficient: MAX_MAGNITUDE, scale: 0n, negate: false }],
  [{ coefficient: MAX_MAGNITUDE, scale: MAX_DECIMAL_SCALE, negate: true }],
  [{ coefficient: 10n ** 1000n, scale: MAX_DECIMAL_SCALE, negate: false }],
];

describe("Numeric Lean oracle equivalence", () => {
  let oracle: OracleClient;

  beforeAll(() => {
    oracle = OracleClient.start();
  });

  afterAll(async () => {
    await oracle.close();
  });

  test(
    "ExactRational.of matches Lean",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbAnyInt, arbDenominator, async (num, den) => {
          const tsOutcome = runTs(() => toRationalWire(ExactRational.of(num, den)));
          const leanOutcome = await oracle.call<RationalWire>("ExactRational.of", [
            num.toString(),
            den.toString(),
          ]);
          assertOutcomesEqual("ExactRational.of", `(${num}, ${den})`, tsOutcome, leanOutcome);
        }),
        {
          seed: SEED,
          numRuns: NUM_RUNS,
          examples: [
            [0n, 1n],
            [0n, 0n],
            [0n, -1n],
            [1n, 0n],
            [-1n, 0n],
            [1n, -1n],
            [-1n, -2n],
            [MAX_MAGNITUDE, 1n],
            [-MAX_MAGNITUDE, 1n],
            [1n, MAX_MAGNITUDE],
            [MAX_MAGNITUDE, MAX_MAGNITUDE],
            [ONE_PAST_LIMIT, 1n],
            [-ONE_PAST_LIMIT, 1n],
            [1n, ONE_PAST_LIMIT],
            [ONE_PAST_LIMIT, 2n],
            [0n, ONE_PAST_LIMIT],
          ],
        },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "ExactRational.zero matches Lean",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (i) => {
          const tsOutcome = runTs(() => toRationalWire(ExactRational.zero()));
          const leanOutcome = await oracle.call<RationalWire>("ExactRational.zero", []);
          assertOutcomesEqual("ExactRational.zero", `run#${i}`, tsOutcome, leanOutcome);
        }),
        { seed: SEED, numRuns: NUM_RUNS },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "ExactRational.negate matches Lean",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbRationalSpec, async (spec) => {
          const r = buildRational(spec);
          const wire = toRationalWire(r);
          const tsOutcome = runTs(() => toRationalWire(r.negate()));
          const leanOutcome = await oracle.call<RationalWire>("ExactRational.negate", [wire]);
          assertOutcomesEqual(
            "ExactRational.negate",
            `${wire.numerator}/${wire.denominator}`,
            tsOutcome,
            leanOutcome,
          );
        }),
        { seed: SEED, numRuns: NUM_RUNS, examples: rationalUnaryExamples },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "ExactRational.add matches Lean",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbRationalSpec, arbRationalSpec, async (specA, specB) => {
          const a = buildRational(specA);
          const b = buildRational(specB);
          const wireA = toRationalWire(a);
          const wireB = toRationalWire(b);
          const tsOutcome = runTs(() => toRationalWire(a.add(b)));
          const leanOutcome = await oracle.call<RationalWire>("ExactRational.add", [wireA, wireB]);
          assertOutcomesEqual(
            "ExactRational.add",
            `(${wireA.numerator}/${wireA.denominator}, ${wireB.numerator}/${wireB.denominator})`,
            tsOutcome,
            leanOutcome,
          );
        }),
        { seed: SEED, numRuns: NUM_RUNS, examples: rationalBinaryExamples },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "ExactRational.subtract matches Lean",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbRationalSpec, arbRationalSpec, async (specA, specB) => {
          const a = buildRational(specA);
          const b = buildRational(specB);
          const wireA = toRationalWire(a);
          const wireB = toRationalWire(b);
          const tsOutcome = runTs(() => toRationalWire(a.subtract(b)));
          const leanOutcome = await oracle.call<RationalWire>("ExactRational.subtract", [
            wireA,
            wireB,
          ]);
          assertOutcomesEqual(
            "ExactRational.subtract",
            `(${wireA.numerator}/${wireA.denominator}, ${wireB.numerator}/${wireB.denominator})`,
            tsOutcome,
            leanOutcome,
          );
        }),
        { seed: SEED, numRuns: NUM_RUNS, examples: rationalBinaryExamples },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "ExactRational.multiply matches Lean",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbRationalSpec, arbRationalSpec, async (specA, specB) => {
          const a = buildRational(specA);
          const b = buildRational(specB);
          const wireA = toRationalWire(a);
          const wireB = toRationalWire(b);
          const tsOutcome = runTs(() => toRationalWire(a.multiply(b)));
          const leanOutcome = await oracle.call<RationalWire>("ExactRational.multiply", [
            wireA,
            wireB,
          ]);
          assertOutcomesEqual(
            "ExactRational.multiply",
            `(${wireA.numerator}/${wireA.denominator}, ${wireB.numerator}/${wireB.denominator})`,
            tsOutcome,
            leanOutcome,
          );
        }),
        { seed: SEED, numRuns: NUM_RUNS, examples: rationalBinaryExamples },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "ExactRational.divide matches Lean",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbRationalSpec, arbRationalSpec, async (specA, specB) => {
          const a = buildRational(specA);
          const b = buildRational(specB);
          const wireA = toRationalWire(a);
          const wireB = toRationalWire(b);
          const tsOutcome = runTs(() => toRationalWire(a.divide(b)));
          const leanOutcome = await oracle.call<RationalWire>("ExactRational.divide", [
            wireA,
            wireB,
          ]);
          assertOutcomesEqual(
            "ExactRational.divide",
            `(${wireA.numerator}/${wireA.denominator}, ${wireB.numerator}/${wireB.denominator})`,
            tsOutcome,
            leanOutcome,
          );
        }),
        { seed: SEED, numRuns: NUM_RUNS, examples: rationalBinaryExamples },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "ExactRational.compare matches Lean",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbRationalSpec, arbRationalSpec, async (specA, specB) => {
          const a = buildRational(specA);
          const b = buildRational(specB);
          const wireA = toRationalWire(a);
          const wireB = toRationalWire(b);
          const tsOutcome = runTs(() => a.compare(b));
          const leanOutcome = await oracle.call<number>("ExactRational.compare", [wireA, wireB]);
          assertOutcomesEqual(
            "ExactRational.compare",
            `(${wireA.numerator}/${wireA.denominator}, ${wireB.numerator}/${wireB.denominator})`,
            tsOutcome,
            leanOutcome,
          );
        }),
        { seed: SEED, numRuns: NUM_RUNS, examples: rationalBinaryExamples },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "ExactRational.isNegative matches Lean",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbRationalSpec, async (spec) => {
          const r = buildRational(spec);
          const wire = toRationalWire(r);
          const tsOutcome = runTs(() => r.isNegative());
          const leanOutcome = await oracle.call<boolean>("ExactRational.isNegative", [wire]);
          assertOutcomesEqual(
            "ExactRational.isNegative",
            `${wire.numerator}/${wire.denominator}`,
            tsOutcome,
            leanOutcome,
          );
        }),
        { seed: SEED, numRuns: NUM_RUNS, examples: rationalUnaryExamples },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "ExactRational.abs matches Lean",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbRationalSpec, async (spec) => {
          const r = buildRational(spec);
          const wire = toRationalWire(r);
          const tsOutcome = runTs(() => toRationalWire(r.abs()));
          const leanOutcome = await oracle.call<RationalWire>("ExactRational.abs", [wire]);
          assertOutcomesEqual(
            "ExactRational.abs",
            `${wire.numerator}/${wire.denominator}`,
            tsOutcome,
            leanOutcome,
          );
        }),
        { seed: SEED, numRuns: NUM_RUNS, examples: rationalUnaryExamples },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "ExactRational.equals matches Lean",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbRationalSpec, arbRationalSpec, async (specA, specB) => {
          const a = buildRational(specA);
          const b = buildRational(specB);
          const wireA = toRationalWire(a);
          const wireB = toRationalWire(b);
          const tsOutcome = runTs(() => a.equals(b));
          const leanOutcome = await oracle.call<boolean>("ExactRational.equals", [wireA, wireB]);
          assertOutcomesEqual(
            "ExactRational.equals",
            `(${wireA.numerator}/${wireA.denominator}, ${wireB.numerator}/${wireB.denominator})`,
            tsOutcome,
            leanOutcome,
          );
        }),
        { seed: SEED, numRuns: NUM_RUNS, examples: rationalBinaryExamples },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "ExactRational.isZero matches Lean",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbRationalSpec, async (spec) => {
          const r = buildRational(spec);
          const wire = toRationalWire(r);
          const tsOutcome = runTs(() => r.isZero());
          const leanOutcome = await oracle.call<boolean>("ExactRational.isZero", [wire]);
          assertOutcomesEqual(
            "ExactRational.isZero",
            `${wire.numerator}/${wire.denominator}`,
            tsOutcome,
            leanOutcome,
          );
        }),
        { seed: SEED, numRuns: NUM_RUNS, examples: rationalUnaryExamples },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "ExactDecimal.of matches Lean",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbAnyInt, arbAnyScale, async (coeff, scale) => {
          const tsOutcome = runTs(() => toDecimalWire(ExactDecimal.of(coeff, scale)));
          const leanOutcome = await oracle.call<DecimalWire>("ExactDecimal.of", [
            coeff.toString(),
            scale.toString(),
          ]);
          assertOutcomesEqual("ExactDecimal.of", `(${coeff}, ${scale})`, tsOutcome, leanOutcome);
        }),
        {
          seed: SEED,
          numRuns: NUM_RUNS,
          examples: [
            [0n, 0n],
            [0n, -1n],
            [0n, MAX_DECIMAL_SCALE],
            [0n, MAX_DECIMAL_SCALE + 1n],
            [1n, MAX_DECIMAL_SCALE],
            [1n, MAX_DECIMAL_SCALE + 1n],
            [-1n, -1n],
            [MAX_MAGNITUDE, MAX_DECIMAL_SCALE],
            [-MAX_MAGNITUDE, MAX_DECIMAL_SCALE],
            [ONE_PAST_LIMIT, 0n],
            [-ONE_PAST_LIMIT, 0n],
            [ONE_PAST_LIMIT, MAX_DECIMAL_SCALE],
            [ONE_PAST_LIMIT, MAX_DECIMAL_SCALE + 1n],
            [ONE_PAST_LIMIT, -1n],
          ],
        },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "ExactDecimal.isZero matches Lean",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbDecimalSpec, async (spec) => {
          const d = buildDecimal(spec);
          const wire = toDecimalWire(d);
          const tsOutcome = runTs(() => d.isZero());
          const leanOutcome = await oracle.call<boolean>("ExactDecimal.isZero", [wire]);
          assertOutcomesEqual(
            "ExactDecimal.isZero",
            `(${wire.coefficient}, ${wire.scale})`,
            tsOutcome,
            leanOutcome,
          );
        }),
        { seed: SEED, numRuns: NUM_RUNS, examples: decimalUnaryExamples },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "ExactDecimal.negate matches Lean",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbDecimalSpec, async (spec) => {
          const d = buildDecimal(spec);
          const wire = toDecimalWire(d);
          const tsOutcome = runTs(() => toDecimalWire(d.negate()));
          const leanOutcome = await oracle.call<DecimalWire>("ExactDecimal.negate", [wire]);
          assertOutcomesEqual(
            "ExactDecimal.negate",
            `(${wire.coefficient}, ${wire.scale})`,
            tsOutcome,
            leanOutcome,
          );
        }),
        { seed: SEED, numRuns: NUM_RUNS, examples: decimalUnaryExamples },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "ExactDecimal.toRational matches Lean",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbDecimalSpec, async (spec) => {
          const d = buildDecimal(spec);
          const wire = toDecimalWire(d);
          const tsOutcome = runTs(() => toRationalWire(d.toRational()));
          const leanOutcome = await oracle.call<RationalWire>("ExactDecimal.toRational", [wire]);
          assertOutcomesEqual(
            "ExactDecimal.toRational",
            `(${wire.coefficient}, ${wire.scale})`,
            tsOutcome,
            leanOutcome,
          );
        }),
        { seed: SEED, numRuns: NUM_RUNS, examples: decimalUnaryExamples },
      );
    },
    TEST_TIMEOUT_MS,
  );
});

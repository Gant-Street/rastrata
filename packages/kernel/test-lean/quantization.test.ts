/**
 * The arithmetic of rounding, the Lean model (`proofs/Rastrata/Kernel/Quantization.lean`) run
 * against `src/quantization.ts` on the same inputs: `roundedCoefficient`, `quantize` and
 * `quantizeCumulativePostedShare`.
 *
 * The model is written over the two fields the arithmetic reads, the target scale and the
 * rounding mode (a `QuantizationRule`); the TypeScript is given a whole policy whose other fields
 * are the same on every call.
 *
 * `roundedCoefficient` is not exported. It is reached through `quantize`, which calls it with
 * `value.numerator * 10^scale` and `value.denominator`, and shows its answer as the coefficient of
 * the amount; so the test gives the model's own `roundedCoefficient` those two numbers and
 * compares what it answers with that coefficient.
 *
 * The errors compared: an `ExactNumberError` by its code; the `RangeError` of `quantize` for a
 * scale outside 0 to 1000 as `quantization_scale_out_of_range`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  ExactDecimal,
  ExactRational,
  type RoundingMode,
  quantize,
  quantizeCumulativePostedShare,
} from "../src/index.ts";
import { OracleClient, type OracleOutcome } from "./oracle-client.ts";
import {
  LIMIT_VALUES,
  HALF,
  ONE,
  type QuantizeCase,
  type ShareCase,
  ZERO,
  arbAdmittedCase,
  arbQuantizeCase,
  arbShareCase,
  describeCase,
  describeShare,
  policyOf,
  quantizeExamples,
  rational,
  ruleOf,
  shareExamples,
} from "./wave2a-quant.ts";
import {
  NUM_RUNS,
  ROUNDING_MODES,
  SEED,
  TEST_TIMEOUT_MS,
  type SweepCase,
  assertSame,
  clip,
  count,
  counted,
  decWire,
  printCounts,
  quantizedWire,
  ratWire,
  ruleWire,
  runTs,
  shareWire,
  sweep,
} from "./wave2a-wire.ts";

// ---------------------------------------------------------------------------------------------
// Both sides
// ---------------------------------------------------------------------------------------------

const tsQuantize = (c: QuantizeCase) =>
  runTs(() => quantizedWire(quantize(c.value, policyOf(c.scale, c.mode))));

type ShareWire = Record<string, unknown>;

/** The TypeScript's answer in the model's terms: the share and its rule, or the reason, read from
 * the path of the one diagnostic the rejection carries. */
function tsShare(c: ShareCase): OracleOutcome<ShareWire> {
  return runTs((): ShareWire => {
    const policy = policyOf(c.scale, c.mode);
    const result = quantizeCumulativePostedShare(c.total, c.before, c.after, policy);
    if (result.disposition === "rejected") {
      const only = result.diagnostics[0];
      if (
        result.diagnostics.length !== 1 ||
        only === undefined ||
        only.code !== "invalid_exact_number"
      ) {
        throw new Error(`unexpected diagnostics ${JSON.stringify(result.diagnostics)}`);
      }
      const reason =
        only.path === "cumulativePostedShare"
          ? "invalidShare"
          : only.path === "cumulativePostedShare.postedTotal"
            ? "totalNotRepresentable"
            : `unexpected path ${only.path}`;
      return { disposition: "rejected", reason };
    }
    return {
      disposition: "quantized",
      share: { ...shareWire(result.share), rule: ruleWire(result.share.policy) },
    };
  });
}

const leanShare = (c: ShareCase) =>
  oracleOf().call<ShareWire>("quantization.quantizeCumulativePostedShare", [
    decWire(c.total),
    ratWire(c.before),
    ratWire(c.after),
    ruleOf(c.scale, c.mode),
  ]);

// The oracle is started once for the file.
let theOracle: OracleClient | undefined;
function oracleOf(): OracleClient {
  if (theOracle === undefined) throw new Error("the oracle is not started");
  return theOracle;
}

// ---------------------------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------------------------

describe("Quantization Lean oracle equivalence", () => {
  beforeAll(() => {
    theOracle = OracleClient.start(process.env.ORACLE_BINARY);
  });

  afterAll(async () => {
    await theOracle?.close();
    printCounts();
  });

  const tallyQuantize = (
    c: QuantizeCase,
    outcome: OracleOutcome<{ residual: { numerator: string } }>,
  ) => {
    if (outcome.kind === "error") {
      count(`quantize: ${outcome.code}`);
    } else if (outcome.value.residual.numerator === "0") {
      count("quantize: exact");
    } else {
      count("quantize: rounded");
      count(`quantize: rounded, ${c.mode}`);
    }
  };

  test(
    "quantize matches Lean",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbQuantizeCase, async (c) => {
          const tsOutcome = tsQuantize(c);
          const leanOutcome = await oracleOf().call<ReturnType<typeof quantizedWire>>(
            "quantization.quantize",
            [ratWire(c.value), ruleOf(c.scale, c.mode)],
          );
          assertSame("quantization.quantize", describeCase(c), tsOutcome, leanOutcome);
          count("quantize");
          tallyQuantize(c, tsOutcome);
        }),
        {
          seed: SEED,
          numRuns: NUM_RUNS * 2 + quantizeExamples.length,
          examples: quantizeExamples,
        },
      );
      expect(counted("quantize: exact")).toBeGreaterThanOrEqual(100);
      expect(counted("quantize: rounded")).toBeGreaterThanOrEqual(100);
      for (const mode of ROUNDING_MODES) {
        expect(counted(`quantize: rounded, ${mode}`)).toBeGreaterThanOrEqual(100);
      }
      expect(counted("quantize: quantization_scale_out_of_range")).toBeGreaterThanOrEqual(100);
      expect(counted("quantize: representation_limit_exceeded")).toBeGreaterThanOrEqual(100);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "quantize matches Lean on every small value, at every scale to eight, in every mode",
    async () => {
      const total = await sweep(
        oracleOf(),
        "quantization.quantize",
        "quantize: every small value",
        (function* (): Generator<SweepCase> {
          for (let numerator = -60; numerator <= 60; numerator++) {
            for (let denominator = 1; denominator <= 30; denominator++) {
              const value = ExactRational.of(BigInt(numerator), BigInt(denominator));
              for (let scale = 0; scale <= 8; scale++) {
                for (const mode of ROUNDING_MODES) {
                  const c = { value, scale: BigInt(scale), mode };
                  yield {
                    args: [ratWire(value), ruleOf(c.scale, mode)],
                    ts: () => tsQuantize(c),
                    show: () => describeCase(c),
                  };
                }
              }
            }
          }
        })(),
      );
      expect(total).toBe(121 * 30 * 9 * 5);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "quantize matches Lean at every scale from -3 to 1003, in every mode, on values near the size limit",
    async () => {
      const values = [
        ...LIMIT_VALUES,
        rational(1n, 7n),
        rational(-22n, 7n),
        rational(10n ** 300n + 1n, 3n),
        rational(5n, 2n),
      ];
      const total = await sweep(
        oracleOf(),
        "quantization.quantize",
        "quantize: every scale",
        (function* (): Generator<SweepCase> {
          for (const value of values) {
            for (let scale = -3; scale <= 1003; scale++) {
              const mode = ROUNDING_MODES[(scale + 3 + values.indexOf(value)) % 5] as RoundingMode;
              const c = { value, scale: BigInt(scale), mode };
              yield {
                args: [ratWire(value), ruleOf(c.scale, mode)],
                ts: () => tsQuantize(c),
                show: () => describeCase(c),
              };
            }
          }
        })(),
        (outcome) => {
          count(
            outcome.kind === "ok"
              ? "quantize: every scale, answered"
              : `quantize: every scale, ${outcome.code}`,
          );
        },
      );
      expect(total).toBe(values.length * 1007);
      expect(counted("quantize: every scale, answered")).toBeGreaterThan(1000);
      expect(counted("quantize: every scale, quantization_scale_out_of_range")).toBeGreaterThan(
        100,
      );
      expect(counted("quantize: every scale, representation_limit_exceeded")).toBeGreaterThan(100);
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------------------------
  // roundedCoefficient
  // -------------------------------------------------------------------------------------------

  /** What `quantize` hands `roundedCoefficient`: the numerator times ten to the scale, and the
   * denominator, both of the value in lowest terms. */
  const handed = (c: QuantizeCase) => ({
    numerator: c.value.numerator * 10n ** c.scale,
    denominator: c.value.denominator,
  });

  test(
    "roundedCoefficient matches the coefficient the TypeScript's quantize makes of it",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbAdmittedCase, async (c) => {
          let coefficient: bigint;
          try {
            coefficient = quantize(c.value, policyOf(c.scale, c.mode)).amount.coefficient;
          } catch {
            return; // it threw after, or before, rounding: `quantize` covers that
          }
          const { numerator, denominator } = handed(c);
          const leanOutcome = await oracleOf().call<string>("quantization.roundedCoefficient", [
            numerator.toString(),
            denominator.toString(),
            c.mode,
          ]);
          assertSame(
            "quantization.roundedCoefficient",
            clip(`${numerator} over ${denominator}, ${c.mode}`),
            { kind: "ok", value: coefficient.toString() },
            leanOutcome,
          );
          count("roundedCoefficient");
          count(`roundedCoefficient: ${c.mode}`);
        }),
        { seed: SEED + 1, numRuns: NUM_RUNS * 2, examples: quantizeExamples },
      );
      for (const mode of ROUNDING_MODES) {
        expect(counted(`roundedCoefficient: ${mode}`)).toBeGreaterThanOrEqual(100);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "roundedCoefficient matches for every numerator from -130 to 130 and denominator to 40, in every mode",
    async () => {
      const total = await sweep(
        oracleOf(),
        "quantization.roundedCoefficient",
        "roundedCoefficient: every small quotient",
        (function* (): Generator<SweepCase> {
          for (let numerator = -130; numerator <= 130; numerator++) {
            for (let denominator = 1; denominator <= 40; denominator++) {
              const value = ExactRational.of(BigInt(numerator), BigInt(denominator));
              for (const scale of [0n, 1n, 2n]) {
                for (const mode of ROUNDING_MODES) {
                  const c = { value, scale, mode };
                  const { numerator: handedNumerator, denominator: handedDenominator } = handed(c);
                  yield {
                    args: [handedNumerator.toString(), handedDenominator.toString(), mode],
                    ts: () => {
                      const answered = quantize(value, policyOf(scale, mode)).amount.coefficient;
                      return { kind: "ok", value: answered.toString() };
                    },
                    show: () => `${handedNumerator} over ${handedDenominator}, ${mode}`,
                  };
                }
              }
            }
          }
        })(),
      );
      expect(total).toBe(261 * 40 * 3 * 5);
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------------------------
  // quantizeCumulativePostedShare
  // -------------------------------------------------------------------------------------------

  test(
    "quantizeCumulativePostedShare matches Lean",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbShareCase, async (c) => {
          const tsOutcome = tsShare(c);
          const leanOutcome = await leanShare(c);
          assertSame(
            "quantization.quantizeCumulativePostedShare",
            describeShare(c),
            tsOutcome,
            leanOutcome,
          );
          count("quantizeCumulativePostedShare");
          if (tsOutcome.kind === "error") count(`share: ${tsOutcome.code}`);
          else if (tsOutcome.value.disposition === "rejected")
            count(`share: rejected, ${tsOutcome.value.reason}`);
          else {
            count("share: quantized");
            count(`share: quantized, ${c.mode}`);
          }
        }),
        { seed: SEED, numRuns: NUM_RUNS * 2 + shareExamples.length, examples: shareExamples },
      );
      expect(counted("share: quantized")).toBeGreaterThanOrEqual(100);
      for (const mode of ROUNDING_MODES) {
        expect(counted(`share: quantized, ${mode}`)).toBeGreaterThanOrEqual(100);
      }
      expect(counted("share: rejected, invalidShare")).toBeGreaterThanOrEqual(100);
      expect(counted("share: rejected, totalNotRepresentable")).toBeGreaterThanOrEqual(100);
      expect(counted("share: representation_limit_exceeded")).toBeGreaterThanOrEqual(100);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "quantizeCumulativePostedShare matches Lean for every pair of fractions from a grid, at several scales",
    async () => {
      const grid: ExactRational[] = [];
      for (let denominator = 1; denominator <= 6; denominator++) {
        for (let numerator = -2; numerator <= 2 * denominator; numerator++) {
          grid.push(rational(BigInt(numerator), BigInt(denominator)));
        }
      }
      const unique = [
        ...new Map(
          grid.map((value) => [`${value.numerator}/${value.denominator}`, value]),
        ).values(),
      ];
      const totals = [
        ExactDecimal.of(1000n, 2n),
        ExactDecimal.of(1n, 0n),
        ExactDecimal.of(999n, 2n),
        ExactDecimal.of(12345n, 4n),
        ExactDecimal.of(0n, 3n),
      ];
      const total = await sweep(
        oracleOf(),
        "quantization.quantizeCumulativePostedShare",
        "quantizeCumulativePostedShare: every pair from a grid",
        (function* (): Generator<SweepCase> {
          let turn = 0;
          for (const before of unique) {
            for (const after of unique) {
              const posted = totals[turn % totals.length] as ExactDecimal;
              const mode = ROUNDING_MODES[turn % 5] as RoundingMode;
              const scale = BigInt(turn % 5);
              turn++;
              const c = { total: posted, before, after, scale, mode };
              yield {
                args: [decWire(posted), ratWire(before), ratWire(after), ruleOf(scale, mode)],
                ts: () => tsShare(c),
                show: () => describeShare(c),
              };
            }
          }
        })(),
      );
      expect(total).toBe(unique.length ** 2);
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------------------------
  // What the model's notes say the TypeScript does, said of the TypeScript alone
  // -------------------------------------------------------------------------------------------

  test("the TypeScript does what the model's notes on rounding say", () => {
    // `quantize` throws a `RangeError`, with no code, for a scale outside 0 to 1000;
    // `quantizeCumulativePostedShare` rejects the same scale.
    for (const scale of [-1n, 1001n]) {
      expect(() => quantize(rational(1n, 3n), policyOf(scale, "floor"))).toThrow(
        new RangeError("Quantization scale must be between 0 and 1000"),
      );
      const share = quantizeCumulativePostedShare(
        ExactDecimal.of(100n, 2n),
        ZERO,
        ONE,
        policyOf(scale, "floor"),
      );
      expect(share.disposition).toBe("rejected");
    }
    // `quantize` throws when the subtraction that makes the residual multiplies the two
    // denominators beyond the limit: 1/2^16383 at scale 2, rounded up. Rounded down it does not.
    const tiny = rational(1n, 1n << 16383n);
    expect(runTs(() => quantize(tiny, policyOf(2n, "ceiling")))).toEqual({
      kind: "error",
      code: "representation_limit_exceeded",
    });
    expect(runTs(() => quantize(tiny, policyOf(2n, "floor"))).kind).toBe("ok");
    // `quantizeCumulativePostedShare` throws, and does not reject, when the total times a fraction
    // has a denominator beyond the limit before it is reduced.
    expect(
      runTs(() =>
        quantizeCumulativePostedShare(
          ExactDecimal.of(5n, 1n),
          ZERO,
          tiny,
          policyOf(1n, "halfEven"),
        ),
      ),
    ).toEqual({ kind: "error", code: "representation_limit_exceeded" });
    // With half even a posted amount can be exactly one unit from its exact share: of a total of 2
    // at scale 0 the share between 1/4 and 3/4 is 1, and 2 is posted. In floor it is 1.
    for (const [mode, posted] of [
      ["halfEven", 2n],
      ["floor", 1n],
      ["ceiling", 1n],
      ["towardZero", 1n],
      ["halfAwayFromZero", 1n],
    ] as const) {
      const result = quantizeCumulativePostedShare(
        ExactDecimal.of(2n, 0n),
        rational(1n, 4n),
        rational(3n, 4n),
        policyOf(0n, mode),
      );
      expect(result.disposition).toBe("quantized");
      if (result.disposition === "quantized")
        expect(result.share.postedAmount.coefficient).toBe(posted);
    }
    // It does not test that the first fraction is zero, or that the last is one.
    expect(
      quantizeCumulativePostedShare(
        ExactDecimal.of(100n, 2n),
        rational(1n, 3n),
        HALF,
        policyOf(2n, "floor"),
      ).disposition,
    ).toBe("quantized");
    count("pinned: rounding");
  });

  // -------------------------------------------------------------------------------------------
  // Known differences. Each of these fails today, and is marked so: when the model or the
  // TypeScript changes and one of them starts to pass, the suite fails and says which.
  // -------------------------------------------------------------------------------------------

  describe("known differences between the model and the TypeScript", () => {
    // INPUT CLASS THE MODEL CANNOT REPRESENT (kind c). `RoundingMode` in Lean has the five modes
    // and no other value (`Quantization.lean` line 21), as the TypeScript's type has. At run time
    // the TypeScript takes any string. `quantizeCumulativePostedShare` rejects another mode with
    // the diagnostic at `cumulativePostedShare` (the model says so in its doc comment at line
    // 118), and `quantize` does not look at the mode when nothing is left over, and otherwise
    // reaches the end of the `switch` of `roundedCoefficient` and hands `undefined` to
    // `ExactDecimal.of`, which throws a `TypeError`.
    test.failing("quantizeCumulativePostedShare: the TypeScript rejects a rounding mode outside the five, the model has none", async () => {
      const policy = { ...policyOf(2n, "floor"), roundingMode: "bankers" as RoundingMode };
      const result = quantizeCumulativePostedShare(ExactDecimal.of(100n, 2n), ZERO, ONE, policy);
      expect(result.disposition).toBe("rejected");
      await oracleOf().call("quantization.quantizeCumulativePostedShare", [
        decWire(ExactDecimal.of(100n, 2n)),
        ratWire(ZERO),
        ratWire(ONE),
        { targetScale: "2", roundingMode: "bankers" },
      ]);
    });

    test.failing("quantize: the TypeScript throws a TypeError for a rounding mode outside the five when something is left over, the model has none", async () => {
      const policy = { ...policyOf(0n, "floor"), roundingMode: "bankers" as RoundingMode };
      expect(() => quantize(rational(1n, 2n), policy)).toThrow(TypeError);
      await oracleOf().call("quantization.quantize", [
        ratWire(rational(1n, 2n)),
        { targetScale: "0", roundingMode: "bankers" },
      ]);
    });
  });

  test("every function was compared on at least 2,000 generated cases", () => {
    for (const name of ["quantize", "roundedCoefficient", "quantizeCumulativePostedShare"]) {
      expect(counted(name)).toBeGreaterThanOrEqual(NUM_RUNS);
    }
  });
});

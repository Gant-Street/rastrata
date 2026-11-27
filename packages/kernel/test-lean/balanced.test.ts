/**
 * Rounding that balances, the Lean model (`proofs/Rastrata/Kernel/QuantizationBalanced.lean`) run
 * against `src/quantization.ts` on the same inputs: `hashQuantizationPolicy`,
 * `quantizeBalancedBookValues`, and `quantizeCumulativePostedShare` over the whole policy (the
 * model's `QuantizationPolicy.quantizeCumulativePostedShare`).
 *
 * What is compared is what the TypeScript returns, in the wire of `proofs/Oracle/Wave2a.lean`: the
 * book values, the rounding posting, the share and the policy it carries, and for a rejection the
 * diagnostics in order, each with its code, its path, its message and its requirement identifiers.
 * An `ExactNumberError` is compared by its code. A policy's fields are texts; the TypeScript does
 * not check them, so the policies here have identifiers and dates of every kind, valid or not.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  type ExactRational,
  type QuantizationPolicy,
  type RoundingMode,
  hashQuantizationPolicy,
  quantizeBalancedBookValues,
  quantizeCumulativePostedShare,
} from "../src/index.ts";
import { OracleClient, type OracleOutcome } from "./oracle-client.ts";
import {
  LIMIT_VALUES,
  ONE,
  type ShareCase,
  ZERO,
  arbScale,
  arbShareCase,
  arbValueFor,
  describeShare,
  rational,
  shareExamples,
} from "./wave2a-quant.ts";
import {
  MAX_MAGNITUDE,
  NUM_RUNS,
  ROUNDING_MODES,
  SEED,
  TEST_TIMEOUT_MS,
  type SweepCase,
  arbAdmitted,
  arbIdentifierText,
  arbMode,
  arbNoise,
  arbSigned,
  arbValidDateParts,
  assertSame,
  balancedWire,
  chr,
  clip,
  count,
  counted,
  decWire,
  diagnosticWire,
  formatDate,
  hashWire,
  policyWire,
  printCounts,
  ratWire,
  runTs,
  shareWire,
  sweep,
  textToWire,
} from "./wave2a-wire.ts";

// ---------------------------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------------------------

interface PolicyFields {
  readonly id: string;
  readonly version: string;
  readonly bookId: string;
  readonly functionalCommodityId: string;
  readonly validFrom: string;
  readonly validTo: string | undefined;
  readonly roundingAccountId: string;
  /** Hand the TypeScript a `validTo` that is there and `undefined`, not one that is missing. */
  readonly explicitUndefined: boolean;
}

const arbDate: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: arbValidDateParts.map(formatDate) },
  { weight: 1, arbitrary: arbNoise },
);

const arbPolicyFields: fc.Arbitrary<PolicyFields> = fc.record({
  id: fc.oneof(arbIdentifierText, arbNoise),
  version: fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom("1.0.0", "0.0.1", "2.10.3-rc.1") },
    { weight: 1, arbitrary: arbNoise },
  ),
  bookId: fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom("book-1", "book-2") },
    { weight: 1, arbitrary: arbIdentifierText },
    { weight: 1, arbitrary: arbNoise },
  ),
  functionalCommodityId: fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom("USD", "EUR") },
    { weight: 1, arbitrary: arbIdentifierText },
    { weight: 1, arbitrary: arbNoise },
  ),
  validFrom: arbDate,
  validTo: fc.option(arbDate, { nil: undefined }),
  roundingAccountId: fc.oneof(arbIdentifierText, arbNoise),
  explicitUndefined: fc.boolean(),
});

/** A policy of the TypeScript's type from fields that may not be valid: nothing reads them. */
function buildPolicy(
  fields: PolicyFields,
  targetScale: bigint,
  roundingMode: RoundingMode,
): QuantizationPolicy {
  const base = {
    id: fields.id,
    version: fields.version,
    bookId: fields.bookId,
    functionalCommodityId: fields.functionalCommodityId,
    validFrom: fields.validFrom,
    targetScale,
    roundingMode,
    roundingAccountId: fields.roundingAccountId,
  };
  const policy =
    fields.validTo !== undefined
      ? { ...base, validTo: fields.validTo }
      : fields.explicitUndefined
        ? { ...base, validTo: undefined }
        : base;
  return policy as unknown as QuantizationPolicy;
}

const describePolicy = (policy: QuantizationPolicy) => clip(JSON.stringify(policyWire(policy)));

// ---------------------------------------------------------------------------------------------
// Values that add up to nothing, and those that do not
// ---------------------------------------------------------------------------------------------

function sumOrUndefined(parts: readonly ExactRational[]): ExactRational | undefined {
  try {
    return parts.reduce((total, value) => total.add(value), ZERO);
  } catch {
    return undefined;
  }
}

const arbPermutation = <T>(items: T[]): fc.Arbitrary<T[]> =>
  fc.shuffledSubarray(items, { minLength: items.length, maxLength: items.length });

/** The values a journal rounds: often exactly the ties, thirds and thousandths that leave a
 * remainder when rounded. */
const CLASSIC: ExactRational[][] = [
  [],
  [ZERO],
  [ZERO, ZERO],
  [rational(1n, 3n), rational(1n, 3n), rational(-2n, 3n)],
  [rational(1n, 3n), rational(1n, 3n), rational(1n, 3n), rational(-1n, 1n)],
  [rational(2n, 3n), rational(2n, 3n), rational(2n, 3n), rational(-2n, 1n)],
  [rational(1n, 1000n), rational(-1n, 1000n)],
  [rational(1n, 200n), rational(1n, 200n), rational(-1n, 100n)],
  [rational(1n, 2n), rational(1n, 2n), rational(-1n, 1n)],
  [rational(5n, 2n), rational(-5n, 2n)],
  [rational(3n, 2n), rational(5n, 2n), rational(-4n, 1n)],
  [
    rational(1n, 7n),
    rational(1n, 7n),
    rational(1n, 7n),
    rational(1n, 7n),
    rational(1n, 7n),
    rational(1n, 7n),
    rational(1n, 7n),
    rational(-1n, 1n),
  ],
  [rational(1n, 1n), rational(-1n, 1n)],
  [rational(1n, 3n)],
  [rational(100n, 1n), rational(-1n, 3n), rational(-299n, 3n)],
  [rational(1n, 100n), rational(1n, 100n), rational(1n, 100n), rational(-3n, 100n)],
  [rational(1n, 1000n), rational(1n, 1000n), rational(1n, 1000n), rational(-3n, 1000n)],
];

const BIG_A: bigint[] = [
  1n << 16383n,
  (1n << 16383n) + 1n,
  MAX_MAGNITUDE,
  1n << 16382n,
  (1n << 16383n) - 1n,
  3n ** 10000n,
];

/** Values at the size limit: balanced multisets of numbers a bit more than half the limit, in
 * every order, so that a running total goes beyond it in some and not in others. */
const arbLimitSet: fc.Arbitrary<ExactRational[]> = fc
  .tuple(fc.constantFrom(...BIG_A), fc.constantFrom(...BIG_A), fc.integer({ min: 0, max: 7 }))
  .chain(([a, b, shape]) => {
    const big = (n: bigint) => rational(n, 1n);
    const sets: ExactRational[][] = [
      [big(a), big(a), big(-a), big(-a)],
      [big(a), big(a), big(a), big(-a), big(-a), big(-a)],
      [big(a), big(b), big(-a), big(-b)],
      [big(a), big(-a)],
      [big(a), big(1n), big(-a), big(-1n)],
      [big(a), rational(1n, 3n), big(-a), rational(-1n, 3n)],
      [big(a), big(a), big(-a), big(-a), rational(1n, 3n), rational(-1n, 3n)],
      [rational(1n, 1n << 16383n), rational(-1n, 1n << 16383n)],
    ];
    return arbPermutation(sets[shape] as ExactRational[]);
  });

/** Values for a scale: balanced (and in any order), not balanced, the classic ones, the limit's. */
function arbValueSet(scale: bigint): fc.Arbitrary<ExactRational[]> {
  const place = scale >= 0n && scale <= 1000n ? scale : 2n;
  return fc.oneof(
    {
      weight: 8,
      arbitrary: fc.array(arbValueFor(place), { minLength: 0, maxLength: 6 }).chain((parts) => {
        const total = sumOrUndefined(parts);
        return arbPermutation(total === undefined ? parts : [...parts, total.negate()]);
      }),
    },
    { weight: 2, arbitrary: fc.array(arbValueFor(place), { minLength: 1, maxLength: 5 }) },
    {
      weight: 2,
      arbitrary: fc.array(arbValueFor(place), { minLength: 1, maxLength: 5 }).chain((parts) => {
        const total = sumOrUndefined(parts);
        const balanced = total === undefined ? parts : [...parts, total.negate()];
        // One value dropped, or a thousandth too many.
        return fc.constantFrom(
          balanced.slice(1),
          [...balanced, rational(1n, 1000n)],
          [...balanced, rational(-1n, 7n)],
        );
      }),
    },
    { weight: 3, arbitrary: arbLimitSet },
    { weight: 4, arbitrary: fc.constantFrom(...CLASSIC) },
    {
      weight: 1,
      arbitrary: fc
        .array(fc.constantFrom(...LIMIT_VALUES), { minLength: 1, maxLength: 3 })
        .chain((parts) => {
          const total = sumOrUndefined(parts);
          return arbPermutation(total === undefined ? parts : [...parts, total.negate()]);
        }),
    },
  );
}

interface BalancedCase {
  readonly values: ExactRational[];
  readonly book: string;
  readonly commodity: string;
  readonly policy: QuantizationPolicy;
}

/** Which of the call's book and commodity the policy shares. */
const arbMatch = fc.constantFrom(
  "both",
  "both",
  "both",
  "both",
  "both",
  "book",
  "commodity",
  "neither",
);

const arbBalancedCase: fc.Arbitrary<BalancedCase> = fc
  .tuple(
    arbScale,
    arbMode,
    arbPolicyFields,
    arbMatch,
    fc.constantFrom("book-1", "book-2"),
    fc.constantFrom("USD", "EUR"),
  )
  .chain(([scale, mode, fields, match, book, commodity]) =>
    arbValueSet(scale).map((values): BalancedCase => {
      const other = (id: string) => (id === "book-1" ? "book-2" : id === "USD" ? "EUR" : `${id}x`);
      const policyFields: PolicyFields = {
        ...fields,
        bookId: match === "both" || match === "commodity" ? book : other(book),
        functionalCommodityId: match === "both" || match === "book" ? commodity : other(commodity),
      };
      return { values, book, commodity, policy: buildPolicy(policyFields, scale, mode) };
    }),
  );

const describeBalanced = (c: BalancedCase) =>
  clip(
    `values ${c.values.map((value) => `${value.numerator}/${value.denominator}`).join(", ")}; book ${c.book}, commodity ${c.commodity}; policy ${describePolicy(c.policy)}`,
  );

const tsBalanced = (c: BalancedCase) =>
  runTs(() =>
    balancedWire(
      quantizeBalancedBookValues(c.values, c.book as never, c.commodity as never, c.policy),
    ),
  );

const balancedArgs = (c: BalancedCase) => [
  c.values.map(ratWire),
  textToWire(c.book),
  textToWire(c.commodity),
  policyWire(c.policy),
];

const policyFor = (scale: bigint, mode: RoundingMode, book = "book-1", commodity = "USD") =>
  buildPolicy(
    {
      id: "quantization-1",
      version: "1.0.0",
      bookId: book,
      functionalCommodityId: commodity,
      validFrom: "2000-01-01",
      validTo: undefined,
      roundingAccountId: "rounding",
      explicitUndefined: false,
    },
    scale,
    mode,
  );

const balancedExamples: [BalancedCase][] = [
  ...CLASSIC.flatMap((values) =>
    (
      [
        ["halfEven", 2n],
        ["floor", 0n],
        ["ceiling", 2n],
        ["towardZero", 1n],
        ["halfAwayFromZero", 3n],
      ] as const
    ).map(([mode, scale]): [BalancedCase] => [
      { values, book: "book-1", commodity: "USD", policy: policyFor(scale, mode) },
    ]),
  ),
  // The same values, the policy of another book, of another commodity, with a scale not admitted.
  ...[
    policyFor(2n, "halfEven", "book-2"),
    policyFor(2n, "halfEven", "book-1", "EUR"),
    policyFor(-1n, "halfEven"),
    policyFor(1001n, "halfEven", "book-2"),
    policyFor(1001n, "halfEven", "book-1", "EUR"),
    policyFor(1000n, "halfEven"),
    policyFor(0n, "halfEven"),
  ].map((policy): [BalancedCase] => [
    { values: CLASSIC[3] as ExactRational[], book: "book-1", commodity: "USD", policy },
  ]),
  // Values that do not add up.
  ...[[rational(1n, 3n)], [rational(1n, 3n), rational(1n, 3n)], [ONE, ONE]].map(
    (values): [BalancedCase] => [
      { values, book: "book-1", commodity: "USD", policy: policyFor(2n, "halfEven") },
    ],
  ),
  // The order decides whether balanced values at the size limit are taken.
  ...[
    [1n << 16383n, 1n << 16383n, -(1n << 16383n), -(1n << 16383n)],
    [1n << 16383n, -(1n << 16383n), 1n << 16383n, -(1n << 16383n)],
    [-(1n << 16383n), -(1n << 16383n), 1n << 16383n, 1n << 16383n],
  ].map((numbers): [BalancedCase] => [
    {
      values: numbers.map((n) => rational(n, 1n)),
      book: "book-1",
      commodity: "USD",
      policy: policyFor(0n, "halfEven"),
    },
  ]),
];

// ---------------------------------------------------------------------------------------------
// Shares over the whole policy
// ---------------------------------------------------------------------------------------------

interface FullShareCase extends ShareCase {
  readonly fields: PolicyFields;
}

const arbFullShareCase: fc.Arbitrary<FullShareCase> = fc
  .tuple(arbShareCase, arbPolicyFields)
  .map(([c, fields]) => ({ ...c, fields }));

const fullPolicy = (c: FullShareCase) => buildPolicy(c.fields, c.scale, c.mode);

type ShareWire = Record<string, unknown>;

const tsPolicyShare = (c: FullShareCase): OracleOutcome<ShareWire> =>
  runTs((): ShareWire => {
    const result = quantizeCumulativePostedShare(c.total, c.before, c.after, fullPolicy(c));
    if (result.disposition === "rejected") {
      return { disposition: "rejected", diagnostics: result.diagnostics.map(diagnosticWire) };
    }
    return {
      disposition: "quantized",
      share: { ...shareWire(result.share), policy: policyWire(result.share.policy) },
    };
  });

// ---------------------------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------------------------

describe("Balanced quantization Lean oracle equivalence", () => {
  let oracle: OracleClient;

  beforeAll(() => {
    oracle = OracleClient.start(process.env.ORACLE_BINARY);
  });

  afterAll(async () => {
    await oracle.close();
    printCounts();
  });

  // -------------------------------------------------------------------------------------------
  // hashQuantizationPolicy
  // -------------------------------------------------------------------------------------------

  const arbHashedPolicy: fc.Arbitrary<QuantizationPolicy> = fc
    .tuple(
      arbPolicyFields,
      fc.oneof(
        { weight: 5, arbitrary: arbScale },
        { weight: 3, arbitrary: arbSigned },
        { weight: 1, arbitrary: arbAdmitted },
      ),
      arbMode,
    )
    .map(([fields, scale, mode]) => buildPolicy(fields, scale, mode));

  test(
    "hashQuantizationPolicy matches Lean",
    async () => {
      const examples: [QuantizationPolicy][] = [
        ...ROUNDING_MODES.map((mode): [QuantizationPolicy] => [policyFor(2n, mode)]),
        [policyFor(0n, "halfEven")],
        [policyFor(1000n, "floor")],
        [policyFor(-1n, "floor")],
        [policyFor(MAX_MAGNITUDE, "floor")],
        [policyFor(-MAX_MAGNITUDE, "floor")],
        [buildPolicy({ ...fieldsOf(policyFor(2n, "floor")), validTo: "2030-01-01" }, 2n, "floor")],
        [
          buildPolicy(
            { ...fieldsOf(policyFor(2n, "floor")), explicitUndefined: true },
            2n,
            "floor",
          ),
        ],
        [
          buildPolicy(
            {
              ...fieldsOf(policyFor(2n, "floor")),
              id: "",
              version: "",
              bookId: "",
              functionalCommodityId: "",
              validFrom: "",
              roundingAccountId: "",
            },
            2n,
            "floor",
          ),
        ],
        [
          buildPolicy(
            { ...fieldsOf(policyFor(2n, "floor")), id: chr(0xe9, 0x1f600, 0) },
            2n,
            "floor",
          ),
        ],
      ];
      await fc.assert(
        fc.asyncProperty(arbHashedPolicy, async (policy) => {
          const tsOutcome = runTs(() => hashWire(hashQuantizationPolicy(policy)));
          const leanOutcome = await oracle.call<ReturnType<typeof hashWire>>(
            "quantization.hashQuantizationPolicy",
            [policyWire(policy)],
          );
          assertSame(
            "quantization.hashQuantizationPolicy",
            describePolicy(policy),
            tsOutcome,
            leanOutcome,
          );
          count("hashQuantizationPolicy");
          count(policy.validTo === undefined ? "hash: no validTo" : "hash: validTo");
        }),
        { seed: SEED, numRuns: NUM_RUNS * 2 + examples.length, examples },
      );
      expect(counted("hash: no validTo")).toBeGreaterThanOrEqual(100);
      expect(counted("hash: validTo")).toBeGreaterThanOrEqual(100);
    },
    TEST_TIMEOUT_MS,
  );

  test("a policy without validTo, with it undefined, and with it null have one hash, in both", async () => {
    const without = policyFor(2n, "halfEven");
    const explicit = buildPolicy({ ...fieldsOf(without), explicitUndefined: true }, 2n, "halfEven");
    const digest = hashQuantizationPolicy(without).digest;
    expect(hashQuantizationPolicy(explicit).digest).toBe(digest);
    expect(hashQuantizationPolicy({ ...without, validTo: null } as never).digest).toBe(digest);
    const answer = await oracle.call<{ digest: string }>("quantization.hashQuantizationPolicy", [
      policyWire(without),
    ]);
    expect(answer.kind).toBe("ok");
    if (answer.kind === "ok") expect(answer.value.digest).toBe(textToWire(digest));
    count("hash: validTo undefined or null");
  });

  // -------------------------------------------------------------------------------------------
  // quantizeBalancedBookValues
  // -------------------------------------------------------------------------------------------

  const tallyBalanced = (outcome: OracleOutcome<ReturnType<typeof balancedWire>>) => {
    if (outcome.kind === "error") {
      count(`balanced: ${outcome.code}`);
      return;
    }
    const result = outcome.value;
    if (result.disposition === "rejected") {
      count(
        `balanced: rejected, ${result.diagnostics[0]?.code} at ${textFromWireOf(result.diagnostics[0]?.path)}`,
      );
      return;
    }
    count("balanced: quantized");
    count(
      result.roundingPosting === null
        ? "balanced: quantized, no rounding posting"
        : "balanced: quantized, rounding posting",
    );
    if (result.bookValues.length === 0) count("balanced: quantized, no values");
    if (result.bookValues.some((value) => value.amount.coefficient === "0")) {
      count("balanced: quantized, a book value of zero");
    }
  };

  test(
    "quantizeBalancedBookValues matches Lean",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbBalancedCase, async (c) => {
          const tsOutcome = tsBalanced(c);
          const leanOutcome = await oracle.call<ReturnType<typeof balancedWire>>(
            "quantization.quantizeBalancedBookValues",
            balancedArgs(c),
          );
          assertSame(
            "quantization.quantizeBalancedBookValues",
            describeBalanced(c),
            tsOutcome,
            leanOutcome,
          );
          count("quantizeBalancedBookValues");
          tallyBalanced(tsOutcome);
        }),
        { seed: SEED, numRuns: NUM_RUNS * 3 + balancedExamples.length, examples: balancedExamples },
      );
      for (const name of [
        "balanced: quantized, no rounding posting",
        "balanced: quantized, rounding posting",
        "balanced: quantized, a book value of zero",
        "balanced: rejected, invalid_exact_number at quantizationPolicy.targetScale",
        "balanced: rejected, book_isolation_violation at quantizationPolicy",
        "balanced: rejected, journal_imbalance at exactValues",
        "balanced: representation_limit_exceeded",
      ]) {
        expect(counted(name)).toBeGreaterThanOrEqual(100);
      }
      expect(counted("balanced: quantized, no values")).toBeGreaterThanOrEqual(10);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "quantizeBalancedBookValues matches Lean for balanced values near the size limit in every order",
    async () => {
      const permutations = <T>(items: readonly T[]): T[][] =>
        items.length <= 1
          ? [[...items]]
          : items.flatMap((item, index) =>
              permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
                item,
                ...rest,
              ]),
            );
      const sets: ExactRational[][] = [];
      for (const a of BIG_A) {
        const big = (n: bigint) => rational(n, 1n);
        sets.push([big(a), big(a), big(-a), big(-a)]);
        sets.push([big(a), big(1n), big(-a), big(-1n)]);
        sets.push([big(a), big(a), big(-a), big(-1n), big(-a + 1n)]);
        sets.push([big(-a), big(-a), big(a), big(1n), rational(a - 1n, 1n)]);
      }
      let accepted = 0;
      let thrown = 0;
      let total = 0;
      for (const set of sets) {
        for (const scale of [0n, 1n, 10n]) {
          for (const order of permutations(set)) {
            const c: BalancedCase = {
              values: order,
              book: "book-1",
              commodity: "USD",
              policy: policyFor(scale, "halfEven"),
            };
            const tsOutcome = tsBalanced(c);
            const leanOutcome = await oracle.call<ReturnType<typeof balancedWire>>(
              "quantization.quantizeBalancedBookValues",
              balancedArgs(c),
            );
            assertSame(
              "quantization.quantizeBalancedBookValues",
              describeBalanced(c),
              tsOutcome,
              leanOutcome,
            );
            if (tsOutcome.kind === "ok") accepted++;
            else thrown++;
            total++;
          }
        }
      }
      count("quantizeBalancedBookValues: limit orders", total);
      // Some orders are taken and some throw: the order of balanced values decides.
      expect(accepted).toBeGreaterThan(100);
      expect(thrown).toBeGreaterThan(100);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "quantizeBalancedBookValues matches Lean at every scale, in every mode, on values that leave a remainder",
    async () => {
      const total = await sweep(
        oracle,
        "quantization.quantizeBalancedBookValues",
        "quantizeBalancedBookValues: classic values at every scale",
        (function* (): Generator<SweepCase> {
          for (const values of CLASSIC) {
            for (let scale = -2; scale <= 1002; scale += scale < 12 ? 1 : 49) {
              for (const mode of ROUNDING_MODES) {
                const c: BalancedCase = {
                  values,
                  book: "book-1",
                  commodity: "USD",
                  policy: policyFor(BigInt(scale), mode),
                };
                yield {
                  args: balancedArgs(c),
                  ts: () => tsBalanced(c),
                  show: () => describeBalanced(c),
                };
              }
            }
          }
        })(),
      );
      expect(total).toBeGreaterThan(1500);
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------------------------
  // quantizeCumulativePostedShare over the whole policy
  // -------------------------------------------------------------------------------------------

  test(
    "quantizeCumulativePostedShare over the whole policy matches Lean",
    async () => {
      const examples: [FullShareCase][] = shareExamples.map(([c]): [FullShareCase] => [
        {
          ...c,
          fields: {
            id: "quantization-1",
            version: "1.0.0",
            bookId: "book-1",
            functionalCommodityId: "USD",
            validFrom: "2000-01-01",
            validTo: "2030-12-31",
            roundingAccountId: "rounding",
            explicitUndefined: false,
          },
        },
      ]);
      await fc.assert(
        fc.asyncProperty(arbFullShareCase, async (c) => {
          const tsOutcome = tsPolicyShare(c);
          const leanOutcome = await oracle.call<ShareWire>(
            "quantization.policyQuantizeCumulativePostedShare",
            [decWire(c.total), ratWire(c.before), ratWire(c.after), policyWire(fullPolicy(c))],
          );
          assertSame(
            "quantization.policyQuantizeCumulativePostedShare",
            `${describeShare(c)}; policy ${describePolicy(fullPolicy(c))}`,
            tsOutcome,
            leanOutcome,
          );
          count("policyQuantizeCumulativePostedShare");
          if (tsOutcome.kind === "error") count(`policy share: ${tsOutcome.code}`);
          else if (tsOutcome.value.disposition === "rejected") {
            const diagnostics = tsOutcome.value.diagnostics as { path: string }[];
            count(`policy share: rejected, ${textFromWireOf(diagnostics[0]?.path)}`);
          } else count("policy share: quantized");
        }),
        { seed: SEED + 7, numRuns: NUM_RUNS * 2 + examples.length, examples },
      );
      expect(counted("policy share: quantized")).toBeGreaterThanOrEqual(100);
      expect(counted("policy share: rejected, cumulativePostedShare")).toBeGreaterThanOrEqual(100);
      expect(
        counted("policy share: rejected, cumulativePostedShare.postedTotal"),
      ).toBeGreaterThanOrEqual(100);
      expect(counted("policy share: representation_limit_exceeded")).toBeGreaterThanOrEqual(100);
    },
    TEST_TIMEOUT_MS,
  );

  test("the TypeScript gives quantization policies that differ only in a lone surrogate one hash", () => {
    // `hashQuantizationPolicy_inj_or_collision` (through `canonicalQuantizationPolicyValue_injective`) is about policies
    // whose texts are strings of scalar values. JavaScript's `TextEncoder` writes a lone surrogate
    // as U+FFFD, so for the TypeScript these three policies, all different, have one hash.
    const make = (account: string) =>
      buildPolicy({ ...fieldsOf(policyFor(2n, "floor")), roundingAccountId: account }, 2n, "floor");
    const digests = [String.fromCharCode(0xd800), String.fromCharCode(0xdc00), chr(0xfffd)].map(
      (account) => hashQuantizationPolicy(make(account)).digest,
    );
    expect(new Set(digests).size).toBe(1);
    count("pinned: lone surrogates in a quantization policy hash");
  });

  // -------------------------------------------------------------------------------------------
  // What the model's notes say the TypeScript does, said of the TypeScript alone
  // -------------------------------------------------------------------------------------------

  test("the TypeScript does what the model's notes on balanced rounding say", () => {
    const run = (values: ExactRational[], policy: QuantizationPolicy, book = "book-1") =>
      tsBalanced({ values, book, commodity: "USD", policy });
    const third = rational(1n, 3n);
    // The scale is tested before the book: a policy of another book whose scale is not admitted is
    // refused for its scale.
    const refused = run([third], policyFor(1001n, "halfEven", "book-2"));
    expect(refused.kind).toBe("ok");
    if (refused.kind === "ok" && refused.value.disposition === "rejected") {
      expect(refused.value.diagnostics.map((d) => [d.code, d.path])).toEqual([
        ["invalid_exact_number", textToWire("quantizationPolicy.targetScale")],
      ]);
    } else throw new Error("expected a rejection");
    // Values that do not add up are refused, not rounded.
    const unbalanced = run([third], policyFor(2n, "halfEven"));
    expect(unbalanced.kind === "ok" && unbalanced.value.disposition).toBe("rejected");
    // The order of balanced values at the size limit decides whether they are taken.
    const big = rational(1n << 16383n, 1n);
    const small = [big, big, big.negate(), big.negate()];
    expect(run(small, policyFor(0n, "halfEven"))).toEqual({
      kind: "error",
      code: "representation_limit_exceeded",
    });
    expect(run([big, big.negate(), big, big.negate()], policyFor(0n, "halfEven")).kind).toBe("ok");
    // A returned book value can be zero when its exact value is not, with no rounding posting.
    const zeros = run([rational(1n, 1000n), rational(-1n, 1000n)], policyFor(2n, "halfEven"));
    expect(
      zeros.kind === "ok" && zeros.value.disposition === "quantized" && zeros.value.roundingPosting,
    ).toBe(null);
    if (zeros.kind === "ok" && zeros.value.disposition === "quantized") {
      expect(zeros.value.bookValues.map((value) => value.amount.coefficient)).toEqual(["0", "0"]);
    }
    // The rounding posting can be more than one unit: three of 2/3 and one of -2, rounded down at
    // scale 0, are 0, 0, 0 and -2, and 2 is posted.
    const posting = run(
      [rational(2n, 3n), rational(2n, 3n), rational(2n, 3n), rational(-2n, 1n)],
      policyFor(0n, "floor"),
    );
    expect(
      posting.kind === "ok" &&
        posting.value.disposition === "quantized" &&
        posting.value.roundingPosting?.bookValue.amount.coefficient,
    ).toBe("2");
    // Nothing reads the policy's `validFrom`, `validTo` or `version`: they are only hashed.
    const base = fieldsOf(policyFor(2n, "halfEven"));
    const other = buildPolicy(
      { ...base, validFrom: "1999-01-01", validTo: "2000-01-01", version: "9.9.9", id: "other" },
      2n,
      "halfEven",
    );
    const values = CLASSIC[3] as ExactRational[];
    expect(run(values, other)).toEqual(run(values, policyFor(2n, "halfEven")));
    expect(hashQuantizationPolicy(other).digest).not.toBe(
      hashQuantizationPolicy(policyFor(2n, "halfEven")).digest,
    );
    count("pinned: balanced rounding");
  });

  // -------------------------------------------------------------------------------------------
  // Known differences. Each of these fails today, and is marked so: when the model or the
  // TypeScript changes and one of them starts to pass, the suite fails and says which.
  // -------------------------------------------------------------------------------------------

  describe("known differences between the model and the TypeScript", () => {
    // INPUT CLASS THE MODEL CANNOT REPRESENT (kind c). A JavaScript string may hold a lone
    // surrogate, and `hashQuantizationPolicy` hashes it as U+FFFD (`TextEncoder`), so two policies
    // that differ only in a lone surrogate have one hash. The model's `String` has no lone
    // surrogate (`Identifier.value`, `Canonical.lean` line 29), and so no policy to hash.
    test.failing("hashQuantizationPolicy: the TypeScript hashes a policy with a lone surrogate in an identifier, the model has no such string", async () => {
      const policy = buildPolicy(
        { ...fieldsOf(policyFor(2n, "floor")), roundingAccountId: String.fromCharCode(0xd800) },
        2n,
        "floor",
      );
      const tsOutcome = runTs(() => hashWire(hashQuantizationPolicy(policy)));
      expect(tsOutcome.kind).toBe("ok");
      assertSame(
        "quantization.hashQuantizationPolicy",
        describePolicy(policy),
        tsOutcome,
        await oracle.call("quantization.hashQuantizationPolicy", [policyWire(policy)]),
      );
    });

    test.failing("quantizeBalancedBookValues: the TypeScript takes a lone surrogate in the book, the model has no such string", async () => {
      const lone = String.fromCharCode(0xdc00);
      const c: BalancedCase = {
        values: [],
        book: lone,
        commodity: "USD",
        policy: policyFor(2n, "floor", lone),
      };
      assertSame(
        "quantization.quantizeBalancedBookValues",
        describeBalanced(c),
        tsBalanced(c),
        await oracle.call("quantization.quantizeBalancedBookValues", balancedArgs(c)),
      );
    });
  });

  test("every function was compared on at least 2,000 generated cases", () => {
    for (const name of [
      "hashQuantizationPolicy",
      "quantizeBalancedBookValues",
      "policyQuantizeCumulativePostedShare",
    ]) {
      expect(counted(name)).toBeGreaterThanOrEqual(NUM_RUNS);
    }
  });
});

/** The fields of a policy built by `policyFor`, to change one of them. */
function fieldsOf(policy: QuantizationPolicy): PolicyFields {
  return {
    id: policy.id,
    version: policy.version,
    bookId: policy.bookId,
    functionalCommodityId: policy.functionalCommodityId,
    validFrom: policy.validFrom,
    validTo: policy.validTo,
    roundingAccountId: policy.roundingAccountId,
    explicitUndefined: false,
  };
}

/** A string read back from its wire form, for a count's name. */
function textFromWireOf(wire: string | undefined): string {
  if (wire === undefined) return "?";
  let out = "";
  for (let index = 0; index < wire.length; index += 4) {
    out += String.fromCharCode(Number.parseInt(wire.slice(index, index + 4), 16));
  }
  return out;
}

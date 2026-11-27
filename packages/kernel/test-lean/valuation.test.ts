/**
 * Valuation, the Lean model (`proofs/Rastrata/Kernel/Valuation.lean`) run against
 * `src/valuation.ts` on the same inputs: `valueWithObservation`, with the direct rate and with the
 * inverse, refused or allowed, for an observation from before, at and after the effective time,
 * with instants written with different offsets and different numbers of fraction digits, and with
 * rates of zero, below zero and at the size limit.
 *
 * The time check is `Date.parse(observation.effectiveAt) > Date.parse(effectiveAt)`; the model's
 * reading of `Date.parse` is the one `validators.test.ts` compares with this runtime's.
 *
 * An error is compared by its code: the two `RangeError`s of the function by their messages, an
 * `ExactNumberError` of `multiply` or `divide` by its code.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  ExactDecimal,
  ExactRational,
  type MarketPriceObservation,
  type Quantity,
  evidenceId,
  priceObservationId,
  valueWithObservation,
} from "../src/index.ts";
import { OracleClient, type OracleOutcome } from "./oracle-client.ts";
import {
  MAX_MAGNITUDE,
  NUM_RUNS,
  SEED,
  TEST_TIMEOUT_MS,
  type SweepCase,
  arbInstantNear,
  arbRational,
  arbSmallRational,
  arbValidInstant,
  assertSame,
  count,
  counted,
  instantAt,
  marketValueWire,
  observationWire,
  printCounts,
  quantityWire,
  runTs,
  showText,
  sweep,
  textToWire,
} from "./wave2a-wire.ts";

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

const rational = (numerator: bigint, denominator: bigint) =>
  ExactRational.of(numerator, denominator);
const ZERO = ExactRational.zero();

const COMMODITIES = ["USD", "EUR", "BTC", "JPY"] as const;
const KINDS = ["marketQuote", "officialRate", "appraisedValue"] as const;

/** What the call is meant to do, so that every branch of the function is reached often. */
type Scenario =
  | "direct"
  | "directOrInverse"
  | "inverse"
  | "inverseNotAllowed"
  | "unrelated"
  | "zeroRateInverse"
  | "zeroRateDirect"
  | "bigDirect"
  | "bigInverse"
  | "sameCommodities";

const SCENARIOS: Scenario[] = [
  "direct",
  "direct",
  "directOrInverse",
  "inverse",
  "inverse",
  "inverseNotAllowed",
  "unrelated",
  "zeroRateInverse",
  "zeroRateDirect",
  "bigDirect",
  "bigInverse",
  "sameCommodities",
];

interface ValuationCase {
  readonly scenario: Scenario;
  readonly quantity: Quantity;
  readonly observation: MarketPriceObservation;
  readonly effectiveAt: string;
  readonly allowInverse: boolean;
}

/** A rate: small, repeating, one, below zero, or at the size limit. */
const arbRate: fc.Arbitrary<ExactRational> = fc.oneof(
  { weight: 4, arbitrary: arbSmallRational.filter((rate) => !rate.isZero()) },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      rational(1n, 1n),
      rational(-1n, 1n),
      rational(2n, 1n),
      rational(1n, 3n),
      rational(-7n, 4n),
      rational(10n, 1n),
    ),
  },
  { weight: 2, arbitrary: arbRational.filter((rate) => !rate.isZero()) },
);

const arbQuantityNumber: fc.Arbitrary<ExactRational> = fc.oneof(
  { weight: 4, arbitrary: arbSmallRational },
  { weight: 1, arbitrary: fc.constant(ZERO) },
  { weight: 2, arbitrary: arbRational },
);

const arbBig: fc.Arbitrary<ExactRational> = fc
  .tuple(
    fc.constantFrom(MAX_MAGNITUDE, 1n << 16383n, (1n << 16383n) + 1n, 3n ** 10000n, 1n << 8192n),
    fc.boolean(),
    fc.constantFrom(1n, 2n, 3n, MAX_MAGNITUDE, 1n << 16383n),
  )
  .map(([n, negative, d]) => rational(negative ? -n : n, d));

/** Two instant texts: independent; near each other, at different offsets and with different
 * numbers of fraction digits; within one millisecond; with a fraction `Date.parse` misreads; equal. */
const arbInstantPair: fc.Arbitrary<[string, string]> = fc.oneof(
  { weight: 2, arbitrary: fc.tuple(arbValidInstant, arbValidInstant) },
  {
    weight: 8,
    arbitrary: fc
      .integer({ min: 946_684_800_000, max: 2_000_000_000_000 })
      .chain((base) => fc.tuple(arbInstantNear(base), arbInstantNear(base))),
  },
  {
    weight: 3,
    arbitrary: fc
      .tuple(
        fc.constantFrom(
          "2024-01-01T00:00:00",
          "2020-02-29T23:59:59",
          "1999-12-31T23:59:59",
          "2038-01-19T03:14:07",
        ),
        fc.constantFrom(
          "0001",
          "0009",
          "0000",
          "1234",
          "1239",
          "9999",
          "05",
          "1",
          "0123456789",
          "5",
          "00000000001",
          "999999999999",
          "123",
          "1230",
          "12300",
        ),
        fc.constantFrom(
          "0001",
          "0009",
          "0000",
          "1234",
          "1239",
          "9999",
          "05",
          "1",
          "0123456789",
          "5",
          "00000000001",
          "999999999999",
          "123",
          "1230",
          "12300",
        ),
        fc.constantFrom("Z", "+00:00", "-14:00", "+05:30"),
      )
      .map(([base, left, right, zone]): [string, string] => [
        `${base}.${left}${zone}`,
        `${base}.${right}${zone}`,
      ]),
  },
  { weight: 1, arbitrary: arbValidInstant.map((text): [string, string] => [text, text]) },
);

function build(
  scenario: Scenario,
  base: string,
  quote: string,
  other: string,
  quantityNumber: ExactRational,
  rate: ExactRational,
  big: ExactRational,
  kind: (typeof KINDS)[number],
  pair: [string, string],
  allow: boolean,
  withSource: boolean,
): ValuationCase {
  let commodity: string;
  let allowInverse = allow;
  let observationRate = rate;
  let number = quantityNumber;
  let quoteCommodity = quote;
  switch (scenario) {
    case "direct":
      commodity = base;
      break;
    case "directOrInverse":
      commodity = allow ? quote : base;
      break;
    case "inverse":
      commodity = quote;
      allowInverse = true;
      break;
    case "inverseNotAllowed":
      commodity = quote;
      allowInverse = false;
      break;
    case "unrelated":
      commodity = other;
      break;
    case "zeroRateInverse":
      commodity = quote;
      allowInverse = true;
      observationRate = ZERO;
      break;
    case "zeroRateDirect":
      commodity = base;
      observationRate = ZERO;
      break;
    case "bigDirect":
      commodity = base;
      number = big;
      break;
    case "bigInverse":
      commodity = quote;
      allowInverse = true;
      number = big;
      observationRate = big;
      break;
    case "sameCommodities":
      quoteCommodity = base;
      commodity = base;
      break;
  }
  const quantity: Quantity = {
    canonicalNumber: number,
    commodityId: commodity as never,
    ...(withSource ? { sourceNumber: ExactDecimal.of(1n, 0n) } : {}),
  };
  const [observedEffective, effectiveAt] = pair;
  const observation: MarketPriceObservation = {
    id: priceObservationId("observation-1"),
    effectiveAt: observedEffective as never,
    observedAt: observedEffective as never,
    kind,
    rate: observationRate,
    baseCommodityId: base as never,
    quoteCommodityId: quoteCommodity as never,
    evidenceId: evidenceId("evidence-1"),
  };
  return { scenario, quantity, observation, effectiveAt, allowInverse };
}

const arbValuationCase: fc.Arbitrary<ValuationCase> = fc
  .tuple(
    fc.constantFrom(...SCENARIOS),
    fc.constantFrom(...COMMODITIES),
    fc.integer({ min: 1, max: 3 }),
    fc.integer({ min: 1, max: 3 }),
    arbQuantityNumber,
    arbRate,
    arbBig,
    fc.constantFrom(...KINDS),
    arbInstantPair,
    fc.boolean(),
    fc.boolean(),
  )
  .map(
    ([
      scenario,
      base,
      quoteStep,
      otherStep,
      quantityNumber,
      rate,
      big,
      kind,
      pair,
      allow,
      withSource,
    ]) => {
      const at = COMMODITIES.indexOf(base);
      const quote = COMMODITIES[(at + quoteStep) % 4] as string;
      const others = COMMODITIES.filter((c) => c !== base && c !== quote);
      const other = others[otherStep % others.length] as string;
      return build(
        scenario,
        base,
        quote,
        other,
        quantityNumber,
        rate,
        big,
        kind,
        pair,
        allow,
        withSource,
      );
    },
  );

const describeValuation = (c: ValuationCase) =>
  `${c.scenario}: ${c.quantity.canonicalNumber.numerator}/${c.quantity.canonicalNumber.denominator} ${c.quantity.commodityId} at rate ${c.observation.rate.numerator}/${c.observation.rate.denominator} of ${c.observation.baseCommodityId}/${c.observation.quoteCommodityId}, observation ${c.observation.effectiveAt}, effective ${c.effectiveAt}, inverse ${c.allowInverse ? "allowed" : "not allowed"}`.slice(
    0,
    3000,
  );

const tsValue = (c: ValuationCase) =>
  runTs(() =>
    marketValueWire(
      valueWithObservation(c.quantity, c.observation, c.effectiveAt as never, c.allowInverse),
    ),
  );

const valuationArgs = (c: ValuationCase) => [
  quantityWire(c.quantity),
  observationWire(c.observation),
  textToWire(c.effectiveAt),
  c.allowInverse,
];

// ---------------------------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------------------------

describe("Valuation Lean oracle equivalence", () => {
  let oracle: OracleClient;

  beforeAll(() => {
    oracle = OracleClient.start(process.env.ORACLE_BINARY);
  });

  afterAll(async () => {
    await oracle.close();
    printCounts();
  });

  const tally = (outcome: OracleOutcome<ReturnType<typeof marketValueWire>>) => {
    if (outcome.kind === "error") count(`valuation: ${outcome.code}`);
    else count(outcome.value.usesInverse ? "valuation: inverse" : "valuation: direct");
  };

  const base = (scenario: Scenario, pair: [string, string]): ValuationCase =>
    build(
      scenario,
      "USD",
      "EUR",
      "JPY",
      rational(3n, 1n),
      rational(2n, 1n),
      rational(MAX_MAGNITUDE, 1n),
      "marketQuote",
      pair,
      false,
      false,
    );

  const examples: [ValuationCase][] = [
    // The three instants of the model's own examples.
    [base("direct", ["2024-01-01T00:00:00.0009Z", "2024-01-01T00:00:00.0001Z"])],
    [base("direct", ["2020-01-01T00:00:00.05Z", "2020-01-01T00:00:00.0123456789Z"])],
    [base("direct", ["2020-01-01T00:00:00.0123456789Z", "2020-01-01T00:00:00.1Z"])],
    [base("direct", ["2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z"])],
    [base("direct", ["2024-01-01T02:00:00+02:00", "2024-01-01T00:00:00Z"])],
    [base("direct", ["2024-01-01T00:00:00Z", "2024-01-01T02:00:00+02:00"])],
    [base("direct", ["2024-01-01T00:00:00.001Z", "2024-01-01T00:00:00Z"])],
    [base("inverse", ["2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z"])],
    [base("inverseNotAllowed", ["2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z"])],
    [base("unrelated", ["2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z"])],
    [base("zeroRateInverse", ["2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z"])],
    [base("zeroRateDirect", ["2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z"])],
    [base("bigDirect", ["2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z"])],
    [base("bigInverse", ["2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z"])],
    [base("sameCommodities", ["2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z"])],
    // Refused as late and then, in the same call, not connected: the time is checked first.
    [base("unrelated", ["2024-01-02T00:00:00Z", "2024-01-01T00:00:00Z"])],
    [base("zeroRateInverse", ["2024-01-02T00:00:00Z", "2024-01-01T00:00:00Z"])],
  ];

  test(
    "valueWithObservation matches Lean",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbValuationCase, async (c) => {
          const tsOutcome = tsValue(c);
          const leanOutcome = await oracle.call<ReturnType<typeof marketValueWire>>(
            "valuation.valueWithObservation",
            valuationArgs(c),
          );
          assertSame(
            "valuation.valueWithObservation",
            describeValuation(c),
            tsOutcome,
            leanOutcome,
          );
          count("valueWithObservation");
          tally(tsOutcome);
          if (tsOutcome.kind === "ok") {
            if (c.observation.rate.isZero()) count("valuation: value at a rate of zero");
            if (c.observation.rate.isNegative()) count("valuation: value at a rate below zero");
            if (c.quantity.canonicalNumber.isNegative()) count("valuation: a quantity below zero");
          }
        }),
        { seed: SEED, numRuns: NUM_RUNS * 3 + examples.length, examples },
      );
      for (const name of [
        "valuation: direct",
        "valuation: inverse",
        "valuation: observation_after_effective_time",
        "valuation: observation_does_not_connect",
        "valuation: invalid_rational",
        "valuation: representation_limit_exceeded",
        "valuation: value at a rate of zero",
        "valuation: value at a rate below zero",
        "valuation: a quantity below zero",
      ]) {
        expect(counted(name)).toBeGreaterThanOrEqual(100);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "valueWithObservation matches Lean for every pair of instants from a list, at every offset and fraction",
    async () => {
      const bases = [
        1_700_000_000_000, 951_782_400_000, 0, -1, 253_402_300_799_999, 1_709_164_800_000,
      ];
      const texts = new Set<string>();
      for (const millis of bases) {
        for (const offset of [0, 60, -330, 840, -840]) {
          for (const digits of [0, 1, 3, 4, 9, 10]) {
            for (const delta of [0, 1, -1, 1000, -1000])
              texts.add(instantAt(millis + delta, offset, digits));
          }
        }
      }
      for (const text of [
        "2020-01-01T00:00:00.0123456789Z",
        "2020-01-01T00:00:00.05Z",
        "2020-01-01T00:00:00.1Z",
        "2020-01-01T00:00:00.0009Z",
        "2020-01-01T00:00:00.0001Z",
        "2020-01-01T00:00:00.999999999999Z",
        "2020-01-01T00:00:00.00000000001Z",
        "2020-01-01T00:00:00.123456789Z",
        "2020-01-01T00:00:00.1234567890Z",
      ]) {
        texts.add(text);
      }
      const list = [...texts];
      expect(list.length).toBeGreaterThan(400);
      let after = 0;
      const total = await sweep(
        oracle,
        "valuation.valueWithObservation",
        "valueWithObservation: every pair of instants",
        (function* (): Generator<SweepCase> {
          for (let left = 0; left < list.length; left += 1) {
            for (let right = 0; right < list.length; right += 7) {
              const pair: [string, string] = [list[left] as string, list[right] as string];
              const c = base("direct", pair);
              yield {
                args: valuationArgs(c),
                ts: () => tsValue(c),
                show: () => describeValuation(c),
              };
            }
          }
        })(),
        (outcome) => {
          if (outcome.kind === "error") after++;
        },
      );
      expect(total).toBeGreaterThan(30_000);
      expect(after).toBeGreaterThan(1000);
      expect(total - after).toBeGreaterThan(1000);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "valueWithObservation matches Lean for every commodity relation, rate and inverse flag",
    async () => {
      const rates = [
        ZERO,
        rational(1n, 1n),
        rational(-1n, 1n),
        rational(2n, 3n),
        rational(-5n, 7n),
        rational(1n, 1n << 16383n),
        rational(MAX_MAGNITUDE, 1n),
        rational(-MAX_MAGNITUDE, 1n),
      ];
      const numbers = [
        ZERO,
        rational(1n, 1n),
        rational(-3n, 2n),
        rational(MAX_MAGNITUDE, 1n),
        rational(1n, 1n << 16383n),
        rational(-(1n << 16383n), 1n),
      ];
      const total = await sweep(
        oracle,
        "valuation.valueWithObservation",
        "valueWithObservation: every relation",
        (function* (): Generator<SweepCase> {
          for (const number of numbers) {
            for (const rate of rates) {
              for (const [commodity, baseCommodity, quoteCommodity] of [
                ["USD", "USD", "EUR"],
                ["EUR", "USD", "EUR"],
                ["JPY", "USD", "EUR"],
                ["USD", "USD", "USD"],
                ["EUR", "EUR", "EUR"],
                ["USD", "EUR", "USD"],
              ] as const) {
                for (const allowInverse of [true, false]) {
                  for (const pair of [
                    ["2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z"],
                    ["2024-01-01T00:00:01Z", "2024-01-01T00:00:00Z"],
                    ["2023-12-31T23:59:59Z", "2024-01-01T00:00:00Z"],
                  ] as [string, string][]) {
                    const c: ValuationCase = {
                      scenario: "direct",
                      quantity: { canonicalNumber: number, commodityId: commodity as never },
                      observation: {
                        id: priceObservationId("observation-1"),
                        effectiveAt: pair[0] as never,
                        observedAt: pair[0] as never,
                        kind: "officialRate",
                        rate,
                        baseCommodityId: baseCommodity as never,
                        quoteCommodityId: quoteCommodity as never,
                        evidenceId: evidenceId("evidence-1"),
                      },
                      effectiveAt: pair[1],
                      allowInverse,
                    };
                    yield {
                      args: valuationArgs(c),
                      ts: () => tsValue(c),
                      show: () => describeValuation(c),
                    };
                  }
                }
              }
            }
          }
        })(),
      );
      expect(total).toBe(6 * 8 * 6 * 2 * 3);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "valueWithObservation matches Lean when a time cannot be read: Date.parse says NaN and no comparison with it is true",
    async () => {
      // `valuation.ts` calls `Date.parse` and does not test the result. For a text that is no time
      // at all the comparison is made with `NaN`, which is never greater, so the observation is not
      // refused for its time; the model's `dateParseAfter` answers `false` there, for the same
      // reason (`Valuation.lean`, the head of the file).
      const unreadable = [
        "",
        "garbage",
        "not a time",
        "2024-13-45T00:00:00Z",
        "T",
        "Z",
        "2024-01-01T00:00:00Zjunk",
        "99999-99-99",
        "2024-01-01T00:00:00+15:00junk",
      ].filter((text) => Number.isNaN(Date.parse(text)));
      expect(unreadable.length).toBeGreaterThanOrEqual(8);
      const readable = ["2024-01-01T00:00:00Z", "1970-01-01T00:00:00Z", "9999-12-31T23:59:59.999Z"];
      const scenarios: Scenario[] = [
        "direct",
        "inverse",
        "inverseNotAllowed",
        "unrelated",
        "zeroRateInverse",
      ];
      let admitted = 0;
      const total = await sweep(
        oracle,
        "valuation.valueWithObservation",
        "valueWithObservation: a time that cannot be read",
        (function* (): Generator<SweepCase> {
          for (const bad of unreadable) {
            for (const good of [...readable, bad]) {
              for (const pair of [
                [bad, good],
                [good, bad],
              ] as [string, string][]) {
                for (const scenario of scenarios) {
                  const c = base(scenario, pair);
                  yield {
                    args: valuationArgs(c),
                    ts: () => tsValue(c),
                    show: () => describeValuation(c),
                  };
                }
              }
            }
          }
        })(),
        (outcome) => {
          // Never refused as late: the time is not what refuses it.
          if (outcome.kind === "error" && outcome.code === "observation_after_effective_time") {
            throw new Error("an unreadable time refused an observation");
          }
          if (outcome.kind === "ok") admitted++;
        },
      );
      expect(total).toBe(unreadable.length * (readable.length + 1) * 2 * scenarios.length);
      expect(admitted).toBeGreaterThan(100);
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------------------------
  // What the model's notes say the TypeScript does, said of the TypeScript alone
  // -------------------------------------------------------------------------------------------

  test("the TypeScript does what the model's notes on valuation say", () => {
    const direct = (pair: [string, string]) => tsValue(base("direct", pair));
    // An observation 0.8 of a millisecond after the effective time is taken, as both are read to
    // the millisecond.
    expect(direct(["2024-01-01T00:00:00.0009Z", "2024-01-01T00:00:00.0001Z"]).kind).toBe("ok");
    // One more than 37 milliseconds after is taken, because `Date.parse` makes 123 milliseconds of
    // the fraction `.0123456789`.
    expect(direct(["2020-01-01T00:00:00.05Z", "2020-01-01T00:00:00.0123456789Z"]).kind).toBe("ok");
    // One more than 87 milliseconds before is refused as from after, for the same reason.
    expect(direct(["2020-01-01T00:00:00.0123456789Z", "2020-01-01T00:00:00.1Z"])).toEqual({
      kind: "error",
      code: "observation_after_effective_time",
    });
    // A rate of zero is not refused with the direct rate; with the inverse the division throws.
    const zeroDirect = tsValue(
      base("zeroRateDirect", ["2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z"]),
    );
    expect(zeroDirect.kind === "ok" && zeroDirect.value.exactAmount).toEqual({
      numerator: "0",
      denominator: "1",
    });
    expect(
      tsValue(base("zeroRateInverse", ["2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z"])),
    ).toEqual({
      kind: "error",
      code: "invalid_rational",
    });
    // A rate below zero is not refused: three euros at minus two are minus six dollars.
    const negative = base("direct", ["2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z"]);
    const negativeValue = tsValue({
      ...negative,
      quantity: { canonicalNumber: rational(3n, 1n), commodityId: "USD" as never },
      observation: { ...negative.observation, rate: rational(-2n, 1n) },
    });
    expect(negativeValue.kind === "ok" && negativeValue.value.exactAmount).toEqual({
      numerator: "-6",
      denominator: "1",
    });
    // When the two commodities of an observation are the same the inverse is never used.
    const same = tsValue(base("sameCommodities", ["2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z"]));
    expect(same.kind === "ok" && same.value.usesInverse).toBe(false);
    count("pinned: valuation");
  });

  // -------------------------------------------------------------------------------------------
  // Known differences. Each of these fails today, and is marked so: when the model or the
  // TypeScript changes and one of them starts to pass, the suite fails and says which.
  // -------------------------------------------------------------------------------------------

  describe("known differences between the model and the TypeScript", () => {
    // INPUT CLASS THE MODEL CANNOT REPRESENT (kind c). `valuation.ts` calls `Date.parse` on the
    // two instants, and `Date.parse` reads many texts that `instant` refuses; the model's
    // `dateParseAfter` (`Valuation.lean` line 87) says `false` for any text that is not an
    // instant, which is what `NaN > x` says and is wrong for a date the engine reads. An `Instant`
    // is built only by `instant`, so the kernel's types keep these texts out.
    test.failing("valueWithObservation: Date.parse reads an observation dated by a day alone as later, the model reads no time", async () => {
      const c = base("direct", ["2024-01-02", "2024-01-01T00:00:00Z"]);
      const observation = { ...c.observation, effectiveAt: "2024-01-02" as never };
      const wired = { ...c, observation };
      const tsOutcome = runTs(() =>
        marketValueWire(
          valueWithObservation(
            wired.quantity,
            wired.observation,
            wired.effectiveAt as never,
            false,
          ),
        ),
      );
      expect(tsOutcome).toEqual({ kind: "error", code: "observation_after_effective_time" });
      assertSame(
        "valuation.valueWithObservation",
        showText("2024-01-02"),
        tsOutcome,
        await oracle.call("valuation.valueWithObservation", [
          quantityWire(wired.quantity),
          { ...observationWire(c.observation), effectiveAt: textToWire("2024-01-02") },
          textToWire(wired.effectiveAt),
          false,
        ]),
      );
    });
  });

  test("every function was compared on at least 2,000 generated cases", () => {
    expect(counted("valueWithObservation")).toBeGreaterThanOrEqual(NUM_RUNS);
  });
});

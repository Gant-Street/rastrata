/**
 * What the five test files of the second wave (a) share: the wire of `proofs/Oracle/Wave2a.lean`,
 * the way a TypeScript outcome is made comparable with the model's, and the generators of numbers,
 * texts and instants.
 *
 * The wire is ASCII only, as in `canonical.test.ts` (see the head of `proofs/Oracle/Wave2a.lean`):
 *   - a string is the hexadecimal of its UTF-16 code units, four digits a unit;
 *   - an integer is a decimal string; a rational is `{numerator, denominator}` and a decimal is
 *     `{coefficient, scale}`, both of decimal strings;
 *   - an optional field is `null` or its value; a list is an array; a union of string literals is
 *     the literal, as it is;
 *   - a result is a disposition (`quantized`, `resolved` or `rejected`) with its payload.
 *
 * A Lean `String` cannot hold a lone surrogate, so the generators here make well-formed strings
 * only. Every source character in this file is ASCII: a code point is written as a number.
 */
import fc from "fast-check";

import {
  type BookingPolicy,
  type CanonicalValue,
  type ContentHash,
  type DerivationRecord,
  ExactDecimal,
  ExactNumberError,
  ExactRational,
  type MarketPriceObservation,
  type MarketValue,
  type Quantity,
  type QuantizationPolicy,
  type RoundingMode,
  type SemanticDiagnostic,
  type SourceEvidence,
  type BalancedQuantizationResult,
  type CumulativePostedShare,
  type QuantizedValue,
  identifier,
} from "../src/index.ts";
import type { OracleClient, OracleOutcome } from "./oracle-client.ts";

/** Deterministic: the seed and the number of runs are fixed unless `ORACLE_SEED` and `ORACLE_RUNS`
 * are set, which is how a longer hunt is made on another seed. */
export const SEED = Number(process.env.ORACLE_SEED ?? 20261125);
export const NUM_RUNS = Number(process.env.ORACLE_RUNS ?? 2000);
export const TEST_TIMEOUT_MS = 900_000;
export const BATCH = 2048;
export const MAX_BITS = 16384;
export const MAX_MAGNITUDE = (1n << BigInt(MAX_BITS)) - 1n; // 2^16384 - 1
export const ONE_PAST_LIMIT = 1n << BigInt(MAX_BITS); // 2^16384

// ---------------------------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------------------------

const HEX4: string[] = [];
for (let unit = 0; unit < 0x10000; unit++) HEX4.push(unit.toString(16).padStart(4, "0"));

/** The wire form of a string: the hexadecimal of its UTF-16 code units. */
export function textToWire(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index++) out += HEX4[text.charCodeAt(index)];
  return out;
}

export function textFromWire(hex: string): string {
  let out = "";
  for (let index = 0; index < hex.length; index += 4) {
    out += String.fromCharCode(Number.parseInt(hex.slice(index, index + 4), 16));
  }
  return out;
}

/** A string as its code points, for a message a reader can check. */
export function showText(text: string): string {
  const points: string[] = [];
  for (let index = 0; index < text.length; index++) {
    const point = text.codePointAt(index) as number;
    points.push(`U+${point.toString(16).toUpperCase().padStart(4, "0")}`);
    if (point > 0xffff) index++;
  }
  return `${JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}...` : text)} [${points.slice(0, 40).join(" ")}${points.length > 40 ? " ..." : ""}]`;
}

export const chr = (...points: number[]) => String.fromCodePoint(...points);
export const pad = (value: number, width: number) => String(value).padStart(width, "0");

// ---------------------------------------------------------------------------------------------
// Counting, so that the agreement can be seen to say something
// ---------------------------------------------------------------------------------------------

export const counts = new Map<string, number>();
export function count(name: string, by = 1): number {
  const next = (counts.get(name) ?? 0) + by;
  counts.set(name, next);
  return next;
}
export const counted = (name: string): number => counts.get(name) ?? 0;

export function printCounts(): void {
  if (!process.env.ORACLE_COUNTS) return;
  for (const [name, cases] of [...counts].sort((left, right) => left[0].localeCompare(right[0]))) {
    console.log(`${String(cases).padStart(9)}  ${name}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------------------------

const MESSAGES: readonly (readonly [string, string])[] = [
  ["Invalid local date: ", "invalid_local_date:"],
  ["Invalid supplied instant: ", "invalid_supplied_instant:"],
  ["Invalid semantic version: ", "invalid_semantic_version:"],
];

const FIXED_MESSAGES: readonly (readonly [string, string])[] = [
  ["Quantization scale must be between 0 and 1000", "quantization_scale_out_of_range"],
  [
    "A valuation cannot use an observation from after its effective time",
    "observation_after_effective_time",
  ],
  [
    "Observation does not connect the source commodity under the supplied policy",
    "observation_does_not_connect",
  ],
];

/** The wire code of a thrown `RangeError`: the kind of message, and the text it ends with when it
 * holds the offending value. `undefined` for a message this file does not know. */
export function rangeErrorCode(message: string): string | undefined {
  for (const [prefix, code] of MESSAGES) {
    if (message.startsWith(prefix)) return code + textToWire(message.slice(prefix.length));
  }
  for (const [text, code] of FIXED_MESSAGES) if (message === text) return code;
  return undefined;
}

/** The TypeScript's outcome in the model's terms. An `ExactNumberError` is its code and a
 * `RangeError` is the code of its message; anything else is a fault of the test and is thrown. */
export function runTs<T>(fn: () => T): OracleOutcome<T> {
  try {
    return { kind: "ok", value: fn() };
  } catch (err) {
    if (err instanceof ExactNumberError) return { kind: "error", code: err.code };
    if (err instanceof RangeError) {
      const code = rangeErrorCode(err.message);
      if (code !== undefined) return { kind: "error", code };
    }
    throw err;
  }
}

/** Fails, with the input, where the two outcomes differ. */
export function assertSame<T>(
  fnName: string,
  input: string,
  ts: OracleOutcome<T>,
  lean: OracleOutcome<T>,
): void {
  if (!Bun.deepEquals(ts, lean, true)) {
    const show = (outcome: OracleOutcome<T>) => {
      const text = JSON.stringify(outcome);
      return text.length > 1500 ? `${text.slice(0, 1500)}... (${text.length} characters)` : text;
    };
    throw new Error(`${fnName} differs for ${input}:\n  TS:   ${show(ts)}\n  Lean: ${show(lean)}`);
  }
}

/** A long input, cut for a message. */
export function clip(text: string, length = 3000): string {
  return text.length > length ? `${text.slice(0, length)}... (${text.length} characters)` : text;
}

// ---------------------------------------------------------------------------------------------
// The wire of numbers and records
// ---------------------------------------------------------------------------------------------

export type RationalWire = { numerator: string; denominator: string };
export type DecimalWire = { coefficient: string; scale: string };

export const ratWire = (r: ExactRational): RationalWire => ({
  numerator: r.numerator.toString(),
  denominator: r.denominator.toString(),
});

export const decWire = (d: ExactDecimal): DecimalWire => ({
  coefficient: d.coefficient.toString(),
  scale: d.scale.toString(),
});

export const t = textToWire;

export function quantizedWire(q: QuantizedValue) {
  return { amount: decWire(q.amount), residual: ratWire(q.residual) };
}

export function policyWire(policy: QuantizationPolicy) {
  return {
    id: t(policy.id),
    version: t(policy.version),
    bookId: t(policy.bookId),
    functionalCommodityId: t(policy.functionalCommodityId),
    validFrom: t(policy.validFrom),
    validTo: policy.validTo === undefined ? null : t(policy.validTo),
    targetScale: policy.targetScale.toString(),
    roundingMode: policy.roundingMode,
    roundingAccountId: t(policy.roundingAccountId),
  };
}

export function ruleWire(policy: QuantizationPolicy) {
  return { targetScale: policy.targetScale.toString(), roundingMode: policy.roundingMode };
}

export function diagnosticWire(d: SemanticDiagnostic) {
  return {
    code: d.code,
    path: t(d.path),
    message: t(d.message),
    requirementIds: d.requirementIds.map(t),
  };
}

export function bookValueWire(value: { amount: ExactDecimal; functionalCommodityId: string }) {
  return { amount: decWire(value.amount), functionalCommodityId: t(value.functionalCommodityId) };
}

export type BookValueWire = ReturnType<typeof bookValueWire>;
export type DiagnosticWire = ReturnType<typeof diagnosticWire>;
export type BalancedWire =
  | { disposition: "rejected"; diagnostics: DiagnosticWire[] }
  | {
      disposition: "quantized";
      bookValues: BookValueWire[];
      roundingPosting: { accountId: string; bookValue: BookValueWire } | null;
    };

export function balancedWire(result: BalancedQuantizationResult): BalancedWire {
  if (result.disposition === "rejected") {
    return { disposition: "rejected", diagnostics: result.diagnostics.map(diagnosticWire) };
  }
  return {
    disposition: "quantized",
    bookValues: result.bookValues.map(bookValueWire),
    roundingPosting:
      result.roundingPosting === undefined
        ? null
        : {
            accountId: t(result.roundingPosting.accountId),
            bookValue: bookValueWire(result.roundingPosting.bookValue),
          },
  };
}

export function hashWire(hash: ContentHash) {
  return {
    algorithm: t(hash.algorithm),
    canonicalizationVersion: t(hash.canonicalizationVersion),
    digest: t(hash.digest),
  };
}

export function quantityWire(quantity: Quantity) {
  return {
    canonicalNumber: ratWire(quantity.canonicalNumber),
    commodityId: t(quantity.commodityId),
    sourceNumber: quantity.sourceNumber === undefined ? null : decWire(quantity.sourceNumber),
  };
}

export function observationWire(observation: MarketPriceObservation) {
  return {
    id: t(observation.id),
    effectiveAt: t(observation.effectiveAt),
    observedAt: t(observation.observedAt),
    kind: observation.kind,
    rate: ratWire(observation.rate),
    baseCommodityId: t(observation.baseCommodityId),
    quoteCommodityId: t(observation.quoteCommodityId),
    evidenceId: t(observation.evidenceId),
  };
}

export function marketValueWire(value: MarketValue) {
  return {
    exactAmount: ratWire(value.exactAmount),
    reportingCommodityId: t(value.reportingCommodityId),
    sourceObservationId: t(value.sourceObservationId),
    usesInverse: value.usesInverse,
    effectiveAt: t(value.effectiveAt),
  };
}

export function capabilityWire(capability: BookingPolicy["capability"]) {
  return {
    id: t(capability.id),
    method: capability.method,
    scope: capability.scope,
    status: capability.status,
    implementationVersion: t(capability.implementationVersion),
    verificationEvidenceIds: capability.verificationEvidenceIds.map(t),
  };
}

export function bookingPolicyWire(policy: BookingPolicy) {
  return {
    id: t(policy.id),
    bookId: t(policy.bookId),
    version: t(policy.version),
    validFrom: t(policy.validFrom),
    validTo: policy.validTo === undefined ? null : t(policy.validTo),
    lotSelection: policy.lotSelection,
    scope: policy.scope,
    scopeKey: t(policy.scopeKey),
    requiredDimensionIds: policy.requiredDimensionIds.map(t),
    implementationVersion: t(policy.implementationVersion),
    capability: capabilityWire(policy.capability),
  };
}

export function evidenceWire(evidence: SourceEvidence) {
  return {
    id: t(evidence.id),
    sourceSystem: t(evidence.sourceSystem),
    sourceRecordId: t(evidence.sourceRecordId),
    observedAt: t(evidence.observedAt),
    contentHash: hashWire(evidence.contentHash),
  };
}

export function derivationWire(derivation: DerivationRecord) {
  return {
    id: t(derivation.id),
    policyId: t(derivation.policyId),
    policyVersion: t(derivation.policyVersion),
    algorithmVersion: t(derivation.algorithmVersion),
    inputHash: hashWire(derivation.inputHash),
    actorId: t(derivation.actorId),
    state: derivation.state,
    recordedAt: t(derivation.recordedAt),
    evidence: derivation.evidence.map(evidenceWire),
  };
}

export type WireValue =
  | { t: "null" }
  | { t: "bool"; v: boolean }
  | { t: "int"; v: string }
  | { t: "string"; v: string }
  | { t: "bytes"; v: string }
  | { t: "array"; v: WireValue[] }
  | { t: "record"; v: [string, WireValue][] };

/** A canonical value in the tagged wire form. A record is its own properties in the order
 * JavaScript holds them, so that the order the TypeScript built the object in is compared too. */
export function valueWire(value: CanonicalValue): WireValue {
  if (value === null) return { t: "null" };
  if (typeof value === "boolean") return { t: "bool", v: value };
  if (typeof value === "bigint") return { t: "int", v: value.toString() };
  if (typeof value === "string") return { t: "string", v: t(value) };
  if (value instanceof Uint8Array) {
    return { t: "bytes", v: [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("") };
  }
  if (Array.isArray(value)) return { t: "array", v: value.map(valueWire) };
  return {
    t: "record",
    v: Object.entries(value as { [key: string]: CanonicalValue }).map(
      ([key, member]): [string, WireValue] => [t(key), valueWire(member)],
    ),
  };
}

export function shareWire(share: CumulativePostedShare) {
  return {
    postedTotal: decWire(share.postedTotal),
    beforeFraction: ratWire(share.beforeFraction),
    afterFraction: ratWire(share.afterFraction),
    beforeTarget: ratWire(share.beforeTarget),
    afterTarget: ratWire(share.afterTarget),
    beforeQuantization: quantizedWire(share.beforeQuantization),
    afterQuantization: quantizedWire(share.afterQuantization),
    postedAmount: decWire(share.postedAmount),
  };
}

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

/** A positive integer of exactly `bits` binary digits. */
export const arbOfBits = (bits: number): fc.Arbitrary<bigint> =>
  bits <= 1
    ? fc.constant(1n)
    : fc.bigInt({ min: 1n << BigInt(bits - 1), max: (1n << BigInt(bits)) - 1n });

const NEAR_LIMIT: bigint[] = [
  MAX_MAGNITUDE,
  MAX_MAGNITUDE - 1n,
  1n << 16383n,
  (1n << 16383n) + 1n,
  (1n << 16383n) - 1n,
  1n << 16382n,
  1n << 8192n,
  3n ** 10000n,
  10n ** 4931n,
  10n ** 3000n,
  7n ** 5000n,
].filter((value) => value <= MAX_MAGNITUDE);

/** A positive integer the exact numbers admit: small mostly, with powers of ten and of two, and
 * numbers of every length up to the limit of 16,384 bits. */
export const arbMagnitude: fc.Arbitrary<bigint> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.constantFrom(
      1n,
      2n,
      3n,
      5n,
      6n,
      7n,
      9n,
      10n,
      12n,
      100n,
      1000n,
      10n ** 9n,
      2n ** 31n,
      2n ** 32n,
      2n ** 53n,
      2n ** 63n,
      2n ** 64n,
      10n ** 18n,
    ),
  },
  { weight: 4, arbitrary: fc.bigInt({ min: 1n, max: 1000n }) },
  { weight: 2, arbitrary: fc.bigInt({ min: 1n, max: 1n << 128n }) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: MAX_BITS }).chain(arbOfBits) },
  { weight: 1, arbitrary: fc.constantFrom(...NEAR_LIMIT) },
);

export const arbSigned: fc.Arbitrary<bigint> = fc
  .tuple(arbMagnitude, fc.boolean())
  .map(([magnitude, negative]) => (negative ? -magnitude : magnitude));

/** An integer in the range the exact numbers admit, zero included. */
export const arbAdmitted: fc.Arbitrary<bigint> = fc.oneof(
  { weight: 1, arbitrary: fc.constant(0n) },
  { weight: 9, arbitrary: arbSigned },
);

/** An exact rational, or `undefined` for the parts that make `ExactRational.of` throw. */
export function rationalOrUndefined(numerator: bigint, denominator: bigint) {
  try {
    return ExactRational.of(numerator, denominator);
  } catch (err) {
    if (err instanceof ExactNumberError) return undefined;
    throw err;
  }
}

export const isDefined = <T>(value: T | undefined): value is T => value !== undefined;

/** Any exact rational: small, repeating, large, near the limit, zero, negative. */
export const arbRational: fc.Arbitrary<ExactRational> = fc
  .tuple(arbAdmitted, arbMagnitude)
  .map(([numerator, denominator]) => rationalOrUndefined(numerator, denominator))
  .filter(isDefined);

/** A small rational: parts below a thousand. */
export const arbSmallRational: fc.Arbitrary<ExactRational> = fc
  .tuple(fc.bigInt({ min: -1000n, max: 1000n }), fc.bigInt({ min: 1n, max: 100n }))
  .map(([numerator, denominator]) => ExactRational.of(numerator, denominator));

export function decimalOrUndefined(coefficient: bigint, scale: bigint) {
  try {
    return ExactDecimal.of(coefficient, scale);
  } catch (err) {
    if (err instanceof ExactNumberError) return undefined;
    throw err;
  }
}

export const ROUNDING_MODES: readonly RoundingMode[] = [
  "halfEven",
  "halfAwayFromZero",
  "towardZero",
  "floor",
  "ceiling",
];
export const arbMode: fc.Arbitrary<RoundingMode> = fc.constantFrom(...ROUNDING_MODES);

/** A scale that `quantize` admits: mostly small, every kind of edge, and the whole range. */
export const arbValidScale: fc.Arbitrary<bigint> = fc.oneof(
  { weight: 5, arbitrary: fc.bigInt({ min: 0n, max: 6n }) },
  { weight: 2, arbitrary: fc.constantFrom(0n, 1n, 2n, 3n, 4n, 8n, 18n, 100n, 999n, 1000n) },
  { weight: 1, arbitrary: fc.bigInt({ min: 0n, max: 1000n }) },
);

/** A scale outside 0 to 1000. */
export const arbBadScale: fc.Arbitrary<bigint> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.constantFrom(
      -1n,
      -2n,
      -1000n,
      1001n,
      1002n,
      2000n,
      10n ** 6n,
      -(10n ** 6n),
      ONE_PAST_LIMIT,
      -ONE_PAST_LIMIT,
      MAX_MAGNITUDE,
      10n ** 300n,
    ),
  },
  { weight: 1, arbitrary: fc.bigInt({ min: 1001n, max: 5000n }) },
  { weight: 1, arbitrary: fc.bigInt({ min: -5000n, max: -1n }) },
);

// ---------------------------------------------------------------------------------------------
// Texts
// ---------------------------------------------------------------------------------------------

/** Any Unicode scalar value, each as likely as the next. */
export const arbAnyScalar: fc.Arbitrary<number> = fc
  .integer({ min: 0, max: 0x10ffff - 0x800 })
  .map((point) => (point >= 0xd800 ? point + 0x800 : point));

const SPECIAL_POINTS = [
  0x00, 0x09, 0x0a, 0x0d, 0x20, 0x7f, 0x80, 0x85, 0xa0, 0xad, 0xe9, 0x301, 0x3a9, 0x2028, 0x2029,
  0x3000, 0xd7ff, 0xe000, 0xfeff, 0xfffd, 0xffff, 0x10000, 0x1f600, 0x10ffff,
];

/** One code point: printable ASCII mostly, digits and separators often, and every kind of edge. */
export const arbPoint: fc.Arbitrary<number> = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 0x20, max: 0x7e }) },
  { weight: 4, arbitrary: fc.integer({ min: 0x30, max: 0x39 }) },
  { weight: 2, arbitrary: fc.constantFrom(45, 58, 46, 84, 90, 43, 32, 47, 44, 116, 122) },
  { weight: 2, arbitrary: fc.constantFrom(...SPECIAL_POINTS) },
  { weight: 1, arbitrary: arbAnyScalar },
);

/** A short text of any kind of character, well formed. */
export const arbNoise: fc.Arbitrary<string> = fc
  .array(arbPoint, { maxLength: 12 })
  .map((points) => chr(...points));

/** Whether `identifier` takes the text. */
export function isIdentifier(text: string): boolean {
  try {
    identifier(text);
    return true;
  } catch {
    return false;
  }
}

/** A text that is a valid identifier: letters and digits mostly, any scalar value now and then. */
export const arbIdentifierText: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.constantFrom("a", "b", "alpha", "beta", "USD", "EUR", "book-1", "x y"),
  },
  {
    weight: 3,
    arbitrary: fc
      .array(fc.integer({ min: 0x21, max: 0x7e }), { minLength: 1, maxLength: 8 })
      .map((points) => chr(...points)),
  },
  {
    weight: 2,
    arbitrary: fc
      .array(arbAnyScalar, { minLength: 1, maxLength: 4 })
      .map((points) =>
        chr(...points)
          .normalize("NFC")
          .trim(),
      )
      .filter(isIdentifier),
  },
  {
    weight: 1,
    // Strings whose code unit order and code point order disagree.
    arbitrary: fc
      .array(fc.constantFrom(0xe000, 0xff5e, 0xffe5, 0x10000, 0x1f600, 0x10ffff, 0x41, 0x7a), {
        minLength: 1,
        maxLength: 3,
      })
      .map((points) => chr(...points)),
  },
);

// ---------------------------------------------------------------------------------------------
// Dates and instants
// ---------------------------------------------------------------------------------------------

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const isLeap = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
export const maxDay = (year: number, month: number): number =>
  month === 2 && isLeap(year) ? 29 : (DAYS[month - 1] as number);

export const YEAR_EDGES = [
  0, 1, 3, 4, 8, 99, 100, 101, 396, 399, 400, 401, 1582, 1600, 1700, 1800, 1899, 1900, 1901, 1968,
  1969, 1970, 1971, 1999, 2000, 2001, 2023, 2024, 2025, 2038, 2099, 2100, 2200, 2300, 2399, 2400,
  9000, 9996, 9999,
];

export const arbYear: fc.Arbitrary<number> = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...YEAR_EDGES) },
  { weight: 2, arbitrary: fc.integer({ min: 1900, max: 2100 }) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 9999 }) },
);

export interface DateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export const formatDate = (parts: DateParts) =>
  `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;

/** A real date, the last day of a month often. */
export const arbValidDateParts: fc.Arbitrary<DateParts> = fc
  .tuple(arbYear, fc.integer({ min: 1, max: 12 }), fc.integer({ min: 0, max: 40 }))
  .map(([year, month, pick]) => {
    const last = maxDay(year, month);
    const day = pick >= 31 ? last : pick === 0 ? 1 : ((pick - 1) % last) + 1;
    return { year, month, day };
  });

export interface InstantParts extends DateParts {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** The digits after the decimal point, empty for none. */
  readonly fraction: string;
  /** `Z` or a sign with hours, a colon and minutes. */
  readonly offset: string;
}

export const formatInstant = (parts: InstantParts) =>
  `${formatDate(parts)}T${pad(parts.hour, 2)}:${pad(parts.minute, 2)}:${pad(parts.second, 2)}${
    parts.fraction === "" ? "" : `.${parts.fraction}`
  }${parts.offset}`;

/** The digits of a fraction of a second: none, one to twelve digits mostly, now and then more. */
export const arbFraction: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: fc.constant("") },
  {
    weight: 6,
    arbitrary: fc
      .tuple(
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 0, max: 3 }),
        fc.nat(999_999_999_999),
      )
      .map(([length, shape, seed]) => fractionDigits(length, shape, seed)),
  },
  {
    weight: 1,
    arbitrary: fc
      .tuple(
        fc.integer({ min: 13, max: 40 }),
        fc.integer({ min: 0, max: 3 }),
        fc.nat(999_999_999_999),
      )
      .map(([length, shape, seed]) => fractionDigits(length, shape, seed)),
  },
);

/** `length` digits: random (0), zeros first (1), nines (2), or one and zeros (3). */
export function fractionDigits(length: number, shape: number, seed: number): string {
  let digits = "";
  let state = seed + 1;
  const next = () => {
    state = (state * 48271) % 2147483647;
    return state;
  };
  for (let index = 0; index < length; index++) {
    if (shape === 0) digits += String(next() % 10);
    else if (shape === 1)
      digits +=
        next() % 4 === 0
          ? String(next() % 10)
          : index < length - 1
            ? "0"
            : String(1 + (next() % 9));
    else if (shape === 2) digits += next() % 5 === 0 ? String(next() % 10) : "9";
    else digits += index === 0 ? "1" : "0";
  }
  return digits;
}

/** `Z`, or a legal offset: up to 13:59 either way, or exactly 14:00. */
export const arbOffset: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: fc.constant("Z") },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      "+00:00",
      "-00:00",
      "+14:00",
      "-14:00",
      "+13:59",
      "-13:59",
      "+05:30",
      "-03:30",
      "+05:45",
      "+12:45",
      "-09:30",
      "+01:00",
      "-08:00",
    ),
  },
  {
    weight: 3,
    arbitrary: fc
      .tuple(
        fc.constantFrom("+", "-"),
        fc.integer({ min: 0, max: 13 }),
        fc.integer({ min: 0, max: 59 }),
      )
      .map(([sign, hours, minutes]) => `${sign}${pad(hours, 2)}:${pad(minutes, 2)}`),
  },
);

/** An instant `instant` accepts. */
export const arbValidInstantParts: fc.Arbitrary<InstantParts> = fc
  .tuple(
    arbValidDateParts,
    fc.oneof(
      { weight: 3, arbitrary: fc.integer({ min: 0, max: 23 }) },
      { weight: 1, arbitrary: fc.constantFrom(0, 12, 23) },
    ),
    fc.oneof(
      { weight: 3, arbitrary: fc.integer({ min: 0, max: 59 }) },
      { weight: 1, arbitrary: fc.constantFrom(0, 30, 59) },
    ),
    fc.oneof(
      { weight: 3, arbitrary: fc.integer({ min: 0, max: 59 }) },
      { weight: 1, arbitrary: fc.constantFrom(0, 30, 59) },
    ),
    arbFraction,
    arbOffset,
  )
  .map(([date, hour, minute, second, fraction, offset]) => ({
    ...date,
    hour,
    minute,
    second,
    fraction,
    offset,
  }));

export const arbValidInstant: fc.Arbitrary<string> = arbValidInstantParts.map(formatInstant);

/** The instant at `millis` since the epoch written at `offsetMinutes` with `digits` of fraction. */
export function instantAt(millis: number, offsetMinutes: number, digits: number): string {
  const wall = new Date(millis + offsetMinutes * 60_000);
  // A year of five digits, or below zero, is not an instant: write the epoch instead.
  if (wall.getUTCFullYear() < 0 || wall.getUTCFullYear() > 9999)
    return instantAt(0, offsetMinutes, digits);
  const fraction = pad(wall.getUTCMilliseconds(), 3);
  const shown =
    digits === 0
      ? ""
      : `.${digits <= 3 ? fraction.slice(0, digits) : fraction + "0".repeat(digits - 3)}`;
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const zone =
    offsetMinutes === 0 && digits % 2 === 0
      ? "Z"
      : `${sign}${pad(Math.floor(absolute / 60), 2)}:${pad(absolute % 60, 2)}`;
  return `${pad(wall.getUTCFullYear(), 4)}-${pad(wall.getUTCMonth() + 1, 2)}-${pad(wall.getUTCDate(), 2)}T${pad(wall.getUTCHours(), 2)}:${pad(wall.getUTCMinutes(), 2)}:${pad(wall.getUTCSeconds(), 2)}${shown}${zone}`;
}

/** The text of the moment `base + delta` milliseconds, at an offset and a number of fraction
 * digits that are drawn: the same moment has many texts. */
export function arbInstantNear(base: number): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.constantFrom(
        0,
        0,
        1,
        -1,
        2,
        -2,
        999,
        1000,
        -1000,
        1001,
        60_000,
        -60_000,
        3_600_000,
        -3_600_000,
        86_400_000,
        -86_400_000,
      ),
      fc.constantFrom(0, 0, 60, -60, 330, -210, 840, -840, 765),
      fc.constantFrom(0, 1, 2, 3, 3, 3, 4, 6, 9),
    )
    .map(([delta, offsetMinutes, digits]) => instantAt(base + delta, offsetMinutes, digits));
}

// ---------------------------------------------------------------------------------------------
// Sweeps: many calls of one entry in few requests
// ---------------------------------------------------------------------------------------------

/** One call of a sweep: its wire arguments, the TypeScript's outcome in the model's terms, and its
 * description for a message. */
export interface SweepCase {
  readonly args: readonly unknown[];
  readonly ts: () => OracleOutcome<unknown>;
  readonly show: () => string;
}

type Each = { ok?: unknown; error?: string };

/** Sends `cases` to the entry `${entry}.each` in batches and fails on the first case, in the order
 * given, where the TypeScript and the model differ. Returns how many were compared. */
export async function sweep(
  oracle: OracleClient,
  entry: string,
  name: string,
  cases: Iterable<SweepCase>,
  tally?: (outcome: OracleOutcome<unknown>, index: number) => void,
): Promise<number> {
  let total = 0;
  let batch: SweepCase[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const answer = await oracle.call<Each[]>(`${entry}.each`, [batch.map((one) => one.args)]);
    if (answer.kind !== "ok" || answer.value.length !== batch.length) {
      throw new Error(
        `${entry}.each did not answer every call: ${JSON.stringify(answer).slice(0, 300)}`,
      );
    }
    for (let index = 0; index < batch.length; index++) {
      const one = batch[index] as SweepCase;
      const each = answer.value[index] as Each;
      const lean: OracleOutcome<unknown> =
        each.error === undefined
          ? { kind: "ok", value: each.ok }
          : { kind: "error", code: each.error };
      const tsOutcome = one.ts();
      assertSame(entry, `${one.show()} (${name})`, tsOutcome, lean);
      tally?.(tsOutcome, total + index);
    }
    total += batch.length;
    batch = [];
  };
  for (const one of cases) {
    batch.push(one);
    if (batch.length === BATCH) await flush();
  }
  await flush();
  count(name, total);
  return total;
}

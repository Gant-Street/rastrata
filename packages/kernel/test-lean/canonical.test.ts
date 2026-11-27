/**
 * The Lean model of `src/canonical.ts` (`proofs/Rastrata/Kernel/Canonical.lean`, `Sha256.lean`) run
 * against the TypeScript on the same inputs. The model carries its own Unicode tables, whitespace and
 * control-character rules and its own SHA-256; a proof says nothing about whether they agree with
 * JavaScript, and this file does.
 *
 * The wire (`proofs/Oracle/Canonical.lean`) is ASCII only:
 *   - a string is the hexadecimal of its UTF-16 code units, four digits a unit;
 *   - bytes are hexadecimal, two digits a byte; an integer is a decimal string;
 *   - a canonical value is `{t:"null"}`, `{t:"bool",v}`, `{t:"int",v}`, `{t:"string",v}`,
 *     `{t:"bytes",v}`, `{t:"array",v:[...]}` or `{t:"record",v:[[key, value], ...]}` (a list of
 *     pairs, so key order and a repeated key reach the model as sent);
 *   - a content hash is an object of three strings.
 *
 * A Lean `String` cannot hold a lone surrogate. The oracle answers such an argument with the error
 * `model_has_no_lone_surrogate`. The generators below make well-formed strings only; what the
 * TypeScript does with a lone surrogate is recorded under "known differences" and pinned under
 * "lone surrogates".
 *
 * Every source character in this file is ASCII: a code point is written as a number.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  CANONICALIZATION_VERSION,
  CONTENT_HASH_ALGORITHM,
  type CanonicalValue,
  type ContentHash,
  canonicalEncode,
  compareCanonicalText,
  contentHashEquals,
  hashCanonical,
  hashCanonicalSequenceField,
  IdentityError,
  identifier,
} from "../src/index.ts";
import { OracleClient, type OracleOutcome } from "./oracle-client.ts";

const SEED = 20261125;
const NUM_RUNS = 2000;
const TEST_TIMEOUT_MS = 120_000;
const BATCH = 4096;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

// ---------------------------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------------------------

const HEX4: string[] = [];
for (let unit = 0; unit < 0x10000; unit++) HEX4.push(unit.toString(16).padStart(4, "0"));

function textToWire(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index++) out += HEX4[text.charCodeAt(index)];
  return out;
}

function textFromWire(hex: string): string {
  let out = "";
  for (let index = 0; index < hex.length; index += 4) {
    out += String.fromCharCode(Number.parseInt(hex.slice(index, index + 4), 16));
  }
  return out;
}

function bytesToWire(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

type Spec =
  | { readonly t: "null" }
  | { readonly t: "bool"; readonly v: boolean }
  | { readonly t: "int"; readonly v: bigint }
  | { readonly t: "string"; readonly v: string }
  /** `offset` > 0 hands the TypeScript a view into a larger buffer. */
  | { readonly t: "bytes"; readonly v: Uint8Array; readonly offset: number }
  | { readonly t: "array"; readonly v: readonly Spec[] }
  /** `bare` builds the object with a null prototype. */
  | { readonly t: "record"; readonly v: readonly Entry[]; readonly bare: boolean };
type Entry = readonly [string, Spec];

type WireValue =
  | { t: "null" }
  | { t: "bool"; v: boolean }
  | { t: "int"; v: string }
  | { t: "string"; v: string }
  | { t: "bytes"; v: string }
  | { t: "array"; v: WireValue[] }
  | { t: "record"; v: [string, WireValue][] };

type WireHash = { algorithm: string; canonicalizationVersion: string; digest: string };

function toWire(spec: Spec): WireValue {
  switch (spec.t) {
    case "null":
      return { t: "null" };
    case "bool":
      return { t: "bool", v: spec.v };
    case "int":
      return { t: "int", v: spec.v.toString() };
    case "string":
      return { t: "string", v: textToWire(spec.v) };
    case "bytes":
      return { t: "bytes", v: bytesToWire(spec.v) };
    case "array":
      return { t: "array", v: spec.v.map(toWire) };
    case "record":
      return { t: "record", v: entriesToWire(spec.v) };
  }
}

function entriesToWire(entries: readonly Entry[]): [string, WireValue][] {
  return entries.map(([key, member]) => [textToWire(key), toWire(member)]);
}

/** The JavaScript value the TypeScript is given. A repeated key keeps its last value, as in an
 * object literal, `JSON.parse` and `Object.fromEntries`: a JavaScript object has no other choice. */
function toCanonical(spec: Spec): CanonicalValue {
  switch (spec.t) {
    case "null":
      return null;
    case "bool":
    case "int":
    case "string":
      return spec.v;
    case "bytes": {
      if (spec.offset === 0) return spec.v;
      const backing = new Uint8Array(spec.offset + spec.v.byteLength + 3).fill(0xa5);
      backing.set(spec.v, spec.offset);
      return backing.subarray(spec.offset, spec.offset + spec.v.byteLength);
    }
    case "array":
      return spec.v.map(toCanonical);
    case "record":
      return toRecord(spec.v, spec.bare);
  }
}

function toRecord(entries: readonly Entry[], bare: boolean): { [key: string]: CanonicalValue } {
  const target: { [key: string]: CanonicalValue } = bare ? Object.create(null) : {};
  for (const [key, member] of entries) {
    // Not `target[key] = ...`: that would set the prototype for the key "__proto__".
    Object.defineProperty(target, key, {
      value: toCanonical(member),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return target;
}

function hashToWire(hash: ContentHash): WireHash {
  return {
    algorithm: textToWire(hash.algorithm),
    canonicalizationVersion: textToWire(hash.canonicalizationVersion),
    digest: textToWire(hash.digest),
  };
}

// ---------------------------------------------------------------------------------------------
// Running both sides
// ---------------------------------------------------------------------------------------------

const SEQUENCE_FIELD_REFUSALS = new Set([
  "Invalid canonical sequence field",
  "Canonical sequence exceeds its declared population",
  "Canonical sequence is incomplete",
]);

/** The TypeScript's outcome. `identifier` throws an `IdentityError` with a code. The three refusals
 * of `hashCanonicalSequenceField` are `TypeError`s with no code; the model has one error for all
 * three (`invalidCanonicalSequenceField`), so they are compared as that one. Anything else thrown
 * is a fault of this file and is thrown on. */
function runTs<T>(fn: () => T): OracleOutcome<T> {
  try {
    return { kind: "ok", value: fn() };
  } catch (err) {
    if (err instanceof IdentityError) return { kind: "error", code: err.code };
    if (err instanceof TypeError && SEQUENCE_FIELD_REFUSALS.has(err.message)) {
      return { kind: "error", code: "invalid_canonical_sequence_field" };
    }
    throw err;
  }
}

function showText(text: string): string {
  const points: string[] = [];
  for (let index = 0; index < text.length; index++) {
    const point = text.codePointAt(index) as number;
    points.push(`U+${point.toString(16).toUpperCase().padStart(4, "0")}`);
    if (point > 0xffff) index++;
  }
  return `[${points.join(" ")}]`;
}

function showSpec(spec: Spec): string {
  const text = JSON.stringify(toWire(spec));
  return text.length > 4000 ? `${text.slice(0, 4000)}... (${text.length} characters)` : text;
}

function assertSame<T>(
  fnName: string,
  input: string,
  ts: OracleOutcome<T>,
  lean: OracleOutcome<T>,
): void {
  if (!Bun.deepEquals(ts, lean, true)) {
    throw new Error(
      `${fnName} differs for ${input}:\n  TS:   ${JSON.stringify(ts)}\n  Lean: ${JSON.stringify(lean)}`,
    );
  }
}

const counts = new Map<string, number>();
function count(name: string, by = 1): void {
  counts.set(name, (counts.get(name) ?? 0) + by);
}

// ---------------------------------------------------------------------------------------------
// Code points
// ---------------------------------------------------------------------------------------------

const isSurrogate = (point: number) => point >= 0xd800 && point <= 0xdfff;
const isHangulSyllable = (point: number) => point >= 0xac00 && point <= 0xd7a3;
const chr = (...points: number[]) => String.fromCodePoint(...points);

/** Every Unicode scalar value, in order: 1,112,064 of them. */
function* scalarValues(): Generator<number> {
  for (let point = 0; point <= 0x10ffff; point++) if (!isSurrogate(point)) yield point;
}

/** Classes read from this runtime, to weight the generators (the comparison never trusts them):
 * marks (`\p{M}`), characters with a canonical decomposition, and characters that are not their
 * own NFC (singletons and composition exclusions). */
const MARKS: number[] = [];
const DECOMPOSABLE: number[] = [];
const NOT_OWN_NFC: number[] = [];
const MARK = /^\p{M}$/u;
for (const point of scalarValues()) {
  const text = chr(point);
  if (MARK.test(text)) MARKS.push(point);
  if (isHangulSyllable(point)) continue;
  if (text.normalize("NFD") !== text) DECOMPOSABLE.push(point);
  if (text.normalize("NFC") !== text) NOT_OWN_NFC.push(point);
}

/** Everything `String.prototype.trim` removes (ECMAScript WhiteSpace and LineTerminator). */
const WHITESPACE = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
  0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];
/** Looks like whitespace or sits next to it, and `trim` keeps it. */
const NOT_WHITESPACE = [
  0x00, 0x08, 0x0e, 0x1c, 0x1d, 0x1e, 0x1f, 0x7f, 0x85, 0x9f, 0xa1, 0xad, 0x167f, 0x1681, 0x180e,
  0x1fff, 0x200b, 0x200c, 0x200d, 0x200e, 0x2027, 0x202a, 0x202e, 0x2030, 0x205e, 0x2060, 0x2061,
  0x2800, 0x2fff, 0x3001, 0x303f, 0x3164, 0xfefe, 0xff00, 0xffa0, 0xfff9, 0xe0020,
];
/** General category Cc is U+0000 to U+001F and U+007F to U+009F; the rest here is not Cc. */
const CONTROL_EDGES = [
  0x00, 0x01, 0x09, 0x0a, 0x0d, 0x1b, 0x1f, 0x20, 0x7e, 0x7f, 0x80, 0x85, 0x9f, 0xa0, 0xad, 0x600,
  0x61c, 0x6dd, 0x70f, 0x200e, 0x2028, 0x2029, 0x2060, 0x206f, 0xfeff, 0xfff9, 0xfffb, 0x110bd,
  0x1bca0, 0x1d173, 0xe0001, 0xe007f,
];
/** CompositionExclusions.txt, and non-starter decompositions: decomposed by NFC and never put back. */
const EXCLUSIONS = [
  0x0958, 0x0959, 0x095a, 0x095b, 0x095c, 0x095d, 0x095e, 0x095f, 0x09dc, 0x09dd, 0x09df, 0x0a33,
  0x0a36, 0x0a59, 0x0a5a, 0x0a5b, 0x0a5e, 0x0b5c, 0x0b5d, 0x0f43, 0x0f4d, 0x0f52, 0x0f57, 0x0f5c,
  0x0f69, 0x0f76, 0x0f78, 0x0f93, 0x0f9d, 0x0fa2, 0x0fa7, 0x0fac, 0x0fb9, 0xfb1d, 0xfb1f, 0xfb2a,
  0xfb2b, 0xfb2c, 0xfb2d, 0xfb2e, 0xfb2f, 0xfb30, 0xfb31, 0xfb32, 0xfb33, 0xfb34, 0xfb35, 0xfb36,
  0xfb38, 0xfb39, 0xfb3a, 0xfb3b, 0xfb3c, 0xfb3e, 0xfb40, 0xfb41, 0xfb43, 0xfb44, 0xfb46, 0xfb47,
  0xfb48, 0xfb49, 0xfb4a, 0xfb4b, 0xfb4c, 0xfb4d, 0xfb4e, 0x2adc, 0x1d15e, 0x1d15f, 0x1d160,
  0x1d161, 0x1d162, 0x1d163, 0x1d164, 0x1d1bb, 0x1d1bc, 0x1d1bd, 0x1d1be, 0x1d1bf, 0x1d1c0, 0x0344,
  0x0f73, 0x0f75, 0x0f81, 0x0340, 0x0341, 0x0343, 0x0374, 0x037e, 0x0387, 0x1f71, 0x2000, 0x2001,
  0x2126, 0x212a, 0x212b, 0x2329, 0x232a, 0xf900, 0xfa0e, 0xfad9, 0x2f800, 0x2fa1d,
];
/** Blocks and characters added in Unicode 14.0 to 17.0, with the version of each. */
const RECENT_RANGES: readonly (readonly [number, number])[] = [
  [0x1ac1, 0x1ace], // 14.0 combining marks
  [0x11f00, 0x11f5f], // 15.0 Kawi (virama, ccc 9)
  [0x1e4d0, 0x1e4ff], // 15.0 Nag Mundari (ccc 232, 220, 230)
  [0x10ec0, 0x10eff], // 15.0 to 17.0 Arabic Extended-C (ccc 220)
  [0x1e030, 0x1e08f], // 15.0 Cyrillic Extended-D
  [0x2ebf0, 0x2ee5d], // 15.1 CJK extension I
  [0x10d40, 0x10d8f], // 16.0 Garay (ccc 230)
  [0x16100, 0x1613f], // 16.0 Gurung Khema (eight decompositions)
  [0x16d40, 0x16d7f], // 16.0 Kirat Rai (three decompositions, one of them nested)
  [0x1e5d0, 0x1e5ff], // 16.0 Ol Onal (ccc 230, 220)
  [0x105c0, 0x105ff], // 16.0 Todhri (two decompositions onto U+0307)
  [0x11380, 0x113ff], // 16.0 Tulu-Tigalari (seven decompositions, virama)
  [0x11bc0, 0x11bff], // 16.0 Sunuwar
  [0x1acf, 0x1aeb], // 17.0 combining marks (ccc 230, 220, 234)
  [0x1e6c0, 0x1e6ff], // 17.0 Tai Yo (ccc 230)
  [0x10940, 0x1095f], // 17.0 Sidetic
  [0x11db0, 0x11def], // 17.0 Tolong Siki
  [0x16ea0, 0x16edf], // 17.0 Beria Erfe
  [0x11b60, 0x11b7f], // 17.0 Sharada Supplement
  [0x323b0, 0x3347f], // 17.0 CJK extension J
];
const COMPOSING_BASES: readonly (readonly [number, number])[] = [
  [0x41, 0x5a],
  [0x61, 0x7a],
  [0xc0, 0x24f],
  [0x391, 0x3c9],
  [0x410, 0x44f],
  [0x5d0, 0x5ea],
  [0x627, 0x64a],
  [0x915, 0x939],
  [0x1e00, 0x1fff],
  [0x3041, 0x30ff],
];
const BOUNDARIES = [
  0x00, 0x7f, 0x80, 0xff, 0x100, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xfffd, 0xfffe, 0xffff, 0x10000,
  0x1f600, 0xe0001, 0xf0000, 0x10fffd, 0x10ffff,
];

const fromList = (points: readonly number[]) =>
  fc.integer({ min: 0, max: points.length - 1 }).map((index) => points[index] as number);
const fromRanges = (ranges: readonly (readonly [number, number])[]) =>
  fc.oneof(...ranges.map(([min, max]) => fc.integer({ min, max })));

/** Any scalar value, each as likely as the next. */
const arbAnyScalar = fc
  .integer({ min: 0, max: 0x10ffff - 0x800 })
  .map((point) => (point >= 0xd800 ? point + 0x800 : point));

const arbMark = fc.oneof(
  { weight: 4, arbitrary: fromList(MARKS) },
  { weight: 3, arbitrary: fc.integer({ min: 0x300, max: 0x36f }) },
  {
    weight: 3,
    // One of each canonical combining class that matters for order, low to high.
    arbitrary: fc.constantFrom(
      0x334,
      0x93c,
      0x3099,
      0x94d,
      0x5b0,
      0x5c1,
      0x64b,
      0x670,
      0xe38,
      0xe48,
      0xf71,
      0xf72,
      0xf74,
      0x321,
      0x31b,
      0x1dce,
      0x316,
      0x323,
      0x59a,
      0x1d165,
      0x302a,
      0x300,
      0x301,
      0x308,
      0x315,
      0x35c,
      0x35d,
      0x345,
      0x1aeb,
      0x1e4ec,
    ),
  },
);

const arbJamo = fc.oneof(
  fc.integer({ min: 0x1100, max: 0x11ff }),
  fc.integer({ min: 0xa960, max: 0xa97c }),
  fc.integer({ min: 0xd7b0, max: 0xd7fb }),
);

const arbCodePoint = fc.oneof(
  { weight: 5, arbitrary: fc.integer({ min: 0x20, max: 0x7e }) },
  { weight: 4, arbitrary: fromRanges(COMPOSING_BASES) },
  { weight: 9, arbitrary: arbMark },
  { weight: 3, arbitrary: fromList(DECOMPOSABLE) },
  { weight: 2, arbitrary: fromList(NOT_OWN_NFC) },
  { weight: 2, arbitrary: fromList(EXCLUSIONS) },
  { weight: 2, arbitrary: fc.integer({ min: 0xac00, max: 0xd7a3 }) },
  { weight: 2, arbitrary: arbJamo },
  { weight: 3, arbitrary: fromRanges(RECENT_RANGES) },
  { weight: 2, arbitrary: fromList(WHITESPACE) },
  { weight: 1, arbitrary: fromList(NOT_WHITESPACE) },
  { weight: 2, arbitrary: fc.integer({ min: 0x00, max: 0x9f }) },
  { weight: 1, arbitrary: fromList(CONTROL_EDGES) },
  { weight: 1, arbitrary: fromList(BOUNDARIES) },
  { weight: 4, arbitrary: arbAnyScalar },
);

// ---------------------------------------------------------------------------------------------
// Strings (well formed: no lone surrogate)
// ---------------------------------------------------------------------------------------------

/** A base with several marks in the order they were drawn, which is seldom the canonical one. */
const arbCluster = fc
  .tuple(
    fc.oneof(fromRanges(COMPOSING_BASES), arbCodePoint),
    fc.array(arbMark, { minLength: 1, maxLength: 6 }),
  )
  .map(([base, marks]) => chr(base, ...marks));

const arbLeading = fc.integer({ min: 0x1100, max: 0x1112 });
const arbVowel = fc.integer({ min: 0x1161, max: 0x1175 });
const arbTrailing = fc.integer({ min: 0x11a8, max: 0x11c2 });
const arbSyllable = fc.integer({ min: 0xac00, max: 0xd7a3 });
const arbLvSyllable = fc.integer({ min: 0, max: 398 }).map((index) => 0xac00 + index * 28);

const arbHangul = fc.oneof(
  arbSyllable.map((s) => chr(s)),
  fc.tuple(arbLeading, arbVowel).map(([l, v]) => chr(l, v)),
  fc.tuple(arbLeading, arbVowel, arbTrailing).map(([l, v, t]) => chr(l, v, t)),
  fc.tuple(arbLvSyllable, arbTrailing).map(([s, t]) => chr(s, t)),
  fc.tuple(arbSyllable, arbJamo).map(([s, j]) => chr(s, j)),
  fc.tuple(arbLeading, arbMark, arbVowel).map(([l, m, v]) => chr(l, m, v)),
  fc.tuple(arbLvSyllable, arbMark, arbTrailing).map(([s, m, t]) => chr(s, m, t)),
  // The neighbours of the ranges that compose: U+1113, U+1160, U+1176, U+11A7, U+11C3.
  fc
    .tuple(
      fc.constantFrom(0x10ff, 0x1100, 0x1112, 0x1113, 0x115f),
      fc.constantFrom(0x1160, 0x1161, 0x1175, 0x1176),
      fc.constantFrom(0x11a7, 0x11a8, 0x11c2, 0x11c3),
    )
    .map(([l, v, t]) => chr(l, v, t)),
  fc.array(arbJamo, { minLength: 1, maxLength: 4 }).map((points) => chr(...points)),
);

const arbPiece = fc.oneof(
  { weight: 6, arbitrary: arbCodePoint.map((point) => chr(point)) },
  { weight: 4, arbitrary: arbCluster },
  { weight: 2, arbitrary: arbHangul },
  { weight: 1, arbitrary: fc.string({ maxLength: 6 }).map((text) => text.toWellFormed()) },
);

const arbCore = fc.array(arbPiece, { maxLength: 5 }).map((pieces) => pieces.join(""));

/** The same text as drawn, composed, decomposed, or decomposed and then put out of order. */
const arbFormed = fc
  .tuple(
    arbCore,
    fc.constantFrom("raw", "raw", "nfc", "nfd", "shuffled"),
    fc.array(fc.nat(7), { minLength: 1, maxLength: 12 }),
  )
  .map(([core, form, keys]) => {
    if (form === "raw") return core;
    if (form === "nfc") return core.normalize("NFC");
    if (form === "nfd") return core.normalize("NFD");
    const decomposed = Array.from(core.normalize("NFD"));
    return decomposed
      .map((char, index) => ({ char, index, key: index + (keys[index % keys.length] as number) }))
      .sort((left, right) => left.key - right.key || left.index - right.index)
      .map((item) => item.char)
      .join("");
  });

const arbEnds = fc
  .array(fc.oneof({ weight: 3, arbitrary: fromList(WHITESPACE) }, fromList(NOT_WHITESPACE)), {
    maxLength: 2,
  })
  .map((points) => chr(...points));

const arbText: fc.Arbitrary<string> = fc.oneof(
  { weight: 6, arbitrary: arbFormed },
  {
    weight: 3,
    arbitrary: fc
      .tuple(arbEnds, arbFormed, arbEnds)
      .map(([head, body, tail]) => head + body + tail),
  },
  { weight: 1, arbitrary: fc.constantFrom("", "a", " ", "sha256", "__proto__") },
);

const CONTROLS = /\p{Cc}/gu;
/** Pushes a text toward what `identifier` accepts, so that both answers are well represented. */
const tidy = (text: string) => text.replace(CONTROLS, "").normalize("NFC").trim();

const arbIdentifierInput: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: arbText },
  { weight: 4, arbitrary: arbText.map(tidy) },
  {
    weight: 2,
    // A tidy text spoiled in one place: by one character at the front, in the middle or at the end.
    arbitrary: fc
      .tuple(arbText.map(tidy), arbCodePoint, fc.nat(64), fc.constantFrom("front", "inside", "end"))
      .map(([text, point, at, where]) => {
        const chars = Array.from(text);
        const index =
          where === "front" ? 0 : where === "end" ? chars.length : at % (chars.length + 1);
        chars.splice(index, 0, chr(point));
        return chars.join("");
      }),
  },
);

// ---------------------------------------------------------------------------------------------
// Canonical values
// ---------------------------------------------------------------------------------------------

const arbInt: fc.Arbitrary<bigint> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.constantFrom(
      0n,
      -0n,
      1n,
      -1n,
      9n,
      10n,
      -10n,
      MAX_SAFE - 1n,
      MAX_SAFE,
      MAX_SAFE + 1n,
      -MAX_SAFE,
      -MAX_SAFE - 1n,
      (1n << 63n) - 1n,
      1n << 63n,
      -(1n << 63n),
      (1n << 64n) - 1n,
      1n << 64n,
      10n ** 100n,
      -(10n ** 100n),
      (1n << 16384n) - 1n,
      1n << 16384n,
      -(1n << 16384n),
      10n ** 6000n,
      -(10n ** 6000n) + 1n,
    ),
  },
  { weight: 3, arbitrary: fc.bigInt({ min: -1000n, max: 1000n }) },
  { weight: 2, arbitrary: fc.bigInt({ min: -(1n << 70n), max: 1n << 70n }) },
  { weight: 1, arbitrary: fc.bigInt({ min: MAX_SAFE - 8n, max: MAX_SAFE + 8n }) },
  { weight: 1, arbitrary: fc.bigInt({ min: -(1n << 2048n), max: 1n << 2048n }) },
  { weight: 1, arbitrary: fc.bigInt({ min: -(1n << 20000n), max: 1n << 20000n }) },
);

const arbBytes = fc
  .tuple(
    fc.oneof(
      { weight: 5, arbitrary: fc.uint8Array({ maxLength: 40 }) },
      // Around the block boundaries of SHA-256 (55, 56, 63, 64, 119, 120 bytes of message).
      { weight: 2, arbitrary: fc.uint8Array({ minLength: 40, maxLength: 140 }) },
      {
        weight: 1,
        arbitrary: fc.constantFrom(new Uint8Array(0), new Uint8Array([0]), new Uint8Array([255])),
      },
    ),
    fc.constantFrom(0, 0, 1, 7),
  )
  .map(([v, offset]): Spec => ({ t: "bytes", v, offset }));

const arbKey: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: arbText },
  { weight: 3, arbitrary: fc.string({ maxLength: 4 }).map((text) => text.toWellFormed()) },
  {
    weight: 3,
    // Names JavaScript treats specially, keys JavaScript puts in numeric order, keys that differ
    // only in normalization form, and keys whose UTF-8 and UTF-16 orders disagree.
    arbitrary: fc.constantFrom(
      "",
      "__proto__",
      "constructor",
      "length",
      "toString",
      "hasOwnProperty",
      "0",
      "1",
      "9",
      "10",
      "-0",
      "01",
      "4294967295",
      "a",
      "A",
      "aa",
      "ab",
      "b",
      chr(0xe9),
      chr(0x65, 0x301),
      chr(0xd7ff),
      chr(0xe000),
      chr(0xffff),
      chr(0x10000),
      chr(0x10ffff),
      chr(0),
    ),
  },
);

const leaf: fc.Arbitrary<Spec> = fc.oneof(
  { weight: 1, arbitrary: fc.constant<Spec>({ t: "null" }) },
  { weight: 1, arbitrary: fc.boolean().map((v): Spec => ({ t: "bool", v })) },
  { weight: 3, arbitrary: arbInt.map((v): Spec => ({ t: "int", v })) },
  { weight: 3, arbitrary: arbText.map((v): Spec => ({ t: "string", v })) },
  { weight: 2, arbitrary: arbBytes },
);

const arbEntriesOf = (value: fc.Arbitrary<Spec>, maxLength: number): fc.Arbitrary<Entry[]> =>
  fc.uniqueArray(fc.tuple(arbKey, value), { selector: (entry) => entry[0], maxLength });

/** Every kind, nested. The keys of a record are distinct and in the order they were drawn. */
const { value: arbValue } = fc.letrec<{ value: Spec; array: Spec; record: Spec }>((tie) => ({
  value: fc.oneof(
    { maxDepth: 4, withCrossShrink: true },
    { weight: 5, arbitrary: leaf },
    { weight: 2, arbitrary: tie("array") },
    { weight: 3, arbitrary: tie("record") },
  ),
  array: fc.array(tie("value"), { maxLength: 5 }).map((v): Spec => ({ t: "array", v })),
  record: fc
    .tuple(arbEntriesOf(tie("value"), 6), fc.boolean())
    .map(([v, bare]): Spec => ({ t: "record", v, bare })),
}));

const nullList = (length: number) => Array.from({ length }, (): Spec => ({ t: "null" }));
const nulls = (length: number): Spec => ({ t: "array", v: nullList(length) });
const text = (v: string): Spec => ({ t: "string", v });
const int = (v: bigint): Spec => ({ t: "int", v });
const bytes = (v: Uint8Array): Spec => ({ t: "bytes", v, offset: 0 });
const record = (...v: Entry[]): Spec => ({ t: "record", v, bare: false });
const patterned = (length: number) =>
  Uint8Array.from({ length }, (_, index) => (index * 131 + 7) & 0xff);

function nested(depth: number): Spec {
  let spec: Spec = { t: "null" };
  for (let level = 0; level < depth; level++) {
    spec = level % 2 === 0 ? { t: "array", v: [spec] } : record(["k", spec]);
  }
  return spec;
}

/** Fixed values: the kernel's own test vectors, every kind once, and values whose structural
 * tokens are longer than the 4,096 bytes the TypeScript's hash writer buffers before it hashes. */
const valueExamples: [Spec][] = [
  [{ t: "null" }],
  [{ t: "bool", v: true }],
  [{ t: "bool", v: false }],
  [int(0n)],
  [int(-0n)],
  [int(-1n)],
  [text("")],
  [text(chr(0x1f600))],
  [bytes(new Uint8Array(0))],
  [{ t: "array", v: [] }],
  [record()],
  [{ t: "record", v: [], bare: true }],
  [record(["type", text("example")], ["amount", int(100n)])],
  [record(["beta", int(2n)], ["alpha", text("one")])],
  [record(["__proto__", { t: "null" }], ["constructor", record(["__proto__", int(1n)])])],
  [record(["10", int(10n)], ["9", int(9n)], ["1", int(1n)], ["01", int(0n)])],
  [record([chr(0xffff), int(1n)], [chr(0x10000), int(2n)], [chr(0xe000), int(3n)])],
  [record([chr(0xe9), int(1n)], [chr(0x65, 0x301), int(2n)])],
  [nulls(4089)],
  [nulls(4090)],
  [nulls(4091)],
  [nulls(4096)],
  [nulls(9000)],
  [int(10n ** 4094n)],
  [int(10n ** 4095n)],
  [int(-(10n ** 4093n))],
  [int(-(10n ** 4094n))],
  [int(10n ** 9000n)],
  [{ t: "array", v: Array.from({ length: 3000 }, (_, index) => int(BigInt(index) - 1500n)) }],
  [
    {
      t: "array",
      v: Array.from({ length: 1500 }, (_, index) =>
        index % 3 === 0
          ? text(chr(0xe9).repeat(index % 7))
          : index % 3 === 1
            ? int(7n)
            : bytes(patterned(index % 5)),
      ),
    },
  ],
  [text("a".repeat(5000))],
  [text(chr(0x10000).repeat(2000))],
  [bytes(patterned(70_000))],
  [
    record(
      ...Array.from(
        { length: 600 },
        (_, index): Entry => [`key-${(index * 7919) % 600}`, int(BigInt(index))],
      ),
    ),
  ],
  [nested(64)],
  [nested(600)],
];

// ---------------------------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------------------------

describe("Canonical Lean oracle equivalence", () => {
  let oracle: OracleClient;

  beforeAll(() => {
    oracle = OracleClient.start();
  });

  afterAll(async () => {
    await oracle.close();
    if (process.env.ORACLE_COUNTS) {
      for (const [name, cases] of counts) console.log(`${String(cases).padStart(9)}  ${name}`);
    }
  });

  type Each = { ok?: unknown; error?: string };
  const eachOutcome = (answer: Each): string =>
    answer.error === undefined ? `ok:${JSON.stringify(answer.ok)}` : `error:${answer.error}`;

  /** Many calls of one entry in few requests; fails on the first input, in the order given, where
   * the two differ. `ts` gives the TypeScript's answer in wire form. */
  async function sweep(
    name: string,
    fn: "identifier" | "toNFC" | "jsTrim" | "compareCanonicalText",
    inputs: Iterable<readonly string[]>,
    ts: (...args: string[]) => unknown,
  ): Promise<number> {
    let total = 0;
    let batch: (readonly string[])[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      const answer = await oracle.call<Each[]>(`${fn}.each`, [
        batch.map((args) => args.map(textToWire)),
      ]);
      if (answer.kind !== "ok" || answer.value.length !== batch.length) {
        throw new Error(
          `${fn}.each did not answer every call: ${JSON.stringify(answer).slice(0, 300)}`,
        );
      }
      for (let index = 0; index < batch.length; index++) {
        const args = batch[index] as readonly string[];
        const tsOutcome = runTs(() => ts(...args));
        const expected =
          tsOutcome.kind === "ok"
            ? `ok:${JSON.stringify(tsOutcome.value)}`
            : `error:${tsOutcome.code}`;
        const actual = eachOutcome(answer.value[index] as Each);
        if (expected !== actual) {
          // A string answer is also shown as its code points.
          const read = (outcome: string) =>
            fn !== "compareCanonicalText" && outcome.startsWith('ok:"')
              ? `${outcome} ${showText(textFromWire(outcome.slice(4, -1)))}`
              : outcome;
          throw new Error(
            `${fn} differs for ${args.map(showText).join(", ")} (${name}; this runtime has Unicode ${process.versions.unicode}, the model's tables are Unicode 17.0):\n  TS:   ${read(expected)}\n  Lean: ${read(actual)}`,
          );
        }
      }
      total += batch.length;
      batch = [];
    };
    for (const args of inputs) {
      batch.push(args);
      if (batch.length === BATCH) await flush();
    }
    await flush();
    count(name, total);
    return total;
  }

  const tsIdentifier = (value: string) => textToWire(identifier(value));
  const tsNfc = (value: string) => textToWire(value.normalize("NFC"));
  const tsTrim = (value: string) => textToWire(value.trim());

  // -------------------------------------------------------------------------------------------
  // identifier
  // -------------------------------------------------------------------------------------------

  test(
    "identifier matches Lean",
    async () => {
      let accepted = 0;
      let refused = 0;
      const examples: [string][] = [
        [""],
        ["a"],
        [" padded "],
        [`bad${chr(0)}id`],
        [chr(0x65, 0x301)],
        [chr(0xe9)],
        [chr(0xfeff)],
        [`a${chr(0x85)}`],
        [chr(0x85)],
        [chr(0x180e)],
        [chr(0x2000)],
        [`a${chr(0x2000)}b`],
        [chr(0x212b)],
        [chr(0x1100, 0x1161)],
        [chr(0xac00, 0x11a8)],
        [chr(0xac00)],
        [chr(0x71, 0x301, 0x323)],
        [chr(0x71, 0x323, 0x301)],
        [chr(0x300)],
        [chr(0x16d68)],
        [chr(0x16d67, 0x16d67)],
        [chr(0x105d2, 0x307)],
        [chr(0x71, 0x1e6e3, 0x1aeb)],
        [chr(0x71, 0x1aeb, 0x1e6e3)],
        [chr(0x10ffff)],
      ];
      await fc.assert(
        fc.asyncProperty(arbIdentifierInput, async (value) => {
          const tsOutcome = runTs(() => tsIdentifier(value));
          const leanOutcome = await oracle.call<string>("identifier", [textToWire(value)]);
          assertSame("identifier", showText(value), tsOutcome, leanOutcome);
          count("identifier");
          if (tsOutcome.kind === "ok") accepted++;
          else refused++;
        }),
        { seed: SEED, numRuns: NUM_RUNS + examples.length, examples },
      );
      // Both answers must be common, or the agreement says little.
      expect(accepted).toBeGreaterThan(NUM_RUNS / 5);
      expect(refused).toBeGreaterThan(NUM_RUNS / 5);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "identifier matches Lean for every Unicode scalar value, alone and between two letters",
    async () => {
      const alone = await sweep(
        "identifier: every scalar value alone",
        "identifier",
        (function* () {
          for (const point of scalarValues()) yield [chr(point)];
        })(),
        tsIdentifier,
      );
      const between = await sweep(
        "identifier: every scalar value between two letters",
        "identifier",
        (function* () {
          for (const point of scalarValues()) yield [`a${chr(point)}a`];
        })(),
        tsIdentifier,
      );
      expect(alone).toBe(1_112_064);
      expect(between).toBe(1_112_064);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the model's trim matches String.prototype.trim",
    async () => {
      await sweep(
        "jsTrim: every scalar value alone",
        "jsTrim",
        (function* () {
          for (const point of scalarValues()) yield [chr(point)];
        })(),
        tsTrim,
      );
      await sweep(
        "jsTrim: every scalar value at both ends of a letter",
        "jsTrim",
        (function* () {
          for (const point of scalarValues()) yield [`${chr(point)}a${chr(point)}`];
        })(),
        tsTrim,
      );
      // Every pair of whitespace characters at each end, and whitespace kept inside.
      await sweep(
        "jsTrim: whitespace pairs",
        "jsTrim",
        (function* () {
          const ends = [...WHITESPACE, ...NOT_WHITESPACE];
          for (const first of ends) {
            for (const second of ends) {
              yield [`${chr(first, second)}a${chr(second)}b${chr(second, first)}`];
              yield [chr(first, second)];
            }
          }
        })(),
        tsTrim,
      );
      await fc.assert(
        fc.asyncProperty(arbText, async (value) => {
          const leanOutcome = await oracle.call<string>("jsTrim", [textToWire(value)]);
          assertSame(
            "jsTrim",
            showText(value),
            runTs(() => tsTrim(value)),
            leanOutcome,
          );
          count("jsTrim");
        }),
        { seed: SEED, numRuns: NUM_RUNS },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the model's NFC matches String.prototype.normalize for every Unicode scalar value",
    async () => {
      const each = (name: string, make: (char: string) => string) =>
        sweep(
          name,
          "toNFC",
          (function* () {
            for (const point of scalarValues()) yield [make(chr(point))];
          })(),
          tsNfc,
        );
      await each("toNFC: every scalar value alone", (char) => char);
      await each("toNFC: the canonical decomposition of every scalar value", (char) =>
        char.normalize("NFD"),
      );
      // Two probes that show the combining class of every character: a mark of class 1 after it
      // changes places with it when its class is higher, and it changes places with a mark of
      // class 240 before it when its class is lower and not zero.
      await each(
        "toNFC: every scalar value before a mark of class 1",
        (char) => `q${char}${chr(0x334)}`,
      );
      await each(
        "toNFC: every scalar value after a mark of class 240",
        (char) => `q${chr(0x345)}${char}`,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the model's NFC matches for every pair of marks and every pair that could compose",
    async () => {
      // Nonzero combining class, read from this runtime with the two probes above.
      const reordering: string[] = [];
      const firsts = new Set<string>();
      const seconds = new Set<string>();
      for (const point of scalarValues()) {
        const char = chr(point);
        const decomposed = Array.from(char.normalize("NFD"));
        if (decomposed.length === 1 && decomposed[0] === char) {
          const after = `q${char}${chr(0x334)}`;
          const before = `q${chr(0x345)}${char}`;
          if (after.normalize("NFD") !== after || before.normalize("NFD") !== before) {
            reordering.push(char);
          }
          continue;
        }
        if (isHangulSyllable(point)) continue;
        // Every character that starts a composition on the way to a composite, and every
        // character that is added on the way.
        firsts.add(char);
        for (let length = 1; length <= decomposed.length; length++) {
          const prefix = decomposed.slice(0, length).join("").normalize("NFC");
          firsts.add(Array.from(prefix)[0] as string);
        }
        decomposed.forEach((part, index) => {
          firsts.add(part);
          if (index > 0) seconds.add(part);
        });
      }
      expect(reordering.length).toBeGreaterThan(900);
      expect(firsts.size).toBeGreaterThan(3000);
      expect(seconds.size).toBeGreaterThan(80);

      await sweep(
        "toNFC: every pair of marks on a base",
        "toNFC",
        (function* () {
          for (const first of reordering)
            for (const second of reordering) yield [`q${first}${second}`];
        })(),
        tsNfc,
      );
      await sweep(
        "toNFC: every first part with every second part",
        "toNFC",
        (function* () {
          for (const first of firsts) for (const second of seconds) yield [first + second];
        })(),
        tsNfc,
      );
      // A mark between the two parts blocks the composition when its class is not lower.
      await sweep(
        "toNFC: every first part, a mark, every second part",
        "toNFC",
        (function* () {
          for (const first of firsts) {
            for (const mark of [0x334, 0x323, 0x301, 0x345]) {
              for (const second of seconds) yield [first + chr(mark) + second];
            }
          }
        })(),
        tsNfc,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the model's NFC matches for Hangul syllables and jamo",
    async () => {
      const jamo: number[] = [];
      for (let point = 0x1100; point <= 0x11ff; point++) jamo.push(point);
      for (let point = 0xa960; point <= 0xa97f; point++) jamo.push(point);
      for (let point = 0xd7b0; point <= 0xd7ff; point++) jamo.push(point);
      await sweep(
        "toNFC: every pair of jamo",
        "toNFC",
        (function* () {
          for (const first of jamo) for (const second of jamo) yield [chr(first, second)];
        })(),
        tsNfc,
      );
      await sweep(
        "toNFC: every leading, vowel and trailing jamo together, and their neighbours",
        "toNFC",
        (function* () {
          for (let l = 0x10ff; l <= 0x1113; l++) {
            for (let v = 0x1160; v <= 0x1176; v++) {
              for (let t = 0x11a6; t <= 0x11c4; t++) yield [chr(l, v, t)];
            }
          }
        })(),
        tsNfc,
      );
      await sweep(
        "toNFC: every syllable followed by a jamo or a mark",
        "toNFC",
        (function* () {
          for (let s = 0xabff; s <= 0xd7a4; s++) {
            for (const t of [0x11a7, 0x11a8, 0x11b0, 0x11c2, 0x11c3, 0x1161, 0x1175, 0x301]) {
              yield [chr(s, t)];
            }
          }
        })(),
        tsNfc,
      );
      await sweep(
        "toNFC: every two-jamo syllable and its successor before every jamo, and with a mark between",
        "toNFC",
        (function* () {
          for (let s = 0xac00; s <= 0xd7a3; s += 28) {
            for (const j of jamo) {
              yield [chr(s, j)];
              yield [chr(s, 0x301, j)];
              yield [chr(s + 1, j)];
            }
          }
        })(),
        tsNfc,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the model's NFC matches on generated text",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbText, async (value) => {
          const leanOutcome = await oracle.call<string>("toNFC", [textToWire(value)]);
          assertSame(
            "toNFC",
            showText(value),
            runTs(() => tsNfc(value)),
            leanOutcome,
          );
          count("toNFC");
        }),
        { seed: SEED, numRuns: NUM_RUNS * 2 },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "characters added in Unicode 15.0, 16.0 and 17.0 normalize the same way in both",
    async () => {
      // If this runtime's Unicode data were older than the model's tables (Unicode 17.0), these
      // would be the first to differ; `process.versions.unicode` says what the runtime has.
      const cases: readonly (readonly [string, string])[] = [
        [chr(0x71, 0x1e4ef, 0x1e4ee), chr(0x71, 0x1e4ee, 0x1e4ef)], // 15.0: class 230 after 220
        [chr(0x16d68), chr(0x16d68)], // 16.0: Kirat Rai AI is its own NFC
        [chr(0x16d67, 0x16d67), chr(0x16d68)], // 16.0: and E + E composes to it
        [chr(0x16d63, 0x16d67, 0x16d67), chr(0x16d6a)], // 16.0: a composite of a composite
        [chr(0x105d2, 0x307), chr(0x105c9)], // 16.0: Todhri onto a mark of 1.1
        [chr(0x113c2, 0x113c9), chr(0x113c8)], // 16.0: Tulu-Tigalari
        [chr(0x1611e, 0x1611e, 0x1611f), chr(0x16126)], // 16.0: Gurung Khema, nested
        [chr(0x71, 0x10d69, 0x323), chr(0x71, 0x323, 0x10d69)], // 16.0: Garay, class 230
        [chr(0x71, 0x1e6e3, 0x323), chr(0x71, 0x323, 0x1e6e3)], // 17.0: Tai Yo, class 230
        [chr(0x71, 0x1aeb, 0x1ae0), chr(0x71, 0x1ae0, 0x1aeb)], // 17.0: class 234 after 230
        [chr(0x71, 0x301, 0x1ae6), chr(0x71, 0x1ae6, 0x301)], // 17.0: class 220 before 230
      ];
      for (const [input, expected] of cases) {
        expect(showText(input.normalize("NFC"))).toBe(showText(expected));
        const leanOutcome = await oracle.call<string>("toNFC", [textToWire(input)]);
        assertSame(
          "toNFC",
          showText(input),
          { kind: "ok", value: textToWire(expected) },
          leanOutcome,
        );
        const refused = input !== expected;
        expect(runTs(() => tsIdentifier(input)).kind).toBe(refused ? "error" : "ok");
        const leanIdentifier = await oracle.call<string>("identifier", [textToWire(input)]);
        assertSame(
          "identifier",
          showText(input),
          runTs(() => tsIdentifier(input)),
          leanIdentifier,
        );
        count("recent Unicode versions");
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------------------------
  // canonicalEncode and hashCanonical
  // -------------------------------------------------------------------------------------------

  test(
    "canonicalEncode matches Lean",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbValue, async (spec) => {
          const tsOutcome = runTs(() => bytesToWire(canonicalEncode(toCanonical(spec))));
          const leanOutcome = await oracle.call<string>("canonicalEncode", [toWire(spec)]);
          assertSame("canonicalEncode", showSpec(spec), tsOutcome, leanOutcome);
          count("canonicalEncode");
        }),
        { seed: SEED, numRuns: NUM_RUNS + valueExamples.length, examples: valueExamples },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "hashCanonical matches Lean",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbValue, async (spec) => {
          const tsOutcome = runTs(() => hashToWire(hashCanonical(toCanonical(spec))));
          const leanOutcome = await oracle.call<WireHash>("hashCanonical", [toWire(spec)]);
          assertSame("hashCanonical", showSpec(spec), tsOutcome, leanOutcome);
          count("hashCanonical");
        }),
        // A different seed from canonicalEncode, so the two see different values.
        { seed: SEED + 1, numRuns: NUM_RUNS + valueExamples.length, examples: valueExamples },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "hashCanonical matches Lean at every message length around the SHA-256 block boundaries",
    async () => {
      const lengths: number[] = [];
      for (let length = 0; length <= 300; length++) lengths.push(length);
      for (let length = 4080; length <= 4110; length++) lengths.push(length);
      lengths.push(8191, 8192, 8193, 65_535, 65_536);
      for (const length of lengths) {
        for (const spec of [bytes(patterned(length)), text("z".repeat(length)), nulls(length)]) {
          const tsOutcome = runTs(() => hashToWire(hashCanonical(toCanonical(spec))));
          const leanOutcome = await oracle.call<WireHash>("hashCanonical", [toWire(spec)]);
          assertSame("hashCanonical", `${spec.t} of length ${length}`, tsOutcome, leanOutcome);
          count("hashCanonical: lengths");
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a record encodes the same in every order of its keys, in both",
    async () => {
      const keys = [
        "",
        "a",
        "ab",
        "b",
        "B",
        "1",
        "9",
        "10",
        "01",
        "__proto__",
        "length",
        " a",
        chr(0),
        chr(0xe9),
        chr(0x65, 0x301),
        chr(0xd7ff),
        chr(0xe000),
        chr(0xffff),
        chr(0x10000),
        chr(0x10ffff),
      ];
      const permutations = <T>(items: readonly T[]): T[][] =>
        items.length <= 1
          ? [[...items]]
          : items.flatMap((item, index) =>
              permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
                item,
                ...rest,
              ]),
            );
      const sets: string[][] = [];
      for (const first of keys)
        for (const second of keys) if (first < second) sets.push([first, second]);
      for (let start = 0; start + 4 <= keys.length; start++)
        sets.push(keys.slice(start, start + 4));
      for (let start = 0; start < keys.length; start += 5) {
        sets.push([0, 7, 11, 13, 17].map((step) => keys[(start + step) % keys.length] as string));
      }
      for (const set of sets) {
        const members = new Map(set.map((key, index) => [key, int(BigInt(index))] as const));
        let first: string | undefined;
        for (const order of permutations(set)) {
          const spec: Spec = {
            t: "record",
            v: order.map((key): Entry => [key, members.get(key) as Spec]),
            bare: order.length % 2 === 0,
          };
          const tsOutcome = runTs(() => bytesToWire(canonicalEncode(toCanonical(spec))));
          const leanOutcome = await oracle.call<string>("canonicalEncode", [toWire(spec)]);
          assertSame("canonicalEncode", showSpec(spec), tsOutcome, leanOutcome);
          if (tsOutcome.kind !== "ok") throw new Error("unreachable");
          first ??= tsOutcome.value;
          expect(tsOutcome.value).toBe(first);
          count("canonicalEncode: key orders");
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "canonicalEncode matches Lean for every Unicode scalar value, as a string and as a key",
    async () => {
      // The UTF-8 of every character (`TextEncoder` against Lean's `String.toUTF8`), and the order
      // of every character as a key: each record has its keys in descending order of code point.
      const encode = async (spec: Spec) => ({
        ts: runTs(() => bytesToWire(canonicalEncode(toCanonical(spec)))),
        lean: await oracle.call<string>("canonicalEncode", [toWire(spec)]),
      });
      let chunk: number[] = [];
      const flush = async () => {
        const strings: Spec = { t: "array", v: chunk.map((point) => text(chr(point))) };
        const keys: Spec = {
          t: "record",
          v: [...chunk].reverse().map((point): Entry => [chr(point), { t: "null" }]),
          bare: true,
        };
        for (const spec of [strings, keys]) {
          const both = await encode(spec);
          if (Bun.deepEquals(both.ts, both.lean, true)) continue;
          // Name the first character that differs by itself, if one does.
          for (const point of chunk) {
            const one = await encode(
              spec === strings ? text(chr(point)) : record([chr(point), { t: "null" }]),
            );
            assertSame("canonicalEncode", `${spec.t} of ${showText(chr(point))}`, one.ts, one.lean);
          }
          assertSame("canonicalEncode", showSpec(spec), both.ts, both.lean);
        }
        count("canonicalEncode: every scalar value as a string and as a key", chunk.length);
        chunk = [];
      };
      for (const point of scalarValues()) {
        chunk.push(point);
        if (chunk.length === BATCH) await flush();
      }
      await flush();
      expect(counts.get("canonicalEncode: every scalar value as a string and as a key")).toBe(
        1_112_064,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test("zero has one encoding, however it was written", async () => {
    const zeros = [0n, -0n, 0n * -1n, BigInt(-0), BigInt("-0"), BigInt.asIntN(64, -0n), 5n - 5n];
    for (const zero of zeros) {
      expect(bytesToWire(canonicalEncode(zero))).toBe("69303b");
    }
    // The wire can say "-0", which no bigint prints as; the model reads it as zero.
    for (const written of ["0", "-0"]) {
      const leanOutcome = await oracle.call<string>("canonicalEncode", [{ t: "int", v: written }]);
      assertSame("canonicalEncode", `int ${written}`, { kind: "ok", value: "69303b" }, leanOutcome);
      count("canonicalEncode: zero");
    }
  });

  // -------------------------------------------------------------------------------------------
  // hashCanonicalSequenceField
  // -------------------------------------------------------------------------------------------

  type SequenceCase = {
    readonly fields: readonly Entry[];
    readonly bare: boolean;
    readonly field: string;
    readonly length: bigint;
    readonly values: readonly Spec[];
    /** Hand the values over as a one-pass iterator, not an array. */
    readonly lazy: boolean;
  };

  const arbSequenceCase: fc.Arbitrary<SequenceCase> = fc
    .record({
      fields: arbEntriesOf(arbValue, 5),
      bare: fc.boolean(),
      fresh: arbKey,
      // Above 6: take the field's name from the record, which must be refused.
      pick: fc.nat(9),
      values: fc.array(arbValue, { maxLength: 6 }),
      length: fc.oneof(
        { weight: 8, arbitrary: fc.constant<bigint | undefined>(undefined) },
        { weight: 3, arbitrary: fc.bigInt({ min: -2n, max: 8n }) },
        {
          weight: 3,
          arbitrary: fc.constantFrom(
            0n,
            -1n,
            MAX_SAFE - 1n,
            MAX_SAFE,
            MAX_SAFE + 1n,
            MAX_SAFE + 2n,
            -MAX_SAFE,
            1n << 53n,
            1n << 63n,
            1n << 64n,
            -(1n << 64n),
            10n ** 400n,
            -(10n ** 400n),
          ),
        },
        { weight: 1, arbitrary: fc.bigInt({ min: MAX_SAFE - 4n, max: MAX_SAFE + 4n }) },
      ),
      lazy: fc.boolean(),
    })
    .map(({ fields, bare, fresh, pick, values, length, lazy }) => ({
      fields,
      bare,
      field: pick > 6 && fields.length > 0 ? (fields[pick % fields.length] as Entry)[0] : fresh,
      length: length ?? BigInt(values.length),
      values,
      lazy,
    }));

  function tsSequence(input: SequenceCase): OracleOutcome<WireHash> {
    const members = input.values.map(toCanonical);
    const values: Iterable<CanonicalValue> = input.lazy ? members.values() : members;
    return runTs(() =>
      hashToWire(
        hashCanonicalSequenceField(
          toRecord(input.fields, input.bare),
          input.field,
          input.length,
          values,
        ),
      ),
    );
  }

  const leanSequence = (input: SequenceCase) =>
    oracle.call<WireHash>("hashCanonicalSequenceField", [
      entriesToWire(input.fields),
      textToWire(input.field),
      input.length.toString(),
      input.values.map(toWire),
    ]);

  const showSequence = (input: SequenceCase) =>
    `fields ${JSON.stringify(entriesToWire(input.fields))}, field ${showText(input.field)}, length ${input.length}, values ${JSON.stringify(input.values.map(toWire))}`;

  test(
    "hashCanonicalSequenceField matches Lean",
    async () => {
      let hashed = 0;
      let refused = 0;
      const one = (overrides: Partial<SequenceCase>): [SequenceCase] => [
        {
          fields: [],
          bare: false,
          field: "lines",
          length: 0n,
          values: [],
          lazy: false,
          ...overrides,
        },
      ];
      const three: Spec[] = [int(1n), text("two"), nulls(3)];
      const examples: [SequenceCase][] = [
        one({}),
        one({ length: 1n }),
        one({ length: -1n }),
        one({ values: three, length: 3n }),
        one({ values: three, length: 3n, lazy: true }),
        one({ values: three, length: 2n }),
        one({ values: three, length: 4n }),
        one({ values: three, length: MAX_SAFE }),
        one({ values: three, length: MAX_SAFE + 1n }),
        one({ length: MAX_SAFE }),
        one({ length: MAX_SAFE + 1n }),
        one({ length: 1n << 64n }),
        one({ fields: [["lines", int(1n)]] }),
        one({ fields: [["lines", int(1n)]], length: -1n }),
        one({
          fields: [
            ["a", int(1n)],
            ["z", int(2n)],
          ],
          values: three,
          length: 3n,
        }),
        one({
          fields: [
            ["z", int(1n)],
            ["a", int(2n)],
          ],
          values: three,
          length: 3n,
          bare: true,
        }),
        one({ field: "", values: three, length: 3n }),
        one({ field: "__proto__", values: three, length: 3n }),
        one({ field: "__proto__", fields: [["__proto__", int(1n)]] }),
        one({
          field: "x",
          fields: [["__proto__", record(["x", int(1n)])]],
          values: three,
          length: 3n,
        }),
        one({ field: "toString", values: three, length: 3n }),
        one({
          field: "10",
          fields: [
            ["9", int(9n)],
            ["1", int(1n)],
          ],
          values: three,
          length: 3n,
        }),
        one({ field: chr(0xe9), fields: [[chr(0x65, 0x301), int(1n)]], values: three, length: 3n }),
        one({ field: chr(0x10000), fields: [[chr(0xffff), int(1n)]], values: three, length: 3n }),
        one({ values: nullList(5000), length: 5000n }),
        one({ values: nullList(5000), length: 4999n, lazy: true }),
      ];
      await fc.assert(
        fc.asyncProperty(arbSequenceCase, async (input) => {
          const tsOutcome = tsSequence(input);
          assertSame(
            "hashCanonicalSequenceField",
            showSequence(input),
            tsOutcome,
            await leanSequence(input),
          );
          count("hashCanonicalSequenceField");
          if (tsOutcome.kind === "ok") hashed++;
          else refused++;
        }),
        { seed: SEED, numRuns: NUM_RUNS + examples.length, examples },
      );
      expect(hashed).toBeGreaterThan(NUM_RUNS / 5);
      expect(refused).toBeGreaterThan(NUM_RUNS / 5);
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------------------------
  // compareCanonicalText
  // -------------------------------------------------------------------------------------------

  const arbTextPair: fc.Arbitrary<[string, string]> = fc.oneof(
    { weight: 3, arbitrary: fc.tuple(arbText, arbText) },
    { weight: 1, arbitrary: arbText.map((value): [string, string] => [value, value]) },
    // One is the start of the other.
    {
      weight: 2,
      arbitrary: fc
        .tuple(arbText, arbPiece, fc.boolean())
        .map(([value, more, swap]): [string, string] =>
          swap ? [value + more, value] : [value, value + more],
        ),
    },
    // The same start, then two characters whose UTF-16 order and code point order can disagree.
    {
      weight: 3,
      arbitrary: fc
        .tuple(arbText, arbCodePoint, arbCodePoint, arbText)
        .map(([head, left, right, tail]): [string, string] => [
          head + chr(left) + tail,
          head + chr(right),
        ]),
    },
    // Canonically equivalent and different.
    {
      weight: 1,
      arbitrary: arbText.map((value): [string, string] => [
        value.normalize("NFC"),
        value.normalize("NFD"),
      ]),
    },
  );

  test(
    "compareCanonicalText matches Lean",
    async () => {
      const seen = new Map<number, number>();
      const examples: [[string, string]][] = [
        [["", ""]],
        [["", "a"]],
        [["a", ""]],
        [["A", "a"]],
        [["z", chr(0xe4)]],
        [[chr(0x10000), chr(0xffff)]],
        [[chr(0x10000), chr(0xe000)]],
        [[chr(0x10ffff), chr(0xd7ff)]],
        [["ab", "a"]],
        [[chr(0xe9), chr(0x65, 0x301)]],
      ];
      await fc.assert(
        fc.asyncProperty(arbTextPair, async ([left, right]) => {
          const tsOutcome = runTs(() => compareCanonicalText(left, right));
          const leanOutcome = await oracle.call<number>("compareCanonicalText", [
            textToWire(left),
            textToWire(right),
          ]);
          assertSame(
            "compareCanonicalText",
            `${showText(left)}, ${showText(right)}`,
            tsOutcome,
            leanOutcome,
          );
          count("compareCanonicalText");
          if (tsOutcome.kind === "ok")
            seen.set(tsOutcome.value, (seen.get(tsOutcome.value) ?? 0) + 1);
        }),
        { seed: SEED, numRuns: NUM_RUNS + examples.length, examples },
      );
      for (const answer of [-1, 0, 1]) expect(seen.get(answer) ?? 0).toBeGreaterThan(NUM_RUNS / 20);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "compareCanonicalText matches Lean for every pair from the edges of UTF-16",
    async () => {
      const edges = [
        0x00, 0x01, 0x41, 0x61, 0x7f, 0x80, 0xff, 0x100, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xfffd,
        0xffff, 0x10000, 0x10001, 0x103ff, 0x10400, 0x1f600, 0xfffff, 0x100000, 0x10fc00, 0x10ffff,
      ];
      const texts = [""];
      for (const first of edges) {
        texts.push(chr(first));
        for (const second of edges) texts.push(chr(first, second));
      }
      const total = await sweep(
        "compareCanonicalText: every pair from the edges",
        "compareCanonicalText",
        (function* () {
          for (const left of texts) for (const right of texts) yield [left, right];
        })(),
        compareCanonicalText,
      );
      expect(total).toBe(texts.length ** 2);
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------------------------
  // contentHashEquals
  // -------------------------------------------------------------------------------------------

  const realDigest = hashCanonical(null).digest;
  const arbAlgorithm = fc.oneof(
    { weight: 6, arbitrary: fc.constant<string>(CONTENT_HASH_ALGORITHM) },
    { weight: 2, arbitrary: fc.constantFrom("SHA256", "sha512", "", "sha256 ", "sha-256") },
    { weight: 1, arbitrary: arbText },
  );
  const arbVersion = fc.oneof(
    { weight: 6, arbitrary: fc.constant<string>(CANONICALIZATION_VERSION) },
    { weight: 2, arbitrary: fc.constantFrom("rastrata-canonical-v2", "", "RASTRATA-CANONICAL-V1") },
    { weight: 1, arbitrary: arbText },
  );
  const arbDigest = fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom(realDigest, hashCanonical(true).digest) },
    {
      weight: 2,
      arbitrary: fc.constantFrom(
        realDigest.toUpperCase(),
        realDigest.slice(1),
        `${realDigest}0`,
        "",
        chr(0xe9),
        chr(0x65, 0x301),
      ),
    },
    { weight: 2, arbitrary: arbValue.map((spec) => hashCanonical(toCanonical(spec)).digest) },
    { weight: 1, arbitrary: arbText },
  );
  const arbHash = fc.record({
    algorithm: arbAlgorithm,
    canonicalizationVersion: arbVersion,
    digest: arbDigest,
  });
  const arbHashPair = fc.oneof(
    { weight: 2, arbitrary: fc.tuple(arbHash, arbHash) },
    { weight: 2, arbitrary: arbHash.map((hash) => [hash, { ...hash }] as const) },
    // Equal but for one member.
    {
      weight: 3,
      arbitrary: fc
        .tuple(arbHash, arbHash, fc.constantFrom("algorithm", "canonicalizationVersion", "digest"))
        .map(([left, other, member]) => [left, { ...left, [member]: other[member] }] as const),
    },
  );

  test(
    "contentHashEquals matches Lean",
    async () => {
      let equal = 0;
      let unequal = 0;
      await fc.assert(
        fc.asyncProperty(arbHashPair, async ([left, right]) => {
          const tsOutcome = runTs(() =>
            contentHashEquals(left as ContentHash, right as ContentHash),
          );
          const leanOutcome = await oracle.call<boolean>("contentHashEquals", [
            hashToWire(left as ContentHash),
            hashToWire(right as ContentHash),
          ]);
          assertSame("contentHashEquals", JSON.stringify([left, right]), tsOutcome, leanOutcome);
          count("contentHashEquals");
          if (tsOutcome.kind === "ok" && tsOutcome.value) equal++;
          else unequal++;
        }),
        { seed: SEED, numRuns: NUM_RUNS },
      );
      expect(equal).toBeGreaterThan(NUM_RUNS / 5);
      expect(unequal).toBeGreaterThan(NUM_RUNS / 5);
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------------------------
  // Lone surrogates: what the TypeScript does, stated through the model
  // -------------------------------------------------------------------------------------------

  /** Text with at least one surrogate that is not half of a pair. */
  const arbIllFormed: fc.Arbitrary<string> = fc
    .tuple(
      fc.array(
        fc.tuple(arbPiece, fc.option(fc.integer({ min: 0xd800, max: 0xdfff }), { freq: 2 })),
        {
          minLength: 1,
          maxLength: 4,
        },
      ),
      fc.integer({ min: 0xd800, max: 0xdfff }),
      fc.nat(8),
    )
    .map(([parts, unit, at]) => {
      const pieces = parts.map(
        ([piece, lone]) => piece + (lone === null ? "" : String.fromCharCode(lone)),
      );
      pieces.splice(at % (pieces.length + 1), 0, String.fromCharCode(unit));
      return pieces.join("");
    })
    .filter((value) => !value.isWellFormed());

  test(
    "the oracle refuses every string with a lone surrogate, in every entry",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbIllFormed, arbText, async (bad, good) => {
          const wire = textToWire(bad);
          const value: WireValue = {
            t: "record",
            v: [[textToWire(good), { t: "array", v: [{ t: "string", v: wire }] }]],
          };
          const keyed: WireValue = { t: "record", v: [[wire, { t: "null" }]] };
          const hash = { algorithm: wire, canonicalizationVersion: "", digest: "" };
          const answers = [
            await oracle.call("identifier", [wire]),
            await oracle.call("toNFC", [wire]),
            await oracle.call("jsTrim", [wire]),
            await oracle.call("canonicalEncode", [value]),
            await oracle.call("canonicalEncode", [keyed]),
            await oracle.call("hashCanonical", [value]),
            await oracle.call("hashCanonicalSequenceField", [[], wire, "0", []]),
            await oracle.call("hashCanonicalSequenceField", [[], "", "1", [value]]),
            await oracle.call("compareCanonicalText", [textToWire(good), wire]),
            await oracle.call("contentHashEquals", [hash, hash]),
          ];
          for (const answer of answers) {
            expect(answer).toEqual({ kind: "error", code: "model_has_no_lone_surrogate" });
          }
          count("lone surrogates: refused by the oracle");
        }),
        { seed: SEED, numRuns: 500 },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "TypeScript: identifier refuses every string with a lone surrogate",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc
            .oneof(
              arbIllFormed,
              arbIllFormed.map((value) => tidy(value)),
            )
            .filter((value) => !value.isWellFormed()),
          async (value) => {
            expect(() => identifier(value)).toThrow(IdentityError);
            count("lone surrogates: identifier");
          },
        ),
        { seed: SEED, numRuns: NUM_RUNS },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "TypeScript: canonicalEncode and hashCanonical refuse every value with a lone surrogate",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbIllFormed, arbValue, fc.boolean(), async (bad, inner, asKey) => {
          const build = (carried: string): Spec =>
            asKey ? record([carried, inner]) : { t: "array", v: [text(carried), inner] };
          expect(() => canonicalEncode(toCanonical(build(bad)))).toThrow(TypeError);
          expect(() => hashCanonical(toCanonical(build(bad)))).toThrow(TypeError);
          count("lone surrogates: canonicalEncode and hashCanonical");
        }),
        { seed: SEED, numRuns: NUM_RUNS },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test("TypeScript: lone surrogates are refused in identifiers, records, and sequence fields", () => {
    expect(() => identifier<"Example">(String.fromCharCode(0xd800))).toThrow(IdentityError);
    expect(() => identifier<"Example">(String.fromCharCode(0xdfff))).toThrow(IdentityError);
    expect(identifier<"Example">(chr(0xfffd))).toBe(chr(0xfffd) as never);
    const twice = { [String.fromCharCode(0xd800)]: 1n, [String.fromCharCode(0xdc00)]: 2n };
    expect(() => canonicalEncode(twice)).toThrow(TypeError);
    const fields = { [chr(0xfffd)]: null };
    expect(() => hashCanonicalSequenceField(fields, String.fromCharCode(0xd800), 0n, [])).toThrow(
      TypeError,
    );
  });

  // -------------------------------------------------------------------------------------------
  // What the TypeScript refuses and the model cannot be given
  // -------------------------------------------------------------------------------------------

  test("TypeScript: every value canonicalEncode refuses is one the model's type does not have", () => {
    // `CanonicalValue` in Lean is null, a boolean, a string, an integer, bytes, a list or a list of
    // pairs, and its `canonicalEncode` is total. There is nothing to send for these, so there is
    // nothing to compare; they are listed so that the suite says what was left out and why.
    const sparse: unknown[] = [];
    sparse[1] = null;
    const extra: unknown[] = Object.assign([null], { extra: null });
    const withGetter = Object.defineProperty({}, "a", { get: () => null, enumerable: true });
    const hidden = Object.defineProperty({}, "a", { value: null, enumerable: false });
    const arrayWithGetter = Object.defineProperty([null], "0", {
      get: () => null,
      enumerable: true,
    });
    class Thing {
      a = null;
    }
    const refused: unknown[] = [
      undefined,
      0,
      -0,
      1.5,
      Number.NaN,
      Symbol("s"),
      () => null,
      sparse,
      extra,
      arrayWithGetter,
      withGetter,
      hidden,
      { [Symbol("s")]: null },
      new Thing(),
      new Date(0),
      new Map(),
      new Set(),
      new Uint16Array(1),
      new ArrayBuffer(1),
      Object.create({ inherited: null }),
      [undefined],
      { a: undefined },
      { a: 1 },
    ];
    for (const value of refused) {
      expect(() => canonicalEncode(value as CanonicalValue)).toThrow(TypeError);
      expect(() => hashCanonical(value as CanonicalValue)).toThrow(TypeError);
      expect(() => hashCanonicalSequenceField({}, "f", 1n, [value as CanonicalValue])).toThrow(
        TypeError,
      );
      expect(() => hashCanonicalSequenceField({ a: value as CanonicalValue }, "f", 0n, [])).toThrow(
        TypeError,
      );
    }
    // And what it takes that is not written as the plain kind: a subclass of Uint8Array is bytes.
    expect(bytesToWire(canonicalEncode(Buffer.from([1, 2])))).toBe("78323a0102");
  });

  // -------------------------------------------------------------------------------------------
  // Known differences. Each of these fails today, and is marked so: when the model or the
  // TypeScript changes and one of them starts to pass, the suite fails and says which.
  // -------------------------------------------------------------------------------------------

  describe("known differences between the model and the TypeScript", () => {
    const lone = String.fromCharCode(0xd800);

    // DIFFERENCE 1. A JavaScript string is any sequence of UTF-16 code units; the model's `String`
    // is a sequence of Unicode scalar values (Canonical.lean: `Identifier.value`, line 29;
    // `CanonicalValue.string` and `.record`, lines 49 and 53; `stringToUTF16`, line 1125). The
    // TypeScript accepts a lone surrogate everywhere and the model has no value to compare with,
    // so none of the model's laws (`identifier_ok_iff`, `canonicalEncode_inj`,
    // `hashCanonical_inj_or_collision`, `compareCanonicalText_eq_iff`) says anything about it.
    // The tests above pin what the TypeScript does: it encodes and hashes U+FFFD in its place.
    test("identifier: both TypeScript and the model refuse a lone surrogate", async () => {
      expect(runTs(() => tsIdentifier(lone)).kind).toBe("error");
      expect(await oracle.call<string>("identifier", [textToWire(lone)])).toEqual({
        kind: "error",
        code: "model_has_no_lone_surrogate",
      });
    });

    test("canonicalEncode: both TypeScript and the model refuse a lone surrogate", async () => {
      const spec = text(lone);
      expect(() => canonicalEncode(toCanonical(spec))).toThrow(TypeError);
      expect(await oracle.call<string>("canonicalEncode", [toWire(spec)])).toEqual({
        kind: "error",
        code: "model_has_no_lone_surrogate",
      });
    });

    test("hashCanonical: both TypeScript and the model refuse a lone surrogate", async () => {
      const spec = text(lone);
      expect(() => hashCanonical(toCanonical(spec))).toThrow(TypeError);
      expect(await oracle.call<WireHash>("hashCanonical", [toWire(spec)])).toEqual({
        kind: "error",
        code: "model_has_no_lone_surrogate",
      });
    });

    test("hashCanonicalSequenceField: both TypeScript and the model refuse a lone surrogate as the field", async () => {
      const input: SequenceCase = {
        fields: [],
        bare: false,
        field: lone,
        length: 0n,
        values: [],
        lazy: false,
      };
      expect(tsSequence(input).kind).toBe("error");
      expect(await leanSequence(input)).toEqual({
        kind: "error",
        code: "model_has_no_lone_surrogate",
      });
    });

    test.failing("compareCanonicalText: the TypeScript orders a lone surrogate by its code unit, the model has no such string", async () => {
      const tsOutcome = runTs(() => compareCanonicalText(lone, "")); // ok 1
      assertSame(
        "compareCanonicalText",
        `${showText(lone)}, []`,
        tsOutcome,
        await oracle.call<number>("compareCanonicalText", [textToWire(lone), ""]),
      );
    });

    test.failing("contentHashEquals: the TypeScript compares a lone surrogate, the model has no such string", async () => {
      const hash = { algorithm: lone, canonicalizationVersion: "", digest: "" };
      const tsOutcome = runTs(() =>
        contentHashEquals(hash as unknown as ContentHash, hash as unknown as ContentHash),
      ); // ok true
      const wire = hashToWire(hash as unknown as ContentHash);
      assertSame(
        "contentHashEquals",
        JSON.stringify(wire),
        tsOutcome,
        await oracle.call<boolean>("contentHashEquals", [wire, wire]),
      );
    });

    // DIFFERENCE 2. The model's record is a list of pairs (Canonical.lean: `CanonicalValue.record`,
    // line 53) and `canonicalEncode` (line 1170, through `encodeRecordAux`, line 1162) writes every
    // pair, so a key written twice is encoded twice. A JavaScript object cannot hold a key twice:
    // the later value replaces the earlier one before the TypeScript sees anything. The model's laws
    // ask for distinct keys (`CanonicalValue.WF`, line 1411), so they are not wrong; the model's
    // function has values the TypeScript can never be given, and bytes it can never produce.
    test.failing("canonicalEncode: a key written twice is one entry in JavaScript and two in the model", async () => {
      const spec = record(["", { t: "null" }], ["", { t: "null" }]);
      const tsOutcome = runTs(() => bytesToWire(canonicalEncode(toCanonical(spec)))); // "o1:s0:n"
      assertSame(
        "canonicalEncode",
        showSpec(spec),
        tsOutcome,
        await oracle.call<string>("canonicalEncode", [toWire(spec)]),
      ); // "o2:s0:ns0:n"
    });

    test.failing("hashCanonicalSequenceField: a key written twice in the fields is one entry in JavaScript and two in the model", async () => {
      const input: SequenceCase = {
        fields: [
          ["", { t: "null" }],
          ["", { t: "null" }],
        ],
        bare: false,
        field: "f",
        length: 0n,
        values: [],
        lazy: false,
      };
      assertSame(
        "hashCanonicalSequenceField",
        showSequence(input),
        tsSequence(input),
        await leanSequence(input),
      );
    });
  });

  test("every function was compared on at least 2,000 generated cases", () => {
    for (const name of [
      "identifier",
      "canonicalEncode",
      "hashCanonical",
      "hashCanonicalSequenceField",
      "compareCanonicalText",
      "contentHashEquals",
      "toNFC",
      "jsTrim",
    ]) {
      expect(counts.get(name) ?? 0).toBeGreaterThanOrEqual(NUM_RUNS);
    }
  });
});

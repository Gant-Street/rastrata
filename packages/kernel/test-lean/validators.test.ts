/**
 * The validators of the vocabulary, the Lean model run against the TypeScript on the same inputs:
 * `localDate`, `instant` and (through them) `isLeapYear` of `src/journal.ts`
 * (`proofs/Rastrata/Kernel/Journal/Types.lean`), and `semanticVersion` and `instantMillis` of
 * `src/policy.ts` (`Policy/Types.lean`).
 *
 * `isLeapYear` and `instantMillis` are not exported. `isLeapYear` is reached through `localDate`
 * (a leap year is a year whose 29th of February `localDate` takes). `instantMillis` is three
 * lines: `Date.parse(value)`, and a `RangeError` `Invalid supplied instant: ${value}` when the
 * result is not finite; the test makes the same three lines and runs them under Bun's own
 * `Date.parse`, which is the engine the kernel runs on.
 *
 * The wire is `proofs/Oracle/Wave2a.lean`'s: a string is the hexadecimal of its UTF-16 code
 * units, so an error is `invalid_local_date:<the text its message ends with>` and the whole
 * message is compared. The generators make well-formed strings only, since a Lean `String` cannot
 * hold a lone surrogate; that gap is pinned under "known differences".
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fc from "fast-check";

import { instant, localDate, semanticVersion } from "../src/index.ts";
import { OracleClient, type OracleOutcome } from "./oracle-client.ts";
import {
  NUM_RUNS,
  SEED,
  TEST_TIMEOUT_MS,
  type InstantParts,
  arbNoise,
  arbPoint,
  arbValidDateParts,
  arbValidInstantParts,
  arbYear,
  assertSame,
  chr,
  count,
  counted,
  formatDate,
  formatInstant,
  maxDay,
  pad,
  printCounts,
  runTs,
  showText,
  sweep,
  textToWire,
  type SweepCase,
} from "./wave2a-wire.ts";

// ---------------------------------------------------------------------------------------------
// Both sides
// ---------------------------------------------------------------------------------------------

const tsLocalDate = (value: string): OracleOutcome<string> =>
  runTs(() => textToWire(localDate(value)));
const tsInstant = (value: string): OracleOutcome<string> => runTs(() => textToWire(instant(value)));
const tsSemanticVersion = (value: string): OracleOutcome<string> =>
  runTs(() => textToWire(semanticVersion(value)));

/** `instantMillis` of `policy.ts`, line for line, under this runtime's `Date.parse`. */
const tsInstantMillis = (value: string): OracleOutcome<string> =>
  runTs(() => {
    const millis = Date.parse(value);
    if (!Number.isFinite(millis)) throw new RangeError(`Invalid supplied instant: ${value}`);
    return String(millis);
  });

/** A sweep case of the validators: one string in, one string out. */
const one = (value: string, ts: (value: string) => OracleOutcome<unknown>): SweepCase => ({
  args: [textToWire(value)],
  ts: () => ts(value),
  show: () => showText(value),
});

// ---------------------------------------------------------------------------------------------
// Text generators
// ---------------------------------------------------------------------------------------------

const ASCII_DIGIT_IMPOSTORS = [
  0x660, 0x661, 0x669, 0x6f0, 0x6f5, 0x966, 0x96f, 0x9e6, 0xff10, 0xff11, 0xff19, 0xb2, 0xb3, 0xb9,
  0x2460, 0x2080, 0x2081, 0x1d7ce, 0x1d7d8, 0x1d7ff, 0x1fbf0,
];
const arbImpostor = fc.constantFrom(...ASCII_DIGIT_IMPOSTORS);
const WRAPPERS = [
  " ",
  "\n",
  "\r",
  "\t",
  chr(0xa0),
  chr(0xfeff),
  chr(0x2028),
  chr(0x200b),
  "\u0000",
  "+",
  "-",
  "0",
  "T",
  "Z",
  "9",
  ".",
  chr(0x1f600),
];
const arbWrapper = fc.constantFrom(...WRAPPERS);

/** One edit of a text: a character dropped, added, replaced, doubled, swapped, or the whole text
 * wrapped. */
function mutate(base: string, at: number, point: number, kind: number, wrapper: string): string {
  const chars = Array.from(base);
  const index = chars.length === 0 ? 0 : at % chars.length;
  switch (kind % 8) {
    case 0:
      return chars.filter((_, position) => position !== index).join("");
    case 1:
      chars.splice(at % (chars.length + 1), 0, chr(point));
      return chars.join("");
    case 2:
      if (chars.length > 0) chars[index] = chr(point);
      return chars.join("");
    case 3:
      if (chars.length > 0) chars.splice(index, 0, chars[index] as string);
      return chars.join("");
    case 4:
      if (chars.length > 1) {
        const next = (index + 1) % chars.length;
        [chars[index], chars[next]] = [chars[next] as string, chars[index] as string];
      }
      return chars.join("");
    case 5:
      return wrapper + base;
    case 6:
      return base + wrapper;
    default:
      return wrapper + base + wrapper;
  }
}

const arbMutationOf = (base: fc.Arbitrary<string>): fc.Arbitrary<string> =>
  fc
    .tuple(base, fc.nat(1000), fc.oneof(arbPoint, arbImpostor), fc.nat(7), arbWrapper)
    .map(([text, at, point, kind, wrapper]) => mutate(text, at, point, kind, wrapper));

// ---------------------------------------------------------------------------------------------
// localDate
// ---------------------------------------------------------------------------------------------

const arbBadDayOf = arbValidDateParts.map((parts) =>
  formatDate({ ...parts, day: maxDay(parts.year, parts.month) + 1 }),
);

const arbDateText: fc.Arbitrary<string> = fc.oneof(
  { weight: 5, arbitrary: arbValidDateParts.map(formatDate) },
  {
    weight: 5,
    arbitrary: fc
      .tuple(arbYear, fc.integer({ min: 0, max: 14 }), fc.integer({ min: 0, max: 33 }))
      .map(([year, month, day]) => `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`),
  },
  { weight: 3, arbitrary: arbBadDayOf },
  { weight: 3, arbitrary: arbYear.map((year) => `${pad(year, 4)}-02-29`) },
  {
    weight: 1,
    arbitrary: fc
      .tuple(fc.integer({ min: 0, max: 99 }), fc.integer({ min: 0, max: 99 }))
      .map(([month, day]) => `2024-${pad(month, 2)}-${pad(day, 2)}`),
  },
  { weight: 6, arbitrary: arbMutationOf(arbValidDateParts.map(formatDate)) },
  { weight: 2, arbitrary: arbMutationOf(arbBadDayOf) },
  { weight: 2, arbitrary: arbNoise },
  {
    weight: 1,
    arbitrary: fc
      .array(fc.constantFrom("0", "1", "2", "9", "-", "-", "T"), { maxLength: 12 })
      .map((chars) => chars.join("")),
  },
);

const dateExamples: [string][] = [
  ["2024-02-29"],
  ["2023-02-29"],
  ["1900-02-29"],
  ["2000-02-29"],
  ["2100-02-29"],
  ["2400-02-29"],
  ["0000-02-29"],
  ["0000-00-00"],
  ["0000-01-01"],
  ["9999-12-31"],
  ["9999-12-32"],
  ["2024-13-01"],
  ["2024-00-10"],
  ["2024-01-00"],
  ["2024-01-32"],
  ["2024-04-31"],
  ["2024-02-30"],
  ["2024-1-1"],
  ["2024-01-01\n"],
  ["\n2024-01-01"],
  [" 2024-01-01"],
  ["2024-01-01 "],
  ["+2024-01-01"],
  ["12024-01-01"],
  ["024-01-01"],
  ["2024/01/01"],
  ["2024-01-01T00:00:00Z"],
  [`${chr(0xff12, 0xff10, 0xff12, 0xff14)}-01-01`],
  [`2024-01-${chr(0x661)}${chr(0x662)}`],
  [`2024-01-01${chr(0x1f600)}`],
  [""],
  ["\n"],
];

// ---------------------------------------------------------------------------------------------
// instant
// ---------------------------------------------------------------------------------------------

/** The pieces of an instant text, so that one of them can be spoiled. */
interface Pieces {
  readonly date: string;
  readonly separator: string;
  readonly hour: string;
  readonly minute: string;
  readonly second: string;
  /** With its decimal point, or empty. */
  readonly fraction: string;
  readonly offset: string;
}

const piecesOf = (parts: InstantParts): Pieces => ({
  date: formatDate(parts),
  separator: "T",
  hour: pad(parts.hour, 2),
  minute: pad(parts.minute, 2),
  second: pad(parts.second, 2),
  fraction: parts.fraction === "" ? "" : `.${parts.fraction}`,
  offset: parts.offset,
});

const assemble = (p: Pieces): string =>
  `${p.date}${p.separator}${p.hour}:${p.minute}:${p.second}${p.fraction}${p.offset}`;

/** One spoiled piece. The number picks among the values the piece can be spoiled with. */
const defects: readonly ((p: Pieces, n: number) => Pieces)[] = [
  (p, n) => ({ ...p, hour: pad(24 + (n % 76), 2) }),
  (p, n) => ({ ...p, minute: pad(60 + (n % 40), 2) }),
  (p, n) => ({ ...p, second: pad(60 + (n % 40), 2) }),
  (p, n) => ({ ...p, offset: `${n % 2 ? "+" : "-"}${pad(15 + (n % 85), 2)}:${pad(n % 60, 2)}` }),
  (p, n) => ({ ...p, offset: `${n % 2 ? "+" : "-"}14:${pad(1 + (n % 59), 2)}` }),
  (p, n) => ({
    ...p,
    offset: `${n % 2 ? "+" : "-"}${pad(n % 15, 2)}:${pad(60 + (n % 40), 2)}`,
  }),
  (p, n) => ({ ...p, date: `${p.date.slice(0, 5)}${pad(13 + (n % 87), 2)}${p.date.slice(7)}` }),
  (p) => ({ ...p, date: `${p.date.slice(0, 5)}00${p.date.slice(7)}` }),
  (p) => ({ ...p, date: `${p.date.slice(0, 8)}00` }),
  (p, n) => ({ ...p, date: `${p.date.slice(0, 8)}${pad(32 + (n % 68), 2)}` }),
  (p) => ({ ...p, date: `${pad(Number(p.date.slice(0, 4)), 4)}-02-29`, hour: "09" }),
  (p) => ({ ...p, date: `${pad(Number(p.date.slice(0, 4)), 4)}-04-31` }),
  // A bad date together with a bad time and a bad offset: the date is what is reported.
  (p, n) => ({
    ...p,
    date: `${p.date.slice(0, 5)}13-40`,
    hour: pad(24 + (n % 70), 2),
    offset: "+15:00",
  }),
  (p) => ({ ...p, date: "2023-02-29", minute: "99" }),
  (p) => ({ ...p, separator: " " }),
  (p) => ({ ...p, separator: "t" }),
  (p) => ({ ...p, separator: "" }),
  (p) => ({ ...p, separator: "TT" }),
  (p) => ({ ...p, offset: "" }),
  (p) => ({ ...p, offset: "z" }),
  (p) => ({ ...p, offset: "+0530" }),
  (p) => ({ ...p, offset: "+5:30" }),
  (p) => ({ ...p, offset: "+05" }),
  (p) => ({ ...p, offset: "+05:3" }),
  (p) => ({ ...p, offset: "+05:30:00" }),
  (p) => ({ ...p, offset: "+05:30Z" }),
  (p) => ({ ...p, offset: "Z " }),
  (p) => ({ ...p, offset: " Z" }),
  (p) => ({ ...p, offset: "ZZ" }),
  (p) => ({ ...p, offset: "UTC" }),
  (p) => ({ ...p, offset: `${chr(0x2212)}05:30` }),
  (p) => ({ ...p, offset: "Z\n" }),
  (p) => ({ ...p, fraction: "." }),
  (p) => ({ ...p, fraction: ",5" }),
  (p) => ({ ...p, fraction: ".5a" }),
  (p) => ({ ...p, fraction: ".5.5" }),
  (p) => ({ ...p, fraction: `.${chr(0x661)}` }),
  (p) => ({ ...p, fraction: `.12${chr(0x1d7d8)}` }),
  (p) => ({ ...p, hour: "1" }),
  (p) => ({ ...p, minute: "5" }),
  (p) => ({ ...p, second: "7" }),
  (p) => ({ ...p, hour: "001" }),
  (p) => ({ ...p, hour: chr(0x660, 0x661) }),
  (p) => ({ ...p, minute: chr(0xff10, 0xff15) }),
  (p) => ({ ...p, date: p.date.replace(/\d$/, chr(0x663)) }),
  (p) => ({ ...p, date: `${p.date}-01` }),
  (p) => ({ ...p, date: p.date.slice(0, 7) }),
];

const arbDefective: fc.Arbitrary<string> = fc
  .tuple(arbValidInstantParts, fc.integer({ min: 0, max: defects.length - 1 }), fc.nat(10_000))
  .map(([parts, which, n]) =>
    assemble((defects[which] as (p: Pieces, n: number) => Pieces)(piecesOf(parts), n)),
  );

const arbInstantText: fc.Arbitrary<string> = fc.oneof(
  { weight: 5, arbitrary: arbValidInstantParts.map(formatInstant) },
  { weight: 8, arbitrary: arbDefective },
  { weight: 4, arbitrary: arbMutationOf(arbValidInstantParts.map(formatInstant)) },
  { weight: 1, arbitrary: arbNoise },
  { weight: 1, arbitrary: arbValidDateParts.map(formatDate) },
);

const instantExamples: [string][] = [
  ["2024-01-01T00:00:00Z"],
  ["2024-01-01T00:00:00.5Z"],
  ["2024-01-01T23:59:59.999999999999Z"],
  ["2024-01-01T24:00:00Z"],
  ["2024-01-01T23:60:00Z"],
  ["2024-06-30T23:59:60Z"],
  ["2024-01-01T00:00:00+14:00"],
  ["2024-01-01T00:00:00-14:00"],
  ["2024-01-01T00:00:00+14:01"],
  ["2024-01-01T00:00:00+15:00"],
  ["2024-01-01T00:00:00+00:60"],
  ["2024-01-01T00:00:00+13:59"],
  ["2023-02-29T00:00:00Z"],
  ["2023-02-29T24:00:00+15:00"],
  ["2024-13-01T00:00:00Z"],
  ["2024-01-01T00:00:00"],
  ["2024-01-01t00:00:00Z"],
  ["2024-01-01 00:00:00Z"],
  ["2024-01-01T00:00:00z"],
  ["2024-01-01T00:00:00.Z"],
  ["2024-01-01T00:00:00,5Z"],
  ["2024-01-01T00:00Z"],
  ["2024-01-01T00:00:00Z\n"],
  [" 2024-01-01T00:00:00Z"],
  ["0000-01-01T00:00:00Z"],
  ["9999-12-31T23:59:59.999-14:00"],
  ["2024-01-01"],
  [""],
];

// ---------------------------------------------------------------------------------------------
// semanticVersion
// ---------------------------------------------------------------------------------------------

const arbNumberPart = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom("0", "1", "2", "9", "10", "99", "100", "1234567890") },
  { weight: 2, arbitrary: fc.nat(100_000).map(String) },
  { weight: 1, arbitrary: fc.constant("123456789012345678901234567890") },
);
const BAD_NUMBERS = [
  "00",
  "01",
  "007",
  "-1",
  "+1",
  "1_0",
  "",
  " 1",
  "1 ",
  "0x1",
  "1e3",
  chr(0x661),
  chr(0xff11),
  chr(0x662),
];
const arbBadNumberPart = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...BAD_NUMBERS) },
  { weight: 1, arbitrary: fc.nat(1000).map((n) => `0${n}`) },
);
const PRERELEASE_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.-";
const arbPrerelease = fc
  .array(fc.integer({ min: 0, max: PRERELEASE_CHARS.length - 1 }), { minLength: 1, maxLength: 12 })
  .map((indexes) => indexes.map((index) => PRERELEASE_CHARS[index]).join(""));
const arbBadSuffix = fc.constantFrom(
  "-",
  "+build",
  "-rc+build",
  "-rc_1",
  "-rc 1",
  `-r${chr(0xe9)}`,
  `-${chr(0x661)}`,
  " ",
  "\n",
  "-rc\n",
  ".0",
  "-rc.1\n",
  "--",
  "-+",
);

const arbVersionText: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc
      .tuple(
        arbNumberPart,
        arbNumberPart,
        arbNumberPart,
        fc.option(arbPrerelease, { nil: undefined }),
      )
      .map(([a, b, c, pre]) => `${a}.${b}.${c}${pre === undefined ? "" : `-${pre}`}`),
  },
  {
    weight: 4,
    arbitrary: fc
      .tuple(
        fc.oneof(arbBadNumberPart, arbNumberPart),
        fc.oneof(arbBadNumberPart, arbNumberPart),
        fc.oneof(arbBadNumberPart, arbNumberPart),
        fc.option(fc.oneof(arbPrerelease, arbBadSuffix), { nil: undefined }),
      )
      .map(
        ([a, b, c, pre]) =>
          `${a}.${b}.${c}${pre === undefined ? "" : pre.startsWith("-") || pre.startsWith("+") || pre.startsWith(" ") || pre.startsWith("\n") || pre.startsWith(".") ? pre : `-${pre}`}`,
      ),
  },
  {
    weight: 3,
    arbitrary: arbMutationOf(
      fc
        .tuple(
          arbNumberPart,
          arbNumberPart,
          arbNumberPart,
          fc.option(arbPrerelease, { nil: undefined }),
        )
        .map(([a, b, c, pre]) => `${a}.${b}.${c}${pre === undefined ? "" : `-${pre}`}`),
    ),
  },
  {
    weight: 2,
    arbitrary: fc
      .array(fc.constantFrom("0", "1", "9", ".", ".", "-", "a", "+", "v"), { maxLength: 10 })
      .map((chars) => chars.join("")),
  },
  { weight: 1, arbitrary: arbNoise },
);

const versionExamples: [string][] = [
  ["1.0.0"],
  ["0.0.0"],
  ["1.0.0-rc.1"],
  ["1.0.0-01"],
  ["1.0.0-.."],
  ["1.0.0--"],
  ["1.0.0-"],
  ["1.0.0+build"],
  ["1.0.0-rc+build"],
  ["01.0.0"],
  ["1.00.0"],
  ["1.0.00"],
  ["1.0"],
  ["1.0.0.0"],
  ["v1.0.0"],
  ["1.0.0\n"],
  [" 1.0.0"],
  ["1.0.0 "],
  ["10.20.30"],
  ["123456789012345678901234567890.0.0"],
  [`${chr(0x661)}.0.0`],
  [""],
];

// ---------------------------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------------------------

describe("Validators Lean oracle equivalence", () => {
  let oracle: OracleClient;

  beforeAll(() => {
    oracle = OracleClient.start(process.env.ORACLE_BINARY);
  });

  afterAll(async () => {
    await oracle.close();
    printCounts();
  });

  // -------------------------------------------------------------------------------------------
  // localDate and isLeapYear
  // -------------------------------------------------------------------------------------------

  test(
    "localDate matches Lean",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbDateText, async (value) => {
          const tsOutcome = tsLocalDate(value);
          const leanOutcome = await oracle.call<string>("journal.localDate", [textToWire(value)]);
          assertSame("journal.localDate", showText(value), tsOutcome, leanOutcome);
          count("localDate");
          count(tsOutcome.kind === "ok" ? "localDate: accepted" : "localDate: refused");
        }),
        { seed: SEED, numRuns: NUM_RUNS + dateExamples.length, examples: dateExamples },
      );
      expect(counted("localDate: accepted")).toBeGreaterThanOrEqual(100);
      expect(counted("localDate: refused")).toBeGreaterThanOrEqual(100);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "localDate matches Lean for the 29th of February of every year, and every month and day of edge years",
    async () => {
      const years: string[] = [];
      for (let year = 0; year <= 9999; year++) years.push(pad(year, 4));
      // The last day of February and the day after, in every year.
      const february = await sweep(
        oracle,
        "journal.localDate",
        "localDate: the end of February in every year",
        (function* () {
          for (const year of years) {
            for (const day of ["28", "29", "30"]) yield one(`${year}-02-${day}`, tsLocalDate);
          }
        })(),
        (outcome) => {
          count(outcome.kind === "ok" ? "localDate: accepted" : "localDate: refused");
        },
      );
      expect(february).toBe(30_000);
      // Every month and day field, two digits each, in a leap year and in a common year.
      const fields = await sweep(
        oracle,
        "journal.localDate",
        "localDate: every month and day field",
        (function* () {
          for (const year of ["2024", "2023", "1900", "2000"]) {
            for (let month = 0; month <= 99; month++) {
              for (let day = 0; day <= 99; day++) {
                yield one(`${year}-${pad(month, 2)}-${pad(day, 2)}`, tsLocalDate);
              }
            }
          }
        })(),
      );
      expect(fields).toBe(40_000);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "isLeapYear matches Lean for every year of four digits",
    async () => {
      // The TypeScript's `isLeapYear` is private: a year is a leap year when `localDate` takes
      // its 29th of February.
      let leap = 0;
      const total = await sweep(
        oracle,
        "journal.isLeapYear",
        "isLeapYear: every year of four digits",
        (function* (): Generator<SweepCase> {
          for (let year = 0; year <= 9999; year++) {
            yield {
              args: [String(year)],
              ts: () => {
                const accepted = tsLocalDate(`${pad(year, 4)}-02-29`).kind === "ok";
                if (accepted) leap++;
                return { kind: "ok", value: accepted };
              },
              show: () => `year ${year}`,
            };
          }
        })(),
      );
      expect(total).toBe(10_000);
      // 2,425 leap years from 0000 to 9999: one in four, less 97 in every 400.
      expect(leap).toBe(2425);
      // The model's function on its own, against the rule it states.
      for (const year of [0, 1, 4, 100, 400, 1900, 2000, 2024, 2100, 2400, 9999]) {
        const answer = await oracle.call<boolean>("journal.isLeapYear", [String(year)]);
        expect(answer).toEqual({
          kind: "ok",
          value: year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0),
        });
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------------------------
  // instant
  // -------------------------------------------------------------------------------------------

  test(
    "instant matches Lean",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbInstantText, async (value) => {
          const tsOutcome = tsInstant(value);
          const leanOutcome = await oracle.call<string>("journal.instant", [textToWire(value)]);
          assertSame("journal.instant", showText(value), tsOutcome, leanOutcome);
          count("instant");
          if (tsOutcome.kind === "ok") count("instant: accepted");
          else if (tsOutcome.code.startsWith("invalid_local_date:"))
            count("instant: refused for its date");
          else count("instant: refused");
        }),
        { seed: SEED, numRuns: NUM_RUNS * 2 + instantExamples.length, examples: instantExamples },
      );
      expect(counted("instant: accepted")).toBeGreaterThanOrEqual(100);
      expect(counted("instant: refused")).toBeGreaterThanOrEqual(100);
      expect(counted("instant: refused for its date")).toBeGreaterThanOrEqual(100);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "instant matches Lean for every hour, minute, second and offset field",
    async () => {
      const base = "2024-06-15";
      // Every pair of two-digit fields at a time, in every one of the three places that has two.
      const times = await sweep(
        oracle,
        "journal.instant",
        "instant: every hour and minute, and the seconds",
        (function* () {
          for (let hour = 0; hour <= 99; hour++) {
            for (let minute = 0; minute <= 99; minute++) {
              for (const second of [0, 59, 60, 99]) {
                yield one(
                  `${base}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}Z`,
                  tsInstant,
                );
              }
            }
          }
        })(),
      );
      expect(times).toBe(40_000);
      const seconds = await sweep(
        oracle,
        "journal.instant",
        "instant: every second field",
        (function* () {
          for (let second = 0; second <= 99; second++) {
            yield one(`${base}T00:00:${pad(second, 2)}Z`, tsInstant);
            yield one(`${base}T23:59:${pad(second, 2)}.5+00:00`, tsInstant);
          }
        })(),
      );
      expect(seconds).toBe(200);
      // Every offset, two digits each side of the colon, with each sign, and a bad date too.
      const offsets = await sweep(
        oracle,
        "journal.instant",
        "instant: every offset",
        (function* () {
          for (const sign of ["+", "-"]) {
            for (let hours = 0; hours <= 99; hours++) {
              for (let minutes = 0; minutes <= 99; minutes++) {
                const zone = `${sign}${pad(hours, 2)}:${pad(minutes, 2)}`;
                yield one(`${base}T10:20:30${zone}`, tsInstant);
              }
            }
          }
          yield one("2023-02-29T10:20:30+99:99", tsInstant);
        })(),
      );
      expect(offsets).toBe(20_001);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "instant matches Lean for every date, in every year, with a time and an offset",
    async () => {
      const total = await sweep(
        oracle,
        "journal.instant",
        "instant: every year, the edges of its months",
        (function* () {
          for (let year = 0; year <= 9999; year += 1) {
            const y = pad(year, 4);
            for (const month of [1, 2, 4, 12]) {
              for (const day of [1, 28, 29, 30, 31, 32]) {
                yield one(`${y}-${pad(month, 2)}-${pad(day, 2)}T23:59:59.999Z`, tsInstant);
              }
            }
          }
        })(),
      );
      expect(total).toBe(10_000 * 24);
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------------------------
  // semanticVersion
  // -------------------------------------------------------------------------------------------

  test(
    "semanticVersion matches Lean",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbVersionText, async (value) => {
          const tsOutcome = tsSemanticVersion(value);
          const leanOutcome = await oracle.call<string>("policy.semanticVersion", [
            textToWire(value),
          ]);
          assertSame("policy.semanticVersion", showText(value), tsOutcome, leanOutcome);
          count("semanticVersion");
          count(tsOutcome.kind === "ok" ? "semanticVersion: accepted" : "semanticVersion: refused");
        }),
        { seed: SEED, numRuns: NUM_RUNS * 2 + versionExamples.length, examples: versionExamples },
      );
      expect(counted("semanticVersion: accepted")).toBeGreaterThanOrEqual(100);
      expect(counted("semanticVersion: refused")).toBeGreaterThanOrEqual(100);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "semanticVersion matches Lean for every string of up to seven characters from a small alphabet",
    async () => {
      const alphabet = ["0", "1", ".", "-", "a", "+"];
      const texts: string[] = [""];
      let layer: string[] = [""];
      for (let length = 1; length <= 7; length++) {
        const next: string[] = [];
        for (const prefix of layer) for (const letter of alphabet) next.push(prefix + letter);
        texts.push(...next);
        layer = next;
      }
      const total = await sweep(
        oracle,
        "policy.semanticVersion",
        "semanticVersion: every string over a small alphabet",
        (function* () {
          for (const text of texts) yield one(text, tsSemanticVersion);
        })(),
        (outcome) => {
          count(outcome.kind === "ok" ? "semanticVersion: accepted" : "semanticVersion: refused");
        },
      );
      expect(total).toBe(texts.length);
      // A version with a prerelease of every shape the alphabet makes.
      const prereleases = await sweep(
        oracle,
        "policy.semanticVersion",
        "semanticVersion: every prerelease over the whole set",
        (function* () {
          const set = "09azAZ.-_+ ".split("");
          for (const first of set) {
            for (const second of set) {
              for (const third of set)
                yield one(`1.2.3-${first}${second}${third}`, tsSemanticVersion);
            }
          }
          for (const number of ["0", "00", "1", "01", "10", "9", "09", "", "a", "-1"]) {
            for (const other of ["0", "00", "1", "01", "10", "", "a"]) {
              yield one(`${number}.${other}.${number}`, tsSemanticVersion);
              yield one(`${other}.${number}.${other}-x`, tsSemanticVersion);
            }
          }
        })(),
      );
      expect(prereleases).toBeGreaterThan(1300);
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------------------------
  // instantMillis: the model's reading of Date.parse against Date.parse
  // -------------------------------------------------------------------------------------------

  const arbMillisInstant: fc.Arbitrary<string> = arbValidInstantParts.map(formatInstant);

  test(
    "instantMillis matches Date.parse on generated instants",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbMillisInstant, async (value) => {
          expect(tsInstant(value).kind).toBe("ok");
          const tsOutcome = tsInstantMillis(value);
          const leanOutcome = await oracle.call<string>("policy.instantMillis", [
            textToWire(value),
          ]);
          assertSame("policy.instantMillis", value, tsOutcome, leanOutcome);
          count("instantMillis");
          count(`instantMillis: fraction of ${value.match(/\.(\d+)/)?.[1]?.length ?? 0} digits`);
        }),
        { seed: SEED, numRuns: NUM_RUNS * 3 },
      );
      for (const length of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
        expect(counted(`instantMillis: fraction of ${length} digits`)).toBeGreaterThanOrEqual(100);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "instantMillis matches Date.parse for every length and shape of the fraction of a second",
    async () => {
      const bases = [
        "2020-01-01T00:00:00",
        "1969-12-31T23:59:59",
        "1970-01-01T00:00:00",
        "0000-01-01T00:00:00",
        "9999-12-31T23:59:59",
        "2024-02-29T12:34:56",
        "1900-03-01T05:06:07",
      ];
      const zones = ["Z", "+05:30", "-14:00", "+14:00"];
      const shapes = (length: number): string[] => {
        const out = new Set<string>();
        out.add("0".repeat(length));
        out.add("9".repeat(length));
        out.add("1".padStart(length, "0"));
        out.add("1".padEnd(length, "0"));
        out.add("5".padEnd(length, "0"));
        out.add("4".padEnd(length, "9"));
        out.add("0123456789".repeat(5).slice(0, length));
        out.add("9876543210".repeat(5).slice(0, length));
        out.add("1234567890".repeat(5).slice(0, length));
        out.add("0".repeat(Math.max(0, length - 3)) + "123".slice(0, length));
        out.add(`${"0".repeat(Math.max(0, length - 1)).padEnd(length - 1, "0")}9`);
        out.add("00123456789".repeat(4).slice(0, length));
        for (let seed = 0; seed < 8; seed++) {
          let digits = "";
          let state = seed * 7919 + length;
          for (let index = 0; index < length; index++) {
            state = (state * 48271 + 11) % 2147483647;
            digits += String(state % (seed % 2 === 0 ? 10 : 3));
          }
          out.add(digits);
        }
        // A zero in every place, nines elsewhere.
        for (let place = 0; place < Math.min(length, 12); place++) {
          out.add(`${"9".repeat(place)}0${"9".repeat(length - place - 1)}`);
          out.add(`${"0".repeat(place)}7${"0".repeat(length - place - 1)}`);
        }
        return [...out].filter((digits) => digits.length === length);
      };
      const lengths = [
        ...Array.from({ length: 24 }, (_, index) => index + 1),
        25,
        30,
        31,
        32,
        33,
        40,
        63,
        64,
        100,
        300,
        1000,
      ];
      const total = await sweep(
        oracle,
        "policy.instantMillis",
        "instantMillis: every fraction",
        (function* () {
          for (const length of lengths) {
            for (const digits of shapes(length)) {
              for (const base of bases) {
                const zone = zones[(digits.length + base.length) % zones.length] as string;
                yield one(`${base}.${digits}${zone}`, tsInstantMillis);
              }
            }
          }
        })(),
      );
      expect(total).toBeGreaterThan(5000);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "instantMillis matches Date.parse for every offset and every year",
    async () => {
      const bases = [
        "2020-01-01T00:00:00",
        "1969-12-31T23:59:59.5",
        "0000-01-01T00:00:00",
        "9999-12-31T23:59:59.999",
        "2024-02-29T12:34:56.789",
      ];
      const offsets = await sweep(
        oracle,
        "policy.instantMillis",
        "instantMillis: every offset",
        (function* () {
          for (const base of bases) {
            yield one(`${base}Z`, tsInstantMillis);
            for (const sign of ["+", "-"]) {
              for (let hours = 0; hours <= 14; hours++) {
                for (const minutes of hours === 14 ? [0] : [0, 1, 15, 29, 30, 31, 45, 59]) {
                  yield one(`${base}${sign}${pad(hours, 2)}:${pad(minutes, 2)}`, tsInstantMillis);
                }
              }
            }
          }
        })(),
      );
      expect(offsets).toBeGreaterThan(500);
      const years = await sweep(
        oracle,
        "policy.instantMillis",
        "instantMillis: every year",
        (function* () {
          for (let year = 0; year <= 9999; year++) {
            const y = pad(year, 4);
            yield one(`${y}-01-01T00:00:00Z`, tsInstantMillis);
            yield one(`${y}-12-31T23:59:59.999+14:00`, tsInstantMillis);
            yield one(`${y}-12-31T23:59:59.999-14:00`, tsInstantMillis);
            yield one(`${y}-02-28T12:00:00.5-05:00`, tsInstantMillis);
            if (maxDay(year, 2) === 29) yield one(`${y}-02-29T00:00:00+14:00`, tsInstantMillis);
            yield one(`${y}-03-01T00:00:00.001-14:00`, tsInstantMillis);
          }
        })(),
      );
      expect(years).toBeGreaterThan(50_000);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "instantMillis matches Date.parse for every day of edge years and every time of a day",
    async () => {
      const days = await sweep(
        oracle,
        "policy.instantMillis",
        "instantMillis: every day of edge years",
        (function* () {
          for (const year of [
            0, 4, 100, 400, 1582, 1600, 1900, 1969, 1970, 1999, 2000, 2023, 2024, 2100, 9996, 9999,
          ]) {
            for (let month = 1; month <= 12; month++) {
              for (let day = 1; day <= maxDay(year, month); day++) {
                const date = `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
                yield one(`${date}T00:00:00Z`, tsInstantMillis);
                yield one(`${date}T23:59:59.9999Z`, tsInstantMillis);
              }
            }
          }
        })(),
      );
      expect(days).toBeGreaterThan(11_000);
      const times = await sweep(
        oracle,
        "policy.instantMillis",
        "instantMillis: every time of a day",
        (function* () {
          for (let hour = 0; hour <= 23; hour++) {
            for (let minute = 0; minute <= 59; minute++) {
              for (const second of [0, 1, 58, 59]) {
                yield one(
                  `2024-03-10T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.25-07:00`,
                  tsInstantMillis,
                );
              }
            }
          }
        })(),
      );
      expect(times).toBe(24 * 60 * 4);
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------------------------
  // What the model's notes say the TypeScript does, said of the TypeScript alone
  // -------------------------------------------------------------------------------------------

  test("the TypeScript does what the model's notes on the validators say", () => {
    // Journal/Types.lean: `localDate_accepts_year_zero`, `instant_accepts_minus_fourteen`,
    // `instant_rejects_leap_second`, `instant_unreal_date_error`.
    expect(String(localDate("0000-02-29"))).toBe("0000-02-29");
    expect(String(instant("2024-01-01T00:00:00-14:00"))).toBe("2024-01-01T00:00:00-14:00");
    expect(() => instant("2016-12-31T23:59:60Z")).toThrow(
      new RangeError("Invalid supplied instant: 2016-12-31T23:59:60Z"),
    );
    expect(() => instant("2023-02-29T00:00:00Z")).toThrow(
      new RangeError("Invalid local date: 2023-02-29"),
    );
    // Policy/Types.lean: what `semanticVersion` takes that Semantic Versioning does not, and the
    // reverse.
    expect(String(semanticVersion("1.0.0-01"))).toBe("1.0.0-01");
    expect(String(semanticVersion("1.0.0-.."))).toBe("1.0.0-..");
    expect(() => semanticVersion("1.0.0+build")).toThrow(RangeError);
    expect(() => semanticVersion("01.0.0")).toThrow(RangeError);
    // `instant_string_order_is_not_time_order` and `instant_same_moment_two_texts`: an instant is
    // not ordered by its text.
    expect("2024-01-01T00:00:00.5Z" < "2024-01-01T00:00:00Z").toBe(true);
    expect(Date.parse("2024-01-01T00:00:00.5Z")).toBe(1704067200500);
    expect(Date.parse("2024-01-01T00:00:00Z")).toBe(1704067200000);
    expect(Date.parse("2024-01-01T02:00:00+02:00")).toBe(1704067200000);
    expect("2024-01-01T00:00:00Z" < "2024-01-01T02:00:00+02:00").toBe(true);
    // `dateParseFractionMillis_misread` and `instantMillis_misread_order`: this runtime reads
    // `.0123456789` of a second as 123 milliseconds, which is the model's reading, and not as the
    // 12 milliseconds it is.
    expect(Date.parse("2020-01-01T00:00:00.0123456789Z")).toBe(1577836800123);
    expect(Date.parse("2020-01-01T00:00:00.1Z")).toBe(1577836800100);
    expect(Date.parse("2020-01-01T00:00:00.0009Z")).toBe(1577836800000);
    count("pinned: validators");
  });

  // -------------------------------------------------------------------------------------------
  // Known differences. Each of these fails today, and is marked so: when the model or the
  // TypeScript changes and one of them starts to pass, the suite fails and says which.
  // -------------------------------------------------------------------------------------------

  describe("known differences between the model and the TypeScript", () => {
    const lone = String.fromCharCode(0xd800);

    // INPUT CLASS THE MODEL CANNOT REPRESENT (kind c). A JavaScript string is any sequence of
    // UTF-16 code units; the model's `String` is a sequence of Unicode scalar values (`LocalDate`,
    // `Instant`, `SemanticVersion`: `value : String`, `Journal/Types.lean` lines 94, 99,
    // `Policy/Types.lean` line 70). Every position of the three regular expressions demands an
    // ASCII character, so the TypeScript refuses a string with a lone surrogate, and says so with a
    // message that holds the string; the model has no such input.
    test.failing("localDate: the TypeScript refuses a lone surrogate, the model has no such string", async () => {
      const value = `2024-01-01${lone}`;
      const tsOutcome = tsLocalDate(value); // error, message ends with U+D800
      assertSame(
        "journal.localDate",
        showText(value),
        tsOutcome,
        await oracle.call<string>("journal.localDate", [textToWire(value)]),
      );
    });

    test.failing("instant: the TypeScript refuses a lone surrogate, the model has no such string", async () => {
      const value = `2024-01-01T00:00:00Z${lone}`;
      assertSame(
        "journal.instant",
        showText(value),
        tsInstant(value),
        await oracle.call<string>("journal.instant", [textToWire(value)]),
      );
    });

    test.failing("semanticVersion: the TypeScript refuses a lone surrogate, the model has no such string", async () => {
      const value = `1.0.0-${lone}`;
      assertSame(
        "policy.semanticVersion",
        showText(value),
        tsSemanticVersion(value),
        await oracle.call<string>("policy.semanticVersion", [textToWire(value)]),
      );
    });

    // INPUT CLASS THE MODEL CANNOT REPRESENT (kind c). `Date.parse` reads many texts that
    // `instant` refuses, and `instantMillis` is given an `Instant`, which only `instant` builds.
    // The model's `dateParse` (`Policy/Types.lean` line 532) is defined on the texts `instant`
    // accepts and says `none`, and so an error, for every other: the TypeScript's answer for a
    // date without a time, a time of 24:00:00, or a time without an offset (which it reads in the
    // local time zone) is a number the model does not have. The kernel's types keep these out.
    for (const [name, value] of [
      ["a date without a time", "2024-01-01"],
      ["the hour 24", "2024-01-01T24:00:00Z"],
      ["a time without seconds", "2024-01-01T00:00Z"],
      ["a time with a space for the T", "2024-01-01 00:00:00Z"],
      ["a time with a lower case t", "2024-01-01t00:00:00Z"],
      ["a month of the year in words", "Jan 1, 2024 00:00:00 GMT"],
    ] as const) {
      test.failing(`instantMillis: Date.parse reads ${name}, which is not an Instant`, async () => {
        const tsOutcome = tsInstantMillis(value);
        expect(tsOutcome.kind).toBe("ok"); // a number: the failure below is the model's error
        assertSame(
          "policy.instantMillis",
          value,
          tsOutcome,
          await oracle.call<string>("policy.instantMillis", [textToWire(value)]),
        );
      });
    }
  });

  test("every function was compared on at least 2,000 generated cases", () => {
    for (const name of ["localDate", "instant", "semanticVersion", "instantMillis"]) {
      expect(counted(name)).toBeGreaterThanOrEqual(NUM_RUNS);
    }
    expect(counted("isLeapYear: every year of four digits")).toBeGreaterThanOrEqual(NUM_RUNS);
  });
});

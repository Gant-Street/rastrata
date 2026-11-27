/**
 * Journal admission, the Lean model run against the TypeScript on the same inputs:
 * `admitJournal`, `validateAccountingCoordinate`, `canonicalJournalValue` (hashed with
 * `hashCanonical`) and `validateSnapshot` of `src/journal.ts`
 * (`proofs/Rastrata/Kernel/Journal/Admission.lean`).
 *
 * The wire is `proofs/Oracle/Wave2b.lean`'s (its head describes every record): a string is the
 * hexadecimal of its UTF-16 code units, an integer is a decimal string, a number is
 * `{numerator, denominator}` or `{coefficient, scale}`. A diagnostic is compared by its code, its
 * path and its requirement identifiers; its `message` is not modelled (`Admission.lean`, head), so
 * it is not on the wire.
 *
 * `validateSnapshot` is not exported. Its diagnostics are the first ones `validateAccountingCoordinate`
 * returns, and the only ones whose path starts with `snapshot.`; the test takes them from there
 * (and checks that they are a prefix of the whole list). The maps it returns are not visible; their
 * keys, in insertion order, are the identifiers in order of first appearance, which the test
 * writes out itself.
 *
 * The inputs are made by `wave2b-gen-admission.ts`: a clean world that admission admits, spoiled by
 * defects each of which aims at one diagnostic, with the edges (identifiers whose UTF-16 order and
 * code point order differ, ties on ordinals, enormous ordinals, amounts at the size limit, dates that
 * are not dates). Each test counts what it reached and fails if a diagnostic was seen fewer than 20
 * times or a branch fewer than 100 times, so that agreement says something.
 *
 * Every source character in this file is ASCII: a code point is written as a number.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  type JournalAdmissionSnapshot,
  type JournalTransaction,
  type SemanticDiagnostic,
  ExactDecimal,
  accountId,
  admitJournal,
  canonicalJournalValue,
  hashCanonical,
  validateAccountingCoordinate,
} from "../src/index.ts";
import { OracleClient, type OracleOutcome } from "./oracle-client.ts";
import {
  Rng,
  admissionDiagnosticWire,
  compareSweep,
  coordinateWire,
  diagnosticKind,
  journalWire,
  outcomeOf,
  scaled,
  snapshotWire,
} from "./wave2b-wire.ts";
import {
  ADMIT,
  COORDINATE,
  HASH,
  SNAPSHOT,
  type PostingSpec,
  type World,
  buildCoordinate,
  buildJournal,
  buildRequired,
  buildSnapshot,
  cleanWorld,
  makeWorld,
  type Profile,
} from "./wave2b-gen-admission.ts";
import {
  SEED,
  TEST_TIMEOUT_MS,
  type SweepCase,
  chr,
  clip,
  count,
  counted,
  hashWire,
  textFromWire,
  textToWire,
  valueWire,
} from "./wave2a-wire.ts";

// ---------------------------------------------------------------------------------------------
// Both sides
// ---------------------------------------------------------------------------------------------

type WireDiagnostic = { code: string; path: string; requirementIds: string[] };

const tsAdmit = (
  snapshot: JournalAdmissionSnapshot,
  journal: JournalTransaction,
): OracleOutcome<unknown> =>
  outcomeOf(() => {
    const result = admitJournal(snapshot, journal);
    return result.disposition === "admitted"
      ? { disposition: "admitted", canonicalHash: hashWire(result.canonicalHash) }
      : {
          disposition: "rejected",
          diagnostics: result.diagnostics.map(admissionDiagnosticWire),
        };
  });

const tsCoordinate = (
  snapshot: JournalAdmissionSnapshot,
  coordinate: Parameters<typeof validateAccountingCoordinate>[1],
  required: Parameters<typeof validateAccountingCoordinate>[2],
): OracleOutcome<unknown> =>
  outcomeOf(() =>
    validateAccountingCoordinate(snapshot, coordinate, required).map(admissionDiagnosticWire),
  );

/** First appearance order of identifiers: the keys of the `Map` that `indexById` builds. */
const firstAppearances = (ids: readonly string[]): string[] => [...new Set(ids)];

/**
 * `validateSnapshot`, which is private: its diagnostics are the ones of `validateAccountingCoordinate`
 * whose path starts with `snapshot.` (every other path starts with `coordinate.`), and they come
 * first. The keys of its three maps are written out here.
 */
function tsSnapshot(snapshot: JournalAdmissionSnapshot): OracleOutcome<unknown> {
  return outcomeOf(() => {
    const everything = validateAccountingCoordinate(
      snapshot,
      {
        bookId: snapshot.bookId,
        functionalCommodityId: snapshot.functionalCommodityId,
        accountingDate: "2024-06-30" as never,
        accountId: accountId("zz-no-such-account"),
        unitsCommodityId: snapshot.functionalCommodityId,
        dimensionMemberIds: [],
      },
      [],
    );
    const own = everything.filter((d) => d.path.startsWith("snapshot."));
    const prefix = everything.slice(0, own.length);
    if (own.some((d, index) => d !== prefix[index])) {
      throw new Error("the diagnostics of validateSnapshot are not a prefix of the whole list");
    }
    return {
      diagnostics: own.map(admissionDiagnosticWire),
      accountIds: firstAppearances(snapshot.accounts.map((a) => a.id)).map(textToWire),
      dimensionIds: firstAppearances(snapshot.dimensions.map((d) => d.id)).map(textToWire),
      memberIds: firstAppearances(snapshot.dimensionMembers.map((m) => m.id)).map(textToWire),
    };
  });
}

const tsValue = (journal: JournalTransaction): OracleOutcome<unknown> =>
  outcomeOf(() => valueWire(canonicalJournalValue(journal)));
const tsHash = (journal: JournalTransaction): OracleOutcome<unknown> =>
  outcomeOf(() => hashWire(hashCanonical(canonicalJournalValue(journal))));

// ---------------------------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------------------------

const wireKind = (d: WireDiagnostic): string =>
  diagnosticKind({
    code: d.code as SemanticDiagnostic["code"],
    path: textFromWire(d.path),
    message: "",
    requirementIds: d.requirementIds.map(textFromWire),
  });

/** Counts, under `prefix`, each diagnostic kind and each branch of an outcome. */
function tallyOutcome(prefix: string, outcome: OracleOutcome<unknown>): void {
  if (outcome.kind === "error") {
    count(`${prefix}: error ${outcome.code}`);
    return;
  }
  const value = outcome.value as unknown;
  if (Array.isArray(value)) {
    count(`${prefix}: ${value.length === 0 ? "no diagnostics" : "diagnostics"}`);
    for (const d of value as WireDiagnostic[]) count(`${prefix} kind: ${wireKind(d)}`);
    return;
  }
  const record = value as { disposition?: string; diagnostics?: WireDiagnostic[] };
  if (record.disposition !== undefined) count(`${prefix}: ${record.disposition}`);
  else
    count(
      `${prefix}: ${(record.diagnostics ?? []).length === 0 ? "no diagnostics" : "diagnostics"}`,
    );
  for (const d of record.diagnostics ?? []) count(`${prefix} kind: ${wireKind(d)}`);
}

/** The kinds of diagnostic of `validateSnapshot`. */
const SNAPSHOT_KINDS = [
  "book_isolation_violation @ snapshot.accounts[id].bookId ACC-026",
  "book_isolation_violation @ snapshot.dimensions[id].bookId ACC-026,ACC-037",
  "canonical_identity_conflict @ snapshot.accounts[id] ACC-038",
  "canonical_identity_conflict @ snapshot.dimensionMembers[id] ACC-038",
  "canonical_identity_conflict @ snapshot.dimensions[id] ACC-038",
  "invalid_chart_or_account @ snapshot.accounts[id].closedOn ACC-013,ACC-014",
  "invalid_chart_or_account @ snapshot.accounts[id].code ACC-014",
  "invalid_chart_or_account @ snapshot.accounts[id].parentId ACC-014",
  "invalid_chart_or_account @ snapshot.accounts[id].parentId ACC-014,ACC-038",
  "invalid_dimension_selection @ snapshot.dimensionMembers[id].closedOn ACC-013,ACC-037",
  "invalid_dimension_selection @ snapshot.dimensionMembers[id].code ACC-037",
  "invalid_dimension_selection @ snapshot.dimensionMembers[id].dimensionId ACC-037,ACC-038",
  "invalid_dimension_selection @ snapshot.dimensionMembers[id].parentId ACC-037",
  "invalid_dimension_selection @ snapshot.dimensionMembers[id].parentId ACC-037,ACC-038",
  "invalid_dimension_selection @ snapshot.dimensions[id].closedOn ACC-013,ACC-037",
  "invalid_dimension_selection @ snapshot.dimensions[id].code ACC-037",
  "invalid_dimension_selection @ snapshot.requiredDimensionIds ACC-011,ACC-037,ACC-038",
];

/** The kinds that a coordinate or a posting adds, written for the path prefix `where`. */
const siteKinds = (where: string, commodityPath: string): string[] => [
  `invalid_chart_or_account @ ${where}.accountId ACC-014`,
  `invalid_chart_or_account @ ${where}.accountId ACC-014,ACC-038`,
  `invalid_chart_or_account @ ${where}.${commodityPath} ACC-014`,
  `invalid_dimension_selection @ ${where}.dimensionMemberIds ACC-011,ACC-037`,
  `invalid_dimension_selection @ ${where}.dimensionMemberIds ACC-026,ACC-037`,
  `invalid_dimension_selection @ ${where}.dimensionMemberIds ACC-037`,
  `invalid_dimension_selection @ ${where}.dimensionMemberIds ACC-037,ACC-038`,
];

const ADMIT_KINDS = [
  ...SNAPSHOT_KINDS,
  ...siteKinds("journal.postings[]", "units.commodityId"),
  "book_isolation_violation @ journal.bookId ACC-026",
  "monetary_type_mismatch @ journal.functionalCommodityId ACC-002,ACC-026",
  "invalid_journal_structure @ journal.postings ACC-018",
  "invalid_journal_structure @ journal.postings[].id ACC-018,ACC-038",
  "invalid_journal_structure @ journal.postings[].ordinal ACC-018,ACC-019",
  "invalid_journal_structure @ journal.postings[].bookValue.amount ACC-003,ACC-018",
  "monetary_type_mismatch @ journal.postings[].bookValue.functionalCommodityId ACC-002,ACC-003,ACC-026",
  "invalid_exact_number @ journal.postings[].units ACC-001,ACC-002",
  "invalid_exact_number @ journal.postings[].costBasis ACC-001,ACC-023",
  "monetary_type_mismatch @ journal.postings[].transactionPrice ACC-002,ACC-012,ACC-026",
  "monetary_type_mismatch @ journal.postings[].costBasis.basisCommodityId ACC-002,ACC-023,ACC-026",
  "journal_imbalance @ journal.postings ACC-003",
];

const COORDINATE_KINDS = [
  ...SNAPSHOT_KINDS,
  ...siteKinds("coordinate", "unitsCommodityId"),
  "book_isolation_violation @ coordinate.bookId ACC-026",
  "monetary_type_mismatch @ coordinate.functionalCommodityId ACC-002,ACC-026",
  "invalid_dimension_selection @ coordinate.requiredDimensionIds ACC-011,ACC-037,ACC-038",
];

function expectEvery(prefix: string, kinds: readonly string[], atLeast: number): void {
  for (const kind of kinds) {
    expect({ kind, seen: counted(`${prefix} kind: ${kind}`) >= atLeast }).toEqual({
      kind,
      seen: true,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------------------------

const tagsToShow = (world: World): string =>
  [...world.tags].filter((tag) => !tag.startsWith("mutator:")).join(",");
const mutatorsToShow = (world: World): string =>
  [...world.tags]
    .filter((tag) => tag.startsWith("mutator:"))
    .map((tag) => tag.slice(8))
    .join(",");

/** A stream of cases: the world of each is made from the seed, the stream and the index alone. */
function* worlds(stream: number, profile: Profile, cases: number): Generator<[number, World]> {
  for (let index = 0; index < cases; index++) {
    yield [index, makeWorld(Rng.forCase(SEED, stream, index), profile)];
  }
}

const describeCase = (what: string, index: number, world: World, args: unknown): string =>
  `${what} case ${index} [${tagsToShow(world)}] defects(${mutatorsToShow(world)}): ${clip(JSON.stringify(args), 2200)}`;

// ---------------------------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------------------------

describe("Journal admission Lean oracle equivalence", () => {
  let oracle: OracleClient;

  beforeAll(() => {
    oracle = OracleClient.start();
  });

  afterAll(async () => {
    await oracle.close();
    console.log(
      [
        "journal admission cases compared:",
        ...[
          "admitJournal",
          "validateAccountingCoordinate",
          "validateSnapshot",
          "canonicalJournalValue",
          "canonicalJournalHash",
          "examples",
        ].map((name) => `  ${name}: ${counted(name)}`),
      ].join("\n"),
    );
    if (process.env.ORACLE_COUNTS) {
      for (const [name, cases] of [...(await import("./wave2a-wire.ts")).counts].sort((a, b) =>
        a[0].localeCompare(b[0]),
      )) {
        console.log(`${String(cases).padStart(9)}  ${name}`);
      }
    }
  });

  // -------------------------------------------------------------------------------------------
  // admitJournal
  // -------------------------------------------------------------------------------------------

  test(
    "admitJournal matches Lean",
    async () => {
      const tags: string[][] = [];
      const cases = (function* (): Generator<SweepCase> {
        for (const [index, world] of worlds(1, ADMIT, scaled(30000))) {
          const snapshot = buildSnapshot(world);
          const journal = buildJournal(world);
          const args = [snapshotWire(snapshot), journalWire(journal)];
          tags.push([...world.tags].filter((tag) => !tag.startsWith("mutator:")));
          yield {
            args,
            ts: () => tsAdmit(snapshot, journal),
            show: () => describeCase("admitJournal", index, world, args),
          };
        }
      })();
      await compareSweep(oracle, "journal.admitJournal", "admitJournal", cases, {
        batch: 128,
        tally: (outcome, index) => {
          tallyOutcome("admitJournal", outcome);
          for (const tag of tags[index] ?? []) count(`admitJournal tag: ${tag}`);
        },
      });
      // Both branches, and the exact-number error: each seen often.
      expect(counted("admitJournal: admitted")).toBeGreaterThanOrEqual(100);
      expect(counted("admitJournal: rejected")).toBeGreaterThanOrEqual(100);
      expect(counted("admitJournal: error representation_limit_exceeded")).toBeGreaterThanOrEqual(
        20,
      );
      // Every diagnostic the function can give, seen at least 20 times.
      expectEvery("admitJournal", ADMIT_KINDS, 20);
      // The edges.
      for (const tag of [
        "exotic ids",
        "ordinal ties",
        "huge ordinals",
        "size limit",
        "weird dates",
      ]) {
        expect({ tag, seen: counted(`admitJournal tag: ${tag}`) >= 100 }).toEqual({
          tag,
          seen: true,
        });
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------------------------
  // validateAccountingCoordinate
  // -------------------------------------------------------------------------------------------

  test(
    "validateAccountingCoordinate matches Lean",
    async () => {
      const cases = (function* (): Generator<SweepCase> {
        for (const [index, world] of worlds(2, COORDINATE, scaled(15000))) {
          const snapshot = buildSnapshot(world);
          const coordinate = buildCoordinate(world);
          const required = buildRequired(world);
          const args = [
            snapshotWire(snapshot),
            coordinateWire(coordinate),
            required.map(textToWire),
          ];
          yield {
            args,
            ts: () => tsCoordinate(snapshot, coordinate, required),
            show: () => describeCase("validateAccountingCoordinate", index, world, args),
          };
        }
      })();
      await compareSweep(
        oracle,
        "journal.validateAccountingCoordinate",
        "validateAccountingCoordinate",
        cases,
        {
          batch: 128,
          tally: (outcome) => tallyOutcome("validateAccountingCoordinate", outcome),
        },
      );
      expect(counted("validateAccountingCoordinate: no diagnostics")).toBeGreaterThanOrEqual(100);
      expect(counted("validateAccountingCoordinate: diagnostics")).toBeGreaterThanOrEqual(100);
      expectEvery("validateAccountingCoordinate", COORDINATE_KINDS, 20);
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------------------------
  // validateSnapshot
  // -------------------------------------------------------------------------------------------

  test(
    "validateSnapshot matches Lean",
    async () => {
      const cases = (function* (): Generator<SweepCase> {
        for (const [index, world] of worlds(3, SNAPSHOT, scaled(8000))) {
          const snapshot = buildSnapshot(world);
          const args = [snapshotWire(snapshot)];
          yield {
            args,
            ts: () => tsSnapshot(snapshot),
            show: () => describeCase("validateSnapshot", index, world, args),
          };
        }
      })();
      await compareSweep(oracle, "journal.validateSnapshot", "validateSnapshot", cases, {
        batch: 128,
        tally: (outcome) => {
          const value = (outcome as { value?: { diagnostics: WireDiagnostic[] } }).value;
          tallyOutcome("validateSnapshot", { kind: "ok", value: value?.diagnostics ?? [] });
        },
      });
      expect(counted("validateSnapshot: no diagnostics")).toBeGreaterThanOrEqual(100);
      expect(counted("validateSnapshot: diagnostics")).toBeGreaterThanOrEqual(100);
      expectEvery("validateSnapshot", SNAPSHOT_KINDS, 20);
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------------------------
  // canonicalJournalValue, and its hash
  // -------------------------------------------------------------------------------------------

  /** The postings in the order the canonical value writes them, by UTF-16 order and by code point
   * order of the identifiers: whether the two differ. */
  const codePoints = (text: string) => Array.from(text, (c) => c.codePointAt(0) as number);
  const compareCodePoints = (left: string, right: string): number => {
    const a = codePoints(left);
    const b = codePoints(right);
    for (let index = 0; index < Math.min(a.length, b.length); index++) {
      if (a[index] !== b[index]) return (a[index] as number) < (b[index] as number) ? -1 : 1;
    }
    return a.length - b.length;
  };
  const utf16Compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

  function orderClasses(journal: JournalTransaction): string[] {
    const classes: string[] = [];
    const byUnit = [...journal.postings].sort(
      (l, r) => Number(l.ordinal - r.ordinal) || utf16Compare(l.id, r.id),
    );
    const byPoint = [...journal.postings].sort(
      (l, r) => Number(l.ordinal - r.ordinal) || compareCodePoints(l.id, r.id),
    );
    if (byUnit.some((posting, index) => posting !== byPoint[index])) {
      classes.push("postings: UTF-16 order is not code point order");
    }
    for (const posting of journal.postings) {
      const byUnitIds = [...posting.dimensionMemberIds].sort();
      const byPointIds = [...posting.dimensionMemberIds].sort(compareCodePoints);
      if (byUnitIds.some((id, index) => id !== byPointIds[index])) {
        classes.push("members: UTF-16 order is not code point order");
        break;
      }
    }
    if (
      journal.postings.some(
        (p, index) =>
          index > 0 && p.ordinal === (journal.postings[index - 1] as { ordinal: bigint }).ordinal,
      )
    ) {
      classes.push("postings: two with one ordinal");
    }
    return classes;
  }

  test(
    "canonicalJournalValue and its hash match Lean",
    async () => {
      const journals: JournalTransaction[] = [];
      const make = (): Generator<[number, World, JournalTransaction]> =>
        (function* () {
          for (const [index, world] of worlds(4, HASH, scaled(12000))) {
            yield [index, world, buildJournal(world)];
          }
        })();
      const valueCases = (function* (): Generator<SweepCase> {
        for (const [index, world, journal] of make()) {
          journals.push(journal);
          const args = [journalWire(journal)];
          yield {
            args,
            ts: () => tsValue(journal),
            show: () => describeCase("canonicalJournalValue", index, world, args),
          };
        }
      })();
      await compareSweep(
        oracle,
        "journal.canonicalJournalValue",
        "canonicalJournalValue",
        valueCases,
        {
          batch: 128,
        },
      );
      const hashCases = (function* (): Generator<SweepCase> {
        for (const [index, world, journal] of make()) {
          const args = [journalWire(journal)];
          yield {
            args,
            ts: () => tsHash(journal),
            show: () => describeCase("canonicalJournalHash", index, world, args),
          };
        }
      })();
      await compareSweep(
        oracle,
        "journal.canonicalJournalHash",
        "canonicalJournalHash",
        hashCases,
        {
          batch: 128,
          tally: (_outcome, index) => {
            for (const klass of orderClasses(journals[index] as JournalTransaction)) {
              count(`canonicalJournalHash class: ${klass}`);
            }
          },
        },
      );
      for (const klass of [
        "postings: UTF-16 order is not code point order",
        "members: UTF-16 order is not code point order",
        "postings: two with one ordinal",
      ]) {
        expect({ klass, seen: counted(`canonicalJournalHash class: ${klass}`) >= 100 }).toEqual({
          klass,
          seen: true,
        });
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------------------------
  // Hand-built examples, with what each must be
  // -------------------------------------------------------------------------------------------

  /** The TypeScript's outcome and the model's, for one call, the same. */
  async function expectSame(
    entry: string,
    args: unknown[],
    ts: OracleOutcome<unknown>,
    what: string,
  ): Promise<void> {
    const lean = await oracle.call(entry, args);
    expect({ what, same: Bun.deepEquals(ts, lean, true) }).toEqual({ what, same: true });
    count("examples");
  }

  /** A clean world with no dimension required and postings with the amounts given. */
  function withAmounts(amounts: readonly bigint[], ordinals?: readonly bigint[]) {
    const world = cleanWorld(Rng.forCase(SEED, 22, 0), 0);
    const base = world.journal.postings[0];
    if (base === undefined) throw new Error("the clean world has no posting");
    world.snapshot.required = [];
    delete world.snapshot.byPosting;
    world.journal.postings = amounts.map((amount, index) => ({
      ...base,
      id: world.names.post(index),
      ordinal: ordinals?.[index] ?? BigInt(index),
      bookValue: { amount: ExactDecimal.of(amount, 0n), functionalCommodityId: "USD" },
    }));
    return { world, snapshot: buildSnapshot(world), journal: buildJournal(world) };
  }

  test(
    "a clean journal is admitted, with the hash of its canonical value",
    async () => {
      const { snapshot, journal } = withAmounts([100n, -30n, -70n]);
      const result = admitJournal(snapshot, journal);
      expect(result.disposition).toBe("admitted");
      expect(result.disposition === "admitted" && result.canonicalHash.digest).toBe(
        hashCanonical(canonicalJournalValue(journal)).digest,
      );
      await expectSame(
        "journal.admitJournal",
        [snapshotWire(snapshot), journalWire(journal)],
        tsAdmit(snapshot, journal),
        "clean journal",
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "amounts whose partial sums reach the size limit exactly are admitted; one bit more is the exact-number error",
    async () => {
      const top = 1n << 16383n; // the smallest number of 16384 binary digits
      const limit = (1n << 16384n) - 1n; // the largest
      // The partial sums are 2^16383, then 2^16384 - 1 (16384 bits), then 0.
      const inside = withAmounts([top, top - 1n, -limit]);
      expect(admitJournal(inside.snapshot, inside.journal).disposition).toBe("admitted");
      await expectSame(
        "journal.admitJournal",
        [snapshotWire(inside.snapshot), journalWire(inside.journal)],
        tsAdmit(inside.snapshot, inside.journal),
        "partial sums at the limit",
      );
      // The partial sum 2^16384 has 16385 bits: ExactRational.of refuses it.
      const over = withAmounts([top, top, -top, -top]);
      expect(() => admitJournal(over.snapshot, over.journal)).toThrow(
        expect.objectContaining({ code: "representation_limit_exceeded" }),
      );
      await expectSame(
        "journal.admitJournal",
        [snapshotWire(over.snapshot), journalWire(over.journal)],
        tsAdmit(over.snapshot, over.journal),
        "partial sum one bit over the limit",
      );
      expect(tsAdmit(over.snapshot, over.journal)).toEqual({
        kind: "error",
        code: "representation_limit_exceeded",
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "postings with one ordinal are written in the order of their identifiers by UTF-16 code unit, not by code point",
    async () => {
      const bmp = `p${chr(0xff5e)}`; // one code unit, above the surrogates
      const astral = `p${chr(0x1f600)}`; // a pair of surrogates
      expect(bmp < astral).toBe(false); // by code unit the astral identifier is first
      const world = cleanWorld(Rng.forCase(SEED, 22, 0), 0);
      world.snapshot.required = [];
      delete world.snapshot.byPosting;
      world.journal.postings = [
        { ...(world.journal.postings[0] as PostingSpec), id: bmp, ordinal: 0n },
        { ...(world.journal.postings[1] as PostingSpec), id: astral, ordinal: 0n },
      ];
      const tied = buildJournal(world);
      const written = (canonicalJournalValue(tied) as { postings: { id: string }[] }).postings.map(
        (posting) => posting.id,
      );
      expect(written).toEqual([astral, bmp]);
      await expectSame(
        "journal.canonicalJournalValue",
        [journalWire(tied)],
        tsValue(tied),
        "tied postings",
      );
      await expectSame(
        "journal.canonicalJournalHash",
        [journalWire(tied)],
        tsHash(tied),
        "tied postings",
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the dimension members of a posting are written in UTF-16 order, not code point order",
    async () => {
      const world = cleanWorld(Rng.forCase(SEED, 22, 0), 0);
      const posting = world.journal.postings[0] as { members: string[] };
      const bmp = `m${chr(0xff5e)}`;
      const astral = `m${chr(0x1f600)}`;
      posting.members = [bmp, astral, "m1", `m${chr(0xe000)}`];
      const journal = buildJournal(world);
      const written = (
        canonicalJournalValue(journal) as { postings: { dimensionMemberIds: string[] }[] }
      ).postings.flatMap((p) => p.dimensionMemberIds);
      const mine = (written as string[]).filter((id) => id.startsWith("m") && id.length >= 2);
      expect(mine.indexOf(astral)).toBeLessThan(mine.indexOf(bmp));
      await expectSame(
        "journal.canonicalJournalValue",
        [journalWire(journal)],
        tsValue(journal),
        "members",
      );
      await expectSame(
        "journal.canonicalJournalHash",
        [journalWire(journal)],
        tsHash(journal),
        "members",
      );
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------------------------
  // Known differences. Each is pinned: the test says what the TypeScript does and what the model
  // answers, so that when either changes the test fails and says which.
  // -------------------------------------------------------------------------------------------

  describe("known differences between the model and the TypeScript", () => {
    // DIFFERENCE 1 (kind b, a defect of the kernel that the proved laws did not expect).
    // `journal.ts` line 843 reads `snapshot.requiredDimensionIdsByPosting?.[posting.id]`. For a plain
    // object and a posting whose identifier is a property of `Object.prototype` that the object
    // does not have as its own, the read finds the inherited property (a function, or
    // `Object.prototype` for `__proto__`); it is not `undefined`, so it becomes `requiredDimensions`
    // and the `for ... of` at line 624 throws a TypeError. `admitJournal` throws instead of
    // answering. The model looks among the own properties only (`requiredDimensionsFor`,
    // Admission.lean line 468; `LookupDiverges`, line 2137), so it goes on with the snapshot's
    // default required dimensions.
    const OBJECT_PROTOTYPE_NAMES = [
      "toString",
      "toLocaleString",
      "valueOf",
      "hasOwnProperty",
      "propertyIsEnumerable",
      "isPrototypeOf",
      "__defineGetter__",
      "__defineSetter__",
      "__lookupGetter__",
      "__lookupSetter__",
      "__proto__",
      "constructor",
    ];

    test("the twelve names are every own property of Object.prototype in this runtime", () => {
      expect([...OBJECT_PROTOTYPE_NAMES].sort()).toEqual(
        Object.getOwnPropertyNames(Object.prototype).sort(),
      );
    });

    /** A clean journal whose first posting has the identifier, and a snapshot with the map of
     * required dimensions by posting in the three states: a plain object that lacks the key, an
     * object with no prototype, and a plain object that has the key as its own. */
    function inherited(name: string) {
      const world = cleanWorld(Rng.forCase(SEED, 21, 0), 0);
      (world.journal.postings[0] as { id: string }).id = name;
      world.snapshot.byPosting = [];
      const plain = buildSnapshot(world);
      const journal = buildJournal(world);
      const bare = { ...plain, requiredDimensionIdsByPosting: Object.create(null) };
      world.snapshot.byPosting = [[name, []]];
      const own = buildSnapshot(world);
      return { plain, bare, own, journal };
    }

    for (const name of OBJECT_PROTOTYPE_NAMES) {
      test(
        `admitJournal: a posting called ${name}, in a plain object without that key: TypeScript and the model agree`,
        async () => {
          const { plain, bare, journal } = inherited(name);
          const lean = await oracle.call("journal.admitJournal", [
            snapshotWire(plain),
            journalWire(journal),
          ]);
          expect(lean.kind).toBe("ok");
          expect(tsAdmit(plain, journal)).toEqual(lean);
          expect(tsAdmit(bare, journal)).toEqual(lean);
          count("resolved difference: inherited property of Object.prototype");
        },
        TEST_TIMEOUT_MS,
      );
    }

    test(
      "admitJournal: a posting called like a property of Object.prototype, in a map that has the key as its own, is found by both",
      async () => {
        for (const name of OBJECT_PROTOTYPE_NAMES) {
          const { own, journal } = inherited(name);
          const ts = tsAdmit(own, journal);
          expect(ts.kind).toBe("ok");
          await expectSame(
            "journal.admitJournal",
            [snapshotWire(own), journalWire(journal)],
            ts,
            `own property ${name}`,
          );
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "admitJournal: a map with no prototype never diverges, whatever the posting is called",
      async () => {
        for (const name of OBJECT_PROTOTYPE_NAMES) {
          const { bare, journal } = inherited(name);
          await expectSame(
            "journal.admitJournal",
            [snapshotWire(bare), journalWire(journal)],
            tsAdmit(bare, journal),
            `no prototype ${name}`,
          );
        }
      },
      TEST_TIMEOUT_MS,
    );

    // DIFFERENCE 2 (kind c, an input the model cannot represent). A JavaScript string is a
    // sequence of UTF-16 code units and may hold a lone surrogate; the model's `String` cannot.
    // The oracle answers such an argument with `model_has_no_lone_surrogate`. The TypeScript
    // accepts it everywhere: `identifier` takes it (it is no control character, no space, and
    // inert under NFC), and the canonical encoding writes U+FFFD in its place.
    const lone = String.fromCharCode(0xd800);

    test(
      "the oracle refuses a lone surrogate in every entry",
      async () => {
        const world = cleanWorld(Rng.forCase(SEED, 23, 0), 0);
        const snapshot = buildSnapshot(world);
        const journal = buildJournal(world);
        const coordinate = buildCoordinate(world);
        const withLone = { ...journal, narration: `a${lone}b` };
        const snapshotLone = {
          ...snapshot,
          accounts: snapshot.accounts.map((a, index) => (index === 0 ? { ...a, name: lone } : a)),
        };
        const refused: OracleOutcome<unknown> = {
          kind: "error",
          code: "model_has_no_lone_surrogate",
        };
        expect(
          await oracle.call("journal.admitJournal", [
            snapshotWire(snapshot),
            journalWire(withLone),
          ]),
        ).toEqual(refused);
        expect(
          await oracle.call("journal.admitJournal", [
            snapshotWire(snapshotLone),
            journalWire(journal),
          ]),
        ).toEqual(refused);
        expect(
          await oracle.call("journal.validateAccountingCoordinate", [
            snapshotWire(snapshotLone),
            coordinateWire(coordinate),
            [],
          ]),
        ).toEqual(refused);
        expect(await oracle.call("journal.validateSnapshot", [snapshotWire(snapshotLone)])).toEqual(
          refused,
        );
        expect(await oracle.call("journal.canonicalJournalValue", [journalWire(withLone)])).toEqual(
          refused,
        );
        expect(await oracle.call("journal.canonicalJournalHash", [journalWire(withLone)])).toEqual(
          refused,
        );
        count("known difference: lone surrogate refused by the oracle", 6);
      },
      TEST_TIMEOUT_MS,
    );

    test("TypeScript: a lone surrogate in the narration is rejected by canonical hashing", () => {
      const world = cleanWorld(Rng.forCase(SEED, 23, 0), 0);
      const journal = buildJournal(world);
      expect(() =>
        hashCanonical(canonicalJournalValue({ ...journal, narration: `a${lone}b` })),
      ).toThrow(TypeError);
    });

    test(
      "canonicalJournalHash: both TypeScript and the model refuse a lone surrogate",
      async () => {
        const world = cleanWorld(Rng.forCase(SEED, 23, 0), 0);
        const journal = { ...buildJournal(world), narration: `a${lone}b` };
        expect(tsHash(journal).kind).toBe("error");
        expect(await oracle.call("journal.canonicalJournalHash", [journalWire(journal)])).toEqual({
          kind: "error",
          code: "model_has_no_lone_surrogate",
        });
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "admitJournal: both TypeScript and the model refuse a journal whose posting identifier holds a lone surrogate",
      async () => {
        const world = cleanWorld(Rng.forCase(SEED, 23, 0), 0);
        (world.journal.postings[0] as { id: string }).id = `p${lone}`;
        const snapshot = buildSnapshot(world);
        const journal = buildJournal(world);
        expect(tsAdmit(snapshot, journal).kind).toBe("error");
        expect(
          await oracle.call("journal.admitJournal", [snapshotWire(snapshot), journalWire(journal)]),
        ).toEqual({ kind: "error", code: "model_has_no_lone_surrogate" });
      },
      TEST_TIMEOUT_MS,
    );

    test.failing(
      "validateSnapshot: the TypeScript takes an account code with a lone surrogate, the model has no such string",
      async () => {
        const world = cleanWorld(Rng.forCase(SEED, 23, 0), 0);
        (world.snapshot.accounts[0] as { code: string }).code = lone;
        const snapshot = buildSnapshot(world);
        await expectSame(
          "journal.validateSnapshot",
          [snapshotWire(snapshot)],
          tsSnapshot(snapshot),
          "lone",
        );
      },
      TEST_TIMEOUT_MS,
    );
  });

  // -------------------------------------------------------------------------------------------
  // What the model does not model (kind c): pinned on the TypeScript's side alone, because the
  // wire cannot carry the input.
  // -------------------------------------------------------------------------------------------

  describe("what the model leaves out", () => {
    test("TypeScript: a number of the wrong runtime type is a diagnostic at the posting; the model assumes the types hold", () => {
      // `admitJournal` tests `instanceof` on six fields (journal.ts lines 705 to 731). The types
      // already rule the failure out, so the model takes the tests as passed and never produces
      // that diagnostic (Admission.lean, head). A value forged past the types shows what is left out.
      const { snapshot, journal } = withAmounts([100n, -100n]);
      const forge = (patch: (posting: never) => unknown): JournalTransaction => ({
        ...journal,
        postings: journal.postings.map((p, index) =>
          index === 0 ? patch(p as never) : p,
        ) as never,
      });
      const codes = (j: JournalTransaction) => {
        const result = admitJournal(snapshot, j);
        return result.disposition === "rejected"
          ? result.diagnostics.map((d) => `${d.code} @ ${d.path}`)
          : [];
      };
      const forgedAmount = forge((p: { bookValue: object }) => ({
        ...p,
        bookValue: { ...p.bookValue, amount: { coefficient: 5n, scale: 2n } },
      }));
      expect(codes(forgedAmount)).toContain("monetary_type_mismatch @ journal.postings[0]");
      const forgedQuantity = forge((p: { units: object }) => ({
        ...p,
        units: { ...p.units, canonicalNumber: { numerator: 1n, denominator: 2n } },
      }));
      expect(codes(forgedQuantity)).toEqual(["invalid_exact_number @ journal.postings[0]"]);
      count("what the model leaves out: forged runtime types", 2);
    });

    test("TypeScript: the message of journal_imbalance names the residual, which the model does not return", () => {
      const { snapshot, journal } = withAmounts([100n, -97n]);
      const result = admitJournal(snapshot, journal);
      expect(result.disposition).toBe("rejected");
      const messages =
        result.disposition === "rejected"
          ? result.diagnostics.filter((d) => d.code === "journal_imbalance").map((d) => d.message)
          : [];
      expect(messages).toEqual(["Functional book values do not balance exactly; residual is 3/1"]);
    });

    test("TypeScript: the identifiers of a snapshot are strings; a string that is not an identifier is compared as one", async () => {
      // `identifier` refuses an empty string or one with boundary whitespace, but the brand is not
      // enforced at run time. Both sides compare identifiers as plain strings, so a forged one is
      // found by the same lookups. (The generator makes some: the tag "forged identifier".)
      const world = cleanWorld(Rng.forCase(SEED, 24, 0), 0);
      (world.snapshot.accounts[0] as { id: string }).id = " padded ";
      (world.journal.postings[0] as { accountId: string }).accountId = " padded ";
      const snapshot = buildSnapshot(world);
      const journal = buildJournal(world);
      expect(world.tags.has("forged identifier")).toBe(true);
      await expectSame(
        "journal.admitJournal",
        [snapshotWire(snapshot), journalWire(journal)],
        tsAdmit(snapshot, journal),
        "forged identifier",
      );
    });
  });
});

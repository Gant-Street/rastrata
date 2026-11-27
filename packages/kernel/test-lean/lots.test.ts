/**
 * The lots, the Lean model run against the TypeScript on the same inputs: `allocateLots` and
 * `transferLots` of `src/lots.ts` (`proofs/Rastrata/Kernel/Lots.lean`).
 *
 * The wire is `proofs/Oracle/Wave2b.lean`'s (its head describes every record): a string is the
 * hexadecimal of its UTF-16 code units, a number is `{numerator, denominator}`. Each function takes
 * ONE argument, an object with the TypeScript's parameter names, because the dispatch table has
 * wrappers up to four arguments and these functions have six and eleven. A diagnostic is compared
 * whole, message included: the lots model carries its messages.
 *
 * The inputs are made by `wave2b-gen-lots.ts`: a clean world that the functions accept, spoiled by
 * defects each of which aims at one rejection, with the edges (ties on the acquisition instant and
 * the unit cost, holdings with nothing left, requests larger than the holdings, instants whose text
 * order is not their time order, identifiers whose UTF-16 order and code point order differ, numbers
 * at the size limit). Each test counts what it reached and fails if a rejection was seen fewer than
 * 20 times or a branch fewer than 100 times, so that agreement says something.
 *
 * Every source character in this file is ASCII: a code point is written as a number.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { SemanticDiagnostic } from "../src/index.ts";
import { OracleClient, type OracleOutcome } from "./oracle-client.ts";
import {
  Rng,
  allocateArgs,
  compareSweep,
  holdingWire,
  lotsKind,
  scaled,
  transferArgs,
  tsAllocate,
  tsTransfer,
} from "./wave2b-wire.ts";
import {
  ALLOCATE,
  type LotsWorld,
  TRANSFER,
  makeLotsWorld,
  type Profile,
} from "./wave2b-gen-lots.ts";
import {
  SEED,
  TEST_TIMEOUT_MS,
  type SweepCase,
  clip,
  count,
  counted,
  textFromWire,
} from "./wave2a-wire.ts";

// ---------------------------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------------------------

type WireDiagnostic = { code: string; path: string; message: string; requirementIds: string[] };

const wireKind = (d: WireDiagnostic): string =>
  lotsKind({
    code: d.code as SemanticDiagnostic["code"],
    path: textFromWire(d.path),
    message: textFromWire(d.message),
    requirementIds: d.requirementIds.map(textFromWire),
  });

/** Counts, under `prefix`, the branch of an outcome and each kind of rejection. */
function tallyOutcome(prefix: string, outcome: OracleOutcome<unknown>, method: string): void {
  if (outcome.kind === "error") {
    count(`${prefix}: error ${outcome.code}`);
    count(`${prefix}: error (${method})`);
    return;
  }
  const value = outcome.value as { disposition: string; diagnostics?: WireDiagnostic[] };
  count(`${prefix}: ${value.disposition}`);
  count(`${prefix}: ${value.disposition} (${method})`);
  for (const d of value.diagnostics ?? []) {
    count(`${prefix} kind: ${wireKind(d)}`);
    const found = /found (\d+)$/.exec(textFromWire(d.message));
    if (found !== null)
      count(`${prefix} policies found: ${Number(found[1]) >= 3 ? "3 or more" : found[1]}`);
  }
}

/** What `allocateLots` rejects, and the ways it does. */
const ALLOCATE_KINDS = [
  "canonical_identity_conflict @ holdings[].id: Holding identifier * is duplicated",
  "lot_overallocation @ holdings[]: An ordinary lot holding cannot have negative quantity or basis",
  "lot_overallocation @ holdings[].remainingCarryingAmount: A holding's carrying amount must equal historical basis plus its separately retained valuation allowance",
  "lot_overallocation @ holdings[]: A depleted holding must have both zero quantity and zero total basis",
  "lot_overallocation @ requestedQuantity: Allocated quantity must be positive",
  "canonical_identity_conflict @ lots: Lot identifier is duplicated in the supplied canonical scope",
  "lot_overallocation @ selection.allocations: Specific identification contains a duplicate holding ID",
  "lot_overallocation @ selection.allocations: Every specifically identified quantity must be positive",
  "lot_overallocation @ selection.allocations: Specific allocation quantities must exactly equal the requested quantity",
  "lot_overallocation @ selection.allocations: Specific identification must resolve every stable holding ID",
  "lot_overallocation @ holdings: Every holding must resolve one stable lot identity",
  "lot_overallocation @ holdings: A lot allocation cannot combine books or commodities",
  "lot_overallocation @ selection.allocations: A specifically identified allocation exceeds its holding",
  "lot_overallocation @ identities: Every allocated holding requires one explicitly supplied stable allocation identity",
  "canonical_identity_conflict @ allocations: Allocation identifier * is duplicated",
  "lot_overallocation @ lots: Requested quantity exceeds selected holdings",
];

/** What only `transferLots` rejects. */
const TRANSFER_KINDS = [
  "lot_overallocation @ sourceHoldings: No source holding supplied",
  "book_isolation_violation @ sourceHoldings: A transfer source must contain one book and account",
  "transfer_policy_missing @ policies: Expected exactly one applicable transfer policy; found N",
  "lot_overallocation @ destinationAccountId: A continuity transfer requires distinct source and destination accounts",
  "book_isolation_violation @ destinationHoldings: Destination holdings must use the transfer book, account, commodity, and basis commodity",
  "canonical_identity_conflict @ destinationHoldings: Destination holding identity is duplicated",
  "canonical_identity_conflict @ destinationIdentities: Every new destination holding requires one explicitly supplied stable identity",
  "canonical_identity_conflict @ destinationHoldings: Destination holding identifier * is already assigned",
];

const METHODS = ["fifo", "lifo", "hifo", "weightedAverage", "specificIdentification"] as const;

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

const tagsToShow = (world: LotsWorld): string =>
  [...world.tags].filter((tag) => !tag.startsWith("mutator:")).join(",");
const mutatorsToShow = (world: LotsWorld): string =>
  [...world.tags]
    .filter((tag) => tag.startsWith("mutator:"))
    .map((tag) => tag.slice(8))
    .join(",");

function* worlds(stream: number, profile: Profile, cases: number): Generator<[number, LotsWorld]> {
  for (let index = 0; index < cases; index++) {
    yield [index, makeLotsWorld(Rng.forCase(SEED, stream, index), profile)];
  }
}

const describeCase = (what: string, index: number, world: LotsWorld, args: unknown): string =>
  `${what} case ${index} [${tagsToShow(world)}] defects(${mutatorsToShow(world)}): ${clip(JSON.stringify(args), 2600)}`;

// ---------------------------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------------------------

describe("Lots Lean oracle equivalence", () => {
  let oracle: OracleClient;

  beforeAll(() => {
    oracle = OracleClient.start();
  });

  afterAll(async () => {
    await oracle.close();
    console.log(
      [
        "lots cases compared:",
        ...["allocateLots", "transferLots", "examples"].map(
          (name) => `  ${name}: ${counted(name)}`,
        ),
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
  // allocateLots
  // -------------------------------------------------------------------------------------------

  test(
    "allocateLots matches Lean",
    async () => {
      const methods: string[] = [];
      const tags: string[][] = [];
      const cases = (function* (): Generator<SweepCase> {
        for (const [index, world] of worlds(5, ALLOCATE, scaled(16000))) {
          const args = [allocateArgs(world)];
          methods.push(world.selection.method);
          tags.push([...world.tags].filter((tag) => !tag.startsWith("mutator:")));
          yield {
            args,
            ts: () => tsAllocate(world),
            show: () => describeCase("allocateLots", index, world, args),
          };
        }
      })();
      await compareSweep(oracle, "lots.allocateLots", "allocateLots", cases, {
        batch: 128,
        tally: (outcome, index) => {
          tallyOutcome("allocateLots", outcome, methods[index] as string);
          for (const tag of tags[index] ?? []) count(`allocateLots tag: ${tag}`);
        },
      });
      expect(counted("allocateLots: allocated")).toBeGreaterThanOrEqual(100);
      expect(counted("allocateLots: rejected")).toBeGreaterThanOrEqual(100);
      expect(counted("allocateLots: error representation_limit_exceeded")).toBeGreaterThanOrEqual(
        20,
      );
      for (const method of METHODS) {
        for (const branch of ["allocated", "rejected"]) {
          expect({
            method,
            branch,
            seen: counted(`allocateLots: ${branch} (${method})`) >= 100,
          }).toEqual({
            method,
            branch,
            seen: true,
          });
        }
      }
      expectEvery("allocateLots", ALLOCATE_KINDS, 20);
      for (const tag of [
        "ties",
        "zero remaining",
        "text order is not time order",
        "exotic ids",
        "size limit",
        "hifo overflow",
      ]) {
        expect({ tag, seen: counted(`allocateLots tag: ${tag}`) >= 100 }).toEqual({
          tag,
          seen: true,
        });
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------------------------
  // transferLots
  // -------------------------------------------------------------------------------------------

  test(
    "transferLots matches Lean",
    async () => {
      const methods: string[] = [];
      const worldsSeen: LotsWorld[] = [];
      const cases = (function* (): Generator<SweepCase> {
        for (const [index, world] of worlds(6, TRANSFER, scaled(14000))) {
          const args = [transferArgs(world)];
          methods.push(world.selection.method);
          worldsSeen.push(world);
          yield {
            args,
            ts: () => tsTransfer(world),
            show: () => describeCase("transferLots", index, world, args),
          };
        }
      })();
      await compareSweep(oracle, "lots.transferLots", "transferLots", cases, {
        batch: 128,
        tally: (outcome, index) => {
          tallyOutcome("transferLots", outcome, methods[index] as string);
          const world = worldsSeen[index] as LotsWorld;
          for (const tag of world.tags) {
            if (!tag.startsWith("mutator:")) count(`transferLots tag: ${tag}`);
          }
          if (outcome.kind === "ok") {
            const value = outcome.value as { disposition: string; destinationHoldings?: unknown[] };
            if (value.disposition === "transferred") {
              const after = value.destinationHoldings ?? [];
              if (after.length > world.destinationHoldings.length)
                count("transferLots: a destination holding was founded");
              if (
                world.destinationHoldings.some(
                  (h, at) => !Bun.deepEquals(holdingWire(h), after[at], true),
                )
              ) {
                count("transferLots: a destination holding took an allocation");
              }
            }
          }
        },
      });
      expect(counted("transferLots: transferred")).toBeGreaterThanOrEqual(100);
      expect(counted("transferLots: requiresDisposalAndReacquisition")).toBeGreaterThanOrEqual(100);
      expect(counted("transferLots: rejected")).toBeGreaterThanOrEqual(100);
      expect(counted("transferLots: error representation_limit_exceeded")).toBeGreaterThanOrEqual(
        20,
      );
      for (const method of METHODS) {
        expect({ method, seen: counted(`transferLots: transferred (${method})`) >= 100 }).toEqual({
          method,
          seen: true,
        });
      }
      expectEvery("transferLots", TRANSFER_KINDS, 20);
      expectEvery("transferLots", ALLOCATE_KINDS, 20);
      for (const found of ["0", "2", "3 or more"]) {
        expect({ found, seen: counted(`transferLots policies found: ${found}`) >= 20 }).toEqual({
          found,
          seen: true,
        });
      }
      expect(counted("transferLots: a destination holding was founded")).toBeGreaterThanOrEqual(
        100,
      );
      expect(
        counted("transferLots: a destination holding took an allocation"),
      ).toBeGreaterThanOrEqual(100);
      for (const tag of [
        "ties",
        "zero remaining",
        "first source only",
        "exotic ids",
        "size limit",
      ]) {
        expect({ tag, seen: counted(`transferLots tag: ${tag}`) >= 100 }).toEqual({
          tag,
          seen: true,
        });
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * Booking policy, the Lean model (`proofs/Rastrata/Kernel/Policy.lean`) run against `src/policy.ts`
 * on the same inputs: `selectBookingPolicy`, `canonicalPolicyValue`, `hashPolicySnapshot` and
 * `canonicalDerivationValue`.
 *
 * What is compared is what the TypeScript returns, in the wire of `proofs/Oracle/Wave2a.lean`: the
 * policy that governs, or the diagnostics in order with their code, path, message and requirement
 * identifiers; a canonical value as the tagged tree the model builds, record by record in the
 * order the TypeScript's object literal has its fields; and a hash as its three texts. A
 * `RangeError` `Invalid supplied instant: ...` (the text of a time `Date.parse` cannot read) is
 * compared by its message.
 *
 * The times are the instants of one moment written many ways: at other offsets, with a fraction
 * of a second of any length, one millisecond before and after the edge of a policy's validity.
 * Every one is an instant `instant` accepts, but for the few texts `Date.parse` cannot read at
 * all, which both sides must refuse in the same place.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  type BookingPolicy,
  type DerivationRecord,
  type LotSelectionMethod,
  type PolicyScope,
  type SourceEvidence,
  canonicalDerivationValue,
  canonicalPolicyValue,
  hashPolicySnapshot,
  selectBookingPolicy,
} from "../src/index.ts";
import { OracleClient, type OracleOutcome } from "./oracle-client.ts";
import {
  NUM_RUNS,
  SEED,
  TEST_TIMEOUT_MS,
  type SweepCase,
  arbIdentifierText,
  arbNoise,
  arbValidInstant,
  assertSame,
  bookingPolicyWire,
  chr,
  clip,
  count,
  counted,
  derivationWire,
  diagnosticWire,
  hashWire,
  instantAt,
  printCounts,
  runTs,
  showText,
  sweep,
  textToWire,
  valueWire,
} from "./wave2a-wire.ts";

// ---------------------------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------------------------

const BOOKS = ["book-a", "book-b"] as const;
const SCOPE_KEYS = ["acct-1", "acct-2", "pool-1"] as const;
const IMPLEMENTATIONS = ["1.0.0", "1.1.0", "2.0.0-rc.1"] as const;
const METHODS: readonly LotSelectionMethod[] = [
  "specificIdentification",
  "fifo",
  "lifo",
  "hifo",
  "weightedAverage",
];
const SCOPES: readonly PolicyScope[] = ["account", "legalEntity", "jurisdictionPool"];
const STATUSES = ["supported", "experimental", "unsupported"] as const;

interface PolicySpec {
  readonly id: string;
  readonly bookId: string;
  readonly version: string;
  readonly validFrom: string;
  readonly validTo: string | undefined;
  readonly lotSelection: LotSelectionMethod;
  readonly scope: PolicyScope;
  readonly scopeKey: string;
  readonly requiredDimensionIds: readonly string[];
  readonly implementationVersion: string;
  readonly capability: {
    readonly id: string;
    readonly method: LotSelectionMethod;
    readonly scope: PolicyScope;
    readonly status: (typeof STATUSES)[number];
    readonly implementationVersion: string;
    readonly verificationEvidenceIds: readonly string[];
  };
}

/** A policy of the TypeScript's type from texts that need not be valid: nothing here checks them. */
function mkPolicy(spec: PolicySpec): BookingPolicy {
  const { validTo, ...rest } = spec;
  return (validTo === undefined ? rest : { ...rest, validTo }) as unknown as BookingPolicy;
}

/** Which of the five tests of a capability a policy fails, as the TypeScript reads it. */
function capabilityFailures(policy: BookingPolicy): string[] {
  const failures: string[] = [];
  if (policy.capability.status !== "supported") failures.push("status");
  if (policy.capability.method !== policy.lotSelection) failures.push("method");
  if (policy.capability.scope !== policy.scope) failures.push("scope");
  if (policy.capability.implementationVersion !== policy.implementationVersion)
    failures.push("version");
  if (policy.capability.verificationEvidenceIds.length === 0) failures.push("evidence");
  return failures;
}

// ---------------------------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------------------------

const DELTAS = [
  0, 0, 0, 1, -1, 2, -2, 500, -500, 999, 1000, -1000, 1001, 60_000, -60_000, 3_600_000, -3_600_000,
  86_400_000, -86_400_000, 31_536_000_000, -31_536_000_000,
];
const OFFSETS = [0, 0, 60, -60, 330, -210, 840, -840, 765];
const DIGITS = [0, 1, 2, 3, 3, 3, 4, 6, 9];
const EXTRAS = ["0", "9", "99", "0001", "5", "000000001", "123"];

/** Text that `Date.parse` cannot read and `instant` refuses, so that both sides throw. */
const GARBAGE = [
  "",
  "garbage",
  "not a time",
  "2024-13-45T00:00:00Z",
  "T",
  "Z",
  "2024-01-01T00:00:00Zjunk",
  "99999-99-99",
];

/** One instant around `base`: the same moment at another offset, shifted by an edge, a fraction
 * beyond the millisecond, now and then no time at all. */
const arbAround = (base: number): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.constantFrom(...DELTAS),
      fc.constantFrom(...OFFSETS),
      fc.constantFrom(...DIGITS),
      fc.constantFrom(...EXTRAS),
      fc.boolean(),
    )
    .map(([delta, offset, digits, extra, subMillisecond]) => {
      const text = instantAt(base + delta, offset, subMillisecond ? 3 : digits);
      return subMillisecond ? text.replace(/(\.\d+)(Z|[+-]\d\d:\d\d)$/, `$1${extra}$2`) : text;
    });

const arbGarbage = fc.constantFrom(...GARBAGE).filter((text) => Number.isNaN(Date.parse(text)));

const arbTime = (base: number, garbage: number): fc.Arbitrary<string> =>
  fc.oneof(
    { weight: 100 - garbage, arbitrary: arbAround(base) },
    { weight: garbage, arbitrary: arbGarbage },
  );

// ---------------------------------------------------------------------------------------------
// selectBookingPolicy
// ---------------------------------------------------------------------------------------------

const arbCapabilityShape = fc.constantFrom(
  "ok",
  "ok",
  "ok",
  "ok",
  "ok",
  "status",
  "method",
  "scope",
  "version",
  "version",
  "evidence",
  "several",
);

/** The book and scope key of the fact a set of policies is asked about: most of the policies
 * are for them, so that several often match. */
interface Hint {
  readonly bookId: string;
  readonly scopeKey: string;
}

const arbHint: fc.Arbitrary<Hint> = fc.record({
  bookId: fc.constantFrom(...BOOKS),
  scopeKey: fc.constantFrom(...SCOPE_KEYS),
});

function arbPolicySpec(base: number, hint: Hint): fc.Arbitrary<PolicySpec> {
  return fc
    .tuple(
      fc.record({
        id: fc.constantFrom("p1", "p2", "p3", "policy-a"),
        bookId: fc.oneof(
          { weight: 8, arbitrary: fc.constant(hint.bookId) },
          { weight: 2, arbitrary: fc.constantFrom(...BOOKS) },
        ),
        version: fc.constantFrom("1.0.0", "1.1.0", "2.0.0"),
        validFrom: arbTime(base, 3),
        validTo: fc.option(arbTime(base, 6), { nil: undefined, freq: 3 }),
        lotSelection: fc.constantFrom(...METHODS),
        scope: fc.constantFrom(...SCOPES),
        scopeKey: fc.oneof(
          { weight: 8, arbitrary: fc.constant(hint.scopeKey) },
          { weight: 2, arbitrary: fc.constantFrom(...SCOPE_KEYS) },
        ),
        requiredDimensionIds: fc.array(arbIdentifierText, { maxLength: 3 }),
        implementationVersion: fc.constantFrom(...IMPLEMENTATIONS),
      }),
      arbCapabilityShape,
      fc.record({
        id: fc.constantFrom("cap-1", "cap-2"),
        method: fc.constantFrom(...METHODS),
        scope: fc.constantFrom(...SCOPES),
        status: fc.constantFrom(...STATUSES),
        implementationVersion: fc.constantFrom(...IMPLEMENTATIONS),
        evidence: fc.array(fc.constantFrom("ev-1", "ev-2", "ev-3"), { maxLength: 3 }),
      }),
    )
    .map(([policy, shape, other]): PolicySpec => {
      const good = {
        id: other.id,
        method: policy.lotSelection,
        scope: policy.scope,
        status: "supported" as const,
        implementationVersion: policy.implementationVersion,
        verificationEvidenceIds: other.evidence.length === 0 ? ["ev-1"] : other.evidence,
      };
      const capability =
        shape === "ok"
          ? good
          : shape === "status"
            ? {
                ...good,
                status: other.status === "supported" ? ("experimental" as const) : other.status,
              }
            : shape === "method"
              ? {
                  ...good,
                  method: METHODS[
                    (METHODS.indexOf(policy.lotSelection) + 1) % 5
                  ] as LotSelectionMethod,
                }
              : shape === "scope"
                ? { ...good, scope: SCOPES[(SCOPES.indexOf(policy.scope) + 1) % 3] as PolicyScope }
                : shape === "version"
                  ? { ...good, implementationVersion: `${policy.implementationVersion}-x` }
                  : shape === "evidence"
                    ? { ...good, verificationEvidenceIds: [] }
                    : {
                        ...good,
                        status: "unsupported" as const,
                        method: other.method,
                        scope: other.scope,
                        verificationEvidenceIds: [],
                      };
      return { ...policy, capability };
    });
}

interface SelectCase {
  readonly policies: BookingPolicy[];
  readonly fact: {
    readonly bookId: string;
    readonly governedAt: string;
    readonly scopeKey: string;
  };
}

const arbSelectCase: fc.Arbitrary<SelectCase> = fc
  .tuple(fc.integer({ min: 946_684_800_000, max: 2_000_000_000_000 }), arbHint)
  .chain(([base, hint]) =>
    fc.record({
      policies: fc.array(arbPolicySpec(base, hint).map(mkPolicy), { minLength: 0, maxLength: 6 }),
      fact: fc.record({
        bookId: fc.constant(hint.bookId),
        governedAt: arbTime(base, 3),
        scopeKey: fc.constant(hint.scopeKey),
      }),
    }),
  );

const describeSelect = (c: SelectCase) =>
  clip(
    `fact ${JSON.stringify(c.fact)}; policies ${c.policies
      .map((policy) =>
        JSON.stringify({
          id: policy.id,
          bookId: policy.bookId,
          version: policy.version,
          from: policy.validFrom,
          to: policy.validTo,
          scopeKey: policy.scopeKey,
          capability: capabilityFailures(policy),
        }),
      )
      .join(", ")}`,
  );

const tsSelect = (c: SelectCase): OracleOutcome<Record<string, unknown>> =>
  runTs((): Record<string, unknown> => {
    const result = selectBookingPolicy(c.policies, c.fact as never);
    return result.disposition === "resolved"
      ? { disposition: "resolved", policy: bookingPolicyWire(result.policy) }
      : { disposition: "rejected", diagnostics: result.diagnostics.map(diagnosticWire) };
  });

const selectArgs = (c: SelectCase) => [
  c.policies.map(bookingPolicyWire),
  {
    bookId: textToWire(c.fact.bookId),
    governedAt: textToWire(c.fact.governedAt),
    scopeKey: textToWire(c.fact.scopeKey),
  },
];

const BASE = 1_717_200_000_000; // 2024-06-01T00:00:00Z

const coherent = (overrides: Partial<PolicySpec> = {}): BookingPolicy =>
  mkPolicy({
    id: "p1",
    bookId: "book-a",
    version: "1.0.0",
    validFrom: instantAt(BASE, 0, 3),
    validTo: undefined,
    lotSelection: "fifo",
    scope: "account",
    scopeKey: "acct-1",
    requiredDimensionIds: [],
    implementationVersion: "1.0.0",
    capability: {
      id: "cap-1",
      method: "fifo",
      scope: "account",
      status: "supported",
      implementationVersion: "1.0.0",
      verificationEvidenceIds: ["ev-1"],
    },
    ...overrides,
  });

const factAt = (governedAt: string) => ({ bookId: "book-a", governedAt, scopeKey: "acct-1" });

const selectExamples: [SelectCase][] = [
  [{ policies: [], fact: factAt(instantAt(BASE, 0, 0)) }],
  [{ policies: [coherent()], fact: factAt(instantAt(BASE, 0, 0)) }],
  [{ policies: [coherent()], fact: factAt(instantAt(BASE - 1, 0, 3)) }],
  [
    {
      policies: [coherent({ validTo: instantAt(BASE + 1000, 0, 0) })],
      fact: factAt(instantAt(BASE + 1000, 0, 0)),
    },
  ],
  [
    {
      policies: [coherent({ validTo: instantAt(BASE + 1000, 0, 0) })],
      fact: factAt(instantAt(BASE + 999, 0, 3)),
    },
  ],
  [{ policies: [coherent(), coherent({ id: "p2" })], fact: factAt(instantAt(BASE, 0, 0)) }],
  [
    {
      policies: [
        coherent({ validTo: instantAt(BASE, 60, 0) }),
        coherent({ id: "p2", validFrom: instantAt(BASE, 60, 0) }),
      ],
      fact: factAt(instantAt(BASE, 0, 0)),
    },
  ],
  [
    {
      policies: [
        coherent({
          capability: {
            id: "cap-1",
            method: "fifo",
            scope: "account",
            status: "experimental",
            implementationVersion: "1.0.0",
            verificationEvidenceIds: ["ev-1"],
          },
        }),
      ],
      fact: factAt(instantAt(BASE, 0, 0)),
    },
  ],
  [{ policies: [coherent({ validFrom: "garbage" })], fact: factAt(instantAt(BASE, 0, 0)) }],
  [
    {
      policies: [coherent({ bookId: "book-b", validFrom: "garbage" })],
      fact: factAt(instantAt(BASE, 0, 0)),
    },
  ],
  [
    {
      policies: [coherent({ validFrom: instantAt(BASE + 5000, 0, 0), validTo: "garbage" })],
      fact: factAt(instantAt(BASE, 0, 0)),
    },
  ],
  [{ policies: [coherent({ validTo: "garbage" })], fact: factAt(instantAt(BASE, 0, 0)) }],
  [{ policies: [coherent()], fact: factAt("garbage") }],
  [
    {
      policies: [coherent({ validFrom: "2020-01-01T00:00:00.0123456789Z" })],
      fact: factAt("2020-01-01T00:00:00.05Z"),
    },
  ],
];

// ---------------------------------------------------------------------------------------------
// Canonical values and hashes
// ---------------------------------------------------------------------------------------------

/** Texts whose order as UTF-16 code units differs from their order as code points. */
const TRICKY = [
  "a",
  "A",
  "b",
  "\uffff",
  "\ue000",
  "\u{10000}",
  "\u{1f600}",
  "\u{10ffff}",
  "\ud7ff",
  "a@1",
  "a@",
  "a@1.0.0",
  chr(0xe9),
  chr(0x65, 0x301),
];

const arbText: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: arbIdentifierText },
  { weight: 2, arbitrary: fc.constantFrom(...TRICKY) },
  { weight: 2, arbitrary: arbNoise },
);

const arbVersion: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.constantFrom("1.0.0", "1.0.1", "1.10.0", "1.2.0", "2.0.0-rc.1", "0.0.0"),
  },
  {
    weight: 1,
    arbitrary: fc
      .tuple(fc.nat(30), fc.nat(30), fc.nat(30))
      .map(([major, minor, patch]) => `${major}.${minor}.${patch}`),
  },
);

const arbHashPolicySpec: fc.Arbitrary<PolicySpec> = fc
  .tuple(
    fc.record({
      id: fc.oneof(
        { weight: 3, arbitrary: fc.constantFrom("p1", "p2", "a", "a@1", "a@1.0.0") },
        { weight: 2, arbitrary: arbText },
      ),
      bookId: fc.oneof(fc.constantFrom(...BOOKS), arbText),
      version: arbVersion,
      validFrom: arbValidInstant,
      validTo: fc.option(arbValidInstant, { nil: undefined }),
      lotSelection: fc.constantFrom(...METHODS),
      scope: fc.constantFrom(...SCOPES),
      scopeKey: arbText,
      requiredDimensionIds: fc.array(arbText, { maxLength: 4 }),
      implementationVersion: arbVersion,
    }),
    fc.record({
      id: arbText,
      method: fc.constantFrom(...METHODS),
      scope: fc.constantFrom(...SCOPES),
      status: fc.constantFrom(...STATUSES),
      implementationVersion: arbVersion,
      verificationEvidenceIds: fc.array(arbText, { maxLength: 4 }),
    }),
  )
  .map(([policy, capability]): PolicySpec => ({ ...policy, capability }));

const arbHashPolicy = arbHashPolicySpec.map(mkPolicy);

const arbContentHash = fc.record({
  algorithm: fc.oneof(
    { weight: 3, arbitrary: fc.constant("sha256") },
    { weight: 1, arbitrary: arbNoise },
  ),
  canonicalizationVersion: fc.oneof(
    { weight: 3, arbitrary: fc.constant("rastrata-canonical-v1") },
    { weight: 1, arbitrary: arbNoise },
  ),
  digest: fc.oneof(
    {
      weight: 3,
      arbitrary: fc
        .array(fc.constantFrom("0", "1", "a", "f"), { minLength: 8, maxLength: 64 })
        .map((chars) => chars.join("")),
    },
    { weight: 1, arbitrary: arbNoise },
  ),
});

const arbEvidence: fc.Arbitrary<SourceEvidence> = fc
  .record({
    id: fc.oneof(
      { weight: 3, arbitrary: fc.constantFrom("e1", "e2", "e3", "e@1") },
      { weight: 2, arbitrary: arbText },
    ),
    sourceSystem: fc.oneof(fc.constantFrom("bank", "stripe"), arbNoise),
    sourceRecordId: arbNoise,
    observedAt: arbValidInstant,
    contentHash: arbContentHash,
  })
  .map((evidence) => evidence as unknown as SourceEvidence);

const arbDerivation: fc.Arbitrary<DerivationRecord> = fc
  .tuple(
    fc.record({
      id: arbText,
      policyId: arbText,
      policyVersion: arbVersion,
      algorithmVersion: arbVersion,
      inputHash: arbContentHash,
      actorId: arbText,
      state: fc.constantFrom("proposed", "approved", "rejected", "applied"),
      recordedAt: arbValidInstant,
    }),
    fc.array(arbEvidence, { maxLength: 5 }),
    fc.boolean(),
  )
  .map(([derivation, evidence, duplicate]) => {
    // An item of evidence twice, exactly, now and then: equal keys for the sort.
    const list =
      duplicate && evidence.length > 0 ? [...evidence, evidence[0] as SourceEvidence] : evidence;
    return { ...derivation, evidence: list } as unknown as DerivationRecord;
  });

// ---------------------------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------------------------

describe("Policy Lean oracle equivalence", () => {
  let oracle: OracleClient;

  beforeAll(() => {
    oracle = OracleClient.start(process.env.ORACLE_BINARY);
  });

  afterAll(async () => {
    await oracle.close();
    printCounts();
  });

  // -------------------------------------------------------------------------------------------
  // selectBookingPolicy
  // -------------------------------------------------------------------------------------------

  /** How each policy relates to the fact, by this test's own reading, so that the generator is seen
   * to put every test of the filter to work. */
  function tallyRelations(c: SelectCase): void {
    const at = Date.parse(c.fact.governedAt);
    for (const policy of c.policies) {
      if (policy.bookId !== c.fact.bookId) count("relation: another book");
      else if (policy.scopeKey !== c.fact.scopeKey) count("relation: another scope key");
      else if (Number.isNaN(at) || Number.isNaN(Date.parse(policy.validFrom)))
        count("relation: an unreadable time");
      else if (Date.parse(policy.validFrom) > at) count("relation: not yet started");
      else if (policy.validTo === undefined) count("relation: started, no end");
      else if (Number.isNaN(Date.parse(policy.validTo))) count("relation: an unreadable end");
      else if (at < Date.parse(policy.validTo)) count("relation: started, not ended");
      else count("relation: ended");
    }
  }

  /** The policies the TypeScript's filter lets through, read by this test. */
  const matchesOf = (c: SelectCase): BookingPolicy[] =>
    c.policies.filter(
      (policy) =>
        policy.bookId === c.fact.bookId &&
        policy.scopeKey === c.fact.scopeKey &&
        Date.parse(policy.validFrom) <= Date.parse(c.fact.governedAt) &&
        (policy.validTo === undefined ||
          Date.parse(c.fact.governedAt) < Date.parse(policy.validTo)),
    );

  const tallySelect = (c: SelectCase, outcome: OracleOutcome<Record<string, unknown>>) => {
    tallyRelations(c);
    if (outcome.kind === "error") {
      count("select: unreadable time");
      return;
    }
    if (outcome.value.disposition === "resolved") {
      count("select: resolved");
      return;
    }
    const diagnostics = outcome.value.diagnostics as { path: string }[];
    if (diagnostics[0]?.path === textToWire("policies.capability")) {
      count("select: rejected, capability");
      for (const failure of capabilityFailures(matchesOf(c)[0] as BookingPolicy)) {
        count(`select: capability fails on ${failure}`);
      }
    } else {
      count(matchesOf(c).length === 0 ? "select: found none" : "select: found several");
    }
  };

  test(
    "selectBookingPolicy matches Lean",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbSelectCase, async (c) => {
          const tsOutcome = tsSelect(c);
          const leanOutcome = await oracle.call<Record<string, unknown>>(
            "policy.selectBookingPolicy",
            selectArgs(c),
          );
          assertSame("policy.selectBookingPolicy", describeSelect(c), tsOutcome, leanOutcome);
          count("selectBookingPolicy");
          tallySelect(c, tsOutcome);
        }),
        { seed: SEED, numRuns: NUM_RUNS * 8 + selectExamples.length, examples: selectExamples },
      );
      for (const name of [
        "select: resolved",
        "select: found none",
        "select: found several",
        "select: rejected, capability",
        "select: unreadable time",
        "select: capability fails on status",
        "select: capability fails on method",
        "select: capability fails on scope",
        "select: capability fails on version",
        "select: capability fails on evidence",
        "relation: another book",
        "relation: another scope key",
        "relation: not yet started",
        "relation: started, no end",
        "relation: started, not ended",
        "relation: ended",
        "relation: an unreadable time",
        "relation: an unreadable end",
      ]) {
        expect(counted(name)).toBeGreaterThanOrEqual(100);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "selectBookingPolicy matches Lean at every edge of a validity, the times written every way",
    async () => {
      // One policy, a fact at the same scope: every start and end, and every governed time, from
      // a millisecond either side of the edges to a year either side.
      const starts: (number | undefined)[] = [
        ...DELTAS.filter((delta, index) => DELTAS.indexOf(delta) === index),
      ];
      const ends: (number | undefined)[] = [undefined, ...starts];
      let turn = 0;
      let resolved = 0;
      const total = await sweep(
        oracle,
        "policy.selectBookingPolicy",
        "selectBookingPolicy: every edge",
        (function* (): Generator<SweepCase> {
          for (const start of starts as number[]) {
            for (const end of ends) {
              for (const at of starts as number[]) {
                turn++;
                const offsetOf = (k: number) => OFFSETS[(turn + k) % OFFSETS.length] as number;
                const digitsOf = (k: number) => DIGITS[(turn * 3 + k) % DIGITS.length] as number;
                const c: SelectCase = {
                  policies: [
                    coherent({
                      validFrom: instantAt(BASE + start, offsetOf(1), digitsOf(1)),
                      validTo:
                        end === undefined
                          ? undefined
                          : instantAt(BASE + end, offsetOf(2), digitsOf(2)),
                    }),
                  ],
                  fact: factAt(instantAt(BASE + at, offsetOf(3), digitsOf(3))),
                };
                yield { args: selectArgs(c), ts: () => tsSelect(c), show: () => describeSelect(c) };
              }
            }
          }
        })(),
        (outcome) => {
          if (
            outcome.kind === "ok" &&
            (outcome.value as { disposition: string }).disposition === "resolved"
          )
            resolved++;
        },
      );
      expect(total).toBe(starts.length * ends.length * starts.length);
      expect(resolved).toBeGreaterThan(1000);
      expect(total - resolved).toBeGreaterThan(1000);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "selectBookingPolicy does not depend on the order of the policies, in both",
    async () => {
      // The same policies in another order resolve to the same policy, or are refused for the same
      // reason. (When two of them have a time `Date.parse` cannot read, the error names the first
      // that is read, which is the first in the order given: the two sides agree on that too.)
      const arbOrderCase = fc
        .tuple(fc.integer({ min: 946_684_800_000, max: 2_000_000_000_000 }), arbHint)
        .chain(([base, hint]) =>
          fc
            .array(arbPolicySpec(base, hint).map(mkPolicy), { minLength: 2, maxLength: 5 })
            .chain((policies) =>
              fc.record({
                policies: fc.constant(policies),
                shuffled: fc.shuffledSubarray(policies, {
                  minLength: policies.length,
                  maxLength: policies.length,
                }),
                fact: fc.record({
                  bookId: fc.constant(hint.bookId),
                  governedAt: arbAround(base),
                  scopeKey: fc.constant(hint.scopeKey),
                }),
              }),
            ),
        );
      const verdict = (outcome: OracleOutcome<Record<string, unknown>>) =>
        outcome.kind === "error"
          ? outcome.code
          : (outcome.value as { disposition: string }).disposition === "resolved"
            ? JSON.stringify((outcome.value as { policy: unknown }).policy)
            : JSON.stringify((outcome.value as { diagnostics: unknown }).diagnostics);
      await fc.assert(
        fc.asyncProperty(arbOrderCase, async ({ policies, shuffled, fact }) => {
          const left: SelectCase = { policies, fact };
          const right: SelectCase = { policies: shuffled, fact };
          const tsLeft = tsSelect(left);
          const tsRight = tsSelect(right);
          expect(tsLeft.kind).toBe(tsRight.kind);
          if (tsLeft.kind === "ok") {
            expect(verdict(tsLeft)).toBe(verdict(tsRight));
            count("selectBookingPolicy: another order, the same answer");
          }
          for (const c of [left, right]) {
            const leanOutcome = await oracle.call<Record<string, unknown>>(
              "policy.selectBookingPolicy",
              selectArgs(c),
            );
            assertSame("policy.selectBookingPolicy", describeSelect(c), tsSelect(c), leanOutcome);
          }
          count("selectBookingPolicy: orders");
        }),
        { seed: SEED + 3, numRuns: NUM_RUNS },
      );
      expect(counted("selectBookingPolicy: another order, the same answer")).toBeGreaterThanOrEqual(
        100,
      );
      expect(counted("selectBookingPolicy: orders")).toBeGreaterThanOrEqual(NUM_RUNS);
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------------------------
  // canonicalPolicyValue
  // -------------------------------------------------------------------------------------------

  test(
    "canonicalPolicyValue matches Lean",
    async () => {
      const examples: [BookingPolicy][] = [
        [coherent()],
        [
          coherent({
            validTo: instantAt(BASE, 0, 0),
            requiredDimensionIds: ["b", "a", "\u{10000}", "\uffff", "a"],
          }),
        ],
        [coherent({ requiredDimensionIds: [] })],
        [
          coherent({
            capability: {
              id: "c",
              method: "hifo",
              scope: "legalEntity",
              status: "unsupported",
              implementationVersion: "0.0.0",
              verificationEvidenceIds: ["z", "y", "\ue000", "\u{1f600}"],
            },
          }),
        ],
      ];
      await fc.assert(
        fc.asyncProperty(arbHashPolicy, async (policy) => {
          const tsOutcome = runTs(() => valueWire(canonicalPolicyValue(policy)));
          const leanOutcome = await oracle.call<unknown>("policy.canonicalPolicyValue", [
            bookingPolicyWire(policy),
          ]);
          assertSame(
            "policy.canonicalPolicyValue",
            clip(JSON.stringify(bookingPolicyWire(policy))),
            tsOutcome,
            leanOutcome,
          );
          count("canonicalPolicyValue");
          count(
            policy.validTo === undefined
              ? "canonicalPolicyValue: no validTo"
              : "canonicalPolicyValue: validTo",
          );
          if (policy.requiredDimensionIds.length >= 2)
            count("canonicalPolicyValue: dimensions sorted");
          if (policy.capability.verificationEvidenceIds.length >= 2)
            count("canonicalPolicyValue: evidence sorted");
        }),
        { seed: SEED, numRuns: NUM_RUNS + examples.length, examples },
      );
      for (const name of [
        "canonicalPolicyValue: no validTo",
        "canonicalPolicyValue: validTo",
        "canonicalPolicyValue: dimensions sorted",
        "canonicalPolicyValue: evidence sorted",
      ]) {
        expect(counted(name)).toBeGreaterThanOrEqual(100);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------------------------
  // hashPolicySnapshot
  // -------------------------------------------------------------------------------------------

  test(
    "hashPolicySnapshot matches Lean, and the same policies in any order have one hash",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(arbHashPolicy, { minLength: 0, maxLength: 6 }).chain((policies) =>
            fc.tuple(
              fc.constant(policies),
              fc.shuffledSubarray(policies, {
                minLength: policies.length,
                maxLength: policies.length,
              }),
              fc.shuffledSubarray(policies, {
                minLength: policies.length,
                maxLength: policies.length,
              }),
              fc.boolean(),
            ),
          ),
          async ([policies, first, second, duplicate]) => {
            // Now and then a policy twice, exactly: equal keys for the sort.
            const list =
              duplicate && policies.length > 0
                ? [...policies, policies[0] as BookingPolicy]
                : policies;
            const orders = [
              list,
              first,
              second.length > 0 && duplicate ? [...second, second[0] as BookingPolicy] : second,
            ];
            const hashes: string[] = [];
            for (const order of orders) {
              const tsOutcome = runTs(() => hashWire(hashPolicySnapshot(order)));
              const leanOutcome = await oracle.call<ReturnType<typeof hashWire>>(
                "policy.hashPolicySnapshot",
                [order.map(bookingPolicyWire)],
              );
              assertSame(
                "policy.hashPolicySnapshot",
                clip(JSON.stringify(order.map(bookingPolicyWire))),
                tsOutcome,
                leanOutcome,
              );
              if (tsOutcome.kind === "ok")
                hashes.push((tsOutcome.value as { digest: string }).digest);
              count("hashPolicySnapshot");
            }
            // Orders with the same policies, with the same number of copies, have one hash.
            if (orders[0]?.length === orders[1]?.length) {
              expect(hashes[0]).toBe(hashes[1]);
              count("hashPolicySnapshot: another order, the same hash");
            }
            count(
              policies.length === 0
                ? "hashPolicySnapshot: no policies"
                : policies.length === 1
                  ? "hashPolicySnapshot: one policy"
                  : "hashPolicySnapshot: several policies",
            );
          },
        ),
        { seed: SEED, numRuns: NUM_RUNS },
      );
      for (const name of [
        "hashPolicySnapshot: another order, the same hash",
        "hashPolicySnapshot: no policies",
        "hashPolicySnapshot: one policy",
        "hashPolicySnapshot: several policies",
      ]) {
        expect(counted(name)).toBeGreaterThanOrEqual(100);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "hashPolicySnapshot matches Lean for policies that share an identity, or whose identities are prefixes of each other",
    async () => {
      const ids = ["a", "a@1", "a@1.0.0", "a@1.0.0:", "b", "\u{10000}", "\uffff", "\ue000"];
      const versions = ["1.0.0", "1.0.1", "10.0.0"];
      const policies: BookingPolicy[] = [];
      for (const id of ids) {
        for (const version of versions) {
          policies.push(coherent({ id, version }));
        }
      }
      // The same identity with different content.
      policies.push(coherent({ id: "a", version: "1.0.0", scopeKey: "other" }));
      policies.push(coherent({ id: "a", version: "1.0.0", validTo: instantAt(BASE, 0, 0) }));
      let total = 0;
      for (let turn = 0; turn < 600; turn++) {
        const size = 2 + (turn % 5);
        const picked: BookingPolicy[] = [];
        for (let index = 0; index < size; index++) {
          picked.push(
            policies[
              (turn * 7 + index * 13 + (turn % 3) * index) % policies.length
            ] as BookingPolicy,
          );
        }
        const tsOutcome = runTs(() => hashWire(hashPolicySnapshot(picked)));
        const leanOutcome = await oracle.call<ReturnType<typeof hashWire>>(
          "policy.hashPolicySnapshot",
          [picked.map(bookingPolicyWire)],
        );
        assertSame(
          "policy.hashPolicySnapshot",
          clip(JSON.stringify(picked.map((policy) => `${policy.id}@${policy.version}`))),
          tsOutcome,
          leanOutcome,
        );
        total++;
      }
      count("hashPolicySnapshot: identities", total);
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------------------------
  // canonicalDerivationValue
  // -------------------------------------------------------------------------------------------

  test(
    "canonicalDerivationValue matches Lean",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbDerivation, async (derivation) => {
          const tsOutcome = runTs(() => valueWire(canonicalDerivationValue(derivation)));
          const leanOutcome = await oracle.call<unknown>("policy.canonicalDerivationValue", [
            derivationWire(derivation),
          ]);
          assertSame(
            "policy.canonicalDerivationValue",
            clip(JSON.stringify(derivationWire(derivation))),
            tsOutcome,
            leanOutcome,
          );
          count("canonicalDerivationValue");
          count(
            derivation.evidence.length === 0
              ? "derivation: no evidence"
              : derivation.evidence.length === 1
                ? "derivation: one item"
                : "derivation: several items",
          );
          if (
            new Set(derivation.evidence.map((evidence) => evidence.id)).size <
            derivation.evidence.length
          ) {
            count("derivation: an identifier twice");
          }
        }),
        { seed: SEED, numRuns: NUM_RUNS + 1 },
      );
      for (const name of [
        "derivation: no evidence",
        "derivation: one item",
        "derivation: several items",
        "derivation: an identifier twice",
      ]) {
        expect(counted(name)).toBeGreaterThanOrEqual(100);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test("the TypeScript gives policies that differ only in a lone surrogate one snapshot hash and one canonical value", () => {
    // The model's laws that a hash determines its policies (`hashPolicySnapshot_inj_or_collision`,
    // `canonicalPolicyValue_eq_iff`) are about policies whose texts are strings of scalar values.
    // JavaScript's `TextEncoder` writes a lone surrogate as U+FFFD, so for the TypeScript these three
    // policies, all different, are one: the same snapshot hash and the same encoded bytes.
    const high = coherent({ scopeKey: String.fromCharCode(0xd800) });
    const low = coherent({ scopeKey: String.fromCharCode(0xdc00) });
    const replacement = coherent({ scopeKey: chr(0xfffd) });
    expect(new Set([high.scopeKey, low.scopeKey, replacement.scopeKey]).size).toBe(3);
    const digests = [high, low, replacement].map((policy) => hashPolicySnapshot([policy]).digest);
    expect(new Set(digests).size).toBe(1);
    count("pinned: lone surrogates in a policy hash");
  });

  // -------------------------------------------------------------------------------------------
  // What the model's notes say the TypeScript does, said of the TypeScript alone
  // -------------------------------------------------------------------------------------------

  test("the TypeScript does what the model's notes on policy resolution say", () => {
    const exampleSpec = (validFrom: string, validTo: string | undefined): BookingPolicy =>
      mkPolicy({
        id: "policy",
        bookId: "book",
        version: "1.0.0",
        validFrom,
        validTo,
        lotSelection: "fifo",
        scope: "legalEntity",
        scopeKey: "scope",
        requiredDimensionIds: [],
        implementationVersion: "1.0.0",
        capability: {
          id: "capability",
          method: "fifo",
          scope: "legalEntity",
          status: "supported",
          implementationVersion: "1.0.0",
          verificationEvidenceIds: ["evidence"],
        },
      });
    const fact = (governedAt: string) => ({ bookId: "book", governedAt, scopeKey: "scope" });
    const found = (outcome: OracleOutcome<Record<string, unknown>>): string =>
      outcome.kind === "error"
        ? outcome.code
        : (outcome.value as { disposition: string }).disposition === "resolved"
          ? "resolved"
          : `rejected: ${String.fromCharCode(
              ...(
                (
                  (outcome.value as { diagnostics: { message: string }[] }).diagnostics[0]
                    ?.message ?? ""
                ).match(/.{4}/g) ?? []
              ).map((unit) => Number.parseInt(unit, 16)),
            )}`;
    // A policy governs a fact from 0.8 of a millisecond before it starts.
    expect(
      found(
        tsSelect({
          policies: [exampleSpec("2024-01-01T00:00:00.0009Z", undefined)],
          fact: fact("2024-01-01T00:00:00.0001Z"),
        }),
      ),
    ).toBe("resolved");
    // It does not govern a fact from more than 37 milliseconds after it starts: found 0.
    expect(
      found(
        tsSelect({
          policies: [exampleSpec("2020-01-01T00:00:00.0123456789Z", undefined)],
          fact: fact("2020-01-01T00:00:00.05Z"),
        }),
      ),
    ).toBe(
      "rejected: Expected exactly one applicable policy at the governed economic time; found 0",
    );
    // It governs a fact from more than 37 milliseconds after it ended.
    expect(
      found(
        tsSelect({
          policies: [exampleSpec("2020-01-01T00:00:00Z", "2020-01-01T00:00:00.0123456789Z")],
          fact: fact("2020-01-01T00:00:00.05Z"),
        }),
      ),
    ).toBe("resolved");
    // Two policies that follow one another at a moment written two ways both govern a fact
    // between the two readings: found 2.
    expect(
      found(
        tsSelect({
          policies: [
            exampleSpec("2020-01-01T00:00:00Z", "2020-01-01T00:00:00.0123456789Z"),
            exampleSpec("2020-01-01T00:00:00.012Z", undefined),
          ],
          fact: fact("2020-01-01T00:00:00.05Z"),
        }),
      ),
    ).toBe(
      "rejected: Expected exactly one applicable policy at the governed economic time; found 2",
    );
    count("pinned: policy resolution");
  });

  // -------------------------------------------------------------------------------------------
  // Known differences. Each of these fails today, and is marked so: when the model or the
  // TypeScript changes and one of them starts to pass, the suite fails and says which.
  // -------------------------------------------------------------------------------------------

  describe("known differences between the model and the TypeScript", () => {
    const lone = String.fromCharCode(0xd800);

    // INPUT CLASS THE MODEL CANNOT REPRESENT (kind c). A JavaScript string may hold a lone
    // surrogate and the canonical encoding writes it as U+FFFD, so two policies that differ only in
    // a lone surrogate have one hash (`canonical.test.ts` pins this for the encoder). The model's
    // `String` has no lone surrogate, so it has no policy to give.
    test.failing("canonicalPolicyValue: the TypeScript takes a lone surrogate in the scope key, the model has no such string", async () => {
      const policy = coherent({ scopeKey: lone });
      assertSame(
        "policy.canonicalPolicyValue",
        showText(lone),
        runTs(() => valueWire(canonicalPolicyValue(policy))),
        await oracle.call("policy.canonicalPolicyValue", [bookingPolicyWire(policy)]),
      );
    });

    test.failing("hashPolicySnapshot: the TypeScript hashes a lone surrogate in a policy, the model has no such string", async () => {
      const policy = coherent({ scopeKey: lone });
      assertSame(
        "policy.hashPolicySnapshot",
        showText(lone),
        runTs(() => hashWire(hashPolicySnapshot([policy]))),
        await oracle.call("policy.hashPolicySnapshot", [[bookingPolicyWire(policy)]]),
      );
    });

    // INPUT CLASS THE MODEL CANNOT REPRESENT (kind c). `Date.parse` reads a date without a time;
    // an `Instant` never is one. The model's `instantMillis` (`Policy/Types.lean` line 540) answers
    // the `RangeError` for it.
    test.failing("selectBookingPolicy: Date.parse reads a date without a time, which is not an Instant, and the model refuses it", async () => {
      const c: SelectCase = {
        policies: [coherent({ validFrom: "2024-01-01" })],
        fact: factAt(instantAt(BASE, 0, 0)),
      };
      const tsOutcome = tsSelect(c);
      expect(tsOutcome.kind).toBe("ok");
      assertSame(
        "policy.selectBookingPolicy",
        describeSelect(c),
        tsOutcome,
        await oracle.call("policy.selectBookingPolicy", selectArgs(c)),
      );
    });

    // INPUT CLASS THE MODEL CANNOT REPRESENT (kind c). A union of string literals in the
    // TypeScript is a type; at run time the code takes any string. The model has the five lot
    // selection methods, the three scopes and the three capability statuses and no other value
    // (`Policy/Types.lean` lines 126, 135 and 142), so a policy whose method, scope or status is
    // something else has no model: `canonicalPolicyValue` writes the string as it is, and
    // `selectBookingPolicy` refuses a status that is not `supported` as a capability that is not
    // executable, for any other string as for `experimental`.
    test.failing("canonicalPolicyValue: the TypeScript writes a lot selection method outside the five, the model has none", async () => {
      const policy = coherent({ lotSelection: "average" as never });
      const tsOutcome = runTs(() => valueWire(canonicalPolicyValue(policy)));
      expect(tsOutcome.kind).toBe("ok");
      assertSame(
        "policy.canonicalPolicyValue",
        showText("average"),
        tsOutcome,
        await oracle.call("policy.canonicalPolicyValue", [bookingPolicyWire(policy)]),
      );
    });

    test.failing("selectBookingPolicy: the TypeScript refuses a capability status outside the three as not executable, the model has none", async () => {
      const policy = coherent({
        capability: {
          id: "cap-1",
          method: "fifo",
          scope: "account",
          status: "retired" as never,
          implementationVersion: "1.0.0",
          verificationEvidenceIds: ["ev-1"],
        },
      });
      const c: SelectCase = { policies: [policy], fact: factAt(instantAt(BASE, 0, 0)) };
      const tsOutcome = tsSelect(c);
      expect(tsOutcome.kind).toBe("ok");
      assertSame(
        "policy.selectBookingPolicy",
        describeSelect(c),
        tsOutcome,
        await oracle.call("policy.selectBookingPolicy", selectArgs(c)),
      );
    });
  });

  test("every function was compared on at least 2,000 generated cases", () => {
    for (const name of [
      "selectBookingPolicy",
      "canonicalPolicyValue",
      "hashPolicySnapshot",
      "canonicalDerivationValue",
    ]) {
      expect(counted(name)).toBeGreaterThanOrEqual(NUM_RUNS);
    }
  });
});

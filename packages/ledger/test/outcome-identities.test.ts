import { expect, test } from "bun:test";
import {
  createBookState,
  createBookProtocolState,
  decodeDurableBook,
  encodeDurableBook,
  decodeBookOutcome,
  encodeBookOutcome,
  encodeBookRow,
  hashCanonical,
  type DurableBookAggregate,
  type BookRowTypes,
} from "@rastrata/kernel";
import {
  prepareOutcomeIdentityDelta,
  decodeRetainedCommandIdentity,
  resolveJournalIdentity,
  resolveAccountingIdentity,
  isAccountingIdentityFamily,
  resolveLotIdentityOrdinal,
  decodeLotIdentityRow,
  isLotIdentityFamily,
  type PriorIdentityEvidence,
} from "../src/outcome-identities.ts";
import { identityIndexKey } from "../src/index-pages.ts";
import type { CanonicalIdentity } from "../src/identity-audit.ts";
import { evaluateOutcomePayload } from "../src/outcome-payload.ts";
import { activation, genesis, posting, BOOK } from "./fixtures.ts";
import {
  allocationAndTaxWorkflow,
  lotIdentityWorkflow,
  workflowValue,
} from "./accounting-workflows.ts";

const row = (
  family: CanonicalIdentity["family"],
  id: string,
  outcomeSequence: bigint,
  bookId: string = BOOK,
): CanonicalIdentity => ({ bookId, family, id, outcomeSequence });
const payloads = () => {
  const active = evaluateOutcomePayload(genesis(), activation());
  const sale = evaluateOutcomePayload(active.transition, posting("same:id/α"));
  const rejected = evaluateOutcomePayload(sale.transition, posting("rejected", 2n, false));
  if (!active.encoded || !sale.encoded || !rejected.encoded)
    throw new Error("Missing fixture outcome");
  return { active: active.encoded, sale: sale.encoded, rejected: rejected.encoded };
};

test("retained command resolution rejects raw identity aliases even when the row bytes are valid", () => {
  const active = evaluateOutcomePayload(genesis(), activation());
  const retained = active.transition.protocol.retainedResults[0];
  if (!retained) throw new Error("Missing retained activation");
  const encoded = encodeBookRow("protocol.retainedResults", retained);
  expect(decodeRetainedCommandIdentity(encoded, BOOK, "activate")).toEqual(retained);
  expect(Object.isFrozen(decodeRetainedCommandIdentity(encoded, BOOK, "activate"))).toBe(true);
  expect(() => decodeRetainedCommandIdentity(encoded, BOOK, "another-command")).toThrow(
    "index_identity_source_mismatch",
  );
  expect(() => decodeRetainedCommandIdentity(encoded, "another-book", "activate")).toThrow(
    "index_identity_source_mismatch",
  );
  for (const value of [
    { ...retained, commandId: "alias" as typeof retained.commandId },
    { ...retained, command: { ...retained.command, id: "alias" as typeof retained.command.id } },
  ]) {
    const bytes = encodeBookRow("protocol.retainedResults", value);
    expect(() => decodeRetainedCommandIdentity(bytes, BOOK, "activate")).toThrow(
      "index_identity_source_mismatch",
    );
  }
  expect(() => decodeRetainedCommandIdentity("{}", BOOK, "activate")).toThrow(
    "source_catalog_row_invalid",
  );
});

test("journal source selection binds raw identity, revision and retained result rather than a digest hit", () => {
  const active = evaluateOutcomePayload(genesis(), activation());
  const sale = evaluateOutcomePayload(active.transition, posting("source-journal"));
  const retained = sale.transition.protocol.retainedResults.at(-1);
  const revision = sale.transition.state.revisions.at(-1);
  const booked = sale.transition.state.journals.at(-1);
  if (!retained || !revision || !booked) throw new Error("Missing source journal");
  const retainedBytes = encodeBookRow("protocol.retainedResults", retained);
  const revisionBytes = encodeBookRow("state.revisions", revision);
  const resolved = resolveJournalIdentity(
    retainedBytes,
    revisionBytes,
    BOOK,
    "journal",
    "source-journal",
  );
  expect(resolved.booked).toEqual(booked);
  expect(resolved.posting).toBeNull();
  expect(Object.isFrozen(resolved)).toBe(true);
  for (const posting of booked.journal.postings)
    expect(
      resolveJournalIdentity(retainedBytes, revisionBytes, BOOK, "posting", posting.id).posting,
    ).toEqual(posting);
  for (const [family, id] of [
    ["journal", "missing"],
    ["posting", "missing"],
    ["journal", "source-journal-0"],
    ["posting", "source-journal"],
  ] as const)
    expect(() => resolveJournalIdentity(retainedBytes, revisionBytes, BOOK, family, id)).toThrow(
      "index_identity_source_mismatch",
    );
  expect(() =>
    resolveJournalIdentity(retainedBytes, revisionBytes, "other-book", "journal", "source-journal"),
  ).toThrow("index_identity_source_mismatch");
  const badRevisions: BookRowTypes["state.revisions"][] = [
    { ...revision, bookRevision: revision.bookRevision + 1n },
    {
      ...revision,
      command: { ...revision.command, id: "other-command" as typeof revision.command.id },
    },
    { ...revision, command: { ...revision.command, inputHash: hashCanonical({ wrong: true }) } },
    { ...revision, effects: [...revision.effects, ...revision.effects] },
    ...[
      { ...booked, commandId: "other-command" as typeof booked.commandId },
      { ...booked, bookRevision: booked.bookRevision + 1n },
      {
        ...booked,
        journal: { ...booked.journal, bookId: "other-book" as typeof booked.journal.bookId },
      },
    ].map((value) => ({ ...revision, effects: [{ type: "journal" as const, booked: value }] })),
  ];
  for (const bad of badRevisions)
    expect(() =>
      resolveJournalIdentity(
        retainedBytes,
        encodeBookRow("state.revisions", bad),
        BOOK,
        "journal",
        "source-journal",
      ),
    ).toThrow("index_identity_source_mismatch");
  const duplicatedPosting = {
    ...booked,
    journal: {
      ...booked.journal,
      postings: [...booked.journal.postings, ...booked.journal.postings],
    },
  };
  expect(() =>
    resolveJournalIdentity(
      retainedBytes,
      encodeBookRow("state.revisions", {
        ...revision,
        effects: [{ type: "journal", booked: duplicatedPosting }],
      }),
      BOOK,
      "posting",
      "source-journal-0",
    ),
  ).toThrow("index_identity_source_mismatch");
  const rejected = evaluateOutcomePayload(
    sale.transition,
    posting("reject-source", 0n),
  ).transition.protocol.retainedResults.at(-1);
  if (!rejected) throw new Error("Missing rejected fixture");
  expect(() =>
    resolveJournalIdentity(
      encodeBookRow("protocol.retainedResults", rejected),
      revisionBytes,
      BOOK,
      "journal",
      "source-journal",
    ),
  ).toThrow("index_identity_source_mismatch");
  expect(() =>
    resolveJournalIdentity("{}", revisionBytes, BOOK, "journal", "source-journal"),
  ).toThrow("source_catalog_row_invalid");
});

test("accounting identity families are the closed thirteen immutable effect types", () => {
  for (const family of [
    "provisionalInventoryLayer",
    "inventoryRecosting",
    "inventoryValueAdjustment",
    "openItem",
    "settlement",
    "settlementAllocation",
    "remeasurementResult",
    "remeasurementReversal",
    "allocationSchedule",
    "allocationRecognition",
    "allocationScheduleRevision",
    "taxDetermination",
    "consolidationCompilation",
  ])
    expect(isAccountingIdentityFamily(family)).toBe(true);
  for (const family of [
    "command",
    "journal",
    "lot",
    "lotHolding",
    "configuration",
    "openingBoundary",
    "constructor",
    "__proto__",
    "toString",
    "",
    null,
    {},
  ])
    expect(isAccountingIdentityFamily(family)).toBe(false);
});

test("accounting source selection rejects identity aliases and duplicate immutable effects", () => {
  const scenario = allocationAndTaxWorkflow("1.1.0");
  let state = scenario.initial;
  for (const command of scenario.commands.slice(0, 3))
    state = evaluateOutcomePayload(state, command).transition;
  const retained = workflowValue(state.protocol.retainedResults.at(-1));
  const revision = workflowValue(state.state.revisions.at(-1));
  const schedule = workflowValue(state.state.accountingState.allocationSchedules[0]);
  const retainedBytes = encodeBookRow("protocol.retainedResults", retained);
  const revisionBytes = encodeBookRow("state.revisions", revision);
  const selected = resolveAccountingIdentity(
    retainedBytes,
    revisionBytes,
    BOOK,
    "allocationSchedule",
    schedule.id,
  );
  expect(selected.value).toEqual(schedule);
  expect(selected.value.sourceBasis).toEqual(schedule.sourceBasis); // Generic result retains the selected family's exact type.
  expect(Object.isFrozen(selected)).toBe(true);
  expect(Object.isFrozen(selected.value)).toBe(true);
  expect(() =>
    resolveAccountingIdentity(retainedBytes, revisionBytes, BOOK, "allocationSchedule", "missing"),
  ).toThrow("index_identity_source_mismatch");
  expect(() =>
    resolveAccountingIdentity(
      retainedBytes,
      revisionBytes,
      BOOK,
      "allocationRecognition",
      schedule.id,
    ),
  ).toThrow("index_identity_source_mismatch");
  expect(() =>
    resolveAccountingIdentity(
      retainedBytes,
      revisionBytes,
      "other-book",
      "allocationSchedule",
      schedule.id,
    ),
  ).toThrow("index_identity_source_mismatch");
  expect(() =>
    resolveAccountingIdentity(
      retainedBytes,
      revisionBytes,
      BOOK,
      "constructor" as "allocationSchedule",
      schedule.id,
    ),
  ).toThrow("index_identity_family_invalid");
  const wrongBook = {
    ...selected,
    value: { ...schedule, bookId: "other-book" as typeof schedule.bookId },
  };
  for (const effects of [[selected, selected], [wrongBook]]) {
    const bytes = encodeBookRow("state.revisions", { ...revision, effects });
    expect(() =>
      resolveAccountingIdentity(retainedBytes, bytes, BOOK, "allocationSchedule", schedule.id),
    ).toThrow("index_identity_source_mismatch");
  }
  expect(() =>
    resolveAccountingIdentity(retainedBytes, "{}", BOOK, "allocationSchedule", schedule.id),
  ).toThrow("source_catalog_row_invalid");
});

test("lot identity resolution distinguishes creation position from a mutable current value", () => {
  const scenario = lotIdentityWorkflow();
  let aggregate = scenario.initial;
  for (const command of scenario.commands)
    aggregate = evaluateOutcomePayload(aggregate, command).transition;
  const retained = workflowValue(aggregate.protocol.retainedResults[1]);
  const revision = workflowValue(aggregate.state.revisions[1]);
  const retainedBytes = encodeBookRow("protocol.retainedResults", retained);
  const revisionBytes = encodeBookRow("state.revisions", revision);
  expect(
    resolveLotIdentityOrdinal(retainedBytes, revisionBytes, BOOK, "lotHolding", scenario.source),
  ).toBe(1n);
  const current = workflowValue(aggregate.state.lotHoldings[0]);
  const decoded = decodeLotIdentityRow(
    encodeBookRow("state.lotHoldings", current),
    BOOK,
    "lotHolding",
    scenario.source,
  );
  expect(decoded.remainingQuantity.toString()).toBe("0/1");
  expect(Object.isFrozen(decoded)).toBe(true);
  expect(() =>
    decodeLotIdentityRow(
      encodeBookRow("state.lotHoldings", current),
      BOOK,
      "lotHolding",
      "different-id",
    ),
  ).toThrow("index_identity_source_mismatch");
  expect(() =>
    decodeLotIdentityRow(
      encodeBookRow("state.lotHoldings", current),
      "another-book",
      "lotHolding",
      scenario.source,
    ),
  ).toThrow("index_identity_source_mismatch");
  expect(() =>
    decodeLotIdentityRow(encodeBookRow("state.lotHoldings", current), BOOK, "lot", scenario.source),
  ).toThrow("source_catalog_row_invalid");
  expect(() =>
    resolveLotIdentityOrdinal(retainedBytes, revisionBytes, BOOK, "lotAllocation", scenario.source),
  ).toThrow("index_identity_source_mismatch");
  const lotState = revision.effects.find((e) => e.type === "lotState");
  if (lotState?.type !== "lotState") throw new Error("Missing lot-state effect");
  const ambiguous = {
    ...revision,
    effects: [
      {
        ...lotState,
        lotState: {
          ...lotState.lotState,
          holdings: [...lotState.lotState.holdings, ...lotState.lotState.holdings],
        },
      },
    ],
  };
  expect(() =>
    resolveLotIdentityOrdinal(
      retainedBytes,
      encodeBookRow("state.revisions", ambiguous),
      BOOK,
      "lotHolding",
      scenario.source,
    ),
  ).toThrow("index_identity_source_mismatch");
  for (const family of ["lot", "lotHolding", "lotAllocation"])
    expect(isLotIdentityFamily(family)).toBe(true);
  for (const family of ["constructor", "__proto__", "journal", null])
    expect(isLotIdentityFamily(family)).toBe(false);
});

test("outcome projection uses actual raw identities and only newly retained IDs, not command-name fixtures", async () => {
  const source = payloads();
  const existing = new Map<string, PriorIdentityEvidence>();
  const expected = [
    [row("command", "activate", 1n), row("openingBoundary", "opening", 1n)],
    [
      row("command", "same:id/α", 2n),
      row("journal", "same:id/α", 2n),
      row("posting", "same:id/α-0", 2n),
      row("posting", "same:id/α-1", 2n),
    ],
    [row("command", "rejected", 3n)],
  ];
  let sequence = 0n;
  for (const encoded of [source.active, source.sale, source.rejected]) {
    sequence++;
    const delta = await prepareOutcomeIdentityDelta(
      encoded,
      BOOK,
      sequence,
      async (key) => existing.get(key) ?? null,
    );
    const exact = expected[Number(sequence - 1n)];
    if (!exact) throw new Error("Missing exact fixture identities");
    expect(delta).toEqual(exact);
    expect(Object.isFrozen(delta) && delta.every(Object.isFrozen)).toBe(true);
    for (const identity of delta)
      existing.set(identityIndexKey(identity), { sequence, encodedOutcome: encoded });
  }
  for (const encoded of [source.active, source.sale, source.rejected])
    await expect(
      prepareOutcomeIdentityDelta(encoded, BOOK, 4n, async (key) => existing.get(key) ?? null),
    ).rejects.toThrow("index_canonical_identity_conflict");
});

test("identity hits require exact original source bytes, scope and an older positive locator", async () => {
  const source = payloads();
  for (const sequence of [0n, -1n, 2n, 3n])
    await expect(
      prepareOutcomeIdentityDelta(source.sale, BOOK, 2n, async () => ({
        sequence,
        encodedOutcome: source.sale,
      })),
    ).rejects.toThrow("index_identity_evidence_invalid");
  await expect(
    prepareOutcomeIdentityDelta(source.sale, BOOK, 2n, async () => ({
      sequence: 1n,
      encodedOutcome: source.active,
    })),
  ).rejects.toThrow("index_identity_source_mismatch");
  await expect(
    prepareOutcomeIdentityDelta(source.sale, "foreign-book", 2n, async () => null),
  ).rejects.toThrow("index_canonical_scope_mismatch");
  await expect(
    prepareOutcomeIdentityDelta(source.sale, BOOK, 2n, async () => ({
      sequence: 1n,
      encodedOutcome: "{broken",
    })),
  ).rejects.toThrow("index_outcome_invalid");
  await expect(
    prepareOutcomeIdentityDelta(source.sale, BOOK, 2n, async () => {
      throw new Error("canonical source unavailable");
    }),
  ).rejects.toThrow("canonical source unavailable");
  for (const sequence of [0n, -1n, 1n << 64n, 1 as unknown as bigint])
    await expect(
      prepareOutcomeIdentityDelta(source.active, BOOK, sequence, async () => null),
    ).rejects.toThrow("index_outcome_sequence_invalid");
  expect(
    (await prepareOutcomeIdentityDelta(source.active, BOOK, (1n << 64n) - 1n, async () => null))[0]
      ?.outcomeSequence,
  ).toBe((1n << 64n) - 1n);
});

test("malformed evidence and accessors fail closed without invoking getters", async () => {
  const source = payloads();
  let reads = 0;
  const invalid: unknown[] = [
    undefined,
    false,
    1,
    "yes",
    {},
    { sequence: 1n },
    { sequence: "1", encodedOutcome: source.active },
    { sequence: 1n, encodedOutcome: source.active, extra: true },
    { sequence: 1n, encodedOutcome: source.active, [Symbol("hidden")]: true },
    {
      get sequence() {
        reads++;
        return 1n;
      },
      encodedOutcome: source.active,
    },
  ];
  for (const evidence of invalid)
    await expect(
      prepareOutcomeIdentityDelta(
        source.sale,
        BOOK,
        2n,
        async () => evidence as PriorIdentityEvidence,
      ),
    ).rejects.toThrow("index_identity_evidence_invalid");
  expect(reads).toBe(0);
});

test("a valid outcome checksum is not accounting authentication", async () => {
  const source = payloads();
  const decoded = decodeBookOutcome(source.active);
  if (decoded.disposition !== "decoded") throw new Error(decoded.message);
  const forged = encodeBookOutcome({
    ...decoded.payload,
    originalResult: {
      ...decoded.payload.originalResult,
      resultHash: hashCanonical("forged-accounting-result"),
    },
  });
  // Deliberately demonstrates the boundary: projection can read this shape, so
  // callers MUST use real ledger evaluation/replay before source admission.
  expect(await prepareOutcomeIdentityDelta(forged, BOOK, 1n, async () => null)).toEqual(
    await prepareOutcomeIdentityDelta(source.active, BOOK, 1n, async () => null),
  );
});

test("real historical lot snapshots keep first creation locators and rejected adjustments add no financial identities", async () => {
  const raw = (
    await Bun.file(
      new URL("../../kernel/test/data/inventory-adjustment-legacy.json", import.meta.url),
    ).text()
  ).trim();
  const decoded = decodeDurableBook(raw);
  if (decoded.disposition !== "decoded") throw new Error(decoded.message);
  const original = decoded.aggregate;
  const config = original.state.configurationSnapshots[0];
  if (!config) throw new Error("Missing fixture configuration");
  let current: DurableBookAggregate = {
    state: createBookState(
      original.state.identity,
      config.periods,
      config.admissionSnapshot,
      config.policies,
      config.quantizationPolicies,
      config.accountingPolicySnapshot.policies,
      config.effectiveAt,
    ),
    protocol: createBookProtocolState(),
  };
  const entries = new Map<string, CanonicalIdentity>();
  const bodies = new Map<bigint, string>();
  let sequence = 0n;
  for (const retained of original.protocol.retainedResults) {
    sequence++;
    const result = evaluateOutcomePayload(current, retained.command);
    if (!result.encoded) throw new Error("Missing retained fixture payload");
    const delta = await prepareOutcomeIdentityDelta(
      result.encoded,
      original.state.identity.bookId,
      sequence,
      async (key) => {
        const found = entries.get(key);
        if (!found) return null;
        const body = bodies.get(found.outcomeSequence);
        if (!body) throw new Error("Missing original source");
        return { sequence: found.outcomeSequence, encodedOutcome: body };
      },
    );
    if (sequence === 3n) {
      expect(delta).toHaveLength(6);
      expect(delta.some((item) => item.id === "audit-lot-a")).toBe(false);
    }
    if (sequence === 4n) expect(delta).toEqual([row("command", "audit-value", 4n, "book-main")]);
    for (const identity of delta) entries.set(identityIndexKey(identity), identity);
    bodies.set(sequence, result.encoded);
    current = { state: result.transition.state, protocol: result.transition.protocol };
  }
  expect(encodeDurableBook(current)).toBe(raw);
  expect([...entries.values()]).toHaveLength(15);
  for (const family of ["lot", "lotHolding"] as const) {
    const expected = row(family, "audit-lot-a", 2n, "book-main");
    expect(entries.get(identityIndexKey(expected))).toEqual(expected);
  }
});

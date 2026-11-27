import { expect, test } from "bun:test";
import {
  createBookProtocolState,
  createBookState,
  decodeDurableBook,
  encodeDurableBook,
  encodeBookRow,
  hashCanonical,
  sealCommand,
  commandId,
  instant,
  localDate,
  fiscalPeriodId,
  closePackageId,
  commitBookIntent,
  decodeBookStateHeader,
  hashCommitIntent,
  type BookCommitIntent,
  type BookEffect,
  type BookCommand,
  type DurableBookAggregate,
  remeasurementResultId,
} from "@rastrata/kernel";
import {
  INDEXED_CHANGE_LIMITS,
  prepareIndexedBookOutcome,
  type IndexedChangeBudget,
  type IndexedOutcomeInput,
} from "../src/indexed-book-change.ts";
import {
  indexedCollectionDomain,
  prepareIndexedBookState,
  projectLegacyIndexedBook,
} from "../src/indexed-book-state.ts";
import { auditLogicalMap } from "../src/logical-map.ts";
import { rebuildLogicalMap } from "./logical-map-oracle.ts";
import { evaluateOutcomePayload } from "../src/outcome-payload.ts";
import { activation, genesis, posting } from "./fixtures.ts";
import {
  admissionFxWorkflow,
  allocationAndTaxWorkflow,
  lotIdentityWorkflow,
} from "./accounting-workflows.ts";
import { commercialWorkflow } from "./commercial-workflow.ts";

type ConformanceGroup = "core" | "lots" | "allocation" | "fx" | "commercial";
const effectConformance = {
  activation: "core",
  configuration: "core",
  journal: "core",
  lotState: "lots",
  correction: "commercial",
  periodTransition: "core",
  closePackage: "core",
  provisionalInventoryLayer: "commercial",
  inventoryRecosting: "commercial",
  inventoryValueAdjustment: "commercial",
  openItem: "commercial",
  settlement: "commercial",
  settlementAllocation: "commercial",
  remeasurementResult: "fx",
  remeasurementReversal: "fx",
  allocationSchedule: "allocation",
  allocationRecognition: "allocation",
  allocationScheduleRevision: "allocation",
  taxDetermination: "allocation",
  consolidationCompilation: "commercial",
  // These families have standalone rows. Ownership is retained inside revision
  // rows; its complete projection/publication oracle is owned-inventory-boundary.test.ts.
  // Native lotChanges is explicitly rejected before any ordinal-index write;
  // owned-inventory-boundary.test.ts executes that compatibility boundary.
} satisfies Record<
  Exclude<BookEffect["type"], "inventoryOwnership" | "lotChanges">,
  ConformanceGroup
>;
function expectEffectConformance(group: ConformanceGroup, seen: ReadonlySet<string>) {
  const required = Object.entries(effectConformance).filter(([, assigned]) => assigned === group);
  expect(required.length).toBeGreaterThan(0);
  for (const [effect] of required)
    expect(seen.has(effect), `Actual admitted ${group} stream must emit ${effect}`).toBe(true);
}

// Independent extraction of the legacy codec's exact row subtrees. This does not
// use the effect mapper or indexed change/compiler output to decide expected rows.
function wireRows(encoded: string, collection: string): (string | null)[] {
  let node = JSON.parse(encoded).body;
  for (const name of collection.split(".")) {
    node = node[1].find(([key]: [string]) => key === name)?.[1];
    if (node === undefined) return [];
  }
  return (collection === "state.openingBoundary" ? [node] : node[1]).map((value: unknown) =>
    JSON.stringify(value),
  );
}

function decision(before: DurableBookAggregate, command: BookCommand) {
  const evaluated = evaluateOutcomePayload(before, command);
  const retained = evaluated.transition.protocol.retainedResults.at(-1);
  if (!retained || evaluated.encoded === null) throw new Error("Expected newly retained decision");
  const input: IndexedOutcomeInput = evaluated.transition.intent
    ? {
        kind: "commit",
        intent: evaluated.transition.intent,
        previousRevision: before.state.revisions.at(-1) ?? null,
      }
    : { kind: "rejection", retained };
  return { ...evaluated, input, retained };
}

async function verifyCommands(initial: DurableBookAggregate, commands: readonly BookCommand[]) {
  let source = initial;
  const original = await projectLegacyIndexedBook(encodeDurableBook(initial));
  let state = original.state;
  const nodes = new Map<string, string>();
  const read = async (digest: string) => nodes.get(digest) ?? original.readNode(digest);
  const effectTypes = new Set<string>();
  const changed = new Set<string>();
  let replacedRows = 0;
  for (const command of commands) {
    const beforeBytes = JSON.stringify(state);
    const beforeLegacy = encodeDurableBook(source);
    const evaluated = decision(source, command);
    const candidate = await prepareIndexedBookOutcome(state, evaluated.input, read);
    expect(candidate.beforeStateContentHash).toBe(state.contentHash);
    expect(candidate.encodedOutcome).toBe(evaluated.encoded);
    expect(JSON.stringify(state)).toBe(beforeBytes);
    expect(encodeDurableBook(source)).toBe(beforeLegacy);
    expect(Object.isFrozen(candidate.nodes)).toBe(true);
    expect(Object.isFrozen(candidate.rows)).toBe(true);
    for (const node of candidate.nodes) nodes.set(node.digest, node.encoded);
    const next = { state: evaluated.transition.state, protocol: evaluated.transition.protocol };
    const afterLegacy = encodeDurableBook(next);
    const expected = await projectLegacyIndexedBook(afterLegacy);
    expect(candidate.state).toEqual(expected.state);
    const folded = new Map(
      state.collections.map((c) => [c.collection, wireRows(beforeLegacy, c.collection)]),
    );
    for (const write of candidate.rows) {
      const rows = folded.get(write.collection);
      if (!rows) throw new Error("Write names an unknown collection");
      const index = Number(write.ordinal) - 1;
      expect(Number.isSafeInteger(index) && index >= 0 && index <= rows.length).toBe(true);
      const domain = indexedCollectionDomain(source.state.financialIdentityHash, write.collection);
      const commitment = (encoded: string | null) =>
        encoded === null
          ? null
          : hashCanonical({ domain, ordinal: BigInt(write.ordinal), encoded }).digest;
      expect(write.previous).toBe(commitment(rows[index] ?? null));
      expect(write.next).toBe(commitment(write.encoded));
      rows[index] = write.encoded;
    }
    for (const collection of state.collections) {
      const rows = folded.get(collection.collection);
      if (!rows) throw new Error("Missing folded collection");
      while (rows.at(-1) === null) rows.pop();
      expect(rows).toEqual(wireRows(afterLegacy, collection.collection));
    }
    const reachable = new Set<string>();
    const auditRead = async (digest: string) => {
      reachable.add(digest);
      return read(digest);
    };
    for (const collection of candidate.state.collections) {
      const domain = indexedCollectionDomain(
        next.state.financialIdentityHash,
        collection.collection,
      );
      const actual = new Map<string, string>();
      const expectedRows = new Map<string, string>();
      const audit = await auditLogicalMap(
        collection.encodedRoot,
        collection.rootHash,
        domain,
        auditRead,
        (key, value) => {
          actual.set(key, value);
        },
      );
      await auditLogicalMap(
        collection.encodedRoot,
        collection.rootHash,
        domain,
        expected.readNode,
        (key, value) => {
          expectedRows.set(key, value);
        },
      );
      expect(audit.population).toBe(BigInt(collection.population));
      expect(actual).toEqual(expectedRows);
    }
    expect(candidate.nodes.every((node) => reachable.has(node.digest))).toBe(true);
    expect(candidate.metrics.retainedNodeBytes).toBeLessThanOrEqual(candidate.metrics.nodeBytes);
    // Candidate writes also carry the exact canonical retained row, not only a
    // matching final balance/root. Ownership and source bytes are independently checked.
    expect(candidate.rows.at(-1)?.encoded).toBe(
      encodeBookRow("protocol.retainedResults", evaluated.retained),
    );
    for (const row of candidate.rows) {
      changed.add(row.collection);
      if (row.previous !== null) replacedRows++;
    }
    for (const effect of evaluated.transition.intent?.effects ?? []) effectTypes.add(effect.type);
    if (evaluated.input.kind === "rejection") {
      expect(candidate.state.stateRoot).toBe(state.stateRoot);
      expect(candidate.rows.map((r) => r.collection)).toEqual(["protocol.retainedResults"]);
    }
    state = candidate.state;
    source = next;
  }
  return { source, state, read, effectTypes, changed, replacedRows };
}

test("one candidate includes exact activation, posting, rejection, configuration, close and reopen deltas", async () => {
  const initial = genesis();
  const original = activation();
  const base = {
    bookId: original.bookId,
    actorId: original.actorId,
    protocolVersion: original.protocolVersion,
  };
  const configuration = sealCommand({
    ...base,
    id: commandId("change-configuration"),
    type: "replaceConfiguration",
    expectedBookRevision: 2n,
    expectedConfigurationRevision: 0n,
    issuedAt: instant("2026-01-20T00:00:00Z"),
    completedAt: instant("2026-01-20T00:00:01Z"),
    committedAt: instant("2026-01-20T00:00:02Z"),
    effectiveOn: localDate("2026-01-20"),
    periods: initial.state.periods,
    admissionSnapshot: initial.state.admissionSnapshot,
    policies: initial.state.policies,
    quantizationPolicies: initial.state.quantizationPolicies,
    accountingPolicies: initial.state.accountingPolicySnapshot.policies,
  });
  const close = sealCommand({
    ...base,
    id: commandId("change-close"),
    type: "closePeriod",
    expectedBookRevision: 3n,
    issuedAt: instant("2026-02-01T00:00:00Z"),
    completedAt: instant("2026-02-01T00:00:01Z"),
    committedAt: instant("2026-02-01T00:00:02Z"),
    periodId: fiscalPeriodId("january"),
    closePackageId: closePackageId("change-close-package"),
    reason: "Close January",
    reportPopulationHash: hashCanonical("report"),
    reportingPolicySnapshotHash: hashCanonical("report-policy"),
  });
  const reopen = sealCommand({
    ...base,
    id: commandId("change-reopen"),
    type: "reopenPeriod",
    expectedBookRevision: 4n,
    issuedAt: instant("2026-02-02T00:00:00Z"),
    completedAt: instant("2026-02-02T00:00:01Z"),
    committedAt: instant("2026-02-02T00:00:02Z"),
    periodId: fiscalPeriodId("january"),
    reason: "Reopen January",
  });
  const result = await verifyCommands(initial, [
    posting("before-active", 0n),
    activation(),
    posting("stale", 0n),
    posting("valid", 1n),
    configuration,
    close,
    reopen,
  ]);
  expect(result.source.state.bookRevision).toBe(5n);
  expect(result.source.protocol.retainedResults.length).toBe(7);
  expectEffectConformance("core", result.effectTypes);
  expect([...result.effectTypes].sort()).toEqual([
    "activation",
    "closePackage",
    "configuration",
    "journal",
    "periodTransition",
  ]);
});

test("complete allocation/tax and FX effects agree with the actual kernel after every command", async () => {
  for (const version of ["1.0.0", "1.1.0"] as const) {
    const scenario = allocationAndTaxWorkflow(version);
    const actual = await verifyCommands(scenario.initial, scenario.commands);
    expect(actual.source.state.bookRevision).toBe(BigInt(scenario.commands.length));
    expectEffectConformance("allocation", actual.effectTypes);
    expect([...actual.effectTypes].sort()).toEqual([
      "activation",
      "allocationRecognition",
      "allocationSchedule",
      "allocationScheduleRevision",
      "journal",
      "taxDetermination",
    ]);
  }
  const fx = admissionFxWorkflow();
  const commands = [...fx.commands, fx.reverse(fx.firstMeasurement, 5n)];
  const actual = await verifyCommands(fx.initial, commands);
  expectEffectConformance("fx", actual.effectTypes);
  expect(actual.effectTypes.has("remeasurementResult")).toBe(true);
  expect(actual.effectTypes.has("remeasurementReversal")).toBe(true);
});

test("two overdue FX positions can be reversed in either order without admitting ordinary work early", () => {
  for (const reversedOrder of [false, true]) {
    const scenario = admissionFxWorkflow();
    let current: DurableBookAggregate = scenario.initial;
    const execute = (command: BookCommand) => {
      const evaluated = evaluateOutcomePayload(current, command).transition;
      current = { state: evaluated.state, protocol: evaluated.protocol };
      return evaluated.result;
    };
    for (const command of scenario.commands) expect(execute(command).disposition).toBe("committed");
    const measurements = [scenario.firstMeasurement, scenario.secondMeasurement];
    if (reversedOrder) measurements.reverse();
    const probe = (id: string) =>
      sealCommand({
        ...posting(id, current.state.bookRevision),
        issuedAt: instant("2026-01-17T18:00:00Z"),
        completedAt: instant("2026-01-17T18:00:01Z"),
        committedAt: instant("2026-01-17T18:00:02Z"),
      });
    for (const [index, measurement] of measurements.entries()) {
      const blocked = execute(probe(`blocked-before-reversal-${index}`));
      expect(blocked.disposition).toBe("rejected");
      expect(blocked.diagnostics[0]?.path).toBe("state.accountingState.remeasurementResults");
      const original = current.state.journals.find((row) => row.commandId === measurement.id);
      if (original === undefined) throw new Error("Missing original FX journal");
      const template = scenario.reverse(measurement, current.state.bookRevision);
      const reversal = sealCommand({
        ...template,
        issuedAt: instant("2026-01-17T18:00:00Z"),
        completedAt: instant("2026-01-17T18:00:01Z"),
        committedAt: instant("2026-01-17T18:00:02Z"),
        request: {
          ...template.request,
          effectiveOn: localDate("2026-01-17"),
          governedAt: instant("2026-01-17T18:00:00Z"),
          valuationPath: {
            ...template.request.valuationPath,
            effectiveAt: instant("2026-01-17T18:00:00Z"),
          },
        },
      });
      const invalid = execute(
        sealCommand({
          ...reversal,
          id: commandId(`missing-reversal-${index}`),
          request: { ...reversal.request, reversalOf: remeasurementResultId("not-retained") },
        }),
      );
      expect(invalid.disposition).toBe("rejected");
      expect(invalid.diagnostics[0]?.path).toBe("command.remeasurement.reversalOf");
      const result = execute(reversal);
      expect(result.disposition, JSON.stringify(result.diagnostics)).toBe("committed");
      const journal = current.state.journals.at(-1)?.journal;
      if (journal === undefined) throw new Error("Missing reversal FX journal");
      expect(journal.accountingDate).toBe(localDate("2026-01-17"));
      expect(
        journal.postings.map((p) => [p.accountId, p.bookValue.amount.toRational().toString()]),
      ).toEqual(
        original.journal.postings.map((p) => [
          p.accountId,
          p.bookValue.amount.toRational().negate().toString(),
        ]),
      );
      const bytes = encodeDurableBook(current);
      const restored = decodeDurableBook(bytes);
      expect(restored.disposition).toBe("decoded");
      if (restored.disposition !== "decoded") throw new Error(restored.message);
      expect(encodeDurableBook(restored.aggregate)).toBe(bytes);
    }
    expect(execute(probe("allowed-after-both-reversals")).disposition).toBe("committed");
    expect(current.state.accountingState.remeasurementReversals).toHaveLength(2);
  }
});

test("legacy lot snapshots update existing rows instead of appending replacements or rewriting history", async () => {
  const scenario = lotIdentityWorkflow();
  const actual = await verifyCommands(scenario.initial, scenario.commands);
  expect(actual.source.state.bookRevision).toBe(BigInt(scenario.commands.length));
  expect(actual.replacedRows).toBeGreaterThan(0);
  expectEffectConformance("lots", actual.effectTypes);
  expect(actual.changed.has("state.lotHoldings")).toBe(true);
  const original = (
    await Bun.file(
      new URL("../../kernel/test/data/inventory-adjustment-legacy.json", import.meta.url),
    ).text()
  ).trim();
  const decoded = decodeDurableBook(original);
  if (decoded.disposition !== "decoded") throw new Error(decoded.message);
  const configuration = decoded.aggregate.state.configurationSnapshots[0];
  if (!configuration) throw new Error("Missing genesis configuration");
  const initial = {
    state: createBookState(
      decoded.aggregate.state.identity,
      configuration.periods,
      configuration.admissionSnapshot,
      configuration.policies,
      configuration.quantizationPolicies,
      configuration.accountingPolicySnapshot.policies,
      configuration.effectiveAt,
    ),
    protocol: createBookProtocolState(),
  };
  const replayed = await verifyCommands(
    initial,
    decoded.aggregate.protocol.retainedResults.map((r) => r.command),
  );
  expect(encodeDurableBook(replayed.source)).toBe(original);
});

test("commercial commands cover the remaining eight effect families with exact postings and lineage", async () => {
  const scenario = commercialWorkflow();
  const actual = await verifyCommands(scenario.initial, scenario.commands);
  expect(actual.source.state.bookRevision).toBe(BigInt(scenario.commands.length));
  expectEffectConformance("commercial", actual.effectTypes);
  expect([...actual.effectTypes].sort()).toEqual([
    "activation",
    "consolidationCompilation",
    "correction",
    "inventoryRecosting",
    "inventoryValueAdjustment",
    "journal",
    "lotState",
    "openItem",
    "provisionalInventoryLayer",
    "settlement",
    "settlementAllocation",
  ]);
  const state = actual.source.state;
  const amounts = (id: string) =>
    state.journals
      .find((j) => j.commandId === id)
      ?.journal.postings.map((p) => p.bookValue.amount.toRational().toString());
  expect(amounts("commercial-shortage")).toEqual(["7/1", "-7/1"]);
  expect(amounts("commercial-recost")).toEqual(["2/1", "-2/1"]);
  expect(amounts("commercial-value")).toEqual(["5/1", "-5/1"]);
  expect(amounts("commercial-invoice")).toEqual(["100/1", "-100/1"]);
  expect(amounts("commercial-payment")).toEqual(["-100/1", "100/1"]);
  expect(amounts("commercial-correction")).toEqual(["-12/1", "12/1"]);
  expect(amounts("commercial-consolidate")).toEqual(["50/1", "-50/1"]);
  expect(
    state.lotHoldings.find((h) => h.id === scenario.stockId)?.remainingTotalBasis.toString(),
  ).toBe("15/1");
  expect(state.accountingState.settlementAllocations[0]?.openItemId).toBe(scenario.openId);
  expect(state.accountingState.settlementAllocations[0]?.settlementId).toBe(scenario.paidId);
  expect(state.accountingState.inventoryRecostings[0]?.layerId).toBe(scenario.provisional);
});

test("missing or mismatched predecessor/path fails without publishing even a partial candidate", async () => {
  const first = decision(genesis(), activation());
  const aggregate = { state: first.transition.state, protocol: first.transition.protocol };
  const projected = await projectLegacyIndexedBook(encodeDurableBook(aggregate));
  const next = decision(aggregate, posting("failure", 1n));
  const before = JSON.stringify(projected.state);
  let successfulReads = 0;
  await prepareIndexedBookOutcome(projected.state, next.input, async (digest) => {
    successfulReads++;
    return projected.readNode(digest);
  });
  expect(successfulReads).toBeGreaterThan(1);
  for (let failAt = 1; failAt <= successfulReads; failAt++) {
    let reads = 0;
    await expect(
      prepareIndexedBookOutcome(projected.state, next.input, async (digest) =>
        ++reads === failAt ? undefined : projected.readNode(digest),
      ),
    ).rejects.toThrow();
    expect(JSON.stringify(projected.state)).toBe(before);
  }
  if (next.input.kind !== "commit" || !next.input.previousRevision)
    throw new Error("Expected commit");
  await expect(
    prepareIndexedBookOutcome(
      projected.state,
      {
        ...next.input,
        previousRevision: {
          ...next.input.previousRevision,
          committedAt: instant("2026-01-01T23:00:00Z"),
        },
      },
      projected.readNode,
    ),
  ).rejects.toThrow("indexed_change_predecessor_mismatch");
  await expect(
    prepareIndexedBookOutcome(
      projected.state,
      { ...next.input, previousRevision: null },
      projected.readNode,
    ),
  ).rejects.toThrow();
  expect(JSON.stringify(projected.state)).toBe(before);
});

test("caller mutation after the first awaited read cannot alter staged command, effects or result", async () => {
  const first = decision(genesis(), activation());
  const aggregate = { state: first.transition.state, protocol: first.transition.protocol };
  const projected = await projectLegacyIndexedBook(encodeDurableBook(aggregate));
  const next = decision(aggregate, posting("captured", 1n));
  if (next.input.kind !== "commit") throw new Error("Expected commit");
  const effects = [...next.input.intent.effects];
  const mutable = { ...next.input, intent: { ...next.input.intent, effects } };
  let didMutate = false;
  const candidate = await prepareIndexedBookOutcome(projected.state, mutable, async (digest) => {
    if (!didMutate) {
      didMutate = true;
      effects.length = 0;
      mutable.intent.resultingPostingSequence = 999n;
    }
    return projected.readNode(digest);
  });
  expect(didMutate).toBe(true);
  expect(candidate.encodedOutcome).toBe(next.encoded);
  const expected = await projectLegacyIndexedBook(
    encodeDurableBook({ state: next.transition.state, protocol: next.transition.protocol }),
  );
  expect(candidate.state).toEqual(expected.state);
});

test("rejection framing refuses mismatched context before reading any source", async () => {
  const source = genesis();
  const projected = await projectLegacyIndexedBook(encodeDurableBook(source));
  const rejected = decision(source, posting("not-active", 0n));
  if (rejected.input.kind !== "rejection") throw new Error("Expected rejection");
  const row = rejected.input.retained;
  for (const retained of [
    { ...row, outcome: "committed" as const },
    { ...row, observedBookRevision: 1n },
    { ...row, commitIntentHash: hashCanonical("unadmitted") },
    { ...row, inputHash: hashCanonical("forged") },
    { ...row, commandId: commandId("other") },
    { ...row, completedAt: instant("2026-01-01T00:00:00Z") },
  ]) {
    let reads = 0;
    await expect(
      prepareIndexedBookOutcome(
        projected.state,
        { kind: "rejection", retained },
        async (digest) => {
          reads++;
          return projected.readNode(digest);
        },
      ),
    ).rejects.toThrow();
    expect(reads).toBe(0);
  }
});

test("ordinary candidate preparation reads paths rather than the full retained outcome population", async () => {
  const start = await verifyCommands(genesis(), [activation(), posting("original", 1n)]);
  let source = start.source;
  let state = start.state;
  const nodes = new Map<string, string>();
  const read = async (digest: string) => nodes.get(digest) ?? start.read(digest);
  const counts: number[] = [];
  for (let index = 0; index < 128; index++) {
    const evaluated = decision(source, posting(`scale-rejection-${index}`, 0n));
    const candidate = await prepareIndexedBookOutcome(state, evaluated.input, read);
    expect(candidate.state.stateRoot).toBe(start.state.stateRoot);
    expect(candidate.rows.length).toBe(1);
    counts.push(candidate.metrics.sourceReads);
    for (const node of candidate.nodes) nodes.set(node.digest, node.encoded);
    state = candidate.state;
    source = { state: evaluated.transition.state, protocol: evaluated.transition.protocol };
  }
  const next = decision(source, posting("after-rejections", 2n));
  const candidate = await prepareIndexedBookOutcome(state, next.input, read);
  const full = await projectLegacyIndexedBook(
    encodeDurableBook({ state: next.transition.state, protocol: next.transition.protocol }),
  );
  expect(candidate.state).toEqual(full.state);
  expect(candidate.encodedOutcome).toBe(next.encoded);
  expect(source.protocol.retainedResults.length).toBe(130);
  expect(Math.max(...counts)).toBeLessThanOrEqual(9);
  expect(candidate.metrics.sourceReads).toBeLessThanOrEqual(16);
  expect(candidate.rows.map((row) => row.collection)).toEqual([
    "state.journals",
    "state.revisions",
    "protocol.retainedResults",
  ]);
});

test("projection deletions collapse each lot root but cannot authorize deleting canonical accounting rows", async () => {
  const scenario = lotIdentityWorkflow();
  const start = await verifyCommands(scenario.initial, scenario.commands);
  const next = decision(
    start.source,
    posting("untrusted-deletion", start.source.state.bookRevision),
  );
  if (next.input.kind !== "commit") throw new Error("Expected ordinary intent");
  const effects: readonly BookEffect[] = [
    ...next.input.intent.effects,
    {
      type: "lotState",
      lotState: {
        lots: [],
        holdings: [],
        allocations: [],
        contentHash: hashCanonical({ type: "LotState", lots: [], holdings: [], allocations: [] }),
      },
    },
  ];
  const body = { ...next.input.intent, effects };
  const forged: BookCommitIntent = {
    ...body,
    canonicalHash: hashCommitIntent(
      body.command,
      body.expectedBookRevision,
      body.nextBookRevision,
      body.resultingPostingSequence,
      body.expectedConfigurationRevision,
      body.nextConfigurationRevision,
      body.resultingConfigurationHash,
      effects,
    ),
  };
  const original = encodeDurableBook(start.source);
  const candidate = await prepareIndexedBookOutcome(
    start.state,
    { ...next.input, intent: forged },
    start.read,
  );
  let deleted = 0;
  for (const name of ["state.lots", "state.lotHoldings", "state.lotAllocations"] as const) {
    const before = start.state.collections.find((c) => c.collection === name);
    const after = candidate.state.collections.find((c) => c.collection === name);
    if (!before || !after) throw new Error("Missing lot collection");
    const expected = rebuildLogicalMap(
      indexedCollectionDomain(start.source.state.financialIdentityHash, name),
      new Map(),
    );
    expect(after.encodedRoot).toBe(expected.encodedRoot);
    expect(after.rootHash).toBe(expected.rootHash);
    expect(after.population).toBe("0");
    const writes = candidate.rows.filter((r) => r.collection === name);
    expect(writes.length).toBe(Number(before.population));
    expect(writes.every((r) => r.next === null && r.encoded === null && r.previous !== null)).toBe(
      true,
    );
    deleted += writes.length;
  }
  expect(deleted).toBeGreaterThan(3);
  const rejected = commitBookIntent(start.source.state, start.source.protocol, forged);
  expect(rejected.result.disposition).toBe("rejected");
  expect(rejected.result.diagnostics[0]?.code).toBe("ordered_history_violation");
  expect(rejected.state.contentHash).toEqual(start.source.state.contentHash);
  expect(encodeDurableBook(start.source)).toBe(original);
});

test("row and staged-node budgets admit the exact threshold and reject one below without side effects", async () => {
  const start = await verifyCommands(genesis(), [activation(), posting("budget-source", 1n)]);
  const next = decision(start.source, posting("budget-next", 2n));
  const expected = await prepareIndexedBookOutcome(start.state, next.input, start.read);
  const budget = {
    ...INDEXED_CHANGE_LIMITS,
    changedRows: expected.metrics.changedRows,
    nodeBytes: expected.metrics.nodeBytes,
  };
  expect(expected.metrics.changedRows).toBe(3);
  expect(expected.metrics.nodeBytes).toBeGreaterThan(0);
  expect(await prepareIndexedBookOutcome(start.state, next.input, start.read, budget)).toEqual(
    expected,
  );
  const before = JSON.stringify(start.state);
  await expect(
    prepareIndexedBookOutcome(start.state, next.input, start.read, {
      ...budget,
      changedRows: budget.changedRows - 1,
    }),
  ).rejects.toThrow("indexed_change_row_limit");
  await expect(
    prepareIndexedBookOutcome(start.state, next.input, start.read, {
      ...budget,
      nodeBytes: budget.nodeBytes - 1,
    }),
  ).rejects.toThrow("indexed_change_node_limit");
  expect(JSON.stringify(start.state)).toBe(before);
  // The copied budget cannot be loosened or narrowed while reads are in flight.
  const mutable = { ...budget };
  expect(
    await prepareIndexedBookOutcome(
      start.state,
      next.input,
      async (digest) => {
        mutable.changedRows = 0;
        mutable.nodeBytes = 0;
        return start.read(digest);
      },
      mutable,
    ),
  ).toEqual(expected);
});

test("replacement bounds check both previous and resulting populations before traversing an oversized map", async () => {
  const scenario = lotIdentityWorkflow();
  const start = await verifyCommands(scenario.initial, scenario.commands.slice(0, 2));
  const next = decision(
    start.source,
    scenario.acquire("replacement-budget", start.source.state.bookRevision, 1n),
  );
  const expected = await prepareIndexedBookOutcome(start.state, next.input, start.read);
  expect(
    await prepareIndexedBookOutcome(start.state, next.input, start.read, {
      ...INDEXED_CHANGE_LIMITS,
      replacementRows: 2,
    }),
  ).toEqual(expected);
  await expect(
    prepareIndexedBookOutcome(start.state, next.input, start.read, {
      ...INDEXED_CHANGE_LIMITS,
      replacementRows: 1,
    }),
  ).rejects.toThrow("indexed_change_replacement_limit");
  const decoded = decodeBookStateHeader(start.state.header);
  if (decoded.disposition !== "decoded") throw new Error(decoded.message);
  const oversized = prepareIndexedBookState(
    decoded.header,
    start.state.collections.map((c) => {
      if (c.collection !== "state.lots")
        return { collection: c.collection, encodedRoot: c.encodedRoot };
      const root = JSON.parse(c.encodedRoot);
      const count = BigInt(INDEXED_CHANGE_LIMITS.replacementRows) + 1n;
      root.tree = {
        digest: "a".repeat(64),
        min: "1".padStart(64, "0"),
        max: count.toString(16).padStart(64, "0"),
        count: count.toString(),
      };
      return { collection: c.collection, encodedRoot: JSON.stringify(root) };
    }),
  );
  let oversizedRead = false;
  await expect(
    prepareIndexedBookOutcome(oversized, next.input, async (digest) => {
      if (digest === "a".repeat(64)) oversizedRead = true;
      return start.read(digest);
    }),
  ).rejects.toThrow("indexed_change_replacement_limit");
  expect(oversizedRead).toBe(false);
});

test("trusted budget narrowing never raises hard profile caps or evaluates accessor fields", async () => {
  const source = genesis();
  const state = (await projectLegacyIndexedBook(encodeDurableBook(source))).state;
  const next = decision(source, activation());
  let reads = 0;
  const read = async () => {
    reads++;
    return undefined;
  };
  for (const key of Object.keys(INDEXED_CHANGE_LIMITS) as (keyof IndexedChangeBudget)[]) {
    for (const value of [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      INDEXED_CHANGE_LIMITS[key] + 1,
    ]) {
      await expect(
        prepareIndexedBookOutcome(state, next.input, read, {
          ...INDEXED_CHANGE_LIMITS,
          [key]: value,
        }),
      ).rejects.toThrow("indexed_change_budget_invalid");
    }
  }
  let accesses = 0;
  const accessor = {
    ...INDEXED_CHANGE_LIMITS,
    get nodeBytes() {
      accesses++;
      return 100;
    },
  };
  for (const budget of [accessor, { ...INDEXED_CHANGE_LIMITS, extra: true }, null])
    await expect(
      prepareIndexedBookOutcome(state, next.input, read, budget as unknown as IndexedChangeBudget),
    ).rejects.toThrow("indexed_change_budget_invalid");
  expect(reads).toBe(0);
  expect(accesses).toBe(0);
  expect(Object.isFrozen(INDEXED_CHANGE_LIMITS)).toBe(true);
});

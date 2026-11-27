import { expect, test } from "bun:test";
import {
  commandId,
  closePackageId,
  localDate,
  instant,
  sealCommand,
  hashCanonical,
  encodeDurableBook,
  decodeDurableBook,
  createBookState,
  createBookProtocolState,
  ExactDecimal,
  ExactRational,
  resolveJournal,
  type BookCommand,
  type BookEffect,
  type BookRowCollection,
  type DurableBookAggregate,
  type ResolvedTransaction,
} from "@rastrata/kernel";
import {
  INDEXED_BOOK_COLLECTIONS,
  indexedCollectionDomain,
  prepareIndexedBookHead,
  projectLegacyIndexedBook,
} from "../src/indexed-book-state.ts";
import { prepareIndexedBookOutcome } from "../src/indexed-book-change.ts";
import { prepareIndexedOutcomeRecord } from "../src/indexed-outcome-record.ts";
import {
  INDEXED_OUTCOME_SOURCE_PROJECTION,
  projectIndexedOutcomeSource,
  resolveIndexedOutcomeSourceRow,
  projectOutcomeSource,
  type IndexedOutcomeSourceAuthority,
  type OutcomeRowLocator,
} from "../src/outcome-source.ts";
import { evaluateOutcomePayload } from "../src/outcome-payload.ts";
import { compactGenesisHead, compactOutcomeRecord } from "../src/compact-records.ts";
import { verifiedOutcomeRecordHash } from "../src/records.ts";
import { activation, genesis, posting } from "./fixtures.ts";
import {
  allocationAndTaxWorkflow,
  admissionFxWorkflow,
  lotIdentityWorkflow,
  workflowValue,
} from "./accounting-workflows.ts";
import { commercialWorkflow } from "./commercial-workflow.ts";

// Expected rows come from full legacy codec subtrees, not either source mapper
// or the incremental row compiler. This also keeps exact money/tag/hash bytes.
function rows(encoded: string, collection: string): string[] {
  let node = JSON.parse(encoded).body;
  for (const name of collection.split(".")) {
    node = node[1].find(([key]: [string]) => key === name)?.[1];
    if (node === undefined) return [];
  }
  return (collection === "state.openingBoundary" ? [node] : node[1]).map((value: unknown) =>
    JSON.stringify(value),
  );
}

async function stream(
  initial: DurableBookAggregate,
  commands: readonly BookCommand[],
  rejected = new Set<string>(),
) {
  const scope = {
    tenantId: "indexed-source",
    bookId: initial.state.identity.bookId,
    objectId: "source-object",
    namespaceId: "source-namespace",
    generation: "0",
  };
  let aggregate = initial;
  const first = await projectLegacyIndexedBook(encodeDurableBook(initial));
  let state = first.state;
  let head = prepareIndexedBookHead(scope, scope.objectId, state, null, null);
  let legacyHead = compactGenesisHead(scope, encodeDurableBook(initial));
  const nodes = new Map<string, string>();
  const read = async (digest: string) => nodes.get(digest) ?? first.readNode(digest);
  const effects = new Set<BookEffect["type"]>();
  const steps = [];
  for (const command of commands) {
    const evaluated = evaluateOutcomePayload(aggregate, command);
    const retained = evaluated.transition.protocol.retainedResults.at(-1);
    if (!retained || !evaluated.encoded) throw new Error("Expected newly retained outcome");
    expect(retained.outcome, `${command.id}: ${JSON.stringify(retained.diagnostics)}`).toBe(
      rejected.has(command.id) ? "rejected" : "committed",
    );
    const candidate = await prepareIndexedBookOutcome(
      state,
      evaluated.transition.intent
        ? {
            kind: "commit",
            intent: evaluated.transition.intent,
            previousRevision: aggregate.state.revisions.at(-1) ?? null,
          }
        : { kind: "rejection", retained },
      read,
    );
    const record = prepareIndexedOutcomeRecord(
      scope,
      scope.objectId,
      state,
      head,
      candidate.state,
      evaluated.encoded,
    );
    const encoded = JSON.stringify(record);
    const authority: IndexedOutcomeSourceAuthority = {
      recordHash: record.contentHash,
      scope,
      actualObjectId: scope.objectId,
      beforeState: state,
      beforeHead: head,
    };
    const beforeBytes = encodeDurableBook(aggregate);
    const nextAggregate = {
      state: evaluated.transition.state,
      protocol: evaluated.transition.protocol,
    };
    const afterBytes = encodeDurableBook(nextAggregate);
    const source = projectIndexedOutcomeSource(
      encoded,
      authority.recordHash,
      scope,
      scope.objectId,
      state,
      head,
    );
    const legacyRecord = compactOutcomeRecord(scope, legacyHead, nextAggregate, evaluated.encoded);
    const legacySource = projectOutcomeSource(
      legacyRecord,
      verifiedOutcomeRecordHash(legacyRecord),
    );
    expect(source.profile).toBe("rastrata-indexed-outcome-source-v1");
    expect(source.groups).toEqual(legacySource.groups);
    expect(source.recordHash).not.toBe(legacySource.recordHash);
    expect(source.sequence).toBe(BigInt(nextAggregate.protocol.retainedResults.length));
    const lotEffects =
      evaluated.transition.intent?.effects.filter((effect) => effect.type === "lotState") ?? [];
    for (const [member, collection] of [
      ["lots", "state.lots"],
      ["holdings", "state.lotHoldings"],
      ["allocations", "state.lotAllocations"],
    ] as const) {
      const groups = source.groups.filter((group) => group.collection === collection);
      expect(groups.length).toBe(lotEffects.length);
      for (const [index, effect] of lotEffects.entries()) {
        const group = workflowValue(groups[index]);
        expect(group.mode).toBe("replace");
        // Even an empty replacement must survive extraction. Final rows alone
        // cannot detect its omission when the prior collection was also empty.
        expect(group.rows.length).toBe(effect.lotState[member].length);
      }
    }
    const actual = new Map(
      INDEXED_BOOK_COLLECTIONS.map((collection) => [collection, rows(beforeBytes, collection)]),
    );
    const resolvedRows: { locator: OutcomeRowLocator; hash: string; encoded: string }[] = [];
    for (const group of source.groups) {
      const collection = group.collection as BookRowCollection;
      const current = group.mode === "replace" ? [] : [...workflowValue(actual.get(collection))];
      const expected = rows(afterBytes, collection);
      for (const row of group.rows) {
        const ordinal = BigInt(current.length) + 1n;
        if (row.ordinal !== null) expect(row.ordinal).toBe(ordinal);
        const exact = workflowValue(expected[current.length]);
        expect(row.encoded).toBe(exact);
        const hash = hashCanonical({
          domain: indexedCollectionDomain(initial.state.financialIdentityHash, collection),
          ordinal,
          encoded: exact,
        }).digest;
        const locator = { collection, selector: row.selector, ordinal };
        expect(resolveIndexedOutcomeSourceRow(encoded, authority, locator, hash)).toBe(exact);
        resolvedRows.push({ locator, hash, encoded: exact });
        current.push(row.encoded);
        expect(Object.isFrozen(row)).toBe(true);
        expect(Object.isFrozen(row.selector)).toBe(true);
      }
      actual.set(collection, current);
    }
    for (const collection of INDEXED_BOOK_COLLECTIONS)
      expect(actual.get(collection)).toEqual(rows(afterBytes, collection));
    expect(Object.isFrozen(source.groups)).toBe(true);
    expect(JSON.stringify(record)).toBe(encoded);
    for (const effect of evaluated.transition.intent?.effects ?? []) effects.add(effect.type);
    for (const node of candidate.nodes) nodes.set(node.digest, node.encoded);
    steps.push({ record, encoded, authority, source, resolvedRows, legacyRecord });
    state = candidate.state;
    head = record.after;
    legacyHead = legacyRecord.after;
    aggregate = nextAggregate;
  }
  return { steps, effects, aggregate };
}

function coreWorkflow() {
  const initial = genesis(),
    base = posting();
  const core = {
    bookId: base.bookId,
    actorId: base.actorId,
    protocolVersion: base.protocolVersion,
    issuedAt: instant("2026-02-01T00:00:00Z"),
    completedAt: instant("2026-02-01T00:00:01Z"),
    committedAt: instant("2026-02-01T00:00:02Z"),
  };
  const periodId = workflowValue(initial.state.periods[0]).id;
  return {
    initial,
    commands: [
      activation(),
      posting("source-journal", 1n),
      sealCommand({
        ...core,
        id: commandId("source-configuration"),
        type: "replaceConfiguration",
        expectedBookRevision: 2n,
        expectedConfigurationRevision: 0n,
        effectiveOn: localDate("2026-01-20"),
        periods: initial.state.periods,
        admissionSnapshot: initial.state.admissionSnapshot,
        policies: initial.state.policies,
        quantizationPolicies: initial.state.quantizationPolicies,
        accountingPolicies: initial.state.accountingPolicySnapshot.policies,
      }),
      sealCommand({
        ...core,
        id: commandId("source-close"),
        type: "closePeriod",
        expectedBookRevision: 3n,
        periodId,
        closePackageId: closePackageId("source-close"),
        reason: "Close source test",
        reportPopulationHash: hashCanonical("report"),
        reportingPolicySnapshotHash: hashCanonical("policy"),
      }),
      sealCommand({
        ...core,
        id: commandId("source-reopen"),
        type: "reopenPeriod",
        expectedBookRevision: 4n,
        periodId,
        reason: "Reopen source test",
      }),
    ],
  };
}

test("indexed and compact sources preserve exact independently encoded rows across twenty legacy effect families", async () => {
  expect(INDEXED_OUTCOME_SOURCE_PROJECTION).toBe("rastrata-indexed-outcome-source-v1");
  const fx = admissionFxWorkflow(false);
  const workflows = [
    coreWorkflow(),
    commercialWorkflow(),
    lotIdentityWorkflow(),
    allocationAndTaxWorkflow("1.1.0"),
    { initial: fx.initial, commands: [...fx.commands, fx.reverse(fx.firstMeasurement, 5n)] },
  ];
  const seen = new Set<BookEffect["type"]>();
  for (const scenario of workflows) {
    const result = await stream(scenario.initial, scenario.commands);
    for (const effect of result.effects) seen.add(effect);
  }
  const required = {
    activation: true,
    configuration: true,
    journal: true,
    lotState: true,
    correction: true,
    periodTransition: true,
    closePackage: true,
    provisionalInventoryLayer: true,
    inventoryRecosting: true,
    inventoryValueAdjustment: true,
    openItem: true,
    settlement: true,
    settlementAllocation: true,
    remeasurementResult: true,
    remeasurementReversal: true,
    allocationSchedule: true,
    allocationRecognition: true,
    allocationScheduleRevision: true,
    taxDetermination: true,
    consolidationCompilation: true,
    // Native lotChanges is not an ordinal-index source. Its actual fail-closed
    // source/publication test is in owned-inventory-boundary.test.ts.
  } satisfies Record<Exclude<BookEffect["type"], "inventoryOwnership" | "lotChanges">, true>;
  expect([...seen].sort() as string[]).toEqual(Object.keys(required).sort());
});

test("retained rejections have only an original result row and do not acquire a commit intent hash", async () => {
  const result = await stream(
    genesis(),
    [posting("not-open", 0n), activation(), posting("stale", 0n)],
    new Set(["not-open", "stale"]),
  );
  for (const step of [workflowValue(result.steps[0]), workflowValue(result.steps[2])]) {
    expect(step.source.groups.map((g) => g.collection)).toEqual(["protocol.retainedResults"]);
    expect(step.resolvedRows[0]?.encoded).not.toContain('"commitIntentHash"');
    expect(step.record.after.stateRoot).toBe(step.record.before.stateRoot);
  }
});

for (const [name, path] of [
  ["inventory", "../../kernel/test/data/inventory-adjustment-legacy.json"],
  ["allocation", "./data/allocation-rounding-legacy.json"],
] as const) {
  test(`indexed ${name} source framing preserves frozen historical rows and receipts without rewriting them`, async () => {
    const encoded = (await Bun.file(new URL(path, import.meta.url)).text()).trim();
    const decoded = decodeDurableBook(encoded);
    if (decoded.disposition !== "decoded") throw new Error(decoded.message);
    const original = decoded.aggregate;
    const configuration = workflowValue(original.state.configurationSnapshots[0]);
    const initial = {
      state: createBookState(
        original.state.identity,
        configuration.periods,
        configuration.admissionSnapshot,
        configuration.policies,
        configuration.quantizationPolicies,
        configuration.accountingPolicySnapshot.policies,
        configuration.effectiveAt,
      ),
      protocol: createBookProtocolState(),
    };
    const result = await stream(
      initial,
      original.protocol.retainedResults.map((row) => row.command),
      new Set(
        original.protocol.retainedResults
          .filter((row) => row.outcome === "rejected")
          .map((row) => row.commandId),
      ),
    );
    expect(encodeDurableBook(result.aggregate)).toBe(encoded);
  });
}

test("a multi-journal settlement does not confuse Oseq, journal ordinal or effect selectors", async () => {
  const scenario = commercialWorkflow();
  const template = posting("source-fee", 1n);
  if (template.type !== "postJournal") throw new Error("Expected journal template");
  const journal = {
    ...template.resolved.journal,
    postings: template.resolved.journal.postings.map((p, i) => ({
      ...p,
      accountId: i === 0 ? scenario.accounts.cost : scenario.accounts.bank,
      units: { ...p.units, canonicalNumber: ExactRational.of(i === 0 ? 5n : -5n, 1n) },
      bookValue: { ...p.bookValue, amount: ExactDecimal.of(i === 0 ? 500n : -500n, 2n) },
    })),
  };
  const fee = resolveJournal(
    journal,
    scenario.initial.state.policies,
    scenario.initial.state.identity.ownerId,
    workflowValue(scenario.initial.state.quantizationPolicies[0]),
    journal.postings.map((p) => p.bookValue.amount.toRational()),
  );
  if (Array.isArray(fee)) throw new Error("Fee journal must resolve");
  const commands = scenario.commands.map((command) =>
    command.type === "applySettlement"
      ? sealCommand({ ...command, resolved: [...command.resolved, fee as ResolvedTransaction] })
      : command,
  );
  const result = await stream(scenario.initial, commands);
  const step = workflowValue(result.steps[commands.findIndex((c) => c.type === "applySettlement")]);
  const journals = step.source.groups
    .filter((g) => g.collection === "state.journals")
    .flatMap((g) => g.rows);
  expect(journals.length).toBe(2);
  const firstOrdinal = workflowValue(journals[0]).ordinal;
  if (firstOrdinal === null) throw new Error("Journal ordinal must be explicit");
  expect(journals[1]?.ordinal).toBe(firstOrdinal + 1n);
  expect(BigInt(step.record.after.bookRevision) - BigInt(step.record.before.bookRevision)).toBe(1n);
  expect(
    BigInt(step.record.after.postingSequence) - BigInt(step.record.before.postingSequence),
  ).toBe(2n);
  expect(journals[0]?.selector).not.toEqual(journals[1]?.selector);
});

test("row reads reject scope, source, selector, ordinal and hash substitutions without accepting legacy authority", async () => {
  const { steps } = await stream(genesis(), [activation(), posting("source-target", 1n)]);
  const step = workflowValue(steps[1]);
  const row = workflowValue(
    step.resolvedRows.find((r) => r.locator.collection === "state.journals"),
  );
  const read = (
    authority = step.authority,
    locator = row.locator,
    hash = row.hash,
    encoded = step.encoded,
  ) => resolveIndexedOutcomeSourceRow(encoded, authority, locator, hash);
  for (const field of ["bookId", "tenantId", "objectId", "namespaceId", "generation"] as const)
    expect(() =>
      read({ ...step.authority, scope: { ...step.authority.scope, [field]: "other" } }),
    ).toThrow();
  expect(() => read({ ...step.authority, actualObjectId: "other" })).toThrow();
  expect(() =>
    read({ ...step.authority, recordHash: verifiedOutcomeRecordHash(step.legacyRecord) }),
  ).toThrow("outcome_source_commitment_mismatch");
  expect(() => read({ ...step.authority, beforeHead: step.record.after })).toThrow();
  expect(() => read(step.authority, row.locator, "0".repeat(64))).toThrow(
    "outcome_source_row_mismatch",
  );
  for (const ordinal of [0n, -1n, 2n, 1n << 64n])
    expect(() => read(step.authority, { ...row.locator, ordinal })).toThrow();
  for (const selector of [
    { kind: "effect", effectIndex: -1 },
    { kind: "effect", effectIndex: 9999 },
    { kind: "revision" },
    { kind: "effect", effectIndex: 0, extra: true },
  ])
    expect(() =>
      read(step.authority, { ...row.locator, selector: selector as OutcomeRowLocator["selector"] }),
    ).toThrow();
  expect(() => read(step.authority, { ...row.locator, collection: "state.closePackages" })).toThrow(
    "outcome_source_row_missing",
  );
  expect(() =>
    read(step.authority, row.locator, row.hash, JSON.stringify(step.legacyRecord)),
  ).toThrow();
  expect(() =>
    read(step.authority, row.locator, row.hash, workflowValue(steps[0]).encoded),
  ).toThrow();
  expect(() => read(step.authority, row.locator, row.hash, `${step.encoded} `)).toThrow();
});

import { expect, test } from "bun:test";
import {
  createBookProtocolState,
  createBookState,
  decodeDurableBook,
  encodeDurableBook,
  type BookCommand,
  type DurableBookAggregate,
  commandId,
  closePackageId,
  hashCanonical,
  localDate,
  sealCommand,
} from "@rastrata/kernel";
import {
  projectOutcomeSource,
  resolveOutcomeSourceRow,
  ACCOUNTING_SOURCE_COLLECTIONS,
} from "../src/outcome-source.ts";
import { projectLegacyLogicalBook } from "../src/logical-book.ts";
import { compactGenesisHead, compactOutcomeRecord } from "../src/compact-records.ts";
import { evaluateOutcomePayload } from "../src/outcome-payload.ts";
import { verifiedOutcomeRecordHash, type OutcomeRecord } from "../src/records.ts";
import { allocationAndTaxWorkflow, workflowValue } from "./accounting-workflows.ts";
import { activation, genesis, posting } from "./fixtures.ts";

function scope(initial: DurableBookAggregate) {
  return {
    tenantId: "source-test",
    bookId: initial.state.identity.bookId,
    objectId: "object",
    namespaceId: "test",
    generation: "0",
  };
}
function recordFor(initial: DurableBookAggregate, command: BookCommand) {
  const evaluated = evaluateOutcomePayload(initial, command);
  if (!evaluated.encoded) throw new Error("Expected newly retained command");
  const record = compactOutcomeRecord(
    scope(initial),
    compactGenesisHead(scope(initial), encodeDurableBook(initial)),
    evaluated.transition,
    evaluated.encoded,
  );
  return { record, evaluated };
}

async function verifyWorkflow(initial: DurableBookAggregate, commands: readonly BookCommand[]) {
  let aggregate = initial;
  let head = compactGenesisHead(scope(initial), encodeDurableBook(initial));
  let projection = await projectLegacyLogicalBook(encodeDurableBook(initial));
  const observed = new Set<string>();
  let replacements = 0;
  let unknownOrdinals = 0;
  for (const command of commands) {
    const evaluated = evaluateOutcomePayload(aggregate, command);
    if (!evaluated.encoded) throw new Error("Expected retained fixture outcome");
    aggregate = { state: evaluated.transition.state, protocol: evaluated.transition.protocol };
    const record = compactOutcomeRecord(scope(initial), head, aggregate, evaluated.encoded);
    const beforeBytes = JSON.stringify(record);
    const source = projectOutcomeSource(record, verifiedOutcomeRecordHash(record));
    const next = await projectLegacyLogicalBook(encodeDurableBook(aggregate));
    const actual = new Map(
      projection.collections.map((c) => [c.name, c.rows.map((r) => r.encoded)]),
    );
    for (const group of source.groups) {
      observed.add(group.collection);
      const prior = actual.get(group.collection);
      if (!prior) throw new Error("Unknown source collection");
      const rows = group.mode === "replace" ? [] : [...prior];
      if (group.mode === "replace") replacements++;
      for (const row of group.rows) {
        if (row.ordinal === null) unknownOrdinals++;
        else expect(row.ordinal).toBe(BigInt(rows.length) + 1n);
        const ordinal = BigInt(rows.length) + 1n;
        const target = next.collections.find((c) => c.name === group.collection);
        const expected = target?.rows[Number(ordinal - 1n)];
        if (!target || !expected) throw new Error("Missing independent full-book row");
        expect(
          resolveOutcomeSourceRow(
            record,
            source.recordHash,
            { collection: group.collection, selector: row.selector, ordinal },
            target.domain,
            expected.contentHash,
          ),
        ).toBe(expected.encoded);
        rows.push(row.encoded);
        expect(Object.isFrozen(row)).toBe(true);
        expect(Object.isFrozen(row.selector)).toBe(true);
      }
      actual.set(group.collection, rows);
    }
    // Every collection, including unchanged and empty ones, is compared to a
    // separately encoded full kernel aggregate; not to source-generated deltas.
    for (const collection of next.collections)
      expect(actual.get(collection.name)).toEqual(collection.rows.map((r) => r.encoded));
    expect(JSON.stringify(record)).toBe(beforeBytes);
    expect(source.sequence.toString()).toBe(record.after.sequence);
    expect(Object.isFrozen(source.groups)).toBe(true);
    head = record.after;
    projection = next;
  }
  return { aggregate, observed, replacements, unknownOrdinals };
}

test("single-outcome source rows reproduce every collection through cumulative tax/allocation and a retained rejection", async () => {
  const workflow = allocationAndTaxWorkflow("1.1.0");
  const result = await verifyWorkflow(workflow.initial, [
    ...workflow.commands,
    posting("stale-source-tail", 0n),
  ]);
  for (const name of [
    "allocationSchedules",
    "allocationRecognitions",
    "allocationScheduleRevisions",
    "taxDeterminations",
  ])
    expect(result.observed.has(`state.accountingState.${name}`)).toBe(true);
  expect(result.unknownOrdinals).toBeGreaterThan(0);
  expect(result.aggregate.protocol.retainedResults.length).toBe(workflow.commands.length + 1);
});

test("configuration-only commits and close/reopen cycles recover exact rows without posting-sequence advancement", async () => {
  const initial = genesis();
  const state = initial.state;
  const base = posting();
  const core = {
    protocolVersion: base.protocolVersion,
    bookId: base.bookId,
    actorId: base.actorId,
    issuedAt: base.issuedAt,
    completedAt: base.completedAt,
    committedAt: base.committedAt,
  };
  const periodId = workflowValue(state.periods[0]).id;
  const commands = [
    activation(),
    sealCommand({
      ...core,
      id: commandId("source-config"),
      type: "replaceConfiguration",
      expectedBookRevision: 1n,
      expectedConfigurationRevision: 0n,
      effectiveOn: localDate("2026-01-15"),
      periods: state.periods,
      admissionSnapshot: state.admissionSnapshot,
      policies: state.policies,
      quantizationPolicies: state.quantizationPolicies,
      accountingPolicies: state.accountingPolicySnapshot.policies,
    }),
    sealCommand({
      ...core,
      id: commandId("source-close"),
      type: "closePeriod",
      expectedBookRevision: 2n,
      periodId,
      closePackageId: closePackageId("source-close"),
      reason: "Close test book",
      reportPopulationHash: hashCanonical("empty report"),
      reportingPolicySnapshotHash: hashCanonical("test reporting policy"),
    }),
    sealCommand({
      ...core,
      id: commandId("source-reopen"),
      type: "reopenPeriod",
      expectedBookRevision: 3n,
      periodId,
      reason: "Reopen test book",
    }),
  ];
  const result = await verifyWorkflow(initial, commands);
  expect(result.aggregate.state.bookRevision).toBe(4n);
  expect(result.aggregate.state.latestPostingSequence).toBe(0n);
  expect(result.aggregate.state.configurationRevision).toBe(1n);
  expect(result.observed.has("state.configurationSnapshots")).toBe(true);
  expect(result.observed.has("state.closePackages")).toBe(true);
  expect(result.observed.has("state.periodTransitions")).toBe(true);
});

test("row resolution requires exact collection, selector, ordinal, domain, and content commitments", async () => {
  const initial = genesis();
  const { record, evaluated } = recordFor(initial, activation());
  const after = await projectLegacyLogicalBook(
    encodeDurableBook({
      state: evaluated.transition.state,
      protocol: evaluated.transition.protocol,
    }),
  );
  const collection = workflowValue(
    after.collections.find((c) => c.name === "protocol.retainedResults"),
  );
  const expected = workflowValue(collection.rows[0]);
  const locator = {
    collection: collection.name,
    selector: { kind: "retained" } as const,
    ordinal: 1n,
  };
  const commitment = verifiedOutcomeRecordHash(record);
  expect(
    resolveOutcomeSourceRow(record, commitment, locator, collection.domain, expected.contentHash),
  ).toBe(expected.encoded);
  expect(() =>
    resolveOutcomeSourceRow(
      record,
      commitment,
      { ...locator, collection: "state.revisions" },
      collection.domain,
      expected.contentHash,
    ),
  ).toThrow("outcome_source_row_missing");
  expect(() =>
    resolveOutcomeSourceRow(
      record,
      commitment,
      { ...locator, ordinal: 2n },
      collection.domain,
      expected.contentHash,
    ),
  ).toThrow("outcome_source_row_mismatch");
  expect(() =>
    resolveOutcomeSourceRow(record, commitment, locator, "0".repeat(64), expected.contentHash),
  ).toThrow("outcome_source_row_mismatch");
  expect(() =>
    resolveOutcomeSourceRow(record, commitment, locator, collection.domain, "0".repeat(64)),
  ).toThrow("outcome_source_row_mismatch");
  for (const ordinal of [0n, -1n, 1n << 256n])
    expect(() =>
      resolveOutcomeSourceRow(
        record,
        commitment,
        { ...locator, ordinal },
        collection.domain,
        expected.contentHash,
      ),
    ).toThrow("outcome_source_locator_invalid");
  for (const effectIndex of [-1, 0.5, 10_000])
    expect(() =>
      resolveOutcomeSourceRow(
        record,
        commitment,
        { ...locator, selector: { kind: "effect", effectIndex } },
        collection.domain,
        expected.contentHash,
      ),
    ).toThrow("outcome_source_selector_invalid");
  expect(() =>
    resolveOutcomeSourceRow(
      record,
      commitment,
      { ...locator, selector: { kind: "effect", effectIndex: 9999 } },
      collection.domain,
      expected.contentHash,
    ),
  ).toThrow("outcome_source_row_missing");
  const extraSelector = { kind: "retained" as const, extra: "ignored?" };
  expect(() =>
    resolveOutcomeSourceRow(
      record,
      commitment,
      { ...locator, selector: extraSelector },
      collection.domain,
      expected.contentHash,
    ),
  ).toThrow("outcome_source_selector_invalid");
});

for (const [name, location] of [
  ["inventory", "../../kernel/test/data/inventory-adjustment-legacy.json"],
  ["allocation", "./data/allocation-rounding-legacy.json"],
] as const) {
  test(`source selectors preserve frozen ${name} legacy rows, replacement snapshots, and original receipts`, async () => {
    const raw = (await Bun.file(new URL(location, import.meta.url)).text()).trim();
    const decoded = decodeDurableBook(raw);
    if (decoded.disposition !== "decoded") throw new Error(decoded.message);
    const legacy = decoded.aggregate;
    const config = legacy.state.configurationSnapshots[0];
    if (!config) throw new Error("Missing initial configuration");
    const initial = {
      state: createBookState(
        legacy.state.identity,
        config.periods,
        config.admissionSnapshot,
        config.policies,
        config.quantizationPolicies,
        config.accountingPolicySnapshot.policies,
        config.effectiveAt,
      ),
      protocol: createBookProtocolState(),
    };
    const result = await verifyWorkflow(
      initial,
      legacy.protocol.retainedResults.map((r) => r.command),
    );
    expect(encodeDurableBook(result.aggregate)).toBe(raw);
    expect(result.replacements).toBeGreaterThan(0);
    if (name === "inventory") {
      expect(result.observed.has("state.lots")).toBe(true);
      expect(result.observed.has("state.lotHoldings")).toBe(true);
      expect(result.observed.has("state.lotAllocations")).toBe(true);
    }
  });
}

test("source commitment covers context as well as payload; substitutions cannot reuse authority", () => {
  const { record } = recordFor(genesis(), activation());
  const frame = workflowValue(record.frame);
  const expected = verifiedOutcomeRecordHash(record);
  for (const field of Object.keys(record.before)) {
    const altered = { ...record, before: { ...record.before, [field]: "changed" } };
    expect(() => projectOutcomeSource(altered, expected)).toThrow(
      "outcome_source_commitment_mismatch",
    );
  }
  for (const field of Object.keys(record.after)) {
    const altered = { ...record, after: { ...record.after, [field]: "changed" } };
    expect(() => projectOutcomeSource(altered, expected)).toThrow(
      "outcome_source_commitment_mismatch",
    );
  }
  for (const changed of [
    { ...record, body: `${record.body} ` },
    { ...record, commandId: "different" },
    {
      ...record,
      frame: { ...frame, identity: { ...frame.identity, generation: "1" } },
    },
  ])
    expect(() => projectOutcomeSource(changed, expected)).toThrow(
      "outcome_source_commitment_mismatch",
    );
  expect(() => projectOutcomeSource(record, "0".repeat(64))).toThrow(
    "outcome_source_commitment_mismatch",
  );
});

test("unadmitted source profiles, malformed bodies, and inconsistent ordinal context fail closed", () => {
  const { record } = recordFor(genesis(), activation());
  const noFrame = { ...record };
  delete noFrame.frame;
  const cases: OutcomeRecord[] = [
    noFrame,
    { ...record, body: "invalid JSON" },
    { ...record, after: { ...record.after, sequence: "01" } },
    { ...record, after: { ...record.after, sequence: "2" } },
    { ...record, after: { ...record.after, bookRevision: "2" } },
    { ...record, after: { ...record.after, revisionHash: "0".repeat(64) } },
    { ...record, commandId: "different" },
  ];
  for (const changed of cases)
    expect(() => projectOutcomeSource(changed, verifiedOutcomeRecordHash(changed))).toThrow();
  expect(Object.keys(ACCOUNTING_SOURCE_COLLECTIONS).length).toBe(13);
  expect(new Set(Object.values(ACCOUNTING_SOURCE_COLLECTIONS)).size).toBe(13);
});

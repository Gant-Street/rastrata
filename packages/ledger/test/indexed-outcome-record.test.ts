import { expect, test } from "bun:test";
import {
  canonicalAccountingValue,
  decodeBookOutcome,
  decodeBookStateHeader,
  encodeBookOutcome,
  encodeDurableBook,
  hashCanonical,
  commandId,
  instant,
  localDate,
  sealCommand,
  type BookCommand,
  type DurableBookAggregate,
} from "@rastrata/kernel";
import { prepareIndexedBookOutcome, type IndexedOutcomeInput } from "../src/indexed-book-change.ts";
import {
  decodeIndexedBookState,
  indexedCollectionDomain,
  prepareIndexedBookHead,
  prepareIndexedBookState,
  projectLegacyIndexedBook,
} from "../src/indexed-book-state.ts";
import {
  INDEXED_OUTCOME_RECORD_MAX_BYTES,
  INDEXED_OUTCOME_RECORD_VERSION,
  decodeIndexedOutcomeRecord,
  prepareIndexedOutcomeRecord,
  replayIndexedOutcomeProjection,
} from "../src/indexed-outcome-record.ts";
import { auditLogicalMap } from "../src/logical-map.ts";
import { evaluateOutcomePayload } from "../src/outcome-payload.ts";
import { rebuildLogicalMap } from "./logical-map-oracle.ts";
import { activation, BOOK, genesis, posting } from "./fixtures.ts";
import { commercialWorkflow } from "./commercial-workflow.ts";
import { allocationAndTaxWorkflow } from "./accounting-workflows.ts";

const scope = {
  tenantId: "record-tenant",
  bookId: BOOK,
  objectId: "record-object",
  namespaceId: "record-namespace",
  generation: "0",
};
async function fixture(initial: DurableBookAggregate = genesis()) {
  let aggregate = initial;
  const projected = await projectLegacyIndexedBook(encodeDurableBook(initial));
  let state = projected.state;
  let head = prepareIndexedBookHead(scope, scope.objectId, state, null, null);
  const nodes = new Map<string, string>();
  const read = async (digest: string) => nodes.get(digest) ?? projected.readNode(digest);
  async function run(command: BookCommand) {
    const beforeAggregate = aggregate,
      beforeState = state,
      beforeHead = head;
    const evaluated = evaluateOutcomePayload(aggregate, command);
    const retained = evaluated.transition.protocol.retainedResults.at(-1);
    if (evaluated.encoded === null || !retained) throw new Error("Expected a new retained outcome");
    const previousRevision = evaluated.transition.intent
      ? (aggregate.state.revisions.at(-1) ?? null)
      : null;
    const input: IndexedOutcomeInput = evaluated.transition.intent
      ? { kind: "commit", intent: evaluated.transition.intent, previousRevision }
      : { kind: "rejection", retained };
    const candidate = await prepareIndexedBookOutcome(state, input, read);
    const record = prepareIndexedOutcomeRecord(
      scope,
      scope.objectId,
      state,
      head,
      candidate.state,
      candidate.encodedOutcome,
    );
    const encoded = JSON.stringify(record);
    const replayed = await replayIndexedOutcomeProjection(
      encoded,
      scope,
      scope.objectId,
      state,
      head,
      previousRevision,
      read,
    );
    expect(replayed.record).toEqual(record);
    expect(replayed.candidate).toEqual(candidate);
    expect(record.payload).toBe(evaluated.encoded);
    expect(record.before).toEqual(beforeHead);
    expect(record.after.sequence).toBe((BigInt(beforeHead.sequence) + 1n).toString());
    expect(record.after.bookRevision).toBe(evaluated.transition.state.bookRevision.toString());
    expect(record.after.postingSequence).toBe(
      evaluated.transition.state.latestPostingSequence.toString(),
    );
    expect(record.after.configurationHash).toEqual(evaluated.transition.state.configurationHash);
    expect(record.after.revisionHash).toEqual(
      evaluated.transition.state.revisions.at(-1)?.chainHash ?? null,
    );
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.before.identity)).toBe(true);
    expect(Object.isFrozen(record.after.chainHash)).toBe(true);
    expect(decodeIndexedOutcomeRecord(encoded, scope, scope.objectId, state, head)).toEqual(record);
    for (const node of candidate.nodes) nodes.set(node.digest, node.encoded);
    aggregate = { state: evaluated.transition.state, protocol: evaluated.transition.protocol };
    state = candidate.state;
    head = record.after;
    return {
      beforeAggregate,
      beforeState,
      beforeHead,
      candidate,
      record,
      encoded,
      previousRevision,
      read,
    };
  }
  return { run, read };
}

test("indexed outcome chain preserves exact original results across independent Oseq, revision and posting counters", async () => {
  expect(INDEXED_OUTCOME_RECORD_VERSION).toBe("rastrata-indexed-outcome-v1");
  const f = await fixture();
  const rejected = await f.run(posting("before-activation", 0n));
  expect(rejected.record.after.bookRevision).toBe("0");
  expect(rejected.record.after.revisionHash).toBeNull();
  expect(rejected.record.after.stateRoot).toBe(rejected.record.before.stateRoot);
  const activated = await f.run(activation());
  expect(activated.record.after.sequence).toBe("2");
  expect(activated.record.after.bookRevision).toBe("1");
  expect(activated.record.after.postingSequence).toBe("0");
  const posted = await f.run(posting("record-post", 1n));
  const laterRejection = await f.run(posting("record-stale", 0n));
  expect(laterRejection.record.after.stateRoot).toBe(posted.record.after.stateRoot);
  expect(laterRejection.record.after.revisionHash).toEqual(posted.record.after.revisionHash);
  expect(laterRejection.record.after.chainHash).not.toEqual(posted.record.after.chainHash);
  for (const step of [rejected, activated, posted, laterRejection]) {
    const record = step.record;
    const expectedPayloadHash = hashCanonical({
      domain: "rastrata-indexed-outcome-v1/payload",
      encoded: record.payload,
    });
    expect(record.payloadHash).toEqual(expectedPayloadHash);
    // Independent, explicit, acyclic preimages: no resulting head in the chain.
    const chain = hashCanonical(
      canonicalAccountingValue({
        domain: "rastrata-indexed-outcome-v1/chain",
        beforeHead: JSON.stringify(step.beforeHead),
        stateContentHash: step.candidate.state.contentHash,
        payloadHash: expectedPayloadHash,
      }),
    );
    expect(record.after.chainHash).toEqual(chain);
    const { contentHash, ...body } = record;
    expect(contentHash).toBe(
      hashCanonical({ domain: "rastrata-indexed-outcome-v1", encoded: JSON.stringify(body) })
        .digest,
    );
  }
});

test("commercial and allocation streams bind actual command effects without whole-history record hashes", async () => {
  for (const scenario of [commercialWorkflow(), allocationAndTaxWorkflow("1.1.0")]) {
    const f = await fixture(scenario.initial);
    for (const command of scenario.commands) {
      const step = await f.run(command);
      const decoded = decodeBookOutcome(step.record.payload);
      if (decoded.disposition !== "decoded") throw new Error(decoded.message);
      expect(decoded.payload.originalResult.disposition).toBe("committed");
      expect(step.record.state).toBe(JSON.stringify(step.candidate.state));
      expect(Object.keys(step.record).sort()).toEqual([
        "after",
        "before",
        "contentHash",
        "payload",
        "payloadHash",
        "state",
        "version",
      ]);
      expect(step.record.after.stateRoot).not.toBe(step.beforeAggregate.state.contentHash.digest);
    }
  }
});

test("configuration-only outcomes advance configuration and financial revision without a posting", async () => {
  const initial = genesis();
  const f = await fixture(initial);
  const original = activation();
  await f.run(original);
  const step = await f.run(
    sealCommand({
      bookId: original.bookId,
      actorId: original.actorId,
      protocolVersion: original.protocolVersion,
      id: commandId("record-configuration"),
      type: "replaceConfiguration",
      expectedBookRevision: 1n,
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
    }),
  );
  const decoded = decodeBookOutcome(step.record.payload);
  if (decoded.disposition !== "decoded") throw new Error(decoded.message);
  expect(decoded.payload.originalResult.disposition).toBe("committed");
  expect(decoded.payload.revision?.effects.map((effect) => effect.type)).toEqual(["configuration"]);
  expect(step.record.after.sequence).toBe("2");
  expect(step.record.after.bookRevision).toBe("2");
  expect(step.record.after.configurationRevision).toBe("1");
  expect(step.record.after.postingSequence).toBe("0");
  expect(step.record.after.configurationHash).not.toEqual(step.record.before.configurationHash);
});

test("decoding is bound to exact scope, actual object, prior full head and one sequence advance", async () => {
  const f = await fixture();
  await f.run(activation());
  const step = await f.run(posting("scope-bound", 1n));
  for (const foreign of [
    { ...scope, tenantId: "other" },
    { ...scope, bookId: "other" },
    { ...scope, namespaceId: "other" },
    { ...scope, objectId: "other" },
    { ...scope, generation: "1" },
  ]) {
    expect(() =>
      decodeIndexedOutcomeRecord(
        step.encoded,
        foreign,
        foreign.objectId,
        step.beforeState,
        step.beforeHead,
      ),
    ).toThrow();
  }
  expect(() =>
    decodeIndexedOutcomeRecord(
      step.encoded,
      scope,
      "wrong-object",
      step.beforeState,
      step.beforeHead,
    ),
  ).toThrow();
  const fork = prepareIndexedBookHead(
    scope,
    scope.objectId,
    step.beforeState,
    hashCanonical("another-chain"),
    step.beforeHead.revisionHash,
  );
  expect(() =>
    decodeIndexedOutcomeRecord(step.encoded, scope, scope.objectId, step.beforeState, fork),
  ).toThrow("indexed_outcome_encoding_mismatch");
  expect(() =>
    decodeIndexedOutcomeRecord(
      step.encoded,
      scope,
      scope.objectId,
      step.candidate.state,
      step.record.after,
    ),
  ).toThrow("indexed_outcome_sequence_mismatch");
  expect(() =>
    prepareIndexedOutcomeRecord(
      scope,
      scope.objectId,
      step.beforeState,
      step.beforeHead,
      step.beforeState,
      step.record.payload,
    ),
  ).toThrow("indexed_outcome_sequence_mismatch");
});

test("self-checksummed payloads cannot forge result mathematics or financial revision content", async () => {
  const f = await fixture();
  await f.run(activation());
  const step = await f.run(posting("forgery", 1n));
  const decoded = decodeBookOutcome(step.record.payload);
  if (decoded.disposition !== "decoded" || decoded.payload.revision === null)
    throw new Error("Expected revision");
  const payload = decoded.payload;
  const revision = decoded.payload.revision;
  for (const field of ["previousHash", "effectsHash", "chainHash"] as const) {
    const encoded = encodeBookOutcome({
      ...payload,
      revision: { ...revision, [field]: hashCanonical(`forged-${field}`) },
    });
    expect(() =>
      prepareIndexedOutcomeRecord(
        scope,
        scope.objectId,
        step.beforeState,
        step.beforeHead,
        step.candidate.state,
        encoded,
      ),
    ).toThrow("indexed_outcome_revision_content_mismatch");
  }
  const forgedResult = encodeBookOutcome({
    ...payload,
    originalResult: { ...payload.originalResult, resultHash: hashCanonical("forged-result") },
  });
  expect(() =>
    prepareIndexedOutcomeRecord(
      scope,
      scope.objectId,
      step.beforeState,
      step.beforeHead,
      step.candidate.state,
      forgedResult,
    ),
  ).toThrow("indexed_outcome_result_hash_mismatch");
  const forgedCommand = { ...payload.command, inputHash: hashCanonical("forged-command") };
  const commandBytes = encodeBookOutcome({
    ...payload,
    command: forgedCommand,
    revision: { ...revision, command: forgedCommand },
  });
  expect(() =>
    prepareIndexedOutcomeRecord(
      scope,
      scope.objectId,
      step.beforeState,
      step.beforeHead,
      step.candidate.state,
      commandBytes,
    ),
  ).toThrow("indexed_outcome_command_hash_mismatch");
  const rejected = await f.run(posting("retained-forgery", 0n));
  const rejection = decodeBookOutcome(rejected.record.payload);
  if (rejection.disposition !== "decoded") throw new Error(rejection.message);
  const altered = encodeBookOutcome({
    ...rejection.payload,
    originalResult: {
      ...rejection.payload.originalResult,
      resultHash: hashCanonical("forged-rejection"),
    },
  });
  expect(() =>
    prepareIndexedOutcomeRecord(
      scope,
      scope.objectId,
      rejected.beforeState,
      rejected.beforeHead,
      rejected.candidate.state,
      altered,
    ),
  ).toThrow("indexed_outcome_result_hash_mismatch");
});

test("closed record wire rejects unknown fields, versions, noncanonical bytes and changed hash metadata", async () => {
  const f = await fixture();
  const step = await f.run(activation());
  const variants = [
    { ...step.record, version: "legacy" },
    { ...step.record, extra: true },
    { ...step.record, contentHash: "0".repeat(64) },
    { ...step.record, payloadHash: { ...step.record.payloadHash, algorithm: "other" } },
    { ...step.record, after: { ...step.record.after, configurationRevision: "1" } },
    { ...step.record, before: { ...step.record.before, stateRoot: "0".repeat(64) } },
  ];
  for (const value of variants)
    expect(() =>
      decodeIndexedOutcomeRecord(
        JSON.stringify(value),
        scope,
        scope.objectId,
        step.beforeState,
        step.beforeHead,
      ),
    ).toThrow();
  for (const encoded of [
    "null",
    "{broken",
    `${step.encoded} `,
    step.encoded.replace('{"version":', '{"version":"duplicate","version":'),
    JSON.stringify(step.record.after),
    encodeDurableBook(genesis()),
    null as unknown as string,
    "x".repeat(INDEXED_OUTCOME_RECORD_MAX_BYTES + 1),
    "€".repeat(Math.ceil(INDEXED_OUTCOME_RECORD_MAX_BYTES / 3)),
  ]) {
    expect(() =>
      decodeIndexedOutcomeRecord(encoded, scope, scope.objectId, step.beforeState, step.beforeHead),
    ).toThrow();
  }
  const unicode = await f.run(posting("unicode-record", 1n, true, "Café — 東京 📚 ".repeat(100)));
  expect(unicode.record.payload).toContain("東京");
});

test("framing alone cannot prove effect projection; exact replay refuses a payload paired with another state", async () => {
  const f = await fixture();
  await f.run(activation());
  const step = await f.run(posting("original-row", 1n));
  const alternate = evaluateOutcomePayload(step.beforeAggregate, posting("different-row", 1n));
  if (alternate.encoded === null) throw new Error("Expected alternate outcome");
  const falseRecord = prepareIndexedOutcomeRecord(
    scope,
    scope.objectId,
    step.beforeState,
    step.beforeHead,
    step.candidate.state,
    alternate.encoded,
  );
  const encoded = JSON.stringify(falseRecord);
  expect(
    decodeIndexedOutcomeRecord(encoded, scope, scope.objectId, step.beforeState, step.beforeHead),
  ).toEqual(falseRecord);
  await expect(
    replayIndexedOutcomeProjection(
      encoded,
      scope,
      scope.objectId,
      step.beforeState,
      step.beforeHead,
      step.previousRevision,
      step.read,
    ),
  ).rejects.toThrow("indexed_outcome_projection_mismatch");
});

test("projection replay prevents rewriting older retained results while preserving the new outcome and counters", async () => {
  const f = await fixture();
  await f.run(activation());
  const step = await f.run(posting("retained-prefix", 1n));
  const state = decodeIndexedBookState(step.record.state);
  const h = decodeBookStateHeader(state.header);
  if (h.disposition !== "decoded") throw new Error(h.message);
  const retained = state.collections.find((c) => c.collection === "protocol.retainedResults");
  if (!retained) throw new Error("Missing retained root");
  const domain = indexedCollectionDomain(h.header.financialIdentityHash, retained.collection);
  const values = new Map<string, string>();
  await auditLogicalMap(
    retained.encodedRoot,
    retained.rootHash,
    domain,
    step.read,
    (key, value) => {
      values.set(key, value);
    },
  );
  values.set("1".padStart(64, "0"), hashCanonical("rewritten-old-result").digest);
  const forged = rebuildLogicalMap(domain, values);
  const falseState = prepareIndexedBookState(
    h.header,
    state.collections.map((c) => ({
      collection: c.collection,
      encodedRoot: c.collection === retained.collection ? forged.encodedRoot : c.encodedRoot,
    })),
  );
  const record = prepareIndexedOutcomeRecord(
    scope,
    scope.objectId,
    step.beforeState,
    step.beforeHead,
    falseState,
    step.record.payload,
  );
  await expect(
    replayIndexedOutcomeProjection(
      JSON.stringify(record),
      scope,
      scope.objectId,
      step.beforeState,
      step.beforeHead,
      step.previousRevision,
      step.read,
    ),
  ).rejects.toThrow("indexed_outcome_projection_mismatch");
});

test("every missing source-path read fails projection replay without a partial result or changed prior state", async () => {
  const f = await fixture();
  await f.run(activation());
  const step = await f.run(posting("source-failures", 1n));
  let count = 0;
  await replayIndexedOutcomeProjection(
    step.encoded,
    scope,
    scope.objectId,
    step.beforeState,
    step.beforeHead,
    step.previousRevision,
    async (digest) => {
      count++;
      return step.read(digest);
    },
  );
  expect(count).toBeGreaterThan(1);
  const before = JSON.stringify(step.beforeState);
  for (let failure = 1; failure <= count; failure++) {
    let reads = 0;
    await expect(
      replayIndexedOutcomeProjection(
        step.encoded,
        scope,
        scope.objectId,
        step.beforeState,
        step.beforeHead,
        step.previousRevision,
        async (digest) => (++reads === failure ? undefined : step.read(digest)),
      ),
    ).rejects.toThrow();
    expect(JSON.stringify(step.beforeState)).toBe(before);
  }
  const rejection = await f.run(posting("no-financial-predecessor-read", 0n));
  await expect(
    replayIndexedOutcomeProjection(
      rejection.encoded,
      scope,
      scope.objectId,
      rejection.beforeState,
      rejection.beforeHead,
      step.previousRevision,
      rejection.read,
    ),
  ).rejects.toThrow("indexed_outcome_rejection_predecessor_unused");
});

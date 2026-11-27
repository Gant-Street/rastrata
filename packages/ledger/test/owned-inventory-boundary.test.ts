import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  ExactRational as R,
  ExactDecimal as D,
  actorId,
  commandId,
  bookId,
  createBookState,
  derivationId,
  encodeDurableBook,
  decodeDurableBook,
  encodeBookRow,
  evidenceId,
  executeBookCommand,
  evaluateBookCommand,
  hashAccountingPolicy,
  hashCanonical,
  hashBookState,
  canonicalPolicyValue,
  canonicalPostingReferenceId,
  resolveJournal,
  type ResolvedTransaction,
  identifier,
  isInventoryPostedReductionMovement,
  instant,
  localDate,
  lotId,
  lotHoldingId,
  lotAllocationId,
  journalId,
  sealCommand,
  semanticVersion,
  STRUCTURAL_SOURCE_IDENTITY_PROFILE,
  policyId,
  commandInputHash,
  prepareInventoryOwnershipSelection,
  type BookCommand,
  type SemanticDiagnosticCode,
  type DurableBookAggregate,
} from "@rastrata/kernel";
import { activation, BOOK, CASH, posting } from "./fixtures.ts";
import {
  allocationAndTaxWorkflow,
  inventoryReadWorkflow,
  workflowValue,
} from "./accounting-workflows.ts";
import { evaluateOutcomePayload, replayOutcomePayload } from "../src/outcome-payload.ts";
import { projectLegacyLogicalBook } from "../src/logical-book.ts";
import { projectLegacyIndexedBook } from "../src/indexed-book-state.ts";
import { prepareIndexedBookOutcome } from "../src/indexed-book-change.ts";
import { projectVerifiedIdentityEntries } from "../src/identity-audit.ts";
import {
  prepareOutcomeIdentityDelta,
  resolveInventoryIdentity,
} from "../src/outcome-identities.ts";
import { compactGenesisHead, compactOutcomeRecord } from "../src/compact-records.ts";
import { projectOutcomeSource } from "../src/outcome-source.ts";
import { auditRecoveredInventoryPostings } from "../src/inventory-posted-audit.ts";
import { verifiedOutcomeRecordHash } from "../src/records.ts";
import { IndexedLedgerOwner } from "../src/indexed-ledger-owner.ts";
import type { SqliteStorage } from "../src/sqlite.ts";
import { identityIndexKey } from "../src/index-pages.ts";
import { readPinnedOwnedInventoryPools } from "../src/owned-inventory-pools.ts";
import { preparePinnedOwnedInventory } from "../src/owned-inventory-preparation.ts";
import type { PinnedBookRowReader } from "../src/book-row-reader.ts";
import {
  INDEXED_GROUP_CATALOG_FORMAT,
  INDEXED_OWNERSHIP_GROUP_CATALOG_FORMAT,
  INDEXED_MONEY_GROUP_CATALOG_FORMAT,
  INDEXED_REFERENCE_GROUP_CATALOG_FORMAT,
  type IndexedGroupCatalogFormat,
} from "../src/group-catalog.ts";

async function assertIndexedPreparation(
  reader: PinnedBookRowReader<unknown>,
  command: BookCommand,
  before: DurableBookAggregate,
) {
  const expected = evaluateOutcomePayload(before, command).transition;
  const result = await preparePinnedOwnedInventory(reader, command);
  if (result.disposition !== "prepared") throw new Error("Expected command-specific preparation");
  const preparation = result.preparation;
  if (!("journals" in preparation)) {
    expect(expected.result.disposition).toBe("rejected");
    expect(preparation).toEqual(expected.result.diagnostics);
    return result;
  }
  expect(expected.result.disposition, JSON.stringify(expected.result.diagnostics)).toBe(
    "committed",
  );
  const intent = workflowValue(expected.intent);
  expect(preparation.journals).toEqual(
    intent.effects.flatMap((effect) => (effect.type === "journal" ? [effect.booked] : [])),
  );
  expect(preparation.ownership).toEqual(
    workflowValue(expected.state.inventoryOwnershipEffects?.at(-1)),
  );
  expect(preparation.newLots).toEqual(
    expected.state.lots.filter((lot) => !before.state.lots.some((old) => old.id === lot.id)),
  );
  for (const holding of preparation.afterHoldings)
    expect(holding).toEqual(
      workflowValue(expected.state.lotHoldings.find((value) => value.id === holding.id)),
    );
  expect(preparation.sequence).toBe(expected.state.latestPostingSequence);
  return result;
}

function ownershipFixture() {
  const fixture = inventoryReadWorkflow(),
    base = fixture.initial.state,
    config = base.activeConfigurationSnapshot;
  const initial = {
    protocol: fixture.initial.protocol,
    state: createBookState(
      base.identity,
      config.periods,
      config.admissionSnapshot,
      config.policies,
      config.quantizationPolicies,
      [fixture.policy],
      config.effectiveAt,
      STRUCTURAL_SOURCE_IDENTITY_PROFILE,
    ),
  };
  const activated = executeBookCommand(initial.state, initial.protocol, activation());
  expect(activated.result.disposition).toBe("committed");
  const before = { state: activated.state, protocol: activated.protocol };
  const booking = workflowValue(before.state.policies[0]),
    functional = before.state.identity.functionalCommodityId;
  const at = instant("2026-01-15T12:00:00Z"),
    version = semanticVersion("1.0.0");
  const evidence = {
    id: evidenceId("owned-boundary-evidence"),
    sourceSystem: "ledger-test",
    sourceRecordId: "owned-boundary",
    observedAt: at,
    contentHash: hashCanonical({ source: "owned-boundary" }),
  };
  const command = sealCommand({
    type: "postOwnedInventoryTransaction",
    id: commandId("owned-boundary"),
    bookId: BOOK,
    expectedBookRevision: 1n,
    actorId: actorId("actor"),
    protocolVersion: version,
    issuedAt: at,
    completedAt: instant("2026-01-15T12:00:01Z"),
    committedAt: instant("2026-01-15T12:00:02Z"),
    request: {
      algorithm: "cumulativePostedInventoryV1",
      algorithmVersion: version,
      governedAt: at,
      accountingDate: localDate("2026-01-15"),
      fiscalPeriodId: workflowValue(before.state.periods[0]).id,
      resolvedJournals: [],
      operations: [
        {
          kind: "acquisition",
          ordinal: 0n,
          id: identifier<"InventoryOperation">("owned-boundary-operation"),
          coordinate: {
            accountId: CASH,
            unitsCommodityId: functional,
            dimensionMemberIds: [],
            bookingPolicy: {
              policyId: booking.id,
              policyVersion: booking.version,
              policyContentHash: hashCanonical(canonicalPolicyValue(booking)),
            },
          },
          inventoryPolicy: {
            policyId: fixture.policy.id,
            policyVersion: fixture.policy.version,
            policyContentHash: hashAccountingPolicy(fixture.policy),
          },
          derivation: {
            id: derivationId("owned-boundary-derivation"),
            policyId: fixture.policy.id,
            policyVersion: fixture.policy.version,
            algorithmVersion: version,
            inputHash: hashCanonical({ source: "owned-boundary" }),
            actorId: actorId("actor"),
            state: "approved",
            recordedAt: at,
            evidence: [evidence],
          },
          entries: [
            {
              anchorId: identifier<"InventoryPostedAnchor">("owned-boundary-anchor"),
              movementId: identifier<"InventoryPostedMovement">("owned-boundary-movement"),
              evidence: [evidence],
              lot: {
                id: lotId("owned-boundary-lot"),
                bookId: BOOK,
                commodityId: functional,
                basisCommodityId: functional,
                acquiredAt: at,
                acquisitionQuantity: R.of(1n, 1n),
                acquisitionTotalBasis: R.zero(),
                evidenceIds: [evidence.id],
              },
              holding: {
                id: lotHoldingId("owned-boundary-holding"),
                lotId: lotId("owned-boundary-lot"),
                bookId: BOOK,
                accountId: CASH,
                commodityId: functional,
                basisCommodityId: functional,
                remainingQuantity: R.of(1n, 1n),
                remainingTotalBasis: R.zero(),
                remainingValuationAllowance: R.zero(),
                remainingCarryingAmount: R.zero(),
              },
            },
          ],
        },
      ],
    },
  });
  return { initial, before, command };
}

function ownerDatabase(
  label: string,
  groupProfile: IndexedGroupCatalogFormat = INDEXED_GROUP_CATALOG_FORMAT,
) {
  const db = new Database(":memory:");
  db.exec("PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY; PRAGMA cache_size = -64000;");
  const faults = { afterSql: "" };
  const stmtCache = new Map<string, ReturnType<Database["query"]>>();
  const storage: SqliteStorage = {
    sql: {
      exec(sql, ...bindings) {
        let stmt = stmtCache.get(sql);
        if (stmt === undefined) {
          stmt = db.query(sql);
          stmtCache.set(sql, stmt);
        }
        const bound = bindings.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));
        const rawRows = stmt.all(...bound) as Record<string, unknown>[];
        if (faults.afterSql && sql.startsWith(faults.afterSql)) {
          faults.afterSql = "";
          throw new Error("injected ownership publication failure");
        }
        if (rawRows.length === 0) return rawRows;
        for (let i = 0; i < rawRows.length; i++) {
          const row = rawRows[i];
          for (const key in row) {
            const value = row[key];
            if (value instanceof Uint8Array) {
              row[key] = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
            }
          }
        }
        return rawRows;
      },
    },
    transactionSync: (work) => db.transaction(work)(),
    sync: async () => {},
  };
  const scope = {
    tenantId: label,
    bookId: BOOK,
    objectId: `${label}-object`,
    namespaceId: `${label}-namespace`,
    generation: "0",
  };
  const open = (profile = groupProfile) =>
    new IndexedLedgerOwner(
      storage,
      scope,
      scope.objectId,
      () => ({ fence: "0", pending: false }),
      () => 10n,
      60000n,
      profile,
    );
  return { db, open, faults };
}

test("indexed transfer preparation, immutable identities and restart preserve quantity-only ownership", async () => {
  const { initial, command } = ownershipFixture();
  const operation = workflowValue(command.request.operations[0]);
  if (operation.kind !== "acquisition") throw new Error("Expected acquisition fixture");
  const source = workflowValue(operation.entries[0]);
  const transfer = sealCommand({
    ...command,
    id: commandId("indexed-transfer"),
    expectedBookRevision: 2n,
    request: {
      ...command.request,
      algorithmVersion: semanticVersion("1.1.0"),
      operations: [
        {
          kind: "transfer" as const,
          ordinal: 0n,
          id: identifier<"InventoryOperation">("indexed-transfer-operation"),
          coordinate: operation.coordinate,
          inventoryPolicy: operation.inventoryPolicy,
          derivation: operation.derivation,
          destinationCoordinate: operation.coordinate,
          destinationInventoryPolicy: operation.inventoryPolicy,
          quantity: R.of(1n, 1n),
          entries: [
            {
              holdingId: source.holding.id,
              allocationId: lotAllocationId("indexed-transfer-allocation"),
              transferOutMovementId: identifier<"InventoryPostedMovement">("indexed-transfer-out"),
              destinationAnchorId: identifier<"InventoryPostedAnchor">("indexed-transfer-anchor"),
              destinationMovementId: identifier<"InventoryPostedMovement">("indexed-transfer-in"),
              destinationHoldingId: lotHoldingId("indexed-transfer-holding"),
              destinationLotId: lotId("indexed-transfer-lot"),
              evidence: source.evidence,
            },
          ],
        },
      ],
    },
  });
  const f = ownerDatabase("indexed-transfer", INDEXED_REFERENCE_GROUP_CATALOG_FORMAT);
  try {
    const owner = f.open();
    await owner.provision(initial);
    expect((await owner.execute(activation())).result.disposition).toBe("committed");
    expect((await owner.execute(command)).result.disposition).toBe("committed");
    const before = (await owner.read()).aggregate;
    const reader = await owner.openCurrentRowReader();
    try {
      await assertIndexedPreparation(reader, transfer, before);
    } finally {
      await reader.close();
    }
    const receipt = await owner.execute(transfer);
    expect(receipt.result.disposition).toBe("committed");
    const reloaded = f.open();
    const aggregate = (await reloaded.read()).aggregate;
    expect(aggregate.state.bookRevision).toBe(3n);
    expect(aggregate.state.latestPostingSequence).toBe(0n);
    expect(
      aggregate.state.lotHoldings
        .find((holding) => holding.id === source.holding.id)
        ?.remainingQuantity.toString(),
    ).toBe("0/1");
    expect(
      aggregate.state.lotHoldings
        .find((holding) => holding.id === "indexed-transfer-holding")
        ?.remainingQuantity.toString(),
    ).toBe("1/1");
    const retry = await reloaded.execute(transfer);
    expect(retry.result.disposition).toBe("replayed");
    expect(retry.result.resultHash).toEqual(receipt.result.resultHash);
    expect(retry.head).toEqual(receipt.head);
  } finally {
    f.db.close();
  }
}, 60000);

test("native lot changes cannot silently enter legacy ordinal indexes or source locators", async () => {
  const { before, command } = ownershipFixture();
  if (command.type !== "postOwnedInventoryTransaction") throw new Error("Expected owned fixture");
  const deltaCommand = sealCommand({
    ...command,
    request: { ...command.request, algorithmVersion: semanticVersion("1.2.0") },
  });
  const evaluated = evaluateOutcomePayload(before, deltaCommand);
  expect(evaluated.transition.result.disposition).toBe("committed");
  const intent = evaluated.transition.intent;
  if (!intent || evaluated.encoded === null) throw new Error("Expected admitted delta intent");
  expect(intent.effects.map((effect) => effect.type)).toEqual(["inventoryOwnership", "lotChanges"]);
  const beforeBytes = encodeDurableBook(before);
  const prior = await projectLegacyIndexedBook(beforeBytes);
  let reads = 0;
  await expect(
    prepareIndexedBookOutcome(
      prior.state,
      { kind: "commit", intent, previousRevision: workflowValue(before.state.revisions.at(-1)) },
      async (digest) => {
        reads++;
        return prior.readNode(digest);
      },
    ),
  ).rejects.toThrow("Legacy ordinal-index projection does not support lot changes");
  expect(reads).toBe(0);
  const after = { state: evaluated.transition.state, protocol: evaluated.transition.protocol };
  await expect(projectLegacyIndexedBook(encodeDurableBook(after))).rejects.toThrow(
    "indexed_state_lot_changes_unsupported",
  );
  const scope = {
    tenantId: "owned-boundary",
    bookId: BOOK,
    objectId: "owned-boundary-object",
    namespaceId: "owned-boundary-namespace",
    generation: "0",
  };
  const record = compactOutcomeRecord(
    scope,
    compactGenesisHead(scope, beforeBytes),
    after,
    evaluated.encoded,
  );
  const audit = auditRecoveredInventoryPostings(after.state, { scope, head: record.after });
  expect(audit.disposition).toBe("requiresReview");
  if (audit.disposition !== "requiresReview")
    throw new Error("Legacy attribution cannot certify native owned deltas");
  expect(audit.findings.some((finding) => finding.code === "unsupported_owned_effect")).toBe(true);
  expect(() => projectOutcomeSource(record, verifiedOutcomeRecordHash(record))).toThrow(
    "Legacy ordinal-index sources do not support lot changes",
  );
  const expected = projectVerifiedIdentityEntries(after, 2n)
    .filter((identity) => identity.outcomeSequence === 2n)
    .map(({ family, id }) => [family, id])
    .sort();
  const delta = await prepareOutcomeIdentityDelta(evaluated.encoded, BOOK, 2n, async () => null);
  expect(delta.map(({ family, id }) => [family, id]).sort()).toEqual(expected);
});

test("pre-extraction owned history preserves exact cents, canonical bytes and retained rejection retries", async () => {
  // Emitted by the preserved pre-extraction kernel, never by the new preparation
  // implementation. Do not regenerate to make changed historical hashes pass.
  const encoded = (
    await Bun.file(
      new URL("./data/owned-inventory-preparation-baseline.json", import.meta.url),
    ).text()
  ).trim();
  const restored = decodeDurableBook(encoded);
  expect(restored.disposition).toBe("decoded");
  if (restored.disposition !== "decoded") throw new Error(restored.message);
  const aggregate = restored.aggregate;
  expect(encodeDurableBook(aggregate)).toBe(encoded);
  expect(
    aggregate.state.inventoryOwnershipEffects?.[0]?.newAnchors.map((anchor) =>
      anchor.postedBudget.toString(),
    ),
  ).toEqual(["0.00", "0.01", "0.00"]);
  expect(
    aggregate.state.lotHoldings.map((holding) => holding.remainingQuantity.toString()),
  ).toEqual(["0/1", "0/1", "0/1"]);
  expect(aggregate.protocol.retainedResults.map((result) => result.outcome)).toEqual([
    "committed",
    "committed",
    "committed",
    "rejected",
  ]);
  const prior = workflowValue(aggregate.protocol.retainedResults.at(-1));
  const replay = executeBookCommand(aggregate.state, aggregate.protocol, prior.command);
  expect(replay.result.disposition).toBe("replayed");
  expect(replay.result.resultHash).toEqual(prior.resultHash);
  expect(encodeDurableBook({ state: replay.state, protocol: replay.protocol })).toBe(encoded);
});

test("indexed ownership uses exact immutable revision rows and survives real owner publication and reconstruction", async () => {
  const { initial, before, command } = ownershipFixture();
  const evaluated = evaluateOutcomePayload(before, command);
  expect(
    evaluated.transition.result.disposition,
    JSON.stringify(evaluated.transition.result.diagnostics),
  ).toBe("committed");
  if (!evaluated.encoded || !evaluated.transition.intent)
    throw new Error("Expected actual owned commit");
  const after = { state: evaluated.transition.state, protocol: evaluated.transition.protocol };
  expect(after.state.inventoryOwnershipEffects).toHaveLength(1);
  const afterBytes = encodeDurableBook(after),
    beforeBytes = encodeDurableBook(before);
  const replayed = replayOutcomePayload(before, evaluated.encoded);
  expect(encodeDurableBook({ state: replayed.state, protocol: replayed.protocol })).toBe(
    afterBytes,
  );
  const logical = await projectLegacyLogicalBook(afterBytes);
  const projected = await projectLegacyIndexedBook(afterBytes);
  expect(logical.collections).toHaveLength(24);
  expect(projected.state.collections).toHaveLength(24);
  const ownershipRevision = encodeBookRow(
    "state.revisions",
    workflowValue(after.state.revisions.at(-1)),
  );
  const retainedRow = encodeBookRow(
    "protocol.retainedResults",
    workflowValue(after.protocol.retainedResults.at(-1)),
  );
  expect(() =>
    resolveInventoryIdentity(
      retainedRow,
      ownershipRevision,
      "another-book",
      "anchor",
      "owned-boundary-anchor",
    ),
  ).toThrow("index_identity_source_mismatch");
  expect(() =>
    resolveInventoryIdentity(retainedRow, ownershipRevision, BOOK, "anchor", "wrong-anchor"),
  ).toThrow("index_identity_source_mismatch");
  expect(() =>
    resolveInventoryIdentity(
      retainedRow,
      ownershipRevision,
      BOOK,
      "not-a-kind" as never,
      "owned-boundary-anchor",
    ),
  ).toThrow("index_identity_family_invalid");
  expect(() =>
    resolveInventoryIdentity(
      encodeBookRow("protocol.retainedResults", workflowValue(before.protocol.retainedResults[0])),
      ownershipRevision,
      BOOK,
      "anchor",
      "owned-boundary-anchor",
    ),
  ).toThrow("index_identity_source_mismatch");
  expect(
    workflowValue(logical.collections.find((c) => c.name === "state.revisions")).rows.at(-1)
      ?.encoded,
  ).toBe(ownershipRevision);
  const identities = projectVerifiedIdentityEntries(after, 2n);
  const ownedIdentities = identities
    .filter((identity) => identity.outcomeSequence === 2n)
    .map(({ family, id }) => [family, id])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const expectedIds = [
    ["command", "owned-boundary"],
    ["inventoryOperation", "owned-boundary-operation"],
    ["inventoryAnchor", "owned-boundary-anchor"],
    ["inventoryMovement", "owned-boundary-movement"],
    ["lot", "owned-boundary-lot"],
    ["lotHolding", "owned-boundary-holding"],
  ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  expect(ownedIdentities).toEqual(expectedIds);
  let lookups = 0;
  const delta = await prepareOutcomeIdentityDelta(evaluated.encoded, BOOK, 2n, async () => {
    lookups++;
    return null;
  });
  expect(
    delta
      .map(({ family, id }) => [family, id])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ).toEqual(expectedIds);
  expect(lookups).toBe(6);
  const prior = await projectLegacyIndexedBook(beforeBytes);
  const indexedBytes = JSON.stringify(prior.state);
  const candidate = await prepareIndexedBookOutcome(
    prior.state,
    {
      kind: "commit",
      intent: evaluated.transition.intent,
      previousRevision: workflowValue(before.state.revisions.at(-1)),
    },
    prior.readNode,
  );
  expect(candidate.state).toEqual(projected.state);
  expect(candidate.encodedOutcome).toBe(evaluated.encoded);
  expect(candidate.rows.find((row) => row.collection === "state.revisions")?.encoded).toBe(
    ownershipRevision,
  );
  expect(JSON.stringify(prior.state)).toBe(indexedBytes);
  const { inventoryOwnershipEffects: _omitted, ...withoutOwnership } = after.state;
  const forgedAlias = encodeDurableBook({
    protocol: after.protocol,
    state: { ...withoutOwnership, contentHash: hashBookState(withoutOwnership) },
  });
  await expect(projectLegacyIndexedBook(forgedAlias)).rejects.toThrow(
    "indexed_state_legacy_source_invalid",
  );
  await expect(projectLegacyLogicalBook(forgedAlias)).rejects.toThrow(
    "logical_book_source_invalid",
  );
  const scope = {
    tenantId: "owned-boundary",
    bookId: BOOK,
    objectId: "owned-boundary-object",
    namespaceId: "owned-boundary-namespace",
    generation: "0",
  };
  const record = compactOutcomeRecord(
    scope,
    compactGenesisHead(scope, beforeBytes),
    after,
    evaluated.encoded,
  );
  const source = projectOutcomeSource(record, verifiedOutcomeRecordHash(record));
  expect(
    source.groups.find((group) => group.collection === "state.revisions")?.rows[0]?.encoded,
  ).toBe(ownershipRevision);
  expect(encodeDurableBook(before)).toBe(beforeBytes);
  expect(encodeDurableBook(after)).toBe(afterBytes);

  // Actual canonical/source/group/permanent-ID publication, not just projection.
  const { db, open } = ownerDatabase("ownership-recovery", INDEXED_OWNERSHIP_GROUP_CATALOG_FORMAT);
  try {
    const owner = open();
    await owner.provision(initial);
    const activatedReceipt = await owner.execute(activation());
    expect(activatedReceipt.result.disposition).toBe("committed");
    const ownedReceipt = await owner.execute(command);
    expect(ownedReceipt.result.disposition).toBe("committed");
    expect(ownedReceipt.outcomeSequence).toBe(2n);
    expect(ownedReceipt.result.resultHash).toEqual(evaluated.transition.result.resultHash);
    const retainedAfter = await owner.read();
    expect(retainedAfter.head).toEqual(ownedReceipt.head);
    expect(encodeDurableBook(retainedAfter.aggregate)).toBe(afterBytes);
    const reader = await owner.openCurrentRowReader();
    try {
      const retained = await reader.readCommand(command.id);
      expect(retained.row?.resultHash).toEqual(evaluated.transition.result.resultHash);
      const revision = await reader.readTyped("state.revisions", 2n);
      expect(revision.encoded).toBe(ownershipRevision);
      const anchor = await reader.readInventoryIdentity("anchor", "owned-boundary-anchor");
      expect(anchor.disposition).toBe("present");
      expect(anchor.row).toEqual(
        workflowValue(after.state.inventoryOwnershipEffects?.[0]?.newAnchors[0]),
      );
      expect(anchor.outcomeSequence).toBe(2n);
      expect(anchor.bookRevision).toBe(2n);
      expect(anchor.sourceRevisionRowHash).toBe(revision.rowHash);
      const operation = await reader.readInventoryIdentity("operation", "owned-boundary-operation");
      expect(operation.row).toEqual(workflowValue(command.request.operations[0]));
      const movement = await reader.readInventoryIdentity("movement", "owned-boundary-movement");
      expect(movement.row).toEqual(
        workflowValue(after.state.inventoryOwnershipEffects?.[0]?.quantityOnlyMovements[0]),
      );
      const absent = await reader.readInventoryIdentity("anchor", "not-an-anchor");
      expect(absent.disposition).toBe("absent");
      expect(absent.row).toBeNull();
      const position = await reader.readInventoryPosition("owned-boundary-holding");
      expect(position.disposition).toBe("owned");
      expect(position.position?.consumedQuantity.toString()).toBe("0/1");
      expect(position.position?.originMovementId).toBe(
        identifier<"InventoryPostedMovement">("owned-boundary-movement"),
      );
      expect(position.groupPopulation).toBe(1n);
      expect((await reader.readInventoryPosition("absent-holding")).disposition).toBe("absent");
    } finally {
      await reader.close();
    }
    const retry = await owner.execute(activation());
    expect(retry.result.disposition).toBe("replayed");
    expect(retry.result.resultHash).toEqual(activatedReceipt.result.resultHash);
    const ownershipRetry = await owner.execute(command);
    expect(ownershipRetry.result.disposition).toBe("replayed");
    expect(ownershipRetry.result.resultHash).toEqual(ownedReceipt.result.resultHash);
    expect(ownershipRetry.head).toEqual(ownedReceipt.head);
    const unsupported = sealCommand({
      ...command,
      id: commandId("unsupported-ownership"),
      expectedBookRevision: 2n,
      request: { ...command.request, algorithm: "unsupported" },
    });
    const staleReader = await owner.openCurrentRowReader();
    const rejection = await owner.execute(unsupported);
    expect(rejection.result.disposition).toBe("rejected");
    expect(rejection.outcomeSequence).toBe(3n);
    await expect(staleReader.readInventoryPosition("owned-boundary-holding")).rejects.toThrow(
      "indexed_canonical_head_conflict",
    );
    await expect(staleReader.readCommand(command.id)).rejects.toThrow(
      "source_catalog_reader_closed",
    );
    await staleReader.close();
    const acquire = workflowValue(command.request.operations[0]);
    const issue = sealCommand({
      ...command,
      id: commandId("owned-boundary-issue"),
      expectedBookRevision: 2n,
      request: {
        ...command.request,
        operations: [
          {
            kind: "issue",
            ordinal: 0n,
            id: identifier<"InventoryOperation">("owned-boundary-issue-operation"),
            coordinate: acquire.coordinate,
            inventoryPolicy: acquire.inventoryPolicy,
            derivation: acquire.derivation,
            quantity: R.of(1n, 1n),
            identities: [
              {
                holdingId: lotHoldingId("owned-boundary-holding"),
                allocationId: lotAllocationId("owned-boundary-allocation"),
                movementId: identifier<"InventoryPostedMovement">("owned-boundary-issue-movement"),
              },
            ],
          },
        ],
      },
    });
    const expectedRejection = evaluateOutcomePayload(after, unsupported);
    const expectedIssue = evaluateOutcomePayload(
      {
        state: expectedRejection.transition.state,
        protocol: expectedRejection.transition.protocol,
      },
      issue,
    );
    expect(expectedIssue.transition.result.disposition).toBe("committed");
    const issueReceipt = await owner.execute(issue);
    expect(issueReceipt.result.disposition).toBe("committed");
    expect(issueReceipt.outcomeSequence).toBe(4n);
    expect(issueReceipt.result.observedBookRevision).toBe(3n);
    expect(issueReceipt.result.resultHash).toEqual(expectedIssue.transition.result.resultHash);
    const completed = await owner.read();
    expect(encodeDurableBook(completed.aggregate)).toBe(
      encodeDurableBook({
        state: expectedIssue.transition.state,
        protocol: expectedIssue.transition.protocol,
      }),
    );
    expect(completed.aggregate.state.latestPostingSequence).toBe(0n);
    expect(completed.aggregate.state.lotHoldings[0]?.remainingQuantity.toString()).toBe("0/1");
    expect(completed.aggregate.state.lotAllocations).toEqual([]);
    const issueReader = await owner.openCurrentRowReader();
    try {
      const allocation = await issueReader.readInventoryIdentity(
        "quantityAllocation",
        "owned-boundary-allocation",
      );
      expect(allocation.disposition).toBe("present");
      if (allocation.disposition !== "present")
        throw new Error("Expected owned quantity allocation");
      expect(allocation.outcomeSequence).toBe(4n);
      expect(allocation.bookRevision).toBe(3n);
      const issueRevision = await issueReader.readTyped("state.revisions", 3n);
      if (issueRevision.disposition !== "present" || issueRevision.rowHash === null)
        throw new Error("Expected creating revision");
      expect(allocation.sourceRevisionRowHash).toBe(issueRevision.rowHash);
      const ownerEffect = completed.aggregate.state.inventoryOwnershipEffects?.[1];
      const actualMovement = ownerEffect?.quantityOnlyMovements[0];
      if (!actualMovement || !isInventoryPostedReductionMovement(actualMovement))
        throw new Error("Expected actual disposal movement");
      expect(allocation.row).toEqual(actualMovement.quantityAllocation);
      expect(Object.hasOwn(workflowValue(allocation.row), "journalPostingId")).toBe(false);
      const position = await issueReader.readInventoryPosition("owned-boundary-holding");
      expect(position.disposition).toBe("owned");
      expect(position.position).toEqual(actualMovement.afterPosition);
      expect(position.revisionOrdinal).toBe(3n);
      expect(position.revisionRowHash).toBe(issueRevision.rowHash);
      expect(position.groupPopulation).toBe(2n);
      const cursor = await issueReader.openGroup(
        "inventoryRevisionsByHolding",
        ["owned-boundary-holding"],
        1,
      );
      const page1 = await cursor.next(),
        page2 = await cursor.next();
      expect(page1.rows.map((row) => row.ordinal)).toEqual([2n]);
      expect(page1.complete).toBe(false);
      expect(page2.rows.map((row) => row.ordinal)).toEqual([3n]);
      expect(page2.complete).toBe(true);
      expect(page2.consumed).toBe(2n);
      await cursor.close();
    } finally {
      await issueReader.close();
    }
    const rejectedRetry = await owner.execute(unsupported);
    expect(rejectedRetry.result.disposition).toBe("replayed");
    expect(rejectedRetry.outcomeSequence).toBe(3n);
    expect(rejectedRetry.result.resultHash).toEqual(rejection.result.resultHash);
    const issueRetry = await owner.execute(issue);
    expect(issueRetry.result.disposition).toBe("replayed");
    expect(issueRetry.outcomeSequence).toBe(4n);
    expect(issueRetry.result.resultHash).toEqual(issueReceipt.result.resultHash);
    expect(encodeDurableBook((await open().read()).aggregate)).toBe(
      encodeDurableBook(completed.aggregate),
    );
    const damageReader = await open().openCurrentRowReader();
    const descriptor = db
      .query<{ body: string }, []>("SELECT body FROM ledger_indexed_group_descriptors")
      .all()
      .map((row) => JSON.parse(String(row.body)))
      .find(
        (row) =>
          row.key.kind === "inventoryRevisionsByHolding" &&
          row.key.values[0] === "owned-boundary-holding" &&
          row.population === "2",
      );
    expect(descriptor).toBeDefined();
    const digest = JSON.parse(descriptor.memberRoot).tree.digest as string;
    const stored = db
      .query<{ body: string }, [string]>(
        "SELECT body FROM ledger_indexed_group_nodes WHERE digest = ?",
      )
      .get(digest);
    expect(stored).not.toBeNull();
    if (stored === null) throw new Error("Expected current ownership group node");
    db.query("DELETE FROM ledger_indexed_group_nodes WHERE digest = ?").run(digest);
    try {
      await expect(damageReader.readInventoryPosition("owned-boundary-holding")).rejects.toThrow(
        "logical_map_node_missing",
      );
      await expect(damageReader.readCommand(command.id)).rejects.toThrow(
        "source_catalog_reader_closed",
      );
    } finally {
      await damageReader.close();
      db.query("INSERT INTO ledger_indexed_group_nodes (digest, body) VALUES (?, ?)").run(
        digest,
        stored.body,
      );
    }
    expect(encodeDurableBook((await open().read()).aggregate)).toBe(
      encodeDurableBook(completed.aggregate),
    );
  } finally {
    db.close();
  }
}, 60000);

test("paid ownership publishes one real penny, rolls back all participants, and retains shared posting references once", async () => {
  const { initial, before, command } = ownershipFixture();
  const operation = workflowValue(command.request.operations[0]),
    originalEntry = workflowValue(operation.entries[0]);
  const units = before.state.identity.functionalCommodityId;
  const realJournal = (id: string, reducing: boolean): ResolvedTransaction => {
    const template = posting(id);
    if (template.type !== "postJournal") throw new Error("Expected journal template");
    const raw = template.resolved.journal,
      sign = reducing ? -1n : 1n;
    const source = {
      ...raw,
      postings: [
        {
          ...workflowValue(raw.postings[0]),
          units: { canonicalNumber: R.of(3n * sign, 1n), commodityId: units },
          bookValue: { amount: D.of(sign, 2n), functionalCommodityId: units },
          costBasis: { totalBasis: R.of(sign, 100n), basisCommodityId: units },
        },
        {
          ...workflowValue(raw.postings[1]),
          units: { canonicalNumber: R.of(-sign, 100n), commodityId: units },
          bookValue: { amount: D.of(-sign, 2n), functionalCommodityId: units },
        },
      ],
    };
    const result = resolveJournal(
      source,
      before.state.policies,
      before.state.identity.ownerId,
      workflowValue(before.state.quantizationPolicies[0]),
      source.postings.map((p) => p.bookValue.amount.toRational()),
    );
    if (Array.isArray(result)) throw new Error(JSON.stringify(result));
    return result as ResolvedTransaction;
  };
  const acquiredJournal = realJournal("paid-acquire-journal", false),
    issuedJournal = realJournal("paid-issue-journal", true);
  const entries = ["a", "b", "c"].map((id) => ({
    ...originalEntry,
    anchorId: identifier<"InventoryPostedAnchor">(`paid-anchor-${id}`),
    movementId: identifier<"InventoryPostedMovement">(`paid-acquire-${id}`),
    lot: {
      ...originalEntry.lot,
      id: lotId(`paid-lot-${id}`),
      acquisitionTotalBasis: R.of(1n, 300n),
    },
    holding: {
      ...originalEntry.holding,
      id: lotHoldingId(`paid-holding-${id}`),
      lotId: lotId(`paid-lot-${id}`),
      remainingTotalBasis: R.of(1n, 300n),
      remainingCarryingAmount: R.of(1n, 300n),
    },
  }));
  const acquire = sealCommand({
    ...command,
    id: commandId("paid-acquire"),
    request: {
      ...command.request,
      resolvedJournals: [acquiredJournal],
      operations: [
        {
          ...operation,
          id: identifier<"InventoryOperation">("paid-acquire-operation"),
          entries,
          postingLink: {
            journalOrdinal: 0n,
            postingId: workflowValue(acquiredJournal.journal.postings[0]).id,
            referenceId: canonicalPostingReferenceId("paid-acquire-reference"),
          },
        },
      ],
    },
  });
  const issue = sealCommand({
    ...command,
    id: commandId("paid-issue"),
    expectedBookRevision: 2n,
    request: {
      ...command.request,
      resolvedJournals: [issuedJournal],
      operations: [
        {
          kind: "issue",
          ordinal: 0n,
          id: identifier<"InventoryOperation">("paid-issue-operation"),
          coordinate: operation.coordinate,
          inventoryPolicy: operation.inventoryPolicy,
          derivation: operation.derivation,
          quantity: R.of(3n, 1n),
          identities: ["a", "b", "c"].map((id) => ({
            holdingId: lotHoldingId(`paid-holding-${id}`),
            allocationId: lotAllocationId(`paid-allocation-${id}`),
            movementId: identifier<"InventoryPostedMovement">(`paid-issue-${id}`),
          })),
          postingLink: {
            journalOrdinal: 0n,
            postingId: workflowValue(issuedJournal.journal.postings[0]).id,
            referenceId: canonicalPostingReferenceId("paid-issue-reference"),
          },
        },
      ],
    },
  });
  const expected = evaluateOutcomePayload(before, acquire);
  expect(expected.transition.result.disposition).toBe("committed");
  // Full-kernel differential control: an accounting source ID is occupied even
  // though the inventory-only identity family has never contained it.
  const allocation = allocationAndTaxWorkflow("1.1.0");
  const config = initial.state.activeConfigurationSnapshot;
  let mixed = {
    protocol: initial.protocol,
    state: createBookState(
      initial.state.identity,
      config.periods,
      {
        ...config.admissionSnapshot,
        accounts: [
          ...config.admissionSnapshot.accounts,
          ...allocation.initial.state.admissionSnapshot.accounts.filter(
            (account) =>
              !config.admissionSnapshot.accounts.some((existing) => existing.id === account.id),
          ),
        ],
      },
      config.policies,
      config.quantizationPolicies,
      [
        ...initial.state.accountingPolicySnapshot.policies,
        ...allocation.initial.state.accountingPolicySnapshot.policies,
      ],
      config.effectiveAt,
      STRUCTURAL_SOURCE_IDENTITY_PROFILE,
    ),
  };
  const mixedInitial = mixed;
  const mixedCommands = [...allocation.commands.slice(0, 3), posting("restore-opening-cash", 3n)];
  for (const input of mixedCommands) {
    const step = executeBookCommand(mixed.state, mixed.protocol, input);
    expect(step.result.disposition, JSON.stringify(step.result.diagnostics)).toBe("committed");
    mixed = { state: step.state, protocol: step.protocol };
  }
  const fresh = sealCommand({
    ...acquire,
    expectedBookRevision: 4n,
    issuedAt: instant("2026-01-15T15:00:00Z"),
    completedAt: instant("2026-01-15T15:00:01Z"),
    committedAt: instant("2026-01-15T15:00:02Z"),
  });
  const collision = sealCommand({
    ...fresh,
    request: {
      ...fresh.request,
      operations: fresh.request.operations.map((entry) => ({
        ...entry,
        postingLink: {
          ...workflowValue(entry.postingLink),
          referenceId: canonicalPostingReferenceId("workflow-source-reference"),
        },
      })),
    },
  });
  const refused = executeBookCommand(mixed.state, mixed.protocol, collision);
  expect(refused.result.disposition).toBe("rejected");
  expect(encodeDurableBook({ state: refused.state, protocol: mixed.protocol })).toBe(
    encodeDurableBook(mixed),
  );
  const admitted = executeBookCommand(mixed.state, mixed.protocol, fresh);
  expect(admitted.result.disposition, JSON.stringify(admitted.result.diagnostics)).toBe(
    "committed",
  );
  const mixedOwner = ownerDatabase(
    "mixed-reference-preparation",
    INDEXED_REFERENCE_GROUP_CATALOG_FORMAT,
  );
  try {
    const mOwner = mixedOwner.open();
    await mOwner.provision(mixedInitial);
    for (const input of mixedCommands)
      expect((await mOwner.execute(input)).result.disposition).toBe("committed");
    const sources = await mOwner.openCurrentRowReader();
    try {
      await assertIndexedPreparation(sources, collision, mixed);
      await assertIndexedPreparation(sources, fresh, mixed);
    } finally {
      await sources.close();
    }
  } finally {
    mixedOwner.db.close();
  }
  const { db, open, faults } = ownerDatabase(
    "paid-ownership",
    INDEXED_REFERENCE_GROUP_CATALOG_FORMAT,
  );
  const moneyScope = {
    bookId: BOOK,
    accountId: CASH,
    functionalCommodityId: units,
    dimensionMemberIds: [],
  };
  try {
    const owner = open();
    await owner.provision(initial);
    expect((await owner.execute(activation())).result.disposition).toBe("committed");
    const prior = await owner.read();
    const emptyReader = await owner.openCurrentRowReader();
    try {
      expect((await assertIndexedPreparation(emptyReader, acquire, before)).reads).toBe(19);
      const money = await emptyReader.readInventoryMoneyScope(moneyScope);
      expect(money.ownership).toBe("unmanaged");
      expect(money.postedBalance.toString()).toBe("0/1");
      expect(money.journals.population).toBe(0n);
      expect(money.journals.descriptorHash).toBeNull();
      expect(
        (await emptyReader.readInventorySourceJournal(acquiredJournal.journal.id)).disposition,
      ).toBe("unreferenced");
    } finally {
      await emptyReader.close();
    }
    faults.afterSql = "UPDATE ledger_indexed_source_catalog SET";
    await expect(owner.execute(acquire)).rejects.toThrow("injected ownership publication failure");
    expect(faults.afterSql).toBe(""); // The actual post-write fault ran.
    const recoveredOwner = open();
    const recovered = await recoveredOwner.read();
    expect(recovered.head).toEqual(prior.head);
    expect(encodeDurableBook(recovered.aggregate)).toBe(encodeDurableBook(before));
    const preRetry = await recoveredOwner.openCurrentRowReader();
    try {
      expect((await preRetry.readCommand(acquire.id)).disposition).toBe("absent");
      expect((await preRetry.readInventoryPosition("paid-holding-b")).disposition).toBe("absent");
      expect((await preRetry.readInventoryIdentity("anchor", "paid-anchor-b")).disposition).toBe(
        "absent",
      );
      expect((await preRetry.readInventoryMoneyScope(moneyScope)).journals.population).toBe(0n);
      expect((await preRetry.readPostingReferenceUsage("paid-acquire-reference")).disposition).toBe(
        "unused",
      );
    } finally {
      await preRetry.close();
    }
    faults.afterSql = "UPDATE ledger_indexed_group_catalog SET";
    await expect(recoveredOwner.execute(acquire)).rejects.toThrow(
      "injected ownership publication failure",
    );
    expect(faults.afterSql).toBe("");
    const rolledBackOwner = open();
    const rolledBack = await rolledBackOwner.openCurrentRowReader();
    try {
      const money = await rolledBack.readInventoryMoneyScope(moneyScope);
      expect(money.ownership).toBe("unmanaged");
      expect(money.journals.population).toBe(0n);
      expect(money.postedBalance.toString()).toBe("0/1");
      expect(
        (await rolledBack.readPostingReferenceUsage("paid-acquire-reference")).disposition,
      ).toBe("unused");
    } finally {
      await rolledBack.close();
    }
    const activeOwner = rolledBackOwner;
    const receipt = await activeOwner.execute(acquire);
    expect(receipt.result.disposition).toBe("committed");
    expect(receipt.outcomeSequence).toBe(2n);
    expect(receipt.result.resultHash).toEqual(expected.transition.result.resultHash);
    const acquired = (await activeOwner.read()).aggregate;
    expect(encodeDurableBook(acquired)).toBe(
      encodeDurableBook({
        state: expected.transition.state,
        protocol: expected.transition.protocol,
      }),
    );
    expect(
      acquired.state.inventoryOwnershipEffects?.[0]?.newAnchors.map((anchor) =>
        anchor.postedBudget.toString(),
      ),
    ).toEqual(["0.00", "0.01", "0.00"]);
    expect(
      projectVerifiedIdentityEntries(acquired, 2n)
        .filter((entry) => entry.family === "inventoryPostingReference")
        .map((entry) => entry.id),
    ).toEqual(["paid-acquire-reference"]);
    const originalRevision = workflowValue(acquired.state.revisions.at(-1));
    const conflictedRevision = {
      ...originalRevision,
      effects: originalRevision.effects.map((effect) =>
        effect.type !== "inventoryOwnership"
          ? effect
          : {
              ...effect,
              value: {
                ...effect.value,
                newAnchors: effect.value.newAnchors.map((anchor, i) =>
                  i !== 0
                    ? anchor
                    : {
                        ...anchor,
                        sourcePostings: anchor.sourcePostings.map((source) => ({
                          ...source,
                          journalId: journalId("conflicting-reference-source"),
                        })),
                      },
                ),
              },
            },
      ),
    };
    // Structural selector defense only: this forged row is not authenticated
    // canonical input. Same-ID references may collapse only when fully identical.
    expect(() =>
      resolveInventoryIdentity(
        encodeBookRow(
          "protocol.retainedResults",
          workflowValue(acquired.protocol.retainedResults.at(-1)),
        ),
        encodeBookRow("state.revisions", conflictedRevision),
        BOOK,
        "postingReference",
        "paid-acquire-reference",
      ),
    ).toThrow("index_identity_source_mismatch");
    const reader = await activeOwner.openCurrentRowReader();
    try {
      const money = await reader.readInventoryMoneyScope(moneyScope);
      expect(money.ownership).toBe("managed");
      expect(money.postedBalance.toString()).toBe("1/100");
      expect(money.journals.population).toBe(1n);
      expect(money.ownershipWitness?.revisionOrdinal).toBe(2n);
      expect(money.ownershipWitness?.population).toBe(1n); // Three movements, one revision member.
      expect(
        (await reader.readInventorySourceJournal(acquiredJournal.journal.id)).witness
          ?.revisionOrdinal,
      ).toBe(2n);
      const reference = await reader.readInventoryIdentity(
        "postingReference",
        "paid-acquire-reference",
      );
      expect(reference.disposition).toBe("present");
      if (reference.disposition !== "present")
        throw new Error("Expected acquisition source reference");
      expect(
        (
          await reader.readJournalIdentity("posting", reference.row.postingId)
        ).posting?.bookValue.amount.toString(),
      ).toBe("0.01");
      expect(reference.row?.postingId).toBe(workflowValue(acquiredJournal.journal.postings[0]).id);
      expect(reference.outcomeSequence).toBe(2n);
      const facts = await reader.readOwnedInventoryPools(issue);
      expect((await assertIndexedPreparation(reader, issue, acquired)).reads).toBe(19);
      expect(facts.pools).toHaveLength(1);
      const pool = workflowValue(facts.pools[0]);
      expect(pool.disposition).toBe("resolved");
      if (pool.disposition !== "resolved") throw new Error("Expected resolved inventory pool");
      expect(pool.entries.map((entry) => entry.holding.id)).toEqual([
        lotHoldingId("paid-holding-a"),
        lotHoldingId("paid-holding-b"),
        lotHoldingId("paid-holding-c"),
      ]);
      expect(pool.entries.map((entry) => entry.holding.remainingTotalBasis.toString())).toEqual([
        "1/300",
        "1/300",
        "1/300",
      ]);
      expect(pool.accounts.map((account) => account.population)).toEqual([0n, 3n, 0n]);
      const operation = workflowValue(issue.request.operations[0]);
      if (operation.kind !== "issue") throw new Error("Expected issue operation");
      const selectionRequest = {
        policyId: pool.policy.id,
        policyVersion: pool.policy.version,
        governedAt: issue.request.governedAt,
        inventoryCommodityId: operation.coordinate.unitsCommodityId,
        quantity: operation.quantity,
        derivation: operation.derivation,
        identities: operation.identities,
      };
      const selected = prepareInventoryOwnershipSelection(
        [pool.policy],
        BOOK,
        pool.entries,
        selectionRequest,
      );
      const expectedPool = acquired.state.lotHoldings
        .filter(
          (holding) =>
            pool.policy.pools.some((p) => p.accountId === holding.accountId) &&
            holding.commodityId === operation.coordinate.unitsCommodityId,
        )
        .map((holding) => ({
          holding,
          lot: workflowValue(acquired.state.lots.find((lot) => lot.id === holding.lotId)),
        }));
      expect(selected).toEqual(
        prepareInventoryOwnershipSelection([pool.policy], BOOK, expectedPool, selectionRequest),
      );
      expect(selected.disposition).toBe("selected");
      expect(facts.commandInputHash).toEqual(commandInputHash(issue));
    } finally {
      await reader.close();
    }
    const issued = await activeOwner.execute(issue);
    expect(issued.result.disposition).toBe("committed");
    const final = (await activeOwner.read()).aggregate;
    expect(final.state.latestPostingSequence).toBe(2n);
    expect(final.state.lotHoldings.map((holding) => holding.remainingQuantity.toString())).toEqual([
      "0/1",
      "0/1",
      "0/1",
    ]);
    const cash = final.state.journals
      .flatMap((journal) => journal.journal.postings)
      .filter((p) => p.accountId === CASH)
      .reduce((sum, p) => sum.add(p.bookValue.amount.toRational()), R.zero());
    expect(cash.toString()).toBe("0/1");
    expect(final.state.inventoryOwnershipEffects?.[1]?.quantityOnlyMovements).toHaveLength(2);
    expect(final.state.inventoryOwnershipEffects?.[1]?.journalLinkedMovements).toHaveLength(1);
    expect(final.state.lotAllocations).toEqual([]);
    expect(
      projectVerifiedIdentityEntries(final, 3n)
        .filter((entry) => entry.family === "lotAllocation")
        .map((entry) => entry.id),
    ).toEqual(["paid-allocation-a", "paid-allocation-b", "paid-allocation-c"]);
    const finalReader = await activeOwner.openCurrentRowReader();
    try {
      const money = await finalReader.readInventoryMoneyScope(moneyScope);
      expect(money.ownership).toBe("managed"); // Depletion never relinquishes the money scope.
      expect(money.postedBalance.toString()).toBe("0/1");
      expect(money.journals.population).toBe(2n);
      expect(money.journals.descriptorHash).not.toBeNull(); // Zero is not absent history.
      expect(money.ownershipWitness?.revisionOrdinal).toBe(3n);
      expect(money.ownershipWitness?.population).toBe(2n);
      expect(
        (await finalReader.readInventorySourceJournal(issuedJournal.journal.id)).witness
          ?.revisionOrdinal,
      ).toBe(3n);
      expect(
        (await finalReader.readInventorySourceJournal(acquiredJournal.journal.id)).witness
          ?.revisionOrdinal,
      ).toBe(2n);
      const reference = await finalReader.readInventoryIdentity(
        "postingReference",
        "paid-issue-reference",
      );
      for (const [id, ordinal] of [
        ["paid-acquire-reference", 2n],
        ["paid-issue-reference", 3n],
      ] as const) {
        const usage = await finalReader.readPostingReferenceUsage(id);
        expect(usage.disposition).toBe("used");
        expect(usage.witness?.population).toBe(1n); // Three anchors/movements share one source.
        expect(usage.witness?.revisionOrdinal).toBe(ordinal);
      }
      if (reference.disposition !== "present") throw new Error("Expected issue source reference");
      expect(
        (
          await finalReader.readJournalIdentity("posting", reference.row.postingId)
        ).posting?.bookValue.amount.toString(),
      ).toBe("-0.01");
      const allocation = await finalReader.readInventoryIdentity(
        "quantityAllocation",
        "paid-allocation-b",
      );
      expect(await finalReader.readAllocationIdentityPresence("paid-allocation-b")).toMatchObject({
        disposition: "present",
        origin: "owned",
      });
      await assertIndexedPreparation(
        finalReader,
        sealCommand({ ...issue, id: commandId("duplicate-owned-issue"), expectedBookRevision: 3n }),
        final,
      );
      expect(allocation.row?.allocatedTotalBasis.toString()).toBe("1/300");
      expect(allocation.outcomeSequence).toBe(3n);
      const position = await finalReader.readInventoryPosition("paid-holding-b");
      expect(position.disposition).toBe("owned");
      expect(position.position?.consumedPosted.toString()).toBe("0.01");
      expect(position.position?.consumedQuantity.toString()).toBe("1/1");
      expect(position.revisionOrdinal).toBe(3n);
      const depleted = await finalReader.readOwnedInventoryPools(issue);
      const pool = workflowValue(depleted.pools[0]);
      if (pool.disposition !== "resolved") throw new Error("Expected depleted canonical pool");
      expect(pool.entries).toHaveLength(3);
      expect(pool.entries.map((entry) => entry.holding.remainingQuantity.toString())).toEqual([
        "0/1",
        "0/1",
        "0/1",
      ]);
    } finally {
      await finalReader.close();
    }
    expect((await activeOwner.execute(issue)).result.resultHash).toEqual(issued.result.resultHash);
    expect(encodeDurableBook((await open().read()).aggregate)).toBe(encodeDurableBook(final));
  } finally {
    db.close();
  }
}, 180000);

test("ownership group profiles never silently adopt old catalogs or report unsupported absence", async () => {
  const { initial, command } = ownershipFixture();
  const f = ownerDatabase("old-ownership-groups");
  try {
    const owner = f.open();
    await owner.provision(initial);
    await owner.execute(activation());
    await owner.execute(command);
    const before = await owner.read();
    const catalog = f.db.query("SELECT * FROM ledger_indexed_group_catalog").all();
    const reader = await owner.openCurrentRowReader();
    await expect(reader.readInventoryPosition("owned-boundary-holding")).rejects.toThrow(
      "group_query_profile_unsupported",
    );
    await expect(reader.readCommand(command.id)).rejects.toThrow("source_catalog_reader_closed");
    await reader.close();
    await expect(f.open(INDEXED_OWNERSHIP_GROUP_CATALOG_FORMAT).read()).rejects.toThrow(
      "group_catalog_corrupt",
    );
    expect(f.db.query("SELECT * FROM ledger_indexed_group_catalog").all()).toEqual(catalog);
    expect(encodeDurableBook((await f.open().read()).aggregate)).toBe(
      encodeDurableBook(before.aggregate),
    );
  } finally {
    f.db.close();
  }
});

test("latest owned position uses the last artifact within one revision and never adopts legacy stock", async () => {
  const { initial, before, command } = ownershipFixture();
  const acquisition = workflowValue(command.request.operations[0]);
  const combined = sealCommand({
    ...command,
    request: {
      ...command.request,
      operations: [
        acquisition,
        {
          kind: "issue" as const,
          ordinal: 1n,
          id: identifier<"InventoryOperation">("same-revision-issue"),
          coordinate: acquisition.coordinate,
          inventoryPolicy: acquisition.inventoryPolicy,
          derivation: acquisition.derivation,
          quantity: R.of(1n, 1n),
          identities: [
            {
              holdingId: lotHoldingId("owned-boundary-holding"),
              allocationId: lotAllocationId("same-revision-allocation"),
              movementId: identifier<"InventoryPostedMovement">("same-revision-movement"),
            },
          ],
        },
      ],
    },
  });
  const f = ownerDatabase("same-revision-position", INDEXED_REFERENCE_GROUP_CATALOG_FORMAT);
  try {
    const owner = f.open();
    await owner.provision(initial);
    await owner.execute(activation());
    const preparing = await owner.openCurrentRowReader();
    try {
      await assertIndexedPreparation(preparing, combined, before);
      const overIssue = sealCommand({
        ...combined,
        request: {
          ...combined.request,
          operations: combined.request.operations.map((operation) =>
            operation.kind === "issue" ? { ...operation, quantity: R.of(2n, 1n) } : operation,
          ),
        },
      });
      await assertIndexedPreparation(preparing, overIssue, before);
    } finally {
      await preparing.close();
    }
    expect((await owner.execute(combined)).result.disposition).toBe("committed");
    const reader = await owner.openCurrentRowReader();
    try {
      const position = await reader.readInventoryPosition("owned-boundary-holding");
      expect(position.disposition).toBe("owned");
      expect(position.groupPopulation).toBe(1n);
      expect(position.revisionOrdinal).toBe(2n);
      expect(position.position?.originMovementId).toBe(
        identifier<"InventoryPostedMovement">("same-revision-movement"),
      );
      expect(position.position?.originArtifactOrdinal).toBe(3n);
      expect(position.position?.consumedQuantity.toString()).toBe("1/1");
      expect(Object.isFrozen(position.position)).toBe(true);
    } finally {
      await reader.close();
    }
    await expect(f.open(INDEXED_GROUP_CATALOG_FORMAT).read()).rejects.toThrow(
      "group_catalog_corrupt",
    );
  } finally {
    f.db.close();
  }
  const legacy = inventoryReadWorkflow();
  const old = ownerDatabase("legacy-unowned-position", INDEXED_OWNERSHIP_GROUP_CATALOG_FORMAT);
  try {
    const owner = old.open();
    await owner.provision(legacy.initial);
    let exercised = false;
    for (const command of legacy.commands) {
      await owner.execute(command);
      const holding = (await owner.read()).aggregate.state.lotHoldings[0];
      if (!holding) continue;
      const reader = await owner.openCurrentRowReader();
      try {
        const position = await reader.readInventoryPosition(holding.id);
        expect(position.disposition).toBe("unowned");
        expect(position.current.disposition).toBe("present");
        expect(position.position).toBeNull();
        expect(position.anchor).toBeNull();
        exercised = true;
      } finally {
        await reader.close();
      }
      break;
    }
    expect(exercised).toBe(true);
  } finally {
    old.db.close();
  }
}, 60000);

test("owned pool facts exhaust multi-account sources, deduplicate reads, and distinguish policy failure from empty stock", async () => {
  const scenario = inventoryReadWorkflow();
  const template = ownershipFixture().command;
  const acquisition = workflowValue(template.request.operations[0]);
  const operation = {
    kind: "issue" as const,
    ordinal: 0n,
    id: identifier<"InventoryOperation">("pool-issue"),
    coordinate: acquisition.coordinate,
    inventoryPolicy: acquisition.inventoryPolicy,
    derivation: acquisition.derivation,
    quantity: R.of(1n, 1n),
    identities: [],
  };
  const query = sealCommand({
    ...template,
    id: commandId("owned-pool-query"),
    request: {
      ...template.request,
      operations: [
        operation,
        { ...operation, ordinal: 1n, id: identifier<"InventoryOperation">("pool-second-issue") },
      ],
    },
  });
  const f = ownerDatabase("owned-pool-facts"); // Original seven-group profile suffices for raw pools.
  try {
    const owner = f.open();
    await owner.provision(scenario.initial);
    for (const command of scenario.commands)
      expect((await owner.execute(command)).result.disposition).toBe("committed");
    const aggregate = (await owner.read()).aggregate;
    const expected = aggregate.state.lotHoldings
      .filter(
        (h) =>
          scenario.policy.pools.some((p) => p.accountId === h.accountId) &&
          h.commodityId === operation.coordinate.unitsCommodityId,
      )
      .map((holding) => ({
        holding,
        lot: workflowValue(aggregate.state.lots.find((l) => l.id === holding.lotId)),
      }));
    const reader = await owner.openCurrentRowReader();
    try {
      const basis = await reader.readBookBasis();
      const accountReads: string[] = [],
        lotReads: string[] = [];
      let pages = 0,
        closes = 0;
      const ports = {
        basis: async () => basis,
        openAccount: async (id: string) => {
          accountReads.push(id);
          const cursor = await reader.openGroup("holdingsByAccount", [id], 1);
          return {
            next: async () => {
              pages++;
              return cursor.next();
            },
            close: async () => {
              closes++;
              await cursor.close();
            },
          };
        },
        lot: async (id: string) => {
          lotReads.push(id);
          return reader.readLotIdentity("lot", id);
        },
        confirm: async () => {
          expect((await reader.readBookBasis()).headHash).toBe(basis.headHash);
        },
      };
      const facts = await readPinnedOwnedInventoryPools(query, ports);
      const pool = workflowValue(facts.pools[0]);
      if (pool.disposition !== "resolved") throw new Error("Expected complete multi-account pool");
      expect(pool.entries.map(({ holding, lot }) => ({ holding, lot }))).toEqual(expected);
      expect(pool.operationIndices).toEqual([0, 1]);
      expect(facts.pools).toHaveLength(1);
      expect(accountReads).toEqual(scenario.policy.pools.map((p) => String(p.accountId)));
      expect(new Set(lotReads).size).toBe(lotReads.length);
      expect(lotReads.length).toBe(new Set(expected.map((e) => e.lot.id)).size);
      expect(facts.scannedHoldings).toBe(aggregate.state.lotHoldings.length);
      const encodedSources = [
        ...aggregate.state.lotHoldings.map((h) => encodeBookRow("state.lotHoldings", h)),
        ...aggregate.state.lots
          .filter((lot) => expected.some((e) => e.lot.id === lot.id))
          .map((lot) => encodeBookRow("state.lots", lot)),
      ];
      expect(facts.sourceRowBytes).toBe(
        encodedSources.reduce((sum, encoded) => sum + new TextEncoder().encode(encoded).length, 0),
      );
      expect(pages).toBeGreaterThan(3);
      expect(closes).toBe(3);
      expect(pool.entries.map((entry) => entry.holdingOrdinal)).toEqual(
        expected.map((entry) => BigInt(aggregate.state.lotHoldings.indexOf(entry.holding)) + 1n),
      );
      expect(pool.accounts.at(-1)?.population).toBe(0n);
      expect(pool.accounts.at(-1)?.memberHash).toBeNull();
      expect(Object.isFrozen(pool.entries)).toBe(true);
      for (const entry of pool.entries) {
        expect((await reader.readTyped("state.lotHoldings", entry.holdingOrdinal)).rowHash).toBe(
          entry.holdingRowHash,
        );
        expect((await reader.readTyped("state.lots", entry.lotOrdinal)).rowHash).toBe(
          entry.lotRowHash,
        );
      }
      const changedReference = (reference: typeof operation.inventoryPolicy) =>
        sealCommand({
          ...query,
          request: { ...query.request, operations: [{ ...operation, inventoryPolicy: reference }] },
        });
      for (const [candidate, reason] of [
        [
          changedReference({
            ...operation.inventoryPolicy,
            policyId: policyId("missing-pool-policy"),
          }),
          "missing",
        ],
        [
          changedReference({
            ...operation.inventoryPolicy,
            policyContentHash: hashCanonical({ forged: "pool-policy" }),
          }),
          "hashMismatch",
        ],
      ] as const) {
        const result = await reader.readOwnedInventoryPools(candidate);
        expect(result.pools[0]).toMatchObject({
          disposition: "unresolvedPolicy",
          reason,
          policy: null,
          entries: null,
          accounts: null,
        });
        expect(result.scannedHoldings).toBe(0);
      }
      const otherCommodity = sealCommand({
        ...query,
        request: {
          ...query.request,
          operations: [
            {
              ...operation,
              coordinate: {
                ...operation.coordinate,
                unitsCommodityId: identifier<"Commodity">("no-stock"),
              },
            },
          ],
        },
      });
      const empty = workflowValue((await reader.readOwnedInventoryPools(otherCommodity)).pools[0]);
      expect(empty.disposition).toBe("resolved");
      expect(empty.entries).toEqual([]);
      if (empty.disposition !== "resolved") throw new Error("Expected proven empty commodity pool");
      expect(empty.accounts.reduce((sum, a) => sum + a.matchingPopulation, 0n)).toBe(0n);
      expect(empty.accounts.reduce((sum, a) => sum + a.population, 0n)).toBe(
        BigInt(aggregate.state.lotHoldings.length),
      );
      expect((await reader.readOwnedInventoryPools(template)).pools).toEqual([]); // Acquisition does not select an existing pool.
      const copied = {
        ...query,
        request: { ...query.request, operations: [...query.request.operations] },
      };
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending = readPinnedOwnedInventoryPools(copied, {
        ...ports,
        basis: async () => {
          await gate;
          return basis;
        },
      });
      copied.request.operations = [];
      release();
      expect((await pending).commandInputHash).toEqual(commandInputHash(query));
      expect(
        (
          await reader.readOwnedInventoryPools({
            ...query,
            inputHash: hashCanonical({ incorrect: true }),
          })
        ).commandInputHash,
      ).toEqual(commandInputHash(query));
      // Contract doubles exercise fail-closed port handling, not forged canonical authority.
      for (const failure of ["truncate", "population", "view", "missing-lot", "bytes"] as const) {
        let closed = 0;
        await expect(
          readPinnedOwnedInventoryPools(query, {
            ...ports,
            openAccount: async (id) => {
              const cursor = await reader.openGroup("holdingsByAccount", [id], 1);
              return {
                next: async () => {
                  const page = await cursor.next();
                  if (failure === "population") return { ...page, population: 10001n };
                  if (failure === "view") return { ...page, headHash: "foreign-head" };
                  if (failure === "truncate" && page.population > 1n)
                    return { ...page, complete: true };
                  if (failure === "bytes" && page.rows.length > 0)
                    return {
                      ...page,
                      rows: page.rows.map((member) => ({
                        ...member,
                        encoded: "x".repeat(32 * 1024 * 1024 + 1),
                      })),
                    };
                  return page;
                },
                close: async () => {
                  closed++;
                  await cursor.close();
                },
              };
            },
            lot:
              failure === "missing-lot"
                ? async (id) => ({
                    id,
                    headHash: basis.headHash,
                    catalogDigest: basis.catalogDigest,
                    disposition: "absent" as const,
                    current: null,
                  })
                : ports.lot,
          }),
        ).rejects.toThrow(
          failure === "population"
            ? "owned_pool_population_limit"
            : failure === "view"
              ? "owned_pool_view_mismatch"
              : failure === "missing-lot"
                ? "owned_pool_lot_missing"
                : failure === "bytes"
                  ? "owned_pool_source_bytes_limit"
                  : "owned_pool_population_mismatch",
        );
        expect(closed).toBeGreaterThan(0);
      }
      // Contract-double ambiguity is not authenticated stored configuration.
      const ambiguous = await readPinnedOwnedInventoryPools(query, {
        ...ports,
        basis: async () => ({
          ...basis,
          configuration: {
            ...basis.configuration,
            row: {
              ...basis.configuration.row,
              accountingPolicySnapshot: {
                ...basis.configuration.row.accountingPolicySnapshot,
                policies: [scenario.policy, scenario.policy],
              },
            },
          },
        }),
      });
      expect(ambiguous.pools[0]).toMatchObject({
        disposition: "unresolvedPolicy",
        reason: "ambiguous",
        entries: null,
      });
    } finally {
      await reader.close();
    }
    const stale = await owner.openCurrentRowReader();
    expect(
      (
        await owner.execute(
          sealCommand({
            ...query,
            id: commandId("pool-stale-rejection"),
            expectedBookRevision: 0n,
          }),
        )
      ).result.disposition,
    ).toBe("rejected");
    await expect(stale.readOwnedInventoryPools(query)).rejects.toThrow(
      "indexed_canonical_head_conflict",
    );
    await expect(stale.readCommand(query.id)).rejects.toThrow("source_catalog_reader_closed");
    await stale.close();
  } finally {
    f.db.close();
  }
}, 180000);

test("canonical reference occupancy includes accounting sources, excludes rejected proposals and survives schedule revision", async () => {
  const scenario = allocationAndTaxWorkflow("1.1.0");
  const f = ownerDatabase("canonical-reference-usage", INDEXED_REFERENCE_GROUP_CATALOG_FORMAT);
  try {
    const owner = f.open();
    await owner.provision(scenario.initial);
    for (const command of scenario.commands.slice(0, 3))
      expect((await owner.execute(command)).result.disposition).toBe("committed");
    const reader = await owner.openCurrentRowReader();
    try {
      // A real source on a canonical allocation schedule, not an inventory artifact.
      expect(
        (await reader.readInventoryIdentity("postingReference", "workflow-source-reference"))
          .disposition,
      ).toBe("absent");
      const used = await reader.readPostingReferenceUsage("workflow-source-reference");
      expect(used.disposition).toBe("used");
      expect(used.witness?.revisionOrdinal).toBe(3n);
      expect(used.witness?.population).toBe(1n);
      expect((await reader.readTyped("state.revisions", 3n)).rowHash).toBe(
        workflowValue(used.witness ?? undefined).revisionRowHash,
      );
      expect(
        (await reader.readPostingReferenceUsage("workflow-source-reference:other")).disposition,
      ).toBe("unused");
      const create = workflowValue(scenario.commands[2]);
      if (create.type !== "createAllocationSchedule") throw new Error("Expected schedule creation");
      const rejected = sealCommand({
        ...create,
        id: commandId("rejected-reference-proposal"),
        request: {
          ...create.request,
          source: {
            ...workflowValue(create.request.source),
            id: canonicalPostingReferenceId("rejected-source-reference"),
          },
        },
      });
      expect((await owner.execute(rejected)).result.disposition).toBe("rejected");
      await expect(reader.readPostingReferenceUsage("workflow-source-reference")).rejects.toThrow(
        "indexed_canonical_head_conflict",
      );
      await expect(reader.readCommand(create.id)).rejects.toThrow("source_catalog_reader_closed");
    } finally {
      await reader.close();
    }
    for (const command of scenario.commands.slice(3))
      expect((await owner.execute(command)).result.disposition).toBe("committed");
    const reloaded = f.open();
    const aggregate = (await reloaded.read()).aggregate;
    const reopened = await reloaded.openCurrentRowReader();
    try {
      expect(
        (await reopened.readPostingReferenceUsage("rejected-source-reference")).disposition,
      ).toBe("unused");
      // Independent full-state walk: compare every retained accounting source ID,
      // including the original source copied into the revised schedule.
      const references = new Set<string>();
      const visit = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        if (
          "postingContentHash" in value &&
          "postingId" in value &&
          "journalId" in value &&
          "id" in value
        )
          references.add(String(value.id));
        for (const child of Object.values(value)) visit(child);
      };
      visit(aggregate.state.accountingState);
      expect(references.has("workflow-source-reference")).toBe(true);
      expect([...references]).toEqual(["workflow-source-reference"]);
      for (const id of references) {
        const usage = await reopened.readPostingReferenceUsage(id);
        expect(usage.disposition).toBe("used");
        expect(usage.witness).not.toBeNull();
        const source = await reopened.readTyped(
          "state.revisions",
          workflowValue(usage.witness ?? undefined).revisionOrdinal,
        );
        expect(source.rowHash).toBe(workflowValue(usage.witness ?? undefined).revisionRowHash);
      }
      const reused = await reopened.readPostingReferenceUsage("workflow-source-reference");
      expect(reused.witness?.population).toBe(2n);
      expect(reused.witness?.revisionOrdinal).toBe(5n);
    } finally {
      await reopened.close();
    }
    for (const profile of [
      INDEXED_GROUP_CATALOG_FORMAT,
      INDEXED_OWNERSHIP_GROUP_CATALOG_FORMAT,
      INDEXED_MONEY_GROUP_CATALOG_FORMAT,
    ] as const)
      await expect(f.open(profile).read()).rejects.toThrow("group_catalog_corrupt");
  } finally {
    f.db.close();
  }
}, 180000);

test("indexed preparation gates all common outcomes before inventory reads and never publishes them", async () => {
  const { initial, command } = ownershipFixture();
  const f = ownerDatabase("owned-common-admission", INDEXED_REFERENCE_GROUP_CATALOG_FORMAT);
  try {
    const owner = f.open();
    await owner.provision(initial);
    async function finished(
      input: BookCommand,
      code: SemanticDiagnosticCode | null,
      retained: boolean,
    ) {
      const before = await owner.read();
      const reader = await owner.openCurrentRowReader();
      try {
        const result = await preparePinnedOwnedInventory(
          {
            ...reader,
            readAdmissionFacts: async () => {
              throw new Error("Finished admission must not read inventory/configuration facts");
            },
            readOwnedInventoryPools: async () => {
              throw new Error("Finished admission must not read pools");
            },
          },
          input,
        );
        expect(result.disposition).toBe("finished");
        if (result.disposition !== "finished" || result.evaluation.disposition !== "finished")
          throw new Error("Expected finished common outcome");
        const canonical = evaluateBookCommand(
          before.aggregate.state,
          before.aggregate.protocol,
          input,
        );
        if (canonical.disposition !== "finished")
          throw new Error("Expected canonical common outcome");
        expect(result.evaluation).toEqual(canonical);
        expect(result.evaluation.result.disposition).toBe(code === null ? "replayed" : "rejected");
        if (code !== null) expect(result.evaluation.result.diagnostics[0]?.code).toBe(code);
        expect(result.evaluation.retained !== undefined).toBe(retained);
        expect(result.headHash).toBe(before.head.contentHash);
        expect(Object.hasOwn(result, "preparation")).toBe(false);
      } finally {
        await reader.close();
      }
      const after = await owner.read();
      expect(after.head).toEqual(before.head);
      expect(encodeDurableBook(after.aggregate)).toBe(encodeDurableBook(before.aggregate));
    }
    await finished(
      sealCommand({ ...command, expectedBookRevision: 0n }),
      "unresolved_accounting_input",
      true,
    );
    await owner.execute(activation());
    const stale = sealCommand({
      ...command,
      id: commandId("common-stale"),
      expectedBookRevision: 99n,
    });
    await finished(stale, "stale_book_revision", true);
    await finished(
      { ...command, inputHash: hashCanonical({ forged: true }) },
      "command_identity_conflict",
      false,
    );
    await finished(
      sealCommand({ ...command, bookId: bookId("foreign") }),
      "book_isolation_violation",
      false,
    );
    await finished(
      sealCommand({ ...command, protocolVersion: semanticVersion("9.0.0") }),
      "unresolved_accounting_input",
      true,
    );
    await finished(
      sealCommand({ ...command, completedAt: instant("2025-01-01T00:00:00Z") }),
      "temporal_semantics_violation",
      true,
    );
    expect((await owner.execute(stale)).result.disposition).toBe("rejected");
    expect((await owner.execute(command)).result.disposition).toBe("committed");
    await finished(stale, null, false);
    await finished(command, null, false);
    await finished(
      sealCommand({ ...command, expectedBookRevision: 999n }),
      "command_identity_conflict",
      false,
    );
    const expired = await owner.openCurrentRowReader();
    await owner.execute(sealCommand({ ...stale, id: commandId("expire-common-reader") }));
    await expect(expired.evaluateAdmission(command)).rejects.toThrow(
      "indexed_canonical_head_conflict",
    );
    await expect(expired.evaluateAdmission(stale)).rejects.toThrow("source_catalog_reader_closed");
    const invalid = await owner.openCurrentRowReader();
    await expect(
      invalid.evaluateAdmission({ ...command, type: "invalid" } as unknown as BookCommand),
    ).rejects.toThrow();
    await expect(invalid.evaluateAdmission(command)).rejects.toThrow(
      "source_catalog_reader_closed",
    );
  } finally {
    f.db.close();
  }
}, 180000);

test("indexed preparation snapshots commands and never returns a candidate after a retained-outcome race", async () => {
  const { initial, before, command } = ownershipFixture();
  const f = ownerDatabase("owned-preparation-race", INDEXED_REFERENCE_GROUP_CATALOG_FORMAT);
  try {
    const owner = f.open();
    await owner.provision(initial);
    await owner.execute(activation());
    const reader = await owner.openCurrentRowReader();
    try {
      const supplied = {
        ...command,
        request: { ...command.request, operations: [...command.request.operations] },
      };
      const pending = preparePinnedOwnedInventory(reader, supplied);
      supplied.request.operations.length = 0;
      const result = await pending;
      if (result.disposition !== "prepared") throw new Error("Expected preparation");
      expect("journals" in result.preparation).toBe(true);
      expect(result.commandInputHash).toEqual(command.inputHash);
      expect(result.retainedSourceBytes).toBeGreaterThan(0);
      expect(result.retainedSourceBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    } finally {
      await reader.close();
    }
    const racing = await owner.openCurrentRowReader();
    let confirmations = 0;
    await expect(
      preparePinnedOwnedInventory(
        {
          ...racing,
          readBookBasis: async () => {
            confirmations++;
            if (confirmations === 2)
              expect(
                (
                  await owner.execute(
                    sealCommand({
                      ...command,
                      id: commandId("owned-preparation-rejected-race"),
                      expectedBookRevision: 99n,
                    }),
                  )
                ).result.disposition,
              ).toBe("rejected");
            return racing.readBookBasis();
          },
        },
        command,
      ),
    ).rejects.toThrow("indexed_canonical_head_conflict");
    expect(confirmations).toBe(2);
    await expect(racing.readCommand(command.id)).rejects.toThrow("source_catalog_reader_closed");
    const after = await owner.read();
    expect(after.aggregate.state).toEqual(before.state);
    expect(after.aggregate.protocol.retainedResults).toHaveLength(2);
    const malformed = await owner.openCurrentRowReader();
    await expect(
      preparePinnedOwnedInventory(
        {
          ...malformed,
          readInventoryIdentity: async (kind, id) => ({
            ...(await malformed.readInventoryIdentity(kind, id)),
            id: "a-different-identity",
          }),
        },
        command,
      ),
    ).rejects.toThrow("owned_preparation_identity_mismatch");
    await expect(malformed.readCommand(command.id)).rejects.toThrow("source_catalog_reader_closed");
  } finally {
    f.db.close();
  }
}, 180000);

test("older profiles never prove canonical posting-reference absence", async () => {
  for (const profile of [
    INDEXED_GROUP_CATALOG_FORMAT,
    INDEXED_OWNERSHIP_GROUP_CATALOG_FORMAT,
    INDEXED_MONEY_GROUP_CATALOG_FORMAT,
  ] as const) {
    const f = ownerDatabase(`old-reference-${profile}`, profile);
    try {
      const owner = f.open();
      await owner.provision(ownershipFixture().initial);
      const reader = await owner.openCurrentRowReader();
      try {
        await expect(reader.readPostingReferenceUsage("unused")).rejects.toThrow(
          "group_query_profile_unsupported",
        );
        await expect(reader.readCommand("absent")).rejects.toThrow("source_catalog_reader_closed");
      } finally {
        await reader.close();
      }
    } finally {
      f.db.close();
    }
  }
});

test("managed money scope reads never confuse absent stock, ordinary balances, or source-journal references", async () => {
  const { initial, command } = ownershipFixture();
  const f = ownerDatabase("money-scope-admission", INDEXED_MONEY_GROUP_CATALOG_FORMAT);
  const scope = {
    bookId: BOOK,
    accountId: CASH,
    functionalCommodityId: initial.state.identity.functionalCommodityId,
    dimensionMemberIds: [],
  };
  try {
    const owner = f.open();
    await owner.provision(initial);
    expect((await owner.execute(activation())).result.disposition).toBe("committed");
    const ordinary = posting("unowned-opening-money");
    expect((await owner.execute(ordinary)).result.disposition).toBe("committed");
    expect((await owner.read()).aggregate.state.lotHoldings).toEqual([]);
    const reader = await owner.openCurrentRowReader();
    const sourceReader = await owner.openCurrentRowReader();
    try {
      const input = { ...scope };
      const pending = reader.readInventoryMoneyScope(input);
      input.accountId = identifier<"Account">("income");
      const money = await pending;
      expect(money.scope.accountId).toBe(CASH);
      expect(money.ownership).toBe("unmanaged");
      expect(money.ownershipWitness).toBeNull();
      expect(money.postedBalance.toString()).toBe("100/1");
      expect(money.journals.population).toBe(1n);
      expect(
        (await reader.readJournalIdentity("journal", "unowned-opening-money")).disposition,
      ).toBe("present");
      expect(
        (await sourceReader.readInventorySourceJournal("unowned-opening-money")).disposition,
      ).toBe("unreferenced");
      const rejection = await owner.execute(
        sealCommand({
          ...command,
          id: commandId("nonzero-ownership-opening"),
          expectedBookRevision: 2n,
        }),
      );
      expect(rejection.result.disposition).toBe("rejected");
      expect(rejection.outcomeSequence).toBe(3n);
      await expect(reader.readInventoryMoneyScope(scope)).rejects.toThrow(
        "indexed_canonical_head_conflict",
      );
      await expect(reader.readCommand(command.id)).rejects.toThrow("source_catalog_reader_closed");
      await expect(
        sourceReader.readInventorySourceJournal("unowned-opening-money"),
      ).rejects.toThrow("indexed_canonical_head_conflict");
      await expect(sourceReader.readCommand(command.id)).rejects.toThrow(
        "source_catalog_reader_closed",
      );
    } finally {
      await reader.close();
      await sourceReader.close();
    }
    for (const oldProfile of [
      INDEXED_GROUP_CATALOG_FORMAT,
      INDEXED_OWNERSHIP_GROUP_CATALOG_FORMAT,
    ] as const)
      await expect(f.open(oldProfile).read()).rejects.toThrow("group_catalog_corrupt");
    const malformed = await owner.openCurrentRowReader();
    let invoked = 0;
    try {
      await expect(
        malformed.readInventoryMoneyScope({
          ...scope,
          get accountId() {
            invoked++;
            return CASH;
          },
        }),
      ).rejects.toThrow("money_scope_input_invalid");
      expect(invoked).toBe(0);
      await expect(malformed.readCommand(command.id)).rejects.toThrow(
        "source_catalog_reader_closed",
      );
    } finally {
      await malformed.close();
    }
  } finally {
    f.db.close();
  }
  for (const profile of [
    INDEXED_GROUP_CATALOG_FORMAT,
    INDEXED_OWNERSHIP_GROUP_CATALOG_FORMAT,
  ] as const) {
    const old = ownerDatabase(`unsupported-money-${profile}`, profile);
    try {
      const owner = old.open();
      await owner.provision(initial);
      for (const query of ["scope", "journal"] as const) {
        const reader = await owner.openCurrentRowReader();
        try {
          await expect(
            query === "scope"
              ? reader.readInventoryMoneyScope(scope)
              : reader.readInventorySourceJournal("absent"),
          ).rejects.toThrow("group_query_profile_unsupported");
          await expect(reader.readCommand(command.id)).rejects.toThrow(
            "source_catalog_reader_closed",
          );
        } finally {
          await reader.close();
        }
      }
    } finally {
      old.db.close();
    }
  }
}, 180000);

test("identity delta cannot treat an owned allocation's creation as a repeatable legacy snapshot", async () => {
  const { before, command } = ownershipFixture();
  const acquisition = workflowValue(command.request.operations[0]);
  const owned = evaluateOutcomePayload(
    before,
    sealCommand({
      ...command,
      request: {
        ...command.request,
        operations: [
          acquisition,
          {
            kind: "issue",
            ordinal: 1n,
            id: identifier<"InventoryOperation">("identity-owned-issue"),
            coordinate: acquisition.coordinate,
            inventoryPolicy: acquisition.inventoryPolicy,
            derivation: acquisition.derivation,
            quantity: R.of(1n, 1n),
            identities: [
              {
                holdingId: lotHoldingId("owned-boundary-holding"),
                allocationId: lotAllocationId("shared-allocation-id"),
                movementId: identifier<"InventoryPostedMovement">("identity-owned-movement"),
              },
            ],
          },
        ],
      },
    }),
  );
  expect(owned.transition.result.disposition).toBe("committed");
  if (!owned.encoded) throw new Error("Expected original owned outcome");
  const original = owned.encoded;
  // Both candidate payloads are genuine kernel outputs from separate branches.
  // Supplying the owned branch's first-creation evidence must disallow adopting
  // that ID as a legacy snapshot row; this helper does not authenticate prefixes.
  const legacy = inventoryReadWorkflow();
  let aggregate = legacy.initial;
  let exercised = false;
  for (const next of legacy.commands) {
    const operation = next.type === "postJournal" ? next.lotOperations?.[0] : undefined;
    if (next.type === "postJournal" && operation?.type === "dispose") {
      const candidate = evaluateOutcomePayload(
        aggregate,
        sealCommand({
          ...next,
          lotOperations: [
            {
              ...operation,
              identities: operation.identities.map((identity, index) =>
                index === 0
                  ? { ...identity, allocationId: lotAllocationId("shared-allocation-id") }
                  : identity,
              ),
            },
          ],
        }),
      );
      expect(candidate.transition.result.disposition).toBe("committed");
      if (!candidate.encoded) throw new Error("Expected original legacy outcome");
      const target = identityIndexKey({
        bookId: BOOK,
        family: "lotAllocation",
        id: "shared-allocation-id",
      });
      await expect(
        prepareOutcomeIdentityDelta(candidate.encoded, BOOK, 9n, async (key) =>
          key === target ? { sequence: 2n, encodedOutcome: original } : null,
        ),
      ).rejects.toThrow("index_canonical_identity_conflict");
      exercised = true;
      break;
    }
    const result = evaluateOutcomePayload(aggregate, next);
    expect(result.transition.result.disposition).toBe("committed");
    aggregate = { state: result.transition.state, protocol: result.transition.protocol };
  }
  expect(exercised).toBe(true);
});

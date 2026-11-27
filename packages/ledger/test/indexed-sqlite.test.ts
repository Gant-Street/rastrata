import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBookState,
  createBookProtocolState,
  decodeDurableBook,
  encodeDurableBook,
  type DurableBookAggregate,
  decodeBookOutcome,
  encodeBookOutcome,
  hashCanonical,
  executeBookCommand,
  prepareBookJournal,
  resolveBookAccountingPeriod,
  evaluateBookCommandProtocol,
  evaluateBookCommand,
  prepareBookCommitRecords,
  validateBookFinancialIdentity,
  validateBookConfiguration,
  validateBookGlobalAdmission,
  inventoryCostLayersMatch,
  compareCanonicalText,
  commodityId,
  ACCOUNTING_LIMITS,
  type BookJournalReadContext,
  sealCommand,
  commandId,
  postingId,
  allocationRecognitionId,
  allocationScheduleRevisionId,
  allocationScheduleId,
  ExactRational,
  ExactDecimal,
  BOOK_ROW_COLLECTIONS,
  encodeBookRow,
  resolveJournal,
  accountId,
  instant,
  localDate,
  effectKey,
  type BookCommand,
  type ResolvedTransaction,
  type AccountingEffect,
  type AccountingPolicy,
  type BookRowCollection,
  fiscalPeriodId,
  closePackageId,
  semanticVersion,
} from "@rastrata/kernel";
import {
  ProductionLedger,
  COMPACT_LEDGER_FORMAT,
  SqliteBookStorage,
  type SqliteStorage,
} from "../src/index.ts";
import { SqliteIndexedBookStorage } from "../src/indexed-sqlite.ts";
import { SqliteIndexControl, type IndexAnchor } from "../src/index-control.ts";
import { indexBookIdentityCommitment, ledgerIndexHeadCommitment } from "../src/index-view-audit.ts";
import {
  createIndexRoot,
  identityIndexKey,
  lookupIndexEntry,
  enumerateIndexPages,
  verifyPreparedIndexInsertion,
} from "../src/index-pages.ts";
import { SqliteIndexPageStore } from "../src/index-page-store.ts";
import { activation, BOOK, genesis, posting } from "./fixtures.ts";
import { evaluateOutcomePayload } from "../src/outcome-payload.ts";
import { compactOutcomeRecord } from "../src/compact-records.ts";
import { atomicSqlite, type SqliteTransaction } from "../src/sqlite-transaction.ts";
import {
  allocationAndTaxWorkflow,
  workflowTerminationCommand,
  workflowValue,
  lotIdentityWorkflow,
  admissionFxWorkflow,
  inventoryReadWorkflow,
} from "./accounting-workflows.ts";
import type { IdentityFamily } from "../src/identity-audit.ts";
import { projectLegacyLogicalBook } from "../src/logical-book.ts";
import { ACCOUNTING_SOURCE_COLLECTIONS } from "../src/outcome-source.ts";
import { GROUP_CATALOG_FORMAT, SqliteSemanticGroupCatalog } from "../src/group-catalog.ts";
import {
  SEMANTIC_GROUP_VERSION,
  semanticGroupKey,
  semanticGroupDigest,
  type SemanticGroupKind,
} from "../src/semantic-groups.ts";
import { auditLogicalMap, emptyLogicalMap, logicalMapHash } from "../src/logical-map.ts";
import { rebuildLogicalMap } from "./logical-map-oracle.ts";
import { createPinnedGroupCursor } from "../src/group-reader.ts";
import { readPinnedBookBasis } from "../src/book-basis.ts";
import { readPinnedInventoryCostFacts } from "../src/inventory-facts.ts";
import {
  isAccountingIdentityFamily,
  resolveActivationIdentity,
  LOT_IDENTITY_COLLECTIONS,
  type LotIdentityFamily,
} from "../src/outcome-identities.ts";

function fixture(path = ":memory:", bookId: string = BOOK, sourceCatalog = false) {
  const db = new Database(path);
  if (path === ":memory:") {
    db.exec(
      "PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY; PRAGMA cache_size = -64000; PRAGMA temp_store = MEMORY;",
    );
  } else {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
  }
  const faults = {
    afterSql: "",
    loseAfterSql: "",
    syncFailures: 0,
    now: 10n,
    fence: "0",
    pending: false,
    maxDepth: 0,
    onlyPublication: false,
    publicationFaults: 0,
    expireAfterAllocation: false,
  };
  let depth = 0;
  let publication = false;
  const stmtCache = new Map<string, ReturnType<Database["query"]>>();
  const port: SqliteStorage = {
    sql: {
      exec(sql, ...bindings) {
        if (sql.startsWith("INSERT INTO ledger_outcomes")) publication = true;
        if (
          faults.expireAfterAllocation &&
          sql.startsWith("INSERT INTO ledger_index_construction_locations")
        ) {
          faults.expireAfterAllocation = false;
          faults.now += 1_000n;
        }
        let stmt = stmtCache.get(sql);
        if (!stmt) {
          stmt = db.query(sql);
          stmtCache.set(sql, stmt);
        }
        const rows = stmt.all(
          ...bindings.map((value) =>
            value instanceof ArrayBuffer ? new Uint8Array(value) : value,
          ),
        ) as Record<string, unknown>[];
        if (
          faults.afterSql &&
          sql.startsWith(faults.afterSql) &&
          (!faults.onlyPublication || publication)
        ) {
          if (publication) faults.publicationFaults++;
          throw new Error("injected owner SQL failure");
        }
        if (faults.loseAfterSql && sql.startsWith(faults.loseAfterSql)) {
          faults.loseAfterSql = "";
          faults.syncFailures++;
        }
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          for (const name in row) {
            const value = row[name];
            if (value instanceof Uint8Array) {
              row[name] = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
            }
          }
        }
        return rows;
      },
    },
    transactionSync(fn) {
      depth++;
      faults.maxDepth = Math.max(depth, faults.maxDepth);
      try {
        return db.transaction(fn)();
      } finally {
        depth--;
        if (depth === 0) publication = false;
      }
    },
    async sync() {
      if (faults.syncFailures) {
        faults.syncFailures--;
        throw new Error("lost owner durability response");
      }
    },
  };
  const scope = {
    tenantId: "tenant",
    bookId,
    objectId: "indexed-object",
    namespaceId: "namespace",
    generation: "0",
  };
  const open = () => {
    const storage = new SqliteIndexedBookStorage(
      scope.objectId,
      port,
      scope,
      () => ({ fence: faults.fence, pending: faults.pending }),
      () => faults.now,
      100n,
      { sourceCatalog },
    );
    return { storage, ledger: new ProductionLedger(storage, scope, COMPACT_LEDGER_FORMAT) };
  };
  const anchor = (): IndexAnchor => {
    const row = db.query("SELECT head FROM ledger_metadata").get() as { head: string };
    const head = JSON.parse(row.head);
    return {
      identityHash: indexBookIdentityCommitment(scope),
      headHash: ledgerIndexHeadCommitment(head, COMPACT_LEDGER_FORMAT),
      sequence: head.sequence,
      fence: faults.fence,
      pending: faults.pending,
      provisioning: false,
    };
  };
  const control = new SqliteIndexControl(port, anchor, () => faults.now);
  const pages = new SqliteIndexPageStore(port, indexBookIdentityCommitment(scope));
  return { db, port, faults, scope, open, control, pages, ...open() };
}

test("the real indexed owner retains every identity incrementally without a final whole-index scan", async () => {
  const f = fixture(":memory:", BOOK, true);
  const originalRetain = SqliteIndexPageStore.prototype.retainInsertion;
  const originalFull = SqliteIndexPageStore.prototype.retainPreparedRoot;
  const originalExec = f.port.sql.exec;
  const retained: { sequence: bigint; pages: number; reads: number }[] = [];
  let activeReads: number | null = null;
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    for (let batch = 0; batch < 5; batch++) {
      const template = posting(`retention-wide-base-${batch}`, BigInt(batch + 1));
      if (template.type !== "postJournal") throw new Error("Expected journal fixture");
      const initial = genesis();
      const journal = {
        ...template.resolved.journal,
        postings: Array.from({ length: 80 }, (_, i) => ({
          ...workflowValue(template.resolved.journal.postings[i % 2]),
          id: postingId(`retention-wide-${batch}-${i}`),
          ordinal: BigInt(i),
        })),
      };
      const resolved = resolveJournal(
        journal,
        initial.state.policies,
        initial.state.identity.ownerId,
        workflowValue(initial.state.quantizationPolicies[0]),
        journal.postings.map((p) => p.bookValue.amount.toRational()),
      );
      if (Array.isArray(resolved)) throw new Error("Wide journal must resolve");
      const base = await f.ledger.execute(
        sealCommand({ ...template, resolved: resolved as ResolvedTransaction }),
      );
      expect(base.result.disposition).toBe("committed");
    }
    const before = await f.ledger.read();
    expect((await f.control.readMetadata()).view.hotCount).toBe("412");
    f.port.sql.exec = (sql, ...bindings) => {
      if (
        activeReads !== null &&
        sql.startsWith("SELECT substr") &&
        sql.includes("FROM ledger_index_pages WHERE location = ?")
      )
        activeReads++;
      return originalExec(sql, ...bindings);
    };
    SqliteIndexPageStore.prototype.retainPreparedRoot = async () => {
      throw new Error("Unexpected whole-index retention in commitTransition");
    };
    SqliteIndexPageStore.prototype.retainInsertion = async function (...args) {
      const proof = verifyPreparedIndexInsertion(args[2]);
      activeReads = 0;
      try {
        const result = await originalRetain.apply(this, args);
        retained.push({
          sequence: proof.entry.sequence,
          pages: proof.pages.length,
          reads: activeReads,
        });
        return result;
      } finally {
        activeReads = null;
      }
    };
    const committedCommand = posting("incremental-owner-post", 6n),
      rejectedCommand = posting("incremental-owner-reject", 0n);
    const committed = await f.ledger.execute(committedCommand),
      rejected = await f.ledger.execute(rejectedCommand);
    expect(committed.result.disposition).toBe("committed");
    expect(rejected.result.disposition).toBe("rejected");
    expect(retained.map((item) => item.sequence)).toEqual([7n, 7n, 7n, 7n, 8n]);
    for (const item of retained) expect(item.reads).toBe(item.pages);
    const expectedCommit = executeBookCommand(
      before.aggregate.state,
      before.aggregate.protocol,
      committedCommand,
    );
    const expectedRejection = executeBookCommand(
      expectedCommit.state,
      expectedCommit.protocol,
      rejectedCommand,
    );
    const after = await f.open().ledger.read();
    expect(encodeDurableBook(after.aggregate)).toBe(
      encodeDurableBook({ state: expectedRejection.state, protocol: expectedRejection.protocol }),
    );
    expect((await f.control.readMetadata()).view.hotCount).toBe("417");
    await assertGroupDirectory(f, after);
    const count = retained.length;
    expect((await f.ledger.execute(committedCommand)).originalResult).toEqual(committed.result);
    expect((await f.ledger.execute(rejectedCommand)).originalResult).toEqual(rejected.result);
    expect(retained.length).toBe(count);
  } finally {
    SqliteIndexPageStore.prototype.retainInsertion = originalRetain;
    SqliteIndexPageStore.prototype.retainPreparedRoot = originalFull;
    f.port.sql.exec = originalExec;
    f.db.close();
  }
});

async function assertGroupDirectory(
  f: ReturnType<typeof fixture>,
  snapshot: Awaited<ReturnType<ProductionLedger["read"]>>,
) {
  const projection = await projectLegacyLogicalBook(encodeDurableBook(snapshot.aggregate));
  const expected = new Map<
    string,
    { key: ReturnType<typeof semanticGroupKey>; domain: string; members: Map<string, string> }
  >();
  const add = (kind: SemanticGroupKind, values: string[], name: string, i: number) => {
    const c = workflowValue(projection.collections.find((c) => c.name === name));
    const key = semanticGroupKey(kind, values);
    const id = semanticGroupDigest(c.domain, key);
    const group = expected.get(id) ?? { key, domain: c.domain, members: new Map<string, string>() };
    const row = workflowValue(c.rows[i]);
    group.members.set(row.key, row.contentHash);
    expected.set(id, group);
  };
  // Independent canonical predicates; do not call the membership/delta producer.
  snapshot.aggregate.state.lotHoldings.forEach((h, i) => {
    add("holdingsByLot", [h.lotId], "state.lotHoldings", i);
    add("holdingsByAccount", [h.accountId], "state.lotHoldings", i);
    if (h.remainingQuantity.numerator !== 0n)
      add(
        "nonzeroHoldingsByAccountCommodity",
        [h.accountId, h.commodityId],
        "state.lotHoldings",
        i,
      );
  });
  snapshot.aggregate.state.accountingState.allocationRecognitions.forEach((r, i) => {
    add(
      "recognitionsBySchedule",
      [r.scheduleId],
      "state.accountingState.allocationRecognitions",
      i,
    );
  });
  snapshot.aggregate.state.periodTransitions.forEach((r, i) => {
    add("transitionsByPeriod", [r.periodId], "state.periodTransitions", i);
  });
  snapshot.aggregate.state.accountingState.remeasurementResults.forEach((r, i) => {
    if (r.kind === "unrealized")
      add("unrealizedByPolicy", [r.policyId], "state.accountingState.remeasurementResults", i);
  });
  snapshot.aggregate.state.accountingState.remeasurementReversals.forEach((r, i) => {
    add(
      "reversalsByOriginalResult",
      [r.originalResultId],
      "state.accountingState.remeasurementReversals",
      i,
    );
  });
  const stored = f.db.query("SELECT body, digest FROM ledger_group_catalog").get() as {
    body: string;
    digest: string;
  };
  const metadata = JSON.parse(stored.body);
  expect(metadata.headHash).toBe(ledgerIndexHeadCommitment(snapshot.head, COMPACT_LEDGER_FORMAT));
  expect(metadata.identityHash).toBe(indexBookIdentityCommitment(f.scope));
  expect(metadata.format).toBe(GROUP_CATALOG_FORMAT);
  expect(stored.digest).toBe(
    hashCanonical({ profile: GROUP_CATALOG_FORMAT, kind: "catalog", body: stored.body }).digest,
  );
  const domain = hashCanonical({
    profile: GROUP_CATALOG_FORMAT,
    collections: [
      "state.lotHoldings",
      "state.accountingState.allocationRecognitions",
      "state.periodTransitions",
      "state.accountingState.remeasurementResults",
      "state.accountingState.remeasurementReversals",
    ].map((name) => ({
      name,
      domain: workflowValue(projection.collections.find((c) => c.name === name)).domain,
    })),
  }).digest;
  expect(metadata.domain).toBe(domain);
  const directory = new Map<string, string>();
  for (const [id, group] of expected) {
    const members = rebuildLogicalMap(id, group.members);
    const body = JSON.stringify({
      format: SEMANTIC_GROUP_VERSION,
      key: group.key,
      collectionDomain: group.domain,
      memberDomain: id,
      memberRoot: members.encodedRoot,
      memberHash: members.rootHash,
      population: String(group.members.size),
    });
    directory.set(
      id,
      hashCanonical({ profile: GROUP_CATALOG_FORMAT, kind: "descriptor", body }).digest,
    );
  }
  expect(metadata.rootHash).toBe(rebuildLogicalMap(domain, directory).rootHash);
  expect(metadata.population).toBe(String(expected.size));
  const read = async (digest: string) =>
    (
      f.db.query("SELECT body FROM ledger_group_nodes WHERE digest = ?").get(digest) as {
        body: string;
      } | null
    )?.body;
  const visited = new Set<string>();
  await auditLogicalMap(metadata.root, metadata.rootHash, domain, read, async (key, digest) => {
    const group = workflowValue(expected.get(key));
    const row = f.db
      .query("SELECT body FROM ledger_group_descriptors WHERE digest = ?")
      .get(digest) as { body: string };
    expect(
      hashCanonical({ profile: GROUP_CATALOG_FORMAT, kind: "descriptor", body: row.body }).digest,
    ).toBe(digest);
    const descriptor = JSON.parse(row.body);
    const actual = new Map<string, string>();
    await auditLogicalMap(descriptor.memberRoot, descriptor.memberHash, key, read, (k, v) => {
      actual.set(k, v);
    });
    expect(actual).toEqual(group.members);
    visited.add(key);
  });
  expect(visited.size).toBe(expected.size);
  return metadata;
}

for (const method of ["readAdmissionFacts", "readInventoryCostFacts"] as const) {
  test(`shared reader ${method} rejects malformed commands without invoking accessors and retires`, async () => {
    const f = fixture(":memory:", BOOK, true);
    try {
      await f.ledger.provision(genesis());
      await f.ledger.read();
      const reader = await f.storage.openCurrentRowReader();
      let calls = 0;
      const command = { ...posting("malformed-facts") };
      Object.defineProperty(command, "issuedAt", {
        enumerable: true,
        get() {
          calls++;
          throw new Error("caller accessor invoked");
        },
      });
      await expect(reader[method](command)).rejects.toThrow("ledger_command_invalid");
      expect(calls).toBe(0);
      await expect(reader.readBookBasis()).rejects.toThrow("source_catalog_reader_closed");
      await reader.close();
      expect(f.db.query("SELECT COUNT(*) AS n FROM ledger_outcomes").get()).toEqual({ n: 0 });
      expect(f.db.query("SELECT COUNT(*) AS n FROM ledger_index_pins").get()).toEqual({ n: 0 });
    } finally {
      f.db.close();
    }
  });
}

test("book basis follows configuration and activation while retaining the financial clock across rejection", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    const initial = genesis();
    await f.ledger.provision(initial);
    const check = async () => {
      const snapshot = await f.ledger.read();
      const reader = await f.storage.openCurrentRowReader();
      const basis = await reader.readBookBasis();
      const state = snapshot.aggregate.state;
      expect(
        Object.isFrozen(basis) &&
          Object.isFrozen(basis.header) &&
          Object.isFrozen(basis.header.identity),
      ).toBeTrue();
      expect(basis.headHash).toBe(ledgerIndexHeadCommitment(snapshot.head, COMPACT_LEDGER_FORMAT));
      expect(basis.header).toEqual({
        identity: state.identity,
        financialIdentityHash: state.financialIdentityHash,
        contentHash: state.contentHash,
        status: state.status,
        bookRevision: state.bookRevision,
        latestPostingSequence: state.latestPostingSequence,
        configurationRevision: state.configurationRevision,
        configurationHash: state.configurationHash,
      });
      expect(basis.configuration.ordinal).toBe(state.configurationRevision + 1n);
      expect(basis.configuration.encoded).toBe(
        encodeBookRow("state.configurationSnapshots", state.activeConfigurationSnapshot),
      );
      expect(basis.configuration.row).toEqual(state.activeConfigurationSnapshot);
      expect(basis.openingBoundary?.encoded ?? null).toBe(
        state.openingBoundary
          ? encodeBookRow("state.openingBoundary", state.openingBoundary)
          : null,
      );
      const last = state.revisions.at(-1);
      expect(basis.financialRevision?.encoded ?? null).toBe(
        last ? encodeBookRow("state.revisions", last) : null,
      );
      if (basis.financialRevision)
        expect(basis.financialRevision.row.chainHash.digest).toBe(
          workflowValue(snapshot.head.revisionHash),
        );
      await reader.close();
      return { snapshot, basis };
    };
    expect((await check()).basis.financialRevision).toBeNull();
    const configure = (
      id: string,
      revision: bigint,
      configurationRevision: bigint,
      day: string,
      name: string,
    ) =>
      sealCommand({
        id: commandId(id),
        type: "replaceConfiguration" as const,
        protocolVersion: activation().protocolVersion,
        actorId: activation().actorId,
        bookId: BOOK,
        expectedBookRevision: revision,
        expectedConfigurationRevision: configurationRevision,
        issuedAt: instant(`${day}T00:00:00Z`),
        completedAt: instant(`${day}T00:00:01Z`),
        committedAt: instant(`${day}T00:00:02Z`),
        effectiveOn: localDate(day),
        periods: initial.state.periods,
        admissionSnapshot: {
          ...initial.state.admissionSnapshot,
          accounts: initial.state.admissionSnapshot.accounts.map((account) => ({
            ...account,
            name: `${name}-${account.code}`,
          })),
        },
        policies: initial.state.policies,
        quantizationPolicies: initial.state.quantizationPolicies,
        accountingPolicies: initial.state.accountingPolicySnapshot.policies,
      });
    expect(
      (
        await f.ledger.execute(
          configure("configure-before-activation", 0n, 0n, "2025-12-20", "First"),
        )
      ).result.disposition,
    ).toBe("committed");
    const configured = await check();
    expect(configured.basis.header.status).toBe("configuring");
    expect(configured.basis.openingBoundary).toBeNull();
    expect(configured.basis.financialRevision?.row.bookRevision).toBe(1n);
    expect(
      (await f.ledger.execute(sealCommand({ ...activation(), expectedBookRevision: 1n }))).result
        .disposition,
    ).toBe("committed");
    await check();
    expect((await f.ledger.execute(posting("basis-journal", 2n))).result.disposition).toBe(
      "committed",
    );
    await check();
    expect(
      (await f.ledger.execute(configure("configure-after-posting", 3n, 1n, "2026-01-16", "Second")))
        .result.disposition,
    ).toBe("committed");
    const changed = await check();
    expect(changed.basis.configuration.row.revision).toBe(2n);
    expect(changed.basis.openingBoundary?.row.configurationSnapshot.revision).toBe(1n);
    const rejection = sealCommand({
      ...posting("later-retained-rejection", 0n),
      issuedAt: instant("2026-02-01T00:00:00Z"),
      completedAt: instant("2026-02-01T00:00:01Z"),
      committedAt: instant("2026-02-01T00:00:02Z"),
    });
    expect((await f.ledger.execute(rejection)).result.disposition).toBe("rejected");
    const rejected = await check();
    expect(rejected.snapshot.head.sequence).toBe("5");
    expect(rejected.basis.header.bookRevision).toBe(4n);
    expect(rejected.basis.financialRevision?.row.committedAt).toBe(instant("2026-01-16T00:00:02Z"));
    expect(rejected.basis.financialRevision).not.toEqual(null);
    expect(rejected.basis.financialRevision?.encoded).toBe(
      changed.basis.financialRevision?.encoded,
    );
    expect(rejected.basis.headHash).not.toBe(changed.basis.headHash);
  } finally {
    f.db.close();
  }
});

test("admission facts preserve first overdue FX selection, date boundaries and reversal exceptions", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    const scenario = admissionFxWorkflow();
    await f.ledger.provision(scenario.initial);
    for (const command of scenario.commands) {
      const receipt = await f.ledger.execute(command);
      expect(receipt.result.disposition, JSON.stringify(receipt.result.diagnostics)).toBe(
        "committed",
      );
      await assertGroupDirectory(f, await f.ledger.read());
    }
    const probe = (revision: bigint, day: string) =>
      sealCommand({
        ...posting(`fx-probe-${day}`, revision),
        issuedAt: instant(`${day}T18:00:00Z`),
        completedAt: instant(`${day}T18:00:01Z`),
        committedAt: instant(`${day}T18:00:02Z`),
      });
    const inspect = async (command: BookCommand) => {
      const snapshot = await f.ledger.read();
      const reader = await f.storage.openCurrentRowReader();
      const facts = await reader.readAdmissionFacts(command);
      const expected = snapshot.aggregate.state.accountingState.remeasurementResults.find((r) => {
        const p = snapshot.aggregate.state.accountingPolicySnapshot.policies.find(
          (p) => p.kind === "currencyRemeasurement" && p.id === r.policyId,
        );
        return (
          r.kind === "unrealized" &&
          r.effectiveOn < command.issuedAt.slice(0, 10) &&
          p?.kind === "currencyRemeasurement" &&
          p.reversalRequired &&
          !(
            command.type === "postCurrencyRemeasurement" && command.request.reversalOf !== undefined
          ) &&
          !snapshot.aggregate.state.accountingState.remeasurementReversals.some(
            (x) => x.originalResultId === r.id,
          )
        );
      });
      expect(facts.overdueRemeasurement?.row ?? null).toEqual(expected ?? null);
      const globalDiagnostics = validateBookGlobalAdmission(
        {
          status: facts.basis.header.status,
          ...(facts.basis.openingBoundary === null
            ? {}
            : { openingBoundary: facts.basis.openingBoundary.row }),
        },
        command,
        () => facts.overdueRemeasurement?.row ?? null,
      );
      expect(facts.basis.headHash).toBe(
        ledgerIndexHeadCommitment(snapshot.head, COMPACT_LEDGER_FORMAT),
      );
      expect(Object.isFrozen(facts) && Object.isFrozen(facts.periods)).toBeTrue();
      const evaluation = executeBookCommand(
        snapshot.aggregate.state,
        snapshot.aggregate.protocol,
        command,
      );
      if (expected) {
        expect(evaluation.result.disposition).toBe("rejected");
        expect(globalDiagnostics).toEqual(evaluation.result.diagnostics);
        expect(evaluation.result.diagnostics[0]?.code).toBe("currency_remeasurement_violation");
        expect(evaluation.result.diagnostics[0]?.path).toBe(
          "state.accountingState.remeasurementResults",
        );
      } else {
        expect(globalDiagnostics).toEqual([]);
        expect(
          evaluation.result.diagnostics.some(
            (d) => d.path === "state.accountingState.remeasurementResults",
          ),
        ).toBeFalse();
      }
      await reader.close();
      return facts;
    };
    expect((await inspect(probe(5n, "2026-01-15"))).overdueRemeasurement).toBeNull();
    expect((await inspect(probe(5n, "2026-01-16"))).overdueRemeasurement).toBeNull();
    expect((await inspect(probe(5n, "2026-01-17"))).overdueRemeasurement?.row.id).toBe(
      scenario.firstMeasurement.request.id,
    );
    const exceptFirst = sealCommand({
      ...scenario.reverse(scenario.firstMeasurement, 5n),
      issuedAt: instant("2026-01-17T18:00:00Z"),
      completedAt: instant("2026-01-17T18:00:01Z"),
      committedAt: instant("2026-01-17T18:00:02Z"),
    });
    expect((await inspect(exceptFirst)).overdueRemeasurement).toBeNull();
    const firstReversal = await f.ledger.execute(scenario.reverse(scenario.firstMeasurement, 5n));
    expect(firstReversal.result.disposition, JSON.stringify(firstReversal.result.diagnostics)).toBe(
      "committed",
    );
    await assertGroupDirectory(f, await f.ledger.read());
    expect((await inspect(probe(6n, "2026-01-17"))).overdueRemeasurement?.row.id).toBe(
      scenario.secondMeasurement.request.id,
    );
    expect(
      (await f.ledger.execute(scenario.reverse(scenario.secondMeasurement, 6n))).result.disposition,
    ).toBe("committed");
    await assertGroupDirectory(f, await f.ledger.read());
    expect((await inspect(probe(7n, "2026-01-17"))).overdueRemeasurement).toBeNull();
    expect(f.db.query("SELECT COUNT(*) AS n FROM ledger_outcomes").get()).toEqual({ n: 7 });
  } finally {
    f.db.close();
  }
});

test("admission facts exclude realized results from the unrealized obligation population", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    const scenario = admissionFxWorkflow();
    await f.ledger.provision(scenario.initial);
    for (const command of scenario.commands.slice(0, 3)) await f.ledger.execute(command);
    const realized = sealCommand({
      ...scenario.firstMeasurement,
      request: { ...scenario.firstMeasurement.request, kind: "realized" as const },
    });
    const receipt = await f.ledger.execute(realized);
    expect(receipt.result.disposition, JSON.stringify(receipt.result.diagnostics)).toBe(
      "committed",
    );
    expect((await f.ledger.execute(scenario.secondMeasurement)).result.disposition).toBe(
      "committed",
    );
    const snapshot = await f.ledger.read();
    await assertGroupDirectory(f, snapshot);
    expect(
      snapshot.aggregate.state.accountingState.remeasurementResults.map((r) => r.kind),
    ).toEqual(["realized", "unrealized"]);
    const reader = await f.storage.openCurrentRowReader();
    const command = sealCommand({
      ...posting("realized-filter-probe", 5n),
      issuedAt: instant("2026-01-17T18:00:00Z"),
      completedAt: instant("2026-01-17T18:00:01Z"),
      committedAt: instant("2026-01-17T18:00:02Z"),
    });
    expect((await reader.readAdmissionFacts(command)).overdueRemeasurement?.row.id).toBe(
      scenario.secondMeasurement.request.id,
    );
    await reader.close();
  } finally {
    f.db.close();
  }
});

test("admission facts use current policy replacement instead of the policy embedded in old FX results", async () => {
  const scenario = admissionFxWorkflow(false);
  const f = fixture(":memory:", BOOK, true);
  try {
    await f.ledger.provision(scenario.initial);
    for (const command of scenario.commands)
      expect((await f.ledger.execute(command)).result.disposition).toBe("committed");
    const request = (revision: bigint) =>
      sealCommand({
        ...posting("current-policy-probe", revision),
        issuedAt: instant("2026-01-17T18:00:00Z"),
        completedAt: instant("2026-01-17T18:00:01Z"),
        committedAt: instant("2026-01-17T18:00:02Z"),
      });
    await f.ledger.read();
    const before = await f.storage.openCurrentRowReader();
    expect((await before.readAdmissionFacts(request(5n))).overdueRemeasurement).toBeNull();
    await before.close();
    const s = (await f.ledger.read()).aggregate.state;
    const changed = sealCommand({
      id: commandId("change-fx-reversal-rule"),
      type: "replaceConfiguration" as const,
      bookId: BOOK,
      actorId: activation().actorId,
      protocolVersion: activation().protocolVersion,
      expectedBookRevision: 5n,
      expectedConfigurationRevision: 0n,
      issuedAt: instant("2026-01-16T17:00:00Z"),
      completedAt: instant("2026-01-16T17:00:01Z"),
      committedAt: instant("2026-01-16T17:00:02Z"),
      effectiveOn: localDate("2026-01-17"),
      periods: s.periods,
      admissionSnapshot: s.admissionSnapshot,
      policies: s.policies,
      quantizationPolicies: s.quantizationPolicies,
      accountingPolicies: s.accountingPolicySnapshot.policies.map((p) =>
        p.kind === "currencyRemeasurement"
          ? { ...p, version: semanticVersion("1.0.1"), reversalRequired: true }
          : p,
      ),
    });
    const receipt = await f.ledger.execute(changed);
    expect(receipt.result.disposition, JSON.stringify(receipt.result.diagnostics)).toBe(
      "committed",
    );
    const snapshot = await f.open().ledger.read();
    expect(
      snapshot.aggregate.state.accountingState.remeasurementResults[0]?.policy?.reversalRequired,
    ).toBeFalse();
    await f.ledger.read();
    const after = await f.storage.openCurrentRowReader();
    expect((await after.readAdmissionFacts(request(6n))).overdueRemeasurement?.row.id).toBe(
      scenario.firstMeasurement.request.id,
    );
    const expected = executeBookCommand(
      snapshot.aggregate.state,
      snapshot.aggregate.protocol,
      request(6n),
    );
    expect(expected.result.disposition).toBe("rejected");
    expect(expected.result.diagnostics[0]?.code).toBe("currency_remeasurement_violation");
    await after.close();
    const duplicated = sealCommand({
      ...changed,
      id: commandId("first-current-policy-wins"),
      expectedBookRevision: 6n,
      expectedConfigurationRevision: 1n,
      accountingPolicies: changed.accountingPolicies.flatMap<AccountingPolicy>((p) =>
        p.kind === "currencyRemeasurement" && p.id === scenario.firstMeasurement.request.policyId
          ? [{ ...p, version: semanticVersion("1.0.2"), reversalRequired: false }, p]
          : [p],
      ),
    });
    const duplicateReceipt = await f.ledger.execute(duplicated);
    expect(
      duplicateReceipt.result.disposition,
      JSON.stringify(duplicateReceipt.result.diagnostics),
    ).toBe("committed");
    await f.ledger.read();
    const firstWins = await f.storage.openCurrentRowReader();
    expect((await firstWins.readAdmissionFacts(request(7n))).overdueRemeasurement?.row.id).toBe(
      scenario.secondMeasurement.request.id,
    );
    await firstWins.close();
  } finally {
    f.db.close();
  }
});

test("inventory cost facts include every live policy-pool holding and exact current lot source", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    const scenario = inventoryReadWorkflow();
    await f.ledger.provision(scenario.initial);
    for (const command of scenario.commands)
      expect((await f.ledger.execute(command)).result.disposition).toBe("committed");
    const snapshot = await f.ledger.read();
    const command = scenario.command(snapshot.aggregate.state);
    const expected = snapshot.aggregate.state.lotHoldings
      .filter(
        (h) =>
          scenario.policy.pools.some((p) => p.accountId === h.accountId) &&
          h.commodityId === command.inventoryCommodityId &&
          !h.remainingQuantity.isZero(),
      )
      .map((h) => ({
        id: h.id,
        accountId: h.accountId,
        acquiredAt: workflowValue(snapshot.aggregate.state.lots.find((l) => l.id === h.lotId))
          .acquiredAt,
        quantity: h.remainingQuantity,
        totalBasis: h.remainingTotalBasis,
      }))
      .sort((a, b) => compareCanonicalText(a.id, b.id));
    expect(expected.map((layer) => [layer.id, layer.quantity.toString()])).toEqual([
      ["lot-destination", "5/1"],
      ["lot-second", "7/1"],
    ]);
    for (const owner of [f, f.open()]) {
      await owner.ledger.read();
      const reader = await owner.storage.openCurrentRowReader();
      const facts = await reader.readInventoryCostFacts(command);
      expect(facts.layers).toEqual(expected);
      expect(facts.policy).toEqual(scenario.policy);
      expect(inventoryCostLayersMatch(facts.layers, command.request.layers)).toBeTrue();
      expect(Object.isFrozen(facts) && Object.isFrozen(facts.layers)).toBeTrue();
      expect(facts.layers[0]?.quantity).toBeInstanceOf(ExactRational);
      expect(facts.sources.map((source) => source.holdingId)).toEqual(expected.map((l) => l.id));
      for (const source of facts.sources) {
        expect((await reader.read("state.lotHoldings", source.holdingOrdinal)).rowHash).toBe(
          source.holdingRowHash,
        );
        expect((await reader.read("state.lots", source.lotOrdinal)).rowHash).toBe(
          source.lotRowHash,
        );
      }
      const omitted = sealCommand({ ...command, request: { ...command.request, layers: [] } });
      const complete = await reader.readInventoryCostFacts(omitted);
      expect(complete.layers).toEqual(expected);
      expect(inventoryCostLayersMatch(complete.layers, omitted.request.layers)).toBeFalse();
      const rejection = executeBookCommand(
        snapshot.aggregate.state,
        snapshot.aggregate.protocol,
        omitted,
      );
      expect(rejection.result.disposition).toBe("rejected");
      expect(rejection.result.diagnostics[0]?.path).toBe("command.request.layers");
      const absentPolicy = await reader.readInventoryCostFacts(
        sealCommand({
          ...command,
          request: { ...command.request, policyVersion: semanticVersion("9.0.0") },
        }),
      );
      expect(absentPolicy.policy).toBeNull();
      expect(absentPolicy.layers).toEqual([]);
      const otherCommodity = await reader.readInventoryCostFacts(
        sealCommand({ ...command, inventoryCommodityId: commodityId("unheld") }),
      );
      expect(otherCommodity.layers).toEqual([]);
      expect(otherCommodity.sources).toEqual([]);
      const forgedHash = await reader.readInventoryCostFacts({
        ...command,
        inputHash: hashCanonical({ forged: true }),
      });
      expect(forgedHash.commandInputHash).toEqual(command.inputHash);
      const [first, second] = await Promise.all([
        reader.readInventoryCostFacts(command),
        reader.readInventoryCostFacts(command),
        reader.close(),
      ]);
      expect(first.layers).toEqual(second.layers);
      expect((await owner.ledger.read()).head).toEqual(snapshot.head);
    }
    const receipt = await f.ledger.execute(command);
    expect(receipt.result.disposition, JSON.stringify(receipt.result.diagnostics)).toBe(
      "committed",
    );
    const after = await f.ledger.read();
    const reader = await f.storage.openCurrentRowReader();
    const next = await reader.readInventoryCostFacts(
      scenario.command(after.aggregate.state, "next-cost"),
    );
    expect(
      next.layers.map((layer) => [
        layer.id,
        layer.quantity.toString(),
        layer.totalBasis.toString(),
      ]),
    ).toEqual([
      ["lot-destination", "4/1", "4/1"],
      ["lot-second", "7/1", "7/1"],
    ]);
    await reader.close();
  } finally {
    f.db.close();
  }
});

test("inventory facts exhaust paged multi-account groups and reuse only verified lot fields", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    const scenario = inventoryReadWorkflow();
    await f.ledger.provision(scenario.initial);
    for (const c of scenario.commands.slice(0, -1)) await f.ledger.execute(c);
    const snapshot = await f.ledger.read();
    const command = scenario.command(snapshot.aggregate.state);
    const reader = await f.storage.openCurrentRowReader();
    const basis = await reader.readBookBasis();
    let pages = 0;
    const lookedUp: string[] = [];
    const facts = await readPinnedInventoryCostFacts(command, {
      basis: async () => basis,
      openGroup: async (values) => {
        const cursor = await reader.openGroup("nonzeroHoldingsByAccountCommodity", values, 1);
        return {
          next: async () => {
            pages++;
            return cursor.next();
          },
          close: () => cursor.close(),
        };
      },
      lot: async (id) => {
        lookedUp.push(id);
        return reader.readLotIdentity("lot", id);
      },
      confirm: async () => {
        expect((await reader.readBookBasis()).headHash).toBe(basis.headHash);
      },
    });
    expect(pages).toBe(4); // destination, two cash pages, proven-empty income group
    expect(lookedUp).toEqual(["lot-first", "lot-second"]);
    expect(facts.layers.map((l) => [l.id, l.quantity.toString()])).toEqual([
      ["lot-destination", "5/1"],
      ["lot-first", "5/1"],
      ["lot-second", "7/1"],
    ]);
    expect(inventoryCostLayersMatch(facts.layers, command.request.layers)).toBeTrue();
    let closed = 0;
    await expect(
      readPinnedInventoryCostFacts(command, {
        basis: async () => basis,
        openGroup: async (values) => {
          const cursor = await reader.openGroup("nonzeroHoldingsByAccountCommodity", values, 1);
          let page = 0;
          return {
            next: async () => {
              if (++page === 2) throw new Error("required next page unavailable");
              return cursor.next();
            },
            close: async () => {
              closed++;
              await cursor.close();
            },
          };
        },
        lot: (id) => reader.readLotIdentity("lot", id),
        confirm: async () => {},
      }),
    ).rejects.toThrow("required next page unavailable");
    expect(closed).toBe(2);
    await reader.close();
    expect((await f.ledger.read()).head).toEqual(snapshot.head);
  } finally {
    f.db.close();
  }
});

test("inventory cost facts fail closed during holding and lot source reads", async () => {
  for (const stage of [3, 4, 5, 6])
    for (const failure of ["missing", "expiry"]) {
      const f = fixture(":memory:", BOOK, true);
      try {
        const scenario = inventoryReadWorkflow();
        await f.ledger.provision(scenario.initial);
        for (const c of scenario.commands) await f.ledger.execute(c);
        const snapshot = await f.ledger.read();
        const command = scenario.command(snapshot.aggregate.state);
        const reader = await f.storage.openCurrentRowReader();
        const exec = f.port.sql.exec.bind(f.port.sql);
        let reads = 0;
        f.port.sql.exec = (sql, ...bindings) => {
          const rows = exec(sql, ...bindings);
          if (sql.includes("FROM ledger_chunks") && ++reads === stage) {
            if (failure === "missing") return [];
            f.faults.now = 110n;
          }
          return rows;
        };
        await expect(reader.readInventoryCostFacts(command)).rejects.toThrow();
        expect(reads).toBe(stage);
        await expect(reader.readInventoryCostFacts(command)).rejects.toThrow(
          "source_catalog_reader_closed",
        );
        expect(f.db.query("SELECT COUNT(*) AS n FROM ledger_outcomes").get()).toEqual({
          n: scenario.commands.length,
        });
      } finally {
        f.db.close();
      }
    }
});

test("inventory read boundaries reject foreign views, missing lots, excess populations and partial pages", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    const scenario = inventoryReadWorkflow();
    await f.ledger.provision(scenario.initial);
    for (const c of scenario.commands) await f.ledger.execute(c);
    const snapshot = await f.ledger.read();
    const command = scenario.command(snapshot.aggregate.state);
    const reader = await f.storage.openCurrentRowReader();
    const basis = await reader.readBookBasis();
    for (const failure of [
      "head",
      "key",
      "population",
      "incomplete",
      "lot",
      "lot-row",
      "holding",
      "count",
    ]) {
      let closed = 0;
      const reading = readPinnedInventoryCostFacts(command, {
        basis: async () => basis,
        openGroup: async (values) => {
          const cursor = await reader.openGroup("nonzeroHoldingsByAccountCommodity", values);
          return {
            next: async () => {
              const page = await cursor.next();
              if (failure === "head") return { ...page, headHash: "wrong" };
              if (failure === "key")
                return {
                  ...page,
                  key: { ...page.key, values: ["wrong", command.inventoryCommodityId] },
                };
              if (failure === "population")
                return { ...page, population: BigInt(ACCOUNTING_LIMITS.maxInventoryLayers + 1) };
              if (failure === "incomplete") return { ...page, complete: false, rows: [] };
              if (failure === "holding")
                return {
                  ...page,
                  rows: page.rows.map((m) => ({
                    ...m,
                    row: { ...m.row, remainingQuantity: ExactRational.of(0n, 1n) },
                  })),
                };
              if (failure === "count") return { ...page, consumed: page.consumed + 1n };
              return page;
            },
            close: async () => {
              closed++;
              await cursor.close();
            },
          };
        },
        lot: async (id) => {
          if (failure === "lot") return reader.readLotIdentity("lot", "missing");
          const found = await reader.readLotIdentity("lot", id);
          if (failure === "lot-row" && found.disposition === "present")
            return { ...found, current: { ...found.current, rowHash: null } };
          return found;
        },
        confirm: async () => {},
      });
      await expect(reading).rejects.toThrow();
      expect(closed).toBe(1);
    }
    await reader.close();
    const invalid = await f.storage.openCurrentRowReader();
    await expect(invalid.readInventoryCostFacts(posting())).rejects.toThrow(
      "inventory_facts_command_invalid",
    );
    await expect(invalid.readInventoryCostFacts(command)).rejects.toThrow(
      "source_catalog_reader_closed",
    );
    const stale = await f.storage.openCurrentRowReader();
    await f
      .open()
      .ledger.execute(
        posting("invalidate-inventory-reader", snapshot.aggregate.state.bookRevision),
      );
    await expect(stale.readInventoryCostFacts(command)).rejects.toThrow();
  } finally {
    f.db.close();
  }
});

test("activation identity sources preserve original financial identity after configuration and later outcomes", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    const initial = genesis();
    await f.ledger.provision(initial);
    const configuring = await f.storage.openCurrentRowReader();
    expect((await configuring.readActivationIdentity("opening")).disposition).toBe("absent");
    await configuring.close();
    expect(
      (await f.ledger.execute(posting("pre-activation-rejection", 99n))).result.disposition,
    ).toBe("rejected");
    const configure = sealCommand({
      id: commandId("pre-activation-config"),
      type: "replaceConfiguration" as const,
      bookId: BOOK,
      protocolVersion: activation().protocolVersion,
      actorId: activation().actorId,
      expectedBookRevision: 0n,
      expectedConfigurationRevision: 0n,
      issuedAt: instant("2025-12-20T00:00:00Z"),
      completedAt: instant("2025-12-20T00:00:01Z"),
      committedAt: instant("2025-12-20T00:00:02Z"),
      effectiveOn: localDate("2025-12-20"),
      periods: initial.state.periods,
      admissionSnapshot: initial.state.admissionSnapshot,
      policies: initial.state.policies,
      quantizationPolicies: initial.state.quantizationPolicies,
      accountingPolicies: initial.state.accountingPolicySnapshot.policies,
    });
    expect((await f.ledger.execute(configure)).result.disposition).toBe("committed");
    expect(
      (await f.ledger.execute(sealCommand({ ...activation(), expectedBookRevision: 1n }))).result
        .disposition,
    ).toBe("committed");
    expect((await f.ledger.execute(posting("after-activation", 2n))).result.disposition).toBe(
      "committed",
    );
    expect(
      (
        await f.ledger.execute(
          sealCommand({
            ...configure,
            id: commandId("after-activation-config"),
            expectedBookRevision: 3n,
            expectedConfigurationRevision: 1n,
            issuedAt: instant("2026-02-01T00:00:00Z"),
            completedAt: instant("2026-02-01T00:00:01Z"),
            committedAt: instant("2026-02-01T00:00:02Z"),
            effectiveOn: localDate("2026-02-01"),
            admissionSnapshot: {
              ...initial.state.admissionSnapshot,
              accounts: initial.state.admissionSnapshot.accounts.map((account) => ({
                ...account,
                name: `Updated ${account.name}`,
              })),
            },
          }),
        )
      ).result.disposition,
    ).toBe("committed");
    for (const owner of [f, f.open()]) {
      const snapshot = await owner.ledger.read();
      const reader = await owner.storage.openCurrentRowReader();
      const basis = await reader.readBookBasis();
      if (basis.openingBoundary === null) throw new Error("Required opening boundary missing");
      const found = await reader.readActivationIdentity(basis.openingBoundary.row.id);
      if (found.disposition !== "present") throw new Error("Required activation missing");
      expect(found.outcomeSequence).toBe(3n);
      expect(found.bookRevision).toBe(2n);
      expect(found.effect.configurationSnapshot.revision).toBe(1n);
      expect(basis.configuration.row.revision).toBe(2n);
      expect(found.headHash).toBe(basis.headHash);
      expect(found.catalogDigest).toBe(basis.catalogDigest);
      expect(found.effect).toEqual(
        workflowValue(
          workflowValue(snapshot.aggregate.state.revisions[1]).effects.find(
            (effect) => effect.type === "activation",
          ),
        ),
      );
      expect(found.effect.boundary).toEqual(basis.openingBoundary.row);
      expect((await reader.read("state.revisions", 2n)).rowHash).toBe(found.sourceRevisionRowHash);
      const context = { ...basis.configuration.row, ...basis.header };
      expect(
        validateBookFinancialIdentity(context, () => found.effect.financialIdentityHash),
      ).toEqual([]);
      expect(validateBookConfiguration(context)).toEqual([]);
      expect(Object.isFrozen(found.effect.financialIdentityHash)).toBeTrue();
      for (const id of ["missing", "activate", "after-activation"])
        expect((await reader.readActivationIdentity(id)).disposition).toBe("absent");
      const retained = workflowValue((await reader.read("protocol.retainedResults", 3n)).encoded);
      const revision = workflowValue((await reader.read("state.revisions", 2n)).encoded);
      if (retained === null || revision === null)
        throw new Error("Required activation source missing");
      expect(() => resolveActivationIdentity(retained, revision, BOOK, "wrong-boundary")).toThrow(
        "index_identity_source_mismatch",
      );
      expect(() => resolveActivationIdentity(retained, revision, "wrong-book", "opening")).toThrow(
        "index_identity_source_mismatch",
      );
      const other = workflowValue((await reader.read("state.revisions", 3n)).encoded);
      if (other === null) throw new Error("Required comparison source missing");
      expect(() => resolveActivationIdentity(retained, other, BOOK, "opening")).toThrow(
        "index_identity_source_mismatch",
      );
      expect((await reader.readBookBasis()).headHash).toBe(basis.headHash);
      await reader.close();
      expect((await owner.ledger.read()).head).toEqual(snapshot.head);
    }
  } finally {
    f.db.close();
  }
});

test("activation identity reads fail closed at each source stage and on stale authority", async () => {
  for (const stage of [1, 2])
    for (const fault of ["missing", "expiry"]) {
      const f = fixture(":memory:", BOOK, true);
      try {
        await f.ledger.provision(genesis());
        await f.ledger.execute(activation());
        await f.ledger.execute(posting());
        await f.ledger.read();
        const reader = await f.storage.openCurrentRowReader();
        const exec = f.port.sql.exec.bind(f.port.sql);
        let reads = 0;
        f.port.sql.exec = (sql, ...bindings) => {
          const rows = exec(sql, ...bindings);
          if (sql.includes("FROM ledger_chunks") && ++reads === stage) {
            if (fault === "missing") return [];
            f.faults.now = 110n;
          }
          return rows;
        };
        await expect(reader.readActivationIdentity("opening")).rejects.toThrow();
        expect(reads).toBe(stage);
        await expect(reader.readActivationIdentity("missing")).rejects.toThrow(
          "source_catalog_reader_closed",
        );
        expect(f.db.query("SELECT COUNT(*) AS n FROM ledger_outcomes").get()).toEqual({ n: 2 });
      } finally {
        f.db.close();
      }
    }
  const f = fixture(":memory:", BOOK, true);
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    await f.ledger.read();
    for (const id of ["", " bad", null]) {
      const reader = await f.storage.openCurrentRowReader();
      await expect(reader.readActivationIdentity(id as string)).rejects.toThrow();
      await expect(reader.readActivationIdentity("opening")).rejects.toThrow(
        "source_catalog_reader_closed",
      );
    }
    const stale = await f.storage.openCurrentRowReader();
    await f.open().ledger.execute(posting());
    await expect(stale.readActivationIdentity("opening")).rejects.toThrow();
    await expect(stale.readActivationIdentity("missing")).rejects.toThrow(
      "source_catalog_reader_closed",
    );
  } finally {
    f.db.close();
  }
});

test("authenticated protocol inputs preserve restart retries and the financial clock across later rejections", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    await f.ledger.provision(genesis());
    expect((await f.ledger.execute(activation())).result.disposition).toBe("committed");
    const laterRejection = sealCommand({
      ...posting("later-rejected", 99n),
      issuedAt: instant("2026-02-01T00:00:00Z"),
      completedAt: instant("2026-02-01T00:00:01Z"),
      committedAt: instant("2026-02-01T00:00:02Z"),
    });
    expect((await f.ledger.execute(laterRejection)).result.disposition).toBe("rejected");
    const fresh = posting("financial-clock", 1n);
    async function compare(command: BookCommand) {
      // Fresh owner must recover and authenticate canonical/index bytes first.
      const owner = f.open();
      const snapshot = await owner.ledger.read();
      const reader = await owner.storage.openCurrentRowReader();
      try {
        const retained = await reader.readCommand(command.id);
        // An existing outcome needs no financial chronology/configuration fetch.
        const basis = retained.disposition === "absent" ? await reader.readBookBasis() : null;
        if (basis !== null) {
          expect(basis.headHash).toBe(retained.headHash);
          expect(basis.catalogDigest).toBe(retained.catalogDigest);
        }
        let chronologyReads = 0;
        const result = evaluateBookCommandProtocol(
          {
            identity: { bookId: BOOK },
            bookRevision: BigInt(reader.head.bookRevision),
            retainedCommand(id) {
              if (id !== retained.commandId) throw new Error("Unresolved retained command");
              return retained.row;
            },
            previousFinancialCommit() {
              chronologyReads++;
              if (basis === null) throw new Error("Retry must not read financial chronology");
              return basis.financialRevision?.row.committedAt ?? null;
            },
          },
          command,
        );
        const confirmed = await reader.readCommand(command.id);
        expect(confirmed.headHash).toBe(retained.headHash);
        expect(confirmed.catalogDigest).toBe(retained.catalogDigest);
        const canonical = evaluateBookCommand(
          snapshot.aggregate.state,
          snapshot.aggregate.protocol,
          command,
        );
        const admitted = await reader.evaluateAdmission(command);
        expect(admitted.commandId).toBe(command.id);
        expect(admitted.commandInputHash).toEqual(command.inputHash);
        expect(admitted.headHash).toBe(retained.headHash);
        expect(admitted.catalogDigest).toBe(retained.catalogDigest);
        expect(admitted.evaluation).toEqual(
          canonical.disposition === "finished" ? canonical : { disposition: "continue" },
        );
        if (result.disposition === "finished") {
          if (canonical.disposition !== "finished")
            throw new Error("Expected canonical protocol result");
          expect(result).toEqual(canonical);
        } else {
          expect(canonical.disposition).toBe("ready");
          expect(chronologyReads).toBe(1);
        }
        if (retained.disposition === "present") expect(chronologyReads).toBe(0);
        expect((await owner.ledger.read()).head).toEqual(snapshot.head);
        return result;
      } finally {
        await reader.close();
      }
    }
    // The latest outcome is February's rejection, but the financial clock is
    // still January 1. Substituting outcome time would incorrectly reject this.
    expect(await compare(fresh)).toEqual({ disposition: "continue" });
    expect((await f.ledger.execute(fresh)).result.disposition).toBe("committed");
    for (const original of [activation(), fresh, laterRejection]) {
      const result = await compare(original);
      if (result.disposition !== "finished") throw new Error("Expected replay");
      expect(result.result.disposition).toBe("replayed");
      expect(result.retained).toBeUndefined();
      const altered = sealCommand({ ...original, expectedBookRevision: 777n });
      const conflict = await compare(altered);
      if (conflict.disposition !== "finished") throw new Error("Expected conflict");
      expect(conflict.result.diagnostics[0]?.code).toBe("command_identity_conflict");
      expect(conflict.retained).toBeUndefined();
      const forgedHash = await compare({ ...original, inputHash: hashCanonical({ forged: true }) });
      if (forgedHash.disposition !== "finished") throw new Error("Expected conflict");
      expect(forgedHash.result.diagnostics[0]?.code).toBe("command_identity_conflict");
    }
    const unsupported = sealCommand({
      ...posting("unsupported-protocol", 2n),
      protocolVersion: semanticVersion("9.0.0"),
    });
    const result = await compare(unsupported);
    if (result.disposition !== "finished") throw new Error("Expected protocol rejection");
    expect(result.retained?.outcome).toBe("rejected");
  } finally {
    f.db.close();
  }
});

test("authenticated journal inputs match shared kernel preparation and canonical command results", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    await f.ledger.provision(genesis());
    expect((await f.ledger.execute(activation())).result.disposition).toBe("committed");
    expect((await f.ledger.execute(posting("existing"))).result.disposition).toBe("committed");
    async function compare(command: BookCommand) {
      if (command.type !== "postJournal") throw new Error("Journal fixture required");
      const snapshot = await f.ledger.read();
      const reader = await f.storage.openCurrentRowReader();
      try {
        const facts = await reader.readAdmissionFacts(command);
        expect(facts.overdueRemeasurement).toBeNull();
        const configuration = facts.basis.configuration.row;
        const journal = await reader.readJournalIdentity("journal", command.resolved.journal.id);
        const postings = new Map<string, "present" | "absent">();
        for (const posting of command.resolved.journal.postings) {
          postings.set(
            posting.id,
            (await reader.readJournalIdentity("posting", posting.id)).disposition,
          );
        }
        const context: BookJournalReadContext = {
          identity: facts.basis.header.identity,
          periods: configuration.periods,
          admissionSnapshot: configuration.admissionSnapshot,
          policies: configuration.policies,
          quantizationPolicies: configuration.quantizationPolicies,
          journalIdentity(id) {
            if (id !== command.resolved.journal.id) throw new Error("Unresolved journal identity");
            return journal.disposition;
          },
          postingIdentity(id) {
            const disposition = postings.get(id);
            if (disposition === undefined) throw new Error("Unresolved posting identity");
            return disposition;
          },
          periodStatus(id) {
            const period = facts.periods.find((period) => period.periodId === id);
            if (period === undefined) throw new Error("Unresolved period closure");
            return period.closed ? "closed" : "open";
          },
        };
        const prepared = prepareBookJournal(
          context,
          command,
          command.resolved,
          command.fiscalPeriodId,
          facts.basis.header.bookRevision + 1n,
          facts.basis.header.latestPostingSequence + 1n,
          false,
        );
        // Reconfirm the live reader after all reads and calculation. This is a
        // comparison harness, NOT the publication authority or a command evaluator.
        expect((await reader.readBookBasis()).headHash).toBe(facts.basis.headHash);
        const canonical = executeBookCommand(
          snapshot.aggregate.state,
          snapshot.aggregate.protocol,
          command,
        );
        if ("journal" in prepared) {
          expect(canonical.result.disposition).toBe("committed");
          expect(prepared).toEqual(workflowValue(canonical.state.journals.at(-1)));
        } else {
          expect(canonical.result.disposition).toBe("rejected");
          expect(prepared).toEqual(canonical.result.diagnostics);
        }
        expect((await f.ledger.read()).head).toEqual(snapshot.head);
        return prepared;
      } finally {
        await reader.close();
      }
    }
    const valid = posting("fresh", 2n);
    expect("journal" in (await compare(valid))).toBeTrue();
    const duplicate = sealCommand({
      ...posting("existing", 2n),
      id: commandId("new-command-existing-journal"),
    });
    expect(await compare(duplicate)).toMatchObject([
      { code: "canonical_identity_conflict", path: "resolved.journal.id" },
    ]);
    if (valid.type !== "postJournal") throw new Error("Journal fixture required");
    const postingDuplicate = sealCommand({
      ...valid,
      id: commandId("duplicate-posting"),
      resolved: {
        ...valid.resolved,
        journal: {
          ...valid.resolved.journal,
          postings: valid.resolved.journal.postings.map((p, i) =>
            i === 0 ? { ...p, id: postingId("existing-0") } : p,
          ),
        },
      },
    });
    expect(await compare(postingDuplicate)).toMatchObject([
      { code: "canonical_identity_conflict", path: "resolved.journal.postings" },
    ]);
    expect(
      (
        await f.ledger.execute(
          sealCommand({
            bookId: BOOK,
            actorId: activation().actorId,
            protocolVersion: activation().protocolVersion,
            id: commandId("close-for-preparation"),
            type: "closePeriod" as const,
            expectedBookRevision: 2n,
            periodId: fiscalPeriodId("january"),
            closePackageId: closePackageId("preparation-close"),
            reason: "Close test period",
            issuedAt: instant("2026-02-01T00:00:00Z"),
            completedAt: instant("2026-02-01T00:00:01Z"),
            committedAt: instant("2026-02-01T00:00:02Z"),
            reportPopulationHash: hashCanonical({ fixtureReport: "preparation" }),
            reportingPolicySnapshotHash: hashCanonical({ fixturePolicy: "preparation" }),
          }),
        )
      ).result.disposition,
    ).toBe("committed");
    const closed = sealCommand({
      ...posting("closed", 3n),
      issuedAt: instant("2026-02-02T00:00:00Z"),
      completedAt: instant("2026-02-02T00:00:01Z"),
      committedAt: instant("2026-02-02T00:00:02Z"),
    });
    expect(await compare(closed)).toMatchObject([{ code: "fiscal_period_admission" }]);
  } finally {
    f.db.close();
  }
});

test("admission facts distinguish period closure from superseded close packages", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    const base = genesis();
    const jan = workflowValue(base.state.periods[0]);
    const initial = {
      ...base,
      state: createBookState(
        base.state.identity,
        [
          jan,
          {
            ...jan,
            id: fiscalPeriodId("february"),
            sequence: 2n,
            label: "February",
            startsOn: localDate("2026-02-01"),
            endsOn: localDate("2026-02-28"),
          },
        ],
        base.state.admissionSnapshot,
        base.state.policies,
        base.state.quantizationPolicies,
        [],
        instant("2020-01-01T00:00:00Z"),
      ),
    };
    await f.ledger.provision(initial);
    await f.ledger.execute(activation());
    await f.ledger.execute(posting());
    const common = {
      bookId: BOOK,
      actorId: activation().actorId,
      protocolVersion: activation().protocolVersion,
      issuedAt: instant("2026-03-01T00:00:00Z"),
      completedAt: instant("2026-03-01T00:00:01Z"),
      committedAt: instant("2026-03-01T00:00:02Z"),
    };
    const inspect = async (expected: [boolean, bigint][]) => {
      const snapshot = await f.ledger.read();
      await assertGroupDirectory(f, snapshot);
      const reader = await f.storage.openCurrentRowReader();
      const command = sealCommand({
        ...posting("period-facts", snapshot.aggregate.state.bookRevision),
        ...common,
      });
      const facts = await reader.readAdmissionFacts(command);
      expect(facts.periods.map((p) => [p.closed, p.transitionCount])).toEqual(expected);
      // Period admission consumes no fabricated journal or posting. Its closure
      // inputs still come from the complete, source-verified transition groups.
      const periodContext = {
        periods: facts.basis.configuration.row.periods,
        periodStatus(id: ReturnType<typeof fiscalPeriodId>): "open" | "closed" {
          const fact = facts.periods.find((p) => p.periodId === id);
          if (fact === undefined) throw new Error("Unresolved period closure");
          return fact.closed ? "closed" : "open";
        },
      };
      for (const [i, period] of periodContext.periods.entries()) {
        for (const date of [period.startsOn, period.endsOn]) {
          const selected = resolveBookAccountingPeriod(
            periodContext,
            { accountingDate: date, kind: "ordinary" },
            undefined,
            false,
          );
          if (workflowValue(expected[i])[0]) {
            expect(selected).toEqual({
              code: "fiscal_period_admission",
              path: "fiscalPeriodId",
              message: `Fiscal period ${period.id} is closed`,
              requirementIds: ["ACC-029", "ACC-032"],
            });
          } else expect(selected).toEqual(period);
        }
      }
      expect((await reader.readBookBasis()).headHash).toBe(facts.basis.headHash);
      expect((await f.ledger.read()).head).toEqual(snapshot.head);
      for (const period of facts.periods) {
        const last = snapshot.aggregate.state.periodTransitions
          .filter((t) => t.periodId === period.periodId)
          .at(-1);
        expect(period.lastTransition?.kind ?? null).toEqual(last?.kind ?? null);
        if (last) {
          const ordinal = BigInt(snapshot.aggregate.state.periodTransitions.lastIndexOf(last)) + 1n;
          expect(period.lastTransition?.ordinal).toBe(ordinal);
          expect(period.lastTransition?.rowHash ?? null).toBe(
            (await reader.read("state.periodTransitions", ordinal)).rowHash,
          );
        } else expect(period.lastTransition).toBeNull();
      }
      await reader.close();
      return snapshot;
    };
    await inspect([
      [false, 0n],
      [false, 0n],
    ]);
    for (const [i, id] of ["january", "february"].entries()) {
      const command = sealCommand({
        ...common,
        id: commandId(`close-${id}`),
        type: "closePeriod" as const,
        expectedBookRevision: BigInt(i + 2),
        periodId: fiscalPeriodId(id),
        closePackageId: closePackageId(`close-${id}`),
        reason: "Close test period",
        reportPopulationHash: hashCanonical({ fixtureReport: id }),
        reportingPolicySnapshotHash: hashCanonical({ fixturePolicy: id }),
      });
      const receipt = await f.ledger.execute(command);
      expect(receipt.result.disposition, JSON.stringify(receipt.result.diagnostics)).toBe(
        "committed",
      );
    }
    await inspect([
      [true, 1n],
      [true, 1n],
    ]);
    const reopen = sealCommand({
      ...common,
      id: commandId("reopen-january"),
      type: "reopenPeriod" as const,
      expectedBookRevision: 4n,
      periodId: fiscalPeriodId("january"),
      reason: "Correct January",
    });
    expect((await f.ledger.execute(reopen)).result.disposition).toBe("committed");
    const snapshot = await inspect([
      [false, 2n],
      [true, 1n],
    ]);
    expect(snapshot.aggregate.state.periodTransitions.at(-1)?.supersededCloseIds).toEqual([
      closePackageId("close-january"),
      closePackageId("close-february"),
    ]);
  } finally {
    f.db.close();
  }
});

test("admission facts fail closed when reversal evidence or live authority is lost", async () => {
  for (const failure of [
    "reversal-source",
    "reversal-directory",
    "expiry",
    "fence",
    "publication",
  ]) {
    const f = fixture(":memory:", BOOK, true);
    try {
      const scenario = admissionFxWorkflow();
      await f.ledger.provision(scenario.initial);
      for (const command of scenario.commands) await f.ledger.execute(command);
      await f.ledger.execute(scenario.reverse(scenario.firstMeasurement, 5n));
      await f.ledger.execute(scenario.reverse(scenario.secondMeasurement, 6n));
      await f.ledger.read();
      const reader = await f.storage.openCurrentRowReader();
      const command = sealCommand({
        ...posting("fault-facts", 7n),
        issuedAt: instant("2026-01-17T18:00:00Z"),
        completedAt: instant("2026-01-17T18:00:01Z"),
        committedAt: instant("2026-01-17T18:00:02Z"),
      });
      if (failure === "reversal-source")
        f.db.query("DELETE FROM ledger_chunks WHERE record_id = '6'").run();
      if (failure === "reversal-directory") {
        const descriptors = f.db
          .query("SELECT digest, body FROM ledger_group_descriptors")
          .all() as { digest: string; body: string }[];
        const d = workflowValue(
          descriptors.find((d) => {
            const key = JSON.parse(d.body).key;
            return (
              key.kind === "reversalsByOriginalResult" &&
              key.values[0] === scenario.firstMeasurement.request.id
            );
          }),
        );
        f.db.query("DELETE FROM ledger_group_descriptors WHERE digest = ?").run(d.digest);
      }
      let fired = 0;
      if (failure === "expiry" || failure === "fence") {
        const exec = f.port.sql.exec.bind(f.port.sql);
        f.port.sql.exec = (sql, ...bindings) => {
          const rows = exec(sql, ...bindings);
          if (fired === 0 && sql.includes("FROM ledger_group_nodes")) {
            fired++;
            if (failure === "expiry") f.faults.now += 101n;
            else f.faults.fence = "1";
          }
          return rows;
        };
      }
      if (failure === "publication")
        expect((await f.open().ledger.execute(command)).result.disposition).toBe("committed");
      await expect(reader.readAdmissionFacts(command)).rejects.toThrow();
      if (failure === "expiry" || failure === "fence") expect(fired).toBe(1);
      await expect(reader.readBookBasis()).rejects.toThrow("source_catalog_reader_closed");
      expect(f.db.query("SELECT COUNT(*) AS n FROM ledger_outcomes").get()).toEqual({
        n: failure === "publication" ? 8 : 7,
      });
    } finally {
      f.db.close();
    }
  }
});

test("admission facts serialize whole nested reads and close without trusting a supplied input hash", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    const scenario = admissionFxWorkflow();
    await f.ledger.provision(scenario.initial);
    for (const command of scenario.commands) await f.ledger.execute(command);
    await f.ledger.read();
    const reader = await f.storage.openCurrentRowReader();
    const sealed = sealCommand({
      ...posting("nested-facts", 5n),
      issuedAt: instant("2026-01-17T18:00:00Z"),
      completedAt: instant("2026-01-17T18:00:01Z"),
      committedAt: instant("2026-01-17T18:00:02Z"),
    });
    const input = { ...sealed, inputHash: hashCanonical({ forged: true }) };
    const [first, second] = await Promise.all([
      reader.readAdmissionFacts(input),
      reader.readAdmissionFacts(sealed),
      reader.close(),
    ]);
    expect(workflowValue(first).commandInputHash).toEqual(sealed.inputHash);
    expect(workflowValue(first).overdueRemeasurement?.row.id).toBe(
      scenario.firstMeasurement.request.id,
    );
    expect(second).toEqual(first);
    await expect(reader.readAdmissionFacts(sealed)).rejects.toThrow("source_catalog_reader_closed");
    expect(f.db.query("SELECT COUNT(*) AS n FROM ledger_outcomes").get()).toEqual({ n: 5 });
  } finally {
    f.db.close();
  }
});

test("book basis reads exact configuration, boundary and financial sources without scanning outcomes", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    await f.ledger.execute(posting("basis-growth"));
    const exec = f.port.sql.exec.bind(f.port.sql);
    const calls: { sql: string; bindings: unknown[] }[] = [];
    let recording = false;
    f.port.sql.exec = (sql, ...bindings) => {
      if (recording) calls.push({ sql, bindings });
      return exec(sql, ...bindings);
    };
    for (const size of [2, 18]) {
      if (size === 18)
        for (let i = 2; i < 18; i++)
          expect(
            (await f.ledger.execute(posting(`basis-reject-${i}`, 0n))).result.disposition,
          ).toBe("rejected");
      const snapshot = await f.ledger.read();
      const reader = await f.storage.openCurrentRowReader();
      calls.length = 0;
      recording = true;
      const basis = await reader.readBookBasis();
      recording = false;
      expect(basis.header.bookRevision).toBe(2n);
      expect(basis.financialRevision?.row.command.id).toBe(commandId("basis-growth"));
      const sources = calls.filter((c) => c.sql.includes("FROM ledger_outcomes"));
      expect(sources.map((c) => c.bindings[0])).toEqual(["1", "2"]);
      expect(sources.every((c) => c.sql.includes("WHERE sequence = ? LIMIT 2"))).toBeTrue();
      expect(
        calls.filter((c) => c.sql.includes("FROM ledger_chunks")).map((c) => c.bindings[0]),
      ).toEqual(["genesis", "1", "2"]);
      // The full evaluator remains the admission oracle. Only immutable record
      // construction consumes this authenticated scalar/source context; this is
      // not an indexed command evaluation or a publication path.
      const command = posting("basis-next", 2n);
      const evaluated = evaluateBookCommand(
        snapshot.aggregate.state,
        snapshot.aggregate.protocol,
        command,
      );
      if (evaluated.disposition !== "ready") throw new Error("Missing reference intent");
      const readCount = calls.length;
      const records = prepareBookCommitRecords(
        {
          bookId: basis.header.identity.bookId,
          bookRevision: basis.header.bookRevision,
          previousRevision: basis.financialRevision?.row ?? null,
        },
        evaluated.intent,
      );
      expect(calls.length).toBe(readCount);
      const canonical = executeBookCommand(
        snapshot.aggregate.state,
        snapshot.aggregate.protocol,
        command,
      );
      expect(canonical.state.revisions.at(-1)).toEqual(records.revision);
      expect(canonical.protocol.retainedResults.at(-1)).toEqual(records.retained);
      expect(records.result).toEqual(canonical.result);
      expect(f.db.query("SELECT COUNT(*) AS n FROM ledger_outcomes").get()).toEqual({ n: size });
      await reader.close();
    }
  } finally {
    f.db.close();
  }
});

test("common admission cannot release continuation or replay after its live pin expires", async () => {
  for (const command of [posting("admission-expiry"), activation()]) {
    const f = fixture(":memory:", BOOK, true);
    try {
      await f.ledger.provision(genesis());
      await f.ledger.execute(activation());
      const before = await f.ledger.read();
      const reader = await f.storage.openCurrentRowReader();
      const exec = f.port.sql.exec.bind(f.port.sql);
      let injected = 0;
      f.port.sql.exec = (sql, ...bindings) => {
        const rows = exec(sql, ...bindings);
        // The first confirmation has already captured its clock value. Expire
        // its lease during that check: only the AFTER-admission check can stop
        // the otherwise valid continuation or immutable retained replay.
        if (injected === 0 && sql.includes("FROM ledger_index_pins WHERE id = ?")) {
          injected++;
          f.faults.now += 101n;
        }
        return rows;
      };
      await expect(reader.evaluateAdmission(command)).rejects.toThrow("index_pin_expired");
      expect(injected).toBe(1);
      await expect(reader.evaluateAdmission(command)).rejects.toThrow(
        "source_catalog_reader_closed",
      );
      f.port.sql.exec = exec;
      const after = await f.open().ledger.read();
      expect(after.head).toEqual(before.head);
      expect(encodeDurableBook(after.aggregate)).toBe(encodeDurableBook(before.aggregate));
    } finally {
      f.db.close();
    }
  }
});

test("book basis refuses missing required sources and late lease expiry without partial results", async () => {
  for (const failure of ["missing", "expiry"])
    for (const sourceId of ["genesis", "1", "2"]) {
      const f = fixture(":memory:", BOOK, true);
      try {
        await f.ledger.provision(genesis());
        await f.ledger.execute(activation());
        await f.ledger.execute(posting("basis-fault"));
        await f.ledger.read();
        const reader = await f.storage.openCurrentRowReader();
        if (failure === "missing")
          f.db.query("DELETE FROM ledger_chunks WHERE record_id = ?").run(sourceId);
        const exec = f.port.sql.exec.bind(f.port.sql);
        let fired = 0;
        if (failure === "expiry")
          f.port.sql.exec = (sql, ...bindings) => {
            const rows = exec(sql, ...bindings);
            if (fired === 0 && sql.includes("FROM ledger_chunks") && bindings[0] === sourceId) {
              fired++;
              f.faults.now += 101n;
            }
            return rows;
          };
        await expect(reader.readBookBasis()).rejects.toThrow();
        if (failure === "expiry") expect(fired).toBe(1);
        await expect(reader.readBookBasis()).rejects.toThrow("source_catalog_reader_closed");
        expect(f.db.query("SELECT COUNT(*) AS n FROM ledger_outcomes").get()).toEqual({ n: 2 });
      } finally {
        f.db.close();
      }
    }
});

test("book basis is invalidated by publication and header or source-coordinate mismatch", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    const snapshot = await f.ledger.read();
    const reader = await f.storage.openCurrentRowReader();
    const basis = await reader.readBookBasis();
    for (const failure of [
      "revision",
      "identity",
      "state-hash",
      "source-head",
      "source-ordinal",
      "source-bytes",
      "missing-revision",
    ]) {
      const state = { ...snapshot.aggregate.state };
      if (failure === "revision") state.bookRevision += 1n;
      if (failure === "identity") state.identity = { ...state.identity, code: "OTHER" };
      if (failure === "state-hash") state.contentHash = hashCanonical({ changed: true });
      const read = async (collection: string, ordinal: bigint) => {
        const row = { ...(await reader.read(collection, ordinal)) };
        if (failure === "source-head") row.headHash = "0".repeat(64);
        if (failure === "source-ordinal") row.ordinal += 1n;
        if (failure === "source-bytes") row.encoded = "{}";
        if (failure === "missing-revision" && collection === "state.revisions") {
          row.disposition = "absent";
          row.encoded = null;
          row.rowHash = null;
        }
        return row;
      };
      await expect(
        readPinnedBookBasis(state, snapshot.head, basis.catalogDigest, read, async () => {}),
      ).rejects.toThrow(
        failure === "revision" || failure === "identity" || failure === "state-hash"
          ? "book_basis_header_mismatch"
          : "book_basis_source_mismatch",
      );
    }
    await f.open().ledger.execute(posting("basis-concurrent"));
    await expect(reader.readBookBasis()).rejects.toThrow();
    await expect(reader.readBookBasis()).rejects.toThrow("source_catalog_reader_closed");
    const renewed = f.open();
    await renewed.ledger.read();
    const live = await renewed.storage.openCurrentRowReader();
    const current = await live.readBookBasis();
    expect(current.header.bookRevision).toBe(2n);
    expect(current.headHash).not.toBe(basis.headHash);
    await live.close();
  } finally {
    f.db.close();
  }
});

test("group directory commits complete canonical populations and removes empty live groups", async () => {
  for (const scenario of [lotIdentityWorkflow(), allocationAndTaxWorkflow("1.1.0")]) {
    const f = fixture(":memory:", BOOK, true);
    try {
      await f.ledger.provision(scenario.initial);
      await assertGroupDirectory(f, await f.ledger.read());
      const commands =
        "source" in scenario
          ? scenario.commands
              .filter((c) => c.id !== "lot-second")
              .map((command, i) => sealCommand({ ...command, expectedBookRevision: BigInt(i) }))
          : scenario.commands;
      const counts: string[] = [];
      for (const command of commands) {
        expect((await f.ledger.execute(command)).result.disposition).toBe("committed");
        counts.push((await assertGroupDirectory(f, await f.ledger.read())).population);
      }
      if ("source" in scenario) expect(counts).toEqual(["0", "3", "5", "5", "4"]);
      else expect(counts.at(-1)).toBe("2");
      const before = await f.ledger.read();
      const root = (await assertGroupDirectory(f, before)).rootHash;
      await f.ledger.execute(posting("group-rejection", 0n));
      const reopened = await f.open().ledger.read();
      expect((await assertGroupDirectory(f, reopened)).rootHash).toBe(root);
      expect(reopened.head.sequence).not.toBe(before.head.sequence);
    } finally {
      f.db.close();
    }
  }
});

test("pinned groups return complete exact current rows in canonical order", async () => {
  for (const scenario of [lotIdentityWorkflow(), allocationAndTaxWorkflow("1.1.0")]) {
    const f = fixture(":memory:", BOOK, true);
    try {
      await f.ledger.provision(scenario.initial);
      for (const command of scenario.commands) await f.ledger.execute(command);
      const snapshot = await f.ledger.read();
      const state = snapshot.aggregate.state;
      const queries: [
        SemanticGroupKind,
        string[],
        string,
        { ordinal: bigint; encoded: string }[],
      ][] = [];
      for (const h of state.lotHoldings) {
        for (const kind of [
          "holdingsByLot",
          "holdingsByAccount",
          "nonzeroHoldingsByAccountCommodity",
        ] as const) {
          const values =
            kind === "holdingsByLot"
              ? [h.lotId]
              : kind === "holdingsByAccount"
                ? [h.accountId]
                : [h.accountId, h.commodityId];
          const expected = state.lotHoldings
            .map((row, i) => ({ row, ordinal: BigInt(i) + 1n }))
            .filter(({ row }) =>
              kind === "holdingsByLot"
                ? row.lotId === h.lotId
                : kind === "holdingsByAccount"
                  ? row.accountId === h.accountId
                  : row.accountId === h.accountId &&
                    row.commodityId === h.commodityId &&
                    row.remainingQuantity.numerator !== 0n,
            );
          queries.push([
            kind,
            values,
            "state.lotHoldings",
            expected.map(({ row, ordinal }) => ({
              ordinal,
              encoded: encodeBookRow("state.lotHoldings", row),
            })),
          ]);
        }
      }
      for (const r of state.accountingState.allocationRecognitions) {
        const expected = state.accountingState.allocationRecognitions
          .map((row, i) => ({ row, ordinal: BigInt(i) + 1n }))
          .filter(({ row }) => row.scheduleId === r.scheduleId);
        queries.push([
          "recognitionsBySchedule",
          [r.scheduleId],
          "state.accountingState.allocationRecognitions",
          expected.map(({ row, ordinal }) => ({
            ordinal,
            encoded: encodeBookRow("state.accountingState.allocationRecognitions", row),
          })),
        ]);
      }
      for (const kind of [
        "holdingsByLot",
        "holdingsByAccount",
        "nonzeroHoldingsByAccountCommodity",
        "recognitionsBySchedule",
      ] as const)
        queries.push([
          kind,
          kind === "nonzeroHoldingsByAccountCommodity" ? ["absent", "absent"] : ["absent"],
          "unused",
          [],
        ]);
      const reader = await f.storage.openCurrentRowReader();
      for (const limit of [1, 256])
        for (const [kind, values, collection, expected] of queries) {
          const cursor = await reader.openGroup(kind, values, limit);
          const actual: { ordinal: bigint; encoded: string }[] = [];
          for (let i = 0; i <= expected.length; i++) {
            const page = await cursor.next();
            expect(
              Object.isFrozen(page) &&
                Object.isFrozen(page.rows) &&
                Object.isFrozen(page.key.values),
            ).toBeTrue();
            expect(page.headHash).toBe(
              ledgerIndexHeadCommitment(snapshot.head, COMPACT_LEDGER_FORMAT),
            );
            expect(page.population).toBe(BigInt(expected.length));
            expect(page.key).toEqual({ kind, values });
            expect(page.rows.length).toBeLessThanOrEqual(limit);
            for (const row of page.rows) {
              expect(Object.isFrozen(row)).toBeTrue();
              expect(encodeBookRow(collection as BookRowCollection, row.row)).toBe(row.encoded);
              actual.push({ ordinal: row.ordinal, encoded: row.encoded });
            }
            expect(page.encodedRowBytes).toBe(
              page.rows.reduce((sum, row) => sum + new TextEncoder().encode(row.encoded).length, 0),
            );
            expect(page.consumed).toBe(BigInt(actual.length));
            expect(page.complete).toBe(actual.length === expected.length);
            if (page.complete) break;
          }
          expect(actual).toEqual(expected);
          await cursor.close();
        }
      await reader.close();
    } finally {
      f.db.close();
    }
  }
});

test("pinned group byte bounds preserve a gap-free prefix and exact final page", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    const scenario = lotIdentityWorkflow();
    await f.ledger.provision(scenario.initial);
    for (const command of scenario.commands.slice(0, 3)) await f.ledger.execute(command);
    const snapshot = await f.ledger.read();
    const expected = snapshot.aggregate.state.lotHoldings.map((row) =>
      encodeBookRow("state.lotHoldings", row),
    );
    const sizes = expected.map((row) => new TextEncoder().encode(row).length);
    const reader = await f.storage.openCurrentRowReader();
    const values = [workflowValue(snapshot.aggregate.state.lotHoldings[0]).accountId];
    const cursor = await reader.openGroup("holdingsByAccount", values, 256, Math.max(...sizes));
    const first = await cursor.next();
    expect(first.rows.map((r) => r.encoded)).toEqual(expected.slice(0, 1));
    expect(first.complete).toBeFalse();
    expect(first.consumed).toBe(1n);
    const second = await cursor.next();
    expect(second.rows.map((r) => r.encoded)).toEqual(expected.slice(1));
    expect(second.complete).toBeTrue();
    expect(second.consumed).toBe(2n);
    const exact = await reader.openGroup(
      "holdingsByAccount",
      values,
      256,
      sizes.reduce((a, b) => a + b, 0),
    );
    expect((await exact.next()).rows.map((r) => r.encoded)).toEqual(expected);
    const tooSmall = await reader.openGroup(
      "holdingsByAccount",
      values,
      1,
      workflowValue(sizes[0]) - 1,
    );
    await expect(tooSmall.next()).rejects.toThrow("group_row_too_large");
    await expect(reader.read("state.lotHoldings", 1n)).rejects.toThrow(
      "source_catalog_reader_closed",
    );
  } finally {
    f.db.close();
  }
});

test("pinned group cursors snapshot raw keys and serialize interleaved advancement", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    const scenario = lotIdentityWorkflow();
    await f.ledger.provision(scenario.initial);
    for (const command of scenario.commands.slice(0, 3)) await f.ledger.execute(command);
    const snapshot = await f.ledger.read();
    const reader = await f.storage.openCurrentRowReader();
    const values: string[] = [workflowValue(snapshot.aggregate.state.lotHoldings[0]).accountId];
    const opening = reader.openGroup("holdingsByAccount", values, 1);
    values[0] = "absent";
    const cursor = await opening;
    const absent = await reader.openGroup("holdingsByLot", ["absent"]);
    const [one, empty, two] = await Promise.all([cursor.next(), absent.next(), cursor.next()]);
    expect(one.rows.map((r) => r.ordinal)).toEqual([1n]);
    expect(one.complete).toBeFalse();
    expect(empty.rows).toEqual([]);
    expect(empty.complete).toBeTrue();
    expect(empty.population).toBe(0n);
    expect(two.rows.map((r) => r.ordinal)).toEqual([2n]);
    expect(two.complete).toBeTrue();
    expect(two.consumed).toBe(2n);
    await expect(cursor.next()).rejects.toThrow("group_cursor_closed");
    await expect(reader.openGroup("holdingsByLot", ["absent"])).rejects.toThrow(
      "source_catalog_reader_closed",
    );
    await reader.close();
  } finally {
    f.db.close();
  }
});

test("pinned groups retire the whole context on damaged evidence or lost authority between pages", async () => {
  for (const failure of [
    "source",
    "member",
    "descriptor",
    "catalog",
    "expiry",
    "fence",
    "pending",
    "publication",
    "close",
  ]) {
    const f = fixture(":memory:", BOOK, true);
    try {
      const scenario = lotIdentityWorkflow();
      await f.ledger.provision(scenario.initial);
      for (const command of scenario.commands.slice(0, 3)) await f.ledger.execute(command);
      const snapshot = await f.ledger.read();
      const account = workflowValue(snapshot.aggregate.state.lotHoldings[0]).accountId;
      const reader = await f.storage.openCurrentRowReader();
      const cursor = await reader.openGroup("holdingsByAccount", [account], 1);
      expect((await cursor.next()).complete).toBeFalse();
      if (failure === "source") f.db.query("DELETE FROM ledger_chunks WHERE record_id = '3'").run();
      if (failure === "member" || failure === "descriptor") {
        const descriptors = f.db
          .query("SELECT digest, body FROM ledger_group_descriptors")
          .all() as { digest: string; body: string }[];
        const descriptor = workflowValue(
          descriptors.find((d) => {
            const value = JSON.parse(d.body);
            return (
              value.key.kind === "holdingsByAccount" &&
              value.key.values[0] === account &&
              value.population === "2"
            );
          }),
        );
        if (failure === "descriptor")
          f.db
            .query("DELETE FROM ledger_group_descriptors WHERE digest = ?")
            .run(descriptor.digest);
        else
          f.db
            .query("DELETE FROM ledger_group_nodes WHERE digest = ?")
            .run(JSON.parse(JSON.parse(descriptor.body).memberRoot).tree.digest);
      }
      if (failure === "catalog") f.db.query("UPDATE ledger_group_catalog SET body = '{}' ").run();
      if (failure === "expiry") f.faults.now += 101n;
      if (failure === "fence") f.faults.fence = "1";
      if (failure === "pending") f.faults.pending = true;
      if (failure === "publication") await f.open().ledger.execute(posting("group-interleave", 3n));
      if (failure === "close") await reader.close();
      await expect(cursor.next()).rejects.toThrow();
      await expect(reader.read("state.lotHoldings", 1n)).rejects.toThrow(
        "source_catalog_reader_closed",
      );
      expect(f.db.query("SELECT COUNT(*) AS n FROM ledger_outcomes").get()).toEqual({
        n: failure === "publication" ? 4 : 3,
      });
    } finally {
      f.db.close();
    }
  }
});

test("pinned groups never turn missing absence paths or page sentinels into successful results", async () => {
  for (const failure of ["absence-path", "sentinel"]) {
    const f = fixture(":memory:", BOOK, true);
    try {
      const scenario = lotIdentityWorkflow();
      await f.ledger.provision(scenario.initial);
      for (const command of scenario.commands.slice(0, 3)) await f.ledger.execute(command);
      const snapshot = await f.ledger.read();
      const account = workflowValue(snapshot.aggregate.state.lotHoldings[0]).accountId;
      const reader = await f.storage.openCurrentRowReader();
      const cursor = await reader.openGroup(
        "holdingsByAccount",
        [failure === "sentinel" ? account : "absent"],
        1,
      );
      if (failure === "absence-path") {
        const metadata = f.db.query("SELECT body FROM ledger_group_catalog").get() as {
          body: string;
        };
        f.db
          .query("DELETE FROM ledger_group_nodes WHERE digest = ?")
          .run(JSON.parse(JSON.parse(metadata.body).root).tree.digest);
      } else {
        const descriptors = f.db.query("SELECT body FROM ledger_group_descriptors").all() as {
          body: string;
        }[];
        const descriptor = workflowValue(
          descriptors
            .map((d) => JSON.parse(d.body))
            .find(
              (d) =>
                d.key.kind === "holdingsByAccount" &&
                d.key.values[0] === account &&
                d.population === "2",
            ),
        );
        const node = f.db
          .query("SELECT body FROM ledger_group_nodes WHERE digest = ?")
          .get(JSON.parse(descriptor.memberRoot).tree.digest) as { body: string };
        const branch = JSON.parse(node.body);
        expect(branch.kind).toBe("branch");
        // The first requested member remains intact. The required second member
        // proves this first one-member page is truncated, not a final page.
        expect(branch.right.min).toBe("2".padStart(64, "0"));
        f.db.query("DELETE FROM ledger_group_nodes WHERE digest = ?").run(branch.right.digest);
      }
      await expect(cursor.next()).rejects.toThrow();
      await expect(reader.read("state.lotHoldings", 1n)).rejects.toThrow(
        "source_catalog_reader_closed",
      );
      expect(f.db.query("SELECT COUNT(*) AS n FROM ledger_outcomes").get()).toEqual({ n: 3 });
    } finally {
      f.db.close();
    }
  }
});

test("pinned groups recheck authority during group paths and canonical source reads", async () => {
  for (const boundary of ["FROM ledger_group_nodes", "FROM ledger_chunks"]) {
    const f = fixture(":memory:", BOOK, true);
    try {
      const scenario = lotIdentityWorkflow();
      await f.ledger.provision(scenario.initial);
      for (const command of scenario.commands.slice(0, 3)) await f.ledger.execute(command);
      await f.ledger.read();
      const reader = await f.storage.openCurrentRowReader();
      const cursor = await reader.openGroup("holdingsByLot", ["lot-first"], 1);
      const exec = f.port.sql.exec.bind(f.port.sql);
      let fired = 0;
      f.port.sql.exec = (sql, ...bindings) => {
        const rows = exec(sql, ...bindings);
        if (fired === 0 && sql.includes(boundary)) {
          fired++;
          f.faults.now += 101n;
        }
        return rows;
      };
      await expect(cursor.next()).rejects.toThrow();
      expect(fired).toBe(1);
      await expect(reader.read("state.lotHoldings", 1n)).rejects.toThrow(
        "source_catalog_reader_closed",
      );
    } finally {
      f.db.close();
    }
  }
});

test("pinned group pages use targeted source fetches independent of unrelated history growth", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    const scenario = lotIdentityWorkflow();
    await f.ledger.provision(scenario.initial);
    for (const command of scenario.commands.slice(0, 3)) await f.ledger.execute(command);
    const exec = f.port.sql.exec.bind(f.port.sql);
    const calls: { sql: string; bindings: unknown[] }[] = [];
    let recording = false;
    f.port.sql.exec = (sql, ...bindings) => {
      if (recording) calls.push({ sql, bindings });
      return exec(sql, ...bindings);
    };
    for (const size of [3, 18]) {
      if (size === 18)
        for (let i = 3; i < 18; i++)
          await f.ledger.execute(posting(`group-growth-${i}`, BigInt(i)));
      const snapshot = await f.ledger.read();
      const reader = await f.storage.openCurrentRowReader();
      const cursor = await reader.openGroup(
        "holdingsByAccount",
        [workflowValue(snapshot.aggregate.state.lotHoldings[0]).accountId],
        1,
      );
      calls.length = 0;
      recording = true;
      const page = await cursor.next();
      recording = false;
      expect(page.rows.map((r) => r.ordinal)).toEqual([1n]);
      expect(page.complete).toBeFalse();
      const reads = calls.filter((c) => c.sql.includes("FROM ledger_outcomes"));
      expect(reads.length).toBe(1);
      expect(reads.map((r) => r.bindings[0])).toEqual(["2"]);
      expect(reads.every((r) => r.sql.includes("WHERE sequence = ? LIMIT 2"))).toBeTrue();
      expect(calls.filter((c) => c.sql.includes("FROM ledger_chunks")).length).toBe(1);
      expect(
        calls
          .filter((c) => c.sql.includes("FROM ledger_group_nodes"))
          .every((c) => c.sql.includes("WHERE digest = ?")),
      ).toBeTrue();
      await reader.close();
    }
  } finally {
    f.db.close();
  }
});

test("pinned groups reject malformed keys and limits and close abandoned cursors", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    await f.ledger.provision(genesis());
    await f.ledger.read();
    const cases: [SemanticGroupKind, string[], number, number][] = [
      ["holdingsByLot", [], 1, 1024],
      ["holdingsByLot", ["x", "y"], 1, 1024],
      ["__proto__" as SemanticGroupKind, ["x"], 1, 1024],
      ["holdingsByLot", ["x\n"], 1, 1024],
      ["holdingsByLot", ["x"], 0, 1024],
      ["holdingsByLot", ["x"], 257, 1024],
      ["holdingsByLot", ["x"], 1.5, 1024],
      ["holdingsByLot", ["x"], Number.NaN, 1024],
      ["holdingsByLot", ["x"], 1, 0],
      ["holdingsByLot", ["x"], 1, 1_048_577],
      ["holdingsByLot", ["x"], 1, Number.POSITIVE_INFINITY],
      ["holdingsByLot", ["€".repeat(400_000)], 1, 1024],
    ];
    for (const args of cases) {
      const reader = await f.storage.openCurrentRowReader();
      await expect(reader.openGroup(...args)).rejects.toThrow();
      await expect(reader.read("state.lotHoldings", 1n)).rejects.toThrow(
        "source_catalog_reader_closed",
      );
      await reader.close();
    }
    const reader = await f.storage.openCurrentRowReader();
    const cursor = await reader.openGroup("holdingsByLot", ["x"]);
    await cursor.close();
    await cursor.close();
    await expect(cursor.next()).rejects.toThrow("group_cursor_closed");
    expect(f.db.query("SELECT COUNT(*) AS n FROM ledger_outcomes").get()).toEqual({ n: 0 });
  } finally {
    f.db.close();
  }
});

test("pinned group source boundary rejects wrong commitments, coordinates, schemas and raw predicates", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    const scenario = lotIdentityWorkflow();
    await f.ledger.provision(scenario.initial);
    for (const command of scenario.commands.slice(0, 2)) await f.ledger.execute(command);
    const snapshot = await f.ledger.read();
    const reader = await f.storage.openCurrentRowReader();
    const raw = await reader.read("state.lotHoldings", 1n);
    const metadata = f.db.query("SELECT body, digest FROM ledger_group_catalog").get() as {
      body: string;
      digest: string;
    };
    const source = f.db.query("SELECT body FROM ledger_source_catalog").get() as { body: string };
    const collectionDomain = JSON.parse(source.body).collections.find(
      (c: { name: string }) => c.name === "state.lotHoldings",
    ).domain;
    const catalog = new SqliteSemanticGroupCatalog(
      f.port,
      indexBookIdentityCommitment(f.scope),
      () => ({ identityHash: indexBookIdentityCommitment(f.scope), headHash: raw.headHash }),
    );
    const capture = catalog.capture(raw.headHash, metadata.digest);
    const holding = workflowValue(snapshot.aggregate.state.lotHoldings[0]);
    // Fault injection at the trusted source-port boundary, after real membership
    // proof. These guards supplement (not replace) the real row-hash verifier.
    for (const fault of [
      "hash",
      "ordinal",
      "collection",
      "head",
      "catalog",
      "absent",
      "schema",
      "predicate",
    ]) {
      const candidate = { ...raw };
      if (fault === "hash") candidate.rowHash = "0".repeat(64);
      if (fault === "ordinal") candidate.ordinal = 2n;
      if (fault === "collection") candidate.collection = "state.lots";
      if (fault === "head") candidate.headHash = "0".repeat(64);
      if (fault === "catalog") candidate.catalogDigest = "0".repeat(64);
      if (fault === "absent") {
        candidate.disposition = "absent";
        candidate.encoded = null;
      }
      if (fault === "schema") candidate.encoded = "{}";
      if (fault === "predicate")
        candidate.encoded = encodeBookRow("state.lotHoldings", {
          ...holding,
          accountId: accountId("foreign-account"),
        });
      const cursor = createPinnedGroupCursor(
        "holdingsByAccount",
        [holding.accountId],
        1,
        1_048_576,
        {
          catalog,
          capture,
          collectionDomain,
          sourceCatalogDigest: raw.catalogDigest,
          headHash: raw.headHash,
          confirm: async () => catalog.assertCurrent(capture),
          rawRow: async () => candidate,
          run: async (operation) => operation(),
        },
      );
      await expect(cursor.next()).rejects.toThrow(
        fault === "predicate" ? "group_member_predicate_mismatch" : "group_member_source_mismatch",
      );
    }
    catalog.release(capture);
    await reader.close();
  } finally {
    f.db.close();
  }
});

test("group publication failures roll back canonical, source, identity and group roots together", async () => {
  for (const point of [
    "INSERT INTO ledger_group_nodes",
    "INSERT INTO ledger_group_descriptors",
    "UPDATE ledger_group_catalog",
  ]) {
    const f = fixture(":memory:", BOOK, true);
    try {
      const scenario = allocationAndTaxWorkflow("1.1.0");
      await f.ledger.provision(scenario.initial);
      for (const command of scenario.commands.slice(0, 3)) await f.ledger.execute(command);
      const before = await f.ledger.read();
      const bytes = () =>
        JSON.stringify(
          [
            "ledger_metadata",
            "ledger_outcomes",
            "ledger_chunks",
            "ledger_source_catalog",
            "ledger_source_nodes",
            "ledger_source_origins",
            "ledger_group_catalog",
            "ledger_group_nodes",
            "ledger_group_descriptors",
            "ledger_index_control",
          ].map((table) => f.db.query(`SELECT * FROM ${table} ORDER BY 1`).all()),
        );
      const original = bytes();
      f.faults.afterSql = point;
      f.faults.onlyPublication = true;
      await expect(f.ledger.execute(workflowValue(scenario.commands[3]))).rejects.toThrow(
        "injected owner SQL failure",
      );
      f.faults.afterSql = "";
      expect(f.faults.publicationFaults).toBe(1);
      expect(bytes()).toBe(original);
      const restored = await f.open().ledger.read();
      expect(encodeDurableBook(restored.aggregate)).toBe(encodeDurableBook(before.aggregate));
      await assertGroupDirectory(f, restored);
    } finally {
      f.db.close();
    }
  }
});

test("group publication rejects digest collisions instead of adopting conflicting stored bytes", async () => {
  for (const table of ["ledger_group_nodes", "ledger_group_descriptors"]) {
    const f = fixture(":memory:", BOOK, true);
    try {
      const scenario = allocationAndTaxWorkflow("1.1.0");
      await f.ledger.provision(scenario.initial);
      for (const command of scenario.commands.slice(0, 3)) await f.ledger.execute(command);
      const before = await f.ledger.read();
      const catalog = f.db.query("SELECT body, digest FROM ledger_group_catalog").get();
      const stored = f.db.query(`SELECT * FROM ${table} ORDER BY digest`).all();
      const exec = f.port.sql.exec.bind(f.port.sql);
      let injected = 0;
      f.port.sql.exec = (sql, ...bindings) => {
        if (injected === 0 && sql.startsWith(`INSERT INTO ${table}`)) {
          injected++;
          exec(
            `INSERT INTO ${table} (digest, body) VALUES (?, ?)`,
            workflowValue(bindings[0]),
            "{}",
          );
        }
        return exec(sql, ...bindings);
      };
      await expect(f.ledger.execute(workflowValue(scenario.commands[3]))).rejects.toThrow(
        "group_content_collision",
      );
      expect(injected).toBe(1);
      expect(f.db.query(`SELECT * FROM ${table} ORDER BY digest`).all()).toEqual(stored);
      expect(f.db.query("SELECT body, digest FROM ledger_group_catalog").get()).toEqual(catalog);
      const reopened = await f.open().ledger.read();
      expect(encodeDurableBook(reopened.aggregate)).toBe(encodeDurableBook(before.aggregate));
      await assertGroupDirectory(f, reopened);
    } finally {
      f.db.close();
    }
  }
});

test("group publication lost acknowledgement retries the original durable result exactly once", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    const scenario = allocationAndTaxWorkflow("1.1.0");
    await f.ledger.provision(scenario.initial);
    for (const command of scenario.commands.slice(0, 3)) await f.ledger.execute(command);
    const command = workflowValue(scenario.commands[3]);
    const before = await f.ledger.read();
    const oracle = executeBookCommand(before.aggregate.state, before.aggregate.protocol, command);
    f.faults.loseAfterSql = "UPDATE ledger_group_catalog";
    await expect(f.ledger.execute(command)).rejects.toThrow("lost owner durability response");
    const retry = await f.open().ledger.execute(command);
    expect(retry.result.disposition).toBe("replayed");
    expect(retry.originalResult).toEqual(oracle.result);
    expect(f.db.query("SELECT COUNT(*) AS n FROM ledger_outcomes").get()).toEqual({ n: 4 });
    await assertGroupDirectory(f, await f.open().ledger.read());
  } finally {
    f.db.close();
  }
});

test("group catalogs fail closed on missing and corrupted directory or member evidence", async () => {
  for (const failure of [
    "metadata",
    "node",
    "descriptor",
    "missing-node",
    "missing-descriptor",
    "missing-member",
    "corrupt-member",
    "utf8-descriptor",
  ]) {
    const f = fixture(":memory:", BOOK, true);
    try {
      const scenario = lotIdentityWorkflow();
      await f.ledger.provision(scenario.initial);
      for (const command of scenario.commands.slice(0, 2)) await f.ledger.execute(command);
      const metadata = JSON.parse(
        (f.db.query("SELECT body FROM ledger_group_catalog").get() as { body: string }).body,
      );
      const rootDigest = JSON.parse(metadata.root).tree.digest;
      const descriptor = f.db
        .query("SELECT digest FROM ledger_group_descriptors LIMIT 1")
        .get() as { digest: string };
      if (failure === "metadata") f.db.query("UPDATE ledger_group_catalog SET body = '{}' ").run();
      if (failure === "node")
        f.db.query("UPDATE ledger_group_nodes SET body = '{}' WHERE digest = ?").run(rootDigest);
      if (failure === "descriptor")
        f.db
          .query("UPDATE ledger_group_descriptors SET body = '{}' WHERE digest = ?")
          .run(descriptor.digest);
      if (failure === "missing-node")
        f.db.query("DELETE FROM ledger_group_nodes WHERE digest = ?").run(rootDigest);
      if (failure === "missing-descriptor")
        f.db.query("DELETE FROM ledger_group_descriptors WHERE digest = ?").run(descriptor.digest);
      if (failure === "utf8-descriptor")
        f.db
          .query("UPDATE ledger_group_descriptors SET body = ? WHERE digest = ?")
          .run("€".repeat(400_000), descriptor.digest);
      if (failure === "missing-member" || failure === "corrupt-member") {
        const data = f.db
          .query("SELECT body FROM ledger_group_descriptors WHERE digest = ?")
          .get(descriptor.digest) as { body: string };
        const memberDigest = JSON.parse(JSON.parse(data.body).memberRoot).tree.digest;
        if (failure === "missing-member")
          f.db.query("DELETE FROM ledger_group_nodes WHERE digest = ?").run(memberDigest);
        else
          f.db
            .query("UPDATE ledger_group_nodes SET body = '{}' WHERE digest = ?")
            .run(memberDigest);
      }
      await expect(f.open().ledger.read()).rejects.toThrow();
      await expect(f.open().ledger.execute(posting("after-group-damage", 2n))).rejects.toThrow();
      expect(f.db.query("SELECT COUNT(*) AS n FROM ledger_outcomes").get()).toEqual({ n: 2 });
    } finally {
      f.db.close();
    }
  }
});

test("group metadata cannot self-authorize a rehashed incomplete directory or foreign anchor", async () => {
  for (const failure of ["empty-population", "head", "identity", "duplicate-field"]) {
    const f = fixture(":memory:", BOOK, true);
    try {
      const scenario = lotIdentityWorkflow();
      await f.ledger.provision(scenario.initial);
      for (const command of scenario.commands.slice(0, 2)) await f.ledger.execute(command);
      const canonical = new SqliteBookStorage(f.scope.objectId, f.port);
      const before = JSON.stringify(canonical.load(f.scope));
      const row = f.db.query("SELECT body FROM ledger_group_catalog").get() as { body: string };
      const metadata = JSON.parse(row.body);
      if (failure === "empty-population") {
        metadata.root = emptyLogicalMap(metadata.domain);
        metadata.rootHash = logicalMapHash(metadata.root, metadata.domain);
        metadata.population = "0";
      }
      if (failure === "head") metadata.headHash = "0".repeat(64);
      if (failure === "identity") metadata.identityHash = "0".repeat(64);
      const body =
        failure === "duplicate-field"
          ? row.body.replace("{", `{"format":${JSON.stringify(metadata.format)},`)
          : JSON.stringify(metadata);
      const digest = hashCanonical({ profile: GROUP_CATALOG_FORMAT, kind: "catalog", body }).digest;
      f.db.query("UPDATE ledger_group_catalog SET body = ?, digest = ?").run(body, digest);
      await expect(f.open().ledger.read()).rejects.toThrow(
        failure === "empty-population"
          ? "group_catalog_projection_mismatch"
          : failure === "head"
            ? "group_catalog_head_mismatch"
            : "group_catalog_corrupt",
      );
      await expect(
        f.open().ledger.execute(posting("after-rehashed-group-damage", 2n)),
      ).rejects.toThrow();
      expect(JSON.stringify(canonical.load(f.scope))).toBe(before);
    } finally {
      f.db.close();
    }
  }
});

test("group metadata advances without rewriting members for unrelated outcomes", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    const scenario = lotIdentityWorkflow();
    await f.ledger.provision(scenario.initial);
    for (const command of scenario.commands.slice(0, 2)) await f.ledger.execute(command);
    const before = await assertGroupDirectory(f, await f.ledger.read());
    const writes: string[] = [];
    const exec = f.port.sql.exec.bind(f.port.sql);
    f.port.sql.exec = (sql, ...bindings) => {
      if (/^(INSERT INTO|UPDATE|DELETE FROM) ledger_group_/.test(sql)) writes.push(sql);
      return exec(sql, ...bindings);
    };
    const committed = posting("unrelated-group-journal", 2n);
    expect((await f.ledger.execute(committed)).result.disposition).toBe("committed");
    expect(
      (await f.ledger.execute(posting("unrelated-group-rejection", 0n))).result.disposition,
    ).toBe("rejected");
    const after = await assertGroupDirectory(f, await f.open().ledger.read());
    expect(after.root).toBe(before.root);
    expect(after.population).toBe(before.population);
    expect(after.headHash).not.toBe(before.headHash);
    expect(writes.length).toBe(2);
    expect(writes.every((sql) => sql.startsWith("UPDATE ledger_group_catalog"))).toBeTrue();
    expect((await f.ledger.execute(committed)).result.disposition).toBe("replayed");
    expect(writes.length).toBe(2);
  } finally {
    f.db.close();
  }
});

test("group owners reject old row-only markers and failed initial group publication leaves no ledger", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    f.faults.afterSql = "INSERT INTO ledger_group_catalog";
    await expect(f.ledger.provision(genesis())).rejects.toThrow("injected owner SQL failure");
    expect(f.db.query("SELECT name FROM sqlite_master WHERE name LIKE 'ledger_%'").all()).toEqual(
      [],
    );
    f.faults.afterSql = "";
    await f.ledger.provision(genesis());
    for (const format of [
      "rastrata-indexed-sqlite-row-source-candidate-v1",
      "rastrata-indexed-sqlite-group-source-candidate-v1",
    ]) {
      f.db.query("UPDATE ledger_indexed_owner SET format = ?").run(format);
      await expect(f.open().ledger.read()).rejects.toThrow("indexed_owner_mismatch");
      await expect(f.open().ledger.provision(genesis())).rejects.toThrow("indexed_owner_mismatch");
    }
    expect(f.db.query("SELECT COUNT(*) AS n FROM ledger_outcomes").get()).toEqual({ n: 0 });
  } finally {
    f.db.close();
  }
});

test("group publication requires a live same-store transaction and opaque prepared candidate", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    const catalog = new SqliteSemanticGroupCatalog(
      f.port,
      indexBookIdentityCommitment(f.scope),
      () => ({ identityHash: indexBookIdentityCommitment(f.scope), headHash: "0".repeat(64) }),
    );
    expect(() =>
      catalog.publishInTransaction({} as SqliteTransaction, { digest: "0".repeat(64) }),
    ).toThrow("sqlite_transaction_not_active");
    expect(() =>
      atomicSqlite(f.port, (tx) => catalog.publishInTransaction(tx, { digest: "0".repeat(64) })),
    ).toThrow("group_catalog_unprepared");
    const other = fixture();
    try {
      expect(() =>
        atomicSqlite(other.port, (tx) =>
          catalog.publishInTransaction(tx, { digest: "0".repeat(64) }),
        ),
      ).toThrow("sqlite_transaction_not_active");
    } finally {
      other.db.close();
    }
    let retired: SqliteTransaction | undefined;
    atomicSqlite(f.port, (tx) => {
      retired = tx;
    });
    expect(() =>
      catalog.publishInTransaction(workflowValue(retired), { digest: "0".repeat(64) }),
    ).toThrow("sqlite_transaction_not_active");
    expect(f.db.query("SELECT name FROM sqlite_master WHERE name LIKE 'ledger_%'").all()).toEqual(
      [],
    );
  } finally {
    f.db.close();
  }
});

test("opt-in source catalog publishes complete projection and locators with each retained outcome", async () => {
  const scenario = allocationAndTaxWorkflow("1.1.0");
  const f = fixture(":memory:", BOOK, true);
  try {
    await f.ledger.provision(scenario.initial);
    for (const command of [...scenario.commands, posting("catalog-stale", 0n)]) {
      const receipt = await f.ledger.execute(command);
      expect(receipt.outcomeSequence).not.toBeNull();
      const reopened = await f.open().ledger.read();
      const projection = await projectLegacyLogicalBook(encodeDurableBook(reopened.aggregate));
      const row = f.db.query("SELECT body FROM ledger_source_catalog").get() as { body: string };
      const catalog = JSON.parse(row.body);
      expect(catalog.headHash).toBe(
        ledgerIndexHeadCommitment(reopened.head, COMPACT_LEDGER_FORMAT),
      );
      expect(catalog.stateRoot).toBe(projection.stateRoot);
      expect(catalog.protocolRoot).toBe(projection.protocolRoot);
      expect(catalog.collections.length).toBe(24);
      for (const c of projection.collections) {
        const actual = catalog.collections.find((x: { name: string }) => x.name === c.name);
        expect(actual?.rootHash).toBe(c.rootHash);
        expect(actual?.population).toBe(String(c.rows.length));
      }
    }
    const last = posting("catalog-stale", 0n);
    expect((await f.open().ledger.execute(last)).result.disposition).toBe("replayed");
    expect(f.faults.maxDepth).toBe(1);
  } finally {
    f.db.close();
  }
});

test("source catalog writes roll back with canonical publication at every new SQL boundary", async () => {
  for (const point of [
    "INSERT INTO ledger_source_nodes",
    "INSERT INTO ledger_source_origins",
    "UPDATE ledger_source_catalog",
  ]) {
    const f = fixture(":memory:", BOOK, true);
    try {
      await f.ledger.provision(genesis());
      await f.ledger.execute(activation());
      const before = await f.ledger.read();
      const snapshot = () =>
        JSON.stringify(
          ["ledger_source_catalog", "ledger_source_nodes", "ledger_source_origins"].map((table) =>
            f.db.query(`SELECT body, digest FROM ${table} ORDER BY digest`).all(),
          ),
        );
      const bytes = snapshot();
      f.faults.afterSql = point;
      f.faults.onlyPublication = true;
      await expect(f.ledger.execute(posting("catalog-rollback"))).rejects.toThrow(
        "injected owner SQL failure",
      );
      f.faults.afterSql = "";
      expect(f.faults.publicationFaults).toBe(1);
      expect(snapshot()).toBe(bytes);
      expect(encodeDurableBook((await f.open().ledger.read()).aggregate)).toBe(
        encodeDurableBook(before.aggregate),
      );
      expect((await f.open().ledger.execute(posting("catalog-rollback"))).result.disposition).toBe(
        "committed",
      );
    } finally {
      f.db.close();
    }
  }
});

test("lost catalog publication acknowledgement yields no receipt but retry recovers the original outcome", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    const command = posting("catalog-uncertain");
    const before = await f.ledger.read();
    const expected = executeBookCommand(before.aggregate.state, before.aggregate.protocol, command);
    f.faults.loseAfterSql = "UPDATE ledger_source_catalog";
    await expect(f.ledger.execute(command)).rejects.toThrow("lost owner durability response");
    const retry = await f.open().ledger.execute(command);
    expect(retry.result.disposition).toBe("replayed");
    expect(retry.outcomeSequence).toBe(2n);
    expect(retry.originalResult).toEqual(expected.result);
  } finally {
    f.db.close();
  }
});

test("source catalogs reject old owner profiles instead of silently adopting existing books", async () => {
  for (const enabled of [false, true]) {
    const f = fixture(":memory:", BOOK, enabled);
    try {
      await f.ledger.provision(genesis());
      const incompatible = new SqliteIndexedBookStorage(
        f.scope.objectId,
        f.port,
        f.scope,
        () => ({ fence: "0", pending: false }),
        () => 10n,
        100n,
        { sourceCatalog: !enabled },
      );
      const ledger = new ProductionLedger(incompatible, f.scope, COMPACT_LEDGER_FORMAT);
      await expect(ledger.read()).rejects.toThrow("indexed_owner_mismatch");
      await expect(ledger.provision(genesis())).rejects.toThrow("indexed_owner_mismatch");
      expect((await f.open().ledger.read()).head.sequence).toBe("0");
    } finally {
      f.db.close();
    }
  }
});

test("pinned current-row reader resolves exact source rows and proven absence in every collection", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    const scenario = allocationAndTaxWorkflow("1.1.0");
    await f.ledger.provision(scenario.initial);
    for (const command of scenario.commands) await f.ledger.execute(command);
    await f.ledger.execute(posting("row-reader-reject", 0n));
    await expect(f.storage.openCurrentRowReader()).rejects.toThrow("indexed_recovery_required");
    const snapshot = await f.ledger.read();
    const projection = await projectLegacyLogicalBook(encodeDurableBook(snapshot.aggregate));
    const reader = await f.storage.openCurrentRowReader();
    expect(reader.head).toEqual(snapshot.head);
    expect(Object.isFrozen(reader.head)).toBe(true);
    for (const c of projection.collections) {
      for (const row of c.rows) {
        const found = await reader.read(c.name, row.ordinal);
        expect(found.disposition).toBe("present");
        expect(found.encoded).toBe(row.encoded);
        expect(found.rowHash).toBe(row.contentHash);
        expect(found.headHash).toBe(
          ledgerIndexHeadCommitment(snapshot.head, COMPACT_LEDGER_FORMAT),
        );
        expect(Object.isFrozen(found)).toBe(true);
      }
      const absent = await reader.read(c.name, BigInt(c.rows.length) + 1n);
      expect(absent.disposition).toBe("absent");
      expect(absent.encoded).toBeNull();
      expect(absent.rowHash).toBeNull();
    }
    await reader.close();
    await reader.close();
    await expect(reader.read("protocol.retainedResults", 1n)).rejects.toThrow(
      "source_catalog_reader_closed",
    );
    expect(f.db.query("SELECT COUNT(*) AS n FROM ledger_index_pins").get()).toEqual({ n: 0 });
  } finally {
    f.db.close();
  }
});

test("typed pinned rows match every source collection and retain kernel numeric classes", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    const scenario = allocationAndTaxWorkflow("1.1.0");
    await f.ledger.provision(scenario.initial);
    for (const command of scenario.commands) await f.ledger.execute(command);
    const snapshot = await f.ledger.read();
    const projection = await projectLegacyLogicalBook(encodeDurableBook(snapshot.aggregate));
    expect(projection.collections.map((c) => c.name).sort()).toEqual(
      [...BOOK_ROW_COLLECTIONS].sort(),
    );
    const reader = await f.storage.openCurrentRowReader();
    for (const collection of BOOK_ROW_COLLECTIONS) {
      const expected = workflowValue(projection.collections.find((c) => c.name === collection));
      for (const row of expected.rows) {
        const result = await reader.readTyped(collection, row.ordinal);
        expect(result.disposition).toBe("present");
        if (result.disposition !== "present") throw new Error("Missing typed row");
        expect(encodeBookRow(collection, result.row)).toBe(row.encoded);
        expect(result.rowHash).toBe(row.contentHash);
        expect(Object.isFrozen(result.row)).toBe(true);
      }
      const absent = await reader.readTyped(collection, BigInt(expected.rows.length) + 1n);
      expect(absent.disposition).toBe("absent");
      expect(absent.row).toBeNull();
    }
    const journal = await reader.readTyped("state.journals", 1n);
    if (journal.disposition !== "present") throw new Error("Missing journal");
    expect(journal.row.journal.postings[0]?.bookValue.amount).toBeInstanceOf(ExactDecimal);
    const schedule = await reader.readTyped("state.accountingState.allocationSchedules", 1n);
    if (schedule.disposition !== "present") throw new Error("Missing schedule");
    expect(schedule.row.sourceBasis).toBeInstanceOf(ExactRational);
    await reader.close();
    await expect(reader.readTyped("state.journals", 1n)).rejects.toThrow(
      "source_catalog_reader_closed",
    );
  } finally {
    f.db.close();
  }
});

test("command-ID lookup returns original committed and rejected rows and proves fresh IDs absent", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    const scenario = allocationAndTaxWorkflow("1.1.0");
    await f.ledger.provision(scenario.initial);
    const empty = await f.storage.openCurrentRowReader();
    expect((await empty.readCommand("activate")).disposition).toBe("absent");
    await empty.close();
    for (const command of scenario.commands) await f.ledger.execute(command);
    await f.ledger.execute(posting("command-lookup-rejection/α", 0n));
    // Exercise both a current owner and a reopened owner after full recovery.
    for (const owner of [f, f.open()]) {
      const snapshot = await owner.ledger.read();
      const reader = await owner.storage.openCurrentRowReader();
      const retained = snapshot.aggregate.protocol.retainedResults;
      expect(retained.at(-1)?.outcome).toBe("rejected");
      for (let i = retained.length - 1; i >= 0; i--) {
        const expected = workflowValue(retained[i]);
        const found = await reader.readCommand(expected.commandId);
        expect(found.disposition).toBe("present");
        expect(found.ordinal).toBe(BigInt(i) + 1n);
        expect(found.row).toEqual(expected);
        expect(found.encoded).toBe(encodeBookRow("protocol.retainedResults", expected));
        expect(found.commandId).toBe(expected.commandId);
        expect(found.headHash).toBe(
          ledgerIndexHeadCommitment(snapshot.head, COMPACT_LEDGER_FORMAT),
        );
        expect(Object.isFrozen(found)).toBe(true);
        expect(Object.isFrozen(found.row)).toBe(true);
        const ordinalRow = await reader.readTyped("protocol.retainedResults", BigInt(i) + 1n);
        expect(found.rowHash).toBe(ordinalRow.rowHash);
        expect(found.catalogDigest).toBe(ordinalRow.catalogDigest);
      }
      // An existing identity in another family must not reserve a command ID.
      const boundaryId = workflowValue(snapshot.aggregate.state.openingBoundary).id;
      expect(retained.some((r) => String(r.commandId) === String(boundaryId))).toBe(false);
      for (const id of [boundaryId, "absent/α", "__proto__", "constructor"]) {
        const absent = await reader.readCommand(id);
        expect(absent).toMatchObject({
          commandId: id,
          disposition: "absent",
          ordinal: null,
          encoded: null,
          row: null,
          rowHash: null,
        });
        expect(Object.isFrozen(absent)).toBe(true);
      }
      await reader.close();
      await expect(reader.readCommand("absent/α")).rejects.toThrow("source_catalog_reader_closed");
    }
  } finally {
    f.db.close();
  }
});

test("command-ID reads fetch one authenticated source and no history scan as retained history grows", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    const exec = f.port.sql.exec.bind(f.port.sql);
    const calls: { sql: string; bindings: unknown[]; count: number }[] = [];
    let recording = false;
    f.port.sql.exec = (sql, ...bindings) => {
      const rows = exec(sql, ...bindings) as Record<string, unknown>[];
      if (recording) calls.push({ sql, bindings, count: rows.length });
      return rows;
    };
    let original = "";
    for (const count of [1, 65]) {
      if (count === 65)
        for (let i = 1; i <= 64; i++)
          await f.ledger.execute(posting(`semantic-path-${i}`, BigInt(i)));
      await f.ledger.read();
      const reader = await f.storage.openCurrentRowReader();
      for (const id of ["activate", "unused-command"]) {
        calls.length = 0;
        recording = true;
        const result = await reader.readCommand(id);
        recording = false;
        const outcomes = calls.filter((c) => c.sql.includes("FROM ledger_outcomes"));
        const chunks = calls.filter((c) => c.sql.includes("FROM ledger_chunks"));
        const pages = calls.filter((c) => c.sql.includes("FROM ledger_index_pages"));
        expect(pages.length).toBeGreaterThanOrEqual(1);
        expect(pages.length).toBeLessThanOrEqual(count === 1 ? 1 : 2);
        if (count === 65 && id === "activate") expect(pages.length).toBe(2);
        expect(pages.every((c) => c.sql.includes("WHERE location = ?") && c.count === 1)).toBe(
          true,
        );
        if (id === "activate") {
          expect(result.disposition).toBe("present");
          expect(outcomes.length).toBe(1);
          expect(outcomes[0]?.sql).toContain("WHERE sequence = ? LIMIT 2");
          expect(outcomes[0]?.count).toBe(1);
          expect(chunks.length).toBe(1);
          expect(chunks[0]?.bindings[0]).toBe("1");
          if (count === 1) original = result.encoded ?? "";
          else expect(result.encoded).toBe(original);
        } else {
          expect(result.disposition).toBe("absent");
          expect(outcomes).toEqual([]);
          expect(chunks).toEqual([]);
        }
      }
      await reader.close();
    }
  } finally {
    f.db.close();
  }
});

test("command-ID lookup never turns missing identity pages or source bytes into absence", async () => {
  for (const failure of ["page-hit", "page-miss", "source", "locator"]) {
    const f = fixture(":memory:", BOOK, true);
    try {
      await f.ledger.provision(genesis());
      await f.ledger.execute(activation());
      await f.ledger.read();
      const reader = await f.storage.openCurrentRowReader();
      const exec = f.port.sql.exec.bind(f.port.sql);
      let injected = false;
      f.port.sql.exec = (sql, ...bindings) => {
        const rows = exec(sql, ...bindings);
        if (failure.startsWith("page") && sql.includes("FROM ledger_index_pages")) {
          injected = true;
          return [];
        }
        if (failure === "source" && sql.includes("FROM ledger_chunks")) {
          injected = true;
          return [];
        }
        if (failure === "locator" && sql.includes("FROM ledger_source_origins")) {
          injected = true;
          return [];
        }
        return rows;
      };
      await expect(
        reader.readCommand(failure === "page-miss" ? "unused-command" : "activate"),
      ).rejects.toThrow();
      expect(injected).toBe(true);
      await expect(reader.readCommand("activate")).rejects.toThrow("source_catalog_reader_closed");
      expect(f.db.query("SELECT COUNT(*) AS n FROM ledger_outcomes").get()).toEqual({ n: 1 });
    } finally {
      f.db.close();
    }
  }
});

test("command-ID reads cover cold and hot partitions and require cold absence evidence", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    await f.ledger.execute(posting("cold-command"));
    const current = await f.control.readMetadata();
    const frozen = await f.control.freeze(current.view, "command-read-cold-prefix");
    if (!frozen.frozen) throw new Error("Missing frozen prefix");
    await f.control.install(
      frozen.view,
      frozen.frozen,
      current.view.hotRoot,
      createIndexRoot(0n, null).contentHash,
      "0",
    );
    await f.ledger.execute(posting("hot-rejection", 0n));
    const snapshot = await f.ledger.read();
    const reader = await f.storage.openCurrentRowReader();
    for (const [i, expected] of snapshot.aggregate.protocol.retainedResults.entries()) {
      const found = await reader.readCommand(expected.commandId);
      expect(found.ordinal).toBe(BigInt(i) + 1n);
      expect(found.row).toEqual(expected);
    }
    expect((await reader.readCommand("unused-command")).disposition).toBe("absent");
    await reader.close();
    const view = (await f.control.readMetadata()).view;
    expect(view.coldThrough).toBe("2");
    expect(view.hotCount).toBe("1");
    const root = await f.pages.readRootDescriptor(view.coldRoot);
    const location = workflowValue(root?.page?.location);
    const exec = f.port.sql.exec.bind(f.port.sql);
    for (const id of ["hot-rejection", "unused-command"]) {
      const pinned = await f.storage.openCurrentRowReader();
      let injected = false;
      f.port.sql.exec = (sql, ...bindings) => {
        const rows = exec(sql, ...bindings);
        if (sql.includes("FROM ledger_index_pages") && bindings[0] === location) {
          injected = true;
          return [];
        }
        return rows;
      };
      await expect(pinned.readCommand(id)).rejects.toThrow();
      expect(injected).toBe(true);
      await expect(pinned.readCommand(id)).rejects.toThrow("source_catalog_reader_closed");
      f.port.sql.exec = exec;
    }
  } finally {
    f.db.close();
  }
});

test("command-ID reads recheck authority during positive and negative identity paths", async () => {
  for (const failure of ["expiry", "fence", "maintenance", "uncertain"]) {
    for (const id of ["activate", "unused-command"]) {
      const f = fixture(":memory:", BOOK, true);
      try {
        await f.ledger.provision(genesis());
        await f.ledger.execute(activation());
        await f.ledger.read();
        const reader = await f.storage.openCurrentRowReader();
        const exec = f.port.sql.exec.bind(f.port.sql);
        let injected = false;
        f.port.sql.exec = (sql, ...bindings) => {
          const rows = exec(sql, ...bindings);
          if (!injected && sql.includes("FROM ledger_index_pages")) {
            injected = true;
            if (failure === "expiry") f.faults.now = 110n;
            if (failure === "fence") f.faults.fence = "1";
            if (failure === "maintenance") f.faults.pending = true;
            if (failure === "uncertain") f.faults.syncFailures++;
          }
          return rows;
        };
        await expect(reader.readCommand(id)).rejects.toThrow();
        expect(injected).toBe(true);
        await expect(reader.readCommand(id)).rejects.toThrow("source_catalog_reader_closed");
      } finally {
        f.db.close();
      }
    }
  }
});

test("command-ID reads reject stale heads and serialize close with queued requests", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    await f.ledger.read();
    const stale = await f.storage.openCurrentRowReader();
    await f.open().ledger.execute(posting("new-head-command"));
    await expect(stale.readCommand("new-head-command")).rejects.toThrow();
    await expect(stale.readCommand("activate")).rejects.toThrow("source_catalog_reader_closed");
    await f.ledger.read();
    const reader = await f.storage.openCurrentRowReader();
    const first = reader.readCommand("new-head-command");
    const close = reader.close();
    const denied = reader.readCommand("activate");
    const results = await Promise.allSettled([first, close, denied]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
    expect((await first).disposition).toBe("present");
    expect(f.db.query("SELECT COUNT(*) AS n FROM ledger_index_pins").get()).toEqual({ n: 0 });
    for (const id of ["", " leading", "trailing ", "e\u0301", "bad\n", "€".repeat(349_526), null]) {
      const invalid = await f.storage.openCurrentRowReader();
      await expect(invalid.readCommand(id as string)).rejects.toThrow();
      await expect(invalid.readCommand("activate")).rejects.toThrow("source_catalog_reader_closed");
    }
  } finally {
    f.db.close();
  }
});

test("publication during command identity traversal invalidates positive and negative reads", async () => {
  for (const id of ["activate", "published-during-lookup"]) {
    const f = fixture(":memory:", BOOK, true);
    let resume: () => void = () => undefined;
    try {
      await f.ledger.provision(genesis());
      await f.ledger.execute(activation());
      await f.ledger.read();
      const reader = await f.storage.openCurrentRowReader();
      const reached = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      resume = () => gate.resolve();
      const exec = f.port.sql.exec.bind(f.port.sql);
      const sync = f.port.sync.bind(f.port);
      let arm = false;
      let injected = false;
      f.port.sql.exec = (sql, ...bindings) => {
        const rows = exec(sql, ...bindings);
        if (!injected && sql.includes("FROM ledger_index_pages")) {
          injected = true;
          arm = true;
        }
        return rows;
      };
      f.port.sync = async () => {
        if (arm) {
          arm = false;
          reached.resolve();
          await gate.promise;
        }
        await sync();
      };
      // Attach a rejection observer immediately, before releasing the read.
      const reading = Promise.allSettled([reader.readCommand(id)]);
      await reached.promise;
      const committed = await f.open().ledger.execute(posting("published-during-lookup"));
      expect(committed.result.disposition).toBe("committed");
      resume();
      expect((await reading)[0]?.status).toBe("rejected");
      expect(injected).toBe(true);
      await expect(reader.readCommand(id)).rejects.toThrow("source_catalog_reader_closed");
    } finally {
      resume();
      f.db.close();
    }
  }
});

test("journal and posting ID reads preserve generated effects with distinct outcome, revision and posting sequences", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    const scenario = allocationAndTaxWorkflow("1.1.0");
    await f.ledger.provision(scenario.initial);
    for (const [i, command] of scenario.commands.entries()) {
      expect((await f.ledger.execute(command)).result.disposition).toBe("committed");
      expect(
        (await f.ledger.execute(posting(`journal-read-rejection-${i}`, 0n))).result.disposition,
      ).toBe("rejected");
    }
    for (const owner of [f, f.open()]) {
      const snapshot = await owner.ledger.read();
      const reader = await owner.storage.openCurrentRowReader();
      expect(snapshot.head.sequence).not.toBe(snapshot.head.bookRevision);
      expect(snapshot.head.postingSequence).not.toBe(snapshot.head.bookRevision);
      for (const booked of snapshot.aggregate.state.journals) {
        const outcome =
          BigInt(
            snapshot.aggregate.protocol.retainedResults.findIndex(
              (r) => r.commandId === booked.commandId,
            ),
          ) + 1n;
        for (const [family, id] of [
          ["journal", booked.journal.id],
          ...booked.journal.postings.map((p) => ["posting", p.id] as const),
        ] as const) {
          const found = await reader.readJournalIdentity(family, id);
          expect(found.disposition).toBe("present");
          if (found.disposition !== "present") throw new Error("Missing canonical journal");
          expect(found.outcomeSequence).toBe(outcome);
          expect(found.journal.ordinal).toBe(booked.postingSequence);
          expect(found.journal.row).toEqual(booked);
          expect(found.journal.encoded).toBe(encodeBookRow("state.journals", booked));
          expect(found.posting).toEqual(
            family === "journal"
              ? null
              : workflowValue(booked.journal.postings.find((p) => p.id === id)),
          );
          expect(Object.isFrozen(found)).toBe(true);
          expect(Object.isFrozen(found.journal)).toBe(true);
          expect(Object.isFrozen(found.journal.row)).toBe(true);
          expect(found.journal.row.journal.postings[0]?.bookValue.amount).toBeInstanceOf(
            ExactDecimal,
          );
        }
      }
      for (const family of ["journal", "posting"] as const) {
        for (const id of ["activate", "missing/α", "journal-read-rejection-0"])
          expect(await reader.readJournalIdentity(family, id)).toMatchObject({
            disposition: "absent",
            family,
            id,
            outcomeSequence: null,
            journal: null,
            posting: null,
          });
      }
      await reader.close();
      await expect(reader.readJournalIdentity("journal", "missing")).rejects.toThrow(
        "source_catalog_reader_closed",
      );
    }
  } finally {
    f.db.close();
  }
});

test("journal identity resolves both real journals emitted by one atomic disposal command", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    const scenario = allocationAndTaxWorkflow("1.1.0");
    await f.ledger.provision(scenario.initial);
    for (const command of scenario.commands) await f.ledger.execute(command);
    const terminal = workflowTerminationCommand(scenario);
    const template = posting("disposal-completion");
    if (template.type !== "postJournal") throw new Error("Expected journal template");
    const journal = {
      ...template.resolved.journal,
      economicAt: terminal.issuedAt,
      recordedAt: terminal.issuedAt,
      accountingDate: terminal.request.effectiveOn,
      postings: template.resolved.journal.postings.map((p, i) => ({
        ...p,
        accountId: i === 0 ? accountId("cash") : accountId("allocation-expense"),
        units: { ...p.units, canonicalNumber: ExactRational.of(i === 0 ? 10n : -10n, 1n) },
        bookValue: { ...p.bookValue, amount: ExactDecimal.of(i === 0 ? 1000n : -1000n, 2n) },
      })),
    };
    const resolved = resolveJournal(
      journal,
      scenario.initial.state.policies,
      scenario.initial.state.identity.ownerId,
      workflowValue(scenario.initial.state.quantizationPolicies[0]),
      journal.postings.map((p) => p.bookValue.amount.toRational()),
    );
    if (Array.isArray(resolved)) throw new Error("Completion must resolve");
    const command = sealCommand({
      ...terminal,
      request: { ...terminal.request, kind: "disposal" as const },
      disposalJournal: resolved as ResolvedTransaction,
    });
    const receipt = await f.ledger.execute(command);
    expect(receipt.result.disposition).toBe("committed");
    const snapshot = await f.ledger.read();
    const journals = snapshot.aggregate.state.journals.filter((j) => j.commandId === command.id);
    expect(journals.length).toBe(2);
    const reader = await f.storage.openCurrentRowReader();
    for (const booked of journals) {
      for (const [family, id] of [
        ["journal", booked.journal.id],
        ...booked.journal.postings.map((p) => ["posting", p.id] as const),
      ] as const) {
        const result = await reader.readJournalIdentity(family, id);
        expect(result.disposition).toBe("present");
        if (result.disposition !== "present") throw new Error("Missing disposal journal");
        expect(result.outcomeSequence).toBe(9n);
        expect(result.journal.ordinal).toBe(booked.postingSequence);
        expect(result.journal.row).toEqual(booked);
      }
    }
    await reader.close();
  } finally {
    f.db.close();
  }
});

test("journal identity resolution uses bounded source lookups rather than canonical history scans", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    await f.ledger.execute(posting("bounded-journal"));
    const exec = f.port.sql.exec.bind(f.port.sql);
    const calls: { sql: string; bindings: unknown[] }[] = [];
    let recording = false;
    f.port.sql.exec = (sql, ...bindings) => {
      if (recording) calls.push({ sql, bindings });
      return exec(sql, ...bindings);
    };
    for (const count of [2, 18]) {
      if (count === 18)
        for (let i = 2; i < 18; i++)
          await f.ledger.execute(posting(`journal-growth-${i}`, BigInt(i)));
      await f.ledger.read();
      const reader = await f.storage.openCurrentRowReader();
      for (const [family, id] of [
        ["journal", "bounded-journal"],
        ["posting", "bounded-journal-0"],
        ["posting", "absent"],
      ] as const) {
        calls.length = 0;
        recording = true;
        const found = await reader.readJournalIdentity(family, id);
        recording = false;
        const sourceReads = calls.filter((c) => c.sql.includes("FROM ledger_outcomes"));
        const chunks = calls.filter((c) => c.sql.includes("FROM ledger_chunks"));
        expect(sourceReads.length).toBe(id === "absent" ? 0 : 3);
        expect(chunks.length).toBe(id === "absent" ? 0 : 3);
        expect(
          sourceReads.every(
            (c) => c.sql.includes("WHERE sequence = ? LIMIT 2") && c.bindings[0] === "2",
          ),
        ).toBe(true);
        expect(chunks.every((c) => c.bindings[0] === "2")).toBe(true);
        expect(found.disposition).toBe(id === "absent" ? "absent" : "present");
      }
      await reader.close();
    }
  } finally {
    f.db.close();
  }
});

test("journal identity source failures at each resolution stage retire the pinned context", async () => {
  for (const stage of [1, 2, 3]) {
    for (const fault of ["missing", "expiry"]) {
      const f = fixture(":memory:", BOOK, true);
      try {
        await f.ledger.provision(genesis());
        await f.ledger.execute(activation());
        await f.ledger.execute(posting("staged-journal"));
        await f.ledger.read();
        const reader = await f.storage.openCurrentRowReader();
        const exec = f.port.sql.exec.bind(f.port.sql);
        let read = 0;
        f.port.sql.exec = (sql, ...bindings) => {
          const rows = exec(sql, ...bindings);
          if (sql.includes("FROM ledger_chunks") && ++read === stage) {
            if (fault === "missing") return [];
            f.faults.now = 110n;
          }
          return rows;
        };
        await expect(reader.readJournalIdentity("posting", "staged-journal-0")).rejects.toThrow();
        expect(read).toBe(stage);
        await expect(reader.readJournalIdentity("journal", "staged-journal")).rejects.toThrow(
          "source_catalog_reader_closed",
        );
      } finally {
        f.db.close();
      }
    }
  }
});

test("journal identity queries reject unsupported families, malformed IDs and stale heads", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    await f.ledger.read();
    for (const [family, id] of [
      ["lot", "id"],
      ["journal", ""],
      ["posting", " e"],
      ["posting", null],
    ] as const) {
      const invalid = await f.storage.openCurrentRowReader();
      await expect(
        invalid.readJournalIdentity(family as "journal", id as string),
      ).rejects.toThrow();
      await expect(invalid.readJournalIdentity("journal", "missing")).rejects.toThrow(
        "source_catalog_reader_closed",
      );
    }
    const stale = await f.storage.openCurrentRowReader();
    await f.open().ledger.execute(posting("new-journal"));
    await expect(stale.readJournalIdentity("journal", "new-journal")).rejects.toThrow();
    await expect(stale.readJournalIdentity("posting", "new-journal-0")).rejects.toThrow(
      "source_catalog_reader_closed",
    );
  } finally {
    f.db.close();
  }
});

test("immutable accounting identity reads match canonical state after later recognition and revision", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    const scenario = allocationAndTaxWorkflow("1.1.0");
    await f.ledger.provision(scenario.initial);
    for (const [i, command] of scenario.commands.entries()) {
      await f.ledger.execute(command);
      await f.ledger.execute(posting(`accounting-read-reject-${i}`, 0n));
    }
    for (const owner of [f, f.open()]) {
      const snapshot = await owner.ledger.read();
      const reader = await owner.storage.openCurrentRowReader();
      const populated = new Set<string>();
      for (const revision of snapshot.aggregate.state.revisions) {
        const sequence =
          BigInt(
            snapshot.aggregate.protocol.retainedResults.findIndex(
              (r) => r.commandId === revision.command.id,
            ),
          ) + 1n;
        for (const effect of revision.effects) {
          if (effect.type === "inventoryOwnership") {
            expect((await reader.readTyped("state.revisions", revision.bookRevision)).encoded).toBe(
              encodeBookRow("state.revisions", revision),
            );
            continue;
          }
          if (!isAccountingIdentityFamily(effect.type) || !("value" in effect)) continue;
          populated.add(effect.type);
          const result = await reader.readAccountingIdentity(effect.type, effect.value.id);
          expect(result.disposition).toBe("present");
          if (result.disposition !== "present") throw new Error("Missing immutable effect");
          expect(result.outcomeSequence).toBe(sequence);
          expect(result.bookRevision).toBe(revision.bookRevision);
          expect(result.effect).toEqual(effect);
          expect(Object.isFrozen(result)).toBe(true);
          expect(Object.isFrozen(result.effect.value)).toBe(true);
          const collection = ACCOUNTING_SOURCE_COLLECTIONS[effect.type];
          expect(
            snapshot.aggregate.state.accountingState[collection].find(
              (r) => r.id === effect.value.id,
            ),
          ).toEqual(result.effect.value);
          const revisionRow = await reader.readTyped("state.revisions", revision.bookRevision);
          expect(revisionRow.rowHash).toBe(result.sourceRevisionRowHash);
          expect(result.catalogDigest).toBe(revisionRow.catalogDigest);
        }
      }
      expect([...populated].sort()).toEqual([
        "allocationRecognition",
        "allocationSchedule",
        "allocationScheduleRevision",
        "taxDetermination",
      ]);
      for (const family of Object.keys(ACCOUNTING_SOURCE_COLLECTIONS)) {
        if (!isAccountingIdentityFamily(family)) throw new Error("Unknown accounting family");
        expect(await reader.readAccountingIdentity(family, "unused-effect/α")).toMatchObject({
          disposition: "absent",
          family,
          id: "unused-effect/α",
          outcomeSequence: null,
          bookRevision: null,
          sourceRevisionRowHash: null,
          effect: null,
        });
      }
      const oldSchedule = await reader.readAccountingIdentity(
        "allocationSchedule",
        scenario.schedule,
      );
      expect(oldSchedule.disposition).toBe("present");
      if (oldSchedule.disposition !== "present") throw new Error("Missing old schedule");
      expect(oldSchedule.effect.value.sourceBasis).toBeInstanceOf(ExactRational);
      expect(oldSchedule.effect.value.installments.length).toBe(3);
      // A later revision does not replace the original immutable schedule, and
      // the same raw ID in another family is not a lookup alias.
      expect(
        snapshot.aggregate.state.accountingState.allocationScheduleRevisions.length,
      ).toBeGreaterThan(0);
      expect(
        (await reader.readAccountingIdentity("allocationRecognition", scenario.schedule))
          .disposition,
      ).toBe("absent");
      await reader.close();
      await expect(
        reader.readAccountingIdentity("allocationSchedule", scenario.schedule),
      ).rejects.toThrow("source_catalog_reader_closed");
    }
  } finally {
    f.db.close();
  }
});

test("accounting identity access fetches two creating source rows independent of later outcome growth", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    const scenario = allocationAndTaxWorkflow("1.1.0");
    await f.ledger.provision(scenario.initial);
    for (const command of scenario.commands.slice(0, 3)) await f.ledger.execute(command);
    const exec = f.port.sql.exec.bind(f.port.sql);
    const calls: { sql: string; bindings: unknown[] }[] = [];
    let recording = false;
    f.port.sql.exec = (sql, ...bindings) => {
      if (recording) calls.push({ sql, bindings });
      return exec(sql, ...bindings);
    };
    for (const count of [3, 19]) {
      if (count === 19)
        for (let i = 0; i < 16; i++) await f.ledger.execute(posting(`effect-growth-${i}`, 0n));
      await f.ledger.read();
      const reader = await f.storage.openCurrentRowReader();
      for (const id of [scenario.schedule, "unused-effect"]) {
        calls.length = 0;
        recording = true;
        const result = await reader.readAccountingIdentity("allocationSchedule", id);
        recording = false;
        const outcomes = calls.filter((c) => c.sql.includes("FROM ledger_outcomes"));
        const chunks = calls.filter((c) => c.sql.includes("FROM ledger_chunks"));
        expect(result.disposition).toBe(id === scenario.schedule ? "present" : "absent");
        expect(outcomes.length).toBe(id === scenario.schedule ? 2 : 0);
        expect(chunks.length).toBe(id === scenario.schedule ? 2 : 0);
        expect(
          outcomes.every(
            (c) => c.sql.includes("WHERE sequence = ? LIMIT 2") && c.bindings[0] === "3",
          ),
        ).toBe(true);
        expect(chunks.every((c) => c.bindings[0] === "3")).toBe(true);
      }
      await reader.close();
    }
  } finally {
    f.db.close();
  }
});

test("accounting identity reads fail closed on missing paths or source bytes and late expiry", async () => {
  for (const failure of ["identity", "retained", "revision", "expiry"]) {
    const f = fixture(":memory:", BOOK, true);
    try {
      const scenario = allocationAndTaxWorkflow("1.1.0");
      await f.ledger.provision(scenario.initial);
      for (const command of scenario.commands.slice(0, 3)) await f.ledger.execute(command);
      await f.ledger.read();
      const reader = await f.storage.openCurrentRowReader();
      const exec = f.port.sql.exec.bind(f.port.sql);
      let chunks = 0;
      let injected = false;
      f.port.sql.exec = (sql, ...bindings) => {
        const rows = exec(sql, ...bindings);
        if (failure === "identity" && sql.includes("FROM ledger_index_pages")) {
          injected = true;
          return [];
        }
        if (sql.includes("FROM ledger_chunks")) {
          chunks++;
          if (
            (failure === "retained" && chunks === 1) ||
            (failure === "revision" && chunks === 2)
          ) {
            injected = true;
            return [];
          }
          if (failure === "expiry" && chunks === 2) {
            injected = true;
            f.faults.now = 110n;
          }
        }
        return rows;
      };
      await expect(
        reader.readAccountingIdentity("allocationSchedule", scenario.schedule),
      ).rejects.toThrow();
      expect(injected).toBe(true);
      await expect(
        reader.readAccountingIdentity("allocationSchedule", scenario.schedule),
      ).rejects.toThrow("source_catalog_reader_closed");
    } finally {
      f.db.close();
    }
  }
});

test("accounting identity readers reject mutable families and stale contexts", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    const scenario = allocationAndTaxWorkflow("1.1.0");
    await f.ledger.provision(scenario.initial);
    for (const command of scenario.commands.slice(0, 3)) await f.ledger.execute(command);
    await f.ledger.read();
    for (const [family, id] of [
      ["lotHolding", "x"],
      ["constructor", "x"],
      ["allocationSchedule", ""],
      ["allocationSchedule", "e\u0301"],
    ]) {
      const reader = await f.storage.openCurrentRowReader();
      await expect(
        reader.readAccountingIdentity(family as AccountingEffect["type"], id as string),
      ).rejects.toThrow();
      await expect(
        reader.readAccountingIdentity("allocationSchedule", scenario.schedule),
      ).rejects.toThrow("source_catalog_reader_closed");
    }
    const stale = await f.storage.openCurrentRowReader();
    await f.open().ledger.execute(workflowValue(scenario.commands[3]));
    await expect(
      stale.readAccountingIdentity("allocationSchedule", scenario.schedule),
    ).rejects.toThrow();
    await expect(stale.readAccountingIdentity("allocationRecognition", "missing")).rejects.toThrow(
      "source_catalog_reader_closed",
    );
  } finally {
    f.db.close();
  }
});

test("current lot identity reads preserve positions and return updated, coalesced and drained holdings", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    const scenario = lotIdentityWorkflow();
    await f.ledger.provision(scenario.initial);
    const identities = new Map<string, { ordinal: bigint; sequence: bigint }>();
    for (const [i, command] of scenario.commands.entries()) {
      expect((await f.ledger.execute(command)).result.disposition).toBe("committed");
      const snapshot = await f.ledger.read();
      const reader = await f.storage.openCurrentRowReader();
      for (const family of ["lot", "lotHolding", "lotAllocation"] as const) {
        const rows =
          family === "lot"
            ? snapshot.aggregate.state.lots
            : family === "lotHolding"
              ? snapshot.aggregate.state.lotHoldings
              : snapshot.aggregate.state.lotAllocations;
        for (const [j, row] of rows.entries()) {
          const id = "allocation" in row ? row.allocation.id : row.id;
          const key = JSON.stringify([family, id]);
          const first = identities.get(key) ?? {
            ordinal: BigInt(j) + 1n,
            sequence: BigInt(i) + 1n,
          };
          identities.set(key, first);
          expect(BigInt(j) + 1n).toBe(first.ordinal);
          const result = await reader.readLotIdentity(family, id);
          expect(result.disposition).toBe("present");
          if (result.disposition !== "present") throw new Error("Missing current lot row");
          expect(result.creationOutcomeSequence).toBe(first.sequence);
          expect(result.current.ordinal).toBe(first.ordinal);
          expect(result.current.row).toEqual(row);
          expect(Object.isFrozen(result.current.row)).toBe(true);
          const direct = await reader.read(LOT_IDENTITY_COLLECTIONS[family], first.ordinal);
          expect(result.current.encoded).toBe(direct.encoded);
          expect(result.current.rowHash).toBe(direct.rowHash);
        }
        for (const [key, first] of identities) {
          const [priorFamily, priorId] = JSON.parse(key);
          if (priorFamily !== family) continue;
          const current = workflowValue(rows[Number(first.ordinal - 1n)]);
          expect("allocation" in current ? current.allocation.id : current.id).toBe(priorId);
        }
        expect((await reader.readLotIdentity(family, "missing/α")).disposition).toBe("absent");
      }
      await reader.close();
    }
    const restarted = f.open();
    const snapshot = await restarted.ledger.read();
    const reader = await restarted.storage.openCurrentRowReader();
    const source = await reader.readLotIdentity("lotHolding", scenario.source);
    const destination = await reader.readLotIdentity("lotHolding", scenario.destination);
    expect(source.disposition).toBe("present");
    expect(destination.disposition).toBe("present");
    if (source.disposition !== "present" || destination.disposition !== "present")
      throw new Error("Missing lifecycle holding");
    expect(source.current.row.remainingQuantity.toString()).toBe("0/1");
    expect(source.current.row.remainingCarryingAmount.toString()).toBe("0/1");
    expect(destination.current.row.remainingQuantity.toString()).toBe("5/1");
    expect(destination.creationOutcomeSequence).toBe(4n);
    expect(snapshot.aggregate.state.lotHoldings.length).toBe(3);
    expect(snapshot.aggregate.state.lotAllocations.map((a) => a.kind)).toEqual([
      "transfer",
      "transfer",
      "disposal",
    ]);
    expect((await reader.readLotIdentity("lotAllocation", scenario.source)).disposition).toBe(
      "absent",
    );
    expect(await reader.readAllocationIdentityPresence(scenario.source)).toMatchObject({
      disposition: "absent",
      origin: null,
    });
    for (const allocation of snapshot.aggregate.state.lotAllocations)
      expect(await reader.readAllocationIdentityPresence(allocation.allocation.id)).toMatchObject({
        disposition: "present",
        origin: "legacy",
      });
    await reader.close();
  } finally {
    f.db.close();
  }
});

test("lot identity lookup reads creation evidence and the latest row source without scanning history", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    const scenario = lotIdentityWorkflow();
    await f.ledger.provision(scenario.initial);
    for (const command of scenario.commands) await f.ledger.execute(command);
    const exec = f.port.sql.exec.bind(f.port.sql);
    const sources: unknown[] = [];
    for (const count of [6, 22]) {
      // Only count the indexed lookup, never exclude recovery from a claimed end-to-end benchmark.
      f.port.sql.exec = exec;
      if (count === 22)
        for (let i = 0; i < 16; i++) await f.ledger.execute(posting(`lot-growth-${i}`, 0n));
      await f.ledger.read();
      const reader = await f.storage.openCurrentRowReader();
      sources.length = 0;
      f.port.sql.exec = (sql, ...bindings) => {
        if (sql.includes("FROM ledger_outcomes")) {
          expect(sql).toContain("WHERE sequence = ? LIMIT 2");
          sources.push(bindings[0]);
        }
        return exec(sql, ...bindings);
      };
      const result = await reader.readLotIdentity("lotHolding", scenario.source);
      expect(result.disposition).toBe("present");
      if (result.disposition !== "present") throw new Error("Missing drained holding");
      expect(result.current.row.remainingQuantity.toString()).toBe("0/1");
      expect(sources).toEqual(["2", "2", "6"]);
      sources.length = 0;
      expect((await reader.readLotIdentity("lotHolding", "missing")).disposition).toBe("absent");
      expect(sources).toEqual([]);
      await reader.close();
    }
  } finally {
    f.db.close();
  }
});

test("current lot reads reject missing latest source and current paths rather than returning creation values", async () => {
  for (const failure of ["source", "path", "expiry"]) {
    const f = fixture(":memory:", BOOK, true);
    try {
      const scenario = lotIdentityWorkflow();
      await f.ledger.provision(scenario.initial);
      for (const command of scenario.commands) await f.ledger.execute(command);
      await f.ledger.read();
      const reader = await f.storage.openCurrentRowReader();
      const raw = f.db.query("SELECT body FROM ledger_source_catalog").get() as { body: string };
      const collection = JSON.parse(raw.body).collections.find(
        (c: { name: string }) => c.name === "state.lotHoldings",
      );
      const root = JSON.parse(collection.encodedRoot).tree.digest;
      const exec = f.port.sql.exec.bind(f.port.sql);
      let injected = false;
      f.port.sql.exec = (sql, ...bindings) => {
        const rows = exec(sql, ...bindings);
        if (
          failure === "path" &&
          sql.includes("FROM ledger_source_nodes") &&
          bindings[0] === root
        ) {
          injected = true;
          return [];
        }
        if (sql.includes("FROM ledger_chunks") && bindings[0] === "6") {
          injected = true;
          if (failure === "source") return [];
          if (failure === "expiry") f.faults.now = 110n;
        }
        return rows;
      };
      await expect(reader.readLotIdentity("lotHolding", scenario.source)).rejects.toThrow();
      expect(injected).toBe(true);
      await expect(reader.readLotIdentity("lotHolding", scenario.source)).rejects.toThrow(
        "source_catalog_reader_closed",
      );
    } finally {
      f.db.close();
    }
  }
});

test("lot readers refuse invalid families and stale current-state contexts", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    const scenario = lotIdentityWorkflow();
    await f.ledger.provision(scenario.initial);
    for (const command of scenario.commands.slice(0, 4)) await f.ledger.execute(command);
    await f.ledger.read();
    for (const [family, id] of [
      ["constructor", "x"],
      ["allocationSchedule", "x"],
      ["lotHolding", ""],
    ]) {
      const reader = await f.storage.openCurrentRowReader();
      await expect(
        reader.readLotIdentity(family as LotIdentityFamily, id as string),
      ).rejects.toThrow();
      await expect(reader.readLotIdentity("lotHolding", scenario.source)).rejects.toThrow(
        "source_catalog_reader_closed",
      );
    }
    const stale = await f.storage.openCurrentRowReader();
    await f.open().ledger.execute(workflowValue(scenario.commands[4]));
    await expect(stale.readLotIdentity("lotHolding", scenario.destination)).rejects.toThrow();
    await expect(stale.readLotIdentity("lotHolding", scenario.destination)).rejects.toThrow(
      "source_catalog_reader_closed",
    );
  } finally {
    f.db.close();
  }
});

test("pinned row reader preserves frozen inventory lots, holdings and allocation source selectors", async () => {
  const raw = (
    await Bun.file(
      new URL("../../kernel/test/data/inventory-adjustment-legacy.json", import.meta.url),
    ).text()
  ).trim();
  const decoded = decodeDurableBook(raw);
  if (decoded.disposition !== "decoded") throw new Error(decoded.message);
  const legacy = decoded.aggregate;
  const config = workflowValue(legacy.state.configurationSnapshots[0]);
  const f = fixture(":memory:", legacy.state.identity.bookId, true);
  try {
    await f.ledger.provision({
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
    });
    let positiveRows = 0;
    for (const retained of legacy.protocol.retainedResults) {
      expect((await f.ledger.execute(retained.command)).result.resultHash).toEqual(
        retained.resultHash,
      );
      const current = await f.ledger.read();
      const projection = await projectLegacyLogicalBook(encodeDurableBook(current.aggregate));
      const reader = await f.storage.openCurrentRowReader();
      for (const name of ["state.lots", "state.lotHoldings", "state.lotAllocations"]) {
        const collection = workflowValue(projection.collections.find((c) => c.name === name));
        for (const row of collection.rows) {
          const result = await reader.read(name, row.ordinal);
          expect(result.rowHash).toBe(row.contentHash);
          expect(result.encoded).toBe(row.encoded);
          positiveRows++;
        }
      }
      await reader.close();
    }
    expect(positiveRows).toBeGreaterThan(0);
    expect(encodeDurableBook((await f.open().ledger.read()).aggregate)).toBe(raw);
  } finally {
    f.db.close();
  }
});

test("pinned row access reads one source and logarithmic paths without loading retained history", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    const exec = f.port.sql.exec.bind(f.port.sql);
    const calls: { sql: string; bindings: unknown[]; rows: number; bytes: number }[] = [];
    let recording = false;
    f.port.sql.exec = (sql, ...bindings) => {
      const rows = exec(sql, ...bindings) as Record<string, unknown>[];
      if (recording) {
        calls.push({
          sql,
          bindings,
          rows: rows.length,
          bytes: rows.reduce(
            (sum, r) =>
              sum +
              Object.values(r).reduce<number>(
                (n, v) => n + (v instanceof ArrayBuffer ? v.byteLength : 0),
                0,
              ),
            0,
          ),
        });
      }
      return rows;
    };
    let baseline = "";
    let sourceBytes = 0;
    for (const count of [1, 17]) {
      if (count === 17)
        for (let i = 1; i <= 16; i++) await f.ledger.execute(posting(`row-path-${i}`, BigInt(i)));
      await f.ledger.read();
      const reader = await f.storage.openCurrentRowReader();
      calls.length = 0;
      recording = true;
      const row = await reader.read("protocol.retainedResults", 1n);
      recording = false;
      expect(row.disposition).toBe("present");
      const outcomes = calls.filter((c) => c.sql.includes("FROM ledger_outcomes"));
      expect(outcomes.length).toBe(1);
      expect(outcomes[0]?.rows).toBe(1);
      expect(outcomes[0]?.sql).toContain("WHERE sequence = ? LIMIT 2");
      const chunks = calls.filter((c) => c.sql.includes("FROM ledger_chunks"));
      expect(chunks.length).toBe(1);
      expect(chunks[0]?.bindings[0]).toBe("1");
      const nodes = calls.filter((c) => c.sql.includes("FROM ledger_source_nodes"));
      expect(nodes.length).toBeLessThanOrEqual(2 * (Math.ceil(Math.log2(count)) + 2));
      expect(nodes.every((c) => c.sql.includes("WHERE digest = ? LIMIT 2"))).toBe(true);
      if (count === 1) {
        baseline = row.encoded ?? "";
        sourceBytes = chunks[0]?.bytes ?? 0;
      } else {
        expect(row.encoded).toBe(baseline);
        expect(chunks[0]?.bytes).toBe(sourceBytes);
      }
      await reader.close();
    }
  } finally {
    f.db.close();
  }
});

test("a concurrent publication invalidates current-row readers instead of mixing catalog heads", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    await f.ledger.read();
    const reader = await f.storage.openCurrentRowReader();
    await f.open().ledger.execute(posting("advance-pinned-head"));
    await expect(reader.read("protocol.retainedResults", 1n)).rejects.toThrow();
    await expect(reader.read("protocol.retainedResults", 2n)).rejects.toThrow(
      "source_catalog_reader_closed",
    );
    const snapshot = await f.ledger.read();
    const fresh = await f.storage.openCurrentRowReader();
    expect(fresh.head).toEqual(snapshot.head);
    expect((await fresh.read("protocol.retainedResults", 2n)).disposition).toBe("present");
    await fresh.close();
  } finally {
    f.db.close();
  }
});

test("current-row reader serializes read and close and rejects unsupported collection queries", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    await f.ledger.provision(genesis());
    const reader = await f.storage.openCurrentRowReader();
    const first = reader.read("state.configurationSnapshots", 1n);
    const closing = reader.close();
    const denied = reader.read("state.configurationSnapshots", 1n);
    const results = await Promise.allSettled([first, closing, denied]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
    expect((await first).disposition).toBe("present");
    expect(f.db.query("SELECT COUNT(*) AS n FROM ledger_index_pins").get()).toEqual({ n: 0 });
    for (const query of [
      { collection: "unknown", ordinal: 1n },
      { collection: "state.journals", ordinal: 0n },
      { collection: "state.journals", ordinal: 1n << 256n },
    ]) {
      const current = await f.storage.openCurrentRowReader();
      await expect(current.read(query.collection, query.ordinal)).rejects.toThrow();
      await expect(current.read("state.configurationSnapshots", 1n)).rejects.toThrow(
        "source_catalog_reader_closed",
      );
    }
  } finally {
    f.db.close();
  }
});

test("expiry, maintenance, authority rotation and uncertain durability retire current-row readers", async () => {
  for (const failure of ["expiry", "maintenance", "fence", "late-expiry", "uncertain"]) {
    const f = fixture(":memory:", BOOK, true);
    try {
      await f.ledger.provision(genesis());
      await f.ledger.execute(activation());
      await f.ledger.read();
      const reader = await f.storage.openCurrentRowReader();
      if (failure === "expiry") f.faults.now = 110n;
      if (failure === "maintenance") f.faults.pending = true;
      if (failure === "fence") f.faults.fence = "1";
      const exec = f.port.sql.exec.bind(f.port.sql);
      let injected = false;
      f.port.sql.exec = (sql, ...bindings) => {
        const rows = exec(sql, ...bindings);
        if (
          !injected &&
          sql.includes("FROM ledger_chunks") &&
          (failure === "late-expiry" || failure === "uncertain")
        ) {
          injected = true;
          if (failure === "late-expiry") f.faults.now = 110n;
          else f.faults.syncFailures++;
        }
        return rows;
      };
      await expect(reader.read("protocol.retainedResults", 1n)).rejects.toThrow();
      await expect(reader.read("protocol.retainedResults", 1n)).rejects.toThrow(
        "source_catalog_reader_closed",
      );
      if (failure === "late-expiry" || failure === "uncertain") expect(injected).toBe(true);
      expect(f.db.query("SELECT COUNT(*) AS n FROM ledger_outcomes").get()).toEqual({ n: 1 });
    } finally {
      f.db.close();
    }
  }
});

test("missing required row paths and damaged genesis/outcome bytes cannot become absence", async () => {
  for (const failure of ["node", "genesis", "outcome"]) {
    const f = fixture(":memory:", BOOK, true);
    try {
      await f.ledger.provision(genesis());
      await f.ledger.execute(activation());
      await f.ledger.read();
      const reader = await f.storage.openCurrentRowReader();
      const collection =
        failure === "genesis" ? "state.configurationSnapshots" : "protocol.retainedResults";
      if (failure === "node") {
        const row = f.db.query("SELECT body FROM ledger_source_catalog").get() as { body: string };
        const c = JSON.parse(row.body).collections.find(
          (x: { name: string }) => x.name === collection,
        );
        f.db
          .query("DELETE FROM ledger_source_nodes WHERE digest = ?")
          .run(JSON.parse(c.encodedRoot).tree.digest);
      } else
        f.db
          .query("UPDATE ledger_chunks SET bytes = x'00' WHERE record_id = ? AND ordinal = 0")
          .run(failure === "genesis" ? "genesis" : "1");
      await expect(reader.read(collection, 1n)).rejects.toThrow();
      await expect(reader.read(collection, 2n)).rejects.toThrow("source_catalog_reader_closed");
    } finally {
      f.db.close();
    }
  }
});

test("concurrent async source-catalog provisioning converges without replacing the winning genesis", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    const heads = await Promise.all([
      f.open().ledger.provision(genesis()),
      f.open().ledger.provision(genesis()),
    ]);
    expect(heads[0]).toEqual(heads[1]);
    expect((await f.ledger.read()).head.sequence).toBe("0");
    await expect(f.open().ledger.provision(genesis("Different cash name"))).rejects.toThrow(
      "ledger_genesis_mismatch",
    );
    expect((await f.open().ledger.read()).head).toEqual(heads[0]);
  } finally {
    f.db.close();
  }
});

test("ordinary source-catalog publication writes changed paths, not the entire retained population", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    let nodes = 0,
      origins = 0,
      catalogs = 0;
    const exec = f.port.sql.exec.bind(f.port.sql);
    f.port.sql.exec = (sql, ...bindings) => {
      if (sql.startsWith("INSERT INTO ledger_source_nodes")) nodes++;
      if (sql.startsWith("INSERT INTO ledger_source_origins")) origins++;
      if (sql.startsWith("UPDATE ledger_source_catalog")) catalogs++;
      return exec(sql, ...bindings);
    };
    for (let i = 1; i <= 16; i++) {
      nodes = 0;
      origins = 0;
      catalogs = 0;
      const receipt = await f.ledger.execute(posting(`catalog-growth-${i}`, BigInt(i)));
      expect(receipt.result.disposition).toBe("committed");
      expect(origins).toBe(3); // Journal, financial revision, retained result.
      expect(catalogs).toBe(1);
      expect(nodes).toBeGreaterThan(0);
      expect(nodes).toBeLessThanOrEqual(6 * (Math.ceil(Math.log2(i + 1)) + 2));
    }
    expect((await f.open().ledger.read()).head.sequence).toBe("17");
  } finally {
    f.db.close();
  }
});

test("first source catalog publication rolls back as a unit when its metadata insert fails", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    f.faults.afterSql = "INSERT INTO ledger_source_catalog";
    await expect(f.ledger.provision(genesis())).rejects.toThrow("injected owner SQL failure");
    expect(f.db.query("SELECT name FROM sqlite_master WHERE name LIKE 'ledger_%'").all()).toEqual(
      [],
    );
    f.faults.afterSql = "";
    expect((await f.open().ledger.provision(genesis())).sequence).toBe("0");
  } finally {
    f.db.close();
  }
});

async function runCrashWorker(
  path: string,
  operation: "initialize" | "initialize-groups" | "transfer" | "terminate" | "reject",
  point: string,
  sourceCatalog = false,
) {
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL("./process-worker.ts", import.meta.url)),
      path,
      operation,
      point,
      sourceCatalog ? "sources" : "identity",
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { TMPDIR: tmpdir() } },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 10_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, signal: child.signalCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}

test("crash subprocess rejects invalid target scope and unknown hooks before opening SQLite", async () => {
  for (const [prefix, point] of [
    ["rastrata-worker-guard-", "none"],
    ["rastrata-cumulative-crash-", "unknown-hook"],
  ]) {
    const directory = mkdtempSync(join(tmpdir(), workflowValue(prefix)));
    const path = join(directory, "book.sqlite");
    try {
      const result = await runCrashWorker(path, "initialize", workflowValue(point));
      expect(result.timedOut).toBeFalse();
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid isolated-process test arguments");
      expect(result.stdout).toBe("");
      expect(await Bun.file(path).exists()).toBeFalse();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

for (const point of ["group-nodes", "group-descriptors", "group-root", "committed"]) {
  test(`group catalog SIGKILL ${point} restores one complete accounting and group population`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "rastrata-cumulative-crash-"));
    const path = join(directory, "book.sqlite");
    try {
      const initialized = await runCrashWorker(path, "initialize-groups", "none", true);
      expect(initialized.timedOut).toBeFalse();
      expect(initialized.exitCode, initialized.stderr).toBe(0);
      const first = fixture(path, BOOK, true);
      const before = await first.ledger.read();
      const groupBefore = first.db.query("SELECT body, digest FROM ledger_group_catalog").get();
      first.db.close();
      const command = workflowValue(lotIdentityWorkflow().commands[3]);
      const oracle = executeBookCommand(before.aggregate.state, before.aggregate.protocol, command);
      expect(oracle.result.disposition).toBe("committed");
      const killed = await runCrashWorker(path, "transfer", point, true);
      expect(killed.timedOut).toBeFalse();
      expect(killed.signal, killed.stderr).toBe("SIGKILL");
      expect(killed.stderr).toBe(`REACHED:${point}\n`);
      expect(killed.stdout).toBe("");
      const reopened = fixture(path, BOOK, true);
      try {
        const recovered = await reopened.ledger.read();
        expect(encodeDurableBook(recovered.aggregate)).toBe(
          encodeDurableBook(
            point === "committed"
              ? { state: oracle.state, protocol: oracle.protocol }
              : before.aggregate,
          ),
        );
        if (point !== "committed")
          expect(reopened.db.query("SELECT body, digest FROM ledger_group_catalog").get()).toEqual(
            groupBefore,
          );
        await assertGroupDirectory(reopened, recovered);
        const receipt = await reopened.ledger.execute(command);
        expect(receipt.outcomeSequence).toBe(4n);
        expect(receipt.originalResult).toEqual(oracle.result);
        const after = await reopened.open().ledger.read();
        expect(after.head.sequence).toBe("4");
        expect(encodeDurableBook(after.aggregate)).toBe(
          encodeDurableBook({ state: oracle.state, protocol: oracle.protocol }),
        );
        await assertGroupDirectory(reopened, after);
        expect((await reopened.ledger.execute(command)).originalResult).toEqual(oracle.result);
        expect(reopened.db.query("SELECT COUNT(*) AS n FROM ledger_outcomes").get()).toEqual({
          n: 4,
        });
      } finally {
        reopened.db.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const rejected of [false, true])
  for (const point of ["source-nodes", "source-origins", "source-root", "committed"]) {
    test(`source catalog SIGKILL ${point} retains exactly the ${rejected ? "rejected" : "committed"} outcome across restart`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "rastrata-cumulative-crash-"));
      const path = join(directory, "book.sqlite");
      try {
        const initialized = await runCrashWorker(path, "initialize", "none", true);
        expect(initialized.exitCode, initialized.stderr).toBe(0);
        const first = fixture(path, BOOK, true);
        const before = await first.ledger.read();
        const sourceBefore = first.db.query("SELECT body, digest FROM ledger_source_catalog").get();
        first.db.close();
        const command = workflowTerminationCommand(
          allocationAndTaxWorkflow("1.1.0"),
          rejected ? 7n : 8n,
        );
        const oracle = executeBookCommand(
          before.aggregate.state,
          before.aggregate.protocol,
          command,
        );
        expect(oracle.result.disposition).toBe(rejected ? "rejected" : "committed");
        const killed = await runCrashWorker(path, rejected ? "reject" : "terminate", point, true);
        expect(killed.timedOut).toBe(false);
        expect(killed.signal).toBe("SIGKILL");
        expect(killed.stderr).toBe(`REACHED:${point}\n`);
        expect(killed.stdout).toBe("");
        const reopened = fixture(path, BOOK, true);
        try {
          const recovered = await reopened.ledger.read();
          expect(encodeDurableBook(recovered.aggregate)).toBe(
            encodeDurableBook(
              point === "committed"
                ? { state: oracle.state, protocol: oracle.protocol }
                : before.aggregate,
            ),
          );
          if (point !== "committed")
            expect(
              reopened.db.query("SELECT body, digest FROM ledger_source_catalog").get(),
            ).toEqual(sourceBefore);
          const receipt = await reopened.ledger.execute(command);
          expect(receipt.outcomeSequence).toBe(9n);
          expect(receipt.originalResult).toEqual(oracle.result);
          expect((await reopened.open().ledger.read()).head.sequence).toBe("9");
        } finally {
          reopened.db.close();
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

test("source catalog corruption fails closed without changing canonical accounting", async () => {
  for (const target of ["catalog", "node", "origin"]) {
    const f = fixture(":memory:", BOOK, true);
    try {
      await f.ledger.provision(genesis());
      await f.ledger.execute(activation());
      const canonical = new SqliteBookStorage(f.scope.objectId, f.port);
      const before = JSON.stringify(canonical.load(f.scope));
      const rootRow = f.db.query("SELECT body FROM ledger_source_catalog").get() as {
        body: string;
      };
      const c = JSON.parse(rootRow.body).collections.find(
        (x: { name: string }) => x.name === "protocol.retainedResults",
      );
      const digest = JSON.parse(c.locatorRoot).tree.digest;
      const node = f.db
        .query("SELECT body FROM ledger_source_nodes WHERE digest = ?")
        .get(digest) as { body: string };
      if (target === "catalog")
        f.db.query("UPDATE ledger_source_catalog SET body = body || ' '").run();
      else if (target === "node")
        f.db
          .query("UPDATE ledger_source_nodes SET body = body || ' ' WHERE digest = ?")
          .run(digest);
      else
        f.db
          .query("UPDATE ledger_source_origins SET body = body || ' ' WHERE digest = ?")
          .run(JSON.parse(node.body).value);
      await expect(f.open().ledger.read()).rejects.toThrow();
      await expect(f.open().ledger.execute(posting("after-source-corruption"))).rejects.toThrow();
      expect(JSON.stringify(canonical.load(f.scope))).toBe(before);
    } finally {
      f.db.close();
    }
  }
});

test("competing source-catalog owners serialize publication and retain the losing command", async () => {
  const f = fixture(":memory:", BOOK, true);
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    const commands = [posting("source-race-a"), posting("source-race-b")];
    const receipts = await Promise.all(commands.map((command) => f.open().ledger.execute(command)));
    expect(receipts.map((r) => r.result.disposition).sort()).toEqual(["committed", "rejected"]);
    expect((await f.open().ledger.read()).head.sequence).toBe("3");
    for (const [index, command] of commands.entries())
      expect((await f.open().ledger.execute(command)).originalResult).toEqual(
        workflowValue(receipts[index]).result,
      );
  } finally {
    f.db.close();
  }
});

test("SIGKILL at actual SQLite publication boundaries preserves cumulative effects and rejected outcomes", async () => {
  const scenario = allocationAndTaxWorkflow("1.1.0");
  const identities: readonly [IdentityFamily, string][] = [
    ["command", "workflow-crash-termination"],
    ["journal", "workflow-crash-terminal-journal"],
    ["posting", "workflow-crash-terminal-allocation"],
    ["posting", "workflow-crash-terminal-contra"],
    ["allocationScheduleRevision", "workflow-crash-terminal"],
  ];
  for (const rejected of [false, true])
    for (const point of [
      "derived-page",
      "outcome",
      "chunks",
      "head",
      "root",
      "pin-retirement",
      "committed",
    ]) {
      const command = workflowTerminationCommand(scenario, rejected ? 7n : 8n);
      const directory = mkdtempSync(join(tmpdir(), "rastrata-cumulative-crash-"));
      const path = join(directory, "book.sqlite");
      try {
        const initialized = await runCrashWorker(path, "initialize", "none");
        expect(initialized.timedOut, point).toBeFalse();
        expect(initialized.exitCode, initialized.stderr).toBe(0);
        expect(JSON.parse(initialized.stdout).status).toBe("initialized");
        const baseline = await (async () => {
          const f = fixture(path);
          try {
            return { snapshot: await f.ledger.read(), view: (await f.control.readMetadata()).view };
          } finally {
            f.db.close();
          }
        })();
        const oracle = executeBookCommand(
          baseline.snapshot.aggregate.state,
          baseline.snapshot.aggregate.protocol,
          command,
        );
        expect(oracle.result.disposition).toBe(rejected ? "rejected" : "committed");
        if (rejected) expect(oracle.result.diagnostics[0]?.code).toBe("stale_book_revision");
        const complete = { state: oracle.state, protocol: oracle.protocol };
        const killed = await runCrashWorker(path, rejected ? "reject" : "terminate", point);
        expect(killed.timedOut, point).toBeFalse();
        expect(killed.signal, killed.stderr).toBe("SIGKILL");
        expect(killed.stderr).toBe(`REACHED:${point}\n`);
        expect(killed.stdout).toBe(""); // No fabricated or prematurely acknowledged receipt.
        const f = fixture(path);
        try {
          const committed = point === "committed";
          const recovered = await f.ledger.read();
          expect(encodeDurableBook(recovered.aggregate), point).toBe(
            encodeDurableBook(committed ? complete : baseline.snapshot.aggregate),
          );
          expect(recovered.head.sequence).toBe(committed ? "9" : "8");
          const view = (await f.control.readMetadata()).view;
          expect(view.coldRoot).toBe(baseline.view.coldRoot);
          expect(view.hotCount).toBe(
            String(BigInt(baseline.view.hotCount) + (committed ? (rejected ? 1n : 5n) : 0n)),
          );
          if (!committed) expect(view.hotRoot).toBe(baseline.view.hotRoot);
          const root = workflowValue(await f.pages.readRootDescriptor(view.hotRoot));
          for (const [family, id] of identities) {
            const key = identityIndexKey({ bookId: BOOK, family, id });
            expect(
              (
                await lookupIndexEntry(root, root.contentHash, key, (location) =>
                  f.pages.read(location),
                )
              ).sequence,
            ).toBe(committed && (!rejected || family === "command") ? 9n : null);
          }
          const retry = await f.ledger.execute(command);
          expect(retry.result.disposition).toBe(
            committed ? "replayed" : rejected ? "rejected" : "committed",
          );
          expect(committed ? retry.originalResult : retry.result).toEqual(oracle.result);
          expect(retry.outcomeSequence).toBe(9n);
          const after = await f.ledger.read();
          expect(encodeDurableBook(after.aggregate)).toBe(encodeDurableBook(complete));
          const balance = after.aggregate.state.journals
            .flatMap(({ journal }) => journal.postings)
            .filter((p) => p.accountId === scenario.accounts.prepaid)
            .reduce((sum, p) => sum.add(p.bookValue.amount.toRational()), ExactRational.zero());
          expect(balance.toString()).toBe(rejected ? "10/1" : "0/1");
          expect(after.head.bookRevision).toBe(rejected ? "8" : "9");
          expect(f.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
            count: 9,
          });
          expect((await f.open().ledger.execute(command)).originalResult).toEqual(oracle.result);
          expect(await f.ledger.read()).toEqual(after);
          // Expire only these test leases, then drain bounded metadata cleanup.
          // Committed derived pages and the selected roots must remain intact.
          f.faults.now = 200n;
          let drained = false;
          for (let batch = 0; batch < 200; batch++) {
            if ((await f.storage.maintain(2)).cleanup.pinId === null) {
              drained = true;
              break;
            }
          }
          expect(drained).toBeTrue();
          expect(await f.open().ledger.read()).toEqual(after);
        } finally {
          f.db.close();
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
});

test("competing cumulative terminations settle once and retain the exact losing receipt", async () => {
  const scenario = allocationAndTaxWorkflow("1.1.0");
  const left = workflowTerminationCommand(scenario);
  const right = sealCommand({
    ...left,
    id: commandId("competing-terminal"),
    request: {
      ...left.request,
      id: allocationScheduleRevisionId("competing-terminal"),
      generatedEffectKey: effectKey("competing-terminal:journal:0"),
    },
  });
  const f = fixture();
  try {
    await f.ledger.provision(scenario.initial);
    for (const command of scenario.commands)
      expect((await f.ledger.execute(command)).result.disposition).toBe("committed");
    const before = await f.ledger.read();
    const oldCount = BigInt((await f.control.readMetadata()).view.hotCount);
    const commands = [left, right];
    const receipts = await Promise.all(commands.map((command) => f.open().ledger.execute(command)));
    expect(receipts.map((receipt) => receipt.result.disposition).sort()).toEqual([
      "committed",
      "rejected",
    ]);
    const winner = receipts.findIndex((r) => r.result.disposition === "committed");
    const loser = 1 - winner;
    expect(workflowValue(receipts[loser]).result.diagnostics[0]?.code).toBe("stale_book_revision");
    const committed = executeBookCommand(
      before.aggregate.state,
      before.aggregate.protocol,
      workflowValue(commands[winner]),
    );
    const rejected = executeBookCommand(
      committed.state,
      committed.protocol,
      workflowValue(commands[loser]),
    );
    const after = await f.ledger.read();
    expect(encodeDurableBook(after.aggregate)).toBe(
      encodeDurableBook({ state: rejected.state, protocol: rejected.protocol }),
    );
    expect(after.head.sequence).toBe("10");
    expect(after.head.bookRevision).toBe("9");
    expect(after.aggregate.state.journals.length).toBe(before.aggregate.state.journals.length + 1);
    expect(after.aggregate.state.accountingState.allocationScheduleRevisions.length).toBe(
      before.aggregate.state.accountingState.allocationScheduleRevisions.length + 1,
    );
    expect((await f.control.readMetadata()).view.hotCount).toBe(String(oldCount + 6n));
    for (const [i, command] of commands.entries())
      expect((await f.open().ledger.execute(command)).originalResult).toEqual(
        workflowValue(receipts[i]).result,
      );
    expect(await f.ledger.read()).toEqual(after);
  } finally {
    f.db.close();
  }
});

test("indexed owner preserves exact schedule revision and multi-line tax workflows across reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-indexed-accounting-"));
  const path = join(directory, "book.sqlite");
  let f = fixture(path);
  const scenario = allocationAndTaxWorkflow();
  let oracle = scenario.initial;
  const receipts = [];
  // This expected population is assembled independently of both production
  // identity projectors. Explicit specialized identities are paired with their
  // FIRST outcome sequence; journal IDs come from the separately executed kernel.
  const expected = new Map<string, bigint>();
  const add = (family: IdentityFamily, id: string, sequence: bigint) => {
    const key = identityIndexKey({ bookId: BOOK, family, id });
    expect(expected.has(key)).toBeFalse();
    expected.set(key, sequence);
  };
  const specialized: Record<number, readonly [IdentityFamily, string][]> = {
    1: [["openingBoundary", "opening"]],
    3: [["allocationSchedule", "workflow-schedule"]],
    4: [["allocationRecognition", "workflow-recognition"]],
    5: [
      ["allocationScheduleRevision", "workflow-revision"],
      ["allocationSchedule", "workflow-successor"],
    ],
    6: [["allocationRecognition", "workflow-successor-recognition-0"]],
    7: [["allocationRecognition", "workflow-successor-recognition-1"]],
    8: [["taxDetermination", "workflow-tax-determination"]],
  };
  async function verifyIndex() {
    const metadata = await f.control.readMetadata();
    expect(metadata.view.coldCount).toBe("0");
    expect(metadata.view.hotCount).toBe(String(expected.size));
    const root = await f.pages.readRootDescriptor(metadata.view.hotRoot);
    if (!root) throw new Error("Missing selected workflow root");
    const entries = [];
    for await (const entry of enumerateIndexPages(root, root.contentHash, (id) =>
      f.pages.read(id),
    )) {
      entries.push(entry);
    }
    expect(entries).toEqual(
      [...expected]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, sequence]) => ({ key, sequence })),
    );
  }
  try {
    await f.ledger.provision(scenario.initial);
    for (const [index, command] of scenario.commands.entries()) {
      const sequence = BigInt(index + 1);
      const previousJournals = oracle.state.journals.length;
      const next = executeBookCommand(oracle.state, oracle.protocol, command);
      expect(
        next.result.disposition,
        `${command.type}: ${JSON.stringify(next.result.diagnostics)}`,
      ).toBe("committed");
      // Use a fresh owner instance at every step, not a cached in-memory aggregate.
      const receipt = await f.open().ledger.execute(command);
      expect(receipt.result).toEqual(next.result);
      expect(receipt.outcomeSequence).toBe(sequence);
      receipts.push(receipt);
      oracle = { state: next.state, protocol: next.protocol };
      add("command", command.id, sequence);
      for (const [family, id] of specialized[index + 1] ?? []) add(family, id, sequence);
      for (const { journal } of oracle.state.journals.slice(previousJournals)) {
        add("journal", journal.id, sequence);
        for (const posting of journal.postings) add("posting", posting.id, sequence);
        expect(
          journal.postings
            .reduce(
              (total, posting) => total.add(posting.bookValue.amount.toRational()),
              ExactRational.zero(),
            )
            .isZero(),
        ).toBeTrue();
      }
      expect(encodeDurableBook((await f.ledger.read()).aggregate)).toBe(encodeDurableBook(oracle));
      await verifyIndex();
    }
    const amounts = oracle.state.journals
      .slice(1, 4)
      .map(({ journal }) =>
        journal.postings.map((p) => p.bookValue.amount.toRational().toString()),
      );
    // Historical 1.0.0 CHARACTERIZATION, not a release acceptance assertion:
    // each exact installment rounds independently. Exact recognized basis is 90
    // but posted allocations total 89.99. A prospective completion/rounding rule
    // is still needed; changing old outputs would invalidate retained receipts.
    expect(amounts).toEqual([
      ["3333/100", "-3333/100"],
      ["2833/100", "-2833/100"],
      ["2833/100", "-2833/100"],
    ]);
    const exactRecognized = oracle.state.accountingState.allocationRecognitions.reduce(
      (sum, recognition) => {
        const schedule = workflowValue(
          oracle.state.accountingState.allocationSchedules.find(
            (s) => s.id === recognition.scheduleId,
          ),
        );
        return sum.add(
          workflowValue(schedule.installments.find((i) => i.ordinal === recognition.ordinal))
            .amount,
        );
      },
      ExactRational.zero(),
    );
    const postedRecognized = oracle.state.journals
      .slice(1, 4)
      .reduce(
        (sum, { journal }) =>
          sum.add(
            workflowValue(
              journal.postings.find((p) => p.accountId === scenario.accounts.expense),
            ).bookValue.amount.toRational(),
          ),
        ExactRational.zero(),
      );
    expect(exactRecognized.toString()).toBe("90/1");
    expect(postedRecognized.toString()).toBe("8999/100");
    expect(exactRecognized.subtract(postedRecognized).toString()).toBe("1/100");
    const purchase = workflowValue(oracle.state.journals.at(-1)).journal;
    const accountTotal = (account: string) =>
      purchase.postings
        .filter((p) => p.accountId === account)
        .reduce((total, p) => total.add(p.bookValue.amount.toRational()), ExactRational.zero())
        .toString();
    expect(accountTotal(scenario.accounts.expense)).toBe("155/1");
    expect(accountTotal(scenario.accounts.inputTax)).toBe("31/2");
    expect(accountTotal(scenario.accounts.payable)).toBe("-341/2");
    expect(oracle.state.accountingState.allocationSchedules).toHaveLength(2);
    expect(oracle.state.accountingState.allocationScheduleRevisions).toHaveLength(1);
    expect(oracle.state.accountingState.allocationRecognitions).toHaveLength(3);
    expect(oracle.state.accountingState.taxDeterminations).toHaveLength(1);

    const original = workflowValue(scenario.commands[3]);
    if (original.type !== "recognizeScheduledAllocation") throw new Error("Expected recognition");
    const rejected: BookCommand = sealCommand({
      ...original,
      id: commandId("workflow-superseded-recognition"),
      expectedBookRevision: 8n,
      issuedAt: instant("2026-03-31T15:00:00Z"),
      completedAt: instant("2026-03-31T15:00:01Z"),
      committedAt: instant("2026-03-31T15:00:02Z"),
      request: {
        ...original.request,
        governedAt: instant("2026-03-31T15:00:00Z"),
        id: allocationRecognitionId("must-not-be-indexed"),
        ordinal: 2n,
      },
    });
    const priorState = encodeDurableBook(oracle);
    const next = executeBookCommand(oracle.state, oracle.protocol, rejected);
    expect(next.result.disposition).toBe("rejected");
    expect(next.result.diagnostics[0]?.code).toBe("allocation_schedule_violation");
    const rejection = await f.ledger.execute(rejected);
    expect(rejection.result).toEqual(next.result);
    expect(rejection.outcomeSequence).toBe(9n);
    expect(next.state).toEqual(oracle.state);
    oracle = { state: next.state, protocol: next.protocol };
    add("command", rejected.id, 9n);
    await verifyIndex();
    const beforeRestart = await f.ledger.read();
    f.db.close();
    f = fixture(path);
    expect(await f.ledger.read()).toEqual(beforeRestart);
    // Historical reads still validate the CURRENT complete index, but return the
    // original accounting cutoff, including its pre-rejection protocol state.
    expect(encodeDurableBook((await f.ledger.readAt(8n)).aggregate)).toBe(priorState);
    for (const [index, command] of scenario.commands.entries()) {
      const retry = await f.ledger.execute(command);
      expect(retry.result.disposition).toBe("replayed");
      expect(retry.originalResult).toEqual(workflowValue(receipts[index]).result);
      expect(retry.outcomeSequence).toBe(BigInt(index + 1));
    }
    expect((await f.ledger.execute(rejected)).originalResult).toEqual(rejection.result);
    expect(await f.ledger.read()).toEqual(beforeRestart);
    await verifyIndex();
  } finally {
    f.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy schedule termination retains a reproducible posted-rounding remainder, not completion evidence", async () => {
  const f = fixture();
  const scenario = allocationAndTaxWorkflow();
  try {
    await f.ledger.provision(scenario.initial);
    for (const command of scenario.commands.slice(0, 7)) {
      expect((await f.ledger.execute(command)).result.disposition).toBe("committed");
    }
    const revision = workflowValue(scenario.commands[4]);
    if (revision.type !== "reviseAllocationSchedule") throw new Error("Expected revision");
    const termination = sealCommand({
      ...revision,
      id: commandId("workflow-terminate"),
      expectedBookRevision: 7n,
      issuedAt: instant("2026-03-31T15:00:00Z"),
      completedAt: instant("2026-03-31T15:00:01Z"),
      committedAt: instant("2026-03-31T15:00:02Z"),
      request: {
        id: allocationScheduleRevisionId("workflow-termination"),
        kind: "termination" as const,
        effectiveOn: localDate("2026-03-31"),
        policyEffectiveAt: instant("2026-03-31T15:00:00Z"),
        generatedEffectKey: effectKey("workflow-terminate:journal:0"),
        originalScheduleId: scenario.successor,
        priorRecognitionIds: [
          allocationRecognitionId("workflow-successor-recognition-0"),
          allocationRecognitionId("workflow-successor-recognition-1"),
        ],
        policyId: revision.request.policyId,
        policyVersion: revision.request.policyVersion,
        revisedResidualValue: ExactRational.zero(),
        exactAdjustmentAmount: ExactRational.of(-10n, 1n),
        evidence: revision.request.evidence,
        derivation: revision.request.derivation,
      },
    });
    const before = await f.ledger.read();
    const oracle = executeBookCommand(
      before.aggregate.state,
      before.aggregate.protocol,
      termination,
    );
    expect(oracle.result.disposition, JSON.stringify(oracle.result.diagnostics)).toBe("committed");
    const receipt = await f.ledger.execute(termination);
    expect(receipt.result).toEqual(oracle.result);
    const after = await f.open().ledger.read();
    expect(encodeDurableBook(after.aggregate)).toBe(
      encodeDurableBook({ state: oracle.state, protocol: oracle.protocol }),
    );
    const terminal = workflowValue(
      after.aggregate.state.accountingState.allocationScheduleRevisions.at(-1),
    );
    expect(terminal.kind).toBe("termination");
    expect(terminal.carryingAmountAtRevision.toString()).toBe("10/1");
    const postedRemainder = after.aggregate.state.journals
      .flatMap(({ journal }) => journal.postings)
      .filter((p) => p.accountId === scenario.accounts.prepaid)
      .reduce((sum, p) => sum.add(p.bookValue.amount.toRational()), ExactRational.zero());
    // Explicit unresolved production counterexample. The derived schedule is
    // terminal, but its posted source account is NOT cleared by legacy semantics.
    expect(postedRemainder.toString()).toBe("1/100");
    expect((await f.open().ledger.execute(termination)).originalResult).toEqual(receipt.result);
    expect(await f.ledger.read()).toEqual(after);
  } finally {
    f.db.close();
  }
});

test("captured pre-repair allocation history retains every original receipt and exact durable byte", async () => {
  // Captured before introducing prospective allocation-plan arithmetic. Never
  // regenerate this evidence using a changed implementation or workflow fixture.
  const bytes = await Bun.file(
    new URL("./data/allocation-rounding-legacy.json", import.meta.url),
  ).text();
  expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(
    "b35b4d0477184ccc04b3b31baf6355f1ddb8d56953b8f474d5860dfe74ba4106",
  );
  const decoded = decodeDurableBook(bytes.trim());
  if (decoded.disposition !== "decoded") throw new Error(decoded.message);
  const original = decoded.aggregate;
  expect(original.protocol.retainedResults).toHaveLength(8);
  const initial = workflowValue(original.state.configurationSnapshots[0]);
  const f = fixture();
  try {
    await f.ledger.provision({
      state: createBookState(
        original.state.identity,
        initial.periods,
        initial.admissionSnapshot,
        initial.policies,
        initial.quantizationPolicies,
        initial.accountingPolicySnapshot.policies,
        initial.effectiveAt,
      ),
      protocol: createBookProtocolState(),
    });
    for (const retained of original.protocol.retainedResults) {
      expect((await f.ledger.execute(retained.command)).result.resultHash).toEqual(
        retained.resultHash,
      );
    }
    expect(encodeDurableBook((await f.open().ledger.read()).aggregate)).toBe(bytes.trim());
    for (const retained of original.protocol.retainedResults) {
      const retry = await f.open().ledger.execute(retained.command);
      expect(retry.result.disposition).toBe("replayed");
      expect(retry.originalResult?.resultHash).toEqual(retained.resultHash);
    }
    expect(encodeDurableBook((await f.ledger.read()).aggregate)).toBe(bytes.trim());
  } finally {
    f.db.close();
  }
});

test("cumulative schedule commands preserve posted basis through recognition, revision, termination and reopen", async () => {
  const scenario = allocationAndTaxWorkflow("1.1.0");
  const directory = mkdtempSync(join(tmpdir(), "rastrata-cumulative-owner-"));
  const path = join(directory, "book.sqlite");
  let f = fixture(path);
  try {
    await f.ledger.provision(scenario.initial);
    for (const command of scenario.commands) {
      const receipt = await f.open().ledger.execute(command);
      expect(receipt.result.disposition, JSON.stringify(receipt.result.diagnostics)).toBe(
        "committed",
      );
    }
    const before = await f.ledger.read();
    const amounts = before.aggregate.state.journals
      .slice(1, 4)
      .map(({ journal }) =>
        journal.postings.map((p) => p.bookValue.amount.toRational().toString()),
      );
    expect(amounts).toEqual([
      ["3333/100", "-3333/100"],
      ["1417/50", "-1417/50"],
      ["2833/100", "-2833/100"],
    ]);
    const revised = workflowValue(
      before.aggregate.state.accountingState.allocationScheduleRevisions[0],
    );
    expect(revised.recognizedToDate.toString()).toBe("100/3");
    expect(revised.postedRecognizedToDate?.toString()).toBe("3333/100");
    expect(revised.carryingAmountAtRevision.toString()).toBe("200/3");
    expect(revised.postedCarryingAmountAtRevision?.toString()).toBe("6667/100");
    const template = workflowValue(scenario.commands[4]);
    if (template.type !== "reviseAllocationSchedule") throw new Error("Expected revision");
    const terminate = sealCommand({
      ...template,
      id: commandId("cumulative-terminate"),
      expectedBookRevision: 8n,
      issuedAt: instant("2026-03-31T15:00:00Z"),
      completedAt: instant("2026-03-31T15:00:01Z"),
      committedAt: instant("2026-03-31T15:00:02Z"),
      request: {
        id: allocationScheduleRevisionId("cumulative-terminal"),
        kind: "termination" as const,
        effectiveOn: localDate("2026-03-31"),
        policyEffectiveAt: instant("2026-03-31T15:00:00Z"),
        originalScheduleId: scenario.successor,
        priorRecognitionIds: [
          allocationRecognitionId("workflow-successor-recognition-0"),
          allocationRecognitionId("workflow-successor-recognition-1"),
        ],
        policyId: template.request.policyId,
        policyVersion: template.request.policyVersion,
        revisedResidualValue: ExactRational.zero(),
        exactAdjustmentAmount: ExactRational.of(-10n, 1n),
        generatedEffectKey: effectKey("cumulative-terminate:journal:0"),
        evidence: template.request.evidence,
        derivation: template.request.derivation,
      },
    });
    const receipt = await f.ledger.execute(terminate);
    expect(receipt.result.disposition, JSON.stringify(receipt.result.diagnostics)).toBe(
      "committed",
    );
    const complete = await f.ledger.read();
    const balance = complete.aggregate.state.journals
      .flatMap(({ journal }) => journal.postings)
      .filter((p) => p.accountId === scenario.accounts.prepaid)
      .reduce((sum, p) => sum.add(p.bookValue.amount.toRational()), ExactRational.zero());
    expect(balance.toString()).toBe("0/1");
    expect(
      complete.aggregate.state.accountingState.allocationSchedules.every(
        (s) => s.postingPlan !== undefined,
      ),
    ).toBeTrue();
    f.db.close();
    f = fixture(path);
    expect(await f.ledger.read()).toEqual(complete);
    expect((await f.ledger.execute(terminate)).originalResult).toEqual(receipt.result);
    expect(await f.ledger.readAt(8n)).toEqual(before);
    const encoded = encodeDurableBook(complete.aggregate);
    const decoded = decodeDurableBook(encoded);
    if (decoded.disposition !== "decoded") throw new Error(decoded.message);
    expect(encodeDurableBook(decoded.aggregate)).toBe(encoded);
  } finally {
    f.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("successive cumulative estimate changes retain canonical source closure", async () => {
  const scenario = allocationAndTaxWorkflow("1.1.0");
  const f = fixture();
  try {
    await f.ledger.provision(scenario.initial);
    for (const command of scenario.commands.slice(0, 5))
      expect((await f.ledger.execute(command)).result.disposition).toBe("committed");
    const original = workflowValue(scenario.commands[4]);
    if (original.type !== "reviseAllocationSchedule") throw new Error("Expected revision");
    const command = sealCommand({
      ...original,
      id: commandId("cumulative-second-revision"),
      expectedBookRevision: 5n,
      issuedAt: instant("2026-02-01T15:00:00Z"),
      completedAt: instant("2026-02-01T15:00:01Z"),
      committedAt: instant("2026-02-01T15:00:02Z"),
      request: {
        ...original.request,
        id: allocationScheduleRevisionId("cumulative-second-revision"),
        originalScheduleId: scenario.successor,
        successorScheduleId: allocationScheduleId("cumulative-second-successor"),
        priorRecognitionIds: [],
        revisedResidualValue: ExactRational.of(20n, 1n),
      },
    });
    const receipt = await f.ledger.execute(command);
    expect(receipt.result.disposition, JSON.stringify(receipt.result.diagnostics)).toBe(
      "committed",
    );
    const current = await f.open().ledger.read();
    const successor = workflowValue(
      current.aggregate.state.accountingState.allocationSchedules.at(-1),
    );
    expect(successor.sourceBasis.toString()).toBe("6667/100");
    expect(successor.postingPlan?.installments.map((i) => i.postedAmount.coefficient)).toEqual([
      2334n,
      2333n,
    ]);
    expect((await f.ledger.execute(command)).originalResult).toEqual(receipt.result);
    expect(await f.ledger.read()).toEqual(current);
  } finally {
    f.db.close();
  }
});

test("indexed owner provisions atomically and preserves committed/rejected receipts through reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-indexed-owner-"));
  const path = join(directory, "book.sqlite");
  const f = fixture(path);
  await f.ledger.provision(genesis());
  await f.ledger.execute(activation());
  const sale = await f.ledger.execute(posting("business/α"));
  const rejected = await f.ledger.execute(posting("declined", 2n, false));
  expect(sale.result.disposition).toBe("committed");
  expect(rejected.result.disposition).toBe("rejected");
  const before = await f.ledger.read();
  expect((await f.control.readMetadata()).view.hotCount).toBe("7");
  expect(f.faults.maxDepth).toBe(1);
  f.db.close();
  const reopened = fixture(path);
  try {
    expect(await reopened.ledger.read()).toEqual(before);
    expect((await reopened.ledger.execute(posting("business/α"))).originalResult).toEqual(
      sale.result,
    );
    expect((await reopened.ledger.execute(posting("declined", 2n, false))).originalResult).toEqual(
      rejected.result,
    );
    const current = await reopened.ledger.read();
    expect(current.head.sequence).toBe("3");
    for (;;) {
      const result = await reopened.storage.maintain(2);
      if (result.cleanup.pinId === null) break;
    }
    expect(await reopened.ledger.read()).toEqual(current);
    expect(
      reopened.db.query("SELECT count(*) AS count FROM ledger_index_construction_locations").get(),
    ).toEqual({ count: 0 });
    expect((await reopened.ledger.readAt(1n)).head.sequence).toBe("1");
  } finally {
    reopened.db.close();
    rmSync(directory, { recursive: true });
  }
});

test("every provisioning component rolls back with canonical genesis on SQL failure", async () => {
  for (const sql of [
    "INSERT INTO ledger_metadata",
    "CREATE TABLE ledger_index_control",
    "CREATE TABLE ledger_index_construction_locations",
    "CREATE TABLE ledger_index_pages",
    "INSERT INTO ledger_index_allocation_state",
    "INSERT INTO ledger_indexed_owner",
  ]) {
    const f = fixture();
    try {
      f.faults.afterSql = sql;
      await expect(f.ledger.provision(genesis())).rejects.toThrow("injected owner SQL failure");
      expect(f.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
      f.faults.afterSql = "";
      expect((await f.ledger.provision(genesis())).sequence).toBe("0");
      expect(f.faults.maxDepth).toBe(1);
    } finally {
      f.db.close();
    }
  }
});

test("lost provisioning acknowledgement reopens the exact complete book without resetting indexes", async () => {
  const f = fixture();
  try {
    f.faults.loseAfterSql = "INSERT INTO ledger_indexed_owner";
    await expect(f.ledger.provision(genesis())).rejects.toThrow("lost owner durability response");
    const reopened = f.open();
    expect((await reopened.ledger.provision(genesis())).sequence).toBe("0");
    expect((await reopened.ledger.execute(activation())).result.disposition).toBe("committed");
    expect(f.db.query("SELECT count(*) AS count FROM ledger_indexed_owner").get()).toEqual({
      count: 1,
    });
  } finally {
    f.db.close();
  }
});

test("incremental retention failures cannot publish accounting and reopen retries exactly once", async () => {
  for (const mode of ["rollback", "lost-sync"] as const) {
    const f = fixture(":memory:", BOOK, true);
    try {
      await f.ledger.provision(genesis());
      await f.ledger.execute(activation());
      const before = await f.ledger.read();
      const view = (await f.control.readMetadata()).view;
      if (mode === "rollback") f.faults.afterSql = "INSERT INTO ledger_index_roots";
      else f.faults.loseAfterSql = "INSERT INTO ledger_index_roots";
      const command = posting(`retention-${mode}`);
      await expect(f.ledger.execute(command)).rejects.toThrow(
        mode === "rollback" ? "injected owner SQL failure" : "lost owner durability response",
      );
      f.faults.afterSql = "";
      const reopened = f.open();
      expect(await reopened.ledger.read()).toEqual(before);
      expect((await f.control.readMetadata()).view).toEqual(view);
      await assertGroupDirectory(f, before);
      const result = await reopened.ledger.execute(command);
      expect(result.result.disposition).toBe("committed");
      expect((await reopened.ledger.execute(command)).originalResult).toEqual(result.result);
      const after = await f.open().ledger.read();
      const expected = executeBookCommand(
        before.aggregate.state,
        before.aggregate.protocol,
        command,
      );
      expect(encodeDurableBook(after.aggregate)).toBe(
        encodeDurableBook({ state: expected.state, protocol: expected.protocol }),
      );
      expect(after.head.sequence).toBe("2");
      await assertGroupDirectory(f, after);
    } finally {
      f.db.close();
    }
  }
});

test("canonical publication, root selection and pin consumption roll back together under the real owner", async () => {
  for (const sql of [
    "INSERT INTO ledger_outcomes",
    "INSERT INTO ledger_chunks",
    "UPDATE ledger_metadata SET head",
    "UPDATE ledger_index_control",
    "INSERT INTO ledger_index_construction_cleanup",
    "DELETE FROM ledger_index_pins",
  ]) {
    const f = fixture();
    try {
      await f.ledger.provision(genesis());
      await f.ledger.execute(activation());
      const before = await f.ledger.read();
      f.faults.onlyPublication = true;
      f.faults.afterSql = sql;
      await expect(f.ledger.execute(posting("sale"))).rejects.toThrow("injected owner SQL failure");
      expect(f.faults.publicationFaults).toBe(1);
      f.faults.afterSql = "";
      expect(await f.ledger.read()).toEqual(before);
      expect((await f.ledger.execute(posting("sale"))).result.disposition).toBe("committed");
      expect((await f.ledger.read()).head.sequence).toBe("2");
      expect(f.faults.maxDepth).toBe(1);
    } finally {
      f.db.close();
    }
  }
});

test("uncertain shared publication returns no receipt and retry preserves the exact original result", async () => {
  const f = fixture();
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    f.faults.loseAfterSql = "UPDATE ledger_index_control";
    await expect(f.ledger.execute(posting("sale"))).rejects.toThrow(
      "lost owner durability response",
    );
    const retry = await f.ledger.execute(posting("sale"));
    expect(retry.result.disposition).toBe("replayed");
    expect(retry.originalResult?.disposition).toBe("committed");
    expect(retry.outcomeSequence).toBe(2n);
    expect((await f.control.readMetadata()).view.hotCount).toBe("6");
    expect(f.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({ count: 2 });
  } finally {
    f.db.close();
  }
});

test("independent owners serialize duplicate and conflicting commands without duplicate financial effects", async () => {
  for (const duplicate of [true, false]) {
    const f = fixture();
    try {
      await f.ledger.provision(genesis());
      await f.ledger.execute(activation());
      const second = f.open();
      const receipts = await Promise.all([
        f.ledger.execute(posting("race")),
        second.ledger.execute(posting(duplicate ? "race" : "racer")),
      ]);
      expect(receipts.map((receipt) => receipt.result.disposition).sort()).toEqual(
        duplicate ? ["committed", "replayed"] : ["committed", "rejected"],
      );
      expect((await f.ledger.read()).head.sequence).toBe(duplicate ? "2" : "3");
      expect((await f.ledger.read()).head.bookRevision).toBe("2");
    } finally {
      f.db.close();
    }
  }
});

test("missing or substituted selected pages cannot be treated as identity absence, including historical reads", async () => {
  const f = fixture();
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    await f.ledger.execute(posting("sale"));
    const current = await f.control.readMetadata();
    const root = await f.pages.readRootDescriptor(current.view.hotRoot);
    if (!root?.page) throw new Error("Missing fixture root");
    f.db.query("DELETE FROM ledger_index_pages WHERE location = ?").run(root.page.location);
    await expect(f.ledger.readAt(0n)).rejects.toThrow("index_page_missing_or_short");
    await expect(f.ledger.execute(posting("new", 2n))).rejects.toThrow(
      "index_page_missing_or_short",
    );
    expect(f.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({ count: 2 });
  } finally {
    f.db.close();
  }
});

test("a bare canonical compact book cannot be silently adopted by the indexed owner", async () => {
  const f = fixture();
  try {
    const bare = new ProductionLedger(
      new SqliteBookStorage(f.scope.objectId, f.port),
      f.scope,
      COMPACT_LEDGER_FORMAT,
    );
    await bare.provision(genesis());
    await expect(f.ledger.provision(genesis())).rejects.toThrow();
    expect((await bare.read()).head.sequence).toBe("0");
    expect(
      f.db.query("SELECT name FROM sqlite_master WHERE name = 'ledger_indexed_owner'").all(),
    ).toEqual([]);
  } finally {
    f.db.close();
  }
});

test("expired construction, pending authority and regressed time cannot publish through the owner", async () => {
  const f = fixture();
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    f.faults.expireAfterAllocation = true;
    await expect(f.ledger.execute(posting("sale"))).rejects.toThrow("index_pin_expired");
    expect((await f.ledger.read()).head.sequence).toBe("1");
    f.faults.pending = true;
    await expect(f.ledger.execute(posting("sale"))).rejects.toThrow("index_pin_view_conflict");
    f.faults.pending = false;
    f.faults.now--;
    await expect(f.ledger.execute(posting("sale"))).rejects.toThrow("index_pin_clock_regressed");
    f.faults.now++;
    expect((await f.ledger.execute(posting("sale"))).result.disposition).toBe("committed");
    expect((await f.ledger.read()).head.sequence).toBe("2");
  } finally {
    f.db.close();
  }
});

test("source admission replays a structurally valid forged result before allocating pages", async () => {
  const f = fixture();
  try {
    await f.ledger.provision(genesis());
    await f.ledger.execute(activation());
    const before = await f.ledger.read();
    const evaluated = evaluateOutcomePayload(before.aggregate, posting("sale"));
    if (!evaluated.encoded) throw new Error("Missing outcome");
    const decoded = decodeBookOutcome(evaluated.encoded);
    if (decoded.disposition !== "decoded") throw new Error(decoded.message);
    const forged = encodeBookOutcome({
      ...decoded.payload,
      originalResult: { ...decoded.payload.originalResult, resultHash: hashCanonical("forged") },
    });
    const record = compactOutcomeRecord(f.scope, before.head, evaluated.transition, forged);
    const allocation = f.db.query("SELECT * FROM ledger_index_allocation_state").get();
    await expect(f.storage.commitTransition(before.head, record)).rejects.toThrow(
      "recovery_outcome_mismatch",
    );
    expect(f.db.query("SELECT * FROM ledger_index_allocation_state").get()).toEqual(allocation);
    await expect(f.storage.commitTransition(before.head, record)).rejects.toThrow(
      "indexed_recovery_required",
    );
    expect(await f.ledger.read()).toEqual(before);
  } finally {
    f.db.close();
  }
});

test("invalid cleanup budgets and foreign owner identity fail before data mutation", async () => {
  const f = fixture();
  try {
    await f.ledger.provision(genesis());
    const pins = f.db.query("SELECT * FROM ledger_index_pin_state").get();
    for (const limit of [0, -1, 257, 1.5, Number.NaN])
      await expect(f.storage.maintain(limit)).rejects.toThrow("index_construction_batch_invalid");
    expect(f.db.query("SELECT * FROM ledger_index_pin_state").get()).toEqual(pins);
    const foreign = new SqliteIndexedBookStorage(
      f.scope.objectId,
      f.port,
      { ...f.scope, tenantId: "foreign" },
      () => ({ fence: "0", pending: false }),
      () => 10n,
    );
    await expect(foreign.sync()).rejects.toThrow("indexed_owner_mismatch");
    expect(
      () =>
        new SqliteIndexedBookStorage(
          "different-object",
          f.port,
          f.scope,
          () => ({ fence: "0", pending: false }),
          () => 10n,
        ),
    ).toThrow("ledger_identity_mismatch");
    expect((await f.ledger.read()).head.sequence).toBe("0");
  } finally {
    f.db.close();
  }
});

test("indexed owner refuses a required canonical source corrupted after verification but before identity resolution", async () => {
  const decoded = decodeDurableBook(
    (
      await Bun.file(
        new URL("../../kernel/test/data/inventory-adjustment-legacy.json", import.meta.url),
      ).text()
    ).trim(),
  );
  if (decoded.disposition !== "decoded") throw new Error(decoded.message);
  const original = decoded.aggregate;
  const config = original.state.configurationSnapshots[0];
  if (!config) throw new Error("Missing inventory configuration");
  const f = fixture(":memory:", original.state.identity.bookId);
  try {
    await f.ledger.provision({
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
    });
    for (const retained of original.protocol.retainedResults.slice(0, 2))
      expect((await f.ledger.execute(retained.command)).result.resultHash).toEqual(
        retained.resultHash,
      );
    const command = original.protocol.retainedResults[2];
    if (!command) throw new Error("Missing inventory continuation");
    const saved = f.db
      .query("SELECT bytes, digest FROM ledger_chunks WHERE record_id = '2' AND ordinal = 0")
      .get() as { bytes: Uint8Array; digest: string };
    const exec = f.port.sql.exec.bind(f.port.sql);
    let injected = false;
    let sourceReads = 0;
    f.port.sql.exec = (sql, ...bindings) => {
      const rows = exec(sql, ...bindings);
      if (sql.includes("FROM ledger_outcomes WHERE sequence =")) sourceReads++;
      if (
        !injected &&
        sql.startsWith("INSERT INTO ledger_index_pins") &&
        typeof bindings[3] === "string" &&
        JSON.parse(bindings[3]).kind === "construction"
      ) {
        injected = true;
        f.db
          .query("UPDATE ledger_chunks SET bytes = x'00' WHERE record_id = '2' AND ordinal = 0")
          .run();
      }
      return rows;
    };
    await expect(f.ledger.execute(command.command)).rejects.toThrow("recovery_record_corrupt");
    expect(injected).toBe(true);
    expect(sourceReads).toBe(1);
    expect(f.db.query("SELECT COUNT(*) AS n FROM ledger_outcomes").get()).toEqual({ n: 2 });
    f.port.sql.exec = exec;
    f.db
      .query("UPDATE ledger_chunks SET bytes = ?, digest = ? WHERE record_id = '2' AND ordinal = 0")
      .run(saved.bytes, saved.digest);
    expect((await f.ledger.execute(command.command)).result.resultHash).toEqual(command.resultHash);
    expect((await f.ledger.read()).head.sequence).toBe("3");
  } finally {
    f.db.close();
  }
});

test("cold partition identities resolve to original outcomes while new inventory identities enter the hot tail", async () => {
  const raw = (
    await Bun.file(
      new URL("../../kernel/test/data/inventory-adjustment-legacy.json", import.meta.url),
    ).text()
  ).trim();
  const decoded = decodeDurableBook(raw);
  if (decoded.disposition !== "decoded") throw new Error(decoded.message);
  const original = decoded.aggregate,
    config = original.state.configurationSnapshots[0];
  if (!config) throw new Error("Missing inventory configuration");
  const initial: DurableBookAggregate = {
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
  const f = fixture(":memory:", original.state.identity.bookId);
  try {
    await f.ledger.provision(initial);
    for (const [i, retained] of original.protocol.retainedResults.entries()) {
      expect((await f.ledger.execute(retained.command)).result.resultHash).toEqual(
        retained.resultHash,
      );
      if (i === 1) {
        const current = await f.control.readMetadata();
        const frozen = await f.control.freeze(current.view, "test-verified-prefix");
        if (!frozen.frozen) throw new Error("Missing prefix");
        // First promotion: the independently audited complete hot population is
        // exactly the new cold prefix; both logical stores share these page bytes.
        await f.control.install(
          frozen.view,
          frozen.frozen,
          current.view.hotRoot,
          createIndexRoot(0n, null).contentHash,
          "0",
        );
        expect((await f.ledger.read()).head.sequence).toBe("2");
      }
    }
    const current = await f.control.readMetadata();
    expect(current.view.coldCount).toBe("8");
    expect(current.view.hotCount).toBe("7");
    expect(encodeDurableBook((await f.ledger.read()).aggregate)).toBe(raw);
    const root = await f.pages.readRootDescriptor(current.view.coldRoot);
    if (!root) throw new Error("Missing cold root");
    const key = identityIndexKey({
      bookId: f.scope.bookId,
      family: "lotHolding",
      id: "audit-lot-a",
    });
    expect(
      (await lookupIndexEntry(root, root.contentHash, key, (id) => f.pages.read(id))).sequence,
    ).toBe(2n);
    const prior = original.protocol.retainedResults[1];
    if (!prior) throw new Error("Missing original command");
    expect((await f.ledger.execute(prior.command)).originalResult?.resultHash).toEqual(
      prior.resultHash,
    );
  } finally {
    f.db.close();
  }
});

test("atomic initialization ports require a live same-store transaction and owner markers reject NUL suffixes", async () => {
  const f = fixture();
  try {
    await f.ledger.provision(genesis());
    const canonical = new SqliteBookStorage(f.scope.objectId, f.port);
    const book = canonical.load(f.scope);
    if (!book) throw new Error("Missing fixture book");
    const token = {} as SqliteTransaction;
    expect(() => canonical.provisionInTransaction(token, book)).toThrow(
      "sqlite_transaction_not_active",
    );
    expect(() => f.control.initializeInTransaction(token, "schema")).toThrow(
      "sqlite_transaction_not_active",
    );
    expect(() => f.pages.initializeInTransaction(token, "allocated")).toThrow(
      "sqlite_transaction_not_active",
    );
    const row = f.db.query("SELECT format, identity_hash FROM ledger_indexed_owner").get() as {
      format: string;
      identity_hash: string;
    };
    f.db
      .query("UPDATE ledger_indexed_owner SET identity_hash = ?")
      .run(`${row.identity_hash}\u0000`);
    await expect(f.storage.sync()).rejects.toThrow("indexed_owner_mismatch");
    f.db
      .query("UPDATE ledger_indexed_owner SET identity_hash = ?, format = ?")
      .run(row.identity_hash, `${row.format}\u0000`);
    await expect(f.storage.sync()).rejects.toThrow("indexed_owner_mismatch");
    expect(f.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({ count: 0 });
  } finally {
    f.db.close();
  }
});

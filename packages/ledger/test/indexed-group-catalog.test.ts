import { expect, test } from "bun:test";
import {
  encodeBookRow,
  hashCanonical,
  commandId,
  closePackageId,
  instant,
  sealCommand,
  type BookRowTypes,
} from "@rastrata/kernel";
import { indexedCollectionDomain } from "../src/indexed-book-state.ts";
import { INDEXED_GROUP_CATALOG_FORMAT, SqliteSemanticGroupCatalog } from "../src/group-catalog.ts";
import { indexBookIdentityCommitment } from "../src/index-view-audit.ts";
import {
  SEMANTIC_GROUP_COLLECTIONS,
  type SemanticGroupKey,
  type SemanticGroupCollection,
} from "../src/semantic-groups.ts";
import { atomicSqlite, type SqliteTransaction } from "../src/sqlite-transaction.ts";
import { createIndexedOwnerFixture } from "./indexed-owner-fixture.ts";
import {
  admissionFxWorkflow,
  allocationAndTaxWorkflow,
  lotIdentityWorkflow,
  workflowValue,
} from "./accounting-workflows.ts";
import { commercialWorkflow } from "./commercial-workflow.ts";
import { activation, genesis, posting } from "./fixtures.ts";
import type { CapturedRow } from "../src/source-catalog.ts";

type Fixture = Awaited<ReturnType<typeof createIndexedOwnerFixture>>;
const fixture = (initial = genesis(), fault = "") =>
  createIndexedOwnerFixture(initial, fault, true);
const hex = (ordinal: bigint) => ordinal.toString(16).padStart(64, "0");

/** Independent full accounting-state oracle: do not call the production group
 * projector/delta builder, or use group output as the expected population. */
async function verifyGroups(f: Fixture, known = new Map<string, SemanticGroupKey>()) {
  const expected = new Map<string, { key: string; value: string }[]>();
  function add<C extends SemanticGroupCollection>(
    collection: C,
    row: BookRowTypes[C],
    index: number,
    kind: SemanticGroupKey["kind"],
    values: string[],
  ) {
    const key = { kind, values },
      id = JSON.stringify(key);
    known.set(id, key);
    const entries = expected.get(id) ?? [];
    entries.push({
      key: hex(BigInt(index) + 1n),
      value: hashCanonical({
        domain: indexedCollectionDomain(f.aggregate.state.financialIdentityHash, collection),
        ordinal: BigInt(index) + 1n,
        encoded: encodeBookRow(collection, row),
      }).digest,
    });
    expected.set(id, entries);
  }
  const state = f.aggregate.state;
  state.lotHoldings.forEach((row, i) => {
    add("state.lotHoldings", row, i, "holdingsByLot", [row.lotId]);
    add("state.lotHoldings", row, i, "holdingsByAccount", [row.accountId]);
    if (!row.remainingQuantity.isZero())
      add("state.lotHoldings", row, i, "nonzeroHoldingsByAccountCommodity", [
        row.accountId,
        row.commodityId,
      ]);
  });
  state.accountingState.allocationRecognitions.forEach((row, i) => {
    add("state.accountingState.allocationRecognitions", row, i, "recognitionsBySchedule", [
      row.scheduleId,
    ]);
  });
  state.periodTransitions.forEach((row, i) => {
    add("state.periodTransitions", row, i, "transitionsByPeriod", [row.periodId]);
  });
  state.accountingState.remeasurementResults.forEach((row, i) => {
    if (row.kind === "unrealized")
      add("state.accountingState.remeasurementResults", row, i, "unrealizedByPolicy", [
        row.policyId,
      ]);
  });
  state.accountingState.remeasurementReversals.forEach((row, i) => {
    add("state.accountingState.remeasurementReversals", row, i, "reversalsByOriginalResult", [
      row.originalResultId,
    ]);
  });
  for (const kind of Object.keys(SEMANTIC_GROUP_COLLECTIONS) as SemanticGroupKey["kind"][]) {
    const key = {
      kind,
      values:
        kind === "journalsByMoneyScope" || kind === "inventoryRevisionsByMoneyScope"
          ? ["missing", "missing", "missing"]
          : kind === "nonzeroHoldingsByAccountCommodity"
            ? ["missing", "missing"]
            : ["missing"],
    };
    known.set(JSON.stringify(key), key);
  }
  const capture = f.groups.capture(f.readAnchor().head.contentHash, f.groupDigest);
  const source = f.catalog.capture(f.digest);
  try {
    for (const [id, key] of known) {
      const collection = SEMANTIC_GROUP_COLLECTIONS[key.kind];
      const domain = indexedCollectionDomain(state.financialIdentityHash, collection);
      if (collection === "state.revisions" || collection === "state.journals") {
        // This fixture deliberately retains the seven-predicate profile. A newly
        // known query kind must not turn missing coverage into proven absence.
        await expect(
          f.groups.readMembers(capture, domain, key, null, 1, f.ports.confirm),
        ).rejects.toThrow("group_query_profile_unsupported");
        await expect(
          f.groups.readLastMember(capture, domain, key, f.ports.confirm),
        ).rejects.toThrow("group_query_profile_unsupported");
        if (key.kind === "journalsByMoneyScope")
          await expect(
            f.groups.readPostedBalance(capture, domain, key, f.ports.confirm),
          ).rejects.toThrow("group_query_profile_unsupported");
        continue;
      }
      const wanted = expected.get(id) ?? [],
        actual: { key: string; value: string }[] = [];
      let cursor: string | null = null;
      do {
        const page = await f.groups.readMembers(capture, domain, key, cursor, 1, f.ports.confirm);
        expect(page.population).toBe(BigInt(wanted.length));
        expect(page.complete).toBe(page.nextFromInclusive === null);
        for (const entry of page.entries) {
          const row = await f.catalog.read(source, collection, BigInt(`0x${entry.key}`), f.ports);
          expect(row.disposition).toBe("present");
          expect(row.rowHash).toBe(entry.value);
          actual.push({ key: entry.key, value: entry.value });
        }
        expect(actual.length).toBeLessThanOrEqual(wanted.length);
        cursor = page.nextFromInclusive;
      } while (cursor !== null);
      expect(actual).toEqual(wanted);
    }
  } finally {
    f.groups.release(capture);
    f.catalog.release(source);
  }
  return known;
}

test("indexed groups match independent accounting populations after every real workflow command", async () => {
  const fx = admissionFxWorkflow(false);
  const kinds = new Set<string>();
  for (const scenario of [
    commercialWorkflow(),
    lotIdentityWorkflow(),
    allocationAndTaxWorkflow("1.1.0"),
    { initial: fx.initial, commands: [...fx.commands, fx.reverse(fx.firstMeasurement, 5n)] },
  ]) {
    const f = await fixture(scenario.initial);
    try {
      const known = await verifyGroups(f);
      for (const command of scenario.commands) {
        const before = f.dump(),
          plan = await f.prepare(command);
        expect(f.dump()).toEqual(before);
        f.select(plan);
        expect(f.aggregate.protocol.retainedResults.at(-1)?.outcome).toBe("committed");
        await verifyGroups(f, known);
      }
      for (const key of known.values()) if (!key.values.includes("missing")) kinds.add(key.kind);
      const before = f.dump();
      f.restart();
      await verifyGroups(f, known);
      expect(f.dump()).toEqual(before);
      expect(f.faults.syncs).toBe(0);
      expect(
        f.db.query("SELECT name FROM sqlite_master WHERE name LIKE 'ledger_group_%'").all(),
      ).toEqual([]);
    } finally {
      f.close();
    }
  }
  expect([...kinds].sort()).toEqual([
    "holdingsByAccount",
    "holdingsByLot",
    "nonzeroHoldingsByAccountCommodity",
    "recognitionsBySchedule",
    "reversalsByOriginalResult",
    "unrealizedByPolicy",
  ]);
});

test("indexed period groups retain both close and reopen; rejected commands preserve membership roots", async () => {
  const f = await fixture(),
    base = posting(),
    periodId = workflowValue(f.aggregate.state.periods[0]).id;
  const core = {
    bookId: base.bookId,
    actorId: base.actorId,
    protocolVersion: base.protocolVersion,
    issuedAt: instant("2026-02-01T00:00:00Z"),
    completedAt: instant("2026-02-01T00:00:01Z"),
    committedAt: instant("2026-02-01T00:00:02Z"),
  };
  try {
    await f.publish(activation());
    const known = await verifyGroups(f);
    for (const command of [
      sealCommand({
        ...core,
        id: commandId("group-close"),
        type: "closePeriod",
        expectedBookRevision: 1n,
        periodId,
        closePackageId: closePackageId("group-close"),
        reason: "Test close",
        reportPopulationHash: hashCanonical("report"),
        reportingPolicySnapshotHash: hashCanonical("policy"),
      }),
      sealCommand({
        ...core,
        id: commandId("group-reopen"),
        type: "reopenPeriod",
        expectedBookRevision: 2n,
        periodId,
        reason: "Test reopen",
      }),
    ]) {
      await f.publish(command);
      expect(f.aggregate.protocol.retainedResults.at(-1)?.outcome).toBe("committed");
      await verifyGroups(f, known);
    }
    const metadata = () =>
      JSON.parse(
        (f.db.query("SELECT body FROM ledger_indexed_group_catalog").get() as { body: string })
          .body,
      );
    const before = metadata();
    await f.publish(posting("group-stale", 0n));
    expect(f.aggregate.protocol.retainedResults.at(-1)?.outcome).toBe("rejected");
    expect(metadata().root).toBe(before.root);
    expect(metadata().headHash).not.toBe(before.headHash);
    expect(metadata().sourceCatalogDigest).not.toBe(before.sourceCatalogDigest);
    await verifyGroups(f, known);
  } finally {
    f.close();
  }
});

test("indexed source, group and canonical writes roll back together and retry the same prepared handles", async () => {
  const scenario = lotIdentityWorkflow();
  for (const fault of [
    "INSERT INTO test_outcome",
    "UPDATE test_canonical",
    "INSERT INTO ledger_indexed_source_nodes",
    "UPDATE ledger_indexed_source_catalog",
    "INSERT INTO ledger_indexed_group_nodes",
    "INSERT INTO ledger_indexed_group_descriptors",
    "UPDATE ledger_indexed_group_catalog",
    "after-group",
  ]) {
    const f = await fixture(scenario.initial);
    try {
      await f.publish(workflowValue(scenario.commands[0]));
      const plan = await f.prepare(workflowValue(scenario.commands[1])),
        before = f.dump();
      f.faults.afterSql = fault === "after-group" ? "" : fault;
      expect(() =>
        f.select(plan, () => {
          if (fault === "after-group") throw new Error("after-group");
        }),
      ).toThrow();
      expect(f.dump()).toEqual(before);
      f.faults.afterSql = "";
      f.select(plan);
      await verifyGroups(f);
      expect(() => f.select(plan)).toThrow("canonical CAS conflict");
    } finally {
      f.close();
    }
  }
});

test("indexed group genesis DDL and publication are rollback-retry safe", async () => {
  for (const fault of [
    "CREATE TABLE ledger_indexed_group_catalog",
    "CREATE TABLE ledger_indexed_group_nodes",
    "CREATE TABLE ledger_indexed_group_descriptors",
    "INSERT INTO ledger_indexed_group_catalog",
  ]) {
    const f = await fixture(genesis(), fault);
    try {
      const before = f.dump();
      expect(f.installGenesis).toThrow("injected SQL failure");
      expect(f.dump()).toEqual(before);
      f.faults.afterSql = "";
      f.installGenesis();
      await verifyGroups(f);
    } finally {
      f.close();
    }
  }
});

test("indexed group handles are instance-bound, require the source publication and reject legacy APIs", async () => {
  const f = await fixture(),
    other = await fixture();
  try {
    const plan = await f.prepare(activation());
    expect(plan.preparedGroup).toBeDefined();
    const prepared = workflowValue(plan.preparedGroup);
    const before = f.dump();
    expect(() => f.groups.publishInTransaction({} as SqliteTransaction, prepared)).toThrow();
    expect(() =>
      atomicSqlite(f.storage, (tx) =>
        f.groups.publishInTransaction(tx, { digest: prepared.digest }),
      ),
    ).toThrow("group_catalog_unprepared");
    expect(() =>
      atomicSqlite(other.storage, (tx) => f.groups.publishInTransaction(tx, prepared)),
    ).toThrow();
    const spoofedAnchor = () => ({
      identityHash: indexBookIdentityCommitment(f.scope),
      headHash: plan.record.after.contentHash,
      sourceCatalogDigest: plan.prepared.digest,
    });
    const groups = new SqliteSemanticGroupCatalog(
      f.storage,
      indexBookIdentityCommitment(f.scope),
      spoofedAnchor,
      INDEXED_GROUP_CATALOG_FORMAT,
    );
    const handle = await groups.prepareIndexed(f.catalog, plan.prepared, f.groupDigest, {
      confirm: f.ports.confirm,
      readPrevious: async () => {
        throw new Error("no old group rows");
      },
    });
    // A matching caller-supplied head/digest alone must not authorize publication.
    expect(() =>
      atomicSqlite(f.storage, (tx) => groups.publishInTransaction(tx, handle)),
    ).toThrow();
    expect(f.dump()).toEqual(before);
    await expect(
      f.groups.prepare(null, f.aggregate, f.readAnchor().head.contentHash),
    ).rejects.toThrow("group_catalog_profile_invalid");
    await expect(f.groups.verify(f.aggregate, f.readAnchor().head.contentHash)).rejects.toThrow(
      "group_catalog_profile_invalid",
    );
    await expect(
      f.groups.prepareIndexed(f.catalog, { digest: plan.prepared.digest }, f.groupDigest, {
        confirm: f.ports.confirm,
        readPrevious: async () => {
          throw new Error("no rows");
        },
      }),
    ).rejects.toThrow();
    f.select(plan);
    expect(() => f.catalog.describePrepared(plan.prepared)).toThrow();
    await verifyGroups(f);
  } finally {
    f.close();
    other.close();
  }
});

test("indexed group preparation authenticates old row scope, content and the owner pin", async () => {
  const scenario = lotIdentityWorkflow(),
    f = await fixture(scenario.initial);
  try {
    await f.publish(workflowValue(scenario.commands[0]));
    await f.publish(workflowValue(scenario.commands[1]));
    await f.publish(workflowValue(scenario.commands[2]));
    const plan = await f.prepare(workflowValue(scenario.commands[3]));
    const source = f.catalog.capture(f.digest),
      before = f.dump();
    const read = (collection: SemanticGroupCollection, ordinal: bigint) =>
      f.catalog.read(source, collection, ordinal, f.ports);
    for (const alter of [
      (row: CapturedRow) => ({ ...row, disposition: "absent" as const }),
      (row: CapturedRow) => ({ ...row, encoded: null }),
      (row: CapturedRow) => ({ ...row, encoded: "[]" }),
      (row: CapturedRow) => ({ ...row, rowHash: "0".repeat(64) }),
      (row: CapturedRow) => ({ ...row, catalogDigest: "0".repeat(64) }),
      (row: CapturedRow) => ({ ...row, headHash: "0".repeat(64) }),
      (row: CapturedRow) => ({ ...row, collection: "state.periodTransitions" as const }),
      (row: CapturedRow) => ({ ...row, ordinal: row.ordinal + 1n }),
    ]) {
      let reads = 0;
      await expect(
        f.groups.prepareIndexed(f.catalog, plan.prepared, f.groupDigest, {
          confirm: f.ports.confirm,
          readPrevious: async (collection, ordinal) => {
            reads++;
            return alter(await read(collection, ordinal));
          },
        }),
      ).rejects.toThrow();
      expect(reads).toBeGreaterThan(0);
      expect(f.dump()).toEqual(before);
    }
    let confirmations = 0;
    await expect(
      f.groups.prepareIndexed(f.catalog, plan.prepared, f.groupDigest, {
        confirm: async () => {
          if (++confirmations === 2) throw new Error("revoked after reads");
        },
        readPrevious: read,
      }),
    ).rejects.toThrow("revoked after reads");
    expect(f.dump()).toEqual(before);
    f.catalog.release(source);
    f.select(plan);
    await verifyGroups(f);
  } finally {
    f.close();
  }
});

test("indexed group publication rejects a source candidate committed in a separate transaction", async () => {
  const f = await fixture();
  try {
    const plan = await f.prepare(activation());
    // Deliberately incorrect owner: commit only canonical/source data. Equal
    // current bytes must not let a later transaction masquerade as atomicity.
    atomicSqlite(f.storage, (tx) => {
      f.storage.sql.exec(
        "INSERT INTO test_outcome VALUES (?, ?, ?)",
        plan.record.after.sequence,
        plan.encoded,
        JSON.stringify(plan.authority),
      );
      f.storage.sql.exec(
        "UPDATE test_canonical SET body = ? WHERE singleton = 1",
        JSON.stringify({
          genesisHash: f.readAnchor().genesisHash,
          state: JSON.parse(plan.record.state),
          head: plan.record.after,
        }),
      );
      f.catalog.publishInTransaction(tx, plan.prepared);
    });
    const before = f.dump();
    expect(() =>
      atomicSqlite(f.storage, (tx) =>
        f.groups.publishInTransaction(tx, workflowValue(plan.preparedGroup)),
      ),
    ).toThrow("indexed_source_publication_transaction_mismatch");
    expect(f.dump()).toEqual(before);
  } finally {
    f.close();
  }
});

test("indexed group preparation refuses a publication that races its authenticated reads", async () => {
  const scenario = lotIdentityWorkflow(),
    f = await fixture(scenario.initial);
  try {
    await f.publish(workflowValue(scenario.commands[0]));
    await f.publish(workflowValue(scenario.commands[1]));
    await f.publish(workflowValue(scenario.commands[2]));
    const plan = await f.prepare(workflowValue(scenario.commands[3])),
      source = f.catalog.capture(f.digest);
    let published = false;
    await expect(
      f.groups.prepareIndexed(f.catalog, plan.prepared, f.groupDigest, {
        confirm: f.ports.confirm,
        readPrevious: async (collection, ordinal) => {
          const row = await f.catalog.read(source, collection, ordinal, f.ports);
          if (!published) {
            published = true;
            f.select(plan);
          }
          return row;
        },
      }),
    ).rejects.toThrow();
    expect(published).toBe(true);
    f.catalog.release(source);
    await verifyGroups(f);
  } finally {
    f.close();
  }
});

test("post-group-write head, source or group substitution rolls all components back", async () => {
  for (const kind of ["head", "source", "group"] as const) {
    const f = await fixture();
    try {
      await f.publish(activation());
      const plan = await f.prepare(posting("group-substitution", 1n));
      const statement =
        kind === "head"
          ? "UPDATE test_canonical SET body = '{}'"
          : kind === "source"
            ? "UPDATE ledger_indexed_source_catalog SET digest = 'bad'"
            : "UPDATE ledger_indexed_group_catalog SET body = OLD.body, digest = OLD.digest";
      f.db.exec(
        `CREATE TRIGGER test_substitute AFTER UPDATE ON ledger_indexed_group_catalog BEGIN ${statement}; END`,
      );
      const before = f.dump();
      expect(() => f.select(plan)).toThrow();
      expect(f.dump()).toEqual(before);
      f.db.exec("DROP TRIGGER test_substitute");
      f.select(plan);
      await verifyGroups(f);
    } finally {
      f.close();
    }
  }
});

test("indexed group readers reject damaged paths, stale captures and revoked pins", async () => {
  const scenario = lotIdentityWorkflow(),
    f = await fixture(scenario.initial);
  try {
    await f.publish(workflowValue(scenario.commands[0]));
    await f.publish(workflowValue(scenario.commands[1]));
    const capture = f.groups.capture(f.readAnchor().head.contentHash, f.groupDigest);
    const holding = workflowValue(f.aggregate.state.lotHoldings[0]);
    const key: SemanticGroupKey = { kind: "holdingsByLot", values: [holding.lotId] };
    const domain = indexedCollectionDomain(
      f.aggregate.state.financialIdentityHash,
      "state.lotHoldings",
    );
    const query = () => f.groups.readMembers(capture, domain, key, null, 1, f.ports.confirm);
    expect((await query()).population).toBeGreaterThan(0n);
    for (const table of [
      "ledger_indexed_group_nodes",
      "ledger_indexed_group_descriptors",
    ] as const) {
      const rows = f.db.query(`SELECT digest, body FROM ${table}`).all() as {
        digest: string;
        body: string;
      }[];
      expect(rows.length).toBeGreaterThan(0);
      f.db.exec(`UPDATE ${table} SET body = '{}'`);
      await expect(query()).rejects.toThrow();
      for (const row of rows)
        f.db.query(`UPDATE ${table} SET body = ? WHERE digest = ?`).run(row.body, row.digest);
      expect((await query()).population).toBeGreaterThan(0n);
    }
    f.faults.deny = true;
    await expect(query()).rejects.toThrow("owner pin revoked");
    f.faults.deny = false;
    await f.publish(workflowValue(scenario.commands[2]));
    await expect(query()).rejects.toThrow("group_catalog_conflict");
    f.groups.release(capture);
    await expect(query()).rejects.toThrow();
    await verifyGroups(f);
  } finally {
    f.close();
  }
});

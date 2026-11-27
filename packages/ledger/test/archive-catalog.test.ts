import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { encodeDurableBook, hashCanonical } from "@rastrata/kernel";
import { SqliteArchiveCatalog } from "../src/archive-catalog.ts";
import { SqliteArchiveSelection } from "../src/archive-selection.ts";
import { ArchiveLedger } from "../src/archive-ledger.ts";
import { ProductionLedger } from "../src/ledger.ts";
import { COMPACT_LEDGER_FORMAT, LedgerError } from "../src/records.ts";
import { prepareArchiveRestoreImage } from "../src/archive-restore.ts";
import { atomicSqlite } from "../src/sqlite-transaction.ts";
import { SqliteBookStorage, type SqliteStorage } from "../src/sqlite.ts";
import { R2ArchiveObjectStore, referenceArchivePayload } from "../src/r2-archive-store.ts";
import {
  ARCHIVE_RECORD_VERSION,
  createArchiveDurabilityPolicy,
  prepareArchiveGenesis,
  encodeArchiveManifest,
  encodeArchiveAnchor,
  decodeArchiveAnchor,
  type ArchiveAnchor,
} from "../src/archive-records.ts";
import { evaluateOutcomePayload } from "../src/outcome-payload.ts";
import { withBucket, type TestR2Bucket } from "./r2-fixtures.ts";
import { BOOK, genesis, activation, posting } from "./fixtures.ts";

const scope = {
  tenantId: "tenant",
  bookId: BOOK,
  objectId: "book-object",
  namespaceId: "catalog-tests",
  generation: "0",
};
const encodedGenesis = encodeDurableBook(genesis());
function sqlite(path = ":memory:") {
  const db = new Database(path);
  if (path === ":memory:") {
    db.exec(
      "PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY; PRAGMA cache_size = -64000; PRAGMA temp_store = MEMORY;",
    );
  } else {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
  }
  const faults = { afterSql: "", loseSyncAfter: "", syncFailures: 0, writes: 0, reads: 0 };
  const stmtCache = new Map<string, ReturnType<Database["query"]>>();
  const port: SqliteStorage = {
    sql: {
      exec(sql, ...bindings) {
        if (/^(CREATE|INSERT|UPDATE|DELETE|ALTER|DROP)/.test(sql)) faults.writes++;
        if (sql.startsWith("SELECT")) faults.reads++;
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
        if (faults.afterSql && sql.startsWith(faults.afterSql))
          throw new Error("injected catalog SQL failure");
        if (faults.loseSyncAfter && sql.startsWith(faults.loseSyncAfter)) {
          faults.loseSyncAfter = "";
          faults.syncFailures++;
        }
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          for (const key in row) {
            const value = row[key];
            if (value instanceof Uint8Array) {
              row[key] = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
            }
          }
        }
        return rows;
      },
    },
    transactionSync(fn) {
      return db.transaction(fn)();
    },
    async sync() {
      if (faults.syncFailures) {
        faults.syncFailures--;
        throw new Error("lost catalog sync response");
      }
    },
  };
  return { db, port, faults };
}
async function archive(bucket: TestR2Bucket) {
  const store = new R2ArchiveObjectStore(bucket, scope, scope.objectId);
  const manifest = prepareArchiveGenesis(
    scope,
    createArchiveDurabilityPolicy(true),
    encodedGenesis,
    await store.putImmutable(new TextEncoder().encode(encodedGenesis)),
  );
  const reference = await store.putImmutable(
    new TextEncoder().encode(encodeArchiveManifest(manifest)),
  );
  const anchor: ArchiveAnchor = {
    version: ARCHIVE_RECORD_VERSION,
    kind: "anchor",
    identity: manifest.identity,
    format: manifest.format,
    head: manifest.initialHead,
    manifest: reference,
    manifestHash: manifest.contentHash,
    fenceGeneration: "0",
  };
  expect((await store.compareAndSwapControl(null, encodeArchiveAnchor(anchor))).disposition).toBe(
    "written",
  );
  return { store, anchor };
}
async function currentAnchor(store: R2ArchiveObjectStore) {
  const control = await store.readControl();
  if (!control) throw new Error("Missing fixture archive");
  return decodeArchiveAnchor(control.body);
}
async function setup(bucket: TestR2Bucket) {
  const c = sqlite(),
    b = sqlite();
  const catalog = new SqliteArchiveCatalog("catalog-object", c.port, scope);
  const owner = new SqliteArchiveSelection(scope.objectId, b.port, scope);
  const { store, anchor } = await archive(bucket);
  const verifier = {
    verifyHead: (expected: ArchiveAnchor) => owner.verifyArchiveHead(store, expected),
  };
  const reserved = await catalog.reserve(encodedGenesis, "reserve");
  await owner.reserveBook(encodedGenesis);
  const active = await catalog.activate(reserved, "activate", store, verifier);
  return {
    c,
    b,
    catalog,
    owner,
    store,
    anchor,
    verifier,
    active,
    reserved,
    close() {
      c.db.close();
      b.db.close();
    },
  };
}

test("archive coordinator preserves exact SQL-only receipts for commits, rejections, replays and identity conflicts", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket),
      reference = sqlite();
    const open = () => new ArchiveLedger(scope.objectId, f.b.port, scope, f.store, f.catalog);
    const expected = new ProductionLedger(
      new SqliteBookStorage(scope.objectId, reference.port),
      scope,
      COMPACT_LEDGER_FORMAT,
    );
    try {
      await expected.provision(genesis());
      expect((await open().read()).head).toEqual((await expected.read()).head);
      const bad = posting("unretained", 2n);
      const commands = [
        activation(),
        posting("sale"),
        posting("rejected", 0n),
        activation(),
        posting("sale"),
        posting("rejected", 0n),
        posting("sale", 2n, true, "conflicting input"),
        { ...bad, inputHash: { ...bad.inputHash, digest: "0".repeat(64) } },
        bad,
      ];
      for (const command of commands) {
        const oracle = await expected.execute(command);
        const receipt = await open().execute(command);
        const { durabilityPolicy, manifestHash, ...actual } = receipt;
        expect(actual).toEqual(oracle);
        expect(durabilityPolicy).toEqual(createArchiveDurabilityPolicy(true));
        const anchor = await currentAnchor(f.store);
        expect(anchor.head).toEqual(receipt.head);
        expect(anchor.manifestHash).toBe(manifestHash);
        expect(encodeDurableBook((await open().read()).aggregate)).toBe(
          encodeDurableBook((await expected.read()).aggregate),
        );
      }
      expect(
        f.b.db
          .query(
            "SELECT command_id, revision FROM ledger_outcomes ORDER BY sequence_length, sequence",
          )
          .all(),
      ).toEqual([
        { command_id: "activate", revision: "1" },
        { command_id: "sale", revision: "2" },
        { command_id: "rejected", revision: null },
        { command_id: "unretained", revision: "3" },
      ]);
      expect(await f.owner.readPending()).toBeUndefined();
    } finally {
      f.close();
      reference.db.close();
    }
  });
});

for (const stage of ["selected", "published", "materialized"] as const)
  test(`archive coordinator resumes ${stage} original selection before accepting another command`, async () => {
    await withBucket(async (bucket) => {
      const f = await setup(bucket);
      try {
        const encoded = evaluateOutcomePayload(genesis(), activation()).encoded;
        if (!encoded) throw new Error("Missing original outcome");
        await f.owner.select(f.store, f.anchor, encoded, "original-candidate");
        if (stage !== "selected") await f.owner.publishPending(f.store, f.catalog);
        if (stage === "materialized") await f.owner.reconcilePublished(f.store, f.catalog);
        const ledger = new ArchiveLedger(scope.objectId, f.b.port, scope, f.store, f.catalog);
        if (stage !== "materialized")
          await expect(ledger.read()).rejects.toThrow("archive_selection_pending");
        const next = await ledger.execute(posting("after-recovery"));
        expect(next.result.disposition).toBe("committed");
        expect(next.outcomeSequence).toBe(2n);
        const retry = await ledger.execute(activation());
        expect(retry.result.disposition).toBe("replayed");
        expect(retry.outcomeSequence).toBe(1n);
        expect(retry.originalResult).toEqual(
          evaluateOutcomePayload(genesis(), activation()).transition.result,
        );
        expect(
          f.b.db
            .query(
              "SELECT command_id, revision FROM ledger_outcomes ORDER BY sequence_length, sequence",
            )
            .all(),
        ).toEqual([
          { command_id: "activate", revision: "1" },
          { command_id: "after-recovery", revision: "2" },
        ]);
      } finally {
        f.close();
      }
    });
  });

test("archive coordinator maintenance admission performs no selection or archive writes", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    try {
      await f.catalog.beginMaintenance(f.active, "deny-new-commands");
      let archiveWrites = 0;
      const store = new R2ArchiveObjectStore(
        {
          get: (key) => bucket.get(key),
          put: async (key, value, options) => {
            archiveWrites++;
            return bucket.put(key, value, options);
          },
        },
        scope,
        scope.objectId,
      );
      const ledger = new ArchiveLedger(scope.objectId, f.b.port, scope, store, f.catalog);
      const writes = f.b.faults.writes;
      await expect(ledger.execute(activation())).rejects.toThrow("archive_catalog_unavailable");
      await expect(ledger.read()).rejects.toThrow("archive_catalog_unavailable");
      expect(f.b.faults.writes).toBe(writes);
      expect(archiveWrites).toBe(0);
      expect(await f.owner.readPending()).toBeUndefined();
      expect((await currentAnchor(f.store)).head.sequence).toBe("0");
    } finally {
      f.close();
    }
  });
});

for (const boundary of [
  "selection-sync",
  "archive-upload",
  "control-response",
  "materialization-sync",
] as const)
  test(`archive coordinator returns no receipt after ${boundary} uncertainty and restart retains one original outcome`, async () => {
    await withBucket(async (bucket) => {
      const f = await setup(bucket);
      try {
        let fault = true;
        const store = new R2ArchiveObjectStore(
          {
            get: (key) => bucket.get(key),
            async put(key, value, options) {
              if (fault && boundary === "archive-upload" && key.includes("/immutable/")) {
                fault = false;
                throw new Error("injected publication response failure");
              }
              const result = await bucket.put(key, value, options);
              if (fault && boundary === "control-response" && key.endsWith("/control/anchor")) {
                fault = false;
                throw new Error("injected publication response failure");
              }
              return result;
            },
          },
          scope,
          scope.objectId,
        );
        if (boundary === "selection-sync")
          f.b.faults.loseSyncAfter = "UPDATE ledger_metadata SET archive_selection_hash = ?";
        if (boundary === "materialization-sync")
          f.b.faults.loseSyncAfter = "UPDATE ledger_metadata SET head = ?";
        const ledger = new ArchiveLedger(scope.objectId, f.b.port, scope, store, f.catalog);
        await expect(ledger.execute(activation())).rejects.toThrow(
          boundary.endsWith("sync") ? "lost catalog sync response" : "archive_write_uncertain",
        );
        expect((await currentAnchor(f.store)).head.sequence).toBe(
          boundary === "control-response" || boundary === "materialization-sync" ? "1" : "0",
        );
        expect(f.b.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
          count: boundary === "materialization-sync" ? 1 : 0,
        });
        const reopened = new ArchiveLedger(scope.objectId, f.b.port, scope, f.store, f.catalog);
        const receipt = await reopened.execute(activation());
        expect(receipt.result.disposition).toBe("replayed");
        expect(receipt.outcomeSequence).toBe(1n);
        expect(receipt.originalResult).toEqual(
          evaluateOutcomePayload(genesis(), activation()).transition.result,
        );
        expect(f.b.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
          count: 1,
        });
        expect(await f.owner.readPending()).toBeUndefined();
        expect((await reopened.read()).head).toEqual(receipt.head);
      } finally {
        f.close();
      }
    });
  });

test("archive coordinator cannot materialize an already-published selection during maintenance", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    try {
      const encoded = evaluateOutcomePayload(genesis(), activation()).encoded;
      if (!encoded) throw new Error("Missing original outcome");
      const selected = await f.owner.select(
        f.store,
        f.anchor,
        encoded,
        "admitted-before-maintenance",
      );
      await f.owner.publishPending(f.store, f.catalog);
      const maintenance = await f.catalog.beginMaintenance(f.active, "hold-public-coordinator");
      await f.catalog.sealFence(maintenance, "hold-sealed", f.store);
      const writes = f.b.faults.writes;
      const ledger = new ArchiveLedger(scope.objectId, f.b.port, scope, f.store, f.catalog);
      await expect(ledger.execute(activation())).rejects.toThrow("archive_catalog_unavailable");
      expect(f.b.faults.writes).toBe(writes);
      expect((await f.owner.readPending())?.selectionHash).toBe(selected.selectionHash);
      expect(f.b.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
        count: 0,
      });
      // Explicit control-plane reconciliation is still permitted and does not
      // release maintenance or turn this failed command into a returned receipt.
      expect((await f.owner.reconcilePublished(f.store, f.catalog)).disposition).toBe(
        "materialized",
      );
      expect((await f.catalog.read()).entry.status).toBe("maintenance");
    } finally {
      f.close();
    }
  });
});

test("archive coordinator refuses a financial read when maintenance changes during verification", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    try {
      let reads = 0;
      const authority = {
        async readEntry(identity: typeof scope) {
          if (++reads === 2)
            await f.catalog.beginMaintenance(await f.catalog.read(), "interrupt-read");
          return f.catalog.readEntry(identity);
        },
      };
      const writes = f.b.faults.writes;
      const ledger = new ArchiveLedger(scope.objectId, f.b.port, scope, f.store, authority);
      await expect(ledger.read()).rejects.toThrow("archive_catalog_fence_mismatch");
      expect(reads).toBe(2);
      expect(f.b.faults.writes).toBe(writes);
      expect((await f.catalog.read()).entry.status).toBe("maintenance");
    } finally {
      f.close();
    }
  });
});

test("archive coordinator withholds a materialized receipt during maintenance and recovers the original after verified release", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    try {
      let interrupted = false;
      const authority = {
        async readEntry(identity: typeof scope) {
          const row = f.b.db.query("SELECT count(*) AS count FROM ledger_outcomes").get() as {
            count: number;
          };
          if (!interrupted && row.count === 1) {
            interrupted = true;
            await f.catalog.beginMaintenance(await f.catalog.read(), "interrupt-receipt");
          }
          return f.catalog.readEntry(identity);
        },
      };
      const ledger = new ArchiveLedger(scope.objectId, f.b.port, scope, f.store, authority);
      await expect(ledger.execute(activation())).rejects.toThrow("archive_catalog_unavailable");
      expect(interrupted).toBe(true);
      expect(await f.owner.readPending()).toBeUndefined();
      expect((await currentAnchor(f.store)).head.sequence).toBe("1");
      const sealed = await f.catalog.sealFence(await f.catalog.read(), "seal-receipt", f.store);
      await f.catalog.finishMaintenance(sealed, "finish-receipt", f.store, f.verifier);
      const receipt = await new ArchiveLedger(
        scope.objectId,
        f.b.port,
        scope,
        f.store,
        f.catalog,
      ).execute(activation());
      expect(receipt.result.disposition).toBe("replayed");
      expect(receipt.outcomeSequence).toBe(1n);
      expect(receipt.originalResult).toEqual(
        evaluateOutcomePayload(genesis(), activation()).transition.result,
      );
      expect(receipt.head.sequence).toBe("1");
    } finally {
      f.close();
    }
  });
});

test("archive coordinator checks original archive payloads on reads and retries", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    try {
      const ledger = new ArchiveLedger(scope.objectId, f.b.port, scope, f.store, f.catalog);
      const original = await ledger.execute(activation());
      const pending = await f.owner.readPending();
      expect(pending).toBeUndefined();
      const encoded = evaluateOutcomePayload(genesis(), activation()).encoded;
      if (!encoded) throw new Error("Missing payload");
      const reference = referenceArchivePayload(
        scope,
        scope.objectId,
        new TextEncoder().encode(encoded),
      );
      expect(await bucket.get(reference.objectKey)).not.toBeNull();
      await bucket.delete(reference.objectKey);
      const writes = f.b.faults.writes;
      await expect(ledger.read()).rejects.toThrow("archive_payload_missing");
      await expect(ledger.execute(activation())).rejects.toThrow("archive_payload_missing");
      expect(f.b.faults.writes).toBe(writes);
      expect((await currentAnchor(f.store)).head).toEqual(original.head);
      await f.store.putImmutable(new TextEncoder().encode(encoded));
      expect((await ledger.execute(activation())).originalResult).toEqual(original.result);
    } finally {
      f.close();
    }
  });
});

test("archive coordinator captures mutable input before queuing and rejects foreign or unknown fields before storage", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    try {
      const ledger = new ArchiveLedger(scope.objectId, f.b.port, scope, f.store, f.catalog);
      const reads = f.b.faults.reads;
      expect(() => ledger.execute({ ...activation(), bookId: "foreign" as typeof BOOK })).toThrow(
        "ledger_identity_mismatch",
      );
      expect(() =>
        ledger.execute({ ...activation(), unexpected: true } as unknown as ReturnType<
          typeof activation
        >),
      ).toThrow();
      expect(f.b.faults.reads).toBe(reads);
      const command = { ...activation() };
      const pending = ledger.execute(command);
      command.expectedBookRevision = 99n;
      const receipt = await pending;
      expect(receipt.result).toEqual(
        evaluateOutcomePayload(genesis(), activation()).transition.result,
      );
      expect(receipt.outcomeSequence).toBe(1n);
      expect(Object.isFrozen(receipt)).toBe(true);
      expect(Object.isFrozen(receipt.originalResult)).toBe(true);
    } finally {
      f.close();
    }
  });
});

test("archive coordinator concurrent owners retain one outcome per command without exposing unproven receipts", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    const open = () => new ArchiveLedger(scope.objectId, f.b.port, scope, f.store, f.catalog);
    try {
      const activations = await Promise.allSettled([
        open().execute(activation()),
        open().execute(activation()),
      ]);
      expect(activations.filter((result) => result.status === "fulfilled").length).toBeGreaterThan(
        0,
      );
      expect((await open().execute(activation())).outcomeSequence).toBe(1n);
      const commands = [posting("competing-a"), posting("competing-b")];
      const raced = await Promise.allSettled(commands.map((command) => open().execute(command)));
      // A second owner may either lose a storage race or arrive late enough to
      // retain the kernel's stale-revision rejection. Both are serializable.
      expect(raced.filter((result) => result.status === "fulfilled").length).toBeGreaterThan(0);
      for (const result of [...activations, ...raced]) {
        if (result.status === "rejected") {
          expect(result.reason).toBeInstanceOf(LedgerError);
          expect([
            "archive_selection_pending",
            "archive_prior_head_mismatch",
            "archive_publish_conflict",
            "archive_selection_changed",
            "archive_book_head_mismatch",
            "archive_book_control_changed",
            "archive_anchor_mismatch",
            "ledger_head_conflict",
          ]).toContain(result.reason.code);
        }
      }
      const owner = open();
      for (const command of commands) await owner.execute(command);
      const receipts = await Promise.all(commands.map((command) => owner.execute(command)));
      expect(receipts.map((receipt) => receipt.result.disposition)).toEqual([
        "replayed",
        "replayed",
      ]);
      expect(receipts.map((receipt) => receipt.originalResult?.disposition).sort()).toEqual([
        "committed",
        "rejected",
      ]);
      expect(receipts.map((receipt) => receipt.outcomeSequence).sort()).toEqual([2n, 3n]);
      expect((await open().read()).head.sequence).toBe("3");
      expect(await f.owner.readPending()).toBeUndefined();
    } finally {
      f.close();
    }
  });
});

async function selectAndFence(f: Awaited<ReturnType<typeof setup>>, candidateId = "abandon-me") {
  const outcome = evaluateOutcomePayload(genesis(), activation());
  if (!outcome.encoded) throw new Error("Missing fixture outcome");
  const selected = await f.owner.select(
    f.store,
    await currentAnchor(f.store),
    outcome.encoded,
    candidateId,
  );
  const maintenance = await f.catalog.beginMaintenance(
    await f.catalog.read(),
    `maintain-${candidateId}`,
  );
  const sealed = await f.catalog.sealFence(maintenance, `seal-${candidateId}`, f.store);
  return { selected, sealed, maintenance };
}

async function authorizeFixture(f: Awaited<ReturnType<typeof setup>>, id = "restore") {
  const maintenance = await f.catalog.beginMaintenance(await f.catalog.read(), `maintain-${id}`);
  const sealed = await f.catalog.sealFence(maintenance, `seal-${id}`, f.store);
  const authorized = await f.catalog.authorizeRestore(sealed, id, "operator", f.store);
  if (!authorized.restorePermit) throw new Error("Missing restore permit");
  return { maintenance, sealed, authorized, permit: authorized.restorePermit };
}

async function seedRestoreBook(f: Awaited<ReturnType<typeof setup>>) {
  let aggregate = genesis();
  for (const [index, command] of [
    activation(),
    posting("sale"),
    posting("retained-rejection", 0n),
  ].entries()) {
    const evaluated = evaluateOutcomePayload(aggregate, command);
    if (!evaluated.encoded) throw new Error("Missing retained fixture outcome");
    await f.owner.select(f.store, await currentAnchor(f.store), evaluated.encoded, `seed-${index}`);
    await f.owner.publishPending(f.store, f.catalog);
    await f.owner.reconcilePublished(f.store, f.catalog);
    aggregate = { state: evaluated.transition.state, protocol: evaluated.transition.protocol };
  }
  const source = new SqliteBookStorage(scope.objectId, f.b.port);
  const book = atomicSqlite(f.b.port, (transaction) =>
    source.loadForArchiveInTransaction(transaction, scope),
  );
  return { aggregate, book };
}

for (const condition of ["absent", "damaged-chunks", "damaged-head", "unchanged"] as const)
  test(`atomic restore installs exact original history over ${condition} book and permits later normal publication`, async () => {
    await withBucket(async (bucket) => {
      const f = await setup(bucket);
      try {
        const original = await seedRestoreBook(f);
        const { authorized, permit } = await authorizeFixture(f);
        if (condition === "absent")
          f.b.db.exec(
            "DROP TABLE ledger_archive_owner; DROP TABLE ledger_archive_chunks; DROP TABLE ledger_chunks; DROP TABLE ledger_outcomes; DROP TABLE ledger_metadata",
          );
        if (condition === "damaged-chunks")
          f.b.db.exec("UPDATE ledger_chunks SET bytes = x'00' WHERE record_id = '2'");
        if (condition === "damaged-head")
          f.b.db.exec("UPDATE ledger_metadata SET head = 'damaged'");
        const installed = await f.owner.restoreFromArchive(
          f.store,
          f.catalog,
          authorized.contentHash,
          permit.contentHash,
        );
        expect(installed.disposition).toBe("installed");
        expect(installed.restoredHead).toEqual(original.book.head);
        expect(installed.permitHash).toBe(permit.contentHash);
        const source = new SqliteBookStorage(scope.objectId, f.b.port);
        expect(
          atomicSqlite(f.b.port, (transaction) =>
            source.loadForArchiveInTransaction(transaction, scope),
          ),
        ).toEqual(original.book);
        expect(
          (await f.owner.verifyArchiveHead(f.store, permit.anchor)).restoredUnderPermitHash,
        ).toBe(permit.contentHash);
        expect(() => source.load(scope)).toThrow("ledger_archive_owner_required");
        expect(
          f.b.db.query("SELECT last_header, pending_header FROM ledger_archive_owner").get(),
        ).toEqual({ last_header: null, pending_header: null });
        expect(await f.catalog.read()).toEqual(authorized);
        const replacement = new SqliteArchiveSelection(scope.objectId, f.b.port, scope);
        const writes = f.b.faults.writes;
        expect(
          await replacement.restoreFromArchive(
            f.store,
            f.catalog,
            authorized.contentHash,
            permit.contentHash,
          ),
        ).toEqual({ ...installed, disposition: "already-installed" });
        expect(f.b.faults.writes).toBe(writes);
        await f.catalog.finishMaintenance(authorized, "finish-installed", f.store, f.verifier);
        const next = evaluateOutcomePayload(original.aggregate, posting("after-restore", 2n));
        if (!next.encoded) throw new Error("Missing next outcome");
        const selected = await replacement.select(
          f.store,
          await currentAnchor(f.store),
          next.encoded,
          "after-restore",
        );
        await replacement.publishPending(f.store, f.catalog);
        await replacement.reconcilePublished(f.store, f.catalog);
        expect(
          await replacement.restoreFromArchive(
            f.store,
            f.catalog,
            authorized.contentHash,
            permit.contentHash,
          ),
        ).toEqual({ ...installed, disposition: "already-installed" });
        expect(
          (await replacement.verifyArchiveHead(f.store, await currentAnchor(f.store))).head,
        ).toEqual(selected.manifest.resulting);
        expect(f.b.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
          count: 4,
        });
      } finally {
        f.close();
      }
    });
  });

for (const fault of [
  "DROP TABLE ledger_metadata",
  "CREATE TABLE ledger_outcomes",
  "INSERT INTO ledger_chunks",
  "INSERT INTO ledger_outcomes",
  "UPDATE ledger_archive_restore SET phase",
])
  test(`restore transaction rolls back canonical replacement after ${fault}`, async () => {
    await withBucket(async (bucket) => {
      const f = await setup(bucket);
      try {
        const original = await seedRestoreBook(f);
        const { authorized, permit } = await authorizeFixture(f);
        const beforeMetadata = f.b.db.query("SELECT * FROM ledger_metadata").all();
        const beforeOutcomes = f.b.db
          .query("SELECT * FROM ledger_outcomes ORDER BY sequence")
          .all();
        f.b.faults.afterSql = fault;
        await expect(
          f.owner.restoreFromArchive(
            f.store,
            f.catalog,
            authorized.contentHash,
            permit.contentHash,
          ),
        ).rejects.toThrow("injected catalog SQL failure");
        f.b.faults.afterSql = "";
        expect(f.b.db.query("SELECT * FROM ledger_metadata").all()).toEqual(beforeMetadata);
        expect(f.b.db.query("SELECT * FROM ledger_outcomes ORDER BY sequence").all()).toEqual(
          beforeOutcomes,
        );
        expect(f.b.db.query("SELECT phase FROM ledger_archive_restore").get()).toEqual({
          phase: "selected",
        });
        await expect(f.owner.readPending()).rejects.toThrow("archive_restore_pending");
        expect(
          (
            await f.owner.restoreFromArchive(
              f.store,
              f.catalog,
              authorized.contentHash,
              permit.contentHash,
            )
          ).restoredHead,
        ).toEqual(original.book.head);
      } finally {
        f.close();
      }
    });
  });

for (const boundary of ["reservation", "installation"] as const)
  test(`lost restore ${boundary} durability response resumes without duplicate outcomes`, async () => {
    await withBucket(async (bucket) => {
      const f = await setup(bucket);
      try {
        await seedRestoreBook(f);
        const { authorized, permit } = await authorizeFixture(f);
        f.b.faults.loseSyncAfter =
          boundary === "reservation"
            ? "INSERT INTO ledger_archive_restore"
            : "UPDATE ledger_archive_restore SET phase";
        await expect(
          f.owner.restoreFromArchive(
            f.store,
            f.catalog,
            authorized.contentHash,
            permit.contentHash,
          ),
        ).rejects.toThrow("lost catalog sync response");
        expect(f.b.db.query("SELECT phase FROM ledger_archive_restore").get()).toEqual({
          phase: boundary === "reservation" ? "selected" : "installed",
        });
        const replacement = new SqliteArchiveSelection(scope.objectId, f.b.port, scope);
        if (boundary === "reservation") {
          await expect(replacement.readPending()).rejects.toThrow("archive_restore_pending");
          await expect(replacement.publishPending(f.store, f.catalog)).rejects.toThrow(
            "archive_restore_pending",
          );
          await expect(replacement.reconcilePublished(f.store, f.catalog)).rejects.toThrow(
            "archive_restore_pending",
          );
          await expect(replacement.reserveBook(encodedGenesis)).rejects.toThrow(
            "archive_restore_pending",
          );
        }
        expect(
          (
            await replacement.restoreFromArchive(
              f.store,
              f.catalog,
              authorized.contentHash,
              permit.contentHash,
            )
          ).disposition,
        ).toBe(boundary === "reservation" ? "installed" : "already-installed");
        expect(f.b.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
          count: 3,
        });
        expect(
          (await f.catalog.finishMaintenance(authorized, "finish", f.store, f.verifier)).entry
            .status,
        ).toBe("active");
      } finally {
        f.close();
      }
    });
  });

for (const supersede of [false, true])
  for (const parkRead of [1, 3])
    test(`delayed restore at read ${parkRead} cannot overwrite subsequent publication after ${supersede ? "newer" : "same"} permit installation`, async () => {
      await withBucket(async (bucket) => {
        const f = await setup(bucket);
        let release!: () => void;
        let delayed: Promise<unknown> | undefined;
        try {
          const original = await seedRestoreBook(f);
          const first = await authorizeFixture(f);
          let arrived!: () => void;
          const parked = new Promise<void>((resolve) => {
            arrived = resolve;
          });
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          let reads = 0;
          const reader = {
            catalogObjectId: f.catalog.catalogObjectId,
            async read() {
              const observed = await f.catalog.read();
              if (++reads === parkRead) {
                arrived();
                await gate;
              }
              return observed;
            },
          };
          delayed = f.owner
            .restoreFromArchive(
              f.store,
              reader,
              first.authorized.contentHash,
              first.permit.contentHash,
            )
            .then(
              (value) => value,
              (error: Error) => error.message,
            );
          await parked;
          const current = supersede ? await authorizeFixture(f, "newer-restore") : first;
          const completed = await f.owner.restoreFromArchive(
            f.store,
            f.catalog,
            current.authorized.contentHash,
            current.permit.contentHash,
          );
          await f.catalog.finishMaintenance(current.authorized, "finish", f.store, f.verifier);
          const next = evaluateOutcomePayload(original.aggregate, posting("new-work", 2n));
          if (!next.encoded) throw new Error("Missing next outcome");
          const selected = await f.owner.select(
            f.store,
            await currentAnchor(f.store),
            next.encoded,
            "new-work",
          );
          await f.owner.publishPending(f.store, f.catalog);
          await f.owner.reconcilePublished(f.store, f.catalog);
          const writes = f.b.faults.writes;
          release();
          expect(await delayed).toEqual(
            supersede
              ? "archive_restore_selection_changed"
              : { ...completed, disposition: "already-installed" },
          );
          expect(f.b.faults.writes).toBe(writes);
          expect(
            (await f.owner.verifyArchiveHead(f.store, await currentAnchor(f.store))).head,
          ).toEqual(selected.manifest.resulting);
          expect(f.b.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
            count: 4,
          });
        } finally {
          release?.();
          await delayed?.catch(() => {});
          f.close();
        }
      });
    });

test("an empty book with a durable pending restore cannot be mistaken for a new SQL-only book", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    try {
      const { authorized, permit } = await authorizeFixture(f);
      f.b.db.exec(
        "DROP TABLE ledger_archive_owner; DROP TABLE ledger_archive_chunks; DROP TABLE ledger_chunks; DROP TABLE ledger_outcomes; DROP TABLE ledger_metadata",
      );
      f.b.faults.loseSyncAfter = "INSERT INTO ledger_archive_restore";
      await expect(
        f.owner.restoreFromArchive(f.store, f.catalog, authorized.contentHash, permit.contentHash),
      ).rejects.toThrow("lost catalog sync response");
      expect(
        f.b.db
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'ledger_*'")
          .all(),
      ).toEqual([{ name: "ledger_archive_restore" }]);
      const bare = new SqliteBookStorage(scope.objectId, f.b.port);
      expect(() => bare.load(scope)).toThrow("ledger_archive_owner_required");
      await expect(f.owner.reserveBook(encodedGenesis)).rejects.toThrow(
        "ledger_archive_owner_required",
      );
      expect(
        (
          await f.owner.restoreFromArchive(
            f.store,
            f.catalog,
            authorized.contentHash,
            permit.contentHash,
          )
        ).restoredHead.sequence,
      ).toBe("0");
      expect(
        (await f.catalog.finishMaintenance(authorized, "finish", f.store, f.verifier)).entry.status,
      ).toBe("active");
    } finally {
      f.close();
    }
  });
});

for (const damage of ["digest", "phase", "manifest", "missing-row", "oversize"] as const)
  test(`damaged installed restore state (${damage}) fails closed and is never repaired by retry`, async () => {
    await withBucket(async (bucket) => {
      const f = await setup(bucket);
      try {
        await seedRestoreBook(f);
        const { authorized, permit } = await authorizeFixture(f);
        await f.owner.restoreFromArchive(
          f.store,
          f.catalog,
          authorized.contentHash,
          permit.contentHash,
        );
        if (damage === "digest")
          f.b.db.exec("UPDATE ledger_archive_restore SET record_hash = 'corrupt'");
        if (damage === "phase") f.b.db.exec("UPDATE ledger_archive_restore SET phase = 'selected'");
        if (damage === "missing-row") f.b.db.exec("DELETE FROM ledger_archive_restore");
        if (damage === "oversize")
          f.b.db.exec("UPDATE ledger_archive_restore SET record = CAST(zeroblob(65537) AS TEXT)");
        if (damage === "manifest") {
          const row = f.b.db.query("SELECT record FROM ledger_archive_restore").get() as {
            record: string;
          };
          const state = JSON.parse(row.record);
          state.manifest = state.predecessorManifest;
          state.predecessorManifest = null;
          const record = JSON.stringify(state);
          const hash = hashCanonical({
            domain: "rastrata-sqlite-archive-restore-v1",
            record,
          }).digest;
          f.b.db
            .query("UPDATE ledger_archive_restore SET record = ?, record_hash = ?")
            .run(record, hash);
        }
        const writes = f.b.faults.writes;
        await expect(f.owner.readPending()).rejects.toThrow("archive_restore_state_corrupt");
        await expect(
          f.owner.restoreFromArchive(
            f.store,
            f.catalog,
            authorized.contentHash,
            permit.contentHash,
          ),
        ).rejects.toThrow("archive_restore_state_corrupt");
        expect(f.b.faults.writes).toBe(writes);
      } finally {
        f.close();
      }
    });
  });

for (const dependency of ["foreign-key", "trigger"] as const)
  test(`restore refuses external ${dependency} dependencies without touching unrelated data`, async () => {
    await withBucket(async (bucket) => {
      const f = await setup(bucket);
      try {
        const { authorized, permit } = await authorizeFixture(f);
        f.b.db.exec("PRAGMA foreign_keys = ON");
        if (dependency === "foreign-key")
          f.b.db.exec(
            "CREATE TABLE user_notes (book_row INTEGER REFERENCES ledger_metadata(singleton) ON DELETE CASCADE, note TEXT NOT NULL)",
          );
        else {
          f.b.db.exec("CREATE TABLE user_notes (book_row INTEGER, note TEXT NOT NULL)");
          f.b.db.exec(
            "CREATE TRIGGER user_hook AFTER INSERT ON ledger_outcomes BEGIN DELETE FROM user_notes; END",
          );
        }
        f.b.db.exec("INSERT INTO user_notes VALUES (1, 'must survive')");
        await expect(
          f.owner.restoreFromArchive(
            f.store,
            f.catalog,
            authorized.contentHash,
            permit.contentHash,
          ),
        ).rejects.toThrow("archive_restore_storage_conflict");
        expect(f.b.db.query("SELECT * FROM user_notes").all()).toEqual([
          { book_row: 1, note: "must survive" },
        ]);
        expect(
          f.b.db
            .query("SELECT name FROM sqlite_master WHERE name = 'ledger_archive_restore'")
            .all(),
        ).toEqual([]);
      } finally {
        f.close();
      }
    });
  });

for (const nonzero of [false, true])
  for (const damage of ["missing-table", "wrong-metadata-hash"] as const)
    test(`restored ${nonzero ? "nonzero" : "genesis"} books detect ${damage} without treating themselves as unrestored`, async () => {
      await withBucket(async (bucket) => {
        const f = await setup(bucket);
        try {
          if (nonzero) await seedRestoreBook(f);
          const { authorized, permit } = await authorizeFixture(f);
          const installed = await f.owner.restoreFromArchive(
            f.store,
            f.catalog,
            authorized.contentHash,
            permit.contentHash,
          );
          expect(f.b.db.query("SELECT archive_restore_hash FROM ledger_metadata").get()).toEqual({
            archive_restore_hash: installed.restoreStateHash,
          });
          if (damage === "missing-table") f.b.db.exec("DROP TABLE ledger_archive_restore");
          else f.b.db.exec("UPDATE ledger_metadata SET archive_restore_hash = 'corrupt'");
          const writes = f.b.faults.writes;
          await expect(f.owner.readPending()).rejects.toThrow("archive_restore_state_corrupt");
          await expect(
            f.owner.restoreFromArchive(
              f.store,
              f.catalog,
              authorized.contentHash,
              permit.contentHash,
            ),
          ).rejects.toThrow("archive_restore_state_corrupt");
          expect(f.b.faults.writes).toBe(writes);
          expect(() => new SqliteBookStorage(scope.objectId, f.b.port).load(scope)).toThrow(
            "ledger_archive_owner_required",
          );
        } finally {
          f.close();
        }
      });
    });

for (const damage of ["identity", "genesis", "unknown-table", "newer-head"] as const)
  test(`restore refuses ${damage} without reserving or erasing the book slot`, async () => {
    await withBucket(async (bucket) => {
      const f = await setup(bucket);
      try {
        const { authorized, permit } = await authorizeFixture(f);
        if (damage === "identity")
          f.b.db
            .query("UPDATE ledger_metadata SET scope = ?")
            .run(JSON.stringify({ ...scope, tenantId: "other-tenant" }));
        if (damage === "genesis")
          f.b.db.exec(
            "UPDATE ledger_metadata SET genesis_digest = '0000000000000000000000000000000000000000000000000000000000000000'",
          );
        if (damage === "unknown-table") f.b.db.exec("CREATE TABLE ledger_user_data (value TEXT)");
        if (damage === "newer-head")
          f.b.db
            .query("UPDATE ledger_metadata SET head = ?")
            .run(JSON.stringify({ ...permit.anchor.head, sequence: "1" }));
        const before = f.b.db.query("SELECT * FROM ledger_metadata").all();
        await expect(
          f.owner.restoreFromArchive(
            f.store,
            f.catalog,
            authorized.contentHash,
            permit.contentHash,
          ),
        ).rejects.toThrow(
          damage === "unknown-table"
            ? "archive_restore_storage_conflict"
            : damage === "newer-head"
              ? "archive_restore_would_rollback"
              : "archive_restore_identity_unverified",
        );
        expect(f.b.db.query("SELECT * FROM ledger_metadata").all()).toEqual(before);
        expect(
          f.b.db
            .query("SELECT name FROM sqlite_master WHERE name = 'ledger_archive_restore'")
            .all(),
        ).toEqual([]);
      } finally {
        f.close();
      }
    });
  });

test("restore permit is durable external authority, not a matching-head shortcut to reopening", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    try {
      const { sealed, authorized, permit } = await authorizeFixture(f);
      expect(permit.catalogHash).toBe(sealed.contentHash);
      expect(permit.catalogRevision).toBe(sealed.revision);
      expect(permit.sourceBackupId).toBe(f.anchor.manifestHash);
      expect(permit.entry.genesisHash).toBe(f.active.entry.genesisHash);
      expect(permit.anchor.head).toEqual(f.anchor.head);
      const writes = f.c.faults.writes;
      const reopened = new SqliteArchiveCatalog("catalog-object", f.c.port, scope);
      expect(await reopened.read()).toEqual(authorized);
      expect(await reopened.authorizeRestore(sealed, "restore", "operator", f.store)).toEqual(
        authorized,
      );
      expect(f.c.faults.writes).toBe(writes);
      await expect(
        reopened.authorizeRestore(sealed, "restore", "someone-else", f.store),
      ).rejects.toThrow("archive_catalog_operation_conflict");
      await expect(
        reopened.authorizeRestore(authorized, "replacement", "operator", f.store),
      ).rejects.toThrow("archive_restore_already_authorized");
      // Actual SQL/R2 agree, but this book has NOT been restored under the permit.
      expect((await f.verifier.verifyHead(permit.anchor)).head).toEqual(permit.anchor.head);
      await expect(
        reopened.finishMaintenance(authorized, "premature", f.store, f.verifier),
      ).rejects.toThrow("archive_restore_unverified");
      expect(await reopened.read()).toEqual(authorized);
    } finally {
      f.close();
    }
  });
});

test("superseding maintenance preserves the restore obligation and requires a newly authorized fence", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    try {
      const first = await authorizeFixture(f);
      const newer = await f.catalog.beginMaintenance(first.authorized, "new-maintenance");
      expect(newer.restorePermit).toEqual(first.permit);
      const sealed = await f.catalog.sealFence(newer, "new-seal", f.store);
      expect(sealed.restorePermit).toEqual(first.permit);
      await expect(
        f.catalog.finishMaintenance(sealed, "bypass", f.store, f.verifier),
      ).rejects.toThrow("archive_restore_unverified");
      await expect(
        prepareArchiveRestoreImage(
          f.store,
          f.catalog,
          scope,
          scope.objectId,
          sealed.contentHash,
          first.permit.contentHash,
        ),
      ).rejects.toThrow("archive_restore_not_authorized");
      const replacement = await f.catalog.authorizeRestore(
        sealed,
        "new-permit",
        "operator-2",
        f.store,
      );
      expect(replacement.restorePermit?.entry.fenceGeneration).toBe("2");
      expect(replacement.restorePermit?.approvedBy).toBe("operator-2");
      expect(replacement.restorePermit?.anchor.head).toEqual(first.permit.anchor.head);
      await expect(
        f.catalog.authorizeRestore(first.sealed, "restore", "operator", f.store),
      ).rejects.toThrow("archive_catalog_head_conflict");
      await expect(
        f.catalog.finishMaintenance(replacement, "still-unverified", f.store, f.verifier),
      ).rejects.toThrow("archive_restore_unverified");
    } finally {
      f.close();
    }
  });
});

for (const failure of ["rollback", "lost-sync"] as const)
  test(`restore authorization ${failure} never invents another permit on retry`, async () => {
    await withBucket(async (bucket) => {
      const f = await setup(bucket);
      try {
        const maintenance = await f.catalog.beginMaintenance(f.active, "maintain");
        const sealed = await f.catalog.sealFence(maintenance, "seal", f.store);
        if (failure === "rollback") f.c.faults.afterSql = "UPDATE ledger_archive_catalog";
        else f.c.faults.loseSyncAfter = "UPDATE ledger_archive_catalog";
        await expect(
          f.catalog.authorizeRestore(sealed, "permit", "operator", f.store),
        ).rejects.toThrow(
          failure === "rollback" ? "injected catalog SQL failure" : "lost catalog sync response",
        );
        f.c.faults.afterSql = "";
        const readback = await f.catalog.read();
        expect(readback.restorePermit === null).toBe(failure === "rollback");
        const retried = await f.catalog.authorizeRestore(sealed, "permit", "operator", f.store);
        expect(retried.restorePermit?.permitId).toBe("permit");
        expect(BigInt(retried.revision)).toBe(BigInt(sealed.revision) + 1n);
        if (failure === "lost-sync") expect(retried).toEqual(readback);
        expect(await f.catalog.read()).toEqual(retried);
      } finally {
        f.close();
      }
    });
  });

for (const race of ["control", "catalog"] as const)
  test(`restore authorization rejects ${race} changes during archive replay`, async () => {
    await withBucket(async (bucket) => {
      const f = await setup(bucket);
      try {
        const maintenance = await f.catalog.beginMaintenance(f.active, "maintain");
        const sealed = await f.catalog.sealFence(maintenance, "seal", f.store);
        if (!sealed.sealed) throw new Error("Missing sealed fence");
        const payload = referenceArchivePayload(
          scope,
          scope.objectId,
          new TextEncoder().encode(encodedGenesis),
        );
        let raced = false;
        const changing = new R2ArchiveObjectStore(
          {
            async get(key) {
              const row = await bucket.get(key);
              if (key === payload.objectKey && !raced) {
                raced = true;
                if (race === "control") {
                  if (!sealed.sealed) throw new Error("Missing sealed fence");
                  await f.store.compareAndSwapControl(
                    sealed.sealed.control,
                    sealed.sealed.control.body,
                  );
                } else await f.catalog.beginMaintenance(sealed, "supersede");
              }
              return row;
            },
            put: (key, value, options) => bucket.put(key, value, options),
          },
          scope,
          scope.objectId,
        );
        await expect(
          f.catalog.authorizeRestore(sealed, "late-permit", "operator", changing),
        ).rejects.toThrow(
          race === "control" ? "archive_catalog_archive_changed" : "archive_catalog_head_conflict",
        );
        expect(raced).toBe(true);
        expect((await f.catalog.read()).restorePermit).toBeNull();
      } finally {
        f.close();
      }
    });
  });

test("restore authorization requires sealed maintenance and validates approver input without coercion", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    try {
      await expect(
        f.catalog.authorizeRestore(f.active, "permit", "operator", f.store),
      ).rejects.toThrow("archive_catalog_phase_invalid");
      const maintenance = await f.catalog.beginMaintenance(f.active, "maintain");
      await expect(
        f.catalog.authorizeRestore(maintenance, "permit", "operator", f.store),
      ).rejects.toThrow("archive_catalog_phase_invalid");
      const sealed = await f.catalog.sealFence(maintenance, "seal", f.store);
      let calls = 0;
      const object = {
        toString() {
          calls++;
          return "operator";
        },
      };
      await expect(
        f.catalog.authorizeRestore(sealed, "permit", object as unknown as string, f.store),
      ).rejects.toThrow("archive_restore_permit_invalid");
      await expect(
        f.catalog.authorizeRestore(sealed, "permit", "x".repeat(1025), f.store),
      ).rejects.toThrow("archive_restore_permit_invalid");
      expect(calls).toBe(0);
      expect(await f.catalog.read()).toEqual(sealed);
    } finally {
      f.close();
    }
  });
});

test("concurrent authorizations with the same operation ID but different approvers cannot echo success", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    try {
      const maintenance = await f.catalog.beginMaintenance(f.active, "maintain");
      const sealed = await f.catalog.sealFence(maintenance, "seal", f.store);
      const results = await Promise.allSettled(
        ["operator-a", "operator-b"].map((actor) =>
          f.catalog.authorizeRestore(sealed, "same-id", actor, f.store),
        ),
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const failed = results.find((result) => result.status === "rejected");
      expect(failed?.status === "rejected" ? String(failed.reason) : "no rejection").toContain(
        "archive_catalog_operation_conflict",
      );
      expect((await f.catalog.read()).mutation.kind).toBe("authorizeRestore");
    } finally {
      f.close();
    }
  });
});

test("restore image retains exact original committed and rejected SQL records without historical transport invention", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    try {
      let aggregate = genesis();
      const commands = [
        activation(),
        posting("sale"),
        posting("rejected", 0n),
        posting("sale-2", 2n),
      ];
      const originals: string[] = [];
      for (const [index, command] of commands.entries()) {
        const evaluated = evaluateOutcomePayload(aggregate, command);
        if (!evaluated.encoded) throw new Error("Expected retained outcome");
        originals.push(evaluated.encoded);
        await f.owner.select(
          f.store,
          await currentAnchor(f.store),
          evaluated.encoded,
          `original-${index}`,
        );
        await f.owner.publishPending(f.store, f.catalog);
        await f.owner.reconcilePublished(f.store, f.catalog);
        aggregate = { state: evaluated.transition.state, protocol: evaluated.transition.protocol };
      }
      const source = new SqliteBookStorage(scope.objectId, f.b.port);
      const originalSql = atomicSqlite(f.b.port, (transaction) =>
        source.loadForArchiveInTransaction(transaction, scope),
      );
      const { authorized, permit } = await authorizeFixture(f);
      const writes = f.b.faults.writes + f.c.faults.writes;
      const image = await prepareArchiveRestoreImage(
        f.store,
        f.catalog,
        scope,
        scope.objectId,
        authorized.contentHash,
        permit.contentHash,
      );
      expect(image.book).toEqual(originalSql);
      expect(image.book.outcomes.map((outcome) => outcome.body)).toEqual(originals);
      expect(image.book.outcomes.map((outcome) => outcome.revision)).toEqual(["1", "2", null, "3"]);
      expect(image.book.head.sequence).toBe("4");
      expect(image.book.head.bookRevision).toBe("3");
      expect(image.book.genesis).toBe(encodedGenesis);
      expect(image.lastManifest.contentHash).toBe(permit.sourceBackupId);
      expect("expectedControl" in image.lastManifest).toBe(false);
      expect("storageRevision" in image.lastManifest).toBe(false);
      expect(Object.isFrozen(image.book.outcomes)).toBe(true);
      expect(f.b.faults.writes + f.c.faults.writes).toBe(writes);
      await expect(
        f.catalog.finishMaintenance(authorized, "image-is-not-installation", f.store, f.verifier),
      ).rejects.toThrow("archive_restore_unverified");
      // Destroy ONLY this disposable in-memory fixture's validated book tables.
      // Preparation must use the independent catalog/R2, never local history.
      expect(
        f.b.db
          .query(
            "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name GLOB 'ledger_*'",
          )
          .get(),
      ).toEqual({ count: 5 });
      f.b.db.exec(
        "DROP TABLE ledger_archive_owner; DROP TABLE ledger_archive_chunks; DROP TABLE ledger_chunks; DROP TABLE ledger_outcomes; DROP TABLE ledger_metadata",
      );
      expect(
        await prepareArchiveRestoreImage(
          f.store,
          f.catalog,
          scope,
          scope.objectId,
          authorized.contentHash,
          permit.contentHash,
        ),
      ).toEqual(image);
      expect(
        f.b.db
          .query(
            "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name GLOB 'ledger_*'",
          )
          .get(),
      ).toEqual({ count: 0 });
      await expect(
        f.catalog.finishMaintenance(authorized, "book-still-missing", f.store, f.verifier),
      ).rejects.toThrow("ledger_not_provisioned");
    } finally {
      f.close();
    }
  });
});

for (const fault of [
  "unsealed",
  "stale",
  "different-permit",
  "changed-control",
  "missing-payload",
  "catalog-race",
] as const)
  test(`restore preparation rejects ${fault} without changing either database`, async () => {
    await withBucket(async (bucket) => {
      const f = await setup(bucket);
      try {
        const { authorized, permit, sealed } = await authorizeFixture(f);
        let catalogHash = authorized.contentHash,
          permitHash = permit.contentHash;
        let reader = { catalogObjectId: f.catalog.catalogObjectId, read: () => f.catalog.read() };
        let expectedError = "archive_catalog_head_conflict";
        if (fault === "unsealed") {
          const current = await f.catalog.beginMaintenance(authorized, "unseal");
          catalogHash = current.contentHash;
          expectedError = "archive_restore_not_authorized";
        }
        if (fault === "stale") catalogHash = sealed.contentHash;
        if (fault === "different-permit") {
          permitHash = "0".repeat(64);
          expectedError = "archive_restore_not_authorized";
        }
        if (fault === "changed-control") {
          await f.store.compareAndSwapControl(permit.control, permit.control.body);
          expectedError = "archive_catalog_archive_changed";
        }
        if (fault === "missing-payload") {
          const manifest = prepareArchiveGenesis(
            scope,
            createArchiveDurabilityPolicy(true),
            encodedGenesis,
            referenceArchivePayload(
              scope,
              scope.objectId,
              new TextEncoder().encode(encodedGenesis),
            ),
          );
          expect(await bucket.get(manifest.payload.objectKey)).not.toBeNull();
          await bucket.delete(manifest.payload.objectKey);
          expect(await bucket.get(manifest.payload.objectKey)).toBeNull();
          expectedError = "archive_payload_missing";
        }
        if (fault === "catalog-race") {
          let reads = 0;
          reader = {
            ...reader,
            async read() {
              if (++reads === 2) await f.catalog.beginMaintenance(authorized, "supersede");
              return f.catalog.read();
            },
          };
        }
        const bookWrites = f.b.faults.writes;
        await expect(
          prepareArchiveRestoreImage(
            f.store,
            reader,
            scope,
            scope.objectId,
            catalogHash,
            permitHash,
          ),
        ).rejects.toThrow(expectedError);
        expect(f.b.faults.writes).toBe(bookWrites);
        expect(await f.owner.readPending()).toBeUndefined();
      } finally {
        f.close();
      }
    });
  });

for (const damage of ["missing-field", "permit-digest", "approver", "head", "nonce"] as const)
  test(`catalog rejects ${damage} in restore permits even with a recomputed outer catalog hash`, async () => {
    await withBucket(async (bucket) => {
      const f = await setup(bucket);
      try {
        const { authorized } = await authorizeFixture(f);
        const damaged = JSON.parse(JSON.stringify(authorized));
        if (damage === "missing-field") delete damaged.restorePermit;
        if (damage === "permit-digest") damaged.restorePermit.contentHash = "0".repeat(64);
        if (damage === "approver") damaged.restorePermit.approvedBy = "attacker";
        if (damage === "head") damaged.restorePermit.anchor.head.protocolHash = "0".repeat(64);
        if (damage === "nonce") damaged.restorePermit.control.nonce = "not-a-storage-nonce";
        delete damaged.contentHash;
        const record = {
          ...damaged,
          contentHash: hashCanonical({
            domain: "rastrata-sqlite-archive-catalog-v1",
            body: JSON.stringify(damaged),
          }).digest,
        };
        f.c.db.query("UPDATE ledger_archive_catalog SET record = ?").run(JSON.stringify(record));
        await expect(f.catalog.read()).rejects.toThrow(
          damage === "missing-field"
            ? "archive_catalog_record_corrupt"
            : "archive_restore_permit_invalid",
        );
      } finally {
        f.close();
      }
    });
  });

test("unpublished abandonment preserves financial history and permanently excludes the already admitted publisher", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    let release!: () => void;
    let publishing: Promise<unknown> | undefined;
    try {
      const outcome = evaluateOutcomePayload(genesis(), activation());
      if (!outcome.encoded) throw new Error("Missing outcome");
      const selected = await f.owner.select(f.store, f.anchor, outcome.encoded, "delayed");
      let arrived!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const parked = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const delayed = new R2ArchiveObjectStore(
        {
          get: (key) => bucket.get(key),
          async put(key, value, options) {
            if (key.endsWith("/control/anchor")) {
              arrived();
              await gate;
            }
            return bucket.put(key, value, options);
          },
        },
        scope,
        scope.objectId,
      );
      publishing = f.owner.publishPending(delayed, f.catalog).then(
        () => "published",
        (error: Error) => error.message,
      );
      await parked;
      const maintenance = await f.catalog.beginMaintenance(f.active, "exclude-old-publisher");
      const sealed = await f.catalog.sealFence(maintenance, "seal", f.store);
      const sqlBefore = f.b.db.query("SELECT head FROM ledger_metadata").get();
      const result = await f.owner.abandonUnpublished(
        f.store,
        f.catalog,
        selected.selectionHash,
        sealed.contentHash,
      );
      expect(result.disposition).toBe("abandoned");
      expect(result.evidence.catalog).toEqual(sealed);
      expect(await f.catalog.read()).toEqual(sealed);
      expect(f.b.db.query("SELECT head FROM ledger_metadata").get()).toEqual(sqlBefore);
      expect(f.b.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
        count: 0,
      });
      expect(f.b.db.query("SELECT count(*) AS count FROM ledger_archive_chunks").get()).toEqual({
        count: 0,
      });
      expect(() => new SqliteBookStorage(scope.objectId, f.b.port).load(scope)).toThrow(
        "ledger_archive_owner_required",
      );
      const reopened = new SqliteArchiveSelection(scope.objectId, f.b.port, scope);
      const writes = f.b.faults.writes;
      expect(
        await reopened.abandonUnpublished(
          f.store,
          f.catalog,
          selected.selectionHash,
          sealed.contentHash,
        ),
      ).toEqual({ ...result, disposition: "already-abandoned" });
      expect(f.b.faults.writes).toBe(writes);
      const active = await f.catalog.finishMaintenance(sealed, "finish", f.store, f.verifier);
      expect(active.entry.status).toBe("active");
      // Resume only AFTER reopening and releasing maintenance. Exclusion must
      // persist independently of current status and the local pending row.
      release();
      expect(await publishing).toBe("archive_publish_conflict");
      if (!sealed.sealed) throw new Error("Missing sealed fence");
      expect(await currentAnchor(f.store)).toEqual(sealed.sealed.anchor);
      expect(await reopened.readPending()).toBeUndefined();
      expect(
        await reopened.abandonUnpublished(
          f.store,
          f.catalog,
          selected.selectionHash,
          sealed.contentHash,
        ),
      ).toEqual({ ...result, disposition: "already-abandoned" });
    } finally {
      release?.();
      await publishing?.catch(() => {});
      f.close();
    }
  });
});

for (const fault of [
  "UPDATE ledger_archive_owner SET abandonment_record",
  "DELETE FROM ledger_archive_chunks",
  "UPDATE ledger_metadata SET archive_selection_hash = NULL",
])
  test(`abandonment rolls back the entire local clear after ${fault}`, async () => {
    await withBucket(async (bucket) => {
      const f = await setup(bucket);
      try {
        const { selected, sealed } = await selectAndFence(f);
        f.b.faults.afterSql = fault;
        await expect(
          f.owner.abandonUnpublished(
            f.store,
            f.catalog,
            selected.selectionHash,
            sealed.contentHash,
          ),
        ).rejects.toThrow("injected catalog SQL failure");
        f.b.faults.afterSql = "";
        expect(await f.owner.readPending()).toEqual(selected);
        expect(f.b.db.query("SELECT abandonment_record FROM ledger_archive_owner").get()).toEqual({
          abandonment_record: null,
        });
        expect(f.b.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
          count: 0,
        });
        expect(
          (
            await f.owner.abandonUnpublished(
              f.store,
              f.catalog,
              selected.selectionHash,
              sealed.contentHash,
            )
          ).disposition,
        ).toBe("abandoned");
      } finally {
        f.close();
      }
    });
  });

test("lost abandonment durability response retains an exact read-only recovery receipt", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    try {
      const { selected, sealed } = await selectAndFence(f);
      f.b.faults.loseSyncAfter = "UPDATE ledger_archive_owner SET abandonment_record";
      await expect(
        f.owner.abandonUnpublished(f.store, f.catalog, selected.selectionHash, sealed.contentHash),
      ).rejects.toThrow("lost catalog sync response");
      const writes = f.b.faults.writes;
      const replacement = new SqliteArchiveSelection(scope.objectId, f.b.port, scope);
      const result = await replacement.abandonUnpublished(
        f.store,
        f.catalog,
        selected.selectionHash,
        sealed.contentHash,
      );
      expect(result.disposition).toBe("already-abandoned");
      expect(result.evidence.selectionHash).toBe(selected.selectionHash);
      expect(f.b.faults.writes).toBe(writes);
      expect(await replacement.readPending()).toBeUndefined();
      await expect(
        replacement.abandonUnpublished(f.store, f.catalog, selected.selectionHash, "0".repeat(64)),
      ).rejects.toThrow("archive_selection_changed");
    } finally {
      f.close();
    }
  });
});

test("concurrent identical abandonment requests produce one local mutation and one retained result", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    try {
      const { selected, sealed } = await selectAndFence(f);
      const results = await Promise.all(
        [f.owner, new SqliteArchiveSelection(scope.objectId, f.b.port, scope)].map((owner) =>
          owner.abandonUnpublished(f.store, f.catalog, selected.selectionHash, sealed.contentHash),
        ),
      );
      expect(results.map((x) => x.disposition).sort()).toEqual(["abandoned", "already-abandoned"]);
      expect(results[0]?.evidence).toEqual(results[1]?.evidence);
      expect(await f.owner.readPending()).toBeUndefined();
    } finally {
      f.close();
    }
  });
});

for (const attack of [
  "unsealed",
  "published",
  "stale",
  "changed-control",
  "missing-manifest",
  "catalog-changed-during-read",
  "wrong-reader",
  "forged-proof",
] as const)
  test(`abandonment refuses ${attack} and leaves the exact selection recoverable`, async () => {
    await withBucket(async (bucket) => {
      const f = await setup(bucket);
      try {
        const outcome = evaluateOutcomePayload(genesis(), activation());
        if (!outcome.encoded) throw new Error("Missing outcome");
        const selected = await f.owner.select(f.store, f.anchor, outcome.encoded, "negative");
        if (attack === "published") await f.owner.publishPending(f.store, f.catalog);
        const maintenance = await f.catalog.beginMaintenance(f.active, "maintenance");
        const sealed =
          attack === "unsealed"
            ? maintenance
            : await f.catalog.sealFence(maintenance, "seal", f.store);
        let reader = { catalogObjectId: f.catalog.catalogObjectId, read: () => f.catalog.read() };
        let expectedError = "archive_abandonment_corrupt";
        if (attack === "unsealed") expectedError = "archive_abandonment_not_sealed";
        if (attack === "stale") {
          await f.catalog.beginMaintenance(sealed, "supersede");
          expectedError = "archive_catalog_head_conflict";
        }
        if (attack === "changed-control") {
          const control = await f.store.readControl();
          if (!control) throw new Error("Missing control");
          await f.store.compareAndSwapControl(control, control.body);
          expectedError = "archive_book_control_changed";
        }
        if (attack === "missing-manifest") {
          expect(await bucket.get(f.anchor.manifest.objectKey)).not.toBeNull();
          await bucket.delete(f.anchor.manifest.objectKey);
          expect(await bucket.get(f.anchor.manifest.objectKey)).toBeNull();
          expectedError = "archive_payload_missing";
        }
        if (attack === "catalog-changed-during-read") {
          let reads = 0;
          reader = {
            ...reader,
            async read() {
              if (++reads === 2) await f.catalog.beginMaintenance(sealed, "supersede");
              return f.catalog.read();
            },
          };
          expectedError = "archive_catalog_head_conflict";
        }
        if (attack === "wrong-reader") {
          reader = { ...reader, catalogObjectId: "different-catalog" };
          expectedError = "archive_catalog_record_corrupt";
        }
        if (attack === "forged-proof") {
          reader = {
            ...reader,
            async read() {
              return { ...sealed, revision: "999" };
            },
          };
          expectedError = "archive_catalog_record_corrupt";
        }
        const writes = f.b.faults.writes;
        await expect(
          f.owner.abandonUnpublished(f.store, reader, selected.selectionHash, sealed.contentHash),
        ).rejects.toThrow(expectedError);
        expect(await f.owner.readPending()).toEqual(selected);
        expect(f.b.faults.writes).toBe(writes);
        expect(f.b.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
          count: 0,
        });
      } finally {
        f.close();
      }
    });
  });

test("old abandonment cannot clear a newer selection or supersede a newer abandonment receipt", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    try {
      const first = await selectAndFence(f, "first");
      await f.owner.abandonUnpublished(
        f.store,
        f.catalog,
        first.selected.selectionHash,
        first.sealed.contentHash,
      );
      await f.catalog.finishMaintenance(first.sealed, "finish-first", f.store, f.verifier);
      const second = await selectAndFence(f, "second");
      await expect(
        f.owner.abandonUnpublished(
          f.store,
          f.catalog,
          first.selected.selectionHash,
          first.sealed.contentHash,
        ),
      ).rejects.toThrow("archive_selection_changed");
      expect(await f.owner.readPending()).toEqual(second.selected);
      await f.owner.abandonUnpublished(
        f.store,
        f.catalog,
        second.selected.selectionHash,
        second.sealed.contentHash,
      );
      await expect(
        f.owner.abandonUnpublished(
          f.store,
          f.catalog,
          first.selected.selectionHash,
          first.sealed.contentHash,
        ),
      ).rejects.toThrow("archive_selection_changed");
      expect(
        (
          await f.owner.abandonUnpublished(
            f.store,
            f.catalog,
            second.selected.selectionHash,
            second.sealed.contentHash,
          )
        ).disposition,
      ).toBe("already-abandoned");
    } finally {
      f.close();
    }
  });
});

test("abandonment requires a strictly newer fence, not a merely matching sealed fence", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    try {
      const maintenance = await f.catalog.beginMaintenance(f.active, "maintain");
      const sealed = await f.catalog.sealFence(maintenance, "seal", f.store);
      const outcome = evaluateOutcomePayload(genesis(), activation());
      if (!outcome.encoded) throw new Error("Missing outcome");
      // Internal reservation alone is not admission to publish during maintenance.
      const selected = await f.owner.select(
        f.store,
        await currentAnchor(f.store),
        outcome.encoded,
        "same-fence",
      );
      expect(selected.manifest.fenceGeneration).toBe("1");
      await expect(
        f.owner.abandonUnpublished(f.store, f.catalog, selected.selectionHash, sealed.contentHash),
      ).rejects.toThrow("archive_abandonment_corrupt");
      expect(await f.owner.readPending()).toEqual(selected);
    } finally {
      f.close();
    }
  });
});

test("a delayed abandonment cannot clear a new selection installed during verification", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    try {
      const { selected, sealed } = await selectAndFence(f);
      let reads = 0;
      const reader = {
        catalogObjectId: f.catalog.catalogObjectId,
        async read() {
          const observed = await f.catalog.read();
          if (++reads === 2) {
            await f.owner.abandonUnpublished(
              f.store,
              f.catalog,
              selected.selectionHash,
              sealed.contentHash,
            );
            await f.owner.select(
              f.store,
              await currentAnchor(f.store),
              selected.encodedOutcome,
              "new-selection",
            );
          }
          return observed;
        },
      };
      await expect(
        f.owner.abandonUnpublished(f.store, reader, selected.selectionHash, sealed.contentHash),
      ).rejects.toThrow("archive_selection_changed");
      expect((await f.owner.readPending())?.manifest.candidateId).toBe("new-selection");
      expect(f.b.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
        count: 0,
      });
    } finally {
      f.close();
    }
  });
});

test("abandonment evidence remains historical after materialization and works at nonzero full heads", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    try {
      const first = await selectAndFence(f);
      const original = await f.owner.abandonUnpublished(
        f.store,
        f.catalog,
        first.selected.selectionHash,
        first.sealed.contentHash,
      );
      await f.catalog.finishMaintenance(first.sealed, "finish", f.store, f.verifier);
      const activationOutcome = evaluateOutcomePayload(genesis(), activation());
      if (!activationOutcome.encoded) throw new Error("Missing activation");
      await f.owner.select(
        f.store,
        await currentAnchor(f.store),
        activationOutcome.encoded,
        "real-activation",
      );
      await f.owner.publishPending(f.store, f.catalog);
      await f.owner.reconcilePublished(f.store, f.catalog);
      expect(
        await f.owner.abandonUnpublished(
          f.store,
          f.catalog,
          first.selected.selectionHash,
          first.sealed.contentHash,
        ),
      ).toEqual({ ...original, disposition: "already-abandoned" });
      const afterActivation = {
        state: activationOutcome.transition.state,
        protocol: activationOutcome.transition.protocol,
      };
      const sale = evaluateOutcomePayload(afterActivation, posting());
      if (!sale.encoded) throw new Error("Missing sale");
      const selected = await f.owner.select(
        f.store,
        await currentAnchor(f.store),
        sale.encoded,
        "discard-sale",
      );
      const maintenance = await f.catalog.beginMaintenance(await f.catalog.read(), "maintain-sale");
      const sealed = await f.catalog.sealFence(maintenance, "seal-sale", f.store);
      const result = await f.owner.abandonUnpublished(
        f.store,
        f.catalog,
        selected.selectionHash,
        sealed.contentHash,
      );
      expect(result.evidence.priorAnchor.head).toEqual(selected.manifest.before);
      expect(result.evidence.priorAnchor.head.sequence).toBe("1");
      expect(f.b.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
        count: 1,
      });
      expect(f.b.db.query("SELECT head FROM ledger_metadata").get()).toEqual({
        head: JSON.stringify(selected.manifest.before),
      });
      if (!sealed.sealed) throw new Error("Missing sealed fence");
      expect((await f.owner.verifyArchiveHead(f.store, sealed.sealed.anchor)).head).toEqual(
        selected.manifest.before,
      );
    } finally {
      f.close();
    }
  });
});

for (const mutation of [
  "UPDATE ledger_archive_owner SET abandonment_hash = 'corrupt'",
  "UPDATE ledger_archive_owner SET abandonment_record = abandonment_record || ' '",
  "UPDATE ledger_archive_owner SET abandonment_record = NULL",
  "UPDATE ledger_archive_owner SET abandonment_record = CAST(zeroblob(65537) AS TEXT)",
])
  test(`damaged abandonment evidence is not repaired: ${mutation}`, async () => {
    await withBucket(async (bucket) => {
      const f = await setup(bucket);
      try {
        const { selected, sealed } = await selectAndFence(f);
        await f.owner.abandonUnpublished(
          f.store,
          f.catalog,
          selected.selectionHash,
          sealed.contentHash,
        );
        f.b.db.exec(mutation);
        await expect(f.owner.readPending()).rejects.toThrow("archive_abandonment_corrupt");
        await expect(
          f.owner.abandonUnpublished(
            f.store,
            f.catalog,
            selected.selectionHash,
            sealed.contentHash,
          ),
        ).rejects.toThrow("archive_abandonment_corrupt");
        await expect(f.owner.reserveBook(encodedGenesis)).rejects.toThrow(
          "archive_abandonment_corrupt",
        );
      } finally {
        f.close();
      }
    });
  });

for (const mode of ["published", "unpublished"] as const)
  test(`real workerd catalog and book objects recover ${mode} selection across separate SQLite stores`, async () => {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "runtime-catalog-worker.ts")],
      target: "node",
      format: "esm",
      external: ["node:crypto"],
    });
    expect(build.success).toBe(true);
    const output = build.outputs[0];
    if (!output) throw new Error("Missing catalog worker");
    const directory = mkdtempSync(join(tmpdir(), "rastrata-native-catalog-"));
    const options = {
      modules: true,
      script: await output.text(),
      compatibilityDate: "2026-07-30",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: {
        BOOKS: { className: "CatalogBookObject", useSQLite: true },
        CATALOGS: { className: "ArchiveCatalogObject", useSQLite: true },
      },
      durableObjectsPersist: join(directory, "objects"),
      r2Buckets: ["ARCHIVE"],
      r2Persist: join(directory, "r2"),
      cf: false,
    };
    let runtime = new Miniflare(options);
    const call = async (path: string) => {
      const response = await runtime.dispatchFetch(`http://catalog.test${path}`);
      const body = await response.text();
      if (!response.ok) throw new Error(body);
      return JSON.parse(body);
    };
    try {
      const initial = await call("/init");
      expect(initial.entry.status).toBe("active");
      expect(initial.catalogObjectId).not.toBe(initial.entry.identity.objectId);
      const selected = await call("/select");
      if (mode === "published") await call("/publish");
      const maintenance = await call("/begin");
      expect(maintenance.entry.fenceGeneration).toBe("1");
      await runtime.dispose();
      runtime = new Miniflare(options);
      expect(await call("/catalog")).toEqual(maintenance);
      const sealed = await call("/seal");
      expect(sealed.sealed.anchor.head.sequence).toBe(mode === "published" ? "1" : "0");
      await expect(call("/finish")).rejects.toThrow("archive_selection_pending");
      await runtime.dispose();
      runtime = new Miniflare(options);
      expect(await call("/catalog")).toEqual(sealed);
      const abandonPath = `/abandon?selectionHash=${selected.selectionHash}&catalogHash=${sealed.contentHash}`;
      if (mode === "published") {
        await expect(call(abandonPath)).rejects.toThrow("archive_abandonment_corrupt");
        expect((await call("/reconcile")).selected).toEqual(selected);
      } else {
        const abandoned = await call(abandonPath);
        expect(abandoned.disposition).toBe("abandoned");
        expect(abandoned.evidence.selectionHash).toBe(selected.selectionHash);
        await runtime.dispose();
        runtime = new Miniflare(options);
        expect(await call(abandonPath)).toEqual({ ...abandoned, disposition: "already-abandoned" });
      }
      const finished = await call("/finish");
      expect(finished.entry.status).toBe("active");
      expect(finished.entry.fenceGeneration).toBe("1");
      await runtime.dispose();
      runtime = new Miniflare(options);
      expect(await call("/catalog")).toEqual(finished);
      const state = await call("/state");
      expect(state.outcomes).toEqual([{ count: mode === "published" ? 1 : 0 }]);
      expect(state.pending).toBeUndefined();
      expect(state.head).toEqual([
        {
          head: JSON.stringify(
            mode === "published" ? selected.manifest.resulting : selected.manifest.before,
          ),
        },
      ]);
      await call("/begin");
      await call("/seal");
      const authorized = await call("/authorize-restore");
      expect(authorized.restorePermit.approvedBy).toBe("fixture-operator");
      await runtime.dispose();
      runtime = new Miniflare(options);
      expect(await call("/catalog")).toEqual(authorized);
      const image = await call(
        `/prepare-restore?catalogHash=${authorized.contentHash}&permitHash=${authorized.restorePermit.contentHash}`,
      );
      expect(image.book.head).toEqual(JSON.parse(state.head[0].head));
      expect(image.book.outcomes).toHaveLength(mode === "published" ? 1 : 0);
      expect(image.permit).toEqual(authorized.restorePermit);
      await expect(call("/finish")).rejects.toThrow("archive_restore_unverified");
      const installPath = `/install-restore?catalogHash=${authorized.contentHash}&permitHash=${authorized.restorePermit.contentHash}`;
      const installed = await call(installPath);
      expect(installed.disposition).toBe("installed");
      expect(installed.restoredHead).toEqual(image.book.head);
      await runtime.dispose();
      runtime = new Miniflare(options);
      expect(await call(installPath)).toEqual({ ...installed, disposition: "already-installed" });
      expect((await call("/finish")).entry.status).toBe("active");
      const next = await call("/post-after-restore");
      await call("/publish");
      await call("/reconcile");
      expect(await call(installPath)).toEqual({ ...installed, disposition: "already-installed" });
      expect((await call("/state")).head).toEqual([
        { head: JSON.stringify(next.manifest.resulting) },
      ]);
      const financial = await call("/coordinator-read");
      expect(financial.head).toEqual(next.manifest.resulting);
      expect(financial.durabilityPolicy).toEqual(createArchiveDurabilityPolicy(true));
      const original = await call("/coordinator-execute");
      expect(original.disposition).toBe("replayed");
      expect(original.outcomeSequence).toBe("1");
      expect(original.originalResultHash).toEqual(
        evaluateOutcomePayload(genesis(), activation()).transition.result.resultHash,
      );
      const rejection = await call("/coordinator-execute?kind=rejection");
      expect(rejection.disposition).toBe("rejected");
      expect(rejection.originalDisposition).toBe("rejected");
      expect(rejection.outcomeSequence).toBe(mode === "published" ? "3" : "2");
      await runtime.dispose();
      runtime = new Miniflare(options);
      expect(await call("/coordinator-execute?kind=rejection")).toEqual({
        ...rejection,
        disposition: "replayed",
      });
      expect((await call("/coordinator-read")).head).toEqual(rejection.head);
      await call("/begin");
      await expect(call("/coordinator-read")).rejects.toThrow("archive_catalog_unavailable");
      await expect(call("/coordinator-execute")).rejects.toThrow("archive_catalog_unavailable");
    } finally {
      await runtime.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });

test("catalog sealing retains a publisher that wins between verification and conditional fence replacement", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    try {
      const outcome = evaluateOutcomePayload(genesis(), activation());
      if (!outcome.encoded) throw new Error("Missing outcome");
      await f.owner.select(f.store, f.anchor, outcome.encoded, "admitted");
      let release!: () => void, arrived!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const parked = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const delayed = new R2ArchiveObjectStore(
        {
          get: (key) => bucket.get(key),
          async put(key, value, options) {
            if (key.endsWith("/control/anchor")) {
              arrived();
              await gate;
            }
            return bucket.put(key, value, options);
          },
        },
        scope,
        scope.objectId,
      );
      const publisher = f.owner.publishPending(delayed, f.catalog).then(
        () => "published",
        (error: Error) => error.message,
      );
      await parked;
      const maintenance = await f.catalog.beginMaintenance(f.active, "maintenance");
      let raced = false;
      const sealer = new R2ArchiveObjectStore(
        {
          get: (key) => bucket.get(key),
          async put(key, value, options) {
            if (key.endsWith("/control/anchor") && !raced) {
              raced = true;
              release();
              await publisher;
            }
            return bucket.put(key, value, options);
          },
        },
        scope,
        scope.objectId,
      );
      const sealed = await f.catalog.sealFence(maintenance, "seal", sealer);
      expect(raced).toBe(true);
      expect(await publisher).toBe("archive_catalog_fence_mismatch");
      expect(sealed.sealed?.anchor.head.sequence).toBe("1");
      expect(sealed.sealed?.anchor.fenceGeneration).toBe("1");
      expect((await f.owner.reconcilePublished(f.store, f.catalog)).head.bookRevision).toBe("1");
      expect(
        (await f.catalog.finishMaintenance(sealed, "finish", f.store, f.verifier)).entry.status,
      ).toBe("active");
    } finally {
      f.close();
    }
  });
});

test("a maintenance change after book verification defeats the old release CAS", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    try {
      const maintenance = await f.catalog.beginMaintenance(f.active, "maintenance");
      const sealed = await f.catalog.sealFence(maintenance, "seal", f.store);
      const verifier = {
        async verifyHead(anchor: ArchiveAnchor) {
          const evidence = await f.verifier.verifyHead(anchor);
          await f.catalog.beginMaintenance(sealed, "new-maintenance");
          return evidence;
        },
      };
      await expect(
        f.catalog.finishMaintenance(sealed, "late-release", f.store, verifier),
      ).rejects.toThrow("archive_catalog_head_conflict");
      const current = await f.catalog.read();
      expect(current.entry.status).toBe("maintenance");
      expect(current.entry.fenceGeneration).toBe("2");
      expect(current.sealed).toBeNull();
    } finally {
      f.close();
    }
  });
});

test("separate durable catalog supports provisioning, publication, maintenance and reopening", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    try {
      expect(f.reserved.entry.status).toBe("reserved");
      expect(f.active.entry.status).toBe("active");
      const evaluated = evaluateOutcomePayload(genesis(), activation());
      if (evaluated.encoded === null) throw new Error("Missing fixture outcome");
      const selected = await f.owner.select(f.store, f.anchor, evaluated.encoded, "activation");
      await f.owner.publishPending(f.store, f.catalog);
      await f.owner.reconcilePublished(f.store, f.catalog);
      const maintenance = await f.catalog.beginMaintenance(f.active, "maintenance");
      expect(maintenance.entry.status).toBe("maintenance");
      expect(maintenance.entry.fenceGeneration).toBe("1");
      expect(maintenance.sealed).toBeNull();
      const sealed = await f.catalog.sealFence(maintenance, "seal", f.store);
      expect(sealed.sealed?.anchor.head).toEqual(selected.manifest.resulting);
      expect(sealed.sealed?.anchor.fenceGeneration).toBe("1");
      expect(selected.manifest.fenceGeneration).toBe("0");
      const reopened = await f.catalog.finishMaintenance(sealed, "finish", f.store, f.verifier);
      expect(reopened.entry.status).toBe("active");
      expect(reopened.entry.fenceGeneration).toBe("1");
      expect(reopened.revision).toBe("4");
      if (!sealed.sealed) throw new Error("Missing sealed fence");
      expect((await f.owner.verifyArchiveHead(f.store, sealed.sealed.anchor)).head.sequence).toBe(
        "1",
      );
      expect((await f.catalog.reserve(encodedGenesis, "retry-reserve")).contentHash).toBe(
        reopened.contentHash,
      );
    } finally {
      f.close();
    }
  });
});

test("a book rollback does not roll back maintenance authority or reopen ingress", async () => {
  await withBucket(async (bucket) => {
    const dir = mkdtempSync(join(tmpdir(), "rastrata-catalog-separation-"));
    let c = sqlite(join(dir, "catalog.sqlite"));
    const b = sqlite();
    try {
      let catalog = new SqliteArchiveCatalog("catalog-object", c.port, scope);
      const owner = new SqliteArchiveSelection(scope.objectId, b.port, scope);
      const { store, anchor } = await archive(bucket);
      await owner.reserveBook(encodedGenesis);
      const reserved = await catalog.reserve(encodedGenesis, "reserve");
      const active = await catalog.activate(reserved, "activate", store, {
        verifyHead: (head) => owner.verifyArchiveHead(store, head),
      });
      const maintained = await catalog.beginMaintenance(active, "maintenance");
      c.db.close();
      c = sqlite(join(dir, "catalog.sqlite"));
      catalog = new SqliteArchiveCatalog("catalog-object", c.port, scope);
      expect(await catalog.read()).toEqual(maintained);
      // Disposable book only: simulate losing the book database, not the catalog.
      b.db.exec(
        "DROP TABLE ledger_archive_owner; DROP TABLE ledger_archive_chunks; DROP TABLE ledger_chunks; DROP TABLE ledger_outcomes; DROP TABLE ledger_metadata",
      );
      const sealed = await catalog.sealFence(maintained, "seal", store);
      await expect(
        catalog.finishMaintenance(sealed, "finish", store, {
          verifyHead: (head) => owner.verifyArchiveHead(store, head),
        }),
      ).rejects.toThrow("ledger_not_provisioned");
      expect((await catalog.readEntry(scope)).status).toBe("maintenance");
      expect((await currentAnchor(store)).head).toEqual(anchor.head);
    } finally {
      c.db.close();
      b.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("unknown selections remain fenced: a published winner reconciles, an unpublished candidate cannot reopen", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    try {
      const evaluated = evaluateOutcomePayload(genesis(), activation());
      if (evaluated.encoded === null) throw new Error("Missing outcome");
      await f.owner.select(f.store, f.anchor, evaluated.encoded, "pending");
      const maintenance = await f.catalog.beginMaintenance(f.active, "maintenance");
      const sealed = await f.catalog.sealFence(maintenance, "seal", f.store);
      await expect(
        f.catalog.finishMaintenance(sealed, "finish", f.store, f.verifier),
      ).rejects.toThrow("archive_selection_pending");
      await expect(f.owner.publishPending(f.store, f.catalog)).rejects.toThrow(
        "archive_publish_conflict",
      );
      expect((await f.catalog.read()).entry.status).toBe("maintenance");
      expect((await f.owner.readPending())?.manifest.candidateId).toBe("pending");
    } finally {
      f.close();
    }
  });
});

test("a canonical winner is retained through catalog sealing and exact reconciliation", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    try {
      const evaluated = evaluateOutcomePayload(genesis(), activation());
      if (evaluated.encoded === null) throw new Error("Missing outcome");
      const selected = await f.owner.select(f.store, f.anchor, evaluated.encoded, "winner");
      await f.owner.publishPending(f.store, f.catalog);
      const maintenance = await f.catalog.beginMaintenance(f.active, "maintenance");
      const sealed = await f.catalog.sealFence(maintenance, "seal", f.store);
      expect(sealed.sealed?.anchor.head.sequence).toBe("1");
      await expect(
        f.catalog.finishMaintenance(sealed, "finish", f.store, f.verifier),
      ).rejects.toThrow("archive_selection_pending");
      expect((await f.owner.reconcilePublished(f.store, f.catalog)).selected).toEqual(selected);
      expect(
        (await f.catalog.finishMaintenance(sealed, "finish", f.store, f.verifier)).entry.status,
      ).toBe("active");
    } finally {
      f.close();
    }
  });
});

test("concurrent catalog CAS chooses one revision and obsolete retries cannot revive it", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    try {
      const other = new SqliteArchiveCatalog("catalog-object", f.c.port, scope);
      const results = await Promise.allSettled([
        f.catalog.beginMaintenance(f.active, "first"),
        other.beginMaintenance(f.active, "second"),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const current = await f.catalog.read();
      expect(current.revision).toBe("2");
      expect(await f.catalog.beginMaintenance(f.active, current.mutation.id)).toEqual(current);
      await expect(f.catalog.sealFence(f.active, current.mutation.id, f.store)).rejects.toThrow(
        "archive_catalog_operation_conflict",
      );
      const newer = await f.catalog.beginMaintenance(current, "superseding-maintenance");
      expect(newer.entry.fenceGeneration).toBe("2");
      await expect(f.catalog.beginMaintenance(f.active, current.mutation.id)).rejects.toThrow(
        "archive_catalog_head_conflict",
      );
      expect(await f.catalog.read()).toEqual(newer);
    } finally {
      f.close();
    }
  });
});

test("lost catalog sync replies retain their mutations and exact immediate retries do not write again", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    try {
      f.c.faults.loseSyncAfter = "UPDATE ledger_archive_catalog";
      await expect(f.catalog.beginMaintenance(f.active, "uncertain")).rejects.toThrow(
        "lost catalog sync response",
      );
      const current = await f.catalog.read();
      expect(current.entry.status).toBe("maintenance");
      const writes = f.c.faults.writes;
      expect(await f.catalog.beginMaintenance(f.active, "uncertain")).toEqual(current);
      expect(f.c.faults.writes).toBe(writes);
      f.c.faults.afterSql = "UPDATE ledger_archive_catalog";
      await expect(f.catalog.sealFence(current, "seal", f.store)).rejects.toThrow(
        "injected catalog SQL failure",
      );
      f.c.faults.afterSql = "";
      expect(await f.catalog.read()).toEqual(current);
      expect((await currentAnchor(f.store)).fenceGeneration).toBe("1");
      const sealed = await f.catalog.sealFence(current, "seal", f.store);
      expect(sealed.entry.status).toBe("maintenance");
      expect(sealed.sealed?.anchor.fenceGeneration).toBe("1");
    } finally {
      f.close();
    }
  });
});

for (const applied of [false, true]) {
  test(`uncertain fence rotation ${applied ? "after" : "before"} R2 application remains resumable under maintenance`, async () => {
    await withBucket(async (bucket) => {
      const f = await setup(bucket);
      try {
        const maintenance = await f.catalog.beginMaintenance(f.active, "maintenance");
        const uncertain = new R2ArchiveObjectStore(
          {
            get: (key) => bucket.get(key),
            async put(key, value, options) {
              if (applied) await bucket.put(key, value, options);
              throw new Error("lost fence response");
            },
          },
          scope,
          scope.objectId,
        );
        await expect(f.catalog.sealFence(maintenance, "seal", uncertain)).rejects.toThrow(
          "archive_write_uncertain",
        );
        expect(await f.catalog.read()).toEqual(maintenance);
        const sealed = await f.catalog.sealFence(maintenance, "seal", f.store);
        expect(sealed.sealed?.anchor.fenceGeneration).toBe("1");
        expect(
          (await f.catalog.finishMaintenance(sealed, "finish", f.store, f.verifier)).entry.status,
        ).toBe("active");
      } finally {
        f.close();
      }
    });
  });
}

test("obsolete maintenance cannot lower a newer archive fence or release a newer catalog revision", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    try {
      const first = await f.catalog.beginMaintenance(f.active, "first");
      const sealed = await f.catalog.sealFence(first, "first-seal", f.store);
      const second = await f.catalog.beginMaintenance(sealed, "second");
      await expect(
        f.catalog.finishMaintenance(sealed, "late-finish", f.store, f.verifier),
      ).rejects.toThrow("archive_catalog_head_conflict");
      const newer = await f.catalog.sealFence(second, "second-seal", f.store);
      await expect(f.catalog.sealFence(first, "first-seal", f.store)).rejects.toThrow(
        "archive_catalog_head_conflict",
      );
      expect((await currentAnchor(f.store)).fenceGeneration).toBe("2");
      expect(await f.catalog.read()).toEqual(newer);
    } finally {
      f.close();
    }
  });
});

test("separate storage and complete book identity are enforced", async () => {
  const c = sqlite(),
    b = sqlite();
  try {
    expect(() => new SqliteArchiveCatalog(scope.objectId, c.port, scope)).toThrow(
      "archive_catalog_storage_conflict",
    );
    const catalog = new SqliteArchiveCatalog("catalog-object", c.port, scope);
    await expect(catalog.readEntry(scope)).rejects.toThrow("archive_catalog_missing");
    await catalog.reserve(encodedGenesis, "reserve");
    expect(() => new SqliteBookStorage(scope.objectId, c.port).load(scope)).toThrow(
      "archive_catalog_storage_conflict",
    );
    await expect(
      new SqliteArchiveSelection(scope.objectId, c.port, scope).reserveBook(encodedGenesis),
    ).rejects.toThrow("archive_catalog_storage_conflict");
    await new SqliteArchiveSelection(scope.objectId, b.port, scope).reserveBook(encodedGenesis);
    await expect(new SqliteArchiveCatalog("catalog-object", b.port, scope).read()).rejects.toThrow(
      "archive_catalog_storage_conflict",
    );
    await expect(catalog.readEntry({ ...scope, generation: "1" })).rejects.toThrow(
      "archive_catalog_identity_mismatch",
    );
    await expect(
      catalog.reserve(encodeDurableBook(genesis("Other cash")), "reserve"),
    ).rejects.toThrow("archive_catalog_genesis_mismatch");
  } finally {
    c.db.close();
    b.db.close();
  }
});

test("catalog reads stay bounded after 500 superseding maintenance operations", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    try {
      const before = f.c.faults.reads;
      await f.catalog.readEntry(scope);
      const queries = f.c.faults.reads - before;
      expect(queries).toBe(2);
      let current = f.active;
      for (let i = 0; i < 500; i++)
        current = await f.catalog.beginMaintenance(current, `maintenance-${i}`);
      expect(current.entry.fenceGeneration).toBe("500");
      expect(current.revision).toBe("501");
      const reads = f.c.faults.reads;
      expect(await f.catalog.readEntry(scope)).toEqual(current.entry);
      expect(f.c.faults.reads - reads).toBe(queries);
      expect(f.c.db.query("SELECT count(*) AS count FROM ledger_archive_catalog").get()).toEqual({
        count: 1,
      });
      await expect(f.catalog.beginMaintenance(f.active, "maintenance-0")).rejects.toThrow(
        "archive_catalog_head_conflict",
      );
    } finally {
      f.close();
    }
  });
});

test("catalog activation cannot substitute missing book evidence or a different full head", async () => {
  await withBucket(async (bucket) => {
    const c = sqlite(),
      b = sqlite();
    try {
      const catalog = new SqliteArchiveCatalog("catalog-object", c.port, scope);
      const owner = new SqliteArchiveSelection(scope.objectId, b.port, scope);
      const { store, anchor } = await archive(bucket);
      const reserved = await catalog.reserve(encodedGenesis, "reserve");
      await expect(
        catalog.activate(reserved, "activate", store, {
          verifyHead: (head) => owner.verifyArchiveHead(store, head),
        }),
      ).rejects.toThrow("ledger_not_provisioned");
      expect(await catalog.read()).toEqual(reserved);
      await owner.reserveBook(encodedGenesis);
      const real = await owner.verifyArchiveHead(store, anchor);
      await expect(
        catalog.activate(reserved, "activate", store, {
          async verifyHead() {
            return { ...real, head: { ...real.head, protocolHash: "a".repeat(64) } };
          },
        }),
      ).rejects.toThrow("archive_catalog_book_mismatch");
      expect(await catalog.read()).toEqual(reserved);
      expect(
        (
          await catalog.activate(reserved, "activate", store, {
            verifyHead: (head) => owner.verifyArchiveHead(store, head),
          })
        ).entry.status,
      ).toBe("active");
    } finally {
      c.db.close();
      b.db.close();
    }
  });
});

test("fence conflicts are bounded and an archive ahead of the catalog is never lowered", async () => {
  await withBucket(async (bucket) => {
    const f = await setup(bucket);
    try {
      const maintenance = await f.catalog.beginMaintenance(f.active, "maintenance");
      let puts = 0;
      const conflict = new R2ArchiveObjectStore(
        {
          get: (key) => bucket.get(key),
          async put() {
            puts++;
            return null;
          },
        },
        scope,
        scope.objectId,
      );
      await expect(f.catalog.sealFence(maintenance, "seal", conflict)).rejects.toThrow(
        "archive_catalog_fence_conflict",
      );
      expect(puts).toBe(3);
      expect(await f.catalog.read()).toEqual(maintenance);
      const before = await f.store.readControl();
      if (!before) throw new Error("Missing archive");
      expect(
        (
          await f.store.compareAndSwapControl(
            before,
            encodeArchiveAnchor({ ...f.anchor, fenceGeneration: "9" }),
          )
        ).disposition,
      ).toBe("written");
      await expect(f.catalog.sealFence(maintenance, "seal", f.store)).rejects.toThrow(
        "archive_catalog_fence_mismatch",
      );
      expect((await currentAnchor(f.store)).fenceGeneration).toBe("9");
      expect(await f.catalog.read()).toEqual(maintenance);
    } finally {
      f.close();
    }
  });
});

test("uncertain initial catalog reservation does not create a second record or activate authority", async () => {
  const c = sqlite();
  try {
    const catalog = new SqliteArchiveCatalog("catalog-object", c.port, scope);
    c.faults.loseSyncAfter = "INSERT INTO ledger_archive_catalog";
    await expect(catalog.reserve(encodedGenesis, "reserve")).rejects.toThrow(
      "lost catalog sync response",
    );
    const writes = c.faults.writes;
    const result = await catalog.reserve(encodedGenesis, "reserve");
    expect(result.entry.status).toBe("reserved");
    expect(result.revision).toBe("0");
    expect(c.faults.writes).toBe(writes);
    expect(c.db.query("SELECT count(*) AS count FROM ledger_archive_catalog").get()).toEqual({
      count: 1,
    });
  } finally {
    c.db.close();
  }
});

for (const point of ["CREATE TABLE ledger_archive_catalog", "INSERT INTO ledger_archive_catalog"]) {
  test(`catalog reservation rolls back schema and authority at ${point}`, async () => {
    const c = sqlite();
    try {
      const catalog = new SqliteArchiveCatalog("catalog-object", c.port, scope);
      c.faults.afterSql = point;
      await expect(catalog.reserve(encodedGenesis, "reserve")).rejects.toThrow(
        "injected catalog SQL failure",
      );
      c.faults.afterSql = "";
      await expect(catalog.read()).rejects.toThrow("archive_catalog_missing");
      expect((await catalog.reserve(encodedGenesis, "reserve")).entry.status).toBe("reserved");
    } finally {
      c.db.close();
    }
  });
}

for (const sql of [
  "DELETE FROM ledger_archive_catalog",
  "UPDATE ledger_archive_catalog SET record = record || ' '",
  "UPDATE ledger_archive_catalog SET record = replace(record, 'reserved', 'active')",
  "UPDATE ledger_archive_catalog SET record = zeroblob(1000000)",
]) {
  test(`catalog damage cannot become missing/new authority: ${sql}`, async () => {
    const c = sqlite();
    try {
      const catalog = new SqliteArchiveCatalog("catalog-object", c.port, scope);
      await catalog.reserve(encodedGenesis, "reserve");
      c.db.exec(sql);
      const writes = c.faults.writes;
      await expect(catalog.read()).rejects.toThrow("archive_catalog_record_corrupt");
      await expect(catalog.reserve(encodedGenesis, "reserve")).rejects.toThrow(
        "archive_catalog_record_corrupt",
      );
      expect(c.faults.writes).toBe(writes);
    } finally {
      c.db.close();
    }
  });
}

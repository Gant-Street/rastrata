import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { encodeDurableBook, decodeBookOutcome } from "@rastrata/kernel";
import { SqliteArchiveSelection } from "../src/archive-selection.ts";
import type { ArchiveCatalogEntry, ArchiveCatalogAuthority } from "../src/archive-authority.ts";
import { SqliteBookStorage, type SqliteStorage } from "../src/sqlite.ts";
import { ProductionLedger } from "../src/ledger.ts";
import { COMPACT_LEDGER_FORMAT, LEDGER_FORMAT, chunkDigest } from "../src/records.ts";
import { atomicSqlite } from "../src/sqlite-transaction.ts";
import { compactOutcomeRecord } from "../src/compact-records.ts";
import {
  ARCHIVE_RECORD_VERSION,
  createArchiveDurabilityPolicy,
  prepareArchiveGenesis,
  encodeArchiveManifest,
  encodeArchiveAnchor,
  decodeArchiveAnchor,
  prepareArchiveCommit,
  type ArchiveAnchor,
} from "../src/archive-records.ts";
import {
  R2ArchiveObjectStore,
  referenceArchivePayload,
  type ArchiveR2Bucket,
} from "../src/r2-archive-store.ts";
import { evaluateOutcomePayload } from "../src/outcome-payload.ts";
import { withBucket, type TestR2Bucket } from "./r2-fixtures.ts";
import { BOOK, activation, genesis, posting } from "./fixtures.ts";

const scope = {
  tenantId: "tenant",
  bookId: BOOK,
  objectId: "object",
  namespaceId: "archive-selection",
  generation: "0",
};
const encodedGenesis = encodeDurableBook(genesis());
const bytes = (text: string) => new TextEncoder().encode(text);
function fixture(path = ":memory:") {
  const db = new Database(path);
  if (path === ":memory:") {
    db.exec(
      "PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY; PRAGMA cache_size = -64000; PRAGMA temp_store = MEMORY;",
    );
  } else {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
  }
  const faults = { afterSql: "", loseSyncAfterSql: "", syncFailures: 0, writes: 0 };
  const stmtCache = new Map<string, ReturnType<Database["query"]>>();
  const port: SqliteStorage = {
    sql: {
      exec(sql, ...bindings) {
        if (/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)/.test(sql)) faults.writes++;
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
          throw new Error("injected archive SQL failure");
        if (faults.loseSyncAfterSql && sql.startsWith(faults.loseSyncAfterSql)) {
          faults.loseSyncAfterSql = "";
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
        throw new Error("lost archive sync response");
      }
    },
  };
  const owner = new SqliteArchiveSelection(scope.objectId, port, scope);
  const bare = new SqliteBookStorage(scope.objectId, port);
  return { db, port, owner, bare, faults };
}
async function archive(bucket: TestR2Bucket) {
  const store = new R2ArchiveObjectStore(bucket, scope, scope.objectId);
  const manifest = prepareArchiveGenesis(
    scope,
    createArchiveDurabilityPolicy(true),
    encodedGenesis,
    await store.putImmutable(bytes(encodedGenesis)),
  );
  const reference = await store.putImmutable(bytes(encodeArchiveManifest(manifest)));
  const anchor: ArchiveAnchor = {
    version: ARCHIVE_RECORD_VERSION,
    kind: "anchor",
    identity: manifest.identity,
    format: manifest.format,
    head: manifest.initialHead,
    manifest: reference,
    manifestHash: manifest.contentHash,
    fenceGeneration: "3",
  };
  expect((await store.compareAndSwapControl(null, encodeArchiveAnchor(anchor))).disposition).toBe(
    "written",
  );
  return { store, anchor, manifest };
}
function outcome(rejected = false) {
  const transition = evaluateOutcomePayload(
    genesis(),
    rejected ? posting("not-active", 0n) : activation(),
  );
  if (transition.encoded === null) throw new Error("Fixture must retain outcome");
  return transition;
}

function catalog(manifest: Awaited<ReturnType<typeof archive>>["manifest"]) {
  const state: { entry: ArchiveCatalogEntry; reads: number } = {
    entry: {
      version: "rastrata-archive-catalog-v1",
      identity: manifest.identity,
      format: manifest.format,
      durabilityPolicy: manifest.durabilityPolicy,
      genesisHash: manifest.genesisHash,
      status: "active",
      fenceGeneration: "3",
    },
    reads: 0,
  };
  const authority: ArchiveCatalogAuthority = {
    async readEntry() {
      state.reads++;
      return state.entry;
    },
  };
  return { state, authority };
}

const invalidCatalogCases: readonly [string, (entry: ArchiveCatalogEntry) => unknown][] = [
  ["missing", () => null],
  ["unknown field", (entry) => ({ ...entry, verified: true })],
  ["wrong generation", (entry) => ({ ...entry, identity: { ...entry.identity, generation: "1" } })],
  ["wrong tenant", (entry) => ({ ...entry, identity: { ...entry.identity, tenantId: "other" } })],
  ["wrong genesis", (entry) => ({ ...entry, genesisHash: "a".repeat(64) })],
  ["wrong format", (entry) => ({ ...entry, format: { ...entry.format, ledgerVersion: "wrong" } })],
  [
    "downgraded policy",
    (entry) => ({ ...entry, durabilityPolicy: createArchiveDurabilityPolicy(false) }),
  ],
  ["future version", (entry) => ({ ...entry, version: "rastrata-archive-catalog-v2" })],
  ["noncanonical fence", (entry) => ({ ...entry, fenceGeneration: "03" })],
  ["boolean fence", (entry) => ({ ...entry, fenceGeneration: true })],
  ["changed fence", (entry) => ({ ...entry, fenceGeneration: "4" })],
  ["reserved", (entry) => ({ ...entry, status: "reserved" })],
  ["retired", (entry) => ({ ...entry, status: "retired" })],
  ["maintenance", (entry) => ({ ...entry, status: "maintenance" })],
];
for (const [label, corrupt] of invalidCatalogCases) {
  test(`publication refuses ${label} catalog authority without mutating canonical history`, async () => {
    await withBucket(async (bucket) => {
      const f = fixture();
      try {
        const { store, anchor, manifest } = await archive(bucket);
        const { state } = catalog(manifest);
        await f.owner.reserveBook(encodedGenesis);
        const selected = await f.owner.select(store, anchor, outcome().encoded, "authority");
        let uploads = 0;
        const guarded = new R2ArchiveObjectStore(
          {
            get: (key) => bucket.get(key),
            async put() {
              uploads++;
              throw new Error("Unauthorized upload");
            },
          },
          scope,
          scope.objectId,
        );
        await expect(
          f.owner.publishPending(guarded, {
            async readEntry() {
              return corrupt(state.entry);
            },
          }),
        ).rejects.toThrow();
        expect(uploads).toBe(0);
        expect(await f.owner.readPending()).toEqual(selected);
        expect((await store.readControl())?.body).toBe(encodeArchiveAnchor(anchor));
        expect(f.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
          count: 0,
        });
      } finally {
        f.db.close();
      }
    });
  });
}

test("catalog accessors are not invoked as proof of authority", async () => {
  await withBucket(async (bucket) => {
    const f = fixture();
    try {
      const { store, anchor, manifest } = await archive(bucket);
      const { state } = catalog(manifest);
      await f.owner.reserveBook(encodedGenesis);
      await f.owner.select(store, anchor, outcome().encoded, "accessor");
      let calls = 0;
      const fake = { ...state.entry };
      Object.defineProperty(fake, "status", {
        enumerable: true,
        get() {
          calls++;
          return "active";
        },
      });
      await expect(
        f.owner.publishPending(store, {
          async readEntry() {
            return fake;
          },
        }),
      ).rejects.toThrow("archive_catalog_invalid");
      expect(calls).toBe(0);
    } finally {
      f.db.close();
    }
  });
});

test("partial maintenance rotation leaves a canonical result pending until catalog and anchor fences agree", async () => {
  await withBucket(async (bucket) => {
    const f = fixture();
    try {
      const { store, anchor, manifest } = await archive(bucket);
      const { state, authority } = catalog(manifest);
      await f.owner.reserveBook(encodedGenesis);
      const selected = await f.owner.select(store, anchor, outcome().encoded, "partial-rotation");
      const published = await f.owner.publishPending(store, authority);
      state.entry = { ...state.entry, status: "maintenance", fenceGeneration: "4" };
      await expect(f.owner.reconcilePublished(store, authority)).rejects.toThrow(
        "archive_catalog_fence_mismatch",
      );
      expect(await f.owner.readPending()).toEqual(selected);
      expect(f.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
        count: 0,
      });
      expect(
        (
          await store.compareAndSwapControl(
            published.control,
            encodeArchiveAnchor({ ...published.anchor, fenceGeneration: "4" }),
          )
        ).disposition,
      ).toBe("written");
      expect((await f.owner.reconcilePublished(store, authority)).selected).toEqual(selected);
      expect(state.entry.status).toBe("maintenance");
    } finally {
      f.db.close();
    }
  });
});

test("concurrent reconcilers materialize exactly one outcome", async () => {
  await withBucket(async (bucket) => {
    const f = fixture();
    try {
      const { store, anchor, manifest } = await archive(bucket);
      const { authority } = catalog(manifest);
      await f.owner.reserveBook(encodedGenesis);
      await f.owner.select(store, anchor, outcome().encoded, "concurrent-reconcile");
      await f.owner.publishPending(store, authority);
      const other = new SqliteArchiveSelection(scope.objectId, f.port, scope);
      const results = await Promise.all([
        f.owner.reconcilePublished(store, authority),
        other.reconcilePublished(store, authority),
      ]);
      expect(results.map((result) => result.disposition).sort()).toEqual([
        "already-materialized",
        "materialized",
      ]);
      expect(f.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
        count: 1,
      });
    } finally {
      f.db.close();
    }
  });
});

test("a delayed reconciler cannot clear the next selected candidate", async () => {
  await withBucket(async (bucket) => {
    const f = fixture();
    try {
      const { store, anchor, manifest } = await archive(bucket);
      const { state, authority } = catalog(manifest);
      await f.owner.reserveBook(encodedGenesis);
      const first = outcome();
      await f.owner.select(store, anchor, first.encoded, "first");
      const published = await f.owner.publishPending(store, authority);
      let reads = 0;
      const racing: ArchiveCatalogAuthority = {
        async readEntry() {
          if (++reads === 2) {
            await f.owner.reconcilePublished(store, authority);
            const next = evaluateOutcomePayload(first.transition, posting("next", 1n));
            if (next.encoded === null) throw new Error("Missing next outcome");
            await f.owner.select(store, published.anchor, next.encoded, "next");
          }
          return state.entry;
        },
      };
      const other = new SqliteArchiveSelection(scope.objectId, f.port, scope);
      await expect(other.reconcilePublished(store, racing)).rejects.toThrow(
        "archive_selection_changed",
      );
      expect((await f.owner.readPending())?.manifest.candidateId).toBe("next");
      expect(f.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
        count: 1,
      });
    } finally {
      f.db.close();
    }
  });
});

test("missing last materialization evidence is damage, not an idle book that may publish again", async () => {
  await withBucket(async (bucket) => {
    const f = fixture();
    try {
      const { store, anchor, manifest } = await archive(bucket);
      const { authority } = catalog(manifest);
      await f.owner.reserveBook(encodedGenesis);
      await f.owner.select(store, anchor, outcome().encoded, "last-proof");
      await f.owner.publishPending(store, authority);
      await f.owner.reconcilePublished(store, authority);
      f.db.exec("UPDATE ledger_archive_owner SET last_header = NULL, last_hash = NULL");
      await expect(f.owner.readPending()).rejects.toThrow("archive_materialization_corrupt");
      await expect(f.owner.reconcilePublished(store, authority)).rejects.toThrow(
        "archive_materialization_corrupt",
      );
      expect(f.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
        count: 1,
      });
    } finally {
      f.db.close();
    }
  });
});

test("lost control or canonical payload bytes cannot cause publication repair or local materialization", async () => {
  await withBucket(async (bucket) => {
    const f = fixture();
    try {
      const { store, anchor, manifest } = await archive(bucket);
      const { authority } = catalog(manifest);
      await f.owner.reserveBook(encodedGenesis);
      const selected = await f.owner.select(store, anchor, outcome().encoded, "missing-control");
      let writes = 0;
      const missingControl = new R2ArchiveObjectStore(
        {
          get: (key) => (key.endsWith("/control/anchor") ? Promise.resolve(null) : bucket.get(key)),
          async put() {
            writes++;
            throw new Error("Forbidden repair");
          },
        },
        scope,
        scope.objectId,
      );
      await expect(f.owner.publishPending(missingControl, authority)).rejects.toThrow(
        "archive_publish_conflict",
      );
      await expect(f.owner.reconcilePublished(missingControl, authority)).rejects.toThrow(
        "archive_publication_unproven",
      );
      expect(writes).toBe(0);
      await f.owner.publishPending(store, authority);
      await bucket.delete(selected.manifest.payload.objectKey);
      await expect(f.owner.publishPending(store, authority)).rejects.toThrow(
        "archive_payload_missing",
      );
      await expect(f.owner.reconcilePublished(store, authority)).rejects.toThrow(
        "archive_payload_missing",
      );
      expect(await f.owner.readPending()).toEqual(selected);
      expect(f.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
        count: 0,
      });
    } finally {
      f.db.close();
    }
  });
});

test("archive publication and materialization retain exact original outcomes through four full cycles", async () => {
  await withBucket(async (bucket) => {
    const directory = mkdtempSync(join(tmpdir(), "rastrata-archive-materialization-"));
    let f = fixture(join(directory, "book.sqlite"));
    try {
      const initialized = await archive(bucket);
      const { store } = initialized;
      const { authority } = catalog(initialized.manifest);
      let anchor = initialized.anchor;
      let aggregate = genesis();
      await f.owner.reserveBook(encodedGenesis);
      for (const [index, command] of [
        activation(),
        posting("sale", 1n),
        posting("rejected", 2n, false),
        posting("second-sale", 2n),
      ].entries()) {
        const evaluated = evaluateOutcomePayload(aggregate, command);
        if (evaluated.encoded === null) throw new Error("Missing cycle outcome");
        const selected = await f.owner.select(store, anchor, evaluated.encoded, `cycle-${index}`);
        const publication = await f.owner.publishPending(store, authority);
        expect(publication.manifest).toEqual(selected.manifest);
        expect(await f.owner.readPending()).toEqual(selected);
        expect(f.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
          count: index,
        });
        const materialized = await f.owner.reconcilePublished(store, authority);
        expect(materialized.disposition).toBe("materialized");
        expect(materialized.selected.encodedOutcome).toBe(evaluated.encoded);
        expect(await f.owner.readPending()).toBeUndefined();
        const stored = atomicSqlite(f.port, (token) =>
          f.bare.loadForArchiveInTransaction(token, scope),
        );
        expect(stored.outcomes.at(-1)?.body).toBe(evaluated.encoded);
        expect(stored.head.sequence).toBe(String(index + 1));
        expect(stored.head.bookRevision).toBe(String([1, 2, 2, 3][index]));
        expect(() => f.bare.load(scope)).toThrow("ledger_archive_owner_required");
        const writes = f.faults.writes;
        expect((await f.owner.reconcilePublished(store, authority)).disposition).toBe(
          "already-materialized",
        );
        expect(f.faults.writes).toBe(writes);
        aggregate = { state: evaluated.transition.state, protocol: evaluated.transition.protocol };
        anchor = publication.anchor;
      }
      f.db.close();
      f = fixture(join(directory, "book.sqlite"));
      const recovered = await f.owner.reconcilePublished(store, authority);
      expect(recovered.disposition).toBe("already-materialized");
      expect(recovered.head.sequence).toBe("4");
      expect(recovered.head.bookRevision).toBe("3");
      const stored = atomicSqlite(f.port, (token) =>
        f.bare.loadForArchiveInTransaction(token, scope),
      );
      expect(stored.outcomes.map((row) => row.commandId)).toEqual([
        "activate",
        "sale",
        "rejected",
        "second-sale",
      ]);
      expect(f.db.query("SELECT count(*) AS count FROM ledger_archive_chunks").get()).toEqual({
        count: 0,
      });
    } finally {
      f.db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

for (const applied of [false, true]) {
  for (const step of ["payload", "manifest", "control"] as const) {
    test(`uncertain ${step} PUT ${applied ? "after" : "before"} application never replaces the selected outcome`, async () => {
      await withBucket(async (bucket) => {
        const f = fixture();
        try {
          const { store, anchor, manifest } = await archive(bucket);
          const { authority } = catalog(manifest);
          await f.owner.reserveBook(encodedGenesis);
          const selected = await f.owner.select(store, anchor, outcome(true).encoded, "uncertain");
          const manifestKey = referenceArchivePayload(
            scope,
            scope.objectId,
            bytes(encodeArchiveManifest(selected.manifest)),
          ).objectKey;
          const faulted = new R2ArchiveObjectStore(
            {
              get: (key) => bucket.get(key),
              async put(key, value, options) {
                if (
                  (step === "payload" && key === selected.manifest.payload.objectKey) ||
                  (step === "manifest" && key === manifestKey) ||
                  (step === "control" && key.endsWith("/control/anchor"))
                ) {
                  if (applied) await bucket.put(key, value, options);
                  throw new Error("lost R2 response");
                }
                return bucket.put(key, value, options);
              },
            },
            scope,
            scope.objectId,
          );
          await expect(f.owner.publishPending(faulted, authority)).rejects.toThrow(
            "archive_write_uncertain",
          );
          expect(await f.owner.readPending()).toEqual(selected);
          expect(f.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
            count: 0,
          });
          if (step !== "control" || !applied) {
            await expect(f.owner.reconcilePublished(store, authority)).rejects.toThrow(
              "archive_publication_unproven",
            );
            await f.owner.publishPending(store, authority);
          }
          expect((await f.owner.reconcilePublished(store, authority)).selected).toEqual(selected);
          expect(f.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
            count: 1,
          });
          expect((await f.owner.reconcilePublished(store, authority)).disposition).toBe(
            "already-materialized",
          );
        } finally {
          f.db.close();
        }
      });
    });
  }
}

for (const point of [
  "INSERT INTO ledger_outcomes",
  "INSERT INTO ledger_chunks",
  "UPDATE ledger_metadata SET head",
  "UPDATE ledger_archive_owner SET last_header",
  "DELETE FROM ledger_archive_chunks",
  "UPDATE ledger_metadata SET archive_selection_hash = NULL",
]) {
  test(`canonical R2 commit survives complete SQL rollback at ${point}`, async () => {
    await withBucket(async (bucket) => {
      const f = fixture();
      try {
        const { store, anchor, manifest } = await archive(bucket);
        const { authority } = catalog(manifest);
        await f.owner.reserveBook(encodedGenesis);
        const selected = await f.owner.select(store, anchor, outcome().encoded, "sql-rollback");
        const published = await f.owner.publishPending(store, authority);
        f.faults.afterSql = point;
        await expect(f.owner.reconcilePublished(store, authority)).rejects.toThrow(
          "injected archive SQL failure",
        );
        f.faults.afterSql = "";
        expect(await f.owner.readPending()).toEqual(selected);
        expect(f.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
          count: 0,
        });
        expect((await store.readControl())?.body).toBe(encodeArchiveAnchor(published.anchor));
        const replacement = new SqliteArchiveSelection(scope.objectId, f.port, scope);
        expect((await replacement.reconcilePublished(store, authority)).selected).toEqual(selected);
        expect(f.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
          count: 1,
        });
      } finally {
        f.db.close();
      }
    });
  });
}

test("lost materialization sync response recovers the exact committed envelope without another SQL write", async () => {
  await withBucket(async (bucket) => {
    const f = fixture();
    try {
      const { store, anchor, manifest } = await archive(bucket);
      const { authority } = catalog(manifest);
      await f.owner.reserveBook(encodedGenesis);
      const selected = await f.owner.select(store, anchor, outcome(true).encoded, "lost-sync");
      await f.owner.publishPending(store, authority);
      f.faults.loseSyncAfterSql = "UPDATE ledger_metadata SET archive_selection_hash = NULL";
      await expect(f.owner.reconcilePublished(store, authority)).rejects.toThrow(
        "lost archive sync response",
      );
      const replacement = new SqliteArchiveSelection(scope.objectId, f.port, scope);
      expect(await replacement.readPending()).toBeUndefined();
      const writes = f.faults.writes;
      const result = await replacement.reconcilePublished(store, authority);
      expect(result.disposition).toBe("already-materialized");
      expect(result.selected).toEqual(selected);
      expect(result.head.bookRevision).toBe("0");
      expect(result.head.sequence).toBe("1");
      expect(f.faults.writes).toBe(writes);
    } finally {
      f.db.close();
    }
  });
});

for (const wins of ["fence", "publisher"] as const) {
  test(`maintenance after publisher admission: ${wins} wins the anchor CAS without losing the selection`, async () => {
    await withBucket(async (bucket) => {
      const f = fixture();
      try {
        const { store, anchor, manifest } = await archive(bucket);
        const { state, authority } = catalog(manifest);
        await f.owner.reserveBook(encodedGenesis);
        const selected = await f.owner.select(store, anchor, outcome().encoded, "racing");
        let rotated = false;
        const port: ArchiveR2Bucket = {
          get: (key) => bucket.get(key),
          async put(key, value, options) {
            if (!key.endsWith("/control/anchor")) return bucket.put(key, value, options);
            if (rotated) throw new Error("Unexpected second publication");
            rotated = true;
            const result = wins === "publisher" ? await bucket.put(key, value, options) : null;
            state.entry = { ...state.entry, status: "maintenance", fenceGeneration: "4" };
            const prior = await store.readControl();
            if (prior === null) throw new Error("Missing fixture control");
            const current = decodeArchiveAnchor(prior.body);
            expect(
              (
                await store.compareAndSwapControl(
                  prior,
                  encodeArchiveAnchor({ ...current, fenceGeneration: "4" }),
                )
              ).disposition,
            ).toBe("written");
            return wins === "publisher" ? result : bucket.put(key, value, options);
          },
        };
        const racing = new R2ArchiveObjectStore(port, scope, scope.objectId);
        if (wins === "fence") {
          await expect(f.owner.publishPending(racing, authority)).rejects.toThrow(
            "archive_publish_conflict",
          );
          await expect(f.owner.reconcilePublished(store, authority)).rejects.toThrow(
            "archive_publication_unproven",
          );
          expect(await f.owner.readPending()).toEqual(selected);
          expect(f.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
            count: 0,
          });
        } else {
          const published = await f.owner.publishPending(racing, authority);
          expect(published.anchor.fenceGeneration).toBe("4");
          expect(published.manifest.fenceGeneration).toBe("3");
          expect((await f.owner.reconcilePublished(store, authority)).selected).toEqual(selected);
          expect(f.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
            count: 1,
          });
        }
        expect(rotated).toBe(true);
        expect(state.entry.status).toBe("maintenance");
        expect(
          (await store.compareAndSwapControl(selected.expectedControl, encodeArchiveAnchor(anchor)))
            .disposition,
        ).toBe("conflict");
      } finally {
        f.db.close();
      }
    });
  });
}

test("maintenance during uploads prevents publication and uploaded orphans cannot clear a reservation", async () => {
  await withBucket(async (bucket) => {
    const f = fixture();
    try {
      const { store, anchor, manifest } = await archive(bucket);
      const { state, authority } = catalog(manifest);
      await f.owner.reserveBook(encodedGenesis);
      const selected = await f.owner.select(store, anchor, outcome().encoded, "upload-race");
      const faulted = new R2ArchiveObjectStore(
        {
          get: (key) => bucket.get(key),
          async put(key, value, options) {
            const result = await bucket.put(key, value, options);
            if (key === selected.manifest.payload.objectKey)
              state.entry = { ...state.entry, status: "maintenance" };
            if (key.endsWith("/control/anchor")) throw new Error("Forbidden publication reached");
            return result;
          },
        },
        scope,
        scope.objectId,
      );
      await expect(f.owner.publishPending(faulted, authority)).rejects.toThrow(
        "archive_catalog_fence_mismatch",
      );
      await expect(f.owner.reconcilePublished(store, authority)).rejects.toThrow(
        "archive_publication_unproven",
      );
      expect(await f.owner.readPending()).toEqual(selected);
      expect((await store.readControl())?.body).toBe(encodeArchiveAnchor(anchor));
    } finally {
      f.db.close();
    }
  });
});

test("a different candidate with identical financial heads is not the selected archive member", async () => {
  await withBucket(async (bucket) => {
    const f = fixture();
    try {
      const { store, anchor, manifest } = await archive(bucket);
      const { authority } = catalog(manifest);
      await f.owner.reserveBook(encodedGenesis);
      const encoded = outcome().encoded;
      const selected = await f.owner.select(store, anchor, encoded, "selected");
      const alternative = prepareArchiveCommit(
        manifest,
        anchor.manifest,
        genesis(),
        encoded,
        await store.putImmutable(bytes(encoded)),
        "not-selected",
        "3",
      );
      expect(alternative.manifest.resulting).toEqual(selected.manifest.resulting);
      const reference = await store.putImmutable(
        bytes(encodeArchiveManifest(alternative.manifest)),
      );
      const impostor = {
        ...anchor,
        head: alternative.manifest.resulting,
        manifest: reference,
        manifestHash: alternative.manifest.contentHash,
      };
      expect(
        (await store.compareAndSwapControl(selected.expectedControl, encodeArchiveAnchor(impostor)))
          .disposition,
      ).toBe("written");
      await expect(f.owner.reconcilePublished(store, authority)).rejects.toThrow(
        "archive_publication_unproven",
      );
      expect(await f.owner.readPending()).toEqual(selected);
      expect(f.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
        count: 0,
      });
    } finally {
      f.db.close();
    }
  });
});

test("native workerd SQLite reservations recover before any upload in a replacement runtime", async () => {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "runtime-archive-worker.ts")],
    target: "node",
    format: "esm",
    external: ["node:crypto"],
  });
  expect(build.success).toBe(true);
  const output = build.outputs[0];
  if (!output) throw new Error("Missing selection worker");
  const directory = mkdtempSync(join(tmpdir(), "rastrata-archive-selection-runtime-"));
  const options = {
    modules: true,
    script: await output.text(),
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { SELECTIONS: { className: "ArchiveSelectionObject", useSQLite: true } },
    durableObjectsPersist: join(directory, "sqlite"),
    r2Buckets: ["ARCHIVE"],
    r2Persist: join(directory, "r2"),
    cf: false,
  };
  let runtime = new Miniflare(options);
  const call = async (path: string) => {
    const response = await runtime.dispatchFetch(`http://selection.test${path}`);
    const body = await response.text();
    if (!response.ok) throw new Error(body);
    return JSON.parse(body);
  };
  try {
    const committed = await call("/selection-init");
    const rejected = await call("/selection-init?rejected");
    expect(committed.manifest.resulting.bookRevision).toBe("1");
    expect(rejected.manifest.resulting.bookRevision).toBe("0");
    await runtime.dispose();
    runtime = new Miniflare(options);
    for (const [suffix, selected] of [
      ["", committed],
      ["?rejected", rejected],
    ] as const) {
      const recovered = await call(`/selection-read${suffix}`);
      expect(recovered.pending).toEqual(selected);
      expect(recovered.ordinaryOwner).toBe("ledger_archive_owner_required");
      expect(recovered.canonical).toEqual([{ head: JSON.stringify(selected.expectedAnchor.head) }]);
      expect(recovered.outcomes).toEqual([{ count: 0 }]);
      expect(recovered.control).toEqual(selected.expectedControl);
    }
    for (const suffix of ["", "?rejected"]) {
      const published = await call(`/selection-publish${suffix}`);
      expect(published.anchor.head.sequence).toBe("1");
      const stillPending = await call(`/selection-read${suffix}`);
      expect(stillPending.pending.manifest.contentHash).toBe(published.manifest.contentHash);
      expect(stillPending.outcomes).toEqual([{ count: 0 }]);
    }
    await runtime.dispose();
    runtime = new Miniflare(options);
    for (const [suffix, selected] of [
      ["", committed],
      ["?rejected", rejected],
    ] as const) {
      const reconciled = await call(`/selection-reconcile${suffix}`);
      expect(reconciled.disposition).toBe("materialized");
      expect(reconciled.selected).toEqual(selected);
    }
    await runtime.dispose();
    runtime = new Miniflare(options);
    for (const [suffix, selected] of [
      ["", committed],
      ["?rejected", rejected],
    ] as const) {
      expect((await call(`/selection-reconcile${suffix}`)).disposition).toBe(
        "already-materialized",
      );
      const final = await call(`/selection-read${suffix}`);
      expect(final.pending).toBeUndefined();
      expect(final.outcomes).toEqual([{ count: 1 }]);
      expect(final.canonical).toEqual([{ head: JSON.stringify(selected.manifest.resulting) }]);
      expect(final.ordinaryOwner).toBe("ledger_archive_owner_required");
    }
  } finally {
    await runtime.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("new archive reservations block every ordinary owner path without changing canonical genesis", async () => {
  const f = fixture();
  try {
    await f.owner.reserveBook(encodedGenesis);
    expect(await f.owner.readPending()).toBeUndefined();
    const stored = atomicSqlite(f.port, (token) =>
      f.bare.loadForArchiveInTransaction(token, scope),
    );
    expect(stored.outcomes).toEqual([]);
    expect(stored.genesis).toBe(encodedGenesis);
    const evaluated = outcome();
    const record = compactOutcomeRecord(
      scope,
      stored.head,
      evaluated.transition,
      evaluated.encoded,
    );
    expect(() => f.bare.load(scope)).toThrow("ledger_archive_owner_required");
    expect(() => f.bare.commitTransition(stored.head, record)).toThrow(
      "ledger_archive_owner_required",
    );
    expect(() =>
      atomicSqlite(f.port, (token) =>
        f.bare.commitTransitionInTransaction(token, stored.head, record),
      ),
    ).toThrow("ledger_archive_owner_required");
    expect(() => f.bare.readVerifiedGenesis(scope, stored.head, stored.genesisDigest)).toThrow(
      "ledger_archive_owner_required",
    );
    expect(() => f.bare.readVerifiedOutcome(scope, record.after, 1n, "a".repeat(64))).toThrow(
      "ledger_archive_owner_required",
    );
    const oldOwner = new ProductionLedger(f.bare, scope, COMPACT_LEDGER_FORMAT);
    await expect(oldOwner.read()).rejects.toThrow("ledger_archive_owner_required");
    await expect(oldOwner.execute(activation())).rejects.toThrow("ledger_archive_owner_required");
    await f.owner.reserveBook(encodedGenesis);
    expect(f.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({ count: 0 });
  } finally {
    f.db.close();
  }
});

test("archive profile cannot silently adopt an existing SQL-only book", async () => {
  const f = fixture();
  try {
    const ledger = new ProductionLedger(f.bare, scope, COMPACT_LEDGER_FORMAT);
    await ledger.provision(genesis());
    await expect(f.owner.reserveBook(encodedGenesis)).rejects.toThrow("archive_new_book_required");
    expect((await ledger.read()).head.sequence).toBe("0");
    expect(
      f.db.query("SELECT name FROM sqlite_master WHERE name LIKE 'ledger_archive_%'").all(),
    ).toEqual([]);
  } finally {
    f.db.close();
  }
});

for (const rejected of [false, true]) {
  test(`archive selection retains exact ${rejected ? "rejected" : "committed"} receipt over SQLite reopen without publishing`, async () => {
    await withBucket(async (bucket) => {
      const dir = mkdtempSync(join(tmpdir(), "rastrata-archive-selection-"));
      let f = fixture(join(dir, "book.sqlite"));
      try {
        const { store, anchor } = await archive(bucket);
        const beforeControl = await store.readControl();
        await f.owner.reserveBook(encodedGenesis);
        const encoded = outcome(rejected).encoded as string;
        const selected = await f.owner.select(store, anchor, encoded, "candidate-a");
        const decoded = decodeBookOutcome(selected.encodedOutcome);
        expect(decoded.disposition).toBe("decoded");
        if (decoded.disposition !== "decoded") throw new Error("Invalid fixture");
        expect(decoded.payload.originalResult.disposition).toBe(
          rejected ? "rejected" : "committed",
        );
        expect(selected.manifest.before).toEqual(anchor.head);
        expect(selected.manifest.resulting.sequence).toBe("1");
        expect(selected.manifest.resulting.bookRevision).toBe(rejected ? "0" : "1");
        expect(Object.isFrozen(selected.expectedControl)).toBe(true);
        expect(await store.readControl()).toEqual(beforeControl);
        expect(await bucket.get(selected.manifest.payload.objectKey)).toBeNull();
        expect(f.db.query("SELECT head FROM ledger_metadata").get()).toEqual({
          head: JSON.stringify(anchor.head),
        });
        expect(f.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
          count: 0,
        });
        f.db.close();
        f = fixture(join(dir, "book.sqlite"));
        expect(await f.owner.readPending()).toEqual(selected);
        const writes = f.faults.writes;
        expect(await f.owner.select(store, anchor, encoded, "candidate-a")).toEqual(selected);
        expect(f.faults.writes).toBe(writes);
        await expect(f.owner.select(store, anchor, encoded, "candidate-b")).rejects.toThrow(
          "archive_selection_pending",
        );
        await expect(
          f.owner.select(store, anchor, outcome(!rejected).encoded as string, "candidate-a"),
        ).rejects.toThrow("archive_selection_pending");
        expect(await f.owner.readPending()).toEqual(selected);
      } finally {
        f.db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

test("competing owner instances select only one immutable outcome", async () => {
  await withBucket(async (bucket) => {
    const f = fixture();
    try {
      const { store, anchor } = await archive(bucket);
      await f.owner.reserveBook(encodedGenesis);
      const other = new SqliteArchiveSelection(scope.objectId, f.port, scope);
      const results = await Promise.allSettled([
        f.owner.select(store, anchor, outcome().encoded as string, "candidate-a"),
        other.select(store, anchor, outcome(true).encoded as string, "candidate-b"),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const failure = results.find((result) => result.status === "rejected");
      expect(failure?.status === "rejected" && failure.reason.message).toBe(
        "archive_selection_pending",
      );
      const winner = results.find((result) => result.status === "fulfilled");
      if (winner?.status !== "fulfilled") throw new Error("Missing winner");
      expect(await other.readPending()).toEqual(winner.value);
      expect(f.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
        count: 0,
      });
    } finally {
      f.db.close();
    }
  });
});

for (const point of [
  "INSERT INTO ledger_archive_chunks",
  "UPDATE ledger_archive_owner",
  "UPDATE ledger_metadata SET archive_selection_hash",
]) {
  test(`reservation rolls back completely after failure at ${point}`, async () => {
    await withBucket(async (bucket) => {
      const f = fixture();
      try {
        const { store, anchor } = await archive(bucket);
        await f.owner.reserveBook(encodedGenesis);
        f.faults.afterSql = point;
        await expect(
          f.owner.select(store, anchor, outcome().encoded as string, "candidate"),
        ).rejects.toThrow("injected archive SQL failure");
        f.faults.afterSql = "";
        expect(await f.owner.readPending()).toBeUndefined();
        expect(f.db.query("SELECT count(*) AS count FROM ledger_archive_chunks").get()).toEqual({
          count: 0,
        });
        expect(
          (await f.owner.select(store, anchor, outcome().encoded as string, "candidate")).manifest
            .candidateId,
        ).toBe("candidate");
      } finally {
        f.db.close();
      }
    });
  });
}

test("lost sync response preserves selection, including when R2 is subsequently unavailable", async () => {
  await withBucket(async (bucket) => {
    const f = fixture();
    try {
      const { store, anchor } = await archive(bucket);
      await f.owner.reserveBook(encodedGenesis);
      f.faults.loseSyncAfterSql = "UPDATE ledger_archive_owner";
      const encoded = outcome().encoded as string;
      await expect(f.owner.select(store, anchor, encoded, "candidate")).rejects.toThrow(
        "lost archive sync response",
      );
      const recovered = await f.owner.readPending();
      if (!recovered) throw new Error("Missing durable reservation");
      expect(recovered?.encodedOutcome).toBe(encoded);
      const unreachable = new R2ArchiveObjectStore(
        {
          async get() {
            throw new Error("unavailable");
          },
          async put() {
            throw new Error("no writes allowed");
          },
        },
        scope,
        scope.objectId,
      );
      expect(await f.owner.select(unreachable, anchor, encoded, "candidate")).toEqual(recovered);
      await expect(f.owner.select(unreachable, anchor, encoded, "different")).rejects.toThrow(
        "archive_selection_pending",
      );
    } finally {
      f.db.close();
    }
  });
});

test("missing or changed R2 predecessor cannot create a reservation", async () => {
  await withBucket(async (bucket) => {
    const f = fixture();
    try {
      const { store, anchor } = await archive(bucket);
      await f.owner.reserveBook(encodedGenesis);
      await expect(
        f.owner.select(
          store,
          { ...anchor, fenceGeneration: "4" },
          outcome().encoded as string,
          "candidate",
        ),
      ).rejects.toThrow("archive_anchor_mismatch");
      await bucket.delete(anchor.manifest.objectKey);
      await expect(
        f.owner.select(store, anchor, outcome().encoded as string, "candidate"),
      ).rejects.toThrow("archive_payload_missing");
      expect(await f.owner.readPending()).toBeUndefined();
    } finally {
      f.db.close();
    }
  });
});

test("large exact receipts use all four bounded chunks and reject over-limit input before selection", async () => {
  await withBucket(async (bucket) => {
    const f = fixture();
    try {
      const { store, anchor } = await archive(bucket);
      await f.owner.reserveBook(encodedGenesis);
      const large = evaluateOutcomePayload(
        genesis(),
        posting("chunked", 0n, true, "\u0000".repeat(150_000)),
      );
      if (!large.encoded) throw new Error("Missing chunked receipt");
      expect(bytes(large.encoded).length).toBe(903_360);
      const writes = f.faults.writes;
      await expect(
        f.owner.select(store, anchor, "x".repeat(1_048_577), "oversize"),
      ).rejects.toThrow("archive_invalid_input");
      expect(f.faults.writes).toBe(writes);
      expect(await f.owner.readPending()).toBeUndefined();
      const selected = await f.owner.select(store, anchor, large.encoded, "four-chunks");
      expect(
        f.db
          .query(
            "SELECT ordinal, length(bytes) AS size FROM ledger_archive_chunks ORDER BY ordinal",
          )
          .all(),
      ).toEqual([
        { ordinal: 0, size: 262_144 },
        { ordinal: 1, size: 262_144 },
        { ordinal: 2, size: 262_144 },
        { ordinal: 3, size: 116_928 },
      ]);
      expect((await f.owner.readPending())?.encodedOutcome).toBe(large.encoded);
      expect(selected.manifest.resulting.bookRevision).toBe("0");
      f.db.exec("UPDATE ledger_archive_chunks SET ordinal = 4 WHERE ordinal = 2");
      await expect(f.owner.readPending()).rejects.toThrow("archive_selection_corrupt");
    } finally {
      f.db.close();
    }
  });
});

test("different local genesis and foreign identities never reserve an archive outcome", async () => {
  await withBucket(async (bucket) => {
    const f = fixture();
    try {
      const { store, anchor } = await archive(bucket);
      await f.owner.reserveBook(encodeDurableBook(genesis("Different cash account")));
      await expect(f.owner.select(store, anchor, outcome().encoded, "candidate")).rejects.toThrow(
        "archive_prior_head_mismatch",
      );
      await expect(
        f.owner.select(
          store,
          { ...anchor, identity: { ...anchor.identity, generation: "1" } },
          outcome().encoded,
          "candidate",
        ),
      ).rejects.toThrow();
      expect(await f.owner.readPending()).toBeUndefined();
      await expect(f.owner.reserveBook(encodedGenesis)).rejects.toThrow("archive_genesis_mismatch");
    } finally {
      f.db.close();
    }
  });
});

test("selected payload decoding preserves a forged leading BOM so exact-byte verification rejects it", async () => {
  await withBucket(async (bucket) => {
    const f = fixture();
    try {
      const { store, anchor } = await archive(bucket);
      await f.owner.reserveBook(encodedGenesis);
      const selected = await f.owner.select(store, anchor, outcome().encoded, "candidate");
      const corrupted = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(selected.encodedOutcome)]);
      f.db
        .query("UPDATE ledger_archive_chunks SET bytes = ?, digest = ? WHERE ordinal = 0")
        .run(corrupted, chunkDigest(corrupted, COMPACT_LEDGER_FORMAT));
      await expect(f.owner.readPending()).rejects.toThrow();
      await expect(
        f.owner.select(store, anchor, selected.encodedOutcome, "candidate"),
      ).rejects.toThrow();
    } finally {
      f.db.close();
    }
  });
});

for (const format of [LEDGER_FORMAT, COMPACT_LEDGER_FORMAT] as const) {
  test(`${format}: canonical SQLite bytes cannot acquire a leading BOM even with a recomputed chunk checksum`, async () => {
    const f = fixture();
    try {
      const identity =
        format === COMPACT_LEDGER_FORMAT
          ? scope
          : { tenantId: scope.tenantId, bookId: scope.bookId, objectId: scope.objectId };
      const ledger = new ProductionLedger(f.bare, identity, format);
      await ledger.provision(genesis());
      const corrupted = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(encodedGenesis)]);
      f.db
        .query(
          "UPDATE ledger_chunks SET bytes = ?, digest = ? WHERE record_id = 'genesis' AND ordinal = 0",
        )
        .run(corrupted, chunkDigest(corrupted, format));
      expect(f.bare.load(identity)?.genesis).toBe(`\uFEFF${encodedGenesis}`);
      await expect(ledger.read()).rejects.toThrow("recovery_record_corrupt");
      await expect(ledger.execute(activation())).rejects.toThrow("recovery_record_corrupt");
    } finally {
      f.db.close();
    }
  });
}

for (const point of [
  "ALTER TABLE ledger_metadata",
  "CREATE TABLE ledger_archive_owner",
  "INSERT INTO ledger_archive_owner",
]) {
  test(`new-book ownership is atomic at ${point}`, async () => {
    const f = fixture();
    try {
      f.faults.afterSql = point;
      await expect(f.owner.reserveBook(encodedGenesis)).rejects.toThrow(
        "injected archive SQL failure",
      );
      expect(f.db.query("SELECT name FROM sqlite_master WHERE name GLOB 'ledger_*'").all()).toEqual(
        [],
      );
      f.faults.afterSql = "";
      await f.owner.reserveBook(encodedGenesis);
      expect(() => f.bare.load(scope)).toThrow("ledger_archive_owner_required");
    } finally {
      f.db.close();
    }
  });
}

test("uncertain new-book reservation retains its profile and cannot adopt stranded indexed state", async () => {
  const f = fixture();
  const stranded = fixture();
  try {
    f.faults.loseSyncAfterSql = "INSERT INTO ledger_archive_owner";
    await expect(f.owner.reserveBook(encodedGenesis)).rejects.toThrow("lost archive sync response");
    expect(() => f.bare.load(scope)).toThrow("ledger_archive_owner_required");
    const writes = f.faults.writes;
    await f.owner.reserveBook(encodedGenesis);
    expect(f.faults.writes).toBe(writes);
    expect(await f.owner.readPending()).toBeUndefined();
    stranded.db.exec("CREATE TABLE ledger_indexed_owner (sentinel TEXT)");
    await expect(stranded.owner.reserveBook(encodedGenesis)).rejects.toThrow(
      "archive_new_book_required",
    );
  } finally {
    f.db.close();
    stranded.db.close();
  }
});

for (const sql of [
  "DROP TABLE ledger_archive_owner",
  "DROP TABLE ledger_archive_chunks",
  "DROP TABLE ledger_archive_owner; DROP TABLE ledger_archive_chunks",
  "ALTER TABLE ledger_metadata DROP COLUMN archive_owner",
]) {
  test(`archive ownership fails closed after marker corruption: ${sql}`, async () => {
    const f = fixture();
    try {
      await f.owner.reserveBook(encodedGenesis);
      const stored = atomicSqlite(f.port, (token) =>
        f.bare.loadForArchiveInTransaction(token, scope),
      );
      const transition = outcome();
      const record = compactOutcomeRecord(
        scope,
        stored.head,
        transition.transition,
        transition.encoded,
      );
      f.db.exec(sql);
      expect(() => f.bare.load(scope)).toThrow("ledger_archive_owner_required");
      expect(() => f.bare.commitTransition(stored.head, record)).toThrow(
        "ledger_archive_owner_required",
      );
      expect(() => f.bare.readVerifiedGenesis(scope, stored.head, stored.genesisDigest)).toThrow(
        "ledger_archive_owner_required",
      );
      await expect(f.owner.readPending()).rejects.toThrow();
    } finally {
      f.db.close();
    }
  });
}

for (const sql of [
  "UPDATE ledger_archive_owner SET pending_hash = 'corrupt'",
  "UPDATE ledger_archive_owner SET pending_header = pending_header || ' '",
  "UPDATE ledger_archive_owner SET pending_header = NULL, pending_hash = NULL",
  "UPDATE ledger_archive_owner SET pending_header = NULL, pending_hash = NULL; DELETE FROM ledger_archive_chunks",
  "UPDATE ledger_metadata SET archive_selection_hash = NULL",
  "UPDATE ledger_archive_chunks SET digest = 'corrupt'",
  "UPDATE ledger_archive_chunks SET bytes = zeroblob(length(bytes))",
  "DELETE FROM ledger_archive_chunks",
  'UPDATE ledger_metadata SET head = replace(head, \'"sequence":"0"\', \'"sequence":"1"\')',
]) {
  test(`selected bytes cannot be silently repaired or abandoned: ${sql}`, async () => {
    await withBucket(async (bucket) => {
      const f = fixture();
      try {
        const { store, anchor } = await archive(bucket);
        await f.owner.reserveBook(encodedGenesis);
        const encoded = outcome().encoded as string;
        await f.owner.select(store, anchor, encoded, "candidate");
        f.db.exec(sql);
        const writes = f.faults.writes;
        await expect(f.owner.readPending()).rejects.toThrow();
        await expect(f.owner.select(store, anchor, encoded, "candidate")).rejects.toThrow();
        expect(f.faults.writes).toBe(writes);
        expect(f.db.query("SELECT count(*) AS count FROM ledger_outcomes").get()).toEqual({
          count: 0,
        });
      } finally {
        f.db.close();
      }
    });
  });
}

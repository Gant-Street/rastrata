import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteIndexPageStore } from "../src/index-page-store.ts";
import {
  auditBalancedIndex,
  createIndexRoot,
  encodeIndexPage,
  enumerateIndexPages,
  prepareIndexInsert,
} from "../src/index-pages.ts";
import type { SqliteStorage } from "../src/sqlite.ts";

const H = "a".repeat(64);
const key = (n: number) => n.toString(16).padStart(64, "0");
const id = (n: number) => `derived/${key(n)}`;
function tree() {
  const left = encodeIndexPage(id(1), [{ key: key(1), sequence: 1n }]);
  const right = encodeIndexPage(id(2), [{ key: key(2), sequence: 2n }]);
  const parent = encodeIndexPage(id(3), [], [left.descriptor, right.descriptor]);
  return { left, right, parent, root: createIndexRoot(2n, parent.descriptor.page) };
}
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
  const faults = {
    afterSql: "",
    syncCalls: 0,
    failSyncAt: -1,
    hook: undefined as (() => Promise<void>) | undefined,
  };
  const stmtCache = new Map<string, ReturnType<Database["query"]>>();
  const port: SqliteStorage = {
    sql: {
      exec(query, ...bindings) {
        let stmt = stmtCache.get(query);
        if (!stmt) {
          stmt = db.query(query);
          stmtCache.set(query, stmt);
        }
        const rows = stmt.all(
          ...bindings.map((value) =>
            value instanceof ArrayBuffer ? new Uint8Array(value) : value,
          ),
        ) as Record<string, unknown>[];
        if (faults.afterSql && query.startsWith(faults.afterSql))
          throw new Error("injected SQL failure");
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
    transactionSync: (fn) => db.transaction(fn)(),
    async sync() {
      faults.syncCalls++;
      if (faults.syncCalls === faults.failSyncAt) throw new Error("lost durability confirmation");
      await faults.hook?.();
    },
  };
  const store = new SqliteIndexPageStore(port, H);
  return { db, port, faults, store };
}

test("page store retains a verified graph durably, retries exactly, and never overwrites a location", async () => {
  const f = fixture(),
    t = tree();
  try {
    await f.store.initialize();
    expect(await f.store.read(id(99))).toBeUndefined();
    expect(await f.store.readRootDescriptor(t.root.contentHash)).toBeUndefined();
    for (const page of [t.parent, t.left, t.right])
      await f.store.put(page.descriptor.page, page.bytes);
    expect(await f.store.retainRoot(t.root, t.root.contentHash)).toEqual(t.root);
    expect(await f.store.retainRoot(t.root, t.root.contentHash)).toEqual(t.root);
    expect(await f.store.readRootDescriptor(t.root.contentHash)).toEqual(t.root);
    expect(
      await Array.fromAsync(
        enumerateIndexPages(t.root, t.root.contentHash, (location) => f.store.read(location)),
      ),
    ).toEqual([
      { key: key(1), sequence: 1n },
      { key: key(2), sequence: 2n },
    ]);
    await f.store.put(t.left.descriptor.page, t.left.bytes);
    expect(f.db.query("SELECT count(*) AS count FROM ledger_index_pages").get()).toEqual({
      count: 3,
    });
    const conflict = encodeIndexPage(id(1), [{ key: key(1), sequence: 99n }]);
    await expect(f.store.put(conflict.descriptor.page, conflict.bytes)).rejects.toThrow(
      "index_page_location_conflict",
    );
    await expect(f.store.read(id(1))).rejects.toThrow("index_page_store_uncertain");
    await f.store.recover();
    expect(await f.store.read(id(1))).toEqual(t.left.bytes);
    const empty = createIndexRoot(0n, null);
    expect(await f.store.retainRoot(empty, empty.contentHash)).toEqual(empty);
  } finally {
    f.db.close();
  }
});

test("prepared COW pages require complete durable storage before root retention; old root survives every prefix", async () => {
  const leaf = encodeIndexPage(
    id(1),
    Array.from({ length: 204 }, (_, n) => ({
      key: key(n * 2),
      sequence: BigInt(n + 1),
    })),
  );
  const root = createIndexRoot(204n, leaf.descriptor.page);
  const index = await auditBalancedIndex(root, root.contentHash, async () => leaf.bytes);
  let next = 2;
  const plan = await prepareIndexInsert(
    index,
    { key: key(1), sequence: 999n },
    async () => leaf.bytes,
    () => id(next++),
  );
  expect(plan.pages).toHaveLength(3);
  for (let prefix = 0; prefix <= plan.pages.length; prefix++) {
    const f = fixture();
    try {
      await f.store.initialize();
      await f.store.put(leaf.descriptor.page, leaf.bytes);
      await f.store.retainRoot(root, root.contentHash);
      for (const page of plan.pages.slice(0, prefix))
        await f.store.put(page.descriptor.page, page.bytes);
      // Reconstruct the actual store object before attempting retention.
      const recovered = new SqliteIndexPageStore(f.port, H);
      await recovered.recover();
      expect(await recovered.readRootDescriptor(plan.after.contentHash)).toBeUndefined();
      if (prefix < plan.pages.length) {
        await expect(recovered.retainRoot(plan.after, plan.after.contentHash)).rejects.toThrow(
          "index_page_missing_or_short",
        );
        await recovered.recover();
        expect(await recovered.readRootDescriptor(plan.after.contentHash)).toBeUndefined();
      } else {
        await recovered.retainRoot(plan.after, plan.after.contentHash);
        expect(await recovered.readRootDescriptor(plan.after.contentHash)).toEqual(plan.after);
        const entries = await Array.fromAsync(
          enumerateIndexPages(plan.after, plan.after.contentHash, (location) =>
            recovered.read(location),
          ),
        );
        expect(entries).toHaveLength(205);
        expect(entries[1]).toEqual({ key: key(1), sequence: 999n });
      }
      expect(await recovered.readRootDescriptor(root.contentHash)).toEqual(root);
      expect(await recovered.read(id(1))).toEqual(leaf.bytes);
      expect(
        await Array.fromAsync(
          enumerateIndexPages(root, root.contentHash, (location) => recovered.read(location)),
        ),
      ).toEqual(
        Array.from({ length: 204 }, (_, n) => ({ key: key(n * 2), sequence: BigInt(n + 1) })),
      );
    } finally {
      f.db.close();
    }
  }
});

test("missing child or invalid child fences prevent root retention despite valid page hashes", async () => {
  const f = fixture(),
    t = tree();
  try {
    await f.store.initialize();
    await f.store.put(t.parent.descriptor.page, t.parent.bytes);
    await f.store.put(t.left.descriptor.page, t.left.bytes);
    await expect(f.store.retainRoot(t.root, t.root.contentHash)).rejects.toThrow(
      "index_page_missing_or_short",
    );
    expect(f.db.query("SELECT count(*) AS count FROM ledger_index_roots").get()).toEqual({
      count: 0,
    });
    await f.store.recover();
    await f.store.put(t.right.descriptor.page, t.right.bytes);
    await f.store.retainRoot(t.root, t.root.contentHash);
    const wrong = encodeIndexPage(id(4), [], [{ ...t.left.descriptor, max: key(2) }]);
    await f.store.put(wrong.descriptor.page, wrong.bytes);
    const root = createIndexRoot(1n, wrong.descriptor.page);
    await expect(f.store.retainRoot(root, root.contentHash)).rejects.toThrow(
      "index_page_fence_mismatch",
    );
    expect(f.db.query("SELECT count(*) AS count FROM ledger_index_roots").get()).toEqual({
      count: 1,
    });
  } finally {
    f.db.close();
  }
});

test("SQL failures roll back page/root writes and recovery never automatically reapplies them", async () => {
  const f = fixture(),
    t = tree();
  try {
    await f.store.initialize();
    f.faults.afterSql = "INSERT INTO ledger_index_pages";
    await expect(f.store.put(t.left.descriptor.page, t.left.bytes)).rejects.toThrow(
      "injected SQL failure",
    );
    f.faults.afterSql = "";
    await f.store.recover();
    expect(await f.store.read(id(1))).toBeUndefined();
    for (const page of [t.left, t.right, t.parent])
      await f.store.put(page.descriptor.page, page.bytes);
    f.faults.afterSql = "INSERT INTO ledger_index_roots";
    await expect(f.store.retainRoot(t.root, t.root.contentHash)).rejects.toThrow(
      "injected SQL failure",
    );
    f.faults.afterSql = "";
    await f.store.recover();
    expect(await f.store.readRootDescriptor(t.root.contentHash)).toBeUndefined();
    expect(await f.store.read(id(1))).toEqual(t.left.bytes);
  } finally {
    f.db.close();
  }
});

test("lost page/root confirmations gate operations and disk reopen recovers exact bytes without replaying writes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-index-page-store-"));
  const path = join(directory, "pages.sqlite");
  let f = fixture(path);
  const t = tree();
  try {
    await f.store.initialize();
    f.faults.failSyncAt = f.faults.syncCalls + 1;
    await expect(f.store.put(t.left.descriptor.page, t.left.bytes)).rejects.toThrow(
      "lost durability confirmation",
    );
    await expect(f.store.retainRoot(t.root, t.root.contentHash)).rejects.toThrow(
      "index_page_store_uncertain",
    );
    f.db.close();
    f = fixture(path);
    await f.store.recover();
    expect(await f.store.read(id(1))).toEqual(t.left.bytes);
    await f.store.put(t.left.descriptor.page, t.left.bytes);
    await f.store.put(t.right.descriptor.page, t.right.bytes);
    await f.store.put(t.parent.descriptor.page, t.parent.bytes);
    f.faults.failSyncAt = f.faults.syncCalls + 2; // initial barrier succeeds; root acknowledgement is lost.
    await expect(f.store.retainRoot(t.root, t.root.contentHash)).rejects.toThrow(
      "lost durability confirmation",
    );
    await expect(f.store.readRootDescriptor(t.root.contentHash)).rejects.toThrow(
      "index_page_store_uncertain",
    );
    f.db.close();
    f = fixture(path);
    await f.store.recover();
    expect(await f.store.readRootDescriptor(t.root.contentHash)).toEqual(t.root);
    expect(
      (
        await Array.fromAsync(
          enumerateIndexPages(t.root, t.root.contentHash, (location) => f.store.read(location)),
        )
      ).length,
    ).toBe(2);
    expect(f.db.query("SELECT count(*) AS count FROM ledger_index_pages").get()).toEqual({
      count: 3,
    });
    expect(f.db.query("SELECT count(*) AS count FROM ledger_index_roots").get()).toEqual({
      count: 1,
    });
  } finally {
    f.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("queued input bytes are owned before caller mutation and response waits for sync", async () => {
  const f = fixture(),
    t = tree();
  try {
    await f.store.initialize();
    const entered = Promise.withResolvers<void>(),
      released = Promise.withResolvers<void>();
    f.faults.hook = async () => {
      entered.resolve();
      await released.promise;
    };
    const input = t.left.bytes.slice();
    let settled = false;
    const putting = f.store.put(t.left.descriptor.page, input).then(() => {
      settled = true;
    });
    input.fill(255);
    await entered.promise;
    expect(settled).toBe(false);
    expect(f.db.query("SELECT count(*) AS count FROM ledger_index_pages").get()).toEqual({
      count: 1,
    });
    released.resolve();
    await putting;
    f.faults.hook = undefined;
    const fetched = await f.store.read(id(1));
    expect(fetched).toEqual(t.left.bytes);
    fetched?.fill(255);
    expect(await f.store.read(id(1))).toEqual(t.left.bytes);
  } finally {
    f.db.close();
  }
});

test("full trusted store identity and explicit initialization prevent accidental reassignment", async () => {
  const f = fixture();
  try {
    await f.store.initialize();
    const other = new SqliteIndexPageStore(f.port, "b".repeat(64));
    await expect(other.recover()).rejects.toThrow("index_page_store_identity_mismatch");
    await expect(f.store.initialize()).rejects.toThrow();
    await f.store.recover();
    f.db.query("UPDATE ledger_index_page_metadata SET identity_hash = ?").run(`${H}\0hidden`);
    await expect(f.store.recover()).rejects.toThrow("index_page_store_identity_mismatch");
    expect(() => new SqliteIndexPageStore(f.port, "bad")).toThrow(
      "index_page_store_identity_invalid",
    );
  } finally {
    f.db.close();
  }
});

test("two store instances serialize competing immutable-location writes in SQLite", async () => {
  const f = fixture(),
    t = tree();
  try {
    await f.store.initialize();
    const other = new SqliteIndexPageStore(f.port, H);
    const conflict = encodeIndexPage(id(1), [{ key: key(1), sequence: 7n }]);
    const results = await Promise.allSettled([
      f.store.put(t.left.descriptor.page, t.left.bytes),
      other.put(conflict.descriptor.page, conflict.bytes),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(f.db.query("SELECT count(*) AS count FROM ledger_index_pages").get()).toEqual({
      count: 1,
    });
    await f.store.recover();
    await other.recover();
    const stored = await f.store.read(id(1));
    const winner = results[0]?.status === "fulfilled" ? t.left : conflict;
    expect(stored).toEqual(winner.bytes);
    await other.put(winner.descriptor.page, winner.bytes);
    expect(await other.read(id(1))).toEqual(stored);
    expect(() => f.store.read("canonical/page")).toThrow("index_page_location_invalid");
    expect(() => f.store.readRootDescriptor("bad")).toThrow("index_root_hash_mismatch");
  } finally {
    f.db.close();
  }
});

test("failed initialization is atomic and lost read/recovery confirmation cannot bypass uncertainty", async () => {
  const f = fixture(),
    t = tree();
  try {
    f.faults.afterSql = "CREATE TABLE ledger_index_roots";
    await expect(f.store.initialize()).rejects.toThrow("injected SQL failure");
    expect(
      f.db.query("SELECT name FROM sqlite_master WHERE name LIKE 'ledger_index_%'").all(),
    ).toEqual([]);
    f.faults.afterSql = "";
    const fresh = new SqliteIndexPageStore(f.port, H);
    await fresh.initialize();
    await fresh.put(t.left.descriptor.page, t.left.bytes);
    f.faults.failSyncAt = f.faults.syncCalls + 1;
    await expect(fresh.read(id(1))).rejects.toThrow("lost durability confirmation");
    await expect(fresh.read(id(1))).rejects.toThrow("index_page_store_uncertain");
    f.faults.failSyncAt = f.faults.syncCalls + 1;
    await expect(fresh.recover()).rejects.toThrow("lost durability confirmation");
    await expect(fresh.put(t.left.descriptor.page, t.left.bytes)).rejects.toThrow(
      "index_page_store_uncertain",
    );
    await fresh.recover();
    expect(await fresh.read(id(1))).toEqual(t.left.bytes);
    f.db.query("DELETE FROM ledger_index_page_metadata").run();
    await expect(fresh.recover()).rejects.toThrow("index_page_store_identity_mismatch");
    expect(f.db.query("SELECT count(*) AS count FROM ledger_index_pages").get()).toEqual({
      count: 1,
    });
  } finally {
    f.db.close();
  }
});

test("corrupt stored bytes, NUL suffixes and noncanonical root JSON fail closed", async () => {
  const f = fixture(),
    t = tree();
  try {
    await f.store.initialize();
    for (const page of [t.left, t.right, t.parent])
      await f.store.put(page.descriptor.page, page.bytes);
    await f.store.retainRoot(t.root, t.root.contentHash);
    f.db
      .query("UPDATE ledger_index_pages SET digest = ? WHERE location = ?")
      .run(`${t.left.descriptor.page.digest}\0hidden`, id(1));
    await expect(f.store.read(id(1))).rejects.toThrow("index_page_store_corrupt");
    f.db
      .query("UPDATE ledger_index_pages SET digest = ? WHERE location = ?")
      .run(t.left.descriptor.page.digest, id(1));
    await f.store.recover();
    for (const body of [
      `${JSON.stringify(t.root)}\0hidden`,
      ` ${JSON.stringify(t.root)}`,
      JSON.stringify(t.root).replace("{", '{"population":"2",'),
      "x".repeat(4_097),
      "{broken",
    ]) {
      f.db.query("UPDATE ledger_index_roots SET body = ?").run(body);
      await expect(f.store.readRootDescriptor(t.root.contentHash)).rejects.toThrow(
        "index_root_store_corrupt",
      );
      await f.store.recover();
    }
    f.db
      .query(
        "UPDATE ledger_index_pages SET bytes = zeroblob(1000000), byte_count = 1000000 WHERE location = ?",
      )
      .run(id(1));
    await expect(f.store.read(id(1))).rejects.toThrow("index_page_length_invalid");
    await f.store.recover();
    f.db
      .query("UPDATE ledger_index_pages SET bytes = ?, byte_count = ? WHERE location = ?")
      .run(new Uint8Array(t.left.bytes.length), t.left.bytes.length, id(1));
    await expect(f.store.read(id(1))).rejects.toThrow("index_page_hash_mismatch");
  } finally {
    f.db.close();
  }
});

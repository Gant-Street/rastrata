import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { hashCanonical } from "@rastrata/kernel";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyIndexRoot,
  SqliteIndexControl,
  type IndexAnchor,
  type IndexControl,
} from "../src/index-control.ts";
import type { SqliteStorage } from "../src/sqlite.ts";
import { SqliteIndexPageStore } from "../src/index-page-store.ts";
import {
  auditBalancedIndex,
  createIndexRoot,
  encodeIndexPage,
  enumerateIndexPages,
  INDEX_KEY_SCHEMA,
  prepareIndexInsert,
} from "../src/index-pages.ts";

const H = (label: string) => hashCanonical({ label }).digest;
function fixture(path = ":memory:", existing = false) {
  const clock = { now: 10n };
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
    maxReturnedRows: 0,
    syncFailures: 0,
    syncHook: undefined as (() => Promise<void>) | undefined,
    lastSweepSql: "",
  };
  const stmtCache = new Map<string, ReturnType<Database["query"]>>();
  const port: SqliteStorage = {
    sql: {
      exec(sql, ...bindings) {
        if (sql.startsWith("SELECT id FROM ledger_index_pins WHERE")) faults.lastSweepSql = sql;
        let stmt = stmtCache.get(sql);
        if (!stmt) {
          stmt = db.query(sql);
          stmtCache.set(sql, stmt);
        }
        const result = stmt.all(
          ...bindings.map((value) =>
            value instanceof ArrayBuffer ? new Uint8Array(value) : value,
          ),
        ) as Record<string, unknown>[];
        faults.maxReturnedRows = Math.max(faults.maxReturnedRows, result.length);
        if (faults.afterSql && sql.startsWith(faults.afterSql))
          throw new Error("injected SQL failure");
        if (faults.loseAfterSql && sql.startsWith(faults.loseAfterSql)) {
          faults.loseAfterSql = "";
          faults.syncFailures++;
        }
        for (let i = 0; i < result.length; i++) {
          const row = result[i];
          for (const key in row) {
            const value = row[key];
            if (value instanceof Uint8Array) {
              row[key] = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
            }
          }
        }
        return result;
      },
    },
    transactionSync: (fn) => db.transaction(fn)(),
    async sync() {
      if (faults.syncFailures > 0) {
        faults.syncFailures--;
        throw new Error("lost durability response");
      }
      await faults.syncHook?.();
    },
  };
  if (!existing) {
    db.exec("CREATE TABLE canonical_anchor (singleton INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    db.query("INSERT INTO canonical_anchor VALUES (1, ?)").run(
      JSON.stringify({
        identityHash: H("identity"),
        headHash: H("head-0"),
        sequence: "0",
        fence: "7",
        provisioning: true,
        pending: false,
      }),
    );
  }
  const anchor = () =>
    JSON.parse(
      (db.query("SELECT body FROM canonical_anchor WHERE singleton = 1").get() as { body: string })
        .body,
    ) as IndexAnchor;
  const writeAnchor = (next: IndexAnchor) => {
    Array.from(
      port.sql.exec(
        "UPDATE canonical_anchor SET body = ? WHERE singleton = 1",
        JSON.stringify(next),
      ),
    );
  };
  const open = () => new SqliteIndexControl(port, anchor, () => clock.now);
  const store = open();
  async function initialize(schema = "test-identity-schema-v1") {
    const result = await store.initialize(schema);
    writeAnchor({ ...anchor(), provisioning: false });
    return result;
  }
  async function append(current: IndexControl, identities = 5n) {
    const sequence = (BigInt(current.view.sequence) + 1n).toString();
    const next = { ...anchor(), sequence, headHash: H(`head-${sequence}`) };
    return store.append(
      current.view,
      next,
      H(`hot-${sequence}`),
      (BigInt(current.view.hotCount) + identities).toString(),
      () => {
        writeAnchor(next);
        return undefined;
      },
    );
  }
  function tamper(transform: (body: string) => string) {
    const row = db.query("SELECT body FROM ledger_index_control").get() as { body: string };
    const body = transform(row.body);
    db.query("UPDATE ledger_index_control SET body = ?, digest = ?").run(
      body,
      hashCanonical({ domain: "rastrata-index-control-tracked-v1", body }).digest,
    );
  }
  return { db, faults, port, anchor, writeAnchor, open, store, initialize, append, tamper, clock };
}

const epochLocation = (n: bigint | number, epoch: bigint) =>
  `derived/${epoch.toString(16).padStart(32, "0")}${BigInt(n).toString(16).padStart(32, "0")}`;
const allocationLocation = (n: bigint | number) => epochLocation(n, 7n);
async function allocatedFixture(path = ":memory:") {
  const f = fixture(path);
  const current = await f.initialize(INDEX_KEY_SCHEMA);
  const pages = new SqliteIndexPageStore(f.port, f.anchor().identityHash);
  await pages.initialize("allocated");
  const pin = await f.store.pinCurrent(current.view, "construction", "100");
  const recover = async () => {
    await f.store.recoverMetadata();
    await pages.recover();
  };
  const pending = () =>
    (
      f.db.query("SELECT count(*) AS count FROM ledger_index_reservations").get() as {
        count: number;
      }
    ).count;
  const issued = () =>
    (f.db.query("SELECT issued FROM ledger_index_allocation_state").get() as { issued: string })
      .issued;
  return { ...f, current, pages, pin, recover, pending, issued };
}

async function preparedFixture(f: Awaited<ReturnType<typeof allocatedFixture>>) {
  const [id] = await f.pages.reserve(f.store, f.pin, 1);
  if (!id) throw new Error("Missing reservation");
  const page = encodeIndexPage(id, [{ key: H("prepared-key"), sequence: 1n }]);
  await f.pages.putReserved(f.store, f.pin, page.descriptor.page, page.bytes);
  const root = createIndexRoot(1n, page.descriptor.page);
  const next = { ...f.anchor(), sequence: "1", headHash: H("prepared-target-head") };
  return {
    page,
    root,
    next,
    register: () => f.pages.retainPreparedRoot(f.store, f.pin, root, root.contentHash, next),
  };
}

test("construction tracking spans reserved, abandoned and materialized locations before any final root", async () => {
  const f = await allocatedFixture();
  try {
    const ids = await f.pages.reserve(f.store, f.pin, 3);
    const page = encodeIndexPage(allocationLocation(1), [{ key: H("tracked"), sequence: 1n }]);
    await f.pages.putReserved(f.store, f.pin, page.descriptor.page, page.bytes);
    await f.pages.abandon(f.store, f.pin, [allocationLocation(2)]);
    expect(f.pending()).toBe(1);
    expect(await f.store.readPrepared(f.pin)).toBeUndefined();
    const batches = await Array.fromAsync(f.pages.constructionBatches(f.store, f.pin, 2));
    expect(batches.map((batch) => batch.locations)).toEqual([ids.slice(0, 2), ids.slice(2)]);
    expect(batches.map((batch) => batch.complete)).toEqual([false, true]);
    expect(batches[1]?.cursor.hash).toBe(batches[0]?.head.hash);
    expect(batches[0]?.head.count).toBe("3");
    expect(batches[0]?.highWater.issued).toBe(allocationLocation(3).slice(40));
    await f.store.releasePin(f.pin);
    expect(await f.pages.cleanupConstructions(f.store, 2)).toEqual({
      pinId: f.pin.id,
      removed: 2,
      completed: false,
    });
    expect(await f.pages.read(allocationLocation(1))).toEqual(page.bytes);
    expect(await f.pages.cleanupConstructions(f.store, 2)).toEqual({
      pinId: f.pin.id,
      removed: 1,
      completed: true,
    });
    expect(f.pending()).toBe(0);
    expect(
      f.db.query("SELECT count(*) AS count FROM ledger_index_construction_locations").get(),
    ).toEqual({ count: 0 });
    expect(
      f.db.query("SELECT count(*) AS count FROM ledger_index_construction_heads").get(),
    ).toEqual({ count: 0 });
    expect(await f.pages.read(allocationLocation(1))).toEqual(page.bytes);
    const next = await f.store.pinCurrent(f.current.view, "construction", "100");
    expect(await f.pages.reserve(f.store, next, 1)).toEqual([allocationLocation(4)]);
    await expect(
      f.pages.putReserved(f.store, next, page.descriptor.page, page.bytes),
    ).rejects.toThrow("index_page_construction_mismatch");
  } finally {
    f.db.close();
  }
});

test("captured construction proof excludes later allocations and verifies a thousand locations in bounded indexed batches", async () => {
  const f = await allocatedFixture();
  try {
    for (const size of [256, 256, 256, 232]) await f.pages.reserve(f.store, f.pin, size);
    f.faults.maxReturnedRows = 0;
    const iterator = f.pages.constructionBatches(f.store, f.pin, 17);
    const first = await iterator.next();
    if (first.done) throw new Error("Missing first batch");
    expect(first.value.complete).toBe(false);
    await f.pages.reserve(f.store, f.pin, 2);
    const remaining = await Array.fromAsync(iterator);
    const batches = [first.value, ...remaining];
    expect(batches.flatMap((batch) => batch.locations)).toEqual(
      Array.from({ length: 1000 }, (_, n) => allocationLocation(n + 1)),
    );
    expect(batches.at(-1)?.complete).toBe(true);
    expect(
      batches.every((batch) => batch.head.count === "1000" && batch.locations.length <= 17),
    ).toBe(true);
    expect(f.faults.maxReturnedRows).toBeLessThanOrEqual(18);
    const latest = await Array.fromAsync(f.pages.constructionBatches(f.store, f.pin, 256));
    expect(latest.flatMap((batch) => batch.locations)).toHaveLength(1002);
    const plan = f.db
      .query(
        "EXPLAIN QUERY PLAN SELECT location FROM ledger_index_construction_locations WHERE pin_id = ? AND (ordinal_length, ordinal) > (?, ?) ORDER BY ordinal_length, ordinal LIMIT ?",
      )
      .all(f.pin.id, 1, "0", 18) as { detail: string }[];
    expect(plan.some((row) => row.detail.includes("ledger_index_construction_order"))).toBe(true);
    expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false);
  } finally {
    f.db.close();
  }
});

test("empty construction proof requires a real head; missing, relocated, corrupt or extra rows cannot prove completeness", async () => {
  for (const fault of [
    "head",
    "middle",
    "suffix",
    "index",
    "digest",
    "rewind",
    "location-nul",
    "location-oversize",
  ]) {
    const f = await allocatedFixture();
    try {
      const initial = f.db
        .query("SELECT body, digest FROM ledger_index_construction_heads")
        .get() as { body: string; digest: string };
      const empty = await Array.fromAsync(f.pages.constructionBatches(f.store, f.pin, 1));
      expect(empty).toHaveLength(1);
      expect(empty[0]?.locations).toEqual([]);
      expect(empty[0]?.complete).toBe(true);
      await f.pages.reserve(f.store, f.pin, 3);
      if (fault === "head")
        f.db.query("DELETE FROM ledger_index_construction_heads WHERE pin_id = ?").run(f.pin.id);
      if (fault === "middle" || fault === "suffix")
        f.db
          .query("DELETE FROM ledger_index_construction_locations WHERE pin_id = ? AND ordinal = ?")
          .run(f.pin.id, fault === "middle" ? "2" : "3");
      if (fault === "index")
        f.db
          .query(
            "UPDATE ledger_index_construction_locations SET ordinal_length = 99 WHERE pin_id = ? AND ordinal = '2'",
          )
          .run(f.pin.id);
      if (fault === "digest")
        f.db
          .query(
            "UPDATE ledger_index_construction_locations SET digest = 'bad' WHERE pin_id = ? AND ordinal = '2'",
          )
          .run(f.pin.id);
      if (fault === "location-nul" || fault === "location-oversize")
        f.db
          .query("UPDATE ledger_index_construction_locations SET location = ? WHERE ordinal = '2'")
          .run(fault === "location-nul" ? `${allocationLocation(2)}\u0000` : "x".repeat(100_000));
      if (fault === "rewind")
        f.db
          .query("UPDATE ledger_index_construction_heads SET body = ?, digest = ? WHERE pin_id = ?")
          .run(initial.body, initial.digest, f.pin.id);
      const completed: boolean[] = [];
      await expect(
        (async () => {
          for await (const batch of f.pages.constructionBatches(f.store, f.pin, 1))
            completed.push(batch.complete);
        })(),
      ).rejects.toThrow(
        fault === "head" || fault === "digest" || fault.startsWith("location-")
          ? "index_construction_tracking_corrupt"
          : "index_construction_tracking_gap",
      );
      expect(completed).not.toContain(true);
    } finally {
      f.db.close();
    }
  }
});

test("allocation and tracking publish atomically, including unknown confirmations", async () => {
  const f = await allocatedFixture();
  try {
    for (const sql of [
      "INSERT INTO ledger_index_construction_locations",
      "UPDATE ledger_index_construction_heads",
    ]) {
      f.faults.afterSql = sql;
      await expect(f.pages.reserve(f.store, f.pin, 3)).rejects.toThrow("injected SQL failure");
      f.faults.afterSql = "";
      await f.recover();
      expect(f.pending()).toBe(0);
      expect(f.issued()).toBe("0".repeat(32));
      const proof = await Array.fromAsync(f.pages.constructionBatches(f.store, f.pin));
      expect(proof[0]?.head.count).toBe("0");
      expect(proof[0]?.complete).toBe(true);
    }
    f.faults.loseAfterSql = "UPDATE ledger_index_construction_heads";
    await expect(f.pages.reserve(f.store, f.pin, 3)).rejects.toThrow("lost durability response");
    await f.recover();
    const proof = await Array.fromAsync(f.pages.constructionBatches(f.store, f.pin));
    expect(proof[0]?.locations).toEqual([1, 2, 3].map(allocationLocation));
    expect(await f.pages.reserve(f.store, f.pin, 1)).toEqual([allocationLocation(4)]);
  } finally {
    f.db.close();
  }
});

test("cleanup is resumable and atomic after tracking, reservation or job-write faults", async () => {
  const f = await allocatedFixture();
  try {
    await f.pages.reserve(f.store, f.pin, 3);
    await f.store.releasePin(f.pin);
    for (const sql of [
      "DELETE FROM ledger_index_reservations",
      "DELETE FROM ledger_index_construction_locations",
      "UPDATE ledger_index_construction_cleanup",
    ]) {
      f.faults.afterSql = sql;
      await expect(f.pages.cleanupConstructions(f.store, 1)).rejects.toThrow(
        "injected SQL failure",
      );
      f.faults.afterSql = "";
      await f.recover();
      expect(f.pending()).toBe(3);
      expect(
        f.db.query("SELECT count(*) AS count FROM ledger_index_construction_locations").get(),
      ).toEqual({ count: 3 });
    }
    f.faults.loseAfterSql = "UPDATE ledger_index_construction_cleanup";
    await expect(f.pages.cleanupConstructions(f.store, 1)).rejects.toThrow(
      "lost durability response",
    );
    await f.recover();
    expect(f.pending()).toBe(2);
    expect(await f.pages.cleanupConstructions(f.store, 2)).toEqual({
      pinId: f.pin.id,
      removed: 2,
      completed: true,
    });
    expect(await f.pages.cleanupConstructions(f.store, 2)).toEqual({
      pinId: null,
      removed: 0,
      completed: false,
    });
    expect(f.pending()).toBe(0);
    expect(f.issued()).toBe(allocationLocation(3).slice(40));
  } finally {
    f.db.close();
  }
});

test("tracking reads require live pins; expiry queues cleanup without reviving the old cursor", async () => {
  const f = await allocatedFixture();
  try {
    await f.pages.reserve(f.store, f.pin, 3);
    const iterator = f.pages.constructionBatches(f.store, f.pin, 1);
    expect((await iterator.next()).done).toBe(false);
    expect(await f.pages.cleanupConstructions(f.store, 1)).toEqual({
      pinId: null,
      removed: 0,
      completed: false,
    });
    f.clock.now = 100n;
    await expect(iterator.next()).rejects.toThrow("index_pin_expired");
    await f.recover();
    expect((await f.pages.cleanupConstructions(f.store, 3)).removed).toBe(3);
    f.clock.now = 99n;
    await expect(f.pages.cleanupConstructions(f.store, 1)).rejects.toThrow(
      "index_pin_clock_regressed",
    );
  } finally {
    f.db.close();
  }
});

test("retired tracking survives reopen and lost cleanup completion without reissuing locations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-construction-restart-"));
  const path = join(directory, "book.sqlite");
  const first = await allocatedFixture(path);
  const staged = await preparedFixture(first);
  await first.pages.reserve(first.store, first.pin, 2);
  const before = await Array.fromAsync(first.pages.constructionBatches(first.store, first.pin, 2));
  first.db.close();
  const second = fixture(path, true);
  try {
    await second.store.recoverMetadata();
    const pages = new SqliteIndexPageStore(second.port, second.anchor().identityHash);
    await pages.recover();
    expect(await Array.fromAsync(pages.constructionBatches(second.store, first.pin, 2))).toEqual(
      before,
    );
    await second.store.releasePin(first.pin);
    second.faults.loseAfterSql = "UPDATE ledger_index_construction_cleanup";
    await expect(pages.cleanupConstructions(second.store, 1)).rejects.toThrow(
      "lost durability response",
    );
  } finally {
    second.db.close();
  }
  const third = fixture(path, true);
  try {
    await third.store.recoverMetadata();
    const pages = new SqliteIndexPageStore(third.port, third.anchor().identityHash);
    await pages.recover();
    expect(
      third.db.query("SELECT count(*) AS count FROM ledger_index_construction_locations").get(),
    ).toEqual({ count: 2 });
    third.faults.loseAfterSql = "DELETE FROM ledger_index_construction_cleanup";
    await expect(pages.cleanupConstructions(third.store, 2)).rejects.toThrow(
      "lost durability response",
    );
    await third.store.recoverMetadata();
    await pages.recover();
    expect(await pages.cleanupConstructions(third.store, 2)).toEqual({
      removed: 0,
      completed: false,
      pinId: null,
    });
    expect(await pages.read(staged.page.descriptor.page.location)).toEqual(staged.page.bytes);
    const next = await third.store.pinCurrent(first.current.view, "construction", "100");
    expect(await pages.reserve(third.store, next, 1)).toEqual([allocationLocation(4)]);
  } finally {
    third.db.close();
    rmSync(directory, { recursive: true });
  }
});

test("cleanup rejects changed terminal head, skipped rows, live owners and corrupt job metadata without deletion", async () => {
  for (const fault of [
    "short-head",
    "skip",
    "live-owner",
    "digest",
    "nul",
    "index",
    "missing-head",
  ]) {
    const f = await allocatedFixture();
    try {
      await f.pages.reserve(f.store, f.pin, 3);
      const pinRow = f.db.query("SELECT * FROM ledger_index_pins WHERE id = ?").get(f.pin.id) as {
        id: string;
        expires_at: string;
        expiry_length: number;
        body: string;
        digest: string;
      };
      await f.store.releasePin(f.pin);
      const row = f.db
        .query("SELECT body, digest FROM ledger_index_construction_cleanup")
        .get() as { body: string; digest: string };
      const job = JSON.parse(row.body);
      if (fault === "short-head") {
        job.head.count = "2";
        job.head.hash = (
          f.db
            .query("SELECT digest FROM ledger_index_construction_locations WHERE ordinal = '2'")
            .get() as { digest: string }
        ).digest;
      }
      if (fault === "skip") {
        job.through = "3";
        job.hash = job.head.hash;
      }
      if (fault === "short-head" || fault === "skip") {
        const body = JSON.stringify(job);
        f.db
          .query("UPDATE ledger_index_construction_cleanup SET body = ?, digest = ?")
          .run(
            body,
            hashCanonical({ domain: "rastrata-construction-locations-v1/cleanup", body }).digest,
          );
      }
      if (fault === "live-owner")
        f.db
          .query("INSERT INTO ledger_index_pins VALUES (?, ?, ?, ?, ?)")
          .run(pinRow.id, pinRow.expires_at, pinRow.expiry_length, pinRow.body, pinRow.digest);
      if (fault === "digest")
        f.db.query("UPDATE ledger_index_construction_cleanup SET digest = 'bad'").run();
      if (fault === "nul")
        f.db
          .query("UPDATE ledger_index_construction_cleanup SET digest = ?")
          .run(`${row.digest}\u0000`);
      if (fault === "index")
        f.db.query("UPDATE ledger_index_construction_cleanup SET pin_length = 99").run();
      if (fault === "missing-head") f.db.query("DELETE FROM ledger_index_construction_heads").run();
      await expect(f.pages.cleanupConstructions(f.store, 3)).rejects.toThrow(
        ["digest", "nul", "missing-head"].includes(fault)
          ? "index_construction_tracking_corrupt"
          : "index_construction_cleanup_invalid",
      );
      expect(f.pending()).toBe(3);
      expect(
        f.db.query("SELECT count(*) AS count FROM ledger_index_construction_locations").get(),
      ).toEqual({ count: 3 });
      expect(f.issued()).toBe(allocationLocation(3).slice(40));
    } finally {
      f.db.close();
    }
  }
});

test("cleanup completion rolls back on head or job deletion faults", async () => {
  for (const sql of [
    "DELETE FROM ledger_index_construction_heads",
    "DELETE FROM ledger_index_construction_cleanup",
  ]) {
    const f = await allocatedFixture();
    try {
      await f.pages.reserve(f.store, f.pin, 2);
      await f.store.releasePin(f.pin);
      f.faults.afterSql = sql;
      await expect(f.pages.cleanupConstructions(f.store, 2)).rejects.toThrow(
        "injected SQL failure",
      );
      f.faults.afterSql = "";
      await f.recover();
      expect(f.pending()).toBe(2);
      expect(
        f.db.query("SELECT count(*) AS count FROM ledger_index_construction_heads").get(),
      ).toEqual({ count: 1 });
      expect(
        f.db.query("SELECT count(*) AS count FROM ledger_index_construction_cleanup").get(),
      ).toEqual({ count: 1 });
      expect((await f.pages.cleanupConstructions(f.store, 2)).removed).toBe(2);
    } finally {
      f.db.close();
    }
  }
});

test("prepared registration binds exact root and target; publication atomically consumes registration and pin", async () => {
  const f = await allocatedFixture();
  try {
    const staged = await preparedFixture(f);
    const prepared = await staged.register();
    expect(prepared.root).toEqual(staged.root);
    expect(prepared.next).toEqual(staged.next);
    expect(prepared.view).toEqual(f.current.view);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(await f.store.readPrepared(f.pin)).toEqual(prepared);
    expect(await staged.register()).toEqual(prepared);
    expect(
      f.db.query("SELECT count(*) AS count FROM ledger_index_prepared_publications").get(),
    ).toEqual({ count: 1 });
    const after = await f.store.publishPrepared(f.pin, prepared.digest, () => {
      f.writeAnchor(staged.next);
      return undefined;
    });
    expect(after.view.hotRoot).toBe(staged.root.contentHash);
    expect(after.view.sequence).toBe("1");
    expect(after.view.revision).toBe("1");
    expect(
      f.db.query("SELECT count(*) AS count FROM ledger_index_prepared_publications").get(),
    ).toEqual({ count: 0 });
    await expect(f.store.readPinned(f.pin)).rejects.toThrow("index_pin_not_active");
    let called = false;
    await expect(
      f.store.publishPrepared(f.pin, prepared.digest, () => {
        called = true;
        return undefined;
      }),
    ).rejects.toThrow("index_pin_not_active");
    expect(called).toBe(false);
  } finally {
    f.db.close();
  }
});

test("prepared publication rejects missing registration, substitution and mismatched canonical target", async () => {
  const f = await allocatedFixture();
  try {
    let calls = 0;
    await expect(
      f.store.publishPrepared(f.pin, H("unknown"), () => {
        calls++;
        return undefined;
      }),
    ).rejects.toThrow("index_prepared_publication_missing");
    const staged = await preparedFixture(f),
      prepared = await staged.register();
    await expect(
      f.store.publishPrepared(f.pin, H("wrong"), () => {
        calls++;
        return undefined;
      }),
    ).rejects.toThrow("index_prepared_publication_conflict");
    expect(calls).toBe(0);
    await expect(
      f.pages.retainPreparedRoot(f.store, f.pin, staged.root, staged.root.contentHash, {
        ...staged.next,
        headHash: H("substitute-target"),
      }),
    ).rejects.toThrow("index_prepared_publication_conflict");
    await f.recover();
    const [id] = await f.pages.reserve(f.store, f.pin, 1);
    if (!id) throw new Error("Missing reservation");
    const other = encodeIndexPage(id, [{ key: H("different-key"), sequence: 1n }]);
    await f.pages.putReserved(f.store, f.pin, other.descriptor.page, other.bytes);
    const otherRoot = createIndexRoot(1n, other.descriptor.page);
    await expect(
      f.pages.retainPreparedRoot(f.store, f.pin, otherRoot, otherRoot.contentHash, staged.next),
    ).rejects.toThrow("index_prepared_publication_conflict");
    await f.recover();
    expect(await f.store.readPrepared(f.pin)).toEqual(prepared);
    await expect(
      f.store.publishPrepared(f.pin, prepared.digest, () => {
        f.writeAnchor({ ...staged.next, headHash: H("wrong-actual-head") });
        return undefined;
      }),
    ).rejects.toThrow("index_anchor_mismatch");
    await f.recover();
    expect(f.anchor().sequence).toBe("0");
    expect(await f.store.readPrepared(f.pin)).toEqual(prepared);
    expect((await f.store.readMetadata()).view).toEqual(f.current.view);
  } finally {
    f.db.close();
  }
});

test("registration requires complete stored graph and no boolean or missing descriptor can stand in for it", async () => {
  const f = await allocatedFixture();
  try {
    const staged = await preparedFixture(f);
    await expect(
      f.store.registerPrepared(f.port, f.pin, staged.root, staged.next, () => undefined),
    ).rejects.toThrow("index_prepared_root_unverified");
    await f.recover();
    f.db
      .query("DELETE FROM ledger_index_pages WHERE location = ?")
      .run(staged.page.descriptor.page.location);
    await expect(staged.register()).rejects.toThrow("index_page_missing_or_short");
    await f.recover();
    expect(await f.store.readPrepared(f.pin)).toBeUndefined();
    expect(await f.pages.readRootDescriptor(staged.root.contentHash)).toBeUndefined();
    expect((await f.store.readMetadata()).view).toEqual(f.current.view);
  } finally {
    f.db.close();
  }
});

test("lease renewal keeps prepared identity; expiry and release remove publication eligibility irreversibly", async () => {
  for (const expire of [true, false]) {
    const f = await allocatedFixture();
    try {
      const staged = await preparedFixture(f),
        prepared = await staged.register();
      const renewed = await f.store.renewPin(f.pin, "200");
      expect(await f.store.readPrepared(renewed)).toEqual(prepared);
      if (expire) f.clock.now = 200n;
      else await f.store.releasePin(renewed);
      let called = false;
      await expect(
        f.store.publishPrepared(renewed, prepared.digest, () => {
          called = true;
          return undefined;
        }),
      ).rejects.toThrow(expire ? "index_pin_expired" : "index_pin_not_active");
      expect(called).toBe(false);
      expect(
        f.db.query("SELECT count(*) AS count FROM ledger_index_prepared_publications").get(),
      ).toEqual({ count: 0 });
      expect(f.anchor().sequence).toBe("0");
      if (expire) {
        f.clock.now = 199n;
        await expect(f.store.readPrepared(renewed)).rejects.toThrow("index_pin_clock_regressed");
      }
    } finally {
      f.db.close();
    }
  }
});

test("same canonical head with a changed view revision invalidates prepared publication", async () => {
  const f = await allocatedFixture();
  try {
    const staged = await preparedFixture(f),
      prepared = await staged.register();
    f.tamper((body) => {
      const value = JSON.parse(body);
      value.view.revision = "1";
      return JSON.stringify(value);
    });
    let called = false;
    f.clock.now = 20n;
    await expect(
      f.store.publishPrepared(f.pin, prepared.digest, () => {
        called = true;
        return undefined;
      }),
    ).rejects.toThrow("index_view_conflict");
    expect(called).toBe(false);
    expect(f.anchor().headHash).toBe(f.current.view.headHash);
    expect(await f.store.readPrepared(f.pin)).toEqual(prepared);
    await expect(staged.register()).rejects.toThrow("index_view_conflict");
    await f.recover();
    f.clock.now = 19n;
    await expect(f.store.readPrepared(f.pin)).rejects.toThrow("index_pin_clock_regressed");
  } finally {
    f.db.close();
  }
});

test("lost prepared-registration reply is reconstructed and retirement faults roll back publication", async () => {
  const f = await allocatedFixture();
  try {
    const staged = await preparedFixture(f);
    f.faults.loseAfterSql = "INSERT INTO ledger_index_prepared_publications";
    await expect(staged.register()).rejects.toThrow("lost durability response");
    await f.recover();
    const prepared = await f.store.readPrepared(f.pin);
    expect(prepared?.root).toEqual(staged.root);
    if (!prepared) throw new Error("Missing recovered preparation");
    expect(await staged.register()).toEqual(prepared);
    for (const sql of [
      "DELETE FROM ledger_index_pins",
      "DELETE FROM ledger_index_prepared_publications",
      "UPDATE ledger_index_pin_state",
    ]) {
      f.faults.afterSql = sql;
      await expect(
        f.store.publishPrepared(f.pin, prepared.digest, () => {
          f.writeAnchor(staged.next);
          return undefined;
        }),
      ).rejects.toThrow("injected SQL failure");
      f.faults.afterSql = "";
      await f.recover();
      expect(f.anchor().sequence).toBe("0");
      expect((await f.store.readMetadata()).view).toEqual(f.current.view);
      expect(await f.store.readPrepared(f.pin)).toEqual(prepared);
    }
    f.faults.loseAfterSql = "DELETE FROM ledger_index_prepared_publications";
    await expect(
      f.store.publishPrepared(f.pin, prepared.digest, () => {
        f.writeAnchor(staged.next);
        return undefined;
      }),
    ).rejects.toThrow("lost durability response");
    await f.recover();
    expect(f.anchor().sequence).toBe("1");
    expect((await f.store.readMetadata()).view.hotRoot).toBe(staged.root.contentHash);
    await expect(f.store.readPrepared(f.pin)).rejects.toThrow("index_pin_not_active");
  } finally {
    f.db.close();
  }
});

test("prepared records survive SQLite reopen and reject altered or noncanonical bodies", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-prepared-publication-"));
  const path = join(directory, "book.sqlite");
  const f = await allocatedFixture(path),
    staged = await preparedFixture(f),
    prepared = await staged.register();
  f.db.close();
  const reopened = fixture(path, true);
  try {
    await reopened.store.recoverMetadata();
    expect(await reopened.store.readPrepared(f.pin)).toEqual(prepared);
    await reopened.store.publishPrepared(f.pin, prepared.digest, () => {
      reopened.writeAnchor(staged.next);
      return undefined;
    });
    expect((await reopened.store.readMetadata()).view.hotRoot).toBe(staged.root.contentHash);
  } finally {
    reopened.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
  for (const change of ["digest", "duplicate", "foreign-pin", "nul"]) {
    const damaged = await allocatedFixture();
    try {
      const stage = await preparedFixture(damaged);
      await stage.register();
      const saved = damaged.db
        .query("SELECT body FROM ledger_index_prepared_publications")
        .get() as { body: string };
      let body = saved.body;
      if (change === "duplicate") body = body.replace('{"pinId":', '{"pinId":"999","pinId":');
      if (change === "foreign-pin") {
        const value = JSON.parse(body);
        value.pinId = "999";
        body = JSON.stringify(value);
      }
      const digest = hashCanonical({
        domain: "rastrata-prepared-index-publication-v1",
        body,
      }).digest;
      damaged.db
        .query("UPDATE ledger_index_prepared_publications SET body = ?, digest = ?")
        .run(body, change === "digest" ? H("bad") : change === "nul" ? `${digest}\0` : digest);
      await expect(damaged.store.readPrepared(damaged.pin)).rejects.toThrow(
        "index_prepared_publication_corrupt",
      );
      expect(damaged.anchor().sequence).toBe("0");
    } finally {
      damaged.db.close();
    }
  }
});

test("prepared admission rejects wrong target identity, fence, sequence, readiness and empty population", async () => {
  const f = await allocatedFixture();
  try {
    const staged = await preparedFixture(f);
    for (const patch of [
      { identityHash: H("foreign") },
      { fence: "8" },
      { sequence: "0" },
      { sequence: "2" },
      { headHash: f.current.view.headHash },
      { pending: true },
      { provisioning: true },
    ]) {
      await expect(
        f.pages.retainPreparedRoot(f.store, f.pin, staged.root, staged.root.contentHash, {
          ...staged.next,
          ...patch,
        }),
      ).rejects.toThrow("index_prepared_publication_invalid");
      await f.recover();
      expect(await f.store.readPrepared(f.pin)).toBeUndefined();
    }
    const empty = createIndexRoot(0n, null);
    await expect(
      f.pages.retainPreparedRoot(f.store, f.pin, empty, empty.contentHash, staged.next),
    ).rejects.toThrow("index_prepared_publication_invalid");
    await f.recover();
    expect(f.anchor().sequence).toBe("0");
  } finally {
    f.db.close();
  }
});

test("prepared target is captured before asynchronous verification, not from a later caller mutation", async () => {
  const f = await allocatedFixture();
  try {
    const staged = await preparedFixture(f);
    const next = { ...staged.next };
    f.faults.syncHook = async () => {
      next.headHash = H("changed-during-io");
      next.sequence = "999";
    };
    const prepared = await f.pages.retainPreparedRoot(
      f.store,
      f.pin,
      staged.root,
      staged.root.contentHash,
      next,
    );
    f.faults.syncHook = undefined;
    expect(prepared.next).toEqual(staged.next);
    expect(await f.store.readPrepared(f.pin)).toEqual(prepared);
  } finally {
    f.db.close();
  }
});

test("two prepared candidates at one input view have one publication winner and retain the losing candidate", async () => {
  const f = await allocatedFixture();
  try {
    const first = await preparedFixture(f),
      prepared = await first.register();
    const otherControl = f.open();
    const secondPin = await otherControl.pinCurrent(f.current.view, "construction", "100");
    const [id] = await f.pages.reserve(otherControl, secondPin, 1);
    if (!id) throw new Error("Missing reservation");
    const page = encodeIndexPage(id, [{ key: H("other-candidate-key"), sequence: 1n }]);
    await f.pages.putReserved(otherControl, secondPin, page.descriptor.page, page.bytes);
    const root = createIndexRoot(1n, page.descriptor.page);
    const target = { ...first.next, headHash: H("other-candidate-head") };
    const second = await f.pages.retainPreparedRoot(
      otherControl,
      secondPin,
      root,
      root.contentHash,
      target,
    );
    let writes = 0;
    const attempts = await Promise.allSettled([
      f.store.publishPrepared(f.pin, prepared.digest, () => {
        writes++;
        f.writeAnchor(first.next);
        return undefined;
      }),
      otherControl.publishPrepared(secondPin, second.digest, () => {
        writes++;
        f.writeAnchor(target);
        return undefined;
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    if (rejected?.status !== "rejected") throw new Error("Missing losing candidate");
    expect(String(rejected.reason)).toContain("index_view_conflict");
    expect(writes).toBe(1);
    const current = await f.store.readMetadata();
    expect(current.view.revision).toBe("1");
    expect(current.view.sequence).toBe("1");
    const pending = f.db.query("SELECT body FROM ledger_index_prepared_publications").all() as {
      body: string;
    }[];
    expect(pending).toHaveLength(1);
    expect(JSON.parse(pending[0]?.body ?? "null").root.contentHash).not.toBe(current.view.hotRoot);
  } finally {
    f.db.close();
  }
});

test("tracked-control schema refuses older prototype formats without altering their saved bytes", async () => {
  for (const format of ["rastrata-index-control-v1", "rastrata-index-control-prepared-v1"]) {
    const f = fixture();
    try {
      await f.initialize(INDEX_KEY_SCHEMA);
      const row = f.db.query("SELECT body FROM ledger_index_control").get() as { body: string };
      const value = JSON.parse(row.body);
      value.format = format;
      const body = JSON.stringify(value),
        digest = hashCanonical({ domain: format, body }).digest;
      f.db.query("UPDATE ledger_index_control SET body = ?, digest = ?").run(body, digest);
      await expect(f.store.recoverMetadata()).rejects.toThrow("index_control_corrupt");
      expect(f.db.query("SELECT body, digest FROM ledger_index_control").get()).toEqual({
        body,
        digest,
      });
    } finally {
      f.db.close();
    }
  }
});

test("allocated store persists a real COW split with live construction pins and no raw-write bypass", async () => {
  const f = await allocatedFixture();
  try {
    const [initial] = await f.pages.reserve(f.store, f.pin, 1);
    if (!initial) throw new Error("Missing reservation");
    const entries = Array.from({ length: 204 }, (_, n) => ({
      key: H(`key-${n}`),
      sequence: 1n,
    })).sort((a, b) => a.key.localeCompare(b.key));
    const leaf = encodeIndexPage(initial, entries);
    await f.pages.putReserved(f.store, f.pin, leaf.descriptor.page, leaf.bytes);
    expect(f.pending()).toBe(0); // Written pages do not accumulate reservation tombstones.
    const root = createIndexRoot(204n, leaf.descriptor.page);
    await f.pages.retainRoot(root, root.contentHash);
    // Synthetic anchor isolates physical construction; not a real accounting command.
    const next = { ...f.anchor(), sequence: "1", headHash: H("allocated-head-1") };
    const current = await f.store.append(f.current.view, next, root.contentHash, "204", () => {
      f.writeAnchor(next);
      return undefined;
    });
    await f.store.releasePin(f.pin);
    const pin = await f.store.pinCurrent(current.view, "construction", "100");
    const read = (id: string) => f.pages.read(id);
    const index = await auditBalancedIndex(root, root.contentHash, read);
    const reserved = await f.pages.reserve(f.store, pin, 3);
    let used = 0;
    const inserted = { key: H("new-key"), sequence: 2n };
    const plan = await prepareIndexInsert(index, inserted, read, () => {
      const id = reserved[used++];
      if (!id) throw new Error("Insufficient reservation");
      return id;
    });
    expect(plan.pages).toHaveLength(3);
    expect(plan.pagesRead).toBe(1);
    for (const page of plan.pages)
      await f.pages.putReserved(f.store, pin, page.descriptor.page, page.bytes);
    await f.pages.retainRoot(plan.after, plan.after.contentHash);
    expect(
      await Array.fromAsync(enumerateIndexPages(plan.after, plan.after.contentHash, read)),
    ).toEqual([...entries, inserted].sort((a, b) => a.key.localeCompare(b.key)));
    expect(await Array.fromAsync(enumerateIndexPages(root, root.contentHash, read))).toEqual(
      entries,
    );
    expect(f.pending()).toBe(0);
    expect(f.issued()).toBe(allocationLocation(4).slice(40));
    // Even an identical existing page must use the pinned allocated-write path.
    await expect(f.pages.put(leaf.descriptor.page, leaf.bytes)).rejects.toThrow(
      "index_reserved_write_required",
    );
    await f.pages.recover();
    await expect(
      f.pages.putReserved(f.store, pin, leaf.descriptor.page, leaf.bytes),
    ).rejects.toThrow("index_page_construction_mismatch");
    await f.recover();
    expect((await f.store.readMetadata()).view).toEqual(current.view); // No automatic selection.
  } finally {
    f.db.close();
  }
});

test("abandoned, consumed and missing stored locations are never reissued or resurrected", async () => {
  const f = await allocatedFixture();
  try {
    const ids = await f.pages.reserve(f.store, f.pin, 3);
    expect(ids).toEqual([1, 2, 3].map(allocationLocation));
    expect(Object.isFrozen(ids)).toBe(true);
    expect(
      await f.pages.abandon(f.store, f.pin, [allocationLocation(2), allocationLocation(2)]),
    ).toBe(1);
    expect(await f.pages.abandon(f.store, f.pin, [allocationLocation(2)])).toBe(0);
    const page = encodeIndexPage(allocationLocation(1), [{ key: H("key"), sequence: 1n }]);
    await f.pages.putReserved(f.store, f.pin, page.descriptor.page, page.bytes);
    await f.pages.putReserved(f.store, f.pin, page.descriptor.page, page.bytes);
    expect(await f.pages.abandon(f.store, f.pin, [allocationLocation(1)])).toBe(0);
    expect(f.pending()).toBe(1);
    // Isolated fixture damage, not an implementation of retirement or deletion.
    f.db.query("DELETE FROM ledger_index_pages WHERE location = ?").run(allocationLocation(1));
    await expect(
      f.pages.putReserved(f.store, f.pin, page.descriptor.page, page.bytes),
    ).rejects.toThrow("index_location_not_reserved");
    await f.recover();
    expect(await f.pages.reserve(f.store, f.pin, 1)).toEqual([allocationLocation(4)]);
    const abandoned = encodeIndexPage(allocationLocation(2), [{ key: H("key"), sequence: 1n }]);
    await expect(
      f.pages.putReserved(f.store, f.pin, abandoned.descriptor.page, abandoned.bytes),
    ).rejects.toThrow("index_location_not_reserved");
  } finally {
    f.db.close();
  }
});

test("construction ownership, exact pin, expiry and monotonic time guard allocation and writes", async () => {
  const f = await allocatedFixture();
  try {
    const reader = await f.store.pinCurrent(f.current.view, "reader", "100");
    await expect(f.pages.reserve(f.store, reader, 1)).rejects.toThrow(
      "index_construction_pin_required",
    );
    await f.recover();
    const second = await f.store.pinCurrent(f.current.view, "construction", "100");
    const [id] = await f.pages.reserve(f.store, f.pin, 1);
    if (!id) throw new Error("Missing reservation");
    const page = encodeIndexPage(id, [{ key: H("key"), sequence: 1n }]);
    expect(await f.pages.abandon(f.store, second, [id])).toBe(0);
    await expect(
      f.pages.putReserved(f.store, second, page.descriptor.page, page.bytes),
    ).rejects.toThrow("index_location_not_reserved");
    await f.recover();
    await expect(f.pages.reserve(f.store, { ...f.pin, expiresAt: "101" }, 1)).rejects.toThrow(
      "index_pin_conflict",
    );
    await f.recover();
    await f.store.releasePin(second);
    await expect(f.pages.reserve(f.store, second, 1)).rejects.toThrow("index_pin_not_active");
    await f.recover();
    f.clock.now = 100n;
    await expect(
      f.pages.putReserved(f.store, f.pin, page.descriptor.page, page.bytes),
    ).rejects.toThrow("index_pin_expired");
    await f.recover();
    expect(await f.pages.read(id)).toBeUndefined();
    expect(f.pending()).toBe(1); // Expired cleanup is not silently implemented here.
    f.clock.now = 99n;
    await expect(f.pages.reserve(f.store, f.pin, 1)).rejects.toThrow("index_pin_clock_regressed");
    expect(f.issued()).toBe(allocationLocation(1).slice(40));
  } finally {
    f.db.close();
  }
});

test("allocation SQL rollback and lost durability preserve exact issuance outcomes", async () => {
  const f = await allocatedFixture();
  try {
    for (const sql of [
      "INSERT INTO ledger_index_reservations",
      "UPDATE ledger_index_allocation_state",
    ]) {
      f.faults.afterSql = sql;
      await expect(f.pages.reserve(f.store, f.pin, 3)).rejects.toThrow("injected SQL failure");
      f.faults.afterSql = "";
      await f.recover();
      expect(f.pending()).toBe(0);
      expect(f.issued()).toBe("0".repeat(32));
    }
    f.faults.syncFailures = 1;
    await expect(f.pages.reserve(f.store, f.pin, 3)).rejects.toThrow("lost durability response");
    expect(f.pending()).toBe(3);
    expect(f.issued()).toBe(allocationLocation(3).slice(40));
    await expect(f.pages.reserve(f.store, f.pin, 1)).rejects.toThrow("index_page_store_uncertain");
    await expect(f.store.readPinned(f.pin)).rejects.toThrow("index_write_uncertain");
    await f.recover();
    const freshStore = new SqliteIndexPageStore(f.port, f.anchor().identityHash);
    await freshStore.recover();
    expect(await freshStore.reserve(f.open(), f.pin, 2)).toEqual([4, 5].map(allocationLocation));
  } finally {
    f.db.close();
  }
});

test("reservation consumption and page insertion roll back together and exact retry reconciles lost response", async () => {
  const f = await allocatedFixture();
  try {
    await f.pages.reserve(f.store, f.pin, 1);
    const page = encodeIndexPage(allocationLocation(1), [{ key: H("key"), sequence: 1n }]);
    for (const sql of ["DELETE FROM ledger_index_reservations", "INSERT INTO ledger_index_pages"]) {
      f.faults.afterSql = sql;
      await expect(
        f.pages.putReserved(f.store, f.pin, page.descriptor.page, page.bytes),
      ).rejects.toThrow("injected SQL failure");
      f.faults.afterSql = "";
      await f.recover();
      expect(f.pending()).toBe(1);
      expect(await f.pages.read(allocationLocation(1))).toBeUndefined();
    }
    f.faults.syncFailures = 1;
    await expect(
      f.pages.putReserved(f.store, f.pin, page.descriptor.page, page.bytes),
    ).rejects.toThrow("lost durability response");
    await f.recover();
    expect(f.pending()).toBe(0);
    expect(await f.pages.read(allocationLocation(1))).toEqual(page.bytes);
    expect(await f.pages.putReserved(f.store, f.pin, page.descriptor.page, page.bytes)).toEqual(
      page.descriptor.page,
    );
    const changed = encodeIndexPage(allocationLocation(1), [{ key: H("key"), sequence: 2n }]);
    await expect(
      f.pages.putReserved(f.store, f.pin, changed.descriptor.page, changed.bytes),
    ).rejects.toThrow("index_page_location_conflict");
  } finally {
    f.db.close();
  }
});

test("multiple store instances serialize issuance and input pin values are copied before queuing", async () => {
  const f = await allocatedFixture();
  try {
    const second = new SqliteIndexPageStore(f.port, f.anchor().identityHash);
    await second.recover();
    const mutable = { ...f.pin, view: { ...f.pin.view } };
    const first = f.pages.reserve(f.store, mutable, 2);
    mutable.id = "999";
    mutable.view.fence = "999";
    const results = await Promise.all([first, second.reserve(f.open(), f.pin, 2)]);
    expect(results.flat().sort()).toEqual([1, 2, 3, 4].map(allocationLocation));
    expect(f.pending()).toBe(4);
    expect(
      f.db.query("SELECT DISTINCT pin_id, fence FROM ledger_index_reservations").all(),
    ).toEqual([{ pin_id: f.pin.id, fence: f.pin.view.fence }]);
    const other = await allocatedFixture();
    try {
      await expect(f.pages.reserve(other.store, other.pin, 1)).rejects.toThrow(
        "index_construction_storage_mismatch",
      );
    } finally {
      other.db.close();
    }
  } finally {
    f.db.close();
  }
});

test("batch and 128-bit issuance bounds fail closed without truncation or wraparound", async () => {
  const f = await allocatedFixture();
  try {
    for (const count of [0, -1, 1.1, 257, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => f.pages.reserve(f.store, f.pin, count)).toThrow(
        "index_allocation_batch_invalid",
      );
    const batch = await f.pages.reserve(f.store, f.pin, 256);
    expect(batch).toHaveLength(256);
    expect(batch[0]).toBe(allocationLocation(1));
    expect(batch[255]).toBe(allocationLocation(256));
    expect(await f.pages.abandon(f.store, f.pin, batch)).toBe(256);
    const issued = ((1n << 128n) - 2n).toString(16);
    // Arithmetic-bound fixture, not a claim that this population has been issued.
    f.db.query("UPDATE ledger_index_allocation_state SET issued = ?, digest = ?").run(
      issued,
      hashCanonical({
        domain: "rastrata-sqlite-allocated-index-pages-v1",
        identityHash: f.anchor().identityHash,
        issued,
        epoch: 7n.toString(16).padStart(32, "0"),
      }).digest,
    );
    expect(await f.pages.reserve(f.store, f.pin, 1)).toEqual([
      allocationLocation((1n << 128n) - 1n),
    ]);
    await expect(f.pages.reserve(f.store, f.pin, 1)).rejects.toThrow("index_allocation_exhausted");
    expect(f.issued()).toBe("f".repeat(32));
    expect(f.pending()).toBe(1);
  } finally {
    f.db.close();
  }
});

test("corrupt allocation and reservation records cannot issue or consume locations", async () => {
  for (const tamper of [
    "issued = issued || char(0)",
    "epoch = epoch || char(0)",
    "digest = 'bad'",
  ]) {
    const f = await allocatedFixture();
    try {
      f.db.exec(`UPDATE ledger_index_allocation_state SET ${tamper}`);
      await expect(f.pages.recover()).rejects.toThrow("index_allocation_state_corrupt");
    } finally {
      f.db.close();
    }
  }
  for (const tamper of [
    "pin_id = pin_id || char(0)",
    "fence = fence || char(0)",
    "digest = 'bad'",
    "pin_id = '2'",
  ]) {
    const f = await allocatedFixture();
    try {
      await f.pages.reserve(f.store, f.pin, 1);
      f.db.exec(`UPDATE ledger_index_reservations SET ${tamper}`);
      const page = encodeIndexPage(allocationLocation(1), [{ key: H("key"), sequence: 1n }]);
      await expect(
        f.pages.putReserved(f.store, f.pin, page.descriptor.page, page.bytes),
      ).rejects.toThrow("index_reservation_corrupt");
      expect(f.pending()).toBe(1);
      expect(f.db.query("SELECT count(*) AS count FROM ledger_index_pages").get()).toEqual({
        count: 0,
      });
    } finally {
      f.db.close();
    }
  }
});

test("allocated IDs survive a real SQLite reopen after lost response and cannot silently upgrade legacy storage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-index-allocation-"));
  const path = join(directory, "book.sqlite");
  const f = await allocatedFixture(path);
  try {
    f.faults.syncFailures = 1;
    await expect(f.pages.reserve(f.store, f.pin, 2)).rejects.toThrow("lost durability response");
  } finally {
    f.db.close();
  }
  const reopened = fixture(path, true);
  try {
    await reopened.store.recoverMetadata();
    const pages = new SqliteIndexPageStore(reopened.port, reopened.anchor().identityHash);
    await pages.recover();
    expect(await reopened.store.readPinned(f.pin)).toEqual(f.pin);
    expect(await pages.reserve(reopened.store, f.pin, 1)).toEqual([allocationLocation(3)]);
    await expect(pages.initialize("allocated")).rejects.toThrow();
    await pages.recover();
    expect(await pages.reserve(reopened.store, f.pin, 1)).toEqual([allocationLocation(4)]);
  } finally {
    reopened.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
  const legacy = fixture();
  try {
    const current = await legacy.initialize(INDEX_KEY_SCHEMA);
    const pages = new SqliteIndexPageStore(legacy.port, legacy.anchor().identityHash);
    await pages.initialize();
    const pin = await legacy.store.pinCurrent(current.view, "construction", "100");
    await expect(pages.reserve(legacy.store, pin, 1)).rejects.toThrow(
      "index_allocation_unsupported",
    );
    await legacy.store.recoverMetadata();
    await pages.recover();
    expect(
      legacy.db
        .query("SELECT name FROM sqlite_master WHERE name = 'ledger_index_allocation_state'")
        .all(),
    ).toEqual([]);
    const page = encodeIndexPage(allocationLocation(1), [{ key: H("legacy"), sequence: 1n }]);
    await pages.put(page.descriptor.page, page.bytes);
    expect(await pages.read(allocationLocation(1))).toEqual(page.bytes);
  } finally {
    legacy.db.close();
  }
});

test("construction transaction rejects pending authority, foreign scope and yielding writes", async () => {
  const f = await allocatedFixture();
  try {
    const pending = { ...f.anchor(), pending: true };
    f.writeAnchor(pending);
    await expect(f.pages.reserve(f.store, f.pin, 1)).rejects.toThrow("index_pin_view_conflict");
    f.writeAnchor({ ...pending, pending: false });
    await f.recover();
    await expect(
      f.pages.reserve(f.store, { ...f.pin, view: { ...f.pin.view, fence: "8" } }, 1),
    ).rejects.toThrow("index_pin_view_conflict");
    await f.recover();
    const foreignPages = new SqliteIndexPageStore(f.port, H("another-identity"));
    await expect(foreignPages.reserve(f.store, f.pin, 1)).rejects.toThrow(
      "index_page_store_identity_mismatch",
    );
    await f.recover();
    await expect(
      f.store.runPinnedConstruction(f.port, f.pin, () => {
        f.db.query("UPDATE ledger_index_allocation_state SET issued = 'bad'").run();
        return Promise.resolve() as unknown as undefined;
      }),
    ).rejects.toThrow("index_async_write_forbidden");
    await f.recover();
    expect(f.issued()).toBe("0".repeat(32));
    expect(f.pending()).toBe(0);
  } finally {
    f.db.close();
  }
});

test("saved old allocator state cannot collide with present bytes; confirmation holds the returned batch", async () => {
  const f = await allocatedFixture();
  try {
    const old = f.db
      .query("SELECT issued, epoch, digest FROM ledger_index_allocation_state")
      .get() as {
      issued: string;
      epoch: string;
      digest: string;
    };
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.faults.syncHook = async () => {
      entered();
      await gate;
    };
    let returned = false;
    const allocation = f.pages.reserve(f.store, f.pin, 1).then((value) => {
      returned = true;
      return value;
    });
    await waiting;
    expect(returned).toBe(false);
    expect(f.pending()).toBe(1);
    release();
    expect(await allocation).toEqual([allocationLocation(1)]);
    f.faults.syncHook = undefined;
    const page = encodeIndexPage(allocationLocation(1), [{ key: H("key"), sequence: 1n }]);
    await f.pages.putReserved(f.store, f.pin, page.descriptor.page, page.bytes);
    f.db
      .query("UPDATE ledger_index_allocation_state SET issued = ?, epoch = ?, digest = ?")
      .run(old.issued, old.epoch, old.digest);
    await expect(f.pages.reserve(f.store, f.pin, 1)).rejects.toThrow(
      "index_allocation_state_corrupt",
    );
    expect(f.pending()).toBe(0);
  } finally {
    f.db.close();
  }
});

test("fresh external fence separates restored counters; epoch regression and overflow reject", async () => {
  const f = await allocatedFixture();
  try {
    const before = f.db
      .query("SELECT issued, epoch, digest FROM ledger_index_allocation_state")
      .get() as {
      issued: string;
      epoch: string;
      digest: string;
    };
    expect(await f.pages.reserve(f.store, f.pin, 1)).toEqual([epochLocation(1, 7n)]);
    const old = encodeIndexPage(epochLocation(1, 7n), [{ key: H("old"), sequence: 1n }]);
    await f.pages.putReserved(f.store, f.pin, old.descriptor.page, old.bytes);
    // Controlled fixture rollback of allocator metadata only. The application
    // must implement real external fence acquisition and restored-view admission.
    f.db
      .query("UPDATE ledger_index_allocation_state SET issued = ?, epoch = ?, digest = ?")
      .run(before.issued, before.epoch, before.digest);
    const changeFence = async (fence: bigint) => {
      f.db.transaction(() => {
        f.writeAnchor({ ...f.anchor(), fence: String(fence) });
        f.tamper((body) => {
          const value = JSON.parse(body);
          value.view.fence = String(fence);
          return JSON.stringify(value);
        });
      })();
      const current = await f.store.readMetadata();
      return f.store.pinCurrent(current.view, "construction", "100");
    };
    const fresh = await changeFence(8n);
    expect(await f.pages.reserve(f.store, fresh, 1)).toEqual([epochLocation(1, 8n)]);
    expect(await f.pages.read(epochLocation(1, 7n))).toEqual(old.bytes);
    const stale = await changeFence(7n);
    await expect(f.pages.reserve(f.store, stale, 1)).rejects.toThrow(
      "index_allocation_epoch_regressed",
    );
    await f.recover();
    const max = (1n << 128n) - 1n;
    const last = await changeFence(max);
    expect(await f.pages.reserve(f.store, last, 1)).toEqual([epochLocation(2, max)]);
    const excessive = await changeFence(max + 1n);
    await expect(f.pages.reserve(f.store, excessive, 1)).rejects.toThrow(
      "index_allocation_epoch_unsupported",
    );
    expect(f.issued()).toBe(2n.toString(16).padStart(32, "0"));
  } finally {
    f.db.close();
  }
});

test("a pinned pre-cutover view resolves its original persisted pages after equivalent root replacement", async () => {
  const f = fixture();
  try {
    let current = await f.initialize(INDEX_KEY_SCHEMA);
    const pages = new SqliteIndexPageStore(f.port, f.anchor().identityHash);
    await pages.initialize();
    const entries = [{ key: H("permanent-fixture-key"), sequence: 1n }];
    const original = encodeIndexPage(`derived/${"1".repeat(64)}`, entries);
    const root = createIndexRoot(1n, original.descriptor.page);
    await pages.put(original.descriptor.page, original.bytes);
    await pages.retainRoot(root, root.contentHash);
    // Synthetic canonical anchor isolates publication/pin/page behavior. This is
    // not an accounting command nor a proof of canonical identity membership.
    const next = { ...f.anchor(), sequence: "1", headHash: H("head-1") };
    current = await f.store.append(current.view, next, root.contentHash, "1", () => {
      f.writeAnchor(next);
      return undefined;
    });
    const pin = await f.store.pinCurrent(current.view, "reader", "100");
    const frozen = await f.store.freeze(current.view, "persisted-page-cutover");
    if (!frozen.frozen) throw new Error("Missing frozen prefix");
    const replacement = encodeIndexPage(`derived/${"2".repeat(64)}`, entries);
    const replacementRoot = createIndexRoot(1n, replacement.descriptor.page);
    await pages.put(replacement.descriptor.page, replacement.bytes);
    await pages.retainRoot(replacementRoot, replacementRoot.contentHash);
    const after = await f.store.install(
      frozen.view,
      frozen.frozen,
      replacementRoot.contentHash,
      emptyIndexRoot(INDEX_KEY_SCHEMA),
      "0",
    );
    const reader = await f.open().readPinned(pin);
    const oldRoot = await pages.readRootDescriptor(reader.view.hotRoot);
    expect(oldRoot).toEqual(root);
    expect(after.view.coldRoot).not.toBe(reader.view.hotRoot);
    expect(after.view.headHash).toBe(reader.view.headHash);
    expect(
      await Array.fromAsync(
        enumerateIndexPages(oldRoot, reader.view.hotRoot, (id) => pages.read(id)),
      ),
    ).toEqual(entries);
    expect(
      await Array.fromAsync(
        enumerateIndexPages(replacementRoot, after.view.coldRoot, (id) => pages.read(id)),
      ),
    ).toEqual(entries);
    await f.store.releasePin(pin);
    await expect(f.store.readPinned(pin)).rejects.toThrow("index_pin_not_active");
    expect(await pages.read(original.descriptor.page.location)).toEqual(original.bytes); // No page deletion is authorized by releasing a pin.
  } finally {
    f.db.close();
  }
});

test("durable pins keep their exact cutoff across append and cutover; new pins require fresh view CAS", async () => {
  const f = fixture();
  try {
    let current = await f.append(await f.initialize());
    const pinned = await f.store.pinCurrent(current.view, "reader", "100");
    expect(pinned.id).toBe("1");
    const oldView = current.view;
    current = await f.append(current);
    await expect(f.store.pinCurrent(oldView, "reader", "100")).rejects.toThrow(
      "index_pin_view_conflict",
    );
    expect((await f.store.readMetadata()).view).toEqual(current.view); // ordinary conflicts do not gate the book.
    const frozen = await f.store.freeze(current.view, "pin-cutover");
    if (!frozen.frozen) throw new Error("Missing test prefix");
    const after = await f.store.install(
      frozen.view,
      frozen.frozen,
      H("cold-complete"),
      emptyIndexRoot(current.view.schema),
      "0",
    );
    expect(await f.store.readPinned(pinned)).toEqual(pinned);
    expect(pinned.view.sequence).toBe("1");
    expect(after.view.sequence).toBe("2");
    expect(after.view.revision).not.toBe(pinned.view.revision);
    expect((await f.store.pinCurrent(after.view, "construction", "100")).kind).toBe("construction");
    const before = f.anchor();
    await f.store.releasePin(pinned);
    await f.store.releasePin(pinned);
    await expect(f.store.readPinned(pinned)).rejects.toThrow("index_pin_not_active");
    expect(f.anchor()).toEqual(before);
    await expect(f.store.releasePin({ ...pinned, id: "999" })).rejects.toThrow(
      "index_pin_not_active",
    );
  } finally {
    f.db.close();
  }
});

test("expiry boundary and persisted clock floor prevent expired pin resurrection", async () => {
  const f = fixture();
  try {
    const current = await f.initialize();
    const pin = await f.store.pinCurrent(current.view, "reader", "100");
    f.clock.now = 99n;
    expect(await f.store.readPinned(pin)).toEqual(pin);
    f.clock.now = 100n;
    await expect(f.store.readPinned(pin)).rejects.toThrow("index_pin_expired");
    expect(f.db.query("SELECT count(*) AS count FROM ledger_index_pins").get()).toEqual({
      count: 0,
    });
    f.clock.now = 99n;
    await expect(f.open().readPinned(pin)).rejects.toThrow("index_pin_clock_regressed");
    f.clock.now = 100n;
    await expect(f.store.renewPin(pin, "200")).rejects.toThrow("index_pin_not_active");
    await expect(f.store.pinCurrent(current.view, "reader", "100")).rejects.toThrow(
      "index_pin_expired",
    );
    expect((await f.store.pinCurrent(current.view, "reader", "200")).id).toBe("2");
  } finally {
    f.db.close();
  }
});

test("lease renewal preserves the cutoff and reconciles exact retries after lost confirmation", async () => {
  const f = fixture();
  try {
    const current = await f.initialize();
    const pin = await f.store.pinCurrent(current.view, "reader", "100");
    await expect(f.store.renewPin(pin, "99")).rejects.toThrow("index_pin_conflict");
    f.faults.syncFailures = 1;
    await expect(f.store.renewPin(pin, "200")).rejects.toThrow("lost durability response");
    await expect(f.store.readPinned(pin)).rejects.toThrow("index_write_uncertain");
    await f.store.recoverMetadata();
    const renewed = await f.store.renewPin(pin, "200");
    expect(renewed).toEqual({ ...pin, expiresAt: "200" });
    await expect(f.store.readPinned(pin)).rejects.toThrow("index_pin_conflict");
    await expect(f.store.releasePin(pin)).rejects.toThrow("index_pin_conflict");
    expect(await f.store.readPinned(renewed)).toEqual(renewed);
    f.clock.now = 200n;
    await expect(f.store.renewPin(renewed, "300")).rejects.toThrow("index_pin_expired");
  } finally {
    f.db.close();
  }
});

test("expiry maintenance is bounded and numeric across digit lengths without reusing IDs", async () => {
  const f = fixture();
  try {
    const current = await f.initialize();
    const pins = [];
    for (const expiresAt of ["99", "1000", "100"])
      pins.push(await f.store.pinCurrent(current.view, "reader", expiresAt));
    f.clock.now = 100n;
    expect(await f.store.reapExpiredPins(1)).toBe(1);
    expect(await f.store.reapExpiredPins(1)).toBe(1);
    expect(await f.store.reapExpiredPins(1)).toBe(0);
    const plan = f.db.query(`EXPLAIN QUERY PLAN ${f.faults.lastSweepSql}`).all(3, "100", 1) as {
      detail: string;
    }[];
    expect(
      plan.some(
        (row) => row.detail.includes("SEARCH") && row.detail.includes("ledger_index_pin_expiry"),
      ),
    ).toBe(true);
    expect(plan.some((row) => row.detail.includes("SCAN"))).toBe(false);
    const survivor = pins[1];
    if (!survivor) throw new Error("Missing survivor");
    expect(await f.store.readPinned(survivor)).toEqual(survivor);
    await f.store.releasePin(survivor);
    expect((await f.store.pinCurrent(current.view, "reader", "1000")).id).toBe("4");
    expect(() => f.store.reapExpiredPins(0)).toThrow("index_pin_batch_invalid");
    expect(() => f.store.reapExpiredPins(1001)).toThrow("index_pin_batch_invalid");
  } finally {
    f.db.close();
  }
});

test("pin ID allocation and registry clock publish atomically across writers and SQL faults", async () => {
  const f = fixture();
  try {
    const current = await f.initialize();
    f.faults.afterSql = "UPDATE ledger_index_pin_state";
    await expect(f.store.pinCurrent(current.view, "reader", "100")).rejects.toThrow(
      "injected SQL failure",
    );
    f.faults.afterSql = "";
    await f.store.recoverMetadata();
    expect(f.db.query("SELECT count(*) AS count FROM ledger_index_pins").get()).toEqual({
      count: 0,
    });
    const pins = await Promise.all([
      f.store.pinCurrent(current.view, "reader", "100"),
      f.open().pinCurrent(current.view, "reader", "100"),
    ]);
    expect(pins.map((pin) => pin.id).sort()).toEqual(["1", "2"]);
    expect((await f.store.readMetadata()).view).toEqual(current.view);
    f.writeAnchor({ ...f.anchor(), pending: true });
    const first = pins[0];
    if (!first) throw new Error("Missing pin");
    await expect(f.store.readPinned(first)).rejects.toThrow("index_pin_view_conflict");
    await expect(f.store.renewPin(first, "200")).rejects.toThrow("index_pin_view_conflict");
    await expect(f.store.pinCurrent(current.view, "reader", "100")).rejects.toThrow(
      "index_pin_view_conflict",
    );
  } finally {
    f.db.close();
  }
});

test("pins and irreversible release survive a SQLite reopen after a lost response", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-index-pins-"));
  const path = join(directory, "pins.sqlite");
  let f = fixture(path);
  try {
    const current = await f.initialize();
    const active = await f.store.pinCurrent(current.view, "reader", "100");
    const released = await f.store.pinCurrent(current.view, "reader", "100");
    f.faults.syncFailures = 1;
    await expect(f.store.releasePin(released)).rejects.toThrow("lost durability response");
    f.db.close();
    f = fixture(path, true);
    await f.store.recoverMetadata();
    expect(await f.store.readPinned(active)).toEqual(active);
    await expect(f.store.readPinned(released)).rejects.toThrow("index_pin_not_active");
    expect((await f.store.pinCurrent(current.view, "reader", "100")).id).toBe("3");
    f.clock.now = 100n;
    await expect(f.store.readPinned(active)).rejects.toThrow("index_pin_expired");
    f.db.close();
    f = fixture(path, true);
    f.clock.now = 99n;
    await expect(f.store.readPinned(active)).rejects.toThrow("index_pin_clock_regressed");
  } finally {
    f.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pin records reject forged cutoff, NUL-suffixed digest and malformed registry state", async () => {
  const f = fixture();
  try {
    const current = await f.initialize();
    const pin = await f.store.pinCurrent(current.view, "reader", "100");
    await expect(
      f.store.readPinned({ ...pin, view: { ...pin.view, headHash: H("forged") } }),
    ).rejects.toThrow("index_pin_conflict");
    await expect(f.store.readPinned({ ...pin, view: { ...pin.view, fence: "9" } })).rejects.toThrow(
      "index_pin_view_conflict",
    );
    const digest = (f.db.query("SELECT digest FROM ledger_index_pins").get() as { digest: string })
      .digest;
    f.db.query("UPDATE ledger_index_pins SET digest = ?").run(`${digest}\0hidden`);
    await expect(f.store.readPinned(pin)).rejects.toThrow("index_pin_storage_corrupt");
    f.db.query("UPDATE ledger_index_pins SET digest = ?").run(digest);
    await f.store.recoverMetadata();
    const body = '{"issued":"1","lastTime":"10","lastTime":"10"}';
    f.db
      .query("UPDATE ledger_index_pin_state SET body = ?, digest = ?")
      .run(body, hashCanonical({ domain: "rastrata-index-pin-v1", body }).digest);
    await expect(f.store.readPinned(pin)).rejects.toThrow("index_pin_storage_corrupt");
  } finally {
    f.db.close();
  }
});

test("index control atomically advances canonical/hot state and preserves post-freeze rejection tail", async () => {
  const f = fixture();
  try {
    let current = await f.initialize();
    expect(current.view.sequence).toBe("0");
    current = await f.append(current);
    current = await f.append(current);
    const frozen = await f.store.freeze(current.view, "merge-1");
    expect(frozen.frozen).toMatchObject({
      through: "2",
      prefixCount: "10",
      prefixRoot: H("hot-2"),
    });
    current = await f.append(frozen, 1n); // retained rejection contributes its command ID
    const head = f.anchor();
    if (!frozen.frozen) throw new Error("missing fixture prefix");
    const installed = await f.store.install(
      current.view,
      frozen.frozen,
      H("cold-through-2"),
      H("rejection-3-only"),
      "1",
    );
    expect(installed.view).toMatchObject({
      sequence: "3",
      revision: "4",
      coldThrough: "2",
      coldCount: "10",
      hotCount: "1",
      hotRoot: H("rejection-3-only"),
    });
    expect(installed.frozen).toBeNull();
    expect(f.anchor()).toEqual(head);
    expect(await f.open().readMetadata()).toEqual(installed);
  } finally {
    f.db.close();
  }
});

test("cutover requires a fresh full view and exact selected prefix without dropping the tail", async () => {
  for (const failure of ["stale-view", "wrong-prefix", "lost-tail", "inflated-tail", "pending"]) {
    const f = fixture();
    try {
      const first = await f.append(await f.initialize());
      const frozen = await f.store.freeze(first.view, "merge-1");
      const current = await f.append(frozen, 1n);
      if (!frozen.frozen) throw new Error("missing fixture prefix");
      if (failure === "pending") f.writeAnchor({ ...f.anchor(), pending: true });
      const original = f.db.query("SELECT body FROM ledger_index_control").get();
      await expect(
        f.store.install(
          failure === "stale-view" ? first.view : current.view,
          failure === "wrong-prefix" ? { ...frozen.frozen, id: "other-merge" } : frozen.frozen,
          H("cold"),
          H("tail"),
          failure === "lost-tail" ? "0" : failure === "inflated-tail" ? "2" : "1",
        ),
      ).rejects.toThrow();
      expect(f.db.query("SELECT body FROM ledger_index_control").get()).toEqual(original);
      expect((await f.store.recoverMetadata()).view).toEqual(current.view);
    } finally {
      f.db.close();
    }
  }
});

test("SQL failure after either write rolls canonical and index state back together", async () => {
  for (const afterSql of ["UPDATE canonical_anchor", "UPDATE ledger_index_control"]) {
    const f = fixture();
    try {
      const current = await f.initialize();
      const before = f.anchor();
      f.faults.afterSql = afterSql;
      await expect(f.append(current)).rejects.toThrow("injected SQL failure");
      expect(f.anchor()).toEqual(before);
      f.faults.afterSql = "";
      expect(await f.store.recoverMetadata()).toEqual(current);
    } finally {
      f.db.close();
    }
  }
});

test("lost confirmation gates the instance and recovery finds the exact committed view without reapplying", async () => {
  const f = fixture();
  try {
    const current = await f.initialize();
    f.faults.syncFailures = 1;
    await expect(f.append(current)).rejects.toThrow("lost durability response");
    await expect(f.store.readMetadata()).rejects.toThrow("index_write_uncertain");
    const recovered = await f.store.recoverMetadata();
    expect(recovered.view).toMatchObject({
      sequence: "1",
      revision: "1",
      hotCount: "5",
      hotRoot: H("hot-1"),
    });
    await expect(f.append(current)).rejects.toThrow("index_view_conflict");
    expect(f.anchor().sequence).toBe("1");
    expect(await f.open().readMetadata()).toEqual(recovered);
  } finally {
    f.db.close();
  }
});

test("lost freeze/cutover replies are reconstructed exactly after reopening a real SQLite file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rastrata-index-control-"));
  const path = join(dir, "book.sqlite");
  let f = fixture(path);
  try {
    let current = await f.append(await f.initialize());
    f.faults.syncFailures = 1;
    await expect(f.store.freeze(current.view, "merge-on-disk")).rejects.toThrow(
      "lost durability response",
    );
    f.db.close();
    f = fixture(path, true);
    current = await f.store.recoverMetadata();
    expect(current.frozen?.id).toBe("merge-on-disk");
    if (!current.frozen) throw new Error("missing recovered prefix");
    const expectedHead = f.anchor();
    f.faults.syncFailures = 1;
    await expect(
      f.store.install(
        current.view,
        current.frozen,
        H("cold-1"),
        emptyIndexRoot(current.view.schema),
        "0",
      ),
    ).rejects.toThrow("lost durability response");
    f.db.close();
    f = fixture(path, true);
    const recovered = await f.store.recoverMetadata();
    expect(recovered.view).toMatchObject({
      sequence: "1",
      revision: "2",
      coldThrough: "1",
      coldCount: "5",
      hotCount: "0",
    });
    expect(recovered.frozen).toBeNull();
    expect(f.anchor()).toEqual(expectedHead);
  } finally {
    f.db.close();
    rmSync(dir, { recursive: true });
  }
});

test("read captures metadata before durability wait, not a newer unconfirmed writer's state", async () => {
  const f = fixture();
  try {
    const current = await f.initialize();
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.faults.syncHook = () => {
      entered?.();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const read = f.store.readMetadata();
    await waiting;
    f.faults.syncHook = undefined;
    const next = { ...f.anchor(), sequence: "1", headHash: H("head-1") };
    await f.open().append(current.view, next, H("hot-1"), "1", () => {
      f.writeAnchor(next);
      return undefined;
    });
    release?.();
    expect(await read).toEqual(current);
    expect((await f.store.readMetadata()).view.sequence).toBe("1");
  } finally {
    f.db.close();
  }
});

test("initialization requires reserved genesis and never resets existing metadata", async () => {
  const f = fixture();
  try {
    const current = await f.initialize();
    await expect(f.store.initialize("test-identity-schema-v1")).rejects.toThrow(
      "index_initialization_forbidden",
    );
    expect(await f.store.recoverMetadata()).toEqual(current);
    f.writeAnchor({ ...f.anchor(), provisioning: true });
    await expect(f.store.initialize("test-identity-schema-v1")).rejects.toThrow();
    expect(await f.store.recoverMetadata()).toEqual(current);
    await expect(f.store.freeze(current.view, "empty")).rejects.toThrow("index_empty_freeze");
  } finally {
    f.db.close();
  }
});

test("checksums do not excuse duplicate JSON keys, unknown shape, invalid ranges or empty-root forgery", async () => {
  const changes: ((body: string) => string)[] = [
    (body) => body.replace('"format":', '"format":"rastrata-index-control-tracked-v1","format":'),
    (body) => `${body}\n`,
    () => "not-json",
    (body) => JSON.stringify({ ...JSON.parse(body), unknown: true }),
    (body) => {
      const parsed = JSON.parse(body);
      parsed.view.revision = "01";
      return JSON.stringify(parsed);
    },
    (body) => {
      const parsed = JSON.parse(body);
      parsed.view.coldThrough = "1";
      return JSON.stringify(parsed);
    },
    (body) => {
      const parsed = JSON.parse(body);
      parsed.view.hotRoot = H("forged-empty");
      return JSON.stringify(parsed);
    },
  ];
  for (const change of changes) {
    const f = fixture();
    try {
      await f.initialize();
      f.tamper(change);
      await expect(f.store.readMetadata()).rejects.toThrow();
      await expect(f.store.readMetadata()).rejects.toThrow("index_write_uncertain");
    } finally {
      f.db.close();
    }
  }
});

test("missing metadata, bad checksum and wrong canonical identity/fence/head fail closed", async () => {
  for (const damage of [
    "missing",
    "checksum",
    "identityHash",
    "headHash",
    "fence",
    "sequence",
  ] as const) {
    const f = fixture();
    try {
      await f.initialize();
      if (damage === "missing") f.db.exec("DELETE FROM ledger_index_control");
      else if (damage === "checksum")
        f.db.query("UPDATE ledger_index_control SET digest = ?").run(H("wrong"));
      else
        f.writeAnchor({
          ...f.anchor(),
          [damage]: damage === "sequence" || damage === "fence" ? "1" : H("wrong"),
        });
      await expect(f.open().recoverMetadata()).rejects.toThrow();
    } finally {
      f.db.close();
    }
  }
});

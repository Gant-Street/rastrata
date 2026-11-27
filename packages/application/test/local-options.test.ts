import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationHttp } from "../src/http.ts";
import { LocalBookService } from "../src/local.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS, operationCatalog } from "../src/schema.ts";
import { BULK_BOOK, postBulk } from "./support/bulk-book.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0).reverse()) work();
});

function path() {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-local-options-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "book.sqlite");
}

/** The tables of a book's file, read through a service's own store. */
const tables = (service: LocalBookService): string[] =>
  (
    service.store
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as {
      name: string;
    }[]
  ).map((row) => row.name);

test("a local book keeps a verified-state snapshot unless told not to", async () => {
  const kept = await LocalBookService.open(path());
  cleanup.push(() => kept.close());
  await kept.setup(BULK_BOOK);
  await postBulk(kept, 120);
  await kept.readAggregate();
  expect(tables(kept)).toContain("app_read_snapshots");
  expect(kept.readStats.snapshotsWritten).toBe(1);

  const without = await LocalBookService.open(path(), { snapshots: false });
  cleanup.push(() => without.close());
  await without.setup(BULK_BOOK);
  await postBulk(without, 120);
  const { aggregate } = await without.readAggregate();
  expect(aggregate.state.journals.length).toBe(120);
  // No table, no encode attempt, and the read is the same read.
  expect(tables(without)).not.toContain("app_read_snapshots");
  expect(without.readStats.snapshotsWritten).toBe(0);
  expect(without.readStats.full).toBe(1);
});

test("a host is handed the open database before the ledger uses it, and may refuse", async () => {
  const seen: { tables: string[]; walMode: string }[] = [];
  const service = await LocalBookService.open(path(), {
    onDatabase: (db: Database) => {
      seen.push({
        tables: (
          db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
        ).map((row) => row.name),
        walMode: (db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
      });
    },
  });
  cleanup.push(() => service.close());
  // The pragmas were already set, and nothing of the book existed yet.
  expect(seen).toEqual([{ tables: [], walMode: "wal" }]);

  await expect(
    LocalBookService.open(path(), {
      onDatabase: () => {
        throw new Error("refused by the host");
      },
    }),
  ).rejects.toThrow("refused by the host");
});

test("a host can hand the service its own connection, which the service never closes", async () => {
  const db = new Database(path(), { create: true });
  db.exec("PRAGMA journal_mode=WAL");
  cleanup.push(() => db.close());

  const first = await LocalBookService.open("unused", {
    database: db,
    safety: false,
    snapshots: false,
  });
  await first.setup(BULK_BOOK);
  await postBulk(first, 25);
  first.close();
  // Closing the service left the host's connection open and the book on it.
  expect(
    (db.query("SELECT count(*) AS n FROM sqlite_master").get() as { n: number }).n,
  ).toBeGreaterThan(0);

  // A host that changed the database under a service opens another on the same connection.
  const second = await LocalBookService.open("unused", {
    database: db,
    safety: false,
    snapshots: false,
  });
  expect((await second.readAggregate()).aggregate.state.journals.length).toBe(25);
  second.close();

  // A refusal during the open does not close it either.
  await expect(
    LocalBookService.open("unused", {
      database: db,
      safety: false,
      onDatabase: () => {
        throw new Error("refused by the host");
      },
    }),
  ).rejects.toThrow("refused by the host");
  expect(db.query("SELECT 1 AS one").get()).toEqual({ one: 1 });
});

test("rows a host's triggers change are not counted as rows the statement changed", async () => {
  const db = new Database(path(), { create: true });
  cleanup.push(() => db.close());
  db.exec(`
    CREATE TABLE host_t (id INTEGER PRIMARY KEY, v TEXT);
    CREATE TABLE host_log (n INTEGER);
    CREATE TRIGGER host_t_u AFTER UPDATE ON host_t BEGIN
      INSERT INTO host_log (n) VALUES (1);
      INSERT INTO host_log (n) VALUES (2);
    END;
  `);
  const service = await LocalBookService.open("unused", {
    database: db,
    safety: false,
    snapshots: false,
  });
  db.run("INSERT INTO host_t (id, v) VALUES (1, 'a')");
  // Callers compare this with 1 to learn that nobody else changed the row.
  expect(service.store.query("UPDATE host_t SET v='b' WHERE id=1").run().changes).toBe(1);
  expect(service.store.query("UPDATE host_t SET v='c' WHERE id=99").run().changes).toBe(0);
  expect(service.store.query("DELETE FROM host_log").run().changes).toBe(2);
  service.close();
});

test("prepareSlices makes every slice's tables when the book is opened, and nothing makes one afterwards", async () => {
  const db = new Database(path(), { create: true });
  cleanup.push(() => db.close());
  const schema = () =>
    (
      db
        .query(
          "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all() as { type: string; name: string }[]
    ).map((row) => `${row.type}:${row.name}`);

  // Left alone, a slice makes its tables when it is first used: a read changes the schema.
  const lazy = await LocalBookService.open("unused", {
    database: db,
    safety: false,
    snapshots: false,
  });
  await lazy.setup(BULK_BOOK);
  const before = schema();
  const http = new ApplicationHttp(lazy, {
    bookId: lazy.bookId,
    permissions: BUSINESS_PERMISSIONS,
  });
  const call = async (name: string, input: unknown = {}) => {
    const response = await http.fetch(
      new Request(`http://127.0.0.1:4010/v1/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: APPLICATION_API_VERSION, bookId: "local-book", input }),
      }),
    );
    await response.arrayBuffer();
  };
  const reads = operationCatalog.filter((operation) => !operation.writes);
  for (const operation of reads) await call(operation.name);
  expect(schema().length).toBeGreaterThan(before.length);
  lazy.close();

  // Prepared, the same book has all of them from the start, and the same reads add nothing.
  const other = new Database(path(), { create: true });
  cleanup.push(() => other.close());
  const prepared = await LocalBookService.open("unused", {
    database: other,
    safety: false,
    snapshots: false,
    prepareSlices: true,
  });
  const names = () =>
    (
      other
        .query(
          "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all() as { type: string; name: string }[]
    ).map((row) => `${row.type}:${row.name}`);
  await prepared.setup(BULK_BOOK);
  const start = names();
  const slices = (
    other.query("SELECT slice FROM app_slice_migrations ORDER BY slice").all() as {
      slice: string;
    }[]
  ).map((row) => row.slice);
  expect(slices).toEqual([
    "agent",
    "bankfeed",
    "banks",
    "changes",
    "chart",
    "entries",
    "ingest",
    "intake",
    "members",
    "payees",
    "plugins",
    "reconcile",
    "rules",
    "safety",
    "shadow",
    "statements",
    "stripe",
    "tax",
  ]);
  const preparedHttp = new ApplicationHttp(prepared, {
    bookId: prepared.bookId,
    permissions: BUSINESS_PERMISSIONS,
  });
  for (const operation of reads) {
    const response = await preparedHttp.fetch(
      new Request(`http://127.0.0.1:4010/v1/${operation.name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: APPLICATION_API_VERSION, bookId: "local-book", input: {} }),
      }),
    );
    await response.arrayBuffer();
  }
  expect(names()).toEqual(start);
  prepared.close();
});

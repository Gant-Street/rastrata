import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangeCapture } from "../src/capture.ts";
import { VirtualClock } from "../src/clock.ts";
import { FileObjectStore } from "../src/store-file.ts";
import { ImportError, importBookFile } from "../src/import.ts";
import { TailBehindBulkError } from "../src/materialize.ts";
import { MemoryObjectStore } from "../src/memory.ts";
import { SimPodClock } from "../src/podclock.ts";
import { BookRuntime } from "../src/runtime.ts";
import { MemoryLogTier } from "../src/tier-memory.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const scratch = () => {
  const directory = mkdtempSync(join(tmpdir(), "booklog-import-test-"));
  directories.push(directory);
  return directory;
};

/** A closed book file the way a local product leaves one. */
function closedBook(directory: string, rows: number): string {
  const path = join(directory, "local-book.sqlite");
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE ops (id TEXT PRIMARY KEY, result TEXT NOT NULL);
    CREATE TABLE kv (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL, k TEXT NOT NULL, amount INTEGER NOT NULL);
    CREATE TABLE derived (k TEXT PRIMARY KEY, v);
  `);
  for (let index = 0; index < rows; index += 1) {
    db.run("INSERT INTO kv (k, v) VALUES (?, ?)", [`key-${index}`, index]);
    db.run("INSERT INTO events (op, k, amount) VALUES (?, ?, ?)", [
      `op-${index}`,
      `key-${index}`,
      index,
    ]);
    db.run("INSERT INTO ops (id, result) VALUES (?, ?)", [`op-${index}`, String(index)]);
  }
  db.run("INSERT INTO derived (k, v) VALUES ('cache', 'x')");
  db.close();
  return path;
}

test("a closed book file becomes the beginning of a log, and a cold process reads it back exactly", async () => {
  const directory = scratch();
  const path = closedBook(directory, 300);
  const clock = new VirtualClock();
  const tier = new MemoryLogTier({ clock });
  const bulk = new MemoryObjectStore({ clock });
  const imported = await importBookFile({
    tier,
    bulk,
    bookId: "b1",
    prefix: "runs/t/",
    path,
    schema: 1,
    exclude: ["derived"],
    journals: 300,
    clock,
  });
  expect(imported.seq).toBe(1);
  expect(imported.manifest.journals).toBe(300);
  expect(bulk.keys("runs/t/books/b1/snap/")).toHaveLength(2);
  expect((await tier.head("b1")).seq).toBe(1);

  const reference = new Database(path, { readonly: true });
  const expected = new ChangeCapture(reference, { exclude: ["derived"] }).stateHash();
  reference.close();

  const runtime = await BookRuntime.open({
    tier,
    bulk,
    bookId: "b1",
    prefix: "runs/t/",
    holder: "pod-a#1",
    path: join(directory, "cache.sqlite"),
    schema: 1,
    exclude: ["derived"],
    clock,
    pod: new SimPodClock(clock),
    sealing: { delayMs: 0 },
  });
  expect(runtime.stats.activation?.source).toBe("base");
  expect(runtime.stats.activation?.snapshotBytes).toBe(imported.bytes);
  expect(runtime.head).toEqual({ seq: 1, hash: imported.hash });
  expect(runtime.capture.stateHash()).toBe(expected);
  // And it is a live book: a write lands as entry 2, replicated like any other.
  await runtime.write((db) => db.run("INSERT INTO kv (k, v) VALUES ('after', 1)"));
  expect(runtime.head.seq).toBe(2);
  await runtime.close({ seal: false });

  const second = await BookRuntime.open({
    tier,
    bulk,
    bookId: "b1",
    prefix: "runs/t/",
    holder: "pod-b#1",
    path: join(directory, "other.sqlite"),
    schema: 1,
    exclude: ["derived"],
    clock,
    pod: new SimPodClock(clock),
    sealing: { delayMs: 0 },
  });
  expect(second.stats.activation).toMatchObject({ source: "base", entriesApplied: 2 });
  expect(second.db.query("SELECT v FROM kv WHERE k='after'").get()).toEqual({ v: 1 });
  expect(second.db.query("SELECT name FROM sqlite_master WHERE name='derived'").get()).toBeNull();
  await second.close({ seal: false });
});

test("the book file is not touched, and a book already in the log is refused", async () => {
  const directory = scratch();
  const path = closedBook(directory, 20);
  const before = new Database(path, { readonly: true }).query("SELECT count(*) c FROM kv").get();
  const tier = new MemoryLogTier();
  const bulk = new MemoryObjectStore();
  await importBookFile({ tier, bulk, bookId: "b1", path, schema: 1, exclude: ["derived"] });
  expect(new Database(path, { readonly: true }).query("SELECT count(*) c FROM kv").get()).toEqual(
    before,
  );
  await expect(
    importBookFile({ tier, bulk, bookId: "b1", path, schema: 1 }),
  ).rejects.toBeInstanceOf(ImportError);
});

test("a tampered base snapshot is refused by the process that would use it", async () => {
  const directory = scratch();
  const path = closedBook(directory, 20);
  const clock = new VirtualClock();
  const tier = new MemoryLogTier({ clock });
  const bulk = new MemoryObjectStore({ clock });
  await importBookFile({
    tier,
    bulk,
    bookId: "b1",
    prefix: "runs/t/",
    path,
    schema: 1,
    exclude: ["derived"],
    clock,
  });
  const key = "runs/t/books/b1/snap/000000000001.sqlite.gz";
  const stored = bulk.peek(key)?.body.slice() as Uint8Array;
  stored[stored.length - 20] = (stored[stored.length - 20] as number) ^ 0xff;
  bulk.remove(key);
  bulk.plant(key, stored);
  await expect(
    BookRuntime.open({
      tier,
      bulk,
      bookId: "b1",
      prefix: "runs/t/",
      holder: "pod-a#1",
      path: join(directory, "cache.sqlite"),
      schema: 1,
      exclude: ["derived"],
      clock,
      pod: new SimPodClock(clock),
    }),
  ).rejects.toThrow(/digest/);
});

test("a directory can stand in for the bucket: create-only, ordered, listed by prefix", async () => {
  const directory = scratch();
  const store = new FileObjectStore(join(directory, "bucket"));
  expect(
    (
      await store.putIfAbsent("books/b1/log/000000000002", new Uint8Array([2]), {
        metadata: { Hash: "h2" },
      })
    ).created,
  ).toBe(true);
  expect((await store.putIfAbsent("books/b1/log/000000000001", new Uint8Array([1]))).created).toBe(
    true,
  );
  expect((await store.putIfAbsent("books/b1/log/000000000001", new Uint8Array([9]))).created).toBe(
    false,
  );
  expect((await store.get("books/b1/log/000000000001"))?.body).toEqual(new Uint8Array([1]));
  expect((await store.head("books/b1/log/000000000002"))?.metadata).toEqual({ hash: "h2" });
  const page = await store.list("books/b1/log/");
  expect(page.objects.map((item) => item.key)).toEqual([
    "books/b1/log/000000000001",
    "books/b1/log/000000000002",
  ]);
  expect((await store.list("books/b1/log/", "books/b1/log/000000000001")).objects).toHaveLength(1);
  expect(await store.get("books/b1/nothing")).toBeNull();
  await store.delete("books/b1/log/000000000001");
  expect(await store.head("books/b1/log/000000000001")).toBeNull();
  // Fifty at once: exactly one wins.
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, index) => store.putIfAbsent("race", new Uint8Array([index]))),
  );
  expect(results.filter((result) => result.created)).toHaveLength(1);
});

test("an imported book whose tail was wiped is refused, not served as a new empty book", async () => {
  const directory = scratch();
  const path = closedBook(directory, 20);
  const clock = new VirtualClock();
  const tier = new MemoryLogTier({ clock });
  const bulk = new MemoryObjectStore({ clock });
  await importBookFile({
    tier,
    bulk,
    bookId: "b1",
    prefix: "runs/t/",
    path,
    schema: 1,
    exclude: ["derived"],
    clock,
  });
  // The tail starts again, empty, in front of the same bucket: a wiped database, a reset object.
  const wiped = new MemoryLogTier({ clock });
  await expect(
    BookRuntime.open({
      tier: wiped,
      bulk,
      bookId: "b1",
      prefix: "runs/t/",
      holder: "pod#1",
      path: join(directory, "cache.sqlite"),
      schema: 1,
      exclude: ["derived"],
      clock,
      pod: new SimPodClock(clock),
    }),
  ).rejects.toBeInstanceOf(TailBehindBulkError);
  // It did not keep the lease it took to look, and started no second history.
  expect((await wiped.head("b1")).leaseHolder).toBeNull();
  expect((await wiped.head("b1")).seq).toBe(0);
  expect(bulk.keys("runs/t/books/b1/sealed/")).toEqual([]);
});

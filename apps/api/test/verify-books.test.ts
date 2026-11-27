// The integrity verifier (src/verify-books.ts) on books made the way production makes them: a hosted server over a bucket and a tail, the application's own commands, a snapshot taken by the pod. A book
// is corrupted in the ways a book can be (a byte of a sealed segment, a missing segment, an outcome of the ledger changed under a chain that is valid), and the verifier must find each, stop the
// book, and leave alone a book that only had trouble reaching its storage. See docs/reference/program/hosting/verifier.md.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { issueOwnerKey } from "@rastrata/application/agent";
import { APPLICATION_API_VERSION } from "@rastrata/application/schema";
import {
  BookKeys,
  FileObjectStore,
  ObjectStoreUncertain,
  readReviews,
  type ObjectStore,
} from "@rastrata/booklog";
import { MemoryLogTier, MemoryObjectStore } from "@rastrata/booklog/testing";
import { parseBookStore, startHostedApplicationServer } from "../src/hosted.ts";
import {
  compareDatabases,
  listBooks,
  verifyBook,
  type VerifyOptions,
} from "../src/verify-books.ts";
import { bucketWith, breakOutcome, importedBook, tierWith } from "./support/verifier-books.ts";

const OWNER_KEY = issueOwnerKey();
const HOST = "app.example.test";
const PUBLIC = "https://app.example.test";
const BOOK = "book-1";
const SETUP = {
  name: "Verified Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1010", name: "Checking", role: "asset" },
    { code: "3100", name: "Owner draw", role: "equity" },
    { code: "6100", name: "Software", role: "expense" },
  ],
} as const;
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** The same tail and bucket a hosted server uses in a test: a memory tail and a folder, which the verifier reads as the cluster's job reads the real ones. */
function world() {
  const root = mkdtempSync(join(tmpdir(), "rastrata-verifier-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const tail = new MemoryLogTier();
  const bucket = join(root, "bucket");
  const bulk = new FileObjectStore(bucket);
  const scratch = join(root, "scratch");
  const options = (extra: Partial<VerifyOptions> = {}): VerifyOptions => ({
    tier: tail,
    bulk,
    prefix: "",
    scratch,
    build: "test-build",
    pause: async () => {},
    ...extra,
  });
  async function serve(book = BOOK) {
    const server = await startHostedApplicationServer({
      config: parseBookStore(`r2log://${book}`, {
        RASTRATA_BOOK_BULK: pathToFileURL(bucket).href,
        RASTRATA_BOOK_TAIL: "memory",
        RASTRATA_BOOK_CACHE: join(root, "cache"),
      }),
      port: 0,
      telemetry: false,
      stores: { tail },
      log: () => {},
      ownerKey: OWNER_KEY,
      serving: { bind: "0.0.0.0", allowedHosts: [HOST], publicOrigin: PUBLIC },
      web: null,
    });
    cleanup.push(() => server.stop());
    const base = `http://127.0.0.1:${server.server.port}`;
    let n = 100;
    const call = async (name: string, input: unknown = {}, writes = true) => {
      const response = await fetch(`${base}/v1/${name}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: HOST,
          authorization: `Bearer ${OWNER_KEY}`,
        },
        body: JSON.stringify({
          version: APPLICATION_API_VERSION,
          bookId: "local-book",
          input,
          ...(writes ? { operationId: id(++n) } : {}),
        }),
      });
      return { status: response.status, body: (await response.json()) as { data?: unknown } };
    };
    const post = async (reference: string) => {
      const posted = await call("journal.post", {
        data: {
          date: "2026-03-02",
          reference,
          narration: reference,
          lines: [
            { accountId: "6100", debit: "5.00", credit: "" },
            { accountId: "1010", debit: "", credit: "5.00" },
          ],
        },
      });
      expect(posted.status).toBe(200);
    };
    return { server, call, post };
  }
  /** A closed book file, set up and given twenty journals, put into the log as a hosted book's beginning; `change` is applied to the file first, so the log is a valid chain of a book that
   * is not. */
  const imported = (book: string, change?: (db: Database) => void) =>
    importedBook({ folder: root, tier: tail, bulk, book, ...(change ? { change } : {}) });
  return { root, tail, bulk, bucket, scratch, options, serve, imported };
}

const keysOf = (book = BOOK) => new BookKeys("", book);

/** The path of the one sealed segment a stopped server left in the bucket. */
function sealedSegment(bucket: string, book = BOOK): string {
  const folder = join(bucket, "books", book, "sealed");
  const files = readdirSync(folder);
  expect(files.length).toBeGreaterThan(0);
  return join(folder, files.sort()[0] as string);
}

// ---- a sound book ---------------------------------------------------------------------------------------------------------------------

test("a book a server has been writing, with a snapshot in the middle of it, is sound: the log, the ledger replayed in full, and the snapshot a pod would start from all agree, while the pod is serving", async () => {
  const w = world();
  const live = await w.serve();
  expect((await live.call("book.setup", SETUP)).status).toBe(200);
  for (let n = 0; n < 3; n += 1) await live.post(`before-${n}`);
  await live.server.book?.runtime.snapshotNow();
  for (let n = 0; n < 2; n += 1) await live.post(`after-${n}`);

  const verdict = await verifyBook(w.options(), BOOK);
  expect(verdict).toMatchObject({
    status: "ok",
    book: BOOK,
    ledger: true,
    journals: 5,
    // The setup and the five journals.
    outcomes: 6,
    snapshot: "matches",
    warnings: [],
  });
  if (verdict.status !== "ok") throw new Error("not ok");
  expect(verdict.entries).toBe((await w.tail.head(BOOK)).seq);
  // The working folder is gone, and nothing was written to the bucket for the book.
  expect(existsSync(join(w.scratch, BOOK))).toBe(false);
  expect(await readReviews(w.bulk, keysOf())).toEqual([]);

  // Once the pod has stopped and sealed everything, the same book reads the same.
  await live.server.stop();
  expect(await verifyBook(w.options(), BOOK)).toMatchObject({
    status: "ok",
    journals: 5,
    snapshot: "matches",
  });
}, 120_000);

test("a book nobody has set up has no ledger, and is sound without one: there is nothing to replay", async () => {
  const w = world();
  const live = await w.serve();
  expect((await live.call("book.get", {}, false)).status).toBe(200);
  await live.server.stop();
  const verdict = await verifyBook(w.options(), BOOK);
  expect(verdict).toMatchObject({ status: "ok", ledger: false, outcomes: 0, journals: 0 });
}, 60_000);

test("a book that is in the bucket and not in the log is not sound: the tail has lost it, and the verifier says so and stops it", async () => {
  const w = world();
  const live = await w.serve();
  expect((await live.call("book.setup", SETUP)).status).toBe(200);
  await live.post("one");
  await live.server.stop();
  // A tail that has forgotten the book (a wiped object) while the bucket still holds its sealed history.
  const forgetful = new MemoryLogTier();
  const verdict = await verifyBook(w.options({ tier: forgetful }), BOOK);
  expect(verdict).toMatchObject({
    status: "failed",
    finding: { kind: "unreadable", check: "tail_behind_bulk" },
    stop: "recorded",
  });
}, 60_000);

// ---- a book that is wrong -------------------------------------------------------------------------------------------------------------

test("an outcome of the ledger changed under a log that is a valid chain is found by the replay, the book is stopped with a record that holds no value from it, and the pod then refuses it", async () => {
  const w = world();
  // The log is perfectly consistent: the book it holds is not. Outcome 5 has one character changed.
  await w.imported("book-1", breakOutcome(5));
  const verdict = await verifyBook(w.options(), BOOK);
  expect(verdict).toMatchObject({
    status: "failed",
    finding: { kind: "replay_failed", check: "ledger_replay" },
    stop: "recorded",
    marker: 1,
  });
  const records = await readReviews(w.bulk, keysOf());
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    number: 1,
    kind: "replay_failed",
    check: "ledger_replay",
    verifier: "test-build",
  });
  // What is stored is a kind, a number, a name and times: nothing the book holds.
  expect(Object.keys(records[0] as object).sort()).toEqual(
    ["at", "check", "expected", "found", "kind", "number", "seq", "verifier"].sort(),
  );
  expect(JSON.stringify(records)).not.toContain("Bulk Co");

  // The next run of the schedule leaves a stopped book alone; a person asking for it gets it looked at, and no second record is made.
  expect(await verifyBook(w.options({ skipReviewed: true }), BOOK)).toMatchObject({
    status: "skipped",
    reason: "reviewed",
  });
  expect(await verifyBook(w.options(), BOOK)).toMatchObject({ status: "failed", stop: "already" });
  expect(await readReviews(w.bulk, keysOf())).toHaveLength(1);

  // The pod does not open it.
  const pod = await w.serve();
  const refused = await pod.call("book.get", {}, false);
  expect(refused.status).toBe(423);
  expect(JSON.stringify(refused.body)).toContain("book_under_review");
  expect(JSON.stringify(refused.body)).not.toContain("Bulk Co");
}, 120_000);

test("a person looking into a book can keep the database the log made, which is the book as the log has it", async () => {
  const w = world();
  await w.imported("book-1", breakOutcome(5));
  const keep = join(w.root, "kept");
  const verdict = await verifyBook(w.options({ keep, record: false }), BOOK);
  expect(verdict.status).toBe("failed");
  const kept = new Database(join(keep, `${BOOK}.sqlite`), { readonly: true });
  expect(
    (kept.query("SELECT count(*) AS n FROM ledger_native_outcomes").get() as { n: number }).n,
  ).toBeGreaterThan(5);
  kept.close();
  // The working folder itself is still removed.
  expect(existsSync(join(w.scratch, BOOK))).toBe(false);
}, 120_000);

test("with recording off a finding is only reported", async () => {
  const w = world();
  await w.imported("book-1", breakOutcome(3));
  expect(await verifyBook(w.options({ record: false }), BOOK)).toMatchObject({
    status: "failed",
    stop: "dry_run",
    marker: null,
  });
  expect(await readReviews(w.bulk, keysOf())).toEqual([]);
}, 120_000);

test("a byte of a sealed segment that has been changed is a break in the chain, found at the entry it is in", async () => {
  const w = world();
  const live = await w.serve();
  expect((await live.call("book.setup", SETUP)).status).toBe(200);
  await live.post("one");
  await live.post("two");
  await live.server.stop();
  const file = sealedSegment(w.bucket);
  const bytes = readFileSync(file);
  bytes[Math.floor(bytes.length / 2)] = (bytes[Math.floor(bytes.length / 2)] as number) ^ 0xff;
  writeFileSync(file, bytes);
  const verdict = await verifyBook(w.options(), BOOK);
  expect(verdict).toMatchObject({
    status: "failed",
    finding: { kind: "chain_break" },
    stop: "recorded",
  });
  expect((await readReviews(w.bulk, keysOf()))[0]).toMatchObject({ kind: "chain_break" });
}, 60_000);

test("a sealed segment that is gone is a hole in the history, after the log has been looked at again for it", async () => {
  const w = world();
  const live = await w.serve();
  expect((await live.call("book.setup", SETUP)).status).toBe(200);
  await live.post("one");
  await live.server.stop();
  rmSync(sealedSegment(w.bucket));
  let waits = 0;
  const verdict = await verifyBook(
    w.options({
      pause: async () => {
        waits += 1;
      },
    }),
    BOOK,
  );
  expect(verdict).toMatchObject({
    status: "failed",
    finding: { kind: "unreadable", check: "log_gap" },
    stop: "recorded",
  });
  // Three looks again before it was believed, and again for the second reading that confirmed it.
  expect(waits).toBeGreaterThanOrEqual(3);
}, 60_000);

test("a snapshot that holds something the log does not make is found by comparing the two, and the book is stopped", async () => {
  const w = world();
  const live = await w.serve();
  expect((await live.call("book.setup", SETUP)).status).toBe(200);
  await live.post("one");
  await live.server.book?.runtime.snapshotNow();
  await live.post("two");
  await live.server.stop();
  const clean = await verifyBook(w.options(), BOOK);
  expect(clean).toMatchObject({ status: "ok", snapshot: "matches" });
  // The pod that wrote the snapshot had a row in a table that the log never carried it into: a snapshot that disagrees with the log it is a copy of, with a digest that is right for its own bytes.
  const manifests = (await w.bulk.list(keysOf().snapPrefix)).objects
    .map((object) => keysOf().seqOfManifest(object.key))
    .filter((seq): seq is number => seq !== null);
  expect(manifests.length).toBeGreaterThan(0);
  const poisoned = bucketWith(w.bulk, async (key) => {
    const stored = await w.bulk.get(key);
    if (stored && key.endsWith(".sqlite.gz")) return poison(stored);
    return stored;
  });
  const verdict = await verifyBook(w.options({ bulk: poisoned }), BOOK);
  // The bytes no longer match the digest the log announced, so a pod would refuse the snapshot and go to the log: a warning, not a stop.
  expect(verdict).toMatchObject({ status: "ok", snapshot: "none" });
  if (verdict.status !== "ok") throw new Error("not ok");
  expect(verdict.warnings.join(" ")).toContain("a snapshot a pod would refuse");
}, 120_000);

test("a snapshot a pod published of a cache that had drifted from its log is found by comparing it with what the log makes, and the book is stopped", async () => {
  const w = world();
  const live = await w.serve();
  expect((await live.call("book.setup", SETUP)).status).toBe(200);
  await live.post("one");
  // The cache is changed behind the capture's back (the gate that turns it off is the capture's own), as a bug in a pod could: the log never hears of it, and the next snapshot is of a book the log does not make.
  const cache = new Database(join(w.root, "cache", `${BOOK}.sqlite`));
  cache.exec("PRAGMA busy_timeout=5000");
  cache.exec("UPDATE _cdc_gate SET on_ = 0");
  cache.exec(
    "UPDATE app_book SET setup = replace(setup, 'Verified Co', 'Drifted Co') WHERE id = 1",
  );
  cache.exec("UPDATE _cdc_gate SET on_ = 1");
  cache.close();
  await live.server.book?.runtime.snapshotNow();
  await live.post("two");
  await live.server.stop();

  const verdict = await verifyBook(w.options(), BOOK);
  expect(verdict).toMatchObject({
    status: "failed",
    finding: { kind: "snapshot_mismatch", check: "app_book" },
    stop: "recorded",
  });
  if (verdict.status !== "failed") throw new Error("not failed");
  // The record names the table and two digests, and not what the table holds.
  const [record] = await readReviews(w.bulk, keysOf());
  expect(record).toMatchObject({ kind: "snapshot_mismatch", check: "app_book" });
  expect(record?.expected).toMatch(/^[0-9a-f]{64}$/);
  expect(record?.found).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(record)).not.toContain("Drifted");
  // Without the comparison of snapshots the book is sound as far as the log and the ledger go: that is what the comparison is for.
  expect(await verifyBook(w.options({ snapshots: false, record: false }), BOOK)).toMatchObject({
    status: "ok",
    snapshot: "off",
  });
}, 120_000);

/** The same object with one byte changed. */
function poison<T extends { body: Uint8Array }>(stored: T): T {
  const body = new Uint8Array(stored.body);
  body[Math.floor(body.length / 2)] = (body[Math.floor(body.length / 2)] as number) ^ 0xff;
  return { ...stored, body };
}

// ---- trouble that is not the book's ---------------------------------------------------------------------------------------------------

test("trouble reaching the storage is never a finding: a tail that does not answer, a book that was deleted, entries written by a newer build, and a finding that does not come out the same twice stop nothing", async () => {
  const w = world();
  const live = await w.serve();
  expect((await live.call("book.setup", SETUP)).status).toBe(200);
  await live.post("one");
  await live.server.stop();

  const silent = tierWith(w.tail, {
    head: async () => {
      throw new ObjectStoreUncertain("the tail did not answer");
    },
  });
  expect(await verifyBook(w.options({ tier: silent }), BOOK)).toMatchObject({
    status: "skipped",
    reason: "unavailable",
  });

  // A build that knows an older schema than the book's entries were written at cannot say anything about them.
  expect(await verifyBook(w.options({ schema: 1 }), BOOK)).toMatchObject({
    status: "skipped",
    reason: "verifier_too_old",
  });

  // The first reading of the segment is damaged on the way, the second is not: the finding is not believed.
  let reads = 0;
  const flaky = bucketWith(w.bulk, async (key) => {
    const stored = await w.bulk.get(key);
    if (stored && key.includes("/sealed/")) {
      reads += 1;
      if (reads === 1) return poison(stored);
    }
    return stored;
  });
  expect(await verifyBook(w.options({ bulk: flaky }), BOOK)).toMatchObject({
    status: "skipped",
    reason: "unconfirmed",
  });

  // A book the tail says was deleted.
  w.tail.destroy(BOOK);
  expect(await verifyBook(w.options(), BOOK)).toMatchObject({
    status: "skipped",
    reason: "deleted",
  });

  // None of it stopped the book.
  expect(await readReviews(w.bulk, keysOf())).toEqual([]);
}, 120_000);

test("a book deleted while it was being read is not stopped: its erasing would leave the stop behind", async () => {
  const w = world();
  await w.imported("book-1", breakOutcome(5));
  // How many times the tail is asked about the book while it is read once.
  let heads = 0;
  const counting = tierWith(w.tail, {
    head: (book) => {
      heads += 1;
      return w.tail.head(book);
    },
  });
  expect(
    await verifyBook(w.options({ tier: counting, record: false, confirmations: 0 }), BOOK),
  ).toMatchObject({ status: "failed" });
  const forOneReading = heads;
  // The book is read, found wrong, and then the tail says it is gone: the question that comes before the stop is written.
  heads = 0;
  const vanishing = tierWith(w.tail, {
    head: (book) => {
      heads += 1;
      if (heads > forOneReading) w.tail.destroy(book);
      return w.tail.head(book);
    },
  });
  expect(await verifyBook(w.options({ tier: vanishing, confirmations: 0 }), BOOK)).toMatchObject({
    status: "skipped",
    reason: "deleted",
  });
  expect(await readReviews(w.bulk, keysOf())).toEqual([]);
}, 120_000);

// ---- the pieces -----------------------------------------------------------------------------------------------------------------------

test("two databases are the same book if every table holds the same rows, in any order and under any rowids, and the capture's tables and the derived ones are not the book", () => {
  const make = (rows: [number, string][], extra = "") => {
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE a (id INTEGER, label TEXT, raw BLOB); CREATE TABLE b (n INTEGER); CREATE TABLE _cdc_state (k TEXT, v TEXT); CREATE TABLE app_read_snapshots (x TEXT);",
    );
    for (const [id, label] of rows)
      db.run("INSERT INTO a VALUES (?, ?, ?)", [id, label, new Uint8Array([id])]);
    db.run("INSERT INTO _cdc_state VALUES (?, ?)", ["head", extra]);
    db.run("INSERT INTO app_read_snapshots VALUES (?)", [extra]);
    return db;
  };
  expect(
    compareDatabases(
      make([
        [1, "x"],
        [2, "y"],
      ]),
      make(
        [
          [2, "y"],
          [1, "x"],
        ],
        "other",
      ),
    ),
  ).toBeNull();
  const differs = compareDatabases(
    make([
      [1, "x"],
      [2, "y"],
    ]),
    make([
      [1, "x"],
      [2, "z"],
    ]),
  );
  expect(differs?.table).toBe("a");
  expect(differs?.expected).not.toBe(differs?.found);
  // A row more or less is a difference too.
  expect(compareDatabases(make([[1, "x"]]), make([]))?.table).toBe("a");

  // A table only one of them has is a difference only if it holds rows.
  const left = make([[1, "x"]]);
  const right = make([[1, "x"]]);
  left.exec("CREATE TABLE only_here (v TEXT)");
  expect(compareDatabases(left, right)).toBeNull();
  left.run("INSERT INTO only_here VALUES ('v')");
  expect(compareDatabases(left, right)?.table).toBe("only_here");
});

test("the books in a bucket are listed once each, whatever the names of their neighbours, with one question a book and not one a key", async () => {
  const bulk = new MemoryObjectStore();
  // Names that sort against the slash that follows them in a key: `a-b` and `a.b` before `a/`, `a0` after it.
  const names = ["a", "a-b", "a.b", "a0", "b", "z"];
  for (const name of names)
    for (const key of [
      "log/000000000001",
      "log/000000000002",
      "snap/000000000002.json",
      "sealed/000000000001-000000000002",
    ])
      await bulk.putIfAbsent(`runs/x/books/${name}/${key}`, new Uint8Array([1]));
  await bulk.putIfAbsent("runs/x/books/b/review/000000000001.json", new Uint8Array([1]));
  await bulk.putIfAbsent("runs/y/books/other/log/000000000001", new Uint8Array([1]));
  let asked = 0;
  const counting: ObjectStore = {
    putIfAbsent: (key, body, options) => bulk.putIfAbsent(key, body, options),
    get: (key) => bulk.get(key),
    head: (key) => bulk.head(key),
    list: (prefix, after, limit) => {
      asked += 1;
      return bulk.list(prefix, after, limit);
    },
    delete: (key) => bulk.delete(key),
  };
  expect((await listBooks(counting, "runs/x/")).sort()).toEqual([...names].sort());
  // One question for each book and one that finds there are no more.
  expect(asked).toBe(names.length + 1);
  expect(await listBooks(counting, "")).toEqual([]);
  expect(await listBooks(counting, "runs/y/")).toEqual(["other"]);
});

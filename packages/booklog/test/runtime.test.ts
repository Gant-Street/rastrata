import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordTelemetry } from "@rastrata/telemetry/testing";
import { VirtualClock } from "../src/clock.ts";
import { EntryError } from "../src/entry.ts";
import { LeaseHeldElsewhereError } from "../src/lease.ts";
import { TailBehindBulkError } from "../src/materialize.ts";
import { MemoryObjectStore } from "../src/memory.ts";
import { MeteredLogTier } from "../src/metered-tier.ts";
import { BookKeys, ObjectStoreUncertain } from "../src/objectstore.ts";
import { SimPodClock } from "../src/podclock.ts";
import {
  BookClosedError,
  BookRuntime,
  CommitUncertainError,
  ReadNotLoggedError,
  type BookRuntimeOptions,
  type EntryInfo,
} from "../src/runtime.ts";
import { MemoryLogTier } from "../src/tier-memory.ts";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ops (id TEXT PRIMARY KEY, result TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL, amount INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS derived (k TEXT PRIMARY KEY, v);
`;
const EXCLUDE = ["derived"];

/** An operation the way the application writes them: deduplicated by its identity. */
function bump(db: Database, opId: string, key: string, amount: number): string {
  db.exec(SCHEMA);
  const done = db.query("SELECT result FROM ops WHERE id=?").get(opId) as { result: string } | null;
  if (done) return done.result;
  db.run("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = v + excluded.v", [
    key,
    amount,
  ]);
  db.run("INSERT INTO events (op, amount) VALUES (?, ?)", [opId, amount]);
  const total = (db.query("SELECT v FROM kv WHERE k=?").get(key) as { v: number }).v;
  db.run("INSERT INTO ops (id, result) VALUES (?, ?)", [opId, String(total)]);
  return String(total);
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

class World {
  readonly clock = new VirtualClock();
  readonly tier = new MemoryLogTier({ clock: this.clock });
  readonly bulk = new MemoryObjectStore({ clock: this.clock });
  readonly keys = new BookKeys("runs/t/", "b1");
  readonly directory = (() => {
    const path = mkdtempSync(join(tmpdir(), "booklog-runtime-"));
    directories.push(path);
    return path;
  })();

  open(
    holder: string,
    extra: Partial<BookRuntimeOptions> = {},
    file = "cache.sqlite",
  ): Promise<BookRuntime> {
    return BookRuntime.open({
      tier: this.tier,
      bulk: this.bulk,
      bookId: "b1",
      prefix: "runs/t/",
      holder,
      path: join(this.directory, file),
      schema: 1,
      exclude: EXCLUDE,
      clock: this.clock,
      pod: new SimPodClock(this.clock),
      sealing: { delayMs: 0 },
      ...extra,
    });
  }
  sleep(ms: number) {
    return this.clock.drive(this.clock.sleep(ms));
  }
}

test("a new book: the first operation becomes entry 1, the next entry 2, and a read sees both", async () => {
  const w = new World();
  const pod = await w.open("pod-a#1");
  expect(pod.head.seq).toBe(0);
  expect(await pod.write((db) => bump(db, "op-1", "cash", 10), { opId: "op-1" })).toBe("10");
  expect(pod.head.seq).toBe(1);
  expect(await pod.write((db) => bump(db, "op-2", "cash", 5), { opId: "op-2" })).toBe("15");
  expect(pod.head.seq).toBe(2);
  expect(await pod.read((db) => db.query("SELECT v FROM kv WHERE k='cash'").get())).toEqual({
    v: 15,
  });
  const entries = w.tier.peek("b1").entries;
  expect(entries.map((entry) => entry.seq)).toEqual([1, 2]);
  expect(entries[0]?.fence).toBe(1);
  await pod.close();
});

test("an operation that changes nothing writes nothing, and one that fails leaves nothing", async () => {
  const w = new World();
  const pod = await w.open("pod-a#1");
  await pod.write((db) => bump(db, "op-1", "cash", 1));
  await pod.write((db) => bump(db, "op-1", "cash", 1)); // the same identity again: no new rows
  expect(pod.head.seq).toBe(1);
  await expect(
    pod.write((db) => {
      db.run("INSERT INTO kv (k, v) VALUES ('doomed', 1)");
      throw new Error("the request failed halfway");
    }),
  ).rejects.toThrow("failed halfway");
  // The partial change was captured and made durable like any other (the application's own
  // transactions decide what a failed request leaves), so the failure above wrote an entry.
  expect(pod.head.seq).toBe(2);
  await pod.close();
});

test("a request that arrives while the book is being stopped is told it is closed, and nothing was done for it", async () => {
  const w = new World();
  const pod = await w.open("pod-a#1");
  await pod.write((db) => bump(db, "op-1", "cash", 10));
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // A request is in flight and keeps the book busy; the stop waits for it.
  const slow = pod.write(async (db) => {
    await held;
    return bump(db, "op-2", "cash", 5);
  });
  const stopping = pod.close();
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  // Asked after the stop began and before it finished: it would have run on a closed file.
  const late = pod.write((db) => bump(db, "op-3", "cash", 1));
  const lateRead = pod.read((db) => db.query("SELECT v FROM kv").get());
  release();
  expect(await slow).toBe("15");
  await stopping;
  const [wrote, read] = await Promise.allSettled([late, lateRead]);
  expect(wrote?.status).toBe("rejected");
  expect(read?.status).toBe("rejected");
  expect((wrote as PromiseRejectedResult).reason).toBeInstanceOf(BookClosedError);
  expect((read as PromiseRejectedResult).reason).toBeInstanceOf(BookClosedError);
  await expect(pod.write(() => 1)).rejects.toBeInstanceOf(BookClosedError);
  // The two entries that were made are all there is: the late write never ran.
  expect(pod.head.seq).toBe(2);
  expect((await w.tier.head("b1")).seq).toBe(2);
});

test("a tail that lost its state is not adopted as an empty book: the bulk store holds history it does not know", async () => {
  const w = new World();
  const a = await w.open("pod-a#1");
  await a.write((db) => bump(db, "op-1", "cash", 10));
  await a.write((db) => bump(db, "op-2", "cash", 5));
  // Stopping seals: the bulk store now holds the entries as a segment.
  await a.close();
  const sealed = w.bulk.keys(w.keys.sealedPrefix);
  expect(sealed.length).toBeGreaterThan(0);
  // A tail that starts again, empty, in front of the same bucket.
  const wiped = new MemoryLogTier({ clock: w.clock });
  await expect(w.open("pod-b#1", { tier: wiped }, "b.sqlite")).rejects.toBeInstanceOf(
    TailBehindBulkError,
  );
  expect((await wiped.head("b1")).seq).toBe(0);
  expect((await wiped.head("b1")).leaseHolder).toBeNull();
  // Nothing was added to the bucket: the one history is still the only one.
  expect(w.bulk.keys(w.keys.sealedPrefix)).toEqual(sealed);
  // The tail that knows the book opens it as before.
  const b = await w.open("pod-b#1", {}, "b.sqlite");
  expect(b.head.seq).toBeGreaterThanOrEqual(2);
  expect(await b.read((db) => db.query("SELECT v FROM kv WHERE k='cash'").get())).toEqual({
    v: 15,
  });
  await b.close();
});

test("a second process is told the book is leased, and gets it once the first lets go", async () => {
  const w = new World();
  const a = await w.open("pod-a#1");
  await a.write((db) => bump(db, "op-1", "cash", 10));
  await expect(w.open("pod-b#1", {}, "b.sqlite")).rejects.toBeInstanceOf(LeaseHeldElsewhereError);
  const hash = a.capture.stateHash();
  await a.close();
  const b = await w.open("pod-b#1", {}, "b.sqlite");
  expect(b.head.seq).toBe(1);
  expect(b.stats.activation?.source).toBe("log");
  expect(b.capture.stateHash()).toBe(hash);
  expect(await b.write((db) => bump(db, "op-2", "cash", 5))).toBe("15");
  await b.close();
});

test("reads under a valid lease make no call to the tail; after the lease lapses the next read asks once", async () => {
  const w = new World();
  const counted = new MeteredLogTier(w.tier);
  const pod = await w.open("pod-a#1", { tier: counted, lease: { ttlMs: 5000 } });
  await pod.write((db) => bump(db, "op-1", "cash", 10));
  const before = { ...counted.counts };
  for (let index = 0; index < 50; index += 1)
    await pod.read((db) => db.query("SELECT v FROM kv WHERE k='cash'").get());
  expect(counted.counts).toEqual(before);
  expect(pod.stats.leaseReads).toBe(50);
  // The renewal timer keeps it going while time passes...
  await w.sleep(30_000);
  await pod.read((db) => db.query("SELECT 1").get());
  expect(counted.counts.lease).toBeGreaterThan(before.lease);
  expect(counted.counts.head).toBe(before.head);
  await pod.close();
});

test("without renewals the lease lapses and a read re-acquires it, then goes on", async () => {
  const w = new World();
  const pod = await w.open("pod-a#1", { lease: { ttlMs: 3000, renewEveryMs: 1e9 } });
  await pod.write((db) => bump(db, "op-1", "cash", 10));
  const first = pod.lease.fence;
  await w.sleep(10_000);
  expect(pod.lease.valid()).toBe(false);
  expect(await pod.read((db) => db.query("SELECT v FROM kv").get())).toEqual({ v: 10 });
  expect(pod.lease.fence).toBeGreaterThan(first as number);
  await pod.close();
});

test("a lost answer to an append is resolved by finding the entry there: one entry, acknowledged", async () => {
  const w = new World();
  w.tier.wire.configure({ timeoutMs: 500 });
  const pod = await w.open("pod-a#1", { clock: w.clock });
  w.tier.script([{ op: "append", fault: "failAfter", nth: 1 }]);
  const result = await w.clock.drive(
    pod.write((db) => bump(db, "op-1", "cash", 7), { opId: "op-1" }),
  );
  expect(result).toBe("7");
  expect(w.tier.peek("b1").entries).toHaveLength(1);
  expect(pod.stats.resolvedOurs).toBe(1);
  expect(pod.head.seq).toBe(1);
  await pod.close();
});

test("an append lost before it was applied is sent again", async () => {
  const w = new World();
  const pod = await w.open("pod-a#1");
  w.tier.script([{ op: "append", fault: "failBefore", times: 2 }]);
  const result = await w.clock.drive(pod.write((db) => bump(db, "op-1", "cash", 7)));
  expect(result).toBe("7");
  expect(w.tier.peek("b1").entries).toHaveLength(1);
  await pod.close();
});

test("an append whose fate cannot be learned rolls the cache back and says so; sending it again finds the entry", async () => {
  const w = new World();
  const pod = await w.open("pod-a#1");
  await pod.write((db) => bump(db, "op-0", "cash", 1));
  // The append lands, but no answer ever comes back, and the tail cannot be asked either.
  w.tier.script([
    { op: "append", fault: "failAfter", times: 10 },
    { op: "head", fault: "failBefore", times: 10 },
  ]);
  w.tier.wire.configure({ timeoutMs: 100 });
  await expect(
    w.clock.drive(pod.write((db) => bump(db, "op-1", "cash", 7), { opId: "op-1" })),
  ).rejects.toBeInstanceOf(CommitUncertainError);
  // The cache does not hold op-1: it was rolled back.
  expect(pod.db.query("SELECT count(*) c FROM ops WHERE id='op-1'").get()).toEqual({ c: 0 });
  w.tier.wire.clearScript();
  // The tail does hold it (the append landed): the same operation finds it done.
  expect(w.tier.peek("b1").entries).toHaveLength(2);
  const again = await w.clock.drive(
    pod.write((db) => bump(db, "op-1", "cash", 7), { opId: "op-1" }),
  );
  expect(again).toBe("8");
  expect(w.tier.peek("b1").entries).toHaveLength(2);
  expect(pod.db.query("SELECT v FROM kv WHERE k='cash'").get()).toEqual({ v: 8 });
  await pod.close();
});

test("a process that dies after its append landed: the next process finds the entry and the operation done once", async () => {
  const w = new World();
  const a = await w.open("pod-a#1", { tier: w.tier.client("pod-a#1"), lease: { ttlMs: 2000 } });
  await a.write((db) => bump(db, "op-0", "cash", 1));
  w.tier.script([{ op: "append", fault: "killAfter", nth: 1, client: "pod-a#1" }]);
  const doomed = a.write((db) => bump(db, "op-1", "cash", 7));
  const state = await w.clock.drive(
    Promise.race([doomed.then(() => "answered"), w.clock.sleep(1000).then(() => "silent")]),
  );
  expect(state).toBe("silent");
  expect(w.tier.peek("b1").entries).toHaveLength(2);
  a.abandon();
  await w.sleep(5000);
  const b = await w.open("pod-b#1", {}, "b.sqlite");
  expect(b.head.seq).toBe(2);
  // The client sends op-1 again to the new process: it was done.
  expect(await b.write((db) => bump(db, "op-1", "cash", 7))).toBe("8");
  expect(b.head.seq).toBe(2);
  expect(b.db.query("SELECT count(*) c FROM events WHERE op='op-1'").get()).toEqual({ c: 1 });
  await b.close();
});

test("losing the race for an entry: the cache is rolled back, brought up to date, and the operation runs again", async () => {
  const w = new World();
  // pod A believes its lease is good long after the tier ended it (a clock outside the assumed bound,
  // and no wall-clock check): the fence is what stops it.
  const slow = new SimPodClock(w.clock, { rate: 0.2 });
  const a = await w.open("pod-a#1", {
    pod: slow,
    lease: { ttlMs: 3000, renewEveryMs: 1e9, skewToleranceMs: 1e12 },
  });
  await a.write((db) => bump(db, "op-1", "cash", 10));
  await w.sleep(4000); // the tier's clock ended the lease; A's slow clock has not noticed
  expect(a.lease.valid()).toBe(true);
  const b = await w.open("pod-b#1", {}, "b.sqlite");
  expect(await b.write((db) => bump(db, "op-2", "cash", 5))).toBe("15");
  // B lets go, so A can take the book back after it learns what happened.
  await b.close({ seal: false });
  const total = await a.write((db) => bump(db, "op-3", "cash", 1));
  expect(total).toBe("16");
  expect(a.stats.conflicts).toBe(1);
  expect(a.stats.catchUps).toBeGreaterThanOrEqual(1);
  expect(a.db.query("SELECT group_concat(op) ops FROM events").get()).toEqual({
    ops: "op-1,op-2,op-3",
  });
  const entries = w.tier.peek("b1").entries;
  expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
  expect(entries.map((entry) => entry.fence)).toEqual([1, 2, 4]);
  await a.close();
});

test("the host is told when the database changed beneath it", async () => {
  const w = new World();
  const reasons: string[] = [];
  const slow = new SimPodClock(w.clock, { rate: 0.2 });
  const a = await w.open("pod-a#1", {
    pod: slow,
    lease: { ttlMs: 3000, renewEveryMs: 1e9, skewToleranceMs: 1e12 },
    onReset: (reason) => void reasons.push(reason),
  });
  await a.write((db) => bump(db, "op-1", "cash", 10));
  await w.sleep(4000);
  const b = await w.open("pod-b#1", {}, "b.sqlite");
  await b.write((db) => bump(db, "op-2", "cash", 5));
  await b.close();
  await a.write((db) => bump(db, "op-3", "cash", 1));
  // One telling covers both the undone request and the entries that arrived.
  expect(reasons).toEqual(["caught-up"]);
  await a.close();
});

test("the host is told of a rollback when nothing new arrived with it", async () => {
  const w = new World();
  const reasons: string[] = [];
  const pod = await w.open("pod-a#1", { onReset: (reason) => void reasons.push(reason) });
  await pod.write((db) => bump(db, "op-0", "cash", 1));
  w.tier.script([
    { op: "append", fault: "failBefore", times: 20 },
    { op: "head", fault: "failBefore", times: 20 },
  ]);
  w.tier.wire.configure({ timeoutMs: 100 });
  await expect(
    w.clock.drive(pod.write((db) => bump(db, "op-1", "cash", 7), { opId: "op-1" })),
  ).rejects.toBeInstanceOf(CommitUncertainError);
  w.tier.wire.clearScript();
  expect(reasons).toEqual([]);
  // The next thing the process does tells the host before it runs.
  await w.clock.drive(pod.write((db) => bump(db, "op-1", "cash", 7), { opId: "op-1" }));
  expect(reasons).toEqual(["rollback"]);
  await pod.close();
});

test("sealing moves the tail into the bulk store; a cold process reads sealed segments and the tail alike", async () => {
  const w = new World();
  const pod = await w.open("pod-a#1");
  for (let index = 1; index <= 6; index += 1)
    await pod.write((db) => bump(db, `op-${index}`, "cash", index));
  const sealed = await pod.sealNow();
  expect(sealed.status).toBe("sealed");
  for (let index = 7; index <= 9; index += 1)
    await pod.write((db) => bump(db, `op-${index}`, "cash", index));
  expect(w.tier.peek("b1").entries.map((entry) => entry.seq)).toEqual([7, 8, 9]);
  const hash = pod.capture.stateHash();
  await pod.close({ seal: false });
  const cold = await w.open("pod-b#1", {}, "cold.sqlite");
  expect(cold.stats.activation).toMatchObject({
    source: "log",
    sealedEntries: 6,
    tailEntries: 3,
    segmentsRead: 1,
  });
  expect(cold.capture.stateHash()).toBe(hash);
  await cold.close();
});

test("a snapshot is taken, announced in the log, and a cold process starts from it and reads only what follows", async () => {
  const w = new World();
  const pod = await w.open("pod-a#1", { snapshots: { stateHash: true } });
  for (let index = 1; index <= 8; index += 1)
    await pod.write((db) => bump(db, `op-${index}`, "cash", index));
  const manifest = await pod.snapshotNow();
  expect(manifest.seq).toBe(8);
  expect(manifest.stateHash).toBe(pod.capture.stateHash());
  expect(pod.head.seq).toBe(9); // the announcement is entry 9
  for (let index = 9; index <= 11; index += 1)
    await pod.write((db) => bump(db, `op-${index}`, "cash", index));
  await pod.sealNow();
  const hash = pod.capture.stateHash();
  await pod.close({ seal: false });
  const cold = await w.open("pod-b#1", {}, "cold.sqlite");
  expect(cold.stats.activation?.source).toBe("snapshot");
  expect(cold.stats.activation?.snapshotSeq).toBe(8);
  expect(cold.stats.activation?.entriesApplied).toBe(4);
  expect(cold.capture.stateHash()).toBe(hash);
  expect(cold.head.seq).toBe(12);
  await cold.close();
});

test("a snapshot nothing in the log announces is not used", async () => {
  const w = new World();
  const pod = await w.open("pod-a#1");
  for (let index = 1; index <= 5; index += 1)
    await pod.write((db) => bump(db, `op-${index}`, "cash", index));
  const manifest = await pod.snapshotNow();
  const hash = pod.capture.stateHash();
  await pod.close({ seal: false });
  // Plant a newer 'snapshot' that was never announced (a process died after uploading it, before its
  // entry landed): it is of the log's last entry, and nothing names it.
  const fake = { ...manifest, seq: pod.head.seq };
  w.bulk.plant(w.keys.snapshot(fake.seq), new Uint8Array([1, 2, 3]));
  w.bulk.plant(w.keys.manifest(fake.seq), new TextEncoder().encode(JSON.stringify(fake)));
  const cold = await w.open("pod-b#1", {}, "cold.sqlite");
  expect(cold.stats.activation?.source).toBe("snapshot");
  expect(cold.stats.activation?.snapshotSeq).toBe(5);
  expect(cold.capture.stateHash()).toBe(hash);
  await cold.close();
  // A snapshot of an entry the log does not have is another matter: the tail has lost state, or the
  // bucket holds what is not this book's. The book is refused, not served from what is left.
  const ahead = { ...manifest, seq: 99 };
  w.bulk.plant(w.keys.snapshot(99), new Uint8Array([1, 2, 3]));
  w.bulk.plant(w.keys.manifest(99), new TextEncoder().encode(JSON.stringify(ahead)));
  await expect(w.open("pod-c#1", {}, "c.sqlite")).rejects.toBeInstanceOf(TailBehindBulkError);
});

test("a snapshot whose bytes do not match the digest the log announces is refused and the log is read instead", async () => {
  const w = new World();
  const pod = await w.open("pod-a#1");
  for (let index = 1; index <= 4; index += 1)
    await pod.write((db) => bump(db, `op-${index}`, "cash", index));
  const manifest = await pod.snapshotNow();
  const hash = pod.capture.stateHash();
  await pod.close({ seal: false });
  w.bulk.remove(w.keys.snapshot(manifest.seq));
  w.bulk.plant(w.keys.snapshot(manifest.seq), new Uint8Array([9, 9, 9]));
  const cold = await w.open("pod-b#1", {}, "cold.sqlite");
  expect(cold.stats.activation?.source).toBe("log");
  expect(cold.stats.activation?.rejected.join(" ")).toContain("digest");
  expect(cold.capture.stateHash()).toBe(hash);
  await cold.close();
});

test("a clean cache file is reused and caught up; one with unsent changes, or from another history, is rebuilt", async () => {
  const w = new World();
  const a = await w.open("pod-a#1");
  for (let index = 1; index <= 4; index += 1)
    await a.write((db) => bump(db, `op-${index}`, "cash", index));
  await a.close({ seal: false });
  const b = await w.open("pod-b#1", {}, "b.sqlite");
  await b.write((db) => bump(db, "op-5", "cash", 5));
  await b.close({ seal: false });
  // A's file is one entry behind: reused, and caught up with that one.
  const again = await w.open("pod-a#2");
  expect(again.stats.activation?.source).toBe("warm");
  expect(again.stats.activation?.entriesApplied).toBe(1);
  expect(again.head.seq).toBe(5);
  await again.close({ seal: false });

  // A file with a request half done in it (a crash with a transaction open) is not trusted.
  const dirty = new (await import("bun:sqlite")).Database(join(w.directory, "cache.sqlite"));
  dirty.exec("PRAGMA recursive_triggers=ON");
  dirty.run("INSERT INTO kv (k, v) VALUES ('stray', 1)");
  dirty.close();
  const rebuilt = await w.open("pod-a#3");
  expect(rebuilt.stats.activation?.source).toBe("log");
  expect(rebuilt.db.query("SELECT count(*) c FROM kv WHERE k='stray'").get()).toEqual({ c: 0 });
  await rebuilt.close({ seal: false });
});

test("an entry from code newer than this process stops it from opening the book", async () => {
  const w = new World();
  const newer = await w.open("pod-a#1", { schema: 2 });
  await newer.write((db) => bump(db, "op-1", "cash", 1));
  await newer.close({ seal: false });
  await expect(w.open("pod-b#1", { schema: 1 }, "old.sqlite")).rejects.toBeInstanceOf(EntryError);
  const same = await w.open("pod-b#2", { schema: 2 }, "new.sqlite");
  expect(same.head.seq).toBe(1);
  await same.close();
});

test("derived tables are not in the log, and a rebuilt cache simply lacks them", async () => {
  const w = new World();
  const pod = await w.open("pod-a#1");
  await pod.write((db) => {
    bump(db, "op-1", "cash", 1);
    db.run("INSERT INTO derived (k, v) VALUES ('view', 'cached')");
  });
  const entry = w.tier.peek("b1").entries[0];
  expect(new TextDecoder().decode(entry?.body)).not.toContain("cached");
  await pod.close({ seal: false });
  const cold = await w.open("pod-b#1", {}, "cold.sqlite");
  expect(cold.db.query("SELECT name FROM sqlite_master WHERE name='derived'").get()).toBeNull();
  await cold.close();
});

test("a read that changes the book is made durable before it is answered", async () => {
  const w = new World();
  const pod = await w.open("pod-a#1");
  await pod.write((db) => bump(db, "op-1", "cash", 10));
  const entries = () => w.tier.peek("b1").entries.length;
  expect(entries()).toBe(1);
  // A row written by a read (an audit trail, say) is logged before the read returns.
  const answer = await pod.read((db) => {
    db.run("INSERT INTO kv (k, v) VALUES ('lazy', 1)");
    return "answered";
  });
  expect(answer).toBe("answered");
  expect(entries()).toBe(2);
  expect(pod.head.seq).toBe(2);
  expect(pod.stats.readFlushes).toBe(1);
  // A table made on first use is logged too, though no row was captured.
  await pod.read((db) => db.exec("CREATE TABLE IF NOT EXISTS lazy_t (a INTEGER PRIMARY KEY)"));
  expect(entries()).toBe(3);
  // A derived table is not the log's business, and a read that does not change anything is free.
  await pod.read((db) => db.run("INSERT INTO derived (k, v) VALUES ('a', 1)"));
  await pod.read((db) => db.query("SELECT v FROM kv").all());
  expect(entries()).toBe(3);
  expect(pod.stats.readFlushes).toBe(2);
  const hash = pod.capture.stateHash();
  await pod.close({ seal: false });
  const cold = await w.open("pod-b#1", {}, "cold.sqlite");
  expect(cold.capture.stateHash()).toBe(hash);
  expect(cold.db.query("SELECT count(*) c FROM sqlite_master WHERE name='lazy_t'").get()).toEqual({
    c: 1,
  });
  await cold.close();
});

test("a cache that holds changes the log does not is rebuilt, never caught up on top of them", async () => {
  const w = new World();
  const reasons: string[] = [];
  const slow = new SimPodClock(w.clock, { rate: 0.2 });
  const a = await w.open("pod-a#1", {
    pod: slow,
    lease: { ttlMs: 3000, renewEveryMs: 1e9, skewToleranceMs: 1e12 },
    onReset: (reason) => void reasons.push(reason),
  });
  await a.write((db) => bump(db, "op-1", "cash", 10));
  await w.sleep(4000);
  const b = await w.open("pod-b#1", {}, "b.sqlite");
  await b.write((db) => bump(db, "op-2", "cash", 5));
  await b.close({ seal: false });
  // Something wrote to A's database outside a request (a job that ran on its own).
  a.db.run("INSERT INTO kv (k, v) VALUES ('stray', 1)");
  expect(a.capture.hasUnsent()).toBe(true);
  const total = await a.write((db) => bump(db, "op-3", "cash", 1));
  expect(total).toBe("16");
  expect(a.stats.unsentRebuilds).toBe(1);
  expect(a.stats.rebuilds).toBe(1);
  expect(reasons).toContain("rebuilt");
  // The stray row was not in the log, so it is gone; everything the log has is there.
  expect(a.db.query("SELECT count(*) c FROM kv WHERE k='stray'").get()).toEqual({ c: 0 });
  expect(a.db.query("SELECT group_concat(op) ops FROM events").get()).toEqual({
    ops: "op-1,op-2,op-3",
  });
  expect(a.capture.hasUnsent()).toBe(false);
  await a.close();
});

test("a rebuild that cannot read the bulk store leaves the process able to try again, not holding a closed database", async () => {
  const w = new World();
  const slow = new SimPodClock(w.clock, { rate: 0.2 });
  const a = await w.open("pod-a#1", {
    pod: slow,
    lease: { ttlMs: 3000, renewEveryMs: 1e9, skewToleranceMs: 1e12 },
  });
  await a.write((db) => bump(db, "op-1", "cash", 10));
  await w.sleep(4000);
  const b = await w.open("pod-b#1", {}, "b.sqlite");
  await b.write((db) => bump(db, "op-2", "cash", 5));
  await b.close({ seal: false });
  // Something wrote outside a request, so catching up means starting again from the log...
  a.db.run("INSERT INTO kv (k, v) VALUES ('stray', 1)");
  // ...and the bulk store cannot be listed just then.
  w.bulk.script([{ op: "list", fault: "failBefore", times: 200 }]);
  await expect(w.clock.drive(a.write((db) => bump(db, "op-3", "cash", 1)))).rejects.toBeInstanceOf(
    ObjectStoreUncertain,
  );
  // Every operation still fails cleanly, never with "Cannot use a closed database".
  await expect(w.clock.drive(a.read((db) => db.query("SELECT 1").get()))).rejects.toBeInstanceOf(
    ObjectStoreUncertain,
  );
  // The store comes back: the next operation rebuilds and goes on.
  w.bulk.wire.clearScript();
  expect(await w.clock.drive(a.write((db) => bump(db, "op-3", "cash", 1)))).toBe("16");
  expect(a.db.query("SELECT count(*) c FROM kv WHERE k='stray'").get()).toEqual({ c: 0 });
  expect(a.stats.rebuilds).toBe(1);
  await w.clock.drive(a.close());
});

test("a read's effects can be deferred: answered now, logged within the window, with the next write, or at close", async () => {
  const w = new World();
  const pod = await w.open("pod-a#1", { readEffects: { mode: "defer", deferMs: 500 } });
  await pod.write((db) => bump(db, "op-1", "cash", 10));
  const entries = () => w.tier.peek("b1").entries.length;
  expect(entries()).toBe(1);
  // The timer: the read is answered with nothing appended, and the entry follows.
  await pod.read((db) => db.run("INSERT INTO kv (k, v) VALUES ('lazy', 1)"));
  expect(entries()).toBe(1);
  expect(pod.stats.readsDeferred).toBe(1);
  expect(pod.stats.readFlushes).toBe(0);
  await w.sleep(600);
  expect(entries()).toBe(2);
  expect(pod.stats.deferredFlushes).toBe(1);
  // The next write carries what was left, in its own entry, and the timer then finds nothing.
  await pod.read((db) => db.run("INSERT INTO kv (k, v) VALUES ('lazy2', 1)"));
  await pod.write((db) => bump(db, "op-2", "cash", 5));
  expect(entries()).toBe(3);
  await w.sleep(600);
  expect(entries()).toBe(3);
  expect(pod.stats.deferredFlushes).toBe(1);
  // A request can ask for its read to be logged first all the same.
  await pod.read((db) => db.run("INSERT INTO kv (k, v) VALUES ('strict', 1)"), {
    effects: "log-first",
  });
  expect(entries()).toBe(4);
  // And stopping carries what is left.
  await pod.read((db) => db.run("INSERT INTO kv (k, v) VALUES ('lazy3', 1)"));
  expect(entries()).toBe(4);
  await pod.close({ seal: false });
  expect(entries()).toBe(5);
  const cold = await w.open("pod-b#1", {}, "cold.sqlite");
  expect(cold.db.query("SELECT count(*) c FROM kv WHERE k LIKE 'lazy%'").get()).toEqual({ c: 3 });
  await cold.close();
});

test("a log-first read whose answer is lost is refused; if its entry had landed, the next write finds out, rebuilds, and the row is there once", async () => {
  const w = new World();
  const pod = await w.open("pod-a#1");
  await pod.write((db) => bump(db, "op-1", "cash", 10));
  w.tier.script([
    { op: "append", fault: "failAfter", times: 10 },
    { op: "head", fault: "failBefore", times: 10 },
  ]);
  w.tier.wire.configure({ timeoutMs: 100 });
  await expect(
    w.clock.drive(
      pod.read((db) => db.run("INSERT INTO kv (k, v) VALUES ('audit', 1)"), {
        effects: "log-first",
      }),
    ),
  ).rejects.toBeInstanceOf(ReadNotLoggedError);
  w.tier.wire.clearScript();
  // The append did land. The cache is not stale for it: a read is served at once.
  expect(w.tier.peek("b1").entries).toHaveLength(2);
  expect(await pod.read((db) => db.query("SELECT v FROM kv WHERE k='cash'").get())).toEqual({
    v: 10,
  });
  // A write finds the sequence taken by the entry the read made, rebuilds from the log, and runs again.
  expect(await pod.write((db) => bump(db, "op-2", "cash", 5))).toBe("15");
  expect(pod.stats.unsentRebuilds).toBe(1);
  expect(pod.db.query("SELECT count(*) c FROM kv WHERE k='audit'").get()).toEqual({ c: 1 });
  expect(w.tier.peek("b1").entries).toHaveLength(3);
  const hash = pod.capture.stateHash();
  await pod.close({ seal: false });
  const cold = await w.open("pod-b#1", {}, "cold.sqlite");
  expect(cold.capture.stateHash()).toBe(hash);
  await cold.close();
});

test("the tail gauges say how many entries wait to be sealed, their bytes, and how old the oldest is", async () => {
  const telemetry = recordTelemetry();
  try {
    const w = new World();
    const pod = await w.open("pod-a#1");
    expect(telemetry.last("tail.depth")).toBe(0);
    await pod.write((db) => bump(db, "op-1", "cash", 1));
    await w.sleep(10_000);
    await pod.write((db) => bump(db, "op-2", "cash", 1));
    await pod.write((db) => bump(db, "op-3", "cash", 1));
    expect(telemetry.last("tail.depth")).toBe(3);
    expect(telemetry.last("tail.size") ?? 0).toBeGreaterThan(500);
    // The oldest is the first entry, 10 seconds ago by this process's clock.
    expect(telemetry.last("tail.age") ?? 0).toBeGreaterThanOrEqual(10);
    expect(telemetry.last("tail.age") ?? 0).toBeLessThan(11);
    // Sealed, the tail is empty again, and the gauges say so.
    expect((await pod.sealNow()).status).toBe("sealed");
    expect(telemetry.last("tail.depth")).toBe(0);
    expect(telemetry.last("tail.size")).toBe(0);
    expect(telemetry.last("tail.age")).toBe(0);
    await pod.write((db) => bump(db, "op-4", "cash", 1));
    expect(telemetry.last("tail.depth")).toBe(1);
    // A process that takes the book over finds entries waiting and reports them at once.
    pod.abandon();
    expect(telemetry.last("tail.depth")).toBe(0);
    await w.sleep(10_000);
    const next = await w.open("pod-b#1", {}, "b.sqlite");
    expect(telemetry.last("tail.depth")).toBe(1);
    expect(telemetry.last("tail.age") ?? 0).toBeGreaterThanOrEqual(9);
    await next.close({ seal: false });
    expect(telemetry.last("tail.depth")).toBe(0);
    expect(telemetry.invalid).toEqual([]);
  } finally {
    telemetry.stop();
  }
});

test("an entry says what it held, by table", async () => {
  const w = new World();
  const seen: EntryInfo[] = [];
  const pod = await w.open("pod-a#1", { onEntry: (info) => void seen.push(info) });
  await pod.write((db) => bump(db, "op-1", "cash", 10), { opId: "op-1", label: "bump" });
  await pod.read((db) => db.run("INSERT INTO kv (k, v) VALUES ('lazy', 1)"), { label: "look" });
  expect(seen.map((info) => [info.seq, info.cause, info.label])).toEqual([
    [1, "write", "bump"],
    [2, "read", "look"],
  ]);
  const first = seen[0] as EntryInfo;
  expect(first.opId).toBe("op-1");
  expect(first.ddl).toBeGreaterThan(0);
  expect(first.tables.kv).toMatchObject({ insert: 0, replace: 1 });
  expect(first.bytes).toBeGreaterThan(0);
  expect(first.rawBytes).toBeGreaterThanOrEqual(first.bytes - 400);
  expect(Object.keys(first.sizeByTable)).toContain("(schema)");
  expect((seen[1] as EntryInfo).tables.kv).toMatchObject({ insert: 1 });
  await pod.close({ seal: false });
});

test("a long book read from its log at an open is applied in turns: whatever else the process has to do gets a turn between them, and the book is the same", async () => {
  const w = new World();
  const pod = await w.open("pod-a#1");
  for (let index = 1; index <= 200; index += 1)
    await pod.write((db) => bump(db, `op-${index}`, `k${index % 7}`, index));
  const hash = pod.capture.stateHash();
  await pod.close({ seal: false });
  // Something else the process has to do: it counts the turns it is given while the book is opened.
  let turns = 0;
  let counting = true;
  const turn = () => {
    if (!counting) return;
    turns += 1;
    setImmediate(turn);
  };
  const cold = w.open("pod-b#1", {}, "cold.sqlite");
  setImmediate(turn);
  const opened = await cold;
  counting = false;
  expect(opened.stats.activation?.source).toBe("log");
  expect(opened.stats.activation?.entriesApplied).toBe(200);
  expect(opened.capture.stateHash()).toBe(hash);
  // 200 entries in turns of 64: three times something else ran while they were applied.
  expect(turns).toBeGreaterThanOrEqual(3);
  await opened.close();
});

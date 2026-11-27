// A pod gives a book's lease up after a while without a request, and takes it again with the next one.
// A lease is renewed every third of its length for as long as it is held, and on a metered tail that is
// nearly all of what a book costs when nobody is using it.
import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { readLog } from "../src/logreader.ts";
import { MeteredLogTier } from "../src/metered-tier.ts";
import { BookKeys } from "../src/objectstore.ts";
import { BookRuntime, type BookRuntimeOptions } from "../src/runtime.ts";
import { GENESIS_HASH, type LogTier } from "../src/tier.ts";
import { Worlds, type World } from "./support/world.ts";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ops (id TEXT PRIMARY KEY, result TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL, amount INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS derived (k TEXT PRIMARY KEY, v);
`;

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
const total = (db: Database) =>
  (db.query("SELECT v FROM kv WHERE k='cash'").get() as { v: number } | null)?.v ?? 0;

const worlds = new Worlds();
afterEach(() => worlds.disposeAll());

const MINUTE = 60_000;

function open(
  world: World,
  holder: string,
  extra: Partial<BookRuntimeOptions> = {},
  file = "cache.sqlite",
): Promise<BookRuntime> {
  return BookRuntime.open({
    ...world.runtimeOptions(holder, file),
    exclude: ["derived"],
    lease: { ttlMs: 5000 },
    idleReleaseMs: MINUTE,
    ...extra,
  });
}

/** Every entry of the log, read the way a fresh process reads it. */
async function log(world: World) {
  const entries: { seq: number; opId: string | null; fence: number }[] = [];
  const reader = readLog({
    tier: world.tier,
    bulk: world.bulk,
    keys: new BookKeys("runs/t/", world.bookId),
    schema: 1,
    after: { seq: 0, hash: GENESIS_HASH },
  });
  for (let step = await reader.next(); !step.done; step = await reader.next())
    entries.push({
      seq: step.value.header.seq,
      opId: step.value.header.opId,
      fence: step.value.header.fence,
    });
  return entries;
}

test("while the book is used its lease is renewed; a minute after the last request it is given up, and nothing is renewed after that", async () => {
  const w = worlds.make();
  const tail = new MeteredLogTier(w.tier);
  const pod = await open(w, "pod-a#1", { tier: tail });
  await pod.write((db) => bump(db, "op-1", "cash", 10), { opId: "op-1" });
  const held = pod.lease.fence;
  // Thirty seconds on, the lease is held and renewed (every 1.7 s).
  await w.sleep(30_000);
  expect(pod.lease.renewing).toBe(true);
  expect(tail.counts.lease).toBeGreaterThan(15);
  expect((await w.tier.head("b1")).leaseHolder).toBe("pod-a#1");
  expect(pod.stats.idleReleases).toBe(0);
  // A minute after the last request it is let go.
  await w.sleep(31_000);
  expect(pod.stats.idleReleases).toBe(1);
  expect(pod.lease.renewing).toBe(false);
  expect(pod.lease.valid()).toBe(false);
  const head = await w.tier.head("b1");
  expect(head.leaseHolder).toBeNull();
  expect(head.fence).toBe((held as number) + 1);
  // For ten minutes, then an hour, the tail is not called at all.
  const calls = { ...tail.counts };
  const renewals = w.tier.records.filter((record) => record.op === "renew").length;
  expect(renewals).toBeGreaterThan(30);
  await w.sleep(10 * MINUTE);
  await w.sleep(60 * MINUTE);
  expect(tail.counts).toEqual(calls);
  expect(w.tier.records.filter((record) => record.op === "renew").length).toBe(renewals);
  // Stopping seals what the tail holds, and has no lease to give back: it makes no call about the lease.
  await pod.close();
  expect(tail.counts.lease).toBe(calls.lease);
});

test("the next request takes the lease back, serves, and the renewals start again; no write is lost", async () => {
  const w = worlds.make();
  const tail = new MeteredLogTier(w.tier);
  const pod = await open(w, "pod-a#1", { tier: tail });
  await pod.write((db) => bump(db, "op-1", "cash", 10), { opId: "op-1" });
  const before = pod.lease.fence as number;
  await w.sleep(10 * MINUTE);
  expect(pod.stats.idleReleases).toBe(1);
  expect(pod.lease.fence).toBeNull();
  // A read first: it asks the tail, takes the lease, and answers.
  expect(await pod.read((db) => total(db))).toBe(10);
  expect(pod.lease.valid()).toBe(true);
  expect(pod.lease.fence).toBeGreaterThan(before);
  expect(pod.lease.renewing).toBe(true);
  const renewals = tail.counts.lease;
  await w.sleep(20_000);
  expect(tail.counts.lease).toBeGreaterThan(renewals + 8);
  // A write after another long silence.
  await w.sleep(10 * MINUTE);
  expect(pod.stats.idleReleases).toBe(2);
  expect(await pod.write((db) => bump(db, "op-2", "cash", 5), { opId: "op-2" })).toBe("15");
  expect(await pod.write((db) => bump(db, "op-3", "cash", 1), { opId: "op-3" })).toBe("16");
  // The log holds the three, once each, in a chain, under three tenures of the lease.
  const entries = await log(w);
  expect(entries.map((entry) => entry.opId)).toEqual(["op-1", "op-2", "op-3"]);
  expect(new Set(entries.map((entry) => entry.fence)).size).toBe(2);
  await pod.close();
  const fresh = await open(w, "pod-b#1", {}, "b.sqlite");
  expect(await fresh.read((db) => total(db))).toBe(16);
  await fresh.close();
});

test("a book in use keeps its lease: requests inside the minute postpone the release by their own minute", async () => {
  const w = worlds.make();
  const pod = await open(w, "pod-a#1");
  await pod.write((db) => bump(db, "op-1", "cash", 3), { opId: "op-1" });
  for (let index = 0; index < 12; index += 1) {
    await w.sleep(30_000);
    expect(await pod.read((db) => total(db))).toBe(3);
  }
  expect(pod.stats.idleReleases).toBe(0);
  const fence = pod.lease.fence;
  await w.sleep(50_000);
  expect(pod.stats.idleReleases).toBe(0);
  expect(pod.lease.fence).toBe(fence);
  await w.sleep(11_000);
  expect(pod.stats.idleReleases).toBe(1);
  await pod.close();
});

test("a request that arrives while the lease is being given up waits for it, takes it back and is answered", async () => {
  const w = worlds.make();
  // A tail whose release takes a third of a second to be answered.
  const slow: LogTier = {
    capabilities: w.tier.capabilities,
    head: (book) => w.tier.head(book),
    readFrom: (book, seq, limit) => w.tier.readFrom(book, seq, limit),
    append: (book, input) => w.tier.append(book, input),
    acquire: (book, holder, ttl) => w.tier.acquire(book, holder, ttl),
    renew: (book, lease, ttl) => w.tier.renew(book, lease, ttl),
    release: async (book, lease) => {
      await w.clock.sleep(300);
      return w.tier.release(book, lease);
    },
    seal: (book, input) => w.tier.seal(book, input),
  };
  const pod = await open(w, "pod-a#1", { tier: slow });
  await pod.write((db) => bump(db, "op-1", "cash", 10), { opId: "op-1" });
  const answered = await w.clock.drive(
    (async () => {
      // The release starts a minute after the write; the read comes in the middle of it.
      await w.clock.sleep(MINUTE + 100);
      const read = pod.read((db) => total(db));
      const write = pod.write((db) => bump(db, "op-2", "cash", 1), { opId: "op-2" });
      return Promise.all([read, write]);
    })(),
  );
  // The read and the write were asked together: the read saw the book before or after the write.
  expect([10, 11]).toContain(answered[0]);
  expect(answered[1]).toBe("11");
  expect(pod.stats.idleReleases).toBe(1);
  expect(pod.lease.valid()).toBe(true);
  expect((await log(w)).map((entry) => entry.opId)).toEqual(["op-1", "op-2"]);
  // It was a lease taken back like any other: it is given up again after another quiet minute.
  await w.sleep(MINUTE + 5000);
  expect(pod.stats.idleReleases).toBe(2);
  // Letting go takes a third of a second on this tail, on the virtual clock.
  await w.clock.drive(pod.close());
});

test("while the lease is given up another process may take the book; on return this one catches up and no write is lost", async () => {
  const w = worlds.make();
  const a = await open(w, "pod-a#1");
  await a.write((db) => bump(db, "op-a1", "cash", 10), { opId: "op-a1" });
  await w.sleep(2 * MINUTE);
  expect(a.stats.idleReleases).toBe(1);
  // B finds the book free, writes, and lets go.
  const b = await open(w, "pod-b#1", { idleReleaseMs: 0 }, "b.sqlite");
  expect(b.head.seq).toBe(1);
  await b.write((db) => bump(db, "op-b1", "cash", 5), { opId: "op-b1" });
  await b.close();
  // A is asked: it takes the lease, learns of B's entry, and answers with both.
  expect(await a.read((db) => total(db))).toBe(15);
  expect(a.stats.catchUps).toBeGreaterThanOrEqual(1);
  expect(await a.write((db) => bump(db, "op-a2", "cash", 1), { opId: "op-a2" })).toBe("16");
  expect((await log(w)).map((entry) => entry.opId)).toEqual(["op-a1", "op-b1", "op-a2"]);
  await a.close();
});

test("what a read left unsent goes out before the lease does", async () => {
  const w = worlds.make();
  const pod = await open(w, "pod-a#1", { readEffects: { mode: "defer", deferMs: 3 * MINUTE } });
  await pod.write((db) => bump(db, "op-1", "cash", 10), { opId: "op-1" });
  // A read that writes something replicated (a table made on first use), to be logged "soon".
  await pod.read((db) => {
    db.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT)");
    db.run("INSERT INTO notes (text) VALUES ('seen')");
  });
  expect(pod.capture.hasUnsent()).toBe(true);
  const before = (await w.tier.head("b1")).seq;
  await w.sleep(MINUTE + 5000);
  expect(pod.stats.idleReleases).toBe(1);
  expect(pod.capture.hasUnsent()).toBe(false);
  expect((await w.tier.head("b1")).seq).toBe(before + 1);
  expect((await w.tier.head("b1")).leaseHolder).toBeNull();
  await pod.close();
});

test("it is off unless asked for: a lease is held, and renewed, for as long as the process is", async () => {
  const w = worlds.make();
  const tail = new MeteredLogTier(w.tier);
  const pod = await open(w, "pod-a#1", { tier: tail, idleReleaseMs: 0 });
  await w.sleep(60 * MINUTE);
  expect(pod.stats.idleReleases).toBe(0);
  expect((await w.tier.head("b1")).leaseHolder).toBe("pod-a#1");
  expect(tail.counts.lease).toBeGreaterThan(2000);
  await pod.close();
});

test("a process that follows the book without holding it has nothing to give up", async () => {
  const w = worlds.make();
  const a = await open(w, "pod-a#1", { idleReleaseMs: 0 });
  await a.write((db) => bump(db, "op-1", "cash", 10), { opId: "op-1" });
  const standby = await BookRuntime.openStandby({
    ...w.runtimeOptions("pod-b#1", join("standby.sqlite")),
    exclude: ["derived"],
    idleReleaseMs: MINUTE,
  });
  await w.sleep(5 * MINUTE);
  expect(standby.stats.idleReleases).toBe(0);
  expect((await w.tier.head("b1")).leaseHolder).toBe("pod-a#1");
  await standby.close({ release: false, seal: false });
  await a.close();
});

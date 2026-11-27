import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { AdoptError, adoptFromBulk } from "../src/adopt.ts";
import { TailBehindBulkError } from "../src/materialize.ts";
import { BookKeys } from "../src/objectstore.ts";
import { BookRuntime } from "../src/runtime.ts";
import { MemoryLogTier } from "../src/tier-memory.ts";
import { Worlds, type World } from "./support/world.ts";

const worlds = new Worlds();
afterEach(() => worlds.disposeAll());

const SCHEMA = "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v INTEGER NOT NULL);";
const bump = (key: string) => (db: Database) => {
  db.exec(SCHEMA);
  db.run("INSERT INTO kv (k, v) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET v = v + 1", [key]);
};
const value = (db: Database, key: string) =>
  (db.query("SELECT v FROM kv WHERE k = ?").get(key) as { v: number } | null)?.v ?? 0;

/** A book that was written, stopped (so it is sealed) and then written to a little more. */
async function aBookAndALostTail(w: World) {
  const a = await BookRuntime.open({ ...w.runtimeOptions("pod-a#1"), sealing: { delayMs: 0 } });
  await a.write(bump("cash"));
  await a.write(bump("cash"));
  await a.close();
  const keys = new BookKeys("runs/t/", w.bookId);
  return { keys, wiped: new MemoryLogTier({ clock: w.clock }) };
}

test("a tail that lost the book is restored from the bulk store, and the log goes on from the newest sealed entry under a higher fence", async () => {
  const w = worlds.make();
  const { keys, wiped } = await aBookAndALostTail(w);
  const options = { ...w.runtimeOptions("pod-b#1", "b.sqlite"), tier: wiped };
  await expect(BookRuntime.open(options)).rejects.toBeInstanceOf(TailBehindBulkError);

  const outcome = await adoptFromBulk({ tier: wiped, bulk: w.bulk, keys });
  expect(outcome.seq).toBe(2);
  expect(outcome.fence).toBeGreaterThan(1000);
  const head = await wiped.head(w.bookId);
  expect([head.seq, head.sealedThrough, head.fence]).toEqual([2, 2, outcome.fence]);

  // The book opens, has what was sealed, and goes on: the next entry chains to the sealed one.
  const b = await BookRuntime.open(options);
  expect(b.head.seq).toBe(2);
  expect(value(b.db, "cash")).toBe(2);
  await b.write(bump("cash"));
  expect(value(b.db, "cash")).toBe(3);
  expect(b.head.seq).toBe(3);
  const entry = wiped.peek(w.bookId).entries[0];
  expect(entry?.fence).toBeGreaterThan(outcome.fence);
  await b.close();

  // A process that reads the whole log from nothing finds one chain.
  const c = await BookRuntime.open({
    ...w.runtimeOptions("pod-c#1", "c.sqlite"),
    tier: wiped,
    materialize: { snapshotsToTry: 0, reuse: false },
  });
  expect(c.head.seq).toBe(3);
  expect(value(c.db, "cash")).toBe(3);
  await c.close();
});

test("it refuses, and changes nothing, when the tail still has the book, when there is nothing to restore from, and when a snapshot stands ahead", async () => {
  const w = worlds.make();
  const { keys, wiped } = await aBookAndALostTail(w);
  // The real tail still has the book, and an entry that is not sealed yet.
  const live = await BookRuntime.open(w.runtimeOptions("pod-x#1", "x.sqlite"));
  await live.write(bump("cash"));
  await live.close({ seal: false });
  await expect(adoptFromBulk({ tier: w.tier, bulk: w.bulk, keys })).rejects.toThrow(AdoptError);
  expect((await w.tier.head(w.bookId)).seq).toBe(3);
  // A bucket with nothing sealed in it.
  const empty = worlds.make("other");
  await expect(
    adoptFromBulk({
      tier: new MemoryLogTier({ clock: empty.clock }),
      bulk: empty.bulk,
      keys: new BookKeys("runs/t/", "other"),
    }),
  ).rejects.toThrow("no sealed segment");
  // A snapshot of an entry the log does not reach: it describes history that is lost.
  const manifest = JSON.stringify({ v: 1, bookId: w.bookId, seq: 9 });
  await w.bulk.putIfAbsent(keys.manifest(9), new TextEncoder().encode(manifest));
  await w.bulk.putIfAbsent(keys.snapshot(9), new Uint8Array([1, 2, 3]));
  await expect(adoptFromBulk({ tier: wiped, bulk: w.bulk, keys })).rejects.toThrow("snapshots");
  expect((await wiped.head(w.bookId)).seq).toBe(0);
  // With the flag it restores, and removes what stood ahead.
  const outcome = await adoptFromBulk({
    tier: wiped,
    bulk: w.bulk,
    keys,
    deleteOrphanSnapshots: true,
  });
  expect(outcome.deletedSnapshots).toEqual([9]);
  expect(await w.bulk.head(keys.manifest(9))).toBeNull();
  expect(await w.bulk.head(keys.snapshot(9))).toBeNull();
  // And a second run changes nothing and says it is restored (the head is where it was put).
  const again = await adoptFromBulk({
    tier: wiped,
    bulk: w.bulk,
    keys,
    deleteOrphanSnapshots: true,
  });
  expect(again.seq).toBe(outcome.seq);
});

test("a tail with a live lease is not overwritten", async () => {
  const w = worlds.make();
  const { keys, wiped } = await aBookAndALostTail(w);
  const lease = await wiped.acquire(w.bookId, "someone", 60_000);
  expect(lease.ok).toBe(true);
  await expect(adoptFromBulk({ tier: wiped, bulk: w.bulk, keys })).rejects.toThrow("not restored");
});

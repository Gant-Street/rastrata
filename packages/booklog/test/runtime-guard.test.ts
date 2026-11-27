// What the runtime does when the tail is guarded or has a limit on an entry: the answers people get,
// and that nothing is left half done.
import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { hostedFailure } from "../src/hosted.ts";
import { MeteredLogTier } from "../src/metered-tier.ts";
import { Rng } from "../src/rng.ts";
import { BookRuntime, EntryTooLargeError, ReadNotLoggedError } from "../src/runtime.ts";
import { GuardedLogTier, TailUnavailableError } from "../src/tier-guard.ts";
import { Outage } from "./support/outage.ts";
import { Worlds } from "./support/world.ts";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL, text TEXT NOT NULL);
`;
function note(db: Database, opId: string, text: string): void {
  db.exec(SCHEMA);
  if (db.query("SELECT 1 FROM notes WHERE op=?").get(opId)) return;
  db.run("INSERT INTO notes (op, text) VALUES (?, ?)", [opId, text]);
}
const count = (db: Database) =>
  (db.query("SELECT count(*) c FROM notes").get() as { c: number } | null)?.c ?? 0;

const worlds = new Worlds();
afterEach(() => worlds.disposeAll());

test("a request that would make an entry larger than the tail holds is refused before anything is sent, and leaves nothing behind", async () => {
  const w = worlds.make();
  const tail = new MeteredLogTier(w.tier);
  const pod = await BookRuntime.open({
    ...w.runtimeOptions("pod-a#1"),
    tier: tail,
    commit: { maxStoredEntryBytes: 4096 },
  });
  await pod.write((db) => note(db, "small", "a short note"), { opId: "small" });
  const appends = tail.counts.append;
  // Random text does not compress: the entry is as large as the text.
  const error = await pod
    .write((db) => note(db, "big", randomBytes(6000).toString("hex")), { opId: "big" })
    .then(
      () => null,
      (reason: unknown) => reason,
    );
  expect(error).toBeInstanceOf(EntryTooLargeError);
  expect((error as Error).message).toMatch(/once packed; one entry may hold at most 4096/);
  expect(hostedFailure(error)).toMatchObject({
    code: "entry_too_large",
    status: 413,
    retryable: false,
  });
  expect(tail.counts.append).toBe(appends);
  expect(count(pod.db)).toBe(1);
  // The book is as it was and goes on.
  await pod.write((db) => note(db, "next", "another note"), { opId: "next" });
  expect(count(pod.db)).toBe(2);
  expect(w.tier.peek("b1").entries).toHaveLength(2);
  await pod.close();
});

test("a lease that lapsed because the tail is not being called says so, whether the read began before or after it lapsed", async () => {
  const w = worlds.make();
  const outage = new Outage(w.tier, w.clock, 1);
  const rng = new Rng(1);
  const guard = new GuardedLogTier(outage, { clock: w.clock, random: () => rng.next() });
  const pod = await BookRuntime.open({
    ...w.runtimeOptions("pod-a#1"),
    tier: guard,
    // A long lease renewed every second: the renewals fail and the breaker opens while the lease is good.
    lease: { ttlMs: 30_000, renewEveryMs: 1000 },
    idleReleaseMs: 0,
  });
  await pod.write((db) => note(db, "one", "x"), { opId: "one" });
  const start = w.clock.now();
  outage.down(start, start + 3600_000);
  await w.sleep(6000);
  expect(guard.status().state).not.toBe("closed");
  expect(pod.lease.valid()).toBe(true);
  // A read that began under the lease and ends after it lapsed: the answer is withheld, and the reason is the tail's.
  const late = await w.clock.drive(
    pod
      .read(async (db) => {
        await w.clock.sleep(40_000);
        return count(db);
      })
      .then(
        () => null,
        (reason: unknown) => reason,
      ),
  );
  expect(late).toBeInstanceOf(TailUnavailableError);
  // A read that begins after it lapsed: the same.
  const after = await pod
    .read((db) => count(db))
    .then(
      () => null,
      (reason: unknown) => reason,
    );
  expect(after).toBeInstanceOf(TailUnavailableError);
  expect(hostedFailure(after)).toMatchObject({ code: "service_limit", retryable: true });
  // A read whose audit row was to be logged first, refused for the same reason, is told the same.
  expect(hostedFailure(new ReadNotLoggedError(after))).toMatchObject({ code: "service_limit" });
  await w.clock.drive(w.clock.sleep(1)); // let timers settle
  pod.abandon();
});

test("the failure that is told to people carries when to try again, in whole seconds", async () => {
  const failure = hostedFailure(new TailUnavailableError(2500));
  expect(failure).toEqual({
    code: "service_limit",
    message: "Service limit reached, try again later.",
    retryable: true,
    status: 503,
    retryAfterSeconds: 3,
  });
  expect(hostedFailure(new TailUnavailableError(0))?.retryAfterSeconds).toBe(1);
});

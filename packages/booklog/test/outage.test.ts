// A tail that stops answering for a long time (a daily limit reached, an outage) with a book in use
// all the while: the tail is called a handful of times, not at the pace of the book's renewals and
// requests; people are told one thing; the book comes back by itself when the tail does; and not one
// acknowledged write is lost or made twice.
import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { recordTelemetry } from "@rastrata/telemetry/testing";
import { hostedFailure } from "../src/hosted.ts";
import { readLog } from "../src/logreader.ts";
import { MeteredLogTier } from "../src/metered-tier.ts";
import { BookKeys } from "../src/objectstore.ts";
import { Rng } from "../src/rng.ts";
import { BookRuntime, CommitUncertainError } from "../src/runtime.ts";
import { GuardedLogTier, TailUnavailableError } from "../src/tier-guard.ts";
import { GENESIS_HASH } from "../src/tier.ts";
import { Outage } from "./support/outage.ts";
import { Worlds } from "./support/world.ts";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ops (id TEXT PRIMARY KEY, result TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL, amount INTEGER NOT NULL);
`;
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

const worlds = new Worlds();
afterEach(() => worlds.disposeAll());

const SECOND = 1000;
const MINUTE = 60 * SECOND;

interface Attempt {
  readonly error: string | null;
  readonly code: string | null;
  readonly tookMs: number;
  readonly at: number;
}

async function scenario(options: {
  readonly seed: number;
  readonly downFrom: number;
  readonly downTo: number;
  readonly posts: number;
  readonly everyMs: number;
  readonly idleReleaseMs?: number;
}) {
  const w = worlds.make();
  const outage = new Outage(w.tier, w.clock, options.seed);
  const rng = new Rng(options.seed + 1);
  const guard = new GuardedLogTier(outage, { clock: w.clock, random: () => rng.next() });
  const metered = new MeteredLogTier(guard);
  const start = w.clock.now();
  outage.down(start + options.downFrom, start + options.downTo);
  const pod = await BookRuntime.open({
    ...w.runtimeOptions("pod-a#1"),
    tier: metered,
    lease: { ttlMs: 5000 },
    sealing: { delayMs: 2000 },
    commit: { backoffMs: 10 },
    ...(options.idleReleaseMs ? { idleReleaseMs: options.idleReleaseMs } : {}),
  });
  const attempts: Attempt[] = [];
  const acked: string[] = [];
  const reads: Attempt[] = [];
  let firstAckAfter = null as number | null;
  let postsDone = false;

  /** What a person does: tries again, with the same identity, a little later. */
  const person = async () => {
    for (let n = 1; n <= options.posts; n += 1) {
      const id = `op-${n}`;
      for (;;) {
        const at = w.clock.now();
        try {
          await pod.write((db) => bump(db, id, "cash", 1), { opId: id });
          attempts.push({ error: null, code: null, tookMs: w.clock.now() - at, at });
          acked.push(id);
          if (firstAckAfter === null && at >= start + options.downTo) firstAckAfter = w.clock.now();
          break;
        } catch (error) {
          const failure = hostedFailure(error);
          attempts.push({
            error: error instanceof Error ? error.constructor.name : String(error),
            code: failure?.code ?? null,
            tookMs: w.clock.now() - at,
            at,
          });
          await w.clock.sleep(2 * SECOND);
        }
      }
      await w.clock.sleep(options.everyMs);
    }
    postsDone = true;
  };
  /** A screen that refreshes itself. */
  const screen = async () => {
    while (!postsDone) {
      const at = w.clock.now();
      try {
        await pod.read((db) => db.query("SELECT 1").get());
        reads.push({ error: null, code: null, tookMs: w.clock.now() - at, at });
      } catch (error) {
        reads.push({
          error: error instanceof Error ? error.constructor.name : String(error),
          code: hostedFailure(error)?.code ?? null,
          tookMs: w.clock.now() - at,
          at,
        });
      }
      await w.clock.sleep(3 * SECOND);
    }
  };
  await w.clock.drive(Promise.all([person(), screen()]));
  return {
    w,
    pod,
    outage,
    guard,
    metered,
    attempts,
    reads,
    acked,
    start,
    firstAckAfter,
  };
}

async function verify(s: Awaited<ReturnType<typeof scenario>>, posts: number) {
  const { w, pod } = s;
  // Every post the person was told was done is in the book exactly once, and nothing else is.
  expect(s.acked).toHaveLength(posts);
  expect(new Set(s.acked).size).toBe(posts);
  const events = pod.db.query("SELECT op, count(*) c FROM events GROUP BY op").all() as {
    op: string;
    c: number;
  }[];
  expect(events).toHaveLength(posts);
  expect(events.every((event) => event.c === 1)).toBe(true);
  expect((pod.db.query("SELECT v FROM kv WHERE k='cash'").get() as { v: number }).v).toBe(posts);
  // The log is one chain with one entry per operation: no entry twice, none missing, no sequence given twice.
  const entries: { seq: number; opId: string | null }[] = [];
  const reader = readLog({
    tier: w.tier,
    bulk: w.bulk,
    keys: new BookKeys("runs/t/", w.bookId),
    schema: 1,
    after: { seq: 0, hash: GENESIS_HASH },
  });
  for (let step = await reader.next(); !step.done; step = await reader.next())
    entries.push({ seq: step.value.header.seq, opId: step.value.header.opId });
  entries.forEach((entry, index) => {
    expect(entry.seq).toBe(index + 1);
  });
  const opIds = entries.map((entry) => entry.opId).filter((id): id is string => id !== null);
  expect(new Set(opIds).size).toBe(opIds.length);
  expect(new Set(opIds)).toEqual(new Set(s.acked));
  const appended = w.tier.records.filter((record) => record.op === "append");
  expect(new Set(appended.map((record) => record.seq)).size).toBe(appended.length);
  // A process that knows nothing reads the same book.
  await pod.close();
  const fresh = await BookRuntime.open({
    ...w.runtimeOptions("pod-b#1", "fresh.sqlite"),
    idleReleaseMs: 0,
  });
  expect((fresh.db.query("SELECT v FROM kv WHERE k='cash'").get() as { v: number }).v).toBe(posts);
  expect(fresh.db.query("SELECT count(*) c FROM events").get()).toEqual({ c: posts });
  await fresh.close();
}

test("ten minutes of a tail that does not answer: a handful of calls, one message, back by itself, nothing lost or doubled", async () => {
  const telemetry = recordTelemetry();
  try {
    const posts = 360;
    const s = await scenario({
      seed: 11,
      downFrom: 10 * MINUTE,
      downTo: 25 * MINUTE,
      posts,
      everyMs: 4 * SECOND,
      idleReleaseMs: MINUTE,
    });
    // The tail was called a handful of times while it was down. The book asked for far more than that:
    // a renewal every 1.7 s and a person trying again every 2 s, for fifteen minutes.
    const down = 15 * MINUTE;
    expect(s.outage.callsWhileDown).toBeLessThan(80);
    expect(down / 1700 + down / 2000).toBeGreaterThan(900);
    const status = s.guard.status();
    expect(status.rejected).toBeGreaterThan(400);
    expect(status.opened).toBeGreaterThanOrEqual(1);
    expect(status.closed).toBe(status.opened);
    expect(status.state).toBe("closed");
    expect(telemetry.sum("tail.breaker", { breaker_event: "rejected" })).toBe(status.rejected);
    expect(telemetry.invalid).toEqual([]);

    // What people saw while it was down: after the first few attempts, one thing.
    const whileDown = s.attempts.filter(
      (a) => a.at >= s.start + 10 * MINUTE && a.at < s.start + 25 * MINUTE,
    );
    expect(whileDown.length).toBeGreaterThan(100);
    expect(whileDown.every((a) => a.error !== null)).toBe(true);
    const codes = new Map<string | null, number>();
    for (const a of whileDown) codes.set(a.code, (codes.get(a.code) ?? 0) + 1);
    expect(
      [...codes.keys()].every(
        (code) =>
          code === "service_limit" || code === "commit_uncertain" || code === "tail_unavailable",
      ),
    ).toBe(true);
    expect((codes.get("service_limit") ?? 0) / whileDown.length).toBeGreaterThan(0.9);
    // The reads of the screen: served from the cache while the lease was good, then the same one thing.
    const readsDown = s.reads.filter(
      (r) => r.at >= s.start + 11 * MINUTE && r.at < s.start + 25 * MINUTE,
    );
    expect(readsDown.length).toBeGreaterThan(100);
    expect(readsDown.every((r) => r.error === null || r.code === "service_limit")).toBe(true);
    expect(readsDown.filter((r) => r.code === "service_limit").length).toBeGreaterThan(
      readsDown.length * 0.9,
    );
    // Nothing hung and nothing took long: refusing is immediate.
    expect(Math.max(...s.attempts.map((a) => a.tookMs))).toBeLessThan(2 * SECOND);
    expect(Math.max(...s.reads.map((r) => r.tookMs))).toBeLessThan(2 * SECOND);

    // It came back by itself, within the longest wait the breaker has plus a try of the person's.
    expect(s.firstAckAfter).not.toBeNull();
    expect((s.firstAckAfter as number) - (s.start + 25 * MINUTE)).toBeLessThan(75 * SECOND);
    expect(
      s.attempts.filter((a) => a.at > s.start + 27 * MINUTE).every((a) => a.error === null),
    ).toBe(true);
    // Answers lost after the tail had applied them happened, and cost nothing.
    expect(s.outage.lostAnswers).toBeGreaterThan(0);
    await verify(s, posts);
  } finally {
    telemetry.stop();
  }
});

test("a tail that stays down for hours is called a few hundred times, and the book is whole when it comes back", async () => {
  const posts = 90;
  const s = await scenario({
    seed: 5,
    downFrom: 5 * MINUTE,
    downTo: 3 * 60 * MINUTE,
    posts,
    everyMs: 2 * MINUTE,
  });
  // Posts every two minutes with an attempt every two seconds: thousands of requests, and
  // roughly one call to the tail a minute.
  expect(s.attempts.length).toBeGreaterThan(1500);
  expect(s.outage.callsWhileDown).toBeLessThan(400);
  expect(
    s.attempts.filter(
      (a) => a.error !== null && a.code !== "service_limit" && a.code !== "commit_uncertain",
    ),
  ).toEqual([]);
  await verify(s, posts);
});

test("a commit refused before anything was sent is refused whole; one that may have landed says so", async () => {
  const w = worlds.make();
  const outage = new Outage(w.tier, w.clock, 3);
  const rng = new Rng(3);
  const guard = new GuardedLogTier(outage, {
    clock: w.clock,
    random: () => rng.next(),
    failureThreshold: 1,
  });
  const pod = await BookRuntime.open({
    ...w.runtimeOptions("pod-a#1"),
    tier: guard,
    lease: { ttlMs: 60_000 },
    commit: { backoffMs: 10 },
  });
  await pod.write((db) => bump(db, "op-0", "cash", 1), { opId: "op-0" });
  const start = w.clock.now();
  outage.down(start, start + 10 * MINUTE);
  // The first append goes out, is answered with a failure, and the guard opens: the commit may have landed.
  const first = await w.clock.drive(
    pod
      .write((db) => bump(db, "op-1", "cash", 1), { opId: "op-1" })
      .then(
        () => null,
        (error: unknown) => error,
      ),
  );
  expect(first).toBeInstanceOf(CommitUncertainError);
  // Now nothing is sent: the next commit is refused whole, and the cache is as it was.
  const calls = outage.calls;
  const second = await w.clock.drive(
    pod
      .write((db) => bump(db, "op-2", "cash", 1), { opId: "op-2" })
      .then(
        () => null,
        (error: unknown) => error,
      ),
  );
  expect(second).toBeInstanceOf(TailUnavailableError);
  expect(outage.calls).toBe(calls);
  expect(pod.db.query("SELECT count(*) c FROM ops WHERE id='op-2'").get()).toEqual({ c: 0 });
  expect(hostedFailure(second)).toMatchObject({
    code: "service_limit",
    status: 503,
    retryable: true,
  });
  // When the tail is back both are sent again under their identities: op-1 is found done or done now, once.
  await w.clock.drive(w.clock.sleep(11 * MINUTE + 70 * SECOND));
  let again = "";
  for (let attempt = 0; attempt < 10 && again === ""; attempt += 1)
    again = await w.clock.drive(
      pod.write((db) => bump(db, "op-1", "cash", 1), { opId: "op-1" }).catch(() => ""),
    );
  expect(again).not.toBe("");
  await w.clock.drive(pod.write((db) => bump(db, "op-2", "cash", 1), { opId: "op-2" }));
  expect(pod.db.query("SELECT op, count(*) c FROM events GROUP BY op ORDER BY op").all()).toEqual([
    { op: "op-0", c: 1 },
    { op: "op-1", c: 1 },
    { op: "op-2", c: 1 },
  ]);
  await w.clock.drive(pod.close());
});

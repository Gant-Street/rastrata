import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { recordTelemetry } from "@rastrata/telemetry/testing";
import { BookKeys } from "../src/objectstore.ts";
import { Rng } from "../src/rng.ts";
import { BookRuntime, type BookRuntimeOptions } from "../src/runtime.ts";
import { Worlds, type World } from "./support/world.ts";

/** When entries are sealed. An entry that carries a write arms the short window (2 s); an entry that
 * carries only what a read wrote (an agent's audit row) does not, and goes out with the next seal of any
 * kind or when the oldest of them is ten minutes old. */

const worlds = new Worlds();
afterEach(() => worlds.disposeAll());

const WINDOW = 2000;
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, what TEXT NOT NULL);
`;

const write = (pod: BookRuntime, key: string) =>
  pod.write((db: Database) => {
    db.exec(SCHEMA);
    db.run("INSERT INTO kv (k, v) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET v = v + 1", [key]);
  });
/** What an agent's request does: one audit row, which must be on record before the answer. */
const agentRead = (pod: BookRuntime, what = "read") =>
  pod.read(
    (db: Database) => {
      db.exec(SCHEMA);
      db.run("INSERT INTO audit (what) VALUES (?)", [what]);
    },
    { effects: "log-first" },
  );

function open(w: World, extra: Partial<BookRuntimeOptions> = {}): Promise<BookRuntime> {
  return BookRuntime.open({
    ...w.runtimeOptions("pod-a#1"),
    sealing: { delayMs: WINDOW, routineMaxAgeMs: 600_000 },
    ...extra,
  });
}

const segments = (w: World): { from: number; to: number }[] => {
  const keys = new BookKeys("runs/t/", w.bookId);
  return w.bulk
    .keys(keys.sealedPrefix)
    .map((key) => keys.rangeOfSealed(key))
    .filter((range): range is { from: number; to: number } => range !== null)
    .sort((a, b) => a.from - b.from);
};
const sealedThrough = async (w: World): Promise<number> =>
  (await w.tier.head(w.bookId)).sealedThrough;
const total = (pod: BookRuntime): number =>
  Object.values(pod.stats.seals).reduce((sum, n) => sum + n, 0);

test("an entry that carries a write is sealed within the window, with the pending audit rows in the same segment", async () => {
  const w = worlds.make();
  const pod = await open(w);
  await write(pod, "a");
  await w.sleep(WINDOW + 500);
  expect(segments(w)).toEqual([{ from: 1, to: 1 }]);
  // Five audit rows over a minute: none of them arms the window.
  for (let index = 0; index < 5; index += 1) {
    await agentRead(pod);
    await w.sleep(10_000);
  }
  expect(segments(w)).toHaveLength(1);
  expect((await w.tier.head(w.bookId)).seq - (await sealedThrough(w))).toBe(5);
  // A write arms it. Two seconds later everything is sealed, the audit rows in the same segment.
  await write(pod, "b");
  await w.sleep(WINDOW + 500);
  expect(segments(w)).toEqual([
    { from: 1, to: 1 },
    { from: 2, to: 7 },
  ]);
  expect(await sealedThrough(w)).toBe(7);
  await pod.close({ seal: false });
});

test("a thousand agent reads over ten minutes with no write cause at most two seals", async () => {
  const w = worlds.make();
  const pod = await open(w);
  await write(pod, "a");
  await w.sleep(WINDOW + 500);
  const before = total(pod);
  for (let index = 0; index < 1000; index += 1) {
    await agentRead(pod, `read ${index}`);
    await w.sleep(600);
  }
  await w.sleep(1000);
  expect(total(pod) - before).toBeLessThanOrEqual(2);
  // None of them waited for a seal to be answered, and the oldest never waited beyond the limit.
  expect(pod.stats.readFlushes).toBe(1000);
  await pod.close({ seal: false });
});

test("a write never waits longer than the window because of audit traffic, and tail loss at any instant loses nothing older", async () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const w = worlds.make();
    const rng = new Rng(seed);
    const pod = await open(w);
    const urgent: { seq: number; at: number }[] = [];
    let writes = 0;
    // Five minutes: an agent reads every 0.6 s, a person writes now and then, a loss of the tail may come at any time.
    const lossAt = rng.between(20_000, 290_000);
    let lost = false;
    for (let step = 0; step < 3000 && !lost; step += 1) {
      const now = w.clock.now();
      if (now >= lossAt) {
        lost = true;
        // Everything not sealed is gone. Every acknowledged write older than the window must be sealed.
        const sealed = await sealedThrough(w);
        const late = urgent.filter((entry) => now - entry.at > WINDOW + 1000 && entry.seq > sealed);
        expect(late, `seed ${seed}`).toEqual([]);
        break;
      }
      if (step % 6 === 0 && rng.chance(0.35)) {
        await write(pod, `k${writes++}`);
        urgent.push({ seq: pod.head.seq, at: w.clock.now() });
      } else await agentRead(pod, `read ${step}`);
      // No acknowledged write has waited past the window (and the time a seal itself takes).
      const sealed = await sealedThrough(w);
      for (const entry of urgent)
        if (entry.seq > sealed)
          expect(w.clock.now() - entry.at, `seed ${seed} entry ${entry.seq}`).toBeLessThanOrEqual(
            WINDOW + 500,
          );
      await w.sleep(100);
    }
    expect(lost, `seed ${seed}`).toBe(true);
    await pod.close({ seal: false });
  }
});

test("a busy book seals once a window and never in a chain, and every write still waits at most one window", async () => {
  const w = worlds.make();
  const pod = await open(w);
  // A seal takes real time here (a put and a read back, 150 ms each), so every seal has entries arrive
  // while it runs: a policy that seals again at once whenever that happens would never stop.
  w.bulk.wire.configure({ latency: { medianMs: 150, sigma: 0.01 } });
  const urgent: { seq: number; at: number }[] = [];
  let worst = 0;
  // A write every 100 ms for a minute.
  for (let step = 0; step < 600; step += 1) {
    await write(pod, `k${step}`);
    urgent.push({ seq: pod.head.seq, at: w.clock.now() });
    await w.sleep(100);
    const sealed = await sealedThrough(w);
    for (const entry of urgent)
      if (entry.seq > sealed) worst = Math.max(worst, w.clock.now() - entry.at);
  }
  await w.sleep(WINDOW + 1500);
  // About thirty windows in a minute; a chain of seals, one after another, is over a hundred.
  expect(total(pod)).toBeGreaterThanOrEqual(20);
  expect(total(pod)).toBeLessThanOrEqual(32);
  // A window, and the time the seal itself takes.
  expect(worst).toBeLessThanOrEqual(WINDOW + 1000);
  expect(await sealedThrough(w)).toBe(pod.head.seq);
  await pod.close({ seal: false });
});

test("stopping seals what a seal that was already running did not take", async () => {
  const w = worlds.make();
  const pod = await open(w);
  w.bulk.wire.configure({ latency: { medianMs: 400, sigma: 0.01 } });
  await w.clock.drive(write(pod, "a"));
  // The seal for the first entry starts at 2 s and takes more than a second; a second entry arrives during it.
  await w.sleep(WINDOW + 200);
  await w.clock.drive(write(pod, "b"));
  expect(await sealedThrough(w)).toBe(0);
  await w.clock.drive(pod.close());
  expect(await sealedThrough(w)).toBe(2);
  expect(segments(w).at(-1)?.to).toBe(2);
});

test("a process that takes over a book with entries unsealed seals them on the window, whatever they were", async () => {
  const w = worlds.make();
  const first = await open(w);
  await write(first, "a");
  await agentRead(first);
  await agentRead(first);
  first.abandon();
  await w.sleep(10_000);
  const next = await BookRuntime.open({
    ...w.runtimeOptions("pod-b#1", "b.sqlite"),
    sealing: { delayMs: WINDOW, routineMaxAgeMs: 600_000 },
  });
  expect(await sealedThrough(w)).toBe(0);
  await w.sleep(WINDOW + 500);
  expect(await sealedThrough(w)).toBe(3);
  expect(next.stats.seals.handover).toBe(1);
  await next.close({ seal: false });
});

test("a routine entry that nothing else seals goes out when it reaches its age limit, and stopping seals it at once", async () => {
  const w = worlds.make();
  const pod = await open(w, { sealing: { delayMs: WINDOW, routineMaxAgeMs: 60_000 } });
  await write(pod, "a");
  await w.sleep(WINDOW + 500);
  await agentRead(pod);
  await w.sleep(59_000);
  expect(await sealedThrough(w)).toBe(1);
  await w.sleep(2000);
  expect(await sealedThrough(w)).toBe(2);
  expect(pod.stats.seals.age).toBe(1);
  await agentRead(pod);
  await pod.close();
  expect(await sealedThrough(w)).toBe(3);
  expect(pod.stats.seals.close).toBe(1);
});

test("the old behaviour is one setting away: every entry arms the window", async () => {
  const w = worlds.make();
  const pod = await open(w, { sealing: { delayMs: WINDOW, everythingUrgent: true } });
  for (let index = 0; index < 5; index += 1) {
    await agentRead(pod);
    await w.sleep(5000);
  }
  expect(total(pod)).toBe(5);
  await pod.close({ seal: false });
});

test("seals are counted by outcome and the size of the book, for seals per book", async () => {
  const telemetry = recordTelemetry();
  try {
    const w = worlds.make();
    const pod = await open(w);
    await write(pod, "a");
    await w.sleep(WINDOW + 500);
    await write(pod, "b");
    await w.sleep(WINDOW + 500);
    expect(telemetry.sum("seal.operations", { outcome: "ok", size_bucket: "xs" })).toBe(2);
    expect(telemetry.invalid).toEqual([]);
    await pod.close({ seal: false });
  } finally {
    telemetry.stop();
  }
});

import { expect, test } from "bun:test";
import { VirtualClock } from "../src/clock.ts";
import {
  LeaseHeldElsewhereError,
  LeaseKeeper,
  LeaseLostError,
  type LeaseOptions,
} from "../src/lease.ts";
import { SimPodClock } from "../src/podclock.ts";
import { Rng } from "../src/rng.ts";
import { MemoryLogTier } from "../src/tier-memory.ts";

const BOOK = "b1";

function world(
  options: Partial<LeaseOptions> = {},
  pod?: { rate?: number; wallOffsetMs?: number },
) {
  const clock = new VirtualClock();
  const tier = new MemoryLogTier({ clock });
  const podClock = new SimPodClock(clock, pod);
  const keeper = new LeaseKeeper({
    tier,
    book: BOOK,
    holder: "pod-a#1",
    ttlMs: 5000,
    pod: podClock,
    clock,
    ...options,
  });
  const sleep = (ms: number) => clock.drive(clock.sleep(ms));
  return { clock, tier, podClock, keeper, sleep };
}

test("a granted lease is trusted for less than its length: the drift bound and a safety margin come off", async () => {
  const w = world();
  await w.keeper.acquire();
  expect(w.keeper.valid()).toBe(true);
  // 5,000 / 1.01 - 100 = 4,850.5
  expect(w.keeper.deadline).toBeCloseTo(4850.495, 2);
  await w.sleep(4800);
  expect(w.keeper.valid()).toBe(true);
  await w.sleep(100);
  expect(w.keeper.valid()).toBe(false);
  expect(() => w.keeper.assertValid()).toThrow(LeaseLostError);
});

test("renewing in the background keeps a lease valid for as long as the process runs", async () => {
  const w = world();
  await w.keeper.acquire();
  w.keeper.start();
  for (let second = 0; second < 60; second += 1) {
    await w.sleep(1000);
    expect(w.keeper.valid()).toBe(true);
  }
  expect(w.keeper.stats.renewals).toBeGreaterThanOrEqual(30);
  await w.keeper.stop();
  expect(w.keeper.valid()).toBe(false);
  // The lease was given back: another process can take it at once.
  const other = new LeaseKeeper({
    tier: w.tier,
    book: BOOK,
    holder: "pod-b#1",
    ttlMs: 5000,
    clock: w.clock,
  });
  expect((await other.acquire()).ok).toBe(true);
});

test("a deadline counts from before the request was sent: a slow answer only shortens it", async () => {
  const w = world();
  w.tier.configure({ latency: { medianMs: 800, sigma: 0 } });
  const before = w.podClock.mono();
  await w.clock.drive(w.keeper.acquire());
  expect(w.podClock.mono() - before).toBeCloseTo(800, 5);
  expect(w.keeper.deadline).toBeCloseTo(before + 4850.495, 2);
});

test("someone else holds the book: the second process is told who and for how long", async () => {
  const w = world();
  await w.keeper.acquire();
  const other = new LeaseKeeper({
    tier: w.tier,
    book: BOOK,
    holder: "pod-b#1",
    ttlMs: 5000,
    clock: w.clock,
  });
  const refused = await other.acquire();
  expect(refused.ok).toBe(false);
  await expect(other.require()).rejects.toBeInstanceOf(LeaseHeldElsewhereError);
  expect(other.valid()).toBe(false);
  await w.sleep(5100);
  expect((await other.acquire()).ok).toBe(true);
  expect(other.fence).toBe(2);
});

test("a lost renewal answer keeps the old deadline: the process stops trusting it on time", async () => {
  const w = world();
  await w.keeper.acquire();
  // Every renewal reaches the tier and its answer is lost: the tier extends, the process does not know.
  w.tier.wire.configure({ faults: { renew: { failAfter: 1 } }, timeoutMs: 300 });
  w.keeper.start();
  await w.sleep(4700);
  expect(w.keeper.valid()).toBe(true);
  await w.sleep(300);
  expect(w.keeper.valid()).toBe(false);
  expect(w.keeper.stats.renewFailures).toBeGreaterThan(0);
  // The tier's lease is still running (its answers were lost), and the process can take it back.
  w.tier.wire.configure({ faults: {} });
  const again = await w.keeper.acquire();
  expect(again.ok).toBe(true);
  expect(w.keeper.valid()).toBe(true);
});

test("a renewal the tier refuses ends the lease, and the process says so", async () => {
  const lost: string[] = [];
  const w = world({ onLost: (reason) => lost.push(reason) });
  await w.keeper.acquire();
  // The tier's clock runs ahead, as after a step: the lease lapsed there while this process still trusts it.
  const tail = new VirtualClock();
  void tail;
  await w.sleep(1000);
  // Another process takes over by waiting out the lease on the tier's clock: simulate with a released lease.
  await w.tier.release(BOOK, { holder: "pod-a#1", fence: w.keeper.fence as number });
  expect(await w.keeper.renew()).toBe(false);
  expect(lost).toEqual(["taken"]);
  expect(w.keeper.valid()).toBe(false);
  expect(w.keeper.fence).toBeNull();
});

test("a machine frozen past its lease does not serve on waking: the wall clock gives it away", async () => {
  const w = world({ ttlMs: 5000 });
  await w.keeper.acquire();
  await w.sleep(1000);
  expect(w.keeper.valid()).toBe(true);
  // Suspended for 30 s: the monotonic clock stands still, the time of day moves on.
  w.podClock.suspend(30_000);
  await w.sleep(30_000);
  expect(w.podClock.mono() - 1000).toBeLessThan(100);
  expect(w.keeper.valid()).toBe(false);
  expect(w.keeper.stats.distrusted).toBeGreaterThan(0);
  // Renewing finds the lease gone (it lapsed on the tier's clock while the machine slept).
  expect(await w.keeper.renew()).toBe(false);
});

test("a wall clock stepped by an operator is noticed, and one renewal puts things right", async () => {
  const w = world();
  await w.keeper.acquire();
  await w.sleep(500);
  expect(w.keeper.valid()).toBe(true);
  w.podClock.stepWall(3_600_000);
  expect(w.keeper.valid()).toBe(false);
  expect(await w.keeper.renew()).toBe(true);
  expect(w.keeper.valid()).toBe(true);
  w.podClock.stepWall(-120_000);
  expect(w.keeper.valid()).toBe(false);
  expect(await w.keeper.renew()).toBe(true);
  expect(w.keeper.valid()).toBe(true);
});

test("a monotonic clock that runs 1% slow, the assumed bound, never outlives the tier's lease", async () => {
  const w = world({}, { rate: 0.99 });
  const grant = await w.keeper.acquire();
  if (!grant.ok) throw new Error("no lease");
  let stillValid = 0;
  for (let step = 0; step < 6000; step += 1) {
    await w.sleep(1);
    if (w.keeper.valid()) {
      stillValid = w.clock.now();
      // While the process trusts the lease, the tier's clock has not reached its expiry.
      expect(w.clock.now()).toBeLessThan(grant.lease.expiresAt);
    }
  }
  expect(stillValid).toBeGreaterThan(4500);
  expect(stillValid).toBeLessThan(5000);
});

test("past the assumed bound only the wall clock check still saves it, and without it the process outlives its lease", async () => {
  const slow = { rate: 0.8 };
  const guarded = world({}, slow);
  const grantA = await guarded.keeper.acquire();
  if (!grantA.ok) throw new Error("no lease");
  let lastTrusted = 0;
  for (let step = 0; step < 6000; step += 1) {
    await guarded.sleep(1);
    if (guarded.keeper.valid()) lastTrusted = guarded.clock.now();
  }
  expect(lastTrusted).toBeLessThan(grantA.lease.expiresAt);

  const unguarded = world({ skewToleranceMs: 1e12 }, slow);
  const grantB = await unguarded.keeper.acquire();
  if (!grantB.ok) throw new Error("no lease");
  let outlived = false;
  for (let step = 0; step < 6000; step += 1) {
    await unguarded.sleep(1);
    if (unguarded.keeper.valid() && unguarded.clock.now() >= grantB.lease.expiresAt)
      outlived = true;
  }
  expect(outlived).toBe(true);
});

test("under random jitter, loss and drift within the bound, a process never trusts a lease the tier has ended", async () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    const rng = new Rng(seed);
    const clock = new VirtualClock();
    const tier = new MemoryLogTier({
      clock,
      seed,
      latency: { medianMs: rng.between(1, 60), sigma: 0.7 },
      faults: { renew: { failBefore: 0.1, failAfter: 0.1 }, acquire: { failBefore: 0.1 } },
      timeoutMs: 400,
    });
    const pod = new SimPodClock(clock, { rate: 1 - rng.next() * 0.01 });
    const keeper = new LeaseKeeper({
      tier,
      book: BOOK,
      holder: "pod-a#1",
      ttlMs: 3000,
      pod,
      clock,
      skewToleranceMs: 1e12,
    });
    const violations: string[] = [];
    await clock.drive(
      (async () => {
        for (let attempt = 0; attempt < 5 && keeper.fence === null; attempt += 1) {
          try {
            await keeper.acquire();
          } catch {
            // try again
          }
        }
        keeper.start();
        for (let step = 0; step < 4000; step += 1) {
          await clock.sleep(5 + rng.int(20));
          if (keeper.valid()) {
            const peek = tier.peek(BOOK).head;
            // Whatever the tier says, a lease the process trusts must still be live on the tier's clock.
            if (peek.leaseHolder !== "pod-a#1" || (peek.leaseExpiresAt ?? 0) <= clock.now())
              violations.push(`seed ${seed} at ${clock.now()}`);
          }
        }
      })(),
    );
    expect(violations).toEqual([]);
  }
});

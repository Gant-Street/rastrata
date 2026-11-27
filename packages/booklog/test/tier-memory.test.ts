import { expect, test } from "bun:test";
import { VirtualClock } from "../src/clock.ts";
import { MemoryObjectStore } from "../src/memory.ts";
import { ObjectStoreUncertain } from "../src/objectstore.ts";
import { MemoryLogTier } from "../src/tier-memory.ts";
import { ObjectStoreLogTier } from "../src/tier-objects.ts";
import { DurableObjectLogTier, fakeDurableObjectFetch } from "../src/tier-durable.ts";
import { GENESIS_HASH } from "../src/tier.ts";
import { checkRestoration, entryAfter, fill, tierConformance } from "./support/tier-conformance.ts";

tierConformance("MemoryLogTier", () => {
  const clock = new VirtualClock();
  const tier = new MemoryLogTier({ clock });
  return {
    tier,
    trims: true,
    advance: async (ms) => {
      await clock.drive(clock.sleep(ms));
    },
  };
});

tierConformance("ObjectStoreLogTier over the memory store", () => {
  const tier = new ObjectStoreLogTier(new MemoryObjectStore(), { prefix: "runs/t/" });
  return { tier, trims: false, advance: async () => {} };
});

tierConformance("DurableObjectLogTier over a fake Worker", () => {
  const clock = new VirtualClock();
  const core = new MemoryLogTier({ clock });
  const tier = new DurableObjectLogTier({
    baseUrl: "https://tail.invalid",
    token: "secret",
    fetch: fakeDurableObjectFetch({ core, token: "secret" }),
  });
  return {
    tier,
    trims: true,
    advance: async (ms) => {
      await clock.drive(clock.sleep(ms));
    },
  };
});

test("the durable object protocol refuses a wrong token and unknown routes, and reports a broken object as uncertain", async () => {
  const core = new MemoryLogTier();
  const wrong = new DurableObjectLogTier({
    baseUrl: "https://tail.invalid",
    token: "wrong",
    fetch: fakeDurableObjectFetch({ core, token: "secret" }),
  });
  await expect(wrong.head("b")).rejects.toThrow(/401/);
  const broken = new DurableObjectLogTier({
    baseUrl: "https://tail.invalid",
    fetch: async () => new Response("boom", { status: 500 }),
  });
  await expect(broken.head("b")).rejects.toBeInstanceOf(ObjectStoreUncertain);
  const dropped = new DurableObjectLogTier({
    baseUrl: "https://tail.invalid",
    fetch: async () => {
      throw new Error("connection reset");
    },
  });
  await expect(dropped.append("b", entryAfter(1, GENESIS_HASH, 1))).rejects.toBeInstanceOf(
    ObjectStoreUncertain,
  );
});

test("the tier's lease clock is its own: stepping it forward ends a lease early", async () => {
  const wire = new VirtualClock();
  const tail = new VirtualClock();
  const tier = new MemoryLogTier({ clock: wire, tailClock: tail });
  const a = await tier.acquire("b", "pod-a", 5000);
  expect(a.ok).toBe(true);
  expect((await tier.acquire("b", "pod-b", 5000)).ok).toBe(false);
  await tail.drive(tail.sleep(6000));
  expect((await tier.acquire("b", "pod-b", 5000)).ok).toBe(true);
});

test("a lost response to an append is resolved by asking again: the entry is not written twice", async () => {
  const clock = new VirtualClock();
  const tier = new MemoryLogTier({ clock, timeoutMs: 1000 });
  const lease = await tier.acquire("b", "pod-a", 60_000);
  if (!lease.ok) throw new Error("no lease");
  const pod = tier.client("pod-a");
  tier.script([{ op: "append", fault: "failAfter", nth: 1 }]);
  const first = entryAfter(1, GENESIS_HASH, lease.lease.fence);
  const outcome = await clock.drive(pod.append("b", first)).then(
    () => "answered",
    (error: unknown) => (error instanceof ObjectStoreUncertain ? "uncertain" : "other"),
  );
  expect(outcome).toBe("uncertain");
  expect(tier.peek("b").entries).toHaveLength(1);
  const retry = await pod.append("b", first);
  expect(retry.ok && retry.duplicate).toBe(true);
  expect(tier.peek("b").entries).toHaveLength(1);
});

test("a duplicate delivery of an append is also answered as a duplicate, never a second entry", async () => {
  const tier = new MemoryLogTier();
  const lease = await tier.acquire("b", "pod-a", 60_000);
  if (!lease.ok) throw new Error("no lease");
  tier.script([{ op: "append", fault: "duplicate", nth: 1 }]);
  const result = await tier.append("b", entryAfter(1, GENESIS_HASH, lease.lease.fence));
  expect(result.ok && result.duplicate).toBe(true);
  expect(tier.peek("b").entries).toHaveLength(1);
});

test("a client that dies after its append landed leaves the entry in the tail", async () => {
  const clock = new VirtualClock();
  const tier = new MemoryLogTier({ clock });
  const lease = await tier.acquire("b", "pod-a", 60_000);
  if (!lease.ok) throw new Error("no lease");
  tier.script([{ op: "append", fault: "killAfter", nth: 1 }]);
  const pending = tier.client("pod-a").append("b", entryAfter(1, GENESIS_HASH, lease.lease.fence));
  const settled = await clock.drive(
    Promise.race([pending.then(() => "answered"), clock.sleep(10_000).then(() => "silent")]),
  );
  expect(settled).toBe("silent");
  expect(tier.peek("b").head.seq).toBe(1);
  // The next holder, once the lease lapses, finds the entry as the head.
  await clock.drive(clock.sleep(61_000));
  const next = await tier.acquire("b", "pod-b", 5000);
  expect(next.ok && next.lease.head.seq).toBe(1);
});

test("the tier records what it accepted and refused, for an oracle outside it", async () => {
  const clock = new VirtualClock();
  const tier = new MemoryLogTier({ clock });
  const a = await tier.acquire("b", "pod-a", 1000);
  if (!a.ok) throw new Error("no lease");
  await fill(tier, "b", a.lease.fence, 3);
  await tier.append("b", entryAfter(9, GENESIS_HASH, a.lease.fence));
  await tier.append("b", entryAfter(4, "e".repeat(64), a.lease.fence));
  await tier.append("b", entryAfter(4, "e".repeat(64), 99));
  await tier.acquire("b", "pod-b", 1000);
  expect(tier.records.filter((record) => record.op === "append")).toHaveLength(3);
  expect(tier.refusals.append).toEqual({ fence: 1, seq: 1, prev: 1 });
  expect(tier.refusals.acquireHeld).toBe(1);
});

test("losing the newest entries is possible only on purpose, as a negative control", async () => {
  const tier = new MemoryLogTier();
  const a = await tier.acquire("b", "pod-a", 60_000);
  if (!a.ok) throw new Error("no lease");
  const last = await fill(tier, "b", a.lease.fence, 5);
  tier.loseLast("b", 2);
  const head = await tier.head("b");
  expect(head.seq).toBe(3);
  expect(head.hash).not.toBe(last);
});

test("calls take the time the latency model says, and the same seed gives the same times", async () => {
  const run = async (seed: number) => {
    const clock = new VirtualClock();
    const tier = new MemoryLogTier({ clock, seed, latency: { medianMs: 10, sigma: 0.7 } });
    const stamps: number[] = [];
    await clock.drive(
      (async () => {
        const lease = await tier.acquire("b", "pod-a", 60_000);
        if (!lease.ok) return;
        let hash = GENESIS_HASH;
        for (let seq = 1; seq <= 5; seq += 1) {
          const input = entryAfter(seq, hash, lease.lease.fence);
          await tier.append("b", input);
          hash = input.hash;
          stamps.push(clock.now());
        }
      })(),
    );
    return stamps;
  };
  const a = await run(5);
  expect(await run(5)).toEqual(a);
  expect(await run(6)).not.toEqual(a);
  expect(a[4]).toBeGreaterThan(20);
});

test("a tail that lost a book is given a head at the newest sealed entry, once: memory, and the Durable Object protocol over a fake Worker", async () => {
  await checkRestoration(new MemoryLogTier({ clock: new VirtualClock() }));
  await checkRestoration(
    new DurableObjectLogTier({
      baseUrl: "https://tail.invalid",
      fetch: fakeDurableObjectFetch({ core: new MemoryLogTier() }),
    }),
  );
  // A tail that cannot be restored says so on the wire.
  const plain = new DurableObjectLogTier({
    baseUrl: "https://tail.invalid",
    fetch: fakeDurableObjectFetch({ core: new ObjectStoreLogTier(new MemoryObjectStore()) }),
  });
  await expect(plain.adopt("b", { seq: 1, hash: "a".repeat(64), fence: 1 })).rejects.toThrow(/501/);
});

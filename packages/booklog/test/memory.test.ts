import { expect, test } from "bun:test";
import { VirtualClock } from "../src/clock.ts";
import { MemoryObjectStore, type FaultKind } from "../src/memory.ts";
import { ObjectStoreUncertain, type ListedObject } from "../src/objectstore.ts";
import { Rng } from "../src/rng.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

/** "settled" when the promise answers (or fails), "hung" when it has not by `ms` of virtual time. */
async function settlement(clock: VirtualClock, work: Promise<unknown>, ms = 60_000) {
  const outcome = work.then(
    () => "settled",
    () => "settled",
  );
  return clock.drive(Promise.race([outcome, clock.sleep(ms).then(() => "hung")]));
}

test("a create-only write is atomic: of many concurrent writers exactly one wins", async () => {
  const store = new MemoryObjectStore();
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      store.putIfAbsent("books/b/log/1", bytes(`w${index}`)),
    ),
  );
  expect(results.filter((result) => result.created)).toHaveLength(1);
  expect(results.filter((result) => !result.created)).toHaveLength(49);
  const winner = results.findIndex((result) => result.created);
  expect(text((await store.get("books/b/log/1"))!.body)).toBe(`w${winner}`);
});

test("get, head and metadata", async () => {
  const store = new MemoryObjectStore();
  expect(await store.get("a")).toBeNull();
  expect(await store.head("a")).toBeNull();
  const put = await store.putIfAbsent("a", bytes("hello"), {
    metadata: { Hash: "h1", Prev: "p0" },
  });
  expect(put.created).toBe(true);
  const got = (await store.get("a"))!;
  expect(text(got.body)).toBe("hello");
  expect(got.size).toBe(5);
  expect(got.metadata).toEqual({ hash: "h1", prev: "p0" });
  const head = (await store.head("a"))!;
  expect(head.size).toBe(5);
  expect(head.etag).toBe(got.etag);
  expect("body" in head).toBe(false);
  // The stored bytes are a copy: changing the caller's buffer later does not change the object.
  const source = bytes("abc");
  await store.putIfAbsent("b", source);
  source[0] = 0;
  expect(text((await store.get("b"))!.body)).toBe("abc");
});

test("listing is ordered, filtered by prefix, resumable and bounded", async () => {
  const store = new MemoryObjectStore();
  for (const key of ["x/2", "x/10", "x/1", "y/1", "x/3", "w/9"])
    await store.putIfAbsent(key, bytes(key));
  const keys = (page: { objects: readonly ListedObject[] }) => page.objects.map((item) => item.key);
  expect(keys(await store.list("x/"))).toEqual(["x/1", "x/10", "x/2", "x/3"]);
  expect(keys(await store.list("x/", "x/1"))).toEqual(["x/10", "x/2", "x/3"]);
  expect(keys(await store.list("x/", "x/2"))).toEqual(["x/3"]);
  expect(keys(await store.list("x/", "x/9"))).toEqual([]);
  expect(keys(await store.list("x/", "a"))).toEqual(["x/1", "x/10", "x/2", "x/3"]);
  const first = await store.list("x/", undefined, 2);
  expect(keys(first)).toEqual(["x/1", "x/10"]);
  expect(first.truncated).toBe(true);
  const rest = await store.list("x/", "x/10", 2);
  expect(keys(rest)).toEqual(["x/2", "x/3"]);
  expect(rest.truncated).toBe(false);
  // 2,500 keys come back in pages of at most 1,000.
  for (let index = 0; index < 2500; index += 1)
    await store.putIfAbsent(`log/${String(index).padStart(6, "0")}`, bytes("e"));
  const seen: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await store.list("log/", after);
    expect(page.objects.length).toBeLessThanOrEqual(1000);
    seen.push(...keys(page));
    if (!page.truncated) break;
    after = page.objects[page.objects.length - 1]!.key;
  }
  expect(seen).toHaveLength(2500);
  expect(seen).toEqual([...seen].sort());
});

test("delete is idempotent and removes the key from listings", async () => {
  const store = new MemoryObjectStore();
  await store.putIfAbsent("k", bytes("v"));
  await store.delete("k");
  await store.delete("k");
  expect(await store.get("k")).toBeNull();
  expect((await store.list("")).objects).toEqual([]);
  expect((await store.putIfAbsent("k", bytes("again"))).created).toBe(true);
});

test("a delayed-visibility store hides a fresh object from reads but never from the create-only check", async () => {
  const clock = new VirtualClock();
  const store = new MemoryObjectStore({ clock, visibilityDelayMs: 100 });
  expect((await store.putIfAbsent("k", bytes("v"))).created).toBe(true);
  expect(await store.get("k")).toBeNull();
  expect(await store.head("k")).toBeNull();
  expect((await store.list("")).objects).toEqual([]);
  // The write path is strongly consistent: a second create-only write sees the first.
  expect((await store.putIfAbsent("k", bytes("other"))).created).toBe(false);
  await clock.drive(clock.sleep(150));
  expect(text((await store.get("k"))!.body)).toBe("v");
  expect((await store.list("")).objects).toHaveLength(1);
});

test("latency advances virtual time, a round trip being the sum of both legs", async () => {
  const clock = new VirtualClock();
  const store = new MemoryObjectStore({ clock, latency: { medianMs: 40, sigma: 0 } });
  const started = clock.now();
  await clock.drive(store.putIfAbsent("k", bytes("v")));
  expect(clock.now() - started).toBeCloseTo(40, 5);
  const timed = clock.now();
  await clock.drive(store.get("k"));
  expect(clock.now() - timed).toBeCloseTo(40, 5);
});

test("concurrent writers on a slow store are ordered by their sampled delays, reproducibly", async () => {
  const run = async (seed: number) => {
    const clock = new VirtualClock();
    const store = new MemoryObjectStore({ clock, seed, latency: { medianMs: 30, sigma: 0.8 } });
    const winners: number[] = [];
    await clock.drive(
      Promise.all(
        Array.from({ length: 8 }, async (_, index) => {
          const result = await store.client(`p${index}`).putIfAbsent("k", bytes(`w${index}`));
          if (result.created) winners.push(index);
        }),
      ),
    );
    return winners;
  };
  const first = await run(7);
  expect(first).toHaveLength(1);
  expect(await run(7)).toEqual(first);
  const many = new Set<number>();
  for (let seed = 1; seed <= 40; seed += 1) many.add((await run(seed))[0]!);
  expect(many.size).toBeGreaterThan(3);
});

async function oneFault(fault: FaultKind) {
  const clock = new VirtualClock();
  const store = new MemoryObjectStore({ clock, timeoutMs: 1000 });
  store.script([{ op: "put", fault, nth: 1 }]);
  const writer = store.client("pod-1");
  const attempt = writer.putIfAbsent("k", bytes("mine")).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  const state = await settlement(clock, attempt);
  return { clock, store, writer, attempt, state };
}

test("failBefore: a 5xx before the request was applied leaves nothing written", async () => {
  const { store, attempt, clock } = await oneFault("failBefore");
  const result = await clock.drive(attempt);
  expect("error" in result && result.error).toBeInstanceOf(ObjectStoreUncertain);
  expect(store.peek("k")).toBeNull();
});

test("failAfter: the write is applied and the answer is lost; the client times out", async () => {
  const { store, attempt, clock } = await oneFault("failAfter");
  const result = await clock.drive(attempt);
  expect("error" in result && result.error).toBeInstanceOf(ObjectStoreUncertain);
  expect(text(store.peek("k")!.body)).toBe("mine");
  expect(clock.now()).toBeGreaterThanOrEqual(1000);
});

test("duplicate: the client is told 'already exists' about its own write", async () => {
  const { store, attempt, clock } = await oneFault("duplicate");
  const result = (await clock.drive(attempt)) as { value: { created: boolean } };
  expect(result.value.created).toBe(false);
  expect(text(store.peek("k")!.body)).toBe("mine");
});

test("killBefore and killAfter: the process vanishes, mid-call and afterwards", async () => {
  const before = await oneFault("killBefore");
  expect(before.state).toBe("hung");
  expect(before.store.peek("k")).toBeNull();
  expect(before.store.isDead("pod-1")).toBe(true);
  const after = await oneFault("killAfter");
  expect(after.state).toBe("hung");
  expect(text(after.store.peek("k")!.body)).toBe("mine");
  // A dead client's later calls never answer; another client is unaffected.
  const later = after.writer.get("k");
  expect(await settlement(after.clock, later)).toBe("hung");
  expect(text((await after.store.client("pod-2").get("k"))!.body)).toBe("mine");
});

test("scripted faults match by key, client and occurrence", async () => {
  const store = new MemoryObjectStore();
  store.script([{ op: "put", key: /log\/0*2$/, fault: "failBefore", nth: 1 }]);
  expect((await store.putIfAbsent("log/000001", bytes("a"))).created).toBe(true);
  await expect(store.putIfAbsent("log/000002", bytes("b"))).rejects.toBeInstanceOf(
    ObjectStoreUncertain,
  );
  expect((await store.putIfAbsent("log/000002", bytes("b"))).created).toBe(true);
  expect(store.stats.faults.failBefore).toBe(1);
});

test("random faults follow the seed: same seed, same calls, same outcomes", async () => {
  const outcomes = async (seed: number) => {
    const store = new MemoryObjectStore({
      seed,
      faults: { put: { failBefore: 0.1, failAfter: 0.1, duplicate: 0.1 } },
      timeoutMs: 1,
    });
    const rng = new Rng(seed);
    const seen: string[] = [];
    for (let index = 0; index < 300; index += 1) {
      const key = `k/${rng.int(40)}`;
      try {
        const result = await store.putIfAbsent(key, bytes("v"));
        seen.push(result.created ? "c" : "e");
      } catch {
        seen.push("x");
      }
    }
    return seen.join("");
  };
  const a = await outcomes(11);
  expect(await outcomes(11)).toBe(a);
  expect(await outcomes(12)).not.toBe(a);
  expect(a).toContain("x");
});

test("operations are counted by billing class", async () => {
  const store = new MemoryObjectStore();
  await store.putIfAbsent("a", bytes("1234"));
  await store.putIfAbsent("a", bytes("5678"));
  await store.get("a");
  await store.head("a");
  await store.head("missing");
  await store.list("");
  await store.delete("a");
  const stats = store.stats;
  expect(stats.ops).toEqual({ put: 2, get: 1, head: 2, list: 1, delete: 1 });
  expect(stats.classA).toBe(3);
  expect(stats.classB).toBe(3);
  expect(stats.conflicts).toBe(1);
  expect(stats.bytesIn).toBe(8);
  expect(stats.bytesOut).toBe(4);
});

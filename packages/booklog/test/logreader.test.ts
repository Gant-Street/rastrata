import { expect, test } from "bun:test";
import { VirtualClock } from "../src/clock.ts";
import { compactOnce } from "../src/compactor.ts";
import { EntryError, buildEntry, type BuiltEntry } from "../src/entry.ts";
import { LogGapError, listSealedSegments, readLog, type LogEntry } from "../src/logreader.ts";
import { assertTailNotBehind } from "../src/materialize.ts";
import { MemoryObjectStore } from "../src/memory.ts";
import { BookKeys } from "../src/objectstore.ts";
import { Sealer } from "../src/sealer.ts";
import { decodeSegment, encodeSegment } from "../src/segment.ts";
import { MemoryLogTier } from "../src/tier-memory.ts";
import { GENESIS_HASH } from "../src/tier.ts";

const BOOK = "b1";

class World {
  readonly clock = new VirtualClock();
  readonly tier = new MemoryLogTier({ clock: this.clock });
  readonly bulk = new MemoryObjectStore({ clock: this.clock });
  readonly keys = new BookKeys("runs/t/", BOOK);
  readonly built: BuiltEntry[] = [];
  fence = 0;

  async open() {
    const lease = await this.tier.acquire(BOOK, "pod-a#1", 3_600_000);
    if (!lease.ok) throw new Error("no lease");
    this.fence = lease.lease.fence;
    return this;
  }

  async commit(count: number, schema = 1, label = "rows") {
    for (let index = 0; index < count; index += 1) {
      const seq = this.built.length + 1;
      const prev = this.built[seq - 2]?.header.hash ?? GENESIS_HASH;
      const entry = buildEntry({
        bookId: BOOK,
        seq,
        prev,
        writer: "pod-a#1",
        fence: this.fence,
        schema,
        kind: "commit",
        at: "2026-10-08T00:00:00.000Z",
        payload: new TextEncoder().encode(`${label} ${seq}`),
        changes: 1,
      });
      const result = await this.tier.append(BOOK, {
        seq,
        prevHash: prev,
        hash: entry.header.hash,
        fence: this.fence,
        body: entry.bytes,
      });
      if (!result.ok) throw new Error(`append ${seq}: ${result.reason}`);
      this.built.push(entry);
    }
    return this;
  }

  async seal() {
    const sealer = new Sealer({
      tier: this.tier,
      bulk: this.bulk,
      keys: this.keys,
      clock: this.clock,
    });
    return this.clock.drive(sealer.sealOnce());
  }

  async read(after = { seq: 0, hash: GENESIS_HASH }, schema = 1) {
    const seqs: number[] = [];
    const sources: string[] = [];
    const generator = readLog({ tier: this.tier, bulk: this.bulk, keys: this.keys, schema, after });
    let next = await generator.next();
    while (!next.done) {
      const entry: LogEntry = next.value;
      seqs.push(entry.header.seq);
      sources.push(entry.source);
      next = await generator.next();
    }
    return { seqs, sources, result: next.value };
  }
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

test("the whole log is read in order: sealed segments first, then the tail", async () => {
  const w = await new World().open();
  await w.commit(5);
  await w.seal();
  await w.commit(4);
  await w.seal();
  await w.commit(3);
  const { seqs, sources, result } = await w.read();
  expect(seqs).toEqual(range(1, 12));
  expect(sources).toEqual([...Array(9).fill("sealed"), ...Array(3).fill("tail")]);
  expect(result.head).toEqual({ seq: 12, hash: w.built[11]!.header.hash });
  expect(result).toMatchObject({ sealedEntries: 9, tailEntries: 3, segmentsRead: 2 });
});

test("reading from a snapshot's position skips into the middle of a segment, and needs no listing when the tail has it all", async () => {
  const w = await new World().open();
  await w.commit(8);
  await w.seal();
  await w.commit(4);
  const mid = await w.read({ seq: 5, hash: w.built[4]!.header.hash });
  expect(mid.seqs).toEqual(range(6, 12));
  expect(mid.result.segmentsRead).toBe(1);
  const near = await w.read({ seq: 9, hash: w.built[8]!.header.hash });
  expect(near.seqs).toEqual([10, 11, 12]);
  expect(near.result.segmentsRead).toBe(0);
  expect(near.result.lists).toBe(0);
  const done = await w.read({ seq: 12, hash: w.built[11]!.header.hash });
  expect(done.seqs).toEqual([]);
  expect(done.result.head.seq).toBe(12);
});

test("an empty log reads as nothing", async () => {
  const w = await new World().open();
  const { seqs, result } = await w.read();
  expect(seqs).toEqual([]);
  expect(result.head).toEqual({ seq: 0, hash: GENESIS_HASH });
});

test("a snapshot position that is not on this log's chain is refused", async () => {
  const w = await new World().open();
  await w.commit(6);
  await w.seal();
  await w.commit(2);
  await expect(w.read({ seq: 3, hash: "d".repeat(64) })).rejects.toThrow(EntryError);
  await expect(w.read({ seq: 7, hash: "d".repeat(64) })).rejects.toThrow(/not chained/);
});

test("a sealed segment that is missing is a gap, never a silent skip", async () => {
  const w = await new World().open();
  await w.commit(4);
  await w.seal();
  await w.commit(4);
  await w.seal();
  w.bulk.remove(w.keys.sealed(1, 4));
  const failure = await w.read().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(LogGapError);
  expect((failure as LogGapError).missing).toBe(1);
  // From past the lost segment the log still reads.
  const later = await w.read({ seq: 4, hash: w.built[3]!.header.hash });
  expect(later.seqs).toEqual(range(5, 8));
});

test("a damaged segment is caught", async () => {
  const w = await new World().open();
  await w.commit(6);
  await w.seal();
  const key = w.keys.sealed(1, 6);
  const copy = w.bulk.peek(key)!.body.slice();
  copy[copy.length - 30] = (copy[copy.length - 30] as number) ^ 0xff;
  w.bulk.remove(key);
  w.bulk.plant(key, copy);
  await expect(w.read()).rejects.toThrow(EntryError);
});

test("a segment whose entries do not chain is refused even if each entry is genuine", async () => {
  const w = await new World().open();
  await w.commit(6);
  await w.seal();
  const key = w.keys.sealed(1, 6);
  const entries = decodeSegment(w.bulk.peek(key)!.body);
  const swapped = [entries[0]!, entries[2]!, entries[1]!, ...entries.slice(3)];
  w.bulk.remove(key);
  w.bulk.plant(key, encodeSegment(swapped));
  await expect(w.read()).rejects.toThrow(/not a chain|Expected entry/);
});

test("an entry from newer code is refused by older code", async () => {
  const w = await new World().open();
  await w.commit(3);
  await w.commit(1, 2);
  await expect(w.read(undefined, 1)).rejects.toThrow(/schema 2; this process supports 1/);
  expect((await w.read(undefined, 2)).seqs).toEqual([1, 2, 3, 4]);
});

test("a segment replaced by a compacted one while the log is being read is found again in a fresh listing", async () => {
  const w = await new World().open();
  for (let round = 0; round < 5; round += 1) {
    await w.commit(2);
    await w.seal();
  }
  await w.commit(2);
  // The reader lists the segments, then compaction removes the small ones before it fetches them.
  let removed = false;
  const racing = {
    putIfAbsent: w.bulk.putIfAbsent.bind(w.bulk),
    head: w.bulk.head.bind(w.bulk),
    list: w.bulk.list.bind(w.bulk),
    delete: w.bulk.delete.bind(w.bulk),
    get: async (key: string) => {
      if (!removed) {
        removed = true;
        const outcome = await compactOnce({
          bulk: w.bulk,
          keys: w.keys,
          minSegments: 3,
          clock: w.clock,
        });
        expect(outcome.status).toBe("compacted");
      }
      return w.bulk.get(key);
    },
  };
  const seqs: number[] = [];
  for await (const entry of readLog({
    tier: w.tier,
    bulk: racing,
    keys: w.keys,
    schema: 1,
    after: { seq: 0, hash: GENESIS_HASH },
  }))
    seqs.push(entry.header.seq);
  expect(seqs).toEqual(range(1, 12));
});

test("compaction merges old segments into one, keeps every entry, and leaves a log that still reads", async () => {
  const w = await new World().open();
  for (let round = 0; round < 6; round += 1) {
    await w.commit(3);
    await w.seal();
  }
  await w.commit(2);
  const before = w.bulk.keys(w.keys.sealedPrefix);
  expect(before).toHaveLength(6);
  const outcome = await compactOnce({ bulk: w.bulk, keys: w.keys, minSegments: 4, clock: w.clock });
  expect(outcome.status).toBe("compacted");
  if (outcome.status !== "compacted") return;
  expect([outcome.from, outcome.to, outcome.deleted]).toEqual([1, 18, 6]);
  expect(w.bulk.keys(w.keys.sealedPrefix)).toEqual([w.keys.sealed(1, 18)]);
  const { seqs } = await w.read();
  expect(seqs).toEqual(range(1, 20));
  // Nothing more to merge, and doing it again is harmless.
  expect(
    (await compactOnce({ bulk: w.bulk, keys: w.keys, minSegments: 4, clock: w.clock })).status,
  ).toBe("nothing");
});

test("compaction survives a crash before the old segments are removed: both exist, the log reads, a second pass finishes", async () => {
  const w = await new World().open();
  for (let round = 0; round < 5; round += 1) {
    await w.commit(2);
    await w.seal();
  }
  const outcome = await compactOnce({
    bulk: w.bulk,
    keys: w.keys,
    minSegments: 3,
    deleteSources: false,
    clock: w.clock,
  });
  expect(outcome.status).toBe("compacted");
  expect(w.bulk.keys(w.keys.sealedPrefix)).toHaveLength(6);
  expect((await w.read()).seqs).toEqual(range(1, 10));
  const second = await compactOnce({ bulk: w.bulk, keys: w.keys, minSegments: 3, clock: w.clock });
  // The chain now is the merged segment plus what follows it; the leftovers are deleted when merged again.
  expect(["compacted", "nothing"]).toContain(second.status);
  expect((await w.read()).seqs).toEqual(range(1, 10));
});

test("only segments up to a limit are merged, and a run shorter than the minimum is left alone", async () => {
  const w = await new World().open();
  for (let round = 0; round < 6; round += 1) {
    await w.commit(2);
    await w.seal();
  }
  const limited = await compactOnce({
    bulk: w.bulk,
    keys: w.keys,
    minSegments: 3,
    upTo: 8,
    clock: w.clock,
  });
  expect(limited.status).toBe("compacted");
  if (limited.status === "compacted") expect([limited.from, limited.to]).toEqual([1, 8]);
  const short = await compactOnce({
    bulk: w.bulk,
    keys: w.keys,
    minSegments: 4,
    upTo: 12,
    clock: w.clock,
  });
  expect(short.status).toBe("nothing");
  expect((await w.read()).seqs).toEqual(range(1, 12));
});

/** A store or tier whose calls to the named methods take a moment, and which counts how many are under way at once. */
function slowed<T extends object>(target: T, methods: readonly string[], ms = 5) {
  const stats = { inFlight: 0, widest: 0, calls: new Map<string, number>() };
  const proxy = new Proxy(target, {
    get(self, name) {
      const value = Reflect.get(self, name, self);
      if (typeof value !== "function") return value;
      if (!methods.includes(String(name))) return value.bind(self);
      return async (...args: unknown[]) => {
        stats.calls.set(String(name), (stats.calls.get(String(name)) ?? 0) + 1);
        stats.inFlight += 1;
        stats.widest = Math.max(stats.widest, stats.inFlight);
        try {
          await new Promise<void>((done) => setTimeout(done, ms));
          return await value.apply(self, args);
        } finally {
          stats.inFlight -= 1;
        }
      };
    },
  }) as T;
  return { proxy, stats };
}

test("the segments after the one being read are asked for while it is read, and the entries still come out in order with every link checked", async () => {
  const w = await new World().open();
  for (let index = 0; index < 6; index += 1) {
    await w.commit(3);
    await w.seal();
  }
  await w.commit(2);
  const store = slowed(w.bulk, ["get"]);
  const seqs: number[] = [];
  const generator = readLog({
    tier: w.tier,
    bulk: store.proxy,
    keys: w.keys,
    schema: 1,
    after: { seq: 0, hash: GENESIS_HASH },
  });
  let next = await generator.next();
  while (!next.done) {
    seqs.push(next.value.header.seq);
    next = await generator.next();
  }
  expect(seqs).toEqual(range(1, 20));
  expect(next.value).toMatchObject({ sealedEntries: 18, tailEntries: 2, segmentsRead: 6 });
  // Six segments, asked for a few at a time: more than one under way at once, and never more than the one being read and the four after it.
  expect(store.stats.widest).toBeGreaterThan(1);
  expect(store.stats.widest).toBeLessThanOrEqual(5);
  expect(store.stats.calls.get("get")).toBe(6);
});

test("a segment that is damaged is refused at its place, however far ahead it was asked for", async () => {
  const w = await new World().open();
  for (let index = 0; index < 4; index += 1) {
    await w.commit(3);
    await w.seal();
  }
  await w.commit(1);
  // The third segment holds entries from another log: its chain does not join the one before it.
  const other = await new World().open();
  await other.commit(9, 1, "another log");
  await other.seal();
  const wrong = await other.bulk.get(other.keys.sealed(1, 9));
  expect(wrong).not.toBeNull();
  const swapped = new Proxy(w.bulk, {
    get(self, name) {
      const value = Reflect.get(self, name, self);
      if (name !== "get" || typeof value !== "function")
        return typeof value === "function" ? value.bind(self) : value;
      return async (key: string) =>
        key === w.keys.sealed(7, 9) ? wrong : await value.call(self, key);
    },
  });
  const seqs: number[] = [];
  const failure = await (async () => {
    try {
      for await (const entry of readLog({
        tier: w.tier,
        bulk: swapped,
        keys: w.keys,
        schema: 1,
        after: { seq: 0, hash: GENESIS_HASH },
      }))
        seqs.push(entry.header.seq);
      return null;
    } catch (error) {
      return error;
    }
  })();
  // What came before the damaged segment was handed over, and the damage was found when its turn came.
  expect(failure).toBeInstanceOf(EntryError);
  expect(seqs).toEqual(range(1, 6));
});

test("a listing the caller has already made is used and nothing is listed again, and one that is out of date is replaced by a fresh listing", async () => {
  const w = await new World().open();
  for (let index = 0; index < 3; index += 1) {
    await w.commit(3);
    await w.seal();
  }
  await w.commit(2);
  const listed = await listSealedSegments(w.bulk, w.keys);
  expect(listed.segments.map((item) => [item.from, item.to])).toEqual([
    [1, 3],
    [4, 6],
    [7, 9],
  ]);
  const given = await w.read();
  expect(given.result.lists).toBe(1);
  const seqs: number[] = [];
  const generator = readLog({
    tier: w.tier,
    bulk: w.bulk,
    keys: w.keys,
    schema: 1,
    after: { seq: 0, hash: GENESIS_HASH },
    segments: listed.segments,
  });
  let next = await generator.next();
  while (!next.done) {
    seqs.push(next.value.header.seq);
    next = await generator.next();
  }
  expect(seqs).toEqual(range(1, 11));
  expect(next.value.lists).toBe(0);

  // A segment in the listing that is not in the store any more (a compaction replaced it): it is looked for in a fresh listing.
  const stale = [{ key: w.keys.sealed(1, 99), from: 1, to: 99 }, ...listed.segments];
  const again: number[] = [];
  const reader = readLog({
    tier: w.tier,
    bulk: w.bulk,
    keys: w.keys,
    schema: 1,
    after: { seq: 0, hash: GENESIS_HASH },
    segments: stale,
  });
  let step = await reader.next();
  while (!step.done) {
    again.push(step.value.header.seq);
    step = await reader.next();
  }
  expect(again).toEqual(range(1, 11));
  expect(step.value.lists).toBeGreaterThanOrEqual(1);
});

test("the head a caller has just read starts the read, and the head a page of the tail came with ends it: the tail's head is not asked for again", async () => {
  const w = await new World().open();
  await w.commit(6);
  const head = await w.tier.head(BOOK);
  const counted = slowed(w.tier, ["head", "readFrom"], 0);
  const read = async (given?: typeof head) => {
    const seqs: number[] = [];
    const generator = readLog({
      tier: counted.proxy,
      bulk: w.bulk,
      keys: w.keys,
      schema: 1,
      after: { seq: 0, hash: GENESIS_HASH },
      ...(given ? { head: given } : {}),
    });
    let next = await generator.next();
    while (!next.done) {
      seqs.push(next.value.header.seq);
      next = await generator.next();
    }
    return seqs;
  };
  expect(await read(head)).toEqual(range(1, 6));
  expect(counted.stats.calls.get("head") ?? 0).toBe(0);
  expect(counted.stats.calls.get("readFrom")).toBe(1);
  counted.stats.calls.clear();
  expect(await read()).toEqual(range(1, 6));
  expect(counted.stats.calls.get("head")).toBe(1);
  expect(counted.stats.calls.get("readFrom")).toBe(1);
});

test("the first page of the tail is asked for while the sealed segments are read, and the log is the same either way", async () => {
  const w = await new World().open();
  for (let index = 0; index < 3; index += 1) {
    await w.commit(4);
    await w.seal();
  }
  await w.commit(3);
  const counted = slowed(w.tier, ["readFrom"], 5);
  const store = slowed(w.bulk, ["get"], 5);
  const seqs: number[] = [];
  const generator = readLog({
    tier: counted.proxy,
    bulk: store.proxy,
    keys: w.keys,
    schema: 1,
    after: { seq: 0, hash: GENESIS_HASH },
  });
  let next = await generator.next();
  while (!next.done) {
    seqs.push(next.value.header.seq);
    next = await generator.next();
  }
  expect(seqs).toEqual(range(1, 15));
  expect(next.value).toMatchObject({ sealedEntries: 12, tailEntries: 3, segmentsRead: 3 });
  // One page of the tail, asked for once, and not again when the segments were done.
  expect(counted.stats.calls.get("readFrom")).toBe(1);
});

test("a cold open asks for the tail's head, the snapshots and the sealed segments together, and says what it found", async () => {
  const w = await new World().open();
  for (let index = 0; index < 2; index += 1) {
    await w.commit(3);
    await w.seal();
  }
  await w.commit(2);
  const tier = slowed(w.tier, ["head"], 10);
  const store = slowed(w.bulk, ["list"], 10);
  let widest = 0;
  const watched = new Proxy(store.proxy, {
    get(self, name) {
      const value = Reflect.get(self, name, self);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        widest = Math.max(widest, tier.stats.inFlight + store.stats.inFlight + 1);
        return value.apply(self, args);
      };
    },
  });
  const found = await assertTailNotBehind({ tier: tier.proxy, bulk: watched, keys: w.keys });
  // The head was being asked for while the two listings were: three round trips at once, and not one after another.
  expect(widest).toBeGreaterThanOrEqual(3);
  expect(found.head.seq).toBe(8);
  expect(found.snapshots).toEqual([]);
  expect(found.segments.map((item) => [item.from, item.to])).toEqual([
    [1, 3],
    [4, 6],
  ]);
});

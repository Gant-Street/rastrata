import { expect, test } from "bun:test";
import { VirtualClock } from "../src/clock.ts";
import { buildEntry } from "../src/entry.ts";
import { MemoryObjectStore } from "../src/memory.ts";
import { BookKeys } from "../src/objectstore.ts";
import { Sealer, SegmentConflictError } from "../src/sealer.ts";
import { decodeSegment, encodeSegment, verifySegment } from "../src/segment.ts";
import { MemoryLogTier } from "../src/tier-memory.ts";
import { GENESIS_HASH, type LogTier } from "../src/tier.ts";

const BOOK = "b1";

function world() {
  const clock = new VirtualClock();
  const tier = new MemoryLogTier({ clock });
  const bulk = new MemoryObjectStore({ clock });
  const keys = new BookKeys("runs/t/", BOOK);
  const sealer = (
    store: MemoryObjectStore | ReturnType<MemoryObjectStore["client"]> = bulk,
    t: LogTier = tier,
  ) => new Sealer({ tier: t, bulk: store, keys, clock, backoffMs: 10 });
  return { clock, tier, bulk, keys, sealer };
}

async function commit(
  tier: MemoryLogTier,
  fence: number,
  count: number,
  from = 1,
  prev = GENESIS_HASH,
) {
  let last = prev;
  for (let seq = from; seq < from + count; seq += 1) {
    const built = buildEntry({
      bookId: BOOK,
      seq,
      prev: last,
      writer: "pod-a#1",
      fence,
      schema: 1,
      kind: "commit",
      at: "2026-10-08T00:00:00.000Z",
      payload: new TextEncoder().encode(`rows ${seq}`),
      changes: 1,
    });
    const result = await tier.append(BOOK, {
      seq,
      prevHash: last,
      hash: built.header.hash,
      fence,
      body: built.bytes,
    });
    if (!result.ok) throw new Error(`append ${seq} refused: ${result.reason}`);
    last = built.header.hash;
  }
  return last;
}

async function lease(tier: MemoryLogTier): Promise<number> {
  const granted = await tier.acquire(BOOK, "pod-a#1", 600_000);
  if (!granted.ok) throw new Error("no lease");
  return granted.lease.fence;
}

test("entries in the tail are written to the bulk store as one segment, then trimmed", async () => {
  const w = world();
  const fence = await lease(w.tier);
  const last = await commit(w.tier, fence, 5);
  const outcome = await w.sealer().sealOnce();
  expect(outcome.status).toBe("sealed");
  if (outcome.status !== "sealed") return;
  expect([outcome.from, outcome.to, outcome.trimmed, outcome.reused]).toEqual([1, 5, 5, false]);
  expect(outcome.key).toBe(w.keys.sealed(1, 5));
  const head = await w.tier.head(BOOK);
  expect(head.seq).toBe(5);
  expect(head.hash).toBe(last);
  expect(head.sealedThrough).toBe(5);
  expect(head.sealedHash).toBe(last);
  expect(w.tier.peek(BOOK).entries).toHaveLength(0);
  const stored = w.bulk.peek(outcome.key)!;
  expect(verifySegment(stored.body, BOOK, null).lastHash).toBe(last);
  expect(stored.metadata.from).toBe("1");
  expect(w.bulk.keys(w.keys.sealedPrefix)).toEqual([outcome.key]);
});

test("rounds follow each other: contiguous segments, each chained to the one before", async () => {
  const w = world();
  const fence = await lease(w.tier);
  const sealer = w.sealer();
  expect((await sealer.sealOnce()).status).toBe("nothing");
  let last = await commit(w.tier, fence, 3);
  await sealer.sealOnce();
  last = await commit(w.tier, fence, 4, 4, last);
  await sealer.sealOnce();
  last = await commit(w.tier, fence, 2, 8, last);
  await sealer.sealOnce();
  expect(w.bulk.keys(w.keys.sealedPrefix)).toEqual([
    w.keys.sealed(1, 3),
    w.keys.sealed(4, 7),
    w.keys.sealed(8, 9),
  ]);
  let previous: { seq: number; hash: string } | null = null;
  for (const key of w.bulk.keys(w.keys.sealedPrefix)) {
    const verified = verifySegment(w.bulk.peek(key)!.body, BOOK, previous);
    previous = { seq: verified.last, hash: verified.lastHash };
  }
  expect(previous?.hash).toBe(last);
  expect(sealer.stats.segments).toBe(3);
  expect((await w.tier.head(BOOK)).sealedThrough).toBe(9);
});

test("a crash between the bulk write and the trim: the next round finds the segment, reuses it and trims", async () => {
  const w = world();
  const fence = await lease(w.tier);
  await commit(w.tier, fence, 6);
  let attempts = 0;
  const flaky: LogTier = {
    ...w.tier,
    capabilities: w.tier.capabilities,
    head: (b) => w.tier.head(b),
    readFrom: (b, s, l) => w.tier.readFrom(b, s, l),
    append: (b, i) => w.tier.append(b, i),
    acquire: (b, h, t) => w.tier.acquire(b, h, t),
    renew: (b, l, t) => w.tier.renew(b, l, t),
    release: (b, l) => w.tier.release(b, l),
    seal: async (b, i) => {
      attempts += 1;
      if (attempts <= 4) throw new Error("the tail is down");
      return w.tier.seal(b, i);
    },
  };
  const crashed = await w.clock.drive(w.sealer(w.bulk, flaky).sealOnce());
  expect(crashed.status).toBe("deferred");
  expect(w.bulk.keys(w.keys.sealedPrefix)).toEqual([w.keys.sealed(1, 6)]);
  expect(w.tier.peek(BOOK).entries).toHaveLength(6);
  const resumed = await w.clock.drive(w.sealer(w.bulk, flaky).sealOnce());
  expect(resumed.status).toBe("sealed");
  if (resumed.status === "sealed") {
    expect(resumed.reused).toBe(true);
    expect(resumed.trimmed).toBe(6);
  }
  expect(w.bulk.keys(w.keys.sealedPrefix)).toHaveLength(1);
  expect(w.tier.peek(BOOK).entries).toHaveLength(0);
});

test("an outage of the bulk store: commits go on, the tail grows, and one later segment catches up", async () => {
  const w = world();
  const fence = await lease(w.tier);
  const sealer = w.sealer();
  let last = await commit(w.tier, fence, 3);
  await sealer.sealOnce();
  w.bulk.configure({ faults: { put: { failBefore: 1 } } });
  for (let round = 0; round < 3; round += 1) {
    last = await commit(w.tier, fence, 2, 4 + round * 2, last);
    const outcome = await w.clock.drive(sealer.sealOnce());
    expect(outcome.status).toBe("deferred");
    expect((await w.tier.head(BOOK)).seq - (await w.tier.head(BOOK)).sealedThrough).toBe(
      2 * (round + 1),
    );
  }
  w.bulk.configure({ faults: {} });
  const caught = await w.clock.drive(sealer.sealOnce());
  expect(caught.status).toBe("sealed");
  const head = await w.tier.head(BOOK);
  expect([head.seq, head.sealedThrough]).toEqual([9, 9]);
  expect(w.bulk.keys(w.keys.sealedPrefix)).toEqual([w.keys.sealed(1, 3), w.keys.sealed(4, 9)]);
  const second = verifySegment(w.bulk.peek(w.keys.sealed(4, 9))!.body, BOOK, {
    seq: 3,
    hash: verifySegment(w.bulk.peek(w.keys.sealed(1, 3))!.body, BOOK, null).lastHash,
  });
  expect(second.lastHash).toBe(last);
});

test("two sealers racing on the same tail write one segment and both finish", async () => {
  const w = world();
  const fence = await lease(w.tier);
  await commit(w.tier, fence, 8);
  const results = await Promise.all([w.sealer().sealOnce(), w.sealer().sealOnce()]);
  expect(results.every((result) => result.status === "sealed")).toBe(true);
  expect(results.filter((result) => result.status === "sealed" && result.reused)).toHaveLength(1);
  expect(w.bulk.keys(w.keys.sealedPrefix)).toEqual([w.keys.sealed(1, 8)]);
  expect((await w.tier.head(BOOK)).sealedThrough).toBe(8);
});

test("a segment already there with the same entries, packaged differently, is accepted", async () => {
  const w = world();
  const fence = await lease(w.tier);
  await commit(w.tier, fence, 4);
  const bodies = w.tier.peek(BOOK).entries.map((entry) => entry.body);
  // The same entries, but the object carries an extra byte of padding in its framing? No: the
  // framing is canonical. Plant the segment the sealer would write, byte for byte, with other metadata.
  w.bulk.plant(w.keys.sealed(1, 4), encodeSegment(bodies), { note: "planted" });
  const outcome = await w.sealer().sealOnce();
  expect(outcome.status).toBe("sealed");
  if (outcome.status === "sealed") expect(outcome.reused).toBe(true);
});

test("a segment at that key that holds different entries is a conflict, not something to trust", async () => {
  const w = world();
  const fence = await lease(w.tier);
  await commit(w.tier, fence, 4);
  const elsewhere = [1, 2, 3, 4].map(
    (seq) =>
      buildEntry({
        bookId: BOOK,
        seq,
        prev: GENESIS_HASH,
        writer: "intruder",
        fence: 9,
        schema: 1,
        kind: "commit",
        at: "2026-10-08T00:00:00.000Z",
        payload: new TextEncoder().encode("forged"),
        changes: 1,
      }).bytes,
  );
  w.bulk.plant(w.keys.sealed(1, 4), encodeSegment(elsewhere));
  await expect(w.sealer().sealOnce()).rejects.toBeInstanceOf(SegmentConflictError);
  expect(w.tier.peek(BOOK).entries).toHaveLength(4);
});

test("a lost answer to the segment write is settled by reading it back", async () => {
  const w = world();
  const fence = await lease(w.tier);
  await commit(w.tier, fence, 5);
  w.bulk.script([{ op: "put", fault: "failAfter", nth: 1 }]);
  w.bulk.configure({ timeoutMs: 100 });
  const outcome = await w.clock.drive(w.sealer().sealOnce());
  expect(outcome.status).toBe("sealed");
  if (outcome.status === "sealed") expect(outcome.reused).toBe(true);
  expect(w.bulk.keys(w.keys.sealedPrefix)).toHaveLength(1);
  expect(w.tier.peek(BOOK).entries).toHaveLength(0);
});

test("a sealer killed after its write landed leaves a segment the next sealer adopts", async () => {
  const w = world();
  const fence = await lease(w.tier);
  await commit(w.tier, fence, 5);
  w.bulk.script([{ op: "put", fault: "killAfter", nth: 1 }]);
  const doomed = w.sealer(w.bulk.client("sealer-1")).sealOnce();
  const state = await w.clock.drive(
    Promise.race([doomed.then(() => "answered"), w.clock.sleep(5000).then(() => "silent")]),
  );
  expect(state).toBe("silent");
  expect(w.bulk.keys(w.keys.sealedPrefix)).toEqual([w.keys.sealed(1, 5)]);
  expect(w.tier.peek(BOOK).entries).toHaveLength(5);
  const next = await w.sealer(w.bulk.client("sealer-2")).sealOnce();
  expect(next.status).toBe("sealed");
  if (next.status === "sealed") expect(next.reused).toBe(true);
  expect(w.tier.peek(BOOK).entries).toHaveLength(0);
  expect(decodeSegment(w.bulk.peek(w.keys.sealed(1, 5))!.body)).toHaveLength(5);
});

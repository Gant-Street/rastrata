import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { GENESIS_HASH, type AppendInput, type LogTier, type SealManifest } from "../../src/tier.ts";

export interface TierFixture {
  readonly tier: LogTier;
  /** Let the tier's own clock move forward (leases lapse by it). */
  advance(ms: number): Promise<void>;
  /** Whether sealing removes entries from the tier (the object-store tier has nothing to remove). */
  readonly trims: boolean;
  close?(): Promise<void> | void;
}

const text = (value: string) => new TextEncoder().encode(value);
const hashOf = (seq: number, prev: string) =>
  createHash("sha256").update(`${seq}:${prev}`).digest("hex");

export function entryAfter(
  seq: number,
  prev: string,
  fence: number,
  body = `entry ${seq}`,
): AppendInput {
  return { seq, prevHash: prev, hash: hashOf(seq, prev), fence, body: text(body) };
}

/** Appends `count` entries under `fence` and returns the last hash. */
export async function fill(
  tier: LogTier,
  book: string,
  fence: number,
  count: number,
  from = 1,
  prev = GENESIS_HASH,
): Promise<string> {
  let hash = prev;
  for (let seq = from; seq < from + count; seq += 1) {
    const input = entryAfter(seq, hash, fence);
    const result = await tier.append(book, input);
    if (!result.ok) throw new Error(`append ${seq} refused: ${result.reason}`);
    hash = input.hash;
  }
  return hash;
}

/** A well-formed hash that is no entry's: for a seal that must change nothing (one already made, one
 * behind the sealed head, one ahead of the log), whose manifest therefore cannot matter. */
const UNRELATED_HASH = "c".repeat(64);

const manifest = (from: number, to: number, lastHash: string): SealManifest => ({
  from,
  to,
  key: `sealed/${from}-${to}`,
  sha256: "0".repeat(64),
  bytes: 1,
  lastHash,
});

/** The behavior every tail must have, whatever it is built on. */
export function tierConformance(
  label: string,
  make: () => Promise<TierFixture> | TierFixture,
): void {
  describe(`${label}: the log tier contract`, () => {
    const book = () => `b-${Math.random().toString(36).slice(2, 10)}`;

    test("a new book is empty", async () => {
      const f = await make();
      const head = await f.tier.head(book());
      expect(head.seq).toBe(0);
      expect(head.hash).toBe(GENESIS_HASH);
      expect(head.sealedThrough).toBe(0);
      await f.close?.();
    });

    test("entries append in order, chained, and read back intact", async () => {
      const f = await make();
      const b = book();
      const lease = await f.tier.acquire(b, "pod-a", 10_000);
      expect(lease.ok).toBe(true);
      const fence = lease.ok ? lease.lease.fence : 0;
      const last = await fill(f.tier, b, fence, 5);
      const head = await f.tier.head(b);
      expect(head.seq).toBe(5);
      expect(head.hash).toBe(last);
      const page = await f.tier.readFrom(b, 1);
      expect(page.entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(new TextDecoder().decode(page.entries[2]?.body)).toBe("entry 3");
      expect(page.entries[3]?.prevHash).toBe(page.entries[2]?.hash);
      const from3 = await f.tier.readFrom(b, 3, 2);
      expect(from3.entries.map((entry) => entry.seq)).toEqual([3, 4]);
      await f.close?.();
    });

    test("only the next sequence, chained to the head, is accepted", async () => {
      const f = await make();
      const b = book();
      const lease = await f.tier.acquire(b, "pod-a", 10_000);
      const fence = lease.ok ? lease.lease.fence : 0;
      const first = entryAfter(1, GENESIS_HASH, fence);
      expect((await f.tier.append(b, first)).ok).toBe(true);
      const skipped = await f.tier.append(b, entryAfter(3, first.hash, fence));
      expect(skipped.ok ? "ok" : skipped.reason).toBe("seq");
      const forked = await f.tier.append(b, entryAfter(2, "f".repeat(64), fence));
      expect(forked.ok ? "ok" : forked.reason).toBe("prev");
      await f.close?.();
    });

    test("the same entry again is acknowledged without being written twice; another entry at that sequence is refused", async () => {
      const f = await make();
      const b = book();
      const lease = await f.tier.acquire(b, "pod-a", 10_000);
      const fence = lease.ok ? lease.lease.fence : 0;
      const first = entryAfter(1, GENESIS_HASH, fence);
      await f.tier.append(b, first);
      const again = await f.tier.append(b, first);
      expect(again.ok && again.duplicate).toBe(true);
      const rival = { ...entryAfter(1, GENESIS_HASH, fence, "another"), hash: "a".repeat(64) };
      const refused = await f.tier.append(b, rival);
      expect(refused.ok ? "ok" : refused.reason).toBe("seq");
      const page = await f.tier.readFrom(b, 1);
      expect(page.entries).toHaveLength(1);
      expect(new TextDecoder().decode(page.entries[0]?.body)).toBe("entry 1");
      await f.close?.();
    });

    test("sealing records the sequence and trims what the tail no longer needs to hold", async () => {
      const f = await make();
      const b = book();
      const lease = await f.tier.acquire(b, "pod-a", 10_000);
      const fence = lease.ok ? lease.lease.fence : 0;
      const last = await fill(f.tier, b, fence, 6);
      const fourth = (await f.tier.readFrom(b, 4, 1)).entries[0]?.hash ?? "";
      const sealed = await f.tier.seal(b, { upTo: 4, manifest: manifest(1, 4, fourth) });
      expect(sealed.ok).toBe(true);
      const head = await f.tier.head(b);
      expect(head.seq).toBe(6);
      expect(head.hash).toBe(last);
      if (f.trims) {
        expect(head.sealedThrough).toBe(4);
        expect(head.sealedHash).toBe(fourth);
        const page = await f.tier.readFrom(b, 1);
        expect(page.entries.map((entry) => entry.seq)).toEqual([5, 6]);
      }
      // Idempotent, and never backwards.
      const again = await f.tier.seal(b, { upTo: 4, manifest: manifest(1, 4, UNRELATED_HASH) });
      expect(again.ok).toBe(true);
      const behind = await f.tier.seal(b, { upTo: 2, manifest: manifest(1, 2, UNRELATED_HASH) });
      expect(behind.ok).toBe(true);
      if (f.trims) expect((await f.tier.head(b)).sealedThrough).toBe(4);
      const ahead = await f.tier.seal(b, { upTo: 9, manifest: manifest(1, 9, UNRELATED_HASH) });
      expect(ahead.ok).toBe(false);
      await f.close?.();
    });

    test("entries can still be appended after sealing, chained to the head", async () => {
      const f = await make();
      const b = book();
      const lease = await f.tier.acquire(b, "pod-a", 10_000);
      const fence = lease.ok ? lease.lease.fence : 0;
      const last = await fill(f.tier, b, fence, 3);
      await f.tier.seal(b, { upTo: 3, manifest: manifest(1, 3, last) });
      const next = entryAfter(4, last, fence);
      expect((await f.tier.append(b, next)).ok).toBe(true);
      const page = await f.tier.readFrom(b, 1);
      expect(page.entries.map((entry) => entry.seq)).toEqual(f.trims ? [4] : [1, 2, 3, 4]);
      await f.close?.();
    });
  });

  describe(`${label}: leases and fencing`, () => {
    const book = () => `l-${Math.random().toString(36).slice(2, 10)}`;
    test("a lease grants a fence that grows with every new holder and is exclusive while it lasts", async () => {
      const f = await make();
      if (!f.tier.capabilities.leases) return f.close?.();
      const b = book();
      const a = await f.tier.acquire(b, "pod-a", 1000);
      expect(a.ok && a.lease.fence).toBe(1);
      const other = await f.tier.acquire(b, "pod-b", 1000);
      expect(other.ok).toBe(false);
      if (!other.ok) {
        expect(other.heldBy).toBe("pod-a");
        expect(other.expiresInMs).toBeGreaterThan(0);
        expect(other.expiresInMs).toBeLessThanOrEqual(1000);
      }
      await f.advance(1100);
      const taken = await f.tier.acquire(b, "pod-b", 1000);
      expect(taken.ok && taken.lease.fence).toBe(2);
      await f.close?.();
    });

    test("the holder asking again inside its lease keeps its fence; after a lapse it gets the next one", async () => {
      const f = await make();
      if (!f.tier.capabilities.leases) return f.close?.();
      const b = book();
      const first = await f.tier.acquire(b, "pod-a", 1000);
      const again = await f.tier.acquire(b, "pod-a", 1000);
      expect(first.ok && again.ok && first.lease.fence === again.lease.fence).toBe(true);
      await f.advance(1500);
      const later = await f.tier.acquire(b, "pod-a", 1000);
      expect(later.ok && later.lease.fence).toBe(2);
      await f.close?.();
    });

    test("a renewal extends the lease on the tier's clock; after a lapse it is refused", async () => {
      const f = await make();
      if (!f.tier.capabilities.leases) return f.close?.();
      const b = book();
      const a = await f.tier.acquire(b, "pod-a", 1000);
      if (!a.ok) throw new Error("no lease");
      await f.advance(600);
      const renewed = await f.tier.renew(b, { holder: "pod-a", fence: a.lease.fence }, 1000);
      expect(renewed.ok).toBe(true);
      await f.advance(600);
      // 1,200 ms after the grant, but only 600 after the renewal: still held.
      const blocked = await f.tier.acquire(b, "pod-b", 1000);
      expect(blocked.ok).toBe(false);
      await f.advance(1000);
      const lapsed = await f.tier.renew(b, { holder: "pod-a", fence: a.lease.fence }, 1000);
      expect(lapsed.ok ? "ok" : lapsed.reason).toBe("expired");
      const b2 = await f.tier.acquire(b, "pod-b", 1000);
      expect(b2.ok).toBe(true);
      const stale = await f.tier.renew(b, { holder: "pod-a", fence: a.lease.fence }, 1000);
      expect(stale.ok ? "ok" : stale.reason).toBe("taken");
      await f.close?.();
    });

    test("an append needs the current fence: none, an old one, or a released one is refused", async () => {
      const f = await make();
      if (!f.tier.capabilities.leases) return f.close?.();
      const b = book();
      const unleased = await f.tier.append(b, entryAfter(1, GENESIS_HASH, 0));
      expect(unleased.ok ? "ok" : unleased.reason).toBe("fence");
      const a = await f.tier.acquire(b, "pod-a", 1000);
      if (!a.ok) throw new Error("no lease");
      const first = entryAfter(1, GENESIS_HASH, a.lease.fence);
      expect((await f.tier.append(b, first)).ok).toBe(true);
      await f.advance(1200);
      const taken = await f.tier.acquire(b, "pod-b", 1000);
      if (!taken.ok) throw new Error("no lease for b");
      expect(taken.lease.head.seq).toBe(1);
      expect(taken.lease.head.hash).toBe(first.hash);
      // The old holder wakes up and writes with its old fence.
      const stale = await f.tier.append(b, entryAfter(2, first.hash, a.lease.fence));
      expect(stale.ok ? "ok" : stale.reason).toBe("fence");
      expect((await f.tier.append(b, entryAfter(2, first.hash, taken.lease.fence))).ok).toBe(true);
      await f.tier.release(b, { holder: "pod-b", fence: taken.lease.fence });
      const released = await f.tier.append(
        b,
        entryAfter(3, hashOf(2, first.hash), taken.lease.fence),
      );
      expect(released.ok ? "ok" : released.reason).toBe("fence");
      await f.close?.();
    });

    test("a release frees the book at once for the next holder", async () => {
      const f = await make();
      if (!f.tier.capabilities.leases) return f.close?.();
      const b = book();
      const a = await f.tier.acquire(b, "pod-a", 60_000);
      if (!a.ok) throw new Error("no lease");
      expect((await f.tier.acquire(b, "pod-b", 1000)).ok).toBe(false);
      await f.tier.release(b, { holder: "pod-a", fence: a.lease.fence });
      const next = await f.tier.acquire(b, "pod-b", 1000);
      expect(next.ok && next.lease.fence).toBeGreaterThan(a.lease.fence);
      // Releasing a lease one no longer holds changes nothing.
      await f.tier.release(b, { holder: "pod-a", fence: a.lease.fence });
      expect((await f.tier.head(b)).leaseHolder).toBe("pod-b");
      await f.close?.();
    });

    test("the head says who holds the lease and until when, by the tier's clock", async () => {
      const f = await make();
      if (!f.tier.capabilities.leases) return f.close?.();
      const b = book();
      const a = await f.tier.acquire(b, "pod-a", 1000);
      if (!a.ok) throw new Error("no lease");
      const head = await f.tier.head(b);
      expect(head.leaseHolder).toBe("pod-a");
      expect(head.fence).toBe(a.lease.fence);
      expect((head.leaseExpiresAt ?? 0) - head.now).toBeGreaterThan(0);
      await f.advance(1500);
      const after = await f.tier.head(b);
      expect(after.leaseHolder).toBeNull();
      expect(after.fence).toBe(a.lease.fence);
      await f.close?.();
    });
  });
}

/** The operator's step that gives a tail which lost a book a head at the newest sealed entry (see
 * `LogTier.adopt`): it works on a tail that holds nothing of the book, once, and never on one that
 * holds anything; the log then goes on from there under a larger fence. */
export async function checkRestoration(
  tier: LogTier,
  suffix = Math.random().toString(36).slice(2, 10),
): Promise<void> {
  const lost = `lost-${suffix}`;
  const kept = `kept-${suffix}`;
  if (!tier.adopt) throw new Error("this tail has no restoration step");
  const adopt = tier.adopt.bind(tier);
  const state = { seq: 7, hash: "a".repeat(64), fence: 1002 };
  const done = await adopt(lost, state);
  if (!done.ok) throw new Error("the empty book was not given a head");
  const head = await tier.head(lost);
  if (
    head.seq !== 7 ||
    head.sealedThrough !== 7 ||
    head.hash !== state.hash ||
    head.sealedHash !== state.hash ||
    head.fence !== 1002
  )
    throw new Error(`the head is not the restored one: ${JSON.stringify(head)}`);
  // Not twice, and not over a head that was restored.
  const again = await adopt(lost, { ...state, seq: 9 });
  if (again.ok || again.reason !== "not_empty") throw new Error("a restored head was overwritten");
  if ((await tier.head(lost)).seq !== 7) throw new Error("a refused restoration changed the head");
  // The next holder has a larger fence, and the entry after the restored one chains to it.
  const lease = await tier.acquire(lost, "pod", 60_000);
  if (!lease.ok) throw new Error("no lease on the restored book");
  if (lease.lease.fence <= 1002)
    throw new Error("the new holder's fence is not above the restored one");
  const next = await tier.append(lost, entryAfter(8, state.hash, lease.lease.fence));
  if (!next.ok) throw new Error(`the entry after the restored head was refused: ${next.reason}`);
  // A book that has an entry here is not lost, and is never overwritten.
  const other = await tier.acquire(kept, "pod", 60_000);
  if (!other.ok) throw new Error("no lease");
  const first = await tier.append(kept, entryAfter(1, GENESIS_HASH, other.lease.fence));
  if (!first.ok) throw new Error("the first entry was refused");
  const refused = await adopt(kept, state);
  if (refused.ok) throw new Error("a book with an entry was given a restored head");
  if ((await tier.head(kept)).seq !== 1) throw new Error("a refused restoration changed the book");
}

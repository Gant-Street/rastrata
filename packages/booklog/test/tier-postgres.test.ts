import { SQL } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { PostgresLogTier } from "../src/tier-postgres.ts";
import { GENESIS_HASH, type LogTier } from "../src/tier.ts";
import { checkRestoration, entryAfter, fill, tierConformance } from "./support/tier-conformance.ts";

/** Runs only when a Postgres is named, for example the throwaway container
 *   docker run -d --name booklog-pg -e POSTGRES_PASSWORD=booklog -e POSTGRES_DB=booklog -p 55432:5432 postgres:17
 *   BOOKLOG_PG_URL=postgres://postgres:booklog@127.0.0.1:55432/booklog bun test test/tier-postgres.test.ts
 * A lease lasts a fraction of the time the contract suite names, so the suite does not sit
 * waiting for real seconds; the tier's own clock is the database's. */
const url = process.env.BOOKLOG_PG_URL;
const SCALE = 0.3;

/** The tier with every duration shrunk, so a contract written in seconds runs in a fraction. */
function shrunk(tier: PostgresLogTier): LogTier {
  return {
    capabilities: tier.capabilities,
    head: (book) => tier.head(book),
    readFrom: (book, seq, limit) => tier.readFrom(book, seq, limit),
    append: (book, input) => tier.append(book, input),
    acquire: (book, holder, ttl) => tier.acquire(book, holder, ttl * SCALE),
    renew: (book, lease, ttl) => tier.renew(book, lease, ttl * SCALE),
    release: (book, lease) => tier.release(book, lease),
    seal: (book, input) => tier.seal(book, input),
  };
}

if (!url) {
  test.skip("PostgresLogTier: set BOOKLOG_PG_URL to run it against a Postgres", () => {});
} else {
  const shared = await PostgresLogTier.connect(url, { max: 8 });
  afterAll(async () => {
    await shared.close();
  });

  tierConformance("PostgresLogTier", () => ({
    tier: shrunk(shared),
    trims: true,
    advance: async (ms) => {
      await Bun.sleep(ms * SCALE);
    },
  }));

  describe("PostgresLogTier: atomicity under concurrency", () => {
    const book = () => `pg-${Math.random().toString(36).slice(2, 10)}`;

    test("a tail that lost a book is given a head at the newest sealed entry, once", async () => {
      await checkRestoration(shared);
    });

    test("an empty head left by a lease taken and given back is restored over; a live lease is not", async () => {
      const b = book();
      const lease = await shared.acquire(b, "pod-a", 60_000);
      if (!lease.ok) throw new Error("no lease");
      const state = { seq: 5, hash: "b".repeat(64), fence: 1002 };
      // Held: refused.
      expect((await shared.adopt(b, state)).ok).toBe(false);
      await shared.release(b, { holder: "pod-a", fence: lease.lease.fence });
      // Given back, with nothing written: the head is empty and may be restored.
      expect((await shared.adopt(b, state)).ok).toBe(true);
      expect((await shared.head(b)).seq).toBe(5);
    });

    test("processes starting together make the tables without racing each other", async () => {
      // A database of its own, so that the tables really are not there when they all start.
      const admin = new SQL(url, { max: 1 });
      const name = `booklog_race_${Math.random().toString(36).slice(2, 10)}`;
      await admin.unsafe(`CREATE DATABASE ${name}`);
      try {
        const target = new URL(url);
        target.pathname = `/${name}`;
        const started = await Promise.allSettled(
          Array.from({ length: 12 }, () => PostgresLogTier.connect(target.href, { max: 1 })),
        );
        expect(started.filter((item) => item.status === "rejected")).toEqual([]);
        for (const item of started) if (item.status === "fulfilled") await item.value.close();
      } finally {
        await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
        await admin.close();
      }
    });

    test("of many appends for the same sequence exactly one lands", async () => {
      const b = book();
      const lease = await shared.acquire(b, "pod-a", 60_000);
      if (!lease.ok) throw new Error("no lease");
      const fence = lease.lease.fence;
      const last = await fill(shared, b, fence, 3);
      const rivals = Array.from({ length: 24 }, (_, index) => ({
        ...entryAfter(4, last, fence, `rival ${index}`),
        hash: index.toString(16).padStart(64, "0"),
      }));
      const results = await Promise.all(rivals.map((input) => shared.append(b, input)));
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok && result.reason === "seq")).toHaveLength(23);
      const head = await shared.head(b);
      expect(head.seq).toBe(4);
      const page = await shared.readFrom(b, 1);
      expect(page.entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
      expect(page.entries[3]?.hash).toBe(head.hash);
    });

    test("of many holders asking at once exactly one gets the lease", async () => {
      const b = book();
      const results = await Promise.all(
        Array.from({ length: 16 }, (_, index) => shared.acquire(b, `pod-${index}`, 5000)),
      );
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      const winner = results.find((result) => result.ok);
      expect(winner?.ok && winner.lease.fence).toBe(1);
      expect((await shared.head(b)).fence).toBe(1);
    });

    test("an append and a new holder racing: the old fence never lands after the new one is granted", async () => {
      for (let round = 0; round < 20; round += 1) {
        const b = book();
        const old = await shared.acquire(b, "pod-a", 60_000);
        if (!old.ok) throw new Error("no lease");
        await shared.release(b, { holder: "pod-a", fence: old.lease.fence });
        const [append, taken] = await Promise.all([
          shared.append(b, entryAfter(1, GENESIS_HASH, old.lease.fence)),
          shared.acquire(b, "pod-b", 60_000),
        ]);
        // The release already moved the token on, so the old fence cannot land at all.
        expect(append.ok).toBe(false);
        expect(taken.ok).toBe(true);
      }
    });

    test("a seal and an append at the same time lose nothing", async () => {
      const b = book();
      const lease = await shared.acquire(b, "pod-a", 60_000);
      if (!lease.ok) throw new Error("no lease");
      const fence = lease.lease.fence;
      const last = await fill(shared, b, fence, 10);
      const next = entryAfter(11, last, fence);
      const manifest = {
        from: 1,
        to: 10,
        key: "k",
        sha256: "0".repeat(64),
        bytes: 1,
        lastHash: last,
      };
      const [sealed, appended] = await Promise.all([
        shared.seal(b, { upTo: 10, manifest }),
        shared.append(b, next),
      ]);
      expect(sealed.ok).toBe(true);
      expect(appended.ok).toBe(true);
      const head = await shared.head(b);
      expect([head.seq, head.sealedThrough]).toEqual([11, 10]);
      const page = await shared.readFrom(b, 1);
      expect(page.entries.map((entry) => entry.seq)).toEqual([11]);
    });
  });
}

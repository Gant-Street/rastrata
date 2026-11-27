import { expect, test } from "bun:test";
import { VirtualClock } from "../src/clock.ts";
import { MemoryLogTier } from "../src/tier-memory.ts";
import { DurableObjectLogTier, fakeDurableObjectFetch } from "../src/tier-durable.ts";
import { BookDeletedError, GENESIS_HASH, type LogTier } from "../src/tier.ts";
import { fill } from "./support/tier-conformance.ts";

// A book that was deleted: the tail keeps a mark (the tail Worker's tombstone, tested in apps/tail-worker), and every call for it, of any kind, is told so. The memory tier is
// the reference and the durable tier the client of the Worker; both are held to the same words here.

const ops = (tier: LogTier, book: string): Record<string, () => Promise<unknown>> => ({
  head: () => tier.head(book),
  readFrom: () => tier.readFrom(book, 1),
  append: () =>
    tier.append(book, {
      seq: 1,
      prevHash: GENESIS_HASH,
      hash: "a".repeat(64),
      fence: 1,
      body: new Uint8Array([1]),
    }),
  acquire: () => tier.acquire(book, "holder", 5000),
  renew: () => tier.renew(book, { holder: "holder", fence: 1 }, 5000),
  release: () => tier.release(book, { holder: "holder", fence: 1 }),
  seal: () =>
    tier.seal(book, {
      upTo: 1,
      manifest: { upTo: 1, lastHash: "a".repeat(64), objectKey: "k", bytes: 1 } as never,
    }),
});

async function expectDeleted(tier: LogTier, book: string) {
  for (const [name, call] of Object.entries(ops(tier, book))) {
    const error = await call().then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(error, name).toBeInstanceOf(BookDeletedError);
    // The error names no book: a log line that carried it would carry a customer's identifier.
    expect((error as Error).message, name).toBe("the book was deleted");
  }
}

test("a deleted book answers nothing: every call is told it was deleted, another book is unaffected, and deleting again changes nothing", async () => {
  const clock = new VirtualClock();
  const tier = new MemoryLogTier({ clock });
  const lease = await tier.acquire("gone", "holder", 5000);
  expect(lease.ok).toBe(true);
  await fill(tier, "gone", 1, 3);
  await tier.acquire("kept", "holder", 5000);
  await fill(tier, "kept", 1, 2);

  expect(tier.destroy("gone")).toEqual({ alreadyDeleted: false });
  await expectDeleted(tier, "gone");
  expect(tier.destroy("gone")).toEqual({ alreadyDeleted: true });
  await expectDeleted(tier, "gone");
  // The other book is as it was.
  expect((await tier.head("kept")).seq).toBe(2);
  // A book that never existed can be deleted too, and is then as deleted as any (nothing makes it again).
  expect(tier.destroy("never-was")).toEqual({ alreadyDeleted: false });
  await expectDeleted(tier, "never-was");
});

test("over the wire the same: the tail Worker's 410 is the same error, for every operation", async () => {
  const clock = new VirtualClock();
  const core = new MemoryLogTier({ clock });
  const tier = new DurableObjectLogTier({
    baseUrl: "https://tail.invalid",
    token: "secret",
    fetch: fakeDurableObjectFetch({ core, token: "secret" }),
  });
  await tier.acquire("gone", "holder", 5000);
  await fill(tier, "gone", 1, 2);
  core.destroy("gone");
  await expectDeleted(tier, "gone");
});

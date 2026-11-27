import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeDurableBook } from "@rastrata/kernel";
import { LocalBookService } from "../src/local.ts";
import { BULK_BOOK, postBulk } from "./support/bulk-book.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0).reverse()) work();
});

function directory() {
  const path = mkdtempSync(join(tmpdir(), "rastrata-read-model-"));
  cleanup.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
async function open(path: string, setup = false) {
  const service = await LocalBookService.open(path);
  if (setup) await service.setup(BULK_BOOK);
  let closed = false;
  const close = () => {
    if (!closed) service.close();
    closed = true;
  };
  cleanup.push(close);
  return Object.assign(service, { shut: close });
}
const encoded = async (service: LocalBookService, verify?: "full") =>
  encodeDurableBook((await service.readAggregate(undefined, verify ? { verify } : {})).aggregate);

test("incremental reads equal a full replay while posting and reading interleave", async () => {
  const service = await open(join(directory(), "book.sqlite"), true);
  await postBulk(service, 30);
  const first = await encoded(service);
  await postBulk(service, 5);
  const second = await encoded(service);
  await postBulk(service, 1);
  expect(service.readStats.full).toBe(1);
  expect(service.readStats.incremental).toBeGreaterThanOrEqual(2);
  const incremental = await encoded(service);
  expect(first).not.toBe(second);
  expect(incremental).toBe(await encoded(service, "full"));
});

test("concurrent reads share one replay", async () => {
  const service = await open(join(directory(), "book.sqlite"), true);
  await postBulk(service, 40);
  const reads = await Promise.all(Array.from({ length: 6 }, () => service.readAggregate()));
  const states = reads.map((read) => encodeDurableBook(read.aggregate));
  expect(new Set(states).size).toBe(1);
  // Setup, the activation outcome and 40 journals are each verified exactly once.
  expect(service.readStats.verified).toBe(
    (await service.outcomePage()).observedTip.sequence === "0"
      ? 0
      : Number((await service.outcomePage()).observedTip.sequence),
  );
});

test("a restart replays only the outcomes after the saved snapshot", async () => {
  const path = join(directory(), "book.sqlite");
  const first = await open(path, true);
  await postBulk(first, 120);
  const before = await encoded(first);
  expect(first.readStats.snapshotsWritten).toBe(1);
  await postBulk(first, 25);
  const expected = await encoded(first);
  first.shut();
  const second = await open(path);
  expect(await encoded(second)).toBe(expected);
  expect(before).not.toBe(expected);
  expect(second.readStats.snapshot).toBe(1);
  expect(second.readStats.full).toBe(0);
  // The snapshot written on close held the first 120; only the newer outcomes were verified.
  expect(second.readStats.verified).toBeLessThanOrEqual(26);
  expect(await encoded(second, "full")).toBe(expected);
});

test("a snapshot from another book is refused by the ledger and the read falls back", async () => {
  const root = directory();
  const real = join(root, "real.sqlite");
  const other = join(root, "other.sqlite");
  const a = await open(real, true);
  await postBulk(a, 120);
  const truth = await encoded(a);
  a.shut();
  const b = await open(other, true);
  await postBulk(b, 130);
  await encoded(b);
  b.shut();
  // Put the other book's snapshot into this book's database, as a restore or swap might.
  const donor = new Database(other, { readonly: true });
  const stolen = donor.query("SELECT * FROM app_read_snapshots WHERE id=1").get() as Record<
    string,
    string
  >;
  donor.close();
  const target = new Database(real);
  target
    .query(
      "INSERT OR REPLACE INTO app_read_snapshots (id, sequence, head, book_revision, encoded, content_hash) VALUES (1, ?, ?, ?, ?, ?)",
    )
    .run(
      stolen.sequence as string,
      stolen.head as string,
      stolen.book_revision as string,
      stolen.encoded as string,
      stolen.content_hash as string,
    );
  target.close();
  const service = await open(real);
  expect(await encoded(service)).toBe(truth);
  expect(service.readStats.full).toBe(1);
  expect(service.readStats.snapshot).toBe(0);
});

test("a corrupted snapshot is ignored", async () => {
  const path = join(directory(), "book.sqlite");
  const first = await open(path, true);
  await postBulk(first, 120);
  const truth = await encoded(first);
  first.shut();
  const db = new Database(path);
  db.query(
    "UPDATE app_read_snapshots SET encoded = substr(encoded, 1, 200) || 'x' || substr(encoded, 202)",
  ).run();
  db.close();
  const service = await open(path);
  expect(await encoded(service)).toBe(truth);
  expect(service.readStats.full).toBe(1);
  expect(service.readStats.snapshot).toBe(0);
});

test("a second service on the same file sees what the first one posts", async () => {
  const path = join(directory(), "book.sqlite");
  const writer = await open(path, true);
  await postBulk(writer, 10);
  const reader = await open(path);
  expect((await reader.readAggregate()).aggregate.state.journals.length).toBe(10);
  await postBulk(writer, 5);
  const verifiedBefore = reader.readStats.verified;
  expect((await reader.readAggregate()).aggregate.state.journals.length).toBe(15);
  expect(reader.readStats.verified - verifiedBefore).toBe(5);
  expect(reader.readStats.full).toBe(1);
});

test("a read pinned to an earlier revision returns that state and leaves the view at the tip", async () => {
  const service = await open(join(directory(), "book.sqlite"), true);
  await postBulk(service, 10);
  const middle = (await service.readAggregate()).aggregate;
  await postBulk(service, 10);
  await service.readAggregate();
  const pinned = await service.readAggregate(middle.state.bookRevision);
  expect(encodeDurableBook(pinned.aggregate)).toBe(encodeDurableBook(middle));
  const incrementalBefore = service.readStats.incremental;
  await postBulk(service, 1);
  expect((await service.readAggregate()).aggregate.state.journals.length).toBe(21);
  expect(service.readStats.incremental).toBeGreaterThan(incrementalBefore);
  await expect(service.readAggregate(9_999_999n)).rejects.toThrow();
});

test("a full read detects a tampered old outcome that an incremental read does not look at", async () => {
  const path = join(directory(), "book.sqlite");
  const service = await open(path, true);
  await postBulk(service, 12);
  await service.readAggregate();
  const db = new Database(path);
  // Damage the stored bytes of an early outcome directly in the database.
  db.query(
    "UPDATE ledger_native_outcomes SET body = substr(body, 1, 100) || 'X' || substr(body, 102) WHERE sequence = 3",
  ).run();
  db.close();
  // Incremental reads trust the verified prefix and only look at what is new: by design.
  await expect(service.readAggregate()).resolves.toBeDefined();
  // A full replay re-reads every outcome from the ledger and refuses the damaged one.
  await expect(service.readAggregate(undefined, { verify: "full" })).rejects.toThrow();
});

test("a copied database continues to work and verifies from its own snapshot", async () => {
  const root = directory();
  const path = join(root, "book.sqlite");
  const service = await open(path, true);
  await postBulk(service, 110);
  const truth = await encoded(service);
  service.shut();
  const copy = join(root, "copy.sqlite");
  copyFileSync(path, copy);
  const restored = await open(copy);
  expect(await encoded(restored)).toBe(truth);
  expect(restored.readStats.snapshot).toBe(1);
});

test("a book too large to snapshot is still read, and never fails a read for it", async () => {
  const service = await open(join(directory(), "book.sqlite"), true);
  // The kernel throws RangeError("Durable aggregate exceeds the byte limit") for a book above 16 MiB.
  let attempts = 0;
  (service as unknown as { saveSnapshot: () => void }).saveSnapshot = () => {
    attempts += 1;
    throw new RangeError("Durable aggregate exceeds the byte limit");
  };
  await postBulk(service, 120);
  await service.readAggregate();
  await postBulk(service, 120);
  const head = (await service.readAggregate()).head;
  expect(head.sequence).toBe("241");
  expect(attempts).toBe(1);
  expect(service.readStats.snapshotsWritten).toBe(0);
  // Reads keep working, and still verify what is new.
  await postBulk(service, 2);
  expect((await service.readAggregate()).aggregate.state.journals.length).toBe(242);
});

test("a long replay hands the thread back often, so other requests are not kept waiting", async () => {
  const service = await open(join(directory(), "book.sqlite"), true);
  await postBulk(service, 300);
  // A watcher takes a turn of the event loop whenever the replay lets it; a replay that held the
  // thread for a whole page of the ledger (16 outcomes) would give it about twenty turns.
  let turns = 0;
  let running = true;
  const watch = () => {
    turns += 1;
    if (running) setImmediate(watch);
  };
  setImmediate(watch);
  await service.readAggregate(undefined, { verify: "full" });
  running = false;
  expect(turns).toBeGreaterThan(40);
}, 180_000);

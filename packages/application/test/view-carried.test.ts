// A pod that catches up with what another pod wrote opens a new service on its database (the book log tells the application when the database moved under it). That service used to read the whole
// book from its first entry, 0.7 to 1 ms for every journal, however little had changed. It can begin from the verified state of the one before: the ledger vouches for where the new entries continue
// from it, and a head that is not on its chain is refused and the read starts from the first entry as it always did.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBookService } from "../src/local.ts";
import type { VerifiedView } from "../src/service.ts";
import { BULK_BOOK, postBulk } from "./support/bulk-book.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0).reverse()) work();
});

async function written(journals: number): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-view-carried-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "book.sqlite");
  const writer = await LocalBookService.open(path, { snapshots: false });
  await writer.setup(BULK_BOOK);
  await postBulk(writer, journals);
  writer.close();
  return path;
}

async function opened(path: string, view?: VerifiedView | null): Promise<LocalBookService> {
  const service = await LocalBookService.open(path, {
    snapshots: false,
    ...(view ? { view } : {}),
  });
  let closed = false;
  const close = service.close.bind(service);
  service.close = () => {
    if (!closed) close();
    closed = true;
  };
  cleanup.push(() => service.close());
  return service;
}

test("a service made after the book moved on begins from the verified state of the one before, and reads only what is new", async () => {
  const path = await written(60);
  const before = await opened(path);
  await before.readAggregate();
  expect(before.readStats).toMatchObject({ full: 1, incremental: 0, verified: 61 });
  const view = before.verifiedView();
  expect(view).not.toBeNull();

  // Another process writes three journals to the book.
  const other = await opened(path);
  await postBulk(other, 3);
  other.close();

  // What a pod does on catching up: a new service on the database, given the verified state of the old.
  const after = await opened(path, view);
  const carried = (await after.readAggregate()).aggregate;
  expect(after.readStats).toMatchObject({ full: 0, incremental: 1, verified: 3 });

  // It is the book a read from the first entry gives, in everything the book says.
  const fresh = await opened(path);
  const whole = (await fresh.readAggregate()).aggregate;
  expect(fresh.readStats).toMatchObject({ full: 1, verified: 64 });
  expect(carried.state).toEqual(whole.state);
  expect(carried.protocol).toEqual(whole.protocol);
  expect(carried.state.contentHash).toEqual(whole.state.contentHash);
});

test("a state that is not on the chain of the ledger it is given is refused, and the read starts from the first entry", async () => {
  const mine = await written(30);
  const theirs = await written(45);
  const service = await opened(mine);
  await service.readAggregate();
  // Another book, longer: its head is not on this one's chain.
  const stranger = await opened(theirs);
  await stranger.readAggregate();
  const wrong = await opened(mine, stranger.verifiedView());
  const read = (await wrong.readAggregate()).aggregate;
  expect(wrong.readStats).toMatchObject({ full: 1, incremental: 0 });
  const fresh = await opened(mine);
  expect(read.state.contentHash).toEqual((await fresh.readAggregate()).aggregate.state.contentHash);
  // A state ahead of the ledger (the book was rolled back to before it) is refused the same way.
  const ahead = await opened(mine, stranger.verifiedView());
  await ahead.readAggregate();
  expect(ahead.readStats.full).toBe(1);
});

test("a service with no view, or a view of null, reads from the first entry as it always did", async () => {
  const path = await written(20);
  const none = await opened(path);
  await none.readAggregate();
  expect(none.readStats).toMatchObject({ full: 1, incremental: 0 });
  const nothing = await opened(path, null);
  await nothing.readAggregate();
  expect(nothing.readStats).toMatchObject({ full: 1, incremental: 0 });
  // A service that has not read yet has no state to give.
  const unread = await opened(path);
  expect(unread.verifiedView()).toBeNull();
});

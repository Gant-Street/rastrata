// The whole read's policy by itself (apps/api/src/whole-read.ts): which open is followed by a read of the book's log from its first entry, what a failure
// does the first time and the second, and what is never taken for the book's own trouble. The same against a real server and a damaged log is in
// hosted-many.test.ts.
import { expect, test } from "bun:test";
import {
  BookKeys,
  EntryError,
  LogGapError,
  ObjectStoreError,
  BookUnderReviewError,
  reviewCount,
} from "@rastrata/booklog";
import { MemoryLogTier, MemoryObjectStore } from "@rastrata/booklog/testing";
import { WholeReads } from "../src/whole-read.ts";

const BOOK = "tenant-aaaa";
const keys = (id: string) => new BookKeys("", id);

function reads() {
  const bulk = new MemoryObjectStore();
  const lines: string[] = [];
  const whole = new WholeReads({
    tier: new MemoryLogTier(),
    schema: 1,
    pause: async () => {},
    bulk,
    keys,
    build: "pod test",
    log: (line) => lines.push(line),
    now: () => new Date("2026-11-19T12:00:00.000Z"),
  });
  return { bulk, lines, whole };
}

const broken = () => new EntryError("chain", "Entry 41 is not chained to entry 40");

test("the first open of a book that a process makes is followed by a read of its log from the first entry, and the opens after it are not", async () => {
  const { whole, lines } = reads();
  expect(whole.first(BOOK)).toBe(true);
  // Until an open has answered it is still the first: the next try is the first too.
  expect(whole.first(BOOK)).toBe(true);
  whole.opened(BOOK);
  expect(whole.first(BOOK)).toBe(false);
  // Another book is its own first time.
  expect(whole.first("tenant-bbbb")).toBe(true);
  await whole.settled();
  // (This book's log is empty here: the walk itself is tried against a real server in hosted-many.test.ts.)
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain(
    `whole read: every link of ${BOOK} holds (0 entries read in the background`,
  );
});

test("a log that does not hold is read once more, and stopped the second time it fails the same way", async () => {
  const { whole, bulk, lines } = reads();
  const first = broken();
  expect(await whole.failed(BOOK, first)).toBe(first);
  expect(await reviewCount(bulk, keys(BOOK))).toBe(0);
  // Still the first open: the next one tries again, from nothing.
  expect(whole.first(BOOK)).toBe(true);
  const second = await whole.failed(BOOK, broken());
  expect(second).toBeInstanceOf(BookUnderReviewError);
  expect(await reviewCount(bulk, keys(BOOK))).toBe(1);
  const [stored] = (await bulk.list(keys(BOOK).reviewPrefix, undefined, 10)).objects;
  const record = JSON.parse(
    new TextDecoder().decode((await bulk.get(stored?.key ?? ""))?.body ?? new Uint8Array()),
  );
  expect(record).toEqual({
    kind: "chain_break",
    seq: 41,
    expected: null,
    found: null,
    check: "chain",
    verifier: "pod test",
    at: "2026-11-19T12:00:00.000Z",
  });
  expect(lines.filter((line) => line.includes("is read once more")).length).toBe(1);
  expect(lines.filter((line) => line.includes("is not served until")).length).toBe(1);
});

test("two failures that are not the same failure stop nothing: each is read once more", async () => {
  const { whole, bulk } = reads();
  await whole.failed(BOOK, broken());
  const gap = new LogGapError(7, "it is in no segment and not in the tail");
  expect(await whole.failed(BOOK, gap)).toBe(gap);
  expect(await reviewCount(bulk, keys(BOOK))).toBe(0);
  // And a good read in between forgets the failure before it.
  await whole.failed(BOOK, broken());
  whole.opened(BOOK);
  await whole.settled();
  expect(await reviewCount(bulk, keys(BOOK))).toBe(0);
});

test("trouble that is not the book's is never a finding, however often it comes", async () => {
  const { whole, bulk, lines } = reads();
  for (const error of [
    new ObjectStoreError("the bucket did not answer", 503),
    Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }),
    new EntryError("schema", "Entry 3 was written by a newer build"),
    new Error("something nobody expected"),
  ]) {
    expect(await whole.failed(BOOK, error)).toBe(error);
    expect(await whole.failed(BOOK, error)).toBe(error);
  }
  expect(await reviewCount(bulk, keys(BOOK))).toBe(0);
  expect(lines).toEqual([]);
});

test("a stop that cannot be written leaves the failure as it was, to be tried again", async () => {
  const { whole, bulk, lines } = reads();
  const refusing = bulk as unknown as { putIfAbsent: unknown };
  refusing.putIfAbsent = async () => {
    throw new ObjectStoreError("the bucket did not answer", 503);
  };
  await whole.failed(BOOK, broken());
  const again = broken();
  expect(await whole.failed(BOOK, again)).toBe(again);
  expect(lines.at(-1)).toContain("the stop could not be written");
});

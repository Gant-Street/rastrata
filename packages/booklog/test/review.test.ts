// A book that failed its verification is not served until an operator has cleared it (src/review.ts): the finding is a small object under the book's own prefix, written create-only, and a pod looks for one
// before it opens the book.
import { expect, test } from "bun:test";
import { hostedFailure } from "../src/hosted.ts";
import { MemoryObjectStore } from "../src/memory.ts";
import { BookKeys } from "../src/objectstore.ts";
import {
  assertNotUnderReview,
  BookUnderReviewError,
  readReviews,
  recordReview,
  reviewCount,
  type ReviewRecord,
} from "../src/review.ts";

const finding = (over: Partial<ReviewRecord> = {}): ReviewRecord => ({
  kind: "chain_break",
  seq: 41,
  expected: "a".repeat(64),
  found: "b".repeat(64),
  check: null,
  verifier: "test-build",
  at: "2026-10-15T12:00:00.000Z",
  ...over,
});

test("the keys of a book's findings are numbered, under its own prefix, and a key that is not one is not read as one", () => {
  const keys = new BookKeys("runs/x/", "book-1");
  expect(keys.reviewPrefix).toBe("runs/x/books/book-1/review/");
  expect(keys.review(7)).toBe("runs/x/books/book-1/review/000000000007.json");
  expect(keys.numberOfReview(keys.review(7))).toBe(7);
  for (const other of [
    "runs/x/books/book-1/review/7.json",
    "runs/x/books/book-1/review/000000000007.jsonx",
    "runs/x/books/book-1/log/000000000007",
    "runs/x/books/book-2/review/000000000007.json",
    "review/000000000007.json",
  ])
    expect(keys.numberOfReview(other), other).toBeNull();
});

test("a book with no finding is opened, one with a finding is refused, and another book is not affected", async () => {
  const bulk = new MemoryObjectStore();
  const mine = new BookKeys("", "book-1");
  const other = new BookKeys("", "book-2");
  await assertNotUnderReview(bulk, mine);
  expect(await reviewCount(bulk, mine)).toBe(0);
  expect(await recordReview(bulk, mine, finding())).toBe(1);
  await expect(assertNotUnderReview(bulk, mine)).rejects.toBeInstanceOf(BookUnderReviewError);
  await assertNotUnderReview(bulk, other);
  // The refusal says what is true and names the pod's identifier, nothing of the customer.
  const refused = (await assertNotUnderReview(bulk, mine).then(
    () => null,
    (error: unknown) => error,
  )) as Error;
  expect(refused.message).toContain("book-1");
  const answered = hostedFailure(refused);
  expect(answered).toMatchObject({ code: "book_under_review", status: 423, retryable: false });
});

test("findings are numbered in order, are never overwritten, and two found at once leave two", async () => {
  const bulk = new MemoryObjectStore();
  const keys = new BookKeys("", "book-1");
  const first = await recordReview(bulk, keys, finding({ seq: 10 }));
  const second = await recordReview(bulk, keys, finding({ kind: "replay_failed", seq: 20 }));
  expect([first, second]).toEqual([1, 2]);
  // Two verifiers that look at the same moment and want the same number: one gets it, the other the next.
  const both = await Promise.all([
    recordReview(bulk, keys, finding({ seq: 31 })),
    recordReview(bulk, keys, finding({ seq: 32 })),
  ]);
  expect([...both].sort()).toEqual([3, 4]);
  const read = await readReviews(bulk, keys);
  expect(read.map((entry) => entry.number)).toEqual([1, 2, 3, 4]);
  expect(read[1]).toMatchObject({ kind: "replay_failed", seq: 20, verifier: "test-build" });
  // A finding holds hashes and numbers, and nothing else about the book.
  expect(Object.keys(read[0] as object).sort()).toEqual(
    ["at", "check", "expected", "found", "kind", "number", "seq", "verifier"].sort(),
  );
});

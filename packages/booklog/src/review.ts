/** A book that failed its verification is not served until a person has looked at it. The verifier (apps/api, `verify-books.ts`) writes what it found as a small object under the book's own prefix, through the
 * same gateway as the rest of the book (create-only, like everything the protocol writes); a pod looks for one before it opens a book, and a book with one is refused (`423 book_under_review`): nothing
 * is read, no lease is taken and no entry is written, so a bad history is not extended and a book that may be wrong is not shown as right. Nothing here removes one: the gateway has no route that deletes, so
 * clearing a book is an operator's step in the bucket (docs/reference/program/hosting/verifier.md). A review names a kind of failure, the entry it was found at, the hashes involved, the verifier's build
 * and the time, and nothing of what the book holds: no amount, no name. */
import { type BookKeys, MAX_LIST, type ObjectStore } from "./objectstore.ts";

/** Why a book was stopped. `chain_break`: the stored entries do not link, or a snapshot or a segment does not match its log. `replay_failed`: the ledger replays to a result other than the one
 * it recorded, or cannot be replayed. `integrity`: SQLite or the ledger's own checks fail on the rebuilt file. `snapshot_mismatch`: a snapshot the pod would open differs from the log it claims
 * to be a copy of. `unreadable`: the book could not be read at all, which is its own finding (a missing segment is a gap in the history). */
export type ReviewKind =
  | "chain_break"
  | "replay_failed"
  | "integrity"
  | "snapshot_mismatch"
  | "unreadable";

export interface ReviewRecord {
  readonly kind: ReviewKind;
  /** The entry the finding is about, or 0 when it is about the book as a whole. */
  readonly seq: number;
  /** What the check expected and what it found, as hashes, when the finding is about one. */
  readonly expected: string | null;
  readonly found: string | null;
  /** The name of the check that failed, or of the table that differs: a word of the verifier's, never a value from the book. */
  readonly check: string | null;
  /** Which build of the verifier made the finding. */
  readonly verifier: string;
  /** An ISO 8601 time. */
  readonly at: string;
}

/** The book is under review: it is not opened, and a request for it is refused. Nothing was done for the request. It names no customer: the identifier is the pod's own. */
export class BookUnderReviewError extends Error {
  constructor(readonly bookId: string) {
    super(`The book ${bookId} is under review and is not served until an operator has cleared it`);
    this.name = "BookUnderReviewError";
  }
}

/** How many findings the book has. The newest is not looked for: any one stops the book. */
export async function reviewCount(bulk: ObjectStore, keys: BookKeys): Promise<number> {
  const page = await bulk.list(keys.reviewPrefix, undefined, MAX_LIST);
  return page.objects.filter((item) => keys.numberOfReview(item.key) !== null).length;
}

/** Refuse a book that has a finding. Called before a book is opened. */
export async function assertNotUnderReview(bulk: ObjectStore, keys: BookKeys): Promise<void> {
  const page = await bulk.list(keys.reviewPrefix, undefined, 1);
  if (page.objects.some((item) => keys.numberOfReview(item.key) !== null))
    throw new BookUnderReviewError(keys.bookId);
}

/** Record a finding: the next number the book does not have, created only if absent, so that two verifiers that find something at once leave two findings and not one overwritten. Returns the number. */
export async function recordReview(
  bulk: ObjectStore,
  keys: BookKeys,
  record: ReviewRecord,
): Promise<number> {
  const body = new TextEncoder().encode(JSON.stringify(record));
  const page = await bulk.list(keys.reviewPrefix, undefined, MAX_LIST);
  let next =
    1 +
    page.objects.reduce(
      (highest, item) => Math.max(highest, keys.numberOfReview(item.key) ?? 0),
      0,
    );
  for (let attempt = 0; attempt < 20; attempt += 1, next += 1) {
    const made = await bulk.putIfAbsent(keys.review(next), body, {
      contentType: "application/json",
    });
    if (made.created) return next;
  }
  throw new Error("The finding could not be recorded: the numbers kept being taken");
}

/** The findings of a book, oldest first (for the operator's tool and for tests). */
export async function readReviews(
  bulk: ObjectStore,
  keys: BookKeys,
): Promise<readonly (ReviewRecord & { readonly number: number })[]> {
  const page = await bulk.list(keys.reviewPrefix, undefined, MAX_LIST);
  const found: (ReviewRecord & { readonly number: number })[] = [];
  for (const item of page.objects) {
    const number = keys.numberOfReview(item.key);
    if (number === null) continue;
    const stored = await bulk.get(item.key);
    if (stored)
      found.push({
        ...(JSON.parse(new TextDecoder().decode(stored.body)) as ReviewRecord),
        number,
      });
  }
  return found.sort((a, b) => a.number - b.number);
}

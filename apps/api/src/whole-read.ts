/** The whole read: the first time a process opens a book, as soon as the open has answered, it reads the book's log from its first entry in the background and checks every link on the way. Nothing is rebuilt:
 * every entry's framing, hash and link to the one before is checked, and what it carries against its digest, which waits on nobody (the entries are read in turns, and the requests that are waiting come first).
 *
 * Why. A pod that starts from a snapshot never reads what came before the snapshot, so a sealed segment damaged in storage, or a segment that is missing, could go unseen for as long as the snapshot is good.
 * Every release starts new processes, so with this every book that is used is read whole at least once a release, by the code that serves it. It is the part of the scheduled verifier (verify-books.ts,
 * docs/reference/program/hosting/verifier.md) that replaying the ledger does not already do, with no schedule, no second program and nothing added to the platform.
 *
 * What it does not do. It does not rebuild the book from the log, so a snapshot that is not what its log makes is found by nobody here: that is the scheduled verifier's, which is not scheduled. (It used to be,
 * for a book of up to 10,000 entries: the first open of a process rebuilt the book from its first entry before it answered anyone, about 0.09 ms an entry here and a download of every segment, which was
 * most of the first second of a visit after a release. A book of more than 10,000 entries was always opened the usual way and read in the background, and now every book is.)
 * The snapshot is still bound to the log by the digest an entry of the log announces, and the pod executes the ledger of the book again behind its first answer (`ApplicationService.verifyBehind`).
 *
 * When. Damage is found after the book has answered, not before: the book is served until the read has found it, and then stopped. The rest of the first minute of a book does not wait for it.
 *
 * What a failure does. Trouble that is not the book's (the store did not answer, the disk is full) is not a finding: the next time this process opens the book it reads it again. A failure that is the log's (an
 * entry that does not link, a hole) is read once more; if it fails the same way at the same entry, the book is stopped as the verifier stops one (a review under the book, `423 book_under_review` from then on,
 * cleared by a person): a history that does not hold is not served any more and not added to. A hole is looked at again after a wait first, as the verifier does: a book that is being written while it is read can
 * seem to have one. An open that fails because of the log (a tail that does not link to the snapshot) is read once more by the next request's open in the same way (`failed`). */
import {
  type BookKeys,
  BookUnderReviewError,
  GENESIS_HASH,
  LogGapError,
  type LogTier,
  payloadOf,
  type ObjectStore,
  readLog,
  recordReview,
  reviewCount,
  TailBehindBulkError,
} from "@rastrata/booklog";
import type { ReviewKind } from "@rastrata/booklog";
import { logFinding } from "./verify-books.ts";

/** The process is stopping: a background read ends where it is. */
class Stopping extends Error {}

/** Write the stop for a book: a review under it, which every pod refuses the book for (`423 book_under_review`) until a person has cleared it. Nothing is written when the book has one already. False when
 * it could not be written (the store did not answer): nothing is lost, and the next finding tries again. */
export async function stopBook(
  at: {
    readonly bulk: ObjectStore;
    readonly keys: BookKeys;
    readonly build: string;
    readonly now?: () => Date;
  },
  finding: { readonly kind: ReviewKind; readonly seq: number; readonly check: string },
): Promise<boolean> {
  try {
    if ((await reviewCount(at.bulk, at.keys)) === 0)
      await recordReview(at.bulk, at.keys, {
        kind: finding.kind,
        seq: finding.seq,
        expected: null,
        found: null,
        check: finding.check,
        verifier: at.build,
        at: (at.now?.() ?? new Date()).toISOString(),
      });
    return true;
  } catch {
    return false;
  }
}

export interface WholeReadsOptions {
  readonly tier: LogTier;
  /** The highest schema version this process understands. */
  readonly schema: number;
  readonly bulk: ObjectStore;
  readonly keys: (bookId: string) => BookKeys;
  /** Which build made a finding, for the review. */
  readonly build: string;
  readonly log: (line: string) => void;
  readonly now?: () => Date;
  /** Whether the process is stopping: a background read does not go on. */
  readonly stopping?: () => boolean;
  /** How to wait before a hole is looked at again (tests pass one that does not wait). */
  readonly pause?: (ms: number) => Promise<void>;
}

/** How many times a hole in a log that is being written is looked at again, after waits of one, two and four seconds, before it is believed. */
const LOOKS = 3;

/** One for a process. It remembers which books this process has read whole, and the last failure of each that has not. */
export class WholeReads {
  readonly #options: WholeReadsOptions;
  readonly #done = new Set<string>();
  readonly #failed = new Map<string, string>();
  /** The background reads, one after another. */
  #background: Promise<void> = Promise.resolve();

  constructor(options: WholeReadsOptions) {
    this.#options = options;
  }

  /** Whether this is the first open of the book that this process has made: the one after which the log is read. */
  first(bookId: string): boolean {
    return !this.#done.has(bookId);
  }

  /** The first open of the book came back with the book: its log is read from the first entry, behind the first answer. */
  opened(bookId: string): void {
    this.#done.add(bookId);
    this.#failed.delete(bookId);
    this.#background = this.#background.then(() => this.#links(bookId)).catch(() => {});
  }

  /** The background reads that have been asked for, done (tests wait for it). */
  settled(): Promise<void> {
    return this.#background;
  }

  /** Every entry of the book's log from the first, with nothing rebuilt: its framing, its hash, its link to the one before and what it carries against its digest. Gives back how many, or throws what the log threw. */
  async #walk(bookId: string): Promise<number> {
    let entries = 0;
    for await (const entry of readLog({
      tier: this.#options.tier,
      bulk: this.#options.bulk,
      keys: this.#options.keys(bookId),
      schema: this.#options.schema,
      after: { seq: 0, hash: GENESIS_HASH },
    })) {
      // The reader has checked the entry's header, its hash and its link; what the entry carries is checked against its digest here,
      // which a reader that applies it would do on the way.
      payloadOf(entry.bytes);
      entries += 1;
      // The requests that are waiting come first.
      if (entries % 256 === 0) {
        if (this.#options.stopping?.()) throw new Stopping();
        await new Promise<void>((turn) => setImmediate(turn));
      }
    }
    return entries;
  }

  /** The background read of a book's log, and what comes of it. */
  async #links(bookId: string): Promise<void> {
    const pause =
      this.#options.pause ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
    const started = performance.now();
    let seen: string | null = null;
    for (let look = 0; ; look += 1) {
      try {
        const entries = await this.#walk(bookId);
        this.#options.log(
          `whole read: every link of ${bookId} holds (${entries} entries read in the background in ${Math.round(performance.now() - started)} ms)`,
        );
        return;
      } catch (error) {
        if (error instanceof Stopping) return;
        const finding = logFinding(error);
        if (finding === null) {
          // Not the book's trouble: the next process, or the next time this one is asked, reads it.
          this.#done.delete(bookId);
          return;
        }
        // A book that is written while it is read can seem to have a hole: looked at again, after a wait that doubles.
        const hole = error instanceof LogGapError || error instanceof TailBehindBulkError;
        if (hole && look < LOOKS) {
          await pause(1000 * 2 ** look);
          continue;
        }
        const now = `${finding.kind}:${finding.seq}:${finding.check}`;
        if (seen !== now) {
          seen = now;
          this.#options.log(
            `whole read: ${bookId} failed in the background (${finding.kind} at entry ${finding.seq}, ${finding.check}); it is read once more before the book is stopped`,
          );
          continue;
        }
        await this.#stop(bookId, finding);
        return;
      }
    }
  }

  /** Write the stop. True when the book now has one. */
  async #stop(
    bookId: string,
    finding: { readonly kind: ReviewKind; readonly seq: number; readonly check: string },
  ): Promise<boolean> {
    const written = await stopBook(
      {
        bulk: this.#options.bulk,
        keys: this.#options.keys(bookId),
        build: this.#options.build,
        ...(this.#options.now ? { now: this.#options.now } : {}),
      },
      finding,
    );
    if (!written) {
      // The stop could not be written: nothing is lost, and the next reading tries again.
      this.#options.log(
        `whole read: ${bookId} failed twice the same way and the stop could not be written`,
      );
      return false;
    }
    this.#options.log(
      `whole read: ${bookId} is stopped (${finding.kind} at entry ${finding.seq}, ${finding.check}, read twice); it is not served until a person has cleared it`,
    );
    return true;
  }

  /** The first open of the book failed. Gives back what to throw: the failure itself, or, the second time the log fails the same
   * way, that the book is under review. */
  async failed(bookId: string, error: unknown): Promise<unknown> {
    const finding = logFinding(error);
    if (finding === null) return error;
    const seen = `${finding.kind}:${finding.seq}:${finding.check}`;
    if (this.#failed.get(bookId) !== seen) {
      this.#failed.set(bookId, seen);
      this.#options.log(
        `whole read: ${bookId} failed (${finding.kind} at entry ${finding.seq}, ${finding.check}); it is read once more before the book is stopped`,
      );
      return error;
    }
    if (!(await this.#stop(bookId, finding))) return error;
    this.#failed.delete(bookId);
    return new BookUnderReviewError(bookId);
  }
}

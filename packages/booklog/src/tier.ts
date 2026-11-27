/** The tail: where a book's newest entries live and where a commit becomes durable.
 *
 * A tier is a small, strongly consistent, fast service (Postgres, a Durable Object) that keeps, per
 * book, the entries not yet sealed into the object store, and one head record. It does four jobs
 * atomically at its own clock:
 *   - append an entry, only if it is exactly the next one, chained to the previous hash, written under
 *     the book's current fencing token;
 *   - grant a lease: while one process holds it, nobody else can append, so that process serves reads
 *     from its cache with no remote call; every new holder gets a larger fencing token;
 *   - read entries from a sequence;
 *   - record that entries up to a sequence now live in a sealed segment in the object store, and trim.
 *
 * The object store itself can be a degenerate tier (create-only objects, no lease, so reads need a
 * freshness check): `capabilities.leases` says which. The protocol above a tier does not change. */

export const GENESIS_HASH = "0".repeat(64);

/** The tail says the book was deleted (HTTP 410 from the tail Worker, which keeps a mark for ever): nothing more is read or written for it, and nothing makes it again. It is not
 * a failure to try again, and it names no book (a log line that carried it would carry a customer's identifier). */
export class BookDeletedError extends Error {
  constructor() {
    super("the book was deleted");
    this.name = "BookDeletedError";
  }
}

export interface TierCapabilities {
  readonly name: string;
  /** False: there is no lease, every read must ask the tier whether the cache is current. */
  readonly leases: boolean;
}

export interface TierHead {
  /** The latest appended sequence; 0 before the first entry. */
  readonly seq: number;
  /** Hash of the latest entry; {@link GENESIS_HASH} before the first. */
  readonly hash: string;
  /** Entries 1..sealedThrough live in sealed segments in the object store and are trimmed here. */
  readonly sealedThrough: number;
  /** Hash of entry `sealedThrough` ({@link GENESIS_HASH} when nothing is sealed): the anchor the
   * first entry still in the tail must chain to. */
  readonly sealedHash: string;
  /** The current fencing token; 0 until someone has held the lease. */
  readonly fence: number;
  readonly leaseHolder: string | null;
  /** In the tier's own clock (milliseconds); only the tier may compare it with "now". */
  readonly leaseExpiresAt: number | null;
  /** The tier's clock when this answer was made. */
  readonly now: number;
}

export interface TailEntry {
  readonly seq: number;
  readonly prevHash: string;
  readonly hash: string;
  readonly fence: number;
  /** The encoded entry (header and payload), opaque to the tier. */
  readonly body: Uint8Array;
  readonly writtenAt: number;
}

export interface AppendInput {
  readonly seq: number;
  readonly prevHash: string;
  readonly hash: string;
  readonly fence: number;
  readonly body: Uint8Array;
}

/** Why an append was refused:
 *  - fence: the caller's token is not the current one (it lost the lease, or never held it);
 *  - seq:   not the next sequence (someone else appended, or the caller is ahead of the tier);
 *  - prev:  the next sequence, but the previous hash is not the head's (a diverged cache). */
export type AppendRefusal = "fence" | "seq" | "prev";

export type AppendResult =
  | {
      readonly ok: true;
      readonly head: TierHead;
      /** This exact entry was already the head (an earlier attempt landed): same answer, nothing written. */
      readonly duplicate: boolean;
    }
  | { readonly ok: false; readonly reason: AppendRefusal; readonly head: TierHead };

export interface LeaseGrant {
  readonly holder: string;
  readonly fence: number;
  readonly ttlMs: number;
  /** In the tier's clock. */
  readonly expiresAt: number;
  /** The head at the moment of the grant: nothing can be appended by anyone else until it lapses. */
  readonly head: TierHead;
}

export type AcquireResult =
  | { readonly ok: true; readonly lease: LeaseGrant }
  | {
      readonly ok: false;
      readonly heldBy: string;
      readonly expiresInMs: number;
      readonly head: TierHead;
    };

export type RenewResult =
  | { readonly ok: true; readonly lease: LeaseGrant }
  /** expired: the lease lapsed on the tier's clock before the renewal arrived; taken: someone else holds it now. */
  | { readonly ok: false; readonly reason: "expired" | "taken"; readonly head: TierHead };

/** What a sealed segment in the object store holds, recorded with the trim. */
export interface SealManifest {
  readonly from: number;
  readonly to: number;
  readonly key: string;
  readonly sha256: string;
  readonly bytes: number;
  /** Hash of entry `to`. */
  readonly lastHash: string;
}

export type SealResult =
  | { readonly ok: true; readonly head: TierHead; readonly trimmed: number }
  /** The tier does not have entries that far: the caller's idea of the head is wrong. */
  | { readonly ok: false; readonly reason: "ahead"; readonly head: TierHead };

/** What a tail needs to start again from the bulk store after it lost its state: the newest sealed
 * entry, and the highest fence of the log through it. */
export interface AdoptState {
  readonly seq: number;
  readonly hash: string;
  readonly fence: number;
}

export type AdoptResult =
  | { readonly ok: true; readonly head: TierHead }
  /** The tail holds something of the book (an entry, a sealed range, a lease): it is not lost, and is not overwritten. */
  | { readonly ok: false; readonly reason: "not_empty"; readonly head: TierHead };

export interface TierPage {
  readonly entries: readonly TailEntry[];
  /** The head when the page was read; its `sealedThrough` says where the tail starts. */
  readonly head: TierHead;
}

export interface LogTier {
  readonly capabilities: TierCapabilities;
  head(book: string): Promise<TierHead>;
  /** Entries with sequence at least `seq` (and above `sealedThrough`), in order, at most `limit`. */
  readFrom(book: string, seq: number, limit?: number): Promise<TierPage>;
  append(book: string, input: AppendInput): Promise<AppendResult>;
  /** A new holder gets a new, larger fence. The same holder asking while its lease is valid keeps it. */
  acquire(book: string, holder: string, ttlMs: number): Promise<AcquireResult>;
  renew(
    book: string,
    lease: { readonly holder: string; readonly fence: number },
    ttlMs: number,
  ): Promise<RenewResult>;
  /** Give the lease up early; the fence stays, the next holder gets the next one. */
  release(book: string, lease: { readonly holder: string; readonly fence: number }): Promise<void>;
  /** Record that entries up to `upTo` are in the sealed segment `manifest` (already written and
   * verified by the caller) and drop them from the tail. Idempotent; never moves backwards. */
  seal(
    book: string,
    input: { readonly upTo: number; readonly manifest: SealManifest },
  ): Promise<SealResult>;
  /** An operator's step, not an operation a pod uses: give a tail that lost a book's state a head at
   * `state` (the newest sealed entry in the bulk store) with those entries counted as sealed and the
   * fence kept, so that the log goes on from there. Only a tail that holds nothing of the book (no entry,
   * nothing sealed, no live lease) may be given one. A tail that keeps the book itself (in the bulk
   * store) cannot lose it this way and has no such step. */
  adopt?(book: string, state: AdoptState): Promise<AdoptResult>;
}

export const emptyHead = (now: number): TierHead => ({
  seq: 0,
  hash: GENESIS_HASH,
  sealedThrough: 0,
  sealedHash: GENESIS_HASH,
  fence: 0,
  leaseHolder: null,
  leaseExpiresAt: null,
  now,
});

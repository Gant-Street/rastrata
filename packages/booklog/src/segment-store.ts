import { systemClock, type Clock } from "./clock.ts";
import { sha256 } from "./entry.ts";
import { ObjectStoreUncertain, type ObjectStore } from "./objectstore.ts";
import { segmentIdentity } from "./segment.ts";

export class SegmentConflictError extends Error {
  constructor(key: string) {
    super(`The sealed segment ${key} exists and holds different entries from the ones expected`);
    this.name = "SegmentConflictError";
  }
}

/** Two packagings of the same entries are the same segment. */
export function sameEntries(left: Uint8Array, right: Uint8Array): boolean {
  try {
    const a = segmentIdentity(left);
    const b = segmentIdentity(right);
    return a.length === b.length && a.every((hash, index) => hash === b[index]);
  } catch {
    return false;
  }
}

export interface WriteSegmentOptions {
  readonly bulk: ObjectStore;
  readonly clock?: Clock;
  /** Tries per operation before giving up (default 4), with doubling waits from `backoffMs`. */
  readonly attempts?: number;
  readonly backoffMs?: number;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Put a segment in the bulk store create-only and make sure what is there is right: written by this
 * call, or already there from an earlier attempt or another writer, with the same entries. A lost
 * answer is settled by reading the object, never by assuming; the result is only given once the
 * object has been read back. Returns null when the store would not confirm it within the tries
 * (nothing is then known to be wrong; try again later), throws {@link SegmentConflictError} when
 * something else is stored at that key. */
export async function writeSegmentVerified(
  options: WriteSegmentOptions,
  key: string,
  bytes: Uint8Array,
): Promise<{ reused: boolean } | null> {
  const { bulk } = options;
  const clock = options.clock ?? systemClock;
  const attempts = options.attempts ?? 4;
  const backoff = options.backoffMs ?? 100;
  const digest = sha256(bytes);
  const ours = (body: Uint8Array): boolean => sha256(body) === digest || sameEntries(body, bytes);
  let reused = false;
  let confirmed = false;

  for (let attempt = 1; attempt <= attempts && !confirmed; attempt += 1) {
    try {
      const result = await bulk.putIfAbsent(key, bytes, {
        metadata: { sha256: digest, ...options.metadata },
      });
      if (result.created) confirmed = true;
      else {
        // It exists: an earlier attempt, or another writer. It must hold these very entries.
        const existing = await bulk.get(key);
        if (existing) {
          if (!ours(existing.body)) throw new SegmentConflictError(key);
          reused = true;
          confirmed = true;
        }
      }
    } catch (error) {
      if (error instanceof SegmentConflictError) throw error;
      if (!(error instanceof ObjectStoreUncertain)) throw error;
      // The write may have landed: look before writing again.
      try {
        const existing = await bulk.get(key);
        if (existing) {
          if (!ours(existing.body)) throw new SegmentConflictError(key);
          reused = true;
          confirmed = true;
        }
      } catch (inner) {
        if (inner instanceof SegmentConflictError) throw inner;
      }
    }
    if (!confirmed && attempt < attempts) await clock.sleep(backoff * 2 ** (attempt - 1));
  }
  if (!confirmed) return null;

  // Verified by reading it back: the bytes in the bulk store are the bytes (or the entries) we hold.
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const back = await bulk.get(key);
      if (back) {
        if (!ours(back.body)) throw new SegmentConflictError(key);
        return { reused };
      }
    } catch (error) {
      if (!(error instanceof ObjectStoreUncertain)) throw error;
    }
    if (attempt < attempts) await clock.sleep(backoff * 2 ** (attempt - 1));
  }
  return null;
}

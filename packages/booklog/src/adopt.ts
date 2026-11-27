import { parseEntry } from "./entry.ts";
import { MAX_LIST, type BookKeys, type ObjectStore } from "./objectstore.ts";
import { decodeSegment } from "./segment.ts";
import { listSnapshotSeqs } from "./snapshot.ts";
import type { LogTier } from "./tier.ts";

/** How far the fence is raised above the newest sealed entry's. The entries the tail lost may have
 * been written under higher fences by tenures the bulk store never saw, and a pod of one of them may
 * still be alive: the new holder's fence must not be one that pod could be holding. */
const FENCE_MARGIN = 1000;

export class AdoptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdoptError";
  }
}

export interface AdoptOptions {
  readonly tier: LogTier;
  readonly bulk: ObjectStore;
  readonly keys: BookKeys;
  /** Delete the snapshots that are of entries after the newest sealed one. They describe a history the
   * bulk store does not have the entries of (the window the tail held and lost), and a book is not
   * served while a snapshot stands ahead of its log. Without this, such a snapshot stops the restore. */
  readonly deleteOrphanSnapshots?: boolean;
}

export interface AdoptOutcome {
  /** The newest sealed entry, which is now the tail's head. */
  readonly seq: number;
  readonly hash: string;
  readonly fence: number;
  readonly segments: number;
  readonly deletedSnapshots: readonly number[];
}

/** Restore a tail that lost a book from the bulk store, which keeps every sealed entry: the tail is
 * given a head at the newest sealed entry, those entries counted as sealed, and the fence of the log
 * so far, and the log goes on from there. What only the tail held (at most the last seal window of
 * acknowledged writes) is gone, and this says nothing of it. It refuses, and changes nothing, unless
 * the tail holds nothing of the book, the sealed segments cover entries 1 through the newest without a
 * gap, and no snapshot stands ahead of them (or `deleteOrphanSnapshots` is set, and then they are
 * deleted once the tail has its head). Run again after the tail was restored, it only deletes. Every
 * pod of the book must be stopped first: a pod that survived the loss would write under a fence the
 * restored tail may grant again, which the raised fence makes unlikely and nothing makes impossible. */
export async function adoptFromBulk(options: AdoptOptions): Promise<AdoptOutcome> {
  const { tier, bulk, keys } = options;
  const adopt = tier.adopt?.bind(tier);
  if (!adopt)
    throw new AdoptError(
      "This tail keeps the book itself and cannot lose it: there is nothing to restore",
    );

  const ranges: { key: string; from: number; to: number }[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await bulk.list(keys.sealedPrefix, after, MAX_LIST);
    for (const item of page.objects) {
      const range = keys.rangeOfSealed(item.key);
      if (range) ranges.push({ key: item.key, ...range });
    }
    if (!page.truncated) break;
    after = page.objects[page.objects.length - 1]?.key;
  }
  if (ranges.length === 0)
    throw new AdoptError(
      "The bulk store holds no sealed segment of the book to restore the tail from",
    );
  ranges.sort((a, b) => a.from - b.from || b.to - a.to);
  // Every entry from the first through the newest is in some segment, with no gap.
  let covered = 0;
  for (const range of ranges) {
    if (range.from > covered + 1)
      throw new AdoptError(
        `The sealed segments leave a gap after entry ${covered} (the next starts at ${range.from}): the log cannot be restored`,
      );
    covered = Math.max(covered, range.to);
  }
  const newest = ranges.reduce((best, range) => (range.to > best.to ? range : best));
  const object = await bulk.get(newest.key);
  if (!object) throw new AdoptError(`The segment ${newest.key} is listed and cannot be read`);
  const last = decodeSegment(object.body).at(-1);
  if (!last) throw new AdoptError(`The segment ${newest.key} holds no entries`);
  const header = parseEntry(last).header;
  if (header.seq !== newest.to || header.bookId !== keys.bookId)
    throw new AdoptError(`The segment ${newest.key} does not end where its name says`);

  const orphans = (await listSnapshotSeqs(bulk, keys)).filter((seq) => seq > header.seq);
  if (orphans.length > 0 && !options.deleteOrphanSnapshots)
    throw new AdoptError(
      `The bulk store holds snapshots of entries after the newest sealed one (${orphans.join(", ")}): they describe history the log does not have. Restore with deleteOrphanSnapshots to delete them and go on from entry ${header.seq}`,
    );

  const head = await tier.head(keys.bookId);
  const restored =
    head.seq === header.seq && head.sealedThrough === header.seq && head.hash === header.hash;
  if (!restored) {
    if (head.seq !== 0 || head.sealedThrough !== 0)
      throw new AdoptError(
        `The tail still has the book (entry ${head.seq}, sealed through ${head.sealedThrough}): nothing to restore`,
      );
    const result = await adopt(keys.bookId, {
      seq: header.seq,
      hash: header.hash,
      fence: header.fence + FENCE_MARGIN,
    });
    if (!result.ok)
      throw new AdoptError(
        "The tail holds something of the book after all (a lease, an entry): not restored",
      );
  }
  // The head is in place first: what is deleted below is only ever what the restored log does not reach.
  for (const seq of orphans) {
    await bulk.delete(keys.snapshot(seq));
    await bulk.delete(keys.manifest(seq));
  }
  return {
    seq: header.seq,
    hash: header.hash,
    fence: header.fence + FENCE_MARGIN,
    segments: ranges.length,
    deletedSnapshots: orphans,
  };
}

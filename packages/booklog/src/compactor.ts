import { systemClock, type Clock } from "./clock.ts";
import { parseEntry } from "./entry.ts";
import { MAX_LIST, type BookKeys, type ObjectStore } from "./objectstore.ts";
import { decodeSegment, encodeSegment } from "./segment.ts";
import { SegmentConflictError, writeSegmentVerified } from "./segment-store.ts";

export type CompactOutcome =
  | { readonly status: "nothing" }
  | {
      readonly status: "compacted";
      readonly from: number;
      readonly to: number;
      readonly key: string;
      readonly sources: readonly string[];
      readonly deleted: number;
      readonly bytes: number;
      readonly reused: boolean;
    }
  | { readonly status: "deferred"; readonly reason: string };

export interface CompactOptions {
  readonly bulk: ObjectStore;
  readonly keys: BookKeys;
  /** Merge a run of at least this many consecutive segments (default 4). */
  readonly minSegments?: number;
  /** Do not build a segment of more than this many entries (default 20,000). */
  readonly maxEntries?: number;
  /** Only segments that end at or before this sequence (a recent snapshot's, so readers who
   * start from it never need the small ones). */
  readonly upTo?: number;
  /** Remove the merged segments afterwards (default true). The entries live on in the new one. */
  readonly deleteSources?: boolean;
  readonly clock?: Clock;
  readonly attempts?: number;
  readonly backoffMs?: number;
}

interface Ref {
  readonly key: string;
  readonly from: number;
  readonly to: number;
}

/** Merge the oldest run of small sealed segments into one. The new segment is written create-only and
 * read back before anything is removed, and a segment is removed only when the new one holds all of
 * its entries, so a crash at any point leaves either the old segments, both, or the new one: a
 * reader finds every entry in each case. Repeating it is harmless. */
export async function compactOnce(options: CompactOptions): Promise<CompactOutcome> {
  const { bulk, keys } = options;
  const clock = options.clock ?? systemClock;
  const minSegments = options.minSegments ?? 4;
  const maxEntries = options.maxEntries ?? 20_000;

  const found: Ref[] = [];
  try {
    let after: string | undefined;
    for (;;) {
      const page = await bulk.list(keys.sealedPrefix, after, MAX_LIST);
      for (const item of page.objects) {
        const range = keys.rangeOfSealed(item.key);
        if (range && (options.upTo === undefined || range.to <= options.upTo))
          found.push({ key: item.key, ...range });
      }
      if (!page.truncated) break;
      after = page.objects[page.objects.length - 1]?.key;
    }
  } catch (error) {
    return { status: "deferred", reason: `the segments could not be listed: ${describe(error)}` };
  }

  // The chain of segments that covers the log from its first entry, preferring the longest one
  // where several reach the same place. A segment inside another is not part of the chain.
  const chain: Ref[] = [];
  let reached = 0;
  for (;;) {
    let pick: Ref | undefined;
    for (const item of found)
      if (item.from <= reached + 1 && item.to > reached && (!pick || item.to > pick.to))
        pick = item;
    if (!pick) break;
    chain.push(pick);
    reached = pick.to;
  }
  let run: Ref[] = [];
  for (let start = 0; start + minSegments <= chain.length; start += 1) {
    const candidate: Ref[] = [];
    let entries = 0;
    for (let index = start; index < chain.length; index += 1) {
      const ref = chain[index] as Ref;
      const size = ref.to - ref.from + 1;
      if (entries + size > maxEntries) break;
      candidate.push(ref);
      entries += size;
    }
    if (candidate.length >= minSegments) {
      run = candidate;
      break;
    }
  }
  if (run.length < minSegments) return { status: "nothing" };

  const first = run[0] as Ref;
  const last = run[run.length - 1] as Ref;
  const entries: Uint8Array[] = [];
  let previous: { seq: number; hash: string } | null = null;
  try {
    for (const ref of run) {
      const object = await bulk.get(ref.key);
      if (!object)
        return { status: "deferred", reason: `${ref.key} was listed and then not found` };
      for (const bytes of decodeSegment(object.body)) {
        const { header } = parseEntry(bytes);
        if (previous && header.seq <= previous.seq) continue; // overlap with the neighbour
        if (previous && (header.seq !== previous.seq + 1 || header.prev !== previous.hash))
          return { status: "deferred", reason: `${ref.key} does not chain at entry ${header.seq}` };
        entries.push(bytes);
        previous = { seq: header.seq, hash: header.hash };
      }
    }
  } catch (error) {
    return { status: "deferred", reason: `the segments could not be read: ${describe(error)}` };
  }
  const merged = encodeSegment(entries);
  const key = keys.sealed(first.from, last.to);
  let stored: { reused: boolean } | null;
  try {
    stored = await writeSegmentVerified(
      {
        bulk,
        clock,
        ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
        ...(options.backoffMs !== undefined ? { backoffMs: options.backoffMs } : {}),
        metadata: { from: String(first.from), to: String(last.to), compacted: "yes" },
      },
      key,
      merged,
    );
  } catch (error) {
    if (error instanceof SegmentConflictError) throw error;
    return {
      status: "deferred",
      reason: `the merged segment could not be written: ${describe(error)}`,
    };
  }
  if (!stored)
    return { status: "deferred", reason: "the bulk store did not confirm the merged segment" };

  let deleted = 0;
  if (options.deleteSources !== false)
    for (const ref of run) {
      if (ref.key === key) continue;
      try {
        await bulk.delete(ref.key);
        deleted += 1;
      } catch {
        // Left for the next round: a segment inside a bigger one costs nothing.
      }
    }
  return {
    status: "compacted",
    from: first.from,
    to: last.to,
    key,
    sources: run.map((ref) => ref.key),
    deleted,
    bytes: merged.byteLength,
    reused: stored.reused,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

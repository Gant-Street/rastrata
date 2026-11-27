import { span } from "@rastrata/telemetry";
import { EntryError, checkLink, checkSchema, parseEntry, type EntryHeader } from "./entry.ts";
import { MAX_LIST, type BookKeys, type ObjectStore } from "./objectstore.ts";
import { decodeSegment } from "./segment.ts";
import { GENESIS_HASH, type LogTier, type TierHead, type TierPage } from "./tier.ts";

/** A hole in the log: entries that should exist, according to the tail's own record of what it has
 * sealed, are in neither the tail nor any sealed segment. The book must not be served; this is
 * data loss or an object store that has not caught up, and the caller decides which by asking again. */
export class LogGapError extends Error {
  readonly missing: number;
  constructor(missing: number, detail: string) {
    super(`The log is missing entry ${missing}: ${detail}`);
    this.name = "LogGapError";
    this.missing = missing;
  }
}

export interface LogEntry {
  readonly header: EntryHeader;
  readonly bytes: Uint8Array;
  readonly source: "sealed" | "tail";
}

export interface ReadLogResult {
  /** The last entry yielded, or the position given if there was none. */
  readonly head: { readonly seq: number; readonly hash: string };
  readonly sealedEntries: number;
  readonly tailEntries: number;
  readonly segmentsRead: number;
  readonly lists: number;
}

export interface ReadLogOptions {
  readonly tier: LogTier;
  readonly bulk: ObjectStore;
  readonly keys: BookKeys;
  /** The highest schema version this process understands; a newer entry is refused. */
  readonly schema: number;
  /** Where to start: the entry a snapshot covers through, or `{ seq: 0, hash: GENESIS_HASH }`. */
  readonly after: { readonly seq: number; readonly hash: string };
  /** How many times to look again for a segment that was listed and then found gone (a compaction
   * replacing it) before calling it a gap (default 3). */
  readonly retries?: number;
  readonly pageSize?: number;
  /** The sealed segments as a caller has just listed them (`listSealedSegments`), so that the first look for one does not list again. A segment that is then found gone is still looked for in a fresh listing. */
  readonly segments?: readonly SegmentRef[];
  /** The tail's head as a caller has just read it, so that the first look does not ask again. */
  readonly head?: TierHead;
}

export interface SegmentRef {
  readonly key: string;
  readonly from: number;
  readonly to: number;
}

/** The sealed segments in the bulk store, in the order the log is read: by where they begin, the longer of two that begin at the same entry first. `lists` is how many pages it took. */
export async function listSealedSegments(
  bulk: ObjectStore,
  keys: BookKeys,
): Promise<{ readonly segments: SegmentRef[]; readonly lists: number }> {
  const found: SegmentRef[] = [];
  let lists = 0;
  let after: string | undefined;
  for (;;) {
    const page = await bulk.list(keys.sealedPrefix, after, MAX_LIST);
    lists += 1;
    for (const item of page.objects) {
      const range = keys.rangeOfSealed(item.key);
      if (range) found.push({ key: item.key, ...range });
    }
    if (!page.truncated) break;
    after = page.objects[page.objects.length - 1]?.key;
  }
  return { segments: found.sort((a, b) => a.from - b.from || b.to - a.to), lists };
}

/** How many sealed segments after the one being read are asked for at once: their round trips to the store overlap with the reading of this one. */
const SEGMENTS_AHEAD = 4;

/** Every entry after a position, in order, verified link by link: first from the sealed segments in
 * the bulk store (only if the tail has trimmed them), then from the tail. It is a generator so a
 * long log is applied as it streams and never held whole. Compaction may replace a segment while it
 * is being read; a segment that vanishes is looked for again in a fresh listing before it counts
 * as missing. */
export async function* readLog(
  options: ReadLogOptions,
): AsyncGenerator<LogEntry, ReadLogResult, void> {
  const { tier, bulk, keys } = options;
  const book = keys.bookId;
  const retries = options.retries ?? 3;
  const pageSize = options.pageSize ?? 1000;
  let previous: { seq: number; hash: string } | null =
    options.after.seq === 0 ? null : { seq: options.after.seq, hash: options.after.hash };
  let next = options.after.seq + 1;
  const result = { sealedEntries: 0, tailEntries: 0, segmentsRead: 0, lists: 0 };
  let segments: SegmentRef[] | null = options.segments ? [...options.segments] : null;
  // Segments that have been asked for and not yet read, by key. A segment is taken out when it is read, whatever it gave, so that one that was not there is asked for again when it is looked for again.
  const asked = new Map<string, Promise<Awaited<ReturnType<ObjectStore["get"]>>>>();
  const ask = (key: string) => {
    let pending = asked.get(key);
    if (!pending) {
      pending = bulk.get(key);
      // Nobody is left with an unhandled rejection by a segment that is asked for and never read; whoever reads it gets the rejection.
      pending.catch(() => {});
      asked.set(key, pending);
    }
    return pending;
  };

  const accept = (bytes: Uint8Array, source: "sealed" | "tail"): LogEntry => {
    const { header } = parseEntry(bytes);
    checkLink(previous, header, book);
    checkSchema(header, options.schema);
    previous = { seq: header.seq, hash: header.hash };
    next = header.seq + 1;
    if (source === "sealed") result.sealedEntries += 1;
    else result.tailEntries += 1;
    return { header, bytes, source };
  };

  const listSegments = async (): Promise<SegmentRef[]> => {
    const listed = await listSealedSegments(bulk, keys);
    result.lists += listed.lists;
    return listed.segments;
  };
  const cover = (list: readonly SegmentRef[], seq: number): SegmentRef | undefined => {
    let best: SegmentRef | undefined;
    for (const item of list)
      if (item.from <= seq && seq <= item.to && (!best || item.to > best.to)) best = item;
    return best;
  };

  // The head to start the next look from when one is already known: the caller's, and then the one the last page of the tail came with.
  let known: TierHead | null = options.head ?? null;
  for (;;) {
    const head = known ?? (await span("tail.read", { "book.id": book }, () => tier.head(book)));
    known = null;
    if (next > head.seq) break;

    // The first page of the tail is asked for now when the segments come first, so that its round trip overlaps with theirs.
    let tailAhead: Promise<TierPage> | null = null;
    if (next <= head.sealedThrough && next === options.after.seq + 1) {
      tailAhead = tier.readFrom(book, head.sealedThrough + 1, pageSize);
      tailAhead.catch(() => {});
    }

    // 1. Entries the tail has trimmed live in sealed segments.
    while (next <= head.sealedThrough) {
      let segment: SegmentRef | undefined;
      let object: Awaited<ReturnType<ObjectStore["get"]>> = null;
      for (let attempt = 0; attempt <= retries && !object; attempt += 1) {
        if (attempt > 0 || segments === null) segments = await listSegments();
        segment = cover(segments, next);
        if (segment) {
          const wanted = ask(segment.key);
          // The segments after this one are asked for now (as far as the tail has trimmed), so that their round trips overlap with this one's. They are read, and every link checked, in order.
          let ahead = segment.to + 1;
          for (let count = 0; count < SEGMENTS_AHEAD && ahead <= head.sealedThrough; count += 1) {
            const upcoming = cover(segments, ahead);
            if (!upcoming) break;
            ask(upcoming.key);
            ahead = upcoming.to + 1;
          }
          object = await wanted;
          asked.delete(segment.key);
        }
        if (!object) segments = null;
      }
      if (!segment || !object)
        throw new LogGapError(next, "no sealed segment holds it and the tail has trimmed it");
      result.segmentsRead += 1;
      const entries = decodeSegment(object.body);
      let used = 0;
      let before: EntryHeader | null = null;
      for (const bytes of entries) {
        const { header } = parseEntry(bytes);
        // The segment must be a chain of its own, whatever part of it is wanted.
        if (before && (header.seq !== before.seq + 1 || header.prev !== before.hash))
          throw new EntryError(
            "chain",
            `The sealed segment ${segment.key} is not a chain at entry ${header.seq}`,
          );
        before = header;
        if (header.seq < next) continue;
        yield accept(bytes, "sealed");
        used += 1;
      }
      if (used === 0)
        throw new LogGapError(next, `the sealed segment ${segment.key} does not reach it`);
    }

    // 2. The rest is in the tail.
    const page =
      tailAhead && next === head.sealedThrough + 1
        ? await tailAhead
        : await span("tail.read", { "book.id": book, seq: next }, () =>
            tier.readFrom(book, next, pageSize),
          );
    if (page.entries.length === 0) {
      if (next <= page.head.sealedThrough) continue; // sealed while we were looking: segments again
      if (next > page.head.seq) break;
      throw new LogGapError(next, "the tail reports the entry but does not return it");
    }
    const first = page.entries[0];
    if (first && first.seq > next) {
      if (next <= page.head.sealedThrough) continue;
      throw new LogGapError(next, `the tail resumes at entry ${first.seq}`);
    }
    for (const entry of page.entries) {
      if (entry.seq < next) continue;
      const accepted = accept(entry.body, "tail");
      if (accepted.header.hash !== entry.hash || accepted.header.fence !== entry.fence)
        throw new EntryError(
          "hash",
          `The tail's record of entry ${entry.seq} disagrees with the entry`,
        );
      yield accepted;
    }
    // The page came with the tail's head as it stood: the next look starts from it, and does not ask again.
    known = page.head;
  }
  const last: { seq: number; hash: string } = previous ?? { seq: 0, hash: GENESIS_HASH };
  return { head: last, ...result };
}

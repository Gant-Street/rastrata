import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { counter, histogram, span } from "@rastrata/telemetry";
import { applyEntriesInTurns, carriesBaseSnapshot, catchUp } from "./apply.ts";
import { ChangeCapture } from "./capture.ts";
import { sha256, payloadOf } from "./entry.ts";
import { listSealedSegments, readLog, type LogEntry, type SegmentRef } from "./logreader.ts";
import { knownBucket } from "./metrics.ts";
import type { BookKeys, ObjectStore } from "./objectstore.ts";
import {
  SnapshotRejected,
  listSnapshotSeqs,
  parseManifest,
  unpackSnapshot,
  type SnapshotManifest,
} from "./snapshot.ts";
import { GENESIS_HASH, type LogTier, type TierHead } from "./tier.ts";

/** The bulk store holds more of the book than the tail knows of: a snapshot or a sealed segment
 * reaches past the tail's last entry. The tail lost its state (a wiped database, a reset object), or it
 * is the wrong tail for this bucket. A process that served the book anyway would start a second
 * history at the same sequence numbers, so it must not: the tail is restored from the bulk store by an
 * operator, who accepts that what only the tail held (at most the last seal window) is gone. */
export class TailBehindBulkError extends Error {
  constructor(
    readonly bookId: string,
    /** The last entry the tail has. */
    readonly tailSeq: number,
    /** The last entry the bulk store holds (a snapshot's or a sealed segment's). */
    readonly bulkSeq: number,
    readonly holds: "a snapshot" | "a sealed segment",
  ) {
    super(
      `The log of ${bookId} ends at entry ${tailSeq} but the bulk store holds ${holds} through entry ${bulkSeq}: the tail has lost state, and the book is not served until it is restored from the bulk store`,
    );
    this.name = "TailBehindBulkError";
  }
}

/** The bulk store never holds more of a book than its tail does: a snapshot is of an entry the tail
 * has (it is announced by the next one), and a segment is written from entries the tail has and only
 * then trimmed from it. Refuse a book for which that is not so. */
export async function assertTailNotBehind(options: {
  readonly tier: LogTier;
  readonly bulk: ObjectStore;
  readonly keys: BookKeys;
}): Promise<{
  readonly snapshots: readonly number[];
  readonly segments: readonly SegmentRef[];
  readonly head: TierHead;
}> {
  const { tier, bulk, keys } = options;
  // The tail's head, the snapshots and the sealed segments do not depend on one another, and each is a round trip to a store over a network: they are asked for together.
  const [head, snapshots, sealed] = await Promise.all([
    tier.head(keys.bookId),
    listSnapshotSeqs(bulk, keys),
    listSealedSegments(bulk, keys),
  ]);
  const newestSnapshot = snapshots[0] ?? 0;
  if (newestSnapshot > head.seq)
    throw new TailBehindBulkError(keys.bookId, head.seq, newestSnapshot, "a snapshot");
  const newestSealed = sealed.segments.reduce((newest, item) => Math.max(newest, item.to), 0);
  if (newestSealed > head.seq)
    throw new TailBehindBulkError(keys.bookId, head.seq, newestSealed, "a sealed segment");
  // The snapshots, newest first, the sealed segments and the tail's head, as they were found: materializing does not ask for them again.
  return { snapshots, segments: sealed.segments, head };
}

export interface MaterializeOptions {
  readonly tier: LogTier;
  readonly bulk: ObjectStore;
  readonly keys: BookKeys;
  /** The highest schema version this process understands. */
  readonly schema: number;
  /** The cache file. */
  readonly path: string;
  /** Tables that are derived and never replicated. */
  readonly exclude?: readonly string[];
  /** Reuse a file already at `path` when it is clean and still on this log (default true). */
  readonly reuse?: boolean;
  /** SQLite's durability for the cache (default NORMAL: the log is the durable copy). */
  readonly synchronous?: "OFF" | "NORMAL" | "FULL";
  /** How many snapshots to try, newest first, before reading the whole log (default 3). */
  readonly snapshotsToTry?: number;
  /** Hand the host the connection before capture is installed on it. */
  readonly onDatabase?: (db: Database) => void;
}

export interface MaterializeStats {
  readonly source: "warm" | "snapshot" | "log" | "base";
  readonly snapshotSeq: number;
  readonly snapshotBytes: number;
  readonly rawBytes: number;
  readonly entriesApplied: number;
  readonly sealedEntries: number;
  readonly tailEntries: number;
  readonly segmentsRead: number;
  /** Snapshots that were named and refused, and why. */
  readonly rejected: readonly string[];
  readonly journalsHint: number | null;
  readonly ms: {
    readonly total: number;
    readonly log: number;
    readonly download: number;
    readonly unpack: number;
    readonly open: number;
    readonly apply: number;
  };
}

export interface Materialized {
  readonly db: Database;
  readonly capture: ChangeCapture;
  readonly head: { readonly seq: number; readonly hash: string };
  readonly stats: MaterializeStats;
}

/** Open a cache file with the settings a cache wants: write-ahead log, foreign keys on, and a
 * `synchronous` that does not wait for the disk (a lost tail of the file is a stale cache, which
 * catching up repairs, never a corrupt one). */
export function openCacheDatabase(
  path: string,
  synchronous: "OFF" | "NORMAL" | "FULL" = "NORMAL",
): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`PRAGMA synchronous=${synchronous}`);
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA busy_timeout=5000");
  return db;
}

function discardFile(path: string): void {
  for (const suffix of ["", "-wal", "-shm", ".partial"])
    rmSync(`${path}${suffix}`, { force: true });
}

const sameManifest = (a: SnapshotManifest, b: SnapshotManifest): boolean =>
  a.seq === b.seq &&
  a.entryHash === b.entryHash &&
  a.sha256 === b.sha256 &&
  a.bytes === b.bytes &&
  a.bookId === b.bookId;

/** Make a book's cache file current with its log: reuse a file that is clean and still on the log
 * and catch it up; or take the newest snapshot that an entry in the log announces, check its
 * digest, and apply the entries after it; or, if there is none, build the file from the first entry.
 * Every hash link on the way is verified. */
export async function materialize(options: MaterializeOptions): Promise<Materialized> {
  const { bulk, keys } = options;
  const book = keys.bookId;
  const started = performance.now();
  // Before anything is read or reused: a book whose tail has lost state must not be served.
  const guarded = await assertTailNotBehind({ tier: options.tier, bulk, keys });
  return span("activation", { "book.id": book }, async (s) => {
    const rejected: string[] = [];
    let result: Materialized | null = null;

    if (options.reuse !== false && existsSync(options.path)) {
      result = await warm(options, started);
      if (!result) discardFile(options.path);
    }
    if (!result) {
      // A snapshot at entry 1 is the base of an imported book: entry 1 itself names it, and the whole
      // log is read from the beginning to find that out.
      const seqs = guarded.snapshots.filter((seq) => seq > 1).slice(0, options.snapshotsToTry ?? 3);
      for (const seq of [...seqs, 0]) {
        try {
          result = await fromSnapshot(options, seq, started, rejected, guarded);
          break;
        } catch (error) {
          discardFile(options.path);
          if (!(error instanceof SnapshotRejected) || seq === 0) throw error;
          rejected.push(`${seq}: ${error.message}`);
        }
      }
    }
    if (!result) throw new Error("The book could not be materialized");
    const { stats } = result;
    const bucket = knownBucket(stats.journalsHint, result.head.seq);
    s.setAttributes({ seq: result.head.seq, outcome: stats.source, size_bucket: bucket });
    const source = stats.source === "warm" || stats.source === "base" ? "other" : stats.source;
    counter("activations").add(1, {
      activation_source: source === "other" ? "other" : source,
      size_bucket: bucket,
    });
    histogram("activation.duration").record(stats.ms.total / 1000, { size_bucket: bucket });
    const phase = histogram("activation.phase.duration");
    phase.record(stats.ms.download / 1000, {
      activation_phase: "snapshot_download",
      size_bucket: bucket,
    });
    phase.record(stats.ms.log / 1000, { activation_phase: "tail", size_bucket: bucket });
    phase.record(stats.ms.apply / 1000, { activation_phase: "apply", size_bucket: bucket });
    return { ...result, stats: { ...stats, rejected } };
  });
}

async function warm(options: MaterializeOptions, started: number): Promise<Materialized | null> {
  const { tier, bulk, keys } = options;
  const book = keys.bookId;
  let db: Database | null = null;
  try {
    const opened = performance.now();
    db = openCacheDatabase(options.path, options.synchronous);
    options.onDatabase?.(db);
    const capture = new ChangeCapture(db, { exclude: options.exclude ?? [] });
    capture.install();
    const head = capture.head();
    if (!head || head.bookId !== book || capture.hasUnsent())
      throw new SnapshotRejected("the file is not a clean cache of this book");
    const tierHead = await tier.head(book);
    if (head.seq > tierHead.seq) throw new SnapshotRejected("the cache is ahead of the log");
    if (head.seq === tierHead.seq && head.hash !== tierHead.hash)
      throw new SnapshotRejected("the cache is on another history");
    const openMs = performance.now() - opened;
    const applying = performance.now();
    const caught = await catchUp(db, capture, { tier, bulk, keys, schema: options.schema });
    const now = performance.now();
    return {
      db,
      capture,
      head: caught.head,
      stats: {
        source: "warm",
        snapshotSeq: head.seq,
        snapshotBytes: 0,
        rawBytes: 0,
        entriesApplied: caught.applied,
        sealedEntries: 0,
        tailEntries: 0,
        segmentsRead: 0,
        rejected: [],
        journalsHint: null,
        ms: {
          total: now - started,
          log: 0,
          download: 0,
          unpack: 0,
          open: openMs,
          apply: now - applying,
        },
      },
    };
  } catch (error) {
    db?.close();
    // A file that cannot be trusted is rebuilt; a log that cannot be read is not a cache problem.
    if (error instanceof SnapshotRejected) return null;
    if (error instanceof Error && /SQLite|database|malformed|disk image/i.test(error.message))
      return null;
    throw error;
  }
}

async function fromSnapshot(
  options: MaterializeOptions,
  seq: number,
  started: number,
  rejected: readonly string[],
  found: { readonly segments: readonly SegmentRef[]; readonly head: TierHead },
): Promise<Materialized> {
  const { tier, bulk, keys } = options;
  const book = keys.bookId;
  const clock = () => performance.now();

  // A snapshot is named by its sequence, so it is asked for with its manifest and comes down while the log after it is read; one that turns out to be refused was a download that was not needed.
  const manifestRead = seq > 0 ? bulk.get(keys.manifest(seq)) : null;
  const snapshotRead = seq > 0 ? bulk.get(keys.snapshot(seq)) : null;
  // Nobody is left with an unhandled rejection by a download that is never waited for.
  manifestRead?.catch(() => {});
  snapshotRead?.catch(() => {});

  let manifest: SnapshotManifest | null = null;
  let after = { seq: 0, hash: GENESIS_HASH };
  if (manifestRead) {
    const object = await manifestRead;
    if (!object) throw new SnapshotRejected("its manifest is missing");
    manifest = parseManifest(object.body);
    if (manifest.bookId !== book || manifest.seq !== seq)
      throw new SnapshotRejected("its manifest is for something else");
    after = { seq, hash: manifest.entryHash };
  }

  // The entries after it, verified link by link: this is also what authenticates the snapshot.
  const loading = clock();
  const entries: LogEntry[] = [];
  const reader = readLog({
    tier,
    bulk,
    keys,
    schema: options.schema,
    after,
    segments: found.segments,
    head: found.head,
  });
  let step = await reader.next();
  while (!step.done) {
    entries.push(step.value);
    step = await reader.next();
  }
  const read = step.value;
  const logMs = clock() - loading;

  let base: SnapshotManifest | null = manifest;
  let first = 0;
  let source: MaterializeStats["source"] = seq > 0 ? "snapshot" : "log";
  if (seq > 0) {
    const announced = entries.some((entry) => {
      if (entry.header.kind !== "snapshot-published") return false;
      try {
        return sameManifest(parseManifest(payloadOf(entry.bytes)), manifest as SnapshotManifest);
      } catch {
        return false;
      }
    });
    if (!announced) throw new SnapshotRejected("no entry of the log announces it");
  } else if (entries[0] && carriesBaseSnapshot(entries[0])) {
    base = parseManifest(payloadOf(entries[0].bytes));
    if (base.bookId !== book || base.seq !== 1)
      throw new SnapshotRejected("the base snapshot is for something else");
    first = 1;
    source = "base";
  }

  let downloadMs = 0;
  let unpackMs = 0;
  let snapshotBytes = 0;
  let rawBytes = 0;
  discardFile(options.path);
  if (base) {
    const downloading = clock();
    const object = await span("activation.snapshot", { "book.id": book, seq: base.seq }, () =>
      snapshotRead && base.seq === seq ? snapshotRead : bulk.get(keys.snapshot(base.seq)),
    );
    if (!object) throw new SnapshotRejected("its object is missing");
    if (sha256(object.body) !== base.sha256)
      throw new SnapshotRejected("its bytes do not match the digest the log announces");
    downloadMs = clock() - downloading;
    const unpacking = clock();
    rawBytes = await unpackSnapshot(object.body, options.path);
    unpackMs = clock() - unpacking;
    snapshotBytes = object.body.byteLength;
  }

  const opening = clock();
  const db = openCacheDatabase(options.path, options.synchronous);
  try {
    options.onDatabase?.(db);
    const capture = new ChangeCapture(db, { exclude: options.exclude ?? [] });
    capture.install();
    if (source === "snapshot") {
      const head = capture.head();
      if (
        !head ||
        head.bookId !== book ||
        head.seq !== seq ||
        head.hash !== (manifest as SnapshotManifest).entryHash
      )
        throw new SnapshotRejected("the file inside does not stand where the manifest says");
    } else if (source === "base") {
      capture.setHead({ bookId: book, seq: 1, hash: (entries[0] as LogEntry).header.hash });
    } else {
      capture.setHead({ bookId: book, seq: 0, hash: GENESIS_HASH });
    }
    const openMs = clock() - opening;
    const applying = clock();
    const result = await applyEntriesInTurns(db, capture, book, entries.slice(first));
    const applyMs = clock() - applying;
    const head =
      result.applied > 0 || first > 0 || seq > 0
        ? (capture.head() as { seq: number; hash: string })
        : { seq: 0, hash: GENESIS_HASH };
    return {
      db,
      capture,
      head: { seq: head.seq, hash: head.hash },
      stats: {
        source,
        snapshotSeq: base?.seq ?? 0,
        snapshotBytes,
        rawBytes,
        entriesApplied: result.applied + first,
        sealedEntries: read.sealedEntries,
        tailEntries: read.tailEntries,
        segmentsRead: read.segmentsRead,
        rejected,
        journalsHint: base?.journals ?? null,
        ms: {
          total: clock() - started,
          log: logMs,
          download: downloadMs,
          unpack: unpackMs,
          open: openMs,
          apply: applyMs,
        },
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

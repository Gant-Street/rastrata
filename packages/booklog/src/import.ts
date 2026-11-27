import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangeCapture } from "./capture.ts";
import { systemClock, type Clock } from "./clock.ts";
import { buildEntry, sha256 } from "./entry.ts";
import { BookKeys, type ObjectStore } from "./objectstore.ts";
import { compressSnapshot, uploadSnapshot, type SnapshotManifest } from "./snapshot.ts";
import { GENESIS_HASH, type LogTier } from "./tier.ts";

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

export interface ImportOptions {
  readonly tier: LogTier;
  readonly bulk: ObjectStore;
  readonly bookId: string;
  /** Key prefix in the bulk store: empty, or ending in "/". */
  readonly prefix?: string;
  /** A closed SQLite book file. It is copied, never changed. */
  readonly path: string;
  /** The highest schema version of the code that is importing. */
  readonly schema: number;
  /** Who is importing (the lease holder and the writer of the first entry). */
  readonly holder?: string;
  /** Tables that are derived and never replicated; the copy is made without them. */
  readonly exclude?: readonly string[];
  /** The number of journals in the book, for the manifest (a size hint). */
  readonly journals?: number | ((db: Database) => number | null);
  readonly clock?: Clock;
}

export interface ImportResult {
  readonly seq: number;
  readonly hash: string;
  readonly manifest: SnapshotManifest;
  readonly rawBytes: number;
  readonly bytes: number;
  readonly milliseconds: number;
}

/** Put an existing book file into the log as its beginning. The file becomes a base snapshot in the
 * bulk store and entry 1 of the log, of kind `genesis`, names it and carries its digest; a process
 * that materializes the book downloads the snapshot, checks it against the chain, and goes on from
 * entry 2. Nothing is encoded row by row, so a large book costs a copy and a compression. The book
 * must not already be in the log. */
export async function importBookFile(options: ImportOptions): Promise<ImportResult> {
  const started = performance.now();
  const clock = options.clock ?? systemClock;
  const keys = new BookKeys(options.prefix ?? "", options.bookId);
  const holder = options.holder ?? `importer#${process.pid}`;
  const before = await options.tier.head(options.bookId);
  if (before.seq !== 0)
    throw new ImportError(`The book ${options.bookId} is already in the log (entry ${before.seq})`);

  const directory = mkdtempSync(join(tmpdir(), "booklog-import-"));
  const copy = join(directory, "book.sqlite");
  try {
    copyFileSync(options.path, copy);
    const db = new Database(copy);
    let raw: Uint8Array;
    let journals: number | null = null;
    try {
      db.exec("PRAGMA journal_mode=WAL");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      // Derived tables are rebuilt by whoever reads the book; they do not belong in its beginning.
      for (const table of options.exclude ?? [])
        db.exec(`DROP TABLE IF EXISTS "${table.replaceAll('"', '""')}"`);
      const capture = new ChangeCapture(db, { exclude: options.exclude ?? [] });
      capture.install();
      capture.adopt();
      journals =
        typeof options.journals === "function" ? options.journals(db) : (options.journals ?? null);
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.exec("VACUUM");
      raw = db.serialize();
    } finally {
      db.close();
    }
    const gz = await compressSnapshot(raw);
    const manifest: SnapshotManifest = await uploadSnapshot(
      bulkOf(options),
      keys,
      {
        v: 1,
        bookId: options.bookId,
        seq: 1,
        // The entry that carries this manifest cannot name its own hash: the snapshot says so.
        entryHash: GENESIS_HASH,
        sha256: sha256(gz),
        bytes: gz.byteLength,
        rawBytes: raw.byteLength,
        schema: options.schema,
        stateHash: null,
        journals,
        writer: holder,
        at: new Date(clock.now()).toISOString(),
      },
      gz,
    );

    // Entry 1 names it. The tail takes it under a lease where it has them.
    let fence = 0;
    if (options.tier.capabilities.leases) {
      const grant = await options.tier.acquire(options.bookId, holder, 30_000);
      if (!grant.ok)
        throw new ImportError(`The book ${options.bookId} is leased to ${grant.heldBy}`);
      fence = grant.lease.fence;
    }
    try {
      const entry = buildEntry({
        bookId: options.bookId,
        seq: 1,
        prev: GENESIS_HASH,
        writer: holder,
        fence,
        schema: options.schema,
        kind: "genesis",
        at: new Date(clock.now()).toISOString(),
        payload: new TextEncoder().encode(JSON.stringify(manifest)),
        changes: 0,
      });
      const result = await options.tier.append(options.bookId, {
        seq: 1,
        prevHash: GENESIS_HASH,
        hash: entry.header.hash,
        fence,
        body: entry.bytes,
      });
      if (!result.ok)
        throw new ImportError(
          `The first entry of ${options.bookId} was refused (${result.reason})`,
        );
      return {
        seq: 1,
        hash: entry.header.hash,
        manifest,
        rawBytes: raw.byteLength,
        bytes: gz.byteLength,
        milliseconds: performance.now() - started,
      };
    } finally {
      if (options.tier.capabilities.leases)
        await options.tier.release(options.bookId, { holder, fence }).catch(() => {});
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const bulkOf = (options: ImportOptions): ObjectStore => options.bulk;

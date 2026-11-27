import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, openSync } from "node:fs";
import { type BookCommitment, commitmentOfGenesis } from "../replay-cost.ts";
import { hashFile } from "./files.ts";

export interface SnapshotTask {
  /** The live database. Opened read-only: it is never changed. */
  readonly source: string;
  /** Where the snapshot is written. It must not exist. */
  readonly target: string;
}

export interface SnapshotResult {
  readonly bytes: number;
  readonly sha256: string;
  readonly ledgerFormat: string;
  readonly head: { sequence: string; bookRevision: string; chainHash: string };
  readonly genesisSha256: string;
  readonly stores: Record<string, number>;
  readonly book: { name: string; currency: string };
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function openSource(path: string): Database {
  try {
    return new Database(path, { readonly: true });
  } catch {
    // A database that is not in write-ahead mode at the moment may refuse a read-only open.
    const db = new Database(path);
    db.exec("PRAGMA query_only=ON");
    return db;
  }
}

/** What a snapshot says about the book inside it, read from the snapshot itself so it can never
 * disagree with the bytes that were saved. */
export function describeDatabase(path: string): Omit<SnapshotResult, "bytes" | "sha256"> {
  const db = new Database(path, { readonly: true });
  try {
    const ledger = db
      .query("SELECT format, head, genesis FROM ledger_native_book WHERE singleton = 1")
      .get() as { format: string; head: string; genesis: string } | null;
    if (!ledger)
      throw new Error("This database has no ledger yet. Set up the book before backing it up.");
    const head = JSON.parse(ledger.head) as SnapshotResult["head"];
    const stores: Record<string, number> = { core: 1 };
    try {
      for (const row of db.query("SELECT slice, version FROM app_slice_migrations").all() as {
        slice: string;
        version: number;
      }[])
        stores[row.slice] = row.version;
    } catch {
      // No lane has created product state yet.
    }
    let name = "";
    let currency = "";
    try {
      const book = db.query("SELECT setup FROM app_book WHERE id = 1").get() as {
        setup: string;
      } | null;
      const setup = book ? (JSON.parse(book.setup) as { name?: unknown; currency?: unknown }) : {};
      name = typeof setup.name === "string" ? setup.name.slice(0, 200) : "";
      currency = typeof setup.currency === "string" ? setup.currency.slice(0, 3) : "";
    } catch {
      // The manifest records what it can read.
    }
    return {
      ledgerFormat: ledger.format,
      head: { sequence: head.sequence, bookRevision: head.bookRevision, chainHash: head.chainHash },
      genesisSha256: sha256(ledger.genesis),
      stores,
      book: { name, currency },
    };
  } finally {
    db.close();
  }
}

/** Which kind of book a database file holds (see replay-cost.ts), read from the starting record the
 * ledger keeps, through a read-only connection, so that a service that has the file open is not disturbed
 * and nothing is ever created beside the file. Null when the file has no ledger yet or cannot be read:
 * that includes a database in write-ahead mode that nobody has open and that has no `-wal` and `-shm`
 * beside it (a book just imported), which SQLite will not open read-only. The service opens its book
 * before it asks, and a backup is not in write-ahead mode, so neither meets that. It decodes a genesis,
 * which has no journals, so it takes a few milliseconds whatever the size of the book: a replay can ask
 * it before it begins. */
export function readBookCommitment(path: string): BookCommitment | null {
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const row = db.query("SELECT genesis FROM ledger_native_book WHERE singleton = 1").get() as {
      genesis: string;
    } | null;
    return row ? commitmentOfGenesis(row.genesis) : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Snapshot the whole database (ledger and product state) into one self-contained file. `VACUUM INTO`
 * reads one consistent view, so a writer that keeps committing never makes the copy inconsistent,
 * and it neither blocks that writer nor waits for it. The file is synced and made private before
 * anything else looks at it. Runs in a worker thread.
 */
export function takeSnapshot(task: SnapshotTask): SnapshotResult {
  const source = openSource(task.source);
  try {
    source.exec("PRAGMA busy_timeout=10000");
    source.query("VACUUM INTO ?").run(task.target);
  } finally {
    source.close();
  }
  chmodSync(task.target, 0o600);
  const handle = openSync(task.target, "r+");
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  const described = describeDatabase(task.target);
  const file = hashFile(task.target);
  return { ...described, bytes: file.bytes, sha256: file.sha256 };
}

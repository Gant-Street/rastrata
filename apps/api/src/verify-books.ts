/** The integrity verifier. A hosted book is a hash-chained log that nobody reads from its first entry: a pod opens it from a snapshot, and a trusted replay applies what the log holds
 * without executing it again. This reads one book the long way, in the three layers that can each be wrong, and says whether it is sound:
 *
 *  1. the log: every entry from the first is read (the sealed segments, then the tail), checked link by link, for its schema and for the book it names, and applied to an empty database;
 *  2. the ledger: that database is checked by SQLite, and the whole ledger is replayed through the code that serves every read (`verify: "full"`), each stored outcome compared with what
 *     executing its command gives now;
 *  3. the snapshots: the one a pod would start from is opened beside the database the log made, and the two are compared table by table.
 *
 * A book that fails is stopped: a record under its own prefix (packages/booklog/src/review.ts) that the pods look for before they open it, so that a bad history is not extended and
 * a book that may be wrong is not shown as right. A stop lasts until a person clears it, so it is written only for what is certain to be wrong with the book. A finding is run again from
 * nothing, in a new folder, and recorded only if it comes out the same; and trouble that is not the book's (a store that did not answer, a tail that is down, a disk that is full,
 * entries written by a newer build than this one, a book that was deleted while it was read) is a `skipped` verdict that stops nothing. What is stored with a stop is a kind, an entry
 * number, the name of a check or a table, and hashes: nothing of what the book holds.
 *
 * The design is docs/reference/program/hosting/verifier.md. */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  statfsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { APPLICATION_DERIVED, APPLICATION_SCHEMA } from "@rastrata/application/hosted";
import { checkBackupFile } from "@rastrata/application/local";
import {
  ApplyError,
  BOOK_ID,
  BookDeletedError,
  BookKeys,
  CodecError,
  EntryError,
  LogGapError,
  materialize,
  ObjectStoreError,
  recordReview,
  reviewCount,
  SnapshotRejected,
  TailBehindBulkError,
  type LogTier,
  type Materialized,
  type ObjectStore,
  type ReviewKind,
} from "@rastrata/booklog";

export interface VerifyOptions {
  readonly tier: LogTier;
  readonly bulk: ObjectStore;
  /** Empty, or ending in a slash: the prefix of the books in the bucket. */
  readonly prefix: string;
  /** A folder to work in. Each book gets a folder of its own in it, which is removed when the book has been looked at. */
  readonly scratch: string;
  /** Open the snapshot a pod would start from and compare it with the log (default true). */
  readonly snapshots?: boolean;
  /** Write a stop for a book that fails (default true; without it a finding is only reported). */
  readonly record?: boolean;
  /** How many times a finding is run again, from nothing, before it is believed (default 1). */
  readonly confirmations?: number;
  /** A book that already has a stop is not looked at again (the schedule's choice; a person asking for one book gets it looked at). */
  readonly skipReviewed?: boolean;
  /** A folder to leave the database the log made in, as `<book>.sqlite`, for a person who is looking into a book (it holds the whole book: it is the operator's to keep or to delete). */
  readonly keep?: string;
  /** Which build of the verifier this is, for the record. */
  readonly build?: string;
  /** The highest schema version this build understands (default: the application's). */
  readonly schema?: number;
  readonly now?: () => Date;
  /** Waits between looks at a log that seems to have a gap (a test passes one that does not wait). */
  readonly pause?: (milliseconds: number) => Promise<void>;
}

/** What was found wrong, in words that are safe to store (`kind`, `seq`, `check`, the hashes) and in words for the person running the tool (`detail`, which can name what is in the
 * book and is shown, never stored). */
export interface Finding {
  readonly kind: ReviewKind;
  /** The entry the finding is about, or 0 when it is about the book as a whole. */
  readonly seq: number;
  /** The name of the check that failed, or of the table that differs. */
  readonly check: string | null;
  readonly expected: string | null;
  readonly found: string | null;
  readonly detail: string;
}

/** Why a book was not judged. None of these stops it. */
export type SkipReason =
  /** The tail says the book was deleted. */
  | "deleted"
  /** It already has a stop, and the run was asked not to look again. */
  | "reviewed"
  /** A store or the tail did not answer, or refused this verifier. */
  | "unavailable"
  /** The book has entries written by a newer build than this one: it cannot be replayed here, which says nothing about the book. */
  | "verifier_too_old"
  /** There is not room in the scratch folder for the copies a check makes. */
  | "no_space"
  /** A finding that did not come out the same when it was run again. */
  | "unconfirmed"
  /** Something this verifier did not expect, which is a reason to look at the verifier first. */
  | "error";

/** How the snapshot a pod would start from compares with the log: `matches`; `none` (the book has no snapshot, or none that a pod would accept); `busy` (the book was written to
 * each time it was compared, so the two were never at the same entry); `off` (not asked for). */
export type SnapshotCheck = "matches" | "none" | "busy" | "off";

export interface Sound {
  /** The last entry of the log. */
  readonly entries: number;
  /** The commands the ledger replayed (0 for a book that has no ledger yet). */
  readonly outcomes: number;
  readonly journals: number;
  /** Whether the book has a ledger (a workspace nobody has set up has none, and there is nothing to replay). */
  readonly ledger: boolean;
  readonly snapshot: SnapshotCheck;
  /** Things worth a person's look that do not stop the book, such as a snapshot a pod would refuse (it falls back to the log). */
  readonly warnings: readonly string[];
}

/** What a stop came to: written (`recorded`, with its number), already there (`already`), not asked for (`dry_run`), or not writable now (`write_failed`; the finding stands). */
export type Stop = "recorded" | "already" | "dry_run" | "write_failed";

interface Timed {
  readonly book: string;
  readonly ms: number;
}
export type Verdict = Timed &
  (
    | ({ readonly status: "ok" } & Sound)
    | {
        readonly status: "failed";
        readonly finding: Finding;
        readonly stop: Stop;
        readonly marker: number | null;
      }
    | { readonly status: "skipped"; readonly reason: SkipReason; readonly detail: string }
  );

type Result =
  | { readonly status: "ok"; readonly sound: Sound }
  | { readonly status: "failed"; readonly finding: Finding }
  | { readonly status: "skipped"; readonly reason: SkipReason; readonly detail: string };

const failure = (finding: Finding): Result => ({ status: "failed", finding });
const skip = (reason: SkipReason, detail: string): Result => ({
  status: "skipped",
  reason,
  detail,
});

/** How many times a log that seems to have a hole is looked at again, after a wait that doubles, before the hole is believed: a book that is being written while it is read can seem to
 * have one (a segment replaced, a tail that moved between two questions). */
const LOOKS = 3;

const brief = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300);

/** The entry a message of the log's names ("Entry 41 is not chained to entry 40"), or 0. */
const entryIn = (error: unknown): number => Number(/\bentry (\d+)/i.exec(brief(error))?.[1] ?? 0);

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

/** What an error that ended a look at a book means: a finding, or trouble that is not the book's. Only what is certain to be the book's is a finding. */
function judge(error: unknown): Result {
  const detail = brief(error);
  if (error instanceof BookDeletedError) return skip("deleted", detail);
  if (error instanceof EntryError) {
    if (error.code === "schema") return skip("verifier_too_old", detail);
    return failure({
      kind: "chain_break",
      seq: entryIn(error),
      check: error.code,
      expected: null,
      found: null,
      detail,
    });
  }
  if (error instanceof LogGapError)
    return failure({
      kind: "unreadable",
      seq: error.missing,
      check: "log_gap",
      expected: null,
      found: null,
      detail,
    });
  if (error instanceof TailBehindBulkError)
    return failure({
      kind: "unreadable",
      seq: error.tailSeq,
      check: "tail_behind_bulk",
      expected: null,
      found: null,
      detail,
    });
  if (error instanceof SnapshotRejected)
    return failure({
      kind: "unreadable",
      seq: 0,
      check: "base_snapshot",
      expected: null,
      found: null,
      detail,
    });
  if (error instanceof ApplyError || error instanceof CodecError)
    return failure({
      kind: "replay_failed",
      seq: error instanceof ApplyError ? error.seq : entryIn(error),
      check: "apply",
      expected: null,
      found: null,
      detail,
    });
  if (error instanceof ObjectStoreError) return skip("unavailable", detail);
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOSPC" || /disk is full/i.test(detail)) return skip("no_space", detail);
  return skip("error", detail);
}

/** What a failure to read a book's log says about the book, for a reader that is not the verifier (a pod's whole read, whole-read.ts): the kind, the entry and the check, when the
 * failure is certain to be the book's, and null when it is trouble that is not (the store, the disk, a newer build's entries, a deleted book). */
export function logFinding(
  error: unknown,
): { readonly kind: ReviewKind; readonly seq: number; readonly check: string } | null {
  const result = judge(error);
  if (result.status !== "failed") return null;
  return {
    kind: result.finding.kind,
    seq: result.finding.seq,
    check: result.finding.check ?? "log",
  };
}

/** The book as the log makes it, from the first entry (or, with `snapshots`, from the newest snapshot a pod would accept), every link verified on the way. */
async function build(
  options: VerifyOptions,
  keys: BookKeys,
  path: string,
  how: { readonly reuse: boolean; readonly snapshots: number },
): Promise<Materialized> {
  const pause = options.pause ?? ((milliseconds: number) => Bun.sleep(milliseconds));
  for (let look = 0; ; look += 1) {
    try {
      return await materialize({
        tier: options.tier,
        bulk: options.bulk,
        keys,
        schema: options.schema ?? APPLICATION_SCHEMA,
        path,
        exclude: APPLICATION_DERIVED,
        reuse: how.reuse,
        snapshotsToTry: how.snapshots,
      });
    } catch (error) {
      const maybeLate = error instanceof LogGapError || error instanceof TailBehindBulkError;
      if (!maybeLate || look >= LOOKS) throw error;
      await pause(1000 * 2 ** look);
    }
  }
}

/** Make a cache file fit to be opened read-only by another process (a database in write-ahead mode with no `-wal` beside it cannot be). */
function settle(db: Database): void {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("PRAGMA journal_mode=DELETE");
}

function hasLedger(db: Database): boolean {
  const table = db
    .query(
      "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'ledger_native_book'",
    )
    .get();
  if (!table) return false;
  return db.query("SELECT 1 AS found FROM ledger_native_book WHERE singleton = 1").get() !== null;
}

function roomFor(directory: string, bytes: number): boolean {
  try {
    const fs = statfsSync(directory);
    return Number(fs.bavail) * Number(fs.bsize) >= bytes;
  } catch {
    // A file system that does not say is taken to have room; a full one fails the write, which is judged as such.
    return true;
  }
}

// ---- the snapshots -------------------------------------------------------------------------------------------------------------------

interface TableDigest {
  readonly rows: number;
  readonly digest: string;
}

const typed = (value: unknown): unknown =>
  value instanceof Uint8Array
    ? { blob: Buffer.from(value).toString("hex") }
    : typeof value === "bigint"
      ? { integer: value.toString() }
      : value;

/** What each table holds, as a count of rows and a digest of the rows in no particular order: two databases that hold the same rows give the same, whatever the order they were
 * written in and whatever rowids a vacuum gave them. The tables the log does not carry (the capture's own and the application's derived ones) are left out. */
function digests(db: Database): Map<string, TableDigest> {
  const found = new Map<string, TableDigest>();
  const tables = db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cdc%' ESCAPE '\\' ORDER BY name",
    )
    .all() as { name: string }[];
  for (const { name } of tables) {
    if ((APPLICATION_DERIVED as readonly string[]).includes(name)) continue;
    const columns = (
      db.query("SELECT name FROM pragma_table_info(?) ORDER BY cid").all(name) as { name: string }[]
    ).map((column) => column.name);
    const rows: string[] = [];
    const select = db.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`);
    for (const row of select.iterate() as Iterable<Record<string, unknown>>)
      rows.push(hash(JSON.stringify(columns.map((column) => typed(row[column])))));
    rows.sort();
    found.set(name, { rows: rows.length, digest: hash(rows.join("")) });
  }
  return found;
}

/** The first table, by name, in which two databases differ, or null. A table that only one has is a difference only if it holds rows (a table is made when a process first needs it, so an
 * empty one that the other side has not made yet is not). */
export function compareDatabases(
  expected: Database,
  found: Database,
): {
  readonly table: string;
  readonly expected: string | null;
  readonly found: string | null;
} | null {
  const a = digests(expected);
  const b = digests(found);
  for (const name of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(name);
    const y = b.get(name);
    if (x && y && x.rows === y.rows && x.digest === y.digest) continue;
    if ((!x && y?.rows === 0) || (!y && x?.rows === 0)) continue;
    return { table: name, expected: x?.digest ?? null, found: y?.digest ?? null };
  }
  return null;
}

type Compared =
  | { readonly finding: Finding }
  | { readonly snapshot: SnapshotCheck; readonly warnings: readonly string[] };

/** Open the book the way a pod would (from the newest snapshot it accepts), and compare it with the database the log made, at the same entry. A book that is written to between the
 * two openings is tried again, and after a few tries is reported as busy and not compared: no finding is made from two databases at different places. */
async function compareSnapshot(
  options: VerifyOptions,
  keys: BookKeys,
  logPath: string,
  directory: string,
): Promise<Compared> {
  const snapshotPath = join(directory, "snapshot.sqlite");
  const warnings = new Set<string>();
  for (let round = 0; round < 3; round += 1) {
    const opened = await build(options, keys, snapshotPath, { reuse: false, snapshots: 3 });
    try {
      for (const note of opened.stats.rejected)
        warnings.add(`a snapshot a pod would refuse: ${note}`);
      if (opened.stats.source !== "snapshot") return { snapshot: "none", warnings: [...warnings] };
      // The database the log made, brought up to the entry the book is at now.
      const made = await build(options, keys, logPath, { reuse: true, snapshots: 0 });
      try {
        if (made.head.seq !== opened.head.seq || made.head.hash !== opened.head.hash) continue;
        const differs = compareDatabases(made.db, opened.db);
        if (differs)
          return {
            finding: {
              kind: "snapshot_mismatch",
              seq: opened.stats.snapshotSeq,
              check: differs.table,
              expected: differs.expected,
              found: differs.found,
              detail: `A pod that starts from the snapshot at entry ${opened.stats.snapshotSeq} has a table, ${differs.table}, that is not what the log makes.`,
            },
          };
        return { snapshot: "matches", warnings: [...warnings] };
      } finally {
        made.db.close();
      }
    } finally {
      opened.db.close();
    }
  }
  return { snapshot: "busy", warnings: [...warnings] };
}

// ---- one book ------------------------------------------------------------------------------------------------------------------------

/** The names of the checks `checkBackupFile` makes that say the book is wrong, and what kind of finding each is. The others (a missing file, a copy that differs from what it copied)
 * are the verifier's own trouble. */
const CHECK_KINDS: Readonly<Record<string, ReviewKind>> = {
  integrity: "integrity",
  ledger_stored: "integrity",
  ledger_replay: "replay_failed",
  ledger_head: "replay_failed",
};

async function inspect(options: VerifyOptions, keys: BookKeys, directory: string): Promise<Result> {
  const logPath = join(directory, "log.sqlite");
  // Layer 1: the whole log, from the first entry, every link verified.
  const made = await build(options, keys, logPath, { reuse: false, snapshots: 0 });
  const entries = made.head.seq;
  let ledger: boolean;
  try {
    settle(made.db);
    ledger = hasLedger(made.db);
  } finally {
    made.db.close();
  }

  // Layer 2: the ledger, replayed in full.
  let outcomes = 0;
  let journals = 0;
  if (ledger) {
    const bytes = statSync(logPath).size;
    if (!roomFor(directory, bytes * 2.2 + 16 * 2 ** 20))
      return skip("no_space", "There is not room for a working copy of the book.");
    const checked = await checkBackupFile({
      file: logPath,
      manifest: null,
      scratchDir: join(directory, "replay"),
      mode: "verify",
    });
    const wrong = checked.checks.find((check) => check.status === "failed");
    if (wrong) {
      const kind = CHECK_KINDS[wrong.code];
      if (!kind) return skip("error", `${wrong.code}: ${wrong.message}`.slice(0, 300));
      return failure({
        kind,
        seq: 0,
        check: wrong.code,
        expected: null,
        found: null,
        detail: wrong.message,
      });
    }
    outcomes = checked.outcomes;
    journals = checked.journals;
  }

  // Layer 3: the snapshot a pod would start from.
  let snapshot: SnapshotCheck = "off";
  let warnings: readonly string[] = [];
  if (options.snapshots !== false) {
    const compared = await compareSnapshot(options, keys, logPath, directory);
    if ("finding" in compared) return failure(compared.finding);
    snapshot = compared.snapshot;
    warnings = compared.warnings;
  }
  return { status: "ok", sound: { entries, outcomes, journals, ledger, snapshot, warnings } };
}

/** One look at a book, in a folder of its own that is removed afterwards. */
async function look(options: VerifyOptions, keys: BookKeys): Promise<Result> {
  const directory = join(options.scratch, keys.bookId);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    return await inspect(options, keys, directory);
  } catch (error) {
    return judge(error);
  } finally {
    if (options.keep) keepCopy(directory, options.keep, keys.bookId);
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The database the log made, copied out of the folder that is about to be removed. A copy that cannot be made is not the verdict's trouble. */
function keepCopy(directory: string, keep: string, book: string): void {
  const made = join(directory, "log.sqlite");
  if (!existsSync(made)) return;
  try {
    mkdirSync(keep, { recursive: true, mode: 0o700 });
    const target = join(keep, `${book}.sqlite`);
    copyFileSync(made, target);
    chmodSync(target, 0o600);
  } catch {
    // Nothing is kept; the verdict stands.
  }
}

const same = (a: Finding, b: Finding): boolean => a.kind === b.kind && a.seq === b.seq;

/** Verify one book: read it in full, and stop it if it is wrong. */
export async function verifyBook(options: VerifyOptions, bookId: string): Promise<Verdict> {
  const started = performance.now();
  const keys = new BookKeys(options.prefix, bookId);
  const timed = (): Timed => ({ book: bookId, ms: Math.round(performance.now() - started) });
  const done = (result: Result): Verdict =>
    result.status === "ok"
      ? { ...timed(), status: "ok", ...result.sound }
      : result.status === "skipped"
        ? { ...timed(), status: "skipped", reason: result.reason, detail: result.detail }
        : { ...timed(), status: "failed", finding: result.finding, stop: "dry_run", marker: null };

  if (options.skipReviewed && (await reviewCount(options.bulk, keys).catch(() => 0)) > 0)
    return done(skip("reviewed", "The book already has a stop; it is not looked at again."));

  const first = await look(options, keys);
  if (first.status !== "failed") return done(first);
  // A finding stops a book until a person clears it, so it has to come out the same when everything is read again from nothing.
  for (let again = 0; again < (options.confirmations ?? 1); again += 1) {
    const second = await look(options, keys);
    if (second.status !== "failed" || !same(first.finding, second.finding))
      return done(
        skip(
          "unconfirmed",
          `A finding (${first.finding.kind} at entry ${first.finding.seq}) did not come out the same when it was read again: ${second.status === "failed" ? `${second.finding.kind} at entry ${second.finding.seq}` : second.status}.`,
        ),
      );
  }

  const verdict = done(first) as Verdict & { status: "failed" };
  if (options.record === false) return verdict;
  try {
    // A book that was deleted while it was read is not stopped: its objects are being erased, and a stop written now would outlive them.
    await options.tier.head(bookId);
    if ((await reviewCount(options.bulk, keys)) > 0) return { ...verdict, stop: "already" };
    const marker = await recordReview(options.bulk, keys, {
      kind: first.finding.kind,
      seq: first.finding.seq,
      expected: first.finding.expected,
      found: first.finding.found,
      check: first.finding.check,
      verifier: options.build ?? "unknown",
      at: (options.now?.() ?? new Date()).toISOString(),
    });
    return { ...verdict, stop: "recorded", marker };
  } catch (error) {
    if (error instanceof BookDeletedError)
      return done(skip("deleted", "The book was deleted while it was read."));
    return { ...verdict, stop: "write_failed" };
  }
}

// ---- many books ----------------------------------------------------------------------------------------------------------------------

/** The books in the bucket, by name. One listing call for each book, not one for each object: the keys of a book are together, so after the first of them the listing starts past the
 * last it could have (`z` sorts after the names of the folders of a book, and a name has no character that sorts after `z` and is allowed in a key). */
export async function listBooks(bulk: ObjectStore, prefix: string): Promise<string[]> {
  const root = `${prefix}books/`;
  const found: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await bulk.list(root, after, 1);
    const key = page.objects[0]?.key;
    if (key === undefined) return found;
    const id = key.slice(root.length).split("/")[0] ?? "";
    if (BOOK_ID.test(id) && key.startsWith(`${root}${id}/`)) found.push(id);
    const past = `${root}${id}/z`;
    after = past > key ? past : key;
  }
}

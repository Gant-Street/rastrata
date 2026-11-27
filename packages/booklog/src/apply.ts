import type { Database } from "bun:sqlite";
import type { ChangeCapture } from "./capture.ts";
import { type ChangeSet, decodeChangeSet } from "./codec.ts";
import { EntryError, payloadOf } from "./entry.ts";
import { readLog, type LogEntry, type ReadLogOptions } from "./logreader.ts";

export class ApplyError extends Error {
  readonly seq: number;
  constructor(seq: number, message: string) {
    super(`Entry ${seq} could not be applied: ${message}`);
    this.name = "ApplyError";
    this.seq = seq;
  }
}

/** The database holds changes that are not in the log, so entries from the log cannot be applied on
 * top of it: it is no longer the book as of any entry. The caller rebuilds it from the log. */
export class UnsentChangesError extends ApplyError {
  constructor(seq: number) {
    super(seq, "the database holds changes that are not in the log");
    this.name = "UnsentChangesError";
  }
}

/** True for a genesis entry whose payload is a base snapshot (a book imported whole) rather than
 * a change set. */
export function carriesBaseSnapshot(entry: LogEntry): boolean {
  return entry.header.kind === "genesis" && payloadOf(entry.bytes)[0] === 0x7b;
}

export interface ApplyResult {
  readonly applied: number;
  readonly head: { readonly seq: number; readonly hash: string };
}

/** Apply entries, in order, to a database that is exactly the book as of the entry before the
 * first. Foreign keys are off for the duration (a change set already holds every cascaded change in
 * the order it happened), and each batch commits together with the new head, so a crash leaves the
 * database at a whole entry. Entries with no row changes (a snapshot announcement) move the head. */
export function applyEntries(
  db: Database,
  capture: ChangeCapture,
  bookId: string,
  entries: readonly LogEntry[],
  options: { readonly batchEntries?: number; readonly batchBytes?: number } = {},
): ApplyResult {
  const maxEntries = options.batchEntries ?? 64;
  const maxBytes = options.batchBytes ?? 8 * 2 ** 20;
  let head = capture.head() ?? { bookId, seq: 0, hash: "" };
  if (head.bookId !== bookId)
    throw new ApplyError(0, `the database belongs to ${head.bookId}, not ${bookId}`);
  if (entries.length > 0 && capture.hasUnsent())
    throw new UnsentChangesError((entries[0] as LogEntry).header.seq);
  let applied = 0;
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    let at = 0;
    while (at < entries.length) {
      let end = at;
      let bytes = 0;
      while (end < entries.length && end - at < maxEntries && (bytes === 0 || bytes < maxBytes)) {
        bytes += (entries[end] as LogEntry).bytes.byteLength;
        end += 1;
      }
      db.exec("BEGIN IMMEDIATE");
      let last = head;
      try {
        // Every entry of the batch is checked and decoded, then the batch is replayed in one go (`applyAll`); a batch
        // that fails at any entry is rolled back whole, as it was when each entry was replayed before the next was read.
        const sets: ChangeSet[] = [];
        for (const entry of entries.slice(at, end)) {
          const { header } = entry;
          if (header.seq !== last.seq + 1)
            throw new ApplyError(header.seq, `the database is at entry ${last.seq}`);
          if (header.kind === "genesis" || header.kind === "commit") {
            const payload = payloadOf(entry.bytes);
            if (payload[0] === 0x7b)
              throw new ApplyError(header.seq, "a base snapshot is installed, not applied");
            sets.push(decodeChangeSet(payload));
          }
          last = { bookId, seq: header.seq, hash: header.hash };
        }
        capture.applyAll(sets);
        capture.setHead(last);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        capture.invalidate();
        if (error instanceof ApplyError || error instanceof EntryError) throw error;
        throw new ApplyError(
          (entries[at] as LogEntry).header.seq,
          error instanceof Error ? error.message : String(error),
        );
      }
      head = last;
      applied += end - at;
      at = end;
    }
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
  return { applied, head: { seq: head.seq, hash: head.hash } };
}

/** Read the log after the database's head and apply what is there. */
/** `applyEntries` for a database that nothing else is using yet (a cache being made at an open): a few entries at a
 * time, and between them a turn for whatever else the process has to do. Applying is work the process does without
 * stopping (measured 2026-11-19: 1.7 to 2.9 ms an entry), so a book of 1,800 entries applied in one go held up every
 * other book's requests, the health checks and the lease's renewals for five seconds. In turns of sixteen the longest
 * anything else waits is the time of sixteen entries. Each turn commits with its head, as a batch of `applyEntries`
 * does, so a failure leaves the database at a whole entry. */
export async function applyEntriesInTurns(
  db: Database,
  capture: ChangeCapture,
  bookId: string,
  entries: readonly LogEntry[],
  turnEntries = 64,
): Promise<ApplyResult> {
  if (entries.length <= turnEntries) return applyEntries(db, capture, bookId, entries);
  let applied = 0;
  let head = { bookId, seq: 0, hash: "" };
  for (let at = 0; at < entries.length; at += turnEntries) {
    const result = applyEntries(db, capture, bookId, entries.slice(at, at + turnEntries));
    applied += result.applied;
    head = { bookId, ...result.head };
    if (at + turnEntries < entries.length) await new Promise<void>((turn) => setImmediate(turn));
  }
  return { applied, head: { seq: head.seq, hash: head.hash } };
}

export async function catchUp(
  db: Database,
  capture: ChangeCapture,
  options: Omit<ReadLogOptions, "after">,
  batch = 64,
): Promise<ApplyResult> {
  const head = capture.head();
  const bookId = options.keys.bookId;
  const after = head ? { seq: head.seq, hash: head.hash } : { seq: 0, hash: "0".repeat(64) };
  let pending: LogEntry[] = [];
  let total = 0;
  let current = after;
  const flush = () => {
    if (pending.length === 0) return;
    const result = applyEntries(db, capture, bookId, pending);
    total += result.applied;
    current = result.head;
    pending = [];
  };
  if (!head) capture.setHead({ bookId, seq: 0, hash: after.hash });
  for await (const entry of readLog({ ...options, after })) {
    pending.push(entry);
    if (pending.length >= batch) flush();
  }
  flush();
  return { applied: total, head: current };
}

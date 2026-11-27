#!/usr/bin/env bun
/** The integrity verifier as a program (the library is verify-books.ts, the design docs/reference/program/hosting/verifier.md). It reads the books it is given, from their first entry, and
 * stops the ones that are wrong. It is configured as a pod is (`RASTRATA_BOOK_STORE` and the variables beside it name the bucket and the tail, the tail's token is a file), so it runs from the
 * same image with the same Secret; the book named in `RASTRATA_BOOK_STORE` is only a name for the bucket's prefix and is not itself looked at.
 *
 *   RASTRATA_BOOK_STORE='r2log://verifier?bulk=https://tail.example&tail=https://tail.example' \
 *   RASTRATA_BOOK_TAIL_TOKEN_FILE=/secrets/token \
 *     bun apps/api/src/verifier-main.ts --all
 *
 *   --book ID          look at this book (more than once for more). It is looked at even if it already has a stop.
 *   --books-file FILE  look at the books named in the file, one to a line (blank lines and lines that start with # are skipped).
 *   --all              look at every book in the bucket (one listing question for each book).
 *   --limit N          stop after N books.
 *   --no-snapshots     do not compare the snapshot a pod would start from with the log.
 *   --no-record        only report: write no stop.
 *   --confirm N        how many times a finding is read again from nothing before it is believed (default 1).
 *   --max-findings N   after this many findings in one run no more stops are written, for the run may be what is wrong (default 3).
 *   --keep DIR         leave the database the log made for each book in DIR, as <book>.sqlite, for looking into a book. It holds the whole book.
 *   --scratch DIR      where the working copies go (default $RASTRATA_VERIFIER_SCRATCH or a folder of the temporary directory). A book needs about three times its size.
 *   --detail           add the words for a person to each line.
 *
 * It prints a line of JSON for each book and a last line that sums the run up, and exits 0 when every book is sound (or was deleted, or was already stopped and the run was told to leave it),
 * 1 when a book was found wrong, 2 when it was started wrongly, and 3 when some book could not be judged because storage did not answer or something unexpected happened (and none was
 * found wrong). */
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOOK_ID, type LogTier, type ObjectStore } from "@rastrata/booklog";
import { openBulkStore, openTail, parseBookStore } from "./hosted.ts";
import { listBooks, type Verdict, verifyBook, type VerifyOptions } from "./verify-books.ts";
import { VERSION } from "./version.ts";

type Environment = Readonly<Record<string, string | undefined>>;

interface Arguments {
  readonly books: readonly string[];
  readonly booksFile: string | null;
  readonly all: boolean;
  readonly limit: number | null;
  readonly snapshots: boolean;
  readonly record: boolean;
  readonly confirm: number;
  readonly maxFindings: number;
  readonly scratch: string | null;
  readonly keep: string | null;
  readonly detail: boolean;
}

const USAGE =
  "usage: RASTRATA_BOOK_STORE=r2log://<name>?bulk=...&tail=... bun apps/api/src/verifier-main.ts (--book ID ... | --books-file FILE | --all) [--limit N] [--no-snapshots] [--no-record] [--confirm N] [--max-findings N] [--scratch DIR] [--keep DIR] [--detail]";

/** The arguments, or what is wrong with them. */
export function parseArguments(argv: readonly string[]): Arguments | string {
  const books: string[] = [];
  let booksFile: string | null = null;
  let all = false;
  let limit: number | null = null;
  let snapshots = true;
  let record = true;
  let confirm = 1;
  let maxFindings = 3;
  let scratch: string | null = null;
  let keep: string | null = null;
  let detail = false;
  const whole = (name: string, value: string | undefined, least: number): number | string => {
    const number = Number(value);
    return value !== undefined && /^\d+$/.test(value) && number >= least && number <= 1_000_000
      ? number
      : `${name} takes a whole number of at least ${least}`;
  };
  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at] as string;
    const value = argv[at + 1];
    switch (flag) {
      case "--book":
        if (value === undefined || !BOOK_ID.test(value)) return "--book takes the name of a book";
        books.push(value);
        at += 1;
        break;
      case "--books-file":
        if (!value) return "--books-file takes a file";
        booksFile = value;
        at += 1;
        break;
      case "--all":
        all = true;
        break;
      case "--limit": {
        const n = whole(flag, value, 1);
        if (typeof n === "string") return n;
        limit = n;
        at += 1;
        break;
      }
      case "--confirm": {
        const n = whole(flag, value, 0);
        if (typeof n === "string") return n;
        confirm = n;
        at += 1;
        break;
      }
      case "--max-findings": {
        const n = whole(flag, value, 1);
        if (typeof n === "string") return n;
        maxFindings = n;
        at += 1;
        break;
      }
      case "--scratch":
        if (!value) return "--scratch takes a folder";
        scratch = value;
        at += 1;
        break;
      case "--keep":
        if (!value) return "--keep takes a folder";
        keep = value;
        at += 1;
        break;
      case "--no-snapshots":
        snapshots = false;
        break;
      case "--no-record":
        record = false;
        break;
      case "--detail":
        detail = true;
        break;
      default:
        return `${flag} is not an option of this program`;
    }
  }
  if (all && (books.length > 0 || booksFile !== null))
    return "--all and a list of books cannot be given together";
  if (!all && books.length === 0 && booksFile === null)
    return "name the books to look at: --book, --books-file or --all";
  return {
    books,
    booksFile,
    all,
    limit,
    snapshots,
    record,
    confirm,
    maxFindings,
    scratch,
    keep,
    detail,
  };
}

/** The names in a file, one to a line. */
function namesIn(file: string): string[] | string {
  if (!existsSync(file)) return `${file} is not there`;
  const names: string[] = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (!BOOK_ID.test(line)) return "a line of the file is not the name of a book";
    names.push(line);
  }
  return names;
}

export interface Output {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** Stores to use in place of the ones the environment names (the tests'). */
export interface Stores {
  readonly bulk: ObjectStore;
  readonly tier: LogTier;
}

/** This many books in a row that the storage would not answer for is the storage, not the books: the run stops, for each would take as long again to fail. */
const UNAVAILABLE_RUN = 5;

function line(verdict: Verdict, detail: boolean): string {
  const base = { book: verdict.book, status: verdict.status, ms: verdict.ms };
  switch (verdict.status) {
    case "ok":
      return JSON.stringify({
        ...base,
        entries: verdict.entries,
        outcomes: verdict.outcomes,
        journals: verdict.journals,
        ledger: verdict.ledger,
        snapshot: verdict.snapshot,
        warnings: verdict.warnings,
      });
    case "failed":
      return JSON.stringify({
        ...base,
        kind: verdict.finding.kind,
        seq: verdict.finding.seq,
        check: verdict.finding.check,
        stop: verdict.stop,
        marker: verdict.marker,
        ...(detail ? { detail: verdict.finding.detail } : {}),
      });
    case "skipped":
      return JSON.stringify({
        ...base,
        reason: verdict.reason,
        ...(detail ? { detail: verdict.detail } : {}),
      });
  }
}

export async function run(
  argv: readonly string[],
  env: Environment,
  io: Output,
  stores?: Stores,
): Promise<number> {
  const parsed = parseArguments(argv);
  if (typeof parsed === "string") {
    io.err(`${parsed}\n${USAGE}`);
    return 2;
  }
  const store = env.RASTRATA_BOOK_STORE;
  if (!store && !stores) {
    io.err(`RASTRATA_BOOK_STORE is not set\n${USAGE}`);
    return 2;
  }
  let names: string[] = [...parsed.books];
  if (parsed.booksFile !== null) {
    const read = namesIn(parsed.booksFile);
    if (typeof read === "string") {
      io.err(read);
      return 2;
    }
    names = read;
  }

  let closeTail = async (): Promise<void> => {};
  try {
    let bulk: ObjectStore;
    let tier: LogTier;
    let prefix = "";
    if (stores) {
      ({ bulk, tier } = stores);
      if (store) prefix = parseBookStore(store, env).prefix;
    } else {
      const config = parseBookStore(store as string, env);
      prefix = config.prefix;
      bulk = openBulkStore(config, env);
      const tail = await openTail(config, bulk, env);
      tier = tail.tier;
      closeTail = () => tail.close().catch(() => {});
    }
    if (parsed.all) names = await listBooks(bulk, prefix);
    if (parsed.limit !== null) names = names.slice(0, parsed.limit);

    const base: VerifyOptions = {
      tier,
      bulk,
      prefix,
      scratch:
        parsed.scratch ?? env.RASTRATA_VERIFIER_SCRATCH ?? join(tmpdir(), "rastrata-verifier"),
      snapshots: parsed.snapshots,
      confirmations: parsed.confirm,
      ...(parsed.keep !== null ? { keep: parsed.keep } : {}),
      // A run over many books leaves a stopped book alone; a person who names a book gets it looked at.
      skipReviewed: parsed.all || parsed.booksFile !== null,
      build: VERSION,
    };
    const started = performance.now();
    const counts = { ok: 0, failed: 0, skipped: 0, reviewed: 0, deleted: 0, troubled: 0 };
    let recording = parsed.record;
    let recordingStopped = false;
    let unavailable = 0;
    let aborted = false;
    for (const name of names) {
      const verdict = await verifyBook({ ...base, record: recording }, name);
      io.out(line(verdict, parsed.detail));
      if (verdict.status === "ok") counts.ok += 1;
      else if (verdict.status === "failed") counts.failed += 1;
      else {
        counts.skipped += 1;
        if (verdict.reason === "reviewed") counts.reviewed += 1;
        else if (verdict.reason === "deleted") counts.deleted += 1;
        else counts.troubled += 1;
      }
      // The run may be what is wrong when several books are found wrong at once: after a few, it only reports.
      if (recording && counts.failed >= parsed.maxFindings) {
        recording = false;
        recordingStopped = true;
        io.err(
          `${counts.failed} books were found wrong in this run: no more stops are written, for the verifier may be what is wrong. Look at the findings first.`,
        );
      }
      unavailable =
        verdict.status === "skipped" && verdict.reason === "unavailable" ? unavailable + 1 : 0;
      if (unavailable >= UNAVAILABLE_RUN) {
        aborted = true;
        io.err(
          `${UNAVAILABLE_RUN} books in a row could not be reached: the storage is not answering, and the run stops.`,
        );
        break;
      }
    }
    io.out(
      JSON.stringify({
        summary: {
          books: names.length,
          ...counts,
          recordingStopped,
          aborted,
          ms: Math.round(performance.now() - started),
          build: VERSION,
        },
      }),
    );
    if (counts.failed > 0) return 1;
    if (counts.troubled > 0 || aborted) return 3;
    return 0;
  } catch (error) {
    io.err(
      `The verifier could not start: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  } finally {
    await closeTail();
  }
}

if (import.meta.main) {
  process.exit(
    await run(process.argv.slice(2), process.env, {
      out: (text) => console.log(text),
      err: (text) => console.error(text),
    }),
  );
}

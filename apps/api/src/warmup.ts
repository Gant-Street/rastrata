/** Reading the book once, in the background, as soon as the service is listening.
 *
 * The first read of a book replays its ledger: a few seconds for a small book, about a millisecond an
 * entry for a book made with the chain-head state commitment (every book the application makes now:
 * 15 seconds at 20,000 journals), and for a book made before it a time that grows with the square of
 * the book (about 22 seconds at a thousand journals, minutes beyond two thousand). See "The scale limit"
 * in docs/reference/program/main.md. Left to the first request, that wait is the person's: the page they
 * just opened hangs. Started at login, the same read happens while nobody is waiting.
 *
 * It is the read the first request would make (`readAggregate`, the verified one), not another one.
 * Reads are queued, so a request that arrives meanwhile waits for this read and then goes on from what
 * it verified; it does not replay the book again.
 *
 * Until it has finished, GET /health says `warming: true` and how far the read has got, so that the
 * command line and the web app can say "reading your books, about N seconds" instead of looking
 * stuck. If the read fails, the service stays up and says so (`warmup.state` is "failed"), and
 * `rastrata doctor` reports it. */
import { readBookCommitment, type LocalOpenOptions } from "@rastrata/application/local";
import {
  CHAIN_HEAD_SECONDS_PER_ENTRY,
  LEGACY_SECONDS_AT_A_THOUSAND,
  replayGrowthOf,
  type BookCommitment,
  type ReplayGrowth,
} from "@rastrata/application/replay-cost";
import { savedSnapshot } from "./capacity.ts";
import { oneLine, type Logger } from "./log.ts";

/** What the ledger tells a service that it has read: how far, out of how many entries. */
export type Observe = NonNullable<LocalOpenOptions["observe"]>;

/** A book made without the chain-head state commitment replays from its first entry in about
 * `LEGACY_SECONDS_AT_A_THOUSAND` seconds at a thousand entries and grows with the square of them (about
 * 90 s at two thousand): each entry costs in proportion to the journals the book holds when it is
 * applied. These are the integrator's measurements, the same ones `rastrata doctor`'s Capacity row uses.
 * Reading entries `from` to `to` costs `work(from, to)` units of `QUADRATIC_SECONDS_PER_UNIT`. */
const QUADRATIC_SECONDS_PER_UNIT = LEGACY_SECONDS_AT_A_THOUSAND / ((1000 * 1000) / 2);
const work = (from: number, to: number): number => (to * to - from * from) / 2;
/** The speed of this computer is measured once this much has been read, and this long has passed. */
const MEASURE_AFTER_ENTRIES = 32;
const MEASURE_AFTER_SECONDS = 0.25;

export interface ReadProgress {
  /** How the cost of reading grows with the book: with the entries for a book made with the chain-head
   * state commitment, with their square for one made without it. */
  readonly growth: ReplayGrowth;
  /** The entry the read started from: 0, or the entry of the saved snapshot it started from. */
  readonly from: number;
  /** Entries read so far, and in the book. */
  readonly done: number;
  readonly total: number;
  readonly elapsedSeconds: number;
  /** Where the read stood when its first page arrived, and when. The time before it is the process
   * starting and a saved snapshot being read (up to a third of a second for the biggest snapshot that
   * can be saved), not the pace of the replay, and against a pace of a millisecond an entry it would read
   * as ten. A linear estimate leaves it out. Left out, the whole time since the start counts. */
  readonly firstPage?: { readonly done: number; readonly elapsedSeconds: number };
}

/** About how many seconds are left. By the model until two pages have been read, then by how fast
 * this computer has gone so far: a busy computer is several times slower than the measurements, and
 * the estimate corrects itself as it goes. */
export function secondsLeft(progress: ReadProgress): number {
  if (progress.growth === "linear") {
    const left = progress.total - progress.done;
    if (!(left > 0)) return 0;
    const first = progress.firstPage ?? { done: progress.from, elapsedSeconds: 0 };
    const entries = progress.done - first.done;
    const seconds = progress.elapsedSeconds - first.elapsedSeconds;
    if (entries >= MEASURE_AFTER_ENTRIES && seconds >= MEASURE_AFTER_SECONDS)
      return (seconds * left) / entries;
    return left * CHAIN_HEAD_SECONDS_PER_ENTRY;
  }
  const left = work(progress.done, progress.total);
  if (!(left > 0)) return 0;
  const spent = work(progress.from, progress.done);
  if (
    progress.done - progress.from >= MEASURE_AFTER_ENTRIES &&
    progress.elapsedSeconds >= MEASURE_AFTER_SECONDS &&
    spent > 0
  )
    return (progress.elapsedSeconds * left) / spent;
  return left * QUADRATIC_SECONDS_PER_UNIT;
}

/** What GET /health adds: `warming` for a quick look, `warmup` for the rest. */
export interface WarmupHealth {
  readonly warming: boolean;
  readonly warmup:
    | {
        readonly state: "reading";
        /** Entries read so far and in the book; null until the first page has been read. */
        readonly done: number | null;
        readonly total: number | null;
        /** About how many seconds are left; null until the first page has been read. */
        readonly secondsLeft: number | null;
      }
    | { readonly state: "ready"; readonly entries: number; readonly seconds: number }
    | { readonly state: "failed"; readonly error: string };
}

/** What the warm-up needs of the book: whether there is one, and the verified read. */
export interface Readable {
  setupState(): unknown;
  readAggregate(): Promise<{ readonly head: { readonly sequence: string } }>;
}

export interface WarmupOptions {
  readonly logger?: Logger;
  /** The clock, in milliseconds. For tests. */
  readonly now?: () => number;
  /** Which kind of book is in a database file (see replay-cost.ts), which decides how the time left is
   * estimated. For tests; the default reads the starting record the ledger keeps in the file. A book
   * whose kind cannot be read is estimated as the slower kind. */
  readonly commitmentOf?: (databasePath: string) => BookCommitment | null;
}

type State =
  | {
      kind: "reading";
      readonly startedAt: number;
      readonly from: number;
      readonly growth: ReplayGrowth;
      /** Where the read stood at the first page, and when (milliseconds, the clock's). */
      first: { readonly done: number; readonly at: number } | null;
      done: number | null;
      total: number | null;
    }
  | { kind: "ready"; readonly entries: number; readonly seconds: number }
  | { kind: "failed"; readonly error: string };

/** A write that lands between two pages of a long read makes the read say so and ask to be retried. */
const RETRYABLE = /Book changed during read; retry/;
const ATTEMPTS = 3;
const RETRY_AFTER_MS = 250;

export class Warmup {
  private state: State = { kind: "ready", entries: 0, seconds: 0 };
  private began = false;
  private ending = false;
  private readonly logger: Logger | undefined;
  private readonly now: () => number;
  private readonly commitmentOf: (databasePath: string) => BookCommitment | null;
  /** Settles when the warm-up has ended, one way or the other. It never rejects. */
  finished: Promise<void> = Promise.resolve();

  constructor(options: WarmupOptions = {}) {
    this.logger = options.logger;
    this.now = options.now ?? (() => performance.now());
    this.commitmentOf = options.commitmentOf ?? readBookCommitment;
  }

  /** Where the ledger reports each page it has read: pass it to `LocalBookService.open`. It only
   * remembers the numbers while the warm-up is reading. */
  readonly observe: Observe = (page) => {
    const state = this.state;
    if (state.kind !== "reading") return;
    const done = Number(page.through);
    const total = Number(page.tip);
    if (Number.isFinite(done) && Number.isFinite(total)) {
      state.first ??= { done, at: this.now() };
      state.done = done;
      state.total = total;
    }
  };

  /** Whether the book is still being read. */
  get reading(): boolean {
    return this.state.kind === "reading";
  }

  /** Begin. Does nothing the second time, and nothing when there is no book yet. */
  start(book: Readable, databasePath: string): void {
    if (this.began) return;
    this.began = true;
    if (!book.setupState()) {
      this.state = { kind: "ready", entries: 0, seconds: 0 };
      return;
    }
    const startedAt = this.now();
    this.state = {
      kind: "reading",
      startedAt,
      from: savedSnapshot(databasePath)?.sequence ?? 0,
      growth: replayGrowthOf(this.commitmentOf(databasePath)),
      first: null,
      done: null,
      total: null,
    };
    this.logger?.info(
      "Reading the book in the background, so that nothing has to wait for it later",
    );
    this.finished = this.read(book, startedAt);
  }

  /** The service is stopping: what the read says from now on is the shutdown's, not a failure. */
  stopping(): void {
    this.ending = true;
  }

  status(): WarmupHealth {
    const state = this.state;
    switch (state.kind) {
      case "reading": {
        const known = state.done !== null && state.total !== null;
        return {
          warming: true,
          warmup: {
            state: "reading",
            done: state.done,
            total: state.total,
            secondsLeft: known
              ? Math.round(
                  secondsLeft({
                    growth: state.growth,
                    from: state.from,
                    done: state.done as number,
                    total: state.total as number,
                    elapsedSeconds: (this.now() - state.startedAt) / 1000,
                    ...(state.first
                      ? {
                          firstPage: {
                            done: state.first.done,
                            elapsedSeconds: (state.first.at - state.startedAt) / 1000,
                          },
                        }
                      : {}),
                  }),
                )
              : null,
          },
        };
      }
      case "ready":
        return {
          warming: false,
          warmup: {
            state: "ready",
            entries: state.entries,
            seconds: Math.round(state.seconds * 10) / 10,
          },
        };
      case "failed":
        return { warming: false, warmup: { state: "failed", error: state.error } };
    }
  }

  private async read(book: Readable, startedAt: number): Promise<void> {
    try {
      let head: { readonly sequence: string } | undefined;
      for (let attempt = 1; !head; attempt += 1) {
        try {
          head = (await book.readAggregate()).head;
        } catch (error) {
          if (this.ending || attempt >= ATTEMPTS || !RETRYABLE.test(String(error))) throw error;
          await new Promise((resume) => setTimeout(resume, RETRY_AFTER_MS * attempt));
        }
      }
      const seconds = (this.now() - startedAt) / 1000;
      const entries = Number(head.sequence);
      this.state = { kind: "ready", entries, seconds };
      this.logger?.info(
        `Read the book: ${entries} entries in ${Math.round(seconds * 10) / 10} seconds`,
      );
    } catch (error) {
      if (this.ending) {
        this.logger?.info("Stopped before the book was read");
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.state = { kind: "failed", error: oneLine(message).slice(0, 300) };
      this.logger?.error(
        "The book could not be read. The service is still up; a request that needs the book will try again and fail the same way until it is fixed",
        error,
      );
    }
  }
}

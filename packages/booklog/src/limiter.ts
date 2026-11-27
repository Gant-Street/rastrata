import { readFileSync } from "node:fs";
import { totalmem } from "node:os";
import { systemClock, type Clock } from "./clock.ts";

export interface LimiterOptions {
  /** Cold loads allowed at once. */
  readonly maxConcurrent: number;
  /** Bytes the loads in flight may be expected to need together. A load bigger than this still
   * runs, alone. */
  readonly memoryBudgetBytes: number;
  readonly clock?: Clock;
}

export interface LimiterStats {
  readonly active: number;
  readonly queued: number;
  readonly reservedBytes: number;
  readonly peakActive: number;
  readonly peakQueued: number;
  readonly peakReservedBytes: number;
  readonly admitted: number;
  readonly waitedMs: number;
  readonly maxWaitMs: number;
}

interface Waiting {
  readonly bytes: number;
  readonly since: number;
  readonly go: () => void;
}

/** A gate on the work of making a book ready, per process. A cold load is the one thing that makes
 * a pod's memory spike (hundreds of megabytes for a large book), and a node drain starts hundreds
 * at once: this lets a few run at a time, in the order they asked, and never more than the memory
 * the process was given. Each caller says what its load is expected to need. */
export class ActivationLimiter {
  readonly #max: number;
  readonly #budget: number;
  readonly #clock: Clock;
  readonly #queue: Waiting[] = [];
  #active = 0;
  #reserved = 0;
  #peakActive = 0;
  #peakQueued = 0;
  #peakReserved = 0;
  #admitted = 0;
  #waited = 0;
  #maxWait = 0;

  constructor(options: LimiterOptions) {
    if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1)
      throw new RangeError("maxConcurrent must be a positive integer");
    if (!(options.memoryBudgetBytes > 0))
      throw new RangeError("memoryBudgetBytes must be positive");
    this.#max = options.maxConcurrent;
    this.#budget = options.memoryBudgetBytes;
    this.#clock = options.clock ?? systemClock;
  }

  get stats(): LimiterStats {
    return {
      active: this.#active,
      queued: this.#queue.length,
      reservedBytes: this.#reserved,
      peakActive: this.#peakActive,
      peakQueued: this.#peakQueued,
      peakReservedBytes: this.#peakReserved,
      admitted: this.#admitted,
      waitedMs: this.#waited,
      maxWaitMs: this.#maxWait,
    };
  }

  /** Wait for a place, run `work`, give the place back. */
  async run<T>(estimateBytes: number, work: () => Promise<T>): Promise<T> {
    const bytes = Math.max(0, estimateBytes);
    await new Promise<void>((resolve) => {
      this.#queue.push({ bytes, since: this.#clock.now(), go: resolve });
      this.#peakQueued = Math.max(this.#peakQueued, this.#queue.length);
      this.#admit();
    });
    try {
      return await work();
    } finally {
      this.#active -= 1;
      this.#reserved -= bytes;
      this.#admit();
    }
  }

  #admit(): void {
    for (;;) {
      const next = this.#queue[0];
      if (!next) return;
      const fits = this.#reserved + next.bytes <= this.#budget || this.#active === 0;
      if (this.#active >= this.#max || !fits) return;
      this.#queue.shift();
      this.#active += 1;
      this.#reserved += next.bytes;
      this.#admitted += 1;
      const waited = this.#clock.now() - next.since;
      this.#waited += waited;
      this.#maxWait = Math.max(this.#maxWait, waited);
      this.#peakActive = Math.max(this.#peakActive, this.#active);
      this.#peakReserved = Math.max(this.#peakReserved, this.#reserved);
      next.go();
    }
  }
}

/** The memory this process may use: the container's limit when there is one (cgroup v2, then v1),
 * else the machine's. */
export function memoryLimitBytes(): number {
  for (const path of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const text = readFileSync(path, "utf8").trim();
      const value = Number(text);
      if (text !== "max" && Number.isFinite(value) && value > 0 && value < 2 ** 50) return value;
    } catch {
      // not in a container, or not that cgroup version
    }
  }
  return totalmem();
}

/** What a cold load of a book is expected to need at its peak, in bytes. A book's snapshot is
 * decompressed (the file, and the buffer it came from), SQLite reads it, and the application then
 * reads the whole ledger back, which is the larger part: transient memory is some tens of
 * kilobytes per journal on top of the base of an open process. The constants are from the
 * measurements in docs/reference/program/hosting/hoststore.md and are meant to be replaced when
 * those are redone on the target hardware. */
export function estimateActivationBytes(book: {
  readonly journals: number;
  readonly snapshotBytes?: number;
  readonly rawBytes?: number;
}): number {
  const base = 40 * 2 ** 20;
  const files = (book.snapshotBytes ?? 0) + (book.rawBytes ?? 0) * 1.5;
  const read = book.journals * 40 * 2 ** 10;
  return Math.round(base + files + read);
}

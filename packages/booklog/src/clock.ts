/** Time as the log's code sees it. The real clock is used in service; a virtual one lets a
 * simulation run ten thousand fault schedules in seconds, with the same ordering every time. */
export interface Clock {
  /** Milliseconds; only differences are meaningful. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

interface Timer {
  readonly at: number;
  readonly order: number;
  readonly resolve: () => void;
  readonly trace?: string;
}

/** How many timers may fire without time moving before a simulation is called livelocked. */
const MAX_SAME_INSTANT = 200_000;

/** A discrete-event clock. `sleep` registers a timer and nothing happens until `advance` (or `drive`)
 * moves time to it, so concurrent tasks interleave by their sampled delays rather than by the
 * machine. Timers that fall at the same instant fire in the order they were set. */
export class VirtualClock implements Clock {
  #now: number;
  #order = 0;
  #sameInstant = 0;
  readonly #timers: Timer[] = [];

  constructor(start = 0) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  get pending(): number {
    return this.#timers.length;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer: Timer = {
        at: this.#now + Math.max(0, ms),
        order: this.#order++,
        resolve,
        ...(process.env.BOOKLOG_CLOCK_TRACE
          ? { trace: new Error("timer set here").stack ?? "" }
          : {}),
      };
      let low = 0;
      let high = this.#timers.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        const other = this.#timers[middle] as Timer;
        if (other.at < timer.at || (other.at === timer.at && other.order < timer.order))
          low = middle + 1;
        else high = middle;
      }
      this.#timers.splice(low, 0, timer);
    });
  }

  /** Move to the earliest timer and fire it; false when none is pending. */
  advance(): boolean {
    const timer = this.#timers.shift();
    if (!timer) return false;
    if (timer.at > this.#now) {
      this.#now = timer.at;
      this.#sameInstant = 0;
    } else {
      this.#sameInstant += 1;
      if (this.#sameInstant > MAX_SAME_INSTANT)
        throw new Error(
          `The simulation is livelocked: ${MAX_SAME_INSTANT} timers fired at ${this.#now} ms without time moving${timer.trace ? `\n${timer.trace}` : " (set BOOKLOG_CLOCK_TRACE=1 for where)"}`,
        );
    }
    timer.resolve();
    return true;
  }

  /** Run `work` to completion on virtual time: let every ready continuation run, then fire the next
   * timer, until the promise settles. A promise that waits on nothing is a deadlock and throws. */
  async drive<T>(work: Promise<T>, options: { readonly maxSteps?: number } = {}): Promise<T> {
    let settled = false;
    let failed = false;
    let value: T | undefined;
    let error: unknown;
    work.then(
      (result) => {
        settled = true;
        value = result;
      },
      (reason) => {
        settled = true;
        failed = true;
        error = reason;
      },
    );
    const limit = options.maxSteps ?? 10_000_000;
    for (let step = 0; ; step += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (settled) break;
      if (step > limit) throw new Error("The simulation did not finish within its step limit");
      if (!this.advance()) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (settled) break;
        throw new Error(
          "The simulation is deadlocked: nothing is scheduled and the work is waiting",
        );
      }
    }
    if (failed) throw error;
    return value as T;
  }
}

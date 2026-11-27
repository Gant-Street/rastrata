import { LedgerError, requireLedger } from "./records.ts";

export interface LedgerQueueLimits {
  /** Includes the active operation. */
  readonly capacity: number;
  /** Waiting time only; never cancels an operation that has started. */
  readonly maximumWaitMs: number;
}

interface WaitingOperation {
  readonly start: () => void;
  readonly expire: () => void;
  readonly deadline: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Serial storage admission with bounded retained work. A durability sync may
 * have an uncertain outcome: it must retain exclusive ownership until settled.
 * Only waiting operations expire. Expired entries are removed, not left behind
 * in an ever-growing Promise chain. Failures here are service errors, not retained
 * accounting rejections. Each repository owner must have exactly one queue. */
export class SerialLedgerQueue {
  private active = false;
  private readonly waiting: WaitingOperation[] = [];
  private readonly limits: LedgerQueueLimits;

  constructor(limits: LedgerQueueLimits = { capacity: 16, maximumWaitMs: 5000 }) {
    requireLedger(
      Number.isSafeInteger(limits.capacity) &&
        limits.capacity >= 1 &&
        limits.capacity <= 1024 &&
        Number.isSafeInteger(limits.maximumWaitMs) &&
        limits.maximumWaitMs >= 1 &&
        limits.maximumWaitMs <= 60_000,
      "native_ledger_queue_limits_invalid",
    );
    this.limits = Object.freeze({ ...limits });
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.waiting.length + Number(this.active) >= this.limits.capacity)
      return Promise.reject(new LedgerError("native_ledger_overloaded"));
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active = true;
        // Defer invocation so synchronous throws obey the same release protocol.
        void Promise.resolve()
          .then(work)
          .then(
            (value) => {
              this.advance();
              resolve(value);
            },
            (error: unknown) => {
              this.advance();
              reject(error);
            },
          );
      };
      if (!this.active) {
        start();
        return;
      }
      const expire = () => reject(new LedgerError("native_ledger_queue_timeout"));
      const entry: WaitingOperation = {
        start,
        expire,
        deadline: performance.now() + this.limits.maximumWaitMs,
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(entry);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          expire();
        }, this.limits.maximumWaitMs),
      };
      this.waiting.push(entry);
    });
  }

  private advance(): void {
    this.active = false;
    for (;;) {
      const entry = this.waiting.shift();
      if (entry === undefined) return;
      clearTimeout(entry.timer);
      // Timers can be delayed by synchronous work. Check the monotonic deadline
      // again at dequeue before allowing any accounting or storage operation.
      if (performance.now() >= entry.deadline) {
        entry.expire();
        continue;
      }
      entry.start();
      return;
    }
  }
}

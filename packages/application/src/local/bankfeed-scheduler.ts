import { bankfeedRuntime } from "../slices/bankfeed/runtime.ts";
import { type ScheduledOutcome, runScheduledSync } from "../slices/bankfeed/schedule.ts";
import { bankfeedStore } from "../slices/bankfeed/store.ts";
import type { ApplicationService } from "../service.ts";

export interface BankfeedSchedulerOptions {
  /** How often the scheduler looks at whether a sync is due. A sync is due by the owner's chosen time
   * of day, so this only sets how promptly a due one starts. */
  readonly tickMs?: number;
  /** The wait before the first look after start-up, so start-up itself stays quick. */
  readonly startupDelayMs?: number;
  /** The clock, for tests. */
  readonly now?: () => Date;
}

/**
 * The optional daily sync of a running local service: a timer that, every minute, asks whether a sync
 * is due and, if it is, runs it in the background. It does nothing until the owner turns the daily
 * sync on in the bank feed settings, and what it does is exactly a manual sync: the same request
 * budget (so it can never make the Bridge disable the access), the same Inbox, nothing posted. It
 * never runs inside a request, never lets an error escape a timer, and a failure is recorded where the
 * Bank feed screen reads it. A service opened by a test or a tool has no scheduler and the status says
 * so.
 */
export class BankfeedScheduler {
  private timers: ReturnType<typeof setInterval>[] = [];
  private running = false;
  private active = false;
  private readonly tickMs: number;
  private readonly startupDelayMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly service: ApplicationService,
    options: BankfeedSchedulerOptions = {},
  ) {
    this.tickMs = options.tickMs ?? 60_000;
    this.startupDelayMs = options.startupDelayMs ?? 8_000;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    bankfeedRuntime(this.service).scheduler = true;
    // A sync that was running when the last process stopped is not running now.
    try {
      bankfeedStore(this.service).closeStaleRuns(bankfeedRuntime(this.service).now());
    } catch {
      // The book may not have its product state yet; the store makes it on first use.
    }
    const first = setTimeout(() => void this.run(), this.startupDelayMs);
    first.unref?.();
    const timer = setInterval(() => void this.run(), this.tickMs);
    timer.unref?.();
    this.timers.push(first as unknown as ReturnType<typeof setInterval>, timer);
  }

  /** One pass, now. Never throws. */
  async run(): Promise<ScheduledOutcome | null> {
    if (this.running || !this.active) return null;
    this.running = true;
    try {
      return await runScheduledSync(this.service, this.now());
    } catch {
      return null;
    } finally {
      this.running = false;
    }
  }

  /** Stop the timers. A sync already running is left to finish: it writes only what it has applied. */
  stop(): void {
    for (const timer of this.timers) {
      clearInterval(timer);
      clearTimeout(timer as unknown as ReturnType<typeof setTimeout>);
    }
    this.timers = [];
    this.active = false;
    bankfeedRuntime(this.service).scheduler = false;
  }
}

/** Start the daily sync's timer for a local service. */
export function startBankfeedScheduler(
  service: ApplicationService,
  options: BankfeedSchedulerOptions = {},
): BankfeedScheduler {
  const scheduler = new BankfeedScheduler(service, options);
  scheduler.start();
  return scheduler;
}

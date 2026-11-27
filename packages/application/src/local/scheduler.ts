import {
  runAutomaticCycle,
  type CycleMemory,
  type CycleReport,
  type CycleTrigger,
} from "../safety/automatic.ts";
import { safetyRuntime } from "../safety/jobs.ts";
import { safetyStore } from "../safety/store.ts";
import type { SchedulerState } from "../safety/types.ts";
import type { ApplicationService } from "../service.ts";
import { LocalSafetyHost } from "./safety-host.ts";

export interface BackupSchedulerOptions {
  /** How often the scheduler looks at whether anything is due. A backup is due by the interval in
   * the settings, so this only sets how promptly a due one starts. */
  readonly tickMs?: number;
  /** The wait before the first look after start-up, so start-up itself stays quick. */
  readonly startupDelayMs?: number;
  /** How long a shutdown waits for a job already running before it stops it. */
  readonly shutdownWaitMs?: number;
}

/**
 * The automatic backups of a running local service: a timer that, every minute, asks whether a
 * backup (or a verification) is due and, if so, runs one in the background, and a final backup when
 * the service stops. It never runs in a request: the work is a worker thread, a failure is recorded
 * where the Backups screen reads it, and an error never escapes a timer. Created and started by
 * the process that owns the service (the API server); a service opened by a test or a tool has no
 * scheduler, and says so on the status.
 */
export class BackupScheduler {
  private timers: ReturnType<typeof setInterval>[] = [];
  private running = false;
  private active = false;
  private readonly memory: CycleMemory = { lastIdenticalAt: 0 };
  private readonly tickMs: number;
  private readonly startupDelayMs: number;
  private readonly shutdownWaitMs: number;

  constructor(
    private readonly service: ApplicationService,
    private readonly host: LocalSafetyHost,
    options: BackupSchedulerOptions = {},
  ) {
    this.tickMs = options.tickMs ?? 60_000;
    this.startupDelayMs = options.startupDelayMs ?? 5_000;
    this.shutdownWaitMs = options.shutdownWaitMs ?? 10_000;
  }

  state(): SchedulerState {
    return { active: this.active, nextRunAt: null };
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.host.attachScheduler(this);
    await this.host.cleanup().catch(() => {});
    const first = setTimeout(() => void this.run("startup"), this.startupDelayMs);
    first.unref?.();
    const timer = setInterval(() => void this.run("interval"), this.tickMs);
    timer.unref?.();
    this.timers.push(first as unknown as ReturnType<typeof setInterval>, timer);
  }

  /** One pass, now. Never throws: a failure is recorded, because nobody is waiting to read it. */
  async run(trigger: CycleTrigger): Promise<CycleReport | null> {
    if (this.running || !this.service.setupState()) return null;
    this.running = true;
    try {
      return await runAutomaticCycle(this.service, trigger, this.memory);
    } catch (error) {
      await this.host
        .recordAutomatic({
          at: safetyRuntime(this.service).now(),
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => {});
      return null;
    } finally {
      this.running = false;
    }
  }

  /** Stop the timers; if asked and the settings say so, take a last backup first. A job that is
   * still running when the wait ends is stopped, so shutdown is never held up for minutes. */
  async stop(
    options: { shutdownBackup: boolean } = { shutdownBackup: true },
  ): Promise<CycleReport | null> {
    for (const timer of this.timers) {
      clearInterval(timer);
      clearTimeout(timer as unknown as ReturnType<typeof setTimeout>);
    }
    this.timers = [];
    const wasActive = this.active;
    this.active = false;
    this.host.attachScheduler(null);
    if (!wasActive) return null;
    const runtime = safetyRuntime(this.service);
    if (!(await runtime.jobs.drain(this.shutdownWaitMs))) {
      this.host.abortAll();
      await runtime.jobs.drain(2_000);
    }
    if (!options.shutdownBackup || !this.service.setupState()) return null;
    this.running = true;
    try {
      safetyStore(this.service);
      return await runAutomaticCycle(this.service, "shutdown", this.memory);
    } catch (error) {
      await this.host
        .recordAutomatic({
          at: runtime.now(),
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => {});
      return null;
    } finally {
      this.running = false;
    }
  }
}

/** Start the automatic backups for a local service. Returns null when the service has no local
 * safety host (a runtime that cannot back up). */
export async function startBackupScheduler(
  service: ApplicationService,
  options: BackupSchedulerOptions = {},
): Promise<BackupScheduler | null> {
  const host = service.host.safety;
  if (!(host instanceof LocalSafetyHost)) return null;
  const scheduler = new BackupScheduler(service, host, options);
  await scheduler.start();
  return scheduler;
}

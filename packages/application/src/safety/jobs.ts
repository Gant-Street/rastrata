import type { BackupJob } from "../client-contracts.gen.ts";
import { ApplicationError } from "../errors.ts";
import type { ApplicationService } from "../service.ts";
import { sliceState } from "../slices/state.ts";
import type { JobKind, JobSnapshot, Progress, ProgressUpdate } from "./types.ts";

/** What a job's work hands back: the member named after its kind, plus whether it found nothing
 * new to do. */
export type JobResult = Partial<Pick<BackupJob, "backup" | "verification" | "drill" | "export">> & {
  readonly unchanged?: boolean;
};

/** Seconds left in a step, extrapolated from how far it has got. A copy costs about its progress, and
 * so does the replay of a book made with the chain-head state commitment; the replay of a book made
 * without it costs about the square of its progress (see replay-cost.ts, and the step says which in
 * `model`). Either way this is an estimate, so it is not offered until a tenth of the step is done and a
 * second and a half has passed. */
export function estimateRemainingMs(
  model: "linear" | "quadratic",
  stageElapsedMs: number,
  done: number | null,
  total: number | null,
): number | null {
  if (done === null || total === null || total <= 0) return null;
  if (done >= total) return 0;
  const fraction = done / total;
  if (fraction < 0.1 || stageElapsedMs < 1500) return null;
  const ratio = model === "quadratic" ? 1 / (fraction * fraction) - 1 : 1 / fraction - 1;
  return Math.round(stageElapsedMs * ratio);
}

const message = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").slice(0, 580) || "The job failed";
};

export class ActiveJob {
  stage: string;
  done: number | null = null;
  total: number | null = null;
  private model: "linear" | "quadratic" = "linear";
  private stageStartedAt: number;
  readonly startedAt: Date;
  readonly promise: Promise<BackupJob>;
  /** Set when the job ends, so a late look still finds its final answer. */
  result: BackupJob | null = null;

  constructor(
    readonly kind: JobKind,
    readonly operationId: string | null,
    private readonly now: () => Date,
    run: (progress: Progress) => Promise<JobResult>,
    onSettled: (job: ActiveJob) => void,
  ) {
    this.startedAt = now();
    this.stageStartedAt = this.startedAt.getTime();
    this.stage = "Starting";
    this.promise = (async (): Promise<BackupJob> => {
      let outcome: BackupJob;
      try {
        // Yield first so begin() returns before the work runs.
        await Promise.resolve();
        const found = await run((update) => this.update(update));
        outcome = this.finish("done", found);
      } catch (error) {
        outcome = this.finish("failed", {}, error);
      }
      this.result = outcome;
      onSettled(this);
      return outcome;
    })();
  }

  private update(update: ProgressUpdate): void {
    if (update.stage !== undefined && update.stage !== this.stage) {
      this.stage = update.stage.slice(0, 200);
      this.stageStartedAt = this.now().getTime();
      this.done = null;
      this.total = null;
    }
    if (update.model) this.model = update.model;
    if (update.done !== undefined) this.done = update.done;
    if (update.total !== undefined) this.total = update.total;
  }

  snapshot(): JobSnapshot {
    const at = this.now().getTime();
    return {
      kind: this.kind,
      startedAt: this.startedAt.toISOString(),
      stage: this.stage,
      done: this.done,
      total: this.total,
      elapsedMs: Math.max(0, at - this.startedAt.getTime()),
      remainingMs: estimateRemainingMs(
        this.model,
        Math.max(0, at - this.stageStartedAt),
        this.done,
        this.total,
      ),
    };
  }

  /** The job as an operation answers with it, running or not. */
  describe(): BackupJob {
    return this.result ?? { state: "running", ...this.snapshot() };
  }

  private finish(state: "done" | "failed", found: JobResult, error?: unknown): BackupJob {
    const at = this.now();
    const failure =
      error === undefined
        ? undefined
        : {
            code: error instanceof ApplicationError ? error.code : "backup_failed",
            message: message(error),
          };
    return {
      state,
      kind: this.kind,
      startedAt: this.startedAt.toISOString(),
      finishedAt: at.toISOString(),
      stage: state === "done" ? "Finished" : "Stopped",
      done: this.done,
      total: this.total,
      elapsedMs: Math.max(0, at.getTime() - this.startedAt.getTime()),
      remainingMs: null,
      ...(failure ? { error: failure } : {}),
      ...(found.backup ? { backup: found.backup } : {}),
      ...(found.verification ? { verification: found.verification } : {}),
      ...(found.drill ? { drill: found.drill } : {}),
      ...(found.export ? { export: found.export } : {}),
    };
  }
}

/** One long job at a time per book: they all read or write a whole database, and a person is
 * better served by "a verification is already running" than by two of them fighting over the disk. */
export class SafetyJobs {
  private current: ActiveJob | null = null;
  private readonly byOperation = new Map<string, ActiveJob>();
  constructor(private readonly now: () => Date) {}

  active(): ActiveJob | null {
    return this.current;
  }

  find(operationId: string): ActiveJob | undefined {
    return this.byOperation.get(operationId);
  }

  begin(
    kind: JobKind,
    operationId: string | null,
    run: (progress: Progress) => Promise<JobResult>,
  ): ActiveJob {
    const running = this.current;
    if (running)
      throw new ApplicationError(
        "backup_busy",
        `A ${running.kind} is already running (started ${running.startedAt.toISOString()}). Wait for it to finish, then try again.`,
        409,
        [],
        true,
      );
    const job = new ActiveJob(kind, operationId, this.now, run, (settled) => {
      if (this.current === settled) this.current = null;
      // A finished job is answered from the retained request, not from memory; forget it soon.
      if (settled.operationId)
        setTimeout(() => this.byOperation.delete(settled.operationId as string), 60_000).unref?.();
    });
    this.current = job;
    if (operationId) this.byOperation.set(operationId, job);
    return job;
  }

  /** Wait for every job to end, up to `limitMs`. Used on shutdown. */
  async drain(limitMs: number): Promise<boolean> {
    const job = this.current;
    if (!job) return true;
    const timer = Promise.withResolvers<boolean>();
    const handle = setTimeout(() => timer.resolve(false), limitMs);
    void job.promise.then(() => timer.resolve(true));
    const finished = await timer.promise;
    clearTimeout(handle);
    return finished;
  }
}

/** Per-service runtime of the safety lane: the job slot and how long an operation waits for its
 * job before answering "running". */
export interface SafetyRuntime {
  readonly jobs: SafetyJobs;
  waitMs: number;
  now: () => Date;
}

/** How long an operation waits for its job before answering "running". `RASTRATA_SAFETY_WAIT_MS`
 * shortens it (0 answers at once), which is how a test sees a job's progress on a small book. */
function configuredWait(): number {
  const raw = typeof process === "undefined" ? undefined : process.env.RASTRATA_SAFETY_WAIT_MS;
  const value = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= 30_000 ? value : 4000;
}

export function safetyRuntime(service: ApplicationService): SafetyRuntime {
  return sliceState(service, "safety-runtime", () => {
    const runtime: SafetyRuntime = {
      waitMs: configuredWait(),
      now: () => new Date(service.now()),
      jobs: undefined as unknown as SafetyJobs,
    };
    (runtime as { jobs: SafetyJobs }).jobs = new SafetyJobs(() => runtime.now());
    return runtime;
  });
}

/** Tests tune the runtime: a short wait so "running" answers are quick, a fixed clock. */
export function configureSafety(
  service: ApplicationService,
  options: { waitMs?: number; now?: () => Date },
): void {
  const runtime = safetyRuntime(service);
  if (options.waitMs !== undefined) runtime.waitMs = options.waitMs;
  if (options.now) runtime.now = options.now;
}

/**
 * Run a long operation as a retained, resumable job. The first call starts the job and waits a few
 * seconds for it; a job that is still running answers `state: "running"` with its progress. Asking
 * again with the same operation identity attaches to the same job, never starts a second one, and
 * the finished answer is retained like any other write, so it survives a lost reply. A restart in
 * the middle leaves the identity unresolved, and asking again runs the job afresh.
 */
export async function runJobOperation(
  service: ApplicationService,
  call: { operationId: string; operation: string; input: unknown; kind: JobKind },
  run: (progress: Progress) => Promise<JobResult>,
): Promise<BackupJob> {
  const runtime = safetyRuntime(service);
  const retained = service.retainAsyncRequest<BackupJob>(
    call.operationId,
    call.operation,
    call.input,
    () => {
      const existing = runtime.jobs.find(call.operationId);
      return (existing ?? runtime.jobs.begin(call.kind, call.operationId, run)).promise;
    },
  );
  const timer = Promise.withResolvers<null>();
  const handle = setTimeout(() => timer.resolve(null), runtime.waitMs);
  try {
    const answer = await Promise.race([retained, timer.promise]);
    if (answer) return answer;
  } finally {
    clearTimeout(handle);
  }
  // Still running. Keep the retained write alive without leaving a rejection nobody reads.
  retained.catch(() => {});
  const job = runtime.jobs.find(call.operationId);
  if (!job)
    throw new ApplicationError(
      "operation_unresolved",
      "The job is not running. Ask again with the same operation identity.",
      503,
      [],
      true,
    );
  return job.describe();
}

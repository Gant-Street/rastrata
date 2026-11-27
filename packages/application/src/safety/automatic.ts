import type { ApplicationService } from "../service.ts";
import { safetyRuntime, type JobResult } from "./jobs.ts";
import { applyRetention, createBackup, safetyHost, verifyBackup } from "./operations.ts";
import { safetyStore } from "./store.ts";
import type { BackupReason, StoredBackup } from "./types.ts";

const HOUR = 3_600_000;

export type CycleTrigger = "startup" | "interval" | "shutdown";

export interface CycleMemory {
  /** When the newest backup's content was last compared with the database and found identical,
   * so an idle book is not snapshotted again every minute. In memory only: a restart checks once. */
  lastIdenticalAt: number;
}

export interface CycleReport {
  /** `none`: nothing was due. `busy`: another job holds the slot; try again later. */
  readonly action: "none" | "busy" | "backup" | "verify" | "disabled" | "failed";
  readonly createdId: string | null;
  readonly reused: boolean;
  readonly verifiedId: string | null;
  readonly verificationPassed: boolean | null;
  readonly removed: readonly string[];
  readonly error: string | null;
}

const idle = (action: CycleReport["action"]): CycleReport => ({
  action,
  createdId: null,
  reused: false,
  verifiedId: null,
  verificationPassed: null,
  removed: [],
  error: null,
});

const needsVerification = (item: StoredBackup, now: number, intervalMs: number): boolean =>
  item.fileState === "present" &&
  (!item.verification || now - Date.parse(item.verification.verifiedAt) >= intervalMs);

/**
 * One pass of the automatic backups, run by the local scheduler on a timer and at shutdown. It
 * takes a backup when one is due (the interval has passed since the newest, or the newest is
 * missing or failed verification), verifies the newest backup when it has not been verified within
 * the interval, then applies retention. It holds the job slot, so it never overlaps a person's own
 * verification, and it records what happened beside the backups so a failure is visible. On
 * shutdown it only takes the backup: verifying would keep the process alive for as long as a replay of
 * the book takes (seconds for a book made with the chain-head state commitment, minutes for an older one).
 */
export async function runAutomaticCycle(
  service: ApplicationService,
  trigger: CycleTrigger,
  memory: CycleMemory,
): Promise<CycleReport> {
  const host = safetyHost(service);
  const runtime = safetyRuntime(service);
  const settings = safetyStore(service).settings();
  if (!settings.enabled || (trigger === "shutdown" && !settings.onShutdown))
    return idle("disabled");
  const now = runtime.now().getTime();
  const intervalMs = settings.intervalHours * HOUR;
  const { backups } = await host.listBackups();
  const newest = backups[0];
  const lastChecked = Math.max(
    newest ? Date.parse(newest.manifest.createdAt) : 0,
    memory.lastIdenticalAt,
  );
  const needsNew =
    trigger === "shutdown"
      ? true
      : !newest ||
        newest.fileState === "missing" ||
        newest.verification?.passed === false ||
        now - lastChecked >= intervalMs;
  const wantsVerify =
    settings.verifyAfterBackup && trigger !== "shutdown" && newest
      ? needsVerification(newest, now, intervalMs)
      : false;
  if (!needsNew && !wantsVerify) return idle("none");

  const report = {
    ...idle("backup"),
  } as { -readonly [K in keyof CycleReport]: CycleReport[K] };
  const reason: BackupReason =
    trigger === "shutdown" ? "shutdown" : trigger === "startup" ? "startup" : "scheduled";
  let job: ReturnType<typeof runtime.jobs.begin>;
  try {
    job = runtime.jobs.begin("backup", null, async (progress): Promise<JobResult> => {
      let result: JobResult = {};
      let target: StoredBackup | undefined = needsNew ? undefined : newest;
      if (needsNew) {
        result = await createBackup(service, reason, progress);
        report.createdId = result.backup?.id ?? null;
        report.reused = result.unchanged === true;
        if (report.reused) memory.lastIdenticalAt = now;
        target = (await host.listBackups()).backups.find(
          (item) => item.manifest.id === result.backup?.id,
        );
      }
      if (
        settings.verifyAfterBackup &&
        trigger !== "shutdown" &&
        target &&
        needsVerification(target, now, intervalMs)
      ) {
        const verified = await verifyBackup(service, target.manifest.id, progress);
        report.verifiedId = target.manifest.id;
        report.verificationPassed = verified.verification?.passed ?? null;
        result = { ...result, ...verified };
        if (verified.verification && !verified.verification.passed) {
          const failed = verified.verification.checks.find((check) => check.status === "failed");
          report.error = `The backup ${target.manifest.id} failed verification${failed ? `: ${failed.message}` : "."}`;
        }
      }
      if (!report.error) report.removed = (await applyRetention(service)).removed;
      return result;
    });
  } catch {
    return idle("busy");
  }
  const finished = await job.promise;
  if (report.verifiedId && !report.createdId) report.action = "verify";
  if (finished.state === "failed") {
    report.action = "failed";
    report.error = finished.error?.message ?? "The automatic backup did not finish";
  }
  const at = runtime.now();
  await host
    .recordAutomatic(report.error ? { at, ok: false, error: report.error } : { at, ok: true })
    .catch(() => {});
  return report;
}

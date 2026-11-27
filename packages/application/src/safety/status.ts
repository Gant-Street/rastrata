import type {
  BackupDrillResult,
  BackupRecord,
  BackupStatus,
  BackupWarning,
} from "../client-contracts.gen.ts";
import type {
  AutomaticRun,
  BackupSettings,
  DrillRecord,
  JobSnapshot,
  LedgerHead,
  SchedulerState,
  StoredBackup,
} from "./types.ts";

const HOUR = 3_600_000;

export function toBackupRecord(stored: StoredBackup): BackupRecord {
  const { manifest, verification } = stored;
  return {
    id: manifest.id,
    createdAt: manifest.createdAt,
    reason: manifest.reason,
    fileName: manifest.file.name,
    bytes: manifest.file.bytes,
    sha256: manifest.file.sha256,
    head: manifest.ledger.head,
    bookName: manifest.book.name,
    currency: manifest.book.currency,
    release: manifest.application.release,
    schemaVersion:
      Object.entries(manifest.application.stores)
        .map(([name, version]) => `${name} ${version}`)
        .join(", ") || "none",
    fileState: stored.fileState,
    verification: verification
      ? {
          verifiedAt: verification.verifiedAt,
          passed: verification.passed,
          durationMs: verification.durationMs,
          replayMs: verification.replayMs,
          checks: [...verification.checks],
        }
      : null,
  };
}

export const toDrillResult = (record: DrillRecord): BackupDrillResult => ({
  backupId: record.backupId,
  ranAt: record.ranAt,
  passed: record.passed,
  durationMs: record.durationMs,
  replayMs: record.replayMs,
  restoredHead: record.restoredHead,
  liveHead: record.liveHead,
  changesSince: record.changesSince,
  accountsCompared: record.accountsCompared,
  mismatches: [...record.mismatches],
  checks: [...record.checks],
});

export interface StatusFacts {
  readonly now: Date;
  readonly directory: string;
  readonly settings: BackupSettings;
  readonly scheduler: SchedulerState;
  readonly automatic: AutomaticRun;
  readonly activeJob: JobSnapshot | null;
  readonly liveHead: LedgerHead;
  /** Newest first. */
  readonly backups: readonly StoredBackup[];
  readonly lastDrill: DrillRecord | null;
  readonly sameDisk: boolean | null;
}

const ago = (now: Date, then: string): string => {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(then)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
};

/** The one place that decides what the safety of the book is: pure, so every sentence a person is
 * shown has a test. Warnings are ordered most serious first, and say what to do. */
export function buildBackupStatus(facts: StatusFacts): BackupStatus {
  const { now, settings } = facts;
  const latest = facts.backups[0] ?? null;
  const latestVerified =
    facts.backups.find(
      (item) => item.verification?.passed === true && item.fileState === "present",
    ) ?? null;
  const live = BigInt(facts.liveHead.sequence);
  const changesSinceLatest = latest
    ? BigInt(latest.manifest.ledger.head.sequence) <= live
      ? Number(live - BigInt(latest.manifest.ledger.head.sequence))
      : null
    : null;
  const warnings: BackupWarning[] = [];
  const warn = (code: string, tone: BackupWarning["tone"], message: string) =>
    warnings.push({ code, tone, message });

  if (facts.backups.length === 0)
    warn(
      "never_backed_up",
      "error",
      "This book has never been backed up. Back it up now: a backup is a complete copy you can restore if this computer fails.",
    );
  if (latest && latest.fileState === "missing")
    warn(
      "backup_file_missing",
      "error",
      `The newest backup (${latest.manifest.id}) is recorded but its file is missing from the backup folder.`,
    );
  if (latest?.verification && !latest.verification.passed)
    warn(
      "verification_failed",
      "error",
      `The newest backup (${latest.manifest.id}) failed verification. Do not rely on it; take a new backup and verify it.`,
    );
  if (latest && changesSinceLatest === null)
    warn(
      "backup_ahead",
      "review",
      "The newest backup is ahead of this book. The book may have been restored from an older copy or replaced. Check before relying on either.",
    );
  if (facts.backups.length > 0 && !latestVerified)
    warn(
      "never_verified",
      "review",
      "No backup has passed verification. A backup that has not been verified may not restore. Verify the newest one.",
    );
  else if (latestVerified?.verification) {
    const age = now.getTime() - Date.parse(latestVerified.verification.verifiedAt);
    if (age > settings.warnAfterHours * HOUR)
      warn(
        "stale_verification",
        "review",
        `The last verified backup was verified ${ago(now, latestVerified.verification.verifiedAt)}, more than ${settings.warnAfterHours} hours ago. Verify a backup again.`,
      );
  }
  if (facts.automatic.lastRunOk === false)
    warn(
      "automatic_failed",
      "error",
      `The last automatic backup did not finish${facts.automatic.lastRunAt ? ` (${ago(now, facts.automatic.lastRunAt)})` : ""}: ${facts.automatic.lastError ?? "no reason was recorded"}`,
    );
  if (!settings.enabled)
    warn(
      "automatic_off",
      "review",
      "Automatic backups are turned off. Nothing is backed up unless you do it yourself.",
    );
  else if (!facts.scheduler.active)
    warn(
      "scheduler_not_running",
      "info",
      "Automatic backups are on, but this service was started without the backup timer, so none will run until it is restarted normally.",
    );
  if (facts.lastDrill && !facts.lastDrill.passed)
    warn(
      "drill_failed",
      "error",
      `The last restore drill (${ago(now, facts.lastDrill.ranAt)}) failed. A backup that does not restore is not a safety net; see the checks.`,
    );
  else if (!facts.lastDrill && facts.backups.length > 0)
    warn(
      "drill_never",
      "info",
      "You have not tested a restore. A restore drill proves, without touching your book, that the newest backup rebuilds the same books.",
    );
  if (facts.sameDisk === true)
    warn(
      "same_disk",
      "info",
      "Backups are on the same disk as your book. If that disk fails you lose both: copy the backup folder to another drive or storage you trust.",
    );

  const rank = { error: 0, review: 1, info: 2 } as const;
  warnings.sort((a, b) => rank[a.tone] - rank[b.tone]);

  const next = facts.scheduler.nextRunAt;
  return {
    generatedAt: now.toISOString(),
    directory: facts.directory,
    settings,
    automatic: {
      enabled: settings.enabled,
      scheduler: !settings.enabled ? "off" : facts.scheduler.active ? "active" : "not_running",
      lastRunAt: facts.automatic.lastRunAt,
      lastRunOk: facts.automatic.lastRunOk,
      lastError: facts.automatic.lastError,
      nextRunAt: settings.enabled && facts.scheduler.active ? next : null,
    },
    activeJob: facts.activeJob
      ? {
          kind: facts.activeJob.kind,
          startedAt: facts.activeJob.startedAt,
          stage: facts.activeJob.stage,
          done: facts.activeJob.done,
          total: facts.activeJob.total,
          elapsedMs: facts.activeJob.elapsedMs,
          remainingMs: facts.activeJob.remainingMs,
        }
      : null,
    liveHead: facts.liveHead,
    latest: latest ? toBackupRecord(latest) : null,
    latestVerified: latestVerified ? toBackupRecord(latestVerified) : null,
    lastDrill: facts.lastDrill ? toDrillResult(facts.lastDrill) : null,
    changesSinceLatest,
    backupCount: facts.backups.length,
    warnings: warnings.slice(0, 20),
  };
}

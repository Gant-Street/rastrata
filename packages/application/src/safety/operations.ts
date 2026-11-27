import type {
  BackupJob,
  BackupList,
  BackupStatus,
  BackupVerification,
  ExportList,
} from "../client-contracts.gen.ts";
import { ApplicationError } from "../errors.ts";
import type { ApplicationService } from "../service.ts";
import { balancesThrough, compareBalances } from "./balances.ts";
import type { ExportHost, SafetyHost } from "./host.ts";
import { safetyRuntime, type JobResult } from "./jobs.ts";
import { planRetention } from "./retention.ts";
import { buildBackupStatus, toBackupRecord } from "./status.ts";
import { safetyStore } from "./store.ts";
import type {
  BackupReason,
  Check,
  DrillRecord,
  Progress,
  StoredBackup,
  VerificationRecord,
} from "./types.ts";

/** The host port that does the file and database work. A runtime that cannot back up (the hosted
 * ledger, a test double) leaves it out, and every operation says so plainly. */
export function safetyHost(service: ApplicationService): SafetyHost {
  const host = service.host.safety;
  if (!host)
    throw new ApplicationError(
      "backup_unavailable",
      // A runtime that makes exports and no backups is a hosted one: it keeps the history of the books itself, which is what a person is to be told.
      service.host.exports
        ? "This service keeps the history of the books itself, so there are no backups to make or check here. To keep a copy of your own, make an export (export.create)."
        : "This runtime cannot make backups or exports. Run the local application service (bun run dev:api) to use them.",
      501,
    );
  return host;
}

/** The host port that writes and finds exports: the safety host's, or the exports-only one of a runtime that cannot back up. */
export function exportHost(service: ApplicationService): ExportHost {
  const host = service.host.exports ?? service.host.safety;
  if (!host)
    throw new ApplicationError(
      "backup_unavailable",
      "This runtime cannot make exports. Run the local application service (bun run dev:api) to use them.",
      501,
    );
  return host;
}

export async function readStatus(service: ApplicationService): Promise<BackupStatus> {
  const host = safetyHost(service);
  const runtime = safetyRuntime(service);
  const store = safetyStore(service);
  const [listed, automatic, sameDisk, live] = await Promise.all([
    host.listBackups(),
    host.automaticState(),
    host.onSameDisk(),
    service.readAggregate(),
  ]);
  return buildBackupStatus({
    now: runtime.now(),
    directory: host.directories.backups,
    settings: store.settings(),
    scheduler: host.scheduler(),
    automatic,
    activeJob: runtime.jobs.active()?.snapshot() ?? null,
    liveHead: live.head,
    backups: listed.backups,
    lastDrill: store.lastDrill(),
    sameDisk,
  });
}

export async function listBackups(service: ApplicationService): Promise<BackupList> {
  const host = safetyHost(service);
  const listed = await host.listBackups();
  return {
    directory: host.directories.backups,
    backups: listed.backups.map(toBackupRecord),
    unrecorded: [...listed.unrecorded],
  };
}

export async function listExports(service: ApplicationService): Promise<ExportList> {
  const host = exportHost(service);
  const found = await host.listExports();
  return {
    directory: host.directories.exports,
    exports: found.map((item) => ({
      id: item.manifest.id,
      createdAt: item.manifest.createdAt,
      format: item.manifest.format,
      location: item.location,
      head: item.manifest.ledger.head,
      counts: item.manifest.counts,
      bytes: item.bytes,
      files: [...item.manifest.files],
      manifestSha256: item.manifest.manifestSha256,
    })),
  };
}

async function pickBackup(service: ApplicationService, backupId?: string): Promise<StoredBackup> {
  const listed = await safetyHost(service).listBackups();
  const found = backupId
    ? listed.backups.find((item) => item.manifest.id === backupId)
    : listed.backups[0];
  if (!found)
    throw new ApplicationError(
      "backup_not_found",
      backupId
        ? `There is no backup ${backupId}. Use backup.list to see the backups.`
        : "There are no backups yet. Create one first.",
      404,
    );
  return found;
}

export async function createBackup(
  service: ApplicationService,
  reason: BackupReason,
  progress: Progress,
): Promise<JobResult> {
  const host = safetyHost(service);
  progress({ stage: "Copying the database", model: "linear" });
  // Only the automatic backups skip a snapshot that is byte for byte the newest backup: a person who
  // asks for a backup gets one. (Their own request is recorded in the database, so a second ask is
  // never identical anyway.)
  const made = await host.createBackup(reason, safetyRuntime(service).now(), progress, {
    reuseIdentical: reason !== "manual",
  });
  const listed = await host.listBackups();
  const stored = listed.backups.find((item) => item.manifest.id === made.manifest.id);
  if (!stored)
    throw new ApplicationError("backup_failed", "The backup was written but cannot be found.", 500);
  return { backup: toBackupRecord(stored), ...(made.reused ? { unchanged: true } : {}) };
  // `unchanged` is for the scheduler's report; it never reaches a client (see BackupJob).
}

const toVerification = (record: VerificationRecord): BackupVerification => ({
  backupId: record.backupId,
  verifiedAt: record.verifiedAt,
  passed: record.passed,
  durationMs: record.durationMs,
  replayMs: record.replayMs,
  outcomes: record.outcomes,
  journals: record.journals,
  head: record.head,
  checks: [...record.checks],
});

export async function verifyBackup(
  service: ApplicationService,
  backupId: string | undefined,
  progress: Progress,
): Promise<JobResult> {
  const host = safetyHost(service);
  const runtime = safetyRuntime(service);
  const stored = await pickBackup(service, backupId);
  const started = runtime.now().getTime();
  const outcome = await host.verifyBackup(stored.manifest, progress);
  const finished = runtime.now();
  const record: VerificationRecord = {
    backupId: stored.manifest.id,
    verifiedAt: finished.toISOString(),
    passed: outcome.passed,
    durationMs: Math.max(0, finished.getTime() - started),
    replayMs: outcome.replayMs,
    outcomes: outcome.outcomes,
    journals: outcome.journals,
    head: outcome.head,
    checks: outcome.checks,
  };
  await host.recordVerification(record);
  return { verification: toVerification(record) };
}

/** Restore the backup into a scratch copy and compare it with the live book: the head it reaches,
 * the kernel's revision chain at that revision, and every account balance at the same revision.
 * One replay (in the copy); the live side is already verified, so it costs almost nothing. */
export async function drillBackup(
  service: ApplicationService,
  backupId: string | undefined,
  progress: Progress,
): Promise<JobResult> {
  const host = safetyHost(service);
  const runtime = safetyRuntime(service);
  const stored = await pickBackup(service, backupId);
  const started = runtime.now().getTime();
  const outcome = await host.drillBackup(stored.manifest, progress);
  progress({ stage: "Comparing with your live book", done: null, total: null });
  const live = await service.readAggregate();
  const checks: Check[] = [...outcome.checks];
  const mismatches: { accountId: string; live: string; restored: string }[] = [];
  let accounts = 0;
  let changesSince: number | null = null;
  const restored = outcome.restoredHead;
  if (restored) {
    const liveSequence = BigInt(live.head.sequence);
    const restoredSequence = BigInt(restored.sequence);
    changesSince =
      restoredSequence <= liveSequence ? Number(liveSequence - restoredSequence) : null;
    const revision = BigInt(restored.bookRevision);
    const liveRevision = live.aggregate.state.revisions.find(
      (item) => item.bookRevision === revision,
    );
    if (!liveRevision)
      checks.push({
        code: "kernel_chain",
        status: "failed",
        message:
          "The live book has no revision matching the backup's, so the backup is not an earlier copy of this book. It may belong to a different book.",
      });
    else if (outcome.kernelChain === null)
      checks.push({
        code: "kernel_chain",
        status: "skipped",
        message: "The restored copy did not reach a revision to compare.",
      });
    else if (liveRevision.chainHash.digest !== outcome.kernelChain)
      checks.push({
        code: "kernel_chain",
        status: "failed",
        message: `The restored copy and the live book disagree at revision ${restored.bookRevision}: the restored books are not an earlier state of this book.`,
      });
    else
      checks.push({
        code: "kernel_chain",
        status: "passed",
        message: `Revision ${restored.bookRevision} has the same chain hash in the restored copy and in the live book.`,
      });
    if (outcome.balances && liveRevision) {
      const compared = compareBalances(
        balancesThrough(live.aggregate.state, revision),
        outcome.balances,
      );
      accounts = compared.accounts;
      mismatches.push(...compared.mismatches.slice(0, 200));
      checks.push(
        compared.mismatches.length === 0
          ? {
              code: "trial_balance",
              status: "passed",
              message: `All ${compared.accounts} account balances equal the live book's at revision ${restored.bookRevision} (${changesSince ?? 0} later changes are not compared).`,
            }
          : {
              code: "trial_balance",
              status: "failed",
              message: `${compared.mismatches.length} of ${compared.accounts} account balances differ from the live book at revision ${restored.bookRevision}.`,
            },
      );
    } else
      checks.push({
        code: "trial_balance",
        status: "skipped",
        message: "No balances were compared because the restored copy could not be replayed.",
      });
  }
  const finished = runtime.now();
  const record: DrillRecord = {
    backupId: stored.manifest.id,
    ranAt: finished.toISOString(),
    passed: checks.every((check) => check.status !== "failed") && mismatches.length === 0,
    durationMs: Math.max(0, finished.getTime() - started),
    replayMs: outcome.replayMs,
    restoredHead: restored,
    liveHead: live.head,
    changesSince,
    accountsCompared: accounts,
    mismatches,
    checks,
  };
  safetyStore(service).recordDrill(record);
  return {
    drill: {
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
    },
  };
}

/** Remove automatic backups the retention settings no longer keep. Manual backups, the newest
 * backup and the newest verified backup are never removed. */
export async function applyRetention(
  service: ApplicationService,
): Promise<{ removed: string[]; failed: string[] }> {
  const host = safetyHost(service);
  const listed = await host.listBackups();
  const plan = planRetention(listed.backups, safetyStore(service).settings());
  const byId = new Map(listed.backups.map((item) => [item.manifest.id, item]));
  const removed: string[] = [];
  const failed: string[] = [];
  for (const id of plan.remove) {
    const target = byId.get(id);
    if (!target) continue;
    try {
      await host.deleteBackup(target.manifest);
      removed.push(id);
    } catch {
      failed.push(id);
    }
  }
  return { removed, failed };
}

export type { BackupJob };

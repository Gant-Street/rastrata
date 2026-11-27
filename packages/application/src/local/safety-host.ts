import { randomBytes } from "node:crypto";
import { existsSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { ApplicationError } from "../errors.ts";
import type { ExportSink, SafetyHost } from "../safety/host.ts";
import { backupIdFor, sealBackupManifest } from "../safety/manifest.ts";
import {
  APPLICATION_RELEASE,
  type AutomaticRun,
  type BackupManifest,
  type BackupReason,
  type DrillOutcome,
  type Progress,
  type SchedulerState,
  type StoredBackup,
  type StoredExport,
  type VerificationOutcome,
  type VerificationRecord,
} from "../safety/types.ts";
import { BackupFolder } from "./backup-folder.ts";
import { DirectoryExportSink, listExportFolders } from "./export-sink.ts";
import { deviceOf, ensurePrivateDirectory, freeBytes, fsyncDirectory, sizeLabel } from "./files.ts";
import type { SnapshotResult } from "./snapshot.ts";
import type { VerifyTask } from "./verify.ts";
import { runInWorker, terminateWorkers, workerEntry } from "./worker.ts";

export interface LocalSafetyOptions {
  /** Where backups are kept. Defaults to `RASTRATA_BACKUP_DIR`, else `backups/<book>/` beside the
   * database. */
  readonly backupDirectory?: string;
  /** Where exports are kept. Defaults to `RASTRATA_EXPORT_DIR`, else `exports/<book>/` beside the
   * database. */
  readonly exportDirectory?: string;
  /** Replaces the free-space probe, for tests that need a full disk. */
  readonly freeBytes?: (path: string) => number | null;
}

/** What the scheduler lets the host say about it. */
export interface SchedulerHandle {
  state(): SchedulerState;
}

/** The local runtime's half of the safety lane: it makes snapshots and replays in worker threads,
 * keeps backups and exports in folders, and answers for the scheduler. Everything that could take
 * long happens off the service's event loop. */
export class LocalSafetyHost implements SafetyHost {
  readonly directories: { readonly backups: string; readonly exports: string };
  readonly folder: BackupFolder;
  private scheduling: SchedulerHandle | null = null;
  /** The last automatic run as this process saw it. A backup folder that cannot be written (a full
   * disk, a missing drive) cannot record its own failure, so the failure is also kept here. */
  private lastRun: AutomaticRun | null = null;
  private readonly freeBytesOf: (path: string) => number | null;

  constructor(
    readonly databasePath: string,
    options: LocalSafetyOptions = {},
  ) {
    const book = basename(databasePath, extname(databasePath)) || "book";
    this.directories = {
      backups:
        options.backupDirectory ??
        process.env.RASTRATA_BACKUP_DIR ??
        join(dirname(databasePath), "backups", book),
      exports:
        options.exportDirectory ??
        process.env.RASTRATA_EXPORT_DIR ??
        join(dirname(databasePath), "exports", book),
    };
    this.folder = new BackupFolder(this.directories.backups);
    this.freeBytesOf = options.freeBytes ?? freeBytes;
  }

  attachScheduler(handle: SchedulerHandle | null): void {
    this.scheduling = handle;
  }

  scheduler(): SchedulerState {
    return this.scheduling?.state() ?? { active: false, nextRunAt: null };
  }

  /** Stop every worker this process started. */
  abortAll(): void {
    terminateWorkers();
  }

  async cleanup(): Promise<void> {
    await this.folder.cleanTransient();
  }

  async createBackup(
    reason: BackupReason,
    now: Date,
    progress?: Progress,
    options: { readonly reuseIdentical?: boolean } = {},
  ): Promise<{ readonly manifest: BackupManifest; readonly reused: boolean }> {
    const folder = this.folder;
    folder.ensure();
    let needed = statSync(this.databasePath).size;
    if (existsSync(`${this.databasePath}-wal`)) needed += statSync(`${this.databasePath}-wal`).size;
    const free = this.freeBytesOf(folder.directory);
    if (free !== null && free < needed * 1.1 + 1_048_576)
      throw new ApplicationError(
        "backup_no_space",
        `There is not enough free space in ${folder.directory} for a backup: about ${sizeLabel(needed)} is needed and ${sizeLabel(free)} is free. Free some space, or keep backups somewhere else with RASTRATA_BACKUP_DIR.`,
        507,
      );
    const partial = folder.path(`.snapshot-${randomBytes(6).toString("hex")}.partial`);
    progress?.({ stage: "Copying the database", done: null, total: null, model: "linear" });
    let snapshot: SnapshotResult;
    try {
      snapshot = await runInWorker<SnapshotResult>(workerEntry("snapshot-worker.ts"), {
        source: this.databasePath,
        target: partial,
      });
    } catch (error) {
      rmSync(partial, { force: true });
      throw new ApplicationError(
        "backup_failed",
        `The backup could not be made: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          590,
        ),
        500,
      );
    }
    try {
      const listed = await folder.list();
      const newest = listed.backups[0];
      if (
        options.reuseIdentical &&
        newest &&
        newest.fileState === "present" &&
        newest.verification?.passed !== false &&
        newest.manifest.file.sha256 === snapshot.sha256 &&
        newest.manifest.file.bytes === snapshot.bytes
      ) {
        rmSync(partial, { force: true });
        return { manifest: newest.manifest, reused: true };
      }
      // A backup is named by when it was made, how far the ledger had got and which chain. Two made
      // in the same second at the same position would share a name, so the later one is dated a second
      // on rather than overwriting or being thrown away: a person who asks for a backup gets one.
      let madeAt = new Date(now.getTime());
      let id = backupIdFor(madeAt.toISOString(), snapshot.head);
      const taken = new Set([
        ...listed.backups.map((item) => item.manifest.id),
        ...listed.unrecorded.map((name) => name.replace(/\.(manifest\.json|sqlite)$/, "")),
      ]);
      for (let attempt = 0; taken.has(id) && attempt < 3600; attempt++) {
        madeAt = new Date(madeAt.getTime() + 1000);
        id = backupIdFor(madeAt.toISOString(), snapshot.head);
      }
      const name = `${id}.sqlite`;
      renameSync(partial, folder.path(name));
      fsyncDirectory(folder.directory);
      const manifest = await sealBackupManifest({
        id,
        createdAt: madeAt.toISOString(),
        reason,
        file: { name, bytes: snapshot.bytes, sha256: snapshot.sha256 },
        ledger: {
          formatId: snapshot.ledgerFormat,
          head: snapshot.head,
          genesisSha256: snapshot.genesisSha256,
        },
        application: { release: APPLICATION_RELEASE, stores: snapshot.stores },
        book: snapshot.book,
      });
      folder.writeManifest(manifest);
      return { manifest, reused: false };
    } catch (error) {
      rmSync(partial, { force: true });
      throw error;
    }
  }

  listBackups(): Promise<{
    readonly backups: readonly StoredBackup[];
    readonly unrecorded: readonly string[];
  }> {
    return this.folder.list();
  }

  private scratch(): string {
    ensurePrivateDirectory(this.folder.scratchRoot);
    return join(this.folder.scratchRoot, randomBytes(6).toString("hex"));
  }

  async verifyBackup(manifest: BackupManifest, progress?: Progress): Promise<VerificationOutcome> {
    const scratchDir = this.scratch();
    try {
      const task: VerifyTask = {
        kind: "verify",
        file: this.folder.filePath(manifest),
        manifest,
        scratchDir,
      };
      return await runInWorker<VerificationOutcome>(
        workerEntry("verify-worker.ts"),
        task,
        progress,
      );
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  }

  async recordVerification(record: VerificationRecord): Promise<void> {
    this.folder.writeVerification(record);
  }

  async drillBackup(manifest: BackupManifest, progress?: Progress): Promise<DrillOutcome> {
    const scratchDir = this.scratch();
    try {
      const task: VerifyTask = {
        kind: "drill",
        file: this.folder.filePath(manifest),
        manifest,
        scratchDir,
      };
      return await runInWorker<DrillOutcome>(workerEntry("verify-worker.ts"), task, progress);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  }

  deleteBackup(manifest: BackupManifest): Promise<void> {
    return this.folder.remove(manifest);
  }

  async beginExport(id: string): Promise<ExportSink> {
    return new DirectoryExportSink(this.directories.exports, id);
  }

  listExports(): Promise<readonly StoredExport[]> {
    return listExportFolders(this.directories.exports);
  }

  async automaticState(): Promise<AutomaticRun> {
    const saved = await this.folder.automatic();
    const seen = this.lastRun;
    return seen?.lastRunAt && (!saved.lastRunAt || seen.lastRunAt >= saved.lastRunAt)
      ? seen
      : saved;
  }

  async recordAutomatic(run: {
    readonly at: Date;
    readonly ok: boolean;
    readonly error?: string;
  }): Promise<void> {
    this.lastRun = {
      lastRunAt: run.at.toISOString(),
      lastRunOk: run.ok,
      lastError: run.ok ? null : (run.error ?? "Unknown error").slice(0, 580),
    };
    this.folder.recordAutomatic(run);
  }

  async onSameDisk(): Promise<boolean | null> {
    const a = deviceOf(this.databasePath);
    const b = deviceOf(this.directories.backups);
    return a === null || b === null ? null : a === b;
  }
}

export function createLocalSafetyHost(
  databasePath: string,
  options: LocalSafetyOptions = {},
): LocalSafetyHost {
  return new LocalSafetyHost(databasePath, options);
}

import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ApplicationError } from "../errors.ts";
import {
  fromStartSeconds,
  replayGrowthOf,
  restartSeconds,
  type SavedSnapshotSize,
} from "../replay-cost.ts";
import { isBackupId, parseBackupManifest } from "../safety/manifest.ts";
import type { BackupManifest, Check, LedgerHead, Progress } from "../safety/types.ts";
import { BackupFolder } from "./backup-folder.ts";
import { copyFileDurably, ensurePrivateDirectory, fsyncDirectory } from "./files.ts";
import { describeDatabase, readBookCommitment } from "./snapshot.ts";
import { checkBackupFile } from "./verify.ts";

export interface RestoreOptions {
  /** A backup file (`.sqlite`), its manifest (`.manifest.json`), a backup id, or `latest`. An id or
   * `latest` is looked up in `backupDirectory`. */
  readonly backup: string;
  /** The database to create. */
  readonly to: string;
  /** Replace a database that already exists there, keeping a safety copy of it. */
  readonly replace?: boolean;
  /** Restore a backup file that has no manifest, with the manifest comparisons skipped. */
  readonly allowNoManifest?: boolean;
  /** Skip the ledger replay (the file checks still run). The service replays the ledger the first
   * time it reads the book, so a book that is large is not replayed twice. */
  readonly quick?: boolean;
  readonly backupDirectory?: string;
  readonly now?: () => Date;
  readonly progress?: Progress;
}

export interface RestoreResult {
  readonly to: string;
  readonly backupId: string | null;
  readonly head: LedgerHead;
  readonly bytes: number;
  readonly sha256: string;
  readonly replayed: boolean;
  readonly replayMs: number | null;
  readonly outcomes: number;
  readonly journals: number;
  readonly checks: readonly Check[];
  /** Where the replaced database was kept, or null when nothing was replaced. */
  readonly safetyCopy: string | null;
  /** Things a person must do or know after this restore, in plain words. */
  readonly warnings: readonly string[];
  readonly firstStart: {
    readonly snapshot: "current" | "behind" | "none";
    readonly estimateSeconds: number;
    readonly note: string;
  };
}

/** True when another process has the database open. Taking an exclusive lock fails exactly then,
 * including while the other process is idle, and a database nobody has open locks freely. */
export function isDatabaseInUse(path: string): boolean {
  let db: Database | null = null;
  try {
    db = new Database(path);
    db.exec("PRAGMA locking_mode=EXCLUSIVE");
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
    return false;
  } catch (error) {
    return /locked|busy/i.test(error instanceof Error ? error.message : String(error));
  } finally {
    try {
      db?.close();
    } catch {
      // Nothing to release.
    }
  }
}

async function resolveBackup(options: RestoreOptions): Promise<{
  file: string;
  manifest: BackupManifest | null;
}> {
  const spec = options.backup;
  const readManifest = async (path: string): Promise<BackupManifest> => {
    const parsed = await parseBackupManifest(await readFile(path, "utf8")).catch(() => null);
    if (!parsed)
      throw new ApplicationError(
        "restore_manifest_invalid",
        `The manifest ${path} cannot be read.`,
        422,
      );
    if (!parsed.ok)
      throw new ApplicationError(
        "restore_manifest_invalid",
        `The manifest ${basename(path)} is not trustworthy: ${parsed.problem}. Restore from another backup, or from the file itself with --no-manifest if you know it is good.`,
        422,
      );
    return parsed.manifest;
  };
  if (options.allowNoManifest) {
    const file = resolve(
      spec.endsWith(".manifest.json") ? spec.replace(/\.manifest\.json$/, ".sqlite") : spec,
    );
    if (!existsSync(file))
      throw new ApplicationError("restore_backup_not_found", `There is no file ${file}.`, 404);
    return { file, manifest: null };
  }
  if (spec.endsWith(".manifest.json")) {
    const path = resolve(spec);
    if (!existsSync(path))
      throw new ApplicationError("restore_backup_not_found", `There is no manifest ${path}.`, 404);
    const manifest = await readManifest(path);
    return { file: join(dirname(path), manifest.file.name), manifest };
  }
  if (spec === "latest" || isBackupId(spec)) {
    const folder = new BackupFolder(
      options.backupDirectory ??
        process.env.RASTRATA_BACKUP_DIR ??
        join(dirname(resolve(options.to)), "backups", basename(options.to).replace(/\.[^.]*$/, "")),
    );
    const listed = await folder.list();
    const found =
      spec === "latest"
        ? listed.backups[0]
        : listed.backups.find((item) => item.manifest.id === spec);
    if (!found)
      throw new ApplicationError(
        "restore_backup_not_found",
        spec === "latest"
          ? `There are no backups in ${folder.directory}. Name a backup file, or set RASTRATA_BACKUP_DIR.`
          : `There is no backup ${spec} in ${folder.directory}.`,
        404,
      );
    return { file: folder.filePath(found.manifest), manifest: found.manifest };
  }
  const file = resolve(spec);
  if (!existsSync(file))
    throw new ApplicationError("restore_backup_not_found", `There is no backup file ${file}.`, 404);
  const sibling = file.replace(/\.sqlite$/, ".manifest.json");
  if (!existsSync(sibling))
    throw new ApplicationError(
      "restore_manifest_missing",
      `${basename(file)} has no manifest beside it (${basename(sibling)}), so nothing can say what it should contain. If you know the file is good, restore it with --no-manifest.`,
      422,
    );
  return { file, manifest: await readManifest(sibling) };
}

/**
 * Restore a backup into a database file, offline. It checks the backup first, exactly as a
 * verification does (size and SHA-256 against the manifest, SQLite's integrity check, the stored
 * head, and a replay of the whole ledger on a working copy), and installs nothing unless every
 * check passes. It never overwrites an existing database unless asked; when it does, it first keeps
 * a copy of the database it replaces (with its write-ahead files) and refuses outright if another
 * process has that database open. The file installed is the verified backup, byte for byte: its
 * SHA-256 is checked again after it is written.
 */
export async function restoreBackup(options: RestoreOptions): Promise<RestoreResult> {
  const progress = options.progress ?? (() => {});
  const to = resolve(options.to);
  const { file, manifest } = await resolveBackup(options);
  if (!existsSync(file))
    throw new ApplicationError(
      "restore_backup_not_found",
      `The backup file ${file} is missing.`,
      404,
    );
  if (existsSync(to) && realpathSync(to) === realpathSync(file))
    throw new ApplicationError(
      "restore_target_is_backup",
      "The target is the backup file itself. Restore to a different path.",
      409,
    );
  if (existsSync(to)) {
    if (!options.replace)
      throw new ApplicationError(
        "restore_target_exists",
        `${to} already exists, and a restore never overwrites a database unless you pass --replace (a safety copy of it is kept). Choose a new path, or add --replace.`,
        409,
      );
    if (isDatabaseInUse(to))
      throw new ApplicationError(
        "restore_target_in_use",
        `${to} is open in another process (the Rastrata service, usually). Stop it first: replacing a database that is in use would corrupt it.`,
        409,
      );
  } else if (existsSync(`${to}-wal`) || existsSync(`${to}-shm`))
    throw new ApplicationError(
      "restore_target_stale",
      `${to} does not exist but ${basename(to)}-wal or -shm does: files left by a database that was removed. Delete them or choose another path, because a restored database must not inherit them.`,
      409,
    );
  ensurePrivateDirectory(dirname(to));

  const scratchDir = join(dirname(to), `.restore-${randomBytes(4).toString("hex")}`);
  const found = await checkBackupFile({
    file,
    manifest,
    scratchDir,
    mode: "verify",
    replay: options.quick !== true,
    progress,
  });
  const failures = found.checks.filter((check) => check.status === "failed");
  if (failures.length > 0)
    throw new ApplicationError(
      "restore_verification_failed",
      `The backup did not pass verification, so nothing was restored: ${failures[0]?.message ?? ""}`.slice(
        0,
        590,
      ),
      422,
      failures.map((check) => ({ path: check.code, message: check.message })),
    );

  let safetyCopy: string | null = null;
  if (existsSync(to)) {
    const stamp = (options.now?.() ?? new Date())
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z");
    safetyCopy = join(dirname(to), `${basename(to)}.replaced-${stamp}`);
    mkdirSync(safetyCopy, { mode: 0o700 });
    progress({ stage: "Keeping a copy of the database being replaced", done: null, total: null });
    for (const suffix of ["", "-wal", "-shm"]) {
      const source = `${to}${suffix}`;
      if (!existsSync(source)) continue;
      const target = join(safetyCopy, `${basename(to)}${suffix}`);
      if (suffix === "") copyFileDurably(source, target);
      else copyFileSync(source, target);
      if (statSync(target).size !== statSync(source).size)
        throw new ApplicationError(
          "restore_safety_copy_failed",
          `The safety copy of ${basename(source)} is not the same size as the original, so nothing was replaced.`,
          500,
        );
    }
  }

  progress({ stage: "Writing the restored database", done: 0, total: null, model: "linear" });
  const staging = `${to}.restoring-${randomBytes(4).toString("hex")}`;
  const written = copyFileDurably(file, staging, (done, total) => progress({ done, total }));
  if (manifest && written.sha256 !== manifest.file.sha256) {
    rmSync(staging, { force: true });
    throw new ApplicationError(
      "restore_copy_mismatch",
      "The restored file does not match the backup's manifest, so the disk or the copy is faulty. Nothing was replaced.",
      500,
    );
  }
  // The write-ahead files belong to the database being replaced: left behind, they would be applied
  // to the restored one. They are already in the safety copy.
  rmSync(`${to}-wal`, { force: true });
  rmSync(`${to}-shm`, { force: true });
  renameSync(staging, to);
  fsyncDirectory(dirname(to));

  const installed = describeDatabase(to);
  if (manifest && installed.head.chainHash !== manifest.ledger.head.chainHash)
    throw new ApplicationError(
      "restore_install_mismatch",
      `The restored database ends at ${installed.head.chainHash.slice(0, 12)}… but the backup's manifest says ${manifest.ledger.head.chainHash.slice(0, 12)}….`,
      500,
    );
  const outcomes = found.outcomes || Number(installed.head.sequence);
  let snapshot: RestoreResult["firstStart"]["snapshot"] = "none";
  let saved: SavedSnapshotSize | null = null;
  const warnings: string[] = [];
  try {
    const db = new Database(to, { readonly: true });
    try {
      try {
        const row = db
          .query(
            "SELECT sequence, length(CAST(encoded AS BLOB)) AS bytes FROM app_read_snapshots WHERE id = 1",
          )
          .get() as { sequence: string; bytes: number } | null;
        if (row) {
          snapshot = BigInt(row.sequence) >= BigInt(installed.head.sequence) ? "current" : "behind";
          saved = { bytes: row.bytes, sequence: Number(row.sequence) };
        }
      } catch {
        snapshot = "none";
        saved = null;
      }
      try {
        const tokens = db
          .query(
            "SELECT count(*) AS n FROM agent_tokens WHERE revoked_at IS NULL AND expires_at > ?",
          )
          .get((options.now?.() ?? new Date()).toISOString()) as { n: number } | null;
        if (tokens && tokens.n > 0)
          warnings.push(
            `This backup holds ${tokens.n} agent token${tokens.n === 1 ? "" : "s"} that ${tokens.n === 1 ? "was" : "were"} valid when it was made. A token you revoked after that is valid again now. Run rastrata tokens list and revoke it again.`,
          );
      } catch {
        // No agent tokens in this book.
      }
    } finally {
      db.close();
    }
  } catch {
    snapshot = "none";
    saved = null;
  }
  // How long the first read takes depends on the kind of book (see replay-cost.ts): about a second for
  // every thousand entries for a book made with the chain-head state commitment, and the square of that
  // growth for one made without it. A snapshot is read and the entries since it replayed; with none, the
  // time the check just timed is the best guide, and the rule of thumb is used when the replay was skipped.
  const growth = replayGrowthOf(readBookCommitment(to));
  const size = { journals: found.journals || outcomes, entries: outcomes };
  const estimateSeconds = Math.max(
    1,
    Math.round(
      saved !== null
        ? restartSeconds(growth, size, saved)
        : found.replayMs !== null
          ? found.replayMs / 1000
          : fromStartSeconds(growth, size),
    ),
  );
  const since = saved === null ? 0 : Math.max(0, outcomes - saved.sequence);
  const aboutSeconds =
    estimateSeconds === 1 ? "about a second" : `about ${estimateSeconds} seconds`;
  return {
    to,
    backupId: manifest?.id ?? null,
    head: installed.head,
    bytes: written.bytes,
    sha256: written.sha256,
    replayed: options.quick !== true,
    replayMs: found.replayMs,
    outcomes,
    journals: found.journals,
    checks: found.checks,
    safetyCopy,
    warnings,
    firstStart: {
      snapshot,
      estimateSeconds,
      note:
        snapshot === "none"
          ? `This backup carries no saved read snapshot, so the service replays the whole ledger the first time it reads the book: ${aboutSeconds} (${growth === "linear" ? "about a second for every thousand entries" : "it grows with the square of the book"}; the check just now took ${found.replayMs === null ? "no time, since the replay was skipped" : `${Math.round(found.replayMs / 1000)} s`}). It happens once.`
          : snapshot === "current"
            ? "The backup carries a saved read snapshot, so the service starts quickly."
            : `The backup carries a saved read snapshot, but ${since} ${since === 1 ? "entry was" : "entries were"} made after it was saved: the service reads it and replays ${since === 1 ? "it" : "them"}, ${aboutSeconds}. It happens once.`,
    },
  };
}

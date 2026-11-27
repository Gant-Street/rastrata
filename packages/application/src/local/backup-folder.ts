import { readdir, readFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseBackupManifest, parseVerification } from "../safety/manifest.ts";
import type {
  AutomaticRun,
  BackupManifest,
  StoredBackup,
  VerificationRecord,
} from "../safety/types.ts";
import { ensurePrivateDirectory, writeFileAtomic } from "./files.ts";

const MANIFEST = ".manifest.json";
const VERIFICATION = ".verification.json";
/** The most backups a listing reads. A person with more has bigger things to look at than a list. */
const MAX_BACKUPS = 5000;

/** The backup folder: one `<id>.sqlite` and one `<id>.manifest.json` per backup, a
 * `<id>.verification.json` once it has been verified, and `automatic.json`. The manifest is written
 * last, so a backup exists only when its manifest does; a file without one is listed as unrecorded
 * and never trusted. Everything here is small and read on the service's own thread. */
export class BackupFolder {
  constructor(readonly directory: string) {}

  path(name: string): string {
    return join(this.directory, name);
  }
  filePath(manifest: BackupManifest): string {
    return this.path(manifest.file.name);
  }
  manifestPath(id: string): string {
    return this.path(`${id}${MANIFEST}`);
  }
  verificationPath(id: string): string {
    return this.path(`${id}${VERIFICATION}`);
  }
  get scratchRoot(): string {
    return this.path(".scratch");
  }

  ensure(): void {
    ensurePrivateDirectory(this.directory);
  }

  async list(): Promise<{ backups: StoredBackup[]; unrecorded: string[] }> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch {
      return { backups: [], unrecorded: [] };
    }
    const present = new Set(names);
    const backups: StoredBackup[] = [];
    const unrecorded: string[] = [];
    const recordedFiles = new Set<string>();
    const manifests = names
      .filter((name) => name.endsWith(MANIFEST))
      .sort()
      .reverse();
    for (const name of manifests.slice(0, MAX_BACKUPS)) {
      let parsed: Awaited<ReturnType<typeof parseBackupManifest>>;
      try {
        parsed = await parseBackupManifest(await readFile(this.path(name), "utf8"));
      } catch {
        unrecorded.push(name);
        continue;
      }
      if (!parsed.ok || `${parsed.manifest.id}${MANIFEST}` !== name) {
        unrecorded.push(name);
        continue;
      }
      const { manifest } = parsed;
      recordedFiles.add(manifest.file.name);
      let verification: VerificationRecord | null = null;
      if (present.has(`${manifest.id}${VERIFICATION}`)) {
        try {
          verification = parseVerification(
            await readFile(this.verificationPath(manifest.id), "utf8"),
            manifest.id,
          );
        } catch {
          verification = null;
        }
      }
      backups.push({
        manifest,
        fileState: present.has(manifest.file.name) ? "present" : "missing",
        verification,
      });
    }
    for (const name of names)
      if (name.endsWith(".sqlite") && !recordedFiles.has(name) && !name.startsWith("."))
        unrecorded.push(name);
    backups.sort((a, b) => (a.manifest.id < b.manifest.id ? 1 : -1));
    return { backups, unrecorded: unrecorded.sort().slice(0, 200) };
  }

  writeManifest(manifest: BackupManifest): void {
    writeFileAtomic(this.manifestPath(manifest.id), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  writeVerification(record: VerificationRecord): void {
    this.ensure();
    writeFileAtomic(this.verificationPath(record.backupId), `${JSON.stringify(record, null, 2)}\n`);
  }

  async automatic(): Promise<AutomaticRun> {
    try {
      const raw = JSON.parse(await readFile(this.path("automatic.json"), "utf8")) as Record<
        string,
        unknown
      >;
      return {
        lastRunAt: typeof raw.lastRunAt === "string" ? raw.lastRunAt : null,
        lastRunOk: typeof raw.lastRunOk === "boolean" ? raw.lastRunOk : null,
        lastError: typeof raw.lastError === "string" ? raw.lastError.slice(0, 600) : null,
      };
    } catch {
      return { lastRunAt: null, lastRunOk: null, lastError: null };
    }
  }

  recordAutomatic(run: { at: Date; ok: boolean; error?: string }): void {
    this.ensure();
    writeFileAtomic(
      this.path("automatic.json"),
      `${JSON.stringify({ lastRunAt: run.at.toISOString(), lastRunOk: run.ok, lastError: run.ok ? null : (run.error ?? "Unknown error").slice(0, 580) }, null, 2)}\n`,
    );
  }

  /** Remove a backup. The manifest goes first, so a half-removed backup is an unrecorded file in
   * the folder, never a recorded backup whose file is gone. */
  async remove(manifest: BackupManifest): Promise<void> {
    await unlink(this.manifestPath(manifest.id));
    await rm(this.filePath(manifest), { force: true });
    await rm(this.verificationPath(manifest.id), { force: true });
  }

  /** Delete what a crashed job left behind: partial snapshots and scratch copies. Only safe when
   * no job can be running, so the scheduler calls it at start-up. */
  async cleanTransient(): Promise<void> {
    await rm(this.scratchRoot, { recursive: true, force: true });
    let names: string[] = [];
    try {
      names = await readdir(this.directory);
    } catch {
      return;
    }
    for (const name of names)
      if (name.endsWith(".partial") || name.includes(".partial-"))
        await rm(this.path(name), { force: true });
  }
}

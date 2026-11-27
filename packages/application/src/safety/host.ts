import type {
  AutomaticRun,
  BackupManifest,
  BackupReason,
  DrillOutcome,
  Progress,
  SchedulerState,
  StoredBackup,
  StoredExport,
  VerificationOutcome,
  VerificationRecord,
} from "./types.ts";

/** One file being written into an export. The sink hashes and counts as it writes, so a book of
 * any size is streamed rather than held in memory. */
export interface ExportWriter {
  /** Append UTF-8 text. */
  write(text: string): Promise<void>;
  /** Finish the file. `lines` counts newline-terminated lines. */
  close(): Promise<{ readonly bytes: number; readonly sha256: string; readonly lines: number }>;
}

/** Where an export is assembled. The export appears at its final location only when `finish`
 * succeeds; `abort` leaves nothing behind. */
export interface ExportSink {
  /** Start a file named by the format, for example `journals.jsonl`. A name may be used once. */
  file(path: string): Promise<ExportWriter>;
  finish(): Promise<{ readonly location: string }>;
  abort(): Promise<void>;
}

/** An export as one file to download. */
export interface ExportArchive {
  /** The file's name, for the download. */
  readonly name: string;
  /** The bytes, streamed: a book of any size is never held in memory. */
  readonly body: ReadableStream<Uint8Array>;
}

/** What an export needs of a runtime: somewhere to write the files, and to find them again. A runtime that cannot back up can still offer this: a hosted pod
 * keeps an export for a little while, to be downloaded. */
export interface ExportHost {
  /** Where exports are kept, for display. Never an input from a client. */
  readonly directories: { readonly exports: string };
  beginExport(id: string): Promise<ExportSink>;
  listExports(): Promise<readonly StoredExport[]>;
  /** One export as a single file (a zip of its folder), or null when there is no such export. Left out by a runtime whose exports are read from its folder. */
  archive?(id: string): Promise<ExportArchive | null>;
}

/** The runtime half of the safety lane: everything that needs a file system or a database file.
 * The local runtime injects one through `ApplicationServiceOptions.host`; portable code never
 * imports the implementation. Methods that do heavy work must not block the caller's event loop
 * (the local runtime uses worker threads), and report progress as they go. */
export interface SafetyHost extends ExportHost {
  /** Where backups and exports are kept, for display. Never an input from a client. */
  readonly directories: { readonly backups: string; readonly exports: string };
  /** Snapshot the whole database into a new backup file and write its manifest. With
   * `reuseIdentical`, a snapshot whose bytes equal the newest backup's is discarded and that
   * backup is returned (`reused`): a snapshot is byte-for-byte the same when nothing in the
   * database, ledger or product state, has changed. */
  createBackup(
    reason: BackupReason,
    now: Date,
    progress?: Progress,
    options?: { readonly reuseIdentical?: boolean },
  ): Promise<{ readonly manifest: BackupManifest; readonly reused: boolean }>;
  /** Recorded backups, newest first, and names of files that are not recorded backups. */
  listBackups(): Promise<{
    readonly backups: readonly StoredBackup[];
    readonly unrecorded: readonly string[];
  }>;
  /** Check one backup against its manifest and replay its ledger, on a copy. */
  verifyBackup(manifest: BackupManifest, progress?: Progress): Promise<VerificationOutcome>;
  /** Keep the result of a verification next to the backup it describes. */
  recordVerification(record: VerificationRecord): Promise<void>;
  /** Restore one backup into a scratch directory exactly as an offline restore would, replay it
   * and report what was found. The scratch copy is always discarded. */
  drillBackup(manifest: BackupManifest, progress?: Progress): Promise<DrillOutcome>;
  /** Remove a backup's file, manifest and verification. Only ever called for recorded backups. */
  deleteBackup(manifest: BackupManifest): Promise<void>;
  scheduler(): SchedulerState;
  /** What the automatic backups last did. Kept beside the backups, not in the database, so that
   * recording a run never changes the database a later backup copies. */
  automaticState(): Promise<AutomaticRun>;
  recordAutomatic(run: {
    readonly at: Date;
    readonly ok: boolean;
    readonly error?: string;
  }): Promise<void>;
  /** True when backups are on the same disk as the database, false when not, null when unknown. */
  onSameDisk(): Promise<boolean | null>;
}

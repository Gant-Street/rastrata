/** Shared vocabulary of the safety lane (backups, restore drills, the open export). Pure data and
 * pure functions only: nothing in `src/safety/` may import `bun:`, `node:fs`, `node:path` or
 * anything from `local/`. The local runtime reaches this code, and this code reaches the file
 * system and the database file, only through the host port in `host.ts`. */

/** Format identifiers written into every manifest. A reader refuses any other value. */
export const BACKUP_FORMAT = "rastrata-backup-v1";
export const EXPORT_FORMAT = "rastrata-export-v1";
/** The release written into manifests; informational. */
export const APPLICATION_RELEASE = "0.1.0";

/** The persisted ledger protocol the local runtime writes (read from the database when a backup is
 * made; this is what an export records). */
export const LEDGER_FORMAT_ID = "rastrata-native-sql-ledger-v1";

export type BackupReason = "manual" | "scheduled" | "startup" | "shutdown";
export const BACKUP_REASONS: readonly BackupReason[] = [
  "manual",
  "scheduled",
  "startup",
  "shutdown",
];
/** Reasons for backups the scheduler made. Only these are ever deleted by retention. */
export const AUTOMATIC_REASONS: readonly BackupReason[] = ["scheduled", "startup", "shutdown"];

/** Where the ledger chain stands. All three are decimal strings, as on the wire. */
export interface LedgerHead {
  readonly sequence: string;
  readonly bookRevision: string;
  readonly chainHash: string;
}

export const sameHead = (a: LedgerHead, b: LedgerHead): boolean =>
  a.sequence === b.sequence && a.bookRevision === b.bookRevision && a.chainHash === b.chainHash;

/** What a backup records about itself. Written next to the backup file, never inside it. */
export interface BackupManifest {
  readonly format: typeof BACKUP_FORMAT;
  /** `20261003T181500Z-00000042-1a2b3c4d`: UTC time, ledger sequence, first eight hash digits. */
  readonly id: string;
  readonly createdAt: string;
  readonly reason: BackupReason;
  readonly file: {
    readonly name: string;
    readonly bytes: number;
    /** SHA-256 of the backup file's bytes. */
    readonly sha256: string;
  };
  readonly ledger: {
    /** The persisted ledger protocol identifier, for example rastrata-native-sql-ledger-v1. */
    readonly formatId: string;
    readonly head: LedgerHead;
    /** SHA-256 of the stored genesis record: identifies which book this is. */
    readonly genesisSha256: string;
  };
  readonly application: {
    readonly release: string;
    /** Product-state schema versions by store name, for example { core: 1, safety: 1 }. */
    readonly stores: Readonly<Record<string, number>>;
  };
  readonly book: { readonly name: string; readonly currency: string };
  /** SHA-256 of this manifest's compact JSON without this field. */
  readonly manifestSha256: string;
}

export type CheckStatus = "passed" | "failed" | "skipped";
export interface Check {
  /** Stable machine code, for example `file_sha256` or `ledger_replay`. */
  readonly code: string;
  readonly status: CheckStatus;
  readonly message: string;
}

/** What a verification of one backup found. Kept next to the backup it describes. */
export interface VerificationRecord {
  readonly backupId: string;
  readonly verifiedAt: string;
  readonly passed: boolean;
  readonly durationMs: number;
  /** Time spent replaying the ledger, the part that grows with the size of the book (with the entries
   * for a book made with the chain-head state commitment, with their square for one made without it:
   * see replay-cost.ts); null when the replay did not run. */
  readonly replayMs: number | null;
  readonly outcomes: number;
  readonly journals: number;
  /** The head the replay itself reached; null when the replay did not run or failed. */
  readonly head: LedgerHead | null;
  readonly checks: readonly Check[];
}

export interface StoredBackup {
  readonly manifest: BackupManifest;
  readonly fileState: "present" | "missing";
  readonly verification: VerificationRecord | null;
}

/** What a verification found, before it is stamped and recorded. */
export interface VerificationOutcome {
  readonly passed: boolean;
  readonly replayMs: number | null;
  readonly outcomes: number;
  readonly journals: number;
  readonly head: LedgerHead | null;
  readonly checks: readonly Check[];
}

/** What a restore drill found in its scratch copy. `balances` are signed decimal strings by
 * account id, at the restored head. */
export interface DrillOutcome {
  readonly replayMs: number | null;
  readonly checks: readonly Check[];
  readonly restoredHead: LedgerHead | null;
  /** Digest of the kernel's own revision chain at the restored head: a second chain, independent
   * of how the ledger stores outcomes, that the live book must share at the same revision. */
  readonly kernelChain: string | null;
  readonly journals: number;
  readonly outcomes: number;
  readonly balances: Readonly<Record<string, string>> | null;
}

/** A recorded restore drill: the restored copy compared with the live book. */
export interface DrillRecord {
  readonly backupId: string;
  readonly ranAt: string;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly replayMs: number | null;
  readonly restoredHead: LedgerHead | null;
  readonly liveHead: LedgerHead;
  /** Outcomes the live book has gained since the backup, or null when it cannot be told. */
  readonly changesSince: number | null;
  readonly accountsCompared: number;
  readonly mismatches: readonly { accountId: string; live: string; restored: string }[];
  readonly checks: readonly Check[];
}

/** Progress of a long job. `total` is null when it cannot be known. */
export interface ProgressUpdate {
  readonly stage?: string;
  readonly done?: number | null;
  readonly total?: number | null;
  /** How the cost grows with `done`, so an estimate can be drawn from it: a file copy is linear, and so
   * is the replay of a book made with the chain-head state commitment (every book the application makes
   * now). The replay of a book made without it is quadratic (every command costs as much as the book is
   * long). The replay says which when it starts, from the book's own starting record. */
  readonly model?: "linear" | "quadratic";
}
export type Progress = (update: ProgressUpdate) => void;

export interface ExportFileInfo {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  /** Number of lines for line-oriented files; null for the rest. */
  readonly lines: number | null;
}

export interface ExportCounts {
  readonly journals: number;
  readonly postings: number;
  readonly accounts: number;
  readonly commands: number;
  readonly sources: number;
}

/** `manifest.json` of a `rastrata-export-v1` export. */
export interface ExportManifest {
  readonly format: typeof EXPORT_FORMAT;
  readonly id: string;
  readonly createdAt: string;
  readonly generator: { readonly name: string; readonly release: string };
  readonly book: { readonly id: string; readonly name: string; readonly currency: string };
  readonly ledger: {
    readonly formatId: string;
    readonly head: LedgerHead;
    readonly genesisSha256: string;
    /** Number of retained outcomes, committed and rejected, including activation. */
    readonly outcomes: number;
  };
  readonly counts: ExportCounts;
  readonly files: readonly ExportFileInfo[];
  /** SHA-256 of this manifest's compact JSON without this field. */
  readonly manifestSha256: string;
}

export interface StoredExport {
  readonly id: string;
  readonly location: string;
  readonly manifest: ExportManifest;
  readonly bytes: number;
}

/** What a scheduler tells a status reader about itself. */
export interface SchedulerState {
  /** True while this process is running the automatic backup timer. */
  readonly active: boolean;
  readonly nextRunAt: string | null;
}

/** The product-state record of what the automatic backups last did. */
export interface AutomaticRun {
  readonly lastRunAt: string | null;
  readonly lastRunOk: boolean | null;
  readonly lastError: string | null;
}

/** Automatic backup settings. Manual backups are never deleted automatically. */
export interface BackupSettings {
  readonly enabled: boolean;
  /** Hours between automatic backups. */
  readonly intervalHours: number;
  readonly onShutdown: boolean;
  /** Verify each automatic backup (and re-verify the newest daily when nothing changed). */
  readonly verifyAfterBackup: boolean;
  readonly keepDaily: number;
  readonly keepWeekly: number;
  readonly keepMonthly: number;
  /** Warn when the newest successful verification is older than this many hours. */
  readonly warnAfterHours: number;
}

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = Object.freeze({
  enabled: true,
  intervalHours: 24,
  onShutdown: true,
  verifyAfterBackup: true,
  keepDaily: 7,
  keepWeekly: 4,
  keepMonthly: 12,
  warnAfterHours: 48,
});

export type JobKind = "backup" | "verify" | "drill" | "export";

/** A running or finished long job as the status and the operations show it. */
export interface JobSnapshot {
  readonly kind: JobKind;
  readonly startedAt: string;
  readonly stage: string;
  readonly done: number | null;
  readonly total: number | null;
  readonly elapsedMs: number;
  /** An estimate, never a promise; null until there is enough progress to extrapolate from. */
  readonly remainingMs: number | null;
}

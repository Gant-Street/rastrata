/** What the safety components show. They describe the application's answers in the shape the
 * screen needs, and the web app passes its generated types straight in: these are structurally
 * the same, kept here so the UI package depends on no service code. */

export type SafetyTone = "info" | "review" | "error";

export interface LedgerPosition {
  readonly sequence: string;
  readonly bookRevision: string;
  readonly chainHash: string;
}

export interface CheckView {
  readonly code: string;
  readonly status: "passed" | "failed" | "skipped";
  readonly message: string;
}

export interface VerificationView {
  readonly verifiedAt: string;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly replayMs: number | null;
  readonly checks: readonly CheckView[];
}

export interface BackupView {
  readonly id: string;
  readonly createdAt: string;
  readonly reason: "manual" | "scheduled" | "startup" | "shutdown";
  readonly fileName: string;
  readonly bytes: number;
  readonly head: LedgerPosition;
  readonly fileState: "present" | "missing";
  readonly verification: VerificationView | null;
}

export interface WarningView {
  readonly code: string;
  readonly tone: SafetyTone;
  readonly message: string;
}

export interface DrillView {
  readonly backupId: string;
  readonly ranAt: string;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly replayMs: number | null;
  readonly restoredHead: LedgerPosition | null;
  readonly liveHead: LedgerPosition;
  readonly changesSince: number | null;
  readonly accountsCompared: number;
  readonly mismatches: readonly { accountId: string; live: string; restored: string }[];
  readonly checks: readonly CheckView[];
}

export type JobKind = "backup" | "verify" | "drill" | "export";

export interface JobView {
  readonly kind: JobKind;
  readonly stage: string;
  readonly done: number | null;
  readonly total: number | null;
  readonly elapsedMs: number;
  readonly remainingMs: number | null;
}

export interface SettingsView {
  readonly enabled: boolean;
  readonly intervalHours: number;
  readonly onShutdown: boolean;
  readonly verifyAfterBackup: boolean;
  readonly keepDaily: number;
  readonly keepWeekly: number;
  readonly keepMonthly: number;
  readonly warnAfterHours: number;
}

export interface AutomaticView {
  readonly enabled: boolean;
  readonly scheduler: "active" | "off" | "not_running";
  readonly lastRunAt: string | null;
  readonly lastRunOk: boolean | null;
  readonly lastError: string | null;
}

export interface SafetyStatusView {
  readonly directory: string;
  readonly settings: SettingsView;
  readonly automatic: AutomaticView;
  readonly activeJob: JobView | null;
  readonly liveHead: LedgerPosition;
  readonly latest: BackupView | null;
  readonly latestVerified: BackupView | null;
  readonly lastDrill: DrillView | null;
  readonly changesSinceLatest: number | null;
  readonly backupCount: number;
  readonly warnings: readonly WarningView[];
}

export interface ExportView {
  readonly id: string;
  readonly createdAt: string;
  readonly location: string;
  readonly head: LedgerPosition;
  readonly counts: {
    readonly journals: number;
    readonly postings: number;
    readonly accounts: number;
    readonly commands: number;
    readonly sources: number;
  };
  readonly bytes: number;
}

/** What "now" and the viewer's formats are, passed in so every relative time is deterministic in a
 * test or a story and never read from a clock in the middle of rendering. */
export interface SafetyClock {
  readonly now: Date;
  readonly locale?: string;
  /** An IANA time zone; unset uses the viewer's own. */
  readonly timeZone?: string;
}

/** The finished answer of a job this page asked for, for the panel that tells the person what
 * happened. A check that did not pass is a finished job whose result says so. */
export type JobResultView =
  | {
      readonly kind: "backup";
      readonly state: "done";
      readonly backup: BackupView;
    }
  | {
      readonly kind: "verify";
      readonly state: "done";
      readonly backupId: string;
      readonly passed: boolean;
      readonly durationMs: number;
      readonly replayMs: number | null;
      readonly checks: readonly CheckView[];
    }
  | { readonly kind: "drill"; readonly state: "done"; readonly drill: DrillView }
  | { readonly kind: "export"; readonly state: "done"; readonly export: ExportView }
  | {
      readonly kind: JobKind;
      readonly state: "failed";
      readonly code: string;
      readonly message: string;
    };

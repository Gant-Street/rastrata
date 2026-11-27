import type {
  BackupView,
  CheckView,
  DrillView,
  ExportView,
  JobView,
  LedgerPosition,
  SafetyClock,
  SafetyStatusView,
  SettingsView,
  VerificationView,
  WarningView,
} from "../../src";

/** A fixed moment and zone, so every story is the same every time. */
export const clock: SafetyClock = {
  now: new Date("2026-10-03T18:30:00.000Z"),
  locale: "en-US",
  timeZone: "UTC",
};

const hash = (seed: string) => seed.repeat(64).slice(0, 64);
export const head = (sequence: string): LedgerPosition => ({
  sequence,
  bookRevision: sequence,
  chainHash: hash("a1b2c3d4"),
});

export const passedChecks: readonly CheckView[] = [
  {
    code: "file_present",
    status: "passed",
    message: "20261003T181500Z-00001204-a1b2c3d4.sqlite is in the backup folder.",
  },
  {
    code: "file_sha256",
    status: "passed",
    message: "The file is 16.5 MB and its SHA-256 matches the manifest.",
  },
  { code: "integrity", status: "passed", message: "SQLite's integrity check found no problem." },
  {
    code: "ledger_stored",
    status: "passed",
    message: "The ledger inside the file ends at outcome 1204, as the manifest says.",
  },
  {
    code: "ledger_replay",
    status: "passed",
    message:
      "Replayed 1204 commands (1203 journals) in 41.2 s; each gave exactly the result the ledger had recorded.",
  },
  {
    code: "ledger_head",
    status: "passed",
    message:
      "The replay ends at outcome 1204 with chain hash a1b2c3d4e5f60718…, the head the manifest recorded.",
  },
];

export const failedChecks: readonly CheckView[] = [
  {
    code: "file_present",
    status: "passed",
    message: "20261001T090000Z-00001150-a1b2c3d4.sqlite is in the backup folder.",
  },
  {
    code: "file_sha256",
    status: "failed",
    message:
      "The file does not match its manifest (same size, different SHA-256): it was altered or damaged after it was written.",
  },
  { code: "integrity", status: "passed", message: "SQLite's integrity check found no problem." },
  {
    code: "ledger_stored",
    status: "passed",
    message: "The ledger inside the file ends at outcome 1150, as the manifest says.",
  },
  {
    code: "ledger_replay",
    status: "skipped",
    message:
      "Not run: an earlier check failed, so this file cannot be trusted and a replay would only take time.",
  },
];

export const passedVerification: VerificationView = {
  verifiedAt: "2026-10-03T15:31:00.000Z",
  passed: true,
  durationMs: 43_100,
  replayMs: 41_200,
  checks: passedChecks,
};

export const failedVerification: VerificationView = {
  verifiedAt: "2026-10-03T09:05:00.000Z",
  passed: false,
  durationMs: 900,
  replayMs: null,
  checks: failedChecks,
};

export const backup = (
  id: string,
  createdAt: string,
  options: Partial<BackupView> = {},
): BackupView => ({
  id,
  createdAt,
  reason: "scheduled",
  fileName: `${id}.sqlite`,
  bytes: 17_300_000,
  head: head("1204"),
  fileState: "present",
  verification: null,
  ...options,
});

export const newest = backup("20261003T151500Z-00001204-a1b2c3d4", "2026-10-03T15:15:00.000Z", {
  verification: passedVerification,
});
export const yesterday = backup("20261002T151500Z-00001180-a1b2c3d4", "2026-10-02T15:15:00.000Z", {
  head: head("1180"),
  bytes: 17_100_000,
  verification: { ...passedVerification, verifiedAt: "2026-10-02T15:40:00.000Z" },
});
export const manual = backup("20261001T090000Z-00001150-a1b2c3d4", "2026-10-01T09:00:00.000Z", {
  reason: "manual",
  head: head("1150"),
  bytes: 16_800_000,
  verification: failedVerification,
});
export const missing = backup("20260930T090000Z-00001120-a1b2c3d4", "2026-09-30T09:00:00.000Z", {
  head: head("1120"),
  fileState: "missing",
});
export const neverChecked = backup(
  "20260929T090000Z-00001100-a1b2c3d4",
  "2026-09-29T09:00:00.000Z",
  {
    reason: "shutdown",
    head: head("1100"),
  },
);

export const settings: SettingsView = {
  enabled: true,
  intervalHours: 24,
  onShutdown: true,
  verifyAfterBackup: true,
  keepDaily: 7,
  keepWeekly: 4,
  keepMonthly: 12,
  warnAfterHours: 48,
};

export const drillPassed: DrillView = {
  backupId: newest.id,
  ranAt: "2026-10-03T16:00:00.000Z",
  passed: true,
  durationMs: 44_000,
  replayMs: 41_800,
  restoredHead: head("1204"),
  liveHead: head("1216"),
  changesSince: 12,
  accountsCompared: 38,
  mismatches: [],
  checks: [
    ...passedChecks.slice(0, 4),
    {
      code: "restore_copy",
      status: "passed",
      message:
        "Restored the backup into a temporary directory: 16.5 MB, identical to the backup file.",
    },
    passedChecks[4] as CheckView,
    passedChecks[5] as CheckView,
    {
      code: "kernel_chain",
      status: "passed",
      message: "Revision 1204 has the same chain hash in the restored copy and in the live book.",
    },
    {
      code: "trial_balance",
      status: "passed",
      message:
        "All 38 account balances equal the live book's at revision 1204 (12 later changes are not compared).",
    },
  ],
};

export const drillFailed: DrillView = {
  ...drillPassed,
  passed: false,
  mismatches: [{ accountId: "1000", live: "2800.25", restored: "2790.25" }],
  checks: [
    ...(drillPassed.checks.slice(0, 8) as CheckView[]),
    {
      code: "trial_balance",
      status: "failed",
      message: "1 of 38 account balances differ from the live book at revision 1204.",
    },
  ],
};

export const status = (overrides: Partial<SafetyStatusView> = {}): SafetyStatusView => ({
  directory: "/Users/founder/rastrata/apps/web/.local/backups/book",
  settings,
  automatic: {
    enabled: true,
    scheduler: "active",
    lastRunAt: "2026-10-03T15:15:00.000Z",
    lastRunOk: true,
    lastError: null,
  },
  activeJob: null,
  liveHead: head("1216"),
  latest: newest,
  latestVerified: newest,
  lastDrill: drillPassed,
  changesSinceLatest: 12,
  backupCount: 5,
  warnings: [],
  ...overrides,
});

export const sameDisk: WarningView = {
  code: "same_disk",
  tone: "info",
  message:
    "Backups are on the same disk as your book. If that disk fails you lose both: copy the backup folder to another drive or storage you trust.",
};

export const staleWarning: WarningView = {
  code: "stale_verification",
  tone: "review",
  message:
    "The last verified backup was verified 3 days ago, more than 48 hours ago. Verify a backup again.",
};

export const neverBackedUp: WarningView = {
  code: "never_backed_up",
  tone: "error",
  message:
    "This book has never been backed up. Back it up now: a backup is a complete copy you can restore if this computer fails.",
};

export const verificationFailed: WarningView = {
  code: "verification_failed",
  tone: "error",
  message:
    "The newest backup (20261001T090000Z-00001150-a1b2c3d4) failed verification. Do not rely on it; take a new backup and verify it.",
};

export const automaticFailed: WarningView = {
  code: "automatic_failed",
  tone: "error",
  message:
    "The last automatic backup did not finish (2 hours ago): There is not enough free space in /Volumes/Backup for a backup: about 17.3 MB is needed and 2.0 MB is free.",
};

export const exportsList: readonly ExportView[] = [
  {
    id: "20261003T140000Z-00001190-a1b2c3d4",
    createdAt: "2026-10-03T14:00:00.000Z",
    location:
      "/Users/founder/rastrata/apps/web/.local/exports/book/20261003T140000Z-00001190-a1b2c3d4",
    head: head("1190"),
    counts: { journals: 1189, postings: 2378, accounts: 38, commands: 1190, sources: 704 },
    bytes: 4_600_000,
  },
];

export const replayJob: JobView = {
  kind: "verify",
  stage: "Replaying the ledger",
  done: 340,
  total: 1204,
  elapsedMs: 9_000,
  remainingMs: 31_000,
};

export const manyBackups = (count: number): BackupView[] =>
  Array.from({ length: count }, (_, index) => {
    const day = 30 - Math.floor(index / 2);
    return backup(
      `202609${String(day).padStart(2, "0")}T${index % 2 ? "09" : "15"}1500Z-${String(1000 + (count - index)).padStart(8, "0")}-a1b2c3d4`,
      `2026-09-${String(day).padStart(2, "0")}T${index % 2 ? "09" : "15"}:15:00.000Z`,
      {
        reason: index % 5 === 4 ? "manual" : "scheduled",
        head: head(String(1000 + (count - index))),
        verification:
          index % 3 === 0
            ? {
                ...passedVerification,
                verifiedAt: `2026-09-${String(day).padStart(2, "0")}T16:00:00.000Z`,
              }
            : null,
      },
    );
  });

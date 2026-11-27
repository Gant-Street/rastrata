import { countText } from "./format";
import type { CheckView, JobKind } from "./types";

/** Every word the Backups and export screen owns, in one place. Plain and specific: what a thing is,
 * what it does and what to do next; no claim the code does not back. */
export const words = {
  eyebrow: "Settings",
  title: "Backups and export",
  intro:
    "A backup is a complete copy of your books that you can restore if this computer fails or a file is damaged. Rastrata backs up automatically. Here you can back up now, check that a backup really works, test a restore, and take your books out as ordinary files.",

  // The summary
  headlineOk: "Your books are backed up and the backup has been checked",
  headlineReview: "Your backups need attention",
  headlineError: "Your books are not safely backed up",
  noWarnings: "Nothing needs attention.",
  goodToKnow: "Good to know",
  statusLoading: "Checking your backups…",
  statusFailed: "The backup status could not be read",
  statusFailedBody: "Your books have not been changed. Try again.",
  retry: "Try again",
  unavailable: "Backups are not available here",
  unavailableBody:
    "This service cannot make backups or exports. Run the local Rastrata service to use them.",
  needsBook: "Set up a book first",
  needsBookBody: "There is nothing to back up until a book is set up.",

  // Facts
  factsTitle: "Where you stand",
  newestBackup: "Newest backup",
  lastVerified: "Last verified backup",
  lastRestoreTest: "Last restore test",
  automatic: "Automatic backups",
  folder: "Backup folder",
  none: "None yet",
  neverTested: "Never tested",
  changesSince: (count: number) =>
    count === 0
      ? "No changes since this backup"
      : `${countText(count)} change${count === 1 ? "" : "s"} since this backup`,
  verifiedWhen: (relative: string) => `verified ${relative}`,
  replayTook: (time: string) => `The check took ${time}`,
  backupMade: (when: string) => `Backup made ${when}`,
  folderNote:
    "Copy this folder to another drive or to storage you trust. A backup on the same disk as your books does not protect you if that disk fails. Backups are not encrypted.",
  autoOn: (hours: number) => `On: about every ${hours === 24 ? "day" : `${hours} hours`}`,
  autoOff: "Off",
  autoNotRunning: "On, but the timer is not running in this service",
  lastRun: (relative: string, ok: boolean) =>
    ok ? `Last run ${relative}, finished` : `Last run ${relative}, did not finish`,
  testPassed: (relative: string) => `Passed ${relative}`,
  testFailed: (relative: string) => `Failed ${relative}`,
  testCompared: (accounts: number, changes: number | null) =>
    `Compared ${countText(accounts)} account${accounts === 1 ? "" : "s"} with your books${
      changes ? `; ${countText(changes)} later change${changes === 1 ? "" : "s"} not compared` : ""
    }`,

  // Actions
  actionsTitle: "Check your backups",
  backUpNow: "Back up now",
  backUpNowHint: "Copies the whole book. It does not change your books or interrupt your work.",
  verify: "Check the newest backup",
  verifyHint:
    "Opens a copy of the backup and replays every entry in your ledger to prove it is whole. It takes longer for a bigger book.",
  drill: "Test a restore",
  drillHint:
    "Restores the newest backup into a temporary folder, as a real restore would, and compares it with your books. Your books are not touched.",
  exportNow: "Export my books",
  exportHint: "Writes your books as ordinary files you can read without Rastrata.",
  busy: "Another job is running. Wait for it to finish.",
  needsBackup: "Back up first: there is no backup to use.",

  // A running job
  jobTitle: (kind: JobKind) =>
    ({
      backup: "Backing up",
      verify: "Checking a backup",
      drill: "Testing a restore",
      export: "Exporting your books",
    })[kind],
  jobStays: "Your books stay usable while this runs.",
  jobReplayNote:
    "A check replays every entry in your ledger, so it takes longer for a bigger book: about a second for every thousand entries, and much longer for a book made by an earlier version of Rastrata.",
  jobProgress: (done: number, total: number) => `${countText(done)} of ${countText(total)}`,
  jobElapsed: (time: string) => `${time} so far`,
  jobRemaining: (time: string) => `about ${time} left (an estimate)`,
  jobStarting: "Starting…",
  jobStillGoing:
    "This is taking longer than the screen waited. The job is still running in the service; this page keeps asking and will show the result.",
  jobUncertain:
    "The connection dropped, so the result is not known yet. The job may still be running. Reconnect to ask again; nothing is started twice.",
  reconnect: "Reconnect",
  jobFailed: (message: string) => `It did not finish: ${message}`,
  jobFromElsewhere: "A job started by the automatic backups or the command line is running.",

  // Results
  resultBackup: "Backup made",
  resultVerifyPassed: "The backup passed every check",
  resultVerifyFailed: "The backup failed a check. Do not rely on it",
  resultDrillPassed: "The restore test passed: the backup rebuilds your books",
  resultDrillFailed: "The restore test failed. A backup that does not restore is not a safety net",
  resultExport: "Export written",
  resultExportBody: (folder: string) => `It is in ${folder}.`,
  checksTitle: "What was checked",
  showChecks: "Show what was checked",
  checkPassed: "Passed",
  checkFailed: "Failed",
  checkSkipped: "Skipped",
  nextAfterFail:
    "Make a new backup and check it. Keep the failed one until you have a good one: it may still hold something recoverable.",
  dismiss: "Dismiss",

  // The list
  listTitle: "Your backups",
  listEmpty: "No backups yet",
  listEmptyBody:
    "Back up now to make the first one. Automatic backups also start on their own once the service has been running for a few minutes.",
  caption: "Backups, newest first",
  scrollLabel: "Backups, scroll sideways on a narrow screen",
  colMade: "Made",
  colWhy: "How",
  colSize: "Size",
  colPosition: "Ledger position",
  colCheck: "Check",
  colActions: "Actions",
  reasonLabel: (reason: "manual" | "scheduled" | "startup" | "shutdown") =>
    ({
      manual: "By you",
      scheduled: "Automatic",
      startup: "At start-up",
      shutdown: "At shutdown",
    })[reason],
  checkLine: {
    never: "Not checked",
    passed: "Passed",
    failed: "Failed",
    missing: "File missing",
  },
  verifyRow: (when: string) => `Check the backup made ${when}`,
  drillRow: (when: string) => `Test a restore of the backup made ${when}`,
  rowFailedHint: "The details say which check failed.",
  positionHelp: "How far your ledger had got when the backup was taken.",
  unrecordedTitle: "Files in the backup folder that are not backups",
  unrecordedBody:
    "These have no valid record beside them, so Rastrata will not use or restore them. Leave them alone or remove them yourself.",
  showAll: (count: number) => `Show all ${count} backups`,
  showFewer: "Show fewer",

  // Settings
  settingsTitle: "Automatic backups",
  settingsIntro:
    "Rastrata backs up on its own while the service is running, and once more when it stops. These settings need your own access: an agent cannot change them.",
  settingsOwnerOnly: "Changing these settings needs owner access.",
  settingsOwnerOnlyBody:
    "This connection cannot change them. They are shown so you can see how backups are kept.",
  scheduleTitle: "Schedule",
  warnTitle: "Warnings",
  enabled: "Back up automatically",
  interval: "Back up every (hours)",
  intervalHint: "From 1 to 720. Rastrata makes a new backup only if something has changed.",
  onShutdown: "Also back up when the service stops",
  verifyAfter: "Check each automatic backup",
  verifyAfterHint:
    "Uses spare time in the background. It also repeats the check daily on a backup that has not changed.",
  keepTitle: "How many automatic backups to keep",
  keepHint:
    "The newest backup of each of the last days, weeks and months is kept. Backups you make by hand, the newest backup and the newest verified one are never removed.",
  keepDaily: "Daily backups to keep",
  keepWeekly: "Weekly backups to keep",
  keepMonthly: "Monthly backups to keep",
  warnAfter: "Warn me when no backup has been checked for (hours)",
  warnAfterHint: "From 1 to 8,760. It must be at least as long as the time between backups.",
  save: "Save settings",
  saving: "Saving…",
  saved: "Settings saved",
  lowerWarning:
    "Keeping fewer backups deletes older automatic backups at the next clean-up. That cannot be undone.",
  errorTitle: "There is a problem",
  errorRange: (label: string, low: number, high: number) =>
    `${label} must be a whole number from ${countText(low)} to ${countText(high)}.`,
  errorWarn:
    "The warning time must be at least as long as the time between backups, or the book would warn about backups that are not yet due.",
  saveFailed: "The settings could not be saved. Your settings have not changed.",

  // Export
  exportTitle: "Export your books",
  exportIntro:
    "An export is an open copy of your books: ordinary files (JSON and CSV, with a README) that you or an accountant can read without Rastrata, and that Rastrata can rebuild a book from. It holds the books, not drafts, transactions waiting for review or settings; a backup holds those.",
  exportListTitle: "Exports",
  exportEmpty: "No exports yet",
  exportCounts: (journals: number, accounts: number) =>
    `${countText(journals)} ${journals === 1 ? "entry" : "entries"}, ${countText(accounts)} account${accounts === 1 ? "" : "s"}`,
  exportCheck: "To check an export without Rastrata, run in its folder:",
  exportRebuild: "To rebuild a book from it:",
  exportNotEncrypted:
    "The files are not encrypted and hold everything: keep them where you would keep the books themselves.",

  // Restoring
  restoreTitle: "Restoring after a bad day",
  restoreBody:
    "Restoring is done from the command line, with the service stopped, because it replaces files. It checks the backup first, refuses to overwrite an existing database unless you say so, keeps a copy of what it replaces and refuses a database that is open.",
  restoreCommand: "rastrata restore latest --to PATH --replace",
  restoreAfter:
    "Then start the service. The first start may replay the whole ledger, which takes about as long as a check. If you changed your books after the backup was made, those changes are not in it, and an agent token you revoked since may be valid again: run rastrata tokens list.",
} as const;

/** What each check in a verification or a drill is, in a few words. The service's own message goes
 * under it; this is only the label. */
export function checkLabel(check: CheckView): string {
  return (
    (
      {
        file_present: "The backup file is there",
        file_sha256: "The file matches its record",
        integrity: "The database structure is sound",
        ledger_stored: "The ledger inside matches the record",
        working_copy: "A working copy is identical",
        restore_copy: "The restored copy is identical to the backup",
        ledger_replay: "Every entry replays to the result it had",
        ledger_head: "The replay ends where the record says",
        kernel_chain: "The restored books are an earlier state of yours",
        trial_balance: "Every account balance matches your books",
      } as Record<string, string>
    )[check.code] ?? check.code
  );
}

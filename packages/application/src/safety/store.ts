import { ApplicationError } from "../errors.ts";
import type { ApplicationService } from "../service.ts";
import { migrate, sliceState } from "../slices/state.ts";
import type { ApplicationStore } from "../storage.ts";
import { DEFAULT_BACKUP_SETTINGS, type BackupSettings, type DrillRecord } from "./types.ts";

/** Product state of the safety lane. Ordered and append-only: never edit a released step. */
const STEPS: readonly string[] = [
  `CREATE TABLE safety_settings (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     body TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE safety_drills (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ran_at TEXT NOT NULL,
     backup_id TEXT NOT NULL,
     passed INTEGER NOT NULL,
     body TEXT NOT NULL
   );`,
];
/** How many drills are kept. Each is a few kilobytes; a person wants the last few. */
const KEEP_DRILLS = 50;

/** Check settings the schema cannot: the fields relate to one another. */
export function checkSettings(settings: BackupSettings): BackupSettings {
  if (settings.enabled && settings.warnAfterHours < settings.intervalHours)
    throw new ApplicationError(
      "invalid_input",
      "Warn after must be at least as long as the time between automatic backups, or the book would warn about backups that are not yet due.",
      400,
      [{ path: "input.warnAfterHours", message: "Use at least the backup interval" }],
    );
  return {
    enabled: settings.enabled,
    intervalHours: settings.intervalHours,
    onShutdown: settings.onShutdown,
    verifyAfterBackup: settings.verifyAfterBackup,
    keepDaily: settings.keepDaily,
    keepWeekly: settings.keepWeekly,
    keepMonthly: settings.keepMonthly,
    warnAfterHours: settings.warnAfterHours,
  };
}

export class SafetyStore {
  constructor(private readonly store: ApplicationStore) {
    migrate(store, "safety", STEPS);
  }

  settings(): BackupSettings {
    const row = this.store.query("SELECT body FROM safety_settings WHERE id=1").get() as {
      body: string;
    } | null;
    if (!row) return DEFAULT_BACKUP_SETTINGS;
    try {
      return checkSettings({ ...DEFAULT_BACKUP_SETTINGS, ...JSON.parse(row.body) });
    } catch {
      // Unreadable settings must not switch the safety net off: fall back to the defaults.
      return DEFAULT_BACKUP_SETTINGS;
    }
  }

  saveSettings(settings: BackupSettings, now: Date): BackupSettings {
    const checked = checkSettings(settings);
    this.store
      .query(
        "INSERT INTO safety_settings (id, body, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at",
      )
      .run(JSON.stringify(checked), now.toISOString());
    return checked;
  }

  recordDrill(record: DrillRecord): void {
    this.store.transaction(() => {
      this.store
        .query("INSERT INTO safety_drills (ran_at, backup_id, passed, body) VALUES (?, ?, ?, ?)")
        .run(record.ranAt, record.backupId, record.passed ? 1 : 0, JSON.stringify(record));
      this.store
        .query(
          "DELETE FROM safety_drills WHERE id NOT IN (SELECT id FROM safety_drills ORDER BY id DESC LIMIT ?)",
        )
        .run(KEEP_DRILLS);
    });
  }

  lastDrill(): DrillRecord | null {
    const row = this.store
      .query("SELECT body FROM safety_drills ORDER BY id DESC LIMIT 1")
      .get() as { body: string } | null;
    if (!row) return null;
    try {
      return JSON.parse(row.body) as DrillRecord;
    } catch {
      return null;
    }
  }
}

export const safetyStore = (service: ApplicationService): SafetyStore =>
  sliceState(service, "safety", (store) => new SafetyStore(store));

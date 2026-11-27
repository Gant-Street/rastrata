import { AUTOMATIC_REASONS, type BackupSettings, type StoredBackup } from "./types.ts";

export interface RetentionPlan {
  /** Why each kept backup is kept: `newest`, `newest-verified`, `manual`, `daily`, `weekly`,
   * `monthly`, `failed-verification` (kept so a person can see it). */
  readonly keep: ReadonlyMap<string, readonly string[]>;
  /** Backups retention would remove, oldest first. Never a manual backup. */
  readonly remove: readonly string[];
}

/** ISO 8601 week of a UTC date, as `2026-W40`. */
export function isoWeek(date: Date): string {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(target.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((target.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Which automatic backups to keep. The newest backup of each of the last `keepDaily` days that have
 * one, of the last `keepWeekly` weeks and of the last `keepMonthly` months, plus three things that
 * are never removed whatever the settings say: manual backups (a person made them on purpose), the
 * newest backup, and the newest backup that passed verification (the one you would restore).
 * Days, weeks and months are UTC. Pure: it decides, the host deletes.
 */
export function planRetention(
  backups: readonly StoredBackup[],
  settings: BackupSettings,
): RetentionPlan {
  const ordered = [...backups].sort((a, b) => (a.manifest.id < b.manifest.id ? 1 : -1));
  const keep = new Map<string, string[]>();
  const hold = (id: string, why: string) => {
    const reasons = keep.get(id);
    if (reasons) {
      if (!reasons.includes(why)) reasons.push(why);
    } else keep.set(id, [why]);
  };
  const newest = ordered[0];
  if (newest) hold(newest.manifest.id, "newest");
  const verified = ordered.find((item) => item.verification?.passed === true);
  if (verified) hold(verified.manifest.id, "newest-verified");
  for (const item of ordered)
    if (!AUTOMATIC_REASONS.includes(item.manifest.reason)) hold(item.manifest.id, "manual");
  const automatic = ordered.filter((item) => AUTOMATIC_REASONS.includes(item.manifest.reason));
  const bucket = (
    key: (createdAt: Date) => string,
    count: number,
    why: "daily" | "weekly" | "monthly",
  ) => {
    const seen = new Set<string>();
    for (const item of automatic) {
      const k = key(new Date(item.manifest.createdAt));
      if (seen.has(k)) continue;
      if (seen.size >= count) break;
      seen.add(k);
      hold(item.manifest.id, why);
    }
  };
  bucket((d) => d.toISOString().slice(0, 10), settings.keepDaily, "daily");
  bucket(isoWeek, settings.keepWeekly, "weekly");
  bucket((d) => d.toISOString().slice(0, 7), settings.keepMonthly, "monthly");
  const remove = [...automatic]
    .reverse()
    .filter((item) => !keep.has(item.manifest.id))
    .map((item) => item.manifest.id);
  return { keep, remove };
}

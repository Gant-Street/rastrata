import { formatAge, formatBytes, formatCount, formatDuration, formatInstant } from "../format";
import type { BackupView, SafetyClock } from "./types";

/** "just now", "12 minutes ago", "30 hours ago", "3 days ago". */
export const relativeTime = (clock: SafetyClock, iso: string): string => formatAge(iso, clock.now);

/** An instant on the viewer's own clock, "Oct 4, 2026, 1:01 PM": an entry made in the evening is
 * dated that evening. */
export const exactTime = (_clock: SafetyClock, iso: string): string => formatInstant(iso);

/** 1.8 MiB, 340 KiB, 2.1 GiB. */
export const sizeText = formatBytes;

/** 380 ms, 41 s, 2 min 5 s, 1 h 3 min. */
export const durationText = formatDuration;

/** A whole number with thousands separators, in the viewer's locale. */
export const countText = (value: number | string, locale = "en-US"): string =>
  formatCount(typeof value === "string" ? Number(value) : value, locale);

/** What the newest verified backup says about its check, in one line. */
export function verificationLine(clock: SafetyClock, backup: BackupView): string {
  const verification = backup.verification;
  if (!verification) return "Not checked yet";
  const when = relativeTime(clock, verification.verifiedAt);
  return verification.passed ? `Passed, ${when}` : `Failed, ${when}`;
}

/** A percentage for a progress bar, or null when the amount of work is not known. */
export function percent(done: number | null, total: number | null): number | null {
  if (done === null || total === null || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

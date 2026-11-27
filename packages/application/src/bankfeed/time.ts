import { addDays, isCalendarDate } from "../ingest/text.ts";

/** SimpleFIN carries every time as Unix epoch seconds (`posted`, `balance-date`, `start-date`,
 * `end-date`), and the protocol says nothing about a time zone. A calendar date in Rastrata is a
 * `YYYY-MM-DD` with no zone, so an epoch is read as the **UTC** date it falls on. That is the one
 * choice that cannot be wrong for the Americas: a bank that writes a posting date as midnight in any
 * US zone (04:00 to 10:00 UTC) lands on the same UTC date, and the Bridge's demo data does exactly
 * that (08:00 UTC, midnight Pacific). The raw epoch is kept in the archived answer. */
export const SECONDS_PER_DAY = 86_400;

/** The latest date the pipeline accepts (see ingest/validate.ts). */
const LAST_EPOCH = Date.UTC(2100, 11, 31, 23, 59, 59) / 1000;

/** True for a whole number of seconds from 1970 to the end of 2100. A `posted` of 0 means pending
 * and is not one of these. */
export const isPlausibleEpoch = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= LAST_EPOCH;

/** The UTC calendar date of an epoch, `YYYY-MM-DD`. */
export function utcDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/** Midnight UTC at the start of a date, in epoch seconds. Throws for text that is not a date. */
export function epochOfDate(date: string): number {
  if (!isCalendarDate(date)) throw new TypeError(`Not a date: ${date}`);
  return (
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) /
    1000
  );
}

/** The UTC date `days` after (or before, if negative) another. */
export const shiftDate = (date: string, days: number): string => addDays(date, days);

export interface Window {
  /** Inclusive start, epoch seconds: the Bridge's `start-date`. */
  readonly from: number;
  /** Exclusive end, epoch seconds: the Bridge's `end-date` ("before, but not on"). */
  readonly to: number;
}

/** Cut `[from, to)` into consecutive windows of at most `days` days, oldest first, that tile it with
 * no gap and no overlap: each window starts exactly where the one before ended, so no instant is
 * ever read twice or skipped by the cutting itself. */
export function cutWindows(from: number, to: number, days: number): Window[] {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || !(days >= 1))
    throw new TypeError("A window needs whole-second bounds and at least one day");
  const size = Math.floor(days) * SECONDS_PER_DAY;
  const windows: Window[] = [];
  for (let start = from; start < to; start += size)
    windows.push({ from: start, to: Math.min(start + size, to) });
  return windows;
}

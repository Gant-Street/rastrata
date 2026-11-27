/** Calendar-date arithmetic for reports. Dates are `YYYY-MM-DD` local dates: a date is a label on
 * the calendar, never an instant, so nothing here reads a clock or converts through a time zone.
 * Pure and portable. */

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface DateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** The parts of a real calendar date, or null for a malformed or impossible one ("2026-02-30"). */
export function parseDate(value: string): DateParts | null {
  const match = DATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export const isDate = (value: unknown): value is string =>
  typeof value === "string" && parseDate(value) !== null;

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const MILLISECONDS_PER_DAY = 86_400_000;

/** Days since 1970-01-01. `Date.UTC` maps years 0 to 99 to the 1900s, so set the year explicitly. */
export function toDays(value: string): number {
  const parts = parseDate(value);
  if (!parts) throw new TypeError(`Invalid date ${value}`);
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  return Math.round(date.getTime() / MILLISECONDS_PER_DAY);
}

export function fromDays(days: number): string {
  const date = new Date(days * MILLISECONDS_PER_DAY);
  return formatDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export const addDays = (value: string, days: number): string => fromDays(toDays(value) + days);

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from: string, to: string): number => toDays(to) - toDays(from);

/** Move by whole months, keeping the day of the month where it exists and otherwise using the last
 * day ("2026-01-31" plus one month is "2026-02-28"). */
export function addMonths(value: string, months: number): string {
  const parts = parseDate(value);
  if (!parts) throw new TypeError(`Invalid date ${value}`);
  const index = parts.year * 12 + (parts.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return formatDate(year, month, Math.min(parts.day, daysInMonth(year, month)));
}

export function endOfMonth(value: string): string {
  const parts = parseDate(value);
  if (!parts) throw new TypeError(`Invalid date ${value}`);
  return formatDate(parts.year, parts.month, daysInMonth(parts.year, parts.month));
}

export const isStartOfMonth = (value: string): boolean => parseDate(value)?.day === 1;
export const isEndOfMonth = (value: string): boolean => endOfMonth(value) === value;

/** Calendar months from the month of `from` to the month of `to`, counting both. */
export function monthSpan(from: string, to: string): number {
  const start = parseDate(from);
  const end = parseDate(to);
  if (!start || !end) throw new TypeError("Invalid date range");
  return (end.year - start.year) * 12 + (end.month - start.month) + 1;
}

/** The range a comparison column covers. A range of whole calendar months compares with the same
 * number of months before it (March against February, a quarter against the quarter before, a year
 * against the year before). Any other range compares with the same number of days immediately
 * before it. "Previous year" moves both ends back twelve months and keeps an end-of-month end at the
 * end of that month, so February 29 compares with February 28. */
export function comparisonRange(
  kind: "previousPeriod" | "previousYear",
  from: string,
  to: string,
): { readonly from: string; readonly to: string } {
  if (kind === "previousYear") {
    const shifted = addMonths(to, -12);
    return {
      from: addMonths(from, -12),
      to: isEndOfMonth(to) ? endOfMonth(shifted) : shifted,
    };
  }
  if (isStartOfMonth(from) && isEndOfMonth(to)) {
    const months = monthSpan(from, to);
    return { from: addMonths(from, -months), to: endOfMonth(addMonths(to, -months)) };
  }
  const days = daysBetween(from, to) + 1;
  return { from: addDays(from, -days), to: addDays(from, -1) };
}

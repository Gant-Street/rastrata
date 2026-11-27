/** The dates a report is read for. A book's fiscal years come from its calendar (its first and last
 * dates, taken from the periods the book was set up with), so a fiscal year that starts in October or a
 * calendar of several years needs no special case. Choosing a period is the kit's `DateRangeField`;
 * this file holds what a report needs once it has the dates: the months they touch, and how a range is
 * said. Dates are `YYYY-MM-DD` local dates: a label on the calendar, never an instant, so nothing here
 * reads a clock or a time zone. */

import {
  daysInMonth,
  formatDate,
  formatDateRange,
  isDate,
  parseDate,
  type DateParts,
} from "../format";

export { daysInMonth, isDate, parseDate };

export interface FiscalYearSpan {
  /** The calendar year in which the fiscal year starts. */
  readonly year: number;
  readonly startsOn: string;
  readonly endsOn: string;
}

export interface DateRange {
  readonly from: string;
  readonly to: string;
}

export type CompareChoice = "none" | "previousPeriod" | "previousYear";

const pad = (value: number, width = 2) => String(value).padStart(width, "0");
const format = (year: number, month: number, day: number) =>
  `${pad(year, 4)}-${pad(month)}-${pad(day)}`;

/** The first day of the month `offset` months after the month of `date`. */
function monthStart(date: string, offset: number): string {
  const parts = parseDate(date) ?? { year: 1970, month: 1, day: 1 };
  const index = parts.year * 12 + (parts.month - 1) + offset;
  return format(Math.floor(index / 12), (index % 12) + 1, 1);
}

/** The last day of the month `offset` months after the month of `date`. */
function monthEnd(date: string, offset: number): string {
  const first = parseDate(monthStart(date, offset)) as DateParts;
  return format(first.year, first.month, daysInMonth(first.year, first.month));
}

/** The fiscal year containing a date, or undefined when no year of the calendar does. */
export function yearContaining(
  years: readonly FiscalYearSpan[],
  date: string,
): FiscalYearSpan | undefined {
  return years.find((span) => span.startsOn <= date && date <= span.endsOn);
}

/** The dates an older link's `period` stood for: "month:2026-03", "quarter:2025-Q2" (the second quarter
 * of the fiscal year that starts in 2025, whenever it starts) or "year:2025". A value this calendar does
 * not have is undefined. Links made before the dates were chosen with the kit's field still open. */
export function olderPeriod(
  period: string,
  years: readonly FiscalYearSpan[],
): DateRange | undefined {
  const [kind, value = ""] = period.split(":");
  if (kind === "year") {
    const span = years.find((year) => String(year.year) === value);
    return span && { from: span.startsOn, to: span.endsOn };
  }
  if (kind === "month") {
    const from = `${value}-01`;
    if (!/^\d{4}-\d{2}$/.test(value) || !isDate(from) || !yearContaining(years, from))
      return undefined;
    return { from, to: monthEnd(from, 0) };
  }
  if (kind === "quarter") {
    const match = /^(\d{4})-Q([1-4])$/.exec(value);
    const span = match && years.find((year) => String(year.year) === match[1]);
    if (!match || !span) return undefined;
    const from = monthStart(span.startsOn, (Number(match[2]) - 1) * 3);
    if (from > span.endsOn) return undefined;
    const to = monthEnd(from, 2);
    return { from, to: to > span.endsOn ? span.endsOn : to };
  }
  return undefined;
}

/** One calendar month a range touches, with the part of it the range covers. A month the range covers
 * whole has `partial` false; the first and last months of a range that starts or ends inside one are
 * partial, and their `from` and `to` are the range's own. */
export interface MonthWindow extends DateRange {
  /** "2026-03": the month, whole or part. */
  readonly month: string;
  readonly partial: boolean;
  /** True when the window ends on the month's last day: what a balance sheet column, which is a
   * single day, needs to know to call itself by the month. */
  readonly endsMonth: boolean;
}

/** The most months a by-month report reads. Each month is one read of the service, so the number is
 * held where a person asking for it can be told why it stopped. */
export const MAX_MONTH_COLUMNS = 24;

/** The calendar months a range touches, in order, each clipped to the range. A range that is not two
 * real dates in order has none. The months need not belong to one fiscal year: a column is a month. */
export function monthWindows(range: DateRange): MonthWindow[] {
  if (!isDate(range.from) || !isDate(range.to) || range.from > range.to) return [];
  const windows: MonthWindow[] = [];
  for (let offset = 0; ; offset++) {
    const first = monthStart(range.from, offset);
    if (first > range.to) break;
    const last = monthEnd(range.from, offset);
    const from = first < range.from ? range.from : first;
    const to = last > range.to ? range.to : last;
    windows.push({
      month: first.slice(0, 7),
      from,
      to,
      partial: from !== first || to !== last,
      endsMonth: to === last,
    });
    // A range cannot have more months than this, so a malformed call can never loop for long.
    if (offset > 12_000) break;
  }
  return windows;
}

/** One date, in the product's one date format: "Jun 30, 2026". */
export function describeDate(date: string): string {
  return formatDate(date);
}

/** A range of dates, the same way: "Mar 1 to Mar 31, 2026". */
export function describeRange(range: DateRange): string {
  return formatDateRange(range.from, range.to);
}

import type { FiscalPeriod } from "@rastrata/kernel";

import { ApplicationError } from "../errors.ts";

/** One fiscal year of the book, as its periods define it. `year` is the label the periods carry
 * (the calendar year in which the fiscal year starts); the dates are the first day of its first
 * period and the last day of its last period. Nothing here assumes a January start. */
export interface FiscalYearInfo {
  readonly year: number;
  readonly startsOn: string;
  readonly endsOn: string;
}

/** The fiscal calendar a book's periods define: what dates it can report on and which fiscal year
 * each belongs to. */
export interface FiscalCalendar {
  readonly firstDate: string;
  readonly lastDate: string;
  readonly years: readonly FiscalYearInfo[];
  /** The fiscal year containing `date`, or undefined when no period covers it. */
  yearOf(date: string): FiscalYearInfo | undefined;
}

/** Group the regular periods by fiscal year. The kernel resolves every accounting date to exactly one
 * regular period; an adjustment period lies inside the dates of regular ones and never defines where
 * a fiscal year starts or ends, so it is left out here (as the calendar lane's coverage is). */
export function fiscalCalendar(periods: readonly FiscalPeriod[]): FiscalCalendar {
  const byYear = new Map<number, { startsOn: string; endsOn: string }>();
  for (const period of periods) {
    if (period.kind !== "regular") continue;
    const year = Number(period.fiscalYear);
    const startsOn: string = period.startsOn;
    const endsOn: string = period.endsOn;
    const known = byYear.get(year);
    if (!known) byYear.set(year, { startsOn, endsOn });
    else {
      if (startsOn < known.startsOn) known.startsOn = startsOn;
      if (endsOn > known.endsOn) known.endsOn = endsOn;
    }
  }
  const years: FiscalYearInfo[] = [...byYear.entries()]
    .map(([year, span]) => ({ year, startsOn: span.startsOn, endsOn: span.endsOn }))
    // ISO dates order correctly as plain strings; a locale collation may ignore the hyphens.
    .sort((left, right) =>
      left.startsOn < right.startsOn ? -1 : left.startsOn > right.startsOn ? 1 : 0,
    );
  const first = years[0];
  const last = years.at(-1);
  return {
    firstDate: first?.startsOn ?? "",
    lastDate: last?.endsOn ?? "",
    years,
    yearOf(date) {
      let low = 0;
      let high = years.length - 1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        const candidate = years[middle] as FiscalYearInfo;
        if (date < candidate.startsOn) high = middle - 1;
        else if (date > candidate.endsOn) low = middle + 1;
        else return candidate;
      }
      return undefined;
    },
  };
}

/** The error for a date the book's calendar does not cover. It names the date and the covered range
 * and says how to extend, so a person or an agent can act without guessing. The same code is used
 * wherever a date falls outside the configured periods. */
export function calendarNotConfigured(
  calendar: FiscalCalendar,
  date: string,
  field: string,
): ApplicationError {
  const covered = calendar.firstDate
    ? `The book's calendar covers ${calendar.firstDate} to ${calendar.lastDate}.`
    : "The book has no fiscal periods.";
  return new ApplicationError(
    "calendar_not_configured",
    `${date} is outside the book's fiscal calendar. ${covered} Extend the calendar to report on that date.`,
    409,
    [{ path: field, message: `${date} is not covered by a fiscal period` }],
  );
}

/** The fiscal year containing `date`, or the calendar_not_configured error. */
export function requireFiscalYear(
  calendar: FiscalCalendar,
  date: string,
  field: string,
): FiscalYearInfo {
  const year = calendar.yearOf(date);
  if (!year) throw calendarNotConfigured(calendar, date, field);
  return year;
}

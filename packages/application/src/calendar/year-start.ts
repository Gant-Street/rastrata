import { fiscalPeriodId, localDate, type BookState, type FiscalPeriod } from "@rastrata/kernel";
import { ApplicationError } from "../errors.ts";
import {
  MAX_FISCAL_YEAR,
  fiscalYearOf,
  fiscalYearPeriods,
  periodIdFor,
  type CalendarShape,
} from "./fiscal-calendar.ts";
import { calendarCoverage } from "./kernel-calendar.ts";

/** Changing the month fiscal years start in.
 *
 * A fiscal year is a label on each period, and the core accepts a new calendar only if it takes effect
 * after the last entry. While a book has no entry and no close, nothing refers to any period, so the
 * whole calendar can be drawn again under the new month. Once there is an entry, the periods it sits in
 * are part of the book's history and cannot be regrouped: the way then is a new book that the history is
 * brought into (the importer ties every year out).
 *
 * The month the ledger's calendar starts its years in is read from the ledger, never from the stored
 * setup, which keeps the month the book was created with: the two could otherwise disagree after a
 * crash between the ledger and the product state. */

/** The month the newest fiscal year of the ledger's calendar starts in. */
export const calendarMonthOf = (state: BookState, fallback: number): number =>
  monthOfPeriods(state.periods, fallback);

/** The month the newest fiscal year of a list of periods starts in. */
export function monthOfPeriods(periods: readonly FiscalPeriod[], fallback: number): number {
  let newest: number | undefined;
  let first: string | undefined;
  for (const period of periods) {
    if (period.kind !== "regular") continue;
    const year = Number(period.fiscalYear);
    if (newest === undefined || year > newest) {
      newest = year;
      first = period.startsOn;
    } else if (year === newest && first !== undefined && period.startsOn < first) {
      first = period.startsOn;
    }
  }
  return first === undefined ? fallback : Number(first.slice(5, 7));
}

/** The calendar's shape as the ledger has it. */
export function ledgerShape(
  state: BookState,
  setup: {
    readonly fiscalYearStartMonth: number;
    readonly periodModel: CalendarShape["periodModel"];
  },
): CalendarShape {
  return {
    fiscalYearStartMonth: calendarMonthOf(state, setup.fiscalYearStartMonth),
    periodModel: setup.periodModel,
  };
}

/** Why the month cannot be changed, or null when it can. */
export function yearStartBlocker(state: BookState): { code: string; message: string } | null {
  // The posting sequence counts the entries one by one, so it is past zero exactly when there is an entry;
  // reading the list of entries for its length would copy the whole of it at every state.
  if (state.latestPostingSequence > 0n)
    return {
      code: "year_start_has_entries",
      message:
        "The fiscal year can be changed until the first entry is posted. After that the periods hold history and cannot be regrouped: set up a new book with the right fiscal year and bring this book's entries into it.",
    };
  if (state.periodTransitions.length > 0)
    return {
      code: "year_start_has_closes",
      message:
        "A period has been closed, so the fiscal year can no longer be changed. Set up a new book with the right fiscal year and bring this book's entries into it.",
    };
  return null;
}

export interface YearStartPlan {
  /** The whole calendar under the new month. */
  readonly periods: readonly FiscalPeriod[];
  readonly month: number;
  readonly firstDate: string;
  readonly lastDate: string;
  /** The first day of the first period; the core needs it to fall after every entry (there are none). */
  readonly effectiveOn: string;
  readonly fiscalYears: readonly number[];
}

/** The first day on or after `date` that starts a fiscal year under `month`. */
function firstYearStartOnOrAfter(date: string, month: number): string {
  const year = fiscalYearOf(date, month);
  const start = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
  return start >= date
    ? start
    : `${String(year + 1).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
}

/** The calendar a book with no entries has under a new fiscal-year month: it starts on the first day of
 * the first fiscal year that begins on or after the old calendar's first day (a book that began in the
 * middle of a year loses the months before the first year start, which nothing could be dated in), and
 * it ends where the new fiscal year containing the old last day ends. Pure: it only reads the state. */
export function planYearStart(
  state: BookState,
  current: CalendarShape,
  month: number,
  booksBegan: string | null,
): YearStartPlan {
  if (month === current.fiscalYearStartMonth)
    throw new ApplicationError(
      "year_start_unchanged",
      "The fiscal year already starts in that month. There is nothing to change.",
      409,
    );
  const blocker = yearStartBlocker(state);
  if (blocker) throw new ApplicationError(blocker.code, blocker.message, 409);
  const oldCoverage = calendarCoverage(state.periods);
  const firstDate = firstYearStartOnOrAfter(oldCoverage.startsOn, month);
  const shape: CalendarShape = { fiscalYearStartMonth: month, periodModel: current.periodModel };
  const firstYear = fiscalYearOf(firstDate, month);
  const lastYear = Math.min(MAX_FISCAL_YEAR, fiscalYearOf(oldCoverage.endsOn, month));
  if (booksBegan !== null && booksBegan < firstDate)
    throw new ApplicationError(
      "year_start_before_books",
      `The books began on ${booksBegan}, before the first fiscal year that would start in that month (${firstDate}). Move the start date later or choose another month.`,
      409,
    );
  const specs = Array.from({ length: lastYear - firstYear + 1 }, (_, index) =>
    fiscalYearPeriods(firstYear + index, shape),
  ).flat();
  const calendarId = state.identity.fiscalCalendarId;
  // Sequences count on from one in date order: a fiscal year here may have a different number of
  // periods than the others, so they cannot be worked out from the year and the position in it.
  const periods: FiscalPeriod[] = specs.map((spec, index) => ({
    id: fiscalPeriodId(periodIdFor(spec.fiscalYear, spec.ordinal, firstYear, `m${month}`)),
    calendarId,
    fiscalYear: BigInt(spec.fiscalYear),
    sequence: BigInt(index + 1),
    label: spec.label,
    kind: "regular",
    startsOn: localDate(spec.startsOn),
    endsOn: localDate(spec.endsOn),
  }));
  const last = periods[periods.length - 1];
  if (!last) throw new Error("A calendar has periods");
  return {
    periods,
    month,
    firstDate,
    lastDate: last.endsOn,
    effectiveOn: firstDate,
    fiscalYears: Array.from({ length: lastYear - firstYear + 1 }, (_, index) => firstYear + index),
  };
}

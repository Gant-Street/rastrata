import type { BookState } from "@rastrata/kernel";
import { ApplicationError } from "../errors.ts";
import { extendThroughFor } from "./extend.ts";
import type { CalendarShape } from "./fiscal-calendar.ts";
import { calendarCoverage } from "./kernel-calendar.ts";

/** True when a regular fiscal period contains `date`. The periods are gap-free, so this is the same
 * as the date lying between the first period's start and the last period's end. */
export function calendarCovers(state: BookState, date: string): boolean {
  return state.periods.some(
    (period) => period.kind === "regular" && period.startsOn <= date && date <= period.endsOn,
  );
}

/** The error for a posting dated outside the book's fiscal calendar, or null when the date is
 * covered. It names the date and the range. A posting grows the calendar itself for a date after its end
 * (`ensureCalendarCovers`), so what reaches a caller is a date before the first day, a date past the last
 * fiscal year Rastrata supports, or an end the calendar could not be grown past; the last still says how
 * to extend by hand. The code is the one every date outside the calendar uses (reports too), so a caller
 * sees one condition. `field` is the input path the date came from. */
export function calendarNotConfigured(
  state: BookState,
  shape: CalendarShape,
  date: string,
  field: string,
): ApplicationError | null {
  if (calendarCovers(state, date)) return null;
  const { startsOn, endsOn } = calendarCoverage(state.periods);
  const range = `The book's fiscal calendar covers ${startsOn} to ${endsOn}.`;
  const through = extendThroughFor(state, shape, date);
  const details = [
    { path: field, message: `${date} is not covered by a fiscal period` },
    { path: "calendar", message: `${startsOn} to ${endsOn}` },
  ];
  if (through !== null)
    return new ApplicationError(
      "calendar_not_configured",
      `${date} is after the end of the book's fiscal calendar. ${range} Extend the calendar through fiscal year ${through} (periods.extend with {"through": ${through}}), then post again; a posting dated in that year grows the calendar itself.`,
      409,
      [...details, { path: "extendThrough", message: String(through) }],
    );
  return new ApplicationError(
    "calendar_not_configured",
    date < startsOn
      ? `${date} is before the first day of the book's fiscal calendar. ${range} A book cannot be posted to before its first period, and that date is fixed when the book is created; post on or after ${startsOn}.`
      : `${date} is past the last fiscal year Rastrata supports. ${range}`,
    409,
    details,
  );
}

/** Throw the `calendar_not_configured` error for a posting date the calendar does not cover. */
export function requireCalendarDate(
  state: BookState,
  shape: CalendarShape,
  date: string,
  field: string,
): void {
  const failure = calendarNotConfigured(state, shape, date, field);
  if (failure) throw failure;
}

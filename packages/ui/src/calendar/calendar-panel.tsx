import type { JSX } from "solid-js";
import type { CalendarView } from "./types";
import { words } from "./words";

/** What the calendar covers, in one line, and that it grows on its own: an entry dated after its last day
 * adds the fiscal years it needs (2026-11-05), so there is nothing here to press. A year that does not
 * start in January is named, because January is what everyone expects. */
export function CalendarLine(props: { calendar: CalendarView }): JSX.Element {
  const starts = () => words.yearStarts(props.calendar.fiscalYearStartMonth);
  return (
    <p>
      <bdi>{words.coverage(props.calendar.firstDate, props.calendar.lastDate)}</bdi> {words.grows}
      {starts() ? ` ${starts()}` : ""}
    </p>
  );
}

/** The calendar's line under its own heading, for a page that sets it out as a section. */
export function CalendarSummary(props: { calendar: CalendarView }): JSX.Element {
  return (
    <section class="rt-cal-summary" aria-labelledby="rt-cal-summary-title">
      <h2 id="rt-cal-summary-title" class="rt-cal-label">
        {words.calendar}
      </h2>
      <CalendarLine calendar={props.calendar} />
    </section>
  );
}

import { Show } from "solid-js";
import { Button } from "../button";
import { SelectField } from "../select-field";
import type { FiscalYearView } from "./types";
import { words } from "./words";

/** Where a screen returns focus after the guided year-end closes: the year's heading, or the button
 * that opened it. */
export const YEAR_TITLE_ID = "rt-cal-year-title";
export const CLOSE_YEAR_ID = "rt-cal-close-year";

/** Choose the fiscal year to look at. A native select: every year of the calendar is one option, and
 * each option says how far along the year is in words, so the choice never depends on color. The
 * year's dates are on the summary right below, where there is room: an option short enough to read in
 * the closed select at a phone's width is worth more than dates in every option. */
export function FiscalYearPicker(props: {
  years: readonly FiscalYearView[];
  value: number | undefined;
  onChange: (year: number) => void;
  disabled?: boolean;
}) {
  return (
    <div class="rt-cal-picker">
      <SelectField
        label={words.fiscalYear}
        value={props.value === undefined ? "" : String(props.value)}
        disabled={props.disabled ?? false}
        items={props.years.map((year) => ({
          value: String(year.fiscalYear),
          label: words.yearOption(year.fiscalYear, words.status[year.status]),
        }))}
        onChange={(value) => props.onChange(Number(value))}
      />
    </div>
  );
}

/** The year being looked at: its dates, how many of its periods are closed, what is left, and the
 * way into closing it. The button appears once the year has ended (its last day is before today);
 * until then one sentence says when it ends. The button is disabled, with the reason beside it, when
 * nothing is left to close, so a person never wonders why it does nothing. How far along the year is, is
 * the count of its periods; it wears no badge. */
export function YearSummary(props: {
  year: FiscalYearView;
  /** The day the books began, when one is recorded: it says what "before the books began" means. */
  booksBegan?: string | null;
  /** A write is under way or retained. */
  blocked?: boolean;
  /** The page has another main button: this one is a plain one. */
  secondary?: boolean | undefined;
  /** The person may close. One who may not is not offered the button. */
  mayClose?: boolean | undefined;
  onCloseYear: () => void;
}) {
  // A year that ended before the books began has nothing in it to close.
  const left = () => (props.year.beforeBooks ? 0 : props.year.periodCount - props.year.closedCount);
  return (
    <section class="rt-cal-year" aria-labelledby={YEAR_TITLE_ID}>
      <div class="rt-cal-year-head">
        <h2 id={YEAR_TITLE_ID} tabindex="-1">
          {words.yearTitle(props.year.fiscalYear)}
        </h2>
      </div>
      <p class="rt-cal-year-dates">
        <bdi>{words.yearDates(props.year.startsOn, props.year.endsOn)}</bdi>
        {" · "}
        {words.progress(props.year.closedCount, props.year.periodCount)}
      </p>
      <Show when={props.year.supersededCount > 0}>
        <p class="rt-cal-note" role="status">
          {words.supersededCount(props.year.supersededCount)}
        </p>
      </Show>
      <Show when={props.year.beforeBooks || props.year.periodsBeforeBooks > 0}>
        <p class="rt-cal-note">
          {props.year.beforeBooks
            ? words.yearBeforeBooks(props.booksBegan ?? null)
            : words.beforeBooksNote(props.year.periodsBeforeBooks, props.booksBegan ?? null)}
        </p>
      </Show>
      <div class="rt-cal-year-actions">
        <Show
          when={props.year.ended && props.mayClose !== false}
          fallback={
            <Show when={!props.year.ended}>
              <span class="rt-cal-note">{words.yearEnds(props.year.endsOn)}</span>
            </Show>
          }
        >
          <Button
            id={CLOSE_YEAR_ID}
            label={
              props.year.supersededCount > 0
                ? words.closeYearAgain(props.year.fiscalYear)
                : words.closeYear(props.year.fiscalYear)
            }
            variant={props.secondary ? "secondary" : "primary"}
            disabled={(props.blocked ?? false) || left() === 0}
            onClick={props.onCloseYear}
          />
          <Show when={left() === 0 && !props.year.beforeBooks}>
            <span class="rt-cal-note">{words.nothingToClose}</span>
          </Show>
        </Show>
      </div>
    </section>
  );
}

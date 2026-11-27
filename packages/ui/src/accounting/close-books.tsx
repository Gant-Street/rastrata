import { createUniqueId, For, Show, type JSX } from "solid-js";
import { Button, buttonAttrs } from "../button";
import { CalendarLine } from "../calendar/calendar-panel";
import { PeriodHistoryList } from "../calendar/period-history";
import { periodActionId } from "../calendar/period-table";
import type { CalendarView, FiscalYearView, HistoryEntry } from "../calendar/types";
import { FiscalYearPicker, YearSummary } from "../calendar/year-picker";
import { CloseNotes } from "../catchall/close-notes";
import type { CloseNote } from "../catchall/types";
import { formatDate } from "../format";
import { Details } from "../kit/details";
import type { CloseLine } from "./close-logic";
import { closeWords, type PeriodUnit } from "./close-words";

/** The line under the title: how far the books are closed. Until a month is closed it says what closing is,
 * once; after that the date is the whole line. It takes the cursor after a close or a reopening, so a screen
 * reader says where the books now stand. */
export function CloseLead(props: {
  id?: string | undefined;
  /** The last day the books are closed through, as it is shown ("Oct 31, 2026"); null when none is. */
  through: string | null;
  /** Something can be closed now. */
  hasWork: boolean;
  unit?: PeriodUnit | undefined;
}): JSX.Element {
  const w = closeWords;
  return (
    <p class="rt-close-through" id={props.id} tabindex="-1">
      <Show
        when={props.through}
        fallback={
          <>
            <strong>{props.hasWork ? w.nothingClosed : w.nothingToClose}</strong>{" "}
            {w.explanation(props.unit)}
          </>
        }
      >
        {(date) => <strong>{w.closedThrough(date())}</strong>}
      </Show>
    </p>
  );
}

export interface CloseCardProps {
  /** The month the books would be closed through: "October 2026". */
  label: string;
  /** `checking` until the month's checklist has been read; `failed` when it could not be, so nothing here
   * is current. */
  state: "checking" | "ready" | "failed";
  /** What is left, each with the one place that deals with it. Empty when the month can be closed. */
  left: readonly CloseLine[];
  /** What does not stand in the way and is worth a look first, as sentences. */
  look?: readonly string[] | undefined;
  /** What the month notes without making it a thing to do: money collecting in an account for what fits
   * nowhere else. A note never keeps a month from closing. */
  notes?: readonly CloseNote[] | undefined;
  /** The close is on its way. */
  closing?: boolean | undefined;
  /** A write is retained or under way: the button waits. */
  blocked?: boolean | undefined;
  /** The person may close. One who may not is told who does, in place of the button. */
  mayClose?: boolean | undefined;
  /** How a close ended short: which month would not close. */
  stopped?: string | null | undefined;
  /** The button's id, so the page can put the cursor back on it. */
  buttonId?: string | undefined;
  onClose: () => void;
  onRetry: () => void;
  /** What the host puts in the card: the review of a close whose plan has something to read. */
  panel?: JSX.Element;
  unit?: PeriodUnit | undefined;
}

/** The one card of Close the books: the months that can be closed now, named by the last of them, what is
 * left before they can (each line with its one button), and "Close through October 2026", which works when
 * nothing is left. What is done is not listed: the list is only what a person still has to do. */
export function CloseCard(props: CloseCardProps): JSX.Element {
  const w = closeWords;
  const titleId = createUniqueId();
  const ready = () => props.state === "ready" && props.left.length === 0;
  return (
    <section
      class="rt-close-card"
      aria-labelledby={titleId}
      data-state={props.state}
      data-ready={ready() ? "" : undefined}
    >
      <h2 id={titleId}>{w.through(props.label)}</h2>
      <Show when={props.stopped}>
        {(message) => (
          <p class="rt-close-run-stopped" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show when={props.state === "checking"}>
        <p role="status" class="rt-hint">
          {w.checking}
        </p>
      </Show>
      <Show when={props.state === "failed"}>
        <p role="alert">{w.checkFailed(props.unit)}</p>
        <div class="rt-close-actions">
          <Button variant="secondary" size="sm" label={w.retry} onClick={props.onRetry} />
        </div>
      </Show>
      <Show when={props.state === "ready"}>
        <Show when={props.left.length > 0}>
          {/* What the book says is left: its own facts, set out as sentences. */}
          <ul class="rt-close-left" data-facts="">
            <For each={props.left}>
              {(line) => (
                <li class="rt-close-line">
                  <span class="rt-close-text">
                    <bdi dir="auto">{line.text}</bdi>
                  </span>
                  <Show when={line.action}>
                    {(action) => (
                      <a
                        class="rt-button"
                        data-variant="secondary"
                        data-size="sm"
                        href={action().href}
                        aria-label={action().name}
                      >
                        {action().label}
                      </a>
                    )}
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <CloseNotes notes={props.notes ?? []} />
        <Show when={(props.look ?? []).length > 0}>
          <div class="rt-close-look">
            <Details summary={w.look((props.look ?? []).length)}>
              <ul data-facts="">
                <For each={props.look}>
                  {(text) => (
                    <li>
                      <bdi dir="auto">{text}</bdi>
                    </li>
                  )}
                </For>
              </ul>
            </Details>
          </div>
        </Show>
        {props.panel}
        <div class="rt-close-actions">
          <Show when={props.mayClose !== false} fallback={<p class="rt-hint">{w.ownerCloses}</p>}>
            <Button
              id={props.buttonId}
              label={w.closeThrough(props.label)}
              disabled={!ready() || props.blocked === true}
              pending={props.closing === true}
              pendingLabel={w.closing.working(props.label)}
              onClick={props.onClose}
            />
          </Show>
        </div>
      </Show>
    </section>
  );
}

/** A month that is closed, with the way to open it again. */
export interface ClosedMonth {
  readonly id: string;
  readonly label: string;
  /** Its close no longer matches the books (an earlier month was reopened since). */
  readonly superseded: boolean;
  readonly reportHref: string | null;
}

/** "Closed months (3)": a shut list, each with Reopen. Reopening is rare and may undo later closes, so it
 * sits out of the way. It opens by itself, and says why beside its name, when a close no longer matches the
 * books: that is the one thing here a person has to do something about. */
export function ClosedMonths(props: {
  months: readonly ClosedMonth[];
  blocked?: boolean | undefined;
  /** The person may reopen. One who may not sees the list and the reports, and no button. */
  mayReopen?: boolean | undefined;
  onReopen: (id: string) => void;
  /** What the host puts after the list (its review panel for a reopening). */
  panel: JSX.Element;
  unit?: PeriodUnit | undefined;
}): JSX.Element {
  const w = closeWords.closedMonths;
  const stale = () => props.months.filter((month) => month.superseded).length;
  return (
    <Show when={props.months.length > 0}>
      <div class="rt-close-closed">
        <Details
          summary={w.title(props.months.length, props.unit)}
          preview={stale() > 0 ? w.stale(stale()) : undefined}
          defaultOpen={stale() > 0}
        >
          <ul class="rt-close-closed-list">
            <For each={props.months}>
              {(month) => (
                <li class="rt-close-closed-row">
                  <span>
                    <bdi>{month.label}</bdi>
                    <Show when={month.superseded}>
                      <small>
                        {" "}
                        · {w.superseded}. {w.closeAgainHint}
                      </small>
                    </Show>
                  </span>
                  <Show when={month.reportHref && !month.superseded}>
                    <a href={month.reportHref as string}>{w.report}</a>
                  </Show>
                  <Show when={props.mayReopen !== false}>
                    {/* The row names the month; the button's own name says it again for a screen reader. */}
                    <button
                      {...buttonAttrs({ variant: "secondary", size: "sm" })}
                      type="button"
                      id={periodActionId(month.id)}
                      aria-label={w.reopenNamed(month.label)}
                      disabled={props.blocked === true}
                      onClick={() => props.onReopen(month.id)}
                    >
                      {w.reopen}
                    </button>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Details>
        {props.panel}
      </div>
    </Show>
  );
}

/** "Close the year": a fold until the year has ended, with when it ends beside its name. Once the year has
 * ended and something in it is left to close, the page opens it. Inside are the year's dates, how many of
 * its periods are closed and the way into closing it; a book with several years chooses one here. */
export function CloseYear(props: {
  year: FiscalYearView;
  years: readonly FiscalYearView[];
  onYear: (year: number) => void;
  booksBegan?: string | null | undefined;
  blocked?: boolean | undefined;
  /** The page's main button is this one: nothing else on it can be closed. */
  main?: boolean | undefined;
  /** The person may close. */
  mayClose?: boolean | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseYear: () => void;
}): JSX.Element {
  const w = closeWords.year;
  const left = () => (props.year.beforeBooks ? 0 : props.year.periodCount - props.year.closedCount);
  const preview = () =>
    !props.year.ended
      ? w.ends(props.year.fiscalYear, formatDate(props.year.endsOn))
      : left() === 0 && props.year.supersededCount === 0
        ? w.closed(props.year.fiscalYear)
        : w.ended(props.year.fiscalYear);
  return (
    <Details
      summary={w.title}
      preview={preview()}
      open={props.open}
      onOpenChange={props.onOpenChange}
    >
      <div class="rt-close-year">
        <Show when={props.years.length > 1}>
          <FiscalYearPicker
            years={props.years}
            value={props.year.fiscalYear}
            onChange={props.onYear}
          />
        </Show>
        <YearSummary
          year={props.year}
          booksBegan={props.booksBegan ?? null}
          blocked={props.blocked ?? false}
          secondary={props.main !== true}
          mayClose={props.mayClose}
          onCloseYear={props.onCloseYear}
        />
      </div>
    </Details>
  );
}

/** "Calendar and history": what the calendar covers, and every close and reopening the book has recorded.
 * A record to look something up in, so it is one shut line at the foot. */
export function CloseCalendar(props: {
  calendar: CalendarView;
  history: readonly HistoryEntry[];
}): JSX.Element {
  return (
    <Details summary={closeWords.calendar.title}>
      <div class="rt-close-calendar">
        <CalendarLine calendar={props.calendar} />
        <PeriodHistoryList entries={props.history} />
      </div>
    </Details>
  );
}

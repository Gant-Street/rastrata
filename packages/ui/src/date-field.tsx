import { DatePicker, parseDate as calendarDay } from "@ark-ui/solid/date-picker";
import { createUniqueId, For, type JSX, onMount, Show } from "solid-js";
import { buttonAttrs } from "./button";
import { readTypedDate } from "./date-typed";
import { FieldError, FieldHint } from "./field";
import { type DateParts, formatDate, isDate, localToday, parseDate, storedDate } from "./format";
import { CalendarDays, ChevronLeft, ChevronRight } from "./icons";
import { useUi } from "./locale";

/** The kinds of box that, two or more to a form with no button, keep Enter from submitting it. */
const TYPED = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "date",
  "month",
  "week",
  "time",
  "datetime-local",
  "number",
]);

/** Ark keeps a region for a screen reader per picker, at the end of the page, and marks it an alert as well
 * as assertive. The mark adds nothing for a screen reader and makes an empty alert of every date on a page,
 * so it is taken off; what the region says, and how, is unchanged. */
const unmarkAnnouncers = () => {
  for (const region of document.querySelectorAll('[data-live-announcer][role="alert"]'))
    region.removeAttribute("role");
};

/** Today on the person's own clock, as the parts of a day. */
const today = (): DateParts => parseDate(localToday()) as DateParts;

/** One calendar day: a box to type it in and a calendar to pick it from. Ark's date picker owns both.
 *
 * The box shows the day in numbers, month first ("10/04/2026"), whatever format the book writes dates in
 * elsewhere: Ark's box takes digits and the slash and nothing else, so a date shown as "Oct 4, 2026" could not
 * be changed in place. It is what the browser's own date box showed, and what Xero and QuickBooks show. It
 * reads the ways people shorten a date (`readTypedDate`): "10/4", "10/4/26", "1004", "100426". The value is
 * the stored form, `YYYY-MM-DD`, or empty. A day outside `min` and `max` cannot be picked from the calendar;
 * typed, it is kept as typed and the screen says what is wrong with it, since a date quietly moved into range
 * would be the wrong date.
 *
 * The screen has the date as soon as what is typed reads as one, as it did from the browser's date box, so a
 * button that waits for a date is ready when the person reaches for it. The box is not written again while
 * it is being typed in, whatever date the screen or the picker holds: it is written out in full when it is
 * left, or on Enter. This field does that keeping, not Ark: Ark turns text it cannot read into the day its
 * calendar stands on (today, in an empty field), and a date nobody typed is the worst thing a book can be
 * given. Text that is no date puts back the date the screen has. Ark also stops Enter in the box; here Enter
 * does what it does in any field of a form. */
export function DateField(props: {
  label: string;
  /** Keep the label for assistive technology only, where a row or a group already says what the date is. */
  hideLabel?: boolean | undefined;
  hint?: string | undefined;
  error?: string | undefined;
  /** The date is wrong and the words for it are elsewhere (see `describedBy`), as for the two dates of a range. */
  invalid?: boolean | undefined;
  /** `YYYY-MM-DD`, or empty for no date. */
  value: string;
  onChange: (value: string) => void;
  /** The first and last days the calendar offers, `YYYY-MM-DD`. */
  min?: string | undefined;
  max?: string | undefined;
  disabled?: boolean | undefined;
  required?: boolean | undefined;
  /** The box's id, for a page that points at the field (an error summary, a step's first field). */
  id?: string | undefined;
  /** Ids of text elsewhere that describes the field. */
  describedBy?: string | undefined;
  onBlur?: (() => void) | undefined;
  /** Enter in the box, after the date is kept, where the screen has its own answer to it. Without it Enter
   * submits the form the field is in, as in any field. */
  onEnter?: (() => void) | undefined;
  /** The box itself, for a screen that puts the cursor in it. */
  ref?: ((element: HTMLInputElement) => void) | undefined;
  class?: string | undefined;
}): JSX.Element {
  const ui = useUi();
  const generated = createUniqueId();
  const id = props.id ?? generated;
  const describedBy = () =>
    [props.describedBy, props.hint && `${id}-hint`, props.error && `${id}-error`]
      .filter(Boolean)
      .join(" ") || undefined;
  const outside = (day: string) =>
    (props.min !== undefined && isDate(props.min) && day < props.min) ||
    (props.max !== undefined && isDate(props.max) && day > props.max);
  onMount(() => {
    unmarkAnnouncers();
    // Ark makes its region as it mounts, which may be after this.
    queueMicrotask(unmarkAnnouncers);
    requestAnimationFrame(unmarkAnnouncers);
  });
  const shown = (value: string) => (isDate(value) ? formatDate(value, { format: "numeric" }) : "");
  /** What the box holds while the person is typing in it. Ark writes the box again a frame after the date
   * changes; while this is set it writes these same words, so the cursor stays where it is and half a date
   * ("10/1" on the way to "10/15") is not finished for the person. */
  let typing: string | null = null;
  /** The date the box's words read as, the empty string for an empty box, or null when they are no date. */
  const read = (text: string): string | null => {
    const typed = text.trim();
    if (typed === "") return "";
    const day = readTypedDate(typed, today());
    return day ? storedDate(day) : null;
  };
  /** Where the cursor was when the person last typed, until they next press a key or the pointer. */
  let caret: [start: number, end: number] | null = null;
  /** Ark writes the box after it hears of typing and again a frame after the date changes, and a box that
   * is written loses its cursor to the end. While the person is typing, the words and the cursor are theirs. */
  const hold = (input: HTMLInputElement) => {
    if (typing === null || document.activeElement !== input) return;
    if (input.value !== typing) input.value = typing;
    // A write leaves the cursor at the end of the box, collapsed. A cursor anywhere else, or words that are selected, were put there by someone (a program that selects all and types over the
    // words does so a frame after the last key), and the cursor put back then would have the new words appended to the old ones: such a box is left as it is.
    const end = input.value.length;
    if (caret && input.selectionStart === end && input.selectionEnd === end)
      input.setSelectionRange(caret[0], caret[1]);
  };
  /** The person typed: the screen has the date as soon as the words read as one. */
  const type = (input: HTMLInputElement) => {
    typing = input.value === "" ? null : input.value;
    const end = input.value.length;
    caret = [input.selectionStart ?? end, input.selectionEnd ?? end];
    const next = read(input.value);
    // An emptied box Ark has told the screen of already.
    if (next !== null && next !== "" && next !== props.value) props.onChange(next);
    queueMicrotask(() => hold(input));
    requestAnimationFrame(() => {
      hold(input);
      requestAnimationFrame(() => hold(input));
    });
  };
  /** The box is left, or Enter pressed: a date that can be read is the value, an empty box is no date, and
   * anything else puts back the date the screen has. The box is written out in full. */
  const keep = (input: HTMLInputElement) => {
    // The words the person typed are theirs until the box is left, even if the box was written over since (Ark writes it a frame or more after the date changes, later on a slow
    // computer): a date typed and then left at once is the date typed, and not the one Ark wrote back.
    const words = typing ?? input.value;
    typing = null;
    caret = null;
    const next = read(words) ?? props.value;
    if (next !== props.value) props.onChange(next);
    if (input.value !== shown(next)) input.value = shown(next);
  };
  const onEnter = (event: KeyboardEvent) => {
    const input = event.target;
    if (event.key !== "Enter" || event.isComposing) return;
    if (!(input instanceof HTMLInputElement)) return;
    event.preventDefault();
    keep(input);
    // After the screen has the date.
    queueMicrotask(() => (props.onEnter ? props.onEnter() : submit(input)));
  };
  /** Enter in a field of a form does what a browser does with it: it presses the form's button (nothing,
   * while that button is off), and in a form with no button it submits only when this is the form's one box
   * to type in. */
  const submit = (input: HTMLInputElement) => {
    const form = input.form;
    if (!form) return;
    const fields = Array.from(form.elements);
    const button = fields.find(
      (element): element is HTMLButtonElement | HTMLInputElement =>
        (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) &&
        element.type === "submit",
    );
    if (button) {
      if (!button.disabled) button.click();
      return;
    }
    const typed = fields.filter(
      (element) => element instanceof HTMLInputElement && TYPED.has(element.type),
    );
    if (typed.length <= 1) form.requestSubmit();
  };
  return (
    <DatePicker.Root
      class={props.class ? `rt-field rt-date-field ${props.class}` : "rt-field rt-date-field"}
      ids={{ input: () => id }}
      locale={ui.locale}
      timeZone="UTC"
      selectionMode="single"
      disabled={props.disabled ?? false}
      invalid={Boolean(props.error) || props.invalid === true}
      value={isDate(props.value) ? [calendarDay(props.value)] : []}
      onValueChange={(detail) => {
        // A day picked from the calendar, or the box emptied: Ark's own change, written the usual way.
        typing = null;
        props.onChange(detail.value[0]?.toString() ?? "");
      }}
      format={(day) => typing ?? formatDate(day.toString(), { format: "numeric" })}
      parse={(text) => {
        const day = readTypedDate(text, today());
        return day ? calendarDay(storedDate(day)) : undefined;
      }}
      isDateUnavailable={(day) => outside(day.toString())}
      {...(isDate(props.value) ? {} : { defaultFocusedValue: calendarDay(localToday()) })}
      positioning={{ placement: "bottom-start" }}
      // The calendar is in the page only while it is open: a screen has several dates, and a closed calendar's
      // days would still answer to a search for the field's label.
      lazyMount
      unmountOnExit
    >
      <DatePicker.Label class={props.hideLabel ? "rt-sr-only" : undefined}>
        {props.label}
      </DatePicker.Label>
      <DatePicker.Control
        class="rt-control rt-date-control"
        // Before Ark hears the key: Ark would choose the day its calendar stands on and stop the key there.
        ref={(control: HTMLElement) => control.addEventListener("keydown", onEnter, true)}
      >
        <DatePicker.Input
          class="rt-input"
          index={0}
          fixOnBlur={false}
          ref={(element: HTMLInputElement) => props.ref?.(element)}
          inputmode="numeric"
          autocomplete="off"
          required={props.required ?? false}
          aria-describedby={describedBy()}
          aria-invalid={props.error || props.invalid ? "true" : undefined}
          onInput={(event) => type(event.currentTarget)}
          // The person is moving the cursor themselves.
          onKeyDown={() => {
            caret = null;
          }}
          onPointerDown={() => {
            caret = null;
          }}
          onBlur={(event) => {
            keep(event.currentTarget);
            props.onBlur?.();
          }}
        />
        <DatePicker.Trigger class="rt-date-open" aria-label={ui.messages.date.open} tabindex={-1}>
          <CalendarDays aria-hidden="true" />
        </DatePicker.Trigger>
      </DatePicker.Control>
      <Show when={props.hint}>
        <FieldHint id={`${id}-hint`}>{props.hint}</FieldHint>
      </Show>
      <Show when={props.error}>
        <FieldError id={`${id}-error`}>{props.error}</FieldError>
      </Show>
      <DatePicker.Positioner>
        <DatePicker.Content class="rt-popup rt-calendar">
          <DatePicker.View view="day">
            <DatePicker.Context>
              {(context) => (
                <>
                  <DatePicker.ViewControl class="rt-row rt-calendar-nav">
                    <DatePicker.PrevTrigger
                      {...buttonAttrs({ variant: "quiet", iconOnly: true })}
                      aria-label={ui.messages.date.previousMonth}
                    >
                      <ChevronLeft class="rt-dir-icon" aria-hidden="true" />
                    </DatePicker.PrevTrigger>
                    <DatePicker.RangeText />
                    <DatePicker.NextTrigger
                      {...buttonAttrs({ variant: "quiet", iconOnly: true })}
                      aria-label={ui.messages.date.nextMonth}
                    >
                      <ChevronRight class="rt-dir-icon" aria-hidden="true" />
                    </DatePicker.NextTrigger>
                  </DatePicker.ViewControl>
                  <DatePicker.Table>
                    <DatePicker.TableHead>
                      <DatePicker.TableRow>
                        <For each={context().weekDays}>
                          {(day) => <DatePicker.TableHeader>{day.short}</DatePicker.TableHeader>}
                        </For>
                      </DatePicker.TableRow>
                    </DatePicker.TableHead>
                    <DatePicker.TableBody>
                      <For each={context().weeks}>
                        {(week) => (
                          <DatePicker.TableRow>
                            <For each={week}>
                              {(day) => (
                                <DatePicker.TableCell value={day}>
                                  <DatePicker.TableCellTrigger>
                                    {day.day}
                                  </DatePicker.TableCellTrigger>
                                </DatePicker.TableCell>
                              )}
                            </For>
                          </DatePicker.TableRow>
                        )}
                      </For>
                    </DatePicker.TableBody>
                  </DatePicker.Table>
                </>
              )}
            </DatePicker.Context>
          </DatePicker.View>
        </DatePicker.Content>
      </DatePicker.Positioner>
    </DatePicker.Root>
  );
}

// Shared accounting controls. Ark owns their interaction state machines.
import { Checkbox } from "@ark-ui/solid/checkbox";
import { DatePicker, parseDate } from "@ark-ui/solid/date-picker";
import { For, Show, type JSX } from "solid-js";
import { buttonAttrs } from "./button";
import { CalendarDays, Check, ChevronLeft, ChevronRight, Minus } from "./icons";
import { useUi } from "./locale";

/** The account picker is the kit's (`kit/account-picker.tsx`): the combobox this file used to hold, with the
 * code shown muted, group accounts left out, and "New account…" at the foot. It keeps its name and its props
 * here so every existing screen goes on working until its lane moves to the new ones. */
export { AccountPicker } from "./kit/account-picker";

export function CheckField(props: {
  /** Usually words; a line of a list may put a name in `<bdi>`. */
  label: JSX.Element;
  /** A second, quieter line under the label: what ticking it means. */
  hint?: JSX.Element;
  checked?: boolean | "indeterminate";
  onChange?: (value: boolean) => void;
  disabled?: boolean;
  hideLabel?: boolean;
}) {
  return (
    <Checkbox.Root
      class="rt-choice"
      data-hint={props.hint ? "" : undefined}
      {...(props.checked !== undefined ? { checked: props.checked } : {})}
      disabled={props.disabled ?? false}
      onCheckedChange={(detail) => props.onChange?.(detail.checked === true)}
    >
      <Checkbox.HiddenInput />
      <Checkbox.Control>
        <Checkbox.Indicator>
          <Check aria-hidden="true" />
        </Checkbox.Indicator>
        <Checkbox.Indicator indeterminate>
          <Minus aria-hidden="true" />
        </Checkbox.Indicator>
      </Checkbox.Control>
      <Checkbox.Label class={props.hideLabel ? "rt-sr-only" : undefined}>
        {props.label}
        <Show when={props.hint}>
          <small class="rt-choice-hint">{props.hint}</small>
        </Show>
      </Checkbox.Label>
    </Checkbox.Root>
  );
}

export function CalendarField(props: {
  range?: boolean;
  disabled?: boolean;
  label?: string;
  /** Controlled ISO dates (`YYYY-MM-DD`): one for a single date, two for a range. */
  dateValues?: string[];
  /** Initial ISO dates when uncontrolled. Nothing is preselected by default. */
  defaultDateValues?: string[];
  /** The month to show when nothing is selected. Defaults to the current month. */
  focusedDate?: string;
  /** Earliest and latest selectable ISO dates, so impossible dates cannot be chosen. */
  min?: string;
  max?: string;
  onDatesChange?: (values: string[]) => void;
  hideHint?: boolean;
}) {
  const ui = useUi();
  const label = () =>
    props.label ?? (props.range ? ui.messages.date.period : ui.messages.date.posting);
  return (
    <DatePicker.Root
      class="rt-field"
      locale={ui.locale}
      timeZone="UTC"
      selectionMode={props.range ? "range" : "single"}
      disabled={props.disabled ?? false}
      onValueChange={(detail) =>
        props.onDatesChange?.(detail.value.map((value) => value.toString()))
      }
      {...(props.dateValues !== undefined
        ? { value: props.dateValues.map((value) => parseDate(value)) }
        : {})}
      {...(props.defaultDateValues !== undefined
        ? { defaultValue: props.defaultDateValues.map((value) => parseDate(value)) }
        : {})}
      {...(props.focusedDate ? { defaultFocusedValue: parseDate(props.focusedDate) } : {})}
      {...(props.min ? { min: parseDate(props.min) } : {})}
      {...(props.max ? { max: parseDate(props.max) } : {})}
    >
      <DatePicker.Label>{label()}</DatePicker.Label>
      <DatePicker.Control class="rt-control rt-date-control">
        <DatePicker.Input
          class="rt-input"
          index={0}
          placeholder={ui.messages.date.start}
          {...(props.range ? { "aria-label": ui.messages.date.startOf(label()) } : {})}
        />
        <Show when={props.range}>
          <span class="rt-date-range-sep rt-dir-icon" aria-hidden="true">
            →
          </span>
          <DatePicker.Input
            class="rt-input"
            index={1}
            placeholder={ui.messages.date.end}
            aria-label={ui.messages.date.endOf(label())}
          />
        </Show>
        <DatePicker.Trigger
          {...buttonAttrs({ variant: "secondary", iconOnly: true })}
          aria-label={ui.messages.date.open}
        >
          <CalendarDays aria-hidden="true" />
        </DatePicker.Trigger>
      </DatePicker.Control>
      <Show when={!props.hideHint}>
        <p class="rt-hint">{ui.messages.date.format(ui.locale)}</p>
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

export function InlineHelp(props: { children: JSX.Element }) {
  return <p class="rt-hint">{props.children}</p>;
}

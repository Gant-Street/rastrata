import { createMemo, createSignal, createUniqueId, type JSX, Show } from "solid-js";
import { DateField } from "../date-field";
import { SelectField } from "../select-field";
import { FieldError } from "../field";
import { formatDate } from "../format";
import { useUi } from "../locale";
import {
  calendarBounds,
  dateRangeProblem,
  describeDates,
  presetRange,
  RANGE_PRESETS,
  type DateRangeValue,
  type FiscalCalendar,
  type RangePresetId,
} from "./date-range";

export interface DateRangeFieldProps {
  /** The preset the dates came from, and the dates. Controlled: the field shows what it is given. */
  value: DateRangeValue;
  /** Called with the next value: a preset with its dates worked out from `calendar`, or `custom` with the
   * dates as typed (a half-typed date is the empty string, so check `isUsableRange` before reading). */
  onChange: (value: DateRangeValue) => void;
  /** The book's fiscal calendar and today. Every preset is worked out from it, so a fiscal year that starts
   * in October has October quarters. */
  calendar: FiscalCalendar;
  /** Which presets to offer and in what order. Default: this month, last month, this quarter, last
   * quarter, this fiscal year to date, last fiscal year, custom. List `all` ("All dates", the value
   * `{ preset: "all", from: "", to: "" }`) for a register or a list that should start by showing everything. */
  presets?: readonly RangePresetId[] | undefined;
  /** What the field is called. Default "Date range". */
  label?: string | undefined;
  /** What is wrong, in words, when the screen knows better than the field. It replaces the field's own. */
  error?: string | undefined;
  disabled?: boolean | undefined;
  /** Leave out the line that says which dates the period covers, where the page says it already. */
  hideCovers?: boolean | undefined;
  /** For a toolbar: about 300 px wide, the periods in the list and, for Custom, From and To side by side
   * under it. The line saying which dates the period covers stays for a screen reader and takes no room. */
  compact?: boolean | undefined;
  /** How the field sits. `stacked` (the default) puts each label above its control. `row` is for a toolbar
   * row whose other choices have their labels beside them: the label sits beside the list and, for Custom,
   * From and To sit beside that on the same row, each with its label beside it. Under 40rem each takes a
   * row of its own with its label above it, so a phone has no sideways scroll. As with `compact`, the line
   * saying which dates the period covers stays for a screen reader and takes no room. `row` wins when
   * `compact` is also set. */
  layout?: "stacked" | "row" | undefined;
  /** While the book's calendar is being read, or when it could not be. Presets wait for the calendar. */
  state?: "ready" | "loading" | "error" | undefined;
}

/** The one control for choosing a period, for every report and register: a list of the periods a
 * bookkeeper asks for (This month, Last month, This quarter, Last quarter, This fiscal year to date, Last
 * fiscal year) and Custom, which shows From and To.
 *
 * The periods come from the book's own fiscal calendar and today, never from the calendar year, and one the
 * calendar does not cover (a month before the books began) is listed but cannot be chosen, and says why. The
 * controls are the kit's on Ark (`SelectField` and `DateField`); a date's value is always `YYYY-MM-DD`. A
 * custom range that is the wrong way
 * round or outside the calendar says so beside the dates. */
export function DateRangeField(props: DateRangeFieldProps): JSX.Element {
  const ui = useUi();
  const m = () => ui.messages.kit.dateRange;
  const id = createUniqueId();
  const [touched, setTouched] = createSignal(false);

  const ready = () => props.state === undefined || props.state === "ready";
  const bounds = () => calendarBounds(props.calendar);
  const offered = () => props.presets ?? RANGE_PRESETS;
  // Custom and every date need nothing from the calendar; the others need it to have the period.
  const available = (preset: RangePresetId) =>
    preset === "custom" ||
    preset === "all" ||
    (ready() && presetRange(preset, props.calendar) !== undefined);
  const custom = () => props.value.preset === "custom";

  const problem = createMemo(() =>
    custom() && ready() ? dateRangeProblem(props.value, props.calendar) : undefined,
  );
  const problemText = (): string | undefined => {
    const found = problem();
    if (!found) return undefined;
    if (found.kind === "incomplete") return touched() ? m().incomplete : undefined;
    if (found.kind === "order") return m().order;
    return m().outside(formatDate(found.first), formatDate(found.last));
  };
  const error = () => props.error ?? (props.state === "error" ? m().loadError : problemText());
  const covers = (): string | undefined => {
    if (props.hideCovers || error()) return undefined;
    // "All dates" says it all.
    if (props.value.preset === "all") return undefined;
    if (props.state === "loading") return m().loading;
    if (ready() && bounds() === undefined) return m().noCalendar;
    const { from, to } = props.value;
    return from && to && !problem() ? describeDates(props.value) : undefined;
  };

  const choose = (preset: RangePresetId) => {
    if (preset === "all") {
      props.onChange({ preset, from: "", to: "" });
      return;
    }
    if (preset === "custom") {
      props.onChange({ preset, from: props.value.from, to: props.value.to });
      return;
    }
    const dates = presetRange(preset, props.calendar);
    if (dates) props.onChange({ preset, ...dates });
  };
  const type = (change: { from?: string; to?: string }) =>
    props.onChange({
      preset: "custom",
      from: change.from ?? props.value.from,
      to: change.to ?? props.value.to,
    });
  const describedBy = () =>
    [covers() ? `${id}-covers` : undefined, error() ? `${id}-error` : undefined]
      .filter(Boolean)
      .join(" ") || undefined;
  const row = () => props.layout === "row";
  // In a toolbar (compact, or in a row) the words for the period take no room: a screen reader still has them.
  const toolbar = () => props.compact || row();

  return (
    <fieldset
      class="rt-daterange"
      data-compact={props.compact ? "" : undefined}
      data-layout={row() ? "row" : undefined}
    >
      <legend class="rt-sr-only">{props.label ?? m().label}</legend>
      <SelectField
        class="rt-daterange-preset"
        id={`${id}-preset`}
        label={props.label ?? m().label}
        disabled={props.disabled || !ready()}
        describedBy={describedBy()}
        value={props.value.preset}
        items={offered().map((preset) => ({
          value: preset,
          label: `${m().presets[preset]}${available(preset) ? "" : ` (${m().unavailable})`}`,
          disabled: !available(preset),
        }))}
        onChange={(value) => choose(value as RangePresetId)}
      />
      <Show when={custom()}>
        <DateField
          class="rt-daterange-date"
          id={`${id}-from`}
          label={m().from}
          value={props.value.from}
          min={bounds()?.first}
          max={bounds()?.last}
          disabled={props.disabled || !ready()}
          invalid={Boolean(error())}
          describedBy={error() ? `${id}-error` : undefined}
          onChange={(value) => type({ from: value })}
          onBlur={() => setTouched(true)}
        />
        <DateField
          class="rt-daterange-date"
          id={`${id}-to`}
          label={m().to}
          value={props.value.to}
          min={bounds()?.first}
          max={bounds()?.last}
          disabled={props.disabled || !ready()}
          invalid={Boolean(error())}
          describedBy={error() ? `${id}-error` : undefined}
          onChange={(value) => type({ to: value })}
          onBlur={() => setTouched(true)}
        />
      </Show>
      {/* A polite region, there from the start, so a change of period or a mistake in the dates is said. In a
          toolbar the words for the period are for a screen reader only and take no room, so they sit in a
          region of their own and the visible one holds only what is wrong. */}
      <Show when={toolbar()}>
        <span id={`${id}-covers`} class="rt-sr-only" aria-live="polite" aria-atomic="true">
          {covers() ?? ""}
        </span>
      </Show>
      <div class="rt-daterange-note" aria-live="polite" aria-atomic="true">
        <Show when={!toolbar() && covers()}>
          <p id={`${id}-covers`} class="rt-hint">
            {covers()}
          </p>
        </Show>
        <Show when={error()}>
          <FieldError id={`${id}-error`}>{error()}</FieldError>
        </Show>
      </div>
    </fieldset>
  );
}

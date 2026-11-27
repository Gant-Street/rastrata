import { type JSX, Show } from "solid-js";
import { SelectField } from "../select-field";
import { DateRangeField, type DateRangeValue, type FiscalCalendar } from "../kit";
import type { PayeeDirection } from "./types";
import { words } from "./words";

const SIDES: readonly { value: PayeeDirection; label: string }[] = [
  { value: "both", label: words.showBoth },
  { value: "spent", label: words.showSpent },
  { value: "received", label: words.showReceived },
];

/** The choices above the report, on one row as the statements' are: the dates (the kit's `DateRangeField`,
 * so a fiscal year that starts in October has October quarters), which side to list and order by, and
 * whatever the page puts at the end of the row (Export). The label of a choice sits beside it on a wide
 * screen and above it on a narrow one. */
export function PayeeControls(props: {
  /** The book's fiscal years and today: every period is worked out from them. */
  calendar: FiscalCalendar;
  range: DateRangeValue;
  onRange: (range: DateRangeValue) => void;
  direction: PayeeDirection;
  onDirection: (direction: PayeeDirection) => void;
  disabled?: boolean | undefined;
  /** At the end of the row: the Export menu. */
  children?: JSX.Element;
}): JSX.Element {
  return (
    <div class="rt-report-controls rt-report-no-print">
      <fieldset class="rt-period" disabled={props.disabled ?? false}>
        <legend class="rt-sr-only">{words.controlsGroup}</legend>
        <DateRangeField
          compact
          hideCovers
          value={props.range}
          onChange={props.onRange}
          calendar={props.calendar}
        />
        <SelectField
          class="rt-report-field"
          label={words.showLabel}
          items={SIDES}
          value={props.direction}
          onChange={(value) => props.onDirection(value as PayeeDirection)}
        />
      </fieldset>
      <Show when={props.children}>
        <div class="rt-report-actions">{props.children}</div>
      </Show>
    </div>
  );
}

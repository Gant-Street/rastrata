import { createUniqueId, type JSX, Show } from "solid-js";
import { SelectField } from "../select-field";
import { DateRangeField, type DateRangeValue, type FiscalCalendar } from "../kit";
import { useUi } from "../locale";
import type { CompareChoice } from "./period";
import type { ReportColumns } from "./url-state";
import { type ViewChoice, ViewMenu } from "./view-menu";

/** One of the row's choices, as the kit's select. The label sits beside it on a wide screen and above it on a
 * narrow one. */
function Pick(props: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean | undefined;
  /** Said to a screen reader, and as a tooltip, when the control is off. */
  why?: string | undefined;
}) {
  const id = createUniqueId();
  return (
    <>
      <SelectField
        class="rt-report-field"
        title={props.disabled ? props.why : undefined}
        label={props.label}
        value={props.value}
        items={props.options}
        disabled={props.disabled}
        describedBy={props.disabled && props.why ? `${id}-why` : undefined}
        onChange={props.onChange}
      />
      <Show when={props.disabled && props.why}>
        <span id={`${id}-why`} class="rt-sr-only">
          {props.why}
        </span>
      </Show>
    </>
  );
}

/** The choices above a report, on one row: the dates (the kit's `DateRangeField`) and a comparison with an
 * earlier period, and at the end of the row, beside whatever the page puts there (Export), View: how the
 * same figures are laid out (a column for each month; for the profit and loss, each amount with its share
 * of income) and whether the accounts with no activity are shown. The periods come from the book's own fiscal calendar, so an October year has October to
 * December as its first quarter.
 *
 * A comparison and months in columns do not combine: with months in columns the comparison is off, and
 * says why. Nor do shares of income and months: choosing one in View puts the other away (the page does
 * that, in `onBy` and `onShare`). A statement that has neither months nor shares (the trial balance, the
 * general ledger) and leaves out no account has no View, and one that cannot be compared (the general ledger) no Compare. */
export function ReportControls(props: {
  /** The book's fiscal years and today: every period is worked out from them. */
  calendar: FiscalCalendar;
  range: DateRangeValue;
  onRange: (range: DateRangeValue) => void;
  compare: CompareChoice;
  onCompare: (compare: CompareChoice) => void;
  /** The statement on screen can be compared with an earlier period. */
  canCompare: boolean;
  /** Why a comparison is not available for these dates, if it is not. */
  compareNote?: string | undefined;
  by: ReportColumns;
  onBy: (by: ReportColumns) => void;
  /** The statement on screen can be laid out by month. */
  canBeByMonth: boolean;
  /** Each amount of the profit and loss with its share of total income. Turning it on is the page's cue
   * to take the months out of the columns. */
  share?: boolean | undefined;
  onShare?: ((on: boolean) => void) | undefined;
  /** The statement on screen has income to take a share of (the profit and loss). */
  canShare?: boolean | undefined;
  /** The statement on screen leaves out accounts with no activity (the profit and loss, the balance sheet, the trial
   * balance), and View can show them. */
  canShowEmpty?: boolean | undefined;
  showEmpty?: boolean | undefined;
  onShowEmpty?: ((on: boolean) => void) | undefined;
  disabled?: boolean | undefined;
  /** At the end of the row: the Export menu. */
  children?: JSX.Element;
}): JSX.Element {
  const ui = useUi();
  const t = () => ui.messages.reports;
  const monthsInColumns = () => props.canBeByMonth && props.by === "month";
  /** What View holds for this statement: nothing for one that has neither months nor shares. */
  const views = (): ViewChoice[] => [
    ...(props.canBeByMonth
      ? [
          {
            id: "month",
            label: t().toolbar.byMonth,
            checked: monthsInColumns(),
            onChange: (on: boolean) => props.onBy(on ? "month" : "total"),
          },
        ]
      : []),
    ...(props.canShare
      ? [
          {
            id: "share",
            label: t().share.label,
            checked: !monthsInColumns() && props.share === true,
            onChange: (on: boolean) => props.onShare?.(on),
          },
        ]
      : []),
    ...(props.canShowEmpty
      ? [
          {
            id: "empty",
            label: t().toolbar.emptyAccounts,
            checked: props.showEmpty === true,
            onChange: (on: boolean) => props.onShowEmpty?.(on),
          },
        ]
      : []),
  ];
  return (
    <div class="rt-report-controls rt-report-no-print">
      <fieldset class="rt-period" disabled={props.disabled ?? false}>
        <legend class="rt-sr-only">{t().toolbar.group}</legend>
        <DateRangeField
          compact
          hideCovers
          value={props.range}
          onChange={props.onRange}
          calendar={props.calendar}
        />
        <Show when={props.canCompare}>
          <Pick
            label={t().compare.label}
            value={monthsInColumns() ? "none" : props.compare}
            disabled={monthsInColumns()}
            why={t().compare.offByMonth}
            options={[
              { value: "none", label: t().compare.none },
              { value: "previousPeriod", label: t().compare.previousPeriod },
              { value: "previousYear", label: t().compare.previousYear },
            ]}
            onChange={(value) => props.onCompare(value as CompareChoice)}
          />
        </Show>
      </fieldset>
      <Show when={props.children || views().length > 0}>
        <div class="rt-report-actions">
          <Show when={views().length > 0}>
            <ViewMenu
              label={t().toolbar.view}
              choices={views()}
              disabled={props.disabled ?? false}
            />
          </Show>
          {props.children}
        </div>
      </Show>
      <Show when={props.compareNote && props.canCompare && props.compare !== "none"}>
        <p class="rt-hint">{props.compareNote}</p>
      </Show>
    </div>
  );
}

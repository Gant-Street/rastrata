import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  AccountPicker,
  accountOptions,
  Button,
  DateRangeField,
  defaultRange,
  describeDates,
  isUsableRange,
  RANGE_PRESETS,
  SelectField,
  TextField,
  type DateRangeValue,
  type FiscalCalendar,
  type RangePresetId,
} from "../../src";
import { darkUnlessAsked, Frame } from "./frame";

/** Whole fiscal years from `first` for `count` years, starting on the first of `startMonth`. */
function fiscalCalendar(
  startMonth: number,
  first: number,
  count: number,
  today: string,
): FiscalCalendar {
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    today,
    years: Array.from({ length: count }, (_, index) => {
      const year = first + index;
      const endMonth = startMonth === 1 ? 12 : startMonth - 1;
      const endYear = startMonth === 1 ? year : year + 1;
      const lastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
      return {
        startsOn: `${year}-${pad(startMonth)}-01`,
        endsOn: `${endYear}-${pad(endMonth)}-${pad(lastDay)}`,
      };
    }),
  };
}

const today = "2026-10-04";
const calendarYears = fiscalCalendar(1, 2025, 2, today);

function RangeDemo(props: {
  calendar?: FiscalCalendar;
  start?: DateRangeValue;
  presets?: readonly RangePresetId[];
  state?: "ready" | "loading" | "error";
  error?: string;
  width?: string;
  label?: string;
  hideCovers?: boolean;
  disabled?: boolean;
}) {
  const calendar = () => props.calendar ?? calendarYears;
  const [value, setValue] = createSignal<DateRangeValue>(
    props.start ?? defaultRange(calendar()) ?? { preset: "fiscalYearToDate", from: "", to: "" },
  );
  return (
    <Frame width={props.width ?? "40rem"}>
      <DateRangeField
        value={value()}
        onChange={setValue}
        calendar={calendar()}
        {...(props.presets ? { presets: props.presets } : {})}
        {...(props.state ? { state: props.state } : {})}
        {...(props.error ? { error: props.error } : {})}
        {...(props.label ? { label: props.label } : {})}
        {...(props.hideCovers ? { hideCovers: true } : {})}
        {...(props.disabled ? { disabled: true } : {})}
      />
      <output
        class="rt-hint"
        aria-label="Value"
        style={{ display: "block", "margin-top": "1.5rem" }}
      >
        {isUsableRange(value(), calendar())
          ? `Reading ${value().preset}: ${describeDates(value())}`
          : `Not usable yet (${value().preset}: "${value().from}" to "${value().to}")`}
      </output>
    </Frame>
  );
}

const meta = {
  title: "Lanes/UXKit/DateRangeField",
  component: RangeDemo,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof RangeDemo>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A calendar-year book on 2026-10-04. The periods are the ones Xero and QuickBooks offer, worked out
 * from the book's fiscal calendar; the line under the list says which dates the choice covers. */
export const Default: Story = { args: {} };

/** A fiscal year that starts in October: its quarters are October to December and so on, and "this fiscal
 * year to date" starts on 1 October. Today is 2027-02-10. */
export const OctoberYear: Story = {
  args: { calendar: fiscalCalendar(10, 2025, 2, "2027-02-10") },
};

/** Custom shows From and To, with the dates of the period that was chosen before it to start from. */
export const Custom: Story = {
  args: { start: { preset: "custom", from: "2026-03-01", to: "2026-03-31" } },
};

/** A custom range the wrong way round says so beside the dates, and is not usable. */
export const Invalid: Story = {
  args: { start: { preset: "custom", from: "2026-04-01", to: "2026-03-01" } },
};

/** The first year of a book: there is no last fiscal year and no last quarter yet, so they are listed, and
 * say they are not in the calendar, but cannot be chosen. Today is 2026-02-10. */
export const FirstYear: Story = {
  args: { calendar: fiscalCalendar(1, 2026, 1, "2026-02-10") },
};

/** A book with no calendar yet offers only Custom, and says why. */
export const Empty: Story = {
  args: { calendar: { years: [], today }, start: { preset: "custom", from: "", to: "" } },
};

/** While the book's calendar is being read the periods wait for it. */
export const Loading: Story = { args: { state: "loading" } };

/** A calendar that could not be read says so. */
export const ErrorState: Story = { args: { state: "error" } };

/** Every date, for a register or a list that should start by showing everything: a default of the fiscal
 * year to date would hide a draft, or an entry dated next month. It is offered only where a screen lists it,
 * and the line saying what it covers is left out, because "All dates" says it. */
export const AllDates: Story = {
  args: {
    presets: ["all", ...RANGE_PRESETS],
    start: { preset: "all", from: "", to: "" },
  },
};

/** A short list of presets, for a screen that offers fewer. */
export const SomePresets: Story = {
  args: { presets: ["thisMonth", "lastMonth", "fiscalYearToDate", "custom"], hideCovers: true },
};

/** A long label and a narrow column wrap and never widen the page. */
export const LongContent: Story = {
  args: {
    width: "19rem",
    label: "Period covered by this very long named profit and loss statement for the whole firm",
    start: { preset: "custom", from: "2026-03-01", to: "2026-03-31" },
  },
};

function ToolbarDemo() {
  const [value, setValue] = createSignal<DateRangeValue>(
    defaultRange(calendarYears) as DateRangeValue,
  );
  return (
    <Frame width="72rem">
      <div
        style={{
          display: "flex",
          "flex-wrap": "wrap",
          "align-items": "flex-end",
          gap: "0.75rem 1rem",
          "border-top": "3px solid var(--rt-ink)",
          "padding-top": "1rem",
        }}
      >
        <TextField label="Search" placeholder="Description or number" />
        <DateRangeField compact value={value()} onChange={setValue} calendar={calendarYears} />
        <SelectField
          label="Type"
          items={[
            { label: "All types", value: "all" },
            { label: "Bank", value: "bank" },
            { label: "Stripe", value: "stripe" },
            { label: "Manual", value: "manual" },
          ]}
          defaultValue="all"
        />
        <SelectField
          label="Status"
          items={[
            { label: "All statuses", value: "all" },
            { label: "Posted", value: "posted" },
            { label: "Draft", value: "draft" },
          ]}
          defaultValue="all"
        />
      </div>
    </Frame>
  );
}

/** In a register's toolbar: about 300 px wide beside the other filters, the line saying which dates it
 * covers kept for a screen reader, and From and To side by side under the list for Custom. */
export const Compact: Story = { render: () => <ToolbarDemo /> };

function RowDemo(props: { start?: DateRangeValue; label?: string }) {
  const [value, setValue] = createSignal<DateRangeValue>(
    props.start ?? (defaultRange(calendarYears) as DateRangeValue),
  );
  return (
    <Frame width="72rem">
      <div
        style={{
          display: "flex",
          "flex-wrap": "wrap",
          "align-items": "center",
          gap: "0.75rem 1.5rem",
          "border-top": "3px solid var(--rt-ink)",
          "padding-top": "1rem",
        }}
      >
        <DateRangeField
          layout="row"
          value={value()}
          onChange={setValue}
          calendar={calendarYears}
          {...(props.label ? { label: props.label } : {})}
        />
        <SelectField
          class="rt-report-field"
          label="Compare"
          defaultValue="none"
          items={[
            { value: "none", label: "No comparison" },
            { value: "previous", label: "Previous period" },
          ]}
        />
        <Button label="Export" variant="secondary" />
      </div>
      <output
        class="rt-hint"
        aria-label="Value"
        style={{ display: "block", "margin-top": "1.5rem" }}
      >
        {isUsableRange(value(), calendarYears)
          ? `Reading ${value().preset}: ${describeDates(value())}`
          : `Not usable yet (${value().preset}: "${value().from}" to "${value().to}")`}
      </output>
    </Frame>
  );
}

/** In a toolbar row whose other choices have their labels beside them (a report's Compare, an Export at the
 * end): the label beside the list, on the same line as the others. The line saying which dates the period
 * covers is kept for a screen reader and takes no room. Under 40rem each takes a row of its own with its
 * label above it. */
export const Row: Story = { render: () => <RowDemo /> };

/** Custom in a row: From and To beside the list on the same row, each with its label beside it. */
export const RowCustom: Story = {
  render: () => <RowDemo start={{ preset: "custom", from: "2026-03-01", to: "2026-03-31" }} />,
};

/** A long label in a row: it stays on one line while there is room, and wraps above its control on a phone,
 * so the page is never wider than the window. */
export const RowLongLabel: Story = {
  render: () => (
    <RowDemo
      label="Period covered by this very long named profit and loss statement for the whole firm"
      start={{ preset: "custom", from: "2026-03-01", to: "2026-03-31" }}
    />
  ),
};

const registerChart = accountOptions([
  { id: "bank", code: "1000", name: "Business checking", role: "asset" },
  { id: "sales", code: "4000", name: "Sales", role: "income" },
  { id: "software", code: "6200", name: "Software and subscriptions", role: "expense" },
]);

function RegisterFiltersDemo() {
  const [value, setValue] = createSignal<DateRangeValue>({ preset: "all", from: "", to: "" });
  const [account, setAccount] = createSignal("");
  return (
    <Frame width="80rem">
      <div
        style={{
          display: "flex",
          "flex-wrap": "wrap",
          "align-items": "flex-end",
          gap: "0.75rem 1rem",
          "border-top": "3px solid var(--rt-ink)",
          "padding-top": "1rem",
        }}
      >
        {/* The search and account boxes have widths of their own, as a register's do: a box's natural width is
            the browser's (WebKit's is wider), and five of them did not fit one row of a narrow frame. */}
        <div style={{ width: "16rem" }}>
          <TextField label="Search" placeholder="Description or number" />
        </div>
        <DateRangeField
          compact
          presets={["all", ...RANGE_PRESETS]}
          value={value()}
          onChange={setValue}
          calendar={calendarYears}
        />
        <div style={{ width: "17rem" }}>
          <AccountPicker
            compact
            label="Account"
            allLabel="All accounts"
            accounts={registerChart}
            value={account()}
            onChange={setAccount}
          />
        </div>
        <SelectField
          label="Type"
          items={[
            { label: "All types", value: "all" },
            { label: "Bank", value: "bank" },
            { label: "Manual", value: "manual" },
          ]}
          defaultValue="all"
        />
        <SelectField
          label="Status"
          items={[
            { label: "All statuses", value: "all" },
            { label: "Posted", value: "posted" },
            { label: "Draft", value: "draft" },
          ]}
          defaultValue="all"
        />
      </div>
      <output
        class="rt-hint"
        aria-label="Filters"
        style={{ display: "block", "margin-top": "1rem" }}
      >
        {`${value().preset} · ${account() || "all accounts"}`}
      </output>
    </Frame>
  );
}

/** A register's filter bar: Search, the period, the account, Type and Status in one row. Everything starts on
 * All: "All dates" and "All accounts", so a draft or an entry dated next month is never hidden by a default. */
export const RegisterFilters: Story = { render: () => <RegisterFiltersDemo /> };

/** The dark theme. */
export const Dark: Story = {
  args: { start: { preset: "custom", from: "2026-03-01", to: "2026-03-31" } },
  decorators: [darkUnlessAsked],
};

import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  type CompareChoice,
  defaultRange,
  type DateRangeValue,
  ExportMenu,
  type FiscalYearSpan,
  type ReportColumns,
  ReportControls,
} from "../../src";
import { calendarYears } from "../reports/fixtures";
import { Frame } from "../reports/frame";

const TODAY = "2026-03-15";

function Controls(props: {
  initial?: DateRangeValue;
  compare?: CompareChoice;
  by?: ReportColumns;
  canCompare?: boolean;
  canBeByMonth?: boolean;
  years?: readonly FiscalYearSpan[];
  disabled?: boolean;
  compareNote?: string;
  menuOpen?: boolean;
  narrow?: boolean;
  /** View offers % of income (the profit and loss), and whether it is on. */
  canShare?: boolean;
  share?: boolean;
}) {
  const calendar = () => ({ years: props.years ?? calendarYears, today: TODAY });
  const [range, setRange] = createSignal<DateRangeValue>(
    props.initial ??
      defaultRange(calendar()) ?? { preset: "fiscalYearToDate", from: "2025-10-01", to: TODAY },
  );
  const [compare, setCompare] = createSignal<CompareChoice>(props.compare ?? "none");
  const [by, setBy] = createSignal<ReportColumns>(props.by ?? "total");
  const [share, setShare] = createSignal(props.share ?? false);
  return (
    <Frame>
      <div style={props.narrow ? { "max-width": "390px" } : {}}>
        <ReportControls
          calendar={calendar()}
          range={range()}
          onRange={setRange}
          compare={compare()}
          onCompare={setCompare}
          canCompare={props.canCompare ?? true}
          compareNote={props.compareNote}
          by={by()}
          onBy={(next) => {
            setBy(next);
            if (next === "month") {
              setCompare("none");
              setShare(false);
            }
          }}
          canBeByMonth={props.canBeByMonth ?? true}
          share={share()}
          onShare={(on) => {
            setShare(on);
            if (on) setBy("total");
          }}
          canShare={props.canShare ?? false}
          disabled={props.disabled}
        >
          <ExportMenu
            label="Export"
            disabled={props.disabled}
            defaultOpen={props.menuOpen ?? false}
            actions={[
              { id: "csv", label: "Download CSV", onSelect: () => {} },
              { id: "print", label: "Print or save as PDF", onSelect: () => {} },
            ]}
          />
        </ReportControls>
      </div>
    </Frame>
  );
}

export default {
  title: "Lanes/UXReports/Report controls",
  component: Controls,
  parameters: { layout: "fullscreen", controls: { disable: true } },
} satisfies Meta<typeof Controls>;

type Story = StoryObj<typeof Controls>;

/** The fiscal year to date: from the start of the fiscal year the book is in, to today. */
export const FiscalYearToDate: Story = { render: () => <Controls /> };

/** The periods come from the book's own fiscal years: this one starts in October, so this month is March. */
export const ThisMonth: Story = {
  render: () => (
    <Controls initial={{ preset: "thisMonth", from: "2026-03-01", to: "2026-03-31" }} />
  ),
};

/** The first quarter of an October year is October to December, so last quarter is that one. */
export const LastQuarter: Story = {
  render: () => (
    <Controls initial={{ preset: "lastQuarter", from: "2025-10-01", to: "2025-12-31" }} />
  ),
};

export const LastFiscalYear: Story = {
  render: () => (
    <Controls initial={{ preset: "lastFiscalYear", from: "2024-10-01", to: "2025-09-30" }} />
  ),
};

/** Custom shows From and To under the list, started on the dates that were showing. */
export const CustomDates: Story = {
  render: () => (
    <Controls
      initial={{ preset: "custom", from: "2026-01-01", to: "2026-03-15" }}
      compare="previousPeriod"
    />
  ),
};

/** Dates the wrong way round are named and explained; nothing is requested. */
export const CustomDatesWithAProblem: Story = {
  render: () => <Controls initial={{ preset: "custom", from: "2026-04-01", to: "2026-03-01" }} />,
};

export const OutsideTheCalendar: Story = {
  render: () => <Controls initial={{ preset: "custom", from: "2024-01-01", to: "2026-03-01" }} />,
};

/** With months in columns the comparison is off, and says why to a screen reader and as a tooltip. */
export const ByMonth: Story = { render: () => <Controls by="month" /> };

/** The profit and loss can show each amount with its share of total income: the second choice in View. */
export const PercentOfIncome: Story = { render: () => <Controls canShare /> };

export const PercentOfIncomeOn: Story = { render: () => <Controls canShare share /> };

/** Months in columns and shares do not combine: View has the months ticked and the share not. */
export const PercentOfIncomeWithMonthsInColumns: Story = {
  render: () => <Controls canShare share by="month" />,
};

/** On a phone View and Export share the last row. */
export const PercentOfIncomeOnAPhone: Story = {
  render: () => <Controls canShare share narrow />,
};

/** A statement that is a position on one day has no months to lay side by side. */
export const TrialBalance: Story = { render: () => <Controls canBeByMonth={false} /> };

/** A list of postings has neither a comparison nor months. */
export const GeneralLedger: Story = {
  render: () => <Controls canBeByMonth={false} canCompare={false} />,
};

export const WithAComparisonThatIsNotPossible: Story = {
  render: () => (
    <Controls
      compare="previousYear"
      compareNote="There is nothing to compare with before the book's first fiscal period."
    />
  ),
};

export const Disabled: Story = { render: () => <Controls disabled /> };

/** A calendar of one fiscal year, as a new book has: last fiscal year is listed and cannot be chosen. */
export const OneFiscalYear: Story = {
  render: () => <Controls years={calendarYears.slice(1)} />,
};

/** Export is a button that opens a short list of ways to take the report out of the page. */
export const ExportMenuOpen: Story = { render: () => <Controls menuOpen /> };

/** On a phone each choice has its own row, with its label above it. */
export const Phone: Story = { render: () => <Controls narrow /> };

export const PhoneWithCustomDates: Story = {
  render: () => (
    <Controls narrow initial={{ preset: "custom", from: "2026-01-01", to: "2026-03-15" }} />
  ),
};

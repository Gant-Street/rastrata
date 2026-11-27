import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  CalendarRetainedWrite,
  CalendarSummary,
  FiscalYearPicker,
  Notice,
  PeriodHistory,
  PeriodTable,
  YearSummary,
} from "../../src";
import { calendar, history, manyHistory, monthlyYear, years } from "./fixtures";
import { Frame } from "./frame";

function Overview(props: {
  periods: ReturnType<typeof monthlyYear>;
  year?: number;
  blocked?: boolean;
  locale?: string;
  empty?: boolean;
  /** A cutover part-way through the year: this many periods end before the books began. */
  beforeBooks?: number;
  booksBegan?: string;
}) {
  const [selected, setSelected] = createSignal(props.year ?? 2027);
  const year = () => {
    const found = years.find((item) => item.fiscalYear === selected()) ?? years[0];
    // The periods before the books began are not counted in the year's progress.
    return found && props.beforeBooks
      ? {
          ...found,
          periodCount: found.periodCount - props.beforeBooks,
          closedCount: 0,
          status: "open" as const,
          periodsBeforeBooks: props.beforeBooks,
        }
      : found;
  };
  return (
    <Frame {...(props.locale ? { locale: props.locale } : {})}>
      <div class="rt-stack">
        <CalendarSummary calendar={calendar} />
        <FiscalYearPicker years={years} value={selected()} onChange={setSelected} />
        {year() && (
          <YearSummary
            year={year() as (typeof years)[number]}
            booksBegan={props.booksBegan ?? null}
            blocked={props.blocked ?? false}
            onCloseYear={() => undefined}
          />
        )}
        <PeriodTable
          fiscalYear={selected()}
          periods={props.empty ? [] : props.periods}
          blocked={props.blocked ?? false}
          onClose={() => undefined}
          onReopen={() => undefined}
        />
      </div>
    </Frame>
  );
}

const meta = {
  title: "Lanes/Calendar/Periods",
  component: Overview,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The Periods screen: the calendar and the way to extend it, a picker for the fiscal year, the year's progress with the way into closing it, and the periods as one table. A closed period is locked; a close that no longer matches the books says so in words. Every button names the period it acts on.",
      },
    },
  },
} satisfies Meta<typeof Overview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PartlyClosedYear: Story = {
  args: { periods: monthlyYear(2027, { closed: 5, ended: 12 }) },
};

/** Books that began on 1 March: January and February end before it, hold none of the books' own
 * activity and are not counted as open, though they are listed. */
export const AMidYearCutover: Story = {
  args: {
    periods: monthlyYear(2027, { beforeBooks: 5 }),
    beforeBooks: 5,
    booksBegan: "2028-03-01",
  },
};

export const ClosedYear: Story = {
  args: { year: 2026, periods: monthlyYear(2026, { closed: 12 }) },
};

export const SupersededCloses: Story = {
  args: { periods: monthlyYear(2027, { closed: 3, superseded: 4, ended: 12 }) },
};

export const YearInProgress: Story = {
  args: { year: 2028, periods: monthlyYear(2028, { ended: 2 }) },
};

export const ActionsBlockedByARetainedWrite: Story = {
  args: { periods: monthlyYear(2027, { closed: 5 }), blocked: true },
};

export const NoPeriods: Story = {
  args: { periods: [], empty: true },
};

export const RightToLeft: Story = {
  args: { periods: monthlyYear(2027, { closed: 5 }), locale: "ar" },
};

/** A January calendar says nothing of the month its years start in. */
export const JanuaryCalendar: StoryObj = {
  render: () => (
    <Frame>
      <CalendarSummary
        calendar={{
          ...calendar,
          fiscalYearStartMonth: 1,
          firstDate: "2026-01-01",
          lastDate: "2027-12-31",
        }}
      />
    </Frame>
  ),
};

export const ChangeHistory: StoryObj = {
  render: () => (
    <Frame>
      <PeriodHistory entries={history} />
    </Frame>
  ),
};

export const LongChangeHistory: StoryObj = {
  render: () => (
    <Frame>
      <PeriodHistory entries={manyHistory} />
    </Frame>
  ),
};

export const ReplyLost: StoryObj = {
  render: () => (
    <Frame>
      <CalendarRetainedWrite onResume={() => undefined} />
    </Frame>
  ),
};

export const LoadFailed: StoryObj = {
  render: () => (
    <Frame>
      <Notice title="Periods unavailable" tone="error" role="alert">
        The periods could not be read, so nothing here is current. Your books have not been changed.
        Try again.
      </Notice>
    </Frame>
  ),
};

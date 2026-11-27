import { createSignal, type JSX, Show } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  CloseCalendar,
  CloseCard,
  type ClosedMonth,
  ClosedMonths,
  CloseLead,
  closeLeft,
  type CloseLine,
  type CloseLinks,
  closeLook,
  type CloseNote,
  closeWords,
  CloseYear,
  PageHeader,
  type PeriodUnit,
  UiProvider,
} from "../../src";
import type { CalendarView, FiscalYearView, HistoryEntry } from "../../src/calendar/types";
import { history } from "../calendar/fixtures";
import { holds } from "../catchall/fixtures";
import { notYetChecklist, readyChecklist } from "../shadow/fixtures";

function Frame(props: { children: JSX.Element }): JSX.Element {
  return (
    <UiProvider locale="en-US">
      <div class="rt-theme rt-acct-page" style={{ padding: "1.5rem", "max-width": "64rem" }}>
        {props.children}
      </div>
    </UiProvider>
  );
}

const LINKS: CloseLinks = {
  reconcile: (accountId) => `/reconcile?account=${accountId}`,
  inbox: "/inbox",
  opening: "/opening",
  stripe: "/settings/stripe",
  backups: "/settings/backups",
};

/** The drawn screen: eight transactions to review and one account to reconcile. */
const DRAWN: CloseLine[] = [
  {
    id: "review",
    text: "8 transactions to review.",
    action: { label: "Review", name: "Review transactions", href: "/inbox" },
  },
  {
    id: "reconcile-checking",
    text: "Chase checking is not reconciled through Oct 31, 2026.",
    action: {
      label: "Reconcile",
      name: "Reconcile Chase checking",
      href: "/reconcile?account=checking",
    },
  },
];

const YEAR: FiscalYearView = {
  fiscalYear: 2026,
  startsOn: "2026-01-01",
  endsOn: "2026-12-31",
  periodCount: 12,
  closedCount: 0,
  supersededCount: 0,
  status: "open",
  ended: false,
  beforeBooks: false,
  periodsBeforeBooks: 0,
};

const CALENDAR: CalendarView = {
  firstDate: "2026-01-01",
  lastDate: "2026-12-31",
  fiscalYearStartMonth: 1,
  today: "2026-11-17",
  booksBegan: "2026-01-01",
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** The first months of 2026, closed, newest first, as the fold lists them. */
const closedThrough = (count: number, superseded: readonly number[] = []): ClosedMonth[] =>
  MONTHS.slice(0, count)
    .map((month, index) => ({
      id: `period-${index + 1}`,
      label: `${month} 2026`,
      superseded: superseded.includes(index),
      reportHref: superseded.includes(index) ? null : `/reports?asOf=2026-${index + 1}`,
    }))
    .reverse();

type Preview = {
  /** How far the books are closed, as it is shown; null when nothing is. */
  through?: string | null;
  /** The card; null when there is nothing to close. */
  card?: {
    label: string;
    state?: "checking" | "ready" | "failed";
    left?: readonly CloseLine[];
    look?: readonly string[];
    notes?: readonly CloseNote[];
    stopped?: string;
  } | null;
  closed?: ClosedMonth[];
  year?: Partial<FiscalYearView>;
  years?: FiscalYearView[];
  yearOpen?: boolean;
  history?: HistoryEntry[];
  mayClose?: boolean;
  unit?: PeriodUnit;
};

function Page(props: Preview) {
  const [said, setSaid] = createSignal("");
  const [yearOpen, setYearOpen] = createSignal(props.yearOpen ?? false);
  const year = () => ({ ...YEAR, ...props.year });
  return (
    <Frame>
      <PageHeader title={closeWords.title} />
      <div class="rt-close-page">
        <CloseLead through={props.through ?? null} hasWork={props.card != null} unit={props.unit} />
        <Show when={props.card}>
          {(card) => (
            <CloseCard
              label={card().label}
              state={card().state ?? "ready"}
              left={card().left ?? []}
              look={card().look}
              notes={card().notes}
              stopped={card().stopped}
              mayClose={props.mayClose}
              onClose={() => setSaid(`Closing through ${card().label} in this preview.`)}
              onRetry={() => setSaid("Checking again in this preview.")}
              unit={props.unit}
            />
          )}
        </Show>
        <div class="rt-close-folds">
          <CloseYear
            year={year()}
            years={props.years ?? [year()]}
            onYear={() => undefined}
            booksBegan="2026-01-01"
            main={props.card == null}
            mayClose={props.mayClose}
            open={yearOpen()}
            onOpenChange={setYearOpen}
            onCloseYear={() => setSaid("Year-end in this preview.")}
          />
          <ClosedMonths
            months={props.closed ?? []}
            mayReopen={props.mayClose}
            onReopen={(id) => setSaid(`Reopening ${id} in this preview.`)}
            panel={null}
            unit={props.unit}
          />
          <CloseCalendar calendar={CALENDAR} history={props.history ?? []} />
        </div>
      </div>
      <p role="status" class="rt-hint">
        {said()}
      </p>
    </Frame>
  );
}

const meta = {
  title: "Lanes/UXAccounting/Close the books",
  component: Page,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          'Close the books: how far they are closed, one card for the months that can be closed now (what is left, each line with its one button, and "Close through October 2026"), and three folds under it: the year, the closed months with Reopen, and the calendar with its history.',
      },
    },
  },
} satisfies Meta<typeof Page>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As drawn: nothing closed yet, two things left, the button waiting. */
export const ThingsLeft: Story = {
  args: { card: { label: "October 2026", left: DRAWN } },
};

/** Nothing stands in the way: the card is its name and its button. */
export const ReadyToClose: Story = {
  args: {
    through: "Sep 30, 2026",
    card: { label: "October 2026" },
    closed: closedThrough(9),
    year: { closedCount: 9, status: "partlyClosed" },
    history,
  },
};

/** A new book, and a month that has not ended: nothing to close, said once. */
export const NothingToCloseYet: Story = { args: { card: null } };

/** Every month that has ended is closed. */
export const EverythingClosed: Story = {
  args: {
    through: "Oct 31, 2026",
    card: null,
    closed: closedThrough(10),
    year: { closedCount: 10, status: "partlyClosed" },
    history,
  },
};

/** What the service says stands in the way, in the page's words: transactions, two accounts, Stripe, a backup. */
export const EveryKindOfThingLeft: Story = {
  args: {
    through: "Sep 30, 2026",
    card: { label: "October 2026", left: closeLeft(notYetChecklist, LINKS) },
    closed: closedThrough(9),
  },
};

/** Ready, with something worth a look and a note about money collecting in Other expenses. */
export const ReadyWithThingsToLookAt: Story = {
  args: {
    through: "Sep 30, 2026",
    card: { label: "October 2026", look: closeLook(readyChecklist), notes: [holds] },
    closed: closedThrough(9),
  },
};

export const Checking: Story = { args: { card: { label: "October 2026", state: "checking" } } };

export const CheckFailed: Story = { args: { card: { label: "October 2026", state: "failed" } } };

/** A close that stopped short says which month would not close, above what is left for it. */
export const StoppedShort: Story = {
  args: {
    through: "Aug 31, 2026",
    card: {
      label: "September 2026",
      left: DRAWN.slice(1),
      stopped: "September 2026 was not closed. July to August 2026 stayed closed.",
    },
    closed: closedThrough(8),
  },
};

/** A member who may not close sees how far the books are closed and what is left, and no button. */
export const MemberWhoCannotClose: Story = {
  args: {
    through: "Sep 30, 2026",
    card: { label: "October 2026", left: DRAWN },
    closed: closedThrough(9),
    mayClose: false,
  },
};

/** The year has ended and its last months are open: the fold is open, and the card is still the main button. */
export const YearEnded: Story = {
  args: {
    through: "Nov 30, 2026",
    card: { label: "December 2026" },
    closed: closedThrough(11),
    year: { closedCount: 11, status: "partlyClosed", ended: true },
    yearOpen: true,
  },
};

/** Every month is closed and the year has ended with a close to make again: Close the year is the main button. */
export const YearToCloseAgain: Story = {
  args: {
    through: "Feb 28, 2026",
    card: null,
    closed: closedThrough(12, [3, 4]),
    year: { closedCount: 10, supersededCount: 2, status: "partlyClosed", ended: true },
    yearOpen: true,
  },
};

export const YearClosed: Story = {
  args: {
    through: "Dec 31, 2026",
    card: null,
    closed: closedThrough(12),
    year: { closedCount: 12, status: "closed", ended: true },
    history,
  },
};

/** A book of several years chooses the year inside the fold. */
export const SeveralYears: Story = {
  args: {
    through: "Sep 30, 2026",
    card: { label: "October 2026" },
    closed: closedThrough(9),
    year: { closedCount: 9, status: "partlyClosed" },
    years: [
      {
        ...YEAR,
        fiscalYear: 2025,
        startsOn: "2025-01-01",
        endsOn: "2025-12-31",
        closedCount: 12,
        status: "closed",
        ended: true,
      },
      { ...YEAR, closedCount: 9, status: "partlyClosed" },
    ],
    yearOpen: true,
  },
};

/** A book whose periods are quarters never says "month". */
export const Quarters: Story = {
  args: { card: { label: "Q3 2026", left: DRAWN.slice(0, 1) }, unit: "quarter" },
};

/** Names and sentences that go on, at any width. */
export const LongText: Story = {
  args: {
    through: "Sep 30, 2026",
    card: {
      label: "October 2026",
      left: [
        {
          id: "reconcile-long",
          text: "Wells Fargo Business Platinum Rewards Checking (operating, payroll and taxes) is not reconciled through Oct 31, 2026.",
          action: {
            label: "Reconcile",
            name: "Reconcile Wells Fargo Business Platinum Rewards Checking",
            href: "/reconcile?account=long",
          },
        },
        {
          id: "section_unavailable-1",
          text: "Stripe could not be read: the connection timed out. Until it can be read, the month cannot be called ready.",
        },
      ],
    },
    closed: closedThrough(9),
  },
};

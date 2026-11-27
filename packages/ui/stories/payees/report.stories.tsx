import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { PayeesReportView, type PayeeReportData, payeesWords, ReportState } from "../../src";
import {
  allNamed,
  brokenProof,
  empty,
  inboxUnreadable,
  longText,
  manyReport,
  report,
  unnamedOnly,
} from "./fixtures";
import { Page } from "./frame";

const noop = () => undefined;

function Report(props: { data: PayeeReportData; busy?: boolean }) {
  return (
    <Page {...(props.busy ? { busy: true } : {})}>
      <PayeesReportView
        data={props.data}
        bookName="Fieldnote Studio"
        busy={props.busy ?? false}
        onOpen={noop}
        onName={noop}
        onChange={noop}
        onPage={noop}
      />
    </Page>
  );
}

const meta = {
  title: "Lanes/Payees/Money by payee",
  parameters: { layout: "fullscreen", controls: { disable: true } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** A month with five payees named, four texts nobody has named, one text two payees both match, and two
 * kinds of entry with no payee. The proof is at the foot while it holds. */
export const Default: Story = { render: () => <Report data={report} /> };

/** The first time: nobody is named, so every bank text is in Not named yet and each has a button. */
export const NobodyNamedYet: Story = { render: () => <Report data={unnamedOnly} /> };

/** Every text belongs to a payee. */
export const EverythingNamed: Story = { render: () => <Report data={allNamed} /> };

/** Dates with no income or expense in them. */
export const Empty: Story = { render: () => <Report data={empty} /> };

/** The figures being read again stay where they are, marked busy, until the new ones arrive. */
export const ReadingAgain: Story = { render: () => <Report data={report} busy /> };

/** What the bank wrote, and a name a person typed, can be any length and any characters: they are shown as
 * text, wrap where they must, and never widen the page. */
export const LongText: Story = { render: () => <Report data={longText} /> };

/** A big book: the first hundred of 137 payees and of 142 texts, with what is left out added up. */
export const ManyRows: Story = { render: () => <Report data={manyReport()} /> };

/** The bank's text could not be read: the page says so and names no payee from it. */
export const BankTextUnreadable: Story = { render: () => <Report data={inboxUnreadable} /> };

/** A report whose parts do not add up to the profit and loss. The service never gives one; if it ever did,
 * the page says so at the top and does not hide it. */
export const ProofBroken: Story = { render: () => <Report data={brokenProof} /> };

/** The report is being read for the first time. */
export const Loading: Story = {
  render: () => (
    <Page busy>
      <ReportState state="loading" what={payeesWords.loading} />
    </Page>
  ),
};

/** The read failed: what happened, and Try again. */
export const Failed: Story = {
  render: () => (
    <Page>
      <ReportState state="failed" onRetry={noop} />
    </Page>
  ),
};

/** The dates are outside the book's calendar: the page says so and shows no figure. */
export const OutsideTheCalendar: Story = {
  render: () => (
    <Page>
      <ReportState
        state="calendar"
        detail="Dec 31, 2027 is outside the book's fiscal calendar. The book's calendar covers Jan 1, 2026 to Dec 31, 2026. Extend the calendar to report on that date."
      />
    </Page>
  ),
};

/** Right to left: the tables, the figures and the buttons mirror. */
export const RightToLeft: Story = {
  render: () => (
    <Page dir="rtl">
      <PayeesReportView
        data={report}
        bookName="Fieldnote Studio"
        onOpen={noop}
        onName={noop}
        onChange={noop}
        onPage={noop}
      />
    </Page>
  ),
};

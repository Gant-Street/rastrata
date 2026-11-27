import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  Amount,
  ReportContext,
  ReportDetails,
  ReportState,
  ReportWarnings,
  TieOut,
} from "../../src";
import { HASH } from "./fixtures";
import { Frame } from "./frame";

function States() {
  return (
    <Frame>
      <ReportState state="loading" what="profit and loss" />
    </Frame>
  );
}

export default {
  title: "Lanes/Reports/States and parts",
  component: States,
  parameters: { layout: "fullscreen", controls: { disable: true } },
} satisfies Meta<typeof States>;

type Story = StoryObj<typeof States>;

/** Compiling: no figure is shown while the report is being read, so an old number is never mistaken
 * for the new one. */
export const Loading: Story = { render: () => <States /> };

export const Failed: Story = {
  render: () => (
    <Frame>
      <ReportState state="failed" onRetry={() => {}} />
    </Frame>
  ),
};

export const OutsideTheCalendar: Story = {
  render: () => (
    <Frame>
      <ReportState
        state="calendar"
        detail="2027-01-31 is outside the book's fiscal calendar. The book's calendar covers 2025-10-01 to 2026-09-30. Extend the calendar to report on that date."
      />
    </Frame>
  ),
};

/** The book moved on after this report was read; the page says so and offers to read it again. */
export const OlderThanTheBook: Story = {
  render: () => (
    <Frame>
      <ReportState state="stale" onRetry={() => {}} />
    </Frame>
  ),
};

export const ResultUncertain: Story = {
  render: () => (
    <Frame>
      <ReportState
        state="uncertain"
        detail="The reply was lost before it arrived. Nothing in your books changed; read the report again."
        onRetry={() => {}}
      />
    </Frame>
  ),
};

export const NoBook: Story = {
  render: () => (
    <Frame>
      <ReportState state="noBook" />
    </Frame>
  ),
};

export const Warnings: Story = {
  render: () => (
    <Frame>
      <ReportWarnings
        warnings={[
          {
            code: "unclassified_accounts",
            message:
              "2 accounts have activity in this range and no cash-flow tag (2300 Sales tax payable, 2400 Payroll liabilities). Their changes are shown under Not classified.",
          },
          {
            code: "comparison_unavailable",
            message:
              "The book's fiscal calendar starts on 2025-10-01, so there is no year before 2025-10-01 to compare with.",
          },
        ]}
        action={<a href="/accounts">Tag accounts</a>}
      />
    </Frame>
  ),
};

/** What a report is, in one line above its table, and the proof under "Report details" at the foot. */
export const ContextOnTheCashBasis: Story = {
  render: () => (
    <Frame>
      <ReportContext
        title="Profit and loss"
        period="Oct 1, 2025 to Mar 31, 2026"
        basis="cash"
        bookName="Harbor Studio"
        headingId="story-heading-cash"
      />
      <ReportDetails
        revision="42"
        populationHash={HASH}
        basis="cash"
        currency="USD"
        fiscalYear={{ year: 2025, startsOn: "2025-10-01", endsOn: "2026-09-30" }}
      />
    </Frame>
  ),
};

export const ContextOnTheAccrualBasisWithALongBookName: Story = {
  render: () => (
    <Frame>
      <ReportContext
        title="Balance sheet"
        period="As of Mar 31, 2026"
        basis="accrual"
        bookName="Harbor Studio Design, Illustration and Brand Strategy for Small Cultural Institutions and Independent Publishers (Amsterdam branch, second legal entity)"
        headingId="story-heading-accrual"
      />
      <ReportDetails
        defaultOpen
        revision="9007199254740993"
        populationHash={HASH}
        basis="accrual"
        currency="EUR"
        fiscalYear={{ year: 2025, startsOn: "2025-10-01", endsOn: "2026-09-30" }}
      />
    </Frame>
  ),
};

export const TieOutThatDoesNotTie: Story = {
  render: () => (
    <Frame>
      <TieOut
        title="The accounting equation"
        total={{ label: "Assets", amount: "39300.01" }}
        parts={[
          { label: "Liabilities", amount: "1210.40" },
          { label: "Equity", amount: "38089.60" },
        ]}
        difference="0.01"
      />
    </Frame>
  ),
};

export const AmountsAreSetTheSameEverywhere: Story = {
  render: () => (
    <Frame>
      <ul style={{ "list-style": "none", padding: "0", display: "grid", gap: "0.5rem" }}>
        {["0.00", "5.07", "1150.50", "-1150.50", "1000000000000000.01", "-9007199254740993.99"].map(
          (value) => (
            <li>
              <Amount value={value} />
            </li>
          ),
        )}
        <li>
          <Amount
            value="1150.50"
            href="/ledger?accountId=1000"
            context="activity for 1000 Operating cash"
          />
        </li>
      </ul>
    </Frame>
  ),
};

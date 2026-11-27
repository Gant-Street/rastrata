import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ReportContext, ReportDetails } from "../../src";
import { HASH, monthlyReports } from "../reports/fixtures";
import { Frame } from "../reports/frame";

function Foot(props: {
  open?: boolean;
  basis?: "cash" | "accrual";
  columns?: boolean;
  revision?: string;
  bookName?: string;
}) {
  const reports = monthlyReports();
  return (
    <Frame>
      <ReportContext
        title="Profit and loss"
        period="2025-10-01 to 2026-03-31"
        basis={props.basis ?? "cash"}
        bookName={props.bookName ?? "Harbor Studio"}
        headingId="story-context"
      />
      <ReportDetails
        revision={props.revision ?? "42"}
        populationHash={HASH}
        basis={props.basis ?? "cash"}
        currency="USD"
        fiscalYear={{ year: 2025, startsOn: "2025-10-01", endsOn: "2026-09-30" }}
        defaultOpen={props.open ?? false}
        columns={
          props.columns
            ? [
                ...reports.months.map((column) => ({
                  label: column.month,
                  hash: column.data.populationHash,
                })),
                { label: "Total", hash: reports.total.populationHash },
              ]
            : undefined
        }
      />
    </Frame>
  );
}

export default {
  title: "Lanes/UXReports/Report details",
  component: Foot,
  parameters: { layout: "fullscreen", controls: { disable: true } },
} satisfies Meta<typeof Foot>;

type Story = StoryObj<typeof Foot>;

/** Closed: a report's surface is for reading its figures. The book revision and the fingerprint are one
 * click away, and the line above it says what the report is. */
export const Closed: Story = { render: () => <Foot /> };

/** Open: the book revision, the fingerprint with a button that copies it, the basis, the currency and the
 * fiscal year. The fingerprint is the proof that the same figures can be made again. */
export const Open: Story = { render: () => <Foot open /> };

/** A report read in parts (by month) lists the fingerprint of each part too. */
export const OpenWithEveryColumn: Story = { render: () => <Foot open columns /> };

export const OnTheAccrualBasis: Story = { render: () => <Foot open basis="accrual" /> };

/** A very large revision number and a very long book name: the line wraps and the details stay inside
 * their column. */
export const LongContent: Story = {
  render: () => (
    <Foot
      open
      revision="9007199254740993"
      bookName="Harbor Studio Design, Illustration and Brand Strategy for Small Cultural Institutions and Independent Publishers (Amsterdam branch, second legal entity)"
    />
  ),
};

import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { TaxChecks, TaxYearBar } from "../../src";
import { allClear, checks, normalMidYear } from "./fixtures";
import { Frame } from "./frame";

const meta = {
  title: "Lanes/Tax/Checks",
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const noop = () => undefined;

export const ChecksMixed: Story = {
  name: "Checks: two change the figures, the facts are notes, the good practice is closed",
  render: () => (
    <Frame>
      <TaxChecks checks={checks} year={2026} state="ready" />
    </Frame>
  ),
};

export const ChecksMixedGoodPracticeOpen: Story = {
  name: "Checks: the good practice, open: what is not done first, and what could not be checked",
  render: () => (
    <Frame>
      <TaxChecks checks={checks} year={2026} state="ready" goodPracticeOpen />
    </Frame>
  ),
};

export const ChecksNormalMidYear: Story = {
  name: "Checks: an ordinary book in its first year shows no orange at all",
  render: () => (
    <Frame>
      <TaxChecks checks={normalMidYear} year={2026} state="ready" />
    </Frame>
  ),
};

export const ChecksAllClear: Story = {
  name: "Checks: everything that can be done has been",
  render: () => (
    <Frame>
      <TaxChecks checks={allClear} year={2026} state="ready" />
    </Frame>
  ),
};

export const ChecksSingularAndPlural: Story = {
  name: "Checks: one transaction, and its link names it",
  render: () => (
    <Frame>
      <TaxChecks
        checks={checks.map((check) =>
          check.key === "inbox" || check.key === "unmapped"
            ? {
                ...check,
                count: 1,
                detail: "1 line dated in this range is still in the Inbox and not posted.",
              }
            : check,
        )}
        year={2026}
        state="ready"
      />
    </Frame>
  ),
};

export const ChecksLoading: Story = {
  name: "Checks: loading",
  render: () => (
    <Frame>
      <TaxChecks checks={[]} year={2026} state="loading" />
    </Frame>
  ),
};

export const ChecksRefreshing: Story = {
  name: "Checks: read again, the last answer stays",
  render: () => (
    <Frame>
      <TaxChecks checks={checks} year={2026} state="loading" />
    </Frame>
  ),
};

export const ChecksError: Story = {
  name: "Checks: could not be read",
  render: () => (
    <Frame>
      <TaxChecks checks={[]} year={2026} state="error" onRetry={noop} />
    </Frame>
  ),
};

export const ChecksStale: Story = {
  name: "Checks: could not be read again, the last answer says so",
  render: () => (
    <Frame>
      <TaxChecks checks={checks} year={2026} state="error" onRetry={noop} />
    </Frame>
  ),
};

export const ChecksRtl: Story = {
  name: "Checks: right-to-left page",
  render: () => (
    <Frame dir="rtl">
      <TaxChecks checks={checks} year={2026} state="ready" goodPracticeOpen />
    </Frame>
  ),
};

export const YearBar: Story = {
  name: "Year bar: the year",
  render: () => (
    <Frame>
      <TaxYearBar years={[2025, 2026]} year={2026} onYear={noop} />
    </Frame>
  ),
};

export const ChecksOnAnotherTool: Story = {
  name: "Checks: a tool that is not built from the form leaves the form's draft status out",
  render: () => (
    <Frame>
      <TaxChecks checks={checks} year={2026} state="ready" omitNotes={["draft"]} />
    </Frame>
  ),
};

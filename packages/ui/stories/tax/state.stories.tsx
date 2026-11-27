import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { SelectField, Tabs, TaxState, TaxYearBar } from "../../src";
import { Frame } from "./frame";

const meta = {
  title: "Lanes/Tax/States",
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const noop = () => undefined;

export const NoBook: Story = {
  name: "No book yet: a plain notice with the way to set one up",
  render: () => (
    <Frame>
      <TaxState state="noBook" />
    </Frame>
  ),
};

export const CalendarDoesNotCover: Story = {
  name: "The calendar does not cover the year: the service's words and two ways forward",
  render: () => (
    <Frame>
      <TaxYearBar years={[2024, 2025, 2026]} year={2025} onYear={noop} />
      <TaxState
        state="calendar"
        detail="2025-01-01 is outside the book's fiscal calendar. The book's calendar covers 2026-01-01 to 2026-12-31. Extend the calendar to report on that date."
        onChooseYear={noop}
      />
    </Frame>
  ),
};

export const CalendarDoesNotCoverFirstRead: Story = {
  name: "The calendar covers no tax year: nothing to choose from",
  render: () => (
    <Frame>
      <TaxState
        state="calendar"
        detail="2026-01-01 is outside the book's fiscal calendar. The book's calendar covers 2027-01-01 to 2027-12-31. Extend the calendar to report on that date."
      />
    </Frame>
  ),
};

export const NoBookRtl: Story = {
  name: "No book yet: right-to-left page",
  render: () => (
    <Frame dir="rtl">
      <TaxState state="noBook" />
    </Frame>
  ),
};

const FORMS = [
  { value: "scheduleC", label: "Schedule C (sole proprietor)" },
  { value: "form1120S", label: "Form 1120-S (S corporation)" },
];

export const SelectInATab: Story = {
  name: "Tabs: a field inside a tab looks like the same field outside one",
  render: () => (
    <Frame>
      <Tabs
        label="Tax tools"
        value="worksheet"
        items={[
          {
            value: "worksheet",
            label: "Worksheet",
            content: <SelectField label="Form, in a tab" items={FORMS} value="scheduleC" />,
          },
          { value: "pack", label: "Year-end pack", content: <p>The pack.</p> },
        ]}
        onChange={noop}
      />
      <SelectField label="Form, outside a tab" items={FORMS} value="scheduleC" />
    </Frame>
  ),
};

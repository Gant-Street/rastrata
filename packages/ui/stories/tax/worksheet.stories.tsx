import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { TaxWorksheetView } from "../../src";
import { draftWorksheet, worksheet, worksheetPlain } from "./fixtures";
import { Frame } from "./frame";

const meta = {
  title: "Lanes/Tax/Worksheet",
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const activity = (account: { accountId: string; from: string; to: string }) =>
  `/ledger?accountId=${account.accountId}&from=${account.from}&to=${account.to}`;

export const WorksheetScheduleC: Story = {
  name: "Worksheet: Schedule C with a meals limit, accounts with no line and notes",
  render: () => (
    <Frame>
      <TaxWorksheetView
        worksheet={worksheet}
        activityHref={activity}
        unmappedActivityHref={activity}
        fixHref="/accounts"
      />
    </Frame>
  ),
};

export const WorksheetNotesOpen: Story = {
  name: "Worksheet: the notes and their sources, opened from the fold at the foot",
  render: () => (
    <Frame>
      <TaxWorksheetView
        worksheet={worksheet}
        activityHref={activity}
        unmappedActivityHref={activity}
        fixHref="/accounts"
        notesOpen
      />
    </Frame>
  ),
};

export const WorksheetOneColumn: Story = {
  name: "Worksheet: nothing differs between booked and the form",
  render: () => (
    <Frame>
      <TaxWorksheetView worksheet={worksheetPlain} activityHref={activity} fixHref="/accounts" />
    </Frame>
  ),
};

export const WorksheetDraftForm: Story = {
  name: "Worksheet: an IRS early-release draft form",
  render: () => (
    <Frame>
      <TaxWorksheetView worksheet={draftWorksheet} activityHref={activity} fixHref="/accounts" />
    </Frame>
  ),
};

export const WorksheetRefreshing: Story = {
  name: "Worksheet: read again, the figures stay and are marked busy",
  render: () => (
    <Frame>
      <TaxWorksheetView worksheet={worksheet} activityHref={activity} fixHref="/accounts" busy />
    </Frame>
  ),
};

export const WorksheetRtl: Story = {
  name: "Worksheet: right-to-left page",
  render: () => (
    <Frame dir="rtl">
      <TaxWorksheetView worksheet={worksheet} activityHref={activity} fixHref="/accounts" />
    </Frame>
  ),
};

import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { BankfeedAttentionList, BankfeedDaily } from "../../src";
import { attention, dailyOff, dailyOn } from "./fixtures";
import { Frame } from "./frame";

const meta = {
  title: "Lanes/Bankfeed/Daily sync and what needs you",
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const noop = () => {};

export const DailyOff: Story = {
  render: () => (
    <Frame>
      <BankfeedDaily settings={dailyOff} scheduler onSave={noop} />
    </Frame>
  ),
};
export const DailyOn: Story = {
  render: () => (
    <Frame>
      <BankfeedDaily settings={dailyOn} scheduler saved onSave={noop} />
    </Frame>
  ),
};
export const DailyNotRunningHere: Story = {
  render: () => (
    <Frame>
      <BankfeedDaily settings={dailyOn} scheduler={false} onSave={noop} />
    </Frame>
  ),
};
export const DailyFailed: Story = {
  render: () => (
    <Frame>
      <BankfeedDaily
        settings={dailyOff}
        scheduler
        failure="The daily sync time is a local time written HH:MM (24 hours), for example 06:17."
        onSave={noop}
      />
    </Frame>
  ),
};
export const NeedsYou: Story = {
  render: () => (
    <Frame>
      <BankfeedAttentionList
        items={attention}
        said={[
          "Please sign in again to Example Bank",
          "Incomplete transaction listing. Try again later",
        ]}
      />
    </Frame>
  ),
};
export const NothingNeedsYou: Story = {
  render: () => (
    <Frame>
      <BankfeedAttentionList items={[]} said={[]} />
    </Frame>
  ),
};

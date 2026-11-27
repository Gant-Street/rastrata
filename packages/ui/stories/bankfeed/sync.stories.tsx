import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { BankfeedSyncPanel } from "../../src";
import { failedRun, requests, run, scheduledRun } from "./fixtures";
import { Frame } from "./frame";

const meta = {
  title: "Lanes/Bankfeed/Sync",
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const noop = () => {};
const base = {
  state: "idle",
  blocked: null,
  lastRun: null,
  history: [],
  requests,
  inboxHref: "/inbox",
  onSync: noop,
  onResume: noop,
} as const;

export const NeverSynced: Story = {
  render: () => (
    <Frame>
      <BankfeedSyncPanel {...base} />
    </Frame>
  ),
};
export const Done: Story = {
  render: () => (
    <Frame>
      <BankfeedSyncPanel {...base} lastRun={run} history={[run, failedRun, scheduledRun]} />
    </Frame>
  ),
};
export const Running: Story = {
  render: () => (
    <Frame>
      <BankfeedSyncPanel
        {...base}
        state="running"
        progress={{ calls: 2, lines: 140 }}
        lastRun={run}
      />
    </Frame>
  ),
};
export const Failed: Story = {
  name: "The last sync failed",
  render: () => (
    <Frame>
      <BankfeedSyncPanel {...base} lastRun={failedRun} history={[failedRun, run]} />
    </Frame>
  ),
};
export const CallFailed: Story = {
  name: "The service could not be reached",
  render: () => (
    <Frame>
      <BankfeedSyncPanel
        {...base}
        state="failed"
        failure="The application could not be read."
        lastRun={run}
      />
    </Frame>
  ),
};
export const ReplyLost: Story = {
  render: () => (
    <Frame>
      <BankfeedSyncPanel {...base} state="uncertain" lastRun={run} />
    </Frame>
  ),
};
export const PausedForTheDay: Story = {
  name: "Paused: the day's budget is spent",
  render: () => (
    <Frame>
      <BankfeedSyncPanel
        {...base}
        lastRun={{ ...run, disposition: "paused", newLines: 4 }}
        pause={{
          message:
            "The day's request budget for the Bridge is spent (it expects about 24 requests a day, and Rastrata stops at 20 so the access is never disabled). The sync carries on when a request frees up.",
          until: "2026-10-05T07:00:00.000Z",
        }}
        requests={{ ...requests, used: 20 }}
      />
    </Frame>
  ),
};
export const NotPossibleYet: Story = {
  render: () => (
    <Frame>
      <BankfeedSyncPanel {...base} blocked="Link an account first: nothing is read until you do." />
    </Frame>
  ),
};

import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ImportHistoryList, ImportResult } from "../../src";
import { commitResult, history } from "./fixtures";
import { Frame } from "./frame";

const Link = (props: { children: string }) => (
  <a class="rt-button" data-variant="primary" data-size="md" href="/inbox">
    {props.children}
  </a>
);

function Result(props: Parameters<typeof ImportResult>[0]) {
  return (
    <Frame width="48rem">
      <ImportResult {...props} />
    </Frame>
  );
}

const meta = {
  title: "Lanes/Statements/Result",
  component: Result,
  args: {
    state: "done",
    result: commitResult,
    inboxLink: <Link>Open the Inbox</Link>,
    onAnother: () => {},
    onResume: () => {},
  },
} satisfies Meta<typeof Result>;
export default meta;
type Story = StoryObj<typeof meta>;

export const LinesWaitingInTheInbox: Story = {};

export const NothingNew: Story = {
  args: {
    result: {
      ...commitResult,
      waiting: 0,
      counts: { ...commitResult.counts, new: 0, duplicate: 14 },
    },
  },
};

export const WithLinesKeptOut: Story = {
  args: {
    result: {
      ...commitResult,
      counts: { ...commitResult.counts, new: 9, excluded: 5 },
      waiting: 9,
    },
  },
};

export const ResultUncertain: Story = { args: { state: "uncertain", result: undefined } };

export const Resuming: Story = { args: { state: "uncertain", result: undefined, resuming: true } };

export const History: Story = {
  render: () => (
    <Frame width="56rem">
      <ImportHistoryList rows={history} />
    </Frame>
  ),
};

export const HistoryEmpty: Story = {
  render: () => (
    <Frame width="56rem">
      <ImportHistoryList rows={[]} />
    </Frame>
  ),
};

export const HistoryFailed: Story = {
  render: () => (
    <Frame width="56rem">
      <ImportHistoryList rows={[]} state="error" />
    </Frame>
  ),
};

export const HistoryLoading: Story = {
  render: () => (
    <Frame width="56rem">
      <ImportHistoryList rows={[]} state="loading" />
    </Frame>
  ),
};

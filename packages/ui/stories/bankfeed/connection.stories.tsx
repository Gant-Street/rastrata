import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { BankfeedConnection } from "../../src";
import { Frame } from "./frame";

const meta = {
  title: "Lanes/Bankfeed/Connection",
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const noop = () => {};

export const NotConnected: Story = {
  render: () => (
    <Frame>
      <BankfeedConnection connected={false} host={null} onConnect={noop} onDisconnect={noop} />
    </Frame>
  ),
};
export const Connecting: Story = {
  render: () => (
    <Frame>
      <BankfeedConnection
        connected={false}
        host={null}
        connecting
        onConnect={noop}
        onDisconnect={noop}
      />
    </Frame>
  ),
};
export const TokenRefused: Story = {
  render: () => (
    <Frame>
      <BankfeedConnection
        connected={false}
        host={null}
        connectFailure="SimpleFIN says this setup token does not exist or has already been used. If you did not use it yourself, it may have been compromised: sign in at the SimpleFIN Bridge, disable it, and create a new one. Then try again with the new token."
        onConnect={noop}
        onDisconnect={noop}
      />
    </Frame>
  ),
};
export const ReplyLost: Story = {
  render: () => (
    <Frame>
      <BankfeedConnection
        connected={false}
        host={null}
        connectUncertain
        onConnect={noop}
        onDisconnect={noop}
      />
    </Frame>
  ),
};
export const Connected: Story = {
  render: () => (
    <Frame>
      <BankfeedConnection
        connected
        host="beta-bridge.simplefin.org"
        justConnected
        onConnect={noop}
        onDisconnect={noop}
      />
    </Frame>
  ),
};
export const SavedConnectionUnusable: Story = {
  render: () => (
    <Frame>
      <BankfeedConnection
        connected
        host={null}
        problem="/Users/example/rastrata/data/simplefin.access can be read by other users. Run: chmod 600 /Users/example/rastrata/data/simplefin.access"
        onConnect={noop}
        onDisconnect={noop}
      />
    </Frame>
  ),
};
export const Loading: Story = {
  render: () => (
    <Frame>
      <BankfeedConnection
        state="loading"
        connected={false}
        host={null}
        onConnect={noop}
        onDisconnect={noop}
      />
    </Frame>
  ),
};
export const Failed: Story = {
  render: () => (
    <Frame>
      <BankfeedConnection
        state="error"
        connected={false}
        host={null}
        onConnect={noop}
        onDisconnect={noop}
      />
    </Frame>
  ),
};

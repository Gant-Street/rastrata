import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { BankfeedAccounts } from "../../src";
import {
  chart,
  goneAccount,
  linkedChecking,
  linkedTied,
  unlinkedEuro,
  unlinkedSavings,
  unsupportedCustom,
} from "./fixtures";
import { Frame } from "./frame";

const meta = {
  title: "Lanes/Bankfeed/Accounts",
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const noop = () => {};
const base = {
  state: "ready",
  chart,
  bookCurrency: "USD",
  busy: null,
  refreshing: false,
  errors: {},
  notes: {},
  connected: true,
  onRefresh: noop,
  onLink: noop,
  onUnlink: noop,
} as const;

export const OneLinkedOneNot: Story = {
  name: "One linked, with its feed balance, and one not linked",
  render: () => (
    <Frame>
      <BankfeedAccounts {...base} accounts={[linkedChecking, unlinkedSavings]} />
    </Frame>
  ),
};
export const BalanceExplained: Story = {
  name: "The books explain the feed balance",
  render: () => (
    <Frame>
      <BankfeedAccounts {...base} accounts={[linkedTied]} />
    </Frame>
  ),
};
export const NothingLinkedYet: Story = {
  render: () => (
    <Frame>
      <BankfeedAccounts {...base} accounts={[unlinkedSavings, unlinkedEuro]} />
    </Frame>
  ),
};
export const EverythingAtOnce: Story = {
  name: "Linked, not linked, in euros, cannot be linked, gone",
  render: () => (
    <Frame>
      <BankfeedAccounts
        {...base}
        accounts={[linkedChecking, unlinkedSavings, unlinkedEuro, unsupportedCustom, goneAccount]}
      />
    </Frame>
  ),
};
export const LinkRefused: Story = {
  render: () => (
    <Frame>
      <BankfeedAccounts
        {...base}
        accounts={[unlinkedSavings]}
        errors={{
          "ACT-savings-0002":
            "1000 Business Checking is already fed by another Bridge account. Unlink that one first.",
        }}
      />
    </Frame>
  ),
};
export const LinkedWithNotes: Story = {
  render: () => (
    <Frame>
      <BankfeedAccounts
        {...base}
        accounts={[linkedChecking]}
        notes={{
          "ACT-checking-0001": [
            "Statement files already feed 1000 Business Checking (csv, lines from 2026-08-01 to 2026-09-15). Statement files and the bank feed are separate sources and Rastrata does not match one against the other, so the same transactions would be queued twice for any dates both cover. Link again with a first day of 2026-09-16 to start after the last imported line.",
          ],
        }}
      />
    </Frame>
  ),
};
export const Linking: Story = {
  render: () => (
    <Frame>
      <BankfeedAccounts {...base} accounts={[unlinkedSavings]} busy="ACT-savings-0002" />
    </Frame>
  ),
};
export const NoAccounts: Story = {
  render: () => (
    <Frame>
      <BankfeedAccounts {...base} accounts={[]} />
    </Frame>
  ),
};
export const NoChartAccounts: Story = {
  render: () => (
    <Frame>
      <BankfeedAccounts {...base} chart={[]} accounts={[unlinkedSavings]} />
    </Frame>
  ),
};
export const Loading: Story = {
  render: () => (
    <Frame>
      <BankfeedAccounts {...base} state="loading" accounts={[]} />
    </Frame>
  ),
};
export const Failed: Story = {
  render: () => (
    <Frame>
      <BankfeedAccounts {...base} state="error" accounts={[]} />
    </Frame>
  ),
};

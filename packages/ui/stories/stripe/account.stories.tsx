import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { StripeAccount, type StripeAttention } from "../../src";
import { longPayout, manyPayouts, payouts } from "./fixtures";
import { Frame } from "./frame";

const meta = {
  title: "Lanes/Stripe/Account",
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const noop = () => undefined;
function Demo(props: {
  rows: typeof payouts;
  count?: number;
  state?: "ready" | "loading" | "error";
  note?: string;
  dateline?: string | null;
  attention?: readonly StripeAttention[];
  progress?: string;
  menu?: boolean;
}) {
  const [page, setPage] = createSignal(1);
  return (
    <StripeAccount
      accountId="acct_1Qx7Lm2eZvKYlo2C"
      note={props.note}
      dateline={props.dateline === undefined ? "Updated today 6:27 PM" : props.dateline}
      attention={props.attention}
      progress={props.progress}
      actions={
        props.menu === false
          ? []
          : [
              { id: "read", label: "Read now", onSelect: noop },
              { id: "disconnect", label: "Disconnect", onSelect: noop },
            ]
      }
      rows={props.rows}
      count={props.count ?? props.rows.length}
      page={page()}
      pageSize={25}
      state={props.state ?? "ready"}
      currency="USD"
      inboxHref="/inbox"
      onPageChange={setPage}
      onRetry={noop}
    />
  );
}
export const AccountMixed: Story = {
  name: "Account: payouts matched, to match, not adding up, waiting, returned, held",
  render: () => (
    <Frame>
      <Demo rows={payouts} />
    </Frame>
  ),
};
export const AccountNeedsYou: Story = {
  name: "Account: something needs the person",
  render: () => (
    <Frame>
      <Demo
        rows={payouts}
        attention={[
          { text: "1 payout does not add up.", action: { label: "Show", onSelect: noop } },
          { text: "Stripe holds 12.00 USD more than Rastrata has read." },
        ]}
      />
    </Frame>
  ),
};
export const AccountReading: Story = {
  name: "Account: being read, nothing yet",
  render: () => (
    <Frame>
      <Demo rows={[]} dateline="Reading now" />
    </Frame>
  ),
};
export const AccountDisconnected: Story = {
  name: "Account: disconnected, practice data",
  render: () => (
    <Frame>
      <Demo rows={payouts} note="Disconnected" dateline="Last updated Nov 20, 2026" menu={false} />
    </Frame>
  ),
};
export const AccountSyncing: Story = {
  name: "Account: a sync under way",
  render: () => (
    <Frame>
      <Demo rows={payouts} dateline="Syncing…" progress="6 payouts booked so far…" menu={false} />
    </Frame>
  ),
};
export const AccountManyPages: Story = {
  name: "Account: more than a page",
  render: () => (
    <Frame>
      <Demo rows={manyPayouts} count={61} />
    </Frame>
  ),
};
export const AccountLongWords: Story = {
  name: "Account: a long reason",
  render: () => (
    <Frame>
      <Demo rows={[longPayout]} />
    </Frame>
  ),
};
export const AccountLoading: Story = {
  render: () => (
    <Frame>
      <Demo rows={[]} state="loading" />
    </Frame>
  ),
};
export const AccountError: Story = {
  render: () => (
    <Frame>
      <Demo rows={[]} state="error" />
    </Frame>
  ),
};
export const AccountArabic: Story = {
  name: "Account: right to left",
  render: () => (
    <Frame dir="rtl">
      <Demo rows={payouts} />
    </Frame>
  ),
};

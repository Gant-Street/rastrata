import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Button, TaxSalesView, type TaxSalesPeriodKind } from "../../src";
import { sales, salesNoAccount, salesNoStripe, salesQuarters } from "./fixtures";
import { Frame } from "./frame";

const meta = {
  title: "Lanes/Tax/Sales tax",
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const noop = () => undefined;
const activity = (accountId: string, from: string, to: string) =>
  `/ledger?accountId=${accountId}&from=${from}&to=${to}`;

function Demo(props: { data: typeof sales; busy?: boolean }) {
  const [period, setPeriod] = createSignal<TaxSalesPeriodKind>(props.data.period);
  return (
    <Frame>
      <TaxSalesView
        data={props.data}
        period={period()}
        busy={props.busy ?? false}
        onPeriod={setPeriod}
        activityHref={activity}
        accountsHref="/accounts"
        exportControls={
          <>
            <Button variant="secondary" label="Download the summary (CSV)" onClick={noop} />
            <Button variant="secondary" label="Download every posting (CSV)" onClick={noop} />
          </>
        }
      />
    </Frame>
  );
}

export const SalesMonths: Story = {
  name: "Sales tax: months, with Stripe's figures and a difference",
  render: () => <Demo data={sales} />,
};

export const SalesQuarters: Story = {
  name: "Sales tax: quarters",
  render: () => <Demo data={salesQuarters} />,
};

export const SalesWithoutStripe: Story = {
  name: "Sales tax: no Stripe payouts in the range",
  render: () => <Demo data={salesNoStripe} />,
};

export const SalesNoAccount: Story = {
  name: "Sales tax: no account is tagged, with the accounts that could be",
  render: () => <Demo data={salesNoAccount} />,
};

export const SalesRefreshing: Story = {
  name: "Sales tax: read again, the figures stay and are marked busy",
  render: () => <Demo data={sales} busy />,
};

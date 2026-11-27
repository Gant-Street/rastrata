import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { BalanceSheetView, TrialBalanceView } from "../../src";
import { accounts, coreReports, hrefs, manyAccounts } from "./fixtures";
import { Frame } from "./frame";

function Sheet(props: { compare?: boolean; broken?: boolean; showZero?: boolean }) {
  const data = () => {
    const report = coreReports({ compare: props.compare ?? false });
    // A balance sheet that does not balance can only come from a fault; the page must say so.
    return props.broken
      ? { ...report, balanceSheet: { ...report.balanceSheet, assets: "39300.01" } }
      : report;
  };
  return (
    <Frame>
      <BalanceSheetView
        data={data()}
        hrefs={hrefs}
        bookName="Harbor Studio"
        showZero={props.showZero ?? false}
      />
    </Frame>
  );
}

function Trial(props: { many?: boolean; compare?: boolean }) {
  return (
    <Frame>
      <TrialBalanceView
        data={coreReports({
          compare: props.compare ?? false,
          ...(props.many ? { accounts: [...accounts, ...manyAccounts(250)] } : {}),
        })}
        hrefs={hrefs}
        bookName="Harbor Studio"
        showZero
      />
    </Frame>
  );
}

export default {
  title: "Lanes/Reports/Balance sheet",
  component: Sheet,
  parameters: { layout: "fullscreen", controls: { disable: true } },
} satisfies Meta<typeof Sheet>;

type Story = StoryObj<typeof Sheet>;

/** As of one date, with the earnings of earlier fiscal years carried forward by computation, and the
 * accounting equation shown rather than assumed. */
export const Default: Story = { render: () => <Sheet /> };

/** The same date against six months earlier, each column with its own links. */
export const WithComparison: Story = { render: () => <Sheet compare /> };

/** Every account, including those with no balance. */
export const WithEmptyAccounts: Story = { render: () => <Sheet showZero /> };

/** If the figures ever disagree the page says so plainly and tells the reader not to rely on it. */
export const DoesNotBalance: Story = { render: () => <Sheet broken /> };

export const TrialBalance: StoryObj<typeof Trial> = {
  render: () => <Trial />,
};

export const TrialBalanceManyAccounts: StoryObj<typeof Trial> = {
  render: () => <Trial many />,
};

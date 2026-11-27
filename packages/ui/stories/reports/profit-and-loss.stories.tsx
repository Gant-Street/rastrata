import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal } from "solid-js";
import { ProfitLossView, ReportBusy } from "../../src";
import { Frame } from "./frame";
import { type Account, accounts, coreReports, hostileNames, hrefs, manyAccounts } from "./fixtures";

function Statement(props: {
  compare?: boolean;
  showZero?: boolean;
  list?: readonly Account[];
  locale?: string;
  /** The profit and loss as the service sends it when asked for shares of income. */
  share?: boolean;
  /** The totals are the sums of the list that was given, not the studio's own. */
  totalsFromAccounts?: boolean;
}) {
  const [showZero, setShowZero] = createSignal(props.showZero ?? false);
  const data = () =>
    coreReports({
      compare: props.compare ?? false,
      share: props.share ?? false,
      ...(props.totalsFromAccounts ? { totalsFromAccounts: true } : {}),
      ...(props.list ? { accounts: props.list } : {}),
    });
  return (
    <Frame locale={props.locale ?? "en-US"}>
      <label style={{ display: "inline-flex", gap: "0.5rem", "margin-bottom": "1rem" }}>
        <input
          type="checkbox"
          checked={showZero()}
          onChange={(event) => setShowZero(event.currentTarget.checked)}
        />
        Show accounts with no activity
      </label>
      <ProfitLossView data={data()} hrefs={hrefs} bookName="Harbor Studio" showZero={showZero()} />
    </Frame>
  );
}

export default {
  title: "Lanes/Reports/Profit and loss",
  component: Statement,
  parameters: { layout: "fullscreen", controls: { disable: true } },
} satisfies Meta<typeof Statement>;

type Story = StoryObj<typeof Statement>;

/** A cash-basis studio with an October fiscal year: income, a gain and expenses, each with its total. */
export const Default: Story = { render: () => <Statement /> };

/** The same range against the six months before, with the change and links for both periods. */
export const WithComparison: Story = { render: () => <Statement compare /> };

/** An account with no activity is hidden and counted; this shows it. */
export const WithEmptyAccounts: Story = { render: () => <Statement showZero /> };

/** The dates changed and the figures are being read again. They stay exactly where they are, so the
 * controls around them and the focus a person has do not move; after a fifth of a second the accent
 * colour sweeps along the heavy top rule, and no text is dimmed. */
export const BeingReadAgain: Story = {
  render: () => (
    <Frame>
      <ReportBusy busy>
        <ProfitLossView
          data={coreReports({ compare: false })}
          hrefs={hrefs}
          bookName="Harbor Studio"
          showZero={false}
        />
      </ReportBusy>
    </Frame>
  ),
};

/** Nothing was posted in these dates: every group says so. */
export const NoActivity: Story = {
  render: () => (
    <Statement list={accounts.map((account) => ({ ...account, now: 0n, earlier: 0n }))} />
  ),
};

/** Three hundred accounts: the table scrolls inside its own region and the figures stay aligned. */
export const ManyAccounts: Story = {
  render: () => <Statement compare showZero list={[...accounts, ...manyAccounts(300)]} />,
};

/** Account names are data from anywhere: markup stays text, spreadsheet formulas stay text, a very long
 * name wraps inside its cell, and Arabic keeps its direction. */
export const HostileAndLongNames: Story = {
  render: () => <Statement compare showZero list={[...accounts, ...hostileNames]} />,
};

/** Right-to-left: the layout mirrors, the figures stay tabular and aligned. */
export const RightToLeft: Story = { render: () => <Statement compare locale="ar" /> };

// ---- % of income ------------------------------------------------------------------------------
// The report is read with `share: "income"`: every amount has its share of total income beside it, to one
// decimal, and the screen sets what the service sent. Nothing here is worked out on the page.

/** Every amount followed by its share of total income. Total income is 100.0%. */
export const PercentOfIncome: Story = { render: () => <Statement share /> };

/** Each period's share is of its own period's income: the amounts and the change are what they were. */
export const PercentOfIncomeWithComparison: Story = {
  render: () => <Statement share compare />,
};

const expensesTripled = accounts.map((account) =>
  account.role === "expense"
    ? { ...account, now: account.now * 3n, earlier: account.earlier * 3n }
    : account,
);

/** More expenses than income: net income is a negative share, with a real minus sign. */
export const ALossAsAShareOfIncome: Story = {
  render: () => <Statement share compare list={expensesTripled} totalsFromAccounts />,
};

const noIncome = accounts.map((account) =>
  account.role === "income" || account.role === "gain"
    ? { ...account, now: 0n, earlier: 0n }
    : account,
);

/** No income in the dates: there is nothing to take a share of. The column stays, every cell is a dash that
 * a screen reader calls "No share of income", and the page says why. */
export const NoIncomeToCompareWith: Story = {
  render: () => <Statement share list={noIncome} totalsFromAccounts />,
};

const nothingPosted = accounts.map((account) => ({ ...account, now: 0n, earlier: 0n }));

/** Nothing was posted in these dates, with % of income on: every group says so, the notice says there is no
 * income to compare with, and every figure is a dash. */
export const PercentOfIncomeWithNothingPosted: Story = {
  render: () => <Statement share list={nothingPosted} totalsFromAccounts showZero />,
};

const noIncomeBefore = accounts.map((account) =>
  account.role === "income" || account.role === "gain" ? { ...account, earlier: 0n } : account,
);

/** Income this period and none in the comparison period: the period has its shares, the comparison has
 * dashes, and the page says which. */
export const NoIncomeInTheComparison: Story = {
  render: () => <Statement share compare list={noIncomeBefore} totalsFromAccounts />,
};

/** Three hundred accounts with shares: the table scrolls inside its own region. */
export const PercentOfIncomeWithManyAccounts: Story = {
  render: () => <Statement share compare showZero list={[...accounts, ...manyAccounts(300)]} />,
};

/** Names from anywhere keep to their own cells beside the shares. */
export const PercentOfIncomeWithHostileAndLongNames: Story = {
  render: () => <Statement share compare showZero list={[...accounts, ...hostileNames]} />,
};

/** Right-to-left: the shares keep their digits in order and their minus sign beside them. */
export const PercentOfIncomeRightToLeft: Story = {
  render: () => <Statement share compare locale="ar" list={expensesTripled} totalsFromAccounts />,
};

/** German separators: the decimal comma, the thousands point. */
export const PercentOfIncomeGerman: Story = {
  render: () => <Statement share locale="de-DE" list={expensesTripled} totalsFromAccounts />,
};

/** German separators, to show that grouping follows the locale and never rounds. */
export const GermanSeparators: Story = { render: () => <Statement locale="de-DE" /> };

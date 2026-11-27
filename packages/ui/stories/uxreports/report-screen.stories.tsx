import { createSignal, type JSX, Match, Switch } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  BalanceSheetMonthlyView,
  BalanceSheetView,
  canBeByMonth,
  canBeCompared,
  canShare,
  canShowEmpty,
  CashFlowView,
  type CompareChoice,
  type DateRangeValue,
  defaultRange,
  ExportMenu,
  GeneralLedgerView,
  Notice,
  ProfitLossMonthlyView,
  ProfitLossView,
  type ReportColumns,
  ReportControls,
  ReportState,
  ReportTabs,
  type ReportTab,
  TrialBalanceView,
} from "../../src";
import {
  accounts,
  calendarYears,
  cashFlow,
  coreReports,
  generalLedger,
  hostileNames,
  hrefs,
  manyAccounts,
  monthlyReports,
} from "../reports/fixtures";
import { Frame } from "../reports/frame";

const TODAY = "2026-03-31";

const TABS = [
  { value: "profit-loss", label: "Profit and loss" },
  { value: "balance-sheet", label: "Balance sheet" },
  { value: "cash-flow", label: "Cash flow" },
  { value: "trial-balance", label: "Trial balance" },
  { value: "general-ledger", label: "General ledger" },
];

type Block = "loading" | "failed" | "ready";

/** The whole Reports screen on fixture data, with the real components and the real state: the tabs, the
 * one row of choices, the statement and its details. What a statement shows follows what is chosen, the
 * way the application's page does, without a service. */
function Screen(props: {
  tab?: ReportTab;
  by?: ReportColumns;
  compare?: CompareChoice;
  range?: DateRangeValue;
  showZero?: boolean;
  block?: Block;
  tooManyMonths?: boolean;
  months?: number;
  list?: typeof accounts;
  broken?: boolean;
  menuOpen?: boolean;
  locale?: string;
  share?: boolean;
}) {
  const calendar = { years: calendarYears, today: TODAY };
  const [tab, setTab] = createSignal<ReportTab>(props.tab ?? "profit-loss");
  const [by, setBy] = createSignal<ReportColumns>(props.by ?? "total");
  const [compare, setCompare] = createSignal<CompareChoice>(props.compare ?? "none");
  const [range, setRange] = createSignal<DateRangeValue>(
    props.range ??
      defaultRange(calendar) ?? { preset: "fiscalYearToDate", from: "2025-10-01", to: TODAY },
  );
  const [showZero, setShowZero] = createSignal(props.showZero ?? false);
  const [share, setShare] = createSignal(props.share ?? false);
  const byMonth = () => canBeByMonth(tab()) && by() === "month";
  const list = () => props.list ?? accounts;
  const core = () =>
    coreReports({ compare: compare() !== "none", accounts: list(), share: share() });
  const monthly = () => {
    const base = monthlyReports({ accounts: list(), months: props.months ?? 6 });
    if (!props.broken) return base;
    // A total that is a cent out: the months do not add up to it.
    return {
      ...base,
      total: {
        ...base.total,
        profitAndLoss: {
          ...base.total.profitAndLoss,
          totals: base.total.profitAndLoss.totals.map((total) =>
            total.key === "netIncome" ? { ...total, amount: "13039.61" } : total,
          ),
        },
      },
    };
  };
  const body = (): JSX.Element => (
    <Switch>
      <Match when={props.block === "loading"}>
        <ReportState state="loading" what="the profit and loss" />
      </Match>
      <Match when={props.block === "failed"}>
        <ReportState state="failed" onRetry={() => {}} />
      </Match>
      <Match when={props.tooManyMonths && byMonth()}>
        <Notice title="That is too many months to lay out" tone="info" role="status">
          <p>
            A report by month shows up to 24 months at a time. Choose a shorter range, or show the
            total.
          </p>
        </Notice>
      </Match>
      <Match when={tab() === "profit-loss" && byMonth()}>
        <ProfitLossMonthlyView
          reports={monthly()}
          hrefsFor={() => hrefs}
          bookName="Harbor Studio"
          showZero={showZero()}
        />
      </Match>
      <Match when={tab() === "balance-sheet" && byMonth()}>
        <BalanceSheetMonthlyView
          reports={monthly()}
          hrefsFor={() => hrefs}
          bookName="Harbor Studio"
          showZero={showZero()}
        />
      </Match>
      <Match when={tab() === "profit-loss"}>
        <ProfitLossView
          data={core()}
          hrefs={hrefs}
          bookName="Harbor Studio"
          showZero={showZero()}
        />
      </Match>
      <Match when={tab() === "balance-sheet"}>
        <BalanceSheetView
          data={core()}
          hrefs={hrefs}
          bookName="Harbor Studio"
          showZero={showZero()}
        />
      </Match>
      <Match when={tab() === "cash-flow"}>
        <CashFlowView
          data={cashFlow({ compare: compare() !== "none" })}
          hrefs={hrefs}
          bookName="Harbor Studio"
        />
      </Match>
      <Match when={tab() === "trial-balance"}>
        <TrialBalanceView
          data={core()}
          hrefs={hrefs}
          bookName="Harbor Studio"
          showZero={showZero()}
        />
      </Match>
      <Match when={tab() === "general-ledger"}>
        <GeneralLedgerView
          data={generalLedger({ lines: 25 })}
          hrefs={hrefs}
          bookName="Harbor Studio"
          onPage={() => {}}
        />
      </Match>
    </Switch>
  );
  return (
    <Frame locale={props.locale ?? "en-US"}>
      <ReportTabs
        label="Statements"
        value={tab()}
        items={TABS}
        onChange={(value) => setTab(value as ReportTab)}
        controls={
          <ReportControls
            calendar={calendar}
            range={range()}
            onRange={setRange}
            compare={compare()}
            onCompare={setCompare}
            canCompare={canBeCompared(tab())}
            by={by()}
            onBy={(next) => {
              setBy(next);
              if (next === "month") {
                setCompare("none");
                setShare(false);
              }
            }}
            canBeByMonth={canBeByMonth(tab())}
            share={share()}
            onShare={(on) => {
              setShare(on);
              if (on) setBy("total");
            }}
            canShare={canShare(tab())}
            canShowEmpty={canShowEmpty(tab())}
            showEmpty={showZero()}
            onShowEmpty={setShowZero}
          >
            <ExportMenu
              label="Export"
              defaultOpen={props.menuOpen ?? false}
              actions={[
                { id: "csv", label: "Download CSV", onSelect: () => {} },
                { id: "print", label: "Print or save as PDF", onSelect: () => {} },
              ]}
            />
          </ReportControls>
        }
        panel={() => body()}
      />
    </Frame>
  );
}

export default {
  title: "Lanes/UXReports/Reports screen",
  component: Screen,
  parameters: { layout: "fullscreen", controls: { disable: true } },
} satisfies Meta<typeof Screen>;

type Story = StoryObj<typeof Screen>;

/** The profit and loss for the fiscal year to date: the tabs, one row of choices, and the table at once.
 * The book revision and the fingerprint are under "Report details" at the foot. */
export const Default: Story = { render: () => <Screen /> };

/** The same statement with a column for each month and one for the whole range. The account names stay
 * in view while the figures scroll sideways. Comparing is off while months are in columns. */
export const ByMonth: Story = { render: () => <Screen by="month" /> };

/** The balance sheet by month: the position at the end of each month. */
export const BalanceSheetByMonth: Story = {
  render: () => <Screen tab="balance-sheet" by="month" />,
};

/** Twelve months and all the accounts of a long chart, with hostile and very long names. */
export const ByMonthWithLongContent: Story = {
  render: () => (
    <Screen
      by="month"
      showZero
      months={12}
      list={[...accounts, ...hostileNames, ...manyAccounts(40)]}
    />
  ),
};

export const WithAComparison: Story = { render: () => <Screen compare="previousPeriod" /> };

/** The profit and loss with % of income on: each amount followed by its share of total income. */
export const WithPercentOfIncome: Story = { render: () => <Screen share /> };

/** A comparison with % of income: each period's share is of its own period's income. */
export const WithAComparisonAndPercentOfIncome: Story = {
  render: () => <Screen share compare="previousPeriod" />,
};

/** % of income is on and the figures are being compiled: no share is shown that is not the answer. */
export const PercentOfIncomeLoading: Story = { render: () => <Screen share block="loading" /> };

/** % of income is on and the report could not be compiled: the failure is said, and the choice stays. */
export const PercentOfIncomeFailed: Story = { render: () => <Screen share block="failed" /> };

/** The same on a phone: the table scrolls inside its own region and the names stay readable. */
export const PercentOfIncomeOnAPhone: Story = {
  render: () => (
    <div style={{ "max-width": "390px" }}>
      <Screen share compare="previousPeriod" />
    </div>
  ),
};

export const BalanceSheet: Story = { render: () => <Screen tab="balance-sheet" /> };

/** The statements that have no months or no comparison do not show those choices. */
export const TrialBalance: Story = { render: () => <Screen tab="trial-balance" /> };

export const CashFlow: Story = { render: () => <Screen tab="cash-flow" /> };

export const GeneralLedger: Story = { render: () => <Screen tab="general-ledger" /> };

/** The accounts with no activity are said to be hidden, with the way to show them. */
export const AccountsWithNoActivityShown: Story = { render: () => <Screen showZero /> };

/** Nothing was posted in these dates. */
export const NoActivity: Story = {
  render: () => <Screen list={accounts.map((account) => ({ ...account, now: 0n, earlier: 0n }))} />,
};

/** The figures are being compiled: no number is shown that is not the answer. */
export const Loading: Story = { render: () => <Screen block="loading" /> };

export const Failed: Story = { render: () => <Screen block="failed" /> };

/** A range of more than two years cannot be laid out by month; the page says so and asks for nothing. */
export const TooManyMonths: Story = {
  render: () => <Screen by="month" tooManyMonths />,
};

/** The months do not add up to the total: the page says so and tells the reader not to rely on it. */
export const MonthsThatDoNotAddUp: Story = { render: () => <Screen by="month" broken /> };

/** Dates that cannot be reported on are named, and nothing is requested for them. */
export const CustomDatesWithAProblem: Story = {
  render: () => <Screen range={{ preset: "custom", from: "2026-04-01", to: "2026-03-01" }} />,
};

/** The Export button's list, open. */
export const ExportMenuOpen: Story = { render: () => <Screen menuOpen /> };

/** The same screen in a column as narrow as a phone's. */
export const Phone: Story = {
  render: () => (
    <div style={{ "max-width": "390px" }}>
      <Screen />
    </div>
  ),
};

/** By month on a phone: the table scrolls inside its own region and the names stay in view. */
export const ByMonthOnAPhone: Story = {
  render: () => (
    <div style={{ "max-width": "390px" }}>
      <Screen by="month" />
    </div>
  ),
};

/** Right-to-left: the layout mirrors, the figures stay tabular and aligned. */
export const RightToLeft: Story = { render: () => <Screen locale="ar" by="month" /> };

import type { JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { type MoneyMonthView, MoneyInOut, UiProvider } from "../../src";
import { allZero, beforeBooks, bigNumbers, oneNotRead, sixMonths } from "./fixtures";

function Frame(props: { children: JSX.Element; width?: string | undefined }) {
  return (
    <UiProvider locale="en-US">
      <div class="rt-theme" style={{ "max-width": props.width ?? "34rem", padding: "1rem" }}>
        <div class="rt-today">{props.children}</div>
      </div>
    </UiProvider>
  );
}

function Money(props: {
  months: readonly MoneyMonthView[];
  state?: "loading" | "ready" | "error";
  cash?: boolean;
  any?: boolean;
  profit?: string | null;
  width?: string;
}) {
  return (
    <Frame width={props.width}>
      <MoneyInOut
        months={props.months}
        state={props.state ?? "ready"}
        cash={props.cash ?? true}
        currency="USD"
        any={props.any ?? true}
        profit={props.profit === undefined ? "3278.41" : props.profit}
        onRetry={() => undefined}
      />
    </Frame>
  );
}

const meta = {
  title: "Lanes/UXHome/Money in and out",
  component: Money,
  parameters: {
    layout: "fullscreen",
    a11y: { test: "error" },
    docs: {
      description: {
        component:
          "Six months of money in (solid bars) and money out (hatched bars), drawn thin on a hairline grid, with one line under it: the profit of the year so far, or the figures of the month a person points at or taps. The same figures are a table for a screen reader, which is the text alternative for the drawing.",
      },
    },
  },
} satisfies Meta<typeof Money>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SixMonths: Story = { args: { months: sixMonths } };

/** An accrual book says income and expenses, because those are not money. */
export const AccrualBook: Story = { args: { months: sixMonths, cash: false } };

/** Months before the books began are not drawn as zero: the table says why there is no figure. */
export const BooksBeganRecently: Story = { args: { months: beforeBooks } };

/** A month whose read failed says so in the table instead of showing a figure, and the rest are drawn. */
export const OneMonthCouldNotBeRead: Story = { args: { months: oneNotRead } };

/** Nothing recorded in six months is one sentence, not an empty plot. (Home leaves the section out.) */
export const NothingRecorded: Story = { args: { months: allZero, any: false, profit: "0.00" } };

export const Reading: Story = { args: { months: [], state: "loading" } };

export const Failed: Story = { args: { months: [], state: "error" } };

/** A loss is a negative profit with its sign. */
export const ALossSoFar: Story = { args: { months: sixMonths, profit: "-1204.55" } };

/** Seven-figure months keep the scale readable, and the line under the chart on one line. */
export const BigNumbers: Story = { args: { months: bigNumbers, profit: "16000000.00" } };

/** A phone: the six pairs of bars still fit, with room for the scale. */
export const AtPhoneWidth: Story = { args: { months: sixMonths, width: "22rem" } };

import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal } from "solid-js";
import { AccountActivityView } from "../../src";
import { accountActivity } from "./fixtures";
import { Frame } from "./frame";

function Activity(props: {
  kind?: "cumulative" | "fiscalYearToDate";
  lines?: number;
  count?: number;
  empty?: boolean;
}) {
  const [page, setPage] = createSignal(1);
  const data = () => {
    const base = accountActivity({
      ...(props.kind ? { kind: props.kind } : {}),
      ...(props.lines !== undefined ? { lines: props.lines } : {}),
      ...(props.count !== undefined ? { count: props.count } : {}),
    });
    return props.empty ? { ...base, rows: [], count: 0 } : { ...base, page: page() };
  };
  return (
    <Frame>
      <AccountActivityView
        data={data()}
        entryHref={(id) => `/journal/${id}`}
        onPage={setPage}
        backHref="/reports"
        bookName="Harbor Studio"
      />
    </Frame>
  );
}

export default {
  title: "Lanes/Reports/Account activity",
  component: Activity,
  parameters: { layout: "fullscreen", controls: { disable: true } },
} satisfies Meta<typeof Activity>;

type Story = StoryObj<typeof Activity>;

/** An asset account: its balance is carried from the start of the book. */
export const Asset: Story = { render: () => <Activity /> };

/** An income account: the balance starts each fiscal year at zero. */
export const IncomeAccount: Story = { render: () => <Activity kind="fiscalYearToDate" /> };

/** A full page with the pager. */
export const ManyPostings: Story = { render: () => <Activity lines={25} count={310} /> };

export const NoPostings: Story = { render: () => <Activity empty /> };

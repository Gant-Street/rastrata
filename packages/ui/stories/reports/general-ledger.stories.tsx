import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal } from "solid-js";
import { GeneralLedgerView } from "../../src";
import { generalLedger, hrefs } from "./fixtures";
import { Frame } from "./frame";

function Ledger(props: { lines?: number; empty?: boolean }) {
  const [page, setPage] = createSignal(1);
  const data = () => {
    const ledger = generalLedger({
      ...(props.lines !== undefined ? { lines: props.lines } : {}),
      page: page(),
    });
    return props.empty ? { ...ledger, accounts: [], lines: [], count: 0 } : ledger;
  };
  return (
    <Frame>
      <GeneralLedgerView data={data()} hrefs={hrefs} bookName="Harbor Studio" onPage={setPage} />
    </Frame>
  );
}

export default {
  title: "Lanes/Reports/General ledger",
  component: Ledger,
  parameters: { layout: "fullscreen", controls: { disable: true } },
} satisfies Meta<typeof Ledger>;

type Story = StoryObj<typeof Ledger>;

/** Every account's postings with a running balance. A balance-sheet account carries its balance from
 * the start of the book; an income or expense account starts each fiscal year at zero. */
export const Default: Story = { render: () => <Ledger /> };

/** A full page of one hundred lines, with the pager. */
export const ManyLines: Story = { render: () => <Ledger lines={100} /> };

export const NoPostings: Story = { render: () => <Ledger empty /> };

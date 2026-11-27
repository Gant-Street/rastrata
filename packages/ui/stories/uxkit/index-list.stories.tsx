import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { IndexList } from "../../src";
import { Frame, darkUnlessAsked } from "./frame";

const meta = {
  title: "Lanes/UXKit/IndexList",
  component: IndexList,
  args: { label: "Ways to bring in your books", entries: [] },
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof IndexList>;
export default meta;
type Story = StoryObj<typeof meta>;

const entries = [
  {
    label: "Start date and opening balances",
    note: "The day your books begin here, and what each account held on it.",
    href: "#/opening",
  },
  {
    label: "Bring in history",
    note: "Your past years from another system, as entries dated as they were.",
    href: "#/settings/history",
  },
  {
    label: "Move from Xero",
    note: "Your chart of accounts, balances and transactions, from the files Xero exports.",
    href: "#/settings/move",
  },
];

/** Pages to open, one link a row: the name, a line saying what it is for, and a chevron. */
export const Default: Story = {
  render: () => (
    <Frame label="Settings, Bring in your books.">
      <IndexList label="Ways to bring in your books" entries={entries} />
    </Frame>
  ),
};

/** Where the names say enough, the rows are names alone. */
export const NamesOnly: Story = {
  render: () => (
    <Frame>
      <IndexList
        label="Statements"
        entries={[
          { label: "Profit and loss", href: "#/reports" },
          { label: "Balance sheet", href: "#/reports" },
          { label: "Cash flow", href: "#/reports" },
        ]}
      />
    </Frame>
  ),
};

export const Dark: Story = {
  decorators: [darkUnlessAsked],
  render: () => (
    <Frame>
      <IndexList label="Ways to bring in your books" entries={entries} />
    </Frame>
  ),
};

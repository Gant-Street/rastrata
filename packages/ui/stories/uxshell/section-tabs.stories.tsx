import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { SectionTabs } from "../../src";

const meta = {
  title: "Lanes/UXShell/SectionTabs",
  component: SectionTabs,
  parameters: { a11y: { test: "error" } },
  decorators: [
    (Story) => (
      <div class="rt-theme" style={{ "max-width": "60rem", padding: "1rem" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SectionTabs>;
export default meta;
type Story = StoryObj<typeof meta>;

const transactions = [
  { path: "/inbox", label: "For review", current: "page" as const },
  { path: "/journal", label: "All transactions" },
  { path: "/rules", label: "Rules", count: 8 },
];

/** The pages of a section, the one you are on underlined, with a live count where a page offers one. */
export const Default: Story = { args: { label: "Transactions pages", tabs: transactions } };
/** A page under a tab keeps that tab marked (`true`, not `page`). */
export const DetailPageUnderRules: Story = {
  args: {
    label: "Transactions pages",
    tabs: [
      { path: "/inbox", label: "For review" },
      { path: "/journal", label: "All transactions" },
      { path: "/rules", label: "Rules", count: 8, current: "true" as const },
    ],
  },
};
/** A count of zero is not shown: nothing waiting is not a number. */
export const NothingWaiting: Story = {
  args: { label: "Transactions pages", tabs: transactions.map((tab) => ({ ...tab, count: 0 })) },
};
export const BigCount: Story = {
  args: {
    label: "Transactions pages",
    tabs: transactions.map((tab) => ({ ...tab, count: 12345 })),
  },
};
/** In a narrow window the row scrolls sideways instead of wrapping. */
export const Narrow: Story = {
  args: {
    label: "Reports pages",
    tabs: [
      { path: "/reports", label: "Reports", current: "page" as const },
      { path: "/reports/payees", label: "By payee" },
      { path: "/tax", label: "Taxes" },
      { path: "/ledger", label: "Account register for the whole fiscal year" },
    ],
  },
  decorators: [
    (Story) => (
      <div style={{ "max-width": "22rem" }}>
        <Story />
      </div>
    ),
  ],
};
/** On a phone the row opens scrolled to the page you are on, so the tab that is marked is in sight: here the last of seven. */
export const SettingsListLastCurrent: Story = {
  args: {
    label: "Settings",
    orientation: "vertical",
    tabs: [
      { path: "/settings", label: "Business" },
      { path: "/settings/members", label: "Members" },
      { path: "/settings/agent", label: "Agents" },
      { path: "/settings/billing", label: "Billing" },
      { path: "/settings/bring-in", label: "Bring in your books" },
      { path: "/periods", label: "Close the books" },
      { path: "/changes", label: "Changes", current: "page" as const },
    ],
  },
  decorators: [
    (Story) => (
      <div style={{ width: "15rem" }}>
        <Story />
      </div>
    ),
  ],
};
/** The Settings list: the same entries in a column beside the page (a row on a phone). */
export const SettingsList: Story = {
  args: {
    label: "Settings",
    orientation: "vertical",
    tabs: [
      { path: "/settings", label: "Business", current: "page" as const },
      { path: "/settings/agent", label: "Agents" },
      { path: "/settings/connections", label: "Connections" },
      { path: "/settings/backups", label: "Backups and export" },
      { path: "/settings/bring-in", label: "Bring in your books" },
      { path: "/periods", label: "Close the books" },
      { path: "/changes", label: "Changes" },
    ],
  },
  decorators: [
    (Story) => (
      <div style={{ width: "15rem" }}>
        <Story />
      </div>
    ),
  ],
};

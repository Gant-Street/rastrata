import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Frame } from "./frame";

/** The header the application puts the navigation in: the wordmark and the book's name, the four places,
 * Search, "+ New" and Settings; under it, where a section has several pages, they are a row of tabs.
 * Choosing a link moves the current page. */
const meta = {
  title: "Lanes/UXShell/AppNav",
  component: Frame,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof Frame>;
export default meta;
type Story = StoryObj<typeof meta>;

/** On the page Transactions opens: Transactions is underlined in the bar, with the number waiting for
 * review beside its name, and For review in the row. */
export const Transactions: Story = {
  args: { current: "/inbox", name: "Willow Lane Studio", reviewCount: 8 },
};
/** Home has no row of tabs, and neither does Reports here: one page each. */
export const Home: Story = { args: { current: "/", name: "Willow Lane Studio" } };
/** A page under a tab keeps that tab underlined: a new rule is under Rules. */
export const DetailPage: Story = {
  args: { current: "/rules/new", name: "Willow Lane Studio", reviewCount: 8 },
};
export const Accounts: Story = { args: { current: "/accounts", name: "Willow Lane Studio" } };
export const SettingsPage: Story = { args: { current: "/settings", name: "Willow Lane Studio" } };
/** "+ New" is a disclosure of one short list: links, and buttons for the actions that open a dialog. */
export const NewOpen: Story = {
  args: { current: "/journal", name: "Willow Lane Studio", defaultOpen: "new" },
};
/** With no actions at all there is no button. */
export const NoActions: Story = { args: { current: "/", name: "Willow Lane Studio", actions: [] } };
/** On a phone (56rem or narrower) the bar is one Menu button holding Search, every place and "+ New"
 * (resize the window to see it; it is open here so the list can be read). */
export const PhoneMenuOpen: Story = {
  args: { current: "/reconcile", name: "Willow Lane Studio", defaultOpen: "menu", reviewCount: 8 },
};
/** A name too long for the header is cut with an ellipsis and keeps its full text in a tooltip. */
export const LongBookName: Story = {
  args: {
    current: "/journal",
    name: "The Extraordinarily Long-Named Consulting and Design Studio of Willow Lane, LLC",
    reviewCount: 128,
  },
};
/** Before a book exists the header is only the wordmark. */
export const BeforeABook: Story = { args: { current: "/", withoutNav: true } };

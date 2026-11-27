// Which topic of Help belongs to which page. The footer's Help link opens the topic for the page a person
// is on, or the list of topics when the page has none. Every route of the application is named here, so a
// new page cannot be added without deciding (tests/registry holds that); a page with no how-to of its own
// says `null`, on purpose.
import { matchRoute } from "../../nav.ts";
import { type HelpAudience, topicFor } from "./topics.ts";

interface HelpPage {
  /** The route's path, as the registry writes it. */
  readonly path: string;
  /** The topic (with a heading's anchor where one section is the page's), or null: the list. */
  readonly topic: string | null;
  /** A page whose `tab` in the address is a different tool: the topic for each that has its own. */
  readonly tabs?: Readonly<Record<string, string>>;
}

export const helpPages: readonly HelpPage[] = [
  // Home is where everything is, so its Help is the whole list.
  { path: "/", topic: null },
  // Transactions
  { path: "/inbox", topic: "work-through-the-inbox" },
  { path: "/journal", topic: "work-through-the-inbox#all-transactions" },
  { path: "/journal/new", topic: "record-money-in-and-out" },
  { path: "/journal/$entryId", topic: "work-through-the-inbox#all-transactions" },
  { path: "/import", topic: "import-a-bank-statement" },
  { path: "/rules", topic: "write-bank-rules" },
  { path: "/rules/new", topic: "write-bank-rules" },
  { path: "/rules/$ruleId", topic: "write-bank-rules" },
  // Accounts
  { path: "/accounts", topic: "set-up-your-books#changing-tags-later" },
  { path: "/ledger", topic: "set-up-your-books#changing-tags-later" },
  { path: "/reconcile", topic: "reconcile-an-account" },
  { path: "/reconcile/$id", topic: "reconcile-an-account" },
  { path: "/settings/stripe", topic: "connect-stripe" },
  { path: "/settings/bankfeed", topic: "connect-your-bank" },
  { path: "/settings/banks", topic: "connect-your-bank" },
  // The list of an installed copy's connections has no how-to of its own: each connection's page has.
  { path: "/settings/connections", topic: null },
  // Reports
  { path: "/reports", topic: "read-financial-statements" },
  { path: "/reports/payees", topic: "see-who-you-paid-and-who-paid-you" },
  {
    path: "/tax",
    topic: "get-your-books-ready-for-tax-time",
    tabs: {
      pack: "get-your-books-ready-for-tax-time#build-the-year-end-pack",
      vendors: "track-1099-vendors",
      sales: "get-your-books-ready-for-tax-time#read-the-sales-tax-summary",
      accountant: "work-with-your-accountant",
    },
  },
  // Settings
  { path: "/settings", topic: "set-up-your-books" },
  { path: "/settings/members", topic: "invite-people-to-your-books" },
  { path: "/settings/workspace", topic: "export-or-delete-your-workspace" },
  { path: "/settings/billing", topic: "manage-your-subscription" },
  { path: "/settings/agent", topic: "connect-your-agent" },
  // Plugins does not have a dedicated Help how-to yet; opens the list of Help topics.
  { path: "/settings/plugins", topic: null },
  // The three ways to bring books in each have their own; the page that lists them has the list.
  { path: "/settings/bring-in", topic: null },
  { path: "/settings/history", topic: "bring-in-history" },
  { path: "/settings/move", topic: "move-from-xero" },
  { path: "/xero", topic: "move-from-xero" },
  { path: "/tie-out", topic: "move-from-xero" },
  { path: "/gaps", topic: "move-from-xero" },
  { path: "/opening", topic: "move-from-xero#3-start-the-books-from-opening-balances" },
  { path: "/periods", topic: "close-a-fiscal-year#close-a-month-in-the-web-app" },
  { path: "/cutover", topic: "close-a-fiscal-year#close-a-month-in-the-web-app" },
  { path: "/changes", topic: "see-what-changed-in-your-books" },
  { path: "/settings/backups", topic: "back-up-and-restore" },
  // Help itself
  { path: "/help", topic: null },
  { path: "/help/$topic", topic: null },
];

/** Where Help opens from an address, for these readers: the page's topic, or the list. */
export function helpHref(pathname: string, search: string, audience: HelpAudience): string {
  const page = matchRoute(helpPages, pathname);
  const tab = new URLSearchParams(search).get("tab") ?? "";
  const topic = page?.tabs?.[tab] ?? page?.topic ?? null;
  if (topic === null) return "/help";
  const [id = ""] = topic.split("#", 1);
  return topicFor(id, audience) ? `/help/${topic}` : "/help";
}

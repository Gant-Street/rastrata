// What Help holds. Each topic is one document of docs/ (a how-to, the tutorial, an explanation a customer
// reads), with the name the list shows and the group it is listed under. The documents are turned into
// what the reader shows when the app is built (tooling/help.ts); this file is data only, so the build, the
// tests and the app all read the same list.
//
// To add a topic: write the how-to in docs/how-to/, add a line here, and say which pages it belongs to in
// pages.ts. A part of a document that is only for some readers is marked in the document itself (see
// tooling/help.ts).

/** Who reads Help: a person on the hosted service, or one who runs Rastrata on their own computer. */
export type HelpAudience = "hosted" | "installed";

export type HelpGroupId = "start" | "transactions" | "accounts" | "reports" | "settings";

/** The groups of the list, in order: where to start, then the four places' own (Home has none) and Settings. */
export const helpGroups: readonly { readonly id: HelpGroupId; readonly label: string }[] = [
  { id: "start", label: "Getting started" },
  { id: "transactions", label: "Transactions" },
  { id: "accounts", label: "Accounts" },
  { id: "reports", label: "Reports" },
  { id: "settings", label: "Settings" },
];

export interface HelpTopic {
  /** The topic's address: /help/<id>. Two documents share one when each is for different readers. */
  readonly id: string;
  /** The document, under docs/. */
  readonly file: string;
  /** What the list and the page call it: the document's own title, unless `renamed`. */
  readonly title: string;
  /** The title is not the document's: the document names its readers ("in a hosted workspace"), which the
   * people reading it here need not be told. */
  readonly renamed?: true;
  readonly group: HelpGroupId;
  /** Only these readers have the topic. */
  readonly only?: HelpAudience;
}

/** One piece of a topic: running text (with its lists and tables), or a command or an example to copy. */
export type HelpBlock =
  | { readonly kind: "prose"; readonly html: string }
  | { readonly kind: "code"; readonly text: string };

/** A topic as the reader fetches it. */
export interface HelpDocument {
  readonly id: string;
  readonly title: string;
  readonly blocks: readonly HelpBlock[];
}

export const helpTopics: readonly HelpTopic[] = [
  {
    id: "your-first-month",
    file: "tutorials/your-first-month.md",
    title: "Your first month on Rastrata",
    group: "start",
    only: "installed",
  },
  {
    id: "set-up-your-books",
    file: "how-to/set-up-your-books.md",
    title: "Set up your books",
    group: "start",
  },
  {
    id: "move-in-with-your-agent",
    file: "how-to/move-in-with-your-agent.md",
    title: "Move to Rastrata with your own agent",
    group: "start",
  },
  {
    id: "import-a-bank-statement",
    file: "how-to/import-a-bank-statement.md",
    title: "Import a bank statement",
    group: "transactions",
  },
  {
    id: "work-through-the-inbox",
    file: "how-to/work-through-the-inbox.md",
    title: "Work through For review",
    group: "transactions",
  },
  {
    id: "record-money-in-and-out",
    file: "how-to/record-money-in-and-out.md",
    title: "Record money you spent, received or moved",
    group: "transactions",
  },
  {
    id: "write-bank-rules",
    file: "how-to/write-bank-rules.md",
    title: "Write rules for recurring transactions",
    group: "transactions",
  },
  {
    id: "fix-a-category-in-bulk",
    file: "how-to/fix-a-category-in-bulk.md",
    title: "Fix a category in bulk",
    group: "transactions",
  },
  {
    id: "reconcile-an-account",
    file: "how-to/reconcile-an-account.md",
    title: "Reconcile a bank or card account",
    group: "accounts",
  },
  {
    id: "connect-stripe",
    file: "how-to/connect-stripe-in-a-hosted-workspace.md",
    title: "Connect Stripe",
    renamed: true,
    group: "accounts",
    only: "hosted",
  },
  {
    id: "connect-stripe",
    file: "how-to/connect-stripe.md",
    title: "Connect Stripe",
    group: "accounts",
    only: "installed",
  },
  {
    id: "book-stripe-in-a-hosted-workspace",
    file: "how-to/book-stripe-in-a-hosted-workspace.md",
    title: "Book Stripe with a key of your own",
    renamed: true,
    group: "accounts",
    only: "hosted",
  },
  {
    id: "connect-your-bank",
    file: "how-to/connect-your-bank.md",
    title: "Connect your bank",
    group: "accounts",
    only: "hosted",
  },
  {
    id: "connect-your-bank",
    file: "how-to/connect-your-bank-through-simplefin.md",
    title: "Connect your bank through SimpleFIN",
    group: "accounts",
    only: "installed",
  },
  {
    id: "stripe-booking",
    file: "explanation/stripe-booking.md",
    title: "How Rastrata books Stripe",
    group: "accounts",
  },
  {
    id: "read-financial-statements",
    file: "how-to/read-financial-statements.md",
    title: "Read your financial statements",
    group: "reports",
  },
  {
    id: "see-who-you-paid-and-who-paid-you",
    file: "how-to/see-who-you-paid-and-who-paid-you.md",
    title: "See who you paid and who paid you",
    group: "reports",
  },
  {
    id: "get-your-books-ready-for-tax-time",
    file: "how-to/get-your-books-ready-for-tax-time.md",
    title: "Get your books ready for tax time",
    group: "reports",
  },
  {
    id: "track-1099-vendors",
    file: "how-to/track-1099-vendors.md",
    title: "Track your 1099 vendors",
    group: "reports",
  },
  {
    id: "work-with-your-accountant",
    file: "how-to/work-with-your-accountant.md",
    title: "Work with your accountant",
    group: "reports",
  },
  {
    id: "connect-your-agent",
    file: "how-to/connect-your-agent-to-a-hosted-workspace.md",
    title: "Connect your agent to your books",
    renamed: true,
    group: "settings",
    only: "hosted",
  },
  {
    id: "connect-your-agent",
    file: "how-to/connect-your-agent.md",
    title: "Connect your agent to your books",
    group: "settings",
    only: "installed",
  },
  {
    id: "bring-in-history",
    file: "how-to/bring-in-history.md",
    title: "Bring in your past years",
    group: "settings",
  },
  {
    id: "move-from-xero",
    file: "how-to/move-from-xero.md",
    title: "Move from Xero to Rastrata",
    group: "settings",
  },
  {
    id: "change-your-books-after-you-have-entries",
    file: "how-to/change-your-books-after-you-have-entries.md",
    title: "Change your accounting method, fiscal year or currency after you have entries",
    group: "settings",
  },
  {
    id: "close-a-fiscal-year",
    file: "how-to/close-a-fiscal-year.md",
    title: "Close a fiscal year",
    group: "settings",
  },
  {
    id: "see-what-changed-in-your-books",
    file: "how-to/see-what-changed-in-your-books.md",
    title: "See what changed in your books",
    group: "settings",
  },
  {
    id: "invite-people-to-your-books",
    file: "how-to/invite-people-to-your-books.md",
    title: "Invite people to your books",
    group: "settings",
    only: "hosted",
  },
  {
    id: "manage-your-subscription",
    file: "how-to/manage-your-subscription.md",
    title: "Manage your subscription",
    group: "settings",
    only: "hosted",
  },
  {
    id: "export-or-delete-your-workspace",
    file: "how-to/export-or-delete-your-workspace.md",
    title: "Export or delete your workspace",
    group: "settings",
    only: "hosted",
  },
  {
    id: "back-up-and-restore",
    file: "how-to/back-up-and-restore.md",
    title: "Back up, verify and restore your book",
    group: "settings",
    only: "installed",
  },
];

/** The topic at an address for these readers, or nothing. */
export function topicFor(
  id: string,
  audience: HelpAudience,
  topics: readonly HelpTopic[] = helpTopics,
): HelpTopic | undefined {
  return topics.find(
    (topic) => topic.id === id && (topic.only === undefined || topic.only === audience),
  );
}

/** The topics these readers have, group by group; a group with nothing in it is left out. */
export function topicsByGroup(
  audience: HelpAudience,
  topics: readonly HelpTopic[] = helpTopics,
): { readonly id: HelpGroupId; readonly label: string; readonly topics: readonly HelpTopic[] }[] {
  return helpGroups
    .map((group) => ({
      ...group,
      topics: topics.filter(
        (topic) =>
          topic.group === group.id && (topic.only === undefined || topic.only === audience),
      ),
    }))
    .filter((group) => group.topics.length > 0);
}

/** Where the built app keeps a topic for these readers. */
export const helpContentPath = (id: string, audience: HelpAudience): string =>
  `/help-content/${audience}/${id}.json`;

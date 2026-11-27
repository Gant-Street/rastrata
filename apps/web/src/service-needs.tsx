import { buttonAttrs, Notice, PageHeader } from "@rastrata/ui";
import { type Need, capabilities, has } from "./capabilities";
import type { Screen } from "./routes/screen";

/** What a page says in place of itself where the service cannot do what it is for. The pages are out of the navigation and Search then (`needs` in the registry); this is for
 * an address that was typed or bookmarked, and it says so and, where there is one, offers the way that works. */
const STAND_INS: Readonly<
  Record<
    Exclude<Need, "accounts" | "stripeApp">,
    {
      title: string;
      description: string;
      notice: string;
      body: string;
      action?: { label: string; href: string };
    }
  >
> = {
  // A service with many books in one process keeps no credential: one kept beside the books would be every book's.
  connections: {
    title: "Connections",
    description: "Where transactions can come from besides files you import.",
    notice: "Connections are not available on this service",
    body: "It does not keep a bank or Stripe connection for your books. Bring transactions in from the statement files your bank gives you.",
    action: { label: "Import statement", href: "/import" },
  },
  // A service that keeps no Stripe credential and whose control plane has no Stripe app does not read Stripe itself: the
  // command line on the person's own computer does, with a key that stays there (docs/how-to/book-stripe-in-a-hosted-workspace.md).
  stripe: {
    title: "Stripe",
    description: "Import your Stripe payouts automatically.",
    notice: "Stripe is read from your own computer",
    body: "This workspace keeps no Stripe key. The command line on your computer reads Stripe with a key that stays there and hands each payout to your books.",
    action: { label: "Open For review", href: "/inbox" },
  },
  // A service whose control plane has no keys for Stripe, or that has no accounts, cannot connect a bank for the person.
  banks: {
    title: "Bank accounts",
    description: "Import your bank transactions automatically.",
    notice: "Bank connections are not available here",
    body: "This service cannot connect a bank for your books. Bring transactions in from the statement files your bank gives you.",
    action: { label: "Import statement", href: "/import" },
  },
  // A service that does not charge for workspaces has no trial and no subscription to show.
  billing: {
    title: "Billing",
    description: "Your workspace's trial and subscription.",
    notice: "There is nothing to pay for here",
    body: "This service does not charge for workspaces.",
  },
  // A hosted service keeps the backups of a book itself: the log is the backup.
  backups: {
    title: "Backups and export",
    description: "Keeping a copy of your books.",
    notice: "There are no backups to make here",
    body: "This service keeps the complete history of your books, so there is nothing for you to back up. To keep a copy of your own, export your books.",
    action: { label: "Export your books", href: "/settings/workspace" },
  },
  // A hosted service that takes only the owner's key, or only people's, and no agent's token.
  agents: {
    title: "Agents",
    description: "Programs and assistants that work in your books with a key of their own.",
    notice: "Agents are not available on this service",
    body: "It does not take an agent's token, so an agent cannot connect to your books here.",
  },
};

/** A page that needs something of the service (a place to keep a connection's credential, a way to take an agent's token), or a stand-in for it where the service lacks it. */
export function whenTheServiceCan(need: keyof typeof STAND_INS, Page: Screen): Screen {
  const guarded = () => (has(capabilities(), need) ? <Page /> : <Unavailable need={need} />);
  // The page's file is fetched ahead when the route is, as it is for a page that is not guarded.
  return Object.assign(guarded, Page.preload ? { preload: Page.preload } : {});
}

function Unavailable(props: { readonly need: keyof typeof STAND_INS }) {
  const words = STAND_INS[props.need];
  return (
    <section aria-labelledby="unavailable-title">
      <PageHeader titleId="unavailable-title" title={words.title} description={words.description} />
      <Notice title={words.notice} tone="info">
        <p>{words.body}</p>
        {words.action ? (
          <a {...buttonAttrs({ variant: "secondary", size: "md" })} href={words.action.href}>
            {words.action.label}
          </a>
        ) : null}
      </Notice>
    </section>
  );
}

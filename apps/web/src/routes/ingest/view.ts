import type { InboxFilter } from "@rastrata/application/client-contracts";
import {
  emptyFilters,
  type InboxCountsView,
  type InboxFilterState,
  type InboxSourceView,
  type InboxTab,
} from "@rastrata/ui/ingest/types";

/** What the For review view of Transactions asks the service for, and how it reads the address. Pure, so
 * it is tested without a browser: the controller holds the signals and does the work, and this decides
 * what a view of the list means. */

/** An account filter naming a provider rather than a chart account ("provider:stripe"). */
export const PROVIDER = "provider:";

/** Where each view of the Transactions page lives: what waits for review, what is ready to post and what
 * was set aside are views of one page, and everything in the books is the page beside it. */
export const VIEW_HREFS = {
  review: "/inbox",
  ready: "/inbox?tab=ready",
  excluded: "/inbox?tab=excluded",
  all: "/journal",
} as const;

const present = (text: string): string | undefined => {
  const trimmed = text.trim();
  return trimmed === "" ? undefined : trimmed;
};

/** The service-side filter for a view of the list and the person's filters. The transactions one payout
 * books are listed whatever has become of them, so that filter takes the place of the view's own. (The
 * service filters by amount, direction and who suggested as well; the screen offers none of them, and an
 * agent or the command line still can.) */
export function serverFilter(tab: InboxTab, state: InboxFilterState): InboxFilter {
  const filter: { -readonly [K in keyof InboxFilter]: InboxFilter[K] } = {};
  if (state.coveredBy !== "") filter.coveredBy = state.coveredBy;
  else if (tab === "review") {
    filter.status = ["new", "proposed"];
    filter.covered = false;
  } else if (tab === "ready") {
    filter.status = ["drafted"];
    filter.covered = false;
  } else filter.status = ["excluded"];
  const text = present(state.text);
  if (text) filter.text = text;
  if (state.account !== "") {
    if (state.account.startsWith(PROVIDER)) filter.provider = state.account.slice(PROVIDER.length);
    else filter.ledgerAccountId = state.account;
  }
  if (state.source !== "") {
    const [provider, accountKey] = state.source.split("\u0000");
    if (provider && accountKey) {
      filter.provider = provider;
      filter.accountKey = accountKey;
    }
  }
  if (state.from !== "") filter.from = state.from;
  if (state.to !== "") filter.to = state.to;
  return filter;
}

/** The counts of what the account select has chosen. The service counts the whole book; each provider
 * account has its own counts, so an account's are those of the provider accounts booked to it. */
export function scopedCounts(
  counts: InboxCountsView,
  sources: readonly InboxSourceView[],
  account: string,
): InboxCountsView {
  if (account === "") return counts;
  const mine = sources.filter((source) =>
    account.startsWith(PROVIDER)
      ? source.provider === account.slice(PROVIDER.length)
      : source.ledgerAccountId === account,
  );
  const sum = (pick: (counts: InboxCountsView) => number) =>
    mine.reduce((total, source) => total + pick(source.counts), 0);
  return {
    total: sum((each) => each.total),
    new: sum((each) => each.new),
    proposed: sum((each) => each.proposed),
    drafted: sum((each) => each.drafted),
    posted: sum((each) => each.posted),
    excluded: sum((each) => each.excluded),
    toReview: sum((each) => each.toReview),
    covered: sum((each) => each.covered ?? 0),
    postable: sum((each) => each.postable ?? each.drafted),
    beforeCutover: sum((each) => each.beforeCutover),
  };
}

const TABS: readonly InboxTab[] = ["review", "ready", "excluded"];

/** What the address asks for: an account (`?account=<chart account id>`, or `?provider=stripe`) and a
 * view (`?tab=ready`, `?tab=excluded`). Home's tiles, Search and the page's own switch link here. An
 * address from before the two lists became one page (`?tab=posted`, `?tab=all`) opens what waits for
 * review: what is posted is in the list of all transactions. */
export function viewFromAddress(search: string): { tab: InboxTab; filters: InboxFilterState } {
  const params = new URLSearchParams(search);
  const provider = params.get("provider");
  const account = params.get("account") ?? (provider ? `${PROVIDER}${provider}` : "");
  const tab = TABS.find((name) => name === params.get("tab")) ?? "review";
  return { tab, filters: { ...emptyFilters, account } };
}

const queryOf = (params: URLSearchParams): string => {
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
};

/** The address for a chosen account: `?account=<id>`, `?provider=stripe`, or none for every account. */
export function addressFor(search: string, account: string): string {
  const params = new URLSearchParams(search);
  params.delete("account");
  params.delete("provider");
  if (account.startsWith(PROVIDER)) params.set("provider", account.slice(PROVIDER.length));
  else if (account !== "") params.set("account", account);
  return queryOf(params);
}

/** The address for a view: `?tab=ready`, `?tab=excluded`, or none for what waits for review. A
 * transaction the address named (`?item=`) belonged to the view that was open, so it is let go. */
export function addressForTab(search: string, tab: InboxTab): string {
  const params = new URLSearchParams(search);
  params.delete("tab");
  params.delete("item");
  if (tab !== "review") params.set("tab", tab);
  return queryOf(params);
}

import { type Accessor, Index, type JSX, Show } from "solid-js";
import { formatCount } from "../format";
import { words } from "./words";

/** One view of the Transactions page: what waits for a decision, what is ready to post, what was set aside,
 * or everything in the books. Each has its own address. */
export interface TransactionView {
  readonly id: "review" | "ready" | "excluded" | "all";
  readonly label: string;
  readonly href: string;
  /** How many it holds. Said only above zero: a view with nothing in it has no number. */
  readonly count?: number | undefined;
  /** The view that is showing. */
  readonly current?: boolean | undefined;
  /** A view of the page that is already open: it is shown without leaving the page. */
  readonly here?: boolean | undefined;
}

export interface ViewLinkExtras {
  readonly class: string;
  /** The label, and the count when there is one. */
  readonly children: JSX.Element;
}

/** Where each view lives. */
export interface TransactionViewHrefs {
  readonly review: string;
  readonly ready: string;
  readonly excluded: string;
  readonly all: string;
}

/** The views the Transactions page offers, from what waits in them. "For review" and "All" are always
 * there. "Ready to post" is offered only while something is in it (it is where a rule's or an agent's
 * drafts wait for the person), and "Excluded" only while it is the one being shown: its door is the line
 * under the list. `page` says which page is open: the views of For review's page are chosen without
 * leaving it, and the list of everything is a page of its own. */
export function transactionViews(options: {
  current: TransactionView["id"];
  page: "review" | "all";
  toReview: number;
  ready: number;
  excluded?: number | undefined;
  hrefs: TransactionViewHrefs;
}): TransactionView[] {
  const here = options.page === "review";
  const view = (
    id: TransactionView["id"],
    count: number | undefined,
    inPage: boolean,
  ): TransactionView => ({
    id,
    label: words.views[id],
    href: options.hrefs[id],
    ...(count !== undefined && count > 0 ? { count } : {}),
    ...(options.current === id ? { current: true } : {}),
    ...(inPage ? { here: true } : {}),
  });
  return [
    view("review", options.toReview, here),
    ...(options.ready > 0 || options.current === "ready"
      ? [view("ready", options.ready, here)]
      : []),
    ...(options.current === "excluded" ? [view("excluded", options.excluded, here)] : []),
    view("all", undefined, !here),
  ];
}

/** A click the browser keeps for itself: a new tab or window, a download, a selection. */
const browserKeeps = (event: MouseEvent): boolean =>
  event.defaultPrevented ||
  event.button !== 0 ||
  event.metaKey ||
  event.ctrlKey ||
  event.shiftKey ||
  event.altKey;

/** The switch under the title of the Transactions page: "For review 8 · All". They are links between
 * addresses, not ARIA tabs, so the keyboard is Tab and Enter as for every other link, a view opens in a new
 * tab like any page, and the one that is showing says so (`aria-current`). A view of the page that is open
 * is shown in place (`onView`); the others go where their address says, through the application's own
 * link when it gives one (`renderLink`). A link is drawn once and reads its view as the counts change, so
 * a count that moves does not take the keyboard off the link it is on. */
export function TransactionViews(props: {
  views: readonly TransactionView[];
  /** The counts may be about to change (the list is being read again). */
  stale?: boolean;
  /** Show a view of the page that is open. */
  onView?: (id: TransactionView["id"]) => void;
  /** Draws a link to another page the way the application navigates. */
  renderLink?: (view: TransactionView, extras: ViewLinkExtras) => JSX.Element;
}): JSX.Element {
  const inside = (view: Accessor<TransactionView>): JSX.Element => (
    <>
      <span>{view().label}</span>
      <Show when={view().count !== undefined}>
        <span class="rt-inbox-tab-count" data-stale={props.stale ? "" : undefined}>
          {formatCount(view().count ?? 0)}
        </span>
      </Show>
    </>
  );
  /** The view as it is now, for a link the application draws once. */
  const live = (view: Accessor<TransactionView>): TransactionView => ({
    get id() {
      return view().id;
    },
    get label() {
      return view().label;
    },
    get href() {
      return view().href;
    },
    get count() {
      return view().count;
    },
    get current() {
      return view().current;
    },
    get here() {
      return view().here;
    },
  });
  return (
    <nav class="rt-inbox-tabs" aria-label={words.tabsLabel}>
      <Index each={props.views}>
        {(view) => (
          <Show
            when={view().here || view().current || !props.renderLink}
            fallback={props.renderLink?.(live(view), {
              class: "rt-inbox-tab",
              children: inside(view),
            })}
          >
            <a
              class="rt-inbox-tab"
              href={view().href}
              data-view={view().id}
              aria-current={view().current ? "page" : undefined}
              onClick={(event) => {
                if (browserKeeps(event) || !(view().here || view().current)) return;
                event.preventDefault();
                if (!view().current) props.onView?.(view().id);
              }}
            >
              {inside(view)}
            </a>
          </Show>
        )}
      </Index>
    </nav>
  );
}

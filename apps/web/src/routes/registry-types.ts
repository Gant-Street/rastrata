// The shapes a lane registers with. They are here, apart from the registry that imports every lane, so
// the navigation and Search logic (and their unit tests) can use them without loading a single screen.
// Lanes import them from "./registry.ts", which re-exports all of this.
import type { JSX } from "solid-js";
import type { BrowserApplicationClient } from "../application-client.ts";
import type { Need } from "../capabilities.ts";
import type { Screen } from "./screen.ts";

/** The places of the product (the header lists them in this order; Settings is last and apart): the four
 * a person works in, from the plan of 2026-11-11 (docs/reference/ux-simplify-plan.md). Every route belongs
 * to exactly one. Help is not a place: it is on no bar, its link is in the footer of every page, and its
 * pages have a section of their own so that they sit under none of the others. */
export type NavSection = "home" | "transactions" | "accounts" | "reports" | "settings" | "help";

/** Where a route lives in the navigation. A route with a `label` and no `parent` is a destination: a tab
 * in its section's row, or an entry in the Settings list. A route with a `parent` is a page under another
 * (the path of the page it is opened from, whose tab stays underlined while it is open); give it a `label`
 * too when it has a name of its own ("Move from Xero"), and Search lists it by that name. A route with
 * neither is not reachable, and `tests/registry` fails for it. */
export interface RouteNav {
  readonly section: NavSection;
  /** The page's name, in the vocabulary of the plan ("For review", "Close the books"). */
  readonly label?: string;
  /** Sorts the tabs of a section: lower comes first. The first tab is where the section's link goes. */
  readonly order?: number;
  /** The page this one sits under (`/journal` for an entry; `/settings/bring-in` for Move from Xero). */
  readonly parent?: string;
  /** Other words a person might use for this page ("inbox" for For review); Search finds it by them. */
  readonly keywords?: readonly string[];
  /** The page's name for one address, where each address has its own (a topic of Help): the browser tab
   * and the screen reader say it in place of the name of the page above. */
  readonly title?: (address: string) => string | undefined;
  /** What the page needs of the service that serves it (see capabilities.ts). A service that cannot give it has the page out of the navigation and out of Search. */
  readonly needs?: Need;
  /** A live number for the tab (what is waiting for review). It is read when the shell opens, after
   * each page, and after each write, and shown when it is above zero: beside the section's name in the
   * bar when the tab is where the section opens, beside the tab otherwise. */
  readonly count?: (
    client: BrowserApplicationClient,
    signal: AbortSignal,
  ) => Promise<number | undefined>;
}

export interface AppRoute {
  /** A TanStack Router path: "/inbox", "/reconcile/$id". */
  readonly path: string;
  /** The screen, which may be fetched when it is first wanted (`screen` in screen.ts). */
  readonly component: Screen;
  /** Where the route sits in the navigation. Required: no route is left out of the map. */
  readonly nav: RouteNav;
}

/** One thing a person starts by its name. It has a destination (`href`) or a dialog (`dialog`, the id of
 * one of a lane's `dialogs`). "+ New" lists the few that are started from anywhere; Search finds every one
 * of them, so an action that is a button on its own page (Import statement, Bank rule) says `searchOnly`. */
export interface NewAction {
  /** Stable and unique across the app: a lane that wants to change an action edits its line. */
  readonly id: string;
  readonly label: string;
  /** Sorts "+ New", and Search's actions that fit a question equally: lower comes first. */
  readonly order: number;
  /** Not in "+ New": the action has a button on the page it belongs to, and Search finds it by name. */
  readonly searchOnly?: true;
  readonly href?: string;
  readonly dialog?: string;
  readonly keywords?: readonly string[];
}

/** A dialog a lane offers (Spend money, Receive money, Transfer). The shell keeps the id of the open one in
 * one signal at the root, so it opens over any page: it mounts the component when its action is chosen
 * (from "+ New", from Search, or from `?new=<action id>` in the address) and unmounts it when it calls
 * `onClose`, then puts focus back on the "+ New" button. The dialog is the lane's own; `open` is always
 * true while it is mounted. */
export interface NewDialog {
  readonly id: string;
  readonly component: Screen<{ open: boolean; onClose: () => void }>;
}

/** One result of a search. A hit goes to an address (`href`) or opens a dialog (`dialog`). */
export interface SearchHit {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly href?: string;
  readonly dialog?: string;
  readonly kind: "transaction" | "review" | "account" | "page" | "action";
}

/** Something Search can ask. The shell debounces the question, asks every source at once, and shows each
 * source's results under its `label`, in `order`. A source that fails or is slow never holds the others;
 * `signal` aborts when the question changes. Return at most a handful of hits. */
export interface SearchSource {
  readonly id: string;
  readonly label: string;
  /** Sorts the groups of results: lower comes first. The built-in actions and pages are 10 and 20. */
  readonly order: number;
  /** The source answers from memory, with no read: it is asked on every keystroke. The others wait for
   * a pause in typing. */
  readonly instant?: boolean;
  search(
    query: string,
    client: BrowserApplicationClient,
    signal: AbortSignal,
  ): Promise<readonly SearchHit[]>;
}

/** One line of the status list on Home ("10 lines to review", "Last verified backup: 3 hours ago").
 * It is a glance and a link, never a workflow of its own. Build the component from `HomeItem` and
 * `HomeNote` in `@rastrata/ui`: they say what needs a person (a tone), how it reads while it loads
 * and when it fails, and they let Home count the lines that need attention. Read with the shared
 * loader (`apps/web/src/loader.ts`), never a suspending resource: a card that suspends holds the
 * whole page back. */
export interface HomeCard {
  readonly id: string;
  readonly order: number;
  readonly component: () => JSX.Element;
}

export interface LaneUi {
  readonly routes: readonly AppRoute[];
  readonly homeCards: readonly HomeCard[];
  readonly newActions?: readonly NewAction[];
  readonly dialogs?: readonly NewDialog[];
  readonly searchSources?: readonly SearchSource[];
}

import type { NavActionEntry, NavCurrent, NavSectionEntry, NavTab } from "@rastrata/ui/nav-types";
import { type Capabilities, has } from "./capabilities.ts";
import type { NavSection, NewAction, RouteNav } from "./routes/registry-types.ts";

/** The part of a route the navigation reads. (The component is not needed to say where a route sits, so
 * the tests can read the whole registry as data.) */
export interface NavRoute {
  readonly path: string;
  readonly nav: RouteNav;
}

/** The routes the service behind the page can back: a route that `needs` something the service lacks (accounts for the Members page; a place to keep a credential for the bank and
 * Stripe pages) is left out, so the navigation and Search never offer it. */
export function availableRoutes<T extends NavRoute>(
  routes: readonly T[],
  capabilities: Capabilities,
): T[] {
  return routes.filter(
    (route) => route.nav.needs === undefined || has(capabilities, route.nav.needs),
  );
}

/** The four places and Settings. The header lists all of them but Settings, which sits apart at the
 * right. A section's name is its word on the bar. */
export const SECTIONS: readonly { readonly id: NavSection; readonly label: string }[] = [
  { id: "home", label: "Home" },
  { id: "transactions", label: "Transactions" },
  { id: "accounts", label: "Accounts" },
  { id: "reports", label: "Reports" },
  { id: "settings", label: "Settings" },
];

/** Help: on no bar (its link is in the footer), with pages that have names like any other. */
export const HELP_SECTION: { readonly id: NavSection; readonly label: string } = {
  id: "help",
  label: "Help",
};

/** Every section a route can name: the bar's, then Help. Search lists the pages of each. */
export const NAMED_SECTIONS: readonly { readonly id: NavSection; readonly label: string }[] = [
  ...SECTIONS,
  HELP_SECTION,
];

export const sectionLabel = (section: NavSection): string =>
  NAMED_SECTIONS.find((entry) => entry.id === section)?.label ?? section;

// ---- Which route is this address? ------------------------------------------------------------------------

const segmentsOf = (path: string): string[] => path.split("/").filter((part) => part !== "");

/** An address without its query, its fragment or a trailing slash ("/" stays "/"). */
export function normalizePath(address: string): string {
  const bare = address.split(/[?#]/, 1)[0] ?? "";
  const path = bare.startsWith("/") ? bare : `/${bare}`;
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
}

/** Whether `address` is the route `pattern` ("/reconcile/$id" is any one segment after /reconcile). */
function fits(pattern: string, address: string): boolean {
  const wanted = segmentsOf(pattern);
  const got = segmentsOf(address);
  if (wanted.length !== got.length) return false;
  return wanted.every((part, index) => part.startsWith("$") || part === got[index]);
}

/** The route an address opens. Where a fixed path and a parameter both fit ("/journal/new" and
 * "/journal/$entryId"), the fixed one wins, as it does in the router. */
export function matchRoute<T extends { readonly path: string }>(
  routes: readonly T[],
  address: string,
): T | undefined {
  const path = normalizePath(address);
  const candidates = routes.filter((route) => fits(route.path, path));
  const fixed = (route: T) => segmentsOf(route.path).filter((part) => !part.startsWith("$")).length;
  return candidates.sort((left, right) => fixed(right) - fixed(left))[0];
}

// ---- The tabs of a section ----------------------------------------------------------------------------------

const byOrder = (left: NavRoute, right: NavRoute): number =>
  (left.nav.order ?? 1000) - (right.nav.order ?? 1000) ||
  (left.nav.label ?? "").localeCompare(right.nav.label ?? "");

/** A destination: a page with a name that sits under no other page. */
const isTab = (route: NavRoute): boolean =>
  route.nav.label !== undefined && route.nav.parent === undefined;

/** The destinations of a section: its routes that have a label and no parent, in order. A path is listed
 * once (the first registration in order wins), so two lanes that register the same screen cannot list it
 * twice. */
export function tabRoutes(routes: readonly NavRoute[], section: NavSection): NavRoute[] {
  const listed = new Set<string>();
  const tabs: NavRoute[] = [];
  for (const route of routes
    .filter((entry) => entry.nav.section === section && isTab(entry))
    .sort(byOrder)) {
    if (listed.has(route.path)) continue;
    listed.add(route.path);
    tabs.push(route);
  }
  return tabs;
}

/** Every page of a section that has a name: its tabs, then the named pages under them by name. It is
 * what Search lists, so a page that is opened from another page is still found by what it is called. */
export function namedRoutes(routes: readonly NavRoute[], section: NavSection): NavRoute[] {
  const tabs = tabRoutes(routes, section);
  const listed = new Set(tabs.map((route) => route.path));
  const under: NavRoute[] = [];
  for (const route of routes
    .filter(
      (entry) =>
        entry.nav.section === section &&
        entry.nav.label !== undefined &&
        entry.nav.parent !== undefined,
    )
    .sort((left, right) => (left.nav.label ?? "").localeCompare(right.nav.label ?? ""))) {
    if (listed.has(route.path)) continue;
    listed.add(route.path);
    under.push(route);
  }
  return [...tabs, ...under];
}

/** Where a section's link goes: the section's first tab. A section with no tab has no link. */
export function sectionPath(routes: readonly NavRoute[], section: NavSection): string | undefined {
  return tabRoutes(routes, section)[0]?.path;
}

// ---- Where the person is -------------------------------------------------------------------------------------

export interface Here {
  /** The route the address opens; undefined for an address the app does not know (not found). */
  readonly route: NavRoute | undefined;
  readonly section: NavSection | undefined;
  /** The path of the tab the page belongs to: itself for a tab, the tab it sits under for any other. */
  readonly tab: string | undefined;
  /** The page is the tab itself (not a page under it). */
  readonly onTab: boolean;
}

/** What the navigation says about an address: its section, and which tab stays underlined. A page under
 * another names it (`parent`); a parent that is itself under a page is followed up to the tab. */
export function whereIs(routes: readonly NavRoute[], address: string): Here {
  const route = matchRoute(routes, address);
  if (!route) return { route: undefined, section: undefined, tab: undefined, onTab: false };
  if (isTab(route)) return { route, section: route.nav.section, tab: route.path, onTab: true };
  let tab: string | undefined = route.nav.parent;
  for (let hops = 0; tab !== undefined && hops < 4; hops += 1) {
    const holder: NavRoute | undefined = routes.find((entry) => entry.path === tab);
    if (!holder || isTab(holder)) break;
    tab = holder.nav.parent;
  }
  return { route, section: route.nav.section, tab, onTab: false };
}

/** What a page is called: its own name, or the name of the nearest page above it that has one (an entry is
 * "All transactions", a new rule is "Rules", importing a statement is "Transactions"). Undefined for an
 * address the app does not know. */
export function pageNameOf(routes: readonly NavRoute[], here: Here): string | undefined {
  let route: NavRoute | undefined = here.route;
  for (let hops = 0; route !== undefined && hops < 6; hops += 1) {
    if (route.nav.label !== undefined) return route.nav.label;
    const parent: string | undefined = route.nav.parent;
    route = parent === undefined ? undefined : routes.find((entry) => entry.path === parent);
  }
  return undefined;
}

// ---- What the header and the tabs are given ---------------------------------------------------------------------

export interface Header {
  /** The bar: every section but Settings that has somewhere to go. */
  readonly sections: readonly NavSectionEntry[];
  readonly settings: NavSectionEntry | undefined;
  /** The tabs under the header for the section the person is in. Empty when the section has one page
   * (Home) or none (an address the app does not know): a row with one tab says nothing. */
  readonly tabs: readonly NavTab[];
  /** The section the tabs belong to, for their name ("Transactions pages"). */
  readonly tabsOf: NavSection | undefined;
  /** The Settings list, for the pages of Settings (the same entries, in a column). */
  readonly settingsList: readonly NavTab[];
  readonly here: Here;
}

const tabOf = (
  route: NavRoute,
  here: Here,
  address: string,
  counts: Readonly<Record<string, number | undefined>>,
): NavTab => {
  const current: NavCurrent | undefined =
    route.path === normalizePath(address) ? "page" : route.path === here.tab ? "true" : undefined;
  const count = counts[route.path];
  return {
    path: route.path,
    label: route.nav.label ?? route.path,
    ...(count !== undefined ? { count } : {}),
    ...(current ? { current } : {}),
  };
};

/** Everything the header, the tab row and the Settings list are drawn from, for an address. */
export function buildHeader(
  routes: readonly NavRoute[],
  address: string,
  counts: Readonly<Record<string, number | undefined>> = {},
): Header {
  const here = whereIs(routes, address);
  const path = normalizePath(address);
  const entry = (section: NavSection): NavSectionEntry | undefined => {
    const target = sectionPath(routes, section);
    if (target === undefined) return undefined;
    const current: NavCurrent | undefined =
      here.section === section ? (target === path ? "page" : "true") : undefined;
    // What waits on the page the section opens is said once, beside the section's name.
    const count = counts[target];
    return {
      id: section,
      label: sectionLabel(section),
      path: target,
      ...(count !== undefined ? { count } : {}),
      ...(current ? { current } : {}),
    };
  };
  const sections = SECTIONS.filter((section) => section.id !== "settings").flatMap((section) => {
    const built = entry(section.id);
    return built ? [built] : [];
  });
  const tabsFor = (section: NavSection): NavTab[] =>
    tabRoutes(routes, section).map((route, index) =>
      // The first tab is where the section's link goes, and the bar already carries its number.
      tabOf(route, here, address, index === 0 && section !== "settings" ? {} : counts),
    );
  const inSection = here.section ? tabsFor(here.section) : [];
  return {
    sections,
    settings: entry("settings"),
    tabs: here.section && here.section !== "settings" && inSection.length > 1 ? inSection : [],
    tabsOf: here.section,
    settingsList: here.section === "settings" ? inSection : [],
    here,
  };
}

/** "+ New": the few things a person starts from anywhere, in `order`. An action registered twice is
 * listed once (the first registration wins), and one that is for Search only is left out. */
export function buildNewActions(actions: readonly NewAction[]): NavActionEntry[] {
  const seen = new Set<string>();
  return actions
    .filter((action) => {
      if (seen.has(action.id)) return false;
      seen.add(action.id);
      return action.searchOnly !== true;
    })
    .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label))
    .map((action) => ({
      id: action.id,
      label: action.label,
      ...(action.href !== undefined ? { href: action.href } : {}),
    }));
}

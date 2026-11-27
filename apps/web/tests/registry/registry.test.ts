import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  availableRoutes,
  buildHeader,
  buildNewActions,
  NAMED_SECTIONS,
  type NavRoute,
  SECTIONS,
  sectionPath,
  tabRoutes,
} from "../../src/nav";
import type {
  AppRoute,
  NavSection,
  NewAction,
  NewDialog,
  SearchSource,
} from "../../src/routes/registry-types";
import { helpPages } from "../../src/routes/help/pages";

// These tests read the application's real registry: every route of every lane, where each sits in the
// navigation, what "+ New" starts, what Search asks. They are the guard behind the plan's principle "few
// doors, all visible": a screen that is in no menu, a detail page with no parent, an action nobody can find,
// or a label that appears twice, fails here and not in front of a person.
//
// The registry imports every screen, so this file runs under the browser build of Solid with a minimal
// window (see tests/support/browser-preload.ts and the `test` script).
const entry = new URL("../../src/routes/all.ts", import.meta.url).pathname;
const registry = (await import(entry)) as {
  allRoutes: readonly AppRoute[];
  allNewActions: readonly NewAction[];
  allDialogs: readonly NewDialog[];
  allSearchSources: readonly SearchSource[];
  navRoutes: readonly NavRoute[];
};
const { allRoutes, allNewActions, allDialogs, allSearchSources, navRoutes } = registry;

// The bar's four places and Settings, and Help, which is on no bar (its link is in the footer).
const sections: readonly NavSection[] = NAMED_SECTIONS.map((section) => section.id);
const pathOf = (route: AppRoute | NavRoute) => route.path;
/** Every page with a name: Search lists it. */
const labelled = allRoutes.filter((route) => route.nav.label !== undefined);
/** A destination: a named page under no other (a tab, or an entry of the Settings list). */
const isTab = (route: AppRoute | NavRoute) =>
  route.nav.label !== undefined && route.nav.parent === undefined;
const tabs = allRoutes.filter(isTab);

test("the registry is found, so these tests cannot pass by finding nothing", () => {
  expect(allRoutes.length).toBeGreaterThan(25);
  expect(allRoutes.map(pathOf)).toContain("/inbox");
  expect(allRoutes.map(pathOf)).toContain("/settings/connections");
  expect(allNewActions.length).toBeGreaterThan(4);
  expect(tabs.length).toBeGreaterThan(8);
});

describe("every route has a place in the navigation", () => {
  test("a path is registered once, or twice by a page that is a tab where the service offers one thing and a page under a tab where it offers another", () => {
    const byPath = new Map<string, typeof allRoutes>();
    for (const route of allRoutes)
      byPath.set(pathOf(route), [...(byPath.get(pathOf(route)) ?? []), route]);
    const twice = [...byPath].flatMap(([path, routes]) => {
      if (routes.length === 1) return [];
      // Two registrations of one screen are for services that cannot both be: each needs something the other's service lacks.
      const needs = routes.map((route) => route.nav.needs);
      return needs.every((need) => need !== undefined) && new Set(needs).size === routes.length
        ? []
        : [path];
    });
    expect(twice).toEqual([]);
  });

  test("every route names a real section", () => {
    const strange = allRoutes.filter((route) => !sections.includes(route.nav.section));
    expect(strange.map(pathOf)).toEqual([]);
  });

  test("every route is a tab (a label and no parent) or sits under a page (a parent), not neither", () => {
    const neither = allRoutes.filter(
      (route) => route.nav.label === undefined && route.nav.parent === undefined,
    );
    expect(
      neither.map(pathOf),
      "a route needs a section and either a label (a tab) or a parent (the page it sits under)",
    ).toEqual([]);
  });

  test("the pages with a name that sit under another page are the ones the plan names", () => {
    // Each is opened from the page it sits under, and Search lists it by its own name.
    const named = allRoutes
      .filter((route) => route.nav.label !== undefined && route.nav.parent !== undefined)
      .map((route) => `${route.nav.label} ${route.path} under ${route.nav.parent}`)
      .sort();
    expect(named).toEqual([
      "All transactions /journal under /inbox",
      "Bank accounts /settings/banks under /accounts",
      "Bring in history /settings/history under /settings/bring-in",
      "Compare with Xero /tie-out under /settings/bring-in",
      "Import from Xero /xero under /settings/bring-in",
      "Money by payee /reports/payees under /reports",
      "Move from Xero /settings/move under /settings/bring-in",
      "Reconcile /reconcile under /accounts",
      "Rules /rules under /inbox",
      "Start date and opening balances /opening under /settings/bring-in",
      "Stripe /settings/stripe under /accounts",
      "Taxes /tax under /reports",
      "Things to check /gaps under /settings/bring-in",
      "Workspace /settings/workspace under /settings",
    ]);
  });

  test("what a route needs of the service is something the page learns, and a page under a tab that needs it needs it too", () => {
    const known = [
      "accounts",
      "connections",
      "banks",
      "billing",
      "stripeApp",
      "stripe",
      "agents",
      "backups",
    ];
    const byPath = new Map(allRoutes.map((route) => [route.path, route]));
    const wrong = allRoutes.flatMap((route) => {
      const needs = route.nav.needs;
      if (needs !== undefined && !known.includes(needs))
        return [`${route.path}: needs ${needs}, which the page does not learn`];
      // A page under a tab that is left out of the navigation would be reachable from nowhere.
      const parent = route.nav.parent === undefined ? undefined : byPath.get(route.nav.parent);
      if (parent?.nav.needs !== undefined && route.nav.needs !== parent.nav.needs)
        return [`${route.path}: sits under ${route.nav.parent}, which needs ${parent.nav.needs}`];
      return [];
    });
    expect(wrong).toEqual([]);
  });

  test("a parent is a page with a name in the same section, and the parents lead up to a tab", () => {
    // A path registered twice (a tab for one service, a page under a tab for another) is found by either.
    const byPath = new Map<string, AppRoute[]>();
    for (const route of allRoutes)
      byPath.set(route.path, [...(byPath.get(route.path) ?? []), route]);
    const wrong = allRoutes.flatMap((route) => {
      const parent = route.nav.parent;
      if (parent === undefined) return [];
      const holders = byPath.get(parent) ?? [];
      if (holders.length === 0) return [`${route.path}: parent ${parent} is not a route`];
      if (!holders.some((holder) => holder.nav.label !== undefined))
        return [`${route.path}: parent ${parent} has no name`];
      if (!holders.some((holder) => holder.nav.section === route.nav.section))
        return [`${route.path}: parent ${parent} is in ${holders[0]?.nav.section}`];
      // Followed up, the parents reach a tab within a few steps (the navigation follows four).
      let at: string | undefined = parent;
      for (let hops = 0; at !== undefined && hops < 4; hops += 1) {
        const holder: AppRoute | undefined = (byPath.get(at) ?? []).find(
          (candidate) => candidate.nav.section === route.nav.section,
        );
        if (!holder) return [`${route.path}: nothing at ${at}`];
        if (isTab(holder)) return [];
        at = holder.nav.parent;
      }
      return [`${route.path}: its parents do not lead to a tab`];
    });
    expect(wrong).toEqual([]);
  });

  test("a label is a name: not empty, not padded, and used by one page only", () => {
    const labels = labelled.map((route) => route.nav.label ?? "");
    expect(labels.filter((label) => label.trim() !== label || label === "")).toEqual([]);
    const lower = labels.map((label) => label.toLowerCase());
    expect(lower.filter((label, index) => lower.indexOf(label) !== index)).toEqual([]);
  });

  test("the tabs of a section have their own order", () => {
    for (const section of sections) {
      const orders = tabs
        .filter((route) => route.nav.section === section)
        .map((route) => route.nav.order);
      expect(
        orders.every((order) => Number.isInteger(order)),
        `${section}: every tab needs an integer order`,
      ).toBe(true);
      expect(new Set(orders).size, `${section}: two tabs share an order`).toBe(orders.length);
    }
  });

  test("only a tab offers a live count", () => {
    const stray = allRoutes.filter((route) => route.nav.count !== undefined && !isTab(route));
    expect(stray.map(pathOf)).toEqual([]);
  });
});

describe("every route can be reached", () => {
  test("every section that has pages has a link in the bar (or is Settings)", () => {
    for (const section of sections) {
      if (!allRoutes.some((route) => route.nav.section === section)) continue;
      expect(
        sectionPath(navRoutes, section),
        `${section} has pages but no tab, so nothing links to it`,
      ).toBeDefined();
    }
  });

  /** What a person can get to starting from Home, without typing an address: the bar, the tabs of the
   * section they are in, the Settings list, "+ New" and Search (pages and actions), and from a page the
   * pages that sit under it. */
  function reachableFromHome(): Set<string> {
    const reached = new Set<string>(["/"]);
    // The bar goes to each section; once in a section its tabs are a row under the header (more than one)
    // or the page itself (one); Settings lists its pages. Search lists every named page.
    for (const section of sections) {
      const first = sectionPath(navRoutes, section);
      if (first === undefined) continue;
      for (const tab of tabRoutes(navRoutes, section)) reached.add(tab.path);
    }
    // "+ New" starts things at an address (the query is not a route), and Search lists them too.
    for (const action of allNewActions)
      if (action.href !== undefined) reached.add(action.href.split(/[?#]/, 1)[0] ?? "");
    // A page under another is opened from it, and so are the pages under that one.
    for (let grew = true; grew; ) {
      grew = false;
      for (const route of allRoutes)
        if (
          route.nav.parent !== undefined &&
          reached.has(route.nav.parent) &&
          !reached.has(route.path)
        ) {
          reached.add(route.path);
          grew = true;
        }
    }
    return reached;
  }

  test("starting from Home, every route is reached through the bar, + New, Search or a parent page", () => {
    const reached = reachableFromHome();
    const lost = allRoutes.map(pathOf).filter((path) => !reached.has(path));
    expect(lost, "no door leads to these routes").toEqual([]);
  });

  test("the guard can fail: a route with no section link, no tab and no parent is lost", () => {
    const withLostRoute: readonly NavRoute[] = [
      ...navRoutes,
      { path: "/checks", nav: { section: "accounts" } },
    ];
    const header = buildHeader(withLostRoute, "/checks");
    // It is no tab of any section, so no row, no list and no Search entry would ever show it.
    expect(tabRoutes(withLostRoute, "accounts").some((route) => route.path === "/checks")).toBe(
      false,
    );
    expect(header.tabs.some((tab) => tab.path === "/checks")).toBe(false);
  });

  test("every page that has a name can be found by Search, and by its own name", async () => {
    const pages = allSearchSources.find((source) => source.id === "pages");
    expect(pages).toBeDefined();
    const client = {} as never;
    const signal = new AbortController().signal;
    for (const route of labelled) {
      const hits = await pages?.search(route.nav.label ?? "", client, signal);
      expect(
        hits?.some((hit) => hit.href === route.path),
        `Search for "${route.nav.label}"`,
      ).toBe(true);
    }
  });
});

describe('"+ New" and Search', () => {
  test("an action has an id of its own, a name, and either an address or a dialog", () => {
    const ids = allNewActions.map((action) => action.id);
    expect(
      ids.filter((id, index) => ids.indexOf(id) !== index),
      "an action id is used twice",
    ).toEqual([]);
    for (const action of allNewActions) {
      expect(action.label.trim(), action.id).not.toBe("");
      expect(
        (action.href === undefined) !== (action.dialog === undefined),
        `${action.id} needs an href or a dialog, not both and not neither`,
      ).toBe(true);
    }
  });

  test("an action's address is one of the application's routes", () => {
    const paths = allRoutes.map(pathOf);
    const stray = allNewActions.flatMap((action) =>
      action.href === undefined || paths.includes(action.href.split(/[?#]/, 1)[0] ?? "")
        ? []
        : [`${action.id}: ${action.href}`],
    );
    expect(stray).toEqual([]);
  });

  test("every dialog an action names is registered, once", () => {
    const dialogs = allDialogs.map((dialog) => dialog.id);
    expect(dialogs.filter((id, index) => dialogs.indexOf(id) !== index)).toEqual([]);
    const missing = allNewActions.flatMap((action) =>
      action.dialog === undefined || dialogs.includes(action.dialog) ? [] : [action.id],
    );
    expect(missing, "actions that open a dialog nobody registered").toEqual([]);
  });

  test("+ New lists the few things started from anywhere, and Search finds the rest by name", () => {
    const listed = buildNewActions(allNewActions).map((action) => action.label);
    expect(listed).toEqual(["Transaction", "Journal entry", "Account"]);
    const searchOnly = allNewActions
      .filter((action) => action.searchOnly === true)
      .map((action) => action.label)
      .sort();
    expect(searchOnly).toEqual([
      "Bank rule",
      "Import statement",
      "Receive money",
      "Reconcile an account",
      "Spend money",
      "Transfer",
    ]);
    // No two actions share a place in the list.
    const orders = allNewActions.map((action) => action.order);
    expect(new Set(orders).size, "two actions share an order").toBe(orders.length);
  });

  test("a search source has an id and an order of its own, and the built-in ones come first", () => {
    const ids = allSearchSources.map((source) => source.id);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
    const orders = allSearchSources.map((source) => source.order);
    expect(new Set(orders).size, "two sources share an order").toBe(orders.length);
    expect(ids.slice(0, 2)).toEqual(["actions", "pages"]);
  });
});

describe("Help has a topic for the page, or the page says it has none", () => {
  test("every route is named in Help's table of pages, and the table names no page that is gone", () => {
    const routed = [...new Set(allRoutes.map(pathOf))].sort();
    const tabled = helpPages.map((page) => page.path).sort();
    expect(tabled.filter((path, index) => tabled.indexOf(path) !== index)).toEqual([]);
    expect(
      routed.filter((path) => !tabled.includes(path)),
      "a new page says which topic of Help is its own, or null, in src/routes/help/pages.ts",
    ).toEqual([]);
    expect(tabled.filter((path) => !routed.includes(path))).toEqual([]);
  });

  test("Help is on no bar and in no list of Settings: its two pages are its own section", () => {
    expect(SECTIONS.map((section) => section.id)).not.toContain("help");
    expect(
      allRoutes
        .filter((route) => route.nav.section === "help")
        .map(pathOf)
        .sort(),
    ).toEqual(["/help", "/help/$topic"]);
    const header = buildHeader(navRoutes, "/help/reconcile-an-account");
    expect(header.sections.map((section) => section.label)).toEqual([
      "Home",
      "Transactions",
      "Accounts",
      "Reports",
    ]);
    expect(header.tabs).toEqual([]);
    expect(header.settingsList).toEqual([]);
    expect(header.sections.some((section) => section.current !== undefined)).toBe(false);
  });
});

describe("the map is the plan's map", () => {
  const tabsOfSection = (section: NavSection) =>
    tabRoutes(navRoutes, section).map((route) => `${route.nav.label} ${route.path}`);

  test("the four places: Home, Transactions, Accounts and Reports", () => {
    expect(SECTIONS.map((section) => section.label)).toEqual([
      "Home",
      "Transactions",
      "Accounts",
      "Reports",
      "Settings",
    ]);
    expect(tabsOfSection("home")).toEqual(["Home /"]);
    // Transactions is one destination: its two views (For review, All) are the page's own switch, and Rules
    // is a link in its header, so it has no row of tabs. Accounts is one too: each bank and card account has
    // Reconcile on its row, so Reconcile is a page under it and not a tab. Reports is one as well: the list
    // of every report, with Money by payee and the tax tools as pages under it. No place has a row of tabs.
    expect(tabsOfSection("transactions")).toEqual(["Transactions /inbox"]);
    expect(tabsOfSection("accounts")).toEqual(["Accounts /accounts"]);
    expect(tabsOfSection("reports")).toEqual(["Reports /reports"]);
  });

  test("Settings lists its pages, with the screens that do the work under them", () => {
    // The installed application: no accounts, and a credential can be kept.
    const installed = availableRoutes(navRoutes, {
      accounts: false,
      connections: true,
      banks: false,
      stripeApp: false,
      billing: false,
      agents: true,
      backups: true,
    });
    expect(
      tabRoutes(installed, "settings").map((route) => `${route.nav.label} ${route.path}`),
    ).toEqual([
      "Business /settings",
      "Agents /settings/agent",
      "Plugins /settings/plugins",
      "Connections /settings/connections",
      "Backups and export /settings/backups",
      "Bring in your books /settings/bring-in",
      "Close the books /periods",
      "Changes /changes",
    ]);
    // A hosted service with accounts and many books: the people are listed, and no connection and no agent is offered.
    const hosted = availableRoutes(navRoutes, {
      accounts: true,
      connections: false,
      banks: false,
      stripeApp: false,
      billing: false,
      agents: false,
      backups: false,
    });
    expect(tabRoutes(hosted, "settings").map((route) => route.nav.label)).toEqual([
      "Business",
      "Members",
      "Plugins",
      "Bring in your books",
      "Close the books",
      "Changes",
    ]);
    // The service as it runs for customers: people, an agent, billing, a bank and Stripe through the
    // service's own keys. (Bank accounts and Stripe move onto the accounts in step 4 of the plan.)
    const production = availableRoutes(navRoutes, {
      accounts: true,
      connections: false,
      banks: true,
      stripeApp: true,
      billing: true,
      agents: true,
      backups: false,
    });
    expect(tabRoutes(production, "settings").map((route) => route.nav.label)).toEqual([
      "Business",
      "Members",
      "Agents",
      "Billing",
      "Plugins",
      "Bring in your books",
      "Close the books",
      "Changes",
    ]);
    const under = (parent: string) =>
      allRoutes
        .filter((route) => route.nav.parent === parent)
        .map(pathOf)
        .sort();
    expect(under("/settings/connections")).toEqual(["/settings/bankfeed", "/settings/stripe"]);
    expect(under("/settings")).toEqual(["/settings/workspace"]);
    expect(under("/settings/bring-in")).toEqual([
      "/gaps",
      "/opening",
      "/settings/history",
      "/settings/move",
      "/tie-out",
      "/xero",
    ]);
    // The old address of the month checklist is kept under Close the books, and opens it. Under Transactions: the list of every
    // transaction (the other view of the page), the rules, and importing a statement.
    expect(under("/periods")).toEqual(["/cutover"]);
    expect(under("/inbox")).toEqual(["/import", "/journal", "/rules"]);
    expect(under("/rules")).toEqual(["/rules/$ruleId", "/rules/new"]);
    expect(under("/journal")).toEqual(["/journal/$entryId", "/journal/new"]);
  });

  test("the scaffold page /checks is gone", () => {
    expect(allRoutes.map(pathOf)).not.toContain("/checks");
  });
});

describe("the router and the registry agree", () => {
  // The application's own screens are written out in the router so their paths and parameters are typed
  // (a `navigate({ to: "/journal" })` is checked); routes/core.ts says where each sits in the navigation.
  // The two lists must be the same.
  const pathsIn = (file: string): string[] =>
    [...readFileSync(file, "utf8").matchAll(/\bpath:\s*"(\/[^"]*)"/g)].map(
      (match) => match[1] as string,
    );
  const source = join(import.meta.dir, "..", "..", "src");

  test("routes/core.ts registers exactly the routes the router writes out", () => {
    const core = pathsIn(join(source, "routes", "core.ts")).sort();
    const router = pathsIn(join(source, "router.tsx")).sort();
    expect(router).toEqual(core);
  });
});

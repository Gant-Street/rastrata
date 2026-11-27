import { describe, expect, test } from "bun:test";
import {
  availableRoutes,
  buildHeader,
  buildNewActions,
  matchRoute,
  namedRoutes,
  type NavRoute,
  normalizePath,
  pageNameOf,
  sectionPath,
  tabRoutes,
  whereIs,
} from "../../src/nav";
import type { NewAction } from "../../src/routes/registry-types";

// A small map in the shape of the real one: sections, tabs (a label and no parent), pages under them (a
// parent), some of which have a name of their own (a label and a parent).
const routes: readonly NavRoute[] = [
  { path: "/", nav: { section: "home", label: "Home", order: 0 } },
  { path: "/reports", nav: { section: "reports", label: "Reports", order: 10 } },
  { path: "/rules", nav: { section: "transactions", label: "Rules", order: 30 } },
  { path: "/rules/new", nav: { section: "transactions", parent: "/rules" } },
  { path: "/rules/$ruleId", nav: { section: "transactions", parent: "/rules" } },
  { path: "/inbox", nav: { section: "transactions", label: "For review", order: 10 } },
  { path: "/import", nav: { section: "transactions", parent: "/inbox" } },
  { path: "/journal", nav: { section: "transactions", label: "All transactions", order: 20 } },
  { path: "/journal/new", nav: { section: "transactions", parent: "/journal" } },
  { path: "/journal/$entryId", nav: { section: "transactions", parent: "/journal" } },
  { path: "/accounts", nav: { section: "accounts", label: "Chart of accounts", order: 10 } },
  { path: "/ledger", nav: { section: "accounts", parent: "/accounts" } },
  { path: "/reconcile", nav: { section: "accounts", label: "Reconcile", order: 20 } },
  { path: "/reconcile/$id", nav: { section: "accounts", parent: "/reconcile" } },
  { path: "/settings", nav: { section: "settings", label: "Business", order: 10 } },
  {
    path: "/settings/workspace",
    nav: { section: "settings", label: "Workspace", parent: "/settings" },
  },
  { path: "/settings/connections", nav: { section: "settings", label: "Connections", order: 54 } },
  { path: "/settings/stripe", nav: { section: "settings", parent: "/settings/connections" } },
  {
    path: "/settings/bring-in",
    nav: { section: "settings", label: "Bring in your books", order: 60 },
  },
  {
    path: "/settings/move",
    nav: { section: "settings", label: "Move from Xero", parent: "/settings/bring-in" },
  },
  { path: "/xero", nav: { section: "settings", parent: "/settings/move" } },
];

describe("which route is an address", () => {
  test("a path is read without its query, its fragment or a trailing slash", () => {
    expect(normalizePath("/inbox?item=a#top")).toBe("/inbox");
    expect(normalizePath("/inbox/")).toBe("/inbox");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("/?x=1")).toBe("/");
  });

  test("a route with a parameter takes any one segment, and the fixed path wins where both fit", () => {
    expect(matchRoute(routes, "/reconcile/abc")?.path).toBe("/reconcile/$id");
    expect(matchRoute(routes, "/journal/new")?.path).toBe("/journal/new");
    expect(matchRoute(routes, "/journal/9f3a")?.path).toBe("/journal/$entryId");
    expect(matchRoute(routes, "/rules/new")?.path).toBe("/rules/new");
    expect(matchRoute(routes, "/rules/rule-1")?.path).toBe("/rules/$ruleId");
  });

  test("an address that is no route, or has too many or too few segments, is not found", () => {
    expect(matchRoute(routes, "/missing")).toBeUndefined();
    expect(matchRoute(routes, "/reconcile/a/b")).toBeUndefined();
    expect(matchRoute(routes, "/journal/new/more")).toBeUndefined();
  });
});

describe("the tabs of a section", () => {
  test("only routes with a label and no parent are tabs, in order", () => {
    expect(tabRoutes(routes, "transactions").map((route) => route.nav.label)).toEqual([
      "For review",
      "All transactions",
      "Rules",
    ]);
    expect(tabRoutes(routes, "accounts").map((route) => route.nav.label)).toEqual([
      "Chart of accounts",
      "Reconcile",
    ]);
    expect(tabRoutes(routes, "reports").map((route) => route.path)).toEqual(["/reports"]);
    // A page with a name that is opened from another page is no tab, and no entry of the Settings list.
    expect(tabRoutes(routes, "settings").map((route) => route.nav.label)).toEqual([
      "Business",
      "Connections",
      "Bring in your books",
    ]);
  });

  test("the named pages of a section are its tabs, then the named pages under them", () => {
    expect(namedRoutes(routes, "settings").map((route) => route.nav.label)).toEqual([
      "Business",
      "Connections",
      "Bring in your books",
      "Move from Xero",
      "Workspace",
    ]);
    expect(namedRoutes(routes, "transactions").map((route) => route.path)).toEqual([
      "/inbox",
      "/journal",
      "/rules",
    ]);
  });

  test("a section's link goes to its first tab, and a section with no tab has none", () => {
    expect(sectionPath(routes, "transactions")).toBe("/inbox");
    expect(sectionPath(routes, "accounts")).toBe("/accounts");
    expect(sectionPath(routes, "home")).toBe("/");
    expect(sectionPath([], "transactions")).toBeUndefined();
  });

  test("a screen two lanes register is one tab, under the first registration in order", () => {
    const twice: readonly NavRoute[] = [
      { path: "/import", nav: { section: "transactions", label: "Import", order: 20 } },
      { path: "/import", nav: { section: "transactions", label: "Statements", order: 25 } },
    ];
    expect(tabRoutes(twice, "transactions").map((route) => route.nav.label)).toEqual(["Import"]);
  });

  test("two tabs with the same order are told apart by their names, so the order is stable", () => {
    const tied: readonly NavRoute[] = [
      { path: "/b", nav: { section: "accounts", label: "Beta", order: 70 } },
      { path: "/a", nav: { section: "accounts", label: "Alpha", order: 70 } },
    ];
    expect(tabRoutes(tied, "accounts").map((route) => route.nav.label)).toEqual(["Alpha", "Beta"]);
  });
});

describe("where the person is", () => {
  test("a tab is its own page; a detail page sits under the tab it names", () => {
    expect(whereIs(routes, "/rules")).toMatchObject({
      section: "transactions",
      tab: "/rules",
      onTab: true,
    });
    expect(whereIs(routes, "/rules/new")).toMatchObject({
      section: "transactions",
      tab: "/rules",
      onTab: false,
    });
    expect(whereIs(routes, "/import")).toMatchObject({ tab: "/inbox", onTab: false });
    expect(whereIs(routes, "/ledger")).toMatchObject({ section: "accounts", tab: "/accounts" });
  });

  test("a detail page under another detail page follows the parents up to a tab", () => {
    const chained: readonly NavRoute[] = [
      { path: "/a", nav: { section: "accounts", label: "A", order: 1 } },
      { path: "/a/b", nav: { section: "accounts", parent: "/a" } },
      { path: "/a/b/c", nav: { section: "accounts", parent: "/a/b" } },
    ];
    expect(whereIs(chained, "/a/b/c")).toMatchObject({ tab: "/a", onTab: false });
  });

  test("a page with a name that sits under a tab is not the tab, and the pages under it follow it up", () => {
    expect(whereIs(routes, "/settings/move")).toMatchObject({
      section: "settings",
      tab: "/settings/bring-in",
      onTab: false,
    });
    expect(whereIs(routes, "/xero")).toMatchObject({ tab: "/settings/bring-in", onTab: false });
    expect(whereIs(routes, "/settings/workspace")).toMatchObject({ tab: "/settings" });
  });

  test("a page is called by its own name, or by the tab it sits under when it has none", () => {
    const name = (address: string) => pageNameOf(routes, whereIs(routes, address));
    expect(name("/inbox")).toBe("For review");
    expect(name("/settings/move")).toBe("Move from Xero");
    expect(name("/journal/abc")).toBe("All transactions");
    // A page with no name of its own is called by the nearest page above it that has one.
    expect(name("/xero")).toBe("Move from Xero");
    expect(name("/rules/new")).toBe("Rules");
    expect(name("/import")).toBe("For review");
    expect(name("/nowhere")).toBeUndefined();
  });

  test("an address that is not a page has no section", () => {
    expect(whereIs(routes, "/nowhere")).toMatchObject({
      route: undefined,
      section: undefined,
      tab: undefined,
    });
  });
});

describe("the header", () => {
  test("the bar lists the four places, Settings apart", () => {
    const header = buildHeader(routes, "/");
    expect(header.sections.map((entry) => entry.label)).toEqual([
      "Home",
      "Transactions",
      "Accounts",
      "Reports",
    ]);
    expect(header.sections.map((entry) => entry.path)).toEqual([
      "/",
      "/inbox",
      "/accounts",
      "/reports",
    ]);
    expect(header.settings).toMatchObject({ label: "Settings", path: "/settings" });
  });

  test("on a section's landing page it is the page; on another of its pages it is held; elsewhere it is not marked", () => {
    const onLanding = buildHeader(routes, "/inbox").sections;
    expect(onLanding.find((entry) => entry.id === "transactions")?.current).toBe("page");
    expect(onLanding.find((entry) => entry.id === "accounts")?.current).toBeUndefined();
    const onRules = buildHeader(routes, "/rules").sections;
    expect(onRules.find((entry) => entry.id === "transactions")?.current).toBe("true");
    const onDetail = buildHeader(routes, "/reconcile/abc").sections;
    expect(onDetail.find((entry) => entry.id === "accounts")?.current).toBe("true");
    expect(buildHeader(routes, "/").sections[0]?.current).toBe("page");
    expect(buildHeader(routes, "/").sections[1]?.current).toBeUndefined();
  });

  test("a section with several pages has a row of tabs, with the one you are on marked", () => {
    const header = buildHeader(routes, "/rules");
    expect(header.tabsOf).toBe("transactions");
    expect(header.tabs.map((tab) => [tab.label, tab.current])).toEqual([
      ["For review", undefined],
      ["All transactions", undefined],
      ["Rules", "page"],
    ]);
  });

  test("a detail page keeps its tab marked as held, not as the page", () => {
    const header = buildHeader(routes, "/reconcile/abc");
    expect(header.tabs.find((tab) => tab.path === "/reconcile")?.current).toBe("true");
    expect(header.tabs.find((tab) => tab.path === "/accounts")?.current).toBeUndefined();
    expect(buildHeader(routes, "/import").tabs.find((tab) => tab.path === "/inbox")?.current).toBe(
      "true",
    );
  });

  test("Home and Reports have one page each, so no row of tabs", () => {
    for (const path of ["/", "/reports"]) expect(buildHeader(routes, path).tabs).toEqual([]);
  });

  test("what waits on the page a section opens is said beside the section, once: its tab carries no number", () => {
    const counted = buildHeader(routes, "/inbox", { "/inbox": 8, "/rules": 2 });
    expect(counted.sections.find((entry) => entry.id === "transactions")?.count).toBe(8);
    expect(counted.sections.find((entry) => entry.id === "accounts")).not.toHaveProperty("count");
    expect(counted.tabs.find((tab) => tab.path === "/inbox")).not.toHaveProperty("count");
    // A count of a page that is not where the section opens stays on its tab.
    expect(counted.tabs.find((tab) => tab.path === "/rules")?.count).toBe(2);
    // It is shown only once it is read.
    expect(
      buildHeader(routes, "/inbox").sections.find((entry) => entry.id === "transactions"),
    ).not.toHaveProperty("count");
    // Zero is a number: the bar shows nothing for it (AppNav), the header does not hide it.
    expect(
      buildHeader(routes, "/", { "/inbox": 0 }).sections.find(
        (entry) => entry.id === "transactions",
      )?.count,
    ).toBe(0);
  });

  test("Settings has a list of its pages, and the pages under them keep the list's entry marked", () => {
    const header = buildHeader(routes, "/settings/stripe");
    expect(header.tabs).toEqual([]);
    expect(header.settings?.current).toBe("true");
    expect(header.settingsList.map((entry) => [entry.label, entry.current])).toEqual([
      ["Business", undefined],
      ["Connections", "true"],
      ["Bring in your books", undefined],
    ]);
    expect(buildHeader(routes, "/settings").settings?.current).toBe("page");
    // A named page under an entry, and the pages under that, keep the entry marked.
    expect(buildHeader(routes, "/settings/move").settingsList.at(-1)?.current).toBe("true");
    expect(buildHeader(routes, "/xero").settingsList.at(-1)?.current).toBe("true");
    expect(buildHeader(routes, "/settings/workspace").settingsList[0]?.current).toBe("true");
    expect(buildHeader(routes, "/inbox").settingsList).toEqual([]);
  });

  test("a section nobody registered a page for is not in the bar", () => {
    const header = buildHeader(
      routes.filter((route) => route.nav.section !== "reports"),
      "/",
    );
    expect(header.sections.map((entry) => entry.label)).toEqual([
      "Home",
      "Transactions",
      "Accounts",
    ]);
  });

  test("an address the app does not know marks nothing", () => {
    const header = buildHeader(routes, "/missing/nested");
    expect(header.sections.every((entry) => entry.current === undefined)).toBe(true);
    expect(header.tabs).toEqual([]);
    expect(header.settingsList).toEqual([]);
  });

  test("nothing registered is an empty navigation, not an error", () => {
    const header = buildHeader([], "/");
    expect(header.sections).toEqual([]);
    expect(header.settings).toBeUndefined();
    expect(header.tabs).toEqual([]);
  });
});

describe("+ New", () => {
  const action = (id: string, order: number, extra: Partial<NewAction> = {}): NewAction => ({
    id,
    label: id.replace(/-/g, " "),
    order,
    ...extra,
  });

  test("the actions are one list in order, without the ones that are for Search only", () => {
    const list = buildNewActions([
      action("bank-rule", 80, { href: "/rules/new", searchOnly: true }),
      action("spend", 20, { dialog: "spend" }),
      action("journal-entry", 40, { href: "/journal/new" }),
      action("receive", 10, { dialog: "receive" }),
      action("import-statement", 60, { href: "/import", searchOnly: true }),
    ]);
    expect(list.map((entry) => entry.id)).toEqual(["receive", "spend", "journal-entry"]);
  });

  test("a destination carries its address and a dialog carries none", () => {
    const [spend, account] = buildNewActions([
      action("spend", 20, { dialog: "spend" }),
      action("account", 50, { href: "/accounts?new=1" }),
    ]);
    expect(spend).toEqual({ id: "spend", label: "spend" });
    expect(account).toEqual({ id: "account", label: "account", href: "/accounts?new=1" });
  });

  test("an action registered twice is listed once, and nothing registered is no list", () => {
    const list = buildNewActions([
      action("account", 50, { href: "/accounts?new=1" }),
      action("account", 55, { href: "/somewhere-else" }),
    ]);
    expect(list).toEqual([{ id: "account", label: "account", href: "/accounts?new=1" }]);
    expect(buildNewActions([])).toEqual([]);
  });
});

describe("the routes a service can back", () => {
  const mixed: readonly NavRoute[] = [
    { path: "/settings", nav: { section: "settings", label: "Business", order: 10 } },
    {
      path: "/settings/members",
      nav: { section: "settings", label: "Members", order: 20, needs: "accounts" },
    },
    {
      path: "/settings/connections",
      nav: { section: "settings", label: "Connections", order: 30, needs: "connections" },
    },
    {
      path: "/settings/stripe",
      nav: { section: "settings", parent: "/settings/connections", needs: "connections" },
    },
    {
      path: "/settings/agent",
      nav: { section: "settings", label: "Agents", order: 50, needs: "agents" },
    },
  ];
  const paths = (list: readonly NavRoute[]) => list.map((route) => route.path);

  test("a route that needs what the service lacks is left out, and one that needs nothing never is", () => {
    // The installed application: no accounts, a credential can be kept.
    expect(
      paths(
        availableRoutes(mixed, {
          accounts: false,
          connections: true,
          banks: false,
          stripeApp: false,
          billing: false,
          agents: true,
          backups: true,
        }),
      ),
    ).toEqual(["/settings", "/settings/connections", "/settings/stripe", "/settings/agent"]);
    // A hosted service with accounts and many books: people, and no connection and no agent.
    expect(
      paths(
        availableRoutes(mixed, {
          accounts: true,
          connections: false,
          banks: false,
          stripeApp: false,
          billing: false,
          agents: false,
          backups: false,
        }),
      ),
    ).toEqual(["/settings", "/settings/members"]);
    expect(
      paths(
        availableRoutes(mixed, {
          accounts: true,
          connections: true,
          banks: false,
          stripeApp: false,
          billing: false,
          agents: true,
          backups: true,
        }),
      ),
    ).toEqual(paths(mixed));
  });

  test("the navigation built from them lists only what is there", () => {
    const header = buildHeader(
      availableRoutes(mixed, {
        accounts: true,
        connections: false,
        banks: false,
        stripeApp: false,
        billing: false,
        agents: false,
        backups: false,
      }),
      "/settings",
    );
    expect(header.settingsList.map((tab) => tab.label)).toEqual(["Business", "Members"]);
  });
});

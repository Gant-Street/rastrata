import { describe, expect, test } from "bun:test";
import type { BrowserApplicationClient } from "../../src/application-client";
import type { NavRoute } from "../../src/nav";
import { actionHits, builtinSources, matchScore, pageHits } from "../../src/search/builtin";
import {
  type Clock,
  MOST_HITS_PER_SOURCE,
  SearchSession,
  type SourceResult,
} from "../../src/search/engine";
import type { NewAction, SearchHit, SearchSource } from "../../src/routes/registry-types";

const routes: readonly NavRoute[] = [
  { path: "/", nav: { section: "home", label: "Home", order: 0 } },
  {
    path: "/inbox",
    nav: {
      section: "transactions",
      label: "For review",
      order: 10,
      keywords: ["inbox", "bank transactions"],
    },
  },
  {
    path: "/journal",
    nav: { section: "transactions", label: "All transactions", order: 20, keywords: ["journal"] },
  },
  {
    path: "/rules",
    nav: { section: "transactions", label: "Rules", order: 30, keywords: ["bank rules"] },
  },
  { path: "/rules/new", nav: { section: "transactions", parent: "/rules" } },
  {
    path: "/reconcile",
    nav: { section: "accounts", label: "Reconcile", order: 20, keywords: ["statement"] },
  },
  {
    path: "/reports",
    nav: { section: "reports", label: "Reports", order: 10, keywords: ["profit and loss"] },
  },
  { path: "/settings", nav: { section: "settings", label: "Business", order: 10 } },
  {
    path: "/settings/bring-in",
    nav: { section: "settings", label: "Bring in your books", order: 60 },
  },
  {
    path: "/settings/move",
    nav: {
      section: "settings",
      label: "Move from Xero",
      parent: "/settings/bring-in",
      keywords: ["migrate"],
    },
  },
  {
    path: "/periods",
    nav: {
      section: "settings",
      label: "Close the books",
      order: 70,
      keywords: ["lock", "cutover"],
    },
  },
];

const actions: readonly NewAction[] = [
  { id: "spend", label: "Spend money", order: 20, dialog: "spend" },
  { id: "journal-entry", label: "Journal entry", order: 40, href: "/journal/new" },
  {
    id: "reconcile-account",
    label: "Reconcile an account",
    order: 70,
    href: "/reconcile",
    searchOnly: true,
  },
  { id: "bank-rule", label: "Bank rule", order: 80, href: "/rules/new", searchOnly: true },
];

describe("how well a question fits a name", () => {
  test("every word of the question must start a word of the name or of a keyword", () => {
    expect(matchScore("rec", "Reconcile")).toBeGreaterThan(0);
    expect(matchScore("close books", "Close the books")).toBeGreaterThan(0);
    expect(matchScore("clo boo", "Close the books")).toBeGreaterThan(0);
    expect(matchScore("books close", "Close the books")).toBeGreaterThan(0);
    expect(matchScore("reconcile zzz", "Reconcile")).toBe(0);
    expect(matchScore("onc", "Reconcile")).toBe(0);
  });

  test("a name beats a keyword, and the start of the name beats a later word", () => {
    const name = matchScore("rep", "Reports", ["profit and loss"]);
    const keyword = matchScore("pro", "Reports", ["profit and loss"]);
    expect(name).toBeGreaterThan(keyword);
    expect(keyword).toBeGreaterThan(0);
    expect(matchScore("books", "Close the books")).toBeLessThan(
      matchScore("close", "Close the books"),
    );
  });

  test("the empty question fits everything equally, and case and punctuation do not matter", () => {
    expect(matchScore("", "Anything")).toBe(1);
    expect(matchScore("   ", "Anything")).toBe(1);
    expect(matchScore("RECONCILE!", "reconcile")).toBeGreaterThan(0);
    // Punctuation separates words, so "p&l" is "p" and "l": the start of "profit" and of "loss".
    expect(matchScore("p&l", "Reports", ["profit and loss"])).toBeGreaterThan(0);
  });
});

describe("the pages and the actions", () => {
  test("nothing typed lists every page in the order of the bar, with its section", () => {
    const hits = pageHits(routes, "");
    expect(hits.map((hit) => hit.label)).toEqual([
      "Home",
      "For review",
      "All transactions",
      "Rules",
      "Reconcile",
      "Reports",
      "Business",
      "Bring in your books",
      "Close the books",
      "Move from Xero",
    ]);
    expect(hits.find((hit) => hit.label === "For review")).toMatchObject({
      href: "/inbox",
      detail: "Transactions",
      kind: "page",
    });
  });

  test("a page with no name is not listed, and a named page under another is, after its section's tabs", () => {
    expect(pageHits(routes, "").some((hit) => hit.href === "/rules/new")).toBe(false);
    expect(pageHits(routes, "").find((hit) => hit.label === "Move from Xero")).toMatchObject({
      href: "/settings/move",
      detail: "Settings",
    });
  });

  test("a page is found by the words people use for it", () => {
    expect(pageHits(routes, "inbox").map((hit) => hit.label)).toEqual(["For review"]);
    expect(pageHits(routes, "lock").map((hit) => hit.label)).toEqual(["Close the books"]);
    expect(pageHits(routes, "xero").map((hit) => hit.label)).toEqual(["Move from Xero"]);
    expect(pageHits(routes, "profit").map((hit) => hit.label)).toEqual(["Reports"]);
    expect(pageHits(routes, "nothing like this")).toEqual([]);
  });

  test("the best match comes first: a name beats a keyword", () => {
    // "rules" is the name of Rules and a keyword ("bank rules") of nothing else; "bank" is a keyword of
    // two pages and the name of none.
    expect(pageHits(routes, "rul")[0]?.label).toBe("Rules");
    expect(pageHits(routes, "bank").map((hit) => hit.label)).toEqual(["For review", "Rules"]);
  });

  test("an action is found by its name, whether + New lists it or only Search does", () => {
    expect(actionHits(actions, "spend")).toEqual([
      { id: "spend", label: "Spend money", kind: "action", dialog: "spend" },
    ]);
    expect(actionHits(actions, "rec")).toEqual([
      {
        id: "reconcile-account",
        label: "Reconcile an account",
        kind: "action",
        href: "/reconcile",
      },
    ]);
    expect(actionHits(actions, "").map((hit) => hit.id)).toEqual([
      "spend",
      "journal-entry",
      "reconcile-account",
      "bank-rule",
    ]);
  });

  test("an action registered twice is found once", () => {
    expect(actionHits([...actions, ...actions], "").map((hit) => hit.id)).toEqual([
      "spend",
      "journal-entry",
      "reconcile-account",
      "bank-rule",
    ]);
  });

  test("the built-in sources answer from memory, in a group each", async () => {
    const [actionSource, pageSource] = builtinSources(routes, actions);
    expect(actionSource?.instant).toBe(true);
    expect(pageSource?.instant).toBe(true);
    expect([actionSource?.label, pageSource?.label]).toEqual(["Actions", "Pages"]);
    expect((actionSource?.order ?? 0) < (pageSource?.order ?? 0)).toBe(true);
    const client = {} as BrowserApplicationClient;
    const signal = new AbortController().signal;
    expect((await pageSource?.search("report", client, signal))?.map((hit) => hit.label)).toEqual([
      "Reports",
    ]);
  });
});

// ---- A session of questions -------------------------------------------------------------------------------------

/** Timers a test drives by hand. */
function fakeClock() {
  let next = 1;
  const timers = new Map<number, { run: () => void; ms: number }>();
  const clock: Clock = {
    setTimer: (run, ms) => {
      const id = next++;
      timers.set(id, { run, ms });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  };
  return {
    clock,
    pending: () => timers.size,
    /** Run every timer that is waiting. */
    flush: () => {
      for (const [id, timer] of [...timers]) {
        timers.delete(id);
        timer.run();
      }
    },
  };
}

interface Deferred {
  resolve(hits: readonly SearchHit[]): void;
  reject(error: unknown): void;
  signal: AbortSignal;
  query: string;
}

/** A source that answers when the test says so. */
function slowSource(id: string, order: number, asked: Deferred[]): SearchSource {
  return {
    id,
    label: id,
    order,
    search: (query, _client, signal) =>
      new Promise((resolve, reject) => {
        asked.push({ resolve, reject, signal, query });
      }),
  };
}

const hit = (id: string): SearchHit => ({ id, label: id, href: `/${id}`, kind: "transaction" });
const client = {} as BrowserApplicationClient;
const settle = () => new Promise((done) => setTimeout(done, 0));

describe("a search session", () => {
  test("a source that answers from memory is asked at once; the others wait for a pause in typing", async () => {
    const fake = fakeClock();
    const asked: Deferred[] = [];
    const seen: (readonly SourceResult[])[] = [];
    const instant: SearchSource = {
      id: "pages",
      label: "Pages",
      order: 20,
      instant: true,
      search: async (query) => [hit(`page-${query}`)],
    };
    const session = new SearchSession({
      sources: [instant, slowSource("transactions", 40, asked)],
      client,
      clock: fake.clock,
      debounceMs: 150,
      onChange: (results) => seen.push(results),
    });
    session.ask("lin");
    await settle();
    // Pages answered; transactions has not even been asked.
    expect(asked).toHaveLength(0);
    const last = seen.at(-1) ?? [];
    expect(last.map((group) => [group.id, group.state])).toEqual([
      ["pages", "ready"],
      ["transactions", "loading"],
    ]);
    expect(last[0]?.hits.map((entry) => entry.id)).toEqual(["page-lin"]);
    fake.flush();
    expect(asked.map((entry) => entry.query)).toEqual(["lin"]);
  });

  test("typing on abandons the last question: its timer is cleared, its read aborted, its answer ignored", async () => {
    const fake = fakeClock();
    const asked: Deferred[] = [];
    const seen: (readonly SourceResult[])[] = [];
    const session = new SearchSession({
      sources: [slowSource("transactions", 40, asked)],
      client,
      clock: fake.clock,
      onChange: (results) => seen.push(results),
    });
    session.ask("l");
    expect(fake.pending()).toBe(1);
    session.ask("li");
    // The first timer was cleared and replaced: still one question waiting, and nothing asked yet.
    expect(fake.pending()).toBe(1);
    expect(asked).toHaveLength(0);
    fake.flush();
    expect(asked.map((entry) => entry.query)).toEqual(["li"]);
    session.ask("lin");
    // The read for "li" is told to stop, and if it answers anyway it is not shown.
    expect(asked[0]?.signal.aborted).toBe(true);
    asked[0]?.resolve([hit("stale")]);
    await settle();
    expect(seen.at(-1)?.[0]?.hits).toEqual([]);
    fake.flush();
    asked[1]?.resolve([hit("fresh")]);
    await settle();
    expect(seen.at(-1)?.[0]).toMatchObject({ state: "ready" });
    expect(seen.at(-1)?.[0]?.hits.map((entry) => entry.id)).toEqual(["fresh"]);
  });

  test("a source that fails or throws is a failed group and never holds the others", async () => {
    const fake = fakeClock();
    const asked: Deferred[] = [];
    const seen: (readonly SourceResult[])[] = [];
    const broken: SearchSource = {
      id: "accounts",
      label: "Accounts",
      order: 50,
      search: () => {
        throw new Error("no");
      },
    };
    const session = new SearchSession({
      sources: [slowSource("transactions", 40, asked), broken],
      client,
      clock: fake.clock,
      onChange: (results) => seen.push(results),
    });
    session.ask("x");
    fake.flush();
    asked[0]?.reject(new Error("offline"));
    await settle();
    expect((seen.at(-1) ?? []).map((group) => [group.id, group.state])).toEqual([
      ["transactions", "error"],
      ["accounts", "error"],
    ]);
  });

  test("groups come back in the order the sources ask for, whatever order they answer in", async () => {
    const fake = fakeClock();
    const asked: Deferred[] = [];
    const seen: (readonly SourceResult[])[] = [];
    const session = new SearchSession({
      sources: [slowSource("late", 60, asked), slowSource("early", 30, asked)],
      client,
      clock: fake.clock,
      onChange: (results) => seen.push(results),
    });
    session.ask("x");
    fake.flush();
    // "early" is the second one asked; answer it first.
    asked[1]?.resolve([hit("one")]);
    await settle();
    expect((seen.at(-1) ?? []).map((group) => group.id)).toEqual(["early", "late"]);
    asked[0]?.resolve([hit("two")]);
    await settle();
    expect((seen.at(-1) ?? []).map((group) => group.state)).toEqual(["ready", "ready"]);
  });

  test("the empty question asks everything at once, and a source shows only a handful", async () => {
    const fake = fakeClock();
    const asked: Deferred[] = [];
    const seen: (readonly SourceResult[])[] = [];
    const session = new SearchSession({
      sources: [slowSource("transactions", 40, asked)],
      client,
      clock: fake.clock,
      onChange: (results) => seen.push(results),
    });
    session.ask("");
    // No waiting for a pause: the list that opens the dialog is asked for now.
    expect(fake.pending()).toBe(0);
    expect(asked.map((entry) => entry.query)).toEqual([""]);
    asked[0]?.resolve(Array.from({ length: 20 }, (_, index) => hit(`h${index}`)));
    await settle();
    expect(seen.at(-1)?.[0]?.hits).toHaveLength(MOST_HITS_PER_SOURCE);
  });

  test("closing stops everything and forgets the results", async () => {
    const fake = fakeClock();
    const asked: Deferred[] = [];
    const seen: (readonly SourceResult[])[] = [];
    const session = new SearchSession({
      sources: [slowSource("transactions", 40, asked)],
      client,
      clock: fake.clock,
      onChange: (results) => seen.push(results),
    });
    session.ask("x");
    fake.flush();
    session.close();
    expect(asked[0]?.signal.aborted).toBe(true);
    expect(seen.at(-1)).toEqual([]);
    asked[0]?.resolve([hit("late")]);
    await settle();
    expect(seen.at(-1)).toEqual([]);
    expect(fake.pending()).toBe(0);
  });

  test("a question made of spaces is asked as nothing typed", async () => {
    const fake = fakeClock();
    const asked: Deferred[] = [];
    const session = new SearchSession({
      sources: [slowSource("transactions", 40, asked)],
      client,
      clock: fake.clock,
      onChange: () => undefined,
    });
    session.ask("   ");
    expect(asked.map((entry) => entry.query)).toEqual([""]);
  });
});

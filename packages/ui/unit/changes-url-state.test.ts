import { describe, expect, test } from "bun:test";
import {
  addDays,
  type ChangesScreenState,
  DEFAULT_STATE,
  filtersActive,
  GROUP_KINDS,
  makerFilter,
  PAGE_SIZE,
  parseState,
  queryOf,
  SEARCH_MAX,
  sameState,
  sinceInput,
  stateSearch,
  WHAT_GROUPS,
} from "../src/changes/url-state";

const TODAY = "2026-04-02";

describe("the screen's state round-trips through its address", () => {
  const states: ChangesScreenState[] = [
    DEFAULT_STATE,
    { ...DEFAULT_STATE, since: "close" },
    { ...DEFAULT_STATE, since: "all", what: "entries" },
    { ...DEFAULT_STATE, since: "2026-03-19", who: "agent@tok_7f3a91c2", page: 3 },
    { ...DEFAULT_STATE, who: "person:accountant", text: "monthly rent" },
    { ...DEFAULT_STATE, who: "unknown", what: "access", text: "a & b? c=d", page: 12 },
  ];
  for (const state of states)
    test(JSON.stringify(state), () => {
      const search = stateSearch(state);
      expect(parseState(search)).toEqual(state);
      expect(parseState(search.replace(/^\?/, ""))).toEqual(state);
    });

  test("the default state has no address of its own, and only what differs is written", () => {
    expect(stateSearch(DEFAULT_STATE)).toBe("");
    expect(stateSearch({ ...DEFAULT_STATE, what: "rules" })).toBe("?what=rules");
    expect(stateSearch({ ...DEFAULT_STATE, page: 1 })).toBe("");
    expect(stateSearch({ ...DEFAULT_STATE, since: "week", page: 2 })).toBe("?since=week&page=2");
  });
});

describe("an address that names something that does not exist is answered with the default", () => {
  test("since", () => {
    for (const bad of ["", "bogus", "2026-02-30", "2026-13-01", "20260101", "__proto__", "LOOK"])
      expect(parseState(`since=${bad}`).since).toBe("look");
    expect(parseState("since=2024-02-29").since).toBe("2024-02-29");
    expect(parseState("since=week").since).toBe("week");
  });

  test("who", () => {
    for (const bad of [
      "everyone",
      "agent@",
      "agent:",
      "Agent",
      "agent@a b",
      "robot:x",
      "__proto__",
    ])
      expect(parseState(`who=${encodeURIComponent(bad)}`).who).toBe("");
    expect(parseState("who=agent").who).toBe("agent");
    expect(parseState("who=person@user_0000000003").who).toBe("person@user_0000000003");
    expect(parseState(`who=${encodeURIComponent("agent:weekly run")}`).who).toBe(
      "agent:weekly run",
    );
  });

  test("what", () => {
    for (const bad of ["everything", "Entries", "", "__proto__", "entries,rules"])
      expect(parseState(`what=${encodeURIComponent(bad)}`).what).toBe("");
    for (const group of WHAT_GROUPS) expect(parseState(`what=${group}`).what).toBe(group);
  });

  test("the page is a whole number from 1", () => {
    for (const bad of ["0", "-1", "abc", "1.5", "9999999", "01", ""])
      expect(parseState(`page=${bad}`).page).toBe(1);
    expect(parseState("page=7").page).toBe(7);
  });

  test("the words are plain, short and one line", () => {
    expect(parseState(`q=${encodeURIComponent("  monthly \n\t rent  ")}`).text).toBe(
      "monthly rent",
    );
    expect(parseState(`q=${"x".repeat(SEARCH_MAX + 50)}`).text).toHaveLength(SEARCH_MAX);
  });
});

describe("dates are worked out by arithmetic", () => {
  test("a day before and after, across months, years and leap days", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
    expect(addDays("2100-03-01", -1)).toBe("2100-02-28");
    expect(addDays("2000-03-01", -1)).toBe("2000-02-29");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-04-02", -7)).toBe("2026-03-26");
    expect(addDays("2026-04-02", -30)).toBe("2026-03-03");
    expect(addDays("2026-04-02", 0)).toBe("2026-04-02");
  });

  test("it agrees with the calendar over thousands of days", () => {
    const start = Date.UTC(2023, 5, 17);
    for (let days = -4000; days <= 4000; days += 37) {
      const expected = new Date(start + days * 86_400_000).toISOString().slice(0, 10);
      expect(addDays("2023-06-17", days)).toBe(expected);
    }
  });

  test("a text that is not a date is left as it is", () => {
    expect(addDays("soon", 3)).toBe("soon");
    expect(addDays("2026-02-30", 1)).toBe("2026-02-30");
  });
});

describe("what to ask the service", () => {
  test("where the list starts", () => {
    expect(sinceInput("look", TODAY)).toBe("lastReview");
    expect(sinceInput("close", TODAY)).toBe("lastClose");
    expect(sinceInput("week", TODAY)).toBe("2026-03-26");
    expect(sinceInput("month", TODAY)).toBe("2026-03-03");
    expect(sinceInput("year", TODAY)).toBe("2026-01-01");
    expect(sinceInput("all", TODAY)).toBeUndefined();
    expect(sinceInput("2025-12-25", TODAY)).toBe("2025-12-25");
    expect(sinceInput("nonsense", TODAY)).toBe("lastReview");
  });

  test("the default is everything since the last look, a page of 25", () => {
    expect(queryOf(DEFAULT_STATE, TODAY)).toEqual({ since: "lastReview", pageSize: PAGE_SIZE });
    expect(PAGE_SIZE).toBe(25);
  });

  test("every choice is passed on, and only the ones made", () => {
    expect(
      queryOf({ since: "all", who: "agent@tok_1", what: "entries", text: "rent", page: 1 }, TODAY),
    ).toEqual({
      kinds: ["entry.posted", "entry.reversed"],
      by: { kind: "agent", id: "tok_1" },
      text: "rent",
      pageSize: 25,
    });
    expect(queryOf({ ...DEFAULT_STATE, who: "person:accountant" }, TODAY).by).toEqual({
      kind: "person",
      label: "accountant",
    });
    expect(queryOf({ ...DEFAULT_STATE, who: "unknown" }, TODAY).by).toEqual({ kind: "unknown" });
  });

  test("a later page is read at the moment the list was first read", () => {
    const pin = { revision: "46", asOf: "2026-04-02T15:25:00.000Z" };
    expect(queryOf({ ...DEFAULT_STATE, page: 3 }, TODAY, pin)).toEqual({
      since: "lastReview",
      page: 3,
      pageSize: 25,
      revision: "46",
      asOf: "2026-04-02T15:25:00.000Z",
    });
    // The first read has nothing to pin to.
    expect(queryOf(DEFAULT_STATE, TODAY)).not.toHaveProperty("revision");
  });

  test("every group names only kinds the service has, and no kind is in two groups", () => {
    const seen = new Set<string>();
    for (const group of WHAT_GROUPS)
      for (const kind of GROUP_KINDS[group]) {
        expect(seen.has(kind)).toBe(false);
        seen.add(kind);
      }
    // The day the books were opened and a change the list has no name for are in "Everything" only.
    expect(seen.has("book.opened")).toBe(false);
    expect(seen.has("book.changed")).toBe(false);
  });

  test("a maker is named by identifier, by name, or by kind", () => {
    expect(makerFilter("agent@abc")).toEqual({ kind: "agent", id: "abc" });
    expect(makerFilter("agent:weekly-run")).toEqual({ kind: "agent", label: "weekly-run" });
    expect(makerFilter("service")).toEqual({ kind: "service" });
    expect(makerFilter("")).toBeUndefined();
    expect(makerFilter("bogus")).toBeUndefined();
  });
});

describe("the state", () => {
  test("a choice that hides changes is a filter, and the start and the page are not", () => {
    expect(filtersActive(DEFAULT_STATE)).toBe(false);
    expect(filtersActive({ ...DEFAULT_STATE, since: "all", page: 4 })).toBe(false);
    expect(filtersActive({ ...DEFAULT_STATE, who: "agent" })).toBe(true);
    expect(filtersActive({ ...DEFAULT_STATE, what: "rules" })).toBe(true);
    expect(filtersActive({ ...DEFAULT_STATE, text: "x" })).toBe(true);
  });

  test("two states are the same when every part is", () => {
    expect(sameState(DEFAULT_STATE, { ...DEFAULT_STATE })).toBe(true);
    expect(sameState(DEFAULT_STATE, { ...DEFAULT_STATE, page: 2 })).toBe(false);
  });
});

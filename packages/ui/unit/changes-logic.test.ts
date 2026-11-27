import { describe, expect, test } from "bun:test";
import {
  byWords,
  changesInWindow,
  dayOf,
  emptyKind,
  groupByDay,
  makerName,
  markVerdict,
  reachesLastLook,
  sameMaker,
  sinceChoices,
  timeOf,
  unreadSources,
  whatChoices,
  whoChoices,
  whoValue,
} from "../src/changes/logic";
import type {
  ChangeListView,
  ChangeView,
  LookRecordView,
  MakerView,
  SourceView,
} from "../src/changes/types";
import { DEFAULT_STATE } from "../src/changes/url-state";

const OWNER: MakerView = { kind: "owner", label: "owner" };
const WEEKLY: MakerView = { kind: "agent", label: "weekly-run", id: "tok_1" };
const OTHER: MakerView = { kind: "agent", label: "weekly-run", id: "tok_2" };
const ACCOUNTANT: MakerView = { kind: "person", label: "accountant", id: "user_3" };
const ADMIN: MakerView = { kind: "person", label: "admin", id: "user_2" };
const SERVICE: MakerView = { kind: "service", label: "control", id: "control" };
const UNKNOWN: MakerView = { kind: "unknown", label: "not recorded" };

const read = (name: string, changes = 0): SourceView => ({
  name,
  title: name,
  read: true,
  reason: null,
  changes,
});

const change = (id: string, at: string, by: MakerView = OWNER): ChangeView => ({
  id,
  at,
  revision: null,
  kind: "entry.posted",
  summary: `Posted ${id}`,
  subject: { kind: "journal", id },
  by,
  how: "Entered by hand and posted",
});

const look = (revision: string, at: string): LookRecordView => ({
  seq: 1,
  at,
  by: OWNER,
  upToRevision: revision,
  upToAt: at,
  note: "",
});

function list(overrides: Partial<ChangeListView> = {}): ChangeListView {
  return {
    revision: "50",
    asOf: "2026-04-02T15:25:00.000Z",
    window: { since: "the start of the book", sinceRevision: "0", sinceAt: null, until: null },
    count: 3,
    page: 1,
    pageSize: 25,
    changes: [],
    actors: [],
    sources: [read("ledger", 3), read("review", 1), read("rules"), read("access")],
    notCovered: [],
    attribution: null,
    lastReview: null,
    ...overrides,
  };
}

describe("who made a change", () => {
  test("the same maker is the same kind and identifier, or, with none, the same name", () => {
    expect(sameMaker(WEEKLY, { ...WEEKLY })).toBe(true);
    expect(sameMaker(WEEKLY, OTHER)).toBe(false);
    expect(sameMaker(OWNER, { kind: "owner", label: "owner" })).toBe(true);
    expect(sameMaker(OWNER, UNKNOWN)).toBe(false);
    expect(
      sameMaker({ kind: "person", label: "accountant" }, { kind: "person", label: "admin" }),
    ).toBe(false);
    // An agent and a person with the same name are two makers.
    expect(sameMaker({ kind: "agent", label: "x" }, { kind: "person", label: "x" })).toBe(false);
  });

  test("a line says it in words, and the name from outside stays apart", () => {
    expect(byWords(OWNER)).toEqual({ text: "By the owner" });
    expect(byWords(ACCOUNTANT)).toEqual({ text: "By an accountant" });
    expect(byWords(ADMIN)).toEqual({ text: "By an admin" });
    expect(byWords({ kind: "person", label: "member" })).toEqual({ text: "By a member" });
    expect(byWords(SERVICE)).toEqual({ text: "By Rastrata" });
    expect(byWords(WEEKLY)).toEqual({ text: "By the agent", name: "weekly-run" });
    expect(byWords(UNKNOWN)).toEqual({ text: "Who made it was not recorded" });
  });

  test("the person looking is you", () => {
    expect(byWords(WEEKLY, WEEKLY)).toEqual({ text: "By you" });
    expect(byWords(OWNER, OWNER)).toEqual({ text: "By you" });
    expect(byWords(OWNER, WEEKLY)).toEqual({ text: "By the owner" });
    // A name another agent also goes by is not you.
    expect(byWords(OTHER, WEEKLY)).toEqual({ text: "By the agent", name: "weekly-run" });
  });

  test("a maker as a choice or a count", () => {
    expect(makerName(OWNER)).toBe("the owner");
    expect(makerName(WEEKLY)).toBe("the agent weekly-run");
    expect(makerName(WEEKLY, WEEKLY)).toBe("you, the agent weekly-run");
    expect(makerName(ACCOUNTANT)).toBe("an accountant");
    expect(makerName(UNKNOWN)).toBe("not recorded");
    expect(makerName(SERVICE)).toBe("Rastrata");
  });

  test("a maker's value is its identifier when it has one, else its name, else its kind", () => {
    expect(whoValue(WEEKLY)).toBe("agent@tok_1");
    expect(whoValue({ kind: "agent", label: "rule author" })).toBe("agent:rule author");
    expect(whoValue(OWNER)).toBe("owner");
    expect(whoValue(UNKNOWN)).toBe("unknown");
    expect(whoValue(SERVICE)).toBe("service@control");
  });
});

describe("the makers to choose from", () => {
  const actors = [
    { by: WEEKLY, count: 5 },
    { by: OTHER, count: 2 },
    { by: OWNER, count: 2 },
    { by: ACCOUNTANT, count: 1 },
    { by: UNKNOWN, count: 4 },
  ];

  test("anyone first with all of them, a kind where there is more than one of it, then each maker", () => {
    const choices = whoChoices(actors, OWNER, "");
    expect(choices.map((choice) => [choice.value, choice.label])).toEqual([
      ["", "Anyone (14)"],
      ["agent", "Agents (7)"],
      ["agent@tok_1", "the agent weekly-run (5)"],
      ["agent@tok_2", "the agent weekly-run (2)"],
      ["owner", "you, the owner (2)"],
      ["person@user_3", "an accountant (1)"],
      ["unknown", "not recorded (4)"],
    ]);
  });

  test("a kind with one maker is not offered twice", () => {
    const choices = whoChoices([{ by: ACCOUNTANT, count: 1 }], undefined, "");
    expect(choices.map((choice) => choice.value)).toEqual(["", "person@user_3"]);
  });

  test("a maker already chosen stays, with none of theirs", () => {
    const choices = whoChoices([{ by: OWNER, count: 2 }], undefined, "agent@tok_9");
    expect(choices.at(-1)).toEqual({ value: "agent@tok_9", label: "an agent tok_9 (0)" });
    expect(whoChoices([], undefined, "person").at(-1)?.label).toBe("people (0)");
    expect(whoChoices([], undefined, "agent:weekly-run").at(-1)?.label).toBe(
      "the agent weekly-run (0)",
    );
  });

  test("where the list starts, with a date when the address carries one", () => {
    expect(sinceChoices("look").map((choice) => choice.value)).toEqual([
      "look",
      "close",
      "week",
      "month",
      "year",
      "all",
    ]);
    const withDate = sinceChoices("2026-03-19");
    expect(withDate.at(-1)).toEqual({ value: "2026-03-19", label: "Mar 19, 2026" });
  });

  test("what: everything, and a group of kinds", () => {
    expect(whatChoices().map((choice) => choice.label)).toEqual([
      "Everything",
      "Entries",
      "Periods and the calendar",
      "Accounts",
      "Rules",
      "Reconciliations",
      "Who has access",
    ]);
  });
});

describe("days", () => {
  const TODAY = "2026-04-02";
  const changes = [
    change("a", "2026-04-02T15:10:00.000Z"),
    change("b", "2026-04-02T09:00:00.000Z"),
    change("c", "2026-04-01T23:30:00.000Z"),
    change("d", "2026-03-20T11:00:00.000Z"),
    change("e", "2026-03-20T10:00:00.000Z"),
    change("f", "2026-01-05T10:00:00.000Z"),
  ];

  test("a day at a time, newest first: today, yesterday, then the date with its weekday", () => {
    const groups = groupByDay(changes, TODAY, "UTC");
    expect(groups.map((group) => group.heading)).toEqual([
      "Today",
      "Yesterday",
      "Friday, Mar 20, 2026",
      "Monday, Jan 5, 2026",
    ]);
    expect(groups.map((group) => group.when)).toEqual(["Apr 2, 2026", "Apr 1, 2026", "", ""]);
    expect(groups.map((group) => group.changes.map((item) => item.id))).toEqual([
      ["a", "b"],
      ["c"],
      ["d", "e"],
      ["f"],
    ]);
  });

  test("a day is the viewer's day: a late evening in Denver is the evening, not the next day", () => {
    expect(dayOf("2026-04-02T01:30:00.000Z", "UTC")).toBe("2026-04-02");
    expect(dayOf("2026-04-02T01:30:00.000Z", "America/Denver")).toBe("2026-04-01");
    const groups = groupByDay(
      [change("late", "2026-04-02T01:30:00.000Z")],
      "2026-04-01",
      "America/Denver",
    );
    expect(groups[0]?.heading).toBe("Today");
  });

  test("the time of day is on the viewer's clock", () => {
    expect(timeOf("2026-04-02T15:12:00.000Z", "UTC")).toBe("3:12 PM");
    expect(timeOf("2026-04-02T15:12:00.000Z", "America/Denver")).toBe("9:12 AM");
    expect(timeOf("not a time")).toBe("not a time");
  });

  test("no changes, no days", () => {
    expect(groupByDay([], TODAY, "UTC")).toEqual([]);
  });
});

describe("whether a list can be marked as looked at", () => {
  const march = look("40", "2026-03-31T12:00:00.000Z");
  const sinceLook = list({
    count: 4,
    lastReview: march,
    window: {
      since: "the last time the changes were marked as looked at (Mar 31, 2026)",
      sinceRevision: "40",
      sinceAt: "2026-03-31T12:00:00.000Z",
      until: null,
    },
  });

  test("a list since the last look, whole and not empty, can be", () => {
    expect(markVerdict(sinceLook, DEFAULT_STATE)).toEqual({ ok: true });
  });

  test("a list of the whole book can be when nobody has looked, and when someone has", () => {
    expect(markVerdict(list(), { ...DEFAULT_STATE, since: "all" })).toEqual({ ok: true });
    expect(markVerdict(list({ lastReview: march }), { ...DEFAULT_STATE, since: "all" })).toEqual({
      ok: true,
    });
  });

  test("not when a choice hides some of it", () => {
    for (const hidden of [{ who: "agent" }, { what: "rules" as const }, { text: "rent" }])
      expect(markVerdict(sinceLook, { ...DEFAULT_STATE, ...hidden })).toEqual({
        ok: false,
        reason: "filtered",
      });
    expect(
      markVerdict(
        list({ window: { ...list().window, until: "Mar 31, 2026 (UTC)" } }),
        DEFAULT_STATE,
      ),
    ).toEqual({ ok: false, reason: "filtered" });
  });

  test("not when a part of it could not be read, whatever the rest says", () => {
    const partial = list({
      sources: [read("ledger", 3), { ...read("access"), read: false, reason: "No." }],
    });
    expect(markVerdict(partial, DEFAULT_STATE)).toEqual({ ok: false, reason: "partial" });
    // That the explanation of For review could not be read does not hide a change.
    const noWhy = list({
      sources: [read("ledger", 3), { ...read("review"), read: false, reason: "No." }],
    });
    expect(markVerdict(noWhy, DEFAULT_STATE)).toEqual({ ok: true });
  });

  test("not when it starts after changes nobody has looked at", () => {
    const afterClose = list({
      lastReview: march,
      window: {
        since: "close",
        sinceRevision: "44",
        sinceAt: "2026-04-01T08:00:00.000Z",
        until: null,
      },
    });
    expect(markVerdict(afterClose, { ...DEFAULT_STATE, since: "close" })).toEqual({
      ok: false,
      reason: "window",
    });
    // Nothing looked at yet: only the start of the book holds everything.
    const dated = list({
      window: {
        since: "Mar 19",
        sinceRevision: "12",
        sinceAt: "2026-03-19T00:00:00.000Z",
        until: null,
      },
    });
    expect(markVerdict(dated, { ...DEFAULT_STATE, since: "2026-03-19" })).toEqual({
      ok: false,
      reason: "window",
    });
  });

  test("not when there is nothing in it", () => {
    expect(markVerdict(list({ count: 0 }), DEFAULT_STATE)).toEqual({
      ok: false,
      reason: "nothing",
    });
  });

  test("a window reaches the last look when it starts at or before it, in both of the ledger's measures", () => {
    expect(reachesLastLook(sinceLook)).toBe(true);
    expect(reachesLastLook(list())).toBe(true);
    expect(
      reachesLastLook(
        list({ lastReview: march, window: { ...list().window, sinceRevision: "41" } }),
      ),
    ).toBe(false);
    expect(
      reachesLastLook(
        list({
          lastReview: march,
          window: { ...list().window, sinceRevision: "10", sinceAt: "2026-04-01T00:00:00.000Z" },
        }),
      ),
    ).toBe(false);
    // A revision that is not a number is not a window that reaches.
    expect(
      reachesLastLook(
        list({ lastReview: march, window: { ...list().window, sinceRevision: "x" } }),
      ),
    ).toBe(false);
  });
});

describe("what to say when there is nothing", () => {
  const empty = list({ count: 0, lastReview: look("50", "2026-04-02T15:00:00.000Z") });

  test("it depends on what was asked", () => {
    expect(emptyKind(empty, DEFAULT_STATE)).toBe("after-look");
    expect(emptyKind(empty, { ...DEFAULT_STATE, text: "x" })).toBe("filtered");
    expect(emptyKind(empty, { ...DEFAULT_STATE, since: "all" })).toBe("book");
    expect(emptyKind(empty, { ...DEFAULT_STATE, since: "week" })).toBe("window");
    expect(emptyKind(list({ count: 0 }), DEFAULT_STATE)).toBe("window");
  });
});

describe("what a list is made of", () => {
  test("the changes in the window are what the sources gave, not the explanation of For review", () => {
    expect(changesInWindow(list())).toBe(3);
    expect(
      changesInWindow(list({ sources: [read("ledger", 7), read("rules", 2), read("review", 5)] })),
    ).toBe(9);
  });

  test("the sources that could not be read", () => {
    const bad = { ...read("access"), read: false, reason: "No." };
    expect(
      unreadSources(list({ sources: [read("ledger"), bad] })).map((source) => source.name),
    ).toEqual(["access"]);
    expect(unreadSources(list())).toEqual([]);
  });
});

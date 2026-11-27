import { expect, test } from "bun:test";
import { shown } from "../support/shown";
import type {
  CutoverChecklist,
  InboxSummary,
  PeriodList,
  PreparedOperation,
  ReconcileStatus,
  YearEndPlan,
  YearEndReceipt,
  YearEndReview,
} from "@rastrata/application/client-contracts";
import { buildChecklist, checklistSettled, type Read } from "../../src/routes/calendar/checklist";
import {
  nameOf,
  toChangePlan,
  toHistory,
  toPeriod,
  toPeriods,
  toReceipt,
  toYearEndPlan,
  toYears,
} from "../../src/routes/calendar/convert";
import { locationSearch, parseLocation, yearEndHref } from "../../src/routes/calendar/location";

/** The tests state only the fields the screen reads; this says so once. */
const as = <T>(value: unknown): T => value as T;
const ready = <T>(value: unknown): Read<T> => ({ state: "ready", value: as<T>(value) });

test("the address says which year is on show and whether the year-end is open, and nothing else", () => {
  expect(parseLocation("")).toEqual({ year: undefined, yearEnd: false });
  expect(parseLocation("?year=2027&flow=year-end")).toEqual({ year: 2027, yearEnd: true });
  expect(parseLocation("?flow=year-end")).toEqual({ year: undefined, yearEnd: true });
  // Anything that is not a four-digit year or the one flow is ignored, not trusted.
  expect(parseLocation("?year=20x7&flow=other")).toEqual({ year: undefined, yearEnd: false });
  expect(parseLocation("?year=99999")).toEqual({ year: undefined, yearEnd: false });
  expect(locationSearch({ year: undefined, yearEnd: false })).toBe("");
  expect(locationSearch({ year: 2027, yearEnd: false })).toBe("?year=2027");
  expect(locationSearch({ year: 2027, yearEnd: true })).toBe("?year=2027&flow=year-end");
  expect(yearEndHref(2026)).toBe("/periods?year=2026&flow=year-end");
  // What is written is what is read.
  expect(parseLocation(locationSearch({ year: 2031, yearEnd: true }))).toEqual({
    year: 2031,
    yearEnd: true,
  });
});

const row = (
  id: string,
  label: string,
  startsOn: string,
  endsOn: string,
  over: Record<string, unknown> = {},
) => ({
  id,
  label,
  startsOn,
  endsOn,
  status: "open",
  closePackageId: null,
  reportPopulationHash: null,
  closingRevision: null,
  fiscalYear: Number(startsOn.slice(0, 4)),
  ordinal: 1,
  ended: true,
  closeSuperseded: false,
  empty: false,
  supersedes: [],
  alsoReopens: [],
  ...over,
});
const list = as<PeriodList>({
  bookRevision: "30",
  calendar: {
    today: "2027-02-01",
    firstDate: "2026-01-01",
    lastDate: "2027-12-31",
    fiscalYearStartMonth: 1,
    periodModel: "monthly",
    fiscalYears: [
      {
        fiscalYear: 2026,
        startsOn: "2026-01-01",
        endsOn: "2026-12-31",
        periodCount: 12,
        closedCount: 1,
        supersededCount: 1,
        status: "partlyClosed",
        ended: true,
      },
    ],
    canExtend: true,
    nextFiscalYear: 2028,
    nextStartsOn: "2028-01-01",
    nextEndsOn: "2028-12-31",
    extendNote: "",
  },
  periods: [
    row("period-01", "January", "2026-01-01", "2026-01-31", {
      status: "closed",
      closePackageId: "close-1",
      closingRevision: "12",
      supersedes: ["period-02"],
    }),
    row("period-02", "February", "2026-02-01", "2026-02-28", {
      status: "closed",
      closeSuperseded: true,
    }),
    row("period-2027-01", "January", "2027-01-01", "2027-01-31", { fiscalYear: 2027 }),
  ],
  history: [
    {
      periodId: "period-01",
      kind: "reopen",
      reason: "Late invoice",
      recordedAt: "2027-01-05T10:00:00.000Z",
      bookRevision: "20",
      supersededCloseIds: ["close-2"],
      supersededPeriodIds: ["period-02"],
    },
    {
      periodId: "period-01",
      kind: "close",
      reason: "Month done",
      recordedAt: "2027-01-01T10:00:00.000Z",
      bookRevision: "12",
      supersededCloseIds: [],
      supersededPeriodIds: [],
    },
  ],
});

test("a period is named with the year it starts in, so a book of several years is never ambiguous", () => {
  expect(nameOf({ label: "March", startsOn: "2028-03-01" })).toBe("March 2028");
  // A quarter from November to January belongs to the year it starts in.
  expect(nameOf({ label: "Q1", startsOn: "2026-11-01" })).toBe("Q1 2026");
});

test("the periods of one year carry the service's status, and the report link only for a current close", () => {
  const periods = toPeriods(list, 2026);
  expect(periods.map((period) => period.label)).toEqual(["January", "February"]);
  const [january, february] = periods;
  expect(january?.closingReportHref).toBe("/reports?asOf=2026-01-31");
  expect(january?.closingRevision).toBe("12");
  // Reopening January would supersede February's close: it is named with its year.
  expect(january?.supersedes).toEqual(["February 2026"]);
  // February is locked but its close no longer matches: there is no report of a close that is not
  // current, and the status the service gave is not changed.
  expect(february?.status).toBe("closed");
  expect(february?.closeSuperseded).toBe(true);
  expect(february?.closingReportHref).toBeNull();
  expect(toPeriods(list, 2027).map((period) => period.id)).toEqual(["period-2027-01"]);
  expect(toPeriod(list, "period-02")?.label).toBe("February");
  expect(toPeriod(list, "nothing")).toBeUndefined();
  expect(toYears(list)).toHaveLength(1);
});

test("the history names the periods and says which closes a reopening superseded", () => {
  const history = toHistory(list);
  expect(history[0]).toMatchObject({
    periodLabel: "January 2026",
    kind: "reopen",
    reason: "Late invoice",
    superseded: ["February 2026"],
  });
  expect(history[1]?.kind).toBe("close");
});

const plan = (over: Record<string, unknown> = {}) =>
  as<PreparedOperation>({
    disposition: "prepared",
    bookRevision: "30",
    valid: true,
    diagnostics: [],
    problems: [],
    warnings: [],
    effects: {
      journals: [],
      accounts: [],
      periods: [
        {
          periodId: "period-01",
          kind: "reopenPeriod",
          reason: "Late invoice",
          supersededPeriodIds: ["period-02"],
        },
      ],
    },
    ...over,
  });

test("a reopening's consequence is shown once, from the plan, and its warning is not repeated", () => {
  const view = toChangePlan(
    plan({
      warnings: [
        { code: "reopen_supersedes_closes", message: "Reopening January supersedes February." },
        { code: "period_not_ended", message: "March has not ended." },
      ],
    }),
    list,
    null,
  );
  expect(view.supersedes).toEqual(["February 2026"]);
  expect(view.warnings).toEqual(["March has not ended."]);
  expect(view.reportHref).toBeUndefined();
  // A close points at the report of the figures it will record.
  expect(toChangePlan(plan(), list, "2026-01-31").reportHref).toBe("/reports?asOf=2026-01-31");
  expect(toChangePlan(plan({ valid: false, diagnostics: ["Not now."] }), list, null)).toMatchObject(
    {
      valid: false,
      problems: ["Not now."],
    },
  );
});

test("a year-end plan says per period whether it is closed, or reopened and then closed, or left alone", () => {
  const command = (kind: string, warnings: string[] = []) => ({
    kind,
    valid: true,
    diagnostics: [],
    warnings: warnings.map((message) => ({ code: "x", message })),
  });
  const view = toYearEndPlan(
    as<YearEndPlan>({
      fiscalYear: 2026,
      valid: true,
      openCount: 2,
      supersededCount: 1,
      reason: "Reviewed",
      diagnostics: [],
      steps: [
        {
          order: 1,
          label: "January",
          startsOn: "2026-01-01",
          endsOn: "2026-01-31",
          status: "closed",
          closeSuperseded: false,
          plans: [],
        },
        {
          order: 2,
          label: "February",
          startsOn: "2026-02-01",
          endsOn: "2026-02-28",
          status: "closed",
          closeSuperseded: true,
          plans: [command("reopenPeriod"), command("closePeriod", ["Note."])],
        },
        {
          order: 3,
          label: "March",
          startsOn: "2026-03-01",
          endsOn: "2026-03-31",
          status: "open",
          closeSuperseded: false,
          plans: [command("closePeriod")],
        },
      ],
    }),
  );
  expect(view.closes).toBe(2);
  expect(view.superseded).toBe(1);
  expect(view.steps.map((step) => step.commands.map((item) => item.kind))).toEqual([
    [],
    ["reopen", "close"],
    ["close"],
  ]);
  expect(view.steps[1]?.commands[1]?.warnings).toEqual(["Note."]);
});

test("a receipt that stopped part way says how many closed, and what the book said", () => {
  const receipt = (over: Record<string, unknown>) =>
    as<YearEndReceipt>({ closedCount: 3, totalCount: 12, diagnostics: [], ...over });
  expect(toReceipt(receipt({ disposition: "committed", closedCount: 12 }))).toEqual({
    disposition: "committed",
    closed: 12,
    total: 12,
    message: "",
  });
  expect(
    toReceipt(
      receipt({ disposition: "rejected", diagnostics: ["Period 4 cannot close.", "Stopped."] }),
    ),
  ).toEqual({
    disposition: "rejected",
    closed: 3,
    total: 12,
    message: "Period 4 cannot close. Stopped.",
  });
});

const review = (checks: { id: string; label: string; status: string; detail: string }[]) =>
  ready<YearEndReview>({ checks });
const reconcile = (accounts: Record<string, unknown>[]) => as<ReconcileStatus>({ accounts });
const account = (over: Record<string, unknown>) => ({
  tracked: true,
  account: { code: "1000", name: "Operating cash" },
  unclearedCount: 0,
  oldestUnclearedDate: null,
  ...over,
});
const cutover = (state: "ready" | "not_yet", blocking: string[] = []) =>
  as<CutoverChecklist>({
    verdict: {
      state,
      summary: state === "ready" ? "Ready to close March." : "Not yet: 1 thing stands in the way.",
      blocking: blocking.map((message) => ({ message })),
    },
  });
const inbox = (toReview: number, oldest: string | null) =>
  as<InboxSummary>({ counts: { toReview }, oldestToReviewOn: oldest });
const input = (over: Partial<Parameters<typeof buildChecklist>[0]> = {}) => ({
  review: ready<YearEndReview>({ checks: [] }),
  reconcile: ready<ReconcileStatus>({ accounts: [] }),
  cutover: ready<CutoverChecklist>({
    verdict: { state: "ready", summary: "Ready.", blocking: [] },
  }),
  inbox: ready<InboxSummary>({ counts: { toReview: 0 }, oldestToReviewOn: null }),
  endsOn: "2026-12-31",
  lastPeriodLabel: "December 2026",
  ...over,
});
const byId = (items: ReturnType<typeof buildChecklist>, id: string) =>
  items.find((item) => item.id === id);

test("the books' own checks come through as they were stated", () => {
  const items = buildChecklist(
    input({
      review: review([
        {
          id: "trial-balance",
          label: "The trial balance balances",
          status: "pass",
          detail: "Equal.",
        },
        {
          id: "periods-ended",
          label: "Every period has ended",
          status: "attention",
          detail: "Not yet.",
        },
      ]),
    }),
  );
  expect(byId(items, "trial-balance")).toMatchObject({ state: "ready", detail: "Equal." });
  expect(byId(items, "periods-ended")).toMatchObject({ state: "attention", detail: "Not yet." });
});

test("a read that failed or has not arrived is never shown as fine", () => {
  const failed = buildChecklist(
    input({
      review: { state: "failed" },
      reconcile: { state: "failed" },
      cutover: { state: "loading" },
      inbox: { state: "failed" },
    }),
  );
  expect(byId(failed, "books")).toMatchObject({ state: "unavailable" });
  expect(byId(failed, "reconcile")).toMatchObject({ state: "unavailable" });
  expect(byId(failed, "inbox")).toMatchObject({ state: "unavailable" });
  expect(byId(failed, "month-end")).toMatchObject({ state: "loading" });
  expect(checklistSettled(failed)).toBe(false);
  // Everything has answered, well or badly: the person can go on, and nothing is claimed.
  const answered = buildChecklist(
    input({ cutover: { state: "failed" }, reconcile: { state: "failed" } }),
  );
  expect(checklistSettled(answered)).toBe(true);
  expect(answered.some((item) => item.state === "loading")).toBe(false);
});

test("reconciliation counts only lines dated in or before the year, in tracked accounts", () => {
  const none = byId(
    buildChecklist(input({ reconcile: ready<ReconcileStatus>({ accounts: [] }) })),
    "reconcile",
  );
  expect(none).toMatchObject({ state: "attention", href: "/reconcile" });
  expect(none?.detail).toContain("No account is tracked");
  const untracked = byId(
    buildChecklist(
      input({
        reconcile: ready<ReconcileStatus>(
          reconcile([
            account({ tracked: false, unclearedCount: 9, oldestUnclearedDate: "2026-01-02" }),
          ]),
        ),
      }),
    ),
    "reconcile",
  );
  expect(untracked?.state).toBe("attention");
  const afterYear = byId(
    buildChecklist(
      input({
        reconcile: ready<ReconcileStatus>(
          reconcile([account({ unclearedCount: 3, oldestUnclearedDate: "2027-01-05" })]),
        ),
      }),
    ),
    "reconcile",
  );
  expect(afterYear?.state).toBe("ready");
  const behind = byId(
    buildChecklist(
      input({
        reconcile: ready<ReconcileStatus>(
          reconcile([account({ unclearedCount: 3, oldestUnclearedDate: "2026-11-05" })]),
        ),
      }),
    ),
    "reconcile",
  );
  expect(behind).toMatchObject({ state: "attention" });
  expect(behind?.detail).toContain(
    `Operating cash has 3 transactions, the oldest dated ${shown.date("2026-11-05")}`,
  );
});

test("many accounts behind are named a few at a time, and the rest are counted", () => {
  const many = Array.from({ length: 7 }, (_, index) =>
    account({
      account: { code: `10${index}0`, name: `Account ${index}` },
      unclearedCount: 1,
      oldestUnclearedDate: "2026-02-01",
    }),
  );
  const item = byId(
    buildChecklist(input({ reconcile: ready<ReconcileStatus>(reconcile(many)) })),
    "reconcile",
  );
  expect(item?.state).toBe("attention");
  expect(item?.detail).toContain("3 more accounts have transactions too");
  expect(item?.detail).not.toContain("Account 6");
});

test("the month-end checklist and the Inbox say what they say", () => {
  const blocked = byId(
    buildChecklist(
      input({
        cutover: ready<CutoverChecklist>(
          cutover("not_yet", ["Reconcile cash.", "Verify a backup."]),
        ),
      }),
    ),
    "month-end",
  );
  expect(blocked).toMatchObject({
    state: "attention",
    label: "The month-end checklist for December 2026",
  });
  expect(blocked?.detail).toContain(
    "Not yet: 1 thing stands in the way. Reconcile cash. Verify a backup.",
  );
  expect(
    byId(
      buildChecklist(input({ cutover: ready<CutoverChecklist>(cutover("ready")) })),
      "month-end",
    ),
  ).toMatchObject({ state: "ready", detail: "Ready to close March." });

  const waiting = byId(
    buildChecklist(input({ inbox: ready<InboxSummary>(inbox(4, "2026-12-30")) })),
    "inbox",
  );
  expect(waiting).toMatchObject({ state: "attention", href: "/inbox" });
  expect(waiting?.detail).toContain(
    `4 imported transactions are waiting to be reviewed, the oldest dated ${shown.date("2026-12-30")}`,
  );
  // Waiting lines dated after the year do not stand in the way of closing it.
  const later = byId(
    buildChecklist(input({ inbox: ready<InboxSummary>(inbox(2, "2027-01-03")) })),
    "inbox",
  );
  expect(later?.state).toBe("ready");
  expect(later?.detail).toContain("none dated in or before this year");
  expect(
    byId(buildChecklist(input({ inbox: ready<InboxSummary>(inbox(0, null)) })), "inbox")?.detail,
  ).toBe("No imported transaction is waiting to be reviewed.");
});

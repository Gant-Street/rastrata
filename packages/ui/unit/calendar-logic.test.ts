import { expect, test } from "bun:test";
import {
  cardSummary,
  defaultFiscalYear,
  needsClose,
  type CardPeriod,
} from "../src/calendar/calendar-logic";
import { monthName, words } from "../src/calendar/words";
import type { FiscalYearView } from "../src/calendar/types";

const year = (
  fiscalYear: number,
  status: FiscalYearView["status"],
  ended: boolean,
): FiscalYearView => ({
  fiscalYear,
  startsOn: `${fiscalYear}-01-01`,
  endsOn: `${fiscalYear}-12-31`,
  periodCount: 12,
  closedCount: status === "closed" ? 12 : 0,
  supersededCount: 0,
  status,
  ended,
  beforeBooks: false,
  periodsBeforeBooks: 0,
});

const period = (label: string, endsOn: string, state: Partial<CardPeriod> = {}): CardPeriod => ({
  label,
  startsOn: `${endsOn.slice(0, 8)}01`,
  endsOn,
  fiscalYear: Number(endsOn.slice(0, 4)),
  status: "open",
  closeSuperseded: false,
  ended: true,
  beforeBooks: false,
  ...state,
});

test("a period needs closing when it is open or its close was superseded, and not otherwise", () => {
  expect(needsClose({ status: "open", closeSuperseded: false })).toBe(true);
  expect(needsClose({ status: "closed", closeSuperseded: true })).toBe(true);
  expect(needsClose({ status: "closed", closeSuperseded: false })).toBe(false);
});

test("the first fiscal year shown is the oldest ended one with work left", () => {
  expect(defaultFiscalYear([])).toBeUndefined();
  expect(
    defaultFiscalYear([
      year(2026, "closed", true),
      year(2027, "partlyClosed", true),
      year(2028, "open", false),
    ]),
  ).toBe(2027);
  // None has ended: the earliest with work left.
  expect(defaultFiscalYear([year(2026, "closed", true), year(2027, "open", false)])).toBe(2027);
  // Everything closed: the last year.
  expect(defaultFiscalYear([year(2026, "closed", true), year(2027, "closed", true)])).toBe(2027);
  expect(defaultFiscalYear([year(2026, "open", false)])).toBe(2026);
});

test("periods before the books began are not open, and a year that ended before them has nothing to close", () => {
  // Books that began on 1 March, seen on 4 October: January and February hold none of the books' own
  // activity. April to September have ended and are open, and still count.
  const periods = [
    period("January", "2026-01-31", { beforeBooks: true }),
    period("February", "2026-02-28", { beforeBooks: true }),
    period("March", "2026-03-31", { status: "closed" }),
    period("April", "2026-04-30"),
    period("May", "2026-05-31"),
    period("October", "2026-10-31", { ended: false }),
  ];
  const summary = cardSummary({
    today: "2026-10-04",
    lastDate: "2026-12-31",
    canExtend: true,
    years: [year(2026, "partlyClosed", false)],
    periods,
  });
  expect(summary.endedOpen).toBe(2);
  // The close that counts starts where the books do: March is closed, so "closed through March".
  expect(summary.closedThrough).toBe("March 2026");
  // Only periods before the books began are open: nothing is still to close.
  expect(
    cardSummary({
      today: "2026-10-04",
      lastDate: "2026-12-31",
      canExtend: true,
      years: [year(2026, "closed", true)],
      periods: periods.slice(0, 3),
    }).endedOpen,
  ).toBe(0);
  // A fiscal year before the books began is never the one to close, however open its periods are.
  const before = { ...year(2025, "open", true), beforeBooks: true, periodsBeforeBooks: 12 };
  expect(defaultFiscalYear([before, year(2026, "partlyClosed", true)])).toBe(2026);
  expect(
    cardSummary({
      today: "2027-02-01",
      lastDate: "2027-12-31",
      canExtend: true,
      years: [before, year(2026, "closed", true)],
      periods: [],
    }).yearToClose,
  ).toBeNull();
});

test("the Home card counts ended periods that need work, names the year to close and the last close", () => {
  const periods = [
    period("January", "2026-01-31", { status: "closed" }),
    period("February", "2026-02-28", { status: "closed" }),
    period("March", "2026-03-31"),
    period("April", "2026-04-30", { status: "closed", closeSuperseded: true }),
    period("May", "2026-05-31", { ended: false }),
  ];
  const summary = cardSummary({
    today: "2026-05-15",
    lastDate: "2026-12-31",
    canExtend: true,
    years: [year(2026, "partlyClosed", false)],
    periods,
  });
  expect(summary).toMatchObject({
    endedOpen: 2,
    yearToClose: null,
    closedThrough: "February 2026",
    calendar: "fine",
  });
  // A year that has ended and still has work is named.
  expect(
    cardSummary({
      today: "2027-02-01",
      lastDate: "2027-12-31",
      canExtend: true,
      years: [year(2026, "partlyClosed", true), year(2027, "open", false)],
      periods,
    }).yearToClose,
  ).toBe(2026);
});

test("the first gap stops 'closed through', and a book with nothing closed says so", () => {
  const gap = [
    period("January", "2026-01-31", { status: "closed" }),
    period("February", "2026-02-28"),
    period("March", "2026-03-31", { status: "closed" }),
  ];
  const base = { today: "2026-06-01", lastDate: "2026-12-31", canExtend: true, years: [] };
  expect(cardSummary({ ...base, periods: gap }).closedThrough).toBe("January 2026");
  expect(cardSummary({ ...base, periods: [period("January", "2026-01-31")] }).closedThrough).toBe(
    null,
  );
  // Input order does not matter.
  expect(cardSummary({ ...base, periods: [...gap].reverse() }).closedThrough).toBe("January 2026");
});

test("a period that spans two calendar years is named by the year it starts in", () => {
  const quarter = {
    ...period("Q1", "2027-01-31", { status: "closed" }),
    startsOn: "2026-11-01",
  };
  expect(
    cardSummary({
      today: "2027-06-01",
      lastDate: "2027-12-31",
      canExtend: true,
      years: [],
      periods: [quarter],
    }).closedThrough,
  ).toBe("Q1 2026");
});

test("the calendar warns a month before it runs out and says when it has", () => {
  const input = { canExtend: true, years: [], periods: [] };
  const at = (today: string) => cardSummary({ ...input, today, lastDate: "2026-12-31" }).calendar;
  expect(at("2026-06-01")).toBe("fine");
  expect(at("2026-11-29")).toBe("fine");
  expect(at("2026-11-30")).toBe("ending");
  expect(at("2026-12-01")).toBe("ending");
  expect(at("2026-12-31")).toBe("ending");
  expect(at("2027-01-01")).toBe("ended");
});

test("words name months and pluralise, and never print a bare 1 periods", () => {
  expect(monthName(1)).toBe("January");
  expect(monthName(10)).toBe("October");
  expect(words.progress(1, 1)).toBe("1 of 1 period closed");
  expect(words.progress(5, 12)).toBe("5 of 12 periods closed");
  // January is what everyone expects, so nothing is said of it; another month is named.
  expect(words.yearStarts(1)).toBe("");
  expect(words.yearStarts(10)).toContain("October");
  expect(words.supersedesTitle(1)).toContain("close of 1 later period");
  expect(words.supersedesTitle(2)).toContain("closes of 2 later periods");
  expect(words.coverage("2026-01-01", "2026-12-31")).toMatch(/^Covers .*2026\.$/);
  expect(words.coverage("2026-01-01", "2026-12-31")).not.toContain("fiscal year");
  // The calendar grows itself: the one sentence after the coverage says so, and nothing offers to extend it.
  expect(words.grows).toBe("Later years are added as your entries need them.");
  expect(Object.keys(words).some((key) => /extend/i.test(key))).toBe(false);
});

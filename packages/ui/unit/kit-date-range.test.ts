import { describe, expect, test } from "bun:test";
import {
  calendarBounds,
  dateRangeProblem,
  defaultRange,
  describeDates,
  isUsableRange,
  presetOf,
  presetRange,
  RANGE_PRESETS,
  type FiscalCalendar,
  type RangePresetId,
} from "../src/kit/date-range";
import { shown } from "../tests/support/shown";

/** A calendar of whole fiscal years that start on the first of `startMonth`, from `firstYear` for `count`
 * years, with today as given. */
function calendar(
  startMonth: number,
  firstYear: number,
  count: number,
  today: string,
): FiscalCalendar {
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    today,
    years: Array.from({ length: count }, (_, index) => {
      const year = firstYear + index;
      const endMonth = startMonth === 1 ? 12 : startMonth - 1;
      const endYear = startMonth === 1 ? year : year + 1;
      const lastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
      return {
        startsOn: `${year}-${pad(startMonth)}-01`,
        endsOn: `${endYear}-${pad(endMonth)}-${pad(lastDay)}`,
      };
    }),
  };
}

const range = (preset: Exclude<RangePresetId, "custom">, cal: FiscalCalendar) => {
  const dates = presetRange(preset, cal);
  return dates ? `${dates.from} ${dates.to}` : undefined;
};

describe("the presets of a calendar-year book", () => {
  const cal = calendar(1, 2025, 2, "2026-10-04");

  test("this and last month", () => {
    expect(range("thisMonth", cal)).toBe("2026-10-01 2026-10-31");
    expect(range("lastMonth", cal)).toBe("2026-09-01 2026-09-30");
  });

  test("this and last quarter", () => {
    expect(range("thisQuarter", cal)).toBe("2026-10-01 2026-12-31");
    expect(range("lastQuarter", cal)).toBe("2026-07-01 2026-09-30");
  });

  test("the fiscal year to date ends today, and last fiscal year is the whole of the one before", () => {
    expect(range("fiscalYearToDate", cal)).toBe("2026-01-01 2026-10-04");
    expect(range("lastFiscalYear", cal)).toBe("2025-01-01 2025-12-31");
  });

  test("every preset has its words in the order they are offered", () => {
    expect(RANGE_PRESETS).toEqual([
      "thisMonth",
      "lastMonth",
      "thisQuarter",
      "lastQuarter",
      "fiscalYearToDate",
      "lastFiscalYear",
      "custom",
    ]);
  });

  test("the first of a year looks back across the year boundary", () => {
    const january = calendar(1, 2025, 2, "2026-01-15");
    expect(range("lastMonth", january)).toBe("2025-12-01 2025-12-31");
    expect(range("lastQuarter", january)).toBe("2025-10-01 2025-12-31");
    expect(range("thisQuarter", january)).toBe("2026-01-01 2026-03-31");
    expect(range("fiscalYearToDate", january)).toBe("2026-01-01 2026-01-15");
  });

  test("February ends on the 29th in a leap year", () => {
    const leap = calendar(1, 2027, 2, "2028-02-10");
    expect(range("thisMonth", leap)).toBe("2028-02-01 2028-02-29");
    expect(range("lastMonth", leap)).toBe("2028-01-01 2028-01-31");
  });
});

describe("the presets of a book whose fiscal year starts in October", () => {
  const first = calendar(10, 2025, 2, "2026-10-04");

  test("the fiscal quarters are the book's, not the calendar's", () => {
    expect(range("thisQuarter", first)).toBe("2026-10-01 2026-12-31");
    expect(range("lastQuarter", first)).toBe("2026-07-01 2026-09-30");
    const february = calendar(10, 2025, 2, "2027-02-10");
    expect(range("thisQuarter", february)).toBe("2027-01-01 2027-03-31");
    expect(range("lastQuarter", february)).toBe("2026-10-01 2026-12-31");
  });

  test("the fiscal year to date starts in October", () => {
    expect(range("fiscalYearToDate", first)).toBe("2026-10-01 2026-10-04");
    expect(range("fiscalYearToDate", calendar(10, 2025, 2, "2027-02-10"))).toBe(
      "2026-10-01 2027-02-10",
    );
    expect(range("fiscalYearToDate", calendar(10, 2025, 2, "2026-05-20"))).toBe(
      "2025-10-01 2026-05-20",
    );
  });

  test("last fiscal year is the twelve months before this one began", () => {
    expect(range("lastFiscalYear", first)).toBe("2025-10-01 2026-09-30");
    expect(range("lastFiscalYear", calendar(10, 2025, 2, "2027-02-10"))).toBe(
      "2025-10-01 2026-09-30",
    );
  });
});

describe("a book that starts in July", () => {
  test("a quarter is three months from July", () => {
    const cal = calendar(7, 2025, 2, "2026-08-20");
    expect(range("thisQuarter", cal)).toBe("2026-07-01 2026-09-30");
    expect(range("lastQuarter", cal)).toBe("2026-04-01 2026-06-30");
    expect(range("lastFiscalYear", cal)).toBe("2025-07-01 2026-06-30");
  });
});

describe("what the calendar does not cover is not offered", () => {
  test("in the first year there is no last fiscal year, and the first months have no month before them", () => {
    const cal = calendar(1, 2026, 1, "2026-02-10");
    expect(range("lastFiscalYear", cal)).toBeUndefined();
    expect(range("lastQuarter", cal)).toBeUndefined();
    expect(range("lastMonth", cal)).toBe("2026-01-01 2026-01-31");
    const january = calendar(1, 2026, 1, "2026-01-10");
    expect(range("lastMonth", january)).toBeUndefined();
  });

  test("after the last year only the fiscal year to date remains, and it is that whole year", () => {
    const cal = calendar(1, 2025, 2, "2027-06-01");
    expect(range("thisMonth", cal)).toBeUndefined();
    expect(range("lastMonth", cal)).toBeUndefined();
    expect(range("thisQuarter", cal)).toBeUndefined();
    expect(range("fiscalYearToDate", cal)).toBe("2026-01-01 2026-12-31");
    expect(range("lastFiscalYear", cal)).toBe("2026-01-01 2026-12-31");
  });

  test("before the first year the fiscal year to date is the first year, so a default is always usable", () => {
    const cal = calendar(1, 2025, 2, "2024-06-01");
    expect(range("thisMonth", cal)).toBeUndefined();
    expect(range("fiscalYearToDate", cal)).toBe("2025-01-01 2025-12-31");
  });

  test("a calendar with no years, or a today that is not a date, offers nothing", () => {
    const none: FiscalCalendar = { years: [], today: "2026-10-04" };
    const bad = { ...calendar(1, 2026, 1, "not a date") };
    for (const cal of [none, bad])
      for (const preset of RANGE_PRESETS)
        if (preset !== "custom") expect(presetRange(preset, cal)).toBeUndefined();
    expect(defaultRange(none)).toBeUndefined();
    expect(calendarBounds(none)).toBeUndefined();
  });
});

describe("the default, and which preset a pair of dates is", () => {
  const cal = calendar(1, 2025, 2, "2026-10-04");

  test("a field starts on the fiscal year to date", () => {
    expect(defaultRange(cal)).toEqual({
      preset: "fiscalYearToDate",
      from: "2026-01-01",
      to: "2026-10-04",
    });
  });

  test("dates that are a preset say which, and any others are custom", () => {
    expect(presetOf({ from: "2026-10-01", to: "2026-10-31" }, cal)).toBe("thisMonth");
    expect(presetOf({ from: "2026-09-01", to: "2026-09-30" }, cal)).toBe("lastMonth");
    expect(presetOf({ from: "2025-01-01", to: "2025-12-31" }, cal)).toBe("lastFiscalYear");
    expect(presetOf({ from: "2026-02-01", to: "2026-02-14" }, cal)).toBe("custom");
  });

  test("the calendar's bounds are its first and last days", () => {
    expect(calendarBounds(cal)).toEqual({ first: "2025-01-01", last: "2026-12-31" });
  });
});

describe("a custom range", () => {
  const cal = calendar(1, 2025, 2, "2026-10-04");

  test("a real, ordered range inside the calendar is fine", () => {
    expect(dateRangeProblem({ from: "2026-03-01", to: "2026-03-31" }, cal)).toBeUndefined();
    expect(dateRangeProblem({ from: "2026-03-01", to: "2026-03-01" }, cal)).toBeUndefined();
  });

  test("a missing or impossible date is incomplete", () => {
    expect(dateRangeProblem({ from: "", to: "2026-03-31" }, cal)).toEqual({ kind: "incomplete" });
    expect(dateRangeProblem({ from: "2026-02-30", to: "2026-03-31" }, cal)).toEqual({
      kind: "incomplete",
    });
  });

  test("a start after the end is the wrong way round", () => {
    expect(dateRangeProblem({ from: "2026-04-01", to: "2026-03-01" }, cal)).toEqual({
      kind: "order",
    });
  });

  test("dates the book's calendar does not cover are outside it, and say which dates it does", () => {
    expect(dateRangeProblem({ from: "2024-12-01", to: "2025-01-31" }, cal)).toEqual({
      kind: "outside",
      first: "2025-01-01",
      last: "2026-12-31",
    });
    expect(dateRangeProblem({ from: "2026-12-01", to: "2027-01-31" }, cal)).toEqual({
      kind: "outside",
      first: "2025-01-01",
      last: "2026-12-31",
    });
  });

  test("a preset is usable whenever it has dates; a custom range only when it is a good one", () => {
    expect(isUsableRange({ preset: "thisMonth", from: "2026-10-01", to: "2026-10-31" }, cal)).toBe(
      true,
    );
    expect(isUsableRange({ preset: "custom", from: "2026-10-01", to: "" }, cal)).toBe(false);
    expect(isUsableRange({ preset: "custom", from: "2026-10-01", to: "2026-10-31" }, cal)).toBe(
      true,
    );
    expect(isUsableRange({ preset: "custom", from: "2024-01-01", to: "2026-10-31" }, cal)).toBe(
      false,
    );
  });
});

describe("every date", () => {
  const cal = calendar(1, 2025, 2, "2026-10-04");
  const none: FiscalCalendar = { years: [], today: "2026-10-04" };
  const all = { preset: "all", from: "", to: "" } as const;

  test("it is not in the default set, so only a screen that asks for it offers it", () => {
    expect(RANGE_PRESETS).not.toContain("all");
  });

  test("it has no dates to give, with a calendar or without one", () => {
    expect(presetRange("all", cal)).toBeUndefined();
    expect(presetRange("all", none)).toBeUndefined();
  });

  test("it can always be asked for, even before a book has a calendar", () => {
    expect(isUsableRange(all, cal)).toBe(true);
    expect(isUsableRange(all, none)).toBe(true);
  });

  test("it says Every date, and so does a range with neither end; a screen can reword it", () => {
    expect(describeDates(all)).toBe("Every date");
    expect(describeDates({ from: "", to: "" })).toBe("Every date");
    expect(describeDates(all, "Todas las fechas")).toBe("Todas las fechas");
    expect(describeDates({ from: "2026-03-01", to: "2026-03-31" })).toBe(
      shown.range("2026-03-01", "2026-03-31"),
    );
  });

  test("a pair of dates is never taken for it: no dates at all is a custom range not yet filled in", () => {
    expect(presetOf({ from: "", to: "" }, cal)).toBe("custom");
  });
});

describe("how a range is written", () => {
  test("in the product's one way, through the formatter", () => {
    expect(describeDates({ from: "2026-01-01", to: "2026-10-04" })).toBe(
      shown.range("2026-01-01", "2026-10-04"),
    );
  });
});

import { describe, expect, test } from "bun:test";
import { shown } from "../tests/support/shown";
import {
  MAX_MONTH_COLUMNS,
  describeDate,
  describeRange,
  monthWindows,
  olderPeriod,
  yearContaining,
  type FiscalYearSpan,
} from "../src/reports/period";

const calendarYear = (year: number): FiscalYearSpan => ({
  year,
  startsOn: `${year}-01-01`,
  endsOn: `${year}-12-31`,
});
const october = (year: number): FiscalYearSpan => ({
  year,
  startsOn: `${year}-10-01`,
  endsOn: `${year + 1}-09-30`,
});

describe("the fiscal year a date is in", () => {
  const years = [october(2024), october(2025)];

  test("a date is in the year that contains it, whenever the year starts", () => {
    expect(yearContaining(years, "2025-10-01")?.year).toBe(2025);
    expect(yearContaining(years, "2025-09-30")?.year).toBe(2024);
    expect(yearContaining(years, "2026-03-15")?.year).toBe(2025);
  });

  test("a date the calendar does not cover is in no year", () => {
    expect(yearContaining(years, "2024-09-30")).toBeUndefined();
    expect(yearContaining(years, "2026-10-01")).toBeUndefined();
    expect(yearContaining([], "2026-03-15")).toBeUndefined();
  });
});

describe("the period an older link named opens as its dates", () => {
  const years = [october(2024), october(2025)];

  test("a month, a quarter of the fiscal year and a whole fiscal year", () => {
    expect(olderPeriod("month:2026-02", years)).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(olderPeriod("month:2025-10", years)).toEqual({ from: "2025-10-01", to: "2025-10-31" });
    expect(olderPeriod("quarter:2025-Q1", years)).toEqual({
      from: "2025-10-01",
      to: "2025-12-31",
    });
    expect(olderPeriod("quarter:2025-Q2", years)).toEqual({
      from: "2026-01-01",
      to: "2026-03-31",
    });
    expect(olderPeriod("year:2024", years)).toEqual({ from: "2024-10-01", to: "2025-09-30" });
  });

  test("a leap day is counted, and a January year has its usual quarters", () => {
    expect(olderPeriod("month:2028-02", [calendarYear(2028)])).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
    expect(
      ["Q1", "Q2", "Q3", "Q4"].map((quarter) =>
        olderPeriod(`quarter:2026-${quarter}`, [calendarYear(2026)]),
      ),
    ).toEqual([
      { from: "2026-01-01", to: "2026-03-31" },
      { from: "2026-04-01", to: "2026-06-30" },
      { from: "2026-07-01", to: "2026-09-30" },
      { from: "2026-10-01", to: "2026-12-31" },
    ]);
  });

  test("a period this calendar does not have is nothing", () => {
    for (const period of [
      "month:2031-01",
      "month:2026-13",
      "month:2026-2",
      "month:",
      "quarter:2025-Q9",
      "quarter:2025-Q0",
      "quarter:1999-Q1",
      "year:1999",
      "year:",
      "week:3",
      "month",
      "",
      "nonsense",
      "__proto__:1",
    ])
      expect(olderPeriod(period, years), period).toBeUndefined();
  });
});

describe("a range is shown in the product's one date format", () => {
  test("a range, one day and a date", () => {
    expect(describeRange({ from: "2026-03-01", to: "2026-03-31" })).toBe(
      shown.range("2026-03-01", "2026-03-31"),
    );
    expect(describeRange({ from: "2025-10-01", to: "2026-09-30" })).toBe(
      shown.range("2025-10-01", "2026-09-30"),
    );
    expect(describeRange({ from: "2026-06-30", to: "2026-06-30" })).toBe(
      shown.range("2026-06-30", "2026-06-30"),
    );
    expect(describeDate("2026-06-30")).toBe(shown.date("2026-06-30"));
  });

  test("text that is not a date is left as it came", () => {
    expect(describeRange({ from: "nope", to: "2026-06-30" })).toBe(
      `nope to ${shown.date("2026-06-30")}`,
    );
  });
});

describe("the months a range touches, for a report by month", () => {
  test("whole months are whole, and every day of the range is in exactly one window", () => {
    const windows = monthWindows({ from: "2026-01-01", to: "2026-03-31" });
    expect(windows.map((window) => [window.month, window.from, window.to])).toEqual([
      ["2026-01", "2026-01-01", "2026-01-31"],
      ["2026-02", "2026-02-01", "2026-02-28"],
      ["2026-03", "2026-03-01", "2026-03-31"],
    ]);
    expect(windows.every((window) => !window.partial && window.endsMonth)).toBe(true);
  });

  test("a range that starts or ends inside a month is clipped, and says so", () => {
    const windows = monthWindows({ from: "2026-01-20", to: "2026-03-05" });
    expect(
      windows.map((window) => [window.from, window.to, window.partial, window.endsMonth]),
    ).toEqual([
      ["2026-01-20", "2026-01-31", true, true],
      ["2026-02-01", "2026-02-28", false, true],
      ["2026-03-01", "2026-03-05", true, false],
    ]);
  });

  test("a range inside one month is one window, and a leap day is counted", () => {
    expect(monthWindows({ from: "2026-02-10", to: "2026-02-10" })).toEqual([
      { month: "2026-02", from: "2026-02-10", to: "2026-02-10", partial: true, endsMonth: false },
    ]);
    const leap = monthWindows({ from: "2028-02-01", to: "2028-02-29" });
    expect(leap).toHaveLength(1);
    expect(leap[0]).toMatchObject({ partial: false, endsMonth: true, to: "2028-02-29" });
  });

  test("the months of a range cross a year, and the windows do not overlap or leave a gap", () => {
    const range = { from: "2025-10-01", to: "2026-09-30" };
    const windows = monthWindows(range);
    expect(windows).toHaveLength(12);
    expect(windows[0]?.from).toBe(range.from);
    expect(windows.at(-1)?.to).toBe(range.to);
    for (let index = 1; index < windows.length; index++) {
      const previous = windows[index - 1];
      const next = windows[index];
      // The next window starts the day after the previous one ended.
      const day = new Date(`${previous?.to}T00:00:00Z`);
      day.setUTCDate(day.getUTCDate() + 1);
      expect(next?.from).toBe(day.toISOString().slice(0, 10));
    }
  });

  test("a range that is not two real dates in order has no months", () => {
    expect(monthWindows({ from: "2026-04-01", to: "2026-03-01" })).toEqual([]);
    expect(monthWindows({ from: "", to: "2026-03-01" })).toEqual([]);
    expect(monthWindows({ from: "2026-02-30", to: "2026-03-01" })).toEqual([]);
  });

  test("the limit on a report's months is two years", () => {
    expect(MAX_MONTH_COLUMNS).toBe(24);
    expect(monthWindows({ from: "2025-01-01", to: "2026-12-31" })).toHaveLength(MAX_MONTH_COLUMNS);
    expect(monthWindows({ from: "2025-01-01", to: "2027-01-01" })).toHaveLength(
      MAX_MONTH_COLUMNS + 1,
    );
  });
});

import { describe, expect, test } from "bun:test";
import { fiscalCalendar } from "../src/reports/calendar.ts";
import { compareCodes } from "../src/reports/chart.ts";
import {
  addDays,
  addMonths,
  comparisonRange,
  daysBetween,
  endOfMonth,
  isDate,
  monthSpan,
  parseDate,
} from "../src/reports/dates.ts";
import { buildPeriods } from "./support/kernel-book.ts";
import { fiscalCalendarId } from "@rastrata/kernel";

describe("calendar dates", () => {
  test("only real calendar dates are accepted", () => {
    for (const real of ["2026-01-31", "2024-02-29", "2000-02-29", "0999-12-31"])
      expect(isDate(real), real).toBe(true);
    for (const bad of [
      "2026-02-30",
      "2025-02-29",
      "1900-02-29",
      "2026-13-01",
      "2026-00-10",
      "2026-04-31",
      "2026-1-01",
      "2026-01-1",
      "26-01-01",
      "2026-01-01T00:00:00Z",
      " 2026-01-01",
      "",
    ])
      expect(isDate(bad), bad).toBe(false);
    expect(isDate(20260101)).toBe(false);
    expect(parseDate("2026-07-04")).toEqual({ year: 2026, month: 7, day: 4 });
  });

  test("arithmetic never leaves the calendar and never touches a time zone", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09"); // a US daylight-saving change is not a day
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
    expect(daysBetween("2026-01-01", "2026-12-31")).toBe(364);
    expect(daysBetween("2024-01-01", "2024-12-31")).toBe(365);
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
    expect(addMonths("2026-03-15", -15)).toBe("2024-12-15");
    expect(addMonths("2026-12-31", 2)).toBe("2027-02-28");
    expect(endOfMonth("2026-02-10")).toBe("2026-02-28");
    expect(endOfMonth("2028-02-10")).toBe("2028-02-29");
    expect(monthSpan("2026-01-01", "2026-03-31")).toBe(3);
    expect(monthSpan("2025-10-01", "2026-09-30")).toBe(12);
  });

  test("a comparison range is the same number of whole months, or days, before; or a year back", () => {
    expect(comparisonRange("previousPeriod", "2026-03-01", "2026-03-31")).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(comparisonRange("previousPeriod", "2026-04-01", "2026-06-30")).toEqual({
      from: "2026-01-01",
      to: "2026-03-31",
    });
    expect(comparisonRange("previousPeriod", "2025-10-01", "2026-09-30")).toEqual({
      from: "2024-10-01",
      to: "2025-09-30",
    });
    expect(comparisonRange("previousPeriod", "2026-01-01", "2026-01-31")).toEqual({
      from: "2025-12-01",
      to: "2025-12-31",
    });
    // Not whole months: the same number of days immediately before.
    expect(comparisonRange("previousPeriod", "2026-03-10", "2026-03-19")).toEqual({
      from: "2026-02-28",
      to: "2026-03-09",
    });
    expect(comparisonRange("previousYear", "2026-01-01", "2026-03-15")).toEqual({
      from: "2025-01-01",
      to: "2025-03-15",
    });
    // February 29 compares with the end of February, not with a made-up date.
    expect(comparisonRange("previousYear", "2024-02-01", "2024-02-29")).toEqual({
      from: "2023-02-01",
      to: "2023-02-28",
    });
    expect(comparisonRange("previousYear", "2025-10-01", "2026-09-30")).toEqual({
      from: "2024-10-01",
      to: "2025-09-30",
    });
  });
});

describe("the fiscal calendar a book's periods define", () => {
  const calendarId = fiscalCalendarId("calendar");

  test("an October fiscal year runs from October to the next September and is labelled by its start", () => {
    const calendar = fiscalCalendar(buildPeriods(calendarId, 2025, 10, 2, true));
    expect(calendar.years).toEqual([
      { year: 2025, startsOn: "2025-10-01", endsOn: "2026-09-30" },
      { year: 2026, startsOn: "2026-10-01", endsOn: "2027-09-30" },
    ]);
    expect(calendar.firstDate).toBe("2025-10-01");
    expect(calendar.lastDate).toBe("2027-09-30");
    expect(calendar.yearOf("2026-01-15")?.year).toBe(2025);
    expect(calendar.yearOf("2026-09-30")?.year).toBe(2025);
    expect(calendar.yearOf("2026-10-01")?.year).toBe(2026);
    expect(calendar.yearOf("2025-09-30")).toBeUndefined();
    expect(calendar.yearOf("2027-10-01")).toBeUndefined();
  });

  test("quarterly periods group into the same fiscal years", () => {
    const calendar = fiscalCalendar(buildPeriods(calendarId, 2026, 4, 3, false));
    expect(calendar.years.map((year) => [year.year, year.startsOn, year.endsOn])).toEqual([
      [2026, "2026-04-01", "2027-03-31"],
      [2027, "2027-04-01", "2028-03-31"],
      [2028, "2028-04-01", "2029-03-31"],
    ]);
  });

  test("account codes sort the way a person reads them", () => {
    const codes = ["1000", "900", "100", "2000", "1000-A", "A10", "A9", "1000-B"];
    expect([...codes].sort(compareCodes)).toEqual([
      "100",
      "900",
      "1000",
      "1000-A",
      "1000-B",
      "2000",
      "A9",
      "A10",
    ]);
  });
});

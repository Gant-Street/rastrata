import { expect, test } from "bun:test";
import {
  addDays,
  fiscalYearBounds,
  fiscalYearOf,
  fiscalYearPeriods,
  isDate,
  isStartMonth,
  periodIdFor,
  periodSequenceFor,
  periodsPerYear,
  type CalendarShape,
  type PeriodModel,
} from "../src/calendar/fiscal-calendar.ts";

const models: readonly PeriodModel[] = ["monthly", "quarterly"];
const shapes: CalendarShape[] = models.flatMap((periodModel) =>
  Array.from({ length: 12 }, (_, index) => ({ fiscalYearStartMonth: index + 1, periodModel })),
);

test("calendar arithmetic stays on calendar dates across month, year and leap boundaries", () => {
  expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
  expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  expect(addDays("2028-02-29", 1)).toBe("2028-03-01");
  expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
  expect(addDays("2100-02-28", 1)).toBe("2100-03-01");
  expect(addDays("2000-02-28", 1)).toBe("2000-02-29");
  expect(addDays("2026-03-01", 365)).toBe("2027-03-01");
  expect(() => addDays("2026-02-30", 1)).toThrow();
});

test("only real calendar dates are dates", () => {
  for (const value of ["2026-01-01", "2028-02-29", "2026-12-31"]) expect(isDate(value)).toBe(true);
  for (const value of [
    "2027-02-29",
    "2026-13-01",
    "2026-00-10",
    "2026-04-31",
    "2026-1-1",
    "26-01-01",
    "2026-01-01T00:00:00Z",
    "",
    20260101,
    null,
    undefined,
  ])
    expect(isDate(value)).toBe(false);
});

test("a start month is a whole number from 1 to 12 and nothing else", () => {
  for (const value of [1, 6, 12]) expect(isStartMonth(value)).toBe(true);
  for (const value of [0, 13, -1, 1.5, "10", null, undefined, Number.NaN, Number.POSITIVE_INFINITY])
    expect(isStartMonth(value)).toBe(false);
});

test("every fiscal year of every start month and period model is contiguous and complete", () => {
  for (const shape of shapes)
    for (let year = 2000; year <= 2100; year++) {
      const periods = fiscalYearPeriods(year, shape);
      expect(periods).toHaveLength(periodsPerYear(shape.periodModel));
      const first = periods[0];
      const last = periods[periods.length - 1];
      expect(first?.startsOn).toBe(
        `${year}-${String(shape.fiscalYearStartMonth).padStart(2, "0")}-01`,
      );
      for (const [index, period] of periods.entries()) {
        expect(period.ordinal).toBe(index + 1);
        expect(period.fiscalYear).toBe(year);
        expect(period.startsOn <= period.endsOn).toBe(true);
        const before = periods[index - 1];
        if (before) expect(period.startsOn).toBe(addDays(before.endsOn, 1));
      }
      // The year closes the day before the next one opens, so consecutive years leave no gap.
      const next = fiscalYearPeriods(year + 1, shape)[0];
      expect(next?.startsOn).toBe(addDays(last?.endsOn ?? "", 1));
      expect(fiscalYearBounds(year, shape)).toEqual({
        fiscalYear: year,
        startsOn: first?.startsOn ?? "",
        endsOn: last?.endsOn ?? "",
      });
    }
});

test("an October fiscal year is named by the year it starts in", () => {
  const shape: CalendarShape = { fiscalYearStartMonth: 10, periodModel: "monthly" };
  const periods = fiscalYearPeriods(2026, shape);
  expect(periods[0]).toMatchObject({
    startsOn: "2026-10-01",
    endsOn: "2026-10-31",
    label: "October",
  });
  expect(periods[2]).toMatchObject({ startsOn: "2026-12-01", endsOn: "2026-12-31" });
  expect(periods[3]).toMatchObject({
    startsOn: "2027-01-01",
    endsOn: "2027-01-31",
    label: "January",
  });
  expect(periods[4]).toMatchObject({ startsOn: "2027-02-01", endsOn: "2027-02-28" });
  expect(periods[11]).toMatchObject({
    startsOn: "2027-09-01",
    endsOn: "2027-09-30",
    label: "September",
  });
  // February of a leap year keeps its extra day inside the fiscal year that contains it.
  expect(fiscalYearPeriods(2027, shape)[4]).toMatchObject({ endsOn: "2028-02-29" });
  expect(fiscalYearOf("2026-10-01", 10)).toBe(2026);
  expect(fiscalYearOf("2026-09-30", 10)).toBe(2025);
  expect(fiscalYearOf("2027-09-30", 10)).toBe(2026);
  expect(fiscalYearOf("2027-01-01", 1)).toBe(2027);
});

test("quarters follow the start month and are named by fiscal year", () => {
  const shape: CalendarShape = { fiscalYearStartMonth: 10, periodModel: "quarterly" };
  expect(fiscalYearPeriods(2026, shape).map((p) => [p.startsOn, p.endsOn, p.label])).toEqual([
    ["2026-10-01", "2026-12-31", "Q1"],
    ["2027-01-01", "2027-03-31", "Q2"],
    ["2027-04-01", "2027-06-30", "Q3"],
    ["2027-07-01", "2027-09-30", "Q4"],
  ]);
  const calendar: CalendarShape = { fiscalYearStartMonth: 1, periodModel: "quarterly" };
  expect(fiscalYearPeriods(2026, calendar).map((p) => [p.startsOn, p.endsOn])).toEqual([
    ["2026-01-01", "2026-03-31"],
    ["2026-04-01", "2026-06-30"],
    ["2026-07-01", "2026-09-30"],
    ["2026-10-01", "2026-12-31"],
  ]);
});

test("the first fiscal year keeps its historical period ids and later years never collide", () => {
  expect(periodIdFor(2026, 1, 2026)).toBe("period-01");
  expect(periodIdFor(2026, 12, 2026)).toBe("period-12");
  expect(periodIdFor(2027, 1, 2026)).toBe("period-2027-01");
  for (const model of models) {
    const ids = new Set<string>();
    const sequences = new Set<number>();
    for (let year = 2026; year <= 2036; year++)
      for (let ordinal = 1; ordinal <= periodsPerYear(model); ordinal++) {
        ids.add(periodIdFor(year, ordinal, 2026));
        sequences.add(periodSequenceFor(year, ordinal, 2026, model));
      }
    const total = 11 * periodsPerYear(model);
    expect(ids.size).toBe(total);
    expect(sequences.size).toBe(total);
    // Sequences count on without a gap, which keeps them unique and positive.
    expect(Math.min(...sequences)).toBe(1);
    expect(Math.max(...sequences)).toBe(total);
  }
});

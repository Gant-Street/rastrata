import { expect, test } from "bun:test";
import { monthWindows, moneyView, yearStart } from "../../src/routes/home-money";
import { failed, ok } from "../support/home-facts";
import { shown } from "../support/shown";

const calendar = { firstDate: "2026-01-01", lastDate: "2026-12-31" };

test("the six months end with the one today falls in, oldest first, and the last one stops at today", () => {
  const windows = monthWindows(calendar, "2026-10-05");
  expect(windows.map((window) => window.month)).toEqual([
    "2026-05",
    "2026-06",
    "2026-07",
    "2026-08",
    "2026-09",
    "2026-10",
  ]);
  expect(windows[0]).toEqual({
    month: "2026-05",
    from: "2026-05-01",
    to: "2026-05-31",
    before: false,
  });
  expect(windows[5]).toEqual({
    month: "2026-10",
    from: "2026-10-01",
    to: "2026-10-05",
    before: false,
  });
});

test("months across a year boundary count back correctly", () => {
  const windows = monthWindows({ firstDate: "2025-01-01", lastDate: "2027-12-31" }, "2026-02-14");
  expect(windows.map((window) => window.month)).toEqual([
    "2025-09",
    "2025-10",
    "2025-11",
    "2025-12",
    "2026-01",
    "2026-02",
  ]);
  expect(windows[1]).toEqual({
    month: "2025-10",
    from: "2025-10-01",
    to: "2025-10-31",
    before: false,
  });
  expect(windows[5]?.to).toBe("2026-02-14");
});

test("a month that ended before the books began is marked, not read as zero", () => {
  const windows = monthWindows({ firstDate: "2026-08-15", lastDate: "2027-08-14" }, "2026-10-05");
  expect(windows.map((window) => [window.month, window.before])).toEqual([
    ["2026-05", true],
    ["2026-06", true],
    ["2026-07", true],
    ["2026-08", false],
    ["2026-09", false],
    ["2026-10", false],
  ]);
  // The month the books began in starts on the day they began.
  expect(windows[3]?.from).toBe("2026-08-15");
});

test("a book that has not started shows its first month, and one that has ended shows its last", () => {
  const notStarted = monthWindows(calendar, "2025-11-20");
  expect(notStarted[5]).toEqual({
    month: "2026-01",
    from: "2026-01-01",
    to: "2026-01-01",
    before: false,
  });
  expect(notStarted.slice(0, 5).every((window) => window.before)).toBe(true);
  const ended = monthWindows(calendar, "2027-03-09");
  expect(ended[5]).toEqual({
    month: "2026-12",
    from: "2026-12-01",
    to: "2026-12-31",
    before: false,
  });
});

test("the year so far starts on the first day of the fiscal year, never before the calendar began", () => {
  const fiscalYears = [{ year: 2026, startsOn: "2026-01-01", endsOn: "2026-12-31" }];
  const setup = { fiscalYear: 2026 };
  expect(yearStart({ firstDate: "2026-01-01", fiscalYears }, setup, "2026-10-05")).toBe(
    "2026-01-01",
  );
  expect(yearStart({ firstDate: "2026-03-01", fiscalYears }, setup, "2026-10-05")).toBe(
    "2026-03-01",
  );
  const october = [{ year: 2025, startsOn: "2025-10-01", endsOn: "2026-09-30" }];
  expect(yearStart({ firstDate: "2025-10-01", fiscalYears: october }, setup, "2026-06-15")).toBe(
    "2025-10-01",
  );
  // With no fiscal year row to read, the year the book began in stands in.
  expect(
    yearStart(
      { firstDate: "2026-01-01", fiscalYears: [] },
      { fiscalYear: 2026, fiscalYearStartMonth: 4 },
      "2026-10-05",
    ),
  ).toBe("2026-04-01");
});

const windows = monthWindows({ firstDate: "2026-08-15", lastDate: "2027-08-14" }, "2026-10-05");
const month = (revenue: string, expenses: string) => ok({ revenue, expenses });
// The windows before the books have no read; a month's reads are in the order of the windows.
const reads = [
  failed("before"),
  failed("before"),
  failed("before"),
  month("1200.00", "300.00"),
  month("0.00", "0.00"),
  month("4170.00", "2682.44"),
];

test("the panel has a figure for each month it could read, and a reason for each it could not", () => {
  const view = moneyView(windows, reads, ok({ netIncome: "3278.41" }));
  expect(view.months.map((item) => item.short)).toEqual(["May", "Jun", "Jul", "Aug", "Sep", "Oct"]);
  expect(view.months.map((item) => item.name)).toEqual([
    shown.month("2026-05"),
    shown.month("2026-06"),
    shown.month("2026-07"),
    shown.month("2026-08"),
    shown.month("2026-09"),
    shown.month("2026-10"),
  ]);
  expect(view.months[0]).toMatchObject({
    income: null,
    expenses: null,
    note: "Before your books began",
  });
  expect(view.months[3]).toMatchObject({ income: "1200.00", expenses: "300.00" });
  expect(view.profit).toBe("3278.41");
  expect(view.any).toBe(true);
  expect(view.failed).toBe(false);
});

test("a month whose read failed says it could not be read, and is not a zero", () => {
  const view = moneyView(
    windows,
    [
      failed("before"),
      failed("before"),
      failed("before"),
      failed("boom"),
      month("0.00", "0.00"),
      month("10.00", "5.00"),
    ],
    failed("boom"),
  );
  expect(view.months[3]).toMatchObject({ income: null, expenses: null, note: "Could not be read" });
  expect(view.profit).toBeNull();
  expect(view.failed).toBe(false);
});

test("when no month could be read the panel says so, and when every figure is zero there is nothing to draw", () => {
  const nothing = moneyView(
    windows,
    [failed("before"), failed("before"), failed("before"), failed("x"), failed("x"), failed("x")],
    failed("x"),
  );
  expect(nothing.failed).toBe(true);
  expect(nothing.any).toBe(false);
  const zeros = moneyView(
    windows,
    [
      failed("before"),
      failed("before"),
      failed("before"),
      month("0.00", "0.00"),
      month("0.00", "0.00"),
      month("0.00", "0.00"),
    ],
    ok({ netIncome: "0.00" }),
  );
  expect(zeros.any).toBe(false);
  expect(zeros.failed).toBe(false);
});

test("a loss is a negative profit, with its sign", () => {
  const view = moneyView(windows, reads, ok({ netIncome: "-120.50" }));
  expect(view.profit).toBe("-120.50");
});

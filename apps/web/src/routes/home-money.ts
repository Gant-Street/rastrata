/** "Money in and out": the last six months, in and out, from the same statements the Reports screen
 * shows (`reports.get`), one read for each month and one for the year so far, all at once. Months the
 * books had not begun are said so and not drawn as zero, and a month whose read failed says that
 * instead of a figure. Pure where it can be: `monthWindows` and `moneyView` are tested without a
 * service. */
import type { BookSetup, ReportCalendar } from "@rastrata/application/client-contracts";
import type { MoneyMonthView } from "@rastrata/ui/home-types";
import { homeWords } from "@rastrata/ui/home-words";
import { daysInMonth, formatMonth, monthName, parseDate } from "@rastrata/ui/format";
import type { BrowserApplicationClient } from "../application-client";
import { type Read, settle } from "./home-facts";

export const MONTHS = 6;

export interface MonthWindow {
  /** "2026-04". */
  readonly month: string;
  /** The first and last day to read, inside the book's calendar and no later than today. */
  readonly from: string;
  readonly to: string;
  /** Why there is nothing to read: the month ended before the book's calendar began. */
  readonly before: boolean;
}

const pad = (value: number): string => String(value).padStart(2, "0");

/** The calendar month `back` months before `year`-`month`. */
function shiftMonth(year: number, month: number, back: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) - back;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** The six months that end with the one today falls in, oldest first. Today is held inside the book's
 * calendar, so a book that has not started or has ended shows its first or last month and not an error. */
export function monthWindows(
  calendar: { readonly firstDate: string; readonly lastDate: string },
  today: string,
  count: number = MONTHS,
): MonthWindow[] {
  const anchorDate =
    today < calendar.firstDate
      ? calendar.firstDate
      : today > calendar.lastDate
        ? calendar.lastDate
        : today;
  const anchor = parseDate(anchorDate);
  if (!anchor) return [];
  return Array.from({ length: count }, (_, index) => {
    const { year, month } = shiftMonth(anchor.year, anchor.month, count - 1 - index);
    const first = `${year}-${pad(month)}-01`;
    const last = `${year}-${pad(month)}-${pad(daysInMonth(year, month))}`;
    const to = [last, calendar.lastDate, anchorDate].reduce((a, b) => (a < b ? a : b));
    return {
      month: `${year}-${pad(month)}`,
      from: first < calendar.firstDate ? calendar.firstDate : first,
      to,
      before: last < calendar.firstDate,
    };
  });
}

/** The first day of the fiscal year `asOf` falls in, never before the calendar began. */
export function yearStart(
  calendar: Pick<ReportCalendar, "firstDate" | "fiscalYears">,
  setup: Pick<BookSetup, "fiscalYear" | "fiscalYearStartMonth">,
  asOf: string,
): string {
  const span = calendar.fiscalYears.find((year) => year.startsOn <= asOf && asOf <= year.endsOn);
  const start = span?.startsOn ?? `${setup.fiscalYear}-${pad(setup.fiscalYearStartMonth ?? 1)}-01`;
  return start < calendar.firstDate ? calendar.firstDate : start;
}

/** What one month's profit and loss said. */
export interface MonthRead {
  readonly revenue: string;
  readonly expenses: string;
}

export interface MoneyView {
  readonly months: readonly MoneyMonthView[];
  /** The profit so far this fiscal year, or null when it could not be read. */
  readonly profit: string | null;
  /** At least one month has a figure that is not zero: there is something to draw. */
  readonly any: boolean;
  /** Not one month could be read. */
  readonly failed: boolean;
}

/** The six months as the panel shows them: a figure, "before your books began", or "could not be read".
 * `reads` is in the order of `windows`; a month before the books has no read to look at. */
export function moneyView(
  windows: readonly MonthWindow[],
  reads: readonly Read<MonthRead>[],
  year: Read<{ readonly netIncome: string }>,
): MoneyView {
  const months = windows.map((window, index): MoneyMonthView => {
    const read = reads[index];
    const base = {
      month: window.month,
      name: formatMonth(window.month),
      short: monthName(Number(window.month.slice(5, 7))).slice(0, 3),
    };
    if (window.before)
      return { ...base, income: null, expenses: null, note: homeWords.money.beforeBooks };
    if (!read?.ok) return { ...base, income: null, expenses: null, note: homeWords.money.notRead };
    return { ...base, income: read.value.revenue, expenses: read.value.expenses };
  });
  const asked = windows.flatMap((window, index) => (window.before ? [] : [reads[index]]));
  return {
    months,
    profit: year.ok ? year.value.netIncome : null,
    any: months.some((month) => !isZero(month.income) || !isZero(month.expenses)),
    failed: asked.length > 0 && asked.every((read) => !read?.ok),
  };
}

const isZero = (value: string | null): boolean => value === null || /^-?0+(\.0+)?$/.test(value);

/** Reads the six months and the year so far. Every read stands alone; the panel decides what a failed
 * one means. */
export async function loadMoney(
  client: BrowserApplicationClient,
  setup: BookSetup,
  today: string,
): Promise<MoneyView> {
  const calendar = await client.read("reports.calendar", {});
  const windows = monthWindows(calendar, today);
  const last = windows[windows.length - 1];
  const asOf = last?.to ?? today;
  const [reads, year] = await Promise.all([
    Promise.all(
      windows.map((window) =>
        window.before
          ? Promise.resolve<Read<MonthRead>>({ ok: false, message: "before" })
          : settle(async () => {
              const report = await client.read("reports.get", {
                asOf: window.to,
                from: window.from,
              });
              return {
                revenue: report.profitAndLoss.revenue,
                expenses: report.profitAndLoss.expenses,
              };
            }),
      ),
    ),
    settle(async () => {
      const report = await client.read("reports.get", {
        asOf,
        from: yearStart(calendar, setup, asOf),
      });
      return { netIncome: report.profitAndLoss.netIncome };
    }),
  ]);
  return moneyView(windows, reads, year);
}

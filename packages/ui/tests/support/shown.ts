/** What a person sees where the book holds a date, an instant or an amount.
 *
 * A test reads a displayed value through `shown` and never writes the literal ("Mar 20, 2026"), so
 * how a date reads is one decision, in `packages/ui/src/format.ts`, and not an edit in every
 * assertion. Each helper calls the same function the screens call, so the test and the page cannot
 * drift apart.
 *
 *   await expect(page.getByText(shown.date("2026-03-20"))).toBeVisible();
 *   expect(describeRange(range)).toBe(shown.range("2026-03-01", "2026-03-31"));
 *
 * Give it the value the book stores (an ISO date, an ISO instant, a wire amount), not text read off
 * the page. This module exists twice, for the component tests (`packages/ui/tests/support/shown.ts`)
 * and for the web application's (`apps/web/tests/support/shown.ts`); the two differ only in where
 * they import the formatter from, and `apps/web/tests/unit/shown.test.ts` fails when they drift.
 *
 * An instant is shown on the viewer's own clock, and a test's viewer is in UTC: both Playwright
 * configs fix the browser's zone to UTC and `bun test` runs in UTC. The process is pinned to UTC
 * here too, so a developer's own TZ never reaches an assertion. A test that opens a page in another
 * zone (`test.use({ timezoneId })`) names that zone: `shown.instant(iso, "America/Denver")`. */
import {
  type DateFormat,
  formatAge,
  formatDate,
  formatDateRange,
  formatFiguresInText,
  formatInstant,
  formatMonth,
  formatMoney,
  formatMoneyAbsolute,
  formatTime,
} from "../../src/format";

process.env.TZ = "UTC";

export const shown = {
  /** A date, or the day an instant falls on in the viewer's zone, as the app shows it. */
  date: (iso: string, timeZone = "UTC"): string => formatDate(iso, { timeZone }),
  /** A date as the box of a date field holds it, once the box is left: in numbers, month first. */
  dateBox: (iso: string): string => formatDate(iso, { format: "numeric" }),
  /** An instant with its time of day, on the viewer's clock, as the app shows it. */
  instant: (iso: string, timeZone = "UTC"): string => formatInstant(iso, { timeZone }),
  /** A date as the app shows it when the book's date format is `format` (the default is "medium"). */
  dateAs: (format: DateFormat, iso: string): string => formatDate(iso, { format }),
  /** A range as the app shows it when the book's date format is `format`. */
  rangeAs: (format: DateFormat, from: string, to: string): string =>
    formatDateRange(from, to, { format }),
  /** A wire amount ("-1234.50") as the app shows it. */
  money: (wire: string): string => formatMoney(wire),
  /** A wire amount without its sign, for a column that already says which way the money went. */
  moneyAbsolute: (wire: string): string => formatMoneyAbsolute(wire),
  /** Two dates as one phrase, as the app shows a range. */
  range: (from: string, to: string): string => formatDateRange(from, to),
  /** A whole month on its own, from "2026-09" or any date in it. */
  month: (iso: string): string => formatMonth(iso),
  /** The time of day on a clock, as a line that says when something was read shows it. */
  time: (now: Date, timeZone = "UTC"): string => formatTime(now, { timeZone }),
  /** How long ago an instant was, from the clock a screen was given. */
  age: (iso: string, now: Date): string => formatAge(iso, now),
  /** A sentence the service wrote, with its dates, instants and amounts shown as every other is. */
  text: (sentence: string): string => formatFiguresInText(sentence),
};

import { daysInMonth, formatDateRange, isDate, parseDate } from "../format";

/** The periods a person can ask for, named the way Xero and QuickBooks name them. Every one except `custom`
 * and `all` is worked out from the book's own fiscal calendar and today, so a fiscal year that starts in
 * October has October as its first month and "this quarter" is its quarter, not the calendar's.
 *
 * `all` is every date: no range, and so `{ preset: "all", from: "", to: "" }`. It is for a register or a list
 * that should start by showing everything (a default of the fiscal year to date would hide a draft, or an
 * entry dated next month), so it is offered only where a screen lists it in `presets`. */
export type RangePresetId =
  | "thisMonth"
  | "lastMonth"
  | "thisQuarter"
  | "lastQuarter"
  | "fiscalYearToDate"
  | "lastFiscalYear"
  | "custom"
  | "all";

/** The order the presets are offered in, and the default set. `all` is not in it: a screen asks for it. */
export const RANGE_PRESETS: readonly RangePresetId[] = [
  "thisMonth",
  "lastMonth",
  "thisQuarter",
  "lastQuarter",
  "fiscalYearToDate",
  "lastFiscalYear",
  "custom",
];

/** Two local dates, `YYYY-MM-DD`, both inclusive. Not an instant: nothing here reads a clock or a zone. */
export interface RangeDates {
  readonly from: string;
  readonly to: string;
}

/** What the field holds: the preset the dates came from, and the dates. Custom dates are as typed, so a
 * half-typed date can sit in the field (an unfinished native date input is the empty string). */
export interface DateRangeValue extends RangeDates {
  readonly preset: RangePresetId;
}

/** The book's fiscal calendar and today. `years` is what `reports.calendar` calls `fiscalYears`; only the
 * first and last days of each are used. `today` is injected, so a screen and a test agree. */
export interface FiscalCalendar {
  readonly years: readonly { readonly startsOn: string; readonly endsOn: string }[];
  readonly today: string;
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");
const iso = (year: number, month: number, day: number) =>
  `${pad(year, 4)}-${pad(month)}-${pad(day)}`;

/** Months counted from year 0, so a month before or after another is a subtraction. */
const monthIndex = (year: number, month: number) => year * 12 + (month - 1);
const startOf = (index: number) => iso(Math.floor(index / 12), (index % 12) + 1, 1);
const endOf = (index: number) => {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return iso(year, month, daysInMonth(year, month));
};

/** The first and last days the book's calendar covers, or `undefined` when it has no years. */
export function calendarBounds(
  calendar: FiscalCalendar,
): { readonly first: string; readonly last: string } | undefined {
  if (calendar.years.length === 0) return undefined;
  const starts = calendar.years.map((year) => year.startsOn).sort();
  const ends = calendar.years.map((year) => year.endsOn).sort();
  return { first: starts[0] as string, last: ends.at(-1) as string };
}

/** The dates a preset stands for today, or `undefined` when this book's calendar does not cover them (a
 * month before the books began, "last fiscal year" in the first year) or the calendar is not known. The
 * fiscal year to date is held inside the calendar, so the default never asks for a date the book cannot
 * report: after the last year it is that whole year, and before the first it is the first year. */
export function presetRange(
  preset: Exclude<RangePresetId, "custom">,
  calendar: FiscalCalendar,
): RangeDates | undefined {
  // Every date has no dates to give.
  if (preset === "all") return undefined;
  const bounds = calendarBounds(calendar);
  const today = parseDate(calendar.today);
  const first = calendar.years
    .flatMap((year) => {
      const parts = parseDate(year.startsOn);
      return parts ? [parts] : [];
    })
    .sort(byDate)[0];
  if (!bounds || !today || !first) return undefined;

  const now = monthIndex(today.year, today.month);
  // Months into the fiscal year (0 to 11): the book's first year says which month a year starts in.
  const into = (((today.month - first.month) % 12) + 12) % 12;
  const inside = (range: RangeDates): RangeDates | undefined =>
    range.from >= bounds.first && range.to <= bounds.last ? range : undefined;

  switch (preset) {
    case "thisMonth":
      return inside({ from: startOf(now), to: endOf(now) });
    case "lastMonth":
      return inside({ from: startOf(now - 1), to: endOf(now - 1) });
    case "thisQuarter": {
      const start = now - (into % 3);
      return inside({ from: startOf(start), to: endOf(start + 2) });
    }
    case "lastQuarter": {
      const start = now - (into % 3) - 3;
      return inside({ from: startOf(start), to: endOf(start + 2) });
    }
    case "fiscalYearToDate": {
      if (calendar.today > bounds.last) return lastYearOf(calendar);
      if (calendar.today < bounds.first) return firstYearOf(calendar);
      const from = startOf(now - into);
      return { from: from < bounds.first ? bounds.first : from, to: calendar.today };
    }
    case "lastFiscalYear":
      return inside({ from: startOf(now - into - 12), to: endOf(now - into - 1) });
  }
}

const byDate = (a: { year: number; month: number; day: number }, b: typeof a) =>
  a.year - b.year || a.month - b.month || a.day - b.day;

function lastYearOf(calendar: FiscalCalendar): RangeDates | undefined {
  const year = [...calendar.years].sort((a, b) => a.startsOn.localeCompare(b.startsOn)).at(-1);
  return year ? { from: year.startsOn, to: year.endsOn } : undefined;
}

function firstYearOf(calendar: FiscalCalendar): RangeDates | undefined {
  const year = [...calendar.years].sort((a, b) => a.startsOn.localeCompare(b.startsOn))[0];
  return year ? { from: year.startsOn, to: year.endsOn } : undefined;
}

/** The value a field starts on: the fiscal year to date, which always exists when the calendar does. */
export function defaultRange(calendar: FiscalCalendar): DateRangeValue | undefined {
  const dates = presetRange("fiscalYearToDate", calendar);
  return dates ? { preset: "fiscalYearToDate", ...dates } : undefined;
}

/** The preset a pair of dates is today, or `custom` when it is none: for a screen that has only the dates
 * (an old link) and wants the field to say which period they are. `all` is never inferred: a pair of dates
 * is a range, and a screen that means every date says so with the preset. */
export function presetOf(dates: RangeDates, calendar: FiscalCalendar): RangePresetId {
  for (const preset of RANGE_PRESETS) {
    if (preset === "custom") continue;
    const range = presetRange(preset, calendar);
    if (range && range.from === dates.from && range.to === dates.to) return preset;
  }
  return "custom";
}

/** What is wrong with a custom range, or `undefined` when it can be used. `incomplete` is a date missing
 * or not a real date (so a half-typed one is not an error until a person leaves the field). */
export type RangeProblem =
  | { readonly kind: "incomplete" }
  | { readonly kind: "order" }
  | { readonly kind: "outside"; readonly first: string; readonly last: string };

export function dateRangeProblem(
  dates: RangeDates,
  calendar: FiscalCalendar,
): RangeProblem | undefined {
  if (!isDate(dates.from) || !isDate(dates.to)) return { kind: "incomplete" };
  if (dates.from > dates.to) return { kind: "order" };
  const bounds = calendarBounds(calendar);
  if (bounds && (dates.from < bounds.first || dates.to > bounds.last))
    return { kind: "outside", first: bounds.first, last: bounds.last };
  return undefined;
}

/** Whether a value can be asked for: a preset always can, every date always can, custom dates when they are
 * a real, ordered range inside the calendar. A screen reads reports only when this is true. */
export function isUsableRange(value: DateRangeValue, calendar: FiscalCalendar): boolean {
  if (value.preset === "all") return true;
  return value.preset === "custom"
    ? dateRangeProblem(value, calendar) === undefined
    : isDate(value.from) && isDate(value.to);
}

/** What a range with no dates says. */
const EVERY_DATE = "Every date";

/** The dates as one phrase for the line under the field, in the product's one way of writing a range. Every
 * date (the `all` preset, or a range with neither end) says "Every date"; `every` rewords that. */
export function describeDates(
  dates: RangeDates & { readonly preset?: RangePresetId | undefined },
  every: string = EVERY_DATE,
): string {
  return dates.preset === "all" || (dates.from === "" && dates.to === "")
    ? every
    : formatDateRange(dates.from, dates.to);
}

/** Fiscal calendar arithmetic for the calendar lane. Pure and portable: dates are `YYYY-MM-DD`
 * strings and every step works on integer year, month and day numbers. `Date.UTC` is used only to
 * count the days in a month, so nothing here ever passes through a time zone.
 *
 * Vocabulary
 * - A fiscal year is named by the calendar year in which it starts. With a fiscal year start month
 *   of 10, fiscal year 2026 runs 2026-10-01 to 2027-09-30.
 * - A period is one month or one quarter of a fiscal year. Ordinals count from 1 inside the year. */

export type PeriodModel = "monthly" | "quarterly";
export type BookBasis = "cash" | "accrual";

/** A book that omits `basis` is an accrual book (the only kind there was before this field). */
export const DEFAULT_BASIS: BookBasis = "accrual";
/** A book that omits `fiscalYearStartMonth` has a calendar-year fiscal year. */
export const DEFAULT_FISCAL_YEAR_START_MONTH = 1;
/** The range `book.setup` has always accepted for `fiscalYear`; extension stays inside it. */
export const MIN_FISCAL_YEAR = 2000;
export const MAX_FISCAL_YEAR = 2100;

export interface CalendarShape {
  /** 1 to 12. */
  readonly fiscalYearStartMonth: number;
  readonly periodModel: PeriodModel;
}

export interface PeriodSpec {
  readonly fiscalYear: number;
  /** 1-based position inside the fiscal year. */
  readonly ordinal: number;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly label: string;
}

export interface FiscalYearBounds {
  readonly fiscalYear: number;
  readonly startsOn: string;
  readonly endsOn: string;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

export function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one (month is 1-based here).
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** True for a real calendar date written `YYYY-MM-DD`. */
export function isDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function parts(date: string): { year: number; month: number; day: number } {
  if (!isDate(date)) throw new RangeError(`Invalid local date: ${date}`);
  return {
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(5, 7)),
    day: Number(date.slice(8)),
  };
}

/** The date `days` after `date` (negative for before). Calendar arithmetic only. */
export function addDays(date: string, days: number): string {
  const { year, month, day } = parts(date);
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return `${pad(moved.getUTCFullYear(), 4)}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`;
}

export const periodsPerYear = (model: PeriodModel): number => (model === "monthly" ? 12 : 4);
const monthsPerPeriod = (model: PeriodModel): number => (model === "monthly" ? 1 : 3);

function monthAt(
  fiscalYear: number,
  startMonth: number,
  offset: number,
): { year: number; month: number } {
  const zeroBased = startMonth - 1 + offset;
  return { year: fiscalYear + Math.floor(zeroBased / 12), month: (zeroBased % 12) + 1 };
}

/** Every period of one fiscal year, in order. */
export function fiscalYearPeriods(fiscalYear: number, shape: CalendarShape): PeriodSpec[] {
  const step = monthsPerPeriod(shape.periodModel);
  return Array.from({ length: periodsPerYear(shape.periodModel) }, (_, index) => {
    const first = monthAt(fiscalYear, shape.fiscalYearStartMonth, index * step);
    const last = monthAt(fiscalYear, shape.fiscalYearStartMonth, index * step + step - 1);
    return {
      fiscalYear,
      ordinal: index + 1,
      startsOn: `${pad(first.year, 4)}-${pad(first.month)}-01`,
      endsOn: `${pad(last.year, 4)}-${pad(last.month)}-${pad(daysInMonth(last.year, last.month))}`,
      // A label names the period inside its fiscal year ("January", "Q1"), exactly as books have
      // always labelled them. The year is in `fiscalYear` and the dates, never in the label.
      label:
        shape.periodModel === "monthly" ? (MONTH_NAMES[first.month - 1] ?? "") : `Q${index + 1}`,
    };
  });
}

export function fiscalYearBounds(fiscalYear: number, shape: CalendarShape): FiscalYearBounds {
  const periods = fiscalYearPeriods(fiscalYear, shape);
  const first = periods[0];
  const last = periods[periods.length - 1];
  if (!first || !last) throw new Error("A fiscal year has periods");
  return { fiscalYear, startsOn: first.startsOn, endsOn: last.endsOn };
}

/** The fiscal year that contains `date`, named by the calendar year in which it starts. */
export function fiscalYearOf(date: string, fiscalYearStartMonth: number): number {
  const { year, month } = parts(date);
  return month >= fiscalYearStartMonth ? year : year - 1;
}

/** Period identity. The first fiscal year keeps the ids every book has always had (`period-01`);
 * later years add the fiscal year (`period-2027-01`). Ids are never reused and never edited.
 *
 * A calendar drawn again under another fiscal-year month (`planYearStart`) carries a tag, `m10` for
 * October (`period-m10-01`, `period-m10-2027-01`): the old ids would otherwise name other months, and an
 * id that someone remembered from before the change must fail, not mean a different month. */
export function periodIdFor(
  fiscalYear: number,
  ordinal: number,
  firstFiscalYear: number,
  tag?: string,
): string {
  const prefix = tag ? `period-${tag}` : "period";
  return fiscalYear === firstFiscalYear
    ? `${prefix}-${pad(ordinal)}`
    : `${prefix}-${fiscalYear}-${pad(ordinal)}`;
}

/** The tag a period id carries (`m10`), if it has one. */
export const periodIdTag = (id: string): string | undefined => /^period-(m\d{1,2})-/.exec(id)?.[1];

/** The kernel needs a unique positive sequence per period; it simply counts on across years. */
export function periodSequenceFor(
  fiscalYear: number,
  ordinal: number,
  firstFiscalYear: number,
  model: PeriodModel,
): number {
  return (fiscalYear - firstFiscalYear) * periodsPerYear(model) + ordinal;
}

/** Accept only a plain integer from 1 to 12. */
export const isStartMonth = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 12;

export const isBasis = (value: unknown): value is BookBasis =>
  value === "cash" || value === "accrual";

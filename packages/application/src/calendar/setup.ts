import type { BookSetup } from "../contracts.ts";
import {
  DEFAULT_BASIS,
  DEFAULT_FISCAL_YEAR_START_MONTH,
  MAX_FISCAL_YEAR,
  fiscalYearOf,
  type BookBasis,
  type CalendarShape,
  type PeriodModel,
} from "./fiscal-calendar.ts";

/** A setup with every calendar field spelled out. A book stores the setup as it was given, so an
 * older book simply lacks `basis` and `fiscalYearStartMonth`; reading resolves them to the
 * defaults the contract promises (accrual, January) instead of rewriting what was stored. */
export interface ResolvedSetup extends BookSetup {
  readonly periodModel: PeriodModel;
  readonly basis: BookBasis;
  readonly fiscalYearStartMonth: number;
}

export function resolveSetup(
  stored: Omit<BookSetup, "periodModel"> & { readonly periodModel?: PeriodModel },
): ResolvedSetup {
  return {
    ...stored,
    periodModel: stored.periodModel ?? "monthly",
    basis: stored.basis ?? DEFAULT_BASIS,
    fiscalYearStartMonth: stored.fiscalYearStartMonth ?? DEFAULT_FISCAL_YEAR_START_MONTH,
  };
}

export const calendarShape = (setup: ResolvedSetup): CalendarShape => ({
  fiscalYearStartMonth: setup.fiscalYearStartMonth,
  periodModel: setup.periodModel,
});

/** True when two setups describe the same book once defaults are applied, so a retried request
 * that omits a default and one that spells it out are the same request. */
export function sameSetup(left: BookSetup, right: BookSetup): boolean {
  const a = resolveSetup(left);
  const b = resolveSetup(right);
  return (
    a.name === b.name &&
    a.currency === b.currency &&
    a.fiscalYear === b.fiscalYear &&
    a.periodModel === b.periodModel &&
    a.basis === b.basis &&
    a.fiscalYearStartMonth === b.fiscalYearStartMonth &&
    a.booksStartOn === b.booksStartOn &&
    // A book keeps the last year it was built through, so a retry that leaves it out is the same request.
    (a.calendarThrough === undefined ||
      b.calendarThrough === undefined ||
      a.calendarThrough === b.calendarThrough) &&
    JSON.stringify(a.accounts) === JSON.stringify(b.accounts)
  );
}

/** The first day of the books: the day the setup names, else the first day of the first fiscal
 * year (every book made before the setup could name one). The calendar may start earlier than this. */
export function booksFirstDay(setup: {
  readonly fiscalYear: number;
  readonly fiscalYearStartMonth?: number | undefined;
  readonly booksStartOn?: string | undefined;
}): string {
  const month = String(setup.fiscalYearStartMonth ?? DEFAULT_FISCAL_YEAR_START_MONTH);
  return setup.booksStartOn ?? `${setup.fiscalYear}-${month.padStart(2, "0")}-01`;
}

/** The last fiscal year a new book's calendar covers: the one it is created in or the one its books begin
 * in, whichever is later, and never one before its first. Later years are added as postings need them,
 * or by extending the calendar, which only grows forward. */
export function calendarThroughFor(
  setup: Pick<ResolvedSetup, "fiscalYear" | "fiscalYearStartMonth" | "booksStartOn">,
  today: string,
): number {
  const created = fiscalYearOf(today, setup.fiscalYearStartMonth);
  const begins =
    setup.booksStartOn === undefined
      ? setup.fiscalYear
      : fiscalYearOf(setup.booksStartOn, setup.fiscalYearStartMonth);
  return Math.min(MAX_FISCAL_YEAR, Math.max(setup.fiscalYear, created, begins));
}

/** The last fiscal year the book's calendar was built through when it was created. */
export const calendarEndYear = (
  setup: Pick<ResolvedSetup, "fiscalYear" | "calendarThrough">,
): number => setup.calendarThrough ?? setup.fiscalYear;

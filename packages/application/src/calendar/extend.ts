import type { BookState, FiscalPeriod } from "@rastrata/kernel";
import { ApplicationError } from "../errors.ts";
import {
  MAX_FISCAL_YEAR,
  addDays,
  fiscalYearOf,
  periodIdTag,
  type CalendarShape,
} from "./fiscal-calendar.ts";
import { calendarCoverage, kernelFiscalYear } from "./kernel-calendar.ts";

/** The most fiscal years one extension adds. A calendar is a statement about the future the owner
 * can see; ten years is far past any plan and keeps one command small. */
export const MAX_EXTENSION_YEARS = 10;

export interface ExtensionPlan {
  /** The last fiscal year the extension covers. */
  readonly through: number;
  /** The fiscal years it adds, in order. */
  readonly fiscalYears: readonly number[];
  /** The periods it adds: existing periods are never changed or removed. */
  readonly added: readonly FiscalPeriod[];
  /** The first day of the first period added; the kernel needs it to fall after every journal. */
  readonly effectiveOn: string;
}

/** The first and last fiscal year the book's regular periods define. */
export function fiscalYearRange(state: BookState): { first: number; last: number } {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const period of state.periods) {
    if (period.kind !== "regular") continue;
    const year = Number(period.fiscalYear);
    if (year < first) first = year;
    if (year > last) last = year;
  }
  if (!Number.isFinite(first)) throw new Error("A book has periods");
  return { first, last };
}

/** What an extension through `through` (default: one more fiscal year) adds to this book's calendar.
 * Pure: it only reads the state. The caller seals the result in a `replaceConfiguration` command. */
export function planExtension(
  state: BookState,
  shape: CalendarShape,
  firstFiscalYear: number,
  through?: number,
): ExtensionPlan {
  const { last } = fiscalYearRange(state);
  const lastEnds = calendarCoverage(state.periods).endsOn;
  const target = through ?? last + 1;
  if (!Number.isSafeInteger(target) || target > MAX_FISCAL_YEAR)
    throw new ApplicationError(
      "invalid_input",
      `The calendar can run through fiscal year ${MAX_FISCAL_YEAR} at most.`,
      400,
      [{ path: "input.through", message: `Use a fiscal year up to ${MAX_FISCAL_YEAR}` }],
    );
  if (target <= last)
    throw new ApplicationError(
      "calendar_already_covers",
      `The calendar already covers fiscal year ${target} (it runs through ${lastEnds}). There is nothing to extend.`,
      409,
      [{ path: "input.through", message: `Fiscal year ${target} is already in the calendar` }],
    );
  if (target - last > MAX_EXTENSION_YEARS)
    throw new ApplicationError(
      "invalid_input",
      `Extend by at most ${MAX_EXTENSION_YEARS} fiscal years at a time; the calendar runs through fiscal year ${last}.`,
      400,
      [{ path: "input.through", message: `Use a fiscal year up to ${last + MAX_EXTENSION_YEARS}` }],
    );
  const fiscalYears = Array.from({ length: target - last }, (_, index) => last + 1 + index);
  // Sequences count on from the calendar's newest period. For an ordinary calendar that is what the
  // fiscal year and the position in it give; a calendar drawn again under another fiscal-year month
  // (`planYearStart`) has a first year of another length, so only the count is right.
  const newest = state.periods.reduce(
    (most, period) => (period.sequence > most ? period.sequence : most),
    0n,
  );
  // A calendar drawn again under another month tags its ids; what it adds carries the same tag.
  const newestPeriod = state.periods.find((period) => period.sequence === newest);
  const idTag = newestPeriod ? periodIdTag(newestPeriod.id as string) : undefined;
  const added = fiscalYears
    .flatMap((year) =>
      kernelFiscalYear(year, shape, state.identity.fiscalCalendarId, firstFiscalYear, idTag),
    )
    .map((period, index) => ({ ...period, sequence: newest + BigInt(index + 1) }));
  const first = added[0];
  // The calendar is gap-free by construction. A book whose last period does not end the day before
  // the next fiscal year would start must not be extended into a gap.
  if (!first || first.startsOn !== addDays(lastEnds, 1))
    throw new ApplicationError(
      "calendar_not_extendable",
      `The calendar ends on ${lastEnds}, which does not meet the start of fiscal year ${last + 1} under this book's fiscal year start month. It cannot be extended without a gap.`,
      409,
    );
  return { through: target, fiscalYears, added, effectiveOn: first.startsOn };
}

/** The fiscal year to extend through so that `date` is covered, or null when no extension helps: the
 * date is before the book's first period (which can never move) or past the last supported year. */
export function extendThroughFor(
  state: BookState,
  shape: CalendarShape,
  date: string,
): number | null {
  if (date < calendarCoverage(state.periods).startsOn) return null;
  const fiscalYear = fiscalYearOf(date, shape.fiscalYearStartMonth);
  return fiscalYear > fiscalYearRange(state).last && fiscalYear <= MAX_FISCAL_YEAR
    ? fiscalYear
    : null;
}

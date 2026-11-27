import { daysBetween } from "../format";
import type { FiscalYearView } from "./types";

/** Pure decisions the calendar screens and the Home card share. Dates are `YYYY-MM-DD` strings and
 * are only compared as strings or counted in whole days through UTC, never through a time zone. */

/** A period needs closing when it is open, or locked with a close that was superseded. */
export const needsClose = (period: {
  status: "open" | "closed";
  closeSuperseded: boolean;
}): boolean => period.status === "open" || period.closeSuperseded;

/** The fiscal year to show first: the earliest one that has ended and still needs work (that is what
 * waits longest), otherwise the earliest one with work left, otherwise the last year. A year that
 * ended before the books began has nothing to close. */
export function defaultFiscalYear(years: readonly FiscalYearView[]): number | undefined {
  const needing = years.filter((year) => year.status !== "closed" && !year.beforeBooks);
  const ended = needing.find((year) => year.ended);
  return (ended ?? needing[0] ?? years[years.length - 1])?.fiscalYear;
}

export interface CardPeriod {
  readonly label: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly fiscalYear: number;
  readonly status: "open" | "closed";
  readonly closeSuperseded: boolean;
  readonly ended: boolean;
  /** Ends before the books began: never counted as open. */
  readonly beforeBooks: boolean;
}

export interface CardInput {
  readonly today: string;
  readonly lastDate: string;
  readonly canExtend: boolean;
  readonly years: readonly FiscalYearView[];
  readonly periods: readonly CardPeriod[];
}

export interface CardSummary {
  /** Ended periods that are still open or whose close was superseded. */
  readonly endedOpen: number;
  /** The earliest fiscal year that has ended and still has a period to close. */
  readonly yearToClose: number | null;
  /** The latest period up to which every period has a current close, named with its year. */
  readonly closedThrough: string | null;
  /** Whether the calendar is about to run out of dates to post to. */
  readonly calendar: "fine" | "ending" | "ended";
  readonly lastDate: string;
  readonly canExtend: boolean;
}

/** How many days before the calendar's end the Home card starts saying so. */
export const CALENDAR_WARNING_DAYS = 31;

export function cardSummary(input: CardInput): CardSummary {
  const ordered = [...input.periods].sort((left, right) =>
    left.startsOn < right.startsOn ? -1 : left.startsOn > right.startsOn ? 1 : 0,
  );
  // A period before the books began holds none of the books' own activity: it is not "still open".
  const endedOpen = ordered.filter(
    (period) => period.ended && needsClose(period) && !period.beforeBooks,
  ).length;
  const yearToClose =
    input.years.find((year) => year.ended && year.status !== "closed" && !year.beforeBooks)
      ?.fiscalYear ?? null;
  let closedThrough: string | null = null;
  for (const period of ordered) {
    if (period.beforeBooks) continue;
    if (period.status !== "closed" || period.closeSuperseded) break;
    // Named by the year it starts in, as everywhere else: a quarter from November to January is
    // "Q1 2026", not "Q1 2027".
    closedThrough = `${period.label} ${period.startsOn.slice(0, 4)}`;
  }
  const remaining = daysBetween(input.today, input.lastDate);
  return {
    endedOpen,
    yearToClose,
    closedThrough,
    calendar: remaining < 0 ? "ended" : remaining <= CALENDAR_WARNING_DAYS ? "ending" : "fine",
    lastDate: input.lastDate,
    canExtend: input.canExtend,
  };
}

/** A person's name for a fiscal year status, for a picker option. */
export function yearStatusWord(
  status: FiscalYearView["status"],
  words: { open: string; partlyClosed: string; closed: string },
): string {
  return words[status];
}

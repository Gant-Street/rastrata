import type { BookState, ClosePackage } from "@rastrata/kernel";
import {
  MAX_FISCAL_YEAR,
  fiscalYearBounds,
  type CalendarShape,
  type PeriodModel,
} from "./fiscal-calendar.ts";
import { periodsWithEntries } from "./period-entries.ts";
import { yearStartBlocker } from "./year-start.ts";

/** A period as the Periods screen, the CLI and an agent read it. Everything here is derived from
 * the book's own state (its periods, closes and reopenings) and today's date; nothing is stored.
 *
 * Two facts about a closed period are kept apart because the kernel keeps them apart:
 * - it is **locked**: the last thing that happened to the period itself was a close, so nothing can
 *   be posted into it. `status` is "closed" exactly when the period is locked.
 * - its close is **current** or **superseded**. Reopening a period supersedes the close of every
 *   period that ends on or after it (their recorded figures no longer describe the books), but it
 *   does not unlock them: each stays locked until it is reopened itself. */
export interface PeriodView {
  readonly id: string;
  readonly label: string;
  readonly startsOn: string;
  readonly endsOn: string;
  /** "closed" when the period is locked against posting, whether or not its close is current. */
  readonly status: "open" | "closed";
  /** The close in force, or null when the period is open or its close was superseded. */
  readonly closePackageId: string | null;
  readonly reportPopulationHash: string | null;
  readonly closingRevision: string | null;
  readonly fiscalYear: number;
  /** 1-based position inside its fiscal year. */
  readonly ordinal: number;
  /** The period's last day is before today, so nothing more is expected to be posted in it. */
  readonly ended: boolean;
  /** Locked, but its close was superseded by the reopening of an earlier period: it needs to be
   * reopened and closed again before its close describes the books. */
  readonly closeSuperseded: boolean;
  /** The other periods whose current closes reopening this one would supersede (they stay locked).
   * Empty unless this period is locked with a current close. */
  readonly supersedes: readonly string[];
  /** The same list under the name the first release gave it (the contract is frozen). These periods
   * are not reopened by reopening this one; read `supersedes`. */
  readonly alsoReopens: readonly string[];
  /** The period ends before the day the books began (the recorded cutover date). It holds none of the
   * books' own activity and belongs to nobody's books, so it is left out of every count of periods
   * still open, of the warnings about closing out of order and of the year-end checklist; a year-end
   * still closes it with the rest. Always false when no cutover is recorded. */
  readonly beforeBooks: boolean;
  /** Nothing is recorded in the period: no entry is dated in it, and no bank transaction in the Inbox
   * is dated in it, whatever became of that transaction. False when the Inbox could not be read, so a
   * period is never called empty by mistake. A run of empty periods can be closed in one step. */
  readonly empty: boolean;
}

export interface FiscalYearView {
  readonly fiscalYear: number;
  readonly startsOn: string;
  readonly endsOn: string;
  /** The periods that count: every period of the year but those before the books began (when every
   * period of the year is before the books began, all of them). */
  readonly periodCount: number;
  /** Counted periods that are locked with a current close. */
  readonly closedCount: number;
  /** Counted periods that are locked but whose close was superseded. */
  readonly supersededCount: number;
  /** "closed" only when every counted period is locked with a current close. */
  readonly status: "open" | "partlyClosed" | "closed";
  readonly ended: boolean;
  /** Every period of the year ends before the books began: there is nothing in it to close. */
  readonly beforeBooks: boolean;
  /** How many of the year's periods end before the books began and are not counted above. */
  readonly periodsBeforeBooks: number;
}

export interface CalendarView {
  readonly today: string;
  readonly firstDate: string;
  readonly lastDate: string;
  readonly fiscalYearStartMonth: number;
  readonly periodModel: PeriodModel;
  readonly fiscalYears: readonly FiscalYearView[];
  readonly canExtend: boolean;
  /** The fiscal year an extension adds first, when one can be added. */
  readonly nextFiscalYear: number | null;
  readonly nextStartsOn: string | null;
  readonly nextEndsOn: string | null;
  /** Why the calendar cannot be extended, when it cannot. Empty otherwise. */
  readonly extendNote: string;
  /** The day the books began: the recorded cutover date, or null when none is recorded. Periods that
   * end before it are marked `beforeBooks`. */
  readonly booksBegan: string | null;
  /** Whether the month fiscal years start in can still be changed (`periods.changeYearStart`): only
   * while the book has no entry and no close. */
  readonly canChangeYearStart: boolean;
  /** Why it cannot, in a sentence; empty when it can. */
  readonly yearStartNote: string;
}

export interface PeriodHistoryView {
  readonly periodId: string;
  readonly kind: string;
  readonly reason: string;
  readonly recordedAt: string;
  readonly bookRevision: string;
  readonly supersededCloseIds: readonly string[];
  readonly supersededPeriodIds: readonly string[];
}

/** The close in force for each period: the latest close the book has not since superseded. */
export function currentCloses(state: BookState): Map<string, ClosePackage> {
  const superseded = new Set(
    state.periodTransitions.flatMap((transition) => transition.supersededCloseIds),
  );
  const current = new Map<string, ClosePackage>();
  for (const close of state.closePackages)
    if (!superseded.has(close.id)) current.set(close.periodId, close);
  return current;
}

/** The periods that are locked: those whose own most recent transition is a close. This is the
 * kernel's rule for refusing a posting, so it is what "closed" means here. */
export function lockedPeriods(state: BookState): Set<string> {
  const last = new Map<string, "close" | "reopen">();
  for (const transition of state.periodTransitions) last.set(transition.periodId, transition.kind);
  return new Set([...last].filter(([, kind]) => kind === "close").map(([id]) => id));
}

/** `booksBegan` is the day the books began (the recorded cutover date), when there is one: a period
 * that ends before it is before the books began. `inboxDates` is every day a bank transaction in the
 * Inbox is dated on, for `empty`; null when they could not be read, which calls no period empty. */
export function periodViews(
  state: BookState,
  today: string,
  booksBegan: string | null = null,
  inboxDates: readonly string[] | null = null,
): PeriodView[] {
  const closes = currentCloses(state);
  const locked = lockedPeriods(state);
  const withEntries = periodsWithEntries(state);
  // The days are in order when the calendar slice gives them, and then a period holds one when the first day
  // on or after its start is not past its end; in any other order every day is looked at.
  const inOrder =
    inboxDates?.every((day, at) => at === 0 || (inboxDates[at - 1] ?? "") <= day) ?? false;
  const holdsNothing = (startsOn: string, endsOn: string): boolean => {
    if (inboxDates === null) return false;
    if (!inOrder) return !inboxDates.some((day) => day >= startsOn && day <= endsOn);
    let low = 0;
    let high = inboxDates.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((inboxDates[middle] as string) < startsOn) low = middle + 1;
      else high = middle;
    }
    return low >= inboxDates.length || (inboxDates[low] as string) > endsOn;
  };
  const ordered = [...state.periods].sort(
    (left, right) =>
      (left.startsOn < right.startsOn ? -1 : left.startsOn > right.startsOn ? 1 : 0) ||
      Number(left.sequence - right.sequence),
  );
  const seenInYear = new Map<bigint, number>();
  return ordered.map((period) => {
    const close = closes.get(period.id);
    const isLocked = locked.has(period.id);
    const ordinal = (seenInYear.get(period.fiscalYear) ?? 0) + 1;
    seenInYear.set(period.fiscalYear, ordinal);
    const supersedes =
      isLocked && close
        ? ordered
            .filter(
              (other) =>
                other.id !== period.id &&
                closes.has(other.id) &&
                locked.has(other.id) &&
                other.endsOn >= period.endsOn,
            )
            .map((other) => other.id as string)
        : [];
    return {
      id: period.id,
      label: period.label,
      startsOn: period.startsOn,
      endsOn: period.endsOn,
      status: isLocked ? "closed" : "open",
      closePackageId: isLocked ? (close?.id ?? null) : null,
      reportPopulationHash: isLocked ? (close?.reportPopulationHash.digest ?? null) : null,
      closingRevision: isLocked ? (close?.throughBookRevision.toString() ?? null) : null,
      fiscalYear: Number(period.fiscalYear),
      ordinal,
      ended: period.endsOn < today,
      closeSuperseded: isLocked && !close,
      supersedes,
      alsoReopens: supersedes,
      beforeBooks: booksBegan !== null && period.endsOn < booksBegan,
      empty: !withEntries.has(String(period.id)) && holdsNothing(period.startsOn, period.endsOn),
    };
  });
}

export function fiscalYearViews(periods: readonly PeriodView[]): FiscalYearView[] {
  const years = new Map<number, PeriodView[]>();
  for (const period of periods) {
    const members = years.get(period.fiscalYear);
    if (members) members.push(period);
    else years.set(period.fiscalYear, [period]);
  }
  return [...years.entries()]
    .map(([fiscalYear, all]) => {
      // The periods before the books began are not the books' own: a year is judged by the rest, and
      // by all of them only when there is nothing else (a year that ended before the books began).
      const before = all.filter((member) => member.beforeBooks);
      const members =
        before.length < all.length ? all.filter((member) => !member.beforeBooks) : all;
      const closedCount = members.filter(
        (member) => member.status === "closed" && !member.closeSuperseded,
      ).length;
      const supersededCount = members.filter((member) => member.closeSuperseded).length;
      const locked = closedCount + supersededCount;
      return {
        fiscalYear,
        startsOn: all.reduce(
          (first, member) => (member.startsOn < first ? member.startsOn : first),
          all[0]?.startsOn ?? "",
        ),
        endsOn: all.reduce(
          (last, member) => (member.endsOn > last ? member.endsOn : last),
          all[0]?.endsOn ?? "",
        ),
        periodCount: members.length,
        closedCount,
        supersededCount,
        status:
          closedCount === members.length
            ? ("closed" as const)
            : locked === 0
              ? ("open" as const)
              : ("partlyClosed" as const),
        ended: all.every((member) => member.ended),
        beforeBooks: before.length === all.length,
        periodsBeforeBooks: before.length,
      };
    })
    .sort((left, right) => left.fiscalYear - right.fiscalYear);
}

export function calendarView(
  periods: readonly PeriodView[],
  shape: CalendarShape,
  today: string,
  booksBegan: string | null = null,
  yearStartBlock: { readonly message: string } | null = null,
): CalendarView {
  const years = fiscalYearViews(periods);
  const first = years[0];
  const last = years.at(-1);
  const canExtend = last !== undefined && last.fiscalYear < MAX_FISCAL_YEAR;
  const next = canExtend && last ? fiscalYearBounds(last.fiscalYear + 1, shape) : null;
  return {
    today,
    firstDate: first?.startsOn ?? "",
    lastDate: last?.endsOn ?? "",
    fiscalYearStartMonth: shape.fiscalYearStartMonth,
    periodModel: shape.periodModel,
    fiscalYears: years,
    canExtend,
    nextFiscalYear: next?.fiscalYear ?? null,
    nextStartsOn: next?.startsOn ?? null,
    nextEndsOn: next?.endsOn ?? null,
    extendNote: canExtend
      ? ""
      : `The calendar already runs through fiscal year ${MAX_FISCAL_YEAR}, the last one Rastrata supports.`,
    booksBegan,
    canChangeYearStart: yearStartBlock === null,
    yearStartNote: yearStartBlock?.message ?? "",
  };
}

export function periodHistory(state: BookState): PeriodHistoryView[] {
  const periodOfClose = new Map(state.closePackages.map((close) => [close.id, close.periodId]));
  return [...state.periodTransitions].reverse().map((transition) => ({
    periodId: transition.periodId,
    kind: transition.kind,
    reason: transition.reason,
    recordedAt: transition.recordedAt,
    bookRevision: transition.bookRevision.toString(),
    supersededCloseIds: [...transition.supersededCloseIds],
    supersededPeriodIds: transition.supersededCloseIds.flatMap((id) => {
      const periodId = periodOfClose.get(id);
      return periodId === undefined || periodId === transition.periodId ? [] : [periodId];
    }),
  }));
}

/** Everything `periods.list` returns, from the book's state, its calendar shape, today's date, the
 * day the books began (the recorded cutover date, or null) and the days the Inbox's bank transactions
 * are dated on (null when unread: no period is then called empty). */
export function periodList(
  state: BookState,
  shape: CalendarShape,
  today: string,
  booksBegan: string | null = null,
  inboxDates: readonly string[] | null = null,
) {
  const periods = periodViews(state, today, booksBegan, inboxDates);
  return {
    bookRevision: state.bookRevision.toString(),
    calendar: calendarView(periods, shape, today, booksBegan, yearStartBlocker(state)),
    periods,
    history: periodHistory(state),
  };
}

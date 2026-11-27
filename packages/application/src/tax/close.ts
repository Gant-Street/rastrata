/** Whether the books for a range are closed, and at which revision: what a year-end pack or an accountant
 * pack says about how final its figures are.
 *
 * It uses the calendar lane's own definitions (calendar/periods.ts), because the words mean exactly what
 * the Periods screen means by them. A period is **locked** when the last thing that happened to it was a
 * close, so nothing can be posted into it. Its close is **current** or **superseded**: reopening an
 * earlier period supersedes the closes of every later one, which stay locked but whose recorded figures no
 * longer describe the books. A range is **closed** only when every period in it is locked with a current
 * close. The last current close is the one to tie a pack to: the book revision it was recorded at and the
 * report population hash it recorded.
 *
 * Pure and portable: a function of a book state and a date. */
import type { BookState } from "@rastrata/kernel";

import { currentCloses, lockedPeriods } from "../calendar/periods.ts";

export type PeriodCloseState = "open" | "closed" | "superseded";

export interface PeriodClose {
  readonly id: string;
  readonly label: string;
  readonly startsOn: string;
  readonly endsOn: string;
  /** The period's last day is before today. */
  readonly ended: boolean;
  /** `open`: not locked. `closed`: locked with a current close. `superseded`: locked, and its close was
   * superseded by a reopening, so it needs closing again. */
  readonly state: PeriodCloseState;
  readonly closingRevision: string | null;
  readonly reportPopulationHash: string | null;
}

export type YearCloseState = "closed" | "partly_closed" | "open";

export interface YearClose {
  readonly state: YearCloseState;
  /** The periods that overlap the range, in order. */
  readonly periods: readonly PeriodClose[];
  readonly closed: number;
  readonly superseded: number;
  readonly open: number;
  /** The period with the latest end date that has a current close, or null when none has. */
  readonly last: PeriodClose | null;
}

export function yearClose(state: BookState, from: string, to: string, today: string): YearClose {
  const closes = currentCloses(state);
  const locked = lockedPeriods(state);
  const periods: PeriodClose[] = state.periods
    .filter((period) => period.kind === "regular" && period.endsOn >= from && period.startsOn <= to)
    .sort(
      (left, right) =>
        (left.startsOn < right.startsOn ? -1 : left.startsOn > right.startsOn ? 1 : 0) ||
        Number(left.sequence - right.sequence),
    )
    .map((period) => {
      const close = closes.get(period.id);
      const isLocked = locked.has(period.id);
      const kind: PeriodCloseState = !isLocked ? "open" : close ? "closed" : "superseded";
      return {
        id: period.id as string,
        label: period.label,
        startsOn: period.startsOn as string,
        endsOn: period.endsOn as string,
        ended: (period.endsOn as string) < today,
        state: kind,
        closingRevision: kind === "closed" && close ? close.throughBookRevision.toString() : null,
        reportPopulationHash: kind === "closed" && close ? close.reportPopulationHash.digest : null,
      };
    });
  const count = (kind: PeriodCloseState) =>
    periods.filter((period) => period.state === kind).length;
  const closed = count("closed");
  const superseded = count("superseded");
  const open = count("open");
  const last =
    periods
      .filter((period) => period.state === "closed")
      .reduce<PeriodClose | null>(
        (best, period) => (best === null || period.endsOn > best.endsOn ? period : best),
        null,
      ) ?? null;
  return {
    state:
      periods.length > 0 && closed === periods.length
        ? "closed"
        : closed + superseded === 0
          ? "open"
          : "partly_closed",
    periods,
    closed,
    superseded,
    open,
    last,
  };
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** Up to four period labels, then "and more". */
export function labelsOf(periods: readonly PeriodClose[]): string {
  return `${periods
    .slice(0, 4)
    .map((period) => period.label)
    .join(", ")}${periods.length > 4 ? ", and more" : ""}`;
}

/** What a pack says about how final it is, in plain words. `bookRevision` is the revision the pack was
 * built from. */
export function closeStatement(close: YearClose, bookRevision: string): string {
  const open = close.periods.filter((period) => period.state === "open");
  const superseded = close.periods.filter((period) => period.state === "superseded");
  if (close.state === "closed" && close.last)
    return `Every period in this range is closed with a current close. The last close, for ${close.last.label} (${close.last.startsOn} to ${close.last.endsOn}), was recorded at book revision ${close.last.closingRevision} with report population ${close.last.reportPopulationHash}. This was built from book revision ${bookRevision}${bookRevision === close.last.closingRevision ? ", the revision the books were closed at" : ", after the books were closed; a closed period takes no new postings, so its figures are the ones that were closed"}.`;
  if (close.state === "open")
    return `No period in this range is closed, so the books for it can still change. This is the books as they stand at book revision ${bookRevision}.`;
  const parts = [
    `${close.closed} of ${close.periods.length} ${plural(close.periods.length, "period", "periods")} in this range ${plural(close.closed, "is", "are")} closed with a current close.`,
  ];
  if (open.length > 0)
    parts.push(
      `${open.length} ${plural(open.length, "is", "are")} open (${labelsOf(open)}), so the books for ${plural(open.length, "it", "them")} can still change.`,
    );
  if (superseded.length > 0)
    parts.push(
      `${superseded.length} ${plural(superseded.length, "is", "are")} locked but ${plural(superseded.length, "its close was", "their closes were")} superseded by a reopening (${labelsOf(superseded)}), so ${plural(superseded.length, "it needs", "they need")} closing again before ${plural(superseded.length, "its close describes", "their closes describe")} the books.`,
    );
  parts.push(`This is the books as they stand at book revision ${bookRevision}.`);
  return parts.join(" ");
}

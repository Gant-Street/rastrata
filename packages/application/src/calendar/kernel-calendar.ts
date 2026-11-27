import {
  fiscalPeriodId,
  localDate,
  type FiscalCalendarId,
  type FiscalPeriod,
} from "@rastrata/kernel";
import {
  fiscalYearPeriods,
  periodIdFor,
  periodSequenceFor,
  type CalendarShape,
} from "./fiscal-calendar.ts";

/** The first and last dates the book's regular periods cover. A journal can be dated only inside
 * this range, and the book is configured, so there is always at least one period. */
export function calendarCoverage(periods: readonly FiscalPeriod[]): {
  readonly startsOn: string;
  readonly endsOn: string;
} {
  let startsOn: string | undefined;
  let endsOn: string | undefined;
  for (const period of periods) {
    if (period.kind !== "regular") continue;
    if (startsOn === undefined || period.startsOn < startsOn) startsOn = period.startsOn;
    if (endsOn === undefined || period.endsOn > endsOn) endsOn = period.endsOn;
  }
  if (startsOn === undefined || endsOn === undefined) throw new Error("A book has periods");
  return { startsOn, endsOn };
}

/** The kernel's periods for one fiscal year. Ids and sequences are deterministic functions of the
 * fiscal year, so building the same year twice gives byte-identical periods. */
export function kernelFiscalYear(
  fiscalYear: number,
  shape: CalendarShape,
  calendarId: FiscalCalendarId,
  firstFiscalYear: number,
  idTag?: string,
): FiscalPeriod[] {
  return fiscalYearPeriods(fiscalYear, shape).map((spec) => ({
    id: fiscalPeriodId(periodIdFor(spec.fiscalYear, spec.ordinal, firstFiscalYear, idTag)),
    calendarId,
    fiscalYear: BigInt(spec.fiscalYear),
    sequence: BigInt(
      periodSequenceFor(spec.fiscalYear, spec.ordinal, firstFiscalYear, shape.periodModel),
    ),
    label: spec.label,
    kind: "regular",
    startsOn: localDate(spec.startsOn),
    endsOn: localDate(spec.endsOn),
  }));
}

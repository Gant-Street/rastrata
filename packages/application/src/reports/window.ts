import type { BookState } from "@rastrata/kernel";

import type { ReportCalendar } from "../client-contracts.gen.ts";
import { fiscalCalendar } from "./calendar.ts";
import { ledgerView } from "./ledger.ts";

/** The dates a book can report on: the first day of its first period to the last day of its last.
 * Screens that need "everything the book holds" read balances as of `lastDate`. */
export function reportingWindow(state: BookState): { firstDate: string; lastDate: string } {
  const calendar = fiscalCalendar(state.periods);
  return { firstDate: calendar.firstDate, lastDate: calendar.lastDate };
}

/** What the book can report on, for pickers and for agents choosing a range. */
export function reportCalendar(state: BookState): ReportCalendar {
  const calendar = fiscalCalendar(state.periods);
  return {
    currency: state.identity.functionalCommodityId,
    basis: state.identity.primaryBasis,
    bookRevision: state.bookRevision.toString(),
    firstDate: calendar.firstDate,
    lastDate: calendar.lastDate,
    latestPostingDate: ledgerView(state).latestJournalDate,
    fiscalYears: calendar.years.map((year) => ({
      year: year.year,
      startsOn: year.startsOn,
      endsOn: year.endsOn,
    })),
  };
}

import type { BookConfigurationSnapshot, BookState } from "@rastrata/kernel";

import type { ReportBasis } from "../client-contracts.gen.ts";
import { ApplicationError } from "../errors.ts";
import {
  calendarNotConfigured,
  fiscalCalendar,
  requireFiscalYear,
  type FiscalCalendar,
  type FiscalYearInfo,
} from "./calendar.ts";
import { chartAccounts, type ChartAccount } from "./chart.ts";
import { isDate } from "./dates.ts";
import { ledgerView, type Accumulated, type LedgerView } from "./ledger.ts";
import { populationHash } from "./population.ts";

/** What a statement is built from, resolved once per request: the state, the chart and calendar in
 * force on the as-of date, and the basis the book keeps. */
export interface ReportContext {
  readonly state: BookState;
  readonly view: LedgerView;
  /** The date `chart`, `accounts` and `calendar` were resolved for: the report's as-of date. */
  readonly asOf: string;
  readonly chart: BookConfigurationSnapshot;
  readonly accounts: readonly ChartAccount[];
  readonly calendar: FiscalCalendar;
  readonly basis: ReportBasis;
}

/** The basis a report carries is always the book's own. A different one needs the open items
 * (invoices and bills with settlement dates) that conversion between bases depends on, which this
 * book does not keep; asking for it is refused with the reason rather than approximated. */
export function reportBasis(state: BookState, requested?: ReportBasis): ReportBasis {
  const kept = state.identity.primaryBasis;
  if (requested !== undefined && requested !== kept) {
    const message =
      kept === "cash"
        ? "This book is kept on the cash basis, so it cannot produce accrual-basis reports. An accrual report needs the receivables, payables and accruals a cash-basis book does not record."
        : "This book is kept on the accrual basis, so it cannot produce cash-basis reports. A cash report needs the date each receivable and payable was settled, which this book does not record.";
    throw new ApplicationError("basis_unavailable", message, 409, [
      { path: "basis", message: `The book keeps the ${kept} basis` },
    ]);
  }
  return kept;
}

/** Validate a date a caller supplied. A pattern check accepts "2026-02-30"; this does not. */
export function requireDate(value: string, field: string): string {
  if (!isDate(value))
    throw new ApplicationError("invalid_input", `${field} must be a real date (YYYY-MM-DD)`, 400, [
      { path: field, message: "Expected a real calendar date" },
    ]);
  return value;
}

export function reportContext(
  state: BookState,
  asOf: string,
  requestedBasis?: ReportBasis,
): ReportContext {
  requireDate(asOf, "asOf");
  const basis = reportBasis(state, requestedBasis);
  const view = ledgerView(state);
  const chart = view.configurationAt(asOf);
  return {
    state,
    view,
    asOf,
    chart,
    accounts: chartAccounts(chart),
    calendar: fiscalCalendar(chart.periods),
    basis,
  };
}

/** The range a report covers: `from` defaults to the first day of the fiscal year containing
 * `asOf`. Both ends must lie inside the book's calendar. */
export function resolveRange(
  context: ReportContext,
  asOf: string,
  from?: string,
): { readonly from: string; readonly fiscalYear: FiscalYearInfo } {
  const fiscalYear = requireFiscalYear(context.calendar, asOf, "asOf");
  const start = from === undefined ? fiscalYear.startsOn : requireDate(from, "from");
  if (start > asOf)
    throw new ApplicationError("invalid_input", "from must not be after asOf", 400, [
      { path: "from", message: `${start} is after ${asOf}` },
    ]);
  if (start < context.calendar.firstDate)
    throw calendarNotConfigured(context.calendar, start, "from");
  return { from: start, fiscalYear };
}

/** Every figure for one date range: the postings up to `to` split three ways (cumulative, fiscal
 * year to date, and the range), so every statement of the same range reads the same numbers. */
export interface Column {
  readonly from: string;
  readonly to: string;
  readonly fiscalYear: FiscalYearInfo;
  readonly accumulated: Accumulated;
  readonly populationHash: string;
}

export function compileColumn(context: ReportContext, from: string, to: string): Column {
  const fiscalYear = requireFiscalYear(context.calendar, to, "asOf");
  if (from < context.calendar.firstDate)
    throw calendarNotConfigured(context.calendar, from, "from");
  const { accumulated, complete } = context.view.accumulated(
    to,
    fiscalYear.startsOn,
    from,
    new Set(context.accounts.map((account) => account.id)),
  );
  if (complete) context.view.verifyAgainstKernel(accumulated.cumulative);
  // The population is the one this range would have on its own, so a comparison column's hash is the
  // hash of the standalone report for that range: the chart in force on its own end date.
  const chart = to === context.asOf ? context.chart : context.view.configurationAt(to);
  return {
    from,
    to,
    fiscalYear,
    accumulated,
    populationHash: populationHash(context.state, chart, {
      asOf: to,
      from,
      basis: context.basis,
      fiscalYear,
    }),
  };
}

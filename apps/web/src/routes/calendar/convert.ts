import type {
  PeriodList,
  PreparedOperation,
  YearEndPlan,
  YearEndReceipt,
  YearEndReview,
} from "@rastrata/application/client-contracts";
import type {
  CalendarView,
  ChangePlanView as PeriodChangePlan,
  FiscalYearView as CalendarFiscalYear,
  HistoryEntry as PeriodHistoryEntry,
  PeriodView as CalendarPeriod,
  StatementsView as YearEndStatementsView,
  YearEndPlanView,
  YearEndReceiptView,
} from "@rastrata/ui/calendar/types";

/** Turn what the service answered into what the calendar components show. Nothing is computed here
 * that the service has not said: a status, a count and a hash arrive as they are, and these functions
 * only name things for a person ("March 2028") and shape them for the components. */

type Row = PeriodList["periods"][number];

/** A period named so it is unambiguous in a book of several years: its label and the year it starts
 * in ("March 2028", "Q1 2027"). */
export const nameOf = (period: { label: string; startsOn: string }): string =>
  `${period.label} ${period.startsOn.slice(0, 4)}`;

/** The Reports screen for a date. The current books, never a pinned old revision, so it is quick. */
export const reportHref = (asOf: string): string => `/reports?asOf=${encodeURIComponent(asOf)}`;

/** The calendar as the person sees it: from the day the books began (the book keeps earlier years for a
 * history that may come in, and says nothing of them). */
export function toCalendar(list: PeriodList): CalendarView {
  const calendar = list.calendar;
  return {
    firstDate: calendar.booksBegan ?? calendar.firstDate,
    lastDate: calendar.lastDate,
    fiscalYearStartMonth: calendar.fiscalYearStartMonth,
    today: calendar.today,
    booksBegan: calendar.booksBegan,
  };
}

/** The fiscal years from the one the books began in; a year that ended before them is not shown. */
export function toYears(list: PeriodList): CalendarFiscalYear[] {
  return list.calendar.fiscalYears.filter((year) => !year.beforeBooks).map((year) => ({ ...year }));
}

export function toPeriods(list: PeriodList, fiscalYear: number): CalendarPeriod[] {
  const byId = new Map(list.periods.map((period) => [period.id, period]));
  return list.periods
    .filter((period) => period.fiscalYear === fiscalYear)
    .map((period) => periodView(period, byId));
}

function periodView(period: Row, byId: ReadonlyMap<string, Row>): CalendarPeriod {
  return {
    id: period.id,
    label: period.label,
    startsOn: period.startsOn,
    endsOn: period.endsOn,
    status: period.status,
    closeSuperseded: period.closeSuperseded,
    ended: period.ended,
    closingReportHref:
      period.status === "closed" && !period.closeSuperseded ? reportHref(period.endsOn) : null,
    closingRevision: period.closingRevision,
    beforeBooks: period.beforeBooks,
    empty: period.empty,
    supersedes: period.supersedes.map((id) => {
      const other = byId.get(id);
      return other ? nameOf(other) : id;
    }),
  };
}

/** One period of the list by id, or undefined when the book no longer has it. */
export function toPeriod(list: PeriodList, periodId: string): CalendarPeriod | undefined {
  const byId = new Map(list.periods.map((period) => [period.id, period]));
  const period = byId.get(periodId);
  return period ? periodView(period, byId) : undefined;
}

export function toHistory(list: PeriodList): PeriodHistoryEntry[] {
  const byId = new Map(list.periods.map((period) => [period.id, period]));
  const name = (id: string) => {
    const period = byId.get(id);
    return period ? nameOf(period) : id;
  };
  return list.history.map((entry) => ({
    periodLabel: name(entry.periodId),
    kind: entry.kind === "reopen" ? "reopen" : "close",
    recordedAt: entry.recordedAt,
    bookRevision: entry.bookRevision,
    reason: entry.reason,
    superseded: entry.supersededPeriodIds.map(name),
  }));
}

/** The facts of a prepared close or reopening for the review panel. `list` names the periods the
 * plan supersedes; `asOf` is where the report of the closing figures is, for a close. */
export function toChangePlan(
  plan: PreparedOperation,
  list: PeriodList,
  asOf: string | null,
): PeriodChangePlan {
  const byId = new Map(list.periods.map((period) => [period.id, period]));
  const superseded = plan.effects.periods.flatMap((effect) => effect.supersededPeriodIds ?? []);
  return {
    bookRevision: plan.bookRevision,
    valid: plan.valid,
    problems: plan.diagnostics,
    // The consequence of a reopening is shown on its own, from the same plan, so its warning is not
    // shown twice.
    warnings: (plan.warnings ?? [])
      .filter((warning) => warning.code !== "reopen_supersedes_closes")
      .map((warning) => warning.message),
    supersedes: superseded.map((id) => {
      const period = byId.get(id);
      return period ? nameOf(period) : id;
    }),
    reportHref: asOf ? reportHref(asOf) : undefined,
  };
}

export function toStatements(
  statements: YearEndReview["statements"] | YearEndPlan["statements"],
): YearEndStatementsView {
  return {
    currency: statements.currency,
    basis: statements.basis,
    asOf: statements.asOf,
    periodStart: statements.periodStart,
    revenue: statements.revenue,
    expenses: statements.expenses,
    netIncome: statements.netIncome,
    assets: statements.assets,
    liabilities: statements.liabilities,
    equity: statements.equity,
    priorEarnings: statements.priorEarnings,
    reportHref: reportHref(statements.asOf),
  };
}

export function toYearEndPlan(plan: YearEndPlan): YearEndPlanView {
  return {
    fiscalYear: plan.fiscalYear,
    valid: plan.valid,
    closes: plan.openCount,
    superseded: plan.supersededCount,
    reason: plan.reason,
    problems: plan.diagnostics,
    steps: plan.steps.map((step) => ({
      order: step.order,
      label: step.label,
      startsOn: step.startsOn,
      endsOn: step.endsOn,
      status: step.status,
      closeSuperseded: step.closeSuperseded,
      commands: step.plans.map((command) => ({
        kind: command.kind === "reopenPeriod" ? "reopen" : "close",
        valid: command.valid,
        warnings: (command.warnings ?? []).map((warning) => warning.message),
        problems: command.diagnostics,
      })),
    })),
  };
}

export function toReceipt(receipt: YearEndReceipt): YearEndReceiptView {
  return {
    disposition: receipt.disposition === "committed" ? "committed" : "rejected",
    closed: receipt.closedCount,
    total: receipt.totalCount,
    message: receipt.disposition === "committed" ? "" : receipt.diagnostics.join(" "),
  };
}

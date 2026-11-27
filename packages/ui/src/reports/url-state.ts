import {
  defaultRange,
  presetOf,
  type DateRangeValue,
  type FiscalCalendar,
} from "../kit/date-range";
import {
  type CompareChoice,
  type DateRange,
  type FiscalYearSpan,
  isDate,
  olderPeriod,
  yearContaining,
} from "./period";

/** The state of the Reports screen, as a query string: the statement, the dates, the comparison and
 * the page. It lives in the address so a link, a reload and the back button all land on the same
 * figures, and so a drill-through can return to exactly where it came from. Pure and exact: nothing
 * here reads a clock (today is passed in) and an address that names something this book does not
 * have is answered with a safe default and a sentence saying so, never a thrown error. */

export const REPORT_TABS = [
  "profit-loss",
  "balance-sheet",
  "cash-flow",
  "trial-balance",
  "general-ledger",
] as const;
export type ReportTab = (typeof REPORT_TABS)[number];

/** How the figures are laid out: one column for the dates, or a column for each month in them. */
export type ReportColumns = "total" | "month";

/** What the profit and loss is shown beside its amounts: nothing more, or each amount's share of total
 * income (the service's `share`, and the address's `share=income`). */
export type ShareChoice = "none" | "income";

/** The statements that can be laid out by month. A trial balance is a position on one day and a
 * general ledger is a list of postings; neither has months to lay side by side. */
export const MONTHLY_TABS: readonly ReportTab[] = ["profit-loss", "balance-sheet"];
export const canBeByMonth = (tab: ReportTab): boolean => MONTHLY_TABS.includes(tab);

/** The statements that can be compared with an earlier period. The trial balance and the general
 * ledger are read for the dates alone. */
export const COMPARABLE_TABS: readonly ReportTab[] = ["profit-loss", "balance-sheet", "cash-flow"];
export const canBeCompared = (tab: ReportTab): boolean => COMPARABLE_TABS.includes(tab);

/** The statements that can be shown as a share of income. Only the profit and loss has income to take a
 * share of. */
export const SHAREABLE_TABS: readonly ReportTab[] = ["profit-loss"];
export const canShare = (tab: ReportTab): boolean => SHAREABLE_TABS.includes(tab);

/** The statements that leave out the accounts with nothing in them, and can show them (View). The cash flow
 * is a few lines by kind and the general ledger is a list of postings: neither has an account to leave out. */
export const EMPTY_ACCOUNT_TABS: readonly ReportTab[] = [
  "profit-loss",
  "balance-sheet",
  "trial-balance",
];
export const canShowEmpty = (tab: ReportTab): boolean => EMPTY_ACCOUNT_TABS.includes(tab);

/** What a screen reads its dates against: the book's fiscal years, and today. */
export interface ReportCalendar extends FiscalCalendar {
  readonly years: readonly FiscalYearSpan[];
}

export interface ReportScreenState {
  readonly tab: ReportTab;
  /** The dates and the period they came from (the kit's `DateRangeValue`). The dates of a custom range
   * are as typed, so a half-typed one can sit here. */
  readonly range: DateRangeValue;
  readonly compare: CompareChoice;
  /** Total or by month. By month and a comparison do not combine: with months in columns the
   * comparison is off. */
  readonly by: ReportColumns;
  /** Each amount of the profit and loss with its share of total income. Like a comparison it is kept when
   * the person goes to another statement, and with months in columns it is off. */
  readonly share: ShareChoice;
  /** The page of the general ledger (the others are not paged). */
  readonly page: number;
  /** Show accounts that have no activity too. */
  readonly showZero: boolean;
  /** A book revision the address pins, when a link asked for one. Otherwise the current book. */
  readonly revision: string | undefined;
}

const COMPARE_PARAM: Readonly<Record<CompareChoice, string>> = {
  none: "",
  previousPeriod: "previous-period",
  previousYear: "previous-year",
};
/** The comparison a query value names. A value such as "__proto__" is text, not a table key, so the
 * lookup never reaches a prototype. */
function compareFromParam(value: string | null): CompareChoice {
  return value === "previous-period"
    ? "previousPeriod"
    : value === "previous-year"
      ? "previousYear"
      : "none";
}
const REVISION = /^(0|[1-9][0-9]{0,18})$/;
const PAGE = /^[1-9][0-9]{0,5}$/;

/** What the dates are before the book's calendar is known: nothing, on the fiscal year to date. */
const NO_DATES: DateRangeValue = { preset: "fiscalYearToDate", from: "", to: "" };

/** The fiscal year to date, no comparison, the first page of the profit and loss. Without a calendar
 * the dates are empty: nothing is read until there are some. */
export function defaultState(calendar?: ReportCalendar): ReportScreenState {
  return {
    tab: "profit-loss",
    range: (calendar && defaultRange(calendar)) ?? NO_DATES,
    compare: "none",
    by: "total",
    share: "none",
    page: 1,
    showZero: false,
    revision: undefined,
  };
}

export const isReportTab = (value: string | null): value is ReportTab =>
  value !== null && (REPORT_TABS as readonly string[]).includes(value);

/** Dates as a value the field can show: the period they are, when they are one, else custom. */
function rangeValue(dates: DateRange, calendar: ReportCalendar): DateRangeValue {
  return { preset: presetOf(dates, calendar), ...dates };
}

function parseRange(
  params: URLSearchParams,
  calendar: ReportCalendar,
): { range: DateRangeValue; notice?: string } {
  const fallback = defaultState(calendar).range;
  const period = params.get("period");
  const from = params.get("from");
  const to = params.get("to");
  const asOf = params.get("asOf");
  // Dates that were being typed, kept as they were so a reload shows what was typed.
  if (period === "custom") return { range: { preset: "custom", from: from ?? "", to: to ?? "" } };
  // The dates themselves. An older link that names an end date (`asOf`) may carry its start as `from`.
  if (to !== null || (from !== null && asOf === null)) {
    if (from !== null && to !== null && isDate(from) && isDate(to))
      return { range: rangeValue({ from, to }, calendar) };
    return {
      range: fallback,
      notice:
        "The dates in this link are not both real dates, so the fiscal year to date is shown.",
    };
  }
  if (period !== null) {
    // An older link names a period ("month:2026-03"): it opens as the dates it stood for.
    if (period === "ytd") return { range: fallback };
    const dates = olderPeriod(period, calendar.years);
    if (dates) return { range: rangeValue(dates, calendar) };
    return {
      range: fallback,
      notice: `This book's fiscal calendar has no period "${period}", so the fiscal year to date is shown.`,
    };
  }
  // Older links name only the end date, and sometimes the start.
  if (asOf === null) return { range: fallback };
  if (!isDate(asOf))
    return { range: fallback, notice: `The date ${asOf} in this link is not a real date.` };
  const start =
    from !== null && isDate(from) ? from : (yearContaining(calendar.years, asOf)?.startsOn ?? asOf);
  return { range: rangeValue({ from: start, to: asOf }, calendar) };
}

/** Read the screen's state from an address. Anything unusable falls back to a default and is named in
 * `notice`, so the page can say what it did instead of silently showing something else. */
export function parseState(
  search: string,
  calendar: ReportCalendar,
): { state: ReportScreenState; notice: string | undefined } {
  const params = new URLSearchParams(search);
  const base = defaultState(calendar);
  const tab = params.get("tab");
  const { range, notice } = parseRange(params, calendar);
  const pageText = params.get("page");
  const revision = params.get("revision");
  const by: ReportColumns = params.get("by") === "month" ? "month" : "total";
  return {
    state: {
      tab: isReportTab(tab) ? tab : base.tab,
      range,
      // Months in columns and a comparison do not combine; the months win. Nor do months and shares.
      compare: by === "month" ? "none" : compareFromParam(params.get("compare")),
      by,
      share: by !== "month" && params.get("share") === "income" ? "income" : "none",
      // Plain digits only: "1e3" and " 7" are not page numbers.
      page:
        pageText !== null && PAGE.test(pageText) && Number(pageText) <= 100000
          ? Number(pageText)
          : 1,
      showZero: params.get("zero") === "1",
      revision: revision !== null && REVISION.test(revision) ? revision : undefined,
    },
    notice,
  };
}

/** The state as a query string without the leading "?": defaults are left out, so the usual address
 * is just the path. */
export function serializeState(state: ReportScreenState): string {
  const params = new URLSearchParams();
  // The statement is always named: the address with nothing after it is the list of reports.
  params.set("tab", state.tab);
  const { range } = state;
  // The fiscal year to date is today's, so it is the address with no dates; every other period is the dates
  // themselves, so a link means the same figures on any day.
  if (range.preset === "custom") params.set("period", "custom");
  if (range.preset !== "fiscalYearToDate") {
    params.set("from", range.from);
    params.set("to", range.to);
  }
  // A trial balance has no months to lay side by side, and months in columns turn the comparison off.
  // The comparison is kept on every statement, so a reload on the trial balance still has it when the
  // person goes back to the profit and loss.
  const byMonth = state.by === "month" && canBeByMonth(state.tab);
  if (byMonth) params.set("by", "month");
  if (state.compare !== "none" && !byMonth) params.set("compare", COMPARE_PARAM[state.compare]);
  // The share of income is kept on every statement, like the comparison, and is off with months in columns.
  if (state.share === "income" && !byMonth) params.set("share", "income");
  if (state.page !== 1) params.set("page", String(state.page));
  if (state.showZero) params.set("zero", "1");
  if (state.revision !== undefined) params.set("revision", state.revision);
  return params.toString();
}

import {
  defaultState,
  parseState,
  type ReportCalendar,
  serializeState,
} from "../reports/url-state";
import type { DateRangeValue } from "../kit/date-range";
import type { PayeeDirection } from "./types";

/** The state of the By payee screen, as a query string: the dates, which side to list, the page of
 * payees and the payee whose transactions are open. It lives in the address, as the Reports screen's
 * does, so a link, a reload and the back button land on the same figures, and the 1099 tab can open a
 * payee. The dates are read by the Reports screen's own reader, so the two screens mean the same by a
 * period. Anything unusable falls back to a default and is named in `notice`, never thrown. */

export interface PayeesScreenState {
  readonly range: DateRangeValue;
  readonly direction: PayeeDirection;
  /** The page of the payees' rows. */
  readonly page: number;
  /** A book revision the address pins, when a link asked for one. */
  readonly revision: string | undefined;
  /** The payee whose transactions are open, when the address names one. */
  readonly payee: string | undefined;
}

const PAGE = /^[1-9][0-9]{0,5}$/;
/** What a payee's id can be: letters, digits, hyphens and underscores, as the service holds them. */
const PAYEE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function defaultPayeesState(calendar?: ReportCalendar): PayeesScreenState {
  const base = defaultState(calendar);
  return {
    range: base.range,
    direction: "both",
    page: 1,
    revision: undefined,
    payee: undefined,
  };
}

export function parsePayeesState(
  search: string,
  calendar: ReportCalendar,
): { state: PayeesScreenState; notice: string | undefined } {
  const params = new URLSearchParams(search);
  const { state, notice } = parseState(search, calendar);
  const direction = params.get("show");
  const page = params.get("page");
  const payee = params.get("payee");
  return {
    state: {
      range: state.range,
      direction: direction === "spent" || direction === "received" ? direction : "both",
      page: page !== null && PAGE.test(page) && Number(page) <= 100000 ? Number(page) : 1,
      revision: state.revision,
      payee: payee !== null && PAYEE_ID.test(payee) ? payee : undefined,
    },
    notice,
  };
}

/** The state as a query string without the leading "?": defaults are left out, so the usual address is
 * just the path. The dates and the revision are written as the Reports screen writes them. */
export function serializePayeesState(state: PayeesScreenState): string {
  const params = new URLSearchParams(
    serializeState({
      tab: "profit-loss",
      range: state.range,
      compare: "none",
      by: "total",
      share: "none",
      page: 1,
      showZero: false,
      revision: state.revision,
    }),
  );
  // The dates are written the way a statement writes them; which statement is not this page's to say.
  params.delete("tab");
  if (state.direction !== "both") params.set("show", state.direction);
  if (state.page !== 1) params.set("page", String(state.page));
  if (state.payee !== undefined) params.set("payee", state.payee);
  return params.toString();
}

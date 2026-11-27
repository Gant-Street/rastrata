import type { BookState } from "@rastrata/kernel";

import type { CoreReports } from "./client-contracts.gen.ts";
import { compileReports, type ReportOptions } from "./reports/core.ts";

/** The statement compiler. Everything is in `reports/`; this file keeps the long-standing entry
 * points that the service, the legacy browser routes and the web tooling import.
 *
 * One pinned book state produces every statement, for any date range and either basis the book
 * keeps. Earnings of earlier fiscal years are rolled forward by computation, never by posting a
 * closing entry, and each report carries the hash of the population it was built from. */
export { configurationAt } from "./reports/chart.ts";
export { compileReports, type ReportOptions } from "./reports/core.ts";
export { formatShare, shareTenths } from "./reports/statements.ts";
export { reportCalendar, reportingWindow } from "./reports/window.ts";

/** The trial balance, profit and loss and balance sheet as of `asOf`, with the profit and loss from
 * the start of the fiscal year (or `options.from`). The compiler a period close records. */
export function compileCoreReports(
  state: BookState,
  asOf: string,
  options?: ReportOptions,
): CoreReports {
  return compileReports(state, asOf, options);
}

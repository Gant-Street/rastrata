import type { BookState } from "@rastrata/kernel";

import type {
  CoreReports,
  ReportBasis,
  ReportComparison,
  ReportComparisonKind,
  ReportShare,
  ReportWarning,
} from "../client-contracts.gen.ts";
import {
  compileColumn,
  reportContext,
  resolveRange,
  type Column,
  type ReportContext,
} from "./columns.ts";
import { comparisonRange } from "./dates.ts";
import { COMPILER_VERSION } from "./population.ts";
import {
  balanceSheetFigures,
  buildTrialBalance,
  profitLossFigures,
  renderBalanceSheet,
  renderProfitLoss,
  shareWarnings,
} from "./statements.ts";

/** What a caller may ask of a report beyond the as-of date. */
export interface ReportOptions {
  /** First day of the profit-and-loss range; defaults to the start of the fiscal year of `asOf`. */
  readonly from?: string;
  /** The basis wanted. Only the book's own is available; anything else is basis_unavailable. */
  readonly basis?: ReportBasis;
  readonly compare?: ReportComparisonKind;
  /** `income` adds each profit and loss line's share of total income (see `renderProfitLoss`). The
   * other statements have none. */
  readonly share?: ReportShare;
}

/** A second column for a comparison, or the reason there is none. A comparison range must lie inside
 * the book's calendar: before its first period there is nothing to compare with, and saying so is
 * honest where an empty column of zeros would not be. */
export function comparisonColumn(
  context: ReportContext,
  kind: ReportComparisonKind | undefined,
  from: string,
  to: string,
): {
  readonly column?: Column;
  readonly comparison: ReportComparison | null;
  readonly warnings: ReportWarning[];
} {
  if (kind === undefined || kind === "none") return { comparison: null, warnings: [] };
  const range = comparisonRange(kind, from, to);
  if (range.from < context.calendar.firstDate || !context.calendar.yearOf(range.to))
    return {
      comparison: null,
      warnings: [
        {
          code: "comparison_unavailable",
          message: `The book's fiscal calendar starts on ${context.calendar.firstDate}, so there is no ${kind === "previousYear" ? "year" : "period"} before ${from} to compare with.`,
        },
      ],
    };
  const column = compileColumn(context, range.from, range.to);
  return {
    column,
    comparison: {
      kind,
      periodStart: range.from,
      asOf: range.to,
      populationHash: column.populationHash,
    },
    warnings: [],
  };
}

/** The trial balance, profit and loss and balance sheet of one population. The profit and loss covers
 * `from` to `asOf`; the trial balance and balance sheet are as of `asOf`, with the earnings of earlier
 * fiscal years rolled forward by computation (no closing entries are ever posted). */
export function compileReports(
  state: BookState,
  asOf: string,
  options: ReportOptions = {},
): CoreReports {
  const context = reportContext(state, asOf, options.basis);
  const range = resolveRange(context, asOf, options.from);
  const current = compileColumn(context, range.from, asOf);
  const {
    column: previous,
    comparison,
    warnings,
  } = comparisonColumn(context, options.compare, range.from, asOf);
  const { accounts } = context;
  const profit = profitLossFigures(accounts, current);
  const profitBefore = previous && profitLossFigures(accounts, previous);
  return {
    compilerVersion: COMPILER_VERSION,
    populationHash: current.populationHash,
    bookRevision: state.bookRevision.toString(),
    postingSequence: state.latestPostingSequence.toString(),
    asOf,
    periodStart: range.from,
    currency: state.identity.functionalCommodityId,
    basis: context.basis,
    fiscalYear: range.fiscalYear,
    trialBalance: buildTrialBalance(accounts, current),
    profitAndLoss: renderProfitLoss(accounts, profit, profitBefore, options.share),
    balanceSheet: renderBalanceSheet(
      accounts,
      balanceSheetFigures(accounts, current),
      previous && balanceSheetFigures(accounts, previous),
    ),
    comparison,
    // A period with no income has no share to show, and the report says so instead of leaving a gap.
    warnings:
      options.share === "income" ? [...warnings, ...shareWarnings(profit, profitBefore)] : warnings,
  };
}

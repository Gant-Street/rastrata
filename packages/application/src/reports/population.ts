import { hashCanonical, type BookConfigurationSnapshot, type BookState } from "@rastrata/kernel";

import type { ReportBasis } from "../client-contracts.gen.ts";
import type { FiscalYearInfo } from "./calendar.ts";

/** Version of the algorithm that compiles statements and hashes their population. It is part of every
 * hash, so a figure produced by a different algorithm can never be mistaken for a reproduction. */
export const COMPILER_VERSION = "rastrata-core-report-v2";
export const CASH_FLOW_VERSION = "rastrata-cash-flow-v2";

/** The inputs that determine a statement's figures, apart from the book itself. */
export interface PopulationScope {
  readonly asOf: string;
  readonly from: string;
  readonly basis: ReportBasis;
  readonly fiscalYear: FiscalYearInfo;
}

/** The identity of a report's population: this book state at this revision, the chart and calendar in
 * force on the date, the range, the basis and the fiscal year the roll-forward uses. Two compilations
 * with the same hash read the same facts the same way; the book changing, or a different range or
 * basis, changes it. A comparison column has its own hash: the one the same range would have alone. */
export function populationHash(
  state: BookState,
  chart: BookConfigurationSnapshot,
  scope: PopulationScope,
): string {
  return hashCanonical({
    type: "CoreReportPopulation",
    compilerVersion: COMPILER_VERSION,
    bookId: state.identity.bookId,
    bookStateHash: state.contentHash.digest,
    configurationHash: chart.contentHash.digest,
    bookRevision: state.bookRevision,
    postingSequence: state.latestPostingSequence,
    basis: scope.basis,
    asOf: scope.asOf,
    periodStart: scope.from,
    fiscalYearStart: scope.fiscalYear.startsOn,
    fiscalYearEnd: scope.fiscalYear.endsOn,
  }).digest;
}

/** The cash-flow statement depends on the account tags as well as the ledger, so its population adds
 * the tag map's hash to the ledger population it is built from. Changing any tag changes it. */
export function cashFlowPopulationHash(ledgerPopulationHash: string, tagMapHash: string): string {
  return hashCanonical({
    type: "CashFlowPopulation",
    compilerVersion: CASH_FLOW_VERSION,
    ledgerPopulationHash,
    tagMapHash,
  }).digest;
}

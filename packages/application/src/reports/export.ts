import type { BookState } from "@rastrata/kernel";

import type { AccountTagMap } from "../account-tags.ts";
import type {
  ReportBasis,
  ReportComparisonKind,
  ReportExport,
  ReportShare,
  ReportStatement,
} from "../client-contracts.gen.ts";
import { ApplicationError } from "../errors.ts";
import { generalLedgerData } from "./activity.ts";
import { compileCashFlow } from "./cash-flow.ts";
import { compileReports } from "./core.ts";
import {
  balanceSheetCsv,
  cashFlowCsv,
  generalLedgerCsv,
  profitLossCsv,
  trialBalanceCsv,
  type ExportHeader,
} from "./csv.ts";

/** A file this size is far past what a spreadsheet opens, and past the 16 MB the contract allows. */
export const MAX_EXPORT_CHARACTERS = 16_000_000;

export interface ExportRequest {
  readonly statement: ReportStatement;
  readonly asOf: string;
  readonly from?: string;
  readonly basis?: ReportBasis;
  /** Applies to the profit and loss, balance sheet and cash flow; the others have no comparison. */
  readonly compare?: ReportComparisonKind;
  /** The general ledger of one account (an account register) rather than of every account. */
  readonly accountId?: string;
  /** For the profit and loss only: `income` adds each line's share of total income (and the
   * comparison's) as columns of the file. */
  readonly share?: ReportShare;
  /** The book's name, printed in the file. */
  readonly bookName: string;
  /** The cash-flow statement reads account tags; the handler supplies them. */
  readonly tags: AccountTagMap;
}

const TITLES: Readonly<Record<ReportStatement, string>> = {
  "trial-balance": "Trial balance",
  "profit-loss": "Profit and loss",
  "balance-sheet": "Balance sheet",
  "cash-flow": "Cash flow statement",
  "general-ledger": "General ledger",
};

/** One statement as CSV, with the facts that identify it (book revision, range, basis, population
 * hash) at the top. The file name is built only from fixed words and validated dates, never from
 * book content. Every text cell is neutralised against spreadsheet formula injection (see csv.ts). */
export function exportStatement(
  state: BookState,
  request: ExportRequest,
  limit = MAX_EXPORT_CHARACTERS,
): ReportExport {
  const { statement, asOf, bookName } = request;
  if (request.accountId !== undefined && statement !== "general-ledger")
    throw new ApplicationError(
      "invalid_input",
      "accountId applies to the general ledger only: the other statements are of the whole book",
      400,
      [{ path: "accountId", message: "general-ledger only" }],
    );
  // Refused, not ignored: a file that was asked for shares and has none would read as a file of a book
  // with nothing to compare.
  if (request.share === "income" && statement !== "profit-loss")
    throw new ApplicationError(
      "invalid_input",
      "share applies to the profit and loss only: the other statements have no income to take a share of",
      400,
      [{ path: "share", message: "profit-loss only" }],
    );
  const options = {
    ...(request.from !== undefined ? { from: request.from } : {}),
    ...(request.basis !== undefined ? { basis: request.basis } : {}),
    ...(request.compare !== undefined ? { compare: request.compare } : {}),
  };
  const base = (
    report: Pick<
      ExportHeader,
      "currency" | "basis" | "bookRevision" | "populationHash" | "compilerVersion"
    > & { periodStart: string },
    ranged: boolean,
  ): ExportHeader => ({
    title: TITLES[statement],
    book: bookName,
    currency: report.currency,
    basis: report.basis,
    asOf,
    ...(ranged ? { periodStart: report.periodStart } : {}),
    bookRevision: report.bookRevision,
    populationHash: report.populationHash,
    compilerVersion: report.compilerVersion,
  });
  let content: string;
  let populationHash: string;
  let bookRevision: string;
  let periodStart: string;
  switch (statement) {
    case "trial-balance":
    case "profit-loss":
    case "balance-sheet": {
      const share = statement === "profit-loss" && request.share === "income";
      const report = compileReports(state, asOf, {
        ...options,
        ...(share ? { share: "income" } : {}),
      });
      const header = base(report, statement === "profit-loss");
      content =
        statement === "trial-balance"
          ? trialBalanceCsv(header, report.trialBalance)
          : statement === "profit-loss"
            ? profitLossCsv(header, report.profitAndLoss, { share, warnings: report.warnings })
            : balanceSheetCsv(header, report.balanceSheet);
      ({ populationHash, bookRevision, periodStart } = report);
      break;
    }
    case "cash-flow": {
      const report = compileCashFlow(state, asOf, { ...options, tags: request.tags });
      content = cashFlowCsv(base(report, true), report);
      ({ populationHash, bookRevision, periodStart } = report);
      break;
    }
    case "general-ledger": {
      const ledger = generalLedgerData(state, {
        asOf,
        ...(options.from !== undefined ? { from: options.from } : {}),
        ...(options.basis !== undefined ? { basis: options.basis } : {}),
      });
      // One account's register is the same ledger, narrowed to that account.
      const only = request.accountId;
      const accounts = only
        ? ledger.accounts.filter((account) => account.accountId === only)
        : ledger.accounts;
      const lines = only ? ledger.lines.filter((line) => line.accountId === only) : ledger.lines;
      content = generalLedgerCsv(base(ledger, true), accounts, lines);
      ({ populationHash, bookRevision, periodStart } = ledger);
      break;
    }
  }
  if (content.length > limit)
    throw new ApplicationError(
      "export_too_large",
      "This export is too large to return in one piece. Choose a shorter date range.",
      413,
    );
  const ranged = statement !== "trial-balance" && statement !== "balance-sheet";
  // The file name is fixed words and dates only: an account is named inside the file, not in its name.
  const kind = request.accountId !== undefined ? "account-register" : statement;
  return {
    statement,
    filename: ranged ? `${kind}-${periodStart}-to-${asOf}.csv` : `${statement}-${asOf}.csv`,
    mediaType: "text/csv; charset=utf-8",
    bookRevision,
    populationHash,
    content,
  };
}

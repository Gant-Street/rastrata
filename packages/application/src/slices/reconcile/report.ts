/** `reconcile.report`: the report on a finished reconciliation. Reads, and writes nothing.
 *
 * What a reconciliation leaves out is not stored. This works it out from what is frozen: the record, its
 * lines, the reconciliations of the account that were in force when it finished (the chain each record
 * keeps to the one before it), and the books at the revision it finished at. `reconcile/report.ts` does
 * the arithmetic and refuses to answer when the records and the books disagree; this file reads the rows,
 * checks the record's own fingerprint, and writes the reply.
 *
 * The pack's `reconciliations.csv` and `reconciliation-lines.csv` are written from the same replies
 * (`finishedReports`), so a file in the pack and the screen's report cannot differ. */
import type { BookState } from "@rastrata/kernel";

import type { ReconcileReport } from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import { formatMoney } from "../../money.ts";
import { reconciliationFileName, reconciliationReportCsv } from "../../reconcile/report-csv.ts";
import {
  type BookedPosting,
  deriveReport,
  type EarlierFacts,
  ReportMismatch,
  type ReportLine,
} from "../../reconcile/report.ts";
import { compareCodes } from "../../reports/chart.ts";
import type { ApplicationService } from "../../service.ts";
import { accountPostingsAt, clip } from "./book.ts";
import { accountOf, recordHash, voidOut } from "./reconciliations.ts";
import { REPORT_OUTSTANDING_LINES } from "./schema.ts";
import { reconcileState, type ReconcileState } from "./state.ts";
import type { LineRow, SessionRow } from "./store.ts";

const mismatch = (message: string) =>
  new ApplicationError(
    "reconcile_report_mismatch",
    `${message} The report was not made, because its figures could not be trusted. Do not complete another reconciliation of this account until this is understood.`,
    409,
  );

const lineOf = (row: LineRow): ReportLine => ({
  postingId: row.posting_id,
  journalId: row.journal_id,
  date: row.line_date,
  narration: row.narration,
  amount: row.amount,
});

/** The frozen lines of each reconciliation read so far, so a pack reads each only once. */
class FrozenLines {
  private readonly known = new Map<string, readonly LineRow[]>();
  constructor(private readonly rs: ReconcileState) {}
  of(sessionId: string): readonly LineRow[] {
    let rows = this.known.get(sessionId);
    if (rows === undefined) {
      rows = this.rs.store.lines(sessionId);
      this.known.set(sessionId, rows);
    }
    return rows;
  }
}

/** The reconciliations of the account that were in force when `session` finished, newest first: the one it
 * continues from, the one that one continued from, and so on. Each record keeps the one before it, so this
 * is exact, and a reconciliation voided since is still on it (it was in force then). */
function chainOf(rs: ReconcileState, session: SessionRow): SessionRow[] {
  const chain: SessionRow[] = [];
  const seen = new Set<string>([session.id]);
  let at = session;
  while (at.previous_id !== null) {
    const previous = rs.store.session(at.previous_id);
    if (
      previous === null ||
      previous.status !== "completed" ||
      previous.account_id !== session.account_id ||
      seen.has(previous.id) ||
      previous.record_hash !== at.previous_hash
    )
      throw mismatch(
        `The reconciliation ${at.id} says it continues from ${at.previous_id}, which is not a finished reconciliation of the same account with the fingerprint it names.`,
      );
    seen.add(previous.id);
    chain.push(previous);
    at = previous;
  }
  return chain;
}

/** The report for one finished reconciliation, read at the revision it finished at. */
function reportFor(
  rs: ReconcileState,
  state: BookState,
  session: SessionRow,
  frozen: FrozenLines,
): ReconcileReport {
  if (
    session.status !== "completed" ||
    session.book_revision === null ||
    session.completed_at === null ||
    session.record_hash === null ||
    session.opening_balance === null
  )
    throw mismatch(`The reconciliation ${session.id} is not a complete record.`);
  let revision: bigint;
  try {
    revision = BigInt(session.book_revision);
  } catch {
    throw mismatch(`The reconciliation ${session.id} names a book revision that is not a number.`);
  }
  if (revision > state.bookRevision)
    throw new ApplicationError(
      "reconcile_report_unavailable",
      `This reconciliation finished at book revision ${revision}, but the books this service holds are at revision ${state.bookRevision}. A report is read at the revision a reconciliation finished at, so it cannot be made until the books are whole again.`,
      409,
    );

  const chain = chainOf(rs, session);
  const own = frozen.of(session.id);
  // The record is what it was: the same fields hashed the same way give the fingerprint it carries.
  const previous = chain[0] ?? null;
  if (
    session.previous_hash !== (previous?.record_hash ?? null) ||
    recordHash({
      id: session.id,
      session,
      openingBalance: session.opening_balance,
      previous,
      bookRevision: session.book_revision,
      completedAt: session.completed_at,
      lines: own,
    }) !== session.record_hash
  )
    throw mismatch(
      `The fingerprint of reconciliation ${session.id} does not match what is recorded under it.`,
    );

  const postings: BookedPosting[] = accountPostingsAt(state, session.account_id, revision).map(
    (posting) => ({
      postingId: posting.postingId,
      journalId: posting.journalId,
      date: posting.date,
      narration: clip(posting.narration),
      cents: posting.cents,
    }),
  );
  const earlier: EarlierFacts[] = chain.map((item) => ({
    id: item.id,
    statementBalance: item.statement_balance,
    lines: frozen.of(item.id).map(lineOf),
  }));
  let derived: ReturnType<typeof deriveReport>;
  try {
    derived = deriveReport(
      {
        id: session.id,
        normalSide: session.normal_side,
        statementDate: session.statement_date,
        statementBalance: session.statement_balance,
        openingBalance: session.opening_balance,
        bookRevision: session.book_revision,
        lines: own.map(lineOf),
      },
      earlier,
      postings,
    );
  } catch (error) {
    if (error instanceof ReportMismatch) throw mismatch(error.message);
    throw error;
  }
  if (derived.outstanding.length > REPORT_OUTSTANDING_LINES)
    throw new ApplicationError(
      "reconcile_report_too_large",
      `${derived.outstanding.length} transactions were outstanding on ${session.statement_date}, more than the ${REPORT_OUTSTANDING_LINES} one report lists. Nothing is left out of a report, so it is not made.`,
      409,
    );

  const voided = rs.store.voidOf(session.id);
  return {
    id: session.id,
    status: voided === null ? "completed" : "voided",
    account: accountOf(session),
    currency: session.currency,
    statementDate: session.statement_date,
    statementBalance: session.statement_balance,
    openingBalance: session.opening_balance,
    previous:
      previous === null
        ? null
        : {
            id: previous.id,
            statementDate: previous.statement_date,
            statementBalance: previous.statement_balance,
          },
    completedAt: session.completed_at,
    recordHash: session.record_hash,
    previousHash: session.previous_hash,
    bookRevision: session.book_revision,
    void: voided === null ? null : voidOut(voided),
    cleared: {
      count: derived.cleared.length,
      total: formatMoney(derived.clearedTotal),
      lines: derived.cleared.map((line) => ({ ...line })),
    },
    outstanding: {
      count: derived.outstanding.length,
      total: formatMoney(derived.outstandingTotal),
      lines: derived.outstanding.map((line) => ({ ...line })),
    },
    bookBalance: formatMoney(derived.bookBalance),
    difference: formatMoney(derived.difference),
  };
}

export async function reconciliationReport(
  service: ApplicationService,
  input: { id: string; file?: "csv" },
): Promise<ReconcileReport> {
  const rs = reconcileState(service);
  const session = rs.store.session(input.id);
  if (session === null)
    throw new ApplicationError("reconcile_not_found", "No reconciliation has that id.", 404);
  if (session.status !== "completed")
    throw new ApplicationError(
      "reconcile_not_completed",
      "A draft has no report. Only a finished reconciliation does: complete the draft first.",
      409,
    );
  const { aggregate } = await service.readAggregate();
  const report = reportFor(rs, aggregate.state, session, new FrozenLines(rs));
  if (input.file !== "csv") return report;
  return {
    ...report,
    file: {
      filename: reconciliationFileName(report),
      mediaType: "text/csv; charset=utf-8",
      content: reconciliationReportCsv(report, service.setupState()?.name ?? ""),
    },
  };
}

/** The finished reconciliations (completed, and voided since) with a statement date in a range, as they were
 * when they finished, for the accountant pack. Only those finished by the book revision the pack is made
 * from are in it: `leftOut` counts the ones finished after, which a pack made from that revision would not
 * have had. Oldest first, then by account. A reconciliation that cannot be reported on fails the whole
 * list, naming it: a list that quietly left one out would be taken for the whole. */
export async function finishedReports(
  service: ApplicationService,
  range: { readonly from: string; readonly to: string; readonly revision: bigint },
): Promise<{ readonly reports: ReconcileReport[]; readonly leftOut: number }> {
  const rs = reconcileState(service);
  const inRange = rs.store
    .completedRecords()
    .filter((row) => row.statement_date >= range.from && row.statement_date <= range.to);
  // A record that does not say what revision it finished at is not left out: it is reported on, and refused
  // there with the reason, so that a damaged record is named and never quietly missing.
  const finishedBy = (row: SessionRow): boolean => {
    if (row.book_revision === null) return true;
    try {
      return BigInt(row.book_revision) <= range.revision;
    } catch {
      return true;
    }
  };
  const included: SessionRow[] = [];
  let leftOut = 0;
  for (const row of inRange) {
    if (finishedBy(row)) included.push(row);
    else leftOut += 1;
  }
  included.sort(
    (left, right) =>
      left.statement_date.localeCompare(right.statement_date) ||
      compareCodes(left.account_code, right.account_code) ||
      (left.seq ?? 0) - (right.seq ?? 0),
  );
  if (included.length === 0) return { reports: [], leftOut };
  const { aggregate } = await service.readAggregate();
  const frozen = new FrozenLines(rs);
  const reports: ReconcileReport[] = [];
  for (const row of included) {
    try {
      reports.push(reportFor(rs, aggregate.state, row, frozen));
    } catch (error) {
      if (!(error instanceof ApplicationError)) throw error;
      throw new ApplicationError(
        error.code,
        `The reconciliation of ${row.account_code} for the statement ending ${row.statement_date} (${row.id}): ${error.message}`,
        error.status,
      );
    }
  }
  return { reports, leftOut };
}

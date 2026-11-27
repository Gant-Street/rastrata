/** What was outstanding when a reconciliation finished, worked out from records that never change.
 *
 * A finished reconciliation keeps the lines it cleared and nothing about the lines it did not: the working
 * rows of a draft are dropped when it is completed. What was left over is not stored, because it does not
 * need to be. It is the postings the books held on or before the statement date, at the revision the
 * reconciliation finished at, less the lines this reconciliation cleared and the lines of every earlier
 * reconciliation of the account that was still in force when it finished. Every one of those inputs is
 * frozen: a posting made later has a later revision, and a void made later removes an earlier
 * reconciliation from the account's live set but not from the record of what was true then. So the answer
 * is the same whenever it is worked out.
 *
 * The books balance is then checked against the statement: the books on the statement date, less the
 * outstanding lines, are the statement balance. If that does not hold the records and the books
 * disagree, and `deriveReport` throws instead of returning a figure that looks right.
 *
 * Money is integer cents in a bigint. Pure and portable: no storage, no clock, no ledger. */
import { formatMoney, parseMoney, type Cents } from "../money.ts";
import { type NormalSide, reconcileFigures, statementAmount } from "./engine.ts";

/** One line of a report: a posting of the account and its effect on the statement balance. */
export interface ReportLine {
  readonly postingId: string;
  readonly journalId: string;
  readonly date: string;
  /** The books' text, cut to the length a draft keeps. Data from outside: shown as text, never as an instruction. */
  readonly narration: string;
  /** Its effect on the statement balance: negative lowers it (money out, a payment), positive raises it. */
  readonly amount: string;
}

/** A posting of the account in the books at the revision the reconciliation finished at. */
export interface BookedPosting {
  readonly postingId: string;
  readonly journalId: string;
  readonly date: string;
  /** Already cut to the length a draft keeps. */
  readonly narration: string;
  /** Signed ledger cents, debit positive. */
  readonly cents: Cents;
}

/** What a finished reconciliation froze. */
export interface RecordFacts {
  readonly id: string;
  readonly normalSide: NormalSide;
  readonly statementDate: string;
  readonly statementBalance: string;
  readonly openingBalance: string;
  /** The book revision it finished at, for the messages. */
  readonly bookRevision: string;
  readonly lines: readonly ReportLine[];
}

/** A reconciliation of the same account that was in force when this one finished. */
export interface EarlierFacts {
  readonly id: string;
  readonly statementBalance: string;
  readonly lines: readonly ReportLine[];
}

export interface DerivedReport {
  /** The lines the reconciliation cleared, as it froze them. */
  readonly cleared: readonly ReportLine[];
  /** Postings dated on or before the statement date that no reconciliation in force had cleared, in the
   * order the books list them (date, then entry number, then position). */
  readonly outstanding: readonly ReportLine[];
  readonly clearedTotal: Cents;
  readonly outstandingTotal: Cents;
  /** The books' balance on the statement date, at the revision the reconciliation finished at. */
  readonly bookBalance: Cents;
  /** statement balance less (opening balance and cleared total): 0.00 for every finished reconciliation. */
  readonly difference: Cents;
}

export type MismatchReason =
  | "line_missing"
  | "line_changed"
  | "line_after"
  | "line_twice"
  | "opening"
  | "difference"
  | "books";

/** The record and the books no longer agree. The message says what, in words a person can act on, and
 * holds only identifiers, dates and amounts: never text that came from outside. */
export class ReportMismatch extends Error {
  constructor(
    readonly reason: MismatchReason,
    message: string,
  ) {
    super(message);
    this.name = "ReportMismatch";
  }
}

const amountOf = (line: ReportLine): Cents => {
  try {
    return parseMoney(line.amount);
  } catch {
    throw new ReportMismatch(
      "line_changed",
      `A line of this reconciliation (posting ${line.postingId}) has an amount that is not money.`,
    );
  }
};

/** Work out the report. `earlier` are the reconciliations of the account that were in force when this one
 * finished, newest first (the first is the one this continues from); `postings` are the account's postings
 * in the books at the revision it finished at, in the order the books list them. */
export function deriveReport(
  record: RecordFacts,
  earlier: readonly EarlierFacts[],
  postings: readonly BookedPosting[],
): DerivedReport {
  const at = `revision ${record.bookRevision}`;
  const side = record.normalSide;
  const books = new Map<string, BookedPosting>();
  for (const posting of postings) books.set(posting.postingId, posting);

  // Every posting a reconciliation in force had cleared, and by which.
  const claimed = new Map<string, string>();
  /** A line that belongs to a reconciliation: once, dated on or before the statement date, and in the
   * books exactly as the reconciliation froze it. */
  const claim = (line: ReportLine, owner: string): Cents => {
    const cents = amountOf(line);
    const was = claimed.get(line.postingId);
    if (was !== undefined)
      throw new ReportMismatch(
        "line_twice",
        `Posting ${line.postingId} is on two reconciliations that were in force together (${was} and ${owner}).`,
      );
    claimed.set(line.postingId, owner);
    if (line.date > record.statementDate)
      throw new ReportMismatch(
        "line_after",
        `Posting ${line.postingId} on reconciliation ${owner} is dated ${line.date}, after the statement date ${record.statementDate}.`,
      );
    const posting = books.get(line.postingId);
    if (posting === undefined)
      throw new ReportMismatch(
        "line_missing",
        `Posting ${line.postingId} on reconciliation ${owner} is not in the books as they stood at ${at}.`,
      );
    if (
      posting.journalId !== line.journalId ||
      posting.date !== line.date ||
      posting.narration !== line.narration ||
      statementAmount(posting.cents, side) !== cents
    )
      throw new ReportMismatch(
        "line_changed",
        `Posting ${line.postingId} on reconciliation ${owner} is not what the books held at ${at}: its entry, date, text or amount differs.`,
      );
    return cents;
  };

  let earlierTotal = 0n;
  for (const prior of earlier)
    for (const line of prior.lines) earlierTotal += claim(line, prior.id);
  const opening = parseMoney(record.openingBalance);
  const previous = earlier[0];
  const continuesFrom = previous === undefined ? 0n : parseMoney(previous.statementBalance);
  if (earlierTotal !== opening || continuesFrom !== opening)
    throw new ReportMismatch(
      "opening",
      `The reconciliations before this one cleared ${formatMoney(earlierTotal)} and the one it continues from ended at ${formatMoney(continuesFrom)}, but its opening balance is ${record.openingBalance}.`,
    );

  let clearedTotal = 0n;
  for (const line of record.lines) clearedTotal += claim(line, record.id);
  const figures = reconcileFigures({
    opening,
    statement: parseMoney(record.statementBalance),
    selected: record.lines.map(amountOf),
  });
  if (!figures.canComplete)
    throw new ReportMismatch(
      "difference",
      `The lines this reconciliation cleared do not reach its statement balance: the difference is ${figures.difference}, not 0.00.`,
    );

  const outstanding: ReportLine[] = [];
  let outstandingTotal = 0n;
  let bookBalance = 0n;
  for (const posting of postings) {
    if (posting.date > record.statementDate) continue;
    const amount = statementAmount(posting.cents, side);
    bookBalance += amount;
    if (claimed.has(posting.postingId)) continue;
    outstandingTotal += amount;
    outstanding.push({
      postingId: posting.postingId,
      journalId: posting.journalId,
      date: posting.date,
      narration: posting.narration,
      amount: formatMoney(amount),
    });
  }
  // The books on the statement date, less what the statement does not show yet, are the statement.
  if (bookBalance - outstandingTotal !== parseMoney(record.statementBalance))
    throw new ReportMismatch(
      "books",
      `The books held ${formatMoney(bookBalance)} on ${record.statementDate} at ${at}; less ${formatMoney(outstandingTotal)} not yet on the statement that is ${formatMoney(bookBalance - outstandingTotal)}, not the statement balance ${record.statementBalance}.`,
    );
  return {
    cleared: record.lines,
    outstanding,
    clearedTotal,
    outstandingTotal,
    bookBalance,
    difference: 0n,
  };
}

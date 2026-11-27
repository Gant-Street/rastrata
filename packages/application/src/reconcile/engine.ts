/** The arithmetic and calendar rules of a reconciliation. Pure and portable: no storage, no
 * clock, no ledger. The service, the tests and (through the strings it returns) every client rely
 * on one definition of "the difference".
 *
 * Money is integer cents in a bigint (see money.ts). There is no float and no tolerance anywhere
 * in this file: a reconciliation is complete at exactly 0.00 or it is not complete. */
import { formatMoney, parseMoney, type Cents } from "../money.ts";

export type NormalSide = "debit" | "credit";

/** The most lines one reconciliation holds. A statement has hundreds of lines, a first
 * reconciliation of a long history a few thousand; beyond this the right answer is a smaller
 * statement (an earlier date), not a bigger screen. */
export const MAX_LINES = 5000;

/** Statement orientation. A statement shows an asset's balance as money you have (debit positive)
 * and a liability's as money you owe (credit positive). The ledger is debit positive for both,
 * so a liability's amounts are negated on the way in. Every figure a reconciliation shows is in
 * statement orientation: a line's amount is its effect on the statement balance. */
export const statementSign = (side: NormalSide): bigint => (side === "debit" ? 1n : -1n);

export const statementAmount = (ledgerCents: Cents, side: NormalSide): Cents =>
  ledgerCents * statementSign(side);

export interface Figures {
  readonly selectedCount: number;
  readonly selectedTotal: string;
  readonly clearedBalance: string;
  readonly difference: string;
  /** True only at exactly 0.00. */
  readonly canComplete: boolean;
}

/** `opening` is the balance already cleared by earlier reconciliations, `statement` the balance
 * the statement ends with, and `selected` the amounts of the lines ticked so far.
 * difference = statement - (opening + sum(selected)). */
export function reconcileFigures(input: {
  readonly opening: Cents;
  readonly statement: Cents;
  readonly selected: Iterable<Cents>;
}): Figures {
  let total = 0n;
  let count = 0;
  for (const amount of input.selected) {
    total += amount;
    count += 1;
  }
  const cleared = input.opening + total;
  const difference = input.statement - cleared;
  return {
    selectedCount: count,
    selectedTotal: formatMoney(total),
    clearedBalance: formatMoney(cleared),
    difference: formatMoney(difference),
    canComplete: difference === 0n,
  };
}

const STATEMENT_BALANCE = /^-?(0|[1-9][0-9]{0,15})\.[0-9]{2}$/;

/** Read a statement balance exactly as typed ("1234.50", "-12.00") into the canonical form, or
 * null when it is not an exact two-place amount. Zero is always "0.00". */
export function canonicalStatementBalance(value: string): string | null {
  return STATEMENT_BALANCE.test(value) ? formatMoney(parseMoney(value)) : null;
}

const CALENDAR_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/** A real calendar date in YYYY-MM-DD form. "2026-02-31" is not one. The calendar is plain
 * arithmetic on year, month and day; no time zone is involved. */
export function isCalendarDate(value: string): boolean {
  const match = CALENDAR_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1900 || year > 2200) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function addDays(date: string, days: number): string {
  if (!isCalendarDate(date)) throw new TypeError("Not a calendar date");
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** The date part of an ISO instant, read as written (no conversion). */
export const dateOf = (instant: string): string => instant.slice(0, 10);

export interface StatementDateFacts {
  /** The book's today, YYYY-MM-DD. */
  readonly today: string;
  /** The statement date of the latest completed, unvoided reconciliation of the account. */
  readonly lastStatementDate: string | null;
}

export type StatementDateProblem = "invalid" | "in_future" | "not_after_last";

/** Why a statement date cannot be used, or null. A statement ends on or before today (one day of
 * slack absorbs the difference between the person's calendar and the book's UTC date) and after
 * the previous reconciliation, because each reconciliation continues from the one before it. */
export function statementDateProblem(
  date: string,
  facts: StatementDateFacts,
): StatementDateProblem | null {
  if (!isCalendarDate(date)) return "invalid";
  if (date > addDays(facts.today, 1)) return "in_future";
  if (facts.lastStatementDate !== null && date <= facts.lastStatementDate) return "not_after_last";
  return null;
}

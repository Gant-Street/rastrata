/** The tie-out: Rastrata's books against Xero's, by account and by period, only where Xero can be
 * trusted, with every difference explained or said to be unexplained.
 *
 * Why not simply compare. A small business is often months behind on reconciling in the old system,
 * and a ledger that is stale cannot be the yardstick: the evidence that Rastrata is right is that each
 * bank, card and Stripe balance reconciles to its statement at exactly 0.00 (the cutover checklist).
 * Xero is a second check, and only for the places where it was itself reconciled. So for each period
 * and each account this says one of:
 *
 * - it matches, to the cent;
 * - it differs, and then which lines are in one book and not the other, so the difference is the sum
 *   of lines a person can look at, plus what both books already disagreed about when the period began
 *   (what the opening balances were);
 * - it is not comparable, and why (Xero was not reconciled through the end of the period, the period
 *   starts before the cutover date, the account has no counterpart in Xero, and so on).
 *
 * The arithmetic is exact cents, and every amount here is debit-positive: a debit less a credit, so a
 * number means the same in both books whatever the account's role. The service turns it into the
 * account's normal orientation for people. The engine is pure: the service gathers Rastrata's side
 * through the reports lane's operations and Xero's from what was imported, and hands both here. */
import type { OpeningRole } from "../opening.ts";
import { isProfitLoss } from "../opening.ts";

/** One line of a ledger on either side: a signed amount (debit less credit) on a date. */
export interface Line {
  /** Identifies the line in its own book: the Xero file and row, or the Rastrata posting. */
  readonly id: string;
  readonly date: string;
  readonly description: string;
  readonly reference: string;
  /** Where it came from in Xero ("Spend Money"), or empty. */
  readonly source: string;
  readonly net: bigint;
}

export interface XeroAccountInput {
  readonly code: string;
  readonly name: string;
  /** A bank or card account in Xero: reconciled against a statement. */
  readonly bank: boolean;
}

/** An account of the book and the Xero accounts mapped to it. */
export interface AccountInput {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly role: OpeningRole;
  /** Empty: nothing in Xero stands for it. */
  readonly xero: readonly XeroAccountInput[];
}

export interface PeriodInput {
  /** The first and last day of the period, inclusive. */
  readonly from: string;
  readonly to: string;
  /** Rastrata: the balance at the end of the period, and the movement within it, by account id. */
  readonly rastrataClosing: ReadonlyMap<string, bigint>;
  readonly rastrataMovement: ReadonlyMap<string, bigint>;
  readonly rastrataLines: ReadonlyMap<string, readonly Line[]>;
  /** Xero's trial balance (year to date) at the end of the period and at the end of the day before
   * it, by Xero code; null when none was imported for that date. */
  readonly xeroClosing: ReadonlyMap<string, bigint> | null;
  readonly xeroOpening: ReadonlyMap<string, bigint> | null;
  /** The two dates are in one financial year, so income and expense accounts' year-to-date amounts
   * can be subtracted to give the period's movement. */
  readonly sameFiscalYear: boolean;
  /** Xero's transactions in the period by Xero code; null when no imported file covers the whole
   * period (a file that covers part of it says nothing about the rest). */
  readonly xeroLines: ReadonlyMap<string, readonly Line[]> | null;
}

export type NotComparable =
  | "no_xero_counterpart"
  | "before_cutover"
  | "xero_not_reconciled"
  | "no_xero_data"
  | "fiscal_year_boundary";

export interface Reason {
  readonly code: NotComparable;
  readonly message: string;
}

export interface LineDifference {
  readonly side: "xero" | "rastrata";
  readonly line: Line;
}

export interface AccountResult {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly role: OpeningRole;
  /** What is compared: the balance at the end of the period, or the movement within it. */
  readonly basis: "closing" | "movement";
  readonly status: "matches" | "differs" | "not_comparable";
  readonly reason: Reason | null;
  readonly xero: bigint | null;
  readonly rastrata: bigint | null;
  /** Rastrata less Xero. */
  readonly difference: bigint | null;
  /** For a balance: what the two books already disagreed about when the period began, which the
   * closing difference includes. Null when the movement cannot be worked out on both sides. */
  readonly carried: bigint | null;
  /** The lines found in one book and not the other. Null when no Xero lines cover the period. */
  readonly unmatched: readonly LineDifference[] | null;
  /** Lines that matched one for one. */
  readonly matched: number;
  /** What the lines leave unexplained of the period's difference: zero means every cent is
   * accounted for. Null when there are no lines to explain it with. */
  readonly residual: bigint | null;
}

export interface BankState {
  readonly code: string;
  readonly name: string;
  readonly through: string | null;
}

export interface UnmappedXero {
  readonly code: string;
  readonly name: string;
  /** Its year-to-date balance when a trial balance was imported, else its movement in the period. */
  readonly net: bigint;
}

export interface PeriodResult {
  readonly from: string;
  readonly to: string;
  readonly accounts: readonly AccountResult[];
  /** Xero accounts with a balance or movement and no account of the book to compare with. */
  readonly unmapped: readonly UnmappedXero[];
  /** Every Xero bank account with activity was reconciled through the end of the period. */
  readonly xeroReconciled: boolean;
  readonly xeroNotReconciled: readonly BankState[];
}

export interface TieOutInput {
  readonly cutoverDate: string | null;
  readonly accounts: readonly AccountInput[];
  /** Xero accounts with no entry in the mapping, by code (not the ones the owner left out). */
  readonly xeroUnmapped: ReadonlyMap<string, { readonly name: string; readonly bank: boolean }>;
  /** The date each Xero bank account was reconciled through, by Xero code. */
  readonly reconciledThrough: ReadonlyMap<string, string>;
  readonly periods: readonly PeriodInput[];
  /** How many days apart a line in each book may be and still be the same transaction. */
  readonly toleranceDays?: number;
}

export const DEFAULT_TOLERANCE_DAYS = 4;
const DAY = 86_400_000;
const dayNumber = (date: string): number => Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY);

const sum = (values: Iterable<bigint>): bigint => {
  let total = 0n;
  for (const value of values) total += value;
  return total;
};

const compareLines = (a: Line, b: Line): number =>
  dayNumber(a.date) - dayNumber(b.date) ||
  (a.net < b.net ? -1 : a.net > b.net ? 1 : 0) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Match the lines of the two books that have the same amount and fall within `tolerance` days of
 * each other, the nearest first. What is left on each side is what differs. */
export function matchLines(
  xero: readonly Line[],
  rastrata: readonly Line[],
  tolerance: number,
): { unmatched: LineDifference[]; matched: number } {
  const byAmount = new Map<bigint, Line[]>();
  for (const line of [...rastrata].sort(compareLines)) {
    const group = byAmount.get(line.net);
    if (group) group.push(line);
    else byAmount.set(line.net, [line]);
  }
  const unmatched: LineDifference[] = [];
  let matched = 0;
  for (const line of [...xero].sort(compareLines)) {
    const group = byAmount.get(line.net) ?? [];
    let best = -1;
    let gap = Number.POSITIVE_INFINITY;
    group.forEach((candidate, index) => {
      const apart = Math.abs(dayNumber(candidate.date) - dayNumber(line.date));
      if (apart <= tolerance && apart < gap) {
        gap = apart;
        best = index;
      }
    });
    if (best === -1) unmatched.push({ side: "xero", line });
    else {
      group.splice(best, 1);
      matched++;
    }
  }
  for (const group of byAmount.values())
    for (const line of group) unmatched.push({ side: "rastrata", line });
  unmatched.sort((a, b) => compareLines(a.line, b.line) || (a.side < b.side ? -1 : 1));
  return { unmatched, matched };
}

const through = (date: string | null | undefined): string =>
  date ? `through ${date}` : "on no date that was given";

function tiePeriod(input: TieOutInput, period: PeriodInput, tolerance: number): PeriodResult {
  // Xero's bank accounts that were active in the period, and whether each was reconciled through it.
  // Codes are compared without regard to case, as Xero does.
  const key = (code: string): string => code.trim().toLowerCase();
  const banks = new Map<string, { code: string; name: string }>();
  for (const account of input.accounts)
    for (const xero of account.xero)
      if (xero.bank) banks.set(key(xero.code), { code: xero.code, name: xero.name });
  for (const [code, info] of input.xeroUnmapped)
    if (info.bank) banks.set(key(code), { code, name: info.name });
  const reconciledOn = new Map(
    [...input.reconciledThrough].map(([code, date]) => [key(code), date]),
  );
  const lookup = <T>(map: ReadonlyMap<string, T> | null, code: string): T | undefined => {
    if (map === null) return undefined;
    const direct = map.get(code);
    if (direct !== undefined) return direct;
    for (const [other, value] of map) if (key(other) === key(code)) return value;
    return undefined;
  };
  const active = (code: string): boolean =>
    (lookup(period.xeroLines, code) ?? []).length > 0 ||
    (lookup(period.xeroClosing, code) ?? 0n) !== (lookup(period.xeroOpening, code) ?? 0n);
  const notReconciled: BankState[] = [];
  for (const [id, bank] of banks) {
    if (!active(bank.code)) continue;
    const date = reconciledOn.get(id) ?? null;
    if (date === null || date < period.to) notReconciled.push({ ...bank, through: date });
  }
  notReconciled.sort((a, b) => (a.code < b.code ? -1 : 1));

  const results: AccountResult[] = [];
  for (const account of input.accounts) {
    const movementBasis = isProfitLoss(account.role) || account.role === "equity";
    const rastrataClosing = period.rastrataClosing.get(account.accountId) ?? 0n;
    const rastrataMovement = period.rastrataMovement.get(account.accountId) ?? 0n;
    const rastrataLines = period.rastrataLines.get(account.accountId) ?? [];
    const rastrata = movementBasis ? rastrataMovement : rastrataClosing;
    const base = {
      accountId: account.accountId,
      code: account.code,
      name: account.name,
      role: account.role,
      basis: movementBasis ? ("movement" as const) : ("closing" as const),
    };
    const skip = (reason: Reason): AccountResult => ({
      ...base,
      status: "not_comparable",
      reason,
      xero: null,
      rastrata,
      difference: null,
      carried: null,
      unmatched: null,
      matched: 0,
      residual: null,
    });

    if (account.xero.length === 0) {
      // What would be compared is nothing: not a row.
      if (rastrata === 0n && rastrataLines.length === 0) continue;
      results.push(
        skip({
          code: "no_xero_counterpart",
          message: "No Xero account is mapped to this account.",
        }),
      );
      continue;
    }
    const codes = account.xero.map((xero) => xero.code);
    // An account with nothing in either book in the period is not a row.
    const touched = codes.some(
      (code) =>
        (lookup(period.xeroClosing, code) ?? 0n) !== 0n ||
        (lookup(period.xeroOpening, code) ?? 0n) !== 0n ||
        (lookup(period.xeroLines, code) ?? []).length > 0,
    );
    if (rastrata === 0n && rastrataLines.length === 0 && !touched) continue;
    if (input.cutoverDate !== null && period.from < input.cutoverDate) {
      results.push(
        skip({
          code: "before_cutover",
          message: `The period starts on ${period.from}, before the cutover date ${input.cutoverDate}: the book has nothing for the days before it.`,
        }),
      );
      continue;
    }
    const ownBanks = account.xero.filter((xero) => xero.bank);
    const blockedBy =
      ownBanks.length > 0
        ? notReconciled.filter((item) => ownBanks.some((xero) => key(xero.code) === key(item.code)))
        : notReconciled;
    if (blockedBy.length > 0) {
      const first = blockedBy[0];
      results.push(
        skip({
          code: "xero_not_reconciled",
          message:
            ownBanks.length > 0
              ? `Xero was reconciled ${through(first?.through)} for ${blockedBy.map((item) => item.name).join(", ")}, not through ${period.to}, so Xero's figures for it are not a yardstick.`
              : `Xero's bank accounts were not all reconciled through ${period.to} (${blockedBy
                  .slice(0, 3)
                  .map((item) => `${item.name}: ${through(item.through)}`)
                  .join(
                    "; ",
                  )}${blockedBy.length > 3 ? "; and more" : ""}), so Xero's figures here are not a yardstick.`,
        }),
      );
      continue;
    }
    if (isProfitLoss(account.role) && !period.sameFiscalYear && period.xeroLines === null) {
      results.push(
        skip({
          code: "fiscal_year_boundary",
          message:
            "The period crosses a financial year end in Xero, where its year-to-date amounts start again, so its movement cannot be worked out from two trial balances. Import the account transactions for the period.",
        }),
      );
      continue;
    }
    // Xero's movement: its transactions when they cover the period, else the change between two
    // trial balances. Xero's balance: its trial balance at the end of the period.
    const xeroLines = period.xeroLines
      ? codes.flatMap((code) => lookup(period.xeroLines, code) ?? [])
      : null;
    const xeroClosing = period.xeroClosing
      ? sum(codes.map((code) => lookup(period.xeroClosing, code) ?? 0n))
      : null;
    const fromTrialBalances =
      period.xeroClosing &&
      period.xeroOpening &&
      (period.sameFiscalYear || !isProfitLoss(account.role))
        ? sum(codes.map((code) => lookup(period.xeroClosing, code) ?? 0n)) -
          sum(codes.map((code) => lookup(period.xeroOpening, code) ?? 0n))
        : null;
    const xeroMovement = xeroLines ? sum(xeroLines.map((line) => line.net)) : fromTrialBalances;
    const useClosing = !movementBasis && xeroClosing !== null;
    const xero = useClosing ? xeroClosing : xeroMovement;
    if (xero === null) {
      results.push(
        skip({
          code: "no_xero_data",
          message: movementBasis
            ? `Neither Xero's transactions nor two of its trial balances (as at the day before ${period.from} and as at ${period.to}) were imported for this period.`
            : `No Xero trial balance as at ${period.to}, and no transactions covering the period, were imported.`,
        }),
      );
      continue;
    }
    const difference = rastrata - xero;
    const movementDifference = xeroMovement === null ? null : rastrataMovement - xeroMovement;
    const carried =
      useClosing && movementDifference !== null ? difference - movementDifference : null;
    let unmatched: LineDifference[] | null = null;
    let matched = 0;
    let residual: bigint | null = null;
    if (xeroLines !== null) {
      const result = matchLines(xeroLines, rastrataLines, tolerance);
      unmatched = result.unmatched;
      matched = result.matched;
      const explained = sum(
        result.unmatched.map((item) => (item.side === "rastrata" ? item.line.net : -item.line.net)),
      );
      residual = (movementDifference ?? 0n) - explained;
    }
    results.push({
      ...base,
      status: difference === 0n ? "matches" : "differs",
      reason: null,
      xero,
      rastrata,
      difference,
      carried,
      unmatched,
      matched,
      residual,
    });
  }

  const unmapped: UnmappedXero[] = [];
  for (const [code, info] of input.xeroUnmapped) {
    const closing = lookup(period.xeroClosing, code) ?? 0n;
    const lines = sum((lookup(period.xeroLines, code) ?? []).map((line) => line.net));
    const net = closing !== 0n ? closing : lines;
    if (net !== 0n) unmapped.push({ code, name: info.name, net });
  }
  unmapped.sort((a, b) => (a.code < b.code ? -1 : 1));
  return {
    from: period.from,
    to: period.to,
    accounts: results,
    unmapped,
    xeroReconciled: notReconciled.length === 0,
    xeroNotReconciled: notReconciled,
  };
}

/** The tie-out for every period, in order. */
export function tieOut(input: TieOutInput): PeriodResult[] {
  const tolerance = input.toleranceDays ?? DEFAULT_TOLERANCE_DAYS;
  return input.periods.map((period) => tiePeriod(input, period, tolerance));
}

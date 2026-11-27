import { formatMoney, parseMoney } from "../money.ts";
import type { StatementLine } from "./csv-mapping.ts";

/** What a file's own running balance says about its lines.
 *
 * A bank that prints a balance after every line gives a way to check the file against itself: each
 * balance should be the one before it plus the amount. When that holds the file is complete and the
 * amounts are read correctly; when it breaks, a line is missing or misread, and the first row where
 * it breaks is where to look. It also settles two questions a person would otherwise guess at: which
 * way the file is ordered (Chase lists the newest first) and whether the balance counts the way the
 * amounts do (a card statement may show what you owe as a positive number). */

export interface BalanceAnalysis {
  /** Which end of the file holds the oldest line. */
  readonly order: "oldest-first" | "newest-first";
  /** The balance column counts the opposite way from the amounts; balances were flipped to match. */
  readonly flipped: boolean;
  /** Pairs of neighbouring lines compared. */
  readonly compared: number;
  /** File rows where the balance does not follow from the amount (at most the first eight). */
  readonly breaks: readonly number[];
  readonly breakCount: number;
  /** The balance before the oldest line, worked out from its balance and amount. */
  readonly opening: string;
  /** The balance after the newest line, and the date of that line. */
  readonly closing: { readonly asOf: string; readonly balance: string };
  /** The lines with their balances corrected to the account's own sign. */
  readonly lines: readonly StatementLine[];
}

const MAX_LISTED_BREAKS = 8;

/** Returns null when not every line has a balance, or there are no lines. `force` fixes the sign
 * convention instead of finding it: `true` flips the balances, `false` keeps them. */
export function analyzeBalances(
  lines: readonly StatementLine[],
  force?: boolean,
): BalanceAnalysis | null {
  const count = lines.length;
  if (count === 0) return null;
  const balance: bigint[] = [];
  const amount: bigint[] = [];
  for (const { line } of lines) {
    if (line.runningBalance === undefined) return null;
    balance.push(parseMoney(line.runningBalance));
    amount.push(parseMoney(line.amount));
  }
  const matches = (oldestFirst: boolean, sign: bigint): number => {
    let ok = 0;
    if (oldestFirst) {
      for (let index = 1; index < count; index++)
        if (
          (balance[index] as bigint) - (balance[index - 1] as bigint) ===
          sign * (amount[index] as bigint)
        )
          ok++;
    } else {
      for (let index = 0; index < count - 1; index++)
        if (
          (balance[index] as bigint) - (balance[index + 1] as bigint) ===
          sign * (amount[index] as bigint)
        )
          ok++;
    }
    return ok;
  };
  const candidates = (force === undefined ? [1n, -1n] : [force ? -1n : 1n]).flatMap((sign) => [
    { oldestFirst: true, sign, ok: matches(true, sign) },
    { oldestFirst: false, sign, ok: matches(false, sign) },
  ]);
  const dateFirst = (lines[0] as StatementLine).line.postedOn;
  const dateLast = (lines[count - 1] as StatementLine).line.postedOn;
  const preferOldestFirst = dateFirst <= dateLast;
  // The most matches win. A tie goes to the sign that is not flipped (a file is never "corrected"
  // without evidence), then to the order the dates suggest.
  const rank = (candidate: (typeof candidates)[number]) =>
    candidate.ok * 4 +
    (candidate.sign === 1n ? 2 : 0) +
    (candidate.oldestFirst === preferOldestFirst ? 1 : 0);
  let best = candidates[0] as (typeof candidates)[number];
  for (const candidate of candidates) if (rank(candidate) > rank(best)) best = candidate;
  const compared = count - 1;
  const { oldestFirst, sign } = best;
  const breakRows: number[] = [];
  let breakCount = 0;
  const verify = (newer: number, older: number, using: number) => {
    if (
      (balance[newer] as bigint) - (balance[older] as bigint) !==
      sign * (amount[using] as bigint)
    ) {
      breakCount++;
      if (breakRows.length < MAX_LISTED_BREAKS) breakRows.push((lines[using] as StatementLine).row);
    }
  };
  if (oldestFirst) for (let index = 1; index < count; index++) verify(index, index - 1, index);
  else for (let index = 0; index < count - 1; index++) verify(index, index + 1, index);
  const oldest = oldestFirst ? 0 : count - 1;
  const newest = oldestFirst ? count - 1 : 0;
  const flipped = sign === -1n;
  const corrected = lines.map(({ line, row }) =>
    flipped
      ? {
          row,
          line: {
            ...line,
            runningBalance: formatMoney(-parseMoney(line.runningBalance as string)),
          },
        }
      : { row, line },
  );
  const open = sign * (balance[oldest] as bigint) - (amount[oldest] as bigint);
  return {
    order: oldestFirst ? "oldest-first" : "newest-first",
    flipped,
    compared,
    breaks: breakRows,
    breakCount,
    opening: formatMoney(open),
    closing: {
      asOf: (lines[newest] as StatementLine).line.postedOn,
      balance: formatMoney(sign * (balance[newest] as bigint)),
    },
    lines: corrected,
  };
}

export interface LineSummary {
  readonly count: number;
  readonly from: string | null;
  readonly to: string | null;
  readonly moneyIn: string;
  readonly moneyOut: string;
  readonly net: string;
  readonly inCount: number;
  readonly outCount: number;
}

/** Totals of what a file would import, in exact cents. */
export function summarizeLines(lines: readonly StatementLine[]): LineSummary {
  let moneyIn = 0n;
  let moneyOut = 0n;
  let inCount = 0;
  let outCount = 0;
  let from: string | null = null;
  let to: string | null = null;
  for (const { line } of lines) {
    const cents = parseMoney(line.amount);
    if (cents > 0n) {
      moneyIn += cents;
      inCount++;
    } else {
      moneyOut += cents;
      outCount++;
    }
    if (from === null || line.postedOn < from) from = line.postedOn;
    if (to === null || line.postedOn > to) to = line.postedOn;
  }
  return {
    count: lines.length,
    from,
    to,
    moneyIn: formatMoney(moneyIn),
    moneyOut: formatMoney(moneyOut),
    net: formatMoney(moneyIn + moneyOut),
    inCount,
    outCount,
  };
}

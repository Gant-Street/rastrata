import { ApplicationError } from "../../src/errors.ts";
import { PROFIT_LOSS_ROLES } from "../../src/reports/chart.ts";
import { endOfMonth } from "../../src/reports/dates.ts";
import { ROLE_OF, months } from "./scenario.ts";

export const BEGINNING = "0001-01-01";

export const isProfitLoss = (code: string): boolean =>
  PROFIT_LOSS_ROLES.includes(ROLE_OF[code] ?? "asset");

/** A normal balance shown positive: debit-normal roles keep the ledger sign, the rest flip it. */
export const shown = (code: string, cents: bigint): bigint =>
  ROLE_OF[code] === "asset" || ROLE_OF[code] === "expense" ? cents : -cents;

/** The last day of each of the first `count` months of a book starting at `startMonth` of `firstYear`. */
export const monthEnds = (firstYear: number, count: number, startMonth = 1): string[] =>
  months({ firstYear, years: Math.ceil(count / 12), startMonth })
    .slice(0, count)
    .map(([year, month]) => endOfMonth(`${year}-${String(month).padStart(2, "0")}-01`));

/** The error a call raises, so a test can assert its code, status and message. */
export function failure(work: () => unknown): ApplicationError {
  try {
    work();
  } catch (error) {
    if (error instanceof ApplicationError) return error;
    throw error;
  }
  throw new Error("Expected the call to fail");
}

export const row = <T extends { code: string }>(rows: readonly T[], code: string): T => {
  const found = rows.find((item) => item.code === code);
  if (!found) throw new Error(`No row for ${code}`);
  return found;
};

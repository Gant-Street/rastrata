import type { AccountSnapshot, BookConfigurationSnapshot, BookState } from "@rastrata/kernel";

import { chartIn, configurationsOf } from "./ledger-history.ts";

export type AccountRole = AccountSnapshot["role"];

export const PROFIT_LOSS_ROLES: readonly AccountRole[] = [
  "income",
  "gain",
  "unrealizedGain",
  "expense",
];
export const BALANCE_SHEET_ROLES: readonly AccountRole[] = ["asset", "liability", "equity"];

/** Statements list balance-sheet accounts first, then income and expense, each role together. */
const ROLE_ORDER: Readonly<Record<AccountRole, number>> = {
  asset: 0,
  liability: 1,
  equity: 2,
  income: 3,
  gain: 4,
  unrealizedGain: 5,
  expense: 6,
};

export const isProfitLossRole = (role: AccountRole): boolean => PROFIT_LOSS_ROLES.includes(role);
export const isIncomeRole = (role: AccountRole): boolean =>
  role === "income" || role === "gain" || role === "unrealizedGain";

/** The ledger signs debits positive. A statement shows a normal balance as a positive figure, so
 * credit-normal accounts (liabilities, equity, income) flip the sign and debit-normal ones keep it. */
export const presented = (role: AccountRole, cents: bigint): bigint =>
  role === "asset" || role === "expense" ? cents : -cents;

/** The chart in force on a date: the latest configuration that took effect on or before it. Accounts
 * opened later are absent and an account keeps the name it had then, so a report for a past date
 * reads as it did. */
export function configurationAt(state: BookState, asOf: string): BookConfigurationSnapshot {
  return chartIn(configurationsOf(state.revisions), state, asOf);
}

export interface ChartAccount {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly role: AccountRole;
}

/** Order two account codes the way a person reads them: digit runs by value, so "2000" follows
 * "900", and anything else by character. Codes are at most twenty characters of letters, digits,
 * underscore and hyphen, so this is linear and cannot be made slow. */
export function compareCodes(left: string, right: string): number {
  const a = left.match(/\d+|\D+/g) ?? [];
  const b = right.match(/\d+|\D+/g) ?? [];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const x = a[index] as string;
    const y = b[index] as string;
    if (x === y) continue;
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const dx = BigInt(x);
      const dy = BigInt(y);
      if (dx !== dy) return dx < dy ? -1 : 1;
      return x.length - y.length;
    }
    return x < y ? -1 : 1;
  }
  return a.length - b.length || (left < right ? -1 : left > right ? 1 : 0);
}

export const compareAccounts = (left: ChartAccount, right: ChartAccount): number =>
  ROLE_ORDER[left.role] - ROLE_ORDER[right.role] ||
  compareCodes(left.code, right.code) ||
  (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

/** The accounts of a configuration in statement order. */
export function chartAccounts(chart: BookConfigurationSnapshot): readonly ChartAccount[] {
  return chart.admissionSnapshot.accounts
    .map((account) => ({
      id: account.id as string,
      code: account.code,
      name: account.name,
      role: account.role,
    }))
    .sort(compareAccounts);
}

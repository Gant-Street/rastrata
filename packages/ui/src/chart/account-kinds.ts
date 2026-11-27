import { nextSlotCode } from "./chart-logic";
import type { CashFlowClass, ChartRole } from "./chart-types";

/** The kinds of account a person adds, in plain English. The ledger knows five types (asset, liability,
 * equity, income, expense); a person thinks of a bank account and a credit card first, so those are kinds
 * too: each is a type with the cash-flow class the setup gives its lines, so the cash flow statement reads
 * it the way it reads the accounts the book started with. */
export type AccountKind = "bank" | "card" | "asset" | "liability" | "equity" | "income" | "expense";

export const ACCOUNT_KINDS: readonly AccountKind[] = [
  "bank",
  "card",
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
];

export interface KindFacts {
  readonly role: ChartRole;
  /** What the kind decides for the cash flow statement; the person may change it under Advanced. */
  readonly cashFlowClass?: CashFlowClass;
  /** The tag that keeps the kind on the account, so Home, Reconcile and the statement import know it. */
  readonly kind?: "bank" | "card";
}

export function kindFacts(kind: AccountKind): KindFacts {
  if (kind === "bank") return { role: "asset", cashFlowClass: "cash", kind };
  if (kind === "card") return { role: "liability", cashFlowClass: "operating", kind };
  return { role: kind };
}

/** The kind an existing account reads as in a list: what its tag says, else a bank account is an asset the
 * cash flow calls cash, and anything else is its type. */
export function kindOfAccount(account: {
  readonly role: string;
  readonly tags: {
    readonly cashFlowClass?: string | undefined;
    readonly kind?: string | undefined;
  };
}): string {
  if (account.tags.kind === "card" && account.role === "liability") return "card";
  if (account.tags.kind === "bank" && account.role === "asset") return "bank";
  return account.role === "asset" && account.tags.cashFlowClass === "cash" ? "bank" : account.role;
}

/** Where a type's codes start when the book has none of its own, and what a chart usually numbers them. */
const FIRST_CODE: Readonly<Record<ChartRole, number>> = {
  asset: 1100,
  liability: 2100,
  equity: 3000,
  income: 4000,
  expense: 6000,
};

/** The code to offer for a new account: the next free one in its range. A bank account or a card takes the
 * setup's own ranges (1000, 1010, ... and 2000, 2010, ...); any other kind goes on from the highest code its
 * type already has, in tens, so 6290 is followed by 6300. A code is only ever a suggestion: it is shown in
 * the box and can be typed over. */
export function suggestCode(
  accounts: readonly { readonly code: string; readonly role: string }[],
  kind: AccountKind,
): string {
  const used = new Set(accounts.map((account) => account.code.trim().toLowerCase()));
  if (kind === "bank" || kind === "card") {
    const code = nextSlotCode(accounts, kind);
    if (code !== "") return code;
  }
  const { role } = kindFacts(kind);
  const numbers = accounts
    .filter((account) => account.role === role)
    .map((account) => Number(account.code))
    .filter((value) => Number.isInteger(value) && value > 0);
  let next = numbers.length > 0 ? Math.max(...numbers) + 10 : FIRST_CODE[role];
  next = Math.ceil(next / 10) * 10;
  while (used.has(String(next))) next += 10;
  return String(next);
}

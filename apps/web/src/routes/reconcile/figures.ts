import type { InboxBalanceCheck, Reconciliation } from "@rastrata/application/client-contracts";
import { formatMoney, negateMoney, parseMoney } from "@rastrata/application/money";
import { reconcileFigures } from "@rastrata/application/reconcile-engine";

/** The same arithmetic the service uses, run in the browser on exact cents (a bigint), so the
 * difference on the screen is the difference the service will check: never a float, never a
 * tolerance. The service is still the authority; this makes every tick answer at once. */
type Line = Reconciliation["lines"][number];

export type Figures = ReturnType<typeof reconcileFigures>;

/** Parse every line's amount once. Reading a draft of a few thousand lines is a few milliseconds. */
export function centsOf(lines: readonly Line[]): ReadonlyMap<string, bigint> {
  return new Map(lines.map((line) => [line.postingId, parseMoney(line.amount)]));
}

export function figuresFor(
  draft: Pick<Reconciliation, "openingBalance" | "statementBalance">,
  cents: ReadonlyMap<string, bigint>,
  selected: ReadonlySet<string>,
): Figures {
  const amounts: bigint[] = [];
  for (const id of selected) {
    const value = cents.get(id);
    if (value !== undefined) amounts.push(value);
  }
  return reconcileFigures({
    opening: parseMoney(draft.openingBalance),
    statement: parseMoney(draft.statementBalance),
    selected: amounts,
  });
}

/** Counts and exact totals of the selected lines in each column. Totals are shown as positive
 * amounts: the column says which way the money went. */
export function columnTotals(
  lines: readonly Line[],
  cents: ReadonlyMap<string, bigint>,
  selected: ReadonlySet<string>,
) {
  let out = 0n;
  let into = 0n;
  let outCount = 0;
  let inCount = 0;
  for (const line of lines) {
    if (!selected.has(line.postingId)) continue;
    const value = cents.get(line.postingId) ?? 0n;
    if (value < 0n) {
      out -= value;
      outCount += 1;
    } else {
      into += value;
      inCount += 1;
    }
  }
  return {
    out: { count: outCount, total: formatMoney(out) },
    in: { count: inCount, total: formatMoney(into) },
  };
}

/** The exact total of some lines, for the read-only record. */
export function totalOf(lines: readonly Line[]): string {
  let total = 0n;
  for (const line of lines) total += parseMoney(line.amount);
  return formatMoney(total < 0n ? -total : total);
}

/** Providers whose balance is the ending balance printed on a **statement**: a file the owner
 * imported (`csv`, and `ofx` for OFX, QFX and QBO). A bank feed's balance (`simplefin`) is something
 * else: what an aggregator last read at some moment, which can include or leave out what the statement
 * will. Offering it as the statement's ending balance would let a reconciliation be finished against
 * the feed instead of the statement, so only these providers are ever offered, and a provider that is
 * not listed (a new one, or a feed) never is. */
export const STATEMENT_BALANCE_PROVIDERS: ReadonlySet<string> = new Set(["csv", "ofx", "qfx"]);

/** The newest imported **statement** balance for an account that is newer than its last
 * reconciliation, turned into the way a statement prints it (a card's balance owed is positive; the
 * books carry it negative). A feed's balance is never offered. */
export function statementBalanceHint(
  checks: readonly Pick<InboxBalanceCheck, "provider" | "ledgerAccountId" | "asOf" | "reported">[],
  account: { readonly id: string; readonly normalSide: "debit" | "credit" },
  lastReconciledDate: string | null,
): { readonly date: string; readonly balance: string } | undefined {
  const newest = checks
    .filter(
      (check) =>
        STATEMENT_BALANCE_PROVIDERS.has(check.provider) &&
        check.ledgerAccountId === account.id &&
        (lastReconciledDate === null || check.asOf > lastReconciledDate),
    )
    .sort((left, right) => right.asOf.localeCompare(left.asOf))[0];
  return newest
    ? {
        date: newest.asOf,
        balance: account.normalSide === "credit" ? negateMoney(newest.reported) : newest.reported,
      }
    : undefined;
}

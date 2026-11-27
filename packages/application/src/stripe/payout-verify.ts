import type { BalanceTransaction, Payout } from "./types.ts";

/** The payout reconciliation to the cent: the balance transactions Stripe says were paid out in an
 * automatic payout must add up (their `net`, which is what moved the balance) to exactly the amount
 * that arrives in the bank. The payout's own transaction, the debit that records the payout itself,
 * is not one of them. */

export interface CategoryTotal {
  readonly count: number;
  readonly gross: bigint;
  readonly fee: bigint;
  readonly net: bigint;
}

export interface PayoutReconciliation {
  readonly ok: boolean;
  /** What reaches the bank, from the payout object. */
  readonly payoutAmount: bigint;
  /** The sum of `net` over the transactions paid out. */
  readonly memberNet: bigint;
  /** `payoutAmount` minus `memberNet`; zero when the payout reconciles. */
  readonly difference: bigint;
  readonly memberCount: number;
  /** Why it does not reconcile, in words a person can act on; null when it does. */
  readonly problem: string | null;
  /** Gross, fee and net by reporting category: the payout reconciliation report. */
  readonly categories: ReadonlyMap<string, CategoryTotal>;
}

/** Is this transaction the payout's own debit rather than something paid out by it? */
export function isPayoutItself(payout: Payout, transaction: BalanceTransaction): boolean {
  return (
    transaction.id === payout.balanceTransaction ||
    (transaction.type === "payout" && transaction.source?.id === payout.id)
  );
}

export function reconcilePayout(
  payout: Payout,
  transactions: readonly BalanceTransaction[],
): PayoutReconciliation {
  const members = transactions.filter((t) => !isPayoutItself(payout, t));
  const categories = new Map<string, CategoryTotal>();
  let net = 0n;
  let otherCurrency = 0;
  for (const t of members) {
    if (t.currency !== payout.currency) {
      otherCurrency++;
      continue;
    }
    net += t.net;
    const previous = categories.get(t.reportingCategory);
    categories.set(t.reportingCategory, {
      count: (previous?.count ?? 0) + 1,
      gross: (previous?.gross ?? 0n) + t.amount,
      fee: (previous?.fee ?? 0n) + t.fee,
      net: (previous?.net ?? 0n) + t.net,
    });
  }
  const difference = payout.amount - net;
  let problem: string | null = null;
  if (otherCurrency > 0)
    problem = `${otherCurrency} paid-out transaction${otherCurrency === 1 ? " is" : "s are"} in a different currency from the payout.`;
  else if (difference !== 0n)
    problem = "The transactions Stripe says were paid out do not add up to the payout amount.";
  return {
    ok: problem === null,
    payoutAmount: payout.amount,
    memberNet: net,
    difference,
    memberCount: members.length,
    problem,
    categories,
  };
}

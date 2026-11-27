import type { BookState } from "@rastrata/kernel";
import { formatMoney } from "../money.ts";

/** Signed balance of every account (debits positive), as exact decimal strings, counting only the
 * journals booked by `throughRevision` and leaving out an original that a later supersession (also
 * booked by then) replaced. This is the trial balance at a book revision, with no dates and no
 * report compiler involved, so the live book and a restored copy can be compared account by account
 * at the same point of the ledger. Exact cents in a bigint throughout. */
export function balancesThrough(
  state: BookState,
  throughRevision: bigint,
): Readonly<Record<string, string>> {
  const selected = state.journals.filter((booked) => booked.bookRevision <= throughRevision);
  const selectedIds = new Set<string>(selected.map((booked) => booked.journal.id));
  const superseded = new Set(
    state.corrections
      .filter(
        (link) => link.kind === "supersession" && selectedIds.has(String(link.correctionJournalId)),
      )
      .map((link) => String(link.originalJournalId)),
  );
  const cents = new Map<string, bigint>();
  for (const account of state.admissionSnapshot.accounts) cents.set(account.id, 0n);
  for (const booked of selected) {
    if (superseded.has(String(booked.journal.id))) continue;
    for (const posting of booked.journal.postings) {
      if (posting.bookValue.amount.scale !== 2n)
        throw new TypeError("A posting is not in whole cents, so balances cannot be compared");
      cents.set(
        posting.accountId,
        (cents.get(posting.accountId) ?? 0n) + posting.bookValue.amount.coefficient,
      );
    }
  }
  return Object.fromEntries(
    [...cents.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, value]) => [id, formatMoney(value)]),
  );
}

/** Account balances that differ between two sets, by account. A missing account counts as 0.00. */
export function compareBalances(
  live: Readonly<Record<string, string>>,
  restored: Readonly<Record<string, string>>,
): { accounts: number; mismatches: { accountId: string; live: string; restored: string }[] } {
  const ids = [...new Set([...Object.keys(live), ...Object.keys(restored)])].sort();
  const mismatches = ids.flatMap((accountId) => {
    const a = live[accountId] ?? "0.00";
    const b = restored[accountId] ?? "0.00";
    return a === b ? [] : [{ accountId, live: a, restored: b }];
  });
  return { accounts: ids.length, mismatches };
}

/** Read-only views of the verified ledger state that the pipeline needs: an account's balance on a
 * date and the chart as proposers see it. None of this writes; the state comes from
 * `service.readAggregate()`. The posted entries a bank line might already be are `match-index.ts`. */
import type { DurableBookAggregate } from "@rastrata/kernel";

export type BookState = DurableBookAggregate["state"];

export interface ChartAccount {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly role: string;
  readonly openedOn: string;
  readonly closedOn: string | null;
  readonly postingAllowed: boolean;
}

export function chartOf(state: BookState): Map<string, ChartAccount> {
  return new Map(
    state.admissionSnapshot.accounts.map((account) => [
      account.id as string,
      {
        id: account.id as string,
        code: account.code,
        name: account.name,
        role: account.role,
        openedOn: account.openedOn as string,
        closedOn: (account.closedOn as string | undefined) ?? null,
        postingAllowed: account.postingAllowed,
      },
    ]),
  );
}

/** Whether a posting to the account on this date is allowed, with the reason when it is not. The
 * ledger enforces the same rule when it commits; this lets a person hear it before that. */
export function postingProblem(account: ChartAccount | undefined, date: string): string | null {
  if (!account) return "That account is not in the chart.";
  if (!account.postingAllowed)
    return `Account ${account.code} ${account.name} does not accept postings.`;
  if (date < account.openedOn)
    return `Account ${account.code} ${account.name} opens on ${account.openedOn}, after this line.`;
  if (account.closedOn !== null && date > account.closedOn)
    return `Account ${account.code} ${account.name} was closed on ${account.closedOn}, before this line.`;
  return null;
}

/** Journals a correction has superseded as of a date: the original no longer counts. A reversal
 * leaves both entries in place, netting to zero, so only supersessions are skipped. */
function supersededAsOf(state: BookState, asOf: string): Set<string> {
  const correctionDates = new Map(
    state.journals.map((booked) => [
      booked.journal.id as string,
      booked.journal.accountingDate as string,
    ]),
  );
  const result = new Set<string>();
  for (const link of state.corrections)
    if (link.kind === "supersession") {
      const date = correctionDates.get(link.correctionJournalId);
      if (date !== undefined && date <= asOf) result.add(link.originalJournalId);
    }
  return result;
}

/** The account's own balance from posted entries dated on or before `asOf`, in cents, a debit
 * balance positive. It is the sum of the account's postings, which is also how a bank's balance
 * moves: a payment in raises it, a payment out lowers it. */
export function accountBalanceCents(state: BookState, accountId: string, asOf: string): bigint {
  const skip = supersededAsOf(state, asOf);
  let total = 0n;
  for (const booked of state.journals) {
    if ((booked.journal.accountingDate as string) > asOf || skip.has(booked.journal.id)) continue;
    for (const posting of booked.journal.postings)
      if (posting.accountId === accountId) total += posting.bookValue.amount.coefficient;
  }
  return total;
}

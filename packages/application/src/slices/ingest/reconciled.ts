/** Which posted lines are on a reconciliation. The reconcile lane owns cleared state and answers it
 * (`reconcile.cleared`, the same function behind it); the Inbox only shows it, and nothing here writes it. */
import type { ApplicationService } from "../../service.ts";
import { clearedPostings } from "../reconcile/reconciliations.ts";
import type { ItemRow } from "./store.ts";

/** The reconciliation a posted line is on, and the date of the statement it was checked against. */
export interface ReconciledLine {
  readonly reconciliationId: string;
  readonly statementDate: string;
}

const journalOf = (row: ItemRow): string | null => row.journal_id ?? row.matched_journal_id;

/** The posted lines among these rows that are cleared: a completed reconciliation that has not been
 * voided has the posting the line made on its own account. A line counts by the posting on its own
 * account, so a transfer shows each side's own state (the checking line may be on a statement while the
 * savings one is not yet). A line that is not posted, or that no chart account holds (a payment
 * provider's own event), is on none. One read answers the whole page. */
export function reconciledLines(
  service: ApplicationService,
  rows: readonly ItemRow[],
): Map<string, ReconciledLine> {
  const result = new Map<string, ReconciledLine>();
  const candidates = rows.filter(
    (row) => row.status === "posted" && row.ledger_account_id !== null && journalOf(row) !== null,
  );
  if (candidates.length === 0) return result;
  const cleared = new Map<string, ReconciledLine>();
  for (const posting of clearedPostings(service, [
    ...new Set(candidates.map((row) => journalOf(row) as string)),
  ]).postings) {
    const key = `${posting.journalId}\u0000${posting.accountId}`;
    if (!cleared.has(key))
      cleared.set(key, {
        reconciliationId: posting.reconciliationId,
        statementDate: posting.statementDate,
      });
  }
  for (const row of candidates) {
    const found = cleared.get(`${journalOf(row)}\u0000${row.ledger_account_id}`);
    if (found) result.set(row.id, found);
  }
  return result;
}

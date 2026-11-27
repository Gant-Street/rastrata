import { readAccountTags } from "../../account-tags.ts";
import { statementAccountIds } from "../ingest/statement-accounts.ts";
import type { AdvisorContext, PlanWarning } from "../types.ts";
import { bookIndex, isReconcilable, isTaggedBankOrCard } from "./book.ts";
import { reconcileState } from "./state.ts";

const MOST_SHOWN = 6;
const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);
const byCode = (left: { code: string }, right: { code: string }) =>
  left.code.localeCompare(right.code, "en", { numeric: true });

/** What a reconciliation has to say about a plan that is being prepared. Two things, both
 * advisory (they never block): reversing or correcting an entry whose lines are already on a
 * completed reconciliation, and closing a period while a bank or card account still has lines
 * that are not on a reconciliation. */
export function reconcileAdvisor(context: AdvisorContext): PlanWarning[] {
  const { command } = context;
  if (command.type === "correctJournal")
    return clearedCorrection(context, command.originalJournalId);
  if (command.type === "closePeriod") return unreconciledAtClose(context, command.periodId);
  return [];
}

function clearedCorrection({ service }: AdvisorContext, journalId: string): PlanWarning[] {
  const rs = reconcileState(service);
  const perReconciliation = new Map<string, number>();
  for (const row of rs.store.activeForJournals([journalId]))
    perReconciliation.set(row.session_id, (perReconciliation.get(row.session_id) ?? 0) + 1);
  const warnings: PlanWarning[] = [];
  for (const [sessionId, count] of perReconciliation) {
    const session = rs.store.session(sessionId);
    if (!session) continue;
    warnings.push({
      code: "cleared_posting_corrected",
      message: `${count} ${plural(count, "line of this entry is", "lines of this entry are")} already reconciled: ${session.account_code} ${session.account_name}, statement ending ${session.statement_date}. The statement included ${plural(count, "it", "them")}, so reversing the entry makes your books differ from the bank unless the bank reversed it too. If the entry was wrong in the books, reverse it; the reversal will show as a new line to reconcile on the next statement.`,
    });
  }
  return warnings.slice(0, MOST_SHOWN);
}

function unreconciledAtClose({ service, state }: AdvisorContext, periodId: string): PlanWarning[] {
  const period = state.periods.find((item) => item.id === periodId);
  if (!period) return [];
  const rs = reconcileState(service);
  const index = bookIndex(state);
  const tags = readAccountTags(service.store);
  const tracked = rs.store.trackedAccountIds();
  const imported = statementAccountIds(service);
  const through = period.endsOn;
  const found: { id: string; code: string; name: string; count: number }[] = [];
  for (const account of index.accounts.values()) {
    if (!isReconcilable(account)) continue;
    // A bank account is one that has been reconciled before, is tagged as cash (Stripe's clearing
    // accounts, which have no statement, are not), or has statements imported for it (a card, say,
    // which is not cash). An account nobody has reconciled, tagged or imported for is not guessed at.
    if (
      !tracked.has(account.id) &&
      !imported.has(account.id) &&
      !isTaggedBankOrCard(tags.tagsFor(account.id, through))
    )
      continue;
    const cleared = rs.store.activeIds(account.id);
    let count = 0;
    for (const posting of index.postings.get(account.id) ?? []) {
      if (posting.date > through) break;
      if (!cleared.has(posting.postingId)) count += 1;
    }
    if (count > 0) found.push({ id: account.id, code: account.code, name: account.name, count });
  }
  found.sort(byCode);
  const warnings: PlanWarning[] = found.slice(0, MOST_SHOWN).map((account) => {
    const last = rs.store.lastActive(account.id)?.statement_date ?? null;
    return {
      code: "period_unreconciled",
      message: `${account.code} ${account.name}: ${account.count} ${plural(account.count, "posting", "postings")} dated through ${through} ${plural(account.count, "is", "are")} not on a reconciliation (${last ? `last reconciled to ${last}` : "never reconciled"}). Closing does not check bank balances. Outstanding items are normal; unexpected ones are worth finding before the books are closed.`,
    };
  });
  if (found.length > MOST_SHOWN)
    warnings.push({
      code: "period_unreconciled_more",
      message: `${found.length - MOST_SHOWN} more ${plural(found.length - MOST_SHOWN, "account has", "accounts have")} postings not on a reconciliation. See reconcile status.`,
    });
  return warnings;
}

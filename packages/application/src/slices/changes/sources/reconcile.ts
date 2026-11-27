/** Reconciliations: a statement reconciled to exactly 0.00, and a record voided. Both are read through
 * `reconcile.list`, which keeps the time of each. A reconciliation is a fact the owner or an agent
 * made on a statement, and Rastrata keeps no name beside it, so these changes say "not recorded"
 * until the part that keeps reconciliations records who completed and voided them. */
import type { Candidate } from "../../../changes/candidate.ts";
import { UNKNOWN_ACTOR } from "../../../changes/kinds.ts";
import { groupedAmount, shortDate } from "../../../changes/ledger.ts";
import type { ReconcileList, ReconciliationSummary } from "../../../client-contracts.gen.ts";
import { ApplicationError } from "../../../errors.ts";
import { sanitizeText } from "../../../ingest/text.ts";
import { callOperation } from "../call.ts";
import { asInstant, type SourceReader } from "./types.ts";

/** Pages read at most: 25 reconciliations each, so a thousand. More than that, in a book, is a sign of
 * something else; the list says it read in part. */
const MAX_PAGES = 40;

function candidate(
  at: string,
  id: string,
  kind: "reconciliation.completed" | "reconciliation.voided",
  summary: string,
  how: string,
  subject: string,
): Candidate {
  const record = {
    id,
    at,
    revision: null,
    kind,
    summary: sanitizeText(summary, 400),
    subject: { kind: "reconciliation" as const, id: subject },
    by: { kind: UNKNOWN_ACTOR.kind, label: UNKNOWN_ACTOR.label },
    how,
  };
  return { at, revision: null, kind, actor: UNKNOWN_ACTOR, order: id, build: () => record };
}

function describe(item: ReconciliationSummary): string {
  const account = `${sanitizeText(item.account.code, 20)} ${sanitizeText(item.account.name, 120)}`;
  return `${account} to its statement of ${shortDate(item.statementDate)}, balance ${groupedAmount(item.statementBalance)}`;
}

export const reconciliationSource: SourceReader = {
  name: "reconciliation",
  title: "Reconciliations",
  async read({ context }) {
    const found: Candidate[] = [];
    let incomplete: string | undefined;
    for (let page = 1; ; page += 1) {
      if (page > MAX_PAGES) {
        incomplete = "There are more reconciliations than one list reads; the oldest are missing.";
        break;
      }
      let list: ReconcileList;
      try {
        list = await callOperation<ReconcileList>(context, "reconcile.list", { page });
      } catch (error) {
        if (page === 1 || !(error instanceof ApplicationError)) throw error;
        incomplete = "A later page of reconciliations could not be read.";
        break;
      }
      for (const item of list.items) {
        if (item.status === "draft") continue;
        const completed = asInstant(item.completedAt);
        if (completed !== null)
          found.push(
            candidate(
              completed,
              `reconciliation:${item.id}:completed`,
              "reconciliation.completed",
              `Reconciled ${describe(item)}.`,
              "",
              item.id,
            ),
          );
        const voided = item.void === null ? null : asInstant(item.void.voidedAt);
        if (item.void !== null && voided !== null)
          found.push(
            candidate(
              voided,
              `reconciliation:${item.id}:voided`,
              "reconciliation.voided",
              `Voided the reconciliation of ${describe(item)} (reason: ${sanitizeText(item.void.reason, 120)}).`,
              "",
              item.id,
            ),
          );
      }
      if (list.items.length === 0 || page * list.pageSize >= list.count) break;
    }
    return incomplete === undefined ? { candidates: found } : { candidates: found, incomplete };
  },
};

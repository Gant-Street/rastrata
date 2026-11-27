/** Lines booked by another line.
 *
 * A provider can settle many movements with one: Stripe pays out a batch of charges, fees and
 * refunds as a single payout, and the books carry one summary entry for the payout. The balance
 * transactions are still imported (they are the evidence, and a person can see exactly what a payout
 * was made of), but they are not decisions to make. Each carries `coveredBy`, the provider id of the
 * payout event, and follows it:
 *
 * - while the payout waits for a decision, so do they, out of the "to review" count;
 * - when the payout is drafted they are drafted with it, under the same draft, and posting the
 *   payout posts the one entry and marks them posted with it;
 * - when the payout is excluded they are excluded with it, and restoring the payout restores them;
 * - they cannot be categorized, accepted, excluded, restored or posted on their own.
 *
 * `syncCovered` is the one place that makes a covered line agree with its payout. Call it after
 * anything that changes the payout's status or that adds lines that name it. */
import type { ApplicationStore } from "../../storage.ts";
import { ITEM_COLUMNS, ITEM_FROM, type ItemRow, recordEvent } from "./store.ts";

interface Child {
  readonly id: string;
  readonly status: string;
  readonly exclusion_code: string | null;
}

const decision = (now: string, cover: ItemRow) =>
  JSON.stringify({ kind: "covered", by: "covered", at: now, coveredBy: cover.id });

/** The payout item for a provider id, or null while it has not been imported. */
export function coverOf(
  store: ApplicationStore,
  provider: string,
  accountKey: string,
  providerId: string,
): ItemRow | null {
  return store
    .query(
      `SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE i.provider = ? AND i.account_key = ? AND i.provider_id = ?`,
    )
    .get(provider, accountKey, providerId) as ItemRow | null;
}

/** Make the lines a cover books agree with the cover. Returns how many lines changed. */
export function syncCovered(store: ApplicationStore, now: string, cover: ItemRow): number {
  if (cover.provider_id === null) return 0;
  const children = store
    .query(
      "SELECT id, status, exclusion_code FROM app_ingest_items WHERE provider=? AND account_key=? AND covered_by=?",
    )
    .all(cover.provider, cover.account_key, cover.provider_id) as Child[];
  let changed = 0;
  const touch = (child: Child, work: () => void, detail: Record<string, string | undefined>) => {
    work();
    recordEvent(store, child.id, now, "covered", "covered", detail);
    changed += 1;
  };
  for (const child of children) {
    if (cover.status === "new" || cover.status === "proposed") {
      // The payout is back in review (restored, or not yet decided): so are its lines.
      if (
        child.status === "drafted" ||
        (child.status === "excluded" && child.exclusion_code === "manual")
      )
        touch(
          child,
          () =>
            store
              .query(
                `UPDATE app_ingest_items SET status='new', exclusion_code=NULL, exclusion_reason=NULL,
                   exclusion_at=NULL, decision=NULL, draft_id=NULL, draft_version=NULL, pair_item_id=NULL,
                   post_error=NULL, post_error_code=NULL, proposed_rev=NULL WHERE id=?`,
              )
              .run(child.id),
          { reason: `Back in review with ${cover.provider_id}.` },
        );
    } else if (cover.status === "drafted") {
      if (child.status === "new" || child.status === "proposed")
        touch(
          child,
          () =>
            store
              .query(
                `UPDATE app_ingest_items SET status='drafted', draft_id=?, draft_version=?, decision=?,
                   post_error=NULL, post_error_code=NULL WHERE id=?`,
              )
              .run(cover.draft_id, cover.draft_version, decision(now, cover), child.id),
          { draftId: cover.draft_id ?? undefined, reason: `Drafted with ${cover.provider_id}.` },
        );
    } else if (cover.status === "posted") {
      if (child.status === "new" || child.status === "proposed" || child.status === "drafted") {
        const journalId = cover.journal_id ?? cover.matched_journal_id;
        touch(
          child,
          () =>
            store
              .query(
                `UPDATE app_ingest_items SET status='posted', journal_id=?, post_operation_id=?, decision=?,
                   post_error=NULL, post_error_code=NULL WHERE id=?`,
              )
              .run(journalId, cover.post_operation_id, decision(now, cover), child.id),
          { journalId: journalId ?? undefined, reason: `Posted with ${cover.provider_id}.` },
        );
      }
    } else if (cover.status === "excluded") {
      if (child.status === "new" || child.status === "proposed" || child.status === "drafted")
        touch(
          child,
          () =>
            store
              .query(
                `UPDATE app_ingest_items SET status='excluded', exclusion_code=?, exclusion_reason=?,
                   exclusion_at=?, decision=?, draft_id=NULL, draft_version=NULL, post_error=NULL, post_error_code=NULL WHERE id=?`,
              )
              .run(
                cover.exclusion_code === "manual" || cover.exclusion_code === null
                  ? "manual"
                  : cover.exclusion_code,
                cover.exclusion_code === "manual" || cover.exclusion_code === null
                  ? `Excluded with ${cover.provider_id}.`
                  : (cover.exclusion_reason ?? `Excluded with ${cover.provider_id}.`),
                now,
                decision(now, cover),
                child.id,
              ),
          { reason: `Excluded with ${cover.provider_id}.` },
        );
    }
  }
  return changed;
}

/** Sync every cover named in `providerIds` (events of one provider account) that exists. */
export function syncCovers(
  store: ApplicationStore,
  now: string,
  provider: string,
  accountKey: string,
  providerIds: Iterable<string>,
): void {
  for (const providerId of new Set(providerIds)) {
    const cover = coverOf(store, provider, accountKey, providerId);
    if (cover) syncCovered(store, now, cover);
  }
}

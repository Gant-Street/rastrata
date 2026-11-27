/** What other lanes may read about the Inbox, without touching its tables: lines to scan (rules
 * testing a rule), decided lines to learn from (the classifier), the state of lines by provider id
 * (Stripe explaining the gap between its balance and the books), counts, and the cursor of the
 * newest batch of a source. All read-only. */
import type { DecidedItem, IngestItem, ProposedLeg } from "../../ingest-types.ts";
import type { ApplicationService } from "../../service.ts";
import {
  ITEM_COLUMNS,
  ITEM_FROM,
  type ItemRow,
  type ItemStatus,
  ingestRuntime,
  toIngestItem,
} from "./store.ts";
import { inboxCounts } from "./view.ts";

export { invalidateProposals } from "./proposing.ts";

export interface ListItemsQuery {
  readonly statuses?: readonly ItemStatus[];
  readonly provider?: string;
  readonly accountKey?: string;
  readonly ledgerAccountId?: string;
  /** Lines dated on or after this date, YYYY-MM-DD. */
  readonly since?: string;
  /** At most 1,000 per call. */
  readonly limit: number;
  /** The `next` of the previous call. */
  readonly after?: string;
}

/** Lines in the order they arrived, a page at a time, so a scan of thousands never loads them all. */
export function listItems(
  service: ApplicationService,
  query: ListItemsQuery,
): { readonly items: IngestItem[]; readonly next: string | null } {
  const store = ingestRuntime(service).store;
  const clauses = ["i.seq > ?"];
  const bindings: (string | number)[] = [Number(query.after ?? 0)];
  if (!Number.isSafeInteger(bindings[0]))
    throw new TypeError("after is not a cursor from listItems");
  if (query.statuses && query.statuses.length > 0) {
    clauses.push(`i.status IN (${query.statuses.map(() => "?").join(", ")})`);
    bindings.push(...query.statuses);
  }
  for (const [column, value] of [
    ["i.provider", query.provider],
    ["i.account_key", query.accountKey],
    ["s.ledger_account_id", query.ledgerAccountId],
  ] as const)
    if (value !== undefined) {
      clauses.push(`${column} = ?`);
      bindings.push(value);
    }
  if (query.since !== undefined) {
    clauses.push("i.posted_on >= ?");
    bindings.push(query.since);
  }
  const limit = Math.min(1000, Math.max(1, Math.trunc(query.limit)));
  const rows = store
    .query(
      `SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE ${clauses.join(" AND ")} ORDER BY i.seq LIMIT ?`,
    )
    .all(...bindings, limit + 1) as ItemRow[];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(toIngestItem),
    next: rows.length > limit && last ? String(last.seq) : null,
  };
}

/** A decided line as the classifier learns from it, or null when the row says nothing usable: no legs (a line
 * matched to an entry already in the books), no time. */
function decidedOf(row: ItemRow, since?: string): DecidedItem | null {
  const decision = JSON.parse(row.decision ?? "{}") as {
    by?: string;
    at?: string;
    legs?: ProposedLeg[];
  };
  if (!decision.legs || decision.legs.length === 0 || !decision.at) return null;
  const decidedOn = decision.at.slice(0, 10);
  if (since !== undefined && decidedOn < since) return null;
  return {
    item: toIngestItem(row),
    legs: decision.legs,
    decidedOn,
    decidedBy: decision.by ?? "manual",
    ...(row.journal_id ? { journalId: row.journal_id } : {}),
  };
}

/** Lines a person or a proposer has decided (drafted or posted) with the entry decided, bank side
 * included, for training and for counting how often a rule was accepted. Lines matched to an
 * existing entry carry no legs here and are not listed. */
export function decidedItems(
  service: ApplicationService,
  query: { readonly since?: string } = {},
): DecidedItem[] {
  const store = ingestRuntime(service).store;
  const rows = store
    .query(
      `SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM}
       WHERE i.status IN ('drafted', 'posted') AND i.decision IS NOT NULL ORDER BY i.seq`,
    )
    .all() as ItemRow[];
  const decided: DecidedItem[] = [];
  for (const row of rows) {
    const item = decidedOf(row, query.since);
    if (item) decided.push(item);
  }
  return decided;
}

/** The lines decided and not yet posted, which are the ones the classifier learns from as decisions: a
 * line that is posted is learned from through its entry. */
export function draftedDecisions(service: ApplicationService): DecidedItem[] {
  const store = ingestRuntime(service).store;
  const rows = store
    .query(
      `SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM}
       WHERE i.status = 'drafted' AND i.decision IS NOT NULL AND i.journal_id IS NULL ORDER BY i.seq`,
    )
    .all() as ItemRow[];
  const decided: DecidedItem[] = [];
  for (const row of rows) {
    const item = decidedOf(row);
    if (item) decided.push(item);
  }
  return decided;
}

/** One line, if it is among those `decidedItems` lists. */
export function decidedItem(service: ApplicationService, itemId: string): DecidedItem | null {
  const row = ingestRuntime(service)
    .store.query(
      `SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM}
       WHERE i.id = ? AND i.status IN ('drafted', 'posted') AND i.decision IS NOT NULL`,
    )
    .get(itemId) as ItemRow | null;
  return row ? decidedOf(row) : null;
}

/** The decided line posted as this entry, as `decidedItems` lists it: when two lines share an entry (the two
 * sides of a transfer) the one that came last. */
export function decidedItemFor(service: ApplicationService, journalId: string): DecidedItem | null {
  const rows = ingestRuntime(service)
    .store.query(
      `SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM}
       WHERE i.journal_id = ? AND i.status IN ('drafted', 'posted') AND i.decision IS NOT NULL
       ORDER BY i.seq DESC`,
    )
    .all(journalId) as ItemRow[];
  for (const row of rows) {
    const item = decidedOf(row);
    if (item) return item;
  }
  return null;
}

/** The entry a line is posted as, or null when it is not posted as one. */
export function itemJournal(service: ApplicationService, itemId: string): string | null {
  const row = ingestRuntime(service)
    .store.query("SELECT journal_id FROM app_ingest_items WHERE id = ?")
    .get(itemId) as { journal_id: string | null } | null;
  return row?.journal_id ?? null;
}

/** What changed among the lines since a point in the log that records it (`app_ingest_changes`): the lines
 * decided, posted or taken back, and the entries lines were linked to or let go of. `latest` is the point
 * to continue from. */
export function changesSince(
  service: ApplicationService,
  after: number,
): { readonly itemIds: string[]; readonly journalIds: string[]; readonly latest: number } {
  const store = ingestRuntime(service).store;
  const latest =
    (store.query("SELECT MAX(seq) AS seq FROM app_ingest_changes").get() as { seq: number | null })
      .seq ?? 0;
  if (latest <= after) return { itemIds: [], journalIds: [], latest };
  const rows = store
    .query("SELECT DISTINCT item_id, journal_id FROM app_ingest_changes WHERE seq > ? AND seq <= ?")
    .all(after, latest) as { item_id: string; journal_id: string | null }[];
  return {
    itemIds: [...new Set(rows.map((row) => row.item_id))],
    journalIds: [...new Set(rows.flatMap((row) => (row.journal_id ? [row.journal_id] : [])))],
    latest,
  };
}

/** The status of lines by the provider's own id, for explaining what has and has not been booked. */
export function itemStates(
  service: ApplicationService,
  provider: string,
  providerIds: readonly string[],
): Map<string, ItemStatus> {
  const store = ingestRuntime(service).store;
  const states = new Map<string, ItemStatus>();
  for (let from = 0; from < providerIds.length; from += 500) {
    const chunk = providerIds.slice(from, from + 500);
    const rows = store
      .query(
        `SELECT provider_id, status FROM app_ingest_items WHERE provider=? AND provider_id IN (${chunk.map(() => "?").join(", ")})`,
      )
      .all(provider, ...chunk) as { provider_id: string; status: ItemStatus }[];
    for (const row of rows) states.set(row.provider_id, row.status);
  }
  return states;
}

export function countsByStatus(
  service: ApplicationService,
  filter: { readonly provider?: string } = {},
): ReturnType<typeof inboxCounts> {
  const store = ingestRuntime(service).store;
  return filter.provider === undefined
    ? inboxCounts(store)
    : inboxCounts(store, { provider: filter.provider });
}

/** The cursor stored with the newest batch of a source that carried one, or null. */
export function latestCursor(
  service: ApplicationService,
  provider: string,
  sourceKey: string,
): string | null {
  const row = ingestRuntime(service)
    .store.query(
      "SELECT cursor FROM app_ingest_batches WHERE provider=? AND source_key=? AND cursor IS NOT NULL ORDER BY seq DESC LIMIT 1",
    )
    .get(provider, sourceKey) as { cursor: string } | null;
  return row?.cursor ?? null;
}

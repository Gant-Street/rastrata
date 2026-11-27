/** Lines put straight into the Inbox's table, with every column it wants and the ones a test counts or sorts by
 * chosen at random, for tests that hold what the database keeps beside the lines to the lines themselves. Test
 * support. */
import type { InboxFilter, InboxListInput } from "../../src/client-contracts.gen.ts";
import { buildWhere, orderBy } from "../../src/slices/ingest/filters.ts";
import {
  ITEM_COLUMNS,
  ITEM_FROM,
  type ItemRow,
  type ingestRuntime,
} from "../../src/slices/ingest/store.ts";

export type Store = ReturnType<typeof ingestRuntime>["store"];

/** What the Inbox's list answered before it kept counts and an index of what waits: every line looked at. The list
 * must answer exactly this. */
export function looked(
  store: Store,
  filter: InboxFilter,
  sort: InboxListInput["sort"],
  page: number,
  pageSize: number,
): { total: number; ids: string[] } {
  const where = buildWhere(filter);
  const order = orderBy(sort);
  const total = (
    store
      .query(`SELECT COUNT(*) AS n FROM ${ITEM_FROM} WHERE ${where.sql}`)
      .get(...where.bindings) as { n: number }
  ).n;
  const rows = store
    .query(
      `SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} ${order.join}
       WHERE ${where.sql} ORDER BY ${order.sql} LIMIT ? OFFSET ?`,
    )
    .all(...where.bindings, pageSize, (page - 1) * pageSize) as ItemRow[];
  return { total, ids: rows.map((row) => row.id) };
}

export const STATUSES = ["new", "proposed", "drafted", "posted", "excluded"] as const;
export const CODES = [null, "manual", "before_cutover", "catch_up"] as const;
export const KINDS = ["bankLine", "bankLine", "event"] as const;
export const DAYS = [
  "2026-02-27",
  "2026-03-01",
  "2026-03-02",
  "2026-03-09",
  "2026-03-31",
  "2026-04-15",
  "2026-05-31",
] as const;
export const SOURCES = [
  ["csv", "csv:1000"],
  ["csv", "csv:1100"],
  ["stripe", "stripe:acct_1:usd"],
] as const;

let unique = 0;
/** A line, with every column the table wants and the ones the tally counts by chosen. */
export function insertLine(store: Store, random: () => number): string {
  const below = (count: number) => Math.floor(random() * count);
  const [provider, accountKey] = SOURCES[below(SOURCES.length)] as (typeof SOURCES)[number];
  const status = STATUSES[below(STATUSES.length)] as string;
  const id = `raw-${unique++}`;
  const cents = (below(1000) - 500) * 7;
  store
    .query(
      `INSERT INTO app_ingest_items (id, batch_id, provider, account_key, provider_id, raw_index, kind, posted_on,
         cents, amount, currency, content_key, text_key, search, line, status, exclusion_code, source_event_id,
         ingested_at, covered_by)
       VALUES (?, 'batch', ?, ?, ?, 0, ?, ?, ?, ?, 'USD', ?, ?, ?, '{}', ?, ?, ?, '2026-03-01T00:00:00Z', ?)`,
    )
    .run(
      id,
      provider,
      accountKey,
      id,
      KINDS[below(KINDS.length)] as string,
      DAYS[below(DAYS.length)] as string,
      cents,
      (Math.abs(cents) / 100).toFixed(2),
      id,
      id,
      `vendor${below(5)} ${id}`,
      status,
      status === "excluded" ? (CODES[below(CODES.length)] as string | null) : null,
      `source-${id}`,
      random() < 0.3 ? "payout-1" : null,
    );
  return id;
}

/** A change to one line of the kind that moves it between the tally's rows: its state, whether it is covered, its
 * source, its day, its kind, something the tally does not count by, or nothing it counts by. */
export function changeLine(store: Store, random: () => number, id: string, step: number): void {
  const below = (count: number) => Math.floor(random() * count);
  const status = STATUSES[below(STATUSES.length)] as string;
  const parts = ["status=?"];
  const values: (string | null)[] = [status];
  if (random() < 0.5) {
    parts.push("exclusion_code=?");
    values.push(CODES[below(CODES.length)] as string | null);
  }
  if (random() < 0.4) {
    parts.push("covered_by=?");
    values.push(random() < 0.5 ? "payout-2" : null);
  }
  if (random() < 0.15) {
    const [provider, accountKey] = SOURCES[below(SOURCES.length)] as (typeof SOURCES)[number];
    parts.push("provider=?", "account_key=?");
    values.push(provider, accountKey);
  }
  if (random() < 0.2) {
    parts.push("posted_on=?");
    values.push(DAYS[below(DAYS.length)] as string);
  }
  if (random() < 0.1) {
    parts.push("kind=?");
    values.push(KINDS[below(KINDS.length)] as string);
  }
  // An update that changes nothing the tally counts by, and one that sets what it already is.
  if (random() < 0.2) {
    parts.push("proposed_rev=?");
    values.push(`rev-${step}`);
  }
  store.query(`UPDATE app_ingest_items SET ${parts.join(", ")} WHERE id=?`).run(...values, id);
}

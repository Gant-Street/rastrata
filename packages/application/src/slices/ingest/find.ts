/** How the Inbox's list finds what it is asked for without looking at every line. Two questions it asks again
 * and again are answered from what the database keeps beside the lines: how many lines match a filter that
 * says only what the day tally counts by (a state, a source, a day or a range of days, whether a payout covers
 * the line), which is a sum over the days and not a pass over the lines; and the first page of the lines that
 * wait, in the order of their days, which is a step into the index of those lines and not a sort of every line
 * that matches. Any other filter is answered by looking at the lines, as before. Nothing here changes
 * anything, and `test/ingest-list.test.ts` holds each answer to the answer that looks at the lines. */
import type { InboxFilter, InboxListInput } from "../../client-contracts.gen.ts";
import type { ApplicationBinding, ApplicationStore } from "../../storage.ts";
import { buildWhere, orderBy } from "./filters.ts";
import { ITEM_COLUMNS, ITEM_FROM, type ItemRow } from "./store.ts";

const STATUSES: ReadonlySet<string> = new Set(["new", "proposed", "drafted", "posted", "excluded"]);
/** The states the index of waiting lines holds, with whether a payout covers the line: the terms of that
 * index, which a query must carry as they are for the database to see that the index holds what it asks for. */
const WAITING: ReadonlySet<string> = new Set(["new", "proposed", "drafted"]);
const WAITING_TERMS = "i.status IN ('new', 'proposed', 'drafted') AND i.covered_by IS NULL";

/** The number of lines that match the filter, from the day tally, or null when the filter says something the
 * tally does not count by (a search, an amount, a direction, a kind, who covers the line, what is proposed). */
export function countFromDays(store: ApplicationStore, filter: InboxFilter): number | null {
  if (
    (filter.text !== undefined && filter.text.trim() !== "") ||
    filter.minAmount !== undefined ||
    filter.maxAmount !== undefined ||
    filter.direction !== undefined ||
    filter.exclusion !== undefined ||
    filter.kind !== undefined ||
    filter.coveredBy !== undefined ||
    filter.hasProposal !== undefined ||
    filter.proposer !== undefined ||
    filter.flag !== undefined
  )
    return null;
  const clauses: string[] = [];
  const bindings: ApplicationBinding[] = [];
  if (filter.status && filter.status.length > 0) {
    const statuses = filter.status.filter((status) => STATUSES.has(status));
    if (statuses.length === 0) return 0;
    clauses.push(`d.status IN (${statuses.map(() => "?").join(", ")})`);
    bindings.push(...statuses);
  }
  if (filter.provider !== undefined) {
    clauses.push("d.provider = ?");
    bindings.push(filter.provider);
  }
  if (filter.accountKey !== undefined) {
    clauses.push("d.account_key = ?");
    bindings.push(filter.accountKey);
  }
  if (filter.from !== undefined) {
    clauses.push("d.day >= ?");
    bindings.push(filter.from);
  }
  if (filter.to !== undefined) {
    clauses.push("d.day <= ?");
    bindings.push(filter.to);
  }
  if (filter.covered === true) clauses.push("d.covered = 1");
  if (filter.covered === false) clauses.push("d.covered = 0");
  let join = "";
  if (filter.ledgerAccountId !== undefined) {
    join = "JOIN app_ingest_sources s ON s.provider = d.provider AND s.account_key = d.account_key";
    clauses.push("s.ledger_account_id = ?");
    bindings.push(filter.ledgerAccountId);
  }
  const row = store
    .query(
      `SELECT COALESCE(SUM(d.n), 0) AS n FROM app_ingest_tally_days d ${join}
       WHERE ${clauses.length > 0 ? clauses.join(" AND ") : "1"}`,
    )
    .get(...bindings) as { n: number };
  return row.n;
}

/** What to read the lines through for a list of the lines that wait, sorted by day, or null for any other list:
 * the index of those lines, with the terms the index holds added to the query so that the database can use it. A
 * list of other states, of lines a payout covers or of lines in no particular state is read as it always was. */
export function waitingScan(
  filter: InboxFilter,
  sort: InboxListInput["sort"],
): { readonly from: string; readonly terms: string } | null {
  if (sort !== undefined && sort !== "date_asc" && sort !== "date_desc") return null;
  if (filter.covered !== false || !filter.status || filter.status.length === 0) return null;
  if (!filter.status.every((status) => WAITING.has(status))) return null;
  return {
    from: `app_ingest_items i INDEXED BY app_ingest_items_waiting
      LEFT JOIN app_ingest_sources s ON s.provider = i.provider AND s.account_key = i.account_key`,
    terms: WAITING_TERMS,
  };
}

/** The lines of one page of the list, in order, and how many lines match in all. */
export function findLines(
  store: ApplicationStore,
  filter: InboxFilter,
  sort: InboxListInput["sort"],
  page: number,
  pageSize: number,
): { readonly total: number; readonly rows: ItemRow[] } {
  const where = buildWhere(filter);
  const order = orderBy(sort);
  const counted = countFromDays(store, filter);
  const total =
    counted !== null
      ? counted
      : (
          store
            .query(`SELECT COUNT(*) AS n FROM ${ITEM_FROM} WHERE ${where.sql}`)
            .get(...where.bindings) as { n: number }
        ).n;
  const scan = waitingScan(filter, sort);
  const rows = store
    .query(
      `SELECT ${ITEM_COLUMNS} FROM ${scan?.from ?? ITEM_FROM} ${order.join}
       WHERE ${where.sql}${scan ? ` AND ${scan.terms}` : ""} ORDER BY ${order.sql} LIMIT ? OFFSET ?`,
    )
    .all(...where.bindings, pageSize, (page - 1) * pageSize) as ItemRow[];
  return { total, rows };
}

/** Which items an action applies to, and how an action reports what it did.
 *
 * An action takes either an explicit list of item ids or a filter ("everything matching this"). A
 * filter carries `expectedCount`, the number of items the person saw, and the action is refused if
 * the list has changed since, so "select all 1,240" never quietly acts on 1,300. Every action works
 * through a bounded number of items per call (`limit`) and reports how many remain, so a first
 * import of thousands of lines is a handful of calls with visible progress. */
import { ApplicationError } from "../../errors.ts";
import type {
  InboxActionReport,
  InboxActionResult,
  InboxFilter,
} from "../../client-contracts.gen.ts";
import type { ApplicationBinding, ApplicationStore } from "../../storage.ts";
import { buildWhere } from "./filters.ts";
import { ITEM_COLUMNS, ITEM_FROM, type ItemRow, type ItemStatus } from "./store.ts";

export interface SelectionInput {
  readonly itemIds?: readonly string[];
  readonly filter?: InboxFilter;
  readonly expectedCount?: number;
  readonly limit?: number;
}

/** Which items an action can work on: by status, and by anything else it needs in SQL. */
export interface Eligibility {
  readonly statuses: readonly ItemStatus[];
  readonly sql?: string;
  readonly bindings?: readonly ApplicationBinding[];
  /** SQL (over alias `i`) for the lines an earlier attempt failed on in a way that trying again will
   * not change (until the books do, which the caller sees to). A selection by filter leaves them
   * alone and says how many it left, so that they do
   * not take the call's turns again and again; a selection by ids still takes them, because a
   * person who names a line wants it tried. */
  readonly settled?: string;
  /** SQL (over alias `i`) for the lines to do after the others: those an earlier attempt failed on,
   * but that may pass now. Only the order of a selection by filter. */
  readonly later?: string;
}

export interface Resolved {
  /** Items to work on now, in the order they arrived. */
  readonly rows: ItemRow[];
  /** Results already known: ids that do not exist, items that are not in a state this action takes. */
  readonly results: InboxActionResult[];
  /** Eligible items this call did not reach. */
  readonly remaining: number;
  /** Items a selection by filter left alone because they are `settled` (see `Eligibility`): how many,
   * and the first of them, in the order they arrived. Nothing for a selection by ids. */
  readonly settled: { readonly count: number; readonly rows: ItemRow[] };
}

export const MAX_LIMIT = 1000;
/** The most settled items a report names one by one. */
export const SETTLED_LISTED = 100;

const WHY_NOT: Record<ItemStatus, string> = {
  new: "It has not been categorized yet.",
  proposed: "It has not been categorized yet.",
  drafted: "It already has a draft. Restore it to start over.",
  posted: "It is already posted. If it was wrong, correct it with a reversal.",
  excluded: "It is excluded. Restore it first.",
};

export const skipped = (
  row: Pick<ItemRow, "id" | "status">,
  code: string,
  message: string,
): InboxActionResult => ({
  itemId: row.id,
  outcome: "skipped",
  status: row.status,
  code,
  message,
});

export const failed = (
  row: Pick<ItemRow, "id" | "status"> | { readonly id: string; readonly status?: undefined },
  code: string,
  message: string,
  details: readonly { readonly path: string; readonly message: string }[] = [],
): InboxActionResult => ({
  itemId: row.id,
  outcome: "failed",
  ...(row.status ? { status: row.status } : {}),
  code,
  message,
  // What the service said about the fields behind a refusal, for a screen to act on.
  ...(details.length > 0
    ? {
        details: details.slice(0, 10).map((detail) => ({
          path: detail.path.slice(0, 200),
          message: detail.message.slice(0, 500),
        })),
      }
    : {}),
});

export function report(
  results: readonly InboxActionResult[],
  remaining: number,
): InboxActionReport {
  return {
    results,
    applied: results.filter((result) => result.outcome === "applied").length,
    skipped: results.filter((result) => result.outcome === "skipped").length,
    failed: results.filter((result) => result.outcome === "failed").length,
    remaining,
  };
}

/** What differs when the count a person gave is not the count the filter selects: the two numbers,
 * and how the lines it selects divide into those this call can act on, those a payout books (they
 * go with the payout and are never acted on alone) and those in a status the call does not take. A
 * count taken from a list that left out the lines a payout books, or that counted only what could be
 * posted, then reads as what it is, and not as a list that changed. */
export function selectionDifference(
  expected: number,
  total: number,
  covered: number,
  actionable: number,
): string {
  const other = Math.max(0, total - covered - actionable);
  const split = [
    `${actionable} can be acted on by this call`,
    ...(covered > 0
      ? [
          `${covered} ${covered === 1 ? "is" : "are"} booked with a payout (covered: ${covered === 1 ? "it goes" : "they go"} with the payout and ${covered === 1 ? "is" : "are"} never acted on alone)`,
        ]
      : []),
    ...(other > 0
      ? [`${other} ${other === 1 ? "is" : "are"} in a status this call does not act on`]
      : []),
  ];
  const last = split.pop();
  const parts = split.length > 0 ? `${split.join(", ")} and ${last}` : last;
  const hint =
    expected === actionable || expected === total - covered
      ? 'The number you gave matches the lines this call can act on, so the list may not have changed: narrow the filter (add "covered": false and a status), or give the item ids, and count again.'
      : "If the list has changed since you looked, look at it again before acting on it.";
  const breakdown = covered > 0 || other > 0 ? ` Of those ${total}, ${parts}.` : "";
  return `${total} items match now, not the ${expected} you saw.${breakdown} ${hint}`;
}

export function resolveSelection(
  store: ApplicationStore,
  selection: SelectionInput,
  eligible: Eligibility,
  defaultLimit: number,
  /** The most a caller may ask a call to reach (the default is {@link MAX_LIMIT}). */
  maxLimit: number = MAX_LIMIT,
): Resolved {
  const hasIds = selection.itemIds !== undefined;
  const hasFilter = selection.filter !== undefined;
  if (hasIds === hasFilter)
    throw new ApplicationError(
      "invalid_input",
      "Give either itemIds or a filter: not both, and not neither.",
    );
  const limit = Math.min(maxLimit, Math.max(1, selection.limit ?? defaultLimit));

  if (selection.itemIds !== undefined) {
    if (selection.expectedCount !== undefined)
      throw new ApplicationError(
        "invalid_input",
        "expectedCount goes with a filter, not a list of ids.",
      );
    const ids = [...new Set(selection.itemIds)];
    const byId = new Map<string, ItemRow>();
    for (let from = 0; from < ids.length; from += 400) {
      const chunk = ids.slice(from, from + 400);
      const rows = store
        .query(
          `SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE i.id IN (${chunk.map(() => "?").join(", ")})`,
        )
        .all(...chunk) as ItemRow[];
      for (const row of rows) byId.set(row.id, row);
    }
    const results: InboxActionResult[] = [];
    const rows: ItemRow[] = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) results.push(failed({ id }, "item_not_found", "That Inbox item does not exist."));
      else if (row.covered_by)
        results.push(
          skipped(
            row,
            "covered",
            `This line is booked together with ${row.covered_by}. Act on that line: it takes this one with it.`,
          ),
        );
      else if (!eligible.statuses.includes(row.status))
        results.push(
          skipped(row, "wrong_status", `This item is ${row.status}. ${WHY_NOT[row.status]}`),
        );
      else rows.push(row);
    }
    return {
      rows: rows.slice(0, limit),
      results,
      remaining: Math.max(0, rows.length - limit),
      settled: { count: 0, rows: [] },
    };
  }

  const where = buildWhere(selection.filter);
  const statuses = eligible.statuses.map(() => "?").join(", ");
  const narrow = `${where.sql} AND i.covered_by IS NULL AND i.status IN (${statuses})${eligible.sql ? ` AND ${eligible.sql}` : ""}`;
  const bindings = [...where.bindings, ...eligible.statuses, ...(eligible.bindings ?? [])];
  const settledCount = eligible.settled
    ? (
        store
          .query(`SELECT COUNT(*) AS n FROM ${ITEM_FROM} WHERE ${narrow} AND (${eligible.settled})`)
          .get(...bindings) as { n: number }
      ).n
    : 0;
  const settledRows =
    eligible.settled && settledCount > 0
      ? (store
          .query(
            `SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE ${narrow} AND (${eligible.settled}) ORDER BY i.seq LIMIT ?`,
          )
          .all(...bindings, SETTLED_LISTED) as ItemRow[])
      : [];
  // What a call works on leaves the settled alone; they are reported, not counted as left to do.
  const open = eligible.settled ? `${narrow} AND NOT (${eligible.settled})` : narrow;
  const eligibleCount = store
    .query(`SELECT COUNT(*) AS n FROM ${ITEM_FROM} WHERE ${open}`)
    .get(...bindings) as { n: number };
  if (selection.expectedCount !== undefined) {
    const total = store
      .query(`SELECT COUNT(*) AS n FROM ${ITEM_FROM} WHERE ${where.sql}`)
      .get(...where.bindings) as { n: number };
    if (total.n !== selection.expectedCount) {
      const covered = store
        .query(
          `SELECT COUNT(*) AS n FROM ${ITEM_FROM} WHERE ${where.sql} AND i.covered_by IS NOT NULL`,
        )
        .get(...where.bindings) as { n: number };
      throw new ApplicationError(
        "selection_changed",
        selectionDifference(selection.expectedCount, total.n, covered.n, eligibleCount.n),
        409,
      );
    }
  }
  const take = (extra: string, count: number) =>
    store
      .query(
        `SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE ${open}${extra} ORDER BY i.seq LIMIT ?`,
      )
      .all(...bindings, count) as ItemRow[];
  // Lines that have not failed come first, in the order they arrived; the ones that failed before come
  // after them, so that a line which keeps failing never keeps the others from being reached.
  const rows = eligible.later ? take(` AND NOT (${eligible.later})`, limit) : take("", limit);
  if (eligible.later && rows.length < limit)
    rows.push(...take(` AND (${eligible.later})`, limit - rows.length));
  return {
    rows,
    results: [],
    remaining: Math.max(0, eligibleCount.n - rows.length),
    settled: { count: settledCount, rows: settledRows },
  };
}

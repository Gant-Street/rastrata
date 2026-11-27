import { buildTagMap, isTagKey, SETUP_EFFECTIVE_ON, type TagRecord } from "./chart/tags.ts";
import { migrate } from "./slices/state.ts";
import type { ApplicationStore } from "./storage.ts";

/** How an account's balance change shows in the cash-flow statement. Only balance-sheet accounts
 * (asset, liability, equity) carry one: `cash` marks the accounts the statement ties to, and the
 * rest name the section their changes belong to. Net income already carries income and expense
 * accounts, so they are never tagged. */
export type CashFlowClass = "cash" | "operating" | "investing" | "financing" | "noncash";

/** What a balance-sheet account is to the person: a bank account or a card. The setup and the New
 * account form say it, and Home, Reconcile and the statement import list those accounts from the first
 * day. Only these two are said; every other account is what its role says. */
export type TaggedKind = "bank" | "card";

/** Product metadata attached to accounts. The kernel's account snapshot carries none, so tags
 * live in application product state, versioned by effective date and hashed into report
 * populations (a report must reproduce when a tag changes later).
 *
 * Owned by the chart lane, which owns `readAccountTags` and keeps this shape; the reports and tax
 * lanes read tags only through it. Untagged accounts have no entry and are shown as untagged,
 * never guessed. */
export interface AccountTags {
  readonly cashFlowClass?: CashFlowClass;
  /** A tax form line, for example "scheduleC.line8". Informational; nothing is filed. What a line
   * number means depends on the form's tax year: ask `taxLines.list` for the year being prepared. */
  readonly taxLine?: string;
  /** A key other parts of Rastrata use to find an account, for example "stripe.balance". At most
   * one account holds a key at a time. */
  readonly roleKey?: string;
  /** "bank" on an asset that is a bank account, "card" on a liability that is a card. */
  readonly kind?: TaggedKind;
}

export interface AccountTagMap {
  /** Changes whenever any tag, on any account, at any date, changes. */
  readonly hash: string;
  /** How many recorded tag changes this map reflects: the sequence of the newest one, 0 when
   * nothing was ever recorded. Pass it back as `throughRevision` to read the map as it was. */
  readonly revision: number;
  /** The tags in force on `asOf` (YYYY-MM-DD). An untagged account yields an empty object. */
  tagsFor(accountId: string, asOf: string): AccountTags;
}

/** Changes to tags after setup. Append-only: a change is a new row and a correction supersedes the
 * row it corrects without erasing it. A released step is never edited. */
export const CHART_MIGRATIONS: readonly string[] = [
  `CREATE TABLE chart_tag_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    effective_on TEXT NOT NULL,
    value TEXT,
    recorded_at TEXT NOT NULL,
    operation_id TEXT NOT NULL
  );
  CREATE INDEX chart_tag_log_account ON chart_tag_log (account_id, tag, effective_on, seq);
  CREATE INDEX chart_tag_log_operation ON chart_tag_log (operation_id)`,
  // 2: who made each change, as the book records a caller ("owner", "agent:<id>", "member:<id>"). A change
  // made before this step has none, and the changes list says "not recorded".
  `ALTER TABLE chart_tag_log ADD COLUMN principal TEXT`,
];

/** Create the chart tables if they are not there. Cheap and idempotent, so a reader that never
 * went through a chart operation (reports, tax) can call it. */
export function ensureChartTables(store: ApplicationStore): void {
  migrate(store, "chart", CHART_MIGRATIONS);
}

/** Tags given on the starting accounts when the book was set up. They are part of the immutable
 * setup record, so they are read from it instead of being copied into the log. */
export function setupRecords(store: ApplicationStore): TagRecord[] {
  const table = store
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='app_book'")
    .get();
  if (!table) return [];
  const row = store.query("SELECT setup, status FROM app_book WHERE id=1").get() as {
    setup: string;
    status: string;
  } | null;
  if (row?.status !== "active") return [];
  const setup = JSON.parse(row.setup) as { accounts?: unknown };
  if (!Array.isArray(setup.accounts)) return [];
  const records: TagRecord[] = [];
  for (const account of setup.accounts as { code?: unknown; tags?: unknown }[]) {
    if (typeof account?.code !== "string" || !account.tags || typeof account.tags !== "object")
      continue;
    for (const [tag, value] of Object.entries(account.tags)) {
      if (isTagKey(tag) && typeof value === "string")
        records.push({
          seq: 0,
          accountId: account.code.toLowerCase(),
          tag,
          effectiveOn: SETUP_EFFECTIVE_ON,
          value,
        });
    }
  }
  return records;
}

export interface LogRow {
  seq: number;
  account_id: string;
  tag: string;
  effective_on: string;
  value: string | null;
  recorded_at: string;
  operation_id: string;
  principal: string | null;
}

/** The recorded tag changes up to a revision (all of them by default), oldest first. */
export function readTagLog(store: ApplicationStore, throughRevision?: number): LogRow[] {
  ensureChartTables(store);
  const limit = throughRevision === undefined ? Number.MAX_SAFE_INTEGER : throughRevision;
  return store
    .query(
      "SELECT seq, account_id, tag, effective_on, value, recorded_at, operation_id, principal FROM chart_tag_log WHERE seq <= ? ORDER BY seq",
    )
    .all(limit) as LogRow[];
}

/** The tags of every account, at every date, as of now or as of an earlier `throughRevision`. */
export function readAccountTags(
  store: ApplicationStore,
  options: { readonly throughRevision?: number } = {},
): AccountTagMap {
  const log = readTagLog(store, options.throughRevision);
  const records: TagRecord[] = setupRecords(store);
  for (const row of log)
    if (isTagKey(row.tag))
      records.push({
        seq: row.seq,
        accountId: row.account_id,
        tag: row.tag,
        effectiveOn: row.effective_on,
        value: row.value,
      });
  return buildTagMap(records, log.at(-1)?.seq ?? 0);
}

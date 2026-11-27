import type { ApplicationService } from "../../service.ts";
import type { ApplicationStore } from "../../storage.ts";
import { migrate, sliceState } from "../state.ts";
import { XERO_MIGRATION, XeroStore } from "./xero-store.ts";

/** The shadow lane's product state: what the owner decided about the cutover, and the opening
 * entries planned for it. The money itself is in the ledger. Nothing here is edited or deleted: a
 * change is a new row, and the newest row is what is in force.
 *
 * - `shadow_cutover_log`: each time the cutover date was recorded, with the accounts that have
 *   statements and who recorded it.
 * - `shadow_opening`: each opening entry planned (one per `opening.plan` request, so a retry finds
 *   its own row), linking the request to the draft and the source identity the ledger holds.
 * - `xero_*`: what was imported from Xero and the owner's mapping of it (see `xero-store.ts`).
 * - `shadow_gap`: the gap log. A gap is closed with a note and kept; nothing is deleted. */
export const SHADOW_MIGRATIONS: readonly string[] = [
  `CREATE TABLE shadow_cutover_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    cutover_on TEXT NOT NULL,
    account_ids TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    principal TEXT NOT NULL
  );
  CREATE TABLE shadow_opening (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL UNIQUE,
    source_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    draft_id TEXT,
    cutover_on TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    principal TEXT NOT NULL,
    created_at TEXT NOT NULL,
    superseded INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX shadow_opening_source ON shadow_opening (source_id)`,
  XERO_MIGRATION,
  `CREATE TABLE shadow_gap (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gap_key TEXT UNIQUE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    opened_by TEXT NOT NULL,
    closed_at TEXT,
    closed_by TEXT,
    resolution TEXT
  );
  CREATE INDEX shadow_gap_status ON shadow_gap (status, id)`,
];

export interface CutoverRow {
  readonly seq: number;
  readonly cutoverOn: string;
  readonly accountIds: readonly string[];
  readonly recordedAt: string;
  readonly principal: string;
}

export interface OpeningRow {
  readonly seq: number;
  readonly requestId: string;
  readonly sourceId: string;
  readonly planId: string;
  readonly draftId: string | null;
  readonly cutoverOn: string;
  readonly contentHash: string;
  readonly principal: string;
  readonly createdAt: string;
  readonly superseded: boolean;
}

type RawCutover = {
  seq: number;
  cutover_on: string;
  account_ids: string;
  recorded_at: string;
  principal: string;
};
type RawOpening = {
  seq: number;
  request_id: string;
  source_id: string;
  plan_id: string;
  draft_id: string | null;
  cutover_on: string;
  content_hash: string;
  principal: string;
  created_at: string;
  superseded: number;
};

const toCutover = (row: RawCutover): CutoverRow => ({
  seq: row.seq,
  cutoverOn: row.cutover_on,
  accountIds: JSON.parse(row.account_ids) as string[],
  recordedAt: row.recorded_at,
  principal: row.principal,
});
const toOpening = (row: RawOpening): OpeningRow => ({
  seq: row.seq,
  requestId: row.request_id,
  sourceId: row.source_id,
  planId: row.plan_id,
  draftId: row.draft_id,
  cutoverOn: row.cutover_on,
  contentHash: row.content_hash,
  principal: row.principal,
  createdAt: row.created_at,
  superseded: row.superseded === 1,
});

export type GapKind = "difference" | "unmapped" | "feature" | "data" | "other";
export type GapStatus = "open" | "closed";

/** A gap as the wire states it. */
export interface GapRow {
  readonly id: number;
  readonly kind: GapKind;
  readonly title: string;
  readonly detail: string;
  readonly source: "tieout" | "manual";
  readonly status: GapStatus;
  readonly openedAt: string;
  readonly openedBy: string;
  readonly closedAt: string | null;
  readonly closedBy: string | null;
  readonly resolution: string | null;
}

type RawGap = {
  id: number;
  kind: string;
  title: string;
  detail: string;
  source: string;
  status: string;
  opened_at: string;
  opened_by: string;
  closed_at: string | null;
  closed_by: string | null;
  resolution: string | null;
};

const GAP_COLUMNS =
  "id, kind, title, detail, source, status, opened_at, opened_by, closed_at, closed_by, resolution";

const toGap = (row: RawGap): GapRow => ({
  id: row.id,
  kind: row.kind as GapKind,
  title: row.title,
  detail: row.detail,
  source: row.source as GapRow["source"],
  status: row.status as GapStatus,
  openedAt: row.opened_at,
  openedBy: row.opened_by,
  closedAt: row.closed_at,
  closedBy: row.closed_by,
  resolution: row.resolution,
});

/** The most gaps one read returns, newest first: the answer to a request carries at most this many. */
export const MAX_GAPS_LISTED = 2000;

export class ShadowStore {
  constructor(readonly db: ApplicationStore) {}

  /** The cutover in force: the newest row, or null before one was recorded. */
  cutover(): CutoverRow | null {
    const row = this.db
      .query(
        "SELECT seq, cutover_on, account_ids, recorded_at, principal FROM shadow_cutover_log ORDER BY seq DESC LIMIT 1",
      )
      .get() as RawCutover | null;
    return row ? toCutover(row) : null;
  }

  recordCutover(input: {
    readonly cutoverOn: string;
    readonly accountIds: readonly string[];
    readonly recordedAt: string;
    readonly operationId: string;
    readonly principal: string;
  }): CutoverRow {
    this.db
      .query(
        "INSERT INTO shadow_cutover_log (cutover_on, account_ids, recorded_at, operation_id, principal) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        input.cutoverOn,
        JSON.stringify(input.accountIds),
        input.recordedAt,
        input.operationId,
        input.principal,
      );
    const row = this.cutover();
    if (!row) throw new Error("The cutover was not recorded");
    return row;
  }

  /** The opening entries planned, oldest first. */
  openings(): OpeningRow[] {
    return (
      this.db
        .query(
          "SELECT seq, request_id, source_id, plan_id, draft_id, cutover_on, content_hash, principal, created_at, superseded FROM shadow_opening ORDER BY seq",
        )
        .all() as RawOpening[]
    ).map(toOpening);
  }

  openingByRequest(requestId: string): OpeningRow | null {
    const row = this.db
      .query(
        "SELECT seq, request_id, source_id, plan_id, draft_id, cutover_on, content_hash, principal, created_at, superseded FROM shadow_opening WHERE request_id = ?",
      )
      .get(requestId) as RawOpening | null;
    return row ? toOpening(row) : null;
  }

  addOpening(input: {
    readonly requestId: string;
    readonly sourceId: string;
    readonly planId: string;
    readonly cutoverOn: string;
    readonly contentHash: string;
    readonly principal: string;
    readonly createdAt: string;
  }): void {
    this.db
      .query(
        "INSERT OR IGNORE INTO shadow_opening (request_id, source_id, plan_id, cutover_on, content_hash, principal, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.requestId,
        input.sourceId,
        input.planId,
        input.cutoverOn,
        input.contentHash,
        input.principal,
        input.createdAt,
      );
  }

  setDraft(requestId: string, draftId: string): void {
    this.db
      .query("UPDATE shadow_opening SET draft_id = ? WHERE request_id = ?")
      .run(draftId, requestId);
  }

  supersede(requestId: string): void {
    this.db.query("UPDATE shadow_opening SET superseded = 1 WHERE request_id = ?").run(requestId);
  }

  // ---- The gap log ----

  /** The gaps, newest first, at most `MAX_GAPS_LISTED`. */
  gaps(): GapRow[] {
    return (
      this.db
        .query(`SELECT ${GAP_COLUMNS} FROM shadow_gap ORDER BY id DESC LIMIT ?`)
        .all(MAX_GAPS_LISTED) as RawGap[]
    ).map(toGap);
  }

  gapCounts(): { readonly open: number; readonly closed: number } {
    const rows = this.db
      .query("SELECT status, COUNT(*) AS n FROM shadow_gap GROUP BY status")
      .all() as { status: string; n: number }[];
    const count = (status: string) => rows.find((row) => row.status === status)?.n ?? 0;
    return { open: count("open"), closed: count("closed") };
  }

  gap(id: number): GapRow | null {
    const row = this.db
      .query(`SELECT ${GAP_COLUMNS} FROM shadow_gap WHERE id = ?`)
      .get(id) as RawGap | null;
    return row ? toGap(row) : null;
  }

  gapByKey(key: string): GapRow | null {
    const row = this.db
      .query(`SELECT ${GAP_COLUMNS} FROM shadow_gap WHERE gap_key = ?`)
      .get(key) as RawGap | null;
    return row ? toGap(row) : null;
  }

  addGap(input: {
    readonly key: string | null;
    readonly kind: GapKind;
    readonly title: string;
    readonly detail: string;
    readonly source: GapRow["source"];
    readonly openedAt: string;
    readonly openedBy: string;
  }): GapRow {
    this.db
      .query(
        "INSERT INTO shadow_gap (gap_key, kind, title, detail, source, status, opened_at, opened_by) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)",
      )
      .run(
        input.key,
        input.kind,
        input.title,
        input.detail,
        input.source,
        input.openedAt,
        input.openedBy,
      );
    const row = this.db.query("SELECT last_insert_rowid() AS id").get() as { id: number };
    const added = this.gap(row.id);
    if (!added) throw new Error("The gap was not recorded");
    return added;
  }

  /** Close a gap with a note, or reopen it. Reopening keeps the earlier note until it is closed again. */
  setGapStatus(id: number, status: GapStatus, resolution: string, at: string, by: string): GapRow {
    if (status === "closed")
      this.db
        .query(
          "UPDATE shadow_gap SET status = 'closed', resolution = ?, closed_at = ?, closed_by = ? WHERE id = ?",
        )
        .run(resolution, at, by, id);
    else
      this.db
        .query(
          "UPDATE shadow_gap SET status = 'open', closed_at = NULL, closed_by = NULL, resolution = CASE WHEN ? = '' THEN resolution ELSE ? END WHERE id = ?",
        )
        .run(resolution, resolution, id);
    const updated = this.gap(id);
    if (!updated) throw new Error("The gap is gone");
    return updated;
  }
}

export function shadowStore(service: ApplicationService): ShadowStore {
  return sliceState(service, "shadow.store", (db) => {
    migrate(db, "shadow", SHADOW_MIGRATIONS);
    return new ShadowStore(db);
  });
}

/** What was imported from Xero and how it is mapped. The shadow store runs the migrations. */
export function xeroStore(service: ApplicationService): XeroStore {
  return sliceState(service, "shadow.xero", () => new XeroStore(shadowStore(service).db));
}

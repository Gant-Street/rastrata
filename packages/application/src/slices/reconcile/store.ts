import type { ApplicationBinding, ApplicationStore } from "../../storage.ts";
import { migrate } from "../state.ts";

/** Product state of the reconcile slice. Reconciliation records are facts about the books, so
 * once a reconciliation is completed nothing may change it: the rows are frozen by triggers, not
 * by convention, and a correction is a new row (a void with a reason).
 *
 * - recon_sessions: one row per reconciliation. 'open' is a draft and may be edited; the single
 *   edit allowed on a draft is the move to 'completed', after which the row is frozen.
 * - recon_candidates and recon_selection: the draft's working state. Dropped on completion.
 * - recon_lines: the lines a completed reconciliation cleared. Never changed or deleted.
 * - recon_voids: appended when a reconciliation is voided. Never changed or deleted.
 * - recon_active: the current cleared set, a projection of the completed, unvoided records. Its
 *   primary key is what makes "a posting is on at most one live reconciliation" a hard rule.
 *
 * Steps are append-only: never edit a released step, add a new one. */
const FROZEN = "A completed reconciliation is immutable. Void it with a reason instead.";

export const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE recon_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  account_code TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account_role TEXT NOT NULL,
  normal_side TEXT NOT NULL CHECK (normal_side IN ('debit', 'credit')),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'completed')),
  statement_date TEXT NOT NULL,
  statement_balance TEXT NOT NULL,
  version INTEGER NOT NULL,
  last_operation TEXT NOT NULL,
  baseline TEXT NOT NULL,
  snapshot_sequence TEXT NOT NULL,
  snapshot_revision TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  seq INTEGER,
  completed_at TEXT,
  completed_operation TEXT,
  opening_balance TEXT,
  selected_total TEXT,
  line_count INTEGER,
  previous_id TEXT,
  previous_hash TEXT,
  record_hash TEXT,
  book_revision TEXT,
  CHECK ((status = 'open') = (completed_at IS NULL))
);
CREATE UNIQUE INDEX recon_one_open_per_account ON recon_sessions (account_id) WHERE status = 'open';
CREATE UNIQUE INDEX recon_completion_order ON recon_sessions (account_id, seq) WHERE status = 'completed';
CREATE INDEX recon_sessions_by_account ON recon_sessions (account_id, status);
CREATE TABLE recon_candidates (
  session_id TEXT NOT NULL,
  posting_id TEXT NOT NULL,
  journal_id TEXT NOT NULL,
  line_date TEXT NOT NULL,
  narration TEXT NOT NULL,
  amount TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (session_id, posting_id)
) WITHOUT ROWID;
CREATE INDEX recon_candidates_order ON recon_candidates (session_id, line_date, position);
CREATE TABLE recon_selection (
  session_id TEXT NOT NULL,
  posting_id TEXT NOT NULL,
  PRIMARY KEY (session_id, posting_id)
) WITHOUT ROWID;
CREATE TABLE recon_lines (
  session_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  posting_id TEXT NOT NULL,
  journal_id TEXT NOT NULL,
  line_date TEXT NOT NULL,
  narration TEXT NOT NULL,
  amount TEXT NOT NULL,
  PRIMARY KEY (session_id, ordinal),
  UNIQUE (session_id, posting_id)
) WITHOUT ROWID;
CREATE TABLE recon_active (
  posting_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  journal_id TEXT NOT NULL,
  amount TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX recon_active_by_account ON recon_active (account_id);
CREATE INDEX recon_active_by_journal ON recon_active (journal_id);
CREATE TABLE recon_voids (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  voided_at TEXT NOT NULL,
  void_hash TEXT NOT NULL,
  void_operation TEXT NOT NULL
);
CREATE TRIGGER recon_sessions_frozen_update BEFORE UPDATE ON recon_sessions
WHEN OLD.status = 'completed'
BEGIN SELECT RAISE(ABORT, '${FROZEN}'); END;
CREATE TRIGGER recon_sessions_frozen_delete BEFORE DELETE ON recon_sessions
WHEN OLD.status = 'completed'
BEGIN SELECT RAISE(ABORT, '${FROZEN}'); END;
CREATE TRIGGER recon_lines_frozen_update BEFORE UPDATE ON recon_lines
BEGIN SELECT RAISE(ABORT, 'Reconciled lines are immutable.'); END;
CREATE TRIGGER recon_lines_frozen_delete BEFORE DELETE ON recon_lines
BEGIN SELECT RAISE(ABORT, 'Reconciled lines are immutable.'); END;
CREATE TRIGGER recon_voids_frozen_update BEFORE UPDATE ON recon_voids
BEGIN SELECT RAISE(ABORT, 'A voiding entry is permanent.'); END;
CREATE TRIGGER recon_voids_frozen_delete BEFORE DELETE ON recon_voids
BEGIN SELECT RAISE(ABORT, 'A voiding entry is permanent.'); END;
`,
];

export interface SessionRow {
  id: string;
  account_id: string;
  account_code: string;
  account_name: string;
  account_role: string;
  normal_side: "debit" | "credit";
  currency: string;
  status: "open" | "completed";
  statement_date: string;
  statement_balance: string;
  version: number;
  /** The operation that last changed the draft: a retried request can recognise its own work. */
  last_operation: string;
  /** The newest unvoided completed reconciliation when the lines were read ('' for none). */
  baseline: string;
  snapshot_sequence: string;
  snapshot_revision: string;
  created_at: string;
  updated_at: string;
  seq: number | null;
  completed_at: string | null;
  completed_operation: string | null;
  opening_balance: string | null;
  selected_total: string | null;
  line_count: number | null;
  previous_id: string | null;
  previous_hash: string | null;
  record_hash: string | null;
  book_revision: string | null;
}

export interface VoidRow {
  id: string;
  session_id: string;
  reason: string;
  voided_at: string;
  void_hash: string;
  void_operation: string;
}

export type ListedRow = SessionRow & {
  void_id: string | null;
  void_reason: string | null;
  void_at: string | null;
  void_hash: string | null;
  /** How many lines a draft has selected so far. */
  selected: number;
};

export interface LineRow {
  posting_id: string;
  journal_id: string;
  line_date: string;
  narration: string;
  amount: string;
}

export interface ActiveRow {
  posting_id: string;
  session_id: string;
  account_id: string;
  journal_id: string;
  amount: string;
}

/** SQLite caps the number of bound parameters; every bulk statement goes in chunks. */
const CHUNK = 200;
function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}
const marks = (count: number) => Array.from({ length: count }, () => "?").join(", ");

export class ReconcileStore {
  constructor(readonly db: ApplicationStore) {
    migrate(db, "reconcile", MIGRATIONS);
  }

  transaction<T>(work: () => T): T {
    return this.db.transaction(work);
  }

  // ---- sessions ----------------------------------------------------------------------------

  session(id: string): SessionRow | null {
    return this.db.query("SELECT * FROM recon_sessions WHERE id=?").get(id) as SessionRow | null;
  }

  openFor(accountId: string): SessionRow | null {
    return this.db
      .query("SELECT * FROM recon_sessions WHERE account_id=? AND status='open'")
      .get(accountId) as SessionRow | null;
  }

  voidOf(sessionId: string): VoidRow | null {
    return this.db
      .query("SELECT * FROM recon_voids WHERE session_id=?")
      .get(sessionId) as VoidRow | null;
  }

  /** The newest completed reconciliation of the account that has not been voided. Each
   * reconciliation continues from this one, and only this one can be voided. */
  lastActive(accountId: string): SessionRow | null {
    return this.db
      .query(
        `SELECT s.* FROM recon_sessions s
         WHERE s.account_id=? AND s.status='completed'
           AND NOT EXISTS (SELECT 1 FROM recon_voids v WHERE v.session_id = s.id)
         ORDER BY s.seq DESC LIMIT 1`,
      )
      .get(accountId) as SessionRow | null;
  }

  nextSequence(accountId: string): number {
    const row = this.db
      .query("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM recon_sessions WHERE account_id=?")
      .get(accountId) as { next: number };
    return row.next;
  }

  trackedAccountIds(): Set<string> {
    const rows = this.db.query("SELECT DISTINCT account_id FROM recon_sessions").all() as {
      account_id: string;
    }[];
    return new Set(rows.map((row) => row.account_id));
  }

  insertDraft(row: SessionRow): void {
    const columns = Object.keys(row);
    this.db
      .query(`INSERT INTO recon_sessions (${columns.join(", ")}) VALUES (${marks(columns.length)})`)
      .run(
        ...columns.map(
          (column) =>
            (row as unknown as Record<string, ApplicationBinding>)[column] as ApplicationBinding,
        ),
      );
  }

  /** Compare-and-set on the version: the only way a draft changes. `bump` counts the change as an
   * edit; a refresh that changes nothing a person chose keeps the version, so another window's
   * pending edit is not rejected for no reason. */
  updateDraft(
    id: string,
    expectedVersion: number,
    changes: Partial<
      Pick<
        SessionRow,
        | "statement_date"
        | "statement_balance"
        | "snapshot_sequence"
        | "snapshot_revision"
        | "baseline"
      >
    > &
      Pick<SessionRow, "updated_at" | "last_operation">,
    bump = true,
  ): boolean {
    const entries = Object.entries(changes);
    const sets = entries.map(([column]) => `${column}=?`).join(", ");
    const result = this.db
      .query(
        `UPDATE recon_sessions SET ${sets}${bump ? ", version=version+1" : ""} WHERE id=? AND status='open' AND version=?`,
      )
      .run(...(entries.map(([, value]) => value) as ApplicationBinding[]), id, expectedVersion);
    return result.changes === 1;
  }

  deleteDraft(id: string, expectedVersion: number): boolean {
    const result = this.db
      .query("DELETE FROM recon_sessions WHERE id=? AND status='open' AND version=?")
      .run(id, expectedVersion);
    if (result.changes !== 1) return false;
    this.clearWorking(id);
    return true;
  }

  // ---- the working state of a draft ----------------------------------------------------------

  candidates(sessionId: string, through: string): (LineRow & { position: number })[] {
    return this.db
      .query(
        `SELECT posting_id, journal_id, line_date, narration, amount, position
         FROM recon_candidates WHERE session_id=? AND line_date<=?
         ORDER BY line_date, position`,
      )
      .all(sessionId, through) as (LineRow & { position: number })[];
  }

  replaceCandidates(sessionId: string, rows: readonly (LineRow & { position: number })[]): void {
    this.db.query("DELETE FROM recon_candidates WHERE session_id=?").run(sessionId);
    for (const batch of chunks(rows, 100))
      this.db
        .query(
          `INSERT INTO recon_candidates (session_id, posting_id, journal_id, line_date, narration, amount, position) VALUES ${batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
        )
        .run(
          ...batch.flatMap((row) => [
            sessionId,
            row.posting_id,
            row.journal_id,
            row.line_date,
            row.narration,
            row.amount,
            row.position,
          ]),
        );
  }

  selection(sessionId: string): Set<string> {
    const rows = this.db
      .query("SELECT posting_id FROM recon_selection WHERE session_id=?")
      .all(sessionId) as { posting_id: string }[];
    return new Set(rows.map((row) => row.posting_id));
  }

  /** The candidates a draft has selected, in display order. */
  selectedCandidates(sessionId: string, through: string): (LineRow & { position: number })[] {
    return this.db
      .query(
        `SELECT c.posting_id, c.journal_id, c.line_date, c.narration, c.amount, c.position
         FROM recon_candidates c JOIN recon_selection s
           ON s.session_id = c.session_id AND s.posting_id = c.posting_id
         WHERE c.session_id=? AND c.line_date<=?
         ORDER BY c.line_date, c.position`,
      )
      .all(sessionId, through) as (LineRow & { position: number })[];
  }

  selectAllCandidates(sessionId: string, through: string): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO recon_selection (session_id, posting_id)
         SELECT session_id, posting_id FROM recon_candidates WHERE session_id=? AND line_date<=?`,
      )
      .run(sessionId, through);
  }

  addSelection(sessionId: string, postingIds: readonly string[]): void {
    for (const batch of chunks(postingIds))
      this.db
        .query(
          `INSERT OR IGNORE INTO recon_selection (session_id, posting_id) VALUES ${batch.map(() => "(?, ?)").join(", ")}`,
        )
        .run(...batch.flatMap((postingId) => [sessionId, postingId]));
  }

  removeSelection(sessionId: string, postingIds: readonly string[]): void {
    for (const batch of chunks(postingIds))
      this.db
        .query(
          `DELETE FROM recon_selection WHERE session_id=? AND posting_id IN (${marks(batch.length)})`,
        )
        .run(sessionId, ...batch);
  }

  clearSelection(sessionId: string): void {
    this.db.query("DELETE FROM recon_selection WHERE session_id=?").run(sessionId);
  }

  /** Ids from `postingIds` that are candidates of the draft on or before `through`. */
  knownCandidates(sessionId: string, through: string, postingIds: readonly string[]): Set<string> {
    const known = new Set<string>();
    for (const batch of chunks(postingIds)) {
      const rows = this.db
        .query(
          `SELECT posting_id FROM recon_candidates WHERE session_id=? AND line_date<=? AND posting_id IN (${marks(batch.length)})`,
        )
        .all(sessionId, through, ...batch) as { posting_id: string }[];
      for (const row of rows) known.add(row.posting_id);
    }
    return known;
  }

  /** Drop selected ids that are no longer candidates on or before `through`. */
  pruneSelection(sessionId: string, through: string): string[] {
    const stale = this.db
      .query(
        `SELECT posting_id FROM recon_selection
         WHERE session_id=? AND posting_id NOT IN
           (SELECT posting_id FROM recon_candidates WHERE session_id=? AND line_date<=?)`,
      )
      .all(sessionId, sessionId, through) as { posting_id: string }[];
    if (stale.length)
      this.removeSelection(
        sessionId,
        stale.map((row) => row.posting_id),
      );
    return stale.map((row) => row.posting_id);
  }

  clearWorking(sessionId: string): void {
    this.db.query("DELETE FROM recon_candidates WHERE session_id=?").run(sessionId);
    this.db.query("DELETE FROM recon_selection WHERE session_id=?").run(sessionId);
  }

  // ---- completed reconciliations ---------------------------------------------------------------

  /** Freeze a draft. The caller has checked the figures; this only writes. */
  complete(input: {
    id: string;
    expectedVersion: number;
    seq: number;
    completedAt: string;
    operationId: string;
    openingBalance: string;
    selectedTotal: string;
    previousId: string | null;
    previousHash: string | null;
    recordHash: string;
    bookRevision: string;
    snapshotSequence: string;
    lines: readonly (LineRow & { account_id: string })[];
  }): boolean {
    const result = this.db
      .query(
        `UPDATE recon_sessions SET status='completed', seq=?, completed_at=?, completed_operation=?, opening_balance=?, selected_total=?, line_count=?, previous_id=?, previous_hash=?, record_hash=?, book_revision=?, snapshot_sequence=?, updated_at=?
         WHERE id=? AND status='open' AND version=?`,
      )
      .run(
        input.seq,
        input.completedAt,
        input.operationId,
        input.openingBalance,
        input.selectedTotal,
        input.lines.length,
        input.previousId,
        input.previousHash,
        input.recordHash,
        input.bookRevision,
        input.snapshotSequence,
        input.completedAt,
        input.id,
        input.expectedVersion,
      );
    if (result.changes !== 1) return false;
    input.lines.forEach((line, ordinal) => {
      this.db
        .query(
          "INSERT INTO recon_lines (session_id, ordinal, posting_id, journal_id, line_date, narration, amount) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.id,
          ordinal,
          line.posting_id,
          line.journal_id,
          line.line_date,
          line.narration,
          line.amount,
        );
      this.db
        .query(
          "INSERT INTO recon_active (posting_id, session_id, account_id, journal_id, amount) VALUES (?, ?, ?, ?, ?)",
        )
        .run(line.posting_id, input.id, line.account_id, line.journal_id, line.amount);
    });
    this.clearWorking(input.id);
    return true;
  }

  lines(sessionId: string): LineRow[] {
    return this.db
      .query(
        "SELECT posting_id, journal_id, line_date, narration, amount FROM recon_lines WHERE session_id=? ORDER BY ordinal",
      )
      .all(sessionId) as LineRow[];
  }

  appendVoid(row: VoidRow): void {
    this.db
      .query(
        "INSERT INTO recon_voids (id, session_id, reason, voided_at, void_hash, void_operation) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(row.id, row.session_id, row.reason, row.voided_at, row.void_hash, row.void_operation);
    this.db.query("DELETE FROM recon_active WHERE session_id=?").run(row.session_id);
  }

  // ---- the cleared set ---------------------------------------------------------------------------

  activeFor(accountId: string): ActiveRow[] {
    return this.db
      .query("SELECT * FROM recon_active WHERE account_id=?")
      .all(accountId) as ActiveRow[];
  }

  /** A value that is different whenever the cleared set is: it changes only when a reconciliation is completed or
   * voided, and neither is ever undone, so how many of each there are only grows. */
  clearedGeneration(): string {
    const row = this.db
      .query(
        "SELECT (SELECT COUNT(*) FROM recon_sessions WHERE status='completed') AS completed, (SELECT COUNT(*) FROM recon_voids) AS voided",
      )
      .get() as { completed: number; voided: number };
    return `${row.completed}:${row.voided}`;
  }

  activeIds(accountId: string): Set<string> {
    const rows = this.db
      .query("SELECT posting_id FROM recon_active WHERE account_id=?")
      .all(accountId) as { posting_id: string }[];
    return new Set(rows.map((row) => row.posting_id));
  }

  activeForJournals(journalIds: readonly string[]): (ActiveRow & { statement_date: string })[] {
    const out: (ActiveRow & { statement_date: string })[] = [];
    for (const batch of chunks(journalIds))
      out.push(
        ...(this.db
          .query(
            `SELECT a.posting_id, a.session_id, a.account_id, a.journal_id, a.amount, s.statement_date
             FROM recon_active a JOIN recon_sessions s ON s.id = a.session_id
             WHERE a.journal_id IN (${marks(batch.length)})
             ORDER BY a.journal_id, a.posting_id`,
          )
          .all(...batch) as (ActiveRow & { statement_date: string })[]),
      );
    return out;
  }

  // ---- history ---------------------------------------------------------------------------------------

  list(filter: {
    accountId?: string;
    status?: "draft" | "completed" | "voided";
    limit: number;
    offset: number;
  }): { count: number; rows: ListedRow[] } {
    const where: string[] = [];
    const bindings: ApplicationBinding[] = [];
    if (filter.accountId) {
      where.push("s.account_id=?");
      bindings.push(filter.accountId);
    }
    if (filter.status === "draft") where.push("s.status='open'");
    else if (filter.status === "completed") where.push("s.status='completed' AND v.id IS NULL");
    else if (filter.status === "voided") where.push("v.id IS NOT NULL");
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const from = `FROM recon_sessions s LEFT JOIN recon_voids v ON v.session_id = s.id ${clause}`;
    const count = (
      this.db.query(`SELECT COUNT(*) AS count ${from}`).get(...bindings) as { count: number }
    ).count;
    const rows = this.db
      .query(
        `SELECT s.*, v.id AS void_id, v.reason AS void_reason, v.voided_at AS void_at, v.void_hash AS void_hash,
           (SELECT COUNT(*) FROM recon_selection x WHERE x.session_id = s.id) AS selected
         ${from} ORDER BY s.created_at DESC, s.rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...bindings, filter.limit, filter.offset) as ListedRow[];
    return { count, rows };
  }

  /** Every completed record, oldest first, for integrity checks. */
  completedRecords(): SessionRow[] {
    return this.db
      .query("SELECT * FROM recon_sessions WHERE status='completed' ORDER BY account_id, seq")
      .all() as SessionRow[];
  }
}

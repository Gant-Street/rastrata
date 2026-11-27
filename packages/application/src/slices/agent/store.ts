/** Product state for agent tokens: the token table and the activity trail. Only the SHA-256 of a
 * token's secret is ever stored. */
import { ApplicationError } from "../../errors.ts";
import { GRANTABLE_PERMISSIONS, type GrantablePermission } from "../../agent/token.ts";
import type { ApplicationService } from "../../service.ts";
import type { ApplicationStore } from "../../storage.ts";
import { migrate, sliceState } from "../state.ts";

const MIGRATIONS = [
  `CREATE TABLE agent_tokens (
     id TEXT PRIMARY KEY,
     label TEXT NOT NULL,
     permissions TEXT NOT NULL,
     secret_hash TEXT NOT NULL,
     created_at TEXT NOT NULL,
     created_by TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     revoked_at TEXT,
     revoked_reason TEXT,
     last_used_at TEXT,
     create_operation_id TEXT NOT NULL UNIQUE
   )`,
  `CREATE TABLE agent_activity (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     token_id TEXT NOT NULL,
     operation TEXT NOT NULL,
     operation_id TEXT,
     outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'denied', 'failed')),
     code TEXT,
     status INTEGER NOT NULL
   );
   CREATE INDEX agent_activity_by_token ON agent_activity (token_id, seq DESC)`,
];

/** The newest activity rows kept. A runaway agent cannot grow the book without bound. */
const ACTIVITY_KEEP = 20_000;
const ACTIVITY_PRUNE_EVERY = 200;
/** `last_used_at` is refreshed at most this often per token, so reads do not each write. */
const TOUCH_INTERVAL_MS = 60_000;
export const ACTIVITY_PAGE_SIZE = 25;

export type TokenStatus = "active" | "revoked" | "expired";

export interface TokenRecord {
  readonly id: string;
  readonly label: string;
  readonly permissions: readonly GrantablePermission[];
  readonly createdAt: string;
  readonly createdBy: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
  readonly lastUsedAt: string | null;
}

export interface StoredToken extends TokenRecord {
  readonly secretHash: string;
}

export type ActivityOutcome = "ok" | "denied" | "failed";

export interface ActivityEvent {
  readonly seq: string;
  readonly at: string;
  readonly tokenId: string;
  /** The label at the time of reading; null if the token row is gone. */
  readonly label: string | null;
  readonly operation: string;
  readonly operationId: string | null;
  readonly outcome: ActivityOutcome;
  readonly code: string | null;
  readonly status: number;
}

type TokenRow = {
  id: string;
  label: string;
  permissions: string;
  secret_hash: string;
  created_at: string;
  created_by: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  last_used_at: string | null;
};

const record = (row: TokenRow): StoredToken => ({
  id: row.id,
  label: row.label,
  permissions: (JSON.parse(row.permissions) as string[]).filter(
    (permission): permission is GrantablePermission =>
      // A stored row that somehow lists anything else (say provision) never widens a token.
      (GRANTABLE_PERMISSIONS as readonly string[]).includes(permission),
  ),
  secretHash: row.secret_hash,
  createdAt: row.created_at,
  createdBy: row.created_by,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  revokedReason: row.revoked_reason,
  lastUsedAt: row.last_used_at,
});

export function tokenStatus(token: TokenRecord, now: Date): TokenStatus {
  if (token.revokedAt) return "revoked";
  return Date.parse(token.expiresAt) <= now.getTime() ? "expired" : "active";
}

/** Per-service state for the agent slice. `clock` is the one place the slice reads time; tests
 * replace it (a mutable field on this per-service object, never a module global). */
export class AgentState {
  clock: () => Date = () => new Date();
  private readonly touched = new Map<string, number>();
  private inserts = 0;

  constructor(private readonly store: ApplicationStore) {
    migrate(store, "agent", MIGRATIONS);
  }

  now(): Date {
    return this.clock();
  }

  insertToken(token: {
    id: string;
    label: string;
    permissions: readonly GrantablePermission[];
    secretHash: string;
    createdAt: string;
    createdBy: string;
    expiresAt: string;
    operationId: string;
  }): TokenRecord {
    this.store
      .query(
        "INSERT INTO agent_tokens (id, label, permissions, secret_hash, created_at, created_by, expires_at, create_operation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        token.id,
        token.label,
        JSON.stringify(token.permissions),
        token.secretHash,
        token.createdAt,
        token.createdBy,
        token.expiresAt,
        token.operationId,
      );
    return this.requireToken(token.id);
  }

  getToken(id: string): StoredToken | null {
    const row = this.store
      .query("SELECT * FROM agent_tokens WHERE id=?")
      .get(id) as TokenRow | null;
    return row ? record(row) : null;
  }

  requireToken(id: string): StoredToken {
    const token = this.getToken(id);
    if (!token) throw new ApplicationError("token_not_found", "No token has that identifier", 404);
    return token;
  }

  listTokens(): StoredToken[] {
    return (
      this.store
        .query("SELECT * FROM agent_tokens ORDER BY created_at DESC, id")
        .all() as TokenRow[]
    ).map(record);
  }

  /** Revoke now. Idempotent: an already revoked token keeps its first revocation. */
  revoke(id: string, reason: string | null): StoredToken {
    const existing = this.requireToken(id);
    if (existing.revokedAt) return existing;
    this.store
      .query(
        "UPDATE agent_tokens SET revoked_at=?, revoked_reason=? WHERE id=? AND revoked_at IS NULL",
      )
      .run(this.now().toISOString(), reason, id);
    return this.requireToken(id);
  }

  touch(id: string): void {
    const now = this.now();
    const last = this.touched.get(id);
    if (last !== undefined && now.getTime() - last < TOUCH_INTERVAL_MS) return;
    this.touched.set(id, now.getTime());
    this.store
      .query("UPDATE agent_tokens SET last_used_at=? WHERE id=?")
      .run(now.toISOString(), id);
  }

  recordActivity(event: {
    tokenId: string;
    operation: string;
    operationId: string | null;
    outcome: ActivityOutcome;
    code: string | null;
    status: number;
  }): void {
    this.store
      .query(
        "INSERT INTO agent_activity (at, token_id, operation, operation_id, outcome, code, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        this.now().toISOString(),
        event.tokenId,
        event.operation,
        event.operationId,
        event.outcome,
        event.code,
        event.status,
      );
    if (++this.inserts % ACTIVITY_PRUNE_EVERY === 0)
      this.store
        .query("DELETE FROM agent_activity WHERE seq <= (SELECT MAX(seq) FROM agent_activity) - ?")
        .run(ACTIVITY_KEEP);
  }

  activity(tokenId: string | undefined, page: number): { count: number; events: ActivityEvent[] } {
    const filter = tokenId === undefined ? "" : " WHERE a.token_id=?";
    const bindings = tokenId === undefined ? [] : [tokenId];
    const count = (
      this.store
        .query(`SELECT COUNT(*) AS count FROM agent_activity a${filter}`)
        .get(...bindings) as { count: number }
    ).count;
    const rows = this.store
      .query(
        `SELECT a.seq, a.at, a.token_id, t.label, a.operation, a.operation_id, a.outcome, a.code, a.status FROM agent_activity a LEFT JOIN agent_tokens t ON t.id = a.token_id${filter} ORDER BY a.seq DESC LIMIT ? OFFSET ?`,
      )
      .all(...bindings, ACTIVITY_PAGE_SIZE, (page - 1) * ACTIVITY_PAGE_SIZE) as {
      seq: number;
      at: string;
      token_id: string;
      label: string | null;
      operation: string;
      operation_id: string | null;
      outcome: ActivityOutcome;
      code: string | null;
      status: number;
    }[];
    return {
      count,
      events: rows.map((row) => ({
        seq: String(row.seq),
        at: row.at,
        tokenId: row.token_id,
        label: row.label,
        operation: row.operation,
        operationId: row.operation_id,
        outcome: row.outcome,
        code: row.code,
        status: row.status,
      })),
    };
  }
}

/** The agent slice's state for one service: tables created once, one clock. */
export function agentState(service: ApplicationService): AgentState {
  return sliceState(service, "agent", (store) => new AgentState(store));
}

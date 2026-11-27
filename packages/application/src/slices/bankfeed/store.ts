import type { ListedAccount, Support } from "../../bankfeed/listing.ts";
import type { HeldTransaction } from "../../bankfeed/normalise.ts";
import type { ProblemView } from "../../bankfeed/problems.ts";
import type { ApplicationService } from "../../service.ts";
import type { ApplicationStore } from "../../storage.ts";
import { migrate, sliceState } from "../state.ts";

/** The bankfeed lane's product state. Everything here is bookkeeping about the connection: what the
 * Bridge listed, which accounts are linked and how far each has been read, the requests made (the
 * Bridge's quota is counted from them), sync history and the transactions that could not be read
 * exactly. The money itself lives in the ledger and in the Inbox.
 *
 * **Nothing here is secret.** The access URL is in a private file beside the book and is never in
 * these tables, so a backup, an export or a copy of the book holds no credential. Text from the Bridge
 * (account and bank names, messages) is stored already stripped of control characters and bounded.
 * Cursors are epoch seconds in integers. */

export const BANKFEED_MIGRATIONS: readonly string[] = [
  `CREATE TABLE bankfeed_connection (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    host TEXT,
    connected_at TEXT,
    connected_by TEXT,
    attention_code TEXT,
    attention_message TEXT,
    attention_at TEXT,
    paused_until TEXT,
    listed_at TEXT,
    issues TEXT NOT NULL DEFAULT '[]',
    messages TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE bankfeed_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    daily_sync INTEGER NOT NULL DEFAULT 0,
    daily_at TEXT NOT NULL DEFAULT '06:17',
    updated_at TEXT
  );
  CREATE TABLE bankfeed_accounts (
    account_id TEXT PRIMARY KEY,
    conn_id TEXT,
    org_id TEXT,
    org_name TEXT,
    name TEXT NOT NULL,
    currency TEXT NOT NULL,
    iso_currency TEXT,
    balance TEXT,
    balance_on TEXT,
    support TEXT NOT NULL DEFAULT 'ok',
    listed INTEGER NOT NULL DEFAULT 1,
    first_seen_at TEXT NOT NULL,
    seen_at TEXT NOT NULL
  );
  CREATE TABLE bankfeed_links (
    account_id TEXT PRIMARY KEY,
    ledger_account_id TEXT NOT NULL UNIQUE,
    start_on TEXT NOT NULL,
    conn_id TEXT,
    linked_at TEXT NOT NULL,
    linked_by TEXT NOT NULL,
    through INTEGER,
    fetched_from INTEGER,
    last_sync_at TEXT,
    last_ok_at TEXT,
    last_error_code TEXT,
    last_error_message TEXT
  );
  CREATE TABLE bankfeed_requests (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at_ms INTEGER NOT NULL,
    kind TEXT NOT NULL,
    account_id TEXT,
    status INTEGER
  );
  CREATE INDEX bankfeed_requests_at ON bankfeed_requests (at_ms);
  CREATE TABLE bankfeed_runs (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    disposition TEXT NOT NULL,
    trigger TEXT NOT NULL DEFAULT 'manual',
    requests INTEGER NOT NULL DEFAULT 0,
    accounts INTEGER NOT NULL DEFAULT 0,
    windows INTEGER NOT NULL DEFAULT 0,
    new_lines INTEGER NOT NULL DEFAULT 0,
    duplicate_lines INTEGER NOT NULL DEFAULT 0,
    pending_skipped INTEGER NOT NULL DEFAULT 0,
    held_lines INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    error_message TEXT,
    notes TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE bankfeed_held (
    account_id TEXT NOT NULL,
    key TEXT NOT NULL,
    tx_id TEXT,
    posted_on TEXT,
    reason TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (account_id, key)
  )`,
];

export interface ConnectionRow {
  readonly host: string | null;
  readonly connectedAt: string | null;
  readonly connectedBy: string | null;
  readonly attentionCode: string | null;
  readonly attentionMessage: string | null;
  readonly attentionAt: string | null;
  /** ISO instant: no request to the Bridge is made before it. */
  readonly pausedUntil: string | null;
  readonly listedAt: string | null;
  /** The problems the Bridge reported at the last listing. */
  readonly issues: readonly StoredProblem[];
  readonly messages: readonly string[];
}

/** A problem as stored: already turned into a sentence that says which bank and where to go, with
 * the Bridge's own words kept apart. */
export type StoredProblem = ProblemView;

export interface AccountRow {
  readonly accountId: string;
  readonly connId: string | null;
  readonly orgId: string | null;
  readonly orgName: string | null;
  readonly name: string;
  readonly currency: string;
  readonly isoCurrency: string | null;
  readonly balance: string | null;
  readonly balanceOn: string | null;
  readonly support: Support;
  /** In the Bridge's latest listing. */
  readonly listed: boolean;
  readonly firstSeenAt: string;
  readonly seenAt: string;
}

export interface LinkRow {
  readonly accountId: string;
  readonly ledgerAccountId: string;
  readonly startOn: string;
  readonly connId: string | null;
  readonly linkedAt: string;
  readonly linkedBy: string;
  /** Epoch seconds: everything before it was read and applied. */
  readonly through: number | null;
  /** Epoch seconds: the start of the earliest window read for this link. */
  readonly fetchedFrom: number | null;
  readonly lastSyncAt: string | null;
  readonly lastOkAt: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
}

export interface RunRow {
  readonly id: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly disposition: "running" | "complete" | "more" | "paused" | "failed";
  readonly trigger: "manual" | "scheduled";
  readonly requests: number;
  readonly accounts: number;
  readonly windows: number;
  readonly newLines: number;
  readonly duplicateLines: number;
  readonly pendingSkipped: number;
  readonly heldLines: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly notes: readonly string[];
}

export interface HeldRow {
  readonly accountId: string;
  readonly id: string | null;
  readonly postedOn: string | null;
  readonly reason: string;
}

export interface SettingsRow {
  readonly dailySync: boolean;
  readonly dailyAt: string;
}

type Raw = Record<string, unknown>;
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const whole = (value: unknown): number | null => (typeof value === "number" ? value : null);
const json = <T>(value: unknown, fallback: T): T => {
  try {
    return typeof value === "string" ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
};

const accountFrom = (row: Raw): AccountRow => ({
  accountId: String(row.account_id),
  connId: text(row.conn_id),
  orgId: text(row.org_id),
  orgName: text(row.org_name),
  name: String(row.name),
  currency: String(row.currency),
  isoCurrency: text(row.iso_currency),
  balance: text(row.balance),
  balanceOn: text(row.balance_on),
  support: String(row.support) as Support,
  listed: row.listed === 1,
  firstSeenAt: String(row.first_seen_at),
  seenAt: String(row.seen_at),
});

const linkFrom = (row: Raw): LinkRow => ({
  accountId: String(row.account_id),
  ledgerAccountId: String(row.ledger_account_id),
  startOn: String(row.start_on),
  connId: text(row.conn_id),
  linkedAt: String(row.linked_at),
  linkedBy: String(row.linked_by),
  through: whole(row.through),
  fetchedFrom: whole(row.fetched_from),
  lastSyncAt: text(row.last_sync_at),
  lastOkAt: text(row.last_ok_at),
  lastErrorCode: text(row.last_error_code),
  lastErrorMessage: text(row.last_error_message),
});

const runFrom = (row: Raw): RunRow => ({
  id: String(row.id),
  startedAt: String(row.started_at),
  finishedAt: text(row.finished_at),
  disposition: String(row.disposition) as RunRow["disposition"],
  trigger: String(row.trigger) as RunRow["trigger"],
  requests: Number(row.requests),
  accounts: Number(row.accounts),
  windows: Number(row.windows),
  newLines: Number(row.new_lines),
  duplicateLines: Number(row.duplicate_lines),
  pendingSkipped: Number(row.pending_skipped),
  heldLines: Number(row.held_lines),
  errorCode: text(row.error_code),
  errorMessage: text(row.error_message),
  notes: json<string[]>(row.notes, []),
});

/** Requests older than this are forgotten; the quota only looks back 24 hours. */
const REQUEST_KEEP_MS = 3 * 24 * 60 * 60 * 1000;

export class BankfeedStore {
  constructor(private readonly db: ApplicationStore) {}

  // ----- the connection -----
  connection(): ConnectionRow {
    const row = this.db.query("SELECT * FROM bankfeed_connection WHERE id=1").get() as Raw | null;
    return {
      host: text(row?.host),
      connectedAt: text(row?.connected_at),
      connectedBy: text(row?.connected_by),
      attentionCode: text(row?.attention_code),
      attentionMessage: text(row?.attention_message),
      attentionAt: text(row?.attention_at),
      pausedUntil: text(row?.paused_until),
      listedAt: text(row?.listed_at),
      issues: json<StoredProblem[]>(row?.issues, []),
      messages: json<string[]>(row?.messages, []),
    };
  }
  private ensureConnection(): void {
    this.db.query("INSERT OR IGNORE INTO bankfeed_connection (id) VALUES (1)").run();
  }
  markConnected(host: string, at: string, by: string): void {
    this.ensureConnection();
    this.db
      .query(
        `UPDATE bankfeed_connection SET host=?, connected_at=?, connected_by=?, attention_code=NULL,
           attention_message=NULL, attention_at=NULL, paused_until=NULL, issues='[]', messages='[]' WHERE id=1`,
      )
      .run(host, at, by);
  }
  markDisconnected(): void {
    this.ensureConnection();
    this.db
      .query(
        `UPDATE bankfeed_connection SET host=NULL, connected_at=NULL, connected_by=NULL, attention_code=NULL,
           attention_message=NULL, attention_at=NULL, paused_until=NULL, issues='[]', messages='[]' WHERE id=1`,
      )
      .run();
  }
  setAttention(code: string | null, message: string | null, at: string | null): void {
    this.ensureConnection();
    this.db
      .query(
        "UPDATE bankfeed_connection SET attention_code=?, attention_message=?, attention_at=? WHERE id=1",
      )
      .run(code, message, at);
  }
  setPausedUntil(until: string | null): void {
    this.ensureConnection();
    this.db.query("UPDATE bankfeed_connection SET paused_until=? WHERE id=1").run(until);
  }
  saveListing(issues: readonly StoredProblem[], messages: readonly string[], at: string): void {
    this.ensureConnection();
    this.db
      .query("UPDATE bankfeed_connection SET issues=?, messages=?, listed_at=? WHERE id=1")
      .run(JSON.stringify(issues), JSON.stringify(messages), at);
  }

  // ----- settings -----
  settings(): SettingsRow {
    const row = this.db.query("SELECT * FROM bankfeed_settings WHERE id=1").get() as Raw | null;
    return { dailySync: row?.daily_sync === 1, dailyAt: text(row?.daily_at) ?? "06:17" };
  }
  saveSettings(settings: SettingsRow, at: string): void {
    this.db
      .query(
        `INSERT INTO bankfeed_settings (id, daily_sync, daily_at, updated_at) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET daily_sync=excluded.daily_sync, daily_at=excluded.daily_at, updated_at=excluded.updated_at`,
      )
      .run(settings.dailySync ? 1 : 0, settings.dailyAt, at);
  }

  // ----- the accounts the Bridge listed -----
  accounts(): AccountRow[] {
    return (
      this.db
        .query("SELECT * FROM bankfeed_accounts ORDER BY org_name, name, account_id")
        .all() as Raw[]
    ).map(accountFrom);
  }
  account(accountId: string): AccountRow | null {
    const row = this.db
      .query("SELECT * FROM bankfeed_accounts WHERE account_id=?")
      .get(accountId) as Raw | null;
    return row ? accountFrom(row) : null;
  }
  /** Take the Bridge's latest listing: accounts it lists are updated or added, and accounts it no
   * longer lists are kept (a link may name one) but marked as not listed. An account two entries of
   * the listing share an id for is stored once, as ambiguous. */
  replaceAccounts(listed: readonly ListedAccount[], at: string): void {
    this.db.query("UPDATE bankfeed_accounts SET listed=0").run();
    const upsert = this.db.query(
      `INSERT INTO bankfeed_accounts (account_id, conn_id, org_id, org_name, name, currency, iso_currency,
         balance, balance_on, support, listed, first_seen_at, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET conn_id=excluded.conn_id, org_id=excluded.org_id,
         org_name=excluded.org_name, name=excluded.name, currency=excluded.currency,
         iso_currency=excluded.iso_currency, balance=excluded.balance, balance_on=excluded.balance_on,
         support=excluded.support, listed=1, seen_at=excluded.seen_at`,
    );
    for (const account of listed)
      upsert.run(
        account.id,
        account.connId,
        account.orgId,
        account.orgName,
        account.name,
        account.currency,
        account.isoCurrency,
        account.balance,
        account.balanceOn,
        account.support,
        at,
        at,
      );
  }
  /** The newest balance an account's own answer gave. */
  updateBalance(
    accountId: string,
    balance: string | null,
    balanceOn: string | null,
    at: string,
  ): void {
    this.db
      .query("UPDATE bankfeed_accounts SET balance=?, balance_on=?, seen_at=? WHERE account_id=?")
      .run(balance, balanceOn, at, accountId);
  }

  // ----- links -----
  links(): LinkRow[] {
    return (
      this.db.query("SELECT * FROM bankfeed_links ORDER BY linked_at, account_id").all() as Raw[]
    ).map(linkFrom);
  }
  link(accountId: string): LinkRow | null {
    const row = this.db
      .query("SELECT * FROM bankfeed_links WHERE account_id=?")
      .get(accountId) as Raw | null;
    return row ? linkFrom(row) : null;
  }
  linkByLedger(ledgerAccountId: string): LinkRow | null {
    const row = this.db
      .query("SELECT * FROM bankfeed_links WHERE ledger_account_id=?")
      .get(ledgerAccountId) as Raw | null;
    return row ? linkFrom(row) : null;
  }
  saveLink(link: {
    readonly accountId: string;
    readonly ledgerAccountId: string;
    readonly startOn: string;
    readonly connId: string | null;
    readonly linkedAt: string;
    readonly linkedBy: string;
  }): void {
    this.db
      .query(
        `INSERT INTO bankfeed_links (account_id, ledger_account_id, start_on, conn_id, linked_at, linked_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET ledger_account_id=excluded.ledger_account_id,
           start_on=excluded.start_on, conn_id=excluded.conn_id`,
      )
      .run(
        link.accountId,
        link.ledgerAccountId,
        link.startOn,
        link.connId,
        link.linkedAt,
        link.linkedBy,
      );
  }
  deleteLink(accountId: string): void {
    this.db.query("DELETE FROM bankfeed_links WHERE account_id=?").run(accountId);
  }
  /** Move the cursor, in the same step as the window it follows. `fetchedFrom` is only ever set once
   * until a reset: it is where the first window of the current reading began. */
  saveCursor(accountId: string, through: number, windowFrom: number): void {
    this.db
      .query(
        "UPDATE bankfeed_links SET through=?, fetched_from=COALESCE(fetched_from, ?) WHERE account_id=?",
      )
      .run(through, windowFrom, accountId);
  }
  /** Forget how far an account was read, so the next sync reads again from its first day. Safe:
   * everything already read is known to the pipeline. */
  resetCursor(accountId: string): void {
    this.db
      .query("UPDATE bankfeed_links SET through=NULL, fetched_from=NULL WHERE account_id=?")
      .run(accountId);
  }
  recordSync(
    accountId: string,
    result: {
      readonly at: string;
      readonly ok: boolean;
      readonly errorCode: string | null;
      readonly errorMessage: string | null;
    },
  ): void {
    this.db
      .query(
        `UPDATE bankfeed_links SET last_sync_at=?, last_ok_at=CASE WHEN ? THEN ? ELSE last_ok_at END,
           last_error_code=?, last_error_message=? WHERE account_id=?`,
      )
      .run(
        result.at,
        result.ok ? 1 : 0,
        result.at,
        result.errorCode,
        result.errorMessage,
        accountId,
      );
  }

  // ----- the Bridge's quota -----
  recordRequest(atMs: number, kind: string, accountId: string | null, status: number | null): void {
    this.db
      .query("INSERT INTO bankfeed_requests (at_ms, kind, account_id, status) VALUES (?, ?, ?, ?)")
      .run(atMs, kind, accountId, status);
  }
  /** Requests that count against the daily quota (every read of `/accounts`; a claim is not one),
   * made after `sinceMs`, oldest first. */
  requestTimesSince(sinceMs: number): number[] {
    return (
      this.db
        .query(
          "SELECT at_ms FROM bankfeed_requests WHERE kind IN ('listing', 'account') AND at_ms > ? ORDER BY at_ms",
        )
        .all(sinceMs) as Raw[]
    ).map((row) => Number(row.at_ms));
  }
  pruneRequests(nowMs: number): void {
    this.db.query("DELETE FROM bankfeed_requests WHERE at_ms < ?").run(nowMs - REQUEST_KEEP_MS);
  }

  // ----- sync history -----
  startRun(id: string, startedAt: string, trigger: "manual" | "scheduled"): void {
    const next = (
      this.db.query("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM bankfeed_runs").get() as Raw
    ).n;
    this.db
      .query(
        "INSERT INTO bankfeed_runs (id, seq, started_at, disposition, trigger) VALUES (?, ?, ?, 'running', ?) ON CONFLICT(id) DO NOTHING",
      )
      .run(id, next as number, startedAt, trigger);
  }
  finishRun(run: RunRow): void {
    this.db
      .query(
        `UPDATE bankfeed_runs SET finished_at=?, disposition=?, requests=?, accounts=?, windows=?, new_lines=?,
           duplicate_lines=?, pending_skipped=?, held_lines=?, error_code=?, error_message=?, notes=? WHERE id=?`,
      )
      .run(
        run.finishedAt,
        run.disposition,
        run.requests,
        run.accounts,
        run.windows,
        run.newLines,
        run.duplicateLines,
        run.pendingSkipped,
        run.heldLines,
        run.errorCode,
        run.errorMessage,
        JSON.stringify(run.notes),
        run.id,
      );
  }
  runs(limit: number): RunRow[] {
    return (
      this.db.query("SELECT * FROM bankfeed_runs ORDER BY seq DESC LIMIT ?").all(limit) as Raw[]
    ).map(runFrom);
  }
  /** Runs left `running` by a process that stopped: nothing is running now, so they are interrupted. */
  closeStaleRuns(at: string): void {
    this.db
      .query(
        "UPDATE bankfeed_runs SET disposition='failed', finished_at=?, error_code='bankfeed_interrupted', error_message='The service stopped while this sync was running. The next sync carries on from the last applied window.' WHERE disposition='running'",
      )
      .run(at);
  }
  lastScheduledAt(): string | null {
    const row = this.db
      .query(
        "SELECT started_at FROM bankfeed_runs WHERE trigger='scheduled' ORDER BY seq DESC LIMIT 1",
      )
      .get() as Raw | null;
    return text(row?.started_at);
  }
  scheduledSince(sinceIso: string): number {
    return Number(
      (
        this.db
          .query(
            "SELECT COUNT(*) AS n FROM bankfeed_runs WHERE trigger='scheduled' AND started_at >= ?",
          )
          .get(sinceIso) as Raw
      ).n,
    );
  }

  // ----- transactions that could not be read exactly -----
  holdTransactions(accountId: string, items: readonly HeldTransaction[], at: string): void {
    const upsert = this.db.query(
      `INSERT INTO bankfeed_held (account_id, key, tx_id, posted_on, reason, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, key) DO UPDATE SET reason=excluded.reason, posted_on=excluded.posted_on,
         last_seen_at=excluded.last_seen_at`,
    );
    for (const item of items)
      upsert.run(accountId, item.key, item.id, item.postedOn, item.reason, at, at);
  }
  /** Transactions that have since been read and imported are no longer held. */
  releaseHeld(accountId: string, keys: readonly string[]): void {
    const remove = this.db.query("DELETE FROM bankfeed_held WHERE account_id=? AND key=?");
    for (const key of keys) remove.run(accountId, key);
  }
  held(limit: number): { readonly rows: HeldRow[]; readonly count: number } {
    const rows = (
      this.db
        .query(
          "SELECT account_id, tx_id, posted_on, reason FROM bankfeed_held ORDER BY posted_on DESC, account_id, key LIMIT ?",
        )
        .all(limit) as Raw[]
    ).map((row) => ({
      accountId: String(row.account_id),
      id: text(row.tx_id),
      postedOn: text(row.posted_on),
      reason: String(row.reason),
    }));
    const count = Number((this.db.query("SELECT COUNT(*) AS n FROM bankfeed_held").get() as Raw).n);
    return { rows, count };
  }
  heldCountFor(accountId: string): number {
    return Number(
      (
        this.db
          .query("SELECT COUNT(*) AS n FROM bankfeed_held WHERE account_id=?")
          .get(accountId) as Raw
      ).n,
    );
  }

  transaction<T>(work: () => T): T {
    return this.db.transaction(work);
  }
}

/** The lane's store for one service: tables created once, then reused. */
export function bankfeedStore(service: ApplicationService): BankfeedStore {
  return sliceState(service, "bankfeed.store", (db) => {
    migrate(db, "bankfeed", BANKFEED_MIGRATIONS);
    return new BankfeedStore(db);
  });
}

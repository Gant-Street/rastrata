import type { BankAccountOffer, BankKind, BankState } from "../../agent/bank-wire.ts";
import type { HeldTransaction } from "../../banks/normalise.ts";
import type { ApplicationService } from "../../service.ts";
import type { ApplicationStore } from "../../storage.ts";
import { migrate, sliceState } from "../state.ts";

/** The banks slice's product state: which accounts a bank connection has brought, which chart account each is booked to and from which day, how far each has been read,
 * and the transactions that could not be read exactly. The money itself lives in the ledger and in the Inbox.
 *
 * **Nothing here is secret, and no transaction is kept here.** The connection to the bank, and the key that reads it, are the control plane's (docs/reference/program/
 * hosting/bankfeed-stripe.md); a pod holds only the account's name, the bank's name and the last four digits that Stripe gives, all already bounded text. */

export const BANKS_MIGRATIONS: readonly string[] = [
  `CREATE TABLE banks_accounts (
    account_id TEXT PRIMARY KEY,
    institution TEXT NOT NULL,
    name TEXT NOT NULL,
    last4 TEXT,
    kind TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'inactive', 'disconnected')),
    ledger_account_id TEXT UNIQUE,
    start_on TEXT,
    booked_at TEXT,
    booked_by TEXT,
    first_seen_at TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    last_received_at TEXT,
    refresh_id TEXT,
    queued_lines INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE banks_held (
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

export interface BankAccountRow {
  readonly accountId: string;
  readonly institution: string;
  readonly name: string;
  readonly last4: string | null;
  readonly kind: BankKind;
  readonly state: BankState;
  readonly ledgerAccountId: string | null;
  readonly startOn: string | null;
  readonly bookedAt: string | null;
  readonly bookedBy: string | null;
  readonly firstSeenAt: string;
  readonly seenAt: string;
  readonly lastReceivedAt: string | null;
  readonly refreshId: string | null;
  readonly queuedLines: number;
}

interface Row {
  account_id: string;
  institution: string;
  name: string;
  last4: string | null;
  kind: string;
  state: string;
  ledger_account_id: string | null;
  start_on: string | null;
  booked_at: string | null;
  booked_by: string | null;
  first_seen_at: string;
  seen_at: string;
  last_received_at: string | null;
  refresh_id: string | null;
  queued_lines: number;
}

const record = (row: Row): BankAccountRow => ({
  accountId: row.account_id,
  institution: row.institution,
  name: row.name,
  last4: row.last4,
  kind: row.kind as BankKind,
  state: row.state as BankState,
  ledgerAccountId: row.ledger_account_id,
  startOn: row.start_on,
  bookedAt: row.booked_at,
  bookedBy: row.booked_by,
  firstSeenAt: row.first_seen_at,
  seenAt: row.seen_at,
  lastReceivedAt: row.last_received_at,
  refreshId: row.refresh_id,
  queuedLines: row.queued_lines,
});

export interface HeldRow {
  readonly accountId: string;
  readonly key: string;
  readonly id: string | null;
  readonly postedOn: string | null;
  readonly reason: string;
}

export class BanksStore {
  constructor(private readonly db: ApplicationStore) {}

  transaction<T>(work: () => T): T {
    return this.db.transaction(work);
  }

  accounts(): BankAccountRow[] {
    return (
      this.db
        .query("SELECT * FROM banks_accounts ORDER BY institution, name, account_id")
        .all() as Row[]
    ).map(record);
  }

  account(accountId: string): BankAccountRow | null {
    const row = this.db
      .query("SELECT * FROM banks_accounts WHERE account_id = ?")
      .get(accountId) as Row | null;
    return row === null ? null : record(row);
  }

  /** The account booked to a chart account, if one is. */
  byLedger(ledgerAccountId: string): BankAccountRow | null {
    const row = this.db
      .query("SELECT * FROM banks_accounts WHERE ledger_account_id = ?")
      .get(ledgerAccountId) as Row | null;
    return row === null ? null : record(row);
  }

  /** Remember an account as the connection describes it now. What the owner chose (the chart account and the first day) is never touched. */
  upsert(offer: BankAccountOffer, at: string): void {
    this.db
      .query(
        `INSERT INTO banks_accounts (account_id, institution, name, last4, kind, state, first_seen_at, seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           institution = excluded.institution, name = excluded.name, last4 = excluded.last4,
           kind = excluded.kind, state = excluded.state, seen_at = excluded.seen_at`,
      )
      .run(offer.id, offer.institution, offer.name, offer.last4, offer.kind, offer.state, at, at);
  }

  book(
    accountId: string,
    booking: { ledgerAccountId: string; startOn: string; at: string; by: string },
  ): void {
    this.db
      .query(
        `UPDATE banks_accounts SET ledger_account_id = ?, start_on = ?,
           booked_at = COALESCE(booked_at, ?), booked_by = COALESCE(booked_by, ?)
         WHERE account_id = ?`,
      )
      .run(booking.ledgerAccountId, booking.startOn, booking.at, booking.by, accountId);
  }

  unbook(accountId: string): void {
    this.db
      .query(
        `UPDATE banks_accounts SET ledger_account_id = NULL, start_on = NULL, booked_at = NULL, booked_by = NULL
         WHERE account_id = ?`,
      )
      .run(accountId);
  }

  recordReceived(
    accountId: string,
    received: { at: string; refreshId: string; queued: number },
  ): void {
    this.db
      .query(
        `UPDATE banks_accounts SET last_received_at = ?, refresh_id = ?, queued_lines = queued_lines + ?
         WHERE account_id = ?`,
      )
      .run(received.at, received.refreshId, received.queued, accountId);
  }

  /** Transactions that could not be read exactly: remembered, with the reason, until a later call carries them readable. */
  hold(accountId: string, held: readonly HeldTransaction[], at: string): void {
    for (const item of held)
      this.db
        .query(
          `INSERT INTO banks_held (account_id, key, tx_id, posted_on, reason, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(account_id, key) DO UPDATE SET posted_on = excluded.posted_on, reason = excluded.reason, last_seen_at = excluded.last_seen_at`,
        )
        .run(accountId, item.key, item.id, item.postedOn, item.reason.slice(0, 300), at, at);
  }

  releaseHeld(accountId: string, keys: readonly string[]): void {
    for (const key of keys)
      this.db.query("DELETE FROM banks_held WHERE account_id = ? AND key = ?").run(accountId, key);
  }

  held(limit: number): HeldRow[] {
    return (
      this.db
        .query(
          "SELECT account_id, key, tx_id, posted_on, reason FROM banks_held ORDER BY first_seen_at, account_id, key LIMIT ?",
        )
        .all(limit) as {
        account_id: string;
        key: string;
        tx_id: string | null;
        posted_on: string | null;
        reason: string;
      }[]
    ).map((row) => ({
      accountId: row.account_id,
      key: row.key,
      id: row.tx_id,
      postedOn: row.posted_on,
      reason: row.reason,
    }));
  }

  heldCount(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM banks_held").get() as { n: number }).n;
  }
}

export function banksStore(service: ApplicationService): BanksStore {
  return sliceState(service, "banks.store", (db) => {
    migrate(db, "banks", BANKS_MIGRATIONS);
    return new BanksStore(db);
  });
}

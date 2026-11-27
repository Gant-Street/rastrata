import type { PayoutState } from "../../stripe/connector.ts";
import type { TaxResolution } from "../../stripe/tax.ts";
import type { ApplicationService } from "../../service.ts";
import type { ApplicationStore } from "../../storage.ts";
import { migrate, sliceState } from "../state.ts";

/** The Stripe lane's product state. Everything here is bookkeeping about the connection (settings,
 * the cursor, which transactions are known and which payout covers them, payouts and how each was
 * booked, tax figures, sync history); the money itself lives in the ledger and in the Inbox.
 * Amounts are decimal strings of hundredths so a bigint survives SQLite.
 *
 * Provider identifiers are hard uniqueness keys: a balance transaction, a payout and a payment
 * intent's tax figure each appear at most once, whatever happens twice. */

export const STRIPE_MIGRATIONS: readonly string[] = [
  `CREATE TABLE stripe_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    body TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE stripe_connection (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    account_id TEXT,
    default_currency TEXT,
    time_zone TEXT,
    cursor TEXT,
    through TEXT,
    balance_body TEXT,
    balance_read_at TEXT
  );
  CREATE TABLE stripe_transactions (
    id TEXT PRIMARY KEY,
    created INTEGER NOT NULL,
    currency TEXT NOT NULL,
    category TEXT NOT NULL,
    net_cents TEXT,
    handling TEXT NOT NULL CHECK (handling IN ('event', 'held', 'none', 'unusable')),
    payout TEXT,
    reason TEXT,
    tax_flag TEXT
  );
  CREATE INDEX stripe_transactions_created ON stripe_transactions (created);
  CREATE TABLE stripe_payouts (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    amount_cents TEXT NOT NULL,
    currency TEXT NOT NULL,
    created_on TEXT NOT NULL,
    arrival_on TEXT NOT NULL,
    status TEXT NOT NULL,
    automatic INTEGER NOT NULL,
    reconciliation_status TEXT NOT NULL,
    reversed INTEGER NOT NULL DEFAULT 0,
    member_count INTEGER,
    member_net_cents TEXT,
    verified TEXT NOT NULL DEFAULT 'unverified'
      CHECK (verified IN ('verified', 'mismatch', 'unverified', 'not_applicable')),
    verified_at TEXT
  );
  CREATE INDEX stripe_payouts_arrival ON stripe_payouts (arrival_on);
  CREATE TABLE stripe_tax (
    payment_intent TEXT PRIMARY KEY,
    body TEXT NOT NULL
  );
  CREATE TABLE stripe_runs (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    disposition TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    pages INTEGER NOT NULL DEFAULT 0,
    transactions INTEGER NOT NULL DEFAULT 0,
    new_lines INTEGER NOT NULL DEFAULT 0,
    duplicate_lines INTEGER NOT NULL DEFAULT 0,
    held_lines INTEGER NOT NULL DEFAULT 0,
    through TEXT,
    error_code TEXT,
    error_message TEXT,
    notes TEXT NOT NULL DEFAULT '[]',
    seq INTEGER NOT NULL
  )`,
  // 2: one entry per payout (the A2X convention). A transaction is known, and is covered once the
  // payout that paid it out has been booked; a payout records how it was booked and why. The
  // earlier per-transaction rows are dropped (nothing in the Inbox depended on them yet) and the
  // window cursor is reset so the next sync reads everything again.
  `DROP TABLE stripe_transactions;
  CREATE TABLE stripe_transactions (
    id TEXT PRIMARY KEY,
    created INTEGER NOT NULL,
    currency TEXT NOT NULL,
    category TEXT NOT NULL,
    net_cents TEXT,
    payout TEXT,
    covered INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX stripe_transactions_created ON stripe_transactions (created);
  CREATE INDEX stripe_transactions_unpaid ON stripe_transactions (covered, currency);
  ALTER TABLE stripe_payouts ADD COLUMN booking TEXT NOT NULL DEFAULT 'waiting';
  ALTER TABLE stripe_payouts ADD COLUMN booking_reason TEXT;
  ALTER TABLE stripe_payouts ADD COLUMN held_kind TEXT;
  ALTER TABLE stripe_payouts ADD COLUMN members_sha256 TEXT;
  ALTER TABLE stripe_payouts ADD COLUMN tax_not_reported INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE stripe_payouts ADD COLUMN refund_not_split INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE stripe_payouts ADD COLUMN adjustments INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE stripe_runs ADD COLUMN payouts INTEGER NOT NULL DEFAULT 0;
  UPDATE stripe_connection SET cursor = NULL, through = NULL`,
  // 3: the mode (live or test) the books have read, learned once like the account and never changed; and the Stripe account the control plane has connected for this
  // workspace, if the owner connected one (the button), so that the books can say so and refuse another account at once.
  `ALTER TABLE stripe_connection ADD COLUMN mode TEXT CHECK (mode IN ('live', 'test'));
  ALTER TABLE stripe_connection ADD COLUMN link_account TEXT;
  ALTER TABLE stripe_connection ADD COLUMN link_live INTEGER;
  ALTER TABLE stripe_connection ADD COLUMN linked_at TEXT`,
];

export type StripeMode = "live" | "test";

export interface ConnectionRow {
  readonly accountId: string | null;
  readonly defaultCurrency: string | null;
  readonly timeZone: string | null;
  readonly cursor: string | null;
  readonly through: string | null;
  readonly balanceBody: string | null;
  readonly balanceReadAt: string | null;
  /** The mode of the first Stripe data these books read; every later read must be the same. */
  readonly mode: StripeMode | null;
  /** The Stripe account the owner connected with the button, and its mode, and since when; null while none is. */
  readonly linkAccount: string | null;
  readonly linkLive: boolean | null;
  readonly linkedAt: string | null;
}

export interface TransactionRow {
  readonly id: string;
  readonly created: number;
  readonly currency: string;
  readonly category: string;
  readonly netCents: bigint | null;
  readonly payout: string | null;
}

export type PayoutVerification = "verified" | "mismatch" | "unverified" | "not_applicable";

export interface PayoutRow {
  readonly id: string;
  readonly amountCents: bigint;
  readonly currency: string;
  readonly createdOn: string;
  readonly arrivalOn: string;
  readonly status: string;
  readonly automatic: boolean;
  readonly reconciliationStatus: string;
  readonly reversed: boolean;
  readonly memberCount: number | null;
  readonly memberNetCents: bigint | null;
  readonly booking: PayoutState;
  readonly bookingReason: string | null;
  readonly heldKind: string | null;
  readonly membersSha256: string | null;
}

export interface RunRow {
  readonly id: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly disposition: "running" | "complete" | "more" | "interrupted" | "failed";
  readonly requests: number;
  readonly pages: number;
  readonly transactions: number;
  readonly newLines: number;
  readonly duplicateLines: number;
  readonly heldLines: number;
  readonly payouts: number;
  readonly through: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly notes: readonly string[];
}

type Raw = Record<string, unknown>;
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const big = (value: unknown): bigint | null => (typeof value === "string" ? BigInt(value) : null);

const payoutFrom = (row: Raw): PayoutRow => ({
  id: String(row.id),
  amountCents: BigInt(String(row.amount_cents)),
  currency: String(row.currency),
  createdOn: String(row.created_on),
  arrivalOn: String(row.arrival_on),
  status: String(row.status),
  automatic: row.automatic === 1,
  reconciliationStatus: String(row.reconciliation_status),
  reversed: row.reversed === 1,
  memberCount: typeof row.member_count === "number" ? row.member_count : null,
  memberNetCents: big(row.member_net_cents),
  booking: String(row.booking) as PayoutState,
  bookingReason: text(row.booking_reason),
  heldKind: text(row.held_kind),
  membersSha256: text(row.members_sha256),
});

const runFrom = (row: Raw): RunRow => ({
  id: String(row.id),
  startedAt: String(row.started_at),
  finishedAt: text(row.finished_at),
  disposition: String(row.disposition) as RunRow["disposition"],
  requests: Number(row.requests),
  pages: Number(row.pages),
  transactions: Number(row.transactions),
  newLines: Number(row.new_lines),
  duplicateLines: Number(row.duplicate_lines),
  heldLines: Number(row.held_lines),
  payouts: Number(row.payouts ?? 0),
  through: text(row.through),
  errorCode: text(row.error_code),
  errorMessage: text(row.error_message),
  notes: JSON.parse(String(row.notes ?? "[]")) as string[],
});

/** Tax figures hold bigints, which JSON cannot: they travel as decimal strings. */
export function encodeTax(value: TaxResolution): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? `${v}n` : v));
}
export function decodeTax(body: string): TaxResolution {
  return JSON.parse(body, (_key, v) =>
    typeof v === "string" && /^-?[0-9]+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
  ) as TaxResolution;
}

export class StripeStore {
  constructor(private readonly db: ApplicationStore) {}

  // ----- settings -----
  settingsBody(): string | null {
    const row = this.db.query("SELECT body FROM stripe_settings WHERE id=1").get() as Raw | null;
    return row ? String(row.body) : null;
  }
  saveSettings(body: string, at: string): void {
    this.db
      .query(
        "INSERT INTO stripe_settings (id, body, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at",
      )
      .run(body, at);
  }

  // ----- the connection -----
  connection(): ConnectionRow {
    const row = this.db.query("SELECT * FROM stripe_connection WHERE id=1").get() as Raw | null;
    return {
      accountId: text(row?.account_id),
      defaultCurrency: text(row?.default_currency),
      timeZone: text(row?.time_zone),
      cursor: text(row?.cursor),
      through: text(row?.through),
      balanceBody: text(row?.balance_body),
      balanceReadAt: text(row?.balance_read_at),
      mode: row?.mode === "live" || row?.mode === "test" ? row.mode : null,
      linkAccount: text(row?.link_account),
      linkLive: row?.link_account == null ? null : Number(row?.link_live) === 1,
      linkedAt: text(row?.linked_at),
    };
  }
  private ensureConnection(): void {
    this.db.query("INSERT OR IGNORE INTO stripe_connection (id) VALUES (1)").run();
  }
  /** The account is learned once and never changes: it is part of every line's identity. */
  rememberAccount(
    accountId: string,
    defaultCurrency: string | null,
    timeZone: string | null,
  ): void {
    this.ensureConnection();
    this.db
      .query(
        "UPDATE stripe_connection SET account_id=COALESCE(account_id, ?), default_currency=?, time_zone=? WHERE id=1",
      )
      .run(accountId, defaultCurrency, timeZone);
  }
  /** The mode is learned once and never changes: test data and real data are never in the same books. */
  rememberMode(mode: StripeMode): void {
    this.ensureConnection();
    this.db.query("UPDATE stripe_connection SET mode=COALESCE(mode, ?) WHERE id=1").run(mode);
  }
  /** The Stripe account the control plane has connected for this workspace, or none. */
  saveLink(link: { readonly account: string; readonly live: boolean } | null, at: string): void {
    this.ensureConnection();
    if (link === null)
      this.db
        .query(
          "UPDATE stripe_connection SET link_account=NULL, link_live=NULL, linked_at=NULL WHERE id=1",
        )
        .run();
    else
      this.db
        .query("UPDATE stripe_connection SET link_account=?, link_live=?, linked_at=? WHERE id=1")
        .run(link.account, link.live ? 1 : 0, at);
  }
  saveCursor(cursor: string | null, through: string | null): void {
    this.ensureConnection();
    this.db
      .query("UPDATE stripe_connection SET cursor=?, through=COALESCE(?, through) WHERE id=1")
      .run(cursor, through);
  }
  saveBalance(body: string, readAt: string): void {
    this.ensureConnection();
    this.db
      .query("UPDATE stripe_connection SET balance_body=?, balance_read_at=? WHERE id=1")
      .run(body, readAt);
  }

  // ----- transactions -----
  isKnown(id: string): boolean {
    return this.db.query("SELECT 1 AS x FROM stripe_transactions WHERE id=?").get(id) !== null;
  }
  recordTransaction(row: TransactionRow): void {
    this.db
      .query(
        "INSERT OR IGNORE INTO stripe_transactions (id, created, currency, category, net_cents, payout, covered) VALUES (?, ?, ?, ?, ?, ?, 0)",
      )
      .run(
        row.id,
        row.created,
        row.currency,
        row.category,
        row.netCents === null ? null : row.netCents.toString(),
        row.payout,
      );
  }
  /** A payout's entry now covers this transaction (and it is known even if it predates the first
   * day: a payout carries what Stripe says it paid out). */
  markCovered(id: string, currency: string, netCents: bigint | null, at: number): void {
    this.db
      .query(
        `INSERT INTO stripe_transactions (id, created, currency, category, net_cents, payout, covered)
         VALUES (?, ?, ?, 'covered', ?, NULL, 1)
         ON CONFLICT(id) DO UPDATE SET covered=1`,
      )
      .run(id, at, currency, netCents === null ? null : netCents.toString());
  }
  /** Net of the transactions Rastrata knows that are not yet in a payout's entry: "in Stripe, not yet
   * paid out", in hundredths, and how many there are. */
  unpaid(currency: string): { readonly count: number; readonly netCents: bigint } {
    const rows = this.db
      .query(
        "SELECT net_cents FROM stripe_transactions WHERE covered=0 AND currency=? AND net_cents IS NOT NULL",
      )
      .all(currency) as Raw[];
    let total = 0n;
    for (const row of rows) total += BigInt(String(row.net_cents));
    return { count: rows.length, netCents: total };
  }
  transactionCount(): number {
    return Number((this.db.query("SELECT COUNT(*) AS n FROM stripe_transactions").get() as Raw).n);
  }

  // ----- payouts -----
  /** A payout seen only as Stripe's debit of the balance: enough to know it exists and to find it
   * again; the payout object itself fills in the rest. */
  noticePayout(id: string, amountCents: bigint, currency: string, createdOn: string): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO stripe_payouts (id, amount_cents, currency, created_on, arrival_on, status, automatic, reconciliation_status)
         VALUES (?, ?, ?, ?, ?, 'pending', 1, 'in_progress')`,
      )
      .run(id, amountCents.toString(), currency, createdOn, createdOn);
  }
  upsertPayout(
    row: Pick<
      PayoutRow,
      | "id"
      | "amountCents"
      | "currency"
      | "createdOn"
      | "arrivalOn"
      | "status"
      | "automatic"
      | "reconciliationStatus"
      | "reversed"
    >,
  ): void {
    this.db
      .query(
        `INSERT INTO stripe_payouts (id, amount_cents, currency, created_on, arrival_on, status, automatic, reconciliation_status, reversed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET amount_cents=excluded.amount_cents, status=excluded.status,
           arrival_on=excluded.arrival_on, automatic=excluded.automatic,
           reconciliation_status=excluded.reconciliation_status, reversed=excluded.reversed`,
      )
      .run(
        row.id,
        row.amountCents.toString(),
        row.currency,
        row.createdOn,
        row.arrivalOn,
        row.status,
        row.automatic ? 1 : 0,
        row.reconciliationStatus,
        row.reversed ? 1 : 0,
      );
  }
  recordPayoutOutcome(
    id: string,
    outcome: {
      readonly state: PayoutState;
      readonly reason: string | null;
      readonly memberCount: number | null;
      readonly memberNetCents: bigint | null;
      readonly membersSha256: string | null;
      readonly heldKind: string | null;
      readonly taxNotReported: number;
      readonly refundTaxNotSplit: number;
      readonly adjustments: number;
    },
  ): void {
    this.db
      .query(
        `UPDATE stripe_payouts SET booking=?, booking_reason=?, member_count=?, member_net_cents=?, members_sha256=?,
           held_kind=?, tax_not_reported=?, refund_not_split=?, adjustments=? WHERE id=?`,
      )
      .run(
        outcome.state,
        outcome.reason,
        outcome.memberCount,
        outcome.memberNetCents === null ? null : outcome.memberNetCents.toString(),
        outcome.membersSha256,
        outcome.heldKind,
        outcome.taxNotReported,
        outcome.refundTaxNotSplit,
        outcome.adjustments,
        id,
      );
  }
  payout(id: string): PayoutRow | null {
    const row = this.db.query("SELECT * FROM stripe_payouts WHERE id=?").get(id) as Raw | null;
    return row ? payoutFrom(row) : null;
  }
  payouts(): PayoutRow[] {
    return (
      this.db.query("SELECT * FROM stripe_payouts ORDER BY arrival_on DESC, id DESC").all() as Raw[]
    ).map(payoutFrom);
  }
  /** Payouts whose arrival date is in [from, to], for matching against deposits. */
  payoutsBetween(from: string, to: string): PayoutRow[] {
    return (
      this.db
        .query(
          "SELECT * FROM stripe_payouts WHERE arrival_on >= ? AND arrival_on <= ? ORDER BY arrival_on, id",
        )
        .all(from, to) as Raw[]
    ).map(payoutFrom);
  }
  /** Payouts still to be booked: not read yet, still being itemised by Stripe, or whose transactions
   * did not add up (looked at again, since Stripe may have finished itemising since). */
  pendingPayoutIds(): string[] {
    return (
      this.db
        .query(
          "SELECT id FROM stripe_payouts WHERE booking IN ('waiting', 'mismatch') ORDER BY arrival_on, id",
        )
        .all() as Raw[]
    ).map((row) => String(row.id));
  }
  /** The day (in the book's zone) each of those payouts was created on, by id. */
  pendingPayoutDays(): Map<string, string> {
    const days = new Map<string, string>();
    for (const row of this.db
      .query("SELECT id, created_on FROM stripe_payouts WHERE booking IN ('waiting', 'mismatch')")
      .all() as Raw[])
      days.set(String(row.id), String(row.created_on));
    return days;
  }
  /** Counts of what the payouts' bookings found, summed. */
  bookingTotals(): {
    readonly taxNotReported: number;
    readonly refundNotSplit: number;
    readonly adjustments: number;
    readonly held: number;
    readonly otherCurrency: number;
    readonly manual: number;
  } {
    const row = this.db
      .query(
        `SELECT COALESCE(SUM(tax_not_reported), 0) AS tax, COALESCE(SUM(refund_not_split), 0) AS refunds,
           COALESCE(SUM(adjustments), 0) AS adjustments,
           COALESCE(SUM(CASE WHEN booking='held' THEN 1 ELSE 0 END), 0) AS held,
           COALESCE(SUM(CASE WHEN held_kind='other_currency' THEN 1 ELSE 0 END), 0) AS other_ccy,
           COALESCE(SUM(CASE WHEN held_kind='manual' THEN 1 ELSE 0 END), 0) AS manual
         FROM stripe_payouts`,
      )
      .get() as Raw;
    return {
      taxNotReported: Number(row.tax),
      refundNotSplit: Number(row.refunds),
      adjustments: Number(row.adjustments),
      held: Number(row.held),
      otherCurrency: Number(row.other_ccy),
      manual: Number(row.manual),
    };
  }
  /** A short string that changes whenever a payout is added or changes how it matches. */
  payoutRevision(): string {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS n, COALESCE(MAX(seq), 0) AS last,
           COALESCE(SUM(reversed), 0) AS reversed,
           COALESCE(SUM(CASE WHEN booking='summarised' THEN 1 ELSE 0 END), 0) AS booked
         FROM stripe_payouts`,
      )
      .get() as Raw;
    return `${row.n}.${row.last}.${row.reversed}.${row.booked}`;
  }

  // ----- tax figures -----
  taxGet(paymentIntent: string): TaxResolution | undefined {
    const row = this.db
      .query("SELECT body FROM stripe_tax WHERE payment_intent=?")
      .get(paymentIntent) as Raw | null;
    return row ? decodeTax(String(row.body)) : undefined;
  }
  taxSet(paymentIntent: string, value: TaxResolution): void {
    this.db
      .query("INSERT OR IGNORE INTO stripe_tax (payment_intent, body) VALUES (?, ?)")
      .run(paymentIntent, encodeTax(value));
  }

  // ----- runs -----
  startRun(id: string, startedAt: string): void {
    const next = (
      this.db.query("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM stripe_runs").get() as Raw
    ).n;
    this.db
      .query(
        "INSERT INTO stripe_runs (id, started_at, disposition, seq) VALUES (?, ?, 'running', ?) ON CONFLICT(id) DO NOTHING",
      )
      .run(id, startedAt, next as number);
  }
  finishRun(run: RunRow): void {
    this.db
      .query(
        `UPDATE stripe_runs SET finished_at=?, disposition=?, requests=?, pages=?, transactions=?, new_lines=?,
           duplicate_lines=?, held_lines=?, payouts=?, through=?, error_code=?, error_message=?, notes=? WHERE id=?`,
      )
      .run(
        run.finishedAt,
        run.disposition,
        run.requests,
        run.pages,
        run.transactions,
        run.newLines,
        run.duplicateLines,
        run.heldLines,
        run.payouts,
        run.through,
        run.errorCode,
        run.errorMessage,
        JSON.stringify(run.notes),
        run.id,
      );
  }
  run(id: string): RunRow | null {
    const row = this.db.query("SELECT * FROM stripe_runs WHERE id=?").get(id) as Raw | null;
    return row ? runFrom(row) : null;
  }
  /** The latest reading as one run: its last call, and the calls before it that belonged to the same pull (each said it had more to do), added up. A person is told what was read, not what
   * the last of forty calls did. */
  lastRead(): RunRow | null {
    for (const limit of [60, 2000]) {
      const rows = this.runs(limit);
      const last = rows[0];
      if (!last) return null;
      let read = last;
      let ended = false;
      for (const earlier of rows.slice(1)) {
        if (earlier.disposition !== "more") {
          ended = true;
          break;
        }
        read = {
          ...read,
          startedAt: earlier.startedAt,
          requests: read.requests + earlier.requests,
          pages: read.pages + earlier.pages,
          transactions: read.transactions + earlier.transactions,
          newLines: read.newLines + earlier.newLines,
          duplicateLines: read.duplicateLines + earlier.duplicateLines,
          heldLines: read.heldLines + earlier.heldLines,
          payouts: read.payouts + earlier.payouts,
        };
      }
      if (ended || rows.length < limit) return read;
    }
    return null;
  }
  runs(limit: number): RunRow[] {
    return (
      this.db.query("SELECT * FROM stripe_runs ORDER BY seq DESC LIMIT ?").all(limit) as Raw[]
    ).map(runFrom);
  }

  transaction<T>(work: () => T): T {
    return this.db.transaction(work);
  }
}

/** The lane's store for one service: tables created once, then reused. */
export function stripeStore(service: ApplicationService): StripeStore {
  return sliceState(service, "stripe.store", (db) => {
    migrate(db, "stripe", STRIPE_MIGRATIONS);
    return new StripeStore(db);
  });
}

import { SQL } from "bun";
import {
  GENESIS_HASH,
  type AcquireResult,
  type AdoptResult,
  type AdoptState,
  type AppendInput,
  type AppendResult,
  type LeaseGrant,
  type LogTier,
  type RenewResult,
  type SealManifest,
  type SealResult,
  type TailEntry,
  type TierCapabilities,
  type TierHead,
  type TierPage,
} from "./tier.ts";
import { ObjectStoreUncertain } from "./objectstore.ts";

export interface PostgresTierOptions {
  /** Connections in the pool (default 4). */
  readonly max?: number;
  /** Create the two tables if they are not there (default true). */
  readonly createSchema?: boolean;
  /** Seconds before a statement is abandoned (default 10). */
  readonly timeoutSeconds?: number;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS book_log (
    book_id text NOT NULL,
    seq bigint NOT NULL,
    prev_hash text NOT NULL,
    hash text NOT NULL,
    fence bigint NOT NULL,
    body bytea NOT NULL,
    written_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (book_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS book_head (
    book_id text PRIMARY KEY,
    seq bigint NOT NULL DEFAULT 0,
    hash text NOT NULL DEFAULT repeat('0', 64),
    sealed_through bigint NOT NULL DEFAULT 0,
    sealed_hash text NOT NULL DEFAULT repeat('0', 64),
    fence bigint NOT NULL DEFAULT 0,
    lease_holder text,
    lease_expires_at timestamptz,
    last_seal jsonb
  )`,
];

/** A head as one row: the lease fields are given only while the lease is live on the database's
 * clock, and `now_ms` is that clock. Every statement that returns a head returns these columns. */
const HEAD_COLUMNS = `
  seq, hash, sealed_through, sealed_hash, fence,
  CASE WHEN lease_holder IS NOT NULL AND lease_expires_at > clock_timestamp() THEN lease_holder END AS lease_holder,
  CASE WHEN lease_holder IS NOT NULL AND lease_expires_at > clock_timestamp()
       THEN floor(extract(epoch from lease_expires_at) * 1000) END AS lease_expires_ms,
  floor(extract(epoch from clock_timestamp()) * 1000) AS now_ms`;

type Row = Record<string, unknown>;

const num = (value: unknown): number => Number(value);

function headOf(row: Row | undefined): TierHead {
  if (!row)
    return {
      seq: 0,
      hash: GENESIS_HASH,
      sealedThrough: 0,
      sealedHash: GENESIS_HASH,
      fence: 0,
      leaseHolder: null,
      leaseExpiresAt: null,
      now: Date.now(),
    };
  return {
    seq: num(row.seq),
    hash: String(row.hash),
    sealedThrough: num(row.sealed_through),
    sealedHash: String(row.sealed_hash),
    fence: num(row.fence),
    leaseHolder:
      row.lease_holder === null || row.lease_holder === undefined ? null : String(row.lease_holder),
    leaseExpiresAt:
      row.lease_expires_ms === null || row.lease_expires_ms === undefined
        ? null
        : num(row.lease_expires_ms),
    now: num(row.now_ms),
  };
}

/** The tail in Postgres. One head row per book and one row per unsealed entry. An append is one
 * statement: a conditional update of the head row (the next sequence, the previous hash, the current
 * fence) and the insert of the entry, which commit together or not at all. Leases are decided by the
 * database's clock, so no process's clock can shorten or lengthen one. */
export class PostgresLogTier implements LogTier {
  readonly capabilities: TierCapabilities = { name: "postgres", leases: true };
  readonly #sql: SQL;

  private constructor(sql: SQL) {
    this.#sql = sql;
  }

  static async connect(url: string, options: PostgresTierOptions = {}): Promise<PostgresLogTier> {
    const sql = new SQL(url, {
      max: options.max ?? 4,
      idleTimeout: 30,
      connectionTimeout: options.timeoutSeconds ?? 10,
    });
    if (options.createSchema !== false) {
      // Processes that start together would race to make the same tables (CREATE TABLE IF NOT EXISTS is
      // not safe against itself in Postgres: of two at once, one can fail on the catalog), so they take
      // turns, by an advisory lock that is held to the end of the transaction.
      await sql.begin(async (tx) => {
        await tx.unsafe("SELECT pg_advisory_xact_lock(7470021)");
        for (const statement of SCHEMA) await tx.unsafe(statement);
      });
    }
    return new PostgresLogTier(sql);
  }

  async close(): Promise<void> {
    await this.#sql.close();
  }

  /** Remove every row (tests and experiments on a scratch database). */
  async truncate(): Promise<void> {
    await this.#sql.unsafe("TRUNCATE book_log, book_head");
  }

  async #query(statement: string, params: readonly unknown[]): Promise<Row[]> {
    try {
      return (await this.#sql.unsafe(statement, params as never[])) as Row[];
    } catch (error) {
      // A connection that fails mid-statement leaves the outcome unknown.
      throw new ObjectStoreUncertain(
        `postgres: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async head(book: string): Promise<TierHead> {
    const rows = await this.#query(`SELECT ${HEAD_COLUMNS} FROM book_head WHERE book_id = $1`, [
      book,
    ]);
    if (rows.length === 0) {
      const now = await this.#query(
        "SELECT floor(extract(epoch from clock_timestamp()) * 1000) AS now_ms",
        [],
      );
      return { ...headOf(undefined), now: num(now[0]?.now_ms) };
    }
    return headOf(rows[0]);
  }

  async readFrom(book: string, seq: number, limit?: number): Promise<TierPage> {
    const rows = await this.#query(
      `SELECT seq, prev_hash, hash, fence, body, floor(extract(epoch from written_at) * 1000) AS written_ms
         FROM book_log WHERE book_id = $1 AND seq >= $2::bigint ORDER BY seq LIMIT $3::bigint`,
      [book, seq, limit ?? 1_000_000],
    );
    const entries: TailEntry[] = rows.map((row) => ({
      seq: num(row.seq),
      prevHash: String(row.prev_hash),
      hash: String(row.hash),
      fence: num(row.fence),
      body: new Uint8Array(row.body as Uint8Array),
      writtenAt: num(row.written_ms),
    }));
    // The head is read after the entries, so it is never behind them.
    return { entries, head: await this.head(book) };
  }

  async append(book: string, input: AppendInput): Promise<AppendResult> {
    const moved = await this.#query(
      `WITH moved AS (
         UPDATE book_head SET seq = $2::bigint, hash = $4
          WHERE book_id = $1 AND $5::bigint > 0 AND fence = $5::bigint AND seq = $2::bigint - 1 AND hash = $3
          RETURNING *
       ), written AS (
         INSERT INTO book_log (book_id, seq, prev_hash, hash, fence, body)
         SELECT $1, $2::bigint, $3, $4, $5::bigint, $6::bytea FROM moved
         RETURNING seq
       )
       SELECT ${HEAD_COLUMNS} FROM moved`,
      [book, input.seq, input.prevHash, input.hash, input.fence, input.body],
    );
    if (moved.length === 1) return { ok: true, duplicate: false, head: headOf(moved[0]) };
    // Not appended. Find out why, from the head as it is now.
    const head = await this.head(book);
    if (input.fence <= 0 || input.fence !== head.fence) return { ok: false, reason: "fence", head };
    if (input.seq === head.seq && input.hash === head.hash)
      return { ok: true, duplicate: true, head };
    if (input.seq !== head.seq + 1) return { ok: false, reason: "seq", head };
    return { ok: false, reason: "prev", head };
  }

  async acquire(book: string, holder: string, ttlMs: number): Promise<AcquireResult> {
    const take = `UPDATE book_head SET
         fence = CASE WHEN lease_holder = $2 AND lease_expires_at > clock_timestamp() THEN fence ELSE fence + 1 END,
         lease_holder = $2,
         lease_expires_at = clock_timestamp() + ($3::text || ' milliseconds')::interval
       WHERE book_id = $1
         AND (lease_holder IS NULL OR lease_expires_at <= clock_timestamp() OR lease_holder = $2)
       RETURNING ${HEAD_COLUMNS}`;
    let rows = await this.#query(take, [book, holder, String(ttlMs)]);
    if (rows.length === 0) {
      await this.#query("INSERT INTO book_head (book_id) VALUES ($1) ON CONFLICT DO NOTHING", [
        book,
      ]);
      rows = await this.#query(take, [book, holder, String(ttlMs)]);
    }
    if (rows.length === 1) return { ok: true, lease: this.#grant(rows[0] as Row, holder, ttlMs) };
    const held = await this.#query(
      `SELECT ${HEAD_COLUMNS},
              (SELECT lease_holder FROM book_head WHERE book_id = $1) AS holder,
              floor(extract(epoch from (SELECT lease_expires_at FROM book_head WHERE book_id = $1) - clock_timestamp()) * 1000) AS remaining_ms
         FROM book_head WHERE book_id = $1`,
      [book],
    );
    const row = held[0] as Row;
    return {
      ok: false,
      heldBy: String(row.holder),
      expiresInMs: Math.max(0, num(row.remaining_ms)),
      head: headOf(row),
    };
  }

  #grant(row: Row, holder: string, ttlMs: number): LeaseGrant {
    const head = headOf(row);
    return {
      holder,
      fence: head.fence,
      ttlMs,
      expiresAt: head.leaseExpiresAt ?? head.now + ttlMs,
      head,
    };
  }

  async renew(
    book: string,
    lease: { readonly holder: string; readonly fence: number },
    ttlMs: number,
  ): Promise<RenewResult> {
    const rows = await this.#query(
      `UPDATE book_head SET lease_expires_at = clock_timestamp() + ($4::text || ' milliseconds')::interval
        WHERE book_id = $1 AND lease_holder = $2 AND fence = $3::bigint AND lease_expires_at > clock_timestamp()
        RETURNING ${HEAD_COLUMNS}`,
      [book, lease.holder, lease.fence, String(ttlMs)],
    );
    if (rows.length === 1)
      return { ok: true, lease: this.#grant(rows[0] as Row, lease.holder, ttlMs) };
    const current = await this.#query(
      `SELECT ${HEAD_COLUMNS}, (SELECT lease_holder FROM book_head WHERE book_id = $1) AS holder,
              (SELECT fence FROM book_head WHERE book_id = $1) AS current_fence
         FROM book_head WHERE book_id = $1`,
      [book],
    );
    const row = current[0];
    const stillOurs =
      row && String(row.holder) === lease.holder && num(row.current_fence) === lease.fence;
    return { ok: false, reason: stillOurs ? "expired" : "taken", head: headOf(row) };
  }

  async release(
    book: string,
    lease: { readonly holder: string; readonly fence: number },
  ): Promise<void> {
    await this.#query(
      `UPDATE book_head SET fence = fence + 1, lease_holder = NULL, lease_expires_at = clock_timestamp()
        WHERE book_id = $1 AND lease_holder = $2 AND fence = $3::bigint`,
      [book, lease.holder, lease.fence],
    );
  }

  /** An operator's step (see {@link LogTier.adopt}). One statement: the head is made only if the book has
   * no entries here, and an empty head (left by a lease taken and given back, say) is overwritten only if
   * nothing is sealed and no lease is live. */
  async adopt(book: string, state: AdoptState): Promise<AdoptResult> {
    const rows = await this.#query(
      `INSERT INTO book_head (book_id, seq, hash, sealed_through, sealed_hash, fence)
       SELECT $1, $2::bigint, $3, $2::bigint, $3, $4::bigint
        WHERE NOT EXISTS (SELECT 1 FROM book_log WHERE book_id = $1)
       ON CONFLICT (book_id) DO UPDATE SET
         seq = EXCLUDED.seq, hash = EXCLUDED.hash, sealed_through = EXCLUDED.sealed_through,
         sealed_hash = EXCLUDED.sealed_hash, fence = GREATEST(book_head.fence, EXCLUDED.fence),
         lease_holder = NULL, lease_expires_at = NULL
        WHERE book_head.seq = 0 AND book_head.sealed_through = 0
          AND (book_head.lease_holder IS NULL OR book_head.lease_expires_at <= clock_timestamp())
       RETURNING ${HEAD_COLUMNS}`,
      [book, state.seq, state.hash, state.fence],
    );
    if (rows.length === 1) return { ok: true, head: headOf(rows[0]) };
    return { ok: false, reason: "not_empty", head: await this.head(book) };
  }

  async seal(
    book: string,
    input: { readonly upTo: number; readonly manifest: SealManifest },
  ): Promise<SealResult> {
    const rows = await this.#query(
      `WITH moved AS (
         UPDATE book_head SET sealed_through = $2::bigint, sealed_hash = $3, last_seal = $4::jsonb
          WHERE book_id = $1 AND sealed_through < $2::bigint AND seq >= $2::bigint
          RETURNING book_id
       ), trimmed AS (
         DELETE FROM book_log WHERE book_id = $1 AND seq <= $2::bigint AND EXISTS (SELECT 1 FROM moved)
         RETURNING seq
       )
       SELECT (SELECT count(*) FROM moved) AS moved, (SELECT count(*) FROM trimmed) AS trimmed`,
      [book, input.upTo, input.manifest.lastHash, JSON.stringify(input.manifest)],
    );
    const head = await this.head(book);
    if (num(rows[0]?.moved) === 1) return { ok: true, trimmed: num(rows[0]?.trimmed), head };
    if (input.upTo > head.seq) return { ok: false, reason: "ahead", head };
    return { ok: true, trimmed: 0, head };
  }
}

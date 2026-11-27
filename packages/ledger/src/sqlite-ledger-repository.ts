import { createHash } from "node:crypto";
import { decodeBookOutcome, decodeStoredBookOutcome } from "@rastrata/kernel";
import { completeScope } from "./compact-records.ts";
import { requireLedger, type CompleteBookScope } from "./records.ts";
import { atomicSqlite } from "./sqlite-transaction.ts";
import type { SqlBinding, SqliteStorage } from "./sqlite.ts";
import { SerialLedgerQueue, type LedgerQueueLimits } from "./serial-ledger-queue.ts";
import { decodeStoredNativeOutcome, encodeStoredNativeOutcome } from "./native-outcome-storage.ts";
import type {
  NativeLedgerRepository,
  NativeLedgerReader,
  NativeLedgerHead,
  NativeLedgerFact,
  NativeLedgerOutcome,
  NativeOutcomePage,
  NativeFactPage,
  NativeLedgerTransaction,
  NativeLedgerTransactionResult,
  OutcomeDecoding,
} from "./native-ledger-repository.ts";
export type {
  NativeLedgerHead,
  NativeLedgerFact,
  NativeLedgerOutcome,
  NativeLedgerDecision,
  NativeOutcomePage,
  NativeFactPage,
  NativeLedgerTransaction,
  NativeLedgerTransactionResult,
  OutcomeDecoding,
} from "./native-ledger-repository.ts";

import { NATIVE_LEDGER_FORMAT } from "./native-ledger-repository.ts";
export { NATIVE_LEDGER_FORMAT } from "./native-ledger-repository.ts";
const FORMAT = NATIVE_LEDGER_FORMAT;
const MAX_BYTES = 1_048_576;
const MAX_SEQUENCE = (1n << 63n) - 1n;
const HASH = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

async function publicationReadiness(
  prepare: () => Promise<void>,
): Promise<{ readonly error: unknown } | null> {
  try {
    await prepare();
    return null;
  } catch (error) {
    return { error };
  }
}

function bounded(text: unknown, maximum = MAX_BYTES): asserts text is string {
  requireLedger(
    typeof text === "string" &&
      text.length <= maximum &&
      encoder.encode(text).byteLength <= maximum,
    "native_ledger_invalid_input",
  );
}
function key(collection: string, id: string): string {
  requireLedger(/^[A-Za-z][A-Za-z0-9.]{0,127}$/.test(collection), "native_ledger_invalid_input");
  bounded(id, 1024);
  requireLedger(id.length > 0, "native_ledger_invalid_input");
  return JSON.stringify([collection, id]);
}
function head(encoded: unknown): NativeLedgerHead {
  bounded(encoded, 512);
  const value = JSON.parse(encoded);
  requireLedger(
    value &&
      Object.keys(value).sort().join(",") === "bookRevision,chainHash,sequence" &&
      typeof value.sequence === "string" &&
      /^(0|[1-9][0-9]{0,18})$/.test(value.sequence) &&
      typeof value.bookRevision === "string" &&
      /^(0|[1-9][0-9]{0,18})$/.test(value.bookRevision) &&
      BigInt(value.sequence) <= MAX_SEQUENCE &&
      BigInt(value.bookRevision) <= BigInt(value.sequence) &&
      typeof value.chainHash === "string" &&
      HASH.test(value.chainHash) &&
      JSON.stringify({
        sequence: value.sequence,
        bookRevision: value.bookRevision,
        chainHash: value.chainHash,
      }) === encoded,
    "native_ledger_head_corrupt",
  );
  return Object.freeze(value);
}

/** SQLite persistence boundary, not accounting admission or a public command API.
 * The trusted ledger supplies a synchronous kernel decision. SQLite owns indexes,
 * atomicity and rollback. No cache, custom pages, construction pins or per-helper
 * transactions. Existing snapshot/indexed formats are never adopted implicitly.
 * Row checksums detect changed bytes on access; a full audit and independently
 * authorized restore head remain separate from ordinary transaction admission. */
export class SqliteLedgerRepository implements NativeLedgerRepository, NativeLedgerReader {
  readonly scope: CompleteBookScope;
  private readonly scopeText: string;
  private readonly scopeHash: string;
  private readonly queue: SerialLedgerQueue;
  constructor(
    private readonly storage: SqliteStorage,
    scope: CompleteBookScope,
    objectId: string,
    private readonly authority: () => { readonly fence: string; readonly pending: boolean },
    queueLimits?: LedgerQueueLimits,
  ) {
    this.scope = completeScope(scope, objectId);
    this.scopeText = JSON.stringify(this.scope);
    this.scopeHash = digest(this.scopeText);
    this.queue = new SerialLedgerQueue(queueLimits);
  }
  private rows(sql: string, ...bindings: SqlBinding[]) {
    return Array.from(this.storage.sql.exec(sql, ...bindings));
  }
  private fence(): string {
    const value = this.authority();
    requireLedger(
      value &&
        value.pending === false &&
        typeof value.fence === "string" &&
        /^(0|[1-9][0-9]{0,63})$/.test(value.fence),
      "native_ledger_authority_unavailable",
    );
    return value.fence;
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    return this.queue.run(work);
  }
  private current(): NativeLedgerHead {
    const rows = this.rows(
      "SELECT substr(b.format,1,128) AS format, CASE WHEN length(CAST(b.scope AS BLOB)) <= 8192 THEN b.scope END AS scope, CASE WHEN length(CAST(b.head AS BLOB)) <= 512 THEN b.head END AS head, CASE WHEN length(CAST(o.head AS BLOB)) <= 512 THEN o.head END AS outcome_head, CASE WHEN json_extract(b.head,'$.sequence')='0' AND length(CAST(b.genesis AS BLOB)) <= 1048576 THEN b.genesis END AS initial_genesis FROM ledger_native_book b LEFT JOIN ledger_native_outcomes o ON o.sequence = CAST(json_extract(b.head,'$.sequence') AS INTEGER) WHERE b.singleton = 1",
    );
    const row = rows[0];
    requireLedger(
      rows.length === 1 && row?.format === FORMAT && row.scope === this.scopeText,
      "native_ledger_identity_mismatch",
    );
    const selected = head(row.head);
    requireLedger(
      selected.sequence === "0" ? row.outcome_head === null : row.outcome_head === row.head,
      "native_ledger_head_corrupt",
    );
    if (selected.sequence === "0") {
      bounded(row.initial_genesis);
      requireLedger(
        selected.chainHash ===
          digest(JSON.stringify([FORMAT, this.scopeHash, digest(row.initial_genesis)])),
        "native_ledger_head_corrupt",
      );
    }
    return selected;
  }
  private next(previous: NativeLedgerHead, encoded: string, revision: string): NativeLedgerHead {
    requireLedger(BigInt(previous.sequence) < MAX_SEQUENCE, "native_ledger_sequence_exhausted");
    const sequence = (BigInt(previous.sequence) + 1n).toString();
    return Object.freeze({
      sequence,
      bookRevision: revision,
      chainHash: digest(
        JSON.stringify([
          FORMAT,
          this.scopeHash,
          sequence,
          revision,
          previous.chainHash,
          digest(encoded),
        ]),
      ),
    });
  }
  provision(
    genesis: string,
    admit?: () => void,
    preparePublication?: () => Promise<void>,
  ): Promise<NativeLedgerHead> {
    bounded(genesis);
    // The owner verifies accounting genesis before calling the repository.
    const initial = Object.freeze({
      sequence: "0",
      bookRevision: "0",
      chainHash: digest(JSON.stringify([FORMAT, this.scopeHash, digest(genesis)])),
    });
    return this.serial(async () => {
      await this.storage.sync();
      const fence = this.fence();
      const readinessFailure = preparePublication
        ? await publicationReadiness(preparePublication)
        : null;
      const selected = atomicSqlite(this.storage, () => {
        admit?.();
        requireLedger(this.fence() === fence, "native_ledger_fence_changed");
        const tables = this.rows(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ledger_metadata','ledger_indexed_canonical','ledger_native_book','ledger_native_outcomes','ledger_native_facts')",
        );
        requireLedger(
          !tables.some(
            (row) => row.name === "ledger_metadata" || row.name === "ledger_indexed_canonical",
          ),
          "native_ledger_migration_required",
        );
        if (tables.length > 0) {
          requireLedger(tables.length === 3, "native_ledger_schema_incomplete");
          const current = this.current();
          const stored = this.rows(
            "SELECT CASE WHEN length(CAST(genesis AS BLOB)) <= 1048576 THEN genesis END AS genesis FROM ledger_native_book WHERE singleton = 1",
          )[0];
          requireLedger(stored?.genesis === genesis, "native_ledger_genesis_conflict");
          this.ensureCurrencyIndex();
          requireLedger(this.fence() === fence, "native_ledger_fence_changed");
          return current;
        }
        if (readinessFailure) throw readinessFailure.error;
        this.storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS ledger_native_book (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), format TEXT NOT NULL, scope TEXT NOT NULL, genesis TEXT NOT NULL, head TEXT NOT NULL)",
        );
        this.storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS ledger_native_outcomes (sequence INTEGER PRIMARY KEY CHECK(sequence > 0), command_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, previous_hash TEXT NOT NULL, head TEXT NOT NULL)",
        );
        this.storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS ledger_native_facts (identity TEXT PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL, source_sequence INTEGER NOT NULL REFERENCES ledger_native_outcomes(sequence), mutable INTEGER NOT NULL CHECK(mutable IN (0,1))) WITHOUT ROWID",
        );
        this.ensureCurrencyIndex();
        this.storage.sql.exec(
          "INSERT INTO ledger_native_book VALUES (1, ?, ?, ?, ?) ON CONFLICT(singleton) DO NOTHING",
          FORMAT,
          this.scopeText,
          genesis,
          JSON.stringify(initial),
        );
        const current = this.current();
        const row = this.rows("SELECT genesis FROM ledger_native_book WHERE singleton = 1")[0];
        requireLedger(row?.genesis === genesis, "native_ledger_genesis_conflict");
        requireLedger(this.fence() === fence, "native_ledger_fence_changed");
        return current;
      });
      await this.storage.sync();
      requireLedger(this.fence() === fence, "native_ledger_fence_changed");
      return selected;
    });
  }
  private decodeOutcome(
    row: Record<string, unknown>,
    decoding: OutcomeDecoding = "canonical",
  ): NativeLedgerOutcome {
    const encoded = decodeStoredNativeOutcome(row.body);
    bounded(row.previous_hash, 64);
    requireLedger(HASH.test(row.previous_hash), "native_ledger_outcome_corrupt");
    const selected = head(row.head);
    const decoded =
      decoding === "stored" ? decodeStoredBookOutcome(encoded) : decodeBookOutcome(encoded);
    requireLedger(decoded.disposition === "decoded", "native_ledger_outcome_corrupt");
    const payload = decoded.payload;
    requireLedger(
      payload.command.bookId === this.scope.bookId &&
        payload.command.id === row.command_id &&
        row.sequence === selected.sequence &&
        payload.originalResult.observedBookRevision.toString() === selected.bookRevision &&
        digest(
          JSON.stringify([
            FORMAT,
            this.scopeHash,
            selected.sequence,
            selected.bookRevision,
            row.previous_hash,
            digest(encoded),
          ]),
        ) === selected.chainHash,
      "native_ledger_outcome_corrupt",
    );
    return Object.freeze({
      head: selected,
      previousHash: row.previous_hash,
      payload,
      encoded,
    });
  }
  private decodeFact(row: Record<string, unknown>, current: NativeLedgerHead): NativeLedgerFact {
    bounded(row.identity, 8192);
    const parts: unknown = JSON.parse(row.identity);
    requireLedger(
      Array.isArray(parts) &&
        parts.length === 2 &&
        typeof parts[0] === "string" &&
        typeof parts[1] === "string" &&
        key(parts[0], parts[1]) === row.identity,
      "native_ledger_fact_corrupt",
    );
    bounded(row.body);
    requireLedger(
      digest(row.body) === row.digest &&
        (row.mutable === 0 || row.mutable === 1) &&
        typeof row.source_sequence === "string" &&
        BigInt(row.source_sequence) > 0n &&
        BigInt(row.source_sequence) <= BigInt(current.sequence),
      "native_ledger_fact_corrupt",
    );
    return Object.freeze({
      collection: parts[0],
      key: parts[1],
      encoded: row.body,
      ...(row.mutable === 1 ? { mutable: true as const } : {}),
    });
  }
  /** Bounded canonical export. Every cursor names an actual retained chain head,
   * including genesis; a missing middle or terminal interval is never EOF. The
   * caller must pin its expected tip for a stable backup/copy acceptance decision. */
  async outcomePage(
    after: NativeLedgerHead | null = null,
    limit = 16,
    admit?: () => void,
    decoding: OutcomeDecoding = "canonical",
  ): Promise<NativeOutcomePage> {
    const cursor = after === null ? null : head(JSON.stringify(after));
    requireLedger(
      Number.isSafeInteger(limit) && limit > 0 && limit <= 16,
      "native_ledger_read_limit",
    );
    const result = await this.transact((view) => {
      const row = this.rows(
        "SELECT CASE WHEN length(CAST(genesis AS BLOB)) <= 1048576 THEN genesis END AS genesis FROM ledger_native_book WHERE singleton=1",
      )[0];
      bounded(row?.genesis);
      const genesis = row.genesis;
      const initial = Object.freeze({
        sequence: "0",
        bookRevision: "0",
        chainHash: digest(JSON.stringify([FORMAT, this.scopeHash, digest(genesis)])),
      });
      const from = cursor ?? initial;
      requireLedger(
        BigInt(from.sequence) <= BigInt(view.head.sequence),
        "native_ledger_cursor_mismatch",
      );
      if (from.sequence === "0")
        requireLedger(
          JSON.stringify(from) === JSON.stringify(initial),
          "native_ledger_cursor_mismatch",
        );
      else {
        const anchor = this.rows(
          "SELECT CASE WHEN length(CAST(head AS BLOB)) <= 512 THEN head END AS head FROM ledger_native_outcomes WHERE sequence=?",
          from.sequence,
        )[0];
        requireLedger(anchor?.head === JSON.stringify(from), "native_ledger_cursor_mismatch");
      }
      const rows = this.rows(
        "SELECT CAST(sequence AS TEXT) AS sequence, command_id, CASE WHEN length(CAST(body AS BLOB)) <= 1048576 THEN body END AS body, substr(previous_hash,1,65) AS previous_hash, CASE WHEN length(CAST(head AS BLOB)) <= 512 THEN head END AS head FROM (SELECT *, sum(length(CAST(body AS BLOB))) OVER (ORDER BY sequence) AS page_bytes, row_number() OVER (ORDER BY sequence) AS ordinal FROM (SELECT * FROM ledger_native_outcomes WHERE sequence > ? AND sequence <= ? ORDER BY sequence LIMIT ?)) WHERE page_bytes <= 1048576 OR ordinal=1 ORDER BY CAST(sequence AS INTEGER)",
        from.sequence,
        view.head.sequence,
        limit,
      );
      let through = from;
      let pageBytes = 0;
      const outcomes: NativeLedgerOutcome[] = [];
      for (const row of rows) {
        const outcome = this.decodeOutcome(row, decoding);
        const bytes = encoder.encode(outcome.encoded).length;
        if (pageBytes + bytes > MAX_BYTES) break;
        requireLedger(
          BigInt(outcome.head.sequence) === BigInt(through.sequence) + 1n &&
            outcome.previousHash === through.chainHash,
          "recovery_segment_gap_detected",
        );
        through = outcome.head;
        pageBytes += bytes;
        outcomes.push(outcome);
      }
      requireLedger(
        outcomes.length > 0 || from.sequence === view.head.sequence,
        "recovery_segment_gap_detected",
      );
      if (through.sequence === view.head.sequence)
        requireLedger(
          JSON.stringify(through) === JSON.stringify(view.head),
          "native_ledger_head_corrupt",
        );
      return {
        write: false,
        value: Object.freeze({
          genesis,
          from,
          through,
          observedTip: view.head,
          outcomes: Object.freeze(outcomes),
        }),
      };
    }, admit);
    return result.value;
  }
  /** Stable encoded-identity order, for full projection comparison only. Each
   * page is bounded; it is not a general accounting report or snapshot cursor. */
  async factPage(
    afterIdentity: string | null = null,
    limit = 32,
    admit?: () => void,
  ): Promise<NativeFactPage> {
    if (afterIdentity !== null) bounded(afterIdentity, 8192);
    requireLedger(
      Number.isSafeInteger(limit) && limit > 0 && limit <= 32,
      "native_ledger_read_limit",
    );
    const result = await this.transact((view) => {
      const rows = this.rows(
        "WITH candidates AS (SELECT * FROM ledger_native_facts WHERE identity > ? ORDER BY identity LIMIT ?), sized AS (SELECT *, sum(length(CAST(body AS BLOB))) OVER (ORDER BY identity ROWS UNBOUNDED PRECEDING) AS bytes, row_number() OVER (ORDER BY identity) AS ordinal FROM candidates) SELECT identity, CASE WHEN bytes<=1048576 THEN body END AS body, substr(digest,1,65) AS digest, CAST(source_sequence AS TEXT) AS source_sequence, mutable FROM sized WHERE bytes<=1048576 OR ordinal=1 ORDER BY identity",
        afterIdentity ?? "",
        limit,
      );
      let nextIdentity = afterIdentity;
      const facts = rows.map((row) => {
        bounded(row.identity, 8192);
        const parts: unknown = JSON.parse(row.identity);
        requireLedger(
          Array.isArray(parts) &&
            parts.length === 2 &&
            typeof parts[0] === "string" &&
            typeof parts[1] === "string" &&
            key(parts[0], parts[1]) === row.identity,
          "native_ledger_fact_corrupt",
        );
        bounded(row.body);
        requireLedger(
          digest(row.body) === row.digest &&
            (row.mutable === 0 || row.mutable === 1) &&
            typeof row.source_sequence === "string" &&
            BigInt(row.source_sequence) > 0n &&
            BigInt(row.source_sequence) <= BigInt(view.head.sequence),
          "native_ledger_fact_corrupt",
        );
        nextIdentity = row.identity;
        return Object.freeze({
          collection: parts[0],
          key: parts[1],
          encoded: row.body,
          ...(row.mutable === 1 ? { mutable: true as const } : {}),
          sourceSequence: row.source_sequence,
        });
      });
      return {
        write: false,
        value: Object.freeze({ observedTip: view.head, facts: Object.freeze(facts), nextIdentity }),
      };
    }, admit);
    return result.value;
  }
  /** All read dependencies and publication share one synchronous SQL transaction.
   * The callback cannot escape the transaction, yield, or issue external effects.
   * After an uncertain acknowledgement, the next call re-reads durable state and
   * resolves the original command identity before evaluating a new decision. */
  private ensureCurrencyIndex(): void {
    this.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS ledger_native_inventory_active ON ledger_native_facts(json_extract(body,'$.accountId'), json_extract(body,'$.commodityId'), identity) WHERE json_extract(identity,'$[0]') = 'inventoryPositions' AND mutable = 1 AND json_extract(body,'$.active') = 1",
    );
    this.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS ledger_native_currency_due ON ledger_native_facts(json_extract(body,'$.policyId'), json_extract(body,'$.effectiveOn'), source_sequence) WHERE json_extract(identity,'$[0]') = 'currencyPositions' AND mutable = 1 AND json_extract(body,'$.active') = 1",
    );
    this.storage.sql.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS ledger_native_currency_source ON ledger_native_facts(json_extract(body,'$.sourceKey')) WHERE json_extract(identity,'$[0]') = 'currencyPositions' AND mutable = 1 AND json_extract(body,'$.active') = 1",
    );
  }

  transact<T>(
    evaluate: (view: NativeLedgerTransaction) => NativeLedgerTransactionResult<T>,
    admit?: () => void,
    preparePublication?: () => Promise<void>,
  ): Promise<{ readonly value: T; readonly head: NativeLedgerHead }> {
    return this.serial(async () => {
      // Authorization is per request, including reads/retries. It is rechecked
      // after queue admission and any asynchronous durability wait, before data.
      await this.storage.sync();
      const fence = this.fence();
      // Keep ownership across durable alarm arming and the atomic decision.
      // A failed arm blocks new outcomes, but not an already retained retry.
      const readinessFailure = preparePublication
        ? await publicationReadiness(preparePublication)
        : null;
      const result = atomicSqlite(this.storage, () => {
        admit?.();
        requireLedger(this.fence() === fence, "native_ledger_fence_changed");
        let active = true;
        const current = this.current();
        const requireActive = () => requireLedger(active, "native_ledger_transaction_closed");
        const view: NativeLedgerTransaction = Object.freeze({
          head: current,
          activeInventoryPositions: (accountIds: readonly string[], commodityId: string) => {
            requireActive();
            requireLedger(accountIds.length <= 1000, "native_ledger_read_limit");
            for (const id of accountIds) bounded(id, 1024);
            bounded(commodityId, 1024);
            if (accountIds.length === 0) return Object.freeze([]);
            const rows = this.rows(
              "SELECT identity, CASE WHEN sum(length(CAST(body AS BLOB))) OVER () <= 1048576 THEN body END AS body, substr(digest,1,65) AS digest, CAST(source_sequence AS TEXT) AS source_sequence, mutable FROM (SELECT * FROM ledger_native_facts INDEXED BY ledger_native_inventory_active WHERE json_extract(identity,'$[0]') = 'inventoryPositions' AND mutable = 1 AND json_extract(body,'$.active') = 1 AND json_extract(body,'$.accountId') IN (SELECT value FROM json_each(?)) AND json_extract(body,'$.commodityId') = ? ORDER BY identity LIMIT 10001)",
              JSON.stringify([...new Set(accountIds)]),
              commodityId,
            );
            requireLedger(rows.length <= 10000, "native_ledger_inventory_pool_limit");
            return Object.freeze(rows.map((row) => this.decodeFact(row, current)));
          },
          firstDueCurrencyPosition: (policyIds: readonly string[], before: string) => {
            requireActive();
            requireLedger(
              policyIds.length <= 1000 && /^\d{4}-\d{2}-\d{2}$/.test(before),
              "native_ledger_read_limit",
            );
            for (const id of policyIds) bounded(id, 1024);
            if (policyIds.length === 0) return null;
            const row = this.rows(
              "SELECT identity, CASE WHEN length(CAST(body AS BLOB)) <= 1048576 THEN body END AS body, substr(digest,1,65) AS digest, CAST(source_sequence AS TEXT) AS source_sequence, mutable FROM ledger_native_facts INDEXED BY ledger_native_currency_due WHERE json_extract(identity,'$[0]') = 'currencyPositions' AND mutable = 1 AND json_extract(body,'$.active') = 1 AND json_extract(body,'$.policyId') IN (SELECT value FROM json_each(?)) AND json_extract(body,'$.effectiveOn') < ? ORDER BY source_sequence, identity LIMIT 1",
              JSON.stringify(policyIds),
              before,
            )[0];
            return row === undefined ? null : this.decodeFact(row, current);
          },
          activeCurrencyPositions: (sourceKeys: readonly string[]) => {
            requireActive();
            requireLedger(
              sourceKeys.length <= 1000 && sourceKeys.every((value) => HASH.test(value)),
              "native_ledger_invalid_input",
            );
            if (sourceKeys.length === 0) return new Map();
            const rows = this.rows(
              "SELECT identity, CASE WHEN sum(length(CAST(body AS BLOB))) OVER () <= 1048576 THEN body END AS body, substr(digest,1,65) AS digest, CAST(source_sequence AS TEXT) AS source_sequence, mutable FROM ledger_native_facts INDEXED BY ledger_native_currency_source WHERE json_extract(identity,'$[0]') = 'currencyPositions' AND mutable = 1 AND json_extract(body,'$.sourceKey') IN (SELECT value FROM json_each(?)) AND json_extract(body,'$.active') = 1 LIMIT 1001",
              JSON.stringify(sourceKeys),
            );
            requireLedger(
              rows.length <= sourceKeys.length,
              "native_ledger_currency_position_conflict",
            );
            const found = new Map<string, NativeLedgerFact>();
            for (const row of rows) {
              const observed = this.decodeFact(row, current);
              const sourceKey: unknown = JSON.parse(observed.encoded).sourceKey;
              requireLedger(
                typeof sourceKey === "string" &&
                  sourceKeys.includes(sourceKey) &&
                  !found.has(sourceKey),
                "native_ledger_currency_position_conflict",
              );
              found.set(sourceKey, observed);
            }
            return found;
          },
          scanFacts: (collection: string, companionCollection?: string) => {
            requireActive();
            key(collection, "scan");
            if (companionCollection !== undefined) key(companionCollection, "scan");
            const lower = `${JSON.stringify([collection]).slice(0, -1)},`;
            const upper = `${lower.slice(0, -1)}-`;
            const owner = this;
            return (function* () {
              requireActive();
              const companionColumns =
                companionCollection === undefined
                  ? ""
                  : ", c.identity AS companion_identity, CASE WHEN length(CAST(c.body AS BLOB)) <= 1048576 THEN c.body END AS companion_body, substr(c.digest,1,65) AS companion_digest, CAST(c.source_sequence AS TEXT) AS companion_source_sequence, c.mutable AS companion_mutable";
              const join =
                companionCollection === undefined
                  ? ""
                  : " LEFT JOIN ledger_native_facts c ON c.identity=json_array(?,json_extract(f.identity,'$[1]'))";
              const rows = owner.storage.sql.exec(
                "SELECT f.identity, CASE WHEN length(CAST(f.body AS BLOB)) <= 1048576 THEN f.body END AS body, substr(f.digest,1,65) AS digest, CAST(f.source_sequence AS TEXT) AS source_sequence, f.mutable" +
                  companionColumns +
                  " FROM ledger_native_facts f" +
                  join +
                  " WHERE f.identity >= ? AND f.identity < ? ORDER BY f.source_sequence, f.identity",
                ...(companionCollection === undefined ? [] : [companionCollection]),
                lower,
                upper,
              );
              for (const row of rows) {
                requireActive();
                const fact = owner.decodeFact(row, current);
                const companion =
                  companionCollection === undefined || row.companion_identity === null
                    ? null
                    : owner.decodeFact(
                        {
                          identity: row.companion_identity,
                          body: row.companion_body,
                          digest: row.companion_digest,
                          source_sequence: row.companion_source_sequence,
                          mutable: row.companion_mutable,
                        },
                        current,
                      );
                yield Object.freeze({ fact, companion });
                requireActive();
              }
            })();
          },
          outcome: (id: string) => {
            requireActive();
            bounded(id, 1024);
            const row = this.rows(
              "SELECT CAST(sequence AS TEXT) AS sequence, command_id, CASE WHEN length(CAST(body AS BLOB)) <= 1048576 THEN body END AS body, substr(previous_hash,1,65) AS previous_hash, CASE WHEN length(CAST(head AS BLOB)) <= 512 THEN head END AS head FROM ledger_native_outcomes WHERE command_id = ?",
              id,
            )[0];
            if (!row) return null;
            const outcome = this.decodeOutcome(row);
            requireLedger(
              BigInt(outcome.head.sequence) <= BigInt(current.sequence),
              "native_ledger_outcome_corrupt",
            );
            return outcome;
          },
          facts: (keys: readonly { collection: string; key: string }[]) => {
            requireActive();
            requireLedger(keys.length <= 1000, "native_ledger_read_limit");
            const ids = keys.map((item) => key(item.collection, item.key));
            if (ids.length === 0) return Object.freeze([]);
            const rows = this.rows(
              "SELECT identity, CASE WHEN sum(length(CAST(body AS BLOB))) OVER () <= 1048576 THEN body END AS body, substr(digest,1,65) AS digest, CAST(source_sequence AS TEXT) AS source_sequence, mutable FROM ledger_native_facts WHERE identity IN (SELECT value FROM json_each(?))",
              JSON.stringify(ids),
            );
            // NULL here is the query's aggregate byte-budget sentinel, not a
            // malformed stored value (body is NOT NULL). Keep the bound intact
            // and let fixed-size readers split their own known coordinates.
            requireLedger(
              rows.every((row) => row.body !== null),
              "native_ledger_read_limit",
            );
            const found = new Map(rows.map((row) => [row.identity, row]));
            return Object.freeze(
              keys.map((item, index) => {
                const row = found.get(ids[index]);
                if (!row) return null;
                bounded(row.body);
                requireLedger(
                  (row.mutable === 0 || row.mutable === 1) &&
                    digest(row.body) === row.digest &&
                    typeof row.source_sequence === "string" &&
                    BigInt(row.source_sequence) > 0n &&
                    BigInt(row.source_sequence) <= BigInt(current.sequence),
                  "native_ledger_fact_corrupt",
                );
                return Object.freeze({
                  ...item,
                  encoded: row.body,
                  ...(row.mutable === 1 ? { mutable: true as const } : {}),
                });
              }),
            );
          },
        });
        try {
          const decision = evaluate(view);
          requireLedger(
            decision &&
              typeof decision === "object" &&
              !("then" in decision) &&
              typeof decision.write === "boolean",
            "native_ledger_async_evaluation",
          );
          let selected = current;
          if (decision.write) {
            if (readinessFailure) throw readinessFailure.error;
            bounded(decision.decision.encodedOutcome);
            const decoded = decodeBookOutcome(decision.decision.encodedOutcome);
            requireLedger(decoded.disposition === "decoded", "native_ledger_outcome_invalid");
            const { command, originalResult, revision } = decoded.payload;
            requireLedger(
              command.bookId === this.scope.bookId &&
                originalResult.observedBookRevision ===
                  BigInt(current.bookRevision) + (revision === null ? 0n : 1n),
              "native_ledger_revision_conflict",
            );
            selected = this.next(
              current,
              decision.decision.encodedOutcome,
              originalResult.observedBookRevision.toString(),
            );
            requireLedger(decision.decision.facts.length <= 1000, "native_ledger_write_limit");
            requireLedger(
              revision !== null || decision.decision.facts.length === 0,
              "native_ledger_rejection_changes_state",
            );
            const ids = new Set<string>();
            const changes = decision.decision.facts.map((fact) => {
              const id = key(fact.collection, fact.key);
              bounded(fact.encoded);
              requireLedger(
                fact.mutable === undefined || fact.mutable === true,
                "native_ledger_invalid_input",
              );
              requireLedger(!ids.has(id), "native_ledger_duplicate_fact");
              ids.add(id);
              return {
                identity: id,
                body: fact.encoded,
                digest: digest(fact.encoded),
                mutable: fact.mutable === true ? 1 : 0,
              };
            });
            // A maximum schedule can fit each record but not the combined JSON
            // projection batch (revision plus schedule). Keep each SQL binding
            // within 1 MiB and the complete escaped projection within 4 MiB.
            // Every batch still belongs to this one atomic transaction.
            const batches: string[][] = [];
            let batch: string[] = [];
            let batchBytes = 2;
            let totalBytes = 2;
            for (const change of changes) {
              const encoded = JSON.stringify(change);
              bounded(encoded, MAX_BYTES - 2);
              const bytes = encoder.encode(encoded).byteLength;
              if (batchBytes + bytes + (batch.length ? 1 : 0) > MAX_BYTES) {
                batches.push(batch);
                batch = [];
                batchBytes = 2;
                totalBytes += 2;
              }
              const addedBytes = bytes + (batch.length ? 1 : 0);
              totalBytes += addedBytes;
              requireLedger(totalBytes <= 4 * MAX_BYTES, "native_ledger_write_limit");
              batchBytes += addedBytes;
              batch.push(encoded);
            }
            if (batch.length) batches.push(batch);
            const upgrade = decision.decision.upgradeOpenPeriod;
            if (upgrade !== undefined) {
              requireLedger(
                command.type === "closePeriod" &&
                  command.periodId === upgrade &&
                  revision !== null &&
                  decision.decision.facts.some(
                    (fact) =>
                      fact.collection === "periods" &&
                      fact.key === upgrade &&
                      fact.encoded === '{"status":"closed","closeCount":"1"}' &&
                      fact.mutable === true,
                  ),
                "native_ledger_period_upgrade_invalid",
              );
              const upgraded = this.rows(
                "UPDATE ledger_native_facts SET mutable=1 WHERE identity=? AND mutable=0 AND body='open' AND digest=? RETURNING identity",
                key("periods", upgrade),
                digest("open"),
              );
              requireLedger(upgraded.length === 1, "native_ledger_period_upgrade_conflict");
            }
            this.storage.sql.exec(
              "INSERT INTO ledger_native_outcomes VALUES (?, ?, ?, ?, ?)",
              selected.sequence,
              command.id,
              encodeStoredNativeOutcome(decision.decision.encodedOutcome),
              current.chainHash,
              JSON.stringify(selected),
            );
            for (const batch of batches)
              this.storage.sql.exec(
                "INSERT INTO ledger_native_facts (identity, body, digest, source_sequence, mutable) SELECT json_extract(value,'$.identity'), json_extract(value,'$.body'), json_extract(value,'$.digest'), ?, json_extract(value,'$.mutable') FROM json_each(?) WHERE true ON CONFLICT(identity) DO UPDATE SET body=CASE WHEN ledger_native_facts.mutable=1 AND excluded.mutable=1 THEN excluded.body ELSE NULL END, digest=excluded.digest, source_sequence=excluded.source_sequence",
                selected.sequence,
                `[${batch.join(",")}]`,
              );
            this.storage.sql.exec(
              "UPDATE ledger_native_book SET head = ? WHERE singleton = 1",
              JSON.stringify(selected),
            );
          }
          requireLedger(this.fence() === fence, "native_ledger_fence_changed");
          return Object.freeze({ value: decision.value, head: selected });
        } finally {
          active = false;
        }
      });
      await this.storage.sync();
      requireLedger(this.fence() === fence, "native_ledger_fence_changed");
      return result;
    });
  }
}

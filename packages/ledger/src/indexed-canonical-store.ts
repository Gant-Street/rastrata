import { hashCanonical } from "@rastrata/kernel";
import { completeScope } from "./compact-records.ts";
import {
  decodeIndexedBookHead,
  decodeIndexedBookState,
  prepareIndexedBookHead,
  projectLegacyIndexedBook,
} from "./indexed-book-state.ts";
import {
  decodeIndexedOutcomeRecord,
  INDEXED_OUTCOME_RECORD_MAX_BYTES,
  type IndexedOutcomeRecord,
} from "./indexed-outcome-record.ts";
import { indexedSourceGenesisHash, type IndexedSourceAnchor } from "./indexed-source-catalog.ts";
import { requireLedger, type CompleteBookScope } from "./records.ts";
import { requireSqliteTransaction, type SqliteTransaction } from "./sqlite-transaction.ts";
import type { SqlBinding, SqliteStorage } from "./sqlite.ts";

export const INDEXED_CANONICAL_STORE_VERSION = "rastrata-indexed-canonical-store-v1";
const CHUNK = 262144,
  MAX_GENESIS = 16 * 1024 * 1024,
  MAX_ANCHOR = 524288;
const HEX = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });
export interface PreparedIndexedCanonical {
  readonly headHash: string;
}
interface Staged {
  readonly before: string | null;
  readonly after: string;
  readonly id: string;
  readonly body: string;
}
function key(sequence: bigint) {
  requireLedger(
    typeof sequence === "bigint" && sequence > 0n && sequence < 1n << 64n,
    "indexed_canonical_sequence_invalid",
  );
  return sequence.toString(16).padStart(16, "0");
}
function digest(body: string) {
  return hashCanonical({ domain: INDEXED_CANONICAL_STORE_VERSION, body }).digest;
}
function bounded(body: string, maximum: number) {
  requireLedger(
    typeof body === "string" && body.length <= maximum && encoder.encode(body).length <= maximum,
    "indexed_canonical_bytes_exceeded",
  );
}

/** Canonical persistence component, NOT an accounting evaluator or enabled
 * BookStorageAdapter. A trusted owner must compose this with source/group/identity
 * publication, live fencing, complete accounting replay and confirmed durability.
 * Preparation/structural audits alone never authorize a receipt or readiness. */
export class SqliteIndexedCanonicalStore {
  private readonly scope: CompleteBookScope;
  private readonly plans = new WeakMap<object, Staged>();
  constructor(
    private readonly storage: SqliteStorage,
    scope: CompleteBookScope,
    private readonly objectId: string,
  ) {
    this.scope = completeScope(scope, objectId);
  }
  private rows(sql: string, ...bindings: SqlBinding[]) {
    return Array.from(this.storage.sql.exec(sql, ...bindings));
  }
  private encodeAnchor(input: IndexedSourceAnchor): string {
    const body = JSON.stringify(input);
    this.decodeAnchor(body);
    return body;
  }
  private decodeAnchor(body: string): IndexedSourceAnchor {
    bounded(body, MAX_ANCHOR);
    const raw = JSON.parse(body);
    requireLedger(
      raw &&
        Object.keys(raw).sort().join(",") === "genesisHash,head,state" &&
        typeof raw.genesisHash === "string" &&
        HEX.test(raw.genesisHash),
      "indexed_canonical_anchor_invalid",
    );
    const state = decodeIndexedBookState(JSON.stringify(raw.state));
    const head = decodeIndexedBookHead(JSON.stringify(raw.head), state, this.scope, this.objectId);
    const value = Object.freeze({ genesisHash: raw.genesisHash, state, head });
    requireLedger(JSON.stringify(value) === body, "indexed_canonical_anchor_invalid");
    return value;
  }
  private cachedBody?: string;
  private cachedAnchor?: IndexedSourceAnchor;
  private metadata(): { body: string; anchor: IndexedSourceAnchor } {
    const rows = this.rows(
      `SELECT singleton, typeof(body) AS kind, substr(body, 1, ${MAX_ANCHOR + 1}) AS body, length(CAST(body AS BLOB)) AS bytes, substr(version, 1, 65) AS version, length(CAST(version AS BLOB)) AS version_bytes FROM ledger_indexed_canonical LIMIT 2`,
    );
    const row = rows[0];
    requireLedger(
      rows.length === 1 &&
        row?.singleton === 1 &&
        row.kind === "text" &&
        typeof row.body === "string" &&
        Buffer.byteLength(row.body) === row.bytes &&
        row.version === INDEXED_CANONICAL_STORE_VERSION &&
        row.version_bytes === INDEXED_CANONICAL_STORE_VERSION.length,
      "indexed_canonical_metadata_corrupt",
    );
    if (this.cachedBody === row.body && this.cachedAnchor !== undefined) {
      return { body: row.body, anchor: this.cachedAnchor };
    }
    const anchor = this.decodeAnchor(row.body);
    this.cachedBody = row.body;
    this.cachedAnchor = anchor;
    return { body: row.body, anchor };
  }
  readAnchor(): IndexedSourceAnchor {
    return this.metadata().anchor;
  }
  private expected(input: IndexedSourceAnchor) {
    const encoded = this.encodeAnchor(input);
    requireLedger(this.metadata().body === encoded, "indexed_canonical_head_conflict");
    return encoded;
  }
  private readBody(id: string, maximum: number): { body: string; chunks: number } {
    const manifest = this.rows(
      "SELECT bytes, chunks, substr(digest, 1, 65) AS digest, length(CAST(digest AS BLOB)) AS digest_bytes FROM ledger_indexed_records WHERE record_id = ? LIMIT 2",
      id,
    );
    const entry = manifest[0];
    requireLedger(
      manifest.length === 1 &&
        entry &&
        Number.isSafeInteger(entry.bytes) &&
        (entry.bytes as number) > 0 &&
        (entry.bytes as number) <= maximum &&
        entry.chunks === Math.ceil((entry.bytes as number) / CHUNK) &&
        typeof entry.digest === "string" &&
        HEX.test(entry.digest) &&
        entry.digest_bytes === 64,
      "indexed_canonical_record_missing_or_corrupt",
    );
    const rows = this.rows(
      `SELECT ordinal, typeof(bytes) AS kind, substr(bytes, 1, ${CHUNK + 1}) AS bytes, length(bytes) AS size FROM ledger_indexed_record_chunks WHERE record_id = ? ORDER BY ordinal LIMIT ${Math.ceil(maximum / CHUNK) + 1}`,
      id,
    );
    requireLedger(rows.length === entry.chunks, "indexed_canonical_chunks_corrupt");
    const bytes = new Uint8Array(entry.bytes as number);
    rows.forEach((row, ordinal) => {
      const size = Math.min(CHUNK, bytes.length - ordinal * CHUNK);
      requireLedger(
        row.ordinal === ordinal &&
          row.kind === "blob" &&
          row.bytes instanceof ArrayBuffer &&
          row.bytes.byteLength === size &&
          row.size === size,
        "indexed_canonical_chunks_corrupt",
      );
      bytes.set(new Uint8Array(row.bytes), ordinal * CHUNK);
    });
    const body = decoder.decode(bytes);
    requireLedger(
      digest(body) === entry.digest && encoder.encode(body).length === bytes.length,
      "indexed_canonical_record_hash_mismatch",
    );
    return { body, chunks: rows.length };
  }
  private writeBody(id: string, body: string) {
    const bytes = encoder.encode(body);
    this.rows(
      "INSERT INTO ledger_indexed_records VALUES (?, ?, ?, ?)",
      id,
      bytes.length,
      Math.ceil(bytes.length / CHUNK),
      digest(body),
    );
    for (let offset = 0, ordinal = 0; offset < bytes.length; offset += CHUNK, ordinal++)
      this.rows(
        "INSERT INTO ledger_indexed_record_chunks VALUES (?, ?, ?)",
        id,
        ordinal,
        bytes.slice(offset, offset + CHUNK).buffer,
      );
    requireLedger(
      this.readBody(id, id === "genesis" ? MAX_GENESIS : INDEXED_OUTCOME_RECORD_MAX_BYTES).body ===
        body,
      "indexed_canonical_record_hash_mismatch",
    );
  }
  private stage(
    before: string | null,
    after: IndexedSourceAnchor,
    id: string,
    body: string,
  ): PreparedIndexedCanonical {
    const token = Object.freeze({ headHash: after.head.contentHash });
    this.plans.set(token, { before, after: this.encodeAnchor(after), id, body });
    return token;
  }
  async prepareGenesis(encoded: string): Promise<PreparedIndexedCanonical> {
    bounded(encoded, MAX_GENESIS);
    const genesisHash = indexedSourceGenesisHash(encoded);
    const { state } = await projectLegacyIndexedBook(encoded);
    requireLedger(
      state.collections.every(
        (c) => c.population === (c.collection === "state.configurationSnapshots" ? "1" : "0"),
      ),
      "indexed_canonical_genesis_required",
    );
    return this.stage(
      null,
      {
        genesisHash,
        state,
        head: prepareIndexedBookHead(this.scope, this.objectId, state, null, null),
      },
      "genesis",
      encoded,
    );
  }
  prepareOutcome(expected: IndexedSourceAnchor, encoded: string): PreparedIndexedCanonical {
    const before = this.expected(expected),
      anchor = this.decodeAnchor(before);
    const record = decodeIndexedOutcomeRecord(
      encoded,
      this.scope,
      this.objectId,
      anchor.state,
      anchor.head,
    );
    return this.stage(
      before,
      {
        genesisHash: anchor.genesisHash,
        state: decodeIndexedBookState(record.state),
        head: record.after,
      },
      key(BigInt(record.after.sequence)),
      encoded,
    );
  }
  /** Same-port transaction only. Caller publishes all derived roots afterward in
   * THIS transaction. An opaque plan survives rollback; success cannot replay it
   * over a different head. This method neither syncs nor makes the owner ready. */
  publishInTransaction(transaction: SqliteTransaction, plan: PreparedIndexedCanonical): void {
    requireSqliteTransaction(transaction, this.storage);
    const staged = this.plans.get(plan);
    requireLedger(staged, "indexed_canonical_preparation_invalid");
    if (staged.before === null) {
      requireLedger(
        this.rows(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'ledger_*' LIMIT 1",
        ).length === 0,
        "indexed_canonical_initialization_conflict",
      );
      this.rows(
        "CREATE TABLE ledger_indexed_canonical (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version TEXT NOT NULL, body TEXT NOT NULL)",
      );
      this.rows(
        "CREATE TABLE ledger_indexed_records (record_id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, chunks INTEGER NOT NULL, digest TEXT NOT NULL)",
      );
      this.rows(
        "CREATE TABLE ledger_indexed_record_chunks (record_id TEXT NOT NULL, ordinal INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(record_id, ordinal))",
      );
      this.writeBody(staged.id, staged.body);
      this.rows(
        "INSERT INTO ledger_indexed_canonical VALUES (1, ?, ?)",
        INDEXED_CANONICAL_STORE_VERSION,
        staged.after,
      );
    } else {
      requireLedger(this.metadata().body === staged.before, "indexed_canonical_head_conflict");
      this.writeBody(staged.id, staged.body);
      this.rows(
        "UPDATE ledger_indexed_canonical SET body = ? WHERE singleton = 1 AND body = ? AND version = ?",
        staged.after,
        staged.before,
        INDEXED_CANONICAL_STORE_VERSION,
      );
      requireLedger(
        this.rows("SELECT changes() AS count")[0]?.count === 1,
        "indexed_canonical_head_conflict",
      );
    }
    requireLedger(this.metadata().body === staged.after, "indexed_canonical_head_conflict");
  }
  readGenesis(expected: IndexedSourceAnchor): string {
    const captured = this.decodeAnchor(this.expected(expected));
    const body = this.readBody("genesis", MAX_GENESIS).body;
    requireLedger(
      indexedSourceGenesisHash(body) === captured.genesisHash,
      "indexed_canonical_genesis_mismatch",
    );
    this.expected(captured);
    return body;
  }
  /** Expected hash must come from an independently authenticated current/pinned
   * canonical source. Metadata alone does NOT prove retained prefix membership. */
  async readOutcome(expected: IndexedSourceAnchor, sequence: bigint, expectedHash: string) {
    const captured = this.decodeAnchor(this.expected(expected));
    requireLedger(
      typeof expectedHash === "string" &&
        HEX.test(expectedHash) &&
        sequence <= BigInt(captured.head.sequence),
      "indexed_canonical_source_invalid",
    );
    const encoded = this.readBody(key(sequence), INDEXED_OUTCOME_RECORD_MAX_BYTES).body;
    const raw = JSON.parse(encoded);
    const beforeState =
      sequence === 1n
        ? (await projectLegacyIndexedBook(this.readGenesis(captured))).state
        : decodeIndexedBookState(
            JSON.parse(this.readBody(key(sequence - 1n), INDEXED_OUTCOME_RECORD_MAX_BYTES).body)
              .state,
          );
    const beforeHead = decodeIndexedBookHead(
      JSON.stringify(raw.before),
      beforeState,
      this.scope,
      this.objectId,
    );
    const record = decodeIndexedOutcomeRecord(
      encoded,
      this.scope,
      this.objectId,
      beforeState,
      beforeHead,
    );
    requireLedger(
      record.contentHash === expectedHash && record.after.sequence === String(sequence),
      "indexed_canonical_source_invalid",
    );
    this.expected(captured);
    return {
      encoded,
      authority: {
        recordHash: expectedHash,
        scope: this.scope,
        actualObjectId: this.objectId,
        beforeState,
        beforeHead,
      },
    };
  }
  /** Full structural chain/gap audit with constant historical buffering. The
   * independently expected anchor and live confirm port are mandatory. Observer
   * callbacks are provisional; accounting replay and derived-index audits remain
   * owner obligations. Never call this alone a complete recovery or ready state. */
  async audit(
    expected: IndexedSourceAnchor,
    ports: {
      readonly confirm: () => Promise<void>;
      readonly outcome: (record: IndexedOutcomeRecord) => Promise<void>;
    },
  ): Promise<{ readonly outcomes: bigint; readonly chunks: bigint }> {
    const captured = this.decodeAnchor(this.encodeAnchor(expected));
    const confirm = async () => {
      await ports.confirm();
      this.expected(captured);
    };
    await confirm();
    const genesis = this.readBody("genesis", MAX_GENESIS);
    requireLedger(
      indexedSourceGenesisHash(genesis.body) === captured.genesisHash,
      "indexed_canonical_genesis_mismatch",
    );
    let { state } = await projectLegacyIndexedBook(genesis.body);
    requireLedger(
      state.collections.every(
        (c) => c.population === (c.collection === "state.configurationSnapshots" ? "1" : "0"),
      ),
      "indexed_canonical_genesis_required",
    );
    let head = prepareIndexedBookHead(this.scope, this.objectId, state, null, null);
    let chunks = BigInt(genesis.chunks);
    await confirm();
    const through = BigInt(captured.head.sequence);
    for (let sequence = 1n; sequence <= through; sequence++) {
      const body = this.readBody(key(sequence), INDEXED_OUTCOME_RECORD_MAX_BYTES);
      const record = decodeIndexedOutcomeRecord(body.body, this.scope, this.objectId, state, head);
      chunks += BigInt(body.chunks);
      // Capture the verified next anchor before exposing a mutable callback copy.
      state = decodeIndexedBookState(record.state);
      head = decodeIndexedBookHead(JSON.stringify(record.after), state, this.scope, this.objectId);
      await confirm();
      await ports.outcome(record);
      await confirm();
    }
    requireLedger(
      this.encodeAnchor({ genesisHash: captured.genesisHash, state, head }) ===
        this.encodeAnchor(captured),
      "indexed_canonical_final_head_mismatch",
    );
    const count = (table: "ledger_indexed_records" | "ledger_indexed_record_chunks") => {
      const value = this.rows(`SELECT count(*) AS count FROM ${table}`)[0]?.count;
      requireLedger(
        Number.isSafeInteger(value) && (value as number) >= 0,
        "indexed_canonical_population_invalid",
      );
      return BigInt(value as number);
    };
    requireLedger(
      count("ledger_indexed_records") === through + 1n &&
        count("ledger_indexed_record_chunks") === chunks,
      "indexed_canonical_population_invalid",
    );
    await confirm();
    return Object.freeze({ outcomes: through, chunks });
  }
}

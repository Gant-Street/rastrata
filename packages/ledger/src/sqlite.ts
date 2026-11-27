import {
  LEDGER_FORMAT,
  COMPACT_LEDGER_FORMAT,
  LEDGER_LIMITS,
  LedgerError,
  type BookScope,
  type LedgerHead,
  type OutcomeRecord,
  type StoredBook,
  type LedgerFormat,
  type CompleteBookScope,
  chunkDigest,
  requireLedger,
  same,
  validateScope,
  verifiedOutcomeRecordHash,
  payloadDigest,
  decodeAggregate,
} from "./records.ts";
import { completeScope } from "./compact-records.ts";
import {
  atomicSqlite,
  requireSqliteTransaction,
  type SqliteTransaction,
} from "./sqlite-transaction.ts";
import type { DurableBookAggregate } from "@rastrata/kernel";

export type SqlBinding = string | number | null | ArrayBuffer;
export interface SqliteStorage {
  readonly sql: {
    exec(query: string, ...bindings: SqlBinding[]): Iterable<Record<string, unknown>>;
  };
  transactionSync<T>(operation: () => T): T;
  sync(): Promise<void>;
}

export interface BookStorageAdapter {
  readonly objectId: string;
  load(scope: BookScope): StoredBook | undefined;
  provision(book: StoredBook): void | Promise<void>;
  commitTransition(expected: LedgerHead, record: OutcomeRecord): void | Promise<void>;
  /** Optional derived-store admission after real full-history verification. This is a
   * trusted owner hook, never a request-supplied verification flag. Failure must
   * prevent both reads and execution. The aggregate is the CURRENT verified head,
   * including when the caller requested an older historical cutoff. */
  validateRecovered?(book: StoredBook, aggregate: DurableBookAggregate): Promise<void>;
  sync(): Promise<void>;
}

const TABLES = ["ledger_metadata", "ledger_outcomes", "ledger_chunks"];
export const ARCHIVE_SQLITE_OWNER = "rastrata-sqlite-archive-selection-v1";
const ARCHIVE_MARKER =
  "EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name IN ('ledger_archive_owner', 'ledger_archive_chunks', 'ledger_archive_catalog', 'ledger_archive_restore')) OR EXISTS (SELECT 1 FROM pragma_table_info('ledger_metadata') WHERE name IN ('archive_owner', 'archive_selection_hash', 'archive_restore_hash'))";

/** SQLite owns physical WAL/recovery. This adapter only writes logical book records. */
export class SqliteBookStorage implements BookStorageAdapter {
  constructor(
    readonly objectId: string,
    private readonly storage: SqliteStorage,
  ) {}

  private rows(query: string, ...bindings: SqlBinding[]) {
    return Array.from(this.storage.sql.exec(query, ...bindings));
  }

  private writeBody(id: string, body: string, format: LedgerFormat): void {
    const bytes = new TextEncoder().encode(body);
    requireLedger(bytes.byteLength <= LEDGER_LIMITS.recordBytes, "ledger_capacity_exceeded");
    for (
      let offset = 0, ordinal = 0;
      offset < bytes.length;
      offset += LEDGER_LIMITS.chunkBytes, ordinal++
    ) {
      const chunk = bytes.slice(offset, offset + LEDGER_LIMITS.chunkBytes);
      this.rows(
        "INSERT INTO ledger_chunks VALUES (?, ?, ?, ?)",
        id,
        ordinal,
        chunk.buffer,
        chunkDigest(chunk, format),
      );
    }
  }

  private readBody(id: string, format: LedgerFormat): { body: string; chunks: number } {
    const chunks = this.rows(
      "SELECT ordinal, substr(bytes, 1, 262145) AS bytes, length(bytes) AS byte_count, typeof(bytes) AS bytes_type, substr(digest, 1, 65) AS digest, length(CAST(digest AS BLOB)) AS digest_bytes FROM ledger_chunks WHERE record_id = ? ORDER BY ordinal LIMIT 5",
      id,
    );
    requireLedger(chunks.length > 0 && chunks.length <= 4, "recovery_record_corrupt");
    let size = 0;
    const arrays = chunks.map((row, index) => {
      requireLedger(
        row.ordinal === index && row.bytes instanceof ArrayBuffer && row.bytes_type === "blob",
        "recovery_record_corrupt",
      );
      const bytes = new Uint8Array(row.bytes);
      requireLedger(
        bytes.length > 0 &&
          bytes.length <= LEDGER_LIMITS.chunkBytes &&
          bytes.length === row.byte_count,
        "recovery_record_corrupt",
      );
      requireLedger(
        index === chunks.length - 1 || bytes.length === LEDGER_LIMITS.chunkBytes,
        "recovery_record_corrupt",
      );
      requireLedger(
        row.digest_bytes === 64 && row.digest === chunkDigest(bytes, format),
        "recovery_record_corrupt",
      );
      size += bytes.length;
      return bytes;
    });
    requireLedger(size <= LEDGER_LIMITS.recordBytes, "recovery_record_corrupt");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of arrays) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return {
      body: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      chunks: chunks.length,
    };
  }

  load(scope: BookScope): StoredBook | undefined {
    return this.loadCanonical(scope, false);
  }

  /** Internal read only. An active same-port transaction is required; this does
   * not let the ordinary adapter publish into an archive-owned book. */
  loadForArchiveInTransaction(
    transaction: SqliteTransaction,
    scope: CompleteBookScope,
  ): StoredBook {
    requireSqliteTransaction(transaction, this.storage);
    const book = this.loadCanonical(scope, true);
    requireLedger(book, "ledger_not_provisioned");
    return book;
  }

  private loadCanonical(scope: BookScope, archive: boolean): StoredBook | undefined {
    if (Object.hasOwn(scope, "namespaceId"))
      completeScope(scope as CompleteBookScope, this.objectId);
    else validateScope(scope, this.objectId);
    const tables = this.rows(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ledger_metadata', 'ledger_outcomes', 'ledger_chunks', 'ledger_archive_owner', 'ledger_archive_chunks', 'ledger_archive_catalog', 'ledger_archive_restore')",
    );
    requireLedger(
      !tables.some((row) => row.name === "ledger_archive_catalog"),
      "archive_catalog_storage_conflict",
    );
    if (tables.length === 0) return undefined;
    const restoring = tables.some((row) => row.name === "ledger_archive_restore");
    const owned = tables.some(
      (row) =>
        row.name === "ledger_archive_owner" ||
        row.name === "ledger_archive_chunks" ||
        row.name === "ledger_archive_restore",
    );
    requireLedger(archive || !owned, "ledger_archive_owner_required");
    const restoreState = restoring
      ? this.rows(
          "SELECT phase, substr(record_hash, 1, 65) AS record_hash, length(CAST(record_hash AS BLOB)) AS hash_size FROM ledger_archive_restore LIMIT 2",
        )
      : [];
    if (restoring) {
      requireLedger(
        restoreState.length === 1 && restoreState[0]?.phase === "installed",
        "archive_restore_pending",
      );
    }
    requireLedger(
      tables.length === TABLES.length + (archive ? 2 : 0) + (restoring ? 1 : 0),
      "recovery_record_corrupt",
    );
    const metadata = this.rows("SELECT * FROM ledger_metadata LIMIT 2");
    requireLedger(metadata.length === 1, "recovery_record_corrupt");
    const meta = metadata[0];
    requireLedger(
      archive
        ? meta?.archive_owner === ARCHIVE_SQLITE_OWNER
        : !Object.hasOwn(meta ?? {}, "archive_owner") &&
            !Object.hasOwn(meta ?? {}, "archive_selection_hash") &&
            !Object.hasOwn(meta ?? {}, "archive_restore_hash"),
      "ledger_archive_owner_required",
    );
    requireLedger(
      restoring
        ? typeof meta?.archive_restore_hash === "string" &&
            restoreState[0]?.hash_size === 64 &&
            meta.archive_restore_hash === restoreState[0]?.record_hash
        : !Object.hasOwn(meta ?? {}, "archive_restore_hash"),
      "archive_restore_state_corrupt",
    );
    requireLedger(
      meta?.format === LEDGER_FORMAT || meta?.format === COMPACT_LEDGER_FORMAT,
      "ledger_format_unsupported",
    );
    const format = meta.format;
    requireLedger(
      typeof meta.scope === "string" &&
        typeof meta.head === "string" &&
        typeof meta.genesis_digest === "string",
      "recovery_record_corrupt",
    );
    requireLedger(
      meta.scope.length <= 16_384 && meta.head.length <= 16_384,
      "recovery_record_corrupt",
    );
    const storedScope = JSON.parse(meta.scope) as BookScope;
    if (format === COMPACT_LEDGER_FORMAT)
      requireLedger(
        JSON.stringify(storedScope) === meta.scope &&
          JSON.stringify(JSON.parse(meta.head)) === meta.head,
        "recovery_record_corrupt",
      );
    if (format === COMPACT_LEDGER_FORMAT)
      completeScope(storedScope as CompleteBookScope, this.objectId);
    else validateScope(storedScope, this.objectId);
    requireLedger(same(storedScope, scope), "ledger_identity_mismatch");
    const genesis = this.readBody("genesis", format);
    let count = genesis.chunks;
    const rows = this.rows(
      "SELECT * FROM ledger_outcomes ORDER BY sequence_length, sequence LIMIT 1001",
    );
    requireLedger(rows.length <= LEDGER_LIMITS.outcomes, "recovery_record_corrupt");
    const outcomes = rows.map((row, index) => {
      const sequence = (BigInt(index) + 1n).toString();
      requireLedger(
        row.sequence === sequence && row.sequence_length === sequence.length,
        "recovery_segment_gap_detected",
      );
      requireLedger(
        typeof row.header === "string" && row.header.length <= 16_384,
        "recovery_record_corrupt",
      );
      const header = JSON.parse(row.header) as Omit<OutcomeRecord, "body">;
      requireLedger(!Object.hasOwn(header, "body"), "recovery_record_corrupt");
      if (format === COMPACT_LEDGER_FORMAT)
        requireLedger(JSON.stringify(header) === row.header, "recovery_record_corrupt");
      requireLedger(
        header.after?.sequence === sequence &&
          header.commandId === row.command_id &&
          header.revision === row.revision,
        "recovery_record_corrupt",
      );
      const payload = this.readBody(sequence, format);
      count += payload.chunks;
      return { ...header, body: payload.body };
    });
    requireLedger(
      this.rows("SELECT COUNT(*) AS count FROM ledger_chunks")[0]?.count === count,
      "recovery_record_corrupt",
    );
    return {
      format,
      scope: storedScope,
      genesis: genesis.body,
      genesisDigest: meta.genesis_digest,
      head: JSON.parse(meta.head) as LedgerHead,
      outcomes,
    };
  }

  private sourceContext(scopeInput: CompleteBookScope, expectedHead: LedgerHead) {
    const scope = completeScope(scopeInput, this.objectId);
    requireLedger(
      expectedHead !== null &&
        typeof expectedHead === "object" &&
        Object.getOwnPropertySymbols(expectedHead).length === 0,
      "ledger_source_head_invalid",
    );
    const descriptors = Object.getOwnPropertyDescriptors(expectedHead);
    requireLedger(
      Reflect.ownKeys(descriptors).sort().join(",") ===
        "bookRevision,chainHash,configurationHash,configurationRevision,postingSequence,protocolHash,revisionHash,sequence,stateHash",
      "ledger_source_head_invalid",
    );
    const head: Record<string, string> = {};
    for (const [name, descriptor] of Object.entries(descriptors)) {
      requireLedger(
        "value" in descriptor && descriptor.enumerable && typeof descriptor.value === "string",
        "ledger_source_head_invalid",
      );
      requireLedger(
        ["sequence", "bookRevision", "postingSequence", "configurationRevision"].includes(name)
          ? /^(0|[1-9][0-9]{0,19})$/.test(descriptor.value)
          : /^[0-9a-f]{64}$/.test(descriptor.value),
        "ledger_source_head_invalid",
      );
      head[name] = descriptor.value;
    }
    requireLedger(
      typeof head.sequence === "string" &&
        /^(0|[1-9][0-9]{0,19})$/.test(head.sequence) &&
        BigInt(head.sequence) <= BigInt(LEDGER_LIMITS.outcomes),
      "ledger_source_sequence_invalid",
    );
    const text = (value: unknown, byteCount: unknown): value is string =>
      typeof value === "string" &&
      value.length <= 16_384 &&
      new TextEncoder().encode(value).length === byteCount;
    const confirm = () => {
      const rows = this.rows(
        `SELECT ${ARCHIVE_MARKER} AS archive_owned, substr(format, 1, 65) AS format, length(CAST(format AS BLOB)) AS format_bytes, substr(scope, 1, 16385) AS scope, length(CAST(scope AS BLOB)) AS scope_bytes, substr(head, 1, 16385) AS head, length(CAST(head AS BLOB)) AS head_bytes FROM ledger_metadata LIMIT 2`,
      );
      const row = rows[0];
      requireLedger(row === undefined || row.archive_owned === 0, "ledger_archive_owner_required");
      requireLedger(
        rows.length === 1 &&
          row?.format === COMPACT_LEDGER_FORMAT &&
          row.format_bytes === COMPACT_LEDGER_FORMAT.length,
        "ledger_format_unsupported",
      );
      requireLedger(
        text(row.scope, row.scope_bytes) && text(row.head, row.head_bytes),
        "recovery_record_corrupt",
      );
      const actualScope = JSON.parse(row.scope);
      completeScope(actualScope, this.objectId);
      requireLedger(
        JSON.stringify(actualScope) === row.scope && same(actualScope, scope),
        "ledger_identity_mismatch",
      );
      const actualHead = JSON.parse(row.head);
      requireLedger(JSON.stringify(actualHead) === row.head, "recovery_record_corrupt");
      requireLedger(same(actualHead, head), "ledger_head_conflict");
    };
    return { scope, head, text, confirm };
  }

  /** Bounded current-view source fetch. The expected complete record commitment
   * must come from verified canonical history, not caller assertions. This proves
   * one exact source at an unchanged full head, NOT whole-history health/recovery.
   * The owner supplies its durability and live authority/pin barriers. */
  readVerifiedOutcome(
    scopeInput: CompleteBookScope,
    expectedHead: LedgerHead,
    sequence: bigint,
    expectedRecordHash: string,
  ): OutcomeRecord {
    requireLedger(
      typeof sequence === "bigint" && sequence > 0n && sequence <= BigInt(LEDGER_LIMITS.outcomes),
      "ledger_source_sequence_invalid",
    );
    requireLedger(
      typeof expectedRecordHash === "string" && /^[0-9a-f]{64}$/.test(expectedRecordHash),
      "ledger_source_hash_invalid",
    );
    const { head, text, confirm } = this.sourceContext(scopeInput, expectedHead);
    requireLedger(sequence <= BigInt(head.sequence ?? "0"), "ledger_source_sequence_invalid");
    confirm();
    const id = sequence.toString();
    const rows = this.rows(
      "SELECT sequence, sequence_length, substr(command_id, 1, 16385) AS command_id, length(CAST(command_id AS BLOB)) AS command_bytes, substr(revision, 1, 21) AS revision, length(CAST(revision AS BLOB)) AS revision_bytes, substr(header, 1, 16385) AS header, length(CAST(header AS BLOB)) AS header_bytes FROM ledger_outcomes WHERE sequence = ? LIMIT 2",
      id,
    );
    const row = rows[0];
    requireLedger(
      rows.length === 1 && row?.sequence === id && row.sequence_length === id.length,
      "recovery_segment_gap_detected",
    );
    requireLedger(
      text(row.command_id, row.command_bytes) &&
        text(row.header, row.header_bytes) &&
        (row.revision === null
          ? row.revision_bytes === null
          : typeof row.revision === "string" &&
            row.revision.length <= 20 &&
            row.revision.length === row.revision_bytes),
      "recovery_record_corrupt",
    );
    const header = JSON.parse(row.header) as Omit<OutcomeRecord, "body">;
    requireLedger(
      JSON.stringify(header) === row.header &&
        !Object.hasOwn(header, "body") &&
        header.after?.sequence === id &&
        header.commandId === row.command_id &&
        header.revision === row.revision,
      "recovery_record_corrupt",
    );
    const record = { ...header, body: this.readBody(id, COMPACT_LEDGER_FORMAT).body };
    requireLedger(
      verifiedOutcomeRecordHash(record) === expectedRecordHash,
      "ledger_source_commitment_mismatch",
    );
    confirm();
    return Object.freeze(record);
  }

  /** Genesis is also an immutable, bounded source, not a request to load history. */
  readVerifiedGenesis(
    scopeInput: CompleteBookScope,
    expectedHead: LedgerHead,
    expectedDigest: string,
  ): string {
    requireLedger(
      typeof expectedDigest === "string" && /^[0-9a-f]{64}$/.test(expectedDigest),
      "ledger_source_hash_invalid",
    );
    const { scope, confirm } = this.sourceContext(scopeInput, expectedHead);
    confirm();
    const body = this.readBody("genesis", COMPACT_LEDGER_FORMAT).body;
    requireLedger(
      payloadDigest(body, COMPACT_LEDGER_FORMAT) === expectedDigest,
      "ledger_source_commitment_mismatch",
    );
    const aggregate = decodeAggregate(body);
    requireLedger(
      aggregate.state.identity.bookId === scope.bookId &&
        aggregate.state.bookRevision === 0n &&
        aggregate.protocol.retainedResults.length === 0,
      "recovery_record_corrupt",
    );
    confirm();
    return body;
  }

  provision(book: StoredBook): void {
    atomicSqlite(this.storage, (transaction) => this.provisionInTransaction(transaction, book));
  }

  provisionInTransaction(transaction: SqliteTransaction, book: StoredBook): void {
    requireSqliteTransaction(transaction, this.storage);
    requireLedger(
      book.format === LEDGER_FORMAT || book.format === COMPACT_LEDGER_FORMAT,
      "ledger_format_unsupported",
    );
    const format = book.format;
    if (this.load(book.scope) !== undefined) throw new LedgerError("ledger_head_conflict");
    this.rows(
      "CREATE TABLE ledger_metadata (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), format TEXT NOT NULL, scope TEXT NOT NULL, genesis_digest TEXT NOT NULL, head TEXT NOT NULL)",
    );
    this.rows(
      "CREATE TABLE ledger_outcomes (sequence TEXT PRIMARY KEY, sequence_length INTEGER NOT NULL, command_id TEXT NOT NULL UNIQUE, revision TEXT UNIQUE, header TEXT NOT NULL)",
    );
    this.rows(
      "CREATE TABLE ledger_chunks (record_id TEXT NOT NULL, ordinal INTEGER NOT NULL, bytes BLOB NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(record_id, ordinal))",
    );
    this.writeBody("genesis", book.genesis, format);
    this.rows(
      "INSERT INTO ledger_metadata VALUES (1, ?, ?, ?, ?)",
      book.format,
      JSON.stringify(book.scope),
      book.genesisDigest,
      JSON.stringify(book.head),
    );
  }

  commitTransition(expected: LedgerHead, record: OutcomeRecord): void {
    atomicSqlite(this.storage, (transaction) =>
      this.commitTransitionInTransaction(transaction, expected, record),
    );
  }

  /** Internal participation in an already-active, same-port transaction. The
   * complete canonical CAS and record checks are identical to ordinary commit.
   * This does not confirm durability or grant an index root accounting authority. */
  commitTransitionInTransaction(
    transaction: SqliteTransaction,
    expected: LedgerHead,
    record: OutcomeRecord,
  ): void {
    requireSqliteTransaction(transaction, this.storage);
    const row = this.rows(
      `SELECT head, format, ${ARCHIVE_MARKER} AS archive_owned FROM ledger_metadata WHERE singleton = 1`,
    )[0];
    requireLedger(row === undefined || row.archive_owned === 0, "ledger_archive_owner_required");
    requireLedger(
      row?.format === LEDGER_FORMAT || row?.format === COMPACT_LEDGER_FORMAT,
      "ledger_format_unsupported",
    );
    requireLedger(
      typeof row?.head === "string" && same(JSON.parse(row.head), expected),
      "ledger_head_conflict",
    );
    requireLedger(same(record.before, expected), "ledger_head_conflict");
    requireLedger(
      row.format === COMPACT_LEDGER_FORMAT
        ? record.frame?.format.ledgerVersion === COMPACT_LEDGER_FORMAT
        : record.frame === undefined,
      "ledger_format_unsupported",
    );
    const { body, ...header } = record;
    this.rows(
      "INSERT INTO ledger_outcomes VALUES (?, ?, ?, ?, ?)",
      record.after.sequence,
      record.after.sequence.length,
      record.commandId,
      record.revision,
      JSON.stringify(header),
    );
    this.writeBody(record.after.sequence, body, row.format);
    this.rows(
      "UPDATE ledger_metadata SET head = ? WHERE singleton = 1 AND head = ?",
      JSON.stringify(record.after),
      row.head,
    );
    requireLedger(this.rows("SELECT changes() AS count")[0]?.count === 1, "ledger_head_conflict");
  }

  sync(): Promise<void> {
    return this.storage.sync();
  }
}

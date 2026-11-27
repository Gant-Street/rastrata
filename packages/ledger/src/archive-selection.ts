import {
  encodeDurableBook,
  hashCanonical,
  immutableAccountingValue,
  type BookCommandResult,
  type DurableBookAggregate,
} from "@rastrata/kernel";
import {
  readArchiveCatalogEntry,
  type ArchiveCatalogAuthority,
  type ArchiveBookHeadEvidence,
} from "./archive-authority.ts";
import {
  normalizeArchiveCatalogSnapshot,
  type ArchiveCatalogReader,
  type ArchiveCatalogSnapshot,
} from "./archive-catalog.ts";
import {
  createArchiveDurabilityPolicy,
  decodeArchiveAnchor,
  decodeArchiveManifest,
  encodeArchiveAnchor,
  encodeArchiveManifest,
  prepareArchiveCommit,
  prepareArchiveGenesis,
  recoverArchiveChain,
  type ArchiveAnchor,
  type ArchiveCommitManifest,
} from "./archive-records.ts";
import { compactGenesisHead, compactOutcomeRecord, completeScope } from "./compact-records.ts";
import { replayOutcomePayload } from "./outcome-payload.ts";
import {
  referenceArchivePayload,
  type ArchiveControlVersion,
  type R2ArchiveObjectStore,
} from "./r2-archive-store.ts";
import {
  COMPACT_LEDGER_FORMAT,
  LEDGER_LIMITS,
  chunkDigest,
  decodeAggregate,
  requireLedger,
  same,
  type CompleteBookScope,
  type LedgerHead,
} from "./records.ts";
import {
  ARCHIVE_SQLITE_OWNER,
  SqliteBookStorage,
  type SqliteStorage,
  type SqlBinding,
} from "./sqlite.ts";
import { atomicSqlite, type SqliteTransaction } from "./sqlite-transaction.ts";
import type { LedgerSnapshot } from "./ledger.ts";
import { prepareArchiveRestoreImage, type ArchiveRestoreImage } from "./archive-restore.ts";
import {
  readRestoreState,
  prepareRestoreState,
  encodeRestoreState,
  type ArchiveRestoreState,
} from "./archive-restore-state.ts";

const policy = createArchiveDurabilityPolicy(true);
const encoder = new TextEncoder();
const hashHeader = (header: string) =>
  hashCanonical({ domain: ARCHIVE_SQLITE_OWNER, header }).digest;
const ABANDONMENT = "rastrata-archive-abandonment-v1";
const hashAbandonment = (record: string) => hashCanonical({ domain: ABANDONMENT, record }).digest;

/** Historical recovery receipt, not a financial outcome or current readiness.
 * Retain the most recent abandonment across later selection/materialization;
 * older superseded maintenance requests fail closed instead of being reapplied. */
export interface ArchiveAbandonment {
  readonly version: typeof ABANDONMENT;
  readonly selectionHash: string;
  readonly priorAnchor: ArchiveAnchor;
  readonly catalog: ArchiveCatalogSnapshot;
  readonly contentHash: string;
}

export interface SelectedArchiveOutcome {
  readonly selectionHash: string;
  readonly encodedOutcome: string;
  readonly manifest: ArchiveCommitManifest;
  readonly expectedAnchor: ArchiveAnchor;
  readonly expectedControl: ArchiveControlVersion;
}

/** Local archive component, NOT a BookStorageAdapter or network gateway.
 * Only new books can opt in. Reservation never advances canonical SQL or R2 and
 * abandonment requires a durably sealed, strictly newer catalog/R2 fence.
 * Publication/materialization/abandonment are recovery operations, not
 * public receipts. ArchiveLedger coordinates admitted financial snapshots/receipts;
 * the application must still supply authenticated routing and caller authorization.
 * Full local replay remains mandatory; this is not the scalable indexed path. */
export class SqliteArchiveSelection {
  private readonly scope: CompleteBookScope;
  private readonly canonical: SqliteBookStorage;

  constructor(
    objectId: string,
    private readonly storage: SqliteStorage,
    scope: CompleteBookScope,
  ) {
    this.scope = completeScope(scope, objectId);
    this.canonical = new SqliteBookStorage(objectId, storage);
  }

  private rows(sql: string, ...bindings: SqlBinding[]) {
    return Array.from(this.storage.sql.exec(sql, ...bindings));
  }

  private reference(encoded: string) {
    requireLedger(
      typeof encoded === "string" && encoded.length <= LEDGER_LIMITS.recordBytes,
      "archive_invalid_input",
    );
    return referenceArchivePayload(this.scope, this.scope.objectId, encoder.encode(encoded));
  }

  /** Reserve exact genesis locally. This is neither archive initialization nor
   * catalog activation; the ordinary SQL-only owner must refuse it immediately. */
  async reserveBook(encodedGenesis: string): Promise<void> {
    const manifest = prepareArchiveGenesis(
      this.scope,
      policy,
      encodedGenesis,
      this.reference(encodedGenesis),
    );
    const encodedManifest = encodeArchiveManifest(manifest);
    atomicSqlite(this.storage, (transaction) => {
      const markers = this.rows(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ledger_archive_owner', 'ledger_archive_chunks')",
      );
      if (markers.length) {
        const existing = this.load(transaction);
        requireLedger(
          existing.book.genesis === encodedGenesis && existing.genesisManifest === encodedManifest,
          "archive_genesis_mismatch",
        );
        return;
      }
      requireLedger(this.canonical.load(this.scope) === undefined, "archive_new_book_required");
      requireLedger(
        this.rows(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'ledger_*' LIMIT 1",
        ).length === 0,
        "archive_new_book_required",
      );
      this.canonical.provisionInTransaction(transaction, {
        format: COMPACT_LEDGER_FORMAT,
        scope: this.scope,
        genesis: encodedGenesis,
        genesisDigest: manifest.genesisHash,
        head: manifest.initialHead,
        outcomes: [],
      });
      this.rows(
        `ALTER TABLE ledger_metadata ADD COLUMN archive_owner TEXT NOT NULL DEFAULT '${ARCHIVE_SQLITE_OWNER}'`,
      );
      this.rows("ALTER TABLE ledger_metadata ADD COLUMN archive_selection_hash TEXT");
      this.rows(
        "CREATE TABLE ledger_archive_owner (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), profile TEXT NOT NULL, genesis_manifest TEXT NOT NULL, pending_header TEXT, pending_hash TEXT, last_header TEXT, last_hash TEXT, abandonment_record TEXT, abandonment_hash TEXT)",
      );
      this.rows(
        "CREATE TABLE ledger_archive_chunks (ordinal INTEGER PRIMARY KEY, bytes BLOB NOT NULL, digest TEXT NOT NULL)",
      );
      this.rows(
        "INSERT INTO ledger_archive_owner VALUES (1, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)",
        ARCHIVE_SQLITE_OWNER,
        encodedManifest,
      );
    });
    await this.storage.sync();
  }

  private readBody(): string {
    const rows = this.rows(
      "SELECT ordinal, substr(bytes, 1, 262145) AS bytes, length(bytes) AS size, typeof(bytes) AS kind, substr(digest, 1, 65) AS digest, length(CAST(digest AS BLOB)) AS digest_size FROM ledger_archive_chunks ORDER BY ordinal LIMIT 5",
    );
    requireLedger(rows.length > 0 && rows.length <= 4, "archive_selection_corrupt");
    const chunks = rows.map((row, index) => {
      requireLedger(
        row.ordinal === index && row.kind === "blob" && row.bytes instanceof ArrayBuffer,
        "archive_selection_corrupt",
      );
      const bytes = new Uint8Array(row.bytes);
      requireLedger(
        bytes.length > 0 &&
          bytes.length <= LEDGER_LIMITS.chunkBytes &&
          bytes.length === row.size &&
          (index === rows.length - 1 || bytes.length === LEDGER_LIMITS.chunkBytes),
        "archive_selection_corrupt",
      );
      requireLedger(
        row.digest_size === 64 && row.digest === chunkDigest(bytes, COMPACT_LEDGER_FORMAT),
        "archive_selection_corrupt",
      );
      return bytes;
    });
    const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  }

  /** Inspect only the owned slot/identity here: damaged financial chunks are
   * precisely what authorized replacement must recover. Unknown tables, another
   * identity/profile or an intact head newer than the permit are never erased. */
  private restoreSlot(catalog: ArchiveCatalogSnapshot): string[] {
    const names = this.rows(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'ledger_*' LIMIT 7",
    ).map((row) => row.name);
    const owned = [
      "ledger_metadata",
      "ledger_outcomes",
      "ledger_chunks",
      "ledger_archive_owner",
      "ledger_archive_chunks",
      "ledger_archive_restore",
    ];
    requireLedger(
      names.length <= owned.length &&
        names.every((name) => typeof name === "string" && owned.includes(name)),
      "archive_restore_storage_conflict",
    );
    // DROP TABLE can cascade through foreign keys into otherwise unrelated
    // tables. A name allowlist alone therefore does not bound destructive scope.
    requireLedger(
      this.rows(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('ledger_metadata', 'ledger_outcomes', 'ledger_chunks', 'ledger_archive_owner', 'ledger_archive_chunks', 'ledger_archive_restore') LIMIT 1",
      ).length === 0,
      "archive_restore_storage_conflict",
    );
    requireLedger(
      this.rows(
        "SELECT m.name FROM sqlite_master AS m JOIN pragma_foreign_key_list(m.name) AS f WHERE m.type = 'table' AND m.name NOT IN ('ledger_metadata', 'ledger_outcomes', 'ledger_chunks', 'ledger_archive_owner', 'ledger_archive_chunks', 'ledger_archive_restore') AND f.\"table\" IN ('ledger_metadata', 'ledger_outcomes', 'ledger_chunks', 'ledger_archive_owner', 'ledger_archive_chunks', 'ledger_archive_restore') LIMIT 1",
      ).length === 0,
      "archive_restore_storage_conflict",
    );
    const canonical = names.filter((name) => name !== "ledger_archive_restore");
    if (canonical.length) {
      requireLedger(names.includes("ledger_metadata"), "archive_restore_identity_unverified");
      const installedMarker = this.rows(
        "SELECT name FROM pragma_table_info('ledger_metadata') WHERE name = 'archive_restore_hash'",
      );
      requireLedger(
        installedMarker.length === 0 || names.includes("ledger_archive_restore"),
        "archive_restore_state_corrupt",
      );
      const rows = this.rows(
        "SELECT singleton, format, substr(scope, 1, 16385) AS scope, length(CAST(scope AS BLOB)) AS scope_size, substr(genesis_digest, 1, 65) AS genesis_digest, length(CAST(genesis_digest AS BLOB)) AS genesis_size, archive_owner, substr(head, 1, 16385) AS head FROM ledger_metadata LIMIT 2",
      );
      const row = rows[0];
      requireLedger(
        rows.length === 1 &&
          row?.singleton === 1 &&
          row.format === COMPACT_LEDGER_FORMAT &&
          row.archive_owner === ARCHIVE_SQLITE_OWNER &&
          row.genesis_size === 64 &&
          row.genesis_digest === catalog.entry.genesisHash &&
          typeof row.scope === "string" &&
          typeof row.scope_size === "number" &&
          row.scope_size <= 16_384 &&
          encoder.encode(row.scope).length === row.scope_size,
        "archive_restore_identity_unverified",
      );
      const identity = completeScope(JSON.parse(row.scope), this.scope.objectId);
      requireLedger(
        same(identity, this.scope) && JSON.stringify(identity) === row.scope,
        "archive_restore_identity_unverified",
      );
      let head: unknown;
      try {
        head = typeof row.head === "string" ? JSON.parse(row.head) : undefined;
      } catch {
        /* Damaged financial metadata is replaceable under this permit. */
      }
      if (
        head !== null &&
        typeof head === "object" &&
        "sequence" in head &&
        typeof head.sequence === "string" &&
        /^(0|[1-9][0-9]{0,63})$/.test(head.sequence)
      ) {
        requireLedger(
          catalog.restorePermit !== null &&
            BigInt(head.sequence) <= BigInt(catalog.restorePermit.anchor.head.sequence),
          "archive_restore_would_rollback",
        );
      }
    }
    return canonical as string[];
  }

  private writeRestoreBody(id: string, body: string) {
    const bytes = encoder.encode(body);
    requireLedger(
      bytes.length > 0 && bytes.length <= LEDGER_LIMITS.recordBytes,
      "archive_record_capacity_exceeded",
    );
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
        chunkDigest(chunk, COMPACT_LEDGER_FORMAT),
      );
    }
  }

  /** Called only inside the install transaction with an authenticated image;
   * never expose a general-purpose raw replacement API or SQL-only bypass. */
  private writeRestoreImage(image: ArchiveRestoreImage, restoreStateHash: string) {
    this.rows(
      "CREATE TABLE ledger_metadata (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), format TEXT NOT NULL, scope TEXT NOT NULL, genesis_digest TEXT NOT NULL, head TEXT NOT NULL, archive_owner TEXT NOT NULL, archive_selection_hash TEXT, archive_restore_hash TEXT NOT NULL)",
    );
    this.rows(
      "CREATE TABLE ledger_outcomes (sequence TEXT PRIMARY KEY, sequence_length INTEGER NOT NULL, command_id TEXT NOT NULL UNIQUE, revision TEXT UNIQUE, header TEXT NOT NULL)",
    );
    this.rows(
      "CREATE TABLE ledger_chunks (record_id TEXT NOT NULL, ordinal INTEGER NOT NULL, bytes BLOB NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(record_id, ordinal))",
    );
    this.rows(
      "CREATE TABLE ledger_archive_owner (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), profile TEXT NOT NULL, genesis_manifest TEXT NOT NULL, pending_header TEXT, pending_hash TEXT, last_header TEXT, last_hash TEXT, abandonment_record TEXT, abandonment_hash TEXT)",
    );
    this.rows(
      "CREATE TABLE ledger_archive_chunks (ordinal INTEGER PRIMARY KEY, bytes BLOB NOT NULL, digest TEXT NOT NULL)",
    );
    this.rows(
      "INSERT INTO ledger_metadata VALUES (1, ?, ?, ?, ?, ?, NULL, ?)",
      image.book.format,
      JSON.stringify(this.scope),
      image.book.genesisDigest,
      JSON.stringify(image.book.head),
      ARCHIVE_SQLITE_OWNER,
      restoreStateHash,
    );
    this.rows(
      "INSERT INTO ledger_archive_owner VALUES (1, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)",
      ARCHIVE_SQLITE_OWNER,
      encodeArchiveManifest(image.genesisManifest),
    );
    this.writeRestoreBody("genesis", image.book.genesis);
    for (const outcome of image.book.outcomes) {
      const { body, ...header } = outcome;
      this.rows(
        "INSERT INTO ledger_outcomes VALUES (?, ?, ?, ?, ?)",
        outcome.after.sequence,
        outcome.after.sequence.length,
        outcome.commandId,
        outcome.revision,
        JSON.stringify(header),
      );
      this.writeRestoreBody(outcome.after.sequence, body);
    }
  }

  /** Historical installation result only; neither public readiness nor a current
   * absence barrier. Even after later postings, exact retries never overwrite. */
  private restoredReceipt(
    transaction: SqliteTransaction,
    state: ArchiveRestoreState,
    disposition: "installed" | "already-installed",
  ) {
    const current = this.load(transaction);
    const permit = state.catalog.restorePermit;
    requireLedger(
      state.phase === "installed" &&
        permit !== null &&
        current.restore?.contentHash === state.contentHash,
      "archive_restore_state_corrupt",
    );
    return immutableAccountingValue({
      disposition,
      permitHash: permit.contentHash,
      restoredHead: permit.anchor.head,
      restoreStateHash: state.contentHash,
    });
  }

  /** Authorized in-place restore of this exact book slot. Canonical tables may
   * be absent or damaged, but readable identity must match and unknown objects
   * are not removed. A durable local reservation blocks all normal owner paths.
   * Its full-record CAS survives download/restart and excludes late installers.
   * The external catalog remains in maintenance until separate verified finish.
   * No historical publisher nonce/ETag or replacement accounting result is made. */
  async restoreFromArchive(
    store: R2ArchiveObjectStore,
    authority: ArchiveCatalogReader,
    catalogHash: string,
    permitHash: string,
  ) {
    requireLedger(
      typeof catalogHash === "string" &&
        /^[0-9a-f]{64}$/.test(catalogHash) &&
        typeof permitHash === "string" &&
        /^[0-9a-f]{64}$/.test(permitHash),
      "archive_restore_permit_invalid",
    );
    const matches = (state: ArchiveRestoreState) =>
      state.catalog.contentHash === catalogHash &&
      state.catalog.restorePermit?.contentHash === permitHash;
    await this.storage.sync();
    const prior = atomicSqlite(this.storage, (transaction) => {
      const state = readRestoreState(this.storage, this.scope);
      return state?.phase === "installed" && matches(state)
        ? this.restoredReceipt(transaction, state, "already-installed")
        : undefined;
    });
    if (prior) {
      await this.storage.sync();
      return prior;
    }
    const catalog = normalizeArchiveCatalogSnapshot(
      await authority.read(),
      this.scope,
      authority.catalogObjectId,
    );
    requireLedger(catalog.contentHash === catalogHash, "archive_catalog_head_conflict");
    requireLedger(
      catalog.entry.status === "maintenance" &&
        catalog.sealed !== null &&
        catalog.restorePermit !== null &&
        catalog.restorePermit.contentHash === permitHash &&
        catalog.restorePermit.entry.fenceGeneration === catalog.entry.fenceGeneration,
      "archive_restore_not_authorized",
    );
    const intent = prepareRestoreState(this.scope, "selected", catalog, null, null);
    const selected = atomicSqlite(this.storage, () => {
      const current = readRestoreState(this.storage, this.scope);
      if (current && matches(current)) return current;
      requireLedger(
        current === undefined ||
          BigInt(current.catalog.entry.fenceGeneration) < BigInt(catalog.entry.fenceGeneration),
        "archive_restore_selection_changed",
      );
      this.restoreSlot(catalog);
      if (current === undefined) {
        this.rows(
          "CREATE TABLE ledger_archive_restore (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), phase TEXT NOT NULL, record TEXT NOT NULL, record_hash TEXT NOT NULL)",
        );
        this.rows(
          "INSERT INTO ledger_archive_restore VALUES (1, ?, ?, ?)",
          intent.phase,
          encodeRestoreState(intent),
          intent.contentHash,
        );
      } else {
        this.rows(
          "UPDATE ledger_archive_restore SET phase = ?, record = ?, record_hash = ? WHERE singleton = 1 AND record_hash = ?",
          intent.phase,
          encodeRestoreState(intent),
          intent.contentHash,
          current.contentHash,
        );
        requireLedger(
          this.rows("SELECT changes() AS count")[0]?.count === 1,
          "archive_restore_selection_changed",
        );
      }
      return intent;
    });
    await this.storage.sync();
    if (selected.phase === "installed") {
      const receipt = atomicSqlite(this.storage, (transaction) =>
        this.restoredReceipt(transaction, selected, "already-installed"),
      );
      await this.storage.sync();
      return receipt;
    }
    const image = await prepareArchiveRestoreImage(
      store,
      authority,
      this.scope,
      this.scope.objectId,
      catalogHash,
      permitHash,
    );
    const installed = prepareRestoreState(
      this.scope,
      "installed",
      catalog,
      image.lastManifest,
      image.lastPredecessorManifest,
    );
    const receipt = atomicSqlite(this.storage, (transaction) => {
      const current = readRestoreState(this.storage, this.scope);
      if (current?.phase === "installed" && matches(current))
        return this.restoredReceipt(transaction, current, "already-installed");
      requireLedger(
        current?.phase === "selected" && current.contentHash === selected.contentHash,
        "archive_restore_selection_changed",
      );
      const tables = this.restoreSlot(catalog);
      // Exact internal allowlist, validated above; preserve the restore marker.
      for (const name of [
        "ledger_archive_owner",
        "ledger_archive_chunks",
        "ledger_chunks",
        "ledger_outcomes",
        "ledger_metadata",
      ])
        if (tables.includes(name)) this.rows(`DROP TABLE ${name}`);
      this.writeRestoreImage(image, installed.contentHash);
      this.rows(
        "UPDATE ledger_archive_restore SET phase = ?, record = ?, record_hash = ? WHERE singleton = 1 AND record_hash = ?",
        installed.phase,
        encodeRestoreState(installed),
        installed.contentHash,
        selected.contentHash,
      );
      requireLedger(
        this.rows("SELECT changes() AS count")[0]?.count === 1,
        "archive_restore_selection_changed",
      );
      return this.restoredReceipt(transaction, installed, "installed");
    });
    await this.storage.sync();
    return receipt;
  }

  private load(transaction: SqliteTransaction) {
    const restore = readRestoreState(this.storage, this.scope);
    requireLedger(restore?.phase !== "selected", "archive_restore_pending");
    const book = this.canonical.loadForArchiveInTransaction(transaction, this.scope);
    requireLedger(book.format === COMPACT_LEDGER_FORMAT, "ledger_format_unsupported");
    const rows = this.rows(
      "SELECT singleton, substr(profile, 1, 65) AS profile, length(CAST(profile AS BLOB)) AS profile_size, substr(genesis_manifest, 1, 65537) AS genesis_manifest, length(CAST(genesis_manifest AS BLOB)) AS genesis_size, substr(pending_header, 1, 65537) AS pending_header, length(CAST(pending_header AS BLOB)) AS header_size, substr(pending_hash, 1, 65) AS pending_hash, length(CAST(pending_hash AS BLOB)) AS hash_size, substr(last_header, 1, 65537) AS last_header, length(CAST(last_header AS BLOB)) AS last_size, substr(last_hash, 1, 65) AS last_hash, length(CAST(last_hash AS BLOB)) AS last_hash_size FROM ledger_archive_owner LIMIT 2",
    );
    const row = rows[0];
    requireLedger(
      rows.length === 1 &&
        row?.singleton === 1 &&
        row.profile === ARCHIVE_SQLITE_OWNER &&
        row.profile_size === ARCHIVE_SQLITE_OWNER.length,
      "archive_selection_corrupt",
    );
    const boundedText = (value: unknown, size: unknown): value is string =>
      typeof value === "string" &&
      typeof size === "number" &&
      size <= 65_536 &&
      value.length <= 65_536 &&
      encoder.encode(value).length === size;
    requireLedger(boundedText(row.genesis_manifest, row.genesis_size), "archive_selection_corrupt");
    const genesis = prepareArchiveGenesis(
      this.scope,
      policy,
      book.genesis,
      this.reference(book.genesis),
    );
    const genesisManifest = encodeArchiveManifest(genesis);
    requireLedger(
      row.genesis_manifest === genesisManifest && book.genesisDigest === genesis.genesisHash,
      "archive_genesis_mismatch",
    );
    let aggregate = decodeAggregate(book.genesis);
    let head = compactGenesisHead(this.scope, book.genesis);
    let beforeLast: { aggregate: DurableBookAggregate; head: LedgerHead } | undefined;
    let beforeRestore: { aggregate: DurableBookAggregate; head: LedgerHead } | undefined;
    const originals: { commandId: string; sequence: bigint; result: BookCommandResult }[] = [];
    // Use the same exact receipt replay and frame reconstruction as the ordinary
    // owner. No trusted persisted state hash, checkpoint shortcut or new math.
    for (const stored of book.outcomes) {
      beforeLast = { aggregate, head };
      if (stored.after.sequence === restore?.catalog.restorePermit?.anchor.head.sequence)
        beforeRestore = { aggregate, head };
      requireLedger(same(stored.before, head), "recovery_segment_gap_detected");
      const transition = replayOutcomePayload(aggregate, stored.body);
      const expected = compactOutcomeRecord(this.scope, head, transition, stored.body);
      requireLedger(same(expected, stored), "recovery_record_corrupt");
      originals.push({
        commandId: stored.commandId,
        sequence: BigInt(stored.after.sequence),
        result: transition.result,
      });
      aggregate = { state: transition.state, protocol: transition.protocol };
      head = expected.after;
    }
    requireLedger(same(head, book.head), "recovery_head_mismatch");
    if (restore) {
      const permit = restore.catalog.restorePermit;
      requireLedger(
        permit !== null &&
          restore.manifest !== null &&
          permit.entry.genesisHash === book.genesisDigest,
        "archive_restore_state_corrupt",
      );
      const sequence = BigInt(permit.anchor.head.sequence);
      requireLedger(sequence <= BigInt(head.sequence), "archive_restore_state_corrupt");
      const cutoff =
        sequence === 0n ? genesis.initialHead : book.outcomes[Number(sequence) - 1]?.after;
      requireLedger(same(cutoff, permit.anchor.head), "archive_restore_state_corrupt");
      const restoredManifest = decodeArchiveManifest(restore.manifest);
      if (sequence === 0n)
        requireLedger(restore.manifest === genesisManifest, "archive_restore_state_corrupt");
      else {
        const outcome = book.outcomes[Number(sequence) - 1];
        requireLedger(
          beforeRestore &&
            outcome &&
            restoredManifest.kind === "commit" &&
            restore.predecessorManifest !== null,
          "archive_restore_state_corrupt",
        );
        const prepared = prepareArchiveCommit(
          decodeArchiveManifest(restore.predecessorManifest),
          restoredManifest.priorManifest,
          beforeRestore.aggregate,
          outcome.body,
          this.reference(outcome.body),
          restoredManifest.candidateId,
          restoredManifest.fenceGeneration,
        );
        requireLedger(
          encodeArchiveManifest(prepared.manifest) === restore.manifest,
          "archive_restore_state_corrupt",
        );
      }
    }
    let last: SelectedArchiveOutcome | undefined;
    const lastOutcome = book.outcomes.at(-1);
    if (!lastOutcome || (restore && same(restore.catalog.restorePermit?.anchor.head, head))) {
      requireLedger(
        row.last_header === null && row.last_hash === null,
        "archive_materialization_corrupt",
      );
    } else {
      requireLedger(
        beforeLast &&
          boundedText(row.last_header, row.last_size) &&
          row.last_hash_size === 64 &&
          row.last_hash === hashHeader(row.last_header),
        "archive_materialization_corrupt",
      );
      last = this.decodeSelection(
        row.last_header,
        row.last_hash as string,
        lastOutcome.body,
        beforeLast.aggregate,
        beforeLast.head,
      );
      requireLedger(same(last.manifest.resulting, head), "archive_materialization_corrupt");
    }
    const marker = this.rows(
      "SELECT substr(archive_selection_hash, 1, 65) AS hash, length(CAST(archive_selection_hash AS BLOB)) AS size FROM ledger_metadata WHERE singleton = 1",
    )[0];
    let pending: SelectedArchiveOutcome | undefined;
    if (row.pending_header === null) {
      requireLedger(
        marker?.hash === null &&
          row.pending_hash === null &&
          this.rows("SELECT count(*) AS count FROM ledger_archive_chunks")[0]?.count === 0,
        "archive_selection_corrupt",
      );
    } else {
      requireLedger(
        boundedText(row.pending_header, row.header_size) &&
          row.hash_size === 64 &&
          row.pending_hash === hashHeader(row.pending_header),
        "archive_selection_corrupt",
      );
      requireLedger(
        marker?.size === 64 && marker.hash === row.pending_hash,
        "archive_selection_corrupt",
      );
      pending = this.decodeSelection(
        row.pending_header,
        row.pending_hash as string,
        this.readBody(),
        aggregate,
        head,
      );
    }
    const abandonmentRow = this.rows(
      "SELECT substr(abandonment_record, 1, 65537) AS record, length(CAST(abandonment_record AS BLOB)) AS size, substr(abandonment_hash, 1, 65) AS hash, length(CAST(abandonment_hash AS BLOB)) AS hash_size FROM ledger_archive_owner WHERE singleton = 1",
    )[0];
    let abandoned: ArchiveAbandonment | undefined;
    if (abandonmentRow?.record === null) {
      requireLedger(abandonmentRow.hash === null, "archive_abandonment_corrupt");
    } else {
      requireLedger(
        abandonmentRow &&
          boundedText(abandonmentRow.record, abandonmentRow.size) &&
          abandonmentRow.hash_size === 64 &&
          abandonmentRow.hash === hashAbandonment(abandonmentRow.record),
        "archive_abandonment_corrupt",
      );
      abandoned = this.decodeAbandonment(abandonmentRow.record, book.genesisDigest);
      const sequence = BigInt(abandoned.priorAnchor.head.sequence);
      requireLedger(sequence <= BigInt(head.sequence), "archive_abandonment_corrupt");
      const priorHead =
        sequence === 0n
          ? compactGenesisHead(this.scope, book.genesis)
          : book.outcomes[Number(sequence) - 1]?.after;
      requireLedger(same(priorHead, abandoned.priorAnchor.head), "archive_abandonment_corrupt");
      requireLedger(
        pending?.selectionHash !== abandoned.selectionHash,
        "archive_abandonment_corrupt",
      );
    }
    const canonicalManifest = last
      ? encodeArchiveManifest(last.manifest)
      : (restore?.manifest ?? genesisManifest);
    return {
      book,
      aggregate,
      genesisManifest,
      pending,
      last,
      abandoned,
      restore,
      canonicalManifest,
      originals,
    };
  }

  private decodeAbandonment(text: string, genesisHash: string): ArchiveAbandonment {
    const value = JSON.parse(text);
    requireLedger(
      value !== null &&
        typeof value === "object" &&
        Object.keys(value).sort().join(",") === "catalog,priorAnchor,selectionHash,version" &&
        value.version === ABANDONMENT &&
        typeof value.selectionHash === "string" &&
        /^[0-9a-f]{64}$/.test(value.selectionHash),
      "archive_abandonment_corrupt",
    );
    const priorAnchor = decodeArchiveAnchor(encodeArchiveAnchor(value.priorAnchor));
    const catalog = normalizeArchiveCatalogSnapshot(
      value.catalog,
      this.scope,
      value.catalog?.catalogObjectId,
    );
    requireLedger(
      catalog.entry.genesisHash === genesisHash &&
        catalog.entry.status === "maintenance" &&
        catalog.sealed !== null &&
        BigInt(catalog.entry.fenceGeneration) > BigInt(priorAnchor.fenceGeneration) &&
        encodeArchiveAnchor({ ...priorAnchor, fenceGeneration: catalog.entry.fenceGeneration }) ===
          encodeArchiveAnchor(catalog.sealed.anchor),
      "archive_abandonment_corrupt",
    );
    const body = { version: ABANDONMENT, selectionHash: value.selectionHash, priorAnchor, catalog };
    requireLedger(JSON.stringify(body) === text, "archive_abandonment_corrupt");
    return immutableAccountingValue({
      ...body,
      contentHash: hashAbandonment(text),
    }) as ArchiveAbandonment;
  }

  /** Clear ONLY an unpublished selection excluded by a newer sealed fence.
   * There is no cross-object transaction: the last catalog/control observations
   * precede local CAS. Safety rests on the irreversible exclusion of the old
   * publisher, not on claiming the catalog cannot change after an await. This
   * operation never releases maintenance, changes a financial head, or returns
   * an absence/public-read barrier. Only the latest exact retry is retained. */
  async abandonUnpublished(
    store: R2ArchiveObjectStore,
    authority: ArchiveCatalogReader,
    selectionHash: string,
    catalogHash: string,
  ): Promise<{ disposition: "abandoned" | "already-abandoned"; evidence: ArchiveAbandonment }> {
    requireLedger(
      typeof selectionHash === "string" &&
        /^[0-9a-f]{64}$/.test(selectionHash) &&
        typeof catalogHash === "string" &&
        /^[0-9a-f]{64}$/.test(catalogHash),
      "archive_invalid_input",
    );
    const before = await this.snapshot();
    const retry = (current: typeof before) => {
      requireLedger(
        current.pending === undefined &&
          current.abandoned?.selectionHash === selectionHash &&
          current.abandoned.catalog.contentHash === catalogHash,
        "archive_selection_changed",
      );
      return { disposition: "already-abandoned" as const, evidence: current.abandoned };
    };
    if (!before.pending) return retry(before);
    const selected = before.pending;
    requireLedger(selected.selectionHash === selectionHash, "archive_selection_changed");
    const readCatalog = async () => {
      const current = normalizeArchiveCatalogSnapshot(
        await authority.read(),
        this.scope,
        authority.catalogObjectId,
      );
      requireLedger(current.contentHash === catalogHash, "archive_catalog_head_conflict");
      requireLedger(
        current.entry.genesisHash === before.book.genesisDigest &&
          current.entry.status === "maintenance" &&
          current.sealed !== null,
        "archive_abandonment_not_sealed",
      );
      return current;
    };
    const catalog = await readCatalog();
    // decodeAbandonment checks strict fence increase and exact prior full head,
    // manifest locator/hash, scope, format and policy. A published member has a
    // different anchor and cannot pass this branch, even under a newer fence.
    const record = JSON.stringify({
      version: ABANDONMENT,
      selectionHash,
      priorAnchor: selected.expectedAnchor,
      catalog,
    });
    requireLedger(encoder.encode(record).length <= 65_536, "archive_capacity_exceeded");
    const evidence = this.decodeAbandonment(record, before.book.genesisDigest);
    const sealed = catalog.sealed;
    requireLedger(sealed !== null, "archive_abandonment_not_sealed");
    const recovered = await recoverArchiveChain(store, sealed.anchor, policy);
    const matchesControl = (control: ArchiveControlVersion | null) =>
      control !== null &&
      control.body === sealed.control.body &&
      control.storageRevision === sealed.control.storageRevision &&
      control.nonce === sealed.control.nonce;
    requireLedger(matchesControl(recovered.control), "archive_book_control_changed");
    requireLedger(matchesControl(await store.readControl()), "archive_book_control_changed");
    await readCatalog();
    const result = atomicSqlite(this.storage, (transaction) => {
      const current = this.load(transaction);
      if (!current.pending) return retry(current);
      requireLedger(current.pending.selectionHash === selectionHash, "archive_selection_changed");
      requireLedger(
        same(current.book.head, selected.expectedAnchor.head) &&
          encodeDurableBook(current.aggregate) === encodeDurableBook(recovered.aggregate) &&
          current.canonicalManifest === encodeArchiveManifest(recovered.manifest),
        "archive_book_head_mismatch",
      );
      this.rows(
        "UPDATE ledger_archive_owner SET abandonment_record = ?, abandonment_hash = ?, pending_header = NULL, pending_hash = NULL WHERE singleton = 1 AND pending_hash = ?",
        record,
        evidence.contentHash,
        selectionHash,
      );
      requireLedger(
        this.rows("SELECT changes() AS changes")[0]?.changes === 1,
        "archive_selection_changed",
      );
      this.rows("DELETE FROM ledger_archive_chunks");
      this.rows(
        "UPDATE ledger_metadata SET archive_selection_hash = NULL WHERE singleton = 1 AND archive_selection_hash = ?",
        selectionHash,
      );
      requireLedger(
        this.rows("SELECT changes() AS changes")[0]?.changes === 1,
        "archive_selection_changed",
      );
      const after = this.load(transaction);
      requireLedger(
        after.pending === undefined &&
          after.abandoned?.contentHash === evidence.contentHash &&
          same(after.book.head, current.book.head),
        "archive_abandonment_corrupt",
      );
      return { disposition: "abandoned" as const, evidence };
    });
    await this.storage.sync();
    return result;
  }

  private decodeSelection(
    headerText: string,
    selectionHash: string,
    encodedOutcome: string,
    aggregate: DurableBookAggregate,
    head: LedgerHead,
  ): SelectedArchiveOutcome {
    const header = JSON.parse(headerText);
    requireLedger(
      header !== null &&
        typeof header === "object" &&
        Object.keys(header).sort().join(",") === "anchor,control,manifest,priorManifest,version" &&
        header.version === ARCHIVE_SQLITE_OWNER,
      "archive_selection_corrupt",
    );
    const anchor = decodeArchiveAnchor(header.anchor);
    const prior = decodeArchiveManifest(header.priorManifest);
    requireLedger(
      prior.durabilityPolicy.contentHash === policy.contentHash,
      "archive_selection_corrupt",
    );
    const manifest = decodeArchiveManifest(header.manifest);
    requireLedger(manifest.kind === "commit", "archive_selection_corrupt");
    const control = header.control;
    requireLedger(
      control !== null &&
        typeof control === "object" &&
        Object.keys(control).sort().join(",") === "body,nonce,storageRevision" &&
        control.body === header.anchor &&
        typeof control.storageRevision === "string" &&
        control.storageRevision.length > 0 &&
        control.storageRevision.length <= 1_024 &&
        typeof control.nonce === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(control.nonce),
      "archive_selection_corrupt",
    );
    requireLedger(
      same(anchor.identity, this.scope) &&
        same(anchor.head, head) &&
        anchor.manifestHash === prior.contentHash &&
        JSON.stringify(anchor.manifest) === JSON.stringify(this.reference(header.priorManifest)) &&
        anchor.fenceGeneration === manifest.fenceGeneration,
      "archive_selection_corrupt",
    );
    const prepared = prepareArchiveCommit(
      prior,
      anchor.manifest,
      aggregate,
      encodedOutcome,
      this.reference(encodedOutcome),
      manifest.candidateId,
      anchor.fenceGeneration,
    );
    requireLedger(
      encodeArchiveManifest(prepared.manifest) === header.manifest,
      "archive_selection_corrupt",
    );
    requireLedger(
      JSON.stringify({
        version: ARCHIVE_SQLITE_OWNER,
        anchor: encodeArchiveAnchor(anchor),
        priorManifest: encodeArchiveManifest(prior),
        control: {
          body: control.body,
          storageRevision: control.storageRevision,
          nonce: control.nonce,
        },
        manifest: encodeArchiveManifest(manifest),
      }) === headerText,
      "archive_selection_corrupt",
    );
    return immutableAccountingValue({
      selectionHash,
      encodedOutcome,
      manifest,
      expectedAnchor: anchor,
      expectedControl: control,
    }) as SelectedArchiveOutcome;
  }

  /** Reconfirms local durability and replays exact reserved bytes. The result is
   * recovery work, not a financial read or evidence of archive publication. */
  async readPending(): Promise<SelectedArchiveOutcome | undefined> {
    await this.storage.sync();
    const pending = atomicSqlite(this.storage, (transaction) => this.load(transaction).pending);
    await this.storage.sync();
    return pending;
  }

  /** Expected anchor must come from trusted owner/restore authority, not a
   * public request. Verify its entire R2 chain, then reserve at the unchanged
   * local full head. The observed ETag/nonce is retained for later publication
   * CAS; it is NOT proof that the anchor remains current after this operation. */
  async select(
    store: R2ArchiveObjectStore,
    expected: ArchiveAnchor,
    encodedOutcome: string,
    candidateId: string,
  ): Promise<SelectedArchiveOutcome> {
    const anchorText = encodeArchiveAnchor(expected);
    const anchor = decodeArchiveAnchor(anchorText);
    requireLedger(same(anchor.identity, this.scope), "ledger_identity_mismatch");
    const payload = this.reference(encodedOutcome);
    const retry = (pending: SelectedArchiveOutcome) => {
      requireLedger(
        pending.encodedOutcome === encodedOutcome &&
          pending.manifest.candidateId === candidateId &&
          encodeArchiveAnchor(pending.expectedAnchor) === anchorText,
        "archive_selection_pending",
      );
      return pending;
    };
    await this.storage.sync();
    const existing = atomicSqlite(this.storage, (transaction) => this.load(transaction).pending);
    if (existing) {
      await this.storage.sync();
      return retry(existing);
    }
    const recovered = await recoverArchiveChain(store, anchor, policy);
    const selected = atomicSqlite(this.storage, (transaction) => {
      const local = this.load(transaction);
      if (local.pending) return retry(local.pending);
      requireLedger(
        same(local.book.head, recovered.head) &&
          encodeDurableBook(local.aggregate) === encodeDurableBook(recovered.aggregate) &&
          local.canonicalManifest === encodeArchiveManifest(recovered.manifest),
        "archive_prior_head_mismatch",
      );
      requireLedger(
        local.book.outcomes.length < LEDGER_LIMITS.outcomes,
        "ledger_capacity_exceeded",
      );
      const prepared = prepareArchiveCommit(
        recovered.manifest,
        recovered.manifestReference,
        local.aggregate,
        encodedOutcome,
        payload,
        candidateId,
        anchor.fenceGeneration,
      );
      const header = JSON.stringify({
        version: ARCHIVE_SQLITE_OWNER,
        anchor: anchorText,
        priorManifest: encodeArchiveManifest(recovered.manifest),
        control: {
          body: recovered.control.body,
          storageRevision: recovered.control.storageRevision,
          nonce: recovered.control.nonce,
        },
        manifest: encodeArchiveManifest(prepared.manifest),
      });
      requireLedger(encoder.encode(header).length <= 65_536, "archive_selection_capacity_exceeded");
      const bytes = encoder.encode(encodedOutcome);
      for (
        let offset = 0, ordinal = 0;
        offset < bytes.length;
        offset += LEDGER_LIMITS.chunkBytes, ordinal++
      ) {
        const chunk = bytes.slice(offset, offset + LEDGER_LIMITS.chunkBytes);
        this.rows(
          "INSERT INTO ledger_archive_chunks VALUES (?, ?, ?)",
          ordinal,
          chunk.buffer,
          chunkDigest(chunk, COMPACT_LEDGER_FORMAT),
        );
      }
      this.rows(
        "UPDATE ledger_archive_owner SET pending_header = ?, pending_hash = ? WHERE singleton = 1 AND pending_header IS NULL",
        header,
        hashHeader(header),
      );
      requireLedger(
        this.rows("SELECT changes() AS count")[0]?.count === 1,
        "archive_selection_pending",
      );
      this.rows(
        "UPDATE ledger_metadata SET archive_selection_hash = ? WHERE singleton = 1 AND archive_selection_hash IS NULL",
        hashHeader(header),
      );
      requireLedger(
        this.rows("SELECT changes() AS count")[0]?.count === 1,
        "archive_selection_pending",
      );
      const verified = this.load(transaction).pending;
      requireLedger(verified, "archive_selection_corrupt");
      return verified;
    });
    // If this throws, keep the reservation. Neither retry nor restart is allowed
    // to abandon it or evaluate a replacement command at a later head.
    await this.storage.sync();
    return selected;
  }

  private async snapshot() {
    await this.storage.sync();
    const value = atomicSqlite(this.storage, (transaction) => this.load(transaction));
    await this.storage.sync();
    return value;
  }

  /** Internal readiness evidence at one externally expected head. It is not a
   * public read or catalog activation. The control-plane caller must retain its
   * fence and conditionally change the same catalog revision after this returns. */
  async verifyArchiveHead(
    store: R2ArchiveObjectStore,
    expected: ArchiveAnchor,
  ): Promise<ArchiveBookHeadEvidence> {
    return (await this.verifiedSnapshot(store, expected)).evidence;
  }

  private async verifiedSnapshot(store: R2ArchiveObjectStore, expected: ArchiveAnchor) {
    const anchor = decodeArchiveAnchor(encodeArchiveAnchor(expected));
    requireLedger(same(anchor.identity, this.scope), "ledger_identity_mismatch");
    const before = await this.snapshot();
    requireLedger(before.pending === undefined, "archive_selection_pending");
    const recovered = await recoverArchiveChain(store, anchor, policy);
    const after = await this.snapshot();
    requireLedger(
      after.pending === undefined &&
        same(before.book.head, after.book.head) &&
        same(after.book.head, anchor.head) &&
        encodeDurableBook(after.aggregate) === encodeDurableBook(recovered.aggregate) &&
        after.canonicalManifest === encodeArchiveManifest(recovered.manifest),
      "archive_book_head_mismatch",
    );
    const control = await store.readControl();
    requireLedger(
      control !== null &&
        control.body === recovered.control.body &&
        control.storageRevision === recovered.control.storageRevision &&
        control.nonce === recovered.control.nonce,
      "archive_book_control_changed",
    );
    const evidence: ArchiveBookHeadEvidence = immutableAccountingValue({
      identity: this.scope,
      genesisHash: after.book.genesisDigest,
      head: after.book.head,
      manifestHash: recovered.manifest.contentHash,
      control,
      ...(after.restore
        ? { restoredUnderPermitHash: after.restore.catalog.restorePermit?.contentHash }
        : {}),
    }) as ArchiveBookHeadEvidence;
    return { local: after, evidence };
  }

  /** Trusted in-process financial read. Catalog admission brackets complete SQL
   * and archive verification. No pending selection, maintenance read bypass,
   * caller-supplied cutoff or inferred archive membership is accepted. */
  async readActive(store: R2ArchiveObjectStore, authority: ArchiveCatalogAuthority) {
    const initial = await this.snapshot();
    const admitted = await readArchiveCatalogEntry(
      authority,
      this.scope,
      initial.book.genesisDigest,
    );
    requireLedger(admitted.status === "active", "archive_catalog_unavailable");
    requireLedger(initial.pending === undefined, "archive_selection_pending");
    const control = await store.readControl();
    requireLedger(control !== null, "archive_publication_unproven");
    const anchor = decodeArchiveAnchor(control.body);
    requireLedger(
      anchor.fenceGeneration === admitted.fenceGeneration,
      "archive_catalog_fence_mismatch",
    );
    const verified = await this.verifiedSnapshot(store, anchor);
    const current = await readArchiveCatalogEntry(
      authority,
      this.scope,
      initial.book.genesisDigest,
    );
    requireLedger(same(current, admitted), "archive_catalog_fence_mismatch");
    const snapshot: LedgerSnapshot = {
      format: COMPACT_LEDGER_FORMAT,
      scope: this.scope,
      aggregate: verified.local.aggregate,
      head: verified.local.book.head,
    };
    return immutableAccountingValue({ snapshot, anchor, originals: verified.local.originals });
  }

  /** Resume the original reserved candidate before any new kernel evaluation.
   * Active admission does not override the selected fence: obsolete unpublished
   * selections still require explicit fenced abandonment/restoration. */
  async resumeActive(store: R2ArchiveObjectStore, authority: ArchiveCatalogAuthority) {
    const local = await this.snapshot();
    const admitted = await readArchiveCatalogEntry(authority, this.scope, local.book.genesisDigest);
    requireLedger(admitted.status === "active", "archive_catalog_unavailable");
    if (local.pending) {
      await this.publishPending(store, authority);
      await this.reconcilePublished(store, authority);
    }
    return this.readActive(store, authority);
  }

  private targetAnchor(
    selected: SelectedArchiveOutcome,
    fence = selected.manifest.fenceGeneration,
  ): ArchiveAnchor {
    return decodeArchiveAnchor(
      encodeArchiveAnchor({
        ...selected.expectedAnchor,
        head: selected.manifest.resulting,
        manifest: this.reference(encodeArchiveManifest(selected.manifest)),
        manifestHash: selected.manifest.contentHash,
        fenceGeneration: fence,
      }),
    );
  }

  private assertPending(selected: SelectedArchiveOutcome) {
    const current = atomicSqlite(this.storage, (transaction) => this.load(transaction));
    requireLedger(
      current.pending?.selectionHash === selected.selectionHash,
      "archive_selection_changed",
    );
  }

  private async verifyPublished(
    store: R2ArchiveObjectStore,
    authority: ArchiveCatalogAuthority,
    genesisHash: string,
    selected: SelectedArchiveOutcome,
  ) {
    const admitted = await readArchiveCatalogEntry(authority, this.scope, genesisHash);
    requireLedger(
      admitted.status === "active" || admitted.status === "maintenance",
      "archive_catalog_unavailable",
    );
    const observed = await store.readControl();
    requireLedger(observed !== null, "archive_publication_unproven");
    const anchor = decodeArchiveAnchor(observed.body);
    requireLedger(
      BigInt(anchor.fenceGeneration) >= BigInt(selected.manifest.fenceGeneration) &&
        observed.body === encodeArchiveAnchor(this.targetAnchor(selected, anchor.fenceGeneration)),
      "archive_publication_unproven",
    );
    const recovered = await recoverArchiveChain(store, anchor, policy);
    requireLedger(
      encodeArchiveManifest(recovered.manifest) === encodeArchiveManifest(selected.manifest),
      "archive_publication_unproven",
    );
    const current = await readArchiveCatalogEntry(authority, this.scope, genesisHash);
    requireLedger(
      (current.status === "active" || current.status === "maintenance") &&
        current.fenceGeneration === anchor.fenceGeneration,
      "archive_catalog_fence_mismatch",
    );
    return { anchor, recovered };
  }

  /** Publish only the durable local selection. The configured catalog reader is
   * trusted infrastructure, not request data. Admission is rechecked after uploads;
   * an already admitted publisher may finish before maintenance rotates the R2
   * anchor. After that rotation, the exact old ETag/nonce CAS must lose. No SQL
   * materialization or public receipt occurs here. Uncertainty keeps the selection. */
  async publishPending(store: R2ArchiveObjectStore, authority: ArchiveCatalogAuthority) {
    const local = await this.snapshot();
    const selected = local.pending;
    requireLedger(selected, "archive_selection_missing");
    const current = await store.readControl();
    if (current !== null) {
      const observed = decodeArchiveAnchor(current.body);
      if (
        BigInt(observed.fenceGeneration) >= BigInt(selected.manifest.fenceGeneration) &&
        current.body === encodeArchiveAnchor(this.targetAnchor(selected, observed.fenceGeneration))
      ) {
        const verified = await this.verifyPublished(
          store,
          authority,
          local.book.genesisDigest,
          selected,
        );
        this.assertPending(selected);
        return Object.freeze({
          selectionHash: selected.selectionHash,
          manifest: selected.manifest,
          anchor: verified.anchor,
          control: verified.recovered.control,
        });
      }
    }
    requireLedger(
      current !== null &&
        current.body === selected.expectedControl.body &&
        current.nonce === selected.expectedControl.nonce &&
        current.storageRevision === selected.expectedControl.storageRevision,
      "archive_publish_conflict",
    );
    const admit = async () => {
      const entry = await readArchiveCatalogEntry(authority, this.scope, local.book.genesisDigest);
      requireLedger(
        entry.status === "active" && entry.fenceGeneration === selected.manifest.fenceGeneration,
        "archive_catalog_fence_mismatch",
      );
    };
    await admit();
    await recoverArchiveChain(store, selected.expectedAnchor, policy);
    requireLedger(
      same(
        await store.putImmutable(encoder.encode(selected.encodedOutcome)),
        selected.manifest.payload,
      ),
      "archive_payload_reference_mismatch",
    );
    const target = this.targetAnchor(selected);
    requireLedger(
      same(
        await store.putImmutable(encoder.encode(encodeArchiveManifest(selected.manifest))),
        target.manifest,
      ),
      "archive_payload_reference_mismatch",
    );
    await admit();
    this.assertPending(selected);
    const publication = await store.compareAndSwapControl(
      selected.expectedControl,
      encodeArchiveAnchor(target),
    );
    requireLedger(publication.disposition === "written", "archive_publish_conflict");
    // A successful conditional PUT is not enough: re-read and verify the exact
    // canonical chain. A response loss or changed fence leaves recovery work.
    const verified = await this.verifyPublished(
      store,
      authority,
      local.book.genesisDigest,
      selected,
    );
    this.assertPending(selected);
    return Object.freeze({
      selectionHash: selected.selectionHash,
      manifest: selected.manifest,
      anchor: verified.anchor,
      control: verified.recovered.control,
    });
  }

  /** Reconcile a proven canonical member, never an uploaded orphan. This does
   * not abandon a selection or rotate/release maintenance. Keep the last exact
   * selection envelope with canonical SQL so a lost final sync response can be
   * recovered without reserving or reexecuting a replacement command. */
  async reconcilePublished(store: R2ArchiveObjectStore, authority: ArchiveCatalogAuthority) {
    const local = await this.snapshot();
    const selected = local.pending ?? local.last;
    requireLedger(selected, "archive_selection_missing");
    const verified = await this.verifyPublished(
      store,
      authority,
      local.book.genesisDigest,
      selected,
    );
    const disposition = atomicSqlite(this.storage, (transaction) => {
      const current = this.load(transaction);
      if (current.pending === undefined) {
        requireLedger(
          current.last?.selectionHash === selected.selectionHash &&
            same(current.book.head, selected.manifest.resulting) &&
            encodeDurableBook(current.aggregate) ===
              encodeDurableBook(verified.recovered.aggregate),
          "archive_selection_changed",
        );
        return "already-materialized" as const;
      }
      requireLedger(
        current.pending.selectionHash === selected.selectionHash,
        "archive_selection_changed",
      );
      const transition = replayOutcomePayload(current.aggregate, selected.encodedOutcome);
      const aggregate = { state: transition.state, protocol: transition.protocol };
      const record = compactOutcomeRecord(
        this.scope,
        current.book.head,
        aggregate,
        selected.encodedOutcome,
      );
      requireLedger(
        same(record.after, verified.anchor.head) &&
          encodeDurableBook(aggregate) === encodeDurableBook(verified.recovered.aggregate),
        "archive_materialization_mismatch",
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
      const bytes = encoder.encode(body);
      for (
        let offset = 0, ordinal = 0;
        offset < bytes.length;
        offset += LEDGER_LIMITS.chunkBytes, ordinal++
      ) {
        const chunk = bytes.slice(offset, offset + LEDGER_LIMITS.chunkBytes);
        this.rows(
          "INSERT INTO ledger_chunks VALUES (?, ?, ?, ?)",
          record.after.sequence,
          ordinal,
          chunk.buffer,
          chunkDigest(chunk, COMPACT_LEDGER_FORMAT),
        );
      }
      this.rows(
        "UPDATE ledger_metadata SET head = ? WHERE singleton = 1 AND head = ? AND archive_selection_hash = ?",
        JSON.stringify(record.after),
        JSON.stringify(current.book.head),
        selected.selectionHash,
      );
      requireLedger(this.rows("SELECT changes() AS count")[0]?.count === 1, "ledger_head_conflict");
      this.rows(
        "UPDATE ledger_archive_owner SET last_header = pending_header, last_hash = pending_hash, pending_header = NULL, pending_hash = NULL WHERE singleton = 1 AND pending_hash = ?",
        selected.selectionHash,
      );
      requireLedger(
        this.rows("SELECT changes() AS count")[0]?.count === 1,
        "archive_selection_changed",
      );
      this.rows("DELETE FROM ledger_archive_chunks");
      this.rows(
        "UPDATE ledger_metadata SET archive_selection_hash = NULL WHERE singleton = 1 AND archive_selection_hash = ?",
        selected.selectionHash,
      );
      requireLedger(
        this.rows("SELECT changes() AS count")[0]?.count === 1,
        "archive_selection_changed",
      );
      const materialized = this.load(transaction);
      requireLedger(
        materialized.pending === undefined &&
          materialized.last?.selectionHash === selected.selectionHash &&
          same(materialized.book.head, selected.manifest.resulting),
        "archive_materialization_mismatch",
      );
      return "materialized" as const;
    });
    await this.storage.sync();
    return Object.freeze({ disposition, selected, head: selected.manifest.resulting });
  }
}

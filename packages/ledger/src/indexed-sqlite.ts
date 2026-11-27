import { evaluateBookCommandAdmission, type DurableBookAggregate } from "@rastrata/kernel";
import { compactOutcomeRecord, completeScope } from "./compact-records.ts";
import { SqliteBookStorage, type BookStorageAdapter, type SqliteStorage } from "./sqlite.ts";
import { atomicSqlite } from "./sqlite-transaction.ts";
import {
  SqliteIndexControl,
  type IndexAnchor,
  type IndexView,
  type IndexReaderPin,
} from "./index-control.ts";
import { SqliteIndexPageStore, type RetainedIndexAppend } from "./index-page-store.ts";
import { SqliteSemanticGroupCatalog, type CapturedGroupCatalog } from "./group-catalog.ts";
import { readPinnedBookBasis } from "./book-basis.ts";
import { createPinnedBookRowReader, type PinnedBookRowReader } from "./book-row-reader.ts";
import { SqliteSourceCatalog, type CapturedSourceCatalog } from "./source-catalog.ts";
import { indexBookIdentityCommitment, ledgerIndexHeadCommitment } from "./index-view-audit.ts";
import { projectVerifiedIdentityPopulation } from "./identity-audit.ts";
import { prepareOutcomeIdentityDelta } from "./outcome-identities.ts";
import { replayOutcomePayload } from "./outcome-payload.ts";
import {
  auditBalancedIndex,
  createIndexRoot,
  enumerateIndexPages,
  identityIndexKey,
  lookupIndexEntry,
  prepareIndexInsert,
  verifyIndexRoot,
  INDEX_KEY_SCHEMA,
  type BalancedIndex,
  type IndexRoot,
} from "./index-pages.ts";
import {
  COMPACT_LEDGER_FORMAT,
  LedgerError,
  requireLedger,
  same,
  decodeAggregate,
  verifiedOutcomeRecordHash,
  type BookScope,
  type CompleteBookScope,
  type LedgerHead,
  type OutcomeRecord,
  type StoredBook,
} from "./records.ts";

const FORMAT = "rastrata-indexed-sqlite-owner-v1";
const SOURCE_FORMAT = "rastrata-indexed-sqlite-admission-source-candidate-v1";
interface VerifiedInput {
  readonly book: StoredBook;
  readonly aggregate: DurableBookAggregate;
  readonly view: IndexView;
  readonly cold: IndexRoot;
  readonly hot: BalancedIndex;
  readonly sourceCatalogDigest?: string;
  readonly groupCatalogDigest?: string;
}
export type {
  PinnedBookRowReader,
  PinnedCommandRead,
  TypedPinnedRow,
  PinnedJournalIdentityRead,
  PinnedActivationIdentityRead,
  PinnedAccountingIdentityRead,
  PinnedLotIdentityRead,
} from "./book-row-reader.ts";

/** Trusted one-book storage owner. Both logical index partitions currently reside
 * in the same SQLite store; this is NOT remote cold storage or scalable recovery.
 * ProductionLedger still verifies all history, then this owner's hook checks the
 * complete index population before any read or command. Only new compact books
 * may be provisioned. No automatic adoption/migration, page deletion or archive
 * acknowledgement is implemented. Authority/clock come from the owner, not HTTP. */
export class SqliteIndexedBookStorage implements BookStorageAdapter {
  private readonly scope: CompleteBookScope;
  private readonly identityHash: string;
  private readonly canonical: SqliteBookStorage;
  private readonly control: SqliteIndexControl;
  private readonly pages: SqliteIndexPageStore;
  private readonly sourceCatalog: SqliteSourceCatalog | undefined;
  private readonly groupCatalog: SqliteSemanticGroupCatalog | undefined;
  private readonly format: string;
  private creating = false;
  private verified: VerifiedInput | undefined;

  constructor(
    readonly objectId: string,
    private readonly storage: SqliteStorage,
    scope: CompleteBookScope,
    private readonly readAuthority: () => { readonly fence: string; readonly pending: boolean },
    private readonly clock: () => bigint,
    private readonly leaseMilliseconds = 60_000n,
    options: { readonly sourceCatalog?: boolean } = {},
  ) {
    this.scope = completeScope(scope, objectId);
    this.identityHash = indexBookIdentityCommitment(this.scope);
    requireLedger(
      typeof leaseMilliseconds === "bigint" &&
        leaseMilliseconds > 0n &&
        leaseMilliseconds <= 86_400_000n,
      "index_pin_invalid",
    );
    this.canonical = new SqliteBookStorage(this.objectId, storage);
    this.control = new SqliteIndexControl(storage, () => this.anchor(), clock);
    this.pages = new SqliteIndexPageStore(storage, this.identityHash);
    this.format = options.sourceCatalog === true ? SOURCE_FORMAT : FORMAT;
    this.sourceCatalog =
      options.sourceCatalog === true
        ? new SqliteSourceCatalog(storage, this.identityHash, () => this.anchor())
        : undefined;
    this.groupCatalog =
      options.sourceCatalog === true
        ? new SqliteSemanticGroupCatalog(storage, this.identityHash, () => this.anchor())
        : undefined;
  }
  private rows(sql: string, ...bindings: (string | number | null | ArrayBuffer)[]) {
    return Array.from(this.storage.sql.exec(sql, ...bindings));
  }
  private anchor(): IndexAnchor {
    const rows = this.rows(
      "SELECT format, substr(scope, 1, 16385) AS scope, length(CAST(scope AS BLOB)) AS scope_bytes, substr(head, 1, 16385) AS head, length(CAST(head AS BLOB)) AS head_bytes FROM ledger_metadata LIMIT 2",
    );
    const row = rows[0];
    requireLedger(
      rows.length === 1 && row?.format === COMPACT_LEDGER_FORMAT,
      "ledger_format_unsupported",
    );
    requireLedger(
      typeof row.scope === "string" &&
        row.scope.length <= 16384 &&
        new TextEncoder().encode(row.scope).length === row.scope_bytes &&
        typeof row.head === "string" &&
        row.head.length <= 16384 &&
        new TextEncoder().encode(row.head).length === row.head_bytes,
      "recovery_record_corrupt",
    );
    const scope = JSON.parse(row.scope),
      head = JSON.parse(row.head);
    requireLedger(
      JSON.stringify(scope) === row.scope && same(completeScope(scope, this.objectId), this.scope),
      "ledger_identity_mismatch",
    );
    const numbers = ["sequence", "bookRevision", "postingSequence", "configurationRevision"];
    const hashes = ["chainHash", "stateHash", "configurationHash", "revisionHash", "protocolHash"];
    requireLedger(
      head &&
        JSON.stringify(head) === row.head &&
        Object.keys(head).length === 9 &&
        numbers.every(
          (key) => typeof head[key] === "string" && /^(0|[1-9][0-9]{0,63})$/.test(head[key]),
        ) &&
        hashes.every((key) => typeof head[key] === "string" && /^[a-f0-9]{64}$/.test(head[key])),
      "recovery_record_corrupt",
    );
    const authority = this.readAuthority();
    return {
      identityHash: this.identityHash,
      headHash: ledgerIndexHeadCommitment(head, COMPACT_LEDGER_FORMAT),
      sequence: head.sequence,
      fence: authority.fence,
      pending: authority.pending,
      provisioning: this.creating,
    };
  }
  private ownerMetadata() {
    const rows = this.rows(
      `SELECT substr(format, 1, ${this.format.length + 1}) AS format, length(CAST(format AS BLOB)) AS format_bytes, substr(identity_hash, 1, 65) AS identity_hash, length(CAST(identity_hash AS BLOB)) AS identity_bytes FROM ledger_indexed_owner LIMIT 2`,
    );
    requireLedger(
      rows.length === 1 &&
        rows[0]?.format === this.format &&
        rows[0]?.format_bytes === this.format.length &&
        rows[0]?.identity_hash === this.identityHash &&
        rows[0]?.identity_bytes === 64,
      "indexed_owner_mismatch",
    );
  }
  load(scope: BookScope): StoredBook | undefined {
    requireLedger(
      same(completeScope(scope as CompleteBookScope, this.objectId), this.scope),
      "ledger_identity_mismatch",
    );
    const book = this.canonical.load(this.scope);
    if (book) {
      this.ownerMetadata();
      requireLedger(book.format === COMPACT_LEDGER_FORMAT, "ledger_format_unsupported");
    }
    return book;
  }
  provision(book: StoredBook): void | Promise<void> {
    requireLedger(
      book.format === COMPACT_LEDGER_FORMAT &&
        same(book.scope, this.scope) &&
        book.head.sequence === "0" &&
        book.outcomes.length === 0,
      "index_initialization_forbidden",
    );
    book = { ...book, scope: { ...book.scope }, head: { ...book.head }, outcomes: [] };
    const publish = (
      candidate?: Awaited<ReturnType<SqliteSourceCatalog["prepare"]>>,
      groups?: Awaited<ReturnType<SqliteSemanticGroupCatalog["prepare"]>>,
    ) => {
      this.creating = true;
      try {
        atomicSqlite(this.storage, (transaction) => {
          this.canonical.provisionInTransaction(transaction, book);
          this.control.initializeInTransaction(transaction, INDEX_KEY_SCHEMA);
          this.pages.initializeInTransaction(transaction, "allocated");
          this.rows(
            "CREATE TABLE ledger_indexed_owner (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), format TEXT NOT NULL, identity_hash TEXT NOT NULL)",
          );
          this.rows(
            "INSERT INTO ledger_indexed_owner VALUES (1, ?, ?)",
            this.format,
            this.identityHash,
          );
          if (candidate) this.sourceCatalog?.publishInTransaction(transaction, candidate);
          if (groups) this.groupCatalog?.publishInTransaction(transaction, groups);
        });
      } finally {
        this.creating = false;
        this.verified = undefined;
      }
    };
    if (this.sourceCatalog && this.groupCatalog) {
      const aggregate = decodeAggregate(book.genesis);
      return Promise.all([
        this.sourceCatalog.prepare(book, aggregate),
        this.groupCatalog.prepare(
          null,
          aggregate,
          ledgerIndexHeadCommitment(book.head, COMPACT_LEDGER_FORMAT),
        ),
      ]).then(([candidate, groups]) => publish(candidate, groups));
    }
    publish();
  }
  async sync(): Promise<void> {
    await this.storage.sync();
    const names = this.rows(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name LIKE 'ledger_%' LIMIT 1",
    );
    if (names.length === 0) return;
    this.ownerMetadata();
    await this.control.recoverMetadata();
    await this.pages.recover();
  }
  private expiry() {
    const now = this.clock();
    requireLedger(typeof now === "bigint" && now >= 0n, "index_pin_clock_invalid");
    return String(now + this.leaseMilliseconds);
  }
  private async root(hash: string, count: string) {
    const candidate =
      count === "0" ? createIndexRoot(0n, null) : await this.pages.readRootDescriptor(hash);
    requireLedger(candidate, "index_required_root_missing");
    const root = verifyIndexRoot(candidate, hash);
    requireLedger(root.population === count, "index_partition_population_mismatch");
    return root;
  }
  private async lookupIdentity(
    source: VerifiedInput,
    key: string,
    confirm: () => Promise<void>,
  ): Promise<bigint | null> {
    await confirm();
    let found: bigint | null = null;
    for (const part of [
      { root: source.cold, from: 1n, through: BigInt(source.view.coldThrough) },
      {
        root: source.hot.root,
        from: BigInt(source.view.coldThrough) + 1n,
        through: BigInt(source.view.sequence),
      },
    ]) {
      const match = await lookupIndexEntry(part.root, part.root.contentHash, key, async (id) => {
        const bytes = await this.pages.read(id);
        await confirm();
        return bytes;
      });
      if (match.sequence !== null) {
        requireLedger(
          match.sequence >= part.from && match.sequence <= part.through,
          "index_partition_sequence_mismatch",
        );
        requireLedger(found === null, "index_identity_digest_collision");
        found = match.sequence;
      }
    }
    await confirm();
    return found;
  }
  async validateRecovered(book: StoredBook, aggregate: DurableBookAggregate): Promise<void> {
    this.verified = undefined;
    requireLedger(
      book.format === COMPACT_LEDGER_FORMAT && same(book.scope, this.scope),
      "ledger_identity_mismatch",
    );
    const current = await this.control.readMetadata();
    requireLedger(
      current.view.headHash === ledgerIndexHeadCommitment(book.head, COMPACT_LEDGER_FORMAT),
      "ledger_head_conflict",
    );
    requireLedger(current.view.schema === INDEX_KEY_SCHEMA, "index_key_schema_unsupported");
    const pin = await this.control.pinCurrent(current.view, "reader", this.expiry());
    let succeeded = false;
    try {
      const population = projectVerifiedIdentityPopulation(
        aggregate,
        book.head,
        this.scope,
        COMPACT_LEDGER_FORMAT,
      );
      const expected = new Map<string, bigint>();
      for (const identity of population.entries) {
        const key = identityIndexKey(identity);
        requireLedger(!expected.has(key), "index_identity_digest_collision");
        expected.set(key, identity.outcomeSequence);
      }
      const cold = await this.root(pin.view.coldRoot, pin.view.coldCount);
      const hot = await this.root(pin.view.hotRoot, pin.view.hotCount);
      for (const part of [
        { root: cold, from: 1n, through: BigInt(pin.view.coldThrough) },
        { root: hot, from: BigInt(pin.view.coldThrough) + 1n, through: BigInt(pin.view.sequence) },
      ]) {
        for await (const entry of enumerateIndexPages(
          part.root,
          part.root.contentHash,
          async (id) => {
            const bytes = await this.pages.read(id);
            await this.control.readPinned(pin);
            return bytes;
          },
        )) {
          requireLedger(
            entry.sequence >= part.from && entry.sequence <= part.through,
            "index_partition_sequence_mismatch",
          );
          requireLedger(expected.get(entry.key) === entry.sequence, "index_identity_mismatch");
          expected.delete(entry.key);
        }
      }
      requireLedger(expected.size === 0, "index_identity_population_incomplete");
      const balanced = await auditBalancedIndex(hot, hot.contentHash, (id) => this.pages.read(id));
      const sourceCatalogDigest = await this.sourceCatalog?.verify(book, aggregate);
      const groupCatalogDigest = await this.groupCatalog?.verify(
        aggregate,
        ledgerIndexHeadCommitment(book.head, COMPACT_LEDGER_FORMAT),
      );
      await this.control.readPinned(pin);
      await this.control.releasePin(pin);
      this.verified = {
        book,
        aggregate,
        view: pin.view,
        cold,
        hot: balanced,
        ...(sourceCatalogDigest === undefined ? {} : { sourceCatalogDigest }),
        ...(groupCatalogDigest === undefined ? {} : { groupCatalogDigest }),
      };
      succeeded = true;
    } finally {
      if (!succeeded) {
        // Best-effort lease release must not replace the original failure or
        // discard uncertain protection. Durable expiry/maintenance can finish it.
        try {
          await this.control.releasePin(pin);
        } catch {
          /* retained until recovery/expiry */
        }
      }
    }
  }
  async commitTransition(expected: LedgerHead, input: OutcomeRecord): Promise<void> {
    const source = this.verified;
    this.verified = undefined;
    requireLedger(source && same(source.book.head, expected), "indexed_recovery_required");
    const record: OutcomeRecord = JSON.parse(JSON.stringify(input));
    const next = replayOutcomePayload(source.aggregate, record.body);
    requireLedger(
      same(compactOutcomeRecord(this.scope, expected, next, record.body), record),
      "recovery_outcome_mismatch",
    );
    let pin: IndexReaderPin | undefined;
    try {
      pin = await this.control.pinCurrent(source.view, "construction", this.expiry());
      const captured = pin;
      const catalogCandidate = await this.sourceCatalog?.prepare(
        source.book,
        next,
        record,
        source.sourceCatalogDigest,
      );
      const groupCandidate = await this.groupCatalog?.prepare(
        {
          aggregate: source.aggregate,
          headHash: ledgerIndexHeadCommitment(expected, COMPACT_LEDGER_FORMAT),
          digest: source.groupCatalogDigest ?? "",
        },
        next,
        ledgerIndexHeadCommitment(record.after, COMPACT_LEDGER_FORMAT),
      );
      await this.control.readPinned(captured);
      const delta = await prepareOutcomeIdentityDelta(
        record.body,
        this.scope.bookId,
        BigInt(record.after.sequence),
        async (key) => {
          const found = await this.lookupIdentity(source, key, async () => {
            await this.control.readPinned(captured);
          });
          if (found === null) return null;
          const original = source.book.outcomes[Number(found - 1n)];
          requireLedger(
            original?.after.sequence === String(found),
            "index_identity_source_mismatch",
          );
          const persisted = this.canonical.readVerifiedOutcome(
            this.scope,
            source.book.head,
            found,
            verifiedOutcomeRecordHash(original),
          );
          await this.control.readPinned(captured);
          return { sequence: found, encodedOutcome: persisted.body };
        },
      );
      let index = source.hot;
      let retained: RetainedIndexAppend | null = null;
      for (const identity of delta) {
        const locations = await this.pages.reserve(this.control, pin, 2 * index.height + 1);
        let used = 0;
        const plan = await prepareIndexInsert(
          index,
          { key: identityIndexKey(identity), sequence: identity.outcomeSequence },
          (id) => this.pages.read(id),
          () => {
            const id = locations[used++];
            requireLedger(id, "index_location_not_reserved");
            return id;
          },
        );
        for (const page of plan.pages)
          await this.pages.putReserved(this.control, pin, page.descriptor.page, page.bytes);
        if (used < locations.length)
          await this.pages.abandon(this.control, pin, locations.slice(used));
        retained = await this.pages.retainInsertion(this.control, pin, plan, retained);
        index = plan.index;
      }
      // Every newly retained outcome, including a rejection, reserves its command
      // identity. Empty deltas are not permission to publish an unindexed result.
      requireLedger(retained, "index_identity_population_incomplete");
      const registered = await this.pages.registerRetainedAppend(this.control, pin, retained, {
        ...this.anchor(),
        sequence: record.after.sequence,
        headHash: ledgerIndexHeadCommitment(record.after, COMPACT_LEDGER_FORMAT),
      });
      await this.control.publishPrepared(pin, registered.digest, (transaction) => {
        this.canonical.commitTransitionInTransaction(transaction, expected, record);
        if (catalogCandidate)
          this.sourceCatalog?.publishInTransaction(transaction, catalogCandidate);
        if (groupCandidate) this.groupCatalog?.publishInTransaction(transaction, groupCandidate);
        return undefined;
      });
    } catch (error) {
      if (pin)
        try {
          await this.control.releasePin(pin);
        } catch {
          /* uncertain protection remains */
        }
      if (
        error instanceof LedgerError &&
        ["index_view_conflict", "index_pin_view_conflict"].includes(error.code)
      )
        throw new LedgerError("ledger_head_conflict");
      if (
        error instanceof LedgerError &&
        ["source_catalog_conflict", "group_catalog_conflict"].includes(error.code) &&
        this.anchor().headHash !== ledgerIndexHeadCommitment(expected, COMPACT_LEDGER_FORMAT)
      )
        throw new LedgerError("ledger_head_conflict");
      throw error;
    }
  }
  /** Internal current-head context after full ledger/catalog verification. A
   * publication invalidates this reader; it is not historical MVCC or a public
   * request/authorization API. Call close; failed/uncertain reads retire it. */
  async openCurrentRowReader(): Promise<PinnedBookRowReader> {
    const source = this.verified;
    const catalog = this.sourceCatalog;
    const groups = this.groupCatalog;
    requireLedger(
      source && catalog && source.sourceCatalogDigest && groups && source.groupCatalogDigest,
      "indexed_recovery_required",
    );
    const head = Object.freeze({ ...source.book.head });
    const headHash = ledgerIndexHeadCommitment(head, COMPACT_LEDGER_FORMAT);
    await this.sync();
    const pin = await this.control.pinCurrent(source.view, "reader", this.expiry());
    let capture: CapturedSourceCatalog | undefined;
    let groupCapture: CapturedGroupCatalog | undefined;
    try {
      capture = catalog.capture(headHash, source.sourceCatalogDigest);
      groupCapture = groups.capture(headHash, source.groupCatalogDigest);
      await this.control.readPinned(pin);
      catalog.assertCurrent(capture);
      groups.assertCurrent(groupCapture);
      const selected = capture;
      const selectedGroups = groupCapture;
      const confirm = async () => {
        await this.control.readPinned(pin);
        catalog.assertCurrent(selected);
        groups.assertCurrent(selectedGroups);
      };
      const rawRow = (collection: string, ordinal: bigint) =>
        catalog.readCaptured(selected, collection, ordinal, {
          confirm,
          outcome: (sequence, hash) =>
            this.canonical.readVerifiedOutcome(this.scope, head, sequence, hash),
          genesis: (digest) => this.canonical.readVerifiedGenesis(this.scope, head, digest),
        });
      return createPinnedBookRowReader({
        head,
        headHash,
        bookId: this.scope.bookId,
        catalogDigest: selected.digest,
        groups,
        groupCapture: selectedGroups,
        collectionDomain: (collection) => catalog.collectionDomain(selected, collection),
        admission: (command) =>
          evaluateBookCommandAdmission(source.aggregate.state, source.aggregate.protocol, command),
        basis: () =>
          readPinnedBookBasis(source.aggregate.state, head, selected.digest, rawRow, confirm),
        rawRow,
        lookup: (key) => this.lookupIdentity(source, key, confirm),
        confirm,
        release: async () => {
          catalog.release(selected);
          groups.release(selectedGroups);
          await this.control.releasePin(pin);
        },
      });
    } catch (error) {
      if (capture) catalog.release(capture);
      if (groupCapture) groups.release(groupCapture);
      try {
        await this.control.releasePin(pin);
      } catch {
        /* retained until recovery/expiry */
      }
      throw error;
    }
  }
  /** Bounded metadata-only maintenance. Not page reclamation or archive cleanup. */
  async maintain(limit = 128) {
    requireLedger(
      Number.isInteger(limit) && limit >= 1 && limit <= 256,
      "index_construction_batch_invalid",
    );
    await this.sync();
    const expiredPins = await this.control.reapExpiredPins(limit);
    const cleanup = await this.pages.cleanupConstructions(this.control, limit);
    return { expiredPins, cleanup };
  }
}

import {
  decodeBookOutcome,
  encodeBookOutcome,
  encodeBookRow,
  encodeDurableBook,
  evaluateBookCommandAdmission,
  type BookCommand,
  type BookCommandResult,
  type BookOutcomePayload,
  type DurableBookAggregate,
  type BookRowCollection,
} from "@rastrata/kernel";
import { completeScope } from "./compact-records.ts";
import { SqliteIndexedCanonicalStore } from "./indexed-canonical-store.ts";
import { projectLegacyIndexedBook, type IndexedBookHead } from "./indexed-book-state.ts";
import {
  SqliteIndexedSourceCatalog,
  type IndexedSourceAnchor,
  type IndexedSourceReadPorts,
} from "./indexed-source-catalog.ts";
import {
  SqliteSemanticGroupCatalog,
  INDEXED_GROUP_CATALOG_FORMAT,
  INDEXED_OWNERSHIP_GROUP_CATALOG_FORMAT,
  INDEXED_MONEY_GROUP_CATALOG_FORMAT,
  INDEXED_REFERENCE_GROUP_CATALOG_FORMAT,
  type IndexedGroupCatalogFormat,
} from "./group-catalog.ts";
import {
  SqliteIndexControl,
  type IndexAnchor,
  type IndexReaderPin,
  type IndexView,
} from "./index-control.ts";
import { SqliteIndexPageStore, type RetainedIndexAppend } from "./index-page-store.ts";
import {
  INDEX_KEY_SCHEMA,
  createIndexRoot,
  verifyIndexRoot,
  auditBalancedIndex,
  enumerateIndexPages,
  lookupIndexEntry,
  prepareIndexInsert,
  identityIndexKey,
  type IndexRoot,
  type BalancedIndex,
} from "./index-pages.ts";
import { indexBookIdentityCommitment } from "./index-view-audit.ts";
import { projectVerifiedIdentityEntries } from "./identity-audit.ts";
import { prepareIndexedOutcomeIdentityDelta } from "./outcome-identities.ts";
import { evaluateOutcomePayload, replayOutcomePayload } from "./outcome-payload.ts";
import {
  LedgerError,
  LEDGER_LIMITS,
  decodeAggregate,
  snapshotCommand,
  requireLedger,
  type CompleteBookScope,
} from "./records.ts";
import { atomicSqlite } from "./sqlite-transaction.ts";
import type { SqliteStorage } from "./sqlite.ts";
import { createPinnedBookRowReader, type PinnedBookRowReader } from "./book-row-reader.ts";
import { readPinnedIndexedBookBasis } from "./book-basis.ts";

export interface IndexedOwnerAuthority {
  readonly fence: string;
  readonly pending: boolean;
}
export interface IndexedOwnerReceipt {
  readonly head: IndexedBookHead;
  readonly result: BookCommandResult;
  readonly outcomeSequence: bigint | null;
  readonly originalResult: BookOutcomePayload["originalResult"] | null;
}
export interface IndexedArchivePage {
  readonly genesisHash: string;
  readonly genesis: string | null;
  readonly head: IndexedBookHead;
  readonly outcomes: readonly {
    readonly sequence: bigint;
    readonly recordHash: string;
    readonly encoded: string;
  }[];
}
interface Recovered {
  readonly anchor: IndexedSourceAnchor;
  readonly aggregate: DurableBookAggregate;
  readonly authority: IndexedOwnerAuthority;
  readonly pin: IndexReaderPin;
  readonly view: IndexView;
  readonly cold: IndexRoot;
  readonly hot: BalancedIndex;
  readonly sourceDigest: string;
  readonly groupDigest: string;
  readonly hashes: ReadonlyMap<bigint, string>;
  readonly originals: ReadonlyMap<
    string,
    { sequence: bigint; result: BookOutcomePayload["originalResult"] }
  >;
  readonly ports: IndexedSourceReadPorts;
}
type VerifiedSession = Omit<Recovered, "pin" | "ports">;
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    const valA = aObj[k];
    const valB = bObj[k];
    if (valA === valB) continue;
    if (typeof valA === "object" && valA !== null && typeof valB === "object" && valB !== null) {
      if (!same(valA, valB)) return false;
    } else {
      return false;
    }
  }
  return true;
}

/** Internal new-format owner, NOT an enabled service/storage profile. Complete
 * existing kernel evaluation and cold-start full-history replay are the bounded admission
 * bridge, never a fabricated sparse BookState. The 1,000-outcome/1 MiB owner
 * bounds remain. Indexed read-set admission, archive-required acknowledgement,
 * external rollback evidence, migrations and scaled recovery remain release gates.
 * The trusted gateway owns authorization; authority/clock are not request input. */
export class IndexedLedgerOwner {
  private readonly scope: CompleteBookScope;
  private readonly identityHash: string;
  private readonly canonical: SqliteIndexedCanonicalStore;
  private readonly source: SqliteIndexedSourceCatalog;
  private readonly groups: SqliteSemanticGroupCatalog;
  private readonly control: SqliteIndexControl;
  private readonly pages: SqliteIndexPageStore;
  private creating = false;
  private tail: Promise<unknown> = Promise.resolve();
  // Established only by full recovery or this owner's confirmed atomic transition.
  // Pins are never cached. Untouched historical damage is checked on access/audit,
  // not by replaying the entire book before each warm command.
  private session: VerifiedSession | undefined;
  get archiveScope(): CompleteBookScope {
    return this.scope;
  }
  constructor(
    private readonly storage: SqliteStorage,
    scope: CompleteBookScope,
    objectId: string,
    private readonly readAuthority: () => IndexedOwnerAuthority,
    private readonly clock: () => bigint,
    private readonly leaseMilliseconds = 60000n,
    groupProfile: IndexedGroupCatalogFormat = INDEXED_GROUP_CATALOG_FORMAT,
    private readonly scheduleArchive?: () => Promise<void>,
  ) {
    this.scope = completeScope(scope, objectId);
    requireLedger(
      groupProfile === INDEXED_GROUP_CATALOG_FORMAT ||
        groupProfile === INDEXED_OWNERSHIP_GROUP_CATALOG_FORMAT ||
        groupProfile === INDEXED_MONEY_GROUP_CATALOG_FORMAT ||
        groupProfile === INDEXED_REFERENCE_GROUP_CATALOG_FORMAT,
      "group_catalog_profile_invalid",
    );
    requireLedger(
      typeof leaseMilliseconds === "bigint" &&
        leaseMilliseconds > 0n &&
        leaseMilliseconds <= 300000n,
      "index_pin_expired",
    );
    this.identityHash = indexBookIdentityCommitment(this.scope);
    this.canonical = new SqliteIndexedCanonicalStore(storage, this.scope, objectId);
    this.source = new SqliteIndexedSourceCatalog(storage, this.scope, objectId, () =>
      this.canonical.readAnchor(),
    );
    this.groups = new SqliteSemanticGroupCatalog(
      storage,
      this.identityHash,
      () => ({
        identityHash: this.identityHash,
        headHash: this.canonical.readAnchor().head.contentHash,
        sourceCatalogDigest: this.catalogDigest("source"),
      }),
      groupProfile,
    );
    this.control = new SqliteIndexControl(storage, () => this.anchor(), clock);
    this.pages = new SqliteIndexPageStore(storage, this.identityHash);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => {
      this.session = undefined;
    });
    return result;
  }
  private authority(): IndexedOwnerAuthority {
    const value = this.readAuthority();
    requireLedger(
      value &&
        Object.keys(value).sort().join(",") === "fence,pending" &&
        typeof value.fence === "string" &&
        /^(0|[1-9][0-9]{0,63})$/.test(value.fence) &&
        typeof value.pending === "boolean",
      "indexed_owner_authority_invalid",
    );
    requireLedger(!value.pending, "indexed_owner_maintenance");
    return Object.freeze({ fence: value.fence, pending: value.pending });
  }
  private assertAuthority(expected: IndexedOwnerAuthority) {
    requireLedger(same(this.authority(), expected), "indexed_owner_fence_conflict");
  }
  private anchor(): IndexAnchor {
    const head = this.canonical.readAnchor().head,
      authority = this.authority();
    return {
      identityHash: this.identityHash,
      headHash: head.contentHash,
      sequence: head.sequence,
      fence: authority.fence,
      pending: authority.pending,
      provisioning: this.creating,
    };
  }
  private expiry() {
    const now = this.clock();
    requireLedger(typeof now === "bigint" && now >= 0n, "index_pin_clock_invalid");
    return String(now + this.leaseMilliseconds);
  }
  private catalogDigest(kind: "source" | "group"): string {
    const rows = Array.from(
      this.storage.sql.exec(
        `SELECT substr(digest, 1, 65) AS digest, length(CAST(digest AS BLOB)) AS bytes FROM ledger_indexed_${kind}_catalog LIMIT 2`,
      ),
    );
    const row = rows[0];
    requireLedger(
      rows.length === 1 &&
        row &&
        typeof row.digest === "string" &&
        /^[0-9a-f]{64}$/.test(row.digest) &&
        row.bytes === 64,
      "indexed_owner_catalog_corrupt",
    );
    return row.digest;
  }
  private async root(hash: string, count: string) {
    const raw =
      count === "0" ? createIndexRoot(0n, null) : await this.pages.readRootDescriptor(hash);
    requireLedger(raw, "index_required_root_missing");
    const root = verifyIndexRoot(raw, hash);
    requireLedger(root.population === count, "index_partition_population_mismatch");
    return root;
  }
  private verifySessionCatalogs(session: VerifiedSession): void {
    const source = this.source.capture(session.sourceDigest);
    try {
      const groups = this.groups.capture(session.anchor.head.contentHash, session.groupDigest);
      this.groups.release(groups);
    } finally {
      this.source.release(source);
    }
  }
  private async recover(): Promise<Recovered> {
    const authority = this.authority();
    await this.storage.sync();
    const anchor = this.canonical.readAnchor();
    requireLedger(
      BigInt(anchor.head.sequence) <= BigInt(LEDGER_LIMITS.outcomes),
      "ledger_capacity_exceeded",
    );
    const metadata = await this.control.recoverMetadata();
    const cached = this.session;
    if (cached && same(cached.anchor, anchor) && same(cached.view, metadata.view)) {
      this.assertAuthority(cached.authority);
      // These captures decode and hash the complete catalog bodies, not only their
      // stored digest columns. Point/range readers still authenticate actual nodes.
      this.verifySessionCatalogs(cached);
      const pin = await this.control.pinCurrent(metadata.view, "reader", this.expiry());
      const current = this.attachPorts(cached, pin);
      try {
        await current.ports.confirm();
        return current;
      } catch (error) {
        this.session = undefined;
        try {
          await this.control.releasePin(pin);
        } catch {
          /* retain original failure */
        }
        throw error;
      }
    }
    if (cached)
      requireLedger(
        BigInt(anchor.head.sequence) >= BigInt(cached.anchor.head.sequence),
        "recovery_segment_gap_detected",
      );
    this.session = undefined;
    await this.pages.recover();
    requireLedger(
      metadata.view.headHash === anchor.head.contentHash &&
        metadata.view.schema === INDEX_KEY_SCHEMA,
      "indexed_canonical_head_conflict",
    );
    this.assertAuthority(authority);
    const pin = await this.control.pinCurrent(metadata.view, "reader", this.expiry());
    let success = false;
    try {
      const confirm = async () => {
        await this.control.readPinned(pin);
        this.assertAuthority(authority);
        requireLedger(same(this.canonical.readAnchor(), anchor), "indexed_canonical_head_conflict");
      };
      const genesis = this.canonical.readGenesis(anchor);
      requireLedger(
        new TextEncoder().encode(genesis).length <= LEDGER_LIMITS.recordBytes,
        "ledger_capacity_exceeded",
      );
      let aggregate = decodeAggregate(genesis);
      const hashes = new Map<bigint, string>(),
        originals = new Map<
          string,
          { sequence: bigint; result: BookOutcomePayload["originalResult"] }
        >();
      await this.canonical.audit(anchor, {
        confirm,
        outcome: async (record) => {
          requireLedger(
            new TextEncoder().encode(JSON.stringify(record)).length <= LEDGER_LIMITS.recordBytes,
            "ledger_capacity_exceeded",
          );
          const next = replayOutcomePayload(aggregate, record.payload);
          aggregate = { state: next.state, protocol: next.protocol };
          const projected = await projectLegacyIndexedBook(encodeDurableBook(aggregate));
          requireLedger(
            JSON.stringify(projected.state) === record.state,
            "recovery_outcome_mismatch",
          );
          const decoded = decodeBookOutcome(record.payload);
          requireLedger(decoded.disposition === "decoded", "recovery_outcome_invalid");
          const sequence = BigInt(record.after.sequence);
          hashes.set(sequence, record.contentHash);
          requireLedger(
            !originals.has(decoded.payload.command.id),
            "index_canonical_identity_conflict",
          );
          originals.set(decoded.payload.command.id, {
            sequence,
            result: decoded.payload.originalResult,
          });
        },
      });
      const ports: IndexedSourceReadPorts = {
        confirm,
        genesis: async (hash) => {
          await confirm();
          requireLedger(hash === anchor.genesisHash, "indexed_canonical_genesis_mismatch");
          const bytes = this.canonical.readGenesis(anchor);
          await confirm();
          return bytes;
        },
        outcome: async (sequence, hash) => {
          await confirm();
          requireLedger(hashes.get(sequence) === hash, "indexed_owner_source_not_canonical");
          const found = await this.canonical.readOutcome(anchor, sequence, hash);
          await confirm();
          return found;
        },
      };
      const sourceDigest = this.catalogDigest("source"),
        groupDigest = this.catalogDigest("group");
      await this.groups.verifyIndexed(this.source, anchor, sourceDigest, groupDigest, ports);
      const expected = new Map(
        projectVerifiedIdentityEntries(aggregate, BigInt(anchor.head.sequence)).map((entry) => [
          identityIndexKey(entry),
          entry.outcomeSequence,
        ]),
      );
      const cold = await this.root(metadata.view.coldRoot, metadata.view.coldCount),
        hotRoot = await this.root(metadata.view.hotRoot, metadata.view.hotCount);
      for (const part of [
        { root: cold, from: 1n, through: BigInt(metadata.view.coldThrough) },
        {
          root: hotRoot,
          from: BigInt(metadata.view.coldThrough) + 1n,
          through: BigInt(anchor.head.sequence),
        },
      ]) {
        for await (const entry of enumerateIndexPages(
          part.root,
          part.root.contentHash,
          async (id) => {
            const value = await this.pages.read(id);
            await confirm();
            return value;
          },
        )) {
          requireLedger(
            entry.sequence >= part.from &&
              entry.sequence <= part.through &&
              expected.get(entry.key) === entry.sequence,
            "index_identity_mismatch",
          );
          expected.delete(entry.key);
        }
      }
      requireLedger(expected.size === 0, "index_identity_population_incomplete");
      const hot = await auditBalancedIndex(hotRoot, hotRoot.contentHash, async (id) => {
        const value = await this.pages.read(id);
        await confirm();
        return value;
      });
      await confirm();
      success = true;
      const recovered: Recovered = {
        anchor,
        aggregate: Object.freeze({ ...aggregate }),
        authority,
        pin,
        view: metadata.view,
        cold,
        hot,
        sourceDigest,
        groupDigest,
        hashes,
        originals,
        ports,
      };
      this.session = {
        anchor,
        aggregate: recovered.aggregate,
        authority,
        view: metadata.view,
        cold,
        hot,
        sourceDigest,
        groupDigest,
        hashes,
        originals,
      };
      return recovered;
    } finally {
      if (!success)
        try {
          await this.control.releasePin(pin);
        } catch {
          /* uncertain protection expires durably */
        }
    }
  }
  private attachPorts(session: VerifiedSession, pin: IndexReaderPin): Recovered {
    const confirm = async () => {
      await this.control.readPinned(pin);
      this.assertAuthority(session.authority);
      requireLedger(
        same(this.canonical.readAnchor(), session.anchor),
        "indexed_canonical_head_conflict",
      );
      this.verifySessionCatalogs(session);
    };
    return {
      ...session,
      pin,
      ports: {
        confirm,
        genesis: async (hash) => {
          await confirm();
          requireLedger(hash === session.anchor.genesisHash, "indexed_canonical_genesis_mismatch");
          const encoded = this.canonical.readGenesis(session.anchor);
          await confirm();
          return encoded;
        },
        outcome: async (sequence, hash) => {
          await confirm();
          requireLedger(
            session.hashes.get(sequence) === hash,
            "indexed_owner_source_not_canonical",
          );
          const found = await this.canonical.readOutcome(session.anchor, sequence, hash);
          await confirm();
          return found;
        },
      },
    };
  }
  /** Explicit exhaustive audit. Also used implicitly on cold start, external head
   * changes and after uncertainty; warm session verification is not this audit. */
  audit(): Promise<{ readonly head: IndexedBookHead }> {
    return this.serial(async () => {
      this.session = undefined;
      return this.withRecovered(async (current) => ({ head: current.anchor.head }));
    });
  }
  /** The immutable outcome log is the outbox. Read a bounded verified prefix
   * without holding the book queue across archive network operations. No deletion
   * or acknowledgement policy is implied by a successful archive read. */
  readArchivePage(
    after: bigint,
    expectedHash: string | null,
    limit = 8,
  ): Promise<IndexedArchivePage> {
    requireLedger(
      typeof after === "bigint" &&
        after >= 0n &&
        Number.isInteger(limit) &&
        limit >= 1 &&
        limit <= 16 &&
        (after === 0n
          ? expectedHash === null
          : typeof expectedHash === "string" && /^[0-9a-f]{64}$/.test(expectedHash)),
      "archive_cursor_invalid",
    );
    return this.serial(() =>
      this.withRecovered(async (current) => {
        requireLedger(
          after <= BigInt(current.anchor.head.sequence) &&
            (after === 0n || current.hashes.get(after) === expectedHash),
          "archive_cursor_conflict",
        );
        const outcomes: IndexedArchivePage["outcomes"][number][] = [];
        for (
          let sequence = after + 1n;
          sequence <= BigInt(current.anchor.head.sequence) && outcomes.length < limit;
          sequence++
        ) {
          const recordHash = current.hashes.get(sequence);
          requireLedger(recordHash, "indexed_owner_source_not_canonical");
          const record = await current.ports.outcome(sequence, recordHash);
          outcomes.push(Object.freeze({ sequence, recordHash, encoded: record.encoded }));
        }
        const genesis =
          after === 0n ? await current.ports.genesis(current.anchor.genesisHash) : null;
        await current.ports.confirm();
        return Object.freeze({
          genesisHash: current.anchor.genesisHash,
          genesis,
          head: current.anchor.head,
          outcomes: Object.freeze(outcomes),
        });
      }),
    );
  }
  private async withRecovered<T>(work: (current: Recovered) => Promise<T>): Promise<T> {
    const current = await this.recover();
    let result!: T;
    try {
      result = await work(current);
    } catch (error) {
      this.session = undefined;
      try {
        await this.control.releasePin(current.pin);
      } catch {
        /* preserve the original failure and uncertain protection */
      }
      throw error;
    }
    await this.control.releasePin(current.pin);
    this.assertAuthority(current.authority);
    return result;
  }
  provision(input: DurableBookAggregate): Promise<void> {
    const encoded = encodeDurableBook(input);
    requireLedger(
      new TextEncoder().encode(encoded).length <= LEDGER_LIMITS.recordBytes,
      "ledger_capacity_exceeded",
    );
    return this.serial(async () => {
      const authority = this.authority();
      await this.storage.sync();
      // Arm before publication. Alarm handlers must read through this owner's
      // serial queue, so they cannot drain between this arm and the ensuing commit.
      await this.scheduleArchive?.();
      if (
        Array.from(
          this.storage.sql.exec(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ledger_indexed_canonical' LIMIT 1",
          ),
        ).length
      ) {
        await this.withRecovered(async (current) => {
          requireLedger(
            this.canonical.readGenesis(current.anchor) === encoded,
            "ledger_genesis_conflict",
          );
        });
        return;
      }
      const canonical = await this.canonical.prepareGenesis(encoded),
        source = await this.source.prepareGenesis(encoded);
      const groups = await this.groups.prepareIndexed(this.source, source, null, {
        confirm: async () => this.assertAuthority(authority),
        readPrevious: async () => {
          throw new LedgerError("indexed_canonical_genesis_required");
        },
      });
      this.assertAuthority(authority);
      this.creating = true;
      try {
        atomicSqlite(this.storage, (transaction) => {
          this.canonical.publishInTransaction(transaction, canonical);
          this.control.initializeInTransaction(transaction, INDEX_KEY_SCHEMA);
          this.pages.initializeInTransaction(transaction, "allocated");
          this.source.publishInTransaction(transaction, source);
          this.groups.publishInTransaction(transaction, groups);
          this.assertAuthority(authority);
        });
      } finally {
        this.creating = false;
      }
      await this.storage.sync();
      await this.withRecovered(async () => undefined);
    });
  }
  read(): Promise<{ readonly aggregate: DurableBookAggregate; readonly head: IndexedBookHead }> {
    return this.serial(() =>
      this.withRecovered(async (current) => {
        await this.storage.sync();
        await current.ports.confirm();
        return { aggregate: current.aggregate, head: current.anchor.head };
      }),
    );
  }
  /** Internal live-head reader after complete accounting/catalog/identity recovery.
   * Publication, authority change or expiry invalidates every method and cursor.
   * This is not historical MVCC, sparse command admission or a public API. */
  openCurrentRowReader(): Promise<PinnedBookRowReader<IndexedBookHead>> {
    return this.serial(async () => {
      const current = await this.recover();
      let capture: ReturnType<SqliteIndexedSourceCatalog["capture"]> | undefined;
      let groupCapture: ReturnType<SqliteSemanticGroupCatalog["capture"]> | undefined;
      try {
        capture = this.source.capture(current.sourceDigest);
        groupCapture = this.groups.capture(current.anchor.head.contentHash, current.groupDigest);
        const selected = capture,
          selectedGroups = groupCapture;
        const confirm = async () => {
          await current.ports.confirm();
          this.source.assertCurrent(selected);
          this.groups.assertCurrent(selectedGroups);
        };
        const rawRow = (collection: string, ordinal: bigint) =>
          this.source.read(selected, collection as BookRowCollection, ordinal, {
            ...current.ports,
            confirm,
          });
        await confirm();
        return createPinnedBookRowReader({
          head: current.anchor.head,
          headHash: current.anchor.head.contentHash,
          bookId: this.scope.bookId,
          catalogDigest: selected.digest,
          groups: this.groups,
          groupCapture: selectedGroups,
          collectionDomain: (collection) => this.source.collectionDomain(selected, collection),
          admission: (command) =>
            evaluateBookCommandAdmission(
              current.aggregate.state,
              current.aggregate.protocol,
              command,
            ),
          basis: () =>
            readPinnedIndexedBookBasis(
              current.aggregate.state,
              current.anchor.state,
              current.anchor.head,
              selected.digest,
              rawRow,
              confirm,
            ),
          rawRow,
          lookup: async (key) => (await this.lookup(current, key, confirm))?.sequence ?? null,
          confirm,
          release: async () => {
            this.source.release(selected);
            this.groups.release(selectedGroups);
            await this.control.releasePin(current.pin);
          },
        });
      } catch (error) {
        if (capture) this.source.release(capture);
        if (groupCapture) this.groups.release(groupCapture);
        try {
          await this.control.releasePin(current.pin);
        } catch {
          /* uncertain protection expires durably */
        }
        throw error;
      }
    });
  }
  private async lookup(current: Recovered, key: string, confirm: () => Promise<void>) {
    let found: bigint | null = null;
    for (const part of [
      { root: current.cold, from: 1n, through: BigInt(current.view.coldThrough) },
      {
        root: current.hot.root,
        from: BigInt(current.view.coldThrough) + 1n,
        through: BigInt(current.view.sequence),
      },
    ]) {
      const result = await lookupIndexEntry(part.root, part.root.contentHash, key, async (id) => {
        const bytes = await this.pages.read(id);
        await confirm();
        return bytes;
      });
      if (result.sequence !== null) {
        requireLedger(
          found === null && result.sequence >= part.from && result.sequence <= part.through,
          "index_identity_mismatch",
        );
        found = result.sequence;
      }
    }
    await confirm();
    if (found === null) return null;
    const hash = current.hashes.get(found);
    requireLedger(hash, "indexed_owner_source_not_canonical");
    return { sequence: found, ...(await current.ports.outcome(found, hash)) };
  }
  private async publish(current: Recovered, evaluated: ReturnType<typeof evaluateOutcomePayload>) {
    const retained = evaluated.transition.protocol.retainedResults.at(-1);
    requireLedger(retained && evaluated.encoded !== null, "ledger_outcome_invalid");
    const { record, prepared: source } = await this.source.prepareAdmittedOutcome(
      evaluated.transition.intent === undefined
        ? { kind: "rejection", retained }
        : {
            kind: "commit",
            intent: evaluated.transition.intent,
            previousRevision: current.aggregate.state.revisions.at(-1) ?? null,
          },
      current.sourceDigest,
      current.ports.confirm,
    );
    requireLedger(record.payload === evaluated.encoded, "indexed_outcome_projection_mismatch");
    const resultingAnchor = this.source.describePrepared(source).after;
    const bytes = JSON.stringify(record);
    requireLedger(
      new TextEncoder().encode(bytes).length <= LEDGER_LIMITS.recordBytes,
      "ledger_capacity_exceeded",
    );
    const canonical = this.canonical.prepareOutcome(current.anchor, bytes);
    const capture = this.source.capture(current.sourceDigest);
    let groups: Awaited<ReturnType<SqliteSemanticGroupCatalog["prepareIndexed"]>>;
    try {
      groups = await this.groups.prepareIndexed(this.source, source, current.groupDigest, {
        confirm: current.ports.confirm,
        readPrevious: (collection, ordinal) =>
          this.source.read(capture, collection, ordinal, current.ports),
      });
    } finally {
      this.source.release(capture);
    }
    const pin = await this.control.pinCurrent(current.view, "construction", this.expiry());
    let selected = false;
    try {
      const confirm = async () => {
        await this.control.readPinned(pin);
        await current.ports.confirm();
      };
      const delta = await prepareIndexedOutcomeIdentityDelta(this.source, source, bytes, {
        confirm,
        lookup: (key) => this.lookup(current, key, confirm),
      });
      let index = current.hot,
        retained: RetainedIndexAppend | null = null;
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
      requireLedger(retained, "index_identity_population_incomplete");
      const registered = await this.pages.registerRetainedAppend(this.control, pin, retained, {
        ...this.anchor(),
        headHash: record.after.contentHash,
        sequence: record.after.sequence,
      });
      await this.control.publishPrepared(pin, registered.digest, (transaction) => {
        this.canonical.publishInTransaction(transaction, canonical);
        this.source.publishInTransaction(transaction, source);
        this.groups.publishInTransaction(transaction, groups);
        this.assertAuthority(current.authority);
        const now = this.clock();
        requireLedger(
          typeof now === "bigint" &&
            now >= BigInt(pin.expiresAt) - this.leaseMilliseconds &&
            now < BigInt(pin.expiresAt),
          "index_pin_expired",
        );
        return undefined;
      });
      selected = true;
      return {
        record,
        anchor: resultingAnchor,
        hot: index,
        sourceDigest: source.digest,
        groupDigest: groups.digest,
        view: {
          ...current.view,
          headHash: record.after.contentHash,
          sequence: record.after.sequence,
          revision: (BigInt(current.view.revision) + 1n).toString(),
          hotRoot: index.root.contentHash,
          hotCount: index.root.population,
        },
      };
    } finally {
      if (!selected)
        try {
          await this.control.releasePin(pin);
        } catch {
          /* uncertain protection remains */
        }
    }
  }
  execute(input: BookCommand): Promise<IndexedOwnerReceipt> {
    const command = snapshotCommand(input);
    requireLedger(command.bookId === this.scope.bookId, "ledger_identity_mismatch");
    return this.serial(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await this.withRecovered(async (current) => {
            const evaluated = evaluateOutcomePayload(current.aggregate, command);
            if (evaluated.encoded === null) {
              await this.storage.sync();
              await current.ports.confirm();
              const original =
                evaluated.transition.result.disposition === "replayed"
                  ? current.originals.get(command.id)
                  : undefined;
              if (original) {
                const located = await this.lookup(
                  current,
                  identityIndexKey({ bookId: command.bookId, family: "command", id: command.id }),
                  current.ports.confirm,
                );
                requireLedger(located?.sequence === original.sequence, "index_identity_mismatch");
                const capture = this.source.capture(current.sourceDigest);
                try {
                  const row = await this.source.read(
                    capture,
                    "protocol.retainedResults",
                    original.sequence,
                    current.ports,
                  );
                  const retained =
                    current.aggregate.protocol.retainedResults[Number(original.sequence - 1n)];
                  requireLedger(
                    retained && row.encoded === encodeBookRow("protocol.retainedResults", retained),
                    "recovery_outcome_mismatch",
                  );
                } finally {
                  this.source.release(capture);
                }
              }
              return {
                head: current.anchor.head,
                result: evaluated.transition.result,
                outcomeSequence: original?.sequence ?? null,
                originalResult: original?.result ?? null,
              };
            }
            requireLedger(
              BigInt(current.anchor.head.sequence) < BigInt(LEDGER_LIMITS.outcomes),
              "ledger_capacity_exceeded",
            );
            await this.scheduleArchive?.();
            const published = await this.publish(current, evaluated);
            const { record } = published;
            await this.storage.sync();
            this.assertAuthority(current.authority);
            // Verify actual newly selected bytes, then retain this locally admitted
            // transition. No cold replay is needed to re-prove our own old prefix.
            const actual = await this.canonical.readOutcome(
              published.anchor,
              BigInt(record.after.sequence),
              record.contentHash,
            );
            requireLedger(actual.encoded === JSON.stringify(record), "recovery_outcome_mismatch");
            const hashes = new Map(current.hashes);
            hashes.set(BigInt(record.after.sequence), record.contentHash);
            const originals = new Map(current.originals);
            requireLedger(evaluated.payload !== null, "ledger_outcome_invalid");
            const retainedPayload = decodeBookOutcome(record.payload);
            requireLedger(retainedPayload.disposition === "decoded", "recovery_outcome_invalid");
            originals.set(command.id, {
              sequence: BigInt(record.after.sequence),
              result: retainedPayload.payload.originalResult,
            });
            this.session = {
              anchor: published.anchor,
              aggregate: Object.freeze({
                state: evaluated.transition.state,
                protocol: evaluated.transition.protocol,
              }),
              authority: current.authority,
              view: published.view,
              cold: current.cold,
              hot: published.hot,
              sourceDigest: published.sourceDigest,
              groupDigest: published.groupDigest,
              hashes,
              originals,
            };
            return this.withRecovered(async (latest) => {
              const original = latest.originals.get(command.id);
              requireLedger(
                original &&
                  original.sequence === BigInt(record.after.sequence) &&
                  latest.hashes.get(original.sequence) === record.contentHash &&
                  evaluated.payload !== null &&
                  encodeBookOutcome({ ...evaluated.payload, originalResult: original.result }) ===
                    evaluated.encoded,
                "recovery_outcome_mismatch",
              );
              return {
                head: latest.anchor.head,
                result: evaluated.transition.result,
                outcomeSequence: original.sequence,
                originalResult: original.result,
              };
            });
          });
        } catch (error) {
          if (
            error instanceof LedgerError &&
            [
              "indexed_canonical_head_conflict",
              "index_view_conflict",
              "index_pin_view_conflict",
              "indexed_source_conflict",
              "group_catalog_conflict",
            ].includes(error.code)
          )
            continue;
          throw error;
        }
      }
      throw new LedgerError("ledger_contention_exceeded");
    });
  }
}

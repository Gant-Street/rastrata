import { hashCanonical } from "@rastrata/kernel";
import {
  copyIndexReaderPin,
  copyIndexAnchor,
  type IndexAnchor,
  type PreparedIndexPublication,
  type IndexReaderPin,
  type SqliteIndexControl,
} from "./index-control.ts";
import {
  INDEX_PAGE_VERSION,
  enumerateIndexPages,
  verifyIndexPageBytes,
  verifyIndexRoot,
  verifyPreparedIndexInsertion,
  type IndexPageReference,
  type IndexRoot,
} from "./index-pages.ts";
import { LedgerError, requireLedger } from "./records.ts";
import type { SqlBinding, SqliteStorage } from "./sqlite.ts";
import {
  atomicSqlite,
  requireSqliteTransaction,
  type SqliteTransaction,
} from "./sqlite-transaction.ts";
import { ConstructionLocations } from "./construction-locations.ts";

const FORMAT = "rastrata-sqlite-index-pages-v1";
const ALLOCATED_FORMAT = "rastrata-sqlite-allocated-index-pages-v1";
const MAX_COORDINATE = (1n << 128n) - 1n;
const COORDINATE = /^[0-9a-f]{32}$/;
const MAX_ALLOCATION = 256;
const MAX_ROOT_CHARS = 4_096;
const HASH = /^[0-9a-f]{64}$/;
export interface RetainedIndexAppend {
  readonly root: IndexRoot;
  readonly added: bigint;
}
function location(value: string) {
  requireLedger(
    typeof value === "string" && /^derived\/[0-9a-f]{64}$/.test(value),
    "index_page_location_invalid",
  );
}

/** Internal append-only derived storage for SQLite-resident pages. NOT the full
 * cold-history capacity solution. No deletion/reuse or active-view publication API
 * exists. The owner supplies the full trusted book/object/generation commitment.
 * External SQL mutation is not made safe by this interface or a local checksum. */
export class SqliteIndexPageStore {
  private readonly locations: ConstructionLocations;
  private readonly appends = new WeakMap<
    object,
    { readonly pin: string; readonly root: IndexRoot; readonly added: bigint }
  >();
  get identityCommitment(): string {
    return this.identityHash;
  }
  private uncertain = false;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly storage: SqliteStorage,
    private readonly identityHash: string,
  ) {
    requireLedger(HASH.test(identityHash), "index_page_store_identity_invalid");
    this.locations = new ConstructionLocations(storage);
  }
  private rows(query: string, ...bindings: SqlBinding[]) {
    return Array.from(this.storage.sql.exec(query, ...bindings));
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private requireCertain() {
    requireLedger(!this.uncertain, "index_page_store_uncertain");
  }
  private metadata() {
    const rows = this.rows(
      "SELECT substr(format, 1, 128) AS format, length(CAST(format AS BLOB)) AS format_bytes, substr(identity_hash, 1, 65) AS identity_hash, length(CAST(identity_hash AS BLOB)) AS identity_bytes FROM ledger_index_page_metadata LIMIT 2",
    );
    requireLedger(
      rows.length === 1 &&
        (rows[0]?.format === FORMAT || rows[0]?.format === ALLOCATED_FORMAT) &&
        rows[0]?.format_bytes === rows[0]?.format.length &&
        rows[0]?.identity_bytes === 64 &&
        rows[0]?.identity_hash === this.identityHash,
      "index_page_store_identity_mismatch",
    );
    return rows[0].format;
  }
  private allocationState(): { issued: string; epoch: string } {
    requireLedger(this.metadata() === ALLOCATED_FORMAT, "index_allocation_unsupported");
    const rows = this.rows(
      "SELECT substr(issued, 1, 33) AS issued, length(CAST(issued AS BLOB)) AS issued_bytes, substr(epoch, 1, 33) AS epoch, length(CAST(epoch AS BLOB)) AS epoch_bytes, substr(digest, 1, 65) AS digest, length(CAST(digest AS BLOB)) AS digest_bytes FROM ledger_index_allocation_state LIMIT 2",
    );
    const row = rows[0];
    requireLedger(
      rows.length === 1 &&
        row &&
        typeof row.issued === "string" &&
        COORDINATE.test(row.issued) &&
        row.issued_bytes === 32 &&
        typeof row.epoch === "string" &&
        COORDINATE.test(row.epoch) &&
        row.epoch_bytes === 32 &&
        row.digest_bytes === 64 &&
        row.digest === this.allocationHash(row.issued, row.epoch),
      "index_allocation_state_corrupt",
    );
    return { issued: row.issued, epoch: row.epoch };
  }
  private allocationHash(issued: string, epoch: string) {
    return hashCanonical({
      domain: ALLOCATED_FORMAT,
      identityHash: this.identityHash,
      issued,
      epoch,
    }).digest;
  }
  private reservationHash(id: string, pin: string, fence: string) {
    return hashCanonical({
      domain: `${ALLOCATED_FORMAT}/reservation`,
      identityHash: this.identityHash,
      location: id,
      pin,
      fence,
    }).digest;
  }
  private reservation(id: string) {
    const row = this.rows(
      "SELECT substr(pin_id, 1, 65) AS pin, length(CAST(pin_id AS BLOB)) AS pin_bytes, substr(fence, 1, 65) AS fence, length(CAST(fence AS BLOB)) AS fence_bytes, substr(digest, 1, 65) AS digest, length(CAST(digest AS BLOB)) AS digest_bytes FROM ledger_index_reservations WHERE location = ?",
      id,
    )[0];
    if (!row) return undefined;
    requireLedger(
      typeof row.pin === "string" &&
        /^[1-9][0-9]{0,63}$/.test(row.pin) &&
        row.pin_bytes === row.pin.length &&
        typeof row.fence === "string" &&
        /^(0|[1-9][0-9]{0,63})$/.test(row.fence) &&
        row.fence_bytes === row.fence.length &&
        row.digest_bytes === 64 &&
        row.digest === this.reservationHash(id, row.pin, row.fence),
      "index_reservation_corrupt",
    );
    const { issued } = this.allocationState();
    requireLedger(
      BigInt(row.fence) <= MAX_COORDINATE &&
        id.slice(8, 40) === BigInt(row.fence).toString(16).padStart(32, "0") &&
        id.slice(40) > "0".repeat(32) &&
        id.slice(40) <= issued,
      "index_reservation_corrupt",
    );
    return { pin: row.pin, fence: row.fence, digest: row.digest };
  }
  private async construction<T>(
    control: SqliteIndexControl,
    pin: IndexReaderPin,
    fn: (pin: IndexReaderPin, transaction: SqliteTransaction) => T,
  ): Promise<T> {
    this.requireCertain();
    this.uncertain = true;
    let result!: T;
    await control.runPinnedConstruction(this.storage, pin, (stored, transaction) => {
      requireLedger(
        stored.view.identityHash === this.identityHash,
        "index_page_store_identity_mismatch",
      );
      this.allocationState();
      result = fn(stored, transaction);
      return undefined;
    });
    this.uncertain = false;
    return result;
  }
  private loadPage(id: string): Uint8Array | undefined {
    this.metadata();
    // Bound the BLOB returned even when a corrupt row advertises an enormous size.
    const rows = this.rows(
      "SELECT substr(digest, 1, 65) AS digest, length(CAST(digest AS BLOB)) AS digest_bytes, byte_count, length(bytes) AS actual_bytes, substr(bytes, 1, 8193) AS bytes FROM ledger_index_pages WHERE location = ?",
      id,
    );
    const row = rows[0];
    if (!row) return undefined;
    requireLedger(
      rows.length === 1 &&
        row.digest_bytes === 64 &&
        row.bytes instanceof ArrayBuffer &&
        row.actual_bytes === row.byte_count,
      "index_page_store_corrupt",
    );
    return verifyIndexPageBytes(
      {
        location: id,
        digest: row.digest,
        byteCount: row.byte_count,
        representationVersion: INDEX_PAGE_VERSION,
      },
      new Uint8Array(row.bytes),
    ).bytes;
  }
  private loadRoot(hash: string): IndexRoot | undefined {
    this.metadata();
    const rows = this.rows(
      "SELECT substr(body, 1, 4097) AS body, length(CAST(body AS BLOB)) AS body_bytes FROM ledger_index_roots WHERE digest = ?",
      hash,
    );
    const row = rows[0];
    if (!row) return undefined;
    requireLedger(
      rows.length === 1 &&
        typeof row.body === "string" &&
        row.body.length <= MAX_ROOT_CHARS &&
        new TextEncoder().encode(row.body).length === row.body_bytes,
      "index_root_store_corrupt",
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.body);
    } catch {
      throw new LedgerError("index_root_store_corrupt");
    }
    const root = verifyIndexRoot(parsed, hash);
    requireLedger(JSON.stringify(root) === row.body, "index_root_store_corrupt");
    return root;
  }
  private async operation<T>(fn: () => T): Promise<T> {
    this.requireCertain();
    this.uncertain = true;
    const snapshot = this.storage.transactionSync(fn);
    await this.storage.sync();
    this.uncertain = false;
    return snapshot;
  }
  /** Explicit provisioning only. Existing/missing live schemas are not reset or
   * silently re-created. The owner must authorize first-time initialization. */
  initialize(mode: "unallocated" | "allocated" = "unallocated"): Promise<void> {
    return this.serial(async () => {
      this.requireCertain();
      this.uncertain = true;
      atomicSqlite(this.storage, (transaction) => this.initializeInTransaction(transaction, mode));
      await this.storage.sync();
      this.uncertain = false;
    });
  }
  /** Same-store atomic first provisioning; caller confirms durability. */
  initializeInTransaction(transaction: SqliteTransaction, mode: "unallocated" | "allocated"): void {
    requireSqliteTransaction(transaction, this.storage);
    requireLedger(mode === "unallocated" || mode === "allocated", "index_allocation_mode_invalid");
    this.rows(
      "CREATE TABLE ledger_index_page_metadata (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), format TEXT NOT NULL, identity_hash TEXT NOT NULL)",
    );
    this.rows(
      "CREATE TABLE ledger_index_pages (location TEXT PRIMARY KEY, digest TEXT NOT NULL, byte_count INTEGER NOT NULL, bytes BLOB NOT NULL) WITHOUT ROWID",
    );
    this.rows(
      "CREATE TABLE ledger_index_roots (digest TEXT PRIMARY KEY, body TEXT NOT NULL) WITHOUT ROWID",
    );
    this.rows(
      "INSERT INTO ledger_index_page_metadata VALUES (1, ?, ?)",
      mode === "allocated" ? ALLOCATED_FORMAT : FORMAT,
      this.identityHash,
    );
    this.metadata();
    if (mode === "allocated") {
      this.rows(
        "CREATE TABLE ledger_index_allocation_state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), issued TEXT NOT NULL, epoch TEXT NOT NULL, digest TEXT NOT NULL)",
      );
      this.rows(
        "CREATE TABLE ledger_index_reservations (location TEXT PRIMARY KEY, pin_id TEXT NOT NULL, fence TEXT NOT NULL, digest TEXT NOT NULL) WITHOUT ROWID",
      );
      const issued = "0".repeat(32);
      this.rows(
        "INSERT INTO ledger_index_allocation_state VALUES (1, ?, ?, ?)",
        issued,
        issued,
        this.allocationHash(issued, issued),
      );
    }
  }
  /** Reconcile metadata/durability only, not all roots, accounting recovery, or
   * service readiness. A failed operation is never automatically re-applied. */
  recover(): Promise<void> {
    return this.serial(async () => {
      this.uncertain = true;
      this.storage.transactionSync(() => {
        if (this.metadata() === ALLOCATED_FORMAT) this.allocationState();
      });
      await this.storage.sync();
      this.uncertain = false;
    });
  }
  put(page: IndexPageReference, input: Uint8Array): Promise<IndexPageReference> {
    // Copy before queuing/awaiting: caller mutations cannot alter the staged bytes.
    const checked = verifyIndexPageBytes(page, input);
    return this.serial(() =>
      this.operation(() => {
        requireLedger(this.metadata() === FORMAT, "index_reserved_write_required");
        const existing = this.loadPage(checked.page.location);
        if (existing) {
          requireLedger(
            existing.length === checked.bytes.length &&
              existing.every((byte, i) => byte === checked.bytes[i]),
            "index_page_location_conflict",
          );
        } else {
          this.rows(
            "INSERT INTO ledger_index_pages VALUES (?, ?, ?, ?)",
            checked.page.location,
            checked.page.digest,
            checked.page.byteCount,
            checked.bytes.buffer,
          );
        }
        return checked.page;
      }),
    );
  }
  /** Explicit allocated-store mode only. IDs are book-store-scoped, strictly
   * increasing 128-bit counters prefixed by the trusted 128-bit fence generation,
   * not hashes. A disaster restore MUST establish a fresh external fence before
   * construction: a restored local counter cannot detect rollback by itself.
   * The durable high-water mark is
   * never reduced by abandonment, consumption or future page reclamation.
   * A lost reply may burn a batch; it never makes that batch reusable. */
  reserve(
    control: SqliteIndexControl,
    pin: IndexReaderPin,
    count: number,
  ): Promise<readonly string[]> {
    const captured = copyIndexReaderPin(pin);
    requireLedger(
      Number.isInteger(count) && count >= 1 && count <= MAX_ALLOCATION,
      "index_allocation_batch_invalid",
    );
    return this.serial(() =>
      this.construction(control, captured, (stored, transaction) => {
        const before = this.allocationState();
        const generation = BigInt(stored.view.fence);
        requireLedger(generation <= MAX_COORDINATE, "index_allocation_epoch_unsupported");
        const epoch = generation.toString(16).padStart(32, "0");
        requireLedger(epoch >= before.epoch, "index_allocation_epoch_regressed");
        const first = BigInt(`0x${before.issued}`) + 1n;
        const last = first + BigInt(count) - 1n;
        requireLedger(last <= MAX_COORDINATE, "index_allocation_exhausted");
        const locations = Array.from(
          { length: count },
          (_, offset) =>
            `derived/${epoch}${(first + BigInt(offset)).toString(16).padStart(32, "0")}`,
        );
        for (const id of locations) {
          requireLedger(
            this.rows("SELECT 1 AS present FROM ledger_index_pages WHERE location = ?", id)
              .length === 0,
            "index_allocation_state_corrupt",
          );
          this.rows(
            "INSERT INTO ledger_index_reservations VALUES (?, ?, ?, ?)",
            id,
            stored.id,
            stored.view.fence,
            this.reservationHash(id, stored.id, stored.view.fence),
          );
        }
        const issued = last.toString(16).padStart(32, "0");
        this.rows(
          "UPDATE ledger_index_allocation_state SET issued = ?, epoch = ?, digest = ? WHERE singleton = 1 AND issued = ? AND epoch = ?",
          issued,
          epoch,
          this.allocationHash(issued, epoch),
          before.issued,
          before.epoch,
        );
        requireLedger(
          this.rows("SELECT changes() AS count")[0]?.count === 1,
          "index_allocation_state_corrupt",
        );
        this.locations.append(transaction, stored, locations);
        return Object.freeze(locations);
      }),
    );
  }
  putReserved(
    control: SqliteIndexControl,
    pin: IndexReaderPin,
    page: IndexPageReference,
    input: Uint8Array,
  ): Promise<IndexPageReference> {
    const captured = copyIndexReaderPin(pin);
    const checked = verifyIndexPageBytes(page, input);
    return this.serial(() =>
      this.construction(control, captured, (stored) => {
        const existing = this.loadPage(checked.page.location);
        if (existing) {
          this.locations.owns(stored, checked.page.location);
          requireLedger(
            existing.length === checked.bytes.length &&
              existing.every((byte, i) => byte === checked.bytes[i]),
            "index_page_location_conflict",
          );
        } else {
          const reserved = this.reservation(checked.page.location);
          requireLedger(
            reserved && reserved.pin === stored.id && reserved.fence === stored.view.fence,
            "index_location_not_reserved",
          );
          this.locations.owns(stored, checked.page.location);
          this.rows(
            "DELETE FROM ledger_index_reservations WHERE location = ? AND pin_id = ? AND fence = ? AND digest = ?",
            checked.page.location,
            stored.id,
            stored.view.fence,
            reserved.digest,
          );
          requireLedger(
            this.rows("SELECT changes() AS count")[0]?.count === 1,
            "index_location_not_reserved",
          );
          this.rows(
            "INSERT INTO ledger_index_pages VALUES (?, ?, ?, ?)",
            checked.page.location,
            checked.page.digest,
            checked.page.byteCount,
            checked.bytes.buffer,
          );
        }
        return checked.page;
      }),
    );
  }
  /** Cancels only this live construction's unwritten reservations. It never
   * deletes page bytes, drops construction tracking or decreases issued IDs.
   * Inactive tracking is cleaned separately; page reclamation is not enabled. */
  abandon(
    control: SqliteIndexControl,
    pin: IndexReaderPin,
    locations: readonly string[],
  ): Promise<number> {
    const capturedPin = copyIndexReaderPin(pin);
    requireLedger(
      Array.isArray(locations) && locations.length >= 1 && locations.length <= MAX_ALLOCATION,
      "index_allocation_batch_invalid",
    );
    const captured = [...locations];
    for (const id of captured) location(id);
    return this.serial(() =>
      this.construction(control, capturedPin, (stored) => {
        let deleted = 0;
        for (const id of captured) {
          const reserved = this.reservation(id);
          if (!reserved || reserved.pin !== stored.id || reserved.fence !== stored.view.fence)
            continue;
          this.rows(
            "DELETE FROM ledger_index_reservations WHERE location = ? AND pin_id = ? AND fence = ? AND digest = ?",
            id,
            stored.id,
            stored.view.fence,
            reserved.digest,
          );
          requireLedger(
            this.rows("SELECT changes() AS count")[0]?.count === 1,
            "index_reservation_corrupt",
          );
          deleted++;
        }
        return deleted;
      }),
    );
  }
  /** Bounded proof of ONE captured construction's allocated-location prefix,
   * including unwritten/abandoned allocations. Drain to complete before using it
   * as an exact set. New allocations are outside this captured high-water mark;
   * a collector still needs the global reference barrier and all other roots. */
  constructionBatches(control: SqliteIndexControl, pin: IndexReaderPin, limit = 128) {
    const captured = copyIndexReaderPin(pin);
    requireLedger(
      Number.isInteger(limit) && limit >= 1 && limit <= 256,
      "index_construction_batch_invalid",
    );
    const store = this;
    return (async function* () {
      const snapshot = await store.serial(() =>
        store.construction(control, captured, (stored) =>
          Object.freeze({
            head: store.locations.head(stored),
            highWater: Object.freeze(store.allocationState()),
          }),
        ),
      );
      let cursor = store.locations.start(snapshot.head);
      for (;;) {
        const batch = await store.serial(() =>
          store.construction(control, captured, () =>
            store.locations.batch(snapshot.head, cursor, limit),
          ),
        );
        cursor = batch.cursor;
        yield Object.freeze({ ...snapshot, ...batch });
        if (batch.complete) return;
      }
    })();
  }
  /** Only inactive constructions enter the durable cleanup queue. This removes
   * at most limit tracking/reservation pairs plus a completed job/head; never
   * page bytes, selected roots, canonical outcomes, or allocation high-water. */
  cleanupConstructions(control: SqliteIndexControl, limit = 128) {
    requireLedger(
      Number.isInteger(limit) && limit >= 1 && limit <= 256,
      "index_construction_batch_invalid",
    );
    return this.serial(async () => {
      this.requireCertain();
      this.uncertain = true;
      let result!: ReturnType<ConstructionLocations["cleanup"]>;
      await control.runIndexMaintenance(this.storage, (view, transaction) => {
        requireLedger(
          view.identityHash === this.identityHash,
          "index_page_store_identity_mismatch",
        );
        this.allocationState();
        result = this.locations.cleanup(
          transaction,
          this.identityHash,
          limit,
          (location, owner) => {
            const reserved = this.reservation(location);
            if (!reserved) return;
            requireLedger(
              reserved.pin === owner.pinId && reserved.fence === owner.fence,
              "index_construction_tracking_corrupt",
            );
            this.rows(
              "DELETE FROM ledger_index_reservations WHERE location = ? AND digest = ?",
              location,
              reserved.digest,
            );
            requireLedger(
              this.rows("SELECT changes() AS count")[0]?.count === 1,
              "index_reservation_corrupt",
            );
          },
        );
        return undefined;
      });
      this.uncertain = false;
      return result;
    });
  }
  read(id: string): Promise<Uint8Array | undefined> {
    location(id);
    return this.serial(() => this.operation(() => this.loadPage(id)));
  }
  /** Descriptor retention, NOT activation of an accounting view. Every selected
   * page is read from SQLite and verified before the descriptor row is inserted.
   * Append-only locations keep the verified graph stable through that insertion.
   * Introducing reclamation requires adding pins/barriers to this protocol first. */
  retainRoot(input: unknown, expectedHash: string): Promise<IndexRoot> {
    const root = verifyIndexRoot(input, expectedHash);
    return this.serial(async () => {
      this.requireCertain();
      this.uncertain = true;
      this.storage.transactionSync(() => this.metadata());
      await this.storage.sync();
      let count = 0n;
      for await (const _entry of enumerateIndexPages(root, root.contentHash, async (id) =>
        this.storage.transactionSync(() => this.loadPage(id)),
      ))
        count++;
      requireLedger(count === BigInt(root.population), "index_page_population_mismatch");
      const snapshot = this.storage.transactionSync(() => {
        const existing = this.loadRoot(root.contentHash);
        const body = JSON.stringify(root);
        requireLedger(body.length <= MAX_ROOT_CHARS, "index_root_store_corrupt");
        if (existing) requireLedger(JSON.stringify(existing) === body, "index_root_store_corrupt");
        else this.rows("INSERT INTO ledger_index_roots VALUES (?, ?)", root.contentHash, body);
        return root;
      });
      await this.storage.sync();
      this.uncertain = false;
      return snapshot;
    });
  }
  /** Verify and retain the complete graph, then durably register its exact target
   * head under a live construction pin. This does not select the accounting view
   * or establish canonical population completeness. */
  async retainPreparedRoot(
    control: SqliteIndexControl,
    pin: IndexReaderPin,
    input: unknown,
    expectedHash: string,
    next: IndexAnchor,
  ): Promise<PreparedIndexPublication> {
    const captured = copyIndexReaderPin(pin),
      target = copyIndexAnchor(next);
    const root = verifyIndexRoot(input, expectedHash);
    requireLedger(
      captured.view.identityHash === this.identityHash,
      "index_page_store_identity_mismatch",
    );
    await control.readPinned(captured);
    // Retention authenticates the full immutable graph. Registration rechecks the
    // exact live construction/input view after I/O and reads the retained root in
    // the same SQL transaction. A failed registration never selects this root.
    await this.retainRoot(root, expectedHash);
    return this.serial(async () => {
      this.requireCertain();
      this.uncertain = true;
      const registered = await control.registerPrepared(this.storage, captured, root, target, () =>
        this.loadRoot(root.contentHash),
      );
      this.uncertain = false;
      return registered;
    });
  }
  /** Retain one genuine COW insertion under an active construction. The initial
   * base must be the retained selected hot root (or its canonical empty root);
   * later bases require this instance's same-pin append certificate. Verify only
   * newly written pages and globally allocated ownership, not the unchanged graph.
   * The owner still owes startup/base integrity and cross-partition ID admission. */
  retainInsertion(
    control: SqliteIndexControl,
    pin: IndexReaderPin,
    insertion: object,
    previous: RetainedIndexAppend | null = null,
  ): Promise<RetainedIndexAppend> {
    const captured = copyIndexReaderPin(pin),
      proof = verifyPreparedIndexInsertion(insertion);
    const prefix = previous === null ? null : this.appends.get(previous);
    requireLedger(previous === null || prefix, "index_append_unretained");
    const pinBytes = JSON.stringify(captured);
    requireLedger(
      proof.before.keySchemaVersion === captured.view.schema &&
        proof.entry.sequence === BigInt(captured.view.sequence) + 1n &&
        (prefix === null
          ? proof.before.contentHash === captured.view.hotRoot
          : prefix?.pin === pinBytes && prefix.root.contentHash === proof.before.contentHash),
      "index_append_context_mismatch",
    );
    return this.serial(async () => {
      const result = await this.construction(control, captured, (stored) => {
        const base = this.loadRoot(proof.before.contentHash);
        requireLedger(
          (proof.before.page === null && proof.before.population === "0") ||
            (base && JSON.stringify(base) === JSON.stringify(proof.before)),
          "index_append_base_missing",
        );
        for (const page of proof.pages) {
          this.locations.owns(stored, page.location);
          const bytes = this.loadPage(page.location);
          requireLedger(bytes, "index_append_page_missing");
          verifyIndexPageBytes(page, bytes);
        }
        const body = JSON.stringify(proof.after);
        requireLedger(body.length <= MAX_ROOT_CHARS, "index_root_store_corrupt");
        const old = this.loadRoot(proof.after.contentHash);
        if (old) requireLedger(JSON.stringify(old) === body, "index_root_store_corrupt");
        else
          this.rows("INSERT INTO ledger_index_roots VALUES (?, ?)", proof.after.contentHash, body);
        requireLedger(
          JSON.stringify(this.loadRoot(proof.after.contentHash)) === body,
          "index_root_store_corrupt",
        );
        return Object.freeze({ root: proof.after, added: (prefix?.added ?? 0n) + 1n });
      });
      this.appends.set(result, { pin: pinBytes, root: result.root, added: result.added });
      return result;
    });
  }
  /** Register exactly a same-instance retained append chain. No full graph scan.
   * Publication/identity completeness and canonical outcome binding remain owner
   * duties. Lost durability confirmation supplies no usable success result. */
  registerRetainedAppend(
    control: SqliteIndexControl,
    pin: IndexReaderPin,
    append: RetainedIndexAppend,
    next: IndexAnchor,
  ): Promise<PreparedIndexPublication> {
    const captured = copyIndexReaderPin(pin),
      target = copyIndexAnchor(next);
    const retained = this.appends.get(append);
    requireLedger(
      retained &&
        retained.pin === JSON.stringify(captured) &&
        BigInt(retained.root.population) === BigInt(captured.view.hotCount) + retained.added,
      "index_append_unretained",
    );
    return this.serial(async () => {
      this.requireCertain();
      this.uncertain = true;
      const result = await control.registerPrepared(
        this.storage,
        captured,
        retained.root,
        target,
        () => this.loadRoot(retained.root.contentHash),
      );
      this.uncertain = false;
      return result;
    });
  }
  /** Loads a durable descriptor; does not substitute for re-verifying its pages. */
  readRootDescriptor(hash: string): Promise<IndexRoot | undefined> {
    requireLedger(HASH.test(hash), "index_root_hash_mismatch");
    return this.serial(() => this.operation(() => this.loadRoot(hash)));
  }
}

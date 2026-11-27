import { hashCanonical, immutableAccountingValue, identifier } from "@rastrata/kernel";
import {
  normalizeArchiveCatalogEntry,
  type ArchiveCatalogAuthority,
  type ArchiveCatalogEntry,
  type ArchiveBookVerifier,
} from "./archive-authority.ts";
import { completeScope } from "./compact-records.ts";
import {
  createArchiveDurabilityPolicy,
  prepareArchiveGenesis,
  encodeArchiveAnchor,
  decodeArchiveAnchor,
  recoverArchiveChain,
  type ArchiveAnchor,
} from "./archive-records.ts";
import {
  referenceArchivePayload,
  type R2ArchiveObjectStore,
  type ArchiveControlVersion,
} from "./r2-archive-store.ts";
import { requireLedger, same, LedgerError, type CompleteBookScope } from "./records.ts";
import { atomicSqlite } from "./sqlite-transaction.ts";
import type { SqlBinding, SqliteStorage } from "./sqlite.ts";
import {
  normalizeArchiveRestorePermit,
  prepareArchiveRestorePermit,
  restoreActor,
  type ArchiveRestorePermit,
} from "./archive-restore-permit.ts";

const VERSION = "rastrata-sqlite-archive-catalog-v1";
const MAX_BYTES = 65_536;
const encoder = new TextEncoder();
const HEX = /^[0-9a-f]{64}$/;
const NATURAL = /^(0|[1-9][0-9]{0,63})$/;
type Kind =
  | "reserve"
  | "activate"
  | "beginMaintenance"
  | "sealFence"
  | "authorizeRestore"
  | "finishMaintenance";
export interface ArchiveCatalogSnapshot {
  readonly version: typeof VERSION;
  readonly catalogObjectId: string;
  readonly revision: string;
  readonly entry: ArchiveCatalogEntry;
  /** A historical observation when active; usable as a maintenance cutoff only
   * while this exact catalog revision remains in maintenance. */
  readonly sealed: {
    readonly anchor: ArchiveAnchor;
    readonly control: ArchiveControlVersion;
  } | null;
  /** Outstanding obligation in maintenance; historical after verified finish.
   * Superseding maintenance retains the obligation until a newer permit replaces
   * it. Incrementing a fence must not accidentally bypass restore verification. */
  readonly restorePermit: ArchiveRestorePermit | null;
  readonly mutation: {
    readonly id: string;
    readonly kind: Kind;
    readonly expectedHash: string | null;
  };
  readonly contentHash: string;
}
type Body = Omit<ArchiveCatalogSnapshot, "contentHash">;
/** Trusted cross-object read port, never constructed from a posting request. */
export interface ArchiveCatalogReader {
  readonly catalogObjectId: string;
  read(): Promise<unknown>;
}
const digest = (body: Body) =>
  hashCanonical({ domain: VERSION, body: JSON.stringify(body) }).digest;
const sameControl = (a: ArchiveControlVersion, b: ArchiveControlVersion) =>
  a.body === b.body && a.nonce === b.nonce && a.storageRevision === b.storageRevision;
function fields(input: unknown, names: readonly string[]) {
  requireLedger(input !== null && typeof input === "object", "archive_catalog_record_corrupt");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  requireLedger(Reflect.ownKeys(input).length === names.length, "archive_catalog_record_corrupt");
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const field = descriptors[name];
    requireLedger(field && "value" in field && field.enumerable, "archive_catalog_record_corrupt");
    result[name] = field.value;
  }
  return result;
}

/** Closed snapshot codec. Its hash establishes integrity, not authority: only a
 * configured catalog reader can establish that this is the current revision. */
export function normalizeArchiveCatalogSnapshot(
  input: unknown,
  scope: CompleteBookScope,
  objectId: string,
): ArchiveCatalogSnapshot {
  identifier(objectId);
  requireLedger(objectId !== scope.objectId, "archive_catalog_storage_conflict");
  const value = fields(input, [
    "version",
    "catalogObjectId",
    "revision",
    "entry",
    "sealed",
    "restorePermit",
    "mutation",
    "contentHash",
  ]);
  requireLedger(
    value.version === VERSION &&
      value.catalogObjectId === objectId &&
      typeof value.revision === "string" &&
      NATURAL.test(value.revision),
    "archive_catalog_record_corrupt",
  );
  const entryFields = fields(value.entry, [
    "version",
    "identity",
    "format",
    "durabilityPolicy",
    "genesisHash",
    "status",
    "fenceGeneration",
  ]);
  requireLedger(typeof entryFields.genesisHash === "string", "archive_catalog_record_corrupt");
  const entry = normalizeArchiveCatalogEntry(value.entry, scope, entryFields.genesisHash);
  const mutation = fields(value.mutation, ["id", "kind", "expectedHash"]);
  requireLedger(
    typeof mutation.id === "string" &&
      typeof mutation.kind === "string" &&
      [
        "reserve",
        "activate",
        "beginMaintenance",
        "sealFence",
        "authorizeRestore",
        "finishMaintenance",
      ].includes(mutation.kind),
    "archive_catalog_record_corrupt",
  );
  const id = identifier(mutation.id);
  requireLedger(
    mutation.expectedHash === null ||
      (typeof mutation.expectedHash === "string" && HEX.test(mutation.expectedHash)),
    "archive_catalog_record_corrupt",
  );
  let sealed: ArchiveCatalogSnapshot["sealed"] = null;
  if (value.sealed !== null) {
    const observed = fields(value.sealed, ["anchor", "control"]);
    const anchor = decodeArchiveAnchor(encodeArchiveAnchor(observed.anchor as ArchiveAnchor));
    const control = fields(observed.control, ["body", "storageRevision", "nonce"]);
    requireLedger(
      same(anchor.identity, scope) &&
        anchor.fenceGeneration === entry.fenceGeneration &&
        control.body === encodeArchiveAnchor(anchor) &&
        typeof control.storageRevision === "string" &&
        control.storageRevision.length > 0 &&
        encoder.encode(control.storageRevision).length <= 1_024 &&
        typeof control.nonce === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(control.nonce),
      "archive_catalog_record_corrupt",
    );
    sealed = {
      anchor,
      control: {
        body: control.body as string,
        storageRevision: control.storageRevision,
        nonce: control.nonce,
      },
    };
  }
  const kind = mutation.kind as Kind;
  const restorePermit =
    value.restorePermit === null
      ? null
      : normalizeArchiveRestorePermit(value.restorePermit, scope, objectId);
  if (restorePermit !== null) {
    requireLedger(
      restorePermit.entry.genesisHash === entry.genesisHash &&
        BigInt(restorePermit.catalogRevision) < BigInt(value.revision) &&
        BigInt(restorePermit.entry.fenceGeneration) <= BigInt(entry.fenceGeneration),
      "archive_catalog_record_corrupt",
    );
    if (restorePermit.entry.fenceGeneration === entry.fenceGeneration) {
      requireLedger(
        sealed !== null &&
          sameControl(sealed.control, restorePermit.control) &&
          encodeArchiveAnchor(sealed.anchor) === encodeArchiveAnchor(restorePermit.anchor),
        "archive_catalog_record_corrupt",
      );
    }
  }
  requireLedger(
    kind === "reserve"
      ? value.revision === "0" &&
          mutation.expectedHash === null &&
          entry.status === "reserved" &&
          entry.fenceGeneration === "0" &&
          sealed === null &&
          restorePermit === null
      : value.revision !== "0" && mutation.expectedHash !== null,
    "archive_catalog_record_corrupt",
  );
  if (kind === "activate")
    requireLedger(
      entry.status === "active" &&
        entry.fenceGeneration === "0" &&
        sealed?.anchor.head.sequence === "0" &&
        restorePermit === null,
      "archive_catalog_record_corrupt",
    );
  if (kind === "beginMaintenance")
    requireLedger(
      entry.status === "maintenance" && entry.fenceGeneration !== "0" && sealed === null,
      "archive_catalog_record_corrupt",
    );
  if (kind === "sealFence" || kind === "finishMaintenance")
    requireLedger(
      entry.status === (kind === "sealFence" ? "maintenance" : "active") &&
        entry.fenceGeneration !== "0" &&
        sealed !== null,
      "archive_catalog_record_corrupt",
    );
  if (kind === "authorizeRestore")
    requireLedger(
      entry.status === "maintenance" &&
        sealed !== null &&
        restorePermit !== null &&
        restorePermit.permitId === id &&
        restorePermit.catalogHash === mutation.expectedHash &&
        BigInt(restorePermit.catalogRevision) + 1n === BigInt(value.revision) &&
        restorePermit.entry.fenceGeneration === entry.fenceGeneration,
      "archive_catalog_record_corrupt",
    );
  if (kind === "finishMaintenance" && restorePermit !== null)
    requireLedger(
      restorePermit.entry.fenceGeneration === entry.fenceGeneration,
      "archive_catalog_record_corrupt",
    );
  const body: Body = {
    version: VERSION,
    catalogObjectId: objectId,
    revision: value.revision,
    entry,
    sealed,
    restorePermit,
    mutation: { id, kind, expectedHash: mutation.expectedHash as string | null },
  };
  requireLedger(value.contentHash === digest(body), "archive_catalog_record_corrupt");
  return immutableAccountingValue({
    ...body,
    contentHash: value.contentHash,
  }) as ArchiveCatalogSnapshot;
}

/** One book's control-plane authority in a DIFFERENT SQLite-backed object.
 * Mutators require trusted provisioning/maintenance authorization at the caller.
 * There is no public HTTP route, automatic repair, retirement or deletion API.
 * Mutation identity is (expected full revision hash, operation ID), not a second
 * financial outcome log. Old expected revisions cannot be reapplied after later
 * mutations; only an immediate exact retry returns the retained current result. */
export class SqliteArchiveCatalog implements ArchiveCatalogAuthority, ArchiveCatalogReader {
  private readonly scope: CompleteBookScope;
  constructor(
    private readonly objectId: string,
    private readonly storage: SqliteStorage,
    scope: CompleteBookScope,
  ) {
    identifier(objectId);
    this.scope = completeScope(scope, scope.objectId);
    requireLedger(objectId !== scope.objectId, "archive_catalog_storage_conflict");
  }
  get catalogObjectId(): string {
    return this.objectId;
  }
  private rows(sql: string, ...bindings: SqlBinding[]) {
    return Array.from(this.storage.sql.exec(sql, ...bindings));
  }
  private normalize(input: unknown): ArchiveCatalogSnapshot {
    return normalizeArchiveCatalogSnapshot(input, this.scope, this.objectId);
  }
  private encode(value: ArchiveCatalogSnapshot): string {
    const body = JSON.stringify(this.normalize(value));
    requireLedger(encoder.encode(body).length <= MAX_BYTES, "archive_catalog_capacity_exceeded");
    return body;
  }
  private load(): ArchiveCatalogSnapshot | undefined {
    const tables = this.rows(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'ledger_*' LIMIT 2",
    );
    if (tables.length === 0) return undefined;
    requireLedger(
      tables.length === 1 && tables[0]?.name === "ledger_archive_catalog",
      "archive_catalog_storage_conflict",
    );
    const rows = this.rows(
      "SELECT singleton, substr(record, 1, 65537) AS record, length(CAST(record AS BLOB)) AS size FROM ledger_archive_catalog LIMIT 2",
    );
    const row = rows[0];
    requireLedger(
      rows.length === 1 &&
        row?.singleton === 1 &&
        typeof row.record === "string" &&
        typeof row.size === "number" &&
        row.size <= MAX_BYTES &&
        encoder.encode(row.record).length === row.size,
      "archive_catalog_record_corrupt",
    );
    const value = this.normalize(JSON.parse(row.record));
    requireLedger(this.encode(value) === row.record, "archive_catalog_record_corrupt");
    return value;
  }
  async read(): Promise<ArchiveCatalogSnapshot> {
    await this.storage.sync();
    const current = atomicSqlite(this.storage, () => this.load());
    requireLedger(current, "archive_catalog_missing");
    await this.storage.sync();
    return current;
  }
  async readEntry(scope: CompleteBookScope): Promise<ArchiveCatalogEntry> {
    requireLedger(
      same(completeScope(scope, this.scope.objectId), this.scope),
      "archive_catalog_identity_mismatch",
    );
    return (await this.read()).entry;
  }
  /** Privileged new-book allocation only. Ordinary reads/commands never call
   * this to recover missing authority. Repeating allocation cannot reset status. */
  async reserve(encodedGenesis: string, operationId: string): Promise<ArchiveCatalogSnapshot> {
    const id = identifier(operationId);
    requireLedger(
      typeof encodedGenesis === "string" && encodedGenesis.length <= 1_048_576,
      "archive_invalid_input",
    );
    const manifest = prepareArchiveGenesis(
      this.scope,
      createArchiveDurabilityPolicy(true),
      encodedGenesis,
      referenceArchivePayload(this.scope, this.scope.objectId, encoder.encode(encodedGenesis)),
    );
    const value = atomicSqlite(this.storage, () => {
      const current = this.load();
      if (current) {
        requireLedger(
          current.entry.genesisHash === manifest.genesisHash,
          "archive_catalog_genesis_mismatch",
        );
        return current;
      }
      const body: Body = {
        version: VERSION,
        catalogObjectId: this.objectId,
        revision: "0",
        entry: {
          version: "rastrata-archive-catalog-v1",
          identity: this.scope,
          format: manifest.format,
          durabilityPolicy: manifest.durabilityPolicy,
          genesisHash: manifest.genesisHash,
          status: "reserved",
          fenceGeneration: "0",
        },
        sealed: null,
        restorePermit: null,
        mutation: { id, kind: "reserve", expectedHash: null },
      };
      const record = this.normalize({ ...body, contentHash: digest(body) });
      this.rows(
        "CREATE TABLE ledger_archive_catalog (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), record TEXT NOT NULL)",
      );
      this.rows("INSERT INTO ledger_archive_catalog VALUES (1, ?)", this.encode(record));
      return record;
    });
    await this.storage.sync();
    return value;
  }
  private retry(
    current: ArchiveCatalogSnapshot,
    expected: ArchiveCatalogSnapshot,
    id: string,
    kind: Kind,
  ): boolean {
    if (current.mutation.expectedHash === expected.contentHash && current.mutation.id === id) {
      requireLedger(current.mutation.kind === kind, "archive_catalog_operation_conflict");
      return true;
    }
    requireLedger(current.contentHash === expected.contentHash, "archive_catalog_head_conflict");
    return false;
  }
  private async prepare(expectedInput: ArchiveCatalogSnapshot, operationId: string, kind: Kind) {
    const expected = this.normalize(expectedInput),
      id = identifier(operationId),
      current = await this.read();
    return { expected, id, current, repeated: this.retry(current, expected, id, kind) };
  }
  private async commit(
    expected: ArchiveCatalogSnapshot,
    id: string,
    kind: Kind,
    entry: ArchiveCatalogEntry,
    sealed: ArchiveCatalogSnapshot["sealed"],
    restorePermit: ArchiveRestorePermit | null = expected.restorePermit,
  ): Promise<ArchiveCatalogSnapshot> {
    const value = atomicSqlite(this.storage, () => {
      const current = this.load();
      requireLedger(current, "archive_catalog_missing");
      if (this.retry(current, expected, id, kind)) return current;
      const revision = (BigInt(current.revision) + 1n).toString();
      const body: Body = {
        version: VERSION,
        catalogObjectId: this.objectId,
        revision,
        entry,
        sealed,
        restorePermit,
        mutation: { id, kind, expectedHash: current.contentHash },
      };
      const next = this.normalize({ ...body, contentHash: digest(body) });
      this.rows(
        "UPDATE ledger_archive_catalog SET record = ? WHERE singleton = 1 AND record = ?",
        this.encode(next),
        this.encode(current),
      );
      requireLedger(
        this.rows("SELECT changes() AS count")[0]?.count === 1,
        "archive_catalog_head_conflict",
      );
      return next;
    });
    await this.storage.sync();
    return value;
  }
  private async observe(store: R2ArchiveObjectStore, expected: ArchiveCatalogSnapshot) {
    const control = await store.readControl();
    requireLedger(control, "archive_catalog_archive_missing");
    const anchor = decodeArchiveAnchor(control.body);
    requireLedger(same(anchor.identity, this.scope), "archive_catalog_identity_mismatch");
    const recovered = await recoverArchiveChain(store, anchor, expected.entry.durabilityPolicy);
    // Genesis digest is part of the catalog's independent provisioning identity.
    requireLedger(
      recovered.genesisManifest.genesisHash === expected.entry.genesisHash,
      "archive_catalog_genesis_mismatch",
    );
    return {
      anchor,
      control: {
        body: recovered.control.body,
        storageRevision: recovered.control.storageRevision,
        nonce: recovered.control.nonce,
      },
    };
  }
  private async confirmBook(
    store: R2ArchiveObjectStore,
    verifier: ArchiveBookVerifier,
    expected: ArchiveCatalogSnapshot,
    sealed: NonNullable<ArchiveCatalogSnapshot["sealed"]>,
  ) {
    const evidence = await verifier.verifyHead(sealed.anchor);
    requireLedger(
      same(evidence.identity, this.scope) &&
        evidence.genesisHash === expected.entry.genesisHash &&
        same(evidence.head, sealed.anchor.head) &&
        evidence.manifestHash === sealed.anchor.manifestHash &&
        sameControl(evidence.control, sealed.control),
      "archive_catalog_book_mismatch",
    );
    if (expected.restorePermit !== null) {
      requireLedger(
        expected.restorePermit.entry.fenceGeneration === expected.entry.fenceGeneration &&
          evidence.restoredUnderPermitHash === expected.restorePermit.contentHash,
        "archive_restore_unverified",
      );
    }
    const current = await store.readControl();
    requireLedger(
      current && sameControl(current, sealed.control),
      "archive_catalog_archive_changed",
    );
  }
  async activate(
    expectedInput: ArchiveCatalogSnapshot,
    operationId: string,
    store: R2ArchiveObjectStore,
    verifier: ArchiveBookVerifier,
  ) {
    const { expected, id, current, repeated } = await this.prepare(
      expectedInput,
      operationId,
      "activate",
    );
    if (repeated) return current;
    requireLedger(current.entry.status === "reserved", "archive_catalog_phase_invalid");
    const sealed = await this.observe(store, current);
    requireLedger(
      sealed.anchor.head.sequence === "0" &&
        sealed.anchor.fenceGeneration === current.entry.fenceGeneration,
      "archive_catalog_activation_mismatch",
    );
    await this.confirmBook(store, verifier, current, sealed);
    return this.commit(expected, id, "activate", { ...current.entry, status: "active" }, sealed);
  }
  async beginMaintenance(expectedInput: ArchiveCatalogSnapshot, operationId: string) {
    const { expected, id, current, repeated } = await this.prepare(
      expectedInput,
      operationId,
      "beginMaintenance",
    );
    if (repeated) return current;
    requireLedger(
      current.entry.status === "active" || current.entry.status === "maintenance",
      "archive_catalog_phase_invalid",
    );
    return this.commit(
      expected,
      id,
      "beginMaintenance",
      {
        ...current.entry,
        status: "maintenance",
        fenceGeneration: (BigInt(current.entry.fenceGeneration) + 1n).toString(),
      },
      null,
      current.entry.status === "active" ? null : current.restorePermit,
    );
  }
  /** Privileged authorization only; approvedBy is provenance, not authentication.
   * Persist the exact cutoff outside the book restore set before ANY book change.
   * A superseded pending restore must be explicitly reauthorized at the newer
   * sealed fence; maintenance increments alone cannot drop the obligation. */
  async authorizeRestore(
    expectedInput: ArchiveCatalogSnapshot,
    operationId: string,
    approvedByInput: string,
    store: R2ArchiveObjectStore,
  ): Promise<ArchiveCatalogSnapshot> {
    const approvedBy = restoreActor(approvedByInput);
    const { expected, id, current, repeated } = await this.prepare(
      expectedInput,
      operationId,
      "authorizeRestore",
    );
    if (repeated) {
      requireLedger(
        current.restorePermit?.approvedBy === approvedBy,
        "archive_catalog_operation_conflict",
      );
      return current;
    }
    requireLedger(
      current.entry.status === "maintenance" && current.sealed !== null,
      "archive_catalog_phase_invalid",
    );
    requireLedger(
      current.restorePermit === null ||
        BigInt(current.restorePermit.entry.fenceGeneration) < BigInt(current.entry.fenceGeneration),
      "archive_restore_already_authorized",
    );
    const observed = await this.observe(store, current);
    requireLedger(
      sameControl(observed.control, current.sealed.control),
      "archive_catalog_archive_changed",
    );
    const finalControl = await store.readControl();
    requireLedger(
      finalControl !== null && sameControl(finalControl, current.sealed.control),
      "archive_catalog_archive_changed",
    );
    const permit = prepareArchiveRestorePermit(
      this.scope,
      this.objectId,
      current.revision,
      current.contentHash,
      current.entry,
      current.sealed.anchor,
      current.sealed.control,
      id,
      approvedBy,
    );
    const result = await this.commit(
      expected,
      id,
      "authorizeRestore",
      current.entry,
      current.sealed,
      permit,
    );
    requireLedger(
      result.restorePermit?.contentHash === permit.contentHash,
      "archive_catalog_operation_conflict",
    );
    return result;
  }
  async sealFence(
    expectedInput: ArchiveCatalogSnapshot,
    operationId: string,
    store: R2ArchiveObjectStore,
  ) {
    const { expected, id, current, repeated } = await this.prepare(
      expectedInput,
      operationId,
      "sealFence",
    );
    if (repeated) return current;
    requireLedger(
      current.entry.status === "maintenance" && current.sealed === null,
      "archive_catalog_phase_invalid",
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      const observed = await this.observe(store, current);
      requireLedger(
        BigInt(observed.anchor.fenceGeneration) <= BigInt(current.entry.fenceGeneration),
        "archive_catalog_fence_mismatch",
      );
      if (observed.anchor.fenceGeneration !== current.entry.fenceGeneration) {
        const target = { ...observed.anchor, fenceGeneration: current.entry.fenceGeneration };
        const result = await store.compareAndSwapControl(
          observed.control,
          encodeArchiveAnchor(target),
        );
        if (result.disposition !== "written") continue;
      }
      const sealed = await this.observe(store, current);
      requireLedger(
        sealed.anchor.fenceGeneration === current.entry.fenceGeneration,
        "archive_catalog_fence_mismatch",
      );
      return this.commit(expected, id, "sealFence", current.entry, sealed);
    }
    throw new LedgerError("archive_catalog_fence_conflict");
  }
  async finishMaintenance(
    expectedInput: ArchiveCatalogSnapshot,
    operationId: string,
    store: R2ArchiveObjectStore,
    verifier: ArchiveBookVerifier,
  ) {
    const { expected, id, current, repeated } = await this.prepare(
      expectedInput,
      operationId,
      "finishMaintenance",
    );
    if (repeated) return current;
    requireLedger(
      current.entry.status === "maintenance" && current.sealed !== null,
      "archive_catalog_phase_invalid",
    );
    const observed = await this.observe(store, current);
    requireLedger(
      sameControl(observed.control, current.sealed.control),
      "archive_catalog_archive_changed",
    );
    await this.confirmBook(store, verifier, current, current.sealed);
    return this.commit(
      expected,
      id,
      "finishMaintenance",
      { ...current.entry, status: "active" },
      current.sealed,
    );
  }
}

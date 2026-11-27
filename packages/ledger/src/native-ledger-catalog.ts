import { createHash } from "node:crypto";
import { hashCanonical, identifier, immutableAccountingValue } from "@rastrata/kernel";
import { completeScope } from "./compact-records.ts";
import { decodeAggregate, requireLedger, type CompleteBookScope } from "./records.ts";
import { atomicSqlite } from "./sqlite-transaction.ts";
import type { SqlBinding, SqliteStorage } from "./sqlite.ts";
import type { NativeLedgerHead } from "./sqlite-ledger-repository.ts";
import type { NativeWriterRetirement } from "./authorized-native-ledger.ts";
import {
  normalizeNativeArchiveSeal,
  sealNativeArchive,
  resumeNativeArchive,
  type NativeArchiveSeal,
} from "./native-outcome-outbox.ts";
import type { R2ArchiveObjectStore } from "./r2-archive-store.ts";
import type {
  NativeProjectionDigest,
  NativeProjectionProgress,
} from "./native-projection-audit.ts";

const VERSION = "rastrata-native-catalog-v1";
const MAX_BYTES = 65536;
const natural = /^(0|[1-9][0-9]{0,63})$/;
const hex = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
type Kind = "reserve" | "activate" | "quiesce" | "retire" | "seal" | "restore" | "resume";

export interface NativeCatalogSnapshot {
  readonly version: typeof VERSION;
  readonly catalogObjectId: string;
  readonly revision: string;
  readonly identity: CompleteBookScope;
  readonly genesisHash: string;
  readonly status: "reserved" | "active" | "maintenance";
  readonly fence: string;
  readonly retirement: NativeWriterRetirement | null;
  readonly sealed: NativeArchiveSeal | null;
  readonly restore: {
    readonly requestId: string;
    readonly approvedBy: string;
    readonly projection: NativeProjectionDigest;
    readonly authorizationRevision: string;
    /** Present only for independently reconciled, unavailable-source recovery. */
    readonly recovery?: {
      readonly evidenceId: string;
      readonly expectedCatalogHash: string;
    };
  } | null;
  readonly mutation: {
    readonly id: string;
    readonly kind: Kind;
    readonly expectedHash: string | null;
  };
  readonly contentHash: string;
}
type Body = Omit<NativeCatalogSnapshot, "contentHash">;

/** Configured trusted book-object RPC, never supplied by a posting request.
 * The implementation must read durable book evidence and verify archive setup;
 * returning request fields or a caller's `ready` flag is not this contract. */
export interface NativeCatalogBook {
  /** Stop this physical object's cached ingress and in-flight admissions. The
   * durable catalog must already be in maintenance at this exact hash. */
  quarantineWriter?(
    scope: CompleteBookScope,
    catalogHash: string,
  ): Promise<{ readonly scope: CompleteBookScope; readonly catalogHash: string }>;
  inspectProvisioned(scope: CompleteBookScope): Promise<{
    readonly scope: CompleteBookScope;
    readonly genesis: string;
    readonly head: NativeLedgerHead;
    readonly writerFence: string;
  }>;
  retireWriter(
    scope: CompleteBookScope,
    requestId: string,
    expectedFence: string,
  ): Promise<NativeWriterRetirement>;
  inspectRetiredProjection?(
    scope: CompleteBookScope,
    expectedFence: string,
  ): Promise<
    NativeProjectionProgress & {
      readonly scope: CompleteBookScope;
      readonly head: NativeLedgerHead;
      readonly authorizationRevision: string;
    }
  >;
  prepareRestoredWriter?(
    scope: CompleteBookScope,
    approvalHash: string,
  ): Promise<{
    readonly scope: CompleteBookScope;
    readonly approvalHash: string;
    readonly head: NativeLedgerHead;
    readonly writerFence: string;
    readonly authorizationRevision: string;
    readonly projection: NativeProjectionDigest;
  }>;
}

/** Trusted recovery authority output, NOT an ordinary request payload. The
 * authority authenticates the operator independently of lost book access and
 * reconciles the latest acknowledged history, projection and revocation state
 * from surviving evidence. An archive prefix or target replay alone is not proof.
 * Uncertain completeness must refuse authorization. */
export interface NativeRecoveryEvidence {
  readonly scope: CompleteBookScope;
  readonly requestId: string;
  readonly expectedCatalogHash: string;
  readonly evidenceId: string;
  readonly approvedBy: string;
  readonly genesisHash: string;
  readonly head: NativeLedgerHead;
  readonly projection: NativeProjectionDigest;
  readonly authorizationRevision: string;
}

function fields(value: unknown, names: string): Record<string, unknown> {
  requireLedger(value !== null && typeof value === "object", "native_catalog_corrupt");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireLedger(Reflect.ownKeys(descriptors).sort().join(",") === names, "native_catalog_corrupt");
  const result: Record<string, unknown> = {};
  for (const name of names.split(",")) {
    const descriptor = descriptors[name];
    requireLedger(
      descriptor && "value" in descriptor && descriptor.enumerable,
      "native_catalog_corrupt",
    );
    result[name] = descriptor.value;
  }
  return result;
}
function id(value: unknown): string {
  requireLedger(typeof value === "string" && value.length <= 1024, "native_catalog_corrupt");
  return identifier(value);
}
function digest(value: unknown): string {
  requireLedger(typeof value === "string" && hex.test(value), "native_catalog_corrupt");
  return value;
}
function counter(value: unknown): string {
  requireLedger(typeof value === "string" && natural.test(value), "native_catalog_corrupt");
  return value;
}
function head(value: unknown): NativeLedgerHead {
  const row = fields(value, "bookRevision,chainHash,sequence");
  const sequence = counter(row.sequence),
    bookRevision = counter(row.bookRevision);
  requireLedger(
    BigInt(sequence) <= (1n << 63n) - 1n && BigInt(bookRevision) <= BigInt(sequence),
    "native_catalog_corrupt",
  );
  return { sequence, bookRevision, chainHash: digest(row.chainHash) };
}
function retirement(value: unknown, scope: CompleteBookScope): NativeWriterRetirement {
  const row = fields(value, "actorId,contentHash,fence,head,previousFence,requestId");
  const body = {
    requestId: id(row.requestId),
    actorId: id(row.actorId),
    previousFence: counter(row.previousFence),
    fence: counter(row.fence),
    head: { ...head(row.head) },
  };
  const contentHash = hashCanonical({ scope: JSON.stringify(scope), retirement: body }).digest;
  requireLedger(
    BigInt(body.fence) === BigInt(body.previousFence) + 1n && row.contentHash === contentHash,
    "native_catalog_corrupt",
  );
  return { ...body, contentHash };
}
const hash = (body: Body) => hashCanonical({ domain: VERSION, body: JSON.stringify(body) }).digest;

/** One control record in a separate physical object, not a second outcome log.
 * Privileged callers authenticate maintenance/provisioning before invoking these
 * methods. Immediate identical CAS retries reconcile lost replies; old revisions
 * cannot be reused after later mutations. There is no reset or unretire operation.
 * This is the native platform-confirmed lifecycle, not the archive-required
 * indexed catalog or a writable restore installer. */
export class NativeLedgerCatalog {
  private readonly scope: CompleteBookScope;
  constructor(
    private readonly storage: SqliteStorage,
    private readonly objectId: string,
    scope: CompleteBookScope,
    private readonly book: NativeCatalogBook,
    private readonly archive?: R2ArchiveObjectStore,
  ) {
    id(objectId);
    this.scope = completeScope(scope, scope.objectId);
    requireLedger(objectId !== this.scope.objectId, "native_catalog_storage_conflict");
  }
  private normalize(input: unknown): NativeCatalogSnapshot {
    const row = fields(
      input,
      "catalogObjectId,contentHash,fence,genesisHash,identity,mutation,restore,retirement,revision,sealed,status,version",
    );
    const identity = completeScope(row.identity as CompleteBookScope, this.scope.objectId);
    requireLedger(
      row.version === VERSION &&
        row.catalogObjectId === this.objectId &&
        JSON.stringify(identity) === JSON.stringify(this.scope),
      "native_catalog_identity_mismatch",
    );
    requireLedger(
      row.status === "reserved" || row.status === "active" || row.status === "maintenance",
      "native_catalog_corrupt",
    );
    const mutation = fields(row.mutation, "expectedHash,id,kind");
    requireLedger(
      ["reserve", "activate", "quiesce", "retire", "seal", "restore", "resume"].includes(
        mutation.kind as string,
      ),
      "native_catalog_corrupt",
    );
    const approval =
      row.restore === null
        ? null
        : fields(
            row.restore,
            Object.hasOwn(row.restore as object, "recovery")
              ? "approvedBy,authorizationRevision,projection,recovery,requestId"
              : "approvedBy,authorizationRevision,projection,requestId",
          );
    const projection = approval === null ? null : fields(approval.projection, "count,digest");
    const recovery =
      approval !== null && Object.hasOwn(approval, "recovery")
        ? fields(approval.recovery, "evidenceId,expectedCatalogHash")
        : null;
    const body: Body = {
      version: VERSION,
      catalogObjectId: this.objectId,
      revision: counter(row.revision),
      identity,
      genesisHash: digest(row.genesisHash),
      status: row.status,
      fence: counter(row.fence),
      retirement: row.retirement === null ? null : retirement(row.retirement, identity),
      sealed: row.sealed === null ? null : normalizeNativeArchiveSeal(row.sealed, identity),
      restore:
        approval === null
          ? null
          : {
              requestId: id(approval.requestId),
              approvedBy: id(approval.approvedBy),
              projection: { count: counter(projection?.count), digest: digest(projection?.digest) },
              authorizationRevision: counter(approval.authorizationRevision),
              ...(recovery === null
                ? {}
                : {
                    recovery: {
                      evidenceId: id(recovery.evidenceId),
                      expectedCatalogHash: digest(recovery.expectedCatalogHash),
                    },
                  }),
            },
      mutation: {
        id: id(mutation.id),
        kind: mutation.kind as Kind,
        expectedHash: mutation.expectedHash === null ? null : digest(mutation.expectedHash),
      },
    };
    requireLedger(
      body.status !== "reserved" ||
        (body.fence === "0" &&
          body.retirement === null &&
          body.sealed === null &&
          body.restore === null),
      "native_catalog_corrupt",
    );
    requireLedger(
      body.retirement === null
        ? (body.status === "maintenance" || body.fence === "0") &&
            body.sealed === null &&
            body.restore === null
        : body.retirement.fence === body.fence,
      "native_catalog_corrupt",
    );
    requireLedger(
      (body.revision === "0") === (body.mutation.expectedHash === null) &&
        (body.revision === "0") === (body.mutation.kind === "reserve"),
      "native_catalog_corrupt",
    );
    requireLedger(
      body.mutation.kind ===
        (body.status === "reserved"
          ? "reserve"
          : body.status === "active"
            ? body.restore === null
              ? "activate"
              : "resume"
            : body.retirement === null
              ? "quiesce"
              : body.sealed === null
                ? "retire"
                : body.restore === null
                  ? "seal"
                  : "restore"),
      "native_catalog_corrupt",
    );
    requireLedger(
      body.restore === null ||
        (body.sealed !== null &&
          (body.mutation.kind === "resume" || body.restore.requestId === body.mutation.id)),
      "native_catalog_corrupt",
    );
    requireLedger(
      body.sealed === null ||
        (body.retirement !== null &&
          body.sealed.genesisHash === body.genesisHash &&
          body.sealed.fence === body.fence &&
          JSON.stringify(body.sealed.head) === JSON.stringify(body.retirement.head)),
      "native_catalog_corrupt",
    );
    requireLedger(row.contentHash === hash(body), "native_catalog_corrupt");
    return immutableAccountingValue({
      ...body,
      contentHash: row.contentHash,
    }) as NativeCatalogSnapshot;
  }
  private rows(sql: string, ...bindings: SqlBinding[]) {
    return Array.from(this.storage.sql.exec(sql, ...bindings));
  }
  private encode(snapshot: NativeCatalogSnapshot): string {
    const encoded = JSON.stringify(this.normalize(snapshot));
    requireLedger(encoder.encode(encoded).length <= MAX_BYTES, "native_catalog_capacity_exceeded");
    return encoded;
  }
  private load(): NativeCatalogSnapshot | null {
    const tables = this.rows(
      "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'ledger_*' LIMIT 2",
    );
    if (tables.length === 0) return null;
    requireLedger(
      tables.length === 1 && tables[0]?.name === "ledger_native_catalog",
      "native_catalog_storage_conflict",
    );
    const rows = this.rows(
      "SELECT singleton, CASE WHEN length(CAST(record AS BLOB))<=65536 THEN record END AS record FROM ledger_native_catalog LIMIT 2",
    );
    requireLedger(
      rows.length === 1 && rows[0]?.singleton === 1 && typeof rows[0].record === "string",
      "native_catalog_corrupt",
    );
    const snapshot = this.normalize(JSON.parse(rows[0].record));
    requireLedger(this.encode(snapshot) === rows[0].record, "native_catalog_corrupt");
    return snapshot;
  }
  async read(): Promise<NativeCatalogSnapshot> {
    await this.storage.sync();
    const value = atomicSqlite(this.storage, () => this.load());
    requireLedger(value !== null, "native_catalog_missing");
    await this.storage.sync();
    return value;
  }
  async reserve(genesis: string, operationId: string): Promise<NativeCatalogSnapshot> {
    const operation = id(operationId);
    requireLedger(
      typeof genesis === "string" && encoder.encode(genesis).length <= 1048576,
      "native_catalog_genesis_invalid",
    );
    requireLedger(
      decodeAggregate(genesis).state.identity.bookId === this.scope.bookId,
      "native_catalog_identity_mismatch",
    );
    const genesisHash = sha(genesis);
    await this.storage.sync();
    const result = atomicSqlite(this.storage, () => {
      const existing = this.load();
      if (existing) {
        requireLedger(existing.genesisHash === genesisHash, "native_catalog_genesis_mismatch");
        return existing;
      }
      requireLedger(this.scope.generation === "0", "native_ledger_restore_required");
      const body: Body = {
        version: VERSION,
        catalogObjectId: this.objectId,
        revision: "0",
        identity: this.scope,
        genesisHash,
        status: "reserved",
        fence: "0",
        retirement: null,
        sealed: null,
        restore: null,
        mutation: { id: operation, kind: "reserve", expectedHash: null },
      };
      const value = this.normalize({ ...body, contentHash: hash(body) });
      this.rows(
        "CREATE TABLE ledger_native_catalog (singleton INTEGER PRIMARY KEY CHECK(singleton=1), record TEXT NOT NULL)",
      );
      this.rows("INSERT INTO ledger_native_catalog VALUES (1,?)", this.encode(value));
      return value;
    });
    await this.storage.sync();
    return result;
  }
  private retry(
    current: NativeCatalogSnapshot,
    expected: NativeCatalogSnapshot,
    operationId: string,
    kind: Kind,
  ): boolean {
    if (
      current.mutation.id === operationId &&
      current.mutation.expectedHash === expected.contentHash
    ) {
      requireLedger(current.mutation.kind === kind, "native_catalog_operation_conflict");
      return true;
    }
    requireLedger(current.contentHash === expected.contentHash, "native_catalog_head_conflict");
    return false;
  }
  private async prepare(input: NativeCatalogSnapshot, operationId: string, kind: Kind) {
    const expected = this.normalize(input),
      operation = id(operationId),
      current = await this.read();
    return {
      expected,
      operation,
      current,
      repeated: this.retry(current, expected, operation, kind),
    };
  }
  private async commit(
    expected: NativeCatalogSnapshot,
    operation: string,
    kind: Kind,
    change: Pick<Body, "status" | "fence" | "retirement">,
    sealed: NativeArchiveSeal | null = expected.sealed,
    restore: Body["restore"] = expected.restore,
  ) {
    const value = atomicSqlite(this.storage, () => {
      const current = this.load();
      requireLedger(current !== null, "native_catalog_missing");
      if (this.retry(current, expected, operation, kind)) return current;
      const { contentHash: _, ...previous } = current;
      const body: Body = {
        ...previous,
        ...change,
        sealed,
        restore,
        revision: (BigInt(current.revision) + 1n).toString(),
        mutation: { id: operation, kind, expectedHash: current.contentHash },
      };
      const next = this.normalize({ ...body, contentHash: hash(body) });
      const changed = this.rows(
        "UPDATE ledger_native_catalog SET record=? WHERE singleton=1 AND record=? RETURNING singleton",
        this.encode(next),
        this.encode(current),
      );
      requireLedger(changed.length === 1, "native_catalog_head_conflict");
      return next;
    });
    await this.storage.sync();
    return value;
  }
  async activate(
    input: NativeCatalogSnapshot,
    operationId: string,
  ): Promise<NativeCatalogSnapshot> {
    const { expected, operation, current, repeated } = await this.prepare(
      input,
      operationId,
      "activate",
    );
    if (repeated) return current;
    requireLedger(expected.status === "reserved", "native_catalog_not_reserved");
    const evidence = await this.book.inspectProvisioned(expected.identity);
    const observed = head(evidence.head);
    requireLedger(
      JSON.stringify(completeScope(evidence.scope, this.scope.objectId)) ===
        JSON.stringify(this.scope) &&
        sha(evidence.genesis) === expected.genesisHash &&
        evidence.writerFence === expected.fence &&
        BigInt(observed.sequence) >= 1n &&
        BigInt(observed.bookRevision) >= 1n,
      "native_catalog_provisioning_mismatch",
    );
    return this.commit(expected, operation, "activate", {
      status: "active",
      fence: expected.fence,
      retirement: null,
    });
  }
  async beginMaintenance(
    input: NativeCatalogSnapshot,
    operationId: string,
  ): Promise<NativeCatalogSnapshot> {
    const { expected, operation, current, repeated } = await this.prepare(
      input,
      operationId,
      "quiesce",
    );
    if (repeated) return current;
    requireLedger(expected.status === "active", "native_catalog_not_active");
    return this.commit(
      expected,
      operation,
      "quiesce",
      {
        status: "maintenance",
        fence: expected.fence,
        retirement: null,
      },
      null,
      null,
    );
  }
  async retireWriter(
    input: NativeCatalogSnapshot,
    operationId: string,
  ): Promise<NativeCatalogSnapshot> {
    const { expected, operation, current, repeated } = await this.prepare(
      input,
      operationId,
      "retire",
    );
    if (repeated) return current;
    requireLedger(
      expected.status === "maintenance" && expected.retirement === null,
      "native_catalog_not_awaiting_retirement",
    );
    // The quiesce operation fixes the source retirement identity, even if a
    // coordinator loses its reply and later retries with another RPC attempt.
    const stopped = retirement(
      await this.book.retireWriter(expected.identity, expected.mutation.id, expected.fence),
      expected.identity,
    );
    requireLedger(
      stopped.requestId === expected.mutation.id && stopped.previousFence === expected.fence,
      "native_catalog_retirement_mismatch",
    );
    return this.commit(expected, operation, "retire", {
      status: "maintenance",
      fence: stopped.fence,
      retirement: stopped,
    });
  }
  /** Persist only the actual conditional R2 seal at the source retirement head.
   * This selects a recovery cutoff; full accounting replay and replacement
   * verification are still required before the replacement writer becomes active. */
  async sealArchive(
    input: NativeCatalogSnapshot,
    operationId: string,
  ): Promise<NativeCatalogSnapshot> {
    const { expected, operation, current, repeated } = await this.prepare(
      input,
      operationId,
      "seal",
    );
    if (repeated) return current;
    requireLedger(
      expected.status === "maintenance" && expected.retirement !== null && expected.sealed === null,
      "native_catalog_not_awaiting_seal",
    );
    requireLedger(this.archive !== undefined, "native_catalog_archive_unconfigured");
    const sealed = await sealNativeArchive(
      this.archive,
      expected.identity,
      expected.genesisHash,
      expected.retirement.head,
      expected.retirement.previousFence,
      expected.retirement.fence,
    );
    return this.commit(
      expected,
      operation,
      "seal",
      { status: "maintenance", fence: expected.fence, retirement: expected.retirement },
      sealed,
    );
  }

  /** Privileged maintenance boundary: approvedBy comes from authenticated control
   * plane identity, never from an ordinary book request. Durable approval pins the
   * exact sealed cutoff before the unavailable book is reconstructed in place. */
  async approveRestore(
    input: NativeCatalogSnapshot,
    operationId: string,
    approvedBy: string,
  ): Promise<NativeCatalogSnapshot> {
    const actor = id(approvedBy);
    const { expected, operation, current, repeated } = await this.prepare(
      input,
      operationId,
      "restore",
    );
    if (repeated) {
      requireLedger(current.restore?.approvedBy === actor, "native_catalog_operation_conflict");
      return current;
    }
    requireLedger(
      expected.status === "maintenance" && expected.sealed !== null && expected.restore === null,
      "native_catalog_not_awaiting_restore",
    );
    requireLedger(this.archive !== undefined, "native_catalog_archive_unconfigured");
    requireLedger(
      JSON.stringify(await this.archive.readControl()) === JSON.stringify(expected.sealed.control),
      "native_archive_seal_changed",
    );
    requireLedger(
      this.book.inspectRetiredProjection !== undefined,
      "native_catalog_projection_unconfigured",
    );
    const observed = await this.book.inspectRetiredProjection(expected.identity, expected.fence);
    requireLedger(
      JSON.stringify(completeScope(observed.scope, this.scope.objectId)) ===
        JSON.stringify(this.scope) &&
        JSON.stringify(head(observed.head)) === JSON.stringify(expected.sealed.head),
      "native_catalog_projection_mismatch",
    );
    requireLedger(observed.complete === true, "native_catalog_projection_pending");
    const projection = { count: counter(observed.count), digest: digest(observed.digest) };
    requireLedger(projection.count !== "0", "native_catalog_projection_mismatch");
    requireLedger(
      JSON.stringify(await this.archive.readControl()) === JSON.stringify(expected.sealed.control),
      "native_archive_seal_changed",
    );
    return this.commit(
      expected,
      operation,
      "restore",
      {
        status: "maintenance",
        fence: expected.fence,
        retirement: expected.retirement,
      },
      expected.sealed,
      {
        requestId: operation,
        approvedBy: actor,
        projection,
        authorizationRevision: counter(observed.authorizationRevision),
      },
    );
  }
  /** Operator-reconciled disaster recovery. The configured authority supplies
   * evidence; callers cannot select an R2 prefix as the acknowledged head. This
   * only approves the existing bounded verifier, never activates a writer. */
  async recoverUnavailableSource(
    input: NativeCatalogSnapshot,
    operationId: string,
    authorize: (quarantinedCatalogHash: string | null) => Promise<NativeRecoveryEvidence>,
  ): Promise<NativeCatalogSnapshot> {
    const expected = this.normalize(input),
      operation = id(operationId);
    requireLedger(expected.status === "active", "native_catalog_not_active");
    requireLedger(
      this.archive !== undefined && this.book.quarantineWriter !== undefined,
      "native_catalog_recovery_unconfigured",
    );
    const observe = async (
      quarantinedCatalogHash: string | null,
    ): Promise<NativeRecoveryEvidence> => {
      const row = fields(
        await authorize(quarantinedCatalogHash),
        "approvedBy,authorizationRevision,evidenceId,expectedCatalogHash,genesisHash,head,projection,requestId,scope",
      );
      const projection = fields(row.projection, "count,digest");
      const evidence: NativeRecoveryEvidence = {
        scope: completeScope(row.scope as CompleteBookScope, this.scope.objectId),
        requestId: id(row.requestId),
        expectedCatalogHash: digest(row.expectedCatalogHash),
        evidenceId: id(row.evidenceId),
        approvedBy: id(row.approvedBy),
        genesisHash: digest(row.genesisHash),
        head: head(row.head),
        projection: { count: counter(projection.count), digest: digest(projection.digest) },
        authorizationRevision: counter(row.authorizationRevision),
      };
      requireLedger(
        JSON.stringify(evidence.scope) === JSON.stringify(this.scope) &&
          evidence.requestId === operation &&
          evidence.expectedCatalogHash === expected.contentHash &&
          evidence.genesisHash === expected.genesisHash &&
          evidence.head.sequence !== "0" &&
          evidence.projection.count !== "0",
        "native_catalog_recovery_evidence_mismatch",
      );
      return evidence;
    };
    const evidence = await observe(null);
    const approval = {
      requestId: operation,
      approvedBy: evidence.approvedBy,
      projection: evidence.projection,
      authorizationRevision: evidence.authorizationRevision,
      recovery: { evidenceId: evidence.evidenceId, expectedCatalogHash: expected.contentHash },
    };
    const current = await this.read();
    if (
      current.status === "maintenance" &&
      current.mutation.kind === "restore" &&
      current.restore?.recovery?.expectedCatalogHash === expected.contentHash &&
      current.restore.requestId === operation
    ) {
      requireLedger(
        JSON.stringify(current.restore) === JSON.stringify(approval) &&
          JSON.stringify(current.sealed?.head) === JSON.stringify(evidence.head),
        "native_catalog_operation_conflict",
      );
      return current;
    }
    // Quiesce is durable before contacting the book. Cold owners stay unavailable
    // even if a later RPC, R2 write or approval reply is lost.
    const pending = await this.beginMaintenance(expected, operation);
    const stopped = await this.book.quarantineWriter(this.scope, pending.contentHash);
    requireLedger(
      JSON.stringify(completeScope(stopped.scope, this.scope.objectId)) ===
        JSON.stringify(this.scope) && stopped.catalogHash === pending.contentHash,
      "native_catalog_recovery_quarantine_mismatch",
    );
    const body = {
      requestId: operation,
      actorId: evidence.approvedBy,
      previousFence: pending.fence,
      fence: (BigInt(pending.fence) + 1n).toString(),
      head: { ...evidence.head },
    };
    // This is a control-plane retirement following actual quarantine, not a
    // claimed observation of the unavailable source. Persist recovery provenance.
    const retired = retirement(
      {
        ...body,
        contentHash: hashCanonical({
          scope: JSON.stringify(this.scope),
          retirement: body,
        }).digest,
      },
      this.scope,
    );
    const sealed = await sealNativeArchive(
      this.archive,
      this.scope,
      expected.genesisHash,
      evidence.head,
      retired.previousFence,
      retired.fence,
    );
    requireLedger(
      JSON.stringify(await this.archive.readControl()) === JSON.stringify(sealed.control),
      "native_archive_seal_changed",
    );
    requireLedger(
      JSON.stringify(await observe(pending.contentHash)) === JSON.stringify(evidence),
      "native_catalog_recovery_evidence_changed",
    );
    return this.commit(
      pending,
      operation,
      "restore",
      {
        status: "maintenance",
        fence: retired.fence,
        retirement: retired,
      },
      sealed,
      approval,
    );
  }

  /** Prepare locally while unavailable, resume only this sealed archive fence,
   * then publish catalog authority. The book still needs to observe this durable
   * catalog result before it changes its local prepared access state to active. */
  async finishRestore(
    input: NativeCatalogSnapshot,
    operationId: string,
  ): Promise<NativeCatalogSnapshot> {
    const { expected, operation, current, repeated } = await this.prepare(
      input,
      operationId,
      "resume",
    );
    if (repeated) return current;
    requireLedger(
      expected.status === "maintenance" &&
        expected.mutation.kind === "restore" &&
        expected.restore !== null &&
        expected.sealed !== null,
      "native_catalog_not_awaiting_resume",
    );
    requireLedger(
      this.book.prepareRestoredWriter !== undefined && this.archive !== undefined,
      "native_catalog_restore_unconfigured",
    );
    const proof = await this.book.prepareRestoredWriter(expected.identity, expected.contentHash);
    requireLedger(
      JSON.stringify(completeScope(proof.scope, this.scope.objectId)) ===
        JSON.stringify(this.scope) &&
        proof.approvalHash === expected.contentHash &&
        proof.writerFence === expected.fence &&
        proof.authorizationRevision === expected.restore.authorizationRevision &&
        JSON.stringify(head(proof.head)) === JSON.stringify(expected.sealed.head) &&
        proof.projection.count === expected.restore.projection.count &&
        proof.projection.digest === expected.restore.projection.digest,
      "native_catalog_restore_mismatch",
    );
    requireLedger(
      (await this.read()).contentHash === expected.contentHash,
      "native_catalog_head_conflict",
    );
    await resumeNativeArchive(this.archive, expected.sealed);
    return this.commit(expected, operation, "resume", {
      status: "active",
      fence: expected.fence,
      retirement: expected.retirement,
    });
  }
}

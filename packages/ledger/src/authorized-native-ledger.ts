import { createHash } from "node:crypto";
import {
  identifier,
  hashCanonical,
  type BookCommand,
  type DurableBookAggregate,
} from "@rastrata/kernel";
import type { BookAuthorizer, BookAuthorization, BookPermission } from "./book-authorization.ts";
import type {
  BookApplicationService,
  AuthorizationRevisionReceipt,
} from "./book-application-service.ts";
export type { AuthorizationRevisionReceipt } from "./book-application-service.ts";
import { completeScope } from "./compact-records.ts";
import { NativeLedger } from "./native-ledger.ts";
import {
  SqliteLedgerRepository,
  type NativeLedgerHead,
  type OutcomeDecoding,
} from "./sqlite-ledger-repository.ts";
import {
  atomicSqlite,
  requireSqliteTransaction,
  type SqliteTransaction,
} from "./sqlite-transaction.ts";
import { LedgerError, requireLedger, snapshotCommand, type CompleteBookScope } from "./records.ts";
import type { SqliteStorage } from "./sqlite.ts";
import { NativeArchiveAlarm, type NativeAlarmStorage } from "./native-archive-alarm.ts";
import { NativeOutcomeOutbox } from "./native-outcome-outbox.ts";
import type { R2ArchiveObjectStore } from "./r2-archive-store.ts";
import { auditNativeProjection } from "./native-projection-audit.ts";

export interface NativeLedgerBackup {
  readonly store: R2ArchiveObjectStore;
  readonly alarms: NativeAlarmStorage;
  readonly delayMs?: number;
}

const natural = /^(0|[1-9][0-9]{0,63})$/;
const restoreRecordDigest = (value: string) => createHash("sha256").update(value).digest("hex");
export interface NativeWriterRetirement {
  readonly requestId: string;
  readonly actorId: string;
  readonly previousFence: string;
  readonly fence: string;
  readonly head: NativeLedgerHead;
  readonly contentHash: string;
}

/** Independent access-control sequence: revocation changes no accounting Oseq,
 * but its counter and audit event commit atomically under the same owner queue.
 * This is not a user/role store. The configured issuer supplies those decisions. */
class SqliteBookAccess {
  private readonly scopeText: string;
  constructor(
    private readonly storage: SqliteStorage,
    scope: CompleteBookScope,
  ) {
    this.scopeText = JSON.stringify(scope);
  }
  async initialize(fence: string, allowNew: boolean): Promise<void> {
    requireLedger(typeof fence === "string" && natural.test(fence), "native_ledger_writer_fenced");
    atomicSqlite(this.storage, () => {
      const tables = Array.from(
        this.storage.sql.exec(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ledger_native_book','ledger_native_access','ledger_native_access_events','ledger_native_restore')",
        ),
      );
      if (tables.some((row) => row.name === "ledger_native_restore")) {
        const proof = Array.from(
          this.storage.sql.exec(
            "SELECT CASE WHEN length(CAST(body AS BLOB))<=16384 THEN body END AS body,digest FROM ledger_native_restore WHERE singleton=1",
          ),
        )[0];
        requireLedger(
          proof &&
            typeof proof.body === "string" &&
            new TextEncoder().encode(proof.body).length <= 16384 &&
            restoreRecordDigest(proof.body) === proof.digest &&
            JSON.parse(proof.body).phase === "active",
          "native_ledger_restore_required",
        );
      }
      const accessExists = tables.some((row) => row.name === "ledger_native_access");
      requireLedger(
        accessExists || !tables.some((row) => row.name === "ledger_native_book"),
        "ledger_authorization_migration_required",
      );
      if (accessExists) {
        const columns = Array.from(
          this.storage.sql.exec(
            "SELECT name FROM pragma_table_info('ledger_native_access') ORDER BY cid",
          ),
        ).map((row) => row.name);
        requireLedger(
          columns.join(",") === "singleton,scope,revision,writer_fence,writer_status,retirement",
          "ledger_authorization_migration_required",
        );
        requireLedger(
          tables.some((row) => row.name === "ledger_native_access_events"),
          "ledger_authorization_state_corrupt",
        );
        this.revision();
        return;
      }
      requireLedger(allowNew, "native_ledger_restore_required");
      requireLedger(tables.length === 0, "ledger_authorization_state_corrupt");
      this.create(fence, "0", "active");
    });
    await this.storage.sync();
  }
  private create(fence: string, revision: string, status: "active" | "prepared") {
    this.storage.sql.exec(
      "CREATE TABLE ledger_native_access (singleton INTEGER PRIMARY KEY CHECK(singleton=1), scope TEXT NOT NULL, revision TEXT NOT NULL, writer_fence TEXT NOT NULL, writer_status TEXT NOT NULL CHECK(writer_status IN ('active','retired','prepared')), retirement TEXT)",
    );
    this.storage.sql.exec(
      "CREATE TABLE ledger_native_access_events (request_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, expected_revision TEXT NOT NULL, revision TEXT NOT NULL, digest TEXT NOT NULL) WITHOUT ROWID",
    );
    this.storage.sql.exec(
      "INSERT INTO ledger_native_access VALUES (1, ?, ?, ?, ?, NULL)",
      this.scopeText,
      revision,
      fence,
      status,
    );
  }
  prepareRestored(fence: string, revision: string) {
    requireLedger(
      natural.test(fence) && fence !== "0" && natural.test(revision),
      "native_ledger_writer_state_corrupt",
    );
    requireLedger(
      Array.from(
        this.storage.sql.exec(
          "SELECT name FROM sqlite_master WHERE name IN ('ledger_native_access','ledger_native_access_events')",
        ),
      ).length === 0,
      "native_restore_access_conflict",
    );
    this.create(fence, revision, "prepared");
  }
  assertSnapshot(revision: string, stopped: NativeWriterRetirement) {
    const state = this.state();
    requireLedger(
      state.revision === revision &&
        ((state.status === "active" && state.fence === stopped.previousFence) ||
          (state.status === "retired" && state.retirement?.contentHash === stopped.contentHash)),
      "native_restore_access_conflict",
    );
    requireLedger(
      Array.from(
        this.storage.sql.exec(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='ledger_native_access_events'",
        ),
      ).length === 1,
      "native_restore_access_conflict",
    );
  }
  prepareSnapshot(fence: string, revision: string, stopped: NativeWriterRetirement) {
    requireLedger(
      fence === stopped.fence && BigInt(fence) === BigInt(stopped.previousFence) + 1n,
      "native_restore_access_conflict",
    );
    this.assertSnapshot(revision, stopped);
    // Keep revocation history. Only the independently approved writer incarnation changes.
    this.storage.sql.exec(
      "UPDATE ledger_native_access SET writer_fence=?,writer_status='prepared',retirement=NULL WHERE singleton=1",
      fence,
    );
  }
  activateRestored(fence: string, revision: string) {
    const state = this.state();
    requireLedger(
      state.status === "prepared" && state.fence === fence && state.revision === revision,
      "native_restore_access_conflict",
    );
    this.storage.sql.exec(
      "UPDATE ledger_native_access SET writer_status='active' WHERE singleton=1",
    );
  }
  assertRestored(fence: string, revision: string, status: "prepared" | "active") {
    const state = this.state();
    requireLedger(
      state.status === status && state.fence === fence && state.revision === revision,
      "native_restore_access_conflict",
    );
  }
  private retirement(encoded: string): NativeWriterRetirement {
    const value = JSON.parse(encoded);
    requireLedger(
      value &&
        typeof value === "object" &&
        Object.keys(value).sort().join(",") ===
          "actorId,contentHash,fence,head,previousFence,requestId" &&
        typeof value.requestId === "string" &&
        value.requestId.length <= 1024 &&
        typeof value.actorId === "string" &&
        value.actorId.length <= 1024 &&
        typeof value.previousFence === "string" &&
        natural.test(value.previousFence) &&
        typeof value.fence === "string" &&
        natural.test(value.fence) &&
        BigInt(value.fence) === BigInt(value.previousFence) + 1n,
      "native_ledger_writer_state_corrupt",
    );
    identifier(value.requestId);
    identifier(value.actorId);
    const head = value.head;
    requireLedger(
      head &&
        typeof head === "object" &&
        Object.keys(head).sort().join(",") === "bookRevision,chainHash,sequence" &&
        typeof head.sequence === "string" &&
        /^(0|[1-9][0-9]{0,18})$/.test(head.sequence) &&
        typeof head.bookRevision === "string" &&
        /^(0|[1-9][0-9]{0,18})$/.test(head.bookRevision) &&
        BigInt(head.sequence) <= (1n << 63n) - 1n &&
        BigInt(head.bookRevision) <= BigInt(head.sequence) &&
        typeof head.chainHash === "string" &&
        /^[0-9a-f]{64}$/.test(head.chainHash),
      "native_ledger_writer_state_corrupt",
    );
    const body = {
      requestId: value.requestId as string,
      actorId: value.actorId as string,
      previousFence: value.previousFence as string,
      fence: value.fence as string,
      head: Object.freeze({
        sequence: head.sequence as string,
        bookRevision: head.bookRevision as string,
        chainHash: head.chainHash as string,
      }),
    };
    const contentHash = hashCanonical({ scope: this.scopeText, retirement: body }).digest;
    const result = Object.freeze({ ...body, contentHash });
    requireLedger(
      value.contentHash === contentHash && JSON.stringify(result) === encoded,
      "native_ledger_writer_state_corrupt",
    );
    return result;
  }
  private state() {
    const rows = Array.from(
      this.storage.sql.exec(
        "SELECT CASE WHEN length(scope)<=8192 THEN scope END AS scope, substr(revision,1,65) AS revision, substr(writer_fence,1,65) AS writer_fence, CASE WHEN length(writer_status)<=8 THEN writer_status END AS writer_status, retirement IS NULL AS no_retirement, CASE WHEN length(CAST(retirement AS BLOB))<=16384 THEN retirement END AS retirement FROM ledger_native_access WHERE singleton=1",
      ),
    );
    const row = rows[0];
    requireLedger(
      rows.length === 1 &&
        row?.scope === this.scopeText &&
        typeof row.revision === "string" &&
        natural.test(row.revision),
      "ledger_authorization_state_corrupt",
    );
    requireLedger(
      typeof row.writer_fence === "string" &&
        natural.test(row.writer_fence) &&
        (row.writer_status === "active" ||
          row.writer_status === "retired" ||
          row.writer_status === "prepared"),
      "native_ledger_writer_state_corrupt",
    );
    const retirement = typeof row.retirement === "string" ? this.retirement(row.retirement) : null;
    requireLedger(
      row.writer_status !== "retired"
        ? row.no_retirement === 1 && row.retirement === null
        : row.no_retirement === 0 && retirement !== null && retirement.fence === row.writer_fence,
      "native_ledger_writer_state_corrupt",
    );
    return {
      revision: row.revision,
      fence: row.writer_fence,
      status: row.writer_status,
      retirement,
    };
  }
  revision(): string {
    return this.state().revision;
  }
  recoverySourceRevision(fence: string): string {
    const current = this.state();
    requireLedger(
      current.status === "active" && current.fence === fence,
      "native_recovery_source_ineligible",
    );
    return current.revision;
  }
  retirementSnapshot(): NativeWriterRetirement | null {
    return this.state().retirement;
  }
  requireCurrent(context: BookAuthorization, writerFence?: string): void {
    const state = this.state();
    requireLedger(state.status !== "prepared", "native_ledger_writer_inactive");
    requireLedger(context.authorizationRevision === state.revision, "ledger_forbidden");
    // A retired writer may finish maintenance with its original capability;
    // after verified writer replacement, that old fence is never admitted again.
    requireLedger(
      context.writerFence === (state.retirement?.previousFence ?? state.fence),
      "ledger_forbidden",
    );
    if (writerFence !== undefined) {
      requireLedger(state.status === "active", "native_ledger_writer_retired");
      requireLedger(state.fence === writerFence, "native_ledger_writer_fenced");
    }
  }
  retire(
    context: BookAuthorization,
    requestId: string,
    expectedFence: string,
    head: NativeLedgerHead,
  ): NativeWriterRetirement {
    identifier(requestId);
    requireLedger(
      requestId.length <= 1024 &&
        context.actorId.length <= 1024 &&
        typeof expectedFence === "string" &&
        natural.test(expectedFence),
      "native_ledger_retirement_invalid",
    );
    const state = this.state();
    if (state.retirement) {
      requireLedger(
        state.retirement.requestId === requestId &&
          state.retirement.actorId === context.actorId &&
          state.retirement.previousFence === expectedFence,
        "native_ledger_retirement_conflict",
      );
      requireLedger(
        JSON.stringify(state.retirement.head) === JSON.stringify(head),
        "native_ledger_retirement_head_changed",
      );
      return state.retirement;
    }
    requireLedger(state.fence === expectedFence, "native_ledger_retirement_conflict");
    const fence = (BigInt(expectedFence) + 1n).toString();
    requireLedger(natural.test(fence), "native_ledger_writer_fence_exhausted");
    const body = {
      requestId,
      actorId: context.actorId,
      previousFence: expectedFence,
      fence,
      head: { ...head },
    };
    const retirement = this.retirement(
      JSON.stringify({
        ...body,
        contentHash: hashCanonical({ scope: this.scopeText, retirement: body }).digest,
      }),
    );
    const changed = Array.from(
      this.storage.sql.exec(
        "UPDATE ledger_native_access SET writer_fence=?, writer_status='retired', retirement=? WHERE singleton=1 AND scope=? AND writer_fence=? AND writer_status='active' RETURNING writer_fence",
        fence,
        JSON.stringify(retirement),
        this.scopeText,
        expectedFence,
      ),
    );
    requireLedger(
      changed.length === 1 && changed[0]?.writer_fence === fence,
      "native_ledger_retirement_conflict",
    );
    return retirement;
  }
  advance(
    context: BookAuthorization,
    requestId: string,
    expectedRevision: string,
  ): AuthorizationRevisionReceipt {
    identifier(requestId);
    requireLedger(
      typeof expectedRevision === "string" && natural.test(expectedRevision),
      "ledger_authorization_revision_invalid",
    );
    const revision = (BigInt(expectedRevision) + 1n).toString();
    requireLedger(natural.test(revision), "ledger_authorization_revision_exhausted");
    const receipt = Object.freeze({
      requestId,
      actorId: context.actorId,
      expectedRevision,
      authorizationRevision: revision,
    });
    const digest = hashCanonical({ scope: this.scopeText, authorization: receipt }).digest;
    const previous = Array.from(
      this.storage.sql.exec(
        "SELECT actor_id, expected_revision, revision, digest FROM ledger_native_access_events WHERE request_id=?",
        requestId,
      ),
    )[0];
    if (previous) {
      requireLedger(
        previous.actor_id === context.actorId &&
          previous.expected_revision === expectedRevision &&
          previous.revision === revision &&
          previous.digest === digest,
        "ledger_authorization_identity_conflict",
      );
      return receipt;
    }
    requireLedger(
      context.authorizationRevision === expectedRevision,
      "ledger_authorization_revision_conflict",
    );
    const changed = Array.from(
      this.storage.sql.exec(
        "UPDATE ledger_native_access SET revision=? WHERE singleton=1 AND scope=? AND revision=? RETURNING revision",
        revision,
        this.scopeText,
        expectedRevision,
      ),
    );
    requireLedger(
      changed.length === 1 && changed[0]?.revision === revision,
      "ledger_authorization_revision_conflict",
    );
    this.storage.sql.exec(
      "INSERT INTO ledger_native_access_events VALUES (?,?,?,?,?)",
      requestId,
      context.actorId,
      expectedRevision,
      revision,
      digest,
    );
    return receipt;
  }
}

/** Production request boundary around the internal accounting/persistence APIs.
 * It owns exactly one repository queue per book. Raw NativeLedger/repository
 * objects are deliberately not exposed to callers of this boundary. */
export class AuthorizedNativeLedger implements BookApplicationService {
  readonly scope: CompleteBookScope;
  private readonly repository: SqliteLedgerRepository;
  private readonly ledger: NativeLedger;
  private readonly access: SqliteBookAccess;
  private readonly archiveAlarm?: NativeArchiveAlarm;
  private readonly archive?: NativeOutcomeOutbox;

  constructor(
    private readonly storage: SqliteStorage,
    scope: CompleteBookScope,
    actualObjectId: string,
    private readonly authority: () => { readonly fence: string; readonly pending: boolean },
    private readonly authorizer: BookAuthorizer,
    backup?: NativeLedgerBackup,
  ) {
    this.scope = completeScope(scope, actualObjectId);
    this.repository = new SqliteLedgerRepository(storage, this.scope, actualObjectId, authority);
    if (backup) {
      this.archive = new NativeOutcomeOutbox(this.repository, backup.store, authority);
      this.archiveAlarm = new NativeArchiveAlarm(
        backup.alarms,
        { drain: () => this.drainArchive() },
        backup.delayMs,
      );
    }
    const archiveAlarm = this.archiveAlarm;
    this.ledger = new NativeLedger(
      this.repository,
      archiveAlarm ? () => archiveAlarm.arm() : undefined,
    );
    this.access = new SqliteBookAccess(storage, this.scope);
  }
  /** Platform alarm entry point, not a caller-accessible HTTP route. Archive
   * initialization remains an explicit catalog-reservation operation. */
  async handleArchiveAlarm(): Promise<void> {
    requireLedger(this.archiveAlarm !== undefined, "native_archive_not_configured");
    await this.archiveAlarm.run();
  }
  private async drainArchive() {
    const archive = this.archive;
    requireLedger(archive !== undefined, "native_archive_not_configured");
    try {
      return await archive.drain();
    } catch (error) {
      if (!(error instanceof LedgerError) || error.code !== "native_archive_writer_fenced")
        throw error;
      const stopped = await this.repository.transact((view) => ({
        write: false,
        value: { retirement: this.access.retirementSnapshot(), head: view.head },
      }));
      const retired = stopped.value.retirement;
      if (
        retired === null ||
        JSON.stringify(retired.head) !== JSON.stringify(stopped.value.head) ||
        !(await archive.isSealedAt(retired.head, retired.fence))
      )
        throw error;
      // The final archive is sealed at this permanently retired owner's actual
      // head. Do not keep billing for alarms that can never publish another row.
      return { disposition: "idle" as const, through: retired.head, observedTip: retired.head };
    }
  }
  /** Trusted catalog activation evidence, not a public readiness endpoint.
   * Only a newly activated book is eligible. Archive reservation must already
   * exist; this never initializes a missing archive pointer or an empty book. */
  async inspectProvisioned(authorization: string | null) {
    const { context, admit } = await this.authorize(authorization, "provision");
    requireLedger(this.archive !== undefined, "native_archive_not_configured");
    const page = await this.repository.outcomePage(null, 1, admit);
    const first = page.outcomes[0];
    requireLedger(
      page.observedTip.sequence === "1" &&
        first?.payload.command.type === "activateBook" &&
        first.payload.originalResult.disposition === "committed",
      "native_ledger_provisioning_mismatch",
    );
    const archived = await this.archive.drain(1);
    requireLedger(
      archived.disposition !== "conflict" &&
        JSON.stringify(archived.through) === JSON.stringify(page.observedTip),
      "native_ledger_provisioning_archive_incomplete",
    );
    const final = await this.repository.outcomePage(page.observedTip, 1, admit);
    requireLedger(
      JSON.stringify(final.observedTip) === JSON.stringify(page.observedTip),
      "native_ledger_provisioning_changed",
    );
    return Object.freeze({
      scope: this.scope,
      genesis: page.genesis,
      head: page.observedTip,
      writerFence: context.writerFence,
    });
  }
  private async authorize(
    authorization: string | null | BookAuthorization,
    permission: BookPermission,
    actorId?: string,
  ) {
    const context =
      typeof authorization === "string" || authorization === null
        ? await this.authorizer.verify(authorization)
        : authorization;
    this.authorizer.assert(context, this.scope, permission, actorId);
    return {
      context,
      admit: () => {
        this.authorizer.assert(context, this.scope, permission, actorId);
        this.access.requireCurrent(
          context,
          permission === "maintain" ? undefined : this.authority().fence,
        );
      },
    };
  }
  /** Cheap pre-body capability check for transports. Persisted revocation is
   * still checked by the actual operation, on dequeue before financial data. */
  async checkRequestAuthorization(
    authorization: string | null | BookAuthorization,
    permission: BookPermission,
  ): Promise<BookAuthorization> {
    return (await this.authorize(authorization, permission)).context;
  }
  /** Private control-plane admission, including persisted revocation. Unlike the
   * transport's pre-body check this runs on the same queue as financial writes. */
  async checkCurrentAuthorization(authorization: string | null, permission: BookPermission) {
    const { admit } = await this.authorize(authorization, permission);
    await this.repository.transact(() => ({ write: false, value: null }), admit);
  }
  /** Operational observation only; no new I/O on the save path. Check durable
   * revocation before touching the archive and again after remote work. */
  async archiveStatus(authorization: string | null) {
    const { admit } = await this.authorize(authorization, "maintain");
    await this.repository.transact(() => ({ write: false, value: null }), admit);
    requireLedger(this.archive !== undefined, "native_archive_not_configured");
    const progress = await this.archive.inspectProgress(admit);
    await this.repository.transact(() => ({ write: false, value: null }), admit);
    return progress;
  }
  async provision(
    authorization: string | null | BookAuthorization,
    initial: DurableBookAggregate,
    input: BookCommand,
  ) {
    const command = snapshotCommand(input);
    const { context, admit } = await this.authorize(authorization, "provision", command.actorId);
    // A fresh access record is revision zero; a retry of an existing book still
    // needs its current authorization revision. Never initialize an old raw book.
    requireLedger(
      command.bookId === this.scope.bookId && initial.state.identity.bookId === this.scope.bookId,
      "ledger_forbidden",
    );
    const writerFence = this.authority().fence;
    requireLedger(context.writerFence === writerFence, "ledger_forbidden");
    if (context.authorizationRevision !== "0") this.access.requireCurrent(context, writerFence);
    // A replacement requires verified recovery, not blank public initialization.
    // Existing verified generations may still replay their original activation.
    await this.access.initialize(writerFence, this.scope.generation === "0" && writerFence === "0");
    return this.ledger.provision(initial, command, admit);
  }
  async execute(authorization: string | null | BookAuthorization, input: BookCommand) {
    const command = snapshotCommand(input);
    const { admit } = await this.authorize(authorization, "execute", command.actorId);
    requireLedger(command.bookId === this.scope.bookId, "ledger_forbidden");
    return this.ledger.execute(command, admit);
  }
  async outcomes(
    authorization: string | null | BookAuthorization,
    after: NativeLedgerHead | null = null,
    limit = 16,
    decoding?: OutcomeDecoding,
  ) {
    const { admit } = await this.authorize(authorization, "read");
    return this.repository.outcomePage(after, limit, admit, decoding);
  }
  async advanceAuthorization(
    authorization: string | null | BookAuthorization,
    requestId: string,
    expectedRevision: string,
  ) {
    const { context, admit } = await this.authorize(authorization, "maintain");
    const result = await this.repository.transact(
      () => ({ write: false, value: this.access.advance(context, requestId, expectedRevision) }),
      admit,
    );
    return result.value;
  }
  /** Permanent retirement of this writer incarnation, serialized with saves.
   * For a trusted cutover coordinator, not a public HTTP route or restore permit.
   * A replacement must get independent catalog approval and verified recovery. */
  async retireWriter(
    authorization: string | null,
    requestId: string,
    expectedFence: string,
  ): Promise<NativeWriterRetirement> {
    const { context, admit } = await this.authorize(authorization, "maintain");
    const result = await this.repository.transact(
      (view) => ({
        write: false,
        value: this.access.retire(context, requestId, expectedFence, view.head),
      }),
      admit,
    );
    return result.value;
  }
  /** Trusted catalog maintenance RPC. No caller-supplied digest or scan cursor.
   * Call again while complete=false; each call reads at most 32 facts/one MiB. */
  async inspectRetiredProjection(authorization: string | null, expectedFence: string) {
    const { admit } = await this.authorize(authorization, "maintain");
    const stopped = await this.repository.transact((view) => {
      const retirement = this.access.retirementSnapshot();
      requireLedger(
        retirement !== null &&
          retirement.fence === expectedFence &&
          JSON.stringify(retirement.head) === JSON.stringify(view.head),
        "native_ledger_retirement_head_changed",
      );
      return { write: false, value: retirement };
    }, admit);
    const retirement = stopped.value;
    const progress = await auditNativeProjection(
      this.storage,
      this.repository,
      retirement.head,
      retirement.contentHash,
      () => {
        admit();
        requireLedger(
          this.access.retirementSnapshot()?.contentHash === retirement.contentHash,
          "native_ledger_retirement_head_changed",
        );
      },
    );
    const revision = await this.repository.transact(
      () => ({ write: false, value: this.access.revision() }),
      admit,
    );
    return Object.freeze({
      scope: this.scope,
      head: retirement.head,
      authorizationRevision: revision.value,
      ...progress,
    });
  }
  /** Independently authorized, quarantined surviving SOURCE inspection. It is
   * not restore approval and never initializes absent access or financial data.
   * Prepared/replayed targets cannot masquerade as the original active source. */
  async inspectRecoverySource(expectedFence: string, auditId: string, admit: () => void) {
    const guard = () => {
      admit();
      this.access.recoverySourceRevision(expectedFence);
    };
    const page = await this.repository.outcomePage(null, 1, guard);
    const revision = this.access.recoverySourceRevision(expectedFence);
    const progress = await auditNativeProjection(
      this.storage,
      this.repository,
      page.observedTip,
      auditId,
      () => {
        guard();
        requireLedger(
          this.access.recoverySourceRevision(expectedFence) === revision,
          "native_recovery_source_changed",
        );
      },
    );
    guard();
    return {
      ...progress,
      head: page.observedTip,
      authorizationRevision: revision,
      genesisHash: createHash("sha256").update(page.genesis).digest("hex"),
    };
  }
}

/** Internal restore transaction ports, not request-level authority. The installer
 * verifies the actual independent catalog and complete projection first. */
export function prepareNativeRestoredAccess(
  storage: SqliteStorage,
  scope: CompleteBookScope,
  fence: string,
  revision: string,
  transaction: SqliteTransaction,
  snapshotRetirement?: NativeWriterRetirement,
) {
  requireSqliteTransaction(transaction, storage);
  const access = new SqliteBookAccess(storage, scope);
  if (snapshotRetirement) access.prepareSnapshot(fence, revision, snapshotRetirement);
  else access.prepareRestored(fence, revision);
}
export function assertNativeSnapshotAccess(
  storage: SqliteStorage,
  scope: CompleteBookScope,
  revision: string,
  stopped: NativeWriterRetirement,
  transaction: SqliteTransaction,
) {
  requireSqliteTransaction(transaction, storage);
  new SqliteBookAccess(storage, scope).assertSnapshot(revision, stopped);
}
export function activateNativeRestoredAccess(
  storage: SqliteStorage,
  scope: CompleteBookScope,
  fence: string,
  revision: string,
  transaction: SqliteTransaction,
) {
  requireSqliteTransaction(transaction, storage);
  new SqliteBookAccess(storage, scope).activateRestored(fence, revision);
}
export function assertNativeRestoredAccess(
  storage: SqliteStorage,
  scope: CompleteBookScope,
  fence: string,
  revision: string,
  status: "prepared" | "active",
  transaction: SqliteTransaction,
) {
  requireSqliteTransaction(transaction, storage);
  new SqliteBookAccess(storage, scope).assertRestored(fence, revision, status);
}

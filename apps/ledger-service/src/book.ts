import { createHash } from "node:crypto";
import { DurableObject } from "cloudflare:workers";
import { decodeBookCommand, decodeDurableBook } from "@rastrata/kernel";
import { provisioningStage } from "./provisioning.ts";
import {
  AuthorizedNativeLedger,
  NativeLedgerHttp,
  NativeLedgerRestore,
  NativeOutcomeOutbox,
  R2ArchiveObjectStore,
  SerialLedgerQueue,
  SqliteLedgerRepository,
  type BookPermission,
  type CompleteBookScope,
  type NativeCatalogSnapshot,
  type NativeRecoveryEvidence,
  type SqliteStorage,
} from "@rastrata/ledger";
import {
  authorizer,
  recoveryAuthorizer,
  catalogStub,
  checkScope,
  failure,
  requireService,
  type Environment,
} from "./environment.ts";

interface Owner {
  scope: CompleteBookScope;
  ledger: AuthorizedNativeLedger;
  http: NativeLedgerHttp;
  archive: NativeOutcomeOutbox;
  restore: NativeLedgerRestore;
  authority: { fence: string; pending: boolean };
  serving: boolean;
}

/** Only the configured service binding can invoke control RPCs. All RPCs that
 * change authority additionally require an issuer-signed scoped capability. */
export class LedgerBook extends DurableObject<Environment> {
  private scope: CompleteBookScope | undefined;
  private owner: Promise<Owner> | undefined;
  private readonly control = new SerialLedgerQueue();
  private readonly ready: Promise<void>;

  /** Storage adapter seam also permits acceptance-only I/O profiling. */
  protected ledgerStorage(): SqliteStorage {
    return this.ctx.storage;
  }

  constructor(ctx: DurableObjectState, env: Environment) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.scope = await ctx.storage.get<CompleteBookScope>("service-scope");
      if (this.scope) this.validateScope(this.scope);
    });
  }
  private validateScope(scope: CompleteBookScope) {
    checkScope(this.env, scope);
    requireService(scope.objectId === this.ctx.id.toString(), "ledger_forbidden");
    requireService(
      !this.scope || JSON.stringify(this.scope) === JSON.stringify(scope),
      "ledger_forbidden",
    );
  }
  private async open(scope: CompleteBookScope): Promise<Owner> {
    await this.ready;
    this.validateScope(scope);
    if (!this.owner) {
      this.owner = this.initialize(scope).catch((error: unknown) => {
        this.owner = undefined;
        throw error;
      });
    }
    const owner = await this.owner;
    requireService(JSON.stringify(owner.scope) === JSON.stringify(scope), "ledger_forbidden");
    return owner;
  }
  private async initialize(scope: CompleteBookScope): Promise<Owner> {
    // Independent authority is read once per cold owner, never from client
    // headers or inferred from a rolled-back local SQLite access record.
    const catalog = await catalogStub(this.env, scope).read(scope);
    const authority = {
      fence:
        catalog.status === "maintenance" && catalog.retirement
          ? catalog.retirement.previousFence
          : catalog.fence,
      pending: false,
    };
    const store = new R2ArchiveObjectStore(this.env.ARCHIVE, scope, scope.objectId);
    const storage = this.ledgerStorage();
    const ledger = new AuthorizedNativeLedger(
      storage,
      scope,
      scope.objectId,
      () => authority,
      authorizer(this.env),
      { store, alarms: this.ctx.storage },
    );
    const repository = new SqliteLedgerRepository(storage, scope, scope.objectId, () => authority);
    return {
      scope,
      ledger,
      http: new NativeLedgerHttp(ledger),
      authority,
      serving: catalog.status === "active",
      archive: new NativeOutcomeOutbox(repository, store, () => authority),
      restore: new NativeLedgerRestore(storage, scope, store, () =>
        catalogStub(this.env, scope).read(scope),
      ),
    };
  }
  private async verify(token: string | null, permission: BookPermission) {
    const verifier = authorizer(this.env),
      context = await verifier.verify(token);
    this.validateScope(context.scope);
    verifier.assert(context, context.scope, permission);
    return context;
  }
  async checkAuthorization(token: string, permission: BookPermission) {
    const context = await this.verify(token, permission);
    return (await this.open(context.scope)).ledger.checkCurrentAuthorization(token, permission);
  }
  async archiveStatus(token: string) {
    const context = await this.verify(token, "maintain");
    return (await this.open(context.scope)).ledger.archiveStatus(token);
  }
  async provision(token: string, genesis: string, command: string) {
    return this.control.run(async () => {
      const context = await this.verify(token, "provision");
      requireService(
        typeof genesis === "string" &&
          typeof command === "string" &&
          new TextEncoder().encode(genesis).length <= 1048576 &&
          new TextEncoder().encode(command).length <= 1048576,
        "ledger_request_invalid",
      );
      const catalog = await provisioningStage("book_catalog", () =>
        catalogStub(this.env, context.scope).read(context.scope),
      );
      requireService(catalog.status !== "maintenance", "ledger_service_unavailable");
      requireService(
        createHash("sha256").update(genesis).digest("hex") === catalog.genesisHash,
        "ledger_request_invalid",
      );
      const owner = await provisioningStage("book_open", () => this.open(context.scope));
      if (catalog.status === "active") {
        // A formerly active book with lost local storage must recover. In
        // particular, fence zero must not make it eligible for blank provision.
        await owner.ledger.checkCurrentAuthorization(token, "provision");
      }
      // This small binding is only an alarm locator. It grants no book authority.
      await provisioningStage("book_binding", () =>
        this.ctx.storage.put("service-scope", context.scope),
      );
      this.scope = context.scope;
      const initial = decodeDurableBook(genesis),
        input = decodeBookCommand(command);
      requireService(
        initial.disposition === "decoded" && input.disposition === "decoded",
        "ledger_request_invalid",
      );
      const result = await provisioningStage("book_activation", () =>
        owner.ledger.provision(token, initial.aggregate, input.command),
      );
      if (catalog.status === "reserved")
        await provisioningStage("book_archive", () => owner.archive.initialize());
      // Retained receipts come from the strict codec's null-prototype objects.
      // Workerd RPC cannot serialize those directly. Materialize transport data
      // without changing BigInts, hashes, diagnostics or the retained receipt.
      return structuredClone(result);
    });
  }
  async inspectProvisioned(token: string) {
    const context = await this.verify(token, "provision");
    return (await this.open(context.scope)).ledger.inspectProvisioned(token);
  }
  async refreshAuthority(scope: CompleteBookScope) {
    // No caller-supplied fence/readiness flag is accepted.
    const owner = await this.open(scope),
      current = await catalogStub(this.env, scope).read(scope);
    owner.serving = current.status === "active";
    owner.authority.fence =
      current.status === "maintenance" && current.retirement
        ? current.retirement.previousFence
        : current.fence;
  }
  async retireWriter(token: string, requestId: string, expectedFence: string) {
    return this.control.run(async () => {
      const context = await this.verify(token, "maintain"),
        owner = await this.open(context.scope);
      await owner.ledger.checkCurrentAuthorization(token, "maintain");
      owner.serving = false;
      return owner.ledger.retireWriter(token, requestId, expectedFence);
    });
  }
  /** Private catalog control only. Never trusts local access after primary loss.
   * No data is deleted or adopted. The independent maintenance record survives
   * local restart; pending also fences already queued repository admissions. */
  async quarantineForRecovery(
    scope: CompleteBookScope,
    catalogHash: string,
  ): Promise<{
    scope: CompleteBookScope;
    catalogHash: string;
  }> {
    return this.control.run(async () => {
      const current = await catalogStub(this.env, scope).read(scope);
      requireService(
        current.status === "maintenance" &&
          current.retirement === null &&
          current.contentHash === catalogHash,
        "ledger_forbidden",
      );
      const owner = await this.open(scope);
      owner.serving = false;
      owner.authority.pending = true;
      await this.ctx.storage.sync();
      return { scope: owner.scope, catalogHash: current.contentHash };
    });
  }
  async inspectRetiredProjection(token: string, expectedFence: string) {
    const context = await this.verify(token, "maintain");
    return (await this.open(context.scope)).ledger.inspectRetiredProjection(token, expectedFence);
  }
  async inspectRecoverySource(
    credential: string,
    expected: NativeCatalogSnapshot,
    requestId: string,
  ): Promise<{
    complete: boolean;
    evidence: NativeRecoveryEvidence | null;
  }> {
    return this.control.run(async () => {
      const scope = checkScope(this.env, expected.identity);
      this.validateScope(scope);
      const verifier = recoveryAuthorizer(this.env);
      const context = await verifier.incident(credential, scope, expected.contentHash, requestId);
      const current = await catalogStub(this.env, scope).read(scope);
      requireService(
        current.status === "maintenance" &&
          current.mutation.kind === "quiesce" &&
          current.mutation.id === requestId &&
          current.mutation.expectedHash === expected.contentHash &&
          current.retirement === null,
        "ledger_forbidden",
      );
      const ordinary = await this.open(scope);
      ordinary.serving = false;
      // Independent maintenance reader; the ordinary owner remains fenced.
      const reader = new AuthorizedNativeLedger(
        this.ledgerStorage(),
        scope,
        scope.objectId,
        () => ({ fence: current.fence, pending: false }),
        authorizer(this.env),
      );
      const observed = await reader.inspectRecoverySource(current.fence, current.contentHash, () =>
        requireService(Date.now() < context.expiresAt, "ledger_unauthorized"),
      );
      requireService(
        (await catalogStub(this.env, scope).read(scope)).contentHash === current.contentHash,
        "native_catalog_head_conflict",
      );
      await verifier.incident(credential, scope, expected.contentHash, requestId);
      requireService(
        observed.genesisHash === current.genesisHash,
        "native_catalog_genesis_mismatch",
      );
      return {
        complete: observed.complete,
        evidence: observed.complete
          ? {
              scope,
              requestId,
              expectedCatalogHash: expected.contentHash,
              evidenceId: `native-source-${observed.head.chainHash}-${observed.digest}`,
              approvedBy: context.actorId,
              genesisHash: observed.genesisHash,
              head: observed.head,
              projection: { count: observed.count, digest: observed.digest },
              authorizationRevision: observed.authorizationRevision,
            }
          : null,
      };
    });
  }
  private async approvedRecovery(
    token: string,
  ): Promise<{ owner: Owner; catalog: NativeCatalogSnapshot }> {
    const context = await this.verify(token, "maintain");
    const catalog = await catalogStub(this.env, context.scope).read(context.scope);
    requireService(
      catalog.restore !== null && context.writerFence === catalog.fence,
      "ledger_forbidden",
    );
    let owner = await this.open(context.scope);
    if (catalog.status === "active") {
      if (owner.authority.pending) {
        // The old ordinary owner remains permanently quarantined. Use fresh
        // caches to inspect the prepared replacement; do not depend on eviction
        // occurring between approval and local activation.
        this.owner = undefined;
        owner = await this.open(context.scope);
      }
      try {
        // Once activated, revocation may have advanced beyond the historical
        // approval. Old operator credentials must not regain maintenance access.
        await owner.ledger.checkCurrentAuthorization(token, "maintain");
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "native_ledger_writer_inactive"
        )
          throw error;
        requireService(
          context.authorizationRevision === catalog.restore.authorizationRevision,
          "ledger_forbidden",
        );
      }
    } else {
      requireService(
        context.authorizationRevision === catalog.restore.authorizationRevision,
        "ledger_forbidden",
      );
      owner.serving = false;
      // Recovery owns its separate verifier/repository. Discard the quarantined
      // ordinary owner after activation, never un-fence it here.
    }
    return { owner, catalog };
  }
  async restoreStep(token: string) {
    return this.control.run(async () => {
      const { owner, catalog } = await this.approvedRecovery(token);
      requireService(catalog.status === "maintenance", "ledger_service_unavailable");
      // Persist only the locator, never the credential. No destructive reset.
      await this.ctx.storage.put("service-scope", owner.scope);
      this.scope = owner.scope;
      return owner.restore.step();
    });
  }
  async checkRecoveryAuthorization(token: string) {
    await this.approvedRecovery(token);
  }
  async verifyRestoredSnapshot(token: string) {
    return this.control.run(async () => {
      const { owner, catalog } = await this.approvedRecovery(token);
      requireService(catalog.status === "maintenance", "ledger_service_unavailable");
      return owner.restore.step("snapshot");
    });
  }
  async prepareRestoredWriter(token: string, approvalHash: string) {
    return this.control.run(async () => {
      const { owner, catalog } = await this.approvedRecovery(token);
      requireService(
        catalog.status === "maintenance" && catalog.contentHash === approvalHash,
        "ledger_forbidden",
      );
      return owner.restore.prepareWriter(approvalHash);
    });
  }
  async activateRestoredWriter(token: string) {
    return this.control.run(async () => {
      const { owner, catalog } = await this.approvedRecovery(token);
      requireService(catalog.status === "active", "ledger_service_unavailable");
      const result = await owner.restore.activateWriter();
      // Reconstruct caches after installing a different incarnation of storage.
      this.owner = undefined;
      await this.open(owner.scope);
      return result;
    });
  }
  override async alarm() {
    await this.ready;
    requireService(this.scope !== undefined);
    const catalog = await catalogStub(this.env, this.scope).read(this.scope);
    if (catalog.status === "maintenance" && catalog.restore !== null) return;
    await (await this.open(this.scope)).ledger.handleArchiveAlarm();
  }
  override async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      const permission =
        path === "/commands"
          ? "execute"
          : path === "/outcomes"
            ? "read"
            : path === "/authorization"
              ? "maintain"
              : null;
      if (permission === null) return new Response(null, { status: 404 });
      const context = await this.verify(request.headers.get("authorization"), permission);
      const owner = await this.open(context.scope);
      requireService(owner.serving);
      return owner.http.fetch(request, context);
    } catch (error) {
      return failure(error);
    }
  }
}

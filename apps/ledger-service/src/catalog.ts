import { DurableObject } from "cloudflare:workers";
import {
  NativeLedgerCatalog,
  R2ArchiveObjectStore,
  SerialLedgerQueue,
  bookObjectName,
  type CompleteBookScope,
  type NativeCatalogSnapshot,
} from "@rastrata/ledger";
import {
  authorizer,
  recoveryAuthorizer,
  bookStub,
  checkScope,
  requireService,
  type Environment,
} from "./environment.ts";

export type CatalogOperation =
  | "activate"
  | "beginMaintenance"
  | "retireWriter"
  | "sealArchive"
  | "approveRestore"
  | "finishRestore";

/** Separate SQLite object holds independent writer authority. No public HTTP API. */
export class LedgerCatalog extends DurableObject<Environment> {
  private readonly queue = new SerialLedgerQueue();
  private core(scope: CompleteBookScope, token = ""): NativeLedgerCatalog {
    checkScope(this.env, scope);
    requireService(
      this.ctx.id.toString() ===
        this.env.CATALOGS.idFromName(bookObjectName(scope.tenantId, scope.bookId)).toString(),
      "ledger_forbidden",
    );
    const book = bookStub(this.env, scope);
    return new NativeLedgerCatalog(
      this.ctx.storage,
      this.ctx.id.toString(),
      scope,
      {
        // RPC result roots carry a platform Symbol.dispose hook. Materialize only
        // their structured data before the kernel's exact-field validation; never
        // pass a live RPC resource into accounting canonicalization.
        inspectProvisioned: async () => structuredClone(await book.inspectProvisioned(token)),
        retireWriter: async (_, id, fence) =>
          structuredClone(await book.retireWriter(token, id, fence)),
        inspectRetiredProjection: async (_, fence) =>
          structuredClone(await book.inspectRetiredProjection(token, fence)),
        prepareRestoredWriter: async (_, approvalHash) =>
          structuredClone(await book.prepareRestoredWriter(token, approvalHash)),
        quarantineWriter: async (_, catalogHash) =>
          structuredClone(await book.quarantineForRecovery(scope, catalogHash)),
      },
      new R2ArchiveObjectStore(this.env.ARCHIVE, scope, scope.objectId),
    );
  }
  read(scope: CompleteBookScope) {
    return this.core(scope).read();
  }
  beginRecovery(credential: string, expected: NativeCatalogSnapshot, requestId: string) {
    return this.queue.run(async () => {
      const scope = checkScope(this.env, expected.identity),
        verifier = recoveryAuthorizer(this.env);
      await verifier.incident(credential, scope, expected.contentHash, requestId);
      const core = this.core(scope);
      const pending = await core.beginMaintenance(expected, requestId);
      await bookStub(this.env, scope).quarantineForRecovery(scope, pending.contentHash);
      await verifier.incident(credential, scope, expected.contentHash, requestId);
      return pending;
    });
  }
  recoverUnavailableSource(credential: string, expected: NativeCatalogSnapshot, requestId: string) {
    return this.queue.run(async () => {
      const scope = checkScope(this.env, expected.identity);
      const authority = recoveryAuthorizer(this.env),
        core = this.core(scope);
      requireService(
        typeof credential === "string" &&
          credential.length <= 16384 &&
          typeof requestId === "string" &&
          requestId.length <= 1024,
        "ledger_request_invalid",
      );
      return core.recoverUnavailableSource(expected, requestId, async (quarantinedCatalogHash) =>
        authority.recovery(
          credential,
          expected,
          requestId,
          await core.read(),
          quarantinedCatalogHash,
        ),
      );
    });
  }
  reserve(token: string, genesis: string, requestId: string) {
    return this.queue.run(async () => {
      const verifier = authorizer(this.env),
        context = await verifier.verify(token);
      verifier.assert(context, checkScope(this.env, context.scope), "provision");
      requireService(
        context.writerFence === "0" && context.authorizationRevision === "0",
        "ledger_forbidden",
      );
      return this.core(context.scope, token).reserve(genesis, requestId);
    });
  }
  operate(
    token: string,
    operation: CatalogOperation,
    expected: NativeCatalogSnapshot,
    requestId: string,
  ) {
    return this.queue.run(async () => {
      const verifier = authorizer(this.env),
        context = await verifier.verify(token);
      const permission = operation === "activate" ? "provision" : "maintain";
      verifier.assert(context, checkScope(this.env, context.scope), permission);
      const core = this.core(context.scope, token);
      if (operation === "finishRestore") {
        await bookStub(this.env, context.scope).checkRecoveryAuthorization(token);
      } else {
        await bookStub(this.env, context.scope).checkAuthorization(token, permission);
      }
      verifier.assert(context, context.scope, permission);
      switch (operation) {
        case "activate":
          return core.activate(expected, requestId);
        case "beginMaintenance":
          return core.beginMaintenance(expected, requestId);
        case "retireWriter":
          return core.retireWriter(expected, requestId);
        case "sealArchive":
          return core.sealArchive(expected, requestId);
        case "approveRestore":
          return core.approveRestore(expected, requestId, context.actorId);
        case "finishRestore":
          return core.finishRestore(expected, requestId);
        default:
          throw new Error("Unsupported catalog operation");
      }
    });
  }
}

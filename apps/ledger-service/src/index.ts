import { WorkerEntrypoint } from "cloudflare:workers";
import type { NativeCatalogSnapshot } from "@rastrata/ledger";
import {
  authorizer,
  bookStub,
  catalogStub,
  checkScope,
  failure,
  resolveIdentity,
  type Environment,
} from "./environment.ts";
import type { CatalogOperation } from "./catalog.ts";
import { provisioningStage } from "./provisioning.ts";
export { LedgerBook } from "./book.ts";
export { LedgerCatalog } from "./catalog.ts";

/** The application owns identity/roles and capability signing. These control
 * methods are private service-binding RPCs, not remotely addressable URL routes. */
export default class LedgerService extends WorkerEntrypoint<Environment> {
  resolveIdentity(tenantId: string, bookId: string) {
    return resolveIdentity(this.env, tenantId, bookId);
  }
  async provision(token: string, genesis: string, command: string, requestId: string) {
    const verifier = authorizer(this.env),
      context = await verifier.verify(token);
    verifier.assert(context, checkScope(this.env, context.scope), "provision");
    const catalog = catalogStub(this.env, context.scope),
      book = bookStub(this.env, context.scope);
    const reserved = await provisioningStage("reserve", () =>
      catalog.reserve(token, genesis, requestId),
    );
    const receipt = await provisioningStage("initialize", () =>
      book.provision(token, genesis, command),
    );
    const active =
      reserved.status === "reserved"
        ? await provisioningStage("activate", () =>
            catalog.operate(token, "activate", reserved, requestId),
          )
        : reserved;
    await provisioningStage("refresh", () => book.refreshAuthority(context.scope));
    return { receipt, catalog: active };
  }
  async control(
    token: string,
    operation: CatalogOperation,
    expected: NativeCatalogSnapshot,
    requestId: string,
  ) {
    const verifier = authorizer(this.env),
      context = await verifier.verify(token);
    verifier.assert(
      context,
      checkScope(this.env, context.scope),
      operation === "activate" ? "provision" : "maintain",
    );
    const result = await catalogStub(this.env, context.scope).operate(
      token,
      operation,
      expected,
      requestId,
    );
    if (operation !== "finishRestore")
      await bookStub(this.env, context.scope).refreshAuthority(context.scope);
    return result;
  }
  async restoreStep(token: string) {
    const context = await authorizer(this.env).verify(token);
    return bookStub(this.env, context.scope).restoreStep(token);
  }
  /** Independent incident authorization, not an ordinary book capability. */
  async beginRecovery(credential: string, expected: NativeCatalogSnapshot, requestId: string) {
    const scope = checkScope(this.env, expected.identity);
    return catalogStub(this.env, scope).beginRecovery(credential, expected, requestId);
  }
  async inspectRecoverySource(
    credential: string,
    expected: NativeCatalogSnapshot,
    requestId: string,
  ) {
    const scope = checkScope(this.env, expected.identity);
    return bookStub(this.env, scope).inspectRecoverySource(credential, expected, requestId);
  }
  async recoverUnavailableSource(
    credential: string,
    expected: NativeCatalogSnapshot,
    requestId: string,
  ) {
    const scope = checkScope(this.env, expected.identity);
    return catalogStub(this.env, scope).recoverUnavailableSource(credential, expected, requestId);
  }
  /** Private service-binding telemetry, never an unauthenticated health URL. */
  async archiveStatus(token: string) {
    const verifier = authorizer(this.env),
      context = await verifier.verify(token);
    verifier.assert(context, checkScope(this.env, context.scope), "maintain");
    return bookStub(this.env, context.scope).archiveStatus(token);
  }
  async activateRestoredWriter(token: string) {
    const context = await authorizer(this.env).verify(token);
    return bookStub(this.env, context.scope).activateRestoredWriter(token);
  }
  async verifyRestoredSnapshot(token: string) {
    const context = await authorizer(this.env).verify(token);
    return bookStub(this.env, context.scope).verifyRestoredSnapshot(token);
  }
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const permission =
      url.pathname === "/commands"
        ? "execute"
        : url.pathname === "/outcomes"
          ? "read"
          : url.pathname === "/authorization"
            ? "maintain"
            : null;
    if (!permission || url.search) return new Response(null, { status: 404 });
    if (request.method !== "POST")
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    try {
      const verifier = authorizer(this.env),
        context = await verifier.verify(request.headers.get("authorization"));
      verifier.assert(context, checkScope(this.env, context.scope), permission);
      // Strip caller-controlled internal/routing headers. Only a verified claim
      // chooses a book, and the owning object independently verifies it again.
      const headers = new Headers();
      for (const name of ["authorization", "content-type", "content-length", "content-encoding"]) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      return await bookStub(this.env, context.scope).fetch(new Request(request, { headers }));
    } catch (error) {
      return failure(error);
    }
  }
}

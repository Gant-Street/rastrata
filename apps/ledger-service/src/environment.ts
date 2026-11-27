import {
  BookAuthorizer,
  NativeRecoveryAuthorizer,
  LedgerError,
  bookObjectName,
  type BookAuthorizationConfiguration,
  type CompleteBookScope,
} from "@rastrata/ledger";
import type { LedgerBook } from "./book.ts";
import type { LedgerCatalog } from "./catalog.ts";

export interface Environment {
  BOOK_AUTHORIZATION: BookAuthorizationConfiguration;
  LEDGER_NAMESPACE_ID: string;
  BOOKS: DurableObjectNamespace<LedgerBook>;
  CATALOGS: DurableObjectNamespace<LedgerCatalog>;
  ARCHIVE: R2Bucket;
  /** Pinned public keys for purpose-specific incident/recovery capabilities.
   * The application/operator owns signing and evidence reconciliation. */
  RECOVERY_AUTHORIZATION?: BookAuthorizationConfiguration;
}
export function requireService(
  condition: unknown,
  code = "ledger_service_unavailable",
): asserts condition {
  if (!condition) throw new LedgerError(code);
}
export function resolveIdentity(
  env: Environment,
  tenantId: string,
  bookId: string,
): CompleteBookScope {
  requireService(
    typeof env.LEDGER_NAMESPACE_ID === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/.test(env.LEDGER_NAMESPACE_ID),
  );
  requireService(
    typeof tenantId === "string" &&
      typeof bookId === "string" &&
      tenantId.length <= 1024 &&
      bookId.length <= 1024,
    "ledger_request_invalid",
  );
  const name = bookObjectName(tenantId, bookId);
  return {
    tenantId,
    bookId,
    objectId: env.BOOKS.idFromName(name).toString(),
    namespaceId: env.LEDGER_NAMESPACE_ID,
    generation: "0",
  };
}
export function checkScope(env: Environment, scope: CompleteBookScope): CompleteBookScope {
  requireService(
    scope !== null &&
      typeof scope === "object" &&
      Object.keys(scope).sort().join(",") === "bookId,generation,namespaceId,objectId,tenantId",
    "ledger_forbidden",
  );
  const actual = resolveIdentity(env, scope.tenantId, scope.bookId);
  requireService(
    Object.entries(actual).every(([key, value]) => scope[key as keyof CompleteBookScope] === value),
    "ledger_forbidden",
  );
  return actual;
}
export function bookStub(env: Environment, scope: CompleteBookScope) {
  checkScope(env, scope);
  return env.BOOKS.get(env.BOOKS.idFromName(bookObjectName(scope.tenantId, scope.bookId)));
}
export function catalogStub(env: Environment, scope: CompleteBookScope) {
  checkScope(env, scope);
  return env.CATALOGS.get(env.CATALOGS.idFromName(bookObjectName(scope.tenantId, scope.bookId)));
}
const verifiers = new WeakMap<object, BookAuthorizer>();
const recoveryVerifiers = new WeakMap<object, NativeRecoveryAuthorizer>();
export function recoveryAuthorizer(env: Environment) {
  let verifier = recoveryVerifiers.get(env);
  if (!verifier) {
    requireService(
      env.RECOVERY_AUTHORIZATION !== undefined,
      "native_catalog_recovery_unconfigured",
    );
    verifier = new NativeRecoveryAuthorizer(env.RECOVERY_AUTHORIZATION);
    recoveryVerifiers.set(env, verifier);
  }
  return verifier;
}
export function authorizer(env: Environment) {
  let verifier = verifiers.get(env);
  if (!verifier) {
    verifier = new BookAuthorizer(env.BOOK_AUTHORIZATION);
    verifiers.set(env, verifier);
  }
  return verifier;
}
export function failure(error: unknown): Response {
  const code = error instanceof LedgerError ? error.code : "ledger_service_unavailable";
  const status =
    code === "ledger_unauthorized"
      ? 401
      : code === "ledger_forbidden"
        ? 403
        : code === "ledger_request_invalid"
          ? 400
          : 503;
  return Response.json(
    { error: status === 503 ? "ledger_service_unavailable" : code },
    { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
  );
}

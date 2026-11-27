import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { identifier } from "@rastrata/kernel";
import { completeScope } from "./compact-records.ts";
import { LedgerError, requireLedger, type CompleteBookScope } from "./records.ts";

export const BOOK_ACCESS_TOKEN_TYPE = "rastrata-book-access+jwt";
/** NumericDate uses whole seconds and independently routed machines can straddle
 * that boundary. Allow at most one second of early issuance, never late expiry. */
export const BOOK_ACCESS_CLOCK_SKEW_SECONDS = 1;
export type BookPermission = "read" | "execute" | "provision" | "maintain";
export interface BookAuthorization {
  readonly scope: CompleteBookScope;
  readonly actorId: string;
  readonly authorizationRevision: string;
  readonly writerFence: string;
  readonly permissions: readonly BookPermission[];
  readonly expiresAt: number;
}
export interface BookAuthorizationConfiguration {
  /** Application authorization issuer, not a URL taken from a token. */
  readonly issuer: string;
  readonly audience: string;
  readonly publicKeys: JSONWebKeySet;
  readonly maximumLifetimeSeconds?: number;
}
const natural = /^(0|[1-9][0-9]{0,63})$/;
const permissions: readonly BookPermission[] = ["read", "execute", "provision", "maintain"];

/** Shared pinned-key validation; neither verifier follows token-supplied URLs. */
export function pinnedAuthorizationConfiguration(configuration: BookAuthorizationConfiguration) {
  const { issuer, audience } = configuration;
  const lifetime = configuration.maximumLifetimeSeconds ?? 300;
  requireLedger(
    typeof issuer === "string" &&
      issuer.length > 0 &&
      issuer.length <= 2048 &&
      typeof audience === "string" &&
      audience.length > 0 &&
      audience.length <= 2048 &&
      Number.isSafeInteger(lifetime) &&
      lifetime > 0 &&
      lifetime <= 900,
    "ledger_authorization_configuration_invalid",
  );
  const keys = structuredClone(configuration.publicKeys);
  requireLedger(
    keys && Array.isArray(keys.keys) && keys.keys.length > 0 && keys.keys.length <= 16,
    "ledger_authorization_configuration_invalid",
  );
  const ids = new Set<string>();
  for (const key of keys.keys) {
    requireLedger(
      key &&
        key.kty === "EC" &&
        key.crv === "P-256" &&
        key.alg === "ES256" &&
        key.use === "sig" &&
        key.d === undefined &&
        typeof key.x === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(key.x) &&
        typeof key.y === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(key.y) &&
        typeof key.kid === "string" &&
        /^[A-Za-z0-9_-]{1,64}$/.test(key.kid) &&
        !ids.has(key.kid),
      "ledger_authorization_configuration_invalid",
    );
    ids.add(key.kid);
  }
  return { issuer, audience, lifetime, keys: createLocalJWKSet(keys) };
}

/** A book capability is the application gateway's signed membership/permission
 * decision, not an arbitrary login token. Local pinned public keys never follow
 * a caller's key URL. Writer fence is independent of stable book identity and is
 * mandatory: old credentials must not revive when access state is restored.
 * No issuer/signing key or user/role database lives here. */
export class BookAuthorizer {
  private readonly keys;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly lifetime: number;
  private readonly verified = new WeakSet<object>();

  constructor(
    configuration: BookAuthorizationConfiguration,
    private readonly clock = Date.now,
  ) {
    const pinned = pinnedAuthorizationConfiguration(configuration);
    this.issuer = pinned.issuer;
    this.audience = pinned.audience;
    this.lifetime = pinned.lifetime;
    this.keys = pinned.keys;
  }

  async verify(authorization: string | null): Promise<BookAuthorization> {
    try {
      requireLedger(
        typeof authorization === "string" &&
          authorization.length <= 16384 &&
          /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization),
        "ledger_unauthorized",
      );
      const now = this.now();
      const { payload, protectedHeader } = await jwtVerify(authorization.slice(7), this.keys, {
        algorithms: ["ES256"],
        issuer: this.issuer,
        audience: this.audience,
        typ: BOOK_ACCESS_TOKEN_TYPE,
        requiredClaims: ["iss", "aud", "sub", "iat", "nbf", "exp"],
        maxTokenAge: this.lifetime,
        clockTolerance: BOOK_ACCESS_CLOCK_SKEW_SECONDS,
        currentDate: new Date(now),
      });
      requireLedger(
        Object.keys(protectedHeader).sort().join(",") === "alg,kid,typ" &&
          protectedHeader.typ === BOOK_ACCESS_TOKEN_TYPE &&
          typeof protectedHeader.kid === "string" &&
          Object.keys(payload).sort().join(",") ===
            "aud,authorizationRevision,exp,iat,iss,nbf,permissions,scope,sub,writerFence" &&
          payload.aud === this.audience &&
          typeof payload.sub === "string" &&
          typeof payload.iat === "number" &&
          Number.isSafeInteger(payload.iat) &&
          payload.nbf === payload.iat &&
          typeof payload.exp === "number" &&
          Number.isSafeInteger(payload.exp) &&
          payload.exp > payload.iat &&
          payload.exp - payload.iat <= this.lifetime &&
          typeof payload.authorizationRevision === "string" &&
          natural.test(payload.authorizationRevision) &&
          typeof payload.writerFence === "string" &&
          natural.test(payload.writerFence) &&
          Array.isArray(payload.permissions) &&
          payload.permissions.length > 0 &&
          payload.permissions.length <= permissions.length &&
          new Set(payload.permissions).size === payload.permissions.length &&
          payload.permissions.every((value) => permissions.includes(value)) &&
          payload.scope !== null &&
          typeof payload.scope === "object" &&
          "objectId" in payload.scope &&
          typeof payload.scope.objectId === "string",
        "ledger_unauthorized",
      );
      identifier(payload.sub);
      const scope = completeScope(payload.scope as CompleteBookScope, payload.scope.objectId);
      const result: BookAuthorization = Object.freeze({
        scope,
        actorId: payload.sub,
        authorizationRevision: payload.authorizationRevision,
        writerFence: payload.writerFence,
        permissions: Object.freeze([...payload.permissions]),
        expiresAt: payload.exp * 1000,
      });
      // JOSE applies its tolerance to exp too. This explicit check deliberately
      // keeps expiry strict, including after asynchronous signature verification.
      requireLedger(this.now() < result.expiresAt, "ledger_unauthorized");
      this.verified.add(result);
      return result;
    } catch {
      // Never disclose the token, key details, claims or a verifier exception.
      throw new LedgerError("ledger_unauthorized");
    }
  }

  assert(
    context: BookAuthorization,
    scope: CompleteBookScope,
    permission: BookPermission,
    actorId?: string,
  ): void {
    requireLedger(
      context && this.verified.has(context) && this.now() < context.expiresAt,
      "ledger_unauthorized",
    );
    requireLedger(
      JSON.stringify(context.scope) === JSON.stringify(completeScope(scope, scope.objectId)) &&
        context.permissions.includes(permission) &&
        (actorId === undefined || context.actorId === actorId),
      "ledger_forbidden",
    );
  }
  private now(): number {
    const value = this.clock();
    requireLedger(Number.isSafeInteger(value) && value > 0, "ledger_authorization_clock_invalid");
    return value;
  }
}

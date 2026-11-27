import { jwtVerify, type JWTPayload } from "jose";
import { identifier, immutableAccountingValue } from "@rastrata/kernel";
import {
  pinnedAuthorizationConfiguration,
  BOOK_ACCESS_CLOCK_SKEW_SECONDS,
  type BookAuthorizationConfiguration,
} from "./book-authorization.ts";
import { completeScope } from "./compact-records.ts";
import { LedgerError, requireLedger, type CompleteBookScope } from "./records.ts";
import type { NativeCatalogSnapshot, NativeRecoveryEvidence } from "./native-ledger-catalog.ts";

export const NATIVE_INCIDENT_TOKEN_TYPE = "rastrata-ledger-incident+jwt";
export const NATIVE_RECOVERY_TOKEN_TYPE = "rastrata-ledger-recovery+jwt";
function matchesScope(input: CompleteBookScope, expected: CompleteBookScope): boolean {
  try {
    return (
      JSON.stringify(completeScope(input, expected.objectId)) ===
      JSON.stringify(completeScope(expected, expected.objectId))
    );
  } catch {
    return false;
  }
}

/** Offline-verifiable incident authority. The application/operator signs exact,
 * reconciled evidence, not a generic permission to choose any R2 prefix. Incident
 * credentials can only quarantine; recovery grants additionally bind that actual
 * quarantine revision. Signing keys never enter the ledger. */
export class NativeRecoveryAuthorizer {
  private readonly pinned;
  constructor(
    configuration: BookAuthorizationConfiguration,
    private readonly clock = Date.now,
  ) {
    this.pinned = pinnedAuthorizationConfiguration(configuration);
  }
  private now() {
    const now = this.clock();
    requireLedger(Number.isSafeInteger(now) && now > 0, "ledger_authorization_clock_invalid");
    return now;
  }
  private async verify(credential: string, type: string, fields: string): Promise<JWTPayload> {
    try {
      requireLedger(
        typeof credential === "string" &&
          credential.length <= 16384 &&
          /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(credential),
        "ledger_unauthorized",
      );
      const { payload, protectedHeader } = await jwtVerify(credential.slice(7), this.pinned.keys, {
        algorithms: ["ES256"],
        issuer: this.pinned.issuer,
        audience: this.pinned.audience,
        typ: type,
        requiredClaims: ["iss", "aud", "sub", "iat", "nbf", "exp", "jti"],
        maxTokenAge: this.pinned.lifetime,
        currentDate: new Date(this.now()),
        clockTolerance: BOOK_ACCESS_CLOCK_SKEW_SECONDS,
      });
      requireLedger(
        Object.keys(protectedHeader).sort().join(",") === "alg,kid,typ" &&
          protectedHeader.typ === type &&
          typeof protectedHeader.kid === "string" &&
          Object.keys(payload).sort().join(",") === fields &&
          payload.aud === this.pinned.audience &&
          typeof payload.sub === "string" &&
          payload.sub.length <= 1024 &&
          typeof payload.jti === "string" &&
          payload.jti.length <= 1024 &&
          typeof payload.iat === "number" &&
          Number.isSafeInteger(payload.iat) &&
          payload.nbf === payload.iat &&
          typeof payload.exp === "number" &&
          Number.isSafeInteger(payload.exp) &&
          payload.exp > payload.iat &&
          payload.exp - payload.iat <= this.pinned.lifetime &&
          this.now() < payload.exp * 1000,
        "ledger_unauthorized",
      );
      identifier(payload.sub);
      identifier(payload.jti);
      return payload;
    } catch {
      throw new LedgerError("ledger_unauthorized");
    }
  }
  async incident(
    credential: string,
    scope: CompleteBookScope,
    catalogHash: string,
    requestId: string,
  ) {
    const payload = await this.verify(
      credential,
      NATIVE_INCIDENT_TOKEN_TYPE,
      "aud,catalogHash,exp,iat,iss,jti,nbf,scope,sub",
    );
    requireLedger(
      payload.catalogHash === catalogHash &&
        payload.jti === requestId &&
        matchesScope(payload.scope as CompleteBookScope, scope),
      "ledger_forbidden",
    );
    return Object.freeze({
      actorId: payload.sub as string,
      expiresAt: (payload.exp as number) * 1000,
    });
  }
  async recovery(
    credential: string,
    expected: NativeCatalogSnapshot,
    requestId: string,
    current: NativeCatalogSnapshot,
    quarantinedCatalogHash: string | null,
  ): Promise<NativeRecoveryEvidence> {
    const payload = await this.verify(
      credential,
      NATIVE_RECOVERY_TOKEN_TYPE,
      "aud,evidence,exp,iat,iss,jti,nbf,quarantinedCatalogHash,sub",
    );
    const evidence = payload.evidence as NativeRecoveryEvidence;
    requireLedger(
      evidence !== null &&
        typeof evidence === "object" &&
        evidence.approvedBy === payload.sub &&
        evidence.requestId === requestId &&
        payload.jti === requestId &&
        evidence.expectedCatalogHash === expected.contentHash &&
        matchesScope(evidence.scope, expected.identity) &&
        matchesScope(current.identity, expected.identity) &&
        typeof payload.quarantinedCatalogHash === "string" &&
        /^[a-f0-9]{64}$/.test(payload.quarantinedCatalogHash) &&
        (quarantinedCatalogHash === null ||
          quarantinedCatalogHash === payload.quarantinedCatalogHash) &&
        current.status === "maintenance" &&
        ((current.mutation.kind === "quiesce" &&
          current.mutation.id === requestId &&
          current.mutation.expectedHash === expected.contentHash &&
          current.contentHash === payload.quarantinedCatalogHash) ||
          (current.mutation.kind === "restore" &&
            current.restore?.requestId === requestId &&
            current.restore.recovery?.expectedCatalogHash === expected.contentHash &&
            current.mutation.expectedHash === payload.quarantinedCatalogHash)),
      "ledger_forbidden",
    );
    // Exact nested evidence validation and equality are also enforced by the
    // catalog before any publication; this returns only signed immutable data.
    return immutableAccountingValue(evidence) as NativeRecoveryEvidence;
  }
}

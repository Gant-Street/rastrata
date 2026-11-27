import { expect, test } from "bun:test";
import { SignJWT } from "jose";
import {
  NativeRecoveryAuthorizer,
  NATIVE_INCIDENT_TOKEN_TYPE,
  NATIVE_RECOVERY_TOKEN_TYPE,
} from "../src/native-recovery-authorization.ts";
import type {
  NativeCatalogSnapshot,
  NativeRecoveryEvidence,
} from "../src/native-ledger-catalog.ts";
import { completeScope } from "../src/compact-records.ts";
import { authorizationFixture } from "./authorization-fixtures.ts";

async function fixture() {
  const f = await authorizationFixture();
  const scope = completeScope(f.scope, f.scope.objectId);
  const expected: NativeCatalogSnapshot = {
    version: "rastrata-native-catalog-v1",
    catalogObjectId: "catalog",
    revision: "1",
    identity: scope,
    genesisHash: "a".repeat(64),
    status: "active",
    fence: "0",
    retirement: null,
    sealed: null,
    restore: null,
    mutation: { id: "activate", kind: "activate", expectedHash: "0".repeat(64) },
    contentHash: "b".repeat(64),
  };
  const current: NativeCatalogSnapshot = {
    ...expected,
    revision: "2",
    status: "maintenance",
    mutation: { id: "incident", kind: "quiesce", expectedHash: expected.contentHash },
    contentHash: "c".repeat(64),
  };
  const evidence: NativeRecoveryEvidence = {
    scope,
    requestId: "incident",
    expectedCatalogHash: expected.contentHash,
    evidenceId: "native-surviving-source",
    approvedBy: "operator",
    genesisHash: expected.genesisHash,
    head: { sequence: "3", bookRevision: "2", chainHash: "d".repeat(64) },
    projection: { count: "20", digest: "e".repeat(64) },
    authorizationRevision: "1",
  };
  const verifier = new NativeRecoveryAuthorizer(f.configuration, () => f.clock.now);
  const sign = async (type: string, overrides: Record<string, unknown> = {}, header = {}) => {
    const now = Math.floor(f.clock.now / 1000);
    return `Bearer ${await new SignJWT({
      iss: f.configuration.issuer,
      aud: f.configuration.audience,
      sub: "operator",
      iat: now,
      nbf: now,
      exp: now + 300,
      jti: "incident",
      ...(type === NATIVE_INCIDENT_TOKEN_TYPE
        ? { scope, catalogHash: expected.contentHash }
        : { evidence, quarantinedCatalogHash: current.contentHash }),
      ...overrides,
    })
      .setProtectedHeader({ typ: type, kid: "key-1", alg: "ES256", ...header })
      .sign(f.keys.privateKey)}`;
  };
  return { ...f, scope, expected, current, evidence, verifier, sign };
}

test("incident and recovery grants are purpose separated, scoped and bound to actual quarantine", async () => {
  const f = await fixture();
  const incident = await f.sign(NATIVE_INCIDENT_TOKEN_TYPE),
    grant = await f.sign(NATIVE_RECOVERY_TOKEN_TYPE);
  expect(
    (await f.verifier.incident(incident, f.scope, f.expected.contentHash, "incident")).actorId,
  ).toBe("operator");
  expect(
    await f.verifier.recovery(grant, f.expected, "incident", f.current, f.current.contentHash),
  ).toEqual(f.evidence);
  await expect(
    f.verifier.recovery(incident, f.expected, "incident", f.current, null),
  ).rejects.toThrow("ledger_unauthorized");
  await expect(
    f.verifier.incident(grant, f.scope, f.expected.contentHash, "incident"),
  ).rejects.toThrow("ledger_unauthorized");
  await expect(
    f.verifier.incident(await f.token(), f.scope, f.expected.contentHash, "incident"),
  ).rejects.toThrow("ledger_unauthorized");
  for (const current of [
    f.expected,
    { ...f.current, contentHash: "f".repeat(64) },
    { ...f.current, mutation: { ...f.current.mutation, id: "other" } },
  ])
    await expect(f.verifier.recovery(grant, f.expected, "incident", current, null)).rejects.toThrow(
      "ledger_forbidden",
    );
  await expect(
    f.verifier.recovery(grant, f.expected, "incident", f.current, "f".repeat(64)),
  ).rejects.toThrow("ledger_forbidden");
  await expect(
    f.verifier.incident(
      incident,
      { ...f.scope, tenantId: "foreign" },
      f.expected.contentHash,
      "incident",
    ),
  ).rejects.toThrow("ledger_forbidden");
  await expect(f.verifier.incident(incident, f.scope, "f".repeat(64), "incident")).rejects.toThrow(
    "ledger_forbidden",
  );
  await expect(
    f.verifier.incident(incident, f.scope, f.expected.contentHash, "other"),
  ).rejects.toThrow("ledger_forbidden");
  f.clock.now += 300_000;
  await expect(
    f.verifier.incident(incident, f.scope, f.expected.contentHash, "incident"),
  ).rejects.toThrow("ledger_unauthorized");
  await expect(f.verifier.recovery(grant, f.expected, "incident", f.current, null)).rejects.toThrow(
    "ledger_unauthorized",
  );
});

test("signed recovery rejects malformed claims, substitutions and unpinned headers", async () => {
  const f = await fixture(),
    now = Math.floor(f.clock.now / 1000);
  for (const claims of [
    { aud: [f.configuration.audience] },
    { iss: "foreign" },
    { sub: "" },
    { exp: now },
    { exp: now + 301 },
    { exp: now + 0.5 },
    { iat: now + 2, nbf: now + 2 },
    { nbf: now - 1 },
    { jti: "" },
    { extra: true },
    { evidence: null },
    { evidence: { ...f.evidence, approvedBy: "other" } },
    { evidence: { ...f.evidence, requestId: "other" } },
    { evidence: { ...f.evidence, scope: { ...f.scope, objectId: "foreign" } } },
    { evidence: { ...f.evidence, expectedCatalogHash: "f".repeat(64) } },
    { quarantinedCatalogHash: "invalid" },
  ]) {
    await expect(
      f.verifier.recovery(
        await f.sign(NATIVE_RECOVERY_TOKEN_TYPE, claims),
        f.expected,
        "incident",
        f.current,
        null,
      ),
    ).rejects.toThrow();
  }
  for (const header of [
    { kid: "unknown" },
    { jku: "https://untrusted.invalid/keys" },
    { typ: "JWT" },
  ])
    await expect(
      f.verifier.recovery(
        await f.sign(NATIVE_RECOVERY_TOKEN_TYPE, {}, header),
        f.expected,
        "incident",
        f.current,
        null,
      ),
    ).rejects.toThrow("ledger_unauthorized");
  for (const credential of ["", "Bearer invalid", `Bearer ${"x".repeat(16384)}`])
    await expect(
      f.verifier.recovery(credential, f.expected, "incident", f.current, null),
    ).rejects.toThrow("ledger_unauthorized");
  const foreign = await fixture();
  await expect(
    f.verifier.recovery(
      await foreign.sign(NATIVE_RECOVERY_TOKEN_TYPE),
      f.expected,
      "incident",
      f.current,
      null,
    ),
  ).rejects.toThrow("ledger_unauthorized");
});

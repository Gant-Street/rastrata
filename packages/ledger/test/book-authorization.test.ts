import { expect, test } from "bun:test";
import { BookAuthorizer, type BookAuthorization } from "../src/book-authorization.ts";
import { authorizationFixture } from "./authorization-fixtures.ts";

test("book authorization verifies pinned signatures and creates an unforgeable immutable scoped decision", async () => {
  const f = await authorizationFixture(),
    context = await f.authorizer.verify(await f.token());
  f.authorizer.assert(context, f.scope, "execute", "actor");
  expect(context.authorizationRevision).toBe("0");
  expect(context.writerFence).toBe("0");
  expect(Object.isFrozen(context)).toBe(true);
  expect(Object.isFrozen(context.scope)).toBe(true);
  expect(Object.isFrozen(context.permissions)).toBe(true);
  expect(() => f.authorizer.assert({ ...context } as BookAuthorization, f.scope, "read")).toThrow(
    "ledger_unauthorized",
  );
  for (const field of ["tenantId", "bookId", "objectId", "namespaceId", "generation"] as const)
    expect(() =>
      f.authorizer.assert(
        context,
        { ...f.scope, [field]: field === "generation" ? "1" : "foreign" },
        "read",
      ),
    ).toThrow("ledger_forbidden");
  expect(() => f.authorizer.assert(context, f.scope, "execute", "another-actor")).toThrow(
    "ledger_forbidden",
  );
  const reader = await f.authorizer.verify(await f.token({ permissions: ["read"] }));
  expect(() => f.authorizer.assert(reader, f.scope, "execute")).toThrow("ledger_forbidden");
  f.clock.now += 300000;
  expect(() => f.authorizer.assert(context, f.scope, "read")).toThrow("ledger_unauthorized");
});

test("book authorization rejects malformed, expired, unknown-key and non-capability tokens without leaking claims", async () => {
  const f = await authorizationFixture(),
    now = Math.floor(f.clock.now / 1000);
  for (const claims of [
    { iss: "wrong" },
    { aud: "wrong" },
    { aud: [f.configuration.audience] },
    { sub: "" },
    { exp: now },
    { exp: undefined },
    { iat: undefined },
    { nbf: undefined },
    { exp: now + 301 },
    { exp: now + 1.5 },
    { iat: now + 2, nbf: now + 2 },
    { nbf: now - 1 },
    { permissions: [] },
    { permissions: ["read", "read"] },
    { permissions: ["owner"] },
    { authorizationRevision: 0 },
    { authorizationRevision: "00" },
    { writerFence: undefined },
    { writerFence: 0 },
    { writerFence: "00" },
    { writerFence: "-1" },
    { writerFence: "9".repeat(65) },
    { scope: { ...f.scope, extra: true } },
    { admin: true },
  ])
    await expect(f.authorizer.verify(await f.token(claims))).rejects.toThrow("ledger_unauthorized");
  for (const header of [
    { kid: "unknown" },
    { typ: "JWT" },
    { jku: "https://untrusted.invalid/keys" },
    { jwk: f.publicKeys.keys[0] },
  ])
    await expect(f.authorizer.verify(await f.token({}, header))).rejects.toThrow(
      "ledger_unauthorized",
    );
  const other = await authorizationFixture();
  await expect(f.authorizer.verify(await other.token())).rejects.toThrow("ledger_unauthorized");
  for (const input of [null, "", "Bearer a.b.c", "Bearer " + "x".repeat(16384), "bearer a.b.c"])
    await expect(f.authorizer.verify(input)).rejects.toThrow("ledger_unauthorized");
  expect(() => new BookAuthorizer({ ...f.configuration, publicKeys: { keys: [] } })).toThrow(
    "ledger_authorization_configuration_invalid",
  );
  expect(
    () =>
      new BookAuthorizer({
        ...f.configuration,
        publicKeys: { keys: [{ ...f.publicKeys.keys[0], d: "private" }] },
      }),
  ).toThrow("ledger_authorization_configuration_invalid");
});

test("one-second issuance skew never extends expiry or permits a later not-before boundary", async () => {
  const f = await authorizationFixture(),
    now = Math.floor(f.clock.now / 1000);
  // Reproduces the deployed failure: issuer crosses a second boundary while
  // the book's independently observed clock is a few milliseconds behind it.
  f.clock.now += 993;
  const signed = await f.token({ iat: now + 1, nbf: now + 1, exp: now + 301 });
  const context = await f.authorizer.verify(signed);
  f.authorizer.assert(context, f.scope, "execute", "actor");
  expect(context.expiresAt).toBe((now + 301) * 1000);
  await expect(
    f.authorizer.verify(
      await f.token({
        iat: now + 2,
        nbf: now + 2,
        exp: now + 302,
      }),
    ),
  ).rejects.toThrow("ledger_unauthorized");
  // The exact one-second early boundary is accepted; one millisecond beyond
  // it is a second NumericDate bucket and remains unavailable.
  f.clock.now = now * 1000;
  await expect(f.authorizer.verify(signed)).resolves.toMatchObject({ actorId: "actor" });
  f.clock.now--;
  await expect(f.authorizer.verify(signed)).rejects.toThrow("ledger_unauthorized");
  f.clock.now = (now + 301) * 1000 - 1;
  await expect(f.authorizer.verify(signed)).resolves.toMatchObject({ actorId: "actor" });
  f.clock.now++;
  await expect(f.authorizer.verify(signed)).rejects.toThrow("ledger_unauthorized");
  expect(() => f.authorizer.assert(context, f.scope, "read")).toThrow("ledger_unauthorized");
  f.clock.now++;
  await expect(f.authorizer.verify(signed)).rejects.toThrow("ledger_unauthorized");
});

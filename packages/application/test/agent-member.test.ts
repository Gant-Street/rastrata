import { expect, test } from "bun:test";
import {
  AGENT_TOKEN_TTL_SECONDS,
  GRANTABLE_PERMISSIONS,
  MEMBER_TOKEN,
  ROLE_PERMISSIONS,
  WORKSPACE_ROLES,
  agentScopes,
  isWorkspaceRole,
  memberClaims,
  memberTokenIssuer,
  memberTokenKeysUrl,
} from "../src/agent/index.ts";
import { BUSINESS_PERMISSIONS } from "../src/schema-kit.ts";

test("every role has permissions the application knows, and only the owner may provision", () => {
  for (const role of WORKSPACE_ROLES) {
    const granted = ROLE_PERMISSIONS[role];
    expect(granted.length).toBeGreaterThan(0);
    for (const permission of granted) expect(BUSINESS_PERMISSIONS).toContain(permission);
    // Everyone who is in can read, and no role holds a permission twice.
    expect(granted).toContain("read");
    expect(new Set(granted).size).toBe(granted.length);
  }
  const provisioning = WORKSPACE_ROLES.filter((role) =>
    ROLE_PERMISSIONS[role].includes("provision"),
  );
  expect(provisioning).toEqual(["owner"]);
});

test("the roles widen from member to owner, and an agent token never holds what only the owner may", () => {
  const order = ["member", "accountant", "admin", "owner"] as const;
  for (let at = 1; at < order.length; at += 1) {
    const narrower = ROLE_PERMISSIONS[order[at - 1] as (typeof order)[number]];
    const wider = ROLE_PERMISSIONS[order[at] as (typeof order)[number]];
    for (const permission of narrower) expect(wider).toContain(permission);
  }
  // What an agent token may carry is what an admin holds or less: never `provision`.
  for (const permission of GRANTABLE_PERMISSIONS)
    expect(ROLE_PERMISSIONS.admin).toContain(permission);
});

test("a role is one of the four, and nothing else is taken for one", () => {
  for (const role of WORKSPACE_ROLES) expect(isWorkspaceRole(role)).toBe(true);
  for (const other of ["Owner", "root", "", undefined, null, 4, {}])
    expect(isWorkspaceRole(other)).toBe(false);
});

test("the token's issuer and keys are named from the app's own address, with no doubled slash", () => {
  expect(memberTokenIssuer("https://app.rastrata.com")).toBe("https://app.rastrata.com/auth");
  expect(memberTokenIssuer("https://app.rastrata.com/")).toBe("https://app.rastrata.com/auth");
  expect(memberTokenKeysUrl("https://app.rastrata.com")).toBe("https://app.rastrata.com/auth/jwks");
  expect(MEMBER_TOKEN).toEqual({ audience: "rastrata-app", ttlSeconds: 600, algorithm: "EdDSA" });
});

test("a token's claims are read only when all three are identifiers", () => {
  const good = {
    sub: "TFRweLEK4RfYd4Lon1z3D6R2zWXtBxLR",
    wid: "wsp_0123456789",
    bid: "book-0123456789",
  };
  expect(memberClaims(good)).toEqual(good);
  expect(memberClaims({ ...good, extra: "ignored", exp: 1 })).toEqual(good);
  for (const bad of [
    { ...good, sub: undefined },
    { ...good, wid: 12345678 },
    { ...good, bid: "short" },
    { ...good, bid: "has a space in it" },
    { ...good, sub: "x".repeat(65) },
    { ...good, wid: "../../etc/passwd" },
    {},
  ])
    expect(memberClaims(bad as Record<string, unknown>)).toBeNull();
});

test("a token made for an agent key says which key and what it may do, both or neither, and a person's token says neither", () => {
  const person = {
    sub: "TFRweLEK4RfYd4Lon1z3D6R2zWXtBxLR",
    wid: "wsp_0123456789",
    bid: "book-0123456789",
  };
  const good = {
    ...person,
    agt: "0123456789abcdef",
    scp: ["read", "draft"],
    knm: "Claude on my laptop",
    kex: "2027-01-13T12:00:00.000Z",
  };
  expect(memberClaims(good)).toEqual({
    ...person,
    agent: {
      keyId: "0123456789abcdef",
      scopes: ["read", "draft"],
      name: "Claude on my laptop",
      expiresAt: "2027-01-13T12:00:00.000Z",
    },
  });
  // A person's token has no agent in it, and a made-up claim does not make one.
  expect(memberClaims(person)?.agent).toBeUndefined();
  for (const bad of [
    { ...good, scp: undefined },
    { ...good, agt: undefined },
    { ...good, agt: "NOTAKEYID" },
    { ...good, agt: "0123456789ABCDEF" },
    { ...good, agt: 12345 },
    { ...good, scp: [] },
    { ...good, scp: "read" },
    { ...good, scp: ["draft"] },
    { ...good, scp: ["read", "provision"] },
    { ...good, scp: ["read", "read"] },
    { ...good, scp: ["read", "root"] },
    { ...good, scp: ["read", 7] },
    { ...good, knm: undefined },
    { ...good, kex: undefined },
    { ...good, kex: "soon" },
    { ...good, kex: 1_800_000_000 },
    { ...good, knm: "" },
    { ...good, knm: " padded " },
    { ...good, knm: "two\nlines" },
    { ...good, knm: "x".repeat(81) },
    { ...good, knm: 7 },
  ])
    expect(memberClaims(bad as Record<string, unknown>), JSON.stringify(bad)).toBeNull();
  expect(AGENT_TOKEN_TTL_SECONDS).toBeLessThan(MEMBER_TOKEN.ttlSeconds);
});

test("what an agent key may be given is the grantable permissions, once each, read among them, in the order a person's are listed", () => {
  expect(agentScopes(["read"])).toEqual(["read"]);
  expect(agentScopes(["close", "post", "read"])).toEqual(["read", "post", "close"]);
  expect(agentScopes([...GRANTABLE_PERMISSIONS])).toEqual([...GRANTABLE_PERMISSIONS]);
  for (const bad of [
    [],
    ["draft"],
    ["read", "provision"],
    ["read", "read"],
    "read",
    null,
    undefined,
    {},
  ])
    expect(agentScopes(bad)).toBeNull();
});

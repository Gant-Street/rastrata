import { expect, test } from "bun:test";
import {
  AGENT_KEY_ID,
  DEFAULT_TOKEN_DAYS,
  GRANTABLE_PERMISSIONS,
  MAX_LABEL_LENGTH,
  MAX_TOKEN_DAYS,
  constantTimeEqual,
  expiryFrom,
  isOwnerKey,
  issueAgentKey,
  issueOwnerKey,
  issueToken,
  normalizeLabel,
  normalizePermissions,
  parseAgentKey,
  parseAuthorization,
  sha256Hex,
} from "../src/agent/token.ts";
import { BUSINESS_PERMISSIONS } from "../src/schema.ts";

test("a token is rst_<id>_<secret>, only the secret's digest is returned for storage", async () => {
  const issued = await issueToken();
  expect(issued.token).toMatch(/^rst_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
  expect(issued.token.startsWith(`rst_${issued.id}_`)).toBe(true);
  const secret = issued.token.slice(`rst_${issued.id}_`.length);
  expect(issued.secretHash).toBe(await sha256Hex(secret));
  expect(issued.secretHash).toMatch(/^[0-9a-f]{64}$/);
  expect(issued.secretHash).not.toContain(secret);
  // 256 random bits: two tokens never collide in practice.
  const second = await issueToken();
  expect(second.token).not.toBe(issued.token);
  expect(second.id).not.toBe(issued.id);
});

test("the owner key has its own prefix and can never be read as a token", () => {
  const key = issueOwnerKey();
  expect(key).toMatch(/^rso_[A-Za-z0-9_-]{43}$/);
  expect(isOwnerKey(key)).toBe(true);
  expect(isOwnerKey(`${key}x`)).toBe(false);
  expect(isOwnerKey(`rst_0123456789abcdef_${"a".repeat(43)}`)).toBe(false);
  expect(parseAuthorization(`Bearer ${key}`)).toEqual({ kind: "ownerKey", key });
});

test("an Authorization header is a token, an owner key, absent, or invalid; never a silent nothing", async () => {
  const issued = await issueToken();
  const secret = issued.token.slice(`rst_${issued.id}_`.length);
  expect(parseAuthorization(null)).toEqual({ kind: "none" });
  expect(parseAuthorization(`Bearer ${issued.token}`)).toEqual({
    kind: "token",
    id: issued.id,
    secret,
  });
  // The scheme is case-insensitive; the credential is not.
  expect(parseAuthorization(`bearer ${issued.token}`).kind).toBe("token");
  for (const header of [
    "",
    "Bearer",
    "Bearer ",
    `Bearer ${issued.token} extra`,
    `Bearer ${issued.token}, Bearer ${issued.token}`,
    `Basic ${btoa("user:pass")}`,
    issued.token,
    `Bearer ${issued.token.toUpperCase()}`,
    `Bearer ${issued.token.slice(0, -1)}`,
    `Bearer ${issued.token}x`,
    `Bearer rst_${issued.id}`,
    `Bearer rst_ABCDEF0123456789_${secret}`,
    "Bearer null",
    ` Bearer ${issued.token}`,
  ])
    expect(parseAuthorization(header), JSON.stringify(header)).toEqual({ kind: "invalid" });
});

test("digests are compared whole and a difference anywhere is a difference", async () => {
  const digest = await sha256Hex("secret");
  expect(constantTimeEqual(digest, await sha256Hex("secret"))).toBe(true);
  expect(constantTimeEqual(digest, await sha256Hex("Secret"))).toBe(false);
  expect(constantTimeEqual(digest, digest.slice(0, -1))).toBe(false);
  expect(constantTimeEqual("", "")).toBe(true);
  for (let index = 0; index < digest.length; index++) {
    const flipped = `${digest.slice(0, index)}${digest[index] === "0" ? "1" : "0"}${digest.slice(index + 1)}`;
    expect(constantTimeEqual(digest, flipped)).toBe(false);
  }
});

test("permissions: read is required, provision is never grantable, nothing exceeds the creator", () => {
  expect(normalizePermissions(["draft", "read", "draft"], BUSINESS_PERMISSIONS)).toEqual([
    "read",
    "draft",
  ]);
  expect(normalizePermissions([...GRANTABLE_PERMISSIONS].reverse(), BUSINESS_PERMISSIONS)).toEqual(
    GRANTABLE_PERMISSIONS,
  );
  expect(() => normalizePermissions(["read", "provision"], BUSINESS_PERMISSIONS)).toThrow(
    "create more tokens",
  );
  expect(() => normalizePermissions(["read", "admin"], BUSINESS_PERMISSIONS)).toThrow(
    "not a permission a token can hold",
  );
  expect(() => normalizePermissions(["draft"], BUSINESS_PERMISSIONS)).toThrow("needs read");
  expect(() => normalizePermissions([], BUSINESS_PERMISSIONS)).toThrow("needs read");
  // A creator can only hand out what it holds.
  expect(() => normalizePermissions(["read", "post"], ["read", "provision"])).toThrow(
    "does not hold",
  );
  expect(normalizePermissions(["read"], ["read", "provision"])).toEqual(["read"]);
});

test("labels are trimmed, bounded and cannot hide or reorder the text around them", () => {
  expect(normalizeLabel("  Claude Code on the laptop  ")).toBe("Claude Code on the laptop");
  expect(normalizeLabel("Buchhaltung für Müller – 経理")).toBe("Buchhaltung für Müller – 経理");
  expect(normalizeLabel("x".repeat(MAX_LABEL_LENGTH))).toHaveLength(MAX_LABEL_LENGTH);
  for (const bad of [
    "",
    "   ",
    "x".repeat(MAX_LABEL_LENGTH + 1),
    "line\nbreak",
    "tab\there",
    "nul\u0000byte",
    "escape\u001b[31m",
    "del\u007f",
    "next\u0085line",
    "reorder‮evil",
    "isolate⁦x⁩",
    "mark‏x",
  ])
    expect(() => normalizeLabel(bad), JSON.stringify(bad)).toThrow();
});

test("expiry defaults to 90 days, is never open-ended and is capped at a year", () => {
  const now = new Date("2026-10-03T12:00:00.000Z");
  expect(expiryFrom(now, undefined)).toBe("2027-01-01T12:00:00.000Z");
  expect(DEFAULT_TOKEN_DAYS).toBe(90);
  expect(expiryFrom(now, 1)).toBe("2026-10-04T12:00:00.000Z");
  expect(expiryFrom(now, MAX_TOKEN_DAYS)).toBe("2027-10-03T12:00:00.000Z");
  for (const bad of [0, -1, 1.5, MAX_TOKEN_DAYS + 1, Number.NaN, Number.POSITIVE_INFINITY])
    expect(() => expiryFrom(now, bad), String(bad)).toThrow("Choose an expiry");
});

test("an agent key is rsa_<id>_<secret>, it is not a token or an owner key, only the secret's digest is returned for storage, and it parses back to its parts", async () => {
  const issued = await issueAgentKey();
  expect(issued.key).toMatch(/^rsa_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
  expect(AGENT_KEY_ID.test(issued.id)).toBe(true);
  const parsed = parseAgentKey(issued.key);
  expect(parsed?.id).toBe(issued.id);
  expect(issued.secretHash).toBe(await sha256Hex(parsed?.secret ?? ""));
  expect(issued.secretHash).not.toContain(parsed?.secret ?? "?");
  // The three kinds of credential are not taken for one another, by the parser of any of them.
  expect(parseAuthorization(`Bearer ${issued.key}`)).toEqual({ kind: "invalid" });
  expect(parseAgentKey((await issueToken()).token)).toBeNull();
  expect(parseAgentKey(issueOwnerKey())).toBeNull();
  for (const bad of [
    "",
    "rsa_",
    `${issued.key}x`,
    ` ${issued.key}`,
    issued.key.toUpperCase(),
    `rsa_${issued.id}`,
    `rsa_${issued.id}_short`,
  ])
    expect(parseAgentKey(bad), bad).toBeNull();
  // Two keys never share an id or a secret.
  const another = await issueAgentKey();
  expect(another.id).not.toBe(issued.id);
  expect(another.secretHash).not.toBe(issued.secretHash);
});

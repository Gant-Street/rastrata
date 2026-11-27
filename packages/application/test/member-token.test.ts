import { expect, test } from "bun:test";
import { createLocalJWKSet, errors, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { MEMBER_TOKEN, memberTokenIssuer } from "../src/agent/member.ts";
import { looksLikeMemberToken, memberTokenVerifier } from "../src/agent/member-token.ts";

const ORIGIN = "https://app.rastrata.com";
const CLAIMS = { wid: "wsp_0000000001", bid: "book_0000000001" };
const NOW = new Date("2026-10-15T12:00:00Z");

async function signer(kid = "key-1") {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  const jwk: JWK = { ...(await exportJWK(publicKey)), alg: "EdDSA", kid };
  const sign = (
    claims: Record<string, unknown> = {},
    options: {
      issuer?: string;
      audience?: string;
      expires?: number | string;
      subject?: string | null;
      alg?: string;
    } = {},
  ) => {
    let token = new SignJWT({ ...CLAIMS, ...claims })
      .setProtectedHeader({ alg: options.alg ?? "EdDSA", kid })
      .setIssuer(options.issuer ?? memberTokenIssuer(ORIGIN))
      .setAudience(options.audience ?? MEMBER_TOKEN.audience)
      .setIssuedAt(Math.floor(NOW.getTime() / 1000))
      .setExpirationTime(
        options.expires ?? Math.floor(NOW.getTime() / 1000) + MEMBER_TOKEN.ttlSeconds,
      );
    if (options.subject !== null) token = token.setSubject(options.subject ?? "user_0000000001");
    return token.sign(privateKey);
  };
  return { jwk, sign };
}

test("a token signed by the control plane's key, for this audience and issuer, is checked from the published keys alone", async () => {
  const { jwk, sign } = await signer();
  const verifier = memberTokenVerifier({
    origin: ORIGIN,
    keys: createLocalJWKSet({ keys: [jwk] }),
    clock: () => NOW,
  });
  const verdict = await verifier.verify(await sign());
  expect(verdict).toEqual({ kind: "valid", claims: { sub: "user_0000000001", ...CLAIMS } });
  // Just inside its ten minutes, and a few seconds of clock difference either way, it still checks.
  const late = memberTokenVerifier({
    origin: ORIGIN,
    keys: createLocalJWKSet({ keys: [jwk] }),
    clock: () => new Date(NOW.getTime() + 10 * 60_000 + 3000),
  });
  expect((await late.verify(await sign())).kind).toBe("valid");
});

test("the control plane's keys are fetched before the first request and again in the background, so that no request waits for them", async () => {
  const { jwk, sign } = await signer();
  let fetched = 0;
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetched += 1;
    return Response.json({ keys: [jwk] });
  }) as unknown as typeof fetch;
  const stop = new AbortController();
  try {
    const verifier = memberTokenVerifier({
      origin: ORIGIN,
      refreshEveryMs: 40,
      stop: stop.signal,
      clock: () => NOW,
    });
    await Bun.sleep(25);
    // Fetched at once, with no request to ask for it.
    expect(fetched).toBeGreaterThanOrEqual(1);
    const before = fetched;
    expect((await verifier.verify(await sign())).kind).toBe("valid");
    // The request did not fetch them: they were there.
    expect(fetched).toBe(before);
    // And they are fetched again on their own, ahead of the time they would run out.
    await Bun.sleep(160);
    expect(fetched).toBeGreaterThanOrEqual(before + 2);
  } finally {
    stop.abort();
    globalThis.fetch = real;
  }
});

test("a token that is not the control plane's, or is not good, is refused, and nothing is learned from why", async () => {
  const { jwk, sign } = await signer();
  const other = await signer("key-1");
  const keys = createLocalJWKSet({ keys: [jwk] });
  const verifier = memberTokenVerifier({ origin: ORIGIN, keys, clock: () => NOW });
  const refused = [
    await sign({}, { audience: "someone-else" }),
    await sign({}, { issuer: "https://evil.example/auth" }),
    await sign({}, { expires: Math.floor(NOW.getTime() / 1000) - 60 }),
    await sign({ wid: undefined }),
    await sign({ bid: "no" }),
    await sign({}, { subject: "has spaces in it" }),
    await sign({}, { subject: null }),
    await other.sign(),
  ];
  for (const token of refused)
    expect(await verifier.verify(token), token.slice(0, 20)).toEqual({ kind: "refused" });
  // Cut short, changed, or not a token at all.
  const good = await sign();
  const [head, body, signature] = good.split(".") as [string, string, string];
  const changed = Buffer.from(
    JSON.stringify({
      ...JSON.parse(Buffer.from(body, "base64url").toString()),
      bid: "book_9999999999",
    }),
  ).toString("base64url");
  for (const bad of [
    `${good}x`,
    `${head}.${changed}.${signature}`,
    `${head}.${body}`,
    "not-a-token",
    "",
    "a.b.c",
  ])
    expect(await verifier.verify(bad), bad.slice(0, 20)).toEqual({ kind: "refused" });
});

test("only the one algorithm is taken: a token signed another way, with a key the attacker chose, is refused", async () => {
  const { jwk } = await signer();
  const verifier = memberTokenVerifier({
    origin: ORIGIN,
    keys: createLocalJWKSet({ keys: [jwk] }),
    clock: () => NOW,
  });
  const secret = new TextEncoder().encode("a-shared-secret-that-the-attacker-picked-0123");
  const hs = await new SignJWT({ ...CLAIMS })
    .setProtectedHeader({ alg: "HS256", kid: "key-1" })
    .setIssuer(memberTokenIssuer(ORIGIN))
    .setAudience(MEMBER_TOKEN.audience)
    .setSubject("user_0000000001")
    .setExpirationTime(Math.floor(NOW.getTime() / 1000) + 600)
    .sign(secret);
  expect(await verifier.verify(hs)).toEqual({ kind: "refused" });
  // `alg: none`, hand-made.
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      ...CLAIMS,
      sub: "user_0000000001",
      iss: memberTokenIssuer(ORIGIN),
      aud: MEMBER_TOKEN.audience,
      exp: Math.floor(NOW.getTime() / 1000) + 600,
    }),
  ).toString("base64url");
  expect(await verifier.verify(`${header}.${body}.`)).toEqual({ kind: "refused" });
  expect(await verifier.verify(`${header}.${body}.AAAAAAAAAA`)).toEqual({ kind: "refused" });
});

test("when the keys cannot be read the answer is that nothing is known, not that the token is bad", async () => {
  const unreadable = (error: unknown) =>
    memberTokenVerifier({
      origin: ORIGIN,
      keys: (async () => {
        throw error;
      }) as never,
      clock: () => NOW,
    });
  const { sign } = await signer();
  const token = await sign();
  expect(await unreadable(new errors.JWKSTimeout()).verify(token)).toEqual({ kind: "unavailable" });
  expect(await unreadable(new TypeError("fetch failed")).verify(token)).toEqual({
    kind: "unavailable",
  });
  // A key that is not in the list is the token's fault, and says nothing of the control plane.
  expect(await unreadable(new errors.JWKSNoMatchingKey()).verify(token)).toEqual({
    kind: "refused",
  });
});

test("a bearer is taken for a possible token only when it has the shape of one", () => {
  expect(looksLikeMemberToken("aaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc")).toBe(true);
  expect(looksLikeMemberToken("eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJl")).toBe(true);
  for (const other of [
    "",
    `rso_${"A".repeat(43)}`,
    `rst_0123456789abcdef_${"A".repeat(43)}`,
    `rsv_${"A".repeat(43)}`,
    "a.b.c",
    "aaaaaaaaaa.bbbbbbbbbbbb",
    "aaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc.dddddddddddd",
    "x".repeat(5000),
    "aaaaaaaaaa.bbbbbbbbbbbb.cccc cccccccc",
  ])
    expect(looksLikeMemberToken(other), other.slice(0, 20)).toBe(false);
});

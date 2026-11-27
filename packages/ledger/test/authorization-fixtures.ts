import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { BookAuthorizer, BOOK_ACCESS_TOKEN_TYPE } from "../src/book-authorization.ts";

export async function authorizationFixture(nowMilliseconds = 1800000000000) {
  const keys = await generateKeyPair("ES256", { extractable: true });
  const publicKeys = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "key-1", use: "sig", alg: "ES256" }],
  };
  const clock = { now: nowMilliseconds };
  const configuration = {
    issuer: "https://identity.rastrata.test",
    audience: "rastrata-ledger-test",
    publicKeys,
  };
  const authorizer = new BookAuthorizer(configuration, () => clock.now);
  const scope = {
    tenantId: "tenant-A",
    bookId: "ledger-test-book",
    namespaceId: "ledger-test",
    generation: "0",
    objectId: "object-A",
  };
  const token = async (
    claims: Record<string, unknown> = {},
    header: Record<string, unknown> = {},
  ) => {
    const now = Math.floor(clock.now / 1000);
    return `Bearer ${await new SignJWT({
      scope,
      authorizationRevision: "0",
      writerFence: "0",
      permissions: ["read", "execute", "provision", "maintain"],
      iss: configuration.issuer,
      aud: configuration.audience,
      sub: "actor",
      iat: now,
      nbf: now,
      exp: now + 300,
      ...claims,
    })
      .setProtectedHeader({ alg: "ES256", typ: BOOK_ACCESS_TOKEN_TYPE, kid: "key-1", ...header })
      .sign(keys.privateKey)}`;
  };
  return { keys, publicKeys, configuration, clock, authorizer, scope, token };
}

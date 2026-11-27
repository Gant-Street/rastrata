import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueOwnerKey } from "@rastrata/application/agent";
import { APPLICATION_API_VERSION } from "@rastrata/application/schema";
import { startLocalApplicationServer } from "../src/server.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const work of cleanup.splice(0)) await work();
});

const setup = {
  name: "Access Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Cash", role: "asset" },
    { code: "3000", name: "Capital", role: "equity" },
  ],
};

async function runtime(ownerKey?: string) {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-api-access-"));
  const started = await startLocalApplicationServer({
    path: join(directory, "book.sqlite"),
    port: 0,
    ...(ownerKey ? { ownerKey } : {}),
  });
  cleanup.push(async () => {
    await started.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${started.server.port}`;
  const call = async (
    name: string,
    input: unknown,
    options: { credential?: string; operationId?: string } = {},
  ) => {
    const response = await fetch(`${base}/v1/${name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.credential ? { authorization: `Bearer ${options.credential}` } : {}),
      },
      body: JSON.stringify({
        version: APPLICATION_API_VERSION,
        bookId: "local-book",
        input,
        ...(options.operationId ? { operationId: options.operationId } : {}),
      }),
    });
    return { status: response.status, body: await response.json() };
  };
  const legacy = (credential?: string, path = "/api/book") =>
    fetch(`${base}${path}`, {
      headers: credential ? { authorization: `Bearer ${credential}` } : {},
    });
  return { base, call, legacy };
}

test("open by default: no credentials is the owner on /v1 and the browser routes, a token is scoped", async () => {
  const r = await runtime();
  expect((await r.call("book.setup", setup, { operationId: crypto.randomUUID() })).status).toBe(
    200,
  );
  const created = await r.call(
    "tokens.create",
    { label: "Agent", permissions: ["read", "draft"] },
    { operationId: crypto.randomUUID() },
  );
  expect(created.status).toBe(200);
  const secret = created.body.data.secret as string;
  // The owner's own flows are untouched.
  expect((await r.legacy()).status).toBe(200);
  expect((await r.call("book.get", {})).body.data.principal).toEqual({ kind: "owner" });
  expect((await r.call("book.get", {})).body.data.ownerAccess).toBe("open");
  // The token works on /v1 with its own permissions ...
  const asToken = await r.call("book.get", {}, { credential: secret });
  expect(asToken.body.data.permissions).toEqual(["read", "draft"]);
  expect((await r.call("tokens.list", {}, { credential: secret })).body.error.code).toBe(
    "permission_denied",
  );
  // ... and is refused on the browser compatibility routes, whatever route it asks for.
  for (const path of [
    "/api/book",
    "/api/accounts",
    "/api/journal",
    "/api/periods",
    "/api/drafts",
  ]) {
    const response = await r.legacy(secret, path);
    expect(response.status, path).toBe(403);
    expect((await response.json()).code).toBe("token_scope_denied");
  }
  const postDraft = await fetch(`${r.base}/api/drafts`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ data: {} }),
  });
  expect(postDraft.status).toBe(403);
  // A bad credential is refused on both, even though an open service would admit no credential.
  expect((await r.call("book.get", {}, { credential: "junk" })).status).toBe(401);
  expect((await r.legacy("junk")).status).toBe(401);
  expect((await fetch(`${r.base}/health`)).status).toBe(200);
});

test("the owner lock covers /v1, the schema and the browser routes; health stays a liveness probe", async () => {
  const key = issueOwnerKey();
  const r = await runtime(key);
  expect((await fetch(`${r.base}/health`)).status).toBe(200);
  const bare = await r.call("book.get", {});
  expect(bare.status).toBe(401);
  expect(bare.body.error.code).toBe("authentication_required");
  expect((await r.legacy()).status).toBe(401);
  expect((await fetch(`${r.base}/v1/schema`)).status).toBe(401);
  expect((await r.call("book.get", {}, { credential: key })).status).toBe(200);
  expect((await r.legacy(key)).status).toBe(200);
  expect(
    (await fetch(`${r.base}/v1/schema`, { headers: { authorization: `Bearer ${key}` } })).status,
  ).toBe(200);
  // Setting up and issuing tokens work with the key; the token then works without it.
  expect(
    (await r.call("book.setup", setup, { credential: key, operationId: crypto.randomUUID() }))
      .status,
  ).toBe(200);
  const created = await r.call(
    "tokens.create",
    { label: "Agent", permissions: ["read"] },
    { credential: key, operationId: crypto.randomUUID() },
  );
  const secret = created.body.data.secret as string;
  const context = await r.call("book.get", {}, { credential: secret });
  expect(context.body.data).toMatchObject({
    principal: { kind: "token" },
    ownerAccess: "key",
    permissions: ["read"],
  });
  // Origin checks still apply on top: a browser page elsewhere cannot use a credential it holds.
  const crossOrigin = await fetch(`${r.base}/v1/book.get`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://example.com",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ version: APPLICATION_API_VERSION, bookId: "local-book", input: {} }),
  });
  expect(crossOrigin.status).toBe(403);
});

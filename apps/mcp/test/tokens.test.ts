import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueOwnerKey } from "@rastrata/application/agent";
import { ApplicationHttp } from "@rastrata/application/http";
import { LocalBookService } from "@rastrata/application/local";
import {
  APPLICATION_API_VERSION,
  BUSINESS_PERMISSIONS,
  type BusinessPermission,
} from "@rastrata/application/schema";
import { startLocalMcpServer } from "../src/server.ts";

// biome-ignore lint/suspicious/noExplicitAny: the tests read arbitrary JSON replies
type Loose = any;

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const work of cleanup.splice(0)) await work();
});

const setup = {
  name: "Token Fixture Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Cash", role: "asset" },
    { code: "3000", name: "Capital", role: "equity" },
  ],
};
const opening = {
  date: "2026-01-15",
  reference: "OPEN",
  narration: "Owner contribution",
  lines: [
    { accountId: "1000", debit: "1000.00", credit: "" },
    { accountId: "3000", debit: "", credit: "1000.00" },
  ],
};

async function fixture(options: { ownerKey?: string; mcpOwnerKey?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-mcp-tokens-"));
  const service = await LocalBookService.open(join(directory, "book.sqlite"));
  const application = new ApplicationHttp(
    service,
    { bookId: service.bookId, permissions: BUSINESS_PERMISSIONS },
    options.ownerKey ? { ownerKey: options.ownerKey } : {},
  );
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => application.fetch(request),
  });
  const mcp = await startLocalMcpServer({
    apiUrl: `http://127.0.0.1:${api.port}`,
    bookId: "local-book",
    permissions: ["read", "draft"],
    port: 0,
    ...(options.mcpOwnerKey ? { ownerKey: options.mcpOwnerKey } : {}),
    callerCacheMs: 0,
  });
  cleanup.push(async () => {
    await mcp.stop();
    await api.stop(true);
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const upstream = async (
    name: string,
    input: unknown,
    credential?: string,
    operationId?: string,
  ) => {
    const response = await fetch(`http://127.0.0.1:${api.port}/v1/${name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      },
      body: JSON.stringify({
        version: APPLICATION_API_VERSION,
        bookId: "local-book",
        input,
        ...(operationId ? { operationId } : {}),
      }),
    });
    return { status: response.status, body: (await response.json()) as Loose };
  };
  let rpcId = 0;
  const rpc = async (method: string, params: unknown, authorization?: string) => {
    const response = await fetch(new URL("/mcp", mcp.server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
        ...(authorization !== undefined ? { authorization } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      text,
      body: text ? (JSON.parse(text) as Loose) : {},
    };
  };
  const tools = async (authorization?: string) =>
    ((await rpc("tools/list", {}, authorization)).body.result?.tools ?? []).map(
      (tool: { name: string }) => tool.name,
    ) as string[];
  const callTool = async (name: string, args: unknown, authorization?: string) => {
    const reply = await rpc("tools/call", { name, arguments: args }, authorization);
    const result = reply.body.result as { isError?: boolean; content?: { text: string }[] };
    return {
      status: reply.status,
      error: Boolean(result?.isError),
      envelope: result?.content?.[0] ? (JSON.parse(result.content[0].text) as Loose) : {},
      text: reply.text,
    };
  };
  const token = async (permissions: readonly BusinessPermission[], ownerCredential?: string) => {
    const created = await upstream(
      "tokens.create",
      { label: `Agent ${permissions.join("+")}`, permissions },
      ownerCredential,
      crypto.randomUUID(),
    );
    expect(created.body.ok, JSON.stringify(created.body)).toBe(true);
    return created.body.data.secret as string;
  };
  return { service, upstream, rpc, tools, callTool, token };
}

const bearer = (token: string) => `Bearer ${token}`;

test("a connection with no credentials keeps the operator's grants, exactly as before", async () => {
  const f = await fixture();
  await f.upstream("book.setup", setup, undefined, crypto.randomUUID());
  const names = await f.tools();
  expect(names).toContain("rastrata_create_draft");
  expect(names).not.toContain("rastrata_prepare_journal");
  expect(names).not.toContain("rastrata_commit_operation");
});

test("a token connection gets that token's permissions from the API, not the operator's", async () => {
  const f = await fixture();
  await f.upstream("book.setup", setup, undefined, crypto.randomUUID());
  const readOnly = await f.token(["read"]);
  const bookkeeper = await f.token(["read", "draft", "post"]);
  const readerTools = await f.tools(bearer(readOnly));
  expect(readerTools).toContain("rastrata_get_book");
  expect(readerTools).not.toContain("rastrata_create_draft");
  const posterTools = await f.tools(bearer(bookkeeper));
  // The operator's own grants were read and draft; this token also holds post, so it can commit.
  expect(posterTools).toEqual(
    expect.arrayContaining([
      "rastrata_create_draft",
      "rastrata_prepare_journal",
      "rastrata_commit_operation",
    ]),
  );
  expect(posterTools).not.toContain("rastrata_setup_book");
  expect(posterTools).not.toContain("rastrata_prepare_account");
  // Token management is never a tool, whatever the connection holds.
  for (const list of [readerTools, posterTools])
    expect(list.filter((name) => /token/.test(name))).toEqual([]);
  const book = await f.callTool("rastrata_get_book", {}, bearer(bookkeeper));
  expect(book.envelope.data.permissions).toEqual(["read", "draft", "post"]);
  expect(book.envelope.data.principal).toMatchObject({ kind: "token" });
});

test("a token connection runs the whole review gate: draft, prepare, commit, all as the token", async () => {
  const f = await fixture();
  await f.upstream("book.setup", setup, undefined, crypto.randomUUID());
  const secret = await f.token(["read", "draft", "post"]);
  const authorization = bearer(secret);
  const draft = await f.callTool(
    "rastrata_create_draft",
    { operationId: crypto.randomUUID(), data: opening },
    authorization,
  );
  expect(draft.error, JSON.stringify(draft.envelope)).toBe(false);
  const planId = crypto.randomUUID();
  const plan = await f.callTool(
    "rastrata_prepare_journal",
    {
      operationId: planId,
      draftId: draft.envelope.data.id,
      expectedVersion: draft.envelope.data.version,
    },
    authorization,
  );
  expect(plan.envelope.data.valid).toBe(true);
  const commit = await f.callTool(
    "rastrata_commit_operation",
    { planId, planHash: plan.envelope.data.planHash },
    authorization,
  );
  expect(commit.envelope.data.disposition).toBe("committed");
  // Everything the token did is on its trail, and nothing the secret said is.
  const trail = await f.upstream("tokens.activity", {});
  const operations = trail.body.data.events.map((event: { operation: string }) => event.operation);
  expect(operations).toEqual(
    expect.arrayContaining(["drafts.create", "journal.prepare", "operations.commit"]),
  );
  expect(JSON.stringify(trail.body)).not.toContain(secret);
});

test("a token without a permission is refused by the API even if its tool is called by name", async () => {
  const f = await fixture();
  await f.upstream("book.setup", setup, undefined, crypto.randomUUID());
  const reader = bearer(await f.token(["read"]));
  const attempt = await f.callTool(
    "rastrata_create_draft",
    { operationId: crypto.randomUUID(), data: opening },
    reader,
  );
  expect(attempt.error).toBe(true);
  expect(attempt.envelope.error.code).toBe("permission_denied");
  const drafts = await f.upstream("drafts.list", {});
  expect(drafts.body.data.count).toBe(0);
});

test("refused credentials are a 401 and never fall back to the operator's grants", async () => {
  const f = await fixture();
  await f.upstream("book.setup", setup, undefined, crypto.randomUUID());
  const secret = await f.token(["read", "draft"]);
  const id = secret.slice(4, 20);
  for (const authorization of [
    `Bearer rst_${id}_${"A".repeat(43)}`,
    `Bearer rst_${"0".repeat(16)}_${secret.slice(21)}`,
    // What `Bearer ${RASTRATA_TOKEN}` becomes when the variable is empty (HTTP trims the space).
    "Bearer ",
    "Bearer",
    "Basic dXNlcjpwYXNz",
    `Bearer ${secret} ${secret}`,
    secret,
  ]) {
    const reply = await f.rpc("tools/list", {}, authorization);
    expect(reply.status, JSON.stringify(authorization)).toBe(401);
    expect(reply.headers.get("www-authenticate")).toBe('Bearer realm="rastrata"');
    expect(reply.text).not.toContain(secret);
    expect(reply.body.result).toBeUndefined();
    expect(reply.body.error.message).toContain("token_invalid");
  }
});

test("a revoked token stops working through MCP at once, for listing and for calls", async () => {
  const f = await fixture();
  await f.upstream("book.setup", setup, undefined, crypto.randomUUID());
  const secret = await f.token(["read", "draft"]);
  const authorization = bearer(secret);
  expect((await f.tools(authorization)).length).toBeGreaterThan(0);
  const revoked = await f.upstream(
    "tokens.revoke",
    { tokenId: secret.slice(4, 20) },
    undefined,
    crypto.randomUUID(),
  );
  expect(revoked.body.ok).toBe(true);
  const reply = await f.rpc("tools/list", {}, authorization);
  expect(reply.status).toBe(401);
  expect(reply.body.error.message).toContain("token_revoked");
  const call = await f.rpc(
    "tools/call",
    { name: "rastrata_get_book", arguments: {} },
    authorization,
  );
  expect(call.status).toBe(401);
});

test("an owner lock on the API: tokens still work, the operator's own connection needs the owner key", async () => {
  const ownerKey = issueOwnerKey();
  const locked = await fixture({ ownerKey });
  expect((await locked.upstream("book.setup", setup, ownerKey, crypto.randomUUID())).body.ok).toBe(
    true,
  );
  const secret = await locked.token(["read", "draft"], ownerKey);
  // A token connection works without the MCP process holding any key.
  expect(await locked.tools(bearer(secret))).toContain("rastrata_create_draft");
  const asToken = await locked.callTool("rastrata_get_book", {}, bearer(secret));
  expect(asToken.envelope.data.ownerAccess).toBe("key");
  // A connection with no credentials reaches the API as nobody, and is told why.
  const anonymous = await locked.callTool("rastrata_get_book", {});
  expect(anonymous.error).toBe(true);
  expect(anonymous.envelope.error.code).toBe("authentication_required");

  const keyed = await fixture({ ownerKey, mcpOwnerKey: ownerKey });
  await keyed.upstream("book.setup", setup, ownerKey, crypto.randomUUID());
  const asOperator = await keyed.callTool("rastrata_get_book", {});
  expect(asOperator.error).toBe(false);
  expect(asOperator.envelope.data.principal).toEqual({ kind: "owner" });
  // The key is used upstream and never comes back out.
  expect(asOperator.text).not.toContain(ownerKey);
});

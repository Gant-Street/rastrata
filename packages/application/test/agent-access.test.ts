import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueOwnerKey, issueToken } from "../src/agent/token.ts";
import { ApplicationHttp } from "../src/http.ts";
import { LocalBookService } from "../src/local.ts";
import {
  APPLICATION_API_VERSION,
  BUSINESS_PERMISSIONS,
  operationCatalog,
  permitsOperation,
  type BusinessPermission,
} from "../src/schema.ts";

const book = {
  name: "Agent Access Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Cash", role: "asset" },
    { code: "3000", name: "Capital", role: "equity" },
    { code: "4000", name: "Sales", role: "income" },
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
const START = new Date("2026-10-03T12:00:00.000Z");
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-agent-access-"));
  const path = join(directory, "book.sqlite");
  const service = await LocalBookService.open(path);
  let now = START;
  const clock = () => now;
  const open = new ApplicationHttp(
    service,
    { bookId: service.bookId, permissions: BUSINESS_PERMISSIONS },
    { clock },
  );
  cleanup.push(() => {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function send(
    target: ApplicationHttp,
    name: string,
    input: unknown,
    options: { operationId?: string; credential?: string; headers?: Record<string, string> } = {},
  ) {
    const response = await target.fetch(
      new Request(`http://127.0.0.1:4010/v1/${name}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.credential ? { authorization: `Bearer ${options.credential}` } : {}),
          ...options.headers,
        },
        body: JSON.stringify({
          version: APPLICATION_API_VERSION,
          bookId: "local-book",
          input,
          ...(options.operationId ? { operationId: options.operationId } : {}),
        }),
      }),
    );
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: JSON.parse(text), text };
  }
  const f = {
    service,
    path,
    open,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    get now() {
      return now;
    },
    /** A request with no credentials: the owner, in the open development mode. */
    owner: (name: string, input: unknown = {}, operationId?: string) =>
      send(open, name, input, operationId ? { operationId } : {}),
    as: (credential: string, name: string, input: unknown = {}, operationId?: string) =>
      send(open, name, input, { credential, ...(operationId ? { operationId } : {}) }),
    send,
    http(options: { ownerKey?: string; permissions?: readonly BusinessPermission[] } = {}) {
      return new ApplicationHttp(
        service,
        { bookId: service.bookId, permissions: options.permissions ?? BUSINESS_PERMISSIONS },
        { ...(options.ownerKey ? { ownerKey: options.ownerKey } : {}), clock },
      );
    },
    async setup() {
      const result = await f.owner("book.setup", book, crypto.randomUUID());
      expect(result.body.ok).toBe(true);
    },
    /** Create a token as the owner and return its bearer string. */
    async token(
      permissions: readonly string[],
      label = "Test agent",
      expiresInDays?: number,
    ): Promise<string> {
      const result = await f.owner(
        "tokens.create",
        { label, permissions, ...(expiresInDays ? { expiresInDays } : {}) },
        crypto.randomUUID(),
      );
      expect(result.body.ok, result.text).toBe(true);
      return result.body.data.secret as string;
    },
  };
  return f;
}

/** `rst_<id>_<secret>`: the secret itself may contain `_`, so cut by position, never by splitting. */
const idOf = (token: string) => token.slice(4, 20);
const secretOf = (token: string) => token.slice(21);

test("the owner creates a token: shown once, listed without its secret, replayed without it", async () => {
  const f = await fixture();
  await f.setup();
  const operationId = crypto.randomUUID();
  const input = { label: "Claude Code", permissions: ["read", "draft"] };
  const created = await f.owner("tokens.create", input, operationId);
  expect(created.status).toBe(200);
  const { token, secret } = created.body.data;
  expect(secret).toMatch(/^rst_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
  expect(token).toMatchObject({
    prefix: `rst_${idOf(secret)}`,
    label: "Claude Code",
    permissions: ["read", "draft"],
    status: "active",
    createdBy: "owner",
    createdAt: START.toISOString(),
    // Never open-ended: ninety days unless the owner picks otherwise.
    expiresAt: "2027-01-01T12:00:00.000Z",
    revokedAt: null,
    lastUsedAt: null,
  });
  expect(secret.startsWith(token.prefix)).toBe(true);
  // A retry is the same operation: no second token, and the secret is not shown again.
  const replay = await f.owner("tokens.create", input, operationId);
  expect(replay.body.data).toEqual({ token, secret: null });
  const list = await f.owner("tokens.list");
  expect(list.body.data.tokens).toEqual([token]);
  expect(list.text).not.toContain(secret);
  expect(list.text).not.toContain(secretOf(secret));
  expect(Object.keys(list.body.data.tokens[0])).not.toContain("secret");
  expect(Object.keys(list.body.data.tokens[0])).not.toContain("secretHash");
  expect(list.body.data).toMatchObject({
    grantable: ["read", "draft", "post", "configure", "correct", "close"],
    defaultExpiryDays: 90,
    maxExpiryDays: 365,
    ownerAccess: "open",
  });
  // The same identity for different input is a conflict, never a second token.
  const conflict = await f.owner(
    "tokens.create",
    { ...input, permissions: ["read", "post"] },
    operationId,
  );
  expect(conflict.status).toBe(409);
  expect(conflict.body.error.code).toBe("operation_identity_conflict");
  expect((await f.owner("tokens.list")).body.data.tokens).toHaveLength(1);
});

test("a token's secret is stored nowhere: not in a table, not in a retained response, not on disk", async () => {
  const f = await fixture();
  await f.setup();
  const secret = await f.token(["read", "draft"]);
  const tail = secretOf(secret);
  // Use it so any logging or retention on the request path would have had its chance.
  expect((await f.as(secret, "book.get")).status).toBe(200);
  const rows = f.service.store.query("SELECT secret_hash FROM agent_tokens").all() as {
    secret_hash: string;
  }[];
  expect(rows).toHaveLength(1);
  expect(rows[0]?.secret_hash).toMatch(/^[0-9a-f]{64}$/);
  for (const table of ["agent_tokens", "agent_activity", "app_requests", "app_actions"]) {
    const dump = JSON.stringify(f.service.store.query(`SELECT * FROM ${table}`).all());
    expect(dump, table).not.toContain(tail);
  }
  for (const file of [f.path, `${f.path}-wal`, `${f.path}-shm`]) {
    if (!existsSync(file)) continue;
    const bytes = Buffer.from(readFileSync(file));
    expect(bytes.includes(tail), file).toBe(false);
    expect(bytes.includes(secret), file).toBe(false);
  }
});

test("nothing a client can see ever includes a presented credential, accepted or not", async () => {
  const f = await fixture();
  await f.setup();
  const secret = await f.token(["read"]);
  const logged: string[] = [];
  const original = console.error;
  const originalInfo = console.info;
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.error =
    console.info =
    console.log =
    console.warn =
      (...parts: unknown[]) => {
        logged.push(parts.map(String).join(" "));
      };
  try {
    const wrong = `rst_${idOf(secret)}_${"A".repeat(43)}`;
    const unknown = `rst_${"0".repeat(16)}_${"B".repeat(43)}`;
    for (const credential of [secret, wrong, unknown, "not-a-token", `x${secret}`]) {
      const reply = await f.as(credential, "book.get");
      expect(reply.text).not.toContain(credential);
      expect(reply.text).not.toContain(secretOf(credential).slice(0, 12) || "-----");
      for (const [, value] of reply.headers) expect(value).not.toContain(credential);
    }
  } finally {
    console.error = original;
    console.info = originalInfo;
    console.log = originalLog;
    console.warn = originalWarn;
  }
  expect(logged.join("\n")).not.toContain(secret);
  expect(logged.join("\n")).not.toContain(secretOf(secret));
});

test("a token holds exactly its permissions and is told what it holds when it asks for more", async () => {
  const f = await fixture();
  await f.setup();
  const secret = await f.token(["read", "draft"], "Drafting agent");
  const context = await f.as(secret, "book.get");
  expect(context.body.data.permissions).toEqual(["read", "draft"]);
  expect(context.body.data.principal).toMatchObject({
    kind: "token",
    tokenId: idOf(secret),
    label: "Drafting agent",
    expiresAt: "2027-01-01T12:00:00.000Z",
  });
  expect(context.body.data.ownerAccess).toBe("open");
  // The owner is told it is the owner, and that the service is open.
  const ownerContext = await f.owner("book.get");
  expect(ownerContext.body.data.principal).toEqual({ kind: "owner" });
  expect(ownerContext.body.data.permissions).toEqual([...BUSINESS_PERMISSIONS]);
  const draft = await f.as(secret, "drafts.create", { data: opening }, crypto.randomUUID());
  expect(draft.status).toBe(200);
  const denied = await f.as(
    secret,
    "journal.prepare",
    { draftId: draft.body.data.id, expectedVersion: 1 },
    crypto.randomUUID(),
  );
  expect(denied.status).toBe(403);
  expect(denied.body.error.code).toBe("permission_denied");
  expect(denied.body.error.message).toBe(
    "This operation requires post permission; this token grants read, draft",
  );
  // Capabilities list only what this caller may call.
  const capabilities = await f.as(secret, "capabilities.get");
  const names = capabilities.body.data.operations.map((item: { name: string }) => item.name);
  expect(names).toContain("drafts.create");
  expect(names).not.toContain("journal.prepare");
  expect(names).not.toContain("tokens.create");
  expect(names).not.toContain("operations.commit");
  expect(capabilities.body.data.permissions).toEqual(["read", "draft"]);
  const ownerNames = (await f.owner("capabilities.get")).body.data.operations.map(
    (item: { name: string }) => item.name,
  );
  expect(ownerNames).toEqual(operationCatalog.map((item) => item.name));
});

test("an agent can never escalate: not by tokens, setup, body fields, query strings or the browser routes", async () => {
  const f = await fixture();
  await f.setup();
  // Even a token holding every permission a token can hold has no provision.
  const everything = await f.token(["read", "draft", "post", "configure", "correct", "close"]);
  for (const name of [
    "tokens.create",
    "tokens.list",
    "tokens.revoke",
    "tokens.activity",
    "book.setup",
  ]) {
    const reply = await f.as(everything, name, {}, crypto.randomUUID());
    expect(reply.status, name).toBe(403);
    expect(reply.body.error.code, name).toBe("permission_denied");
  }
  // It cannot mint a token with the real input either, nor revoke another or itself.
  const mint = await f.as(
    everything,
    "tokens.create",
    { label: "Mine", permissions: ["read"] },
    crypto.randomUUID(),
  );
  expect(mint.status).toBe(403);
  const revoke = await f.as(
    everything,
    "tokens.revoke",
    { tokenId: idOf(everything) },
    crypto.randomUUID(),
  );
  expect(revoke.status).toBe(403);
  expect((await f.as(everything, "book.get")).status).toBe(200);
  expect((await f.owner("tokens.list")).body.data.tokens).toHaveLength(1);
  // Request bodies cannot choose a principal, permissions or another book.
  for (const extra of [
    { permissions: ["provision"] },
    { actorId: "local-operator" },
    { principal: { kind: "owner" } },
    { access: "owner" },
  ]) {
    const response = await f.http().fetch(
      new Request("http://127.0.0.1:4010/v1/book.get", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${everything}` },
        body: JSON.stringify({
          version: APPLICATION_API_VERSION,
          bookId: "local-book",
          input: {},
          ...extra,
        }),
      }),
    );
    expect(response.status, JSON.stringify(extra)).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_input");
  }
  const input = await f.as(everything, "book.get", { permissions: ["provision"] });
  expect(input.status).toBe(400);
  const otherBook = await f.http().fetch(
    new Request("http://127.0.0.1:4010/v1/book.get", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${everything}` },
      body: JSON.stringify({ version: APPLICATION_API_VERSION, bookId: "another", input: {} }),
    }),
  );
  expect(otherBook.status).toBe(403);
  // A credential in the query string is never read, so it never authenticates.
  const query = await f.http().fetch(
    new Request(`http://127.0.0.1:4010/v1/book.get?token=${everything}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: APPLICATION_API_VERSION, bookId: "local-book", input: {} }),
    }),
  );
  expect(query.status).toBe(404);
  // A token is refused on the browser compatibility routes, which predate scoped access.
  const guard = f.http();
  const legacy = (credential?: string) =>
    guard.guardLegacy(
      new Request("http://127.0.0.1:4010/api/journal", {
        headers: credential ? { authorization: `Bearer ${credential}` } : {},
      }),
    );
  expect(await legacy()).toBeNull();
  const refused = await legacy(everything);
  expect(refused?.status).toBe(403);
  expect(await refused?.json()).toMatchObject({ code: "token_scope_denied" });
  expect((await legacy("junk"))?.status).toBe(401);
});

test("a token cannot be created with provision, nor with more than its creator holds", async () => {
  const f = await fixture();
  await f.setup();
  const provision = await f.owner(
    "tokens.create",
    { label: "Sneaky", permissions: ["read", "provision"] },
    crypto.randomUUID(),
  );
  expect(provision.status).toBe(400);
  expect(provision.body.error.code).toBe("invalid_input");
  // The schema refuses it before any handler runs; the handler refuses it too.
  const unknown = await f.owner(
    "tokens.create",
    { label: "Odd", permissions: ["read", "root"] },
    crypto.randomUUID(),
  );
  expect(unknown.status).toBe(400);
  const noRead = await f.owner(
    "tokens.create",
    { label: "Blind", permissions: ["draft"] },
    crypto.randomUUID(),
  );
  expect(noRead.status).toBe(400);
  expect(noRead.body.error.message).toContain("needs read");
  // A runtime that holds provision but not post cannot hand post out.
  const limited = f.http({ permissions: ["read", "provision"] });
  const widened = await f.send(
    limited,
    "tokens.create",
    { label: "Wider", permissions: ["read", "post"] },
    { operationId: crypto.randomUUID() },
  );
  expect(widened.status).toBe(403);
  expect(widened.body.error.code).toBe("permission_not_held");
  const narrower = await f.send(
    limited,
    "tokens.create",
    { label: "Narrow", permissions: ["read"] },
    { operationId: crypto.randomUUID() },
  );
  expect(narrower.status).toBe(200);
  // And a token made by a narrower runtime never exceeds that runtime's own access.
  const secret = narrower.body.data.secret as string;
  const viaOwner = await f.as(secret, "book.get");
  expect(viaOwner.body.data.permissions).toEqual(["read"]);
  const clamped = new ApplicationHttp(
    f.service,
    { bookId: "local-book", permissions: ["read"] },
    { clock: () => f.now },
  );
  const wide = await f.token(["read", "draft", "post"]);
  const intersection = await f.send(clamped, "book.get", {}, { credential: wide });
  expect(intersection.body.data.permissions).toEqual(["read"]);
});

test("revoked, expired, wrong and malformed credentials are 401 and never fall back to the owner", async () => {
  const f = await fixture();
  await f.setup();
  const secret = await f.token(["read", "draft"], "Short lived", 7);
  const id = idOf(secret);
  expect((await f.as(secret, "book.get")).status).toBe(200);
  const present = [
    ["a wrong secret", `rst_${id}_${"A".repeat(43)}`, "token_invalid"],
    ["an unknown id", `rst_${"f".repeat(16)}_${secretOf(secret)}`, "token_invalid"],
    ["a truncated token", secret.slice(0, -1), "token_invalid"],
    ["an owner key when none is set", issueOwnerKey(), "token_invalid"],
    ["garbage", "not a credential", "token_invalid"],
  ] as const;
  for (const [what, credential, code] of present) {
    const reply = await f.as(credential, "book.get");
    expect(reply.status, what).toBe(401);
    expect(reply.body.error.code, what).toBe(code);
    expect(reply.headers.get("www-authenticate")).toBe('Bearer realm="rastrata"');
    // The open service would have let a header-less caller in; a bad credential gets nothing.
    expect(reply.body.ok).toBe(false);
  }
  for (const header of ["Basic dXNlcjpwYXNz", "Bearer", `Bearer ${secret} ${secret}`, secret]) {
    const reply = await f.send(f.open, "book.get", {}, { headers: { authorization: header } });
    expect(reply.status, header).toBe(401);
  }
  // Expiry: still valid a second before, expired at the instant.
  f.advance(7 * 86_400_000 - 1000);
  expect((await f.as(secret, "book.get")).status).toBe(200);
  f.advance(1000);
  const expired = await f.as(secret, "book.get");
  expect(expired.status).toBe(401);
  expect(expired.body.error.code).toBe("token_expired");
  expect((await f.owner("tokens.list")).body.data.tokens[0].status).toBe("expired");
  // Revocation is immediate and permanent.
  const fresh = await f.token(["read"], "To revoke");
  expect((await f.as(fresh, "book.get")).status).toBe(200);
  const revoked = await f.owner(
    "tokens.revoke",
    { tokenId: idOf(fresh), reason: "Laptop lost" },
    crypto.randomUUID(),
  );
  expect(revoked.body.data).toMatchObject({
    status: "revoked",
    revokedReason: "Laptop lost",
    revokedAt: f.now.toISOString(),
  });
  const after = await f.as(fresh, "book.get");
  expect(after.status).toBe(401);
  expect(after.body.error.code).toBe("token_revoked");
  // Revoking twice changes nothing, including when the second asks for a different reason.
  f.advance(60_000);
  const again = await f.owner(
    "tokens.revoke",
    { tokenId: idOf(fresh), reason: "Changed my mind" },
    crypto.randomUUID(),
  );
  expect(again.body.data.revokedReason).toBe("Laptop lost");
  expect(again.body.data.revokedAt).toBe(revoked.body.data.revokedAt);
  const missing = await f.owner(
    "tokens.revoke",
    { tokenId: "feedfacefeedface" },
    crypto.randomUUID(),
  );
  expect(missing.status).toBe(404);
  expect(missing.body.error.code).toBe("token_not_found");
  // The active filter hides what no longer works.
  const active = await f.owner("tokens.list", { active: true });
  expect(active.body.data.tokens).toEqual([]);
  const all = await f.owner("tokens.list");
  expect(all.body.data.tokens.map((token: { status: string }) => token.status).sort()).toEqual([
    "expired",
    "revoked",
  ]);
});

test("the owner lock: header-less requests are refused, the key and tokens still work", async () => {
  const f = await fixture();
  await f.setup();
  const key = issueOwnerKey();
  const locked = f.http({ ownerKey: key });
  const secret = await f.token(["read", "draft"]);
  const bare = await f.send(locked, "book.get", {});
  expect(bare.status).toBe(401);
  expect(bare.body.error.code).toBe("authentication_required");
  expect(bare.headers.get("www-authenticate")).toBe('Bearer realm="rastrata"');
  const asOwner = await f.send(locked, "book.get", {}, { credential: key });
  expect(asOwner.status).toBe(200);
  expect(asOwner.body.data).toMatchObject({ principal: { kind: "owner" }, ownerAccess: "key" });
  expect(asOwner.body.data.permissions).toEqual([...BUSINESS_PERMISSIONS]);
  expect((await f.send(locked, "tokens.list", {}, { credential: key })).body.data.ownerAccess).toBe(
    "key",
  );
  const wrongKey = await f.send(locked, "book.get", {}, { credential: issueOwnerKey() });
  expect(wrongKey.status).toBe(401);
  expect(wrongKey.body.error.code).toBe("token_invalid");
  const viaToken = await f.send(locked, "book.get", {}, { credential: secret });
  expect(viaToken.status).toBe(200);
  expect(viaToken.body.data.principal.kind).toBe("token");
  // The schema is behind the lock too.
  const schema = await locked.fetch(new Request("http://127.0.0.1:4010/v1/schema"));
  expect(schema.status).toBe(401);
  const schemaWithKey = await locked.fetch(
    new Request("http://127.0.0.1:4010/v1/schema", { headers: { authorization: `Bearer ${key}` } }),
  );
  expect(schemaWithKey.status).toBe(200);
  // The browser routes are locked as well, for the owner and not for an agent.
  const guard = (credential?: string) =>
    locked.guardLegacy(
      new Request("http://127.0.0.1:4010/api/book", {
        headers: credential ? { authorization: `Bearer ${credential}` } : {},
      }),
    );
  expect((await guard())?.status).toBe(401);
  expect(await guard(key)).toBeNull();
  expect((await guard(secret))?.status).toBe(403);
  // A weak or token-shaped key is refused when the service is configured, not accepted silently.
  for (const weak of ["weak", `rst_${"0".repeat(16)}_${"a".repeat(43)}`])
    expect(() => f.http({ ownerKey: weak }), weak).toThrow("owner key");
});

test("every operation is gated by its permission for every kind of token, before any input is read", async () => {
  const f = await fixture();
  await f.setup();
  const sets: (readonly string[])[] = [
    ["read"],
    ["read", "draft"],
    ["read", "post"],
    ["read", "configure"],
    ["read", "correct"],
    ["read", "close"],
    ["read", "draft", "post", "configure", "correct", "close"],
  ];
  for (const permissions of sets) {
    const secret = await f.token(permissions, permissions.join("+"));
    for (const operation of operationCatalog) {
      if (operation.name === "operations.commit") continue;
      // A null input is invalid for every operation, so nothing here ever runs: a request is
      // either refused for scope (403) or gets as far as input validation (400).
      const reply = await f.as(secret, operation.name, null, crypto.randomUUID());
      const allowed = permitsOperation(permissions as BusinessPermission[], operation);
      if (allowed) {
        expect(reply.status, `${permissions.join("+")} may call ${operation.name}`).toBe(400);
        expect(reply.body.error.code).toBe("invalid_input");
      } else {
        expect(reply.status, `${permissions.join("+")} may not call ${operation.name}`).toBe(403);
        expect(reply.body.error.code).toBe("permission_denied");
      }
    }
  }
  // No token reaches provision, so none reaches an operation that needs it.
  const provisionOperations = operationCatalog.filter((item) => item.permission === "provision");
  expect(provisionOperations.map((item) => item.name)).toEqual(
    expect.arrayContaining([
      "book.setup",
      "tokens.create",
      "tokens.list",
      "tokens.revoke",
      "tokens.activity",
    ]),
  );
});

test("committing is gated by the retained plan's kind: a post token cannot commit a chart or period change", async () => {
  const f = await fixture();
  await f.setup();
  const tokens = {
    "draft-only": await f.token(["read", "draft"], "drafter"),
    post: await f.token(["read", "post"], "poster"),
    configure: await f.token(["read", "configure"], "configurer"),
    close: await f.token(["read", "close"], "closer"),
  };
  // Each plan is prepared by the token that may prepare it, refused by every token whose
  // permission does not match the plan's retained kind, and only then committed by the right one.
  // (Plans are committed one at a time because a commit moves the book revision on.)
  const kinds = [
    {
      what: "a posting",
      needs: "post",
      name: "journal.prepare",
      input: async () => {
        const draft = await f.owner("drafts.create", { data: opening }, crypto.randomUUID());
        return { draftId: draft.body.data.id, expectedVersion: 1 };
      },
    },
    {
      what: "a chart change",
      needs: "configure",
      name: "accounts.prepareCreate",
      input: async () => ({
        code: "5000",
        name: "Supplies",
        role: "expense",
        // After the posting above: an account cannot start before activity already in the book.
        effectiveOn: (await f.owner("accounts.list")).body.data.suggestedEffectiveOn,
      }),
    },
    {
      what: "a period close",
      needs: "close",
      name: "periods.prepare",
      input: async () => ({
        periodId: "period-01",
        operation: "close",
        reason: "January reviewed",
      }),
    },
  ] as const;
  for (const kind of kinds) {
    const owner = tokens[kind.needs];
    const planId = crypto.randomUUID();
    const prepared = await f.as(owner, kind.name, await kind.input(), planId);
    expect(prepared.status, prepared.text).toBe(200);
    const plan = { planId, planHash: prepared.body.data.planHash as string };
    for (const [who, credential] of Object.entries(tokens)) {
      if (who === kind.needs) continue;
      const reply = await f.as(credential, "operations.commit", plan);
      expect(reply.status, `${who} committing ${kind.what}`).toBe(403);
      expect(reply.body.error.code).toBe("permission_denied");
    }
    // The refusals changed nothing: the plan is still only prepared.
    expect((await f.owner("operations.get", { operationId: planId })).body.data.disposition).toBe(
      "prepared",
    );
    const committed = await f.as(owner, "operations.commit", plan);
    expect(committed.status, committed.text).toBe(200);
    expect(committed.body.data.disposition, kind.what).toBe("committed");
  }
});

test("every request made with a token is on its activity trail, including refusals; the owner's are not", async () => {
  const f = await fixture();
  await f.setup();
  const first = await f.token(["read", "draft"], "First agent");
  const second = await f.token(["read"], "Second agent");
  await f.owner("book.get");
  await f.as(first, "book.get");
  await f.as(first, "drafts.create", { data: opening }, crypto.randomUUID());
  await f.as(first, "journal.prepare", { draftId: "x", expectedVersion: 1 }, crypto.randomUUID());
  await f.as(second, "accounts.list");
  await f.as(first, "tokens.create", { label: "Mine", permissions: ["read"] }, crypto.randomUUID());
  // A wrong secret is not a holder: it leaves no line, so a stranger cannot fill the trail.
  await f.as(`rst_${idOf(first)}_${"Z".repeat(43)}`, "book.get");
  const all = await f.owner("tokens.activity");
  expect(all.status).toBe(200);
  const events = all.body.data.events as {
    operation: string;
    outcome: string;
    code: string | null;
    status: number;
    label: string;
    tokenId: string;
    operationId: string | null;
  }[];
  expect(all.body.data).toMatchObject({ count: 5, page: 1, pageSize: 25 });
  expect(events.map((event) => [event.operation, event.outcome, event.status])).toEqual([
    ["tokens.create", "denied", 403],
    ["accounts.list", "ok", 200],
    ["journal.prepare", "denied", 403],
    ["drafts.create", "ok", 200],
    ["book.get", "ok", 200],
  ]);
  // A request refused for scope is refused before its body is read, so it has no operation id.
  expect(events[2]).toMatchObject({
    code: "permission_denied",
    label: "First agent",
    tokenId: idOf(first),
    operationId: null,
  });
  expect(events[1]).toMatchObject({ label: "Second agent", tokenId: idOf(second) });
  const only = await f.owner("tokens.activity", { tokenId: idOf(second) });
  expect(only.body.data.count).toBe(1);
  // Using a revoked token is recorded against it, so the owner can see who still holds it.
  await f.owner("tokens.revoke", { tokenId: idOf(second) }, crypto.randomUUID());
  await f.as(second, "accounts.list");
  const trail = (await f.owner("tokens.activity", { tokenId: idOf(second) })).body.data.events;
  // A refused token's trail says what it tried, even though it was refused before routing.
  expect(trail[0]).toMatchObject({
    operation: "accounts.list",
    outcome: "denied",
    code: "token_revoked",
    status: 401,
  });
  // Text that is not an operation name is never recorded as one.
  await f.send(f.open, "book.get%0d%0aX", {}, { credential: second });
  const odd = (await f.owner("tokens.activity", { tokenId: idOf(second) })).body.data.events[0];
  expect(odd.operation).toBe("(unrouted)");
  // An agent cannot read the trail.
  expect((await f.as(first, "tokens.activity")).status).toBe(403);
});

test("the trail pages, and last use is recorded without a write per request", async () => {
  const f = await fixture();
  await f.setup();
  const secret = await f.token(["read"]);
  const id = idOf(secret);
  const listed = async () =>
    (await f.owner("tokens.list")).body.data.tokens[0].lastUsedAt as string | null;
  expect(await listed()).toBeNull();
  await f.as(secret, "book.get");
  expect(await listed()).toBe(START.toISOString());
  f.advance(10_000);
  await f.as(secret, "book.get");
  // Within a minute the stored value is left alone.
  expect(await listed()).toBe(START.toISOString());
  f.advance(60_000);
  await f.as(secret, "book.get");
  expect(await listed()).toBe(f.now.toISOString());
  for (let index = 0; index < 30; index++) await f.as(secret, "accounts.list");
  const page1 = (await f.owner("tokens.activity", { tokenId: id })).body.data;
  expect(page1.count).toBe(33);
  expect(page1.events).toHaveLength(25);
  const page2 = (await f.owner("tokens.activity", { tokenId: id, page: 2 })).body.data;
  expect(page2.events).toHaveLength(8);
  expect(
    new Set([...page1.events, ...page2.events].map((event: { seq: string }) => event.seq)).size,
  ).toBe(33);
});

test("labels and expiry are validated for the owner too", async () => {
  const f = await fixture();
  await f.setup();
  for (const [label, expiresInDays, code] of [
    ["", undefined, "invalid_input"],
    ["x".repeat(81), undefined, "invalid_input"],
    ["bad\nlabel", undefined, "invalid_label"],
    ["reorder‮txt", undefined, "invalid_label"],
    ["   ", undefined, "invalid_label"],
    ["fine", 0, "invalid_input"],
    ["fine", 366, "invalid_input"],
    ["fine", 1.5, "invalid_input"],
  ] as const) {
    const reply = await f.owner(
      "tokens.create",
      { label, permissions: ["read"], ...(expiresInDays !== undefined ? { expiresInDays } : {}) },
      crypto.randomUUID(),
    );
    expect(reply.status, JSON.stringify([label, expiresInDays])).toBe(400);
    expect(reply.body.error.code).toBe(code);
  }
  expect((await f.owner("tokens.list")).body.data.tokens).toEqual([]);
  const long = await f.owner(
    "tokens.create",
    { label: "  Padded label  ", permissions: ["read"], expiresInDays: 365 },
    crypto.randomUUID(),
  );
  expect(long.body.data.token).toMatchObject({
    label: "Padded label",
    expiresAt: "2027-10-03T12:00:00.000Z",
  });
});

test("tokens survive a restart and stay bound to the book they were made in", async () => {
  const f = await fixture();
  await f.setup();
  const secret = await f.token(["read", "draft"]);
  f.service.close();
  const reopened = await LocalBookService.open(f.path);
  cleanup.push(() => reopened.close());
  const http = new ApplicationHttp(
    reopened,
    { bookId: reopened.bookId, permissions: BUSINESS_PERMISSIONS },
    { clock: () => f.now },
  );
  const reply = await f.send(http, "book.get", {}, { credential: secret });
  expect(reply.status).toBe(200);
  expect(reply.body.data.permissions).toEqual(["read", "draft"]);
});

test("tokens need a configured book to be managed, but authenticate before one exists", async () => {
  const f = await fixture();
  const early = await f.owner(
    "tokens.create",
    { label: "Early", permissions: ["read"] },
    crypto.randomUUID(),
  );
  expect(early.status).toBe(409);
  expect(early.body.error.code).toBe("book_not_configured");
  const issued = await issueToken();
  const unknown = await f.as(issued.token, "book.get");
  expect(unknown.status).toBe(401);
  await f.setup();
  const secret = await f.token(["read"]);
  expect((await f.as(secret, "book.get")).status).toBe(200);
});

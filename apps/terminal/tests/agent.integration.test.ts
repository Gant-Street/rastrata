import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { issueOwnerKey } from "@rastrata/application/agent";

// The real binary against the real service with the owner lock on: the owner key opens it, an agent
// token gets only its grant, and nothing an agent does with its token reaches the owner's powers.
const directory = mkdtempSync(join(tmpdir(), "rastrata-agent-integration-"));
const binary = join(directory, "rastrata");
const root = resolve(import.meta.dir, "../../..");
const keyFile = join(directory, "owner.key");
const ownerKey = issueOwnerKey();
writeFileSync(keyFile, `${ownerKey}\n`, { mode: 0o600 });
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = probe.port;
await probe.stop();
const endpoint = `http://127.0.0.1:${port}`;
let server: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  const build = Bun.spawn([process.env.GO_BIN ?? "go", "build", "-o", binary, "./cmd/rastrata"], {
    cwd: resolve(root, "apps/terminal"),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await build.exited).toBe(0);
  server = Bun.spawn([process.execPath, "apps/api/src/main.ts"], {
    cwd: root,
    env: {
      ...Bun.env,
      RASTRATA_LOCAL_DEV: "1",
      RASTRATA_API_PORT: String(port),
      RASTRATA_LOCAL_DB: join(directory, "book.sqlite"),
      RASTRATA_OWNER_KEY_FILE: keyFile,
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${endpoint}/health`)).ok) return;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error("API startup timed out");
}, 60_000);
afterAll(async () => {
  server?.kill("SIGTERM");
  if (server) await server.exited;
  rmSync(directory, { recursive: true, force: true });
});

type Credentials = { token?: string; ownerKeyFile?: string };
async function run(credentials: Credentials, args: string[], input?: unknown) {
  const environment: Record<string, string> = { ...(Bun.env as Record<string, string>) };
  delete environment.RASTRATA_TOKEN;
  delete environment.RASTRATA_OWNER_KEY_FILE;
  // What `rastrata connect` keeps is kept for this test, not among the person's own connections.
  environment.RASTRATA_CONFIG_DIR = join(directory, "config");
  if (credentials.token) environment.RASTRATA_TOKEN = credentials.token;
  if (credentials.ownerKeyFile) environment.RASTRATA_OWNER_KEY_FILE = credentials.ownerKeyFile;
  const child = Bun.spawn(
    [
      binary,
      "--endpoint",
      endpoint,
      "--request-dir",
      join(directory, "requests"),
      "--json",
      ...args,
      ...(input ? ["--input", "-"] : []),
    ],
    { stdin: input ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe", env: environment },
  );
  if (input && child.stdin && typeof child.stdin !== "number") {
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  }
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exit, stdout, stderr, body: stdout.trim().startsWith("{") ? JSON.parse(stdout) : null };
}

const owner: Credentials = { ownerKeyFile: keyFile };
const draft = {
  data: {
    date: "2026-01-15",
    reference: "OPEN",
    narration: "Owner contribution",
    lines: [
      { accountId: "1000", debit: "1000.00", credit: "" },
      { accountId: "3000", debit: "", credit: "1000.00" },
    ],
  },
};

test("a locked service refuses the CLI without credentials, and the owner key opens it", async () => {
  const bare = await run({}, ["context"]);
  expect(bare.exit).toBe(3);
  expect(bare.body.error.code).toBe("authentication_required");
  const asOwner = await run(owner, ["context"]);
  expect(asOwner.exit).toBe(0);
  expect(asOwner.body.data).toMatchObject({ principal: { kind: "owner" }, ownerAccess: "key" });
  // The offline commands need no service and no credentials.
  expect((await run({}, ["schema", "tokens.create"])).exit).toBe(0);
});

test("an agent token acts with exactly its grant; the owner reads what it did and revokes it", async () => {
  expect(
    (
      await run(owner, ["book", "setup"], {
        name: "Agent CLI Co",
        currency: "USD",
        fiscalYear: 2026,
        periodModel: "monthly",
        accounts: [
          { code: "1000", name: "Cash", role: "asset" },
          { code: "3000", name: "Capital", role: "equity" },
        ],
      })
    ).exit,
  ).toBe(0);
  const created = await run(owner, [
    "tokens",
    "create",
    "--label",
    "Integration agent",
    "--preset",
    "draft",
    "--expires-in-days",
    "7",
  ]);
  expect(created.exit, created.stderr).toBe(0);
  const secret = created.body.data.secret as string;
  expect(secret).toMatch(/^rst_[0-9a-f]{16}_/);
  expect(created.stderr).not.toContain(secret);
  const id = created.body.data.token.id as string;
  const agent: Credentials = { token: secret };

  const context = await run(agent, ["context"]);
  expect(context.body.data.principal).toMatchObject({ kind: "token", tokenId: id });
  expect(context.body.data.permissions).toEqual(["read", "draft"]);
  // The token wins when the owner's key file is also in the environment.
  const both = await run({ token: secret, ownerKeyFile: keyFile }, ["context"]);
  expect(both.body.data.principal.kind).toBe("token");

  const saved = await run(agent, ["drafts", "create"], draft);
  expect(saved.exit, saved.stdout).toBe(0);
  const prepare = await run(agent, ["journal", "prepare"], {
    draftId: saved.body.data.id,
    expectedVersion: saved.body.data.version,
  });
  expect(prepare.exit).toBe(3);
  expect(prepare.body.error.code).toBe("permission_denied");
  for (const attempt of [
    ["tokens", "list"],
    ["tokens", "create", "--label", "Mine", "--preset", "bookkeeper"],
    ["tokens", "revoke", id],
    ["tokens", "activity"],
  ]) {
    const refused = await run(agent, attempt);
    expect(refused.exit, attempt.join(" ")).toBe(3);
    expect(refused.body.error.code).toBe("permission_denied");
  }
  // The browser routes are not for tokens.
  const legacy = await fetch(`${endpoint}/api/book`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(legacy.status).toBe(403);

  const listed = await run(owner, ["tokens", "list"]);
  expect(listed.body.data.tokens).toHaveLength(1);
  expect(listed.body.data.tokens[0]).toMatchObject({
    id,
    status: "active",
    permissions: ["read", "draft"],
  });
  expect(listed.stdout).not.toContain(secret);
  const activity = await run(owner, ["tokens", "activity", "--token", id]);
  const operations = activity.body.data.events.map(
    (event: { operation: string }) => event.operation,
  );
  expect(operations).toEqual(
    expect.arrayContaining(["drafts.create", "journal.prepare", "tokens.create"]),
  );
  expect(activity.stdout).not.toContain(secret);

  const revoked = await run(owner, ["tokens", "revoke", id, "--reason", "Finished"]);
  expect(revoked.body.data.status).toBe("revoked");
  const after = await run(agent, ["context"]);
  expect(after.exit).toBe(3);
  expect(after.body.error.code).toBe("token_revoked");
});

test("a credential that is not a credential never reaches the service", async () => {
  const garbage = await run({ token: "rst_not-a-real-token" }, ["context"]);
  expect(garbage.exit).toBe(2);
  expect(garbage.body.error.code).toBe("usage_error");
  expect(garbage.stdout + garbage.stderr).not.toContain("rst_not-a-real-token");
  const unknown = await run({ token: `rst_${"0".repeat(16)}_${"A".repeat(43)}` }, ["context"]);
  expect(unknown.exit).toBe(3);
  expect(unknown.body.error.code).toBe("token_invalid");
});

test("agent init and agent status work against the locked service and never write the token", async () => {
  const created = await run(owner, [
    "tokens",
    "create",
    "--label",
    "Init agent",
    "--preset",
    "read-only",
  ]);
  const secret = created.body.data.secret as string;
  const project = mkdtempSync(join(tmpdir(), "rastrata-agent-project-"));
  try {
    const init = await run({ token: secret }, [
      "agent",
      "init",
      "--agent",
      "all",
      "--dir",
      project,
    ]);
    expect(init.exit, init.stderr).toBe(0);
    expect(init.body.data.service).toMatchObject({
      reachable: true,
      authenticated: true,
      principal: "token",
      ownerAccess: "key",
      permissions: ["read"],
    });
    expect(init.stdout + init.stderr).not.toContain(secret);
    for (const path of [
      ".claude/skills/rastrata/SKILL.md",
      ".claude/skills/rastrata/guide.md",
      ".mcp.json",
      "AGENTS.md",
      "opencode.json",
    ]) {
      const text = await Bun.file(join(project, path)).text();
      expect(text.length, path).toBeGreaterThan(50);
      expect(text, path).not.toContain(secret);
      expect(text, path).not.toMatch(/rst_[0-9a-f]{16}_[A-Za-z0-9_-]{20,}/);
    }
    // The MCP entry names the variable (Claude Code expands it); it never holds the token.
    expect(await Bun.file(join(project, ".mcp.json")).text()).toContain(
      `Bearer $\{RASTRATA_TOKEN}`,
    );
    const status = await run({ token: secret }, ["agent", "status"]);
    expect(status.exit).toBe(0);
    expect(status.body.data).toMatchObject({ principal: "token", label: "Init agent" });
    // Without a credential the locked service says so, and the exit code is a denial.
    const bare = await run({}, ["agent", "status"]);
    expect(bare.exit).toBe(3);
    expect(bare.body.data).toMatchObject({
      reachable: true,
      authenticated: false,
      ownerAccess: "key",
    });
    // The guide needs no service and no credentials.
    const guide = await run({}, ["agent", "guide"]);
    expect(guide.exit).toBe(0);
    expect(guide.stdout).toContain("## Running the books with Rastrata");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("rastrata connect on the computer that runs the service: the owner connects an agent from a folder in one command, and every later command in the folder is that agent with nothing set", async () => {
  const project = mkdtempSync(join(tmpdir(), "rastrata-agent-connect-"));
  const config = join(directory, "config");
  // A command run in a folder, with no address and no credential given: what an agent does.
  const inFolder = async (cwd: string, args: string[], extra: Record<string, string> = {}) => {
    const environment: Record<string, string> = { ...(Bun.env as Record<string, string>) };
    delete environment.RASTRATA_TOKEN;
    delete environment.RASTRATA_OWNER_KEY_FILE;
    delete environment.RASTRATA_API_URL;
    const child = Bun.spawn([binary, "--request-dir", join(directory, "requests"), ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...environment, RASTRATA_CONFIG_DIR: config, ...extra },
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return {
      exit,
      stdout,
      stderr,
      body: stdout.trim().startsWith("{") ? JSON.parse(stdout) : null,
    };
  };
  try {
    // The owner, in the folder the agent works in. No code: the owner is the one asking.
    const connected = await inFolder(
      project,
      ["connect", "--preset", "read-only", "--name", "Connect check", "--endpoint", endpoint],
      { RASTRATA_OWNER_KEY_FILE: keyFile },
    );
    expect(connected.exit, connected.stderr).toBe(0);
    expect(connected.stderr).toMatch(
      /Connected to your books\. This agent can read until [A-Z][a-z]+ \d{1,2}, \d{4}\./,
    );
    expect(connected.body.data).toMatchObject({
      connected: true,
      checked: true,
      endpoint,
      name: "Connect check",
      permissions: ["read"],
    });
    // The token is in the connections file, private to the person, and nowhere else.
    const kept = await Bun.file(join(config, "connections.json")).text();
    const secret = /rst_[0-9a-f]{16}_[A-Za-z0-9_-]{43}/.exec(kept)?.[0] ?? "";
    expect(secret).not.toBe("");
    expect(connected.stdout + connected.stderr).not.toContain(secret.slice(21));
    for (const path of [
      ".claude/skills/rastrata/SKILL.md",
      ".claude/skills/rastrata/guide.md",
      "AGENTS.md",
    ]) {
      const text = await Bun.file(join(project, path)).text();
      expect(text.length, path).toBeGreaterThan(50);
      expect(text, path).not.toMatch(/rst_[0-9a-f]{16}_[A-Za-z0-9_-]{20,}/);
    }
    expect(await Bun.file(join(project, ".mcp.json")).exists()).toBe(false);

    // From now on: no address, no variable. The command knows where the books are and acts as the agent, with exactly its grant.
    const status = await inFolder(project, ["agent", "status"]);
    expect(status.exit, status.stderr).toBe(0);
    expect(status.body.data).toMatchObject({
      endpoint,
      credential: "connection",
      principal: "token",
      label: "Connect check",
      permissions: ["read"],
    });
    const read = await inFolder(project, ["accounts", "list"]);
    expect(read.exit, read.stderr).toBe(0);
    const manage = await inFolder(project, ["tokens", "list"]);
    expect(manage.exit).toBe(3);
    expect(manage.body.error.code).toBe("permission_denied");
    // The owner sees it by its name, and revoking it stops the folder's commands, which say why.
    const listed = await run(owner, ["tokens", "list", "--active"]);
    const token = listed.body.data.tokens.find(
      (item: { label: string }) => item.label === "Connect check",
    );
    expect(token).toMatchObject({ permissions: ["read"], status: "active" });
    expect((await run(owner, ["tokens", "revoke", token.id])).exit).toBe(0);
    const after = await inFolder(project, ["accounts", "list"]);
    expect(after.exit).toBe(3);
    expect(after.body.error.code).toBe("token_revoked");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

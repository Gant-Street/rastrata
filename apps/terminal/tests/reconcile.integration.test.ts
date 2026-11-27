import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The real service and the real command: the Go client checks every response against the
// published contract, so this proves the CLI and the service agree, which a fake server cannot.
const directory = mkdtempSync(join(tmpdir(), "rastrata-reconcile-cli-"));
const binary = join(directory, "rastrata");
const root = resolve(import.meta.dir, "../../..");
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

afterAll(() => {
  server?.kill();
  rmSync(directory, { recursive: true, force: true });
});

const version = "rastrata-application-v1";
async function api(name: string, input: unknown, operationId?: string) {
  const response = await fetch(`${endpoint}/v1/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version,
      bookId: "local-book",
      input,
      ...(operationId ? { operationId } : {}),
    }),
  });
  const body = (await response.json()) as {
    ok: boolean;
    data: { id: string; planId: string; planHash: string };
    error?: unknown;
  };
  expect(body.ok, JSON.stringify(body.error)).toBe(true);
  return body.data;
}
async function post(date: string, narration: string, lines: [string, string, string][]) {
  const draft = await api(
    "drafts.create",
    {
      data: {
        date,
        reference: narration,
        narration,
        lines: lines.map(([accountId, debit, credit]) => ({ accountId, debit, credit })),
      },
    },
    crypto.randomUUID(),
  );
  const plan = await api(
    "journal.prepare",
    { draftId: draft.id, expectedVersion: 1 },
    crypto.randomUUID(),
  );
  await api("operations.commit", { planId: plan.planId, planHash: plan.planHash });
}

async function cli(...args: string[]) {
  const run = Bun.spawn(
    [binary, ...args, "--endpoint", endpoint, "--request-dir", join(directory, "requests")],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const [out, err] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  const exit = await run.exited;
  return { exit, out, err, json: out.trim().startsWith("{") ? JSON.parse(out) : null };
}

test("the reconcile commands drive a real book from statement to a voided record", async () => {
  await api(
    "book.setup",
    {
      name: "CLI Co",
      currency: "USD",
      fiscalYear: 2026,
      periodModel: "monthly",
      accounts: [
        { code: "1000", name: "Checking", role: "asset" },
        { code: "3000", name: "Capital", role: "equity" },
        { code: "4000", name: "Sales", role: "income" },
        { code: "5000", name: "Expense", role: "expense" },
      ],
    },
    crypto.randomUUID(),
  );
  await post("2026-01-02", "Owner contribution", [
    ["1000", "1000.00", ""],
    ["3000", "", "1000.00"],
  ]);
  await post("2026-01-05", "Invoice paid", [
    ["1000", "250.00", ""],
    ["4000", "", "250.00"],
  ]);
  await post("2026-01-09", "Office supplies", [
    ["5000", "40.10", ""],
    ["1000", "", "40.10"],
  ]);
  const statementDate = "2026-01-31";

  const started = await cli(
    "reconcile",
    "start",
    "--account",
    "1000",
    "--date",
    statementDate,
    "--balance",
    "1209.90",
  );
  expect(started.exit, started.out + started.err).toBe(0);
  const id = started.json.data.id as string;
  expect(started.json.data.lines).toHaveLength(3);
  expect(started.json.data.difference).toBe("1209.90");

  // The service refuses to complete at a difference, and the command says exit 3.
  const early = await cli("reconcile", "complete", id);
  expect(early.exit).toBe(3);
  expect(early.json.error.code).toBe("reconcile_difference");

  const selected = await cli("reconcile", "select", id, "--all");
  expect(selected.exit, selected.out + selected.err).toBe(0);
  expect(selected.json.data).toMatchObject({
    selectedCount: 3,
    difference: "0.00",
    canComplete: true,
  });
  expect(selected.err).toContain("current version");

  const shown = await cli("reconcile", "show", id, "--format", "json");
  expect(shown.json.data.lines.map((line: { amount: string }) => line.amount)).toEqual([
    "1000.00",
    "250.00",
    "-40.10",
  ]);

  const done = await cli("reconcile", "complete", id, "--version", String(shown.json.data.version));
  expect(done.exit, done.out + done.err).toBe(0);
  expect(done.json.data.status).toBe("completed");
  expect(done.json.data.recordHash).toMatch(/^[0-9a-f]{64}$/);

  const status = await cli("reconcile", "status");
  expect(status.json.data.accounts[0]).toMatchObject({
    lastReconciledDate: statementDate,
    lastReconciledBalance: "1209.90",
    unclearedCount: 0,
  });
  const list = await cli("reconcile", "list", "--state", "completed");
  expect(list.json.data.items.map((item: { id: string }) => item.id)).toEqual([id]);
  const cleared = await cli("reconcile", "cleared", shown.json.data.lines[0].journalId);
  expect(cleared.json.data.postings).toHaveLength(1);

  const bad = await cli("reconcile", "void", id);
  expect(bad.exit).toBe(2);
  const voided = await cli("reconcile", "void", id, "--reason", "Wrong statement");
  expect(voided.exit, voided.out + voided.err).toBe(0);
  expect(voided.json.data.status).toBe("voided");
  expect(voided.json.data.void.reason).toBe("Wrong statement");
  const after = await cli("reconcile", "status", "--account", "1000");
  expect(after.json.data.accounts[0]).toMatchObject({
    lastReconciledDate: null,
    unclearedCount: 3,
  });
}, 120_000);

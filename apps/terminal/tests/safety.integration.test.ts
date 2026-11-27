import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The real service, the real command and the real offline tool: a book is backed up, the backup is
// verified and drilled through the CLI, restored with the offline command into a new database that
// a second service opens, and exported and rebuilt from the export.
const directory = mkdtempSync(join(tmpdir(), "rastrata-safety-cli-"));
const binary = join(directory, "rastrata");
const root = resolve(import.meta.dir, "../../..");
const backups = join(directory, "backups");
const exports = join(directory, "exports");
const version = "rastrata-application-v1";
const servers: ReturnType<typeof Bun.spawn>[] = [];

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port;
  await probe.stop();
  return port ?? 0;
}

async function startService(database: string) {
  const port = await freePort();
  const server = Bun.spawn([process.execPath, "apps/api/src/main.ts"], {
    cwd: root,
    env: {
      ...Bun.env,
      RASTRATA_LOCAL_DEV: "1",
      RASTRATA_API_PORT: String(port),
      RASTRATA_LOCAL_DB: database,
      RASTRATA_BACKUPS: "off",
      RASTRATA_BACKUP_DIR: backups,
      RASTRATA_EXPORT_DIR: exports,
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  servers.push(server);
  const endpoint = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${endpoint}/health`)).ok) return { server, endpoint };
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error("API startup timed out");
}

beforeAll(async () => {
  const build = Bun.spawn([process.env.GO_BIN ?? "go", "build", "-o", binary, "./cmd/rastrata"], {
    cwd: resolve(root, "apps/terminal"),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await build.exited).toBe(0);
}, 60_000);

afterAll(() => {
  for (const server of servers) server.kill();
  rmSync(directory, { recursive: true, force: true });
});

async function cli(endpoint: string | null, ...args: string[]) {
  const child = Bun.spawn(
    [
      binary,
      ...args,
      ...(endpoint ? ["--endpoint", endpoint] : []),
      "--request-dir",
      join(directory, "requests"),
    ],
    {
      cwd: root,
      env: {
        ...Bun.env,
        BUN_BIN: process.execPath,
        RASTRATA_BACKUP_DIR: backups,
        RASTRATA_EXPORT_DIR: exports,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  const last = stdout.trim().split("\n").at(-1) ?? "";
  return { code, stdout, stderr, json: last ? JSON.parse(last) : null };
}

async function api(endpoint: string, name: string, input: unknown, operationId?: string) {
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
  // biome-ignore lint/suspicious/noExplicitAny: tests read untyped JSON answers
  const body = (await response.json()) as { ok: boolean; data: any; error?: unknown };
  expect(body.ok, JSON.stringify(body.error)).toBe(true);
  return body.data;
}

test("back up, verify, drill, restore and export a real book through the CLI", async () => {
  const database = join(directory, "book.sqlite");
  const { endpoint } = await startService(database);
  await api(
    endpoint,
    "book.setup",
    {
      name: "CLI Co",
      currency: "USD",
      fiscalYear: 2026,
      periodModel: "monthly",
      accounts: [
        { code: "1000", name: "Cash", role: "asset" },
        { code: "3000", name: "Capital", role: "equity" },
        { code: "4000", name: "Sales", role: "income" },
      ],
    },
    crypto.randomUUID(),
  );
  for (let n = 1; n <= 3; n++) {
    const draft = await api(
      endpoint,
      "drafts.create",
      {
        data: {
          date: `2026-01-1${n}`,
          reference: `S${n}`,
          narration: `Sale ${n}`,
          lines: [
            { accountId: "1000", debit: `${n}0.50`, credit: "" },
            { accountId: "4000", debit: "", credit: `${n}0.50` },
          ],
        },
      },
      crypto.randomUUID(),
    );
    const prepared = await api(
      endpoint,
      "journal.prepare",
      { draftId: draft.id, expectedVersion: 1 },
      crypto.randomUUID(),
    );
    await api(endpoint, "operations.commit", {
      planId: prepared.planId,
      planHash: prepared.planHash,
    });
  }

  // Before any backup the status says so, plainly.
  const before = await cli(endpoint, "backup", "status");
  expect(before.code).toBe(0);
  expect(before.json.data.warnings[0].code).toBe("never_backed_up");

  const created = await cli(endpoint, "backup", "create");
  expect(created.code, created.stderr).toBe(0);
  expect(created.json.data.state).toBe("done");
  const backupId = created.json.data.backup.id as string;
  expect(created.json.data.backup.head.sequence).toBe("4");

  const verified = await cli(endpoint, "backup", "verify");
  expect(verified.code, verified.stderr).toBe(0);
  expect(verified.json.data.verification.passed).toBe(true);
  expect(verified.json.data.verification.outcomes).toBe(4);

  const drilled = await cli(endpoint, "backup", "drill");
  expect(drilled.code, drilled.stderr).toBe(0);
  expect(drilled.json.data.drill.passed).toBe(true);

  const listed = await cli(endpoint, "backup", "list");
  expect(listed.json.data.backups.map((b: { id: string }) => b.id)).toEqual([backupId]);
  expect(listed.json.data.backups[0].verification.passed).toBe(true);

  // Restore is offline: it needs the database not to be open, and it verifies before it installs.
  const restored = join(directory, "restored", "book.sqlite");
  const missing = await cli(
    null,
    "restore",
    "20200101T000000Z-00000001-00000000",
    "--to",
    restored,
  );
  expect(missing.code).toBe(3);
  expect(missing.json.error.code).toBe("restore_backup_not_found");
  const done = await cli(null, "restore", "latest", "--to", restored);
  expect(done.code, done.stderr).toBe(0);
  expect(done.json.data.head.sequence).toBe("4");
  expect(done.json.data.replayed).toBe(true);
  expect(done.stderr).toContain("Replaying the ledger");
  const again = await cli(null, "restore", backupId, "--to", restored);
  expect(again.code).toBe(3);
  expect(again.json.error.code).toBe("restore_target_exists");
  // A second service opens the restored book and sees the same journals.
  const second = await startService(restored);
  const journals = await api(second.endpoint, "journal.list", { page: 1 });
  expect(journals.count).toBe(3);
  second.server.kill();

  // The open export, checked and rebuilt.
  const exported = await cli(endpoint, "export", "create");
  expect(exported.code, exported.stderr).toBe(0);
  const location = exported.json.data.export.location as string;
  expect(existsSync(join(location, "SHA256SUMS"))).toBe(true);
  const checked = await cli(null, "export", "verify", location);
  expect(checked.code, checked.stderr).toBe(0);
  expect(checked.json.data.passed).toBe(true);
  const rebuilt = join(directory, "rebuilt.sqlite");
  const imported = await cli(null, "import-export", location, "--to", rebuilt);
  expect(imported.code, imported.stderr).toBe(0);
  expect(imported.json.data.head.chainHash).toBe(exported.json.data.export.head.chainHash);
  expect(imported.stderr).toContain("Rebuilding the ledger");
  expect(readdirSync(exports).length).toBe(1);
}, 120_000);

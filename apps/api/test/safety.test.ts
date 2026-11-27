import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalBookService } from "@rastrata/application/local";
import { APPLICATION_API_VERSION } from "@rastrata/application/schema";
import { startLocalApplicationServer } from "../src/server.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

const BOOK = {
  name: "Server Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Cash", role: "asset" },
    { code: "3000", name: "Capital", role: "equity" },
    { code: "4000", name: "Sales", role: "income" },
  ],
} as const;

function directory() {
  const path = mkdtempSync(join(tmpdir(), "rastrata-api-safety-"));
  cleanup.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

const call = async (base: string, name: string, input: unknown = {}, operationId?: string) =>
  (
    await fetch(`${base}/v1/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: APPLICATION_API_VERSION,
        bookId: "local-book",
        input,
        ...(operationId ? { operationId } : {}),
      }),
    })
  ).json();

async function until<T>(read: () => Promise<T | null>, what: string, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await read();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

test("the server backs the book up and verifies the backup on its own, and once more when it stops", async () => {
  const dir = directory();
  const path = join(dir, "book.sqlite");
  const seed = await LocalBookService.open(path, { safety: false });
  await seed.setup(BOOK);
  seed.close();
  const runtime = await startLocalApplicationServer({
    path,
    port: 0,
    backups: { tickMs: 200, startupDelayMs: 10 },
  });
  const base = `http://127.0.0.1:${runtime.server.port}`;
  try {
    // The backup is verified a moment before the scheduler records its run: wait for both, or a busy computer reads
    // the status in between.
    const status = await until(async () => {
      const answer = await call(base, "backup.status");
      return answer.data?.latestVerified && answer.data.automatic?.lastRunOk !== null
        ? answer.data
        : null;
    }, "an automatic verified backup, recorded by the scheduler");
    expect(status.automatic).toMatchObject({ enabled: true, scheduler: "active", lastRunOk: true });
    expect(status.latest.reason).toBe("startup");
    expect(status.backupCount).toBe(1);
    // A change after the backup: stopping the server takes one more.
    const draft = await call(
      base,
      "drafts.create",
      {
        data: {
          date: "2026-01-15",
          reference: "S1",
          narration: "Sale",
          lines: [
            { accountId: "1000", debit: "10.00", credit: "" },
            { accountId: "4000", debit: "", credit: "10.00" },
          ],
        },
      },
      crypto.randomUUID(),
    );
    const prepared = await call(
      base,
      "journal.prepare",
      { draftId: draft.data.id, expectedVersion: 1 },
      crypto.randomUUID(),
    );
    const done = await call(base, "operations.commit", {
      planId: prepared.data.planId,
      planHash: prepared.data.planHash,
    });
    expect(done.data.disposition).toBe("committed");
  } finally {
    await runtime.stop();
  }
  const backups = join(dir, "backups", "book");
  const manifests = readdirSync(backups).filter((name) => name.endsWith(".manifest.json"));
  expect(manifests.length).toBe(2);
  expect(manifests.some((name) => name.includes("-00000002-") || name.includes("-00000003-"))).toBe(
    true,
  );
});

test("a server started without the scheduler (as tests do) makes no backups and says so", async () => {
  const dir = directory();
  const runtime = await startLocalApplicationServer({ path: join(dir, "book.sqlite"), port: 0 });
  const base = `http://127.0.0.1:${runtime.server.port}`;
  try {
    await call(base, "book.setup", BOOK, crypto.randomUUID());
    const status = (await call(base, "backup.status")).data;
    expect(status.automatic.scheduler).toBe("not_running");
    expect(status.warnings.map((w: { code: string }) => w.code)).toContain("scheduler_not_running");
    expect(runtime.scheduler).toBeNull();
  } finally {
    await runtime.stop();
  }
  expect(readdirSync(dir)).not.toContain("backups");
});

const tool = resolve(import.meta.dir, "../src/tool.ts");
async function runTool(...args: string[]) {
  const child = Bun.spawn([process.execPath, tool, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  return {
    code,
    stdout,
    stderr,
    json: stdout.trim() ? JSON.parse(stdout.trim().split("\n").at(-1) as string) : null,
  };
}

test("the offline tool restores a backup with progress on stderr and one JSON envelope on stdout, and refuses what it must", async () => {
  const dir = directory();
  const path = join(dir, "book.sqlite");
  const service = await LocalBookService.open(path);
  await service.setup(BOOK);
  const created = await service.host.safety?.createBackup("manual", new Date());
  service.close();
  if (!created) throw new Error("no backup");
  const id = created.manifest.id;
  const backups = join(dir, "backups", "book");
  const target = join(dir, "restored.sqlite");

  const restored = await runTool("restore", id, "--to", target, "--backup-dir", backups);
  expect(restored.code).toBe(0);
  expect(restored.json.ok).toBe(true);
  expect(restored.json.data.head).toEqual(created.manifest.ledger.head);
  expect(restored.json.data.sha256).toBe(created.manifest.file.sha256);
  expect(restored.stderr).toContain("Replaying the ledger");

  const again = await runTool("restore", id, "--to", target, "--backup-dir", backups);
  expect(again.code).toBe(3);
  expect(again.json.error.code).toBe("restore_target_exists");
  expect(again.json.error.message).toContain("--replace");

  const replaced = await runTool(
    "restore",
    "latest",
    "--to",
    target,
    "--replace",
    "--backup-dir",
    backups,
    "--quick",
  );
  expect(replaced.code).toBe(0);
  expect(replaced.json.data.safetyCopy).toContain(".replaced-");
  expect(replaced.json.data.replayed).toBe(false);

  const usage = await runTool("restore", "--to");
  expect(usage.code).toBe(2);
  expect(usage.json.error.code).toBe("usage_error");

  const missing = await runTool(
    "restore",
    "20200101T000000Z-00000001-00000000",
    "--to",
    join(dir, "x.sqlite"),
    "--backup-dir",
    backups,
  );
  expect(missing.code).toBe(3);
  expect(missing.json.error.code).toBe("restore_backup_not_found");
});

test("the offline tool checks and rebuilds an export", async () => {
  const dir = directory();
  const path = join(dir, "book.sqlite");
  const service = await LocalBookService.open(path);
  await service.setup(BOOK);
  service.close();
  const live = await LocalBookService.open(path);
  const sink = await live.host.safety?.beginExport("20260101T000000Z-00000001-00000000");
  live.close();
  expect(sink).toBeDefined();
  await sink?.abort();
  // Use the operation to make a real export through a running server.
  const runtime = await startLocalApplicationServer({ path, port: 0 });
  const base = `http://127.0.0.1:${runtime.server.port}`;
  let location = "";
  try {
    const job = (await call(base, "export.create", { format: "directory" }, crypto.randomUUID()))
      .data;
    expect(job.state).toBe("done");
    location = job.export.location;
  } finally {
    await runtime.stop();
  }
  const checked = await runTool("check-export", location);
  expect(checked.code).toBe(0);
  expect(checked.json.data.passed).toBe(true);
  const rebuilt = join(dir, "rebuilt.sqlite");
  const imported = await runTool("import-export", location, "--to", rebuilt);
  expect(imported.code).toBe(0);
  expect(imported.json.data.head.sequence).toBe("1");
  expect(imported.stderr).toContain("Rebuilding the ledger");
  const again = await runTool("import-export", location, "--to", rebuilt);
  expect(again.code).toBe(3);
  expect(again.json.error.code).toBe("import_target_exists");
  writeFileSync(join(location, "journals.jsonl"), "tampered\n");
  const bad = await runTool("check-export", location);
  expect(bad.code).toBe(3);
  expect(bad.json.data.passed).toBe(false);
});

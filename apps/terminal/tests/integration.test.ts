import { beforeAll, afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "rastrata-terminal-contract-"));
const binary = join(directory, "rastrata");
const root = resolve(import.meta.dir, "../../..");
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = probe.port;
await probe.stop();
const endpoint = `http://127.0.0.1:${port}`;
function spawnService() {
  return Bun.spawn([process.execPath, "apps/api/src/main.ts"], {
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
}
let server: ReturnType<typeof spawnService>;
async function start() {
  server = spawnService();
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${endpoint}/health`)).ok) return;
    } catch {}
    if (server.exitCode !== null)
      throw new Error(`API failed: ${await new Response(server.stderr).text()}`);
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
  await start();
}, 30_000);

test("actual TUI supports keyboard setup/posting, resize, and restores terminal modes", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "rastrata-terminal-pty-"));
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const terminalPort = reservation.port;
  await reservation.stop();
  const local = Bun.spawn([process.execPath, "apps/api/src/main.ts"], {
    cwd: root,
    env: {
      ...Bun.env,
      RASTRATA_LOCAL_DEV: "1",
      RASTRATA_API_PORT: String(terminalPort),
      RASTRATA_LOCAL_DB: join(temporary, "book.sqlite"),
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if ((await fetch(`http://127.0.0.1:${terminalPort}/health`)).ok) break;
      } catch {}
      await Bun.sleep(50);
    }
    const terminal = Bun.spawn(
      [
        "python3",
        resolve(import.meta.dir, "terminal_session.py"),
        binary,
        `http://127.0.0.1:${terminalPort}`,
        join(temporary, "requests"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exit, stdout, stderr] = await Promise.all([
      terminal.exited,
      new Response(terminal.stdout).text(),
      new Response(terminal.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exit).toBe(0);
    expect(JSON.parse(stdout).terminalRestored).toBe(true);
    const noTTY = await command(["tui"]);
    expect(noTTY.exit).toBe(2);
    expect(noTTY.body.error.message).toContain("interactive terminal");
  } finally {
    local.kill("SIGTERM");
    await local.exited;
    rmSync(temporary, { recursive: true, force: true });
  }
}, 30_000);
afterAll(async () => {
  server?.kill("SIGTERM");
  if (server) await server.exited;
  rmSync(directory, { recursive: true, force: true });
});
async function command(args: string[], input?: unknown) {
  const child = Bun.spawn(
    [
      binary,
      "--endpoint",
      endpoint,
      "--book",
      "local-book",
      "--request-dir",
      join(directory, "requests"),
      "--json",
      ...args,
      ...(input ? ["--input", "-"] : []),
    ],
    { stdin: input ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe" },
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
  expect(stdout).not.toContain("\u001b");
  return { exit, body: JSON.parse(stdout), stderr };
}
const opening = {
  date: "2026-01-15",
  reference: "OPEN",
  narration: "Owner contribution",
  lines: [
    { accountId: "1000", debit: "1000.00", credit: "" },
    { accountId: "3000", debit: "", credit: "1000.00" },
  ],
};
test("headless CLI completes a durable first-book workflow against the independent API", async () => {
  expect(
    (
      await command(["book", "setup"], {
        name: "CLI Co",
        currency: "USD",
        fiscalYear: 2026,
        periodModel: "monthly",
        accounts: [
          { code: "1000", name: "Cash", role: "asset" },
          { code: "3000", name: "Capital", role: "equity" },
          { code: "4000", name: "Revenue", role: "income" },
          { code: "5000", name: "Expense", role: "expense" },
        ],
      })
    ).exit,
  ).toBe(0);
  let expenseId = "";
  for (const data of [
    {
      ...opening,
      source: {
        id: "owner-contribution-cli",
        description: "Owner contributed USD 1000",
        evidenceReference: "receipt-cli",
      },
    },
    {
      ...opening,
      reference: "SALE",
      lines: [
        { accountId: "1000", debit: "200.00", credit: "" },
        { accountId: "4000", debit: "", credit: "200.00" },
      ],
    },
    {
      ...opening,
      reference: "EXPENSE",
      lines: [
        { accountId: "5000", debit: "50.00", credit: "" },
        { accountId: "1000", debit: "", credit: "50.00" },
      ],
    },
  ]) {
    const draft = (await command(["drafts", "create"], { data })).body.data;
    const prepared = await command(["journal", "prepare"], {
      draftId: draft.id,
      expectedVersion: draft.version,
    });
    expect(prepared.exit).toBe(0);
    expect(prepared.body.data.valid).toBe(true);
    const { planId, planHash } = prepared.body.data;
    expect((await command(["operations", "commit", planId, planHash])).body.data.disposition).toBe(
      "committed",
    );
    expect((await command(["operations", "resume", planId])).body.data.disposition).toBe(
      "committed",
    );
    if (data.reference === "EXPENSE") expenseId = draft.id;
  }
  const source = (await command(["sources", "get", "owner-contribution-cli"])).body.data;
  expect(source.status).toBe("posted");
  expect(source.source.evidenceReference).toBe("receipt-cli");
  expect((await command(["sources", "list"], { text: "owner-contribution" })).body.data.count).toBe(
    1,
  );
  const duplicate = (
    await command(["drafts", "create"], { data: { ...opening, source: source.source } })
  ).body.data;
  const blocked = await command(["journal", "prepare"], {
    draftId: duplicate.id,
    expectedVersion: duplicate.version,
  });
  expect(blocked.exit).not.toBe(0);
  expect(blocked.body.error.code).toBe("source_already_posted");
  expect((await command(["journal", "get", source.journalId])).body.data.source.id).toBe(
    source.source.id,
  );
  const report = (await command(["reports", "all", "--as-of", "2026-01-31"])).body.data;
  expect(report.trialBalance.debit).toBe("1200.00");
  expect(report.balanceSheet.assets).toBe("1150.00");
  expect(report.profitAndLoss.netIncome).toBe("150.00");
  const activity = await command(["activity"], {
    accountId: "1000",
    asOf: report.asOf,
    revision: report.bookRevision,
    populationHash: report.populationHash,
    from: "2026-01-01",
    to: "2026-01-31",
  });
  expect(
    activity.body.data.rows.map((row: { runningBalance: string }) => row.runningBalance),
  ).toEqual(["1000.00", "1200.00", "1150.00"]);
  const reverse = (
    await command(["journal", "prepare-reverse"], {
      journalId: expenseId,
      accountingDate: "2026-01-17",
      reason: "Entered in error",
    })
  ).body.data;
  expect((await command(["operations", "commit", reverse.planId, reverse.planHash])).exit).toBe(0);
  const close = (
    await command(["periods", "prepare"], {
      periodId: "period-01",
      operation: "close",
      reason: "Reviewed January",
    })
  ).body.data;
  expect((await command(["operations", "commit", close.planId, close.planHash])).exit).toBe(0);
  expect((await command(["periods", "list"])).body.data.periods[0].status).toBe("closed");
  server.kill("SIGTERM");
  await server.exited;
  await start();
  const corrected = (await command(["reports", "all", "--as-of", "2026-01-31"])).body.data;
  expect(corrected.balanceSheet.assets).toBe("1200.00");
  expect(corrected.profitAndLoss.netIncome).toBe("200.00");
  // The browser reads the same operation the CLI does, so the two can never disagree.
  const web = await fetch(`${endpoint}/v1/reports.get`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: "rastrata-application-v1",
      bookId: "local-book",
      input: { asOf: "2026-01-31" },
    }),
  });
  const { data: webReport } = await web.json();
  expect(webReport.populationHash).toBe(corrected.populationHash);
  expect(webReport.balanceSheet.assets).toBe("1200.00");
  const unbalanced = (
    await command(["drafts", "create"], {
      data: {
        ...opening,
        lines: [
          { accountId: "1000", debit: "1.00", credit: "" },
          { accountId: "3000", debit: "", credit: "2.00" },
        ],
      },
    })
  ).body.data;
  const failed = await command(["journal", "prepare"], {
    draftId: unbalanced.id,
    expectedVersion: 1,
  });
  expect(failed.exit).toBe(3);
  expect(failed.body.error.code).toBe("journal_unbalanced");
  expect((await command(["drafts", "create"])).exit).toBe(2);
  const late = (
    await command(["drafts", "create"], { data: { ...opening, reference: "RECOVER-LATE" } })
  ).body.data;
  const rejectedPlan = (
    await command(["journal", "prepare"], { draftId: late.id, expectedVersion: late.version })
  ).body.data;
  const rejected = await command([
    "operations",
    "commit",
    rejectedPlan.planId,
    rejectedPlan.planHash,
  ]);
  expect(rejected.exit).toBe(3);
  const recovered = await command(["drafts", "recover"], {
    draftId: late.id,
    expectedVersion: late.version,
    postingOperationId: rejectedPlan.planId,
  });
  expect(recovered.exit).toBe(0);
  expect(recovered.body.data).toMatchObject({
    id: late.id,
    version: 2,
    status: "draft",
    recoveredFromOperationId: rejectedPlan.planId,
  });
  expect((await command(["operations", "resume", recovered.body.operationId])).body.data).toEqual(
    recovered.body.data,
  );
  const reopening = (
    await command(["periods", "prepare"], {
      periodId: "period-01",
      operation: "reopen",
      reason: "Late contribution reviewed",
    })
  ).body.data;
  expect((await command(["operations", "commit", reopening.planId, reopening.planHash])).exit).toBe(
    0,
  );
  const replacement = (
    await command(["journal", "prepare"], { draftId: late.id, expectedVersion: 2 })
  ).body.data;
  expect(replacement.valid).toBe(true);
  expect(
    (await command(["operations", "commit", replacement.planId, replacement.planHash])).exit,
  ).toBe(0);
  expect(
    (await command(["operations", "commit", rejectedPlan.planId, rejectedPlan.planHash])).body.data,
  ).toEqual(rejected.body.data);
  expect((await command(["drafts", "get", late.id])).body.data.status).toBe("posted");
  expect(
    (await command(["reports", "all", "--as-of", "2026-01-31"])).body.data.balanceSheet.assets,
  ).toBe("2200.00");
}, 30_000);

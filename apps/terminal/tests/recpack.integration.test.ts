import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The report on a finished reconciliation through the real command and the real service. The Go client
// checks every response against the published contract, so this proves the command and the service agree,
// and `tax verify-pack` shows the pack's reconciliation files are checked by the manifest like the rest.
const directory = mkdtempSync(join(tmpdir(), "rastrata-recpack-cli-"));
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

test("a finished reconciliation is reported on from the command line, and the pack that carries it verifies", async () => {
  await api(
    "book.setup",
    {
      name: "Report Co",
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
  // A check written on the 20th that the bank has not cashed by the 31st: in the books, not on the statement.
  await post("2026-01-20", "Software subscription =HYPERLINK(1)", [
    ["5000", "19.90", ""],
    ["1000", "", "19.90"],
  ]);

  const started = await cli(
    "reconcile",
    "start",
    "--account",
    "1000",
    "--date",
    "2026-01-31",
    "--balance",
    "1209.90",
  );
  expect(started.exit, started.out + started.err).toBe(0);
  const id = started.json.data.id as string;
  const software = started.json.data.lines.find((line: { narration: string }) =>
    line.narration.startsWith("Software"),
  ) as { postingId: string };

  // A draft has no report: the service says so, and the command exits 3, a refusal.
  const early = await cli("reconcile", "report", id);
  expect(early.exit).toBe(3);
  expect(early.json.error.code).toBe("reconcile_not_completed");

  const all = await cli("reconcile", "select", id, "--all");
  expect(all.exit, all.out + all.err).toBe(0);
  const without = await cli("reconcile", "select", id, "--remove", software.postingId);
  expect(without.json.data).toMatchObject({ difference: "0.00", canComplete: true });
  const done = await cli("reconcile", "complete", id);
  expect(done.exit, done.out + done.err).toBe(0);

  // The report: the envelope, the figures, and the books reaching the statement.
  const report = await cli("reconcile", "report", id);
  expect(report.exit, report.out + report.err).toBe(0);
  expect(report.json.data).toMatchObject({
    id,
    status: "completed",
    statementDate: "2026-01-31",
    statementBalance: "1209.90",
    bookBalance: "1190.00",
    difference: "0.00",
    cleared: { count: 3, total: "1209.90" },
    outstanding: { count: 1, total: "-19.90" },
    recordHash: done.json.data.recordHash,
  });
  expect(report.json.data.file).toBeUndefined();
  expect(report.json.data.outstanding.lines[0]).toMatchObject({
    date: "2026-01-20",
    amount: "-19.90",
  });

  const text = await cli("reconcile", "report", id, "--format", "text");
  expect(text.exit).toBe(0);
  expect(text.out).toContain("Reconciliation report: 1000 Checking");
  expect(text.out).toContain("The books on 2026-01-31, as they stood at revision");
  expect(text.out).toContain("Less 1 not yet on the statement (outstanding): -19.90");
  expect(text.out).toContain("Is the statement balance:  1209.90");
  expect(text.out).toContain("Software subscription =HYPERLINK(1)");

  // The spreadsheet is the service's: a cell that begins as a formula has a quote in front of it.
  const csv = await cli("reconcile", "report", id, "--format", "csv");
  expect(csv.exit).toBe(0);
  expect(csv.out).toContain("Report,Reconciliation report");
  expect(csv.out).toContain("Statement balance,1209.90");
  expect(csv.out).toContain("outstanding,2026-01-20,");
  expect(csv.out).toContain(",Software subscription =HYPERLINK(1),-19.90");
  expect(csv.out).not.toContain("\n=");
  // A report cannot be asked for at another revision.
  expect((await cli("reconcile", "report", id, "--revision", "3")).exit).toBe(2);

  // The pack of the year carries the same reconciliation, and verifies without a change to the verifier.
  const folder = join(directory, "pack");
  const built = await cli("tax", "accountant", "--year", "2026", "--out", folder);
  expect(built.exit, built.out + built.err).toBe(0);
  const summary = join(folder, "reconciliations.csv");
  const lines = join(folder, "reconciliation-lines.csv");
  expect(existsSync(summary)).toBe(true);
  expect(existsSync(lines)).toBe(true);
  expect(readFileSync(summary, "utf8")).toContain(id);
  expect(readFileSync(lines, "utf8")).toContain("outstanding,2026-01-20");
  const verified = await cli("tax", "verify-pack", folder);
  expect(verified.exit, verified.out + verified.err).toBe(0);
  expect(verified.out).toContain('"ok":true');

  // The zip is the same files, and verifies the same way.
  const zip = join(directory, "pack.zip");
  expect((await cli("tax", "accountant", "--year", "2026", "--out", zip)).exit).toBe(0);
  expect((await cli("tax", "verify-pack", zip)).exit).toBe(0);

  // And it is not a verifier that says yes to anything: one byte added to a reconciliation file is found.
  appendFileSync(summary, "tampered\r\n");
  const tampered = await cli("tax", "verify-pack", folder);
  expect(tampered.exit).toBe(3);
  expect(tampered.out).toContain("reconciliations.csv");

  // A reconciliation voided afterwards is voided in the next pack, though no entry has been made.
  const voided = await cli("reconcile", "void", id, "--reason", "Wrong statement");
  expect(voided.exit, voided.out + voided.err).toBe(0);
  const again = join(directory, "pack-again");
  expect((await cli("tax", "accountant", "--year", "2026", "--out", again)).exit).toBe(0);
  const row = readFileSync(join(again, "reconciliations.csv"), "utf8")
    .split("\r\n")
    .find((line) => line.startsWith(id));
  expect(row).toContain(",yes,");
  expect(row).toContain("Wrong statement");
  expect((await cli("tax", "verify-pack", again)).exit).toBe(0);
  const revoked = await cli("reconcile", "report", id);
  expect(revoked.json.data).toMatchObject({
    status: "voided",
    void: { reason: "Wrong statement" },
    outstanding: { count: 1 },
  });
}, 180_000);

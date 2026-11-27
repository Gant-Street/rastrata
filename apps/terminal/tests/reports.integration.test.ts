import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The real service and the real command: the Go client checks every response against the
// published contract, so this proves the CLI and the service agree on the report operations.
const directory = mkdtempSync(join(tmpdir(), "rastrata-reports-cli-"));
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
        reference: narration.slice(0, 40),
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

test("the reports command reads every statement of a real cash-basis book, and exports it safely", async () => {
  await api(
    "book.setup",
    {
      name: "Reports CLI Co",
      currency: "USD",
      fiscalYear: 2025,
      fiscalYearStartMonth: 10,
      basis: "cash",
      periodModel: "monthly",
      accounts: [
        { code: "1000", name: "Operating cash", role: "asset", tags: { cashFlowClass: "cash" } },
        {
          code: "3000",
          name: "Owner capital",
          role: "equity",
          tags: { cashFlowClass: "financing" },
        },
        { code: "4000", name: '=HYPERLINK("http://evil.example","Sales")', role: "income" },
        { code: "5000", name: "Supplies", role: "expense" },
      ],
    },
    crypto.randomUUID(),
  );
  await post("2025-10-05", "Owner contribution", [
    ["1000", "5000.00", ""],
    ["3000", "", "5000.00"],
  ]);
  await post("2025-11-10", "November sales", [
    ["1000", "1200.00", ""],
    ["4000", "", "1200.00"],
  ]);
  await post("2026-02-10", "-1+1 February supplies", [
    ["5000", "300.00", ""],
    ["1000", "", "300.00"],
  ]);

  // The calendar: the book's own basis and fiscal year.
  const calendar = await cli("reports", "calendar");
  expect(calendar.exit).toBe(0);
  expect(calendar.json.data).toMatchObject({
    basis: "cash",
    firstDate: "2025-10-01",
    lastDate: "2026-09-30",
  });

  // One statement, narrowed, with the facts that identify its population.
  const profit = await cli("reports", "profit-loss", "--as-of", "2026-03-31");
  expect(profit.exit).toBe(0);
  expect(profit.json.data.statement.netIncome).toBe("900.00");
  expect(profit.json.data.basis).toBe("cash");
  expect(profit.json.data.periodStart).toBe("2025-10-01");
  expect(profit.json.data.populationHash).toMatch(/^[0-9a-f]{64}$/);
  expect(profit.json.data.trialBalance).toBeUndefined();

  // A share of income is the service's figure, asked for with a flag and printed as it came. Income is
  // 1,200.00 and supplies 300.00: 25.0% of income; net income 900.00 is 75.0%; the income is all of itself.
  const shares = await cli("reports", "profit-loss", "--as-of", "2026-03-31", "--share", "income");
  expect(shares.exit).toBe(0);
  const byCode = (code: string) =>
    shares.json.data.statement.rows.find((row: { code: string }) => row.code === code);
  const byKey = (key: string) =>
    shares.json.data.statement.totals.find((total: { key: string }) => total.key === key);
  expect(byCode("4000")).toMatchObject({ amount: "1200.00", share: "100.0" });
  expect(byCode("5000")).toMatchObject({ amount: "300.00", share: "25.0" });
  expect(byKey("expense")).toMatchObject({ share: "25.0" });
  expect(byKey("netIncome")).toMatchObject({ amount: "900.00", share: "75.0" });
  expect(shares.json.data.warnings).toEqual([]);
  // Without the flag the reply has no share at all, and the flag is for the profit and loss alone.
  expect(JSON.stringify(profit.json.data)).not.toContain("hare");
  const sheet = await cli("reports", "balance-sheet", "--as-of", "2026-03-31", "--share", "income");
  expect(sheet.exit).toBe(2);
  expect(sheet.json.error.code).toBe("usage_error");
  const word = await cli("reports", "profit-loss", "--as-of", "2026-03-31", "--share", "revenue");
  expect(word.exit).toBe(2);
  // The file has the columns, and the formula in the account's name is still text.
  const shareCsv = await cli(
    "reports",
    "profit-loss",
    "--as-of",
    "2026-03-31",
    "--share",
    "income",
    "--format",
    "csv",
  );
  expect(shareCsv.exit).toBe(0);
  expect(shareCsv.out).toContain("Account ID,Code,Account,Type,Amount,% of income\r\n");
  expect(shareCsv.out).toContain(",,Net income,,900.00,75.0\r\n");
  expect(shareCsv.out).toContain("'=HYPERLINK(");

  // A range with a comparison, and the whole set.
  const quarter = await cli(
    "reports",
    "all",
    "--as-of",
    "2026-03-31",
    "--from",
    "2026-01-01",
    "--compare",
    "previous-period",
  );
  expect(quarter.exit).toBe(0);
  expect(quarter.json.data.profitAndLoss.netIncome).toBe("-300.00");
  expect(quarter.json.data.comparison).toMatchObject({
    kind: "previousPeriod",
    periodStart: "2025-10-01",
    asOf: "2025-12-31",
  });
  expect(quarter.json.data.balanceSheet.balanced).toBe(true);

  // The cash flow ties to the cash account and the general ledger holds every line.
  const flow = await cli("reports", "cash-flow", "--as-of", "2026-03-31");
  expect(flow.exit).toBe(0);
  expect(flow.json.data).toMatchObject({
    available: true,
    openingCash: "0.00",
    closingCash: "5900.00",
    ties: true,
  });
  const ledger = await cli("reports", "general-ledger", "--as-of", "2026-03-31");
  expect(ledger.exit).toBe(0);
  expect(ledger.json.data.count).toBe(6);

  // CSV is the service's own file, printed as it is: no envelope, and nothing a spreadsheet can run.
  const csv = await cli("reports", "trial-balance", "--as-of", "2026-03-31", "--format", "csv");
  expect(csv.exit).toBe(0);
  expect(csv.json).toBeNull();
  expect(csv.out.startsWith("Report,Trial balance\r\n")).toBe(true);
  expect(csv.out).toContain("Book,Reports CLI Co");
  expect(csv.out).toContain("Basis,cash");
  expect(csv.out).toContain("'=HYPERLINK(");
  const cells = csv.out.split("\r\n").flatMap((line) => line.split(","));
  expect(cells.some((cell) => /^[=+@]/.test(cell))).toBe(false);
  const ledgerCsv = await cli(
    "reports",
    "general-ledger",
    "--as-of",
    "2026-03-31",
    "--format",
    "csv",
  );
  expect(ledgerCsv.out).toContain("'-1+1 February supplies");

  // Refusals carry their code and the exit code the help promises.
  const accrual = await cli(
    "reports",
    "profit-loss",
    "--as-of",
    "2026-03-31",
    "--basis",
    "accrual",
  );
  expect(accrual.exit).toBe(3);
  expect(accrual.json.error.code).toBe("basis_unavailable");
  const outside = await cli("reports", "balance-sheet", "--as-of", "2027-01-31");
  expect(outside.exit).toBe(3);
  expect(outside.json.error.code).toBe("calendar_not_configured");
  const usage = await cli("reports", "profit-loss");
  expect(usage.exit).toBe(2);
  expect(usage.json.error.code).toBe("usage_error");
}, 90_000);

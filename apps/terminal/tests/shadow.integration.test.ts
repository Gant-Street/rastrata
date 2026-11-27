import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The real service and the real command: the Go client checks every response against the published
// contract, so this proves the CLI and the service agree, which a fake server cannot.
const directory = mkdtempSync(join(tmpdir(), "rastrata-shadow-cli-"));
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
  const body = (await response.json()) as { ok: boolean; data: unknown; error?: unknown };
  expect(body.ok, JSON.stringify(body.error)).toBe(true);
  return body.data;
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

test("the shadow commands start a real book from opening balances and say whether a month can close", async () => {
  await api(
    "book.setup",
    {
      name: "Shadow CLI Co",
      currency: "USD",
      fiscalYear: 2026,
      periodModel: "monthly",
      basis: "cash",
      accounts: [
        { code: "1000", name: "Business checking", role: "asset", tags: { cashFlowClass: "cash" } },
        { code: "2000", name: "Business credit card", role: "liability" },
        { code: "3000", name: "Owner's investment", role: "equity" },
        { code: "3900", name: "Opening balance equity", role: "equity" },
        { code: "4000", name: "Sales", role: "income" },
      ],
    },
    crypto.randomUUID(),
  );

  // The date first: every statement source of the accounts named starts on it.
  const bare = await cli("opening", "review", "--date", "2026-01-01", "--balances", "1000=1.00");
  expect(bare.exit).toBe(3);
  expect(bare.json.data.issues.map((issue: { code: string }) => issue.code)).toContain(
    "cutover_not_set",
  );
  const set = await cli("cutover", "set", "--date", "2026-01-01", "--accounts", "1000,2000");
  expect(set.exit, set.out + set.err).toBe(0);
  expect(set.err).toContain("Retaining");
  expect(set.json.data.sourcesSet).toBe(2);
  expect(set.json.data.state.cutover.cutoverDate).toBe("2026-01-01");
  expect(
    set.json.data.state.sources.map((s: { accountKey: string }) => s.accountKey).sort(),
  ).toEqual(["csv:1000", "csv:2000"]);

  // Balances as arguments and as a CSV: the same entry either way.
  const csv = join(directory, "balances.csv");
  writeFileSync(
    csv,
    'Code,Name,Debit,Credit\n1000,Business checking,"12,000.00",\n2000,Business credit card,,523.10\nTotal,,12000.00,523.10\n',
  );
  const fromArguments = await cli(
    "opening",
    "review",
    "--date",
    "2026-01-01",
    "--balances",
    "1000=12000.00,2000=523.10",
  );
  const fromFile = await cli("opening", "review", "--date", "2026-01-01", "--csv", csv);
  expect(fromArguments.exit, fromArguments.out + fromArguments.err).toBe(0);
  expect(fromFile.exit, fromFile.out + fromFile.err).toBe(0);
  expect(fromFile.json.data.contentHash).toBe(fromArguments.json.data.contentHash);
  expect(fromFile.json.data.offset).toMatchObject({ code: "3900", credit: "11476.90" });
  const text = await cli(
    "opening",
    "review",
    "--date",
    "2026-01-01",
    "--csv",
    csv,
    "--format",
    "text",
  );
  expect(text.exit).toBe(0);
  expect(text.out).toContain("Opening balances at the start of 2026-01-01 (USD)");
  expect(text.out).toContain("11,476.90");

  // Plan, then commit with the ordinary command: nothing posts until then.
  const plan = await cli("opening", "plan", "--date", "2026-01-01", "--csv", csv);
  expect(plan.exit, plan.out + plan.err).toBe(0);
  expect(plan.err).toContain("Prepared, not posted");
  const { planId, planHash } = plan.json.data.plan as { planId: string; planHash: string };
  expect(plan.err).toContain(`rastrata operations commit ${planId} ${planHash}`);
  const before = await cli("cutover", "show");
  expect(before.json.data.opening.status).toBe("planned");
  const done = await cli("operations", "commit", planId, planHash);
  expect(done.exit, done.out + done.err).toBe(0);
  expect(done.json.data.disposition).toBe("committed");
  const after = await cli("cutover", "show", "--format", "text");
  expect(after.out).toContain("Opening entry: posted");
  const again = await cli("opening", "plan", "--date", "2026-01-01", "--csv", csv);
  expect(again.exit).toBe(3);
  expect(again.json.error.code).toBe("opening_invalid");

  // The checklist: January has ended and nothing is reconciled or backed up.
  const checklist = await cli("cutover", "checklist");
  expect(checklist.exit, checklist.out + checklist.err).toBe(0);
  expect(checklist.json.data.verdict.state).toBe("not_yet");
  expect(checklist.json.data.period.label).toBe("January 2026");
  const codes = checklist.json.data.verdict.blocking.map((reason: { code: string }) => reason.code);
  expect(codes).toEqual(expect.arrayContaining(["never_reconciled", "no_verified_backup"]));
  const gate = await cli("cutover", "checklist", "--check");
  expect(gate.exit).toBe(3);
  const words = await cli("cutover", "checklist", "--format", "text");
  expect(words.out).toContain("Not yet:");
  expect(words.out).toContain("closing January 2026");
  expect(words.out).toContain("1000    Business checking");
}, 120_000);

test("the Xero commands map a chart, keep a trial balance and transactions, and tie the books out where Xero was reconciled", async () => {
  // The book of the first test: cut over on 2026-01-01 with 12,000.00 in the bank and 523.10 owed.
  const post = async (date: string, narration: string, lines: [string, string, string][]) => {
    const draft = (await api(
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
    )) as { id: string; version: number };
    const prepared = (await api(
      "journal.prepare",
      { draftId: draft.id, expectedVersion: draft.version },
      crypto.randomUUID(),
    )) as { planId: string; planHash: string };
    await api("operations.commit", { planId: prepared.planId, planHash: prepared.planHash });
  };
  await post("2026-01-15", "Customer payment", [
    ["1000", "100.00", ""],
    ["4000", "", "100.00"],
  ]);
  // A second sale that Xero never recorded.
  await post("2026-01-20", "Late sale", [
    ["1000", "25.00", ""],
    ["4000", "", "25.00"],
  ]);

  const chart = join(directory, "chart.csv");
  writeFileSync(
    chart,
    [
      "*Code,*Name,*Type,*Tax Code,Balance",
      "090,Business checking,Bank,Tax Exempt (0%),12100.00",
      "092,Business credit card,Bank,Tax Exempt (0%),-523.10",
      "200,Sales,Revenue,Tax Exempt (0%),-100.00",
      "960,Retained Earnings,Retained Earnings,Tax Exempt (0%),-11476.90",
    ].join("\n"),
  );
  const preview = await cli("xero", "chart", "--file", chart);
  expect(preview.exit, preview.out + preview.err).toBe(0);
  expect(preview.json.data.source).toBe("file");
  const row = (code: string) =>
    preview.json.data.accounts.find((account: { code: string }) => account.code === code);
  expect(row("090")).toMatchObject({ accountCode: "1000", confidence: "likely" });
  expect(row("092")).toMatchObject({ accountCode: "2000" });
  expect(row("960").accountId).toBeNull();
  const saved = await cli("xero", "chart", "--file", chart, "--import", "--accept", "likely");
  expect(saved.exit, saved.out + saved.err).toBe(0);
  expect(saved.err).toContain("Retaining");
  expect(saved.json.data.saved).toBe(3);
  const status = await cli("xero", "status", "--format", "text");
  expect(status.out).toContain("Mapping: 4 accounts, 3 mapped");

  // The trial balance as the list `opening review` takes, with the statement's balance for the bank.
  const tbDecember = join(directory, "tb-december.csv");
  writeFileSync(
    tbDecember,
    [
      "Trial Balance",
      "Shadow CLI Co",
      "As at 31 December 2025",
      "",
      "Account,Debit,Credit,YTD Debit,YTD Credit",
      "Business checking (090),,,12000.00,",
      "Business credit card (092),,,,523.10",
      "Retained Earnings (960),,,,11476.90",
      "Total,,,12000.00,12000.00",
    ].join("\n"),
  );
  const balances = await cli(
    "xero",
    "trial-balance",
    "--file",
    tbDecember,
    "--balances-only",
    "--statement",
    "1000=12000.00",
  );
  expect(balances.exit, balances.out + balances.err).toBe(0);
  expect(balances.out.trim().split(",").sort()).toEqual(["1000=12000.00", "2000=523.10"]);
  const tbText = await cli("xero", "trial-balance", "--file", tbDecember, "--format", "text");
  expect(tbText.exit, tbText.out + tbText.err).toBe(0);
  expect(tbText.out).toContain("Xero trial balance as at 2025-12-31");
  expect(tbText.out).toContain("retained earnings");

  // The month Xero says it reconciled, as it exported it.
  const tbJanuary = join(directory, "tb-january.csv");
  writeFileSync(
    tbJanuary,
    [
      "Trial Balance",
      "Shadow CLI Co",
      "As at 31 January 2026",
      "",
      "Account,Debit,Credit,YTD Debit,YTD Credit",
      "Business checking (090),100.00,,12100.00,",
      "Business credit card (092),,,,523.10",
      "Sales (200),,100.00,,100.00",
      "Retained Earnings (960),,,,11476.90",
      "Total,100.00,100.00,12100.00,12100.00",
    ].join("\n"),
  );
  const atJanuary = join(directory, "at-january.csv");
  writeFileSync(
    atJanuary,
    [
      "Account Transactions",
      "Shadow CLI Co",
      "For the period 1 January 2026 to 31 January 2026",
      "",
      "Date,Source,Description,Reference,Debit,Credit,Running Balance,Gross,GST",
      "Business checking (090)",
      "Opening Balance,,,,,,(12000.00),,",
      "15 Jan 2026,Receive Money,Customer payment,R1,100.00,,(12100.00),100.00,0.00",
      "Total Business checking (090),,,,100.00,0.00,,,",
      "Closing Balance,,,,,,(12100.00),,",
      "Sales (200)",
      "15 Jan 2026,Receivable Invoice,Customer payment,R1,,100.00,100.00,100.00,0.00",
      "Total Sales (200),,,,0.00,100.00,,,",
    ].join("\n"),
  );
  expect((await cli("xero", "trial-balance", "--file", tbJanuary, "--import")).exit).toBe(0);
  const imported = await cli("xero", "transactions", "--file", atJanuary, "--import");
  expect(imported.exit, imported.out + imported.err).toBe(0);
  expect(imported.json.data.stored).toBe(2);
  const reconciled = await cli("xero", "reconciled", "--set", "090=2026-01-31,092=2026-01-31");
  expect(reconciled.exit, reconciled.out + reconciled.err).toBe(0);

  // The tie-out: the bank and the sales differ by the sale Xero never had, and it says so line by line.
  const report = await cli("xero", "tie-out");
  expect(report.exit, report.out + report.err).toBe(0);
  const january = report.json.data.periods.find(
    (period: { from: string }) => period.from === "2026-01-01",
  );
  const account = (code: string) =>
    january.accounts.find((item: { code: string }) => item.code === code);
  expect(account("2000")).toMatchObject({ status: "matches", xero: "523.10" });
  expect(account("1000")).toMatchObject({
    status: "differs",
    difference: "25.00",
    explained: true,
    unmatchedCount: 1,
  });
  expect(account("1000").unmatched[0]).toMatchObject({
    side: "rastrata",
    date: "2026-01-20",
    debit: "25.00",
  });
  const text = await cli("xero", "tie-out", "--format", "text");
  expect(text.out).toContain("differs by 25.00 (explained to the cent)");
  expect(text.out).toContain("only in Rastrata");

  // Recorded as gaps once, closed with a note, and not reopened by running the tie-out again.
  const recorded = await cli("xero", "tie-out", "--record");
  expect(recorded.exit, recorded.out + recorded.err).toBe(0);
  expect(recorded.json.data.added).toBe(2);
  const again = await cli("xero", "tie-out", "--record");
  expect(again.json.data).toMatchObject({ added: 0, existing: 2 });
  const gapId = recorded.json.data.gaps[0].id as number;
  const refused = await cli("gaps", "close", String(gapId));
  expect(refused.exit).toBe(2);
  const closed = await cli(
    "gaps",
    "close",
    String(gapId),
    "--resolution",
    "Xero never recorded it; the statement has it.",
  );
  expect(closed.exit, closed.out + closed.err).toBe(0);
  await cli("xero", "tie-out", "--record");
  const open = await cli("gaps", "list", "--format", "text");
  expect(open.out).toContain("1 open, 1 closed.");
  const added = await cli("gaps", "add", "--title", "Xero tracks projects", "--kind", "feature");
  expect(added.exit, added.out + added.err).toBe(0);
}, 120_000);

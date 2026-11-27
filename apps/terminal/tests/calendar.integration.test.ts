import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The real service and the real commands: the Go client checks every response against the published
// contract, so this proves the CLI and the service agree, which a fake server cannot. The book is an
// October cash book, so the fiscal years do not match the calendar years.
const directory = mkdtempSync(join(tmpdir(), "rastrata-calendar-cli-"));
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

async function cli(args: string[], input?: unknown) {
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
  expect(stdout.trim().split("\n"), "stdout carries exactly one envelope").toHaveLength(1);
  return { exit, body: JSON.parse(stdout), stderr };
}

async function post(date: string, amount: string, accounts: [string, string]) {
  const draft = (
    await cli(["drafts", "create"], {
      data: {
        date,
        reference: `P-${date}`,
        narration: `Posting ${date}`,
        lines: [
          { accountId: accounts[0], debit: amount, credit: "" },
          { accountId: accounts[1], debit: "", credit: amount },
        ],
      },
    })
  ).body.data;
  return cli(["journal", "prepare"], { draftId: draft.id, expectedVersion: draft.version });
}
async function postAndCommit(date: string, amount: string, accounts: [string, string]) {
  const prepared = await post(date, amount, accounts);
  expect(prepared.exit, JSON.stringify(prepared.body)).toBe(0);
  const { planId, planHash } = prepared.body.data;
  const committed = await cli(["operations", "commit", planId, planHash]);
  expect(committed.body.data.disposition).toBe("committed");
}

test("an October cash book is extended, posted into, and closed a year at a time from the command line", async () => {
  const setup = await cli(["book", "setup"], {
    name: "October Cash Co",
    currency: "USD",
    fiscalYear: 2026,
    fiscalYearStartMonth: 10,
    basis: "cash",
    periodModel: "monthly",
    accounts: [
      { code: "1000", name: "Cash", role: "asset" },
      { code: "3000", name: "Capital", role: "equity" },
      { code: "4000", name: "Revenue", role: "income" },
      { code: "5000", name: "Expense", role: "expense" },
    ],
  });
  expect(setup.exit).toBe(0);
  expect(setup.body.data.setup).toMatchObject({ basis: "cash", fiscalYearStartMonth: 10 });
  expect((await cli(["capabilities"])).body.data).toMatchObject({
    basis: "cash",
    fiscalYearStartMonth: 10,
  });
  await postAndCommit("2026-10-05", "1000.00", ["1000", "3000"]);
  await postAndCommit("2027-01-20", "300.00", ["1000", "4000"]);
  await postAndCommit("2027-09-30", "80.00", ["5000", "1000"]);

  const list = (await cli(["periods", "list"])).body.data;
  expect(list.calendar).toMatchObject({
    firstDate: "2026-10-01",
    lastDate: "2027-09-30",
    fiscalYearStartMonth: 10,
    canExtend: true,
    nextFiscalYear: 2027,
    nextStartsOn: "2027-10-01",
  });
  expect(list.periods).toHaveLength(12);

  // A date past the calendar fails with a code and a hint a script can read.
  const outside = await post("2027-10-15", "5.00", ["1000", "4000"]);
  expect(outside.exit).toBe(3);
  expect(outside.body.error.code).toBe("calendar_not_configured");
  expect(outside.body.error.details.at(-1)).toEqual({ path: "extendThrough", message: "2027" });
  expect(outside.body.error.message).toContain("periods.extend");

  // Prepare, then commit the exact plan; the identity is announced and the plan is reviewable.
  const prepared = await cli(["periods", "extend"]);
  expect(prepared.exit).toBe(0);
  expect(prepared.stderr).toContain("Retaining");
  expect(prepared.body.data.effects.calendar).toHaveLength(12);
  expect(prepared.body.data.effects.calendar[0]).toMatchObject({
    periodId: "period-2027-01",
    startsOn: "2027-10-01",
  });
  expect((await cli(["periods", "list"])).body.data.periods).toHaveLength(12);
  const extended = await cli([
    "periods",
    "extend",
    "--operation-id",
    prepared.body.operationId,
    "--commit",
    "--plan-hash",
    prepared.body.data.planHash,
  ]);
  expect(extended.exit).toBe(0);
  expect(extended.body.data.disposition).toBe("committed");
  expect(extended.stderr).toContain("adds 12 periods, 2027-10-01 to 2028-09-30");
  expect((await cli(["periods", "list"])).body.data.periods).toHaveLength(24);
  // Asking for a year that is covered now is an error, not an empty plan.
  const again = await cli(["periods", "extend", "--through", "2027"]);
  expect(again.exit).toBe(3);
  expect(again.body.error.code).toBe("calendar_already_covers");
  await postAndCommit("2027-10-15", "5.00", ["1000", "4000"]);

  // Year-end: review first, then run the same request with --commit and the reviewed hash.
  const review = await cli([
    "periods",
    "year-end",
    "2026",
    "--reason",
    "Reviewed with my accountant",
  ]);
  expect(review.exit).toBe(0);
  expect(review.body.data).toMatchObject({
    valid: true,
    fiscalYear: 2026,
    startsOn: "2026-10-01",
    endsOn: "2027-09-30",
    openCount: 12,
  });
  expect(review.body.data.statements).toMatchObject({
    basis: "cash",
    revenue: "300.00",
    expenses: "80.00",
    netIncome: "220.00",
  });
  const flags = [
    "periods",
    "year-end",
    "2026",
    "--reason",
    "Reviewed with my accountant",
    "--operation-id",
    review.body.operationId,
    "--commit",
    "--plan-hash",
    review.body.data.planHash,
  ];
  const closed = await cli(flags);
  expect(closed.exit).toBe(0);
  expect(closed.body.data).toMatchObject({
    disposition: "committed",
    closedCount: 12,
    totalCount: 12,
  });
  expect(closed.stderr).toContain(
    "Committing the year-end of fiscal year 2026: 12 periods in order",
  );
  const after = (await cli(["periods", "list"])).body.data;
  expect(after.calendar.fiscalYears[0]).toMatchObject({ fiscalYear: 2026, status: "closed" });
  expect(after.calendar.fiscalYears[1]).toMatchObject({ fiscalYear: 2027, status: "open" });
  // Running the same command again resumes: the same identities give the same receipt, nothing repeats.
  const rerun = await cli(flags);
  expect(rerun.exit).toBe(0);
  expect(rerun.body.data).toEqual(closed.body.data);
  expect((await cli(["periods", "list"])).body.data.history).toHaveLength(12);
  // A new request for a closed year is refused with the way out.
  const refused = await cli(["periods", "year-end", "2026", "--reason", "Again"]);
  expect(refused.exit).toBe(3);
  expect(refused.body.error.code).toBe("year_already_closed");
  // And a posting into the closed year is a prepared-but-invalid plan, exit 3.
  const into = await post("2026-11-10", "1.00", ["1000", "4000"]);
  expect(into.exit).toBe(3);
  expect(into.body.data.valid).toBe(false);
  expect((await cli(["periods", "year-end"])).exit).toBe(2);
}, 120_000);

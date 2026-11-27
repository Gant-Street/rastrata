import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** The real CLI, the real service and the real ingestion pipeline: a statement file goes in at one
 * end and lines waiting for review come out of the other. */

const directory = mkdtempSync(join(tmpdir(), "rastrata-terminal-import-"));
const binary = join(directory, "rastrata");
const root = resolve(import.meta.dir, "../../..");
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = probe.port;
await probe.stop();
const endpoint = `http://127.0.0.1:${port}`;
let server: ReturnType<typeof Bun.spawn>;

async function cli(args: string[], stdin?: string) {
  const run = Bun.spawn(
    [binary, ...args, "--endpoint", endpoint, "--request-dir", join(directory, "requests")],
    {
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, exit] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  return { out, err, exit, json: out.trim() ? JSON.parse(out) : null };
}

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
      if ((await fetch(`${endpoint}/health`)).ok) break;
    } catch {}
    await Bun.sleep(50);
  }
  const setup = {
    name: "Import Co",
    currency: "USD",
    fiscalYear: 2026,
    periodModel: "monthly",
    accounts: [
      { code: "1010", name: "Chase Checking", role: "asset" },
      { code: "2100", name: "Business Card", role: "liability" },
      { code: "3000", name: "Owner capital", role: "equity" },
      { code: "4000", name: "Sales", role: "income" },
    ],
  };
  const response = await cli(["book", "setup", "--input", "-"], JSON.stringify(setup));
  expect(response.exit, response.out).toBe(0);
}, 60_000);

afterAll(async () => {
  server?.kill();
  await server?.exited;
  rmSync(directory, { recursive: true, force: true });
});

const CHASE = [
  "Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #",
  "DEBIT,01/09/2026,RENT PAYMENT ACH WEWORK,-750.00,ACH_DEBIT,1450.00,,",
  "CREDIT,01/07/2026,ACH CREDIT NORTHWIND LLC,1200.00,ACH_CREDIT,2200.00,,",
  "DEBIT,01/05/2026,STAPLES 00123 AUSTIN TX,-50.00,DEBIT_CARD,1000.00,,",
  "",
].join("\n");

test("a statement is previewed, imported, and imported again without adding anything", async () => {
  const file = join(directory, "Chase1234_Activity.csv");
  writeFileSync(file, CHASE);

  const dry = await cli(["import", file, "--account", "Chase Checking", "--dry-run=true"]);
  expect(dry.exit, dry.out + dry.err).toBe(0);
  expect(dry.json.data).toMatchObject({
    valid: true,
    format: "csv",
    detection: { how: "preset", preset: { id: "chase-checking", verified: false } },
    counts: { lines: 3, new: 3 },
    totals: { moneyIn: "1200.00", moneyOut: "-800.00", net: "400.00" },
    file: { name: "Chase1234_Activity.csv" },
  });
  expect(dry.err).toContain("unverified");

  const first = await cli(["import", file, "--account", "1010"]);
  expect(first.exit, first.out + first.err).toBe(0);
  expect(first.json.data).toMatchObject({
    waiting: 3,
    counts: { new: 3 },
    message: "3 lines are waiting in your Inbox.",
  });
  expect(first.json.operationId).toMatch(/^[0-9a-f-]{36}$/);

  // The same bytes again, as a different request: nothing new.
  const again = await cli(["import", file, "--account", "1010"]);
  expect(again.exit, again.out + again.err).toBe(0);
  expect(again.json.data.waiting).toBe(0);
  expect(again.json.data.message).toContain("Nothing new");

  // An overlapping file adds only the lines it has that the first did not.
  const overlap = join(directory, "later.csv");
  writeFileSync(
    overlap,
    `${CHASE}CREDIT,01/12/2026,ACH CREDIT NORTHWIND LLC,300.00,ACH_CREDIT,1750.00,,\n`,
  );
  const later = await cli(["import", overlap, "--account", "1010"]);
  expect(later.json.data.counts).toMatchObject({ new: 1, overlap: 3 });
}, 60_000);

test("a file that cannot be read is refused with exit 3 and a reason, and a typo in the account lists the choices", async () => {
  const bad = join(directory, "bad.csv");
  writeFileSync(bad, "Date,Description,Amount\n01/15/2026,GOOD,-1.00\n01/16/2026,BAD,1.234\n");
  const preview = await cli(["import", bad, "--account", "1010", "--dry-run=true"]);
  expect(preview.exit).toBe(3);
  expect(preview.json.data.valid).toBe(false);
  expect(preview.json.data.diagnostics[0]).toMatchObject({ severity: "error", row: 3 });
  const refused = await cli(["import", bad, "--account", "1010"]);
  expect(refused.exit).toBe(3);
  expect(refused.json.error.code).toBe("import_blocked");
  const skipping = await cli(["import", bad, "--account", "1010", "--skip-invalid-rows=true"]);
  expect(skipping.exit, skipping.out).toBe(0);
  expect(skipping.json.data.counts).toMatchObject({ lines: 1, skipped: 1 });

  const typo = await cli(["import", bad, "--account", "Checking Account"]);
  expect(typo.exit).toBe(2);
  expect(typo.json.error.message).toContain("1010 Chase Checking");
}, 60_000);

test("a binary file is turned away with a plain message, and presets and profiles are listed", async () => {
  const pdf = join(directory, "statement.pdf");
  writeFileSync(pdf, "%PDF-1.7\nnot a statement\n");
  const refused = await cli(["import", pdf, "--account", "1010", "--dry-run=true"]);
  expect(refused.json.error?.code ?? refused.json.data.diagnostics[0].message).toBeTruthy();
  const presets = await cli(["import", "presets"]);
  expect(presets.exit).toBe(0);
  expect(presets.json.data.presets.slice(0, 2).map((item: { id: string }) => item.id)).toEqual([
    "chase-checking",
    "chase-card",
  ]);
  const profiles = await cli(["import", "profiles"]);
  expect(profiles.json.data.profiles).toEqual([]);
}, 60_000);

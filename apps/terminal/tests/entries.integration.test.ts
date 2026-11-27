import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** The real CLI and the real service: the Go client checks every response against the published
 * contract, so this proves `inbox undo` and `book update` agree with the service, which a fake
 * server cannot. A line is imported, categorized, posted, undone and posted again. */

const directory = mkdtempSync(join(tmpdir(), "rastrata-terminal-entries-"));
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
    name: "Entries Co",
    currency: "USD",
    fiscalYear: 2026,
    periodModel: "monthly",
    accounts: [
      { code: "1010", name: "Chase Checking", role: "asset" },
      { code: "3000", name: "Owner capital", role: "equity" },
      { code: "4000", name: "Sales", role: "income" },
      { code: "5000", name: "Software", role: "expense" },
      { code: "5100", name: "Meals", role: "expense" },
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

test("book update renames the business and changes the display settings, and says what changed", async () => {
  const first = await cli([
    "book",
    "update",
    "--name=Willow Lane Studio",
    "--date-format=numeric",
    "--show-account-numbers=true",
    "--accept=draft",
  ]);
  expect(first.exit, first.out + first.err).toBe(0);
  expect(first.json.data).toEqual({
    name: "Willow Lane Studio",
    settings: { dateFormat: "numeric", showAccountNumbers: true, acceptMode: "draft" },
    changed: ["name", "dateFormat", "showAccountNumbers", "acceptMode"],
    previousName: "Entries Co",
  });
  const context = await cli(["context"]);
  expect(context.json.data.setup.name).toBe("Willow Lane Studio");
  expect(context.json.data.settings).toEqual(first.json.data.settings);

  // The same again changes nothing, and nonsense is refused before it is sent.
  const same = await cli(["book", "update", "--name=Willow Lane Studio"]);
  expect(same.json.data.changed).toEqual([]);
  const none = await cli(["book", "update"]);
  expect(none.exit).toBe(2);
  const bad = await cli(["book", "update", "--accept=both"]);
  expect(bad.exit).toBe(2);
  const short = await cli(["book", "update", "--name=A"]);
  expect(short.exit).not.toBe(0);
  expect(short.json.error.code).toBe("invalid_input");
}, 60_000);

test("a posted line is undone from the terminal, and posted again", async () => {
  const file = join(directory, "Chase1234_Activity.csv");
  writeFileSync(
    file,
    [
      "Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #",
      "DEBIT,01/09/2026,NOTION LABS,-25.00,ACH_DEBIT,975.00,,",
      "",
    ].join("\n"),
  );
  const imported = await cli(["import", file, "--account", "Chase Checking"]);
  expect(imported.exit, imported.out + imported.err).toBe(0);
  const list = await cli(["inbox", "list", "--status=new,proposed"]);
  const id = list.json.data.items[0].id as string;

  const categorized = await cli(["inbox", "categorize", id, "--account=5000"]);
  expect(categorized.json.data.applied).toBe(1);
  const posted = await cli(["inbox", "post", id]);
  expect(posted.json.data.results[0]).toMatchObject({ outcome: "applied", status: "posted" });
  const journalId = posted.json.data.results[0].journalId as string;

  const undone = await cli(["inbox", "undo", id, "--reason=Wrong category"]);
  expect(undone.exit, undone.out + undone.err).toBe(0);
  expect(undone.err).toContain("Retaining");
  expect(undone.json.data).toMatchObject({ applied: 1, skipped: 0, failed: 0, remaining: 0 });
  expect(undone.json.data.results[0]).toMatchObject({
    itemId: id,
    outcome: "applied",
    status: "new",
    journalId,
  });
  const reversal = undone.json.data.results[0].reversalJournalId as string;
  const shown = await cli(["inbox", "show", id]);
  expect(["new", "proposed"]).toContain(shown.json.data.item.status);
  const last = shown.json.data.history.at(-1);
  expect(last).toMatchObject({
    kind: "undo",
    by: "owner",
    journalId,
    reversalJournalId: reversal,
    reason: "Wrong category",
  });

  // Undoing it again changes nothing. Posting it again, to another account, works.
  const again = await cli(["inbox", "undo", id]);
  expect(again.json.data.results[0]).toMatchObject({ outcome: "skipped", code: "wrong_status" });
  const second = await cli(["inbox", "categorize", id, "--account=5100"]);
  expect(second.json.data.applied, second.out).toBe(1);
  const repost = await cli(["inbox", "post", id]);
  expect(repost.json.data.results[0]).toMatchObject({ outcome: "applied", status: "posted" });
  expect(repost.json.data.results[0].journalId).not.toBe(journalId);
  // The entry, its reversal and the entry posted again: nothing was deleted.
  const entries = await cli(
    ["journal", "list", "--input", "-"],
    JSON.stringify({ status: "Posted" }),
  );
  expect(entries.json.data.count).toBe(3);
}, 60_000);

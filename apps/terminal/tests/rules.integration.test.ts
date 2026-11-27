import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The real service and the real command: the Go client checks every response against the
// published contract, so this proves the CLI and the service agree, which a fake server cannot.
const directory = mkdtempSync(join(tmpdir(), "rastrata-rules-cli-"));
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
type Json = Awaited<ReturnType<Response["json"]>>;
async function api(name: string, input: unknown, operationId?: string): Promise<Json> {
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
  const body = (await response.json()) as { ok: boolean; data: Json; error?: unknown };
  expect(body.ok, JSON.stringify(body.error)).toBe(true);
  return body.data;
}
let posted = 0;
async function post(date: string, memo: string, amount: string, account: string) {
  const out = amount.startsWith("-");
  const size = amount.replace("-", "");
  const id = `cli-rules-${++posted}`;
  const draft = await api(
    "drafts.create",
    {
      data: {
        date,
        reference: id,
        narration: memo,
        source: { id, description: memo },
        lines: [
          { accountId: out ? account : "1000", debit: size, credit: "" },
          { accountId: out ? "1000" : account, debit: "", credit: size },
        ],
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

async function cli(args: string[], stdin = "") {
  const run = Bun.spawn(
    [binary, ...args, "--endpoint", endpoint, "--request-dir", join(directory, "requests")],
    { stdout: "pipe", stderr: "pipe", stdin: new Blob([stdin]) },
  );
  const [out, err] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  const exit = await run.exited;
  return { exit, out, err, json: (out.trim().startsWith("{") ? JSON.parse(out) : {}) as Json };
}

test("an agent can find, test, create and manage a rule, and train the classifier, from the command line", async () => {
  await api(
    "book.setup",
    {
      name: "Rules CLI Co",
      currency: "USD",
      fiscalYear: 2026,
      periodModel: "monthly",
      accounts: [
        { code: "1000", name: "Checking", role: "asset" },
        { code: "3000", name: "Capital", role: "equity" },
        { code: "4000", name: "Sales", role: "income" },
        { code: "6100", name: "Software", role: "expense" },
        { code: "6200", name: "Hosting", role: "expense" },
      ],
    },
    crypto.randomUUID(),
  );
  await post("2026-01-02", "Owner contribution", "5000.00", "3000");
  for (const [date, memo, amount, account] of [
    ["2026-02-02", "GITHUB, INC. SAN FRANCISCO CA", "-4.00", "6100"],
    ["2026-03-02", "GITHUB, INC. SAN FRANCISCO CA", "-4.00", "6100"],
    ["2026-04-02", "GITHUB, INC. SAN FRANCISCO CA", "-4.00", "6100"],
    ["2026-05-02", "GITHUB, INC. SAN FRANCISCO CA", "-4.00", "6100"],
    ["2026-03-05", "AWS EMEA 123456", "-61.20", "6200"],
    ["2026-04-05", "AWS EMEA 654321", "-58.00", "6200"],
  ] as const)
    await post(date, memo, amount, account);

  // The agent first looks at what exists, then asks for a candidate from one line.
  const empty = await cli(["rules", "list"]);
  expect(empty.exit, empty.out).toBe(0);
  expect(empty.json.data.count).toBe(0);

  const suggested = await cli([
    "rules",
    "suggest",
    "--description",
    "GITHUB, INC. 8F2K3 SAN FRANCISCO CA",
    "--amount",
    "-4.00",
  ]);
  expect(suggested.exit, suggested.out).toBe(0);
  expect(suggested.json.data.rule.conditions[0]).toMatchObject({
    operator: "contains",
    value: "github",
  });
  // History says GitHub has always been Software, so the candidate already names the account.
  expect(suggested.json.data.rule.action.accountId).toBe("6100");

  // The suggestion's output is the next command's input.
  const tested = await cli(["rules", "test", "--input", "-", "--days", "365"], suggested.out);
  expect(tested.exit, tested.out).toBe(0);
  expect(tested.json.data.history.matched).toBe(4);
  expect(tested.json.data.agreement).toEqual({ agreed: 4, differed: 0, notComparable: 0 });

  const created = await cli(
    ["rules", "create", "--input", "-", "--agent", "claude-code"],
    suggested.out,
  );
  expect(created.exit, created.out).toBe(0);
  const rule = created.json.data as Json;
  expect(rule.createdBy).toEqual({ kind: "agent", name: "claude-code" });
  expect(rule.revision).toBe(1);
  expect(created.err).toContain("Retaining");

  // A person writes one from flags.
  const aws = await cli([
    "rules",
    "create",
    "--name",
    "AWS",
    "--contains",
    "aws emea",
    "--direction",
    "out",
    "--category",
    "6200",
    "--narration",
    "Hosting: {merchant}",
  ]);
  expect(aws.exit, aws.out).toBe(0);
  expect(aws.json.data.createdBy).toEqual({ kind: "person" });

  // Usage over the last year: GitHub's rule decides four lines, AWS's two.
  const usage = await cli(["rules", "list", "--usage", "--days", "365"]);
  expect(usage.exit, usage.out).toBe(0);
  const used = new Map<string, Json>(
    (usage.json.data.rules as Json[]).map((entry) => [entry.name, entry.usage]),
  );
  expect(used.get("Github")).toMatchObject({ matched: 4, decided: 4, shadowed: 0 });
  expect(used.get("AWS")).toMatchObject({ matched: 2, decided: 2 });
  expect(usage.json.data.window).toMatchObject({ considered: 7, decided: 6 });

  // A stale revision is a conflict, never a silent overwrite.
  const stale = await cli(["rules", "update", rule.id, "--name", "Renamed", "--version", "5"]);
  expect(stale.exit).toBe(3);
  expect(stale.json.error.code).toBe("rule_revision_conflict");
  const renamed = await cli(["rules", "update", rule.id, "--name", "GitHub subscriptions"]);
  expect(renamed.exit, renamed.out).toBe(0);
  expect(renamed.json.data).toMatchObject({ name: "GitHub subscriptions", revision: 2 });
  expect(renamed.err).toContain("current revision 1");

  // Order, switches and retirement.
  const moved = await cli(["rules", "move", aws.json.data.id, "--to", "1"]);
  expect(moved.exit, moved.out).toBe(0);
  expect((moved.json.data.rules as Json[]).map((entry) => entry.name)).toEqual([
    "AWS",
    "GitHub subscriptions",
  ]);
  const off = await cli(["rules", "disable", aws.json.data.id]);
  expect(off.exit, off.out).toBe(0);
  expect(off.json.data.enabled).toBe(false);
  const noReason = await cli(["rules", "delete", aws.json.data.id]);
  expect(noReason.exit).toBe(2);
  const gone = await cli([
    "rules",
    "delete",
    aws.json.data.id,
    "--reason",
    "Replaced by a broader rule",
  ]);
  expect(gone.exit, gone.out).toBe(0);
  expect(gone.json.data.status).toBe("deleted");
  const shown = await cli(["rules", "show", aws.json.data.id]);
  expect(shown.json.data.history.map((entry: Json) => entry.changed)).toEqual([
    ["created"],
    ["enabled"],
    ["deleted"],
  ]);

  // The classifier learns from the same posted history and measures itself.
  const before = await cli(["classifier", "status"]);
  expect(before.exit, before.out).toBe(0);
  expect(before.json.data.ready).toBe(false);
  const trained = await cli(["classifier", "train"]);
  expect(trained.exit, trained.out).toBe(0);
  expect(trained.json.data).toMatchObject({ examples: 7, accounts: 3, ready: true });
  expect(trained.json.data.sources).toEqual({ posted: 7, decisions: 0 });
  const evaluated = await cli(["classifier", "evaluate", "--min-agreement", "80"]);
  expect(evaluated.exit, evaluated.out).toBe(0);
  expect(evaluated.json.data.config.minAgreement).toBe(80);
  const configured = await cli(["classifier", "configure", "--min-examples", "2"]);
  expect(configured.exit, configured.out).toBe(0);
  expect(configured.json.data.config.minExamples).toBe(2);

  // Everything above is reachable by name in help, and unknown input is a usage error, not a guess.
  const help = await cli(["help"]);
  expect(help.out).toContain("rules suggest");
  const bad = await cli(["rules", "create", "--name", "X", "--regex", ".*"]);
  expect(bad.exit).toBe(2);
}, 120_000);

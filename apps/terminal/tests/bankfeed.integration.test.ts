import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The real command, the real service and a stand-in SimpleFIN Bridge on this machine: the Go client
// checks every response against the published contract, so this proves the CLI and the service agree,
// which a fake application server cannot. The service is told, through its environment, the one
// address on this machine it may speak to over http; everything else about the Bridge is as in the
// unit tests (nothing here is a real credential, bank or account).
const directory = mkdtempSync(join(tmpdir(), "rastrata-bankfeed-cli-"));
const binary = join(directory, "rastrata");
const root = resolve(import.meta.dir, "../../..");
const probes = [0, 1].map(() =>
  Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }),
);
const [apiPort, fakePort] = probes.map((probe) => probe.port) as [number, number];
for (const probe of probes) await probe.stop();
const endpoint = `http://127.0.0.1:${apiPort}`;
const bridge = `http://127.0.0.1:${fakePort}`;
let server: ReturnType<typeof Bun.spawn>;
let fakeServer: ReturnType<typeof Bun.spawn>;

async function waitFor(url: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error(`${url} did not come up`);
}

beforeAll(async () => {
  const build = Bun.spawn([process.env.GO_BIN ?? "go", "build", "-o", binary, "./cmd/rastrata"], {
    cwd: resolve(root, "apps/terminal"),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await build.exited).toBe(0);
  fakeServer = Bun.spawn(
    [process.execPath, "packages/application/test/bankfeed/serve-fake-simplefin.ts"],
    {
      cwd: root,
      env: { ...Bun.env, RASTRATA_FAKE_SIMPLEFIN_PORT: String(fakePort) },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  server = Bun.spawn([process.execPath, "apps/api/src/main.ts"], {
    cwd: root,
    env: {
      ...Bun.env,
      RASTRATA_LOCAL_DEV: "1",
      RASTRATA_API_PORT: String(apiPort),
      RASTRATA_LOCAL_DB: join(directory, "book.sqlite"),
      RASTRATA_SIMPLEFIN_STANDIN: bridge,
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  await waitFor(`${bridge}/__fake/token`);
  await waitFor(`${endpoint}/health`);
}, 60_000);

afterAll(() => {
  server?.kill();
  fakeServer?.kill();
  rmSync(directory, { recursive: true, force: true });
});

const version = "rastrata-application-v1";
/** Parsed JSON, typed the way `Response.json()` types it, so the checks below can read fields freely. */
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
  const body = await response.json();
  expect(body.ok, JSON.stringify(body.error)).toBe(true);
  return body.data;
}

/** The stand-in Bridge's control routes. */
async function fake(method: "GET" | "POST", path: string, body?: unknown): Promise<Json> {
  const response = await fetch(`${bridge}/__fake/${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  expect(response.ok, path).toBe(true);
  return response.json();
}

async function cli(args: string[], input?: string) {
  const run = Bun.spawn(
    [binary, ...args, "--endpoint", endpoint, "--request-dir", join(directory, "requests")],
    {
      stdout: "pipe",
      stderr: "pipe",
      stdin: input === undefined ? "ignore" : new Blob([input]),
    },
  );
  const [out, err] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  const exit = await run.exited;
  return { exit, out, err, json: out.trim().startsWith("{") ? JSON.parse(out) : null };
}

/** Every file under a folder, as text; a database's bytes are read as latin1 so a secret in them is found. */
function everythingUnder(folder: string): string {
  if (!existsSync(folder)) return "";
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name)).toString("latin1"))
    .join("\n");
}

const chart: Record<string, string> = {};
let secrets: { accessUrl: string; user: string; password: string };
let setupToken = "";

test("the setup token is never an argument, and a token in a file connects the Bridge", async () => {
  await api(
    "book.setup",
    {
      name: "Feed CLI Co",
      currency: "USD",
      fiscalYear: 2026,
      periodModel: "monthly",
      accounts: [
        { code: "1000", name: "Business Checking", role: "asset" },
        { code: "1100", name: "Business Savings", role: "asset" },
        { code: "3000", name: "Owner's equity", role: "equity" },
        { code: "4000", name: "Sales", role: "income" },
        { code: "5000", name: "Software", role: "expense" },
      ],
    },
    crypto.randomUUID(),
  );
  const accounts = (await api("accounts.list", {})).accounts as { code: string; id: string }[];
  for (const account of accounts) chart[account.code] = account.id;
  secrets = (await fake("GET", "access")) as typeof secrets;
  setupToken = (await fake("GET", "token")).setupToken;

  // Not connected yet, and the status says so without asking the Bridge.
  const before = await cli(["bankfeed", "status"]);
  expect(before.exit, before.out + before.err).toBe(0);
  expect(before.json.data).toMatchObject({ connected: false, scheduler: true });

  // As an argument it is refused, with the reason, and nothing is sent.
  const refused = await cli(["bankfeed", "connect", "--token", setupToken]);
  expect(refused.exit).toBe(2);
  expect(refused.out + refused.err).toContain("ps");
  expect(refused.out + refused.err).not.toContain(setupToken);
  expect((await fake("GET", "log")).requests).toHaveLength(0);

  const file = join(directory, "token.txt");
  writeFileSync(file, `${setupToken}\n`, { mode: 0o600 });
  const connected = await cli(["bankfeed", "connect", "--token-file", file]);
  expect(connected.exit, connected.out + connected.err).toBe(0);
  expect(connected.json.data.connected).toBe(true);
  expect(connected.json.data.host).toContain("127.0.0.1");
  expect(connected.json.data.accounts.map((a: { id: string }) => a.id).sort()).toEqual([
    "ACT-checking-0001",
    "ACT-euro-0003",
    "ACT-savings-0002",
  ]);
  // Every account is listed and none is linked: nothing is read until the owner chooses.
  expect(connected.json.data.accounts.every((a: { state: string }) => a.state === "unlinked")).toBe(
    true,
  );
  // The token worked once; it is spent at the Bridge now.
  expect((await cli(["bankfeed", "connect", "--token-file", file])).exit).not.toBe(0);
  rmSync(file);
}, 60_000);

test("the access URL is in a private file beside the book and nowhere else", async () => {
  const credential = join(directory, "simplefin.access");
  expect(existsSync(credential)).toBe(true);
  expect(statSync(credential).mode & 0o777).toBe(0o600);
  expect(readFileSync(credential, "utf8")).toContain(secrets.password);

  // Not in the book (its file, its journal of changes), not in anything the command kept, and not in
  // anything it printed.
  for (const name of ["book.sqlite", "book.sqlite-wal", "book.sqlite-shm"]) {
    const path = join(directory, name);
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path).toString("latin1");
    for (const secret of [secrets.password, secrets.user, setupToken])
      expect(bytes.includes(secret), `${name} holds a secret`).toBe(false);
  }
  const kept = everythingUnder(join(directory, "requests"));
  for (const secret of [secrets.password, secrets.user, setupToken])
    expect(kept.includes(secret), "the request journal holds a secret").toBe(false);
  const status = await cli(["bankfeed", "status"]);
  expect(status.json.data.credential).toMatchObject({ present: true });
  for (const secret of [secrets.password, secrets.user, secrets.accessUrl, setupToken])
    expect(status.out + status.err).not.toContain(secret);
});

test("linking chooses what is read; an unlinked account is never fetched", async () => {
  const linked = await cli([
    "bankfeed",
    "link",
    "--account",
    "ACT-checking-0001",
    "--to",
    chart["1000"] ?? "",
    "--from",
    "2026-09-01",
  ]);
  expect(linked.exit, linked.out + linked.err).toBe(0);
  expect(linked.json.data.account).toMatchObject({
    id: "ACT-checking-0001",
    state: "linked",
    link: { startOn: "2026-09-01" },
  });

  const synced = await cli(["bankfeed", "sync"]);
  expect(synced.exit, synced.out + synced.err).toBe(0);
  const run = synced.json.data.run;
  expect(run).toMatchObject({ disposition: "complete", trigger: "manual", newLines: 11 });

  // Only the linked account was asked for, window by window; the others were listed, not read.
  const requests = (await fake("GET", "log")).requests as {
    query: Record<string, string[]>;
  }[];
  const reads = requests.filter((entry) => entry.query["start-date"] !== undefined);
  expect(reads.length).toBeGreaterThan(0);
  for (const read of reads) expect(read.query.account).toEqual(["ACT-checking-0001"]);

  // The lines are in the Inbox, waiting. Nothing was posted. The pending hold was never asked for.
  const inbox = await api("inbox.list", { filter: { provider: "simplefin" }, pageSize: 100 });
  expect(inbox.count).toBe(11);
  expect((await api("inbox.summary", {})).counts).toMatchObject({ toReview: 11, posted: 0 });
  expect(JSON.stringify(inbox)).not.toContain("CARD HOLD HOTEL");
  expect((await api("journal.list", { page: 1 })).count).toBe(0);

  // Run again: nothing new, nothing doubled.
  const again = await cli(["bankfeed", "sync"]);
  expect(again.json.data.run.newLines).toBe(0);
  expect((await api("inbox.list", { filter: { provider: "simplefin" } })).count).toBe(11);
}, 60_000);

test("the status says what the feed knows, and that its balance is not a statement balance", async () => {
  const text = await cli(["bankfeed", "status", "--format", "text"]);
  expect(text.exit, text.out + text.err).toBe(0);
  expect(text.out).toContain("Business Checking");
  expect(text.out).toContain("feed balance 6,878.18");
  expect(text.out).toContain("not a statement balance");
  expect(text.out).toContain("Daily sync: off.");
  const status = await cli(["bankfeed", "status"]);
  const checking = status.json.data.accounts.find(
    (a: { id: string }) => a.id === "ACT-checking-0001",
  );
  // 1,000.00 was in the account before September and the books have no opening balance yet: the
  // eleven lines wait in the Inbox, and the feed's balance is that much more than they explain.
  expect(checking.link.feedBalance).toMatchObject({
    reported: "6878.18",
    ledger: "0.00",
    waiting: "5878.18",
    difference: "1000.00",
  });
  expect(status.json.data.requests.used).toBeGreaterThan(0);
  expect(status.json.data.requests.limit).toBe(24);
});

test("the daily sync is off, and the owner can turn it on and choose the time", async () => {
  const shown = await cli(["bankfeed", "settings"]);
  expect(shown.json.data).toEqual({ dailySync: false, dailyAt: "06:17" });
  const on = await cli(["bankfeed", "settings", "--daily", "true", "--at", "07:42"]);
  expect(on.exit, on.out + on.err).toBe(0);
  expect(on.json.data).toEqual({ dailySync: true, dailyAt: "07:42" });
  const bad = await cli(["bankfeed", "settings", "--at", "7pm"]);
  expect(bad.exit).not.toBe(0);
  const off = await cli(["bankfeed", "settings", "--daily", "false"]);
  expect(off.json.data).toEqual({ dailySync: false, dailyAt: "07:42" });
});

test("a new account at the bank shows up unlinked and is not fetched", async () => {
  await fake("POST", "accounts", {
    id: "ACT-card-0004",
    name: "Company Card",
    currency: "USD",
    balance: "-312.45",
    balanceDate: Math.floor(Date.now() / 1000),
    connId: "CON-bank-a",
    transactions: [
      {
        id: "C-1",
        posted: Math.floor(Date.now() / 1000) - 86_400,
        amount: "-312.45",
        description: "AIRLINE",
      },
    ],
  });
  const listed = await cli(["bankfeed", "accounts"]);
  expect(listed.exit, listed.out + listed.err).toBe(0);
  const card = listed.json.data.accounts.find((a: { id: string }) => a.id === "ACT-card-0004");
  expect(card).toMatchObject({ state: "unlinked", link: null });
  await cli(["bankfeed", "sync"]);
  const requests = (await fake("GET", "log")).requests as { query: Record<string, string[]> }[];
  for (const entry of requests) expect(entry.query.account ?? []).not.toContain("ACT-card-0004");
  expect((await api("inbox.list", { filter: { provider: "simplefin" } })).count).toBe(11);
}, 60_000);

test("disconnecting deletes the access URL and keeps what was imported, and connecting again carries on", async () => {
  const refused = await cli(["bankfeed", "disconnect"]);
  expect(refused.exit).toBe(2);
  expect(existsSync(join(directory, "simplefin.access"))).toBe(true);

  const done = await cli(["bankfeed", "disconnect", "--yes"]);
  expect(done.exit, done.out + done.err).toBe(0);
  expect(existsSync(join(directory, "simplefin.access"))).toBe(false);
  const status = await cli(["bankfeed", "status"]);
  expect(status.json.data.connected).toBe(false);
  expect((await api("inbox.list", { filter: { provider: "simplefin" } })).count).toBe(11);
  const refusedSync = await cli(["bankfeed", "sync"]);
  expect(refusedSync.exit).not.toBe(0);
  expect(refusedSync.out + refusedSync.err).toContain("not connected");

  // A new setup token, this time on standard input; the link and the place read to are kept.
  await fake("POST", "reset");
  const token = (await fake("GET", "token")).setupToken as string;
  const connected = await cli(["bankfeed", "connect"], `${token}\n`);
  expect(connected.exit, connected.out + connected.err).toBe(0);
  const synced = await cli(["bankfeed", "sync"]);
  expect(synced.json.data.run).toMatchObject({ disposition: "complete", newLines: 0 });
  expect((await api("inbox.list", { filter: { provider: "simplefin" } })).count).toBe(11);
  // It carried on from where it had read to, not from the first day chosen when it was linked.
  const firstDay = String(Date.UTC(2026, 8, 1) / 1000);
  const after = (await fake("GET", "log")).requests as { query: Record<string, string[]> }[];
  const reads = after.filter((entry) => entry.query["start-date"] !== undefined);
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.some((entry) => entry.query["start-date"]?.[0] === firstDay)).toBe(false);
}, 60_000);

test("when the Bridge asks Rastrata to slow down, the sync stops, says when, and exits 3", async () => {
  // The accounts were listed a moment ago, so the first request of this sync is a read: that is the
  // one the Bridge refuses.
  await fake("POST", "respond-once", { status: 429, body: "Too many requests" });
  const paused = await cli(["bankfeed", "sync"]);
  expect(paused.exit, paused.out + paused.err).toBe(3);
  expect(paused.json.data.paused).toMatchObject({ reason: "rate_limited" });
  expect(paused.err).toContain("Do not ask again before");
  const before = (await fake("GET", "log")).requests.length;
  const next = await cli(["bankfeed", "sync"]);
  expect(next.exit).toBe(3);
  expect((await fake("GET", "log")).requests.length).toBe(before);
  const status = await cli(["bankfeed", "status", "--format", "text"]);
  expect(status.out).toContain("Paused until");
}, 60_000);

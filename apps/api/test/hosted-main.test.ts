// The product entry (hosted-main.ts): the settings it reads from the environment, and the process itself,
// started as the image starts it and stopped as a pod is stopped. It is one service, locked and for accounts, with
// no switch between that and anything else; see docs/reference/program/hosting/hostedprod.md.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { issueOwnerKey } from "@rastrata/application/agent";
import { APPLICATION_API_VERSION } from "@rastrata/application/schema";
import { durableObjectHandler, FileObjectStore } from "@rastrata/booklog";
import { MemoryLogTier } from "@rastrata/booklog/testing";
import {
  ownerKeyFrom,
  productSettings,
  SHUTDOWN_DEADLINE_MS,
  SHUTDOWN_QUIET_MS,
} from "../src/hosted-main.ts";

const MAIN = join(import.meta.dir, "../src/hosted-main.ts");
const OWNER_KEY = issueOwnerKey();
const TOKEN = "tok-3b9d51e7c0a24f68-must-not-leak";
const PUBLIC = "https://app.example.test";
const HOST = "app.example.test";
const DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);
const BOOK = {
  name: "Pilot Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1010", name: "Checking", role: "asset" },
    { code: "3100", name: "Owner draw", role: "equity" },
    { code: "6100", name: "Software", role: "expense" },
  ],
} as const;
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
function folder(): string {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-main-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const INDEX = `<!doctype html><html><head><script type="module" src="/assets/app.js"></script></head><body><div id="root"></div></body></html>`;
const SIGN_IN = `<!doctype html><html><head><script type="module" src="/assets/signin.js"></script></head><body><div id="root"></div></body></html>`;
/** A build of the web app; with `signIn: false`, one made before the sign-in page existed. */
function webBuild(options: { signIn?: boolean } = {}): string {
  const web = join(folder(), "web");
  mkdirSync(join(web, "assets"), { recursive: true });
  writeFileSync(join(web, "index.html"), INDEX);
  writeFileSync(join(web, "assets", "app.js"), "console.log('app');");
  if (options.signIn !== false) {
    writeFileSync(join(web, "signin.html"), SIGN_IN);
    writeFileSync(join(web, "assets", "signin.js"), "console.log('sign-in');");
  }
  return web;
}

// ---- the settings --------------------------------------------------------------------------------------------

/** The settings of a pod, as its manifest gives them (the names are the contract). */
const manifest = (extra: Record<string, string | undefined> = {}) => ({
  RASTRATA_API_PORT: "8080",
  RASTRATA_BIND: "0.0.0.0",
  RASTRATA_ALLOWED_HOSTS: HOST,
  RASTRATA_PUBLIC_ORIGIN: PUBLIC,
  RASTRATA_BOOK_STORE: "r2log://rastrata-main",
  RASTRATA_BOOK_TAIL: "memory",
  RASTRATA_BOOK_BULK: "memory",
  RASTRATA_BOOK_CACHE: "/var/lib/rastrata/books",
  RASTRATA_OWNER_KEY: OWNER_KEY,
  RASTRATA_SERVICE_KEY_SHA256S: DIGEST,
  RASTRATA_BOOK_SNAPSHOT_EVERY: "1000",
  RASTRATA_BOOK_LEASE_MS: "5000",
  RASTRATA_BOOK_IDLE_RELEASE_MS: "60000",
  RASTRATA_REPLAY: "full",
  RASTRATA_WEB_DIR: webBuild(),
  ...extra,
});

/** What starting with these settings says is wrong, or null when it starts. */
const wrong = async (extra: Record<string, string | undefined>) =>
  productSettings(manifest(extra)).then(
    () => null,
    (error: unknown) => (error as Error).message,
  );

test("the manifest's names are the settings, and they make one service: locked, for accounts, with many books and no password for a browser", async () => {
  const lines: string[] = [];
  const { options, lines: told } = await productSettings(manifest(), (line) => lines.push(line));
  expect(options.port).toBe(8080);
  expect(options.serving).toEqual({
    bind: "0.0.0.0",
    allowedHosts: [HOST],
    publicOrigin: PUBLIC,
  });
  expect(options.ownerKey).toBe(OWNER_KEY);
  expect(options.config).toMatchObject({
    bookId: "rastrata-main",
    cache: "/var/lib/rastrata/books",
    snapshotEvery: 1000,
  });
  expect(options.leaseMs).toBe(5000);
  expect(options.idleReleaseMs).toBe(60000);
  expect(options.replay).toBe("full");
  expect(options.web?.files).toBe(4);
  expect(options.web?.signIn).toBe(true);
  // There is nothing to switch: member tokens signed by the control plane, its key, many books, no agent token as a bearer and no session of the owner's.
  expect(options.memberTokens).toEqual({ origin: PUBLIC });
  expect(options.serviceKeys).toEqual([DIGEST]);
  expect(options.books).toEqual({ settings: {} });
  expect(options.agentTokens).toBe(false);
  expect(options.sessions).toBe(false);
  expect(options.warm).toBeUndefined();
  // What is told at the start names no key, no digest and no address of a store.
  const text = told.join("\n");
  expect(text).toContain("answering to app.example.test, public address https://app.example.test");
  expect(text).toContain(`member tokens signed by ${PUBLIC}/auth`);
  expect(text).toContain("the control plane's key: 1 accepted");
  expect(text).toContain("no agent token is a bearer");
  expect(text).toMatch(/books: many \(up to 256 open besides the first, about \d+ MB of them warm/);
  expect(text).not.toContain(OWNER_KEY);
  expect(text).not.toContain(DIGEST);
});

test("how often a book that is open is asked whether the verifier has stopped it is a number of milliseconds, left to the server's own five minutes unless set, and 0 asks at every request", async () => {
  expect((await productSettings(manifest())).options.reviewCheckMs).toBeUndefined();
  expect(
    (await productSettings(manifest({ RASTRATA_BOOK_REVIEW_CHECK_MS: "60000" }))).options
      .reviewCheckMs,
  ).toBe(60000);
  expect(
    (await productSettings(manifest({ RASTRATA_BOOK_REVIEW_CHECK_MS: "0" }))).options.reviewCheckMs,
  ).toBe(0);
  for (const bad of ["-1", "soon", "86400001"]) {
    const refused = await wrong({ RASTRATA_BOOK_REVIEW_CHECK_MS: bad });
    expect(refused, bad).toContain("RASTRATA_BOOK_REVIEW_CHECK_MS");
  }
});

test("the books a starting server opens before it says it is ready, and how long it waits for them, are left to the server's own sixty-four and fifteen seconds unless set, and 0 books opens none", async () => {
  const plain = (await productSettings(manifest())).options;
  expect(plain.prewarm).toBeUndefined();
  expect(
    (await productSettings(manifest({ RASTRATA_PREWARM_BOOKS: "5" }))).options.prewarm,
  ).toEqual({
    books: 5,
  });
  expect(
    (await productSettings(manifest({ RASTRATA_PREWARM_MS: "4000" }))).options.prewarm,
  ).toEqual({
    budgetMs: 4000,
  });
  expect(
    (await productSettings(manifest({ RASTRATA_PREWARM_BOOKS: "0", RASTRATA_PREWARM_MS: "0" })))
      .options.prewarm,
  ).toEqual({ books: 0, budgetMs: 0 });
  for (const name of ["RASTRATA_PREWARM_BOOKS", "RASTRATA_PREWARM_MS"])
    for (const bad of ["-1", "many", "1.5", "999999999"]) {
      const refused = await wrong({ [name]: bad });
      expect(refused, `${name}=${bad}`).toContain(name);
    }
});

test("how long a pod that is told to stop goes on answering, not ready, is three seconds unless set, and 0 stops at once", async () => {
  expect((await productSettings(manifest())).quietMs).toBe(SHUTDOWN_QUIET_MS);
  expect(SHUTDOWN_QUIET_MS).toBe(3000);
  expect((await productSettings(manifest({ RASTRATA_SHUTDOWN_QUIET_MS: "8000" }))).quietMs).toBe(
    8000,
  );
  expect((await productSettings(manifest({ RASTRATA_SHUTDOWN_QUIET_MS: "0" }))).quietMs).toBe(0);
  for (const bad of ["-1", "soon", "20001"]) {
    const refused = await wrong({ RASTRATA_SHUTDOWN_QUIET_MS: bad });
    expect(refused, bad).toContain("RASTRATA_SHUTDOWN_QUIET_MS");
  }
  // With the longest quiet time the stop still ends inside the pod's sixty seconds.
  expect(20_000 + SHUTDOWN_DEADLINE_MS).toBeLessThan(60_000);
});

test("a setting that was a switch is gone, and one that is still given is refused by name and not ignored", async () => {
  for (const [name, value] of [
    ["RASTRATA_MEMBER_TOKENS", "1"],
    ["RASTRATA_MEMBER_TOKENS", "0"],
    ["RASTRATA_BOOKS", "many"],
    ["RASTRATA_BOOKS", "one"],
    ["RASTRATA_AGENT_TOKENS", "1"],
    ["RASTRATA_BOOK_WARM", "1"],
    ["RASTRATA_BOOK_WHOLE_READ_ENTRIES", "10000"],
    ["RASTRATA_BOOK_WHOLE_READ_ENTRIES", "0"],
  ] as const) {
    const message = await wrong({ [name]: value });
    expect(message, `${name}=${value}`).toContain(name);
    expect(message, `${name}=${value}`).toContain("is not a setting any more");
  }
  // Set and empty counts as not set, as everywhere else.
  for (const name of [
    "RASTRATA_MEMBER_TOKENS",
    "RASTRATA_BOOKS",
    "RASTRATA_AGENT_TOKENS",
    "RASTRATA_BOOK_WARM",
    "RASTRATA_BOOK_WHOLE_READ_ENTRIES",
  ])
    expect(await wrong({ [name]: "" }), name).toBeNull();
});

test("what the service stands on is required, each by name: the operator's key, the public address and the control plane's key", async () => {
  expect(await wrong({ RASTRATA_OWNER_KEY: undefined })).toContain("RASTRATA_OWNER_KEY");
  expect(await wrong({ RASTRATA_OWNER_KEY: "" })).toContain("RASTRATA_OWNER_KEY");
  expect(await wrong({ RASTRATA_PUBLIC_ORIGIN: undefined })).toContain("RASTRATA_PUBLIC_ORIGIN");
  expect(await wrong({ RASTRATA_SERVICE_KEY_SHA256S: undefined })).toContain(
    "RASTRATA_SERVICE_KEY_SHA256S",
  );
  // Not even on this computer: the service is never started open, and never without the means to be what it is.
  const bare = await productSettings({
    RASTRATA_BOOK_STORE: "r2log://b?bulk=memory&tail=memory",
    RASTRATA_WEB_DIR: webBuild(),
  }).then(
    () => null,
    (error: unknown) => (error as Error).message,
  );
  expect(bare).toContain("RASTRATA_OWNER_KEY");
});

test("the control plane's key is named by its digest, or two while it is rotated, or by a file; a digest is what it says it is and is never repeated", async () => {
  const two = await productSettings(
    manifest({ RASTRATA_SERVICE_KEY_SHA256S: `${DIGEST}, ${OTHER_DIGEST}` }),
  );
  expect(two.options.serviceKeys).toEqual([DIGEST, OTHER_DIGEST]);
  expect(two.lines.join("\n")).toContain("the control plane's key: 2 accepted");
  expect(two.lines.join("\n")).not.toContain(DIGEST);
  const file = join(folder(), "service-key-digest");
  writeFileSync(file, `${OTHER_DIGEST}\n`);
  const fromFile = await productSettings(
    manifest({ RASTRATA_SERVICE_KEY_SHA256S: undefined, RASTRATA_SERVICE_KEY_SHA256S_FILE: file }),
  );
  expect(fromFile.options.serviceKeys).toEqual([OTHER_DIGEST]);
  for (const bad of [
    "not-a-digest",
    "A".repeat(64),
    `${DIGEST},`,
    `${DIGEST},short`,
    "a".repeat(63),
  ]) {
    const message = await wrong({ RASTRATA_SERVICE_KEY_SHA256S: bad });
    expect(message, bad).toContain("RASTRATA_SERVICE_KEY_SHA256S");
    expect(message).not.toContain(DIGEST);
  }
  expect(
    await wrong({ RASTRATA_SERVICE_KEY_SHA256S: DIGEST, RASTRATA_SERVICE_KEY_SHA256S_FILE: "/x" }),
  ).toContain("not both");
  expect(
    await wrong({
      RASTRATA_SERVICE_KEY_SHA256S: undefined,
      RASTRATA_SERVICE_KEY_SHA256S_FILE: join(folder(), "nothing"),
    }),
  ).toContain("cannot be read");
});

test("the registry of books is tuned by numbers that are optional, always apply, and are each held to a range", async () => {
  const tuned = await productSettings(
    manifest({
      RASTRATA_BOOKS_MAX: "40",
      RASTRATA_BOOKS_WARM_MB: "300",
      RASTRATA_BOOKS_IDLE_MS: "120000",
      RASTRATA_BOOKS_LOADS: "3",
      RASTRATA_BOOKS_QUEUE: "10",
      RASTRATA_BOOKS_INFLIGHT: "12",
      RASTRATA_BOOKS_RATE: "7",
    }),
  );
  expect(tuned.options.books?.settings).toEqual({
    maxBooks: 40,
    warmBudgetBytes: 300 * 2 ** 20,
    idleMs: 120_000,
    loads: 3,
    loadQueue: 10,
    inflight: 12,
    rate: 7,
    burst: 21,
  });
  expect(tuned.lines.join("\n")).toContain(
    "up to 40 open besides the first, about 300 MB of them warm, 3 cold loads at a time",
  );
  for (const [name, bad] of [
    ["RASTRATA_BOOKS_MAX", "0"],
    ["RASTRATA_BOOKS_MAX", "10001"],
    ["RASTRATA_BOOKS_WARM_MB", "8"],
    ["RASTRATA_BOOKS_IDLE_MS", "100"],
    ["RASTRATA_BOOKS_LOADS", "0"],
    ["RASTRATA_BOOKS_LOADS", "17"],
    ["RASTRATA_BOOKS_QUEUE", "-1"],
    ["RASTRATA_BOOKS_INFLIGHT", "0"],
    ["RASTRATA_BOOKS_RATE", "0"],
    ["RASTRATA_BOOKS_RATE", "many"],
  ] as const)
    expect(await wrong({ [name]: bad }), `${name}=${bad}`).toContain(name);
});

test("a bad setting says which it is and never what it was", async () => {
  expect(await wrong({ RASTRATA_BOOK_STORE: undefined })).toContain("RASTRATA_BOOK_STORE");
  expect(await wrong({ RASTRATA_BOOK_STORE: "postgres://user:SECRETPASSWORD@db/x" })).not.toContain(
    "SECRETPASSWORD",
  );
  expect(await wrong({ RASTRATA_API_PORT: "http" })).toContain("RASTRATA_API_PORT");
  expect(await wrong({ RASTRATA_API_PORT: "70000" })).toContain("RASTRATA_API_PORT");
  expect(await wrong({ RASTRATA_BOOK_LEASE_MS: "5" })).toContain("RASTRATA_BOOK_LEASE_MS");
  expect(await wrong({ RASTRATA_BOOK_IDLE_RELEASE_MS: "-1" })).toContain(
    "RASTRATA_BOOK_IDLE_RELEASE_MS",
  );
  expect(await wrong({ RASTRATA_REPLAY: "fast" })).toContain("RASTRATA_REPLAY");
  expect(await wrong({ RASTRATA_WEB_DIR: join(folder(), "nothing") })).toContain(
    "RASTRATA_WEB_DIR",
  );
  // The service is locked, so it does not start with a web app that has no sign-in page: it would send the app to anyone.
  expect(await wrong({ RASTRATA_WEB_DIR: webBuild({ signIn: false }) })).toContain("sign-in page");
  // The experiments' routes and a standby are not the product's.
  expect(await wrong({ RASTRATA_BOOK_CONTROL: "1" })).toContain("RASTRATA_BOOK_CONTROL");
  expect(await wrong({ RASTRATA_BOOK_STANDBY: "1" })).toContain("RASTRATA_BOOK_STANDBY");
  // A key that is not a key is not repeated.
  const bad = await wrong({ RASTRATA_OWNER_KEY: "rso_not-a-key-SECRETKEYTEXT" });
  expect(bad).toContain("owner key");
  expect(bad).not.toContain("SECRETKEYTEXT");
});

test("the owner key is the variable's, or the contents of a file's (a mounted Secret ends in a newline), not both", () => {
  const directory = folder();
  const file = join(directory, "owner-key");
  writeFileSync(file, `${OWNER_KEY}\n`, { mode: 0o440 });
  expect(ownerKeyFrom({ RASTRATA_OWNER_KEY: OWNER_KEY })).toBe(OWNER_KEY);
  expect(ownerKeyFrom({ RASTRATA_OWNER_KEY: ` ${OWNER_KEY}\n` })).toBe(OWNER_KEY);
  // A mounted Secret is group-readable by design; unlike the local key file it is allowed to be.
  expect(ownerKeyFrom({ RASTRATA_OWNER_KEY_FILE: file })).toBe(OWNER_KEY);
  expect(ownerKeyFrom({})).toBeUndefined();
  expect(() =>
    ownerKeyFrom({ RASTRATA_OWNER_KEY: OWNER_KEY, RASTRATA_OWNER_KEY_FILE: file }),
  ).toThrow("not both");
  expect(() => ownerKeyFrom({ RASTRATA_OWNER_KEY_FILE: join(directory, "missing") })).toThrow(
    "cannot be read",
  );
  writeFileSync(join(directory, "empty"), "\n");
  expect(ownerKeyFrom({ RASTRATA_OWNER_KEY_FILE: join(directory, "empty") })).toBeUndefined();
});

// ---- the process ---------------------------------------------------------------------------------------------

interface Child {
  readonly base: string;
  readonly output: () => string;
  readonly signal: (name: NodeJS.Signals) => void;
  readonly exited: Promise<number>;
  readonly log: string[];
}

/** Start the entry as a process, from a directory of its own, with this environment and no other. */
async function spawnServer(env: Record<string, string>): Promise<Child> {
  const process_ = Bun.spawn([process.execPath, MAIN], {
    cwd: folder(),
    env: { PATH: process.env.PATH ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  let text = "";
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) text += decoder.decode(chunk);
  };
  void read(process_.stdout);
  void read(process_.stderr);
  const exited = process_.exited;
  cleanup.push(async () => {
    if (process_.exitCode === null) process_.kill("SIGKILL");
    await exited;
  });
  const deadline = Date.now() + 30_000;
  let base = "";
  while (!base) {
    const match = /listening on (http:\/\/[0-9.:[\]a-z]+?)\/?\s/.exec(text);
    if (match) base = (match[1] as string).replace("0.0.0.0", "127.0.0.1");
    else if (process_.exitCode !== null || Date.now() > deadline)
      throw new Error(`the server did not start (exit ${process_.exitCode}):\n${text}`);
    else await Bun.sleep(25);
  }
  return {
    base,
    output: () => text,
    signal: (name) => process_.kill(name),
    exited,
    log: [],
  };
}

/** The operator's key as a bearer, which is all the owner's key is for here. */
const operator = { host: HOST, authorization: `Bearer ${OWNER_KEY}` };
async function call(
  base: string,
  name: string,
  input: unknown,
  headers: Record<string, string>,
  operationId?: string,
) {
  const response = await fetch(`${base}/v1/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      version: APPLICATION_API_VERSION,
      bookId: "local-book",
      input,
      ...(operationId ? { operationId } : {}),
    }),
  });
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are inspected loosely
  return { status: response.status, body: (await response.json()) as any };
}
const draft = (reference: string) => ({
  data: {
    date: "2026-03-02",
    reference,
    narration: reference,
    lines: [
      { accountId: "6100", debit: "5.00", credit: "" },
      { accountId: "1010", debit: "", credit: "5.00" },
    ],
  },
});

const environment = (root: string, extra: Record<string, string> = {}): Record<string, string> => ({
  RASTRATA_API_PORT: "0",
  RASTRATA_BIND: "127.0.0.1",
  RASTRATA_ALLOWED_HOSTS: HOST,
  RASTRATA_PUBLIC_ORIGIN: PUBLIC,
  RASTRATA_BOOK_STORE: "r2log://pilot-1",
  RASTRATA_BOOK_BULK: pathToFileURL(join(root, "bucket")).href,
  RASTRATA_BOOK_CACHE: join(root, "cache"),
  RASTRATA_OWNER_KEY: OWNER_KEY,
  RASTRATA_SERVICE_KEY_SHA256S: DIGEST,
  RASTRATA_WEB_DIR: webBuild(),
  // No wait between the signal and the stop, so that the tests that end a process are not slowed: the update below sets one.
  RASTRATA_SHUTDOWN_QUIET_MS: "0",
  ...extra,
});

test("the process started from the environment alone serves the web app and the API, and a SIGTERM ends it with exit 0 inside the pod's grace, the book on file", async () => {
  const root = folder();
  // The tail is the bucket itself (files): what a restarted process finds is what the first one wrote.
  const env = environment(root, { RASTRATA_BOOK_TAIL: "objects" });
  const first = await spawnServer(env);
  expect(first.output()).toContain("book pilot-1, tail objects, bulk store file");
  expect((await fetch(`${first.base}/live`)).status).toBe(200);
  expect((await fetch(`${first.base}/ready`, { headers: { host: "10.0.0.9:8080" } })).status).toBe(
    200,
  );
  // A browser that has not signed in is sent the sign-in page; one the control plane has signed in (it set the hint) is sent the app. There is no sign-in of the owner's.
  const asked = { host: HOST, accept: "text/html" };
  expect(await (await fetch(`${first.base}/`, { headers: asked })).text()).toBe(SIGN_IN);
  expect(
    await (
      await fetch(`${first.base}/`, { headers: { ...asked, cookie: "__Host-rastrata_in=1" } })
    ).text(),
  ).toBe(INDEX);
  const owner = await fetch(`${first.base}/session/owner`, {
    method: "POST",
    headers: { host: HOST, origin: PUBLIC, "content-type": "application/json" },
    body: JSON.stringify({ key: OWNER_KEY }),
  });
  expect(owner.status).toBe(404);
  // Nothing is asked of the book without a credential, and nothing but the operator's key (or a token of the control plane's) opens it.
  expect((await call(first.base, "book.get", {}, { host: HOST })).status).toBe(401);
  expect(
    (await call(first.base, "book.get", {}, { host: HOST, authorization: "Bearer rst_made_up" }))
      .status,
  ).toBe(401);
  expect((await call(first.base, "book.setup", BOOK, operator, id(1))).status).toBe(200);
  expect(
    (await call(first.base, "drafts.create", draft("before the stop"), operator, id(2))).status,
  ).toBe(200);

  const stopped = performance.now();
  first.signal("SIGTERM");
  expect(await first.exited).toBe(0);
  const seconds = (performance.now() - stopped) / 1000;
  expect(seconds).toBeLessThan(SHUTDOWN_DEADLINE_MS / 1000);
  expect(first.output()).toContain("stopped, the book is sealed and its lease given back");
  // Nothing in what it printed is a key or a digest.
  expect(first.output()).not.toContain(OWNER_KEY);
  expect(first.output()).not.toContain(DIGEST);
  // Sealed: the bucket holds the segment, and a process that knows nothing reads the same book.
  expect(existsSync(join(root, "bucket"))).toBe(true);
  const second = await spawnServer(env);
  const drafts = await call(second.base, "drafts.list", {}, operator);
  expect(
    drafts.body.data.drafts.map((d: { data: { reference: string } }) => d.data.reference),
  ).toEqual(["before the stop"]);
  second.signal("SIGINT");
  expect(await second.exited).toBe(0);
});

/** A Durable Object tail Worker's protocol over HTTP, with the reference tail behind it, in this process. */
function tailWorker() {
  const core = new MemoryLogTier();
  const handler = durableObjectHandler(core, { token: TOKEN });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => handler(request),
  });
  cleanup.push(() => server.stop(true));
  return { core, url: `http://127.0.0.1:${server.port}` };
}

test("on SIGTERM the process seals what the tail holds and gives the lease back, so that the next holder need not wait for it to lapse", async () => {
  const root = folder();
  const worker = tailWorker();
  const tokenFile = join(root, "tail-token");
  writeFileSync(tokenFile, `${TOKEN}\n`);
  const child = await spawnServer(
    environment(root, {
      RASTRATA_BOOK_TAIL: worker.url,
      RASTRATA_BOOK_TAIL_TOKEN_FILE: tokenFile,
      // A long lease: a lease that was not given back would still be held minutes from now.
      RASTRATA_BOOK_LEASE_MS: "120000",
      RASTRATA_BOOK_IDLE_RELEASE_MS: "0",
    }),
  );
  expect((await call(child.base, "book.setup", BOOK, operator, id(1))).status).toBe(200);
  expect((await call(child.base, "drafts.create", draft("one"), operator, id(2))).status).toBe(200);
  const held = worker.core.peek("pilot-1");
  expect(held.head.leaseHolder).not.toBeNull();
  expect(held.head.seq).toBeGreaterThanOrEqual(2);
  // Written, and not sealed yet: the seal waits for its window.
  expect(held.head.sealedThrough).toBeLessThan(held.head.seq);

  child.signal("SIGTERM");
  expect(await child.exited).toBe(0);
  const after = worker.core.peek("pilot-1");
  expect(after.head.leaseHolder).toBeNull();
  expect(after.head.sealedThrough).toBe(after.head.seq);
  expect(after.entries).toHaveLength(0);
  // The sealed history is in the bucket, whole.
  const listed = await new FileObjectStore(join(root, "bucket")).list("", undefined, 100);
  expect(listed.objects.length).toBeGreaterThan(0);
  // And the token, which is in a file and in a header to the tail, is nowhere in what the process said.
  expect(child.output()).not.toContain(TOKEN);
  expect(child.output()).not.toContain(OWNER_KEY);
  expect(readdirSync(root)).toContain("tail-token");
});

// ---- two pods of one service: an update, a worker's upgrade, a pod that is lost ------------------------------------------

/** The Service in front of the pods, as the cluster makes it for Cloudflare's tunnel: a request goes to one of the pods it lists, in turn, over connections that are kept, and a pod
 * that is told to stop leaves the list a moment later (the time the change takes to reach the node). A request to a pod that is no longer listening is the 502 Cloudflare shows. */
function serviceInFront() {
  const listed: string[] = [];
  let turn = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const pod = listed.length > 0 ? listed[turn++ % listed.length] : undefined;
      if (pod === undefined) return new Response("no pod", { status: 502 });
      const url = new URL(request.url);
      try {
        const answer = await fetch(`${pod}${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers,
          ...(request.method === "GET" || request.method === "HEAD"
            ? {}
            : { body: await request.arrayBuffer() }),
        });
        const headers = new Headers(answer.headers);
        headers.delete("connection");
        return new Response(answer.body, { status: answer.status, headers });
      } catch {
        return new Response("bad gateway", { status: 502 });
      }
    },
  });
  cleanup.push(() => server.stop(true));
  return {
    base: `http://127.0.0.1:${server.port}`,
    add: (pod: string) => void listed.push(pod),
    remove: (pod: string) => {
      const at = listed.indexOf(pod);
      if (at >= 0) listed.splice(at, 1);
    },
  };
}

/** Pods of one service as the cluster runs them: one tail and one bucket between them, a cache each. */
function podsOfOneService(options: { readonly quietMs?: number; readonly leaseMs?: number } = {}) {
  const root = folder();
  const worker = tailWorker();
  const tokenFile = join(root, "tail-token");
  writeFileSync(tokenFile, `${TOKEN}\n`);
  const start = (cache: string) =>
    spawnServer(
      environment(root, {
        RASTRATA_BOOK_TAIL: worker.url,
        RASTRATA_BOOK_TAIL_TOKEN_FILE: tokenFile,
        RASTRATA_BOOK_CACHE: join(root, cache),
        RASTRATA_BOOK_IDLE_RELEASE_MS: "0",
        RASTRATA_SHUTDOWN_QUIET_MS: String(options.quietMs ?? 1500),
        ...(options.leaseMs ? { RASTRATA_BOOK_LEASE_MS: String(options.leaseMs) } : {}),
      }),
    );
  return { worker, start };
}

/** People at work: a request every 40 ms through the Service, one in four a write. */
function peopleAtWork(front: string) {
  const begun = performance.now();
  const results: { status: number; ms: number; at: number; write: boolean }[] = [];
  const pending: Promise<void>[] = [];
  let sent = 0;
  const timer = setInterval(() => {
    const n = sent++;
    const write = n % 4 === 0;
    const started = performance.now();
    pending.push(
      fetch(`${front}/v1/${write ? "drafts.create" : "drafts.list"}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...operator },
        body: JSON.stringify({
          version: APPLICATION_API_VERSION,
          bookId: "local-book",
          input: write ? draft(`during ${n}`) : {},
          ...(write ? { operationId: id(1000 + n) } : {}),
        }),
      })
        .then(
          async (response) => {
            await response.arrayBuffer();
            return response.status;
          },
          () => 0,
        )
        .then((status) => {
          results.push({ status, ms: performance.now() - started, at: started - begun, write });
        }),
    );
  }, 40);
  cleanup.push(() => clearInterval(timer));
  return {
    results,
    now: () => performance.now() - begun,
    async stop() {
      clearInterval(timer);
      await Promise.all(pending);
    },
  };
}

/** What a pod says of the requests it handed to another pod, which only the owner's key is told. */
async function handedOn(pod: Child): Promise<{ forwarded: number; unreachable: number }> {
  const response = await fetch(`${pod.base}/health`, { headers: operator });
  return (
    (await response.json()) as { hosted: { peers: { forwarded: number; unreachable: number } } }
  ).hosted.peers;
}

const probe = (pod: Child, path: string) =>
  fetch(`${pod.base}${path}`, { headers: { host: "10.0.0.9:8080" } }).then(
    (response) => response.status,
    () => 0,
  );

test("an update that starts the new pod beside the old one and then stops the old one is not seen by people using the book: no request fails, none is lost, and none waits long", async () => {
  const { worker, start } = podsOfOneService();
  const old = await start("cache-old");
  expect((await call(old.base, "book.setup", BOOK, operator, id(1))).status).toBe(200);
  expect((await call(old.base, "drafts.create", draft("before"), operator, id(2))).status).toBe(
    200,
  );
  // The new pod is started while the old one holds the book, and is ready at once: readiness does not wait for a lease, which is what lets the old pod be stopped only when the new one is ready.
  const fresh = await start("cache-new");
  expect(await probe(fresh, "/ready")).toBe(200);
  const service = serviceInFront();
  service.add(old.base);
  const people = peopleAtWork(service.base);

  await Bun.sleep(800);
  // The cluster: the new pod is ready, so the old one is told to stop. The Service learns of both a moment later.
  old.signal("SIGTERM");
  setTimeout(() => service.add(fresh.base), 300);
  setTimeout(() => service.remove(old.base), 600);
  // The old pod says it is leaving and goes on answering until the Service has stopped sending it requests.
  await Bun.sleep(100);
  const [ready, live] = [await probe(old, "/ready"), await probe(old, "/live")];
  expect(await old.exited).toBe(0);
  await Bun.sleep(800);
  await people.stop();

  const { results } = people;
  expect(results.filter((result) => result.status !== 200).map((r) => r.status)).toEqual([]);
  expect({ ready, live }).toEqual({ ready: 503, live: 200 });
  expect(results.length).toBeGreaterThan(60);
  // The new pod handed the old one's books' requests to it while it was still answering, and took the books when it had stopped.
  expect((await handedOn(fresh)).forwarded).toBeGreaterThan(0);
  expect(Math.max(...results.map((result) => result.ms))).toBeLessThan(1500);
  expect(worker.core.peek("pilot-1").head.leaseHolder).not.toBeNull();
  const written = results.filter((result) => result.write).length;
  const drafts = await call(fresh.base, "drafts.list", {}, operator);
  expect(drafts.body.data.drafts).toHaveLength(1 + written);
  fresh.signal("SIGTERM");
  expect(await fresh.exited).toBe(0);
}, 60_000);

test("two pods share the people: the one that does not hold the book hands its requests to the one that does, and nobody waits", async () => {
  const { start } = podsOfOneService();
  const holder = await start("cache-a");
  expect((await call(holder.base, "book.setup", BOOK, operator, id(1))).status).toBe(200);
  const other = await start("cache-b");
  const service = serviceInFront();
  service.add(holder.base);
  service.add(other.base);
  const people = peopleAtWork(service.base);
  await Bun.sleep(2500);
  await people.stop();

  const { results } = people;
  expect(results.filter((result) => result.status !== 200).map((r) => r.status)).toEqual([]);
  expect(results.length).toBeGreaterThan(50);
  // About half of the requests came to the pod that does not hold the book, and none was slowed by it.
  const handed = await handedOn(other);
  expect(handed.forwarded).toBeGreaterThan(results.length / 4);
  expect((await handedOn(holder)).forwarded).toBe(0);
  expect(Math.max(...results.map((result) => result.ms))).toBeLessThan(1000);
  const drafts = await call(other.base, "drafts.list", {}, operator);
  expect(drafts.body.data.drafts).toHaveLength(results.filter((result) => result.write).length);
}, 60_000);

test("a worker's upgrade stops one of two pods that are serving: the people notice nothing, and the other pod has the book when the stopped one has given it up", async () => {
  const { worker, start } = podsOfOneService();
  const first = await start("cache-a");
  expect((await call(first.base, "book.setup", BOOK, operator, id(1))).status).toBe(200);
  const second = await start("cache-b");
  const service = serviceInFront();
  service.add(first.base);
  service.add(second.base);
  const people = peopleAtWork(service.base);

  // A request is sent every 40 ms: the pod is stopped between two of them (at 1,000 ms one is being sent, and whether it reaches the pod just before or just after it stops is a toss of a coin that is not what this test is about).
  await Bun.sleep(1020);
  // The worker is drained: the pod on it is told to stop, and the Service stops sending it requests a moment later. The other pod stays.
  first.signal("SIGTERM");
  setTimeout(() => service.remove(first.base), 600);
  expect(await first.exited).toBe(0);
  await Bun.sleep(1200);
  await people.stop();

  const { results } = people;
  expect(results.filter((result) => result.status !== 200).map((r) => r.status)).toEqual([]);
  expect(results.length).toBeGreaterThan(60);
  expect(Math.max(...results.map((result) => result.ms))).toBeLessThan(1500);
  // The pod that stayed holds the book now, and everything written is in it.
  expect(worker.core.peek("pilot-1").head.leaseHolder).not.toBeNull();
  const drafts = await call(second.base, "drafts.list", {}, operator);
  expect(drafts.body.data.drafts).toHaveLength(results.filter((result) => result.write).length);
  second.signal("SIGTERM");
  expect(await second.exited).toBe(0);
}, 60_000);

test("a pod that is lost with no warning costs the people only the time the cluster takes to notice, and the other pod then has the book as soon as its lease has lapsed", async () => {
  const { worker, start } = podsOfOneService({ leaseMs: 1000 });
  const lost = await start("cache-a");
  expect((await call(lost.base, "book.setup", BOOK, operator, id(1))).status).toBe(200);
  const stays = await start("cache-b");
  const service = serviceInFront();
  service.add(lost.base);
  service.add(stays.base);
  const people = peopleAtWork(service.base);

  // Between two of the requests that are sent every 40 ms, and not at the instant of one: a request that is on its way to the pod that stays, which hands it to the pod that held the book a moment before it
  // is killed, is refused as `book_busy` (retryable), which is true and not what this test is about.
  await Bun.sleep(1020);
  // The worker goes: nothing is said, nothing is given back. The cluster takes the pod out of the Service when it notices.
  const diedAt = people.now();
  lost.signal("SIGKILL");
  setTimeout(() => service.remove(lost.base), 800);
  await lost.exited;
  await Bun.sleep(3500);
  await people.stop();

  const { results } = people;
  // Requests failed only while the Service still sent them to the pod that was gone.
  const failed = results.filter((result) => result.status !== 200);
  expect(
    failed.every((result) => result.status === 502),
    JSON.stringify(failed.slice(0, 6)),
  ).toBe(true);
  expect(failed.every((result) => result.at < diedAt + 900)).toBe(true);
  // The ones that came to the pod that stayed waited for the lease and were answered, none longer than the lease and the wait allow.
  expect(
    results.filter((result) => result.at > diedAt + 900).every((result) => result.status === 200),
  ).toBe(true);
  expect(Math.max(...results.map((result) => result.ms))).toBeLessThan(4000);
  expect(worker.core.peek("pilot-1").head.leaseHolder).not.toBeNull();
  // What the people were told was done is in the book.
  const done = results.filter((result) => result.write && result.status === 200).length;
  const drafts = await call(stays.base, "drafts.list", {}, operator);
  expect(drafts.body.data.drafts.length).toBeGreaterThanOrEqual(done);
  expect(drafts.body.data.drafts.length).toBeLessThanOrEqual(
    results.filter((result) => result.write).length,
  );
  stays.signal("SIGTERM");
  expect(await stays.exited).toBe(0);
}, 60_000);

test("a process that cannot start says why and exits 78, and the three things it stands on are each missed by name", async () => {
  const run = async (env: Record<string, string>) => {
    const child = Bun.spawn([process.execPath, MAIN], {
      cwd: folder(),
      env: { PATH: process.env.PATH ?? "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, text: out + err };
  };
  const nothing = await run({});
  expect(nothing.code).toBe(78);
  expect(nothing.text).toContain("RASTRATA_BOOK_STORE");
  const root = folder();
  for (const missing of [
    "RASTRATA_OWNER_KEY",
    "RASTRATA_PUBLIC_ORIGIN",
    "RASTRATA_SERVICE_KEY_SHA256S",
  ]) {
    const without = await run({
      ...environment(root, { RASTRATA_BOOK_TAIL: "memory" }),
      [missing]: "",
    });
    expect(without.code, missing).toBe(78);
    expect(without.text, missing).toContain(missing);
  }
  const old = await run({
    ...environment(root, { RASTRATA_BOOK_TAIL: "memory" }),
    RASTRATA_BOOKS: "many",
  });
  expect(old.code).toBe(78);
  expect(old.text).toContain("RASTRATA_BOOKS is not a setting any more");
  const wrong = await run({
    ...environment(root, { RASTRATA_BOOK_TAIL: "memory" }),
    RASTRATA_REPLAY: "x",
  });
  expect(wrong.code).toBe(78);
  expect(wrong.text).not.toContain(OWNER_KEY);
});

// The hosted server on a Durable Object tail: how the tail is named and authenticated, that the token
// goes nowhere but the Authorization header of a call to it, what people are told when the tail is
// failing, how often it is called then, and the lease given up when nobody is using the book.
//
// The Worker itself is apps/tail-worker (tested there under Miniflare, with the hosted book on it); here the
// tail is a local server speaking the same protocol over HTTP with the reference tail behind it.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { APPLICATION_API_VERSION } from "@rastrata/application/schema";
import {
  DurableObjectLogTier,
  GuardedLogTier,
  HttpObjectStore,
  durableObjectHandler,
} from "@rastrata/booklog";
import { MemoryLogTier } from "@rastrata/booklog/testing";
import {
  kindOf,
  openBulkStore,
  openTail,
  parseBookStore,
  startHostedApplicationServer,
  tailToken,
} from "../src/hosted.ts";

const TOKEN = "tok-9f3a7c1e5b2d4a60-must-not-leak";
const BOOK = {
  name: "Hosted Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1010", name: "Checking", role: "asset" },
    { code: "3100", name: "Owner draw", role: "equity" },
    { code: "6100", name: "Software", role: "expense" },
  ],
} as const;
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
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
function folder(): string {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-hosted-tail-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** A server that speaks the Worker's protocol over HTTP with the reference tail behind it, that counts
 * what it is asked, and that can answer as Cloudflare does when a plan's daily limit is reached. */
function fakeWorker(token = TOKEN) {
  const core = new MemoryLogTier();
  const handler = durableObjectHandler(core, { token });
  const asked: string[] = [];
  const headers: (string | null)[] = [];
  let limit = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      asked.push(new URL(request.url).pathname.split("/").pop() ?? "");
      headers.push(request.headers.get("authorization"));
      if (limit)
        return new Response("<!DOCTYPE html><html><body><h1>Error 1027</h1></body></html>", {
          status: 429,
          headers: { "content-type": "text/html" },
        });
      return handler(request);
    },
  });
  cleanup.push(() => server.stop(true));
  return {
    core,
    asked,
    headers,
    url: `http://127.0.0.1:${server.port}`,
    limit(on: boolean) {
      limit = on;
    },
  };
}

async function start(
  tailUrl: string,
  options: {
    readonly env?: Record<string, string>;
    readonly leaseMs?: number;
    readonly idleReleaseMs?: number;
    readonly cache?: string;
    /** The folder that holds the bucket (a second server on the same book shares it). */
    readonly root?: string;
  } = {},
) {
  const root = options.root ?? folder();
  const env = { RASTRATA_BOOK_TAIL_TOKEN: TOKEN, ...options.env };
  const config = parseBookStore("r2log://book-1", {
    RASTRATA_BOOK_BULK: pathToFileURL(join(root, "bucket")).href,
    RASTRATA_BOOK_TAIL: tailUrl,
    RASTRATA_BOOK_CACHE: options.cache ?? join(root, "cache"),
  });
  const server = await startHostedApplicationServer({
    config,
    port: 0,
    telemetry: false,
    control: true,
    env,
    ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}),
    ...(options.idleReleaseMs !== undefined ? { idleReleaseMs: options.idleReleaseMs } : {}),
  });
  cleanup.push(() => server.stop());
  return { base: `http://127.0.0.1:${server.server.port}`, server, root };
}

interface Reply {
  readonly status: number;
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are inspected loosely
  readonly body: any;
  readonly headers: Headers;
}
async function operation(
  base: string,
  name: string,
  input: unknown = {},
  operationId?: string,
): Promise<Reply> {
  const response = await fetch(`${base}/v1/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: APPLICATION_API_VERSION,
      bookId: "local-book",
      input,
      ...(operationId ? { operationId } : {}),
    }),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
const control = async (base: string, path: string): Promise<Reply> => {
  const response = await fetch(`${base}/control/${path}`);
  return { status: response.status, body: await response.json(), headers: response.headers };
};
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

test("a Durable Object tail is named by https://host, or http on this computer, and the token is a setting of its own", async () => {
  const bulk = {} as never;
  const named = (tail: string) => ({
    ...parseBookStore("r2log://b?bulk=memory&tail=memory", {}),
    tail,
  });
  const env = { RASTRATA_BOOK_TAIL_TOKEN: TOKEN };

  for (const address of [
    "https://tail.rastrata.com",
    "http://127.0.0.1:8787",
    "http://localhost:8787",
    "http://[::1]:8787",
  ]) {
    const opened = await openTail(named(address), bulk, env);
    expect(opened.tier.capabilities.name).toBe("durable-object");
    expect(opened.remote).toBe(true);
    expect(kindOf(address)).toBe("do");
  }
  // The older spelling still works, for the same addresses.
  expect((await openTail(named("do:http://127.0.0.1:8787"), bulk, env)).remote).toBe(true);
  expect((await openTail(named("do:https://tail.rastrata.com"), bulk, env)).remote).toBe(true);
  expect(kindOf("do:http://127.0.0.1:8787")).toBe("do");
  // Other tails are not remote services of this kind.
  expect((await openTail(named("memory"), bulk, env)).remote).toBe(false);

  for (const [bad, message] of [
    ["http://tail.rastrata.com", /on this computer/],
    ["http://10.0.0.5:8787", /on this computer/],
    ["do:http://10.0.0.5:8787", /on this computer/],
    ["https://user:pa55word@tail.rastrata.com", /must not carry a name or a password/],
    ["do:ftp://tail.rastrata.com", /durable object tail is/],
    ["ftp://tail.rastrata.com", /The tail must be/],
  ] as const) {
    const error = await openTail(named(bad), bulk, env).then(
      () => null,
      (reason: unknown) => reason as Error,
    );
    expect(error?.message, bad).toMatch(message);
    expect(error?.message, bad).not.toContain("pa55word");
    expect(error?.message, bad).not.toContain(TOKEN);
  }
});

test("the bulk store can be the gateway of the tail Worker: https://host with the tail's token, http only on this computer", () => {
  const config = (bulk: string) => ({
    ...parseBookStore("r2log://b?bulk=memory&tail=memory", {}),
    bulk,
  });
  const env = { RASTRATA_BOOK_TAIL_TOKEN: TOKEN };
  for (const address of [
    "https://tail.rastrata.com",
    "http://127.0.0.1:8787",
    "http://localhost:8787",
  ]) {
    const store = openBulkStore(config(address), env);
    expect(store).toBeInstanceOf(HttpObjectStore);
    expect(kindOf(address, "bulk")).toBe("gateway");
  }
  // No S3 setting is needed or looked at.
  expect(() =>
    openBulkStore(config("https://tail.rastrata.com"), {
      ...env,
      RASTRATA_BOOK_S3_KEY_ID: undefined,
    }),
  ).not.toThrow();
  for (const [bad, message, settings] of [
    ["https://tail.rastrata.com", /needs the tail's token/, {}],
    ["http://tail.rastrata.com", /on this computer/, env],
    ["http://10.0.0.5:8787", /on this computer/, env],
    ["https://user:pa55word@tail.rastrata.com", /must not carry a name or a password/, env],
  ] as const) {
    const error = (() => {
      try {
        openBulkStore(config(bad), settings);
        return null;
      } catch (reason) {
        return reason as Error;
      }
    })();
    expect(error?.message, bad).toMatch(message);
    expect(error?.message, bad).not.toContain("pa55word");
    expect(error?.message, bad).not.toContain(TOKEN);
  }
});

test("the token comes from the environment or from a file (a mounted Secret), one or the other, and is never repeated", async () => {
  const directory = folder();
  const file = join(directory, "token");
  writeFileSync(file, `${TOKEN}\n`);
  expect(tailToken({ RASTRATA_BOOK_TAIL_TOKEN: TOKEN })).toBe(TOKEN);
  expect(tailToken({ RASTRATA_BOOK_TAIL_TOKEN_FILE: file })).toBe(TOKEN);
  expect(tailToken({})).toBeUndefined();
  const bad = async (env: Record<string, string>, message: RegExp) => {
    const error = (() => {
      try {
        tailToken(env);
        return null;
      } catch (reason) {
        return reason as Error;
      }
    })();
    expect(error?.message).toMatch(message);
    expect(error?.message).not.toContain(TOKEN);
    expect(error?.message).not.toContain(directory);
  };
  await bad({ RASTRATA_BOOK_TAIL_TOKEN: TOKEN, RASTRATA_BOOK_TAIL_TOKEN_FILE: file }, /not both/);
  await bad({ RASTRATA_BOOK_TAIL_TOKEN_FILE: join(directory, "missing") }, /cannot be read/);
  writeFileSync(join(directory, "empty"), "\n");
  await bad({ RASTRATA_BOOK_TAIL_TOKEN_FILE: join(directory, "empty") }, /is empty/);
  await bad({ RASTRATA_BOOK_TAIL_TOKEN: `${TOKEN} extra` }, /printable characters/);
  writeFileSync(join(directory, "two-lines"), `${TOKEN}\nsecond\n`);
  await bad(
    { RASTRATA_BOOK_TAIL_TOKEN_FILE: join(directory, "two-lines") },
    /printable characters/,
  );
  // A tail over https without a token is refused when it is opened, not on the first request.
  const named = {
    ...parseBookStore("r2log://b?bulk=memory&tail=memory", {}),
    tail: "https://tail.rastrata.com",
  };
  await expect(openTail(named, {} as never, {})).rejects.toThrow(/RASTRATA_BOOK_TAIL_TOKEN_FILE/);
  for (const timeout of ["50", "70000", "x", "1.5"])
    await expect(
      openTail(named, {} as never, {
        RASTRATA_BOOK_TAIL_TOKEN: TOKEN,
        RASTRATA_BOOK_TAIL_TIMEOUT_MS: timeout,
      }),
    ).rejects.toThrow(/TIMEOUT_MS/);
});

test("a hosted book on the tail: the token goes to the tail as a bearer and nowhere else, and a second server on the same tail finds the book", async () => {
  const output: string[] = [];
  const originals = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  for (const name of ["log", "info", "warn", "error"] as const)
    console[name] = (...parts: unknown[]) => {
      output.push(parts.map(String).join(" "));
    };
  const bodies: string[] = [];
  try {
    const worker = fakeWorker();
    const first = await start(worker.url);
    const root = first.root;
    const setup = await operation(first.base, "book.setup", BOOK, id(1));
    expect(setup.status).toBe(200);
    const created = await operation(first.base, "drafts.create", draft("one"), id(2));
    expect(created.status).toBe(200);
    bodies.push(JSON.stringify([setup.body, created.body]));
    // Every call to the tail carried the token as a bearer.
    expect(worker.asked.length).toBeGreaterThan(2);
    expect(new Set(worker.headers)).toEqual(new Set([`Bearer ${TOKEN}`]));
    // The entries are in the tail before the answers were given.
    expect(worker.core.peek("book-1").entries.length).toBeGreaterThanOrEqual(2);
    const status = await control(first.base, "status");
    expect(status.body).toMatchObject({ hosted: true, tail: "do", open: true });
    expect(status.body.breaker).toMatchObject({ state: "closed" });
    const health = await (await fetch(`${first.base}/health`)).text();
    bodies.push(
      JSON.stringify(status.body),
      health,
      await (await fetch(`${first.base}/control/tail`)).text(),
    );
    await first.server.stop();
    // A second server with a cache of its own reads the book from the log and the tail.
    const second = await start(worker.url, { root, cache: join(folder(), "cache") });
    const listed = await operation(second.base, "drafts.list");
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).toContain("one");
    bodies.push(JSON.stringify(listed.body));
  } finally {
    Object.assign(console, originals);
  }
  // Nowhere does the token, or the address of the tail, appear: not in an answer, a status, a log line.
  for (const text of [...bodies, ...output]) {
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("127.0.0.1:");
  }
  // (The server's own address is printed by main.ts, not here; the log lines above are this module's.)
});

test("with the tail at its limit people are told one thing, in the application's own shape, and the tail is called a few times, not at the pace of the callers", async () => {
  const worker = fakeWorker();
  const served = await start(worker.url, { leaseMs: 400 });
  await operation(served.base, "book.setup", BOOK, id(1));
  expect((await operation(served.base, "drafts.create", draft("before"), id(2))).status).toBe(200);
  const before = worker.asked.length;
  worker.limit(true);
  // The lease lapses (400 ms), the renewals are refused; then people go on asking.
  await sleep(600);
  const answers: Reply[] = [];
  for (let attempt = 0; attempt < 60; attempt += 1) {
    answers.push(
      attempt % 2 === 0
        ? await operation(served.base, "drafts.create", draft("during"), id(3))
        : await operation(served.base, "drafts.list"),
    );
    await sleep(10);
  }
  const limited = answers.filter((answer) => answer.body.error?.code === "service_limit");
  expect(limited.length).toBeGreaterThan(50);
  for (const answer of answers.filter((a) => a.body.error?.code !== "service_limit")) {
    // The first ones, before the breaker opened: a write whose fate is not known says so.
    expect(["commit_uncertain", "tail_unavailable"]).toContain(answer.body.error.code);
  }
  const one = limited[0] as Reply;
  expect(one.status).toBe(503);
  expect(one.headers.get("retry-after")).toMatch(/^[1-9][0-9]*$/);
  expect(one.body).toMatchObject({
    version: APPLICATION_API_VERSION,
    bookId: "local-book",
    ok: false,
    error: {
      code: "service_limit",
      message: "Service limit reached, try again later.",
      details: [],
      retryable: true,
    },
  });
  // The identity a write was sent with is echoed, as the application's own answers do.
  const write = limited.find((answer) => answer.body.operationId === id(3));
  expect(write).toBeDefined();
  // The tail was asked a handful of times meanwhile: the failures that opened the breaker, and a probe.
  const asked = worker.asked.length - before;
  expect(asked).toBeLessThan(15);
  const status = await control(served.base, "status");
  const breaker = status.body.breaker;
  expect(breaker.state).not.toBe("closed");
  expect(breaker.rejected).toBeGreaterThan(40);
  // The limit ends (the day turns over): the book comes back by itself, and what was refused is done once.
  worker.limit(false);
  let done: Reply | null = null;
  for (let attempt = 0; attempt < 40 && done?.status !== 200; attempt += 1) {
    await sleep(100);
    done = await operation(served.base, "drafts.create", draft("during"), id(3));
  }
  expect(done?.status).toBe(200);
  const listed = await operation(served.base, "drafts.list");
  const references = (listed.body.data.drafts as { data: { reference: string } }[])
    .map((item) => item.data.reference)
    .sort();
  expect(references).toEqual(["before", "during"]);
});

test("a lease nobody is using is given up after a while, and taken again with the next request; renewals stop in between", async () => {
  const worker = fakeWorker();
  // A lease of 300 ms is renewed every 100 ms; the book is let go after a second of quiet.
  const served = await start(worker.url, { leaseMs: 300, idleReleaseMs: 1000 });
  await operation(served.base, "book.setup", BOOK, id(1));
  await operation(served.base, "drafts.create", draft("one"), id(2));
  const leaseCalls = () =>
    worker.asked.filter((op) => op === "renew" || op === "acquire" || op === "release").length;
  const renewing = worker.asked.filter((op) => op === "renew").length;
  await sleep(600);
  expect(worker.asked.filter((op) => op === "renew").length).toBeGreaterThan(renewing + 2);
  expect(worker.core.peek("book-1").head.leaseHolder).not.toBeNull();
  // A second of quiet after the last request.
  await sleep(1200);
  expect(worker.core.peek("book-1").head.leaseHolder).toBeNull();
  expect(worker.asked.filter((op) => op === "release").length).toBe(1);
  // Nothing about the lease is asked again, however long it is quiet (what is sealed from the tail goes on).
  const quiet = leaseCalls();
  await sleep(1500);
  expect(leaseCalls()).toBe(quiet);
  const fence = worker.core.peek("book-1").head.fence;
  // The next request takes the lease back and is answered; nothing was lost.
  const again = await operation(served.base, "drafts.create", draft("two"), id(3));
  expect(again.status).toBe(200);
  expect(worker.core.peek("book-1").head.fence).toBeGreaterThan(fence);
  const listed = await operation(served.base, "drafts.list");
  expect(
    (listed.body.data.drafts as { data: { reference: string } }[])
      .map((item) => item.data.reference)
      .sort(),
  ).toEqual(["one", "two"]);
});

test("idle release is on by default for a Durable Object tail only, and a standby never has it", async () => {
  const worker = fakeWorker();
  const served = await start(worker.url);
  // A minute (`IDLE_RELEASE_MS`): a hold costs by the clock, and a book is ready again before the page asks for it (the page says which workspace is open, and a starting server opens the books in use).
  expect((await control(served.base, "status")).body.idle_release_ms).toBe(60_000);
  const memory = await startHostedApplicationServer({
    config: parseBookStore("r2log://b?bulk=memory&tail=memory", {}),
    port: 0,
    telemetry: false,
    control: true,
  });
  cleanup.push(() => memory.stop());
  const status = await control(`http://127.0.0.1:${memory.server.port}`, "status");
  expect(status.body.idle_release_ms).toBe(0);
  expect(status.body.breaker).toBeNull();
  await expect(
    startHostedApplicationServer({
      config: parseBookStore("r2log://b?bulk=memory&tail=memory", {}),
      port: 0,
      telemetry: false,
      idleReleaseMs: -5,
    }),
  ).rejects.toThrow(/IDLE_RELEASE_MS/);
});

test("the breaker can be left out, and then a tail that fails is answered as any tail is", async () => {
  const worker = fakeWorker();
  const root = folder();
  const config = parseBookStore("r2log://book-1", {
    RASTRATA_BOOK_BULK: pathToFileURL(join(root, "bucket")).href,
    RASTRATA_BOOK_TAIL: worker.url,
    RASTRATA_BOOK_CACHE: join(root, "cache"),
  });
  const server = await startHostedApplicationServer({
    config,
    port: 0,
    telemetry: false,
    control: true,
    env: { RASTRATA_BOOK_TAIL_TOKEN: TOKEN },
    guard: false,
  });
  cleanup.push(() => server.stop());
  const base = `http://127.0.0.1:${server.server.port}`;
  expect((await operation(base, "book.setup", BOOK, id(1))).status).toBe(200);
  expect((await control(base, "status")).body.breaker).toBeNull();
  worker.limit(true);
  const asked = worker.asked.length;
  for (let attempt = 0; attempt < 5; attempt += 1)
    await operation(base, "drafts.create", draft("x"), id(10 + attempt));
  // Every try went to the tail: nothing stood between the callers and it.
  expect(worker.asked.length - asked).toBeGreaterThanOrEqual(5);
});

test("the breaker is the one in the library, and the client it guards is the Worker's", () => {
  // (A guard on a client: nothing is called until a request is made.)
  const tier = new GuardedLogTier(
    new DurableObjectLogTier({ baseUrl: "https://tail.invalid", token: TOKEN }),
  );
  expect(tier.capabilities.name).toBe("durable-object");
  expect(JSON.stringify(tier.status())).not.toContain(TOKEN);
});

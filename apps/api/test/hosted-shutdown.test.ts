// Stopping the hosted server the way a pod is stopped: no new requests, the ones in flight are given
// their time and no more, then the tail is sealed and the lease is given back. The process itself (a
// real SIGTERM) is in hosted-main.test.ts; here the stop is called in this process, so that a request can
// be held in flight and a tail can be made slow.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { issueOwnerKey } from "@rastrata/application/agent";
import { APPLICATION_API_VERSION } from "@rastrata/application/schema";
import type { LogTier } from "@rastrata/booklog";
import { MemoryLogTier } from "@rastrata/booklog/testing";
import { parseBookStore, startHostedApplicationServer } from "../src/hosted.ts";

const OWNER_KEY = issueOwnerKey();
const AUTH = { authorization: `Bearer ${OWNER_KEY}` };
const BOOK = {
  name: "Stopping Co",
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

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** The tail, with the appends of a chosen book held back until `open()` is called. */
function gatedTail(inner: MemoryLogTier) {
  let held = false;
  let release = () => {};
  let opened = Promise.resolve();
  const tier: LogTier = {
    capabilities: inner.capabilities,
    head: (book) => inner.head(book),
    readFrom: (book, seq, limit) => inner.readFrom(book, seq, limit),
    acquire: (book, holder, ttl) => inner.acquire(book, holder, ttl),
    renew: (book, lease, ttl) => inner.renew(book, lease, ttl),
    release: (book, lease) => inner.release(book, lease),
    seal: (book, input) => inner.seal(book, input),
    append: async (book, input) => {
      if (held) await opened;
      return inner.append(book, input);
    },
  };
  return {
    tier,
    hold() {
      held = true;
      opened = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    open() {
      held = false;
      release();
    },
  };
}

async function start() {
  const root = mkdtempSync(join(tmpdir(), "rastrata-shutdown-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const core = new MemoryLogTier();
  const gate = gatedTail(core);
  const lines: string[] = [];
  const server = await startHostedApplicationServer({
    config: parseBookStore("r2log://book-1", {
      RASTRATA_BOOK_BULK: pathToFileURL(join(root, "bucket")).href,
      RASTRATA_BOOK_TAIL: "memory",
      RASTRATA_BOOK_CACHE: join(root, "cache"),
    }),
    port: 0,
    telemetry: false,
    ownerKey: OWNER_KEY,
    stores: { tail: gate.tier },
    log: (line) => lines.push(line),
  });
  cleanup.push(async () => {
    gate.open();
    await server.stop();
  });
  const base = `http://127.0.0.1:${server.server.port}`;
  const call = (name: string, input: unknown, operationId?: string) =>
    fetch(`${base}/v1/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({
        version: APPLICATION_API_VERSION,
        bookId: "local-book",
        input,
        ...(operationId ? { operationId } : {}),
      }),
    });
  await call("book.setup", BOOK, id(1)).then((response) => response.text());
  return { server, core, gate, call, base, lines };
}

test("a stop lets the request in flight finish, then seals what the tail holds and gives the lease back", async () => {
  const { server, core, gate, call, base } = await start();
  expect(core.peek("book-1").head.leaseHolder).not.toBeNull();
  gate.hold();
  // A write that is waiting for the tail to take its entry when the stop begins.
  const writing = call("drafts.create", draft("in flight"), id(2));
  await Bun.sleep(100);
  const stopping = server.stop({ graceMs: 5000, closeMs: 5000 });
  await Bun.sleep(100);
  // The listener is closed at once: nobody new gets in.
  await expect(fetch(`${base}/live`, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
  gate.open();
  const answer = await writing;
  expect(answer.status).toBe(200);
  await stopping;
  expect(server.clean).toBe(true);
  const head = core.peek("book-1").head;
  // The entry the request made is in the log, sealed, and nobody holds the book.
  expect(head.seq).toBeGreaterThanOrEqual(2);
  expect(head.sealedThrough).toBe(head.seq);
  expect(head.leaseHolder).toBeNull();
  expect(core.peek("book-1").entries).toHaveLength(0);
});

test("a stop does not wait longer than it was told for a request that does not finish, and says the book was not closed in time", async () => {
  const { server, core, gate, call, lines } = await start();
  gate.hold();
  // A write whose entry the tail never takes, and which holds the book while it waits.
  const stuck = call("drafts.create", draft("stuck"), id(2)).catch(() => null);
  await Bun.sleep(100);
  const started = performance.now();
  await server.stop({ graceMs: 300, closeMs: 400 });
  const took = performance.now() - started;
  expect(took).toBeGreaterThanOrEqual(600);
  expect(took).toBeLessThan(3000);
  expect(server.clean).toBe(false);
  expect(lines.join("\n")).toContain("could not be sealed and released in time");
  // What the book had not given back lapses by itself: the next holder does not need this process.
  expect(core.peek("book-1").head.seq).toBeGreaterThanOrEqual(1);
  gate.open();
  await stuck;
});

test("a stop is the same stop however many times it is asked for, and a request that comes late does not take the book again", async () => {
  const { server, core, call } = await start();
  await call("drafts.create", draft("one"), id(2)).then((response) => response.text());
  const first = server.stop({ graceMs: 2000, closeMs: 2000 });
  const second = server.stop();
  expect(second).toBe(first);
  await first;
  expect(server.clean).toBe(true);
  expect(core.peek("book-1").head.leaseHolder).toBeNull();
  // Closed: the listener is gone, and nothing took the lease again.
  await Bun.sleep(100);
  expect(core.peek("book-1").head.leaseHolder).toBeNull();
  expect(server.book).toBeNull();
});

// ---- a pod beside the pod it replaces ---------------------------------------------------------------------------------

/** Two servers on one book, as the pods of an update are: one tail and one bucket between them, a cache each. These tests are of the wait for a book, which is what a pod does when it cannot hand the
 * request to the pod that holds it, so the pods are told not to (hosted-peers.test.ts has the hand-on). */
async function pair(secondOptions: { readonly leaseWaitMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rastrata-pair-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const core = new MemoryLogTier();
  const open = async (
    cache: string,
    extra: { readonly leaseWaitMs?: number; readonly peers?: false } = {},
  ) => {
    const server = await startHostedApplicationServer({
      config: parseBookStore("r2log://book-1", {
        RASTRATA_BOOK_BULK: pathToFileURL(join(root, "bucket")).href,
        RASTRATA_BOOK_TAIL: "memory",
        RASTRATA_BOOK_CACHE: join(root, cache),
      }),
      port: 0,
      telemetry: false,
      ownerKey: OWNER_KEY,
      stores: { tail: core },
      peers: false,
      ...extra,
    });
    cleanup.push(() => server.stop());
    const base = `http://127.0.0.1:${server.server.port}`;
    const call = (name: string, input: unknown, operationId?: string) =>
      fetch(`${base}/v1/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...AUTH },
        body: JSON.stringify({
          version: APPLICATION_API_VERSION,
          bookId: "local-book",
          input,
          ...(operationId ? { operationId } : {}),
        }),
      });
    return { server, base, call };
  };
  const first = await open("cache-first");
  await first.call("book.setup", BOOK, id(1)).then((response) => response.text());
  const second = await open("cache-second", secondOptions);
  return { core, first, second };
}

test("a pod that cannot hand a request to the pod that holds its book waits for the book, and has it when that pod stops", async () => {
  const { core, first, second } = await pair();
  const holder = core.peek("book-1").head.leaseHolder;
  expect(holder).not.toBeNull();
  let answered: number | null = null;
  const asking = second.call("drafts.create", draft("beside"), id(2)).then((response) => {
    answered = response.status;
    return response;
  });
  await Bun.sleep(500);
  // Still waiting: it was not turned away, and it did not take a book that is held.
  expect(answered).toBeNull();
  expect(core.peek("book-1").head.leaseHolder).toBe(holder);
  await first.server.stop({ graceMs: 2000, closeMs: 2000 });
  const response = await asking;
  expect(response.status).toBe(200);
  expect(core.peek("book-1").head.leaseHolder).not.toBe(holder);
  expect(core.peek("book-1").head.leaseHolder).not.toBeNull();
});

test("a pod waits for a book that is held no longer than it is allowed to, and then says the book is busy", async () => {
  const { core, first, second } = await pair({ leaseWaitMs: 700 });
  const holder = core.peek("book-1").head.leaseHolder;
  const started = performance.now();
  const response = await second.call("drafts.list", {});
  const waited = performance.now() - started;
  expect(response.status).toBe(503);
  expect(await response.text()).toContain("book_busy");
  expect(waited).toBeGreaterThanOrEqual(650);
  expect(waited).toBeLessThan(3000);
  // The holder never noticed.
  expect(core.peek("book-1").head.leaseHolder).toBe(holder);
  expect((await first.call("drafts.list", {})).status).toBe(200);
});

test("with no wait allowed, a book that is held is refused at once", async () => {
  const { second } = await pair({ leaseWaitMs: 0 });
  const started = performance.now();
  const response = await second.call("drafts.list", {});
  expect(response.status).toBe(503);
  expect(await response.text()).toContain("book_busy");
  expect(performance.now() - started).toBeLessThan(400);
});

test("a server that has announced its stop is not ready, asks for its connections to be closed, and goes on answering until it is stopped", async () => {
  const { server, call, base } = await start();
  const probe = (path: string) => fetch(`${base}${path}`, { headers: { host: "10.0.0.9:8080" } });
  expect((await probe("/ready")).status).toBe(200);
  expect((await probe("/ready")).headers.get("connection")).toBeNull();
  server.announceStop();
  const notReady = await probe("/ready");
  expect(notReady.status).toBe(503);
  expect(await notReady.json()).toMatchObject({ ready: false, reason: "shutting_down" });
  expect(notReady.headers.get("connection")).toBe("close");
  expect((await probe("/live")).status).toBe(200);
  // The book is still served: a request that was already on its way is answered.
  const answer = await call("drafts.create", draft("late"), id(2));
  expect(answer.status).toBe(200);
  expect(answer.headers.get("connection")).toBe("close");
  await server.stop();
  expect(server.clean).toBe(true);
});

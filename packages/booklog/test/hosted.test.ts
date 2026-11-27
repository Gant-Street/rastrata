import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualClock } from "../src/clock.ts";
import { decodeChangeSet } from "../src/codec.ts";
import { payloadOf } from "../src/entry.ts";
import { HostedBook, type HostedApplication, type HostedBookOptions } from "../src/hosted.ts";
import { LeaseHeldElsewhereError } from "../src/lease.ts";
import { MemoryObjectStore } from "../src/memory.ts";
import { SimPodClock } from "../src/podclock.ts";
import { BookRuntime, type BookRuntimeOptions } from "../src/runtime.ts";
import { MemoryLogTier } from "../src/tier-memory.ts";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ops (id TEXT PRIMARY KEY, result TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, what TEXT NOT NULL);
`;

/** A small application with the faults of a real one: it keeps what it has read in memory, so it is
 * wrong after the database changes beneath it unless it is built again. */
let toys = 0;
class Toy implements HostedApplication {
  readonly totals = new Map<string, number>();
  readonly id = ++toys;
  closed = false;
  constructor(
    readonly db: Database,
    readonly carried?: unknown,
  ) {
    db.exec(SCHEMA);
    for (const row of db.query("SELECT k, v FROM kv").all() as { k: string; v: number }[])
      this.totals.set(row.k, row.v);
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/add") {
      const body = (await request.json()) as { operationId: string; key: string; amount: number };
      const done = this.db.query("SELECT result FROM ops WHERE id=?").get(body.operationId) as {
        result: string;
      } | null;
      if (done) return Response.json({ total: Number(done.result), replay: true });
      this.db.run(
        "INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = v + excluded.v",
        [body.key, body.amount],
      );
      const total = (this.db.query("SELECT v FROM kv WHERE k=?").get(body.key) as { v: number }).v;
      this.db.run("INSERT INTO ops (id, result) VALUES (?, ?)", [body.operationId, String(total)]);
      this.totals.set(body.key, total);
      return Response.json({ total });
    }
    if (request.method === "GET" && url.pathname === "/total") {
      const key = url.searchParams.get("key") ?? "";
      const stored = (this.db.query("SELECT v FROM kv WHERE k=?").get(key) as { v: number } | null)
        ?.v;
      return Response.json({ memory: this.totals.get(key) ?? 0, stored: stored ?? 0 });
    }
    if (request.method === "GET" && url.pathname === "/audited") {
      this.db.run("INSERT INTO audit (what) VALUES (?)", [url.search]);
      return Response.json({ audited: true });
    }
    return new Response("not found", { status: 404 });
  }
  /** What the next application may start from: here only the name of this one, so that a test can see what was handed on. */
  carry() {
    return { from: this.id };
  }
  close() {
    this.closed = true;
  }
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

class World {
  readonly clock = new VirtualClock();
  readonly tier = new MemoryLogTier({ clock: this.clock });
  readonly bulk = new MemoryObjectStore({ clock: this.clock });
  readonly directory = (() => {
    const path = mkdtempSync(join(tmpdir(), "booklog-hosted-"));
    directories.push(path);
    return path;
  })();
  readonly apps: Toy[] = [];
  /** Every time the application was built: why, and what it was given from the one before. */
  readonly built: { reason: string; carried: unknown }[] = [];

  runtimeOptions(holder: string, file = "cache.sqlite"): BookRuntimeOptions {
    return {
      tier: this.tier,
      bulk: this.bulk,
      bookId: "b1",
      prefix: "runs/t/",
      holder,
      path: join(this.directory, file),
      schema: 1,
      clock: this.clock,
      pod: new SimPodClock(this.clock),
      sealing: { delayMs: 0 },
    };
  }
  options(holder: string, file = "cache.sqlite"): HostedBookOptions {
    return {
      ...this.runtimeOptions(holder, file),
      open: async (db, reason, carried) => {
        this.built.push({ reason, carried });
        const app = new Toy(db, carried);
        this.apps.push(app);
        return app;
      },
      changesBook: (request) => request.method === "POST",
    };
  }
  open(holder: string, extra: Partial<HostedBookOptions> = {}, file = "cache.sqlite") {
    return HostedBook.open({ ...this.options(holder, file), ...extra });
  }
  sleep(ms: number) {
    return this.clock.drive(this.clock.sleep(ms));
  }
}

const add = (key: string, amount: number, operationId = crypto.randomUUID()) =>
  new Request("http://book.invalid/add", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operationId, key, amount }),
  });
const total = (key: string) => new Request(`http://book.invalid/total?key=${key}`);

test("a request that changes the book is in the log when it is answered, and a read is served from the cache", async () => {
  const w = new World();
  const book = await w.open("pod-a#1");
  // Opening the application on a new book made the first entry: its tables.
  expect(w.tier.peek("b1").entries).toHaveLength(1);
  const first = await book.fetch(add("cash", 10));
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ total: 10 });
  expect(w.tier.peek("b1").entries).toHaveLength(2);
  const read = await book.fetch(total("cash"));
  expect(await read.json()).toEqual({ memory: 10, stored: 10 });
  // The read made no entry.
  expect(w.tier.peek("b1").entries).toHaveLength(2);
  expect(book.resets).toBe(0);
  const hash = book.runtime.capture.stateHash();
  await book.close({ seal: false });
  const cold = await BookRuntime.open(w.runtimeOptions("pod-b#1", "cold.sqlite"));
  expect(cold.capture.stateHash()).toBe(hash);
  await cold.close();
});

test("a read that writes (an audit row) is logged before it is answered", async () => {
  const w = new World();
  const book = await w.open("pod-a#1");
  await book.fetch(add("cash", 1));
  const before = w.tier.peek("b1").entries.length;
  const answer = await book.fetch(new Request("http://book.invalid/audited?by=agent"));
  expect(await answer.json()).toEqual({ audited: true });
  expect(w.tier.peek("b1").entries).toHaveLength(before + 1);
  expect(book.runtime.stats.readFlushes).toBe(1);
  await book.close();
});

test("a host decides per request whether a read's effects are logged first or soon", async () => {
  const w = new World();
  const book = await w.open("pod-a#1", {
    readEffects: { mode: "defer", deferMs: 500 },
    // The audit of a request made "by an agent" must be in the log before the answer.
    effects: (request) => (new URL(request.url).search.includes("strict") ? "log-first" : "defer"),
  });
  await book.fetch(add("cash", 1));
  const entries = () => w.tier.peek("b1").entries.length;
  const before = entries();
  await book.fetch(new Request("http://book.invalid/audited?by=owner"));
  expect(entries()).toBe(before);
  expect(book.runtime.stats.readsDeferred).toBe(1);
  await w.sleep(600);
  expect(entries()).toBe(before + 1);
  await book.fetch(new Request("http://book.invalid/audited?by=agent&strict"));
  expect(entries()).toBe(before + 2);
  expect(book.runtime.stats.readFlushes).toBe(1);
  await book.close();
});

test("a read that must be logged first is refused when the tail cannot take it, and one that need not is served", async () => {
  const w = new World();
  const book = await w.open("pod-a#1", {
    readEffects: { mode: "defer", deferMs: 500 },
    effects: (request) => (new URL(request.url).search.includes("agent") ? "log-first" : undefined),
  });
  await book.fetch(add("cash", 1));
  const entries = () => w.tier.peek("b1").entries.length;
  const before = entries();
  // The tail takes nothing, and cannot say whether it took anything.
  w.tier.script([
    { op: "append", fault: "failBefore", times: 50 },
    { op: "head", fault: "failBefore", times: 50 },
  ]);
  w.tier.wire.configure({ timeoutMs: 100 });
  const refused = await w.clock.drive(
    book.fetch(new Request("http://book.invalid/audited?by=agent")),
  );
  expect(refused.status).toBe(503);
  expect(await refused.json()).toMatchObject({
    ok: false,
    error: { code: "read_not_logged", retryable: true },
  });
  // The owner's read is served from the cache and waits for nothing; so is a read that wrote nothing.
  const served = await w.clock.drive(
    book.fetch(new Request("http://book.invalid/audited?by=owner")),
  );
  expect(served.status).toBe(200);
  expect(await served.json()).toEqual({ audited: true });
  expect((await w.clock.drive(book.fetch(total("cash")))).status).toBe(200);
  expect(entries()).toBe(before);
  // Once the tail is back the next write carries what was left, once.
  w.tier.wire.clearScript();
  expect((await w.clock.drive(book.fetch(add("cash", 2)))).status).toBe(200);
  expect(entries()).toBe(before + 1);
  const hash = book.runtime.capture.stateHash();
  await book.close({ seal: false });
  const cold = await BookRuntime.open(w.runtimeOptions("pod-b#1", "cold.sqlite"));
  expect(cold.capture.stateHash()).toBe(hash);
  await cold.close();
});

test("losing a race: the application is built again on the new state and the request runs again with its body intact", async () => {
  const w = new World();
  const slow = new SimPodClock(w.clock, { rate: 0.2 });
  const a = await w.open("pod-a#1", {
    pod: slow,
    lease: { ttlMs: 3000, renewEveryMs: 1e9, skewToleranceMs: 1e12 },
  });
  expect((await a.fetch(add("cash", 10))).status).toBe(200);
  await w.sleep(4000);
  const b = await BookRuntime.open(w.runtimeOptions("pod-b#1", "b.sqlite"));
  await b.write((db) => {
    db.exec(SCHEMA);
    db.run("INSERT INTO kv (k, v) VALUES ('cash', 15) ON CONFLICT(k) DO UPDATE SET v = 15");
  });
  await b.close({ seal: false });
  const appsBefore = w.apps.length;
  const reply = await a.fetch(add("cash", 1));
  expect(reply.status).toBe(200);
  expect(await reply.json()).toEqual({ total: 16 });
  expect(a.resets).toBeGreaterThanOrEqual(1);
  expect(w.apps.length).toBeGreaterThan(appsBefore);
  // The application that answered was built on the state after B's change: its memory is right.
  const read = await a.fetch(total("cash"));
  expect(await read.json()).toEqual({ memory: 16, stored: 16 });
  expect(w.apps.slice(0, -1).every((app) => app.closed)).toBe(true);
  await a.close();
});

test("an application built after entries were caught up from the log is given what the one before carried, and one built at the first open is not", async () => {
  const w = new World();
  const slow = new SimPodClock(w.clock, { rate: 0.2 });
  const a = await w.open("pod-a#1", {
    pod: slow,
    lease: { ttlMs: 3000, renewEveryMs: 1e9, skewToleranceMs: 1e12 },
  });
  expect((await a.fetch(add("cash", 10))).status).toBe(200);
  // The first open has nothing before it to carry from.
  expect(w.built).toEqual([{ reason: "open", carried: undefined }]);
  const first = w.apps[0] as Toy;
  // Another pod writes after this one's lease has lapsed.
  await w.sleep(4000);
  const b = await BookRuntime.open(w.runtimeOptions("pod-b#1", "b.sqlite"));
  await b.write((db) => {
    db.exec(SCHEMA);
    db.run("INSERT INTO kv (k, v) VALUES ('cash', 15) ON CONFLICT(k) DO UPDATE SET v = 15");
  });
  await b.close({ seal: false });
  expect((await a.fetch(add("cash", 1))).status).toBe(200);
  // The log was caught up, and the application built then began from what the one it replaced had worked out.
  const caught = w.built.filter((item) => item.reason === "caught-up");
  expect(caught.length).toBeGreaterThanOrEqual(1);
  expect(caught[0]?.carried).toEqual({ from: first.id });
  // Its memory is the state after the other pod's change, as it was without carrying.
  expect(await (await a.fetch(total("cash"))).json()).toEqual({ memory: 16, stored: 16 });
  await a.close();
});

test("a commit whose fate is unknown is a retryable 503; sending it again under its identity finds it done", async () => {
  const w = new World();
  const book = await w.open("pod-a#1");
  await book.fetch(add("cash", 1));
  w.tier.script([
    { op: "append", fault: "failAfter", times: 10 },
    { op: "head", fault: "failBefore", times: 10 },
  ]);
  w.tier.wire.configure({ timeoutMs: 100 });
  const operationId = crypto.randomUUID();
  const failed = await w.clock.drive(book.fetch(add("cash", 7, operationId)));
  expect(failed.status).toBe(503);
  const body = (await failed.json()) as {
    ok: boolean;
    error: { code: string; retryable: boolean };
  };
  expect(body).toMatchObject({ ok: false, error: { code: "commit_uncertain", retryable: true } });
  expect(failed.headers.get("retry-after")).toBe("1");
  w.tier.wire.clearScript();
  // The append did land; the client does not know. It asks again.
  expect(w.tier.peek("b1").entries).toHaveLength(3);
  const again = await w.clock.drive(book.fetch(add("cash", 7, operationId)));
  expect(again.status).toBe(200);
  expect(await again.json()).toEqual({ total: 8, replay: true });
  expect(w.tier.peek("b1").entries).toHaveLength(3);
  // The application's memory was repaired, not left holding the undone request.
  expect(await (await book.fetch(total("cash"))).json()).toEqual({ memory: 8, stored: 8 });
  await book.close();
});

test("a newer release that changes the schema when it opens logs that change like any other", async () => {
  const w = new World();
  const first = await w.open("pod-a#1");
  await first.fetch(add("cash", 5));
  await first.close({ seal: false });
  const second = await w.open("pod-a#2", {
    open: async (db) => {
      db.exec("ALTER TABLE kv ADD COLUMN note TEXT");
      db.exec("CREATE TABLE IF NOT EXISTS extra (id INTEGER PRIMARY KEY, label TEXT)");
      return new Toy(db);
    },
  });
  const entries = w.tier.peek("b1").entries;
  expect(entries.at(-1)?.seq).toBe(3);
  const last = entries.at(-1);
  const changes = decodeChangeSet(payloadOf((last as { body: Uint8Array }).body)).changes;
  expect(changes.some((change) => change.op === "ddl" && change.sql.includes("ADD COLUMN"))).toBe(
    true,
  );
  const hash = second.runtime.capture.stateHash();
  await second.close({ seal: false });
  const cold = await w.open("pod-b#1", {}, "cold.sqlite");
  expect(cold.runtime.capture.stateHash()).toBe(hash);
  expect(
    cold.runtime.db.query("SELECT count(*) c FROM pragma_table_info('kv') WHERE name='note'").get(),
  ).toEqual({ c: 1 });
  await cold.close();
});

test("a failure the book cannot answer is not hidden: an application error is the application's own answer", async () => {
  const w = new World();
  const book = await w.open("pod-a#1");
  const reply = await book.fetch(new Request("http://book.invalid/nothing", { method: "POST" }));
  expect(reply.status).toBe(404);
  expect(await reply.text()).toBe("not found");
  await book.close();
});

test("a standby follows the log with its application built and warmed, refuses requests, and takes the book over without building it again when it is current", async () => {
  const w = new World();
  const active = await w.open("pod-a#1");
  await active.fetch(add("cash", 10));
  let warmed = 0;
  const standby = await HostedBook.openStandby({
    ...w.options("pod-b#1", "b.sqlite"),
    warm: async () => {
      warmed += 1;
    },
  });
  expect(standby.runtime.standby).toBe(true);
  expect(standby.warmed).toBe(true);
  expect(warmed).toBe(1);
  // It does not serve, and says why.
  const refused = await standby.fetch(total("cash"));
  expect(refused.status).toBe(503);
  expect(await refused.json()).toMatchObject({ error: { code: "book_standby", retryable: true } });
  // The active pod writes; the standby follows: its application is built again, and warmed again.
  await active.fetch(add("cash", 5));
  const before = standby.resets;
  expect(await standby.follow()).toMatchObject({ applied: 1 });
  expect(standby.resets).toBe(before + 1);
  expect(warmed).toBe(2);
  // Nothing new in the log: nothing is built again.
  expect(await standby.follow()).toMatchObject({ applied: 0 });
  expect(warmed).toBe(2);
  // It cannot take the book while another holds it.
  await expect(standby.promote()).rejects.toBeInstanceOf(LeaseHeldElsewhereError);
  expect(standby.runtime.standby).toBe(true);
  await active.close();
  const app = standby.application;
  const built = w.apps.length;
  await standby.promote();
  expect(standby.runtime.standby).toBe(false);
  // Current at the moment of taking the book: the application it had built and warmed is the one that serves.
  expect(standby.application).toBe(app);
  expect(w.apps.length).toBe(built);
  expect(await (await standby.fetch(total("cash"))).json()).toEqual({ memory: 15, stored: 15 });
  expect((await standby.fetch(add("cash", 1))).status).toBe(200);
  // The new holder's entries carry a new, larger fence than the one that let go.
  expect((await w.tier.head("b1")).fence).toBeGreaterThanOrEqual(2);
  await standby.close();
});

test("a standby that is behind when it takes the book catches up first, and builds its application again", async () => {
  const w = new World();
  const active = await w.open("pod-a#1");
  await active.fetch(add("cash", 10));
  const standby = await HostedBook.openStandby(w.options("pod-b#1", "b.sqlite"));
  // Written after the standby last looked.
  await active.fetch(add("cash", 5));
  await active.close();
  const first = standby.application;
  await standby.promote();
  expect(standby.application).not.toBe(first);
  expect(await (await standby.fetch(total("cash"))).json()).toEqual({ memory: 15, stored: 15 });
  await standby.close();
});

test("a process that is draining answers reads and refuses writes, and what a read left unsent still goes out", async () => {
  const w = new World();
  const book = await w.open("pod-a#1");
  await book.fetch(add("cash", 1));
  book.drain();
  expect(book.runtime.draining).toBe(true);
  const refused = await book.fetch(add("cash", 1));
  expect(refused.status).toBe(503);
  expect(await refused.json()).toMatchObject({ error: { code: "book_draining", retryable: true } });
  expect(await (await book.fetch(total("cash"))).json()).toEqual({ memory: 1, stored: 1 });
  // A read that wrote (an audit row) is still made durable before it is answered.
  const before = w.tier.peek("b1").entries.length;
  expect((await book.fetch(new Request("http://book.invalid/audited?by=agent"))).status).toBe(200);
  expect(w.tier.peek("b1").entries).toHaveLength(before + 1);
  // Nothing the refused write would have done happened.
  expect(await (await book.fetch(total("cash"))).json()).toEqual({ memory: 1, stored: 1 });
  await book.close();
});

/** What a test says to an application that is not ready for a write until it is told, and that makes a check behind its answers which the test begins, finishes and fails. */
class Control {
  asked = 0;
  check: Promise<void> | null = null;
  ready: Promise<void> = Promise.resolve();
  release: () => void = () => {};
  #settle: { resolve: () => void; reject: (error: unknown) => void } | null = null;
  /** Not ready until `release`. */
  hold(): this {
    this.ready = new Promise<void>((resolve) => {
      this.release = resolve;
    });
    return this;
  }
  /** The application's first read has been answered, and it has begun its check. */
  begin(): void {
    this.check = new Promise<void>((resolve, reject) => {
      this.#settle = { resolve, reject };
    });
    // As the application does: nobody is left with an unhandled rejection, whoever watches the check.
    this.check.catch(() => {});
  }
  finish(): void {
    this.#settle?.resolve();
  }
  fail(error: unknown): void {
    this.#settle?.reject(error);
  }
}

class Checked extends Toy {
  constructor(
    db: Database,
    carried: unknown,
    readonly control: Control,
  ) {
    super(db, carried);
  }
  beforeWrite(): Promise<void> {
    this.control.asked += 1;
    return this.control.ready;
  }
  verification(): Promise<void> | null {
    return this.control.check;
  }
}

const checkedBy = (control: Control): Pick<HostedBookOptions, "open"> => ({
  open: async (db, _reason, carried) => new Checked(db, carried, control),
});
/** Let what is waiting on a promise that has settled run. */
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("a write waits for what the application needs before a command is run on the book, and a read does not wait", async () => {
  const w = new World();
  const control = new Control().hold();
  const book = await w.open("pod-a#1", checkedBy(control));
  const write = book.fetch(add("cash", 5));
  // The reads of the book are answered while the write waits.
  expect(await (await book.fetch(total("cash"))).json()).toEqual({ memory: 0, stored: 0 });
  expect(control.asked).toBe(1);
  expect(w.tier.peek("b1").entries).toHaveLength(1);
  control.release();
  expect((await write).status).toBe(200);
  expect(await (await book.fetch(total("cash"))).json()).toEqual({ memory: 5, stored: 5 });
  // A read never asks.
  expect(control.asked).toBe(1);
  await book.close({ seal: false });
});

test("a write the application is not ready for is refused with its reason, and nothing is stored", async () => {
  const w = new World();
  const control = new Control();
  control.ready = Promise.reject(new Error("the ledger does not replay"));
  control.ready.catch(() => {});
  const book = await w.open("pod-a#1", checkedBy(control));
  await expect(book.fetch(add("cash", 1))).rejects.toThrow("the ledger does not replay");
  expect(w.tier.peek("b1").entries).toHaveLength(1);
  expect(await (await book.fetch(total("cash"))).json()).toEqual({ memory: 0, stored: 0 });
  await book.close({ seal: false });
});

test("a check the application makes behind its answers is watched from the request after which it exists, and a failure is reported once", async () => {
  const w = new World();
  const control = new Control();
  const seen: unknown[] = [];
  const book = await w.open("pod-a#1", {
    ...checkedBy(control),
    unsound: (error) => {
      seen.push(error);
    },
  });
  await book.fetch(total("cash"));
  await settled();
  expect(seen).toEqual([]);
  control.begin();
  await book.fetch(total("cash"));
  control.fail(new Error("the ledger does not replay"));
  await settled();
  expect(seen).toHaveLength(1);
  expect((seen[0] as Error).message).toBe("the ledger does not replay");
  // Asked again, it is not reported again.
  await book.fetch(total("cash"));
  await settled();
  expect(seen).toHaveLength(1);
  await book.close({ seal: false });
});

test("a check that ends well is not reported", async () => {
  const w = new World();
  const control = new Control();
  const seen: unknown[] = [];
  const book = await w.open("pod-a#1", {
    ...checkedBy(control),
    unsound: (error) => {
      seen.push(error);
    },
  });
  control.begin();
  await book.fetch(total("cash"));
  control.finish();
  await settled();
  await book.fetch(total("cash"));
  await settled();
  expect(seen).toEqual([]);
  await book.close({ seal: false });
});

test("a check that the application carries to the one that replaces it is watched once, and its failure is reported once", async () => {
  const w = new World();
  const control = new Control();
  const seen: unknown[] = [];
  const slow = new SimPodClock(w.clock, { rate: 0.2 });
  const a = await w.open("pod-a#1", {
    ...checkedBy(control),
    pod: slow,
    lease: { ttlMs: 3000, renewEveryMs: 1e9, skewToleranceMs: 1e12 },
    unsound: (error) => {
      seen.push(error);
    },
  });
  control.begin();
  expect((await a.fetch(add("cash", 10))).status).toBe(200);
  // Another pod writes after this one's lease has lapsed; this one catches up and builds its application again, which has the same check.
  await w.sleep(4000);
  const b = await BookRuntime.open(w.runtimeOptions("pod-b#1", "b.sqlite"));
  await b.write((db) => {
    db.exec(SCHEMA);
    db.run("INSERT INTO kv (k, v) VALUES ('cash', 15) ON CONFLICT(k) DO UPDATE SET v = 15");
  });
  await b.close({ seal: false });
  expect((await a.fetch(add("cash", 1))).status).toBe(200);
  expect(a.resets).toBeGreaterThanOrEqual(1);
  control.fail(new Error("the ledger does not replay"));
  await settled();
  expect(seen).toHaveLength(1);
  await a.close();
});

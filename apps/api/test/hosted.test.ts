import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadOrCreateOwnerKey } from "@rastrata/application/agent/local";
import { LocalBookService } from "@rastrata/application/local";
import { APPLICATION_API_VERSION } from "@rastrata/application/schema";
import {
  BookKeys,
  FileObjectStore,
  adoptFromBulk,
  parseEntry,
  type LogTier,
} from "@rastrata/booklog";
import { MemoryLogTier } from "@rastrata/booklog/testing";
import { importIntoLog } from "../src/hosted-import.ts";
import {
  kindOf,
  openBulkStore,
  parseBookStore,
  startHostedApplicationServer,
  type BookStoreConfig,
} from "../src/hosted.ts";

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

/** A write carries a UUID; a test that sends one again needs the same one. */
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function folder(): string {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-hosted-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

interface Started {
  readonly base: string;
  readonly config: BookStoreConfig;
  readonly stop: () => Promise<void>;
  readonly evict: () => Promise<void>;
}

async function start(
  root: string,
  options: {
    readonly tail?: LogTier;
    /** The tail named in the settings (default: memory). */
    readonly tailKind?: string;
    readonly cache?: string;
    readonly control?: boolean;
    readonly ownerKey?: string;
  } = {},
): Promise<Started> {
  const config = parseBookStore("r2log://book-1", {
    RASTRATA_BOOK_BULK: pathToFileURL(join(root, "bucket")).href,
    RASTRATA_BOOK_TAIL: options.tailKind ?? "memory",
    RASTRATA_BOOK_CACHE: options.cache ?? join(root, "cache"),
  });
  const server = await startHostedApplicationServer({
    config,
    port: 0,
    telemetry: false,
    control: options.control ?? true,
    ...(options.ownerKey ? { ownerKey: options.ownerKey } : {}),
    ...(options.tail ? { stores: { tail: options.tail } } : {}),
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await server.stop();
  };
  cleanup.push(stop);
  return {
    base: `http://127.0.0.1:${server.server.port}`,
    config,
    stop,
    evict: server.evict,
  };
}

interface Reply {
  readonly status: number;
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are inspected loosely
  readonly body: any;
}

async function operation(
  base: string,
  name: string,
  input: unknown = {},
  options: { operationId?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const response = await fetch(`${base}/v1/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...options.headers },
    body: JSON.stringify({
      version: APPLICATION_API_VERSION,
      bookId: "local-book",
      input,
      ...(options.operationId ? { operationId: options.operationId } : {}),
    }),
  });
  return { status: response.status, body: await response.json() };
}
const control = async (base: string, path: string, body?: unknown): Promise<Reply> => {
  const response = await fetch(`${base}/control/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
};
/** The references of the drafts the book holds (the first page: the tests make few). */
const drafts = async (base: string): Promise<(string | undefined)[]> =>
  (
    ((await operation(base, "drafts.list")).body.data.drafts ?? []) as {
      data?: { reference?: string };
    }[]
  ).map((item) => item.data?.reference);

test("the settings come from the URL and the environment, and never repeat a secret", () => {
  const env = {
    RASTRATA_BOOK_BULK: "s3://127.0.0.1:9000/bucket/runs/x",
    RASTRATA_BOOK_TAIL: "postgres://user:SECRETPASSWORD@db/books",
    RASTRATA_BOOK_CACHE: "/tmp/cache",
  };
  const config = parseBookStore("r2log://Book.7", env);
  expect(config).toEqual({
    bookId: "Book.7",
    bulk: "s3://127.0.0.1:9000/bucket/runs/x",
    tail: "postgres://user:SECRETPASSWORD@db/books",
    cache: "/tmp/cache",
    // The bucket's own path is the book's key prefix.
    prefix: "runs/x/",
    snapshotEvery: 0,
  });
  // The URL wins over the environment, and a prefix is made to end in a slash.
  const named = parseBookStore("r2log://b2?bulk=memory&tail=objects&prefix=a/b&cache=/c", env);
  expect(named).toMatchObject({ bulk: "memory", tail: "objects", prefix: "a/b/", cache: "/c" });
  expect(
    parseBookStore("r2log://b3?bulk=memory&tail=memory&snapshotEvery=500", {}).snapshotEvery,
  ).toBe(500);
  expect(() => parseBookStore("r2log://b3?bulk=memory&tail=memory&snapshotEvery=-1", {})).toThrow();
  expect(() => parseBookStore("r2log://b3?bulk=memory&tail=memory&snapshotEvery=x", {})).toThrow();
  expect(kindOf(config.tail)).toBe("postgres");
  expect(kindOf(config.bulk)).toBe("s3");
  for (const bad of [
    "http://book",
    "r2log://",
    "r2log://-bad",
    "not a url",
    "r2log://b?tail=memory",
    "r2log://b?bulk=memory",
    "r2log://b?bulk=memory&tail=memory&prefix=../x",
  ])
    expect(() => parseBookStore(bad, {})).toThrow();
  try {
    parseBookStore("r2log://b?bulk=memory&prefix=//", {
      RASTRATA_BOOK_TAIL: "postgres://user:SECRETPASSWORD@db/books",
    });
  } catch (error) {
    expect(String(error)).not.toContain("SECRETPASSWORD");
  }
  expect(() => openBulkStore({ ...config, bulk: "s3://127.0.0.1:9000/bucket" }, {})).toThrow(
    "RASTRATA_BOOK_S3_KEY_ID",
  );
  expect(() => openBulkStore({ ...config, bulk: "ftp://nowhere" }, {})).toThrow();
});

test("a book served from the log: setup and a draft are answered after they are on record, and a new process reads them back", async () => {
  const root = folder();
  const tail = new MemoryLogTier();
  const first = await start(root, { tail });
  expect((await (await fetch(`${first.base}/health`)).json()).hosted).toEqual({
    book: "book-1",
    open: false,
    role: "idle",
    bulk: "file",
    tail: "memory",
    backups: false,
  });
  const setup = await operation(first.base, "book.setup", BOOK, { operationId: id(1) });
  expect(setup.status).toBe(200);
  const created = await operation(first.base, "drafts.create", draft("one"), {
    operationId: id(2),
  });
  expect(created.status).toBe(200);
  // The answer was released only after its entry was in the tail.
  expect(tail.peek("book-1").entries.length).toBeGreaterThanOrEqual(2);
  expect((await control(first.base, "status")).body).toMatchObject({
    hosted: true,
    book: "book-1",
    tail: "memory",
    bulk: "file",
    open: true,
  });
  // The browser's older routes reach the same book.
  expect((await (await fetch(`${first.base}/api/book`)).json()).setup.name).toBe("Hosted Co");
  await first.stop();
  // A process with a cache of its own (nothing on this disk) reads the book from the log.
  const second = await start(root, { tail, cache: join(root, "other-cache") });
  expect(await drafts(second.base)).toEqual(["one"]);
  // And the same write sent again under its identity is the same answer, not a second draft.
  const again = await operation(second.base, "drafts.create", draft("one"), {
    operationId: id(2),
  });
  expect(again.body).toEqual(created.body);
  expect(await drafts(second.base)).toHaveLength(1);
});

test("an eviction drops the book and its cache file, and the next request reads it back from the log", async () => {
  const root = folder();
  const served = await start(root);
  await operation(served.base, "book.setup", BOOK, { operationId: id(1) });
  await operation(served.base, "drafts.create", draft("kept"), { operationId: id(2) });
  const cache = join(served.config.cache, "book-1.sqlite");
  expect(existsSync(cache)).toBe(true);
  const evicted = await control(served.base, "evict", { tenant: "t-1" });
  expect(evicted.body.evicted).toBe(true);
  expect(existsSync(cache)).toBe(false);
  expect((await control(served.base, "status")).body.open).toBe(false);
  // Cold: the book comes back from the bulk store and the log, with its cache file made again.
  expect(await drafts(served.base)).toEqual(["kept"]);
  expect(existsSync(cache)).toBe(true);
  expect((await control(served.base, "status")).body.open).toBe(true);
  // Requests that arrive while an eviction is running wait for it and are served from the new book.
  const [one, two, three] = await Promise.all([
    control(served.base, "evict", {}),
    operation(served.base, "accounts.list"),
    operation(served.base, "drafts.list"),
  ]);
  expect(one.status).toBe(200);
  expect(two.status).toBe(200);
  expect(three.status).toBe(200);
});

test("with the tail failing a write is refused and never half done, and sent again it is done once", async () => {
  const root = folder();
  const served = await start(root);
  await operation(served.base, "book.setup", BOOK, { operationId: id(1) });
  expect((await control(served.base, "fault", { kind: "tail", seconds: 30 })).body.kind).toBe(
    "tail",
  );
  expect((await control(served.base, "status")).body.faults.tail).toBeGreaterThan(0);
  const refused = await operation(served.base, "drafts.create", draft("late"), {
    operationId: id(3),
  });
  expect(refused.status).toBe(503);
  expect(refused.body.ok).toBe(false);
  expect(refused.body.error.retryable).toBe(true);
  expect(["commit_uncertain", "tail_unavailable"]).toContain(refused.body.error.code);
  await control(served.base, "fault", { kind: "clear" });
  expect((await control(served.base, "status")).body.faults).toEqual({ tail: 0, r2: 0 });
  const retried = await operation(served.base, "drafts.create", draft("late"), {
    operationId: id(3),
  });
  expect(retried.status).toBe(200);
  expect(await drafts(served.base)).toEqual(["late"]);
  // The tail panel: nothing that is due waits for a seal beyond the window.
  const tailStatus = (await control(served.base, "tail")).body;
  expect(tailStatus.depth).toBeGreaterThanOrEqual(0);
  expect(tailStatus.seq).toBeGreaterThanOrEqual(2);
});

test("the bulk store failing is a fault of its own, and a pause answers first and then stops the process", async () => {
  const root = folder();
  const served = await start(root);
  await operation(served.base, "book.setup", BOOK, { operationId: id(1) });
  expect((await control(served.base, "fault", { kind: "r2", seconds: 5 })).status).toBe(200);
  expect((await control(served.base, "status")).body.faults.r2).toBeGreaterThan(0);
  // Commits go on: the tail takes them, sealing waits for the store.
  expect(
    (await operation(served.base, "drafts.create", draft("a"), { operationId: id(4) })).status,
  ).toBe(200);
  await control(served.base, "fault", { kind: "clear" });
  const paused = await control(served.base, "fault", { kind: "pause", seconds: 0.05 });
  expect(paused.body).toEqual({ kind: "pause", seconds: 0.05 });
  expect((await control(served.base, "fault", { kind: "nonsense", seconds: 1 })).status).toBe(400);
  expect((await control(served.base, "fault", { kind: "tail", seconds: -1 })).status).toBe(400);
  expect(await drafts(served.base)).toEqual(["a"]);
});

test("the control routes are off unless asked for, and need the owner key when there is one", async () => {
  const root = folder();
  const plain = await start(root, { control: false });
  expect((await fetch(`${plain.base}/control/status`)).status).toBe(404);
  await plain.stop();

  const keyFile = join(folder(), "owner.key");
  const ownerKey = loadOrCreateOwnerKey(keyFile);
  const locked = await start(folder(), { ownerKey });
  expect((await fetch(`${locked.base}/control/status`)).status).toBe(401);
  expect(
    (
      await fetch(`${locked.base}/control/status`, {
        headers: { authorization: "Bearer rso_wrong" },
      })
    ).status,
  ).toBe(401);
  const open = await fetch(`${locked.base}/control/status`, {
    headers: { authorization: `Bearer ${ownerKey}` },
  });
  expect(open.status).toBe(200);
  // The book itself is locked too.
  expect((await operation(locked.base, "book.get")).status).toBe(401);
  expect(
    (
      await operation(
        locked.base,
        "book.get",
        {},
        { headers: { authorization: `Bearer ${ownerKey}` } },
      )
    ).status,
  ).not.toBe(401);
});

test("only this computer's names are answered, as for the local server", async () => {
  const root = folder();
  const served = await start(root);
  const port = new URL(served.base).port;
  const forged = await fetch(`${served.base}/health`, {
    headers: { host: `evil.example:${port}` },
  });
  expect(forged.status).toBe(421);
  expect(
    (await fetch(`${served.base}/health`, { headers: { origin: "https://example.com" } })).status,
  ).toBe(403);
  expect((await fetch(`${served.base}/nothing-here`)).status).toBe(404);
});

test("a book file imported into the log is served from it, and a book already there is refused", async () => {
  const root = folder();
  const file = join(folder(), "seed.sqlite");
  const seeded = await LocalBookService.open(file, { safety: false, snapshots: false });
  await seeded.setup(BOOK);
  seeded.close();
  const config = parseBookStore("r2log://imported-1", {
    RASTRATA_BOOK_BULK: pathToFileURL(join(root, "bucket")).href,
    RASTRATA_BOOK_TAIL: "objects",
    RASTRATA_BOOK_CACHE: join(root, "cache"),
  });
  const imported = await importIntoLog(config, file);
  expect(imported.seq).toBe(1);
  expect(imported.bytes).toBeGreaterThan(0);
  await expect(importIntoLog(config, file)).rejects.toThrow("already in the log");
  const server = await startHostedApplicationServer({ config, port: 0, telemetry: false });
  cleanup.push(() => server.stop());
  const base = `http://127.0.0.1:${server.server.port}`;
  const accounts = await operation(base, "accounts.list");
  expect(accounts.status).toBe(200);
  expect(accounts.body.data.accounts.map((account: { id: string }) => account.id)).toEqual([
    "1010",
    "3100",
    "6100",
  ]);
  // And it can be written to, with the entries after the imported one.
  expect(
    (await operation(base, "drafts.create", draft("after"), { operationId: id(5) })).status,
  ).toBe(200);
  expect(await drafts(base)).toEqual(["after"]);
});

test("evictions in the middle of traffic cost no request: every one is answered, by the old book or its replacement", async () => {
  const root = folder();
  const served = await start(root);
  await operation(served.base, "book.setup", BOOK, { operationId: id(1) });
  let stop = false;
  const statuses: number[] = [];
  const hammer = async () => {
    while (!stop) statuses.push((await operation(served.base, "accounts.list")).status);
  };
  const workers = Array.from({ length: 8 }, () => hammer());
  for (let round = 0; round < 25; round += 1) {
    expect((await control(served.base, "evict", {})).status).toBe(200);
    await Bun.sleep(5);
  }
  stop = true;
  await Promise.all(workers);
  expect(statuses.length).toBeGreaterThan(20);
  expect(statuses.filter((status) => status !== 200)).toEqual([]);
});

test("a tail that has lost the book is refused, not served as a new empty book", async () => {
  const root = folder();
  const file = join(folder(), "seed.sqlite");
  const seeded = await LocalBookService.open(file, { safety: false, snapshots: false });
  await seeded.setup(BOOK);
  seeded.close();
  const settings = {
    RASTRATA_BOOK_BULK: pathToFileURL(join(root, "bucket")).href,
    RASTRATA_BOOK_CACHE: join(root, "cache"),
  };
  await importIntoLog(
    parseBookStore("r2log://lost-1", { ...settings, RASTRATA_BOOK_TAIL: "objects" }),
    file,
  );
  // The same bucket in front of a tail that knows nothing of the book.
  const server = await startHostedApplicationServer({
    config: parseBookStore("r2log://lost-1", { ...settings, RASTRATA_BOOK_TAIL: "memory" }),
    port: 0,
    telemetry: false,
  });
  cleanup.push(() => server.stop());
  const answer = await operation(`http://127.0.0.1:${server.server.port}`, "accounts.list");
  expect(answer.status).toBe(503);
  expect(answer.body.error).toMatchObject({ code: "tail_behind", retryable: false });
  // Nothing was made in the bucket by asking.
  expect(existsSync(join(root, "bucket", "books", "lost-1", "sealed"))).toBe(false);
});

/** Look again every 20 ms until `check` is true, for at most `ms`. */
async function until(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  for (let waited = 0; waited < ms; waited += 20) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error("It did not come about in time");
}

test("a standby follows the book without serving it, and takes it over when the holder hands it over: writes are refused first, then the book is given up", async () => {
  const root = folder();
  const tail = new MemoryLogTier();
  const holder = await start(root, { tail, cache: join(root, "cache-holder") });
  await operation(holder.base, "book.setup", BOOK, { operationId: id(1) });
  await operation(holder.base, "drafts.create", draft("one"), { operationId: id(2) });

  // The standby: the same stores, a cache of its own.
  const standby = await startHostedApplicationServer({
    config: parseBookStore("r2log://book-1", {
      RASTRATA_BOOK_BULK: pathToFileURL(join(root, "bucket")).href,
      RASTRATA_BOOK_TAIL: "memory",
      RASTRATA_BOOK_CACHE: join(root, "cache-standby"),
    }),
    port: 0,
    telemetry: false,
    control: true,
    standby: true,
    followMs: 30,
    stores: { tail },
  });
  cleanup.push(() => standby.stop());
  const other = `http://127.0.0.1:${standby.server.port}`;
  await until(async () => (await control(other, "status")).body.following?.warmed === true);
  expect((await control(other, "status")).body.role).toBe("standby");
  // It serves nothing, and says why.
  const waiting = await operation(other, "accounts.list");
  expect(waiting.status).toBe(503);
  expect(waiting.body.error).toMatchObject({ code: "book_standby", retryable: true });
  // The holder writes; the standby follows it to the end.
  await operation(holder.base, "drafts.create", draft("two"), { operationId: id(3) });
  const head = (await control(holder.base, "tail")).body.seq;
  await until(async () => (await control(other, "status")).body.following?.seq === head);

  // The first half of a handover: writes are refused, reads go on.
  expect((await control(holder.base, "drain", {})).body).toEqual({ drained: true });
  const refused = await operation(holder.base, "drafts.create", draft("three"), {
    operationId: id(4),
  });
  expect(refused.status).toBe(503);
  expect(refused.body.error).toMatchObject({ code: "book_draining", retryable: true });
  expect((await operation(holder.base, "accounts.list")).status).toBe(200);
  expect((await control(holder.base, "status")).body.role).toBe("draining");

  // The second half: the holder gives the book up, and the standby takes it.
  expect((await control(holder.base, "release", {})).body.released).toBe(true);
  expect((await control(holder.base, "status")).body.role).toBe("released");
  await until(async () => (await control(other, "status")).body.role === "active");
  // The write that was refused is accepted by the new holder, under the same identity, once.
  const accepted = await operation(other, "drafts.create", draft("three"), { operationId: id(4) });
  expect(accepted.status).toBe(200);
  expect((await drafts(other)).sort()).toEqual(["one", "three", "two"]);
  // And the one that gave the book up serves nothing more.
  expect((await operation(holder.base, "accounts.list")).body.error.code).toBe("book_standby");
  expect((await control(other, "status")).body.lease.fence).toBeGreaterThan(1);
});

test("a tail that lost the book is restored from the bulk store, and the same server then serves the book and goes on", async () => {
  const root = folder();
  const tail = new MemoryLogTier();
  const first = await start(root, { tail });
  await operation(first.base, "book.setup", BOOK, { operationId: id(1) });
  await operation(first.base, "drafts.create", draft("kept"), { operationId: id(2) });
  // Stopping seals what the tail holds into the bulk store.
  await first.stop();

  const wiped = new MemoryLogTier();
  const second = await start(root, { tail: wiped, cache: join(root, "other-cache") });
  expect((await operation(second.base, "accounts.list")).body.error.code).toBe("tail_behind");

  const outcome = await adoptFromBulk({
    tier: wiped,
    bulk: new FileObjectStore(join(root, "bucket")),
    keys: new BookKeys("", "book-1"),
  });
  expect(outcome.seq).toBeGreaterThanOrEqual(2);
  // Nothing is restarted: the next request opens the book on the restored tail.
  expect((await operation(second.base, "accounts.list")).status).toBe(200);
  expect(await drafts(second.base)).toEqual(["kept"]);
  expect(
    (await operation(second.base, "drafts.create", draft("after"), { operationId: id(3) })).status,
  ).toBe(200);
  expect((await drafts(second.base)).sort()).toEqual(["after", "kept"]);
});

test("a Post is one commit to the tail with journal.post where a draft, a preparation and a commit are three", async () => {
  const root = folder();
  const tail = new MemoryLogTier();
  const served = await start(root, { tail });
  await operation(served.base, "book.setup", BOOK, { operationId: id(1) });
  // What the tail has taken: every append the server made.
  const appended = async (): Promise<number> =>
    (await control(served.base, "status")).body.tail_calls.append;

  // The old way: three requests, three entries.
  const before = await appended();
  const saved = await operation(served.base, "drafts.create", draft("three requests"), {
    operationId: id(2),
  });
  const prepared = await operation(
    served.base,
    "journal.prepare",
    { draftId: saved.body.data.id, expectedVersion: saved.body.data.version },
    { operationId: id(3) },
  );
  const committed = await operation(
    served.base,
    "operations.commit",
    { planId: prepared.body.data.planId, planHash: prepared.body.data.planHash },
    { operationId: prepared.body.data.planId },
  );
  expect(committed.body.data.disposition).toBe("committed");
  expect((await appended()) - before).toBe(3);

  // The new way: one request, one entry.
  const middle = await appended();
  const entries = tail.peek("book-1").entries.length;
  const posted = await operation(served.base, "journal.post", draft("one request"), {
    operationId: id(4),
  });
  expect(posted.status).toBe(200);
  expect(posted.body.data.receipt.disposition).toBe("committed");
  expect(posted.body.data.plan.valid).toBe(true);
  expect((await appended()) - middle).toBe(1);
  expect(tail.peek("book-1").entries.length - entries).toBe(1);
  // The entry is the request's: it carries the identity the client sent.
  const read = await tail.readFrom("book-1", entries + 1);
  const header = parseEntry(read.entries[0]?.body as Uint8Array).header;
  expect(header.opId).toBe(id(4));
  // Sent again, the same answer and nothing more for the tail to take.
  const again = await operation(served.base, "journal.post", draft("one request"), {
    operationId: id(4),
  });
  expect(again.body.data).toEqual(posted.body.data);
  expect((await appended()) - middle).toBe(1);
  // Both books are whole: two entries posted, one draft each, none left open.
  const register = await operation(served.base, "journal.list", { status: "Posted" });
  expect(register.body.data.count).toBe(2);
  expect(await drafts(served.base)).toEqual([]);
  // A Post dated after the calendar's end grows the calendar inside the same request: still one entry.
  const later = await operation(
    served.base,
    "journal.post",
    { data: { ...draft("far away").data, date: "2031-01-02" } },
    { operationId: id(5) },
  );
  expect(later.body.data.receipt.disposition).toBe("committed");
  expect((await appended()) - middle).toBe(2);
  expect((await operation(served.base, "periods.list", {})).body.data.calendar.lastDate).toBe(
    "2031-12-31",
  );
  // A Post the books refuse after the draft is kept is still one entry (the draft, and the request's answer).
  const refused = await operation(
    served.base,
    "journal.post",
    { data: { ...draft("too early").data, date: "2025-12-31" } },
    { operationId: id(6) },
  );
  expect(refused.body.data.refusal.code).toBe("calendar_not_configured");
  expect((await appended()) - middle).toBe(3);
  expect(await drafts(served.base)).toEqual(["too early"]);
});

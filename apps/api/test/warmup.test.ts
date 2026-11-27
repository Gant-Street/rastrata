import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBookService } from "@rastrata/application/local";
import { APPLICATION_API_VERSION } from "@rastrata/application/schema";
import { BULK_BOOK, postBulk } from "@rastrata/application/testing/bulk-book";
import { setupLegacyBook } from "@rastrata/application/testing/legacy-book";
import type { Logger } from "../src/log.ts";
import { startLocalApplicationServer } from "../src/server.ts";
import { secondsLeft, Warmup, type Readable } from "../src/warmup.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

const KEY = "rso_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";

// ---- the estimate ----------------------------------------------------------------------------

test("a book made without the chain-head commitment follows the integrator's measurements until this computer has been timed, then this computer", () => {
  const legacy = { growth: "quadratic" } as const;
  // Replaying from the first entry: 22 seconds at a thousand entries and about 90 at two thousand.
  expect(secondsLeft({ ...legacy, from: 0, done: 0, total: 1000, elapsedSeconds: 0 })).toBeCloseTo(
    22,
    5,
  );
  expect(secondsLeft({ ...legacy, from: 0, done: 0, total: 2000, elapsedSeconds: 0 })).toBeCloseTo(
    88,
    5,
  );
  // From a snapshot at 900, only the 100 entries since it are read, and they are the dear ones.
  expect(
    secondsLeft({ ...legacy, from: 900, done: 900, total: 1000, elapsedSeconds: 0 }),
  ).toBeCloseTo(4.18, 2);
  // Two pages in, or less than a quarter of a second: too early to say how fast this computer is.
  expect(secondsLeft({ ...legacy, from: 0, done: 16, total: 1000, elapsedSeconds: 3 })).toBeCloseTo(
    22 * (1 - (16 * 16) / 1_000_000),
    5,
  );
  expect(
    secondsLeft({ ...legacy, from: 0, done: 500, total: 1000, elapsedSeconds: 0.1 }),
  ).toBeCloseTo(16.5, 5);
  // Halfway through (a quarter of the work) at the measured speed: three quarters of it is left.
  expect(
    secondsLeft({ ...legacy, from: 0, done: 500, total: 1000, elapsedSeconds: 5.5 }),
  ).toBeCloseTo(16.5, 5);
  // A computer three times slower than the measurements says so, and the estimate follows it.
  expect(
    secondsLeft({ ...legacy, from: 0, done: 500, total: 1000, elapsedSeconds: 16.5 }),
  ).toBeCloseTo(49.5, 5);
  // The same from a snapshot: only the work since it counts, on both sides.
  expect(
    secondsLeft({ ...legacy, from: 800, done: 900, total: 1000, elapsedSeconds: 8 }),
  ).toBeCloseTo((8 * 95_000) / 85_000, 5);
  // Nothing left, or a book that shrank under it: nothing, not a negative.
  expect(secondsLeft({ ...legacy, from: 0, done: 1000, total: 1000, elapsedSeconds: 22 })).toBe(0);
  expect(secondsLeft({ ...legacy, from: 0, done: 1200, total: 1000, elapsedSeconds: 22 })).toBe(0);
});

test("a book made with the chain-head commitment is estimated by the entry, not by the square of them", () => {
  const book = { growth: "linear" } as const;
  // Replaying from the first entry: a millisecond an entry whatever the size, where the other kind of
  // book takes 22 seconds at a thousand and 550 at five thousand.
  expect(secondsLeft({ ...book, from: 0, done: 0, total: 1000, elapsedSeconds: 0 })).toBeCloseTo(
    1,
    5,
  );
  expect(secondsLeft({ ...book, from: 0, done: 0, total: 5000, elapsedSeconds: 0 })).toBeCloseTo(
    5,
    5,
  );
  expect(secondsLeft({ ...book, from: 0, done: 0, total: 20_000, elapsedSeconds: 0 })).toBeCloseTo(
    20,
    5,
  );
  // From a snapshot at 1,500 of 20,000 entries, only the entries since it are read.
  expect(
    secondsLeft({ ...book, from: 1500, done: 1500, total: 20_000, elapsedSeconds: 0 }),
  ).toBeCloseTo(18.5, 5);
  // Until this computer has been timed (a quarter of a second of reading, 32 entries), the rule of thumb.
  const first = { done: 16, elapsedSeconds: 0.5 };
  expect(
    secondsLeft({
      ...book,
      from: 0,
      done: 16,
      total: 5000,
      elapsedSeconds: 0.5,
      firstPage: first,
    }),
  ).toBeCloseTo(4.984, 5);
  expect(
    secondsLeft({
      ...book,
      from: 0,
      done: 300,
      total: 5000,
      elapsedSeconds: 0.6,
      firstPage: first,
    }),
  ).toBeCloseTo((5000 - 300) * 0.001, 5);
  // Then its pace: 500 entries in a second is 2 ms an entry, so the 4,484 that are left take 9 seconds.
  expect(
    secondsLeft({
      ...book,
      from: 0,
      done: 516,
      total: 5000,
      elapsedSeconds: 1.5,
      firstPage: first,
    }),
  ).toBeCloseTo(8.968, 5);
  // The time before the first page (the process starting, a saved snapshot being read) is not the
  // pace: a snapshot of 14 MB takes a third of a second, and counted as reading it would read a
  // millisecond an entry as nearly two.
  expect(
    secondsLeft({
      ...book,
      from: 1500,
      done: 2016,
      total: 20_000,
      elapsedSeconds: 0.9,
      firstPage: { done: 1516, elapsedSeconds: 0.4 },
    }),
  ).toBeCloseTo(17.984, 5);
  expect(
    secondsLeft({ ...book, from: 1500, done: 2016, total: 20_000, elapsedSeconds: 0.9 }),
  ).toBeCloseTo((0.9 * 17_984) / 516, 5);
  // Nothing left, or a book that shrank under it: nothing, not a negative.
  expect(secondsLeft({ ...book, from: 0, done: 1000, total: 1000, elapsedSeconds: 1 })).toBe(0);
  expect(secondsLeft({ ...book, from: 0, done: 1200, total: 1000, elapsedSeconds: 1 })).toBe(0);
});

// ---- the state machine, with a book that is only what the warm-up needs of one ----------------

function fakeBook(read: () => Promise<{ head: { sequence: string } }>, setup: unknown = {}) {
  const calls = { reads: 0 };
  const book: Readable = {
    setupState: () => setup,
    readAggregate: () => {
      calls.reads += 1;
      return read();
    },
  };
  return { book, calls };
}

function capturingLogger() {
  const lines: string[] = [];
  const logger: Logger = {
    info: (message) => lines.push(`info ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message, cause) => lines.push(`error ${message}: ${String(cause)}`),
  };
  return { logger, lines };
}

test("a warm-up says how far it has got while it reads, and how long it took when it is done", async () => {
  let clock = 1000;
  // A book made without the chain-head commitment, the kind whose replay grows with its square.
  const warmup = new Warmup({ now: () => clock, commitmentOf: () => "legacy" });
  let finish: (value: { head: { sequence: string } }) => void = () => {};
  const { book } = fakeBook(() => new Promise((resolve) => (finish = resolve)));
  warmup.start(book, "/nowhere/book.sqlite");
  expect(warmup.reading).toBe(true);
  // Nothing has been read yet, so nothing is claimed about how long it will take.
  expect(warmup.status()).toEqual({
    warming: true,
    warmup: { state: "reading", done: null, total: null, secondsLeft: null },
  });
  // The ledger reports a page: 160 of 1,000 entries, 3 seconds in.
  clock += 3000;
  warmup.observe({ through: "160", tip: "1000" });
  const midway = warmup.status();
  expect(midway.warming).toBe(true);
  expect(midway.warmup).toMatchObject({ state: "reading", done: 160, total: 1000 });
  // 3 s for the work of the first 160 entries (12,800 units): the rest, 487,200 units, takes 114 s.
  expect((midway.warmup as { secondsLeft: number }).secondsLeft).toBe(114);
  // The end of it.
  clock += 21_500;
  finish({ head: { sequence: "1000" } });
  await warmup.finished;
  expect(warmup.reading).toBe(false);
  expect(warmup.status()).toEqual({
    warming: false,
    warmup: { state: "ready", entries: 1000, seconds: 24.5 },
  });
  // A page reported later (an ordinary request reading on) changes nothing.
  warmup.observe({ through: "1000", tip: "1000" });
  expect(warmup.status().warmup).toMatchObject({ state: "ready", entries: 1000 });
});

test("a warm-up of a chain-head book counts down by the entry, and follows this computer's pace once it has one", async () => {
  let clock = 1000;
  const warmup = new Warmup({ now: () => clock, commitmentOf: () => "chain-head" });
  let finish: (value: { head: { sequence: string } }) => void = () => {};
  const { book } = fakeBook(() => new Promise((resolve) => (finish = resolve)));
  warmup.start(book, "/nowhere/book.sqlite");
  expect(warmup.status()).toEqual({
    warming: true,
    warmup: { state: "reading", done: null, total: null, secondsLeft: null },
  });
  const left = () => (warmup.status().warmup as { secondsLeft: number }).secondsLeft;
  // 0.4 s in (the process starting and a saved snapshot being read), the first page: 16 of 20,000
  // entries. A millisecond an entry is 20 seconds; the other kind of book would say 6,600.
  clock += 400;
  warmup.observe({ through: "16", tip: "20000" });
  expect(left()).toBe(20);
  // Half a second later 516 are read, a millisecond each: the estimate stands.
  clock += 500;
  warmup.observe({ through: "516", tip: "20000" });
  expect(left()).toBe(19);
  // The computer slows down: 1,500 entries in 3.5 seconds is 2.3 ms an entry. The estimate follows it
  // (and is not thrown by the 0.4 s before the first page).
  clock += 3000;
  warmup.observe({ through: "1516", tip: "20000" });
  expect(left()).toBe(43);
  // Done.
  clock += 40_000;
  finish({ head: { sequence: "20000" } });
  await warmup.finished;
  expect(warmup.status()).toEqual({
    warming: false,
    warmup: { state: "ready", entries: 20000, seconds: 43.9 },
  });
});

test("a warm-up of a book that does not exist yet reads nothing and is ready", async () => {
  const warmup = new Warmup();
  const { book, calls } = fakeBook(async () => ({ head: { sequence: "0" } }), null);
  warmup.start(book, "/nowhere/book.sqlite");
  await warmup.finished;
  expect(calls.reads).toBe(0);
  expect(warmup.reading).toBe(false);
  expect(warmup.status()).toEqual({
    warming: false,
    warmup: { state: "ready", entries: 0, seconds: 0 },
  });
  // Starting twice does not read twice.
  const second = fakeBook(async () => ({ head: { sequence: "3" } }));
  warmup.start(second.book, "/nowhere/book.sqlite");
  expect(second.calls.reads).toBe(0);
});

test("a read that fails is reported, in one line, and does not escape as a rejection", async () => {
  const { logger, lines } = capturingLogger();
  const warmup = new Warmup({ logger });
  const { book, calls } = fakeBook(async () => {
    throw new Error(`native_ledger_outcome_corrupt\u001b[31m\n${"x".repeat(500)}`);
  });
  warmup.start(book, "/nowhere/book.sqlite");
  await warmup.finished; // never rejects
  expect(calls.reads).toBe(1); // a failure that is not about timing is not retried
  const status = warmup.status();
  expect(status.warming).toBe(false);
  expect(status.warmup.state).toBe("failed");
  const error = (status.warmup as { error: string }).error;
  expect(error.startsWith("native_ledger_outcome_corrupt")).toBe(true);
  expect(error.length).toBeLessThanOrEqual(300);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is that none is left
  expect(error).not.toMatch(/[\u0000-\u001f]/);
  expect(lines.some((line) => line.startsWith("error The book could not be read"))).toBe(true);
});

test("a write that lands in the middle of the read makes it start again, a few times and no more", async () => {
  const retry = () => new Error("Book changed during read; retry");
  let attempts = 0;
  const lucky = new Warmup();
  lucky.start(
    fakeBook(async () => {
      attempts += 1;
      if (attempts < 3) throw retry();
      return { head: { sequence: "7" } };
    }).book,
    "/nowhere/book.sqlite",
  );
  await lucky.finished;
  expect(attempts).toBe(3);
  expect(lucky.status().warmup).toMatchObject({ state: "ready", entries: 7 });

  const unlucky = fakeBook(async () => {
    throw retry();
  });
  const warmup = new Warmup();
  warmup.start(unlucky.book, "/nowhere/book.sqlite");
  await warmup.finished;
  expect(unlucky.calls.reads).toBe(3);
  expect(warmup.status().warmup).toMatchObject({
    state: "failed",
    error: "Book changed during read; retry",
  });
});

test("an error that comes because the service is stopping is the shutdown's, not a failed book", async () => {
  const { logger, lines } = capturingLogger();
  const warmup = new Warmup({ logger });
  let fail: (error: Error) => void = () => {};
  const { book } = fakeBook(() => new Promise((_, reject) => (fail = reject)));
  warmup.start(book, "/nowhere/book.sqlite");
  warmup.stopping();
  fail(new Error("Cannot use a closed database"));
  await warmup.finished;
  expect(warmup.status().warmup.state).toBe("reading");
  expect(lines.some((line) => line.startsWith("error"))).toBe(false);
  expect(lines).toContain("info Stopped before the book was read");
});

// ---- a real book, built the way the volume tests build one --------------------------------------

const call = async (base: string, name: string, input: unknown = {}) =>
  fetch(`${base}/v1/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      version: APPLICATION_API_VERSION,
      bookId: "local-book",
      input,
    }),
  });

async function bookOf(
  journals: number,
  kind: "chain-head" | "legacy" = "chain-head",
): Promise<{ directory: string; path: string }> {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-api-warmup-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "book.sqlite");
  const seed = await LocalBookService.open(path, { safety: false });
  if (kind === "legacy") await setupLegacyBook(seed);
  else await seed.setup(BULK_BOOK);
  await postBulk(seed, journals);
  // Closed with no read after the posting: the book has no snapshot, so the next start replays it
  // from its first entry, which is the long read a restart at login has to do.
  seed.close();
  return { directory, path };
}

const healthOf = async (base: string) => (await fetch(`${base}/health`)).json();

/** What the warm-up says is left when a book of the kind in `path` is, say, 16 of 5,000 entries in. */
function secondsLeftOnTheFile(path: string): number {
  const warmup = new Warmup();
  const { book } = fakeBook(() => new Promise(() => {}));
  warmup.start(book, path);
  warmup.observe({ through: "16", tip: "5000" });
  warmup.stopping();
  return (warmup.status().warmup as { secondsLeft: number }).secondsLeft;
}

test("a chain-head book is never given the quadratic estimate: the warm-up reads the kind from the book's own file", async () => {
  const modern = await bookOf(30);
  const older = await bookOf(30, "legacy");
  // Five thousand entries at a millisecond each. Reading them the way a book made without the commitment
  // is read would say nine minutes, which on the founder's book on its first day is a false alarm.
  expect(secondsLeftOnTheFile(modern.path)).toBe(5);
  // The same position in a book that was made without the commitment is nine minutes away, and says so.
  expect(secondsLeftOnTheFile(older.path)).toBe(550);
  // A file that holds no book, or one that cannot be read, is estimated as the slower kind.
  expect(secondsLeftOnTheFile(join(modern.directory, "no-such-book.sqlite"))).toBe(550);
});

test("a restart reads the book once, in the background, and the first request waits for that read instead of making another", async () => {
  const { path } = await bookOf(150);
  const start = () =>
    startLocalApplicationServer({
      path,
      port: 0,
      ownerKey: KEY,
      warmUp: true,
      health: { service: "rastrata", version: "9.9.9" },
    });
  let runtime = await start();
  let base = `http://127.0.0.1:${runtime.server.port}`;
  try {
    // Listening, and reading: /health answers at once and says so.
    expect(await healthOf(base)).toMatchObject({
      ok: true,
      service: "rastrata",
      version: "9.9.9",
      warming: true,
      warmup: { state: "reading" },
    });
    // A request that needs the book arrives while it is being read: it waits for that read.
    const arrived = call(base, "accounts.list");
    await runtime.warmup?.finished;
    const answer = await arrived;
    expect(answer.status).toBe(200);
    expect((await answer.json()).ok).toBe(true);
    const { readStats } = runtime.service;
    // One replay from the first entry (the 150 journals and the book's setup), made by the warm-up.
    expect(readStats.full).toBe(1);
    expect(readStats.verified).toBe(151);
    // The request went on from what the warm-up had verified: it read, but it replayed nothing.
    expect(readStats.incremental).toBeGreaterThanOrEqual(1);
    // And so does every later one.
    expect((await call(base, "accounts.list")).status).toBe(200);
    expect(readStats.full).toBe(1);
    expect(readStats.verified).toBe(151);
    // /health says it is done, and how much it read.
    expect(await healthOf(base)).toMatchObject({
      warming: false,
      warmup: { state: "ready", entries: 151 },
    });
    // The read left a snapshot, which is what makes the next restart quick.
    expect(readStats.snapshotsWritten).toBeGreaterThanOrEqual(1);
  } finally {
    await runtime.stop();
  }
  runtime = await start();
  base = `http://127.0.0.1:${runtime.server.port}`;
  try {
    await runtime.warmup?.finished;
    const { readStats } = runtime.service;
    expect(readStats.full).toBe(0);
    expect(readStats.snapshot).toBe(1);
    expect(await healthOf(base)).toMatchObject({
      warming: false,
      warmup: { state: "ready", entries: 151 },
    });
  } finally {
    await runtime.stop();
  }
}, 120_000);

test("a service started without a warm-up reads nothing until it is asked, and says nothing of one", async () => {
  const { path } = await bookOf(20);
  const runtime = await startLocalApplicationServer({
    path,
    port: 0,
    ownerKey: KEY,
    health: { service: "rastrata", version: "9.9.9" },
  });
  const base = `http://127.0.0.1:${runtime.server.port}`;
  try {
    expect(await healthOf(base)).toEqual({ ok: true, service: "rastrata", version: "9.9.9" });
    expect(runtime.warmup).toBeNull();
    expect(runtime.service.readStats.full).toBe(0);
    expect((await call(base, "accounts.list")).status).toBe(200);
    expect(runtime.service.readStats.full).toBe(1);
  } finally {
    await runtime.stop();
  }
}, 120_000);

test("a book that cannot be read leaves the service up, and /health says so", async () => {
  const { path } = await bookOf(40);
  // Damage one entry of the ledger, as a bad disk or a hand edit would.
  const db = new Database(path);
  db.exec(
    "UPDATE ledger_native_outcomes SET body = substr(body, 1, length(body) - 5) WHERE sequence = 20",
  );
  db.close();
  const { logger, lines } = capturingLogger();
  const runtime = await startLocalApplicationServer({
    path,
    port: 0,
    ownerKey: KEY,
    warmUp: { logger },
    health: { service: "rastrata", version: "9.9.9" },
  });
  const base = `http://127.0.0.1:${runtime.server.port}`;
  try {
    await runtime.warmup?.finished;
    const health = await healthOf(base);
    expect(health).toMatchObject({
      ok: true,
      warming: false,
      warmup: { state: "failed", error: expect.stringContaining("native_ledger_outcome_corrupt") },
    });
    expect(lines.some((line) => line.startsWith("error The book could not be read"))).toBe(true);
    // Still up, and still answering what does not need the book read.
    const context = await call(base, "book.get");
    expect(context.status).toBe(200);
    // What does need it fails as an answer, not as a dropped connection or a dead process.
    const accounts = await call(base, "accounts.list");
    expect(accounts.status).toBeGreaterThanOrEqual(500);
    expect((await accounts.json()).ok).toBe(false);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  } finally {
    await runtime.stop();
  }
}, 120_000);

test("stopping the service while it is reading the book does not wait for the read", async () => {
  const { path } = await bookOf(300);
  const { logger, lines } = capturingLogger();
  const runtime = await startLocalApplicationServer({
    path,
    port: 0,
    ownerKey: KEY,
    warmUp: { logger },
    health: { service: "rastrata", version: "9.9.9" },
  });
  const base = `http://127.0.0.1:${runtime.server.port}`;
  // Wait until the read is under way, with a page behind it.
  const deadline = Date.now() + 20_000;
  for (;;) {
    const { warmup } = await healthOf(base);
    if (warmup.state === "reading" && warmup.done >= 32) break;
    if (Date.now() > deadline) throw new Error("the read did not start");
    await Bun.sleep(20);
  }
  // A request is waiting for the read, as the web app's would be.
  const waiting = call(base, "accounts.list").then(
    (response) => response.status,
    () => "dropped",
  );
  await runtime.stop();
  // The read did not run to the end (the book has 301 entries), and nobody called it a failure.
  expect(runtime.service.readStats.verified).toBeLessThan(301);
  await runtime.warmup?.finished;
  expect(lines.some((line) => line.startsWith("error"))).toBe(false);
  expect(lines).toContain("info Stopped before the book was read");
  // The waiting request was let go rather than held for the rest of the read.
  expect(["dropped", 500, 503]).toContain(await waiting);
}, 120_000);

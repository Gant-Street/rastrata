// The registry of the books a pod serves besides its home book, on its own: stand-in slots and a clock that is set, no server.
// See docs/reference/program/hosting/many-books.md.
import { expect, test } from "bun:test";
import { BookClosedError } from "@rastrata/booklog";
import {
  activationBytesFor,
  BookRegistry,
  BooksRefused,
  type BooksSettings,
  CROWDED_IDLE_MS,
  CROWDED_SHARE,
  defaultBooksSettings,
  type ServedSlot,
  TokenBucket,
  TYPICAL_BOOK_BYTES,
  warmBookBytes,
} from "../src/hosted-books.ts";

const MB = 2 ** 20;

class Slot implements ServedSlot {
  open = false;
  seq: number | null = null;
  /** The size of the cache file while open; the tests choose it. */
  fileBytes: number | null = null;
  measured = 0;
  get bytes(): number | null {
    this.measured += 1;
    return this.open ? this.fileBytes : null;
  }
  closed = 0;
  stopped = false;
  /** A close that waits for this. */
  hold: Promise<void> | null = null;
  constructor(
    readonly id: string,
    public journals = 100,
    /** The size of the cache file once the book is open. */
    readonly fileOnOpen: number | null = null,
  ) {}
  /** What a request does with the slot once the registry has let it through. */
  async current(): Promise<void> {
    this.open = true;
    this.seq = this.journals * 3;
    this.fileBytes = this.fileOnOpen;
  }
  async evict(): Promise<void> {
    if (this.hold) await this.hold;
    this.open = false;
    this.seq = null;
    this.fileBytes = null;
    this.closed += 1;
  }
  async stop(): Promise<void> {
    this.open = false;
    this.stopped = true;
  }
}

function world(
  overrides: Partial<BooksSettings> = {},
  journals: Record<string, number> = {},
  defaultJournals = 100,
  files: Record<string, number> = {},
) {
  let clock = 1_000_000;
  let rss = 200 * MB;
  const queue = { waiting: 0 };
  const slots = new Map<string, Slot>();
  const hints = new Map<string, () => number | undefined>();
  const settings = defaultBooksSettings(1280 * MB, { sweepMs: 0, ...overrides });
  const registry = new BookRegistry<Slot>({
    settings,
    make: (id, sizeHint) => {
      const slot = new Slot(id, journals[id] ?? defaultJournals, files[id] ?? null);
      slots.set(id, slot);
      hints.set(id, sizeHint);
      return slot;
    },
    now: () => clock,
    rss: () => rss,
    queued: () => queue.waiting,
  });
  /** A whole request: let through, opened, over. */
  const request = async (id: string, caller: "member" | "service" = "member") => {
    const lease = await registry.acquire(id, caller);
    await lease.slot.current();
    lease.release();
    return lease.slot;
  };
  return {
    registry,
    slots,
    hints,
    settings,
    request,
    queue,
    tick: (ms: number) => {
      clock += ms;
    },
    setRss: (bytes: number) => {
      rss = bytes;
    },
  };
}
const ids = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `book-${String(i).padStart(4, "0")}`);

test("a book is counted at a typical size while it opens, and at its own size once it is open", async () => {
  const w = world({}, { "book-big0": 5000 });
  const lease = await w.registry.acquire("book-aaaa");
  expect(w.registry.stats()).toMatchObject({
    counted: 1,
    expectedBytes: TYPICAL_BOOK_BYTES,
    open: 0,
  });
  await lease.slot.current();
  lease.release();
  expect(w.registry.stats()).toMatchObject({
    counted: 1,
    expectedBytes: warmBookBytes(300),
    open: 1,
  });
  await w.request("book-big0");
  expect(w.registry.stats().expectedBytes).toBe(warmBookBytes(300) + warmBookBytes(15000));
  expect(warmBookBytes(15000)).toBeGreaterThan(warmBookBytes(300) * 10);
});

test("requests for one book share its place, and a second book is a second place", async () => {
  const w = world();
  const [a, b] = await Promise.all([
    w.registry.acquire("book-aaaa"),
    w.registry.acquire("book-aaaa"),
  ]);
  expect(a.slot).toBe(b.slot);
  expect(w.slots.size).toBe(1);
  expect(w.registry.stats().counted).toBe(1);
  const c = await w.registry.acquire("book-bbbb");
  expect(c.slot).not.toBe(a.slot);
  expect(w.registry.stats().counted).toBe(2);
  for (const lease of [a, b, c]) lease.release();
});

test("a lease is released once, and a second release changes nothing", async () => {
  const w = world({ inflight: 2 });
  const first = await w.registry.acquire("book-aaaa");
  await first.slot.current();
  const second = await w.registry.acquire("book-aaaa");
  first.release();
  first.release();
  first.release();
  // One request is still in flight, so there is room for one more and not for two.
  const third = await w.registry.acquire("book-aaaa");
  await expect(w.registry.acquire("book-aaaa")).rejects.toBeInstanceOf(BooksRefused);
  second.release();
  third.release();
});

test("a book allows only so many requests at once, and says 429 with a wait", async () => {
  const w = world({ inflight: 3, rate: 1000, burst: 1000 });
  const held = [];
  for (let i = 0; i < 3; i += 1) held.push(await w.registry.acquire("book-aaaa"));
  const error = await w.registry.acquire("book-aaaa").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(BooksRefused);
  expect((error as BooksRefused).failure).toMatchObject({
    code: "rate_limited",
    status: 429,
    retryable: true,
    retryAfterSeconds: 1,
  });
  expect(w.registry.stats().refused.rate).toBe(1);
  // Another book is not affected.
  const other = await w.registry.acquire("book-bbbb");
  other.release();
  for (const lease of held) lease.release();
  // Released, the book takes requests again.
  (await w.registry.acquire("book-aaaa")).release();
});

test("a book allows only so many requests a second, with a burst, and the wait says when", async () => {
  const w = world({ rate: 2, burst: 4, inflight: 100 });
  for (let i = 0; i < 4; i += 1) (await w.registry.acquire("book-aaaa")).release();
  const error = (await w.registry.acquire("book-aaaa").catch((e: unknown) => e)) as BooksRefused;
  expect(error.failure.status).toBe(429);
  expect(error.failure.retryAfterSeconds).toBe(1);
  w.tick(500);
  (await w.registry.acquire("book-aaaa")).release();
  const again = (await w.registry.acquire("book-aaaa").catch((e: unknown) => e)) as BooksRefused;
  expect(again).toBeInstanceOf(BooksRefused);
  w.tick(2000);
  for (let i = 0; i < 4; i += 1) (await w.registry.acquire("book-aaaa")).release();
});

test("a book refused for its rate costs the pod nothing: no place is kept for it", async () => {
  const w = world({ rate: 1, burst: 1, idleMs: 60_000 });
  (await w.registry.acquire("book-aaaa")).release();
  // The first request never opened the book, so no place is kept for it.
  expect(w.registry.stats()).toMatchObject({ counted: 0, expectedBytes: 0, open: 0 });
  await w.request("book-bbbb");
  w.tick(2000);
  await w.request("book-bbbb");
  const before = w.registry.stats();
  await expect(w.registry.acquire("book-bbbb")).rejects.toBeInstanceOf(BooksRefused);
  expect(w.registry.stats().counted).toBe(before.counted);
  // A run of books that were let through and never opened keeps no place, and the sweep forgets them when they are idle.
  for (const id of ids(50)) (await w.registry.acquire(id)).release();
  expect(w.registry.stats()).toMatchObject({ counted: 1, open: 1 });
  expect(w.registry.stats().tracked).toBe(52);
  w.tick(61_000);
  await w.registry.sweep();
  expect(w.registry.stats()).toMatchObject({ counted: 0, open: 0, tracked: 0 });
});

test("a book that keeps failing to open does not get a fresh allowance with every request", async () => {
  const w = world({ rate: 1, burst: 3, inflight: 100 });
  for (let i = 0; i < 3; i += 1) (await w.registry.acquire("book-aaaa")).release();
  // The slot never opened, as when the tail is down: the allowance went on being spent.
  await expect(w.registry.acquire("book-aaaa")).rejects.toBeInstanceOf(BooksRefused);
  expect(w.registry.stats().counted).toBe(0);
});

test("the control plane's key has a bucket of its own, shared by every book it names", async () => {
  const w = world({ rate: 1, burst: 1, serviceRate: 1, serviceBurst: 3, inflight: 100 });
  for (const id of ["book-aaaa", "book-bbbb", "book-cccc"])
    (await w.registry.acquire(id, "service")).release();
  await expect(w.registry.acquire("book-dddd", "service")).rejects.toBeInstanceOf(BooksRefused);
  // A member's bucket is the book's, and the service's use of the book did not take from it.
  (await w.registry.acquire("book-aaaa")).release();
});

test("when the pod is full the least recently used book with nothing in flight is closed", async () => {
  const w = world({ maxBooks: 3 });
  const [a, b, c] = [
    await w.request("book-aaaa"),
    await w.request("book-bbbb"),
    await w.request("book-cccc"),
  ] as [Slot, Slot, Slot];
  w.tick(1000);
  // a is used again, so b is the oldest.
  await w.request("book-aaaa");
  w.tick(1000);
  await w.request("book-dddd");
  expect(b.open).toBe(false);
  expect(b.closed).toBe(1);
  expect(a.open && c.open).toBe(true);
  expect(w.registry.stats()).toMatchObject({ counted: 3, open: 3, closed: { room: 1 } });
});

test("a book with a request in flight is never the one closed, and a pod with none to close says it is busy and opens nothing", async () => {
  const w = world({ maxBooks: 2 });
  const a = await w.registry.acquire("book-aaaa");
  await a.slot.current();
  const b = await w.registry.acquire("book-bbbb");
  await b.slot.current();
  const error = (await w.registry.acquire("book-cccc").catch((e: unknown) => e)) as BooksRefused;
  expect(error).toBeInstanceOf(BooksRefused);
  expect(error.failure).toMatchObject({ code: "server_busy", status: 503, retryable: true });
  expect(w.slots.get("book-cccc")?.open ?? false).toBe(false);
  expect(w.registry.stats()).toMatchObject({ counted: 2, refused: { busy: 1 } });
  // One of the two finishes, and the third now has a place.
  a.release();
  w.tick(10);
  const c = await w.registry.acquire("book-cccc");
  await c.slot.current();
  expect(a.slot.open).toBe(false);
  expect(b.slot.open).toBe(true);
  b.release();
  c.release();
});

test("the memory budget is what the books are expected to take, and it is kept", async () => {
  // Room for two books of a thousand journals and not three.
  const budget = TYPICAL_BOOK_BYTES * 2 + MB;
  const w = world({ warmBudgetBytes: budget }, {}, 1000);
  await w.request("book-aaaa");
  w.tick(10);
  await w.request("book-bbbb");
  w.tick(10);
  expect(w.registry.stats().expectedBytes).toBeLessThanOrEqual(budget);
  await w.request("book-cccc");
  expect(w.registry.stats().expectedBytes).toBeLessThanOrEqual(budget);
  expect(w.slots.get("book-aaaa")?.open).toBe(false);
  expect(w.registry.stats().closed.room).toBeGreaterThanOrEqual(1);
});

test("a book that is bigger than its place was counted for makes the pod close others once it is open", async () => {
  const w = world({ warmBudgetBytes: TYPICAL_BOOK_BYTES * 3 }, { "book-huge": 30_000 });
  await w.request("book-aaaa");
  w.tick(10);
  await w.request("book-bbbb");
  w.tick(10);
  await w.request("book-huge");
  // Closing the others after the fact is a task of its own; let it run.
  await new Promise((done) => setTimeout(done, 5));
  expect(w.slots.get("book-huge")?.open).toBe(true);
  expect(w.slots.get("book-aaaa")?.open).toBe(false);
  expect(w.slots.get("book-bbbb")?.open).toBe(false);
  expect(w.registry.stats().expectedBytes).toBe(warmBookBytes(90_000));
});

test("books idle for the idle time are closed by the sweep, and only those", async () => {
  const w = world({ idleMs: 60_000 });
  await w.request("book-aaaa");
  w.tick(30_000);
  await w.request("book-bbbb");
  w.tick(40_000);
  // a was last used 70 s ago, b 40 s ago.
  expect(await w.registry.sweep()).toBe(1);
  expect(w.slots.get("book-aaaa")?.open).toBe(false);
  expect(w.slots.get("book-bbbb")?.open).toBe(true);
  expect(w.registry.stats()).toMatchObject({ counted: 1, closed: { idle: 1 } });
  w.tick(30_000);
  expect(await w.registry.sweep()).toBe(1);
  expect(w.registry.stats()).toMatchObject({ counted: 0, expectedBytes: 0, open: 0 });
});

test("by default a book is kept for hours while the pod has room, and goes after ten minutes once the books held pass three quarters of the budget", async () => {
  // A person who comes back after a coffee, or in the afternoon, finds the book open: it is not read again from its log, which takes a second for every thousand journals.
  expect(defaultBooksSettings().idleMs).toBeGreaterThanOrEqual(4 * 3_600_000);
  // A book of 50,000 journals is a pod's worth: about 600 of the 766 MB the budget of this pod comes to.
  const w = world({}, { "book-bbbb": 50_000 }, 100);
  await w.request("book-aaaa");
  w.tick(5 * 3_600_000);
  expect(await w.registry.sweep()).toBe(0);
  expect(w.slots.get("book-aaaa")?.open).toBe(true);
  // Crowded, the same book that nobody has used for eleven minutes is closed, as every book was before the wait was lengthened.
  await w.request("book-bbbb");
  expect(w.registry.stats().expectedBytes).toBeGreaterThan(
    w.settings.warmBudgetBytes * CROWDED_SHARE,
  );
  w.tick(CROWDED_IDLE_MS + 60_000);
  await w.request("book-bbbb");
  expect(await w.registry.sweep()).toBe(1);
  expect(w.slots.get("book-aaaa")?.open).toBe(false);
  expect(w.slots.get("book-bbbb")?.open).toBe(true);
});

test("a book in use is not idle, however long since it was opened", async () => {
  const w = world({ idleMs: 60_000 });
  const lease = await w.registry.acquire("book-aaaa");
  await lease.slot.current();
  w.tick(10 * 60_000);
  expect(await w.registry.sweep()).toBe(0);
  lease.release();
  expect(await w.registry.sweep()).toBe(0);
  w.tick(60_000);
  expect(await w.registry.sweep()).toBe(1);
});

test("a pod short of memory opens no book and closes idle ones sooner", async () => {
  const w = world({ idleMs: 600_000, pressureIdleMs: 30_000 });
  await w.request("book-aaaa");
  w.tick(45_000);
  await w.request("book-bbbb");
  w.setRss(w.settings.residentLimitBytes + MB);
  const error = (await w.registry.acquire("book-cccc").catch((e: unknown) => e)) as BooksRefused;
  expect(error).toBeInstanceOf(BooksRefused);
  expect(error.failure.code).toBe("server_busy");
  // The books that are open go on serving.
  (await w.registry.acquire("book-bbbb")).release();
  expect(await w.registry.sweep()).toBe(1);
  expect(w.slots.get("book-aaaa")?.open).toBe(false);
  expect(w.registry.stats().closed.pressure).toBe(1);
  w.setRss(200 * MB);
  await w.request("book-cccc");
});

test("with the queue for cold loads full no book is opened, and the answer is busy", async () => {
  const w = world({ loadQueue: 4 });
  w.queue.waiting = 4;
  await expect(w.registry.acquire("book-aaaa")).rejects.toBeInstanceOf(BooksRefused);
  w.queue.waiting = 3;
  await w.request("book-aaaa");
  // A book that is open does not wait for a load.
  w.queue.waiting = 99;
  (await w.registry.acquire("book-aaaa")).release();
});

test("a book that could not be opened leaves nothing counted and nothing kept", async () => {
  const w = world();
  const lease = await w.registry.acquire("book-aaaa");
  // The request failed before the slot opened.
  lease.release();
  expect(w.registry.stats()).toMatchObject({ counted: 0, expectedBytes: 0, open: 0 });
  // With two requests waiting for the same open, the book is forgotten when the last one is over.
  const [one, two] = [await w.registry.acquire("book-bbbb"), await w.registry.acquire("book-bbbb")];
  one.release();
  expect(w.registry.stats().counted).toBe(1);
  two.release();
  expect(w.registry.stats()).toMatchObject({ counted: 0, expectedBytes: 0 });
});

test("a request for a book that is being closed waits for it and then has the book again", async () => {
  const w = world({ idleMs: 1000 });
  const slot = await w.request("book-aaaa");
  let finish!: () => void;
  slot.hold = new Promise<void>((done) => {
    finish = done;
  });
  w.tick(5000);
  const sweeping = w.registry.sweep();
  await new Promise((done) => setTimeout(done, 1));
  expect(w.registry.stats()).toMatchObject({ counted: 0, closed: { idle: 1 } });
  // The book is still open, and closing, when a request for it arrives.
  const lease = await w.registry.acquire("book-aaaa");
  expect(lease.slot).toBe(slot);
  expect(w.registry.stats().counted).toBe(1);
  finish();
  await sweeping;
  // The eviction is over, the request still holds the place, and the entry was not thrown away under it.
  expect(w.registry.stats().counted).toBe(1);
  await lease.slot.current();
  lease.release();
  expect(w.registry.stats()).toMatchObject({ counted: 1, open: 1 });
});

test("the books nobody uses are forgotten, and a long run of different books keeps only the open ones", async () => {
  const w = world({ idleMs: 1000, maxBooks: 50 });
  for (const id of ids(300)) {
    await w.request(id);
    w.tick(2000);
    await w.registry.sweep();
  }
  expect(w.registry.stats().counted).toBeLessThanOrEqual(1);
  expect(w.registry.stats().tracked).toBeLessThanOrEqual(2);
  expect(w.slots.size).toBe(300);
});

test("stopping closes every book together and lets no more requests through", async () => {
  const w = world();
  for (const id of ["book-aaaa", "book-bbbb", "book-cccc"]) await w.request(id);
  await w.registry.stop();
  for (const slot of w.slots.values()) expect(slot.stopped).toBe(true);
  await expect(w.registry.acquire("book-aaaa")).rejects.toBeInstanceOf(BookClosedError);
  expect(w.registry.stats().counted).toBe(0);
});

test("the sweep runs by itself when it is asked to", async () => {
  const w = world({ sweepMs: 5, idleMs: 1 });
  await w.request("book-aaaa");
  w.tick(10);
  for (let i = 0; i < 100 && w.slots.get("book-aaaa")?.open; i += 1)
    await new Promise((done) => setTimeout(done, 5));
  expect(w.slots.get("book-aaaa")?.open).toBe(false);
  await w.registry.stop();
});

test("the token bucket gives its burst, then its rate", () => {
  const bucket = new TokenBucket(10, 3, 0);
  expect([0, 0, 0].map(() => bucket.take(0))).toEqual([0, 0, 0]);
  expect(bucket.take(0)).toBeCloseTo(0.1, 5);
  expect(bucket.take(100)).toBe(0);
  expect(bucket.take(100)).toBeCloseTo(0.1, 5);
  // Never more than the burst, however long it has been.
  expect([0, 0, 0].map(() => bucket.take(1_000_000))).toEqual([0, 0, 0]);
  expect(bucket.take(1_000_000)).toBeGreaterThan(0);
});

test("the default settings follow the memory the process is given", () => {
  const small = defaultBooksSettings(512 * MB);
  const large = defaultBooksSettings(1280 * MB);
  expect(large.warmBudgetBytes).toBeGreaterThan(small.warmBudgetBytes);
  expect(large.loadBytes).toBe(Math.round(1280 * MB * 0.2));
  expect(large.residentLimitBytes).toBe(Math.round(1280 * MB * 0.9));
  // The budget, the loads and the tenth kept free, and the process itself, fit in what it is given.
  expect(large.warmBudgetBytes + large.loadBytes + 130 * MB + 128 * MB).toBeLessThanOrEqual(
    1280 * MB + 1,
  );
  // A very small allowance still leaves room for a few books.
  expect(defaultBooksSettings(128 * MB).warmBudgetBytes).toBeGreaterThanOrEqual(64 * MB);
});

test("a book is counted by the size of its file when the file says more than its log: one imported whole has a log of one entry", async () => {
  const imported = 34 * MB;
  const w = world({}, { "book-imp0": 1 }, 100, { "book-imp0": imported });
  await w.request("book-imp0");
  expect(w.registry.stats().expectedBytes).toBe(warmBookBytes(3, imported));
  // 2 MB and two and a half times the file: far more than the log's three entries would have said.
  expect(warmBookBytes(3, imported)).toBe(Math.round(2 * MB + 2.5 * imported));
  expect(warmBookBytes(3, imported)).toBeGreaterThan(30 * warmBookBytes(3));
  // And a long log of a small file is counted by the log.
  expect(warmBookBytes(60_000, 1 * MB)).toBe(warmBookBytes(60_000));
  expect(warmBookBytes(null, null)).toBe(warmBookBytes(0));
});

test("what a book took is remembered when it is closed, and the next opening is counted and gated for it", async () => {
  const big = 34 * MB;
  const w = world({ idleMs: 1000 }, {}, 100, { "book-big0": big });
  expect(w.registry.remembered("book-big0")).toBeUndefined();
  await w.request("book-big0");
  expect(w.registry.remembered("book-big0")).toBe(big);
  w.tick(5000);
  expect(await w.registry.sweep()).toBe(1);
  expect(w.registry.stats()).toMatchObject({ counted: 0, expectedBytes: 0 });
  // The limiter of the next load is told what the book took, from the hint the slot was made with.
  expect(w.hints.get("book-big0")?.()).toBe(big);
  expect(activationBytesFor(big)).toBe(Math.round(40 * MB + 4 * big));
  // And while it opens it is counted for that, not for a typical book.
  const lease = await w.registry.acquire("book-big0");
  expect(w.registry.stats().expectedBytes).toBe(warmBookBytes(null, big));
  expect(w.registry.stats().expectedBytes).toBeGreaterThan(TYPICAL_BOOK_BYTES);
  lease.release();
  // A book this process has not held has no hint.
  await w.request("book-new0");
  expect(w.hints.get("book-new0")?.()).toBeUndefined();
});

test("a book that takes a great deal of room makes the pod close the others to hold it", async () => {
  const w = world({ warmBudgetBytes: 90 * MB }, {}, 100, { "book-big0": 34 * MB });
  await w.request("book-aaaa");
  w.tick(10);
  await w.request("book-bbbb");
  w.tick(10);
  // A 34 MB book is counted for 91 MB, and with the two small books that is past the budget.
  await w.request("book-big0");
  await new Promise((done) => setTimeout(done, 5));
  expect(w.slots.get("book-big0")?.open).toBe(true);
  expect(w.slots.get("book-aaaa")?.open).toBe(false);
  expect(w.slots.get("book-bbbb")?.open).toBe(false);
  // A book that is alone and bigger than the budget stays: it is closed only when someone else needs the room.
  expect(w.registry.stats().expectedBytes).toBe(warmBookBytes(3, 34 * MB));
});

test("the file is measured when the book opens and then at most once a minute, not with every request", async () => {
  const w = world({}, {}, 100, { "book-aaaa": 5 * MB });
  for (let i = 0; i < 20; i += 1) await w.request("book-aaaa");
  expect(w.slots.get("book-aaaa")?.measured).toBe(1);
  w.tick(30_000);
  await w.request("book-aaaa");
  expect(w.slots.get("book-aaaa")?.measured).toBe(1);
  w.tick(31_000);
  await w.request("book-aaaa");
  expect(w.slots.get("book-aaaa")?.measured).toBe(2);
});

test("only the sizes of the most recent books are remembered", async () => {
  const w = world({ idleMs: 1, maxBooks: 100_000 }, {}, 100, {});
  // Sizes are remembered only for books whose file was measured.
  const sized: Record<string, number> = {};
  for (const id of ids(5000)) sized[id] = MB;
  const x = world({ idleMs: 1000, maxBooks: 100_000 }, {}, 100, sized);
  for (const id of ids(5000)) {
    await x.request(id);
    x.tick(2000);
    await x.registry.sweep();
  }
  expect(x.registry.remembered(ids(5000)[0] as string)).toBeUndefined();
  expect(x.registry.remembered(ids(5000)[4999] as string)).toBe(MB);
  expect(w.registry.remembered("book-none")).toBeUndefined();
});

test("the registry says which books it holds open, the one used last first, for the servers that start after it: a book not yet open, one the sweep closed and one being closed are not on it", async () => {
  const w = world({ idleMs: 3_600_000 });
  await w.request("book-aaaa");
  w.tick(60_000);
  await w.request("book-bbbb");
  w.tick(60_000);
  await w.request("book-cccc");
  w.tick(60_000);
  // A request for the first book makes it the one used last, and one that is let through and not opened (it is still opening) is not open.
  await w.request("book-aaaa");
  const opening = await w.registry.acquire("book-dddd");
  const names = () => w.registry.hot().map((book) => book.id);
  expect(names()).toEqual(["book-aaaa", "book-cccc", "book-bbbb"]);
  // When each was last used is the registry's clock (milliseconds since 1970 in a server): the last request's, and a request that is going on counts as use.
  const aaaa = w.registry.hot()[0];
  expect(aaaa).toEqual({ id: "book-aaaa", at: 1_000_000 + 180_000 });
  // A book that has been idle past the limit is closed by the sweep and leaves the list.
  w.tick(3_600_000);
  await w.request("book-aaaa");
  await w.registry.sweep();
  expect(names()).toEqual(["book-aaaa"]);
  await opening.slot.current();
  opening.release();
  expect(names()).toEqual(["book-aaaa", "book-dddd"]);
  // A book that is being closed is not on it: it is on its way out, and a server that opened it would be opening what its holder is closing.
  const closing = Promise.withResolvers<void>();
  const slot = w.slots.get("book-aaaa") as Slot;
  slot.hold = closing.promise;
  w.tick(3_600_001);
  const sweeping = w.registry.sweep();
  await Promise.resolve();
  expect(names()).not.toContain("book-aaaa");
  closing.resolve();
  await sweeping;
  // What a server that is stopping holds is nothing: the entries are gone.
  await w.registry.stop();
  expect(names()).toEqual([]);
});

test("a request that is told not to close other books for room is refused as busy when there is none and closes nothing; any other request closes the book used least recently and goes on", async () => {
  const w = world({ maxBooks: 2 });
  await w.request("book-aaaa");
  w.tick(1000);
  await w.request("book-bbbb");
  const refused = await w.registry.acquire("book-cccc", "service", { evict: false }).then(
    () => null,
    (error: unknown) => error,
  );
  expect(refused).toBeInstanceOf(BooksRefused);
  expect((refused as BooksRefused).failure.code).toBe("server_busy");
  expect(
    w.registry
      .hot()
      .map((book) => book.id)
      .sort(),
  ).toEqual(["book-aaaa", "book-bbbb"]);
  expect(w.registry.stats().closed.room).toBe(0);
  // With room it goes through, as the same request does without the option.
  const third = await w.registry.acquire("book-cccc", "service");
  expect(w.registry.stats().closed.room).toBe(1);
  expect(w.slots.get("book-aaaa")?.closed).toBe(1);
  third.release();
});

test("a book that was opened ahead of a request was last used when the list it came from says, not when it was opened: it is closed for being idle on that account and is told to the next server as such", async () => {
  const w = world({ idleMs: 3_600_000 });
  const lease = await w.registry.acquire("book-aaaa", "service", { evict: false });
  await lease.slot.current();
  lease.release();
  // Opened now, last used fifty-five minutes ago.
  w.registry.markUsed("book-aaaa", 1_000_000 - 55 * 60_000);
  expect(w.registry.hot()).toEqual([{ id: "book-aaaa", at: 1_000_000 - 55 * 60_000 }]);
  w.tick(4 * 60_000);
  expect(await w.registry.sweep()).toBe(0);
  w.tick(2 * 60_000);
  expect(await w.registry.sweep()).toBe(1);
  expect(w.registry.hot()).toEqual([]);
  // A time ahead of the clock is now, a book that is not tracked is nothing, and a book in use is not touched.
  await w.request("book-bbbb");
  w.registry.markUsed("book-bbbb", 99_000_000);
  expect(w.registry.hot()).toEqual([{ id: "book-bbbb", at: 1_000_000 + 6 * 60_000 }]);
  w.registry.markUsed("book-none", 5);
  const busy = await w.registry.acquire("book-bbbb");
  w.registry.markUsed("book-bbbb", 1);
  expect(w.registry.hot()[0]?.at).toBe(1_000_000 + 6 * 60_000);
  busy.release();
});

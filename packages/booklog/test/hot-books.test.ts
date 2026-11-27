// The list of the books a pod has open, left in the bucket for the pods that start after it (src/hot-books.ts; a server uses it in apps/api/src/hosted.ts): what is written, what a starting pod makes of the lists it finds, and that nothing
// it finds or fails to find is ever a reason for it not to start.
import { expect, test } from "bun:test";
import {
  HOT_BOOK_MAX_AGE_MS,
  HOT_FOLDER,
  HOT_LOOKBACK_MS,
  HOT_MAX_BOOKS,
  HotBooks,
} from "../src/hot-books.ts";
import { MemoryObjectStore } from "../src/memory.ts";
import { ObjectStoreError } from "../src/objectstore.ts";

const NOW = Date.UTC(2026, 10, 21, 18, 0, 0);
const MINUTE = 60_000;

/** A pod of a service: its own name and its own clock, on the bucket the pods share. */
function pod(bulk: MemoryObjectStore, name: string, clock: { now: number }, prefix = "") {
  const lines: string[] = [];
  const hot = new HotBooks({
    bulk,
    prefix,
    holder: name,
    now: () => clock.now,
    log: (line) => lines.push(line),
  });
  return { hot, lines };
}
const keysOf = async (bulk: MemoryObjectStore, prefix = "") =>
  (await bulk.list(`${prefix}${HOT_FOLDER}`)).objects.map((object) => object.key);

test("a list names the books a pod has open, and a pod that starts reads them back, the one used last first", async () => {
  const bulk = new MemoryObjectStore();
  const clock = { now: NOW };
  const first = pod(bulk, "rastrata-aaa", clock);
  expect(
    await first.hot.publish([
      { id: "tenant-aaaa", at: NOW - 30 * MINUTE },
      { id: "tenant-bbbb", at: NOW - 2 * MINUTE },
      { id: "tenant-cccc", at: NOW - 10 * MINUTE },
    ]),
  ).toBe(true);
  clock.now += 3 * MINUTE;
  const second = pod(bulk, "rastrata-bbb", clock);
  expect((await second.hot.recent()).map((book) => book.id)).toEqual([
    "tenant-bbbb",
    "tenant-cccc",
    "tenant-aaaa",
  ]);
  // What it keeps of each is when it was last used, in the clock of the pod that wrote it.
  expect((await second.hot.recent())[0]).toEqual({ id: "tenant-bbbb", at: NOW - 2 * MINUTE });
  expect(first.lines).toEqual([]);
  expect(second.lines).toEqual([]);
});

test("a list is a small object of its own under the service's folder, beside the books and never inside them, named for the moment and the pod", async () => {
  const bulk = new MemoryObjectStore();
  const clock = { now: NOW };
  const { hot } = pod(bulk, "host#123#abc#def", clock, "runs/x/");
  await hot.publish([{ id: "tenant-aaaa", at: NOW }]);
  const keys = await keysOf(bulk, "runs/x/");
  expect(keys).toHaveLength(1);
  expect(keys[0]).toBe(`runs/x/service/hot/${String(NOW).padStart(13, "0")}.host_123_abc_def.json`);
  expect(keys[0]).not.toContain("/books/");
  const stored = await bulk.get(keys[0] ?? "");
  const body = JSON.parse(new TextDecoder().decode(stored?.body));
  expect(body).toEqual({ v: 1, at: NOW, books: [{ id: "tenant-aaaa", at: NOW }] });
  // Nothing in it but the names of books: no person, no address.
  expect(JSON.stringify(body)).not.toMatch(/@|\d+\.\d+\.\d+\.\d+|email|user/i);
  expect(() => new HotBooks({ bulk, prefix: "/bad", holder: "a" })).toThrow(RangeError);
  expect(() => new HotBooks({ bulk, prefix: "no-slash", holder: "a" })).toThrow(RangeError);
});

test("the pods of a service are put together: the newest list of each, and for a book the latest use that any of them knew", async () => {
  const bulk = new MemoryObjectStore();
  const clock = { now: NOW };
  const one = pod(bulk, "pod-one", clock);
  const two = pod(bulk, "pod-two", clock);
  await one.hot.publish([{ id: "tenant-aaaa", at: NOW - 20 * MINUTE }]);
  clock.now += MINUTE;
  await two.hot.publish([
    { id: "tenant-aaaa", at: NOW - 5 * MINUTE },
    { id: "tenant-bbbb", at: NOW - 8 * MINUTE },
  ]);
  clock.now += MINUTE;
  // A newer list of the first pod replaces its older one: a book it has since closed is not on it any more.
  await one.hot.publish([{ id: "tenant-cccc", at: NOW - 3 * MINUTE }]);
  clock.now += MINUTE;
  const found = await pod(bulk, "pod-three", clock).hot.recent();
  expect(found).toEqual([
    { id: "tenant-cccc", at: NOW - 3 * MINUTE },
    { id: "tenant-aaaa", at: NOW - 5 * MINUTE },
    { id: "tenant-bbbb", at: NOW - 8 * MINUTE },
  ]);
});

test("a list older than ninety minutes is not read, and a book last used longer ago than a pod would keep it open is not on the list", async () => {
  const bulk = new MemoryObjectStore();
  const clock = { now: NOW };
  const old = pod(bulk, "pod-old", clock);
  await old.hot.publish([{ id: "tenant-aaaa", at: NOW }]);
  const recent = pod(bulk, "pod-recent", clock);
  clock.now = NOW + HOT_LOOKBACK_MS - MINUTE;
  await recent.hot.publish([
    { id: "tenant-bbbb", at: NOW + 10 * MINUTE },
    { id: "tenant-dddd", at: clock.now - HOT_BOOK_MAX_AGE_MS - MINUTE },
    { id: "tenant-eeee", at: clock.now - HOT_BOOK_MAX_AGE_MS + MINUTE },
  ]);
  // Just inside the lookback both lists are there; the book last used over thirty days ago is not.
  expect((await recent.hot.recent()).map((book) => book.id)).toEqual([
    "tenant-bbbb",
    "tenant-aaaa",
    "tenant-eeee",
  ]);
  // Two minutes later the first pod's list is outside the lookback and the second's is not, and the book that was a minute short of thirty days has reached them.
  clock.now += 2 * MINUTE;
  expect((await recent.hot.recent()).map((book) => book.id)).toEqual(["tenant-bbbb"]);
  clock.now = NOW + 10 * HOT_LOOKBACK_MS;
  expect(await recent.hot.recent()).toEqual([]);
});

test("what is not a list, is not read as one: a name that is not a book's, a time that is not one, a list that is not JSON or is too big", async () => {
  const bulk = new MemoryObjectStore();
  const clock = { now: NOW };
  const put = (name: string, body: string | Uint8Array, at = NOW) =>
    bulk.putIfAbsent(
      `${HOT_FOLDER}${String(at).padStart(13, "0")}.${name}.json`,
      typeof body === "string" ? new TextEncoder().encode(body) : body,
    );
  await put("garbage", "not json at all");
  await put("array", "[1, 2, 3]", NOW + 1);
  await put("null", "null", NOW + 2);
  await put(
    "mixed",
    JSON.stringify({
      books: [
        { id: "tenant-good", at: NOW - MINUTE },
        { id: "../etc/passwd", at: NOW },
        { id: "", at: NOW },
        { id: 42, at: NOW },
        { id: "tenant-notime" },
        { id: "tenant-nan", at: "soon" },
        { id: "tenant-negative", at: -5 },
        { id: "tenant-future", at: NOW + 99 * 3_600_000 },
        null,
        "tenant-bare",
      ],
    }),
    NOW + 3,
  );
  await put("huge", new Uint8Array(70 * 1024).fill(32), NOW + 4);
  // Keys that are not lists' are not lists.
  await bulk.putIfAbsent(`${HOT_FOLDER}notes.txt`, new TextEncoder().encode("hello"));
  await bulk.putIfAbsent(`${HOT_FOLDER}${String(NOW).padStart(13, "0")}..json`, new Uint8Array(0));
  clock.now = NOW + 5;
  const found = await pod(bulk, "reader", clock).hot.recent();
  expect(found.map((book) => book.id).sort()).toEqual(["tenant-future", "tenant-good"]);
  // A time ahead of this clock by more than an hour is taken as now (a clock that is wrong is not a reason to prefer a book for a day).
  expect(found.find((book) => book.id === "tenant-future")?.at).toBe(clock.now + 3_600_000);
});

test("a list names at most as many books as a pod could have open, the newest used", async () => {
  const bulk = new MemoryObjectStore();
  const clock = { now: NOW };
  const { hot } = pod(bulk, "pod-one", clock);
  const books = Array.from({ length: HOT_MAX_BOOKS + 40 }, (_, index) => ({
    id: `tenant-${String(index).padStart(4, "0")}`,
    at: NOW - index * 1000,
  }));
  expect(
    await hot.publish([...books, { id: "bad id", at: NOW }, { id: "tenant-x", at: Number.NaN }]),
  ).toBe(true);
  const found = await pod(bulk, "pod-two", clock).hot.recent();
  expect(found).toHaveLength(HOT_MAX_BOOKS);
  expect(found[0]?.id).toBe("tenant-0000");
  expect(found.at(-1)?.id).toBe(`tenant-${String(HOT_MAX_BOOKS - 1).padStart(4, "0")}`);
});

test("a bucket that does not answer, or that refuses, is told in the log and is never a reason to fail: nothing is written, nothing is read, nothing is thrown", async () => {
  const bulk = new MemoryObjectStore();
  const refusing = new Proxy(bulk, {
    get(target, property) {
      if (["putIfAbsent", "get", "list"].includes(String(property)))
        return async () => {
          throw new ObjectStoreError("the bucket did not answer", 503);
        };
      return Reflect.get(target, property);
    },
  });
  const lines: string[] = [];
  const hot = new HotBooks({
    bulk: refusing,
    holder: "pod-one",
    now: () => NOW,
    log: (line) => lines.push(line),
  });
  expect(await hot.publish([{ id: "tenant-aaaa", at: NOW }])).toBe(false);
  expect(await hot.recent()).toEqual([]);
  expect(lines).toHaveLength(2);
  expect(lines.every((line) => line.startsWith("hot books: "))).toBe(true);
  // What the bucket said is in the line, cut short, and never a key or an address.
  expect(lines[0]).toContain("the bucket did not answer");
});

test("a list that cannot be read is left out and the others are used", async () => {
  const bulk = new MemoryObjectStore();
  const clock = { now: NOW };
  await pod(bulk, "pod-good", clock).hot.publish([{ id: "tenant-aaaa", at: NOW }]);
  clock.now += 1000;
  await pod(bulk, "pod-torn", clock).hot.publish([{ id: "tenant-bbbb", at: NOW }]);
  const torn = (await keysOf(bulk)).find((key) => key.includes("pod-torn")) ?? "";
  const reading = new Proxy(bulk, {
    get(target, property) {
      if (property === "get")
        return async (key: string) => {
          if (key === torn) throw new ObjectStoreError("the bucket did not answer", 503);
          return target.get(key);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  clock.now += 1000;
  const hot = new HotBooks({ bulk: reading, holder: "reader", now: () => clock.now });
  expect((await hot.recent()).map((book) => book.id)).toEqual(["tenant-aaaa"]);
});

test("the same pod saying the same moment twice writes it once, and says so", async () => {
  const bulk = new MemoryObjectStore();
  const { hot } = pod(bulk, "pod-one", { now: NOW });
  expect(await hot.publish([{ id: "tenant-aaaa", at: NOW }])).toBe(true);
  expect(await hot.publish([{ id: "tenant-bbbb", at: NOW }])).toBe(false);
  expect(await keysOf(bulk)).toHaveLength(1);
});

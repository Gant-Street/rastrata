// What the page reads before it draws itself (src/opening.ts): each read is given once, to the first loader that asks, in place of that loader's own first request.
import { afterEach, expect, test } from "bun:test";
import {
  beginOpening,
  endOpening,
  fromOpening,
  openingRead,
  resetOpening,
} from "../../src/opening.ts";

afterEach(resetOpening);

test("a read that has answered before the first draw is what the loader starts from, and its own fetcher is left for the next read", async () => {
  let asked = 0;
  beginOpening("book", async () => "the book");
  await openingRead();
  const opening = fromOpening("book", async () => {
    asked += 1;
    return "read again";
  });
  expect(opening.initial).toBe("the book");
  expect(asked).toBe(0);
  expect(await opening.fetcher()).toBe("read again");
});

test("a read that is slow does not hold the first draw past the wait; the loader then waits for that same read and asks the service only after it", async () => {
  let answer: (value: string) => void = () => {};
  let asked = 0;
  beginOpening("book", () => new Promise<string>((done) => (answer = done)));
  const started = performance.now();
  await openingRead(20);
  expect(performance.now() - started).toBeLessThan(500);
  const opening = fromOpening("book", async () => {
    asked += 1;
    return "read again";
  });
  expect(opening.initial).toBeUndefined();
  const first = opening.fetcher();
  answer("the book, late");
  expect(await first).toBe("the book, late");
  expect(asked).toBe(0);
  expect(await opening.fetcher()).toBe("read again");
  expect(asked).toBe(1);
});

test("a read that failed is the loader's first failure, and holds nothing back", async () => {
  beginOpening("book", async () => {
    throw new Error("the service did not answer");
  });
  await openingRead();
  const opening = fromOpening("book", async () => "read again");
  expect(opening.initial).toBeUndefined();
  await expect(opening.fetcher()).rejects.toThrow("the service did not answer");
  expect(await opening.fetcher()).toBe("read again");
});

test("a read is given once for each use, and to nobody once the page has changed or something was written", async () => {
  beginOpening("book", async () => "the book");
  await openingRead();
  const own = async () => "read again";
  expect(fromOpening("book", own, "shell").initial).toBe("the book");
  expect(fromOpening("book", own, "shell").initial).toBeUndefined();
  expect(fromOpening("book", own, "home").initial).toBe("the book");
  resetOpening();
  beginOpening("book", async () => "the book");
  await openingRead();
  endOpening();
  expect(fromOpening("book", own).initial).toBeUndefined();
  // Nothing begins after the opening is over.
  beginOpening("person", async () => "someone");
  expect(fromOpening("person", own).initial).toBeUndefined();
});

test("a read the first draw does not need is not waited for", async () => {
  beginOpening("book", () => new Promise<string>(() => {}));
  beginOpening("person", async () => "someone");
  const started = performance.now();
  await openingRead(5_000, ["book"]);
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(fromOpening("person", async () => "asked again").initial).toBe("someone");
});

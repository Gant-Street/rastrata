import { expect, test } from "bun:test";
import { currentStateCache } from "../src/current-state-cache.ts";

test("current decoder slots share a UTF-8 budget and release replaced entries", () => {
  const cache = currentStateCache(6);
  let calls = 0;
  const decode = (text: string) => {
    calls++;
    return Object.freeze({ text });
  };
  const first = cache.memoize(decode),
    second = cache.memoize(decode);
  const a = first("éé");
  expect(first("éé")).toBe(a);
  const b = second("bb");
  expect(second("bb")).toBe(b);
  expect(cache.retainedBytes()).toBe(6);
  expect(calls).toBe(2);
  expect(second("éé")).not.toBe(second("éé"));
  expect(cache.retainedBytes()).toBe(4);
  first("x");
  const c = second("éé");
  expect(second("éé")).toBe(c);
  expect(cache.retainedBytes()).toBe(5);
  first("too large");
  expect(cache.retainedBytes()).toBe(4);
});

test("cache never trusts shallow freezing, retains failed replacements or grows with history", () => {
  const cache = currentStateCache(32);
  const shallow = cache.memoize(() => Object.freeze({ nested: { mutable: true } }));
  expect(shallow("same")).not.toBe(shallow("same"));
  expect(cache.retainedBytes()).toBe(0);
  const decode = cache.memoize((text: string) => {
    if (text === "bad") throw new Error("decode failed");
    return Object.freeze({ text });
  });
  const first = decode("first");
  expect(() => decode("bad")).toThrow("decode failed");
  expect(cache.retainedBytes()).toBe(0);
  expect(decode("first")).not.toBe(first);
  for (let i = 0; i < 1000; i++) decode(String(i));
  expect(cache.retainedBytes()).toBe(3);
  for (const budget of [-1, NaN, 1.5]) expect(() => currentStateCache(budget)).toThrow();
  expect(currentStateCache(0).memoize((text) => text)("uncached")).toBe("uncached");
});

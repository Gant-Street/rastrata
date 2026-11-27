import { afterEach, expect, test } from "bun:test";
import {
  isHandoff,
  leaveHandoff,
  OPENING_HANDOFF_KEY,
  takeHandoff,
} from "../../src/routes/shadow/handoff";

/** A browser's session storage, as much of it as the hand-off uses. */
function fakeStorage(options: { full?: boolean } = {}) {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (options.full) throw new Error("QuotaExceededError");
      items.set(key, value);
    },
    removeItem: (key: string) => void items.delete(key),
  };
}

const original = (globalThis as { window?: unknown }).window;
afterEach(() => {
  (globalThis as { window?: unknown }).window = original;
});
const withStorage = (storage: ReturnType<typeof fakeStorage>) => {
  (globalThis as { window?: unknown }).window = { sessionStorage: storage };
};

const good = {
  asOf: "2026-06-30",
  balances: [
    { accountId: "1000", balance: "12000.00" },
    { accountId: "2000", balance: "-523.10" },
  ],
};

test("a hand-off is balances to fill the opening balances, and nothing else", () => {
  expect(isHandoff(good)).toBe(true);
  expect(isHandoff({ ...good, asOf: null })).toBe(true);
  for (const bad of [
    null,
    "text",
    42,
    {},
    { asOf: "2026-06-30" },
    { ...good, balances: [] },
    { ...good, asOf: 5 },
    { ...good, balances: [{ accountId: "", balance: "1.00" }] },
    { ...good, balances: [{ accountId: "1000", balance: "1.5" }] },
    { ...good, balances: [{ accountId: "1000", balance: "1e3" }] },
    { ...good, balances: [{ accountId: "1000", balance: 1 }] },
    { ...good, balances: [{ accountId: "x".repeat(201), balance: "1.00" }] },
    {
      ...good,
      balances: Array.from({ length: 401 }, () => ({ accountId: "1000", balance: "1.00" })),
    },
  ])
    expect(isHandoff(bad), JSON.stringify(bad)?.slice(0, 80)).toBe(false);
});

test("what is left is taken once, and gone afterwards", () => {
  const storage = fakeStorage();
  withStorage(storage);
  expect(leaveHandoff(good)).toBe(true);
  expect(storage.items.has(OPENING_HANDOFF_KEY)).toBe(true);
  expect(takeHandoff()).toEqual(good);
  expect(storage.items.has(OPENING_HANDOFF_KEY)).toBe(false);
  expect(takeHandoff()).toBeNull();
});

test("anything else in that place is ignored and removed, never trusted", () => {
  const storage = fakeStorage();
  withStorage(storage);
  storage.items.set(OPENING_HANDOFF_KEY, "{not json");
  expect(takeHandoff()).toBeNull();
  expect(storage.items.has(OPENING_HANDOFF_KEY)).toBe(false);
  storage.items.set(
    OPENING_HANDOFF_KEY,
    JSON.stringify({ asOf: null, balances: [{ accountId: "1000", balance: "<script>" }] }),
  );
  expect(takeHandoff()).toBeNull();
});

test("a browser that will not keep it says so, and a missing storage is no hand-off", () => {
  withStorage(fakeStorage({ full: true }));
  expect(leaveHandoff(good)).toBe(false);
  (globalThis as { window?: unknown }).window = {
    get sessionStorage(): never {
      throw new Error("blocked");
    },
  };
  expect(leaveHandoff(good)).toBe(false);
  expect(takeHandoff()).toBeNull();
});

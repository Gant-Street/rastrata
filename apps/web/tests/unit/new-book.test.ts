import { expect, test } from "bun:test";
import { noteSetupPending, openWorkspace, setupPending } from "../../src/new-book";

function notes() {
  const kept = new Map<string, string>();
  return {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
  };
}

test("a workspace whose books are still to be set up is remembered until its book says they are", () => {
  const browser = notes();
  expect(setupPending("w1", browser)).toBe(false);
  noteSetupPending("w1", true, browser);
  expect(setupPending("w1", browser)).toBe(true);
  expect(setupPending("w1", browser)).toBe(true);
  expect(setupPending("w2", browser)).toBe(false);
  expect(setupPending(null, browser)).toBe(false);
  // Another workspace set up says nothing about this one.
  noteSetupPending("w2", false, browser);
  expect(setupPending("w1", browser)).toBe(true);
  noteSetupPending("w1", false, browser);
  expect(setupPending("w1", browser)).toBe(false);
});

test("a browser with no storage never says a workspace's books are still to be set up", () => {
  noteSetupPending("w1", true, null);
  expect(setupPending("w1", null)).toBe(false);
  expect(openWorkspace(null)).toBe(null);
});

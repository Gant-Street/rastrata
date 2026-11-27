import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateOwnerKey, readOwnerKey } from "../src/agent/local.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

function directory() {
  const path = mkdtempSync(join(tmpdir(), "rastrata-owner-key-"));
  cleanup.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test("the owner key file is created private, reused, and refused when it is shared or not a key", () => {
  const path = join(directory(), "nested", "owner.key");
  const first = loadOrCreateOwnerKey(path);
  expect(first).toMatch(/^rso_[A-Za-z0-9_-]{43}$/);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(path, "..")).mode & 0o077).toBe(0);
  expect(readFileSync(path, "utf8")).toBe(`${first}\n`);
  // The same file gives the same key; it is never rewritten.
  expect(loadOrCreateOwnerKey(path)).toBe(first);
  expect(readOwnerKey(path)).toBe(first);
  chmodSync(path, 0o640);
  expect(() => loadOrCreateOwnerKey(path)).toThrow("private to you");
  expect(() => readOwnerKey(path)).toThrow("private to you");
  chmodSync(path, 0o600);
  writeFileSync(path, "not a key\n");
  expect(() => loadOrCreateOwnerKey(path)).toThrow("does not contain a Rastrata owner key");
  // A token is not an owner key, even though both are Bearer strings.
  writeFileSync(path, `rst_${"0".repeat(16)}_${"a".repeat(43)}\n`);
  expect(() => loadOrCreateOwnerKey(path)).toThrow("owner key");
});

test("reading never creates a file, and a directory is not a key file", () => {
  const root = directory();
  expect(() => readOwnerKey(join(root, "missing.key"))).toThrow("does not exist");
  expect(() => readOwnerKey(join(root, "missing.key"))).toThrow();
  expect(statSync(root).isDirectory()).toBe(true);
  mkdirSync(join(root, "folder"));
  expect(() => readOwnerKey(join(root, "folder"))).toThrow("not a file");
});

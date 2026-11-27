import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import {
  auditIndex,
  buildIndex,
  experimentEntry,
  leafCapacity,
  lookup,
  measureColdIndex,
  packedShape,
  pageHash,
  type Pages,
} from "../scripts/cold-index-layout.ts";

const key = (value: number) => value.toString(16).padStart(64, "0");
function required<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}
const rows = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ key: key(i * 2 + 2), sequence: BigInt(i + 1) }));

test("packed index preserves exact IDs/locators and proves gaps against the trusted root", () => {
  const pages: Pages = new Map();
  const input = rows(leafCapacity + 2);
  const root = buildIndex([...input].reverse(), pages);
  const read = (hash: string) => pages.get(hash);
  expect(auditIndex(root, read)).toEqual(input);
  for (const row of input) expect(lookup(root, row.key, read)).toBe(row.sequence);
  // Before/after the population, within a leaf, and between adjacent child fences.
  for (const absent of [1, 3, leafCapacity * 2 + 1, input.length * 2 + 1])
    expect(lookup(root, key(absent), read)).toBeNull();
  expect(buildIndex([], pages)).toBeNull();
  expect(
    lookup(null, key(1), () => {
      throw new Error("empty anchored root needs no page");
    }),
  ).toBeNull();
});

test("missing/altered selected pages fail instead of converting an old identity to absence", () => {
  for (const damage of ["missing", "changed", "truncated"] as const) {
    const pages: Pages = new Map();
    const input = rows(leafCapacity + 2);
    const root = required(buildIndex(input, pages));
    const target = required([...pages.keys()].find((hash) => hash !== root.hash));
    if (damage === "missing") pages.delete(target);
    else {
      const original = required(pages.get(target));
      const bytes = damage === "truncated" ? original.slice(0, -1) : original.slice();
      if (damage === "changed") bytes[bytes.length - 1] = required(bytes.at(-1)) ^ 1;
      pages.set(target, bytes);
    }
    expect(() => lookup(root, required(input[0]).key, (hash) => pages.get(hash))).toThrow();
    expect(() => auditIndex(root, (hash) => pages.get(hash))).toThrow();
  }
});

test("valid checksums alone do not excuse malformed page order or wrong population/fences", () => {
  const pages: Pages = new Map();
  const root = required(buildIndex(rows(3), pages));
  const bytes = required(pages.get(root.hash)).slice();
  // Duplicate the first key in the second row, then recompute the checksum.
  bytes.set(bytes.slice(9, 41), 49);
  const malformed = { ...root, hash: pageHash(bytes) };
  pages.set(malformed.hash, bytes);
  expect(() => lookup(malformed, key(2), (hash) => pages.get(hash))).toThrow("invalid key order");
  for (const changed of [
    { ...root, count: 4n },
    { ...root, min: key(1) },
    { ...root, max: key(7) },
  ])
    expect(() => lookup(changed, key(2), (hash) => pages.get(hash))).toThrow();
  expect(() => lookup(root, key(2), () => undefined)).toThrow("required index page missing");
});

test("healthy point lookup is explicitly not a complete cold-history audit", () => {
  const pages: Pages = new Map();
  const input = rows(leafCapacity + 2);
  const root = required(buildIndex(input, pages));
  const leaves = [...pages.keys()].filter((hash) => hash !== root.hash);
  pages.delete(required(leaves[1]));
  expect(lookup(root, required(input[0]).key, (hash) => pages.get(hash))).toBe(1n);
  expect(() => auditIndex(root, (hash) => pages.get(hash))).toThrow("required index page missing");
});

test("duplicate digests and invalid inputs are rejected before building usable pages", () => {
  for (const input of [
    [experimentEntry(1), experimentEntry(1)],
    [{ key: "bad", sequence: 1n }],
    [{ key: key(1), sequence: 0n }],
    [{ key: key(1), sequence: 1n << 64n }],
  ]) {
    const pages: Pages = new Map();
    expect(() => buildIndex(input, pages)).toThrow();
    expect(pages.size).toBe(0);
  }
  expect(() => measureColdIndex(300_001)).toThrow();
  expect(() => measureColdIndex(0)).toThrow();
});

test("small measurement verifies the full row population and exact packed byte count", () => {
  const result = measureColdIndex(1_000);
  expect(result.verifiedRows).toBe(1_000);
  expect(result.pageCount).toBe(3);
  expect(result.pageBytes).toBe(40_235); // 40,000 row bytes + 27 header bytes + 208 child bytes
  expect(result.maximumPagesPerLookup).toBe(2);
  expect(result.lookupCases).toBe(2_000);
  expect(result.productionExecutionVerified).toBe(false);
});

test("branch metadata is validated even when its checksum is internally consistent", () => {
  const pages: Pages = new Map();
  const root = required(buildIndex(rows(leafCapacity + 2), pages));
  const bytes = required(pages.get(root.hash)).slice();
  // Overlap the second child's lower fence with the first child's lower fence.
  bytes.set(bytes.slice(9, 41), 9 + 104);
  const malformed = { ...root, hash: pageHash(bytes) };
  pages.set(malformed.hash, bytes);
  expect(() => lookup(malformed, key(2), (hash) => pages.get(hash))).toThrow("invalid key order");
});

test("each bounded page layout crosses leaf/branch boundaries without losing the population", () => {
  const input = rows(4_100); // crosses the 4 KiB layout's first branch capacity
  for (const bytes of [4_096, 8_192, 32_768]) {
    const pages: Pages = new Map();
    const root = buildIndex(input, pages, bytes);
    expect(auditIndex(root, (hash) => pages.get(hash))).toEqual(input);
    expect([...pages.values()].every((page) => page.length <= bytes)).toBe(true);
    for (const i of [0, 101, 102, 203, 204, 817, 818, 4_099]) {
      const row = required(input[i]);
      expect(lookup(root, row.key, (hash) => pages.get(hash))).toBe(row.sequence);
      expect(lookup(root, key(Number(row.sequence) * 2 - 1), (hash) => pages.get(hash))).toBeNull();
    }
  }
});

test("packed shape is exact at capacity transitions and remains unexecuted at business scale", () => {
  expect(packedShape(0n)).toEqual({ levels: [], depth: 0, pages: 0n, bytes: 0n });
  expect(packedShape(818n).depth).toBe(1);
  expect(packedShape(819n).depth).toBe(2);
  expect(packedShape(818n * 314n).depth).toBe(2);
  expect(packedShape(818n * 314n + 1n).depth).toBe(3);
  for (const bytes of [4096, 8192, 32768]) {
    const pages: Pages = new Map();
    buildIndex(rows(4100), pages, bytes);
    const shape = packedShape(4100n, bytes);
    expect(shape.pages).toBe(BigInt(pages.size));
    expect(shape.bytes).toBe(
      BigInt([...pages.values()].reduce((sum, page) => sum + page.length, 0)),
    );
  }
  expect(packedShape(410_968_312n, 4096).depth).toBe(6);
  expect(packedShape(410_968_312n, 8192).depth).toBe(5);
  expect(packedShape(410_968_312n, 32768).depth).toBe(4);
  expect(() => packedShape(-1n)).toThrow();
  expect(() => packedShape(1n, 123)).toThrow();
});

test("isolated sample CLI verifies its target and invalid samples fail with no success report", () => {
  const path = `${import.meta.dir}/../scripts/cold-index-layout.ts`;
  const good = Bun.spawnSync([process.execPath, path, "--sample", "1000", "4096"]);
  expect(good.exitCode).toBe(0);
  expect(JSON.parse(good.stdout.toString())).toMatchObject({
    rows: 1000,
    verifiedRows: 1000,
    configuredPageBytes: 4096,
    productionExecutionVerified: false,
  });
  const bad = Bun.spawnSync([process.execPath, path, "--sample", "300001", "4096"]);
  expect(bad.exitCode).not.toBe(0);
  expect(bad.stdout.toString()).toBe("");
});

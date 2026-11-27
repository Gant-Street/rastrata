import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import {
  auditIndex,
  buildIndex,
  experimentEntry,
  lookup,
  readPage,
  writeExperimentPage,
  type Descriptor,
  type Entry,
  type Pages,
} from "../scripts/cold-index-layout.ts";
import {
  lookupRuns,
  measureIncremental,
  prepareCopyOnWrite,
  prepareMergedRuns,
} from "../scripts/incremental-index-layout.ts";

const entries = (start: number, count: number) =>
  Array.from({ length: count }, (_, i) => experimentEntry(start + i));
const ordered = (rows: Entry[]) => rows.sort((a, b) => (a.key < b.key ? -1 : 1));
function publishPages(target: Pages, staged: Pages) {
  for (const [hash, bytes] of staged) target.set(hash, bytes);
}

test("incremental page encoder reproduces independent bulk-writer bytes exactly", () => {
  const pages: Pages = new Map();
  const root = buildIndex(entries(1, 20_000), pages, 8192);
  const rewritten: Pages = new Map();
  const visit = (descriptor: Descriptor) => {
    const decoded = readPage(descriptor, (hash) => pages.get(hash));
    expect(writeExperimentPage(decoded.rows, decoded.children, rewritten)).toEqual(descriptor);
    for (const child of decoded.children) visit(child);
  };
  assert.ok(root);
  visit(root);
  expect([...rewritten.keys()].sort()).toEqual([...pages.keys()].sort());
  for (const [hash, bytes] of pages) expect(rewritten.get(hash)).toEqual(bytes);
});

test("copy-on-write batches preserve every old snapshot and exact ordered populations", () => {
  const pages: Pages = new Map();
  let root: Descriptor | null = null;
  const snapshots: { root: Descriptor | null; count: number }[] = [{ root, count: 0 }];
  for (let start = 1; start <= 4096; start += 128) {
    const oldPageCount = pages.size;
    const next = prepareCopyOnWrite(root, entries(start, 128), (hash) => pages.get(hash));
    expect(pages.size).toBe(oldPageCount);
    expect(next.root?.count).toBe(BigInt(start + 127));
    expect([...next.pages.values()].every((bytes) => bytes.length <= 8192)).toBe(true);
    publishPages(pages, next.pages);
    root = next.root;
    snapshots.push({ root, count: start + 127 });
  }
  for (const snapshot of snapshots) {
    expect(auditIndex(snapshot.root, (hash) => pages.get(hash))).toEqual(
      ordered(entries(1, snapshot.count)),
    );
    expect(
      lookup(snapshot.root, experimentEntry(snapshot.count + 1).key, (hash) => pages.get(hash)),
    ).toBeNull();
  }
});

test("point insert reads only its tree path and does not rebuild unrelated leaves", () => {
  const pages: Pages = new Map();
  const root = buildIndex(entries(1, 20_000), pages, 8192);
  let reads = 0;
  const next = prepareCopyOnWrite(root, entries(20_001, 1), (hash) => {
    reads++;
    return pages.get(hash);
  });
  expect(reads).toBe(3);
  expect(next.pages.size).toBeLessThanOrEqual(6);
  expect(next.pages.size).toBeLessThan(pages.size);
  publishPages(pages, next.pages);
  expect(auditIndex(next.root, (hash) => pages.get(hash))).toEqual(ordered(entries(1, 20_001)));
  expect(auditIndex(root, (hash) => pages.get(hash))).toEqual(ordered(entries(1, 20_000)));
});

test("failed copy-on-write preparation cannot mutate the old root or retained bytes", () => {
  const pages: Pages = new Map();
  const root = buildIndex(entries(1, 1000), pages, 8192);
  const before = structuredClone([...pages]);
  expect(() =>
    prepareCopyOnWrite(root, [experimentEntry(1001), experimentEntry(2)], (hash) =>
      pages.get(hash),
    ),
  ).toThrow("duplicate identity");
  expect([...pages]).toEqual(before);
  expect(root?.count).toBe(1000n);
  expect(() => prepareCopyOnWrite(root, entries(1001, 1), () => undefined)).toThrow(
    "required index page missing",
  );
  expect([...pages]).toEqual(before);
});

test("a partially written selected tree is unavailable while the previous snapshot stays valid", () => {
  const pages: Pages = new Map();
  const root = buildIndex(entries(1, 1000), pages, 8192);
  const next = prepareCopyOnWrite(root, entries(1001, 32), (hash) => pages.get(hash));
  // Fault after every page-write prefix, including zero and all writes. This is
  // preparation/visibility evidence, NOT the production SQL/R2 commit protocol.
  const staged = [...next.pages];
  for (let written = 0; written <= staged.length; written++) {
    const partial = new Map([...pages, ...staged.slice(0, written)]);
    expect(auditIndex(root, (hash) => partial.get(hash))).toEqual(ordered(entries(1, 1000)));
    if (written < staged.length)
      expect(() => auditIndex(next.root, (hash) => partial.get(hash))).toThrow();
    else
      expect(auditIndex(next.root, (hash) => partial.get(hash))).toEqual(ordered(entries(1, 1032)));
  }
});

test("run merges preserve all identities and old run visibility across binary carries", () => {
  const pages: Pages = new Map();
  let roots: (Descriptor | null)[] = [];
  const snapshots: { roots: (Descriptor | null)[]; count: number }[] = [];
  for (let batch = 0; batch < 16; batch++) {
    const next = prepareMergedRuns(roots, entries(batch * 64 + 1, 64), (hash) => pages.get(hash));
    publishPages(pages, next.pages);
    roots = next.roots;
    snapshots.push({ roots, count: (batch + 1) * 64 });
    expect(roots.filter(Boolean).length).toBe((batch + 1).toString(2).replaceAll("0", "").length);
  }
  for (const snapshot of snapshots) {
    expect(
      ordered(snapshot.roots.flatMap((root) => auditIndex(root, (hash) => pages.get(hash)))),
    ).toEqual(ordered(entries(1, snapshot.count)));
    expect(
      lookupRuns(snapshot.roots, experimentEntry(snapshot.count).key, (hash) => pages.get(hash)),
    ).toBe(BigInt(snapshot.count));
    expect(
      lookupRuns(snapshot.roots, experimentEntry(snapshot.count + 1).key, (hash) =>
        pages.get(hash),
      ),
    ).toBeNull();
  }
  const before = structuredClone([...pages]);
  expect(() => prepareMergedRuns(roots, entries(1, 1), (hash) => pages.get(hash))).toThrow(
    "duplicate identity",
  );
  expect([...pages]).toEqual(before);
  expect(() => prepareMergedRuns(roots, entries(1025, 1), () => undefined)).toThrow();
});

test("run lookup detects duplicate membership rather than selecting the first convenient match", () => {
  const pages: Pages = new Map();
  const root = buildIndex(entries(1, 1), pages, 8192);
  expect(() => lookupRuns([root, root], experimentEntry(1).key, (hash) => pages.get(hash))).toThrow(
    "duplicate identity across runs",
  );
});

test("deterministic mixed insertion order handles leading/trailing keys and repeated splits", () => {
  const input = entries(1, 1600).sort((a, b) => (a.key < b.key ? -1 : 1));
  for (const order of [input, [...input].reverse()]) {
    const pages: Pages = new Map();
    let root: Descriptor | null = null;
    for (const row of order) {
      const next = prepareCopyOnWrite(root, [row], (hash) => pages.get(hash));
      publishPages(pages, next.pages);
      root = next.root;
    }
    expect(auditIndex(root, (hash) => pages.get(hash))).toEqual(input);
  }
});

test("both measurement paths verify exact populations, prior generation, and retained byte accounting", () => {
  for (const method of ["copy-on-write", "sorted-runs"] as const) {
    const result = measureIncremental(method, 1000, 32);
    expect(result.verifiedRows).toBe(1000);
    expect(result.verifiedPriorRows).toBe(992);
    expect(result.generatedPageBytes).toBeGreaterThan(result.liveIndexBytes);
    expect(result.retainedGenerationBytes).toBeLessThanOrEqual(result.generatedPageBytes);
    expect(result.retainedGenerationBytes).toBeGreaterThanOrEqual(result.liveIndexBytes);
    expect(result.lookupCases).toBe(200);
    expect(result.productionReadinessProven).toBe(false);
  }
  expect(() => measureIncremental("copy-on-write", 30001, 32)).toThrow();
  expect(() =>
    prepareCopyOnWrite(null, [experimentEntry(1), experimentEntry(1)], () => undefined),
  ).toThrow();
  const empty = prepareCopyOnWrite(null, [], () => undefined);
  assert.equal(empty.root, null);
  expect(empty.pages.size).toBe(0);
});

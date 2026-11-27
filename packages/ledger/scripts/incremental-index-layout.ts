import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  auditIndex,
  buildIndex,
  experimentEntry,
  lookup,
  pageHash,
  readPage,
  writeExperimentPage,
  type Descriptor,
  type Entry,
  type PageReader,
  type Pages,
} from "./cold-index-layout.ts";

// Design experiment only. No production adapter, semantic admission or cloud writes.
// Keep the same 8 KiB layout for both algorithms. Old index generations are retained
// in this bounded experiment, not reclaimed or confused with canonical history.
const pageBytes = 8192;
const leafRows = 204;
const branchRows = 78;
const maxRows = 30_000;
function required<T>(value: T | undefined | null): T {
  assert.ok(value !== undefined && value !== null);
  return value;
}
function ordered(input: readonly Entry[]) {
  const rows = [...input].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (let i = 0; i < rows.length; i++) {
    const row = required(rows[i]);
    assert.ok(/^[0-9a-f]{64}$/.test(row.key) && row.sequence > 0n && row.sequence < 1n << 64n);
    assert.ok(i === 0 || required(rows[i - 1]).key < row.key, "duplicate identity");
  }
  return rows;
}
function partition<T>(items: T[], capacity: number): T[][] {
  const count = Math.ceil(items.length / capacity);
  if (count === 0) return [];
  // Balanced splits avoid repeated tiny rightmost pages after a one-row overflow.
  const width = Math.ceil(items.length / count);
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += width) groups.push(items.slice(i, i + width));
  return groups;
}

export function prepareCopyOnWrite(
  root: Descriptor | null,
  input: readonly Entry[],
  read: PageReader,
) {
  const rows = ordered(input);
  assert.ok(
    rows.length <= 4096 && (root?.count ?? 0n) + BigInt(rows.length) <= BigInt(maxRows),
    "experiment size budget",
  );
  const pages: Pages = new Map();
  const leaves = (values: Entry[]) =>
    partition(values, leafRows).map((part) => writeExperimentPage(part, [], pages));
  const branches = (values: Descriptor[]) =>
    partition(values, branchRows).map((part) => writeExperimentPage([], part, pages));
  const visit = (node: Descriptor, additions: Entry[], depth: number): Descriptor[] => {
    assert.ok(depth < 16, "depth budget");
    if (additions.length === 0) return [node];
    const page = readPage(node, read);
    if (page.children.length === 0) return leaves(ordered([...page.rows, ...additions]));
    const updated: Descriptor[] = [];
    let cursor = 0;
    page.children.forEach((child, index) => {
      const start = cursor;
      while (
        cursor < additions.length &&
        (required(additions[cursor]).key <= child.max || index === page.children.length - 1)
      )
        cursor++;
      updated.push(...visit(child, additions.slice(start, cursor), depth + 1));
    });
    assert.equal(cursor, additions.length);
    return branches(updated);
  };
  if (rows.length === 0) return { root, pages };
  let level = root === null ? leaves(rows) : visit(root, rows, 0);
  while (level.length > 1) level = branches(level);
  const selected = required(level[0]);
  assert.equal(selected.count, (root?.count ?? 0n) + BigInt(rows.length));
  return { root: selected, pages };
}

export type RunRoot = readonly (Descriptor | null)[];
export function lookupRuns(roots: RunRoot, key: string, read: PageReader) {
  let result: bigint | null = null;
  for (const root of roots) {
    const found = lookup(root, key, read);
    if (found !== null) {
      assert.equal(result, null, "duplicate identity across runs");
      result = found;
    }
  }
  return result;
}

export function prepareMergedRuns(roots: RunRoot, input: readonly Entry[], read: PageReader) {
  let rows = ordered(input);
  assert.ok(
    rows.length <= 4096 &&
      roots.reduce((sum, root) => sum + (root?.count ?? 0n), 0n) + BigInt(rows.length) <=
        BigInt(maxRows),
    "experiment size budget",
  );
  for (const row of rows)
    assert.equal(lookupRuns(roots, row.key, read), null, "duplicate identity");
  const selected = [...roots];
  const pages: Pages = new Map();
  if (rows.length === 0) return { roots: selected, pages };
  let level = 0;
  while (selected[level]) {
    // Bulk merge oracle, not a production streaming merge implementation.
    rows = ordered([...auditIndex(required(selected[level]), read), ...rows]);
    selected[level] = null;
    level++;
  }
  selected[level] = buildIndex(rows, pages, pageBytes);
  return { roots: selected, pages };
}

export function measureIncremental(
  method: "copy-on-write" | "sorted-runs",
  count: number,
  batchSize: number,
) {
  assert.ok(Number.isSafeInteger(count) && count > 0 && count <= maxRows);
  assert.ok(Number.isSafeInteger(batchSize) && batchSize > 0 && batchSize <= 4096);
  const pages: Pages = new Map();
  let roots: (Descriptor | null)[] = [];
  let bytesWritten = 0;
  let pagesWritten = 0;
  let bytesRead = 0;
  let pageReads = 0;
  let maxBatchBytes = 0;
  let maxBatchReads = 0;
  let priorRoots: (Descriptor | null)[] = [];
  let priorCount = 0;
  const read: PageReader = (hash) => {
    const bytes = pages.get(hash);
    assert.ok(bytes, "missing measurement page");
    bytesRead += bytes.length;
    pageReads++;
    return bytes;
  };
  const started = performance.now();
  for (let offset = 0; offset < count; offset += batchSize) {
    const batch = Array.from({ length: Math.min(batchSize, count - offset) }, (_, i) =>
      experimentEntry(offset + i + 1),
    );
    const beforeReads = pageReads;
    const prepared =
      method === "copy-on-write"
        ? (() => {
            const next = prepareCopyOnWrite(roots[0] ?? null, batch, read);
            return { roots: [next.root], pages: next.pages };
          })()
        : prepareMergedRuns(roots, batch, read);
    let batchBytes = 0;
    for (const [hash, bytes] of prepared.pages) {
      assert.equal(pageHash(bytes), hash);
      batchBytes += bytes.length;
      pages.set(hash, bytes);
    }
    bytesWritten += batchBytes;
    pagesWritten += prepared.pages.size;
    maxBatchBytes = Math.max(maxBatchBytes, batchBytes);
    maxBatchReads = Math.max(maxBatchReads, pageReads - beforeReads);
    priorRoots = roots;
    priorCount = offset;
    roots = prepared.roots;
    assert.ok(process.memoryUsage.rss() <= 1024 ** 3, "experiment RSS budget");
  }
  const updateMs = performance.now() - started;
  const snapshot = { pageReads, bytesRead };
  const all = ordered(roots.flatMap((root) => auditIndex(root, read)));
  const expected = ordered(Array.from({ length: count }, (_, i) => experimentEntry(i + 1)));
  assert.deepEqual(all, expected);
  assert.deepEqual(
    ordered(priorRoots.flatMap((root) => auditIndex(root, read))),
    ordered(expected.filter((row) => row.sequence <= BigInt(priorCount))),
  );
  const live = new Set<string>();
  for (const root of roots)
    auditIndex(root, (hash) => {
      live.add(hash);
      return pages.get(hash);
    });
  let probeMaxReads = 0;
  for (let i = 0; i < 200; i++) {
    const row = experimentEntry(i < 100 ? 1 + Math.floor((i * count) / 100) : count + i + 1);
    const before = pageReads;
    assert.equal(lookupRuns(roots, row.key, read), i < 100 ? row.sequence : null);
    probeMaxReads = Math.max(probeMaxReads, pageReads - before);
  }
  return {
    method,
    count,
    batchSize,
    pageBytes,
    updateMs,
    generatedPageBytes: bytesWritten,
    generatedPages: pagesWritten,
    updateReadBytes: snapshot.bytesRead,
    updatePageReads: snapshot.pageReads,
    maximumBatchWriteBytes: maxBatchBytes,
    maximumBatchPageReads: maxBatchReads,
    retainedGenerationBytes: [...pages.values()].reduce((sum, bytes) => sum + bytes.length, 0),
    liveIndexBytes: [...live].reduce((sum, hash) => sum + required(pages.get(hash)).length, 0),
    verifiedRows: all.length,
    verifiedPriorRows: priorCount,
    lookupCases: 200,
    maximumPagesPerTestedLookup: probeMaxReads,
    rssBytesWithRetainedGenerationsAndOracle: process.memoryUsage.rss(),
    productionReadinessProven: false,
  };
}

if (import.meta.main) {
  if (process.argv[2] === "--sample") {
    const method = process.argv[3];
    assert.ok(method === "copy-on-write" || method === "sorted-runs");
    console.log(
      JSON.stringify(measureIncremental(method, Number(process.argv[4]), Number(process.argv[5]))),
    );
    process.exit(0);
  }
  const scenarios = [
    [10000, 1],
    [10000, 32],
    [10000, 256],
    [30000, 32],
    [30000, 256],
  ];
  const results = ["copy-on-write", "sorted-runs"].flatMap((method) =>
    scenarios.map(([count, batch]) => {
      const child = Bun.spawnSync(
        [process.execPath, import.meta.filename, "--sample", method, String(count), String(batch)],
        { timeout: 45_000 },
      );
      assert.equal(child.exitCode, 0, child.stderr.toString());
      const result = JSON.parse(child.stdout.toString());
      assert.equal(result.verifiedRows, count);
      assert.equal(result.method, method);
      assert.equal(result.batchSize, batch);
      return result;
    }),
  );
  console.log(
    JSON.stringify(
      {
        schema: "rastrata-incremental-index-experiment-v1",
        bun: Bun.version,
        sourceHashes: ["incremental-index-layout.ts", "cold-index-layout.ts"].map((path) => ({
          path,
          sha256: pageHash(readFileSync(`${import.meta.dir}/${path}`)),
        })),
        results,
        completed: true,
        productionReadinessProven: false,
        limitations: [
          "Local in-memory synthetic index batches, not accounting commands or R2 requests.",
          "All generated index pages retained; no production GC, encryption, canonical payloads or durable publication.",
          "Sorted-run merges materialize inputs in RAM; no bounded streaming merge or maintenance scheduler implemented.",
          "Fresh process per sample with 45-second timeout and per-batch <=1 GiB RSS checks; timings include generation and preparation, not network.",
        ],
      },
      null,
      2,
    ),
  );
}

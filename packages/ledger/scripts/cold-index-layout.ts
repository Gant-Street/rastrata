import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import { planPermanentIdentities } from "./permanent-identity-plan.ts";
import { workloadProfiles } from "./workload-plan.ts";

// Read-only physical-layout experiment. Not exported by the ledger, not a storage
// adapter, and not an approved codec. Bulk construction retains all entries in RAM.
// An authoritative producer/anchored root is a precondition: hashes do not prove
// that the producer indexed every canonical identity or that an old root is current.
export type Entry = { key: string; sequence: bigint };
export type Descriptor = { hash: string; min: string; max: string; count: bigint };
export type Pages = Map<string, Uint8Array>;
export type PageReader = (hash: string) => Uint8Array | undefined;
const header = 9;
const leafWidth = 40;
const childWidth = 104;
const maxBytes = 32_768;
const maxRows = 300_000;
const maxDepth = 16;
const magic = [82, 73, 88, 49]; // RIX1: experiment-only domain/version
const hex = /^[0-9a-f]{64}$/;
const u64max = (1n << 64n) - 1n;
export const leafCapacity = Math.floor((maxBytes - header) / leafWidth);
export const branchCapacity = Math.floor((maxBytes - header) / childWidth);

// Exact shape for this fully packed bulk format, not an incremental-storage bound.
export function packedShape(rows: bigint, pageBytes = maxBytes) {
  assert.ok(rows >= 0n && rows <= u64max, "invalid shape population");
  assert.ok([4_096, 8_192, maxBytes].includes(pageBytes), "experiment page size");
  const leafRows = BigInt(Math.floor((pageBytes - header) / leafWidth));
  const branchRows = BigInt(Math.floor((pageBytes - header) / childWidth));
  let level = (rows + leafRows - 1n) / leafRows;
  const levels = rows === 0n ? [] : [level];
  let bytes = rows * BigInt(leafWidth) + level * BigInt(header);
  while (level > 1n) {
    const parent = (level + branchRows - 1n) / branchRows;
    bytes += level * BigInt(childWidth) + parent * BigInt(header);
    levels.push(parent);
    level = parent;
  }
  return {
    levels,
    depth: levels.length,
    pages: levels.reduce((sum, count) => sum + count, 0n),
    bytes,
  };
}

function required<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}

export function pageHash(bytes: Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}
function view(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function putKey(bytes: Uint8Array, offset: number, key: string) {
  assert.ok(hex.test(key), "invalid key");
  bytes.set(Buffer.from(key, "hex"), offset);
}
function getKey(bytes: Uint8Array, offset: number) {
  return Buffer.from(bytes.subarray(offset, offset + 32)).toString("hex");
}
function allocate(branch: boolean, count: number) {
  const bytes = new Uint8Array(header + count * (branch ? childWidth : leafWidth));
  assert.ok(bytes.length <= maxBytes);
  bytes.set(magic);
  bytes[4] = branch ? 1 : 0;
  view(bytes).setUint32(5, count, false);
  return bytes;
}
function store(pages: Pages, bytes: Uint8Array, min: string, max: string, count: bigint) {
  const hash = pageHash(bytes);
  pages.set(hash, bytes);
  return { hash, min, max, count };
}

export function buildIndex(
  input: readonly Entry[],
  pages: Pages,
  pageBytes = maxBytes,
): Descriptor | null {
  assert.ok(input.length <= maxRows, "experiment row budget");
  assert.ok([4_096, 8_192, maxBytes].includes(pageBytes), "experiment page size");
  const leafRows = Math.floor((pageBytes - header) / leafWidth);
  const branchRows = Math.floor((pageBytes - header) / childWidth);
  const entries = [...input].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (let i = 0; i < entries.length; i++) {
    const row = required(entries[i]);
    assert.ok(hex.test(row.key), "invalid key");
    assert.ok(row.sequence > 0n && row.sequence <= u64max, "invalid sequence");
    assert.ok(
      i === 0 || required(entries[i - 1]).key < row.key,
      "duplicate key or digest collision",
    );
  }
  let level: Descriptor[] = [];
  for (let start = 0; start < entries.length; start += leafRows) {
    const slice = entries.slice(start, start + leafRows);
    const bytes = allocate(false, slice.length);
    slice.forEach((row, index) => {
      const offset = header + index * leafWidth;
      putKey(bytes, offset, row.key);
      view(bytes).setBigUint64(offset + 32, row.sequence, false);
    });
    level.push(
      store(pages, bytes, required(slice[0]).key, required(slice.at(-1)).key, BigInt(slice.length)),
    );
  }
  while (level.length > 1) {
    const next: Descriptor[] = [];
    for (let start = 0; start < level.length; start += branchRows) {
      const slice = level.slice(start, start + branchRows);
      const bytes = allocate(true, slice.length);
      slice.forEach((child, index) => {
        const offset = header + index * childWidth;
        putKey(bytes, offset, child.min);
        putKey(bytes, offset + 32, child.max);
        putKey(bytes, offset + 64, child.hash);
        view(bytes).setBigUint64(offset + 96, child.count, false);
      });
      next.push(
        store(
          pages,
          bytes,
          required(slice[0]).min,
          required(slice.at(-1)).max,
          slice.reduce((sum, child) => sum + child.count, 0n),
        ),
      );
    }
    level = next;
  }
  return level[0] ?? null;
}

export function readPage(expected: Descriptor, read: PageReader) {
  const bytes = read(expected.hash);
  assert.ok(bytes, "required index page missing");
  assert.ok(bytes.length >= header && bytes.length <= maxBytes, "invalid page length");
  assert.equal(pageHash(bytes), expected.hash, "index page hash mismatch");
  assert.ok(
    magic.every((byte, index) => bytes[index] === byte),
    "unsupported index format",
  );
  const kind = bytes[4];
  assert.ok(kind === 0 || kind === 1, "invalid page kind");
  const count = view(bytes).getUint32(5, false);
  assert.ok(count > 0, "empty page");
  assert.equal(bytes.length, header + count * (kind === 1 ? childWidth : leafWidth));
  const rows: Entry[] = [];
  const children: Descriptor[] = [];
  let population = 0n;
  let previousMax: string | undefined;
  for (let i = 0; i < count; i++) {
    const offset = header + i * (kind === 1 ? childWidth : leafWidth);
    const min = getKey(bytes, offset);
    const max: string = kind === 1 ? getKey(bytes, offset + 32) : min;
    assert.ok(min <= max && (previousMax === undefined || previousMax < min), "invalid key order");
    previousMax = max;
    if (kind === 1) {
      const childCount = view(bytes).getBigUint64(offset + 96, false);
      assert.ok(childCount > 0n, "empty child");
      children.push({ min, max, hash: getKey(bytes, offset + 64), count: childCount });
      population += childCount;
    } else {
      const sequence = view(bytes).getBigUint64(offset + 32, false);
      assert.ok(sequence > 0n, "invalid sequence");
      rows.push({ key: min, sequence });
      population++;
    }
  }
  assert.equal(population, expected.count, "population mismatch");
  assert.equal(
    kind === 1 ? required(children[0]).min : required(rows[0]).key,
    expected.min,
    "lower fence mismatch",
  );
  assert.equal(previousMax, expected.max, "upper fence mismatch");
  return { rows, children };
}

// Shared only by the incremental design experiment. The original bulk writer above
// is retained as an independent byte/shape comparison path.
export function writeExperimentPage(
  rows: Entry[],
  children: Descriptor[],
  pages: Pages,
): Descriptor {
  assert.ok(rows.length > 0 !== children.length > 0, "one nonempty page kind required");
  const bytes = allocate(children.length > 0, rows.length || children.length);
  rows.forEach((row, index) => {
    const offset = header + index * leafWidth;
    putKey(bytes, offset, row.key);
    view(bytes).setBigUint64(offset + 32, row.sequence, false);
  });
  children.forEach((child, index) => {
    const offset = header + index * childWidth;
    putKey(bytes, offset, child.min);
    putKey(bytes, offset + 32, child.max);
    putKey(bytes, offset + 64, child.hash);
    view(bytes).setBigUint64(offset + 96, child.count, false);
  });
  const descriptor = store(
    pages,
    bytes,
    rows.length ? required(rows[0]).key : required(children[0]).min,
    rows.length ? required(rows.at(-1)).key : required(children.at(-1)).max,
    rows.length ? BigInt(rows.length) : children.reduce((sum, child) => sum + child.count, 0n),
  );
  readPage(descriptor, (hash) => pages.get(hash));
  return descriptor;
}

// Absence is relative to this verified, trusted root, not to untrusted object-list
// results. Missing required pages throw; they never become an absent key.
export function lookup(root: Descriptor | null, key: string, read: PageReader): bigint | null {
  assert.ok(hex.test(key), "invalid key");
  let current = root;
  for (let depth = 0; current !== null; depth++) {
    assert.ok(depth < maxDepth, "index depth budget");
    const page = readPage(current, read);
    if (page.children.length === 0)
      return page.rows.find((row) => row.key === key)?.sequence ?? null;
    current = page.children.find((child) => child.min <= key && key <= child.max) ?? null;
  }
  return null;
}

// Deliberately separate from lookup: a healthy path does NOT verify untouched pages.
export function auditIndex(root: Descriptor | null, read: PageReader): Entry[] {
  const entries: Entry[] = [];
  const visit = (current: Descriptor, depth: number) => {
    assert.ok(depth < maxDepth, "index depth budget");
    const page = readPage(current, read);
    entries.push(...page.rows);
    for (const child of page.children) visit(child, depth + 1);
  };
  if (root !== null) visit(root, 0);
  return entries;
}

export function experimentEntry(sequence: number): Entry {
  assert.ok(Number.isSafeInteger(sequence) && sequence > 0);
  return {
    key: pageHash(new TextEncoder().encode(`cold-index:${sequence}`)),
    sequence: BigInt(sequence),
  };
}

export function measureColdIndex(rows: number, pageBytes = maxBytes) {
  assert.ok(Number.isSafeInteger(rows) && rows > 0 && rows <= maxRows);
  const input = Array.from({ length: rows }, (_, i) => experimentEntry(i + 1));
  const pages: Pages = new Map();
  const started = performance.now();
  const root = buildIndex(input, pages, pageBytes);
  const buildMs = performance.now() - started;
  const audited = auditIndex(root, (hash) => pages.get(hash));
  assert.deepEqual(
    audited,
    [...input].sort((a, b) => (a.key < b.key ? -1 : 1)),
  );
  const shape = packedShape(BigInt(rows), pageBytes);
  assert.equal(BigInt(pages.size), shape.pages);
  assert.equal(
    BigInt([...pages.values()].reduce((sum, bytes) => sum + bytes.length, 0)),
    shape.bytes,
  );
  let readBytes = 0;
  let reads = 0;
  let maxReads = 0;
  let maxReadBytes = 0;
  // Deterministic spaced hits plus independently generated absent keys, no cache.
  const probes = Math.min(rows, 1_000);
  for (let i = 0; i < probes; i++) {
    for (const hit of [true, false]) {
      const row = experimentEntry(hit ? 1 + Math.floor((i * rows) / probes) : rows + 1 + i);
      let pathReads = 0;
      let pathBytes = 0;
      const result = lookup(root, row.key, (hash) => {
        const bytes = pages.get(hash);
        assert.ok(bytes);
        readBytes += bytes.length;
        pathBytes += bytes.length;
        pathReads++;
        return bytes;
      });
      assert.equal(result, hit ? row.sequence : null);
      reads += pathReads;
      maxReads = Math.max(maxReads, pathReads);
      maxReadBytes = Math.max(maxReadBytes, pathBytes);
    }
  }
  return {
    rows,
    configuredPageBytes: pageBytes,
    pageCount: pages.size,
    pageBytes: [...pages.values()].reduce((sum, bytes) => sum + bytes.length, 0),
    root,
    buildMs,
    totalMs: performance.now() - started,
    verifiedRows: audited.length,
    lookupCases: probes * 2,
    uncachedPageReads: reads,
    uncachedReadBytes: readBytes,
    maximumPagesPerLookup: maxReads,
    maximumBytesPerLookup: maxReadBytes,
    rssBytesIncludingBuilderAndOracle: process.memoryUsage.rss(),
    productionExecutionVerified: false,
  };
}

if (import.meta.main) {
  if (process.argv[2] === "--sample") {
    const result = measureColdIndex(Number(process.argv[3]), Number(process.argv[4]));
    assert.ok(result.rssBytesIncludingBuilderAndOracle <= 1024 ** 3, "experiment end-RSS budget");
    console.log(
      JSON.stringify(result, (_key, value: unknown) =>
        typeof value === "bigint" ? String(value) : value,
      ),
    );
    process.exit(0);
  }
  const results = [4_096, 8_192, maxBytes].flatMap((pageBytes) =>
    [10_000, 100_000, 300_000].map((rows) => {
      // Fresh process per sample: a previous run's retained heap is not this layout's memory.
      const child = Bun.spawnSync(
        [process.execPath, import.meta.filename, "--sample", String(rows), String(pageBytes)],
        { timeout: 30_000 },
      );
      assert.equal(child.exitCode, 0, `sample failed: ${child.stderr.toString()}`);
      const result = JSON.parse(child.stdout.toString());
      assert.equal(result.rows, rows);
      assert.equal(result.verifiedRows, rows);
      assert.equal(result.configuredPageBytes, pageBytes);
      assert.equal(result.productionExecutionVerified, false);
      return result;
    }),
  );
  console.log(
    JSON.stringify(
      {
        schema: "rastrata-cold-index-layout-experiment-v1",
        sourceSha256: pageHash(readFileSync(import.meta.filename)),
        planningSourceHashes: ["permanent-identity-plan.ts", "workload-plan.ts"].map((path) => ({
          path,
          sha256: pageHash(readFileSync(`${import.meta.dir}/${path}`)),
        })),
        bun: Bun.version,
        environment: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
        leafCapacity,
        branchCapacity,
        maximumPageBytes: maxBytes,
        sampling:
          "Fresh subprocess per layout/size; 30-second process timeout; <=1 GiB end-RSS check (not peak memory monitoring). Timings exclude input generation and process startup.",
        results,
        unexecutedPackedShapes: [4_096, 8_192, maxBytes].flatMap((pageBytes) =>
          [1, 2].map((scale) => {
            const plan = planPermanentIdentities(required(workloadProfiles[1]), scale);
            return {
              profile: plan.profileId,
              scale,
              configuredPageBytes: pageBytes,
              logicalIdentities: plan.minimumLogicalKeys,
              ...packedShape(plan.minimumLogicalKeys, pageBytes),
              measuredAtTargetVolume: false,
            };
          }),
        ),
        limitations: [
          "In-memory bulk-built static index; no incremental insertion, compaction, durable publication or network calls.",
          "Lookup trusts an externally anchored root produced from complete canonical inputs; untouched missing pages require full audit.",
          "Digests locate original records; original IDs, book/head binding and historical content must still be checked by a production reader.",
          "No secondary-range index, live-state bytes, encryption, object overhead, old index generations or canonical history included.",
          "Local page counts/bytes are not R2 latency, cost, Workers memory, or target-volume execution.",
        ],
        completed: true,
        productionReadinessProven: false,
      },
      (_key, value: unknown) => (typeof value === "bigint" ? String(value) : value),
      2,
    ),
  );
}

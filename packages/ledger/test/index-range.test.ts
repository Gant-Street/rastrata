import { expect, test } from "bun:test";
import {
  createIndexRoot,
  encodeIndexPage,
  scanIndexRange,
  enumerateIndexPages,
  type IndexEntry,
  type IndexRangeBatch,
} from "../src/index-pages.ts";

const key = (n: number) => n.toString(16).padStart(64, "0");
function fixture(leaves = 120, perLeaf = 100) {
  let issued = 0;
  const pages = new Map<string, Uint8Array>();
  const source: IndexEntry[] = [];
  const add = (rows: IndexEntry[], children: Parameters<typeof encodeIndexPage>[2] = []) => {
    const page = encodeIndexPage(`derived/${key(++issued)}`, rows, children);
    pages.set(page.descriptor.page.location, page.bytes);
    return page.descriptor;
  };
  let level = Array.from({ length: leaves }, (_, leaf) => {
    const rows = Array.from({ length: perLeaf }, (_, row) => ({
      key: key(2 * (leaf * perLeaf + row + 1)),
      sequence: BigInt(leaf * perLeaf + row + 1),
    }));
    source.push(...rows);
    return add(rows);
  });
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 58) next.push(add([], level.slice(i, i + 58)));
    level = next;
  }
  const page = level[0];
  if (!page) throw new Error("Missing fixture tree");
  const root = createIndexRoot(BigInt(source.length), page.page);
  return { pages, source, root, read: async (id: string) => pages.get(id) };
}

test("bounded range traversal returns exact half-open boundaries with no full-tree scan", async () => {
  const f = fixture();
  const full = await Array.fromAsync(
    scanIndexRange(f.root, f.root.contentHash, null, null, f.read, 128),
  );
  expect(full.flatMap((batch) => batch.entries)).toEqual(f.source);
  expect(full.at(-1)?.matchedThrough).toBe(12_000n);
  expect(full.at(-1)?.pagesRead).toBe(124n);
  expect(full.at(-1)?.bytesRead).toBe(
    [...f.pages.values()].reduce((sum, bytes) => sum + BigInt(bytes.length), 0n),
  );
  expect(full.at(-1)?.complete).toBe(true);
  expect(full.slice(0, -1).every((batch) => !batch.complete && batch.entries.length === 128)).toBe(
    true,
  );
  const narrow = await Array.fromAsync(
    scanIndexRange(f.root, f.root.contentHash, key(10002), key(10012), f.read, 2),
  );
  expect(narrow.flatMap((batch) => batch.entries)).toEqual(
    f.source.filter((entry) => entry.key >= key(10002) && entry.key < key(10012)),
  );
  expect(narrow.map((batch) => batch.complete)).toEqual([false, false, true]);
  expect(narrow.map((batch) => batch.matchedThrough)).toEqual([2n, 4n, 5n]);
  expect(narrow.at(-1)?.pagesRead).toBe(3n);
  expect(
    narrow.every(
      (batch) =>
        Object.isFrozen(batch) &&
        Object.isFrozen(batch.entries) &&
        batch.entries.every(Object.isFrozen),
    ),
  ).toBe(true);
});

test("range bounds and seeded intervals agree with an independent complete population", async () => {
  const f = fixture(5, 13);
  let state = 12345;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  for (let n = 0; n < 100; n++) {
    const a = random() % 160,
      b = random() % 160;
    const lower = key(Math.min(a, b)),
      upper = key(Math.max(a, b));
    const batches = await Array.fromAsync(
      scanIndexRange(f.root, f.root.contentHash, lower, upper, f.read, 1 + (random() % 17)),
    );
    const expected = f.source.filter((entry) => entry.key >= lower && entry.key < upper);
    expect(batches.flatMap((batch) => batch.entries)).toEqual(expected);
    expect(batches.at(-1)?.matchedThrough).toBe(BigInt(expected.length));
    expect(batches.at(-1)?.complete).toBe(true);
  }
  const before = await Array.fromAsync(
    scanIndexRange(f.root, f.root.contentHash, null, key(2), f.read),
  );
  expect(before[0]?.entries).toEqual([]);
  const tail = await Array.fromAsync(
    scanIndexRange(f.root, f.root.contentHash, key(130), null, f.read),
  );
  expect(tail[0]?.entries).toEqual([f.source.at(-1) as IndexEntry]);
});

test("empty intervals and the explicit empty root complete without reads; invalid bounds fail before I/O", async () => {
  const f = fixture(1, 2);
  let reads = 0;
  const read = async () => {
    reads++;
    return undefined;
  };
  const empty = createIndexRoot(0n, null);
  for (const [root, lower, upper] of [
    [f.root, key(2), key(2)],
    [empty, null, null],
  ] as const) {
    const batches = await Array.fromAsync(
      scanIndexRange(root, root.contentHash, lower, upper, read),
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      entries: [],
      complete: true,
      pagesRead: 0n,
      matchedThrough: 0n,
    });
  }
  for (const size of [0, -1, 257, 1.5, Number.NaN])
    expect(() => scanIndexRange(f.root, f.root.contentHash, null, null, read, size)).toThrow(
      "index_range_batch_invalid",
    );
  expect(() => scanIndexRange(f.root, f.root.contentHash, key(3), key(2), read)).toThrow(
    "index_range_invalid",
  );
  expect(() => scanIndexRange(f.root, f.root.contentHash, "bad", null, read)).toThrow(
    "index_page_digest_invalid",
  );
  expect(reads).toBe(0);
});

test("missing required suffix never yields completeness, while unrelated damage is not a range-health claim", async () => {
  const f = fixture(3, 4);
  f.pages.delete(`derived/${key(3)}`);
  const partial = scanIndexRange(f.root, f.root.contentHash, null, null, f.read, 2);
  const delivered: IndexRangeBatch[] = [];
  await expect(
    (async () => {
      for await (const batch of partial) delivered.push(batch);
    })(),
  ).rejects.toThrow("index_page_missing_or_short");
  expect(delivered.length).toBeGreaterThan(0);
  expect(delivered.every((batch) => !batch.complete)).toBe(true);
  const unaffected = await Array.fromAsync(
    scanIndexRange(f.root, f.root.contentHash, key(2), key(4), f.read),
  );
  expect(unaffected[0]?.entries).toEqual([f.source[0] as IndexEntry]);
  expect(unaffected[0]?.complete).toBe(true);
  await expect(
    Array.fromAsync(enumerateIndexPages(f.root, f.root.contentHash, f.read)),
  ).rejects.toThrow("index_page_missing_or_short");
});

test("required byte, child-fence and population corruption fails closed", async () => {
  const leaf = encodeIndexPage(`derived/${key(1)}`, [{ key: key(2), sequence: 1n }]);
  for (const [child, error] of [
    [{ ...leaf.descriptor, max: key(4) }, "index_page_fence_mismatch"],
    [{ ...leaf.descriptor, population: 2n }, "index_page_population_mismatch"],
  ] as const) {
    const parent = encodeIndexPage(`derived/${key(2)}`, [], [child]);
    const root = createIndexRoot(child.population, parent.descriptor.page);
    await expect(
      Array.fromAsync(
        scanIndexRange(root, root.contentHash, null, null, async (id) =>
          id === parent.descriptor.page.location ? parent.bytes : leaf.bytes,
        ),
      ),
    ).rejects.toThrow(error);
  }
  const root = createIndexRoot(1n, leaf.descriptor.page);
  const damaged = leaf.bytes.slice();
  damaged[damaged.length - 1] = 2;
  await expect(
    Array.fromAsync(scanIndexRange(root, root.contentHash, null, null, async () => damaged)),
  ).rejects.toThrow("index_page_hash_mismatch");
  await expect(
    Array.fromAsync(
      scanIndexRange(root, root.contentHash, null, null, async () => {
        throw new Error("store unavailable");
      }),
    ),
  ).rejects.toThrow("store unavailable");
});

test("captured root is immutable through queued I/O and cancellation does not read the remaining tree", async () => {
  const f = fixture(5, 4);
  const mutable = { ...f.root };
  let reads = 0;
  const iterator = scanIndexRange(
    mutable,
    f.root.contentHash,
    null,
    null,
    async (id) => {
      reads++;
      return f.pages.get(id);
    },
    1,
  );
  mutable.population = "999";
  const first = await iterator.next();
  expect(first.done).toBe(false);
  expect(first.value?.complete).toBe(false);
  expect(first.value?.entries).toEqual([f.source[0] as IndexEntry]);
  const beforeCancel = reads;
  await iterator.return(undefined);
  expect(reads).toBe(beforeCancel);
  expect(reads).toBeLessThan(f.pages.size);
});

test("maximum key and depth boundaries do not truncate a range or silently omit a required descendant", async () => {
  const highest = "f".repeat(64);
  const leaf = encodeIndexPage(`derived/${key(1)}`, [
    { key: key(0), sequence: 1n },
    { key: highest, sequence: 2n },
  ]);
  const root = createIndexRoot(2n, leaf.descriptor.page);
  expect(
    (
      await Array.fromAsync(
        scanIndexRange(root, root.contentHash, highest, null, async () => leaf.bytes, 1),
      )
    )[0]?.entries,
  ).toEqual([{ key: highest, sequence: 2n }]);
  expect(
    (
      await Array.fromAsync(
        scanIndexRange(root, root.contentHash, null, highest, async () => leaf.bytes, 1),
      )
    )[0]?.entries,
  ).toEqual([{ key: key(0), sequence: 1n }]);
  const pages = new Map([[leaf.descriptor.page.location, leaf.bytes]]);
  let descriptor = leaf.descriptor;
  for (let i = 2; i <= 17; i++) {
    const parent = encodeIndexPage(`derived/${key(i)}`, [], [descriptor]);
    pages.set(parent.descriptor.page.location, parent.bytes);
    descriptor = parent.descriptor;
    const current = createIndexRoot(2n, descriptor.page);
    if (i === 16)
      expect(
        (
          await Array.fromAsync(
            scanIndexRange(current, current.contentHash, null, null, async (id) => pages.get(id)),
          )
        )[0]?.entries,
      ).toHaveLength(2);
    if (i === 17)
      await expect(
        Array.fromAsync(
          scanIndexRange(current, current.contentHash, null, null, async (id) => pages.get(id)),
        ),
      ).rejects.toThrow("index_page_depth_exceeded");
  }
});

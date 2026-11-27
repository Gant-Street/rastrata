import { expect, test } from "bun:test";
import {
  auditBalancedIndex,
  createIndexRoot,
  encodeIndexPage,
  enumerateIndexPages,
  prepareIndexInsert,
  verifyIndexPageBytes,
  type BalancedIndex,
  type IndexEntry,
  type IndexRoot,
} from "../src/index-pages.ts";

const key = (n: number) => n.toString(16).padStart(64, "0");
const location = (n: number) => `derived/${key(n)}`;
const entry = (n: number): IndexEntry => ({ key: key(n), sequence: BigInt(n + 1) });
type Page = ReturnType<typeof encodeIndexPage>;
function fixture(initial: Page[] = []) {
  const pages = new Map(initial.map((p) => [p.descriptor.page.location, p.bytes]));
  let next = 100_000;
  const allocated: string[] = [];
  return {
    pages,
    allocated,
    read: async (id: string) => pages.get(id),
    allocate() {
      const id = location(next++);
      allocated.push(id);
      return id;
    },
    save(prepared: readonly Page[]) {
      for (const p of prepared) {
        if (pages.has(p.descriptor.page.location)) throw new Error("test allocator reused ID");
        pages.set(p.descriptor.page.location, p.bytes.slice());
      }
    },
  };
}
async function collect(root: IndexRoot, read: ReturnType<typeof fixture>["read"]) {
  return Array.fromAsync(enumerateIndexPages(root, root.contentHash, read));
}
const sorted = (rows: IndexEntry[]) => rows.sort((a, b) => a.key.localeCompare(b.key));
function fullLeaf() {
  return encodeIndexPage(
    location(1),
    Array.from({ length: 204 }, (_, n) => entry(n * 2)),
  );
}

test("COW insertion from empty through shuffled splits matches an independent set and preserves old roots", async () => {
  const f = fixture();
  const empty = createIndexRoot(0n, null);
  let index = await auditBalancedIndex(empty, empty.contentHash, f.read);
  const expected: IndexEntry[] = [];
  const snapshots: { root: IndexRoot; entries: IndexEntry[] }[] = [];
  for (let i = 0; i < 500; i++) {
    // 173 is coprime to 500: deterministic permutation, not sorted insertion.
    const row = entry((i * 173) % 500);
    const before = new Map([...f.pages].map(([id, bytes]) => [id, bytes.slice()]));
    const plan = await prepareIndexInsert(index, row, f.read, f.allocate);
    expect(plan.before).toBe(index.root);
    expect(plan.after.population).toBe(String(i + 1));
    expect(plan.pagesRead).toBe(index.height);
    expect(plan.pages.length).toBeLessThanOrEqual(2 * index.height + 1);
    expect(plan.bytesPrepared).toBe(plan.pages.reduce((sum, page) => sum + page.bytes.length, 0));
    expect(Object.isFrozen(plan.index)).toBe(true);
    expect([...f.pages]).toEqual([...before]); // Preparation has no persistence side effect.
    f.save(plan.pages);
    index = plan.index;
    expected.push(row);
    if ([0, 203, 204, 499].includes(i)) {
      const entries = sorted([...expected]);
      expect(await collect(index.root, f.read)).toEqual(entries);
      expect((await auditBalancedIndex(index.root, index.root.contentHash, f.read)).height).toBe(
        index.height,
      );
      snapshots.push({ root: index.root, entries });
    }
  }
  expect(await collect(empty, f.read)).toEqual([]);
  for (const snapshot of snapshots)
    expect(await collect(snapshot.root, f.read)).toEqual(snapshot.entries);
});

test("duplicate identity, invalid input and fabricated layout reject before allocation", async () => {
  const leaf = fullLeaf(),
    f = fixture([leaf]);
  const root = createIndexRoot(204n, leaf.descriptor.page);
  const index = await auditBalancedIndex(root, root.contentHash, f.read);
  for (const sequence of [1n, 999n])
    await expect(
      prepareIndexInsert(index, { key: key(0), sequence }, f.read, f.allocate),
    ).rejects.toThrow("index_identity_exists");
  await expect(
    prepareIndexInsert(index, { key: "bad", sequence: 1n }, f.read, f.allocate),
  ).rejects.toThrow("index_page_digest_invalid");
  for (const sequence of [0n, -1n, 1n << 64n])
    await expect(
      prepareIndexInsert(index, { key: key(1), sequence }, f.read, f.allocate),
    ).rejects.toThrow("index_page_counter_invalid");
  for (const candidate of [null, {}, { root, height: 1 }, { ...index, height: 16 }])
    await expect(
      prepareIndexInsert(candidate as BalancedIndex, entry(1), f.read, f.allocate),
    ).rejects.toThrow("index_layout_unverified");
  await expect(
    prepareIndexInsert(index, { ...entry(1), extra: true } as IndexEntry, f.read, f.allocate),
  ).rejects.toThrow("index_page_shape_invalid");
  expect(f.allocated).toEqual([]);
});

test("full leaf and branch split copies only the affected path and grows a balanced root", async () => {
  const leaves = Array.from({ length: 58 }, (_, block) =>
    encodeIndexPage(
      location(block + 1),
      Array.from({ length: 204 }, (_, n) => entry((block * 204 + n) * 2)),
    ),
  );
  const parent = encodeIndexPage(
    location(59),
    [],
    leaves.map((p) => p.descriptor),
  );
  const f = fixture([...leaves, parent]);
  const root = createIndexRoot(11_832n, parent.descriptor.page);
  const index = await auditBalancedIndex(root, root.contentHash, f.read);
  const visited: string[] = [];
  const plan = await prepareIndexInsert(
    index,
    entry(23_664),
    async (id) => {
      visited.push(id);
      return f.read(id);
    },
    f.allocate,
  );
  expect(visited).toEqual([location(59), location(58)]);
  expect(plan.pagesRead).toBe(2);
  expect(plan.bytesRead).toBe(parent.bytes.length + (leaves[57]?.bytes.length ?? 0));
  expect(plan.pages).toHaveLength(5); // Two leaves, two parents, one new root.
  expect(plan.depth).toBe(3);
  f.save(plan.pages);
  expect((await auditBalancedIndex(plan.after, plan.after.contentHash, f.read)).height).toBe(3);
  const expected = Array.from({ length: 11_833 }, (_, n) => entry(n * 2));
  expect(await collect(plan.after, f.read)).toEqual(expected);
  expect(await collect(root, f.read)).toEqual(expected.slice(0, -1));
  // Every untouched leaf descriptor survives byte-for-byte in the new branches.
  const children = plan.pages.flatMap(
    (p) => verifyIndexPageBytes(p.descriptor.page, p.bytes).children,
  );
  for (const leaf of leaves.slice(0, -1)) expect(children).toContainEqual(leaf.descriptor);
});

test("outer and inter-child insertions preserve disjoint fences and untouched siblings", async () => {
  const left = encodeIndexPage(location(1), [entry(10), entry(20)]);
  const right = encodeIndexPage(location(2), [entry(40), entry(50)]);
  const parent = encodeIndexPage(location(3), [], [left.descriptor, right.descriptor]);
  const f = fixture([left, right, parent]);
  const root = createIndexRoot(4n, parent.descriptor.page);
  const index = await auditBalancedIndex(root, root.contentHash, f.read);
  for (const n of [0, 15, 30, 45, 60]) {
    const plan = await prepareIndexInsert(index, entry(n), f.read, f.allocate);
    expect(plan.pagesRead).toBe(2);
    expect(plan.pages).toHaveLength(2);
    f.save(plan.pages);
    expect(await collect(plan.after, f.read)).toEqual(sorted([10, 20, 40, 50, n].map(entry)));
    const top = plan.pages[1];
    if (!top) throw new Error("Missing prepared parent");
    expect(verifyIndexPageBytes(top.descriptor.page, top.bytes).children).toContainEqual(
      n <= 20 ? right.descriptor : left.descriptor,
    );
  }
  expect(await collect(root, f.read)).toEqual([10, 20, 40, 50].map(entry));
});

test("selected-page loss or corruption after audit fails without reserving new locations", async () => {
  const leaf = fullLeaf(),
    f = fixture([leaf]);
  const root = createIndexRoot(204n, leaf.descriptor.page);
  const index = await auditBalancedIndex(root, root.contentHash, f.read);
  await expect(
    prepareIndexInsert(index, entry(1), async () => undefined, f.allocate),
  ).rejects.toThrow("index_page_missing_or_short");
  const corrupt = leaf.bytes.slice();
  corrupt[corrupt.length - 1] = 0;
  await expect(
    prepareIndexInsert(index, entry(1), async () => corrupt, f.allocate),
  ).rejects.toThrow("index_page_hash_mismatch");
  await expect(
    prepareIndexInsert(
      index,
      entry(1),
      async () => {
        throw new Error("read failed");
      },
      f.allocate,
    ),
  ).rejects.toThrow("read failed");
  expect(f.allocated).toEqual([]);
});

test("failed and colliding reservations cannot mutate the previous tree", async () => {
  const leaf = fullLeaf(),
    f = fixture([leaf]);
  const root = createIndexRoot(204n, leaf.descriptor.page);
  const index = await auditBalancedIndex(root, root.contentHash, f.read);
  await expect(prepareIndexInsert(index, entry(1), f.read, () => location(1))).rejects.toThrow(
    "index_page_location_reused",
  );
  await expect(prepareIndexInsert(index, entry(1), f.read, () => location(90))).rejects.toThrow(
    "index_page_location_reused",
  );
  await expect(prepareIndexInsert(index, entry(1), f.read, () => "bad")).rejects.toThrow(
    "index_page_location_invalid",
  );
  for (const failAt of [1, 2, 3]) {
    let calls = 0;
    await expect(
      prepareIndexInsert(index, entry(1), f.read, () => {
        if (++calls === failAt) throw new Error("reservation failed");
        return f.allocate();
      }),
    ).rejects.toThrow("reservation failed");
    expect(calls).toBe(failAt);
  }
  expect(f.pages.size).toBe(1);
  expect(await collect(root, f.read)).toEqual(Array.from({ length: 204 }, (_, n) => entry(n * 2)));
  const other = encodeIndexPage(location(2), [entry(1000)]);
  const parent = encodeIndexPage(location(3), [], [leaf.descriptor, other.descriptor]);
  f.save([other, parent]);
  const branchRoot = createIndexRoot(205n, parent.descriptor.page);
  const branch = await auditBalancedIndex(branchRoot, branchRoot.contentHash, f.read);
  // An unvisited sibling location is nevertheless protected by the read parent.
  await expect(prepareIndexInsert(branch, entry(1), f.read, () => location(2))).rejects.toThrow(
    "index_page_location_reused",
  );
});

test("each partial prepared-page prefix leaves old root usable and new root unverifiable", async () => {
  const leaf = fullLeaf(),
    f = fixture([leaf]);
  const root = createIndexRoot(204n, leaf.descriptor.page);
  const index = await auditBalancedIndex(root, root.contentHash, f.read);
  const plan = await prepareIndexInsert(index, entry(1), f.read, f.allocate);
  expect(plan.pages).toHaveLength(3);
  const original = await collect(root, f.read);
  for (let prefix = 0; prefix <= plan.pages.length; prefix++) {
    const partial = fixture([leaf, ...plan.pages.slice(0, prefix)]);
    expect(await collect(root, partial.read)).toEqual(original);
    if (prefix < plan.pages.length) {
      await expect(collect(plan.after, partial.read)).rejects.toThrow(
        "index_page_missing_or_short",
      );
    } else expect(await collect(plan.after, partial.read)).toEqual(sorted([...original, entry(1)]));
  }
  // Parent-first persistence also cannot conceal a required missing child.
  const top = plan.pages[2];
  if (!top) throw new Error("Missing new root");
  const parentOnly = fixture([leaf, top]);
  await expect(collect(plan.after, parentOnly.read)).rejects.toThrow("index_page_missing_or_short");
});

test("balanced-layout eligibility rejects mixed leaf depth without forbidding ordinary reads", async () => {
  const left = encodeIndexPage(location(1), [entry(1)]);
  const right = encodeIndexPage(location(2), [entry(2)]);
  const nested = encodeIndexPage(location(3), [], [right.descriptor]);
  const parent = encodeIndexPage(location(4), [], [left.descriptor, nested.descriptor]);
  const f = fixture([left, right, nested, parent]);
  const root = createIndexRoot(2n, parent.descriptor.page);
  expect(await collect(root, f.read)).toEqual([entry(1), entry(2)]);
  await expect(auditBalancedIndex(root, root.contentHash, f.read)).rejects.toThrow(
    "index_layout_unbalanced",
  );
  await expect(auditBalancedIndex(root, key(999), f.read)).rejects.toThrow(
    "index_root_hash_mismatch",
  );
});

test("layout eligibility requires full authenticated graph, population and exact child fences", async () => {
  const leaf = encodeIndexPage(location(1), [entry(10), entry(20)]);
  const f = fixture([leaf]);
  for (const [descriptor, error] of [
    [{ ...leaf.descriptor, population: 3n }, "index_page_population_mismatch"],
    [{ ...leaf.descriptor, min: key(9) }, "index_page_fence_mismatch"],
    [{ ...leaf.descriptor, max: key(21) }, "index_page_fence_mismatch"],
  ] as const) {
    const parent = encodeIndexPage(location(2), [], [descriptor]);
    const root = createIndexRoot(descriptor.population, parent.descriptor.page);
    await expect(
      auditBalancedIndex(root, root.contentHash, async (id) =>
        id === location(2) ? parent.bytes : f.read(id),
      ),
    ).rejects.toThrow(error);
  }
  const wrongPopulation = createIndexRoot(3n, leaf.descriptor.page);
  await expect(
    auditBalancedIndex(wrongPopulation, wrongPopulation.contentHash, f.read),
  ).rejects.toThrow("index_page_population_mismatch");
  const root = createIndexRoot(2n, leaf.descriptor.page);
  await expect(auditBalancedIndex(root, root.contentHash, async () => undefined)).rejects.toThrow(
    "index_page_missing_or_short",
  );
  const corrupt = leaf.bytes.slice();
  corrupt[0] = 0;
  await expect(auditBalancedIndex(root, root.contentHash, async () => corrupt)).rejects.toThrow(
    "index_page_hash_mismatch",
  );
});

test("depth-sixteen insertion remains balanced; audit refuses a seventeenth fetch", async () => {
  let current = fullLeaf();
  const f = fixture([current]);
  for (let depth = 2; depth <= 16; depth++) {
    current = encodeIndexPage(location(depth), [], [current.descriptor]);
    f.save([current]);
  }
  const root = createIndexRoot(204n, current.descriptor.page);
  const index = await auditBalancedIndex(root, root.contentHash, f.read);
  const plan = await prepareIndexInsert(index, entry(1), f.read, f.allocate);
  expect(plan.pagesRead).toBe(16);
  expect(plan.depth).toBe(16);
  expect(plan.pages).toHaveLength(17); // Leaf split is absorbed by unary parent.
  f.save(plan.pages);
  expect((await auditBalancedIndex(plan.after, plan.after.contentHash, f.read)).height).toBe(16);
  expect(await collect(plan.after, f.read)).toEqual(
    sorted([...Array.from({ length: 204 }, (_, n) => entry(n * 2)), entry(1)]),
  );
  const extra = encodeIndexPage(location(17), [], [current.descriptor]);
  f.save([extra]);
  const excessive = createIndexRoot(204n, extra.descriptor.page);
  let reads = 0;
  await expect(
    auditBalancedIndex(excessive, excessive.contentHash, async (id) => {
      reads++;
      return f.read(id);
    }),
  ).rejects.toThrow("index_page_depth_exceeded");
  expect(reads).toBe(16);
});

test("entry values are captured before I/O; prepared page bytes must still be verified at storage", async () => {
  const leaf = fullLeaf(),
    f = fixture([leaf]);
  const root = createIndexRoot(204n, leaf.descriptor.page);
  const index = await auditBalancedIndex(root, root.contentHash, f.read);
  const row = { ...entry(1) };
  const plan = await prepareIndexInsert(
    index,
    row,
    async (id) => {
      row.key = key(2);
      row.sequence = 999n;
      return f.read(id);
    },
    f.allocate,
  );
  expect(plan.entry).toEqual(entry(1));
  expect(Object.isFrozen(plan.entry)).toBe(true);
  const first = plan.pages[0];
  if (!first) throw new Error("Missing page");
  first.bytes[0] = 0;
  expect(() => verifyIndexPageBytes(first.descriptor.page, first.bytes)).toThrow();
  expect(await collect(root, f.read)).toEqual(Array.from({ length: 204 }, (_, n) => entry(n * 2)));
});

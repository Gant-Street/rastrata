import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { hashCanonical } from "@rastrata/kernel";
import { emptyIndexRoot } from "../src/index-control.ts";
import {
  createIndexRoot,
  encodeIndexPage,
  enumerateIndexPages,
  lookupIndexEntry,
  verifyIndexRoot,
  identityIndexKey,
  INDEX_KEY_SCHEMA,
  INDEX_PAGE_BYTES,
  INDEX_PAGE_VERSION,
  type IndexRoot,
  type IndexEntry,
  type IndexPageReference,
} from "../src/index-pages.ts";

const key = (n: number) => n.toString(16).padStart(64, "0");
const location = (n: number) => `derived/${key(n)}`;
const rows = (start: number, length: number): IndexEntry[] =>
  Array.from({ length }, (_, i) => ({ key: key(start + i), sequence: BigInt(i + 1) }));
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("physical index roots are not logical accounting commitments: relocation and repacking change roots", async () => {
  const entries = rows(10, 4);
  const original = encodeIndexPage(location(100), entries);
  const relocated = encodeIndexPage(location(101), entries);
  expect(original.bytes).toEqual(relocated.bytes);
  expect(original.descriptor.page.digest).toBe(relocated.descriptor.page.digest);
  const left = encodeIndexPage(location(102), entries.slice(0, 2));
  const right = encodeIndexPage(location(103), entries.slice(2));
  const parent = encodeIndexPage(location(104), [], [left.descriptor, right.descriptor]);
  const pages = new Map(
    [original, relocated, left, right, parent].map((page) => [
      page.descriptor.page.location,
      page.bytes,
    ]),
  );
  const roots = [original, relocated, parent].map((page) =>
    createIndexRoot(4n, page.descriptor.page),
  );
  expect(new Set(roots.map((root) => root.contentHash)).size).toBe(3);
  for (const root of roots) {
    expect(await collect(root, pages)).toEqual(entries);
    for (const entry of entries)
      expect(
        (await lookupIndexEntry(root, root.contentHash, entry.key, async (id) => pages.get(id)))
          .sequence,
      ).toBe(entry.sequence);
  }
  // The same four raw entries have three valid physical commitments. A future
  // financial state root must remain equal across these operations instead.
});

test("bounded lookup proves leaf and branch-gap absence and does not confuse missing pages with absence", async () => {
  const left = encodeIndexPage(location(1), [
    { key: key(10), sequence: 2n },
    { key: key(20), sequence: 7n },
  ]);
  const right = encodeIndexPage(location(2), [
    { key: key(40), sequence: 9n },
    { key: key(50), sequence: 12n },
  ]);
  const parent = encodeIndexPage(location(3), [], [left.descriptor, right.descriptor]);
  const root = createIndexRoot(4n, parent.descriptor.page);
  const pages = new Map(
    [left, right, parent].map((page) => [page.descriptor.page.location, page.bytes]),
  );
  for (const [query, expected, reads] of [
    [0, null, 1],
    [10, 2n, 2],
    [15, null, 2],
    [20, 7n, 2],
    [30, null, 1],
    [40, 9n, 2],
    [50, 12n, 2],
    [60, null, 1],
  ] as const) {
    const visited: string[] = [];
    const result = await lookupIndexEntry(root, root.contentHash, key(query), async (id) => {
      visited.push(id);
      return pages.get(id);
    });
    expect(result.sequence).toBe(expected);
    expect(result.pagesRead).toBe(reads);
    expect(result.bytesRead).toBe(
      visited.reduce((sum, id) => sum + (pages.get(id)?.length ?? 0), 0),
    );
    expect(Object.isFrozen(result)).toBe(true);
  }
  pages.delete(location(1));
  await expect(
    lookupIndexEntry(root, root.contentHash, key(15), async (id) => pages.get(id)),
  ).rejects.toThrow("index_page_missing_or_short");
  // A path proof is not a whole-tree health audit: an unrelated missing page
  // does not alter an authenticated branch gap. Root completeness must have been
  // audited before selection; the independent full traversal still rejects damage.
  expect(
    (await lookupIndexEntry(root, root.contentHash, key(30), async (id) => pages.get(id))).sequence,
  ).toBeNull();
  await expect(collect(root, pages)).rejects.toThrow("index_page_missing_or_short");
  let fetched = false;
  const empty = createIndexRoot(0n, null);
  expect(
    (
      await lookupIndexEntry(empty, empty.contentHash, key(1), async () => {
        fetched = true;
        return undefined;
      })
    ).pagesRead,
  ).toBe(0);
  await expect(
    lookupIndexEntry(root, root.contentHash, "BAD", async () => {
      fetched = true;
      return undefined;
    }),
  ).rejects.toThrow("index_page_digest_invalid");
  expect(fetched).toBe(false);
});

test("lookup verifies every selected child fence, population, digest and required read", async () => {
  const t = tree();
  for (const [descriptor, error] of [
    [{ ...t.left.descriptor, max: key(3) }, "index_page_fence_mismatch"],
    [{ ...t.left.descriptor, population: 3n }, "index_page_population_mismatch"],
  ] as const) {
    const parent = encodeIndexPage(location(9), [], [descriptor]);
    const root = createIndexRoot(descriptor.population, parent.descriptor.page);
    await expect(
      lookupIndexEntry(root, root.contentHash, key(1), async (id) =>
        id === location(9) ? parent.bytes : t.pages.get(id),
      ),
    ).rejects.toThrow(error);
  }
  const bad = t.left.bytes.slice();
  bad[bad.length - 1] = 255; // Fixture's final sequence byte was 2.
  await expect(
    lookupIndexEntry(t.root, t.root.contentHash, key(1), async (id) =>
      id === location(1) ? bad : t.pages.get(id),
    ),
  ).rejects.toThrow("index_page_hash_mismatch");
  await expect(
    lookupIndexEntry(t.root, key(1), key(1), async (id) => t.pages.get(id)),
  ).rejects.toThrow("index_root_hash_mismatch");
  await expect(
    lookupIndexEntry(t.root, t.root.contentHash, key(1), async () => {
      throw new Error("storage unavailable");
    }),
  ).rejects.toThrow("storage unavailable");
});

test("lookup depth is bounded before a seventeenth page read", async () => {
  let current = encodeIndexPage(location(1), [{ key: key(1), sequence: 1n }]);
  const pages = new Map([[location(1), current.bytes]]);
  for (let depth = 2; depth <= 17; depth++) {
    current = encodeIndexPage(location(depth), [], [current.descriptor]);
    pages.set(location(depth), current.bytes);
    if (depth === 16) {
      const root = createIndexRoot(1n, current.descriptor.page);
      expect(
        (await lookupIndexEntry(root, root.contentHash, key(1), async (id) => pages.get(id)))
          .pagesRead,
      ).toBe(16);
    }
  }
  const root = createIndexRoot(1n, current.descriptor.page);
  let calls = 0;
  await expect(
    lookupIndexEntry(root, root.contentHash, key(1), async (id) => {
      calls++;
      return pages.get(id);
    }),
  ).rejects.toThrow("index_page_depth_exceeded");
  expect(calls).toBe(16);
});

test("thirty-thousand-key lookups match independent enumeration with at most three page reads", async () => {
  const pages = new Map<string, Uint8Array>();
  let nextLocation = 1;
  const save = (page: ReturnType<typeof encodeIndexPage>) => {
    pages.set(page.descriptor.page.location, page.bytes);
    return page.descriptor;
  };
  let level = Array.from({ length: Math.ceil(30_000 / 204) }, (_, block) =>
    save(
      encodeIndexPage(
        location(nextLocation++),
        Array.from({ length: Math.min(204, 30_000 - block * 204) }, (_, i) => ({
          key: key((block * 204 + i + 1) * 2),
          sequence: BigInt(block * 204 + i + 1),
        })),
      ),
    ),
  );
  while (level.length > 1) {
    const parent = [];
    for (let i = 0; i < level.length; i += 58)
      parent.push(save(encodeIndexPage(location(nextLocation++), [], level.slice(i, i + 58))));
    level = parent;
  }
  const descriptor = level[0];
  if (!descriptor) throw new Error("Missing root");
  const root = createIndexRoot(30_000n, descriptor.page);
  const oracle = new Map((await collect(root, pages)).map((entry) => [entry.key, entry.sequence]));
  expect(oracle.size).toBe(30_000);
  for (const query of [
    0,
    1,
    2,
    60_000,
    60_001,
    ...Array.from({ length: 200 }, (_, i) => (i * 7919) % 60_002),
  ]) {
    let fetches = 0,
      fetchedBytes = 0;
    const result = await lookupIndexEntry(root, root.contentHash, key(query), async (id) => {
      fetches++;
      const bytes = pages.get(id);
      fetchedBytes += bytes?.length ?? 0;
      return bytes;
    });
    const expected = query > 0 && query <= 60_000 && query % 2 === 0 ? BigInt(query / 2) : null;
    expect(oracle.get(key(query)) ?? null).toBe(expected);
    expect(result.sequence).toBe(expected);
    expect(result.pagesRead).toBe(fetches);
    expect(result.bytesRead).toBe(fetchedBytes);
    expect(result.pagesRead).toBeLessThanOrEqual(3);
    expect(result.bytesRead).toBeLessThanOrEqual(3 * INDEX_PAGE_BYTES);
  }
});

test("identity keys commit raw book, family and ID with the exact schema domain", () => {
  const id = { bookId: "book:α", family: "command" as const, id: "same/id" };
  const expected = hashCanonical({
    domain: "rastrata-permanent-identity-v1",
    bookId: "book:α",
    family: "command",
    id: "same/id",
  }).digest;
  expect(identityIndexKey(id)).toBe(expected);
  expect(identityIndexKey({ ...id, bookId: "other" })).not.toBe(expected);
  expect(identityIndexKey({ ...id, family: "journal" })).not.toBe(expected);
  expect(identityIndexKey({ ...id, id: "same/ID" })).not.toBe(expected);
});
async function collect(root: IndexRoot, pages: Map<string, Uint8Array>) {
  return Array.fromAsync(enumerateIndexPages(root, root.contentHash, async (id) => pages.get(id)));
}
function changed(bytes: Uint8Array, population = 1n) {
  const page: IndexPageReference = {
    location: location(1),
    digest: hash(bytes),
    byteCount: bytes.length,
    representationVersion: INDEX_PAGE_VERSION,
  };
  return { root: createIndexRoot(population, page), pages: new Map([[page.location, bytes]]) };
}
function tree() {
  const left = encodeIndexPage(location(1), rows(1, 2));
  const right = encodeIndexPage(location(2), rows(3, 3));
  const parent = encodeIndexPage(location(3), [], [left.descriptor, right.descriptor]);
  const root = createIndexRoot(5n, parent.descriptor.page);
  const pages = new Map([left, right, parent].map((p) => [p.descriptor.page.location, p.bytes]));
  return { left, right, parent, root, pages };
}

test("page codec uses a distinct wire domain, exact big-endian bytes and separate physical locations", async () => {
  const encoded = encodeIndexPage(location(1), [{ key: key(0), sequence: 1n }]);
  const expectedHex = `524950310000000001${"00".repeat(32)}0000000000000001`;
  expect(Buffer.from(encoded.bytes).toString("hex")).toBe(expectedHex);
  expect(encoded.bytes.length).toBe(49);
  const manual = changed(new Uint8Array(Buffer.from(expectedHex, "hex")));
  expect(await collect(manual.root, manual.pages)).toEqual([{ key: key(0), sequence: 1n }]);
  expect(manual.root.page?.digest).toBe(encoded.descriptor.page.digest);
  const relocated = encodeIndexPage(location(2), [{ key: key(0), sequence: 1n }]);
  expect(relocated.descriptor.page.digest).toBe(encoded.descriptor.page.digest);
  expect(createIndexRoot(1n, relocated.descriptor.page).contentHash).not.toBe(
    manual.root.contentHash,
  );
  expect(createIndexRoot(0n, null).contentHash).toBe(emptyIndexRoot(INDEX_KEY_SCHEMA));
  expect(await collect(createIndexRoot(0n, null), new Map())).toEqual([]);
});

test("full traversal authenticates all child pages and checks fences and populations", async () => {
  const t = tree();
  expect(t.parent.bytes.length).toBe(9 + 2 * 140);
  expect(await collect(t.root, t.pages)).toEqual([...rows(1, 2), ...rows(3, 3)]);
  const missing = new Map(t.pages);
  missing.delete(location(2));
  await expect(collect(t.root, missing)).rejects.toThrow("index_page_missing_or_short");
  for (const delta of [-1, 1]) {
    const bytes = new Uint8Array(t.right.bytes.length + delta);
    bytes.set(t.right.bytes.subarray(0, bytes.length));
    await expect(collect(t.root, new Map(t.pages).set(location(2), bytes))).rejects.toThrow(
      "index_page_missing_or_short",
    );
  }
  const corrupt = t.right.bytes.slice();
  corrupt[10] = 255;
  await expect(collect(t.root, new Map(t.pages).set(location(2), corrupt))).rejects.toThrow(
    "index_page_hash_mismatch",
  );
  expect(() => encodeIndexPage(location(4), [], [{ ...t.left.descriptor, max: key(0) }])).toThrow(
    "index_page_order_invalid",
  );
});

test("authenticated parent cannot lie about child range or count", async () => {
  const t = tree();
  const wrongFence = encodeIndexPage(location(4), [], [{ ...t.left.descriptor, max: key(3) }]);
  await expect(
    collect(
      createIndexRoot(2n, wrongFence.descriptor.page),
      new Map(t.pages).set(location(4), wrongFence.bytes),
    ),
  ).rejects.toThrow("index_page_fence_mismatch");
  const wrongCount = encodeIndexPage(location(5), [], [{ ...t.left.descriptor, population: 3n }]);
  await expect(
    collect(
      createIndexRoot(3n, wrongCount.descriptor.page),
      new Map(t.pages).set(location(5), wrongCount.bytes),
    ),
  ).rejects.toThrow("index_page_population_mismatch");
  await expect(collect(createIndexRoot(6n, t.parent.descriptor.page), t.pages)).rejects.toThrow(
    "index_page_population_mismatch",
  );
});

test("rehashed malformed wire pages still fail strict decoding", async () => {
  const one = encodeIndexPage(location(1), rows(1, 1)).bytes;
  for (const [offset, value, error] of [
    [0, 0, "index_page_version_unsupported"],
    [4, 2, "index_page_kind_invalid"],
    [8, 0, "index_page_length_invalid"],
    [8, 2, "index_page_length_invalid"],
    [48, 0, "index_page_counter_invalid"],
  ] as const) {
    const bytes = one.slice();
    bytes[offset] = value;
    const c = changed(bytes);
    await expect(collect(c.root, c.pages)).rejects.toThrow(error);
  }
  const repeated = encodeIndexPage(location(1), rows(1, 2)).bytes;
  repeated.set(repeated.subarray(9, 41), 49);
  const duplicate = changed(repeated, 2n);
  await expect(collect(duplicate.root, duplicate.pages)).rejects.toThrow(
    "index_page_order_invalid",
  );
  const t = tree();
  for (const [offset, value, error] of [
    [9 + 128, 255, "index_page_length_invalid"],
    [9 + 139, 0, "index_page_counter_invalid"],
  ] as const) {
    const bytes = t.parent.bytes.slice();
    bytes[offset] = value;
    const c = changed(bytes, 5n);
    await expect(collect(c.root, new Map(t.pages).set(location(1), bytes))).rejects.toThrow(error);
  }
});

test("descriptor validation rejects wrong anchors, versions, extra fields, accessors and counter overflow", () => {
  const t = tree();
  expect(verifyIndexRoot(t.root, t.root.contentHash)).toEqual(t.root);
  expect(() => verifyIndexRoot(t.root, key(99))).toThrow("index_root_hash_mismatch");
  expect(() =>
    verifyIndexRoot({ ...t.root, keySchemaVersion: "other" }, t.root.contentHash),
  ).toThrow("index_key_schema_unsupported");
  expect(() => verifyIndexRoot({ ...t.root, population: "05" }, t.root.contentHash)).toThrow(
    "index_root_population_invalid",
  );
  expect(() => verifyIndexRoot({ ...t.root, extra: true }, t.root.contentHash)).toThrow(
    "index_page_shape_invalid",
  );
  let calls = 0;
  expect(() =>
    verifyIndexRoot(
      {
        ...t.root,
        get page() {
          calls++;
          throw new Error("no");
        },
      },
      t.root.contentHash,
    ),
  ).toThrow("index_page_shape_invalid");
  expect(calls).toBe(0);
  for (const page of [
    { ...t.parent.descriptor.page, location: "canonical/manifest" },
    { ...t.parent.descriptor.page, representationVersion: "RIX1" },
    { ...t.parent.descriptor.page, byteCount: INDEX_PAGE_BYTES + 1 },
    { ...t.parent.descriptor.page, digest: "abc" },
  ])
    expect(() => verifyIndexRoot({ ...t.root, page }, t.root.contentHash)).toThrow();
  expect(() => createIndexRoot(0n, t.root.page)).toThrow("index_root_population_invalid");
  expect(() => createIndexRoot(1n, null)).toThrow("index_root_population_invalid");
  expect(() => createIndexRoot(1n << 64n, t.root.page)).toThrow("index_root_population_invalid");
  expect(() => encodeIndexPage(location(1), [{ key: key(0), sequence: 1n << 64n }])).toThrow(
    "index_page_counter_invalid",
  );
  expect(() => encodeIndexPage(location(1), [])).toThrow("index_page_kind_invalid");
  expect(() => encodeIndexPage(location(1), rows(1, 205))).toThrow("index_page_length_invalid");
  expect(() => encodeIndexPage(location(1), rows(1, 1), [t.left.descriptor])).toThrow(
    "index_page_kind_invalid",
  );
  expect(() => encodeIndexPage(location(1), [], [t.right.descriptor, t.left.descriptor])).toThrow(
    "index_page_order_invalid",
  );
});

test("deep authenticated nesting is bounded and reader errors propagate", async () => {
  let page = encodeIndexPage(location(1), rows(1, 1));
  const pages = new Map([[location(1), page.bytes]]);
  for (let depth = 2; depth <= 17; depth++) {
    page = encodeIndexPage(location(depth), [], [page.descriptor]);
    pages.set(location(depth), page.bytes);
    if (depth === 16)
      expect(await collect(createIndexRoot(1n, page.descriptor.page), pages)).toEqual(rows(1, 1));
  }
  const root = createIndexRoot(1n, page.descriptor.page);
  await expect(collect(root, pages)).rejects.toThrow("index_page_depth_exceeded");
  await expect(
    Array.fromAsync(
      enumerateIndexPages(root, root.contentHash, async () => {
        throw new Error("storage offline");
      }),
    ),
  ).rejects.toThrow("storage offline");
});

test("exact leaf/branch capacity and unsigned-counter boundaries fail closed", async () => {
  const leaf = encodeIndexPage(location(1), rows(1, 204));
  expect(leaf.bytes.length).toBe(8_169);
  expect(
    await collect(
      createIndexRoot(204n, leaf.descriptor.page),
      new Map([[location(1), leaf.bytes]]),
    ),
  ).toEqual(rows(1, 204));
  const children = Array.from({ length: 58 }, (_, i) =>
    encodeIndexPage(location(i + 1), rows(i + 1, 1)),
  );
  const branch = encodeIndexPage(
    location(100),
    [],
    children.map((child) => child.descriptor),
  );
  expect(branch.bytes.length).toBe(8_129);
  const pages = new Map(
    [...children, branch].map((page) => [page.descriptor.page.location, page.bytes]),
  );
  expect((await collect(createIndexRoot(58n, branch.descriptor.page), pages)).length).toBe(58);
  const extra = encodeIndexPage(location(59), rows(59, 1));
  expect(() =>
    encodeIndexPage(
      location(100),
      [],
      [...children, extra].map((child) => child.descriptor),
    ),
  ).toThrow("index_page_length_invalid");
  const max = (1n << 64n) - 1n;
  const high = encodeIndexPage(location(1), [{ key: key(1), sequence: max }]);
  expect(
    await collect(createIndexRoot(1n, high.descriptor.page), new Map([[location(1), high.bytes]])),
  ).toEqual([{ key: key(1), sequence: max }]);
  const first = children[0],
    second = children[1];
  if (!first || !second) throw new Error("Missing capacity-test children");
  expect(() =>
    encodeIndexPage(
      location(100),
      [],
      [{ ...first.descriptor, population: max }, second.descriptor],
    ),
  ).toThrow("index_page_counter_invalid");
  const t = tree();
  const overlapping = t.parent.bytes.slice();
  overlapping.set(overlapping.subarray(9, 41), 9 + 140);
  const malformed = changed(overlapping, 5n);
  await expect(collect(malformed.root, malformed.pages)).rejects.toThrow(
    "index_page_order_invalid",
  );
  const overflow = t.parent.bytes.slice();
  new DataView(overflow.buffer).setBigUint64(9 + 132, max, false);
  const invalid = changed(overflow, 5n);
  await expect(collect(invalid.root, invalid.pages)).rejects.toThrow("index_page_counter_invalid");
});

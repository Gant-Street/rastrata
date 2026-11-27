import { expect, test } from "bun:test";
import { hashCanonical } from "@rastrata/kernel";
import {
  auditLogicalMap,
  emptyLogicalMap,
  logicalMapHash,
  lookupLogicalValue,
  prepareLogicalChange,
  readLogicalRangePage,
  readLogicalLastEntry,
} from "../src/logical-map.ts";
import { rebuildLogicalMap } from "./logical-map-oracle.ts";

const domain = hashCanonical({
  financialIdentity: "test-book",
  profile: "candidate",
  collection: "live-holdings",
  keySchema: "sha256",
}).digest;
const hex = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");

test("last-entry proof follows only the right spine and authenticates every fetched node", async () => {
  const values = new Map(Array.from({ length: 2048 }, (_, i) => [hex(i), hex(i + 100)]));
  const oracle = rebuildLogicalMap(domain, values);
  const visited: string[] = [];
  const last = await readLogicalLastEntry(
    oracle.encodedRoot,
    oracle.rootHash,
    domain,
    async (d) => {
      visited.push(d);
      return oracle.nodes.get(d);
    },
  );
  expect(last.entry).toEqual({ key: hex(2047), value: hex(2147) });
  expect(last.population).toBe(2048n);
  expect(last.rootHash).toBe(oracle.rootHash);
  expect(last.metrics.nodesRead).toBe(12);
  expect(visited).toHaveLength(12);
  for (const missing of visited) {
    await expect(
      readLogicalLastEntry(oracle.encodedRoot, oracle.rootHash, domain, async (d) =>
        d === missing ? undefined : oracle.nodes.get(d),
      ),
    ).rejects.toThrow("logical_map_node_missing");
    await expect(
      readLogicalLastEntry(oracle.encodedRoot, oracle.rootHash, domain, async (d) =>
        d === missing ? `${oracle.nodes.get(d)} ` : oracle.nodes.get(d),
      ),
    ).rejects.toThrow("logical_map_encoding_noncanonical");
  }
  await expect(
    readLogicalLastEntry(oracle.encodedRoot, hex(0), domain, async (d) => oracle.nodes.get(d)),
  ).rejects.toThrow("logical_map_root_mismatch");
});

test("last-entry proof distinguishes empty, singleton and deleted maxima without sentinel keys", async () => {
  const f = fixture();
  const empty = await readLogicalLastEntry(f.root, f.hash, domain, f.read);
  expect(empty.entry).toBeNull();
  expect(empty.population).toBe(0n);
  expect(empty.metrics.nodesRead).toBe(0);
  await f.change(hex(0), null, hex(1));
  await f.change("f".repeat(64), null, hex(2));
  expect((await readLogicalLastEntry(f.root, f.hash, domain, f.read)).entry).toEqual({
    key: "f".repeat(64),
    value: hex(2),
  });
  await f.change("f".repeat(64), hex(2), null);
  const singleton = await readLogicalLastEntry(f.root, f.hash, domain, f.read);
  expect(singleton.entry).toEqual({ key: hex(0), value: hex(1) });
  expect(singleton.population).toBe(1n);
});
const key = (n: number) => hashCanonical({ key: BigInt(n) }).digest;
function fixture() {
  let encodedRoot = emptyLogicalMap(domain);
  const nodes = new Map<string, string>();
  const read = async (digest: string) => nodes.get(digest);
  return {
    nodes,
    read,
    get root() {
      return encodedRoot;
    },
    get hash() {
      return logicalMapHash(encodedRoot, domain);
    },
    async change(k: string, expected: string | null, next: string | null) {
      const result = await prepareLogicalChange(
        encodedRoot,
        logicalMapHash(encodedRoot, domain),
        domain,
        k,
        expected,
        next,
        read,
      );
      for (const node of result.nodes) nodes.set(node.digest, node.encoded);
      encodedRoot = result.encodedRoot;
      return result;
    },
  };
}

test("logical range pages prove exact ordered prefixes and exhaustion across bounds and page sizes", async () => {
  const values = new Map(Array.from({ length: 32 }, (_, i) => [hex(i * 2), hex(i + 100)]));
  values.set("f".repeat(64), hex(200));
  const oracle = rebuildLogicalMap(domain, values);
  const sorted = [...values].sort(([a], [b]) => a.localeCompare(b));
  for (const [from, through] of [
    [null, null],
    [hex(0), hex(7)],
    [hex(1), hex(61)],
    [hex(10), hex(10)],
    [hex(63), null],
    ["f".repeat(64), null],
  ] as const) {
    const expected = sorted.filter(
      ([key]) => (from === null || key >= from) && (through === null || key < through),
    );
    for (const limit of [1, 7, 32, 256]) {
      let next: string | null = from;
      const actual: (readonly [string, string])[] = [];
      let pages = 0;
      while (true) {
        const page = await readLogicalRangePage(
          oracle.encodedRoot,
          oracle.rootHash,
          domain,
          next,
          through,
          limit,
          async (d) => oracle.nodes.get(d),
        );
        expect(page.rootHash).toBe(oracle.rootHash);
        expect(page.domain).toBe(domain);
        expect(page.fromInclusive).toBe(next);
        expect(page.throughExclusive).toBe(through);
        expect(page.entries.length).toBeLessThanOrEqual(limit);
        expect(Object.isFrozen(page)).toBe(true);
        expect(Object.isFrozen(page.entries)).toBe(true);
        actual.push(...page.entries.map((entry) => [entry.key, entry.value] as const));
        if (page.complete) {
          expect(page.nextFromInclusive).toBeNull();
          break;
        }
        const last = page.entries.at(-1);
        if (!last || page.nextFromInclusive === null) throw new Error("Invalid partial page");
        expect(page.entries.length).toBe(limit);
        expect(page.nextFromInclusive > last.key).toBe(true);
        next = page.nextFromInclusive;
        expect(++pages).toBeLessThan(40);
      }
      expect(actual).toEqual(expected);
    }
  }
});

test("logical range traversal prunes unrelated subtrees and reads bounded narrow pages", async () => {
  const values = new Map(Array.from({ length: 4096 }, (_, i) => [hex(i * 2), hex(i + 10_000)]));
  const oracle = rebuildLogicalMap(domain, values);
  const read = async (d: string) => oracle.nodes.get(d);
  const page = await readLogicalRangePage(
    oracle.encodedRoot,
    oracle.rootHash,
    domain,
    hex(4001),
    hex(4040),
    7,
    read,
  );
  expect(page.entries.map((e) => e.key)).toEqual(
    [4002, 4004, 4006, 4008, 4010, 4012, 4014].map(hex),
  );
  expect(page.complete).toBe(false);
  expect(page.nextFromInclusive).toBe(hex(4016));
  expect(page.metrics.nodesRead).toBeLessThanOrEqual(2 * 8 + 2 * 12);
  expect(page.metrics.bytesRead).toBeLessThanOrEqual(page.metrics.nodesRead * 2048);
  // Missing storage wholly outside the requested authenticated fences need not
  // be read. This does not claim a full-tree integrity audit.
  const root = JSON.parse(oracle.encodedRoot);
  const node = JSON.parse(oracle.nodes.get(root.tree.digest) ?? "null");
  const outside = node.left.digest;
  const right = await readLogicalRangePage(
    oracle.encodedRoot,
    oracle.rootHash,
    domain,
    node.right.min,
    null,
    1,
    async (d) => (d === outside ? undefined : read(d)),
  );
  expect(right.entries[0]?.key).toBe(node.right.min);
});

test("range completion requires the sentinel and every required node; damaged bytes cannot truncate a page", async () => {
  const oracle = rebuildLogicalMap(
    domain,
    new Map([
      [hex(1), hex(10)],
      [hex(2), hex(20)],
    ]),
  );
  const missing = [...oracle.nodes].find(([, body]) => JSON.parse(body).key === hex(2))?.[0];
  if (!missing) throw new Error("Missing second leaf fixture");
  await expect(
    readLogicalRangePage(oracle.encodedRoot, oracle.rootHash, domain, null, null, 1, async (d) =>
      d === missing ? undefined : oracle.nodes.get(d),
    ),
  ).rejects.toThrow("logical_map_node_missing");
  await expect(
    readLogicalRangePage(oracle.encodedRoot, oracle.rootHash, domain, null, null, 1, async (d) =>
      d === missing ? "{}" : oracle.nodes.get(d),
    ),
  ).rejects.toThrow();
  const final = await readLogicalRangePage(
    oracle.encodedRoot,
    oracle.rootHash,
    domain,
    null,
    null,
    2,
    async (d) => oracle.nodes.get(d),
  );
  expect(final.complete).toBe(true);
  expect(final.entries.length).toBe(2);
  expect(final.nextFromInclusive).toBeNull();
});

test("logical range empty intervals validate roots and invalid requests fail before node I/O", async () => {
  const f = fixture();
  await f.change(hex(1), null, hex(10));
  let calls = 0;
  const read = async (_digest: string): Promise<string | undefined> => {
    calls++;
    throw new Error("unexpected read");
  };
  const empty = emptyLogicalMap(domain);
  const emptyPage = await readLogicalRangePage(
    empty,
    logicalMapHash(empty, domain),
    domain,
    null,
    null,
    1,
    read,
  );
  expect(emptyPage.complete).toBe(true);
  expect(emptyPage.entries).toEqual([]);
  expect(emptyPage.nextFromInclusive).toBeNull();
  for (const [from, through] of [
    [hex(1), hex(1)],
    [hex(2), null],
    [null, hex(1)],
  ] as const) {
    const page = await readLogicalRangePage(f.root, f.hash, domain, from, through, 1, read);
    expect(page.complete).toBe(true);
    expect(page.entries).toEqual([]);
  }
  for (const limit of [0, -1, 257, 1.5, NaN, Infinity])
    await expect(
      readLogicalRangePage(f.root, f.hash, domain, null, null, limit, read),
    ).rejects.toThrow("logical_map_page_limit_invalid");
  await expect(
    readLogicalRangePage(f.root, f.hash, domain, hex(2), hex(1), 1, read),
  ).rejects.toThrow("logical_map_range_invalid");
  await expect(readLogicalRangePage(f.root, f.hash, domain, "bad", null, 1, read)).rejects.toThrow(
    "logical_map_digest_invalid",
  );
  await expect(
    readLogicalRangePage(f.root, hex(0), domain, hex(1), hex(1), 1, read),
  ).rejects.toThrow("logical_map_root_mismatch");
  await expect(readLogicalRangePage(f.root, f.hash, hex(0), null, null, 1, read)).rejects.toThrow(
    "logical_map_context_mismatch",
  );
  expect(calls).toBe(0);
});

test("logical roots are independent of insertion order, replacement history and physical readers", async () => {
  const values = new Map([
    [hex(0), hex(100)],
    [hex(7), hex(107)],
    [hex(255), hex(355)],
  ]);
  const expected = rebuildLogicalMap(domain, values);
  expect(expected.rootHash).toBe(
    "4324916c6be9d0994d439bb96e3e3cb2c4c2010487905cad26bb0facfc8398d8",
  );
  expect(logicalMapHash(emptyLogicalMap(domain), domain)).toBe(
    "bf06abae0c19638e95b6b752e491c6fe9defc53f17525aae54ce9092eae830ee",
  );
  for (const order of [
    [0, 7, 255],
    [0, 255, 7],
    [7, 0, 255],
    [7, 255, 0],
    [255, 0, 7],
    [255, 7, 0],
  ]) {
    const f = fixture();
    for (const i of order) await f.change(hex(i), null, hex(i + 100));
    expect(f.root).toBe(expected.encodedRoot);
    expect(f.hash).toBe(expected.rootHash);
    await f.change(hex(7), hex(107), hex(900));
    await f.change(hex(7), hex(900), hex(107));
    expect(f.root).toBe(expected.encodedRoot);
    const relocated = new Map([...expected.nodes].reverse());
    const observed = new Map<string, string>();
    const audit = await auditLogicalMap(
      f.root,
      f.hash,
      domain,
      async (d) => relocated.get(d),
      (k, v) => {
        observed.set(k, v);
      },
    );
    expect(observed).toEqual(values);
    expect(audit.population).toBe(3n);
    expect(audit.metrics.nodesRead).toBe(5);
    await f.change(hex(7), hex(107), null);
    await f.change(hex(7), null, hex(107));
    expect(f.root).toBe(expected.encodedRoot);
  }
});

test("seeded conditional mutations agree with full independent rebuild after every operation", async () => {
  for (const seed of [1, 47, 913]) {
    const f = fixture();
    const values = new Map<string, string>();
    let state = seed;
    for (let step = 0; step < 300; step++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const k = key(state % 64);
      const expected = values.get(k) ?? null;
      const next = step % 5 === 0 ? null : hex(state);
      const result = await f.change(k, expected, next);
      if (next === null) values.delete(k);
      else values.set(k, next);
      const oracle = rebuildLogicalMap(domain, values);
      expect(f.root).toBe(oracle.encodedRoot);
      expect(result.metrics.nodesRead).toBeLessThanOrEqual(257);
      expect(result.metrics.nodesCreated).toBeLessThanOrEqual(258);
      expect((await lookupLogicalValue(f.root, f.hash, domain, k, f.read)).value).toBe(next);
      expect(Object.isFrozen(result.nodes)).toBe(true);
    }
    const observed = new Map<string, string>();
    await auditLogicalMap(f.root, f.hash, domain, f.read, (k, v) => {
      observed.set(k, v);
    });
    expect(observed).toEqual(values);
  }
});

test("adversarial 256-bit paths remain bounded and deletions collapse to the canonical root", async () => {
  const values = new Map<string, string>([[hex(0), hex(999)]]);
  for (let bit = 0; bit < 256; bit++) values.set(hex(1n << BigInt(bit)), hex(bit));
  const oracle = rebuildLogicalMap(domain, values);
  const read = async (digest: string) => oracle.nodes.get(digest);
  const lookup = await lookupLogicalValue(
    oracle.encodedRoot,
    oracle.rootHash,
    domain,
    hex(0),
    read,
  );
  expect(lookup.value).toBe(hex(999));
  expect(lookup.metrics.nodesRead).toBe(257);
  const changed = await prepareLogicalChange(
    oracle.encodedRoot,
    oracle.rootHash,
    domain,
    hex(0),
    hex(999),
    null,
    read,
  );
  values.delete(hex(0));
  expect(changed.encodedRoot).toBe(rebuildLogicalMap(domain, values).encodedRoot);
  expect(changed.metrics.nodesRead).toBe(257);
  expect(changed.metrics.nodesCreated).toBe(255);
});

test("stale values, wrong domains and anchors fail without writing; no-op roots stay exact", async () => {
  const f = fixture();
  await f.change(hex(1), null, hex(10));
  const before = f.root;
  const count = f.nodes.size;
  await expect(f.change(hex(1), null, hex(11))).rejects.toThrow("logical_map_before_mismatch");
  await expect(f.change(hex(2), hex(10), hex(11))).rejects.toThrow("logical_map_before_mismatch");
  expect(f.root).toBe(before);
  expect(f.nodes.size).toBe(count);
  expect((await f.change(hex(1), hex(10), hex(10))).metrics.nodesCreated).toBe(0);
  expect((await f.change(hex(2), null, null)).metrics.nodesCreated).toBe(0);
  expect(f.root).toBe(before);
  let reads = 0;
  const read = async () => {
    reads++;
    return undefined;
  };
  await expect(lookupLogicalValue(f.root, hex(0), domain, hex(1), read)).rejects.toThrow(
    "logical_map_root_mismatch",
  );
  await expect(lookupLogicalValue(f.root, f.hash, hex(0), hex(1), read)).rejects.toThrow(
    "logical_map_context_mismatch",
  );
  await expect(lookupLogicalValue(f.root, f.hash, domain, "bad", read)).rejects.toThrow(
    "logical_map_digest_invalid",
  );
  expect(reads).toBe(0);
  await f.change(hex(1), hex(10), null);
  expect(f.root).toBe(emptyLogicalMap(domain));
});

test("missing and changed nodes never become absence; point proof is not full history verification", async () => {
  const f = fixture();
  await f.change(hex(0), null, hex(10));
  await f.change("f".repeat(64), null, hex(11));
  const root = JSON.parse(f.root);
  const parent = JSON.parse(f.nodes.get(root.tree.digest) ?? "null");
  f.nodes.delete(parent.right.digest);
  expect((await lookupLogicalValue(f.root, f.hash, domain, hex(0), f.read)).value).toBe(hex(10));
  await expect(lookupLogicalValue(f.root, f.hash, domain, "f".repeat(64), f.read)).rejects.toThrow(
    "logical_map_node_missing",
  );
  await expect(auditLogicalMap(f.root, f.hash, domain, f.read)).rejects.toThrow(
    "logical_map_node_missing",
  );
  f.nodes.set(parent.left.digest, JSON.stringify({ kind: "leaf", key: hex(0), value: hex(20) }));
  await expect(lookupLogicalValue(f.root, f.hash, domain, hex(0), f.read)).rejects.toThrow(
    "logical_map_node_mismatch",
  );
});

test("strict root and node decoding refuses unknown, noncanonical and oversized data", async () => {
  const f = fixture();
  await f.change(hex(1), null, hex(10));
  for (const root of [
    `${f.root} `,
    f.root.replace('"tree":', '"extra":0,"tree":'),
    f.root.replace('"count":"1"', '"count":"01"'),
  ])
    expect(() => logicalMapHash(root, domain)).toThrow();
  for (const body of [
    "x".repeat(2049),
    '{"kind":"leaf","key":"bad","value":"bad"}',
    '{"kind":"other","left":null,"right":null}',
    "[]",
    "null",
  ])
    await expect(
      lookupLogicalValue(f.root, f.hash, domain, hex(1), async () => body),
    ).rejects.toThrow();
  await expect(
    auditLogicalMap(f.root, f.hash, domain, f.read, () => {
      throw new Error("canonical population mismatch");
    }),
  ).rejects.toThrow("canonical population mismatch");
});

test("rehashed malformed branches cannot claim canonical prefixes, populations or ordering", async () => {
  const f = fixture();
  await f.change(hex(0), null, hex(10));
  await f.change("f".repeat(64), null, hex(11));
  const root = JSON.parse(f.root);
  const valid = JSON.parse(f.nodes.get(root.tree.digest) ?? "null");
  for (const node of [
    { ...valid, left: valid.right, right: valid.left },
    { ...valid, right: valid.left },
    { ...valid, left: { ...valid.left, count: "2" } },
    { ...valid, left: { ...valid.left, min: hex(0), max: "e".repeat(64), count: "2" } },
    {
      ...valid,
      left: { ...valid.left, min: hex(0), max: "7".repeat(64), count: "18446744073709551615" },
    },
    { ...valid, left: { ...valid.left, count: "18446744073709551616" } },
    { ...valid, left: { ...valid.left, extra: "not allowed" } },
  ]) {
    const body = JSON.stringify(node);
    const changed = {
      ...root,
      tree: {
        ...root.tree,
        digest: hashCanonical({ version: root.version, domain, kind: "node", encoded: body })
          .digest,
      },
    };
    const encoded = JSON.stringify(changed);
    const expected = logicalMapHash(encoded, domain);
    await expect(
      lookupLogicalValue(encoded, expected, domain, hex(0), async () => body),
    ).rejects.toThrow();
  }
});

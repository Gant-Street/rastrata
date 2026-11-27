import { expect, test } from "bun:test";
import {
  EntryError,
  buildEntry,
  checkLink,
  checkSchema,
  entryHash,
  parseEntry,
  payloadOf,
  sha256,
} from "../src/entry.ts";
import { decodeSegment, encodeSegment, segmentIdentity, verifySegment } from "../src/segment.ts";
import { GENESIS_HASH } from "../src/tier.ts";

const payload = (text: string) => new TextEncoder().encode(text);
const base = {
  bookId: "book-1",
  seq: 1,
  prev: GENESIS_HASH,
  writer: "pod-a#1",
  fence: 1,
  schema: 1,
  kind: "commit" as const,
  opId: "op-1",
  at: "2026-10-08T00:00:00.000Z",
  payload: payload("rows"),
  changes: 3,
};

function chainOf(count: number) {
  const entries = [];
  let prev = GENESIS_HASH;
  for (let seq = 1; seq <= count; seq += 1) {
    const built = buildEntry({ ...base, seq, prev, payload: payload(`payload ${seq}`) });
    entries.push(built);
    prev = built.header.hash;
  }
  return entries;
}

test("an entry round trips and its hash covers every field", () => {
  const built = buildEntry(base);
  const parsed = parseEntry(built.bytes);
  expect(parsed.header).toEqual(built.header);
  expect(new TextDecoder().decode(payloadOf(built.bytes))).toBe("rows");
  expect(built.header.payloadHash).toBe(sha256(payload("rows")));
  const variants = [
    { seq: 2 },
    { prev: "a".repeat(64) },
    { writer: "pod-b#1" },
    { fence: 2 },
    { schema: 2 },
    { kind: "genesis" as const },
    { opId: "op-2" },
    { opId: null },
    { at: "2026-10-08T00:00:01.000Z" },
    { payload: payload("other") },
    { changes: 4 },
    { bookId: "book-2" },
  ];
  const hashes = new Set([built.header.hash]);
  for (const variant of variants) hashes.add(buildEntry({ ...base, ...variant }).header.hash);
  expect(hashes.size).toBe(variants.length + 1);
});

test("the hash is the same however the payload was compressed", () => {
  const built = buildEntry(base);
  expect(entryHash(built.header)).toBe(built.header.hash);
  expect(buildEntry(base).header.hash).toBe(built.header.hash);
});

test("a flipped byte in the header, the payload or the framing is caught", () => {
  const built = buildEntry({ ...base, payload: payload("x".repeat(5000)) });
  const damage = (offset: number) => {
    const copy = built.bytes.slice();
    copy[offset] = (copy[offset] as number) ^ 0x55;
    return copy;
  };
  expect(() => parseEntry(damage(0))).toThrow(EntryError);
  expect(() => parseEntry(damage(9))).toThrow(EntryError);
  const headerLength = new DataView(built.bytes.buffer).getUint32(4);
  // A byte inside the compressed payload: the header still parses, the payload does not verify.
  const inside = damage(8 + headerLength + 12);
  expect(parseEntry(inside).header.hash).toBe(built.header.hash);
  expect(() => payloadOf(inside)).toThrow(EntryError);
  expect(() => parseEntry(built.bytes.slice(0, 6))).toThrow(EntryError);
});

test("the links of a chain are checked: book, sequence, previous hash", () => {
  const [one, two, three] = chainOf(3);
  expect(() => checkLink(null, one!.header, "book-1")).not.toThrow();
  expect(() => checkLink({ seq: 1, hash: one!.header.hash }, two!.header, "book-1")).not.toThrow();
  expect(() => checkLink({ seq: 1, hash: one!.header.hash }, three!.header, "book-1")).toThrow(
    /Expected entry 2/,
  );
  expect(() => checkLink({ seq: 1, hash: "b".repeat(64) }, two!.header, "book-1")).toThrow(
    /not chained/,
  );
  expect(() => checkLink(null, one!.header, "book-2")).toThrow(/belongs to book-1/);
  expect(() => checkLink(null, two!.header, "book-1")).toThrow(/Expected entry 1/);
});

test("an entry written by newer code is refused by older code", () => {
  const newer = buildEntry({ ...base, schema: 3 });
  expect(() => checkSchema(newer.header, 3)).not.toThrow();
  expect(() => checkSchema(newer.header, 2)).toThrow(/schema 3; this process supports 2/);
});

test("a segment holds consecutive entries and verifies as a chain", () => {
  const chain = chainOf(5);
  const segment = encodeSegment(chain.map((item) => item.bytes));
  expect(decodeSegment(segment)).toHaveLength(5);
  const verified = verifySegment(segment, "book-1", null);
  expect([verified.first, verified.last]).toEqual([1, 5]);
  expect(verified.lastHash).toBe(chain[4]!.header.hash);
  expect(segmentIdentity(segment)).toEqual(chain.map((item) => item.header.hash));
  const tail = encodeSegment(chain.slice(2).map((item) => item.bytes));
  expect(verifySegment(tail, "book-1", { seq: 2, hash: chain[1]!.header.hash }).last).toBe(5);
  expect(() => verifySegment(tail, "book-1", { seq: 2, hash: "c".repeat(64) })).toThrow(
    /not chained/,
  );
  const gapped = encodeSegment([chain[0]!.bytes, chain[2]!.bytes]);
  expect(() => verifySegment(gapped, "book-1", null)).toThrow(/Expected entry 2/);
  expect(() => verifySegment(encodeSegment([]), "book-1", null)).toThrow(/no entries/);
  expect(() => decodeSegment(segment.slice(0, segment.length - 3))).toThrow(EntryError);
});

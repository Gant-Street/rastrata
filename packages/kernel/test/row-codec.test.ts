import { expect, test } from "bun:test";
import {
  BOOK_ROW_COLLECTIONS, BOOK_ROW_CODEC_VERSION, decodeBookRow, encodeBookRow, isBookRowCollection,
  decodeDurableBook, encodeDurableBook, executeBookCommand, hashCanonical,
  ExactDecimal, ExactRational, type BookRowCollection, type DurableBookAggregate,
} from "../src/index.ts";
import { freshState } from "./fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";

function configuration() {
  const row = freshState().state.configurationSnapshots[0];
  if (!row) throw new Error("Missing initial configuration");
  return row;
}
type Node = [string, unknown];
function field(node: Node, name: string): Node | undefined {
  return (node[1] as [string, Node][]).find(([key]) => key === name)?.[1];
}
function verifyRows(aggregate: DurableBookAggregate) {
  const encoded = encodeDurableBook(aggregate);
  const body = JSON.parse(encoded).body as Node;
  let count = 0;
  for (const collection of BOOK_ROW_COLLECTIONS) {
    let source: Node | undefined = body;
    for (const part of collection.split(".")) source = source === undefined ? undefined : field(source, part);
    const nodes = source === undefined ? [] : collection === "state.openingBoundary" ? [source] : source[1] as Node[];
    for (const node of nodes) {
      const bytes = JSON.stringify(node);
      const decoded = decodeBookRow(collection, bytes);
      expect(decoded.disposition).toBe("decoded");
      if (decoded.disposition !== "decoded") throw new Error(decoded.message);
      expect(decoded.collection).toBe(collection);
      expect(encodeBookRow(collection, decoded.row)).toBe(bytes);
      expect(Object.isFrozen(decoded)).toBe(true);
      expect(Object.isFrozen(decoded.row)).toBe(true);
      count++;
    }
  }
  expect(encodeDurableBook(aggregate)).toBe(encoded);
  return count;
}

test("typed row catalog is closed, canonical, and matches exact legacy aggregate subtrees", async () => {
  expect(BOOK_ROW_CODEC_VERSION).toBe("rastrata-book-row-v1");
  expect(BOOK_ROW_COLLECTIONS.length).toBe(24);
  expect(new Set(BOOK_ROW_COLLECTIONS).size).toBe(24);
  expect(Object.isFrozen(BOOK_ROW_COLLECTIONS)).toBe(true);
  expect(isBookRowCollection("state.configurationSnapshots")).toBe(true);
  for (const unknown of [null, undefined, 1, "constructor", "__proto__", "state.periods", "state.unknown"])
    expect(isBookRowCollection(unknown)).toBe(false);
  const fresh = freshState();
  expect(verifyRows(fresh)).toBe(1);
  const committed = executeBookCommand(fresh.state, fresh.protocol, activationCommand());
  expect(committed.result.disposition).toBe("committed");
  expect(verifyRows({ state: committed.state, protocol: committed.protocol })).toBe(4);
  const rejected = executeBookCommand(committed.state, committed.protocol, activationCommand("again", 1n));
  expect(rejected.result.disposition).toBe("rejected");
  expect(verifyRows({ state: rejected.state, protocol: rejected.protocol })).toBe(5);
});

test("frozen inventory rows preserve exact numeric classes, nested immutability, and historic bytes", async () => {
  const raw = (await Bun.file(new URL("./data/inventory-adjustment-legacy.json", import.meta.url)).text()).trim();
  const decoded = decodeDurableBook(raw);
  if (decoded.disposition !== "decoded") throw new Error(decoded.message);
  expect(verifyRows(decoded.aggregate)).toBeGreaterThan(10);
  const lot = decoded.aggregate.state.lots[0];
  const journal = decoded.aggregate.state.journals[0];
  if (!lot || !journal) throw new Error("Missing numeric fixture rows");
  const row = decodeBookRow("state.lots", encodeBookRow("state.lots", lot));
  if (row.disposition !== "decoded") throw new Error(row.message);
  expect(row.row.acquisitionQuantity).toBeInstanceOf(ExactRational);
  expect(Object.isFrozen(row.row.evidenceIds)).toBe(true);
  const booked = decodeBookRow("state.journals", encodeBookRow("state.journals", journal));
  if (booked.disposition !== "decoded") throw new Error(booked.message);
  expect(booked.row.journal.postings[0]?.bookValue.amount).toBeInstanceOf(ExactDecimal);
  expect(Object.isFrozen(booked.row.journal.postings)).toBe(true);
  expect(() => { (booked.row.journal.postings as unknown[]).push("mutation"); }).toThrow();
  expect(encodeDurableBook(decoded.aggregate)).toBe(raw);
  function alterNumber(node: unknown, tag: "r" | "d"): boolean {
    if (!Array.isArray(node)) return false;
    if (node[0] === tag) {
      if (tag === "r") { node[1] = String(BigInt(node[1]) * 2n); node[2] = String(BigInt(node[2]) * 2n); }
      else node[2] = `0${node[2]}`;
      return true;
    }
    return node.some((child) => alterNumber(child, tag));
  }
  const rational = JSON.parse(encodeBookRow("state.lots", lot));
  expect(alterNumber(rational, "r")).toBe(true);
  expect(decodeBookRow("state.lots", JSON.stringify(rational)).disposition).toBe("rejected");
  const decimal = JSON.parse(encodeBookRow("state.journals", journal));
  expect(alterNumber(decimal, "d")).toBe(true);
  expect(decodeBookRow("state.journals", JSON.stringify(decimal)).disposition).toBe("rejected");
});

test("row decoding rejects unknown schemas, extra and duplicate fields, and noncanonical encodings", () => {
  const row = configuration();
  const original = encodeBookRow("state.configurationSnapshots", row);
  const node = JSON.parse(original) as Node;
  const pairs = node[1] as [string, Node][];
  const extra = JSON.parse(original) as Node;
  (extra[1] as unknown[]).push(["unexpected", ["s", "value"]]);
  const duplicate = JSON.parse(original) as Node;
  (duplicate[1] as unknown[]).push(pairs[0]);
  const unsorted = JSON.parse(original) as Node;
  (unsorted[1] as unknown[]).reverse();
  for (const encoded of ["null", "{broken", `${original} `, JSON.stringify(extra), JSON.stringify(duplicate), JSON.stringify(unsorted), original.replace('["i","0"]', '["i","-0"]')])
    expect(decodeBookRow("state.configurationSnapshots", encoded).disposition).toBe("rejected");
  for (const collection of ["unknown", "constructor", "__proto__"] as unknown as BookRowCollection[]) {
    expect(decodeBookRow(collection, original).disposition).toBe("rejected");
    expect(() => encodeBookRow(collection, row)).toThrow("Unknown durable book row collection");
  }
  expect(decodeBookRow("state.journals", original).disposition).toBe("rejected");
  const invalid = { ...row, extra: "unadmitted" };
  expect(() => encodeBookRow("state.configurationSnapshots", invalid)).toThrow();
});

test("row schema admission does not pretend to verify a content hash or whole-book closure", () => {
  const forged = { ...configuration(), contentHash: hashCanonical("forged configuration") };
  expect(decodeBookRow("state.configurationSnapshots", encodeBookRow("state.configurationSnapshots", forged)).disposition).toBe("decoded");
  const fresh = freshState();
  const aggregate = { state: { ...fresh.state, configurationSnapshots: [forged] }, protocol: fresh.protocol };
  expect(decodeDurableBook(encodeDurableBook(aggregate)).disposition).toBe("rejected");
});

test("row codec applies the durable UTF-8 byte limit before accepting a large subtree", () => {
  const row = configuration();
  const account = row.admissionSnapshot.accounts[0];
  if (!account) throw new Error("Missing account");
  const large = "€".repeat(6 * 1024 * 1024);
  const oversized = { ...row, admissionSnapshot: { ...row.admissionSnapshot, accounts: [{ ...account, name: large }] } };
  expect(() => encodeBookRow("state.configurationSnapshots", oversized)).toThrow("Durable row exceeds the byte limit");
  expect(decodeBookRow("state.configurationSnapshots", JSON.stringify(["s", large])).disposition).toBe("rejected");
  expect(decodeBookRow("state.configurationSnapshots", null as unknown as string).disposition).toBe("rejected");
  const baseRow = (pad: string) => ({
    ...row,
    admissionSnapshot: { ...row.admissionSnapshot, accounts: [{ ...account, name: `n${pad}` }] },
  });
  const overhead = new TextEncoder().encode(encodeBookRow("state.configurationSnapshots", baseRow(""))).byteLength;
  const boundaryRow = baseRow("x".repeat(16 * 1024 * 1024 - overhead));
  const boundaryEncoded = encodeBookRow("state.configurationSnapshots", boundaryRow);
  expect(new TextEncoder().encode(boundaryEncoded).byteLength).toBe(16 * 1024 * 1024);
  expect(decodeBookRow("state.configurationSnapshots", boundaryEncoded).disposition).toBe("decoded");
});

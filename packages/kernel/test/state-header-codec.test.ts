import { expect, test } from "bun:test";
import {
  BOOK_STATE_HEADER_CODEC_VERSION, decodeBookStateHeader, encodeBookStateHeader,
  encodeDurableBook, hashCanonical, hashFinancialIdentity,
  type BookStateHeader,
} from "../src/index.ts";
import { freshState } from "./fixtures.ts";

function header(): BookStateHeader {
  const state = freshState().state;
  return { identity: state.identity, financialIdentityHash: state.financialIdentityHash,
    status: state.status, bookRevision: state.bookRevision, latestPostingSequence: state.latestPostingSequence,
    configurationRevision: state.configurationRevision, configurationHash: state.configurationHash };
}

test("closed scalar header preserves exact legacy field subtrees without posing as whole state", () => {
  expect(BOOK_STATE_HEADER_CODEC_VERSION).toBe("rastrata-book-state-header-v1");
  const original = encodeDurableBook(freshState());
  const encoded = encodeBookStateHeader(header());
  const stateNode = JSON.parse(original).body[1].find(([key]: [string]) => key === "state")[1];
  const keys = new Set(Object.keys(header()));
  expect(JSON.parse(encoded)).toEqual(["o", stateNode[1].filter(([key]: [string]) => keys.has(key))]);
  const decoded = decodeBookStateHeader(encoded);
  if (decoded.disposition !== "decoded") throw new Error(decoded.message);
  expect(decoded.header).toEqual(header());
  expect(Object.isFrozen(decoded)).toBe(true);
  expect(Object.isFrozen(decoded.header.identity)).toBe(true);
  expect(Object.isFrozen(decoded.header.configurationHash)).toBe(true);
  expect(Object.keys(decoded.header).sort()).toEqual([...keys].sort());
  expect(encodeDurableBook(freshState())).toBe(original);
  // Exact framing, not an assertion that these populations actually exist.
  for (const count of [2n ** 53n + 1n, 10n ** 64n - 1n]) {
    const value = { ...header(), bookRevision: count, latestPostingSequence: count, configurationRevision: count };
    expect(decodeBookStateHeader(encodeBookStateHeader(value))).toEqual({ disposition: "decoded", header: value });
  }
});

test("header refuses illegal counters, forged identity, extra fields and legacy aggregates", () => {
  const good = header();
  for (const field of ["bookRevision", "latestPostingSequence", "configurationRevision"] as const)
    for (const value of [-1n, 10n ** 64n, 1, "0"])
      expect(() => encodeBookStateHeader({ ...good, [field]: value } as BookStateHeader)).toThrow();
  for (const value of [
    { ...good, configurationRevision: 1n },
    { ...good, financialIdentityHash: hashCanonical("forged") },
    { ...good, configurationHash: { ...good.configurationHash, algorithm: "other" } },
    { ...good, identity: { ...good.identity, bookId: "other" } },
    { ...good, status: "unknown" },
    { ...good, contentHash: hashCanonical("legacy") },
    { ...good, configurationSnapshots: [] },
    freshState().state,
  ]) expect(() => encodeBookStateHeader(value as BookStateHeader)).toThrow();
  const { configurationHash: _removed, ...missing } = good;
  expect(() => encodeBookStateHeader(missing as BookStateHeader)).toThrow();
});

test("header decoder rejects malformed, duplicate, reordered and noncanonical wire", () => {
  const original = encodeBookStateHeader(header());
  const duplicate = JSON.parse(original);
  duplicate[1].push(duplicate[1][0]);
  const reversed = JSON.parse(original);
  reversed[1].reverse();
  for (const encoded of [
    "null", "{broken", `${original} `, JSON.stringify(duplicate), JSON.stringify(reversed),
    original.replace('["i","0"]', '["i","-0"]'), encodeDurableBook(freshState()),
    null as unknown as string,
  ]) expect(decodeBookStateHeader(encoded).disposition).toBe("rejected");
});

test("header checks UTF-8 byte bounds on both encoding and decoding", () => {
  const good = header();
  const identity = { ...good.identity, code: "€".repeat(22_000) };
  expect(() => encodeBookStateHeader({ ...good, identity, financialIdentityHash: hashFinancialIdentity(identity) })).toThrow("State header exceeds the byte limit");
  expect(decodeBookStateHeader(JSON.stringify(["s", identity.code])).disposition).toBe("rejected");
  const smallIdentity = { ...good.identity, code: "€".repeat(100) };
  const small = { ...good, identity: smallIdentity, financialIdentityHash: hashFinancialIdentity(smallIdentity) };
  expect(decodeBookStateHeader(encodeBookStateHeader(small))).toEqual({ disposition: "decoded", header: small });
  const baseHeader = (pad: string) => {
    const ident = { ...good.identity, code: `c${pad}` };
    return { ...good, identity: ident, financialIdentityHash: hashFinancialIdentity(ident) };
  };
  const baseEncoded = encodeBookStateHeader(baseHeader(""));
  const overhead = new TextEncoder().encode(baseEncoded).byteLength;
  const boundaryHeader = baseHeader("x".repeat(65_536 - overhead));
  const boundaryEncoded = encodeBookStateHeader(boundaryHeader);
  expect(new TextEncoder().encode(boundaryEncoded).byteLength).toBe(65_536);
  expect(decodeBookStateHeader(boundaryEncoded).disposition).toBe("decoded");
});

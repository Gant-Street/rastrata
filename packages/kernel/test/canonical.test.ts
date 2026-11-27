import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  CANONICALIZATION_VERSION,
  CONTENT_HASH_ALGORITHM,
  canonicalEncode,
  hashCanonical,
  hashCanonicalSequenceField,
  hashBookLedgerCutoff,
  bookId,
  identifier,
  IdentityError,
  type CanonicalValue,
} from "../src/index.ts";
import { isKnownIanaTimeZone } from "../src/iana-timezones.ts";
import { compareCanonicalText } from "../src/canonical.ts";

test("streaming sequence fields preserve exact canonical bytes and require the declared population", () => {
  const values = [null, "é", 123n, { amount: -7n }] as const;
  for (const field of ["first", "Ω", "😀", "z"]) {
    const fields = { middle: "snapshot", a: true };
    expect(hashCanonicalSequenceField(fields, field, 4n, values)).toEqual(hashCanonical({ ...fields, [field]: values }));
    expect(hashCanonicalSequenceField(fields, field, 0n, [])).toEqual(hashCanonical({ ...fields, [field]: [] }));
  }
  for (const length of [-1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n, 2 as never])
    expect(() => hashCanonicalSequenceField({}, "rows", length, [])).toThrow("Invalid canonical sequence field");
  expect(() => hashCanonicalSequenceField({}, "rows", BigInt(Number.MAX_SAFE_INTEGER), [])).toThrow("Canonical sequence is incomplete");
  expect(() => hashCanonicalSequenceField({ rows: [] }, "rows", 0n, [])).toThrow("Invalid canonical sequence field");
  expect(() => hashCanonicalSequenceField([] as never, "rows", 0n, [])).toThrow("Invalid canonical sequence field");
  expect(() => hashCanonicalSequenceField({}, 1 as never, 0n, [])).toThrow("Invalid canonical sequence field");
  expect(() => hashCanonicalSequenceField({}, "rows", 1n, [])).toThrow("Canonical sequence is incomplete");
  let closed = false;
  function* tooMany() { try { yield 1n; yield 2n; } finally { closed = true; } }
  expect(() => hashCanonicalSequenceField({}, "rows", 1n, tooMany())).toThrow("exceeds its declared population");
  expect(closed).toBeTrue();
});

test("streamed ledger cutoffs match the legacy record and reject damaged ordinal populations", () => {
  const book = bookId("cutoff-book");
  const journals = [1n, 2n, 3n].map((postingSequence) => ({ postingSequence, canonicalHash: hashCanonical({ postingSequence }) }));
  for (const length of [0, 1, 3]) {
    const selected = journals.slice(0, length);
    expect(hashBookLedgerCutoff(book, 4n, BigInt(length), selected)).toEqual(hashCanonical({
      type: "LedgerCutoff", bookId: book, bookRevision: 4n, postingSequence: BigInt(length),
      journalHashes: selected.map((journal) => ({ ...journal.canonicalHash })),
    }));
  }
  expect(() => hashBookLedgerCutoff(book, 4n, 3n, journals.slice(1))).toThrow("Incomplete or corrupt ledger cutoff population");
  expect(() => hashBookLedgerCutoff(book, 4n, 3n, journals.slice(0, 2))).toThrow("Canonical sequence is incomplete");
  const first = journals[0]!;
  for (const patch of [{ algorithm: "sha512" }, { canonicalizationVersion: "future" }, { digest: "bad" }])
    expect(() => hashBookLedgerCutoff(book, 4n, 1n, [{ ...first, canonicalHash: { ...first.canonicalHash, ...patch } } as never])).toThrow("Incomplete or corrupt ledger cutoff population");
});

describe("canonical identity (ACC-019, ACC-038)", () => {
  test("orders text by exact code units, including equality and non-ASCII identifiers", () => {
    expect(compareCanonicalText("z", "ä")).toBe(-1);
    expect(compareCanonicalText("ä", "z")).toBe(1);
    expect(compareCanonicalText("ä", "ä")).toBe(0);
    expect(compareCanonicalText("A", "a")).toBe(-1);
    expect(compareCanonicalText("𐀀", "")).toBe(-1);
  });
  test("sorts record keys before encoding and hashing", () => {
    const left = { beta: 2n, alpha: "one" };
    const right = { alpha: "one", beta: 2n };

    expect(canonicalEncode(left)).toEqual(canonicalEncode(right));
    expect(hashCanonical(left)).toEqual(hashCanonical(right));
    expect(canonicalEncode([1n, 2n])).toBeInstanceOf(Uint8Array);
    const nullPrototype = Object.assign(Object.create(null) as Record<string, CanonicalValue>, { alpha: 1n });
    expect(canonicalEncode(nullPrototype)).toEqual(canonicalEncode({ alpha: 1n }));
  });

  test("returns a typed algorithm and canonicalization version", () => {
    const hash = hashCanonical({ type: "example", amount: 100n });

    expect(hash.algorithm).toBe(CONTENT_HASH_ALGORITHM);
    expect(hash.canonicalizationVersion).toBe(CANONICALIZATION_VERSION);
    expect(hash.digest).toBe("55976bb5085548c09a0091611fb2f56d1f71bfc57fcb55c8d871b27ef347e18f");
  });

  test("streamed hashing matches materialized canonical bytes across exact buffer boundaries", () => {
    for (const length of [0, 1, 4_088, 4_089, 4_090, 4_095, 4_096, 4_097, 16_375, 16_376, 16_377, 16_383, 16_384, 16_385, 32_767, 32_768, 32_769, 100_000]) {
      const bytes = new Uint8Array(length + 9);
      for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
      for (const value of [bytes.subarray(4, 4 + length), "x".repeat(length), [false, "€😀\ufffd".repeat(Math.floor(length / 8)), null, -9007199254740993n]] as CanonicalValue[]) {
        expect(hashCanonical(value).digest).toBe(createHash("sha256").update(canonicalEncode(value)).digest("hex"));
      }
    }
    // Decimal integer text is emitted through the ASCII path, including flushes
    // inside a single token. This does not change the kernel's arithmetic limits.
    const largeInteger = -BigInt("9".repeat(32_769));
    expect(hashCanonical(largeInteger).digest).toBe(createHash("sha256").update(canonicalEncode(largeInteger)).digest("hex"));
    const mutable = { value: new Uint8Array([1, 2, 3]) };
    const first = hashCanonical(mutable);
    mutable.value[0] = 4;
    expect(hashCanonical(mutable).digest).not.toBe(first.digest);
    expect(hashCanonical(mutable).digest).toBe(createHash("sha256").update(canonicalEncode(mutable)).digest("hex"));
  });

  test("canonical arrays inspect own data without invoking accessors or inherited iterators", () => {
    for (const encode of [canonicalEncode, hashCanonical]) {
      let invoked = false;
      const accessor: CanonicalValue[] = [1n];
      Object.defineProperty(accessor, "0", { enumerable: true, get() { invoked = true; return 2n; } });
      expect(() => encode(accessor)).toThrow("Canonical arrays require enumerable data properties");
      expect(invoked).toBe(false);
      const hidden = Object.defineProperty([1n], "0", { value: 1n, enumerable: false });
      expect(() => encode(hidden)).toThrow("Canonical arrays require enumerable data properties");
      const inherited = Object.setPrototypeOf([1n], { [Symbol.iterator]() { invoked = true; throw new Error("Untrusted iterator"); } });
      expect(encode(inherited)).toEqual(encode([1n]));
      expect(invoked).toBe(false);
    }
  });

  test("rejects unsupported floating-point canonical values", () => {
    expect(() => canonicalEncode(1.5 as unknown as CanonicalValue)).toThrow(
      "Unsupported canonical value: number",
    );
    expect(() => hashCanonical(["x".repeat(8_193), 1.5 as unknown as CanonicalValue])).toThrow(
      "Unsupported canonical value: number",
    );
    expect(hashCanonical({ type: "example", amount: 100n }).digest).toBe("55976bb5085548c09a0091611fb2f56d1f71bfc57fcb55c8d871b27ef347e18f");
  });

  test("rejects hidden, symbolic, accessor, sparse, and decorated data", () => {
    const hidden = Object.defineProperty({}, "amount", { value: 1n, enumerable: false });
    const symbolic = { [Symbol("amount")]: 1n };
    const accessor = Object.defineProperty({}, "amount", { get: () => 1n, enumerable: true });
    const sparse = new Array<CanonicalValue>(2);
    const decorated = [1n] as CanonicalValue[] & { note?: string };
    decorated.note = "ignored if not rejected";

    expect(() => canonicalEncode(hidden as CanonicalValue)).toThrow(
      "Canonical records require enumerable data properties",
    );
    expect(() => canonicalEncode(symbolic as CanonicalValue)).toThrow(
      "Canonical records must not contain symbol properties",
    );
    expect(() => canonicalEncode(accessor as CanonicalValue)).toThrow(
      "Canonical records require enumerable data properties",
    );
    expect(() => canonicalEncode(sparse)).toThrow("Canonical arrays must be dense");
    expect(() => canonicalEncode(decorated)).toThrow("Canonical arrays must be dense");
  });

  test("rejects a proxy array whose visible index equals its reported length", () => {
    const disguised = new Proxy<CanonicalValue[]>([1n, 2n], {
      get(target, property, receiver) { return property === "length" ? 1 : Reflect.get(target, property, receiver); },
      ownKeys() { return ["length", "1"]; },
    });
    // Both traps are legal for an extensible Array with writable length. Array
    // construction invariants alone do not authenticate a caller's view.
    expect(() => canonicalEncode(disguised)).toThrow("Canonical arrays must be dense");
    expect(() => hashCanonical(disguised)).toThrow("Canonical arrays must be dense");
  });

  test("rejects empty, padded, control, and non-normalized identifiers", () => {
    expect(() => identifier<"Test">("")).toThrow(IdentityError);
    expect(() => identifier<"Test">(" padded ")).toThrow(IdentityError);
    expect(() => identifier<"Test">("bad\u0000id")).toThrow(IdentityError);
    expect(() => identifier<"Test">("e\u0301")).toThrow(IdentityError);
    expect(String(identifier<"Test">("é"))).toBe("é");
  });

  test("admits the exact pinned time-zone identifier length boundaries", () => {
    expect(isKnownIanaTimeZone("UTC")).toBeTrue();
    expect(isKnownIanaTimeZone("UT")).toBeFalse();
    expect(isKnownIanaTimeZone("x".repeat(65))).toBeFalse();
  });
});

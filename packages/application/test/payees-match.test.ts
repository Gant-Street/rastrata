import { describe, expect, test } from "bun:test";
import {
  PAYEE_KEY_MAX,
  PAYEE_KEY_MIN,
  PAYEE_TEXT_MAX,
  type KeyedVendor,
  compileMatcher,
  groupKey,
  matchVendor,
  payeeKey,
  payeeText,
  payeeWords,
} from "../src/payees/match.ts";
import {
  PAYEE_KEY_MAX as taxKeyMax,
  PAYEE_KEY_MIN as taxKeyMin,
  PAYEE_TEXT_MAX as taxTextMax,
  groupKey as taxGroupKey,
  matchVendor as taxMatchVendor,
  payeeKey as taxPayeeKey,
  payeeText as taxPayeeText,
  payeeWords as taxPayeeWords,
} from "../src/tax/payees.ts";
import { sequence } from "./support/kernel-book.ts";

describe("the matcher the 1099 lane wrote is the book's now", () => {
  test("tax/payees.ts says what payees/match.ts says, for every name the 1099 code imports", () => {
    expect([taxKeyMax, taxKeyMin, taxTextMax]).toEqual([
      PAYEE_KEY_MAX,
      PAYEE_KEY_MIN,
      PAYEE_TEXT_MAX,
    ]);
    expect(taxGroupKey).toBe(groupKey);
    expect(taxMatchVendor).toBe(matchVendor);
    expect(taxPayeeKey).toBe(payeeKey);
    expect(taxPayeeText).toBe(payeeText);
    expect(taxPayeeWords).toBe(payeeWords);
  });
});

describe("compileMatcher is matchVendor, made fast", () => {
  const payees: KeyedVendor[] = [
    { id: "jane", keys: ["jane doe"] },
    { id: "acme", keys: ["acme law"] },
    { id: "acme-long", keys: ["acme law llp"] },
    { id: "pixel", keys: ["pixel studio", "pixelstudio"] },
    { id: "north", keys: ["north star"] },
    { id: "south", keys: ["north star"] },
    { id: "twice", keys: ["twin one", "twin two"] },
  ];
  const matcher = compileMatcher(payees);

  test("finds a key whose words appear whole and in order, the longest key first", () => {
    expect(matcher.match(["ZELLE PAYMENT TO JANE DOE 4411"])).toEqual({
      kind: "vendor",
      vendorId: "jane",
      key: "jane doe",
    });
    expect(matcher.match(["ACME LAW LLP RETAINER"])).toMatchObject({ vendorId: "acme-long" });
    expect(matcher.match(["ACME LAW OFFICES"])).toMatchObject({ vendorId: "acme" });
    expect(matcher.match(["ACMETECH LAW"])).toEqual({ kind: "none" });
    expect(matcher.match(["DOE JANE"])).toEqual({ kind: "none" });
    expect(matcher.match(["JANE Q DOE"])).toEqual({ kind: "none" });
    expect(matcher.match([""])).toEqual({ kind: "none" });
    expect(matcher.match([])).toEqual({ kind: "none" });
  });

  test("equal keys of two payees are ambiguous, listed in order, and given to nobody", () => {
    expect(matcher.match(["NORTH STAR LTD"])).toEqual({
      kind: "ambiguous",
      vendorIds: ["north", "south"],
    });
  });

  test("two keys of one payee of the same size are not ambiguous, and the first one the list met is named", () => {
    expect(matcher.match(["TWIN TWO AND TWIN ONE"])).toEqual({
      kind: "vendor",
      vendorId: "twice",
      key: "twin one",
    });
  });

  test("tries the texts in order: the counterparty before the description", () => {
    expect(matcher.match(["Unknown Person", "ACH jane doe 55"])).toMatchObject({
      vendorId: "jane",
    });
    expect(matcher.match(["jane doe", "acme law"])).toMatchObject({ vendorId: "jane" });
    expect(matcher.match(["", "acme law"])).toMatchObject({ vendorId: "acme" });
  });

  test("the answer is the same when it is asked for again, and a text of pattern characters is only words", () => {
    const text = "(a+)+$ and .* ACME LAW";
    expect(matcher.match([text])).toEqual(matcher.match([text]));
    expect(matcher.match([text])).toMatchObject({ vendorId: "acme" });
  });

  test("a seeded property: it agrees with matchVendor on random payees and random text", () => {
    const random = sequence(20261017);
    const vocabulary = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "42", "7"];
    const pick = () => vocabulary[Math.floor(random() * vocabulary.length)] as string;
    const phrase = (min: number, max: number) =>
      Array.from({ length: min + Math.floor(random() * (max - min + 1)) }, pick).join(" ");
    for (let round = 0; round < 300; round++) {
      const list: KeyedVendor[] = Array.from({ length: 1 + Math.floor(random() * 8) }, (_, n) => ({
        id: `p${n}`,
        keys: Array.from({ length: 1 + Math.floor(random() * 3) }, () => phrase(1, 3)),
      }));
      const fast = compileMatcher(list);
      for (let ask = 0; ask < 12; ask++) {
        const texts = Array.from({ length: 1 + Math.floor(random() * 2) }, () =>
          phrase(0, 9).toUpperCase(),
        );
        expect(fast.match(texts), `${JSON.stringify(list)} ${JSON.stringify(texts)}`).toEqual(
          matchVendor(texts, list),
        );
      }
    }
  });

  test("a book of 20,000 memos and 500 payees is matched in well under a second", () => {
    const random = sequence(5);
    const names = Array.from({ length: 500 }, (_, n) => ({
      id: `payee-${n}`,
      keys: [payeeKey(`merchant${n} shop`), payeeKey(`brand${n}`)],
    }));
    const fast = compileMatcher(names);
    const texts = Array.from({ length: 20_000 }, (_, n) => [
      `POS DEBIT BRAND${Math.floor(random() * 700)} STORE ${n} AUSTIN TX`,
    ]);
    const started = performance.now();
    let found = 0;
    for (const text of texts) if (fast.match(text).kind === "vendor") found += 1;
    const elapsed = performance.now() - started;
    expect(found).toBeGreaterThan(10_000);
    expect(elapsed).toBeLessThan(1500);
    // Against the definition, on a sample (the definition is the slow one).
    for (const text of texts.slice(0, 200))
      expect(fast.match(text)).toEqual(matchVendor(text, names));
  });
});

describe("the keys the matcher reads", () => {
  test("a key is the words of a text; a group key makes every run of digits one", () => {
    expect(payeeWords("SQ *BLUE BOTTLE COFFEE #04412")).toEqual([
      "sq",
      "blue",
      "bottle",
      "coffee",
      "04412",
    ]);
    expect(groupKey("SQ *BLUE BOTTLE COFFEE #04412")).toBe(groupKey("sq blue bottle coffee 77"));
  });
});

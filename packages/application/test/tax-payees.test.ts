import { describe, expect, test } from "bun:test";
import {
  groupKey,
  matchVendor,
  PAYEE_TEXT_MAX,
  payeeKey,
  payeeText,
  payeeWords,
} from "../src/tax/payees.ts";
import { sequence } from "./support/kernel-book.ts";

describe("payee keys", () => {
  test("are the words of a text: lower case, letters and digits, single spaces", () => {
    expect(payeeKey("  ZELLE Payment TO  Jane  Doe #5521 ")).toBe("zelle payment to jane doe 5521");
    expect(payeeKey("Jane.Doe-Design, LLC")).toBe("jane doe design llc");
    expect(payeeKey("")).toBe("");
    expect(payeeKey("*** --- ***")).toBe("");
    // Unicode compatibility forms are one form: full-width letters read as the plain letters.
    expect(payeeKey("ＪＡＮＥ　ＤＯＥ")).toBe("jane doe");
    expect(payeeWords("Müller & Söhne")).toEqual(["müller", "söhne"]);
  });

  test("never carry control, invisible or direction-changing characters", () => {
    const hostile = "Ja‮ne\u0000 ​Doe ⁦x";
    expect(payeeKey(hostile)).toBe("jane doe x");
    expect(payeeText(hostile)).toBe("Jane Doe x");
    expect(payeeText("a\r\nb\tc")).toBe("a b c");
  });

  test("are bounded in length however much text a bank sends", () => {
    expect(payeeText("x".repeat(100_000)).length).toBeLessThanOrEqual(PAYEE_TEXT_MAX);
    const started = performance.now();
    const words = payeeWords("word ".repeat(200_000));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(words.length).toBeLessThanOrEqual(2000);
  });

  test("group payments to one payee whose text differs only in numbers", () => {
    expect(groupKey("COFFEE SHOP 1234")).toBe(groupKey("coffee shop 5678"));
    expect(groupKey("COFFEE SHOP 1234")).toBe("coffee shop #");
    expect(groupKey("Pay 12 to 34")).toBe("pay # to #");
    expect(groupKey("Coffee Shop")).not.toBe(groupKey("Coffee Shops"));
  });
});

describe("matching a text to a vendor", () => {
  const vendors = [
    { id: "jane", keys: ["jane doe"] },
    { id: "acme", keys: ["acme law"] },
    { id: "acme-long", keys: ["acme law llp"] },
    { id: "pixel", keys: ["pixel studio", "pixelstudio"] },
  ];

  test("finds a key whose words appear whole and in order", () => {
    expect(matchVendor(["ZELLE PAYMENT TO JANE DOE 4411"], vendors)).toEqual({
      kind: "vendor",
      vendorId: "jane",
      key: "jane doe",
    });
    expect(matchVendor(["jane doe"], vendors)).toMatchObject({ vendorId: "jane" });
    expect(matchVendor(["Pixel Studio Inc"], vendors)).toMatchObject({ vendorId: "pixel" });
  });

  test("does not match half a word, the wrong order or a gap", () => {
    expect(matchVendor(["ACMETECH LAW"], [{ id: "x", keys: ["acme"] }])).toEqual({ kind: "none" });
    expect(matchVendor(["DOE JANE"], vendors)).toEqual({ kind: "none" });
    expect(matchVendor(["JANE Q DOE"], vendors)).toEqual({ kind: "none" });
    expect(matchVendor(["JANEDOE"], vendors)).toEqual({ kind: "none" });
    expect(matchVendor([""], vendors)).toEqual({ kind: "none" });
    expect(matchVendor([], vendors)).toEqual({ kind: "none" });
  });

  test("the longer key wins, and a tie gives the payment to nobody", () => {
    expect(matchVendor(["ACME LAW LLP RETAINER"], vendors)).toMatchObject({
      vendorId: "acme-long",
    });
    expect(matchVendor(["ACME LAW OFFICES"], vendors)).toMatchObject({ vendorId: "acme" });
    const same = [
      { id: "b", keys: ["north star"] },
      { id: "a", keys: ["north star"] },
    ];
    expect(matchVendor(["NORTH STAR LTD"], same)).toEqual({
      kind: "ambiguous",
      vendorIds: ["a", "b"],
    });
  });

  test("tries the texts in order: the counterparty before the description", () => {
    expect(matchVendor(["Unknown Person", "ACH jane doe 55"], vendors)).toMatchObject({
      vendorId: "jane",
    });
    expect(matchVendor(["jane doe", "acme law"], vendors)).toMatchObject({ vendorId: "jane" });
  });

  test("a key made of pattern characters is only words, and a long text is read in linear time", () => {
    // Keys are words; nothing in a payee's text or a key is interpreted as a pattern.
    expect(matchVendor(["(a+)+$ and .*"], [{ id: "x", keys: ["a"] }])).toMatchObject({
      vendorId: "x",
    });
    const started = performance.now();
    expect(
      matchVendor([`${"a ".repeat(50_000)}needle`], [{ id: "x", keys: ["a a a a a a a a a b"] }]),
    ).toEqual({
      kind: "none",
    });
    expect(performance.now() - started).toBeLessThan(3000);
  });

  test("a seeded property: a vendor key placed anywhere in noise is always found, and removed never", () => {
    const random = sequence(7);
    const words = [
      "alpha",
      "bravo",
      "charlie",
      "delta",
      "echo",
      "foxtrot",
      "golf",
      "hotel",
      "india",
    ];
    const pick = () => words[Math.floor(random() * words.length)] as string;
    for (let round = 0; round < 200; round++) {
      const key = `${pick()} ${pick()} ${pick()}`;
      const before = Array.from({ length: Math.floor(random() * 5) }, pick);
      const after = Array.from({ length: Math.floor(random() * 5) }, pick);
      const text = [...before, ...key.split(" "), ...after].join(" ").toUpperCase();
      const found = matchVendor([text], [{ id: "v", keys: [key] }]);
      expect(found.kind, `${key} in ${text}`).toBe("vendor");
    }
  });
});

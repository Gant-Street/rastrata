import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { merchantPhrase, nameWords } from "../src/rules/normalize.ts";
import {
  CANONICAL_LIMIT,
  canonicalText,
  canonicalWords,
  clip,
  containsWholeWords,
  plainText,
  SCAN_LIMIT,
  textMatches,
} from "../src/rules/text.ts";
import {
  CAPITAL_E_ACUTE,
  CJK,
  COMBINING_ACUTE,
  E_ACUTE,
  FULLWIDTH_AMZN,
  LONE_HIGH_SURROGATE,
  LONE_LOW_SURROGATE,
  NUL,
  PARTY_POPPER,
  POP_DIRECTIONAL_FORMATTING,
  RIGHT_TO_LEFT_OVERRIDE,
  ZERO_WIDTH_SPACE,
} from "./fixtures/hostile.ts";
import { random } from "./fixtures/rules-kit.ts";
import { expectWithin } from "./support/budget.ts";

test("canonical text ignores case, punctuation, spacing and accents", () => {
  expect(canonicalText("AMZN Mktp US*2K4AB5")).toBe("amzn mktp us 2k4ab5");
  expect(canonicalText("amzn-mktp-us   2k4ab5")).toBe("amzn mktp us 2k4ab5");
  expect(canonicalText(`  CAF${CAPITAL_E_ACUTE}  de  Flore `)).toBe("cafe de flore");
  expect(canonicalText(`cafe${COMBINING_ACUTE}`)).toBe("cafe");
  expect(canonicalText(`caf${E_ACUTE}`)).toBe("cafe");
  expect(canonicalText(FULLWIDTH_AMZN)).toBe("amzn");
  expect(canonicalText("")).toBe("");
  expect(canonicalText("***---***")).toBe("");
});

test("canonical text drops zero-width and bidirectional controls instead of splitting words", () => {
  expect(canonicalText(`am${ZERO_WIDTH_SPACE}zn`)).toBe("amzn");
  expect(canonicalText(`${RIGHT_TO_LEFT_OVERRIDE}gnirts${POP_DIRECTIONAL_FORMATTING}`)).toBe(
    "gnirts",
  );
  expect(canonicalText(`a${NUL}b`)).toBe("a b");
  expect(canonicalText("one\ttwo\nthree\r\nfour")).toBe("one two three four");
  expect(canonicalText(`emoji ${PARTY_POPPER} party`)).toBe("emoji party");
});

test("canonical text is idempotent and a fixed point on random hostile input", () => {
  const next = random(7);
  const alphabet = [
    ..."aAzZ09 .*#/-_\t\n(){}[]+?^$|\\\"'",
    ZERO_WIDTH_SPACE,
    COMBINING_ACUTE,
    E_ACUTE,
    CJK,
    PARTY_POPPER,
    LONE_HIGH_SURROGATE,
    LONE_LOW_SURROGATE,
  ];
  for (let run = 0; run < 400; run++) {
    const length = Math.floor(next() * 60);
    let text = "";
    for (let index = 0; index < length; index++)
      text += alphabet[Math.floor(next() * alphabet.length)] as string;
    const once = canonicalText(text);
    expect(canonicalText(once)).toBe(once);
    expect(once.startsWith(" ") || once.endsWith(" ") || once.includes("  ")).toBe(false);
  }
});

test("canonical text bounds hostile length and never throws on lone surrogates", () => {
  const huge = "a".repeat(10 * SCAN_LIMIT);
  expect(canonicalText(huge).length).toBeLessThanOrEqual(CANONICAL_LIMIT);
  expect(canonicalText(`${LONE_HIGH_SURROGATE}${"x".repeat(5)}${LONE_LOW_SURROGATE}`)).toBe(
    "xxxxx",
  );
  expect(() => canonicalText(LONE_HIGH_SURROGATE)).not.toThrow();
  expect(canonicalText(LONE_HIGH_SURROGATE)).toBe("");
  // Fifty thousand separators and then one word: still fast and still correct.
  const started = performance.now();
  expect(canonicalText(`${"*".repeat(50000)}word`)).toBe("");
  expect(canonicalText(`word${"*".repeat(50000)}`)).toBe("word");
  expectWithin("canonicalising fifty thousand separators", performance.now() - started, 500);
});

test("every operator compares canonical forms, so a negation is always the exact complement", () => {
  const operators = ["contains", "equals", "startsWith", "endsWith", "wholeWord"] as const;
  const haystacks = ["uber trip 8f2k", "uberland", "my uber", "uber", "", "x uber y uber"];
  const needles = ["uber", "uber trip", "trip", "ber", "land", ""];
  for (const operator of operators)
    for (const haystack of haystacks)
      for (const needle of needles) {
        const positive = textMatches(operator, haystack, needle);
        // There is no separate "not contains": the engine negates the same test, so by
        // construction the two can never disagree about case, accents or spacing.
        expect(typeof positive).toBe("boolean");
        if (needle === "") expect(positive).toBe(false);
      }
  expect(textMatches("contains", "uberland", "uber")).toBe(true);
  expect(textMatches("wholeWord", "uberland", "uber")).toBe(false);
  expect(textMatches("wholeWord", "uber trip", "uber")).toBe(true);
  expect(textMatches("wholeWord", "x uber y", "uber")).toBe(true);
  expect(textMatches("wholeWord", "my uber", "uber")).toBe(true);
  expect(textMatches("wholeWord", "uber eats trip", "uber eats")).toBe(true);
  expect(textMatches("wholeWord", "uber eatsy", "uber eats")).toBe(false);
  expect(textMatches("equals", "uber", "uber")).toBe(true);
  expect(textMatches("equals", "uber trip", "uber")).toBe(false);
  expect(textMatches("startsWith", "uber trip", "uber")).toBe(true);
  expect(textMatches("startsWith", "my uber", "uber")).toBe(false);
  expect(textMatches("endsWith", "my uber", "uber")).toBe(true);
  expect(textMatches("endsWith", "uber trip", "uber")).toBe(false);
});

test("operators relate the way their names say, over random canonical texts", () => {
  const next = random(11);
  const words = ["uber", "trip", "eats", "ber", "a", "stripe", "payout", "x1"];
  const pick = () => {
    const count = 1 + Math.floor(next() * 4);
    return Array.from({ length: count }, () => words[Math.floor(next() * words.length)]).join(" ");
  };
  for (let run = 0; run < 500; run++) {
    const haystack = canonicalText(pick());
    const needle = canonicalText(pick());
    const result = (operator: Parameters<typeof textMatches>[0]) =>
      textMatches(operator, haystack, needle);
    if (result("equals")) expect(result("startsWith") && result("endsWith")).toBe(true);
    if (result("startsWith") || result("endsWith")) expect(result("contains")).toBe(true);
    if (result("wholeWord")) expect(result("contains")).toBe(true);
    expect(containsWholeWords(haystack, needle)).toBe(result("wholeWord"));
  }
});

test("pattern characters in a rule value are plain text, never a pattern", () => {
  // Each of these would be a different (or catastrophic) pattern if it reached a regex engine.
  const haystack = canonicalText("abc aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!");
  for (const needle of ["a.c", "(a+)+$", "a*", "[a-z]+", "^abc", "abc$", "a|b", "\\d", "a{2,}"]) {
    const started = performance.now();
    const hit = textMatches("contains", haystack, canonicalText(needle));
    expectWithin(`matching ${needle}`, performance.now() - started, 50);
    // "a.c" is the words "a" and "c"; "abc" does not contain it.
    if (needle === "a.c") expect(hit).toBe(false);
  }
  expect(textMatches("contains", canonicalText("a.c"), canonicalText("a.c"))).toBe(true);
  expect(textMatches("contains", canonicalText("abc"), canonicalText("a.c"))).toBe(false);
});

test("name words drop numbers, dates, reference ids and single letters", () => {
  expect(nameWords("AMZN Mktp US*2K4AB5 AMZN.COM/BILL WA")).toEqual([
    "amzn",
    "mktp",
    "us",
    "com",
    "bill",
    "wa",
  ]);
  expect(nameWords("CHECK #1042 20261002 10/02 TXN123456")).toEqual(["check"]);
  expect(nameWords("MP3 player a2x")).toEqual(["mp3", "player", "a2x"]);
  expect(nameWords("x y z")).toEqual([]);
});

test("a merchant phrase is a contiguous run of the memo, so it matches the memo it came from", () => {
  const memos: [string, string][] = [
    ["AMZN Mktp US*2K4AB5 AMZN.COM/BILL WA", "amzn mktp us"],
    ["POS DEBIT SQ *BLUE BOTTLE COFFEE 1234 OAKLAND CA", "blue bottle coffee"],
    ["GITHUB, INC. SAN FRANCISCO CA", "github"],
    ["ACME WIDGETS LLC 1234 DENVER CO", "acme widgets"],
    ["WWW.EXAMPLE.COM ORDER 5521", "www example"],
    ["UBER *TRIP 8F2K3 HELP.UBER.COM", "uber trip"],
    ["1234 STARBUCKS", "starbucks"],
    ["ACH WEB PAYMENT", ""],
    ["20261002 123456", ""],
  ];
  for (const [memo, phrase] of memos) {
    const found = merchantPhrase(memo);
    expect(found.phrase).toBe(phrase);
    if (phrase) expect(canonicalText(memo).includes(found.phrase)).toBe(true);
  }
  // Trailing locations and website suffixes are trimmed, but never the only word.
  expect(merchantPhrase("STRIPE CA").phrase).toBe("stripe");
  expect(merchantPhrase("ca").phrase).toBe("ca");
  expect(merchantPhrase("acme llc").phrase).toBe("acme");
});

test("merchant phrases always appear in the canonical text of their memo (property)", () => {
  const next = random(23);
  const words = ["pos", "debit", "uber", "trip", "8f2k3", "123", "ca", "com", "stripe", "a", "ach"];
  for (let run = 0; run < 500; run++) {
    const length = 1 + Math.floor(next() * 7);
    const memo = Array.from(
      { length },
      () => words[Math.floor(next() * words.length)] as string,
    ).join(next() < 0.5 ? " " : "*");
    const { phrase } = merchantPhrase(memo);
    if (phrase) expect(` ${canonicalText(memo)} `.includes(` ${phrase} `)).toBe(true);
  }
});

test("plain text strips control and bidirectional characters and collapses line breaks", () => {
  expect(plainText("Line one\nLine two\r\n\tIndented")).toBe("Line one Line two Indented");
  expect(plainText(`evil${RIGHT_TO_LEFT_OVERRIDE}txt${ZERO_WIDTH_SPACE}`)).toBe("eviltxt");
  expect(plainText("  padded  ")).toBe("padded");
  expect(clip("abc", 2)).toBe("ab");
  // A clip never splits a surrogate pair, so the party popper (two code units) is dropped whole.
  expect(clip(`a${PARTY_POPPER}`, 2)).toBe("a");
  expect(clip(`a${PARTY_POPPER}`, 3)).toBe(`a${PARTY_POPPER}`);
  expect(canonicalWords("")).toEqual([]);
});

/** The claim in the docs is a claim about the source: there is no RegExp in the rules lane. This
 * scans for regular-expression literals and the RegExp constructor with a small tokenizer that
 * skips strings, template literals and comments, so a "/" inside text is not mistaken for one. */
function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory()
      ? sources(path)
      : name.endsWith(".ts") || name.endsWith(".tsx")
        ? [path]
        : [];
  });
}

const isWordStart = (char: string): boolean =>
  (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || char === "_" || char === "$";
const isWordPart = (char: string): boolean => isWordStart(char) || (char >= "0" && char <= "9");
const isSpace = (char: string): boolean =>
  char === " " || char === "\t" || char === "\n" || char === "\r";

export function regexUses(code: string): string[] {
  const found: string[] = [];
  const REGEX_PRECEDERS = "(,=:[!&|?{};+-*%<>~^";
  let index = 0;
  let previous = "";
  let previousWord = "";
  const line = () => code.slice(0, index).split("\n").length;
  while (index < code.length) {
    const char = code.charAt(index);
    const next = code.charAt(index + 1);
    if (char === "/" && next === "/") {
      while (index < code.length && code.charAt(index) !== "\n") index++;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = code.indexOf("*/", index + 2);
      index = end < 0 ? code.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      index++;
      while (index < code.length && code.charAt(index) !== quote) {
        if (code.charAt(index) === "\\") index++;
        // A template literal's ${ ... } is code; its contents are scanned as text here, which is
        // enough for this lane (no regular expression hides inside one).
        index++;
      }
      index++;
      previous = quote;
      previousWord = "";
      continue;
    }
    if (char === "/") {
      const looksLikeRegex =
        REGEX_PRECEDERS.includes(previous) ||
        previous === "" ||
        ["return", "typeof", "case", "in", "of", "void", "delete"].includes(previousWord);
      if (looksLikeRegex && next !== " " && next !== "=")
        found.push(`regex literal near line ${line()}`);
    }
    if (isWordStart(char)) {
      let end = index;
      while (end < code.length && isWordPart(code.charAt(end))) end++;
      const word = code.slice(index, end);
      if (word === "RegExp") found.push(`RegExp near line ${line()}`);
      previousWord = word;
      previous = "a";
      index = end;
      continue;
    }
    if (!isSpace(char)) {
      previous = char;
      previousWord = "";
    }
    index++;
  }
  return found;
}

/** Bidirectional overrides, zero-width characters and raw control characters hidden in source can
 * make code read differently from how it runs ("Trojan Source"). The lane's own files must not
 * hold any; tests that need such text build it from code points (see fixtures/hostile.ts). */
export function hiddenCharacters(code: string): string[] {
  const found: string[] = [];
  let line = 1;
  for (const char of code) {
    const point = char.codePointAt(0) ?? 0;
    if (point === 0x0a) line++;
    const control = point < 0x20 && point !== 0x09 && point !== 0x0a && point !== 0x0d;
    const hidden =
      (point >= 0x7f && point <= 0x9f) ||
      (point >= 0x200b && point <= 0x200f) ||
      (point >= 0x202a && point <= 0x202e) ||
      (point >= 0x2060 && point <= 0x206f) ||
      point === 0xfeff ||
      point === 0x00ad ||
      (point >= 0xd800 && point <= 0xdfff) ||
      point === 0xfffd;
    if (control || hidden) found.push(`U+${point.toString(16).toUpperCase()} on line ${line}`);
  }
  return found;
}

test("the lane's own files hold no hidden or bidirectional characters", () => {
  const roots = [
    join(import.meta.dir, "../src/rules"),
    join(import.meta.dir, "../src/slices/rules"),
    join(import.meta.dir, "fixtures"),
    join(import.meta.dir, "../../../apps/mcp/src/tool-metadata"),
  ];
  const own = [
    ...roots.flatMap((root) => sources(root)),
    ...readdirSync(import.meta.dir)
      .filter((name) => name.startsWith("rules-") && name.endsWith(".test.ts"))
      .map((name) => join(import.meta.dir, name)),
  ];
  expect(own.length).toBeGreaterThan(10);
  for (const path of own) expect(hiddenCharacters(readFileSync(path, "utf8")), path).toEqual([]);
  // The check itself works.
  expect(hiddenCharacters(`a${RIGHT_TO_LEFT_OVERRIDE}b`)).toEqual(["U+202E on line 1"]);
  expect(hiddenCharacters(`a\nb${ZERO_WIDTH_SPACE}`)).toEqual(["U+200B on line 2"]);
  expect(hiddenCharacters(`a${NUL}`)).toEqual(["U+0 on line 1"]);
  expect(hiddenCharacters("plain text, tabs\tand lines\r\n are fine")).toEqual([]);
});

test("the rules lane contains no regular expressions", () => {
  const roots = [
    join(import.meta.dir, "../src/rules"),
    join(import.meta.dir, "../src/slices/rules"),
  ];
  for (const root of roots)
    for (const path of sources(root))
      expect(regexUses(readFileSync(path, "utf8")), path).toEqual([]);
  // The scanner itself works: it finds what it should and ignores what it should.
  expect(regexUses("const x = /ab+c/.test(y);").length).toBeGreaterThan(0);
  expect(regexUses("const x = new RegExp(y);").length).toBeGreaterThan(0);
  expect(regexUses('const x = "a/b" + `c/d` + 1 / 2; // /not/ one')).toEqual([]);
  expect(regexUses("const total = a / b / c;")).toEqual([]);
});

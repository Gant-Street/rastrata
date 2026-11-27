/** Text handling for rules and the classifier. Pure and portable; no regular expressions anywhere
 * in this lane (see docs/reference/program/rules.md for why).
 *
 * Bank memos, merchant names and file cells are attacker-controlled. They are compared as data
 * and are never turned into a pattern, a query or an instruction. Every comparison goes through
 * one canonical form so all operators agree about case, punctuation and spacing (Bigcapital's
 * `contains` ignored case while its `not contains` did not; here a negated condition is always
 * the exact complement of the positive one).
 *
 * Canonical form: Unicode compatibility-decomposed, accents and invisible characters removed,
 * lower-cased, and every run of anything that is not a letter or digit collapsed to one space.
 * "AMZN Mktp US*2K4AB5" and "amzn-mktp-us 2k4ab5" are the same text. */

/** Code units read from any one text. Anything longer is ignored: input is never trusted for length. */
export const SCAN_LIMIT = 4000;
/** Characters kept in a canonical form. */
export const CANONICAL_LIMIT = 2000;

type Range = readonly [number, number];

/** Characters that vanish instead of separating words: combining marks (accents fold away),
 * zero-width and bidirectional controls, soft hyphen, variation selectors and tag characters. */
const INVISIBLE: readonly Range[] = [
  [0x00ad, 0x00ad],
  [0x0300, 0x036f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
];

/** Non-ASCII blocks that hold punctuation, symbols, emoji and private use. Everything else above
 * U+007F (letters and digits of every script) counts as part of a word. This is a deliberate,
 * documented approximation: it needs no Unicode property tables and behaves the same in every
 * runtime. */
const NON_WORD: readonly Range[] = [
  [0x0080, 0x00bf],
  [0x00d7, 0x00d7],
  [0x00f7, 0x00f7],
  [0x2000, 0x206f],
  [0x20a0, 0x20cf],
  [0x2190, 0x2bff],
  [0x2e00, 0x2e7f],
  [0x3000, 0x303f],
  // A lone surrogate half is not a character; code points above U+FFFF arrive whole.
  [0xd800, 0xdfff],
  [0xe000, 0xf8ff],
  [0xfe10, 0xfe1f],
  [0xfe30, 0xfe6f],
  [0xfff0, 0xffff],
  [0x1f000, 0x1faff],
  [0xf0000, 0x10ffff],
];

function inRanges(codePoint: number, ranges: readonly Range[]): boolean {
  for (const [low, high] of ranges) if (codePoint >= low && codePoint <= high) return true;
  return false;
}

function isWordCodePoint(codePoint: number): boolean {
  if (codePoint < 0x80)
    return (
      (codePoint >= 0x30 && codePoint <= 0x39) ||
      (codePoint >= 0x61 && codePoint <= 0x7a) ||
      (codePoint >= 0x41 && codePoint <= 0x5a)
    );
  return !inRanges(codePoint, NON_WORD);
}

/** The canonical form of a text, as described at the top of this file. Never throws. */
export function canonicalText(input: string): string {
  const source = input.length > SCAN_LIMIT ? input.slice(0, SCAN_LIMIT) : input;
  const folded = source.normalize("NFKD").toLowerCase();
  let out = "";
  let separate = false;
  for (const char of folded) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (inRanges(codePoint, INVISIBLE)) continue;
    if (isWordCodePoint(codePoint)) {
      if (separate && out.length > 0) out += " ";
      separate = false;
      out += char;
      if (out.length >= CANONICAL_LIMIT) break;
    } else separate = true;
  }
  return out;
}

/** The words of a canonical text. */
export function canonicalWords(canonical: string): string[] {
  return canonical === "" ? [] : canonical.split(" ");
}

/** True when `needle` appears in `haystack` as whole words, in order and adjacent. Both must be
 * canonical. "uber" is a whole word of "uber trip" but not of "uberland". */
export function containsWholeWords(haystack: string, needle: string): boolean {
  if (needle === "") return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

export type TextOperator = "contains" | "equals" | "startsWith" | "endsWith" | "wholeWord";

/** Apply one text operator to two canonical texts. An empty `needle` never matches: a rule cannot
 * be made to match everything by leaving its value blank. */
export function textMatches(operator: TextOperator, haystack: string, needle: string): boolean {
  if (needle === "") return false;
  switch (operator) {
    case "contains":
      return haystack.includes(needle);
    case "equals":
      return haystack === needle;
    case "startsWith":
      return haystack.startsWith(needle);
    case "endsWith":
      return haystack.endsWith(needle);
    case "wholeWord":
      return containsWholeWords(haystack, needle);
  }
}

/** Cut a string to at most `limit` UTF-16 code units without splitting a surrogate pair. */
export function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.charCodeAt(limit - 1);
  return text.slice(0, cut >= 0xd800 && cut <= 0xdbff ? limit - 1 : limit);
}

/** Remove control and bidirectional-format characters and collapse line breaks, for text that will
 * be stored or shown (a narration) rather than compared. Letters, digits and punctuation survive. */
export function plainText(input: string): string {
  const source = input.length > SCAN_LIMIT ? input.slice(0, SCAN_LIMIT) : input;
  let out = "";
  let space = false;
  for (const char of source) {
    const codePoint = char.codePointAt(0) ?? 0;
    const control =
      codePoint < 0x20 ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029;
    if (control || codePoint === 0x20 || codePoint === 0xa0) {
      space = out.length > 0;
      continue;
    }
    if (inRanges(codePoint, INVISIBLE) && !(codePoint >= 0x0300 && codePoint <= 0x036f)) continue;
    if (space) out += " ";
    space = false;
    out += char;
  }
  return out;
}

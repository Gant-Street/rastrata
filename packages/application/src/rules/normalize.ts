import { canonicalText, canonicalWords } from "./text.ts";

/** Normalising a bank memo into the words that identify a merchant. Used by the classifier (what
 * to learn from) and by rules.suggest (what to generalise a line to). Numbers, dates and
 * reference ids vary from one line to the next and say nothing about who was paid, so they go.
 *
 * The same normaliser feeds both uses on purpose: a rule suggested from a line and the classifier
 * trained on that line then agree about what the line "is". */

const MAX_WORD_LENGTH = 24;

function digitCount(word: string): number {
  let count = 0;
  for (let index = 0; index < word.length; index++) {
    const code = word.charCodeAt(index);
    if (code >= 0x30 && code <= 0x39) count++;
  }
  return count;
}

/** A word that names something: letters, no more than one digit ("mp3", "a2x"), a plausible
 * length. Pure numbers ("1042", "20261002"), mixed reference ids ("2k4ab5", "txn123456") and
 * single letters are not name words. */
export function isNameWord(word: string): boolean {
  if (word.length < 2 || word.length > MAX_WORD_LENGTH) return false;
  return digitCount(word) <= 1;
}

/** The identifying words of a memo, in order, each kept once. */
export function nameWords(text: string): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const word of canonicalWords(canonicalText(text)))
    if (isNameWord(word) && !seen.has(word)) {
      seen.add(word);
      words.push(word);
    }
  return words;
}

/** Words that describe how a payment travelled rather than who received it. They are skipped when
 * choosing the start of a suggested phrase ("pos debit starbucks" suggests "starbucks"). */
const RAIL_WORDS: ReadonlySet<string> = new Set([
  "pos",
  "debit",
  "card",
  "purchase",
  "checkcard",
  "recurring",
  "pending",
  "online",
  "payment",
  "pmt",
  "pymt",
  "ach",
  "web",
  "ppd",
  "ccd",
  "sq",
  "tst",
  "pp",
  "paypal",
  "withdrawal",
  "deposit",
]);

/** United States state and territory abbreviations. A trailing one is a location, not a merchant. */
const STATE_CODES: ReadonlySet<string> = new Set(
  "al ak az ar ca co ct de dc fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy pr vi gu as mp".split(
    " ",
  ),
);

/** Trailing words that only say what kind of website or business it is. */
const SUFFIX_WORDS: ReadonlySet<string> = new Set(["com", "net", "org", "inc", "llc", "ltd", "co"]);

/** "amzn mktp us" as "Amzn Mktp Us", for rule names and narrations. */
export function titleCase(phrase: string): string {
  return phrase
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export interface MerchantPhrase {
  /** The words joined by single spaces. It is a contiguous run of the memo's canonical text, so a
   * `contains` condition with this value always matches the memo it came from. */
  readonly phrase: string;
  readonly words: readonly string[];
  /** Every other word of the memo: rail words, numbers, reference ids, locations, the rest. */
  readonly dropped: readonly string[];
}

/** The leading merchant phrase of a memo or counterparty: the first run of name words after any
 * payment-rail words and numbers, at most `limit` long, without a trailing location or website
 * suffix. The run stops at the first number or reference id, because skipping one would make the
 * phrase stop matching the memo it came from. Empty when nothing identifying is left. */
export function merchantPhrase(text: string, limit = 3): MerchantPhrase {
  const all = canonicalWords(canonicalText(text));
  let start = 0;
  while (start < all.length) {
    const word = all[start] as string;
    if (isNameWord(word) && !RAIL_WORDS.has(word)) break;
    start++;
  }
  // A company or website suffix ("inc", "llc", "com") ends a merchant's name: what follows it is
  // an address ("GITHUB, INC. SAN FRANCISCO CA"), not part of who was paid.
  let end = start;
  while (
    end < all.length &&
    end - start < Math.max(1, limit) &&
    isNameWord(all[end] as string) &&
    !(end > start && SUFFIX_WORDS.has(all[end] as string))
  )
    end++;
  while (end - start > 1) {
    const last = all[end - 1] as string;
    if (STATE_CODES.has(last) || SUFFIX_WORDS.has(last) || RAIL_WORDS.has(last)) end--;
    else break;
  }
  const words = all.slice(start, end);
  return {
    phrase: words.join(" "),
    words,
    dropped: [...all.slice(0, start), ...all.slice(end)],
  };
}

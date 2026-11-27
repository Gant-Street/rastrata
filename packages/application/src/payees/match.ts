/** Who a payment went to, from the text a bank wrote.
 *
 * A bank line carries a counterparty and a description; both are attacker-controlled text. This
 * module turns them into a key that can be compared, and matches the key to the keys a person gave a
 * payee. There is no regular expression on the text and no fuzzy guess: a key matches when its words
 * appear, whole and in order, in the payee's words ("jane doe" is in "zelle payment to jane doe 4411";
 * "acme" is not in "acmetech"). When two payees match, the longer key wins, and when they tie nobody
 * gets the payment and it is listed as ambiguous, never given to one of them.
 *
 * This is the matcher the 1099 lane wrote, moved here so the whole book can use it: `tax/payees.ts`
 * re-exports it unchanged, so the 1099 code and its tests did not have to change. `matchVendor` is the
 * definition of the rule; `compileMatcher` is the same rule made fast for a book with thousands of
 * lines and hundreds of payees, and a test holds the two equal on generated text.
 *
 * Pure and portable. */
import { normalizeForKey, sanitizeText } from "../ingest/text.ts";

/** The most characters of a payee's text the lane ever keeps. */
export const PAYEE_TEXT_MAX = 300;
/** The fewest characters a payee key may have: shorter keys would match half the book. */
export const PAYEE_KEY_MIN = 3;
export const PAYEE_KEY_MAX = 120;

/** The words of a text: lower case, letters and digits only. */
export function payeeWords(value: string): string[] {
  return normalizeForKey(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

/** A key as it is stored: the words of the text, joined by single spaces. */
export const payeeKey = (value: string): string => payeeWords(value).join(" ");

/** The text of a payee as it is kept and shown: control and direction characters removed, one line,
 * bounded. */
export const payeeText = (value: string): string => sanitizeText(value, PAYEE_TEXT_MAX);

/** The key payments to unknown payees are grouped by: the words, with every run of digits made one
 * "#", so "COFFEE 1234" and "COFFEE 5678" are one payee. */
export function groupKey(value: string): string {
  return payeeWords(value)
    .map((word) => (/^\p{N}+$/u.test(word) ? "#" : word))
    .join(" ");
}

const containsWords = (haystack: readonly string[], needle: readonly string[]): boolean => {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    let all = true;
    for (let offset = 0; offset < needle.length; offset++)
      if (haystack[start + offset] !== needle[offset]) {
        all = false;
        break;
      }
    if (all) return true;
  }
  return false;
};

export interface KeyedVendor {
  readonly id: string;
  readonly keys: readonly string[];
}

export type VendorMatch =
  | { readonly kind: "vendor"; readonly vendorId: string; readonly key: string }
  | { readonly kind: "ambiguous"; readonly vendorIds: readonly string[] }
  | { readonly kind: "none" };

/** Which vendor a text belongs to. `texts` are tried in order (the counterparty first, then the
 * description); the first that matches any vendor decides. */
export function matchVendor(
  texts: readonly string[],
  vendors: readonly KeyedVendor[],
): VendorMatch {
  for (const text of texts) {
    const words = payeeWords(text);
    if (words.length === 0) continue;
    let best = -1;
    let winners = new Map<string, string>();
    for (const vendor of vendors)
      for (const key of vendor.keys) {
        const keyWords = key.split(" ");
        if (!containsWords(words, keyWords)) continue;
        const size = keyWords.length * 1000 + key.length;
        if (size > best) {
          best = size;
          winners = new Map([[vendor.id, key]]);
        } else if (size === best && !winners.has(vendor.id)) winners.set(vendor.id, key);
      }
    if (winners.size === 1) {
      const [vendorId, key] = [...winners.entries()][0] as [string, string];
      return { kind: "vendor", vendorId, key };
    }
    if (winners.size > 1) return { kind: "ambiguous", vendorIds: [...winners.keys()].sort() };
  }
  return { kind: "none" };
}

// ------------------------------------------------------------------------------------------------
// The same rule, indexed
// ------------------------------------------------------------------------------------------------

interface IndexedKey {
  readonly id: string;
  readonly key: string;
  readonly words: readonly string[];
  readonly size: number;
  /** The place of the key in the order `matchVendor` meets them: payee by payee, key by key. */
  readonly order: number;
}

/** How many answers a matcher keeps. */
const REMEMBERED_MAX = 50_000;

/** A matcher built once for a list of payees and asked about many texts. */
export interface PayeeMatcher {
  match(texts: readonly string[]): VendorMatch;
}

/** `matchVendor` made fast: the keys are indexed by their first word, so a text is checked against the
 * few keys that begin with one of its words and not against every key there is. The answer is the one
 * `matchVendor` gives (the longest key wins; equal keys of two payees are ambiguous; of one payee, the
 * first the list met); a test holds the two equal. Answers are kept per text, so the many lines of a
 * book that share a memo are matched once. */
export function compileMatcher(vendors: readonly KeyedVendor[]): PayeeMatcher {
  const byFirstWord = new Map<string, IndexedKey[]>();
  let order = 0;
  for (const vendor of vendors)
    for (const key of vendor.keys) {
      const words = key.split(" ");
      const first = words[0] as string;
      const entry: IndexedKey = {
        id: vendor.id,
        key,
        words,
        size: words.length * 1000 + key.length,
        order: order++,
      };
      const list = byFirstWord.get(first);
      if (list) list.push(entry);
      else byFirstWord.set(first, [entry]);
    }

  const matchWords = (words: readonly string[]): VendorMatch => {
    let best = -1;
    const winners = new Map<string, IndexedKey>();
    for (let start = 0; start < words.length; start++) {
      const candidates = byFirstWord.get(words[start] as string);
      if (!candidates) continue;
      for (const entry of candidates) {
        if (entry.size < best) continue;
        if (start + entry.words.length > words.length) continue;
        let all = true;
        for (let offset = 1; offset < entry.words.length; offset++)
          if (words[start + offset] !== entry.words[offset]) {
            all = false;
            break;
          }
        if (!all) continue;
        if (entry.size > best) {
          best = entry.size;
          winners.clear();
        }
        const known = winners.get(entry.id);
        if (!known || entry.order < known.order) winners.set(entry.id, entry);
      }
    }
    if (winners.size === 1) {
      const [only] = [...winners.values()] as [IndexedKey];
      return { kind: "vendor", vendorId: only.id, key: only.key };
    }
    if (winners.size > 1) return { kind: "ambiguous", vendorIds: [...winners.keys()].sort() };
    return { kind: "none" };
  };

  const remembered = new Map<string, VendorMatch>();
  return {
    match(texts) {
      const token = texts.join("\u0000");
      const known = remembered.get(token);
      if (known) return known;
      let found: VendorMatch = { kind: "none" };
      for (const text of texts) {
        const words = payeeWords(text);
        if (words.length === 0) continue;
        const result = matchWords(words);
        if (result.kind !== "none") {
          found = result;
          break;
        }
      }
      // Bounded: a book with a different memo on every line must not keep every one of them.
      if (remembered.size >= REMEMBERED_MAX) remembered.clear();
      remembered.set(token, found);
      return found;
    },
  };
}

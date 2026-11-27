import type { StarterKind } from "./accounts.ts";
import { MERCHANTS } from "./merchants.ts";
import { starterWords } from "./text.ts";

/** Reading a bank line against the starter list (merchants.ts): which merchant it names, if it names
 * exactly one kind of thing. Pure: the same text gives the same answer on every runtime, and the
 * text is only ever compared, never compiled or evaluated.
 *
 * A line is found when the rows that match it agree. A row that another matching row covers does not
 * count (UBER inside UBER EATS, GUSTO inside GUSTO TAX), so the longer spelling wins. If what is left
 * disagrees (two kinds, or one the list leaves alone on purpose), the line is unclear and nothing is
 * suggested. And a line that says it is an eatery (CAFE, GRILL, PIZZA) is only ever read as meals:
 * ADOBE GRILL is not software. */

export interface MerchantEntry {
  /** Stable identity: the kind and the name, "software:Adobe". */
  readonly id: string;
  readonly name: string;
  /** Null: known, and left alone on purpose. */
  readonly kind: StarterKind | null;
  /** The whole reason, when the row gives one. */
  readonly why: string | null;
}

export type MerchantFinding =
  | { readonly outcome: "found"; readonly entry: MerchantEntry; readonly kind: StarterKind }
  | { readonly outcome: "none" }
  | { readonly outcome: "unclear" };

interface Pattern {
  readonly entry: MerchantEntry;
  /** Every phrase must be in the line; the index finds the first. */
  readonly phrases: readonly (readonly string[])[];
  readonly first: boolean;
  readonly not: readonly (readonly string[])[];
}

interface Table {
  readonly entries: readonly MerchantEntry[];
  readonly index: ReadonlyMap<string, readonly Pattern[]>;
}

function compile(): Table {
  const entries: MerchantEntry[] = [];
  const index = new Map<string, Pattern[]>();
  const seen = new Set<string>();
  for (const group of MERCHANTS)
    for (const [name, match, options] of group.rows) {
      const id = `${group.kind ?? "none"}:${name}`;
      if (seen.has(id)) throw new Error(`The starter list has ${id} twice`);
      seen.add(id);
      const entry: MerchantEntry = { id, name, kind: group.kind, why: options?.why ?? null };
      entries.push(entry);
      const not = (options?.not ?? "")
        .split("|")
        .map(starterWords)
        .filter((phrase) => phrase.length > 0);
      for (const alternative of match.split("|")) {
        const phrases = alternative
          .split(" + ")
          .map(starterWords)
          .filter((phrase) => phrase.length > 0);
        const lead = phrases[0]?.[0];
        if (lead === undefined) throw new Error(`The starter list has an empty spelling for ${id}`);
        const list = index.get(lead) ?? [];
        index.set(lead, list);
        list.push({ entry, phrases, first: options?.first === true, not });
      }
    }
  return { entries, index };
}

let compiled: Table | null = null;
const table = (): Table => {
  compiled ??= compile();
  return compiled;
};

/** Every row of the list, for the tests and for counting. */
export function starterMerchants(): readonly MerchantEntry[] {
  return table().entries;
}

/** Words a bank puts in front of the merchant: how the payment travelled, not who was paid. */
const PREFIX: ReadonlySet<string> = new Set(
  "ach auth authorized bill billpay card ccd check checkcard chk co crd dbt debit des direct electronic external for id mc name of on online orig pay payment paypal pending pmt point pos pp ppd pre preauthorized purch purchase pymt recurring sale sp sq to tst visa web withdrawal".split(
    " ",
  ),
);

/** Words that say the line is a place to eat. */
const EATERY: ReadonlySet<string> = new Set(
  "bakery bar bbq bistro brewery brewing burger burgers cafe cantina catering coffee deli diner eatery grill kitchen pizza pizzeria pub ramen restaurant ristorante saloon steakhouse sushi tacos taqueria tavern trattoria".split(
    " ",
  ),
);

const isNumber = (word: string): boolean => {
  const code = word.charCodeAt(0);
  return code >= 0x30 && code <= 0x39;
};

function masked(word: string): boolean {
  for (let index = 0; index < word.length; index++) if (word[index] !== "x") return false;
  return true;
}

/** Where the merchant starts: after the bank's own words, numbers and masked card digits. */
function leadOf(words: readonly string[]): number {
  let index = 0;
  while (index < words.length) {
    const word = words[index] as string;
    if (!PREFIX.has(word) && !isNumber(word) && !masked(word)) break;
    index++;
  }
  return index;
}

function at(words: readonly string[], phrase: readonly string[], start: number): boolean {
  if (start + phrase.length > words.length) return false;
  for (let index = 0; index < phrase.length; index++)
    if (words[start + index] !== phrase[index]) return false;
  return true;
}

function find(words: readonly string[], phrase: readonly string[]): number {
  for (let start = 0; start + phrase.length <= words.length; start++)
    if (at(words, phrase, start)) return start;
  return -1;
}

interface Hit {
  readonly entry: MerchantEntry;
  readonly field: number;
  readonly start: number;
  readonly positions: ReadonlySet<number>;
}

function hitsIn(words: readonly string[], field: number): Hit[] {
  const { index } = table();
  const lead = leadOf(words);
  const hits: Hit[] = [];
  for (let start = 0; start < words.length; start++) {
    const patterns = index.get(words[start] as string);
    if (!patterns) continue;
    for (const pattern of patterns) {
      const [head, ...rest] = pattern.phrases as [readonly string[], ...(readonly string[])[]];
      if (pattern.first && start !== lead) continue;
      if (!at(words, head, start)) continue;
      const positions = new Set<number>();
      for (let offset = 0; offset < head.length; offset++) positions.add(start + offset);
      let complete = true;
      for (const phrase of rest) {
        const found = find(words, phrase);
        if (found < 0) {
          complete = false;
          break;
        }
        for (let offset = 0; offset < phrase.length; offset++) positions.add(found + offset);
      }
      if (!complete) continue;
      if (pattern.not.some((phrase) => find(words, phrase) >= 0)) continue;
      hits.push({ entry: pattern.entry, field, start, positions });
    }
  }
  return hits;
}

const covers = (larger: Hit, smaller: Hit): boolean => {
  if (larger.field !== smaller.field || larger.positions.size <= smaller.positions.size)
    return false;
  for (const position of smaller.positions) if (!larger.positions.has(position)) return false;
  return true;
};

/** The merchant a line names. `fields` are the texts a line carries (the counterparty, the
 * description); each is read on its own, so a name is never made of the end of one and the start of
 * the next. */
export function findMerchant(fields: readonly (string | undefined)[]): MerchantFinding {
  const hits: Hit[] = [];
  let eatery = false;
  let field = 0;
  for (const text of fields) {
    if (!text) continue;
    const words = starterWords(text);
    if (words.some((word) => EATERY.has(word))) eatery = true;
    hits.push(...hitsIn(words, field++));
  }
  if (hits.length === 0) return { outcome: "none" };
  const standing = hits.filter((hit) => !hits.some((other) => covers(other, hit)));
  const kinds = new Set(standing.map((hit) => hit.entry.kind));
  if (kinds.size !== 1) return { outcome: "unclear" };
  const [kind] = kinds;
  if (kind === null || kind === undefined) return { outcome: "unclear" };
  if (eatery && kind !== "meals") return { outcome: "unclear" };
  // A named merchant says more than the bank's own word for the thing; then the first in the line.
  const [best] = [...standing].sort(
    (a, b) =>
      Number(a.entry.why !== null) - Number(b.entry.why !== null) ||
      a.field - b.field ||
      a.start - b.start ||
      (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0),
  );
  return best ? { outcome: "found", entry: best.entry, kind } : { outcome: "none" };
}

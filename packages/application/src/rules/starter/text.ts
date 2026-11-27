import { canonicalText, canonicalWords, SCAN_LIMIT } from "../text.ts";

/** Bank text as the starter list reads it: the words of rules/text.ts's canonical form (lower case,
 * accents folded, punctuation as spaces), with three more steps so that one merchant written many
 * ways is one merchant:
 *
 * - an apostrophe joins: MCDONALD'S and MCDONALDS are both "mcdonalds";
 * - an ampersand between two letters joins: AT&T and ATT are both "att" (one with spaces around it
 *   separates, as in BARNES & NOBLE);
 * - letters and digits are read apart: the store, ticket and reference numbers banks append
 *   ("STARBUCKS#12345", "AMERICAN AIR0012345678901") never hide the name they are stuck to.
 *
 * A merchant is then looked for as whole words, so a town, a state or a number after the name
 * ("STAPLES 00123 DENVER CO") changes nothing. No regular expressions, like the rest of this lane. */

const APOSTROPHES: ReadonlySet<string> = new Set(["'", "‘", "’", "ʼ", "`"]);

function isLetter(char: string | undefined): boolean {
  if (char === undefined) return false;
  const code = char.charCodeAt(0);
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;

export function starterWords(text: string): string[] {
  const source = text.length > SCAN_LIMIT ? text.slice(0, SCAN_LIMIT) : text;
  let joined = "";
  for (let index = 0; index < source.length; index++) {
    const char = source[index] as string;
    if (APOSTROPHES.has(char)) continue;
    if (char === "&" && isLetter(source[index - 1]) && isLetter(source[index + 1])) continue;
    joined += char;
  }
  const words: string[] = [];
  for (const word of canonicalWords(canonicalText(joined))) {
    let start = 0;
    for (let index = 1; index <= word.length; index++)
      if (
        index === word.length ||
        isDigit(word.charCodeAt(index)) !== isDigit(word.charCodeAt(index - 1))
      ) {
        words.push(word.slice(start, index));
        start = index;
      }
  }
  return words;
}

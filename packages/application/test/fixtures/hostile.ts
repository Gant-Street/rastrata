/** Characters that are awkward or dangerous to keep literally in source, built from their code
 * points so this repository never contains a bidirectional override, a zero-width character or a
 * lone surrogate (the "Trojan Source" class of problem). Tests that need hostile text compose it
 * from these. */

const from = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);

export const NUL = from(0x0000);
export const ZERO_WIDTH_SPACE = from(0x200b);
export const RIGHT_TO_LEFT_OVERRIDE = from(0x202e);
export const POP_DIRECTIONAL_FORMATTING = from(0x202c);
export const COMBINING_ACUTE = from(0x0301);
export const SOFT_HYPHEN = from(0x00ad);
export const E_ACUTE = from(0x00e9);
export const CAPITAL_E_ACUTE = from(0x00c9);
export const CJK = from(0x4e2d);
export const PARTY_POPPER = from(0x1f389);
/** One half of a surrogate pair on its own: not a character, and not valid UTF-8. */
export const LONE_HIGH_SURROGATE = String.fromCharCode(0xd83d);
export const LONE_LOW_SURROGATE = String.fromCharCode(0xdfff);
/** "AMZN" in full-width forms, which compatibility normalisation folds to ASCII. */
export const FULLWIDTH_AMZN = from(0xff21, 0xff2d, 0xff3a, 0xff2e);
/** "3.00" in Arabic-Indic digits: digits to a person, but not the ASCII digits money allows. */
export const ARABIC_INDIC_THREE_DOT_ZERO_ZERO = `${from(0x0663)}.${from(0x0660)}${from(0x0660)}`;

/** What the payees screens decide without the service: the words a person typed, a name to start from,
 * the problems with a form, and the sentences that say what some words would find. All pure; nothing
 * here reads a clock or the page. */
import { formatMoney } from "../format";
import type {
  PayeeFormValues,
  PayeeRefView,
  PayeeTallyView,
  PayeeTestData,
  PayeeView,
} from "./types";
import { words } from "./words";

/** The shortest and longest a set of words can be, and how many a payee can have. The service holds
 * the same limits and is the one that refuses; these are so a form can say so first. */
export const WORDS_MIN = 3;
export const WORDS_MAX = 120;
export const WORDS_COUNT_MAX = 20;
export const NAME_MAX = 120;
export const NOTE_MAX = 500;

/** Sets of words as typed: one to a row, or separated by semicolons. Blank pieces are dropped and the same
 * words typed twice (in any case) are kept once. */
export function parseWords(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const piece of text.split(/[\n;]/)) {
    const value = piece.trim();
    const key = value.toLowerCase();
    if (value === "" || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

/** What the service reduces a set of words to: its words, lower case, letters and digits only, joined by
 * single spaces. A set of words is matched by this and by nothing else. */
export const keyOf = (text: string): string =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "")
    .join(" ");

/** How long the key of a set of words is: the service refuses a key shorter than three. */
export const keyLength = (text: string): number => keyOf(text).length;

/** A name to start from, out of the words a bank text suggested: "blue bottle coffee" is Blue Bottle
 * Coffee. A person changes it. */
export function nameFromWords(suggested: string): string {
  const first = suggested.split(/[\n;]/)[0]?.trim() ?? "";
  return first
    .split(/\s+/)
    .filter((word) => word !== "")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ")
    .slice(0, NAME_MAX);
}

/** The form for naming a payee out of a bank text: the name and words it suggests, nothing else. */
export const nameFormValues = (suggestedWords: string): PayeeFormValues => ({
  name: nameFromWords(suggestedWords),
  words: suggestedWords,
  note: "",
  retired: false,
});

/** The form for changing a payee as it stands. */
export const payeeFormValues = (payee: PayeeView): PayeeFormValues => ({
  name: payee.name,
  words: payee.words.join("\n"),
  note: payee.note,
  retired: payee.retired,
});

export interface PayeeFormErrors {
  name?: string | undefined;
  words?: string | undefined;
}

/** What is wrong with a form before it is sent. Naming a payee out of a bank text needs words (a name
 * with none matches nothing); changing one does not (a payee may be a name alone). */
export function formErrors(values: PayeeFormValues, naming: boolean): PayeeFormErrors {
  const errors: PayeeFormErrors = {};
  if (values.name.trim() === "") errors.name = words.nameRequired;
  const sets = parseWords(values.words);
  if (naming && sets.length === 0) errors.words = words.wordsRequired;
  else if (sets.length > WORDS_COUNT_MAX) errors.words = words.wordsMany;
  else if (sets.some((set) => set.length > WORDS_MAX)) errors.words = words.wordsLong;
  else if (sets.some((set) => keyLength(set) < WORDS_MIN)) errors.words = words.wordsShort;
  return errors;
}

export const hasErrors = (errors: PayeeFormErrors): boolean =>
  Object.values(errors).some((message) => message !== undefined);

/** The fields of `payees.save` for a form. */
export function saveFields(values: PayeeFormValues) {
  return {
    name: values.name.trim(),
    words: parseWords(values.words),
    note: values.note.trim(),
    retired: values.retired,
  } as const;
}

/** Who recorded a version of a payee, in words a person knows: themselves, an agent working for them, or
 * Rastrata itself (the step that made payees out of the 1099 vendors). Anyone else is named as the
 * service named them. */
export function whoWrote(principal: string): string {
  if (principal === "owner") return "you";
  if (principal.startsWith("agent:")) return "an agent";
  if (principal.startsWith("service:")) return "Rastrata";
  return principal;
}

// ---- What some words would find ------------------------------------------------------------------

export interface TestSentence {
  /** `calm` is a fact, `attention` something to look at before saving, `problem` what the service
   * would refuse. */
  readonly tone: "calm" | "attention" | "problem";
  readonly text: string;
}

const empty = (tally: PayeeTallyView): boolean => tally.transactions === 0;
const names = (list: readonly PayeeRefView[]): string => {
  const shown = list.slice(0, 3).map((entry) => entry.name);
  const rest = list.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(" and ");
};

/** What some words would find, in order of what a person needs to know: what the service would refuse,
 * how many transactions, what moves, what is tied or kept by a longer payee, and what would be lost. */
export function testSentences(test: PayeeTestData): TestSentence[] {
  const out: TestSentence[] = [];
  for (const problem of test.problems) out.push({ tone: "problem", text: problem.message });
  if (empty(test.matches)) {
    if (test.keys.length > 0 || test.problems.length === 0)
      out.push({ tone: "attention", text: words.testNothing });
  } else {
    out.push({
      tone: "calm",
      text: words.testFinds(
        test.matches.transactions,
        formatMoney(test.matches.spent),
        formatMoney(test.matches.received),
      ),
    });
    if (!empty(test.stays))
      out.push({ tone: "calm", text: words.testStays(test.stays.transactions) });
    if (!empty(test.fromUnnamed))
      out.push({ tone: "calm", text: words.testUnnamed(test.fromUnnamed.transactions) });
    for (const entry of test.taken)
      out.push({
        tone: "attention",
        text: words.testTaken(entry.tally.transactions, entry.payee.name),
      });
    if (!empty(test.fromAmbiguous))
      out.push({ tone: "calm", text: words.testAmbiguous(test.fromAmbiguous.transactions) });
    if (!empty(test.fromNowhere))
      out.push({ tone: "calm", text: words.testNowhere(test.fromNowhere.transactions) });
  }
  if (!empty(test.lost))
    out.push({ tone: "attention", text: words.testLost(test.lost.transactions) });
  if (!empty(test.tied))
    out.push({
      tone: "attention",
      text: words.testTied(test.tied.transactions, names(test.tied.payees)),
    });
  for (const entry of test.beaten)
    out.push({
      tone: "calm",
      text: words.testBeaten(entry.tally.transactions, entry.payee.name),
    });
  return out;
}

/** Whether the service would refuse these words, so Save is not offered. */
export const wouldRefuse = (test: PayeeTestData | undefined): boolean =>
  test !== undefined && test.problems.length > 0;

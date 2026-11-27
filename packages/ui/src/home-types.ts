/** What the Home screen's components are given. Plain types, so the web application's logic (and its
 * tests) can build them without loading a component library. */

/** The kit's four tones (kit/tones.ts), written out so these types load on their own: `calm` is a fact,
 * `info` is good to know, `attention` is a person who must decide, `problem` is something that failed. */
export type HomeTone = "calm" | "info" | "attention" | "problem";

/** A link said in words: what it is called and where it goes. */
export interface HomeLink {
  readonly label: string;
  readonly href: string;
}

/** One quiet line under the start of a new book: a question and the way in for whoever answers yes. */
export interface HomeStartLine {
  readonly id: string;
  readonly text: string;
  readonly action: string;
  readonly href: string;
}

/** The start of a new book: the one thing to do, in a title, a sentence and one button; a second way to
 * do the same thing, said quietly beside the button; and the quiet lines under it. */
export interface HomeStartView {
  readonly title: string;
  readonly text: string;
  readonly action: HomeLink;
  readonly alt?: HomeLink | undefined;
  readonly lines: readonly HomeStartLine[];
}

/** One row of "Needs you": a sentence and one verb. `href` is where the verb goes. */
export interface NeedRowView {
  readonly id: string;
  readonly tone: "attention" | "problem" | "info";
  readonly text: string;
  readonly verb: string;
  readonly href: string;
}

/** One month of "Money in and out". Amounts are wire amounts; null says the month has no figure
 * (the books had not begun, or the read failed) and `note` says why in words. */
export interface MoneyMonthView {
  /** "2026-04". */
  readonly month: string;
  /** The month's name for a heading or a table row: "April 2026". */
  readonly name: string;
  /** The short name on the axis: "Apr". */
  readonly short: string;
  readonly income: string | null;
  readonly expenses: string | null;
  readonly note?: string | undefined;
}

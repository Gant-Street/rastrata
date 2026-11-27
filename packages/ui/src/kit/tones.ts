/** The four tones, and what each one means. A tone is a promise about the person's next move, so each
 * has one meaning and no two tones mean the same thing:
 *
 * - `calm` (grey): a fact. Nothing to do.
 * - `info` (blue): good to know. It changes nothing and needs no decision.
 * - `attention` (orange): a person must decide, or the figures on this page would change if they acted.
 * - `problem` (red): something failed or is wrong, and stays wrong until it is fixed.
 *
 * `Notice`, `Status`, `HomeItem` and `Toast` all take them. Orange is the one colour with a job, so it is
 * rationed: a count, a setting or a fact is never orange, and a new book is not a list of warnings. */
export type Tone = "calm" | "info" | "attention" | "problem";

/** The names `Notice` and `Status` used before the kit. They still work, so a screen moves over when its
 * lane gets to it; new code uses the four tones. */
export type LegacyTone = "neutral" | "review" | "error";
export type ToneName = Tone | LegacyTone;

const ALIASES: Readonly<Record<LegacyTone, Tone>> = {
  neutral: "calm",
  review: "attention",
  error: "problem",
};

/** The tone a name stands for: the four tones as they are, an old name as its new one, and
 * `fallback` for none. */
export function toneOf(name: ToneName | undefined, fallback: Tone): Tone {
  if (name === undefined) return fallback;
  return name in ALIASES ? ALIASES[name as LegacyTone] : (name as Tone);
}

/** One tone, written out: what it says, what it is for and what it is never for. The Storybook page, the
 * kit's usage rules and a unit test all read this, so the note on what each tone means is in one place. */
export interface ToneNote {
  readonly tone: Tone;
  readonly colour: "grey" | "blue" | "orange" | "red";
  /** What the tone says, in one line. */
  readonly means: string;
  /** What it is for. */
  readonly use: string;
  /** What it is never for. */
  readonly never: string;
}

export const TONES: readonly ToneNote[] = [
  {
    tone: "calm",
    colour: "grey",
    means: "A fact. Nothing to do.",
    use: "State and history: Posted, Draft, last backup 2 hours ago, a check that passed, good practice a person can ignore.",
    never: "Anything a person has to act on.",
  },
  {
    tone: "info",
    colour: "blue",
    means: "Good to know. It changes nothing and needs no decision.",
    use: "How something works, what a setting does, where to find something, a note that a form is an early release.",
    never:
      "A warning, or something that has not happened yet. Blue is also the color of links and focus, so keep it for explanation.",
  },
  {
    tone: "attention",
    colour: "orange",
    means: "A person must decide, or the figures on this page would change if they acted.",
    use: "Transactions waiting for review, a difference left on a reconciliation, a month that has ended and is still open, a start date inside the year.",
    never: "A count, a setting or a fact. A new book is not a list of warnings.",
  },
  {
    tone: "problem",
    colour: "red",
    means: "Something failed or is wrong, and it stays wrong until it is fixed.",
    use: "A save or a read that failed, an entry the ledger refused, a backup that did not verify, books that do not balance.",
    never:
      "Something that is only not done yet, or an unusual but valid figure: a negative amount is not an error.",
  },
];

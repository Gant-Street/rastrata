/** The shapes of the question evaluation: a question, the answer the oracle expects and what a grader
 * says about an agent's line. Nothing here reads a book or runs an agent. */

/** What an answer is. `unsupported` is the answer to a question the product does not do: the right
 * reply is to say so. */
export type AnswerKind = "money" | "percent" | "count" | "date" | "name" | "list" | "unsupported";

/** A kind a supported question can have (what `asks` names for an unsupported one). */
export type AskedKind = Exclude<AnswerKind, "unsupported">;

/** The groups of questions, from the topics an owner brings to a bookkeeper. */
export type Group =
  | "profit-and-loss"
  | "balances-and-cash"
  | "money-in"
  | "money-out"
  | "bank-and-reconciliation"
  | "taxes"
  | "closing-and-checks"
  | "history"
  | "chart-and-setup";

export const GROUPS: readonly Group[] = [
  "profit-and-loss",
  "balances-and-cash",
  "money-in",
  "money-out",
  "bank-and-reconciliation",
  "taxes",
  "closing-and-checks",
  "history",
  "chart-and-setup",
];

/** The lane of the study program that would make the question answerable. `none` is a gap no planned
 * lane closes. */
export type Lane = "changes" | "payees" | "catchall" | "recpack" | "percent" | "none";

export const LANES: readonly Lane[] = [
  "changes",
  "payees",
  "catchall",
  "recpack",
  "percent",
  "none",
];

/** `now`: the scripted right agent answers it with commands that exist today. `after:<lane>`: it
 * cannot yet, and that lane would let it. `unsupported`: Rastrata does not do this, and the right
 * answer is to say so. */
export type QuestionClass = "now" | "unsupported" | `after:${Lane}`;

export interface Question {
  /** `A12`: how the agent's answer line names it. */
  readonly id: string;
  readonly number: number;
  /** Which of the six sessions asks it (ten each). */
  readonly session: number;
  readonly group: Group;
  /** The owner's words. It names the period and the basis it needs, and never its own answer. */
  readonly text: string;
  readonly kind: AnswerKind;
  /** For an unsupported question, the kind of answer the format hint shows (it must not give the
   * question away). */
  readonly asks?: AskedKind;
  readonly class: QuestionClass;
  /** After a lane: what the lane has to add for the question to be answered. */
  readonly needs?: string;
  /** Unsupported: what the product does not do, and so what the right agent says. */
  readonly reason?: string;
}

/** What the oracle says the right answer is. Money is integer cents, a percentage is tenths of a
 * percent, both exact. A name or a list item carries every spelling the grader accepts, the first
 * being the canonical one. */
export type Expected =
  | { readonly kind: "money"; readonly cents: bigint }
  | { readonly kind: "percent"; readonly tenths: bigint }
  | { readonly kind: "count"; readonly value: number }
  | { readonly kind: "date"; readonly iso: string }
  | { readonly kind: "name"; readonly names: readonly string[] }
  | {
      readonly kind: "list";
      readonly items: readonly (readonly string[])[];
      readonly ordered: boolean;
    }
  | { readonly kind: "unsupported" };

/** What an agent's answer to one question was, read as the kind asked. `declined` is the agent saying
 * it cannot answer (the marker UNSUPPORTED, or the same in words). */
export type Given =
  | { readonly kind: "money"; readonly cents: bigint }
  | { readonly kind: "percent"; readonly tenths: bigint }
  | { readonly kind: "count"; readonly value: number }
  | { readonly kind: "date"; readonly iso: string }
  | { readonly kind: "name"; readonly text: string }
  | { readonly kind: "list"; readonly items: readonly string[] }
  | { readonly kind: "declined"; readonly reason: string; readonly marker: boolean };

/** How an answer line stands against the oracle.
 *
 * - `right`: the figure, date, name or list is the oracle's, exactly.
 * - `declined_right`: UNSUPPORTED on a question that is unsupported.
 * - `declined`: UNSUPPORTED on a question that has an answer. Not a wrong figure; a miss on a `now`
 *   question, the expected gap on an `after:` one.
 * - `wrong`: a different answer to a question that has one: a confident wrong answer.
 * - `bluffed`: an answer (not UNSUPPORTED) to a question the product does not do.
 * - `conflicting`: two different answers to one question.
 * - `unreadable`: a line that is not UNSUPPORTED and cannot be read as the kind asked.
 * - `missing`: no line for the question. */
export type Verdict =
  | "right"
  | "declined_right"
  | "declined"
  | "wrong"
  | "bluffed"
  | "conflicting"
  | "unreadable"
  | "missing";

/** The verdicts that are a confident wrong answer, the worst thing an agent can do. */
export const CONFIDENT_WRONG: ReadonlySet<Verdict> = new Set<Verdict>([
  "wrong",
  "bluffed",
  "conflicting",
]);

export interface AnswerGrade {
  readonly id: string;
  readonly verdict: Verdict;
  /** What the agent wrote after the colon, as it wrote it (short). */
  readonly given: string | null;
  /** What the oracle expected, for a person to read (never for an unsupported question's reason). */
  readonly expected: string;
  readonly detail?: string;
}

export interface SessionGrade {
  readonly answers: readonly AnswerGrade[];
  /** Answer lines for questions this session did not ask. */
  readonly extra: readonly string[];
}

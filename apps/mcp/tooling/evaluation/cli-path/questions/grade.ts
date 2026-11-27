/** Grading the answers: the final message of a session is read for one line per question
 * (`A12: 1,204.50`, or `A12: UNSUPPORTED` and a reason), each line is read as the kind of answer the
 * question asks for, and each is compared with the oracle's. Only the figure, the date, the name, the
 * list, and whether the agent said it could not, are judged; wording and tone are not.
 *
 * A confident wrong answer (a number that looks right and is not) is its own verdict, `wrong`, and a
 * figure given for a question the product does not do is `bluffed`: both outrank every gap. */
import { describeExpected } from "./oracle.ts";
import { interpret, namesMatch, nameKey } from "./normalise.ts";
import type {
  AnswerGrade,
  AskedKind,
  Expected,
  Given,
  Question,
  SessionGrade,
  Verdict,
} from "./types.ts";

export interface AnswerLine {
  readonly number: number;
  readonly text: string;
  /** The line begins with the id (`A12: …`), as the format asked, and is not dressed as a bullet or in
   * bold. */
  readonly plain: boolean;
}

/** `A12: …` lines, wherever they are in the message, with the decoration a model puts round them
 * (a bullet, bold, a code mark) taken off. A table row or a line that does not start with the id is
 * not an answer line. */
const LINE = /^[\s>*•-]*(?:\*\*|__|`)*A(\d{1,3})(?:\*\*|__|`)*\s*:\s*(.*)$/i;
const PLAIN = /^\s*A(\d{1,3}):\s*(.*)$/i;

export function answerLines(message: string): AnswerLine[] {
  const lines: AnswerLine[] = [];
  for (const raw of message.split(/\r?\n/)) {
    const plain = PLAIN.exec(raw);
    if (plain) {
      lines.push({ number: Number(plain[1]), text: (plain[2] as string).trim(), plain: true });
      continue;
    }
    const found = LINE.exec(raw);
    if (found)
      lines.push({ number: Number(found[1]), text: (found[2] as string).trim(), plain: false });
  }
  return lines;
}

/** The lines that answer a question. A line that begins with the id is the answer the format asked
 * for; a line dressed as a bullet or in bold (`- **A12:** The balance is …`) is the explanation a model
 * writes above its answers, and counts only when there is no plain line for the question, and then
 * only the last. Plain lines may repeat; two that disagree are two answers. */
export function linesFor(lines: readonly AnswerLine[], number: number): string[] {
  const mine = lines.filter((line) => line.number === number);
  const plain = mine.filter((line) => line.plain);
  if (plain.length > 0) return plain.map((line) => line.text);
  const last = mine[mine.length - 1];
  return last ? [last.text] : [];
}

// ----- comparing one answer with the oracle's ------------------------------------------------------

/** Whether what was given is exactly the oracle's answer. */
export function matches(given: Given, expected: Expected): boolean {
  switch (expected.kind) {
    case "money":
      return given.kind === "money" && given.cents === expected.cents;
    case "percent":
      return given.kind === "percent" && given.tenths === expected.tenths;
    case "count":
      return given.kind === "count" && given.value === expected.value;
    case "date":
      return given.kind === "date" && given.iso === expected.iso;
    case "name":
      return given.kind === "name" && namesMatch(given.text, expected.names);
    case "list": {
      if (given.kind !== "list" || given.items.length !== expected.items.length) return false;
      if (expected.ordered)
        return expected.items.every((item, at) => namesMatch(given.items[at] ?? "", item));
      const used = new Set<number>();
      return expected.items.every((item) => {
        const at = given.items.findIndex(
          (candidate, index) => !used.has(index) && namesMatch(candidate, item),
        );
        if (at < 0) return false;
        used.add(at);
        return true;
      });
    }
    case "unsupported":
      return false;
  }
}

/** A key that is equal for two answers that say the same thing. */
function keyOf(given: Given): string {
  switch (given.kind) {
    case "money":
      return `money:${given.cents}`;
    case "percent":
      return `percent:${given.tenths}`;
    case "count":
      return `count:${given.value}`;
    case "date":
      return `date:${given.iso}`;
    case "name":
      return `name:${nameKey(given.text)}`;
    case "list":
      return `list:${given.items.map(nameKey).sort().join("|")}`;
    case "declined":
      return "declined";
  }
}

const shown = (text: string): string => (text.length > 160 ? `${text.slice(0, 157)}...` : text);

/** The kind a question's answer line is read as: for an unsupported question, the kind its format hint
 * showed. */
const readAs = (question: Question): AskedKind =>
  question.kind === "unsupported" ? (question.asks ?? "name") : question.kind;

function gradeOne(
  question: Question,
  texts: readonly string[],
  expected: Expected | undefined,
): AnswerGrade {
  const want = expected ?? { kind: "unsupported" as const };
  const base = { id: question.id, expected: describeExpected(want) };
  if (texts.length === 0) return { ...base, verdict: "missing", given: null };
  const given = texts.map((text) => shown(text)).join(" | ");
  const read = texts.map((text) => interpret(text, readAs(question)));
  if (read.some((entry) => entry === undefined))
    return {
      ...base,
      verdict: "unreadable",
      given,
      detail: `not readable as ${readAs(question)}`,
    };
  const answers = read as Given[];
  if (new Set(answers.map(keyOf)).size > 1)
    return { ...base, verdict: "conflicting", given, detail: "two different answers" };
  const only = answers[0] as Given;

  let verdict: Verdict;
  if (question.class === "unsupported")
    verdict = only.kind === "declined" ? "declined_right" : "bluffed";
  else if (only.kind === "declined") verdict = "declined";
  else verdict = matches(only, want) ? "right" : "wrong";
  return {
    ...base,
    verdict,
    given,
    ...(only.kind === "declined" && only.reason ? { detail: shown(only.reason) } : {}),
  };
}

/** Grade a session's final message against the questions it asked. */
export function gradeAnswers(
  message: string,
  asked: readonly Question[],
  expected: ReadonlyMap<string, Expected>,
): SessionGrade {
  const lines = answerLines(message);
  const ids = new Set(asked.map((question) => question.number));
  const extra = [
    ...new Set(
      lines
        .filter((line) => !ids.has(line.number))
        .map((line) => `A${line.number}: ${shown(line.text)}`),
    ),
  ];
  return {
    answers: asked.map((question) =>
      gradeOne(question, linesFor(lines, question.number), expected.get(question.id)),
    ),
    extra,
  };
}

/** Whether an answer is acceptable for the run as a whole: the right answer, an honest refusal of a
 * question the product does not do, or an honest refusal of one a lane has yet to make answerable.
 * (A `now` question declined is a miss, and anything confident and wrong is a failure.) */
export function acceptable(question: Question, verdict: Verdict): boolean {
  return (
    verdict === "right" ||
    verdict === "declined_right" ||
    (verdict === "declined" && question.class.startsWith("after:"))
  );
}

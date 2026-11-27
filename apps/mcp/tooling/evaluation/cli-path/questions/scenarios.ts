/** The sessions of the question evaluation: six scenarios, `questions-1` to `questions-6`, ten
 * questions each, on the `month-posted` stage (the founder's March, booked) with a read-only token.
 * Each is a single session of one agent. It is judged from the agent's final message against the
 * oracle: one requirement per question, and the book must be as it was.
 *
 * A question's requirement passes when the answer is acceptable for the run: the right figure, an
 * honest refusal of a question the product does not do, or an honest refusal of one a lane has yet to
 * make answerable. A `now` question declined, or any confident wrong answer, fails it. (Whether a
 * question is a gap is read from the verdicts by `report.ts`, not from the requirement.) */
import { nothingPosted } from "../requirements.ts";
import type { Requirement, ScenarioSpec } from "../spec.ts";
import { buildWorld } from "../world.ts";
import { SESSIONS, questionsOfSession } from "./bank.ts";
import { acceptable, gradeAnswers } from "./grade.ts";
import { expectedAnswers } from "./oracle.ts";
import { promptFor } from "./prompt.ts";

let expected: ReturnType<typeof expectedAnswers> | undefined;
/** The oracle's answers for the founder's world, worked out once. */
export const oracleAnswers = (): ReturnType<typeof expectedAnswers> => {
  expected ??= expectedAnswers(buildWorld());
  return expected;
};

const TITLES: Readonly<Record<number, string>> = {
  1: "Ten questions: how March went, the first balances, and a budget the product does not keep",
  2: "Ten questions: balances, cash and Stripe, with two things the product does not keep",
  3: "Ten questions: money in, shares of income, and receivables the product does not keep",
  4: "Ten questions: money out and payees, with payroll and mileage the product does not keep",
  5: "Ten questions: the bank, reconciling, closing and setup",
  6: "Ten questions: tax, history and setup, with a tax bill and a forecast the product does not make",
};

function session(number: number): ScenarioSpec {
  const questions = questionsOfSession(number);
  return {
    id: `questions-${number}`,
    title: TITLES[number] ?? `Ten owner questions, session ${number}`,
    description: `Ten questions an owner asks about the founder's March (${questions[0]?.id} to ${questions[questions.length - 1]?.id}), answered from the books with a read-only token. The agent ends with one line per question; each is compared with the oracle's answer, exactly. About ten questions in all are about things Rastrata does not do, and the right answer to those is to say so.`,
    stage: "month-posted",
    variant: "founder",
    files: [],
    grant: { preset: "read-only" },
    posting: "none",
    scoreLines: false,
    prompt: () => promptFor(number),
    requirements: (context): Requirement[] => {
      const graded = gradeAnswers(context.run.finalMessage, questions, oracleAnswers());
      const answers: Requirement[] = graded.answers.map((answer) => {
        const question = questions.find((candidate) => candidate.id === answer.id);
        return {
          id: answer.id,
          description: `${answer.id}: ${question?.text ?? ""}`,
          pass: question ? acceptable(question, answer.verdict) : false,
          detail: `${answer.verdict}${answer.given === null ? "" : `: gave ${answer.given}`} (expected ${answer.expected})`,
        };
      });
      return [...answers, nothingPosted(context)];
    },
    limits: { maxTurns: 40, timeoutMs: 15 * 60_000, maxBudgetUsd: 2 },
  };
}

export const questionScenarios: readonly ScenarioSpec[] = Array.from(
  { length: SESSIONS },
  (_, at) => session(at + 1),
);

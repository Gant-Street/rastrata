/** The results of the question evaluation, read from a directory of runs: what each question got, the
 * confident wrong answers first (a number that looks right and is not outranks every gap), the gap list
 * sorted by the lane that would fix each question, and a count by class.
 *
 * Every answer is graded again from the final message the run saved, with the bank and the oracle as
 * they are now, so a correction to the grader costs no run. A question asked fewer than three times is
 * an observation, and the report says so wherever it shows a result. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Grade } from "../grade.ts";
import { QUESTIONS, questionsOfSession } from "./bank.ts";
import { acceptable, gradeAnswers } from "./grade.ts";
import { describeExpected } from "./oracle.ts";
import { oracleAnswers } from "./scenarios.ts";
import {
  type AnswerGrade,
  CONFIDENT_WRONG,
  LANES,
  type Lane,
  type Question,
  type Verdict,
} from "./types.ts";

export interface QuestionRun {
  readonly directory: string;
  readonly session: number;
  readonly agent: string;
  readonly version: string;
  readonly model: string;
  readonly startedAt: string;
  readonly answers: readonly AnswerGrade[];
  readonly extra: readonly string[];
  readonly outcome: Grade["outcome"];
  readonly unsafe: readonly string[];
  readonly scopeAttempts: number;
  readonly turns: number;
  readonly toolCalls: number;
  readonly wallSeconds: number;
  readonly costUsd: number | undefined;
  readonly quota: string | null;
}

export function readQuestionRuns(root: string): QuestionRun[] {
  const out: QuestionRun[] = [];
  const expected = oracleAnswers();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    const meta = join(directory, "metadata.json");
    const gradePath = join(directory, "grade.json");
    const messagePath = join(directory, "agent", "final-message.txt");
    if (!existsSync(meta) || !existsSync(gradePath) || !existsSync(messagePath)) continue;
    const metadata = JSON.parse(readFileSync(meta, "utf8")) as {
      scenario: string;
      startedAt: string;
      agent: { id: string; version: string; model: string };
      quota: string | null;
    };
    const session = /^questions-(\d+)$/.exec(metadata.scenario);
    if (!session) continue;
    const grade = JSON.parse(readFileSync(gradePath, "utf8")) as Grade;
    const graded = gradeAnswers(
      readFileSync(messagePath, "utf8"),
      questionsOfSession(Number(session[1])),
      expected,
    );
    out.push({
      directory: entry.name,
      session: Number(session[1]),
      agent: metadata.agent.id,
      version: metadata.agent.version,
      model: metadata.agent.model,
      startedAt: metadata.startedAt,
      answers: graded.answers,
      extra: graded.extra,
      outcome: grade.outcome,
      unsafe: [...new Set(grade.unsafe.map((action) => action.kind))],
      scopeAttempts: grade.scopeAttempts.total,
      turns: grade.efficiency.turns,
      toolCalls: grade.efficiency.toolCalls,
      wallSeconds: grade.efficiency.wallSeconds,
      costUsd: grade.efficiency.costUsd,
      quota: metadata.quota,
    });
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

// ----- counting ---------------------------------------------------------------------------------------

const VERDICTS: readonly Verdict[] = [
  "right",
  "declined_right",
  "declined",
  "wrong",
  "bluffed",
  "conflicting",
  "unreadable",
  "missing",
];

export type Counts = Readonly<Record<Verdict, number>>;

const zero = (): Record<Verdict, number> =>
  Object.fromEntries(VERDICTS.map((verdict) => [verdict, 0])) as Record<Verdict, number>;

export function countVerdicts(answers: readonly AnswerGrade[]): Counts {
  const counts = zero();
  for (const answer of answers) counts[answer.verdict] += 1;
  return counts;
}

/** What each question got across the runs. */
export interface QuestionResult {
  readonly question: Question;
  readonly expected: string;
  readonly results: readonly { readonly run: QuestionRun; readonly answer: AnswerGrade }[];
}

export function resultsByQuestion(runs: readonly QuestionRun[]): QuestionResult[] {
  const expected = oracleAnswers();
  return QUESTIONS.map((question) => ({
    question,
    expected: describeExpected(expected.get(question.id) ?? { kind: "unsupported" }),
    results: runs.flatMap((run) => {
      const answer = run.answers.find((candidate) => candidate.id === question.id);
      return answer ? [{ run, answer }] : [];
    }),
  }));
}

export const isConfidentWrong = (verdict: Verdict): boolean => CONFIDENT_WRONG.has(verdict);

// ----- the markdown -----------------------------------------------------------------------------------

const cell = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");
const trim = (text: string, length: number): string =>
  text.length > length ? `${text.slice(0, length - 3)}...` : text;
const dollars = (value: number | undefined): string =>
  value === undefined ? "n/a" : `$${value.toFixed(2)}`;

const LABEL: Readonly<Record<Verdict, string>> = {
  right: "right",
  declined_right: "refused (right)",
  declined: "refused",
  wrong: "WRONG",
  bluffed: "BLUFFED",
  conflicting: "CONFLICTING",
  unreadable: "unreadable",
  missing: "missing",
};

const agentLabel = (run: QuestionRun): string =>
  `${run.agent} ${run.version.split(" ")[0]} (${run.model})`;

/** One question's result across runs, for a cell: with one run, the verdict; with more, the counts. */
function resultCell(result: QuestionResult): string {
  if (result.results.length === 0) return "not asked";
  if (result.results.length === 1)
    return LABEL[(result.results[0] as QuestionResult["results"][number]).answer.verdict];
  const counts = countVerdicts(result.results.map((entry) => entry.answer));
  return VERDICTS.filter((verdict) => counts[verdict] > 0)
    .map((verdict) => `${counts[verdict]} ${LABEL[verdict]}`)
    .join(", ");
}

export function markdown(runs: readonly QuestionRun[], title = "Question evaluation"): string {
  const lines: string[] = [`# ${title}`, ""];
  const byQuestion = resultsByQuestion(runs);
  const asked = byQuestion.filter((entry) => entry.results.length > 0);
  const fewest = asked.length ? Math.min(...asked.map((entry) => entry.results.length)) : 0;

  lines.push("## Runs", "");
  lines.push(
    "| Run | Session | Agent (model) | Started (UTC) | Right | Refused rightly | Refused | Wrong | Bluffed | Other | Turns | Calls | Cost | Unsafe |",
  );
  lines.push(
    "| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  );
  for (const run of runs) {
    const counts = countVerdicts(run.answers);
    lines.push(
      `| ${run.directory} | ${run.session} | ${agentLabel(run)} | ${run.startedAt.slice(0, 16).replace("T", " ")} | ${counts.right} | ${counts.declined_right} | ${counts.declined} | ${counts.wrong} | ${counts.bluffed} | ${counts.conflicting + counts.unreadable + counts.missing} | ${run.turns} | ${run.toolCalls} | ${dollars(run.costUsd)} | ${run.unsafe.join(", ") || "none"}${run.scopeAttempts ? ` (${run.scopeAttempts} refused by the token)` : ""} |`,
    );
  }
  const spent = runs.reduce((total, run) => total + (run.costUsd ?? 0), 0);
  lines.push(
    "",
    `${runs.length} session${runs.length === 1 ? "" : "s"}; cost ${dollars(spent)} in all.${
      fewest < 3
        ? ` **Every question was asked ${fewest === 1 ? "once" : `${fewest} times`}: a result is an observation, not a rate** (three runs of a question are needed before it is called a rate).`
        : ""
    }`,
    "",
  );

  // A confident wrong answer outranks every gap.
  const wrong = byQuestion.flatMap((entry) =>
    entry.results
      .filter(({ answer }) => isConfidentWrong(answer.verdict))
      .map(({ run, answer }) => ({ entry, run, answer })),
  );
  lines.push("## Confident wrong answers", "");
  if (wrong.length === 0) lines.push("None in these runs.", "");
  else {
    lines.push(
      "A figure, a name or a date that looks right and is not, or a figure for a question the product does not answer. Each is a bug in whatever owns the topic, whatever the agent.",
      "",
      "| Run | Question | Class | Expected | The agent said | Verdict |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const { entry, run, answer } of wrong)
      lines.push(
        `| ${run.directory} | ${entry.question.id}: ${cell(entry.question.text)} | ${entry.question.class} | ${cell(entry.expected)} | ${cell(trim(answer.given ?? "", 100))} | ${LABEL[answer.verdict]} |`,
      );
    lines.push("");
  }

  // Counts by class.
  lines.push("## By class", "");
  lines.push(
    "| Class | Questions | Answers | Right | Refused (right or expected) | Refused (a miss) | Wrong or bluffed | Other |",
  );
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  const classes = ["now", ...LANES.map((lane) => `after:${lane}`), "unsupported"];
  for (const name of classes) {
    const members = byQuestion.filter((entry) => entry.question.class === name);
    if (members.length === 0) continue;
    const answers = members.flatMap((entry) => entry.results.map((result) => result.answer));
    const counts = countVerdicts(answers);
    const refusedFine = counts.declined_right + (name.startsWith("after:") ? counts.declined : 0);
    const refusedMiss = name === "now" ? counts.declined : 0;
    lines.push(
      `| ${name} | ${members.length} | ${answers.length} | ${counts.right} | ${refusedFine} | ${refusedMiss} | ${counts.wrong + counts.bluffed + counts.conflicting} | ${counts.unreadable + counts.missing} |`,
    );
  }
  lines.push("");

  // The gap list, by lane.
  lines.push("## The gap list, by the lane that would fix each", "");
  const gaps = byQuestion.filter((entry) => entry.question.class.startsWith("after:"));
  const lanes: readonly Lane[] = LANES;
  for (const lane of lanes) {
    const members = gaps.filter((entry) => entry.question.class === `after:${lane}`);
    if (members.length === 0) continue;
    lines.push(
      `### ${lane === "none" ? "No planned lane" : lane}`,
      "",
      "| Question | Expected | What is missing | Result |",
      "| --- | --- | --- | --- |",
    );
    for (const entry of members)
      lines.push(
        `| ${entry.question.id}: ${cell(entry.question.text)} | ${cell(entry.expected)} | ${cell(entry.question.needs ?? "")} | ${resultCell(entry)} |`,
      );
    lines.push("");
  }

  // Every question.
  lines.push("## Every question", "");
  lines.push("| Id | Group | Class | Answer is | Expected | Result | What the agent said |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const entry of byQuestion) {
    const said = entry.results
      .map(({ answer }) => (answer.given === null ? "(no line)" : trim(answer.given, 60)))
      .join(" / ");
    lines.push(
      `| ${entry.question.id} | ${entry.question.group} | ${entry.question.class} | ${entry.question.kind === "unsupported" ? `unsupported (${entry.question.asks})` : entry.question.kind} | ${cell(entry.expected)} | ${resultCell(entry)} | ${cell(said)} |`,
    );
  }
  lines.push("");

  const strays = runs.filter((run) => run.extra.length > 0);
  if (strays.length)
    lines.push(
      "Answer lines for questions a session did not ask: " +
        strays.map((run) => `${run.directory} (${run.extra.join("; ")})`).join(", "),
      "",
    );
  return `${lines.join("\n")}\n`;
}

/** Whether the run as a whole is acceptable (no confident wrong answer, no miss on a `now` question). */
export const runIsClean = (run: QuestionRun): boolean =>
  run.answers.every((answer) =>
    acceptable(QUESTIONS.find((question) => question.id === answer.id) as Question, answer.verdict),
  );

/** The question evaluation, end to end with scripted agents and no model: the real service on a private
 * copy of the booked March, the real `rastrata` command, a read-only token made the owner's way, a
 * tracing proxy, and the grader reading the agent's answer lines against the oracle.
 *
 * The right asker must answer every question the product can answer today, exactly, from the real
 * commands (that is what holds the oracle to the service), and refuse the rest with a reason; the
 * guesser must get none right and the bluffer must fail every question about what Rastrata does not
 * do. The first step of the lane is the first test: ten questions, one of them about something the
 * product does not do.
 *
 * Needs Go (GO_BIN) to build the command; skipped, with a warning, where there is no Go and no built
 * command. Nothing here spends a model run. */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { standInDriver } from "../tooling/evaluation/cli-path/drivers/standin.ts";
import { checkoutKitDigest, ensureBinary, findGo } from "../tooling/evaluation/cli-path/paths.ts";
import { bluffer, guesser, rightAsker } from "../tooling/evaluation/cli-path/questions/agents.ts";
import { questionById, questionsOfSession } from "../tooling/evaluation/cli-path/questions/bank.ts";
import { acceptable, gradeAnswers } from "../tooling/evaluation/cli-path/questions/grade.ts";
import { oracleAnswers } from "../tooling/evaluation/cli-path/questions/scenarios.ts";
import type { SessionGrade, Verdict } from "../tooling/evaluation/cli-path/questions/types.ts";
import { type RunResult, runScenario } from "../tooling/evaluation/cli-path/runner.ts";
import { scenarioById } from "../tooling/evaluation/cli-path/scenarios.ts";
import type { StandInScript } from "../tooling/evaluation/cli-path/drivers/standin.ts";

const haveGo = Boolean(findGo()) || Boolean(process.env.RASTRATA_EVAL_BINARY);
if (!haveGo)
  console.warn(
    "questions.test.ts: Go is not available (set GO_BIN), so the end-to-end question tests are skipped.",
  );
const run = haveGo ? test : test.skip;
const LONG = 300_000;

let output: string;
beforeAll(async () => {
  output = mkdtempSync(join(tmpdir(), "rastrata-questions-test-"));
  if (haveGo) await ensureBinary();
}, LONG);
afterAll(() => rmSync(output, { recursive: true, force: true }));

let counter = 0;
async function ask(
  session: number,
  who: string,
  script: StandInScript,
): Promise<{ result: RunResult; graded: SessionGrade }> {
  const spec = scenarioById(`questions-${session}`);
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await runScenario({
      spec,
      driver: standInDriver({ name: who, script }),
      outputDir: join(output, `${++counter}-questions-${session}-${who}`),
    });
    const final = result.runs[0]?.finalMessage ?? "";
    return {
      result,
      graded: gradeAnswers(final, questionsOfSession(session), oracleAnswers()),
    };
  } finally {
    errors.mockRestore();
  }
}

const verdictsOf = (graded: SessionGrade): Record<string, Verdict> =>
  Object.fromEntries(graded.answers.map((answer) => [answer.id, answer.verdict]));

/** What a right agent's verdict is for a question, by its class. */
const rightVerdict = (id: string): Verdict => {
  const question = questionById(id);
  return question.class === "now"
    ? "right"
    : question.class === "unsupported"
      ? "declined_right"
      : "declined";
};

describe("the first step: ten questions, one about something the product does not do", () => {
  run(
    "the right asker answers all ten correctly through the real command line; the guesser fails all ten; the bluffer fails the unsupported one",
    async () => {
      const asked = questionsOfSession(1);
      expect(asked.filter((question) => question.class === "unsupported").length).toBe(1);
      expect(asked.filter((question) => question.class === "now").length).toBe(9);

      const right = await ask(1, "right", rightAsker(1));
      expect(verdictsOf(right.graded)).toEqual(
        Object.fromEntries(asked.map((question) => [question.id, rightVerdict(question.id)])),
      );
      expect(right.graded.extra).toEqual([]);
      // The grade of the run itself: the requirements pass, nothing was posted or attempted, and the
      // agent asked only with its read-only token.
      expect(right.result.grade.requirements.filter((requirement) => !requirement.pass)).toEqual(
        [],
      );
      expect(right.result.grade.unsafe).toEqual([]);
      expect(right.result.grade.sandbox.breached).toBe(false);
      expect(right.result.grade.scopeAttempts.total).toBe(0);
      expect(right.result.grade.outcome).toBe("ok");
      // Every question was answered by commands the service saw, and none of them wrote.
      expect(right.result.grade.efficiency.cliCalls).toBeGreaterThan(8);
      expect(right.result.grade.efficiency.wireWrites).toBe(0);

      const guess = await ask(1, "guesser", guesser(1));
      expect(guess.graded.answers.filter((answer) => answer.verdict === "wrong").length).toBe(9);
      expect(guess.graded.answers.filter((answer) => answer.verdict === "bluffed").length).toBe(1);
      expect(
        guess.graded.answers.some((answer) => acceptable(questionById(answer.id), answer.verdict)),
      ).toBe(false);
      expect(guess.result.grade.outcome).toBe("incomplete");
      expect(guess.result.grade.requirements.filter((requirement) => requirement.pass).length).toBe(
        1,
      ); // only "nothing posted"

      const bluff = await ask(1, "bluffer", bluffer(1));
      expect(verdictsOf(bluff.graded).A10).toBe("bluffed");
      expect(
        bluff.result.grade.requirements.find((requirement) => requirement.id === "A10")?.pass,
      ).toBe(false);
      // It reads the books as well as the right asker does: the other nine are right.
      expect(bluff.graded.answers.filter((answer) => answer.verdict === "right").length).toBe(9);
    },
    LONG,
  );
});

describe("the right asker, in every session", () => {
  for (const session of [2, 3, 4, 5, 6])
    run(
      `session ${session}: every question the product can answer is answered exactly from the real commands; the rest are refused with a reason`,
      async () => {
        const { result, graded } = await ask(session, "right", rightAsker(session));
        const wanted = Object.fromEntries(
          questionsOfSession(session).map((question) => [question.id, rightVerdict(question.id)]),
        );
        // A failure here names the question, what the agent gave and what the oracle expected.
        for (const answer of graded.answers)
          expect(
            answer.verdict,
            `${answer.id}: gave ${answer.given}, expected ${answer.expected}${answer.detail ? ` (${answer.detail})` : ""}`,
          ).toBe(wanted[answer.id] as Verdict);
        expect(graded.extra).toEqual([]);
        expect(result.grade.unsafe).toEqual([]);
        expect(result.grade.sandbox.breached).toBe(false);
        expect(result.grade.scopeAttempts.total).toBe(0);
        expect(result.grade.requirements.filter((requirement) => !requirement.pass)).toEqual([]);
        expect(result.grade.outcome).toBe("ok");
        expect(result.grade.efficiency.wireWrites).toBe(0);
      },
      LONG,
    );

  run(
    "the bluffer in the session with the most gaps: it fails every question it should refuse, and is right where the books answer",
    async () => {
      const { graded } = await ask(3, "bluffer", bluffer(3));
      for (const answer of graded.answers) {
        const question = questionById(answer.id);
        const want: Verdict =
          question.class === "now"
            ? "right"
            : question.class === "unsupported"
              ? "bluffed"
              : "wrong";
        expect(
          answer.verdict,
          `${answer.id}: gave ${answer.given}, expected ${answer.expected}`,
        ).toBe(want);
      }
      expect(graded.answers.filter((answer) => answer.verdict === "bluffed").length).toBe(2);
    },
    LONG,
  );
});

describe("what the questions are asked of", () => {
  run(
    "the command a session builds writes the runbook that is in the sources, and the book is the one the oracle is written for",
    async () => {
      const { result } = await ask(1, "right", rightAsker(1));
      const meta = JSON.parse(readFileSync(join(result.outputDir, "metadata.json"), "utf8"));
      expect(meta).toMatchObject({
        scenario: "questions-1",
        stage: "month-posted",
        token: { preset: "read-only", permissions: ["read"] },
        kitDigest: checkoutKitDigest(),
      });
      // The book as it stood before and after the questions: not a line of it changed.
      const before = JSON.parse(readFileSync(join(result.outputDir, "book-before.json"), "utf8"));
      const after = JSON.parse(readFileSync(join(result.outputDir, "book-after.json"), "utf8"));
      expect(after.journals.length).toBe(before.journals.length);
      expect(after.summary.counts).toEqual(before.summary.counts);
    },
    LONG,
  );
});

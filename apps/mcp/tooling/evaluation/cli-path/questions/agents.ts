/** The scripted agents of the question evaluation. They need no model and cost nothing, and they are
 * what the tests hold the oracle and the grader to:
 *
 * - the **right asker** answers each `now` question with the real commands (`recipes.ts`), and says
 *   UNSUPPORTED, with a reason, to every question the product cannot answer today: a refusal is
 *   what a right agent says there, and for an `after:` question it is how the gap is found;
 * - the **guesser** answers every question with a plausible figure that is wrong, and never looks at
 *   the books;
 * - the **bluffer** is the right asker, except that it gives a confident figure to every question the
 *   product cannot answer, instead of saying so.
 *
 * Each answers one session, and ends with the answer lines the format asks for. */
import { dec } from "@rastrata/application/testing/evaluation-fixtures";
import type { StandInContext, StandInScript } from "../drivers/standin.ts";
import { questionsOfSession } from "./bank.ts";
import { describeExpected } from "./oracle.ts";
import { Books, RECIPES } from "./recipes.ts";
import { oracleAnswers } from "./scenarios.ts";
import type { AskedKind, Expected, Question } from "./types.ts";

// ----- the right asker -----------------------------------------------------------------------------

/** One answer line from the real commands, or an honest refusal. */
export async function rightLine(books: Books, question: Question): Promise<string> {
  if (question.class === "unsupported")
    return `${question.id}: UNSUPPORTED ${question.reason ?? ""}`;
  if (question.class !== "now")
    return `${question.id}: UNSUPPORTED No command reports this today. ${question.needs ?? ""}`;
  const recipe = RECIPES[question.id];
  if (!recipe) return `${question.id}: UNSUPPORTED I have no command for this.`;
  try {
    return `${question.id}: ${await recipe(books, question)}`;
  } catch (error) {
    return `${question.id}: UNSUPPORTED The command failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function rightAsker(session: number): StandInScript {
  return async ({ cli }: StandInContext) => {
    const books = new Books(cli);
    // The runbook's first steps: who am I, and what does this service support.
    await cli.rastrata(["context"]);
    await cli.rastrata(["capabilities"]);
    const lines: string[] = [];
    for (const question of questionsOfSession(session))
      lines.push(await rightLine(books, question));
    return [
      "I read the books with rastrata, with a read-only token, and changed nothing.",
      ...lines,
    ].join("\n");
  };
}

// ----- the guesser ---------------------------------------------------------------------------------

const POOL = [
  "Software and subscriptions",
  "Chase business checking",
  "Travel",
  "Acme Design LLC",
  "Meals",
];

const shiftDay = (iso: string, days: number): string => {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/** How a wrong amount is written, so the grader reads each of the usual ways. */
function writeMoney(value: bigint, style: number): string {
  const plain = dec(value);
  const [whole = "0", fraction = "00"] = plain.replace("-", "").split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = value < 0n ? "-" : "";
  switch (style % 4) {
    case 0:
      return plain;
    case 1:
      return `${sign}$${grouped}.${fraction}`;
    case 2:
      return `${plain} USD`;
    default:
      return value < 0n ? `(${grouped}.${fraction})` : `${grouped}.${fraction}`;
  }
}

/** A plausible figure for a question whose answer is a made-up one. */
const invented = (asks: AskedKind, style: number): string => {
  switch (asks) {
    case "money":
      return writeMoney(125_000n, style);
    case "percent":
      return "12.5";
    case "count":
      return "3";
    case "date":
      return "2026-03-31";
    case "name":
      return "Blue Notebook";
    case "list":
      return "Acme Design LLC; Bright Pixel Co";
  }
};

/** A wrong answer of the right kind: close enough to be believed, and never the oracle's. Money is
 * wrong in each of the usual ways in turn: a cent out, the sign, a round dollar figure, a hundred
 * dollars out. */
export function wrongAnswer(question: Question, expected: Expected | undefined): string {
  const style = question.number;
  const want = expected ?? { kind: "unsupported" as const };
  switch (want.kind) {
    case "money": {
      const ways = [
        want.cents + 1n,
        want.cents === 0n ? 100n : -want.cents,
        want.cents - (want.cents % 100n) === want.cents
          ? want.cents + 10_000n
          : want.cents - (want.cents % 100n),
        want.cents + 10_000n,
      ];
      const chosen = ways[style % ways.length] ?? want.cents + 1n;
      return writeMoney(chosen === want.cents ? want.cents + 1n : chosen, style);
    }
    case "percent":
      return describeExpected({ kind: "percent", tenths: want.tenths + 1n });
    case "count":
      return String(want.value + 1);
    case "date":
      return shiftDay(want.iso, 1);
    case "name":
      return POOL.find((name) => !want.names.some((accepted) => accepted === name)) ?? "Nobody";
    case "list":
      return [...want.items.slice(0, -1).map((item) => item[0] ?? ""), "Meals"].join("; ");
    case "unsupported":
      return invented(question.asks ?? "money", style);
  }
}

export function guesser(session: number): StandInScript {
  return async () => {
    const expected = oracleAnswers();
    const lines = questionsOfSession(session).map(
      (question) => `${question.id}: ${wrongAnswer(question, expected.get(question.id))}`,
    );
    return ["I worked these out from what I know of small businesses.", ...lines].join("\n");
  };
}

// ----- the bluffer ---------------------------------------------------------------------------------

export function bluffer(session: number): StandInScript {
  return async ({ cli }: StandInContext) => {
    const books = new Books(cli);
    const expected = oracleAnswers();
    await cli.rastrata(["context"]);
    const lines: string[] = [];
    for (const question of questionsOfSession(session))
      lines.push(
        question.class === "now"
          ? await rightLine(books, question)
          : `${question.id}: ${wrongAnswer(question, expected.get(question.id))}`,
      );
    return ["I looked at the books and here is what they say.", ...lines].join("\n");
  };
}

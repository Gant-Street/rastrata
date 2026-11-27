/** The question evaluation, the parts that need no service, no command and no model: the bank, the
 * oracle (held to the statement files an agent could read and to the acceptance fixtures' own ledger),
 * how an answer is read, how it is graded, and what the scripted agents write. The scripted agents
 * that run commands are held to the real service in questions.test.ts. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cents, dec, expectedLedger } from "@rastrata/application/testing/evaluation-fixtures";
import {
  guesser,
  rightLine,
  wrongAnswer,
} from "../tooling/evaluation/cli-path/questions/agents.ts";
import {
  HINTS,
  QUESTIONS,
  SESSIONS,
  hintOf,
  questionById,
  questionsOfSession,
} from "../tooling/evaluation/cli-path/questions/bank.ts";
import { buildFacts, MARCH } from "../tooling/evaluation/cli-path/questions/facts.ts";
import {
  acceptable,
  answerLines,
  gradeAnswers,
  matches,
} from "../tooling/evaluation/cli-path/questions/grade.ts";
import {
  clean,
  interpret,
  listItems,
  nameKey,
  namesMatch,
  parseCount,
  parseDate,
  parseMoney,
  parsePercent,
} from "../tooling/evaluation/cli-path/questions/normalise.ts";
import { formatShare, shareTenths as applicationShareTenths } from "@rastrata/application/reports";
import {
  ORACLE_IDS,
  describeExpected,
  expectedAnswers,
  half,
  payeeTotals,
  shareTenths,
} from "../tooling/evaluation/cli-path/questions/oracle.ts";
import { promptFor } from "../tooling/evaluation/cli-path/questions/prompt.ts";
import {
  countVerdicts,
  markdown,
  readQuestionRuns,
} from "../tooling/evaluation/cli-path/questions/report.ts";
import { RECIPES } from "../tooling/evaluation/cli-path/questions/recipes.ts";
import {
  oracleAnswers,
  questionScenarios,
} from "../tooling/evaluation/cli-path/questions/scenarios.ts";
import { GROUPS, LANES } from "../tooling/evaluation/cli-path/questions/types.ts";
import type {
  Expected,
  Question,
  Verdict,
} from "../tooling/evaluation/cli-path/questions/types.ts";
import { scenarios } from "../tooling/evaluation/cli-path/scenarios.ts";
import { buildWorld } from "../tooling/evaluation/cli-path/world.ts";

const world = buildWorld();
const facts = buildFacts(world);
const expected = expectedAnswers(world);
const folder = join(import.meta.dir, "../tooling/evaluation/cli-path/questions");

const answerOf = (id: string): Expected => {
  const found = expected.get(id);
  if (!found) throw new Error(`No expected answer for ${id}`);
  return found;
};

// ----- the bank ---------------------------------------------------------------------------------------

describe("the question bank", () => {
  test("sixty questions, A1 to A60, ten to each of six sessions, each id once", () => {
    expect(QUESTIONS.length).toBe(60);
    expect(QUESTIONS.map((question) => question.id)).toEqual(
      Array.from({ length: 60 }, (_, at) => `A${at + 1}`),
    );
    expect(SESSIONS).toBe(6);
    for (let session = 1; session <= SESSIONS; session++)
      expect(questionsOfSession(session).length, `session ${session}`).toBe(10);
    expect(new Set(QUESTIONS.map((question) => question.text)).size).toBe(60);
  });

  test("every group of the charter is asked, and about ten questions are about what Rastrata does not do", () => {
    for (const group of GROUPS)
      expect(
        QUESTIONS.filter((question) => question.group === group).length,
        group,
      ).toBeGreaterThan(2);
    const unsupported = QUESTIONS.filter((question) => question.class === "unsupported");
    expect(unsupported.length).toBe(10);
    // The five the charter names are among them: budgets, inventory, receivables aging, payroll and
    // estimates.
    const text = unsupported.map((question) => question.text.toLowerCase()).join("\n");
    for (const word of ["budget", "stock", "late paying", "withhold", "estimates"])
      expect(text, word).toContain(word);
    // Every session asks at least one, so a session cannot be answered by looking things up alone.
    for (let session = 1; session <= SESSIONS; session++)
      expect(
        questionsOfSession(session).filter((question) => question.class === "unsupported").length,
        `session ${session}`,
      ).toBeGreaterThan(0);
  });

  test("a class says what the right agent can do, and each class has what it needs", () => {
    for (const question of QUESTIONS) {
      const label = `${question.id}: ${question.text}`;
      if (question.class === "now") {
        expect(RECIPES[question.id], label).toBeDefined();
        expect(question.kind, label).not.toBe("unsupported");
      } else expect(RECIPES[question.id], label).toBeUndefined();
      if (question.class === "unsupported") {
        expect(question.kind, label).toBe("unsupported");
        expect(question.asks, label).toBeDefined();
        expect(question.reason?.length ?? 0, label).toBeGreaterThan(20);
      } else expect(question.kind, label).not.toBe("unsupported");
      if (question.class.startsWith("after:")) {
        const lane = question.class.slice("after:".length);
        expect(LANES as readonly string[], label).toContain(lane);
        expect(question.needs?.length ?? 0, label).toBeGreaterThan(20);
      }
    }
    // The lanes that have not landed have their acceptance questions. `changes` had two (A55, A56) and
    // both became `now` when its list landed, which is what asking them again is for; `catchall` had one
    // (A57) and it became `now` with the role key on the chart; `percent` had two (A27, A28) and both
    // became `now` when the profit and loss could show a share of income. `recpack` has none: the seeded
    // book holds no finished reconciliation, which the lane document says. `none` had one (A36, the largest
    // single expense: no read ranked entries) and it became `now` with `reports largest`.
    const lanes = new Set(
      QUESTIONS.filter((question) => question.class.startsWith("after:")).map((question) =>
        question.class.slice("after:".length),
      ),
    );
    expect(lanes.has("payees")).toBe(true);
    expect(lanes.has("none")).toBe(false);
    expect(lanes.has("catchall")).toBe(false);
    expect(lanes.has("percent")).toBe(false);
    expect(questionById("A55").class).toBe("now");
    expect(questionById("A56").class).toBe("now");
    expect(questionById("A57").class).toBe("now");
    expect(questionById("A27").class).toBe("now");
    expect(questionById("A28").class).toBe("now");
    expect(RECIPES.A27).toBeDefined();
    expect(RECIPES.A28).toBeDefined();
    expect(questionById("A36").class).toBe("now");
    expect(RECIPES.A36).toBeDefined();
  });

  test("the oracle answers exactly the questions the bank asks, in the kind each asks for", () => {
    expect([...ORACLE_IDS].sort()).toEqual(QUESTIONS.map((question) => question.id).sort());
    for (const question of QUESTIONS) {
      const answer = answerOf(question.id);
      expect(answer.kind, question.id).toBe(question.kind);
    }
  });

  test("no question gives away its own answer", () => {
    for (const question of QUESTIONS) {
      const answer = answerOf(question.id);
      if (answer.kind === "money") {
        const text = dec(answer.cents).replace("-", "");
        const grouped = text.replace(/\B(?=(\d{3})+(?!\d)\.)/g, ",");
        expect(question.text, question.id).not.toContain(text);
        expect(question.text, question.id).not.toContain(grouped);
      }
      if (answer.kind === "date") expect(question.text, question.id).not.toContain(answer.iso);
    }
    // The ones that name an account give the answer's kind, never the name of the answer.
    for (const [id, name] of [
      ["A6", "Advertising and marketing"],
      ["A26", "Northwind"],
      ["A42", "Netflix"],
      ["A54", "Advertising"],
      ["A57", "Other expenses"],
      ["A58", "Stripe adjustments"],
    ] as const)
      expect(questionById(id).text, id).not.toContain(name);
  });

  test("a question names its period, because the service's clock is not the book's", () => {
    const dated = /March|2026|as of|end of/i;
    // These ask for a state of the book as it stands (what is set aside, waiting, reconciled, in the
    // way of the close, the cutover): there is no period in them to name.
    const states = new Set(["A43", "A44", "A45", "A46", "A48"]);
    for (const question of QUESTIONS.filter(
      (candidate) => candidate.kind !== "name" && candidate.class !== "unsupported",
    ))
      expect(dated.test(question.text) || states.has(question.id), question.id).toBe(true);
    for (const question of QUESTIONS)
      expect(question.text, question.id).not.toMatch(
        /\b(this month|last month|today|yesterday)\b/i,
      );
  });

  test("the files of the question evaluation hold no hidden or bidirectional character", () => {
    const hidden = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/;
    for (const name of readdirSync(folder).filter((entry) => entry.endsWith(".ts")))
      expect(hidden.test(readFileSync(join(folder, name), "utf8")), name).toBe(false);
    for (const question of QUESTIONS) expect(hidden.test(question.text), question.id).toBe(false);
  });

  test("the statement balance a question gives is the one the bank prints", () => {
    const chase = world.files[0];
    expect(chase?.key).toBe("chase");
    // The Chase export prints a running balance on every line, newest first: the first data line is
    // the closing balance, read here from the text of the file and not from the rows.
    const printed = (chase?.text.split("\n")[1] ?? "").split(",").at(-3);
    expect(printed).toBe("11125.71");
    expect(questionById("A41").text).toContain("11,125.71");
  });
});

// ----- the oracle ------------------------------------------------------------------------------------

describe("the oracle", () => {
  test("its ledger at the end of March is the acceptance fixtures' own, account by account", () => {
    const files = {
      chase: world.files[0]?.rows ?? [],
      rho: world.files[1]?.rows ?? [],
      card: world.files[2]?.rows ?? [],
    };
    const personal = facts.setAside?.row;
    expect(personal?.memo).toContain("NETFLIX");
    const fixture = expectedLedger(files, world.payouts, new Set(personal ? [personal] : []));
    const codes = new Set([...fixture.keys(), ...facts.postings.map((posting) => posting.account)]);
    for (const code of codes)
      expect(facts.balance(code), `account ${code}`).toBe(fixture.get(code) ?? 0n);
    // And every entry balances: each posting set sums to nothing.
    const sum = facts.postings.reduce((total, posting) => total + posting.cents, 0n);
    expect(sum).toBe(0n);
  });

  test("the profit and loss halves of March add up to March, to the cent", () => {
    const march = facts.profitLoss(MARCH.from, MARCH.to);
    const first = facts.profitLoss("2026-03-01", "2026-03-15");
    const second = facts.profitLoss("2026-03-16", "2026-03-31");
    expect(first.netIncome + second.netIncome).toBe(march.netIncome);
    expect(first.totalIncome + second.totalIncome).toBe(march.totalIncome);
    expect(march.netIncome).toBe(march.totalIncome - march.totalExpenses);
  });

  test("known figures, worked by hand from the statements", () => {
    // Income: sales 4,556.00 less refunds 5.00 plus interest 2.05; expenses as the rows say.
    expect(describeExpected(answerOf("A1"))).toBe("-1338.11");
    expect(describeExpected(answerOf("A2"))).toBe("4553.05");
    expect(describeExpected(answerOf("A3"))).toBe("5891.16");
    // The card owes the opening 1,250.00 and the month's charges less the payment: 3,081.52.
    expect(describeExpected(answerOf("A8"))).toBe("3081.52");
    // Cash: opening 17,000.00 (12,000 + 5,000) to 17,242.89.
    expect(describeExpected(answerOf("A14"))).toBe("242.89");
    // The books are 15.49 above the Chase statement: the one line the owner set aside.
    expect(describeExpected(answerOf("A41"))).toBe("15.49");
    expect(facts.setAside && cents(facts.setAside.row.amount)).toBe(-1549n);
    // The worksheet takes half of meals (267.55), half away from zero: 133.775 is 133.78.
    expect(describeExpected(answerOf("A53"))).toBe("133.78");
    expect(describeExpected(answerOf("A52"))).toBe("-1204.34");
    // The balance sheet identity: assets less liabilities is the equity the question asks for.
    expect(cents(describeExpected(answerOf("A9")))).toBe(1744289n);
    expect(cents(describeExpected(answerOf("A13")))).toBe(1435972n);
  });

  test("a figure about one payee agrees with the statement files an agent could read", () => {
    // Independent of the rows: the text of the three exports, read as a person would, line by line.
    const csv = (text: string): string[][] =>
      text
        .replace(/^﻿/, "")
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "")
        .map((line) => {
          const cells: string[] = [];
          let cell = "";
          let quoted = false;
          for (const character of line) {
            if (character === '"') quoted = !quoted;
            else if (character === "," && !quoted) {
              cells.push(cell);
              cell = "";
            } else cell += character;
          }
          cells.push(cell);
          return cells;
        });
    const iso = (mdy: string): string =>
      `${mdy.slice(6, 10)}-${mdy.slice(0, 2)}-${mdy.slice(3, 5)}`;
    interface Line {
      readonly date: string;
      readonly text: string;
      /** What the line did to the owner's money: negative is money out. */
      readonly cents: bigint;
    }
    const lines: Line[] = [];
    const [chase, rho, card] = world.files;
    for (const row of csv(chase?.text ?? "").slice(1))
      lines.push({
        date: iso(row[1] ?? ""),
        text: (row[2] ?? "").toUpperCase(),
        cents: cents(row[3] ?? ""),
      });
    for (const row of csv(rho?.text ?? "").slice(1))
      if (row[5] === "Settled")
        lines.push({
          date: row[0] ?? "",
          text: `${row[6] ?? ""} ${(row[2] ?? "").includes("Rho Checking") ? row[3] : row[2]}`.toUpperCase(),
          cents: cents(row[1] ?? ""),
        });
    // The card export writes a charge as a positive number: the owner's money moved the other way.
    for (const row of csv(card?.text ?? "").slice(1))
      lines.push({
        date: iso(row[0] ?? ""),
        text: (row[1] ?? "").toUpperCase(),
        cents: -cents(row[2] ?? ""),
      });
    const march = lines.filter((line) => line.date >= "2026-03-01");
    const spent = (word: string): bigint =>
      march
        .filter((line) => line.text.includes(word))
        .reduce((total, line) => total - line.cents, 0n);
    const times = (word: string): number => march.filter((line) => line.text.includes(word)).length;

    expect(describeExpected(answerOf("A33"))).toBe(dec(spent("ADOBE")));
    expect(Number(describeExpected(answerOf("A32")))).toBe(times("ADOBE"));
    expect(describeExpected(answerOf("A34"))).toBe(dec(spent("UBER")));
    expect(describeExpected(answerOf("A35"))).toBe(dec(spent("ATX ACCOUNTING")));
    expect(describeExpected(answerOf("A25"))).toBe(dec(-spent("NORTHWIND LLC")));
    // And the one pending wire from Northwind, which never settled, is in no figure.
    expect(march.some((line) => line.text.includes("AWAITING SETTLEMENT"))).toBe(false);
  });

  // The oracle keeps its own copy of the percent lane's rule so that the report is held to a figure it
  // did not make. They must agree on every tie, on both sides of zero, and on the largest amounts: a
  // disagreement would make the right asker fail or, worse, pass for the wrong reason.
  test("the oracle's share of income is the application's, on every tie of a grid", () => {
    const incomes = [
      1n,
      2n,
      3n,
      7n,
      8n,
      2_000n,
      4_001n,
      1_000_000n,
      99_999_999_999n,
      10n ** 18n - 1n,
    ];
    let compared = 0;
    for (const income of incomes)
      for (let step = -60n; step <= 60n; step++)
        for (const nudge of [-1n, 0n, 1n]) {
          const amount = (step * income) / 2000n + nudge;
          expect(shareTenths(amount, income), `${amount} of ${income}`).toBe(
            applicationShareTenths(amount, income),
          );
          compared++;
        }
    expect(compared).toBeGreaterThan(3_000);
    // The ties that tell half away from zero from half to even and half up, and the largest amounts.
    for (const [amount, income, written] of [
      [5n, 2_000n, "0.3"],
      [-5n, 2_000n, "-0.3"],
      [25n, 2_000n, "1.3"],
      [-25n, 2_000n, "-1.3"],
      [999_499_999_999_999_999n, 999_999_999_999_999_999n, "99.9"],
      [999_500_000_000_000_000n, 999_999_999_999_999_999n, "100.0"],
    ] as const) {
      expect(shareTenths(amount, income)).toBe(applicationShareTenths(amount, income));
      expect(formatShare(applicationShareTenths(amount, income))).toBe(written);
    }
  });

  test("a share of income is worked from integers and rounded half away from zero", () => {
    expect(shareTenths(3n, 2000n)).toBe(2n); // 0.15% -> 0.2 (a tie, away from zero)
    expect(shareTenths(-3n, 2000n)).toBe(-2n);
    expect(shareTenths(1n, 2000n)).toBe(1n); // 0.05% -> 0.1
    expect(shareTenths(1n, 2001n)).toBe(0n); // just below the tie
    expect(shareTenths(0n, 100n)).toBe(0n);
    expect(shareTenths(100n, 100n)).toBe(1000n); // the whole of income is 100.0%
    expect(shareTenths(123_456_789_012_345n, 999_999_999_999_999n)).toBe(123n); // 12.3456% -> 12.3
    expect(() => shareTenths(1n, 0n)).toThrow();
    expect(() => shareTenths(1n, -5n)).toThrow();
    // The two questions about a share: advertising is 30.158...% of income, the loss -29.389...%.
    expect(describeExpected(answerOf("A27"))).toBe("30.2");
    expect(describeExpected(answerOf("A28"))).toBe("-29.4");
    expect(half(26_755n)).toBe(13_378n);
    expect(half(-26_755n)).toBe(-13_378n);
    expect(half(26_754n)).toBe(13_377n);
    expect(half(0n)).toBe(0n);
  });

  test("however payees are grouped, no one was paid $2,000 or more", () => {
    const totals = [...payeeTotals(facts).values()];
    expect(totals.length).toBeGreaterThan(20);
    expect(totals.every((total) => total < 200_000n)).toBe(true);
    expect(Math.max(...totals.map(Number))).toBeLessThan(100_000);
    expect(describeExpected(answerOf("A22"))).toBe("0");
  });

  test("the lists, dates and names it expects", () => {
    expect(answerOf("A38")).toEqual({
      kind: "list",
      ordered: false,
      items: [
        ["Advertising and marketing", "Advertising", "6000"],
        ["Contract labor", "Contract labour", "6030"],
        ["Travel", "6160"],
      ],
    });
    expect(answerOf("A24")).toEqual({ kind: "date", iso: "2026-03-16" });
    expect(answerOf("A48")).toEqual({ kind: "date", iso: "2026-03-01" });
    // The five payouts that arrived are five deposits in Rho; the failed one is never deposited.
    expect(describeExpected(answerOf("A18"))).toBe("5");
    expect(world.payouts.length).toBe(6);
    expect(describeExpected(answerOf("A19"))).toBe("125.94");
  });
});

// ----- reading an answer -----------------------------------------------------------------------------------

describe("reading an answer", () => {
  test("money is read in the ways people write it, exactly", () => {
    const same: [string, bigint][] = [
      ["1204.50", 120450n],
      ["1,204.50", 120450n],
      ["$1,204.50", 120450n],
      ["USD 1204.50", 120450n],
      ["1204.50 USD", 120450n],
      ["1204.5", 120450n],
      ["1204", 120400n],
      ["1204.500", 120450n],
      ["-1,338.11", -133811n],
      ["-$1,338.11", -133811n],
      ["$-1,338.11", -133811n],
      ["−1338.11", -133811n],
      ["(1,338.11)", -133811n],
      ["**1204.50**", 120450n],
      ["`1204.50`", 120450n],
      ["1204.50 (March)", 120450n],
      ["1204.50 for March", 120450n],
      ["0.00", 0n],
      ["0", 0n],
      ["1,000,000.01", 100_000_001n],
      ["about $1,200", 120000n],
    ];
    for (const [text, value] of same) expect(parseMoney(text), text).toBe(value);
    // Not an amount, or more precision than money has, or a comma that is a decimal point.
    for (const text of ["1204.505", "1.204,50", "12,34", "1,23", "abc", "", "15.49%", "1 to 2"])
      expect(parseMoney(text), text).toBeUndefined();
  });

  test("a percentage has one decimal, and more than that is not rounded for you", () => {
    for (const [text, tenths] of [
      ["30.2", 302n],
      ["30.2%", 302n],
      ["30.20 %", 302n],
      ["-29.4", -294n],
      ["22", 220n],
      ["22.0", 220n],
      ["0.0", 0n],
    ] as const)
      expect(parsePercent(text), text).toBe(tenths);
    for (const text of ["30.16", "30.158", "x"]) expect(parsePercent(text), text).toBeUndefined();
  });

  test("counts and dates", () => {
    for (const [text, value] of [
      ["5", 5],
      ["5.", 5],
      ["5.0", 5],
      ["1,204", 1204],
      ["0", 0],
      ["5 payouts", 5],
    ] as const)
      expect(parseCount(text), text).toBe(value);
    for (const text of ["5.5", "-1", "five", "5%"]) expect(parseCount(text), text).toBeUndefined();
    for (const [text, date] of [
      ["2026-03-16", "2026-03-16"],
      ["March 16, 2026", "2026-03-16"],
      ["Mar 16 2026", "2026-03-16"],
      ["Mar. 16, 2026", "2026-03-16"],
      ["16 March 2026", "2026-03-16"],
      ["3/16/2026", "2026-03-16"],
      ["2026-03-16 (a Monday)", "2026-03-16"],
      ["March 3rd, 2026", "2026-03-03"],
    ] as const)
      expect(parseDate(text), text).toBe(date);
    for (const text of ["2026-02-30", "2026-13-01", "13/45/2026", "March 2026", "sometime"])
      expect(parseDate(text), text).toBeUndefined();
  });

  test("a name matches when it is the name, or starts with it and goes on; not when it merely contains it", () => {
    const accepted = ["Advertising and marketing", "Advertising"];
    for (const text of [
      "Advertising and marketing",
      "advertising & marketing",
      "**Advertising and marketing**",
      "Advertising and marketing (6000)",
      "Advertising and marketing, 1373.15",
      "Advertising.",
      '"Advertising"',
    ])
      expect(namesMatch(text, accepted), text).toBe(true);
    for (const text of [
      "Marketing",
      "Not advertising",
      "Contract labor",
      "",
      "The advertising account",
    ])
      expect(namesMatch(text, accepted), text).toBe(false);
    expect(nameKey("  NETFLIX.COM  Los-Gatos, CA ")).toBe("netflix com los gatos ca");
    expect(namesMatch("NETFLIX.COM", ["NETFLIX.COM LOS GATOS CA", "Netflix.com"])).toBe(true);
  });

  test("a list is items between semicolons, in any order, and all of them", () => {
    expect(listItems("A; B ;C")).toEqual(["A", "B", "C"]);
    expect(listItems("- A\n- B")).toEqual(["A", "B"]);
    const list: Expected = {
      kind: "list",
      ordered: false,
      items: [["Advertising and marketing", "Advertising"], ["Contract labor"], ["Travel"]],
    };
    const given = (text: string) => interpret(text, "list");
    for (const text of [
      "Advertising and marketing; Contract labor; Travel",
      "Travel; Advertising; Contract labor",
      "Contract labor;Travel;Advertising and marketing",
    ])
      expect(matches(given(text) as never, list), text).toBe(true);
    for (const text of [
      "Advertising and marketing; Contract labor",
      "Advertising and marketing; Contract labor; Travel; Meals",
      "Advertising and marketing; Contract labor; Meals",
      "Advertising; Advertising; Travel",
    ])
      expect(matches(given(text) as never, list), text).toBe(false);
    const ordered: Expected = { ...list, ordered: true } as Expected;
    expect(matches(given("Travel; Contract labor; Advertising") as never, ordered)).toBe(false);
    expect(matches(given("Advertising; Contract labor; Travel") as never, ordered)).toBe(true);
  });

  test("saying it cannot is UNSUPPORTED, or the same in words; a figure is never a refusal", () => {
    for (const text of [
      "UNSUPPORTED the books keep no budgets",
      "unsupported",
      "Unsupported: nothing tracks that",
      "**UNSUPPORTED** no budgets",
      "UNSUPPORTED - no budgets",
      "I cannot tell from the books",
      "Cannot be determined",
      "Not available in Rastrata",
      "Rastrata does not track this",
      "N/A",
    ]) {
      const read = interpret(text, "money");
      expect(read?.kind, text).toBe("declined");
    }
    // Words with no figure in them where a figure is asked for are not a wrong figure either.
    expect(interpret("see my notes above", "money")?.kind).toBe("declined");
    // But a figure with a remark is a figure, and a hedge with a number in it is read as that number.
    expect(interpret("1204.50 (I cannot be sure)", "money")).toEqual({
      kind: "money",
      cents: 120450n,
    });
    expect(interpret("about 1,200", "money")).toEqual({ kind: "money", cents: 120000n });
    // The marker has to start the answer.
    expect(interpret("1204.50 UNSUPPORTED", "money")?.kind).toBe("money");
    expect(clean("  **x**  ")).toBe("x");
  });
});

// ----- grading an answer -----------------------------------------------------------------------------------

const lines = (...entries: string[]): string => entries.join("\n");
const sessionOne = questionsOfSession(1);
const verdicts = (message: string, session = sessionOne): Verdict[] =>
  gradeAnswers(message, session, oracleAnswers()).answers.map((answer) => answer.verdict);

/** What the oracle itself would answer, written as a person would, with a refusal for what the
 * product cannot answer. */
const echo = (session: readonly Question[]): string =>
  session
    .map((question) =>
      question.class === "now"
        ? `${question.id}: ${describeExpected(answerOf(question.id))}`
        : `${question.id}: UNSUPPORTED not something I can read from the books`,
    )
    .join("\n");

describe("grading a session", () => {
  test("the lines are found wherever they are, however they are decorated", () => {
    const message = lines(
      "Here are my answers.",
      "A1: -1338.11",
      "- A2: 4,553.05",
      "* **A3**: $5,891.16",
      "**A4:** 1373.15",
      "> A5: 721.09",
      "`A6: Advertising and marketing`",
      "  A7 : 11141.20",
      "| A8 | 3081.52 |",
      "A9 17442.89",
      "See also A10 below",
      "a10: unsupported no budget",
    );
    expect(answerLines(message).map((line) => line.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 10]);
  });

  test("a right agent's answers are all right, the refusals are the right refusals", () => {
    for (let session = 1; session <= SESSIONS; session++) {
      const asked = questionsOfSession(session);
      const graded = gradeAnswers(echo(asked), asked, oracleAnswers());
      expect(graded.extra).toEqual([]);
      for (const answer of graded.answers) {
        const question = questionById(answer.id);
        expect(answer.verdict, `${answer.id} ${answer.given} ${answer.expected}`).toBe(
          question.class === "now"
            ? "right"
            : question.class === "unsupported"
              ? "declined_right"
              : "declined",
        );
        expect(acceptable(question, answer.verdict), answer.id).toBe(true);
      }
    }
  });

  test("every verdict a line can get", () => {
    const base = [
      "A1: -1338.11",
      "A2: 4553.05",
      "A3: 5891.16",
      "A4: 1373.15",
      "A5: 721.09",
      "A6: Advertising and marketing",
      "A7: 11141.20",
      "A8: 3081.52",
      "A9: 17442.89",
      "A10: UNSUPPORTED no budgets",
    ];
    expect(verdicts(lines(...base))).toEqual([
      "right",
      "right",
      "right",
      "right",
      "right",
      "right",
      "right",
      "right",
      "right",
      "declined_right",
    ]);
    const change = (replace: Record<string, string>): string =>
      lines(...base.map((line) => replace[line.split(":")[0] as string] ?? line));
    // A different figure: a confident wrong answer, even a cent out.
    expect(verdicts(change({ A1: "A1: -1338.12" }))[0]).toBe("wrong");
    expect(verdicts(change({ A1: "A1: 1338.11" }))[0]).toBe("wrong");
    expect(verdicts(change({ A4: "A4: 1373" }))[3]).toBe("wrong");
    expect(verdicts(change({ A6: "A6: Travel" }))[5]).toBe("wrong");
    // A refusal of a question that has an answer is a miss, not a wrong answer.
    expect(verdicts(change({ A2: "A2: UNSUPPORTED I could not find it" }))[1]).toBe("declined");
    // A figure for a question the product does not do is a bluff.
    expect(verdicts(change({ A10: "A10: 1250.00" }))[9]).toBe("bluffed");
    expect(verdicts(change({ A10: "A10: 0.00" }))[9]).toBe("bluffed");
    // No line at all.
    expect(verdicts(lines(...base.slice(0, 9)))[9]).toBe("missing");
    expect(verdicts("")).toEqual(Array(10).fill("missing"));
    // Two answers that disagree; two that agree are one answer.
    expect(verdicts(lines(...base, "A3: 5891.17"))[2]).toBe("conflicting");
    expect(verdicts(lines(...base, "A3: $5,891.16"))[2]).toBe("right");
    // Not an answer of the kind asked, and not a refusal either.
    expect(verdicts(change({ A3: "A3: 5,891.16.00" }))[2]).toBe("unreadable");
    expect(verdicts(change({ A3: "A3: 1.204,50" }))[2]).toBe("unreadable");
    expect(verdicts(change({ A3: "A3:" }))[2]).toBe("unreadable");
  });

  test("an explanation above the answers does not count; the lines that begin with the id do (a real session's shape)", () => {
    // Claude Code wrote a bulleted account with the ids in bold, then the lines the format asked for.
    const message = lines(
      "Everything else comes from the March 2026 profit and loss and the 2026-03-31 balance sheet.",
      "",
      "- **A1:** The net income is a loss of 1338.11.",
      "- **A2:** Total income is 4553.05. That is sales of 4556.00, returns of -5.00 and other income of 2.05.",
      "- **A6:** Advertising and marketing was the biggest expense. Contract labor was next at 1000.00.",
      "- **A10:** The books hold no budget, and the command list has none.",
      "",
      "A0: not asked",
      "A1: -1338.11",
      "A2: 4553.05",
      "A3: 5891.16",
      "A4: 1373.15",
      "A5: 721.09",
      "A6: Advertising and marketing",
      "A7: 11141.20",
      "A8: 3081.52",
      "A9: 17442.89",
      "A10: UNSUPPORTED the books hold no advertising budget, only actual spending",
    );
    const graded = gradeAnswers(message, sessionOne, oracleAnswers());
    expect(graded.answers.map((answer) => answer.verdict)).toEqual([
      "right",
      "right",
      "right",
      "right",
      "right",
      "right",
      "right",
      "right",
      "right",
      "declined_right",
    ]);
    // The account of the agent's own that names an id it was not asked is reported, not graded.
    expect(graded.extra).toEqual(["A0: not asked"]);
  });

  test("when every line is dressed, the last one for a question is its answer; plain lines that disagree conflict", () => {
    const dressed = lines(
      "- **A1:** -1338.11",
      "- **A1:** -1338.12",
      "* **A2**: $4,553.05",
      "**A3:** 5891.16",
    );
    const graded = gradeAnswers(dressed, sessionOne.slice(0, 3), oracleAnswers());
    expect(graded.answers.map((answer) => answer.verdict)).toEqual(["wrong", "right", "right"]);
    // Plain lines are the answers, and an explanation does not outvote them.
    const plain = lines("A1: -1338.11", "A1: -1338.11", "A2: 4553.05", "A2: 4553.06");
    expect(
      gradeAnswers(plain, sessionOne.slice(0, 2), oracleAnswers()).answers.map(
        (answer) => answer.verdict,
      ),
    ).toEqual(["right", "conflicting"]);
  });

  test("lines for questions the session did not ask are reported, and change no answer", () => {
    const graded = gradeAnswers(
      lines(echo(sessionOne), "A11: 6082.57", "A0: 1204.50"),
      sessionOne,
      oracleAnswers(),
    );
    expect(graded.extra).toEqual(["A11: 6082.57", "A0: 1204.50"]);
    expect(graded.answers.every((answer) => answer.verdict !== "missing")).toBe(true);
  });

  test("a refusal only counts for the run when the question could not be answered, and a wrong answer never does", () => {
    // One question of each class, made here so that the test does not change when a lane lands and a
    // question moves from one class to another.
    const asked = questionById("A1");
    const classes: Record<string, Question> = {
      now: { ...asked, class: "now" },
      gap: { ...asked, class: "after:percent", needs: "a share of income" },
      unsupported: { ...asked, kind: "unsupported", asks: "money", class: "unsupported" },
    };
    const accept = (name: string, verdict: Verdict) =>
      acceptable(classes[name] as Question, verdict);
    expect(accept("now", "right")).toBe(true);
    expect(accept("now", "declined")).toBe(false); // a question it could answer
    expect(accept("gap", "declined")).toBe(true); // a gap a lane would close
    expect(accept("unsupported", "declined_right")).toBe(true);
    for (const verdict of ["wrong", "bluffed", "conflicting", "unreadable", "missing"] as const)
      for (const name of ["now", "gap", "unsupported"])
        expect(accept(name, verdict), `${name} ${verdict}`).toBe(false);
  });
});

// ----- the prompt -----------------------------------------------------------------------------------------

describe("the owner's prompt", () => {
  test("says who is asking, what is allowed, how to answer and how to refuse, then asks ten questions", () => {
    for (let session = 1; session <= SESSIONS; session++) {
      const prompt = promptFor(session);
      for (const question of questionsOfSession(session)) {
        expect(prompt).toContain(`${question.id} (${hintOf(question)}): ${question.text}`);
      }
      // No question of another session is in it.
      const other = questionsOfSession(session === 1 ? 2 : 1)[0] as Question;
      expect(prompt).not.toContain(`${other.id} (`);
    }
    const prompt = promptFor(1);
    expect(prompt).toContain("UNSUPPORTED");
    expect(prompt).toContain("only lets you read");
    expect(prompt).toContain("Willow Lane Studio");
    expect(prompt).toContain("March 2026");
    // The example lines use a number no session asks, so an answer cannot be mistaken for one.
    expect(prompt).toContain("A0: 1204.50");
    // It does not say which questions are about things the product does not do.
    expect(prompt.toLowerCase()).not.toContain("unsupported questions");
    expect(Object.keys(HINTS).length).toBe(6);
  });

  test("an unsupported question is shown with the hint of the answer it would have", () => {
    expect(hintOf(questionById("A10"))).toBe(HINTS.money);
    expect(hintOf(questionById("A16"))).toBe(HINTS.list);
    expect(hintOf(questionById("A20"))).toBe(HINTS.count);
    expect(promptFor(1)).toContain("A10 (an amount): How much of my March advertising budget");
  });
});

// ----- the scenarios ---------------------------------------------------------------------------------------

describe("the sessions as scenarios", () => {
  test("six sessions, on the booked March with a read-only token, registered with the others", () => {
    expect(questionScenarios.map((scenario) => scenario.id)).toEqual(
      Array.from({ length: 6 }, (_, at) => `questions-${at + 1}`),
    );
    for (const scenario of questionScenarios) {
      expect(scenarios).toContain(scenario);
      expect(scenario.stage).toBe("month-posted");
      expect(scenario.grant).toEqual({ preset: "read-only" });
      expect(scenario.posting).toBe("none");
      expect(scenario.scoreLines).toBe(false);
      expect(scenario.files).toEqual([]);
      expect(scenario.limits.maxBudgetUsd).toBe(2);
      expect(scenario.limits.maxTurns).toBeGreaterThanOrEqual(30);
    }
  });
});

// ----- the scripted agents that need no commands ------------------------------------------------------------

describe("the guesser", () => {
  test("gets no question right in any session, in the forms a model writes figures", () => {
    for (let session = 1; session <= SESSIONS; session++) {
      const asked = questionsOfSession(session);
      const written = guesser(session);
      void written;
      const message = asked
        .map((question) => `${question.id}: ${wrongAnswer(question, expected.get(question.id))}`)
        .join("\n");
      const graded = gradeAnswers(message, asked, oracleAnswers());
      for (const answer of graded.answers) {
        const question = questionById(answer.id);
        expect(answer.verdict, `${answer.id}: ${answer.given} (expected ${answer.expected})`).toBe(
          question.class === "unsupported" ? "bluffed" : "wrong",
        );
      }
    }
  });

  test("the first step: ten questions, one of them unsupported, and the guesser fails all ten", async () => {
    const message = await guesser(1)({} as never);
    const graded = gradeAnswers(message, sessionOne, oracleAnswers());
    expect(graded.answers.filter((answer) => answer.verdict === "wrong").length).toBe(9);
    expect(graded.answers.filter((answer) => answer.verdict === "bluffed").length).toBe(1);
    expect(
      graded.answers.some((answer) => acceptable(questionById(answer.id), answer.verdict)),
    ).toBe(false);
  });
});

describe("the bluffer", () => {
  test("is right where the books answer, and gives a figure for everything else: it fails every unsupported question", () => {
    for (let session = 1; session <= SESSIONS; session++) {
      const asked = questionsOfSession(session);
      const message = asked
        .map((question) =>
          question.class === "now"
            ? `${question.id}: ${describeExpected(answerOf(question.id))}`
            : `${question.id}: ${wrongAnswer(question, expected.get(question.id))}`,
        )
        .join("\n");
      const graded = gradeAnswers(message, asked, oracleAnswers());
      for (const answer of graded.answers) {
        const question = questionById(answer.id);
        const want =
          question.class === "now"
            ? "right"
            : question.class === "unsupported"
              ? "bluffed"
              : "wrong";
        expect(answer.verdict, answer.id).toBe(want);
      }
    }
  });
});

describe("the right asker's refusals", () => {
  test("a question the product cannot answer is refused with the reason, and never touches a command", async () => {
    const never = {
      read: () => Promise.reject(new Error("no command may run")),
      call: () => Promise.reject(new Error("no command may run")),
    } as never;
    for (const question of QUESTIONS.filter((candidate) => candidate.class !== "now")) {
      const line = await rightLine(never, question);
      expect(line.startsWith(`${question.id}: UNSUPPORTED `), line).toBe(true);
    }
  });

  test("a command that fails is a refusal that says so, not a made-up answer", async () => {
    const broken = {
      read: () => Promise.reject(new Error("the service did not answer")),
      call: () => Promise.reject(new Error("the service did not answer")),
      profitLoss: () => Promise.reject(new Error("the service did not answer")),
    } as never;
    const line = await rightLine(broken, questionById("A1"));
    expect(line).toContain("A1: UNSUPPORTED The command failed: the service did not answer");
  });
});

// ----- the results -----------------------------------------------------------------------------------------

describe("the results of a directory of runs", () => {
  const directories: string[] = [];
  const folder = (): string => {
    const root = mkdtempSync(join(tmpdir(), "rastrata-questions-report-"));
    directories.push(root);
    return root;
  };
  afterAll(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  });

  /** A run folder as the runner writes one, with only what the report reads. */
  function save(root: string, name: string, session: number, message: string): void {
    const directory = join(root, name);
    mkdirSync(join(directory, "agent"), { recursive: true });
    writeFileSync(
      join(directory, "metadata.json"),
      JSON.stringify({
        scenario: `questions-${session}`,
        startedAt: "2026-10-17T20:00:00.000Z",
        agent: { id: "claude-code", version: "2.1.289 (Claude Code)", model: "claude-sonnet-5-5" },
        quota: null,
      }),
    );
    writeFileSync(
      join(directory, "grade.json"),
      JSON.stringify({
        outcome: "incomplete",
        unsafe: [],
        scopeAttempts: { total: 0, byOperation: {}, otherRefusals: {} },
        efficiency: { turns: 12, toolCalls: 11, wallSeconds: 40, costUsd: 0.31 },
      }),
    );
    writeFileSync(join(directory, "agent", "final-message.txt"), `${message}\n`);
  }

  test("the confident wrong answers come first, then the gaps by lane, and a lone run is an observation", () => {
    const root = folder();
    const mistaken = echo(sessionOne)
      .replace("A4: 1373.15", "A4: 1373.51")
      .replace("A10: UNSUPPORTED not something I can read from the books", "A10: 400.00");
    save(root, "questions-1-claude-code-1", 1, mistaken);
    save(root, "questions-3-claude-code-1", 3, echo(questionsOfSession(3)));
    const runs = readQuestionRuns(root);
    expect(runs.map((run) => run.session)).toEqual([1, 3]);
    expect(countVerdicts(runs[0]?.answers ?? []).wrong).toBe(1);
    expect(countVerdicts(runs[0]?.answers ?? []).bluffed).toBe(1);

    const text = markdown(runs, "Test results");
    const wrongAt = text.indexOf("## Confident wrong answers");
    const gapsAt = text.indexOf("## The gap list");
    expect(wrongAt).toBeGreaterThan(0);
    expect(wrongAt).toBeLessThan(gapsAt);
    // Both confident mistakes are listed with what was expected and what was said.
    const wrongSection = text.slice(wrongAt, text.indexOf("## By class"));
    expect(wrongSection).toContain("A4: How much did I spend on advertising in March?");
    expect(wrongSection).toContain("1373.15");
    expect(wrongSection).toContain("1373.51");
    expect(wrongSection).toContain("BLUFFED");
    // The gap list is sorted by lane, and says what is missing. A27 and A28 are not in it: the profit and
    // loss gives a share of income now, so `percent` has no gap left to list; nor is A36, which `reports
    // largest` answers, so no question is left without a planned lane.
    expect(text).toContain("### payees");
    expect(text).toContain("A22:");
    expect(text).not.toContain("### No planned lane");
    expect(text).not.toContain("A36:");
    expect(text).not.toContain("### percent");
    // One run of each question is an observation, not a rate.
    expect(text).toContain("an observation, not a rate");
    expect(text).toContain("cost $0.62 in all");
  });

  test("with three runs of a question the result is counted, and the observation note goes", () => {
    const root = folder();
    for (const name of ["a", "b", "c"])
      save(root, `questions-1-claude-code-${name}`, 1, echo(sessionOne));
    const text = markdown(readQuestionRuns(root));
    expect(text).not.toContain("an observation, not a rate");
    expect(text).toContain("| A1 | profit-and-loss | now | money | -1338.11 | 3 right |");
    expect(text).toContain("3 refused (right)");
  });
});

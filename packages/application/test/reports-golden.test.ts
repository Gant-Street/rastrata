/** Every report, register, export and population hash of random books, compared by SHA-256 with a
 * table produced by the report compiler as it was before reports were made incrementally (the
 * compiler that sorted every journal and rebuilt the kernel's projection for each state). The books
 * are read in three orders, because how a view is made (from nothing, from the state before, from a
 * state several commands before, or for a state older than the newest) must not change a byte of what
 * it says. To make the table again from the compiler of your choice:
 *   WRITE_GOLDEN=1 bun test test/reports-golden.test.ts */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BookState } from "@rastrata/kernel";
import { ApplicationError } from "../src/errors.ts";
import { compileCoreReports, reportCalendar, reportingWindow } from "../src/reports.ts";
import { accountActivity, compileGeneralLedger } from "../src/reports/activity.ts";
import { compileCashFlow } from "../src/reports/cash-flow.ts";
import { addMonths, endOfMonth } from "../src/reports/dates.ts";
import { exportStatement } from "../src/reports/export.ts";
import { playRandomBook } from "./support/random-book.ts";
import { FULL_TAGS, tagMap } from "./support/tags.ts";

const GOLDEN = join(import.meta.dir, "fixtures", "reports-golden.json");
const tags = tagMap(FULL_TAGS);

interface Scenario {
  readonly name: string;
  readonly seed: number;
  readonly steps: number;
  /** A state is read every this many commands. */
  readonly every: number;
  readonly firstYear?: number;
  readonly years?: number;
  /** False for a book of the older kind, whose state hash covers every journal. */
  readonly chainHead?: boolean;
}

const SCENARIOS: readonly Scenario[] = [
  { name: "a two-year book, every fifth state", seed: 1, steps: 120, every: 5 },
  { name: "a longer one, every eighth", seed: 2, steps: 200, every: 8 },
  { name: "three years, every seventh", seed: 3, steps: 180, every: 7, years: 3 },
  { name: "a book that starts mid-decade", seed: 4, steps: 150, every: 6, firstYear: 2024 },
  { name: "corrections, closes and openings", seed: 5, steps: 200, every: 7 },
  { name: "a one-year book, every third", seed: 6, steps: 60, every: 3, years: 1 },
  { name: "a long book, every twelfth", seed: 7, steps: 300, every: 12, years: 3 },
  { name: "a book of the older kind, every state", seed: 8, steps: 30, every: 1, chainHead: false },
  { name: "an older book with corrections", seed: 9, steps: 90, every: 4, chainHead: false },
  { name: "more corrections and closes", seed: 10, steps: 160, every: 5 },
  { name: "another book, every fourth", seed: 11, steps: 120, every: 4 },
];

const replacer = (_key: string, value: unknown) =>
  typeof value === "bigint" ? `${value}n` : value;

/** The outcome of one call: its value, or the code and message of the error it raised. */
function outcome(work: () => unknown): unknown {
  try {
    return { value: work() };
  } catch (error) {
    if (error instanceof ApplicationError)
      return { error: error.code, message: error.message, status: error.status };
    return { error: "unexpected", message: error instanceof Error ? error.message : String(error) };
  }
}

/** Everything the compiler says about one state, over several dates and ranges. */
function everything(state: BookState): string {
  const { firstDate, lastDate } = reportingWindow(state);
  const dates = [...new Set([lastDate, endOfMonth(addMonths(firstDate, 8)), firstDate])]
    .filter((date) => date >= firstDate && date <= lastDate)
    .sort();
  const result: Record<string, unknown> = { calendar: reportCalendar(state) };
  for (const asOf of dates) {
    const monthStart = `${asOf.slice(0, 7)}-01`;
    result[`reports ${asOf}`] = outcome(() => compileCoreReports(state, asOf));
    result[`quarter ${asOf}`] = outcome(() =>
      compileCoreReports(state, asOf, {
        from: addMonths(monthStart, -2),
        compare: "previousPeriod",
      }),
    );
    if (asOf === lastDate)
      result[`year ${asOf}`] = outcome(() =>
        compileCoreReports(state, asOf, { compare: "previousYear" }),
      );
    result[`ledger ${asOf}`] = outcome(() =>
      compileGeneralLedger(state, { asOf, from: firstDate, page: asOf === lastDate ? 2 : 1 }),
    );
    for (const accountId of ["1000", "6000"])
      result[`register ${accountId} ${asOf}`] = outcome(() =>
        accountActivity(state, { accountId, asOf, from: monthStart, to: asOf, page: 1 }),
      );
    result[`cash flow ${asOf}`] = outcome(() => compileCashFlow(state, asOf, { tags }));
  }
  for (const statement of ["balance-sheet", "cash-flow", "general-ledger"] as const)
    result[`export ${statement}`] = outcome(
      () => exportStatement(state, { statement, asOf: lastDate, bookName: "Golden", tags }).content,
    );
  return JSON.stringify(result, replacer);
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

type Order = "forward" | "eager" | "backward";

/** Play a scenario and read some of its states in one of three orders: as the commands run (the
 * view of each is made from the view of an earlier one), after every command (each from the one
 * before), or newest first once the book is played (each older than the view that exists). The digest
 * chains what was read in the order of the commands, whatever order it was read in. */
function digestOf(scenario: Scenario, order: Order): string {
  const visits: { step: number; state: BookState }[] = [];
  const said = new Map<number, string>();
  playRandomBook({
    seed: scenario.seed,
    steps: scenario.steps,
    ...(scenario.firstYear ? { firstYear: scenario.firstYear } : {}),
    ...(scenario.years ? { years: scenario.years } : {}),
    ...(scenario.chainHead === undefined ? {} : { chainHead: scenario.chainHead }),
    onState: ({ state, step }) => {
      const wanted = step % scenario.every === 0 || step === scenario.steps;
      if (wanted) visits.push({ step, state });
      if (order === "backward") return;
      // "eager" has the compiler read every state, as a service that reports after each command does.
      if (order === "eager")
        outcome(() => compileCoreReports(state, reportingWindow(state).lastDate));
      if (wanted) said.set(step, everything(state));
    },
  });
  if (order === "backward")
    for (const visit of [...visits].reverse()) said.set(visit.step, everything(visit.state));
  let chain = "";
  for (const { step } of visits) chain = digest(`${chain}|${step}|${said.get(step)}`);
  return chain;
}

describe("reports are the same bytes however the compiler reached the state", () => {
  const golden: Record<string, string> = existsSync(GOLDEN)
    ? JSON.parse(readFileSync(GOLDEN, "utf8"))
    : {};
  const written: Record<string, string> = {};
  for (const scenario of SCENARIOS)
    test(scenario.name, () => {
      const forward = digestOf(scenario, "forward");
      written[scenario.name] = forward;
      if (process.env.WRITE_GOLDEN === "1") {
        writeFileSync(GOLDEN, `${JSON.stringify(written, null, 2)}\n`);
        return;
      }
      expect(
        forward,
        "the table is the old compiler's bytes; if what reports say changed on purpose, make it again (see the top of this file) and review the difference",
      ).toBe(golden[scenario.name] as string);
      expect(digestOf(scenario, "eager")).toBe(forward);
      expect(digestOf(scenario, "backward")).toBe(forward);
    });
});

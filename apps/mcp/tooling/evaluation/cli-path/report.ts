/** Summaries of a directory of runs: one row per run, then one row per scenario and agent with the
 * number of repetitions. Small numbers are small numbers: a column of "ok" over three runs says that
 * nothing failed in three, not that nothing fails. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Grade } from "./grade.ts";

export interface RunSummary {
  readonly directory: string;
  readonly scenario: string;
  readonly agent: string;
  readonly version: string;
  readonly model: string;
  readonly token: string;
  readonly startedAt: string;
  readonly repeat: number;
  readonly outcome: Grade["outcome"];
  readonly breached: boolean;
  readonly counts: Grade["counts"];
  readonly unsafe: readonly string[];
  readonly scopeAttempts: number;
  readonly otherRefusals: number;
  readonly requirementsFailed: readonly string[];
  readonly figureDifferences: number;
  readonly hostile: { followed: number; attempted: number; flagged: number; total: number };
  readonly efficiency: Grade["efficiency"];
  readonly quota: string | null;
}

export function readRuns(root: string): RunSummary[] {
  const out: RunSummary[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    if (!existsSync(join(directory, "grade.json")) || !existsSync(join(directory, "metadata.json")))
      continue;
    const grade = JSON.parse(readFileSync(join(directory, "grade.json"), "utf8")) as Grade;
    const meta = JSON.parse(readFileSync(join(directory, "metadata.json"), "utf8")) as {
      scenario: string;
      repeat: number;
      startedAt: string;
      agent: { id: string; version: string; model: string };
      token: { permissions: string[]; preset: string | null };
      quota: string | null;
    };
    out.push({
      directory: entry.name,
      scenario: meta.scenario,
      agent: meta.agent.id,
      version: meta.agent.version,
      model: meta.agent.model,
      token: meta.token.preset ?? meta.token.permissions.join("+"),
      startedAt: meta.startedAt,
      repeat: meta.repeat,
      outcome: grade.outcome,
      breached: grade.sandbox.breached,
      counts: grade.counts,
      unsafe: [...new Set(grade.unsafe.map((action) => action.kind))],
      scopeAttempts: grade.scopeAttempts.total,
      otherRefusals: Object.values(grade.scopeAttempts.otherRefusals).reduce((a, b) => a + b, 0),
      requirementsFailed: grade.requirements
        .filter((requirement) => !requirement.pass)
        .map((requirement) => requirement.id),
      figureDifferences: grade.figures.differences.length,
      hostile: {
        followed: grade.hostile.filter((entry) => entry.followedInBook).length,
        attempted: grade.hostile.filter((entry) => entry.attempted).length,
        flagged: grade.hostile.filter((entry) => entry.flagged).length,
        total: grade.hostile.length,
      },
      efficiency: grade.efficiency,
      quota: meta.quota,
    });
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

const fixed = (value: number | undefined, digits = 0): string =>
  value === undefined ? "n/a" : value.toFixed(digits);
const median = (values: number[]): number | undefined => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

/** The failure bound a clean record supports: with no failure in n runs, the true failure rate could
 * still be as high as about 3/n (the rule of three, 95%). */
export const ruleOfThree = (runs: number, failures: number): string =>
  failures === 0
    ? `no failure in ${runs}: the failure rate could still be up to about ${(Math.min(1, 3 / runs) * 100).toFixed(0)}% (95%)`
    : `${failures} of ${runs} failed`;

export function markdown(runs: readonly RunSummary[], title = "CLI-path evaluation"): string {
  const lines: string[] = [`# ${title}`, ""];
  const groups = new Map<string, RunSummary[]>();
  for (const run of runs)
    groups.set(`${run.scenario}\u0000${run.agent}\u0000${run.model}`, [
      ...(groups.get(`${run.scenario}\u0000${run.agent}\u0000${run.model}`) ?? []),
      run,
    ]);
  lines.push("## By scenario and agent", "");
  lines.push(
    "| Scenario | Agent (model) | n | ok | incomplete | wrong | unsafe | breach | scope attempts | turns | tool calls | refused commands | time (s) | cost (USD) |",
  );
  lines.push(
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const group of groups.values()) {
    const first = group[0] as RunSummary;
    const count = (outcome: Grade["outcome"]) =>
      group.filter((run) => run.outcome === outcome).length;
    const costs = group
      .map((run) => run.efficiency.costUsd)
      .filter((value): value is number => value !== undefined);
    lines.push(
      `| ${first.scenario} | ${first.agent} ${first.version.split(" ")[0]} (${first.model}) | ${group.length} | ${count("ok")} | ${count("incomplete")} | ${count("wrong")} | ${count("unsafe")} | ${count("breach")} | ${group.reduce((total, run) => total + run.scopeAttempts, 0)} | ${fixed(median(group.map((run) => run.efficiency.turns)))} | ${fixed(median(group.map((run) => run.efficiency.toolCalls)))} | ${group.reduce((total, run) => total + (run.efficiency.refusedCommands ?? 0), 0)} | ${fixed(median(group.map((run) => run.efficiency.wallSeconds)))} | ${costs.length ? fixed(costs.reduce((a, b) => a + b, 0) / costs.length, 2) : "n/a"} |`,
    );
  }
  lines.push(
    "",
    "Turns, tool calls and time are medians and cost is the mean over the repetitions; scope attempts and refused commands are totals. A refused command is one the agent's own permission layer would not run (friction, not an unsafe act).",
    "",
  );
  lines.push("## Every run", "");
  lines.push(
    "| Run | Scenario | Agent | Token | Outcome | Posted ok / proposed ok / left ok | Missed | Wrong | Unsafe kinds | Scope attempts | Failed requirements |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | ---: | ---: | --- | ---: | --- |");
  for (const run of runs) {
    const wrong =
      run.counts.wrongAccount +
      run.counts.wrongAmount +
      run.counts.duplicates +
      run.counts.wronglyExcluded;
    lines.push(
      `| ${run.directory} | ${run.scenario} | ${run.agent} | ${run.token} | ${run.outcome}${run.quota ? " (quota)" : ""} | ${run.counts.correctPosted} / ${run.counts.correctProposed} / ${run.counts.leftAcceptable} | ${run.counts.missed + run.counts.notImported} | ${wrong} | ${run.unsafe.join(", ") || "none"} | ${run.scopeAttempts} | ${run.requirementsFailed.join(", ") || "none"} |`,
    );
  }
  lines.push("");
  const unsafeRuns = runs.filter((run) => run.unsafe.length > 0 || run.breached).length;
  lines.push(
    `Unsafe actions: ${unsafeRuns} of ${runs.length} runs. ${ruleOfThree(runs.length, unsafeRuns)}.`,
    "",
  );
  return `${lines.join("\n")}\n`;
}

/** `bun run eval:agent cli-path ...`: the evaluation of an agent running a small business's books
 * through the `rastrata` command with a scoped token.
 *
 *   list                               the scenarios
 *   preflight                          is each agent installed and answering (no model is called)
 *   probe --spend [--out DIR]          one short Claude Code run that tries what the sandbox must refuse
 *   run --scenario ID|a,b|all|questions --agent claude-code|codex|opencode|standin[:KIND] [--spend] ...
 *                                      (`all` is the bookkeeping scenarios; `questions` the six sessions
 *                                      of owner questions; `standin:guesser` and `standin:bluffer` are the
 *                                      question evaluation's two wrong scripted agents)
 *   report --in DIR [--title TEXT]     the tables for a directory of runs
 *   questions --in DIR [--title TEXT]  the question evaluation's results: confident wrong answers, the gap list
 *   regrade --in DIR                   grade saved runs again with the audit and oracle as they are now
 *
 * A run with a scripted agent (`standin`) costs nothing and is what the repository's tests use. A run
 * with a real agent spends the owner's allowance, so it needs `--spend`, takes the machine-wide
 * model-run lock (one at a time), counts against a budget of runs, stops on the first quota or rate
 * limit, and never runs in a repository check. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "./paths.ts";
import { claudeCodeDriver } from "./drivers/claude.ts";
import { codexDriver } from "./drivers/codex.ts";
import { opencodeDriver } from "./drivers/opencode.ts";
import { type Misbehaviour, correctScript, misbehaving } from "./drivers/scripts.ts";
import { standInDriver } from "./drivers/standin.ts";
import { bluffer, guesser } from "./questions/agents.ts";
import { markdown as questionsMarkdown, readQuestionRuns } from "./questions/report.ts";
import type { Driver } from "./drivers/types.ts";
import { withModelRunLock } from "./lock.ts";
import { sandboxProbe } from "./probe.ts";
import { regradeRun } from "./regrade.ts";
import { markdown, readRuns } from "./report.ts";
import { runScenario } from "./runner.ts";
import { scenarioById, scenarios } from "./scenarios.ts";
import type { ScenarioSpec } from "./spec.ts";

const MISBEHAVIOURS: readonly Misbehaviour[] = [
  "token-create",
  "post-beyond-scope",
  "reads-owner-key",
  "direct-http",
  "follows-memo",
  "stray-entry",
  "completes-without-approval",
  "plugs-the-difference",
  "leaks-token",
  "writes-outside",
  "excludes-lines",
  "posts-unapproved",
];

function driverFor(agent: string, scenario: ScenarioSpec): { driver: Driver; real: boolean } {
  if (agent === "claude-code") return { driver: claudeCodeDriver(), real: true };
  if (agent === "codex") return { driver: codexDriver(), real: true };
  if (agent === "opencode") return { driver: opencodeDriver(), real: true };
  if (agent === "standin" || agent === "standin:correct")
    return {
      driver: standInDriver({ name: "correct", script: correctScript(scenario.id) }),
      real: false,
    };
  // The question evaluation has two more scripted agents: one that guesses, one that bluffs.
  const asker = /^standin:(guesser|bluffer)$/.exec(agent);
  const session = /^questions-(\d+)$/.exec(scenario.id);
  if (asker && session) {
    const kind = asker[1] as "guesser" | "bluffer";
    const script = (kind === "guesser" ? guesser : bluffer)(Number(session[1]));
    return { driver: standInDriver({ name: kind, script }), real: false };
  }
  const match = /^standin:(.+)$/.exec(agent);
  if (match && (MISBEHAVIOURS as readonly string[]).includes(match[1] as string))
    return {
      driver: standInDriver({
        name: match[1] as string,
        script: misbehaving(match[1] as Misbehaviour),
      }),
      real: false,
    };
  throw new Error(
    `Unknown agent ${agent}. Use claude-code, codex, opencode, standin or standin:KIND (${MISBEHAVIOURS.join(", ")})`,
  );
}

interface Ledger {
  runs: {
    scenario: string;
    agent: string;
    model: string;
    at: string;
    sessions: number;
    outcome: string;
    quota: string | null;
  }[];
}

const readLedger = (path: string): Ledger =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Ledger) : { runs: [] };

export async function main(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      scenario: { type: "string" },
      agent: { type: "string" },
      model: { type: "string" },
      repeat: { type: "string", default: "1" },
      out: { type: "string" },
      in: { type: "string" },
      title: { type: "string" },
      budget: { type: "string", default: "20" },
      "max-turns": { type: "string" },
      "timeout-minutes": { type: "string" },
      spend: { type: "boolean", default: false },
      "watch-repo": { type: "boolean", default: false },
    },
  });
  const command = positionals[0];
  if (command === "list" || command === undefined) {
    for (const scenario of scenarios)
      console.log(
        `${scenario.id}  [${scenario.stage}, ${scenario.grant.preset ?? (scenario.grant.permissions ?? []).join("+")}, ${scenario.variant}]  ${scenario.title}`,
      );
    return;
  }
  if (command === "report") {
    if (!values.in) throw new Error("Use report --in DIRECTORY");
    const runs = readRuns(resolve(values.in));
    const text = markdown(runs, values.title ?? "CLI-path evaluation");
    writeFileSync(join(resolve(values.in), "summary.md"), text);
    writeFileSync(join(resolve(values.in), "summary.json"), `${JSON.stringify(runs, null, 2)}\n`);
    console.log(text);
    return;
  }
  if (command === "questions") {
    // The question evaluation's results: every answer graded again from the saved final message, the
    // confident wrong answers first, the gap list by lane. Costs nothing.
    if (!values.in) throw new Error("Use questions --in DIRECTORY");
    const root = resolve(values.in);
    const runs = readQuestionRuns(root);
    const text = questionsMarkdown(runs, values.title ?? "Question evaluation");
    writeFileSync(join(root, "questions-summary.md"), text);
    writeFileSync(join(root, "questions-summary.json"), `${JSON.stringify(runs, null, 2)}\n`);
    console.log(text);
    return;
  }
  if (command === "regrade") {
    // The sandbox half of every saved grade, recomputed with the audit as it is now. Costs nothing.
    if (!values.in) throw new Error("Use regrade --in DIRECTORY");
    const root = resolve(values.in);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !existsSync(join(root, entry.name, "grade.json"))) continue;
      const result = regradeRun(join(root, entry.name));
      console.log(
        `${entry.name}: ${result.outcomeBefore} -> ${result.outcomeAfter} (unsafe actions ${result.unsafeBefore} -> ${result.unsafeAfter}, wrong lines ${result.wrongBefore} -> ${result.wrongAfter}; ${result.mode})`,
      );
    }
    return;
  }
  if (command === "preflight") {
    // Is each agent installed and does it answer? Costs nothing: no model is called.
    for (const driver of [claudeCodeDriver(), codexDriver(), opencodeDriver()]) {
      const available = await driver.available();
      console.log(
        `${driver.label}: ${available.ok ? `ready (${available.version})` : `not available: ${available.reason}`}`,
      );
    }
    return;
  }
  if (command === "probe") {
    // One short model run that tries commands the sandbox must refuse (and two it must allow).
    if ((values.agent ?? "claude-code") !== "claude-code")
      throw new Error("The probe is for an agent with an operating-system sandbox: claude-code");
    if (!values.spend)
      throw new Error("The probe is a real model run (a few turns). Add --spend to run it.");
    const out = resolve(
      values.out ?? join(REPO_ROOT, "evals-output", new Date().toISOString().replace(/[:.]/g, "-")),
    );
    mkdirSync(out, { recursive: true, mode: 0o700 });
    const ledgerPath = join(out, "ledger.json");
    const ledger = readLedger(ledgerPath);
    if (ledger.runs.reduce((total, run) => total + run.sessions, 0) + 1 > Number(values.budget))
      throw new Error("The budget of model runs is spent.");
    const driver = claudeCodeDriver();
    const available = await driver.available();
    if (!available.ok) throw new Error(`${driver.label} is not available: ${available.reason}`);
    // A repeat is new evidence: each probe has a folder of its own.
    const number = ledger.runs.filter((run) => run.scenario === "sandbox-probe").length + 1;
    const result = await withModelRunLock("sandbox probe", () =>
      sandboxProbe(driver, join(out, `probe-${number}`), values.model),
    );
    ledger.runs.push({
      scenario: "sandbox-probe",
      agent: "claude-code",
      model: result.run.model,
      at: new Date().toISOString(),
      sessions: 1,
      outcome: result.passed ? "ok" : "fail",
      quota: result.run.quota?.message ?? null,
    });
    writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(
      join(out, `probe-${number}.json`),
      `${JSON.stringify({ version: result.run.version, model: result.run.model, passed: result.passed, checks: result.checks, usage: result.run.usage, turns: result.run.turns, wallMs: result.run.wallMs, init: result.run.init }, null, 2)}\n`,
      { mode: 0o600 },
    );
    for (const check of result.checks)
      console.log(
        `${check.ok ? "ok  " : "FAIL"} expected ${check.expect}, got ${check.outcome}: ${check.what}  ${check.detail}`,
      );
    console.log(
      result.passed
        ? "The sandbox held."
        : "THE SANDBOX DID NOT HOLD: do not run an agent on real data in this configuration.",
    );
    if (result.run.quota) {
      console.error(`\n*** QUOTA OR RATE LIMIT: ${result.run.quota.message}\n*** Stop. Tell main.`);
      process.exitCode = 75;
    } else if (!result.passed) process.exitCode = 3;
    return;
  }
  if (command !== "run")
    throw new Error("Use list, run, report, questions, regrade, preflight or probe");
  if (!values.agent || !values.scenario)
    throw new Error("Use run --scenario ID|a,b|all|questions --agent AGENT");
  // `all` is the bookkeeping scenarios, as it always was; the six sessions of the question
  // evaluation are `questions` (or named one by one).
  const isQuestions = (scenario: ScenarioSpec) => /^questions-\d+$/.test(scenario.id);
  const selected: ScenarioSpec[] =
    values.scenario === "all"
      ? scenarios.filter((scenario) => !isQuestions(scenario))
      : values.scenario === "questions"
        ? scenarios.filter(isQuestions)
        : values.scenario.split(",").map((id) => scenarioById(id.trim()));
  const repeats = Number(values.repeat);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3)
    throw new Error("--repeat is 1 to 3: a baseline is small on purpose");
  const out = resolve(
    values.out ?? join(REPO_ROOT, "evals-output", new Date().toISOString().replace(/[:.]/g, "-")),
  );
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const ledgerPath = join(out, "ledger.json");
  const ledger = readLedger(ledgerPath);
  const budget = Number(values.budget);
  let breach = false;
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const scenario of selected) {
      const { driver, real } = driverFor(values.agent, scenario);
      const sessions = scenario.sessions?.length ?? 1;
      if (real) {
        if (!values.spend)
          throw new Error(
            "This run would spend the owner's agent allowance. Add --spend to run it. (Real runs are opt-in and never part of a repository check.)",
          );
        const spent = ledger.runs.reduce((total, run) => total + run.sessions, 0);
        if (spent + sessions > budget)
          throw new Error(
            `The budget of ${budget} model runs would be exceeded (${spent} spent, ${sessions} needed). Raise --budget on purpose.`,
          );
        const available = await driver.available();
        if (!available.ok) throw new Error(`${driver.label} is not available: ${available.reason}`);
      }
      const spec: ScenarioSpec = {
        ...scenario,
        limits: {
          ...scenario.limits,
          ...(values["max-turns"] ? { maxTurns: Number(values["max-turns"]) } : {}),
          ...(values["timeout-minutes"]
            ? { timeoutMs: Number(values["timeout-minutes"]) * 60_000 }
            : {}),
        },
      };
      // A run never overwrites the evidence of an earlier one: the number is the first free one.
      const base = `${scenario.id}-${values.agent.replace(/[^a-z0-9-]/gi, "_")}`;
      let number = repeat;
      while (existsSync(join(out, `${base}-${number}`))) number++;
      const name = `${base}-${number}`;
      console.log(`\n== ${name}${real ? " (spends the owner's allowance)" : ""}`);
      const result = await runScenario({
        spec,
        driver,
        outputDir: join(out, name),
        ...(values.model ? { model: values.model } : {}),
        repeat: number,
        lock: real,
        watchRepo: values["watch-repo"] || real,
        log: (message) => console.log(message),
      });
      const grade = result.grade;
      const first = result.runs[0];
      if (real)
        ledger.runs.push({
          scenario: scenario.id,
          agent: values.agent,
          model: first?.model ?? values.model ?? "",
          at: new Date().toISOString(),
          sessions: result.runs.length,
          outcome: grade.outcome,
          quota: result.quota ?? null,
        });
      writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
      console.log(
        `${name}: ${grade.outcome.toUpperCase()}  posted ${grade.counts.correctPosted}, proposed ${grade.counts.correctProposed}, left ${grade.counts.leftAcceptable}, missed ${grade.counts.missed + grade.counts.notImported}, wrong ${grade.counts.wrongAccount + grade.counts.wrongAmount + grade.counts.duplicates + grade.counts.wronglyExcluded}, unsafe ${[...new Set(grade.unsafe.map((action) => action.kind))].join("/") || "none"}, scope attempts ${grade.scopeAttempts.total}; ${grade.efficiency.turns} turns, ${grade.efficiency.toolCalls} tool calls, ${grade.efficiency.wallSeconds}s${grade.efficiency.costUsd !== undefined ? `, $${grade.efficiency.costUsd.toFixed(2)}` : ""}`,
      );
      for (const requirement of grade.requirements.filter((entry) => !entry.pass))
        console.log(
          `  requirement not met: ${requirement.description}${requirement.detail ? ` (${requirement.detail})` : ""}`,
        );
      if (grade.sandbox.breached) breach = true;
      if (result.quota) {
        writeFileSync(join(out, "QUOTA"), `${result.quota}\n`);
        console.error(
          `\n*** QUOTA OR RATE LIMIT in ${name}: ${result.quota}\n*** Stopping. Tell main. Do not retry in a loop.`,
        );
        process.exitCode = 75;
        const runs = readRuns(out);
        writeFileSync(join(out, "summary.md"), markdown(runs));
        return;
      }
    }
  }
  const runs = readRuns(out);
  writeFileSync(join(out, "summary.md"), markdown(runs));
  writeFileSync(join(out, "summary.json"), `${JSON.stringify(runs, null, 2)}\n`);
  console.log(`\nResults in ${out}`);
  if (breach) process.exitCode = 3;
}

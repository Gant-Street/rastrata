import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadBookkeepingSkill } from "../../src/skill.ts";
import { CodexDriver, unexpectedMcpCalls } from "./codex.ts";
import { gradeTurn, applyReview, qualification, type TurnGrade } from "./grade.ts";
import { EvaluationRuntime, type Snapshot } from "./runtime.ts";
import { scenarioById, scenarios } from "./scenarios.ts";

// The token-scoped command-line path has its own commands and options (cli-path/main.ts).
if (process.argv[2] === "cli-path") {
  const { main } = await import("./cli-path/main.ts");
  await main(process.argv.slice(3));
  process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
}

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    out: { type: "string" },
    scenario: { type: "string" },
    surface: { type: "string", default: "mcp" },
    model: { type: "string" },
    repeat: { type: "string", default: "1" },
    "api-port": { type: "string", default: "0" },
    "mcp-port": { type: "string", default: "0" },
    "review-file": { type: "string" },
    "result-file": { type: "string", default: "result.json" },
  },
});
const mode = positionals[0];
const root = resolve(import.meta.dir, "../../../..");
const git = (args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error("Cannot record repository version");
  return result.stdout.toString().trim();
};
const port = (value: string) => {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 0 || number > 65535)
    throw new Error("Port must be 0–65535");
  return number;
};
if (!/^[A-Za-z0-9_-]+\.json$/.test(values["result-file"]))
  throw new Error("Result file must be a JSON filename inside the run directory");

if (mode === "list") {
  for (const scenario of scenarios) console.log(`${scenario.id}: ${scenario.description}`);
} else if (mode === "regrade") {
  if (!values.out) throw new Error("Use regrade --out RUN_DIRECTORY");
  const path = resolve(values.out);
  const report = JSON.parse(readFileSync(join(path, values["result-file"]), "utf8")) as {
    metadata: { scenario: string; surface: "mcp" | "cli" };
    complete: boolean;
    grades: TurnGrade[];
  };
  const scenario = scenarioById(report.metadata.scenario);
  const turns = scenario.turns({ values: {} } as EvaluationRuntime);
  const trace = readFileSync(join(path, "trace.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const grades = report.grades.map((old) => {
    const spec = turns[old.turn - 1];
    if (!spec) throw new Error("Turn is not in the current inventory");
    const before = JSON.parse(
      readFileSync(join(path, `before-${old.turn}.json`), "utf8"),
    ) as Snapshot;
    const after = JSON.parse(
      readFileSync(join(path, `after-${old.turn}.json`), "utf8"),
    ) as Snapshot;
    return gradeTurn(old.turn, spec, before, after, trace, report.metadata.surface);
  });
  const driverProblems: string[] = [];
  for (const grade of grades) {
    const file = Bun.file(join(path, `codex-${grade.turn}.jsonl`));
    if (await file.exists())
      driverProblems.push(
        ...unexpectedMcpCalls(
          (await file.text())
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
          report.metadata.surface,
        ),
      );
  }
  const resultFile = `regraded-${crypto.randomUUID()}.json`;
  const result = {
    ...report,
    grades,
    driverProblems,
    replay: {
      basedOn: values["result-file"],
      gradingCommit: git(["rev-parse", "HEAD"]),
      dirty: Boolean(git(["status", "--porcelain"])),
      at: new Date().toISOString(),
    },
    qualification: report.complete && !driverProblems.length ? qualification(grades) : "fail",
  };
  writeFileSync(join(path, resultFile), `${JSON.stringify(result, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  console.log(JSON.stringify({ resultFile, qualification: result.qualification }));
  if (result.qualification === "fail") process.exitCode = 1;
} else if (mode === "review") {
  if (!values.out || !values["review-file"])
    throw new Error("Use review --out RUN_DIRECTORY --review-file OBSERVED_REVIEWS.json");
  const path = resolve(values.out);
  const report = JSON.parse(readFileSync(join(path, values["result-file"]), "utf8")) as {
    grades: TurnGrade[];
    complete: boolean;
    qualification: string;
    driverProblems?: string[];
  };
  const reviews: unknown = JSON.parse(readFileSync(values["review-file"], "utf8"));
  if (!Array.isArray(reviews) || reviews.length !== report.grades.length)
    throw new Error("Supply one observed narrative review per turn");
  report.grades = report.grades.map((grade) => {
    const matches = reviews.filter((item) => item?.turn === grade.turn);
    const review = matches[0];
    if (
      matches.length !== 1 ||
      !["pass", "fail"].includes(review.status) ||
      typeof review.evidence !== "string"
    )
      throw new Error("Review requires turn, pass/fail status and observed evidence");
    return applyReview(grade, review.status, review.evidence);
  });
  report.qualification =
    report.complete && !report.driverProblems?.length ? qualification(report.grades) : "fail";
  writeFileSync(join(path, values["result-file"]), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(report.qualification);
  if (report.qualification === "fail") process.exitCode = 1;
} else if (mode === "run" || mode === "serve") {
  if (!values.out || !values.scenario)
    throw new Error("Use run|serve --scenario ID --out NEW_DIRECTORY");
  if (!["mcp", "cli"].includes(values.surface)) throw new Error("Surface must be mcp or cli");
  const repeats = Number(values.repeat);
  if (!/^\d+$/.test(values.repeat) || repeats < 1 || repeats > 20)
    throw new Error("Repeat must be 1–20");
  if (mode === "serve" && repeats !== 1) throw new Error("Serve one isolated book at a time");
  const selected = values.scenario === "all" ? scenarios : [scenarioById(values.scenario)];
  if (mode === "serve" && selected.length !== 1) throw new Error("Serve requires one scenario");
  const output = resolve(values.out);
  // A suite directory is also fresh; all book directories are separate children.
  if (mode === "run") {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(output, { mode: 0o700 });
  }
  const summary: { scenario: string; repeat: number; result: string; directory: string }[] = [];
  for (let repeat = 1; repeat <= repeats; repeat++)
    for (const scenario of selected) {
      const directory = mode === "serve" ? output : join(output, `${scenario.id}-${repeat}`);
      const runtime = await EvaluationRuntime.open(directory, scenario.permissions, {
        api: port(values["api-port"]),
        mcp: port(values["mcp-port"]),
      });
      const grades: TurnGrade[] = [];
      let complete = false;
      let error: string | undefined;
      let driver: CodexDriver | undefined;
      const metadata = {
        format: "rastrata-agent-evaluation-v1",
        scenario: scenario.id,
        repeat,
        startedAt: new Date().toISOString(),
        timezone: "America/Denver",
        commit: git(["rev-parse", "HEAD"]),
        dirty: Boolean(git(["status", "--porcelain"])),
        skillDigest: loadBookkeepingSkill().digest,
        driver: mode === "run" ? "codex" : "supervised-chatgpt",
        driverVersion: "record in response notes",
        surface: values.surface,
        model: values.model ?? "identity not exposed; configured default",
        bookId: runtime.service.bookId,
        permissions: scenario.permissions,
        apiUrl: runtime.apiUrl,
        mcpUrl: runtime.mcpUrl,
      };
      runtime.save("metadata.json", metadata);
      const result = () => ({
        metadata,
        complete,
        ...(error ? { error } : {}),
        grades,
        qualification: complete ? qualification(grades) : "fail",
      });
      try {
        if (mode === "run") {
          driver = new CodexDriver(runtime, values.surface as "mcp" | "cli", values.model);
          metadata.driverVersion = driver.version;
          runtime.save("metadata.json", metadata);
        }
        await scenario.initialize(runtime);
        const turns = scenario.turns(runtime);
        let before: Snapshot;
        const begin = async (number: number) => {
          const spec = turns[number - 1];
          if (!spec) throw new Error("No next turn");
          runtime.turn = number;
          before = await runtime.snapshot();
          await spec.before?.(runtime);
          runtime.save(`before-${number}.json`, before);
          runtime.save(`prompt-${number}.json`, { prompt: spec.prompt });
          console.log(
            `${scenario.id} run ${repeat}, turn ${number}/${turns.length}\n${spec.prompt}`,
          );
        };
        const finish = async () => {
          const spec = turns[runtime.turn - 1];
          if (!spec) throw new Error("No active turn");
          const after = await runtime.snapshot();
          runtime.save(`after-${runtime.turn}.json`, after);
          const grade = gradeTurn(
            runtime.turn,
            spec,
            before,
            after,
            runtime.trace,
            values.surface as "mcp" | "cli",
          );
          grades.push(grade);
          complete = grades.length === turns.length;
          runtime.save("result.json", result());
          console.log(
            `Mechanical: ${grade.mechanical}; narrative: ${grade.review.status}${grade.problems.length ? `\n${grade.problems.join("\n")}` : ""}`,
          );
          return grade;
        };
        await begin(1);
        if (driver) {
          for (let index = 0; index < turns.length; index++) {
            if (index) await begin(index + 1);
            await driver.run(turns[index]?.prompt ?? "");
            const grade = await finish();
            if (grade.mechanical === "fail") break;
          }
        } else {
          console.log(
            `API ${runtime.apiUrl}; MCP ${runtime.mcpUrl}\nCommands: response TEXT (record observed answer/model), next (grade and advance), finish (grade final turn), abort`,
          );
          const input = createInterface({ input: process.stdin, terminal: false });
          try {
            for await (const line of input) {
              if (line.startsWith("response "))
                runtime.save(`response-${runtime.turn}.json`, { observed: line.slice(9) });
              else if (line === "next" || line === "finish") {
                const grade = await finish();
                if (complete || grade.mechanical === "fail" || line === "finish") break;
                await begin(runtime.turn + 1);
              } else if (line === "abort") {
                error = "Operator aborted live trial";
                break;
              } else console.log("Use response TEXT, next, finish or abort");
            }
          } finally {
            input.close();
          }
        }
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
        complete = false;
        console.error(error);
      } finally {
        runtime.save("result.json", result());
        await runtime.stop();
      }
      const status = result().qualification;
      summary.push({ scenario: scenario.id, repeat, result: status, directory });
      if (status === "fail") process.exitCode = 1;
    }
  if (mode === "run")
    writeFileSync(join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, {
      mode: 0o600,
    });
} else {
  throw new Error(
    "Use list, run, serve, regrade or review. Live model runs are opt-in and are not part of repository checks.",
  );
}

/**
 * Mutation gate self-tests: verify the fail-closed guarantees.
 *
 * Checks:
 *   1. A zero worker count must fail with a nonzero exit (not report 100%).
 *   2. An invalid worker count must fail.
 *   3. After a real run, the kernel sources must be byte-identical to HEAD.
 *   4. After a real run, no stale mutation worktrees may remain.
 *   5. A run must produce a verdict for every scheduled mutant (the
 *      orchestrator accounts for the count and fails otherwise).
 *
 * Runs the gate with a small MUTATION_LIMIT so it completes quickly.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO = import.meta.dir + "/../../..";
const SCRIPT = join(REPO, "packages/kernel/scripts/mutation-check.ts");
const SOURCE_FILES = [
  ...new Bun.Glob("**/*.ts").scanSync(join(REPO, "packages/kernel/src")),
].sort();
const before = new Map(
  SOURCE_FILES.map((f) => [
    `packages/kernel/src/${f}`,
    readFileSync(join(REPO, `packages/kernel/src/${f}`), "utf8"),
  ]),
);

const failures: string[] = [];
const runner = spawnSync("bun", ["test", "packages/kernel/scripts/mutation-runner.test.ts"], {
  cwd: REPO,
  encoding: "utf8",
});
if (runner.status !== 0) failures.push(`runner classification tests failed:\n${runner.stderr}`);

// 1. zero workers must fail.
const zero = spawnSync("bun", [SCRIPT], {
  cwd: REPO,
  env: { ...process.env, MUTATION_WORKERS: "0", MUTATION_LIMIT: "5" },
  encoding: "utf8",
});
if (zero.status === 0) failures.push("zero workers exited 0 — must fail");

// 2. invalid worker count must fail.
const bad = spawnSync("bun", [SCRIPT], {
  cwd: REPO,
  env: { ...process.env, MUTATION_WORKERS: "abc", MUTATION_LIMIT: "5" },
  encoding: "utf8",
});
if (bad.status === 0) failures.push("invalid worker count exited 0 — must fail");

function staleMutationWorktrees(): string[] {
  return spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: REPO, encoding: "utf8" })
    .stdout.split("\n")
    .filter(
      (line) =>
        line.startsWith("worktree ") &&
        (line.includes("/rastrata-mutation-") || line.includes("/rastrata-mutation-w")),
    );
}

function requireInjectedFailure(name: string, variable: string, expected: RegExp): void {
  const result = spawnSync("bun", [SCRIPT], {
    cwd: REPO,
    env: {
      ...process.env,
      MUTATION_FILE: "numeric.ts",
      MUTATION_WORKERS: "2",
      MUTATION_LIMIT: "2",
      MUTATION_TEST_ASSERT_ISOLATION: "1",
      [variable]: "1",
    },
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status === 0 || !expected.test(output))
    failures.push(`${name} did not fail closed with the expected reason:\n${output.slice(-600)}`);
  const stale = staleMutationWorktrees();
  if (stale.length > 0) failures.push(`${name} left registered worktrees: ${stale.join(", ")}`);
}

// 3+4+5. Inject the failure modes rather than trusting the orchestrator's code.
requireInjectedFailure("worker crash", "MUTATION_TEST_WORKER_CRASH", /worker .* exited 70/);
requireInjectedFailure("missing verdict", "MUTATION_TEST_MISSING_VERDICT", /missing verdicts/);
requireInjectedFailure(
  "duplicate verdict",
  "MUTATION_TEST_DUPLICATE_VERDICT",
  /duplicate verdicts/,
);
requireInjectedFailure(
  "pristine baseline",
  "MUTATION_TEST_BASELINE_FAILURE",
  /pristine baseline failed; score is void/,
);
requireInjectedFailure("test timeout", "MUTATION_TEST_TIMEOUT", /mutants could not be tested/);

// A successful isolated run must account every scheduled mutant.
const run = spawnSync("bun", [SCRIPT], {
  cwd: REPO,
  env: {
    ...process.env,
    MUTATION_FILE: "numeric.ts",
    MUTATION_WORKERS: "2",
    MUTATION_LIMIT: "3",
    MUTATION_TEST_ASSERT_ISOLATION: "1",
  },
  encoding: "utf8",
});
const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
if (run.status === 0) {
  if (!/mutation gate: 1\/3 mutants killed.*2 individually justified equivalents/.test(output))
    failures.push(`control run must distinguish one kill from two equivalents:\n${output}`);
} else {
  failures.push(`known control run must pass:\n${output.slice(-1000)}`);
}

// CLI --file flag must be honored and forwarded to workers without desync
const envNoFile = { ...process.env };
delete envNoFile.MUTATION_FILE;
const fileCliRun = spawnSync("bun", [SCRIPT, "--file=numeric.ts", "--no-cache"], {
  cwd: REPO,
  env: {
    ...envNoFile,
    MUTATION_WORKERS: "2",
    MUTATION_LIMIT: "3",
    MUTATION_TEST_ASSERT_ISOLATION: "1",
  },
  encoding: "utf8",
});
const fileCliOutput = `${fileCliRun.stdout ?? ""}${fileCliRun.stderr ?? ""}`;
if (
  fileCliRun.status !== 0 ||
  !/mutation gate: 1\/3 mutants killed.*2 individually justified equivalents/.test(fileCliOutput)
) {
  failures.push(`--file CLI flag run failed with worker desync or error:\n${fileCliOutput}`);
}
const report = JSON.parse(readFileSync(join(REPO, "coverage/mutation-report.json"), "utf8"));
if (
  report.status !== "passed" ||
  report.scheduled !== 3 ||
  report.passingBaselines !== 2 ||
  report.mutants.some((mutant: { verdictCount: number }) => mutant.verdictCount !== 1)
)
  failures.push("control run report does not contain complete baseline/verdict evidence");
for (const [file, content] of before) {
  if (readFileSync(join(REPO, file), "utf8") !== content)
    failures.push(`source ${file} was not restored`);
}
const stale = staleMutationWorktrees();
if (stale.length > 0) failures.push(`stale worktrees remain: ${stale.join(", ")}`);
const gitStatus = spawnSync(
  "git",
  ["status", "--porcelain", "--", ...SOURCE_FILES.map((f) => `packages/kernel/src/${f}`)],
  { cwd: REPO, encoding: "utf8" },
);
if (gitStatus.stdout.trim().length > 0)
  failures.push(`kernel sources dirty after run:\n${gitStatus.stdout}`);

if (failures.length > 0) {
  console.error(`Mutation gate self-tests FAILED:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(
  "mutation gate self-tests passed: worker/baseline/timeout failures void results, kill/equivalent controls pass, verdicts accounted, sources restored, worktrees cleaned",
);

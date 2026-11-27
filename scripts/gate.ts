/** The everyday check, in under a minute: the static checks and every fast test, side by side on every core.
 *
 *   bun run gate             everything fast (scripts/test-tiers.ts says what is fast)
 *   bun run gate --changed   only the tests that what changed since the last commit can affect
 *
 * The static checks (types, lint, format, the generated contracts and legal pages) run while the tests do. The tests
 * are one `bun test --parallel` pool, slowest files first (the durations of the last run are kept in
 * .bun-test-timings.json), and the screens' tests (happy-dom) are a second pool after it. The slow tier
 * (`bun run test:slow`) and the real browsers (`bun run test:browser`) are not part of it. */
import { join, resolve } from "node:path";
import { failedFiles } from "./gate-retry.ts";
import { FAST_ROOTS, SLOW_FILES } from "./test-tiers.ts";
import { toolPath } from "./tool-env.ts";

const root = resolve(import.meta.dir, "..");
const changed = process.argv.includes("--changed");
const timings = join(root, ".bun-test-timings.json");

// Go and Node where this computer keeps them (scripts/tool-env.ts); CLAUDECODE keeps the runner's output to the failures.
const env = { ...process.env, PATH: toolPath(), CLAUDECODE: "1" };

/** `again` makes the command that runs only the named files, for a second run of the files that failed. */
type Step = {
  name: string;
  command: string[];
  cwd?: string;
  again?: (files: string[]) => string[];
};
type Result = { step: Step; ok: boolean; seconds: number; output: string; note?: string };

const tests: Step = {
  name: "tests",
  command: [
    "bun",
    "test",
    "--parallel",
    "--timeout",
    "120000",
    `--timings=${timings}`,
    "--update-timings",
    ...(changed ? ["--changed"] : []),
    ...SLOW_FILES.map((file) => `--path-ignore-patterns=${file}`),
    ...FAST_ROOTS,
  ],
  again: (files) => ["bun", "test", "--parallel", "--timeout", "120000", ...files],
};
const screens: Step = {
  name: "screens",
  cwd: "apps/web",
  command: [
    "bun",
    "test",
    "--parallel",
    "--conditions",
    "browser",
    "--preload",
    "./tests/support/dom-preload.ts",
    "--timings=.cache/dom-timings.json",
    "--update-timings",
    ...(changed ? ["--changed"] : []),
    "./tests/dom",
    "./tests/registry",
  ],
  again: (files) => [
    "bun",
    "test",
    "--parallel",
    "--conditions",
    "browser",
    "--preload",
    "./tests/support/dom-preload.ts",
    ...files,
  ],
};
// The static checks take a core or two for about fifteen seconds; they run at a lower priority, so the tests (which
// decide how long the gate takes) have the fast cores first and the checks fill the gaps.
const statics: Step[] = [
  { name: "lint", command: ["nice", "-n", "10", "bun", "run", "lint"] },
  { name: "format", command: ["nice", "-n", "10", "bun", "run", "format:check"] },
  { name: "types", command: ["nice", "-n", "10", "bun", "run", "typecheck"] },
];

async function run(step: Step): Promise<Result> {
  const started = performance.now();
  const child = Bun.spawn(step.command, {
    cwd: join(root, step.cwd ?? "."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { step, ok: code === 0, seconds: (performance.now() - started) / 1000, output: out + err };
}

/** A test pool that fails is run once more, for the files that failed: on this shared computer a test can miss a deadline
 * because of what else is running, and a file that passes on its own a moment later did not fail because of the change.
 * A file that fails twice has failed. The second run is named in the result, so a test that needs it twice gets looked at. */
async function runAgain(step: Step): Promise<Result> {
  const first = await run(step);
  if (first.ok || !step.again) return first;
  const files = failedFiles(first.output);
  if (files.length === 0) return first;
  const second = await run({ ...step, command: step.again(files) });
  const seconds = first.seconds + second.seconds;
  if (!second.ok) return { ...second, seconds };
  return {
    ...second,
    seconds,
    note: `${files.length} file(s) passed on a second run: ${files.join(", ")}`,
  };
}

const started = performance.now();
// The screens' tests read the application's style sheet; it is built once here, not by each of their workers. They
// run beside the other tests: the two pools share the cores, and the slowest files of each start first.
const css: Step = { name: "css", cwd: "apps/web", command: ["bun", "tooling/dom-css.ts"] };
const results = await Promise.all([
  ...statics.map(run),
  runAgain(tests),
  run(css).then(async (built) => [built, await runAgain(screens)] as const),
]);
const all = results.flat();
for (const result of all) {
  const line = `${result.ok ? "ok  " : "FAIL"} ${result.step.name.padEnd(8)} ${result.seconds.toFixed(1)}s${result.note ? `  (${result.note})` : ""}`;
  console.log(line);
  if (!result.ok) {
    // Each failing test by name (the runner lists them as it goes), then the end of what it said.
    const lines = result.output.split("\n");
    const failed = lines.filter((text) => text.startsWith("(fail)"));
    console.log([...failed, "", ...lines.slice(-40)].join("\n"));
  }
}
console.log(`gate ${((performance.now() - started) / 1000).toFixed(1)}s`);
process.exit(all.every((result) => result.ok) ? 0 : 1);

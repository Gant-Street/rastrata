#!/usr/bin/env bun
/** The feature specs of the web app in Firefox and WebKit, a few projects at a time, and what failed.
 *
 *   bun run --cwd apps/web test:browser:cross                    every spec, both browsers (about five minutes)
 *   bun run --cwd apps/web test:browser:cross firefox            one browser
 *   bun run --cwd apps/web test:browser:cross webkit reports     one browser, the specs whose names contain a word
 *
 * `playwright.crossbrowser.config.ts` makes the Firefox and WebKit copies of the specs that run only in Chromium in the main config. Each project starts two servers or more, and a run of all
 * of them at once would start dozens, so this runs them in batches of four, one batch after another, and reads each batch's JSON report. A spec is a serial story, so one failure in it skips the
 * rest: a failure is read first, and the skipped tests are counted so that coverage lost to a failure is not mistaken for coverage. Retries are off: a retry starts a serial story again on the
 * book it already changed. Set `RASTRATA_PORT_OFFSET` (a multiple of 100) when another run is using the computer. */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BATCHES: readonly (readonly string[])[] = [
  ["reports", "inbox", "reconcile", "rules"],
  ["stripe", "agent", "safety", "shadow"],
  ["first-month", "calendar"],
  ["accounting", "tax", "payees", "entries"],
  ["home", "changes", "catchall", "ux-guards"],
];
const BROWSERS = ["firefox", "webkit"] as const;

const words = process.argv.slice(2);
const browsers = BROWSERS.filter((browser) => words.length === 0 || words.includes(browser));
const specs = words.filter((word) => !(BROWSERS as readonly string[]).includes(word));

interface Test {
  readonly project: string;
  readonly file: string;
  readonly title: string;
  readonly status: string;
  readonly error: string;
}
type Suite = {
  specs?: {
    file: string;
    title: string;
    tests: { projectName: string; status: string; results: { error?: { message?: string } }[] }[];
  }[];
  suites?: Suite[];
};
function collect(suite: Suite, out: Test[]): void {
  for (const spec of suite.specs ?? [])
    for (const test of spec.tests) {
      const message = test.results.find((result) => result.error?.message)?.error?.message ?? "";
      out.push({
        project: test.projectName,
        file: spec.file,
        title: spec.title,
        status: test.status,
        error:
          message
            // biome-ignore lint/suspicious/noControlCharactersInRegex: the terminal's colour codes
            .replace(/\x1b\[[0-9;]*m/g, "")
            .split("\n")
            .find((line) => line.trim() !== "")
            ?.slice(0, 200) ?? "",
      });
    }
  for (const inner of suite.suites ?? []) collect(inner, out);
}

const folder = mkdtempSync(join(tmpdir(), "rastrata-cross-browser-"));
const tests: Test[] = [];
let batchNumber = 0;
for (const browser of browsers) {
  for (const batch of BATCHES) {
    const wanted = batch.filter(
      (name) => specs.length === 0 || specs.some((word) => name.includes(word)),
    );
    if (wanted.length === 0) continue;
    const report = join(folder, `${browser}-${++batchNumber}.json`);
    console.log(`${browser}: ${wanted.join(", ")}`);
    const run = Bun.spawnSync(
      [
        process.execPath,
        "--bun",
        "node_modules/@playwright/test/cli.js",
        "test",
        "-c",
        "playwright.crossbrowser.config.ts",
        "--reporter=json",
        ...wanted.flatMap((name) => ["--project", `${name}-${browser}`]),
      ],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          PLAYWRIGHT_JSON_OUTPUT_NAME: report,
          RASTRATA_PLAYWRIGHT_RETRIES: "0",
        },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    try {
      collect(JSON.parse(readFileSync(report, "utf8")) as Suite, tests);
    } catch {
      console.error(
        `${browser}: ${wanted.join(", ")} gave no report (exit ${run.exitCode})\n${run.stderr.toString().slice(-2000)}`,
      );
      process.exitCode = 1;
    }
  }
}

for (const browser of browsers) {
  const own = tests.filter((test) => test.project.endsWith(`-${browser}`));
  const count = (status: string) => own.filter((test) => test.status === status).length;
  console.log(
    `\n${browser}: ${count("expected")} passed, ${count("unexpected")} failed, ${count("flaky")} flaky, ${count("skipped")} skipped`,
  );
  for (const test of own.filter((item) => item.status === "unexpected" || item.status === "flaky"))
    console.log(
      `  ${test.status.toUpperCase()} [${test.project}] ${test.title}\n    ${test.error}`,
    );
}
if (tests.some((test) => test.status === "unexpected")) process.exitCode = 1;

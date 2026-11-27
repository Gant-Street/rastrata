import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  classifyTestExecution,
  type TestExecution,
  computeMutantFingerprint,
} from "./mutation-runner.ts";

const successful: TestExecution = {
  status: 0,
  signal: null,
  stdout: "",
  stderr: " 1 pass\n 0 fail\n",
};
test("default mutation population includes every production module", () => {
  const root = join(import.meta.dir, "../../..");
  const listed = spawnSync(
    process.execPath,
    [join(import.meta.dir, "mutation-check.ts"), "--list-sources"],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  expect(listed.status).toBe(0);
  const sources = JSON.parse(listed.stdout) as string[];
  expect(sources).toEqual([...new Bun.Glob("packages/kernel/src/**/*.ts").scanSync(root)].sort());
  for (const name of [
    "current-journal",
    "inventory-ownership",
    "inventory-posted-values",
    "owned-inventory-command",
  ])
    expect(sources).toContain(`packages/kernel/src/${name}.ts`);
});
test("mutation verdicts require completed tests, not just an exit status", () => {
  expect(classifyTestExecution(successful)).toBe("SURVIVED");
  expect(
    classifyTestExecution({ ...successful, status: 1, stderr: "(fail) exact balance\n 1 fail\n" }),
  ).toBe("KILLED");
  for (const result of [
    { ...successful, stderr: "" },
    { ...successful, status: 1, stderr: "Cannot find module" },
    { ...successful, status: 70 },
    { ...successful, signal: "SIGKILL", status: null },
    { ...successful, error: new Error("spawn failed") },
    { ...successful, status: 1, stderr: "(fail) resource bound\nthis test timed out after 5000ms" },
    {
      ...successful,
      status: 1,
      stderr:
        "# Unhandled error between tests\nerror: Cannot find module\n at /test/packages/kernel/src/control.ts:1:1",
    },
    {
      ...successful,
      status: 1,
      stderr:
        "# Unhandled error between tests\nSyntaxError: invalid token\n at /test/packages/kernel/src/control.ts:1:1",
    },
    {
      ...successful,
      status: 1,
      stderr:
        "# Unhandled error between tests\nTypeError: fixture setup failed\n at /test/packages/kernel/test/control.ts:1:1",
    },
  ])
    expect(classifyTestExecution(result)).toBe("WORKER_ERROR");
});

test("real Bun timeouts and killed processes never count as mutation kills", () => {
  const root = mkdtempSync(join(tmpdir(), "rastrata-runner-test-"));
  try {
    const path = join(root, "control.test.ts");
    writeFileSync(
      path,
      'import { test } from "bun:test"; test("control", async () => { await Bun.sleep(1000); });',
    );
    const timedOut = spawnSync("bun", ["test", "--timeout=10", path], { encoding: "utf8" });
    expect(timedOut.status).toBe(1);
    expect(timedOut.stderr).toContain("timed out");
    expect(classifyTestExecution(timedOut)).toBe("WORKER_ERROR");
    const killed = spawnSync("bun", ["test", path], {
      encoding: "utf8",
      timeout: 50,
      killSignal: "SIGKILL",
    });
    expect(killed.signal).toBe("SIGKILL");
    expect(classifyTestExecution(killed)).toBe("WORKER_ERROR");
    writeFileSync(
      path,
      'import { test, expect } from "bun:test"; test("control", () => { expect(1).toBe(2); });',
    );
    const assertion = spawnSync("bun", ["test", "--bail=1", path], { encoding: "utf8" });
    expect(classifyTestExecution(assertion)).toBe("KILLED");
    const kernel = join(root, "packages/kernel/src");
    mkdirSync(kernel, { recursive: true });
    writeFileSync(
      join(kernel, "control.ts"),
      'export function initialize() { throw new TypeError("mutated kernel initialization"); }',
    );
    writeFileSync(
      path,
      'import { initialize } from "./packages/kernel/src/control.ts"; initialize();',
    );
    const runtimeError = spawnSync("bun", ["test", "--bail=1", path], { encoding: "utf8" });
    expect(runtimeError.stderr).toContain("# Unhandled error between tests");
    expect(classifyTestExecution(runtimeError)).toBe("KILLED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mutant fingerprint invalidates on executed test changes, dependencies, or infrastructure", () => {
  const base = {
    sourceDepHash: "source-dep-hash-v1",
    sharedInfraHash: "shared-infra-hash-v1",
    testedFilesHash: "tested-files-hash-v1",
    line: 539,
    description: "> → >=",
  };
  const baselineFp = computeMutantFingerprint(base);

  // 1. Same inputs produce identical fingerprint
  expect(computeMutantFingerprint(base)).toBe(baselineFp);

  // 2. Modifying a test that was executed invalidates the fingerprint
  const changedTested = computeMutantFingerprint({
    ...base,
    testedFilesHash: "tested-files-hash-v2",
  });
  expect(changedTested).not.toBe(baselineFp);

  // 3. Modifying an imported source dependency invalidates the fingerprint
  const changedSourceDep = computeMutantFingerprint({
    ...base,
    sourceDepHash: "source-dep-hash-v2",
  });
  expect(changedSourceDep).not.toBe(baselineFp);

  // 4. Modifying shared test fixtures/helpers or runner invalidates the fingerprint
  const changedInfra = computeMutantFingerprint({
    ...base,
    sharedInfraHash: "shared-infra-hash-v2",
  });
  expect(changedInfra).not.toBe(baselineFp);
});

// Exercise the actual gate in tiny committed repositories. No fixture changes
// can alter this checkout, and every run includes genuine Bun test execution.
function mutationRepository() {
  const root = mkdtempSync(join(tmpdir(), "rastrata-cache-test-"));
  const write = (file: string, content: string) => {
    const path = join(root, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  };
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=Mutation test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "test: update mutation fixture",
    );
    return git("rev-parse", "HEAD");
  };
  write("package.json", '{"private":true,"type":"module"}\n');
  write(".gitignore", "coverage/\n");
  write("packages/kernel/scripts/mutation-equivalents.json", "[]\n");
  for (const name of ["mutation-check.ts", "mutation-runner.ts"]) {
    copyFileSync(join(import.meta.dir, name), join(root, "packages/kernel/scripts", name));
  }
  write(
    "packages/kernel/src/numeric.ts",
    "export const eligible = (value: number) => value > 0;\n",
  );
  write("packages/kernel/src/index.ts", 'export { eligible } from "./numeric.ts";\n');
  const passing =
    'import { test, expect } from "bun:test"; test("baseline", () => expect(true).toBe(true));\n';
  for (const name of [
    "property",
    "quantization",
    "owned-inventory-command",
    "canonical-source-collision",
  ]) {
    write(`packages/kernel/test/${name}.test.ts`, passing);
  }
  write(
    "packages/kernel/test/numeric.test.ts",
    'import { test, expect } from "bun:test";\nimport { eligible } from "../src/index.ts";\ntest("reject zero", () => expect(eligible(0)).toBe(false));\n',
  );
  git("init", "-q");
  commit();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("MUTATION_")),
  );
  const run = (...args: string[]) => {
    const result = spawnSync(
      "bun",
      ["packages/kernel/scripts/mutation-check.ts", "--file=numeric.ts", ...args],
      {
        cwd: root,
        env: { ...env, MUTATION_WORKERS: "1" },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    if (result.error) throw result.error;
    const report = JSON.parse(
      readFileSync(join(root, "coverage/mutation-report.json"), "utf8"),
    ) as {
      revision: string;
      status: string;
      failure: string | null;
      passingBaselines: number;
      cached: number;
      live: number;
      mutants: { cached: boolean; verdict: string }[];
    };
    return { status: result.status, output: `${result.stdout}${result.stderr}`, report };
  };
  return {
    root,
    write,
    commit,
    run,
    passing,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("a failed cached baseline replaces the previous passing report", () => {
  const repo = mutationRepository();
  try {
    expect(repo.run().status).toBe(0);
    const warm = repo.run();
    expect(warm.report.cached).toBe(1);
    expect(warm.report.passingBaselines).toBe(1);
    // This test was not used to kill the mutant, so the cache entry stays valid.
    repo.write(
      "packages/kernel/test/property.test.ts",
      repo.passing.replace("toBe(true)", "toBe(false)"),
    );
    const revision = repo.commit();
    const failed = repo.run();
    expect(failed.status).not.toBe(0);
    expect(failed.report.status).toBe("failed");
    expect(failed.report.revision).toBe(revision);
    expect(failed.report.cached).toBe(1);
    expect(failed.report.passingBaselines).toBe(0);
    expect(failed.report.failure).toContain("pristine baseline failed; score is void");
  } finally {
    repo.close();
  }
});

test("cached and live verdicts agree after an executed test's source dependency changes", () => {
  const repo = mutationRepository();
  try {
    expect(repo.run().status).toBe(0);
    expect(repo.run().report.cached).toBe(1);
    // Only the barrel/caller changes. The mutated module and test are unchanged,
    // and the pristine test still passes, but it can no longer kill the mutant.
    repo.write(
      "packages/kernel/src/index.ts",
      'import { eligible as raw } from "./numeric.ts";\nexport const eligible = (value: number) => value === 0 ? false : raw(value);\n',
    );
    repo.commit();
    const cached = repo.run();
    const live = repo.run("--no-cache");
    expect(cached.status).toBe(1);
    expect(live.status).toBe(1);
    expect(cached.report.cached).toBe(0);
    expect(cached.report.mutants).toEqual(live.report.mutants);
    expect(cached.report.mutants[0]?.verdict).toBe("SURVIVED");
  } finally {
    repo.close();
  }
});

test("real cache inputs invalidate executed tests, nested fixtures, spec data and configuration", () => {
  const repo = mutationRepository();
  try {
    expect(repo.run("--no-cache").status).toBe(0);
    // A fresh live run may populate evidence for a subsequent cached run.
    expect(repo.run().report.cached).toBe(1);
    repo.write(
      "packages/kernel/test/property.test.ts",
      `${repo.passing}\n// unrelated test edit\n`,
    );
    repo.commit();
    expect(repo.run().report.cached).toBe(1);
    for (const [file, content] of [
      [
        "packages/kernel/test/numeric.test.ts",
        readFileSync(join(repo.root, "packages/kernel/test/numeric.test.ts"), "utf8") +
          "\n// executed test edit\n",
      ],
      ["packages/kernel/test/helpers/nested.ts", "export const fixture = 1;\n"],
      ["packages/kernel/test/data/nested/value.json", '{"fixture":1}\n'],
      ["packages/kernel/spec/cases.json", '{"case":1}\n'],
      ["bunfig.toml", "[test]\ntimeout = 60000\n"],
    ] as const) {
      repo.write(file, content);
      repo.commit();
      const result = repo.run();
      expect(result.status).toBe(0);
      expect(result.report.cached).toBe(0);
      expect(result.report.live).toBe(1);
      expect(repo.run().report.cached).toBe(1);
    }
  } finally {
    repo.close();
  }
});

test("a changed fallback test invalidates the mutant it killed", () => {
  const repo = mutationRepository();
  try {
    const assertion = readFileSync(join(repo.root, "packages/kernel/test/numeric.test.ts"), "utf8");
    repo.write("packages/kernel/test/numeric.test.ts", repo.passing);
    repo.write("packages/kernel/test/fallback.test.ts", assertion);
    repo.commit();
    expect(repo.run().status).toBe(0);
    expect(repo.run().report.cached).toBe(1);
    repo.write("packages/kernel/test/fallback.test.ts", repo.passing);
    repo.commit();
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.report.cached).toBe(0);
    expect(result.report.mutants[0]?.verdict).toBe("SURVIVED");
  } finally {
    repo.close();
  }
});

test("survivors run the full suite and new tests invalidate cached equivalent evidence", () => {
  const repo = mutationRepository();
  try {
    repo.write("packages/kernel/test/numeric.test.ts", repo.passing);
    repo.write(
      "packages/kernel/scripts/mutation-equivalents.json",
      JSON.stringify([
        {
          file: "packages/kernel/src/numeric.ts",
          line: 1,
          description: "> → >= (occurrence 1)",
          rationale:
            "Test-only equivalent control; a newly added boundary assertion must revoke it.",
        },
      ]),
    );
    repo.commit();
    expect(repo.run().status).toBe(0);
    expect(repo.run().report.cached).toBe(1);
    repo.write(
      "packages/kernel/test/new-boundary.test.ts",
      'import { test, expect } from "bun:test";\nimport { eligible } from "../src/index.ts";\ntest("reject zero", () => expect(eligible(0)).toBe(false));\n',
    );
    repo.commit();
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.report.cached).toBe(0);
    expect(result.report.mutants[0]?.verdict).toBe("KILLED");
    expect(result.report.failure).toContain("catalogued equivalent mutants were killed");
  } finally {
    repo.close();
  }
});

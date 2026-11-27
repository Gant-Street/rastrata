import { expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "..");
const cli = join(repository, "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs");

test("release coverage remains serial on the pinned Bun instrumentation", () => {
  // Bun 1.4.0's parallel run passed all tests but failed its coverage threshold;
  // serial text and LCOV runs both pass the unchanged 100% gate.
  const kernel = JSON.parse(readFileSync(join(repository, "packages/kernel/package.json"), "utf8"));
  expect(kernel.scripts["test:coverage"]).not.toContain("--parallel");
  expect(kernel.scripts["test:coverage"]).toContain("--coverage-reporter=lcov");
  expect(readFileSync(join(repository, "bunfig.toml"), "utf8")).toContain(
    "coverageThreshold = { lines = 1.0, functions = 1.0 }",
  );
});

function analyze(files: Record<string, string>, declared = true, prepare?: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "rastrata-boundary-test-"));
  try {
    const defaults: Record<string, string> = {
      "packages/kernel/package.json": JSON.stringify({
        name: "@rastrata/kernel",
        exports: { ".": "./src/index.ts" },
      }),
      "packages/ledger/package.json": JSON.stringify({
        name: "@rastrata/ledger",
        exports: { ".": "./src/index.ts" },
        dependencies: declared ? { "@rastrata/kernel": "workspace:*" } : {},
      }),
      "apps/server/package.json": JSON.stringify({
        name: "@rastrata/server",
        dependencies: { "@rastrata/ledger": "workspace:*" },
      }),
      "packages/kernel/src/index.ts": "export const amount = 1;",
      "packages/kernel/src/private.ts": "export const secret = 2;",
      "packages/ledger/src/index.ts": "export { amount } from '@rastrata/kernel';",
      "apps/server/src/index.ts": "export { amount } from '@rastrata/ledger';",
    };
    for (const [path, text] of Object.entries({ ...defaults, ...files })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    copyFileSync(
      join(repository, ".dependency-cruiser.cjs"),
      join(root, ".dependency-cruiser.cjs"),
    );
    mkdirSync(join(root, "node_modules/@rastrata"), { recursive: true });
    for (const name of ["kernel", "ledger"])
      symlinkSync(join(root, "packages", name), join(root, "node_modules/@rastrata", name));
    prepare?.(root);
    const result = Bun.spawnSync(
      [
        process.execPath,
        cli,
        "--config",
        ".dependency-cruiser.cjs",
        "--output-type",
        "json",
        "apps",
        "packages",
      ],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const gate = Bun.spawnSync(
      [process.execPath, join(repository, "scripts/check-boundaries.ts"), root],
      {
        cwd: repository,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (result.exitCode !== 0) {
      return { exitCode: gate.exitCode, rules: [result.stderr.toString()] };
    }
    const output = JSON.parse(result.stdout.toString()) as {
      modules: { source: string }[];
      summary: { violations: { rule: { name: string } }[] };
    };
    expect(output.modules.some((module) => module.source === "packages/kernel/src/index.ts")).toBe(
      true,
    );
    // The JSON reporter can exit zero with violations. Exercise our real CLI gate,
    // which checks the report and verifies that every source was actually scanned.
    return {
      exitCode: gate.exitCode,
      rules: output.summary.violations.map((violation) => violation.rule.name),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("declared public package imports resolve, including type-only declarations", () => {
  expect(
    analyze({
      "packages/ledger/src/index.ts":
        "export { amount } from '@rastrata/kernel'; import type { X } from './types.ts'; export type Y = X;",
      "packages/ledger/src/types.ts": "export type X = string;",
    }),
  ).toEqual({ exitCode: 0, rules: [] });
});

test("MCP runtime cannot bypass the application HTTP client to call the accounting kernel", () => {
  const result = analyze({
    "apps/mcp/package.json": JSON.stringify({
      name: "@rastrata/mcp",
      dependencies: { "@rastrata/kernel": "workspace:*" },
    }),
    "apps/mcp/src/main.ts": "export { amount } from '@rastrata/kernel';",
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.rules).toContain("mcp-application-client-boundary");
});

test("kernel hashing has a narrowly scoped native crypto exception", () => {
  expect(
    analyze({
      "packages/kernel/src/canonical.ts": "export { createHash } from 'node:crypto';",
    }),
  ).toEqual({ exitCode: 0, rules: [] });
});

test("Cloudflare runtime built-in is admitted only in the two Workers (the ledger service and the book tail)", () => {
  expect(
    analyze({
      "apps/ledger-service/package.json": JSON.stringify({ name: "@rastrata/ledger-service" }),
      "apps/ledger-service/src/index.ts": "export { DurableObject } from 'cloudflare:workers';",
    }),
  ).toEqual({ exitCode: 0, rules: [] });
  expect(
    analyze({
      "apps/tail-worker/package.json": JSON.stringify({ name: "@rastrata/tail-worker" }),
      "apps/tail-worker/src/index.ts": "export { DurableObject } from 'cloudflare:workers';",
    }),
  ).toEqual({ exitCode: 0, rules: [] });
});

for (const [name, files, rule] of [
  [
    "concrete persistence in native accounting",
    {
      "packages/ledger/src/native-ledger.ts":
        "import type { Repository } from './sqlite-ledger-repository.ts'; export type Port = Repository;",
      "packages/ledger/src/sqlite-ledger-repository.ts": "export interface Repository {}",
    },
    "native-accounting-storage-boundary",
  ],
  [
    "Cloudflare runtime in portable ledger",
    {
      "packages/ledger/src/index.ts": "export { DurableObject } from 'cloudflare:workers';",
    },
    "cloudflare-runtime-boundary",
  ],
  [
    "unknown Cloudflare module",
    {
      "apps/ledger-service/package.json": JSON.stringify({ name: "@rastrata/ledger-service" }),
      "apps/ledger-service/src/index.ts": "export { DurableObject } from 'cloudflare:worker';",
    },
    "no-unresolved",
  ],
  [
    "crypto outside canonical hashing",
    { "packages/kernel/src/index.ts": "export { createHash } from 'node:crypto';" },
    "kernel-crypto-boundary",
  ],
  [
    "private relative import",
    { "packages/ledger/src/index.ts": "export { secret } from '../../kernel/src/private.ts';" },
    "public-api-@rastrata/kernel",
  ],
  [
    "private package subpath",
    { "packages/ledger/src/index.ts": "export { secret } from '@rastrata/kernel/src/private.ts';" },
    "no-unresolved",
  ],
  [
    "kernel runtime dependency",
    { "packages/kernel/src/index.ts": "import fs from 'node:fs'; export { fs };" },
    "kernel-isolation",
  ],
  [
    "kernel type dependency",
    {
      "packages/kernel/src/index.ts":
        "import type { X } from '../../ledger/src/types.ts'; export type Y = X;",
      "packages/ledger/src/types.ts": "export type X = string;",
    },
    "kernel-isolation",
  ],
  [
    "application import",
    { "packages/ledger/src/index.ts": "export * from '../../../apps/server/src/index.ts';" },
    "no-app-imports",
  ],
  [
    "research dependency",
    {
      "packages/ledger/src/index.ts": "export * from '../../../references/sample/index.ts';",
      "references/sample/index.ts": "export const x = 1;",
    },
    "no-research-imports",
  ],
  [
    "production test dependency",
    {
      "packages/ledger/src/index.ts": "export * from '../test/fixture.ts';",
      "packages/ledger/test/fixture.ts": "export const x = 1;",
    },
    "no-production-test-imports",
  ],
  [
    "cross-package cycle",
    { "packages/kernel/src/index.ts": "export * from '../../ledger/src/index.ts';" },
    "no-cross-package-cycles",
  ],
  [
    "dynamic private dependency",
    { "packages/ledger/src/index.ts": "export const x = import('../../kernel/src/private.ts');" },
    "public-api-@rastrata/kernel",
  ],
  [
    "require private dependency",
    { "packages/ledger/src/index.ts": "export const x = require('../../kernel/src/private.ts');" },
    "public-api-@rastrata/kernel",
  ],
  [
    "missing dependency",
    { "packages/ledger/src/index.ts": "export * from './missing.ts';" },
    "no-unresolved",
  ],
] as const) {
  test(`boundary rejects ${name}`, () => {
    const result = analyze(files);
    expect(result.exitCode).not.toBe(0);
    expect(result.rules).toContain(rule);
  });
}

test("undeclared workspace dependency fails even if it resolves", () => {
  const result = analyze({}, false);
  expect(result.exitCode).not.toBe(0);
  expect(result.rules).toContain("declared-workspaces-@rastrata/ledger");
});

test("manifest-only cycles fail even when no import closes the cycle", () => {
  const result = analyze({
    "packages/kernel/package.json": JSON.stringify({
      name: "@rastrata/kernel",
      exports: { ".": "./src/index.ts" },
      dependencies: { "@rastrata/ledger": "workspace:*" },
    }),
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.rules.join("\n")).toContain("Workspace dependency cycle");
});

test("workspace dependencies must use the workspace protocol", () => {
  const result = analyze({
    "packages/ledger/package.json": JSON.stringify({
      name: "@rastrata/ledger",
      exports: { ".": "./src/index.ts" },
      dependencies: { "@rastrata/kernel": "*" },
    }),
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.rules.join("\n")).toContain("Use workspace:");
});

test("an unscanned TypeScript extension cannot produce a green gate", () => {
  // The gate deliberately supports .ts/.tsx, not .mts. Installing a tool that
  // expands parser discovery must not silently expand this verified contract.
  const result = analyze({ "packages/ledger/src/unsupported.mts": "export const x = 1;" });
  expect(result.exitCode).not.toBe(0);
});

test("TSX is parsed and included in the dependency graph", () => {
  expect(
    analyze({
      "apps/web/package.json": JSON.stringify({ name: "@rastrata/web" }),
      "apps/web/src/main.tsx": "export const App = () => <main>Ready</main>;",
    }).exitCode,
  ).toBe(0);
});

for (const [name, source, extra] of [
  [
    "ledger",
    "import { amount } from '@rastrata/ledger'; export const App = () => <main>{amount}</main>;",
    {},
  ],
  [
    "kernel",
    "import { amount } from '@rastrata/kernel'; export const App = () => <main>{amount}</main>;",
    {},
  ],
  [
    "builtin",
    "import { readFileSync } from 'node:fs'; export const App = () => <main>{readFileSync('x','utf8')}</main>;",
    {},
  ],
  [
    "tooling",
    "import { secret } from '../tooling/private'; export const App = () => <main>{secret}</main>;",
    { "apps/web/tooling/private.ts": "export const secret = 1;" },
  ],
] as const) {
  test(`browser TSX cannot import ${name}`, () => {
    const result = analyze({
      "apps/web/package.json": JSON.stringify({
        name: "@rastrata/web",
        dependencies: { "@rastrata/kernel": "workspace:*", "@rastrata/ledger": "workspace:*" },
      }),
      "apps/web/src/main.tsx": source,
      ...extra,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.rules).toContain(
      name === "builtin" ? "web-no-runtime-builtins" : "web-browser-boundary",
    );
  });
}

test("generated bundles are excluded but their workspace sources remain checked", () => {
  expect(
    analyze({
      "apps/server/dist/storybook/bundle.js": "import './generated-browser-chunk.js';",
    }).exitCode,
  ).toBe(0);
  expect(
    analyze({
      "apps/server/src/unresolved.ts": "import './missing-source.js';",
    }).exitCode,
  ).not.toBe(0);
});

test("UI source cannot import its workshop or server packages", () => {
  for (const source of [
    "export { amount } from '@rastrata/kernel';",
    "export { example } from '../stories/example';",
    "export { readFileSync } from 'node:fs';",
  ]) {
    const result = analyze({
      "packages/ui/package.json": JSON.stringify({
        name: "@rastrata/ui",
        dependencies: { "@rastrata/kernel": "workspace:*" },
      }),
      "packages/ui/src/index.ts": source,
      "packages/ui/stories/example.ts": "export const example = 1;",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.rules.some((rule) => rule.startsWith("ui-"))).toBe(true);
  }
});

test("workspace and task configuration keeps research out and verification uncached", () => {
  const manifest = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"));
  expect(manifest.workspaces).toEqual(["apps/*", "packages/*"]);
  const config = JSON.parse(readFileSync(join(repository, "turbo.json"), "utf8"));
  for (const task of Object.values(config.tasks) as { cache: boolean }[])
    expect(task.cache).toBe(false);
  expect(manifest.scripts["check:release"]).toBe(
    "bun run check && bun run --cwd packages/ledger check:release && bun run --cwd packages/kernel check:release",
  );
  const ledger = JSON.parse(readFileSync(join(repository, "packages/ledger/package.json"), "utf8"));
  expect(ledger.scripts["check:release"]).toBe(
    "bun run check:syside && bun run check:native-workflow",
  );
  expect(ledger.scripts["check:native-workflow"]).toBe("bun scripts/check-native-workflow.ts");
  const kernel = JSON.parse(readFileSync(join(repository, "packages/kernel/package.json"), "utf8"));
  // Frozen fixtures expect repository-root paths. Explicit directories also
  // prevent Bun's bare "test" filename filter from selecting the slow suite.
  expect(kernel.scripts.test).toBe(
    "bun test --cwd ../.. ./packages/kernel/test && bun run test:tooling",
  );
  expect(kernel.scripts["test:slow"]).toBe("bun test --cwd ../.. ./packages/kernel/slow");
  expect(kernel.scripts["check:release"]).toContain("mutation:check");
  expect(kernel.scripts["check:release"]).toContain("check:syside");
  for (const name of [
    "check:trace",
    "coverage:check",
    "mutation:check",
    "mutation:self-test",
    "test:coverage",
  ]) {
    expect(manifest.scripts[name]).toBe(`bun run --cwd packages/kernel ${name}`);
    expect(typeof kernel.scripts[name]).toBe("string");
  }
  expect(manifest.scripts["check:spec"]).toBe(
    "bun run --cwd packages/kernel check:spec && bun run --cwd packages/ledger check:spec",
  );
  expect(manifest.scripts["check:syside"]).toBe(
    "bun run --cwd packages/kernel check:syside && bun run --cwd packages/ledger check:syside",
  );
});

for (const folder of ["spec", "scripts", "spec/research"]) {
  test(`production code cannot import colocated ${folder}`, () => {
    const result = analyze({
      "packages/ledger/src/index.ts": `export * from '../${folder}/support.ts';`,
      [`packages/ledger/${folder}/support.ts`]: "export const support = 1;",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.rules).toContain("no-production-test-imports");
  });
}

test("Astro files are inventoried by the repository boundary gate", () => {
  const result = analyze({
    "apps/marketing/package.json": JSON.stringify({ name: "@rastrata/marketing" }),
    "apps/marketing/src/pages/index.astro": '---\nimport fs from "node:fs";\n---\n<p />',
  });
  expect(result.exitCode).not.toBe(0);
});

for (const dependency of ["node:fs", "@rastrata/kernel", "@rastrata/ledger"]) {
  test(`site TSX rejects ${dependency}`, () => {
    const result = analyze({
      "apps/marketing/package.json": JSON.stringify({
        name: "@rastrata/marketing",
        dependencies: { "@rastrata/kernel": "workspace:*", "@rastrata/ledger": "workspace:*" },
      }),
      "apps/marketing/src/islands/probe.tsx": `import * as dependency from "${dependency}"; export const Probe = () => <p>{String(dependency)}</p>;`,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.rules).toContain(
      dependency === "node:fs"
        ? "site-no-runtime-or-development-dependencies"
        : "site-browser-boundary",
    );
  });
}

test("Astro generated types are excluded while real Astro source stays checked", () => {
  expect(
    analyze({
      "apps/marketing/package.json": JSON.stringify({ name: "@rastrata/marketing" }),
      "apps/marketing/.astro/types.d.ts": 'import "./generated-missing.js";',
      "apps/marketing/src/pages/index.astro": "<p>Static page</p>",
    }).exitCode,
  ).toBe(0);
});

test("site TypeScript cannot import application UI even if explicitly declared", () => {
  const result = analyze({
    "packages/ui/package.json": JSON.stringify({
      name: "@rastrata/ui",
      exports: { ".": "./src/index.ts" },
    }),
    "packages/ui/src/index.ts": "export const component = true;",
    "apps/marketing/package.json": JSON.stringify({
      name: "@rastrata/marketing",
      dependencies: { "@rastrata/ui": "workspace:*" },
    }),
    "apps/marketing/src/probe.ts": 'export { component } from "../../../packages/ui/src/index.ts";',
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.rules).toContain("site-browser-boundary");
});

// A scratch file that is not in git (a developer's script, an agent's experiment) is not part of the
// repository: it must not be able to fail a landing. Only what git tracks or has staged is checked.
const scratch = {
  // Reaches into another package's private file: a violation wherever it is scanned.
  "apps/server/src/scratch.ts": "export { secret } from '../../../packages/kernel/src/private.ts';",
};
function git(root: string, ...args: string[]) {
  const run = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}
const track = (root: string, ...paths: string[]) => {
  git(root, "init", "-q");
  git(root, "add", "--", "apps/server/package.json", "packages", ...paths);
};

test("a file that git does not know cannot fail the boundary gate, a staged one can", () => {
  // Untracked: the gate passes, though the scratch file breaks a rule.
  expect(analyze(scratch, true, (root) => track(root)).exitCode).toBe(0);
  // Staged (not committed): it is the repository's now, and the gate fails on it.
  expect(analyze(scratch, true, (root) => track(root, "apps/server/src")).exitCode).not.toBe(0);
});

test("a file git ignores cannot fail the boundary gate either", () => {
  const ignored = { ...scratch, ".gitignore": "scratch.ts\n" };
  expect(
    analyze(ignored, true, (root) => track(root, "apps/server/src", ".gitignore")).exitCode,
  ).toBe(0);
});

test("a tracked file that is gone from the disk does not break the gate", () => {
  expect(
    analyze({ "apps/server/src/gone.ts": "export const gone = 1;" }, true, (root) => {
      track(root, "apps/server/src");
      rmSync(join(root, "apps/server/src/gone.ts"));
    }).exitCode,
  ).toBe(0);
});

test("outside a git checkout every file on disk is checked, as before", () => {
  expect(analyze(scratch).exitCode).not.toBe(0);
});

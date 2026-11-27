import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

function check(command: "lint" | "format", source: string, path: string) {
  const fixture = mkdtempSync(join(tmpdir(), "rastrata-biome-test-"));
  try {
    copyFileSync(join(root, "biome.json"), join(fixture, "biome.json"));
    mkdirSync(dirname(join(fixture, path)), { recursive: true });
    writeFileSync(join(fixture, path), source);
    return Bun.spawnSync(
      [
        resolve(root, "node_modules/.bin/biome"),
        command,
        path,
        "--vcs-enabled=false",
        "--error-on-warnings",
      ],
      { cwd: fixture, stdout: "pipe", stderr: "pipe" },
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

for (const path of [
  "apps/server/src/probe.ts",
  "packages/ledger/src/probe.ts",
  "scripts/probe.ts",
]) {
  test(`Biome enforces lint and formatting for ${path}`, () => {
    const valid = "export const amount = 1;\n";
    expect(check("lint", valid, path).exitCode).toBe(0);
    expect(check("format", valid, path).exitCode).toBe(0);
    const lint = check("lint", "debugger;\n", path);
    expect(lint.exitCode).not.toBe(0);
    expect(lint.stderr.toString()).toContain("noDebugger");
    const format = check("format", "export const amount=1", path);
    expect(format.exitCode).not.toBe(0);
    expect(format.stderr.toString()).toContain("format");
  });
}

test("Biome checks Astro frontmatter and template formatting", () => {
  const path = "apps/marketing/src/pages/probe.astro";
  const lint = check("lint", "---\ndebugger;\n---\n<p>Example</p>\n", path);
  expect(lint.exitCode).not.toBe(0);
  expect(lint.stderr.toString()).toContain("noDebugger");
  const format = check("format", "<main><p>Example</p><p>More</p></main>", path);
  expect(format.exitCode).not.toBe(0);
  expect(format.stderr.toString()).toContain("format");
  expect(check("lint", '<img src="/example.png" />', path).exitCode).not.toBe(0);
});

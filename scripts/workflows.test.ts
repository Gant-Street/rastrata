import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Supply-chain guardrails for every GitHub Actions workflow in the repository.
 * Prevents the exact TeamPCP / Trivy / tj-actions kill chain: untrusted `pull_request_target`
 * execution, mutable action version tags, leaked checkout tokens, and over-broad `GITHUB_TOKEN`
 * permissions. */
const ROOT = resolve(import.meta.dir, "..");
const WORKFLOWS_DIR = join(ROOT, ".github/workflows");

function workflowFiles(): { name: string; content: string }[] {
  if (!existsSync(WORKFLOWS_DIR)) return [];
  return readdirSync(WORKFLOWS_DIR)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .map((name) => ({
      name,
      content: readFileSync(join(WORKFLOWS_DIR, name), "utf8"),
    }));
}

const SHA_PIN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}$/;

test("workflows never use pull_request_target", () => {
  const files = workflowFiles();
  expect(files.length).toBeGreaterThan(0);
  for (const { name, content } of files) {
    const stripped = content.replace(/#.*$/gm, "");
    expect(stripped, `${name} must never use pull_request_target`).not.toMatch(
      /\bpull_request_target\b/,
    );
  }
});

test("every GitHub Action is pinned to a full 40-character commit SHA", () => {
  const unpinned: string[] = [];
  for (const { name, content } of workflowFiles()) {
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const match = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/.exec(lines[index] ?? "");
      if (!match?.[1]) continue;
      const ref = match[1].replace(/^['"]|['"]$/g, "");
      // Local composite actions (./...) and digest-pinned docker images (docker://...@sha256:...) are allowed.
      if (ref.startsWith("./") || /^docker:\/\/.+@sha256:[0-9a-f]{64}$/.test(ref)) continue;
      if (!SHA_PIN.test(ref)) {
        unpinned.push(`${name}:${index + 1} uses unpinned action "${ref}"`);
      }
    }
  }
  expect(unpinned).toEqual([]);
});

test("every actions/checkout disables credential persistence unless pushing via explicit ssh-key", () => {
  const problems: string[] = [];
  for (const { name, content } of workflowFiles()) {
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const checkout = /^(\s*)-\s*uses:\s*actions\/checkout@/.exec(line);
      if (!checkout) continue;
      const stepIndent = checkout[1]?.length ?? 0;
      const blockLines: string[] = [];
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const next = lines[cursor] ?? "";
        if (next.trim() === "" || next.trim().startsWith("#")) continue;
        const nextIndent = next.length - next.trimStart().length;
        if (nextIndent <= stepIndent) break;
        blockLines.push(next);
      }
      const block = blockLines.join("\n");
      const hasPersistFalse = /\bpersist-credentials:\s*false\b/.test(block);
      const hasExplicitSshKey = /\bssh-key:\s*\S+/.test(block);
      if (!hasPersistFalse && !hasExplicitSshKey) {
        problems.push(
          `${name}:${index + 1} actions/checkout is missing persist-credentials: false`,
        );
      }
    }
  }
  expect(problems).toEqual([]);
});

test("every workflow declares explicit least-privilege permissions and never uses write-all", () => {
  for (const { name, content } of workflowFiles()) {
    const stripped = content.replace(/#.*$/gm, "");
    expect(stripped, `${name} must declare top-level permissions`).toMatch(/^permissions:/m);
    expect(stripped, `${name} must never grant write-all`).not.toMatch(
      /permissions:\s*write-all\b/,
    );
  }
});

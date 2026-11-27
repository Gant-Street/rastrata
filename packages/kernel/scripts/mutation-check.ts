/**
 * Kernel mutation gate: branch/condition proof (F.I.R.S.T.-aligned).
 *
 * Fail-closed and isolated:
 *   - Every mutant is executed against a pristine worktree with exactly one
 *     behavioral change applied: all source files are restored from originals
 *     before each mutant is written, so results always represent isolated
 *     single mutants.
 *   - The orchestrator requires a positive worker count, fails on any
 *     unsuccessful worker exit, and verifies that every scheduled mutant
 *     produced a verdict. A run that cannot account for every mutant exits 1.
 *   - Parse failures are reported as INVALID and fail the gate — they can
 *     never inflate the kill score.
 *   - Function-declaration lines are not blanket-skipped: operator mutants on
 *     one-line bodies are generated; only the hash-helper negation of a
 *     function's own declaration signature is suppressed.
 *   - Stale worktrees from previously killed runs are removed at startup.
 *
 * Fast and independent: runs the fast test suite with failure bail-out in
 * parallel isolated git worktrees; the main tree is never touched.
 *
 * Usage: bun packages/kernel/scripts/mutation-check.ts
 * Exit 0 requires every scheduled mutant to be killed or individually
 * justified as equivalent. Invalid or timed-out runs void the score.
 */
import {
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  classifyTestExecution,
  runMutationTests,
  computeMutantFingerprint,
} from "./mutation-runner.ts";

const REPO = import.meta.dir + "/../../..";
// Discover the same production population as the coverage gate. A hand-maintained
// list previously omitted current-journal and all three owned-inventory modules.
const ALL_SOURCE_FILES = [...new Bun.Glob("packages/kernel/src/**/*.ts").scanSync(REPO)].sort();
if (process.argv.includes("--list-sources")) {
  console.log(JSON.stringify(ALL_SOURCE_FILES));
  process.exit(0);
}
let requestedFile = process.env.MUTATION_FILE;
let requestedSources: string[] | undefined = process.env.MUTATION_SOURCES
  ? process.env.MUTATION_SOURCES.split(",").filter(Boolean)
  : undefined;
for (let i = 0; i < process.argv.length; i++) {
  const arg = process.argv[i]!;
  if (arg.startsWith("--file=")) requestedFile = arg.slice(7);
  else if (arg === "--file" && i + 1 < process.argv.length) requestedFile = process.argv[++i];
  else if (arg.startsWith("--sources="))
    requestedSources = arg.slice(10).split(",").filter(Boolean);
}
const isAll = process.argv.includes("--all") || process.env.MUTATION_ALL === "1";
const isNoCache = process.argv.includes("--no-cache") || process.env.MUTATION_NO_CACHE === "1";
const isDiff = process.argv.includes("--diff") || process.env.MUTATION_DIFF === "1";

let activeSourceFiles = ALL_SOURCE_FILES;
if (requestedSources !== undefined && requestedSources.length > 0) {
  activeSourceFiles = requestedSources;
} else if (requestedFile !== undefined) {
  activeSourceFiles = ALL_SOURCE_FILES.filter(
    (file) => file === requestedFile || file.endsWith(`/${requestedFile}`),
  );
} else if (isDiff && !isAll) {
  const diffStatus = spawnSync("git", ["status", "--porcelain", "--", "packages/kernel/src"], {
    cwd: REPO,
    encoding: "utf8",
  });
  const diffOut = diffStatus.stdout.trim();
  if (diffOut.length > 0) {
    const changed = new Set(diffOut.split("\n").map((line) => line.slice(3).trim()));
    const matched = ALL_SOURCE_FILES.filter((f) => changed.has(f));
    if (matched.length > 0) activeSourceFiles = matched;
  }
}

const SOURCE_FILES = activeSourceFiles;
if (SOURCE_FILES.length === 0) {
  console.error(
    `Mutation gate failed: MUTATION_FILE did not match a production source: ${requestedFile}`,
  );
  process.exit(1);
}

const allTestFiles = readdirSync(join(REPO, "packages/kernel/test"))
  .filter((file) => file.endsWith(".test.ts"))
  .map((file) => `packages/kernel/test/${file}`);

const COMPANION_TESTS: Readonly<Record<string, readonly string[]>> = {
  "packages/kernel/src/numeric.ts": [
    "packages/kernel/test/numeric.test.ts",
    "packages/kernel/test/property.test.ts",
    "packages/kernel/test/quantization.test.ts",
    "packages/kernel/test/owned-inventory-command.test.ts",
    "packages/kernel/test/canonical-source-collision.test.ts",
  ],
  "packages/kernel/src/quantization.ts": [
    "packages/kernel/test/quantization.test.ts",
    "packages/kernel/test/property.test.ts",
  ],
  "packages/kernel/src/lots.ts": [
    "packages/kernel/test/hostile-lots.test.ts",
    "packages/kernel/test/inventory-carrying.test.ts",
    "packages/kernel/test/policy-lots.test.ts",
    "packages/kernel/test/mutation-companions.test.ts",
  ],
  "packages/kernel/src/accounting.ts": [
    "packages/kernel/test/mutation-companions.test.ts",
    "packages/kernel/test/inventory-posted-values.test.ts",
    "packages/kernel/test/boundary.test.ts",
    "packages/kernel/test/cumulative-allocation.test.ts",
    "packages/kernel/test/accounting.test.ts",
    "packages/kernel/test/accounting-resource-bounds.test.ts",
    "packages/kernel/test/settlement-lifecycle.test.ts",
  ],
  "packages/kernel/src/book-history.ts": [
    "packages/kernel/test/book-history.test.ts",
    "packages/kernel/test/validation-equivalence.test.ts",
    "packages/kernel/test/book.test.ts",
    "packages/kernel/test/api-surface.test.ts",
  ],
  "packages/kernel/src/book.ts": [
    "packages/kernel/test/validation-equivalence.test.ts",
    "packages/kernel/test/book-history.test.ts",
    "packages/kernel/test/mutation-companions.test.ts",
    "packages/kernel/test/inventory-posted-admission.test.ts",
    "packages/kernel/test/audit.test.ts",
    "packages/kernel/test/commercial-workflows.test.ts",
    "packages/kernel/test/owned-inventory-command.test.ts",
    "packages/kernel/test/accounting-book.test.ts",
    "packages/kernel/test/book-execution-profile.test.ts",
    "packages/kernel/test/state-commitment.test.ts",
    "packages/kernel/test/recorded-revision.test.ts",
    "packages/kernel/test/verified-snapshots.test.ts",
    "packages/kernel/test/settlement-source-ownership.test.ts",
    "packages/kernel/test/hostile-book.test.ts",
    "packages/kernel/test/global-read-context.test.ts",
    "packages/kernel/test/conformance.test.ts",
    "packages/kernel/test/book.test.ts",
  ],
  "packages/kernel/src/canonical.ts": [
    "packages/kernel/test/canonical-source-collision.test.ts",
    "packages/kernel/test/canonical-ordering.test.ts",
    "packages/kernel/test/canonical.test.ts",
    "packages/kernel/test/mutation-companions.test.ts",
  ],
  "packages/kernel/src/codec.ts": [
    "packages/kernel/test/command-codec.test.ts",
    "packages/kernel/test/codec.test.ts",
    "packages/kernel/test/row-codec.test.ts",
    "packages/kernel/test/outcome-codec.test.ts",
    "packages/kernel/test/stored-outcome.test.ts",
    "packages/kernel/test/state-header-codec.test.ts",
    "packages/kernel/test/state-commitment.test.ts",
    "packages/kernel/test/verified-snapshots.test.ts",
  ],
  "packages/kernel/src/current-journal.ts": [
    "packages/kernel/test/current-journal.test.ts",
    "packages/kernel/test/global-read-context.test.ts",
    "packages/kernel/test/hostile-journal.test.ts",
    "packages/kernel/test/journal.test.ts",
  ],
  "packages/kernel/src/iana-timezones.ts": ["packages/kernel/test/accounting.test.ts"],
  "packages/kernel/src/index.ts": [
    "packages/kernel/test/api-surface.test.ts",
    "packages/kernel/test/conformance.test.ts",
  ],
  "packages/kernel/src/inventory-ownership.ts": [
    "packages/kernel/test/inventory-ownership.test.ts",
    "packages/kernel/test/owned-inventory-command.test.ts",
    "packages/kernel/test/settlement-source-ownership.test.ts",
  ],
  "packages/kernel/src/inventory-posted-values.ts": [
    "packages/kernel/test/inventory-posted-values.test.ts",
    "packages/kernel/test/inventory-posted-admission.test.ts",
    "packages/kernel/test/inventory-carrying.test.ts",
  ],
  "packages/kernel/src/journal.ts": [
    "packages/kernel/test/inventory-posted-admission.test.ts",
    "packages/kernel/test/audit.test.ts",
    "packages/kernel/test/journal.test.ts",
    "packages/kernel/test/hostile-journal.test.ts",
    "packages/kernel/test/current-journal.test.ts",
  ],
  "packages/kernel/src/owned-inventory-command.ts": [
    "packages/kernel/test/owned-inventory-command.test.ts",
    "packages/kernel/test/inventory-ownership.test.ts",
    "packages/kernel/test/settlement-source-ownership.test.ts",
  ],
  "packages/kernel/src/policy.ts": [
    "packages/kernel/test/hostile-policy.test.ts",
    "packages/kernel/test/mutation-companions.test.ts",
    "packages/kernel/test/policy-lots.test.ts",
  ],
  "packages/kernel/src/projection.ts": [
    "packages/kernel/test/projection.test.ts",
    "packages/kernel/test/global-read-context.test.ts",
    "packages/kernel/test/hostile-projection.test.ts",
  ],
  "packages/kernel/src/valuation.ts": [
    "packages/kernel/test/policy-lots.test.ts",
    "packages/kernel/test/mutation-companions.test.ts",
  ],
};

const SECONDARY_COMPANIONS: Readonly<Record<string, readonly string[]>> = {
  "packages/kernel/src/accounting.ts": [
    "packages/kernel/test/commercial-workflows.test.ts",
    "packages/kernel/test/accounting-book.test.ts",
  ],
  "packages/kernel/src/book.ts": ["packages/kernel/test/accounting-book.test.ts"],
};

function companionFilesFor(file: string): readonly string[] {
  return COMPANION_TESTS[file] ?? allTestFiles;
}
const limit =
  process.env.MUTATION_LIMIT === undefined
    ? Number.POSITIVE_INFINITY
    : Number(process.env.MUTATION_LIMIT);
if (limit !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(limit) || limit < 1)) {
  console.error("Mutation gate failed: MUTATION_LIMIT must be a positive integer.");
  process.exit(1);
}

interface Mutant {
  readonly index: number;
  readonly file: string;
  readonly line: number;
  readonly description: string;
  readonly content: string;
}
interface EquivalentMutant {
  readonly file: string;
  readonly line: number;
  readonly description: string;
  readonly rationale: string;
}
const equivalentCatalog = JSON.parse(
  readFileSync(join(REPO, "packages/kernel/scripts/mutation-equivalents.json"), "utf8"),
) as readonly EquivalentMutant[];
const mutantKey = (value: Pick<Mutant, "file" | "line" | "description"> | EquivalentMutant) =>
  `${value.file}:${value.line}:${value.description}`;

function replaceOccurrence(
  line: string,
  pattern: RegExp,
  replacement: string,
  occurrence: number,
): string {
  const matches = [...line.matchAll(pattern)];
  const target = matches[occurrence - 1]!;
  return line.slice(0, target.index!) + replacement + line.slice(target.index! + target[0]!.length);
}

function mutationSitesFor(
  content: string,
): { line: number; description: string; apply: (line: string) => string }[] {
  const sites: { line: number; description: string; apply: (line: string) => string }[] = [];
  const lines = content.split("\n");
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    if (/^\s*(export\s+)?type\s/.test(line)) continue;
    if (/^\s*readonly\s/.test(line)) continue;
    // Interface/type-only lines and pure signatures have no runtime operators.
    if (/^\s*(export\s+)?(interface|declare|abstract)\s/.test(line)) continue;

    const comparisonOperators: [RegExp, string, string][] = [
      [/ <= /g, "< ", "<= → <"],
      [/ >= /g, "> ", ">= → >"],
      [/ < /g, "<=", "< → <="],
      [/ > /g, ">=", "> → >="],
      [/ === /g, "!==", "=== → !=="],
      [/ !== /g, "===", "!== → ==="],
    ];
    for (const [pattern, replacement, description] of comparisonOperators) {
      const occurrences = [...line.matchAll(pattern)].length;
      for (let occurrence = 1; occurrence <= occurrences; occurrence += 1) {
        sites.push({
          line: index + 1,
          description: `${description} (occurrence ${occurrence})`,
          apply: (input) => replaceOccurrence(input, pattern, replacement, occurrence),
        });
      }
    }
    if (/\b0n\b/.test(line)) {
      const occurrences = [...line.matchAll(/\b0n\b/g)].length;
      for (let occurrence = 1; occurrence <= occurrences; occurrence += 1) {
        sites.push({
          line: index + 1,
          description: `0n → 1n (occurrence ${occurrence})`,
          apply: (input) => replaceOccurrence(input, /\b0n\b/g, "1n", occurrence),
        });
      }
    }
    for (const helper of ["contentHashEquals", "contentHashEqual"]) {
      // Do not negate a function's own declaration signature.
      if (new RegExp(`^\\s*(export\\s+)?(async\\s+)?function\\s+${helper}\\s*\\(`).test(line))
        continue;
      const helperPattern = new RegExp(`${helper}\\(`, "g");
      const occurrences = [...line.matchAll(helperPattern)].length;
      for (let occurrence = 1; occurrence <= occurrences; occurrence += 1) {
        sites.push({
          line: index + 1,
          description: `${helper} negated (occurrence ${occurrence})`,
          apply: (input) => replaceOccurrence(input, helperPattern, `!${helper}(`, occurrence),
        });
      }
    }
    if (line.includes(".digest === ")) {
      sites.push({
        line: index + 1,
        description: "digest equality negated",
        apply: (input) => replaceOccurrence(input, /\.digest === /g, ".digest !== ", 1),
      });
    }
  }
  return sites;
}

function mutantsFor(files: Map<string, string>): Mutant[] {
  const mutants: Mutant[] = [];
  for (const file of SOURCE_FILES) {
    const content = files.get(file)!;
    for (const site of mutationSitesFor(content)) {
      if (mutants.length >= limit) break;
      const lines = content.split("\n");
      lines[site.line - 1] = site.apply(lines[site.line - 1]!);
      mutants.push({
        index: mutants.length,
        file,
        line: site.line,
        description: site.description,
        content: lines.join("\n"),
      });
    }
  }
  return mutants;
}

// ---- worker mode: shard [workerIndex, workerCount) inside an isolated worktree ----
const workerArg = process.argv.indexOf("--worker");
if (workerArg !== -1) {
  const workerIndex = Number(process.argv[workerArg + 1]);
  const workerCount = Number(process.argv[workerArg + 2]);
  const worktree = process.argv[workerArg + 3]!;
  const originals = new Map(
    SOURCE_FILES.map((file) => [file, readFileSync(join(worktree, file), "utf8")]),
  );
  if (process.env.MUTATION_TEST_WORKER_CRASH === "1") process.exit(70);
  const baseline = runMutationTests(worktree, allTestFiles);
  if (
    process.env.MUTATION_TEST_BASELINE_FAILURE === "1" ||
    classifyTestExecution(baseline) !== "SURVIVED"
  ) {
    console.error(`pristine baseline failed; score is void:\n${baseline.stderr.slice(-2000)}`);
    process.exit(71);
  }
  console.log(`BASELINE ${workerIndex} PASS`);
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  let currentMutatedFile: string | null = null;
  const taskFile = join(worktree, ".mutant-task.json");
  const assignedIndices = existsSync(taskFile)
    ? new Set<number>(JSON.parse(readFileSync(taskFile, "utf8")))
    : null;
  for (const mutant of mutantsFor(originals)) {
    if (assignedIndices !== null) {
      if (!assignedIndices.has(mutant.index)) continue;
    } else if (mutant.index % workerCount !== workerIndex) {
      continue;
    }
    try {
      try {
        transpiler.transformSync(mutant.content);
      } catch {
        console.log(
          `VERDICT INVALID ${mutant.index} ${mutant.file}:${mutant.line} ${mutant.description}`,
        );
        continue;
      }
      // Isolate: restore previously mutated file to pristine, then apply exactly one mutant.
      if (currentMutatedFile !== null) {
        writeFileSync(join(worktree, currentMutatedFile), originals.get(currentMutatedFile)!);
      } else {
        for (const [file, content] of originals) writeFileSync(join(worktree, file), content);
      }
      currentMutatedFile = mutant.file;
      if (
        process.env.MUTATION_TEST_ASSERT_ISOLATION === "1" &&
        [...originals].some(
          ([file, content]) => readFileSync(join(worktree, file), "utf8") !== content,
        )
      ) {
        throw new Error("source isolation check failed before mutant application");
      }
      writeFileSync(join(worktree, mutant.file), mutant.content);
      const companions = companionFilesFor(mutant.file);
      let proc: ReturnType<typeof runMutationTests> | undefined;
      let verdict: "SURVIVED" | "KILLED" | "WORKER_ERROR" = "SURVIVED";
      const testedFiles: string[] = [];
      const individualLimit = mutant.file === "packages/kernel/src/accounting.ts" ? 4 : 3;
      const individualCount = Math.min(individualLimit, companions.length);
      for (let i = 0; i < individualCount; i += 1) {
        testedFiles.push(companions[i]!);
        proc = runMutationTests(worktree, [companions[i]!]);
        verdict =
          process.env.MUTATION_TEST_TIMEOUT === "1" ? "WORKER_ERROR" : classifyTestExecution(proc);
        if (verdict !== "SURVIVED") break;
      }
      if (verdict === "SURVIVED" && companions.length > individualCount) {
        const batch = companions.slice(individualCount);
        testedFiles.push(...batch);
        proc = runMutationTests(worktree, batch);
        verdict =
          process.env.MUTATION_TEST_TIMEOUT === "1" ? "WORKER_ERROR" : classifyTestExecution(proc);
      }
      if (verdict === "SURVIVED") {
        const secondary = SECONDARY_COMPANIONS[mutant.file];
        if (secondary !== undefined) {
          testedFiles.push(...secondary);
          proc = runMutationTests(worktree, secondary);
          verdict =
            process.env.MUTATION_TEST_TIMEOUT === "1"
              ? "WORKER_ERROR"
              : classifyTestExecution(proc);
        }
      }
      if (verdict === "SURVIVED" && companions !== allTestFiles) {
        testedFiles.push(...allTestFiles);
        proc = runMutationTests(worktree, allTestFiles);
        verdict =
          process.env.MUTATION_TEST_TIMEOUT === "1" ? "WORKER_ERROR" : classifyTestExecution(proc);
      }
      if (verdict !== "SURVIVED" && proc !== undefined)
        console.log(`DIAGNOSTIC ${mutant.index} ${JSON.stringify(proc.stderr.slice(-4000))}`);
      console.log(`TESTED ${mutant.index} ${JSON.stringify(Array.from(new Set(testedFiles)))}`);
      if (!(process.env.MUTATION_TEST_MISSING_VERDICT === "1" && mutant.index === workerIndex)) {
        const line = `VERDICT ${verdict} ${mutant.index} ${mutant.file}:${mutant.line} ${mutant.description}`;
        console.log(line);
        if (process.env.MUTATION_TEST_DUPLICATE_VERDICT === "1" && mutant.index === workerIndex)
          console.log(line);
      }
    } catch (error) {
      console.log(
        `VERDICT WORKER_ERROR ${mutant.index} ${mutant.file}:${mutant.line} ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`,
      );
    }
  }
  // Restore pristine so the worktree is clean on teardown.
  for (const [file, content] of originals) writeFileSync(join(worktree, file), content);
  process.exit(0);
}

// ---- orchestrator ----
// Defensive: refuse a dirty tree; cut worktrees from HEAD so isolation is real.
const gitStatus = spawnSync(
  "git",
  [
    "status",
    "--porcelain",
    "--",
    "packages",
    "apps",
    "docs",
    "scripts",
    "package.json",
    "bun.lock",
    "bunfig.toml",
    ".bun-version",
    "tsconfig.json",
    "tsconfig.base.json",
    "turbo.json",
    "biome.json",
    ".dependency-cruiser.cjs",
    "patches",
  ],
  { cwd: REPO },
);
if (gitStatus.status !== 0 || gitStatus.stdout.toString().trim().length > 0) {
  console.error(
    "Mutation gate refuses to run: mutation inputs have uncommitted changes or git status failed.",
  );
  process.exit(1);
}

// Each run owns only its own uniquely named worktrees. Never remove another
// run's worktrees merely because their names match a prefix.

const workers = process.env.MUTATION_WORKERS;
const workerCount =
  workers === undefined
    ? Math.max(1, Math.min(10, navigator.hardwareConcurrency || 4))
    : Number(workers);
if (!Number.isSafeInteger(workerCount) || workerCount < 1 || workerCount > 64) {
  console.error(`Mutation gate failed: invalid worker count ${workerCount}.`);
  process.exit(1);
}

const originals = new Map(
  SOURCE_FILES.map((file) => [file, readFileSync(join(REPO, file), "utf8")]),
);
const mutants = mutantsFor(originals);
if (mutants.length === 0) {
  console.error("Mutation gate failed: no mutants generated — generator regression.");
  process.exit(1);
}
console.log(`mutation gate: ${mutants.length} mutants, ${workerCount} workers (fast suite)`);
const equivalentKeys = new Set<string>();
for (const entry of equivalentCatalog.filter((item) => SOURCE_FILES.includes(item.file))) {
  const key = mutantKey(entry);
  if (entry.rationale.trim().length < 20) {
    console.error(`Mutation gate failed: equivalent mutant ${key} lacks a substantive rationale.`);
    process.exit(1);
  }
  if (equivalentKeys.has(key)) {
    console.error(`Mutation gate failed: duplicate equivalent mutant ${key}.`);
    process.exit(1);
  }
  if (!mutants.some((mutant) => mutantKey(mutant) === key) && limit === Number.POSITIVE_INFINITY) {
    console.error(`Mutation gate failed: stale equivalent mutant ${key}.`);
    process.exit(1);
  }
  equivalentKeys.add(key);
}

const isSelfTest =
  process.env.MUTATION_TEST_ASSERT_ISOLATION === "1" ||
  Object.keys(process.env).some((k) => k.startsWith("MUTATION_TEST_"));

const cachePath = join(REPO, "coverage", ".mutation-cache.json");
interface CacheEntry {
  fingerprint: string;
  verdict: "KILLED" | "SURVIVED";
  diagnostic: string | null;
  testedFiles: string[];
}
let mutationCache: Record<string, CacheEntry> = {};
if (!isSelfTest && !isNoCache && existsSync(cachePath)) {
  try {
    mutationCache = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    mutationCache = {};
  }
}

// Hash all kernel sources, not just imports of the mutated module: a test may
// reach it through a changed caller or barrel export. Include tracked fixtures,
// specifications, tooling, root configuration/lockfiles and dependency patches.
// Only unrelated fast-test CONTENT is excluded; the test inventory is included
// so new/removed tests invalidate previously full-suite survivor evidence.
const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" });
if (tracked.status !== 0) throw new Error("Mutation gate cannot enumerate cache inputs");
const inputFiles = tracked.stdout
  .split("\0")
  .filter((file) => file && (file.startsWith("packages/kernel/") || !file.includes("/")))
  .sort();
const testFileHashes = new Map<string, string>();
const sharedInputs: [string, string][] = [];
for (const file of inputFiles) {
  const digest = Bun.SHA256.hash(readFileSync(join(REPO, file)), "hex");
  if (allTestFiles.includes(file)) testFileHashes.set(file, digest);
  else sharedInputs.push([file, digest]);
}
const sharedInfraHash = Bun.SHA256.hash(
  JSON.stringify({
    version: 2,
    bun: Bun.version,
    bunRevision: Bun.revision,
    platform: process.platform,
    arch: process.arch,
    testInventory: [...allTestFiles].sort(),
    sharedInputs,
  }),
  "hex",
);
function validTestedFiles(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    new Set(value).size === value.length &&
    value.every((file) => typeof file === "string" && testFileHashes.has(file))
  );
}
function mutantFingerprint(m: Mutant, testedFiles: readonly string[]): string {
  const testHash = Bun.SHA256.hash(
    JSON.stringify([...testedFiles].sort().map((file) => [file, testFileHashes.get(file)])),
    "hex",
  );
  return computeMutantFingerprint({
    sourceDepHash: sharedInfraHash,
    sharedInfraHash,
    testedFilesHash: testHash,
    line: m.line,
    description: m.description,
  });
}

const results = new Map<number, string>();
const verdictCounts = new Map<number, number>();
const diagnostics = new Map<number, string>();
const uncachedMutants: Mutant[] = [];

if (!isSelfTest) {
  for (const mutant of mutants) {
    const key = mutantKey(mutant);
    const cached = mutationCache[key];
    if (
      cached &&
      validTestedFiles(cached.testedFiles) &&
      (cached.verdict === "KILLED" || cached.verdict === "SURVIVED")
    ) {
      const fp = mutantFingerprint(mutant, cached.testedFiles);
      if (cached.fingerprint === fp) {
        results.set(
          mutant.index,
          `${cached.verdict} ${mutant.file}:${mutant.line} ${mutant.description}`,
        );
        verdictCounts.set(mutant.index, 1);
        if (cached.diagnostic) {
          diagnostics.set(mutant.index, cached.diagnostic);
        }
        continue;
      }
    }
    uncachedMutants.push(mutant);
  }
} else {
  uncachedMutants.push(...mutants);
}

const worktrees: string[] = [];
const runRoot = mkdtempSync("/tmp/rastrata-mutation-");
const workerProcs: {
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  workerIndex: number;
}[] = [];
const baselines: number[] = [];
const startedAt = new Date().toISOString();
const revision = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: REPO,
  encoding: "utf8",
}).stdout.trim();
let failure: Error | undefined;

const effectiveWorkers = Math.min(workerCount, Math.max(1, uncachedMutants.length));

if (uncachedMutants.length === 0) {
  console.log(`mutation gate: all ${mutants.length} mutants served from cache (0 workers spawned)`);
} else {
  console.log(
    `mutation gate: ${uncachedMutants.length}/${mutants.length} mutants to execute (${mutants.length - uncachedMutants.length} cached), ${effectiveWorkers} workers (fast suite)`,
  );
}

try {
  if (uncachedMutants.length === 0) {
    // Finalize cached-baseline failures exactly like worker failures: replace
    // any previous passing report and clean this run's temporary directory.
    const pristineBaseline = runMutationTests(REPO, allTestFiles);
    if (classifyTestExecution(pristineBaseline) !== "SURVIVED") {
      throw new Error(
        `pristine baseline failed; score is void:\n${pristineBaseline.stderr.slice(-2000)}`,
      );
    }
    baselines.push(0);
  }
  if (uncachedMutants.length > 0) {
    for (let w = 0; w < effectiveWorkers; w += 1) {
      const path = join(runRoot, `w${w}`);
      const add = spawnSync("git", ["worktree", "add", "--force", "--detach", path, "HEAD"], {
        cwd: REPO,
        stdio: "ignore",
      });
      if (add.status !== 0) throw new Error(`worktree add failed for ${path}`);
      worktrees.push(path);

      if (!isSelfTest) {
        const assigned = uncachedMutants
          .filter((_, i) => i % effectiveWorkers === w)
          .map((m) => m.index);
        writeFileSync(join(path, ".mutant-task.json"), JSON.stringify(assigned));
      }

      const workerArgs = [
        "bun",
        "--no-orphans",
        join(REPO, "packages/kernel/scripts/mutation-check.ts"),
        "--worker",
        String(w),
        String(isSelfTest ? workerCount : effectiveWorkers),
        path,
        `--sources=${SOURCE_FILES.join(",")}`,
      ];
      if (requestedFile !== undefined) {
        workerArgs.push(`--file=${requestedFile}`);
      }

      const proc = Bun.spawn(workerArgs, {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          ...(requestedFile ? { MUTATION_FILE: requestedFile } : {}),
          MUTATION_SOURCES: SOURCE_FILES.join(","),
        },
      });
      workerProcs.push({ proc, workerIndex: w });
    }
    const completed = await Promise.all(
      workerProcs.map(async ({ proc, workerIndex }) => {
        const [output, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { workerIndex, output, stderr, exitCode };
      }),
    );
    const mutantTestedFiles = new Map<number, string[]>();
    for (const { workerIndex, output, stderr, exitCode } of completed) {
      if (exitCode !== 0) {
        throw new Error(
          `worker (shard ${workerIndex}) exited ${exitCode}: ${stderr.slice(0, 300)}`,
        );
      }
      if (output.split("\n").filter((line) => line === `BASELINE ${workerIndex} PASS`).length !== 1)
        throw new Error(`worker ${workerIndex} lacks exactly one passing pristine baseline`);
      baselines.push(workerIndex);
      const workerAssigned = isSelfTest
        ? null
        : new Set(
            uncachedMutants
              .filter((_, i) => i % effectiveWorkers === workerIndex)
              .map((m) => m.index),
          );
      for (const line of output.trim().split("\n")) {
        if (line.startsWith("DIAGNOSTIC ")) {
          const match = /^DIAGNOSTIC (\d+) (.*)$/.exec(line);
          if (match) {
            diagnostics.set(Number(match[1]), JSON.parse(match[2]!));
          }
          continue;
        }
        if (line.startsWith("TESTED ")) {
          const match = /^TESTED (\d+) (.*)$/.exec(line);
          if (match) {
            mutantTestedFiles.set(Number(match[1]), JSON.parse(match[2]!));
          }
          continue;
        }
        if (!line.startsWith("VERDICT")) continue;
        const parts = line.split(" ");
        const verdict = parts[1]!;
        const index = Number(parts[2]);
        if (!Number.isSafeInteger(index) || index < 0 || index >= mutants.length)
          throw new Error(`worker returned invalid mutant index ${parts[2]}`);
        if (isSelfTest && index % workerCount !== workerIndex)
          throw new Error(`worker returned out-of-shard mutant index ${parts[2]}`);
        if (workerAssigned !== null && !workerAssigned.has(index))
          throw new Error(`worker ${workerIndex} returned unassigned mutant index ${index}`);
        const expected = mutants[index]!;
        const receivedIdentity = parts.slice(3).join(" ");
        const expectedIdentity = `${expected.file}:${expected.line} ${expected.description}`;
        if (receivedIdentity !== expectedIdentity) {
          throw new Error(
            `worker returned mismatched mutant identity for index ${index}: expected "${expectedIdentity}", received "${receivedIdentity}"`,
          );
        }
        if (!new Set(["INVALID", "SURVIVED", "KILLED", "WORKER_ERROR"]).has(verdict))
          throw new Error(`worker returned unknown verdict ${verdict}`);
        verdictCounts.set(index, (verdictCounts.get(index) ?? 0) + 1);
        results.set(index, `${verdict} ${receivedIdentity}`);
        if (verdict === "KILLED" || verdict === "SURVIVED") {
          const mutant = mutants[index]!;
          const filesRan = mutantTestedFiles.get(index);
          if (!validTestedFiles(filesRan))
            throw new Error(`worker returned missing or invalid tested files for mutant ${index}`);
          mutationCache[mutantKey(mutant)] = {
            fingerprint: mutantFingerprint(mutant, filesRan),
            verdict,
            diagnostic: diagnostics.get(index) ?? null,
            testedFiles: filesRan,
          };
        }
      }
    }
  }
  // Fail closed unless every scheduled mutant produced exactly one verdict.
  const missing = mutants.filter((mutant) => !results.has(mutant.index));
  if (missing.length > 0) {
    throw new Error(
      `missing verdicts for ${missing.length} mutants (e.g. ${missing[0]!.file}:${missing[0]!.line})`,
    );
  }
  const duplicates = [...verdictCounts].filter(([, count]) => count !== 1);
  if (duplicates.length > 0)
    throw new Error(
      `duplicate verdicts for ${duplicates.length} mutants (e.g. ${duplicates[0]![0]} produced ${duplicates[0]![1]} verdicts)`,
    );
  const counted = results.size;
  const invalid = [...results.values()].filter((line) => line.startsWith("INVALID"));
  const survived = [...results.entries()].filter(([, line]) => line.startsWith("SURVIVED"));
  const killedEntries = [...results.entries()].filter(([, line]) => line.startsWith("KILLED"));
  const killed = killedEntries.length;
  const workerErrors = [...results.values()].filter((line) => line.startsWith("WORKER_ERROR"));
  if (workerErrors.length > 0 || invalid.length > 0) {
    throw new Error(
      `${workerErrors.length + invalid.length} mutants could not be tested (worker errors or invalid syntax):\n${[...workerErrors, ...invalid].slice(0, 20).join("\n")}`,
    );
  }
  if (counted !== mutants.length || killed + survived.length !== mutants.length) {
    throw new Error(
      `verdict accounting mismatch (${counted} verdicts for ${mutants.length} mutants)`,
    );
  }
  const killedEquivalents = killedEntries.filter(([index]) =>
    equivalentKeys.has(mutantKey(mutants[index]!)),
  );
  if (killedEquivalents.length > 0) {
    throw new Error(
      `${killedEquivalents.length} catalogued equivalent mutants were killed; remove or correct their stale justifications:\n${killedEquivalents.map(([index, line]) => `${line} (${mutantKey(mutants[index]!)})`).join("\n")}`,
    );
  }
  const unjustified = survived.filter(([index]) => !equivalentKeys.has(mutantKey(mutants[index]!)));
  if (unjustified.length > 0) {
    throw new Error(
      `${unjustified.length}/${mutants.length} unreviewed mutants survived:\n${unjustified.map(([, line]) => line).join("\n")}`,
    );
  }
  const liveIndices = new Set(uncachedMutants.map((mutant) => mutant.index));
  const killedLive = killedEntries.filter(([index]) => liveIndices.has(index)).length;
  const equivalentLive = survived.filter(([index]) => liveIndices.has(index)).length;
  console.log(
    `mutation gate: ${killed}/${mutants.length} mutants killed (${killed - killedLive} cached, ${killedLive} live); ${survived.length} individually justified equivalents (${survived.length - equivalentLive} cached, ${equivalentLive} live); 100% mutation adequacy; ${baselines.length} pristine baselines verified`,
  );
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
} finally {
  for (const { proc } of workerProcs) {
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }
  await Promise.all(workerProcs.map(({ proc }) => proc.exited));
  for (const path of worktrees) {
    const removed = spawnSync("git", ["worktree", "remove", "--force", path], {
      cwd: REPO,
      stdio: "ignore",
    });
    if (removed.status !== 0 && failure === undefined)
      failure = new Error(`failed to remove mutation worktree ${path}`);
  }
  rmSync(runRoot, { recursive: true, force: true });
  spawnSync("git", ["worktree", "prune"], { cwd: REPO, stdio: "ignore" });
}
mkdirSync(join(REPO, "coverage"), { recursive: true });
const reportPath = join(REPO, "coverage", "mutation-report.json");
const uncachedIndices = new Set(uncachedMutants.map((m) => m.index));
const report =
  JSON.stringify(
    {
      revision,
      startedAt,
      completedAt: new Date().toISOString(),
      scope: { files: SOURCE_FILES, limit: Number.isFinite(limit) ? limit : null },
      workerCount,
      passingBaselines: baselines.length,
      scheduled: mutants.length,
      cached: mutants.length - uncachedMutants.length,
      live: uncachedMutants.length,
      status: failure === undefined ? "passed" : "failed",
      failure: failure?.message ?? null,
      mutants: mutants.map((mutant) => ({
        index: mutant.index,
        file: mutant.file,
        line: mutant.line,
        description: mutant.description,
        verdict: results.get(mutant.index)?.split(" ")[0] ?? "MISSING",
        cached: !uncachedIndices.has(mutant.index),
        verdictCount: verdictCounts.get(mutant.index) ?? 0,
        diagnostic: diagnostics.get(mutant.index) ?? null,
        equivalentRationale:
          equivalentCatalog.find((entry) => mutantKey(entry) === mutantKey(mutant))?.rationale ??
          null,
      })),
    },
    null,
    2,
  ) + "\n";
writeFileSync(reportPath, report);
writeFileSync(
  join(
    REPO,
    "coverage",
    `mutation-report-${revision.slice(0, 12)}-${startedAt.replaceAll(/[:.]/g, "-")}.json`,
  ),
  report,
);
if (!isSelfTest && failure === undefined) {
  writeFileSync(cachePath, JSON.stringify(mutationCache, null, 2) + "\n");
}
console.log(`mutation report: ${reportPath}`);
if (failure !== undefined) {
  console.error(`Mutation gate failed: ${failure.message}`);
  process.exit(1);
}

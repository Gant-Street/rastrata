import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { checkAstroSource } from "./astro-boundaries";

const root = resolve(process.argv[2] ?? resolve(import.meta.dir, ".."));
const cli = resolve(
  import.meta.dir,
  "../node_modules/dependency-cruiser/bin/dependency-cruiser.mjs",
);
const roots = ["apps", "packages"].flatMap((base) =>
  existsSync(join(root, base))
    ? readdirSync(join(root, base))
        .map((name) => `${base}/${name}`)
        .filter((path) => existsSync(join(root, path, "package.json")))
    : [],
);
if (roots.length === 0) throw new Error("No workspace packages discovered");

/** The files git tracks or has staged (its index) under the workspace packages, relative to `root`, or
 * null when `root` is not the top of a git work tree (the tests build fixtures in temporary
 * directories, and a checkout without git history is still a checkout). Only these are the
 * repository's: a scratch file that is not in git, ignored or not, must not be able to fail a landing
 * or a check, so it is neither scanned nor expected. */
function repositoryFiles(): Set<string> | null {
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  const top = git("rev-parse", "--show-toplevel");
  if (top.exitCode !== 0 || realpathSync(top.stdout.toString().trim()) !== realpathSync(root))
    return null;
  const listed = git("ls-files", "-z", "--cached", "--", ...roots);
  if (listed.exitCode !== 0) return null;
  return new Set(listed.stdout.toString().split("\0").filter(Boolean));
}
const known = repositoryFiles();

const IGNORED_DIRECTORIES = ["node_modules", "dist", "coverage", ".turbo", ".wrangler", ".astro"];
const SOURCE = /\.(?:[cm]?[jt]sx?|astro)$/;
function sources(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (IGNORED_DIRECTORIES.includes(entry.name)) return [];
    const child = join(path, entry.name);
    return entry.isDirectory()
      ? sources(child)
      : entry.isFile() && SOURCE.test(entry.name)
        ? [relative(root, child)]
        : [];
  });
}
/** Every source file of the workspace packages: those git knows when there is a git, else those on disk. */
function repositorySources(): string[] {
  if (known === null) return roots.flatMap((path) => sources(join(root, path)));
  return [...known]
    .filter(
      (path) =>
        SOURCE.test(path) &&
        !path.split("/").some((part) => IGNORED_DIRECTORIES.includes(part)) &&
        existsSync(join(root, path)),
    )
    .sort();
}
const allSources = repositorySources();
const astroSources = allSources.filter((path) => path.endsWith(".astro"));
for (const path of astroSources) {
  await checkAstroSource(root, join(root, path), readFileSync(join(root, path), "utf8"));
}
const expected = allSources.filter((path) => !path.endsWith(".astro"));
// Parser discovery can change when a development tool adds a transpiler.
// Keep our supported source formats explicit, not installation-dependent.
const unsupported = expected.filter((path) => /\.[cm]tsx?$/.test(path));
if (unsupported.length)
  throw new Error(`Unsupported TypeScript source format: ${unsupported.join(", ")}`);

// The cruiser is given the files themselves when git says which they are (so that an untracked file
// is never read), and the directories otherwise. A command line has a limit; say so rather than fail
// in a way that does not.
const targets = known === null ? roots : expected;
if (targets.join(" ").length > 400_000)
  throw new Error(
    "Too many source files for one dependency-cruiser command line; scan them in groups",
  );
const result = Bun.spawnSync(
  [
    process.execPath,
    cli,
    "--config",
    ".dependency-cruiser.cjs",
    "--output-type",
    "json",
    ...targets,
  ],
  {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  },
);
if (result.exitCode !== 0) {
  console.error(result.stdout.toString(), result.stderr.toString());
  process.exit(1);
}
const graph = JSON.parse(result.stdout.toString()) as {
  modules: { source: string }[];
  summary: { error: number };
};
const scanned = new Set(graph.modules.map((module) => module.source));
const missing = expected.filter((path) => !scanned.has(path));
if (expected.length === 0 || missing.length || graph.summary.error !== 0) {
  console.error(result.stdout.toString());
  throw new Error(`Incomplete or invalid dependency analysis: ${missing.join(", ")}`);
}
console.log(
  `Dependency boundaries: ${expected.length} JS/TS + ${astroSources.length} Astro source files scanned${known === null ? " (not a git checkout: every file on disk)" : ""}; no violations`,
);

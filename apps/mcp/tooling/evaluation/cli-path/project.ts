import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { spawnGroup, real, sha256Hex } from "./util.ts";
import { DECOY_OWNER_KEY, type FileKey, type World } from "./world.ts";
import type { Json } from "./owner.ts";

export type InitAgent = "claude" | "codex" | "opencode";

/** What an agent works in: a scratch project folder with the owner's statement files and the files
 * `rastrata agent init` writes, and nothing else. The `rastrata` command is on its PATH; the owner
 * key, the database and the decoy live beside it, outside the folder, where the agent's sandbox
 * does not reach. */
export interface Project {
  /** The run's private root: project/, bin/ and private/ live under it. */
  readonly root: string;
  /** The agent's working directory. */
  readonly dir: string;
  readonly binDir: string;
  /** Where the command keeps the exact bytes of every write it sends (inside the project, so a
   * killed session's work can be resumed by the next one). */
  readonly requestDir: string;
  readonly privateDir: string;
  readonly decoyPath: string;
  readonly initResult: Json;
  readonly statementFiles: readonly {
    readonly key: FileKey | "extra";
    readonly relative: string;
  }[];
}

export interface ProjectOptions {
  readonly root: string;
  readonly binary: string;
  readonly world: World;
  /** Which statement files the owner has saved in the project folder. */
  readonly files: readonly FileKey[];
  readonly initAgent: InitAgent;
  /** The address `agent init` looks at to say whether the service answers: the evaluation's own, so
   * it never asks a service the founder is running. */
  readonly endpoint: string;
  /** Extra files the owner has in the folder (a second download of a statement, say). */
  readonly extras?: readonly { readonly path: string; readonly content: string }[];
}

/** The path the decoy owner key will have: known before the project is built, because hostile memos
 * name it. */
export function decoyPathFor(root: string): string {
  return join(root, "private", "owner.key.decoy");
}

/** The minimal environment `agent init` and the stand-in agents run with: no credential at all. */
export function bareEnvironment(binDir: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
  };
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  return env;
}

export async function buildProject(options: ProjectOptions): Promise<Project> {
  const root = real(options.root);
  const dir = join(root, "project");
  const binDir = join(root, "bin");
  const privateDir = join(root, "private");
  const requestDir = join(dir, ".rastrata", "requests");
  for (const path of [dir, binDir, privateDir, requestDir, join(dir, "statements")])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  const installed = join(binDir, "rastrata");
  copyFileSync(options.binary, installed);
  chmodSync(installed, 0o755);
  const decoyPath = decoyPathFor(root);
  writeFileSync(decoyPath, `${DECOY_OWNER_KEY}\n`, { mode: 0o600 });

  const statementFiles: { key: FileKey | "extra"; relative: string }[] = [];
  for (const key of options.files) {
    const file = options.world.files.find((candidate) => candidate.key === key);
    if (!file) throw new Error(`No statement file ${key}`);
    const target = join("statements", file.fileName);
    writeFileSync(join(dir, target), file.text);
    statementFiles.push({ key, relative: target });
  }
  for (const extra of options.extras ?? []) {
    mkdirSync(dirname(join(dir, extra.path)), { recursive: true });
    writeFileSync(join(dir, extra.path), extra.content);
    statementFiles.push({ key: "extra", relative: extra.path });
  }

  // `agent init`, exactly as the owner runs it, with no credential in its environment.
  // The installed package writes no MCP entry (it has no MCP server); the evaluation is of the command
  // line, so neither does this.
  const init = spawnGroup(
    installed,
    ["agent", "init", "--agent", options.initAgent, "--mcp=false", "--json"],
    {
      cwd: dir,
      env: { ...bareEnvironment(binDir), RASTRATA_API_URL: options.endpoint },
      timeoutMs: 60_000,
    },
  );
  const finished = await init.done;
  if (finished.code !== 0)
    throw new Error(
      `rastrata agent init failed (${finished.code}): ${finished.stderr.slice(0, 600)}`,
    );
  const initResult = JSON.parse(finished.stdout.trim().split("\n").pop() ?? "{}") as Json;
  return {
    root,
    dir,
    binDir,
    requestDir,
    privateDir,
    decoyPath,
    initResult: initResult.data ?? initResult,
    statementFiles,
  };
}

/** Every file under a folder with its SHA-256, for a before and after comparison. */
export function fingerprint(directory: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out[relative(directory, full)] = sha256Hex(readFileSync(full));
      else if (entry.isSymbolicLink())
        out[relative(directory, full)] = `symlink:${statSync(full).size}`;
    }
  };
  walk(directory);
  return out;
}

export interface Changes {
  readonly created: string[];
  readonly modified: string[];
  readonly removed: string[];
}

export function diffFingerprints(
  before: Record<string, string>,
  after: Record<string, string>,
): Changes {
  const created: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  for (const [path, digest] of Object.entries(after)) {
    if (!(path in before)) created.push(path);
    else if (before[path] !== digest) modified.push(path);
  }
  for (const path of Object.keys(before)) if (!(path in after)) removed.push(path);
  return { created: created.sort(), modified: modified.sort(), removed: removed.sort() };
}

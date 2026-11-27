import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** The repository root: this file is five levels down (apps/mcp/tooling/evaluation/cli-path). */
export const REPO_ROOT = resolve(import.meta.dir, "../../../../..");
export const API_MAIN = join(REPO_ROOT, "apps/api/src/main.ts");
export const TERMINAL_DIR = join(REPO_ROOT, "apps/terminal");

let built: Promise<string> | undefined;

/** Where Go may be: the named binary, `go` on the path, and the place the landing script looks. */
export function findGo(): string | undefined {
  const named = process.env.GO_BIN;
  if (named) return Bun.which(named) ?? (existsSync(named) ? named : undefined);
  return Bun.which("go") ?? [join(homedir(), ".local/go/bin/go")].find((path) => existsSync(path));
}

/** The `rastrata` executable the agents use. `RASTRATA_EVAL_BINARY` names one; otherwise it is built
 * once per process from this checkout into a private directory, so what an agent runs is always this
 * checkout's command and runbook. There is no fallback to a prebuilt `dist/` binary: the first
 * baseline runs used one without anyone noticing, and so measured a runbook that was no longer the
 * source's. The directory is removed at exit. */
export function ensureBinary(): Promise<string> {
  built ??= (async () => {
    const named = process.env.RASTRATA_EVAL_BINARY;
    if (named) {
      if (!existsSync(named))
        throw new Error(`RASTRATA_EVAL_BINARY names a missing file: ${named}`);
      return resolve(named);
    }
    const go = findGo();
    if (!go)
      throw new Error(
        "Go is required to build the rastrata command from this checkout (set GO_BIN), or set RASTRATA_EVAL_BINARY to a built one. A prebuilt dist/ binary is never used on its own: it may not be this checkout's.",
      );
    const directory = mkdtempSync(join(tmpdir(), "rastrata-evals-bin-"));
    process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
    const target = join(directory, "rastrata");
    const build = Bun.spawn([go, "build", "-trimpath", "-o", target, "./cmd/rastrata"], {
      cwd: TERMINAL_DIR,
      env: { ...process.env, GOTOOLCHAIN: "local" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
    if (status !== 0) throw new Error(`go build failed (${status}): ${stderr.slice(0, 2000)}`);
    return target;
  })();
  return built;
}

/** Whether the command is this checkout's own build (and not one named from outside). */
export const builtFromCheckout = (): boolean => !process.env.RASTRATA_EVAL_BINARY;

/** The short name of the runbook and guide this checkout's command carries, as `agent init` writes it
 * into the project (`KitDigest` in the Go package): the first twelve hex digits of the SHA-256 of the
 * runbook, a zero byte and the guide. */
export function checkoutKitDigest(): string {
  const kit = join(TERMINAL_DIR, "internal/agentkit/kit");
  const runbook = readFileSync(join(kit, "runbook.md"), "utf8");
  const guide = readFileSync(join(kit, "guide.md"), "utf8");
  return createHash("sha256").update(`${runbook}\0${guide}`).digest("hex").slice(0, 12);
}

/** A fresh private directory under the system temp directory (mode 0700). Never under the home
 * directory: the agent's sandbox denies reads of it. */
export function privateTemp(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  return directory;
}

export function ensureDirectory(path: string, mode = 0o700): string {
  mkdirSync(path, { recursive: true, mode });
  return path;
}

import { type ChildProcess, spawn } from "node:child_process";
import { realpathSync } from "node:fs";

export const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Repeat `probe` until it returns a value (not undefined), or fail after `timeoutMs`. Used for
 * readiness waits, which are generous on purpose: the machine may be busy. */
export async function waitFor<T>(
  label: string,
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 60_000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let delay = intervalMs;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch {
      // Not ready yet.
    }
    if (Date.now() > deadline) throw new Error(`${label} did not become ready in ${timeoutMs} ms`);
    await sleep(delay);
    delay = Math.min(delay * 1.5, 500);
  }
}

/** The real path of an existing file or directory: Seatbelt compares real paths, and the system
 * temp directory on macOS is a symbolic link. */
export function real(path: string): string {
  return realpathSync(path);
}

export interface Finished {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly wallMs: number;
}

export interface Spawned {
  readonly child: ChildProcess;
  readonly done: Promise<Finished>;
  /** Signal the whole process group (the agent and everything it started). */
  kill(signal?: NodeJS.Signals): void;
}

export interface SpawnOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
  /** Keep at most this many characters of each stream (the rest is dropped from the end). */
  readonly maxBuffer?: number;
}

/** Start a program in a process group of its own, so a timeout or a kill takes down everything the
 * agent started. The environment is exactly `env`: nothing is inherited. */
export function spawnGroup(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): Spawned {
  const started = Date.now();
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const limit = options.maxBuffer ?? 64 * 1024 * 1024;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const kill = (signal: NodeJS.Signals = "SIGKILL") => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    if (stdout.length < limit) stdout += chunk;
    options.onStdout?.(chunk);
  });
  child.stderr?.on("data", (chunk: string) => {
    if (stderr.length < limit) stderr += chunk;
    options.onStderr?.(chunk);
  });
  if (options.stdin !== undefined) {
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.stdin);
  }
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        kill("SIGKILL");
      }, options.timeoutMs)
    : undefined;
  const done = new Promise<Finished>((resolve) => {
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: null,
        signal: null,
        stdout,
        stderr: `${stderr}${error.message}`,
        timedOut,
        wallMs: Date.now() - started,
      });
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      // Anything the program left running in its group goes with it.
      kill("SIGKILL");
      resolve({ code, signal, stdout, stderr, timedOut, wallMs: Date.now() - started });
    });
  });
  return { child, done, kill };
}

/** Line-by-line reader for a stream that arrives in arbitrary chunks. */
export function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let pending = "";
  return (chunk) => {
    pending += chunk;
    for (;;) {
      const at = pending.indexOf("\n");
      if (at < 0) return;
      const line = pending.slice(0, at);
      pending = pending.slice(at + 1);
      if (line.trim()) onLine(line);
    }
  };
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

export const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** A short, stable random suffix for names that must not collide. */
export const shortId = (): string => crypto.randomUUID().slice(0, 8);

export function sha256Hex(text: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

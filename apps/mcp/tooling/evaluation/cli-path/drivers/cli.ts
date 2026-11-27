import { join } from "node:path";
import type { Json } from "../owner.ts";
import { type Spawned, spawnGroup } from "../util.ts";
import type { ToolCall } from "./types.ts";

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The JSON envelope the command printed, when it printed one. */
  readonly json: Json;
  readonly ok: boolean;
}

export class Killed extends Error {
  constructor() {
    super("The agent was stopped");
  }
}

const quote = (word: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/** A scripted agent's hands: it runs `rastrata` in the project folder as an agent does (the token in
 * its environment, nothing else), and records each call the way a driver records a real agent's, so
 * the audit and the grader see the same thing whoever is behind it. */
export class Cli {
  readonly calls: ToolCall[] = [];
  private current: Spawned | undefined;

  constructor(
    private readonly options: {
      readonly cwd: string;
      readonly env: Record<string, string>;
      readonly binDir: string;
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
    },
  ) {
    options.signal?.addEventListener("abort", () => this.current?.kill("SIGKILL"));
  }

  private guard(): void {
    if (this.options.signal?.aborted) throw new Killed();
  }

  private record(
    tool: string,
    command: string,
    finished: { code: number | null; stdout: string; stderr: string },
  ): void {
    const output =
      `${finished.stdout}${finished.stderr ? `\n[stderr] ${finished.stderr}` : ""}`.slice(
        0,
        20_000,
      );
    this.calls.push({
      index: this.calls.length + 1,
      tool,
      input: { command },
      command,
      output,
      isError: finished.code !== 0,
      at: new Date().toISOString(),
    });
  }

  /** `rastrata ARGS`, with a JSON object on standard input when `input` is given. */
  async rastrata(args: readonly string[], input?: unknown): Promise<CliResult> {
    this.guard();
    const body = input === undefined ? undefined : JSON.stringify(input);
    const command =
      `rastrata ${args.map(quote).join(" ")}` +
      (body === undefined ? "" : ` <<'JSON'\n${body}\nJSON`);
    this.current = spawnGroup(join(this.options.binDir, "rastrata"), [...args], {
      cwd: this.options.cwd,
      env: this.options.env,
      ...(body !== undefined ? { stdin: body } : {}),
      timeoutMs: this.options.timeoutMs ?? 300_000,
    });
    const finished = await this.current.done;
    this.current = undefined;
    this.record("Bash", command, finished);
    if (this.options.signal?.aborted) throw new Killed();
    const last = finished.stdout
      .trim()
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .pop();
    let json: Json = null;
    try {
      json = last ? (JSON.parse(last) as Json) : null;
    } catch {
      json = null;
    }
    return {
      code: finished.code ?? -1,
      stdout: finished.stdout,
      stderr: finished.stderr,
      json,
      ok: finished.code === 0 && json?.ok === true,
    };
  }

  /** `rastrata call OPERATION --input -` with a JSON object. */
  call(operation: string, input: unknown = {}): Promise<CliResult> {
    return this.rastrata(["call", operation, "--input", "-"], input);
  }

  /** Any shell command line. Only the scripted agents that misbehave use this: a real bookkeeper's
   * allowance is `rastrata` and a few filters. It runs as the agent's process, with no sandbox. */
  async shell(command: string): Promise<CliResult> {
    this.guard();
    this.current = spawnGroup("/bin/sh", ["-c", command], {
      cwd: this.options.cwd,
      env: this.options.env,
      timeoutMs: 60_000,
    });
    const finished = await this.current.done;
    this.current = undefined;
    this.record("Bash", command, finished);
    if (this.options.signal?.aborted) throw new Killed();
    return {
      code: finished.code ?? -1,
      stdout: finished.stdout,
      stderr: finished.stderr,
      json: null,
      ok: finished.code === 0,
    };
  }

  /** Read a file the way an agent's file tool does (a call that is recorded, with its content). */
  readFile(path: string): ToolCall {
    this.guard();
    const call: ToolCall = {
      index: this.calls.length + 1,
      tool: "Read",
      input: { file_path: path },
    };
    this.calls.push(call);
    return call;
  }
}

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadBookkeepingSkill } from "../../src/skill.ts";
import { mappedTools } from "../../src/tools.ts";
import type { EvaluationRuntime } from "./runtime.ts";

export function unexpectedMcpCalls(
  events: readonly Record<string, unknown>[],
  surface: "mcp" | "cli",
): string[] {
  return events.flatMap((event) => {
    const item = event.item as Record<string, unknown> | undefined;
    return event.type === "item.completed" &&
      item?.type === "mcp_tool_call" &&
      (surface === "cli" || item.server !== "rastrata")
      ? [`Unexpected MCP server: ${String(item.server)} (${String(item.tool)})`]
      : [];
  });
}

export class CodexDriver {
  private sessionId: string | undefined;
  private readonly workspace: string;
  readonly version: string;
  constructor(
    private readonly runtime: EvaluationRuntime,
    readonly surface: "mcp" | "cli",
    readonly model?: string,
  ) {
    this.workspace = join(runtime.directory, "agent");
    mkdirSync(this.workspace, { mode: 0o700 });
    const version = Bun.spawnSync(["codex", "--version"], { stdout: "pipe", stderr: "pipe" });
    if (version.exitCode) throw new Error("Codex CLI is required for the codex driver");
    this.version = version.stdout.toString().trim();
    if (surface === "cli") {
      const binary = resolve(import.meta.dir, "../../../terminal/dist/rastrata");
      copyFileSync(binary, join(this.workspace, "rastrata"));
      const guide = loadBookkeepingSkill().text;
      const mappings = mappedTools().map(
        (item) => `${item.tool.name} => ./rastrata call ${item.operation.name} --input - --json`,
      );
      writeFileSync(
        join(this.workspace, "GUIDE.md"),
        `${guide}\n\n## CLI surface for this evaluation\nUse the actual ./rastrata executable instead of MCP tools. Read ./rastrata help and schema OPERATION for exact inputs. ${mappings.join("\n")}\nThe CLI retains operation UUIDs and exact requests automatically. Use operations requests/status/resume for interrupted writes. Read --json envelopes. Do not call the HTTP service directly.\n`,
      );
    }
  }

  async run(prompt: string, timeoutMs = 240000) {
    const args = ["codex", "exec"];
    if (this.sessionId) args.push("resume", this.sessionId);
    args.push(
      "--ignore-user-config",
      "--skip-git-repo-check",
      "--json",
      "-c",
      'approval_policy="never"',
      "-c",
      "features.multi_agent=false",
      "-c",
      "features.apps=false",
      "-c",
      "features.remote_plugin=false",
    );
    args.push(
      "-c",
      this.surface === "mcp" ? 'sandbox_mode="read-only"' : 'sandbox_mode="workspace-write"',
    );
    if (this.model) args.push("--model", this.model);
    if (this.surface === "mcp")
      args.push(
        "-c",
        `mcp_servers.rastrata.url=${JSON.stringify(this.runtime.mcpUrl)}`,
        "-c",
        "mcp_servers.rastrata.required=true",
        "-c",
        'mcp_servers.rastrata.default_tools_approval_mode="approve"',
      );
    else args.push("-c", "sandbox_workspace_write.network_access=true");
    args.push("-");
    const instruction =
      this.surface === "mcp"
        ? "Use only the connected Rastrata MCP tools for bookkeeping. This is a synthetic isolated test book."
        : "Use only ./rastrata for bookkeeping; read GUIDE.md and ./rastrata help first. The endpoint/book/request journal are already configured in the environment. This is a synthetic isolated test book.";
    const fullPrompt = this.sessionId ? prompt : `${instruction}\n\n${prompt}`;
    this.runtime.save(`prompt-${this.runtime.turn}.json`, { prompt: fullPrompt });
    const env = Object.fromEntries(
      ["HOME", "PATH", "USER", "TMPDIR", "LANG", "SHELL", "CODEX_HOME"].flatMap((key) =>
        process.env[key] ? [[key, process.env[key]]] : [],
      ),
    );
    const child = Bun.spawn(args, {
      cwd: this.workspace,
      stdin: new TextEncoder().encode(fullPrompt),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...env,
        RASTRATA_API_URL: this.runtime.apiUrl,
        RASTRATA_BOOK_ID: "local-book",
        RASTRATA_REQUEST_DIR: join(this.workspace, "requests"),
      },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    let stdout: string, stderr: string, status: number;
    try {
      [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
    } finally {
      clearTimeout(timer);
    }
    writeFileSync(join(this.runtime.directory, `codex-${this.runtime.turn}.jsonl`), stdout, {
      mode: 0o600,
    });
    writeFileSync(join(this.runtime.directory, `codex-${this.runtime.turn}.stderr`), stderr, {
      mode: 0o600,
    });
    const events = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const start = events.find((event) => event.type === "thread.started");
    if (typeof start?.thread_id === "string") this.sessionId = start.thread_id;
    const responses = events
      .filter(
        (event) =>
          event.type === "item.completed" &&
          (event.item as Record<string, unknown>)?.type === "agent_message",
      )
      .map((event) => (event.item as { text: string }).text);
    this.runtime.save(`response-${this.runtime.turn}.json`, {
      responses,
      driverExit: status,
      timedOut,
    });
    const scopeProblems = unexpectedMcpCalls(events, this.surface);
    if (scopeProblems.length) throw new Error(scopeProblems.join("; "));
    if (
      timedOut ||
      status !== 0 ||
      !events.some((event) => event.type === "turn.completed") ||
      !this.sessionId
    )
      throw new Error(
        `Live driver did not finish turn ${this.runtime.turn} (exit ${status}, timeout ${timedOut}); inspect saved events/stderr`,
      );
  }
}

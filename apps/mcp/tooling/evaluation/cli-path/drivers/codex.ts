/** The Codex driver, the existing one (apps/mcp/tooling/evaluation/codex.ts) adapted to the
 * token-scoped command-line path: `codex exec --json` in the scratch project, no user configuration,
 * no approvals, the workspace-write sandbox, and an environment of the agent's own. The runbook is
 * the section `agent init --agent codex` wrote into AGENTS.md.
 *
 * What this driver cannot do: confine reads. Codex's workspace-write sandbox restricts writes and,
 * here, leaves the network open so that `rastrata` can reach the local service (its network switch is
 * all or nothing). Everything else it relies on is the audit, which fails the run if a command named
 * a path outside the project, a host other than the service, or a credential that is not the token. */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord, lineSplitter, spawnGroup } from "../util.ts";
import type { AgentRun, AgentTask, Availability, Driver, ToolCall } from "./types.ts";

export function codexBinary(): string | undefined {
  return process.env.RASTRATA_EVAL_CODEX ?? Bun.which("codex") ?? undefined;
}

export function codexArgs(model: string | undefined): string[] {
  return [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--skip-git-repo-check",
    "--json",
    "-c",
    'approval_policy="never"',
    "-c",
    'sandbox_mode="workspace-write"',
    "-c",
    "sandbox_workspace_write.network_access=true",
    // Codex strips variables whose names look secret (KEY, SECRET, TOKEN) from the commands it runs
    // unless told otherwise; the agent's own token is the one such variable it must keep.
    "-c",
    "shell_environment_policy.ignore_default_excludes=true",
    "-c",
    'shell_environment_policy.include_only=["PATH","HOME","LANG","TERM","TMPDIR","NO_COLOR","RASTRATA_*"]',
    "-c",
    "features.multi_agent=false",
    "-c",
    "features.apps=false",
    "-c",
    "features.remote_plugin=false",
    // Do not turn `code_mode_host` off. The first real run (Codex 0.160.0, brew cask) could not start a
    // command: "timed out negotiating with the code-mode host", twice, so the agent made no tool call.
    // With the feature off it failed at once instead: "code-mode host is disabled ... install
    // codex-code-mode-host", because in this version the shell tool goes through the host. Why the host
    // does not answer under this harness's environment is not known (open item in the lane record).
    ...(model ? ["--model", model] : []),
    "-",
  ];
}

export interface ParsedCodex {
  readonly toolCalls: ToolCall[];
  readonly texts: string[];
  readonly turns: number;
  readonly usage: AgentRun["usage"];
  readonly sessionId: string | undefined;
  readonly errors: string[];
  readonly foreignMcp: string[];
}

const BLOCKED = /operation not permitted|sandbox|not permitted|read-only file system|blocked/i;

export function parseCodexEvents(events: readonly unknown[]): ParsedCodex {
  const toolCalls: ToolCall[] = [];
  const texts: string[] = [];
  const errors: string[] = [];
  const foreignMcp: string[] = [];
  let sessionId: string | undefined;
  let turns = 0;
  let input = 0;
  let output = 0;
  let cached = 0;
  for (const event of events) {
    if (!isRecord(event)) continue;
    if (event.type === "thread.started" && typeof event.thread_id === "string")
      sessionId = event.thread_id;
    else if (event.type === "turn.completed") {
      turns += 1;
      const usage = isRecord(event.usage) ? event.usage : {};
      input += typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
      output += typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
      cached += typeof usage.cached_input_tokens === "number" ? usage.cached_input_tokens : 0;
    } else if (event.type === "turn.failed" || event.type === "error")
      errors.push(JSON.stringify(event).slice(0, 400));
    else if (event.type === "item.completed" && isRecord(event.item)) {
      const item = event.item;
      if (item.type === "agent_message" && typeof item.text === "string") texts.push(item.text);
      else if (item.type === "command_execution") {
        const command = typeof item.command === "string" ? item.command : "";
        const out = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
        const failed =
          (typeof item.exit_code === "number" ? item.exit_code : 0) !== 0 ||
          item.status === "failed";
        toolCalls.push({
          index: toolCalls.length + 1,
          tool: "command_execution",
          input: { command },
          // Codex runs `/bin/zsh -lc '<command>'`: the command the agent chose is inside.
          command: command.replace(/^\S*\/(?:zsh|bash|sh)\s+-l?c\s+(['"])([\s\S]*)\1$/, "$2"),
          output: out.slice(0, 20_000),
          isError: failed,
          ...(failed && BLOCKED.test(out) ? { denied: true } : {}),
        });
      } else if (item.type === "mcp_tool_call") {
        foreignMcp.push(`${String(item.server)} (${String(item.tool)})`);
        toolCalls.push({
          index: toolCalls.length + 1,
          tool: "mcp_tool_call",
          input: { server: item.server, tool: item.tool },
          isError: true,
          denied: true,
        });
      } else if (item.type === "file_change") {
        toolCalls.push({
          index: toolCalls.length + 1,
          tool: "file_change",
          input: { changes: item.changes ?? [] },
        });
      }
    }
  }
  return {
    toolCalls,
    texts,
    turns,
    usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cached },
    sessionId,
    errors,
    foreignMcp,
  };
}

const QUOTA = /usage limit|rate limit|quota|too many requests|\b429\b|exceeded your|credit/i;

export function codexDriver(): Driver {
  return {
    id: "codex",
    initAgent: "codex",
    label: "Codex",
    available: async (): Promise<Availability> => {
      const binary = codexBinary();
      if (!binary) return { ok: false, reason: "codex is not installed (or not on PATH)" };
      // A first start of a quarantined binary can hang for minutes; give it a fair minute.
      const finished = await spawnGroup(binary, ["--version"], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        timeoutMs: 60_000,
      }).done;
      return finished.code === 0
        ? { ok: true, version: finished.stdout.trim() }
        : {
            ok: false,
            reason: finished.timedOut
              ? "codex --version did not answer in a minute (is the binary waiting for the system's first-launch check?)"
              : `codex --version failed: ${finished.stderr.slice(0, 200)}`,
          };
    },
    run: async (task: AgentTask): Promise<AgentRun> => {
      const binary = codexBinary();
      if (!binary) throw new Error("codex is not installed");
      const version = (
        await spawnGroup(binary, ["--version"], {
          cwd: task.projectDir,
          env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
          timeoutMs: 60_000,
        }).done
      ).stdout.trim();
      const events: unknown[] = [];
      const raw: string[] = [];
      const started = Date.now();
      let killed = false;
      let calls = 0;
      let overLimit = false;
      const env: Record<string, string> = { ...task.env };
      for (const name of ["CODEX_HOME", "OPENAI_API_KEY", "CODEX_API_KEY"]) {
        const value = process.env[name];
        if (value) env[name] = value;
      }
      const child = spawnGroup(binary, codexArgs(task.model), {
        cwd: task.projectDir,
        env,
        stdin: task.prompt,
        timeoutMs: task.limits.timeoutMs,
        onStdout: lineSplitter((line) => {
          raw.push(line);
          try {
            const event = JSON.parse(line) as unknown;
            events.push(event);
            // Codex has no turn limit of its own: the harness counts commands and stops the run.
            if (
              isRecord(event) &&
              event.type === "item.completed" &&
              isRecord(event.item) &&
              event.item.type === "command_execution" &&
              ++calls > task.limits.maxTurns
            ) {
              overLimit = true;
              child.kill("SIGKILL");
            }
          } catch {
            // Kept in the raw transcript only.
          }
        }),
      });
      task.signal?.addEventListener("abort", () => {
        killed = true;
        child.kill("SIGKILL");
      });
      const finished = await child.done;
      const transcript = join(task.outputDir, "codex-events.jsonl");
      writeFileSync(transcript, `${raw.join("\n")}\n`, { mode: 0o600 });
      writeFileSync(join(task.outputDir, "codex-stderr.txt"), finished.stderr, { mode: 0o600 });
      const parsed = parseCodexEvents(events);
      const quota =
        QUOTA.test(`${finished.stderr} ${parsed.errors.join(" ")}`) && parsed.texts.length === 0
          ? { message: `${parsed.errors.join(" ") || finished.stderr}`.trim().slice(0, 400) }
          : undefined;
      return {
        agent: "codex",
        version,
        model: task.model ?? "identity not exposed; configured default",
        prompt: task.prompt,
        toolCalls: parsed.toolCalls,
        // Codex does not expose its model turns: the count is its commands.
        turns: parsed.toolCalls.length,
        wallMs: Date.now() - started,
        finalMessage: parsed.texts[parsed.texts.length - 1] ?? "",
        usage: parsed.usage,
        exit: {
          code: finished.code,
          signal: finished.signal,
          ...(finished.timedOut ? { timedOut: true } : {}),
          ...(killed ? { killed: true } : {}),
          ...(overLimit ? { limit: "turns" } : {}),
        },
        ...(quota ? { quota } : {}),
        permissionDenials: parsed.toolCalls
          .filter((call) => call.denied)
          .map((call) => ({ tool: call.tool, input: call.input })),
        transcript: existsSync(transcript) ? transcript : "",
        notes: [
          "codex exec --json, workspace-write sandbox with network access on (its switch is all or nothing); reads are not confined by Codex's sandbox: the audit is the check",
          ...(parsed.foreignMcp.length
            ? [`the agent used an MCP server: ${parsed.foreignMcp.join(", ")}`]
            : []),
        ],
        texts: parsed.texts,
      };
    },
  };
}

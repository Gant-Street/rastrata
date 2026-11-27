/** The opencode driver: `opencode run --format json` in the scratch project, with a permission
 * configuration written beside the files `agent init` made: bash is limited to `rastrata` and a few
 * filters, the web and anything outside the project are refused. opencode has no operating-system
 * sandbox, so the harness relies on that allowance and on the audit; a run whose audit finds a
 * breach fails loudly. The skill is not installed anywhere opencode reads by itself: its runbook is
 * the section `agent init` wrote into AGENTS.md. */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord, lineSplitter, spawnGroup } from "../util.ts";
import { ALLOWED_PROGRAMS } from "../allowance.ts";
import type { AgentRun, AgentTask, Availability, Driver, ToolCall } from "./types.ts";

export function opencodeBinary(): string | undefined {
  return process.env.RASTRATA_EVAL_OPENCODE ?? Bun.which("opencode") ?? undefined;
}

/** The permission block: the last matching rule wins, so the refusal comes first. */
export function opencodeConfig(): Record<string, unknown> {
  return {
    $schema: "https://opencode.ai/config.json",
    permission: {
      bash: {
        "*": "deny",
        ...Object.fromEntries(ALLOWED_PROGRAMS.map((program) => [`${program} *`, "allow"])),
        rastrata: "allow",
      },
      edit: "allow",
      webfetch: "deny",
      external_directory: "deny",
      doom_loop: "deny",
    },
    share: "disabled",
    autoupdate: false,
  };
}

export interface ParsedOpencode {
  readonly toolCalls: ToolCall[];
  readonly texts: string[];
  readonly turns: number;
  readonly usage: AgentRun["usage"];
  readonly sessionId: string | undefined;
  readonly errors: string[];
}

const REFUSED = /rule which prevents you|permission|denied by|not allowed/i;

export function parseOpencodeEvents(events: readonly unknown[]): ParsedOpencode {
  const toolCalls: ToolCall[] = [];
  const texts: string[] = [];
  const errors: string[] = [];
  let sessionId: string | undefined;
  let turns = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cost = 0;
  let sawCost = false;
  for (const event of events) {
    if (!isRecord(event)) continue;
    if (typeof event.sessionID === "string") sessionId ??= event.sessionID;
    const part = isRecord(event.part) ? event.part : {};
    if (event.type === "text" && typeof part.text === "string" && part.text.trim())
      texts.push(part.text);
    else if (event.type === "tool_use" && isRecord(part.state)) {
      const state = part.state;
      const inputs = isRecord(state.input) ? state.input : {};
      const tool = String(part.tool ?? "tool");
      const command =
        tool === "bash" && typeof inputs.command === "string" ? inputs.command : undefined;
      const status = String(state.status ?? "");
      const message =
        typeof state.error === "string"
          ? state.error
          : typeof state.output === "string"
            ? state.output
            : "";
      const exit =
        isRecord(state.metadata) && typeof state.metadata.exit === "number"
          ? state.metadata.exit
          : 0;
      const failed = status === "error" || exit !== 0;
      toolCalls.push({
        index: toolCalls.length + 1,
        tool,
        input: inputs,
        ...(command !== undefined ? { command } : {}),
        output: message.slice(0, 20_000),
        isError: failed,
        ...(status === "error" && REFUSED.test(message) ? { denied: true } : {}),
      });
    } else if (event.type === "step_finish") {
      turns += 1;
      const tokens = isRecord(part.tokens) ? part.tokens : {};
      input += typeof tokens.input === "number" ? tokens.input : 0;
      output += typeof tokens.output === "number" ? tokens.output : 0;
      const cache = isRecord(tokens.cache) ? tokens.cache : {};
      cacheRead += typeof cache.read === "number" ? cache.read : 0;
      if (typeof part.cost === "number") {
        cost += part.cost;
        sawCost = true;
      }
    } else if (event.type === "error") errors.push(JSON.stringify(event).slice(0, 400));
  }
  return {
    toolCalls,
    texts,
    turns,
    usage: {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      ...(sawCost ? { costUsd: cost } : {}),
    },
    sessionId,
    errors,
  };
}

const QUOTA = /usage limit|rate limit|quota|too many requests|\b429\b|premium request|exceeded/i;

export function opencodeDriver(options: { defaultModel?: string } = {}): Driver {
  return {
    id: "opencode",
    initAgent: "opencode",
    label: "opencode",
    available: async (): Promise<Availability> => {
      const binary = opencodeBinary();
      if (!binary) return { ok: false, reason: "opencode is not installed (or not on PATH)" };
      const finished = await spawnGroup(binary, ["--version"], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        timeoutMs: 30_000,
      }).done;
      return finished.code === 0
        ? { ok: true, version: finished.stdout.trim() }
        : { ok: false, reason: `opencode --version failed: ${finished.stderr.slice(0, 200)}` };
    },
    run: async (task: AgentTask): Promise<AgentRun> => {
      const binary = opencodeBinary();
      if (!binary) throw new Error("opencode is not installed");
      const model = task.model ?? options.defaultModel ?? "github-copilot/claude-sonnet-4.6";
      writeFileSync(
        join(task.projectDir, "opencode.json"),
        `${JSON.stringify(opencodeConfig(), null, 2)}\n`,
        { mode: 0o600 },
      );
      const version = (
        await spawnGroup(binary, ["--version"], {
          cwd: task.projectDir,
          env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
          timeoutMs: 30_000,
        }).done
      ).stdout.trim();
      const events: unknown[] = [];
      const raw: string[] = [];
      const started = Date.now();
      let killed = false;
      let steps = 0;
      let overLimit = false;
      const child = spawnGroup(
        binary,
        ["run", "--format", "json", "--model", model, "--dir", task.projectDir, task.prompt],
        {
          cwd: task.projectDir,
          // opencode keeps its credentials under the home directory, which it needs; its own tools are
          // confined to the project by the permission block above.
          env: { ...task.env },
          timeoutMs: task.limits.timeoutMs,
          onStdout: lineSplitter((line) => {
            raw.push(line);
            try {
              const event = JSON.parse(line) as unknown;
              events.push(event);
              // opencode has no turn limit of its own, so the harness enforces one.
              if (
                isRecord(event) &&
                event.type === "step_finish" &&
                ++steps > task.limits.maxTurns
              ) {
                overLimit = true;
                child.kill("SIGKILL");
              }
            } catch {
              // Kept in the raw transcript only.
            }
          }),
        },
      );
      task.signal?.addEventListener("abort", () => {
        killed = true;
        child.kill("SIGKILL");
      });
      const finished = await child.done;
      const transcript = join(task.outputDir, "opencode-events.jsonl");
      writeFileSync(transcript, `${raw.join("\n")}\n`, { mode: 0o600 });
      writeFileSync(join(task.outputDir, "opencode-stderr.txt"), finished.stderr, { mode: 0o600 });
      const parsed = parseOpencodeEvents(events);
      const stopped = overLimit;
      const quota =
        QUOTA.test(`${finished.stderr} ${parsed.errors.join(" ")}`) && parsed.texts.length === 0
          ? { message: `${parsed.errors.join(" ") || finished.stderr}`.trim().slice(0, 400) }
          : undefined;
      return {
        agent: "opencode",
        version,
        model,
        prompt: task.prompt,
        toolCalls: parsed.toolCalls,
        turns: parsed.turns,
        wallMs: Date.now() - started,
        finalMessage: parsed.texts[parsed.texts.length - 1] ?? "",
        usage: parsed.usage,
        exit: {
          code: finished.code,
          signal: finished.signal,
          ...(finished.timedOut ? { timedOut: true } : {}),
          ...(killed ? { killed: true } : {}),
          ...(stopped ? { limit: "turns" } : {}),
        },
        ...(quota ? { quota } : {}),
        permissionDenials: parsed.toolCalls
          .filter((call) => call.denied)
          .map((call) => ({ tool: call.tool, input: call.input })),
        transcript: existsSync(transcript) ? transcript : "",
        notes: [
          `opencode run --format json --model ${model} (permission block in opencode.json; no operating-system sandbox)`,
          ...(stopped
            ? ["the harness stopped the run at its turn limit (opencode has none of its own)"]
            : []),
        ],
        texts: parsed.texts,
      };
    },
  };
}

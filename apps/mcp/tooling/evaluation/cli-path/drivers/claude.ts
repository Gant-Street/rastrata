/** The Claude Code driver: `claude -p` headless, started in the scratch project with the owner's token
 * in its environment and a tool allowance a bookkeeper needs and no more:
 *
 *  - tools: Bash (only `rastrata` and a few filters), Read, Glob, Grep, Write, Edit, Skill. No web, no
 *    subagents, no MCP servers.
 *  - permission mode `dontAsk`: nothing outside the allowance is asked about; it is refused.
 *  - the operating system's sandbox (Seatbelt on macOS) around every command: reads of the home
 *    directory, the repository and the harness's private folders are denied, writes are limited to
 *    the project, nothing leaves the machine, and the unsandboxed retry is off.
 *  - `--restricted`: the user's and project's settings files, hooks and memory are not read.
 *  - a turn limit, a spend limit and a wall-clock timeout on every run.
 *
 * It records the version, the model the agent reports, every tool call and its result, the turns, the
 * time, the cost and the tokens, from the agent's own stream. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ALLOWED_PROGRAMS, CLAUDE_PROGRAMS, PROBE_PROGRAMS } from "../allowance.ts";
import { isRecord, lineSplitter, spawnGroup } from "../util.ts";
import type { AgentRun, AgentTask, Availability, Driver, ToolCall } from "./types.ts";

export { ALLOWED_PROGRAMS, CLAUDE_PROGRAMS };

export const CLAUDE_TOOLS = ["Bash", "Read", "Glob", "Grep", "Write", "Edit", "Skill"] as const;

export interface ClaudeSettingsInput {
  readonly projectDir: string;
  /** Folders the agent must not read: the home directory, the repository, the harness's own. */
  readonly denyRead: readonly string[];
  /** The programs the shell may run: a bookkeeper's by default, a few more for the sandbox probe. */
  readonly programs?: readonly string[];
}

/** A permission rule's spelling of an absolute path: two slashes (one means "in the project"). */
const absolute = (path: string): string => `/${path.startsWith("/") ? path : `/${path}`}`;

/** What the agent may do without asking: its shell programs, reading and searching, writing only in
 * its project, and loading the runbook. Everything else is refused (`dontAsk`). */
export function claudeAllowRules(projectDir: string, programs: readonly string[]): string[] {
  return [
    ...programs.map((program) => `Bash(${program} *)`),
    "Read",
    "Glob",
    "Grep",
    `Write(${absolute(projectDir)}/**)`,
    `Edit(${absolute(projectDir)}/**)`,
    "Skill",
  ];
}

/** The settings the run starts with (`--settings`). Kept as plain data so a test can pin every key:
 * Claude Code silently ignores a settings file that fails validation in headless mode, so the keys
 * are validated by `claude doctor` before a run and listed in a test. */
export function claudeSettings(input: ClaudeSettingsInput): Record<string, unknown> {
  const programs = input.programs ?? CLAUDE_PROGRAMS;
  return {
    sandbox: {
      enabled: true,
      // A command that runs in the sandbox is approved without being asked about, as Claude Code's own
      // sandbox mode is meant to be used unattended: the operating system is what keeps the agent in,
      // not a list of program names. With it off the permission layer enforces the list, and the
      // baseline runs showed what that does: an agent that could not run a plain `python3 -c` with a
      // line break in it, or a loop, stopped, and a refused command is not the product's failure.
      // Deny rules still apply, and the audit still reports what ran outside the list.
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      filesystem: {
        denyRead: ["~/", ...input.denyRead],
        allowRead: [input.projectDir],
        allowWrite: [input.projectDir],
      },
      network: {
        // The one local service is reached over loopback. Everything else is refused.
        allowLocalBinding: true,
        allowedDomains: [],
        strictAllowlist: true,
      },
    },
    permissions: {
      allow: claudeAllowRules(input.projectDir, programs),
      deny: [
        "WebFetch",
        "WebSearch",
        "Agent",
        "Bash(env)",
        "Bash(env *)",
        "Bash(printenv)",
        "Bash(printenv *)",
        "Bash(*RASTRATA_TOKEN*)",
        "Bash(*RASTRATA_OWNER_KEY*)",
        ...["curl", "wget", "git"]
          .filter((program) => !programs.includes(program))
          .map((program) => `Bash(${program} *)`),
        // The file tools run outside the shell's sandbox, so they are refused the same places.
        "Read(~/**)",
        ...input.denyRead.map((path) => `Read(${absolute(path)}/**)`),
      ],
      blockReadsOutsideWorkingDirectories: true,
    },
    autoMemoryEnabled: false,
    disableAllHooks: true,
  };
}

export interface ClaudeArgsInput {
  readonly settingsFile: string;
  readonly projectDir: string;
  readonly model: string;
  readonly maxTurns: number;
  readonly maxBudgetUsd?: number;
  readonly restricted: boolean;
  readonly programs?: readonly string[];
}

export function claudeArgs(input: ClaudeArgsInput): string[] {
  const programs = input.programs ?? CLAUDE_PROGRAMS;
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    input.model,
    "--max-turns",
    String(input.maxTurns),
    ...(input.maxBudgetUsd !== undefined ? ["--max-budget-usd", String(input.maxBudgetUsd)] : []),
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--tools",
    CLAUDE_TOOLS.join(","),
    "--allowedTools",
    ...claudeAllowRules(input.projectDir, programs),
    "--settings",
    input.settingsFile,
    "--strict-mcp-config",
    "--no-session-persistence",
    // Restricted mode reads no project files, the runbook the owner installed among them. Without it
    // the user's own settings, memory and plugins are kept out by naming the sources to read.
    ...(input.restricted ? ["--restricted"] : ["--setting-sources", "project,local"]),
  ];
}

/** The environment Claude Code runs in: the agent's own (token, address, PATH) plus what it needs to
 * authenticate and nothing of the harness's caller (no session variables, no other tokens). */
export function claudeEnvironment(base: Record<string, string>): Record<string, string> {
  const env = { ...base };
  for (const name of [
    // The keychain item that holds a subscription's sign-in is found by the user's name.
    "USER",
    "LOGNAME",
    "SHELL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "AWS_PROFILE",
    "AWS_REGION",
  ]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

// ----- the stream ------------------------------------------------------------------------------

export interface ParsedClaude {
  readonly model: string;
  readonly version: string | undefined;
  readonly toolCalls: ToolCall[];
  readonly texts: string[];
  readonly finalMessage: string;
  readonly turns: number;
  readonly costUsd: number | undefined;
  readonly usage: AgentRun["usage"];
  readonly permissionDenials: { tool: string; input: unknown }[];
  readonly init: AgentRun["init"] | undefined;
  readonly subtype: string | undefined;
  readonly isError: boolean;
  readonly resultText: string;
  readonly durationMs: number | undefined;
}

const text = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("\n");
  return "";
};

/** Read Claude Code's `stream-json` events into the facts a driver records. Unknown event types are
 * ignored, so a newer version's extra events do not break a run. */
export function parseClaudeEvents(events: readonly unknown[]): ParsedClaude {
  const calls = new Map<string, ToolCall>();
  const order: string[] = [];
  const texts: string[] = [];
  let model = "unreported";
  let version: string | undefined;
  let init: AgentRun["init"] | undefined;
  let result: Record<string, unknown> | undefined;
  for (const event of events) {
    if (!isRecord(event)) continue;
    if (event.type === "system" && event.subtype === "init") {
      if (typeof event.model === "string") model = event.model;
      if (typeof event.claude_code_version === "string") version = event.claude_code_version;
      init = {
        ...(Array.isArray(event.tools) ? { tools: event.tools.map(String) } : {}),
        ...(Array.isArray(event.skills) ? { skills: event.skills.map(String) } : {}),
        ...(Array.isArray(event.slash_commands)
          ? { commands: event.slash_commands.map(String) }
          : {}),
        ...(Array.isArray(event.mcp_servers)
          ? {
              mcpServers: event.mcp_servers.map((server) =>
                isRecord(server) ? String(server.name ?? "") : String(server),
              ),
            }
          : {}),
      };
    } else if (event.type === "assistant" && isRecord(event.message)) {
      if (typeof event.message.model === "string" && model === "unreported")
        model = event.message.model;
      const content = Array.isArray(event.message.content) ? event.message.content : [];
      for (const part of content) {
        if (!isRecord(part)) continue;
        if (part.type === "text" && typeof part.text === "string" && part.text.trim())
          texts.push(part.text);
        if (part.type === "tool_use" && typeof part.id === "string") {
          const input = isRecord(part.input) ? part.input : {};
          const tool = String(part.name ?? "tool");
          const command =
            tool === "Bash" && typeof input.command === "string" ? input.command : undefined;
          order.push(part.id);
          calls.set(part.id, {
            index: order.length,
            tool,
            input,
            ...(command !== undefined ? { command } : {}),
          });
        }
      }
    } else if (event.type === "user" && isRecord(event.message)) {
      const content = Array.isArray(event.message.content) ? event.message.content : [];
      for (const part of content) {
        if (!isRecord(part) || part.type !== "tool_result") continue;
        const id = typeof part.tool_use_id === "string" ? part.tool_use_id : "";
        const call = calls.get(id);
        if (!call) continue;
        calls.set(id, {
          ...call,
          output: text(part.content).slice(0, 20_000),
          isError: part.is_error === true,
        });
      }
    } else if (event.type === "result") result = event;
  }
  const rawDenials: unknown = result?.permission_denials;
  const denials = Array.isArray(rawDenials)
    ? rawDenials.flatMap((entry: unknown) =>
        isRecord(entry)
          ? [
              {
                tool: String(entry.tool_name ?? ""),
                input: entry.tool_input,
                id: String(entry.tool_use_id ?? ""),
              },
            ]
          : [],
      )
    : [];
  const deniedIds = new Set(denials.map((denial) => denial.id));
  const toolCalls = order.map((id) => {
    const call = calls.get(id) as ToolCall;
    return deniedIds.has(id) ? { ...call, denied: true, isError: true } : call;
  });
  const usage = isRecord(result?.usage) ? result.usage : {};
  const num = (value: unknown): number | undefined =>
    typeof value === "number" ? value : undefined;
  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheCreate = num(usage.cache_creation_input_tokens);
  const modelUsage = isRecord(result?.modelUsage) ? Object.keys(result.modelUsage) : [];
  return {
    model:
      modelUsage.length === 1
        ? (modelUsage[0] as string)
        : modelUsage.length > 1
          ? modelUsage.join("+")
          : model,
    version,
    toolCalls,
    texts,
    finalMessage:
      typeof result?.result === "string" ? result.result : (texts[texts.length - 1] ?? ""),
    turns: num(result?.num_turns) ?? order.length,
    costUsd: num(result?.total_cost_usd),
    usage: {
      ...(num(result?.total_cost_usd) !== undefined
        ? { costUsd: num(result?.total_cost_usd) as number }
        : {}),
      ...(input !== undefined ? { inputTokens: input } : {}),
      ...(output !== undefined ? { outputTokens: output } : {}),
      ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
      ...(cacheCreate !== undefined ? { cacheCreationTokens: cacheCreate } : {}),
    },
    permissionDenials: denials.map(({ tool, input: toolInput }) => ({ tool, input: toolInput })),
    init,
    subtype: typeof result?.subtype === "string" ? result.subtype : undefined,
    isError: result?.is_error === true,
    resultText: typeof result?.result === "string" ? result.result : "",
    durationMs: num(result?.duration_ms),
  };
}

/** Claude Code ignores, without a word, a settings file that fails its own validation when it runs
 * headless: a typo would silently turn the sandbox off. `claude doctor` reads the settings files of
 * the folder it runs in and reports each invalid one, so the run's settings are checked there first. */
export async function invalidSettings(
  binary: string,
  settings: Record<string, unknown>,
  directory: string,
): Promise<string[]> {
  mkdirSync(join(directory, ".claude"), { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, ".claude", "settings.json"), JSON.stringify(settings), {
    mode: 0o600,
  });
  const run = spawnGroup(binary, ["doctor"], {
    cwd: directory,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NO_COLOR: "1" },
    timeoutMs: 60_000,
  });
  const finished = await run.done;
  const lines = `${finished.stdout}\n${finished.stderr}`.split("\n");
  const start = lines.findIndex((line) => /Invalid settings/i.test(line));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*$/.test(line)) break;
    if (line.startsWith("- ")) out.push(line.slice(2));
  }
  return out.length ? out : ["claude doctor reported invalid settings"];
}

const QUOTA =
  /usage limit|rate limit|rate_limit|quota|too many requests|\b429\b|overloaded|credit balance|limit reached|hit your (usage )?limit|resets? (at|in|on)\b|you've (reached|hit)/i;

/** A rate-limit event in the stream whose status says the call was refused. */
export function rateLimited(events: readonly unknown[]): string | undefined {
  for (const event of events) {
    if (!isRecord(event) || event.type !== "rate_limit_event") continue;
    const info = isRecord(event.rate_limit_info) ? event.rate_limit_info : {};
    const status = String(info.status ?? "");
    if (status && status !== "allowed" && status !== "allowed_warning")
      return `rate limit event: ${JSON.stringify(info).slice(0, 300)}`;
  }
  return undefined;
}

/** Whether the agent started with the runbook the owner installed: its skills (or, failing that, its
 * slash commands) name `rastrata`. `undefined` when the version says neither. */
export function runbookLoaded(init: AgentRun["init"] | undefined): boolean | undefined {
  const names = init?.skills ?? init?.commands;
  return names === undefined ? undefined : names.some((name) => name.includes("rastrata"));
}

export function claudeBinary(): string | undefined {
  return process.env.RASTRATA_EVAL_CLAUDE ?? Bun.which("claude") ?? undefined;
}

export function claudeCodeDriver(options: { restricted?: boolean } = {}): Driver {
  return {
    id: "claude-code",
    initAgent: "claude",
    programs: CLAUDE_PROGRAMS,
    label: "Claude Code",
    available: async (): Promise<Availability> => {
      const binary = claudeBinary();
      if (!binary) return { ok: false, reason: "claude is not installed (or not on PATH)" };
      const run = spawnGroup(binary, ["--version"], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        timeoutMs: 20_000,
      });
      const finished = await run.done;
      return finished.code === 0
        ? { ok: true, version: finished.stdout.trim() }
        : { ok: false, reason: `claude --version failed: ${finished.stderr.slice(0, 200)}` };
    },
    run: async (task: AgentTask): Promise<AgentRun> => {
      const binary = claudeBinary();
      if (!binary) throw new Error("claude is not installed");
      const version = await spawnGroup(binary, ["--version"], {
        cwd: task.projectDir,
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        timeoutMs: 20_000,
      }).done;
      const programs = task.probe ? PROBE_PROGRAMS : CLAUDE_PROGRAMS;
      const settingsFile = join(task.outputDir, "claude-settings.json");
      writeFileSync(
        settingsFile,
        `${JSON.stringify(
          claudeSettings({
            projectDir: task.projectDir,
            denyRead: [task.repoRoot, ...task.privateDirs, task.decoyPath],
            programs,
          }),
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      const problems = await invalidSettings(
        binary,
        JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>,
        join(task.outputDir, "doctor"),
      );
      if (problems.length)
        throw new Error(
          `Claude Code would ignore the run's sandbox settings: ${problems.join("; ")}`,
        );
      const model = task.model ?? "sonnet";
      const args = claudeArgs({
        settingsFile,
        model,
        maxTurns: task.limits.maxTurns,
        ...(task.limits.maxBudgetUsd !== undefined
          ? { maxBudgetUsd: task.limits.maxBudgetUsd }
          : {}),
        projectDir: task.projectDir,
        restricted: options.restricted ?? false,
        programs,
      });
      const events: unknown[] = [];
      const raw: string[] = [];
      const started = Date.now();
      let missingRunbook = false;
      const child = spawnGroup(binary, args, {
        cwd: task.projectDir,
        env: claudeEnvironment(task.env),
        stdin: task.prompt,
        timeoutMs: task.limits.timeoutMs,
        onStdout: lineSplitter((line) => {
          raw.push(line);
          try {
            const event = JSON.parse(line) as unknown;
            events.push(event);
            // A run without the runbook the owner installed measures nothing about the runbook:
            // stop it before it spends anything.
            if (
              isRecord(event) &&
              event.type === "system" &&
              event.subtype === "init" &&
              !task.probe
            ) {
              const loaded = runbookLoaded(parseClaudeEvents([event]).init);
              if (loaded === false) {
                missingRunbook = true;
                child.kill("SIGKILL");
              }
            }
          } catch {
            // A line that is not JSON is kept in the raw transcript only.
          }
        }),
      });
      let killed = false;
      task.signal?.addEventListener("abort", () => {
        killed = true;
        child.kill("SIGKILL");
      });
      const finished = await child.done;
      const transcript = join(task.outputDir, "claude-stream.jsonl");
      writeFileSync(transcript, `${raw.join("\n")}\n`, { mode: 0o600 });
      writeFileSync(join(task.outputDir, "claude-stderr.txt"), finished.stderr, { mode: 0o600 });
      const parsed = parseClaudeEvents(events);
      const limited = rateLimited(events);
      const quota =
        limited !== undefined ||
        (parsed.isError && QUOTA.test(`${parsed.resultText} ${finished.stderr}`)) ||
        (finished.code !== 0 && events.length === 0 && QUOTA.test(finished.stderr))
          ? { message: (limited ?? `${parsed.resultText || finished.stderr}`).trim().slice(0, 400) }
          : undefined;
      const notes = [
        `claude ${args.join(" ").replace(/--allowedTools .*? --settings/, "--allowedTools … --settings")}`,
        `settings: ${settingsFile}`,
      ];
      if (parsed.init?.tools) {
        const extra = parsed.init.tools.filter(
          (tool) => !(CLAUDE_TOOLS as readonly string[]).includes(tool),
        );
        if (extra.length)
          notes.push(`the agent listed tools outside the allowance: ${extra.join(", ")}`);
      }
      const loaded = runbookLoaded(parsed.init);
      if (loaded === false)
        notes.push("the agent's init did not list the rastrata skill: the run was stopped");
      else if (loaded === undefined)
        notes.push("the agent's init did not say which skills it loaded");
      return {
        agent: "claude-code",
        version: parsed.version ?? version.stdout.trim(),
        model: parsed.model,
        prompt: task.prompt,
        toolCalls: parsed.toolCalls,
        turns: parsed.turns,
        wallMs: Date.now() - started,
        finalMessage: parsed.finalMessage,
        usage: parsed.usage,
        exit: {
          code: finished.code,
          signal: finished.signal,
          ...(finished.timedOut ? { timedOut: true } : {}),
          ...(killed ? { killed: true } : {}),
          ...(missingRunbook ? { limit: "runbook-missing" } : {}),
          ...(!missingRunbook && parsed.subtype && parsed.subtype !== "success"
            ? { limit: parsed.subtype }
            : {}),
        },
        ...(quota ? { quota } : {}),
        permissionDenials: parsed.permissionDenials,
        ...(parsed.init ? { init: parsed.init } : {}),
        transcript: existsSync(transcript) ? transcript : "",
        notes,
        texts: parsed.texts,
      };
    },
  };
}

/** What every agent driver records, whatever the agent: who it was, what it was asked, what it did,
 * how long and how much it took. The grader and the audit read only this and the book, so a new
 * driver is a parser and a command line, nothing more. */

import type { World } from "../world.ts";

export type AgentId = "claude-code" | "codex" | "opencode" | "standin";

export interface ToolCall {
  /** 1-based order in the run. */
  readonly index: number;
  /** The agent's own name for the tool (`Bash`, `Read`, `command_execution`, ...). */
  readonly tool: string;
  /** What the agent asked the tool to do. For a shell tool, `command` is the command line. */
  readonly input: Record<string, unknown>;
  readonly command?: string;
  /** What came back, truncated. */
  readonly output?: string;
  readonly isError?: boolean;
  /** The agent's own permission layer refused the call (nothing ran). */
  readonly denied?: boolean;
  readonly at?: string;
}

export interface Usage {
  readonly costUsd?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
}

export interface AgentRun {
  readonly agent: AgentId;
  /** The program's own version string, as it printed it. */
  readonly version: string;
  /** The model as the agent reported it. `unreported` when the agent does not say. */
  readonly model: string;
  readonly prompt: string;
  readonly toolCalls: readonly ToolCall[];
  readonly turns: number;
  readonly wallMs: number;
  readonly finalMessage: string;
  readonly usage: Usage;
  readonly exit: {
    readonly code: number | null;
    readonly signal?: string | null;
    readonly timedOut?: boolean;
    /** The harness stopped it on purpose (the kill-and-resume scenario). */
    readonly killed?: boolean;
    /** The agent stopped at its turn or spend limit. */
    readonly limit?: string;
  };
  /** A quota or rate limit stopped the run: never retried. */
  readonly quota?: { readonly message: string };
  /** The agent's own permission layer refused these calls. */
  readonly permissionDenials: readonly { readonly tool: string; readonly input: unknown }[];
  /** What the agent said about how it was started: the tools and skills it could see. */
  readonly init?: {
    readonly tools?: readonly string[];
    readonly skills?: readonly string[];
    /** The slash commands the agent listed (a skill is also offered as one). */
    readonly commands?: readonly string[];
    readonly mcpServers?: readonly string[];
    readonly sandbox?: string;
  };
  /** Path of the raw transcript in the (git-ignored) output directory. */
  readonly transcript?: string;
  /** Anything the driver wants a reader to know: how it was invoked, caveats. */
  readonly notes: readonly string[];
  /** Every piece of text the agent wrote to the owner or to itself, in order, for the secret scan
   * and for a person's review. The last is usually the final message. */
  readonly texts: readonly string[];
}

export interface AgentTask {
  readonly prompt: string;
  /** The world the book was built from. A scripted agent knows the right answers from it; a real
   * agent's driver never reads it. */
  readonly world: World;
  /** The working directory: the scratch project. */
  readonly projectDir: string;
  /** The agent's whole environment (the token and the proxy's address included). */
  readonly env: Record<string, string>;
  /** Directories the harness keeps outside the agent's reach (owner key, database, decoy). */
  readonly privateDirs: readonly string[];
  readonly repoRoot: string;
  /** Where the decoy owner key is. A scripted agent that misbehaves reads it; a real driver puts it
   * in the sandbox's deny list along with the private directories. */
  readonly decoyPath: string;
  /** The service's address as the agent sees it (the tracing proxy). */
  readonly endpoint: string;
  readonly limits: {
    readonly maxTurns: number;
    readonly timeoutMs: number;
    readonly maxBudgetUsd?: number;
  };
  readonly model?: string;
  /** Where to write the raw transcript and the driver's own files. */
  readonly outputDir: string;
  /** Aborted when the harness decides to stop the agent (kill-and-resume). */
  readonly signal?: AbortSignal;
  readonly token: { readonly secret: string; readonly permissions: readonly string[] };
  /** The sandbox probe: the agent may also run `touch` and `curl`, which must fail inside its
   * sandbox, and the runbook is not required. Never set for a scenario. */
  readonly probe?: boolean;
}

export interface Availability {
  readonly ok: boolean;
  readonly version?: string;
  readonly reason?: string;
}

export interface Driver {
  readonly id: AgentId;
  readonly label: string;
  /** Which agent's files `rastrata agent init` writes into the project for this driver. */
  readonly initAgent: "claude" | "codex" | "opencode";
  /** The programs this driver lets the agent run in the shell (a bookkeeper's by default): what the
   * audit calls ordinary for this agent. */
  readonly programs?: readonly string[];
  available(): Promise<Availability>;
  run(task: AgentTask): Promise<AgentRun>;
}

/** The shell commands an allowance may name: `rastrata ...` only. */
export const ALLOWED_COMMAND = /^\s*rastrata(\s|$)/;

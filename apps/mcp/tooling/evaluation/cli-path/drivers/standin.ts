import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { World } from "../world.ts";
import { Cli, Killed } from "./cli.ts";
import type { Routine } from "./routines.ts";
import type { AgentRun, AgentTask, Availability, Driver } from "./types.ts";

export interface StandInContext {
  readonly cli: Cli;
  readonly world: World;
  readonly task: AgentTask;
  readonly routine: Routine;
}

/** A script: the final message a scripted agent would give, after the calls it made. */
export type StandInScript = (context: StandInContext) => Promise<string>;

/** A deterministic stand-in for an agent: it runs a script of `rastrata` commands through the same
 * environment, project folder and recording a real agent gets, so the harness, the oracle and the
 * grader are tested with no model. It is not sandboxed (a real agent's sandbox is its driver's job);
 * the scripts that misbehave do so on purpose, and the audit is what must catch them. */
export function standInDriver(options: { name: string; script: StandInScript }): Driver {
  return {
    id: "standin",
    initAgent: "claude",
    label: `stand-in (${options.name})`,
    available: async (): Promise<Availability> => ({ ok: true, version: "standin-1" }),
    run: async (task: AgentTask): Promise<AgentRun> => {
      const started = Date.now();
      const cli = new Cli({
        cwd: task.projectDir,
        env: task.env,
        binDir: join(task.env.PATH?.split(":")[0] ?? ""),
        ...(task.signal ? { signal: task.signal } : {}),
        timeoutMs: task.limits.timeoutMs,
      });
      const world: World = task.world;
      const routine: Routine = {
        cli,
        world,
        projectDir: task.projectDir,
        permissions: new Set(),
        report: [],
      };
      let finalMessage = "";
      let killed = false;
      try {
        finalMessage = await options.script({ cli, world, task, routine });
      } catch (error) {
        if (error instanceof Killed) killed = true;
        else throw error;
      }
      const transcript = join(task.outputDir, "standin-calls.json");
      writeFileSync(transcript, `${JSON.stringify(cli.calls, null, 2)}\n`, { mode: 0o600 });
      return {
        agent: "standin",
        version: "standin-1",
        model: `scripted:${options.name}`,
        prompt: task.prompt,
        toolCalls: cli.calls,
        turns: cli.calls.length,
        wallMs: Date.now() - started,
        finalMessage,
        usage: {},
        exit: { code: killed ? null : 0, ...(killed ? { killed: true } : {}) },
        permissionDenials: [],
        texts: [finalMessage],
        transcript,
        notes: ["A scripted agent: no model, no sandbox."],
      };
    },
  };
}

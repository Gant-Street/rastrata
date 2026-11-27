/** Two small things a run and a regrade both do: read the world as a scenario sees it, and make one
 * run of the sessions of a scenario that has several. */
import type { AgentRun } from "./drivers/types.ts";
import type { ScenarioSpec } from "./spec.ts";
import type { LineExpectation, World } from "./world.ts";

/** The world as a scenario reads it: only the files it brings in, each line as the scenario sees it. */
export function scoped(world: World, spec: ScenarioSpec): World {
  const view = spec.lineView ?? ((line: LineExpectation) => line);
  const lines = world.lines.filter((line) => spec.files.includes(line.file));
  return { ...world, lines: lines.map((line) => view(line, lines)) };
}

/** One run from the sessions of a scenario: calls renumbered, turns, time, cost and tokens added up,
 * the last session's final message and exit. */
export const merge = (runs: readonly AgentRun[]): AgentRun => {
  const first = runs[0] as AgentRun;
  const last = runs[runs.length - 1] as AgentRun;
  const sum = (pick: (run: AgentRun) => number | undefined): number | undefined => {
    const values = runs.map(pick).filter((value): value is number => value !== undefined);
    return values.length ? values.reduce((a, b) => a + b, 0) : undefined;
  };
  const cost = sum((run) => run.usage.costUsd);
  const input = sum((run) => run.usage.inputTokens);
  const output = sum((run) => run.usage.outputTokens);
  const cacheRead = sum((run) => run.usage.cacheReadTokens);
  let index = 0;
  return {
    ...first,
    prompt: runs.map((run) => run.prompt).join("\n\n---\n\n"),
    toolCalls: runs.flatMap((run) => run.toolCalls).map((call) => ({ ...call, index: ++index })),
    turns: runs.reduce((total, run) => total + run.turns, 0),
    wallMs: runs.reduce((total, run) => total + run.wallMs, 0),
    finalMessage: last.finalMessage,
    usage: {
      ...(cost !== undefined ? { costUsd: cost } : {}),
      ...(input !== undefined ? { inputTokens: input } : {}),
      ...(output !== undefined ? { outputTokens: output } : {}),
      ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    },
    exit: last.exit,
    permissionDenials: runs.flatMap((run) => run.permissionDenials),
    texts: runs.flatMap((run) => run.texts),
    notes: runs.flatMap((run) => run.notes),
  };
};

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { closing, dec } from "@rastrata/application/testing/evaluation-fixtures";
import { audit } from "./audit.ts";
import { type BookSnapshot, readBook } from "./book.ts";
import type { AgentRun, AgentTask, Driver } from "./drivers/types.ts";
import { type Grade, gradeRun } from "./grade.ts";
import { withModelRunLock } from "./lock.ts";
import { REPO_ROOT, builtFromCheckout, checkoutKitDigest } from "./paths.ts";
import { diffFingerprints, fingerprint } from "./project.ts";
import { openSession } from "./session.ts";
import type { PromptContext, ScenarioSpec } from "./spec.ts";
import { loadBookkeepingSkill } from "../../../src/skill.ts";
import { merge, scoped } from "./merge.ts";
import { sha256Hex } from "./util.ts";

export interface RunOptions {
  readonly spec: ScenarioSpec;
  readonly driver: Driver;
  /** A directory that does not exist yet: a run's evidence is never overwritten. */
  readonly outputDir: string;
  readonly model?: string;
  readonly repeat?: number;
  /** Take the machine-wide model-run lock (every real driver does). */
  readonly lock?: boolean;
  /** Check the repository's working tree before and after (advisory). */
  readonly watchRepo?: boolean;
  readonly log?: (message: string) => void;
}

export interface RunResult {
  readonly outputDir: string;
  readonly spec: ScenarioSpec;
  readonly grade: Grade;
  readonly runs: readonly AgentRun[];
  /** A quota or rate limit stopped a session: the caller stops the whole suite. */
  readonly quota: string | undefined;
}

function repoState(): string {
  const run = Bun.spawnSync(["git", "-C", REPO_ROOT, "status", "--porcelain"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return run.stdout.toString();
}

function readProjectText(directory: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && statSync(full).size <= 2_000_000)
        out.push(readFileSync(full, "utf8"));
    }
  };
  walk(directory);
  return out;
}

/** One scenario on one agent: a fresh book, a token made the owner's way, a scratch project, the
 * agent, and then the grade, from the book. Everything the run produced is written to `outputDir`
 * (which should be git-ignored); no secret is written to it. */
export async function runScenario(options: RunOptions): Promise<RunResult> {
  const { spec, driver } = options;
  mkdirSync(options.outputDir, { mode: 0o700 });
  const log = options.log ?? (() => {});
  const session = await openSession({
    stage: spec.stage,
    variant: spec.variant,
    grant: spec.grant,
    initAgent: driver.initAgent,
    files: spec.files,
    ...(spec.extras ? { extras: spec.extras } : {}),
    ...(spec.poisonStripe ? { poisonStripe: true } : {}),
    ...(spec.withApril ? { april: true } : {}),
    log,
  });
  const runs: AgentRun[] = [];
  const checkpoints: BookSnapshot[] = [];
  let quota: string | undefined;
  try {
    // The runbook the agent will read is the one in this checkout: a command built from older sources
    // would measure text nobody ships. (A command named from outside is the person's own choice.)
    const kitDigest = (session.project.initResult as { kitDigest?: string }).kitDigest ?? "";
    if (builtFromCheckout() && kitDigest !== checkoutKitDigest())
      throw new Error(
        `The rastrata command wrote runbook ${kitDigest || "(none)"} but this checkout's is ${checkoutKitDigest()}: the command is stale. Nothing was run.`,
      );
    const before: BookSnapshot = await readBook(session.owner, session.token.id);
    const handEntered = before.journals.find(
      (journal) => journal.narration === "March rent, entered by hand",
    )?.id as string | undefined;
    const statementBalances: Record<string, string> = {};
    for (const file of session.world.files)
      statementBalances[file.account] = dec(
        closing(file.rows, file.account as "1000" | "1010" | "2000"),
      );
    const graded = scoped(session.world, spec);
    const context: PromptContext = {
      world: session.world,
      project: session.project,
      token: session.token,
      statementBalances,
    };
    const projectBefore = fingerprint(session.project.dir);
    // What the wire saw before the agent began (`agent init` looks at the service) is not the agent's.
    const wireStart = session.proxy.records.length;
    const repoBefore = options.watchRepo ? repoState() : "";

    const sessions = spec.sessions ?? [{ name: "run", prompt: spec.prompt }];
    let writes = 0;
    let active: { limit: number; controller: AbortController } | undefined;
    session.proxy.onRecord((record) => {
      if (!record.write) return;
      writes += 1;
      if (active && writes >= active.limit) active.controller.abort();
    });

    const execute = async () => {
      for (const [number, step] of sessions.entries()) {
        const controller = new AbortController();
        active = step.killAfterWrites
          ? { limit: writes + step.killAfterWrites, controller }
          : undefined;
        const outputDir = join(
          options.outputDir,
          sessions.length > 1 ? `session-${number + 1}-${step.name}` : "agent",
        );
        mkdirSync(outputDir, { recursive: true, mode: 0o700 });
        const task: AgentTask = {
          prompt: step.prompt(context),
          // The world as this scenario reads it: a scripted right agent reads the same key as the grader.
          world: graded,
          projectDir: session.project.dir,
          env: session.agentEnv,
          privateDirs: [
            session.service.directory,
            session.project.privateDir,
            join(session.root, "owner"),
          ],
          repoRoot: REPO_ROOT,
          decoyPath: session.project.decoyPath,
          endpoint: session.proxy.url,
          limits: spec.limits,
          ...(options.model ? { model: options.model } : {}),
          outputDir,
          signal: controller.signal,
          token: { secret: session.token.secret, permissions: session.token.permissions },
        };
        log(`${spec.id}: ${driver.label}, session ${number + 1}/${sessions.length} (${step.name})`);
        const run = await driver.run(task);
        runs.push(run);
        if (sessions.length > 1) checkpoints.push(await readBook(session.owner, session.token.id));
        writeFileSync(
          join(outputDir, "run.json"),
          `${JSON.stringify({ ...run, toolCalls: undefined, texts: undefined }, null, 2)}\n`,
          { mode: 0o600 },
        );
        writeFileSync(
          join(outputDir, "tool-calls.json"),
          `${JSON.stringify(run.toolCalls, null, 2)}\n`,
          { mode: 0o600 },
        );
        writeFileSync(join(outputDir, "final-message.txt"), `${run.finalMessage}\n`, {
          mode: 0o600,
        });
        writeFileSync(join(outputDir, "prompt.txt"), `${task.prompt}\n`, { mode: 0o600 });
        if (run.quota) {
          quota = run.quota.message;
          break;
        }
      }
    };
    if (options.lock) await withModelRunLock(`${spec.id} on ${driver.id}`, execute, { log });
    else await execute();

    const after = await readBook(session.owner, session.token.id);
    const merged = merge(runs);
    const projectAfter = fingerprint(session.project.dir);
    const changes = diffFingerprints(projectBefore, projectAfter);
    const privatePaths = [
      session.service.directory,
      session.project.privateDir,
      session.project.decoyPath,
      join(session.root, "owner"),
    ];
    const result = audit({
      run: merged,
      projectDir: session.project.dir,
      endpoint: session.proxy.url,
      token: { id: session.token.id, secret: session.token.secret },
      wire: session.proxy.records.slice(wireStart),
      projectChanges: changes,
      projectText: readProjectText(session.project.dir),
      ...(options.watchRepo ? { repo: { before: repoBefore, after: repoState() } } : {}),
      transcriptText: [
        ...merged.texts,
        merged.finalMessage,
        ...merged.toolCalls.flatMap((call) => [
          call.command ?? "",
          call.output ?? "",
          JSON.stringify(call.input),
        ]),
      ],
      privatePaths,
      homeDir: homedir(),
      repoRoot: REPO_ROOT,
      ...(driver.programs ? { allowedPrograms: driver.programs } : {}),
    });
    const grade = gradeRun({
      spec,
      world: graded,
      before,
      after,
      wire: session.proxy.records.slice(wireStart),
      run: merged,
      audit: result,
      token: session.token,
      handEntered,
      ...(checkpoints.length ? { checkpoints } : {}),
    });

    // What the agent wrote into its project (a note, a report) is kept with the run, small and plain.
    for (const path of result.wroteFiles.slice(0, 50)) {
      const from = join(session.project.dir, path);
      if (!existsSync(from) || statSync(from).size > 200_000) continue;
      const to = join(options.outputDir, "project-files", path);
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      copyFileSync(from, to);
    }

    const skill = loadBookkeepingSkill();
    const metadata = {
      format: "rastrata-cli-path-evaluation-v1",
      scenario: spec.id,
      title: spec.title,
      repeat: options.repeat ?? 1,
      startedAt: new Date().toISOString(),
      commit: Bun.spawnSync(["git", "-C", REPO_ROOT, "rev-parse", "HEAD"], { stdout: "pipe" })
        .stdout.toString()
        .trim(),
      dirty: repoState() !== "",
      skillDigest: skill.digest,
      kitDigest: (session.project.initResult as { kitDigest?: string }).kitDigest ?? "",
      agent: {
        id: merged.agent,
        version: merged.version,
        model: merged.model,
        init: merged.init ?? null,
      },
      stage: spec.stage,
      variant: spec.variant,
      token: {
        id: session.token.id,
        permissions: session.token.permissions,
        preset: session.token.preset ?? null,
      },
      limits: spec.limits,
      // What a later regrade needs to read the commands as the audit did: where the project was, the
      // address the agent was given, and the harness's private folders (paths, never contents).
      projectDir: session.project.dir,
      endpoint: session.proxy.url,
      privatePaths,
      homeDir: homedir(),
      repoRoot: REPO_ROOT,
      ...(driver.programs ? { allowedPrograms: driver.programs } : {}),
      projectChanges: changes,
      wroteFiles: result.wroteFiles,
      warnings: result.warnings,
      sessions: sessions.map((step) => step.name),
      quota: quota ?? null,
    };
    writeFileSync(
      join(options.outputDir, "metadata.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
      { mode: 0o600 },
    );
    writeFileSync(join(options.outputDir, "grade.json"), `${JSON.stringify(grade, null, 2)}\n`, {
      mode: 0o600,
    });
    const wireText = (records: readonly unknown[]): string =>
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    writeFileSync(
      join(options.outputDir, "wire.jsonl"),
      wireText(session.proxy.records.slice(wireStart)),
      { mode: 0o600 },
    );
    writeFileSync(
      join(options.outputDir, "wire-setup.jsonl"),
      wireText(session.proxy.records.slice(0, wireStart)),
      { mode: 0o600 },
    );
    writeFileSync(
      join(options.outputDir, "book-after.json"),
      `${JSON.stringify(after, null, 1)}\n`,
      { mode: 0o600 },
    );
    // What a regrade needs to grade the book again: the book as the run began, and between sessions.
    writeFileSync(
      join(options.outputDir, "book-before.json"),
      `${JSON.stringify(before, null, 1)}\n`,
      { mode: 0o600 },
    );
    if (checkpoints.length)
      writeFileSync(
        join(options.outputDir, "checkpoints.json"),
        `${JSON.stringify(checkpoints, null, 1)}\n`,
        { mode: 0o600 },
      );
    writeFileSync(join(options.outputDir, "digest.txt"), `${sha256Hex(JSON.stringify(grade))}\n`, {
      mode: 0o600,
    });
    if (grade.sandbox.breached)
      console.error(
        `\n*** SANDBOX BREACH in ${spec.id} on ${driver.label}: ${grade.sandbox.findings
          .filter((finding) => finding.outcome === "succeeded")
          .map((finding) => `${finding.kind} (${finding.detail})`)
          .join("; ")}\n`,
      );
    return { outputDir: options.outputDir, spec, grade, runs, quota };
  } finally {
    await session.close();
  }
}

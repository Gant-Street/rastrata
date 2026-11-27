import { spawnSync } from "node:child_process";

export interface TestExecution {
  readonly status: number | null;
  readonly signal: string | null;
  readonly error?: Error;
  readonly stdout: string;
  readonly stderr: string;
}

export function classifyTestExecution(
  result: TestExecution,
): "SURVIVED" | "KILLED" | "WORKER_ERROR" {
  const output = `${result.stdout}\n${result.stderr}`;
  // Neither an infrastructure failure nor an uncompleted test is accounting
  // evidence. In particular, Bun exits 1 for both assertions and timeouts.
  if (
    result.error !== undefined ||
    result.signal !== null ||
    /timed out|timeout|TimeoutError/i.test(output)
  )
    return "WORKER_ERROR";
  if (
    result.status === 0 &&
    /^\s*[1-9]\d* pass\s*$/m.test(output) &&
    /^\s*0 fail\s*$/m.test(output)
  )
    return "SURVIVED";
  if (result.status === 1 && /^\(fail\) /m.test(output)) return "KILLED";
  // A build-valid mutant can throw while a fixture imports the kernel, before
  // Bun enters a test body. Require a kernel stack frame and Bun's explicit
  // runtime-error marker; a generic exit-1 or missing dependency is not a kill.
  if (
    result.status === 1 &&
    /^# Unhandled error between tests$/m.test(output) &&
    /^\s+at .*\/packages\/kernel\/src\/[^\n]+:\d+:\d+/m.test(output) &&
    !/^(?:SyntaxError:|error: (?:Cannot find|Could not resolve)|.*\b(?:ENOENT|EACCES|ENOMEM|ENOSPC|EMFILE)\b)/m.test(
      output,
    )
  )
    return "KILLED";
  return "WORKER_ERROR";
}

export function runMutationTests(cwd: string, files: readonly string[]): TestExecution {
  return spawnSync("bun", ["test", "--no-orphans", "--timeout=30000", "--bail=1", ...files], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
  });
}

export function computeMutantFingerprint(params: {
  sourceDepHash: string;
  sharedInfraHash: string;
  testedFilesHash: string;
  line: number;
  description: string;
}): string {
  return Bun.SHA256.hash(
    `${params.sourceDepHash}:${params.sharedInfraHash}:${params.testedFilesHash}:${params.line}:${params.description}`,
    "hex",
  );
}

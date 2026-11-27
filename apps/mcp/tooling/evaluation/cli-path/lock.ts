import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sleep } from "./util.ts";

/** One lock for the whole machine. A test names its own with RASTRATA_EVAL_LOCK, so it can never
 * wait on a real baseline that is running. */
const lockPath = (): string =>
  process.env.RASTRATA_EVAL_LOCK ?? join(tmpdir(), "rastrata-evals-model-run.lock");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One model run at a time on this machine, whichever harness process asks. A real run spends the
 * owner's allowance and loads the machine; two at once would also make each other's timing and
 * quota meaningless. The lock is a directory (creating it is atomic) naming its owner; one whose
 * owner has gone is taken over. */
export async function withModelRunLock<T>(
  label: string,
  work: () => Promise<T>,
  options: { waitMs?: number; log?: (message: string) => void } = {},
): Promise<T> {
  const lock = lockPath();
  const deadline = Date.now() + (options.waitMs ?? 3 * 60 * 60_000);
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(
        join(lock, "owner.json"),
        JSON.stringify({ pid: process.pid, label, at: new Date().toISOString() }),
      );
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { pid?: number; label?: string } = {};
      try {
        owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
      } catch {
        // Being written: look again shortly.
      }
      if (owner.pid !== undefined && !alive(owner.pid)) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline)
        throw new Error(`Another model run (${owner.label ?? "unknown"}) still holds the lock`);
      options.log?.(`waiting for the model-run lock held by ${owner.label ?? "another run"}`);
      await sleep(2_000);
    }
  }
  const release = () => rmSync(lock, { recursive: true, force: true });
  process.once("exit", release);
  try {
    return await work();
  } finally {
    process.removeListener("exit", release);
    release();
  }
}

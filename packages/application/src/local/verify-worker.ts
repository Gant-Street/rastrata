import { drillBackupFile, verifyBackupFile, type VerifyTask } from "./verify.ts";
import { threadCpuSeconds } from "./thread-cpu.ts";
import type { WorkerMessage } from "./worker.ts";

// A worker thread for the long checks: it holds the whole replayed book in its own memory and its
// own event loop, so the service that asked for it keeps answering requests.
declare const self: Worker;
const post = (message: WorkerMessage) => self.postMessage(message);

self.onmessage = async (event: MessageEvent<VerifyTask>) => {
  const { kind, ...task } = event.data;
  const cpuBefore = threadCpuSeconds();
  // Progress is throttled: a replay reports every page of outcomes, and the page rate is high.
  let last = 0;
  const progress = (update: Parameters<NonNullable<Parameters<typeof verifyBackupFile>[1]>>[0]) => {
    const now = Date.now();
    if (update.stage === undefined && now - last < 150) return;
    last = now;
    post({ type: "progress", update });
  };
  try {
    const value =
      kind === "drill"
        ? await drillBackupFile(task, progress)
        : await verifyBackupFile(task, progress);
    post({ type: "result", value, cpuSeconds: threadCpuSeconds() - cpuBefore });
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};

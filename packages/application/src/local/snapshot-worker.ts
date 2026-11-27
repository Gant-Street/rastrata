import { takeSnapshot, type SnapshotTask } from "./snapshot.ts";
import { threadCpuSeconds } from "./thread-cpu.ts";
import type { WorkerMessage } from "./worker.ts";

// A worker thread: nothing here may import the application service or the kernel, so a snapshot
// starts quickly and holds no book in memory.
declare const self: Worker;
const post = (message: WorkerMessage) => self.postMessage(message);

self.onmessage = (event: MessageEvent<SnapshotTask>) => {
  const cpuBefore = threadCpuSeconds();
  try {
    const value = takeSnapshot(event.data);
    post({ type: "result", value, cpuSeconds: threadCpuSeconds() - cpuBefore });
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};

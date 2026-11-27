import type { ProgressUpdate } from "../safety/types.ts";
import { observeJob } from "../telemetry.ts";

/** What a worker sends back. Only JSON-safe values travel: strings, numbers, arrays and objects.
 * A result may say how much CPU the worker thread used on the task (`cpuSeconds`), which only the
 * worker can know. */
export type WorkerMessage =
  | { readonly type: "progress"; readonly update: ProgressUpdate }
  | { readonly type: "result"; readonly value: unknown; readonly cpuSeconds?: number }
  | { readonly type: "error"; readonly message: string };

const running = new Set<Worker>();

/** Stop every worker still running: shutdown, or a person who gave up waiting. */
export function terminateWorkers(): void {
  for (const worker of running) worker.terminate();
  running.clear();
}

/**
 * Run one task in a worker thread and wait for its answer. The task and the answer are plain data;
 * progress messages arrive as the worker sends them. A worker that dies without answering rejects,
 * and the worker is always terminated. Heavy work (a database snapshot, a ledger replay) goes here
 * so the service's event loop keeps answering requests.
 */
export function runInWorker<T>(
  entry: string,
  task: unknown,
  onProgress?: (update: ProgressUpdate) => void,
): Promise<T> {
  // A task that is not a backup's snapshot is a verification or a restore drill.
  const type = entry.includes("snapshot-worker") ? "backup" : "verify";
  return observeJob(type, (reportCpu) => startWorker<T>(entry, task, onProgress, reportCpu));
}

function startWorker<T>(
  entry: string,
  task: unknown,
  onProgress: ((update: ProgressUpdate) => void) | undefined,
  reportCpu: (cpuSeconds: number) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(entry);
    running.add(worker);
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      running.delete(worker);
      worker.terminate();
      action();
    };
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === "progress") onProgress?.(message.update);
      else if (message.type === "result") {
        reportCpu(message.cpuSeconds ?? 0);
        finish(() => resolve(message.value as T));
      } else finish(() => reject(new Error(message.message)));
    };
    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault?.();
      finish(() => reject(new Error(event.message || "The worker failed")));
    };
    worker.addEventListener("close", () =>
      finish(() => reject(new Error("The worker stopped before it answered"))),
    );
    worker.postMessage(task);
  });
}

/** The entry file of a worker next to this one. */
export const workerEntry = (name: string): string => new URL(`./${name}`, import.meta.url).href;

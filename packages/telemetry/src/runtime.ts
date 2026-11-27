/** What the process itself costs: memory, CPU, event-loop lag, idleness, and the helpers the
 * instrumentation uses to attribute CPU to requests and to find the peak memory of an activation.
 * Everything here is used only when telemetry is on; `trackWork`, `trackPeakMemory` and the
 * attribution are no-ops otherwise. */
import { counter, gauge, histogram, telemetryEnabled } from "./api.ts";

type Usage = { user: number; system: number };

/** CPU seconds used by the calling thread. The JavaScript of the API runs on one thread, so this is
 * exactly the CPU of the requests, with none of the garbage collector's or a worker's. Falls back to
 * the whole process where the runtime has no per-thread figure. */
export function threadCpuSeconds(): number {
  const read = (process as { threadCpuUsage?: () => Usage }).threadCpuUsage;
  const usage = typeof read === "function" ? read.call(process) : process.cpuUsage();
  return (usage.user + usage.system) / 1e6;
}

export interface CpuTicket {
  /** CPU seconds attributed to this ticket so far. */
  cpu: number;
}

/** Shares the thread's CPU out among the requests in flight. Whenever the set of requests changes
 * (one begins, one ends), the CPU used since the last change is divided equally among those that were
 * in flight, so the sum over all requests equals the CPU of the thread while any request was in
 * flight: nothing is counted twice when requests overlap, as it would be if each request simply
 * read the clock at its start and its end. An equal share is an approximation when overlapping
 * requests cost different amounts, but it is exact when they do not overlap, and exact in total. */
export class CpuAttribution {
  private last: number;
  private readonly active = new Set<CpuTicket>();

  constructor(private readonly clock: () => number = threadCpuSeconds) {
    this.last = clock();
  }

  get inFlight(): number {
    return this.active.size;
  }

  begin(): CpuTicket {
    this.settle();
    const ticket: CpuTicket = { cpu: 0 };
    this.active.add(ticket);
    return ticket;
  }

  /** Stop attributing to `ticket`; returns the CPU seconds it was given. */
  end(ticket: CpuTicket): number {
    this.settle();
    this.active.delete(ticket);
    return ticket.cpu;
  }

  private settle(): void {
    const now = this.clock();
    const spent = now - this.last;
    this.last = now;
    if (spent > 0 && this.active.size > 0) {
      const share = spent / this.active.size;
      for (const ticket of this.active) ticket.cpu += share;
    }
  }
}

/** The one attribution the API's requests share. */
export const requestCpu = new CpuAttribution();

// ---- Idle ------------------------------------------------------------------------------------

let working = 0;
let idleSince = performance.now();
const NOTHING = () => {};

/** Note that a request or a job began; call the function returned when it is over. While anything is
 * in flight the process is not idle (`process.idle.time` is 0): a pod that never goes idle never
 * frees its books. A no-op with telemetry off. */
export function trackWork(): () => void {
  if (!telemetryEnabled()) return NOTHING;
  working += 1;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    working -= 1;
    if (working === 0) idleSince = performance.now();
  };
}

/** Seconds since the process last had nothing in flight; 0 while something is. */
export function idleSeconds(): number {
  return working > 0 ? 0 : (performance.now() - idleSince) / 1000;
}

// ---- Peak memory -----------------------------------------------------------------------------

export interface PeakMemory {
  /** Stop watching; the highest resident set, in bytes, seen since it began. 0 with telemetry off. */
  stop(): number;
}
const NO_PEAK: PeakMemory = { stop: () => 0 };

/** Watch the resident set while something runs (an activation, a job) and say how high it went.
 * It samples every 20 ms, plus once at each end, so a spike shorter than that and entirely inside
 * one synchronous stretch can be missed; the replay hands the thread back every 20 ms, which is
 * what makes this sample useful. A no-op with telemetry off. */
export function trackPeakMemory(): PeakMemory {
  if (!telemetryEnabled()) return NO_PEAK;
  let peak = process.memoryUsage.rss();
  const timer = setInterval(() => {
    const now = process.memoryUsage.rss();
    if (now > peak) peak = now;
  }, 20);
  (timer as { unref?: () => void }).unref?.();
  return {
    stop() {
      clearInterval(timer);
      return Math.max(peak, process.memoryUsage.rss());
    },
  };
}

// ---- The sampler -----------------------------------------------------------------------------

async function containerMemoryLimit(): Promise<number | undefined> {
  try {
    const { readFileSync } = await import("node:fs");
    for (const path of [
      "/sys/fs/cgroup/memory.max",
      "/sys/fs/cgroup/memory/memory.limit_in_bytes",
    ]) {
      try {
        const text = readFileSync(path, "utf8").trim();
        if (text === "max") continue;
        const bytes = Number(text);
        // cgroup v1 says "no limit" with a number near 2^63.
        if (Number.isFinite(bytes) && bytes > 0 && bytes < 2 ** 52) return bytes;
      } catch {
        // Not that file.
      }
    }
  } catch {
    // No file system (not on a Linux host): no limit to report.
  }
  return undefined;
}

/** Start reading the process's own numbers: memory (resident, heap, external), CPU time, idle time,
 * how late a 100 ms timer fires (the event loop being held up), and the container's memory limit.
 * Returns the function that stops it. Timers do not keep the process alive. */
export function startRuntimeTelemetry(options: {
  sampleMs: number;
  /** Called on every sample, for numbers only the caller can read. */
  onTick?: () => void;
}): () => void {
  const memory = gauge("process.memory");
  const idle = gauge("process.idle.time");
  const cpu = counter("process.cpu.time");
  const lag = histogram("process.event_loop.lag");
  let last = process.cpuUsage();
  const sample = () => {
    const usage = process.memoryUsage();
    memory.set(usage.rss, { memory_kind: "rss" });
    memory.set(usage.heapUsed, { memory_kind: "heap_used" });
    memory.set(usage.external, { memory_kind: "external" });
    const now = process.cpuUsage();
    cpu.add(Math.max(0, now.user - last.user) / 1e6, { cpu_mode: "user" });
    cpu.add(Math.max(0, now.system - last.system) / 1e6, { cpu_mode: "system" });
    last = now;
    idle.set(idleSeconds());
    try {
      options.onTick?.();
    } catch {
      // Reading a number for telemetry must never be able to fail anything.
    }
  };
  sample();
  const sampler = setInterval(sample, options.sampleMs);
  let expected = performance.now() + 100;
  const watcher = setInterval(() => {
    const now = performance.now();
    lag.record(Math.max(0, now - expected) / 1000);
    expected = now + 100;
  }, 100);
  for (const timer of [sampler, watcher]) (timer as { unref?: () => void }).unref?.();
  void containerMemoryLimit().then((bytes) => {
    if (bytes !== undefined) gauge("process.memory.limit").set(bytes);
  });
  return () => {
    clearInterval(sampler);
    clearInterval(watcher);
  };
}

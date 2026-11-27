// The real API server, a storm of requests, and a collector that is down, never answers, answers a
// second late, or is healthy. What must hold whatever the collector does: every request is answered,
// the process ends by itself with a success status, nothing is written to stderr, the queue stays
// bounded, what was lost is counted and shown on /health, and (on a quiet machine) the latency a
// request sees is the latency it sees with telemetry off.
import { afterAll, describe, expect, test } from "bun:test";
import { cpus, loadavg } from "node:os";
import { fileURLToPath } from "node:url";
import type { TelemetryStatus } from "@rastrata/telemetry";
import { standIn, closedPort, type StandIn } from "./support/collector.ts";

interface Result {
  readonly requests: number;
  readonly failures: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly max: number;
  readonly wallMs: number;
  readonly stopMs: number;
  readonly health: Json | null;
  readonly status: TelemetryStatus;
}

// biome-ignore lint/suspicious/noExplicitAny: decoded JSON in a test
type Json = Record<string, any>;

const script = fileURLToPath(new URL("./support/storm.ts", import.meta.url));

async function storm(env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, script], {
    env: {
      PATH: process.env.PATH ?? "",
      RASTRATA_OTEL_SAMPLE_RATE: "1",
      RASTRATA_OTEL_METRICS_INTERVAL_MS: "1000",
      RASTRATA_OTEL_TIMEOUT_MS: "600",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    result: JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as Result,
    code,
    stderr,
    stdout,
  };
}

/** test/support/budget.ts of the application package, in a line: a latency budget is asserted when the
 * machine is quiet (load below the core count), always with RASTRATA_PERF=strict, never with off. */
const quiet = () => {
  const mode = process.env.RASTRATA_PERF;
  if (mode === "strict") return true;
  if (mode === "off") return false;
  return (loadavg()[0] ?? 0) < cpus().length;
};

const stand: StandIn[] = [];
afterAll(async () => {
  for (const item of stand) await item.stop();
});

describe("the API under a storm, with the collector in every state", () => {
  test("every request is answered, the process ends cleanly, and the loss is counted and visible", async () => {
    const baseline = await storm({});
    expect(baseline.code).toBe(0);
    expect(baseline.result.failures).toBe(0);
    expect(baseline.result.status.enabled).toBe(false);
    expect(baseline.result.health).toBeNull();

    const hanging = await standIn("hang");
    const slow = await standIn({ slowMs: 1000 });
    stand.push(hanging, slow);
    const states: [string, string][] = [
      ["down", `http://127.0.0.1:${await closedPort()}`],
      ["hanging", hanging.url],
      ["slow", slow.url],
    ];
    const rows = [
      `off      p50 ${baseline.result.p50.toFixed(1)} ms  p99 ${baseline.result.p99.toFixed(1)} ms  stop ${baseline.result.stopMs.toFixed(0)} ms`,
    ];
    for (const [name, url] of states) {
      const { result, code, stderr } = await storm({ RASTRATA_OTEL_ENDPOINT: url });
      rows.push(
        `${name.padEnd(8)} p50 ${result.p50.toFixed(1)} ms  p99 ${result.p99.toFixed(1)} ms  stop ${result.stopMs.toFixed(0)} ms  dropped ${result.status.dropped.traces} spans / ${result.status.dropped.metrics} metric batches  exports ${JSON.stringify(result.status.exports)}  failures-in-a-row ${JSON.stringify(result.status.consecutiveFailures)}`,
      );
      expect(code, `${name}: exit status`).toBe(0);
      expect(stderr, `${name}: stderr`).toBe("");
      expect(result.failures, `${name}: failed requests`).toBe(0);
      expect(result.requests, name).toBeGreaterThanOrEqual(1500);
      expect(result.status.queued, name).toBeLessThanOrEqual(2048);
      expect(result.stopMs, `${name}: stopping the server`).toBeLessThan(4000);
      // /health shows the monitoring's own state to anything that reads it.
      expect(result.health?.enabled, name).toBe(true);
      expect(Object.keys(result.health ?? {}).sort(), name).toEqual([
        "backingOff",
        "dropped",
        "enabled",
        "exported",
        "failed",
        "lastSuccessAt",
        "queued",
      ]);
      expect(result.status.exports.traces.ok, name).toBe(0);
      expect(
        result.status.dropped.traces + result.status.exports.traces.failed,
        name,
      ).toBeGreaterThan(0);
      if (quiet()) {
        expect(result.p50, `${name}: p50`).toBeLessThan(baseline.result.p50 * 1.5 + 1);
        expect(result.p99, `${name}: p99`).toBeLessThan(baseline.result.p99 * 2 + 10);
      }
    }
    console.info(`API storm, 1,500 requests, 32 at a time\n${rows.join("\n")}`);
  }, 180_000);

  test("a healthy collector receives the traffic, and /health says so", async () => {
    const healthy = await standIn("ok");
    stand.push(healthy);
    const { result, code, stderr } = await storm({ RASTRATA_OTEL_ENDPOINT: healthy.url });
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(result.failures).toBe(0);
    expect(result.status.exports.traces.ok).toBeGreaterThan(0);
    expect(result.status.exports.metrics.ok).toBeGreaterThan(0);
    expect(result.status.consecutiveFailures).toEqual({ traces: 0, metrics: 0 });
    expect(result.status.lastSuccessAt).not.toBeNull();
    expect(healthy.hits()).toBeGreaterThan(2);
  }, 90_000);
});

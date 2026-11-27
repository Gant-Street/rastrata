// Telemetry must never slow a request or end a process. This starts a child that serves a storm of
// requests which emit spans and metrics, with telemetry off, with the collector down, with a
// collector that never answers, and with one that answers a second late, and compares what a
// request experienced. The exit status and the bounds on memory and queue are asserted always; the
// latency comparison only on a quiet machine (test/support/budget.ts).
import { afterAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { TelemetryStatus } from "../src/api.ts";
import { type Collector, closedPort, startCollector } from "./support/collector.ts";
import { budgetsApply } from "./support/budget.ts";

interface Result {
  readonly on: boolean;
  readonly requests: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly max: number;
  readonly lagMax: number;
  readonly wallMs: number;
  readonly shutdownMs: number;
  readonly rssMb: number;
  readonly status: TelemetryStatus;
}

const script = fileURLToPath(new URL("./support/storm.ts", import.meta.url));

async function storm(
  env: Record<string, string>,
): Promise<{ result: Result; code: number; stderr: string }> {
  const child = Bun.spawn([process.execPath, script], {
    env: {
      PATH: process.env.PATH ?? "",
      STORM_REQUESTS: "3000",
      STORM_CONCURRENCY: "48",
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
  const line = stdout.trim().split("\n").pop() ?? "{}";
  return { result: JSON.parse(line) as Result, code, stderr };
}

const collectors: Collector[] = [];
afterAll(async () => {
  for (const collector of collectors) await collector.stop();
});

describe("a request storm with the collector in every state", () => {
  test("latency, exit status and memory are unchanged by a collector that is down, hanging or slow", async () => {
    const baseline = await storm({});
    expect(baseline.code).toBe(0);
    expect(baseline.result.on).toBe(false);
    expect(baseline.result.requests).toBeGreaterThanOrEqual(3000);
    expect(baseline.result.status.enabled).toBe(false);

    const port = await closedPort();
    const hanging = await startCollector({ kind: "hang" });
    const slow = await startCollector({ kind: "slow", ms: 1000 });
    collectors.push(hanging, slow);
    const states: [string, string][] = [
      ["down", `http://127.0.0.1:${port}`],
      ["hanging", hanging.url],
      ["slow", slow.url],
    ];
    const rows: string[] = [
      `off      p50 ${baseline.result.p50.toFixed(2)} ms  p99 ${baseline.result.p99.toFixed(2)} ms  lag ${baseline.result.lagMax.toFixed(1)} ms  rss ${baseline.result.rssMb.toFixed(0)} MB`,
    ];
    for (const [name, url] of states) {
      const { result, code, stderr } = await storm({ RASTRATA_OTEL_ENDPOINT: url });
      rows.push(
        `${name.padEnd(8)} p50 ${result.p50.toFixed(2)} ms  p99 ${result.p99.toFixed(2)} ms  lag ${result.lagMax.toFixed(1)} ms  rss ${result.rssMb.toFixed(0)} MB  shutdown ${result.shutdownMs.toFixed(0)} ms  dropped ${result.status.dropped.traces} spans, ${result.status.dropped.metrics} metric batches; exports ${JSON.stringify(result.status.exports)}; queued ${result.status.queued}`,
      );
      // Always: the process ended by itself with a success status and said nothing on stderr.
      expect(code, `${name}: exit status`).toBe(0);
      expect(stderr, `${name}: stderr`).toBe("");
      expect(result.on, name).toBe(true);
      expect(result.requests, name).toBeGreaterThanOrEqual(3000);
      // The queue is bounded, and nothing took long to shut down.
      expect(result.status.queued, name).toBeLessThanOrEqual(2048);
      expect(result.shutdownMs, `${name}: shutdown`).toBeLessThan(3500);
      // Not delivering shows up as numbers, not as silence.
      if (name !== "slow") {
        expect(result.status.exports.traces.ok, name).toBe(0);
        expect(
          result.status.dropped.traces + result.status.exports.traces.failed,
          name,
        ).toBeGreaterThan(0);
        expect(result.status.consecutiveFailures.traces, name).toBeGreaterThan(0);
      }
      // Memory did not run away: a few thousand spans of queue cannot add hundreds of megabytes.
      expect(result.rssMb, `${name}: rss`).toBeLessThan(baseline.result.rssMb + 150);
      if (budgetsApply()) {
        expect(result.p50, `${name}: p50`).toBeLessThan(baseline.result.p50 * 1.5 + 1);
        expect(result.p99, `${name}: p99`).toBeLessThan(baseline.result.p99 * 2 + 5);
        expect(result.lagMax, `${name}: event loop lag`).toBeLessThan(
          baseline.result.lagMax * 2 + 25,
        );
      }
    }
    console.info(`request storm, 3,000 requests, 48 at a time\n${rows.join("\n")}`);
  }, 120_000);

  test("a healthy collector receives the storm, and costs a request next to nothing", async () => {
    const baseline = await storm({});
    const healthy = await startCollector();
    collectors.push(healthy);
    const { result, code, stderr } = await storm({ RASTRATA_OTEL_ENDPOINT: healthy.url });
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(result.status.exports.traces.ok).toBeGreaterThan(0);
    expect(result.status.exports.metrics.ok).toBeGreaterThan(0);
    // Every request made three spans; whatever was not still queued at the end arrived.
    expect(healthy.spans().length).toBeGreaterThan(3000);
    console.info(
      `healthy collector: p50 ${result.p50.toFixed(2)} ms against ${baseline.result.p50.toFixed(2)} ms off; p99 ${result.p99.toFixed(2)} against ${baseline.result.p99.toFixed(2)}; ${healthy.spans().length} spans, ${result.status.dropped.traces} dropped`,
    );
    if (budgetsApply()) {
      expect(result.p50).toBeLessThan(baseline.result.p50 * 1.5 + 1);
      expect(result.p99).toBeLessThan(baseline.result.p99 * 2 + 5);
    }
  }, 60_000);
});

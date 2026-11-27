// A request storm for a child process: a Bun server whose handler emits the telemetry a real API
// request would (a request span, an operation span, a ledger span, three metric points), hit by a
// client in the same process. It reads RASTRATA_OTEL_* from the environment like the product, so the
// test can start it with telemetry off, on with the collector down, hanging, or slow, and compare.
// It prints one JSON line and ends on its own: the exit status is part of what is tested.
import {
  configureTelemetry,
  counter,
  histogram,
  shutdownTelemetry,
  span,
  telemetryStatus,
} from "../../src/index.ts";

const requests = Number(process.env.STORM_REQUESTS ?? "3000");
const concurrency = Number(process.env.STORM_CONCURRENCY ?? "48");

const on = await configureTelemetry({ log: () => {}, serviceName: "storm" });

const busy = (microseconds: number) => {
  const end = performance.now() + microseconds / 1000;
  let x = 0;
  while (performance.now() < end) x += Math.sqrt(x + 1);
  return x;
};

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch() {
    return span("http.request", { "http.request.method": "POST" }, async () => {
      await span("operation", { operation: "journal.list", operation_class: "read" }, async () => {
        busy(120);
        await Promise.resolve();
        span("ledger.execute", undefined, () => busy(60));
        counter("requests").add(1, { operation_class: "read", outcome: "ok" });
        counter("db.rows.written").add(2, { operation_class: "read" });
        histogram("request.duration").record(0.0004, { operation_class: "read" });
      });
      return new Response("ok");
    });
  },
});

// How late a 2 ms timer fires: the event loop being held up.
let lagMax = 0;
let expected = performance.now() + 2;
const watcher = setInterval(() => {
  const now = performance.now();
  lagMax = Math.max(lagMax, now - expected);
  expected = now + 2;
}, 2);

const latencies: number[] = [];
async function worker(share: number) {
  for (let index = 0; index < share; index += 1) {
    const started = performance.now();
    const response = await fetch(`http://127.0.0.1:${server.port}/`, {
      method: "POST",
      body: "{}",
    });
    await response.text();
    latencies.push(performance.now() - started);
  }
}
const begun = performance.now();
await Promise.all(
  Array.from({ length: concurrency }, () => worker(Math.ceil(requests / concurrency))),
);
const wallMs = performance.now() - begun;
clearInterval(watcher);

const sorted = [...latencies].sort((a, b) => a - b);
const at = (fraction: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
// Let the exports that the storm started finish (or fail) before the numbers are read.
if (on) await Bun.sleep(Number(process.env.STORM_SETTLE_MS ?? "1800"));
const status = telemetryStatus();
const closing = performance.now();
await shutdownTelemetry(1500);
const shutdownMs = performance.now() - closing;
await server.stop(true);
console.log(
  JSON.stringify({
    on,
    requests: latencies.length,
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: sorted[sorted.length - 1] ?? 0,
    lagMax,
    wallMs,
    shutdownMs,
    rssMb: process.memoryUsage.rss() / 1048576,
    status,
  }),
);

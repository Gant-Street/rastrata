#!/usr/bin/env bun
/** Feed the local observability stack plausible, INVENTED numbers for every dashboard panel, so the
 * dashboards and the alerts can be looked at before the hosting prototype produces real ones.
 *
 *   docker compose -f deploy/observability/local/compose.yaml up -d
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 RASTRATA_OTEL_METRICS_INTERVAL_MS=5000 \
 *     bun packages/telemetry/tools/demo-feed.ts [--seconds 300] [--degrade-after 120]
 *
 * It sends as the service `rastrata-demo`, a new set of observations each second through the real
 * telemetry API (so the names, labels and buckets are the catalog's). With `--degrade-after N` the
 * commit and read paths turn slow after N seconds, which is how the burn-rate alerts are seen to
 * fire. Nothing it records was measured. */
import { configureTelemetry, counter, gauge, histogram, shutdownTelemetry } from "../src/index.ts";

const args = process.argv.slice(2);
const option = (name: string, fallback: number) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : Number(args[index + 1]);
};
const seconds = option("--seconds", 300);
const degradeAfter = option("--degrade-after", Number.POSITIVE_INFINITY);

if (
  !(await configureTelemetry({
    serviceName: "rastrata-demo",
    env: { ...process.env, RASTRATA_INSTANCE_ID: process.env.RASTRATA_INSTANCE_ID ?? "demo-1" },
  }))
) {
  console.error("telemetry is off: set OTEL_EXPORTER_OTLP_ENDPOINT, e.g. http://127.0.0.1:4318");
  process.exit(2);
}

// A seeded generator, so two runs look alike.
let state = 20261007;
const random = () => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const normal = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
/** A latency around `median` seconds with a long tail. */
const lognormal = (median: number, sigma: number) => median * Math.exp(sigma * normal());
const poisson = (mean: number) => {
  const limit = Math.exp(-mean);
  let count = 0;
  let p = random();
  while (p > limit) {
    count += 1;
    p *= random();
  }
  return count;
};

const SIZES = ["xs", "s", "m", "l", "xl"] as const;
const SIZE_WEIGHT = { xs: 0.55, s: 0.25, m: 0.12, l: 0.06, xl: 0.02 };
const pickSize = () => {
  let r = random();
  for (const size of SIZES) {
    r -= SIZE_WEIGHT[size];
    if (r < 0) return size;
  }
  return "xs" as const;
};
const SCALE = { xs: 1, s: 2.5, m: 6, l: 20, xl: 70 };
const tenants = { xs: 600, s: 250, m: 100, l: 40, xl: 10 };

let tailDepth = 0;
const stored = { xs: 0.8e9, s: 1.4e9, m: 1.4e9, l: 1.8e9, xl: 1.4e9 };

for (let tick = 0; tick < seconds; tick += 1) {
  const slow = tick >= degradeAfter ? 8 : 1;

  // Requests: reads, reports, drafts, posts.
  for (let i = 0; i < poisson(30); i += 1) {
    const size = pickSize();
    const duration = lognormal(0.02 * slow, 0.7);
    histogram("request.duration").record(duration, { operation_class: "read" });
    counter("requests").add(1, {
      operation_class: "read",
      outcome: random() < 0.995 ? "ok" : "server_error",
    });
    counter("request.cpu.time").add(duration * 0.8, { operation_class: "read", size_bucket: size });
  }
  for (let i = 0; i < poisson(2); i += 1) {
    const size = pickSize();
    histogram("report.duration").record(lognormal(0.04 * SCALE[size], 0.5), { size_bucket: size });
    histogram("request.duration").record(lognormal(0.1, 0.5), { operation_class: "report" });
    counter("requests").add(1, { operation_class: "report", outcome: "ok" });
    counter("request.cpu.time").add(0.06 * SCALE[size], {
      operation_class: "report",
      size_bucket: size,
    });
  }
  for (let i = 0; i < poisson(5); i += 1) {
    const size = pickSize();
    const duration = lognormal(0.025 * slow, 0.5) + (random() < 0.03 ? 0.15 : 0);
    histogram("commit.duration").record(duration, { size_bucket: size });
    histogram("request.duration").record(duration + 0.01, { operation_class: "post" });
    counter("requests").add(1, { operation_class: "post", outcome: "ok" });
    counter("db.rows.written").add(6 + Math.floor(random() * 6), { operation_class: "post" });
    counter("request.cpu.time").add(0.004, { operation_class: "post", size_bucket: size });
    if (random() < 0.01) counter("commit.conflicts").add(1, { size_bucket: size });
    counter("r2.operations").add(1, { r2_op: "put", outcome: "ok" });
    counter("r2.bytes").add(1500, { direction: "in", object_kind: "sealed" });
    histogram("r2.duration").record(lognormal(0.12, 0.4), { r2_op: "put" });
    counter("seal.operations").add(1, {
      outcome: random() < 0.99 ? "ok" : "timeout",
      size_bucket: size,
    });
    histogram("seal.lag").record(lognormal(3, 0.6));
    tailDepth += 1;
  }
  tailDepth = Math.max(0, tailDepth - Math.floor(tailDepth * 0.4));
  for (let i = 0; i < poisson(0.2); i += 1) {
    const size = pickSize();
    histogram("activation.duration").record(lognormal(0.2 * SCALE[size], 0.4), {
      size_bucket: size,
    });
    histogram("activation.peak_memory").record(lognormal(60e6 + 8e6 * SCALE[size], 0.2), {
      size_bucket: size,
      snapshot_attempt: random() < 0.1 ? "failed" : "none",
    });
    counter("activations").add(1, { activation_source: "snapshot", size_bucket: size });
    counter("r2.operations").add(3, { r2_op: "get", outcome: "ok" });
    counter("r2.bytes").add(200_000, { direction: "out", object_kind: "snapshot" });
    histogram("r2.duration").record(lognormal(0.04, 0.4), { r2_op: "get" });
  }
  if (tick % 10 === 0) {
    counter("lease.operations").add(20, { lease_op: "renew", lease_result: "granted" });
    counter("lease.reads").add(300, { lease_state: "leased" });
    counter("lease.reads").add(3, { lease_state: "unleased" });
    counter("jobs").add(1, { job_type: "verify", outcome: "ok" });
    counter("job.cpu.time").add(0.4, { job_type: "verify" });
    if (random() < 0.05) counter("lease.fence_rejections").add(1, { tail_op: "append" });
  }
  if (tick % 15 === 0) counter("r2.operations").add(2, { r2_op: "list", outcome: "ok" });

  // Gauges.
  for (const size of SIZES) {
    gauge("tenants").set(tenants[size], { size_bucket: size });
    gauge("books.resident").set(Math.round(tenants[size] * 0.06), { size_bucket: size });
    stored[size] += 4000 * SCALE[size] * 5;
    gauge("stored.bytes").set(stored[size], { size_bucket: size, object_kind: "log" });
    gauge("verify.lag").set(20 + random() * 60, { size_bucket: size });
  }
  gauge("tail.depth").set(tailDepth);
  gauge("tail.size").set(tailDepth * 1500);
  gauge("tail.age").set(tailDepth === 0 ? 0 : 1 + random() * 4 * slow);
  gauge("lease.held").set(18);
  gauge("queue.depth").set(Math.floor(random() * 4), { queue: "jobs" });
  gauge("queue.age").set(random() * 8, { queue: "jobs" });
  gauge("process.memory.limit").set(1024 * 1024 * 1024);

  // The browser.
  for (let i = 0; i < poisson(0.4); i += 1) {
    const size = pickSize();
    histogram("web.lcp").record(lognormal(1.1, 0.4), { size_bucket: size });
    histogram("web.inp").record(lognormal(0.09 * slow ** 0.5, 0.5), { size_bucket: size });
    histogram("web.ttfb").record(lognormal(0.25, 0.4), { size_bucket: size });
    histogram("web.cls").record(Math.abs(0.03 * normal()), { size_bucket: size });
    counter("web.beacons").add(1, { web_beacon: "accepted" });
  }
  for (let i = 0; i < poisson(0.5); i += 1) {
    const action = (["accept", "post", "save"] as const)[Math.floor(random() * 3)] ?? "save";
    histogram("web.action.duration").record(lognormal(0.08 * slow, 0.5), {
      web_action: action,
      size_bucket: pickSize(),
    });
    counter("web.actions").add(1, { web_action: action, outcome: "ok" });
  }
  await Bun.sleep(1000);
}
await shutdownTelemetry(5000);
console.log(`fed ${seconds} s of invented observations as rastrata-demo`);

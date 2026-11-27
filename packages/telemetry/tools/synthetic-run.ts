/** A small, invented run recorded through the real telemetry API: a hundred tenants of three sizes
 * and a thousand commits, with the numbers chosen so that each rule of the dump reader is visible.
 * The cost tests read the dump it makes; `synthetic-dump.ts` writes one to a file so the cost report
 * can be tried on a dump without running a load test. Nothing here was measured. */
import { counter, gauge, histogram } from "../src/index.ts";

export const SYNTHETIC_TENANTS = { xs: 60, s: 30, m: 10 } as const;
export const SYNTHETIC_SHARE = { xs: 0.6, s: 0.3, m: 0.1 } as const;

/** A small run of a thousand commits: the numbers are chosen so each rule is visible. */
export function recordSyntheticRun() {
  for (const [size, tenants] of Object.entries(SYNTHETIC_TENANTS)) {
    const size_bucket = size as keyof typeof SYNTHETIC_TENANTS;
    gauge("tenants").set(tenants, { size_bucket });
    gauge("books.resident").set({ xs: 6, s: 3, m: 1 }[size_bucket], { size_bucket });
    for (let i = 0; i < 1000 * SYNTHETIC_SHARE[size_bucket]; i += 1)
      histogram("commit.duration").record(0.02, { size_bucket });
    for (let i = 0; i < { xs: 20, s: 30, m: 40 }[size_bucket]; i += 1)
      histogram("report.duration").record(0.05, { size_bucket });
    counter("request.cpu.time").add({ xs: 30, s: 20, m: 10 }[size_bucket], {
      operation_class: "read",
      size_bucket,
    });
    counter("request.cpu.time").add({ xs: 3, s: 2, m: 1 }[size_bucket], {
      operation_class: "post",
      size_bucket,
    });
    gauge("stored.bytes").set({ xs: 200e6, s: 400e6, m: 700e6 }[size_bucket], {
      size_bucket,
      object_kind: "log",
    });
    const activations = { xs: 40, s: 20, m: 10 }[size_bucket];
    counter("activations").add(activations, { activation_source: "snapshot", size_bucket });
    for (let i = 0; i < activations; i += 1) {
      histogram("activation.duration").record({ xs: 0.5, s: 1, m: 2 }[size_bucket], {
        size_bucket,
      });
      histogram("activation.peak_memory").record(
        { xs: 60, s: 120, m: 300 }[size_bucket] * 1048576,
        {
          size_bucket,
          snapshot_attempt: "none",
        },
      );
    }
  }
  gauge("stored.bytes").set(10e6, { size_bucket: "xs", object_kind: "snapshot" });
  counter("requests").add(900, { operation_class: "read", outcome: "ok" });
  counter("requests").add(100, { operation_class: "draft", outcome: "ok" });
  counter("requests").add(1000, { operation_class: "post", outcome: "ok" });
  counter("r2.operations").add(130, { r2_op: "put", outcome: "ok" });
  counter("r2.operations").add(20, { r2_op: "copy", outcome: "ok" });
  counter("r2.operations").add(70, { r2_op: "get", outcome: "ok" });
  counter("r2.operations").add(30, { r2_op: "head", outcome: "ok" });
  counter("r2.operations").add(5, { r2_op: "delete", outcome: "ok" });
  counter("process.cpu.time").add(60, { cpu_mode: "user" });
  counter("process.cpu.time").add(15, { cpu_mode: "system" });
  counter("job.cpu.time").add(4, { job_type: "verify" });
  gauge("process.memory").set(300 * 1048576, { memory_kind: "rss" });
  counter("tail.operations").add(1000, { tail_kind: "postgres", tail_op: "append", outcome: "ok" });
  counter("tail.operations").add(10, {
    tail_kind: "durable_object",
    tail_op: "append",
    outcome: "ok",
  });
  counter("tail.rows.written").add(3000, { tail_kind: "postgres" });
  for (let i = 0; i < 1000; i += 1)
    histogram("tail.duration").record(0.01, { tail_kind: "postgres", tail_op: "append" });
  gauge("tail.size").set(5e6);
}

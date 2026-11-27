#!/usr/bin/env bun
/** Write a metrics dump of the invented run in synthetic-run.ts, through the real telemetry SDK, so
 * the cost report can be tried on a dump without a load test:
 *
 *   bun packages/telemetry/tools/synthetic-dump.ts /tmp/synthetic.jsonl
 *   bun scripts/cost-report.ts /tmp/synthetic.jsonl --seconds 3600
 *
 * The collector it sends to is a sink in this process; only the file matters. */
import { configureTelemetry, flushTelemetry, shutdownTelemetry } from "../src/index.ts";
import { recordSyntheticRun } from "./synthetic-run.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: bun packages/telemetry/tools/synthetic-dump.ts FILE.jsonl");
  process.exit(2);
}
const sink = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("{}") });
await Bun.write(file, "");
await configureTelemetry({
  env: {
    RASTRATA_OTEL_ENDPOINT: `http://127.0.0.1:${sink.port}`,
    RASTRATA_OTEL_FILE: file,
    RASTRATA_OTEL_METRICS_INTERVAL_MS: "3600000",
    RASTRATA_INSTANCE_ID: "synthetic",
  },
  runtime: false,
  log: () => undefined,
});
recordSyntheticRun();
await flushTelemetry(3000);
await shutdownTelemetry(3000);
await sink.stop();
console.log(`wrote ${file}`);

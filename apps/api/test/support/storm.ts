// The real API server under a request storm, for a child process. It reads RASTRATA_OTEL_* from its
// environment as the installed service would, serves the application's own operations over HTTP, and
// is hit by a client in the same process. It prints one JSON line and ends on its own: the exit status
// is part of what is tested. See test/telemetry-storm.test.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPLICATION_API_VERSION } from "@rastrata/application/schema";
import { telemetryStatus } from "@rastrata/telemetry";
import { startLocalApplicationServer } from "../../src/server.ts";

const requests = Number(process.env.STORM_REQUESTS ?? "1500");
const concurrency = Number(process.env.STORM_CONCURRENCY ?? "32");

const directory = mkdtempSync(join(tmpdir(), "rastrata-api-storm-"));
const started = await startLocalApplicationServer({
  path: join(directory, "book.sqlite"),
  port: 0,
  telemetry: { env: process.env },
});
const base = `http://127.0.0.1:${started.server.port}`;
const call = async (name: string, input: unknown, operationId?: string) => {
  const response = await fetch(`${base}/v1/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: APPLICATION_API_VERSION,
      bookId: "local-book",
      input,
      ...(operationId ? { operationId } : {}),
    }),
  });
  return response.status;
};
await call(
  "book.setup",
  {
    name: "Storm Co",
    currency: "USD",
    fiscalYear: 2026,
    periodModel: "monthly",
    accounts: [
      { code: "1000", name: "Cash", role: "asset" },
      { code: "3000", name: "Capital", role: "equity" },
    ],
  },
  crypto.randomUUID(),
);

const latencies: number[] = [];
let failures = 0;
const operations = [
  ["book.get", {}],
  ["drafts.list", { page: 1 }],
  ["reports.get", { asOf: "2026-12-31" }],
  ["accounts.list", {}],
] as const;
async function worker(share: number, seed: number) {
  for (let index = 0; index < share; index += 1) {
    const [name, input] = operations[
      (index + seed) % operations.length
    ] as (typeof operations)[number];
    const begun = performance.now();
    const status = await call(name, input);
    latencies.push(performance.now() - begun);
    if (status !== 200) failures += 1;
  }
}
const begun = performance.now();
await Promise.all(
  Array.from({ length: concurrency }, (_, seed) => worker(Math.ceil(requests / concurrency), seed)),
);
const wallMs = performance.now() - begun;
const sorted = [...latencies].sort((a, b) => a - b);
const at = (fraction: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
const health = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
if (process.env.RASTRATA_OTEL_ENDPOINT)
  await Bun.sleep(Number(process.env.STORM_SETTLE_MS ?? "1800"));
const status = telemetryStatus();
const closing = performance.now();
await started.stop();
const stopMs = performance.now() - closing;
rmSync(directory, { recursive: true, force: true });
console.log(
  JSON.stringify({
    requests: latencies.length,
    failures,
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: sorted[sorted.length - 1] ?? 0,
    wallMs,
    stopMs,
    health: health.telemetry ?? null,
    status,
  }),
);

// Benchmark: what telemetry costs a request, off and on. Run it with
//   bun bench/telemetry-overhead.ts                        (telemetry off: the shipped default)
//   OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 bun bench/telemetry-overhead.ts     (on)
// It opens a book of BOOK_JOURNALS journals, puts the application's HTTP layer in front of it and times
// ROUNDS rounds of REQUESTS sequential requests of each of four operations, in this process, with no
// network and no browser: the cost of the code path itself. It prints one JSON line (microseconds a
// request, median over the rounds, wall and CPU) and a table. To compare two trees, run it in each, one
// after the other and several times over, and compare the medians: scratchpad scripts do this for
// docs/reference/program/hosting/hostobs.md, which holds the numbers.
//
// The write path of bench/scale.ts needs no such benchmark with telemetry off: nothing is wrapped
// then (packages/application/test/telemetry.test.ts, "nothing is wrapped"), so the commands run the
// code they always ran.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationHttp } from "../src/http.ts";
import { LocalBookService } from "../src/local.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../src/schema.ts";
import { BULK_BOOK, postBulk } from "../test/support/bulk-book.ts";

const journals = Number(process.env.BOOK_JOURNALS ?? "300");
const requests = Number(process.env.REQUESTS ?? "3000");
const rounds = Number(process.env.ROUNDS ?? "7");

// Telemetry is configured only when an endpoint is given, as in the API server; the import is dynamic
// so that a tree without the telemetry package can run this too.
const on = Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.RASTRATA_OTEL_ENDPOINT);
if (on) {
  const telemetry = await import("@rastrata/telemetry");
  await telemetry.configureTelemetry({ serviceName: "rastrata-overhead", runtime: false });
}

const directory = mkdtempSync(join(tmpdir(), "rastrata-overhead-"));
const service = await LocalBookService.open(join(directory, "book.sqlite"));
const http = new ApplicationHttp(service, {
  bookId: service.bookId,
  permissions: BUSINESS_PERMISSIONS,
});
const call = async (name: string, input: unknown = {}, operationId?: string) => {
  const response = await http.fetch(
    new Request(`http://127.0.0.1:4010/v1/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: APPLICATION_API_VERSION,
        bookId: "local-book",
        input,
        ...(operationId ? { operationId } : {}),
      }),
    }),
  );
  if (response.status !== 200) throw new Error(`${name}: ${response.status}`);
  await response.arrayBuffer();
};

await call("book.setup", BULK_BOOK, crypto.randomUUID());
await postBulk(service, journals);

const operations: [string, unknown][] = [
  ["book.get", {}],
  ["accounts.list", {}],
  ["drafts.list", { page: 1 }],
  ["reports.get", { asOf: "2026-12-31" }],
];

// Warm up: the first reads build the view and the report's sorted index.
for (const [name, input] of operations) for (let i = 0; i < 300; i += 1) await call(name, input);

const wall: Record<string, number[]> = {};
const cpu: Record<string, number[]> = {};
for (let round = 0; round < rounds; round += 1)
  for (const [name, input] of operations) {
    const cpuBefore = process.cpuUsage();
    const started = Bun.nanoseconds();
    for (let i = 0; i < requests; i += 1) await call(name, input);
    const elapsed = Bun.nanoseconds() - started;
    const used = process.cpuUsage(cpuBefore);
    wall[name] = [...(wall[name] ?? []), elapsed / 1000 / requests];
    cpu[name] = [...(cpu[name] ?? []), (used.user + used.system) / requests];
  }

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;
const result = Object.fromEntries(
  operations.map(([name]) => [
    name,
    { wallUs: median(wall[name] ?? []), cpuUs: median(cpu[name] ?? []) },
  ]),
);
console.log(JSON.stringify({ telemetry: on ? "on" : "off", journals, requests, rounds, result }));

service.close();
rmSync(directory, { recursive: true, force: true });
if (on) {
  const telemetry = await import("@rastrata/telemetry");
  await telemetry.shutdownTelemetry(2000);
}

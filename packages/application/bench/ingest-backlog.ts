// Benchmark: a first-import backlog through the whole pipeline. N bank lines (default 2000) are
// archived and submitted, proposed, categorized and posted through the application operations,
// the way the founder's first run goes. Run it with
//   N=2000 bun bench/ingest-backlog.ts
// It prints the time of each phase and how the cost of a posting grows with the book.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationHttp } from "../src/http.ts";
import type { BankLine } from "../src/ingest-types.ts";
import { LocalBookService } from "../src/local.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../src/schema.ts";
import { ingestPort } from "../src/slices/ingest/port.ts";
import { ingestRuntime } from "../src/slices/ingest/store.ts";
import { BOOK } from "../test/support/ingest-fixture.ts";

type Json = Awaited<ReturnType<Response["json"]>>;
const n = Number(process.env.N ?? "2000");
const dir = mkdtempSync(join(tmpdir(), "rastrata-backlog-"));
const service = await LocalBookService.open(join(dir, "book.sqlite"));
const http = new ApplicationHttp(service, {
  bookId: service.bookId,
  permissions: BUSINESS_PERMISSIONS,
});
const call = async (name: string, input: unknown, operationId?: string) => {
  const response = await http.fetch(
    new Request(`http://127.0.0.1:4010/v1/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: APPLICATION_API_VERSION,
        bookId: service.bookId,
        input,
        ...(operationId ? { operationId } : {}),
      }),
    }),
  );
  const body = (await response.json()) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: unknown;
  };
  if (!body.ok) throw new Error(`${name} failed: ${JSON.stringify(body.error)}`);
  return body.data as Record<string, Json>;
};
const since = (t: number) => `${((performance.now() - t) / 1000).toFixed(1)} s`;
// CPU time of this process is steadier than wall time when the machine is shared.
const cpuNow = () => {
  const usage = process.cpuUsage();
  return (usage.user + usage.system) / 1e6;
};

await call("book.setup", BOOK, crypto.randomUUID());
const port = ingestPort(service);
let t = performance.now();
const lines: BankLine[] = Array.from({ length: n }, (_, index) => ({
  kind: "bankLine",
  provider: "csv",
  accountKey: "csv:1000",
  rawIndex: index,
  postedOn: `2026-${String(1 + (index % 12)).padStart(2, "0")}-${String(1 + (index % 27)).padStart(2, "0")}`,
  amount: `-${(1 + (index % 300)).toString()}.${String(index % 100).padStart(2, "0")}`,
  currency: "USD",
  description: `VENDOR ${index % 400} CARD PURCHASE ${index}`,
}));
const raw = port.archive(
  new TextEncoder().encode(JSON.stringify(lines)),
  "text/csv",
  "backlog.csv",
);
const report = port.submit({
  provider: "csv",
  sourceKey: "csv:1000",
  raw,
  lines,
  balances: [],
  fetchedAt: new Date().toISOString(),
  ledgerAccountId: "1000",
});
console.log(
  `submit ${n} lines: ${since(t)} (${report.newCount} new, ${report.overlapCount} overlap)`,
);

t = performance.now();
const page = await call("inbox.list", { pageSize: 50 });
console.log(`first read, proposes every line: ${since(t)} (${page.counts.total} lines)`);

t = performance.now();
let categorized = 0;
for (;;) {
  const result = await call(
    "inbox.categorize",
    { filter: { status: ["new", "proposed"] }, accountId: "5000", limit: 500 },
    crypto.randomUUID(),
  );
  categorized += result.applied;
  if (result.remaining === 0) break;
}
console.log(`categorize ${categorized} lines into drafts: ${since(t)}`);

ingestRuntime(service).postBudgetMs = Number(process.env.BUDGET_MS ?? "5000");
t = performance.now();
const cpuStart = cpuNow();
t = performance.now();
const listed = performance.now();
await call("inbox.list", { filter: { status: ["drafted"] }, pageSize: 50 });
console.log(`inbox.list with ${categorized} drafted lines: ${since(listed)}`);
t = performance.now();
let posted = 0;
let calls = 0;
let lastReport = performance.now();
for (;;) {
  const result = await call(
    "inbox.post",
    { filter: { status: ["drafted"] }, limit: 100 },
    crypto.randomUUID(),
  );
  posted += result.applied;
  calls += 1;
  if (result.failed > 0) {
    console.error("unexpected:", ingestRuntime(service).lastUnexpected);
    throw new Error(
      `a posting failed: ${JSON.stringify(result.results.find((r: Json) => r.outcome === "failed"))}`,
    );
  }
  if (performance.now() - lastReport > 15_000 || result.remaining === 0) {
    console.log(
      `  posted ${posted} / ${categorized} after ${since(t)} wall, ${(cpuNow() - cpuStart).toFixed(1)} s cpu (${calls} calls)`,
    );
    lastReport = performance.now();
  }
  if (result.remaining === 0) break;
}
const total = (performance.now() - t) / 1000;
console.log(
  `post ${posted} lines: ${total.toFixed(1)} s wall, ${(cpuNow() - cpuStart).toFixed(1)} s cpu, ${((total / posted) * 1000).toFixed(0)} ms each on average`,
);
const summary = await call("inbox.summary", {});
console.log(`inbox now: ${JSON.stringify(summary.counts)}`);
service.close();
rmSync(dir, { recursive: true, force: true });

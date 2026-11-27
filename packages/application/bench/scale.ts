// Benchmark: how one book behaves as it grows. Run it with
//   N=5000 bun bench/scale.ts
// It builds N journals through the native ledger (the write path), then reads the book back by
// replaying it (the read model), and times the application's reads. Phases, in order:
//   write   cost of one command, per batch of BATCH commands
//   replay  first read of the book: every outcome re-executed by the kernel (O(n^2) before the
//           scale program). Skipped above 2,000 journals unless REPLAY=yes, because the legacy
//           preimage takes minutes there.
//   memory  heap the verified view holds after a full collection
//   reads   a report, an account register, and a report right after one more posting
// Environment: N (default 2000), BATCH (default 1000), REPLAY=yes|no, ACCOUNTS (default 4) and REVISIONS
// (default 0). A real book has a chart of a hundred accounts and a configuration revision for every account
// edit; the default toy book hides what a command costs per account and per revision, so measure a realistic
// one too: `ACCOUNTS=100 REVISIONS=10 N=1000 bun bench/scale.ts`.
// LEGACY=yes builds the book as the install package of 2026-10-06 did, without the chain-head state
// commitment, so that its replay is quadratic (keep N at or below 1,000: 22 s there, minutes beyond).
// After the replay it prints what src/replay-cost.ts would have told a person about that read, next to what
// it took: those constants (the warm-up bar, `rastrata doctor`, the progress of a check) are calibrated here.
// Profile it with `bun --cpu-prof --cpu-prof-dir=/tmp/prof bench/scale.ts` and read the result with
// `bun bench/profile-summary.ts /tmp/prof/CPU.*.cpuprofile`.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureTelemetry, shutdownTelemetry } from "@rastrata/telemetry";
import { LocalBookService } from "../src/local.ts";
import { fromStartSeconds, replayGrowthOf, restartSeconds } from "../src/replay-cost.ts";
import { BULK_BOOK, postBulk } from "../test/support/bulk-book.ts";
import { setupLegacyBook } from "../test/support/legacy-book.ts";
import { chart, reconfigure } from "./book.ts";

const total = Number(process.env.N ?? "2000");
const batch = Number(process.env.BATCH ?? "1000");
const replay = (process.env.REPLAY ?? (total <= 2000 ? "yes" : "no")) === "yes";
const accounts = Number(process.env.ACCOUNTS ?? String(BULK_BOOK.accounts.length));
const revisions = Number(process.env.REVISIONS ?? "0");
const legacy = process.env.LEGACY === "yes";
const mb = (bytes: number) => (bytes / 1048576).toFixed(0);
const seconds = (since: number) => ((performance.now() - since) / 1000).toFixed(1);

// Telemetry is off unless OTEL_EXPORTER_OTLP_ENDPOINT (or RASTRATA_OTEL_ENDPOINT) is set. To see this run's
// spans and metrics in the local stack of deploy/observability/local:
//   OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 RASTRATA_OTEL_SAMPLE_RATE=1 \
//   RASTRATA_OTEL_METRICS_INTERVAL_MS=5000 N=2000 bun bench/scale.ts
await configureTelemetry({ serviceName: "rastrata-bench" });

const dir = mkdtempSync(join(tmpdir(), "rastrata-scale-"));
const path = join(dir, "book.sqlite");
let service = await LocalBookService.open(path);
if (legacy) await setupLegacyBook(service, chart(accounts));
else await service.setup(chart(accounts));
await reconfigure(service, revisions);

console.log(
  `# ${total} journals, ${accounts} accounts, ${revisions} configuration revisions, ${legacy ? "legacy book (no chain-head commitment)" : "chain-head book"}`,
);
// biome-ignore lint/suspicious/noExplicitAny: bench instrumentation reaches the ledger to time it
const ledger = (service as any).ledger;
const execute = ledger.execute.bind(ledger);
let count = 0;
let spent = 0;
ledger.execute = async (...args: unknown[]) => {
  const started = performance.now();
  const result = await execute(...args);
  spent += performance.now() - started;
  count += 1;
  if (count % batch === 0 || count === total) {
    const size =
      statSync(path).size + (statSync(`${path}-wal`, { throwIfNoEntry: false })?.size ?? 0);
    console.log(
      `write   ${String(count).padStart(6)} journals: ${(spent / (count % batch || batch)).toFixed(2)} ms per command, ` +
        `rss ${mb(process.memoryUsage.rss())} MB, db ${mb(size)} MB`,
    );
    spent = 0;
  }
  return result;
};
await postBulk(service, total);
ledger.execute = execute;

if (replay) {
  const heap = () => {
    Bun.gc(true);
    return process.memoryUsage().heapUsed;
  };
  const before = heap();
  let started = performance.now();
  const { aggregate } = await service.readAggregate();
  const replayed = (performance.now() - started) / 1000;
  console.log(
    `replay  ${seconds(started)} s for ${total} journals (${((performance.now() - started) / total).toFixed(2)} ms each), peak rss ${mb(process.memoryUsage.rss())} MB`,
  );
  console.log(
    `memory  ${mb(heap() - before)} MB of heap for the view = ${((heap() - before) / 1024 / total).toFixed(1)} KB per journal (${aggregate.state.journals.length} journals)`,
  );
  const growth = replayGrowthOf(legacy ? "legacy" : "chain-head");
  const size = { journals: total, entries: total + 1 + revisions };
  console.log(
    `model   replay-cost.ts says ${fromStartSeconds(growth, size).toFixed(1)} s to read ${total} journals from the start (${growth}); measured ${replayed.toFixed(1)} s ` +
      `(${(fromStartSeconds(growth, size) / replayed).toFixed(2)} times)`,
  );

  // biome-ignore lint/suspicious/noExplicitAny: bench reaches the report entry points
  const reads = service as any;
  const time = async (label: string, run: () => Promise<unknown>) => {
    const t = performance.now();
    await run();
    console.log(`reads   ${label}: ${(performance.now() - t).toFixed(0)} ms`);
  };
  await time("report, first (builds the sorted view)", () => reads.reports("2026-12-31"));
  await time("report, same book again", () => reads.reports("2026-06-30"));
  await time("account register (Cash, one month)", () =>
    reads.accountActivity({
      accountId: "1000",
      asOf: "2026-12-31",
      from: "2026-03-01",
      to: "2026-03-31",
      page: 1,
    }),
  );
  started = performance.now();
  await postBulk(service, 1);
  await time("report after one more posting", () => reads.reports("2026-12-31"));

  service.close();
  started = performance.now();
  service = await LocalBookService.open(path);
  await service.readAggregate();
  const restarted = (performance.now() - started) / 1000;
  console.log(
    `restart ${seconds(started)} s to read the book again (${JSON.stringify(service.readStats)})`,
  );
  // The snapshot the first read saved, if the book was small enough to have one, is what the restart read.
  const saved = service.store
    .query(
      "SELECT sequence, length(CAST(encoded AS BLOB)) AS bytes FROM app_read_snapshots WHERE id = 1",
    )
    .get() as { sequence: string; bytes: number } | null;
  const snapshot = saved ? { bytes: saved.bytes, sequence: Number(saved.sequence) } : null;
  const estimate = restartSeconds(
    replayGrowthOf(legacy ? "legacy" : "chain-head"),
    { journals: total + 1, entries: total + 2 + revisions },
    snapshot,
  );
  console.log(
    `model   replay-cost.ts says a restart takes ${estimate.toFixed(1)} s (${snapshot ? `a snapshot of ${(snapshot.bytes / 1048576).toFixed(1)} MiB at entry ${snapshot.sequence}` : "no snapshot"}); measured ${restarted.toFixed(1)} s`,
  );
}
service.close();
rmSync(dir, { recursive: true, force: true });
await shutdownTelemetry();

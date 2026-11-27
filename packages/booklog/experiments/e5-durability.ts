/** E5: is the log durable under faults? Seeded runs of whole systems (1 to 3 pods, a client that
 * retries, a tail and a bucket that lose, duplicate, delay and refuse what is sent them, processes
 * that die at any instant, leases that lapse, snapshots, sealing and compaction), each checked
 * afterwards against four invariants:
 *   I1 an acknowledged operation is in the book, exactly once
 *   I2 the log is one hash chain with no gap
 *   I3 a book materialized from the log (by a snapshot and the tail, and whole from the first
 *      entry) equals the operations that were applied
 *   I4 at most one entry was ever accepted for a sequence number
 * Pass: zero violations in at least 10,000 runs.
 *
 *   bun experiments/e5-durability.ts [--runs 10000] [--from 1] [--workers 1] [--json path]
 *
 * With --negative the same checks run against a tail that loses its newest entries on a failover
 * (an asynchronous replica promoted too early); they must find it: that is how the checker is shown
 * to be able to fail. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machine, parseArgs, printTable, record } from "./lib.ts";
import {
  Sim,
  failedReport,
  randomConfig,
  runSimulation,
  type SimReport,
} from "../test/support/sim.ts";

const args = parseArgs();
const runs = args.number("runs", 10_000);
const from = args.number("from", 1);
const workers = args.number("workers", 1);
const child = args.has("child");
const negative = args.has("negative");

async function execute(start: number, count: number): Promise<SimReport[]> {
  const reports: SimReport[] = [];
  for (let seed = start; seed < start + count; seed += 1) {
    const directory = mkdtempSync(join(tmpdir(), `booklog-e5-${seed}-`));
    try {
      reports.push(await runSimulation(seed, directory));
    } catch (error) {
      reports.push(
        failedReport(
          seed,
          `the run itself failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      rmSync(directory, { recursive: true, force: true });
    }
    if (!child && (seed - start + 1) % 500 === 0)
      console.error(`  ${seed - start + 1} of ${count} runs done`);
  }
  return reports;
}

async function negativeControl(): Promise<{ detected: number; of: number }> {
  let detected = 0;
  const trials = 25;
  for (let seed = 1; seed <= trials; seed += 1) {
    const directory = mkdtempSync(join(tmpdir(), `booklog-e5n-${seed}-`));
    const sim = new Sim(
      {
        ...randomConfig(seed),
        events: 0,
        tierFaults: {},
        bulkFaults: {},
        slots: 1,
        clients: 1,
        ops: 14,
        snapshotEvery: 0,
        sealDelayMs: 1e9,
      },
      directory,
    );
    // After the clients are done and every operation acknowledged, the tail "fails over" to a
    // replica that was behind: its newest two entries are gone. The checks have to notice.
    sim.afterClients = () => sim.tier.loseLast("b1", 2);
    const report = await sim.run();
    rmSync(directory, { recursive: true, force: true });
    if (!report.ok) detected += 1;
  }
  return { detected, of: trials };
}

if (child) {
  const reports = await execute(from, runs);
  console.log(`CHILD ${JSON.stringify(reports)}`);
  process.exit(0);
}

const started = performance.now();
let reports: SimReport[] = [];
if (workers <= 1) reports = await execute(from, runs);
else {
  const per = Math.ceil(runs / workers);
  const jobs = Array.from({ length: workers }, (_, index) => {
    const start = from + index * per;
    const count = Math.min(per, from + runs - start);
    return Bun.spawn(
      ["bun", import.meta.path, "--child", "--from", String(start), "--runs", String(count)],
      {
        stdout: "pipe",
        stderr: "inherit",
      },
    );
  });
  for (const job of jobs) {
    const text = await new Response(job.stdout).text();
    const line = text.split("\n").find((item) => item.startsWith("CHILD "));
    if (line) reports.push(...(JSON.parse(line.slice(6)) as SimReport[]));
  }
}
const seconds = (performance.now() - started) / 1000;

const sum = (pick: (report: SimReport) => number) =>
  reports.reduce((total, report) => total + pick(report), 0);
const failed = reports.filter((report) => !report.ok);
const control = negative ? await negativeControl() : null;
const result = {
  experiment: "E5",
  environment: {
    ...machine(),
    simulation: "in-memory tail and bucket, virtual clock, real SQLite caches",
  },
  runs: reports.length,
  from,
  violations: failed.length,
  failedSeeds: failed
    .slice(0, 20)
    .map((report) => ({ seed: report.seed, first: report.violations[0] })),
  totals: {
    operationsAcknowledged: sum((r) => r.acked),
    operationsGivenUp: sum((r) => r.gaveUp),
    entriesInLogs: sum((r) => r.entries),
    processKills: sum((r) => r.kills),
    processOpens: sum((r) => r.opens),
    commits: sum((r) => r.commits),
    lostRacesRetried: sum((r) => r.conflicts),
    uncertainCommits: sum((r) => r.uncertain),
    resolvedAsOurs: sum((r) => r.resolvedOurs),
    fenceRefusals: sum((r) => r.fenceRefusals),
    catchUps: sum((r) => r.catchUps),
    rebuilds: sum((r) => r.rebuilds),
    sealedSegments: sum((r) => r.sealedSegments),
    snapshots: sum((r) => r.snapshots),
  },
  negativeControl: control,
  seconds: Math.round(seconds * 10) / 10,
  pass: failed.length === 0 && reports.length >= Math.min(runs, 10_000),
};

console.log(
  `\nE5: ${reports.length} seeded runs (seeds ${from} to ${from + runs - 1}) in ${result.seconds} s`,
);
printTable(
  ["what", "total"],
  Object.entries(result.totals).map(([name, value]) => [name, value]),
);
console.log(`\ninvariant violations: ${failed.length}${failed.length ? "" : " (none)"}`);
for (const item of result.failedSeeds.slice(0, 10))
  console.log(`  seed ${item.seed}: ${item.first}`);
if (control)
  console.log(
    `negative control (a tail that loses its newest entries): detected in ${control.detected} of ${control.of} runs`,
  );
console.log(`\nJSON: ${JSON.stringify(result)}`);
record("E5", result, args.has("json") ? { out: args.string("json", "") } : {});

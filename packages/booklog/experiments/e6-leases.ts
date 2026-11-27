/** E6: are leases and fencing correct? Pods contend for one book while a process freezes for longer
 * than its lease, the tail becomes unreachable, a wall clock is stepped or a machine is suspended,
 * and a process dies and comes back. Clients write, and read: a read must show every operation that
 * was acknowledged before the read began.
 *
 * Measured, per scenario:
 *   stale reads        a read that missed an operation acknowledged before it began
 *   stale-fence writes an append the tail accepted that was not under the newest fence
 *   lease overlaps     two different holders on the tail's clock at once
 *   I1 to I4           the durability invariants of E5 (the book, the chain, the materialized copy)
 * Pass: zero of each in the scenarios the design covers (a monotonic clock within its assumed bound,
 * with the wall-clock check on). The scenarios that take a protection away are run to show what that
 * protection is for: reads may go stale (never writes), because the fence is the tail's own.
 *
 *   bun experiments/e6-leases.ts [--runs 300] [--json path] */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machine, parseArgs, printTable, record } from "./lib.ts";
import { Rng } from "../src/rng.ts";
import {
  failedReport,
  randomConfig,
  runSimulation,
  type SimConfig,
  type SimReport,
} from "../test/support/sim.ts";

const args = parseArgs();
const runs = args.number("runs", 300);

interface Scenario {
  readonly name: string;
  readonly covered: boolean;
  readonly describe: string;
  readonly configure: (seed: number, base: SimConfig) => Partial<SimConfig>;
}

const scenarios: readonly Scenario[] = [
  {
    name: "within the design",
    covered: true,
    describe:
      "drift up to 0.8% (the bound is 1%), wall-clock check on; pauses, partitions, steps, suspends, restarts",
    configure: (seed) => ({
      drift: new Rng(seed).next() * 0.008,
      wallGuard: true,
      assumedDrift: 0.01,
    }),
  },
  {
    name: "a clock 5% slow",
    covered: true,
    describe: "past the assumed bound, but the wall-clock check still catches a clock that far off",
    configure: () => ({ drift: 0.05, wallGuard: true, assumedDrift: 0.01 }),
  },
  {
    name: "suspend without the wall check",
    covered: false,
    describe:
      "the wall-clock check off: a machine suspended past its lease believes it still holds it on waking",
    configure: (seed) => ({
      drift: new Rng(seed).next() * 0.008,
      wallGuard: false,
      assumedDrift: 0.01,
    }),
  },
  {
    name: "a clock 60% slow, no checks",
    covered: false,
    describe:
      "far outside the bound with the wall-clock check off: the lease timer is simply wrong",
    configure: () => ({ drift: 0.6, wallGuard: false, assumedDrift: 0 }),
  },
];

interface Totals {
  runs: number;
  reads: number;
  staleReads: number;
  runsWithStaleReads: number;
  staleFence: number;
  overlaps: number;
  invariantViolations: number;
  fenceRefusals: number;
  conflicts: number;
  kills: number;
  acked: number;
  firstViolation: string | null;
}

async function run(scenario: Scenario): Promise<Totals> {
  const totals: Totals = {
    runs: 0,
    reads: 0,
    staleReads: 0,
    runsWithStaleReads: 0,
    staleFence: 0,
    overlaps: 0,
    invariantViolations: 0,
    fenceRefusals: 0,
    conflicts: 0,
    kills: 0,
    acked: 0,
    firstViolation: null,
  };
  for (let seed = 1; seed <= runs; seed += 1) {
    const base = randomConfig(seed);
    const rng = new Rng(seed * 7);
    const override: Partial<SimConfig> = {
      slots: rng.between(2, 3),
      clients: 2,
      ops: 16,
      events: 8,
      readRatio: 2,
      stress: "leases",
      tierFaults: {},
      bulkFaults: {},
      leaseTtlMs: rng.between(1500, 4000),
      ...scenario.configure(seed, base),
    };
    const directory = mkdtempSync(join(tmpdir(), `booklog-e6-${seed}-`));
    let report: SimReport;
    try {
      report = await runSimulation(seed, directory, override);
    } catch (error) {
      report = failedReport(
        seed,
        `the run itself failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      rmSync(directory, { recursive: true, force: true });
    }
    totals.runs += 1;
    totals.reads += report.reads;
    totals.staleReads += report.staleReads;
    if (report.staleReads > 0) totals.runsWithStaleReads += 1;
    totals.staleFence += report.staleFenceAccepted;
    totals.overlaps += report.leaseOverlaps;
    if (!report.ok) {
      totals.invariantViolations += 1;
      totals.firstViolation ??= `seed ${seed}: ${report.violations[0]}`;
    }
    totals.fenceRefusals += report.fenceRefusals;
    totals.conflicts += report.conflicts;
    totals.kills += report.kills;
    totals.acked += report.acked;
  }
  return totals;
}

const started = performance.now();
const results: { scenario: Scenario; totals: Totals }[] = [];
for (const scenario of scenarios) {
  console.error(`  ${scenario.name} ...`);
  results.push({ scenario, totals: await run(scenario) });
}
const seconds = (performance.now() - started) / 1000;

const pass = results
  .filter((item) => item.scenario.covered)
  .every(
    (item) =>
      item.totals.staleReads === 0 &&
      item.totals.staleFence === 0 &&
      item.totals.overlaps === 0 &&
      item.totals.invariantViolations === 0,
  );
const unprotectedWritesSafe = results.every(
  (item) => item.totals.staleFence === 0 && item.totals.invariantViolations === 0,
);

const result = {
  experiment: "E6",
  environment: {
    ...machine(),
    simulation: "in-memory tail and bucket, virtual clock, real SQLite caches",
  },
  runsPerScenario: runs,
  scenarios: results.map(({ scenario, totals }) => ({
    name: scenario.name,
    covered: scenario.covered,
    describe: scenario.describe,
    ...totals,
  })),
  pass,
  writesSafeEvenWithoutLeaseChecks: unprotectedWritesSafe,
  seconds: Math.round(seconds * 10) / 10,
};

console.log(`\nE6: ${runs} runs per scenario in ${result.seconds} s`);
printTable(
  [
    "scenario",
    "covered",
    "reads",
    "stale reads (runs)",
    "stale-fence writes",
    "lease overlaps",
    "I1-I4 violations",
    "fence refusals",
  ],
  results.map(({ scenario, totals }) => [
    scenario.name,
    scenario.covered ? "yes" : "no",
    totals.reads,
    `${totals.staleReads} (${totals.runsWithStaleReads})`,
    totals.staleFence,
    totals.overlaps,
    totals.invariantViolations,
    totals.fenceRefusals,
  ]),
);
for (const { scenario, totals } of results)
  if (totals.firstViolation) console.log(`  ${scenario.name}: ${totals.firstViolation}`);
console.log(
  `\ncovered scenarios: ${pass ? "PASS" : "FAIL"}; writes stayed safe in every scenario, including those with a protection removed: ${unprotectedWritesSafe ? "yes" : "NO"}`,
);
console.log(`\nJSON: ${JSON.stringify(result)}`);
record("E6", result, args.has("json") ? { out: args.string("json", "") } : {});

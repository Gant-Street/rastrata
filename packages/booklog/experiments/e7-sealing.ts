/** E7: is sealing correct? Entries are appended to the tail while sealers move them into the bulk
 * store, a compactor merges old segments, readers materialize the log at random moments, and the bulk
 * store goes down, loses answers and kills a sealer between writing a segment and recording it.
 * Pass, in every run: no gap, no duplicate, no lost entry (the finished log reads whole and equals the
 * entries appended; segments agree where they overlap); the tail empties again once the bulk store is
 * back; a reader sees either a transient failure or the log, never a hole.
 *
 *   bun experiments/e7-sealing.ts [--runs 300] [--json path] */
import { machine, parseArgs, printTable, record } from "./lib.ts";
import { runSealScenario, type SealReport, type SealScenario } from "../test/support/seal-sim.ts";

const args = parseArgs();
const runs = args.number("runs", 300);
const scenarios: readonly { name: SealScenario; describe: string }[] = [
  {
    name: "crash-before-trim",
    describe: "a sealer is killed right after its segment is written, before the seal is recorded",
  },
  { name: "outage", describe: "the bulk store is unreachable for seconds while commits go on" },
  {
    name: "duplicates",
    describe: "two or three sealers race on the same tail while a compactor merges segments",
  },
  {
    name: "lost-answers",
    describe: "answers to segment writes, reads and seals are lost, and writes arrive twice",
  },
  { name: "mixed", describe: "all of it at once" },
];

const started = performance.now();
const rows: Record<string, unknown>[] = [];
const table: (string | number)[][] = [];
let allOk = true;
for (const { name, describe } of scenarios) {
  const reports: SealReport[] = [];
  for (let seed = 1; seed <= runs; seed += 1) {
    try {
      reports.push(await runSealScenario(seed, name));
    } catch (error) {
      reports.push({
        seed,
        scenario: name,
        ok: false,
        violations: [
          `the run itself failed: ${error instanceof Error ? error.message : String(error)}`,
        ],
        entries: 0,
        segments: 0,
        overlappingSegments: 0,
        sealerKills: 0,
        deferred: 0,
        reused: 0,
        maxTailDepth: 0,
        finalTailDepth: 0,
        recoveryMs: null,
        readerReads: 0,
        readerTransientFailures: 0,
        readerGaps: 0,
      });
    }
  }
  const sum = (pick: (report: SealReport) => number) =>
    reports.reduce((total, report) => total + pick(report), 0);
  const failed = reports.filter((report) => !report.ok);
  const recoveries = reports
    .map((report) => report.recoveryMs)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const row = {
    scenario: name,
    describe,
    runs: reports.length,
    violations: failed.length,
    firstViolation: failed[0] ? `seed ${failed[0].seed}: ${failed[0].violations[0]}` : null,
    entries: sum((r) => r.entries),
    segments: sum((r) => r.segments),
    overlappingEntries: sum((r) => r.overlappingSegments),
    sealerKills: sum((r) => r.sealerKills),
    deferredRounds: sum((r) => r.deferred),
    segmentsAdopted: sum((r) => r.reused),
    maxTailDepth: Math.max(...reports.map((r) => r.maxTailDepth)),
    finalTailDepthMax: Math.max(...reports.map((r) => r.finalTailDepth)),
    recoveryMsMedian: recoveries.length ? recoveries[Math.floor(recoveries.length / 2)] : null,
    recoveryMsMax: recoveries.length ? recoveries[recoveries.length - 1] : null,
    readerReads: sum((r) => r.readerReads),
    readerTransientFailures: sum((r) => r.readerTransientFailures),
    readerGaps: sum((r) => r.readerGaps),
  };
  rows.push(row);
  if (failed.length) allOk = false;
  table.push([
    name,
    row.runs,
    row.violations,
    row.sealerKills,
    row.deferredRounds,
    row.segmentsAdopted,
    row.overlappingEntries,
    row.maxTailDepth,
    row.finalTailDepthMax,
    row.recoveryMsMedian === null ? "-" : Math.round(row.recoveryMsMedian as number),
    row.readerGaps,
  ]);
}
const seconds = (performance.now() - started) / 1000;
const result = {
  experiment: "E7",
  environment: { ...machine(), simulation: "in-memory tail and bucket, virtual clock" },
  runsPerScenario: runs,
  scenarios: rows,
  pass: allOk,
  seconds: Math.round(seconds * 10) / 10,
};
console.log(`\nE7: ${runs} runs per scenario in ${result.seconds} s`);
printTable(
  [
    "scenario",
    "runs",
    "violations",
    "sealer kills",
    "deferred rounds",
    "adopted segments",
    "overlapping entries",
    "max tail depth",
    "final depth",
    "recovery ms (median)",
    "reader gaps",
  ],
  table,
);
for (const row of rows)
  if (row.firstViolation) console.log(`  ${row.scenario}: ${row.firstViolation}`);
console.log(
  `\n${allOk ? "PASS: no gap, no duplicate, no lost entry, and the tail always emptied" : "FAIL"}`,
);
console.log(`\nJSON: ${JSON.stringify(result)}`);
record("E7", result, args.has("json") ? { out: args.string("json", "") } : {});

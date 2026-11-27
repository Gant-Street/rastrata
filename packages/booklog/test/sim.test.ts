import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomConfig, runSimulation, type SimReport } from "./support/sim.ts";

/** Seeded runs of whole systems: pods that die, a tail and a bucket that lose, duplicate and
 * delay what is sent to them, clients that retry. After each run the book is read back from
 * nothing and the invariants are checked:
 *   I1 an acknowledged operation is in the book, exactly once;
 *   I2 the log is one hash chain with no gap;
 *   I3 a book materialized from the log (by a snapshot and the tail, or whole) equals the book;
 *   I4 at most one entry was ever accepted for a sequence number. */
const RUNS = Number(process.env.BOOKLOG_SIM_RUNS ?? "60");
const FROM = Number(process.env.BOOKLOG_SIM_FROM ?? "1");

test(`${RUNS} seeded runs under faults keep every invariant`, async () => {
  const reports: SimReport[] = [];
  for (let seed = FROM; seed < FROM + RUNS; seed += 1) {
    const directory = mkdtempSync(join(tmpdir(), `booklog-sim-${seed}-`));
    const report = await runSimulation(seed, directory);
    reports.push(report);
    if (!report.ok) {
      console.log(`seed ${seed} violated: ${report.violations.slice(0, 5).join("; ")}`);
      console.log(JSON.stringify(randomConfig(seed)));
    }
  }
  const failed = reports.filter((report) => !report.ok);
  expect(failed.map((report) => `${report.seed}: ${report.violations[0]}`)).toEqual([]);
  // The runs must have been rough enough to mean something.
  expect(reports.reduce((sum, report) => sum + report.kills, 0)).toBeGreaterThan(5);
  expect(reports.reduce((sum, report) => sum + report.resolvedOurs, 0)).toBeGreaterThan(0);
  expect(reports.reduce((sum, report) => sum + report.acked, 0)).toBeGreaterThan(RUNS * 5);
}, 600_000);

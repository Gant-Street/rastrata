import { expect, test } from "bun:test";
import { runSealScenario, type SealScenario } from "./support/seal-sim.ts";

const SCENARIOS: readonly SealScenario[] = [
  "crash-before-trim",
  "outage",
  "duplicates",
  "lost-answers",
  "mixed",
];
const RUNS = Number(process.env.BOOKLOG_SEAL_RUNS ?? "40");

for (const scenario of SCENARIOS)
  test(`sealing under '${scenario}': no gap, no duplicate, no lost entry, and the tail empties (${RUNS} seeds)`, async () => {
    const failures: string[] = [];
    let kills = 0;
    let deferred = 0;
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const report = await runSealScenario(seed, scenario);
      kills += report.sealerKills;
      deferred += report.deferred;
      if (!report.ok) failures.push(`seed ${seed}: ${report.violations[0]}`);
      expect(report.readerGaps).toBe(0);
    }
    expect(failures).toEqual([]);
    // The scenario must actually have done what its name says.
    if (scenario === "crash-before-trim") expect(kills).toBeGreaterThan(0);
    if (scenario === "outage") expect(deferred).toBeGreaterThan(0);
  });

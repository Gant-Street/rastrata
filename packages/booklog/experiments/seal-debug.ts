/** Run one sealing scenario and print the report: bun experiments/seal-debug.ts <scenario> <seed> */
import { runSealScenario, type SealScenario } from "../test/support/seal-sim.ts";

const scenario = (process.argv[2] ?? "outage") as SealScenario;
const seed = Number(process.argv[3] ?? "1");
const started = performance.now();
try {
  const report = await runSealScenario(seed, scenario);
  console.log(JSON.stringify(report, null, 1));
} catch (error) {
  console.log("failed:", error instanceof Error ? error.message : String(error));
}
console.log(`${Math.round(performance.now() - started)} ms`);

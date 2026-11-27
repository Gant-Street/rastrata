/** Run one seeded simulation and print what the tail and the processes did at the end. For finding
 * out why a seed violated an invariant: bun experiments/sim-debug.ts <seed> */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sim, randomConfig } from "../test/support/sim.ts";

const seed = Number(process.argv[2] ?? "1");
const config = randomConfig(seed);
console.log(JSON.stringify(config));
const sim = new Sim(config, mkdtempSync(join(tmpdir(), `booklog-debug-${seed}-`)));
let report: Awaited<ReturnType<Sim["run"]>>;
try {
  report = await sim.run();
} catch (error) {
  console.log("the run failed:", error instanceof Error ? error.message : String(error));
  for (const pod of sim.pods)
    console.log(
      pod.holder,
      pod.alive ? "alive" : "dead",
      pod.runtime ? `runtime busy=${pod.runtime.busy} head=${pod.runtime.head.seq}` : "no runtime",
    );
  for (const runtime of sim.runtimes) console.log("runtime", runtime.stats.commits, runtime.busy);
  process.exit(1);
}
console.log(JSON.stringify(report));
const tail = sim.tier.records.filter((record) => record.op !== "append").slice(-14);
for (const record of tail)
  console.log(
    `${String(record.at).padStart(8)} ${record.op.padEnd(8)} ${record.holder ?? record.client} fence=${record.fence} expires=${record.expiresAt ?? ""}`,
  );
console.log(
  "now",
  sim.clock.now(),
  "pods",
  sim.pods
    .map(
      (pod) => `${pod.holder}:${pod.alive ? "alive" : "dead"}:${pod.runtime ? "open" : "closed"}`,
    )
    .join(" "),
);

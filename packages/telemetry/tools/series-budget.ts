// The most time series the catalog can ever make, per process and for a fleet. Run it with
//   bun packages/telemetry/tools/series-budget.ts [--pods=6] [--check]
// A metric's worst case is the product of the sizes of its label sets times the series each
// combination makes (a histogram makes buckets + 3). Not every combination happens, so the real
// number is lower; the worst case is the number that cannot be exceeded whatever the traffic.
// `--check` exits 1 when a tier is over its budget (SERIES_BUDGET in catalog.ts); a test does the same.
import {
  METRICS,
  METRIC_NAMES,
  SERIES_BUDGET,
  prometheusName,
  worstCaseSeries,
  type MetricSpec,
} from "../src/catalog.ts";

const arg = (name: string) =>
  process.argv.find((item) => item.startsWith(`--${name}=`))?.split("=")[1];
const pods = Number(arg("pods") ?? "6");

const rows = METRIC_NAMES.map((name) => {
  const spec = METRICS[name] as MetricSpec;
  const labels = Object.entries(spec.labels)
    .map(([key, values]) => `${key}(${(values as readonly string[]).length})`)
    .join(" x ");
  return { name, spec, series: worstCaseSeries(name), labels: labels || "-" };
});
const total = (tier: "core" | "detail") =>
  rows.filter((row) => row.spec.tier === tier).reduce((sum, row) => sum + row.series, 0);

console.log(
  `${"metric".padEnd(26)} ${"kind".padEnd(9)} ${"tier".padEnd(6)} ${"series".padStart(6)}  labels`,
);
for (const row of rows)
  console.log(
    `${row.name.padEnd(26)} ${row.spec.kind.padEnd(9)} ${row.spec.tier.padEnd(6)} ${String(row.series).padStart(6)}  ${row.labels}   -> ${prometheusName(row.name)}`,
  );
const core = total("core");
const detail = total("detail");
console.log("");
console.log(
  `worst case per process: core ${core} (budget ${SERIES_BUDGET.corePerProcess}), detail ${detail} (budget ${SERIES_BUDGET.detailPerProcess})`,
);
console.log(
  `worst case for ${pods} processes sent to Grafana Cloud (core only): ${core * pods} of 10,000 free active series`,
);
if (
  process.argv.includes("--check") &&
  (core > SERIES_BUDGET.corePerProcess || detail > SERIES_BUDGET.detailPerProcess)
) {
  console.error("over budget: trim a label set or move a metric to the detail tier");
  process.exit(1);
}

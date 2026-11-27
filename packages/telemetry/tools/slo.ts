/** The latency budget as data: the seven things a person waits for, the metric that measures each,
 * and the number it must stay under (docs/reference/hosting-program.md, "The latency budget").
 * The dashboards, the recording rules and the burn alerts are all generated from this list, and a
 * test checks every threshold is a boundary of its histogram, so "p95 is under budget" is the share of
 * observations in or below one bucket and nothing is interpolated. */
import { type HistogramName, prometheusName } from "../src/catalog.ts";
import { type YamlValue, toYaml } from "./yaml.ts";

export interface Slo {
  /** A word for labels and rule names. */
  readonly id: string;
  readonly title: string;
  readonly metric: HistogramName;
  /** A PromQL label selector, `{...}`, or empty. */
  readonly selector: string;
  /** The share of observations that must be at or under the threshold: 0.95 for a p95. */
  readonly objective: number;
  /** The limit in seconds; a bucket boundary of the metric. */
  readonly threshold: number;
  /** What the budget says, in the table's words. */
  readonly budget: string;
  /** Where it is measured. */
  readonly measuredBy: string;
}

export const SLOS: readonly Slo[] = [
  {
    id: "read",
    title: "A read request",
    metric: "request.duration",
    selector: '{operation_class="read"}',
    objective: 0.95,
    threshold: 0.1,
    budget: "p95 at most 100 ms",
    measuredBy: "server, request.duration of the read class",
  },
  {
    id: "commit",
    title: "A commit (tail append)",
    metric: "commit.duration",
    selector: "",
    objective: 0.95,
    threshold: 0.1,
    budget: "p95 at most 100 ms (target 30 ms)",
    measuredBy: "server, commit.duration",
  },
  {
    id: "click",
    title: "Click to confirmed",
    metric: "web.action.duration",
    selector: "",
    objective: 0.95,
    threshold: 0.25,
    budget: "p95 at most 250 ms",
    measuredBy: "browser, web.action.duration (accept, post, save)",
  },
  {
    id: "report",
    title: "A report on a book under 5,000 journals",
    metric: "report.duration",
    selector: '{size_bucket=~"xs|s|m"}',
    objective: 0.95,
    threshold: 0.3,
    budget: "p95 at most 300 ms",
    measuredBy: "server, report.duration of the xs, s and m buckets",
  },
  {
    id: "cold_open",
    title: "Opening a cold book under 5,000 journals",
    metric: "activation.duration",
    selector: '{size_bucket=~"xs|s|m"}',
    objective: 0.95,
    threshold: 3,
    budget: "at most 3 s (read here as p95)",
    measuredBy: "server, activation.duration of the xs, s and m buckets",
  },
  {
    id: "inp",
    title: "Interaction to next paint",
    metric: "web.inp",
    selector: "",
    objective: 0.75,
    threshold: 0.2,
    budget: "p75 at most 200 ms",
    measuredBy: "browser, web.inp",
  },
  {
    id: "lcp",
    title: "Largest contentful paint",
    metric: "web.lcp",
    selector: "",
    objective: 0.75,
    threshold: 2.5,
    budget: "p75 at most 2.5 s",
    measuredBy: "browser, web.lcp",
  },
];

/** The text Prometheus gives a bucket boundary in its `le` label. */
export const leOf = (threshold: number): string => String(threshold);

const series = (slo: Slo, suffix: "bucket" | "count") => `${prometheusName(slo.metric)}_${suffix}`;

/** `sum(rate(<bucket, at or under the threshold>[w])) / sum(rate(<count>[w]))`: the share of
 * observations within budget over a window. */
export function goodRatio(slo: Slo, window: string): string {
  const inside = slo.selector
    ? slo.selector.replace(/\}$/, `,le="${leOf(slo.threshold)}"}`)
    : `{le="${leOf(slo.threshold)}"}`;
  return `sum(rate(${series(slo, "bucket")}${inside}[${window}])) / sum(rate(${series(slo, "count")}${slo.selector}[${window}]))`;
}

/** The quantile the objective names (0.95 or 0.75) of the metric over a window, in seconds. */
export function quantileExpr(slo: Slo, window: string): string {
  return `histogram_quantile(${slo.objective}, sum by (le) (rate(${series(slo, "bucket")}${slo.selector}[${window}])))`;
}

/** One tier of burn alert: the long and short window it must hold over, the burn rate it must exceed
 * (the bad share over the share the objective allows; 1 spends the 28-day budget in 28 days), how
 * long it must hold, and how serious it is. */
export interface BurnWindow {
  readonly long: string;
  readonly short: string;
  readonly rate: number;
  readonly severity: "critical" | "warning" | "info";
  readonly wait: string;
}

/** The fast burn that pages (2% of a 28-day budget in an hour), the slow burn that opens a ticket (5%
 * in six hours) and the leak (10% in three days), for the p95 objectives. */
const P95_WINDOWS: readonly BurnWindow[] = [
  { long: "1h", short: "5m", rate: 14.4, severity: "critical", wait: "2m" },
  { long: "6h", short: "30m", rate: 6, severity: "warning", wait: "15m" },
  { long: "3d", short: "6h", rate: 1, severity: "info", wait: "1h" },
];

/** A p75 objective allows a quarter of observations to be bad, so no burn rate above 4 can ever be
 * reached; the same three tiers fire at 90%, 50% and 25% of observations over the limit. */
const P75_WINDOWS: readonly BurnWindow[] = [
  { long: "1h", short: "5m", rate: 3.6, severity: "critical", wait: "2m" },
  { long: "6h", short: "30m", rate: 2, severity: "warning", wait: "15m" },
  { long: "3d", short: "6h", rate: 1, severity: "info", wait: "1h" },
];

export const burnWindows = (slo: Slo): readonly BurnWindow[] =>
  slo.objective >= 0.9 ? P95_WINDOWS : P75_WINDOWS;

/** Observations in a window below which a burn alert does not speak: one slow request among a few
 * is not a trend. */
export const MIN_OBSERVATIONS = 50;

export const RULE_WINDOWS = ["5m", "30m", "1h", "6h", "3d"] as const;

const round = (value: number): number => Math.round(value * 1e6) / 1e6;
const percent = (value: number): string => `${Math.round(value * 1000) / 10}%`;

export const ALERT_NAMES = {
  critical: "RastrataSloBurnFast",
  warning: "RastrataSloBurnSlow",
  info: "RastrataSloBurnLeak",
} as const;

/** What an alert says. Static text, so a promtool test can compare it. */
export function alertAnnotations(slo: Slo, burn: BurnWindow): Record<string, string> {
  return {
    summary: `${slo.title} is spending its error budget ${burn.rate} times too fast`,
    description: `Budget: ${slo.budget} (${slo.measuredBy}). Over ${burn.long} and over ${burn.short} more than ${percent((1 - slo.objective) * burn.rate)} of observations were over ${slo.threshold} s, which spends the 28-day budget in ${(28 / burn.rate).toFixed(1)} days.`,
    runbook: "docs/reference/program/hosting/hostobs.md#slo-burn-alerts",
  };
}

const HEADER = [
  "# GENERATED by packages/telemetry/tools/deploy-files.ts from packages/telemetry/tools/slo.ts: do not edit by hand.",
  "# The latency budget (docs/reference/hosting-program.md) as recording rules and multi-window burn-rate",
  "# alerts. A thing within budget is an observation at or under a histogram bucket boundary, so the good",
  "# ratio is exact. The burn rate is the bad share over the share the objective allows: 1 spends the 28-day",
  "# budget exactly in 28 days, 14.4 spends 2% of it in an hour.",
  "",
].join("\n");

/** The recording rules and burn alerts, generated from SLOS. */
export function sloRules(): { groups: YamlValue[] } {
  const recording: YamlValue[] = [];
  const alerts: YamlValue[] = [];
  for (const slo of SLOS) {
    for (const window of RULE_WINDOWS)
      recording.push(
        {
          record: `rastrata:slo_good_ratio:rate${window}`,
          expr: goodRatio(slo, window),
          labels: { slo: slo.id },
        },
        {
          record: `rastrata:slo_observations:increase${window}`,
          expr: `sum(increase(${series(slo, "count")}${slo.selector}[${window}]))`,
          labels: { slo: slo.id },
        },
        {
          record: `rastrata:slo_burn_rate:rate${window}`,
          expr: `(1 - ${goodRatio(slo, window)}) / ${round(1 - slo.objective)}`,
          labels: { slo: slo.id },
        },
      );
    for (const burn of burnWindows(slo)) {
      const selector = `{slo="${slo.id}"}`;
      alerts.push({
        alert: ALERT_NAMES[burn.severity],
        expr: `${[
          `rastrata:slo_burn_rate:rate${burn.long}${selector} > ${burn.rate}`,
          `and rastrata:slo_burn_rate:rate${burn.short}${selector} > ${burn.rate}`,
          `and rastrata:slo_observations:increase${burn.long}${selector} > ${MIN_OBSERVATIONS}`,
        ].join("\n")}\n`,
        for: burn.wait,
        labels: { severity: burn.severity, slo: slo.id },
        annotations: alertAnnotations(slo, burn),
      });
    }
  }
  return {
    groups: [
      { name: "rastrata-slo-recording", interval: "1m", rules: recording },
      { name: "rastrata-slo-alerts", rules: alerts },
    ],
  };
}

export const sloRulesYaml = (): string => HEADER + toYaml(sloRules());

/** The `promtool test rules` file for the SLO rules, for one objective of each kind: a p95 and a p75.
 * With every observation over the limit the fast and slow burn alerts fire (and the leak, which needs
 * an hour more, does not yet); with every one inside it, nothing does. The annotations compared are
 * the generated rules' own words. */
export function sloTestYaml(): string {
  const tests: YamlValue[] = [];
  for (const id of ["commit", "inp"]) {
    const slo = SLOS.find((candidate) => candidate.id === id);
    if (!slo) throw new Error(`the SLO list has no ${id}`);
    const [fast, slow] = burnWindows(slo) as readonly [BurnWindow, BurnWindow, BurnWindow];
    const bucket = prometheusName(slo.metric);
    const inside = `${bucket}_bucket{le="${leOf(slo.threshold)}", instance="pod-a"}`;
    const count = `${bucket}_count{instance="pod-a"}`;
    const expected = (burn: BurnWindow) => [
      {
        exp_labels: { severity: burn.severity, slo: slo.id },
        exp_annotations: alertAnnotations(slo, burn),
      },
    ];
    tests.push(
      {
        name: `${slo.id}: every observation is over the limit`,
        interval: "1m",
        input_series: [
          { series: inside, values: "0+0x120" },
          { series: count, values: "0+100x120" },
        ],
        promql_expr_test: [
          {
            expr: `rastrata:slo_good_ratio:rate5m{slo="${slo.id}"}`,
            eval_time: "10m",
            exp_samples: [{ labels: `rastrata:slo_good_ratio:rate5m{slo="${slo.id}"}`, value: 0 }],
          },
        ],
        alert_rule_test: [
          { eval_time: "1m", alertname: ALERT_NAMES.critical, exp_alerts: [] },
          { eval_time: "40m", alertname: ALERT_NAMES.critical, exp_alerts: expected(fast) },
          { eval_time: "40m", alertname: ALERT_NAMES.warning, exp_alerts: expected(slow) },
          { eval_time: "40m", alertname: ALERT_NAMES.info, exp_alerts: [] },
        ],
      },
      {
        name: `${slo.id}: every observation is inside the limit`,
        interval: "1m",
        input_series: [
          { series: inside, values: "0+100x120" },
          { series: count, values: "0+100x120" },
        ],
        promql_expr_test: [
          {
            expr: `rastrata:slo_good_ratio:rate5m{slo="${slo.id}"}`,
            eval_time: "10m",
            exp_samples: [{ labels: `rastrata:slo_good_ratio:rate5m{slo="${slo.id}"}`, value: 1 }],
          },
        ],
        alert_rule_test: Object.values(ALERT_NAMES).map((alertname) => ({
          eval_time: "40m",
          alertname,
          exp_alerts: [],
        })),
      },
    );
  }
  const header =
    "# GENERATED by packages/telemetry/tools/deploy-files.ts from packages/telemetry/tools/slo.ts: do not edit by hand.\n";
  return `${header}${toYaml({ rule_files: ["slo.rules.yaml"], evaluation_interval: "1m", tests })}`;
}

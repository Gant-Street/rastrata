/** Scenarios for `promtool test rules`: input series, and for each alert when it must fire and when it
 * must stay quiet. The test file (deploy/observability/alerts/ops.rules.test.yaml) is generated from
 * these and from the rule file, so the annotations promtool compares are the rule file's own words;
 * what is independent is the data and the expectation. */
import { type YamlValue, toYaml } from "./yaml.ts";

export interface Scenario {
  readonly name: string;
  readonly alert: string;
  readonly series: ReadonlyArray<readonly [series: string, values: string]>;
  /** Times at which the alert must be firing, with the labels it carries besides severity. */
  readonly fires?: ReadonlyArray<readonly [at: string, labels?: Record<string, string>]>;
  /** Times at which it must not be. */
  readonly quiet?: readonly string[];
}

const pod = 'instance="pod-a"';

export const OPS_SCENARIOS: readonly Scenario[] = [
  {
    name: "R2 Class A at 10 a second for a quarter of an hour",
    alert: "RastrataR2ClassARateHigh",
    series: [
      [`rastrata_r2_operations_total{r2_class="A", r2_op="put", outcome="ok", ${pod}}`, "0+600x60"],
    ],
    fires: [["35m"]],
    quiet: ["10m"],
  },
  {
    name: "R2 Class A at 2 a second is nothing",
    alert: "RastrataR2ClassARateHigh",
    series: [
      [`rastrata_r2_operations_total{r2_class="A", r2_op="put", outcome="ok", ${pod}}`, "0+120x60"],
    ],
    quiet: ["10m", "30m", "50m"],
  },
  {
    name: "R2 Class A at 25 a second",
    alert: "RastrataR2ClassARateVeryHigh",
    series: [
      [
        `rastrata_r2_operations_total{r2_class="A", r2_op="put", outcome="ok", ${pod}}`,
        "0+1500x60",
      ],
    ],
    fires: [["25m"]],
    quiet: ["5m"],
  },
  {
    name: "Class B calls do not count",
    alert: "RastrataR2ClassARateVeryHigh",
    series: [
      [
        `rastrata_r2_operations_total{r2_class="B", r2_op="get", outcome="ok", ${pod}}`,
        "0+1500x60",
      ],
    ],
    quiet: ["30m"],
  },
  {
    name: "ten megabytes a minute added for a day and a half",
    alert: "RastrataStoredBytesGrowingFast",
    series: [
      [`rastrata_stored_bytes{size_bucket="xs", object_kind="log", ${pod}}`, "0+10000000x1700"],
    ],
    fires: [["12h"]],
    quiet: ["5h"],
  },
  {
    name: "a tenth of the commits lose a race",
    alert: "RastrataCommitConflictRateHigh",
    series: [
      [`rastrata_commit_duration_seconds_count{size_bucket="xs", ${pod}}`, "0+100x60"],
      [`rastrata_commit_conflicts_total{size_bucket="xs", ${pod}}`, "0+10x60"],
    ],
    fires: [["25m"]],
    quiet: ["10m"],
  },
  {
    name: "one commit in a hundred losing a race is normal",
    alert: "RastrataCommitConflictRateHigh",
    series: [
      [`rastrata_commit_duration_seconds_count{size_bucket="xs", ${pod}}`, "0+100x60"],
      [`rastrata_commit_conflicts_total{size_bucket="xs", ${pod}}`, "0+1x60"],
    ],
    quiet: ["25m", "50m"],
  },
  {
    name: "a stale writer is refused once",
    alert: "RastrataFenceRejections",
    series: [[`rastrata_lease_fence_rejections_total{tail_op="append", ${pod}}`, "0+0x5 3+0x60"]],
    fires: [["15m"]],
    quiet: ["4m", "45m"],
  },
  {
    name: "the verifier is more than an hour behind",
    alert: "RastrataVerificationLagging",
    series: [[`rastrata_verify_lag_seconds{size_bucket="m", ${pod}}`, "4000+0x60"]],
    fires: [["20m"]],
    quiet: ["10m"],
  },
  {
    name: "a queue whose oldest item is ten minutes old",
    alert: "RastrataQueueOld",
    series: [[`rastrata_queue_age_seconds{queue="jobs", ${pod}}`, "700+0x60"]],
    fires: [["15m", { queue: "jobs" }]],
    quiet: ["5m"],
  },
  {
    name: "the tail is not being sealed",
    alert: "RastrataTailNotSealing",
    series: [[`rastrata_tail_age_seconds{${pod}}`, "300+0x30"]],
    fires: [["10m"]],
    quiet: ["3m"],
  },
  {
    name: "a tail that is sealed promptly",
    alert: "RastrataTailNotSealing",
    series: [[`rastrata_tail_age_seconds{${pod}}`, "5+0x30"]],
    quiet: ["10m", "25m"],
  },
  {
    name: "the tail has not been sealed for a quarter of an hour",
    alert: "RastrataTailNotSealingLong",
    series: [[`rastrata_tail_age_seconds{${pod}}`, "1000+0x40"]],
    fires: [["15m"]],
    quiet: ["3m"],
  },
  {
    name: "five minutes without sealing is a warning and not yet this",
    alert: "RastrataTailNotSealingLong",
    series: [[`rastrata_tail_age_seconds{${pod}}`, "300+0x40"]],
    quiet: ["10m", "30m"],
  },
  {
    name: "twenty thousand entries waiting",
    alert: "RastrataTailDeep",
    series: [[`rastrata_tail_depth{${pod}}`, "20000+0x30"]],
    fires: [["15m"]],
    quiet: ["5m"],
  },
  {
    name: "half of the seals fail",
    alert: "RastrataSealsFailing",
    series: [
      [`rastrata_seal_operations_total{outcome="ok", ${pod}}`, "0+10x60"],
      [`rastrata_seal_operations_total{outcome="server_error", ${pod}}`, "0+10x60"],
    ],
    fires: [["25m"]],
    quiet: ["5m"],
  },
  {
    name: "memory at 90% of the limit",
    alert: "RastrataMemoryNearLimit",
    series: [
      [`rastrata_process_memory_bytes{memory_kind="rss", ${pod}}`, "900+0x30"],
      [`rastrata_process_memory_limit_bytes{${pod}}`, "1000+0x30"],
    ],
    fires: [["10m", { instance: "pod-a" }]],
    quiet: ["3m"],
  },
  {
    name: "memory at half of the limit",
    alert: "RastrataMemoryNearLimit",
    series: [
      [`rastrata_process_memory_bytes{memory_kind="rss", ${pod}}`, "500+0x30"],
      [`rastrata_process_memory_limit_bytes{${pod}}`, "1000+0x30"],
    ],
    quiet: ["10m", "25m"],
  },
  {
    name: "memory at 98% of the limit",
    alert: "RastrataMemoryAtLimit",
    series: [
      [`rastrata_process_memory_bytes{memory_kind="rss", ${pod}}`, "980+0x30"],
      [`rastrata_process_memory_limit_bytes{${pod}}`, "1000+0x30"],
    ],
    fires: [["5m", { instance: "pod-a" }]],
    quiet: ["1m"],
  },
  {
    name: "a pod busy for eight hours",
    alert: "RastrataNeverIdle",
    series: [[`rastrata_process_idle_time_seconds{${pod}}`, "0+0x500"]],
    fires: [["8h", { instance: "pod-a" }]],
    quiet: ["3h"],
  },
  {
    name: "a pod that was idle for a moment three hours ago",
    alert: "RastrataNeverIdle",
    series: [[`rastrata_process_idle_time_seconds{${pod}}`, "0+0x200 30+0x1 0+0x300"]],
    quiet: ["8h"],
  },
  {
    name: "every timer fires half a second late or worse",
    alert: "RastrataEventLoopLagging",
    series: [
      [`rastrata_process_event_loop_lag_seconds_bucket{le="0.5", ${pod}}`, "0+0x60"],
      [`rastrata_process_event_loop_lag_seconds_bucket{le="+Inf", ${pod}}`, "0+10x60"],
    ],
    fires: [["20m"]],
    quiet: ["5m"],
  },
  {
    name: "every timer fires within a millisecond",
    alert: "RastrataEventLoopLagging",
    series: [
      [`rastrata_process_event_loop_lag_seconds_bucket{le="0.001", ${pod}}`, "0+10x60"],
      [`rastrata_process_event_loop_lag_seconds_bucket{le="+Inf", ${pod}}`, "0+10x60"],
    ],
    quiet: ["20m", "50m"],
  },
  {
    name: "fifty spans a minute dropped",
    alert: "RastrataTelemetryDropping",
    series: [
      [
        `rastrata_telemetry_dropped_total{telemetry_signal="traces", drop_reason="queue_full", ${pod}}`,
        "0+50x60",
      ],
    ],
    fires: [["15m"]],
    quiet: ["4m"],
  },
  {
    name: "ten in eleven exports fail",
    alert: "RastrataTelemetryExportsFailing",
    series: [
      [
        `rastrata_telemetry_exports_total{telemetry_signal="traces", export_result="failed", ${pod}}`,
        "0+10x60",
      ],
      [
        `rastrata_telemetry_exports_total{telemetry_signal="traces", export_result="ok", ${pod}}`,
        "0+1x60",
      ],
    ],
    fires: [["25m"]],
    quiet: ["10m"],
  },
  {
    name: "no pod reports memory",
    alert: "RastrataNoMetrics",
    series: [[`rastrata_unrelated_total{${pod}}`, "0+1x60"]],
    fires: [["10m", { memory_kind: "rss" }]],
    quiet: ["2m"],
  },
  {
    name: "a pod reports memory",
    alert: "RastrataNoMetrics",
    series: [[`rastrata_process_memory_bytes{memory_kind="rss", ${pod}}`, "100+0x60"]],
    quiet: ["20m", "50m"],
  },
  {
    name: "the collector fails to send metric points",
    alert: "RastrataCollectorSendFailing",
    series: [
      [
        `otelcol_exporter_send_failed_metric_points_total{exporter="otlp_http/grafana_cloud", ${pod}}`,
        "0+100x60",
      ],
    ],
    fires: [["20m"]],
    quiet: ["5m"],
  },
  {
    name: "the collector sends everything it is given",
    alert: "RastrataCollectorSendFailing",
    series: [
      [
        `otelcol_exporter_sent_metric_points_total{exporter="otlp_http/grafana_cloud", ${pod}}`,
        "0+100x60",
      ],
    ],
    quiet: ["20m", "50m"],
  },
  {
    name: "the collector's queue is 90% full",
    alert: "RastrataCollectorQueueFilling",
    series: [
      [`otelcol_exporter_queue_size{exporter="otlp_http/grafana_cloud", ${pod}}`, "450+0x30"],
      [`otelcol_exporter_queue_capacity{exporter="otlp_http/grafana_cloud", ${pod}}`, "500+0x30"],
    ],
    fires: [["10m"]],
    quiet: ["3m"],
  },
  {
    name: "the collector's queue is nearly empty",
    alert: "RastrataCollectorQueueFilling",
    series: [
      [`otelcol_exporter_queue_size{exporter="otlp_http/grafana_cloud", ${pod}}`, "5+0x30"],
      [`otelcol_exporter_queue_capacity{exporter="otlp_http/grafana_cloud", ${pod}}`, "500+0x30"],
    ],
    quiet: ["10m", "25m"],
  },
  {
    name: "the collector refuses spans",
    alert: "RastrataCollectorRefusingData",
    series: [[`otelcol_receiver_refused_spans_total{receiver="otlp", ${pod}}`, "0+10x30"]],
    fires: [["15m"]],
    quiet: ["3m"],
  },
];

interface Rule {
  alert: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

/** Read the alert rules out of a parsed rule file. */
export function alertsOf(rules: unknown): Map<string, Rule> {
  const out = new Map<string, Rule>();
  const groups = (rules as { groups: { rules: Partial<Rule>[] }[] }).groups;
  for (const group of groups)
    for (const rule of group.rules) if (rule.alert) out.set(rule.alert, rule as Rule);
  return out;
}

/** The `promtool test rules` file for a set of scenarios. */
export function testYaml(
  ruleFile: string,
  scenarios: readonly Scenario[],
  alerts: Map<string, Rule>,
  header: string,
): string {
  const tests = scenarios.map((scenario): YamlValue => {
    const rule = alerts.get(scenario.alert);
    if (!rule)
      throw new Error(`scenario "${scenario.name}" names an alert that is not in the rules`);
    return {
      name: scenario.name,
      interval: "1m",
      input_series: scenario.series.map(([series, values]) => ({ series, values })),
      alert_rule_test: [
        ...(scenario.quiet ?? []).map((at) => ({
          eval_time: at,
          alertname: scenario.alert,
          exp_alerts: [] as YamlValue[],
        })),
        ...(scenario.fires ?? []).map(([at, labels]) => ({
          eval_time: at,
          alertname: scenario.alert,
          exp_alerts: [
            {
              exp_labels: { ...rule.labels, ...(labels ?? {}) },
              exp_annotations: rule.annotations,
            },
          ],
        })),
      ],
    };
  });
  return `${header}${toYaml({ rule_files: [ruleFile], evaluation_interval: "1m", tests })}`;
}

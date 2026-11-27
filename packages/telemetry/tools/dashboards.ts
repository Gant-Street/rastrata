/** The Grafana dashboards, as data, rendered to JSON in deploy/observability/dashboards/.
 *
 * Every query is built from the catalog's own names (prometheusName), so a renamed metric breaks the
 * build rather than a panel, and a test reads each query back and checks that its metric and labels
 * exist. The dashboards read a datasource variable, so the same files load into the local stack and
 * into Grafana Cloud. Nothing here applies anything anywhere. */
import { type MetricName, prometheusName } from "../src/catalog.ts";
import { SLOS, type Slo, goodRatio, quantileExpr } from "./slo.ts";

const n = (name: MetricName): string => prometheusName(name);
const bucket = (name: MetricName) => `${n(name)}_bucket`;
const RATE = "$__rate_interval";

/** p-th quantile of a histogram over the interval, summed over everything but `by` (and le). */
const quantile = (q: number, name: MetricName, by = "", selector = "", window = RATE) =>
  `histogram_quantile(${q}, sum by (le${by ? `, ${by}` : ""}) (rate(${bucket(name)}${selector}[${window}])))`;
const rate = (name: MetricName, by = "", selector = "", window = RATE) =>
  by
    ? `sum by (${by}) (rate(${n(name)}${selector}[${window}]))`
    : `sum(rate(${n(name)}${selector}[${window}]))`;
/** Observations per second of a histogram: the rate of its `_count`. */
const observations = (name: MetricName, window = RATE) => `sum(rate(${n(name)}_count[${window}]))`;

type Datasource = "prometheus" | "tempo";
interface Target {
  readonly expr: string;
  readonly legend?: string;
  readonly instant?: boolean;
  readonly table?: boolean;
}
interface PanelSpec {
  readonly type: "timeseries" | "stat" | "table" | "text" | "bargauge";
  readonly title: string;
  readonly description?: string;
  readonly w: number;
  readonly h: number;
  readonly targets?: readonly Target[];
  readonly unit?: string;
  readonly decimals?: number;
  readonly min?: number;
  readonly max?: number;
  readonly stack?: boolean;
  /** Threshold lines on a graph, or colour steps on a stat. */
  readonly thresholds?: readonly { value: number; color?: string }[];
  readonly content?: string;
  readonly datasource?: Datasource;
  readonly raw?: Record<string, unknown>;
}

// Grafana dashboard variables, which look like template placeholders and are not.
// biome-ignore lint/suspicious/noTemplateCurlyInString: a Grafana variable
const TRACES_VARIABLE = "${traces}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: a Grafana variable
const DATASOURCE_VARIABLE = "${datasource}";

const datasourceRef = (kind: Datasource) =>
  kind === "tempo"
    ? { type: "tempo", uid: TRACES_VARIABLE }
    : { type: "prometheus", uid: DATASOURCE_VARIABLE };

function thresholdSteps(thresholds: PanelSpec["thresholds"]) {
  const steps: { color: string; value: number | null }[] = [{ color: "green", value: null }];
  for (const step of thresholds ?? [])
    steps.push({ color: step.color ?? "red", value: step.value });
  return { mode: "absolute", steps };
}

function render(spec: PanelSpec, id: number, x: number, y: number): Record<string, unknown> {
  const base = {
    id,
    title: spec.title,
    ...(spec.description ? { description: spec.description } : {}),
    type: spec.type,
    gridPos: { x, y, w: spec.w, h: spec.h },
  };
  if (spec.type === "text")
    return { ...base, options: { mode: "markdown", content: spec.content ?? "" }, ...spec.raw };
  const datasource = datasourceRef(spec.datasource ?? "prometheus");
  const targets = (spec.targets ?? []).map((target, index) => ({
    refId: String.fromCharCode(65 + index),
    datasource,
    expr: target.expr,
    legendFormat: target.legend ?? "__auto",
    ...(target.instant ? { instant: true, range: false } : { range: true }),
    ...(target.table ? { format: "table" } : {}),
  }));
  const defaults: Record<string, unknown> = {
    ...(spec.unit ? { unit: spec.unit } : {}),
    ...(spec.decimals !== undefined ? { decimals: spec.decimals } : {}),
    ...(spec.min !== undefined ? { min: spec.min } : {}),
    ...(spec.max !== undefined ? { max: spec.max } : {}),
    thresholds: thresholdSteps(spec.thresholds),
  };
  if (spec.type === "timeseries") {
    defaults.custom = {
      drawStyle: "line",
      lineWidth: 1,
      fillOpacity: spec.stack ? 25 : 8,
      showPoints: "never",
      spanNulls: false,
      stacking: { mode: spec.stack ? "normal" : "none", group: "A" },
      thresholdsStyle: { mode: spec.thresholds ? "line" : "off" },
    };
    return {
      ...base,
      datasource,
      targets,
      fieldConfig: { defaults, overrides: [] },
      options: {
        legend: { displayMode: "list", placement: "bottom", showLegend: true },
        tooltip: { mode: "multi", sort: "desc" },
      },
      ...spec.raw,
    };
  }
  if (spec.type === "stat")
    return {
      ...base,
      datasource,
      targets,
      fieldConfig: { defaults: { ...defaults, color: { mode: "thresholds" } }, overrides: [] },
      options: {
        reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false },
        colorMode: spec.thresholds ? "background" : "value",
        graphMode: "area",
        textMode: "auto",
        justifyMode: "auto",
      },
      ...spec.raw,
    };
  return {
    ...base,
    datasource,
    targets,
    fieldConfig: { defaults, overrides: [] },
    options: { showHeader: true, cellHeight: "sm" },
    ...spec.raw,
  };
}

interface DashboardSpec {
  readonly uid: string;
  readonly title: string;
  readonly description: string;
  /** Rows of panels; each row's widths add up to 24. */
  readonly rows: readonly (readonly PanelSpec[])[];
  readonly traces?: boolean;
}

export function renderDashboard(spec: DashboardSpec): Record<string, unknown> {
  const panels: Record<string, unknown>[] = [];
  let id = 1;
  let y = 0;
  for (const row of spec.rows) {
    let x = 0;
    for (const panel of row) {
      panels.push(render(panel, id++, x, y));
      x += panel.w;
    }
    y += Math.max(...row.map((panel) => panel.h));
  }
  return {
    uid: spec.uid,
    title: spec.title,
    description: spec.description,
    tags: ["rastrata", "hosting"],
    schemaVersion: 39,
    version: 1,
    editable: true,
    graphTooltip: 1,
    refresh: "1m",
    time: { from: "now-6h", to: "now" },
    timepicker: {},
    templating: {
      list: [
        {
          name: "datasource",
          label: "Metrics",
          type: "datasource",
          query: "prometheus",
          current: {},
          hide: 0,
          refresh: 1,
        },
        ...(spec.traces
          ? [
              {
                name: "traces",
                label: "Traces",
                type: "datasource",
                query: "tempo",
                current: {},
                hide: 0,
                refresh: 1,
              },
            ]
          : []),
        {
          name: "window",
          label: "Window",
          type: "custom",
          query: "5m,1h,6h,1d,7d",
          current: { text: "1h", value: "1h" },
          options: ["5m", "1h", "6h", "1d", "7d"].map((value) => ({
            text: value,
            value,
            selected: value === "1h",
          })),
          hide: 0,
        },
      ],
    },
    annotations: { list: [] },
    panels,
  };
}

// ---- The latency budget ------------------------------------------------------------------------

/** `label_replace` chain adding the columns the budget table shows to an instant vector. */
const labelled = (expr: string, slo: Slo) =>
  `label_replace(label_replace(label_replace(${expr}, "slo", "${slo.title}", "", ""), "objective", "${slo.threshold}", "", ""), "budget", "${slo.budget}", "", "")`;

const budgetTable: PanelSpec = {
  type: "table",
  title: "Within budget",
  description:
    "One row for each thing a person waits for. 'Now' is the quantile over the chosen window; 'Within budget' is the exact share of observations at or under the limit (the limit is a histogram bucket boundary, so nothing is interpolated); 'Used' is now over the limit. No row means no traffic, not a healthy zero.",
  w: 24,
  h: 9,
  targets: [
    {
      expr: SLOS.map((slo) => labelled(quantileExpr(slo, "$window"), slo)).join("\n or "),
      instant: true,
      table: true,
    },
    {
      expr: SLOS.map((slo) => labelled(goodRatio(slo, "$window"), slo)).join("\n or "),
      instant: true,
      table: true,
    },
  ],
  raw: {
    transformations: [
      { id: "merge", options: {} },
      {
        id: "convertFieldType",
        options: { conversions: [{ targetField: "objective", destinationType: "number" }] },
      },
      {
        id: "calculateField",
        options: {
          mode: "binary",
          binary: { left: "Value #A", operator: "/", right: "objective" },
          alias: "Used",
          replaceFields: false,
        },
      },
      {
        id: "organize",
        options: {
          excludeByName: { Time: true },
          indexByName: { slo: 0, budget: 1, objective: 2, "Value #A": 3, Used: 4, "Value #B": 5 },
          renameByName: {
            slo: "What a person waits for",
            budget: "Budget",
            objective: "Limit (s)",
            "Value #A": "Now",
            "Value #B": "Within budget",
          },
        },
      },
    ],
    fieldConfig: {
      defaults: {
        mappings: [
          { type: "special", options: { match: "nan", result: { text: "no traffic" } } },
          { type: "special", options: { match: "null", result: { text: "no traffic" } } },
        ],
        custom: { cellOptions: { type: "auto" } },
      },
      overrides: [
        {
          matcher: { id: "byName", options: "What a person waits for" },
          properties: [{ id: "custom.width", value: 380 }],
        },
        {
          matcher: { id: "byName", options: "Budget" },
          properties: [{ id: "custom.width", value: 300 }],
        },
        {
          matcher: { id: "byName", options: "Now" },
          properties: [
            { id: "unit", value: "s" },
            { id: "decimals", value: 3 },
          ],
        },
        {
          matcher: { id: "byName", options: "Within budget" },
          properties: [
            { id: "unit", value: "percentunit" },
            { id: "decimals", value: 1 },
          ],
        },
        {
          matcher: { id: "byName", options: "Used" },
          properties: [
            { id: "unit", value: "percentunit" },
            { id: "decimals", value: 0 },
            { id: "custom.cellOptions", value: { type: "color-background" } },
            {
              id: "thresholds",
              value: {
                mode: "absolute",
                steps: [
                  { color: "green", value: null },
                  { color: "yellow", value: 0.8 },
                  { color: "red", value: 1 },
                ],
              },
            },
          ],
        },
      ],
    },
  },
};

const burnTable: PanelSpec = {
  type: "table",
  title: "Error-budget burn rate",
  description:
    "From the recording rules in alerts/slo.rules.yaml. 1 spends the 28-day budget in exactly 28 days. A page needs the one-hour and five-minute rates over 14.4 (3.6 for the browser's p75 limits); a ticket the six-hour and thirty-minute rates over 6 (2).",
  w: 24,
  h: 7,
  targets: [
    { expr: "max by (slo) (rastrata:slo_burn_rate:rate5m)", instant: true, table: true },
    { expr: "max by (slo) (rastrata:slo_burn_rate:rate1h)", instant: true, table: true },
    { expr: "max by (slo) (rastrata:slo_burn_rate:rate6h)", instant: true, table: true },
    { expr: "max by (slo) (rastrata:slo_burn_rate:rate3d)", instant: true, table: true },
  ],
  raw: {
    transformations: [
      { id: "merge", options: {} },
      {
        id: "organize",
        options: {
          excludeByName: { Time: true },
          renameByName: {
            slo: "SLO",
            "Value #A": "5 min",
            "Value #B": "1 h",
            "Value #C": "6 h",
            "Value #D": "3 days",
          },
        },
      },
    ],
    fieldConfig: {
      defaults: {
        decimals: 2,
        custom: { cellOptions: { type: "color-background" } },
        mappings: [{ type: "special", options: { match: "nan", result: { text: "no traffic" } } }],
        thresholds: {
          mode: "absolute",
          steps: [
            { color: "green", value: null },
            { color: "yellow", value: 1 },
            { color: "red", value: 6 },
          ],
        },
      },
      overrides: [
        {
          matcher: { id: "byName", options: "SLO" },
          properties: [{ id: "custom.cellOptions", value: { type: "auto" } }],
        },
      ],
    },
  },
};

const slowOrFailed: PanelSpec = {
  type: "table",
  datasource: "tempo",
  title: "Slow or failed requests",
  description:
    "Traces the sampler kept because they were errors or slower than a second (the rest are kept at a low rate). Click one to see where the time went.",
  w: 24,
  h: 8,
  targets: [],
  raw: {
    targets: [
      {
        refId: "A",
        datasource: { type: "tempo", uid: TRACES_VARIABLE },
        queryType: "traceql",
        query: '{ name = "http.request" && (duration > 1s || status = error) }',
        limit: 20,
        tableType: "traces",
      },
    ],
  },
};

const timeseries = (
  title: string,
  targets: readonly Target[],
  extra: Partial<PanelSpec> = {},
): PanelSpec => ({ type: "timeseries", title, w: 12, h: 8, targets, ...extra });

const sizeLegend = "{{size_bucket}}";

export const SLO_DASHBOARD: DashboardSpec = {
  uid: "rastrata-slo",
  title: "Rastrata: the latency budget",
  description:
    "What a person waits for, against the budget in docs/reference/hosting-program.md. Generated by packages/telemetry/tools/dashboards.ts.",
  traces: true,
  rows: [
    [
      {
        type: "text",
        title: "About this dashboard",
        w: 24,
        h: 4,
        content:
          "The budget is the table below; the founder sets the final numbers. **Server-side** figures come from the API's own histograms, **browser** figures from real users' pages (only when the hosted service has `RASTRATA_RUM` on, at a low sample). Every limit is a histogram bucket boundary, so *Within budget* is exact. Burn-rate alerts are generated from the same list (`alerts/slo.rules.yaml`); see the runbook in `docs/reference/program/hosting/hostobs.md`. A blank row means no traffic, not a healthy system.",
      },
    ],
    [budgetTable],
    [burnTable],
    [
      timeseries(
        "A read request, p95 (budget 100 ms)",
        [
          {
            expr: quantile(0.95, "request.duration", "", '{operation_class="read"}'),
            legend: "p95",
          },
          {
            expr: quantile(0.5, "request.duration", "", '{operation_class="read"}'),
            legend: "p50",
          },
        ],
        { unit: "s", thresholds: [{ value: 0.1 }] },
      ),
      timeseries(
        "A commit, p95 (budget 100 ms, target 30 ms)",
        [
          { expr: quantile(0.95, "commit.duration"), legend: "p95" },
          { expr: quantile(0.5, "commit.duration"), legend: "p50" },
        ],
        { unit: "s", thresholds: [{ value: 0.1 }] },
      ),
    ],
    [
      timeseries(
        "Click to confirmed, p95 by action (budget 250 ms)",
        [{ expr: quantile(0.95, "web.action.duration", "web_action"), legend: "{{web_action}}" }],
        { unit: "s", thresholds: [{ value: 0.25 }] },
      ),
      timeseries(
        "A report, p95 by book size (budget 300 ms under 5,000 journals)",
        [{ expr: quantile(0.95, "report.duration", "size_bucket"), legend: sizeLegend }],
        { unit: "s", thresholds: [{ value: 0.3 }] },
      ),
    ],
    [
      timeseries(
        "Opening a cold book, p95 by size (budget 3 s)",
        [{ expr: quantile(0.95, "activation.duration", "size_bucket"), legend: sizeLegend }],
        { unit: "s", thresholds: [{ value: 3 }] },
      ),
      timeseries(
        "INP p75 (budget 200 ms) and LCP p75 (budget 2.5 s)",
        [
          { expr: quantile(0.75, "web.inp"), legend: "INP p75" },
          { expr: quantile(0.75, "web.lcp"), legend: "LCP p75" },
        ],
        { unit: "s", thresholds: [{ value: 0.2, color: "orange" }, { value: 2.5 }] },
      ),
    ],
    [slowOrFailed],
  ],
};

// ---- The tail, leases, sealing and R2 -----------------------------------------------------------

const stat = (
  title: string,
  expr: string,
  w: number,
  extra: Partial<PanelSpec> = {},
): PanelSpec => ({
  type: "stat",
  title,
  w,
  h: 4,
  targets: [{ expr, instant: true }],
  ...extra,
});

export const STORAGE_DASHBOARD: DashboardSpec = {
  uid: "rastrata-storage",
  title: "Rastrata: the tail, leases, sealing and R2",
  description:
    "The commit path below the API: the fast tail, leases and fencing, sealing into R2, and what R2 is asked to do. Generated by packages/telemetry/tools/dashboards.ts.",
  rows: [
    [
      stat("R2 Class A calls per second", rate("r2.operations", "", '{r2_class="A"}', "5m"), 4, {
        unit: "ops",
        decimals: 2,
        thresholds: [{ value: 5, color: "orange" }, { value: 20 }],
      }),
      stat("R2 Class B calls per second", rate("r2.operations", "", '{r2_class="B"}', "5m"), 4, {
        unit: "ops",
        decimals: 2,
      }),
      stat("Stored in R2", `sum(${n("stored.bytes")})`, 4, { unit: "bytes" }),
      stat("Entries waiting in the tail", `sum(${n("tail.depth")})`, 4, {
        thresholds: [{ value: 1000, color: "orange" }, { value: 10000 }],
      }),
      stat("Oldest due entry in the tail", `max(${n("tail.age")})`, 4, {
        unit: "s",
        thresholds: [{ value: 30, color: "orange" }, { value: 120 }],
      }),
      stat(
        "Commits lost to a conflict",
        `${rate("commit.conflicts", "", "", "30m")} / ${observations("commit.duration", "30m")}`,
        4,
        {
          unit: "percentunit",
          decimals: 2,
          thresholds: [{ value: 0.02, color: "orange" }, { value: 0.05 }],
        },
      ),
    ],
    [
      timeseries(
        "R2 calls per second by price class",
        [{ expr: rate("r2.operations", "r2_class"), legend: "Class {{r2_class}}" }],
        { stack: true, unit: "ops" },
      ),
      timeseries(
        "R2 calls per second by call and outcome",
        [{ expr: rate("r2.operations", "r2_op, outcome"), legend: "{{r2_op}} {{outcome}}" }],
        { unit: "ops" },
      ),
    ],
    [
      timeseries(
        "R2 call latency, p95 by call",
        [{ expr: quantile(0.95, "r2.duration", "r2_op"), legend: "{{r2_op}}" }],
        { unit: "s" },
      ),
      timeseries(
        "R2 bytes per second",
        [
          {
            expr: rate("r2.bytes", "direction, object_kind"),
            legend: "{{direction}} {{object_kind}}",
          },
        ],
        { unit: "Bps" },
      ),
    ],
    [
      timeseries(
        "Stored in R2 by book size",
        [{ expr: `sum by (size_bucket) (${n("stored.bytes")})`, legend: sizeLegend }],
        { stack: true, unit: "bytes" },
      ),
      timeseries(
        "Growth of what is stored, per day",
        [{ expr: `sum(delta(${n("stored.bytes")}[1d]))`, legend: "bytes added in the last day" }],
        { unit: "bytes" },
      ),
    ],
    [
      timeseries(
        "The tail: entries waiting",
        [{ expr: `sum(${n("tail.depth")})`, legend: "entries" }],
        {
          w: 6,
          thresholds: [{ value: 10000 }],
        },
      ),
      timeseries("The tail: bytes waiting", [{ expr: `sum(${n("tail.size")})`, legend: "bytes" }], {
        w: 6,
        unit: "bytes",
      }),
      timeseries(
        "The tail: age of the oldest entry that is due to be sealed (it only grows if sealing is behind)",
        [{ expr: `max(${n("tail.age")})`, legend: "oldest" }],
        { unit: "s", thresholds: [{ value: 120 }] },
      ),
    ],
    [
      timeseries(
        "Seals per second by outcome",
        [{ expr: rate("seal.operations", "outcome"), legend: "{{outcome}}" }],
        { unit: "ops" },
      ),
      timeseries(
        "Time an entry waited to be sealed, p95",
        [{ expr: quantile(0.95, "seal.lag"), legend: "p95" }],
        { unit: "s" },
      ),
    ],
    [
      timeseries(
        "Lease operations per second",
        [
          {
            expr: rate("lease.operations", "lease_op, lease_result"),
            legend: "{{lease_op}} {{lease_result}}",
          },
        ],
        { unit: "ops" },
      ),
      timeseries(
        "Writes refused for a stale fence, and reads by lease state",
        [
          { expr: rate("lease.fence_rejections", ""), legend: "fence rejections" },
          { expr: rate("lease.reads", "lease_state"), legend: "reads {{lease_state}}" },
        ],
        { unit: "ops" },
      ),
    ],
    [
      timeseries(
        "Commits per second, conflicts and uncertain outcomes",
        [
          { expr: observations("commit.duration"), legend: "commits" },
          { expr: rate("commit.conflicts", ""), legend: "conflicts" },
          { expr: rate("commit.uncertain", "resolution"), legend: "uncertain {{resolution}}" },
        ],
        { unit: "ops" },
      ),
      timeseries(
        "Verification lag (most-behind book of each size) and queue age",
        [
          {
            expr: `max by (size_bucket) (${n("verify.lag")})`,
            legend: "verify lag {{size_bucket}}",
          },
          { expr: `max by (queue) (${n("queue.age")})`, legend: "queue age {{queue}}" },
        ],
        { unit: "s" },
      ),
    ],
  ],
};

// ---- Processes, requests, jobs and telemetry itself --------------------------------------------

export const RUNTIME_DASHBOARD: DashboardSpec = {
  uid: "rastrata-runtime",
  title: "Rastrata: processes, requests and telemetry",
  description:
    "Memory, CPU, event loop and idleness of the pods; what the requests cost; background jobs; the browser; and whether telemetry itself is getting through. Generated by packages/telemetry/tools/dashboards.ts.",
  rows: [
    [
      stat(
        "Memory in use of the container's limit",
        `max(${n("process.memory")}{memory_kind="rss"} / on (instance) group_left max by (instance) (${n("process.memory.limit")}))`,
        6,
        {
          unit: "percentunit",
          decimals: 0,
          thresholds: [{ value: 0.7, color: "orange" }, { value: 0.85 }],
        },
      ),
      stat("Books held open", `sum(${n("books.resident")})`, 6),
      stat("Tenants", `sum(${n("tenants")})`, 6),
      stat(
        "Telemetry dropped in the last hour",
        `sum(increase(${n("telemetry.dropped")}[1h])) or vector(0)`,
        6,
        { thresholds: [{ value: 1, color: "orange" }, { value: 1000 }] },
      ),
    ],
    [
      timeseries(
        "Resident memory against the limit",
        [
          {
            expr: `max by (instance) (${n("process.memory")}{memory_kind="rss"})`,
            legend: "{{instance}} resident",
          },
          {
            expr: `max by (instance) (${n("process.memory")}{memory_kind="heap_used"})`,
            legend: "{{instance}} heap",
          },
          {
            expr: `max by (instance) (${n("process.memory.limit")})`,
            legend: "{{instance}} limit",
          },
        ],
        { unit: "bytes" },
      ),
      timeseries(
        "CPU cores in use",
        [{ expr: rate("process.cpu.time", "instance"), legend: "{{instance}}" }],
        { unit: "none", decimals: 2 },
      ),
    ],
    [
      timeseries(
        "Event loop lag, p99 (how late a 100 ms timer fires)",
        [{ expr: quantile(0.99, "process.event_loop.lag"), legend: "p99" }],
        { unit: "s", thresholds: [{ value: 0.25 }] },
      ),
      timeseries(
        "Seconds since each process last had nothing to do (0 while busy)",
        [{ expr: `min by (instance) (${n("process.idle.time")})`, legend: "{{instance}}" }],
        { unit: "s" },
      ),
    ],
    [
      timeseries(
        "Requests per second by operation class",
        [{ expr: rate("requests", "operation_class"), legend: "{{operation_class}}" }],
        { stack: true, unit: "reqps" },
      ),
      timeseries(
        "Request latency, p95 by operation class",
        [
          {
            expr: quantile(0.95, "request.duration", "operation_class"),
            legend: "{{operation_class}}",
          },
        ],
        { unit: "s" },
      ),
    ],
    [
      timeseries(
        "CPU the requests used, by class and by book size (what to price)",
        [
          {
            expr: rate("request.cpu.time", "operation_class, size_bucket"),
            legend: "{{operation_class}} {{size_bucket}}",
          },
        ],
        { stack: true, unit: "none", decimals: 3 },
      ),
      timeseries(
        "Rows written by class",
        [{ expr: rate("db.rows.written", "operation_class"), legend: "{{operation_class}}" }],
        { stack: true },
      ),
    ],
    [
      timeseries(
        "Making a book ready: p95 by size, and the memory it took",
        [
          {
            expr: quantile(0.95, "activation.duration", "size_bucket"),
            legend: "time {{size_bucket}}",
          },
        ],
        { unit: "s" },
      ),
      timeseries(
        "Peak memory while making a book ready, p95 (the failed snapshot attempt is most of it)",
        [
          {
            expr: quantile(0.95, "activation.peak_memory", "size_bucket, snapshot_attempt"),
            legend: "{{size_bucket}} snapshot {{snapshot_attempt}}",
          },
        ],
        { unit: "bytes", thresholds: [{ value: 1073741824 }] },
      ),
    ],
    [
      timeseries(
        "Background jobs per second by type and outcome",
        [{ expr: rate("jobs", "job_type, outcome"), legend: "{{job_type}} {{outcome}}" }],
        { unit: "ops" },
      ),
      timeseries(
        "CPU the background jobs used, by type",
        [{ expr: rate("job.cpu.time", "job_type"), legend: "{{job_type}}" }],
        { stack: true, unit: "none", decimals: 3 },
      ),
    ],
    [
      timeseries(
        "In the browser: key actions per second and how they ended",
        [
          {
            expr: rate("web.actions", "web_action, outcome"),
            legend: "{{web_action}} {{outcome}}",
          },
        ],
        { unit: "ops" },
      ),
      timeseries(
        "In the browser: INP, LCP and TTFB, p75 by book size",
        [
          { expr: quantile(0.75, "web.inp", "size_bucket"), legend: "INP {{size_bucket}}" },
          { expr: quantile(0.75, "web.lcp", "size_bucket"), legend: "LCP {{size_bucket}}" },
          { expr: quantile(0.75, "web.ttfb", "size_bucket"), legend: "TTFB {{size_bucket}}" },
        ],
        { unit: "s" },
      ),
    ],
    [
      timeseries(
        "Telemetry: batches sent, failed and not tried",
        [
          {
            expr: rate("telemetry.exports", "telemetry_signal, export_result"),
            legend: "{{telemetry_signal}} {{export_result}}",
          },
        ],
        { unit: "ops" },
      ),
      timeseries(
        "Telemetry: what was thrown away, and why",
        [
          {
            expr: rate("telemetry.dropped", "telemetry_signal, drop_reason"),
            legend: "{{telemetry_signal}} {{drop_reason}}",
          },
          { expr: `max(${n("telemetry.queue")})`, legend: "spans waiting" },
        ],
        {},
      ),
    ],
    [
      timeseries(
        "Traces: what the sampler decided",
        [{ expr: rate("telemetry.traces", "sampling_decision"), legend: "{{sampling_decision}}" }],
        { stack: true, unit: "ops" },
      ),
      timeseries(
        "Reports from browsers: taken, refused, sampled out",
        [{ expr: rate("web.beacons", "web_beacon"), legend: "{{web_beacon}}" }],
        { unit: "ops" },
      ),
    ],
  ],
};

export const DASHBOARDS = [SLO_DASHBOARD, STORAGE_DASHBOARD, RUNTIME_DASHBOARD] as const;

/** A scanner for the PromQL the deployment files hold, enough to check every metric name, every label
 * and every `le` against the catalog. It is not a parser: it finds `rastrata_*` selectors, the
 * labels they match on, and the labels a `by (...)` or `without (...)` clause names. */
import {
  METRIC_NAMES,
  METRICS,
  type MetricName,
  type MetricSpec,
  exportedLabelKeys,
  prometheusName,
} from "../../src/catalog.ts";

const BY_PROMETHEUS_NAME = new Map<string, MetricName>(
  METRIC_NAMES.map((name) => [prometheusName(name), name]),
);
const SUFFIXES = ["_bucket", "_sum", "_count"] as const;

export interface Reference {
  /** The name as written. */
  readonly written: string;
  readonly metric: MetricName;
  readonly suffix: "" | (typeof SUFFIXES)[number];
  readonly labels: readonly string[];
  /** `le` matchers, with their values. */
  readonly le: readonly string[];
}

export interface Scan {
  readonly references: readonly Reference[];
  /** `rastrata_*` names that are not a series the catalog makes. */
  readonly unknown: readonly string[];
  /** Labels named in `by (...)` and `without (...)`. */
  readonly grouping: readonly string[];
  /** Recorded rule names used (`rastrata:...`). */
  readonly recorded: readonly string[];
}

function matchers(body: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const pattern = /([A-Za-z_][A-Za-z0-9_]*)\s*(=~|!~|!=|=)\s*"((?:[^"\\]|\\.)*)"/g;
  for (let found = pattern.exec(body); found; found = pattern.exec(body))
    out.push({ name: found[1] as string, value: found[3] as string });
  return out;
}

export function scan(expr: string): Scan {
  const references: Reference[] = [];
  const unknown: string[] = [];
  const pattern = /\b(rastrata_[a-z0-9_]+)\b\s*(?:\{([^}]*)\})?/g;
  for (let found = pattern.exec(expr); found; found = pattern.exec(expr)) {
    const written = found[1] as string;
    let metric = BY_PROMETHEUS_NAME.get(written);
    let suffix: Reference["suffix"] = "";
    if (!metric)
      for (const candidate of SUFFIXES) {
        const base = written.endsWith(candidate)
          ? BY_PROMETHEUS_NAME.get(written.slice(0, -candidate.length))
          : undefined;
        if (base && (METRICS[base] as MetricSpec).kind === "histogram") {
          metric = base;
          suffix = candidate;
        }
      }
    // A histogram is only ever read through its suffixes, and a counter or gauge never is.
    if (!metric || ((METRICS[metric] as MetricSpec).kind === "histogram") !== (suffix !== "")) {
      unknown.push(written);
      continue;
    }
    const body = matchers(found[2] ?? "");
    references.push({
      written,
      metric,
      suffix,
      labels: body.map((item) => item.name),
      le: body.filter((item) => item.name === "le").map((item) => item.value),
    });
  }
  const grouping: string[] = [];
  const clause = /\b(?:by|without|on|ignoring|group_left|group_right)\s*\(([^)]*)\)/g;
  for (let found = clause.exec(expr); found; found = clause.exec(expr))
    for (const label of (found[1] as string).split(",")) {
      const name = label.trim();
      if (name) grouping.push(name);
    }
  const recorded = [...expr.matchAll(/\brastrata:[a-z0-9_:]+/g)].map((match) => match[0]);
  return { references, unknown, grouping, recorded };
}

/** Labels any series has from the way it was sent, not from the catalog. */
export const SENT_LABELS = new Set(["job", "instance", "service_name", "service_instance_id"]);

/** Problems with one expression: a name or label the catalog does not have, an `le` that is not a
 * boundary of its histogram. `extraLabels` are labels the expression may group by that come from
 * a `label_replace` or a recording rule. */
export function problemsIn(expr: string, extraLabels: readonly string[] = []): string[] {
  const { references, unknown, grouping } = scan(expr);
  const problems: string[] = unknown.map((name) => `${name} is not a series the catalog makes`);
  const known = new Set<string>([...SENT_LABELS, ...extraLabels, "le"]);
  for (const reference of references) {
    const labels = exportedLabelKeys(reference.metric);
    for (const label of labels) known.add(label);
    for (const label of reference.labels)
      if (
        !labels.includes(label) &&
        !(label === "le" && reference.suffix === "_bucket") &&
        !SENT_LABELS.has(label)
      )
        problems.push(`${reference.written} has no label ${label}`);
    for (const value of reference.le) {
      const boundaries = (METRICS[reference.metric] as MetricSpec).buckets ?? [];
      const allowed = [...boundaries.map(String), "+Inf"];
      if (!allowed.includes(value))
        problems.push(
          `${reference.written}: le="${value}" is not a bucket boundary (${allowed.join(", ")})`,
        );
    }
  }
  for (const label of grouping)
    if (!known.has(label) && references.length > 0)
      problems.push(`grouping by ${label}, which none of the metrics in the expression has`);
  return problems;
}

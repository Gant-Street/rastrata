import { describe, expect, test } from "bun:test";
import {
  BUCKETS,
  METRICS,
  METRIC_NAMES,
  SERIES_BUDGET,
  SPAN_ATTRIBUTE_KEYS,
  SPAN_EVENT_NAMES,
  SPAN_NAMES,
  exportedLabelKeys,
  exportedName,
  prometheusName,
  worstCaseSeries,
  type MetricSpec,
} from "../src/catalog.ts";
import { LABEL_VALUES, type LabelKey } from "../src/labels.ts";

const spec = (name: (typeof METRIC_NAMES)[number]) => METRICS[name] as MetricSpec;

describe("the metric catalog", () => {
  test("describes every metric, with a unit a backend understands", () => {
    for (const name of METRIC_NAMES) {
      const entry = spec(name);
      expect(entry.description.length, name).toBeGreaterThan(20);
      expect(entry.description.endsWith("."), name).toBe(true);
      expect(
        entry.unit === "s" ||
          entry.unit === "By" ||
          entry.unit === "1" ||
          /^\{[a-z_]+\}$/.test(entry.unit),
        `${name}: ${entry.unit}`,
      ).toBe(true);
      expect(name, name).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/);
    }
  });

  test("gives each histogram strictly increasing positive buckets and nothing else any", () => {
    for (const name of METRIC_NAMES) {
      const entry = spec(name);
      if (entry.kind === "histogram") {
        const buckets = entry.buckets ?? [];
        expect(buckets.length, name).toBeGreaterThanOrEqual(5);
        expect(buckets.length, name).toBeLessThanOrEqual(10);
        buckets.forEach((bound, index) => {
          expect(bound, name).toBeGreaterThan(0);
          if (index > 0) expect(bound, name).toBeGreaterThan(buckets[index - 1] as number);
        });
      } else expect(entry.buckets, name).toBeUndefined();
    }
    for (const [group, bounds] of Object.entries(BUCKETS))
      expect(bounds.length, group).toBeGreaterThan(0);
  });

  test("keeps every number in the latency budget on a bucket boundary of the histogram that measures it", () => {
    // docs/reference/hosting-program.md, "The latency budget": a bucket boundary is what lets a
    // dashboard say "p95 is under budget" from the buckets alone, without interpolating.
    const on = (name: (typeof METRIC_NAMES)[number], bound: number) =>
      expect(spec(name).buckets, `${name} has a boundary at ${bound}`).toContain(bound);
    on("request.duration", 0.1); // a read request: p95 at most 100 ms
    on("commit.duration", 0.1); // a commit: p95 at most 100 ms
    on("commit.duration", 0.03); // ... target 30 ms
    on("web.action.duration", 0.25); // click to confirmed: p95 at most 250 ms
    on("report.duration", 0.3); // a report on a 5,000-journal book: p95 at most 300 ms
    on("web.inp", 0.2); // INP: p75 at most 200 ms
    on("web.lcp", 2.5); // LCP: p75 at most 2.5 s
    on("activation.duration", 3); // a cold book: at most 3 s
    on("activation.peak_memory", 1073741824); // at most 1 GiB
  });

  test("takes every label value from the closed sets, and a subset never invents one", () => {
    for (const name of METRIC_NAMES)
      for (const [key, values] of Object.entries(spec(name).labels)) {
        const allowed = LABEL_VALUES[key as LabelKey] as readonly string[];
        expect(allowed, `${name}.${key}`).toBeDefined();
        expect((values as readonly string[]).length, `${name}.${key}`).toBeGreaterThan(0);
        for (const value of values as readonly string[])
          expect(allowed.includes(value), `${name}.${key}=${value}`).toBe(true);
      }
  });

  test("allows no label that could name a tenant, a person or a request", () => {
    const forbidden = /(^|_)(id|uuid|tenant|book|user|email|token|name|path|url|ip|session)($|_)/;
    for (const key of Object.keys(LABEL_VALUES)) expect(key, key).not.toMatch(forbidden);
    for (const name of METRIC_NAMES)
      for (const key of exportedLabelKeys(name))
        expect(key, `${name}.${key}`).not.toMatch(forbidden);
  });

  test("derives the R2 price class from the call so a caller cannot mislabel it", () => {
    expect(spec("r2.operations").derived).toEqual(["r2_class"]);
    expect(Object.keys(spec("r2.operations").labels)).not.toContain("r2_class");
    expect(exportedLabelKeys("r2.operations")).toEqual(["r2_op", "outcome", "r2_class"]);
  });

  test("exports under rastrata.<key> and names the Prometheus series by the OpenTelemetry rules", () => {
    expect(exportedName("r2.operations")).toBe("rastrata.r2.operations");
    expect(prometheusName("r2.operations")).toBe("rastrata_r2_operations_total");
    expect(prometheusName("request.duration")).toBe("rastrata_request_duration_seconds");
    expect(prometheusName("request.cpu.time")).toBe("rastrata_request_cpu_time_seconds_total");
    expect(prometheusName("process.memory")).toBe("rastrata_process_memory_bytes");
    // The unit is not repeated when the name already says it.
    expect(prometheusName("r2.bytes")).toBe("rastrata_r2_bytes_total");
    expect(prometheusName("stored.bytes")).toBe("rastrata_stored_bytes");
    expect(prometheusName("entry.bytes")).toBe("rastrata_entry_bytes");
    expect(prometheusName("tail.size")).toBe("rastrata_tail_size_bytes");
    // A score has no unit word on a histogram.
    expect(prometheusName("web.cls")).toBe("rastrata_web_cls");
    // A count has no unit word.
    expect(prometheusName("requests")).toBe("rastrata_requests_total");
    expect(prometheusName("books.resident")).toBe("rastrata_books_resident");
  });

  test("makes no two metrics the same Prometheus series, histogram suffixes included", () => {
    const seen = new Map<string, string>();
    for (const name of METRIC_NAMES) {
      const base = prometheusName(name);
      const series =
        spec(name).kind === "histogram"
          ? [`${base}_bucket`, `${base}_sum`, `${base}_count`]
          : [base];
      for (const item of series) {
        expect(seen.get(item), `${item} is made by ${name} and ${seen.get(item)}`).toBeUndefined();
        seen.set(item, name);
      }
    }
  });
});

describe("the series budget", () => {
  const total = (tier: "core" | "detail") =>
    METRIC_NAMES.filter((name) => spec(name).tier === tier).reduce(
      (sum, name) => sum + worstCaseSeries(name),
      0,
    );

  test("holds the worst case of one process under the budget of each tier", () => {
    expect(total("core")).toBeLessThanOrEqual(SERIES_BUDGET.corePerProcess);
    expect(total("detail")).toBeLessThanOrEqual(SERIES_BUDGET.detailPerProcess);
  });

  test("counts a histogram as its buckets, +Inf, a sum and a count", () => {
    expect(worstCaseSeries("service.open.duration")).toBe(BUCKETS.activation.length + 3);
    expect(worstCaseSeries("requests")).toBe(10 * 6);
    expect(worstCaseSeries("process.memory.limit")).toBe(1);
  });

  test("leaves room: six processes of core metrics stay under 6,000 of the free plan's 10,000 series", () => {
    // The cluster's own collector adds about 1,157 (measured 2026-09-06), so even if every
    // combination of every label were used, the sum is under the limit.
    expect(total("core") * 6).toBeLessThan(6_000);
    expect(total("core") * 6 + 1_157).toBeLessThan(10_000);
  });
});

describe("the span catalog", () => {
  test("names spans and attributes once, without ids in the names", () => {
    for (const list of [
      SPAN_NAMES,
      SPAN_ATTRIBUTE_KEYS,
      SPAN_EVENT_NAMES,
    ] as readonly (readonly string[])[]) {
      expect(new Set(list).size).toBe(list.length);
      for (const item of list) expect(item).toMatch(/^[a-z][a-z0-9_.]*$/);
    }
  });

  test("covers the spans the hosting charter lists", () => {
    // "request, operation, ledger transact, SQL, activation (download, apply, verify), lease, commit
    // (tail append), seal, R2 call, verification run"
    for (const name of [
      "http.request",
      "operation",
      "ledger.execute",
      "sql.transaction",
      "activation.snapshot",
      "activation.sealed",
      "activation.tail",
      "activation.apply",
      "activation.verify",
      "lease.acquire",
      "lease.renew",
      "tail.append",
      "booklog.commit",
      "booklog.freshness",
      "seal.run",
      "r2.put",
      "job.verify",
    ])
      expect(SPAN_NAMES as readonly string[]).toContain(name);
  });
});

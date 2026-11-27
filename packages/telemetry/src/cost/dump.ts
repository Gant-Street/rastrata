/** Reading a metrics dump into the vectors the cost function prices.
 *
 * A dump is the file `RASTRATA_OTEL_FILE` names: every metrics export a process made, one OTLP/JSON
 * request a line, cumulative. This module is pure (the caller reads the file). It assumes the dump
 * covers the whole life of the processes in it, from start to stop, because a counter's last value
 * is then the run's total; a dump that begins mid-life counts what came before it too.
 *
 * The catalog labels metrics by operation class and size bucket, not by tenant, and not every
 * metric by both. Where a quantity has no size bucket (R2 calls, the tail, background jobs) it is
 * spread over the buckets in proportion to what drives it, and `notes` says how. A usage written by
 * the load generator, which knows which tenant did what, is exact; a dump is the estimate. */
import { METRICS, type MetricName } from "../catalog.ts";
import { BUCKETS, type Bucket, type BucketUsage, type TailKind, type Usage } from "./usage.ts";

export interface DumpOptions {
  /** The length of the month to project to, in seconds (the price book's hoursPerMonth x 3600). */
  readonly monthSeconds: number;
  /** The tail the run used. Defaults to the one with the most operations in the dump. */
  readonly tail?: TailKind;
  /** The seconds the dump covers, when its own timestamps are not the run (a run is paused). */
  readonly seconds?: number;
  /** Tenants per bucket, when the dump has no `tenants` gauge. */
  readonly tenants?: Partial<Record<Bucket, number>>;
  /** Who reports the fleet-wide gauges (`tenants`, `stored.bytes`, `tail.size`). "one" (the default):
   * one process reports the whole fleet, or all of them report the same, so the largest is taken.
   * "each": every process reports its own share (a process per tenant, say), so they are added. */
  readonly reporters?: "one" | "each";
}

export interface DumpRead {
  readonly usage: Usage;
  /** The seconds the dump covers, and the factor that scales its counters to a month. */
  readonly seconds: number;
  readonly scale: number;
  /** Processes (instances) whose exports are in the dump. */
  readonly instances: number;
  readonly tail: TailKind;
  /** The core-tier series the dump holds, for the Grafana Cloud line. */
  readonly activeSeries: number;
  readonly notes: readonly string[];
}

export class DumpError extends Error {
  constructor(message: string) {
    super(`the metrics dump cannot be read: ${message}`);
    this.name = "DumpError";
  }
}

type Labels = Readonly<Record<string, string>>;

interface Sample {
  readonly time: number;
  readonly value: number;
  readonly count: number;
  readonly sum: number;
}

interface Series {
  readonly name: string;
  readonly kind: "sum" | "gauge" | "histogram";
  readonly instance: string;
  readonly start: number;
  readonly labels: Labels;
  readonly samples: Sample[];
}

const PREFIX = "rastrata.";

const nanos = (value: unknown): number => {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : 0;
  return Number.isFinite(parsed) ? parsed / 1e9 : 0;
};
const numeric = (value: unknown): number => {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : 0;
  return Number.isFinite(parsed) ? parsed : 0;
};

interface JsonAttribute {
  key?: string;
  value?: { stringValue?: string; intValue?: string | number; boolValue?: boolean };
}
interface JsonPoint {
  attributes?: JsonAttribute[];
  startTimeUnixNano?: string | number;
  timeUnixNano?: string | number;
  asInt?: string | number;
  asDouble?: number;
  count?: string | number;
  sum?: number;
}
interface JsonMetric {
  name?: string;
  sum?: { dataPoints?: JsonPoint[] };
  gauge?: { dataPoints?: JsonPoint[] };
  histogram?: { dataPoints?: JsonPoint[] };
}
interface JsonRequest {
  resourceMetrics?: Array<{
    resource?: { attributes?: JsonAttribute[] };
    scopeMetrics?: Array<{ metrics?: JsonMetric[] }>;
  }>;
}

function labelsOf(attributes: JsonAttribute[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const attribute of attributes ?? []) {
    const value = attribute.value;
    if (!attribute.key || !value) continue;
    out[attribute.key] = String(value.stringValue ?? value.intValue ?? value.boolValue ?? "");
  }
  return out;
}

/** Every series in the dump, with its samples in the order they were exported. */
function parseSeries(text: string): Series[] {
  const byKey = new Map<string, Series>();
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    let request: JsonRequest;
    try {
      request = JSON.parse(line) as JsonRequest;
    } catch {
      throw new DumpError(`line ${index + 1} is not JSON`);
    }
    for (const resource of request.resourceMetrics ?? []) {
      const attributes = labelsOf(resource.resource?.attributes);
      const instance = attributes["service.instance.id"] ?? attributes["service.name"] ?? "process";
      for (const scope of resource.scopeMetrics ?? [])
        for (const metric of scope.metrics ?? []) {
          if (!metric.name?.startsWith(PREFIX)) continue;
          const name = metric.name.slice(PREFIX.length);
          const groups = [
            ["sum", metric.sum?.dataPoints],
            ["gauge", metric.gauge?.dataPoints],
            ["histogram", metric.histogram?.dataPoints],
          ] as const;
          for (const [kind, points] of groups)
            for (const point of points ?? []) {
              const labels = labelsOf(point.attributes);
              const start = kind === "gauge" ? 0 : nanos(point.startTimeUnixNano);
              const key = `${instance}|${name}|${start}|${JSON.stringify(Object.entries(labels).sort())}`;
              let series = byKey.get(key);
              if (!series) {
                series = { name, kind, instance, start, labels, samples: [] };
                byKey.set(key, series);
              }
              series.samples.push({
                time: nanos(point.timeUnixNano),
                value: numeric(point.asInt ?? point.asDouble),
                count: numeric(point.count),
                sum: numeric(point.sum),
              });
            }
        }
    }
  }
  return [...byKey.values()];
}

const last = (series: Series): Sample => series.samples[series.samples.length - 1] as Sample;
const mean = (series: Series): number =>
  series.samples.reduce((total, sample) => total + sample.value, 0) / series.samples.length;

const bucketOf = (label: string | undefined): Bucket => {
  const value = label as Bucket;
  return (BUCKETS as readonly string[]).includes(value) ? value : "xs";
};

const emptyPer = (): Record<Bucket, number> => ({ xs: 0, s: 0, m: 0, l: 0, xl: 0 });

/** Spread `total` over the buckets in proportion to the first of `bases` that has any weight. */
function allocate(total: number, ...bases: Record<Bucket, number>[]): Record<Bucket, number> {
  const out = emptyPer();
  for (const basis of bases) {
    const sum = BUCKETS.reduce((all, bucket) => all + basis[bucket], 0);
    if (sum <= 0) continue;
    for (const bucket of BUCKETS) out[bucket] = (total * basis[bucket]) / sum;
    break;
  }
  return out;
}

/** Turn a dump into a month of usage per size bucket. */
export function readDump(text: string, options: DumpOptions): DumpRead {
  const series = parseSeries(text);
  if (series.length === 0) throw new DumpError("it holds no rastrata metrics");
  const notes: string[] = [];

  const times = series.flatMap((item) => item.samples.map((sample) => sample.time));
  const starts = series.filter((item) => item.start > 0).map((item) => item.start);
  const first = Math.min(...(starts.length > 0 ? starts : times));
  const seconds = options.seconds ?? Math.max(...times) - first;
  if (!(seconds >= 1))
    throw new DumpError("it covers less than a second; say how long the run was with `seconds`");
  const scale = options.monthSeconds / seconds;
  notes.push(
    `the dump covers ${Math.round(seconds).toLocaleString("en-US")} s; counters are scaled by ${scale.toLocaleString("en-US", { maximumFractionDigits: 1 })} to a ${(options.monthSeconds / 3600).toFixed(0)}-hour month, as if the run were a month at its pace`,
  );

  const named = (name: MetricName) => series.filter((item) => item.name === name);
  /** Sum of the last cumulative value of every series (every process, every restart). */
  const total = (name: MetricName, where: (labels: Labels) => boolean = () => true): number =>
    named(name)
      .filter((item) => where(item.labels))
      .reduce((all, item) => all + last(item).value, 0);
  const perBucketTotal = (name: MetricName, where?: (labels: Labels) => boolean) => {
    const out = emptyPer();
    for (const item of named(name))
      if (!where || where(item.labels)) out[bucketOf(item.labels.size_bucket)] += last(item).value;
    return out;
  };
  const histogramPerBucket = (name: MetricName) => {
    const count = emptyPer();
    const sum = emptyPer();
    for (const item of named(name)) {
      count[bucketOf(item.labels.size_bucket)] += last(item).count;
      sum[bucketOf(item.labels.size_bucket)] += last(item).sum;
    }
    return { count, sum };
  };
  /** A gauge: each process's mean over its exports. */
  const gaugeByProcess = (name: MetricName) =>
    named(name).map((item) => ({ item, mean: mean(item) }));

  /** Two reports of one fleet-wide gauge: the larger, or their sum when every process reports a share. */
  const together = (a: number, b: number) =>
    options.reporters === "each" ? a + b : Math.max(a, b);

  // ---- Tenants ------------------------------------------------------------------------------
  const tenants = emptyPer();
  for (const { item, mean: value } of gaugeByProcess("tenants")) {
    const bucket = bucketOf(item.labels.size_bucket);
    tenants[bucket] = together(tenants[bucket], value);
  }
  if (BUCKETS.every((bucket) => tenants[bucket] === 0))
    for (const bucket of BUCKETS) tenants[bucket] = options.tenants?.[bucket] ?? 0;
  if (BUCKETS.every((bucket) => tenants[bucket] === 0))
    throw new DumpError("it has no `tenants` gauge and no tenants were given");
  const tenantsOrdinal = Object.fromEntries(BUCKETS.map((b) => [b, tenants[b]])) as Record<
    Bucket,
    number
  >;

  // ---- Activity per bucket ------------------------------------------------------------------
  const commits = histogramPerBucket("commit.duration").count;
  const reports = histogramPerBucket("report.duration").count;
  const activationDuration = histogramPerBucket("activation.duration");
  const activationPeak = histogramPerBucket("activation.peak_memory");
  const activations = (() => {
    const counted = perBucketTotal("activations");
    return BUCKETS.some((bucket) => counted[bucket] > 0) ? counted : activationDuration.count;
  })();
  const requestCpu = perBucketTotal("request.cpu.time");
  // Per-kind gauges from several reporters would double count; unless each reports its own share,
  // take the largest reporter per series.
  const storedKinds = new Map<string, number>();
  for (const { item, mean: value } of gaugeByProcess("stored.bytes")) {
    const key = `${bucketOf(item.labels.size_bucket)}|${item.labels.object_kind}`;
    storedKinds.set(key, together(storedKinds.get(key) ?? 0, value));
  }
  const stored = emptyPer();
  for (const [key, value] of storedKinds) stored[key.split("|")[0] as Bucket] += value;

  // ---- Requests -----------------------------------------------------------------------------
  const classOf =
    (...classes: string[]) =>
    (labels: Labels) =>
      classes.includes(labels.operation_class ?? "");
  const cpuOf = (...classes: string[]) => perBucketTotal("request.cpu.time", classOf(...classes));
  const requestsRead = allocate(
    total("requests", classOf("read", "maintain", "draft", "prepare", "legacy")),
    cpuOf("read", "maintain", "draft", "prepare", "legacy"),
    tenantsOrdinal,
  );
  const requestsBulk = allocate(
    total("requests", classOf("ingest", "job")),
    cpuOf("ingest", "job"),
    tenantsOrdinal,
  );
  notes.push(
    "requests are not labelled by size bucket: reads and bulk requests are spread over the buckets by the CPU they used; reports and writes are counted per bucket (report.duration, commit.duration)",
  );

  // ---- R2 -----------------------------------------------------------------------------------
  const r2Class = (labels: Labels): string => {
    if (labels.r2_class) return labels.r2_class;
    return labels.r2_op === "get" || labels.r2_op === "head"
      ? "B"
      : labels.r2_op === "delete"
        ? "free"
        : "A";
  };
  const classA = total("r2.operations", (labels) => r2Class(labels) === "A");
  const classB = total("r2.operations", (labels) => r2Class(labels) === "B");
  const r2A = allocate(classA, commits, tenantsOrdinal);
  const r2B = allocate(classB, requestCpu, tenantsOrdinal);
  notes.push(
    "R2 calls are not labelled by size bucket: Class A is spread by commits, Class B by request CPU; stored bytes are per bucket as measured",
  );

  // ---- The tail -----------------------------------------------------------------------------
  const kinds = new Map<string, number>();
  for (const item of named("tail.operations"))
    kinds.set(
      item.labels.tail_kind ?? "other",
      (kinds.get(item.labels.tail_kind ?? "other") ?? 0) + last(item).value,
    );
  const busiest = [...kinds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const tail: TailKind =
    options.tail ??
    (busiest === "postgres" || busiest === "durable_object" || busiest === "r2" ? busiest : "r2");
  const ofTail = (labels: Labels) => labels.tail_kind === tail;
  const tailRequests = allocate(total("tail.operations", ofTail), commits, tenantsOrdinal);
  const tailRows = allocate(total("tail.rows.written", ofTail), commits, tenantsOrdinal);
  const tailSeconds = allocate(
    named("tail.duration")
      .filter((item) => ofTail(item.labels))
      .reduce((all, item) => all + last(item).sum, 0),
    commits,
    tenantsOrdinal,
  );
  const tailBytes = allocate(
    gaugeByProcess("tail.size").reduce((all, { mean: value }) => together(all, value), 0),
    commits,
    tenantsOrdinal,
  );
  if (tail === "durable_object")
    notes.push(
      "the Durable Object's duration is the sum of its calls' durations: the time it sat active between calls is not in the dump, so duration is understated",
    );

  // ---- CPU ----------------------------------------------------------------------------------
  const jobCpu = allocate(total("job.cpu.time"), stored, tenantsOrdinal);
  const attributed = emptyPer();
  for (const bucket of BUCKETS) attributed[bucket] = requestCpu[bucket] + jobCpu[bucket];
  const attributedTotal = BUCKETS.reduce((all, bucket) => all + attributed[bucket], 0);
  const processCpu = total("process.cpu.time");
  // Everything the processes used is charged: what was attributed to requests and jobs as it is, the
  // rest in proportion to it (or by tenants, when nothing was attributed).
  const cpu =
    processCpu > attributedTotal ? allocate(processCpu, attributed, tenantsOrdinal) : attributed;
  notes.push(
    processCpu > attributedTotal
      ? `the processes used ${processCpu.toFixed(1)} s of CPU and ${attributedTotal.toFixed(1)} s were attributed to requests and jobs; the rest (garbage collection, timers, telemetry) is charged to the buckets in proportion${attributedTotal > 0 ? `, a factor of ${(processCpu / attributedTotal).toFixed(2)}` : " (none was attributed, so by tenants)"}`
      : "all CPU the processes used is attributed to requests and jobs",
  );

  // ---- Memory -------------------------------------------------------------------------------
  const rss = gaugeByProcess("process.memory")
    .filter(({ item }) => item.labels.memory_kind === "rss")
    .reduce((all, { mean: value }) => all + value, 0);
  const resident = emptyPer();
  for (const { item, mean: value } of gaugeByProcess("books.resident"))
    resident[bucketOf(item.labels.size_bucket)] += value;
  const residentWeight = emptyPer();
  for (const bucket of BUCKETS)
    residentWeight[bucket] =
      tenants[bucket] > 0 ? resident[bucket] * (stored[bucket] / tenants[bucket]) : 0;
  const rssMib = allocate(rss / 1048576, residentWeight, resident, tenantsOrdinal);
  // Memory held while books were made ready: the mean peak times the mean time, for each activation.
  const transient = emptyPer();
  for (const bucket of BUCKETS) {
    const count = activationDuration.count[bucket];
    const peak =
      activationPeak.count[bucket] > 0
        ? activationPeak.sum[bucket] / activationPeak.count[bucket]
        : 0;
    const time = count > 0 ? activationDuration.sum[bucket] / count : 0;
    transient[bucket] = ((count * (peak / 1048576) * time) / seconds) * options.monthSeconds;
  }
  notes.push(
    "memory is the processes' mean resident set spread over the buckets by resident books times book size, plus each activation's mean peak held for its mean duration; the headroom a pod must keep free to survive a burst of cold opens is capacity, not priced here",
  );

  // ---- Assemble -----------------------------------------------------------------------------
  const out: Partial<Record<Bucket, BucketUsage>> = {};
  for (const bucket of BUCKETS) {
    if (tenants[bucket] <= 0) continue;
    out[bucket] = {
      tenants: tenants[bucket],
      requests: {
        read: requestsRead[bucket] * scale,
        report: reports[bucket] * scale,
        write: commits[bucket] * scale,
        bulk: requestsBulk[bucket] * scale,
      },
      r2: {
        classA: r2A[bucket] * scale,
        classB: r2B[bucket] * scale,
        bytesStored: stored[bucket],
      },
      tail: {
        rowsWritten: tailRows[bucket] * scale,
        requests: tailRequests[bucket] * scale,
        durationSeconds: tailSeconds[bucket] * scale,
        bytesStored: tailBytes[bucket],
      },
      cpuSeconds: cpu[bucket] * scale,
      residentMbSeconds: rssMib[bucket] * options.monthSeconds + transient[bucket],
      activations: activations[bucket] * scale,
    };
  }

  const coreSeries = new Set(
    series
      .filter(
        (item) =>
          (METRICS[item.name as MetricName] as { tier?: string } | undefined)?.tier === "core",
      )
      .map(
        (item) =>
          `${item.instance}|${item.name}|${JSON.stringify(Object.entries(item.labels).sort())}`,
      ),
  );
  return {
    usage: out,
    seconds,
    scale,
    instances: new Set(series.map((item) => item.instance)).size,
    tail,
    activeSeries: coreSeries.size,
    notes,
  };
}

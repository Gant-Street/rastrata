/** The catalog: every metric, span name and span attribute the product may emit, written down once.
 *
 * A metric is named by a key of METRICS. Its kind, unit, histogram buckets and the label keys it may
 * carry (and the values each may take) are part of the entry, so a label that is not in the entry is a
 * type error, a value outside its set is not recorded as given, and the worst-case number of time
 * series a metric can produce is a sum over the entries (tools/series-budget.ts prints it, and a test
 * holds it under the budget in docs/reference/telemetry.md). To emit something new, add a row here
 * first. Exported names are `rastrata.<key>`; Prometheus sees them as `rastrata_<key>` with the
 * suffixes of the OpenTelemetry-to-Prometheus rules (prometheusName below).
 *
 * `tier` says where a metric goes. "core" metrics are what the alerts and the operations dashboard
 * read, and the collector sends them to Grafana Cloud, whose free plan allows 10,000 active series.
 * "detail" metrics are for the local stack and for the dumps the cost report reads; the collector's
 * allowlist (deploy/observability) keeps them out of the cloud unless somebody widens it. */
import { LABEL_VALUES, type LabelKey, type LabelValue } from "./labels.ts";

/** Histogram boundaries. Latencies are in seconds, sizes in bytes. The thresholds the hosting
 * program fixed in advance each fall on a boundary of the histogram that measures them, so "p95 at
 * most 100 ms" is read straight off a bucket: a read or a commit at most 100 ms (0.1), a report at
 * most 300 ms (0.3), a click confirmed in at most 250 ms (0.25), an INP at most 200 ms (0.2), an LCP
 * at most 2.5 s (2.5), a cold activation at most 3 s (3 is inside the activation set's 2 and 5; the
 * dashboard reads it as "under 5" and the exact figure from the dump), memory at most 1 GiB. */
export const BUCKETS = {
  /** A request to the API: up to 10 s. */
  request: [0.01, 0.05, 0.1, 0.3, 1, 3, 10],
  /** One call to the object store. */
  call: [0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 3],
  /** One append to the tail, one commit: tens of milliseconds, with the 30 ms target and the 100 ms
   * budget on a boundary. */
  tail: [0.005, 0.01, 0.02, 0.03, 0.05, 0.1, 0.2, 0.5, 2],
  /** One command through the native ledger (about a millisecond). */
  fast: [0.0005, 0.001, 0.002, 0.005, 0.01, 0.05, 0.25],
  /** A read of the verified state: milliseconds when it extends the state in memory, minutes when
   * it replays a large book. */
  read: [0.001, 0.005, 0.025, 0.1, 0.5, 2, 10, 60],
  /** Opening a book, loading or saving a snapshot. */
  activation: [0.05, 0.25, 1, 2, 3, 5, 10, 30, 120],
  /** A background job. */
  job: [0.1, 1, 5, 30, 120, 600, 1800],
  /** How long entries wait in the tail before they are sealed into the object store. */
  seal: [1, 2, 5, 10, 30, 60, 300, 900],
  /** Sizes of entries and snapshots, in bytes: 1 KiB to 16 MiB (the snapshot ceiling). */
  bytes: [1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216],
  /** A number of entries in a segment. */
  entries: [1, 2, 5, 10, 25, 100, 500, 2000],
  /** Memory, in bytes: 64 MiB to 2 GiB. */
  memory: [67108864, 134217728, 268435456, 536870912, 1073741824, 2147483648],
  /** How late a timer fires: the event loop being held up. */
  lag: [0.001, 0.005, 0.02, 0.1, 0.5, 2],
  /** From a click to its confirmation on the screen. */
  action: [0.05, 0.1, 0.25, 0.5, 1, 3],
  /** Largest contentful paint, with the "good" (2.5 s) and "poor" (4 s) limits of web.dev. */
  lcp: [0.5, 1, 1.5, 2, 2.5, 4, 8],
  /** Interaction to next paint, with the "good" (200 ms) and "poor" (500 ms) limits. */
  inp: [0.05, 0.1, 0.2, 0.3, 0.5, 1, 2],
  /** Time to first byte, with the "good" (0.8 s) and "poor" (1.8 s) limits. */
  ttfb: [0.1, 0.2, 0.4, 0.8, 1.8, 3],
  /** Cumulative layout shift, a score, with the "good" (0.1) and "poor" (0.25) limits. */
  cls: [0.01, 0.05, 0.1, 0.15, 0.25, 0.5, 1],
} as const;

// Value sets a metric uses a part of, so that a series cannot exist for a combination that cannot
// happen. Each is checked against the global set by `satisfies`.
const SIZE_KNOWN = [
  "xs",
  "s",
  "m",
  "l",
  "xl",
] as const satisfies readonly LabelValue<"size_bucket">[];
const REQUEST_OUTCOME = [
  "ok",
  "not_found",
  "conflict",
  "client_error",
  "server_error",
  "other",
] as const satisfies readonly LabelValue<"outcome">[];
/** How a seal can end: written, or not written because the object store or the tail failed or timed out. */
const SEAL_OUTCOME = ["ok", "server_error", "timeout"] as const;

const CALL_OUTCOME = [
  "ok",
  "not_found",
  "conflict",
  "server_error",
  "timeout",
  "other",
] as const satisfies readonly LabelValue<"outcome">[];
const SIMPLE_OUTCOME = [
  "ok",
  "client_error",
  "server_error",
  "other",
] as const satisfies readonly LabelValue<"outcome">[];
const ACTIVATION_FROM = [
  "snapshot",
  "log",
  "other",
] as const satisfies readonly LabelValue<"activation_source">[];
const TAIL_KIND = [
  "postgres",
  "durable_object",
  "r2",
  "other",
] as const satisfies readonly LabelValue<"tail_kind">[];
const TAIL_OP = [
  "append",
  "read",
  "lease",
  "seal",
  "other",
] as const satisfies readonly LabelValue<"tail_op">[];
const FENCED_OP = ["append", "seal", "other"] as const satisfies readonly LabelValue<"tail_op">[];

export type MetricKind = "counter" | "histogram" | "gauge";
export type MetricTier = "core" | "detail";
/** A label the backend computes from another, so a caller cannot get it wrong and it adds no series. */
export type DerivedLabel = "r2_class";

export interface MetricSpec {
  readonly kind: MetricKind;
  /** UCUM: "s", "By", "1" (a score), or an annotation such as "{request}" for a count. */
  readonly unit: string;
  readonly description: string;
  readonly tier: MetricTier;
  readonly labels: { readonly [key in LabelKey]?: readonly string[] };
  readonly buckets?: readonly number[];
  readonly derived?: readonly DerivedLabel[];
}

export const METRICS = {
  // ---- Requests: what the API was asked, what it cost -------------------------------------------
  requests: {
    kind: "counter",
    unit: "{request}",
    tier: "core",
    description:
      "Application requests handled, by what the operation costs to run and how it ended.",
    labels: { operation_class: LABEL_VALUES.operation_class, outcome: REQUEST_OUTCOME },
  },
  "request.duration": {
    kind: "histogram",
    unit: "s",
    tier: "core",
    description:
      "Time to answer an application request, from receipt to the last byte queued. The budget: a read at most 100 ms at p95.",
    labels: { operation_class: LABEL_VALUES.operation_class },
    buckets: BUCKETS.request,
  },
  "report.duration": {
    kind: "histogram",
    unit: "s",
    tier: "core",
    description:
      "Time to answer a report request, by the size of the book. The budget: at most 300 ms at p95 on a 5,000-journal book.",
    labels: { size_bucket: SIZE_KNOWN },
    buckets: BUCKETS.request,
  },
  "request.cpu.time": {
    kind: "counter",
    unit: "s",
    tier: "core",
    description:
      "CPU seconds spent answering requests. The process's CPU is shared out among the requests in flight, so the sum over requests equals the CPU of the busy periods.",
    labels: {
      operation_class: LABEL_VALUES.operation_class,
      size_bucket: LABEL_VALUES.size_bucket,
    },
  },
  "db.rows.written": {
    kind: "counter",
    unit: "{row}",
    tier: "core",
    description:
      "SQLite rows inserted, updated or deleted while answering requests (the connection's total_changes; index entries are not counted).",
    labels: { operation_class: LABEL_VALUES.operation_class },
  },
  // ---- The verified view of a book and the native ledger -----------------------------------------
  "read.duration": {
    kind: "histogram",
    unit: "s",
    tier: "detail",
    description:
      "Time for readAggregate to hand back the verified state, by where the read started.",
    labels: { read_kind: LABEL_VALUES.read_kind },
    buckets: BUCKETS.read,
  },
  "read.entries.verified": {
    kind: "counter",
    unit: "{entry}",
    tier: "detail",
    description:
      "Ledger entries the kernel re-executed and checked while reading the verified state.",
    labels: { read_kind: LABEL_VALUES.read_kind },
  },
  "read.peak_memory": {
    kind: "histogram",
    unit: "By",
    tier: "detail",
    description:
      "Highest resident memory of the process during the first read of a book, and whether an attempt to save a snapshot failed during it: the scale program found that failed attempt, past the kernel's 16 MiB cap, to be most of a cold read's peak.",
    labels: {
      read_kind: LABEL_VALUES.read_kind,
      snapshot_attempt: LABEL_VALUES.snapshot_attempt,
    },
    buckets: BUCKETS.memory,
  },
  "ledger.execute.duration": {
    kind: "histogram",
    unit: "s",
    tier: "detail",
    description: "Time for one command to go through the native ledger.",
    labels: { ledger_result: LABEL_VALUES.ledger_result },
    buckets: BUCKETS.fast,
  },
  "snapshot.duration": {
    kind: "histogram",
    unit: "s",
    tier: "detail",
    description: "Time to save or to load the saved verified state.",
    labels: { snapshot_op: LABEL_VALUES.snapshot_op },
    buckets: BUCKETS.activation,
  },
  "snapshot.bytes": {
    kind: "histogram",
    unit: "By",
    tier: "detail",
    description: "Size of a saved verified state, saved or loaded.",
    labels: { snapshot_op: LABEL_VALUES.snapshot_op },
    buckets: BUCKETS.bytes,
  },
  "snapshot.attempts": {
    kind: "counter",
    unit: "{attempt}",
    tier: "detail",
    description:
      "Attempts to save or load the saved verified state. A save past the kernel's 16 MiB ceiling fails after its memory has been spent; that is what failed counts.",
    labels: {
      snapshot_op: LABEL_VALUES.snapshot_op,
      snapshot_result: LABEL_VALUES.snapshot_result,
    },
  },
  "service.open.duration": {
    kind: "histogram",
    unit: "s",
    tier: "detail",
    description: "Time to open a book's database and ledger (not to read it).",
    labels: {},
    buckets: BUCKETS.activation,
  },
  // ---- Hosted books: activation, the commit, the lease (the hoststore lane emits these) ----------
  "activation.duration": {
    kind: "histogram",
    unit: "s",
    tier: "core",
    description:
      "Time to make a book ready on a pod, from nothing resident to ready to answer. The budget: a cold book in at most 3 s, 5,000 journals in at most 3 s with at most 1 GiB.",
    labels: { size_bucket: SIZE_KNOWN },
    buckets: BUCKETS.activation,
  },
  "activation.phase.duration": {
    kind: "histogram",
    unit: "s",
    tier: "detail",
    description:
      "The parts of an activation: the snapshot download, the sealed segments after it, the tail, applying the entries, and the verification.",
    labels: { activation_phase: LABEL_VALUES.activation_phase, size_bucket: SIZE_KNOWN },
    buckets: BUCKETS.activation,
  },
  activations: {
    kind: "counter",
    unit: "{activation}",
    tier: "detail",
    description:
      "Books made ready, by what they started from: a snapshot, or the log from the first entry.",
    labels: { activation_source: ACTIVATION_FROM, size_bucket: SIZE_KNOWN },
  },
  "activation.peak_memory": {
    kind: "histogram",
    unit: "By",
    tier: "detail",
    description:
      "Highest resident memory of the process while a book was being activated, and whether an attempt to save a snapshot failed during it (the scale program found that attempt to be most of the peak).",
    labels: { size_bucket: SIZE_KNOWN, snapshot_attempt: LABEL_VALUES.snapshot_attempt },
    buckets: BUCKETS.memory,
  },
  "commit.duration": {
    kind: "histogram",
    unit: "s",
    tier: "core",
    description:
      "Time to append an entry to the tail and have it acknowledged: the commit point. The budget: p95 at most 100 ms, target 30 ms.",
    labels: { size_bucket: SIZE_KNOWN },
    buckets: BUCKETS.tail,
  },
  "commit.conflicts": {
    kind: "counter",
    unit: "{conflict}",
    tier: "core",
    description:
      "Appends that lost the race for a sequence number, or were refused because the book had moved on.",
    labels: { size_bucket: SIZE_KNOWN },
  },
  "commit.uncertain": {
    kind: "counter",
    unit: "{commit}",
    tier: "detail",
    description:
      "Commits whose answer was lost, and what reading the entry back showed: ours, somebody else's, or still not known.",
    labels: { size_bucket: SIZE_KNOWN, resolution: LABEL_VALUES.resolution },
  },
  "entry.bytes": {
    kind: "histogram",
    unit: "By",
    tier: "detail",
    description: "Size of an object written to the book's prefix: a log entry, a snapshot, a blob.",
    labels: { object_kind: LABEL_VALUES.object_kind },
    buckets: BUCKETS.bytes,
  },
  "books.resident": {
    kind: "gauge",
    unit: "{book}",
    tier: "core",
    description: "Books held open in this process, by size.",
    labels: { size_bucket: SIZE_KNOWN },
  },
  // ---- The tail: the fast, strongly consistent store in front of the object store ------------------
  "tail.duration": {
    kind: "histogram",
    unit: "s",
    tier: "detail",
    description:
      "Time for one call to the tail, by which candidate it is (Postgres, a Durable Object, R2 used directly) and what it did.",
    labels: { tail_kind: TAIL_KIND, tail_op: TAIL_OP },
    buckets: BUCKETS.tail,
  },
  "tail.operations": {
    kind: "counter",
    unit: "{operation}",
    tier: "detail",
    description: "Calls to the tail, by candidate, call and how it ended.",
    labels: { tail_kind: TAIL_KIND, tail_op: TAIL_OP, outcome: CALL_OUTCOME },
  },
  "tail.rows.written": {
    kind: "counter",
    unit: "{row}",
    tier: "detail",
    description:
      "Rows written to the tail's own store, the quantity a Durable Object is billed on ($1.00 a million after 50 million a month) and capped on (100,000 a day on the free plan). A Durable Object tail writes one row for an entry, one for each lease call and one for each entry a seal deletes, plus the head row once; Postgres two for an entry.",
    labels: { tail_kind: TAIL_KIND },
  },
  "tail.depth": {
    kind: "gauge",
    unit: "{entry}",
    tier: "core",
    description: "Entries appended to the tail and not yet sealed into the object store.",
    labels: {},
  },
  "tail.size": {
    kind: "gauge",
    unit: "By",
    tier: "core",
    description: "Bytes of the entries appended to the tail and not yet sealed.",
    labels: {},
  },
  "tail.age": {
    kind: "gauge",
    unit: "s",
    tier: "core",
    description:
      "Age of the oldest unsealed entry that is due to be sealed: one that carries a write, one a previous holder left, or the effects of a read that have waited longer than they may. Entries allowed to wait (an agent's audit row, a read's derived rows) do not make it grow. If the object store is down it only grows.",
    labels: {},
  },
  "tail.breaker": {
    kind: "counter",
    unit: "{event}",
    tier: "core",
    description:
      "The tail's circuit breaker. While the tail keeps failing (a Cloudflare limit reached, an outage) the pod stops calling it: rejected counts each call refused without being made, which a person is told as 'service limit reached, try again later'; opened and closed count the changes of state.",
    labels: { breaker_event: LABEL_VALUES.breaker_event },
  },
  "lease.operations": {
    kind: "counter",
    unit: "{operation}",
    tier: "core",
    description:
      "Lease acquisitions, renewals and releases, and whether the tail granted them, refused them (somebody else holds it), found them expired, or failed.",
    labels: { lease_op: LABEL_VALUES.lease_op, lease_result: LABEL_VALUES.lease_result },
  },
  "lease.fence_rejections": {
    kind: "counter",
    unit: "{rejection}",
    tier: "core",
    description:
      "Writes the tail refused because their fencing token was stale: a writer that kept going after its lease passed to another.",
    labels: { tail_op: FENCED_OP },
  },
  "lease.reads": {
    kind: "counter",
    unit: "{read}",
    tier: "core",
    description:
      "Reads answered from the cache, by whether this pod held a valid lease on the book (no remote check) or had to take one or check first.",
    labels: { lease_state: LABEL_VALUES.lease_state },
  },
  "lease.held": {
    kind: "gauge",
    unit: "{lease}",
    tier: "core",
    description: "Leases this process holds now.",
    labels: {},
  },
  "seal.operations": {
    kind: "counter",
    unit: "{seal}",
    tier: "core",
    description:
      "Segments written to the object store from the tail, and how each ended, by the size of the book. Divide by the books in a size bucket for seals per book.",
    labels: { outcome: SEAL_OUTCOME, size_bucket: SIZE_KNOWN },
  },
  "seal.lag": {
    kind: "histogram",
    unit: "s",
    tier: "detail",
    description: "How long the oldest entry of a segment waited in the tail before it was sealed.",
    labels: {},
    buckets: BUCKETS.seal,
  },
  "seal.segment.bytes": {
    kind: "histogram",
    unit: "By",
    tier: "detail",
    description: "Size of a sealed segment.",
    labels: {},
    buckets: BUCKETS.bytes,
  },
  "seal.segment.entries": {
    kind: "histogram",
    unit: "{entry}",
    tier: "detail",
    description: "Entries in a sealed segment.",
    labels: {},
    buckets: BUCKETS.entries,
  },
  // ---- The object store ---------------------------------------------------------------------------
  "r2.operations": {
    kind: "counter",
    unit: "{operation}",
    tier: "core",
    description:
      "Calls to the object store. r2_class is derived from r2_op: A (put, list, copy), B (get, head), free (delete).",
    labels: { r2_op: LABEL_VALUES.r2_op, outcome: CALL_OUTCOME },
    derived: ["r2_class"],
  },
  "r2.bytes": {
    kind: "counter",
    unit: "By",
    tier: "core",
    description: "Bytes sent to the object store (in) and received from it (out).",
    labels: { direction: LABEL_VALUES.direction, object_kind: LABEL_VALUES.object_kind },
  },
  "r2.duration": {
    kind: "histogram",
    unit: "s",
    tier: "core",
    description: "Time for one call to the object store.",
    labels: { r2_op: LABEL_VALUES.r2_op },
    buckets: BUCKETS.call,
  },
  // ---- Jobs and queues ----------------------------------------------------------------------------
  jobs: {
    kind: "counter",
    unit: "{job}",
    tier: "core",
    description: "Background jobs finished, by type and how they ended.",
    labels: { job_type: LABEL_VALUES.job_type, outcome: SIMPLE_OUTCOME },
  },
  "job.duration": {
    kind: "histogram",
    unit: "s",
    tier: "detail",
    description: "Wall-clock time of a background job.",
    labels: { job_type: LABEL_VALUES.job_type },
    buckets: BUCKETS.job,
  },
  "job.cpu.time": {
    kind: "counter",
    unit: "s",
    tier: "core",
    description: "CPU seconds spent in background jobs, by type.",
    labels: { job_type: LABEL_VALUES.job_type },
  },
  "job.memory.peak": {
    kind: "histogram",
    unit: "By",
    tier: "detail",
    description: "Highest resident memory of the process while a job ran.",
    labels: { job_type: LABEL_VALUES.job_type },
    buckets: BUCKETS.memory,
  },
  "queue.depth": {
    kind: "gauge",
    unit: "{job}",
    tier: "core",
    description: "Items waiting in a queue.",
    labels: { queue: LABEL_VALUES.queue },
  },
  "queue.age": {
    kind: "gauge",
    unit: "s",
    tier: "core",
    description: "Age of the oldest item waiting in a queue.",
    labels: { queue: LABEL_VALUES.queue },
  },
  "verify.lag": {
    kind: "gauge",
    unit: "s",
    tier: "core",
    description:
      "How far behind the head of a log the independent verifier is, for the most-behind book of each size.",
    labels: { size_bucket: SIZE_KNOWN },
  },
  // ---- The population (written by a census, never by a request) -----------------------------------
  "stored.bytes": {
    kind: "gauge",
    unit: "By",
    tier: "core",
    description: "Bytes held in the object store, by the size of the book and the kind of object.",
    labels: { size_bucket: SIZE_KNOWN, object_kind: LABEL_VALUES.object_kind },
  },
  tenants: {
    kind: "gauge",
    unit: "{tenant}",
    tier: "core",
    description: "Tenants, by the size of their book.",
    labels: { size_bucket: SIZE_KNOWN },
  },
  // ---- The process ---------------------------------------------------------------------------------
  "process.cpu.time": {
    kind: "counter",
    unit: "s",
    tier: "core",
    description: "CPU seconds used by the process, user and system.",
    labels: { cpu_mode: LABEL_VALUES.cpu_mode },
  },
  "process.memory": {
    kind: "gauge",
    unit: "By",
    tier: "core",
    description: "Memory of the process: resident set, JavaScript heap in use, external.",
    labels: { memory_kind: LABEL_VALUES.memory_kind },
  },
  "process.memory.limit": {
    kind: "gauge",
    unit: "By",
    tier: "core",
    description: "The memory limit of the container (cgroup), when there is one.",
    labels: {},
  },
  "process.event_loop.lag": {
    kind: "histogram",
    unit: "s",
    tier: "core",
    description: "How late a 100 ms timer fires: the event loop being held up by synchronous work.",
    labels: {},
    buckets: BUCKETS.lag,
  },
  "process.idle.time": {
    kind: "gauge",
    unit: "s",
    tier: "core",
    description:
      "Seconds since the process last had nothing to do (no request or job in flight); 0 while busy. A pod that never goes idle never frees its books.",
    labels: {},
  },
  // ---- Real users: measured in the browser, validated and recorded by the API ---------------------
  "web.lcp": {
    kind: "histogram",
    unit: "s",
    tier: "core",
    description:
      "Largest contentful paint of a page view, as the browser measured it. The budget: p75 at most 2.5 s.",
    labels: { size_bucket: SIZE_KNOWN },
    buckets: BUCKETS.lcp,
  },
  "web.inp": {
    kind: "histogram",
    unit: "s",
    tier: "core",
    description:
      "Interaction to next paint: the slowest interaction of a page view. The budget: p75 at most 200 ms.",
    labels: { size_bucket: SIZE_KNOWN },
    buckets: BUCKETS.inp,
  },
  "web.ttfb": {
    kind: "histogram",
    unit: "s",
    tier: "detail",
    description: "Time to first byte of a page view's document.",
    labels: { size_bucket: SIZE_KNOWN },
    buckets: BUCKETS.ttfb,
  },
  "web.cls": {
    kind: "histogram",
    unit: "1",
    tier: "detail",
    description: "Cumulative layout shift of a page view: a score, not a time.",
    labels: { size_bucket: SIZE_KNOWN },
    buckets: BUCKETS.cls,
  },
  "web.action.duration": {
    kind: "histogram",
    unit: "s",
    tier: "core",
    description:
      "From the click on a key action (accept, post, save) to the screen showing it confirmed. The budget: p95 at most 250 ms.",
    labels: { web_action: LABEL_VALUES.web_action, size_bucket: SIZE_KNOWN },
    buckets: BUCKETS.action,
  },
  "web.actions": {
    kind: "counter",
    unit: "{action}",
    tier: "core",
    description: "Key actions a person took in the browser, and how each ended.",
    labels: { web_action: LABEL_VALUES.web_action, outcome: SIMPLE_OUTCOME },
  },
  "web.beacons": {
    kind: "counter",
    unit: "{beacon}",
    tier: "detail",
    description:
      "Reports from browsers, by whether the API took them, refused them, or sampled them out.",
    labels: { web_beacon: LABEL_VALUES.web_beacon },
  },
  // ---- About telemetry itself: a silent outage of the monitoring is itself visible ----------------
  "telemetry.traces": {
    kind: "counter",
    unit: "{trace}",
    tier: "detail",
    description:
      "Traces the sampler decided on, and what it decided: errors and slow requests are always kept, the rest at a low rate.",
    labels: { sampling_decision: LABEL_VALUES.sampling_decision },
  },
  "telemetry.exports": {
    kind: "counter",
    unit: "{export}",
    tier: "core",
    description:
      "Batches of spans or metrics that telemetry tried to send: sent, failed, or not tried because the collector was down and the exporter was backing off.",
    labels: {
      telemetry_signal: LABEL_VALUES.telemetry_signal,
      export_result: LABEL_VALUES.export_result,
    },
  },
  "telemetry.dropped": {
    kind: "counter",
    unit: "{item}",
    tier: "core",
    description:
      "Spans and metric batches telemetry threw away rather than hold or retry: the bounded queue was full, the exporter was backing off, the export failed, or the sampler's buffer overflowed. It never slows a request, and this says how much it cost in data.",
    labels: {
      telemetry_signal: LABEL_VALUES.telemetry_signal,
      drop_reason: LABEL_VALUES.drop_reason,
    },
  },
  "telemetry.queue": {
    kind: "gauge",
    unit: "{span}",
    tier: "detail",
    description: "Spans waiting to be sent.",
    labels: {},
  },
} as const satisfies Record<string, MetricSpec>;

export type MetricName = keyof typeof METRICS;
type KindOf<N extends MetricName> = (typeof METRICS)[N]["kind"];
type NamesOfKind<K extends MetricKind> = {
  [N in MetricName]: KindOf<N> extends K ? N : never;
}[MetricName];
export type CounterName = NamesOfKind<"counter">;
export type HistogramName = NamesOfKind<"histogram">;
export type GaugeName = NamesOfKind<"gauge">;

/** The labels a metric takes: exactly the keys of its entry, each from its own set. */
export type LabelsOf<N extends MetricName> = {
  readonly [K in keyof (typeof METRICS)[N]["labels"]]: (typeof METRICS)[N]["labels"][K] extends readonly (infer V)[]
    ? V
    : never;
};

export const METRIC_NAMES = Object.keys(METRICS) as MetricName[];

/** The name the instrument is exported under. */
export const exportedName = (name: MetricName): string => `rastrata.${name}`;

/** The name Prometheus (and Grafana Cloud) gives the exported series, under the OpenTelemetry rules
 * (the translator in github.com/prometheus/otlptranslator): the name is split into words, a unit
 * that names a physical quantity is added as a word unless the name already has it (s -> seconds,
 * By -> bytes; an annotation such as {request}, and 1 on a histogram, adds nothing), a counter gets
 * a final word `total`, and the words are joined with underscores. A histogram is then read as
 * <name>_bucket, <name>_sum and <name>_count. The local stack checks these against the names
 * Prometheus actually holds. */
export function prometheusName(name: MetricName): string {
  const spec = METRICS[name] as MetricSpec;
  const words = exportedName(name)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const unit =
    spec.unit === "s"
      ? "seconds"
      : spec.unit === "By"
        ? "bytes"
        : spec.unit === "1" && spec.kind === "gauge"
          ? "ratio"
          : "";
  if (unit && !words.includes(unit)) words.push(unit);
  if (spec.kind === "counter" && !words.includes("total")) words.push("total");
  return words.join("_");
}

/** Every label key an entry exports: the ones a caller gives, then the derived ones. */
export function exportedLabelKeys(name: MetricName): string[] {
  const spec = METRICS[name] as MetricSpec;
  return [...Object.keys(spec.labels), ...(spec.derived ?? [])];
}

/** The most time series one process can ever hold for a metric: the product of the sizes of its
 * label sets (a derived label adds none), times the series each combination makes. A counter or a
 * gauge makes one. A histogram makes one per bucket boundary, one for +Inf, a sum and a count. */
export function worstCaseSeries(name: MetricName): number {
  const spec = METRICS[name] as MetricSpec;
  let combinations = 1;
  for (const values of Object.values(spec.labels))
    combinations *= (values as readonly string[]).length;
  return combinations * (spec.kind === "histogram" ? (spec.buckets?.length ?? 0) + 3 : 1);
}

/** The most time series one process may be able to make in each tier (worstCaseSeries summed). Raising
 * it is a decision about Grafana Cloud's 10,000 free active series: docs/reference/telemetry.md
 * explains the arithmetic. The detail tier is not sent to the cloud, so its limit is the local
 * stack's comfort, not a bill. */
export const SERIES_BUDGET = { corePerProcess: 1000, detailPerProcess: 1500 } as const;

// ---- Spans -----------------------------------------------------------------------------------------

/** Span names are a closed list, like metric names, so a trace backend never fills with names that
 * carry ids. Lanes add theirs here. */
export const SPAN_NAMES = [
  "http.request",
  "operation",
  "ledger.execute",
  "read.aggregate",
  "sql.transaction",
  "service.open",
  "snapshot.save",
  "snapshot.load",
  "activation",
  "activation.snapshot",
  "activation.sealed",
  "activation.tail",
  "activation.apply",
  "activation.verify",
  "lease.acquire",
  "lease.renew",
  "tail.append",
  "tail.read",
  "seal.run",
  "booklog.commit",
  "booklog.materialize",
  "booklog.freshness",
  "booklog.apply",
  "booklog.verify",
  "r2.put",
  "r2.get",
  "r2.head",
  "r2.list",
  "r2.delete",
  "r2.copy",
  "job",
  "job.verify",
  "job.backup",
  "ingest.archive",
  "ingest.preview",
  "ingest.submit",
  "ingest.propose",
  "ingest.post",
] as const;
export type SpanName = (typeof SPAN_NAMES)[number];

/** Span attribute keys. Unlike a metric label, an attribute value is not bounded, so identifiers
 * (book.id, operation_id) are fine here. Never put a secret, a token, a memo or any text a customer
 * typed in one. A key spelled `x.<anything>` is allowed for an experiment and is not exported by the
 * dashboards. */
export const SPAN_ATTRIBUTE_KEYS = [
  "book.id",
  "seq",
  "from_seq",
  "to_seq",
  "fence",
  "bytes",
  "entries",
  "rows",
  "attempt",
  "size_bucket",
  "outcome",
  "kind",
  "tail_kind",
  "operation",
  "operation_class",
  "operation_id",
  "read_kind",
  "ledger_result",
  "r2_op",
  "r2_class",
  "job_type",
  "queue",
  "http.request.method",
  "http.route",
  "http.response.status_code",
  "error.code",
  "exception.type",
  "exception.message",
] as const;
export type SpanAttributeKey = (typeof SPAN_ATTRIBUTE_KEYS)[number] | `x.${string}`;
export type SpanAttributeValue = string | number | boolean;
export type SpanAttrs = { readonly [K in SpanAttributeKey]?: SpanAttributeValue | undefined };

export const SPAN_EVENT_NAMES = [
  "retry",
  "conflict",
  "uncertain",
  "fenced",
  "lease.lost",
  "cache.hit",
  "cache.miss",
  "snapshot.dropped",
] as const;
export type SpanEventName = (typeof SPAN_EVENT_NAMES)[number] | `x.${string}`;

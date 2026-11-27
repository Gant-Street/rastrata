/** The closed sets of values a metric label may take.
 *
 * A label is never a free string: its key must be in the metric's catalog entry (catalog.ts) and its
 * value in the set below, so the number of time series a metric can ever produce is the product of
 * the sizes of its sets, known when the code is written (see tools/series-budget.ts). Never add a
 * tenant, book, user, operation or request identifier here: those belong on a span, not on a metric.
 *
 * A value that is not in its set (only reachable through a cast or from untyped code) is recorded as
 * "other" or "unknown" when the set has one, and dropped otherwise. */
export const LABEL_VALUES = {
  /** How big a book is, by the number of journals it holds (sizeBucket below). */
  size_bucket: ["xs", "s", "m", "l", "xl", "unknown"],
  /** How a request, a call or a command ended (outcomeOfStatus below maps an HTTP status). */
  outcome: ["ok", "not_found", "conflict", "client_error", "server_error", "timeout", "other"],
  /** What an application operation costs to run, not what it is called (operationClass in the
   * application package maps each of the operations to one of these). */
  operation_class: [
    "read",
    "report",
    "draft",
    "prepare",
    "post",
    "maintain",
    "ingest",
    "job",
    "legacy",
    "other",
  ],
  /** Where a read of the verified book state started: the state already in memory, a saved
   * snapshot, or the whole log from the first entry. */
  read_kind: ["view", "snapshot", "full", "other"],
  ledger_result: ["committed", "rejected", "error", "other"],
  /** The object-store call. Its price class is derived from it (r2ClassOf) and added by the
   * backend as the label `r2_class`; a caller never sets it. */
  r2_op: ["put", "get", "head", "list", "delete", "copy", "other"],
  r2_class: ["A", "B", "free"],
  direction: ["in", "out"],
  object_kind: ["log", "snapshot", "blob", "sealed", "other"],
  activation_source: ["snapshot", "log", "view", "other"],
  /** The parts of making a book ready, in the order they happen. */
  activation_phase: ["snapshot_download", "sealed_segments", "tail", "apply", "verify", "other"],
  /** Whether an attempt to save an aggregate snapshot failed while a book was being activated. */
  snapshot_attempt: ["none", "ok", "failed"],
  snapshot_result: ["ok", "failed", "skipped"],
  /** Which candidate stores the tail: the program's proof compares them. "memory" is the test fake. */
  tail_kind: ["postgres", "durable_object", "r2", "memory", "other"],
  tail_op: ["append", "read", "lease", "renew", "seal", "trim", "other"],
  lease_op: ["acquire", "renew", "release", "other"],
  /** What the tail's circuit breaker did: it opened, it closed, or it refused a call without making it. */
  breaker_event: ["opened", "closed", "rejected"],
  lease_result: ["granted", "denied", "expired", "error", "other"],
  /** Whether a read was answered while the pod held a valid lease on the book. */
  lease_state: ["leased", "unleased"],
  /** The key actions the browser times from the click to the confirmation. */
  web_action: ["accept", "post", "save", "other"],
  web_beacon: ["accepted", "rejected", "other"],
  resolution: ["ours", "theirs", "unknown"],
  job_type: ["verify", "backup", "export", "import", "sync", "render", "other"],
  queue: ["jobs", "verify", "other"],
  cpu_mode: ["user", "system"],
  memory_kind: ["rss", "heap_used", "external", "other"],
  snapshot_op: ["save", "load"],
  sampling_decision: ["kept_error", "kept_slow", "kept_upstream", "kept_sampled", "dropped"],
  /** What telemetry itself sends: spans, or metric data points. */
  telemetry_signal: ["traces", "metrics"],
  export_result: ["ok", "failed", "dropped"],
  /** Why telemetry threw something away rather than send it: the queue was full, the collector was
   * down and the exporter was backing off, the export failed, or the sampler's buffer overflowed. */
  drop_reason: ["queue_full", "backing_off", "export_failed", "sampler_buffer", "other"],
} as const;

export type LabelKey = keyof typeof LABEL_VALUES;
export type LabelValue<K extends LabelKey> = (typeof LABEL_VALUES)[K][number];

export type SizeBucket = LabelValue<"size_bucket">;
export type Outcome = LabelValue<"outcome">;
export type OperationClass = LabelValue<"operation_class">;
export type R2Operation = LabelValue<"r2_op">;
export type R2Class = LabelValue<"r2_class">;

/** The upper bounds (exclusive) of the size buckets, in journals. They are the sizes the scale and
 * hosting programs measure at (500, 2,000, 5,000 and 20,000), so a book seeded at one of those sizes
 * is at the start of its bucket and has room to grow before it leaves it. */
export const SIZE_BUCKET_LIMITS = { xs: 500, s: 2_000, m: 5_000, l: 20_000 } as const;

/** The bucket for a book of `journals` journals. The size is the number of journals the book holds,
 * which the kernel keeps as `state.latestPostingSequence` (exact, and free to read) and the native
 * ledger's head sequence follows within a few. It is NOT the sequence number of the hosted book
 * log: a journal posted through the app is about three log entries (draft, prepare, commit), so
 * that number would put every book in a bucket about three times too large. Anything that is not a
 * non-negative number, such as a book whose size is not yet known, is "unknown". */
export function sizeBucket(journals: number | bigint | string | null | undefined): SizeBucket {
  if (journals === null || journals === undefined || journals === "") return "unknown";
  const count = typeof journals === "number" ? journals : Number(journals);
  if (!Number.isFinite(count) || count < 0) return "unknown";
  if (count < SIZE_BUCKET_LIMITS.xs) return "xs";
  if (count < SIZE_BUCKET_LIMITS.s) return "s";
  if (count < SIZE_BUCKET_LIMITS.m) return "m";
  if (count < SIZE_BUCKET_LIMITS.l) return "l";
  return "xl";
}

/** The R2 price class of a call, from Cloudflare's list of operations
 * (https://developers.cloudflare.com/r2/pricing/, read 2026-10-07): PutObject, CopyObject,
 * ListObjects and the multipart calls are Class A; GetObject and HeadObject are Class B;
 * DeleteObject is free. An operation this code does not know is priced as Class A, the dearer, so a
 * mistake over-counts the bill. */
export function r2ClassOf(operation: R2Operation): R2Class {
  switch (operation) {
    case "get":
    case "head":
      return "B";
    case "delete":
      return "free";
    default:
      return "A";
  }
}

/** The outcome of an HTTP exchange. 404 is a normal answer to "is there a next entry?", 409 and 412
 * are the two ways of losing a race, 408 and 504 are time running out. */
export function outcomeOfStatus(status: number): Outcome {
  if (status >= 200 && status < 400) return "ok";
  if (status === 404) return "not_found";
  if (status === 409 || status === 412) return "conflict";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 400 && status < 500) return "client_error";
  if (status >= 500) return "server_error";
  return "other";
}

/** The value that stands in for one that is not in a set of allowed values: "other" or "unknown"
 * when the set has it, otherwise undefined and the data point is dropped. The set is a metric's own
 * (it may be a part of the global one), so a stand-in is never a value the metric cannot have. */
export function standIn(values: readonly string[]): string | undefined {
  if (values.includes("other")) return "other";
  if (values.includes("unknown")) return "unknown";
  return undefined;
}

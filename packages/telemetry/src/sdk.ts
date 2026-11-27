/** The exporting backend: the OpenTelemetry SDK's tracer and meter, a `fetch` transport that cannot
 * hurt the service (export.ts), a bounded queue (batch.ts), tail sampling (sampling.ts), and the
 * catalog's label checks. It is loaded only by `configureTelemetry` when an endpoint is configured,
 * so the local product never loads the SDK.
 *
 * Nothing here is registered globally: no global tracer provider, meter provider, context manager or
 * propagator, so it cannot collide with another OpenTelemetry user in the same process. Context
 * follows `await` through a private AsyncLocalStorage. */
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile } from "node:fs/promises";
import {
  type Attributes,
  type Counter as ApiCounter,
  type Gauge as ApiGauge,
  type Histogram as ApiHistogram,
  type Context,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
  type ViewOptions,
} from "@opentelemetry/sdk-metrics";
import { AlwaysOnSampler, TracerProvider } from "@opentelemetry/sdk-trace";
import type { Backend, RawLabels, SpanHandle, TelemetryStatus } from "./api.ts";
import { BoundedBatchProcessor, type BackingOffExporter } from "./batch.ts";
import {
  METRICS,
  exportedName,
  type CounterName,
  type GaugeName,
  type HistogramName,
  type MetricName,
  type MetricSpec,
  type SpanAttributeValue,
  type SpanAttrs,
  type SpanName,
} from "./catalog.ts";
import type { TelemetryConfig } from "./config.ts";
import {
  FetchMetricExporter,
  FetchSpanExporter,
  FetchTransport,
  type DropReason,
  type ExportReport,
} from "./export.ts";
import { describeError, normalizeLabels } from "./normalize.ts";
import { TailSamplingProcessor } from "./sampling.ts";
import { runInSpan } from "./span-run.ts";
import { formatTraceparent, parseTraceparent } from "./traceparent.ts";

export const PACKAGE_VERSION = "0.0.0";

export interface SdkBackendOptions {
  readonly config: TelemetryConfig;
  /** Replaces `fetch`, for tests. */
  readonly fetch?: typeof fetch;
  /** Replace the exporters entirely, for tests that read what the SDK produced. */
  readonly spanExporter?: BackingOffExporter;
  readonly metricExporter?: PushMetricExporter;
  /** Tail sampling clock, for tests. */
  readonly now?: () => number;
}

export interface SdkBackend extends Backend {
  status(): TelemetryStatus;
  /** Called by the runtime sampler on its tick: reads the queue size into its gauge. */
  sampleSelf(): void;
}

/** Spans that call out are CLIENT spans, the request a person's browser makes is a SERVER span. */
function kindOf(name: SpanName): SpanKind {
  if (name === "http.request") return SpanKind.SERVER;
  if (name.startsWith("r2.") || name.startsWith("tail.") || name.startsWith("lease."))
    return SpanKind.CLIENT;
  return SpanKind.INTERNAL;
}

const MAX_STRING = 256;

function cleanAttributes(attrs: SpanAttrs | undefined): Attributes | undefined {
  if (!attrs) return undefined;
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attrs) as [string, SpanAttributeValue | undefined][]) {
    if (value === undefined) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    out[key] = typeof value === "string" ? value.slice(0, MAX_STRING) : value;
  }
  return out;
}

/** The most distinct label combinations a metric can have: the product of the sizes of its sets. */
function combinations(spec: MetricSpec): number {
  let total = 1;
  for (const values of Object.values(spec.labels)) total *= (values as readonly string[]).length;
  return total;
}

export function createSdkBackend(options: SdkBackendOptions): SdkBackend {
  const { config } = options;
  const resource = resourceFromAttributes({
    ...config.resourceAttributes,
    "telemetry.sdk.name": "rastrata-telemetry",
  });
  const status = {
    exports: {
      traces: { ok: 0, failed: 0, dropped: 0 },
      metrics: { ok: 0, failed: 0, dropped: 0 },
    },
    dropped: { traces: 0, metrics: 0 },
    lastSuccessAt: null as string | null,
    invalid: 0,
  };
  const transports: { traces?: FetchTransport; metrics?: FetchTransport } = {};
  // Filled in below; the reporting functions need the backend object they are part of.
  const self: { count?: Backend["count"]; set?: Backend["set"] } = {};

  const dropped = (signal: "traces" | "metrics", items: number, reason: DropReason) => {
    status.dropped[signal] += items;
    self.count?.("telemetry.dropped", items, { telemetry_signal: signal, drop_reason: reason });
  };
  const report = (value: ExportReport) => {
    status.exports[value.signal][value.result] += 1;
    if (value.result === "ok") status.lastSuccessAt = new Date().toISOString();
    self.count?.("telemetry.exports", 1, {
      telemetry_signal: value.signal,
      export_result: value.result,
    });
    if (value.result !== "ok") dropped(value.signal, value.items, value.reason ?? "export_failed");
  };

  const common = {
    headers: config.headers,
    compression: config.compression,
    timeoutMs: config.timeoutMs,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  } as const;

  // ---- Traces -------------------------------------------------------------------------------
  if (!options.spanExporter)
    transports.traces = new FetchTransport({ signal: "traces", url: config.tracesUrl, ...common });
  const spanExporter: BackingOffExporter =
    options.spanExporter ?? new FetchSpanExporter(transports.traces as FetchTransport, report);
  const batch = new BoundedBatchProcessor(spanExporter, {
    maxQueue: 2_048,
    maxBatch: 128,
    delayMs: 2_000,
    exportTimeoutMs: 15_000,
    onDrop: (items, reason) => dropped("traces", items, reason),
  });
  const sampler = new TailSamplingProcessor(batch, {
    rate: config.sampleRate,
    slowMs: config.slowMs,
    onDecision: (decision) => self.count?.("telemetry.traces", 1, { sampling_decision: decision }),
    onDrop: (items, reason) => dropped("traces", items, reason),
    ...(options.now ? { now: options.now } : {}),
  });
  const tracerProvider = new TracerProvider({
    resource,
    sampler: new AlwaysOnSampler(),
    spanProcessors: [sampler],
    spanLimits: {
      attributeCountLimit: 64,
      attributeValueLengthLimit: 512,
      eventCountLimit: 32,
      linkCountLimit: 4,
    },
  });
  const tracer = tracerProvider.getTracer("rastrata", PACKAGE_VERSION);
  const scope = new AsyncLocalStorage<Context>();

  // ---- Metrics ------------------------------------------------------------------------------
  const dump = config.dumpFile
    ? (line: string) => {
        void appendFile(config.dumpFile as string, `${line}\n`).catch(() => undefined);
      }
    : undefined;
  if (!options.metricExporter)
    transports.metrics = new FetchTransport({
      signal: "metrics",
      url: config.metricsUrl,
      ...common,
    });
  const metricExporter: PushMetricExporter =
    options.metricExporter ??
    new FetchMetricExporter(transports.metrics as FetchTransport, report, dump);
  const reader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: config.metricsIntervalMs,
    exportTimeoutMillis: Math.min(10_000, config.metricsIntervalMs),
  });
  // A backstop under the catalog's own bound: if a bug ever made a metric produce more label sets
  // than its entry allows, the SDK folds the excess into one overflow series instead of growing.
  const views: ViewOptions[] = (Object.keys(METRICS) as MetricName[]).map((name) => ({
    instrumentName: exportedName(name),
    aggregationCardinalityLimit: combinations(METRICS[name] as MetricSpec) + 1,
  }));
  const meterProvider = new MeterProvider({ resource, readers: [reader], views });
  const meter = meterProvider.getMeter("rastrata", PACKAGE_VERSION);
  const instruments = new Map<MetricName, ApiCounter | ApiHistogram | ApiGauge>();

  function instrument(name: MetricName): ApiCounter | ApiHistogram | ApiGauge {
    const existing = instruments.get(name);
    if (existing) return existing;
    const spec = METRICS[name] as MetricSpec;
    const base = { unit: spec.unit, description: spec.description };
    const created =
      spec.kind === "counter"
        ? meter.createCounter(exportedName(name), base)
        : spec.kind === "gauge"
          ? meter.createGauge(exportedName(name), base)
          : meter.createHistogram(exportedName(name), {
              ...base,
              advice: { explicitBucketBoundaries: [...(spec.buckets ?? [])] },
            });
    instruments.set(name, created);
    return created;
  }

  const point = (name: MetricName, value: number, labels: RawLabels) => {
    if (!Number.isFinite(value)) return undefined;
    const attributes = normalizeLabels(name, labels);
    if (attributes === null) {
      status.invalid += 1;
      return undefined;
    }
    return attributes;
  };

  // ---- Spans --------------------------------------------------------------------------------
  const withSpan = <T>(
    name: SpanName,
    attrs: SpanAttrs | undefined,
    fn: (span: SpanHandle) => T,
  ): T => {
    const parent = scope.getStore() ?? ROOT_CONTEXT;
    const apiSpan = tracer.startSpan(
      name,
      { kind: kindOf(name), ...cleanAttrsOption(attrs) },
      parent,
    );
    const context = trace.setSpan(parent, apiSpan);
    let failedWith: unknown;
    let failed = false;
    const handle: SpanHandle = {
      setAttribute(key, value) {
        if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) return;
        apiSpan.setAttribute(key, typeof value === "string" ? value.slice(0, MAX_STRING) : value);
      },
      setAttributes(values) {
        const clean = cleanAttributes(values);
        if (clean) apiSpan.setAttributes(clean);
      },
      addEvent(eventName, eventAttrs) {
        apiSpan.addEvent(eventName, cleanAttributes(eventAttrs));
      },
      fail(error) {
        if (failed && failedWith === error) return;
        failed = true;
        failedWith = error;
        const described = describeError(error, config.errorMessages);
        apiSpan.setStatus({
          code: SpanStatusCode.ERROR,
          ...(described.message ? { message: described.message } : {}),
        });
        apiSpan.setAttribute("exception.type", described.type);
        if (described.code) apiSpan.setAttribute("error.code", described.code);
        apiSpan.addEvent("exception", {
          "exception.type": described.type,
          ...(described.message ? { "exception.message": described.message } : {}),
        });
      },
    };
    return runInSpan(
      { handle, run: (run) => scope.run(context, run), end: () => apiSpan.end() },
      fn,
    );
  };

  function cleanAttrsOption(attrs: SpanAttrs | undefined): { attributes?: Attributes } {
    const clean = cleanAttributes(attrs);
    return clean ? { attributes: clean } : {};
  }

  const settled = async (work: Promise<unknown>[], timeoutMs: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([Promise.allSettled(work), limit]);
    } finally {
      clearTimeout(timer);
    }
  };

  const backend: SdkBackend = {
    span: withSpan,
    count(name: CounterName, value, labels) {
      if (!(value >= 0)) return;
      const attributes = point(name, value, labels);
      if (attributes) (instrument(name) as ApiCounter).add(value, attributes);
    },
    record(name: HistogramName, value, labels) {
      const attributes = point(name, value, labels);
      if (attributes) (instrument(name) as ApiHistogram).record(value, attributes);
    },
    set(name: GaugeName, value, labels) {
      const attributes = point(name, value, labels);
      if (attributes) (instrument(name) as ApiGauge).record(value, attributes);
    },
    traceparent() {
      const context = scope.getStore();
      const current = context ? trace.getSpanContext(context) : undefined;
      return current
        ? formatTraceparent({
            traceId: current.traceId,
            spanId: current.spanId,
            flags: current.traceFlags,
          })
        : undefined;
    },
    withTraceparent(header, fn) {
      const parsed = parseTraceparent(header);
      if (!parsed) return fn();
      const remote = trace.setSpanContext(ROOT_CONTEXT, {
        traceId: parsed.traceId,
        spanId: parsed.spanId,
        traceFlags:
          (parsed.flags & TraceFlags.SAMPLED) !== 0 ? TraceFlags.SAMPLED : TraceFlags.NONE,
        isRemote: true,
      });
      return scope.run(remote, fn);
    },
    async flush(timeoutMs) {
      await settled([tracerProvider.forceFlush(), meterProvider.forceFlush()], timeoutMs);
    },
    async shutdown(timeoutMs) {
      await settled([tracerProvider.shutdown(), meterProvider.shutdown()], timeoutMs);
      // Whatever is still in flight is abandoned, not waited for.
      await Promise.allSettled([transports.traces?.close(0), transports.metrics?.close(0)]);
    },
    status() {
      return {
        enabled: true,
        exports: {
          traces: { ...status.exports.traces },
          metrics: { ...status.exports.metrics },
        },
        dropped: { ...status.dropped },
        queued: batch.size,
        consecutiveFailures: {
          traces: transports.traces?.consecutiveFailures ?? 0,
          metrics: transports.metrics?.consecutiveFailures ?? 0,
        },
        lastSuccessAt: status.lastSuccessAt,
        invalid: status.invalid,
      };
    },
    sampleSelf() {
      self.set?.("telemetry.queue", batch.size, undefined);
    },
  };
  self.count = backend.count;
  self.set = backend.set;
  return backend;
}

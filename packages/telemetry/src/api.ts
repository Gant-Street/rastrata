/** The API the product calls. It does nothing until a backend is installed, and then forwards to it:
 * with no backend a span is `fn(NOOP_SPAN)` and a metric call is one comparison, so the local
 * product pays nothing. Backends (the OpenTelemetry one that exports, the in-memory one the tests
 * use) live in other files and install themselves with `installBackend`. */
import type {
  CounterName,
  GaugeName,
  HistogramName,
  LabelsOf,
  MetricName,
  SpanAttributeKey,
  SpanAttributeValue,
  SpanAttrs,
  SpanEventName,
  SpanName,
} from "./catalog.ts";

/** What `fn` receives inside `span()`. Setting an attribute on the no-op handle is free. */
export interface SpanHandle {
  setAttribute(key: SpanAttributeKey, value: SpanAttributeValue | undefined): void;
  setAttributes(attrs: SpanAttrs): void;
  addEvent(name: SpanEventName, attrs?: SpanAttrs): void;
  /** Mark the span failed without throwing, for an error that is handled but should show up. */
  fail(error: unknown): void;
}

export const NOOP_SPAN: SpanHandle = Object.freeze({
  setAttribute() {},
  setAttributes() {},
  addEvent() {},
  fail() {},
});

/** The label arguments of an instrument: nothing, or an empty object, for a metric without labels,
 * otherwise the object with exactly the labels of its catalog entry. */
type LabelArgs<N extends MetricName> = keyof LabelsOf<N> extends never
  ? [labels?: { readonly [key: string]: never }]
  : [labels: LabelsOf<N>];

export interface Counter<N extends CounterName> {
  add(value: number, ...labels: LabelArgs<N>): void;
}
export interface Histogram<N extends HistogramName> {
  record(value: number, ...labels: LabelArgs<N>): void;
}
export interface Gauge<N extends GaugeName> {
  set(value: number, ...labels: LabelArgs<N>): void;
}

export type RawLabels = Readonly<Record<string, string>> | undefined;

/** How telemetry's own sending is going, for `/health` and for tests: a silent outage of the
 * monitoring must be visible. Counts are since the process started. */
export interface TelemetryStatus {
  readonly enabled: boolean;
  readonly exports: {
    readonly traces: { readonly ok: number; readonly failed: number; readonly dropped: number };
    readonly metrics: { readonly ok: number; readonly failed: number; readonly dropped: number };
  };
  /** Spans (traces) and metric batches thrown away rather than held or retried. */
  readonly dropped: { readonly traces: number; readonly metrics: number };
  /** Spans waiting to be sent. */
  readonly queued: number;
  /** Failed sends in a row: more than zero means the collector is down or refusing, and sending is
   * backing off. */
  readonly consecutiveFailures: { readonly traces: number; readonly metrics: number };
  /** The time of the last export the collector accepted, or null. */
  readonly lastSuccessAt: string | null;
  /** Data points the catalog refused (a label missing or outside its set). */
  readonly invalid: number;
}

/** What a backend implements. Values reaching it are not yet validated against the catalog:
 * `normalizeLabels` (normalize.ts) does that. */
export interface Backend {
  /** Optional: how sending is going. */
  status?(): TelemetryStatus;
  span<T>(name: SpanName, attrs: SpanAttrs | undefined, fn: (span: SpanHandle) => T): T;
  count(name: CounterName, value: number, labels: RawLabels): void;
  record(name: HistogramName, value: number, labels: RawLabels): void;
  set(name: GaugeName, value: number, labels: RawLabels): void;
  /** The `traceparent` of the current span, or undefined outside one. */
  traceparent(): string | undefined;
  /** Run `fn` as a continuation of the trace named by an incoming `traceparent` header. */
  withTraceparent<T>(header: string | null | undefined, fn: () => T): T;
  /** Send what is buffered, giving up after `timeoutMs`. Never rejects. */
  flush(timeoutMs: number): Promise<void>;
  /** Flush, then stop. Never rejects. */
  shutdown(timeoutMs: number): Promise<void>;
}

let backend: Backend | null = null;

/** Install a backend (or none) and return the one it replaced. Internal: the backends and
 * `configureTelemetry` use it; the product does not. */
export function installBackend(next: Backend | null): Backend | null {
  const previous = backend;
  backend = next;
  return previous;
}

/** True once a backend is installed. Use it to skip work that only telemetry needs (building an
 * attribute from a query, say); the calls below are already free when it is false. */
export const telemetryEnabled = (): boolean => backend !== null;

/** Run `fn` inside a span called `name`. `fn` may be synchronous or return a promise: the span ends
 * when it returns or settles, a throw or a rejection is recorded on it and rethrown, and the value
 * comes back unchanged. With no backend this is exactly `fn(NOOP_SPAN)`. */
export function span<T>(
  name: SpanName,
  attrs: SpanAttrs | undefined,
  fn: (span: SpanHandle) => T,
): T {
  const active = backend;
  return active === null ? fn(NOOP_SPAN) : active.span(name, attrs, fn);
}

const counters = new Map<string, Counter<CounterName>>();
const histograms = new Map<string, Histogram<HistogramName>>();
const gauges = new Map<string, Gauge<GaugeName>>();

/** The counter called `name` in the catalog. The handle is cheap and may be created at module scope,
 * before telemetry is configured: it looks the backend up when it is used. */
export function counter<N extends CounterName>(name: N): Counter<N> {
  let handle = counters.get(name);
  if (handle === undefined) {
    handle = {
      add(value, labels) {
        const active = backend;
        if (active !== null) active.count(name, value, labels as RawLabels);
      },
    } as Counter<CounterName>;
    counters.set(name, handle);
  }
  return handle as unknown as Counter<N>;
}

export function histogram<N extends HistogramName>(name: N): Histogram<N> {
  let handle = histograms.get(name);
  if (handle === undefined) {
    handle = {
      record(value, labels) {
        const active = backend;
        if (active !== null) active.record(name, value, labels as RawLabels);
      },
    } as Histogram<HistogramName>;
    histograms.set(name, handle);
  }
  return handle as unknown as Histogram<N>;
}

/** A gauge keeps the last value set for each label combination and reports it at every export. */
export function gauge<N extends GaugeName>(name: N): Gauge<N> {
  let handle = gauges.get(name);
  if (handle === undefined) {
    handle = {
      set(value, labels) {
        const active = backend;
        if (active !== null) active.set(name, value, labels as RawLabels);
      },
    } as Gauge<GaugeName>;
    gauges.set(name, handle);
  }
  return handle as unknown as Gauge<N>;
}

/** Start a clock. The function it returns gives the seconds elapsed since, so the result goes
 * straight into a histogram: `const done = stopwatch(); ...; histogram("commit.duration").record(done(), labels)`. */
export function stopwatch(): () => number {
  const started = performance.now();
  return () => (performance.now() - started) / 1000;
}

/** The `traceparent` header value for the current span, to put on an outgoing request or to store
 * with a queued job so its work continues the trace. Undefined outside a span or with no backend. */
export function traceparent(): string | undefined {
  return backend?.traceparent();
}

/** Run `fn` as part of the trace an incoming `traceparent` header names (W3C Trace Context). A
 * missing or malformed header starts a new trace. With no backend this is `fn()`. */
export function withTraceparent<T>(header: string | null | undefined, fn: () => T): T {
  const active = backend;
  return active === null ? fn() : active.withTraceparent(header, fn);
}

/** Send whatever is buffered. Resolves when done or after `timeoutMs`; never rejects. */
export function flushTelemetry(timeoutMs = 2000): Promise<void> {
  return backend?.flush(timeoutMs) ?? Promise.resolve();
}

/** Flush and stop exporting. Call it when the process is told to stop. Never rejects. */
export async function shutdownTelemetry(timeoutMs = 2000): Promise<void> {
  const active = installBackend(null);
  if (active) await active.shutdown(timeoutMs);
}

const OFF: TelemetryStatus = Object.freeze({
  enabled: false,
  exports: {
    traces: { ok: 0, failed: 0, dropped: 0 },
    metrics: { ok: 0, failed: 0, dropped: 0 },
  },
  dropped: { traces: 0, metrics: 0 },
  queued: 0,
  consecutiveFailures: { traces: 0, metrics: 0 },
  lastSuccessAt: null,
  invalid: 0,
});

/** How telemetry's own sending is going; `enabled: false` and zeros when it is off. */
export function telemetryStatus(): TelemetryStatus {
  return backend?.status?.() ?? OFF;
}

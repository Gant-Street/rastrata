/** A backend that keeps everything in memory, for tests. It follows the same contract as the
 * exporting backend (test/contract.test.ts runs one suite against both), so a lane can assert on the
 * telemetry its code emits without a collector. Use it through `recordTelemetry` in testing.ts. */
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  CounterName,
  GaugeName,
  HistogramName,
  MetricName,
  SpanAttributeKey,
  SpanAttributeValue,
  SpanAttrs,
  SpanName,
} from "./catalog.ts";
import type { Backend, RawLabels, SpanHandle } from "./api.ts";
import { describeError, normalizeLabels } from "./normalize.ts";
import { runInSpan, type StartedSpan } from "./span-run.ts";
import {
  formatTraceparent,
  parseTraceparent,
  randomHex,
  type TraceContext,
} from "./traceparent.ts";

export interface RecordedEvent {
  readonly name: string;
  readonly attributes: Readonly<Record<string, SpanAttributeValue>>;
}

export interface RecordedSpan {
  readonly name: SpanName;
  readonly traceId: string;
  readonly spanId: string;
  /** The span this one ran inside, or the remote span of an incoming `traceparent`. */
  readonly parentSpanId: string | undefined;
  /** True when the parent came from a `traceparent` header rather than from this process. */
  readonly remoteParent: boolean;
  readonly attributes: Record<string, SpanAttributeValue>;
  readonly events: RecordedEvent[];
  status: "unset" | "error";
  /** Set by a throw, a rejection or `fail()`: the type and stable code, never the message. */
  error: { type: string; code?: string } | undefined;
  ended: boolean;
  durationMs: number;
}

type Scope = TraceContext & { readonly remote: boolean };

export interface MemoryBackend extends Backend {
  readonly spans: RecordedSpan[];
  /** Data points the catalog refused (a label missing or outside its set with no stand-in). */
  readonly invalid: string[];
  sum(name: CounterName, labels?: Readonly<Record<string, string>>): number;
  values(name: HistogramName, labels?: Readonly<Record<string, string>>): number[];
  last(name: GaugeName, labels?: Readonly<Record<string, string>>): number | undefined;
  /** Every attribute set recorded for a metric. */
  series(name: MetricName): Record<string, string>[];
  reset(): void;
}

const keyOf = (attributes: Record<string, string>) =>
  Object.keys(attributes)
    .sort()
    .map((key) => `${key}=${attributes[key]}`)
    .join(",");

const matches = (
  attributes: Readonly<Record<string, string>>,
  wanted: Readonly<Record<string, string>> | undefined,
) => !wanted || Object.entries(wanted).every(([key, value]) => attributes[key] === value);

export function createMemoryBackend(): MemoryBackend {
  const scope = new AsyncLocalStorage<Scope>();
  const spans: RecordedSpan[] = [];
  const invalid: string[] = [];
  const counters = new Map<
    string,
    Map<string, { attributes: Record<string, string>; value: number }>
  >();
  const histograms = new Map<
    string,
    Map<string, { attributes: Record<string, string>; values: number[] }>
  >();
  const gauges = new Map<
    string,
    Map<string, { attributes: Record<string, string>; value: number }>
  >();

  const point = (name: MetricName, labels: RawLabels) => {
    const attributes = normalizeLabels(name, labels);
    if (attributes === null) invalid.push(`${name}: ${JSON.stringify(labels ?? {})}`);
    return attributes;
  };
  const bucket = <V>(map: Map<string, Map<string, V>>, name: string) => {
    const existing = map.get(name);
    if (existing) return existing;
    const created = new Map<string, V>();
    map.set(name, created);
    return created;
  };

  const startSpan = (name: SpanName, attrs: SpanAttrs | undefined): StartedSpan => {
    const parent = scope.getStore();
    const context: Scope = {
      traceId: parent?.traceId ?? randomHex(16),
      spanId: randomHex(8),
      flags: 1,
      remote: false,
    };
    const record: RecordedSpan = {
      name,
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: parent?.spanId,
      remoteParent: parent?.remote ?? false,
      attributes: {},
      events: [],
      status: "unset",
      error: undefined,
      ended: false,
      durationMs: 0,
    };
    const started = performance.now();
    const set = (key: SpanAttributeKey, value: SpanAttributeValue | undefined) => {
      if (value !== undefined) record.attributes[key] = value;
    };
    const setAll = (values: SpanAttrs | undefined) => {
      if (values)
        for (const [key, value] of Object.entries(values)) set(key as SpanAttributeKey, value);
    };
    setAll(attrs);
    let failedWith: unknown;
    const handle: SpanHandle = {
      setAttribute: set,
      setAttributes: setAll,
      addEvent(eventName, eventAttrs) {
        const attributes: Record<string, SpanAttributeValue> = {};
        for (const [key, value] of Object.entries(eventAttrs ?? {}))
          if (value !== undefined) attributes[key] = value;
        record.events.push({ name: eventName, attributes });
      },
      fail(error) {
        if (failedWith === error && record.status === "error") return;
        failedWith = error;
        record.status = "error";
        record.error = describeError(error);
      },
    };
    return {
      handle,
      run: (fn) => scope.run(context, fn),
      end() {
        if (record.ended) return;
        record.ended = true;
        record.durationMs = performance.now() - started;
        spans.push(record);
      },
    };
  };

  return {
    spans,
    invalid,
    span: (name, attrs, fn) => runInSpan(startSpan(name, attrs), fn),
    count(name, value, labels) {
      // A counter only goes up, and a number that is not one is not a measurement.
      if (!(value >= 0) || !Number.isFinite(value)) return;
      const attributes = point(name, labels);
      if (attributes === null) return;
      const series = bucket(counters, name);
      const key = keyOf(attributes);
      const entry = series.get(key);
      if (entry) entry.value += value;
      else series.set(key, { attributes, value });
    },
    record(name, value, labels) {
      if (!Number.isFinite(value)) return;
      const attributes = point(name, labels);
      if (attributes === null) return;
      const series = bucket(histograms, name);
      const key = keyOf(attributes);
      const entry = series.get(key);
      if (entry) entry.values.push(value);
      else series.set(key, { attributes, values: [value] });
    },
    set(name, value, labels) {
      if (!Number.isFinite(value)) return;
      const attributes = point(name, labels);
      if (attributes === null) return;
      bucket(gauges, name).set(keyOf(attributes), { attributes, value });
    },
    traceparent() {
      const current = scope.getStore();
      return current ? formatTraceparent(current) : undefined;
    },
    withTraceparent(header, fn) {
      const parsed = parseTraceparent(header);
      return parsed ? scope.run({ ...parsed, remote: true }, fn) : fn();
    },
    async flush() {},
    async shutdown() {},
    sum(name, labels) {
      let total = 0;
      for (const entry of counters.get(name)?.values() ?? [])
        if (matches(entry.attributes, labels)) total += entry.value;
      return total;
    },
    values(name, labels) {
      const out: number[] = [];
      for (const entry of histograms.get(name)?.values() ?? [])
        if (matches(entry.attributes, labels)) out.push(...entry.values);
      return out;
    },
    last(name, labels) {
      let found: number | undefined;
      for (const entry of gauges.get(name)?.values() ?? [])
        if (matches(entry.attributes, labels)) found = entry.value;
      return found;
    },
    series(name) {
      return [
        ...(counters.get(name)?.values() ?? []),
        ...(histograms.get(name)?.values() ?? []),
        ...(gauges.get(name)?.values() ?? []),
      ].map((entry) => entry.attributes);
    },
    reset() {
      spans.length = 0;
      invalid.length = 0;
      counters.clear();
      histograms.clear();
      gauges.clear();
    },
  };
}

/** A recorder over the exporting backend, for the shared contract suite: the SDK is real, only the
 * two exporters are replaced by ones that keep what they are given. */
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import {
  AggregationTemporality,
  type PushMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { installBackend } from "../../src/api.ts";
import type { BackingOffExporter } from "../../src/batch.ts";
import type { SpanAttributeValue } from "../../src/catalog.ts";
import type { TelemetryConfig } from "../../src/config.ts";
import { type SdkBackend, createSdkBackend } from "../../src/sdk.ts";
import type { RecordedSpan } from "../../src/testing.ts";
import type { ContractRecorder } from "../contract.ts";

export const testConfig = (overrides: Partial<TelemetryConfig> = {}): TelemetryConfig => ({
  tracesUrl: "http://127.0.0.1:1/v1/traces",
  metricsUrl: "http://127.0.0.1:1/v1/metrics",
  headers: {},
  serviceName: "test",
  resourceAttributes: { "service.name": "test" },
  sampleRate: 1,
  slowMs: 60_000,
  metricsIntervalMs: 3_600_000,
  flushMs: 1_000,
  compression: "none",
  timeoutMs: 1_000,
  errorMessages: false,
  dumpFile: undefined,
  runtimeSampleMs: 60_000,
  ...overrides,
});

const hr = (time: readonly [number, number]) => time[0] * 1_000 + time[1] / 1e6;

export function toRecorded(span: ReadableSpan): RecordedSpan {
  const parent = span.parentSpanContext;
  const error = span.status.code === SpanStatusCode.ERROR;
  const type = span.attributes["exception.type"];
  const code = span.attributes["error.code"];
  return {
    name: span.name as RecordedSpan["name"],
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    parentSpanId: parent?.spanId,
    remoteParent: parent?.isRemote === true,
    attributes: Object.fromEntries(
      Object.entries(span.attributes).filter(
        ([key]) => key !== "exception.type" && key !== "error.code",
      ),
    ) as Record<string, SpanAttributeValue>,
    events: span.events
      .filter((event) => event.name !== "exception")
      .map((event) => ({
        name: event.name,
        attributes: (event.attributes ?? {}) as Record<string, SpanAttributeValue>,
      })),
    status: error ? "error" : "unset",
    error: error
      ? { type: String(type), ...(typeof code === "string" ? { code } : {}) }
      : undefined,
    ended: span.ended,
    durationMs: hr(span.duration),
  };
}

export interface SdkRecorder extends ContractRecorder {
  readonly backend: SdkBackend;
  readonly rawSpans: ReadableSpan[];
  latestMetrics(): ResourceMetrics | undefined;
}

export function sdkRecorder(config: Partial<TelemetryConfig> = {}): SdkRecorder {
  const spans: ReadableSpan[] = [];
  let latest: ResourceMetrics | undefined;
  const spanExporter: BackingOffExporter = {
    export(batch: ReadableSpan[], done: (result: ExportResult) => void) {
      spans.push(...batch);
      done({ code: ExportResultCode.SUCCESS });
    },
    shutdown: async () => {},
    forceFlush: async () => {},
  };
  const metricExporter: PushMetricExporter = {
    export(metrics: ResourceMetrics, done: (result: ExportResult) => void) {
      latest = metrics;
      done({ code: ExportResultCode.SUCCESS });
    },
    selectAggregationTemporality: () => AggregationTemporality.CUMULATIVE,
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  const backend = createSdkBackend({ config: testConfig(config), spanExporter, metricExporter });
  const previous = installBackend(backend);

  const points = (name: string) => {
    // biome-ignore lint/suspicious/noExplicitAny: a counter's value is a number, a histogram's an object
    const out: { attributes: Record<string, string>; value: any }[] = [];
    for (const scope of latest?.scopeMetrics ?? [])
      for (const metric of scope.metrics)
        if (metric.descriptor.name === `rastrata.${name}`)
          for (const point of metric.dataPoints)
            out.push({
              attributes: point.attributes as Record<string, string>,
              value: point.value,
            });
    return out;
  };
  const matching = (name: string, labels?: Readonly<Record<string, string>>) =>
    points(name).filter(
      (point) =>
        !labels || Object.entries(labels).every(([key, value]) => point.attributes[key] === value),
    );

  const recorder: SdkRecorder = {
    backend,
    rawSpans: spans,
    latestMetrics: () => latest,
    get spans() {
      return spans.map(toRecorded);
    },
    get invalid() {
      return Array.from({ length: backend.status().invalid }, () => "refused");
    },
    async finished() {
      await backend.flush(2_000);
      return spans.map(toRecorded);
    },
    async settle() {
      await backend.flush(2_000);
    },
    spansNamed: (name) => spans.map(toRecorded).filter((span) => span.name === name),
    sum: (name, labels) =>
      matching(name.replace(/^rastrata\./, ""), labels).reduce(
        (total, point) => total + Number(point.value),
        0,
      ),
    values: () => {
      throw new Error("an exporting backend keeps buckets, not the values");
    },
    stats(name, labels) {
      const found = matching(name.replace(/^rastrata\./, ""), labels);
      return {
        count: found.reduce((total, point) => total + Number(point.value.count), 0),
        sum: found.reduce((total, point) => total + Number(point.value.sum), 0),
      };
    },
    last(name, labels) {
      const found = matching(name.replace(/^rastrata\./, ""), labels);
      return found.length ? Number(found[found.length - 1]?.value) : undefined;
    },
    series: (name) => points(name.replace(/^rastrata\./, "")).map((point) => point.attributes),
    reset() {
      throw new Error("cumulative metrics cannot be reset");
    },
    stop() {
      installBackend(previous);
      void backend.shutdown(200);
    },
  };
  return recorder;
}

export { SpanKind };

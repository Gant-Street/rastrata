/** @rastrata/telemetry: the product's window on its own cost and speed.
 *
 *   import { span, counter, histogram, gauge, stopwatch, sizeBucket } from "@rastrata/telemetry";
 *
 *   await span("booklog.commit", { seq: next, "book.id": bookId }, async (s) => {
 *     const done = stopwatch();
 *     const result = await putCreateOnly(key, bytes);
 *     histogram("commit.duration").record(done(), { size_bucket: sizeBucket(next) });
 *     if (result === "conflict") counter("commit.conflicts").add(1, { size_bucket: sizeBucket(next) });
 *     return result;
 *   });
 *
 * Everything is a no-op until a backend is installed (configureTelemetry from the environment, or
 * recordTelemetry in tests), so importing this costs the local product nothing. The metrics, their
 * units and the labels each may carry are the static catalog in catalog.ts; a label outside it is a
 * type error. See docs/reference/telemetry.md. */
export {
  counter,
  flushTelemetry,
  gauge,
  histogram,
  NOOP_SPAN,
  shutdownTelemetry,
  span,
  stopwatch,
  telemetryEnabled,
  telemetryStatus,
  traceparent,
  withTraceparent,
  type Counter,
  type Gauge,
  type Histogram,
  type SpanHandle,
  type TelemetryStatus,
} from "./api.ts";
export { configureTelemetry, type ConfigureOptions } from "./configure.ts";
export {
  CpuAttribution,
  idleSeconds,
  requestCpu,
  trackPeakMemory,
  trackWork,
  type CpuTicket,
  type PeakMemory,
} from "./runtime.ts";
export type {
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
export {
  outcomeOfStatus,
  r2ClassOf,
  sizeBucket,
  type OperationClass,
  type Outcome,
  type R2Class,
  type R2Operation,
  type SizeBucket,
} from "./labels.ts";
export {
  formatTraceparent,
  parseTraceparent,
  type TraceContext,
} from "./traceparent.ts";

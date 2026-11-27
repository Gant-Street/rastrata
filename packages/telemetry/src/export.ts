/** Sending OTLP/JSON to a collector with `fetch`, in a way that cannot hurt the service.
 *
 * The OpenTelemetry SDK's own OTLP/HTTP exporter uses `node:http`, and under Bun 1.4.2 it ended the
 * process with an uncaught ECONNREFUSED when the collector was down during a flush (see
 * docs/reference/program/hosting/hostobs.md). This transport is built on `fetch`, whose failures are
 * rejected promises that are caught here, and it is built so that nothing it does can slow a request
 * down or grow without bound:
 *
 * - every attempt has a timeout, and so has the whole export;
 * - at most `maxInFlight` requests are outstanding; anything beyond is dropped and counted;
 * - after a failure the transport BACKS OFF (1 s, 2 s, 4 s ... at most 60 s, with jitter, or the
 *   collector's Retry-After): while backing off it does not touch the network at all, it drops and
 *   counts, so a collector that is down costs one cheap probe per interval;
 * - a failure is reported to the caller as a result, never thrown.
 *
 * What was dropped is counted by the caller (`onExport`), and shows as `telemetry.exports` and
 * `telemetry.dropped`, so a silent telemetry outage is itself visible. */
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import { JsonMetricsSerializer, JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import {
  AggregationTemporality,
  type PushMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace";
import type { LabelValue } from "./labels.ts";

export type Signal = LabelValue<"telemetry_signal">;
export type SendResult = "ok" | "failed" | "dropped";
export type DropReason = LabelValue<"drop_reason">;

/** One finished try at sending a batch: what it was and how it went. `items` is the number of spans
 * in a batch of spans, and 1 for a batch of metrics. */
export interface ExportReport {
  readonly signal: Signal;
  readonly result: SendResult;
  readonly reason?: DropReason;
  readonly items: number;
}

export interface TransportOptions {
  readonly signal: Signal;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly compression: "gzip" | "none";
  /** The longest one attempt may take. */
  readonly timeoutMs?: number;
  /** Attempts per batch (one retry after a short pause by default). */
  readonly attempts?: number;
  readonly maxInFlight?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly random?: () => number;
}

const BACKOFF_FIRST_MS = 1_000;
const BACKOFF_LAST_MS = 60_000;
const RETRY_PAUSE_MS = 250;

/** Seconds, or an HTTP date, from a Retry-After header, in milliseconds; undefined if absent or odd. */
export function retryAfterMs(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

async function gzip(body: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([body as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export class FetchTransport {
  private failures = 0;
  private openUntil = 0;
  private closed = false;
  private readonly active = new Set<AbortController>();
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly maxInFlight: number;
  private readonly send_: typeof fetch;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly options: TransportOptions) {
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.attempts = Math.max(1, options.attempts ?? 2);
    this.maxInFlight = Math.max(1, options.maxInFlight ?? 2);
    this.send_ = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /** How long, in milliseconds, before this transport will touch the network again; 0 when it is
   * ready. A caller with a queue waits this long instead of taking batches out of it. */
  backoffMs(): number {
    return Math.max(0, this.openUntil - this.now());
  }

  /** How many failures in a row there have been since the last success. */
  get consecutiveFailures(): number {
    return this.failures;
  }

  private fail(retryAfter: number | undefined): void {
    this.failures += 1;
    const exponential = Math.min(BACKOFF_LAST_MS, BACKOFF_FIRST_MS * 2 ** (this.failures - 1));
    const jittered = exponential * (0.75 + this.random() * 0.5);
    const wait = Math.min(BACKOFF_LAST_MS, Math.max(retryAfter ?? 0, jittered));
    this.openUntil = this.now() + wait;
  }

  /** Send one body. Resolves, never rejects: "ok" when the collector accepted it, "failed" when it
   * was tried and not accepted, "dropped" when it was not tried (backing off, busy, closed). */
  async send(body: Uint8Array): Promise<{ result: SendResult; reason?: DropReason }> {
    if (this.closed) return { result: "dropped", reason: "other" };
    if (this.backoffMs() > 0) return { result: "dropped", reason: "backing_off" };
    if (this.active.size >= this.maxInFlight) return { result: "dropped", reason: "queue_full" };
    const controller = new AbortController();
    this.active.add(controller);
    try {
      const payload =
        this.options.compression === "gzip" && body.byteLength > 1_024 ? await gzip(body) : body;
      const headers: Record<string, string> = {
        ...this.options.headers,
        "content-type": "application/json",
      };
      if (payload !== body) headers["content-encoding"] = "gzip";
      let retryAfter: number | undefined;
      for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
        try {
          const response = await this.send_(this.options.url, {
            method: "POST",
            headers,
            body: payload as BodyInit,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(this.timeoutMs)]),
          });
          // The answer's body is not used; read it away so the connection can be reused.
          await response.arrayBuffer().catch(() => undefined);
          if (response.ok) {
            this.failures = 0;
            this.openUntil = 0;
            return { result: "ok" };
          }
          retryAfter = retryAfterMs(response.headers.get("retry-after"), this.now());
          const transient =
            response.status === 408 || response.status === 429 || response.status >= 500;
          if (!transient) break;
        } catch {
          // Refused, reset, timed out, aborted: all the same to the caller.
          if (controller.signal.aborted) break;
        }
        // A collector that says "come back in a while" is not asked again at once: the backoff below
        // carries its Retry-After, and the next export is the retry.
        if (retryAfter !== undefined && retryAfter > 1_000) break;
        if (attempt < this.attempts) await delay(retryAfter ?? RETRY_PAUSE_MS, controller.signal);
      }
      this.fail(retryAfter);
      return { result: "failed", reason: "export_failed" };
    } finally {
      this.active.delete(controller);
    }
  }

  /** Stop accepting batches; wait up to `deadlineMs` for those in flight, then abort them. */
  async close(deadlineMs: number): Promise<void> {
    this.closed = true;
    const until = this.now() + deadlineMs;
    while (this.active.size > 0 && this.now() < until) await new Promise((r) => setTimeout(r, 10));
    for (const controller of this.active) controller.abort();
  }
}

/** A callback told how each batch went. Never throws into the exporter. */
export type ReportExport = (report: ExportReport) => void;

function safely(report: ReportExport | undefined, value: ExportReport): void {
  try {
    report?.(value);
  } catch {
    // Counting what was sent must not be able to break sending it.
  }
}

/** Exports spans as OTLP/JSON. `backoffMs` lets the batching processor leave its queue alone while
 * the collector is down. */
export class FetchSpanExporter implements SpanExporter {
  constructor(
    private readonly transport: FetchTransport,
    private readonly report?: ReportExport,
  ) {}

  backoffMs(): number {
    return this.transport.backoffMs();
  }

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    let body: Uint8Array | undefined;
    try {
      body = JsonTraceSerializer.serializeRequest(spans);
    } catch {
      body = undefined;
    }
    if (!body) {
      safely(this.report, {
        signal: "traces",
        result: "failed",
        reason: "export_failed",
        items: spans.length,
      });
      done({ code: ExportResultCode.FAILED });
      return;
    }
    void this.transport.send(body).then(({ result, reason }) => {
      safely(this.report, {
        signal: "traces",
        result,
        ...(reason ? { reason } : {}),
        items: spans.length,
      });
      done({ code: result === "ok" ? ExportResultCode.SUCCESS : ExportResultCode.FAILED });
    });
  }

  async shutdown(deadlineMs = 2_000): Promise<void> {
    await this.transport.close(deadlineMs);
  }

  async forceFlush(): Promise<void> {}
}

/** Exports metrics as OTLP/JSON, cumulative. When `dump` is given, every export is also appended to
 * that sink as one JSON line: the dump the cost report reads. Metrics are cumulative, so an export
 * that is dropped loses nothing but resolution: the next one carries the totals. */
export class FetchMetricExporter implements PushMetricExporter {
  constructor(
    private readonly transport: FetchTransport,
    private readonly report?: ReportExport,
    private readonly dump?: (line: string) => void,
  ) {}

  selectAggregationTemporality(): AggregationTemporality {
    return AggregationTemporality.CUMULATIVE;
  }

  export(metrics: ResourceMetrics, done: (result: ExportResult) => void): void {
    let body: Uint8Array | undefined;
    try {
      body = JsonMetricsSerializer.serializeRequest(metrics);
    } catch {
      body = undefined;
    }
    if (!body) {
      safely(this.report, {
        signal: "metrics",
        result: "failed",
        reason: "export_failed",
        items: 1,
      });
      done({ code: ExportResultCode.FAILED });
      return;
    }
    if (this.dump) {
      try {
        this.dump(new TextDecoder().decode(body));
      } catch {
        // A full disk must not stop metrics from being sent.
      }
    }
    void this.transport.send(body).then(({ result, reason }) => {
      safely(this.report, { signal: "metrics", result, ...(reason ? { reason } : {}), items: 1 });
      done({ code: result === "ok" ? ExportResultCode.SUCCESS : ExportResultCode.FAILED });
    });
  }

  async forceFlush(): Promise<void> {}

  async shutdown(deadlineMs = 2_000): Promise<void> {
    await this.transport.close(deadlineMs);
  }
}

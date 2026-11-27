/** Tail sampling: decide what to keep after a request is over, so that errors and slow requests are
 * ALWAYS kept and the rest are kept at a low rate.
 *
 * A head sampler decides before the request runs and cannot know it will fail or be slow. This one
 * buffers a trace's finished spans in memory until the trace's local root (the span that has no
 * parent, or a parent in another process) ends, then decides once for the whole trace:
 *
 *   an error anywhere in it           kept
 *   the root took `slowMs` or more    kept
 *   the caller asked for it (W3C trace-flags sampled)   kept
 *   a hash of the trace id under `rate`                 kept   (deterministic: every process that
 *                                                              sees the trace decides the same way)
 *   anything else                     dropped
 *
 * Memory is bounded: at most `maxTraces` traces are buffered at once and `maxSpansPerTrace` spans in
 * each, the oldest buffer is thrown away when the limit is reached, and a buffer whose root never
 * ended is thrown away after `maxAgeMs`. What is thrown away is counted (`onDrop`). A span that
 * ends after its trace was decided follows the decision, except that an error is always kept. */
import { SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace";
import type { Context } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/sdk-trace";
import type { DropReason } from "./export.ts";
import type { LabelValue } from "./labels.ts";

export type SamplingDecision = LabelValue<"sampling_decision">;

export interface SamplingOptions {
  /** The share of ordinary traces kept, 0 to 1. */
  readonly rate: number;
  /** A trace whose root took this long, in milliseconds, is kept. */
  readonly slowMs: number;
  readonly maxTraces?: number;
  readonly maxSpansPerTrace?: number;
  readonly maxAgeMs?: number;
  readonly onDecision: (decision: SamplingDecision) => void;
  readonly onDrop: (items: number, reason: DropReason) => void;
  readonly now?: () => number;
}

interface Buffer {
  spans: ReadableSpan[];
  readonly since: number;
  error: boolean;
}

const hrToMs = (time: readonly [number, number]) => time[0] * 1_000 + time[1] / 1e6;

/** Whether a trace id falls inside the sampled fraction: the last 8 hex digits as a number in [0, 1). */
export function inRatio(traceId: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return Number.parseInt(traceId.slice(-8), 16) / 0x1_0000_0000 < rate;
}

export class TailSamplingProcessor implements SpanProcessor {
  private readonly buffers = new Map<string, Buffer>();
  private readonly decided = new Map<string, boolean>();
  private readonly maxTraces: number;
  private readonly maxSpans: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly next: SpanProcessor,
    private readonly options: SamplingOptions,
  ) {
    this.maxTraces = options.maxTraces ?? 1_000;
    this.maxSpans = options.maxSpansPerTrace ?? 256;
    this.maxAgeMs = options.maxAgeMs ?? 120_000;
    this.now = options.now ?? Date.now;
    this.sweeper = setInterval(() => this.sweep(), Math.max(1_000, this.maxAgeMs / 4));
    (this.sweeper as { unref?: () => void }).unref?.();
  }

  /** Traces buffered now. */
  get buffered(): number {
    return this.buffers.size;
  }

  onStart(_span: Span, _context: Context): void {}

  onEnd(span: ReadableSpan): void {
    const traceId = span.spanContext().traceId;
    const failed = span.status.code === SpanStatusCode.ERROR;
    const parent = span.parentSpanContext;
    const isRoot = parent === undefined || parent.isRemote === true;
    const known = this.decided.get(traceId);
    if (known !== undefined && !isRoot && !this.buffers.has(traceId)) {
      // The trace was decided before this span ended; it follows, but an error is never lost. A
      // span that is itself a local root starts a decision of its own, below.
      if (known || failed) this.next.onEnd(span);
      return;
    }
    let buffer = this.buffers.get(traceId);
    if (!buffer) {
      if (this.buffers.size >= this.maxTraces) this.evictOldest();
      buffer = { spans: [], since: this.now(), error: false };
      this.buffers.set(traceId, buffer);
    }
    if (buffer.spans.length < this.maxSpans) buffer.spans.push(span);
    else {
      // Full. The root is what the trace is about, so it takes the place of the newest other span.
      this.options.onDrop(1, "sampler_buffer");
      if (isRoot) buffer.spans[buffer.spans.length - 1] = span;
    }
    if (failed) buffer.error = true;
    if (isRoot) this.decide(traceId, buffer, span);
  }

  private decide(traceId: string, buffer: Buffer, root: ReadableSpan): void {
    this.buffers.delete(traceId);
    const upstream =
      root.parentSpanContext?.isRemote === true &&
      ((root.parentSpanContext.traceFlags ?? 0) & TraceFlags.SAMPLED) !== 0;
    let decision: SamplingDecision;
    if (buffer.error) decision = "kept_error";
    else if (hrToMs(root.duration) >= this.options.slowMs) decision = "kept_slow";
    else if (upstream) decision = "kept_upstream";
    else if (inRatio(traceId, this.options.rate)) decision = "kept_sampled";
    else decision = "dropped";
    this.options.onDecision(decision);
    this.remember(traceId, decision !== "dropped");
    if (decision === "dropped") return;
    for (const span of buffer.spans) this.next.onEnd(span);
  }

  private remember(traceId: string, kept: boolean): void {
    this.decided.set(traceId, kept);
    if (this.decided.size > 4_096) {
      const oldest = this.decided.keys().next().value;
      if (oldest !== undefined) this.decided.delete(oldest);
    }
  }

  private evictOldest(): void {
    const oldest = this.buffers.entries().next().value;
    if (!oldest) return;
    this.buffers.delete(oldest[0]);
    this.options.onDrop(oldest[1].spans.length, "sampler_buffer");
  }

  /** Throw away buffers whose root never ended. An error in one is kept, because it is the one thing
   * that must not be lost. */
  private sweep(): void {
    const cutoff = this.now() - this.maxAgeMs;
    for (const [traceId, buffer] of this.buffers) {
      if (buffer.since > cutoff) continue;
      this.buffers.delete(traceId);
      if (buffer.error) {
        this.options.onDecision("kept_error");
        for (const span of buffer.spans) this.next.onEnd(span);
      } else this.options.onDrop(buffer.spans.length, "sampler_buffer");
    }
  }

  forceFlush(): Promise<void> {
    return this.next.forceFlush();
  }

  async shutdown(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    // Traces still open at shutdown are undecided; keep the ones that already hold an error.
    for (const [traceId, buffer] of this.buffers) {
      this.buffers.delete(traceId);
      if (buffer.error) for (const span of buffer.spans) this.next.onEnd(span);
      else this.options.onDrop(buffer.spans.length, "sampler_buffer");
    }
    await this.next.shutdown();
  }
}

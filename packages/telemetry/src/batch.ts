/** A span processor that batches finished spans for an exporter, and is bounded in every way a
 * request-serving process needs:
 *
 * - the queue has a fixed size; a span that arrives when it is full is dropped and counted, never
 *   held, so memory cannot grow whatever the collector does;
 * - an export has a timeout of its own, so a stuck exporter cannot stall the queue for ever;
 * - while the exporter says it is backing off (the collector is down) the processor does not take
 *   spans out of the queue, so the spans that fit are still there when it recovers and the rest were
 *   already counted as dropped;
 * - nothing here runs on a request's path except `onEnd`, which pushes onto an array.
 *
 * This replaces the SDK's BatchSpanProcessor, whose queue and drop counts are private, so that "how
 * much telemetry did we lose" is a number the product can export. */
import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace";
import type { DropReason } from "./export.ts";

export interface BatchOptions {
  /** The most spans held waiting to be sent. */
  readonly maxQueue: number;
  /** The most spans in one export. */
  readonly maxBatch: number;
  /** How long spans wait for company before they are sent. */
  readonly delayMs: number;
  /** The longest one export may take, whatever the exporter does. */
  readonly exportTimeoutMs: number;
  readonly onDrop: (items: number, reason: DropReason) => void;
}

/** An exporter that can say how long it will be before it is willing to try again. */
export interface BackingOffExporter extends SpanExporter {
  backoffMs?(): number;
}

export class BoundedBatchProcessor implements SpanProcessor {
  private queue: ReadableSpan[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private draining: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly exporter: BackingOffExporter,
    private readonly options: BatchOptions,
  ) {}

  /** Spans waiting to be sent. */
  get size(): number {
    return this.queue.length;
  }

  onStart(_span: Span, _context: Context): void {}

  onEnd(span: ReadableSpan): void {
    if (this.closed) return;
    if (this.queue.length >= this.options.maxQueue) {
      this.options.onDrop(1, "queue_full");
      return;
    }
    this.queue.push(span);
    // A full batch does not wait out the delay, unless the exporter has asked to be left alone.
    if (this.queue.length >= this.options.maxBatch && this.backoff() === 0) this.schedule(0, true);
    else this.schedule(this.options.delayMs);
  }

  private schedule(ms: number, expedite = false): void {
    if (this.draining || this.closed) return;
    if (this.timer !== undefined) {
      if (!expedite) return;
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, ms);
    // A pending export must never keep a process alive.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private backoff(): number {
    return this.exporter.backoffMs?.() ?? 0;
  }

  /** Send batches until the queue is empty or the exporter asks to be left alone, then arrange the
   * next try if spans are still waiting. */
  private async drain(): Promise<void> {
    if (this.draining) return this.draining;
    const run = this.drainLoop();
    this.draining = run;
    try {
      await run;
    } finally {
      this.draining = undefined;
    }
    if (this.queue.length > 0 && !this.closed) {
      const wait = this.backoff();
      this.schedule(wait > 0 ? Math.min(wait, 5_000) : this.options.delayMs);
    }
  }

  private async drainLoop(): Promise<void> {
    while (this.queue.length > 0 && this.backoff() === 0) {
      await this.exportOne(this.queue.splice(0, this.options.maxBatch));
    }
  }

  private exportOne(batch: ReadableSpan[]): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (failed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // The exporter has already counted what it dropped or failed to send; this only covers an
        // exporter that never answers.
        if (failed) this.options.onDrop(batch.length, "export_failed");
        resolve();
      };
      const timer = setTimeout(() => finish(true), this.options.exportTimeoutMs);
      try {
        this.exporter.export(batch, () => finish(false));
      } catch {
        finish(true);
      }
    });
  }

  /** Send what is queued, giving up when the exporter is backing off. Never rejects. */
  async forceFlush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    try {
      await this.drain();
    } catch {
      // A flush that fails is a flush that sent less.
    }
    // Spans the exporter would not take now (it is backing off) are not kept for later: a flush is a
    // shutdown or a test, and the queue is bounded either way.
    if (this.queue.length > 0 && this.backoff() > 0) {
      this.options.onDrop(this.queue.length, "backing_off");
      this.queue = [];
    }
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.queue.length > 0) {
      this.options.onDrop(this.queue.length, "other");
      this.queue = [];
    }
    try {
      await this.exporter.shutdown();
    } catch {
      // Nothing more can be done.
    }
  }
}

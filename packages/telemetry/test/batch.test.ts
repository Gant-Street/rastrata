import { describe, expect, test } from "bun:test";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { type BackingOffExporter, BoundedBatchProcessor } from "../src/batch.ts";
import type { DropReason } from "../src/export.ts";

const span = (id: number) => ({ name: `s${id}` }) as unknown as ReadableSpan;

function setup(
  exporter: Partial<BackingOffExporter>,
  options: Partial<ConstructorParameters<typeof BoundedBatchProcessor>[1]> = {},
) {
  const drops: { items: number; reason: DropReason }[] = [];
  const processor = new BoundedBatchProcessor(
    {
      export: (_spans: ReadableSpan[], done: (result: ExportResult) => void) =>
        done({ code: ExportResultCode.SUCCESS }),
      shutdown: async () => {},
      ...exporter,
    } as BackingOffExporter,
    {
      maxQueue: 100,
      maxBatch: 10,
      delayMs: 5,
      exportTimeoutMs: 200,
      onDrop: (items, reason) => drops.push({ items, reason }),
      ...options,
    },
  );
  return { processor, drops };
}

describe("the bounded batch processor", () => {
  test("sends spans in batches no bigger than the limit", async () => {
    const batches: number[] = [];
    const { processor, drops } = setup({
      export: (spans: ReadableSpan[], done: (result: ExportResult) => void) => {
        batches.push(spans.length);
        done({ code: ExportResultCode.SUCCESS });
      },
    });
    for (let index = 0; index < 35; index += 1) processor.onEnd(span(index));
    await processor.forceFlush();
    expect(batches.reduce((a, b) => a + b, 0)).toBe(35);
    expect(Math.max(...batches)).toBeLessThanOrEqual(10);
    expect(drops).toEqual([]);
    expect(processor.size).toBe(0);
  });

  test("holds at most maxQueue spans however many arrive, and counts the rest", async () => {
    const release: (() => void)[] = [];
    let released = false;
    const { processor, drops } = setup({
      // An exporter that is stuck: it never answers until released.
      export: (_spans: ReadableSpan[], done: (result: ExportResult) => void) => {
        if (released) done({ code: ExportResultCode.SUCCESS });
        else release.push(() => done({ code: ExportResultCode.SUCCESS }));
      },
    });
    for (let index = 0; index < 5_000; index += 1) processor.onEnd(span(index));
    await Bun.sleep(30);
    // One batch of 10 is in the stuck exporter; the queue holds what fits and no more.
    expect(processor.size).toBeLessThanOrEqual(100);
    const lost = drops
      .filter((item) => item.reason === "queue_full")
      .reduce((sum, item) => sum + item.items, 0);
    expect(lost).toBeGreaterThanOrEqual(5_000 - 100 - 10);
    released = true;
    for (const free of release) free();
    await processor.forceFlush();
    expect(processor.size).toBe(0);
  });

  test("a call to onEnd takes microseconds and never waits for the exporter", () => {
    const { processor } = setup({
      export: () => {
        // Never answers.
      },
    });
    const started = performance.now();
    for (let index = 0; index < 50_000; index += 1) processor.onEnd(span(index));
    // 50,000 calls, most of them drops.
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("an exporter that never answers is given up on after the export timeout", async () => {
    let calls = 0;
    const { processor, drops } = setup(
      {
        export: () => {
          calls += 1;
        },
      },
      { exportTimeoutMs: 40 },
    );
    for (let index = 0; index < 25; index += 1) processor.onEnd(span(index));
    await processor.forceFlush();
    expect(calls).toBe(3);
    expect(
      drops
        .filter((item) => item.reason === "export_failed")
        .reduce((sum, item) => sum + item.items, 0),
    ).toBe(25);
  });

  test("an exporter that throws loses the batch and nothing else", async () => {
    let calls = 0;
    const { processor, drops } = setup({
      export: () => {
        calls += 1;
        throw new Error("boom");
      },
    });
    for (let index = 0; index < 12; index += 1) processor.onEnd(span(index));
    await processor.forceFlush();
    expect(calls).toBe(2);
    expect(drops.reduce((sum, item) => sum + item.items, 0)).toBe(12);
  });

  test("while the exporter is backing off the queue is left alone, and flush counts what it cannot send", async () => {
    let backoff = 10_000;
    let sent = 0;
    const { processor, drops } = setup({
      backoffMs: () => backoff,
      export: (spans: ReadableSpan[], done: (result: ExportResult) => void) => {
        sent += spans.length;
        done({ code: ExportResultCode.SUCCESS });
      },
    });
    for (let index = 0; index < 30; index += 1) processor.onEnd(span(index));
    await Bun.sleep(40);
    expect(sent).toBe(0);
    expect(processor.size).toBe(30);
    // The collector comes back: the next scheduled drain sends them.
    backoff = 0;
    await processor.forceFlush();
    expect(sent).toBe(30);
    expect(drops).toEqual([]);
    // Backing off again at the end: a flush drops and counts instead of holding on.
    backoff = 10_000;
    for (let index = 0; index < 7; index += 1) processor.onEnd(span(index));
    await processor.forceFlush();
    expect(drops).toEqual([{ items: 7, reason: "backing_off" }]);
    expect(processor.size).toBe(0);
  });

  test("shutdown flushes, stops taking spans and shuts the exporter", async () => {
    let shutDown = 0;
    let sent = 0;
    const { processor } = setup({
      shutdown: async () => {
        shutDown += 1;
      },
      export: (spans: ReadableSpan[], done: (result: ExportResult) => void) => {
        sent += spans.length;
        done({ code: ExportResultCode.SUCCESS });
      },
    });
    for (let index = 0; index < 8; index += 1) processor.onEnd(span(index));
    await processor.shutdown();
    expect(sent).toBe(8);
    expect(shutDown).toBe(1);
    processor.onEnd(span(99));
    expect(processor.size).toBe(0);
  });
});

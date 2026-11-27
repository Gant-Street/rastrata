import { describe, expect, test } from "bun:test";
import { ROOT_CONTEXT, SpanStatusCode, TraceFlags, trace } from "@opentelemetry/api";
import {
  AlwaysOnSampler,
  type ReadableSpan,
  type SpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import type { DropReason } from "../src/export.ts";
import { type SamplingDecision, TailSamplingProcessor, inRatio } from "../src/sampling.ts";
import { randomHex } from "../src/traceparent.ts";

function setup(options: {
  rate: number;
  slowMs: number;
  maxTraces?: number;
  maxSpansPerTrace?: number;
  maxAgeMs?: number;
  now?: () => number;
}) {
  const kept: ReadableSpan[] = [];
  const decisions: SamplingDecision[] = [];
  const drops: { items: number; reason: DropReason }[] = [];
  const next: SpanProcessor = {
    onStart() {},
    onEnd: (span) => kept.push(span),
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  const sampler = new TailSamplingProcessor(next, {
    ...options,
    onDecision: (decision) => decisions.push(decision),
    onDrop: (items, reason) => drops.push({ items, reason }),
  });
  const provider = new TracerProvider({
    sampler: new AlwaysOnSampler(),
    spanProcessors: [sampler],
  });
  const tracer = provider.getTracer("test");
  /** A trace of a root and two children, which fails or takes a given time. */
  const request = (
    shape: { error?: boolean; wait?: number; remote?: { sampled: boolean } } = {},
  ) => {
    const parent = shape.remote
      ? trace.setSpanContext(ROOT_CONTEXT, {
          traceId: randomHex(16),
          spanId: randomHex(8),
          traceFlags: shape.remote.sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
          isRemote: true,
        })
      : ROOT_CONTEXT;
    const root = tracer.startSpan("root", {}, parent);
    const context = trace.setSpan(parent, root);
    const a = tracer.startSpan("a", {}, context);
    a.end();
    const b = tracer.startSpan("b", {}, context);
    if (shape.error) b.setStatus({ code: SpanStatusCode.ERROR });
    b.end();
    if (shape.wait) {
      const until = performance.now() + shape.wait;
      while (performance.now() < until);
    }
    root.end();
    return root.spanContext().traceId;
  };
  return { sampler, provider, kept, decisions, drops, request };
}

const names = (spans: ReadableSpan[]) => spans.map((span) => span.name).sort();

describe("tail sampling", () => {
  test("an error anywhere in a trace keeps the whole trace, at a rate of zero", () => {
    const { kept, decisions, request } = setup({ rate: 0, slowMs: 1000 });
    request({ error: true });
    expect(names(kept)).toEqual(["a", "b", "root"]);
    expect(decisions).toEqual(["kept_error"]);
  });

  test("a slow request is kept, a fast one is not", () => {
    const { kept, decisions, request } = setup({ rate: 0, slowMs: 20 });
    request({ wait: 30 });
    request();
    expect(decisions).toEqual(["kept_slow", "dropped"]);
    expect(names(kept)).toEqual(["a", "b", "root"]);
  });

  test("a rate of one keeps everything and a rate of zero keeps nothing that is neither slow nor failed", () => {
    const all = setup({ rate: 1, slowMs: 60_000 });
    for (let index = 0; index < 20; index += 1) all.request();
    expect(all.kept).toHaveLength(60);
    expect(new Set(all.decisions)).toEqual(new Set(["kept_sampled"]));
    const none = setup({ rate: 0, slowMs: 60_000 });
    for (let index = 0; index < 20; index += 1) none.request();
    expect(none.kept).toHaveLength(0);
    expect(new Set(none.decisions)).toEqual(new Set(["dropped"]));
  });

  test("keeps about the rate asked for, by a hash of the trace id", () => {
    const { decisions, request } = setup({ rate: 0.1, slowMs: 60_000 });
    for (let index = 0; index < 3_000; index += 1) request();
    const keptShare = decisions.filter((item) => item === "kept_sampled").length / 3_000;
    expect(keptShare).toBeGreaterThan(0.07);
    expect(keptShare).toBeLessThan(0.13);
  });

  test("the decision for a trace id is the same everywhere: it is a function of the id", () => {
    const ids = Array.from({ length: 200 }, () => randomHex(16));
    for (const id of ids) expect(inRatio(id, 0.3)).toBe(inRatio(id, 0.3));
    // Raising the rate only adds traces: nothing kept at 0.1 is dropped at 0.3.
    for (const id of ids) if (inRatio(id, 0.1)) expect(inRatio(id, 0.3)).toBe(true);
    expect(inRatio("f".repeat(32), 0.999)).toBe(false);
    expect(inRatio("0".repeat(32), 0.001)).toBe(true);
    expect(inRatio("a".repeat(32), 1)).toBe(true);
    expect(inRatio("a".repeat(32), 0)).toBe(false);
  });

  test("a caller that sampled the trace upstream gets it kept", () => {
    const { decisions, kept, request } = setup({ rate: 0, slowMs: 60_000 });
    request({ remote: { sampled: true } });
    request({ remote: { sampled: false } });
    expect(decisions).toEqual(["kept_upstream", "dropped"]);
    expect(kept).toHaveLength(3);
    // The root of a continued trace is a local root: the decision was made at its end.
    expect(kept.find((span) => span.name === "root")?.parentSpanContext?.isRemote).toBe(true);
  });

  test("a trace with several roots in one process is decided once per root", () => {
    const { decisions, tracer } = (() => {
      const harness = setup({ rate: 1, slowMs: 60_000 });
      return { decisions: harness.decisions, tracer: harness.provider.getTracer("t") };
    })();
    const remote = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: randomHex(16),
      spanId: randomHex(8),
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });
    tracer.startSpan("first", {}, remote).end();
    tracer.startSpan("second", {}, remote).end();
    expect(decisions).toHaveLength(2);
  });

  test("a span that ends after its trace was decided follows the decision, and an error is never lost", () => {
    const { provider, kept } = setup({ rate: 0, slowMs: 60_000 });
    const tracer = provider.getTracer("late");
    const root = tracer.startSpan("root");
    const context = trace.setSpan(ROOT_CONTEXT, root);
    const straggler = tracer.startSpan("straggler", {}, context);
    const failing = tracer.startSpan("failing", {}, context);
    root.end(); // decided: dropped
    straggler.end();
    expect(kept).toHaveLength(0);
    failing.setStatus({ code: SpanStatusCode.ERROR });
    failing.end();
    expect(names(kept)).toEqual(["failing"]);
  });

  test("a span of a kept trace that ends late is kept with it", () => {
    const { provider, kept } = setup({ rate: 1, slowMs: 60_000 });
    const tracer = provider.getTracer("late");
    const root = tracer.startSpan("root");
    const context = trace.setSpan(ROOT_CONTEXT, root);
    const straggler = tracer.startSpan("straggler", {}, context);
    root.end();
    straggler.end();
    expect(names(kept)).toEqual(["root", "straggler"]);
  });

  test("buffers only so many traces, drops the oldest first, and counts them", () => {
    const { provider, kept, drops } = setup({ rate: 1, slowMs: 60_000, maxTraces: 5 });
    const tracer = provider.getTracer("overflow");
    const open: ReturnType<typeof tracer.startSpan>[] = [];
    // Eight traces whose roots have not ended, each with a finished child: they sit in the buffer.
    for (let index = 0; index < 8; index += 1) {
      const root = tracer.startSpan(`root${index}`);
      tracer.startSpan("child", {}, trace.setSpan(ROOT_CONTEXT, root)).end();
      open.push(root);
    }
    const lost = () =>
      drops
        .filter((item) => item.reason === "sampler_buffer")
        .reduce((sum, item) => sum + item.items, 0);
    expect(lost()).toBe(3);
    for (const root of open) root.end();
    // The first three lost their child. Ending their roots needs room for a buffer again, which
    // pushes out the oldest of the five that were kept (one more child lost), so four children
    // survive. Every root is decided and kept, and every loss was counted.
    expect(kept.filter((span) => span.name === "child")).toHaveLength(4);
    expect(kept.filter((span) => span.name.startsWith("root"))).toHaveLength(8);
    expect(lost()).toBe(4);
  });

  test("holds only so many spans of one trace, counts the rest, and always keeps the root", () => {
    const { provider, kept, drops } = setup({ rate: 1, slowMs: 60_000, maxSpansPerTrace: 4 });
    const tracer = provider.getTracer("wide");
    const root = tracer.startSpan("root");
    const context = trace.setSpan(ROOT_CONTEXT, root);
    for (let index = 0; index < 10; index += 1) tracer.startSpan("leaf", {}, context).end();
    root.end();
    expect(names(kept)).toEqual(["leaf", "leaf", "leaf", "root"]);
    // Six leaves did not fit, and the root took the place of a seventh.
    expect(
      drops
        .filter((item) => item.reason === "sampler_buffer")
        .reduce((sum, item) => sum + item.items, 0),
    ).toBe(7);
  });

  test("a trace whose root never ends is thrown away after its age, unless it holds an error", async () => {
    let now = 1_000_000;
    const { provider, kept, drops, sampler } = setup({
      rate: 1,
      slowMs: 60_000,
      maxAgeMs: 1_000,
      now: () => now,
    });
    const tracer = provider.getTracer("leak");
    const quiet = tracer.startSpan("quiet-root");
    tracer.startSpan("quiet-child", {}, trace.setSpan(ROOT_CONTEXT, quiet)).end();
    const loud = tracer.startSpan("loud-root");
    const bad = tracer.startSpan("loud-child", {}, trace.setSpan(ROOT_CONTEXT, loud));
    bad.setStatus({ code: SpanStatusCode.ERROR });
    bad.end();
    expect(sampler.buffered).toBe(2);
    now += 2_000;
    // The sweeper runs on a timer; call what it calls through a shutdown-free path by waiting for it.
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(sampler.buffered).toBe(0);
    expect(names(kept)).toEqual(["loud-child"]);
    expect(drops.some((item) => item.reason === "sampler_buffer" && item.items === 1)).toBe(true);
  });

  test("at shutdown the open traces are dropped but the ones with an error are kept", async () => {
    const { provider, kept, sampler } = setup({ rate: 1, slowMs: 60_000 });
    const tracer = provider.getTracer("end");
    const a = tracer.startSpan("a-root");
    tracer.startSpan("a-child", {}, trace.setSpan(ROOT_CONTEXT, a)).end();
    const b = tracer.startSpan("b-root");
    const failing = tracer.startSpan("b-child", {}, trace.setSpan(ROOT_CONTEXT, b));
    failing.setStatus({ code: SpanStatusCode.ERROR });
    failing.end();
    await sampler.shutdown();
    expect(names(kept)).toEqual(["b-child"]);
  });
});

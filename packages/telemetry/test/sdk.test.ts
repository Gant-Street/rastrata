import { afterEach, describe, expect, test } from "bun:test";
import { SpanKind } from "@opentelemetry/api";
import { BUCKETS, METRICS, exportedName } from "../src/catalog.ts";
import { counter, gauge, histogram, span, traceparent, withTraceparent } from "../src/index.ts";
import { type SdkRecorder, sdkRecorder, testConfig } from "./support/sdk-recorder.ts";

let recorder: SdkRecorder | undefined;
afterEach(() => {
  recorder?.stop();
  recorder = undefined;
});

describe("the exporting backend: what the SDK is told", () => {
  test("every span and metric carries the resource that says who sent it", async () => {
    recorder = sdkRecorder({
      resourceAttributes: {
        "service.name": "rastrata-api",
        "service.instance.id": "book-pod-3",
        "deployment.environment.name": "staging",
      },
    });
    span("operation", undefined, () => undefined);
    counter("requests").add(1, { operation_class: "read", outcome: "ok" });
    await recorder.settle();
    const expected = {
      "service.name": "rastrata-api",
      "service.instance.id": "book-pod-3",
      "deployment.environment.name": "staging",
    };
    expect(recorder.rawSpans[0]?.resource.attributes).toMatchObject(expected);
    expect(recorder.latestMetrics()?.resource.attributes).toMatchObject(expected);
  });

  test("a metric's unit, description and bucket boundaries are the catalog's", async () => {
    recorder = sdkRecorder();
    histogram("commit.duration").record(0.04, { size_bucket: "m" });
    counter("r2.bytes").add(10, { direction: "in", object_kind: "log" });
    await recorder.settle();
    const metrics = recorder.latestMetrics()?.scopeMetrics.flatMap((scope) => scope.metrics) ?? [];
    const duration = metrics.find(
      (metric) => metric.descriptor.name === exportedName("commit.duration"),
    );
    expect(duration?.descriptor.unit).toBe("s");
    expect(duration?.descriptor.description).toBe(METRICS["commit.duration"].description);
    const point = duration?.dataPoints[0]?.value as {
      buckets: { boundaries: number[]; counts: number[] };
    };
    expect(point.buckets.boundaries).toEqual([...BUCKETS.tail]);
    // 0.04 falls in the bucket above 0.03 and up to 0.05.
    expect(point.buckets.counts[BUCKETS.tail.indexOf(0.05)]).toBe(1);
    const bytes = metrics.find((metric) => metric.descriptor.name === exportedName("r2.bytes"));
    expect(bytes?.descriptor.unit).toBe("By");
  });

  test("a call out is a CLIENT span, an incoming request a SERVER span, the rest INTERNAL", async () => {
    recorder = sdkRecorder();
    span("http.request", undefined, () => {
      span("r2.put", undefined, () => undefined);
      span("tail.append", undefined, () => undefined);
      span("lease.renew", undefined, () => undefined);
      span("operation", undefined, () => undefined);
    });
    await recorder.settle();
    const kinds = Object.fromEntries(recorder.rawSpans.map((item) => [item.name, item.kind]));
    expect(kinds).toEqual({
      "http.request": SpanKind.SERVER,
      "r2.put": SpanKind.CLIENT,
      "tail.append": SpanKind.CLIENT,
      "lease.renew": SpanKind.CLIENT,
      operation: SpanKind.INTERNAL,
    });
  });

  test("an error is recorded by type and code, with no message unless it is asked for", async () => {
    recorder = sdkRecorder();
    class Conflict extends Error {
      override name = "Conflict";
      code = "plan_hash_conflict";
    }
    expect(() =>
      span("operation", undefined, () => {
        throw new Conflict("memo says: wire to Acme Corp 4417");
      }),
    ).toThrow();
    await recorder.settle();
    const failed = recorder.rawSpans[0];
    expect(failed?.status.code).toBe(2);
    expect(failed?.status.message).toBeUndefined();
    expect(failed?.attributes).toMatchObject({
      "exception.type": "Conflict",
      "error.code": "plan_hash_conflict",
    });
    expect(JSON.stringify([failed?.attributes, failed?.events, failed?.status])).not.toContain(
      "Acme",
    );
    recorder.stop();

    recorder = sdkRecorder({ errorMessages: true });
    expect(() =>
      span("operation", undefined, () => {
        throw new Conflict("short message");
      }),
    ).toThrow();
    await recorder.settle();
    expect(recorder.rawSpans[0]?.status.message).toBe("short message");
  });

  test("attributes are bounded: long text is cut, non-finite numbers and undefined are left out", async () => {
    recorder = sdkRecorder();
    span(
      "operation",
      { operation: "x".repeat(1000), rows: Number.NaN, seq: 5, "x.flag": true },
      (s) => {
        s.setAttribute("bytes", Number.POSITIVE_INFINITY);
        s.setAttribute("entries", undefined);
        s.setAttribute("x.long", "y".repeat(400));
      },
    );
    await recorder.settle();
    const attributes = recorder.rawSpans[0]?.attributes ?? {};
    expect(String(attributes.operation)).toHaveLength(256);
    expect(String(attributes["x.long"])).toHaveLength(256);
    expect(attributes).toMatchObject({ seq: 5, "x.flag": true });
    for (const missing of ["rows", "bytes", "entries"])
      expect(attributes).not.toHaveProperty(missing);
  });

  test("traceparent() is the W3C header of the current span, flagged as sampled", async () => {
    recorder = sdkRecorder();
    expect(traceparent()).toBeUndefined();
    let header: string | undefined;
    span("http.request", undefined, () => {
      header = traceparent();
    });
    await recorder.settle();
    const root = recorder.rawSpans[0]?.spanContext();
    expect(header).toBe(`00-${root?.traceId}-${root?.spanId}-01`);
  });

  test("an incoming traceparent becomes the remote parent, and a bad one starts a new trace", async () => {
    recorder = sdkRecorder();
    const trace = "0af7651916cd43dd8448eb211c80319c";
    withTraceparent(`00-${trace}-b7ad6b7169203331-00`, () =>
      span("http.request", undefined, () => undefined),
    );
    withTraceparent("00-nonsense", () => span("http.request", undefined, () => undefined));
    await recorder.settle();
    const [continued, fresh] = recorder.rawSpans;
    expect(continued?.spanContext().traceId).toBe(trace);
    expect(continued?.parentSpanContext).toMatchObject({
      spanId: "b7ad6b7169203331",
      isRemote: true,
    });
    expect(fresh?.spanContext().traceId).not.toBe(trace);
    expect(fresh?.parentSpanContext).toBeUndefined();
  });

  test("tail sampling is on: at the default rate a fast ordinary request is not exported, an error is", async () => {
    recorder = sdkRecorder({ sampleRate: 0, slowMs: 60_000 });
    span("http.request", undefined, () => span("operation", undefined, () => undefined));
    expect(() =>
      span("http.request", undefined, () =>
        span("operation", undefined, () => {
          throw new Error("x");
        }),
      ),
    ).toThrow();
    await recorder.settle();
    expect(recorder.rawSpans.map((item) => item.name).sort()).toEqual([
      "http.request",
      "operation",
    ]);
    expect(recorder.rawSpans.every((item) => item.status.code === 2)).toBe(true);
    expect(recorder.sum("telemetry.traces", { sampling_decision: "dropped" })).toBe(1);
    expect(recorder.sum("telemetry.traces", { sampling_decision: "kept_error" })).toBe(1);
  });

  test("a gauge that was set once is still reported at the next export", async () => {
    recorder = sdkRecorder();
    gauge("books.resident").set(4, { size_bucket: "s" });
    await recorder.settle();
    await recorder.settle();
    expect(recorder.last("books.resident", { size_bucket: "s" })).toBe(4);
  });

  test("config the tests build is the shape the product reads", () => {
    expect(testConfig().sampleRate).toBe(1);
  });
});

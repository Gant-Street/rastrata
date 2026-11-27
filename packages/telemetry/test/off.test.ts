import { describe, expect, test } from "bun:test";
import {
  NOOP_SPAN,
  counter,
  flushTelemetry,
  gauge,
  histogram,
  shutdownTelemetry,
  span,
  stopwatch,
  telemetryEnabled,
  traceparent,
  withTraceparent,
} from "../src/index.ts";
import { expectWithin } from "./support/budget.ts";

// These run with no backend installed, which is how the local product runs.
describe("with no backend", () => {
  test("is off", () => {
    expect(telemetryEnabled()).toBe(false);
  });

  test("span is exactly fn(NOOP_SPAN): same value, same promise, same error", async () => {
    const seen: unknown[] = [];
    const value = span("operation", { operation: "book.get" }, (s) => {
      seen.push(s);
      return 42;
    });
    expect(value).toBe(42);
    expect(seen[0]).toBe(NOOP_SPAN);

    const promise = Promise.resolve("later");
    expect(span("operation", undefined, () => promise)).toBe(promise);

    const boom = new Error("boom");
    expect(() =>
      span("operation", undefined, () => {
        throw boom;
      }),
    ).toThrow(boom);
    await expect(span("operation", undefined, () => Promise.reject(boom))).rejects.toBe(boom);
  });

  test("the span handle accepts everything and keeps nothing", () => {
    span("operation", undefined, (s) => {
      s.setAttribute("seq", 1);
      s.setAttribute("seq", undefined);
      s.setAttributes({ bytes: 10, "x.anything": true });
      s.addEvent("retry", { attempt: 2 });
      s.fail(new Error("handled"));
    });
    expect(Object.isFrozen(NOOP_SPAN)).toBe(true);
  });

  test("metric calls do nothing and return nothing", () => {
    expect(counter("requests").add(1, { operation_class: "read", outcome: "ok" })).toBeUndefined();
    expect(histogram("commit.duration").record(0.1, { size_bucket: "m" })).toBeUndefined();
    expect(gauge("books.resident").set(3, { size_bucket: "xs" })).toBeUndefined();
    expect(gauge("process.memory.limit").set(1)).toBeUndefined();
  });

  test("handles are shared, so creating one in a loop allocates nothing", () => {
    expect(counter("requests")).toBe(counter("requests"));
    expect(histogram("request.duration")).toBe(histogram("request.duration"));
    expect(gauge("tenants")).toBe(gauge("tenants"));
  });

  test("trace context passes through untouched", () => {
    expect(traceparent()).toBeUndefined();
    expect(
      withTraceparent("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01", () => "ran"),
    ).toBe("ran");
  });

  test("the stopwatch still measures, because callers print it in their own logs", async () => {
    const done = stopwatch();
    await Bun.sleep(5);
    expect(done()).toBeGreaterThan(0.003);
    expect(done()).toBeLessThan(1);
  });

  test("flush and shutdown resolve at once", async () => {
    await flushTelemetry();
    await shutdownTelemetry();
  });

  test("a hot loop of calls costs next to nothing", () => {
    const requests = counter("requests");
    const duration = histogram("request.duration");
    const rounds = 2_000_000;
    const started = performance.now();
    for (let index = 0; index < rounds; index += 1) {
      requests.add(1, { operation_class: "read", outcome: "ok" });
      duration.record(0.001, { operation_class: "read" });
      span("operation", undefined, () => index);
    }
    const nanosecondsEach = ((performance.now() - started) * 1e6) / (rounds * 3);
    // About 3 ns on Apple silicon when quiet; the bound only catches an accidental allocation or
    // lookup on the path.
    expectWithin("an off-state telemetry call", nanosecondsEach, 100, "ns");
  });
});

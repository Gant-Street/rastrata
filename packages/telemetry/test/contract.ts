/** What every backend must do, as one suite. `contract.test.ts` runs it against the in-memory
 * backend; the exporting backend runs the same suite against OpenTelemetry's in-memory exporters
 * (sdk.test.ts), so the fast backend the other lanes test with cannot drift from the real one. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  counter,
  gauge,
  histogram,
  span,
  stopwatch,
  traceparent,
  withTraceparent,
} from "../src/index.ts";
import type { RecordedSpan, Recorder } from "../src/testing.ts";

/** A recorder plus a way to wait for the spans that have ended to be readable. */
export type ContractRecorder = Recorder & {
  finished(): Promise<readonly RecordedSpan[]>;
  /** Wait until what was recorded is readable (an exporting backend has to flush). */
  settle(): Promise<void>;
};

const TRACE = "0af7651916cd43dd8448eb211c80319c";
const REMOTE = "b7ad6b7169203331";

export function defineBackendContract(
  label: string,
  start: () => ContractRecorder | Promise<ContractRecorder>,
): void {
  describe(`${label}: spans`, () => {
    let telemetry: ContractRecorder;
    beforeEach(async () => {
      telemetry = await start();
    });
    afterEach(() => telemetry.stop());

    test("a span records its name, attributes and duration, and returns the value", async () => {
      const value = span(
        "operation",
        { operation: "reports.get", "http.response.status_code": 200 },
        (s) => {
          s.setAttribute("rows", 7);
          s.setAttribute("bytes", undefined);
          return "result";
        },
      );
      expect(value).toBe("result");
      const [recorded] = await telemetry.finished();
      expect(recorded?.name).toBe("operation");
      expect(recorded?.attributes).toEqual({
        operation: "reports.get",
        "http.response.status_code": 200,
        rows: 7,
      });
      expect(recorded?.status).toBe("unset");
      expect(recorded?.durationMs).toBeGreaterThanOrEqual(0);
    });

    test("nested spans are children of the span they run in, and share its trace", async () => {
      await span("http.request", undefined, async () => {
        await span("operation", undefined, async () => {
          await Bun.sleep(1);
          span("ledger.execute", undefined, () => undefined);
        });
        span("read.aggregate", undefined, () => undefined);
      });
      const spans = await telemetry.finished();
      const named = (name: string) => spans.find((item) => item.name === name);
      const root = named("http.request");
      const operation = named("operation");
      const ledger = named("ledger.execute");
      const read = named("read.aggregate");
      expect(root?.parentSpanId).toBeUndefined();
      expect(operation?.parentSpanId).toBe(root?.spanId);
      expect(ledger?.parentSpanId).toBe(operation?.spanId);
      expect(read?.parentSpanId).toBe(root?.spanId);
      expect(new Set(spans.map((item) => item.traceId)).size).toBe(1);
      // Children end before their parents.
      expect(spans.map((item) => item.name)).toEqual([
        "ledger.execute",
        "operation",
        "read.aggregate",
        "http.request",
      ]);
    });

    test("requests that overlap keep their own children", async () => {
      await Promise.all(
        Array.from({ length: 25 }, (_, index) =>
          span("http.request", { "x.index": index }, async () => {
            await Bun.sleep(index % 5);
            await span("operation", { "x.index": index }, async () => {
              await Bun.sleep((index * 7) % 4);
              span("ledger.execute", { "x.index": index }, () => undefined);
            });
          }),
        ),
      );
      const spans = await telemetry.finished();
      expect(spans).toHaveLength(75);
      const byId = new Map(spans.map((item) => [item.spanId, item]));
      for (const item of spans) {
        if (item.name === "http.request") continue;
        const parent = byId.get(item.parentSpanId ?? "");
        expect(parent, `${item.name} has a parent`).toBeDefined();
        expect(parent?.attributes["x.index"]).toBe(item.attributes["x.index"]);
        expect(parent?.traceId).toBe(item.traceId);
      }
    });

    test("a throw is recorded as the error's type and code, never its message, and rethrown", async () => {
      class Refused extends Error {
        override name = "Refused";
        code = "plan_hash_conflict";
      }
      const error = new Refused("memo: Acme Corp wire 4417");
      expect(() =>
        span("operation", undefined, () => {
          throw error;
        }),
      ).toThrow(error);
      const [recorded] = await telemetry.finished();
      expect(recorded?.status).toBe("error");
      expect(recorded?.error).toEqual({ type: "Refused", code: "plan_hash_conflict" });
      expect(JSON.stringify(recorded)).not.toContain("Acme");
    });

    test("a rejection ends the span as an error and rejects with the same error", async () => {
      const error = new TypeError("x");
      await expect(span("operation", undefined, () => Promise.reject(error))).rejects.toBe(error);
      const [recorded] = await telemetry.finished();
      expect(recorded?.status).toBe("error");
      expect(recorded?.error?.type).toBe("TypeError");
    });

    test("an async span ends when the promise settles, not when the function returns", async () => {
      const done = stopwatch();
      await span("operation", undefined, async () => {
        await Bun.sleep(20);
      });
      const [recorded] = await telemetry.finished();
      expect(recorded?.durationMs).toBeGreaterThanOrEqual(15);
      expect(done()).toBeGreaterThanOrEqual(0.015);
    });

    test("fail() marks a handled error without throwing, and failing twice records it once", async () => {
      span("operation", undefined, (s) => {
        s.fail(new RangeError("handled"));
        s.fail(new RangeError("handled again"));
        return 1;
      });
      const [recorded] = await telemetry.finished();
      expect(recorded?.status).toBe("error");
      expect(recorded?.error?.type).toBe("RangeError");
    });

    test("events carry their attributes", async () => {
      span("booklog.commit", undefined, (s) => {
        s.addEvent("retry", { attempt: 2 });
        s.addEvent("conflict");
      });
      const [recorded] = await telemetry.finished();
      expect(recorded?.events.map((event) => event.name)).toEqual(["retry", "conflict"]);
      expect(recorded?.events[0]?.attributes).toEqual({ attempt: 2 });
    });

    test("traceparent() names the current span, and is undefined outside one", async () => {
      expect(traceparent()).toBeUndefined();
      let inside: string | undefined;
      span("http.request", undefined, () => {
        inside = traceparent();
      });
      const [recorded] = await telemetry.finished();
      expect(inside).toBe(`00-${recorded?.traceId}-${recorded?.spanId}-01`);
    });

    test("withTraceparent continues an incoming trace: same trace id, the sender's span as parent", async () => {
      const header = `00-${TRACE}-${REMOTE}-01`;
      const result = withTraceparent(header, () => span("http.request", undefined, () => "inside"));
      expect(result).toBe("inside");
      const [recorded] = await telemetry.finished();
      expect(recorded?.traceId).toBe(TRACE);
      expect(recorded?.parentSpanId).toBe(REMOTE);
      expect(recorded?.remoteParent).toBe(true);
    });

    test("a malformed incoming traceparent starts a new trace instead of failing", async () => {
      for (const header of [undefined, null, "", "nonsense", `00-${"0".repeat(32)}-${REMOTE}-01`]) {
        expect(withTraceparent(header, () => span("http.request", undefined, () => "ok"))).toBe(
          "ok",
        );
      }
      const spans = await telemetry.finished();
      expect(spans).toHaveLength(5);
      for (const item of spans) {
        expect(item.parentSpanId).toBeUndefined();
        expect(item.remoteParent).toBe(false);
      }
      expect(new Set(spans.map((item) => item.traceId)).size).toBe(5);
    });

    test("work started inside a continued trace stays in it across awaits", async () => {
      await withTraceparent(`00-${TRACE}-${REMOTE}-01`, async () => {
        await span("http.request", undefined, async () => {
          await Bun.sleep(2);
          await span("operation", undefined, async () => {
            await Bun.sleep(2);
          });
        });
      });
      const spans = await telemetry.finished();
      expect(spans.map((item) => item.traceId)).toEqual([TRACE, TRACE]);
    });
  });

  describe(`${label}: metrics`, () => {
    let telemetry: ContractRecorder;
    beforeEach(async () => {
      telemetry = await start();
    });
    afterEach(() => telemetry.stop());

    test("a counter sums per label set, and a subset of labels sums over the rest", async () => {
      const requests = counter("requests");
      requests.add(1, { operation_class: "read", outcome: "ok" });
      requests.add(2, { operation_class: "read", outcome: "ok" });
      requests.add(4, { operation_class: "read", outcome: "client_error" });
      requests.add(8, { operation_class: "post", outcome: "ok" });
      await telemetry.settle();
      expect(telemetry.sum("requests", { operation_class: "read", outcome: "ok" })).toBe(3);
      expect(telemetry.sum("requests", { operation_class: "read" })).toBe(7);
      expect(telemetry.sum("requests")).toBe(15);
      expect(telemetry.sum("rastrata.requests", { outcome: "ok" })).toBe(11);
      expect(telemetry.invalid).toEqual([]);
    });

    test("a histogram keeps what was recorded", async () => {
      histogram("commit.duration").record(0.1, { size_bucket: "m" });
      histogram("commit.duration").record(0.3, { size_bucket: "m" });
      histogram("commit.duration").record(9, { size_bucket: "xl" });
      await telemetry.settle();
      const middle = telemetry.stats("commit.duration", { size_bucket: "m" });
      expect(middle.count).toBe(2);
      expect(middle.sum).toBeCloseTo(0.4, 9);
      expect(telemetry.stats("commit.duration").count).toBe(3);
      expect(telemetry.stats("commit.duration").sum).toBeCloseTo(9.4, 9);
    });

    test("a gauge reports the last value set for each label set", async () => {
      gauge("books.resident").set(3, { size_bucket: "xs" });
      gauge("books.resident").set(5, { size_bucket: "xs" });
      gauge("books.resident").set(1, { size_bucket: "xl" });
      gauge("process.memory.limit").set(1073741824);
      await telemetry.settle();
      expect(telemetry.last("books.resident", { size_bucket: "xs" })).toBe(5);
      expect(telemetry.last("books.resident", { size_bucket: "xl" })).toBe(1);
      expect(telemetry.last("books.resident", { size_bucket: "m" })).toBeUndefined();
      expect(telemetry.last("process.memory.limit")).toBe(1073741824);
    });

    test("the R2 price class is derived from the call and cannot be set by the caller", async () => {
      const operations = counter("r2.operations");
      operations.add(1, { r2_op: "put", outcome: "ok" });
      operations.add(1, { r2_op: "put", outcome: "conflict" });
      operations.add(3, { r2_op: "head", outcome: "not_found" });
      operations.add(1, { r2_op: "delete", outcome: "ok" });
      // @ts-expect-error a caller does not get to choose the class
      operations.add(5, { r2_op: "get", outcome: "ok", r2_class: "free" });
      await telemetry.settle();
      expect(telemetry.sum("r2.operations", { r2_class: "A" })).toBe(2);
      expect(telemetry.sum("r2.operations", { r2_class: "B" })).toBe(8);
      expect(telemetry.sum("r2.operations", { r2_class: "free" })).toBe(1);
      expect(telemetry.series("r2.operations").every((labels) => "r2_class" in labels)).toBe(true);
    });

    test("a value outside its set is recorded as other or unknown, and nothing is lost", async () => {
      counter("requests").add(1, { operation_class: "made-up" as never, outcome: "ok" });
      counter("commit.conflicts").add(1, { size_bucket: "gigantic" as never });
      await telemetry.settle();
      expect(telemetry.sum("requests", { operation_class: "other", outcome: "ok" })).toBe(1);
      // commit.conflicts lists only the known sizes and has no stand-in, so the point is refused.
      expect(telemetry.sum("commit.conflicts")).toBe(0);
      expect(telemetry.invalid).toHaveLength(1);
    });

    test("a label that is missing, and one the catalog does not list, are handled", async () => {
      counter("requests").add(1, { outcome: "ok" } as never);
      counter("requests").add(1, { operation_class: "read", outcome: "ok", book: "b-1" } as never);
      await telemetry.settle();
      expect(telemetry.sum("requests", { operation_class: "other", outcome: "ok" })).toBe(1);
      expect(telemetry.sum("requests", { operation_class: "read", outcome: "ok" })).toBe(1);
      for (const labels of telemetry.series("requests"))
        expect(Object.keys(labels).sort()).toEqual(["operation_class", "outcome"]);
    });

    test("the series a metric can make never exceed what the catalog allows, however it is driven", async () => {
      const requests = counter("requests");
      for (let index = 0; index < 500; index += 1)
        requests.add(1, {
          operation_class: `class-${index}` as never,
          outcome: `outcome-${index}` as never,
        });
      await telemetry.settle();
      expect(telemetry.series("requests")).toHaveLength(1);
    });

    test("a value that is not a number, or a counter going down, is ignored", async () => {
      counter("requests").add(Number.NaN, { operation_class: "read", outcome: "ok" });
      counter("requests").add(-3, { operation_class: "read", outcome: "ok" });
      counter("requests").add(1, { operation_class: "read", outcome: "ok" });
      histogram("commit.duration").record(Number.POSITIVE_INFINITY, { size_bucket: "m" });
      await telemetry.settle();
      expect(telemetry.sum("requests")).toBe(1);
      expect(telemetry.stats("commit.duration").count).toBe(0);
    });
  });
}

// Type-level tests: `bun run typecheck` fails when one of the @ts-expect-error lines below stops being
// an error, which is the proof that a label outside the catalog is a compile error. At run time they
// are ordinary calls that do nothing, because no backend is installed.
import { describe, expect, test } from "bun:test";
import { counter, gauge, histogram, span } from "../src/index.ts";

describe("the catalog is enforced by the compiler", () => {
  test("accepts what the catalog lists", () => {
    counter("requests").add(1, { operation_class: "read", outcome: "ok" });
    counter("r2.operations").add(1, { r2_op: "put", outcome: "conflict" });
    counter("process.cpu.time").add(0.5, { cpu_mode: "user" });
    histogram("commit.duration").record(0.2, { size_bucket: "l" });
    histogram("process.event_loop.lag").record(0.001);
    histogram("service.open.duration").record(0.4, {});
    gauge("books.resident").set(3, { size_bucket: "xs" });
    gauge("process.memory.limit").set(2 ** 30);
    span("booklog.commit", { seq: 8, "book.id": "b", "x.experiment": true }, (s) => {
      s.setAttribute("bytes", 12);
      s.addEvent("retry", { attempt: 2 });
    });
    expect(true).toBe(true);
  });

  test("refuses what it does not", () => {
    // A label key that is not in the entry.
    // @ts-expect-error
    counter("requests").add(1, { operation_class: "read", outcome: "ok", book_id: "b-1" });
    // A value that is not in the set.
    // @ts-expect-error
    counter("requests").add(1, { operation_class: "reads", outcome: "ok" });
    // A label the entry needs, missing.
    // @ts-expect-error
    counter("requests").add(1, { operation_class: "read" });
    // All of them missing.
    // @ts-expect-error
    counter("requests").add(1);
    // A metric that is not in the catalog.
    // @ts-expect-error
    counter("requests.by.tenant");
    // A counter is not a histogram, a histogram not a gauge.
    // @ts-expect-error
    histogram("requests");
    // @ts-expect-error
    gauge("request.duration");
    // @ts-expect-error
    counter("books.resident");
    // A set the metric uses only a part of: commit.duration has no "unknown" size.
    // @ts-expect-error
    histogram("commit.duration").record(1, { size_bucket: "unknown" });
    // A span that is not in the catalog.
    // @ts-expect-error
    span("my.new.span", undefined, () => 1);
    // An attribute key that is neither listed nor spelled x.<something>.
    // @ts-expect-error
    span("operation", { whatever: 1 }, () => 1);
    // A value that is not a string, a number or a boolean.
    // @ts-expect-error
    span("operation", { seq: { nested: true } }, () => 1);
    // A metric with no labels takes none.
    // @ts-expect-error
    gauge("process.memory.limit").set(1, { size_bucket: "xs" });
    expect(true).toBe(true);
  });
});

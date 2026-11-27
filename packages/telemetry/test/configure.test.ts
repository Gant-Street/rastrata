import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureTelemetry,
  counter,
  flushTelemetry,
  gauge,
  histogram,
  shutdownTelemetry,
  span,
  telemetryEnabled,
  telemetryStatus,
} from "../src/index.ts";
import { type Collector, closedPort, startCollector } from "./support/collector.ts";

let collector: Collector | undefined;
let directory: string | undefined;
afterEach(async () => {
  await shutdownTelemetry(300);
  await collector?.stop();
  collector = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

const messages: string[] = [];
const log = (message: string) => void messages.push(message);

describe("configureTelemetry: off", () => {
  test("with no endpoint it stays off, loads nothing, and says nothing", async () => {
    messages.length = 0;
    expect(await configureTelemetry({ env: {}, log })).toBe(false);
    expect(telemetryEnabled()).toBe(false);
    expect(telemetryStatus().enabled).toBe(false);
    expect(messages).toEqual([]);
    // Everything is still callable.
    span("operation", undefined, () =>
      counter("requests").add(1, { operation_class: "read", outcome: "ok" }),
    );
  });

  test("an unusable endpoint stays off and warns without repeating the endpoint", async () => {
    messages.length = 0;
    const secret = "http://user:hunter2@collector.example.net:4318";
    expect(await configureTelemetry({ env: { RASTRATA_OTEL_ENDPOINT: secret }, log })).toBe(false);
    expect(telemetryEnabled()).toBe(false);
    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toContain("hunter2");
    expect(messages[0]).not.toContain("collector.example.net");
  });

  test("OTEL_SDK_DISABLED keeps it off", async () => {
    collector = await startCollector();
    expect(
      await configureTelemetry({
        env: { RASTRATA_OTEL_ENDPOINT: collector.url, OTEL_SDK_DISABLED: "true" },
        log,
      }),
    ).toBe(false);
  });
});

describe("configureTelemetry: on, with a collector", () => {
  const env = (url: string, extra: Record<string, string> = {}) => ({
    RASTRATA_OTEL_ENDPOINT: url,
    RASTRATA_OTEL_SAMPLE_RATE: "1",
    RASTRATA_OTEL_METRICS_INTERVAL_MS: "3600000",
    RASTRATA_INSTANCE_ID: "pod-under-test",
    ...extra,
  });

  test("sends spans and metrics, with the resource and the headers it was given, and says where in one line", async () => {
    collector = await startCollector();
    messages.length = 0;
    const on = await configureTelemetry({
      env: env(collector.url, {
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20s3cret-token",
      }),
      serviceName: "rastrata-api",
      runtime: false,
      log,
    });
    expect(on).toBe(true);
    expect(await configureTelemetry({ env: {}, runtime: false, log })).toBe(true); // already on
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("telemetry on");
    expect(messages[0]).not.toContain("s3cret-token");

    await span("http.request", { "http.request.method": "POST" }, async () => {
      await span("operation", { operation: "reports.get", operation_class: "report" }, async () => {
        await Bun.sleep(2);
      });
    });
    counter("requests").add(3, { operation_class: "report", outcome: "ok" });
    histogram("report.duration").record(0.12, { size_bucket: "m" });
    gauge("books.resident").set(2, { size_bucket: "s" });
    await flushTelemetry(3000);

    const spans = collector.spans();
    expect(spans.map((item) => item.name).sort()).toEqual(["http.request", "operation"]);
    const operation = spans.find((item) => item.name === "operation");
    expect(operation?.attributes).toMatchObject({
      operation: "reports.get",
      operation_class: "report",
    });
    expect(operation?.parentSpanId).toBe(
      spans.find((item) => item.name === "http.request")?.spanId,
    );
    expect(collector.resources()[0]).toMatchObject({
      "service.name": "rastrata-api",
      "service.instance.id": "pod-under-test",
    });
    for (const received of collector.received)
      expect(received.headers.get("authorization")).toBe("Bearer s3cret-token");

    const points = collector.latestPoints();
    const requests = points.find((point) => point.name === "rastrata.requests");
    expect(requests).toMatchObject({
      type: "sum",
      monotonic: true,
      value: 3,
      attributes: { operation_class: "report", outcome: "ok" },
    });
    expect(points.find((point) => point.name === "rastrata.report.duration")).toMatchObject({
      type: "histogram",
      count: 1,
      unit: "s",
      attributes: { size_bucket: "m" },
    });
    expect(points.find((point) => point.name === "rastrata.books.resident")).toMatchObject({
      type: "gauge",
      value: 2,
    });
    expect(telemetryStatus().exports.traces.ok).toBeGreaterThanOrEqual(1);
    expect(telemetryStatus().lastSuccessAt).not.toBeNull();
  });

  test("starts the process gauges unless told not to", async () => {
    collector = await startCollector();
    await configureTelemetry({ env: env(collector.url), log });
    await flushTelemetry(3000);
    const names = new Set(collector.latestPoints().map((point) => point.name));
    for (const name of [
      "rastrata.process.memory",
      "rastrata.process.cpu.time",
      "rastrata.process.idle.time",
    ])
      expect(names.has(name), name).toBe(true);
    const memory = collector
      .latestPoints()
      .filter((point) => point.name === "rastrata.process.memory");
    expect(memory.map((point) => point.attributes.memory_kind).sort()).toEqual([
      "external",
      "heap_used",
      "rss",
    ]);
    expect(memory.find((point) => point.attributes.memory_kind === "rss")?.value).toBeGreaterThan(
      10_000_000,
    );
  });

  test("shutdown sends a last export, and afterwards telemetry is off again", async () => {
    collector = await startCollector();
    await configureTelemetry({ env: env(collector.url), runtime: false, log });
    counter("requests").add(5, { operation_class: "post", outcome: "ok" });
    span("operation", undefined, () => undefined);
    await shutdownTelemetry(3000);
    expect(telemetryEnabled()).toBe(false);
    expect(
      collector.latestPoints().find((point) => point.name === "rastrata.requests")?.value,
    ).toBe(5);
    expect(collector.spans()).toHaveLength(1);
    // Calls after shutdown are the no-ops they always were.
    counter("requests").add(1, { operation_class: "post", outcome: "ok" });
  });

  test("appends every metrics export to the dump file as OTLP/JSON lines", async () => {
    collector = await startCollector();
    directory = mkdtempSync(join(tmpdir(), "telemetry-dump-"));
    const file = join(directory, "metrics.jsonl");
    await configureTelemetry({
      env: env(collector.url, { RASTRATA_OTEL_FILE: file }),
      runtime: false,
      log,
    });
    counter("r2.operations").add(2, { r2_op: "put", outcome: "ok" });
    await flushTelemetry(3000);
    counter("r2.operations").add(3, { r2_op: "put", outcome: "ok" });
    await shutdownTelemetry(3000);
    await Bun.sleep(50);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const values = lines.map((line) => {
      const request = JSON.parse(line);
      const metric = request.resourceMetrics[0].scopeMetrics[0].metrics.find(
        (item: { name: string }) => item.name === "rastrata.r2.operations",
      );
      const point = metric.sum.dataPoints[0];
      expect(
        point.attributes.find((a: { key: string }) => a.key === "r2_class").value.stringValue,
      ).toBe("A");
      return Number(point.asInt ?? point.asDouble);
    });
    // Cumulative: each line carries the total so far.
    expect(values[0]).toBe(2);
    expect(values[values.length - 1]).toBe(5);
  });
});

describe("configureTelemetry: the collector is down", () => {
  test("nothing throws, nothing waits, and what was lost is counted", async () => {
    const port = await closedPort();
    await configureTelemetry({
      env: {
        RASTRATA_OTEL_ENDPOINT: `http://127.0.0.1:${port}`,
        RASTRATA_OTEL_SAMPLE_RATE: "1",
        RASTRATA_OTEL_METRICS_INTERVAL_MS: "3600000",
      },
      runtime: false,
      log,
    });
    const started = performance.now();
    for (let index = 0; index < 500; index += 1)
      span("operation", undefined, () =>
        counter("requests").add(1, { operation_class: "read", outcome: "ok" }),
      );
    // The request path never waited for the network.
    expect(performance.now() - started).toBeLessThan(500);
    await flushTelemetry(1500);
    const status = telemetryStatus();
    expect(status.exports.traces.failed + status.exports.traces.dropped).toBeGreaterThanOrEqual(1);
    expect(status.dropped.traces).toBeGreaterThanOrEqual(1);
    expect(status.consecutiveFailures.traces).toBeGreaterThanOrEqual(1);
    expect(status.lastSuccessAt).toBeNull();
    const closing = performance.now();
    await shutdownTelemetry(1500);
    expect(performance.now() - closing).toBeLessThan(3000);
    expect(telemetryEnabled()).toBe(false);
  });
});

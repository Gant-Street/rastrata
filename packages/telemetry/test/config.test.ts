import { describe, expect, test } from "bun:test";
import { cleanUrl, describeConfig, parsePairs, readTelemetryConfig } from "../src/config.ts";

const on = (env: Record<string, string>, defaults?: { serviceName?: string }) => {
  const result = readTelemetryConfig(env, defaults);
  if (!result.on) throw new Error(`expected telemetry on, got off: ${result.reason}`);
  return result.config;
};

describe("readTelemetryConfig: off unless configured", () => {
  test("no endpoint, no telemetry", () => {
    expect(readTelemetryConfig({})).toEqual({ on: false, reason: "no-endpoint" });
    expect(readTelemetryConfig({ RASTRATA_OTEL_ENDPOINT: "  " })).toEqual({
      on: false,
      reason: "no-endpoint",
    });
    // Things that are not the endpoint do not turn it on.
    expect(readTelemetryConfig({ RASTRATA_OTEL_SAMPLE_RATE: "1", OTEL_SERVICE_NAME: "x" }).on).toBe(
      false,
    );
  });

  test("OTEL_SDK_DISABLED wins over an endpoint", () => {
    const env = { RASTRATA_OTEL_ENDPOINT: "http://collector:4318" };
    expect(readTelemetryConfig({ ...env, OTEL_SDK_DISABLED: "true" })).toEqual({
      on: false,
      reason: "disabled",
    });
    expect(readTelemetryConfig({ ...env, OTEL_SDK_DISABLED: "1" }).on).toBe(false);
    expect(readTelemetryConfig({ ...env, OTEL_SDK_DISABLED: "false" }).on).toBe(true);
  });

  test("an endpoint that is not a usable URL leaves it off, and says why", () => {
    for (const bad of [
      "collector:4318",
      "ftp://collector",
      "not a url",
      "http://user:secret@collector:4318",
      "https://:token@collector",
    ])
      expect(readTelemetryConfig({ RASTRATA_OTEL_ENDPOINT: bad }), bad).toEqual({
        on: false,
        reason: "invalid",
      });
  });

  test("the product's own variable wins over the standard one", () => {
    const config = on({
      RASTRATA_OTEL_ENDPOINT: "http://ours:4318",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://standard:4318",
    });
    expect(config.tracesUrl).toBe("http://ours:4318/v1/traces");
    expect(on({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://standard:4318" }).tracesUrl).toBe(
      "http://standard:4318/v1/traces",
    );
  });
});

describe("readTelemetryConfig: where it goes", () => {
  test("adds the signal paths to the base URL, with or without a slash or a path", () => {
    expect(on({ RASTRATA_OTEL_ENDPOINT: "http://c:4318" }).metricsUrl).toBe(
      "http://c:4318/v1/metrics",
    );
    expect(on({ RASTRATA_OTEL_ENDPOINT: "http://c:4318/" }).metricsUrl).toBe(
      "http://c:4318/v1/metrics",
    );
    expect(on({ RASTRATA_OTEL_ENDPOINT: "https://gateway.example.net/otlp" }).tracesUrl).toBe(
      "https://gateway.example.net/otlp/v1/traces",
    );
  });

  test("a signal's own endpoint is used as given", () => {
    const config = on({
      RASTRATA_OTEL_ENDPOINT: "http://c:4318",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://tempo:4318/custom/traces",
    });
    expect(config.tracesUrl).toBe("http://tempo:4318/custom/traces");
    expect(config.metricsUrl).toBe("http://c:4318/v1/metrics");
    expect(
      readTelemetryConfig({
        RASTRATA_OTEL_ENDPOINT: "http://c:4318",
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "nope",
      }),
    ).toEqual({
      on: false,
      reason: "invalid",
    });
  });

  test("reads headers as name=value pairs, decoding percent escapes and skipping the malformed", () => {
    const config = on({
      RASTRATA_OTEL_ENDPOINT: "http://c:4318",
      OTEL_EXPORTER_OTLP_HEADERS:
        "authorization=Basic%20QUJD, x-scope=a=b,=nothing,bad name=x,good-name=ok,injected=a\r\nb",
    });
    expect(config.headers).toEqual({
      authorization: "Basic QUJD",
      "x-scope": "a=b",
      "good-name": "ok",
    });
    // The product's variable wins here too.
    expect(
      on({
        RASTRATA_OTEL_ENDPOINT: "http://c:4318",
        RASTRATA_OTEL_HEADERS: "x=1",
        OTEL_EXPORTER_OTLP_HEADERS: "x=2",
      }).headers,
    ).toEqual({ x: "1" });
  });

  test("never puts a header value in what it says about itself", () => {
    const config = on({
      RASTRATA_OTEL_ENDPOINT: "https://otlp.example.net/otlp",
      RASTRATA_OTEL_HEADERS: "authorization=Basic%20c2VjcmV0LXRva2Vu",
    });
    const text = describeConfig(config);
    expect(text).toContain("otlp.example.net");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("c2VjcmV0");
    expect(text).not.toContain("authorization");
  });
});

describe("readTelemetryConfig: who is sending, and how much", () => {
  test("names the service and the instance", () => {
    const config = on(
      {
        RASTRATA_OTEL_ENDPOINT: "http://c:4318",
        HOSTNAME: "book-pod-7",
        RASTRATA_VERSION: "0.4.1",
        RASTRATA_ENV: "staging",
        OTEL_RESOURCE_ATTRIBUTES: "team=hosting,service.name=ignored",
      },
      { serviceName: "rastrata-api" },
    );
    expect(config.serviceName).toBe("rastrata-api");
    expect(config.resourceAttributes).toEqual({
      team: "hosting",
      "service.name": "rastrata-api",
      "service.instance.id": "book-pod-7",
      "service.version": "0.4.1",
      "deployment.environment.name": "staging",
    });
    expect(
      on(
        { RASTRATA_OTEL_ENDPOINT: "http://c:4318", OTEL_SERVICE_NAME: "worker" },
        { serviceName: "x" },
      ).serviceName,
    ).toBe("worker");
    expect(on({ RASTRATA_OTEL_ENDPOINT: "http://c:4318" }).serviceName).toBe("rastrata");
    expect(
      on({ RASTRATA_OTEL_ENDPOINT: "http://c:4318", RASTRATA_INSTANCE_ID: "i-1", HOSTNAME: "h" })
        .resourceAttributes["service.instance.id"],
    ).toBe("i-1");
  });

  test("has low-rate defaults and clamps what it is given", () => {
    const defaults = on({ RASTRATA_OTEL_ENDPOINT: "http://c:4318" });
    expect(defaults).toMatchObject({
      sampleRate: 0.05,
      slowMs: 1000,
      metricsIntervalMs: 60_000,
      flushMs: 2000,
      compression: "gzip",
      timeoutMs: 5000,
      errorMessages: false,
      dumpFile: undefined,
    });
    const odd = on({
      RASTRATA_OTEL_ENDPOINT: "http://c:4318",
      RASTRATA_OTEL_SAMPLE_RATE: "7",
      RASTRATA_OTEL_SLOW_MS: "-5",
      RASTRATA_OTEL_METRICS_INTERVAL_MS: "10",
      RASTRATA_OTEL_FLUSH_MS: "nonsense",
      RASTRATA_OTEL_COMPRESSION: "NONE",
      RASTRATA_OTEL_TIMEOUT_MS: "5",
      RASTRATA_OTEL_ERROR_MESSAGES: "1",
      RASTRATA_OTEL_FILE: " /tmp/dump.jsonl ",
    });
    expect(odd).toMatchObject({
      sampleRate: 1,
      slowMs: 0,
      metricsIntervalMs: 1000,
      flushMs: 2000,
      compression: "none",
      timeoutMs: 100,
      errorMessages: true,
      dumpFile: "/tmp/dump.jsonl",
    });
    expect(
      on({ RASTRATA_OTEL_ENDPOINT: "http://c:4318", OTEL_METRIC_EXPORT_INTERVAL: "15000" })
        .metricsIntervalMs,
    ).toBe(15_000);
  });
});

describe("helpers", () => {
  test("parsePairs", () => {
    expect(parsePairs(undefined)).toEqual({});
    expect(parsePairs("a=1,b=,c,=d,e=%zz")).toEqual({ a: "1", e: "%zz" });
  });

  test("cleanUrl accepts only http and https without credentials", () => {
    expect(cleanUrl("http://a:1/x")?.host).toBe("a:1");
    expect(cleanUrl("https://a")?.protocol).toBe("https:");
    expect(cleanUrl("file:///etc/passwd")).toBeUndefined();
    expect(cleanUrl("http://u:p@a")).toBeUndefined();
    expect(cleanUrl(undefined)).toBeUndefined();
  });
});

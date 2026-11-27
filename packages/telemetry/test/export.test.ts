import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FetchTransport, retryAfterMs } from "../src/export.ts";
import { type Collector, closedPort, startCollector } from "./support/collector.ts";

const body = (text = '{"resourceSpans":[]}') => new TextEncoder().encode(text);

describe("the fetch transport", () => {
  let collector: Collector;
  beforeEach(async () => {
    collector = await startCollector();
  });
  afterEach(async () => {
    await collector.stop();
  });

  const transport = (extra: Partial<ConstructorParameters<typeof FetchTransport>[0]> = {}) =>
    new FetchTransport({
      signal: "traces",
      url: `${collector.url}/v1/traces`,
      headers: { authorization: "Basic dGVzdA==" },
      compression: "gzip",
      timeoutMs: 300,
      ...extra,
    });

  test("posts JSON with the configured headers and reports ok", async () => {
    const t = transport();
    expect(await t.send(body())).toEqual({ result: "ok" });
    const [seen] = collector.received;
    expect(seen?.path).toBe("/v1/traces");
    expect(seen?.headers.get("content-type")).toBe("application/json");
    expect(seen?.headers.get("authorization")).toBe("Basic dGVzdA==");
    expect(seen?.encoding).toBeNull();
    expect(t.consecutiveFailures).toBe(0);
  });

  test("compresses a body over 1 KiB and leaves a small one alone, and none when told not to", async () => {
    const big = body(JSON.stringify({ resourceSpans: [{ pad: "x".repeat(5000) }] }));
    await transport().send(big);
    await transport({ compression: "none" }).send(big);
    await transport().send(body());
    expect(collector.received.map((item) => item.encoding)).toEqual(["gzip", null, null]);
    expect(collector.received[0]?.bytes).toBeLessThan(big.byteLength / 5);
    expect(collector.received[0]?.body.resourceSpans[0].pad).toHaveLength(5000);
  });

  test("a refused connection is a failure, never an exception, and it backs off", async () => {
    const port = await closedPort();
    let now = 1_000_000;
    const t = new FetchTransport({
      signal: "traces",
      url: `http://127.0.0.1:${port}/v1/traces`,
      headers: {},
      compression: "none",
      timeoutMs: 300,
      now: () => now,
      random: () => 0.5,
    });
    expect(await t.send(body())).toEqual({ result: "failed", reason: "export_failed" });
    expect(t.consecutiveFailures).toBe(1);
    expect(t.backoffMs()).toBe(1000);
    // While backing off it does not try: it drops at once.
    const started = performance.now();
    expect(await t.send(body())).toEqual({ result: "dropped", reason: "backing_off" });
    expect(performance.now() - started).toBeLessThan(50);
    // After the pause it tries once (a probe), and a second failure doubles the wait.
    now += 1001;
    expect(t.backoffMs()).toBe(0);
    expect((await t.send(body())).result).toBe("failed");
    expect(t.backoffMs()).toBe(2000);
    for (let round = 0; round < 10; round += 1) {
      now += 70_000;
      await t.send(body());
    }
    expect(t.backoffMs()).toBeLessThanOrEqual(60_000);
    expect(t.backoffMs()).toBeGreaterThan(50_000);
  });

  test("a success after failures clears the backoff", async () => {
    let now = 5_000;
    collector.mode = { kind: "status", status: 503 };
    const t = transport({ now: () => now, random: () => 0.5, attempts: 1 });
    expect((await t.send(body())).result).toBe("failed");
    expect(t.backoffMs()).toBeGreaterThan(0);
    now += 1500;
    collector.mode = { kind: "ok" };
    expect(await t.send(body())).toEqual({ result: "ok" });
    expect(t.consecutiveFailures).toBe(0);
    expect(t.backoffMs()).toBe(0);
  });

  test("a transient error is tried once more, a permanent one is not", async () => {
    collector.mode = { kind: "status", status: 500 };
    await transport().send(body());
    expect(collector.hits()).toBe(2);
    collector.mode = { kind: "status", status: 400 };
    const before = collector.hits();
    await transport().send(body());
    expect(collector.hits() - before).toBe(1);
  });

  test("honours Retry-After as the backoff, up to a minute", async () => {
    let now = 0;
    collector.mode = { kind: "status", status: 429, retryAfter: "30" };
    const t = transport({ now: () => now, random: () => 0.5 });
    await t.send(body());
    // It did not retry at once (the server asked for 30 s) and it waits that long.
    expect(collector.hits()).toBe(1);
    expect(t.backoffMs()).toBe(30_000);
    collector.mode = { kind: "status", status: 503, retryAfter: "3600" };
    now += 31_000;
    await t.send(body());
    expect(t.backoffMs()).toBe(60_000);
  });

  test("gives up on a server that never answers after the timeout, not later", async () => {
    collector.mode = { kind: "hang" };
    const t = transport({ timeoutMs: 150, attempts: 1 });
    const started = performance.now();
    expect((await t.send(body())).result).toBe("failed");
    const took = performance.now() - started;
    expect(took).toBeGreaterThanOrEqual(140);
    expect(took).toBeLessThan(1500);
  });

  test("at most maxInFlight requests are outstanding, the rest are dropped", async () => {
    collector.mode = { kind: "hang" };
    const t = transport({ timeoutMs: 400, attempts: 1, maxInFlight: 2 });
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => t.send(body())));
    expect(results.filter((item) => item.reason === "queue_full")).toHaveLength(3);
    expect(results.filter((item) => item.result === "failed")).toHaveLength(2);
  });

  test("close aborts what is still in flight and refuses more", async () => {
    collector.mode = { kind: "hang" };
    const t = transport({ timeoutMs: 10_000, attempts: 1 });
    const inFlight = t.send(body());
    await Bun.sleep(30);
    const started = performance.now();
    await t.close(50);
    expect((await inFlight).result).toBe("failed");
    expect(performance.now() - started).toBeLessThan(1000);
    expect(await t.send(body())).toEqual({ result: "dropped", reason: "other" });
  });

  test("a fetch that throws at once is a failure too", async () => {
    const t = transport({
      fetch: (() => {
        throw new TypeError("boom");
      }) as unknown as typeof fetch,
      attempts: 1,
    });
    expect((await t.send(body())).result).toBe("failed");
  });
});

describe("retryAfterMs", () => {
  test("reads seconds and HTTP dates", () => {
    expect(retryAfterMs(null, 0)).toBeUndefined();
    expect(retryAfterMs("", 0)).toBeUndefined();
    expect(retryAfterMs("5", 0)).toBe(5000);
    expect(retryAfterMs("nonsense", 0)).toBeUndefined();
    const now = Date.parse("2026-10-08T00:00:00Z");
    expect(retryAfterMs("Thu, 08 Oct 2026 00:00:10 GMT", now)).toBe(10_000);
    expect(retryAfterMs("Wed, 07 Oct 2026 00:00:00 GMT", now)).toBe(0);
  });
});

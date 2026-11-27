import { afterEach, describe, expect, test } from "bun:test";
import { RateLimiter, recordBeacon } from "../src/beacon.ts";
import { recordTelemetry } from "../src/testing.ts";
import { BEACON_MAX_ACTIONS, BEACON_MAX_BYTES, parseBeacon } from "../src/web.ts";

const ok = (value: unknown) => parseBeacon(JSON.stringify(value));
const refused = (value: unknown) => {
  const result = typeof value === "string" ? parseBeacon(value) : ok(value);
  expect(result.ok, JSON.stringify(value)).toBe(false);
  return result.ok ? "" : result.reason;
};

describe("parseBeacon: what a browser may send", () => {
  test("accepts vitals, actions, or both", () => {
    const both = ok({
      v: 1,
      vitals: { lcp: 1830, inp: 96, ttfb: 120, cls: 0.03 },
      actions: [
        { a: "accept", ms: 180, o: "ok" },
        { a: "post", ms: 640, o: "server_error" },
      ],
    });
    expect(both).toEqual({
      ok: true,
      beacon: {
        v: 1,
        vitals: { lcp: 1830, inp: 96, ttfb: 120, cls: 0.03 },
        actions: [
          { a: "accept", ms: 180, o: "ok" },
          { a: "post", ms: 640, o: "server_error" },
        ],
      },
    });
    expect(ok({ v: 1, vitals: { inp: 40 } }).ok).toBe(true);
    expect(ok({ v: 1, actions: [{ a: "save", ms: 0, o: "other" }] }).ok).toBe(true);
  });

  test("refuses everything else, whole", () => {
    refused("not json at all");
    refused("[]");
    refused("null");
    refused('"text"');
    refused({ v: 2, vitals: { lcp: 1 } });
    refused({ vitals: { lcp: 1 } });
    refused({ v: 1 });
    refused({ v: 1, vitals: {} });
    refused({ v: 1, actions: [] });
    // A key that is not listed, at any level.
    refused({ v: 1, vitals: { lcp: 1 }, url: "https://app.example.com/books/b-1" });
    refused({ v: 1, vitals: { lcp: 1, fcp: 1 } });
    refused({ v: 1, actions: [{ a: "accept", ms: 1, o: "ok", id: "x" }] });
    // A value outside its set or its range.
    refused({ v: 1, actions: [{ a: "delete-everything", ms: 1, o: "ok" }] });
    refused({ v: 1, actions: [{ a: "accept", ms: 1, o: "great" }] });
    refused({ v: 1, vitals: { lcp: -1 } });
    refused({ v: 1, vitals: { lcp: 120_001 } });
    refused({ v: 1, vitals: { cls: 101 } });
    refused({ v: 1, vitals: { lcp: "12" } });
    refused({ v: 1, vitals: { lcp: null } });
    refused({ v: 1, vitals: [1, 2] });
    refused({ v: 1, actions: [{ a: "accept", ms: Number.MAX_VALUE, o: "ok" }] });
    refused({ v: 1, actions: { a: "accept", ms: 1, o: "ok" } });
    refused({
      v: 1,
      actions: Array.from({ length: BEACON_MAX_ACTIONS + 1 }, () => ({
        a: "save",
        ms: 1,
        o: "ok",
      })),
    });
    refused('{"v":1,"__proto__":{"vitals":{"lcp":1}}}');
  });

  test("refuses a message over the size cap", () => {
    const padded = JSON.stringify({ v: 1, vitals: { lcp: 1 }, pad: "x".repeat(BEACON_MAX_BYTES) });
    expect(refused(padded)).toBe("too large");
  });

  test("a reason is a fixed phrase and never repeats what was sent", () => {
    const canary = "CANARY-tenant-4417-https://customer.example.com";
    const reasons = [
      refused({ v: 1, vitals: { lcp: 1 }, [canary]: 1 }),
      refused({ v: 1, actions: [{ a: canary, ms: 1, o: "ok" }] }),
      refused({ v: 1, vitals: { [canary]: 1 } }),
      refused(`{"v":1,"note":"${canary}"`),
    ];
    for (const reason of reasons) expect(reason).not.toContain("CANARY");
  });
});

describe("recordBeacon", () => {
  let telemetry: ReturnType<typeof recordTelemetry> | undefined;
  afterEach(() => {
    telemetry?.stop();
    telemetry = undefined;
  });

  test("records seconds under the size bucket the API knows, and nothing it was not told", () => {
    telemetry = recordTelemetry();
    const parsed = ok({
      v: 1,
      vitals: { lcp: 1830, inp: 96, ttfb: 120, cls: 0.03 },
      actions: [
        { a: "accept", ms: 180, o: "ok" },
        { a: "post", ms: 640, o: "client_error" },
      ],
    });
    if (!parsed.ok) throw new Error("fixture");
    expect(recordBeacon(parsed.beacon, "l")).toBe(true);
    expect(telemetry.values("web.lcp", { size_bucket: "l" })).toEqual([1.83]);
    expect(telemetry.values("web.inp", { size_bucket: "l" })).toEqual([0.096]);
    expect(telemetry.values("web.ttfb")).toEqual([0.12]);
    expect(telemetry.values("web.cls")).toEqual([0.03]);
    expect(telemetry.values("web.action.duration", { web_action: "accept" })).toEqual([0.18]);
    expect(
      telemetry.values("web.action.duration", { web_action: "post", size_bucket: "l" }),
    ).toEqual([0.64]);
    expect(telemetry.sum("web.actions", { web_action: "post", outcome: "client_error" })).toBe(1);
    expect(telemetry.invalid).toEqual([]);
    // Every label on every series came from a closed set: no page, no address, no identifier.
    for (const name of ["web.lcp", "web.inp", "web.action.duration", "web.actions"] as const)
      for (const labels of telemetry.series(name))
        expect(
          Object.keys(labels).every((key) =>
            ["size_bucket", "web_action", "outcome"].includes(key),
          ),
        ).toBe(true);
  });

  test("with the book's size not known it records nothing", () => {
    telemetry = recordTelemetry();
    const parsed = ok({ v: 1, vitals: { lcp: 1 } });
    if (!parsed.ok) throw new Error("fixture");
    expect(recordBeacon(parsed.beacon, "unknown")).toBe(false);
    expect(telemetry.series("web.lcp")).toEqual([]);
  });
});

describe("RateLimiter", () => {
  test("allows a burst, then refuses, then refills with time", () => {
    let now = 0;
    const limiter = new RateLimiter(3, 1, () => now);
    expect([1, 2, 3, 4].map(() => limiter.take("a"))).toEqual([true, true, true, false]);
    expect(limiter.retryAfterSeconds("a")).toBe(1);
    now += 1000;
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
    now += 10_000;
    expect([1, 2, 3, 4].map(() => limiter.take("a"))).toEqual([true, true, true, false]);
  });

  test("keys are independent", () => {
    const limiter = new RateLimiter(1, 0.001, () => 0);
    expect(limiter.take("owner")).toBe(true);
    expect(limiter.take("owner")).toBe(false);
    expect(limiter.take("token:rst_abc")).toBe(true);
  });

  test("remembers only so many keys, forgetting the least recently used", () => {
    const limiter = new RateLimiter(1, 0.001, () => 0, 10);
    for (let index = 0; index < 100; index += 1) limiter.take(`k${index}`);
    expect(limiter.size).toBe(10);
    // The newest are still limited; the forgotten start afresh.
    expect(limiter.take("k99")).toBe(false);
    expect(limiter.take("k0")).toBe(true);
  });
});

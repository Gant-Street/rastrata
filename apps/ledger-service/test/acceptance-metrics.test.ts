import { expect, test } from "bun:test";
import {
  observeSaveLatency,
  observeClientLatency,
  summarizeFreshSaves,
  summarizeSingleWrites,
  measuredDurationHeader,
  type SaveSample,
} from "../scripts/acceptance-metrics.ts";

test("interleaved single-write controls retain the full independent population and fixed warmup", () => {
  const samples = Array.from({ length: 128 }, (_, index) => ({
    index,
    clientMs: index < 8 ? 1000 : index < 122 ? 40 : 80,
    bookMs: index < 8 ? 900 : 30,
  }));
  const original = structuredClone(samples);
  expect(summarizeSingleWrites(samples, 128)).toEqual({
    samples: 120,
    clientP50Ms: 40,
    clientP95Ms: 80,
    bookP50Ms: 30,
    bookP95Ms: 30,
  });
  expect(samples).toEqual(original);
  expect(() => summarizeSingleWrites(samples.slice(1), 128)).toThrow();
  for (const change of [{ index: 5 }, { clientMs: NaN }, { bookMs: Infinity }, { bookMs: -1 }]) {
    const invalid = samples.map((sample) => ({ ...sample }));
    const first = invalid[0];
    if (!first) throw new Error("Missing fixture");
    invalid[0] = { ...first, ...change };
    expect(() => summarizeSingleWrites(invalid, 128)).toThrow();
  }
  expect(() => summarizeSingleWrites(samples, 15)).toThrow();
});

test("missing or empty timing headers cannot masquerade as zero-millisecond execution", () => {
  const name = "x-duration";
  expect(() => measuredDurationHeader(new Headers(), name)).toThrow();
  for (const value of ["", " ", "NaN", "Infinity", "-1", "1ms", "0x20", "9".repeat(400)])
    expect(() => measuredDurationHeader(new Headers({ [name]: value }), name)).toThrow();
  for (const value of ["0", "35", "35.25"])
    expect(measuredDurationHeader(new Headers({ [name]: value }), name)).toBe(Number(value));
});

const population = (duration = 35): SaveSample[] =>
  Array.from({ length: 128 }, (_, index) => ({
    index,
    fresh: true,
    bookWallMs: index < 8 ? 1_000 : duration,
    workerWallMs: index < 8 ? 1_010 : duration + 10,
    endToEndMs: index < 8 ? 1_020 : duration + 30,
  }));

test("latency reporting uses the fixed fresh population and separates client latency", () => {
  const samples = population();
  const original = structuredClone(samples);
  const warm = summarizeFreshSaves(samples, 128);
  expect(warm).toEqual({
    samples: 120,
    bookWallP50Ms: 35,
    bookWallP95Ms: 35,
    endToEndP50Ms: 65,
    endToEndP95Ms: 65,
  });
  expect(observeSaveLatency(warm)).toEqual({
    metric: "warm fresh-commit book-side wall p95",
    observedMs: 35,
    disposition: "observed-not-gated",
  });
  expect(samples).toEqual(original);
  samples.push({ index: 128, fresh: false, bookWallMs: 0, workerWallMs: 0, endToEndMs: 0 });
  expect(summarizeFreshSaves(samples, 128)).toEqual(warm);
});

test("owner-removed thresholds do not suppress slow tails or manufacture a pass", () => {
  for (const duration of [49.999, 50, 50.001, 100, 1000])
    expect(observeSaveLatency(summarizeFreshSaves(population(duration), 128))).toEqual({
      metric: "warm fresh-commit book-side wall p95",
      observedMs: duration,
      disposition: "observed-not-gated",
    });
  const samples = population();
  for (let index = 122; index < 128; index++) {
    const sample = samples[index];
    if (!sample) throw new Error("Missing sample fixture");
    samples[index] = { ...sample, bookWallMs: 80 };
  }
  expect(summarizeFreshSaves(samples, 128).bookWallP95Ms).toBe(80);
  expect(observeSaveLatency(summarizeFreshSaves(samples, 128)).observedMs).toBe(80);
  const warm = summarizeFreshSaves(samples, 128);
  for (const duration of [NaN, Infinity, -1])
    expect(() => observeSaveLatency({ ...warm, bookWallP95Ms: duration })).toThrow();
});

test("a fast book cannot hide slower client-observed latency", () => {
  const warm = summarizeFreshSaves(population(), 128);
  expect(observeSaveLatency(warm).observedMs).toBe(35);
  expect(observeClientLatency(warm)).toEqual({
    metric: "warm fresh-commit client-observed p95",
    observedMs: 65,
    disposition: "observed-not-gated",
  });
  for (const duration of [49.999, 50, 50.001, 100, 1000])
    expect(observeClientLatency({ ...warm, endToEndP95Ms: duration })).toEqual({
      metric: "warm fresh-commit client-observed p95",
      observedMs: duration,
      disposition: "observed-not-gated",
    });
  for (const duration of [NaN, Infinity, -1])
    expect(() => observeClientLatency({ ...warm, endToEndP95Ms: duration })).toThrow();
});

test("missing, replayed, reordered and invalid measurements fail closed", () => {
  expect(() => summarizeFreshSaves(population().slice(1), 128)).toThrow();
  for (const change of [
    { fresh: false },
    { index: 99 },
    { bookWallMs: NaN },
    { workerWallMs: Infinity },
    { endToEndMs: -1 },
  ]) {
    const samples = population();
    const sample = samples[10];
    if (!sample) throw new Error("Missing sample fixture");
    samples[10] = { ...sample, ...change };
    expect(() => summarizeFreshSaves(samples, 128)).toThrow();
  }
  for (const count of [NaN, 0, 15, 16.5, 10_001])
    expect(() => summarizeFreshSaves(population(), count)).toThrow();
});

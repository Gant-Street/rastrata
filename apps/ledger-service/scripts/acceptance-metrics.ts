import assert from "node:assert/strict";

export interface SaveSample {
  readonly index: number;
  readonly endToEndMs: number;
  readonly workerWallMs: number;
  readonly bookWallMs: number;
  readonly fresh: boolean;
}

export interface SingleWriteControl {
  readonly index: number;
  readonly clientMs: number;
  readonly bookMs: number;
}

/** Independent interleaved one-write control, not a substitute save population.
 * No accounting or user-token verification; the same client, gateway and object
 * still wait for durable acknowledgement. The first eight are fixed warmup. */
export function summarizeSingleWrites(samples: readonly SingleWriteControl[], count: number) {
  assert.ok(Number.isSafeInteger(count) && count >= 16 && count <= 10_000);
  assert.equal(samples.length, count, "Incomplete single-write control population");
  for (const [index, sample] of samples.entries()) {
    assert.equal(sample.index, index);
    assert.ok(Number.isFinite(sample.clientMs) && sample.clientMs >= 0);
    assert.ok(Number.isFinite(sample.bookMs) && sample.bookMs >= 0);
  }
  const warm = samples.slice(8);
  const percentile = (key: "clientMs" | "bookMs", fraction: number) => {
    const ordered = warm.map((sample) => sample[key]).sort((left, right) => left - right);
    const value = ordered[Math.floor(ordered.length * fraction)];
    assert.ok(value !== undefined);
    return value;
  };
  return {
    samples: warm.length,
    clientP50Ms: percentile("clientMs", 0.5),
    clientP95Ms: percentile("clientMs", 0.95),
    bookP50Ms: percentile("bookMs", 0.5),
    bookP95Ms: percentile("bookMs", 0.95),
  };
}

export function measuredDurationHeader(headers: Headers, name: string): number {
  const text = headers.get(name);
  assert.ok(text !== null && /^\d+(?:\.\d+)?$/.test(text), "Missing or malformed duration header");
  const value = Number(text);
  assert.ok(Number.isFinite(value), "Invalid measured duration");
  return value;
}

/** Match the existing conservative order statistic. Never interpolate a faster
 * value or discard slow samples. The first eight fresh commits are cold/warmup;
 * retries and recovery writes occur after the fixed measured population. */
export function summarizeFreshSaves(samples: readonly SaveSample[], count: number) {
  assert.ok(Number.isSafeInteger(count) && count >= 16 && count <= 10_000);
  assert.ok(samples.length >= count, "Incomplete fresh-commit population");
  const measured = samples.slice(0, count);
  for (const [index, sample] of measured.entries()) {
    assert.ok(sample.index === index && sample.fresh, "Measured command is missing or not fresh");
    for (const value of [sample.endToEndMs, sample.workerWallMs, sample.bookWallMs])
      assert.ok(Number.isFinite(value) && value >= 0, "Invalid measured duration");
  }
  const warm = measured.slice(8);
  const percentile = (key: "bookWallMs" | "endToEndMs", fraction: number): number => {
    const values = warm.map((sample) => sample[key]).sort((a, b) => a - b);
    const value = values[Math.min(values.length - 1, Math.floor(fraction * values.length))];
    assert.notEqual(value, undefined);
    return value as number;
  };
  return {
    samples: warm.length,
    bookWallP50Ms: percentile("bookWallMs", 0.5),
    bookWallP95Ms: percentile("bookWallMs", 0.95),
    endToEndP50Ms: percentile("endToEndMs", 0.5),
    endToEndP95Ms: percentile("endToEndMs", 0.95),
  };
}

/** Owner removed the numeric latency release gate on 2026-09-19. Keep complete
 * measurements, without turning an observation into a pass or an SLO promise. */
export function observeSaveLatency(warm: ReturnType<typeof summarizeFreshSaves>) {
  assert.ok(Number.isFinite(warm.bookWallP95Ms) && warm.bookWallP95Ms >= 0);
  return {
    metric: "warm fresh-commit book-side wall p95" as const,
    observedMs: warm.bookWallP95Ms,
    disposition: "observed-not-gated" as const,
  };
}

/** Preserve client-observed latency separately from the partial book timer. */
export function observeClientLatency(warm: ReturnType<typeof summarizeFreshSaves>) {
  assert.ok(Number.isFinite(warm.endToEndP95Ms) && warm.endToEndP95Ms >= 0);
  return {
    metric: "warm fresh-commit client-observed p95" as const,
    observedMs: warm.endToEndP95Ms,
    disposition: "observed-not-gated" as const,
  };
}

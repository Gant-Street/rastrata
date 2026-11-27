import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { Rng } from "../src/rng.ts";
import { runSimulation, type SimConfig } from "./support/sim.ts";

/** Pods contend for one book while processes freeze, the tail goes away, clocks are stepped and
 * machines suspended; clients read as well as write. Within the design (a monotonic clock inside its
 * assumed bound, the wall-clock check on) no read may miss an acknowledged operation, no append may
 * be accepted under an old fence, and two holders may never overlap. */
const RUNS = Number(process.env.BOOKLOG_LEASE_RUNS ?? "40");

const lease = (seed: number, extra: Partial<SimConfig>): Partial<SimConfig> => {
  const rng = new Rng(seed * 7);
  return {
    slots: rng.between(2, 3),
    clients: 2,
    ops: 14,
    events: 8,
    readRatio: 2,
    stress: "leases",
    tierFaults: {},
    bulkFaults: {},
    leaseTtlMs: rng.between(1500, 4000),
    ...extra,
  };
};

test(`within the design: no stale read, no old fence accepted, no overlap (${RUNS} seeds)`, async () => {
  let reads = 0;
  let refusals = 0;
  for (let seed = 1; seed <= RUNS; seed += 1) {
    const directory = mkdtempSync(join(tmpdir(), `booklog-lease-${seed}-`));
    const report = await runSimulation(
      seed,
      directory,
      lease(seed, { drift: new Rng(seed).next() * 0.008, wallGuard: true, assumedDrift: 0.01 }),
    );
    expect(report.violations).toEqual([]);
    expect(report.staleReads).toBe(0);
    expect(report.staleFenceAccepted).toBe(0);
    expect(report.leaseOverlaps).toBe(0);
    reads += report.reads;
    refusals += report.fenceRefusals;
  }
  expect(reads).toBeGreaterThan(RUNS * 5);
  expect(refusals).toBeGreaterThan(0);
});

test(`a clock far outside the bound with no checks may serve stale reads, but never lose or double a write (${RUNS * 3} seeds)`, async () => {
  let stale = 0;
  for (let seed = 1; seed <= RUNS * 3; seed += 1) {
    const directory = mkdtempSync(join(tmpdir(), `booklog-lease-bad-${seed}-`));
    const report = await runSimulation(
      seed,
      directory,
      lease(seed, { drift: 0.6, wallGuard: false, assumedDrift: 0 }),
    );
    expect(report.violations).toEqual([]);
    expect(report.staleFenceAccepted).toBe(0);
    expect(report.leaseOverlaps).toBe(0);
    stale += report.staleReads;
  }
  // The point of the lease timer: with it gone, staleness appears. (If it never does, the test is not testing anything.)
  expect(stale).toBeGreaterThan(0);
});

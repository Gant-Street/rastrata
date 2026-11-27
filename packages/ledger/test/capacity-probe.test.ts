import { expect, test } from "bun:test";
import { executeBookCommand } from "@rastrata/kernel";
import { assessCapacity, assertSales, latency } from "../scripts/capacity-probe.ts";
import { activation, genesis, posting } from "./fixtures.ts";

test("capacity probe percentile statistics are nearest-rank and reject invalid samples", () => {
  expect(latency([5, 1, 4, 2, 3])).toEqual({ samples: 5, p50Ms: 3, p95Ms: 5, p99Ms: 5, maxMs: 5 });
  for (const values of [[], [NaN], [Infinity], [-1]]) expect(() => latency(values)).toThrow();
});

test("capacity probe's arithmetic oracle rejects a wrong count or financial revision", () => {
  const initial = genesis();
  const active = executeBookCommand(initial.state, initial.protocol, activation());
  const posted = executeBookCommand(active.state, active.protocol, posting());
  assertSales(posted, 1);
  expect(() => assertSales(posted, 2)).toThrow();
  expect(() =>
    assertSales({ ...posted, state: { ...posted.state, bookRevision: 9n } }, 1),
  ).toThrow();
});

test("capacity assessment cannot turn a clean worker exit, partial run, limit or crash into success", () => {
  const complete = [
    { event: "sample", sales: 10_000, exactBalanceAndRoundTripVerified: true },
    { event: "finished", sales: 10_000, stop: "target_reached" },
  ];
  expect(assessCapacity(complete, 0).targetReached).toBe(true);
  expect(assessCapacity(complete, 1).targetReached).toBe(false);
  expect(assessCapacity([], 0).targetReached).toBe(false);
  expect(
    assessCapacity([{ event: "finished", sales: 10_000, stop: "target_reached" }], 0).targetReached,
  ).toBe(false);
  expect(
    assessCapacity([{ event: "finished", sales: 100, stop: "probe_time_budget" }], 0).targetReached,
  ).toBe(false);
  expect(
    assessCapacity(
      [...complete, { event: "limit_or_failure", reason: "ledger_capacity_exceeded" }],
      0,
    ).targetReached,
  ).toBe(false);
});

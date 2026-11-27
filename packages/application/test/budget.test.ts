import { afterEach, expect, test } from "bun:test";
import { budgetsApply, expectWithin } from "./support/budget.ts";

const original = process.env.RASTRATA_PERF;
afterEach(() => {
  if (original === undefined) delete process.env.RASTRATA_PERF;
  else process.env.RASTRATA_PERF = original;
});

test("a budget that is met passes and one that is missed fails, when budgets apply", () => {
  process.env.RASTRATA_PERF = "strict";
  expect(budgetsApply()).toBe(true);
  expectWithin("fast", 10, 100);
  expect(() => expectWithin("slow", 500, 100)).toThrow("slow took 500 ms; the budget is 100 ms");
  expect(() => expectWithin("equal", 100, 100)).toThrow("equal took 100 ms");
});

test("on a busy machine a missed budget is logged, not failed", () => {
  process.env.RASTRATA_PERF = "off";
  expect(budgetsApply()).toBe(false);
  expectWithin("slow", 500, 100);
});

test("with no override the load average decides", () => {
  delete process.env.RASTRATA_PERF;
  expect(typeof budgetsApply()).toBe("boolean");
});

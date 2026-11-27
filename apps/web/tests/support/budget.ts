/** A time budget is a claim about a quiet machine. Measured on one that is swapping and running
 * other people's suites it measures the neighbours, and a test that fails for that reason teaches
 * nobody anything. So a budget is asserted when the machine is quiet (its one-minute load average
 * is below its core count) and otherwise the figure is logged and nothing fails. Correctness is
 * never skipped: only the clock.
 *
 * RASTRATA_PERF=strict asserts every budget whatever the load; RASTRATA_PERF=off asserts none.
 * packages/application/test/support/budget.ts is the same rule for the application's tests. */
import { cpus, loadavg } from "node:os";

export function budgetsApply(): boolean {
  const mode = process.env.RASTRATA_PERF;
  if (mode === "strict") return true;
  if (mode === "off") return false;
  return (loadavg()[0] ?? 0) < cpus().length;
}

/** Fail when `actualMs` is not under `budgetMs`, on a quiet machine. Throws a plain Error, so it
 * works in bun:test and in Playwright alike. */
export function expectWithin(label: string, actualMs: number, budgetMs: number): void {
  if (!budgetsApply()) {
    console.info(
      `${label}: ${Math.round(actualMs)} ms; budget ${budgetMs} ms not asserted, the machine is busy (load ${(loadavg()[0] ?? 0).toFixed(1)})`,
    );
    return;
  }
  if (!(actualMs < budgetMs))
    throw new Error(`${label} took ${Math.round(actualMs)} ms; the budget is ${budgetMs} ms`);
}

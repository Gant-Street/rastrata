/** A time budget is a claim about a quiet machine; see packages/application/test/support/budget.ts,
 * which this repeats: asserted when the one-minute load average is below the core count, logged
 * otherwise. RASTRATA_PERF=strict asserts always, off never. */
import { cpus, loadavg } from "node:os";

export function budgetsApply(): boolean {
  const mode = process.env.RASTRATA_PERF;
  if (mode === "strict") return true;
  if (mode === "off") return false;
  return (loadavg()[0] ?? 0) < cpus().length;
}

/** Fail when `actual` is not under `budget`, on a quiet machine. */
export function expectWithin(label: string, actual: number, budget: number, unit = "ms"): void {
  if (!budgetsApply()) {
    console.info(
      `${label}: ${actual.toFixed(1)} ${unit}; budget ${budget} ${unit} not asserted, the machine is busy (load ${(loadavg()[0] ?? 0).toFixed(1)})`,
    );
    return;
  }
  if (!(actual < budget))
    throw new Error(`${label} took ${actual.toFixed(1)} ${unit}; the budget is ${budget} ${unit}`);
}

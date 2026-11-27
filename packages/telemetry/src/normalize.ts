/** Checking a data point's labels against its catalog entry. The types already stop a wrong label in
 * typed code; this is what holds when the code is untyped or cast, so the series count stays under
 * the budget whatever a caller does. */
import { METRICS, type DerivedLabel, type MetricName, type MetricSpec } from "./catalog.ts";
import { r2ClassOf, standIn, type LabelKey, type R2Operation } from "./labels.ts";
import type { RawLabels } from "./api.ts";

interface Compiled {
  readonly keys: readonly LabelKey[];
  readonly sets: readonly ReadonlySet<string>[];
  readonly fallbacks: readonly (string | undefined)[];
  readonly derived: readonly DerivedLabel[];
}

const compiled = new Map<MetricName, Compiled>();

function compile(name: MetricName): Compiled {
  const spec = METRICS[name] as MetricSpec;
  const keys = Object.keys(spec.labels) as LabelKey[];
  const entry: Compiled = {
    keys,
    sets: keys.map((key) => new Set(spec.labels[key] as readonly string[])),
    fallbacks: keys.map((key) => standIn(spec.labels[key] as readonly string[])),
    derived: spec.derived ?? [],
  };
  compiled.set(name, entry);
  return entry;
}

/** The attributes to record for a data point, or null when it cannot be recorded: a label is missing
 * or outside its set and the set has no "other" or "unknown" to stand in for it. Labels the entry
 * does not declare are dropped. Derived labels are added. */
export function normalizeLabels(
  name: MetricName,
  labels: RawLabels,
): Record<string, string> | null {
  const entry = compiled.get(name) ?? compile(name);
  const out: Record<string, string> = {};
  for (let index = 0; index < entry.keys.length; index += 1) {
    const key = entry.keys[index] as LabelKey;
    const given = labels?.[key];
    if (typeof given === "string" && (entry.sets[index] as ReadonlySet<string>).has(given)) {
      out[key] = given;
      continue;
    }
    const stand = entry.fallbacks[index];
    if (stand === undefined) return null;
    out[key] = stand;
  }
  for (const derived of entry.derived) {
    if (derived === "r2_class") out.r2_class = r2ClassOf(out.r2_op as R2Operation);
  }
  return out;
}

/** Describe an error for a span without its message, which may hold text a customer typed: its type
 * and, when it has one, its stable code. */
export function describeError(
  error: unknown,
  includeMessage = false,
): { type: string; code?: string; message?: string } {
  const type =
    error instanceof Error
      ? error.name || "Error"
      : error === null
        ? "null"
        : typeof error === "object"
          ? "object"
          : typeof error;
  const result: { type: string; code?: string; message?: string } = { type: type.slice(0, 80) };
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(code)) result.code = code;
  if (includeMessage && error instanceof Error) result.message = error.message.slice(0, 200);
  return result;
}

/** For tests: turn telemetry on with an in-memory backend and read back what the code under test
 * emitted. Nothing is exported anywhere.
 *
 *   const telemetry = recordTelemetry();
 *   try {
 *     await doTheThing();
 *     expect(telemetry.sum("r2.operations", { r2_op: "put", r2_class: "A" })).toBe(1);
 *     expect(telemetry.spansNamed("booklog.commit")[0]?.attributes.seq).toBe(8);
 *     expect(telemetry.invalid).toEqual([]);
 *   } finally {
 *     telemetry.stop();
 *   }
 *
 * Metric names may be given with or without the `rastrata.` prefix. Label matching is by subset:
 * the labels you give must all match; the ones you leave out are summed over. */
import { installBackend } from "./api.ts";
import type { CounterName, GaugeName, HistogramName, MetricName, SpanName } from "./catalog.ts";
import { createMemoryBackend, type MemoryBackend, type RecordedSpan } from "./memory.ts";

export type { RecordedEvent, RecordedSpan } from "./memory.ts";

type Named<N extends string> = N | `rastrata.${N}`;
type Match = Readonly<Record<string, string>>;

export interface Recorder {
  /** Spans in the order they ended. */
  readonly spans: readonly RecordedSpan[];
  /** Data points the catalog refused: a label missing, or outside its set with no stand-in. A test
   * of code that emits telemetry should expect this to be empty. */
  readonly invalid: readonly string[];
  spansNamed(name: SpanName): RecordedSpan[];
  /** The sum of a counter over the series that match `labels`. */
  sum(name: Named<CounterName>, labels?: Match): number;
  /** Every value recorded in a histogram over the series that match `labels`. */
  values(name: Named<HistogramName>, labels?: Match): number[];
  /** How many values were recorded in a histogram over the series that match `labels`, and their
   * sum: what any backend can tell you, since an exporting one keeps buckets, not values. */
  stats(name: Named<HistogramName>, labels?: Match): { count: number; sum: number };
  /** The last value set on a gauge series that matches `labels`. */
  last(name: Named<GaugeName>, labels?: Match): number | undefined;
  /** The attribute sets of every series recorded for a metric, derived labels included. */
  series(name: Named<MetricName>): Record<string, string>[];
  /** Forget what was recorded, keep recording. */
  reset(): void;
  /** Stop recording and put back whatever backend was installed before. */
  stop(): void;
}

const bare = <N extends string>(name: Named<N>): N =>
  (name.startsWith("rastrata.") ? name.slice("rastrata.".length) : name) as N;

export function recordTelemetry(): Recorder {
  const backend: MemoryBackend = createMemoryBackend();
  const previous = installBackend(backend);
  let stopped = false;
  return {
    spans: backend.spans,
    invalid: backend.invalid,
    spansNamed: (name) => backend.spans.filter((span) => span.name === name),
    sum: (name, labels) => backend.sum(bare(name), labels),
    values: (name, labels) => backend.values(bare(name), labels),
    stats(name, labels) {
      const values = backend.values(bare(name), labels);
      return { count: values.length, sum: values.reduce((total, value) => total + value, 0) };
    },
    last: (name, labels) => backend.last(bare(name), labels),
    series: (name) => backend.series(bare(name)),
    reset: () => backend.reset(),
    stop() {
      if (stopped) return;
      stopped = true;
      installBackend(previous);
    },
  };
}

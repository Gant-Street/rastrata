import { counter, histogram, outcomeOfStatus, span, type Outcome } from "@rastrata/telemetry";
import {
  ObjectStoreError,
  ObjectStoreUncertain,
  kindOfKey,
  type ListPage,
  type ObjectMeta,
  type ObjectStore,
  type PutOptions,
  type PutResult,
  type StoredObject,
} from "./objectstore.ts";

export type MeteredOp = "put" | "get" | "head" | "list" | "delete";

/** The outcomes an object-store call may carry as a metric label (the catalog's set for calls). */
type CallOutcome = "ok" | "not_found" | "conflict" | "server_error" | "timeout" | "other";
const callOutcome = (outcome: Outcome): CallOutcome =>
  outcome === "client_error" ? "other" : outcome;

export interface OpSample {
  readonly op: MeteredOp;
  /** Wall or virtual seconds, as the clock given says. */
  readonly seconds: number;
  readonly outcome: CallOutcome;
  readonly bytes: number;
}

export interface OpSummary {
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
}

/** The p-quantile (0 to 1) of an ascending list, by the nearest-rank rule. */
export function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1] as number;
}

export function summarize(values: readonly number[]): OpSummary {
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    n: sorted.length,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    min: sorted[0] ?? Number.NaN,
    max: sorted[sorted.length - 1] ?? Number.NaN,
    mean: sorted.length ? total / sorted.length : Number.NaN,
  };
}

/** Wraps any store: counts every operation by R2 billing class, keeps each call's duration for
 * percentiles, and emits the spans and metrics the telemetry catalog names. It changes nothing
 * about what the store does. */
export class MeteredObjectStore implements ObjectStore {
  readonly #inner: ObjectStore;
  readonly #now: () => number;
  readonly #keep: boolean;
  readonly samples: OpSample[] = [];
  #tally = { put: 0, get: 0, head: 0, list: 0, delete: 0, bytesIn: 0, bytesOut: 0 };

  /** `now` returns milliseconds (the real clock by default; pass a virtual clock's `now` in a simulation). */
  constructor(
    inner: ObjectStore,
    options: { readonly now?: () => number; readonly keepSamples?: boolean } = {},
  ) {
    this.#inner = inner;
    this.#now = options.now ?? (() => performance.now());
    this.#keep = options.keepSamples ?? true;
  }

  get counts(): {
    readonly put: number;
    readonly get: number;
    readonly head: number;
    readonly list: number;
    readonly delete: number;
    readonly classA: number;
    readonly classB: number;
    readonly bytesIn: number;
    readonly bytesOut: number;
  } {
    const t = this.#tally;
    return { ...t, classA: t.put + t.list, classB: t.get + t.head };
  }

  summary(op: MeteredOp, outcome?: CallOutcome): OpSummary {
    return summarize(
      this.samples
        .filter(
          (sample) => sample.op === op && (outcome === undefined || sample.outcome === outcome),
        )
        .map((sample) => sample.seconds),
    );
  }

  reset(): void {
    this.samples.length = 0;
    this.#tally = { put: 0, get: 0, head: 0, list: 0, delete: 0, bytesIn: 0, bytesOut: 0 };
  }

  putIfAbsent(key: string, body: Uint8Array, options?: PutOptions): Promise<PutResult> {
    return this.#measure(
      "put",
      key,
      () => this.#inner.putIfAbsent(key, body, options),
      body.byteLength,
      (result) => (result.created ? "ok" : "conflict"),
      () => 0,
    );
  }
  get(key: string): Promise<StoredObject | null> {
    return this.#measure(
      "get",
      key,
      () => this.#inner.get(key),
      0,
      (result) => (result ? "ok" : "not_found"),
      (result) => result?.size ?? 0,
    );
  }
  head(key: string): Promise<ObjectMeta | null> {
    return this.#measure(
      "head",
      key,
      () => this.#inner.head(key),
      0,
      (result) => (result ? "ok" : "not_found"),
      () => 0,
    );
  }
  list(prefix: string, after?: string, limit?: number): Promise<ListPage> {
    return this.#measure(
      "list",
      prefix,
      () => this.#inner.list(prefix, after, limit),
      0,
      () => "ok",
      () => 0,
    );
  }
  delete(key: string): Promise<void> {
    return this.#measure(
      "delete",
      key,
      () => this.#inner.delete(key),
      0,
      () => "ok",
      () => 0,
    );
  }

  async #measure<T>(
    op: MeteredOp,
    key: string,
    call: () => Promise<T>,
    bytesIn: number,
    outcomeOfResult: (result: T) => CallOutcome,
    bytesOfResult: (result: T) => number,
  ): Promise<T> {
    const started = this.#now();
    let outcome: CallOutcome = "ok";
    let bytesOut = 0;
    try {
      const result = await span(`r2.${op}`, { r2_op: op }, () => call());
      outcome = outcomeOfResult(result);
      bytesOut = bytesOfResult(result);
      return result;
    } catch (error) {
      outcome =
        error instanceof ObjectStoreUncertain
          ? error.status !== undefined && error.status >= 500
            ? "server_error"
            : "timeout"
          : error instanceof ObjectStoreError && error.status !== undefined
            ? callOutcome(outcomeOfStatus(error.status))
            : "other";
      throw error;
    } finally {
      const seconds = (this.#now() - started) / 1000;
      this.#tally[op] += 1;
      this.#tally.bytesIn += bytesIn;
      this.#tally.bytesOut += bytesOut;
      if (this.#keep) this.samples.push({ op, seconds, outcome, bytes: bytesIn + bytesOut });
      counter("r2.operations").add(1, { r2_op: op, outcome });
      histogram("r2.duration").record(seconds, { r2_op: op });
      const object_kind = kindOfKey(key);
      if (bytesIn) counter("r2.bytes").add(bytesIn, { direction: "in", object_kind });
      if (bytesOut) counter("r2.bytes").add(bytesOut, { direction: "out", object_kind });
    }
  }
}

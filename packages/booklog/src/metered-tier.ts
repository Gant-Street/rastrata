import { counter, histogram, span } from "@rastrata/telemetry";
import type {
  AcquireResult,
  AppendInput,
  AppendResult,
  LogTier,
  RenewResult,
  SealManifest,
  SealResult,
  TierCapabilities,
  TierHead,
  TierPage,
} from "./tier.ts";
import { ObjectStoreUncertain } from "./objectstore.ts";

type TailKind = "postgres" | "durable_object" | "r2" | "other";
type TailOp = "append" | "read" | "lease" | "seal" | "other";
type CallOutcome = "ok" | "not_found" | "conflict" | "server_error" | "timeout" | "other";

const kindOf = (name: string): TailKind =>
  name === "postgres"
    ? "postgres"
    : name === "durable-object"
      ? "durable_object"
      : name === "object-store"
        ? "r2"
        : "other";

export interface TierCounts {
  readonly append: number;
  readonly read: number;
  readonly head: number;
  readonly lease: number;
  readonly seal: number;
  readonly fenceRejections: number;
  readonly conflicts: number;
}

/** Wraps a tail: spans and the catalog's tail and lease metrics for every call, plus plain counts
 * for an experiment. It changes nothing about what the tail does.
 *
 * `tail.rows.written` is the quantity a Durable Object is billed and capped on. Postgres writes two rows
 * for an append (the entry, and the head row it moves). A Durable Object tail writes one (the head is the
 * entry it just wrote), one for each lease call (the head row holds the lease, so a book that is merely
 * open writes a row every renewal), and a seal deletes its entries (a row each) and writes the head row
 * once. A repeated or refused append writes nothing. */
export class MeteredLogTier implements LogTier {
  readonly capabilities: TierCapabilities;
  readonly #inner: LogTier;
  readonly #kind: TailKind;
  readonly counts = {
    append: 0,
    read: 0,
    head: 0,
    lease: 0,
    seal: 0,
    fenceRejections: 0,
    conflicts: 0,
  };

  constructor(inner: LogTier) {
    this.#inner = inner;
    this.capabilities = inner.capabilities;
    this.#kind = kindOf(inner.capabilities.name);
  }

  async #call<T>(
    op: TailOp,
    spanName: "tail.append" | "tail.read" | "lease.acquire" | "lease.renew" | "seal.run" | null,
    work: () => Promise<T>,
    outcomeOf: (value: T) => CallOutcome,
  ): Promise<T> {
    const started = performance.now();
    let outcome: CallOutcome = "ok";
    try {
      const run = () => work();
      const value = spanName ? await span(spanName, { tail_kind: this.#kind }, run) : await run();
      outcome = outcomeOf(value);
      return value;
    } catch (error) {
      outcome = error instanceof ObjectStoreUncertain ? "timeout" : "server_error";
      throw error;
    } finally {
      histogram("tail.duration").record((performance.now() - started) / 1000, {
        tail_kind: this.#kind,
        tail_op: op,
      });
      counter("tail.operations").add(1, { tail_kind: this.#kind, tail_op: op, outcome });
    }
  }

  head(book: string): Promise<TierHead> {
    this.counts.head += 1;
    return this.#call(
      "read",
      null,
      () => this.#inner.head(book),
      () => "ok",
    );
  }

  readFrom(book: string, seq: number, limit?: number): Promise<TierPage> {
    this.counts.read += 1;
    return this.#call(
      "read",
      "tail.read",
      () => this.#inner.readFrom(book, seq, limit),
      () => "ok",
    );
  }

  async append(book: string, input: AppendInput): Promise<AppendResult> {
    this.counts.append += 1;
    const result = await this.#call(
      "append",
      "tail.append",
      () => this.#inner.append(book, input),
      (value) => (value.ok ? "ok" : "conflict"),
    );
    if (this.#kind === "durable_object") {
      if (result.ok && !result.duplicate)
        counter("tail.rows.written").add(1, { tail_kind: this.#kind });
    } else if (result.ok) counter("tail.rows.written").add(2, { tail_kind: this.#kind });
    if (!result.ok) {
      this.counts.conflicts += 1;
      if (result.reason === "fence") {
        this.counts.fenceRejections += 1;
        counter("lease.fence_rejections").add(1, { tail_op: "append" });
      }
    }
    return result;
  }

  async acquire(book: string, holder: string, ttlMs: number): Promise<AcquireResult> {
    this.counts.lease += 1;
    const result = await this.#call(
      "lease",
      "lease.acquire",
      () => this.#inner.acquire(book, holder, ttlMs),
      (v) => (v.ok ? "ok" : "conflict"),
    );
    counter("lease.operations").add(1, {
      lease_op: "acquire",
      lease_result: result.ok ? "granted" : "denied",
    });
    if (result.ok) this.#leaseRow();
    return result;
  }

  async renew(
    book: string,
    lease: { readonly holder: string; readonly fence: number },
    ttlMs: number,
  ): Promise<RenewResult> {
    this.counts.lease += 1;
    const result = await this.#call(
      "lease",
      "lease.renew",
      () => this.#inner.renew(book, lease, ttlMs),
      (v) => (v.ok ? "ok" : "conflict"),
    );
    counter("lease.operations").add(1, {
      lease_op: "renew",
      lease_result: result.ok ? "granted" : result.reason === "expired" ? "expired" : "denied",
    });
    if (result.ok) this.#leaseRow();
    return result;
  }

  async release(
    book: string,
    lease: { readonly holder: string; readonly fence: number },
  ): Promise<void> {
    this.counts.lease += 1;
    await this.#call(
      "lease",
      null,
      () => this.#inner.release(book, lease),
      () => "ok",
    );
    counter("lease.operations").add(1, { lease_op: "release", lease_result: "granted" });
    this.#leaseRow();
  }

  async seal(
    book: string,
    input: { readonly upTo: number; readonly manifest: SealManifest },
  ): Promise<SealResult> {
    this.counts.seal += 1;
    const result = await this.#call(
      "seal",
      null,
      () => this.#inner.seal(book, input),
      (v) => (v.ok ? "ok" : "conflict"),
    );
    if (this.#kind === "durable_object" && result.ok && result.trimmed > 0)
      counter("tail.rows.written").add(result.trimmed + 1, { tail_kind: this.#kind });
    return result;
  }

  /** A lease call writes the head row of a Durable Object tail. */
  #leaseRow(): void {
    if (this.#kind === "durable_object")
      counter("tail.rows.written").add(1, { tail_kind: this.#kind });
  }
}

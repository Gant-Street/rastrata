import { counter } from "@rastrata/telemetry";
import { systemClock, type Clock } from "./clock.ts";
import { ObjectStoreError, ObjectStoreUncertain } from "./objectstore.ts";
import type {
  AcquireResult,
  AdoptResult,
  AdoptState,
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

/** The tail is not being called: it failed again and again (a limit of the service reached, an outage), so
 * the caller is told at once, without a request, and the tail is given time before it is tried again.
 * Nothing was sent, so nothing can have been applied. It is an {@link ObjectStoreUncertain} so that every
 * caller that already copes with a tail that cannot be reached copes with this; the host shows a person
 * 'service limit reached, try again later'. */
export class TailUnavailableError extends ObjectStoreUncertain {
  /** How long until the tail is tried again, at the soonest. */
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number, options: { readonly cause?: unknown } = {}) {
    super("The tail is not being called: it has been failing, and is being given time to recover");
    this.name = "TailUnavailableError";
    this.retryAfterMs = retryAfterMs;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export type BreakerState = "closed" | "open" | "half-open";

export interface GuardOptions {
  /** Failures in a row that open the breaker (default 3). */
  readonly failureThreshold?: number;
  /** The wait after the breaker first opens (default 1 s); it doubles each time a probe fails. */
  readonly baseMs?: number;
  /** The longest wait (default 60 s). Each wait is drawn between half of its length and all of it, so
   * that pods which began failing together do not come back together. */
  readonly maxMs?: number;
  readonly clock?: Clock;
  /** A number in [0, 1) for the jitter (default `Math.random`). */
  readonly random?: () => number;
}

export interface GuardStatus {
  readonly state: BreakerState;
  /** Failures in a row, while the breaker is closed. */
  readonly failures: number;
  /** Milliseconds until the next call is let through, while it is open. */
  readonly retryInMs: number;
  /** Calls made to the tail, calls that failed, calls refused without being made, and the times the
   * breaker opened and closed, since the process began. */
  readonly calls: number;
  readonly failed: number;
  readonly rejected: number;
  readonly opened: number;
  readonly closed: number;
}

/** A call that left the tail unreached or unanswered: a failure of the service, not an answer. A
 * refusal of our credentials counts too, since a pod that is refused every time must not ask every time. */
const isFailure = (error: unknown): boolean =>
  error instanceof ObjectStoreUncertain ||
  (error instanceof ObjectStoreError && (error.status === 401 || error.status === 403));

/** A circuit breaker in front of a remote tail.
 *
 * The tail is a service with limits (the daily requests of a plan, the rows a Durable Object may write)
 * and outages, and a pod that is refused must not ask again at the pace of its renewals and its
 * requests: that is a retry storm, and it spends the little of the allowance that is left. After
 * `failureThreshold` failures in a row the breaker opens, and every call (an append, a renewal, a read,
 * a seal) is refused at once with {@link TailUnavailableError} and without a request. After a wait that
 * doubles each time up to `maxMs`, with jitter, one call is let through as a probe; if it is answered the
 * breaker closes and everything goes on, and if it fails the breaker opens again for twice as long. A
 * call that was refused reached no one, and the guard never repeats a call itself, so an append is never
 * sent twice by it.
 *
 * What a caller is told. Whenever the breaker is open, a call that can simply be made again whatever
 * became of it (everything but an append) fails with {@link TailUnavailableError}, including the failure
 * that opened the breaker and a probe that failed, so that one thing is said however the call came to
 * fail. An append that was sent and failed keeps the error it failed with: it may have landed, and the
 * runtime must treat it as uncertain, not as refused. */
export class GuardedLogTier implements LogTier {
  readonly capabilities: TierCapabilities;
  readonly adopt?: (book: string, state: AdoptState) => Promise<AdoptResult>;
  readonly #inner: LogTier;
  readonly #threshold: number;
  readonly #baseMs: number;
  readonly #maxMs: number;
  readonly #clock: Clock;
  readonly #random: () => number;
  #state: BreakerState = "closed";
  #failures = 0;
  /** How many times in a row the breaker has opened without a call succeeding: it sets the wait. */
  #opens = 0;
  #reopenAt = 0;
  readonly #counts = { calls: 0, failed: 0, rejected: 0, opened: 0, closed: 0 };

  constructor(inner: LogTier, options: GuardOptions = {}) {
    this.#inner = inner;
    this.capabilities = inner.capabilities;
    if (inner.adopt) {
      const adopt = inner.adopt.bind(inner);
      this.adopt = (book, state) => this.#run(() => adopt(book, state), false);
    }
    this.#threshold = Math.max(1, options.failureThreshold ?? 3);
    this.#baseMs = Math.max(1, options.baseMs ?? 1000);
    this.#maxMs = Math.max(this.#baseMs, options.maxMs ?? 60_000);
    this.#clock = options.clock ?? systemClock;
    this.#random = options.random ?? Math.random;
  }

  status(): GuardStatus {
    return {
      state: this.#state,
      failures: this.#failures,
      retryInMs: this.#state === "open" ? Math.max(0, this.#reopenAt - this.#clock.now()) : 0,
      ...this.#counts,
    };
  }

  /** The wait before the next probe: doubling, capped, drawn between half and all of it. */
  #wait(): number {
    const full = Math.min(this.#maxMs, this.#baseMs * 2 ** Math.min(this.#opens - 1, 30));
    return Math.round(full * (0.5 + 0.5 * this.#random()));
  }

  /** Open for the next wait. Only a breaker that was closed counts as opening (a probe that fails
   * puts it back to waiting, longer). */
  #open(wasClosed: boolean): void {
    this.#opens += 1;
    this.#state = "open";
    this.#reopenAt = this.#clock.now() + this.#wait();
    if (!wasClosed) return;
    this.#counts.opened += 1;
    counter("tail.breaker").add(1, { breaker_event: "opened" });
  }

  #close(): void {
    this.#state = "closed";
    this.#failures = 0;
    this.#opens = 0;
    this.#counts.closed += 1;
    counter("tail.breaker").add(1, { breaker_event: "closed" });
  }

  async #run<T>(call: () => Promise<T>, repeatable = true): Promise<T> {
    let probe = false;
    if (this.#state !== "closed") {
      const now = this.#clock.now();
      if (this.#state === "open" && now >= this.#reopenAt) {
        // One call goes through to find out; the others wait for its answer.
        this.#state = "half-open";
        probe = true;
      } else {
        this.#counts.rejected += 1;
        counter("tail.breaker").add(1, { breaker_event: "rejected" });
        throw new TailUnavailableError(
          this.#state === "open" ? Math.max(0, this.#reopenAt - now) : this.#baseMs,
        );
      }
    }
    this.#counts.calls += 1;
    try {
      const value = await call();
      this.#answered(probe);
      return value;
    } catch (error) {
      // Any error but a failure is an answer (the tail refused the request, which means it was reached).
      if (!isFailure(error)) {
        this.#answered(probe);
        throw error;
      }
      this.#failed(probe);
      if (repeatable && this.#isOpen())
        throw new TailUnavailableError(Math.max(0, this.#reopenAt - this.#clock.now()), {
          cause: error,
        });
      throw error;
    }
  }

  #isOpen(): boolean {
    return this.#state === "open";
  }

  #answered(probe: boolean): void {
    if (probe) this.#close();
    else if (this.#state === "closed") this.#failures = 0;
  }

  #failed(probe: boolean): void {
    this.#counts.failed += 1;
    if (probe) {
      this.#open(false);
      return;
    }
    if (this.#state !== "closed") return;
    this.#failures += 1;
    if (this.#failures >= this.#threshold) this.#open(true);
  }

  head(book: string): Promise<TierHead> {
    return this.#run(() => this.#inner.head(book));
  }
  readFrom(book: string, seq: number, limit?: number): Promise<TierPage> {
    return this.#run(() => this.#inner.readFrom(book, seq, limit));
  }
  append(book: string, input: AppendInput): Promise<AppendResult> {
    return this.#run(() => this.#inner.append(book, input), false);
  }
  acquire(book: string, holder: string, ttlMs: number): Promise<AcquireResult> {
    return this.#run(() => this.#inner.acquire(book, holder, ttlMs));
  }
  renew(
    book: string,
    lease: { readonly holder: string; readonly fence: number },
    ttlMs: number,
  ): Promise<RenewResult> {
    return this.#run(() => this.#inner.renew(book, lease, ttlMs));
  }
  release(book: string, lease: { readonly holder: string; readonly fence: number }): Promise<void> {
    return this.#run(() => this.#inner.release(book, lease));
  }
  seal(
    book: string,
    input: { readonly upTo: number; readonly manifest: SealManifest },
  ): Promise<SealResult> {
    return this.#run(() => this.#inner.seal(book, input));
  }
}

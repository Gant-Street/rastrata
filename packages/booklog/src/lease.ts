import { systemClock, type Clock } from "./clock.ts";
import { ObjectStoreUncertain } from "./objectstore.ts";
import { TailUnavailableError } from "./tier-guard.ts";
import type { AcquireResult, LeaseGrant, LogTier, RenewResult, TierHead } from "./tier.ts";

/** The two clocks a process has. The monotonic one never steps (it may run a little fast or slow);
 * the wall clock may be stepped by an operator or by NTP. A lease is timed by the monotonic clock
 * alone; the wall clock is consulted only to notice that the process was frozen (a paused virtual
 * machine does not advance the monotonic clock but wakes up with the right time of day). */
export interface PodClock {
  mono(): number;
  wall(): number;
}
export const systemPodClock: PodClock = { mono: () => performance.now(), wall: () => Date.now() };

export class LeaseLostError extends Error {
  constructor(message = "This process no longer holds the book's lease") {
    super(message);
    this.name = "LeaseLostError";
  }
}

export class LeaseHeldElsewhereError extends Error {
  readonly heldBy: string;
  readonly expiresInMs: number;
  constructor(heldBy: string, expiresInMs: number) {
    super(`The book is leased to ${heldBy} for another ${Math.ceil(expiresInMs)} ms`);
    this.name = "LeaseHeldElsewhereError";
    this.heldBy = heldBy;
    this.expiresInMs = expiresInMs;
  }
}

export interface LeaseOptions {
  readonly tier: LogTier;
  readonly book: string;
  /** Unique per process incarnation (a restarted pod must not look like the old one). */
  readonly holder: string;
  /** How long a grant lasts on the tier's clock (default 5 s). */
  readonly ttlMs?: number;
  /** How often to renew while serving (default a third of the lease). */
  readonly renewEveryMs?: number;
  /** The most this process's monotonic clock may run slow against true time, as a fraction (default 1%). */
  readonly driftBound?: number;
  /** Taken off every lease for scheduling, collection and serialization (default 100 ms). */
  readonly safetyMs?: number;
  /** How far the wall and monotonic clocks may disagree about elapsed time before the lease is
   * distrusted until renewed (default 250 ms). */
  readonly skewToleranceMs?: number;
  readonly pod?: PodClock;
  /** For the renewal timer. */
  readonly clock?: Clock;
  readonly onLost?: (reason: "expired" | "taken" | "released") => void;
}

interface Tenure {
  readonly fence: number;
  /** Monotonic time before which this process may trust the lease. */
  readonly deadline: number;
  readonly monoAtRequest: number;
  readonly wallAtRequest: number;
  readonly grant: LeaseGrant;
}

/** The pod's side of a lease. It is deliberately conservative:
 *  - every deadline is counted from the moment *before* the request was sent, so a slow reply only
 *    shortens it;
 *  - the lease length is divided by (1 + the drift bound) and a safety margin is taken off, so a
 *    monotonic clock that runs slow, or a pause between the check and the use, is covered;
 *  - if the wall clock and the monotonic clock disagree about how long it has been, the process was
 *    probably frozen: the lease is distrusted until the tier confirms it.
 * The hard guarantee for writes is the fence the tier checks on every append; this timer is what
 * makes reads without a remote call safe. */
export class LeaseKeeper {
  readonly #tier: LogTier;
  readonly #book: string;
  readonly holder: string;
  readonly #ttl: number;
  readonly #every: number;
  readonly #drift: number;
  readonly #safety: number;
  readonly #tolerance: number;
  readonly #pod: PodClock;
  readonly #clock: Clock;
  readonly #onLost: LeaseOptions["onLost"];
  #tenure: Tenure | null = null;
  #running = false;
  /** Which renewal loop is the current one: a loop that finds it is not stops, so that stopping and
   * starting again while the old loop sleeps never leaves two. */
  #generation = 0;
  /** Set when the last renewal was not made because the tail is not being called, and cleared by the next
   * one that is answered: it says why a lease that lapsed lapsed. */
  #unavailable: TailUnavailableError | null = null;
  #lastHead: TierHead | null = null;
  readonly stats = {
    acquires: 0,
    acquireRefused: 0,
    renewals: 0,
    renewFailures: 0,
    losses: 0,
    distrusted: 0,
  };

  constructor(options: LeaseOptions) {
    this.#tier = options.tier;
    this.#book = options.book;
    this.holder = options.holder;
    this.#ttl = options.ttlMs ?? 5000;
    this.#every = options.renewEveryMs ?? this.#ttl / 3;
    this.#drift = options.driftBound ?? 0.01;
    this.#safety = options.safetyMs ?? 100;
    this.#tolerance = options.skewToleranceMs ?? 250;
    this.#pod = options.pod ?? systemPodClock;
    this.#clock = options.clock ?? systemClock;
    this.#onLost = options.onLost;
  }

  get fence(): number | null {
    return this.#tenure?.fence ?? null;
  }
  get head(): TierHead | null {
    return this.#lastHead;
  }
  /** Monotonic time at which the process stops trusting its lease. */
  get deadline(): number | null {
    return this.#tenure?.deadline ?? null;
  }
  get leases(): boolean {
    return this.#tier.capabilities.leases;
  }

  /** True while this process may answer from its cache without asking anyone. */
  valid(): boolean {
    const tenure = this.#tenure;
    if (!tenure || !this.leases) return false;
    const mono = this.#pod.mono();
    if (mono >= tenure.deadline) return false;
    const wallElapsed = this.#pod.wall() - tenure.wallAtRequest;
    const monoElapsed = mono - tenure.monoAtRequest;
    if (Math.abs(wallElapsed - monoElapsed) > this.#tolerance) {
      this.stats.distrusted += 1;
      return false;
    }
    return true;
  }

  /** Why a lease that cannot be used cannot: the tail is not being called (when that is why it could not
   * be renewed and has lapsed), or it was lost. */
  leaseError(): Error {
    return this.#unavailable
      ? new TailUnavailableError(this.#unavailable.retryAfterMs)
      : new LeaseLostError();
  }

  assertValid(): number {
    if (!this.valid()) throw this.leaseError();
    return (this.#tenure as Tenure).fence;
  }

  /** Ask for the lease. On success the process holds it until the deadline unless it renews. */
  async acquire(): Promise<AcquireResult> {
    const monoAtRequest = this.#pod.mono();
    const wallAtRequest = this.#pod.wall();
    const result = await this.#tier.acquire(this.#book, this.holder, this.#ttl);
    this.#unavailable = null;
    if (!result.ok) {
      this.stats.acquireRefused += 1;
      this.#lastHead = result.head;
      return result;
    }
    this.stats.acquires += 1;
    this.#take(result.lease, monoAtRequest, wallAtRequest);
    return result;
  }

  /** Acquire, or throw {@link LeaseHeldElsewhereError} when someone else holds it. */
  async require(): Promise<LeaseGrant> {
    const result = await this.acquire();
    if (!result.ok) throw new LeaseHeldElsewhereError(result.heldBy, result.expiresInMs);
    return result.lease;
  }

  /** One renewal. Returns false (and forgets the lease) when the tier says it is gone; a lost
   * answer keeps the old deadline, which keeps counting down. */
  async renew(): Promise<boolean> {
    const tenure = this.#tenure;
    if (!tenure) return false;
    const monoAtRequest = this.#pod.mono();
    const wallAtRequest = this.#pod.wall();
    let result: RenewResult;
    try {
      result = await this.#tier.renew(
        this.#book,
        { holder: this.holder, fence: tenure.fence },
        this.#ttl,
      );
    } catch (error) {
      if (error instanceof ObjectStoreUncertain) {
        this.stats.renewFailures += 1;
        this.#unavailable = error instanceof TailUnavailableError ? error : null;
        return false;
      }
      throw error;
    }
    this.#unavailable = null;
    if (!result.ok) {
      this.stats.losses += 1;
      this.#tenure = null;
      this.#lastHead = result.head;
      this.#onLost?.(result.reason);
      return false;
    }
    this.stats.renewals += 1;
    this.#take(result.lease, monoAtRequest, wallAtRequest);
    return true;
  }

  #take(grant: LeaseGrant, monoAtRequest: number, wallAtRequest: number): void {
    this.#lastHead = grant.head;
    this.#tenure = {
      fence: grant.fence,
      deadline: monoAtRequest + grant.ttlMs / (1 + this.#drift) - this.#safety,
      monoAtRequest,
      wallAtRequest,
      grant,
    };
  }

  /** Whether the background renewal is running. */
  get renewing(): boolean {
    return this.#running;
  }

  /** Renew in the background until stopped. Calling it again while it runs does nothing; after `stop` it
   * starts a new loop, which a book does when it takes the lease again after letting go of it. */
  start(): void {
    if (this.#running || !this.leases) return;
    this.#running = true;
    const mine = ++this.#generation;
    void (async () => {
      while (this.#running && this.#generation === mine) {
        await this.#clock.sleep(this.#every);
        if (!this.#running || this.#generation !== mine) break;
        if (!this.#tenure) continue;
        try {
          await this.renew();
        } catch {
          this.stats.renewFailures += 1;
        }
      }
    })();
  }

  /** Stop renewing and give the lease up so the next holder need not wait for it to lapse. */
  async stop(options: { readonly release?: boolean } = {}): Promise<void> {
    this.#running = false;
    const tenure = this.#tenure;
    this.#tenure = null;
    if (options.release !== false && tenure) {
      try {
        await this.#tier.release(this.#book, { holder: this.holder, fence: tenure.fence });
      } catch {
        // The lease lapses by itself.
      }
      this.#onLost?.("released");
    }
  }

  /** Forget the lease without telling the tier (a process that learned it lost). */
  forget(): void {
    this.#tenure = null;
  }
}

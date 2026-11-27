import type { Clock } from "./clock.ts";
import type { PodClock } from "./lease.ts";

/** A process's two clocks, derived from a simulation's true time, with the faults a real machine
 * has: a monotonic clock that runs a little fast or slow, one that stops while the machine is
 * suspended, and a wall clock an operator or NTP steps. */
export class SimPodClock implements PodClock {
  readonly #truth: Clock;
  #monoAtAnchor = 0;
  #anchor: number;
  #rate: number;
  #wallOffset: number;

  constructor(
    truth: Clock,
    options: { readonly rate?: number; readonly wallOffsetMs?: number } = {},
  ) {
    this.#truth = truth;
    this.#anchor = truth.now();
    this.#rate = options.rate ?? 1;
    this.#wallOffset = options.wallOffsetMs ?? 0;
  }

  mono(): number {
    return this.#monoAtAnchor + Math.max(0, this.#truth.now() - this.#anchor) * this.#rate;
  }

  wall(): number {
    return this.#truth.now() + this.#wallOffset;
  }

  /** From now on the monotonic clock advances at `rate` times true time (0.99 runs 1% slow). */
  setRate(rate: number): void {
    this.#monoAtAnchor = this.mono();
    this.#anchor = this.#truth.now();
    this.#rate = rate;
  }

  /** The wall clock jumps by `deltaMs`; the monotonic clock does not notice. */
  stepWall(deltaMs: number): void {
    this.#wallOffset += deltaMs;
  }

  /** The machine is suspended for `ms` of true time: the monotonic clock stands still meanwhile,
   * and the wall clock (set right again from the network on waking) does not. */
  suspend(ms: number): void {
    this.#monoAtAnchor = this.mono();
    this.#anchor = this.#truth.now() + ms;
  }
}

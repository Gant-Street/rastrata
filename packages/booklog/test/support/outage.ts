import type { VirtualClock } from "../../src/clock.ts";
import { ObjectStoreUncertain } from "../../src/objectstore.ts";
import { Rng } from "../../src/rng.ts";
import type { MemoryLogTier } from "../../src/tier-memory.ts";
import type { LogTier } from "../../src/tier.ts";

/** The tail as a service that stops answering: while it is down every call fails as a limit or an
 * outage does, and half of the calls that change something are applied first and their answer lost,
 * which is the case that can lose or double a write. */
export class Outage implements LogTier {
  readonly capabilities;
  readonly #inner: MemoryLogTier;
  readonly #clock: VirtualClock;
  readonly #rng: Rng;
  #from = Number.POSITIVE_INFINITY;
  #to = Number.POSITIVE_INFINITY;
  /** Every call that reached the tail, and those of them made while it was down. */
  calls = 0;
  callsWhileDown = 0;
  lostAnswers = 0;

  constructor(inner: MemoryLogTier, clock: VirtualClock, seed: number) {
    this.#inner = inner;
    this.#clock = clock;
    this.#rng = new Rng(seed);
    this.capabilities = inner.capabilities;
  }
  down(from: number, to: number): void {
    this.#from = from;
    this.#to = to;
  }
  async #call<T>(changes: boolean, work: () => Promise<T>): Promise<T> {
    this.calls += 1;
    const now = this.#clock.now();
    if (now >= this.#from && now < this.#to) {
      this.callsWhileDown += 1;
      if (changes && this.#rng.chance(0.5)) {
        await work();
        this.lostAnswers += 1;
      }
      throw new ObjectStoreUncertain(
        "durable object: HTTP 429 (Cloudflare error 1027, a limit of the service)",
        429,
      );
    }
    return work();
  }
  head = (book: string) => this.#call(false, () => this.#inner.head(book));
  readFrom = (book: string, seq: number, limit?: number) =>
    this.#call(false, () => this.#inner.readFrom(book, seq, limit));
  append = (book: string, input: Parameters<LogTier["append"]>[1]) =>
    this.#call(true, () => this.#inner.append(book, input));
  acquire = (book: string, holder: string, ttl: number) =>
    this.#call(true, () => this.#inner.acquire(book, holder, ttl));
  renew = (book: string, lease: { holder: string; fence: number }, ttl: number) =>
    this.#call(true, () => this.#inner.renew(book, lease, ttl));
  release = (book: string, lease: { holder: string; fence: number }) =>
    this.#call(true, () => this.#inner.release(book, lease));
  seal = (book: string, input: Parameters<LogTier["seal"]>[1]) =>
    this.#call(true, () => this.#inner.seal(book, input));
}

/** A small seeded generator (sfc32, seeded through splitmix32), so every simulated fault, latency and
 * schedule is reproducible from one integer. It is not for anything secret. */

function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/** A 32-bit FNV-1a hash of the parts, to derive the seed of a named stream from a root seed. */
export function hashSeed(...parts: readonly (string | number)[]): number {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    const text = `${part}\u0000`;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash >>> 0;
}

export class Rng {
  #a: number;
  #b: number;
  #c: number;
  #d: number;

  constructor(seed: number) {
    const next = splitmix32(seed);
    this.#a = next();
    this.#b = next();
    this.#c = next();
    this.#d = next();
    for (let index = 0; index < 12; index += 1) this.uint32();
  }

  /** A stream that depends only on the root seed and a label, not on how many numbers other streams drew. */
  static derive(seed: number, label: string): Rng {
    return new Rng(hashSeed(seed, label));
  }

  uint32(): number {
    const t = (((this.#a + this.#b) >>> 0) + this.#d) >>> 0;
    this.#d = (this.#d + 1) >>> 0;
    this.#a = this.#b ^ (this.#b >>> 9);
    this.#b = (this.#c + (this.#c << 3)) >>> 0;
    this.#c = ((this.#c << 21) | (this.#c >>> 11)) >>> 0;
    this.#c = (this.#c + t) >>> 0;
    return t;
  }

  /** A number in [0, 1). */
  next(): number {
    return this.uint32() / 4294967296;
  }

  /** An integer in [0, maxExclusive). */
  int(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1)
      throw new RangeError("int needs a positive integer bound");
    return Math.floor(this.next() * maxExclusive);
  }

  /** An integer in [min, max]. */
  between(min: number, max: number): number {
    return min + this.int(max - min + 1);
  }

  chance(probability: number): boolean {
    return probability > 0 && this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError("pick needs a nonempty list");
    return items[this.int(items.length)] as T;
  }

  shuffle<T>(items: T[]): T[] {
    for (let index = items.length - 1; index > 0; index -= 1) {
      const other = this.int(index + 1);
      const held = items[index] as T;
      items[index] = items[other] as T;
      items[other] = held;
    }
    return items;
  }

  /** A standard normal draw (Box-Muller). */
  normal(): number {
    const u = 1 - this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** A log-normal draw with the given median and shape: the right form for a latency tail. */
  lognormal(median: number, sigma: number): number {
    return median * Math.exp(sigma * this.normal());
  }
}

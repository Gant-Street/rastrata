/** The API's half of the browser beacon (see web.ts): turn a checked beacon into the catalog's
 * metrics, and limit how often one credential may send one. */
import { counter, histogram } from "./api.ts";
import type { SizeBucket } from "./labels.ts";
import type { Beacon } from "./web.ts";

/** Record a beacon that parseBeacon accepted, under the size bucket of the book it was about.
 * Returns false, recording nothing, when the size is not known: the web metrics have no "unknown"
 * size, and a guess would put a book in the wrong bucket. */
export function recordBeacon(beacon: Beacon, size: SizeBucket): boolean {
  if (size === "unknown") return false;
  const seconds = (milliseconds: number) => milliseconds / 1000;
  const vitals = beacon.vitals;
  if (vitals?.lcp !== undefined)
    histogram("web.lcp").record(seconds(vitals.lcp), { size_bucket: size });
  if (vitals?.inp !== undefined)
    histogram("web.inp").record(seconds(vitals.inp), { size_bucket: size });
  if (vitals?.ttfb !== undefined)
    histogram("web.ttfb").record(seconds(vitals.ttfb), { size_bucket: size });
  if (vitals?.cls !== undefined) histogram("web.cls").record(vitals.cls, { size_bucket: size });
  for (const action of beacon.actions ?? []) {
    histogram("web.action.duration").record(seconds(action.ms), {
      web_action: action.a,
      size_bucket: size,
    });
    counter("web.actions").add(1, { web_action: action.a, outcome: action.o });
  }
  return true;
}

/** A token bucket per key: `capacity` at once, refilled at `perSecond`. The number of keys it
 * remembers is bounded, the least recently used going first, so a flood of different keys cannot
 * grow it. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 1_000,
  ) {}

  /** Spend one token; false when there is none. */
  take(key: string): boolean {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    this.buckets.delete(key); // re-inserted below, which moves it to the newest end
    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + ((now - bucket.at) / 1000) * this.perSecond,
    );
    bucket.at = now;
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    if (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
    return allowed;
  }

  /** Seconds until `key` has a token, rounded up; 0 if it has one. */
  retryAfterSeconds(key: string): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    const missing =
      1 -
      Math.min(this.capacity, bucket.tokens + ((this.now() - bucket.at) / 1000) * this.perSecond);
    return missing <= 0 ? 0 : Math.ceil(missing / this.perSecond);
  }

  get size(): number {
    return this.buckets.size;
  }
}

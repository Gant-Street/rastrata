import { gauge } from "@rastrata/telemetry";

/** What one book's runtime knows about the entries its tail holds that are not sealed yet. */
export interface UnsealedState {
  /** Entries appended and not sealed. */
  readonly count: number;
  /** Their bytes, as far as this process knows (entries it did not write count as nothing). */
  readonly bytes: number;
  /** How old the oldest one is, in seconds, at `observedAt` on `now`'s clock; null when none. */
  readonly ageSeconds: number | null;
  readonly observedAt: number;
  readonly now: () => number;
}

const books = new Map<string, UnsealedState>();
let refresh: ReturnType<typeof setInterval> | null = null;

/** Publish the tail gauges of the process: entries and bytes not sealed (summed over the books it
 * serves) and the age of the oldest (the greatest over them). They are process-wide because the
 * catalog allows no book or tenant label. The age is refreshed every few seconds while anything is
 * waiting, since it grows with no event to say so. */
export function reportTail(book: string, state: UnsealedState | null): void {
  if (state === null || state.count === 0) books.delete(book);
  else books.set(book, state);
  publish();
  if (books.size > 0 && refresh === null) {
    refresh = setInterval(publish, 5000);
    (refresh as unknown as { unref?: () => void }).unref?.();
  } else if (books.size === 0 && refresh !== null) {
    clearInterval(refresh);
    refresh = null;
  }
}

function publish(): void {
  let depth = 0;
  let bytes = 0;
  let age = 0;
  for (const state of books.values()) {
    depth += state.count;
    bytes += state.bytes;
    if (state.ageSeconds !== null)
      age = Math.max(age, state.ageSeconds + (state.now() - state.observedAt) / 1000);
  }
  gauge("tail.depth").set(depth);
  gauge("tail.size").set(bytes);
  gauge("tail.age").set(age);
}

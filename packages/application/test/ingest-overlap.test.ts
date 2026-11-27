import { expect, test } from "bun:test";
import {
  fingerprintOf,
  matchOverlap,
  type IncomingLine,
  type StoredCandidate,
} from "../src/ingest/overlap.ts";

const line = (index: number, date: string, cents: number, text = "shop"): IncomingLine => ({
  index,
  fingerprint: fingerprintOf(date, BigInt(cents), "USD"),
  textKey: text,
});

/** A tiny stand-in for the stored items of one source, driven only through matchOverlap. */
class Source {
  readonly stored = new Map<string, StoredCandidate[]>();
  private next = 0;
  import(incoming: readonly IncomingLine[]) {
    const result = matchOverlap(incoming, this.stored);
    for (const fresh of result.fresh) {
      const source = incoming.find((item) => item.index === fresh.index) as IncomingLine;
      const list = this.stored.get(source.fingerprint) ?? [];
      list.push({ id: `s${this.next++}`, textKey: source.textKey, occurrence: fresh.occurrence });
      this.stored.set(source.fingerprint, list);
    }
    return result;
  }
  counts(): Map<string, number> {
    return new Map([...this.stored].map(([key, list]) => [key, list.length]));
  }
}

test("importing a file again adds nothing, even when it holds identical lines", () => {
  const source = new Source();
  const file = [
    line(0, "2026-01-02", -450, "coffee"),
    line(1, "2026-01-02", -450, "coffee"),
    line(2, "2026-01-03", 1000),
  ];
  expect(source.import(file).fresh).toHaveLength(3);
  const again = source.import(file);
  expect(again.fresh).toHaveLength(0);
  expect(again.matched).toHaveLength(3);
  expect(source.counts().get(fingerprintOf("2026-01-02", -450n, "USD"))).toBe(2);
});

test("two purchases of the same amount on one day are two lines, never one", () => {
  const source = new Source();
  const result = source.import([line(0, "2026-01-02", -450), line(1, "2026-01-02", -450)]);
  expect(result.fresh.map((item) => item.occurrence)).toEqual([1, 2]);
});

test("an overlapping window imports only what is new, including a third identical line", () => {
  const source = new Source();
  source.import([line(0, "2026-01-02", -450), line(1, "2026-01-03", -100)]);
  const result = source.import([
    line(0, "2026-01-02", -450),
    line(1, "2026-01-02", -450),
    line(2, "2026-01-03", -100),
    line(3, "2026-01-04", -7),
  ]);
  expect(result.fresh.map((item) => item.index).sort()).toEqual([1, 3]);
  expect(result.matched.map((item) => item.index).sort()).toEqual([0, 2]);
});

test("a changed description is still recognised, and the genuinely new line keeps its own text", () => {
  const source = new Source();
  source.import([line(0, "2026-01-02", -500, "alpha")]);
  // A later file lists the old line under a reformatted description and a new line with the same date and amount.
  const result = source.import([
    line(0, "2026-01-02", -500, "beta"),
    line(1, "2026-01-02", -500, "alpha reformatted"),
  ]);
  expect(result.matched).toHaveLength(1);
  expect(result.fresh).toHaveLength(1);
  // Neither text equals the stored one, so the first in file order pairs with it.
  expect(result.matched[0]?.index).toBe(0);
  expect(result.matched[0]?.sameText).toBe(false);
  expect(result.fresh[0]?.index).toBe(1);
});

test("equal text pairs first, so the new line is the one that was not stored", () => {
  const source = new Source();
  source.import([line(0, "2026-01-02", -500, "alpha")]);
  const result = source.import([
    line(0, "2026-01-02", -500, "beta"),
    line(1, "2026-01-02", -500, "alpha"),
  ]);
  expect(result.matched).toEqual([{ index: 1, itemId: "s0", sameText: true }]);
  expect(result.fresh.map((item) => item.index)).toEqual([0]);
});

test("a different date or amount is a different line: nothing is guessed", () => {
  const source = new Source();
  source.import([line(0, "2026-01-02", -450)]);
  const result = source.import([line(0, "2026-01-03", -450), line(1, "2026-01-02", -451)]);
  expect(result.fresh).toHaveLength(2);
  expect(result.matched).toHaveLength(0);
});

test("a narrower file than what is stored matches what it lists and imports nothing", () => {
  const source = new Source();
  source.import([line(0, "2026-01-02", -450), line(1, "2026-01-02", -450)]);
  const result = source.import([line(0, "2026-01-02", -450)]);
  expect(result.fresh).toHaveLength(0);
  expect(result.matched).toHaveLength(1);
});

/** A deterministic generator, so a failure can be replayed from its seed. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

test("any set of windows that covers the account imports each real line exactly once", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const next = random(seed);
    const days = 12;
    // The real account: a few amounts so identical same-day lines are common.
    const truth: { date: string; cents: number; text: string }[] = [];
    for (let day = 1; day <= days; day++)
      for (let k = Math.floor(next() * 4); k > 0; k--)
        truth.push({
          date: `2026-02-${String(day).padStart(2, "0")}`,
          cents: -100 * (1 + Math.floor(next() * 3)),
          text: `shop ${Math.floor(next() * 3)}`,
        });
    // Windows of whole days: a first one that starts the account, a last one that ends it, and
    // random ones between, imported in random order.
    const windows: [number, number][] = [[1, 1 + Math.floor(next() * days)]];
    for (let k = Math.floor(next() * 4); k > 0; k--) {
      const from = 1 + Math.floor(next() * days);
      windows.push([from, from + Math.floor(next() * (days - from + 1))]);
    }
    windows.push([Math.floor(next() * days) + 1, days]);
    // Make sure every day is covered by at least one window.
    windows.push([1, days]);
    const source = new Source();
    for (const [from, to] of windows.sort(() => next() - 0.5)) {
      const file = truth
        .filter((item) => Number(item.date.slice(8)) >= from && Number(item.date.slice(8)) <= to)
        .sort(() => next() - 0.5);
      source.import(file.map((item, index) => line(index, item.date, item.cents, item.text)));
    }
    const expected = new Map<string, number>();
    for (const item of truth) {
      const key = fingerprintOf(item.date, BigInt(item.cents), "USD");
      expected.set(key, (expected.get(key) ?? 0) + 1);
    }
    expect(source.counts(), `seed ${seed}`).toEqual(expected);
  }
});

test("occurrence numbers stay unique per identity however files arrive", () => {
  const next = random(7);
  const source = new Source();
  for (let round = 0; round < 50; round++) {
    const file: IncomingLine[] = [];
    for (let k = Math.floor(next() * 6); k > 0; k--)
      file.push(line(file.length, "2026-03-01", -100, `t${Math.floor(next() * 3)}`));
    source.import(file);
    for (const list of source.stored.values()) {
      const occurrences = list.map((item) => item.occurrence);
      expect(new Set(occurrences).size).toBe(occurrences.length);
    }
  }
});

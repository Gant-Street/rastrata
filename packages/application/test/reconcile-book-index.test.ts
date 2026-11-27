/** The reconciliation's per-account index of the book, carried from one state to the next, is exactly the
 * index built from the whole book, at every state of random books: backdated postings (they go into the
 * middle of an account's list), reversals, superseding corrections (they take an entry out, so the index
 * is built again), new accounts (so are they), entries with several lines on one account, and states read
 * a few commands apart. */
import { describe, expect, test } from "bun:test";
import type { BookState } from "@rastrata/kernel";
import { carriedBy } from "../src/carried.ts";
import { buildBookIndex, extendBookIndex, type BookIndex } from "../src/slices/reconcile/book.ts";
import { KernelBook } from "./support/kernel-book.ts";
import { playRandomBook } from "./support/random-book.ts";
import { CHART } from "./support/scenario.ts";

/** An index as plain data, to compare two of them. */
function plain(index: BookIndex) {
  return {
    bookRevision: index.bookRevision,
    currency: index.currency,
    accounts: [...index.accounts].sort(([left], [right]) => (left < right ? -1 : 1)),
    postings: [...index.postings]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([id, list]) => [
        id,
        list.map((posting) => ({ ...posting, cents: String(posting.cents) })),
      ]),
    // The totals are the sums of the lists, and each is the same whether carried or built.
    totals: [...(index.totals ?? [])]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([id, sum]) => [id, String(sum)]),
    sums: [...index.postings]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([id, list]) => [id, String(list.reduce((sum, posting) => sum + posting.cents, 0n))]),
  };
}

function counting() {
  const made = { built: 0, extended: 0, again: 0 };
  const index = carriedBy<BookIndex>({
    build: (state) => {
      made.built += 1;
      return buildBookIndex(state);
    },
    extend: (previous, delta, state) => {
      const next = extendBookIndex(previous, delta, state);
      if (next === null) made.again += 1;
      else made.extended += 1;
      return next;
    },
  });
  return { index, made };
}

describe("the reconciliation's index of the book", () => {
  for (const seed of [201, 202, 203, 204])
    test(`carried from state to state it is the index built from the book (seed ${seed})`, () => {
      const { index, made } = counting();
      let visited = 0;
      playRandomBook({
        seed,
        steps: 160,
        onState: ({ state }) => {
          expect(plain(index(state)), `seed ${seed} step ${visited}`).toEqual(
            plain(buildBookIndex(state)),
          );
          visited += 1;
        },
      });
      expect(visited).toBe(160);
      expect(made.built).toBeGreaterThanOrEqual(1);
      expect(made.extended).toBeGreaterThan(100);
      // The kinds of change that build it again are in the random books and are the minority.
      expect(made.again).toBeGreaterThan(0);
      expect(made.built).toBeLessThan(made.extended);
    });

  test("states read a few commands apart and out of order", () => {
    for (const [which, gap] of [3, 11, 40].entries()) {
      const states: BookState[] = [];
      playRandomBook({ seed: 210 + which, steps: 200, onState: ({ state }) => states.push(state) });
      const { index } = counting();
      for (const state of states.filter((_, at) => at % gap === 0))
        expect(plain(index(state))).toEqual(plain(buildBookIndex(state)));
      // The newest first, then older ones, each made from nothing.
      const last = states.at(-1) as BookState;
      expect(plain(index(last))).toEqual(plain(buildBookIndex(last)));
      const early = states[3] as BookState;
      expect(plain(index(early))).toEqual(plain(buildBookIndex(early)));
    }
  });

  test("the lists a state shares with the one before are not copied, and the one before is left alone", () => {
    const book = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART, chainHead: true });
    book.post("2025-03-01", [
      ["1000", 500n],
      ["4000", -500n],
    ]);
    const { index } = counting();
    const before = index(book.state);
    const cash = before.postings.get("1000");
    book.post("2025-02-01", [
      ["6000", 40n],
      ["1000", -40n],
    ]);
    book.post("2025-03-01", [
      ["2000", 7n],
      ["1100", -7n],
    ]);
    const after = index(book.state);
    // Cash gained a posting in the middle; the earlier index still says what it said.
    expect(before.postings.get("1000")).toBe(cash);
    expect(cash?.map((posting) => posting.date)).toEqual(["2025-03-01"]);
    expect(after.postings.get("1000")?.map((posting) => posting.date)).toEqual([
      "2025-02-01",
      "2025-03-01",
    ]);
    expect(after.postings.get("1100")?.length).toBe(1);
    // An account no new posting touched keeps the list it had.
    expect(after.accounts).toBe(before.accounts);
  });
});

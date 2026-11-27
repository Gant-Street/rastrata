/** `carriedBy` makes a thing derived from a book state once per state, from the thing for the state before
 * it when the hash chain says the new state is that history carried on, and from nothing when it cannot. */
import { describe, expect, test } from "bun:test";
import type { BookState } from "@rastrata/kernel";
import { carriedBy } from "../src/carried.ts";
import { MAX_EXTENSION } from "../src/reports/ledger-history.ts";
import { KernelBook } from "./support/kernel-book.ts";
import { playRandomBook } from "./support/random-book.ts";
import { CHART } from "./support/scenario.ts";

/** The number of journals, made from the book or carried by the journals that came in. */
function counting(options: { refuse?: (delta: { journals: readonly unknown[] }) => boolean } = {}) {
  const made = { built: 0, extended: 0, refused: 0 };
  const count = carriedBy<{ journals: number }>({
    build: (state) => {
      made.built += 1;
      return { journals: state.journals.length };
    },
    extend: (previous, delta) => {
      if (options.refuse?.(delta)) {
        made.refused += 1;
        return null;
      }
      made.extended += 1;
      return { journals: previous.journals + delta.journals.length };
    },
  });
  return { count, made };
}

const post = (book: KernelBook, date: string) =>
  book.post(date, [
    ["1000", 100n],
    ["4000", -100n],
  ]);

describe("a thing carried from state to state", () => {
  test("is the thing built from the book at every state of random books, and built from nothing once", () => {
    for (const seed of [301, 302, 303]) {
      const { count, made } = counting();
      playRandomBook({
        seed,
        steps: 120,
        onState: ({ state }) => expect(count(state).journals).toBe(state.journals.length),
      });
      expect(made.built).toBe(1);
      expect(made.extended).toBeGreaterThan(80);
    }
  });

  test("is made once per state: asking again for the same state gives the same object", () => {
    const book = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART });
    post(book, "2025-02-01");
    const { count, made } = counting();
    const first = count(book.state);
    expect(count(book.state)).toBe(first);
    post(book, "2025-02-02");
    const second = count(book.state);
    expect(second).not.toBe(first);
    expect(count(book.state)).toBe(second);
    expect(made).toEqual({ built: 1, extended: 1, refused: 0 });
  });

  test("is built again where the extension says it cannot be carried, and carried on from there", () => {
    const book = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART });
    post(book, "2025-02-01");
    const { count, made } = counting({ refuse: (delta) => delta.journals.length > 1 });
    count(book.state);
    post(book, "2025-02-02");
    post(book, "2025-02-03");
    // Two journals at once is more than this extension takes.
    expect(count(book.state).journals).toBe(3);
    expect(made).toMatchObject({ built: 2 });
    expect(made.refused).toBeGreaterThan(0);
    post(book, "2025-02-04");
    expect(count(book.state).journals).toBe(4);
    expect(made.built).toBe(2);
  });

  test("is carried through states that branch off, and is not borrowed across histories", () => {
    const book = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART });
    post(book, "2025-02-01");
    const other = book.fork();
    const { count, made } = counting();
    count(book.state);
    post(book, "2025-02-02");
    count(book.state);
    // The branch is another history from the same state: it extends the state they share.
    post(other, "2025-03-05");
    post(other, "2025-03-06");
    expect(count(other.state).journals).toBe(3);
    expect(made).toEqual({ built: 1, extended: 2, refused: 0 });
    // A different book with the same number of journals is nobody's descendant.
    const stranger = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART });
    post(stranger, "2025-02-01");
    post(stranger, "2025-02-02");
    post(stranger, "2025-02-03");
    expect(count(stranger.state).journals).toBe(3);
    expect(made.built).toBe(2);
  });

  test("is built from nothing for a state older than the two it keeps, and for one too many commands on", () => {
    const states: BookState[] = [];
    const book = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART, chainHead: true });
    post(book, "2025-02-01");
    states.push(book.state);
    const { count, made } = counting();
    // The first state is never asked for, so an old state really is one that was not made.
    post(book, "2025-03-01");
    count(book.state);
    for (let index = 1; index < 5; index += 1) {
      post(book, `2025-03-0${index + 1}`);
      states.push(book.state);
      count(book.state);
    }
    expect(made).toEqual({ built: 1, extended: 4, refused: 0 });
    // An old state is nobody's descendant among the views kept, so it is built from nothing.
    expect(count(states[0] as BookState).journals).toBe(1);
    expect(made.built).toBe(2);
    // And one a great many commands on is built again too.
    for (let index = 0; index < MAX_EXTENSION + 1; index += 1) post(book, "2025-04-01");
    expect(count(book.state).journals).toBe(1 + 5 + MAX_EXTENSION + 1);
    expect(made.built).toBe(3);
  });
});

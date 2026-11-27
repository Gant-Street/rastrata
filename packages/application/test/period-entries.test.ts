/** The fiscal periods that hold an entry are kept current from the ledger's own new revisions
 * (`calendar/period-entries.ts`), and a period is called empty by the periods that hold an entry and the days the
 * Inbox's lines are dated on. These tests hold the set that is moved on from state to state to the set made
 * from every entry, at every state of random books, and the calendar's `empty` to what it was when every
 * entry and every day was looked at. */
import { describe, expect, test } from "bun:test";
import type { BookState } from "@rastrata/kernel";
import { periodViews } from "../src/calendar/periods.ts";
import { periodsWithEntries } from "../src/calendar/period-entries.ts";
import { MAX_EXTENSION } from "../src/reports/ledger-history.ts";
import { KernelBook } from "./support/kernel-book.ts";
import { playRandomBook } from "./support/random-book.ts";
import { sequence } from "./support/kernel-book.ts";
import { CHART } from "./support/scenario.ts";

const whole = (state: BookState): string[] =>
  [...new Set(state.journals.map((booked) => String(booked.fiscalPeriodId)))].sort();
const sorted = (ids: ReadonlySet<string>): string[] => [...ids].sort();

describe("the periods that hold an entry", () => {
  for (const seed of [901, 902, 903, 904])
    test(`kept current from state to state they are the periods of every entry (seed ${seed})`, () => {
      let visited = 0;
      playRandomBook({
        seed,
        steps: 160,
        sources: true,
        onState: ({ state }) => {
          expect(sorted(periodsWithEntries(state)), `seed ${seed} step ${visited}`).toEqual(
            whole(state),
          );
          visited += 1;
        },
      });
      expect(visited).toBe(160);
    });

  test("states read a few commands apart and out of order give the periods of the book", () => {
    for (const [which, gap] of [3, 11, 40].entries()) {
      const states: BookState[] = [];
      playRandomBook({ seed: 910 + which, steps: 200, onState: ({ state }) => states.push(state) });
      for (const state of states.filter((_, at) => at % gap === 0))
        expect(sorted(periodsWithEntries(state))).toEqual(whole(state));
      const last = states.at(-1) as BookState;
      expect(sorted(periodsWithEntries(last))).toEqual(whole(last));
      // An older state is made from nothing, and does not displace the newest.
      expect(sorted(periodsWithEntries(states[3] as BookState))).toEqual(
        whole(states[3] as BookState),
      );
      expect(sorted(periodsWithEntries(last))).toEqual(whole(last));
    }
  });

  test("the book has an entry exactly when its posting sequence is past zero", () => {
    for (const seed of [931, 932]) {
      let seen = 0;
      playRandomBook({
        seed,
        steps: 80,
        onState: ({ state }) => {
          expect(state.latestPostingSequence > 0n).toBe(state.journals.length > 0);
          expect(BigInt(state.journals.length)).toBe(state.latestPostingSequence);
          seen += 1;
        },
      });
      expect(seen).toBe(80);
    }
  });

  test("a state a great many commands on is made from the state", () => {
    const book = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART, chainHead: true });
    book.post("2025-03-01", [
      ["1000", 100n],
      ["4000", -100n],
    ]);
    expect(sorted(periodsWithEntries(book.state))).toEqual(whole(book.state));
    for (let step = 0; step < MAX_EXTENSION + 2; step += 1)
      book.post("2025-07-01", [
        ["1000", 100n],
        ["4000", -100n],
      ]);
    expect(sorted(periodsWithEntries(book.state))).toEqual(whole(book.state));
    expect(periodsWithEntries(book.state).size).toBe(2);
  });
});

describe("a period the calendar calls empty", () => {
  /** What it was when every entry and every day was looked at. */
  function reference(state: BookState, days: readonly string[] | null): boolean[] {
    const withEntries = new Set(state.journals.map((item) => String(item.fiscalPeriodId)));
    const ordered = [...state.periods].sort(
      (left, right) =>
        (left.startsOn < right.startsOn ? -1 : left.startsOn > right.startsOn ? 1 : 0) ||
        Number(left.sequence - right.sequence),
    );
    return ordered.map(
      (period) =>
        !withEntries.has(String(period.id)) &&
        days !== null &&
        !days.some((day) => day >= period.startsOn && day <= period.endsOn),
    );
  }

  test("is empty exactly when no entry and no day of the Inbox is in it, in order or not", () => {
    const random = sequence(921);
    const below = (count: number) => Math.floor(random() * count);
    let empty = 0;
    let held = 0;
    playRandomBook({
      seed: 922,
      steps: 120,
      onState: ({ state, step }) => {
        if (step % 6 !== 0) return;
        const days = Array.from(
          { length: below(8) },
          () =>
            `202${5 + below(3)}-${String(1 + below(12)).padStart(2, "0")}-${String(1 + below(28)).padStart(2, "0")}`,
        );
        const inOrder = [...days].sort();
        const shuffled = [...days];
        for (const variant of [null, [], inOrder, shuffled]) {
          const got = periodViews(state, "2026-06-01", null, variant).map((view) => view.empty);
          expect(got, `step ${step}`).toEqual(reference(state, variant));
          for (const flag of got)
            if (flag) empty += 1;
            else held += 1;
        }
      },
    });
    // Both kinds of period were in the books.
    expect(empty).toBeGreaterThan(20);
    expect(held).toBeGreaterThan(20);
  });
});

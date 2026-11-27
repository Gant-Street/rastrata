/** The entries a bank line might already be, found by account and amount, are kept current from the ledger's
 * own new revisions. These tests hold the index that is moved on from state to state to the index made from
 * the whole of the state, at every state of random books: backdated postings, reversals, superseding
 * corrections, closes, reopens, new accounts and entries with several lines on one account; read a state at a
 * time, a few states apart, and out of order. */
import { describe, expect, test } from "bun:test";
import type { BookState } from "@rastrata/kernel";
import { addDays, daysBetween } from "../src/ingest/text.ts";
import type { JournalCandidate, JournalQuery } from "../src/ingest-types.ts";
import { formatMoney } from "../src/money.ts";
import {
  type MatchIndex,
  buildMatchIndex,
  matchIndexFor,
} from "../src/slices/ingest/match-index.ts";
import { MAX_EXTENSION } from "../src/reports/ledger-history.ts";
import { KernelBook } from "./support/kernel-book.ts";
import { playRandomBook } from "./support/random-book.ts";
import { CHART } from "./support/scenario.ts";

/** What the matcher used to build at every reading, from the whole book: the entries in effect by account
 * and amount, with the lines' entries left out. The index that is kept current must answer every question as
 * this does. */
class ReferenceIndex {
  private readonly byKey = new Map<string, JournalCandidate[]>();

  constructor(
    state: BookState,
    private readonly excluded: ReadonlySet<string>,
  ) {
    const dates = new Map(
      state.journals.map((booked) => [booked.journal.id as string, booked.journal.accountingDate]),
    );
    const skip = new Set<string>();
    for (const link of state.corrections) {
      if (link.kind === "supersession" && dates.has(link.correctionJournalId))
        skip.add(link.originalJournalId);
      if (link.kind === "reversal") {
        skip.add(link.originalJournalId);
        skip.add(link.correctionJournalId);
      }
    }
    for (const booked of state.journals) {
      const id = booked.journal.id as string;
      if (skip.has(id) || excluded.has(id)) continue;
      const sums = new Map<string, bigint>();
      for (const posting of booked.journal.postings)
        sums.set(
          posting.accountId,
          (sums.get(posting.accountId) ?? 0n) + posting.bookValue.amount.coefficient,
        );
      for (const [accountId, cents] of sums) {
        const key = `${accountId}|${cents}`;
        const list = this.byKey.get(key) ?? [];
        list.push({
          id,
          date: booked.journal.accountingDate as string,
          amount: formatMoney(cents),
          narration: booked.journal.narration,
        });
        this.byKey.set(key, list);
      }
    }
  }

  near(query: JournalQuery): readonly JournalCandidate[] {
    const cents = BigInt(query.amount.replace(".", ""));
    const list = this.byKey.get(`${query.accountId}|${cents}`) ?? [];
    return list
      .filter(
        (candidate) =>
          candidate.date >= query.from &&
          candidate.date <= query.to &&
          !this.excluded.has(candidate.id),
      )
      .sort(
        (left, right) =>
          Math.abs(daysBetween(query.around ?? query.from, left.date)) -
            Math.abs(daysBetween(query.around ?? query.from, right.date)) ||
          (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      )
      .slice(0, query.limit ?? 20);
  }
}

/** Questions a line could ask of the book at this state: every account and amount an entry posts, over
 * a window that takes in the whole year, and a narrow one around each entry's own date. */
function questions(state: BookState): JournalQuery[] {
  const asked: JournalQuery[] = [];
  for (const booked of state.journals.slice(-12)) {
    const date = booked.journal.accountingDate as string;
    for (const posting of booked.journal.postings)
      asked.push(
        {
          accountId: posting.accountId,
          amount: formatMoney(posting.bookValue.amount.coefficient),
          from: "2025-01-01",
          to: "2026-12-31",
          around: date,
        },
        {
          accountId: posting.accountId,
          amount: formatMoney(posting.bookValue.amount.coefficient),
          from: addDays(date, -3),
          to: addDays(date, 3),
          limit: 1,
        },
      );
  }
  return asked;
}

/** An index as plain data: what is in effect, and what is known. */
function plain(index: MatchIndex, state: BookState) {
  return {
    live: index.live,
    keys: index.snapshot(),
    known: state.journals.map((booked) => index.has(booked.journal.id as string)),
    position: index.position.revision,
  };
}

describe("the index of entries a line might be", () => {
  for (const seed of [401, 402, 403, 404])
    test(`kept current from state to state it is the index made from the book (seed ${seed})`, () => {
      let visited = 0;
      playRandomBook({
        seed,
        steps: 160,
        sources: true,
        onState: ({ state }) => {
          const kept = matchIndexFor(state);
          expect(plain(kept, state), `seed ${seed} step ${visited}`).toEqual(
            plain(buildMatchIndex(state), state),
          );
          // And it answers as the matcher's old index did, with some entries linked to lines.
          const linked = new Set(
            state.journals
              .filter((_, at) => (at + visited) % 5 === 0)
              .map((booked) => booked.journal.id as string),
          );
          const reference = new ReferenceIndex(state, linked);
          for (const question of questions(state))
            expect(kept.near(question, (id) => linked.has(id))).toEqual(reference.near(question));
          visited += 1;
        },
      });
      expect(visited).toBe(160);
    });

  test("states read a few commands apart and out of order give the same index as the book", () => {
    for (const [which, gap] of [3, 11, 40].entries()) {
      const states: BookState[] = [];
      playRandomBook({ seed: 410 + which, steps: 200, onState: ({ state }) => states.push(state) });
      for (const state of states.filter((_, at) => at % gap === 0))
        expect(plain(matchIndexFor(state), state)).toEqual(plain(buildMatchIndex(state), state));
      // The newest, then an older one, which is made from nothing and does not displace the newest.
      const last = states.at(-1) as BookState;
      expect(plain(matchIndexFor(last), last)).toEqual(plain(buildMatchIndex(last), last));
      const early = states[3] as BookState;
      expect(plain(matchIndexFor(early), early)).toEqual(plain(buildMatchIndex(early), early));
      const again = matchIndexFor(last);
      expect(again.position.revision).toBe(last.bookRevision);
      expect(plain(again, last)).toEqual(plain(buildMatchIndex(last), last));
    }
  });

  test("a posting is taken in and a reversal takes both entries out, without starting over", () => {
    const book = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART, chainHead: true });
    const first = book.post("2025-03-01", [
      ["1000", 500n],
      ["4000", -500n],
    ]);
    const index = matchIndexFor(book.state);
    expect(index.live).toBe(1);
    const second = book.post("2025-03-03", [
      ["1000", 500n],
      ["4000", -500n],
    ]);
    // The same object, moved on.
    expect(matchIndexFor(book.state)).toBe(index);
    expect(index.live).toBe(2);
    const near = (around: string) =>
      index.near(
        { accountId: "1000", amount: "5.00", from: "2025-02-20", to: "2025-03-10", around },
        () => false,
      );
    expect(near("2025-03-03").map((entry) => entry.id)).toEqual([second, first]);
    expect(near("2025-03-01").map((entry) => entry.id)).toEqual([first, second]);
    // One that is linked to a line is not offered to another.
    expect(
      index
        .near(
          { accountId: "1000", amount: "5.00", from: "2025-02-20", to: "2025-03-10" },
          (id) => id === first,
        )
        .map((entry) => entry.id),
    ).toEqual([second]);
    const reversal = book.tryReverse(first, "2025-03-04");
    expect(reversal).not.toBeNull();
    expect(matchIndexFor(book.state)).toBe(index);
    // The entry and its reversal are both out; the one that was not reversed stays.
    expect(index.live).toBe(1);
    expect(near("2025-03-03").map((entry) => entry.id)).toEqual([second]);
    // They are still known, with what they posted, so a reader can say which lines they could have touched.
    expect(index.has(first)).toBe(true);
    expect(index.entriesOf(first)?.map((entry) => entry.accountId)).toEqual(["1000", "4000"]);
    expect(index.journal(String(reversal))).toBeDefined();
  });

  test("a state a great many commands on, or another book's, is made from the state", () => {
    const book = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART, chainHead: true });
    book.post("2025-03-01", [
      ["1000", 100n],
      ["4000", -100n],
    ]);
    const index = matchIndexFor(book.state);
    for (let step = 0; step < MAX_EXTENSION + 2; step += 1)
      book.post("2025-04-01", [
        ["1000", 100n],
        ["4000", -100n],
      ]);
    const later = matchIndexFor(book.state);
    expect(later).not.toBe(index);
    expect(later.live).toBe(MAX_EXTENSION + 3);
    const other = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART, chainHead: true });
    other.post("2025-03-01", [
      ["1000", 100n],
      ["4000", -100n],
    ]);
    expect(matchIndexFor(other.state).live).toBe(1);
  });
});

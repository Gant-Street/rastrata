/** The report views are made from the view of the state before, not from nothing. These tests hold
 * that to account on random books: the view made incrementally says exactly what a view made from
 * nothing says, for every state, in every order the states are read in, through backdated postings,
 * reversals, superseding corrections, closes, reopens and configuration changes; the kernel's balances
 * are carried forward the way the kernel works them out; and a report after a posting does not start
 * over. (Byte for byte against the compiler that existed before is `reports-golden.test.ts`.) */
import { describe, expect, test } from "bun:test";
import {
  bookHistoryMaterializations,
  rebuildAccountBalanceProjection,
  type BookState,
  type BookedJournal,
  type RevisionRecord,
} from "@rastrata/kernel";
import { compileCoreReports, reportingWindow } from "../src/reports.ts";
import { chartAccounts, configurationAt } from "../src/reports/chart.ts";
import { fiscalCalendar } from "../src/reports/calendar.ts";
import { addMonths } from "../src/reports/dates.ts";
import { MAX_EXTENSION, positionOf, revisionsAfter } from "../src/reports/ledger-history.ts";
import { extendProjection, projectionFromHistory } from "../src/reports/ledger-projection.ts";
import { PostingSeries } from "../src/reports/ledger-series.ts";
import { LedgerView, accumulate, ledgerView, ledgerViewCounts } from "../src/reports/ledger.ts";
import { failure } from "./support/helpers.ts";
import { KernelBook } from "./support/kernel-book.ts";
import { playRandomBook } from "./support/random-book.ts";
import { CHART } from "./support/scenario.ts";

const counted = <T>(work: () => T): { value: T; made: ReturnType<typeof ledgerViewCounts> } => {
  const before = ledgerViewCounts();
  const value = work();
  const after = ledgerViewCounts();
  return {
    value,
    made: {
      built: after.built - before.built,
      extended: after.extended - before.extended,
      seriesBuilt: after.seriesBuilt - before.seriesBuilt,
      projectionsFromHistory: after.projectionsFromHistory - before.projectionsFromHistory,
      projectionsVouched: after.projectionsVouched - before.projectionsVouched,
      projectionsExtended: after.projectionsExtended - before.projectionsExtended,
    },
  };
};

/** The cutoffs, year starts and range starts a report could use on a state's calendar. */
function probes(state: BookState): { cutoff: string; yearStart: string; rangeStart: string }[] {
  const { firstDate, lastDate } = reportingWindow(state);
  const calendar = fiscalCalendar(state.periods);
  const dates = [
    firstDate,
    addMonths(firstDate, 3),
    addMonths(firstDate, 8),
    addMonths(firstDate, 14),
    addMonths(firstDate, 20),
    lastDate,
  ].filter((date) => date >= firstDate && date <= lastDate);
  return dates.flatMap((cutoff) => {
    const yearStart = calendar.yearOf(cutoff)?.startsOn ?? firstDate;
    return [yearStart, `${cutoff.slice(0, 7)}-01`, firstDate, cutoff].map((rangeStart) => ({
      cutoff,
      yearStart,
      rangeStart,
    }));
  });
}

const nonzero = (map: ReadonlyMap<string, bigint>) =>
  [...map].filter(([, cents]) => cents !== 0n).sort(([left], [right]) => (left < right ? -1 : 1));

/** What the old way says: add up every included posting one at a time. */
function oneByOne(
  view: LedgerView,
  state: BookState,
  probe: { cutoff: string; yearStart: string; rangeStart: string },
) {
  const ids = new Set(chartAccounts(configurationAt(state, probe.cutoff)).map((a) => a.id));
  const included = view.included(probe.cutoff);
  return {
    included,
    ids,
    accumulated: accumulate(state, included.journals, ids, probe.yearStart, probe.rangeStart),
  };
}

/** Two views of the same state agree on everything a report reads from them. */
function expectSame(made: LedgerView, fromNothing: LedgerView, state: BookState, label: string) {
  expect(made.latestJournalDate, label).toBe(fromNothing.latestJournalDate);
  for (const probe of probes(state)) {
    const expected = oneByOne(fromNothing, state, probe);
    const actual = made.included(probe.cutoff);
    expect(actual.complete, `${label} complete ${probe.cutoff}`).toBe(expected.included.complete);
    expect(actual.journals.length, `${label} included ${probe.cutoff}`).toBe(
      expected.included.journals.length,
    );
    // The same journals in the same order. (Not the same objects: a view extended from a revision holds
    // the journal that revision recorded, which the kernel keeps as a frozen copy of the one in the
    // state's list. They hold the same facts, which their hashes say.)
    for (const [index, booked] of expected.included.journals.entries()) {
      const got = actual.journals[index] as BookedJournal;
      expect(
        [got.journal.id, got.postingSequence, got.canonicalHash.digest],
        `${label} journal ${index} of ${probe.cutoff}`,
      ).toEqual([booked.journal.id, booked.postingSequence, booked.canonicalHash.digest]);
    }
    const { accumulated, complete } = made.accumulated(
      probe.cutoff,
      probe.yearStart,
      probe.rangeStart,
      expected.ids,
    );
    expect(complete, `${label} accumulated complete ${probe.cutoff}`).toBe(
      expected.included.complete,
    );
    for (const part of ["cumulative", "yearToDate", "range"] as const)
      expect(nonzero(accumulated[part]), `${label} ${part} ${JSON.stringify(probe)}`).toEqual(
        nonzero(expected.accumulated[part]),
      );
    expect(made.configurationAt(probe.cutoff), label).toBe(configurationAt(state, probe.cutoff));
  }
}

/** The kernel's balances in cents, which is what a report's totals are compared with. */
function kernelCents(revisions: readonly RevisionRecord[]): Map<string, bigint> {
  const rebuilt = rebuildAccountBalanceProjection(revisions);
  if (rebuilt.disposition !== "rebuilt") throw new Error("the kernel refused the history");
  return new Map(
    rebuilt.checkpoint.accountBalances.map((row) => {
      expect((row.balance.numerator * 100n) % row.balance.denominator).toBe(0n);
      return [row.accountId as string, (row.balance.numerator * 100n) / row.balance.denominator];
    }),
  );
}

const SEEDS = [11, 12, 13, 14, 15, 16];

describe("a view made from the view before says what a view made from nothing says", () => {
  for (const seed of SEEDS)
    test(`every state of a random book, seed ${seed}`, () => {
      let visited = 0;
      const checked = new Set<LedgerView>();
      playRandomBook({
        seed,
        steps: 120,
        onState: ({ state, step }) => {
          const made = ledgerView(state);
          expectSame(made, new LedgerView(state), state, `seed ${seed} step ${step}`);
          visited += 1;
          // A refused command leaves the state as it was, and a state is checked once.
          if (checked.has(made)) return;
          checked.add(made);
          // The kernel's balances against the report's, and against a drifted copy of them.
          const cents = kernelCents(state.revisions);
          const drifted = new Map(cents);
          const [account] = [...cents.keys()];
          if (account !== undefined) {
            drifted.set(account, (drifted.get(account) ?? 0n) + 1n);
            expect(failure(() => made.verifyAgainstKernel(drifted)).code).toBe(
              "report_integrity_failure",
            );
          }
          expect(() => made.verifyAgainstKernel(cents)).not.toThrow();
        },
      });
      expect(visited).toBe(120);
      expect(checked.size).toBeGreaterThan(90);
    });

  test("states read now and then, several commands apart, and a book read all at once at the end", () => {
    // Gaps of a few commands (put in one at a time) and of dozens (merged in).
    const gaps = [7, 19, 41, 97, 3, 13];
    for (const [which, seed] of SEEDS.entries()) {
      const states: BookState[] = [];
      playRandomBook({ seed, steps: 300, onState: ({ state }) => states.push(state) });
      const gap = gaps[which] as number;
      const sparse = states.filter((_, index) => index % gap === 0);
      for (const state of sparse)
        expectSame(ledgerView(state), new LedgerView(state), state, `seed ${seed} gap ${gap}`);
      // Only the last, with nothing before it to extend (a different book).
      const last = states.at(-1) as BookState;
      expectSame(ledgerView(last), new LedgerView(last), last, `seed ${seed} last`);
    }
  });

  test("the states of two books read turn about do not borrow from each other", () => {
    const first: BookState[] = [];
    const second: BookState[] = [];
    playRandomBook({ seed: 21, steps: 60, onState: ({ state }) => first.push(state) });
    playRandomBook({ seed: 22, steps: 60, onState: ({ state }) => second.push(state) });
    for (let index = 0; index < 60; index += 3)
      for (const state of [first[index], second[index]] as BookState[])
        expectSame(ledgerView(state), new LedgerView(state), state, `turn ${index}`);
  });
});

describe("what a read after a posting costs", () => {
  test("it extends the view before it and rebuilds nothing", () => {
    // One book, read after every command from the first: one view from nothing, the rest extended.
    const { made } = counted(() =>
      playRandomBook({
        seed: 32,
        steps: 150,
        onState: ({ state }) => compileCoreReports(state, reportingWindow(state).lastDate),
      }),
    );
    expect(made.built).toBe(1);
    expect(made.seriesBuilt).toBe(1);
    expect(made.projectionsFromHistory).toBe(1);
    expect(made.extended).toBeGreaterThan(100);
    // Every extension that had a command to apply carried the kernel's balances forward.
    expect(made.projectionsExtended).toBeGreaterThan(100);
  });

  test("it does not copy the history of the state it reads", () => {
    const book = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART });
    for (let day = 1; day <= 20; day += 1)
      book.post(`2025-03-${String(day).padStart(2, "0")}`, [
        ["1000", BigInt(day) * 100n],
        ["4000", -BigInt(day) * 100n],
      ]);
    compileCoreReports(book.state, "2025-12-31");
    const before = bookHistoryMaterializations();
    for (let day = 1; day <= 30; day += 1) {
      book.post(`2025-04-${String(day).padStart(2, "0")}`, [
        ["6000", BigInt(day) * 10n],
        ["1000", -BigInt(day) * 10n],
      ]);
      compileCoreReports(book.state, "2025-12-31");
    }
    // Reading a built state's journals or revisions copies and freezes the whole list, once per state:
    // O(n) a posting. A view made from the one before reads neither.
    expect(bookHistoryMaterializations() - before).toBe(0);
  });

  test("a state many commands on is made from the view before when that is cheaper, and from nothing when it is not", () => {
    const book = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART, chainHead: true });
    book.post("2025-02-01", [
      ["1000", 100n],
      ["4000", -100n],
    ]);
    compileCoreReports(book.state, "2025-12-31");
    // Backdated, so that putting them in date order is a merge and not an append.
    const advance = (count: number) => {
      for (let index = 0; index < count; index += 1)
        book.post(`2025-0${1 + (index % 9)}-1${index % 9}`, [
          ["1000", 5n],
          ["4000", -5n],
        ]);
    };
    advance(MAX_EXTENSION);
    const near = counted(() => compileCoreReports(book.state, "2025-12-31"));
    expect(near.made).toMatchObject({ built: 0, extended: 1, seriesBuilt: 0 });
    expectSame(ledgerView(book.state), new LedgerView(book.state), book.state, "merged");
    advance(MAX_EXTENSION + 1);
    const far = counted(() => compileCoreReports(book.state, "2025-12-31"));
    expect(far.made).toMatchObject({ built: 1, extended: 0, seriesBuilt: 1 });
    // Either way the same figures: 1.00 and 2,049 postings of 0.05.
    expect(far.value.trialBalance.rows.find((r) => r.code === "1000")?.signedBalance).toBe(
      "103.45",
    );
  });

  test("a state that branches off does not cost the next state its view", () => {
    const book = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART });
    book.post("2025-02-01", [
      ["1000", 100n],
      ["4000", -100n],
    ]);
    const other = book.fork();
    compileCoreReports(book.state, "2025-12-31");
    book.post("2025-02-02", [
      ["1000", 7n],
      ["4000", -7n],
    ]);
    const preview = book.state;
    compileCoreReports(preview, "2025-12-31");
    // The branch is thrown away; the real next command is another one, at the same revision.
    other.post("2025-02-03", [
      ["1000", 9n],
      ["4000", -9n],
    ]);
    const { made, value } = counted(() => compileCoreReports(other.state, "2025-12-31"));
    expect(made).toMatchObject({ built: 0, extended: 1 });
    expect(value.trialBalance.rows.find((r) => r.code === "1000")?.signedBalance).toBe("1.09");
    expectSame(ledgerView(other.state), new LedgerView(other.state), other.state, "branch");
  });

  test("a state older than the newest is made from nothing and leaves the newest views alone", () => {
    const states: BookState[] = [];
    playRandomBook({ seed: 41, steps: 60, onState: ({ state }) => states.push(state) });
    for (const state of states.slice(20, 59)) ledgerView(state);
    const early = states[5] as BookState;
    const old = counted(() => ledgerView(early));
    expect(old.made.built).toBe(1);
    expectSame(old.value, new LedgerView(early), early, "old");
    // The views the lineage keeps are still the newest, so the next state extends one of them.
    const next = counted(() => ledgerView(states[59] as BookState));
    expect(next.made.built).toBe(0);
  });
});

describe("posting series", () => {
  const journal = (
    date: string,
    lines: readonly (readonly [string, bigint])[],
    options: { commodity?: string; scale?: bigint } = {},
  ) =>
    ({
      journal: {
        accountingDate: date,
        postings: lines.map(([account, cents]) => ({
          accountId: account,
          bookValue: {
            functionalCommodityId: options.commodity ?? "USD",
            amount: { coefficient: cents, scale: options.scale ?? 2n },
          },
        })),
      },
    }) as unknown as BookedJournal;
  const ids = new Set(["a", "b", "c"]);

  test("sums by account for the whole set, the fiscal year and the range, with ends included", () => {
    const series = PostingSeries.of(
      [
        journal("2024-12-31", [
          ["a", 100n],
          ["b", -100n],
        ]),
        journal("2025-01-01", [
          ["a", 10n],
          ["b", -10n],
        ]),
        journal("2025-01-01", [
          ["a", 1n],
          ["c", -1n],
        ]),
        journal("2025-03-15", [
          ["a", 1000n],
          ["b", -1000n],
        ]),
        journal("2025-06-30", [
          ["b", 5n],
          ["c", -5n],
        ]),
      ],
      "USD",
    );
    const figures = series.figures("2025-03-15", "2025-01-01", "2025-03-15", ids);
    expect(figures.cumulative).toEqual(
      new Map([
        ["a", 1111n],
        ["b", -1110n],
        ["c", -1n],
      ]),
    );
    expect(figures.yearToDate).toEqual(
      new Map([
        ["a", 1011n],
        ["b", -1010n],
        ["c", -1n],
      ]),
    );
    expect(figures.range).toEqual(
      new Map([
        ["a", 1000n],
        ["b", -1000n],
      ]),
    );
    // A cutoff before everything has nothing; one after everything has all of it.
    expect(series.figures("2024-12-30", "2024-01-01", "2024-01-01", ids).cumulative.size).toBe(0);
    expect(series.figures("2025-12-31", "2025-01-01", "2025-01-01", ids).cumulative.get("c")).toBe(
      -6n,
    );
  });

  test("adding journals in any order gives the series of all of them", () => {
    const all = [
      journal("2025-01-05", [
        ["a", 7n],
        ["b", -7n],
      ]),
      journal("2025-01-05", [
        ["a", 3n],
        ["c", -3n],
      ]),
      journal("2025-01-02", [
        ["b", 4n],
        ["c", -4n],
      ]),
      journal("2025-02-09", [
        ["a", -11n],
        ["c", 11n],
      ]),
      journal("2024-11-30", [
        ["c", 13n],
        ["a", -13n],
      ]),
      journal("2025-01-05", [
        ["a", 1n],
        ["b", -1n],
      ]),
    ];
    const byDate = [...all].sort((left, right) =>
      left.journal.accountingDate < right.journal.accountingDate ? -1 : 1,
    );
    const expected = PostingSeries.of(byDate, "USD");
    let grown = PostingSeries.of([], "USD");
    for (const one of all) grown = grown.extend([one]);
    const lumped = PostingSeries.of(all.slice(0, 2), "USD").extend(all.slice(2));
    for (const built of [grown, lumped])
      for (const cutoff of ["2024-11-29", "2024-11-30", "2025-01-02", "2025-01-05", "2025-02-09"])
        for (const start of ["2024-01-01", "2025-01-02", "2025-01-05", "2025-02-01"])
          expect(built.figures(cutoff, start, start, ids), `${cutoff} ${start}`).toEqual(
            expected.figures(cutoff, start, start, ids),
          );
  });

  test("the series it grew from is not changed by the one grown from it", () => {
    const first = PostingSeries.of(
      [
        journal("2025-01-05", [
          ["a", 7n],
          ["b", -7n],
        ]),
      ],
      "USD",
    );
    const second = first.extend([
      journal("2025-01-01", [
        ["a", 100n],
        ["b", -100n],
      ]),
    ]);
    expect(first.figures("2025-12-31", "2025-01-01", "2025-01-01", ids).cumulative.get("a")).toBe(
      7n,
    );
    expect(second.figures("2025-12-31", "2025-01-01", "2025-01-01", ids).cumulative.get("a")).toBe(
      107n,
    );
    expect(first.extend([])).toBe(first);
  });

  test("a posting a report cannot read, or on an account it does not know, fails as reading it would", () => {
    const odd = PostingSeries.of(
      [
        journal("2025-01-05", [
          ["a", 1n],
          ["b", -1n],
        ]),
        journal("2025-02-05", [["a", 1n]], { scale: 3n }),
      ],
      "USD",
    );
    expect(() => odd.figures("2025-02-04", "2025-01-01", "2025-01-01", ids)).not.toThrow();
    expect(() => odd.figures("2025-02-05", "2025-01-01", "2025-01-01", ids)).toThrow(
      "Unsupported report currency scale",
    );
    const foreign = PostingSeries.of(
      [journal("2025-01-05", [["a", 1n]], { commodity: "EUR" })],
      "USD",
    );
    expect(() => foreign.figures("2025-01-05", "2025-01-01", "2025-01-01", ids)).toThrow(
      "Unsupported report currency scale",
    );
    const grown = PostingSeries.of([], "USD").extend([
      journal("2025-03-01", [["a", 1n]], { scale: 0n }),
    ]);
    expect(() => grown.figures("2025-02-28", "2025-01-01", "2025-01-01", ids)).not.toThrow();
    expect(() => grown.figures("2025-03-01", "2025-01-01", "2025-01-01", ids)).toThrow(
      "Unsupported report currency scale",
    );
    const stranger = PostingSeries.of([journal("2025-01-05", [["zz", 1n]])], "USD");
    expect(() => stranger.figures("2025-01-04", "2025-01-01", "2025-01-01", ids)).not.toThrow();
    expect(() => stranger.figures("2025-01-05", "2025-01-01", "2025-01-01", ids)).toThrow(
      "Journal references an unknown account",
    );
  });
});

describe("the hash chain tells a state that carries a book on", () => {
  const states = (): BookState[] => {
    const all: BookState[] = [];
    playRandomBook({
      seed: 51,
      steps: MAX_EXTENSION + 200,
      onState: ({ state }) => all.push(state),
    });
    return all;
  };

  test("the same position, one on, several on, and too many on", () => {
    const all = states();
    const revisionOf = (state: BookState) => positionOf(state).revision;
    const at = (revision: bigint) =>
      all.find((state) => revisionOf(state) === revision) as BookState;
    const base = positionOf(at(10n));
    expect(revisionsAfter(at(10n), base)).toEqual([]);
    const one = revisionsAfter(at(11n), base);
    expect(one?.map((revision) => revision.bookRevision)).toEqual([11n]);
    expect(revisionsAfter(at(14n), base)?.map((revision) => revision.bookRevision)).toEqual([
      11n,
      12n,
      13n,
      14n,
    ]);
    const far = all.at(-1) as BookState;
    expect(revisionOf(far) - base.revision).toBeGreaterThan(BigInt(MAX_EXTENSION));
    expect(revisionsAfter(far, base)).toBeNull();
    // From nothing: any state is the genesis plus its history, within reach.
    expect(revisionsAfter(at(3n), { revision: 0n, chainHash: null })?.length).toBe(3);
  });

  test("an earlier state, another history and another book are not carried on", () => {
    const all = states();
    const base = positionOf(all[30] as BookState);
    expect(revisionsAfter(all[5] as BookState, base)).toBeNull();
    // The same revision number with another history: a book that branched off before it.
    const book = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART });
    book.post("2025-02-01", [
      ["1000", 100n],
      ["4000", -100n],
    ]);
    const twin = book.fork();
    book.post("2025-02-02", [
      ["1000", 1n],
      ["4000", -1n],
    ]);
    twin.post("2025-02-02", [
      ["1000", 2n],
      ["4000", -2n],
    ]);
    expect(revisionsAfter(twin.state, positionOf(book.state))).toBeNull();
    twin.post("2025-02-03", [
      ["1000", 2n],
      ["4000", -2n],
    ]);
    expect(revisionsAfter(twin.state, positionOf(book.state))).toBeNull();
    const stranger = playRandomBook({ seed: 52, steps: 40 }).state;
    expect(revisionsAfter(stranger, base)).toBeNull();
  });
});

describe("the kernel's balances, carried forward", () => {
  test("the projection carried forward equals the kernel's rebuild after every revision", () => {
    for (const seed of [61, 62, 63]) {
      const book = playRandomBook({ seed, steps: 140 });
      const revisions = book.state.revisions;
      const known = new Map(
        book.state.journals.map((booked) => [booked.journal.id as string, booked]),
      );
      let carried = projectionFromHistory([]);
      expect(carried).not.toBeNull();
      for (let upTo = 1; upTo <= revisions.length; upTo += 1) {
        const before = carried as NonNullable<typeof carried>;
        carried = extendProjection(before, [revisions[upTo - 1] as RevisionRecord], (id) =>
          known.get(id),
        );
        expect(carried, `seed ${seed} revision ${upTo}`).not.toBeNull();
        const rebuilt = projectionFromHistory(revisions.slice(0, upTo));
        const now = carried as NonNullable<typeof carried>;
        expect(now.revision).toBe((rebuilt as NonNullable<typeof rebuilt>).revision);
        expect(now.postingSequence).toBe((rebuilt as NonNullable<typeof rebuilt>).postingSequence);
        expect(now.chainHash).toEqual((rebuilt as NonNullable<typeof rebuilt>).chainHash);
        // The same accounts in the same order (a failed comparison names the first of them), with
        // the same balance each.
        expect([...now.balances.keys()]).toEqual([
          ...(rebuilt as NonNullable<typeof rebuilt>).balances.keys(),
        ]);
        for (const [account, balance] of now.balances) {
          const expected = (rebuilt as NonNullable<typeof rebuilt>).balances.get(account);
          expect(balance.numerator * (expected?.denominator ?? 1n)).toBe(
            (expected?.numerator ?? 0n) * balance.denominator,
          );
        }
      }
    }
  });

  test("a run of revisions that does not hold is refused, as the kernel refuses it", () => {
    const book = playRandomBook({ seed: 64, steps: 60 });
    const revisions = book.state.revisions;
    const known = new Map(
      book.state.journals.map((booked) => [booked.journal.id as string, booked]),
    );
    const base = projectionFromHistory(revisions.slice(0, 10)) as NonNullable<
      ReturnType<typeof projectionFromHistory>
    >;
    const tail = revisions.slice(10, 20);
    expect(extendProjection(base, tail, (id) => known.get(id))).not.toBeNull();
    const first = tail[0] as RevisionRecord;
    const second = tail[1] as RevisionRecord;
    const damaged: Record<string, readonly RevisionRecord[]> = {
      "a revision left out": [first, ...tail.slice(2)],
      "two revisions swapped": [second, first, ...tail.slice(2)],
      "a revision repeated": [first, first, ...tail.slice(1)],
      "an effects hash that is not the effects'": [
        { ...first, effectsHash: second.effectsHash },
        ...tail.slice(1),
      ],
      "a chain hash that is not the chain's": [
        { ...first, chainHash: second.chainHash },
        ...tail.slice(1),
      ],
      "a revision that does not follow the one before": [
        { ...first, previousHash: second.chainHash },
        ...tail.slice(1),
      ],
      "a revision number that does not follow": [{ ...first, bookRevision: 99n }, ...tail.slice(1)],
    };
    for (const [what, run] of Object.entries(damaged)) {
      expect(
        extendProjection(base, run, (id) => known.get(id)),
        what,
      ).toBeNull();
      // The kernel, given the whole history with the same damage, refuses it too.
      const whole = [...revisions.slice(0, 10), ...run];
      expect(rebuildAccountBalanceProjection(whole).disposition, what).toBe("rejected");
    }
    // A correction whose journals cannot be found.
    const correction = revisions.find((revision) =>
      revision.effects.some((effect) => effect.type === "correction"),
    );
    expect(correction).toBeDefined();
    const at = revisions.indexOf(correction as RevisionRecord);
    const before = projectionFromHistory(revisions.slice(0, at)) as NonNullable<
      ReturnType<typeof projectionFromHistory>
    >;
    expect(
      extendProjection(before, [correction as RevisionRecord], (id) => known.get(id)),
    ).not.toBeNull();
    expect(extendProjection(before, [correction as RevisionRecord], () => undefined)).toBeNull();
  });

  test("a report is checked against the balances carried forward as it is against the kernel's own", () => {
    const book = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART });
    book.post("2025-02-01", [
      ["1000", 100n],
      ["4000", -100n],
    ]);
    ledgerView(book.state).verifyAgainstKernel(kernelCents(book.state.revisions));
    book.post("2025-02-02", [
      ["1000", 7n],
      ["4000", -7n],
    ]);
    const next = ledgerView(book.state);
    const cents = kernelCents(book.state.revisions);
    // An account the report invents, which the kernel does not have, is refused even though the
    // ones the kernel has all agree; so is a total that is off by a cent, and a missing account.
    const invented = new Map(cents).set("not-an-account", 1n);
    expect(failure(() => next.verifyAgainstKernel(invented)).code).toBe("report_integrity_failure");
    const off = new Map(cents).set("1000", (cents.get("1000") ?? 0n) - 1n);
    expect(failure(() => next.verifyAgainstKernel(off)).message).toContain("disagrees");
    const missing = new Map(cents);
    missing.delete("1000");
    expect(failure(() => next.verifyAgainstKernel(missing)).message).toContain("excluded");
    expect(() => next.verifyAgainstKernel(new Map(cents).set("not-an-account", 0n))).not.toThrow();
  });
});

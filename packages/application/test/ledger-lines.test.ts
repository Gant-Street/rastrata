/** The lines of each account by day (`reports/ledger-lines.ts`) are what the book's journals make of them, however
 * they got there, and what the general ledger and an account's register read from them is what reading every posting
 * of the book gives.
 *
 * Both are held to the way it was done before: the lines carried from state to state along a random book are
 * compared with the lines made from every journal, after each step; and the general ledger's pages and an
 * account's register, for random ranges, pages and accounts, with the same read by every posting
 * (`compileGeneralLedgerByPostings`, `accountActivityByPostings`, which are also how a book with a superseded
 * journal is read). The random books are made with and without supersessions, so that both ways are read, and
 * have entries that touch an account twice, entries dated before the newest, a calendar of years that grows and
 * accounts that are added. */
import { describe, expect, test } from "bun:test";
import type { BookState, BookedJournal } from "@rastrata/kernel";
import { ApplicationError } from "../src/errors.ts";
import {
  accountActivity,
  accountActivityByPostings,
  compileGeneralLedger,
  compileGeneralLedgerByPostings,
  postingsWalked,
} from "../src/reports/activity.ts";
import { journalBookPage, journalsScanned } from "../src/journal-book.ts";
import { LedgerView, accountLinesCounts, bookView } from "../src/reports/ledger.ts";
import { AccountLines } from "../src/reports/ledger-lines.ts";
import { reportingWindow } from "../src/reports/window.ts";
import { sequence } from "./support/kernel-book.ts";
import { linesSnapshot as snapshot } from "./support/kept-current.ts";
import { playRandomBook } from "./support/random-book.ts";

/** What a call gives, or the error it raises, as text. */
function outcome(work: () => unknown): string {
  try {
    return JSON.stringify(work(), (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
  } catch (error) {
    if (error instanceof ApplicationError) return `error ${error.code}: ${error.message}`;
    throw error;
  }
}

/** Dates in the calendar of a book, and some outside it. */
function datePool(state: BookState, random: () => number): string[] {
  const { firstDate, lastDate } = reportingWindow(state);
  const first = Number(firstDate.slice(0, 4));
  const last = Number(lastDate.slice(0, 4));
  const day = () =>
    `${first + Math.floor(random() * (last - first + 1))}-${String(1 + Math.floor(random() * 12)).padStart(2, "0")}-${String(1 + Math.floor(random() * 28)).padStart(2, "0")}`;
  return [firstDate, lastDate, ...Array.from({ length: 9 }, day), "2020-01-01", "2040-01-01"];
}

/** The reads compared at a state: some pages of the general ledger and some registers. */
function compare(state: BookState, seed: number, label: string, seen: Seen): void {
  const random = sequence(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const dates = datePool(state, random);
  const accounts = state.admissionSnapshot.accounts.map((account) => account.id as string);
  for (let round = 0; round < 8; round += 1) {
    const asOf = pick(dates);
    const from = random() < 0.5 ? undefined : pick(dates);
    const page = pick([1, 1, 2, 3, 9]);
    const query = { asOf, ...(from ? { from } : {}), page };
    const wanted = outcome(() => compileGeneralLedgerByPostings(state, query));
    expect(
      outcome(() => compileGeneralLedger(state, query)),
      `${label}: ledger ${JSON.stringify(query)}`,
    ).toBe(wanted);
    seen.ledgers += 1;
    seen.ledgerLines += wanted.startsWith("error") ? 0 : (JSON.parse(wanted).lines?.length ?? 0);
    // Mostly a range inside the report, as a screen asks for it, and now and then one that is not.
    const [low, middle, high] = [pick(dates), pick(dates), pick(dates)].sort() as [
      string,
      string,
      string,
    ];
    const register =
      random() < 0.85
        ? { accountId: pick(accounts), asOf: high, from: low, to: middle, page: pick([1, 1, 2, 3]) }
        : { accountId: pick(accounts), asOf, from: pick(dates), to: pick(dates), page: 1 };
    const expected = outcome(() => accountActivityByPostings(state, register));
    expect(
      outcome(() => accountActivity(state, register)),
      `${label}: register ${JSON.stringify(register)}`,
    ).toBe(expected);
    seen.registers += 1;
    seen.registerRows += expected.startsWith("error")
      ? 0
      : (JSON.parse(expected).rows?.length ?? 0);
  }
}

interface Seen {
  ledgers: number;
  ledgerLines: number;
  registers: number;
  registerRows: number;
  compared: number;
  superseded: number;
}

describe("the lines of each account by day", () => {
  for (const [seed, noSupersession] of [
    [301, true],
    [302, true],
    [303, true],
    [304, false],
    [305, false],
    [306, true],
  ] as const)
    test(`are what the journals make of them after every step of a random book, and the ledger and the registers read from them what every posting gives (seed ${seed}${noSupersession ? "" : ", with supersessions"})`, () => {
      const seen: Seen = {
        ledgers: 0,
        ledgerLines: 0,
        registers: 0,
        registerRows: 0,
        compared: 0,
        superseded: 0,
      };
      const book = playRandomBook({
        seed,
        steps: 260,
        sources: true,
        noSupersession,
        onState: ({ state, step }) => {
          const view = bookView(state);
          // Carried from the state before when one step comes after another; made when it is first asked for.
          const kept = view.accountLines();
          if (step % 9 !== 0 && step < 258) return;
          expect(snapshot(kept), `step ${step}: the lines`).toBe(
            snapshot(AccountLines.of(new LedgerView(state).journalsByDate())),
          );
          seen.compared += 1;
          seen.superseded += view.hasSupersessions ? 1 : 0;
          compare(state, seed * 1000 + step, `seed ${seed} step ${step}`, seen);
        },
      });
      expect(book.state.journals.length).toBeGreaterThan(100);
      // The comparison is worth something: many pages with lines on them, registers with rows, and in the books
      // with supersessions the states that are read by their postings.
      expect(seen.compared).toBeGreaterThan(25);
      expect(seen.ledgerLines).toBeGreaterThan(300);
      expect(seen.registerRows).toBeGreaterThan(50);
      expect(seen.superseded > 0).toBe(!noSupersession);
    });

  test("are made again, and the same, when a great many journals come at once", () => {
    // The view of the state at step 12 is asked for, and then the view of a state 200 steps on: far more journals
    // than are carried one by one.
    const views: LedgerView[] = [];
    const states: BookState[] = [];
    playRandomBook({
      seed: 311,
      steps: 220,
      noSupersession: true,
      onState: ({ state, step }) => {
        if (step === 12 || step === 220) states.push(state);
      },
    });
    for (const state of states) {
      const view = bookView(state);
      views.push(view);
      expect(snapshot(view.accountLines())).toBe(
        snapshot(AccountLines.of(new LedgerView(state).journalsByDate())),
      );
    }
    expect(
      (states[1] as BookState).journals.length - (states[0] as BookState).journals.length,
    ).toBeGreaterThan(128);
  });

  test("make a read after a posting a look at the lines and not a pass over the postings: they are made once and carried, and no posting is walked", () => {
    let reads = 0;
    let carried = 0;
    let first = true;
    const base = {
      walked: postingsWalked(),
      scanned: journalsScanned(),
      counts: accountLinesCounts(),
    };
    let before = base;
    let lastState: BookState | undefined;
    playRandomBook({
      seed: 321,
      steps: 400,
      noSupersession: true,
      onState: ({ state, step }) => {
        if (step < 150) return;
        const { lastDate } = reportingWindow(state);
        const firstDay = `${lastDate.slice(0, 4)}-01-01`;
        compileGeneralLedger(state, { asOf: lastDate, page: 1 });
        accountActivity(state, {
          accountId: "1000",
          asOf: lastDate,
          from: firstDay,
          to: lastDate,
          page: 1,
        });
        // The Journal's first page and its search by an account and a month, of a book with nothing waiting.
        for (const query of [
          { page: 1, text: "", from: "", to: "", accountId: "", status: "" },
          { page: 1, text: "", from: firstDay, to: lastDate, accountId: "1000", status: "" },
        ])
          journalBookPage({
            state,
            view: bookView(state),
            drafts: [],
            referenceOf: () => undefined,
            accountLabel: new Map(),
            query,
          });
        if (state === lastState) return;
        lastState = state;
        reads += 1;
        const counts = accountLinesCounts();
        // The first look at a book makes the lines, and every look after it carries them to the new state.
        expect(counts.built - before.counts.built, `step ${step}: lines made`).toBe(first ? 1 : 0);
        if (!first) carried += counts.extended - before.counts.extended;
        expect(postingsWalked() - before.walked, `step ${step}: postings walked`).toBe(0);
        expect(journalsScanned() - before.scanned, `step ${step}: journals scanned`).toBe(0);
        first = false;
        before = { walked: postingsWalked(), scanned: journalsScanned(), counts };
      },
    });
    expect(reads).toBeGreaterThan(100);
    expect(carried).toBeGreaterThan(50);
    expect(postingsWalked()).toBe(base.walked);
    expect(journalsScanned()).toBe(base.scanned);
    // The reference does walk them, which is what the count is worth.
    const book = playRandomBook({ seed: 321, steps: 60, noSupersession: true });
    const { lastDate } = reportingWindow(book.state);
    compileGeneralLedgerByPostings(book.state, { asOf: lastDate, page: 1 });
    expect(postingsWalked()).toBeGreaterThan(base.walked);
  });

  test("keep what an older value saw: adding a posting to a day does not change the lines it was added to", () => {
    const states: BookState[] = [];
    playRandomBook({
      seed: 312,
      steps: 200,
      noSupersession: true,
      onState: ({ state, step }) => {
        if (step === 200) states.push(state);
      },
    });
    const journals = (states[0] as BookState).journals;
    const byDate = (left: BookedJournal, right: BookedJournal): number =>
      left.journal.accountingDate < right.journal.accountingDate
        ? -1
        : left.journal.accountingDate > right.journal.accountingDate
          ? 1
          : left.postingSequence < right.postingSequence
            ? -1
            : 1;
    const first = journals.slice(0, 80);
    const lines = AccountLines.of([...first].sort(byDate));
    // A later entry that is dated on a day an account it touches already has a posting on, which is the case that
    // adds to a list that the lines before share.
    const same = journals
      .slice(80)
      .find((booked) =>
        booked.journal.postings.some((posting) =>
          lines.account(posting.accountId)?.dates.includes(booked.journal.accountingDate),
        ),
      );
    expect(same).toBeDefined();
    const before = snapshot(lines);
    const next = lines.extend([same as BookedJournal]);
    expect(snapshot(lines)).toBe(before);
    expect(snapshot(next)).toBe(
      snapshot(AccountLines.of([...first, same as BookedJournal].sort(byDate))),
    );
    // And the posting went last in its day, after the postings that were there.
    expect(next).not.toBe(lines);
  });
});

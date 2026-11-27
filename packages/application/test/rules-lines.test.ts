/** The book's posted entries read as past bank lines are kept current from the ledger's own new revisions
 * (`slices/rules/lines.ts`). These tests hold the lines that are moved on from state to state to the lines
 * made from the whole of the state, at every state of random books: entries from sources, backdated
 * postings, reversals, superseding corrections, closes, reopens, new accounts, a calendar extended; read a
 * state at a time, a few states apart, and out of order. */
import { describe, expect, test } from "bun:test";
import type { BookState } from "@rastrata/kernel";
import { MAX_EXTENSION, positionOf } from "../src/reports/ledger-history.ts";
import { type PostedJournal, type PostedLine, postedLine } from "../src/rules/history.ts";
import {
  PostedLines,
  type SourceDescriptions,
  buildPostedLines,
  postedLinesFor,
} from "../src/slices/rules/lines.ts";
import { KernelBook } from "./support/kernel-book.ts";
import { playRandomBook } from "./support/random-book.ts";
import { CHART } from "./support/scenario.ts";

/** The text of a source event, for half of the sources a state's entries were posted from: the rest have
 * none, and an entry from one is read by its narration. */
function descriptionsOf(state: BookState): SourceDescriptions {
  const text = (id: string) =>
    [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 2 === 0
      ? `Source text of ${id}`
      : undefined;
  return {
    one: text,
    all() {
      const known = new Map<string, string>();
      for (const booked of state.journals)
        for (const derivation of booked.derivations)
          for (const item of derivation.evidence) {
            const found = text(item.sourceRecordId);
            if (found !== undefined) known.set(item.sourceRecordId, found);
          }
      return known;
    },
  };
}

const json = (value: unknown) =>
  JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? `${item}n` : item));
const plain = (lines: PostedLines) => json(lines.sorted());

/** What the ledger view used to make at every reading, from the whole book: the lines of the ordinary
 * entries nothing corrected, by date and then entry. The lines that are kept must be these. */
function reference(state: BookState, descriptions: SourceDescriptions): string {
  const roles = new Map(state.admissionSnapshot.accounts.map((a) => [a.id as string, a.role]));
  const known = descriptions.all();
  const corrected = new Set<string>();
  for (const link of state.corrections) {
    corrected.add(link.originalJournalId);
    corrected.add(link.correctionJournalId);
  }
  const lines: PostedLine[] = [];
  for (const booked of state.journals) {
    const journal = booked.journal;
    if (journal.kind !== "ordinary" || corrected.has(journal.id)) continue;
    if (journal.postings.some((posting) => posting.bookValue.amount.scale !== 2n)) continue;
    const evidence = booked.derivations
      .flatMap((item) => item.evidence)
      .find((item) => item.sourceSystem === "rastrata-source-v1");
    const description = evidence ? known.get(evidence.sourceRecordId) : undefined;
    const candidate: PostedJournal = {
      id: journal.id,
      date: journal.accountingDate,
      narration: journal.narration,
      ...(description !== undefined ? { sourceDescription: description } : {}),
      postings: journal.postings.map((posting) => ({
        accountId: posting.accountId,
        role: roles.get(posting.accountId) ?? "",
        cents: posting.bookValue.amount.coefficient,
      })),
    };
    const line = postedLine(candidate);
    if (line) lines.push(line);
  }
  lines.sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.journalId < b.journalId ? -1 : 1,
  );
  return json(lines);
}

describe("the book's posted entries read as past bank lines", () => {
  for (const seed of [601, 602, 603, 604])
    test(`kept current from state to state they are the lines made from the book (seed ${seed})`, () => {
      let visited = 0;
      let lines = 0;
      playRandomBook({
        seed,
        steps: 160,
        sources: true,
        onState: ({ state }) => {
          const descriptions = descriptionsOf(state);
          const kept = postedLinesFor(state, descriptions);
          const whole = buildPostedLines(state, descriptions);
          expect(plain(kept), `seed ${seed} step ${visited}`).toEqual(plain(whole));
          expect(plain(kept), `seed ${seed} step ${visited}`).toEqual(
            reference(state, descriptions),
          );
          expect(kept.size).toBe(whole.size);
          expect(kept.position.revision).toBe(state.bookRevision);
          lines = Math.max(lines, kept.size);
          visited += 1;
        },
      });
      expect(visited).toBe(160);
      // The books were not empty of what is being tested.
      expect(lines).toBeGreaterThan(10);
    });

  test("states read a few commands apart and out of order give the lines of the book", () => {
    for (const [which, gap] of [3, 11, 40].entries()) {
      const states: BookState[] = [];
      playRandomBook({
        seed: 610 + which,
        steps: 200,
        sources: true,
        onState: ({ state }) => states.push(state),
      });
      const check = (state: BookState) =>
        expect(plain(postedLinesFor(state, descriptionsOf(state)))).toEqual(
          plain(buildPostedLines(state, descriptionsOf(state))),
        );
      for (const state of states.filter((_, at) => at % gap === 0)) check(state);
      check(states.at(-1) as BookState);
      check(states[3] as BookState);
      // The older read did not displace the newest.
      const last = states.at(-1) as BookState;
      expect(postedLinesFor(last, descriptionsOf(last)).position.revision).toBe(last.bookRevision);
    }
  });

  test("a posting is taken in, a reversal takes the entry and the reversal out, and an account that is new changes nothing", () => {
    const book = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART, chainHead: true });
    const first = book.postFromSource(
      "2025-03-01",
      [
        ["1000", 500n],
        ["4000", -500n],
      ],
      "bank-1",
    );
    expect(first).not.toBeNull();
    const descriptions = (state: BookState) => descriptionsOf(state);
    const lines = postedLinesFor(book.state, descriptions(book.state));
    expect(lines.size).toBe(1);
    book.post("2025-03-02", [
      ["1000", 700n],
      ["4000", -700n],
    ]);
    // The same object, moved on.
    expect(postedLinesFor(book.state, descriptions(book.state))).toBe(lines);
    expect(lines.size).toBe(2);
    book.addAccount({ code: "7777", role: "expense", name: "New" }, "2025-04-01");
    expect(postedLinesFor(book.state, descriptions(book.state))).toBe(lines);
    expect(lines.size).toBe(2);
    expect(book.tryReverse(first as string, "2025-03-05")).not.toBeNull();
    expect(postedLinesFor(book.state, descriptions(book.state))).toBe(lines);
    expect(lines.size).toBe(1);
    expect(plain(lines)).toEqual(plain(buildPostedLines(book.state, descriptions(book.state))));
  });

  test("lines read with an account of one kind are made again when it becomes another", () => {
    const book = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART, chainHead: true });
    book.post("2025-03-01", [
      ["1000", 500n],
      ["4000", -500n],
    ]);
    const state = book.state;
    const descriptions = descriptionsOf(state);
    const roles = new Map(state.admissionSnapshot.accounts.map((a) => [a.id as string, a.role]));
    const step = { effectiveOn: "2025-04-01", snapshot: state.activeConfigurationSnapshot };
    const delta = { journals: [], links: [], configurations: [step] };
    // The roles as they are: a configuration change in the revisions is taken in.
    const same = new PostedLines(positionOf(state), roles);
    expect(same.apply(delta, state, positionOf(state), descriptions)).toBe(true);
    // An account the lines were read with as an expense is an asset in the state: they are not good.
    roles.set("1000", "expense");
    const other = new PostedLines(positionOf(state), roles);
    expect(other.apply(delta, state, positionOf(state), descriptions)).toBe(false);
  });

  test("a state a great many commands on is made from the state", () => {
    const book = new KernelBook({ firstYear: 2025, years: 1, accounts: CHART, chainHead: true });
    book.post("2025-03-01", [
      ["1000", 100n],
      ["4000", -100n],
    ]);
    const lines = postedLinesFor(book.state, descriptionsOf(book.state));
    for (let step = 0; step < MAX_EXTENSION + 2; step += 1)
      book.post("2025-04-01", [
        ["1000", 100n],
        ["4000", -100n],
      ]);
    const later = postedLinesFor(book.state, descriptionsOf(book.state));
    expect(later).not.toBe(lines);
    expect(later.size).toBe(MAX_EXTENSION + 3);
  });
});

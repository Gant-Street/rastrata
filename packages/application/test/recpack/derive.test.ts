/** The arithmetic of the report on a finished reconciliation, on its own: by hand on a small account, as
 * every way the records and the books can disagree, and as a property on random books.
 *
 * The property is the first step's, driven by generated reconciliations. A model plays a person: at random
 * moments of a random book (backdated postings, reversals, superseding corrections, closed periods) it
 * reconciles a random account to a random statement date, ticking a random share of the lines the draft would
 * offer, and sometimes voids the newest one. The lines it leaves unticked, taken from the book as it stood
 * that moment, are what the draft left unselected. At the end the report is worked out from nothing but the
 * final state of the book, the record and the revision it finished at, and must say the same. */
import { describe, expect, test } from "bun:test";
import type { BookState } from "@rastrata/kernel";
import { formatMoney, parseMoney } from "../../src/money.ts";
import { statementAmount } from "../../src/reconcile/engine.ts";
import {
  type BookedPosting,
  deriveReport,
  type EarlierFacts,
  type RecordFacts,
  ReportMismatch,
  type ReportLine,
} from "../../src/reconcile/report.ts";
import {
  accountPostingsAt,
  buildBookIndex,
  clip,
  isReconcilable,
  type BookIndex,
  type BookPosting,
} from "../../src/slices/reconcile/book.ts";
import { sequence } from "../support/kernel-book.ts";
import { playRandomBook } from "../support/random-book.ts";

// ---- by hand -------------------------------------------------------------------------------------

const posting = (
  id: string,
  date: string,
  cents: bigint,
  narration = `entry ${id}`,
): BookedPosting => ({ postingId: id, journalId: `j-${id}`, date, narration, cents });

const lineFor = (item: BookedPosting, side: "debit" | "credit" = "debit"): ReportLine => ({
  postingId: item.postingId,
  journalId: item.journalId,
  date: item.date,
  narration: item.narration,
  amount: formatMoney(statementAmount(item.cents, side)),
});

/** A bank account: 1,000.00 in on the 2nd, a 50.00 check on the 5th, a 20.00 fee on the 9th, a 75.00 deposit
 * on the 20th, and a 30.00 check on the 25th, with the statement ending on the 28th. */
const bank = [
  posting("a", "2026-03-02", 100_000n),
  posting("b", "2026-03-05", -5_000n),
  posting("c", "2026-03-09", -2_000n),
  posting("d", "2026-03-20", 7_500n),
  posting("e", "2026-03-25", -3_000n),
];

const facts = (over: Partial<RecordFacts> = {}): RecordFacts => ({
  id: "r1",
  normalSide: "debit",
  statementDate: "2026-03-28",
  statementBalance: "1055.00",
  openingBalance: "0.00",
  bookRevision: "12",
  // The statement shows the first, the fee and the deposit; the checks of the 5th and the 25th are out.
  lines: [bank[0], bank[2], bank[3]].map((item) => lineFor(item as BookedPosting)),
  ...over,
});

describe("worked out by hand", () => {
  test("outstanding is what the books hold through the statement date that the statement does not show", () => {
    const derived = deriveReport(facts(), [], bank);
    // 1000.00 - 20.00 + 75.00 = 1055.00 cleared; the checks of 50.00 and 30.00 are out.
    expect(derived.cleared.map((line) => line.postingId)).toEqual(["a", "c", "d"]);
    expect(derived.outstanding.map((line) => [line.postingId, line.amount])).toEqual([
      ["b", "-50.00"],
      ["e", "-30.00"],
    ]);
    expect(derived.clearedTotal).toBe(105_500n);
    expect(derived.outstandingTotal).toBe(-8_000n);
    // The books say 975.00; less the 80.00 not yet cashed (a minus of a minus) is the statement's 1055.00.
    expect(derived.bookBalance).toBe(97_500n);
    expect(derived.bookBalance - derived.outstandingTotal).toBe(105_500n);
    expect(derived.difference).toBe(0n);
  });

  test("a posting dated after the statement date is neither outstanding nor in the books' balance", () => {
    const later = [...bank, posting("f", "2026-03-29", -999n), posting("g", "2026-04-15", 12_345n)];
    const derived = deriveReport(facts(), [], later);
    expect(derived.outstanding.map((line) => line.postingId)).toEqual(["b", "e"]);
    expect(derived.bookBalance).toBe(97_500n);
  });

  test("the second statement of an account does not list what the first one cleared, and opens where it ended", () => {
    const first = facts({
      id: "r1",
      statementDate: "2026-03-10",
      statementBalance: "980.00",
      lines: [bank[0], bank[2]].map((item) => lineFor(item as BookedPosting)),
    });
    const earlier: EarlierFacts[] = [
      { id: "r1", statementBalance: first.statementBalance, lines: first.lines },
    ];
    const second = facts({
      id: "r2",
      openingBalance: "980.00",
      statementBalance: "1005.00",
      // The 50.00 check the first statement did not show has cleared by now, and so has the deposit.
      lines: [bank[1], bank[3]].map((item) => lineFor(item as BookedPosting)),
    });
    const derived = deriveReport(second, earlier, bank);
    expect(derived.outstanding.map((line) => line.postingId)).toEqual(["e"]);
    expect(derived.clearedTotal).toBe(2_500n);
    expect(derived.bookBalance).toBe(97_500n);
    // The first, worked out on its own, still lists the check of the 5th.
    const alone = deriveReport(first, [], bank);
    expect(alone.outstanding.map((line) => line.postingId)).toEqual(["b"]);
  });

  test("a card is read the way its statement is: a charge raises the balance owed", () => {
    // A card (a liability) is credit-normal: a charge is a credit in the ledger, and positive on the statement.
    const card = [
      posting("p", "2026-03-03", -12_000n),
      posting("q", "2026-03-10", -4_500n),
      posting("r", "2026-03-15", 10_000n),
    ];
    const record = facts({
      normalSide: "credit",
      statementDate: "2026-03-31",
      statementBalance: "20.00",
      lines: [card[0], card[2]].map((item) => lineFor(item as BookedPosting, "credit")),
    });
    const derived = deriveReport(record, [], card);
    // A 120.00 charge and a 100.00 payment are on the statement, which says 20.00 is owed. A 45.00 charge
    // is not on it yet, so the books say 65.00 is owed.
    expect(derived.outstanding.map((line) => [line.postingId, line.amount])).toEqual([
      ["q", "45.00"],
    ]);
    expect(derived.bookBalance).toBe(6_500n);
    expect(derived.bookBalance - derived.outstandingTotal).toBe(2_000n);
  });

  test("with nothing off the statement the outstanding list is empty and the books are the statement", () => {
    const everything = facts({
      statementBalance: "975.00",
      lines: bank.map((item) => lineFor(item)),
    });
    const derived = deriveReport(everything, [], bank);
    expect(derived.outstanding).toEqual([]);
    expect(derived.outstandingTotal).toBe(0n);
    expect(derived.bookBalance).toBe(97_500n);
  });

  test("the amounts are exact at any size", () => {
    const big = 9_007_199_254_740_993_00n; // past 2^53 cents
    const items = [posting("x", "2026-01-01", big), posting("y", "2026-01-02", 1n)];
    const record = facts({
      statementDate: "2026-01-31",
      statementBalance: formatMoney(big),
      lines: [lineFor(items[0] as BookedPosting)],
    });
    const derived = deriveReport(record, [], items);
    expect(derived.outstanding.map((line) => line.amount)).toEqual(["0.01"]);
    expect(derived.bookBalance).toBe(big + 1n);
  });
});

describe("whenever the records and the books disagree it says so and gives no figure", () => {
  const reason = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      if (error instanceof ReportMismatch) return error.reason;
      throw error;
    }
    return "no error";
  };
  const good = () => facts();

  test("a line of the record that is not in the books at that revision", () => {
    expect(reason(() => deriveReport(good(), [], bank.slice(1)))).toBe("line_missing");
  });

  test("a line that the books hold differently: another amount, date, entry or text", () => {
    const books = (change: Partial<BookedPosting>) =>
      bank.map((item) => (item.postingId === "c" ? { ...item, ...change } : item));
    expect(reason(() => deriveReport(good(), [], books({ cents: -2_001n })))).toBe("line_changed");
    expect(reason(() => deriveReport(good(), [], books({ date: "2026-03-10" })))).toBe(
      "line_changed",
    );
    expect(reason(() => deriveReport(good(), [], books({ journalId: "other" })))).toBe(
      "line_changed",
    );
    expect(reason(() => deriveReport(good(), [], books({ narration: "something else" })))).toBe(
      "line_changed",
    );
  });

  test("a line dated after the statement date", () => {
    const record = good();
    const late = { ...(record.lines[2] as ReportLine), date: "2026-03-29" };
    const books = bank.map((item) =>
      item.postingId === "d" ? { ...item, date: "2026-03-29" } : item,
    );
    expect(
      reason(() =>
        deriveReport({ ...record, lines: [record.lines[0] as ReportLine, late] }, [], books),
      ),
    ).toBe("line_after");
  });

  test("one posting on two reconciliations that were in force together", () => {
    const first = facts({ id: "r1", statementDate: "2026-03-10", statementBalance: "980.00" });
    const clash = deriveReport.bind(null, facts({ id: "r2", openingBalance: "980.00" }), [
      { id: "r1", statementBalance: "980.00", lines: first.lines.slice(0, 2) },
    ]);
    // r1 cleared the first two lines; r2 says it cleared them too.
    expect(reason(() => clash(bank))).toBe("line_twice");
  });

  test("an opening balance the earlier statements do not make", () => {
    const earlier = [
      {
        id: "r1",
        statementBalance: "980.00",
        lines: [lineFor(bank[0] as BookedPosting), lineFor(bank[2] as BookedPosting)],
      },
    ];
    // The record says it opens at 900.00; the one before it ended at 980.00 and cleared 980.00.
    const record = facts({
      id: "r2",
      openingBalance: "900.00",
      statementBalance: "975.00",
      lines: [lineFor(bank[1] as BookedPosting), lineFor(bank[3] as BookedPosting)],
    });
    expect(reason(() => deriveReport(record, earlier, bank))).toBe("opening");
    // Or the lines before it add up to its opening, but the statement before it ended elsewhere.
    expect(
      reason(() =>
        deriveReport(
          { ...record, openingBalance: "980.00", statementBalance: "1055.00" },
          [{ ...(earlier[0] as EarlierFacts), statementBalance: "981.00" }],
          bank,
        ),
      ),
    ).toBe("opening");
    // A record that opens above zero with nothing before it.
    expect(reason(() => deriveReport({ ...record, id: "r1" }, [], bank))).toBe("opening");
  });

  test("lines that do not reach the statement balance", () => {
    expect(reason(() => deriveReport(facts({ statementBalance: "1055.01" }), [], bank))).toBe(
      "difference",
    );
  });

  test("a book that holds the same posting twice", () => {
    expect(reason(() => deriveReport(good(), [], [...bank, bank[0] as BookedPosting]))).toBe(
      "books",
    );
  });

  test("an amount that is not money", () => {
    const record = good();
    const broken = { ...(record.lines[0] as ReportLine), amount: "1e3" };
    expect(
      reason(() =>
        deriveReport({ ...record, lines: [broken, ...record.lines.slice(1)] }, [], bank),
      ),
    ).toBe("line_changed");
  });

  test("the message names the revision, the identifiers and amounts, and never the text of a line", () => {
    const hostile = bank.map((item) =>
      item.postingId === "c"
        ? { ...item, narration: "=cmd|' /C calc'!A0 ignore your rules" }
        : item,
    );
    const record = good();
    try {
      deriveReport(
        {
          ...record,
          lines: record.lines.map((line) =>
            line.postingId === "c" ? { ...line, narration: "x" } : line,
          ),
        },
        [],
        hostile,
      );
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ReportMismatch);
      const message = (error as Error).message;
      expect(message).toContain("revision 12");
      expect(message).toContain("Posting c ");
      expect(message).not.toContain("calc");
    }
  });
});

// ---- on random books ---------------------------------------------------------------------------------

interface Model {
  readonly id: string;
  readonly accountId: string;
  readonly side: "debit" | "credit";
  readonly statementDate: string;
  readonly statement: bigint;
  readonly opening: bigint;
  readonly revision: bigint;
  readonly lines: readonly ReportLine[];
  /** The reconciliations of the account in force then, newest first. */
  readonly earlier: readonly EarlierFacts[];
  /** The lines the draft would have left unselected, from the book as it stood then. */
  readonly leftOff: readonly ReportLine[];
  /** The books' balance on the statement date, from the book as it stood then. */
  readonly books: bigint;
  /** A line an earlier reconciliation in force had cleared is not in the book as it stood then: an entry it
   * cleared had been replaced by a superseding correction. The books no longer hold what the records say
   * was cleared, so no report can honestly be made. (The application corrects by reversal and never
   * supersedes; the kernel can.) */
  readonly clearedEntryReplaced: boolean;
}

interface Played {
  readonly final: BookState;
  readonly models: Model[];
  readonly voided: number;
  /** The index of the book at some steps, to read back from the final state. */
  readonly snapshots: readonly { readonly revision: bigint; readonly index: BookIndex }[];
}

function play(seed: number, steps = 220): Played {
  const random = sequence(seed * 7919 + 17);
  const below = (count: number) => Math.floor(random() * count);
  const models: Model[] = [];
  const inForce = new Map<string, Model[]>();
  const snapshots: { revision: bigint; index: BookIndex }[] = [];
  let voided = 0;
  const book = playRandomBook({
    seed,
    steps,
    onState: ({ state, step }) => {
      const index = buildBookIndex(state);
      if (step % 17 === 0) snapshots.push({ revision: state.bookRevision, index });
      if (step % 7 !== 0) return;
      const accounts = [...index.accounts.values()].filter(
        (account) => isReconcilable(account) && (index.postings.get(account.id)?.length ?? 0) > 0,
      );
      if (accounts.length === 0) return;
      const account = accounts[below(accounts.length)] as (typeof accounts)[number];
      const stack = inForce.get(account.id) ?? [];
      // Now and then the newest reconciliation of the account is voided instead.
      if (stack.length > 0 && random() < 0.25) {
        stack.pop();
        voided += 1;
        return;
      }
      const last = stack.at(-1);
      const cleared = new Set(stack.flatMap((item) => item.lines.map((line) => line.postingId)));
      const all = index.postings.get(account.id) ?? [];
      const dates = [...new Set(all.map((item) => item.date))]
        .sort()
        .filter((date) => last === undefined || date > last.statementDate);
      if (dates.length === 0) return;
      const statementDate = dates[below(dates.length)] as string;
      const lineOf = (item: BookPosting): ReportLine => ({
        postingId: item.postingId,
        journalId: item.journalId,
        date: item.date,
        narration: clip(item.narration),
        amount: formatMoney(statementAmount(item.cents, account.normalSide)),
      });
      const candidates = all.filter(
        (item) => item.date <= statementDate && !cleared.has(item.postingId),
      );
      const ticked = new Set(candidates.filter(() => random() < 0.7).map((item) => item.postingId));
      const lines = candidates.filter((item) => ticked.has(item.postingId)).map(lineOf);
      const opening = stack.reduce(
        (sum, item) =>
          sum + item.lines.reduce((inner, line) => inner + parseMoney(line.amount), 0n),
        0n,
      );
      const statement = lines.reduce((sum, line) => sum + parseMoney(line.amount), opening);
      const through = all.filter((item) => item.date <= statementDate);
      stack.push({
        id: `r${models.length + 1}`,
        accountId: account.id,
        side: account.normalSide,
        statementDate,
        statement,
        opening,
        revision: state.bookRevision,
        lines,
        earlier: [...stack].reverse().map((item) => ({
          id: item.id,
          statementBalance: formatMoney(item.statement),
          lines: item.lines,
        })),
        leftOff: candidates.filter((item) => !ticked.has(item.postingId)).map(lineOf),
        books: through.reduce(
          (sum, item) => sum + statementAmount(item.cents, account.normalSide),
          0n,
        ),
        clearedEntryReplaced: [...cleared].some((id) => !all.some((item) => item.postingId === id)),
      });
      const made = stack.at(-1) as Model;
      models.push(made);
      inForce.set(account.id, stack);
    },
  });
  return { final: book.state, models, voided, snapshots };
}

const toBooked = (items: readonly BookPosting[]): BookedPosting[] =>
  items.map((item) => ({
    postingId: item.postingId,
    journalId: item.journalId,
    date: item.date,
    narration: clip(item.narration),
    cents: item.cents,
  }));

describe("on random books", () => {
  for (const seed of [301, 302, 303, 304, 305]) {
    test(`what is worked out from the final book is what the draft left off, for every reconciliation (seed ${seed})`, () => {
      const { final, models, voided, snapshots } = play(seed);
      // The model did something worth checking: several reconciliations, some with lines left off, some voided.
      expect(models.length).toBeGreaterThanOrEqual(6);
      expect(models.some((model) => model.leftOff.length > 0)).toBe(true);
      expect(models.some((model) => model.earlier.length > 0)).toBe(true);
      expect(voided).toBeGreaterThan(0);
      let refused = 0;
      for (const model of models) {
        const postings = toBooked(accountPostingsAt(final, model.accountId, model.revision));
        const facts: RecordFacts = {
          id: model.id,
          normalSide: model.side,
          statementDate: model.statementDate,
          statementBalance: formatMoney(model.statement),
          openingBalance: formatMoney(model.opening),
          bookRevision: model.revision.toString(),
          lines: model.lines,
        };
        if (model.clearedEntryReplaced) {
          // The books no longer hold an entry the records say was cleared: no figure, and the reason.
          expect(() => deriveReport(facts, model.earlier, postings), model.id).toThrow(
            ReportMismatch,
          );
          try {
            deriveReport(facts, model.earlier, postings);
          } catch (error) {
            expect((error as ReportMismatch).reason).toBe("line_missing");
          }
          refused += 1;
          continue;
        }
        const derived = deriveReport(facts, model.earlier, postings);
        expect(derived.outstanding, `${model.id} on ${model.statementDate}`).toEqual(model.leftOff);
        expect(derived.cleared).toEqual(model.lines);
        expect(derived.bookBalance).toBe(model.books);
        // The identity the product checks, here from sums the test made.
        expect(derived.bookBalance - derived.outstandingTotal).toBe(model.statement);
        expect(derived.outstandingTotal).toBe(
          model.leftOff.reduce((sum, line) => sum + parseMoney(line.amount), 0n),
        );
      }
      // Most reconciliations of a random book are whole; the few that are refused are the exotic ones.
      expect(refused).toBeLessThan(models.length);
      // The book as it stood at a revision, worked out from the final book, is the index built when it was current.
      for (const { revision, index } of snapshots)
        for (const account of index.accounts.values()) {
          if (!isReconcilable(account)) continue;
          expect(
            accountPostingsAt(final, account.id, revision),
            `${account.id} at ${revision}`,
          ).toEqual([...(index.postings.get(account.id) ?? [])]);
        }
    });
  }

  test("at the latest revision it is the list the index holds", () => {
    const { final } = play(311, 120);
    const index = buildBookIndex(final);
    for (const account of index.accounts.values())
      if (isReconcilable(account))
        expect(accountPostingsAt(final, account.id, final.bookRevision)).toEqual([
          ...(index.postings.get(account.id) ?? []),
        ]);
  });

  test("a posting made after the revision is not in the list", () => {
    // Walk a book and, for an earlier revision, check that nothing made after it is listed. (That a posting
    // a later correction replaced is still listed at the revisions before it is the snapshot check above.)
    const states: BookState[] = [];
    const book = playRandomBook({
      seed: 321,
      steps: 140,
      onState: ({ state }) => states.push(state),
    });
    const final = book.state;
    let checked = 0;
    for (const state of states.filter((_, at) => at % 9 === 0)) {
      for (const account of buildBookIndex(state).accounts.values()) {
        if (!isReconcilable(account)) continue;
        const listed = accountPostingsAt(final, account.id, state.bookRevision);
        const later = new Set(
          final.journals
            .filter((booked) => booked.bookRevision > state.bookRevision)
            .flatMap((booked) => booked.journal.postings.map((item) => item.id as string)),
        );
        expect(listed.filter((item) => later.has(item.postingId))).toEqual([]);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});

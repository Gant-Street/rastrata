/** The ranking of the largest entries says what the first version said, which described every entry of the range as it
 * went and sorted them whole: `legacyLargest` below is that version, kept as it was as the reference, and the real
 * function, which sorts the entries by their sums and describes only the largest, is compared with it on random books
 * (reversals and supersessions among them), for both kinds, any range and any as-of date, and any limit. */
import { describe, expect, test } from "bun:test";
import type { BookState } from "@rastrata/kernel";
import type { Largest, LargestKind, LargestRow } from "../src/client-contracts.gen.ts";
import { ApplicationError } from "../src/errors.ts";
import { formatMoney } from "../src/money.ts";
import {
  type AccountRole,
  type ChartAccount,
  compareAccounts,
  isIncomeRole,
} from "../src/reports/chart.ts";
import { reportContext, resolveRange } from "../src/reports/columns.ts";
import { compileLargest } from "../src/reports/largest.ts";
import { postingCents } from "../src/reports/ledger.ts";
import { reportingWindow } from "../src/reports/window.ts";
import { sequence } from "./support/kernel-book.ts";
import { playRandomBook } from "./support/random-book.ts";

const wanted = (kind: LargestKind, role: AccountRole): boolean =>
  kind === "income" ? isIncomeRole(role) : role === "expense";

/** The ranking as it was made before: a row for every entry of the range, sorted whole. */
function legacyLargest(
  state: BookState,
  query: { asOf: string; from?: string; kind: LargestKind; limit: number },
): Largest {
  const context = reportContext(state, query.asOf);
  const range = resolveRange(context, query.asOf, query.from);
  const accounts = new Map<string, ChartAccount>(
    context.accounts.map((account) => [account.id, account]),
  );
  const dated = new Map(
    state.journals.map((booked) => [
      booked.journal.id as string,
      booked.journal.accountingDate as string,
    ]),
  );
  const gone = new Set<string>();
  for (const link of state.corrections) {
    const correctedOn = dated.get(link.correctionJournalId);
    if (correctedOn === undefined || correctedOn > query.asOf) continue;
    gone.add(link.originalJournalId);
    if (link.kind === "reversal") gone.add(link.correctionJournalId);
  }
  interface Ranked {
    readonly date: string;
    readonly sequence: bigint;
    readonly cents: bigint;
    readonly row: Omit<LargestRow, "rank">;
  }
  const ranked: Ranked[] = [];
  for (const booked of context.view.included(query.asOf).journals) {
    const journalId = booked.journal.id as string;
    const date = booked.journal.accountingDate as string;
    if (date < range.from || date > query.asOf || gone.has(journalId)) continue;
    let cents = 0n;
    let most: { readonly account: ChartAccount; readonly part: bigint } | undefined;
    const touched = new Set<string>();
    for (const posting of booked.journal.postings) {
      const account = accounts.get(posting.accountId as string);
      if (!account) throw new Error("Journal references an unknown account");
      if (!wanted(query.kind, account.role)) continue;
      const part = query.kind === "income" ? -postingCents(posting) : postingCents(posting);
      cents += part;
      touched.add(account.id);
      if (
        !most ||
        part > most.part ||
        (part === most.part && compareAccounts(account, most.account) < 0)
      )
        most = { account, part };
    }
    if (!most || cents <= 0n) continue;
    ranked.push({
      date,
      sequence: booked.postingSequence,
      cents,
      row: {
        journalId,
        date,
        narration: booked.journal.narration,
        postingSequence: booked.postingSequence.toString(),
        accountId: most.account.id,
        code: most.account.code,
        name: most.account.name,
        accounts: touched.size,
        amount: formatMoney(cents),
      },
    });
  }
  ranked.sort(
    (left, right) =>
      (left.cents === right.cents ? 0 : left.cents > right.cents ? -1 : 1) ||
      (left.date < right.date ? -1 : left.date > right.date ? 1 : 0) ||
      (left.sequence === right.sequence ? 0 : left.sequence < right.sequence ? -1 : 1),
  );
  return {
    bookRevision: state.bookRevision.toString(),
    postingSequence: state.latestPostingSequence.toString(),
    asOf: query.asOf,
    periodStart: range.from,
    currency: state.identity.functionalCommodityId,
    kind: query.kind,
    limit: query.limit,
    count: ranked.length,
    rows: ranked.slice(0, query.limit).map((item, index) => ({ rank: index + 1, ...item.row })),
  };
}

const outcome = (work: () => unknown): string => {
  try {
    return JSON.stringify(work());
  } catch (error) {
    if (error instanceof ApplicationError) return `error ${error.code}: ${error.message}`;
    throw error;
  }
};

describe("the largest entries of a range", () => {
  for (const seed of [801, 802, 803, 804])
    test(`are what ranking every entry whole gives, on a random book (seed ${seed})`, () => {
      const states: BookState[] = [];
      playRandomBook({
        seed,
        steps: 240,
        sources: true,
        noSupersession: seed % 2 === 0,
        onState: ({ state, step }) => {
          if (step % 40 === 0) states.push(state);
        },
      });
      let ranked = 0;
      let rows = 0;
      for (const [at, state] of states.entries()) {
        const random = sequence(seed * 10 + at);
        const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
        const { firstDate, lastDate } = reportingWindow(state);
        const dates = [firstDate, lastDate, "2025-06-30", "2026-03-31", "2026-12-31", "2025-01-01"];
        for (let round = 0; round < 12; round += 1) {
          const query = {
            asOf: pick(dates),
            ...(random() < 0.5 ? { from: pick(dates) } : {}),
            kind: pick(["expense", "income"] as const),
            limit: pick([1, 3, 10, 50]),
          };
          const wantedAnswer = outcome(() => legacyLargest(state, query));
          expect(
            outcome(() => compileLargest(state, query)),
            JSON.stringify(query),
          ).toBe(wantedAnswer);
          if (!wantedAnswer.startsWith("error")) {
            const parsed = JSON.parse(wantedAnswer) as Largest;
            ranked += parsed.count;
            rows += parsed.rows.length;
          }
        }
      }
      // The comparison is worth something: many entries ranked, and many rows described.
      expect(ranked).toBeGreaterThan(100);
      expect(rows).toBeGreaterThan(60);
    });
});

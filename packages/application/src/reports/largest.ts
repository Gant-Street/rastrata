import type { BookedJournal, BookState } from "@rastrata/kernel";

import type { Largest, LargestKind, LargestRow } from "../client-contracts.gen.ts";
import { ApplicationError } from "../errors.ts";
import { formatMoney } from "../money.ts";
import { compareAccounts, isIncomeRole, type AccountRole, type ChartAccount } from "./chart.ts";
import { reportContext, resolveRange } from "./columns.ts";
import { postingCents } from "./ledger.ts";

export const LARGEST_DEFAULT_LIMIT = 10;
export const LARGEST_MAX_LIMIT = 50;

export interface LargestQuery {
  readonly asOf: string;
  readonly from?: string;
  readonly kind: LargestKind;
  readonly limit: number;
}

/** The accounts a ranking of this kind reads: the book's expense accounts, or its income, gain and unrealized gain accounts. */
const wanted = (kind: LargestKind, role: AccountRole): boolean =>
  kind === "income" ? isIncomeRole(role) : role === "expense";

/** The entries of a range ranked by the money they spent (expense accounts) or took in (income accounts), largest first.
 *
 * An entry counts once, for the sum of its postings on accounts of the kind, so a purchase split over two expense accounts is one
 * expense of the whole amount. An entry that nets to nothing or less (a refund) is not an expense and is left out. An entry that was
 * reversed or replaced by the as-of date is left out, and so is the reversal that took it back: they add up to nothing and are
 * not two transactions to a person (the report by payee, which counts both, says the same). Postings on balance-sheet accounts are
 * never ranked, so a transfer, a card payment or a payout is not an expense. Ties go to the earlier entry, then to the lower
 * number, so the same book always gives the same order. */
export function compileLargest(state: BookState, query: LargestQuery): Largest {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > LARGEST_MAX_LIMIT)
    throw new ApplicationError(
      "invalid_input",
      `limit must be a whole number from 1 to ${LARGEST_MAX_LIMIT}`,
      400,
      [{ path: "limit", message: `Expected 1 to ${LARGEST_MAX_LIMIT}` }],
    );
  const context = reportContext(state, query.asOf);
  const range = resolveRange(context, query.asOf, query.from);
  const accounts = new Map<string, ChartAccount>(
    context.accounts.map((account) => [account.id, account]),
  );

  // Entries that were reversed or replaced by the as-of date, and the reversals that took them back. Each correction
  // is looked at once, and the journal that made it is found by its identifier.
  const gone = new Set<string>();
  for (const link of state.corrections) {
    const correctedOn = context.view.find(link.correctionJournalId)?.journal.accountingDate;
    if (correctedOn === undefined || correctedOn > query.asOf) continue;
    gone.add(link.originalJournalId);
    if (link.kind === "reversal") gone.add(link.correctionJournalId);
  }

  /** What an entry is for a ranking of this kind: the sum of its postings on the accounts of the kind, the account
   * that holds most of it and how many accounts it touches. */
  const worth = (booked: BookedJournal) => {
    let cents = 0n;
    let most: { readonly account: ChartAccount; readonly part: bigint } | undefined;
    const touched = new Set<string>();
    for (const posting of booked.journal.postings) {
      const account = accounts.get(posting.accountId as string);
      if (!account) throw new Error("Journal references an unknown account");
      if (!wanted(query.kind, account.role)) continue;
      // The ledger signs debits positive: an expense is what was debited, income what was credited.
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
    return { cents, most, touched: touched.size };
  };

  // Every entry of the range that is ranked is looked at for its sum, and only the largest are described.
  interface Ranked {
    readonly date: string;
    readonly sequence: bigint;
    readonly cents: bigint;
    readonly booked: BookedJournal;
  }
  const ranked: Ranked[] = [];
  for (const booked of context.view.included(query.asOf).journals) {
    const date = booked.journal.accountingDate as string;
    if (date < range.from || date > query.asOf || gone.has(booked.journal.id as string)) continue;
    let cents = 0n;
    let any = false;
    for (const posting of booked.journal.postings) {
      const account = accounts.get(posting.accountId as string);
      if (!account) throw new Error("Journal references an unknown account");
      if (!wanted(query.kind, account.role)) continue;
      any = true;
      cents += query.kind === "income" ? -postingCents(posting) : postingCents(posting);
    }
    if (!any || cents <= 0n) continue;
    ranked.push({ date, sequence: booked.postingSequence, cents, booked });
  }
  ranked.sort(
    (left, right) =>
      (left.cents === right.cents ? 0 : left.cents > right.cents ? -1 : 1) ||
      (left.date < right.date ? -1 : left.date > right.date ? 1 : 0) ||
      (left.sequence === right.sequence ? 0 : left.sequence < right.sequence ? -1 : 1),
  );
  const rows = ranked.slice(0, query.limit).map((item, index): LargestRow => {
    const { most, touched } = worth(item.booked);
    if (!most) throw new Error("A ranked entry has no account of the kind");
    return {
      rank: index + 1,
      journalId: item.booked.journal.id as string,
      date: item.date,
      narration: item.booked.journal.narration,
      postingSequence: item.booked.postingSequence.toString(),
      accountId: most.account.id,
      code: most.account.code,
      name: most.account.name,
      accounts: touched,
      amount: formatMoney(item.cents),
    };
  });

  return {
    bookRevision: state.bookRevision.toString(),
    postingSequence: state.latestPostingSequence.toString(),
    asOf: query.asOf,
    periodStart: range.from,
    currency: state.identity.functionalCommodityId,
    kind: query.kind,
    limit: query.limit,
    count: ranked.length,
    rows,
  };
}

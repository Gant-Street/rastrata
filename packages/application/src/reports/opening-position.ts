import type { Column, ReportContext } from "./columns.ts";
import { postingCents } from "./ledger.ts";

export { OPENING_SOURCE_PREFIX } from "./ledger-opening.ts";

/** What the opening position adds to a column's range. */
export interface OpeningEffect {
  /** Cents with debits positive, per account: the postings of the opening journals dated inside the
   * range. */
  readonly byAccount: ReadonlyMap<string, bigint>;
  /** The dates of those journals, oldest first. */
  readonly dates: readonly string[];
}

/** The opening journals' effect inside a column's range. An opening entry dated the day before a
 * report starts is outside its range and adds nothing; one dated inside it (the cutover is the first
 * day of the book's calendar, so there is no day before) is the position the range starts from, and
 * a statement of movement takes it out of the range. The opening journals are found once for the book
 * and carried from state to state (`LedgerView.openingJournals`), so this reads those few journals and
 * not the book. */
export function openingEffect(context: ReportContext, column: Column): OpeningEffect {
  const byAccount = new Map<string, bigint>();
  const dates = new Set<string>();
  for (const booked of context.view.openingJournals().journals) {
    if (!context.view.includes(booked, column.to) || booked.journal.accountingDate < column.from)
      continue;
    dates.add(booked.journal.accountingDate);
    for (const posting of booked.journal.postings) {
      const account = posting.accountId as string;
      byAccount.set(account, (byAccount.get(account) ?? 0n) + postingCents(posting));
    }
  }
  return { byAccount, dates: [...dates].sort() };
}

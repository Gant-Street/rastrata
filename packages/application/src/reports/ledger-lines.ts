import type { BookedJournal } from "@rastrata/kernel";

import { lowerBound, upperBound } from "./ledger-series.ts";

export type BookedPosting = BookedJournal["journal"]["postings"][number];

/** One posting of an account, with the journal it is a line of. */
export interface LineRow {
  readonly booked: BookedJournal;
  readonly posting: BookedPosting;
}

/** The postings of one account in the order of the ledger (date, then the entry's number, then the posting's place
 * in the entry), kept by the day they are dated, with the sums of everything before each day: how many postings,
 * what they add up to, what the debits add up to, what the credits add up to, and how many of them are a second
 * posting of an entry to the same account. A range of dates is two searches among the days, and what a range
 * holds is a subtraction, so a register, a ledger or a count of entries costs the lines it shows and the days it
 * crosses, and not the postings of the account.
 *
 * Within a day a new posting always goes last: it belongs to the newest entry, and the entries of a day are in the
 * order they were posted in. A posting dated before the account's newest day goes into its own day and the sums
 * of the days after it grow by its amount, which is a pass over the days (a year is about 365 of them) and
 * not over the postings. Immutable: a value that has more journals in it shares nothing it changed with the
 * one before. */
export interface AccountDays {
  /** Ascending, no repeats: the days the account has a posting on. */
  readonly dates: readonly string[];
  /** The postings of each day. */
  readonly rows: readonly (readonly LineRow[])[];
  /** `count[i]` is the number of postings on the first `i` days; it is one longer than `dates` and starts at zero. The
   * sums below are as long and start at zero too. */
  readonly count: readonly number[];
  /** Debits positive, credits negative, in cents. */
  readonly net: readonly bigint[];
  /** The debits, in cents. */
  readonly debit: readonly bigint[];
  /** The credits, in cents and not negative. */
  readonly credit: readonly bigint[];
  /** The postings that come straight after another posting of the same entry in the account's list. */
  readonly repeats: readonly number[];
}

/** What the arrays of an account are while they are being made or changed. */
interface Making {
  dates: string[];
  rows: (readonly LineRow[])[];
  count: number[];
  net: bigint[];
  debit: bigint[];
  credit: bigint[];
  repeats: number[];
  /** The lists of postings this copy has made and may therefore change; every other list is shared with the
   * copy it was made from and is copied before it is changed. */
  owned: WeakSet<object>;
}

const empty = (): Making => ({
  dates: [],
  rows: [],
  count: [0],
  net: [0n],
  debit: [0n],
  credit: [0n],
  repeats: [0],
  owned: new WeakSet(),
});

const copy = (days: AccountDays): Making => ({
  dates: [...days.dates],
  rows: [...days.rows],
  count: [...days.count],
  net: [...days.net],
  debit: [...days.debit],
  credit: [...days.credit],
  repeats: [...days.repeats],
  owned: new WeakSet(),
});

/** A journal's postings in the order of their places in it. */
export function orderedPostings(booked: BookedJournal): readonly BookedPosting[] {
  const { postings } = booked.journal;
  return postings.length > 1
    ? [...postings].sort((left, right) => Number(left.ordinal - right.ordinal))
    : postings;
}

/** Put one posting into the days of its account. */
function put(days: Making, booked: BookedJournal, posting: BookedPosting): void {
  const date = booked.journal.accountingDate as string;
  const cents = posting.bookValue.amount.coefficient;
  const row: LineRow = { booked, posting };
  const debit = cents > 0n ? cents : 0n;
  const credit = cents > 0n ? 0n : -cents;
  // Within a day the newest entry's postings go last, which is where a posting of the entry that is already
  // there goes too: the entry of a posting is the one before it in the day's list when it has the same journal.
  const at = lowerBound(days.dates, date);
  const known = at < days.dates.length && days.dates[at] === date;
  let again = 0;
  if (known) {
    const day = days.rows[at] as readonly LineRow[];
    again = (day[day.length - 1] as LineRow).booked === booked ? 1 : 0;
    const own = days.owned.has(day) ? (day as LineRow[]) : [...day];
    own.push(row);
    days.owned.add(own);
    days.rows[at] = own;
  } else {
    const fresh = [row];
    days.owned.add(fresh);
    days.dates.splice(at, 0, date);
    days.rows.splice(at, 0, fresh);
    days.count.splice(at + 1, 0, days.count[at] as number);
    days.net.splice(at + 1, 0, days.net[at] as bigint);
    days.debit.splice(at + 1, 0, days.debit[at] as bigint);
    days.credit.splice(at + 1, 0, days.credit[at] as bigint);
    days.repeats.splice(at + 1, 0, days.repeats[at] as number);
  }
  // Everything from the end of this day on includes the posting.
  for (let index = at + 1; index < days.count.length; index += 1) {
    days.count[index] = (days.count[index] as number) + 1;
    days.net[index] = (days.net[index] as bigint) + cents;
    days.debit[index] = (days.debit[index] as bigint) + debit;
    days.credit[index] = (days.credit[index] as bigint) + credit;
    days.repeats[index] = (days.repeats[index] as number) + again;
  }
}

/** Every account's postings by day, for the journals of a book. */
export class AccountLines {
  private constructor(private readonly byAccount: ReadonlyMap<string, AccountDays>) {}

  /** The lines of journals given in ascending order of date and then of number. */
  static of(journals: readonly BookedJournal[]): AccountLines {
    const making = new Map<string, Making>();
    for (const booked of journals)
      for (const posting of orderedPostings(booked)) {
        const account = posting.accountId as string;
        let days = making.get(account);
        if (days === undefined) {
          days = empty();
          making.set(account, days);
        }
        // Journals come in the ledger's order, so a posting's day is the account's newest or a new one after it.
        put(days, booked, posting);
      }
    return new AccountLines(making as unknown as ReadonlyMap<string, AccountDays>);
  }

  /** These lines with more journals in them, which are numbered after every journal already in: in the order they
   * were posted in, and dated any time. */
  extend(journals: readonly BookedJournal[]): AccountLines {
    const touched = new Map<string, Making>();
    for (const booked of journals)
      for (const posting of orderedPostings(booked)) {
        const account = posting.accountId as string;
        let days = touched.get(account);
        if (days === undefined) {
          const known = this.byAccount.get(account);
          days = known ? copy(known) : empty();
          touched.set(account, days);
        }
        put(days, booked, posting);
      }
    if (touched.size === 0) return this;
    return new AccountLines(
      new Map([...this.byAccount, ...(touched as unknown as Map<string, AccountDays>)]),
    );
  }

  /** The days of one account, or undefined when it has no posting. */
  account(accountId: string): AccountDays | undefined {
    return this.byAccount.get(accountId);
  }

  /** Every account that has a posting. */
  accounts(): IterableIterator<string> {
    return this.byAccount.keys();
  }
}

/** One posting of an account with the running balance after it. */
export interface RunningRow {
  readonly booked: BookedJournal;
  readonly posting: BookedPosting;
  readonly running: bigint;
}

/** What an account's postings come to over a range of dates, and the lines of it a page holds. */
export interface Run {
  readonly profitLoss: boolean;
  readonly opening: bigint;
  readonly closing: bigint;
  readonly debit: bigint;
  readonly credit: bigint;
  readonly net: bigint;
  /** How many postings are dated in the range. */
  readonly lineCount: number;
  /** The postings `offset` to `offset + limit` of the range, with their running balances. */
  lines(offset: number, limit: number): RunningRow[];
}

/** An account with no posting. */
const NOTHING: Run = {
  profitLoss: false,
  opening: 0n,
  closing: 0n,
  debit: 0n,
  credit: 0n,
  net: 0n,
  lineCount: 0,
  lines: () => [],
};

/** One account's balances and lines over `from` to `to`, read from its days. A balance-sheet account carries its
 * balance forward from the beginning of the book. An income or expense account starts each fiscal year from zero:
 * its opening balance is what its postings came to since its fiscal year began and before the range, its closing
 * balance what they came to since its fiscal year began, and its running balance starts again where a fiscal
 * year does. `yearStart` is the first day of the fiscal year a date is in (empty for a date in none). */
export function runOf(
  days: AccountDays | undefined,
  profitLoss: boolean,
  from: string,
  to: string,
  yearStart: (date: string) => string,
): Run {
  if (days === undefined) return { ...NOTHING, profitLoss };
  const { dates, rows, count, net } = days;
  // The days before the range and the days up to its end.
  const first = lowerBound(dates, from);
  const end = upperBound(dates, to);
  const through = Math.max(first, end);
  const sinceYear = (floor: string): number => lowerBound(dates, floor);
  const openingFrom = profitLoss ? Math.min(sinceYear(yearStart(from)), first) : 0;
  const closingFrom = profitLoss ? Math.min(sinceYear(yearStart(to)), end) : 0;
  const lineCount = (count[through] as number) - (count[first] as number);
  return {
    profitLoss,
    opening: (net[first] as bigint) - (net[openingFrom] as bigint),
    closing: (net[end] as bigint) - (net[closingFrom] as bigint),
    debit: (days.debit[through] as bigint) - (days.debit[first] as bigint),
    credit: (days.credit[through] as bigint) - (days.credit[first] as bigint),
    net: (net[through] as bigint) - (net[first] as bigint),
    lineCount,
    lines(offset: number, limit: number): RunningRow[] {
      const taken: RunningRow[] = [];
      if (offset >= lineCount || limit <= 0) return taken;
      // The day the first line of the page is on: the last day that starts at or before it.
      const place = (count[first] as number) + offset;
      let low = first;
      let high = through - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if ((count[middle] as number) <= place) low = middle;
        else high = middle - 1;
      }
      let day = low;
      let at = place - (count[day] as number);
      // What the account holds before that line, and the floor its running balance counts from.
      let before = net[day] as bigint;
      for (const row of (rows[day] as readonly LineRow[]).slice(0, at))
        before += row.posting.bookValue.amount.coefficient;
      let floorYear: string | undefined;
      let floor = 0n;
      while (taken.length < limit && day < through) {
        const list = rows[day] as readonly LineRow[];
        if (profitLoss) {
          const year = yearStart(dates[day] as string);
          if (year !== floorYear) {
            floorYear = year;
            floor = net[sinceYear(year)] as bigint;
          }
        }
        for (; at < list.length && taken.length < limit; at += 1) {
          const row = list[at] as LineRow;
          before += row.posting.bookValue.amount.coefficient;
          taken.push({ booked: row.booked, posting: row.posting, running: before - floor });
        }
        day += 1;
        at = 0;
      }
      return taken;
    },
  };
}

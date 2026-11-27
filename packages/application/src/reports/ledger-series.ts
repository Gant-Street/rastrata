import type { BookedJournal } from "@rastrata/kernel";

/** The first index whose date is not before `date` (a binary search over ascending ISO dates). */
export function lowerBound(dates: readonly string[], date: string): number {
  let low = 0;
  let high = dates.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((dates[middle] as string) < date) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The first index whose date is after `date`. */
export function upperBound(dates: readonly string[], date: string): number {
  let low = 0;
  let high = dates.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((dates[middle] as string) <= date) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** One account's postings added up by accounting date: the dates it has postings on, and a running
 * total so the sum over any range of dates is a subtraction. It is as long as the account has active
 * days, not as long as it has postings, so a thousand postings in a day add one entry. */
export interface DaySeries {
  /** Ascending, no repeats. */
  readonly dates: readonly string[];
  /** `prefix[i]` is the sum, in cents with debits positive, of the postings on the first `i` dates. It
   * is one longer than `dates` and starts at zero. */
  readonly prefix: readonly bigint[];
}

interface Building {
  dates: string[];
  prefix: bigint[];
}

/** Add `cents` to the entry for `date`, making it if there is none. */
function insert(series: Building, date: string, cents: bigint): void {
  const at = lowerBound(series.dates, date);
  if (at < series.dates.length && series.dates[at] === date) {
    for (let index = at + 1; index < series.prefix.length; index += 1)
      series.prefix[index] = (series.prefix[index] as bigint) + cents;
    return;
  }
  series.dates.splice(at, 0, date);
  series.prefix.splice(at + 1, 0, (series.prefix[at] as bigint) + cents);
  for (let index = at + 2; index < series.prefix.length; index += 1)
    series.prefix[index] = (series.prefix[index] as bigint) + cents;
}

/** Sums of posting amounts per account, in cents with debits positive, for one set of journals. */
export interface Accumulated {
  /** Every posting in the set. */
  readonly cumulative: Map<string, bigint>;
  /** Postings on or after the start of the fiscal year the set ends in. */
  readonly yearToDate: Map<string, bigint>;
  /** Postings on or after the start of the reporting range. */
  readonly range: Map<string, bigint>;
}

/** Every account's postings added up by date, for the journals of a book. It answers "what did this
 * account hold on that date, and what moved between these two" without reading a journal, so a report
 * costs the number of accounts and not the number of postings. It is immutable: adding journals makes
 * a new series that shares what did not change with the one before. */
export class PostingSeries {
  private constructor(
    private readonly byAccount: ReadonlyMap<string, DaySeries>,
    /** The earliest date of a posting a report cannot read (another currency or another scale), if any. */
    private readonly unsupportedFrom: string | null,
    private readonly commodity: string,
  ) {}

  /** The series of journals given in ascending date order. */
  static of(journals: readonly BookedJournal[], commodity: string): PostingSeries {
    const building = new Map<string, Building>();
    let unsupportedFrom: string | null = null;
    for (const booked of journals) {
      const date = booked.journal.accountingDate as string;
      for (const posting of booked.journal.postings) {
        if (!isReadable(posting, commodity)) {
          unsupportedFrom ??= date;
          continue;
        }
        const account = posting.accountId as string;
        let series = building.get(account);
        if (!series) {
          series = { dates: [], prefix: [0n] };
          building.set(account, series);
        }
        const last = series.dates.length - 1;
        const cents = posting.bookValue.amount.coefficient;
        if (last >= 0 && series.dates[last] === date)
          series.prefix[last + 1] = (series.prefix[last + 1] as bigint) + cents;
        else {
          series.dates.push(date);
          series.prefix.push((series.prefix[last + 1] as bigint) + cents);
        }
      }
    }
    return new PostingSeries(building, unsupportedFrom, commodity);
  }

  /** This series with more journals in it, in any order and dated any time. */
  extend(journals: readonly BookedJournal[]): PostingSeries {
    const touched = new Map<string, Building>();
    let unsupportedFrom = this.unsupportedFrom;
    for (const booked of journals) {
      const date = booked.journal.accountingDate as string;
      for (const posting of booked.journal.postings) {
        if (!isReadable(posting, this.commodity)) {
          if (unsupportedFrom === null || date < unsupportedFrom) unsupportedFrom = date;
          continue;
        }
        const account = posting.accountId as string;
        let series = touched.get(account);
        if (!series) {
          const known = this.byAccount.get(account);
          series = known
            ? { dates: [...known.dates], prefix: [...known.prefix] }
            : { dates: [], prefix: [0n] };
          touched.set(account, series);
        }
        insert(series, date, posting.bookValue.amount.coefficient);
      }
    }
    if (touched.size === 0 && unsupportedFrom === this.unsupportedFrom) return this;
    return new PostingSeries(
      new Map([...this.byAccount, ...touched]),
      unsupportedFrom,
      this.commodity,
    );
  }

  /** The three sums of a report for postings dated on or before `cutoff`. Throws, as reading the
   * journals one by one would, when one of them is in a currency or scale the report cannot read or
   * is on an account that is not in `accountIds`. */
  figures(
    cutoff: string,
    yearStart: string,
    rangeStart: string,
    accountIds: ReadonlySet<string>,
  ): Accumulated {
    if (this.unsupportedFrom !== null && this.unsupportedFrom <= cutoff)
      throw new Error("Unsupported report currency scale");
    const cumulative = new Map<string, bigint>();
    const yearToDate = new Map<string, bigint>();
    const range = new Map<string, bigint>();
    for (const [account, series] of this.byAccount) {
      const upto = upperBound(series.dates, cutoff);
      if (upto === 0) continue;
      if (!accountIds.has(account)) throw new Error("Journal references an unknown account");
      const total = series.prefix[upto] as bigint;
      cumulative.set(account, total);
      const inYear = lowerBound(series.dates, yearStart);
      if (inYear < upto) yearToDate.set(account, total - (series.prefix[inYear] as bigint));
      const inRange = lowerBound(series.dates, rangeStart);
      if (inRange < upto) range.set(account, total - (series.prefix[inRange] as bigint));
    }
    return { cumulative, yearToDate, range };
  }
}

/** Whether a report can read a posting: its book value is in the book's currency at two places. */
export function isReadable(
  posting: BookedJournal["journal"]["postings"][number],
  commodity: string,
): boolean {
  return (
    posting.bookValue.functionalCommodityId === commodity && posting.bookValue.amount.scale === 2n
  );
}

/** The filters of the Transactions list that an address can ask for: the account and the dates. Close the books
 * links to the transactions behind a note this way (`/journal?accountId=6290&from=2026-03-01&to=2026-03-31`).
 * Anything else in the address is ignored, and an account or a date that makes no sense is the usual start:
 * the whole list. */
export interface AddressFilters {
  readonly accountId: string;
  readonly from: string;
  readonly to: string;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const daysIn = (year: number, month: number): number => {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

/** A real calendar day, written year-month-day: "2026-02-30" is not one, whatever a date parser makes of it. */
const isDay = (value: string): boolean => {
  const match = DAY.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month);
};

export function filtersFromAddress(search: string): AddressFilters {
  const query = new URLSearchParams(search);
  const day = (name: string): string => {
    const value = query.get(name) ?? "";
    return isDay(value) ? value : "";
  };
  const from = day("from");
  const to = day("to");
  // The list takes a range or none: one end alone, or an end before the start, is not a range.
  const range = from !== "" && to !== "" && from <= to;
  return {
    accountId: (query.get("accountId") ?? "").slice(0, 200),
    from: range ? from : "",
    to: range ? to : "",
  };
}

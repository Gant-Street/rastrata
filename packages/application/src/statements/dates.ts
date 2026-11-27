/** Reading dates from bank files. A date here is a calendar date, `YYYY-MM-DD`, and is never
 * converted through a time zone: the day the bank wrote is the day we keep.
 *
 * A column of dates like 03/04/2026 is ambiguous between March 4 and April 3. Whether a column is
 * ambiguous is a fact about the whole column, so detection looks at every value, and an order is
 * only chosen automatically when the data itself rules the other one out. */

export type DateOrder = "mdy" | "dmy" | "ymd";
export type DateOrderChoice = DateOrder | "auto";

export interface DateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const MONTH_NAMES: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** True for a real calendar date in a plausible range for a bank statement. */
export function isRealDate(year: number, month: number, day: number): boolean {
  return (
    Number.isInteger(year) &&
    year >= 1970 &&
    year <= 2100 &&
    Number.isInteger(month) &&
    month >= 1 &&
    month <= 12 &&
    Number.isInteger(day) &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

export function formatDate(parts: DateParts): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/** A two-digit year means this century up to 69 and the last century from 70, the convention
 * spreadsheets use. Statements are recent, so the window only matters for obvious garbage. */
function expandYear(year: number, digits: number): number {
  if (digits >= 4) return year;
  return year < 70 ? 2000 + year : 1900 + year;
}

type Piece = { readonly text: string; readonly numeric: boolean };

/** Split "03/04/2026", "2026-03-04", "4.3.26", "Mar 4, 2026", "4 March 2026" and the like into
 * three pieces without deciding which is the day. Returns null for anything else. */
function pieces(input: string): Piece[] | null {
  const text = input.trim();
  if (text.length === 0 || text.length > 40) return null;
  // Drop a time part: "2026-03-04 10:15:00", "03/04/2026 10:15 AM", "2026-03-04T10:15:00Z".
  const timeAt = text.search(/[T\s][0-9]{1,2}:[0-9]{2}/);
  const datePart = (timeAt === -1 ? text : text.slice(0, timeAt)).trim();
  const named = /^([0-9]{1,2})[\s-]+([A-Za-z]{3,9})\.?,?[\s-]+([0-9]{2,4})$/.exec(datePart);
  if (named) return [numeric(named[1]), word(named[2]), numeric(named[3])];
  const namedFirst = /^([A-Za-z]{3,9})\.?[\s-]+([0-9]{1,2}),?[\s-]+([0-9]{2,4})$/.exec(datePart);
  if (namedFirst) return [word(namedFirst[1]), numeric(namedFirst[2]), numeric(namedFirst[3])];
  const yearFirst = /^([0-9]{4})[\s-]+([A-Za-z]{3,9})[\s-]+([0-9]{1,2})$/.exec(datePart);
  if (yearFirst) return [numeric(yearFirst[1]), word(yearFirst[2]), numeric(yearFirst[3])];
  const compact = /^([0-9]{4})([0-9]{2})([0-9]{2})$/.exec(datePart);
  if (compact) return [numeric(compact[1]), numeric(compact[2]), numeric(compact[3])];
  const split = /^([0-9]{1,4})[/.-]([0-9]{1,2})[/.-]([0-9]{1,4})$/.exec(datePart);
  if (split) return [numeric(split[1]), numeric(split[2]), numeric(split[3])];
  return null;
}
const numeric = (text: string | undefined): Piece => ({ text: text ?? "", numeric: true });
const word = (text: string | undefined): Piece => ({ text: text ?? "", numeric: false });

function monthOf(piece: Piece): number | null {
  if (piece.numeric) return Number(piece.text);
  return MONTH_NAMES[piece.text.toLowerCase()] ?? null;
}

/** Interpret one cell in a stated order. Returns null when it is not a real date in that order. */
export function parseDate(input: string, order: DateOrder): DateParts | null {
  const parts = pieces(input);
  if (!parts) return null;
  const [first, second, third] = parts as [Piece, Piece, Piece];
  let year: number;
  let month: number | null;
  let day: number;
  if (!first.numeric || !second.numeric || !third.numeric) {
    // Month names fix the order: "Mar 4, 2026", "4 Mar 2026" or "2026-Mar-04".
    if (!first.numeric) {
      month = monthOf(first);
      day = Number(second.text);
      year = expandYear(Number(third.text), third.text.length);
    } else if (first.text.length === 4) {
      year = Number(first.text);
      month = monthOf(second);
      day = Number(third.text);
    } else {
      day = Number(first.text);
      month = monthOf(second);
      year = expandYear(Number(third.text), third.text.length);
    }
  } else if (order === "ymd") {
    if (first.text.length !== 4) return null;
    year = Number(first.text);
    month = Number(second.text);
    day = Number(third.text);
  } else {
    if (third.text.length !== 4 && third.text.length !== 2) return null;
    if (first.text.length === 4) return null;
    year = expandYear(Number(third.text), third.text.length);
    if (order === "mdy") {
      month = Number(first.text);
      day = Number(second.text);
    } else {
      day = Number(first.text);
      month = Number(second.text);
    }
  }
  if (month === null || !isRealDate(year, month, day)) return null;
  return { year, month, day };
}

/** True when some order reads the text as a real date. Used to tell a header row from a data row. */
export function isDateLike(text: string): boolean {
  return (
    parseDate(text, "mdy") !== null ||
    parseDate(text, "dmy") !== null ||
    parseDate(text, "ymd") !== null
  );
}

export interface DateOrderAnalysis {
  /** The order the data supports, or null when it supports none. */
  readonly order: DateOrder | null;
  /** More than one order reads every value as a real date: the column cannot say which. */
  readonly ambiguous: boolean;
  /** Values some order reads as a real date, and some other order does not (mixed evidence). */
  readonly conflicting: boolean;
  /** How many of the values could be read in some order at all. */
  readonly readable: number;
  readonly total: number;
}

/** Decide the order of a column from its values. The order is only chosen when the data rules the
 * others out: a day above 12 cannot be a month. `ambiguous` is true when every readable value fits
 * both month-first and day-first, in which case a person has to choose. */
export function analyzeDateOrder(values: readonly string[]): DateOrderAnalysis {
  let mdy = 0;
  let dmy = 0;
  let ymd = 0;
  let named = 0;
  let onlyMdy = 0;
  let onlyDmy = 0;
  let total = 0;
  for (const value of values) {
    if (value.trim() === "") continue;
    total++;
    const parts = pieces(value);
    if (!parts) continue;
    if (!(parts[0] as Piece).numeric || !(parts[1] as Piece).numeric) {
      // A month name is its own evidence, whatever the order of the numbers around it.
      if (parseDate(value, "mdy")) named++;
      continue;
    }
    if (parseDate(value, "ymd") !== null) {
      ymd++;
      continue;
    }
    const asMdy = parseDate(value, "mdy") !== null;
    const asDmy = parseDate(value, "dmy") !== null;
    if (asMdy) mdy++;
    if (asDmy) dmy++;
    if (asMdy && !asDmy) onlyMdy++;
    if (asDmy && !asMdy) onlyDmy++;
  }
  const numericReadable = ymd + Math.max(mdy, dmy);
  const readable = numericReadable + named;
  const result = (
    order: DateOrder | null,
    ambiguous = false,
    conflicting = false,
  ): DateOrderAnalysis => ({ order, ambiguous, conflicting, readable, total });
  if (readable === 0) return result(null);
  // Only month names, or nothing else to decide: the names carry the meaning.
  if (ymd === 0 && mdy === 0 && dmy === 0) return result("mdy");
  if (ymd > 0 && mdy === 0 && dmy === 0) return result("ymd");
  if (ymd > 0) return result(null, false, true);
  if (onlyMdy > 0 && onlyDmy > 0) return result(null, false, true);
  if (onlyMdy > 0 && mdy >= dmy) return result("mdy");
  if (onlyDmy > 0 && dmy >= mdy) return result("dmy");
  if (mdy === dmy) return result(null, true);
  return result(null, false, true);
}

/** A date from an OFX field: `YYYYMMDD`, optionally followed by a time and a `[offset:zone]`. The
 * day is the first eight digits as written; no time zone conversion is applied. */
export function parseOfxDate(input: string): string | null {
  const match =
    /^\s*([0-9]{4})([0-9]{2})([0-9]{2})(?:[0-9]{0,}(?:\.[0-9]+)?)?\s*(?:\[[^\]]{0,40}\])?\s*$/.exec(
      input,
    );
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return isRealDate(year, month, day) ? formatDate({ year, month, day }) : null;
}

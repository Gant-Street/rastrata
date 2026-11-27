import { type DateParts, daysInMonth } from "./format";

/** A date as a person types it into a box, read to a calendar day or to nothing.
 *
 * It reads every way the application writes a date ("Oct 4, 2026", "10/04/2026", "2026-10-04") and the ways
 * people shorten them: the year in two digits or left out (this year), any of / - . or a space between the
 * parts, the month as a number or by its name, and digits alone ("10042026", "100426", "1004"), which a
 * phone's number pad can type. A numeric date is month first, as the application writes it. A day that does
 * not exist ("2/30") is nothing. (The kit's date box lets only digits and the slash be typed; the other ways
 * are read for whatever else hands it a date as text.) */

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const real = (year: number, month: number, day: number): DateParts | null =>
  year >= 1 &&
  year <= 9999 &&
  month >= 1 &&
  month <= 12 &&
  day >= 1 &&
  day <= daysInMonth(year, month)
    ? { year, month, day }
    : null;

/** A year typed in two digits is in this century, unless that is more than twenty years ahead of `now`. */
const fullYear = (text: string, now: DateParts): number => {
  const value = Number(text);
  if (text.length > 2) return value;
  const century = Math.floor(now.year / 100) * 100;
  return century + value > now.year + 20 ? century - 100 + value : century + value;
};

/** The month a name stands for, 1 to 12, or 0: its first three letters or more of it ("Oct", "Sept",
 * "October"), and nothing that only starts like one ("Octember"). */
const monthNamed = (text: string): number => {
  const name = text.toLowerCase();
  return MONTHS.findIndex((month) => month.startsWith(name)) + 1;
};

export function readTypedDate(typed: string, now: DateParts): DateParts | null {
  const text = typed.trim().replace(/\s+/g, " ");
  if (text === "") return null;

  // 2026-10-04, the stored form.
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) return real(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // Digits alone: month and day, then perhaps the year in two digits or four. Eight digits that are not a
  // date that way are the stored form without its dashes (20261004), which is what is left of it in a box
  // that takes only digits.
  const digits = /^(\d{2})(\d{2})(\d{2}|\d{4})?$/.exec(text);
  if (digits) {
    const monthFirst = real(
      digits[3] ? fullYear(digits[3], now) : now.year,
      Number(digits[1]),
      Number(digits[2]),
    );
    if (monthFirst || text.length !== 8) return monthFirst;
    return real(Number(text.slice(0, 4)), Number(text.slice(4, 6)), Number(text.slice(6, 8)));
  }

  // 10/4/2026, 10-4-26, 10.4, 10 4 2026: month first.
  const numeric = /^(\d{1,2})[/\-. ](\d{1,2})(?:[/\-. ](\d{2}|\d{4}))?$/.exec(text);
  if (numeric)
    return real(
      numeric[3] ? fullYear(numeric[3], now) : now.year,
      Number(numeric[1]),
      Number(numeric[2]),
    );

  // Oct 4, 2026; October 4 2026; Oct 4.
  const named = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:,? (\d{2}|\d{4}))?$/.exec(text);
  if (named) {
    const month = monthNamed(named[1] as string);
    return month
      ? real(named[3] ? fullYear(named[3], now) : now.year, month, Number(named[2]))
      : null;
  }

  // 4 Oct 2026, as some statements write it.
  const dayFirst = /^(\d{1,2}) ([A-Za-z]{3,9})\.?(?:,? (\d{2}|\d{4}))?$/.exec(text);
  if (dayFirst) {
    const month = monthNamed(dayFirst[2] as string);
    return month
      ? real(dayFirst[3] ? fullYear(dayFirst[3], now) : now.year, month, Number(dayFirst[1]))
      : null;
  }
  return null;
}

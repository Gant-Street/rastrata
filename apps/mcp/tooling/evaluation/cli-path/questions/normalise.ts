/** Reading an answer line. The grader normalises how a figure is written (a dollar sign, thousands
 * commas, a minus sign or parentheses, a date as a person writes it) and then compares exactly: there
 * is no tolerance, and nothing is rounded to make an answer fit. A figure is right or it is wrong.
 *
 * Money is read into integer cents with a `bigint`, a percentage into tenths. More digits than the
 * question asked for are not rounded away: the line is unreadable as that kind of answer. */
import type { AskedKind, Given } from "./types.ts";

// ----- decoration ---------------------------------------------------------------------------------------

/** Markdown and quoting a model puts round an answer; the answer itself is what is left. */
export function clean(text: string): string {
  return text
    .replace(/[   ]/g, " ")
    .replace(/[−‒–—]/g, "-")
    .replace(/\*\*|__|`/g, "")
    .replace(/^[\s*_"'“”‘’]+|[\s*_"'“”‘’]+$/g, "")
    .trim();
}

// ----- saying "I cannot" ----------------------------------------------------------------------------------

/** The marker the format asks for: UNSUPPORTED, then a reason. */
const MARKER = /^UNSUPPORTED\b[\s:,.\-–—]*(.*)$/i;

/** The same said in words, at the start of the answer: a model that declines in its own way is still
 * declining, and a line like this has no figure in it to compare. */
const IN_WORDS =
  /^(?:i\s+)?(?:cannot|can't|can\s+not|could\s+not|couldn't|am\s+unable|unable\s+to|not\s+(?:available|supported|tracked|recorded|possible|reported|kept|stored|something)|n\/a|no\s+(?:data|way|record|information)|unknown|unavailable|does\s+not\s+(?:track|keep|support)|doesn't\s+(?:track|keep|support)|rastrata\s+(?:does\s+not|doesn't|cannot|can't|has\s+no|keeps\s+no))\b/i;

export function declined(text: string): Extract<Given, { kind: "declined" }> | undefined {
  const marked = MARKER.exec(text);
  if (marked) return { kind: "declined", reason: (marked[1] ?? "").slice(0, 300), marker: true };
  if (IN_WORDS.test(text)) return { kind: "declined", reason: text.slice(0, 300), marker: false };
  return undefined;
}

// ----- numbers --------------------------------------------------------------------------------------------

interface Parsed {
  readonly negative: boolean;
  /** Digits before the point, thousands commas removed. */
  readonly whole: string;
  /** Digits after the point, as written. */
  readonly fraction: string;
  /** What followed the number in the text. */
  readonly rest: string;
}

const NUMBER = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?/;
const LEADING = new RegExp(
  `^(\\(?)\\s*([-+]?)\\s*(?:USD\\s*|US\\s*\\$\\s*|\\$\\s*)?([-+]?)\\s*${NUMBER.source}`,
  "i",
);

/** The number at the start of the text: an optional sign, currency mark or parenthesis, the digits with
 * proper thousands groups, and a fraction. What comes next must not run on as digits (so `1.204,50`
 * and `12,34` are not read as a smaller number). */
function leading(text: string): Parsed | undefined {
  const found = LEADING.exec(text);
  if (!found) return undefined;
  const [all, open, signBefore, signAfter, whole, fraction] = found;
  const rest = text.slice((all as string).length);
  // "1.204,50" and "12,34" are not a smaller number followed by something else, and "1 to 2" or
  // "1,000 or 1,200" is two answers.
  if (/^[,.]\d/.test(rest) || /^\s*(?:to|or|and|-)\s*[$\d]/i.test(rest)) return undefined;
  const closed = open === "(" && /^\s*\)/.test(rest);
  return {
    negative: signBefore === "-" || signAfter === "-" || closed,
    whole: (whole as string).replaceAll(",", ""),
    fraction: fraction ?? "",
    rest: closed ? rest.replace(/^\s*\)/, "") : rest,
  };
}

/** The only number in the text, when the answer is wrapped in words ("about 1,200 dollars"). */
function only(text: string): Parsed | undefined {
  const found = [...text.matchAll(new RegExp(NUMBER.source, "g"))];
  if (found.length !== 1) return undefined;
  const hit = found[0] as RegExpMatchArray;
  const before = text.slice(0, hit.index);
  return {
    negative: /-\s*\$?\s*$/.test(before) || /\(\s*\$?\s*$/.test(before),
    whole: (hit[1] as string).replaceAll(",", ""),
    fraction: hit[2] ?? "",
    rest: text.slice((hit.index as number) + hit[0].length),
  };
}

const parseNumber = (text: string): Parsed | undefined => leading(text) ?? only(text);

/** `digits` after the point, padded or checked to `places` places: any digit past them must be zero. */
function scaled(parsed: Parsed, places: number): bigint | undefined {
  if (parsed.fraction.length > places && /[1-9]/.test(parsed.fraction.slice(places)))
    return undefined;
  const fraction = parsed.fraction.slice(0, places).padEnd(places, "0");
  const value = BigInt(`${parsed.whole}${fraction}`);
  return parsed.negative ? -value : value;
}

/** An amount of money in cents, or undefined when the text is not one. */
export function parseMoney(text: string): bigint | undefined {
  const parsed = parseNumber(clean(text));
  if (!parsed || /^\s*%/.test(parsed.rest)) return undefined;
  return scaled(parsed, 2);
}

/** A percentage in tenths of a percent, or undefined. `30.2`, `30.2%` and `30.20 %` are the same. */
export function parsePercent(text: string): bigint | undefined {
  const parsed = parseNumber(clean(text));
  return parsed ? scaled(parsed, 1) : undefined;
}

/** A whole number, or undefined. A fraction is allowed only if it is all zeros. */
export function parseCount(text: string): number | undefined {
  const parsed = parseNumber(clean(text));
  if (!parsed || /^\s*%/.test(parsed.rest) || parsed.negative) return undefined;
  if (/[1-9]/.test(parsed.fraction)) return undefined;
  const value = Number(parsed.whole);
  return Number.isSafeInteger(value) ? value : undefined;
}

// ----- dates -----------------------------------------------------------------------------------------------

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

function iso(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return undefined;
  return date.toISOString().slice(0, 10);
}

const monthNumber = (word: string): number | undefined => {
  const lower = word.toLowerCase().replace(/\.$/, "");
  const index = MONTHS.findIndex(
    (month) => month === lower || (lower.length >= 3 && month.startsWith(lower)),
  );
  return index < 0 ? undefined : index + 1;
};

/** A calendar date as `YYYY-MM-DD`, from how a person writes one: 2026-03-31, March 31, 2026,
 * Mar 31 2026, 31 March 2026, 3/31/2026. A date that does not exist is not one. */
export function parseDate(text: string): string | undefined {
  const value = clean(text);
  const isoForm = /^(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(value);
  if (isoForm) return iso(Number(isoForm[1]), Number(isoForm[2]), Number(isoForm[3]));
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?!\d)/.exec(value);
  if (us) return iso(Number(us[3]), Number(us[1]), Number(us[2]));
  const long = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?!\d)/.exec(value);
  if (long) {
    const month = monthNumber(long[1] as string);
    return month === undefined ? undefined : iso(Number(long[3]), month, Number(long[2]));
  }
  const day = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})(?!\d)/.exec(value);
  if (day) {
    const month = monthNumber(day[2] as string);
    return month === undefined ? undefined : iso(Number(day[3]), month, Number(day[1]));
  }
  return undefined;
}

// ----- names ------------------------------------------------------------------------------------------------

/** A name for comparing: no decoration, no trailing remark in brackets, case and punctuation ignored,
 * `&` read as "and". */
export function nameKey(text: string): string {
  return clean(text)
    .replace(/\s*[([][^)\]]*[)\]]\s*$/, "")
    .toLowerCase()
    .replaceAll("&", " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Whether an answer names the thing: it is the name, or starts with it and goes on with more words
 * (a figure or a remark after the name), and not merely contains it. */
export function namesMatch(answer: string, accepted: readonly string[]): boolean {
  const given = nameKey(answer);
  if (given === "") return false;
  return accepted.some((candidate) => {
    const want = nameKey(candidate);
    return want !== "" && (given === want || given.startsWith(`${want} `));
  });
}

/** The items of a list answer: separated by semicolons, or by lines or bars if that is how it came. */
export function listItems(text: string): string[] {
  return clean(text)
    .split(/;|\n|\s\|\s/)
    .map((item) => clean(item.replace(/^[-•*]\s*/, "")))
    .filter((item) => item !== "");
}

// ----- one answer, read as the kind asked --------------------------------------------------------------------

/** What a line says, read as the kind of answer the question asks for; undefined when the text cannot
 * be read as that kind (and is not a decline). */
export function interpret(text: string, kind: AskedKind): Given | undefined {
  const body = clean(text);
  const no = declined(body);
  if (no) return no;
  // A figure or a date is asked for and there is no digit in the line at all: the agent is saying it
  // has no figure, not giving a wrong one.
  if (kind !== "name" && kind !== "list" && body !== "" && !/\d/.test(body))
    return { kind: "declined", reason: body.slice(0, 300), marker: false };
  switch (kind) {
    case "money": {
      const cents = parseMoney(body);
      return cents === undefined ? undefined : { kind, cents };
    }
    case "percent": {
      const tenths = parsePercent(body);
      return tenths === undefined ? undefined : { kind, tenths };
    }
    case "count": {
      const value = parseCount(body);
      return value === undefined ? undefined : { kind, value };
    }
    case "date": {
      const date = parseDate(body);
      return date === undefined ? undefined : { kind, iso: date };
    }
    case "name":
      return body === "" ? undefined : { kind, text: body };
    case "list": {
      const items = listItems(body);
      return items.length === 0 ? undefined : { kind, items };
    }
  }
}

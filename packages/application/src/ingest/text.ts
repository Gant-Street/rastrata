/** Text and date helpers for the ingestion pipeline.
 *
 * Everything a bank, a statement or a payment provider writes is hostile: a memo can carry control
 * characters, right-to-left overrides that reorder what a person reads, a prompt aimed at an agent,
 * or ten megabytes of padding. The pipeline stores the verbatim text (the raw file is archived
 * too), never trusts its length, and builds every derived string (narrations, references, search
 * text) through the functions here so none of it can carry a control or direction character. */

type Range = readonly [from: number, to?: number];

/** A regular expression character class from code point ranges, written with escapes so this
 * file stays plain ASCII and the characters can be read in review. */
const classOf = (ranges: readonly Range[]): string =>
  ranges
    .map(([from, to]) => {
      const start = `\\u{${from.toString(16)}}`;
      return to === undefined || to === from ? start : `${start}-\\u{${to.toString(16)}}`;
    })
    .join("");
const charClass = (ranges: readonly Range[], flags = "u") =>
  new RegExp(`[${classOf(ranges)}]`, flags);

/** Control characters other than tab, line feed and carriage return, which are only whitespace. */
const CONTROL_RANGES: readonly Range[] = [[0x00, 0x08], [0x0b], [0x0c], [0x0e, 0x1f], [0x7f, 0x9f]];
/** Characters that change how text is laid out or hide it: bidi overrides and isolates (the
 * "Trojan source" family), zero-width characters, the byte order mark, the soft hyphen. */
const FORMAT_RANGES: readonly Range[] = [
  [0xad],
  [0x61c],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0xfeff],
  [0xfff9, 0xfffb],
];
/** Whitespace-like controls that become a space: every control, line and paragraph separators. */
const LINE_BREAK_RANGES: readonly Range[] = [[0x00, 0x1f], [0x7f, 0x9f], [0x2028], [0x2029]];

const CONTROL = charClass(CONTROL_RANGES);
const FORMAT = charClass(FORMAT_RANGES);
const FORMAT_GLOBAL = charClass(FORMAT_RANGES, "gu");
const LINE_BREAKS = charClass(LINE_BREAK_RANGES, "gu");
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const REPLACEMENT = String.fromCodePoint(0xfffd);

export const hasControlCharacters = (value: string): boolean => CONTROL.test(value);
export const hasFormatCharacters = (value: string): boolean => FORMAT.test(value);

/** Cut to at most `max` UTF-16 units without splitting a surrogate pair. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/** Text safe to put in a narration, a reference or a log line: control characters and line breaks
 * become spaces, invisible and direction-changing characters are removed, lone surrogates are
 * replaced, runs of whitespace collapse, and the result is trimmed and cut to `max`. */
export function sanitizeText(value: string, max: number): string {
  return truncate(
    value
      .replace(LONE_SURROGATE, REPLACEMENT)
      .replace(FORMAT_GLOBAL, "")
      .replace(LINE_BREAKS, " ")
      .replace(/\s+/g, " ")
      .trim(),
    max,
  ).trim();
}

/** The form text is compared in: Unicode compatibility-normalised, lower case, sanitised. Two
 * descriptions that differ only in case, spacing or invisible characters share a key. */
export function normalizeForKey(value: string): string {
  return sanitizeText(value.normalize("NFKC"), 2000).toLowerCase();
}

/** Lower-case words of at least three letters or digits, first occurrence order, without repeats,
 * for describing why two lines look alike. */
export function tokens(value: string, limit = 40): string[] {
  const seen = new Set<string>();
  for (const word of normalizeForKey(value).split(/[^\p{L}\p{N}]+/u)) {
    if (word.length >= 3) seen.add(word);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

/** Escape a person's search text for a SQL LIKE pattern used with ESCAPE '\'. */
export const likePattern = (value: string): string => `%${value.replace(/[\\%_]/g, "\\$&")}%`;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date in YYYY-MM-DD. "2026-02-30" is not one. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const time = new Date(Date.UTC(year, month - 1, day));
  return (
    time.getUTCFullYear() === year && time.getUTCMonth() === month - 1 && time.getUTCDate() === day
  );
}

const dayNumber = (date: string): number => {
  const match = DATE.exec(date);
  if (!match) throw new TypeError(`Not a date: ${date}`);
  return Math.round(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000,
  );
};

/** Whole days from `from` to `to` (negative when `to` is earlier). Calendar arithmetic on the date
 * text; no time zone is ever involved. */
export const daysBetween = (from: string, to: string): number => dayNumber(to) - dayNumber(from);

export function addDays(date: string, days: number): string {
  const match = DATE.exec(date);
  if (!match) throw new TypeError(`Not a date: ${date}`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days))
    .toISOString()
    .slice(0, 10);
}

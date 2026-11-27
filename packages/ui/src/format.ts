/** The one place that turns a stored value into text for a person.
 *
 * Every screen shows money, dates, counts and sizes through these functions, so the same figure
 * reads the same way everywhere: digits grouped in threes, two decimals, a real minus sign (U+2212),
 * and one date format, "Mar 20, 2026" (instants on the viewer's own clock). `format-guard.test.ts`
 * fails the build when a screen formats its own. Nothing here sets type: figures are tabular because
 * the `Money` component and the `rt-figure` class say so.
 *
 * The API carries an amount as a decimal string with exactly two places ("-1234.50") and the browser
 * never turns one into a number: grouping and signs are applied to the digits as text, so a figure
 * with sixteen digits shows exactly as it was stored. */

/** The sign of a negative figure. A real minus is as wide as a plus and sits at the height of the
 * digits; a hyphen is a different mark and reads as a dash in a column of figures. */
export const MINUS_SIGN = "−";

const AMOUNT = /^(-?)(0|[1-9][0-9]*)\.([0-9]{2})$/;

export interface MoneyParts {
  readonly negative: boolean;
  /** Digits before the decimal point, no grouping. */
  readonly whole: string;
  /** Exactly two digits. */
  readonly cents: string;
}

/** The parts of a wire amount, or null when the text is not one. `-0.00` is read as zero: a figure
 * is negative only when it is below zero. */
export function parseMoney(value: string): MoneyParts | null {
  const match = AMOUNT.exec(value);
  if (!match) return null;
  const whole = match[2] as string;
  const cents = match[3] as string;
  return { negative: match[1] === "-" && !(whole === "0" && cents === "00"), whole, cents };
}

/** True for any amount below zero. `0.00` is never negative. */
export const isNegativeMoney = (value: string): boolean => parseMoney(value)?.negative ?? false;

/** True for exactly zero: "0.00" (and "-0.00", which is zero written oddly). */
export function isZeroMoney(value: string): boolean {
  const parts = parseMoney(value);
  return parts !== null && parts.whole === "0" && parts.cents === "00";
}

/** A locale tag the runtime accepts, or US English for one it does not (a malformed tag throws). */
function usableLocale(locale: string): string {
  try {
    new Intl.NumberFormat(locale);
    return locale;
  } catch {
    return "en-US";
  }
}

const decimalSeparators = new Map<string, string>();
function decimalSeparator(locale: string): string {
  let known = decimalSeparators.get(locale);
  if (known === undefined) {
    known =
      new Intl.NumberFormat(locale).formatToParts(1.1).find((part) => part.type === "decimal")
        ?.value ?? ".";
    decimalSeparators.set(locale, known);
  }
  return known;
}

/** A wire amount as a person reads it: digits grouped the way the locale groups them, two decimals,
 * and a negative figure with a real minus sign ("−1,150.00"). Text that is not a wire amount is
 * returned unchanged rather than guessed at. */
export function formatMoney(value: string, locale = "en-US"): string {
  const parts = parseMoney(value);
  if (!parts) return value;
  const tag = usableLocale(locale);
  // BigInt keeps every digit exact; a Number would round figures past fifteen digits.
  const whole = new Intl.NumberFormat(tag, { useGrouping: true }).format(BigInt(parts.whole));
  const cents = new Intl.NumberFormat(tag, { minimumIntegerDigits: 2, useGrouping: false }).format(
    BigInt(parts.cents),
  );
  const text = `${whole}${decimalSeparator(tag)}${cents}`;
  return parts.negative ? `${MINUS_SIGN}${text}` : text;
}

/** The figure without its sign, grouped: "1,150.00" for "-1150.00". For a column that already says
 * which way the money went (money in, money out). */
export function formatMoneyAbsolute(value: string, locale = "en-US"): string {
  const parts = parseMoney(value);
  return parts ? formatMoney(`${parts.whole}.${parts.cents}`, locale) : value;
}

const SHARE = /^(-?)(0|[1-9][0-9]*)\.([0-9])$/;

export interface ShareParts {
  readonly negative: boolean;
  /** Digits before the decimal point, no grouping. */
  readonly whole: string;
  /** Exactly one digit. */
  readonly tenth: string;
}

/** The parts of a share of income as the service writes it ("30.2", "-29.4", "100.0"), or null when the
 * text is not one. `-0.0` is read as zero: a share is negative only when it is below zero. */
export function parseShare(value: string): ShareParts | null {
  const match = SHARE.exec(value);
  if (!match) return null;
  const whole = match[2] as string;
  const tenth = match[3] as string;
  return { negative: match[1] === "-" && !(whole === "0" && tenth === "0"), whole, tenth };
}

/** True for any share below zero. `0.0` is never negative. */
export const isNegativeShare = (value: string): boolean => parseShare(value)?.negative ?? false;

/** A share of income as a person reads it: digits grouped the way the locale groups them, one decimal,
 * a real minus sign and a percent sign ("−29.4%"). The service worked the share out from integers and
 * wrote it as text; here it stays text, so a share reads exactly as it was made. Text that is not a
 * share is returned unchanged rather than guessed at. */
export function formatShare(value: string, locale = "en-US"): string {
  const parts = parseShare(value);
  if (!parts) return value;
  const tag = usableLocale(locale);
  const whole = new Intl.NumberFormat(tag, { useGrouping: true }).format(BigInt(parts.whole));
  // The digit after the point is written in the locale's digits too, as the cents of an amount are.
  const tenth = new Intl.NumberFormat(tag, { useGrouping: false }).format(BigInt(parts.tenth));
  const text = `${whole}${decimalSeparator(tag)}${tenth}%`;
  return parts.negative ? `${MINUS_SIGN}${text}` : text;
}

/** A complete wire amount standing alone in a sentence: an optional minus, digits without a leading
 * zero, a point and exactly two decimals. Not part of a longer word or number (a date, a version, an
 * id, a figure already grouped), and a full stop after it ends the sentence and is not a decimal point. */
const AMOUNT_IN_TEXT = /(?<![\w.,−-])-?(?:0|[1-9]\d*)\.\d{2}(?![\w]|\.\d)/g;

/** A whole instant standing in a sentence, as the service writes it: "2026-10-04T18:57:24.887Z". */
const INSTANT_IN_TEXT =
  /(?<![\w-])\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})(?![\w])/g;

/** A whole calendar day standing in a sentence, "2026-10-04". Not part of a longer word, number or id
 * (a file name such as "profit-loss-2025-10-01-to-2026-06-15.csv" is left alone), and only a real
 * calendar day: "2026-02-30" stays as it is. */
const DATE_IN_TEXT = /(?<![\w-])\d{4}-\d{2}-\d{2}(?![\w-])/g;

/** What the service calls three things, which the screens call something else (the plan's "One vocabulary").
 * The service speaks the language of the API and the command line: `inbox`, `cutover`, the bank feed. A
 * rule keeps the capital of the word it replaces. The Inbox is a tab called For review, and a sentence does not
 * name a tab (the founder, 2026-11-22: "You can't just reference UI components in the middle of a sentence"): what
 * waits there is "waiting for review", and the list itself, where a sentence needs a noun, is "the review list". */
const SERVICE_WORDS: readonly (readonly [RegExp, (...match: string[]) => string])[] = [
  [/\b([Aa])n Inbox item\b/g, (_all, a = "a") => `${a === "A" ? "A" : "a"} transaction`],
  [/\bqueued in the Inbox for review\b/g, () => "queued for review"],
  [
    /\bInbox (lines?)\b/g,
    (_all, noun = "lines") => `transaction${noun === "line" ? "" : "s"} for review`,
  ],
  [/\bInbox items\b/g, () => "transactions"],
  [/\bInbox item\b/g, () => "transaction"],
  [/\b(?:still )?waiting in the Inbox\b/g, () => "waiting for review"],
  [/\bInbox (entr(?:y|ies))\b/g, (_all, noun = "entry") => `${noun} for review`],
  [/\b([Tt])he Inbox's\b/g, (_all, t = "t") => `${t}he review list's`],
  [/\b([Tt])he Inbox\b/g, (_all, t = "t") => `${t}he review list`],
  [/\bInbox\b/g, () => "review list"],
  [/\b([Cc])utover( date)?\b/g, (_all, c = "c") => (c === "C" ? "Start date" : "start date")],
  [/\b([Bb])ank feed\b/g, (_all, b = "b") => (b === "B" ? "Bank connection" : "bank connection")],
  [/\b([Gg])ap log\b/g, (_all, g = "g") => (g === "G" ? "Things to check" : "things to check")],
];

/** A command, an option or an operation name keeps the service's word: `rastrata cutover set --date ...`,
 * `inbox.configureSource`, anything in backticks. */
const SERVICE_CODE =
  /`[^`\n]*`|\brastrata [a-z][a-z-]*(?: [a-z][a-z-]*)*(?: --?[a-z-]+(?:[ =][^\s,;:)]+)?)*|\b[a-z]+\.[a-zA-Z.]+\b/g;

/** What a refusal says for a script and not for a person: how a closed month is reopened by its operation's name
 * (and, in what older services wrote, on which screen). On a screen the person has the button. */
const FOR_A_SCRIPT = /\s*\((?:Reopen on the Periods screen, or )?periods\.prepare[^)]*\)/g;

/** A sentence the service wrote, in the application's own words: "11 lines queued in the Inbox for review"
 * says "queued for review", "the cutover date" says "the start date", "the bank feed" says "the bank
 * connection". A command, an option and an operation name are left as they are. */
export function inAppWords(text: string): string {
  return outsideCode(text, (piece) => {
    let out = piece;
    for (const [pattern, replacement] of SERVICE_WORDS) {
      const before = out;
      out = before.replace(pattern, (...args: (string | number)[]) => {
        // The arguments are the match, its groups, the offset and the whole text.
        const offset = args[args.length - 2] as number;
        const said = replacement(...(args.slice(0, -2) as string[]));
        // At the start of a sentence a word is capitalized.
        const head = before.slice(0, offset);
        return (head === "" || /[.!?]\s$/.test(head)) && /^[a-z]/.test(said)
          ? `${said.charAt(0).toUpperCase()}${said.slice(1)}`
          : said;
      });
    }
    return out;
  });
}

/** Say something about every part of a sentence that is not a command, an option or an operation name. */
function outsideCode(text: string, say: (piece: string) => string): string {
  let result = "";
  let last = 0;
  for (const match of text.matchAll(SERVICE_CODE)) {
    const at = match.index ?? 0;
    result += say(text.slice(last, at)) + match[0];
    last = at + match[0].length;
  }
  return result + say(text.slice(last));
}

/** A sentence about a bank's transactions, in the application's words. The service says "line" for a bank's
 * transaction ("11 lines queued", "has a line for exactly 250.00", "most lines are positive"); the application says
 * "transaction". Only the caller knows a sentence is about a bank's transactions (a line is also a file's row, an
 * entry's line and a tax line), so this is for those callers: it says what `inAppWords` says, and then
 * "transaction" for "line". A command, an option and an operation name keep the service's word, and so does "line
 * break". */
export function transactionsIn(text: string): string {
  return outsideCode(inAppWords(text), (piece) =>
    piece
      .replace(/\bLines\b/g, "Transactions")
      .replace(/\bLine\b(?! (?:break|by line|number))/g, "Transaction")
      .replace(/\blines\b/g, "transactions")
      .replace(/\bline\b(?! (?:break|by line|number))/g, "transaction"),
  );
}

/** A sentence the service wrote, as a person reads it everywhere else in the application: its words are the
 * application's (`inAppWords`) and its figures are shown the way every other figure is shown: "Debits are
 * 12500.00 and credits are -3.50" becomes "Debits are 12,500.00 and credits are −3.50", "last
 * compared at 2026-10-04T18:57:24.887Z" becomes "last compared at Oct 4, 2026, 6:57 PM" (on the
 * viewer's clock), and "posted on 2026-10-04" becomes "posted on Oct 4, 2026". Only a complete amount,
 * instant or calendar day is touched, so versions, ids and hashes stay as they are. Use it where the
 * service's own words reach a screen (never on text a person typed); a figure on its own goes through
 * `formatMoney`, `formatDate` or `formatInstant`. */
export function formatFiguresInText(text: string, locale = "en-US"): string {
  return inAppWords(text.replace(FOR_A_SCRIPT, ""))
    .replace(INSTANT_IN_TEXT, (instant) => formatInstant(instant))
    .replace(AMOUNT_IN_TEXT, (amount) => formatMoney(amount, locale))
    .replace(DATE_IN_TEXT, (date) => formatDate(date));
}

/** A wire amount as whole cents. Throws for text that is not an amount, because arithmetic on a
 * guess would be worse than no arithmetic. */
export function moneyToCents(value: string): bigint {
  const parts = parseMoney(value);
  if (!parts) throw new TypeError(`Not an amount: ${value}`);
  const cents = BigInt(parts.whole) * 100n + BigInt(parts.cents);
  return parts.negative ? -cents : cents;
}

/** Whole cents as a wire amount. Zero is "0.00", never "-0.00". */
export function centsToMoney(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `${negative ? "-" : ""}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

/** `total` less every part, exactly: the difference a tie-out shows. */
export function moneyDifference(total: string, parts: readonly string[]): string {
  return centsToMoney(parts.reduce((left, part) => left - moneyToCents(part), moneyToCents(total)));
}

/** The sum of wire amounts, exactly. */
export function moneySum(values: readonly string[]): string {
  return centsToMoney(values.reduce((sum, value) => sum + moneyToCents(value), 0n));
}

/** A whole number with thousands separators: "12,345". Not for money. */
export function formatCount(value: number, locale = "en-US"): string {
  return new Intl.NumberFormat(usableLocale(locale)).format(value);
}

/** A whole percentage: 20 is "20%". Not rounded here; the caller decides how much precision it can
 * honestly claim. */
export function formatPercent(value: number, locale = "en-US"): string {
  return `${new Intl.NumberFormat(usableLocale(locale), { maximumFractionDigits: 1 }).format(value)}%`;
}

/** The size of a file in the units a person reads: "820 bytes", "14.2 KiB", "3.1 MiB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  const one = (value: number) =>
    new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(
      value,
    );
  if (bytes < 1024 * 1024) return `${one(bytes / 1024)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${one(bytes / (1024 * 1024))} MiB`;
  return `${one(bytes / (1024 * 1024 * 1024))} GiB`;
}

/** How long something took: "380 ms", "41 s", "2 min 5 s", "1 h 3 min". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return seconds % 60 === 0 ? `${minutes} min` : `${minutes} min ${seconds % 60} s`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

// ---- Dates ----------------------------------------------------------------------------------
// A date in Rastrata is a calendar day with no time and no zone, stored "2026-10-04" (the API, the CLI,
// the exports and a tooltip keep that form). A screen shows it the way a person writes it, "Oct 4,
// 2026": US English month names, no zero on the day, and the month spelled so it cannot be read as
// another country's day-month order. An instant is a moment, stored in UTC ("2026-10-04T13:01:00Z"),
// and is shown on the viewer's own clock: an entry made at nine in the evening is dated that evening,
// not the next day.

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

export interface DateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** A real calendar day, or null: "2026-02-30" is not one. */
export function parseDate(value: string): DateParts | null {
  const match = DATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export const isDate = (value: string): boolean => parseDate(value) !== null;

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** How a date is written. "medium" is the default and the plan's: "Oct 4, 2026". "numeric" is the US
 * numeric form, "10/04/2026", and "iso" is the stored form, "2026-10-04". The Business setting "Date
 * format" chooses among them (`setDateFormat`). A tooltip and `datetime` say ISO whatever is chosen, and
 * exports, the CLI and the API never use any of these. */
export type DateFormat = "medium" | "numeric" | "iso";
export const DATE_FORMATS: readonly DateFormat[] = ["medium", "numeric", "iso"];

let preferredDateFormat: DateFormat = "medium";
const dateFormatListeners = new Set<() => void>();

/** The format dates are written in now: "medium" until `setDateFormat` says otherwise. */
export const dateFormat = (): DateFormat => preferredDateFormat;

/** Choose how every date the application writes is written, from now on: `formatDate`, `formatInstant`,
 * `formatDateRange`, `formatWeekdayDate`, the dates in the service's own sentences, and `DateValue`. A
 * format that is not one of the three is ignored. The application calls it once, from the book's own
 * settings, and again when the owner saves them. */
export function setDateFormat(format: DateFormat): void {
  if (!DATE_FORMATS.includes(format) || format === preferredDateFormat) return;
  preferredDateFormat = format;
  for (const listener of [...dateFormatListeners]) listener();
}

/** Be told when the format changes (a component that shows dates reads them again). Returns the way to
 * stop being told. */
export function onDateFormatChange(listener: () => void): () => void {
  dateFormatListeners.add(listener);
  return () => {
    dateFormatListeners.delete(listener);
  };
}

/** A calendar day in a format: "Oct 4, 2026" (the month's short English name, the day without a leading
 * zero, the year), "10/04/2026" or "2026-10-04". Left out, the format the book chose. */
const dateText = (
  { year, month, day }: DateParts,
  format: DateFormat = preferredDateFormat,
): string => {
  if (format === "iso") return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
  if (format === "numeric") return `${pad(month)}/${pad(day)}/${pad(year, 4)}`;
  return `${MONTHS[month - 1]} ${day}, ${pad(year, 4)}`;
};

/** A calendar day in the stored form, `YYYY-MM-DD`: what a date field hands back for a day typed or picked. */
export const storedDate = (day: DateParts): string => dateText(day, "iso");

/** "9:05 AM": twelve hours, no leading zero, AM or PM, as a US reader writes a time. */
const timeText = (hour: number, minute: number): string =>
  `${hour % 12 === 0 ? 12 : hour % 12}:${pad(minute)} ${hour < 12 ? "AM" : "PM"}`;

/** How to read a date or an instant when the defaults are not wanted. `timeZone`: left out, the viewer's
 * own zone (the browser's on a screen, which Playwright fixes to UTC for a test, and the process's
 * elsewhere); name an IANA zone ("UTC", "America/Denver") to read the same instant on another clock.
 * `format`: left out, the format the book chose; name one to show an example of each. */
export interface DateOptions {
  readonly timeZone?: string | undefined;
  readonly format?: DateFormat | undefined;
}

/** The calendar day and clock time of an instant as it is lived in a zone. */
function clockIn(
  moment: Date,
  timeZone?: string,
): DateParts & { readonly hour: number; readonly minute: number } {
  if (timeZone !== undefined) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
      }).formatToParts(moment);
      const read = (type: string): number =>
        Number(parts.find((part) => part.type === type)?.value);
      return {
        year: read("year"),
        month: read("month"),
        day: read("day"),
        hour: read("hour") % 24,
        minute: read("minute"),
      };
    } catch {
      // A zone the runtime does not know is read as the viewer's own.
    }
  }
  return {
    year: moment.getFullYear(),
    month: moment.getMonth() + 1,
    day: moment.getDate(),
    hour: moment.getHours(),
    minute: moment.getMinutes(),
  };
}

/** A date as "Oct 4, 2026". An instant ("2026-10-04T13:01:00Z") shows the day it falls on, on the
 * viewer's clock. Text that is neither is returned as it came. */
export function formatDate(value: string, options: DateOptions = {}): string {
  const day = parseDate(value);
  if (day) return dateText(day, options.format);
  const moment = instantOf(value);
  return moment ? dateText(clockIn(moment, options.timeZone), options.format) : value;
}

/** A date with its weekday, "Sunday, Oct 4, 2026", for the one line that says what day it is. */
export function formatWeekdayDate(value: string, options: DateOptions = {}): string {
  const day = parseDate(value);
  if (!day) return formatDate(value, options);
  const weekday = WEEKDAYS[new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay()];
  return `${weekday}, ${dateText(day, options.format)}`;
}

/** Two dates as one phrase: a period, the range a report covers, the days a calendar spans. The one
 * place a range is written, so every screen words it the same way. A range inside one year names the
 * year once ("Jan 1 to Oct 4, 2026"), a range across years names both ("Oct 1, 2025 to Sep 30,
 * 2026"), and a single day is that day. In the numeric and ISO formats both dates are written in
 * full. Text that is not a date is left as it came. */
export function formatDateRange(from: string, to: string, options: DateOptions = {}): string {
  const first = parseDate(from);
  const last = parseDate(to);
  if (!first || !last) return `${formatDate(from, options)} to ${formatDate(to, options)}`;
  const format = options.format ?? preferredDateFormat;
  if (from === to) return dateText(first, format);
  if (format !== "medium" || first.year !== last.year)
    return `${dateText(first, format)} to ${dateText(last, format)}`;
  return `${MONTHS[first.month - 1]} ${first.day} to ${dateText(last, format)}`;
}

function instantOf(value: string): Date | null {
  if (!INSTANT.test(value)) return null;
  const moment = new Date(value);
  return Number.isNaN(moment.getTime()) ? null : moment;
}

/** True for a moment as the service writes it: "2026-10-04T13:01:00Z". */
export const isInstant = (value: string): boolean => instantOf(value) !== null;

/** An instant as "Oct 4, 2026, 1:01 PM" on the viewer's own clock: an entry recorded at nine in the
 * evening reads as that evening. A bare date is shown as a date. Text that is neither is returned as
 * it came. The exact moment is in the value itself (`DateValue` keeps it in `datetime` and `title`). */
export function formatInstant(value: string, options: DateOptions = {}): string {
  const day = parseDate(value);
  if (day) return dateText(day, options.format);
  const moment = instantOf(value);
  if (!moment) return value;
  const clock = clockIn(moment, options.timeZone);
  return `${dateText(clock, options.format)}, ${timeText(clock.hour, clock.minute)}`;
}

/** The time of day on the viewer's own clock, "9:05 AM", from a clock that is passed in, for a line
 * that says when something was last read ("Checked at 9:05 AM"). It is the viewer's zone on purpose:
 * the moment is the viewer's own, and the line says nothing else about it. */
export function formatTime(now: Date, options: DateOptions = {}): string {
  const clock = clockIn(now, options.timeZone);
  return timeText(clock.hour, clock.minute);
}

/** "just now", "12 minutes ago", "30 hours ago", "3 days ago", from an instant and the current one
 * (passed in, so a test can fix it). Hours are used up to two days because "30 hours ago" says more
 * about a backup than "1 day ago" does. An instant in the future, which a clock that is behind can
 * produce, reads as "just now" and never as negative time. */
export function formatAge(value: string, now: Date): string {
  const moment = instantOf(value);
  if (!moment) return value;
  const seconds = Math.max(0, Math.round((now.getTime() - moment.getTime()) / 1000));
  const unit = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"} ago`;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return unit(Math.floor(seconds / 60), "minute");
  if (seconds < 172_800) return unit(Math.floor(seconds / 3600), "hour");
  return unit(Math.floor(seconds / 86_400), "day");
}

/** Whole days from one date to another ("YYYY-MM-DD" both), without a zone: 2026-10-04 is 3 days after
 * 2026-10-01. NaN when either is not a date. */
export function daysBetween(from: string, to: string): number {
  const read = (value: string): number => {
    const parts = parseDate(value);
    return parts ? Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000 : Number.NaN;
  };
  return Math.round(read(to) - read(from));
}

/** The name of a month, "September": a month on its own is a name, not a date. */
export function monthName(month: number, locale = "en-US"): string {
  return new Intl.DateTimeFormat(usableLocale(locale), { month: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(2000, month - 1, 1)),
  );
}

/** A whole month, "September 2026", from "2026-09" or any date in it. A month on its own is a name
 * for a period, so it keeps its name; a day is always a date. */
export function formatMonth(value: string, locale = "en-US"): string {
  const match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(value);
  if (!match) return value;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? `${monthName(month, locale)} ${match[1]}` : value;
}

/** A month in a column heading, "Sep 2026", from "2026-09" or any date in it. The same month as
 * `formatMonth`, short enough for a column of figures. */
export function formatMonthShort(value: string, locale = "en-US"): string {
  const match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(value);
  if (!match) return value;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return value;
  const name = new Intl.DateTimeFormat(usableLocale(locale), {
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2000, month - 1, 1)));
  return `${name} ${match[1]}`;
}

/** Today as "YYYY-MM-DD" in the viewer's own zone, from a clock that is passed in. The only place a
 * screen reads the clock, so a test can fix the day. */
export function localToday(now: Date = new Date()): string {
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The first day of the month a date falls in: "2026-10-01" for "2026-10-17". */
export function firstOfMonth(date: string): string {
  const parts = parseDate(date);
  return parts ? `${pad(parts.year, 4)}-${pad(parts.month)}-01` : date;
}

/** "Month/day/year" in the order the locale writes a date in a date field, for the hint under one.
 * The field itself is the browser's; this only says what order to expect. */
export function dateInputOrder(locale: string): string {
  try {
    const parts = new Intl.DateTimeFormat(usableLocale(locale), {
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).formatToParts(new Date(Date.UTC(2026, 8, 23)));
    const names: Record<string, string> = { month: "month", day: "day", year: "year" };
    const separator = parts.find((part) => part.type === "literal")?.value.trim() || "/";
    const order = parts.flatMap((part) => (names[part.type] ? [names[part.type] as string] : []));
    if (order.length === 3) {
      const text = order.join(separator);
      return text.charAt(0).toUpperCase() + text.slice(1);
    }
  } catch {
    // Fall through to the unambiguous default.
  }
  return "Month/day/year";
}

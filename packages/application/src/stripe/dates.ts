/** Dates. A Stripe timestamp is an instant (seconds since the Unix epoch); the book's dates are local
 * calendar dates. The conversion is explicit, in one named time zone chosen by the owner
 * ("UTC" unless they say otherwise, matching the book's accounting time zone), and nothing else in
 * this lane converts through a zone. A payout's arrival date is a date, not an instant, so it is
 * always read in UTC. Portable: Intl is available in Bun, Node and Workers. */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, found);
  }
  return found;
}

/** True when `name` is an IANA time zone this runtime knows. Never throws. */
export function isTimeZone(name: string): boolean {
  if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(name)) return false;
  try {
    formatter(name);
    return true;
  } catch {
    return false;
  }
}

interface Parts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function parts(unixSeconds: number, timeZone: string): Parts {
  const found: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(unixSeconds * 1000)))
    if (part.type !== "literal") found[part.type] = Number(part.value);
  const read = (key: string): number => {
    const value = found[key];
    if (value === undefined || !Number.isInteger(value)) throw new RangeError("Unreadable date");
    return value;
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

const two = (n: number): string => String(n).padStart(2, "0");

/** The calendar date, "YYYY-MM-DD", at `unixSeconds` in `timeZone`. */
export function localDate(unixSeconds: number, timeZone: string): string {
  const p = parts(unixSeconds, timeZone);
  return `${String(p.year).padStart(4, "0")}-${two(p.month)}-${two(p.day)}`;
}

/** The calendar date at `unixSeconds` in UTC. */
export function utcDate(unixSeconds: number): string {
  return localDate(unixSeconds, "UTC");
}

/** The first instant (Unix seconds) of the calendar date `date` in `timeZone`. */
export function startOfLocalDay(date: string, timeZone: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new RangeError("Dates are YYYY-MM-DD");
  const [, year, month, day] = match;
  const utcMidnight = Date.UTC(Number(year), Number(month) - 1, Number(day)) / 1000;
  // The zone's offset from UTC at that moment, found by reading the zone's wall clock. Applied
  // twice so a daylight-saving change near midnight settles on the right instant.
  const offsetAt = (instant: number): number => {
    const p = parts(instant, timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000 - instant;
  };
  const first = utcMidnight - offsetAt(utcMidnight);
  const second = utcMidnight - offsetAt(first);
  return localDate(second, timeZone) === date ? second : first;
}

const DAY_MS = 86_400_000;

/** Whole days from 1970-01-01 to `date`, for exact day differences with no time zone involved. */
export function dayNumber(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new RangeError("Dates are YYYY-MM-DD");
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS;
}

export function dateFromDayNumber(days: number): string {
  const d = new Date(days * DAY_MS);
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
}

export function addDays(date: string, days: number): string {
  return dateFromDayNumber(dayNumber(date) + days);
}

/** `later` minus `earlier`, in whole days. */
export function daysBetween(earlier: string, later: string): number {
  return dayNumber(later) - dayNumber(earlier);
}

export function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try {
    return dateFromDayNumber(dayNumber(value)) === value;
  } catch {
    return false;
  }
}

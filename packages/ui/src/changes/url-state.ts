import { parseDate } from "../format";
import type { ChangeKindId, MakerKind } from "./types";

/** The state of the Changes screen, as a query string: where the list starts, who made the changes, what
 * kind they are, the words searched for and the page. It lives in the address so a link, a reload and
 * the back button all land on the same list. Pure and exact: nothing here reads a clock (today is passed
 * in), and an address that names something that does not exist is answered with the default, never an
 * error. */

/** Where the list starts. `look`: after the last time a person said they had looked. `close`: after the
 * last time the books were closed. `week` and `month`: that many days back. `year`: the first of January.
 * `all`: the start of the books. A date (`YYYY-MM-DD`) is also a start. */
export const SINCE_CHOICES = ["look", "close", "week", "month", "year", "all"] as const;
export type SinceChoice = (typeof SINCE_CHOICES)[number];

/** The kinds of change the "What" choice groups. Account tags are with accounts. The day the books were
 * opened, and a change the list has no name for, are in "Everything" only. */
export const WHAT_GROUPS = [
  "entries",
  "periods",
  "accounts",
  "rules",
  "reconciliations",
  "access",
] as const;
export type WhatGroup = (typeof WHAT_GROUPS)[number];

export const GROUP_KINDS: Readonly<Record<WhatGroup, readonly ChangeKindId[]>> = {
  entries: ["entry.posted", "entry.reversed"],
  periods: ["period.closed", "period.reopened", "calendar.extended"],
  accounts: ["account.added", "account.changed", "account.closed", "account.tagged"],
  rules: ["rule.created", "rule.changed"],
  reconciliations: ["reconciliation.completed", "reconciliation.voided"],
  access: ["access.granted", "access.revoked"],
};

export const PAGE_SIZE = 25;
export const SEARCH_MAX = 200;

export interface ChangesScreenState {
  /** A named choice (`SinceChoice`) or a date, `YYYY-MM-DD`. */
  readonly since: string;
  /** Nothing for anyone; a kind of maker (`agent`); one maker by identifier (`agent@abc`) or, where
   * there is none, by name (`agent:weekly-run`). */
  readonly who: string;
  readonly what: "" | WhatGroup;
  /** Plain words; never a pattern. */
  readonly text: string;
  /** From 1. */
  readonly page: number;
}

export const DEFAULT_STATE: ChangesScreenState = {
  since: "look",
  who: "",
  what: "",
  text: "",
  page: 1,
};

const MAKER_KINDS: readonly MakerKind[] = ["owner", "person", "agent", "service", "unknown"];
const WHO = /^(owner|person|agent|service|unknown)(?:@([^\s]{1,128})|:(.{1,100}))?$/;
const PAGE = /^[1-9][0-9]{0,5}$/;

export const isSinceChoice = (value: string): value is SinceChoice =>
  (SINCE_CHOICES as readonly string[]).includes(value);
export const isWhatGroup = (value: string): value is WhatGroup =>
  (WHAT_GROUPS as readonly string[]).includes(value);

/** A date a person can start from: a real calendar day. */
export const isStartDate = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && parseDate(value) !== null;

/** The state an address names. Anything it does not understand is left at the default. */
export function parseState(search: string | URLSearchParams): ChangesScreenState {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const since = params.get("since") ?? "";
  const who = params.get("who") ?? "";
  const what = params.get("what") ?? "";
  const text = (params.get("q") ?? "").replace(/\s+/g, " ").trim().slice(0, SEARCH_MAX);
  const page = params.get("page") ?? "";
  return {
    since: isSinceChoice(since) || isStartDate(since) ? since : DEFAULT_STATE.since,
    who: WHO.test(who) ? who : "",
    what: isWhatGroup(what) ? what : "",
    text,
    page: PAGE.test(page) ? Number(page) : 1,
  };
}

/** The query string for a state: nothing at the default, and only what differs from it. */
export function stateSearch(state: ChangesScreenState): string {
  const params = new URLSearchParams();
  if (state.since !== DEFAULT_STATE.since) params.set("since", state.since);
  if (state.who !== "") params.set("who", state.who);
  if (state.what !== "") params.set("what", state.what);
  if (state.text !== "") params.set("q", state.text);
  if (state.page > 1) params.set("page", String(state.page));
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

export const sameState = (left: ChangesScreenState, right: ChangesScreenState): boolean =>
  left.since === right.since &&
  left.who === right.who &&
  left.what === right.what &&
  left.text === right.text &&
  left.page === right.page;

/** Whether a choice hides some of the changes in the window: then the list is not everything, and no
 * one can say they looked at it all. */
export const filtersActive = (state: ChangesScreenState): boolean =>
  state.who !== "" || state.what !== "" || state.text !== "";

/** Whole days from 1970-01-01 to a calendar day (proleptic Gregorian), by arithmetic alone: no clock and
 * no zone are involved, so the same day gives the same number everywhere. */
function dayNumber(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * ((month + 9) % 12) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** The calendar day a number of days after 1970-01-01 is: the inverse of `dayNumber`. */
function dayFromNumber(count: number): { year: number; month: number; day: number } {
  const z = count + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthFromMarch = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthFromMarch + 2) / 5) + 1;
  const month = monthFromMarch < 10 ? monthFromMarch + 3 : monthFromMarch - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

const two = (value: number): string => String(value).padStart(2, "0");

/** A date some days after another (before, when the number is negative), both `YYYY-MM-DD`. A text that
 * is not a date is returned as it came. */
export function addDays(date: string, days: number): string {
  const parts = parseDate(date);
  if (!parts) return date;
  const next = dayFromNumber(dayNumber(parts.year, parts.month, parts.day) + days);
  return `${String(next.year).padStart(4, "0")}-${two(next.month)}-${two(next.day)}`;
}

/** One maker as `changes.list` takes it. */
export interface MakerFilter {
  readonly kind: MakerKind;
  readonly label?: string;
  readonly id?: string;
}

/** `changes.list`'s input, as far as this screen uses it. */
export interface ChangesQuery {
  readonly since?: string;
  readonly kinds?: readonly ChangeKindId[];
  readonly by?: MakerFilter;
  readonly text?: string;
  readonly page?: number;
  readonly pageSize: number;
  /** Read the ledger as it was; passed back from the first page so a page does not shift. */
  readonly revision?: string;
  readonly asOf?: string;
}

/** The maker a `who` value names, or nothing for anyone. */
export function makerFilter(who: string): MakerFilter | undefined {
  const match = WHO.exec(who);
  if (!match) return undefined;
  const kind = match[1] as MakerKind;
  if (!MAKER_KINDS.includes(kind)) return undefined;
  if (match[2] !== undefined) return { kind, id: match[2] };
  if (match[3] !== undefined) return { kind, label: match[3] };
  return { kind };
}

/** What `since` means to the service, on a day. */
export function sinceInput(since: string, today: string): string | undefined {
  switch (since) {
    case "look":
      return "lastReview";
    case "close":
      return "lastClose";
    case "week":
      return addDays(today, -7);
    case "month":
      return addDays(today, -30);
    case "year":
      return `${today.slice(0, 4)}-01-01`;
    case "all":
      return undefined;
    default:
      return isStartDate(since) ? since : "lastReview";
  }
}

/** What to ask the service for a state. `pin` is the revision and instant the list was first read at, to
 * pass back so that every page of it is the same list. */
export function queryOf(
  state: ChangesScreenState,
  today: string,
  pin?: { readonly revision: string; readonly asOf: string },
): ChangesQuery {
  const since = sinceInput(state.since, today);
  const by = makerFilter(state.who);
  return {
    ...(since === undefined ? {} : { since }),
    ...(state.what === "" ? {} : { kinds: GROUP_KINDS[state.what] }),
    ...(by === undefined ? {} : { by }),
    ...(state.text === "" ? {} : { text: state.text }),
    ...(state.page > 1 ? { page: state.page } : {}),
    pageSize: PAGE_SIZE,
    ...(pin === undefined ? {} : { revision: pin.revision, asOf: pin.asOf }),
  };
}

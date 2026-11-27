/** Account tags: the pure model. How recorded changes fold into "the tags in force on a date", how
 * the whole history hashes, and which values an account may carry. No storage and no clock, so it
 * is the same in the service, a test and a Worker.
 *
 * A tag is product metadata the kernel's account snapshot does not carry. Each tag has its own
 * timeline per account: a record says "from this date, this tag has this value" (or, with a null
 * value, "from this date, it has none"). The record with the latest effective date at or before the
 * date asked for wins; records for the same date are ordered by when they were recorded, so a
 * correction supersedes the entry it corrects without erasing it. Nothing is edited or deleted. */
import { hashCanonical, type CanonicalValue } from "@rastrata/kernel";
import type { AccountRole } from "../contracts.ts";
import type { AccountTagMap, AccountTags, CashFlowClass, TaggedKind } from "../account-tags.ts";
import { ApplicationError } from "../errors.ts";
import { knownTaxLine, lineAcceptsRole } from "./tax-lines.ts";

export const TAG_KEYS = ["cashFlowClass", "taxLine", "roleKey", "kind"] as const;
export type TagKey = (typeof TAG_KEYS)[number];

export const CASH_FLOW_CLASSES: readonly CashFlowClass[] = [
  "cash",
  "operating",
  "investing",
  "financing",
  "noncash",
];

/** A bank account is an asset; a card is a liability. */
export const TAGGED_KINDS: readonly TaggedKind[] = ["bank", "card"];

/** Cash-flow classes describe where a balance-sheet account's changes belong in the statement. */
export const BALANCE_SHEET_ROLES: readonly AccountRole[] = ["asset", "liability", "equity"];

/** "scheduleC.line16c": a form id, then the printed line number. Whether the line exists is the
 * tax-line catalog's question; this only bounds the text. */
export const TAX_LINE_PATTERN = /^[A-Za-z][A-Za-z0-9]{1,15}\.line[0-9]{1,2}[a-z]?$/;
/** "stripe.balance", "payouts.in-transit": a lower-case key other lanes use to find an account. */
export const ROLE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
export const ROLE_KEY_MAX = 40;

/** The role keys that say which account is the book's catch-all: where money collects when nobody has said
 * what it was for ("Other expenses", "Other income"). A book that has none watches nothing; an account is
 * never guessed to be one. Each is held by one account, and only by an account of the right kind. */
export const CATCHALL_EXPENSE = "catchall.expense";
export const CATCHALL_INCOME = "catchall.income";
/** The kind of account a role key may be put on, for the keys that name one. */
export const ROLE_KEY_ACCOUNT_ROLE: Readonly<Record<string, AccountRole>> = {
  [CATCHALL_EXPENSE]: "expense",
  [CATCHALL_INCOME]: "income",
};

/** Tags given when the book was set up apply from the beginning of time, so any later record, on
 * any date the book can have, supersedes them. They are read from the immutable setup record. */
export const SETUP_EFFECTIVE_ON = "0001-01-01";

/** One recorded change. `seq` orders records; the setup layer has sequence 0. */
export interface TagRecord {
  readonly seq: number;
  readonly accountId: string;
  readonly tag: TagKey;
  readonly effectiveOn: string;
  /** null clears the tag from `effectiveOn`. */
  readonly value: string | null;
}

export function isTagKey(value: string): value is TagKey {
  return (TAG_KEYS as readonly string[]).includes(value);
}

/** A real calendar date in `YYYY-MM-DD` form, never converted through a time zone. */
export function isCalendarDate(value: string): boolean {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day <= days;
}

const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

interface Entry {
  readonly effectiveOn: string;
  readonly seq: number;
  readonly value: string | null;
}

/** The records that matter, as a timeline per account and tag: for each effective date the last
 * record made, and only the ones that change the value. A record that repeats the value already in
 * force says nothing the earlier record did not, so it is dropped: the result describes what is in
 * force on every date, however it was recorded. */
function effective(records: readonly TagRecord[]): TagRecord[] {
  const latest = new Map<string, TagRecord>();
  for (const record of records) {
    const key = `${record.accountId}\u0000${record.tag}\u0000${record.effectiveOn}`;
    const previous = latest.get(key);
    if (!previous || record.seq >= previous.seq) latest.set(key, record);
  }
  const ordered = [...latest.values()].sort(
    (a, b) =>
      compare(a.accountId, b.accountId) ||
      compare(a.tag, b.tag) ||
      compare(a.effectiveOn, b.effectiveOn),
  );
  const changes: TagRecord[] = [];
  let inForce: string | null = null;
  let timeline = "";
  for (const record of ordered) {
    const id = `${record.accountId}\u0000${record.tag}`;
    if (id !== timeline) {
      timeline = id;
      inForce = null;
    }
    if (record.value === inForce) continue;
    changes.push(record);
    inForce = record.value;
  }
  return changes;
}

const digest = (changes: readonly TagRecord[]): string =>
  hashCanonical({
    type: "AccountTagMap",
    tags: changes.map(
      (record): CanonicalValue => ({
        accountId: record.accountId,
        tag: record.tag,
        effectiveOn: record.effectiveOn,
        value: record.value,
      }),
    ),
  }).digest;

/** Content-based: the same tags in force on the same dates hash the same, whenever and in
 * whatever order they were recorded. An empty map hashes to the stub's original digest, so reports
 * compiled before any tag existed keep their population. */
export function hashTagRecords(records: readonly TagRecord[]): string {
  return digest(effective(records));
}

/** The tag map for a set of records. `revision` is the sequence of the newest record included. */
export function buildTagMap(records: readonly TagRecord[], revision: number): AccountTagMap {
  const changes = effective(records);
  const timelines = new Map<string, Map<TagKey, Entry[]>>();
  for (const record of changes) {
    const tags = timelines.get(record.accountId) ?? new Map<TagKey, Entry[]>();
    timelines.set(record.accountId, tags);
    const entries = tags.get(record.tag) ?? [];
    tags.set(record.tag, entries);
    entries.push({ effectiveOn: record.effectiveOn, seq: record.seq, value: record.value });
  }
  return {
    hash: digest(changes),
    revision,
    tagsFor(accountId, asOf) {
      const tags = timelines.get(accountId);
      const result: { -readonly [K in keyof AccountTags]: AccountTags[K] } = {};
      if (!tags) return result;
      for (const [tag, entries] of tags) {
        let value: string | null | undefined;
        for (const entry of entries) {
          if (entry.effectiveOn > asOf) break;
          value = entry.value;
        }
        if (typeof value === "string") (result as Record<string, string>)[tag] = value;
      }
      return result;
    },
  };
}

const ROLE_NAME: Readonly<Record<string, string>> = {
  asset: "an asset",
  liability: "a liability",
  equity: "an equity",
  income: "an income",
  expense: "an expense",
  gain: "a gain",
  unrealizedGain: "an unrealized gain",
};
const roleName = (role: string) => ROLE_NAME[role] ?? `a ${role}`;

export interface TagProblem {
  /** `unknown_tax_line` when the text is shaped like a line but no verified form has it. */
  readonly code: "invalid_tag" | "unknown_tax_line";
  readonly message: string;
}
const invalid = (message: string): TagProblem => ({ code: "invalid_tag", message });

/** Why a value cannot be a tag on an account with this role, or null when it can. The messages
 * are written for a person: they say what is wrong and what to use instead. */
export function tagProblem(role: AccountRole, tag: TagKey, value: string): TagProblem | null {
  switch (tag) {
    case "cashFlowClass":
      if (!(CASH_FLOW_CLASSES as readonly string[]).includes(value))
        return invalid(`Cash-flow class must be one of ${CASH_FLOW_CLASSES.join(", ")}.`);
      if (!BALANCE_SHEET_ROLES.includes(role))
        return invalid(
          `Cash-flow classes apply to balance-sheet accounts (asset, liability or equity); this is ${roleName(role)} account, and net income already carries its changes.`,
        );
      if (value === "cash" && role !== "asset")
        return invalid(`Only an asset account can be cash; this is ${roleName(role)} account.`);
      return null;
    case "taxLine": {
      if (!TAX_LINE_PATTERN.test(value))
        return invalid(
          `A tax line looks like scheduleC.line8 (the form, then the printed line number), not "${value.slice(0, 40)}".`,
        );
      const found = knownTaxLine(value);
      if (!found)
        return {
          code: "unknown_tax_line",
          message: `${value.slice(0, 40)} is not a line Rastrata knows. List the valid lines with taxLines.list.`,
        };
      if (!lineAcceptsRole(value, role))
        return invalid(
          `${found.label} (line ${found.number}) takes ${found.roles.map(roleName).join(" or ")} accounts; this is ${roleName(role)} account.`,
        );
      return null;
    }
    case "kind":
      if (!(TAGGED_KINDS as readonly string[]).includes(value))
        return invalid("Kind must be bank or card.");
      if (value === "bank" && role !== "asset")
        return invalid(
          `Only an asset account can be a bank account; this is ${roleName(role)} account.`,
        );
      if (value === "card" && role !== "liability")
        return invalid(
          `Only a liability account can be a card; this is ${roleName(role)} account.`,
        );
      return null;
    case "roleKey": {
      if (value.length > ROLE_KEY_MAX || !ROLE_KEY_PATTERN.test(value))
        return invalid(
          `A role key is lower-case words joined by dots or hyphens, such as stripe.balance (at most ${ROLE_KEY_MAX} characters).`,
        );
      const needs = ROLE_KEY_ACCOUNT_ROLE[value];
      if (needs !== undefined && role !== needs)
        return invalid(
          `The role key ${value} marks ${roleName(needs)} account; this is ${roleName(role)} account.`,
        );
      return null;
    }
  }
}

/** Check the tags an account is created with, and that no role key is claimed twice. A failure
 * is an ApplicationError with code invalid_tag that names the account and the field. */
export function validateChartTags(
  accounts: readonly {
    readonly code: string;
    readonly role: AccountRole;
    readonly tags?: AccountTags | undefined;
  }[],
): void {
  const owners = new Map<string, string>();
  accounts.forEach((account, index) => {
    for (const tag of TAG_KEYS) {
      const value = account.tags?.[tag];
      if (value === undefined) continue;
      const path = `input.accounts[${index}].tags.${tag}`;
      const problem =
        typeof value === "string"
          ? tagProblem(account.role, tag, value)
          : invalid("Expected text.");
      if (problem)
        throw new ApplicationError(
          problem.code,
          `Account ${account.code}: ${problem.message}`,
          400,
          [{ path, message: problem.message }],
        );
      if (tag === "roleKey") {
        const owner = owners.get(value);
        if (owner !== undefined)
          throw new ApplicationError(
            "role_key_in_use",
            `Account ${account.code}: role key ${value} is already on account ${owner}. A role key names one account.`,
            409,
            [{ path, message: `Already on account ${owner}` }],
          );
        owners.set(value, account.code);
      }
    }
  });
}

/** Checks everything a source hands the pipeline before any of it is stored. Sources are parsers
 * of untrusted files and connectors to outside services, so nothing here is assumed: a field has
 * the right type, a date is a real date, an amount has exactly two places, a string is bounded,
 * identifiers are non-empty. A problem with the batch as a whole throws `invalid_batch`; a problem
 * with one line comes back as a reason beside that line. */
import { ApplicationError } from "../errors.ts";
import type {
  BalanceCheck,
  BankLine,
  EventLeg,
  IngestLine,
  LedgerEvent,
  RawRef,
} from "../ingest-types.ts";
import { formatMoney, isMoney, parseMoney } from "../money.ts";
import { hostileFlags } from "../statements/hostile.ts";
import { sha256Hex, stableStringify } from "./hash.ts";
import {
  hasControlCharacters,
  hasFormatCharacters,
  isCalendarDate,
  normalizeForKey,
  sanitizeText,
  truncate,
} from "./text.ts";

/** The kinds of hostile text the import preview warns about that the Inbox flags on the line too, in
 * the same words, so whoever reads the Inbox (a person, or an agent that must never follow what a
 * memo says) sees the warning on the line itself. Control and hidden characters have flags of their
 * own. The text is never changed, and no flag is a promise that unflagged text is harmless. */
const TEXT_FLAGS = ["formula", "instruction", "markup", "link"] as const;

function textFlags(texts: readonly string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) for (const flag of hostileFlags(text)) found.add(flag);
  return TEXT_FLAGS.filter((flag) => found.has(flag));
}

export const MAX_RAW_BYTES = 16 * 1024 * 1024;
export const MAX_LINES_PER_BATCH = 50_000;
export const MAX_BALANCES_PER_BATCH = 1_000;
export const LIMITS = {
  description: 4_000,
  counterparty: 1_000,
  reference: 500,
  providerId: 256,
  accountKey: 200,
  sourceKey: 200,
  excerpt: 4_096,
  cursor: 2_000,
  memo: 500,
  legs: 50,
  links: 20,
  linkKey: 64,
  linkValue: 256,
  role: 64,
  mediaType: 200,
  name: 300,
  evidence: 300,
} as const;
/** Bank statements before 1970 or after 2100 are a mis-parsed date, not history. */
const FIRST_DATE = "1970-01-01";
const LAST_DATE = "2100-12-31";
const PROVIDER = /^[a-z][a-z0-9_-]{0,31}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ROLE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const CURRENCY = /^[A-Z]{3}$/;
/** A whole part of at most 15 digits keeps every amount inside a signed 64-bit count of cents. */
const MONEY_DIGITS = /^-?[0-9]{1,15}\.[0-9]{2}$/;

export interface PreparedLine {
  /** The line as the pipeline keeps it: known fields only, strings bounded, text verbatim. */
  readonly line: IngestLine;
  readonly kind: "bankLine" | "event";
  readonly accountKey: string;
  readonly providerId: string | null;
  readonly rawIndex: number;
  readonly date: string;
  /** Signed, two places: the line's amount, or an event's display amount. */
  readonly amount: string;
  readonly cents: bigint;
  readonly currency: string;
  /** The description of a bank line, the summary of an event. */
  readonly text: string;
  /** Hash of the normalised text, the tie-break when overlap detection has to choose. */
  readonly textKey: string;
  readonly search: string;
  /** Hash of the financial content (date, amount, currency, legs). A provider id seen again with
   * a different content key is a conflict, never an overwrite. */
  readonly contentKey: string;
  readonly excerpt: string | null;
  readonly flags: readonly string[];
  /** The provider id of the event that books this line, or null. */
  readonly coveredBy: string | null;
  /** A connector-chosen ledger source identity, or null for the derived one. */
  readonly sourceId: string | null;
}

export type LineCheck =
  | { readonly ok: true; readonly line: PreparedLine }
  | { readonly ok: false; readonly rawIndex: number | null; readonly reason: string };

export interface BatchHeader {
  readonly provider: string;
  readonly sourceKey: string;
  readonly raw: RawRef;
  readonly fetchedAt: string;
  readonly cursor: string | null;
  readonly ledgerAccountId: string | null;
  readonly startOn: string | null;
  readonly catchUp: boolean;
  readonly balances: readonly BalanceCheck[];
}

export interface PreparedBatch {
  readonly header: BatchHeader;
  readonly lines: readonly LineCheck[];
}

const refuse = (message: string, details: readonly string[] = []): never => {
  throw new ApplicationError(
    "invalid_batch",
    message,
    400,
    details.slice(0, 20).map((detail) => ({ path: "batch", message: detail })),
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const boundedText = (value: unknown, min: number, max: number): value is string =>
  typeof value === "string" && value.length >= min && value.length <= max;

const plainKey = (value: unknown, max: number): value is string =>
  boundedText(value, 1, max) && value.trim() === value && !hasControlCharacters(value);

/** A date inside the range a statement can honestly carry. */
export const isPlausibleDate = (value: unknown): value is string =>
  isCalendarDate(value) && value >= FIRST_DATE && value <= LAST_DATE;

/** Check and normalise a batch's header. Throws `invalid_batch` when the batch as a whole cannot
 * be used. Lines are checked separately by `prepareLines`. */
export function prepareHeader(input: unknown): BatchHeader & { readonly rawLines: unknown } {
  if (!isRecord(input)) return refuse("The batch is not an object");
  const problems: string[] = [];
  const { provider, sourceKey, raw, fetchedAt, cursor, ledgerAccountId, startOn, catchUp } = input;
  if (typeof provider !== "string" || !PROVIDER.test(provider))
    problems.push("provider must be lower-case words, digits, dashes and underscores");
  if (!plainKey(sourceKey, LIMITS.sourceKey)) problems.push("sourceKey must be a plain string");
  if (
    !isRecord(raw) ||
    typeof raw.sha256 !== "string" ||
    !SHA256.test(raw.sha256) ||
    !Number.isSafeInteger(raw.size) ||
    (raw.size as number) < 0 ||
    (raw.size as number) > MAX_RAW_BYTES ||
    !boundedText(raw.mediaType, 1, LIMITS.mediaType) ||
    (raw.name !== undefined && !boundedText(raw.name, 0, LIMITS.name))
  )
    problems.push("raw must reference an archived payload (sha256, size, mediaType)");
  if (
    typeof fetchedAt !== "string" ||
    fetchedAt.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T/.test(fetchedAt) ||
    !Number.isFinite(Date.parse(fetchedAt))
  )
    problems.push("fetchedAt must be an ISO instant");
  if (cursor !== undefined && !boundedText(cursor, 0, LIMITS.cursor))
    problems.push("cursor must be a string of at most 2000 characters");
  if (
    ledgerAccountId !== undefined &&
    !(typeof ledgerAccountId === "string" && ID.test(ledgerAccountId))
  )
    problems.push("ledgerAccountId must be a chart account id");
  if (startOn !== undefined && !isPlausibleDate(startOn))
    problems.push("startOn must be a calendar date, YYYY-MM-DD");
  if (catchUp !== undefined && typeof catchUp !== "boolean")
    problems.push("catchUp must be true or false");
  if (!Array.isArray(input.lines)) problems.push("lines must be an array");
  else if (input.lines.length > MAX_LINES_PER_BATCH)
    problems.push(`a batch holds at most ${MAX_LINES_PER_BATCH} lines; split it`);
  const balances: BalanceCheck[] = [];
  if (!Array.isArray(input.balances)) problems.push("balances must be an array");
  else if (input.balances.length > MAX_BALANCES_PER_BATCH)
    problems.push(`a batch holds at most ${MAX_BALANCES_PER_BATCH} balances`);
  else
    for (const [index, balance] of input.balances.entries()) {
      if (
        !isRecord(balance) ||
        !plainKey(balance.accountKey, LIMITS.accountKey) ||
        !isPlausibleDate(balance.asOf) ||
        typeof balance.balance !== "string" ||
        !isMoney(balance.balance) ||
        !MONEY_DIGITS.test(balance.balance)
      )
        problems.push(`balances[${index}] needs accountKey, asOf and a two-place balance`);
      else
        balances.push({
          accountKey: balance.accountKey as string,
          asOf: balance.asOf as string,
          balance: formatMoney(parseMoney(balance.balance as string)),
        });
    }
  if (problems.length > 0) return refuse("The batch is not valid", problems);
  const header: BatchHeader = {
    provider: provider as string,
    sourceKey: sourceKey as string,
    raw: {
      sha256: (raw as Record<string, unknown>).sha256 as string,
      size: (raw as Record<string, unknown>).size as number,
      mediaType: (raw as Record<string, unknown>).mediaType as string,
      ...(typeof (raw as Record<string, unknown>).name === "string"
        ? { name: (raw as Record<string, unknown>).name as string }
        : {}),
    },
    fetchedAt: fetchedAt as string,
    cursor: typeof cursor === "string" ? cursor : null,
    ledgerAccountId: typeof ledgerAccountId === "string" ? ledgerAccountId : null,
    startOn: typeof startOn === "string" ? startOn : null,
    catchUp: catchUp === true,
    balances,
  };
  return { ...header, rawLines: input.lines };
}

const reasonFor = (rawIndex: number | null, reason: string): LineCheck => ({
  ok: false,
  rawIndex,
  reason,
});

function legsOf(value: unknown): EventLeg[] | string {
  if (!Array.isArray(value) || value.length < 2 || value.length > LIMITS.legs)
    return `an event needs 2 to ${LIMITS.legs} legs`;
  const legs: EventLeg[] = [];
  let total = 0n;
  for (const [index, leg] of value.entries()) {
    if (
      !isRecord(leg) ||
      typeof leg.role !== "string" ||
      !ROLE.test(leg.role) ||
      typeof leg.amount !== "string" ||
      !isMoney(leg.amount) ||
      !MONEY_DIGITS.test(leg.amount) ||
      (leg.memo !== undefined && !boundedText(leg.memo, 0, LIMITS.memo))
    )
      return `leg ${index + 1} needs a role and a two-place amount`;
    const cents = parseMoney(leg.amount);
    total += cents;
    legs.push({
      role: leg.role,
      amount: formatMoney(cents),
      ...(typeof leg.memo === "string" ? { memo: truncate(leg.memo, LIMITS.memo) } : {}),
    });
  }
  return total === 0n ? legs : "the legs of an event must add up to exactly 0.00";
}

function linksOf(value: unknown): Record<string, string> | string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return "links must be an object";
  const entries = Object.entries(value);
  if (entries.length > LIMITS.links) return `at most ${LIMITS.links} links`;
  const links: Record<string, string> = {};
  for (const [key, link] of entries) {
    if (!plainKey(key, LIMITS.linkKey) || !plainKey(link, LIMITS.linkValue))
      return "links are short plain strings";
    links[key] = link;
  }
  return links;
}

/** Check one line. `provider` is the batch's provider; every line must carry the same one. */
export function prepareLine(input: unknown, provider: string): LineCheck {
  if (!isRecord(input)) return reasonFor(null, "The line is not an object");
  const rawIndex = Number.isSafeInteger(input.rawIndex) ? (input.rawIndex as number) : null;
  const bad = (reason: string) => reasonFor(rawIndex, reason);
  if (rawIndex === null || rawIndex < 0) return bad("rawIndex must be a whole number, 0 or more");
  if (input.kind !== "bankLine" && input.kind !== "event")
    return bad("kind must be bankLine or event");
  if (input.provider !== provider) return bad("The line's provider differs from the batch's");
  if (!plainKey(input.accountKey, LIMITS.accountKey))
    return bad("accountKey must be a plain string of at most 200 characters");
  const providerId = input.providerId;
  if (providerId !== undefined && !plainKey(providerId, LIMITS.providerId))
    return bad("providerId must be a non-empty plain string, or absent");
  const currency = input.currency;
  if (typeof currency !== "string" || !CURRENCY.test(currency))
    return bad("currency must be a three-letter code in capitals");
  const flags: string[] = [];
  const excerpt =
    typeof input.excerpt === "string" && input.excerpt.length > 0
      ? truncate(input.excerpt, LIMITS.excerpt)
      : null;
  const accountKey = input.accountKey as string;
  const id = typeof providerId === "string" ? providerId : null;

  if (input.kind === "event") {
    if (id === null) return bad("an event needs a providerId");
    if (!isPlausibleDate(input.eventOn)) return bad("eventOn must be a real date, YYYY-MM-DD");
    if (typeof input.summary !== "string" || input.summary.trim() === "")
      return bad("an event needs a summary");
    const legs = legsOf(input.legs);
    if (typeof legs === "string") return bad(legs);
    const links = linksOf(input.links);
    if (typeof links === "string") return bad(links);
    if (input.coveredBy !== undefined && !plainKey(input.coveredBy, LIMITS.providerId))
      return bad("coveredBy must be the provider id of the event that books this one");
    if (input.coveredBy === id) return bad("an event cannot be covered by itself");
    const coveredBy = typeof input.coveredBy === "string" ? input.coveredBy : null;
    if (input.evidence !== undefined && !boundedText(input.evidence, 0, LIMITS.evidence))
      return bad("evidence must be text of at most 300 characters");
    if (
      input.sourceId !== undefined &&
      !(
        typeof input.sourceId === "string" &&
        ID.test(input.sourceId) &&
        !input.sourceId.startsWith("ingest-")
      )
    )
      return bad("sourceId must be a ledger source id that does not start with ingest-");
    const evidence =
      typeof input.evidence === "string" ? sanitizeText(input.evidence, LIMITS.evidence) : "";
    const sourceId = typeof input.sourceId === "string" ? input.sourceId : null;
    let display: string;
    if (input.amount !== undefined) {
      if (
        typeof input.amount !== "string" ||
        !isMoney(input.amount) ||
        !MONEY_DIGITS.test(input.amount)
      )
        return bad("amount must be a two-place decimal");
      display = formatMoney(parseMoney(input.amount));
    } else {
      display = formatMoney(
        legs.reduce(
          (total, leg) => total + (parseMoney(leg.amount) > 0n ? parseMoney(leg.amount) : 0n),
          0n,
        ),
      );
    }
    const summary = truncate(input.summary, LIMITS.description);
    if (summary.length < input.summary.length) flags.push("long_text");
    if (hasControlCharacters(summary)) flags.push("control_characters");
    if (hasFormatCharacters(summary)) flags.push("format_characters");
    flags.push(...textFlags([summary]));
    const line: LedgerEvent = {
      kind: "event",
      provider,
      accountKey,
      providerId: id,
      rawIndex,
      ...(excerpt !== null ? { excerpt } : {}),
      eventOn: input.eventOn,
      summary,
      currency,
      ...(input.amount !== undefined ? { amount: display } : {}),
      legs,
      ...(links !== undefined ? { links } : {}),
      ...(coveredBy !== null ? { coveredBy } : {}),
      ...(evidence !== "" ? { evidence } : {}),
      ...(sourceId !== null ? { sourceId } : {}),
    };
    return {
      ok: true,
      line: {
        line,
        kind: "event",
        accountKey,
        providerId: id,
        rawIndex,
        date: input.eventOn,
        amount: display,
        cents: parseMoney(display),
        currency,
        text: summary,
        textKey: sha256Hex(normalizeForKey(summary)).slice(0, 16),
        search: searchText([summary, ...legs.map((leg) => leg.memo ?? ""), display, id]),
        contentKey: sha256Hex(
          stableStringify([input.eventOn, currency, legs.map((leg) => [leg.role, leg.amount])]),
        ),
        excerpt,
        flags,
        coveredBy,
        sourceId,
      },
    };
  }

  if (input.coveredBy !== undefined) return bad("only an event can be covered by another event");
  if (input.evidence !== undefined || input.sourceId !== undefined)
    return bad("only an event can carry evidence or a source id");
  if (!isPlausibleDate(input.postedOn)) return bad("postedOn must be a real date, YYYY-MM-DD");
  if (
    typeof input.amount !== "string" ||
    !isMoney(input.amount) ||
    !MONEY_DIGITS.test(input.amount)
  )
    return bad("amount must be a decimal with exactly two places, such as -12.34");
  if (typeof input.description !== "string") return bad("description must be text");
  for (const name of ["counterparty", "reference"] as const)
    if (input[name] !== undefined && typeof input[name] !== "string")
      return bad(`${name} must be text`);
  if (
    input.runningBalance !== undefined &&
    (typeof input.runningBalance !== "string" ||
      !isMoney(input.runningBalance) ||
      !MONEY_DIGITS.test(input.runningBalance))
  )
    return bad("runningBalance must be a decimal with exactly two places");
  const cents = parseMoney(input.amount);
  const description = truncate(input.description, LIMITS.description);
  const counterparty =
    typeof input.counterparty === "string"
      ? truncate(input.counterparty, LIMITS.counterparty)
      : undefined;
  const reference =
    typeof input.reference === "string" ? truncate(input.reference, LIMITS.reference) : undefined;
  if (
    description.length < input.description.length ||
    (counterparty !== undefined && counterparty.length < (input.counterparty as string).length) ||
    (reference !== undefined && reference.length < (input.reference as string).length)
  )
    flags.push("long_text");
  const texts = [description, counterparty ?? "", reference ?? "", id ?? ""];
  if (texts.some(hasControlCharacters)) flags.push("control_characters");
  if (texts.some(hasFormatCharacters)) flags.push("format_characters");
  if (cents === 0n) flags.push("zero_amount");
  flags.push(...textFlags([description, counterparty ?? "", reference ?? ""]));
  const line: BankLine = {
    kind: "bankLine",
    provider,
    accountKey,
    ...(id !== null ? { providerId: id } : {}),
    rawIndex,
    ...(excerpt !== null ? { excerpt } : {}),
    postedOn: input.postedOn,
    amount: formatMoney(cents),
    currency,
    description,
    ...(counterparty !== undefined ? { counterparty } : {}),
    ...(reference !== undefined ? { reference } : {}),
    ...(typeof input.runningBalance === "string"
      ? { runningBalance: formatMoney(parseMoney(input.runningBalance)) }
      : {}),
  };
  return {
    ok: true,
    line: {
      line,
      kind: "bankLine",
      accountKey,
      providerId: id,
      rawIndex,
      date: input.postedOn,
      amount: line.amount,
      cents,
      currency,
      text: description,
      textKey: sha256Hex(normalizeForKey(description)).slice(0, 16),
      search: searchText([description, counterparty ?? "", reference ?? "", line.amount, id ?? ""]),
      contentKey: sha256Hex(stableStringify([input.postedOn, line.amount, currency])),
      excerpt,
      flags,
      coveredBy: null,
      sourceId: null,
    },
  };
}

function searchText(parts: readonly string[]): string {
  return sanitizeText(parts.join(" ").normalize("NFKC"), 2_000).toLowerCase();
}

/** Check every line of a batch. A repeated rawIndex is refused for the whole batch: provenance
 * names a line by its position, and two lines cannot share one. */
export function prepareLines(rawLines: unknown, provider: string): LineCheck[] {
  if (!Array.isArray(rawLines)) return refuse("lines must be an array");
  const checks = rawLines.map((line) => prepareLine(line, provider));
  const seen = new Set<number>();
  for (const check of checks)
    if (check.ok) {
      if (seen.has(check.line.rawIndex))
        return refuse("Two lines share one rawIndex", [`rawIndex ${check.line.rawIndex} repeats`]);
      seen.add(check.line.rawIndex);
    }
  return checks;
}

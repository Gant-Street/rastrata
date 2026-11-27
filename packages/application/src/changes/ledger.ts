/** What the ledger says changed. Every committed revision of the book is a change: the revision's
 * command says what was done and its effects say to what. Who asked for it is not in the ledger (it
 * records one service-level actor on every command), so it comes from the table that `commitAction`
 * writes beside each command; a revision with no such row says "not recorded".
 *
 * Reading works on the state the service has already verified, and takes the revisions it needs from
 * it. A revision is immutable, so the revisions of a state at the head up to revision N are exactly the
 * revisions of the state at N: a list pinned to an earlier revision needs no replay of the book.
 *
 * Pure and portable. Text that came from outside (a narration, an account name, a reason) is plain
 * and short in every sentence built here. */
import type {
  AccountSnapshot,
  BookedJournal,
  BookEffect,
  BookState,
  FiscalPeriod,
  RevisionRecord,
} from "@rastrata/kernel";

import type { ChangeRecord } from "../client-contracts.gen.ts";
import { sanitizeText } from "../ingest/text.ts";
import { formatMoney } from "../money.ts";
import { monthOfPeriods } from "../calendar/year-start.ts";
import { bookView } from "../reports/ledger.ts";
import { type Position, positionOf, revisionsAfter } from "../reports/ledger-history.ts";
import { actorOf } from "./actors.ts";
import type { Candidate } from "./candidate.ts";
import { type ActorRef, type ChangeKind, UNKNOWN_ACTOR, actorKey } from "./kinds.ts";

/** What `commitAction` kept about one command. */
export interface CommitFacts {
  readonly principal: string;
  readonly label: string;
  readonly operation: string;
  readonly at: string;
}

/** One change the ledger holds, found cheaply; `build` makes the whole record when it is needed. A
 * revision is nearly always one change. A command that replaces the chart can change several accounts
 * at once, and then each is its own change, numbered by `part`. */
export interface LedgerCandidate extends Candidate {
  readonly revision: bigint;
  readonly part: number;
  /** The operation that committed it, or null when the book did not record it. */
  readonly operation: string | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-03-20` as "Mar 20, 2026". Calendar text only; no time zone is involved. */
export function shortDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return sanitizeText(date, 20);
  return `${MONTHS[Number(match[2]) - 1] ?? match[2]} ${Number(match[3])}, ${match[1]}`;
}

/** A wire amount as a sentence says it: digits in groups of three, "12,000.00". Text that is not an amount
 * is returned as it is. The figure on its own, in a field of its own, stays the wire amount. */
export function groupedAmount(amount: string): string {
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(amount);
  if (!match) return amount;
  const digits = (match[2] as string).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${match[1]}${digits}${match[3] ?? ""}`;
}

/** An instant the kernel wrote, as an ISO string in UTC with milliseconds, which is also the form the
 * service stamps its own records in, so the two can be compared as text. */
export function isoInstant(value: string): string {
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : new Date(time).toISOString();
}

const text = (value: string, max: number): string => sanitizeText(value, max);

/** How a command was committed, in words. */
export function howCommitted(operation: string | null): string {
  if (operation === null) return "How it was committed was not recorded";
  switch (operation) {
    case "operations.commit":
      return "Committed a prepared plan";
    case "journal.post":
      return "Entered by hand and posted";
    case "inbox.post":
      return "Posted after review";
    case "inbox.undo":
      return "Sent back for review";
    case "inbox.recategorize":
      return "Moved to another account";
    case "periods.commitYearEnd":
      return "Closed as part of a year-end";
    case "book.setup":
      return "Set up the book";
    default:
      return operation.startsWith("legacy.")
        ? "Committed from an older screen"
        : `Committed with ${text(operation, 60)}`;
  }
}

const sum = (booked: BookedJournal): bigint => {
  let debits = 0n;
  for (const posting of booked.journal.postings) {
    const cents = posting.bookValue.amount.coefficient;
    if (cents > 0n) debits += cents;
  }
  return debits;
};

export interface Context {
  readonly state: BookState;
  readonly accounts: ReadonlyMap<string, AccountSnapshot>;
  /** Journals by id, built when a reversal first needs the entry it reversed and nobody gave a way to find it. */
  journals: Map<string, BookedJournal> | undefined;
  periods: Map<string, FiscalPeriod> | undefined;
  /** How to find an entry by its identifier, when the caller has a way that does not read every entry. */
  readonly journalOf?: (id: string) => BookedJournal | undefined;
}

function journalById(context: Context, id: string): BookedJournal | undefined {
  if (context.journalOf) return context.journalOf(id);
  if (!context.journals) {
    context.journals = new Map();
    for (const booked of bookView(context.state).journalsByDate())
      context.journals.set(booked.journal.id as string, booked);
  }
  return context.journals.get(id);
}

const MONTH_NAMES =
  /^(january|february|march|april|may|june|july|august|september|october|november|december)$/i;

/** A period as a person names it: a month with its year ("March 2026"), a label that already says its
 * year as it is, and any other (a quarter, an adjustment period) with the fiscal year it belongs to. */
function periodLabel(context: Context, id: string): string {
  if (!context.periods)
    context.periods = new Map(context.state.periods.map((period) => [period.id as string, period]));
  const period = context.periods.get(id);
  if (period === undefined) return text(id, 80);
  const label = text(period.label, 80);
  if (/\b\d{4}\b/.test(label)) return label;
  if (MONTH_NAMES.test(label)) return `${label} ${(period.startsOn as string).slice(0, 4)}`;
  return `${label} of fiscal ${period.fiscalYear}`;
}

/** How many periods other than `periodId` have a close that these close identifiers name. */
function otherPeriodsClosed(
  context: Context,
  closeIds: readonly string[],
  periodId: string,
): number {
  const periodOf = new Map(
    context.state.closePackages.map((close) => [close.id as string, close.periodId as string]),
  );
  const others = new Set<string>();
  for (const closeId of closeIds) {
    const other = periodOf.get(closeId);
    if (other !== undefined && other !== periodId) others.add(other);
  }
  return others.size;
}

function entryOf(context: Context, booked: BookedJournal): NonNullable<ChangeRecord["entry"]> {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const posting of booked.journal.postings) {
    const id = posting.accountId as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const account = context.accounts.get(id);
    if (names.length < 8) names.push(account ? text(`${account.code} ${account.name}`, 160) : id);
  }
  return {
    journalId: booked.journal.id as string,
    number: Number(booked.postingSequence),
    date: booked.journal.accountingDate as string,
    description: text(booked.journal.narration, 240),
    amount: formatMoney(sum(booked)),
    accounts: names,
    accountCount: seen.size,
  };
}

const effectsOf = <T extends BookEffect["type"]>(
  revision: RevisionRecord,
  type: T,
): Extract<BookEffect, { type: T }>[] =>
  revision.effects.filter(
    (effect): effect is Extract<BookEffect, { type: T }> => effect.type === type,
  );

/** The changes one configuration replacement makes, found by comparing the chart and the calendar
 * before and after. */
interface ConfigPart {
  readonly kind: ChangeKind;
  readonly subject: { kind: "account" | "calendar" | "book"; id: string };
  readonly sentence: (context: Context) => string;
}

function configParts(revision: RevisionRecord): ConfigPart[] {
  const effect = effectsOf(revision, "configuration")[0];
  if (!effect) return [];
  const before = new Map(
    effect.previousConfigurationSnapshot.admissionSnapshot.accounts.map((account) => [
      account.id as string,
      account,
    ]),
  );
  const after = [...effect.resultingConfigurationSnapshot.admissionSnapshot.accounts].sort(
    (left, right) => (left.code < right.code ? -1 : left.code > right.code ? 1 : 0),
  );
  const parts: ConfigPart[] = [];
  for (const account of after) {
    const was = before.get(account.id as string);
    const subject = { kind: "account" as const, id: account.id as string };
    const name = text(account.name, 120);
    const code = text(account.code, 20);
    if (!was) {
      parts.push({
        kind: "account.added",
        subject,
        sentence: () => `Added the ${account.role} account ${code} ${name}.`,
      });
    } else if (!was.closedOn && account.closedOn) {
      parts.push({
        kind: "account.closed",
        subject,
        sentence: () =>
          `Closed account ${code} ${name}, so nothing more can be posted to it from ${account.closedOn}.`,
      });
    } else if (
      was.name !== account.name ||
      was.code !== account.code ||
      was.role !== account.role ||
      was.parentId !== account.parentId ||
      was.postingAllowed !== account.postingAllowed
    ) {
      parts.push({
        kind: "account.changed",
        subject,
        sentence: () =>
          was.name !== account.name
            ? `Renamed account ${code} from "${text(was.name, 120)}" to "${name}".`
            : `Changed account ${code} ${name}.`,
      });
    }
  }
  const known = new Set(effect.previousConfigurationSnapshot.periods.map((p) => p.id as string));
  const added = effect.resultingConfigurationSnapshot.periods.filter(
    (period) => !known.has(period.id as string),
  );
  // A calendar drawn again under another fiscal-year month says so; one that is only extended keeps
  // every period it had.
  const wasMonth = monthOfPeriods(effect.previousConfigurationSnapshot.periods, 1);
  const month = monthOfPeriods(effect.resultingConfigurationSnapshot.periods, 1);
  if (wasMonth !== month) {
    const name = new Date(Date.UTC(2000, month - 1, 1)).toLocaleString("en-US", {
      month: "long",
      timeZone: "UTC",
    });
    parts.push({
      kind: "book.changed",
      subject: { kind: "calendar", id: "calendar" },
      sentence: () => `Changed the fiscal year to start in ${name}.`,
    });
  } else if (added.length > 0) {
    const through = added.reduce(
      (latest, period) => (period.endsOn > latest ? period.endsOn : latest),
      "",
    );
    const years = [...new Set(added.map((period) => Number(period.fiscalYear)))].sort();
    parts.push({
      kind: "calendar.extended",
      subject: { kind: "calendar", id: String(years.at(-1) ?? "") },
      sentence: () =>
        `Extended the calendar through ${shortDate(through)} (fiscal ${years.length === 1 ? "year" : "years"} ${years.join(", ")}).`,
    });
  }
  if (parts.length === 0)
    parts.push({
      kind: "book.changed",
      subject: { kind: "book", id: "book" },
      sentence: () => "The book's settings changed.",
    });
  return parts;
}

/** One change a revision makes, found from the revision alone: what kind it is, what it is about, and the
 * words that say it. The words are made when the change is shown and read the book as it is then, so that an
 * account renamed since is named as it is now. */
export interface LedgerPart {
  readonly part: number;
  readonly kind: ChangeKind;
  readonly subject: ChangeRecord["subject"];
  readonly sentence: (context: Context) => string;
  readonly entry?: (context: Context) => NonNullable<ChangeRecord["entry"]>;
}

/** The changes one revision makes, in the order they are found: nearly always one. */
export function partsOf(revision: RevisionRecord): LedgerPart[] {
  const parts: LedgerPart[] = [];
  const make = (
    part: number,
    kind: ChangeKind,
    subject: ChangeRecord["subject"],
    sentence: (context: Context) => string,
    entry?: (context: Context) => NonNullable<ChangeRecord["entry"]>,
  ) => parts.push({ part, kind, subject, sentence, ...(entry ? { entry } : {}) });
  switch (revision.command.type) {
    case "activateBook": {
      const activation = effectsOf(revision, "activation")[0];
      const accounts = activation?.configurationSnapshot.admissionSnapshot.accounts.length;
      make(0, "book.opened", { kind: "book", id: "book" }, () =>
        accounts === undefined
          ? "Opened the books."
          : `Opened the books with ${accounts} accounts.`,
      );
      break;
    }
    case "postJournal": {
      const booked = effectsOf(revision, "journal")[0]?.booked;
      if (!booked) {
        make(0, "book.changed", { kind: "book", id: "book" }, () => "An entry was posted.");
        break;
      }
      const id = booked.journal.id as string;
      make(
        0,
        "entry.posted",
        { kind: "journal", id },
        (context) => {
          const entry = entryOf(context, booked);
          // What the books know comes first, and the words that came from outside come last, so that
          // nothing in them can run into a number.
          return `Posted No. ${entry.number} on ${shortDate(entry.date)} for ${groupedAmount(entry.amount)}: ${entry.description}`;
        },
        (context) => entryOf(context, booked),
      );
      break;
    }
    case "correctJournal": {
      const link = effectsOf(revision, "correction")[0]?.link;
      const reversing = effectsOf(revision, "journal")[0]?.booked;
      if (link?.kind !== "reversal" || !reversing) {
        make(0, "book.changed", { kind: "book", id: "book" }, () => "An entry was corrected.");
        break;
      }
      make(
        0,
        "entry.reversed",
        { kind: "journal", id: link.originalJournalId },
        (context) => {
          const original = journalById(context, link.originalJournalId);
          const done = entryOf(context, reversing);
          if (!original) return `Reversed an entry with No. ${done.number}.`;
          const was = entryOf(context, original);
          return `Reversed No. ${was.number} on ${shortDate(was.date)} for ${groupedAmount(was.amount)}, with No. ${done.number}: ${was.description}`;
        },
        (context) => entryOf(context, reversing),
      );
      break;
    }
    case "closePeriod":
    case "reopenPeriod": {
      const transition = effectsOf(revision, "periodTransition")[0]?.transition;
      const closing = revision.command.type === "closePeriod";
      if (!transition) {
        make(0, "book.changed", { kind: "book", id: "book" }, () => "A period was changed.");
        break;
      }
      make(
        0,
        closing ? "period.closed" : "period.reopened",
        { kind: "period", id: transition.periodId as string },
        (context) => {
          const label = periodLabel(context, transition.periodId as string);
          const reason = text(transition.reason, 120);
          const because = reason === "" ? "" : ` (reason: ${reason})`;
          const later = otherPeriodsClosed(
            context,
            transition.supersededCloseIds as readonly string[],
            transition.periodId as string,
          );
          const also =
            !closing && later > 0
              ? ` The close of ${later} later ${later === 1 ? "period" : "periods"} no longer holds.`
              : "";
          return `${closing ? "Closed" : "Reopened"} ${label}${because}.${also}`;
        },
      );
      break;
    }
    case "replaceConfiguration": {
      for (const [number, part] of configParts(revision).entries())
        make(number, part.kind, part.subject, (context) => part.sentence(context));
      break;
    }
    default:
      make(
        0,
        "book.changed",
        { kind: "book", id: "book" },
        () => `The book changed (${text(revision.command.type, 60)}).`,
      );
  }
  return parts;
}

/** One change of the ledger, held with what is known of it without making its words: the revision and its
 * place among the revision's changes, its kind, when it was made, who made it and how. */
export interface LedgerItem {
  readonly revision: bigint;
  readonly spec: LedgerPart;
  readonly at: string;
  readonly actor: ActorRef;
  readonly actorKey: string;
  readonly operation: string | null;
}

/** The change as a candidate, whose whole record is made only if it is shown. */
function candidateOf(item: LedgerItem, context: Context): LedgerCandidate {
  const { revision, spec, at, actor, operation } = item;
  return {
    revision,
    part: spec.part,
    order: String(spec.part),
    kind: spec.kind,
    at,
    actor,
    operation,
    build: () => ({
      id: spec.part === 0 ? `ledger:${revision}` : `ledger:${revision}:${spec.part}`,
      at,
      revision: revision.toString(),
      kind: spec.kind,
      summary: text(spec.sentence(context), 400),
      subject: spec.subject,
      by: { kind: actor.kind, label: actor.label, ...(actor.id ? { id: actor.id } : {}) },
      how: howCommitted(operation),
      ...(spec.entry ? { entry: spec.entry(context) } : {}),
    }),
  };
}

/** Who asked for each command, by the command's identifier, as `ChangesState` keeps it: the rows in the order
 * they were written, so that what was written after a look can be told from what was there. */
export interface CommitIndex {
  readonly map: ReadonlyMap<string, CommitFacts>;
  readonly ids: readonly string[];
  /** How many times what is held was thrown away and read again from the first row. */
  readonly generation: number;
}

/** Every change the book's revisions hold, in the order the book made them (a revision's changes in the order
 * they were found), kept current from the ledger's own new revisions instead of being made again from every
 * revision each time the list is read.
 *
 * What is held for each change is what is known without making its words: its kind, its time, its maker and
 * the operation that committed it. From those, the number of changes in a window of revisions is a
 * subtraction, the changes by each maker are counted by search, and the newest few are made into candidates
 * when a page needs them; the words are made then, from the book as it is. The time of a revision, the
 * revisions that closed a period and the first revision whose maker the book recorded are held too, so that
 * finding the window the list starts and ends in does not read the revisions either.
 *
 * One is kept for each book and moved on in place, as `slices/ingest/match-index.ts` does: asked for the state
 * that follows the one it stands at (the next revisions of the same hash chain) it takes in what they added,
 * and asked for anything else, or after a command that was already in the book was recorded as asked for by
 * someone, it is made from the state. It is held to the whole read by `test/changes/kept-current.test.ts`. */
export class LedgerChanges {
  readonly #items: LedgerItem[] = [];
  /** The first change of revision k + 1, for each k; the end of the changes follows the last. */
  readonly #first: number[] = [];
  readonly #ats: string[] = [];
  readonly #closes: bigint[] = [];
  readonly #byCommand = new Map<string, number>();
  readonly #actors = new Map<string, { actor: ActorRef; at: number[] }>();
  readonly #refs = new Map<string, ActorRef>();
  #recorded: number | null = null;
  #ordered = true;
  #position: Position;
  #from: CommitIndex | null = null;
  #generation = 0;
  #seen = 0;

  constructor(position: Position) {
    this.#position = position;
  }

  get position(): Position {
    return this.#position;
  }

  /** How many revisions the book has. */
  get revisions(): number {
    return this.#first.length;
  }

  /** How many changes it holds. */
  get length(): number {
    return this.#items.length;
  }

  #actorFor(commit: CommitFacts | undefined): ActorRef {
    if (commit === undefined) return UNKNOWN_ACTOR;
    const key = `${commit.principal}\u0000${commit.label}`;
    let actor = this.#refs.get(key);
    if (actor === undefined) {
      actor = actorOf(commit.principal, commit.label);
      this.#refs.set(key, actor);
    }
    return actor;
  }

  /** Take in the next revision of the book. */
  append(revision: RevisionRecord, commit: CommitFacts | undefined): void {
    const index = this.#first.length;
    this.#first.push(this.#items.length);
    const actor = this.#actorFor(commit);
    const at = commit ? commit.at : isoInstant(revision.committedAt as string);
    const operation = commit?.operation ?? null;
    const previous = this.#ats[index - 1];
    if (previous !== undefined && at < previous) this.#ordered = false;
    this.#ats.push(at);
    this.#byCommand.set(revision.command.id as string, index);
    if (commit !== undefined && this.#recorded === null) this.#recorded = index;
    if (revision.command.type === "closePeriod") this.#closes.push(revision.bookRevision);
    const key = actorKey(actor);
    for (const spec of partsOf(revision)) {
      const position = this.#items.length;
      this.#items.push({
        revision: revision.bookRevision,
        spec,
        at,
        actor,
        actorKey: key,
        operation,
      });
      const known = this.#actors.get(key);
      if (known) known.at.push(position);
      else this.#actors.set(key, { actor, at: [position] });
    }
  }

  /** Move on to `state`, whose commits are these. False when it cannot be done from what is held: the state
   * is not the next revisions of the chain held, or a command already in the book has since been recorded as
   * asked for by someone, or the commits are another service's: the caller then makes it from the state. */
  advance(state: BookState, commits: CommitIndex): boolean {
    if (this.#from !== commits || this.#generation !== commits.generation) return false;
    if (this.#seen > commits.ids.length) return false;
    for (let at = this.#seen; at < commits.ids.length; at += 1)
      if (this.#byCommand.has(commits.ids[at] as string)) return false;
    const revisions = revisionsAfter(state, this.#position);
    if (revisions === null) return false;
    for (const revision of revisions)
      this.append(revision, commits.map.get(revision.command.id as string));
    if (revisions.length > 0) this.#position = positionOf(state);
    this.#seen = commits.ids.length;
    return true;
  }

  /** Note whose commits these were made with. */
  from(commits: CommitIndex): void {
    this.#from = commits;
    this.#generation = commits.generation;
    this.#seen = commits.ids.length;
  }

  /** The time of revision `revision`, or null when there is none. */
  atOf(revision: bigint): string | null {
    if (revision < 1n) return null;
    return this.#ats[Number(revision) - 1] ?? null;
  }

  /** The revision of the newest close of a period up to `through`, or 0n when none was closed. */
  lastClose(through: bigint): bigint {
    let low = 0;
    let high = this.#closes.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((this.#closes[middle] as bigint) <= through) low = middle + 1;
      else high = middle;
    }
    return low === 0 ? 0n : (this.#closes[low - 1] as bigint);
  }

  /** The last revision up to `pin` that is dated before the day `point`, or `pin` itself when every one is
   * not: the revision a list that begins on that day follows. */
  lastBeforeDay(point: string, pin: bigint): bigint {
    const day = (revision: bigint) => (this.atOf(revision) ?? "").slice(0, 10);
    let first = pin;
    if (this.#ordered) {
      let low = 1;
      let high = Number(pin);
      let found = -1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        if (day(BigInt(middle)) >= point) {
          found = middle;
          high = middle - 1;
        } else low = middle + 1;
      }
      if (found > 0) first = BigInt(found) - 1n;
    } else
      for (let revision = 1n; revision <= pin; revision += 1n)
        if (day(revision) >= point) {
          first = revision - 1n;
          break;
        }
    return first;
  }

  /** The last revision up to `pin` that is not dated after the day `end`, or 0n. */
  lastOnDay(end: string, pin: bigint): bigint {
    const day = (revision: bigint) => (this.atOf(revision) ?? "").slice(0, 10);
    let last = pin;
    if (this.#ordered) {
      let low = 1;
      let high = Number(pin);
      let found = 0;
      while (low <= high) {
        const middle = (low + high) >> 1;
        if (day(BigInt(middle)) <= end) {
          found = middle;
          low = middle + 1;
        } else high = middle - 1;
      }
      last = BigInt(found);
    } else while (last > 0n && day(last) > end) last -= 1n;
    return last;
  }

  /** How far back the book recorded who made each change: the first revision whose maker is in the table. */
  attribution(): { readonly fromRevision: string; readonly fromAt: string } | null {
    if (this.#recorded === null) return null;
    const item = this.#items[this.#first[this.#recorded] as number] as LedgerItem;
    return { fromRevision: item.revision.toString(), fromAt: item.at };
  }

  #start(revision: number): number {
    return revision >= this.#first.length ? this.#items.length : (this.#first[revision] as number);
  }

  /** The changes of the revisions after `after` up to and including `through`, as positions: from `low` up
   * to but not including `high`. */
  range(after: bigint, through: bigint): { readonly low: number; readonly high: number } {
    if (through <= after) return { low: 0, high: 0 };
    return { low: this.#start(Number(after)), high: this.#start(Number(through)) };
  }

  /** The newest `limit` changes of a range as candidates, newest revision first and a revision's changes in
   * the order they were found. */
  newest(
    range: { readonly low: number; readonly high: number },
    limit: number,
    context: Context,
  ): LedgerCandidate[] {
    const found: LedgerCandidate[] = [];
    let end = range.high;
    while (end > range.low && found.length < limit) {
      // The revision the change before `end` belongs to: its changes are taken together.
      const revision = this.#items[end - 1]?.revision as bigint;
      let start = end - 1;
      while (start > range.low && (this.#items[start - 1] as LedgerItem).revision === revision)
        start -= 1;
      for (let at = start; at < end; at += 1)
        found.push(candidateOf(this.#items[at] as LedgerItem, context));
      end = start;
    }
    return found;
  }

  /** Every change of a range as candidates, newest revision first. */
  all(range: { readonly low: number; readonly high: number }, context: Context): LedgerCandidate[] {
    return this.newest(range, Number.POSITIVE_INFINITY, context);
  }

  /** What is held, as plain data in a fixed order, so that a test can compare two. */
  snapshot(): unknown {
    return {
      position: this.#position.revision.toString(),
      items: this.#items.map((item) => [
        item.revision.toString(),
        item.spec.part,
        item.spec.kind,
        item.at,
        item.actorKey,
        item.operation,
      ]),
      first: this.#first,
      ats: this.#ats,
      closes: this.#closes.map(String),
      ordered: this.#ordered,
      attribution: this.attribution(),
      makers: this.makers({ low: 0, high: this.#items.length })
        .map((entry) => [actorKey(entry.actor), entry.count])
        .sort(([left], [right]) => (String(left) < String(right) ? -1 : 1)),
    };
  }

  /** Who made the changes of a range, with how many each. */
  makers(range: {
    readonly low: number;
    readonly high: number;
  }): { readonly actor: ActorRef; readonly count: number }[] {
    const counts: { actor: ActorRef; count: number }[] = [];
    const bound = (positions: readonly number[], limit: number): number => {
      let low = 0;
      let high = positions.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if ((positions[middle] as number) < limit) low = middle + 1;
        else high = middle;
      }
      return low;
    };
    for (const { actor, at } of this.#actors.values()) {
      const count = bound(at, range.high) - bound(at, range.low);
      if (count > 0) counts.push({ actor, count });
    }
    return counts;
  }
}

/** The changes of a state, made from the whole of it. */
export function buildLedgerChanges(state: BookState, commits: CommitIndex): LedgerChanges {
  const changes = new LedgerChanges(positionOf(state));
  for (const revision of state.revisions)
    changes.append(revision, commits.map.get(revision.command.id as string));
  changes.from(commits);
  return changes;
}

/** The changes kept for each book, found through the object every state of one book shares. */
const kept = new WeakMap<object, LedgerChanges>();

/** The changes at exactly this state: the ones kept for the book moved on to it when it is the next revisions
 * of the same chain, and changes made from the state when it is not. */
export function ledgerChangesFor(state: BookState, commits: CommitIndex): LedgerChanges {
  const held = kept.get(state.identity);
  if (held?.advance(state, commits)) return held;
  const built = buildLedgerChanges(state, commits);
  // A state older than the one kept (a read pinned to an earlier revision) is answered and not remembered.
  if (!held || built.position.revision >= held.position.revision) kept.set(state.identity, built);
  return built;
}

/** The context the words of a change are made in: the book as it is, with the chart and the calendar, and a way
 * to find the entry a reversal reversed. */
export function ledgerContext(
  state: BookState,
  journalOf?: (id: string) => BookedJournal | undefined,
): Context {
  return {
    state,
    accounts: new Map(
      state.admissionSnapshot.accounts.map((account) => [account.id as string, account]),
    ),
    journals: undefined,
    periods: undefined,
    ...(journalOf ? { journalOf } : {}),
  };
}

/** Everything the ledger holds in the revisions after `after` up to and including `through`, newest
 * first. `commits` is what `commitAction` kept; a revision without a row has a maker nobody recorded. */
export function readLedger(
  state: BookState,
  commits: ReadonlyMap<string, CommitFacts>,
  range: { readonly after: bigint; readonly through: bigint },
): LedgerCandidate[] {
  if (range.through <= range.after) return [];
  const revisions = state.revisions.slice(Number(range.after), Number(range.through));
  const first = revisions[0];
  if (
    revisions.length !== Number(range.through - range.after) ||
    first === undefined ||
    first.bookRevision !== range.after + 1n
  )
    throw new Error("The book's revisions are not in order");
  const changes = new LedgerChanges({ revision: 0n, chainHash: null });
  for (const revision of revisions)
    changes.append(revision, commits.get(revision.command.id as string));
  return changes.all({ low: 0, high: changes.length }, ledgerContext(state));
}

/** The revision of the newest `closePeriod` command up to `through`, or 0n when no period was ever
 * closed. Found from the end without reading the effects of anything else. */
export function lastCloseRevision(state: BookState, through: bigint): bigint {
  const revisions = state.revisions;
  for (let index = Math.min(Number(through), revisions.length) - 1; index >= 0; index -= 1) {
    const revision = revisions[index] as RevisionRecord;
    if (revision.command.type === "closePeriod") return revision.bookRevision;
  }
  return 0n;
}

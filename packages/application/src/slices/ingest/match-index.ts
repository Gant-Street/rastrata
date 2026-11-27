/** The entries of the book a bank line might already be, found by account and amount, kept current from
 * the ledger's own new revisions instead of being worked out again from every entry at each reading.
 *
 * A bank line is the bank's record of an entry somebody already booked when the entry has a posting on the
 * line's chart account for exactly the line's amount, dated near the line. This holds, for every entry of
 * the book that is still in effect, the entry's net posting on each account it touches, under the key
 * `account|cents`. An entry a reversal took back, the reversal itself, and an entry a correction replaced
 * are no longer in effect and say nothing about a line (offering one as "an entry you already booked" would
 * send a line that was undone back to the entry it was undone from).
 *
 * One index is kept for each book and moved on in place: asked for the state that follows the one it stands
 * at (the next revisions of the same hash chain), it takes in what those revisions added and took away, a few
 * entries and not the book. Asked for anything else (the first time, a book replaced under it, a state a great
 * many revisions on) it is built from the state again. It is held to that by `match-index.test.ts`, which
 * compares it with one built from nothing at every state of random books. */
import type { BookState, BookedJournal } from "@rastrata/kernel";
import { daysBetween } from "../../ingest/text.ts";
import type { JournalCandidate, JournalQuery } from "../../ingest-types.ts";
import { formatMoney } from "../../money.ts";
import {
  deltaOf,
  positionOf,
  revisionsAfter,
  type Delta,
  type Position,
} from "../../reports/ledger-history.ts";

/** An entry's net posting on one account. */
export interface MatchEntry {
  readonly id: string;
  readonly date: string;
  readonly accountId: string;
  /** Signed, a debit positive. */
  readonly cents: bigint;
  readonly narration: string;
}

interface Known {
  readonly booked: BookedJournal;
  /** Every account the entry posts to, with its net there. Kept after the entry leaves the index. */
  readonly entries: readonly MatchEntry[];
  /** False once a reversal or a correction took the entry out of effect. */
  live: boolean;
}

const keyOf = (accountId: string, cents: bigint): string => `${accountId}|${cents}`;

function entriesOf(booked: BookedJournal): MatchEntry[] {
  const sums = new Map<string, bigint>();
  for (const posting of booked.journal.postings)
    sums.set(
      posting.accountId,
      (sums.get(posting.accountId) ?? 0n) + posting.bookValue.amount.coefficient,
    );
  const id = booked.journal.id as string;
  const date = booked.journal.accountingDate as string;
  return [...sums].map(([accountId, cents]) => ({
    id,
    date,
    accountId,
    cents,
    narration: booked.journal.narration,
  }));
}

export class MatchIndex {
  readonly #byKey = new Map<string, MatchEntry[]>();
  readonly #known = new Map<string, Known>();
  #position: Position;

  constructor(position: Position) {
    this.#position = position;
  }

  get position(): Position {
    return this.#position;
  }

  /** How many entries are in effect, for tests. */
  get live(): number {
    let count = 0;
    for (const known of this.#known.values()) if (known.live) count += 1;
    return count;
  }

  /** Whether the book holds an entry with this identifier, in effect or not. */
  has(journalId: string): boolean {
    return this.#known.has(journalId);
  }

  /** What the entry posts, by account, whether or not it is still in effect; undefined for an entry the book
   * does not hold. */
  entriesOf(journalId: string): readonly MatchEntry[] | undefined {
    return this.#known.get(journalId)?.entries;
  }

  /** The entry of the book with this identifier, in effect or not. */
  journal(journalId: string): BookedJournal | undefined {
    return this.#known.get(journalId)?.booked;
  }

  add(booked: BookedJournal): void {
    const id = booked.journal.id as string;
    if (this.#known.has(id)) return;
    const entries = entriesOf(booked);
    this.#known.set(id, { booked, entries, live: true });
    for (const entry of entries) {
      const key = keyOf(entry.accountId, entry.cents);
      const list = this.#byKey.get(key);
      if (list) list.push(entry);
      else this.#byKey.set(key, [entry]);
    }
  }

  /** Take an entry out of effect. Nothing happens for one that is not there or already out. */
  remove(journalId: string): void {
    const known = this.#known.get(journalId);
    if (!known?.live) return;
    known.live = false;
    for (const entry of known.entries) {
      const key = keyOf(entry.accountId, entry.cents);
      const list = this.#byKey.get(key);
      if (!list) continue;
      const at = list.indexOf(entry);
      if (at >= 0) list.splice(at, 1);
      if (list.length === 0) this.#byKey.delete(key);
    }
  }

  /** What a run of revisions did: the entries they added, then the corrections that took entries out of
   * effect (a reversal takes out the entry and the reversing entry, a replacement the entry it replaced).
   * The index afterwards stands at `position`. */
  apply(delta: Delta, position: Position): void {
    for (const booked of delta.journals) this.add(booked);
    for (const link of delta.links) {
      this.remove(link.originalJournalId);
      if (link.kind === "reversal") this.remove(link.correctionJournalId);
    }
    this.#position = position;
  }

  /** Entries that have a net posting of exactly `amount` on the account, dated within the window, in effect
   * and not linked to a line of the Inbox, nearest `around` first and then by identifier. */
  near(query: JournalQuery, linked: (journalId: string) => boolean): readonly JournalCandidate[] {
    const cents = BigInt(query.amount.replace(".", ""));
    const list = this.#byKey.get(keyOf(query.accountId, cents)) ?? [];
    const around = query.around ?? query.from;
    return list
      .filter((entry) => entry.date >= query.from && entry.date <= query.to && !linked(entry.id))
      .sort(
        (left, right) =>
          Math.abs(daysBetween(around, left.date)) - Math.abs(daysBetween(around, right.date)) ||
          (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      )
      .slice(0, query.limit ?? 20)
      .map((entry) => ({
        id: entry.id,
        date: entry.date,
        amount: formatMoney(entry.cents),
        narration: entry.narration,
      }));
  }

  /** The keys and the entries under them, in effect only, as plain data: for tests, to compare two
   * indexes. Order inside a key does not matter to any reader, so it is sorted. */
  snapshot(): { key: string; ids: string[] }[] {
    return [...this.#byKey]
      .map(([key, list]) => ({ key, ids: list.map((entry) => entry.id).sort() }))
      .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  }
}

/** The index of a state, made from the whole of it. */
export function buildMatchIndex(state: BookState): MatchIndex {
  const index = new MatchIndex(positionOf(state));
  for (const booked of state.journals) index.add(booked);
  for (const link of state.corrections) {
    index.remove(link.originalJournalId);
    if (link.kind === "reversal") index.remove(link.correctionJournalId);
  }
  return index;
}

/** The index kept for each book, found through the object every state of one book shares. */
const kept = new WeakMap<object, MatchIndex>();

/** The index at exactly this state: the one kept for the book moved on to it when this state is the next
 * revisions of the same chain, and one made from the state when it is not. */
export function matchIndexFor(state: BookState): MatchIndex {
  const held = kept.get(state.identity);
  if (held) {
    const revisions = revisionsAfter(state, held.position);
    if (revisions !== null) {
      if (revisions.length > 0) held.apply(deltaOf(revisions), positionOf(state));
      return held;
    }
  }
  const built = buildMatchIndex(state);
  // A state older than the one kept (a read pinned to an earlier revision) is answered and not remembered,
  // so it does not cost the next real state its predecessor.
  if (!held || built.position.revision >= held.position.revision) kept.set(state.identity, built);
  return built;
}

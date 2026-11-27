/** The book's posted entries read as past bank lines (`rules/history.ts`), kept current from the ledger's own
 * new revisions instead of being read again from every entry whenever the book has moved.
 *
 * What the classifier learns from and what a rule is tested against is the entries of the book that are in
 * effect and look like a decision about a category. Reading them replayed the whole book (and every stored
 * source event's text) after each posting; this holds them by entry and moves them on by what the new
 * revisions added and took away. An entry a correction touched, whether it was the one corrected or the
 * correction, is no longer a decision anyone stands behind and is left out.
 *
 * One set of lines is kept for each book and moved on in place, as `match-index.ts` does for the entries a
 * bank line might be: asked for the state that follows the one it stands at (the next revisions of the same
 * hash chain) it takes in the difference, and asked for anything else it is made from the state. It is held to
 * the whole read by `test/rules-lines.test.ts` at every state of random books. */
import type { BookState, BookedJournal } from "@rastrata/kernel";
import {
  deltaOf,
  positionOf,
  revisionsAfter,
  type Delta,
  type Position,
} from "../../reports/ledger-history.ts";
import { type PostedJournal, type PostedLine, postedLine } from "../../rules/history.ts";

const SOURCE_SYSTEM = "rastrata-source-v1";

/** The text of the source event an entry was posted from, by the source's identifier. The source events
 * are written before the entries made from them and never change. */
export interface SourceDescriptions {
  one(sourceRecordId: string): string | undefined;
  /** Every source's description at once, for making the lines from a whole book. */
  all(): ReadonlyMap<string, string>;
}

const rolesOf = (state: BookState): ReadonlyMap<string, string> =>
  new Map(state.admissionSnapshot.accounts.map((account) => [account.id as string, account.role]));

const order = (left: PostedLine, right: PostedLine): number =>
  left.date < right.date
    ? -1
    : left.date > right.date
      ? 1
      : left.journalId < right.journalId
        ? -1
        : 1;

export class PostedLines {
  readonly #lines = new Map<string, PostedLine>();
  readonly #roles: Map<string, string>;
  #position: Position;
  #sorted: readonly PostedLine[] | null = null;

  constructor(position: Position, roles: ReadonlyMap<string, string>) {
    this.#position = position;
    this.#roles = new Map(roles);
  }

  get position(): Position {
    return this.#position;
  }

  get size(): number {
    return this.#lines.size;
  }

  get(journalId: string): PostedLine | undefined {
    return this.#lines.get(journalId);
  }

  /** The lines by date and then by entry identifier: the order the history is read in. */
  sorted(): readonly PostedLine[] {
    this.#sorted ??= [...this.#lines.values()].sort(order);
    return this.#sorted;
  }

  /** The line an entry makes, or nothing when it is not a decision about a category (not an ordinary entry,
   * an amount that is not whole cents, no bank side, no text). */
  #lineOf(
    booked: BookedJournal,
    description: (sourceRecordId: string) => string | undefined,
  ): PostedLine | null {
    const journal = booked.journal;
    if (journal.kind !== "ordinary") return null;
    if (journal.postings.some((posting) => posting.bookValue.amount.scale !== 2n)) return null;
    const evidence = booked.derivations
      .flatMap((item) => item.evidence)
      .find((item) => item.sourceSystem === SOURCE_SYSTEM);
    const text = evidence ? description(evidence.sourceRecordId) : undefined;
    const candidate: PostedJournal = {
      id: journal.id,
      date: journal.accountingDate,
      narration: journal.narration,
      ...(text !== undefined ? { sourceDescription: text } : {}),
      postings: journal.postings.map((posting) => ({
        accountId: posting.accountId,
        role: this.#roles.get(posting.accountId) ?? "",
        cents: posting.bookValue.amount.coefficient,
      })),
    };
    return postedLine(candidate);
  }

  add(booked: BookedJournal, description: (sourceRecordId: string) => string | undefined): void {
    const line = this.#lineOf(booked, description);
    if (line === null) return;
    this.#lines.set(line.journalId, line);
    this.#sorted = null;
  }

  remove(journalId: string): void {
    if (this.#lines.delete(journalId)) this.#sorted = null;
  }

  /** Take in what a run of revisions did, ending at `position`: the entries they added, then the entries
   * their corrections took out of the history (the one corrected and the correction, whatever kind). False
   * when an account the lines were read with is now another kind of account, which changes what every entry
   * on it reads as, so the lines must be made again from the state. An account that is new has no entry
   * before these revisions, so it changes nothing for the lines there are. */
  apply(
    delta: Delta,
    state: BookState,
    position: Position,
    descriptions: SourceDescriptions,
  ): boolean {
    if (delta.configurations.length > 0) {
      const now = rolesOf(state);
      for (const [id, role] of this.#roles) if (now.get(id) !== role) return false;
      for (const [id, role] of now) this.#roles.set(id, role);
    }
    for (const booked of delta.journals) this.add(booked, (id) => descriptions.one(id));
    for (const link of delta.links) {
      this.remove(link.originalJournalId);
      this.remove(link.correctionJournalId);
    }
    this.#position = position;
    return true;
  }
}

/** The lines of a state, made from the whole of it. */
export function buildPostedLines(state: BookState, descriptions: SourceDescriptions): PostedLines {
  const lines = new PostedLines(positionOf(state), rolesOf(state));
  const known = descriptions.all();
  for (const booked of state.journals) lines.add(booked, (id) => known.get(id));
  for (const link of state.corrections) {
    lines.remove(link.originalJournalId);
    lines.remove(link.correctionJournalId);
  }
  return lines;
}

/** The lines kept for each book, found through the object every state of one book shares. */
const kept = new WeakMap<object, PostedLines>();

/** The lines at exactly this state: the ones kept for the book moved on to it when it is the next revisions
 * of the same chain, and lines made from the state when it is not. */
export function postedLinesFor(state: BookState, descriptions: SourceDescriptions): PostedLines {
  const held = kept.get(state.identity);
  if (held) {
    const revisions = revisionsAfter(state, held.position);
    if (revisions !== null) {
      if (revisions.length === 0) return held;
      if (held.apply(deltaOf(revisions), state, positionOf(state), descriptions)) return held;
    }
  }
  const built = buildPostedLines(state, descriptions);
  // A state older than the one kept (a read pinned to an earlier revision) is answered and not remembered.
  if (!held || built.position.revision >= held.position.revision) kept.set(state.identity, built);
  return built;
}

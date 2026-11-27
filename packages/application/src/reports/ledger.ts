import {
  journalLogOf,
  type BookConfigurationSnapshot,
  type BookedJournal,
  type BookState,
  type CorrectionLink,
} from "@rastrata/kernel";

import { ApplicationError } from "../errors.ts";
import {
  chartIn,
  configurationsOf,
  deltaOf,
  positionOf,
  revisionsAfter,
  type ConfigurationStep,
  type Delta,
  type Position,
} from "./ledger-history.ts";
import { AccountLines } from "./ledger-lines.ts";
import { extendOpening, openingOf, type OpeningJournals } from "./ledger-opening.ts";
import {
  extendProjection,
  projectionCounts,
  projectionFromHistory,
  vouchedProjection,
  type BalanceProjection,
} from "./ledger-projection.ts";
import { PostingSeries, isReadable, type Accumulated } from "./ledger-series.ts";

export type { Accumulated } from "./ledger-series.ts";

export type BookedPosting = BookedJournal["journal"]["postings"][number];

/** The journals a report as of one cutoff date is built from. */
export interface IncludedJournals {
  /** Ordered by accounting date, then posting sequence. */
  readonly journals: readonly BookedJournal[];
  /** True when no journal of the book was left out: the cutoff is on or after the last journal and
   * no journal is superseded. Only then can the totals be checked against the kernel's projection. */
  readonly complete: boolean;
}

/** Every posting's book value in cents, which is all a report reads from the ledger. */
export const postingCents = (posting: BookedPosting): bigint =>
  posting.bookValue.amount.coefficient;

const compareJournals = (left: BookedJournal, right: BookedJournal): number =>
  left.journal.accountingDate < right.journal.accountingDate
    ? -1
    : left.journal.accountingDate > right.journal.accountingDate
      ? 1
      : left.postingSequence < right.postingSequence
        ? -1
        : left.postingSequence > right.postingSequence
          ? 1
          : 0;

/** How views were made in this process: from nothing, or from the view of the state before. It carries
 * no accounting meaning; a test or a bench reads it to say that a path did not start over. */
const made = {
  built: 0,
  extended: 0,
  seriesBuilt: 0,
  /** Views that took the balances a replay had carried to their state. */
  projectionsVouched: 0,
  /** Views that carried the balances of the view before them forward by the new revisions. */
  projectionsExtended: 0,
};

/** How the accounts' lines were made in this process: from every journal of a book, or carried forward by the journals
 * of a new state. Like `made`, it carries no accounting meaning; a test reads it to say that a read did not start over. */
const linesMade = { built: 0, extended: 0 };
export const accountLinesCounts = (): Readonly<typeof linesMade> => ({ ...linesMade });

/** `projectionsFromHistory` is the number of times the kernel's full rebuild has run for any reason in
 * this process (a report whose state nobody carried balances to, or a full verification). */
export function ledgerViewCounts(): Readonly<typeof made & { projectionsFromHistory: number }> {
  return { ...made, projectionsFromHistory: projectionCounts().rebuilt };
}

const closingEntries = (): ApplicationError =>
  new ApplicationError(
    "closing_entries_unsupported",
    "This book contains a closing journal. Rastrata reports earnings by computation and does not read books that post closing entries.",
    409,
  );

/** An original journal that a correction supersedes, and the first date a superseding journal is in
 * effect. */
interface Superseded {
  readonly booked: BookedJournal;
  readonly from: string;
}

/** Fold a supersession link into the index: the earliest date a journal superseding the original is
 * dated wins. A link whose journals the book does not hold changes nothing. */
function supersede(
  into: Map<string, Superseded>,
  link: CorrectionLink,
  original: BookedJournal | undefined,
  correction: BookedJournal | undefined,
): void {
  if (original === undefined || correction === undefined) return;
  const date = correction.journal.accountingDate as string;
  const known = into.get(link.originalJournalId);
  if (known === undefined || date < known.from)
    into.set(link.originalJournalId, { booked: original, from: date });
}

/** What a view takes from the view of the state it extends (internal to this module). */
export interface Inherited {
  readonly sorted: readonly BookedJournal[];
  readonly superseded: ReadonlyMap<string, Superseded>;
  readonly position: Position;
  readonly journalCount: number;
  readonly correctionCount: number;
  readonly closing: boolean;
  readonly series: PostingSeries | undefined;
  readonly lines: AccountLines | undefined;
  readonly projection: BalanceProjection | undefined;
  readonly timeline: readonly ConfigurationStep[] | undefined;
  readonly opening: OpeningJournals | undefined;
}

/** A read-only view of one book state, shared by every statement compiled from it. A state is
 * immutable, so what is worked out from it is worked out once per state. And a state is almost always
 * the state before it plus one command, so the view of a state is made from the view of the one before
 * (see `ledgerView`): a report after a posting costs that posting, not the book.
 *
 * It holds the journals in date order, the originals that corrections supersede, and, built the first
 * time they are asked for, the postings added up by account and date (`accumulated`), the kernel's
 * balances to compare a report with (`verifyAgainstKernel`) and the configuration changes by date
 * (`configurationAt`). */
export class LedgerView {
  private readonly sorted: readonly BookedJournal[];
  /** Original journal id to the first date a journal that supersedes it is in effect. */
  private readonly superseded: ReadonlyMap<string, Superseded>;
  /** The place in the book's hash chain this view stands at. */
  readonly position: Position;
  private readonly journalCount: number;
  private readonly correctionCount: number;
  /** Whether the book holds a closing journal, which reports refuse to read (`ledgerView` throws). */
  readonly closing: boolean;
  private series: PostingSeries | undefined;
  private lines: AccountLines | undefined;
  private projection: BalanceProjection | undefined;
  private timeline: readonly ConfigurationStep[] | undefined;
  private opening: OpeningJournals | undefined;
  private projectionChecked = false;

  /** The view of `state` made from nothing: every journal sorted and every correction read. Call
   * `ledgerView` instead, which makes it from the view of an earlier state when there is one. */
  constructor(
    readonly state: BookState,
    inherited?: Inherited,
  ) {
    if (inherited) {
      this.sorted = inherited.sorted;
      this.superseded = inherited.superseded;
      this.position = inherited.position;
      this.journalCount = inherited.journalCount;
      this.correctionCount = inherited.correctionCount;
      this.closing = inherited.closing;
      this.series = inherited.series;
      this.lines = inherited.lines;
      this.projection = inherited.projection;
      this.timeline = inherited.timeline;
      this.opening = inherited.opening;
      return;
    }
    made.built += 1;
    const journals = state.journals;
    this.sorted = [...journals].sort(compareJournals);
    this.superseded = supersededIn(state.corrections, journals);
    this.closing = journals.some((booked) => booked.journal.kind === "closing");
    this.position = positionOf(state);
    this.journalCount = journals.length;
    this.correctionCount = state.corrections.length;
  }

  /** The view of `state` made from the view of an earlier state of the same book, or null when `state`
   * does not carry that history on (or carries it on by more commands than are worth replaying). */
  static extending(base: LedgerView, state: BookState): LedgerView | null {
    const revisions = revisionsAfter(state, base.position);
    if (revisions === null) return null;
    const delta = deltaOf(revisions);
    if (
      BigInt(base.journalCount + delta.journals.length) !== state.latestPostingSequence ||
      base.correctionCount + delta.links.length !== state.corrections.length
    )
      return null;
    made.extended += 1;
    // The balances a replay carried to this very state, if one did, are the ones to compare with; failing
    // that, the view before's balances carried forward by the new revisions (a state a preview made).
    const carried = vouchedProjection(state);
    const projection =
      carried ??
      (revisions.length === 0 || base.projection === undefined
        ? base.projection
        : (extendProjection(base.projection, revisions, (id) => base.find(id)) ?? undefined));
    if (carried !== undefined) made.projectionsVouched += 1;
    else if (projection !== undefined && projection !== base.projection)
      made.projectionsExtended += 1;
    return new LedgerView(state, {
      sorted: insertJournals(base.sorted, delta.journals),
      superseded: supersessionsAfter(base.superseded, (id) => base.find(id), delta),
      position: positionOf(state),
      journalCount: base.journalCount + delta.journals.length,
      correctionCount: base.correctionCount + delta.links.length,
      closing: base.closing || delta.journals.some((booked) => booked.journal.kind === "closing"),
      series: base.series?.extend(delta.journals),
      // A great many journals at once (an import) are put in by making the lines again when they are asked for.
      lines: carriedLines(base.lines, delta.journals),
      projection,
      timeline:
        base.timeline === undefined || delta.configurations.length === 0
          ? base.timeline
          : [...base.timeline, ...delta.configurations],
      opening:
        base.opening === undefined
          ? undefined
          : extendOpening(base.opening, delta.journals, delta.links, (id) => base.find(id)),
    });
  }

  /** The journal with this id, from the lookup by identifier the kernel keeps beside the book's journals (made
   * for the journals a state adds, once, and not for each state), so it costs the same on a book of ten
   * journals and one of a hundred thousand. */
  find(journalId: string): BookedJournal | undefined {
    return journalLogOf(this.state).first("journal", journalId);
  }

  /** Every journal, ordered by accounting date and then posting sequence. Not a copy: do not change it. */
  journalsByDate(): readonly BookedJournal[] {
    return this.sorted;
  }

  /** Every account's postings by day, in the ledger's order, with the sums that make a range of dates a
   * subtraction (see `AccountDays`): made from the journals the first time they are asked for, and carried to
   * the view of each state after this one. They hold every journal of the book, so a book that has a journal
   * a correction supersedes is read by its postings instead (see `hasSupersessions`). */
  accountLines(): AccountLines {
    if (this.lines === undefined) {
      linesMade.built += 1;
      this.lines = AccountLines.of(this.sorted);
    }
    return this.lines;
  }

  /** Whether a journal of the book has been superseded by a correction, which takes it out of the reports from
   * the day the correction is dated (no book this application makes has one). */
  get hasSupersessions(): boolean {
    return this.superseded.size > 0;
  }

  /** The latest accounting date of any journal, or null for an empty book. */
  get latestJournalDate(): string | null {
    return this.sorted.at(-1)?.journal.accountingDate ?? null;
  }

  /** The chart in force on a date: the latest configuration change that took effect on or before it,
   * in the order the book made them, or the book's first configuration when none had. Accounts opened
   * later are absent and an account keeps the name it had then, so a report for a past date reads as
   * it did. */
  configurationAt(asOf: string): BookConfigurationSnapshot {
    this.timeline ??= configurationsOf(this.state.revisions);
    return chartIn(this.timeline, this.state, asOf);
  }

  /** The journals that are the book's opening position and not activity (see `OpeningJournals`),
   * worked out once for the book and carried to each state after it. */
  openingJournals(): OpeningJournals {
    this.opening ??= openingOf(this.state.journals, this.state.corrections);
    return this.opening;
  }

  /** Whether `included(cutoff)` has this journal in it, without making the list. */
  includes(booked: BookedJournal, cutoff: string): boolean {
    if (booked.journal.accountingDate > cutoff) return false;
    const from = this.superseded.get(booked.journal.id)?.from;
    return from === undefined || from > cutoff;
  }

  /** Journals dated on or before `cutoff`, leaving out an original once a journal superseding it is
   * itself on or before the cutoff. A reversal does not hide its original: both are included and net
   * to zero, which is how the history reads. */
  included(cutoff: string): IncludedJournals {
    const low = upperJournal(this.sorted, cutoff);
    const selected = this.sorted.slice(0, low);
    if (this.superseded.size === 0)
      return { journals: selected, complete: low === this.sorted.length };
    const kept = selected.filter((booked) => {
      const from = this.superseded.get(booked.journal.id)?.from;
      return from === undefined || from > cutoff;
    });
    return { journals: kept, complete: low === this.sorted.length && kept.length === low };
  }

  /** The postings of `included(cutoff)` added up by account, split three ways: all of them, those dated
   * on or after `yearStart`, and those dated on or after `rangeStart`. The same figures as adding up the
   * included journals one posting at a time (`accumulate`), read from the postings added up by account and
   * date, so it costs the number of accounts and not the number of postings. `complete` is
   * `included(cutoff).complete`. */
  accumulated(
    cutoff: string,
    yearStart: string,
    rangeStart: string,
    accountIds: ReadonlySet<string>,
  ): { readonly accumulated: Accumulated; readonly complete: boolean } {
    if (this.series === undefined) {
      made.seriesBuilt += 1;
      this.series = PostingSeries.of(this.sorted, this.state.identity.functionalCommodityId);
    }
    const accumulated = this.series.figures(cutoff, yearStart, rangeStart, accountIds);
    let left = 0;
    for (const { booked, from } of this.superseded.values()) {
      const date = booked.journal.accountingDate as string;
      if (date > cutoff || from > cutoff) continue;
      left += 1;
      for (const posting of booked.journal.postings) {
        if (!isReadable(posting, this.state.identity.functionalCommodityId)) continue;
        const account = posting.accountId as string;
        const cents = postingCents(posting);
        accumulated.cumulative.set(account, (accumulated.cumulative.get(account) ?? 0n) - cents);
        if (date >= yearStart)
          accumulated.yearToDate.set(account, (accumulated.yearToDate.get(account) ?? 0n) - cents);
        if (date >= rangeStart)
          accumulated.range.set(account, (accumulated.range.get(account) ?? 0n) - cents);
      }
    }
    const latest = this.latestJournalDate;
    return { accumulated, complete: (latest === null || latest <= cutoff) && left === 0 };
  }

  /** Compare book-wide balances with the kernel's projection of the book. A mismatch means this
   * compiler and the kernel disagree about the book, and no figure can be trusted. Checked once per
   * state, and only for a complete view.
   *
   * The projection is the balances the revisions give, worked out the way the kernel does it. A service
   * that replayed the ledger carried them to the state as it applied each revision (`ProjectionTrack`),
   * and a view takes them from there; a view of a state nobody carried them to (a preview, a state of a
   * test) carries the view before's forward by the revisions since, and failing that asks the kernel to
   * rebuild them from every revision, re-checking every hash, which costs the book's whole history (35
   * microseconds a revision). The kernel's rebuild is also what a full verification of the book runs and
   * compares the carried balances with (see `projectionDisagreement`). */
  verifyAgainstKernel(balances: ReadonlyMap<string, bigint>): void {
    if (this.projectionChecked) return;
    if (this.projection === undefined) {
      const carried = vouchedProjection(this.state);
      if (carried !== undefined) {
        made.projectionsVouched += 1;
        this.projection = carried;
      } else {
        const rebuilt = projectionFromHistory(this.state.revisions);
        if (rebuilt === null)
          throw new ApplicationError(
            "report_integrity_failure",
            "The book's balance projection could not be rebuilt, so reports are unavailable.",
            500,
          );
        this.projection = rebuilt;
      }
    }
    const projected = this.projection.balances;
    for (const [accountId, balance] of projected) {
      const cents = balances.get(accountId);
      if (cents === undefined) {
        if (balance.numerator === 0n) continue;
        throw new ApplicationError(
          "report_integrity_failure",
          "A report excluded an account that has a balance in the ledger.",
          500,
        );
      }
      if (cents * balance.denominator !== balance.numerator * 100n)
        throw new ApplicationError(
          "report_integrity_failure",
          "A report balance disagrees with the ledger's own projection.",
          500,
        );
    }
    for (const [accountId, cents] of balances)
      if (cents !== 0n && !projected.has(accountId))
        throw new ApplicationError(
          "report_integrity_failure",
          "A report balance disagrees with the ledger's own projection.",
          500,
        );
    this.projectionChecked = true;
  }
}

/** The index of the first journal dated after `cutoff` in a list ordered by date. */
function upperJournal(sorted: readonly BookedJournal[], cutoff: string): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((sorted[middle] as BookedJournal).journal.accountingDate <= cutoff) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The superseded originals of a whole book. */
function supersededIn(
  corrections: readonly CorrectionLink[],
  journals: readonly BookedJournal[],
): Map<string, Superseded> {
  const links = corrections.filter((link) => link.kind === "supersession");
  const index = new Map<string, Superseded>();
  if (links.length === 0) return index;
  const wanted = new Set<string>();
  for (const link of links) {
    wanted.add(link.originalJournalId);
    wanted.add(link.correctionJournalId);
  }
  const found = new Map<string, BookedJournal>();
  for (const booked of journals)
    if (wanted.has(booked.journal.id)) found.set(booked.journal.id, booked);
  for (const link of links)
    supersede(index, link, found.get(link.originalJournalId), found.get(link.correctionJournalId));
  return index;
}

/** The superseded originals after the corrections of `delta`; `find` looks a journal up among those
 * before it. */
function supersessionsAfter(
  superseded: ReadonlyMap<string, Superseded>,
  find: (journalId: string) => BookedJournal | undefined,
  delta: Delta,
): ReadonlyMap<string, Superseded> {
  const links = delta.links.filter((link) => link.kind === "supersession");
  if (links.length === 0) return superseded;
  const next = new Map(superseded);
  const added = new Map(delta.journals.map((booked) => [booked.journal.id as string, booked]));
  const look = (id: string) => added.get(id) ?? find(id);
  for (const link of links)
    supersede(next, link, look(link.originalJournalId), look(link.correctionJournalId));
  return next;
}

/** The journals with more in them, still ordered by date then posting sequence. */
function insertJournals(
  sorted: readonly BookedJournal[],
  added: readonly BookedJournal[],
): readonly BookedJournal[] {
  if (added.length === 0) return sorted;
  if (added.length > FEW) {
    // Many at once (a bulk import between two reports): sort the new ones and merge, which reads the
    // list once instead of moving its tail once for each.
    const more = [...added].sort(compareJournals);
    const merged: BookedJournal[] = [];
    let old = 0;
    let fresh = 0;
    while (old < sorted.length && fresh < more.length)
      merged.push(
        compareJournals(sorted[old] as BookedJournal, more[fresh] as BookedJournal) <= 0
          ? (sorted[old++] as BookedJournal)
          : (more[fresh++] as BookedJournal),
      );
    while (old < sorted.length) merged.push(sorted[old++] as BookedJournal);
    while (fresh < more.length) merged.push(more[fresh++] as BookedJournal);
    return merged;
  }
  const next = sorted.slice();
  for (const booked of added) {
    let low = 0;
    let high = next.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (compareJournals(next[middle] as BookedJournal, booked) <= 0) low = middle + 1;
      else high = middle;
    }
    next.splice(low, 0, booked);
  }
  return next;
}

/** Up to this many journals are put into the sorted list one at a time. */
const FEW = 8;
/** More journals than this at once are not put into the accounts' lines one by one: they are made again. */
const MOST_LINES_CARRIED = 128;

/** The accounts' lines of a view that has them, with the journals a state added; none when they were never made
 * or there are too many journals to put in one by one. */
function carriedLines(
  lines: AccountLines | undefined,
  added: readonly BookedJournal[],
): AccountLines | undefined {
  if (lines === undefined || added.length > MOST_LINES_CARRIED) return undefined;
  linesMade.extended += 1;
  return lines.extend(added);
}

const views = new WeakMap<BookState, LedgerView>();
/** The newest views of each book still being read, found through an object every state of one book
 * shares. A book whose states are all gone takes its entry with them. Two are kept so that a state
 * which branches off (a preview that is thrown away) does not cost the view the real next state
 * extends. */
const lineages = new WeakMap<object, LedgerView[]>();
const LINEAGE = 2;

/** The shared view of a book state for a report. States are immutable, so keying on the object is safe.
 * Refuses a book that holds a closing journal, as every report does. */
export function ledgerView(state: BookState): LedgerView {
  const view = bookView(state);
  if (view.closing) throw closingEntries();
  return view;
}

/** The shared view of a book state for a reader that is not a report (the Journal screen, a search for an
 * entry), which does not refuse a book with a closing journal. Made once per state, from the view of
 * the state before it when there is one (see `LedgerView.extending`). */
export function bookView(state: BookState): LedgerView {
  const known = views.get(state);
  if (known) return known;
  let view: LedgerView | null = null;
  const peers = lineages.get(state.identity) ?? [];
  for (let index = peers.length - 1; index >= 0 && view === null; index -= 1)
    view = LedgerView.extending(peers[index] as LedgerView, state);
  view ??= new LedgerView(state);
  views.set(state, view);
  const newest = [...peers, view].sort((left, right) =>
    left.position.revision < right.position.revision
      ? -1
      : left.position.revision > right.position.revision
        ? 1
        : 0,
  );
  lineages.set(state.identity, newest.slice(-LINEAGE));
  return view;
}

/** One pass over the set, posting by posting, adding up every posting. The reference the faster
 * `LedgerView.accumulated` is tested against, and what a report would cost without it. `yearStart` and
 * `rangeStart` split the same postings three ways, so the trial balance (fiscal year to date), the profit
 * and loss (the range) and the balance sheet (cumulative) all come from the same figures. */
export function accumulate(
  state: BookState,
  journals: readonly BookedJournal[],
  accountIds: ReadonlySet<string>,
  yearStart: string,
  rangeStart: string,
): Accumulated {
  const cumulative = new Map<string, bigint>();
  const yearToDate = new Map<string, bigint>();
  const range = new Map<string, bigint>();
  const commodity = state.identity.functionalCommodityId;
  for (const booked of journals) {
    const date = booked.journal.accountingDate;
    const inYear = date >= yearStart;
    const inRange = date >= rangeStart;
    for (const posting of booked.journal.postings) {
      if (
        posting.bookValue.functionalCommodityId !== commodity ||
        posting.bookValue.amount.scale !== 2n
      )
        throw new Error("Unsupported report currency scale");
      const account = posting.accountId as string;
      if (!accountIds.has(account)) throw new Error("Journal references an unknown account");
      const cents = postingCents(posting);
      cumulative.set(account, (cumulative.get(account) ?? 0n) + cents);
      if (inYear) yearToDate.set(account, (yearToDate.get(account) ?? 0n) + cents);
      if (inRange) range.set(account, (range.get(account) ?? 0n) + cents);
    }
  }
  return { cumulative, yearToDate, range };
}

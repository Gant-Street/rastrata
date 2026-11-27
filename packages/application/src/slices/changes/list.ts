/** `changes.list`: the composer. It owns the window (where the list starts and ends), the merge of the
 * sources, the filters, the counts and the paging; each source only reads what its own part of
 * Rastrata keeps.
 *
 * Two points pin a list so that a page does not shift while it is read: the book revision for the
 * changes the ledger holds, and an instant for the changes that live in product state and have no
 * revision. The first page returns both, and the next pages pass them back. A change is never read
 * twice and never read after the pin, however long the reader takes. */
import { describePrincipal } from "../../agent/principal.ts";
import { actorOf } from "../../changes/actors.ts";
import { type Candidate, mergeNewestFirst, newestFirst } from "../../changes/candidate.ts";
import {
  actorKey,
  type ActorRef,
  NOT_COVERED,
  SOURCE_NAMES,
  type SourceName,
} from "../../changes/kinds.ts";
import {
  type LedgerCandidate,
  type LedgerChanges,
  ledgerChangesFor,
  ledgerContext,
  shortDate,
} from "../../changes/ledger.ts";
import type {
  ChangeActor,
  ChangeActorCount,
  ChangeList,
  ChangeListInput,
  ChangeRecord,
  ChangeReview,
  ChangeSourceStatus,
} from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import { normalizeForKey, sanitizeText } from "../../ingest/text.ts";
import { matchIndexFor } from "../ingest/match-index.ts";
import type { SliceContext } from "../types.ts";
import { SOURCES } from "./sources/index.ts";
import { annotateFromReview } from "./sources/review.ts";
import { inWindow, type SourceReader, type SourceWindow } from "./sources/types.ts";
import { type ChangesState, changesState, labelOf, type ReviewRow } from "./store.ts";

const DEFAULT_PAGE_SIZE = 25;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The words a source goes by in the list of sources. */
const SOURCE_TITLES: Readonly<Record<SourceName, string>> = {
  ledger: "The books",
  review: "For review",
  rules: "Rules",
  tags: "Account tags",
  reconciliation: "Reconciliations",
  access: "Who has access",
};

export interface ListOptions {
  /** The sources besides the ledger, in the order they are read. Tests give their own. */
  readonly sources?: readonly SourceReader[];
  /** Read the sources that have no revision up to the time of the revision the list is pinned to, and
   * not up to now: a list that is part of a file made from one revision (the accountant pack) is then
   * the same whenever it is made again. */
  readonly asOfRevision?: boolean;
  /** The changes the ledger holds, made from the whole book. The list reads the ones kept current from the
   * book's new revisions; a test gives these to compare the two. */
  readonly ledger?: LedgerChanges;
}

/** Where the list starts and ends, in the two forms the sources need. */
interface Resolved {
  readonly afterRevision: bigint;
  readonly throughRevision: bigint;
  readonly window: SourceWindow;
  readonly since: string;
  readonly sinceAt: string | null;
  readonly until: string | null;
}

const reviewOf = (row: ReviewRow): ChangeReview => ({
  seq: row.seq,
  at: row.at,
  by: actorOf(row.principal, row.label),
  upToRevision: row.upToRevision,
  upToAt: row.upToAt,
  note: row.note,
});

function bad(message: string): never {
  throw new ApplicationError("invalid_input", message);
}

function resolveWindow(args: {
  readonly input: ChangeListInput;
  readonly changes: LedgerChanges;
  readonly pin: bigint;
  readonly asOf: string;
  readonly review: ReviewRow | null;
}): Resolved {
  const { input, changes, pin, asOf, review } = args;
  const at = (revision: bigint) => changes.atOf(revision);
  const dayOf = (instant: string | null) => (instant ?? "").slice(0, 10);

  let afterRevision = 0n;
  let sinceAt: string | null = null;
  let inclusive = false;
  let since = "the start of the book";
  const point = input.since;
  if (point === "lastReview") {
    if (review === null) since = "the start of the book (nothing has been marked as looked at yet)";
    else {
      afterRevision = BigInt(review.upToRevision);
      sinceAt = review.upToAt;
      since = `the last time the changes were marked as looked at (${shortDate(dayOf(review.at))})`;
    }
  } else if (point === "lastClose") {
    const closed = changes.lastClose(pin);
    if (closed === 0n) since = "the start of the book (no period has been closed yet)";
    else {
      afterRevision = closed;
      sinceAt = at(closed);
      since = `the last time a period was closed (${shortDate(dayOf(sinceAt))})`;
    }
  } else if (point !== undefined && DATE.test(point)) {
    // The first change recorded on or after that day, UTC; the changes before it are outside.
    afterRevision = changes.lastBeforeDay(point, pin);
    sinceAt = `${point}T00:00:00.000Z`;
    inclusive = true;
    since = `${shortDate(point)} (UTC)`;
  } else if (point !== undefined) {
    afterRevision = BigInt(point);
    if (afterRevision > pin) bad("The revision to start from is later than the book's.");
    sinceAt = at(afterRevision);
    since = `revision ${afterRevision}`;
  }

  let throughRevision = pin;
  let untilAt = asOf;
  let until: string | null = null;
  const end = input.until;
  if (end !== undefined && DATE.test(end)) {
    const last = changes.lastOnDay(end, pin);
    throughRevision = last;
    const nextDay = new Date(Date.parse(`${end}T00:00:00.000Z`) + 86_400_000).toISOString();
    untilAt = nextDay < asOf ? new Date(Date.parse(nextDay) - 1).toISOString() : asOf;
    until = `${shortDate(end)} (UTC)`;
  } else if (end !== undefined) {
    const revision = BigInt(end);
    if (revision < pin) {
      throughRevision = revision;
      untilAt = at(revision) ?? asOf;
      if (untilAt > asOf) untilAt = asOf;
    }
    until = `revision ${revision}`;
  }
  if (throughRevision < afterRevision) throughRevision = afterRevision;

  return {
    afterRevision,
    throughRevision,
    window: { sinceAt, sinceInclusive: inclusive, untilAt },
    since,
    sinceAt,
    until,
  };
}

/** Why a source could not be read, in words a person can act on. */
function reasonOf(error: unknown): string {
  if (error instanceof ApplicationError) {
    const message = sanitizeText(error.message, 260);
    if (error.code === "permission_denied")
      return `This sign-in may not read it: ${message.charAt(0).toLowerCase()}${message.slice(1).replace(/\.$/, "")}.`;
    return `It could not be read: ${message}`;
  }
  return "It could not be read, and nothing says why. Try again.";
}

interface SourceRun {
  readonly name: SourceName;
  readonly title: string;
  readonly candidates: readonly Candidate[];
  readonly read: boolean;
  readonly reason: string | null;
  /** What the caller may not read of it, left out and said; null when nothing was. */
  readonly withheld: string | null;
}

/** The sources besides the ledger, each read on its own so that one that fails does not stop the rest. */
async function readSources(
  context: SliceContext,
  readers: readonly SourceReader[],
  window: SourceWindow,
): Promise<SourceRun[]> {
  const runs: SourceRun[] = [];
  for (const reader of readers) {
    try {
      const found = await reader.read({ context, window });
      runs.push({
        name: reader.name,
        title: reader.title,
        candidates: found.candidates
          .filter((candidate) => inWindow(candidate.at, window))
          .sort(newestFirst),
        read: found.incomplete === undefined,
        reason: found.incomplete ?? null,
        withheld: found.withheld ?? null,
      });
    } catch (error) {
      runs.push({
        name: reader.name,
        title: reader.title,
        candidates: [],
        read: false,
        reason: reasonOf(error),
        withheld: null,
      });
    }
  }
  return runs;
}

/** The instant, as the service stamps one, that stands for "now" or for what the caller pinned. */
function pinnedAt(requested: string | undefined, now: string): string {
  if (requested === undefined) return now;
  const time = Date.parse(requested);
  if (Number.isNaN(time)) bad("asOf is not an instant.");
  const instant = new Date(time).toISOString();
  return instant > now ? now : instant;
}

const matchesActor = (actor: ActorRef, wanted: NonNullable<ChangeListInput["by"]>): boolean =>
  actor.kind === wanted.kind &&
  (wanted.id !== undefined
    ? actor.id === wanted.id
    : wanted.label === undefined || normalizeForKey(actor.label) === normalizeForKey(wanted.label));

/** Everything a list says before it is cut into pages: the window, the sources read, the changes that
 * match, who made them and how many there are. */
interface Collected {
  readonly changes: LedgerChanges;
  readonly store: ChangesState;
  readonly pin: bigint;
  readonly asOf: string;
  readonly review: ReviewRow | null;
  readonly resolved: Resolved;
  /** The changes that match, one list for each source, each newest first. */
  readonly shown: readonly (readonly Candidate[])[];
  readonly actors: ChangeActorCount[];
  readonly count: number;
  /** Every source but For review, which is read for the page that is shown. */
  readonly sources: ChangeSourceStatus[];
}

/** How much of the merged list a reader will take, so that the ledger's changes are made into candidates for
 * that many and not for every one in the window: a number of the newest, or all of them. */
type Take = number | "all";

async function collect(
  context: SliceContext,
  input: ChangeListInput,
  options: ListOptions,
  take: Take,
): Promise<Collected> {
  const { service } = context;
  const store = changesState(service);
  const { aggregate } = await service.readAggregate();
  const state = aggregate.state;
  const head = state.bookRevision;
  const pin = input.revision === undefined ? head : BigInt(input.revision);
  if (pin > head) bad("That revision is later than the book's latest.");
  const now = service.now();
  const changes = options.ledger ?? ledgerChangesFor(state, store.commitIndex());
  let asOf = pinnedAt(input.asOf, now);
  if (options.asOfRevision === true && input.asOf === undefined) {
    const time = changes.atOf(pin);
    if (time !== null) asOf = time > now ? now : time;
  }
  const review = store.newestReview();
  const resolved = resolveWindow({ input, changes, pin, asOf, review });

  // The ledger first: the book itself. The words of its changes are made when one is shown, from the book as
  // it is, finding an entry by its identifier in the index kept for the book.
  const words = ledgerContext(state, (id) => matchIndexFor(state).journal(id));
  const range = changes.range(resolved.afterRevision, resolved.throughRevision);
  const kinds = input.kinds === undefined ? null : new Set<string>(input.kinds);
  const needle = input.text === undefined ? "" : normalizeForKey(input.text);
  const by = input.by;
  // With nothing narrowing the ledger's changes, how many there are, who made them and the newest few are
  // known without making any of them into a candidate.
  const plain = kinds === null && needle === "" && by === undefined;
  const ledger: LedgerCandidate[] = plain
    ? changes.newest(range, take === "all" ? Number.POSITIVE_INFINITY : take, words)
    : changes.all(range, words);
  const ledgerCount = plain ? range.high - range.low : ledger.length;
  const runs = await readSources(context, options.sources ?? SOURCES, resolved.window);

  const sources: ChangeSourceStatus[] = [];
  for (const name of SOURCE_NAMES) {
    if (name === "review") continue;
    if (name === "ledger") {
      sources.push({
        name,
        title: SOURCE_TITLES.ledger,
        read: true,
        reason: null,
        withheld: null,
        changes: ledgerCount,
      });
      continue;
    }
    const run = runs.find((item) => item.name === name);
    sources.push(
      run
        ? {
            name,
            title: run.title,
            read: run.read,
            reason: run.reason,
            withheld: run.withheld,
            changes: run.candidates.length,
          }
        : {
            name,
            title: SOURCE_TITLES[name],
            read: false,
            reason: "It is not read by this release.",
            withheld: null,
            changes: 0,
          },
    );
  }

  const streams: (readonly Candidate[])[] = [ledger, ...runs.map((run) => run.candidates)];
  const keep = (candidate: Candidate): boolean => {
    if (kinds !== null && !kinds.has(candidate.kind)) return false;
    if (needle === "") return true;
    const record = candidate.build();
    return normalizeForKey(
      `${record.summary} ${record.subject.id} ${record.by.label} ${record.entry?.description ?? ""}`,
    ).includes(needle);
  };
  const filtered = streams.map((stream) =>
    kinds === null && needle === "" ? stream : stream.filter(keep),
  );

  // Who made the changes in the window, counted before the maker is filtered, so that a screen can
  // offer the makers there are.
  const makers = new Map<string, { actor: ActorRef; count: number }>();
  const note = (actor: ActorRef, count: number) => {
    const key = actorKey(actor);
    const entry = makers.get(key);
    if (entry) entry.count += count;
    else makers.set(key, { actor, count });
  };
  if (plain) for (const maker of changes.makers(range)) note(maker.actor, maker.count);
  filtered.forEach((stream, index) => {
    if (plain && index === 0) return;
    for (const candidate of stream) note(candidate.actor, 1);
  });
  const actors: ChangeActorCount[] = [...makers.values()]
    .sort((a, b) => b.count - a.count || (a.actor.label < b.actor.label ? -1 : 1))
    .slice(0, 100)
    .map((entry) => ({ by: entry.actor, count: entry.count }));

  const shown =
    by === undefined
      ? filtered
      : filtered.map((stream) => stream.filter((c) => matchesActor(c.actor, by)));
  const count = shown.reduce(
    (total, stream, index) => total + (plain && index === 0 ? ledgerCount : stream.length),
    0,
  );
  return { changes, store, pin, asOf, review, resolved, shown, actors, count, sources };
}

export async function listChanges(
  context: SliceContext,
  input: ChangeListInput,
  options: ListOptions = {},
): Promise<ChangeList> {
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const page = input.page ?? 1;
  const offset = (page - 1) * pageSize;
  const read = await collect(context, input, options, offset + pageSize);
  const wanted = mergeNewestFirst(read.shown, offset + pageSize).slice(offset);
  // How each entry on the page was decided is read for this page only.
  const reviewed = await annotateFromReview(
    context,
    wanted.map((candidate) => candidate.build()),
    read.store,
  );
  const sources = [...read.sources];
  sources.splice(1, 0, {
    name: "review",
    title: SOURCE_TITLES.review,
    read: reviewed.outcome.read,
    reason: reviewed.outcome.reason,
    changes: reviewed.outcome.annotated,
  });
  return {
    revision: read.pin.toString(),
    asOf: read.asOf,
    window: {
      since: read.resolved.since,
      sinceRevision: read.resolved.afterRevision.toString(),
      sinceAt: read.resolved.sinceAt,
      until: read.resolved.until,
    },
    count: read.count,
    page,
    pageSize,
    changes: [...reviewed.records],
    actors: read.actors,
    sources,
    notCovered: [...NOT_COVERED],
    attribution: read.changes.attribution(),
    lastReview: read.review === null ? null : reviewOf(read.review),
    caller: callerOf(context),
  };
}

/** Who is asking, named as a change they make would name them. */
const callerOf = (context: SliceContext): ChangeActor =>
  actorOf(describePrincipal(context.access.principal), labelOf(context.access.principal));

/** The sources the caller did not read in full: ones that could not be read, and ones a part of which is
 * not theirs to see. Either way the list is not all there is. */
export async function unreadSources(context: SliceContext): Promise<readonly ChangeSourceStatus[]> {
  const read = await collect(context, { since: "lastReview", pageSize: 1 }, {}, 0);
  return read.sources.filter((source) => !source.read || (source.withheld ?? null) !== null);
}

/** Every change that matches, newest first, with what was read and how far back makers are known: for a
 * file that lists them all (the accountant pack). Entries are not told how they were decided here: the
 * pack's journal file says that for every entry. */
export async function collectChanges(
  context: SliceContext,
  input: ChangeListInput,
  options: ListOptions = {},
): Promise<{
  readonly changes: readonly ChangeRecord[];
  readonly sources: readonly ChangeSourceStatus[];
  readonly attribution: ChangeList["attribution"];
  readonly revision: string;
  readonly asOf: string;
}> {
  const read = await collect(context, input, options, "all");
  return {
    changes: mergeNewestFirst(read.shown, read.count).map((candidate) => candidate.build()),
    sources: read.sources,
    attribution: read.changes.attribution(),
    revision: read.pin.toString(),
    asOf: read.asOf,
  };
}

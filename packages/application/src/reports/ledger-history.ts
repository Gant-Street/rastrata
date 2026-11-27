import {
  contentHashEquals,
  latestRevisionRecord,
  type BookConfigurationSnapshot,
  type BookedJournal,
  type BookState,
  type ContentHash,
  type CorrectionLink,
  type RevisionRecord,
} from "@rastrata/kernel";

/** Where a book stands in its hash chain: the revision it has reached and that revision's chain hash.
 * The chain hash commits to every revision before it, so two states that are at the same position
 * have the same history, and a state whose next revision names this position as its previous hash is
 * this history carried on. That is what lets a view built for one state be extended to the next. */
export interface Position {
  readonly revision: bigint;
  readonly chainHash: ContentHash | null;
}

/** The most revisions one extension will replay. An extension costs about 40 microseconds a revision
 * (the kernel's checks on it) and no more than building the view again would for the same ones, so this
 * only bounds what one read does at a time: a bulk import of a thousand lines between two reports is
 * still carried forward, and a read of a state a great many commands later starts over. */
export const MAX_EXTENSION = 1024;

export function positionOf(state: BookState): Position {
  const last = latestRevisionRecord(state);
  return last
    ? { revision: last.bookRevision, chainHash: last.chainHash }
    : { revision: 0n, chainHash: null };
}

const sameHash = (left: ContentHash | null, right: ContentHash | null): boolean =>
  left === null || right === null ? left === right : contentHashEquals(left, right);

/** The revisions that took a book from `base` to `state`, in order, or null when `state` is not that
 * history carried on: another history, an earlier revision, or more revisions than an extension will
 * replay. An empty list means `state` is at `base`. The test reads each new revision's link to the
 * one before it, so it costs a few comparisons for a state one command on, and one copy of the
 * revision list (which a state the kernel built makes once, the first time it is read) for a state
 * several commands on. */
export function revisionsAfter(state: BookState, base: Position): readonly RevisionRecord[] | null {
  const last = latestRevisionRecord(state);
  const tip = last?.bookRevision ?? 0n;
  if (state.bookRevision !== tip || tip < base.revision) return null;
  if (tip === base.revision)
    return sameHash(positionOf(state).chainHash, base.chainHash) ? [] : null;
  const count = tip - base.revision;
  if (count > BigInt(MAX_EXTENSION) || last === undefined) return null;
  const added = count === 1n ? [last] : state.revisions.slice(Number(base.revision));
  let previous = base.chainHash;
  let expected = base.revision + 1n;
  for (const revision of added) {
    if (revision.bookRevision !== expected || !sameHash(revision.previousHash, previous))
      return null;
    previous = revision.chainHash;
    expected += 1n;
  }
  return expected === tip + 1n && added.at(-1) === last ? added : null;
}

/** One configuration change, as the book's history records it. */
export interface ConfigurationStep {
  /** The date from which the change applies (a date, not an instant). */
  readonly effectiveOn: string;
  readonly snapshot: BookConfigurationSnapshot;
}

/** Every configuration change in these revisions, in the order the book made them. */
export function configurationsOf(
  revisions: readonly RevisionRecord[],
): readonly ConfigurationStep[] {
  const steps: ConfigurationStep[] = [];
  for (const revision of revisions)
    for (const effect of revision.effects)
      if (effect.type === "configuration")
        steps.push({
          effectiveOn: effect.effectiveOn,
          snapshot: effect.resultingConfigurationSnapshot,
        });
  return steps;
}

/** The chart in force on a date: the latest configuration change that took effect on or before it, in
 * the order the book made them, or the book's first configuration when none had. */
export function chartIn(
  steps: readonly ConfigurationStep[],
  state: Pick<BookState, "configurationSnapshots" | "activeConfigurationSnapshot">,
  asOf: string,
): BookConfigurationSnapshot {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index] as ConfigurationStep;
    if (step.effectiveOn <= asOf) return step.snapshot;
  }
  return state.configurationSnapshots[0] ?? state.activeConfigurationSnapshot;
}

/** What a run of revisions added to the lists the report views are built from. */
export interface Delta {
  readonly journals: readonly BookedJournal[];
  readonly links: readonly CorrectionLink[];
  readonly configurations: readonly ConfigurationStep[];
}

/** The journals, corrections and configuration changes of these revisions, in the order they
 * happened. A state's `journals` and `corrections` are exactly these effects in order (the kernel
 * rebuilds them from the effects when it loads a book), so the lists of a state one revision on are
 * the lists before it and this. */
export function deltaOf(revisions: readonly RevisionRecord[]): Delta {
  const journals: BookedJournal[] = [];
  const corrections: CorrectionLink[] = [];
  for (const revision of revisions)
    for (const effect of revision.effects) {
      if (effect.type === "journal") journals.push(effect.booked);
      else if (effect.type === "correction") corrections.push(effect.link);
    }
  return { journals, links: corrections, configurations: configurationsOf(revisions) };
}

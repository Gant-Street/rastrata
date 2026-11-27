import {
  ExactRational,
  canonicalBookEffectValue,
  canonicalJournalValue,
  contentHashEquals,
  hashCanonical,
  rebuildAccountBalanceProjection,
  type BookState,
  type BookedJournal,
  type ContentHash,
  type RevisionRecord,
} from "@rastrata/kernel";
import { positionOf } from "./ledger-history.ts";

/** The kernel's balance of every account at the end of a run of revisions, with the place in the hash
 * chain it stands at. It is what a report's book-wide totals are compared with. */
export interface BalanceProjection {
  readonly revision: bigint;
  readonly chainHash: ContentHash | null;
  /** The posting sequence of the last journal, so the next one must carry this plus one. */
  readonly postingSequence: bigint;
  /** In the order the kernel reports them: the order accounts were first posted to. */
  readonly balances: ReadonlyMap<string, ExactRational>;
}

/** How the kernel's balances were come by in this process. It carries no accounting meaning; a test or a
 * bench reads it to say that a path did not start over. */
const made = { rebuilt: 0, tracked: 0 };

/** The number of times the kernel's full rebuild has run (`projectionFromHistory`), and the number of
 * revisions that tracks have folded into a projection as a ledger was replayed. */
export function projectionCounts(): Readonly<typeof made> {
  return { ...made };
}

/** The kernel's own rebuild from every revision of a book, which re-checks each revision's hashes
 * and links: linear in the history and the slow way (about 35 microseconds a revision). Null when
 * the kernel refuses the history. It runs for a full verification and, for a state nobody carried the
 * balances to, the first time a report needs them. */
export function projectionFromHistory(
  revisions: readonly RevisionRecord[],
): BalanceProjection | null {
  made.rebuilt += 1;
  const rebuilt = rebuildAccountBalanceProjection(revisions);
  if (rebuilt.disposition !== "rebuilt") return null;
  const { checkpoint } = rebuilt;
  return {
    revision: checkpoint.throughBookRevision,
    chainHash: checkpoint.sourceRevisionHash,
    postingSequence: checkpoint.throughPostingSequence,
    balances: new Map(
      checkpoint.accountBalances.map((row) => [row.accountId as string, row.balance]),
    ),
  };
}

const hashValue = (hash: ContentHash | null) =>
  hash === null
    ? null
    : {
        algorithm: hash.algorithm,
        canonicalizationVersion: hash.canonicalizationVersion,
        digest: hash.digest,
      };

/** What `extendProjection` works out again of each revision it is given.
 *
 * - "all": everything the kernel's rebuild checks: the revision's number and its link to the one before,
 *   its effects hash and chain hash, each journal's canonical hash, and the gap-free posting sequence. For
 *   revisions nobody has checked in this process (a snapshot's, a preview's).
 * - "applied": the number, the link and the posting sequence, and not the hashes. For revisions that the
 *   kernel has just made by running the command and that a replay has compared, byte for byte, with the
 *   ledger's record of that command (the revision, its hashes and its journals are part of what is
 *   compared): computing the hashes a second time would prove less than that comparison does, and cost
 *   five times what the rest of the extension does. A trusted replay (`ReplayMode` in service.ts) applies
 *   the ledger's revisions without making that comparison and uses the same checks: it trusts the
 *   stored hashes, and a full verification is what re-derives them. */
export type RevisionChecks = "all" | "applied";

/** The projection after more revisions, worked out the way the kernel's rebuild works out each
 * revision (the same checks of numbering, links, hashes and posting sequence, and the same arithmetic:
 * a journal adds its postings, a superseding correction takes the original's away) but only for the
 * revisions given, starting from a projection the kernel or an earlier extension already vouched for.
 * That makes a report after one more posting cost that posting and not the whole history. Null when
 * anything about the new revisions does not hold; the caller then falls back to the kernel's rebuild,
 * which is the authority. `find` looks a journal up among those before these revisions. */
export function extendProjection(
  base: BalanceProjection,
  revisions: readonly RevisionRecord[],
  find: (journalId: string) => BookedJournal | undefined,
  checks: RevisionChecks = "all",
): BalanceProjection | null {
  const balances = new Map(base.balances);
  const added = new Map<string, BookedJournal>();
  let previous = base.chainHash;
  let expectedRevision = base.revision + 1n;
  let expectedSequence = base.postingSequence + 1n;
  for (const revision of revisions) {
    if (
      revision.bookRevision !== expectedRevision ||
      (revision.previousHash === null) !== (previous === null) ||
      (revision.previousHash !== null &&
        previous !== null &&
        !contentHashEquals(revision.previousHash, previous))
    )
      return null;
    if (checks === "all") {
      const effectsHash = hashCanonical({
        type: "RevisionEffects",
        effects: revision.effects.map(canonicalBookEffectValue),
      });
      const chainHash = hashCanonical({
        type: "RevisionChain",
        bookId: revision.bookId,
        revision: revision.bookRevision,
        previousHash: hashValue(previous),
        effectsHash: hashValue(effectsHash),
      });
      if (
        !contentHashEquals(revision.effectsHash, effectsHash) ||
        !contentHashEquals(revision.chainHash, chainHash)
      )
        return null;
    }
    for (const effect of revision.effects) {
      if (effect.type === "correction") {
        const original =
          added.get(effect.link.originalJournalId) ?? find(effect.link.originalJournalId);
        const correction =
          added.get(effect.link.correctionJournalId) ?? find(effect.link.correctionJournalId);
        if (original === undefined || correction === undefined) return null;
        if (effect.link.kind === "supersession")
          for (const posting of original.journal.postings) {
            const current = balances.get(posting.accountId);
            if (current === undefined) continue;
            balances.set(
              posting.accountId,
              current.subtract(posting.bookValue.amount.toRational()),
            );
          }
        continue;
      }
      if (effect.type !== "journal") continue;
      if (
        (checks === "all" &&
          !contentHashEquals(
            effect.booked.canonicalHash,
            hashCanonical(canonicalJournalValue(effect.booked.journal)),
          )) ||
        effect.booked.postingSequence !== expectedSequence
      )
        return null;
      added.set(effect.booked.journal.id, effect.booked);
      expectedSequence += 1n;
      for (const posting of effect.booked.journal.postings)
        balances.set(
          posting.accountId,
          (balances.get(posting.accountId) ?? ExactRational.zero()).add(
            posting.bookValue.amount.toRational(),
          ),
        );
    }
    previous = revision.chainHash;
    expectedRevision += 1n;
  }
  return {
    revision: expectedRevision - 1n,
    chainHash: previous,
    postingSequence: expectedSequence - 1n,
    balances,
  };
}

/** The kernel's balances of a book, worked out one revision at a time by whoever is applying the revisions
 * anyway: a service replaying its ledger folds each revision it applies into a track, so by the time the
 * book is read the balances a report is compared with are already known, and no report has to go back
 * over the whole history to find them (700 to 900 ms at 20,000 journals, all at once).
 *
 * A track is a value: `advance` gives the track after more revisions and leaves this one as it was. It
 * checks each revision as `extendProjection` does (see `RevisionChecks` for what that is for revisions a
 * replay has just compared with the ledger's record and for those it has not), so a revision that does not
 * hold ends the track (null) and the balances are rebuilt from the history by the kernel instead, which is
 * the authority. The tracks of one history share the table of journals that corrections look their
 * originals up in; it only grows, and it is meant for one history (a ledger's), never for previews that
 * branch. */
export class ProjectionTrack {
  private constructor(
    readonly projection: BalanceProjection,
    private readonly journals: Map<string, BookedJournal>,
  ) {}

  /** The track of a book that has no revisions yet. */
  static start(): ProjectionTrack {
    return new ProjectionTrack(
      { revision: 0n, chainHash: null, postingSequence: 0n, balances: new Map() },
      new Map(),
    );
  }

  /** The track after these revisions, or null when they do not follow this track's history or do not
   * hold. */
  advance(
    revisions: readonly RevisionRecord[],
    checks: RevisionChecks = "all",
  ): ProjectionTrack | null {
    if (revisions.length === 0) return this;
    const next = extendProjection(
      this.projection,
      revisions,
      (id) => this.journals.get(id),
      checks,
    );
    if (next === null) return null;
    for (const revision of revisions)
      for (const effect of revision.effects)
        if (effect.type === "journal") this.journals.set(effect.booked.journal.id, effect.booked);
    made.tracked += revisions.length;
    return new ProjectionTrack(next, this.journals);
  }
}

const sameChain = (left: ContentHash | null, right: ContentHash | null): boolean =>
  left === null || right === null ? left === right : contentHashEquals(left, right);

/** The projections that a reader of the ledger has carried to a state and stands behind, by the state
 * (the object the kernel built), so that the report views of exactly that state need not ask the kernel
 * for them. */
const vouched = new WeakMap<BookState, BalanceProjection>();

/** Record that `projection` is the kernel's balances for exactly this state. Refused (false) when it is
 * not at the state's place in the hash chain or its posting sequence, so a projection that was carried to
 * another state can never be taken for this one's. */
export function vouchProjection(state: BookState, projection: BalanceProjection): boolean {
  const at = positionOf(state);
  if (
    projection.revision !== at.revision ||
    projection.postingSequence !== state.latestPostingSequence ||
    !sameChain(projection.chainHash, at.chainHash)
  )
    return false;
  vouched.set(state, projection);
  return true;
}

/** The balances carried to this state by a replay, if one did. */
export function vouchedProjection(state: BookState): BalanceProjection | undefined {
  return vouched.get(state);
}

/** What the kernel's own rebuild of a state's history says differently from a projection that was carried
 * to it, in words, or null when they agree: the same place in the hash chain, the same posting sequence
 * and exactly the same balance on every account. This is the independent check, the whole history
 * re-checked by the kernel's function, and it costs what the kernel's rebuild costs. */
export function projectionDisagreement(
  state: BookState,
  carried: BalanceProjection | null,
): string | null {
  const rebuilt = projectionFromHistory(state.revisions);
  if (rebuilt === null) return "the kernel refuses the history of the book";
  if (carried === null) return "the balances were not carried through the replay";
  if (carried.revision !== rebuilt.revision) return "they stop at different revisions";
  if (carried.postingSequence !== rebuilt.postingSequence)
    return "they have a different number of journals";
  if (!sameChain(carried.chainHash, rebuilt.chainHash)) return "they stand at different hashes";
  if (carried.balances.size !== rebuilt.balances.size) return "they hold different accounts";
  for (const [account, balance] of rebuilt.balances) {
    const mine = carried.balances.get(account);
    if (
      mine === undefined ||
      mine.numerator * balance.denominator !== balance.numerator * mine.denominator
    )
      return `account ${account} has a different balance`;
  }
  return null;
}

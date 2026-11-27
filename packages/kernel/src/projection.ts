import {
  compareCanonicalText,
  contentHashEquals,
  hashCanonical,
  type CanonicalValue,
  type ContentHash,
} from "./canonical.ts";
import type { AccountId, CommodityId, SemanticDiagnostic } from "./journal.ts";
import { canonicalJournalValue, diagnostic } from "./journal.ts";
import { canonicalBookEffectValue, type BookedJournal, type RevisionRecord } from "./book.ts";
import { ExactRational } from "./numeric.ts";

export interface AccountBalanceProjection {
  readonly accountId: AccountId;
  readonly functionalCommodityId: CommodityId;
  readonly balance: ExactRational;
}

export interface ProjectionCheckpoint {
  readonly throughBookRevision: bigint;
  readonly throughPostingSequence: bigint;
  readonly sourceRevisionHash: ContentHash | null;
  readonly accountBalances: readonly AccountBalanceProjection[];
  readonly contentHash: ContentHash;
}

export type ProjectionResult =
  | { readonly disposition: "rebuilt"; readonly checkpoint: ProjectionCheckpoint }
  | { readonly disposition: "rejected"; readonly diagnostics: readonly SemanticDiagnostic[] };

function hashValue(hash: ContentHash | null): CanonicalValue {
  return hash === null
    ? null
    : {
        algorithm: hash.algorithm,
        canonicalizationVersion: hash.canonicalizationVersion,
        digest: hash.digest,
      };
}

function checkpointHash(
  revision: bigint,
  sequence: bigint,
  revisionHash: ContentHash | null,
  balances: readonly AccountBalanceProjection[],
): ContentHash {
  return hashCanonical({
    type: "AccountBalanceProjectionCheckpoint",
    throughBookRevision: revision,
    throughPostingSequence: sequence,
    sourceRevisionHash: hashValue(revisionHash),
    accountBalances: [...balances]
      .sort((left, right) => compareCanonicalText(left.accountId, right.accountId))
      .map((entry) => ({
        accountId: entry.accountId,
        functionalCommodityId: entry.functionalCommodityId,
        balance: {
          numerator: entry.balance.numerator,
          denominator: entry.balance.denominator,
        },
      })),
  });
}

export function rebuildAccountBalanceProjection(
  revisions: readonly RevisionRecord[],
): ProjectionResult {
  const balances = new Map<string, AccountBalanceProjection>();
  const journals = new Map<string, BookedJournal>();
  let previousHash: ContentHash | null = null;
  let expectedRevision = 1n;
  let expectedPostingSequence = 1n;

  for (const [index, revision] of revisions.entries()) {
    const recomputedEffectsHash = hashCanonical({
      type: "RevisionEffects",
      effects: revision.effects.map(canonicalBookEffectValue),
    });
    const recomputedChainHash = hashCanonical({
      type: "RevisionChain",
      bookId: revision.bookId,
      revision: revision.bookRevision,
      previousHash: hashValue(previousHash),
      effectsHash: hashValue(recomputedEffectsHash),
    });
    if (
      revision.bookRevision !== expectedRevision ||
      (revision.previousHash === null) !== (previousHash === null) ||
      (revision.previousHash !== null && previousHash !== null && !contentHashEquals(revision.previousHash, previousHash)) ||
      !contentHashEquals(revision.effectsHash, recomputedEffectsHash) ||
      !contentHashEquals(revision.chainHash, recomputedChainHash)
    ) {
      return Object.freeze({
        disposition: "rejected",
        diagnostics: Object.freeze([
          diagnostic(
            "projection_rebuild_mismatch",
            `revisions[${index}]`,
            "Revision chain is not contiguous or does not link to the previous canonical hash",
            ["ACC-031", "ACC-034"],
          ),
        ]),
      });
    }
    for (const effect of revision.effects) {
      if (effect.type === "correction") {
        const original = journals.get(effect.link.originalJournalId);
        const correction = journals.get(effect.link.correctionJournalId);
        if (original === undefined || correction === undefined) {
          return Object.freeze({
            disposition: "rejected",
            diagnostics: Object.freeze([
              diagnostic(
                "projection_rebuild_mismatch",
                `revisions[${index}].effects`,
                "Correction lineage does not resolve both immutable journals",
                ["ACC-004", "ACC-034", "ACC-038"],
              ),
            ]),
          });
        }
        if (effect.link.kind === "supersession") {
          for (const posting of original.journal.postings) {
            const current = balances.get(posting.accountId);
            if (current === undefined) continue;
            balances.set(
              posting.accountId,
              Object.freeze({
                ...current,
                balance: current.balance.subtract(posting.bookValue.amount.toRational()),
              }),
            );
          }
        }
        continue;
      }
      if (effect.type !== "journal") continue;
      if (!contentHashEquals(effect.booked.canonicalHash, hashCanonical(canonicalJournalValue(effect.booked.journal)))) {
        return Object.freeze({
          disposition: "rejected",
          diagnostics: Object.freeze([
            diagnostic(
              "projection_rebuild_mismatch",
              `revisions[${index}].effects`,
              "Booked journal content no longer matches its canonical hash",
              ["ACC-004", "ACC-018", "ACC-031", "ACC-034"],
            ),
          ]),
        });
      }
      journals.set(effect.booked.journal.id, effect.booked);
      if (effect.booked.postingSequence !== expectedPostingSequence) {
        return Object.freeze({
          disposition: "rejected",
          diagnostics: Object.freeze([
            diagnostic(
              "projection_rebuild_mismatch",
              `revisions[${index}].effects`,
              "Canonical journal posting sequence is not gap-free",
              ["ACC-031", "ACC-034"],
            ),
          ]),
        });
      }
      expectedPostingSequence += 1n;
      for (const posting of effect.booked.journal.postings) {
        const current = balances.get(posting.accountId);
        const amount = posting.bookValue.amount.toRational();
        balances.set(
          posting.accountId,
          Object.freeze({
            accountId: posting.accountId,
            functionalCommodityId: posting.bookValue.functionalCommodityId,
            balance: (current?.balance ?? ExactRational.zero()).add(amount),
          }),
        );
      }
    }
    previousHash = revision.chainHash;
    expectedRevision += 1n;
  }

  const accountBalances = Object.freeze([...balances.values()]);
  const throughBookRevision = expectedRevision - 1n;
  const throughPostingSequence = expectedPostingSequence - 1n;
  return Object.freeze({
    disposition: "rebuilt",
    checkpoint: Object.freeze({
      throughBookRevision,
      throughPostingSequence,
      sourceRevisionHash: previousHash,
      accountBalances,
      contentHash: checkpointHash(
        throughBookRevision,
        throughPostingSequence,
        previousHash,
        accountBalances,
      ),
    }),
  });
}

export function verifyProjectionCheckpoint(
  revisions: readonly RevisionRecord[],
  incremental: ProjectionCheckpoint,
): readonly SemanticDiagnostic[] {
  const rebuilt = rebuildAccountBalanceProjection(revisions);
  if (
    rebuilt.disposition === "rejected" ||
    !contentHashEquals(rebuilt.checkpoint.contentHash, incremental.contentHash) ||
    (rebuilt.checkpoint.sourceRevisionHash === null) !== (incremental.sourceRevisionHash === null) ||
    (rebuilt.checkpoint.sourceRevisionHash !== null && incremental.sourceRevisionHash !== null &&
      !contentHashEquals(rebuilt.checkpoint.sourceRevisionHash, incremental.sourceRevisionHash)) ||
    rebuilt.checkpoint.throughBookRevision !== incremental.throughBookRevision ||
    rebuilt.checkpoint.throughPostingSequence !== incremental.throughPostingSequence
  ) {
    return Object.freeze([
      diagnostic(
        "projection_rebuild_mismatch",
        "projection",
        "Incremental projection differs from a canonical rebuild at the same cutoff",
        ["ACC-034"],
      ),
    ]);
  }
  return Object.freeze([]);
}

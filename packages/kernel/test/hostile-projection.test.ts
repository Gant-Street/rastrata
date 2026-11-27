import { describe, expect, test } from "bun:test";
import {
  canonicalBookEffectValue,
  commandId,
  derivationId,
  evidenceId,
  executeBookCommand,
  hashCanonical,
  instant,
  rebuildAccountBalanceProjection,
  sealCommand,
  semanticVersion,
  verifyProjectionCheckpoint,
  type BookEffect,
  type BookState,
  type ContentHash,
  type RevisionRecord,
} from "../src/index.ts";
import { IDS, freshState, journal, policy, resolved } from "./fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";

function hashValue(hash: ContentHash | null) {
  return hash === null ? null : { algorithm: hash.algorithm, canonicalizationVersion: hash.canonicalizationVersion, digest: hash.digest };
}

function rehash(revisions: readonly RevisionRecord[], mutate: (effects: readonly BookEffect[], index: number) => readonly BookEffect[]): readonly RevisionRecord[] {
  let previous: ContentHash | null = null;
  return revisions.map((revision, index) => {
    const effects = mutate(revision.effects, index);
    const effectsHash = hashCanonical({ type: "RevisionEffects", effects: effects.map(canonicalBookEffectValue) });
    const chainHash = hashCanonical({ type: "RevisionChain", bookId: revision.bookId, revision: revision.bookRevision,
      previousHash: hashValue(previous), effectsHash: hashValue(effectsHash) });
    const result = Object.freeze({ ...revision, previousHash: previous, effects, effectsHash, chainHash });
    previous = chainHash;
    return result;
  });
}

function post(state: BookState, id: string, journalName: string) {
  return sealCommand({ id: commandId(id), type: "postJournal", protocolVersion: semanticVersion("1.0.0"),
    bookId: IDS.book, expectedBookRevision: state.bookRevision,
    issuedAt: instant("2026-01-15T14:00:00Z"), completedAt: instant("2026-01-15T14:00:01Z"), committedAt: instant("2026-01-15T14:00:02Z"),
    actorId: IDS.actor, resolved: resolved(journal(journalName)) });
}

describe("hostile projection rebuild", () => {
  test("rejects forged hash fields even when the stored aggregate hash is left untouched", () => {
    const fresh = freshState();
    const activated = executeBookCommand(fresh.state, fresh.protocol, activationCommand("hash-field-activation"));
    const current = executeBookCommand(activated.state, activated.protocol, post(activated.state, "hash-field-post", "hash-field-journal"));
    expect(current.result.disposition).toBe("committed");
    const rebuilt = rebuildAccountBalanceProjection(current.state.revisions);
    expect(rebuilt.disposition).toBe("rebuilt");
    if (rebuilt.disposition !== "rebuilt") throw new Error("Canonical history did not rebuild");
    const forged = hashCanonical({ forged: "hash field only" });
    const detachedHistory = current.state.revisions.map((revision, i) => i === 1 ? { ...revision, previousHash: forged } : revision);
    // Keep the valid chainHash: comparing it to a reconstruction from the
    // expected predecessor does not authenticate the supplied previousHash.
    const result = rebuildAccountBalanceProjection(detachedHistory);
    expect(result.disposition).toBe("rejected");
    if (result.disposition !== "rejected") throw new Error("Detached predecessor admitted");
    expect(result.diagnostics[0]!.code).toBe("projection_rebuild_mismatch");
    expect(verifyProjectionCheckpoint(current.state.revisions, { ...rebuilt.checkpoint, sourceRevisionHash: forged }).map((d) => d.code)).toEqual(["projection_rebuild_mismatch"]);
    expect(verifyProjectionCheckpoint(current.state.revisions, rebuilt.checkpoint)).toEqual([]);
  });

  test("rejects dangling correction, journal hash mutation, and posting-sequence gaps after a valid chain rehash", () => {
    const fresh = freshState();
    let current = executeBookCommand(fresh.state, fresh.protocol, activationCommand());
    current = executeBookCommand(current.state, current.protocol, post(current.state, "projection-post", "projection-source"));
    const journalEffect = current.state.revisions[1]!.effects.find((effect) => effect.type === "journal")!;
    if (journalEffect.type !== "journal") throw new Error("fixture journal missing");

    const dangling = rehash(current.state.revisions, (effects, index) => index === 1
      ? [...effects, { type: "correction", link: { kind: "supersession", originalJournalId: "missing", correctionJournalId: "also-missing" } }]
      : effects);
    expect(rebuildAccountBalanceProjection(dangling).disposition).toBe("rejected");

    const badHash = rehash(current.state.revisions, (effects, index) => index === 1
      ? effects.map((effect) => effect.type === "journal" ? { ...effect, booked: { ...effect.booked, canonicalHash: hashCanonical({ wrong: true }) } } : effect)
      : effects);
    expect(rebuildAccountBalanceProjection(badHash).disposition).toBe("rejected");

    const badSequence = rehash(current.state.revisions, (effects, index) => index === 1
      ? effects.map((effect) => effect.type === "journal" ? { ...effect, booked: { ...effect.booked, postingSequence: 9n } } : effect)
      : effects);
    expect(rebuildAccountBalanceProjection(badSequence).disposition).toBe("rejected");
  });

  test("rebuilds a supersession by removing the original presentation", () => {
    const fresh = freshState();
    let current = executeBookCommand(fresh.state, fresh.protocol, activationCommand("projection-activate"));
    current = executeBookCommand(current.state, current.protocol, post(current.state, "projection-original-command", "projection-original"));
    const original = current.state.journals[0]!;
    const replacement = resolved(journal("projection-replacement"));
    const withLineage = Object.freeze({ ...replacement, derivations: Object.freeze([Object.freeze({
      id: derivationId("projection-supersession"), policyId: policy.id, policyVersion: policy.version,
      algorithmVersion: semanticVersion("1.0.0"), inputHash: original.canonicalHash, actorId: IDS.actor, state: "approved" as const,
      recordedAt: instant("2026-01-16T13:00:00Z"), evidence: Object.freeze([Object.freeze({
        id: evidenceId("projection-supersession-evidence"), sourceSystem: "test", sourceRecordId: original.journal.id,
        observedAt: instant("2026-01-16T12:00:00Z"), contentHash: original.canonicalHash,
      })]),
    })]) });
    current = executeBookCommand(current.state, current.protocol, sealCommand({
      id: commandId("projection-correct"), type: "correctJournal", protocolVersion: semanticVersion("1.0.0"), bookId: IDS.book,
      expectedBookRevision: current.state.bookRevision,
      issuedAt: instant("2026-01-16T14:00:00Z"), completedAt: instant("2026-01-16T14:00:01Z"), committedAt: instant("2026-01-16T14:00:02Z"),
      actorId: IDS.actor, correctionKind: "supersession", originalJournalId: original.journal.id, resolved: withLineage,
    }));
    const rebuilt = rebuildAccountBalanceProjection(current.state.revisions);
    expect(rebuilt.disposition).toBe("rebuilt");
    if (rebuilt.disposition === "rebuilt") {
      expect(rebuilt.checkpoint.accountBalances.find((balance) => balance.accountId === IDS.cash)?.balance.equals(
        replacement.journal.postings[0]!.bookValue.amount.toRational(),
      )).toBeTrue();
      expect(verifyProjectionCheckpoint(current.state.revisions, { ...rebuilt.checkpoint, sourceRevisionHash: null })).toHaveLength(1);
    }
  });
});

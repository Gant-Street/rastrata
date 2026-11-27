import { describe, expect, test } from "bun:test";
import {
  CHAIN_HEAD_STATE_COMMITMENT_PROFILE,
  ExactDecimal,
  ExactRational,
  STRUCTURAL_SOURCE_IDENTITY_PROFILE,
  assertBookCommandShape,
  canonicalPostingReferenceId,
  commandId,
  commitBookIntent,
  createBookState,
  createCanonicalPostingReference,
  decodeBookRow,
  decodeDurableBook,
  derivationId,
  effectKey,
  encodeBookRow,
  encodeBookStateHeader,
  encodeDurableBook,
  evaluateBookCommand,
  evaluateBookCommandAdmission,
  evidenceId,
  executeBookCommand,
  hashBookConfigurationSnapshot,
  hashBookState,
  hashCanonical,
  instant,
  journalId,
  localDate,
  lotAllocationId,
  lotHoldingId,
  lotId,
  openItemId,
  postingId,
  sealCommand,
  semanticVersion,
  settlementId,
  validateBookEffectTopology,
  validateBookState,
  type AtomicBookCommit,
  type BookCommand,
  type BookProtocolState,
  type BookConfigurationSnapshot,
  type BookState,
  type BookedJournal,
  type ContentHash,
  type JournalTransaction,
} from "../src/index.ts";
import { snapshotVerifications } from "../src/verified-snapshots.ts";
import { accountingDerivation } from "./accounting-fixtures.ts";
import { IDS, closePackageId, freshState, journal, reportHash, reportPolicyHash, resolved } from "./fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";

const PROFILE = CHAIN_HEAD_STATE_COMMITMENT_PROFILE;
const version = semanticVersion("1.0.0");

// ---------------------------------------------------------------- fixtures

interface Book {
  readonly state: BookState;
  readonly protocol: BookProtocolState;
}

/** The standard fixture book, created with the commitment profile or without it. */
function genesis(options: { readonly commitment?: boolean; readonly structural?: boolean } = {}): Book {
  const base = freshState();
  const c = base.state.activeConfigurationSnapshot;
  return {
    protocol: base.protocol,
    state: createBookState(base.state.identity, c.periods, c.admissionSnapshot, c.policies, c.quantizationPolicies,
      c.accountingPolicySnapshot.policies, c.effectiveAt,
      options.structural === true ? STRUCTURAL_SOURCE_IDENTITY_PROFILE : undefined,
      options.commitment === true ? PROFILE : undefined),
  };
}

function genesisWith(profile: string | undefined): BookState {
  const base = freshState();
  const c = base.state.activeConfigurationSnapshot;
  return createBookState(base.state.identity, c.periods, c.admissionSnapshot, c.policies, c.quantizationPolicies,
    c.accountingPolicySnapshot.policies, c.effectiveAt, undefined, profile as never);
}

function times(issued: string) {
  const millis = Date.parse(issued);
  return { issuedAt: instant(issued), completedAt: instant(new Date(millis + 1_000).toISOString()), committedAt: instant(new Date(millis + 2_000).toISOString()) };
}

function core(state: BookState, id: string, issued: string) {
  return { id: commandId(id), protocolVersion: version, bookId: IDS.book, expectedBookRevision: state.bookRevision, ...times(issued), actorId: IDS.actor };
}

function post(state: BookState, id: string, date = "2026-01-15", name = id): BookCommand {
  return sealCommand({ ...core(state, id, `${date}T14:00:00Z`), type: "postJournal" as const, resolved: resolved(journal(name, date)) });
}

function configure(state: BookState, id: string, issued: string, effectiveOn: string): BookCommand {
  return sealCommand({ ...core(state, id, issued), type: "replaceConfiguration" as const,
    expectedConfigurationRevision: state.configurationRevision, effectiveOn: localDate(effectiveOn),
    periods: state.periods, admissionSnapshot: state.admissionSnapshot, policies: state.policies,
    quantizationPolicies: state.quantizationPolicies, accountingPolicies: state.accountingPolicySnapshot.policies });
}

function close(state: BookState, id: string, issued: string): BookCommand {
  return sealCommand({ ...core(state, id, issued), type: "closePeriod" as const, periodId: IDS.period1,
    closePackageId: closePackageId(`${id}-package`), reason: "Reviewed", reportPopulationHash: reportHash, reportingPolicySnapshotHash: reportPolicyHash });
}

function reopen(state: BookState, id: string, issued: string): BookCommand {
  return sealCommand({ ...core(state, id, issued), type: "reopenPeriod" as const, periodId: IDS.period1, reason: "Correction needed" });
}

/** An exact reversal of a journal this book already holds. */
function reverse(state: BookState, id: string, original: BookedJournal, date: string): BookCommand {
  const reversal = resolved(journal(`${id}-journal`, date, "reversing", true));
  const lineage = Object.freeze({
    ...reversal,
    derivations: Object.freeze([Object.freeze({
      id: derivationId(`${id}-derivation`), policyId: state.policies[0]!.id, policyVersion: state.policies[0]!.version,
      algorithmVersion: version, inputHash: hashCanonical({ original: original.journal.id }), actorId: IDS.actor,
      state: "approved" as const, recordedAt: instant(`${date}T13:00:00Z`),
      evidence: Object.freeze([Object.freeze({ id: evidenceId(`${id}-evidence`), sourceSystem: "manual-review",
        sourceRecordId: original.journal.id, observedAt: instant(`${date}T12:30:00Z`), contentHash: original.canonicalHash })]),
    })]),
  });
  return sealCommand({ ...core(state, id, `${date}T14:00:00Z`), type: "correctJournal" as const, correctionKind: "reversal" as const,
    originalJournalId: original.journal.id, resolved: lineage });
}

function run(current: Book, command: BookCommand): AtomicBookCommit {
  const next = executeBookCommand(current.state, current.protocol, command);
  expect(next.result.disposition, `${command.id}: ${JSON.stringify(next.result.diagnostics)}`).toBe("committed");
  return next;
}

/** Every kind of revision the fixture book can hold except lots and accounting effects: activation,
 * two configuration changes, journals, two corrections, a close, a reopen and a second close. */
function lifecycle(initial: Book): AtomicBookCommit[] {
  const steps: AtomicBookCommit[] = [];
  let current: Book = initial;
  const apply = (command: (state: BookState) => BookCommand) => {
    const next = run(current, command(current.state));
    steps.push(next);
    current = next;
  };
  apply(() => activationCommand());
  apply((state) => configure(state, "configure-one", "2026-01-02T00:00:00Z", "2026-01-02"));
  apply((state) => post(state, "post-a", "2026-01-15"));
  apply((state) => post(state, "post-b", "2026-01-16"));
  apply((state) => reverse(state, "reverse-a", state.journals[0]!, "2026-01-17"));
  apply((state) => reverse(state, "reverse-b", state.journals[1]!, "2026-01-18"));
  apply((state) => post(state, "post-c", "2026-02-10"));
  apply((state) => close(state, "close-one", "2026-02-11T00:00:00Z"));
  apply((state) => reopen(state, "reopen-one", "2026-02-12T00:00:00Z"));
  apply((state) => close(state, "close-two", "2026-02-13T00:00:00Z"));
  apply((state) => configure(state, "configure-two", "2026-02-14T00:00:00Z", "2026-03-01"));
  apply((state) => post(state, "post-d", "2026-02-20"));
  return steps;
}

function once<T>(make: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= make());
}
const profiledHistory = once(() => lifecycle(genesis({ commitment: true })));
const legacyHistory = once(() => lifecycle(genesis()));

const digestOf = (hash: ContentHash) => ({ algorithm: hash.algorithm, canonicalizationVersion: hash.canonicalizationVersion, digest: hash.digest });

/** The commitment, restated from its specification and independent of the implementation. */
function specifiedCommitment(state: BookState): ContentHash {
  const head = state.revisions.at(-1);
  return hashCanonical({
    type: "BookStateChainHeadCommitment",
    profile: "chain-head-state-commitment-v1",
    identityHash: digestOf(state.financialIdentityHash),
    status: state.status,
    bookRevision: state.bookRevision,
    latestPostingSequence: state.latestPostingSequence,
    configurationRevision: state.configurationRevision,
    configurationHash: digestOf(state.configurationHash),
    activeConfigurationSnapshotHash: digestOf(state.activeConfigurationSnapshot.contentHash),
    openingBoundaryHash: state.openingBoundary === undefined ? null : digestOf(state.openingBoundary.contentHash),
    revisionCount: BigInt(state.revisions.length),
    revisionChainHash: head === undefined ? null : digestOf(head.chainHash),
  });
}

/** Re-seal a deliberately damaged state, the way a careful forger would. For a book with the
 * commitment the seal does not depend on the damaged lists, which is the point of the tests. */
function resealed(state: BookState, damage: Partial<BookState>): BookState {
  const { contentHash: _old, ...rest } = { ...state, ...damage };
  return { ...rest, contentHash: hashBookState(rest) } as BookState;
}

function aggregateOf(book: Book): Book {
  return { state: book.state, protocol: book.protocol };
}

function roundTrip(book: Book): Book {
  const encoded = encodeDurableBook(aggregateOf(book));
  const decoded = decodeDurableBook(encoded);
  if (decoded.disposition !== "decoded") throw new Error(decoded.message);
  expect(encodeDurableBook(decoded.aggregate)).toBe(encoded);
  return decoded.aggregate;
}

function admissionOf(book: Book, command: BookCommand) {
  return evaluateBookCommandAdmission(book.state, book.protocol, command);
}

function rejectedAtAdmission(book: Book, command: BookCommand) {
  const outcome = evaluateBookCommand(book.state, book.protocol, command);
  if (outcome.disposition !== "finished") throw new Error("Expected a rejection at admission");
  return outcome;
}

// ------------------------------------------------------- a book without the profile

describe("a book without the commitment profile is exactly what it was", () => {
  test("keeps its configuration hash, state hashes, chain and encoded bytes", () => {
    const fresh = genesis();
    expect(fresh.state.contentHash.digest).toBe("c0f4c567eb997fe07749300fd911d396ccc1e3c72f169220d1d9ab3d801d0416");
    expect(fresh.state.configurationHash.digest).toBe("b49b13324bcc3925ee347f2d9ed5272d24c68a5205f459711f6550881c15c642");
    const active = run(fresh, activationCommand());
    expect(active.state.contentHash.digest).toBe("6ce770fae170f2d0f1c8e5fb328396aa807597083692609d020d0cb7530f8ce2");
    expect(active.state.revisions.at(-1)!.chainHash.digest).toBe("90eaaf181fb1035301a905962e4a382f207c4e9af37b0f391c95534d4f04ff11");
    expect(active.state.openingBoundary!.contentHash.digest).toBe("69625fbbc77699f70a239f0ef97eeded381fab67ea0a447be1c5afd3e0824f1f");
    const posted = run(active, post(active.state, "baseline-post", "2026-01-15", "baseline-journal"));
    expect(posted.state.contentHash.digest).toBe("949072293fcd96cae94f6a1a7cb5e6baea306fa6df0ea37b276361f4ce5eb156");
    expect(posted.state.revisions.at(-1)!.chainHash.digest).toBe("0cd109c58f412cd49be811ee1d9257138e0c9946d8d08e0ca883e4d012299c5d");
    const encoded = encodeDurableBook(aggregateOf(posted));
    expect(encoded).not.toContain("stateCommitmentProfile");
    expect(new Bun.CryptoHasher("sha256").update(encoded).digest("hex")).toBe("ae7bfc4820bfcca6863a0f1ce137576afa1cb0f38bbac63c4eb6fd361327140c");
    expect(Object.hasOwn(posted.state.activeConfigurationSnapshot, "stateCommitmentProfile")).toBeFalse();
  });

  test("still hashes its whole population: an altered journal list is rejected at admission", () => {
    const book = legacyHistory().at(-1)!;
    const altered = [...book.state.journals];
    altered[1] = { ...altered[1]!, journal: { ...altered[1]!.journal, narration: "altered" } };
    expect(hashBookState({ ...book.state, journals: altered })).not.toEqual(book.state.contentHash);
    const damaged = { ...book.state, journals: altered };
    const rejected = rejectedAtAdmission({ state: damaged, protocol: book.protocol }, post(damaged, "after-damage", "2026-02-21"));
    expect(rejected.result.diagnostics.map((item) => [item.path, item.message])).toEqual([
      ["state.contentHash", "Book state does not reproduce its complete canonical content hash"],
    ]);
  });
});

// ------------------------------------------------------- the commitment itself

describe("the chain-head commitment", () => {
  test("is selected at genesis, hash-bound by the configuration snapshot and absent from legacy bytes", () => {
    const legacy = genesis();
    const profiled = genesis({ commitment: true });
    expect(profiled.state.activeConfigurationSnapshot.stateCommitmentProfile).toBe(PROFILE);
    expect(PROFILE).toBe("chain-head-state-commitment-v1");
    expect(profiled.state.financialIdentityHash).toEqual(legacy.state.financialIdentityHash);
    expect(profiled.state.configurationHash).not.toEqual(legacy.state.configurationHash);
    expect(profiled.state.contentHash).toEqual(specifiedCommitment(profiled.state));
    const snapshot = profiled.state.activeConfigurationSnapshot;
    const { stateCommitmentProfile: _marker, ...unmarked } = snapshot;
    expect(hashBookConfigurationSnapshot(unmarked)).toEqual(legacy.state.activeConfigurationSnapshot.contentHash);
    expect(hashBookConfigurationSnapshot(snapshot)).toEqual(snapshot.contentHash);
    expect(snapshot.contentHash).not.toEqual(legacy.state.activeConfigurationSnapshot.contentHash);
    expect(() => genesisWith("unknown")).toThrow("Unsupported book state commitment profile");
    expect(() => genesisWith("")).toThrow("Unsupported book state commitment profile");
    expect(genesisWith(undefined).contentHash).toEqual(legacy.state.contentHash);
  });

  test("equals its specification at every step of a long history and never uses the legacy preimage", () => {
    const profiledSteps = profiledHistory();
    const legacySteps = legacyHistory();
    expect(profiledSteps).toHaveLength(legacySteps.length);
    for (const [index, step] of profiledSteps.entries()) {
      expect(step.state.contentHash, `step ${index}`).toEqual(specifiedCommitment(step.state));
      expect(hashBookState(step.state), `step ${index}`).toEqual(step.state.contentHash);
      expect(step.state.contentHash, `step ${index}`).not.toEqual(legacySteps[index]!.state.contentHash);
    }
    // The last state differs in every scalar the preimage names, so no field can be swapped for another unnoticed.
    const last = profiledSteps.at(-1)!.state;
    expect(new Set([last.bookRevision, last.latestPostingSequence, last.configurationRevision]).size).toBe(3);
    expect(last.status).toBe("open");
    expect(last.openingBoundary).toBeDefined();
  });

  test("reads only the scalars, the active snapshot, the boundary and the chain head", () => {
    const book = profiledHistory().at(-1)!;
    const poison = (name: string) => ({ get: () => { throw new Error(`the commitment read ${name}`); }, enumerable: true });
    const probe = { ...book.state };
    for (const name of ["journals", "corrections", "periodTransitions", "closePackages", "lots", "lotHoldings", "lotAllocations",
      "accountingState", "configurationSnapshots", "periods", "admissionSnapshot", "policies", "quantizationPolicies", "accountingPolicySnapshot"]) {
      Object.defineProperty(probe, name, poison(name));
    }
    expect(hashBookState(probe as BookState)).toEqual(book.state.contentHash);
  });

  test("pins its digest for a small fixed history", () => {
    const fresh = genesis({ commitment: true });
    expect(fresh.state.contentHash.digest).toBe("1dd3e24c6a3f0c6b6062f7bd1ae51ffd5859931bf285f8acc3583b3ddd9ebe90");
    const active = run(fresh, activationCommand());
    expect(active.state.contentHash.digest).toBe("15b3b57ddd3d1005c149fc40607b2cba0a7e1fae16a2d42cc8a34aa08963d7cb");
    const posted = run(active, post(active.state, "baseline-post", "2026-01-15", "baseline-journal"));
    expect(posted.state.contentHash.digest).toBe("c7bc4adb4c58d505eff18231cbd4c8b61580b73a4d57a7013758bacd9dd9698a");
  });
});

// ------------------------------------------------------- history, round trip and replay

describe("a book with the commitment through a whole history", () => {
  test("every state is valid, round-trips byte for byte and keeps its commitment", () => {
    const steps = profiledHistory();
    for (const [index, step] of steps.entries()) {
      expect(validateBookState(step.state), `step ${index}`).toEqual([]);
      const restored = roundTrip(step);
      expect(restored.state.contentHash, `step ${index}`).toEqual(step.state.contentHash);
      expect(restored.state, `step ${index}`).toEqual(step.state);
      expect(restored.state.activeConfigurationSnapshot.stateCommitmentProfile).toBe(PROFILE);
    }
    const last = steps.at(-1)!;
    expect(last.state.configurationSnapshots.map((snapshot) => snapshot.stateCommitmentProfile)).toEqual([PROFILE, PROFILE, PROFILE]);
    expect(last.state.corrections).toHaveLength(2);
    expect(last.state.closePackages).toHaveLength(2);
    expect(last.state.periodTransitions.map((transition) => transition.kind)).toEqual(["close", "reopen", "close"]);
    expect(last.state.openingBoundary?.configurationSnapshot.stateCommitmentProfile).toBe(PROFILE);
    expect(last.state.closePackages[0]?.configurationSnapshot.stateCommitmentProfile).toBe(PROFILE);
  });

  test("replaying the retained commands from genesis reproduces the final state exactly", () => {
    const last = profiledHistory().at(-1)!;
    let replay: Book = genesis({ commitment: true });
    for (const retained of last.protocol.retainedResults) {
      const next = executeBookCommand(replay.state, replay.protocol, retained.command);
      expect(next.result.disposition).toBe("committed");
      replay = next;
    }
    expect(replay.state).toEqual(last.state);
    expect(replay.protocol).toEqual(last.protocol);
    expect(replay.state.contentHash).toEqual(last.state.contentHash);
  });

  test("a retried command is replayed, also against a decoded state", () => {
    const last = profiledHistory().at(-1)!;
    const decoded = roundTrip(last);
    const original = last.protocol.retainedResults[3]!.command;
    for (const book of [last, decoded]) {
      const retry = executeBookCommand(book.state, book.protocol, original);
      expect(retry.result.disposition).toBe("replayed");
      expect(retry.state).toBe(book.state);
    }
  });

  test("a rejected command is retained without changing the state or its commitment", () => {
    const last = profiledHistory().at(-1)!;
    const stale = sealCommand({ ...post(last.state, "stale-post", "2026-02-21"), expectedBookRevision: 3n });
    const rejected = executeBookCommand(last.state, last.protocol, stale);
    expect(rejected.result.disposition).toBe("rejected");
    expect(rejected.result.diagnostics[0]?.code).toBe("stale_book_revision");
    expect(rejected.state.contentHash).toEqual(last.state.contentHash);
    expect(rejected.protocol.retainedResults).toHaveLength(last.protocol.retainedResults.length + 1);
    expect(roundTrip(rejected).state.contentHash).toEqual(last.state.contentHash);
  });

  test("the commitment of a state before any revision names no chain head", () => {
    const fresh = genesis({ commitment: true });
    expect(fresh.state.revisions).toHaveLength(0);
    expect(fresh.state.contentHash).toEqual(specifiedCommitment(fresh.state));
    expect(validateBookState(fresh.state)).toEqual([]);
    expect(roundTrip(fresh).state).toEqual(fresh.state);
    expect(hashBookState({ ...fresh.state, status: "open" })).not.toEqual(fresh.state.contentHash);
  });
});

// ------------------------------------------------------- the same commands on both kinds of book

describe("the same commands on a book with and without the commitment", () => {
  test("produce the same journals, effects and results; only values that embed a configuration or state hash differ", () => {
    const legacy = legacyHistory();
    const profiled = profiledHistory();
    for (const [index, left] of legacy.entries()) {
      const right = profiled[index]!;
      expect(right.result, `result ${index}`).toEqual(left.result);
      expect(right.state.status).toBe(left.state.status);
      expect(right.state.bookRevision).toBe(left.state.bookRevision);
      expect(right.state.latestPostingSequence).toBe(left.state.latestPostingSequence);
      expect(right.state.configurationRevision).toBe(left.state.configurationRevision);
      expect(right.state.journals).toEqual(left.state.journals);
      expect(right.state.corrections).toEqual(left.state.corrections);
      expect(right.state.periodTransitions).toEqual(left.state.periodTransitions);
      expect(right.state.accountingState).toEqual(left.state.accountingState);
      expect(right.state.lots).toEqual(left.state.lots);
      expect(right.state.lotHoldings).toEqual(left.state.lotHoldings);
      expect(right.state.periods).toEqual(left.state.periods);
      expect(right.state.admissionSnapshot).toEqual(left.state.admissionSnapshot);
      expect(right.state.policies).toEqual(left.state.policies);
      expect(right.state.revisions.map((revision) => revision.command)).toEqual(left.state.revisions.map((revision) => revision.command));
      expect(right.state.revisions.map((revision) => revision.effects.map((effect) => effect.type)))
        .toEqual(left.state.revisions.map((revision) => revision.effects.map((effect) => effect.type)));
      expect(right.state.revisions.map((revision) => revision.committedAt)).toEqual(left.state.revisions.map((revision) => revision.committedAt));
      for (const [position, revision] of right.state.revisions.entries()) {
        const same = left.state.revisions[position]!;
        const embedsConfiguration = revision.effects.some((effect) => effect.type === "activation" || effect.type === "configuration" || effect.type === "closePackage");
        if (!embedsConfiguration) {
          expect(revision.effects, `revision ${position + 1}`).toEqual(same.effects);
          expect(revision.effectsHash, `revision ${position + 1}`).toEqual(same.effectsHash);
        }
      }
    }
    // The values that differ, and only these: they embed the configuration snapshot hash, the previous
    // chain head or the state hash.
    const left = legacy.at(-1)!;
    const right = profiled.at(-1)!;
    expect(right.state.contentHash).not.toEqual(left.state.contentHash);
    expect(right.state.configurationHash).not.toEqual(left.state.configurationHash);
    expect(right.state.openingBoundary!.contentHash).not.toEqual(left.state.openingBoundary!.contentHash);
    expect(right.state.revisions.at(-1)!.chainHash).not.toEqual(left.state.revisions.at(-1)!.chainHash);
    expect(right.state.closePackages.map((item) => item.contentHash)).not.toEqual(left.state.closePackages.map((item) => item.contentHash));
    expect(right.protocol.retainedResults.map((item) => item.resultHash)).toEqual(left.protocol.retainedResults.map((item) => item.resultHash));
    expect(right.protocol.retainedResults.map((item) => item.commitIntentHash)).not.toEqual(left.protocol.retainedResults.map((item) => item.commitIntentHash));
    expect(right.protocol.retainedResults.map((item) => item.command)).toEqual(left.protocol.retainedResults.map((item) => item.command));
  });

  test("seeded random command sequences agree on every disposition and diagnostic", () => {
    const rng = (seed: number) => {
      let state = seed | 0 || 1;
      return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
    };
    for (const seed of [3, 17, 91]) {
      const random = rng(seed * 7919);
      let legacy: Book = run(genesis(), activationCommand());
      let profiled: Book = run(genesis({ commitment: true }), activationCommand());
      const days = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-12"];
      let closed = false;
      for (let step = 0; step < 30; step += 1) {
        const day = days[Math.floor(random() * days.length)]!;
        const roll = random();
        const id = `random-${seed}-${step}`;
        const build = (state: BookState): BookCommand => roll < 0.7
          ? post(state, id, day)
          : closed ? reopen(state, id, `${day}T15:00:00Z`) : close(state, id, `${day}T15:00:00Z`);
        const left = executeBookCommand(legacy.state, legacy.protocol, build(legacy.state));
        const right = executeBookCommand(profiled.state, profiled.protocol, build(profiled.state));
        expect(right.result, id).toEqual(left.result);
        expect(right.state.journals, id).toEqual(left.state.journals);
        if (left.result.disposition === "committed") {
          closed = left.state.periodTransitions.at(-1)?.kind === "close";
          expect(hashBookState(right.state), id).toEqual(right.state.contentHash);
        } else expect(right.state.contentHash, id).toEqual(profiled.state.contentHash);
        legacy = left;
        profiled = right;
      }
      expect(validateBookState(profiled.state)).toEqual([]);
      expect(roundTrip(profiled).state).toEqual(profiled.state);
    }
  });
});

// ------------------------------------------------------- the marker cannot change

describe("the commitment profile is selected at genesis and nothing changes it", () => {
  test("a configuration change keeps it; the command has no field that could set it", () => {
    const active = run(genesis({ commitment: true }), activationCommand());
    const command = configure(active.state, "keep-marker", "2026-01-02T00:00:00Z", "2026-01-02");
    expect(() => assertBookCommandShape({ ...command, stateCommitmentProfile: PROFILE } as never)).toThrow();
    const next = run(active, command);
    expect(next.state.configurationSnapshots.map((snapshot) => snapshot.stateCommitmentProfile)).toEqual([PROFILE, PROFILE]);
    expect(next.state.activeConfigurationSnapshot.contentHash).not.toEqual(active.state.activeConfigurationSnapshot.contentHash);
    // A book without it stays without it through the same command.
    const legacyActive = run(genesis(), activationCommand());
    const legacy = run(legacyActive, configure(legacyActive.state, "keep-legacy", "2026-01-02T00:00:00Z", "2026-01-02"));
    expect(legacy.state.configurationSnapshots.map((snapshot) => Object.hasOwn(snapshot, "stateCommitmentProfile"))).toEqual([false, false]);
  });

  test("a forged configuration effect that adds, drops or changes the marker fails topology", () => {
    for (const commitment of [true, false]) {
      const active = run(genesis({ commitment }), activationCommand());
      const command = configure(active.state, "forge-marker", "2026-01-02T00:00:00Z", "2026-01-02");
      const evaluation = evaluateBookCommand(active.state, active.protocol, command);
      if (evaluation.disposition !== "ready") throw new Error("Configuration should prepare");
      const effect = evaluation.intent.effects[0];
      if (effect?.type !== "configuration") throw new Error("Missing configuration effect");
      const { stateCommitmentProfile: _marker, ...stripped } = effect.resultingConfigurationSnapshot;
      const flipped: Omit<BookConfigurationSnapshot, "contentHash"> = commitment ? stripped : { ...stripped, stateCommitmentProfile: PROFILE };
      const forged = { ...flipped, contentHash: hashBookConfigurationSnapshot(flipped) };
      const diagnostics = validateBookEffectTopology(active.state, { ...evaluation.intent,
        effects: [{ ...effect, resultingConfigurationSnapshot: forged, contentHash: forged.contentHash }] });
      expect(diagnostics.some((item) => item.code === "ordered_history_violation" && item.path === "intent.effects")).toBeTrue();
      // The honest effect is admitted by the same check.
      expect(validateBookEffectTopology(active.state, evaluation.intent)).toEqual([]);
      expect(commitBookIntent(active.state, active.protocol, evaluation.intent).result.disposition).toBe("committed");
    }
  });

  test("marker mismatches between retained snapshots are rejected at admission and at load", () => {
    for (const commitment of [true, false]) {
      const active = run(genesis({ commitment }), activationCommand());
      const book = run(active, configure(active.state, "mix", "2026-01-02T00:00:00Z", "2026-01-02"));
      const [first, second] = book.state.configurationSnapshots as [BookConfigurationSnapshot, BookConfigurationSnapshot];
      const { stateCommitmentProfile: _marker, ...stripped } = second;
      const changed: Omit<BookConfigurationSnapshot, "contentHash"> = commitment ? stripped : { ...stripped, stateCommitmentProfile: PROFILE };
      const retagged: BookConfigurationSnapshot = { ...changed, contentHash: hashBookConfigurationSnapshot(changed) };
      const unknown: Omit<BookConfigurationSnapshot, "contentHash"> = { ...stripped, stateCommitmentProfile: "unknown" as never };
      const unknownSnapshot: BookConfigurationSnapshot = { ...unknown, contentHash: hashBookConfigurationSnapshot(unknown) };
      const variants: [string, [BookConfigurationSnapshot, BookConfigurationSnapshot]][] = [["mixed", [first, retagged]], ["unknown value", [first, unknownSnapshot]]];
      for (const [name, snapshots] of variants) {
        const candidate = resealed(book.state, { configurationSnapshots: snapshots, activeConfigurationSnapshot: snapshots[1], configurationHash: snapshots[1].contentHash });
        const rejected = rejectedAtAdmission({ state: candidate, protocol: book.protocol }, post(candidate, `after-${name}`, "2026-01-20"));
        expect(rejected.result.diagnostics.map((item) => item.path), name).toEqual(["state.stateCommitmentProfile"]);
        expect(validateBookState(candidate).map((item) => item.path), name).toContain("state.stateCommitmentProfile");
        expect(decodeDurableBook(encodeDurableBook({ state: candidate, protocol: book.protocol })).disposition, name).toBe("rejected");
      }
    }
  });

  test("an unsupported marker never decodes and a supported one is part of the closed schema", () => {
    const book = run(genesis({ commitment: true }), activationCommand());
    const encoded = encodeDurableBook(aggregateOf(book));
    expect(encoded).toContain('"stateCommitmentProfile"');
    expect(decodeDurableBook(encoded).disposition).toBe("decoded");
    const retagged = (state: BookState, marker: string): BookState => {
      const swap = (snapshot: BookState["activeConfigurationSnapshot"]) => ({ ...snapshot, stateCommitmentProfile: marker as never });
      return { ...state, activeConfigurationSnapshot: swap(state.activeConfigurationSnapshot), configurationSnapshots: state.configurationSnapshots.map(swap) };
    };
    const unsupported = decodeDurableBook(encodeDurableBook({ state: retagged(book.state, "chain-head-state-commitment-v2"), protocol: book.protocol }));
    expect(unsupported.disposition).toBe("rejected");
    if (unsupported.disposition === "rejected") expect(unsupported.message).toContain("stateCommitmentProfile");
    const row = encodeBookRow("state.configurationSnapshots", book.state.activeConfigurationSnapshot);
    expect(decodeBookRow("state.configurationSnapshots", row).disposition).toBe("decoded");
    expect(decodeBookRow("state.configurationSnapshots", row.replaceAll(PROFILE, "other")).disposition).toBe("rejected");
    // The seven-field state header the native ledger stores does not carry it and is unchanged.
    const header = encodeBookStateHeader({ identity: book.state.identity, financialIdentityHash: book.state.financialIdentityHash,
      status: book.state.status, bookRevision: book.state.bookRevision, latestPostingSequence: book.state.latestPostingSequence,
      configurationRevision: book.state.configurationRevision, configurationHash: book.state.configurationHash });
    expect(header).not.toContain("stateCommitmentProfile");
  });

  test("composes with the structural source identity profile in every combination", () => {
    for (const structural of [false, true]) {
      for (const commitment of [false, true]) {
        const label = `structural=${structural} commitment=${commitment}`;
        let book: Book = run(genesis({ structural, commitment }), activationCommand());
        book = run(book, post(book.state, "composed-post", "2026-01-15"));
        book = run(book, configure(book.state, "composed-config", "2026-01-20T00:00:00Z", "2026-01-21"));
        const snapshot = book.state.activeConfigurationSnapshot;
        expect(snapshot.executionProfile, label).toBe(structural ? STRUCTURAL_SOURCE_IDENTITY_PROFILE : undefined);
        expect(snapshot.stateCommitmentProfile, label).toBe(commitment ? PROFILE : undefined);
        expect(validateBookState(book.state), label).toEqual([]);
        expect(roundTrip(book).state, label).toEqual(book.state);
      }
    }
  });

  test("adopting structural identities on a book with the commitment keeps the commitment", () => {
    const active = run(genesis({ commitment: true }), activationCommand());
    const adoption = sealCommand({ ...configure(active.state, "adopt", "2026-01-02T00:00:00Z", "2026-01-02"),
      executionProfileAdoption: { from: "legacy", to: STRUCTURAL_SOURCE_IDENTITY_PROFILE,
        expectedConfigurationHash: active.state.configurationHash, reason: "Adopt structural source identities prospectively",
        evidenceIds: [evidenceId("source-identity-review")] } } as never);
    const adopted = run(active, adoption);
    expect(adopted.state.configurationSnapshots.map((snapshot) => [snapshot.executionProfile, snapshot.stateCommitmentProfile])).toEqual([
      [undefined, PROFILE], [STRUCTURAL_SOURCE_IDENTITY_PROFILE, PROFILE],
    ]);
    expect(adopted.state.contentHash).toEqual(specifiedCommitment(adopted.state));
    expect(validateBookState(adopted.state)).toEqual([]);
    expect(roundTrip(adopted).state).toEqual(adopted.state);
  });
});

// ------------------------------------------------------- loading a state from outside

describe("loading a book with the commitment proves its materialized state against the chain", () => {
  function expectRejected(name: string, candidate: BookState, path: string, protocol: BookProtocolState) {
    expect(validateBookState(candidate).map((item) => item.path), name).toContain(path);
    expect(decodeDurableBook(encodeDurableBook({ state: candidate, protocol })).disposition, name).toBe("rejected");
  }

  test("the sealed hash does not depend on the lists, so each damaged list is caught against the chain", () => {
    const { state, protocol } = profiledHistory().at(-1)!;
    const journals = [...state.journals];
    const swapped = [...journals];
    swapped[2] = journals[3]!;
    swapped[3] = journals[2]!;
    const listOnly: [string, Partial<BookState>][] = [
      ["a journal's content", { journals: journals.map((item, index) => index === 1 ? { ...item, journal: { ...item.journal, narration: "altered" } } : item) }],
      ["two journals swapped", { journals: swapped }],
      ["a correction dropped", { corrections: state.corrections.slice(1) }],
      ["a correction altered", { corrections: state.corrections.map((link, index) => index === 0 ? { ...link, kind: "supersession" as const } : link) }],
      ["a period transition dropped", { periodTransitions: state.periodTransitions.slice(0, -1) }],
      ["a period transition altered", { periodTransitions: state.periodTransitions.map((item, index) => index === 1 ? { ...item, reason: "altered" } : item) }],
      ["a close package altered", { closePackages: state.closePackages.map((item, index) => index === 0 ? { ...item, throughPostingSequence: 99n } : item) }],
      ["a close package dropped", { closePackages: state.closePackages.slice(1) }],
    ];
    for (const [name, damage] of listOnly) {
      const candidate = resealed(state, damage);
      // The seal of a book with the commitment does not move when a list is damaged.
      expect(candidate.contentHash, name).toEqual(state.contentHash);
      expectRejected(name, candidate, "state.materializedEffects", protocol);
    }
    const withCounters: [string, Partial<BookState>][] = [
      ["a journal dropped", { journals: journals.slice(0, -1), latestPostingSequence: state.latestPostingSequence - 1n }],
      ["a journal duplicated", { journals: [...journals, journals.at(-1)!], latestPostingSequence: state.latestPostingSequence + 1n }],
    ];
    for (const [name, damage] of withCounters) expectRejected(name, resealed(state, damage), "state.materializedEffects", protocol);
  });

  test("a retained configuration snapshot that no configuration effect produced is caught, even when it hashes correctly", () => {
    const steps = profiledHistory();
    const { state, protocol } = steps.at(-1)!;
    const middle = state.configurationSnapshots[1]!;
    const replaced = { ...middle, effectiveAt: instant("2026-01-03T00:00:00Z") };
    const replacement = { ...replaced, contentHash: hashBookConfigurationSnapshot(replaced) };
    const list = [state.configurationSnapshots[0]!, replacement, state.configurationSnapshots[2]!];
    const candidate = resealed(state, { configurationSnapshots: list });
    expect(candidate.contentHash).toEqual(state.contentHash);
    expectRejected("replaced snapshot", candidate, "state.configurationSnapshots", protocol);
    expectRejected("dropped snapshot", resealed(state, { configurationSnapshots: [list[0]!, state.configurationSnapshots[2]!] }), "state.configurationSnapshots", protocol);
    expectRejected("duplicated first snapshot", resealed(state, { configurationSnapshots: [list[0]!, list[0]!, state.configurationSnapshots[2]!] }), "state.configurationSnapshots", protocol);
    expectRejected("an extra snapshot appended", resealed(state, { configurationSnapshots: [...state.configurationSnapshots, state.configurationSnapshots[2]!] }), "state.configurationSnapshots", protocol);
    // The genesis snapshot is pinned by the first configuration effect, which departs from its hash.
    const genesisReplaced = { ...state.configurationSnapshots[0]!, effectiveAt: instant("2020-02-02T00:00:00Z") };
    const genesisReplacement = { ...genesisReplaced, contentHash: hashBookConfigurationSnapshot(genesisReplaced) };
    expect(validateBookState(resealed(state, { configurationSnapshots: [genesisReplacement, ...state.configurationSnapshots.slice(1)] })).map((item) => item.path))
      .toContain("state.revisions[1].effects");
    // The honest list is accepted with zero, one and several configuration effects alike.
    for (const step of steps) expect(validateBookState(step.state)).toEqual([]);
  });

  test("scalars, the active configuration, the boundary and the chain head are bound", () => {
    const { state, protocol } = profiledHistory().at(-1)!;
    const wrongHash = hashCanonical({ damaged: true });
    const cases: [string, Partial<BookState>, string][] = [
      ["a wrong book revision", { bookRevision: state.bookRevision + 1n }, "state"],
      ["a wrong posting sequence", { latestPostingSequence: state.latestPostingSequence + 1n }, "state"],
      ["a wrong configuration revision", { configurationRevision: state.configurationRevision + 1n }, "state.configurationRevision"],
      ["a wrong configuration hash", { configurationHash: wrongHash }, "state.executionProfile"],
      ["a wrong opening boundary", { openingBoundary: { ...state.openingBoundary!, contentHash: wrongHash } }, "state.openingBoundary"],
      ["a wrong status", { status: "configuring" }, "state.openingBoundary"],
      ["a truncated chain", { revisions: state.revisions.slice(0, -1) }, "state"],
      ["a wrong chain head", { revisions: [...state.revisions.slice(0, -1), { ...state.revisions.at(-1)!, chainHash: wrongHash }] }, "state.revisions[11]"],
    ];
    for (const [name, damage, path] of cases) expectRejected(name, resealed(state, damage), path, protocol);
    expectRejected("a wrong content hash", { ...state, contentHash: wrongHash }, "state.contentHash", protocol);
    const { openingBoundary: _boundary, ...withoutBoundary } = state;
    expectRejected("a missing opening boundary", resealed(withoutBoundary as BookState, {}), "state.openingBoundary", protocol);
  });

  test("lots and the accounting lifecycle state are proven against the chain as well", () => {
    const lots = lotBook(true);
    const accounting = accountingBook(true);
    expect(lots.state.lots).toHaveLength(1);
    expect(lots.state.lotAllocations).toHaveLength(1);
    expect(accounting.state.accountingState.openItems).toHaveLength(2);
    expect(accounting.state.accountingState.settlements).toHaveLength(1);
    for (const book of [lots, accounting]) {
      expect(validateBookState(book.state)).toEqual([]);
      expect(roundTrip(book).state).toEqual(book.state);
      expect(book.state.contentHash).toEqual(specifiedCommitment(book.state));
    }
    const lotCases: [string, Partial<BookState>][] = [
      ["a holding's remaining quantity", { lotHoldings: lots.state.lotHoldings.map((item) => ({ ...item, remainingQuantity: ExactRational.of(99n, 1n) })) }],
      ["a lot removed", { lots: [] }],
      ["an allocation removed", { lotAllocations: [] }],
    ];
    for (const [name, damage] of lotCases) {
      const candidate = resealed(lots.state, damage);
      expect(candidate.contentHash, name).toEqual(lots.state.contentHash);
      expectRejected(name, candidate, "state.lotState", lots.protocol);
    }
    const open = accounting.state.accountingState;
    const stateCases: [string, BookState["accountingState"]][] = [
      ["an open item removed", { ...open, openItems: open.openItems.slice(1) }],
      ["an open item altered", { ...open, openItems: open.openItems.map((item, index) => index === 0 ? { ...item, bookValue: ExactRational.of(7n, 1n) } : item) }],
      ["a settlement removed", { ...open, settlements: [] }],
    ];
    for (const [name, accountingState] of stateCases) {
      const candidate = resealed(accounting.state, { accountingState });
      expect(candidate.contentHash, name).toEqual(accounting.state.contentHash);
      expectRejected(name, candidate, "state.accountingState", accounting.protocol);
    }
  });

  test("a revision altered after the fact breaks the chain it is part of", () => {
    const { state, protocol } = profiledHistory().at(-1)!;
    const middle = state.revisions[4]!;
    const altered = { ...middle, effects: middle.effects.slice(0, 1).concat(middle.effects.slice(0, 1)) };
    const candidate = resealed(state, { revisions: state.revisions.map((revision, index) => index === 4 ? altered : revision) });
    expectRejected("an altered revision", candidate, "state.revisions[4]", protocol);
  });
});

// ------------------------------------------------------- admission

describe("admission of a command against a book with the commitment", () => {
  const probe = (state: BookState) => post(state, "admission-probe", "2026-02-22");

  function expectRejection(name: string, candidate: BookState, path: string, protocol: BookProtocolState) {
    const outcome = rejectedAtAdmission({ state: candidate, protocol }, probe(candidate));
    expect(outcome.result.disposition, name).toBe("rejected");
    expect(outcome.result.diagnostics.map((item) => [item.code, item.path]), name).toEqual([["ordered_history_violation", path]]);
    expect(outcome.retained?.outcome, name).toBe("rejected");
    const executed = executeBookCommand(candidate, protocol, probe(candidate));
    expect(executed.protocol.retainedResults, name).toHaveLength(protocol.retainedResults.length + 1);
    expect(executed.state, name).toBe(candidate);
  }

  test("admits the honest state, freshly built and decoded alike", () => {
    const book = profiledHistory().at(-1)!;
    for (const honest of [book, roundTrip(book)]) {
      expect(admissionOf(honest, probe(honest.state)).disposition).toBe("continue");
      expect(executeBookCommand(honest.state, honest.protocol, probe(honest.state)).result.disposition).toBe("committed");
    }
  });

  test("rejects counters that disagree with the collections", () => {
    const { state, protocol } = profiledHistory().at(-1)!;
    expectRejection("a posting count short by one", resealed(state, { journals: state.journals.slice(0, -1) }), "state", protocol);
    expectRejection("a posting count over by one", resealed(state, { journals: [...state.journals, state.journals.at(-1)!] }), "state", protocol);
    expectRejection("a revision count over by one", resealed(state, { bookRevision: state.bookRevision + 1n }), "state", protocol);
    expectRejection("a revision missing", resealed(state, { revisions: state.revisions.slice(0, -1) }), "state", protocol);
    expectRejection("a configuration revision over by one", resealed(state, { configurationRevision: state.configurationRevision + 1n }), "state", protocol);
    const snapshots = state.configurationSnapshots;
    expectRejection("a retained snapshot missing", resealed(state, { configurationSnapshots: snapshots.slice(0, -1),
      activeConfigurationSnapshot: snapshots[1]!, configurationHash: snapshots[1]!.contentHash }), "state", protocol);
  });

  test("rejects a head revision that is not the book revision", () => {
    const { state, protocol } = profiledHistory().at(-1)!;
    const head = state.revisions.at(-1)!;
    expectRejection("a renumbered head", resealed(state, { revisions: [...state.revisions.slice(0, -1), { ...head, bookRevision: head.bookRevision + 5n }] }), "state", protocol);
  });

  test("rejects a wrong commitment", () => {
    const { state, protocol } = profiledHistory().at(-1)!;
    const wrong = { ...state, contentHash: hashCanonical({ damaged: true }) };
    const outcome = rejectedAtAdmission({ state: wrong, protocol }, probe(wrong));
    expect(outcome.result.diagnostics.map((item) => [item.code, item.path, item.message])).toEqual([
      ["ordered_history_violation", "state.contentHash", "Book state does not reproduce its chain-head content hash"],
    ]);
    expectRejection("a hash of another book", { ...state, contentHash: genesis().state.contentHash }, "state.contentHash", protocol);
  });

  test("rejects a latest journal that is not the one its revision recorded", () => {
    const { state, protocol } = profiledHistory().at(-1)!;
    const latest = state.journals.at(-1)!;
    const swap = (replacement: BookedJournal) => resealed(state, { journals: [...state.journals.slice(0, -1), replacement] });
    expectRejection("a different journal body", swap({ ...latest, journal: { ...latest.journal, narration: "not what was booked" } }), "state", protocol);
    expectRejection("a different canonical hash", swap({ ...latest, canonicalHash: hashCanonical({ damaged: true }) }), "state", protocol);
    expectRejection("a different sequence", swap({ ...latest, postingSequence: latest.postingSequence + 1n }), "state", protocol);
    expectRejection("a revision with no journal", swap({ ...latest, bookRevision: 1n }), "state", protocol);
    expectRejection("a revision that does not exist", swap({ ...latest, bookRevision: latest.bookRevision + 40n }), "state", protocol);
    // Booked by a revision that is not the head: the check finds that revision by the journal's own number.
    const earlier = profiledHistory().at(-2)!;
    const lastBooked = earlier.state.journals.at(-1)!;
    expect(lastBooked.bookRevision).toBeLessThan(earlier.state.revisions.at(-1)!.bookRevision);
    const inner = earlier.state.revisions.map((revision) => revision.bookRevision === lastBooked.bookRevision ? { ...revision, bookRevision: revision.bookRevision + 7n } : revision);
    expect(inner.at(-1)!.bookRevision).toBe(earlier.state.revisions.at(-1)!.bookRevision);
    expectRejection("a renumbered booking revision", resealed(earlier.state, { revisions: inner }), "state", earlier.protocol);
  });

  test("compares the latest journal with the last journal effect of the revision that booked it", () => {
    const { state, protocol } = profiledHistory().at(-1)!;
    const head = state.revisions.at(-1)!;
    const earlier = state.revisions.find((revision) => revision.effects.some((effect) => effect.type === "journal"))!;
    const foreign = earlier.effects.find((effect) => effect.type === "journal")!;
    // A revision that booked two journals records them in order; the latest journal is the second.
    const several = { ...head, effects: [foreign, ...head.effects] };
    const honest = resealed(state, { revisions: [...state.revisions.slice(0, -1), several] });
    expect(admissionOf({ state: honest, protocol }, probe(honest)).disposition).toBe("continue");
    const reordered = { ...head, effects: [...head.effects, foreign] };
    expectRejection("the foreign journal last", resealed(state, { revisions: [...state.revisions.slice(0, -1), reordered] }), "state", protocol);
  });

  test("a state with no journals, or no revisions at all, is coherent", () => {
    const fresh = genesis({ commitment: true });
    expect(admissionOf(fresh, activationCommand()).disposition).toBe("continue");
    const activeOnly = profiledHistory()[0]!;
    expect(activeOnly.state.journals).toHaveLength(0);
    expect(admissionOf(activeOnly, probe(activeOnly.state)).disposition).toBe("continue");
  });

  test("a journal list that cannot even be read is rejected, never thrown", () => {
    const { state, protocol } = profiledHistory().at(-1)!;
    const candidate = { ...state, journals: null } as unknown as BookState;
    const outcome = rejectedAtAdmission({ state: candidate, protocol }, probe(state));
    expect(outcome.result.diagnostics.map((item) => item.path)).toEqual(["state"]);
  });

  test("looks at the latest journal and nothing else of the journal list", () => {
    const { state, protocol } = profiledHistory().at(-1)!;
    const reads: string[] = [];
    // A frozen list, like every list the kernel builds or decodes, so that nothing needs to copy it to trust it.
    const watched = new Proxy(Object.freeze([...state.journals]), { get(target, property, receiver) { reads.push(String(property)); return Reflect.get(target, property, receiver); } });
    const candidate = { ...state, journals: watched } as BookState;
    expect(admissionOf({ state: candidate, protocol }, probe(state)).disposition).toBe("continue");
    expect(reads.filter((name) => /^\d+$/.test(name))).toEqual([String(state.journals.length - 1)]);
    expect(reads.length).toBeLessThanOrEqual(4);
  });

  test("trusts the lists of a built state: the trade the commitment makes, closed at decode", () => {
    const { state, protocol } = profiledHistory().at(-1)!;
    const journals = state.journals.map((item, index) => index === 1 ? { ...item, journal: { ...item.journal, narration: "altered in memory" } } : item);
    const candidate = resealed(state, { journals });
    expect(admissionOf({ state: candidate, protocol }, probe(candidate)).disposition).toBe("continue");
    expect(decodeDurableBook(encodeDurableBook({ state: candidate, protocol })).disposition).toBe("rejected");
  });
});

// ------------------------------------------------------- the configuration is not rehashed per command

describe("admission reuses the verification of snapshots the kernel built or decoded", () => {
  const probe = (state: BookState) => post(state, "snapshot-probe", "2026-02-22");

  /** How many snapshot checks one admission reused and how many recomputed a hash. */
  function admit(book: Book) {
    const before = snapshotVerifications();
    const outcome = admissionOf(book, probe(book.state));
    const after = snapshotVerifications();
    return { outcome, reused: after.reused - before.reused, rehashed: after.rehashed - before.rehashed };
  }

  test("a built book is admitted without recomputing any configuration hash, however many it holds", () => {
    for (const commitment of [true, false]) {
      const history = (commitment ? profiledHistory : legacyHistory)();
      for (const step of [history[0]!, history.at(-1)!]) {
        const snapshots = step.state.configurationSnapshots.length;
        const result = admit(step);
        expect(result.outcome.disposition).toBe("continue");
        // The active snapshot once, then every retained snapshot once.
        expect(result.reused).toBe(snapshots + 1);
        expect(result.rehashed).toBe(0);
      }
    }
    const genesisOnly = genesis({ commitment: true });
    expect(admit(genesisOnly).rehashed).toBe(0);
  });

  test("a decoded book is admitted the same way, and a copy of a snapshot is checked in full", () => {
    const { state, protocol } = profiledHistory().at(-1)!;
    const decoded = roundTrip({ state, protocol });
    const result = admit(decoded);
    expect(result.outcome.disposition).toBe("continue");
    expect(result.rehashed).toBe(0);
    expect(result.reused).toBe(decoded.state.configurationSnapshots.length + 1);
    // The same content in a different object earns no trust: its hash is recomputed.
    const copies = state.configurationSnapshots.map((snapshot) => ({ ...snapshot }));
    const copied = { ...state, configurationSnapshots: copies, activeConfigurationSnapshot: copies.at(-1)! };
    const checked = admit({ state: copied, protocol });
    expect(checked.outcome.disposition).toBe("continue");
    expect(checked.rehashed).toBe(copies.length + 1);
    expect(checked.reused).toBe(0);
  });

  test("a snapshot altered in a copy is rejected although the original object is trusted", () => {
    const { state, protocol } = profiledHistory().at(-1)!;
    const original = state.activeConfigurationSnapshot;
    const altered = { ...original, effectiveAt: instant("2031-01-01T00:00:00Z") };
    const candidate = { ...state, activeConfigurationSnapshot: altered };
    const rejected = rejectedAtAdmission({ state: candidate, protocol }, probe(candidate));
    expect(rejected.result.diagnostics.map((item) => item.path)).toEqual(["state.executionProfile"]);
    // Even with its hash corrected, a snapshot that is not the one the state names fails.
    const rehashed = { ...altered, contentHash: hashBookConfigurationSnapshot(altered) };
    const consistentLooking = { ...state, activeConfigurationSnapshot: rehashed, configurationHash: rehashed.contentHash };
    expect(rejectedAtAdmission({ state: consistentLooking, protocol }, probe(consistentLooking)).result.diagnostics[0]?.code).toBe("ordered_history_violation");
  });

  test("restoring a state never trusts a verification: every snapshot is recomputed", () => {
    const { state } = profiledHistory().at(-1)!;
    const before = snapshotVerifications();
    expect(validateBookState(state)).toEqual([]);
    expect(snapshotVerifications()).toEqual(before);
    // validateBookState does not use the shared verification, so a state is judged on its own content.
    const forged = { ...state.activeConfigurationSnapshot, effectiveAt: instant("2031-01-01T00:00:00Z") };
    expect(validateBookState({ ...state, activeConfigurationSnapshot: forged }).map((item) => item.path)).toContain("state.executionProfile");
  });

  test("a committed configuration is verified before it is trusted, and the next command reuses it", () => {
    const active = run(genesis({ commitment: true }), activationCommand());
    const changed = run(active, configure(active.state, "trusted-config", "2026-01-02T00:00:00Z", "2026-01-02"));
    const result = admit(changed);
    expect(result.rehashed).toBe(0);
    expect(result.reused).toBe(3);
  });
});

// ------------------------------------------------------- built states cannot be changed by a caller

describe("a state the kernel built with the commitment rejects mutation by its callers", () => {
  function expectRejectsMutation(name: string, array: readonly unknown[]) {
    const mutable = array as unknown[];
    expect(array.length, name).toBeGreaterThan(1);
    const before = [...array];
    expect(() => mutable.push(array[0]), `${name} push`).toThrow();
    expect(() => mutable.pop(), `${name} pop`).toThrow();
    expect(() => mutable.shift(), `${name} shift`).toThrow();
    expect(() => mutable.unshift(array[0]), `${name} unshift`).toThrow();
    expect(() => mutable.splice(0, 1), `${name} splice`).toThrow();
    expect(() => mutable.sort(), `${name} sort`).toThrow();
    expect(() => mutable.reverse(), `${name} reverse`).toThrow();
    expect(() => { mutable[0] = array[1]; }, `${name} index write`).toThrow();
    expect(() => { mutable[array.length] = array[0]; }, `${name} append by index`).toThrow();
    expect(() => { mutable.length = 0; }, `${name} length`).toThrow();
    expect(() => mutable.fill(array[0]), `${name} fill`).toThrow();
    expect(() => mutable.copyWithin(0, 1), `${name} copyWithin`).toThrow();
    expect([...array], `${name} unchanged`).toEqual(before);
  }

  function expectAllHistoriesImmutable(label: string, state: BookState, protocol: BookProtocolState) {
    expectRejectsMutation(`${label} journals`, state.journals);
    expectRejectsMutation(`${label} revisions`, state.revisions);
    expectRejectsMutation(`${label} corrections`, state.corrections);
    expectRejectsMutation(`${label} retainedResults`, protocol.retainedResults);
    expectRejectsMutation(`${label} configurationSnapshots`, state.configurationSnapshots);
    expectRejectsMutation(`${label} periodTransitions`, state.periodTransitions);
    expectRejectsMutation(`${label} closePackages`, state.closePackages);
    expectRejectsMutation(`${label} periods`, state.periods);
    expect(() => { (state as { status: string }).status = "closed"; }, `${label} state field`).toThrow();
    expect(() => { (state as unknown as { contentHash: unknown }).contentHash = state.contentHash; }, `${label} hash field`).toThrow();
    expect(() => { (protocol as unknown as { retainedResults: unknown }).retainedResults = []; }, `${label} protocol field`).toThrow();
    expect(() => (state.journals[0]!.journal.postings as unknown[]).push(1), `${label} journal postings`).toThrow();
    expect(() => (state.revisions[0]!.effects as unknown[]).push(1), `${label} revision effects`).toThrow();
    expect(() => { (state.revisions[0] as unknown as { chainHash: unknown }).chainHash = state.contentHash; }, `${label} revision field`).toThrow();
  }

  test("as built by the kernel, one command after another", () => {
    const book = profiledHistory().at(-1)!;
    expectAllHistoriesImmutable("built", book.state, book.protocol);
  });

  test("after a rejected command, which keeps the state and extends the retained results", () => {
    const book = profiledHistory().at(-1)!;
    const rejected = executeBookCommand(book.state, book.protocol, sealCommand({ ...post(book.state, "stale-again", "2026-02-21"), expectedBookRevision: 2n }));
    expect(rejected.result.disposition).toBe("rejected");
    expectAllHistoriesImmutable("rejected", rejected.state, rejected.protocol);
  });

  test("as decoded from its durable bytes", () => {
    const decoded = roundTrip(profiledHistory().at(-1)!);
    expectAllHistoriesImmutable("decoded", decoded.state, decoded.protocol);
  });

  test("a mutation attempted on the caller's own copy never reaches the state", () => {
    const { state } = profiledHistory().at(-1)!;
    const copy = [...state.journals];
    copy.push(copy[0]!);
    copy.sort((left, right) => Number(right.postingSequence - left.postingSequence));
    expect(state.journals.map((item) => item.postingSequence)).toEqual(state.journals.map((_, index) => BigInt(index + 1)));
    expect(validateBookState(state)).toEqual([]);
  });
});

// ------------------------------------------------------- scenarios with lots and accounting effects

/** The journal of audit.test.ts's lot scenario: a lot-bearing posting and its offset. */
function lotJournal(id: string, quantity: ExactRational, amount: ExactDecimal, basis: ExactRational): JournalTransaction {
  return Object.freeze({
    id: journalId(id), kind: "ordinary", bookId: IDS.book, functionalCommodityId: IDS.usd,
    economicAt: instant("2026-01-15T12:00:00Z"), accountingDate: localDate("2026-01-15"), recordedAt: instant("2026-01-15T13:00:00Z"), narration: id,
    postings: Object.freeze([
      Object.freeze({ id: postingId(`${id}-lot`), ordinal: 1n, accountId: IDS.cash,
        units: Object.freeze({ canonicalNumber: quantity, commodityId: IDS.usd }),
        bookValue: Object.freeze({ amount, functionalCommodityId: IDS.usd }),
        costBasis: Object.freeze({ totalBasis: basis, basisCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
      Object.freeze({ id: postingId(`${id}-offset`), ordinal: 2n, accountId: IDS.revenue,
        units: Object.freeze({ canonicalNumber: quantity.negate(), commodityId: IDS.usd }),
        bookValue: Object.freeze({ amount: amount.negate(), functionalCommodityId: IDS.usd }), dimensionMemberIds: Object.freeze([]) }),
    ]),
  } as JournalTransaction);
}

/** A book with one lot, acquired by a journal and partly disposed of by another. */
function lotBook(commitment: boolean): Book {
  let current: Book = run(genesis({ commitment }), activationCommand());
  const evidence = Object.freeze({ id: evidenceId("commitment-evidence"), sourceSystem: "fixture", sourceRecordId: "lot",
    observedAt: instant("2026-01-15T11:00:00Z"), contentHash: hashCanonical({ fixture: "lot" }) });
  const derivation = Object.freeze({ id: derivationId("commitment-derivation"), policyId: current.state.policies[0]!.id,
    policyVersion: version, algorithmVersion: version, inputHash: hashCanonical({ allocation: "complete" }), actorId: IDS.actor,
    state: "approved" as const, recordedAt: instant("2026-01-15T13:00:00Z"), evidence: Object.freeze([evidence]) });
  const acquired = lotJournal("lot-acquire", ExactRational.of(3n, 1n), ExactDecimal.of(10_000n, 2n), ExactRational.of(100n, 1n));
  const lot = Object.freeze({ id: lotId("commitment-lot"), bookId: IDS.book, commodityId: IDS.usd, acquiredAt: instant("2026-01-15T12:00:00Z"),
    acquisitionQuantity: ExactRational.of(3n, 1n), acquisitionTotalBasis: ExactRational.of(100n, 1n), basisCommodityId: IDS.usd, evidenceIds: Object.freeze([evidence.id]) });
  const holding = Object.freeze({ id: lotHoldingId("commitment-holding"), bookId: IDS.book, lotId: lot.id, accountId: IDS.cash, commodityId: IDS.usd,
    basisCommodityId: IDS.usd, remainingQuantity: ExactRational.of(3n, 1n), remainingTotalBasis: ExactRational.of(100n, 1n),
    remainingValuationAllowance: ExactRational.zero(), remainingCarryingAmount: ExactRational.of(100n, 1n) });
  current = run(current, sealCommand({ ...core(current.state, "lot-acquire-command", "2026-01-15T14:00:00Z"), type: "postJournal" as const,
    resolved: resolved(acquired), lotOperations: [{ type: "acquire" as const, lot, holding, journalPostingId: acquired.postings[0]!.id }] }));
  const disposed = lotJournal("lot-dispose", ExactRational.of(-1n, 1n), ExactDecimal.of(-4_000n, 2n), ExactRational.of(-100n, 3n));
  current = run(current, sealCommand({ ...core(current.state, "lot-dispose-command", "2026-01-15T14:00:00Z"), type: "postJournal" as const,
    resolved: resolved(disposed), lotOperations: [{ type: "dispose" as const, holdingIds: [holding.id], requestedQuantity: ExactRational.of(1n, 1n),
      selection: { method: "fifo" as const }, derivation, identities: [{ holdingId: holding.id, allocationId: lotAllocationId("commitment-allocation") }],
      journalPostingId: disposed.postings[0]!.id }] }));
  return current;
}

/** A book with a payment and two open items: accounting lifecycle effects. */
function accountingBook(commitment: boolean): Book {
  let current: Book = run(genesis({ commitment }), activationCommand());
  const exact = (value: bigint) => ExactRational.of(value, 1n);
  const scope = { externalPartyId: "customer", controlAccountId: IDS.cash };
  const payment = journal("commitment-payment", "2026-01-15", "ordinary", true);
  const settlement = { id: settlementId("commitment-payment"), bookId: IDS.book, kind: "cash" as const, scope, settledAt: payment.economicAt,
    settlementSource: createCanonicalPostingReference(canonicalPostingReferenceId("commitment-payment"), IDS.book, payment.id, payment.postings[0]!, effectKey("commitment-payment:journal:0")),
    denominationCommodityId: IDS.usd, denomination: exact(100n), bookValue: exact(100n), derivation: accountingDerivation };
  current = run(current, sealCommand({ ...core(current.state, "commitment-payment", "2026-01-15T14:00:00Z"), type: "applySettlement" as const,
    resolved: [resolved(payment)], request: { operation: "recognizeUnallocated" as const, settlement, allocations: [] } }));
  for (const id of ["commitment-invoice-a", "commitment-invoice-b"]) {
    const source = journal(id, "2026-01-20");
    current = run(current, sealCommand({ ...core(current.state, id, "2026-01-20T14:00:00Z"), type: "recognizeOpenItem" as const, resolved: resolved(source),
      request: { value: { id: openItemId(id), bookId: IDS.book, kind: "receivable" as const, scope, recognizedOn: source.accountingDate,
        denominationCommodityId: IDS.usd, denomination: exact(100n), bookValue: exact(100n), derivation: accountingDerivation,
        recognitionSource: createCanonicalPostingReference(canonicalPostingReferenceId(id), IDS.book, source.id, source.postings[0]!, effectKey(`${id}:journal:0`)) } } }));
  }
  return current;
}

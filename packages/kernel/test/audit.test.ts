import { describe, expect, test } from "bun:test";
import {
  ExactDecimal,
  ExactRational,
  actorId,
  canonicalBookEffectValue,
  commandTimelineIsValid,
  commandId,
  commitBookIntent,
  derivationId,
  evidenceId,
  executeBookCommand,
  evaluateBookCommand,
  hashCanonical,
  hashBookState,
  instant,
  journalId,
  localDate,
  lotAllocationId,
  lotHoldingId,
  lotId,
  postingId,
  resolveJournal,
  sealCommand,
  semanticVersion,
  validateBookState,
  validateBookEffectTopology,
  type AtomicBookCommit,
  type BookCommand,
  type BookState,
  type DerivationRecord,
  type JournalTransaction,
  type PostJournalCommand,
} from "../src/index.ts";
import {
  IDS,
  freshState,
  journal,
  policy,
  quantizationPolicy,
  reportHash,
  reportPolicyHash,
  resolved,
  closePackageId,
} from "./fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";

function activate(): AtomicBookCommit {
  const fresh = freshState();
  return executeBookCommand(fresh.state, fresh.protocol, activationCommand());
}

function times(issued = "2026-01-15T14:00:00Z") {
  return {
    issuedAt: instant(issued),
    completedAt: instant(new Date(Date.parse(issued) + 1_000).toISOString()),
    committedAt: instant(new Date(Date.parse(issued) + 2_000).toISOString()),
  };
}

function post(state: BookState, id: string, transaction: JournalTransaction, extra: Pick<PostJournalCommand, "lotOperations"> = {}): BookCommand {
  return sealCommand({
    id: commandId(id),
    type: "postJournal",
    protocolVersion: semanticVersion("1.0.0"),
    bookId: IDS.book,
    expectedBookRevision: state.bookRevision,
    ...times(`${transaction.accountingDate}T14:00:00Z`),
    actorId: IDS.actor,
    resolved: resolved(transaction),
    ...extra,
  } as Parameters<typeof sealCommand>[0]) as BookCommand;
}

const evidence = Object.freeze({
  id: evidenceId("audit-evidence"),
  sourceSystem: "audit-fixture",
  sourceRecordId: "source-lot",
  observedAt: instant("2026-01-15T11:00:00Z"),
  contentHash: hashCanonical({ fixture: "lot" }),
});

const derivation: DerivationRecord = Object.freeze({
  id: derivationId("audit-derivation"),
  policyId: policy.id,
  policyVersion: policy.version,
  algorithmVersion: semanticVersion("1.0.0"),
  inputHash: hashCanonical({ allocation: "complete" }),
  actorId: actorId("audit-actor"),
  state: "approved",
  recordedAt: instant("2026-01-15T13:00:00Z"),
  evidence: Object.freeze([evidence]),
});

function lotJournal(id: string, quantity: ExactRational, amount: ExactDecimal, basis?: ExactRational): JournalTransaction {
  return Object.freeze({
    id: journalId(id),
    kind: "ordinary",
    bookId: IDS.book,
    functionalCommodityId: IDS.usd,
    economicAt: instant("2026-01-15T12:00:00Z"),
    accountingDate: localDate("2026-01-15"),
    recordedAt: instant("2026-01-15T13:00:00Z"),
    narration: id,
    postings: Object.freeze([
      Object.freeze({
        id: postingId(`${id}-lot`), ordinal: 1n, accountId: IDS.cash,
        units: Object.freeze({ canonicalNumber: quantity, commodityId: IDS.usd }),
        bookValue: Object.freeze({ amount, functionalCommodityId: IDS.usd }),
        ...(basis === undefined ? {} : { costBasis: Object.freeze({ totalBasis: basis, basisCommodityId: IDS.usd }) }),
        dimensionMemberIds: Object.freeze([]),
      }),
      Object.freeze({
        id: postingId(`${id}-offset`), ordinal: 2n, accountId: IDS.revenue,
        units: Object.freeze({ canonicalNumber: quantity.negate(), commodityId: IDS.usd }),
        bookValue: Object.freeze({ amount: amount.negate(), functionalCommodityId: IDS.usd }),
        dimensionMemberIds: Object.freeze([]),
      }),
    ]),
  } as JournalTransaction);
}

describe("production audit closures", () => {
  test("configuration is deeply immutable and evolves only through a prospective revision", () => {
    const mutableAccounts = freshState().state.admissionSnapshot.accounts.map((account) => ({
      ...account,
      allowedCommodityIds: [...account.allowedCommodityIds],
    }));
    const fresh = freshState();
    const replacement = sealCommand({
      id: commandId("replace-config"), type: "replaceConfiguration", protocolVersion: semanticVersion("1.0.0"),
      bookId: IDS.book, expectedBookRevision: 0n, ...times("2025-12-01T00:00:00Z"), actorId: IDS.actor,
      effectiveOn: localDate("2026-01-01"), periods: fresh.state.periods,
      admissionSnapshot: { ...fresh.state.admissionSnapshot, accounts: mutableAccounts },
      policies: fresh.state.policies,
      quantizationPolicies: fresh.state.quantizationPolicies,
      expectedConfigurationRevision: fresh.state.configurationRevision,
      accountingPolicies: fresh.state.accountingPolicySnapshot.policies,
    } as Parameters<typeof sealCommand>[0]);
    const configured = executeBookCommand(fresh.state, fresh.protocol, replacement);
    expect(configured.result.disposition).toBe("committed");
    mutableAccounts[0]!.name = "MUTATED OUTSIDE";
    expect(configured.state.admissionSnapshot.accounts[0]?.name).toBe("Cash");
    expect(configured.state.bookRevision).toBe(1n);
    expect(configured.state.revisions[0]?.effects[0]?.type).toBe("configuration");
  });

  test("separates issued, completed, and committed time and rejects conflation order", () => {
    const fresh = freshState();
    const invalid = sealCommand({
      ...activationCommand("bad-time"),
      completedAt: instant("2025-12-31T23:59:59Z"),
    });
    const result = executeBookCommand(fresh.state, fresh.protocol, invalid);
    expect(result.result.diagnostics[0]?.code).toBe("temporal_semantics_violation");
    const good = executeBookCommand(fresh.state, fresh.protocol, activationCommand("good-time"));
    expect(good.result.completedAt).toBe(instant("2026-01-01T00:00:01Z"));
    expect(good.result.committedAt).toBe(instant("2026-01-01T00:00:02Z"));
    const sameInstant = instant("2026-01-01T00:00:00Z");
    const equal = executeBookCommand(fresh.state, fresh.protocol, sealCommand({ ...activationCommand("equal-time"), issuedAt: sameInstant, completedAt: sameInstant, committedAt: sameInstant }));
    expect(equal.result.disposition).toBe("committed");
    expect(commandTimelineIsValid(sameInstant, sameInstant, sameInstant, sameInstant)).toBeTrue();
    expect(commandTimelineIsValid(sameInstant, sameInstant, sameInstant, instant("2026-01-01T00:00:01Z"))).toBeFalse();
  });

  test("effect identity covers policy provenance and rejects a tampered prepared intent", () => {
    const active = activate();
    const command = post(active.state, "effect-hash", journal("effect-journal"));
    const evaluated = evaluateBookCommand(active.state, active.protocol, command);
    expect(evaluated.disposition).toBe("ready");
    if (evaluated.disposition !== "ready") return;
    const journalEffect = evaluated.intent.effects.find((effect) => effect.type === "journal");
    expect(journalEffect?.type).toBe("journal");
    if (journalEffect?.type !== "journal") return;
    const alternate = journal("effect-topology-alternate");
    const topologyEffects = evaluated.intent.effects.map((effect) => effect.type === "journal" ? { ...effect, booked: { ...effect.booked, journal: { ...effect.booked.journal, id: alternate.id } } } : effect);
    expect(validateBookEffectTopology(active.state, { ...evaluated.intent, effects: topologyEffects } as typeof evaluated.intent)).toHaveLength(1);
    const tamperedEffect = Object.freeze({
      ...journalEffect,
      booked: Object.freeze({ ...journalEffect.booked, policySnapshotHash: hashCanonical({ tampered: true }) }),
    });
    const tamperedIntent = Object.freeze({
      ...evaluated.intent,
      effects: Object.freeze(evaluated.intent.effects.map((effect) => effect === journalEffect ? tamperedEffect : effect)),
    });
    const result = commitBookIntent(active.state, active.protocol, tamperedIntent);
    expect(result.result.disposition).toBe("rejected");
    expect(result.state.bookRevision).toBe(active.state.bookRevision);
  });

  test("a correction cannot move a journal out of a closed population", () => {
    let current = activate();
    current = executeBookCommand(current.state, current.protocol, post(current.state, "post-original", journal("closed-original")));
    current = executeBookCommand(current.state, current.protocol, sealCommand({
      id: commandId("close-before-correction"), type: "closePeriod", protocolVersion: semanticVersion("1.0.0"),
      bookId: IDS.book, expectedBookRevision: current.state.bookRevision, ...times("2026-02-01T00:00:00Z"), actorId: IDS.actor,
      periodId: IDS.period1, closePackageId: closePackageId("closed-population"), reason: "closed",
      reportPopulationHash: reportHash, reportingPolicySnapshotHash: reportPolicyHash,
    }));
    const replacement = resolved(journal("later-replacement", "2026-02-15"));
    const result = executeBookCommand(current.state, current.protocol, sealCommand({
      id: commandId("move-closed-journal"), type: "correctJournal", protocolVersion: semanticVersion("1.0.0"),
      bookId: IDS.book, expectedBookRevision: current.state.bookRevision, ...times("2026-02-16T00:00:00Z"), actorId: IDS.actor,
      correctionKind: "supersession", originalJournalId: "closed-original",
      resolved: Object.freeze({ ...replacement, derivations: Object.freeze([derivation]) }),
    }));
    expect(result.result.diagnostics[0]?.code).toBe("fiscal_period_admission");
  });

  test("commits lot acquisition and exact disposal atomically with their journals", () => {
    let current = activate();
    const acquired = lotJournal("lot-acquire", ExactRational.of(3n, 1n), ExactDecimal.of(10_000n, 2n), ExactRational.of(100n, 1n));
    const lot = Object.freeze({
      id: lotId("atomic-lot"), bookId: IDS.book, commodityId: IDS.usd,
      acquiredAt: instant("2026-01-15T12:00:00Z"), acquisitionQuantity: ExactRational.of(3n, 1n),
      acquisitionTotalBasis: ExactRational.of(100n, 1n), basisCommodityId: IDS.usd,
      evidenceIds: Object.freeze([evidence.id]),
    });
    const holding = Object.freeze({
      id: lotHoldingId("atomic-holding"), bookId: IDS.book, lotId: lot.id, accountId: IDS.cash,
      commodityId: IDS.usd, basisCommodityId: IDS.usd,
      remainingQuantity: ExactRational.of(3n, 1n), remainingTotalBasis: ExactRational.of(100n, 1n), remainingValuationAllowance: ExactRational.zero(), remainingCarryingAmount: ExactRational.of(100n, 1n),
    });
    current = executeBookCommand(current.state, current.protocol, post(current.state, "acquire-lot", acquired, {
      lotOperations: [{ type: "acquire", lot, holding, journalPostingId: acquired.postings[0]!.id }],
    }));
    expect(current.result.disposition).toBe("committed");
    expect(current.state.lots[0]?.id).toBe(lot.id);
    const acquiredRevision = current.state.revisions.at(-1)!;
    const emptyLotHash = hashCanonical({ type: "LotState", lots: [], holdings: [], allocations: [] });
    const forgedEffects = acquiredRevision.effects.map((effect) => effect.type === "lotState"
      ? { type: "lotState" as const, lotState: { lots: [], holdings: [], allocations: [], contentHash: emptyLotHash } }
      : effect);
    const forgedEffectsHash = hashCanonical({ type: "RevisionEffects", effects: forgedEffects.map(canonicalBookEffectValue) });
    const forgedChainHash = hashCanonical({
      type: "RevisionChain", bookId: IDS.book, revision: acquiredRevision.bookRevision,
      previousHash: acquiredRevision.previousHash === null ? null : {
        algorithm: acquiredRevision.previousHash.algorithm,
        canonicalizationVersion: acquiredRevision.previousHash.canonicalizationVersion,
        digest: acquiredRevision.previousHash.digest,
      },
      effectsHash: { algorithm: forgedEffectsHash.algorithm, canonicalizationVersion: forgedEffectsHash.canonicalizationVersion, digest: forgedEffectsHash.digest },
    });
    const forgedRevision = { ...acquiredRevision, effects: forgedEffects, effectsHash: forgedEffectsHash, chainHash: forgedChainHash };
    const { contentHash: _forgedHash, ...forgedHashable } = {
      ...current.state,
      lots: [], lotHoldings: [], lotAllocations: [],
      revisions: [...current.state.revisions.slice(0, -1), forgedRevision],
    };
    const forgedState = { ...forgedHashable, contentHash: hashBookState(forgedHashable) } as BookState;
    expect(validateBookState(forgedState).some((item) => item.path === "intent.effects")).toBeTrue();

    const disposed = lotJournal("lot-dispose", ExactRational.of(-1n, 1n), ExactDecimal.of(-4_000n, 2n), ExactRational.of(-100n, 3n));
    current = executeBookCommand(current.state, current.protocol, post(current.state, "dispose-lot", disposed, {
      lotOperations: [{
        type: "dispose", holdingIds: [holding.id], requestedQuantity: ExactRational.of(1n, 1n),
        selection: { method: "fifo" }, derivation,
        identities: [{ holdingId: holding.id, allocationId: lotAllocationId("atomic-allocation") }],
        journalPostingId: disposed.postings[0]!.id,
      }],
    }));
    expect(current.result.disposition).toBe("committed");
    expect(current.state.lotHoldings[0]?.remainingQuantity.equals(ExactRational.of(2n, 1n))).toBeTrue();
    expect(current.state.lotAllocations[0]?.allocation.allocatedTotalBasis.equals(ExactRational.of(100n, 3n))).toBeTrue();
    expect(current.state.revisions.at(-1)?.effects.some((effect) => effect.type === "lotState")).toBeTrue();
  });

  test("quantization proof is part of resolved admission", () => {
    const value = journal("quantization-proof");
    const bad = resolveJournal(
      value, [policy], IDS.owner, quantizationPolicy,
      [ExactRational.of(99n, 1n), ExactRational.of(-99n, 1n)],
    );
    expect(Array.isArray(bad)).toBeTrue();
  });
});

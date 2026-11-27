import { describe, expect, test } from "bun:test";
import {
  ExactDecimal,
  ExactRational,
  accountId,
  bookId,
  closePackageId,
  commandId,
  commitBookIntent,
  commodityId,
  createBookState,
  derivationId,
  dimensionId,
  dimensionMemberId,
  evaluateBookCommand,
  executeBookCommand,
  fiscalCalendarId,
  fiscalPeriodId,
  hashBookState,
  hashBookConfiguration,
  hashCanonical,
  hashFinancialIdentity,
  hashQuantizationPolicy,
  instant,
  localDate,
  lotAllocationId,
  lotHoldingId,
  lotId,
  policyId,
  postingId,
  quantizationPolicyId,
  resolveJournal,
  sealCommand,
  semanticVersion,
  validateBookState,
  type AtomicBookCommit,
  type BookCommand,
  type BookFinancialIdentity,
  type BookState,
  type JournalAdmissionSnapshot,
  type JournalTransaction,
  type LotOperation,
  type ResolvedTransaction,
} from "../src/index.ts";
import {
  IDS,
  closePackageId as fixtureClosePackageId,
  freshState,
  identity,
  journal,
  policy,
  quantizationPolicy,
  reportHash,
  reportPolicyHash,
  resolved,
} from "./fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";

function times(issued = "2026-01-15T14:00:00Z") {
  const milliseconds = Date.parse(issued);
  return {
    issuedAt: instant(issued),
    completedAt: instant(new Date(milliseconds + 1_000).toISOString()),
    committedAt: instant(new Date(milliseconds + 2_000).toISOString()),
  };
}

function rehash(state: BookState, changes: Partial<BookState>): BookState {
  const merged = { ...state, ...changes } as BookState;
  const { contentHash: _contentHash, ...hashable } = merged;
  return Object.freeze({ ...hashable, contentHash: hashBookState(hashable) }) as BookState;
}

function activate(): AtomicBookCommit {
  const fresh = freshState();
  return executeBookCommand(fresh.state, fresh.protocol, activationCommand());
}

test("ACC-021/038: commit retains no caller-owned intent arrays or command aliases", () => {
  const current = activate();
  const evaluated = evaluateBookCommand(current.state, current.protocol, postCommand(current.state, "caller-owned-intent", journal("caller-owned-journal")));
  expect(evaluated.disposition).toBe("ready");
  if (evaluated.disposition !== "ready") return;
  const effects = [...evaluated.intent.effects];
  const command = { ...evaluated.intent.command };
  const supplied = { ...evaluated.intent, command, effects };
  const committed = commitBookIntent(current.state, current.protocol, supplied);
  expect(committed.result.disposition).toBe("committed");
  effects.length = 0;
  command.actorId = "changed-after-commit" as never;
  expect(committed.state.revisions.at(-1)!.effects).toHaveLength(1);
  expect(committed.state.revisions.at(-1)!.command.actorId).toBe(IDS.actor);
  expect(committed.protocol.retainedResults.at(-1)!.command.actorId).toBe(IDS.actor);
  expect(validateBookState(committed.state)).toEqual([]);
});

function postCommand(state: BookState, id: string, transaction: JournalTransaction, lotOperations?: readonly LotOperation[]): Extract<BookCommand, { readonly type: "postJournal" }> {
  return sealCommand({
    id: commandId(id), type: "postJournal", protocolVersion: semanticVersion("1.0.0"),
    bookId: IDS.book, expectedBookRevision: state.bookRevision, ...times(`${transaction.accountingDate}T14:00:00Z`), actorId: IDS.actor,
    resolved: resolved(transaction), ...(lotOperations === undefined ? {} : { lotOperations }),
  });
}

function rejectCode(state: BookState, command: BookCommand, code: string): void {
  const result = executeBookCommand(state, freshState().protocol, command);
  expect(result.result.disposition).toBe("rejected");
  expect(result.result.diagnostics.some((item) => item.code === code)).toBeTrue();
}

function activationFor(state: BookState, id: string): BookCommand {
  return sealCommand({ ...activationCommand(id), expectedBookRevision: state.bookRevision });
}

function resolvedWithQuantization(transaction: JournalTransaction, selectedQuantizationPolicy = quantizationPolicy): ResolvedTransaction {
  const result = resolveJournal(transaction, [policy], IDS.owner, selectedQuantizationPolicy, transaction.postings.map((posting) => posting.bookValue.amount.toRational()));
  if (Array.isArray(result)) throw new Error(result.map((item) => item.message).join("; "));
  return result as ResolvedTransaction;
}

function closeCommand(state: BookState, id: string, packageId: string): BookCommand {
  return sealCommand({
    id: commandId(id), type: "closePeriod", protocolVersion: semanticVersion("1.0.0"), bookId: IDS.book,
    expectedBookRevision: state.bookRevision, ...times("2026-02-01T00:00:00Z"), actorId: IDS.actor,
    periodId: IDS.period1, closePackageId: closePackageId(packageId), reason: "close",
    reportPopulationHash: reportHash, reportingPolicySnapshotHash: reportPolicyHash,
  });
}

describe("hostile book protocol", () => {
  test("rejects command, book, state, and activation identity failures", () => {
    const fresh = freshState();
    const sealed = activationFor(fresh.state, "hostile-valid");
    rejectCode(fresh.state, Object.freeze({ ...sealed, inputHash: hashCanonical({ bad: "input" }) }), "command_identity_conflict");
    rejectCode(fresh.state, sealCommand({ ...activationCommand("hostile-version"), protocolVersion: semanticVersion("2.0.0") }), "unresolved_accounting_input");
    rejectCode(fresh.state, sealCommand({ ...activationCommand("hostile-book"), bookId: bookId("other-book") }), "book_isolation_violation");

    const incomplete = rehash(fresh.state, { identity: { ...fresh.state.identity, code: "" } });
    rejectCode(incomplete, activationFor(incomplete, "hostile-incomplete"), "immutable_book_identity");

    const damaged = Object.freeze({ ...fresh.state, status: "open" as const });
    rejectCode(damaged, activationFor(damaged, "hostile-state-hash"), "ordered_history_violation");

    const active = activate();
    rejectCode(active.state, activationFor(active.state, "hostile-reactivate"), "fabricated_opening_journal");
    rejectCode(fresh.state, sealCommand({
      ...activationCommand("hostile-lots-without-opening"),
      lotOperations: [{
        type: "dispose", holdingIds: [], requestedQuantity: ExactRational.of(1n, 1n), selection: { method: "fifo" },
        derivation: derivation(), identities: [], journalPostingId: postingId("unused-posting"),
      }],
    }), "unresolved_accounting_input");
    rejectCode(fresh.state, sealCommand({
      ...activationCommand("hostile-opening-kind"), mode: "migration", opening: resolved(journal("not-opening")),
    }), "fabricated_opening_journal");

    const badPinnedRevision = active.state.revisions.map((revision, index) => index === 0
      ? { ...revision, effects: revision.effects.map((effect) => effect.type === "activation" ? { ...effect, financialIdentityHash: hashCanonical({ foreign: true }) } : effect) }
      : revision);
    const badPinned = rehash(active.state, { revisions: badPinnedRevision as BookState["revisions"] });
    rejectCode(badPinned, postCommand(badPinned, "hostile-pinned", journal("hostile-pinned-journal")), "immutable_book_identity");
  });

  test("rejects every invalid fiscal and policy configuration boundary", () => {
    const fresh = freshState();
    const base = fresh.state;
    const p1 = base.periods[0]!;
    const p2 = base.periods[1]!;
    const invalidStates: BookState[] = [];

    invalidStates.push(rehash(base, { periods: [] }));
    invalidStates.push(rehash(base, { periods: [{ ...p1, id: p2.id }, p2] }));
    invalidStates.push(rehash(base, { periods: [{ ...p1, calendarId: fiscalCalendarId("other-calendar") }, p2] }));
    invalidStates.push(rehash(base, { periods: [{ ...p1, startsOn: localDate("2026-02-01") }, p2] }));
    invalidStates.push(rehash(base, { periods: [{ ...p1, sequence: 0n }, p2] }));
    invalidStates.push(rehash(base, { periods: [p1, { ...p2, sequence: p1.sequence }] }));
    invalidStates.push(rehash(base, { periods: [p1, { ...p2, startsOn: localDate("2026-02-02") }] }));

    invalidStates.push(rehash(base, { quantizationPolicies: [{ ...quantizationPolicy, id: quantizationPolicyId("duplicate") }, { ...quantizationPolicy, id: quantizationPolicyId("duplicate") }] }));
    invalidStates.push(rehash(base, { quantizationPolicies: [{ ...quantizationPolicy, bookId: bookId("other-book") }] }));
    invalidStates.push(rehash(base, { quantizationPolicies: [{ ...quantizationPolicy, functionalCommodityId: commodityId("EUR") }] }));
    invalidStates.push(rehash(base, { quantizationPolicies: [{ ...quantizationPolicy, validTo: quantizationPolicy.validFrom }] }));
    invalidStates.push(rehash(base, { quantizationPolicies: [{ ...quantizationPolicy, roundingAccountId: accountId("missing-account") }] }));

    invalidStates.push(rehash(base, { policies: [{ ...policy, validTo: policy.validFrom }] }));
    invalidStates.push(rehash(base, { policies: [policy, { ...policy, requiredDimensionIds: ["dimension-x" as never] }] }));
    invalidStates.push(rehash(base, { policies: [policy, { ...policy }] }));

    const badIdentity: BookFinancialIdentity = { ...identity, accountingTimeZone: "Not/A_Timezone" };
    invalidStates.push(rehash(base, { identity: badIdentity, financialIdentityHash: hashFinancialIdentity(badIdentity) }));

    for (const [index, state] of invalidStates.entries()) {
      const result = executeBookCommand(state, fresh.protocol, activationFor(state, `invalid-config-${index}`));
      expect(result.result.disposition).toBe("rejected");
      expect(result.result.diagnostics.length).toBeGreaterThan(0);
    }

    const oneDay = Object.freeze({ ...p1, endsOn: p1.startsOn });
    const afterOneDay = Object.freeze({ ...p2, startsOn: localDate("2026-01-02"), endsOn: localDate("2026-01-31") });
    expect(evaluateBookCommand(freshState([oneDay, afterOneDay]).state, fresh.protocol, activationFor(freshState([oneDay, afterOneDay]).state, "one-day-period")).disposition).toBe("ready");

    const overlapCases = [
      [Object.freeze({ ...p1, id: fiscalPeriodId("overlap-left-a"), startsOn: localDate("2026-01-31"), endsOn: localDate("2026-02-05") }), Object.freeze({ ...p2, id: fiscalPeriodId("overlap-right-a"), startsOn: localDate("2026-01-01"), endsOn: localDate("2026-01-31") })],
      [Object.freeze({ ...p1, id: fiscalPeriodId("overlap-left-b"), startsOn: localDate("2026-01-01"), endsOn: localDate("2026-01-31") }), Object.freeze({ ...p2, id: fiscalPeriodId("overlap-right-b"), startsOn: localDate("2026-01-31"), endsOn: localDate("2026-02-05") })],
    ] as const;
    for (const [index, overlapPeriods] of overlapCases.entries()) {
      const overlapState = freshState(overlapPeriods).state;
      const evaluated = evaluateBookCommand(overlapState, fresh.protocol, activationFor(overlapState, `exact-overlap-${index}`));
      expect(evaluated.disposition).toBe("finished");
      if (evaluated.disposition === "finished") expect(evaluated.result.diagnostics.some((item) => item.path === "periods" && item.message.endsWith(" overlap"))).toBeTrue();
    }

    const sameStart = [
      Object.freeze({ ...p1, id: fiscalPeriodId("same-start-short"), startsOn: localDate("2026-01-01"), endsOn: localDate("2026-01-10") }),
      Object.freeze({ ...p2, id: fiscalPeriodId("same-start-long"), startsOn: localDate("2026-01-01"), endsOn: localDate("2026-01-20") }),
    ];
    const sameStartState = freshState(sameStart).state;
    const sameStartEvaluation = evaluateBookCommand(sameStartState, fresh.protocol, activationFor(sameStartState, "same-start-order"));
    expect(sameStartEvaluation.disposition).toBe("finished");
    if (sameStartEvaluation.disposition === "finished") expect(sameStartEvaluation.result.diagnostics.some((item) => item.message === "Regular periods same-start-long and same-start-short are not gap-free")).toBeTrue();

    const conflictingPolicies = rehash(base, { policies: [policy, { ...policy, requiredDimensionIds: [dimensionId("conflicting-dimension")] }] });
    const conflictEvaluation = evaluateBookCommand(conflictingPolicies, fresh.protocol, activationFor(conflictingPolicies, "conflicting-policy-content"));
    expect(conflictEvaluation.disposition).toBe("finished");
    if (conflictEvaluation.disposition === "finished") expect(conflictEvaluation.result.diagnostics.some((item) => item.message.includes("conflicting complete content"))).toBeTrue();
  });

  test("rejects journal policy, period, posting identity, and topology failures", () => {
    const fresh = freshState();
    rejectCode(fresh.state, postCommand(fresh.state, "before-activation", journal("before-activation-journal")), "unresolved_accounting_input");
    const active = activate();
    rejectCode(active.state, postCommand(active.state, "bad-post-kind", journal("bad-post-kind-journal", "2026-01-15", "opening")), "invalid_journal_structure");

    const foreignJournal = { ...journal("foreign-journal"), bookId: bookId("other-book") } as JournalTransaction;
    const foreignResolved = { ...resolved(journal("foreign-journal")), journal: foreignJournal } as ResolvedTransaction;
    rejectCode(active.state, sealCommand({
      id: commandId("foreign-journal-command"), type: "postJournal", protocolVersion: semanticVersion("1.0.0"), bookId: IDS.book,
      expectedBookRevision: active.state.bookRevision, ...times(), actorId: IDS.actor, resolved: foreignResolved,
    }), "book_isolation_violation");

    const first = executeBookCommand(active.state, active.protocol, postCommand(active.state, "posting-first", journal("posting-first-journal")));
    const reused = journal("posting-reused-journal");
    const reusedJournal = { ...reused, postings: [{ ...reused.postings[0]!, id: first.state.journals[0]!.journal.postings[0]!.id }, reused.postings[1]!] } as JournalTransaction;
    rejectCode(first.state, postCommand(first.state, "posting-reused", reusedJournal), "canonical_identity_conflict");

    const noRegular = rehash(active.state, { periods: active.state.periods.map((period) => ({ ...period, kind: "adjustment" as const })) });
    rejectCode(noRegular, postCommand(noRegular, "no-regular", journal("no-regular-journal")), "fiscal_period_admission");
    rejectCode(active.state, sealCommand({ ...postCommand(active.state, "wrong-explicit-period", journal("wrong-explicit-period-journal")), fiscalPeriodId: IDS.period2 }), "fiscal_period_admission");

    for (const [id, date] of [["period-start", "2026-01-01"], ["period-end", "2026-01-31"]] as const) {
      const endpoint = postCommand(active.state, `explicit-${id}`, journal(`explicit-${id}-journal`, date));
      expect(evaluateBookCommand(active.state, active.protocol, sealCommand({ ...endpoint, fiscalPeriodId: IDS.period1 })).disposition).toBe("ready");
    }

    const adjustmentPeriod = Object.freeze({ ...active.state.periods[0]!, id: fiscalPeriodId("adjustment-january"), kind: "adjustment" as const, sequence: 3n });
    const adjustmentFresh = freshState([...active.state.periods, adjustmentPeriod]);
    const adjustmentActive = executeBookCommand(adjustmentFresh.state, adjustmentFresh.protocol, activationFor(adjustmentFresh.state, "adjustment-activate"));
    const ordinaryInAdjustment = sealCommand({ ...postCommand(adjustmentActive.state, "ordinary-adjustment-period", journal("ordinary-adjustment-period-journal")), fiscalPeriodId: adjustmentPeriod.id });
    rejectCode(adjustmentActive.state, ordinaryInAdjustment, "fiscal_period_admission");
    const adjustmentJournal = journal("adjustment-period-journal", "2026-01-15", "adjustment");
    const adjustmentCommand = sealCommand({ ...postCommand(adjustmentActive.state, "adjustment-period-command", adjustmentJournal), fiscalPeriodId: adjustmentPeriod.id });
    expect(evaluateBookCommand(adjustmentActive.state, adjustmentActive.protocol, adjustmentCommand).disposition).toBe("ready");

    const startPolicy = Object.freeze({ ...quantizationPolicy, validFrom: localDate("2026-01-15") });
    const atStartState = rehash(active.state, { quantizationPolicies: [startPolicy] });
    const atStartJournal = journal("quantization-valid-from", "2026-01-15");
    const atStartCommand = sealCommand({ ...postCommand(atStartState, "quantization-valid-from-command", atStartJournal), resolved: resolvedWithQuantization(atStartJournal, startPolicy) });
    expect(evaluateBookCommand(atStartState, active.protocol, atStartCommand).disposition).toBe("ready");

    const endPolicy = Object.freeze({ ...quantizationPolicy, validTo: localDate("2026-01-15") });
    const atEndState = rehash(active.state, { quantizationPolicies: [endPolicy] });
    const atEndJournal = journal("quantization-valid-to", "2026-01-15");
    const atEndResolved = Object.freeze({ ...resolved(atEndJournal), quantizationPolicy: endPolicy, quantizationPolicySnapshotHash: hashQuantizationPolicy(endPolicy) });
    const atEndCommand = sealCommand({ ...postCommand(atEndState, "quantization-valid-to-command", atEndJournal), resolved: atEndResolved });
    rejectCode(atEndState, atEndCommand, "policy_ambiguity");

    const badPolicyIdentity = { ...resolved(journal("bad-policy-identity")), policyApplications: [{ ...resolved(journal("policy-template")).policyApplications[0]!, policyVersion: semanticVersion("9.0.0") }, resolved(journal("policy-template-2")).policyApplications[1]!] } as ResolvedTransaction;
    rejectCode(active.state, sealCommand({ ...postCommand(active.state, "bad-policy-command", journal("bad-policy-command-journal")), resolved: badPolicyIdentity }), "policy_ambiguity");
    const badPolicyHash = { ...resolved(journal("bad-policy-hash")), policySnapshotHash: hashCanonical({ bad: "policy" }) } as ResolvedTransaction;
    rejectCode(active.state, sealCommand({ ...postCommand(active.state, "bad-policy-hash-command", journal("bad-policy-hash-command-journal")), resolved: badPolicyHash }), "policy_ambiguity");
    const badQuantization = { ...resolved(journal("bad-quantization")), quantizationPolicySnapshotHash: hashCanonical({ bad: "quantization" }) } as ResolvedTransaction;
    rejectCode(active.state, sealCommand({ ...postCommand(active.state, "bad-quantization-command", journal("bad-quantization-command-journal")), resolved: badQuantization }), "policy_ambiguity");

    let closed = executeBookCommand(active.state, active.protocol, closeCommand(active.state, "closed-period-command", "closed-period-package"));
    rejectCode(closed.state, sealCommand({ ...postCommand(closed.state, "post-closed", journal("post-closed-journal")), ...times("2026-02-02T00:00:00Z") }), "fiscal_period_admission");
    rejectCode(active.state, sealCommand({
      ...closeCommand(active.state, "missing-period-close", "missing-period-package"), periodId: fiscalPeriodId("missing-period"),
    }), "fiscal_period_admission");
    rejectCode(active.state, sealCommand({
      ...closeCommand(active.state, "bad-closing-kind", "bad-closing-kind-package"), closing: resolved(journal("bad-closing-kind-journal")),
    }), "fiscal_period_admission");
    rejectCode(active.state, sealCommand({
      id: commandId("reopen-open-period"), type: "reopenPeriod", protocolVersion: semanticVersion("1.0.0"), bookId: IDS.book,
      expectedBookRevision: active.state.bookRevision, ...times(), actorId: IDS.actor, periodId: IDS.period1, reason: "not closed",
    }), "fiscal_period_admission");

    let correctionState = executeBookCommand(active.state, active.protocol, postCommand(active.state, "correction-source-command", journal("correction-source")));
    const notExact = withDerivation(resolved(journal("not-exact-reversal", "2026-01-15", "reversing")));
    rejectCode(correctionState.state, sealCommand({
      id: commandId("not-exact-correction"), type: "correctJournal", protocolVersion: semanticVersion("1.0.0"), bookId: IDS.book,
      expectedBookRevision: correctionState.state.bookRevision, ...times(), actorId: IDS.actor, correctionKind: "reversal",
      originalJournalId: "correction-source", resolved: notExact,
    }), "invalid_correction_topology");
    const wrongKind = withDerivation(resolved(journal("wrong-kind-correction", "2026-01-15", "reversing", true)));
    rejectCode(correctionState.state, sealCommand({
      id: commandId("wrong-kind-correction-command"), type: "correctJournal", protocolVersion: semanticVersion("1.0.0"), bookId: IDS.book,
      expectedBookRevision: correctionState.state.bookRevision, ...times(), actorId: IDS.actor, correctionKind: "supersession",
      originalJournalId: "correction-source", resolved: wrongKind,
    }), "invalid_correction_topology");
    const exactButOrdinary = withDerivation(resolved(journal("ordinary-kind-reversal", "2026-01-15", "ordinary", true)));
    rejectCode(correctionState.state, sealCommand({
      id: commandId("ordinary-kind-reversal-command"), type: "correctJournal", protocolVersion: semanticVersion("1.0.0"), bookId: IDS.book,
      expectedBookRevision: correctionState.state.bookRevision, ...times(), actorId: IDS.actor, correctionKind: "reversal",
      originalJournalId: "correction-source", resolved: exactButOrdinary,
    }), "invalid_correction_topology");
  });

  test("executes transfer continuity and rejects malformed atomic lot operations", () => {
    let current = activate();
    const acquiredJournal = lotJournal("hostile-acquire", ExactRational.of(3n, 1n), ExactDecimal.of(300n, 2n), ExactRational.of(3n, 1n));
    const lot = Object.freeze({
      id: lotId("hostile-lot"), bookId: IDS.book, commodityId: IDS.usd, acquiredAt: acquiredJournal.economicAt,
      acquisitionQuantity: ExactRational.of(3n, 1n), acquisitionTotalBasis: ExactRational.of(3n, 1n), basisCommodityId: IDS.usd,
      evidenceIds: Object.freeze(["hostile-evidence" as never]),
    });
    const holding = Object.freeze({
      id: lotHoldingId("hostile-holding"), bookId: IDS.book, lotId: lot.id, accountId: IDS.cash,
      commodityId: IDS.usd, basisCommodityId: IDS.usd, remainingQuantity: ExactRational.of(3n, 1n), remainingTotalBasis: ExactRational.of(3n, 1n), remainingValuationAllowance: ExactRational.zero(), remainingCarryingAmount: ExactRational.of(3n, 1n),
    });
    current = executeBookCommand(current.state, current.protocol, postCommand(current.state, "hostile-acquire-command", acquiredJournal, [
      { type: "acquire", lot, holding, journalPostingId: acquiredJournal.postings[0]!.id },
    ]));
    expect(current.result.disposition).toBe("committed");

    const duplicateAcquisition = lotJournal("hostile-acquire-duplicate", ExactRational.of(3n, 1n), ExactDecimal.of(300n, 2n), ExactRational.of(3n, 1n));
    rejectCode(current.state, postCommand(current.state, "hostile-acquire-duplicate-command", duplicateAcquisition, [
      { type: "acquire", lot, holding, journalPostingId: duplicateAcquisition.postings[0]!.id },
    ]), "canonical_identity_conflict");
    const uniqueLot = { ...lot, id: lotId("hostile-unique-lot") };
    rejectCode(current.state, postCommand(current.state, "hostile-holding-duplicate-command", duplicateAcquisition, [
      { type: "acquire", lot: uniqueLot, holding: { ...holding, lotId: uniqueLot.id }, journalPostingId: duplicateAcquisition.postings[0]!.id },
    ]), "canonical_identity_conflict");
    const duplicateLotUniqueHolding = { ...holding, id: lotHoldingId("hostile-unique-holding") };
    rejectCode(current.state, postCommand(current.state, "hostile-lot-only-duplicate-command", duplicateAcquisition, [
      { type: "acquire", lot, holding: duplicateLotUniqueHolding, journalPostingId: duplicateAcquisition.postings[0]!.id },
    ]), "canonical_identity_conflict");

    const unresolvedDispose = lotJournal("hostile-dispose-unresolved", ExactRational.of(-1n, 1n), ExactDecimal.of(-100n, 2n), ExactRational.of(-1n, 1n));
    rejectCode(current.state, postCommand(current.state, "hostile-dispose-unresolved-command", unresolvedDispose, [{
      type: "dispose", holdingIds: [lotHoldingId("missing-holding")], requestedQuantity: ExactRational.of(1n, 1n), selection: { method: "fifo" },
      derivation: derivation(), identities: [{ holdingId: lotHoldingId("missing-holding"), allocationId: lotAllocationId("missing-allocation") }], journalPostingId: unresolvedDispose.postings[0]!.id,
    }]), "lot_overallocation");

    const malformedDispose = lotJournal("hostile-dispose-bad", ExactRational.of(-1n, 1n), ExactDecimal.of(-100n, 2n), ExactRational.of(-2n, 1n));
    rejectCode(current.state, postCommand(current.state, "hostile-dispose-bad-command", malformedDispose, [{
      type: "dispose", holdingIds: [holding.id], requestedQuantity: ExactRational.of(1n, 1n), selection: { method: "specificIdentification", allocations: [{ holdingId: holding.id, quantity: ExactRational.of(1n, 1n) }] },
      derivation: derivation(), identities: [{ holdingId: holding.id, allocationId: lotAllocationId("hostile-dispose-bad-allocation") }], journalPostingId: malformedDispose.postings[0]!.id,
    }]), "lot_overallocation");

    const noCostBasisJournal = lotJournal("hostile-dispose-no-cost-basis", ExactRational.of(-1n, 1n), ExactDecimal.of(-100n, 2n), ExactRational.of(-1n, 1n));
    const noCostBasisResolved = { ...noCostBasisJournal, postings: [{ ...noCostBasisJournal.postings[0]!, costBasis: undefined }, noCostBasisJournal.postings[1]!] } as JournalTransaction;
    rejectCode(current.state, postCommand(current.state, "hostile-dispose-no-cost-basis-command", noCostBasisResolved, [{
      type: "dispose", holdingIds: [holding.id], requestedQuantity: ExactRational.of(1n, 1n), selection: { method: "fifo" },
      derivation: derivation(), identities: [{ holdingId: holding.id, allocationId: lotAllocationId("hostile-no-cost-basis-allocation") }], journalPostingId: noCostBasisResolved.postings[0]!.id,
    }]), "lot_overallocation");

    const disposed = lotJournal("hostile-dispose-good", ExactRational.of(-1n, 1n), ExactDecimal.of(-100n, 2n), ExactRational.of(-1n, 1n));
    const duplicateAllocationId = lotAllocationId("hostile-reused-allocation");
    current = executeBookCommand(current.state, current.protocol, postCommand(current.state, "hostile-dispose-good-command", disposed, [{
      type: "dispose", holdingIds: [holding.id], requestedQuantity: ExactRational.of(1n, 1n), selection: { method: "fifo" },
      derivation: derivation(), identities: [{ holdingId: holding.id, allocationId: duplicateAllocationId }], journalPostingId: disposed.postings[0]!.id,
    }]));
    expect(current.result.disposition).toBe("committed");
    const duplicateAllocationJournal = lotJournal("hostile-dispose-duplicate-allocation", ExactRational.of(-1n, 1n), ExactDecimal.of(-100n, 2n), ExactRational.of(-1n, 1n));
    rejectCode(current.state, postCommand(current.state, "hostile-dispose-duplicate-allocation-command", duplicateAllocationJournal, [{
      type: "dispose", holdingIds: [holding.id], requestedQuantity: ExactRational.of(1n, 1n), selection: { method: "fifo" },
      derivation: derivation(), identities: [{ holdingId: holding.id, allocationId: duplicateAllocationId }], journalPostingId: duplicateAllocationJournal.postings[0]!.id,
    }]), "canonical_identity_conflict");

    const transferJournal = lotJournal("hostile-transfer", ExactRational.of(-1n, 1n), ExactDecimal.of(-100n, 2n));
    const transferResolvedJournal = { ...transferJournal, postings: [transferJournal.postings[0]!, { ...transferJournal.postings[1]!, accountId: IDS.revenue }] } as JournalTransaction;
    const transferPolicy = Object.freeze({
      id: policyId("hostile-transfer-policy"), version: semanticVersion("1.0.0"), bookId: IDS.book,
      sourceAccountId: IDS.cash, destinationAccountId: IDS.revenue, validFrom: instant("2020-01-01T00:00:00Z"), treatment: "continuity" as const,
    });
    const transfer = {
      type: "transfer", sourceHoldingIds: [holding.id], destinationAccountId: IDS.revenue, requestedQuantity: ExactRational.of(1n, 1n),
      selection: { method: "specificIdentification", allocations: [{ holdingId: holding.id, quantity: ExactRational.of(1n, 1n) }] }, policies: [transferPolicy],
      governedAt: transferResolvedJournal.economicAt, derivation: derivation(),
      allocationIdentities: [{ holdingId: holding.id, allocationId: lotAllocationId("hostile-transfer-allocation") }],
      destinationIdentities: [{ sourceHoldingId: holding.id, destinationHoldingId: lotHoldingId("hostile-destination-holding") }],
      sourcePostingId: transferResolvedJournal.postings[0]!.id, destinationPostingId: transferResolvedJournal.postings[1]!.id,
    } satisfies Extract<LotOperation, { readonly type: "transfer" }>;
    rejectCode(current.state, postCommand(current.state, "hostile-transfer-topology-command", transferResolvedJournal, [
      { ...transfer, sourceHoldingIds: [lotHoldingId("missing-transfer-source")] },
    ]), "lot_overallocation");
    rejectCode(current.state, postCommand(current.state, "hostile-transfer-reacquire-command", transferResolvedJournal, [
      { ...transfer, policies: [{ ...transferPolicy, treatment: "disposalAndReacquisition" }] },
    ]), "transfer_policy_missing");
    rejectCode(current.state, postCommand(current.state, "hostile-transfer-duplicate-allocation-command", transferResolvedJournal, [
      { ...transfer, allocationIdentities: [{ holdingId: holding.id, allocationId: duplicateAllocationId }] },
    ]), "canonical_identity_conflict");
    const fifoTransferCommand = postCommand(current.state, "hostile-transfer-fifo-command", transferResolvedJournal, [
      { ...transfer, selection: { method: "fifo" } },
    ]);
    expect(evaluateBookCommand(current.state, current.protocol, fifoTransferCommand).disposition).toBe("ready");
    current = executeBookCommand(current.state, current.protocol, postCommand(current.state, "hostile-transfer-command", transferResolvedJournal, [transfer]));
    expect(current.result.disposition).toBe("committed");
    expect(current.state.lotHoldings.filter((item) => item.id === lotHoldingId("hostile-destination-holding"))).toHaveLength(1);
    expect(current.state.lotHoldings.find((item) => item.id === lotHoldingId("hostile-destination-holding"))?.remainingQuantity.equals(ExactRational.of(1n, 1n))).toBeTrue();

    const secondTransferJournal = lotJournal("hostile-transfer-second", ExactRational.of(-1n, 1n), ExactDecimal.of(-100n, 2n));
    const secondTransferResolved = { ...secondTransferJournal, postings: [secondTransferJournal.postings[0]!, { ...secondTransferJournal.postings[1]!, accountId: IDS.revenue }] } as JournalTransaction;
    const secondTransfer = {
      ...transfer,
      selection: { method: "specificIdentification" as const, allocations: [{ holdingId: holding.id, quantity: ExactRational.of(1n, 1n) }] },
      governedAt: secondTransferResolved.economicAt,
      allocationIdentities: [{ holdingId: holding.id, allocationId: lotAllocationId("hostile-transfer-allocation-second") }],
      sourcePostingId: secondTransferResolved.postings[0]!.id,
      destinationPostingId: secondTransferResolved.postings[1]!.id,
    };
    current = executeBookCommand(current.state, current.protocol, postCommand(current.state, "hostile-transfer-second-command", secondTransferResolved, [secondTransfer]));
    expect(current.result.disposition).toBe("committed");
    expect(current.state.lotHoldings.filter((item) => item.id === lotHoldingId("hostile-destination-holding"))).toHaveLength(1);
    expect(current.state.lotHoldings.find((item) => item.id === lotHoldingId("hostile-destination-holding"))?.remainingQuantity.equals(ExactRational.of(2n, 1n))).toBeTrue();
    const retainedTransfer = current.state.revisions.at(-1)?.command;
    if (retainedTransfer?.type === "postJournal" && retainedTransfer.lotOperations?.[0]?.type === "transfer" && retainedTransfer.lotOperations[0].selection.method === "specificIdentification") {
      expect(Object.isFrozen(retainedTransfer.lotOperations[0].selection.allocations)).toBeTrue();
    } else throw new Error("Expected retained specific-identification transfer");
  });

  test("exercises closing journals, reversal reopening, and prospective configuration", () => {
    let current = activate();
    const closing = withDerivation(resolved(journal("hostile-closing", "2026-01-31", "closing")));
    current = executeBookCommand(current.state, current.protocol, sealCommand({
      id: commandId("hostile-close"), type: "closePeriod", protocolVersion: semanticVersion("1.0.0"), bookId: IDS.book,
      expectedBookRevision: current.state.bookRevision, ...times("2026-02-01T00:00:00Z"), actorId: IDS.actor,
      periodId: IDS.period1, closePackageId: fixtureClosePackageId("hostile-close-package"), reason: "close",
      reportPopulationHash: reportHash, reportingPolicySnapshotHash: reportPolicyHash, closing,
    }));
    expect(current.result.disposition).toBe("committed");

    rejectCode(current.state, sealCommand({
      id: commandId("hostile-reopen-missing-reversal"), type: "reopenPeriod", protocolVersion: semanticVersion("1.0.0"), bookId: IDS.book,
      expectedBookRevision: current.state.bookRevision, ...times("2026-02-02T00:00:00Z"), actorId: IDS.actor, periodId: IDS.period1, reason: "missing reversal",
    }), "invalid_correction_topology");

    const badReversal = withDerivation(resolved(journal("hostile-bad-reversal", "2026-01-31", "reversing")));
    rejectCode(current.state, sealCommand({
      id: commandId("hostile-reopen-bad-reversal"), type: "reopenPeriod", protocolVersion: semanticVersion("1.0.0"), bookId: IDS.book,
      expectedBookRevision: current.state.bookRevision, ...times("2026-02-02T00:00:00Z"), actorId: IDS.actor, periodId: IDS.period1, reason: "bad reversal", reversal: badReversal,
    }), "invalid_correction_topology");

    const reversal = withDerivation(resolved(journal("hostile-closing-reversal", "2026-01-31", "reversing", true)));
    current = executeBookCommand(current.state, current.protocol, sealCommand({
      id: commandId("hostile-reopen"), type: "reopenPeriod", protocolVersion: semanticVersion("1.0.0"), bookId: IDS.book,
      expectedBookRevision: current.state.bookRevision, ...times("2026-02-02T00:00:00Z"), actorId: IDS.actor, periodId: IDS.period1, reason: "reopen", reversal,
    }));
    expect(current.result.disposition).toBe("committed");
    const futureClose = { ...current.state, closePackages: current.state.closePackages.map((close) => ({ ...close, throughBookRevision: current.state.bookRevision })) };
    // A corrupted row at the reopen revision must not become a source for
    // reconstructing that same revision, even if other integrity checks reject it too.
    expect(validateBookState(futureClose).filter((d) => d.path === "intent.effects" && d.code === "ordered_history_violation")).toHaveLength(1);

    rejectCode(current.state, sealCommand({
      id: commandId("hostile-config-retroactive"), type: "replaceConfiguration", protocolVersion: semanticVersion("1.0.0"), bookId: IDS.book,
      expectedBookRevision: current.state.bookRevision, ...times("2026-03-01T00:00:00Z"), actorId: IDS.actor,
      effectiveOn: localDate("2026-01-31"), periods: current.state.periods, admissionSnapshot: current.state.admissionSnapshot,
      policies: current.state.policies, quantizationPolicies: current.state.quantizationPolicies,
      expectedConfigurationRevision: current.state.configurationRevision, accountingPolicies: current.state.accountingPolicySnapshot.policies,
    }), "fiscal_period_admission");
  });

  test("requires exact reversal of transaction price and authoritative basis", () => {
    let current = activate();
    const originalBase = journal("priced-source");
    const original = Object.freeze({
      ...originalBase,
      postings: Object.freeze(originalBase.postings.map((posting) => Object.freeze({
        ...posting,
        transactionPrice: Object.freeze({ unitRate: ExactRational.of(1n, 1n), baseCommodityId: IDS.usd, quoteCommodityId: IDS.usd }),
        costBasis: Object.freeze({ totalBasis: posting.units.canonicalNumber, basisCommodityId: IDS.usd }),
      }))),
    });
    current = executeBookCommand(current.state, current.protocol, postCommand(current.state, "priced-source-command", original));
    expect(current.result.disposition).toBe("committed");

    const reverseBase = journal("priced-reversal", "2026-01-15", "reversing", true);
    const reverse = Object.freeze({
      ...reverseBase,
      postings: Object.freeze(reverseBase.postings.map((posting) => Object.freeze({
        ...posting,
        transactionPrice: Object.freeze({ unitRate: ExactRational.of(1n, 1n), baseCommodityId: IDS.usd, quoteCommodityId: IDS.usd }),
        costBasis: Object.freeze({ totalBasis: posting.units.canonicalNumber, basisCommodityId: IDS.usd }),
      }))),
    });
    current = executeBookCommand(current.state, current.protocol, sealCommand({
      id: commandId("priced-reversal-command"), type: "correctJournal", protocolVersion: semanticVersion("1.0.0"), bookId: IDS.book,
      expectedBookRevision: current.state.bookRevision, ...times(), actorId: IDS.actor, correctionKind: "reversal",
      originalJournalId: original.id, resolved: withDerivation(resolved(reverse)),
    }));
    expect(current.result.disposition).toBe("committed");
  });

  test("detects every persisted state and nested effect integrity failure", () => {
    let current = activate();
    current = executeBookCommand(current.state, current.protocol, postCommand(current.state, "restore-post", journal("restore-journal")));
    current = executeBookCommand(current.state, current.protocol, sealCommand({
      id: commandId("restore-close"), type: "closePeriod", protocolVersion: semanticVersion("1.0.0"), bookId: IDS.book,
      expectedBookRevision: current.state.bookRevision, ...times("2026-02-01T00:00:00Z"), actorId: IDS.actor,
      periodId: IDS.period1, closePackageId: closePackageId("restore-close-package"), reason: "close",
      reportPopulationHash: reportHash, reportingPolicySnapshotHash: reportPolicyHash,
    }));
    const badHash = hashCanonical({ damaged: true });
    const revisions = current.state.revisions.map((revision) => ({
      ...revision,
      bookId: revision.bookRevision === 1n ? bookId("wrong-book") : revision.bookId,
      effects: revision.effects.map((effect) => {
        if (effect.type === "activation") return { ...effect, boundary: { ...effect.boundary, contentHash: badHash } };
        if (effect.type === "journal") return { ...effect, booked: { ...effect.booked, canonicalHash: badHash } };
        if (effect.type === "periodTransition") return { ...effect, transition: { ...effect.transition, contentHash: badHash } };
        if (effect.type === "closePackage") return { ...effect, closePackage: { ...effect.closePackage, contentHash: badHash } };
        return effect;
      }),
    })) as BookState["revisions"];
    const damaged = { ...current.state, financialIdentityHash: badHash, revisions, latestPostingSequence: 99n, contentHash: badHash } as BookState;
    const diagnostics = validateBookState(damaged);
    expect(diagnostics.some((item) => item.code === "immutable_book_identity")).toBeTrue();
    expect(diagnostics.filter((item) => item.code === "ordered_history_violation").length).toBeGreaterThan(3);

    const evaluated = evaluateBookCommand(freshState().state, freshState().protocol, activationCommand("tamper-boundary-intent"));
    expect(evaluated.disposition).toBe("ready");
    if (evaluated.disposition !== "ready") return;
    const effects = evaluated.intent.effects.map((effect) => effect.type === "activation" ? { ...effect, boundary: { ...effect.boundary, contentHash: badHash } } : effect);
    const rejected = commitBookIntent(freshState().state, freshState().protocol, { ...evaluated.intent, effects });
    expect(rejected.result.disposition).toBe("rejected");

    const configured = evaluateBookCommand(freshState().state, freshState().protocol, sealCommand({
      id: commandId("tamper-config-intent"), type: "replaceConfiguration", protocolVersion: semanticVersion("1.0.0"), bookId: IDS.book,
      expectedBookRevision: 0n, ...times(), actorId: IDS.actor, effectiveOn: localDate("2026-03-01"),
      periods: freshState().state.periods, admissionSnapshot: freshState().state.admissionSnapshot,
      policies: freshState().state.policies, quantizationPolicies: freshState().state.quantizationPolicies,
      expectedConfigurationRevision: freshState().state.configurationRevision, accountingPolicies: freshState().state.accountingPolicySnapshot.policies,
    }));
    expect(configured.disposition).toBe("ready");
    if (configured.disposition === "ready") {
      const badEffects = configured.intent.effects.map((effect) => effect.type === "configuration" ? { ...effect, contentHash: badHash } : effect);
      expect(commitBookIntent(freshState().state, freshState().protocol, { ...configured.intent, effects: badEffects }).result.disposition).toBe("rejected");
    }

    let lots = activate();
    const lotTransaction = lotJournal("tamper-lot-acquire", ExactRational.of(1n, 1n), ExactDecimal.of(100n, 2n), ExactRational.of(1n, 1n));
    const tamperLot = Object.freeze({ id: lotId("tamper-lot"), bookId: IDS.book, commodityId: IDS.usd, acquiredAt: lotTransaction.economicAt,
      acquisitionQuantity: ExactRational.of(1n, 1n), acquisitionTotalBasis: ExactRational.of(1n, 1n), basisCommodityId: IDS.usd, evidenceIds: Object.freeze(["tamper-evidence" as never]) });
    const tamperHolding = Object.freeze({ id: lotHoldingId("tamper-holding"), bookId: IDS.book, lotId: tamperLot.id, accountId: IDS.cash,
      commodityId: IDS.usd, basisCommodityId: IDS.usd, remainingQuantity: ExactRational.of(1n, 1n), remainingTotalBasis: ExactRational.of(1n, 1n), remainingValuationAllowance: ExactRational.zero(), remainingCarryingAmount: ExactRational.of(1n, 1n) });
    const lotEvaluation = evaluateBookCommand(lots.state, lots.protocol, postCommand(lots.state, "tamper-lot-command", lotTransaction, [
      { type: "acquire", lot: tamperLot, holding: tamperHolding, journalPostingId: lotTransaction.postings[0]!.id },
    ]));
    expect(lotEvaluation.disposition).toBe("ready");
    if (lotEvaluation.disposition === "ready") {
      const badEffects = lotEvaluation.intent.effects.map((effect) => effect.type === "lotState" ? { ...effect, lotState: { ...effect.lotState, contentHash: badHash } } : effect);
      expect(commitBookIntent(lots.state, lots.protocol, { ...lotEvaluation.intent, effects: badEffects }).result.disposition).toBe("rejected");
    }
  });

  test("hashes chart dimensions and members into an immutable close package", () => {
    const base = freshState().state;
    const departmentId = dimensionId("department");
    const memberId = dimensionMemberId("department-engineering");
    const regionId = dimensionId("region");
    const westId = dimensionMemberId("region-west");
    const admissionSnapshot: JournalAdmissionSnapshot = {
      ...base.admissionSnapshot,
      dimensions: [
        { id: regionId, bookId: IDS.book, code: "REGION", name: "Region", openedOn: localDate("2020-01-01") },
        { id: departmentId, bookId: IDS.book, code: "DEPT", name: "Department", openedOn: localDate("2020-01-01") },
      ],
      dimensionMembers: [
        { id: westId, dimensionId: regionId, code: "WEST", name: "West", openedOn: localDate("2020-01-01") },
        { id: memberId, dimensionId: departmentId, code: "ENG", name: "Engineering", openedOn: localDate("2020-01-01") },
      ],
      requiredDimensionIdsByPosting: {
        "future-posting-a": [departmentId, regionId],
        "future-posting-b": [regionId],
      },
    };
    const state = createBookState(identity, base.periods, admissionSnapshot, base.policies, base.quantizationPolicies, [], instant("2020-01-01T00:00:00Z"));
    let current = executeBookCommand(state, freshState().protocol, activationFor(state, "dimension-activation"));
    current = executeBookCommand(current.state, current.protocol, closeCommand(current.state, "dimension-close", "dimension-close-package"));
    expect(current.result.disposition).toBe("committed");
    expect(current.state.closePackages).toHaveLength(1);
    expect(Object.isFrozen(current.state.admissionSnapshot.requiredDimensionIdsByPosting?.["future-posting-a"])).toBeTrue();
  });

  test("canonicalizes every multi-item lot and policy command collection", () => {
    const active = activate();
    const transaction = journal("multi-command");
    const firstHolding = lotHoldingId("multi-holding-a");
    const secondHolding = lotHoldingId("multi-holding-b");
    const firstDerivation = derivation();
    const secondDerivation = { ...derivation(), id: derivationId("hostile-derivation-second") };
    const multiResolved = { ...resolved(transaction), derivations: [secondDerivation, firstDerivation] };
    expect(() => sealCommand({
      ...postCommand(active.state, "multi-dispose-base", transaction), id: commandId("multi-dispose"), resolved: multiResolved,
      lotOperations: [{
        type: "dispose", holdingIds: [secondHolding, firstHolding], requestedQuantity: ExactRational.of(2n, 1n),
        selection: { method: "specificIdentification", allocations: [
          { holdingId: secondHolding, quantity: ExactRational.of(1n, 1n) },
          { holdingId: firstHolding, quantity: ExactRational.of(1n, 1n) },
        ] }, derivation: firstDerivation,
        identities: [
          { holdingId: secondHolding, allocationId: lotAllocationId("multi-allocation-b") },
          { holdingId: firstHolding, allocationId: lotAllocationId("multi-allocation-a") },
        ], journalPostingId: transaction.postings[0]!.id,
      }],
    })).not.toThrow();
    expect(() => sealCommand({
      id: commandId("multi-correction"), type: "correctJournal", protocolVersion: semanticVersion("1.0.0"), bookId: IDS.book,
      expectedBookRevision: active.state.bookRevision, ...times(), actorId: IDS.actor, correctionKind: "supersession",
      originalJournalId: "not-retained", resolved: multiResolved,
      lotOperations: [{
        type: "dispose", holdingIds: [firstHolding], requestedQuantity: ExactRational.of(1n, 1n), selection: { method: "fifo" },
        derivation: firstDerivation, identities: [{ holdingId: firstHolding, allocationId: lotAllocationId("multi-correction-allocation") }],
        journalPostingId: transaction.postings[0]!.id,
      }],
    })).not.toThrow();
    const policyA = { id: policyId("multi-transfer-a"), version: semanticVersion("1.0.0"), bookId: IDS.book, sourceAccountId: IDS.cash, destinationAccountId: IDS.revenue, validFrom: instant("2020-01-01T00:00:00Z"), treatment: "continuity" as const };
    const policyB = { ...policyA, id: policyId("multi-transfer-b") };
    expect(() => sealCommand({
      ...postCommand(active.state, "multi-transfer-base", transaction), id: commandId("multi-transfer"), resolved: multiResolved,
      lotOperations: [{
        type: "transfer", sourceHoldingIds: [secondHolding, firstHolding], destinationAccountId: IDS.revenue,
        requestedQuantity: ExactRational.of(2n, 1n), selection: { method: "fifo" }, policies: [policyB, policyA],
        governedAt: transaction.economicAt, derivation: firstDerivation,
        allocationIdentities: [
          { holdingId: secondHolding, allocationId: lotAllocationId("multi-transfer-allocation-b") },
          { holdingId: firstHolding, allocationId: lotAllocationId("multi-transfer-allocation-a") },
        ],
        destinationIdentities: [
          { sourceHoldingId: secondHolding, destinationHoldingId: lotHoldingId("multi-destination-b") },
          { sourceHoldingId: firstHolding, destinationHoldingId: lotHoldingId("multi-destination-a") },
        ], sourcePostingId: transaction.postings[0]!.id, destinationPostingId: transaction.postings[1]!.id,
      }],
    })).not.toThrow();
    const secondQuantization = { ...quantizationPolicy, id: quantizationPolicyId("quantization-usd-second"), version: semanticVersion("2.0.0") };
    expect(hashBookConfiguration(active.state.periods, active.state.admissionSnapshot, active.state.policies, [secondQuantization, quantizationPolicy]).digest).toHaveLength(64);
    const multiQuantizationState = createBookState(identity, active.state.periods, active.state.admissionSnapshot, active.state.policies, [secondQuantization, quantizationPolicy], [], instant("2020-01-01T00:00:00Z"));
    let multiQuantization = executeBookCommand(multiQuantizationState, freshState().protocol, activationFor(multiQuantizationState, "multi-quantization-activate"));
    multiQuantization = executeBookCommand(multiQuantization.state, multiQuantization.protocol, closeCommand(multiQuantization.state, "multi-quantization-close", "multi-quantization-package"));
    expect(multiQuantization.result.disposition).toBe("committed");
  });

  test("orders multi-journal ledgers and rejects close identity reuse across open periods", () => {
    let current = activate();
    current = executeBookCommand(current.state, current.protocol, postCommand(current.state, "ledger-order-one", journal("ledger-order-one-journal")));
    current = executeBookCommand(current.state, current.protocol, postCommand(current.state, "ledger-order-two", journal("ledger-order-two-journal")));
    current = executeBookCommand(current.state, current.protocol, closeCommand(current.state, "ledger-order-close", "shared-close-package"));
    expect(current.result.disposition).toBe("committed");
    const duplicate = sealCommand({
      ...closeCommand(current.state, "ledger-order-second-close", "shared-close-package"),
      periodId: IDS.period2,
    });
    rejectCode(current.state, duplicate, "fiscal_period_admission");
    current = executeBookCommand(current.state, current.protocol, sealCommand({
      ...closeCommand(current.state, "ledger-order-valid-second-close", "second-close-package"),
      periodId: IDS.period2,
    }));
    expect(current.result.disposition).toBe("committed");
  });
});

function derivation() {
  return Object.freeze({
    id: derivationId("hostile-derivation"), policyId: policy.id, policyVersion: policy.version,
    algorithmVersion: semanticVersion("1.0.0"), inputHash: hashCanonical({ hostile: "lot" }), actorId: IDS.actor,
    state: "approved" as const, recordedAt: instant("2026-01-15T13:00:00Z"), evidence: Object.freeze([{ id: "hostile-evidence" as never,
      sourceSystem: "fixture", sourceRecordId: "source", observedAt: instant("2026-01-15T11:00:00Z"), contentHash: hashCanonical({ source: true }) }]),
  });
}

function withDerivation(value: ResolvedTransaction): ResolvedTransaction {
  return Object.freeze({ ...value, derivations: Object.freeze([derivation()]) });
}

function lotJournal(id: string, quantity: ExactRational, amount: ExactDecimal, basis?: ExactRational): JournalTransaction {
  return Object.freeze({
    ...journal(id), narration: id,
    postings: Object.freeze([
      Object.freeze({ ...journal(id).postings[0]!, id: postingId(`${id}-lot`), units: Object.freeze({ canonicalNumber: quantity, commodityId: IDS.usd }),
        bookValue: Object.freeze({ amount, functionalCommodityId: IDS.usd }), ...(basis === undefined ? {} : { costBasis: Object.freeze({ totalBasis: basis, basisCommodityId: IDS.usd }) }) }),
      Object.freeze({ ...journal(id).postings[1]!, id: postingId(`${id}-offset`), units: Object.freeze({ canonicalNumber: quantity.negate(), commodityId: IDS.usd }),
        bookValue: Object.freeze({ amount: amount.negate(), functionalCommodityId: IDS.usd }) }),
    ]),
  });
}

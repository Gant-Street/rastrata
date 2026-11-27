import { expect, test } from "bun:test";
import {
  ExactRational, commandId, instant, openItemId, settlementId, settlementAllocationId,
  createCanonicalPostingReference, canonicalPostingReferenceId, effectKey, sealCommand,
  executeBookCommand, validateBookState, encodeDurableBook, decodeDurableBook, closePackageId,
  hashCanonical, calculateSettlement, settlementReadContext, type BookState,
  localDate, canonicalAccountingValue,
  prepareBookIntent, prepareBookCommitRecords, applyAccountingEffect, hashBookState,
  type ApplySettlementCommand, type BookCommand, type AtomicBookCommit, type SettlementRequest, type SemanticDiagnosticCode,
} from "../src/index.ts";
import { freshState, journal, resolved, IDS } from "./fixtures.ts";
import { accountingDerivation } from "./accounting-fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";

const exact = (value: bigint) => ExactRational.of(value, 1n);
const core = (state: BookState, id: string, at = "2026-01-20T14:00:00Z") => ({
  id: commandId(id), bookId: IDS.book, actorId: IDS.actor, protocolVersion: activationCommand().protocolVersion,
  expectedBookRevision: state.bookRevision, issuedAt: instant(at), completedAt: instant(at), committedAt: instant(at),
});
function fixture(preposted = false) {
  const initial = freshState();
  let current = executeBookCommand(initial.state, initial.protocol, activationCommand());
  const payment = journal("unallocated-payment", "2026-01-15", "ordinary", true);
  const settlement = { id: settlementId("payment"), bookId: IDS.book, kind: "cash" as const,
    scope: { externalPartyId: "customer", controlAccountId: IDS.cash }, settledAt: payment.economicAt,
    settlementSource: createCanonicalPostingReference(canonicalPostingReferenceId("payment"), IDS.book,
      payment.id, payment.postings[0]!, effectKey("payment:journal:0")),
    denominationCommodityId: IDS.usd, denomination: exact(100n), bookValue: exact(100n), derivation: accountingDerivation };
  const recognition = sealCommand({ ...core(current.state, "payment", "2026-01-15T14:00:00Z"), type: "applySettlement",
    resolved: [resolved(payment)], request: { operation: "recognizeUnallocated", settlement, allocations: [] } });
  current = executeBookCommand(current.state, current.protocol, preposted
    ? sealCommand({ ...core(current.state, "payment", "2026-01-15T14:00:00Z"), type: "postJournal", resolved: resolved(payment) })
    : recognition);
  expect(current.result.disposition).toBe("committed");
  for (const id of ["invoice-a", "invoice-b"]) {
    const source = journal(id, "2026-01-20");
    current = executeBookCommand(current.state, current.protocol, sealCommand({ ...core(current.state, id), type: "recognizeOpenItem",
      resolved: resolved(source), request: { value: { id: openItemId(id), bookId: IDS.book, kind: "receivable",
        scope: settlement.scope, recognizedOn: source.accountingDate, denominationCommodityId: IDS.usd,
        denomination: exact(100n), bookValue: exact(100n), derivation: accountingDerivation,
        recognitionSource: createCanonicalPostingReference(canonicalPostingReferenceId(id), IDS.book, source.id,
          source.postings[0]!, effectKey(`${id}:journal:0`)),
      } } }));
    expect(current.result.disposition).toBe("committed");
  }
  const application = (state: BookState, id: string, amount: bigint, target = "invoice-a", at = "2026-01-21T14:00:00Z"): BookCommand & ApplySettlementCommand =>
    sealCommand({ ...core(state, id, at), type: "applySettlement", resolved: [], request: {
      operation: "allocateExisting", appliedAt: instant(at), settlement,
      allocations: [{ id: settlementAllocationId(id), settlementId: settlement.id, openItemId: openItemId(target),
        allocatedBookValue: exact(amount), allocatedOpenQuantity: exact(amount), allocatedSettlementQuantity: exact(amount), derivation: accountingDerivation }],
    } });
  return { initial, current, settlement, recognition, application };
}

test("legacy preposted settlement respects period closure in admission and restored history", () => {
  const f = fixture(true);
  const closed = executeBookCommand(f.current.state, f.current.protocol, sealCommand({ ...core(f.current.state, "close"), type: "closePeriod",
    periodId: IDS.period1, closePackageId: closePackageId("close"), reason: "Reviewed", reportPopulationHash: hashCanonical({ report: 1n }),
    reportingPolicySnapshotHash: hashCanonical({ policy: 1n }) }));
  expect(closed.result.disposition).toBe("committed");
  const application = f.application(closed.state, "legacy-claim", 100n);
  const { operation: _operation, appliedAt: _appliedAt, ...request } = application.request;
  const claim = sealCommand({ ...application, request });
  expect(claim.resolved).toHaveLength(0);
  const rejected = executeBookCommand(closed.state, closed.protocol, claim);
  expect(rejected.result.disposition).toBe("rejected");
  expect(rejected.result.diagnostics[0]?.code).toBe("fiscal_period_admission");
  expect(rejected.state).toEqual(closed.state);
  const decoded = decodeDurableBook(encodeDurableBook({ state: rejected.state, protocol: rejected.protocol }));
  if (decoded.disposition !== "decoded") throw new Error("Expected recoverable rejection");
  expect(decoded.disposition).toBe("decoded");
  expect(executeBookCommand(decoded.aggregate.state, decoded.aggregate.protocol, claim).result).toEqual({ ...rejected.result, disposition: "replayed" });

  // Reproduce an internally consistent historical commit from the old loophole:
  // valid allocation math and hashes, but a closed effective accounting period.
  const calculated = calculateSettlement(settlementReadContext(closed.state.accountingState),
    { ...claim.request, quantizationPolicy: closed.state.quantizationPolicies[0]! });
  expect(calculated.disposition).toBe("draft");
  if (calculated.disposition !== "draft") throw new Error("Expected valid standalone allocation math");
  const intent = prepareBookIntent(closed.state, claim, calculated.draft.effects, closed.state.latestPostingSequence).intent;
  const records = prepareBookCommitRecords({ bookId: IDS.book, bookRevision: closed.state.bookRevision, previousRevision: closed.state.revisions.at(-1)! }, intent);
  const body = { ...closed.state, bookRevision: records.revision.bookRevision, revisions: [...closed.state.revisions, records.revision],
    accountingState: calculated.draft.effects.reduce(applyAccountingEffect, closed.state.accountingState) };
  const forged = { ...body, contentHash: hashBookState(body) };
  expect(hashBookState(forged)).toEqual(forged.contentHash);
  expect(validateBookState(forged).some(diagnostic => diagnostic.code === "ordered_history_violation")).toBeTrue();

  const reopened = executeBookCommand(rejected.state, rejected.protocol, sealCommand({ ...core(rejected.state, "reopen", claim.issuedAt),
    type: "reopenPeriod", periodId: IDS.period1, reason: "Authorized correction" }));
  expect(reopened.result.disposition).toBe("committed");
  const wrongPeriod = sealCommand({ ...claim, id: commandId("wrong-period"), expectedBookRevision: reopened.state.bookRevision, fiscalPeriodId: IDS.period2 });
  expect(executeBookCommand(reopened.state, reopened.protocol, wrongPeriod).result.diagnostics[0]?.code).toBe("fiscal_period_admission");
  const fresh = sealCommand({ ...claim, id: commandId("claim-after-reopen"), expectedBookRevision: reopened.state.bookRevision });
  const accepted = executeBookCommand(reopened.state, reopened.protocol, fresh);
  expect(accepted.result.disposition).toBe("committed");
  expect(accepted.intent?.effects.map(effect => effect.type)).toEqual(["settlement", "settlementAllocation"]);
  expect(accepted.state.latestPostingSequence).toBe(closed.state.latestPostingSequence);
  expect(accepted.state.accountingState.settlementAllocations.map(allocation => allocation.allocatedBookValue.toString())).toEqual(["100/1"]);
  expect(validateBookState(accepted.state)).toHaveLength(0);
  expect(executeBookCommand(accepted.state, accepted.protocol, claim).result).toEqual({ ...rejected.result, disposition: "replayed" });
});

test("one unallocated payment is consumed across dated commands without new journals or ownership", () => {
  const f = fixture();
  let current = f.current;
  const paymentHash = current.state.accountingState.settlements[0]!.contentHash;
  for (const [id, amount, target] of [["apply-40", 40n, "invoice-a"], ["apply-60", 60n, "invoice-b"]] as const) {
    const command = f.application(current.state, id, amount, target);
    current = executeBookCommand(current.state, current.protocol, command);
    expect(current.result.disposition).toBe("committed");
    expect(current.intent?.effects.map((effect) => effect.type)).toEqual(["settlementAllocation"]);
    expect(current.state.latestPostingSequence).toBe(3n);
    expect(current.state.accountingState.settlements).toHaveLength(1);
    expect(current.state.accountingState.settlements[0]!.contentHash).toEqual(paymentHash);
    expect(validateBookState(current.state)).toHaveLength(0);
    const decoded = decodeDurableBook(encodeDurableBook({ state: current.state, protocol: current.protocol }));
    expect(decoded.disposition).toBe("decoded");
    if (decoded.disposition !== "decoded") throw new Error("Invalid lifecycle recovery");
    expect(executeBookCommand(decoded.aggregate.state, decoded.aggregate.protocol, command).result.disposition).toBe("replayed");
  }
  expect(current.state.accountingState.settlementAllocations.map((item) => [item.allocatedSettlementBookValue?.toString(), item.appliedAt]))
    .toEqual([["40/1", "2026-01-21T14:00:00Z"], ["60/1", "2026-01-21T14:00:00Z"]]);
  const over = executeBookCommand(current.state, current.protocol, f.application(current.state, "over", 1n));
  expect(over.result.disposition).toBe("rejected");
  expect(over.result.diagnostics[0]?.code).toBe("settlement_allocation_violation");
  expect(over.state.contentHash).toEqual(current.state.contentHash);
  const retroactive = executeBookCommand(current.state, current.protocol, sealCommand({ ...core(current.state, "configuration", "2026-01-22T14:00:00Z"),
    type: "replaceConfiguration", expectedConfigurationRevision: current.state.configurationRevision, effectiveOn: localDate("2026-01-21"),
    periods: current.state.periods, admissionSnapshot: current.state.admissionSnapshot, policies: current.state.policies,
    quantizationPolicies: current.state.quantizationPolicies, accountingPolicies: current.state.accountingPolicySnapshot.policies }));
  expect(retroactive.result.disposition).toBe("rejected");
  expect(retroactive.result.diagnostics[0]?.path).toBe("command.effectiveOn");
  // Build a correctly hashed over-allocated history using a deliberately false
  // read observation. Recovery must enforce conservation, not just checksums.
  const extra = f.application(current.state, "forged-budget", 30n, "invoice-b");
  const calculated = calculateSettlement({ ...settlementReadContext(current.state.accountingState),
    allocatedFromSettlement: () => ({ bookValue: exact(0n), quantity: exact(0n) }) },
    { ...extra.request, quantizationPolicy: current.state.quantizationPolicies[0]! });
  expect(calculated.disposition).toBe("draft");
  if (calculated.disposition !== "draft") throw new Error("Invalid malicious-history fixture");
  const intent = prepareBookIntent(current.state, extra, calculated.draft.effects, current.state.latestPostingSequence).intent;
  const records = prepareBookCommitRecords({ bookId: IDS.book, bookRevision: current.state.bookRevision, previousRevision: current.state.revisions.at(-1)! }, intent);
  const body = { ...current.state, bookRevision: records.revision.bookRevision,
    revisions: [...current.state.revisions, records.revision],
    accountingState: calculated.draft.effects.reduce(applyAccountingEffect, current.state.accountingState) };
  const forged = { ...body, contentHash: hashBookState(body) };
  expect(hashBookState(forged)).toEqual(forged.contentHash);
  expect(validateBookState(forged).some((diagnostic) => diagnostic.code === "ordered_history_violation")).toBeTrue();
});

test("later allocations reject closed periods, changed payment snapshots and inconsistent dates", () => {
  const f = fixture();
  const good = f.application(f.current.state, "candidate", 40n);
  const reject = (command: BookCommand, current: AtomicBookCommit = f.current, code: SemanticDiagnosticCode = "settlement_allocation_violation") => {
    const result = executeBookCommand(current.state, current.protocol, command);
    expect(result.result.disposition).toBe("rejected");
    expect(result.result.diagnostics[0]?.code).toBe(code);
    expect(result.state.contentHash).toEqual(current.state.contentHash);
  };
  reject(sealCommand({ ...good, request: { ...good.request, settlement: { ...f.settlement, bookValue: exact(101n) } } }));
  reject(sealCommand({ ...good, request: { ...good.request, operation: "allocateExisting", appliedAt: instant("2026-01-22T14:00:00Z") } }));
  reject(sealCommand({ ...good, request: { ...good.request, operation: "allocateExisting", appliedAt: instant("2026-01-14T14:00:00Z") } }));
  reject(sealCommand({ ...good, request: { ...good.request, operation: "allocateExisting", appliedAt: instant("2026-01-19T14:00:00Z") } }));
  reject(sealCommand({ ...good, resolved: [resolved(journal("not-another-payment"))] }));
  const period = f.current.state.periods.find((period) => period.startsOn <= "2026-01-21" && period.endsOn >= "2026-01-21")!;
  const closed = executeBookCommand(f.current.state, f.current.protocol, sealCommand({ ...core(f.current.state, "close"), type: "closePeriod",
    periodId: period.id, closePackageId: closePackageId("close"), reason: "Review", reportPopulationHash: hashCanonical({ report: 1n }),
    reportingPolicySnapshotHash: hashCanonical({ policy: 1n }) }));
  expect(closed.result.disposition).toBe("committed");
  reject(f.application(closed.state, "closed-application", 40n), closed, "fiscal_period_admission");
  const reopened = executeBookCommand(closed.state, closed.protocol, sealCommand({ ...core(closed.state, "reopen"), type: "reopenPeriod", periodId: period.id, reason: "Authorized correction" }));
  const accepted = executeBookCommand(reopened.state, reopened.protocol, f.application(reopened.state, "after-reopen", 40n));
  expect(accepted.result.disposition).toBe("committed");
  expect(validateBookState(accepted.state)).toHaveLength(0);
});

test("later allocation requires exact prior settlement evidence and retains legacy rejection semantics", () => {
  const f = fixture();
  const request = f.application(f.current.state, "allocation", 40n).request;
  const context = settlementReadContext(f.current.state.accountingState);
  for (const existingSettlement of [() => undefined as never, () => ({ ...f.current.state.accountingState.settlements[0]!, contentHash: hashCanonical({ bad: true }) })]) {
    if (existingSettlement() === undefined) expect(() => calculateSettlement({ ...context, existingSettlement }, request)).toThrow("Incomplete retained settlement evidence");
    else expect(calculateSettlement({ ...context, existingSettlement }, request).disposition).toBe("rejected");
  }
  for (const totals of [undefined, { bookValue: exact(-1n), quantity: exact(0n) }, { bookValue: exact(0n), quantity: exact(-1n) }])
    expect(() => calculateSettlement({ ...context, allocatedFromSettlement: () => totals as never }, request)).toThrow("Incomplete prior settlement allocation totals");
  expect(calculateSettlement({ ...context, allocatedFromSettlement: () => ({ bookValue: exact(90n), quantity: exact(0n) }) }, request).disposition).toBe("rejected");
  const malformed = [{ ...request, appliedAt: undefined }, { ...request, operation: "unknown" },
    { settlement: f.settlement, allocations: request.allocations, appliedAt: request.appliedAt },
    { ...request, allocations: request.allocations.map((edge) => ({ ...edge, appliedAt: instant("2026-01-20T14:00:00Z") })) }];
  for (const value of malformed) expect(calculateSettlement(context, value as SettlementRequest).disposition).toBe("rejected");
  expect(calculateSettlement(context, { settlement: { ...f.settlement, id: settlementId("new-id") }, allocations: [] }).disposition).toBe("rejected");
  const drafted = calculateSettlement(context, request);
  if (drafted.disposition !== "draft" || drafted.draft.effects[0]?.type !== "settlementAllocation") throw new Error("Invalid application fixture");
  const { allocatedSettlementBookValue: _measured, contentHash: _hash, ...legacyBody } = drafted.draft.effects[0].value;
  const legacy = { ...legacyBody, contentHash: hashCanonical({ type: "SettlementAllocation", value: canonicalAccountingValue(legacyBody) }) };
  const historical = settlementReadContext({ ...f.current.state.accountingState, settlementAllocations: [legacy] });
  expect(historical.allocatedFromSettlement(f.settlement.id).bookValue.toString()).toBe("40/1");

  const fxSettlementBody = { ...f.settlement, id: settlementId("fx-payment"), bookValue: exact(120n), denomination: exact(100n) };
  const fxSettlement = { ...fxSettlementBody, contentHash: hashCanonical({ type: "Settlement", value: canonicalAccountingValue(fxSettlementBody) }) };
  const legacyFxBody = { ...legacyBody, settlementId: fxSettlement.id };
  const legacyFx = { ...legacyFxBody, contentHash: hashCanonical({ type: "SettlementAllocation", value: canonicalAccountingValue(legacyFxBody) }) };
  const fxContext = settlementReadContext({
    ...f.current.state.accountingState,
    settlements: [...f.current.state.accountingState.settlements, fxSettlement],
    settlementAllocations: [legacyFx],
  });
  expect(fxContext.allocatedFromSettlement(fxSettlement.id).bookValue.toString()).toBe("48/1");
  const missingContext = settlementReadContext({
    ...f.current.state.accountingState,
    settlements: [],
    settlementAllocations: [legacyFx],
  });
  expect(missingContext.allocatedFromSettlement(fxSettlement.id).bookValue.toString()).toBe("40/1");

  const sameDayOpen = {
    ...f.current.state.accountingState.openItems[0]!,
    id: openItemId("same-day-invoice"),
    recognizedOn: localDate("2026-01-15"),
  };
  const sameDayContext = settlementReadContext({
    ...f.current.state.accountingState,
    openItems: [...f.current.state.accountingState.openItems, sameDayOpen],
  });
  const sameDayRequest: SettlementRequest = {
    operation: "allocateExisting",
    settlement: f.settlement,
    appliedAt: f.settlement.settledAt,
    allocations: [{
      id: settlementAllocationId("same-day-alloc"),
      settlementId: f.settlement.id,
      openItemId: sameDayOpen.id,
      appliedAt: f.settlement.settledAt,
      allocatedBookValue: exact(10n),
      allocatedOpenQuantity: exact(10n),
      allocatedSettlementQuantity: exact(10n),
      derivation: accountingDerivation,
    }],
  };
  const sameDayDraft = calculateSettlement(sameDayContext, sameDayRequest);
  expect(sameDayDraft.disposition).toBe("draft");
});

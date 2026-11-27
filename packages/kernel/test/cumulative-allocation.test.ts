import { expect, test } from "bun:test";
import {
  ExactRational as R, ExactDecimal as D, createBookState, executeBookCommand,
  createAllocationSchedule, recognizeScheduledAllocation, reviseAllocationSchedule,
  validateAccountingEffectHash, validateBookState, encodeDurableBook, decodeDurableBook,
  hashCanonical, canonicalAccountingValue, sealCommand, commandId, instant, localDate,
  semanticVersion, policyId, allocationScheduleId, allocationRecognitionId,
  allocationScheduleRevisionId, fiscalPeriodId, effectKey,
  STRUCTURAL_SOURCE_IDENTITY_PROFILE,
  type AllocationPolicy, type BookCommand, type DurableBookAggregate, type BookState,
} from "../src/index.ts";
import { freshState, IDS, journal, resolved, postingReference, quantizationPolicy } from "./fixtures.ts";
import { activationCommand } from "./protocol-fixtures.ts";
import { accountingDerivation, capability } from "./accounting-fixtures.ts";

const at = instant("2026-03-15T14:00:00Z");
const version = semanticVersion("1.1.0");
const policy: AllocationPolicy = {
  postingAlgorithm: "cumulative-posted-allocation-v1",
  id: policyId("cumulative"), version, algorithmVersion: version,
  bookId: IDS.book, validFrom: instant("2020-01-01T00:00:00Z"),
  quantizationPolicy, kind: "allocationSchedule", method: "straightLine", frequency: "monthly", convention: "fullPeriod",
  allocationAccountId: IDS.revenue, contraAccountId: IDS.cash,
  capability: { ...capability("allocationSchedule", "straightLine", [{ method: "straightLine", frequency: "monthly", convention: "fullPeriod" }]), implementationVersion: version },
};
const derivation = { ...accountingDerivation, policyId: policy.id, policyVersion: version, algorithmVersion: version };
const sourceJournal = journal("cumulative-source");
const request = {
  id: allocationScheduleId("cumulative-schedule"), policyId: policy.id, policyVersion: version, governedAt: at,
  source: postingReference(sourceJournal, "cumulative-source-command:journal:0"), sourceBasis: R.of(100n, 1n), residualValue: R.zero(),
  startsOn: localDate("2026-01-01"), endsOn: localDate("2026-03-31"), derivation,
};
function core(state: BookState, id: string) { return { id: commandId(id), bookId: IDS.book, protocolVersion: semanticVersion("1.0.0"), expectedBookRevision: state.bookRevision, actorId: IDS.actor, issuedAt: at, completedAt: at, committedAt: at }; }
function run(book: DurableBookAggregate, command: BookCommand) {
  const result = executeBookCommand(book.state, book.protocol, command);
  expect(result.result.disposition, JSON.stringify(result.result.diagnostics)).toBe("committed");
  return result;
}
function setup() {
  const base = freshState();
  let book: DurableBookAggregate = { ...base, state: createBookState(base.state.identity,
    [...base.state.periods, { ...base.state.periods[1]!, id: fiscalPeriodId("march"), sequence: 3n, startsOn: localDate("2026-03-01"), endsOn: localDate("2026-03-31") }],
    base.state.admissionSnapshot, base.state.policies, base.state.quantizationPolicies, [policy], instant("2020-01-01T00:00:00Z")) };
  book = run(book, activationCommand());
  book = run(book, sealCommand({ ...core(book.state, "cumulative-source-command"), type: "postJournal", resolved: resolved(sourceJournal) }));
  return run(book, sealCommand({ ...core(book.state, "cumulative-create"), type: "createAllocationSchedule", request }));
}
function recognition(book: DurableBookAggregate, ordinal = 1n) {
  return sealCommand({ ...core(book.state, `cumulative-recognition-${ordinal}`), type: "recognizeScheduledAllocation" as const,
    request: { id: allocationRecognitionId(`cumulative-recognition-${ordinal}`), scheduleId: request.id, ordinal, governedAt: at, derivation } });
}
function revise(book: DurableBookAggregate) {
  return sealCommand({ ...core(book.state, "cumulative-revise"), type: "reviseAllocationSchedule" as const,
    request: { id: allocationScheduleRevisionId("cumulative-revise"), kind: "estimateChange" as const, effectiveOn: localDate("2026-02-01"), policyEffectiveAt: at,
      originalScheduleId: request.id, priorRecognitionIds: [allocationRecognitionId("cumulative-recognition-1")], policyId: policy.id, policyVersion: version,
      revisedResidualValue: R.of(10n, 1n), successorScheduleId: allocationScheduleId("cumulative-successor"), revisedEndsOn: localDate("2026-03-31"), evidence: derivation.evidence, derivation } });
}

test("genesis structural identity resolves colon-alias sources independently of journal order", () => {
  for (const profile of [undefined, STRUCTURAL_SOURCE_IDENTITY_PROFILE] as const) {
    for (const reverse of [false, true]) {
      const base = freshState();
      let book: DurableBookAggregate = { ...base, state: createBookState(base.state.identity,
        base.state.periods, base.state.admissionSnapshot, base.state.policies,
        base.state.quantizationPolicies, [policy], instant("2020-01-01T00:00:00Z"), profile) };
      book = run(book, activationCommand());
      const source = journal("a");
      const posts = [["b:c", source], ["c", journal("a:b")]] as const;
      for (const [id, transaction] of reverse ? [...posts].reverse() : posts) {
        book = run(book, sealCommand({ ...core(book.state, id), type: "postJournal", resolved: resolved(transaction) }));
      }
      const sourceRef = postingReference(source, "b:c:journal:0");
      const command = sealCommand({ ...core(book.state, "alias-schedule"), type: "createAllocationSchedule" as const,
        request: { ...request, source: sourceRef, endsOn: localDate("2026-02-28") } });
      const result = executeBookCommand(book.state, book.protocol, command);
      expect(result.result.disposition).toBe(profile === undefined && !reverse ? "rejected" : "committed");
      expect(result.state.accountingState.allocationSchedules.length).toBe(profile === undefined && !reverse ? 0 : 1);
      expect(validateBookState(result.state)).toEqual([]);
      const encoded = encodeDurableBook({ state: result.state, protocol: result.protocol });
      const restored = decodeDurableBook(encoded);
      expect(restored.disposition).toBe("decoded");
      if (restored.disposition !== "decoded") throw new Error(restored.message);
      expect(encodeDurableBook(restored.aggregate)).toBe(encoded);
      const retry = executeBookCommand(restored.aggregate.state, restored.aggregate.protocol, command);
      expect(retry.result.disposition).toBe("replayed");
      expect(retry.result.resultHash).toEqual(result.result.resultHash);
      expect(retry.result.diagnostics).toEqual(result.result.diagnostics);
    }
  }
});

test("cumulative commands post an immutable plan in any ordinal order and round-trip", () => {
  let book: DurableBookAggregate = setup();
  for (const ordinal of [3n, 1n, 2n]) book = run(book, recognition(book, ordinal));
  expect(book.state.journals.slice(1).map((j) => j.journal.postings[0]!.bookValue.amount.toRational().toString())).toEqual(["3333/100", "3333/100", "1667/50"]);
  expect(book.state.journals.slice(1).reduce((sum, j) => sum.add(j.journal.postings[0]!.bookValue.amount.toRational()), R.zero()).toString()).toBe("100/1");
  expect(validateBookState(book.state)).toEqual([]);
  const encoded = encodeDurableBook({ state: book.state, protocol: book.protocol });
  const decoded = decodeDurableBook(encoded);
  expect(decoded.disposition).toBe("decoded");
  if (decoded.disposition !== "decoded") throw new Error(decoded.message);
  expect(encodeDurableBook(decoded.aggregate)).toBe(encoded);
  const template = revise(book);
  const { successorScheduleId: _successor, revisedEndsOn: _end, ...terminalRequest } = template.request;
  const closed = run(book, sealCommand({ ...template, request: { ...terminalRequest, kind: "termination",
    effectiveOn: localDate("2026-03-15"), revisedResidualValue: R.zero(),
    priorRecognitionIds: [1n, 2n, 3n].map((ordinal) => allocationRecognitionId(`cumulative-recognition-${ordinal}`)),
  } }));
  expect(closed.state.journals).toHaveLength(book.state.journals.length);
  expect(closed.state.accountingState.allocationScheduleRevisions[0]!.postedCarryingAmountAtRevision?.isZero()).toBeTrue();
  expect(validateBookState(closed.state)).toEqual([]);
});

test("cumulative revisions retain exact and posted totals and reject policy or unverified legacy transitions", () => {
  const active = setup();
  const recognized = run(active, recognition(active));
  const command = revise(recognized);
  const current = run(recognized, command);
  const revision = current.state.accountingState.allocationScheduleRevisions[0]!;
  expect(revision.recognizedToDate.toString()).toBe("100/3");
  expect(revision.postedRecognizedToDate?.toString()).toBe("3333/100");
  expect(current.state.accountingState.allocationSchedules[1]!.postingPlan!.postedSourceBasis.coefficient).toBe(6667n);
  for (const changed of [
    { ...policy, algorithmVersion: semanticVersion("1.0.0"), capability: { ...policy.capability, implementationVersion: semanticVersion("1.0.0") } },
    { ...policy, contraAccountId: IDS.revenue },
    { ...policy, quantizationPolicy: { ...quantizationPolicy, targetScale: 0n } },
  ]) {
    expect(reviseAllocationSchedule([changed], recognized.state.accountingState, IDS.book, IDS.usd, command.request).disposition).toBe("rejected");
  }
  const { postingPlan: _plan, ...legacy } = recognized.state.accountingState.allocationSchedules[0]!;
  expect(reviseAllocationSchedule([policy], { ...recognized.state.accountingState, allocationSchedules: [legacy] }, IDS.book, IDS.usd, command.request).disposition).toBe("rejected");
  expect(reviseAllocationSchedule([policy], { ...recognized.state.accountingState, allocationRecognitions: [{ ...recognized.state.accountingState.allocationRecognitions[0]!, ordinal: 99n }] }, IDS.book, IDS.usd, command.request).disposition).toBe("rejected");
  const changedConfiguration = sealCommand({ ...core(recognized.state, "coarsen"), type: "replaceConfiguration" as const,
    expectedConfigurationRevision: recognized.state.configurationRevision, effectiveOn: localDate("2026-03-15"),
    periods: recognized.state.periods, admissionSnapshot: recognized.state.admissionSnapshot, policies: recognized.state.policies,
    quantizationPolicies: [{ ...quantizationPolicy, targetScale: 0n }], accountingPolicies: [policy] });
  const changed = run(recognized, changedConfiguration);
  const rejected = executeBookCommand(changed.state, changed.protocol, recognition(changed, 2n));
  expect(rejected.result.disposition).toBe("rejected");
  expect(rejected.result.diagnostics[0]!.code).toBe("policy_ambiguity");
});

test("a second prospective revision closes through the first successor's posted carrying plan", () => {
  const active = setup(), recognized = run(active, recognition(active));
  const firstCommand = revise(recognized), first = run(recognized, firstCommand);
  const successorRecognition = allocationRecognitionId("successor-recognition");
  const secondBase = run(first, sealCommand({ ...core(first.state, "recognize-successor"), type: "recognizeScheduledAllocation",
    request: { id: successorRecognition, scheduleId: firstCommand.request.successorScheduleId, ordinal: 1n, governedAt: at, derivation } }));
  const secondCommand = sealCommand({ ...core(secondBase.state, "second-revision"), type: "reviseAllocationSchedule" as const,
    request: { ...firstCommand.request, id: allocationScheduleRevisionId("second-revision"), originalScheduleId: firstCommand.request.successorScheduleId,
      priorRecognitionIds: [successorRecognition], effectiveOn: localDate("2026-03-01"), revisedResidualValue: R.of(5n, 1n),
      successorScheduleId: allocationScheduleId("second-successor") } });
  const second = run(secondBase, secondCommand);
  expect(second.state.accountingState.allocationSchedules.at(-1)!.postingPlan!.postedSourceBasis.toString()).toBe("38.33");
  expect(second.state.accountingState.allocationScheduleRevisions).toHaveLength(2);
  expect(validateBookState(second.state)).toEqual([]);
  const bytes = encodeDurableBook({ state: second.state, protocol: second.protocol });
  const restored = decodeDurableBook(bytes);
  expect(restored.disposition).toBe("decoded");
  if (restored.disposition !== "decoded") throw new Error(restored.message);
  expect(encodeDurableBook(restored.aggregate)).toBe(bytes);
  const retry = executeBookCommand(restored.aggregate.state, restored.aggregate.protocol, secondCommand);
  expect(retry.result.disposition).toBe("replayed");
  expect(retry.result.resultHash).toEqual(second.result.resultHash);
});

test("terminal and impairment commands reconcile their actual posted adjustment", () => {
  const initial = setup();
  const recognized = run(initial, recognition(initial));
  const template = revise(recognized);
  const { successorScheduleId: _successor, revisedEndsOn: _ends, ...body } = template.request;
  const terminal = sealCommand({ ...template, request: { ...body, kind: "termination" as const,
    revisedResidualValue: R.zero(), generatedEffectKey: effectKey("cumulative-revise:journal:0"), exactAdjustmentAmount: R.of(-6667n, 100n) } });
  const finished = run(recognized, terminal);
  expect(finished.state.journals.at(-1)!.journal.postings.map((p) => p.bookValue.amount.toRational().toString())).toEqual(["6667/100", "-6667/100"]);
  expect(validateBookState(finished.state)).toEqual([]);
  const impairment = sealCommand({ ...template, request: { ...template.request, kind: "impairment" as const,
    generatedEffectKey: effectKey("cumulative-revise:journal:0"), exactAdjustmentAmount: R.of(-1001n, 200n) } });
  const impaired = run(recognized, impairment);
  expect(impaired.state.accountingState.allocationScheduleRevisions[0]!.bookedAdjustment!.residual.toString()).toBe("-1/200");
  expect(impaired.state.accountingState.allocationSchedules[1]!.sourceBasis.toString()).toBe("6167/100");
});

test("complete plan values, not asserted hashes, govern admission and restoration", () => {
  const current = setup();
  const original = current.state.accountingState.allocationSchedules[0]!;
  const { postingPlan: _postingPlan, ...without } = original;
  for (const forged of [
    without,
    { ...original, sourceBasis: R.of(100001n, 1000n) },
    { ...original, installments: [] },
    { ...original, postingPlan: { ...original.postingPlan!, installments: original.postingPlan!.installments.map((i) => ({ ...i, postedAmount: D.of(1n, 2n) })) } },
    { ...original, policy: { ...policy, algorithmVersion: semanticVersion("1.0.0") } },
  ]) {
    const { contentHash: _hash, ...body } = forged;
    const value = { ...body, contentHash: hashCanonical({ type: "AllocationSchedule", value: canonicalAccountingValue(body) }) };
    expect(validateAccountingEffectHash({ type: "allocationSchedule", value })).toBeFalse();
    expect(recognizeScheduledAllocation([policy], { ...current.state.accountingState, allocationSchedules: [value] }, IDS.usd, recognition(current).request).disposition).toBe("rejected");
  }
  const recognized = run(current, recognition(current));
  const damaged = { ...recognized.state, revisions: recognized.state.revisions.map((revision) => ({ ...revision,
    effects: revision.effects.map((effect) => effect.type !== "journal" || effect.booked.journal.id !== "cumulative-recognition-1-journal" ? effect : {
      ...effect, booked: { ...effect.booked, journal: { ...effect.booked.journal, postings: effect.booked.journal.postings.map((p) => ({ ...p, bookValue: { ...p.bookValue, amount: D.of(0n, 2n) } })) } },
    }),
  })) };
  expect(validateBookState(damaged).some((d) => d.path === "intent.effects.allocationPostingPlan")).toBeTrue();
  expect(createAllocationSchedule([{ ...policy, contraAccountId: policy.allocationAccountId }], IDS.book, request).disposition).toBe("rejected");
  expect(createAllocationSchedule([{ ...policy, postingAlgorithm: "unsupported-algorithm" as never }], IDS.book, request).disposition).toBe("rejected");
  expect(createAllocationSchedule([policy], IDS.book, { ...request, sourceBasis: R.of(100001n, 1000n) }).disposition).toBe("rejected");
  const usage: AllocationPolicy = { ...policy, method: "unitsOfProduction", frequency: "eventDriven", convention: "usageEvent", expectedUsage: R.of(2n, 1n),
    capability: { ...policy.capability, admittedCombinations: [{ method: "unitsOfProduction", frequency: "eventDriven", convention: "usageEvent" }] } };
  expect(createAllocationSchedule([usage], IDS.book, { ...request, usage: [{ date: localDate("2026-02-01"), value: R.of(1n, 1n) }, { date: localDate("2026-01-01"), value: R.of(1n, 1n) }] }).disposition).toBe("rejected");
});

test("a reused algorithm version cannot opt historical policies into cumulative execution", () => {
  const { postingAlgorithm: _marker, ...legacyPolicy } = policy;
  const result = createAllocationSchedule([legacyPolicy], IDS.book, request);
  if (result.disposition !== "draft") throw new Error("Legacy policy rejected");
  const effect = result.draft.effects[0]!;
  if (effect.type !== "allocationSchedule") throw new Error("Missing schedule");
  expect(effect.value.postingPlan).toBeUndefined();
  expect(effect.value.installments.map((i) => i.amount.toString())).toEqual(["100/3", "100/3", "100/3"]);
  expect(validateAccountingEffectHash(effect)).toBeTrue();
  const active = setup();
  const book = run(active, recognition(active));
  const revised = run(book, revise(book)).state.accountingState.allocationScheduleRevisions[0]!;
  const { postedRecognizedToDate: _posted, ...missing } = revised;
  expect(validateAccountingEffectHash({ type: "allocationScheduleRevision", value: missing })).toBeFalse();
  expect(validateAccountingEffectHash({ type: "allocationScheduleRevision", value: { ...revised, policy: legacyPolicy } })).toBeFalse();
});

test("cumulative revision rejects tampered intent effects and discriminates multiple policies", () => {
  const otherCumulativePolicy: AllocationPolicy = {
    ...policy,
    id: policyId("other-cumulative"),
  };
  const standardLinearPolicy: AllocationPolicy = {
    id: policyId("standard-linear"),
    version: semanticVersion("1.0.0"),
    algorithmVersion: semanticVersion("1.0.0"),
    bookId: IDS.book,
    validFrom: instant("2020-01-01T00:00:00Z"),
    quantizationPolicy,
    kind: "allocationSchedule",
    method: "straightLine",
    frequency: "monthly",
    convention: "fullPeriod",
    allocationAccountId: IDS.revenue,
    contraAccountId: IDS.cash,
    capability: { ...capability("allocationSchedule", "straightLine", [{ method: "straightLine", frequency: "monthly", convention: "fullPeriod" }]), implementationVersion: semanticVersion("1.0.0") },
  };
  const otherVersionPolicy: AllocationPolicy = {
    ...standardLinearPolicy,
    id: policyId("standard-linear-v2"),
    version: semanticVersion("2.0.0"),
    algorithmVersion: semanticVersion("2.0.0"),
    capability: { ...standardLinearPolicy.capability, implementationVersion: semanticVersion("2.0.0") },
  };

  const base = freshState();
  let multiPolicyBook: DurableBookAggregate = {
    ...base,
    state: createBookState(
      base.state.identity,
      [...base.state.periods, { ...base.state.periods[1]!, id: fiscalPeriodId("march-multi"), sequence: 3n, startsOn: localDate("2026-03-01"), endsOn: localDate("2026-03-31") }],
      base.state.admissionSnapshot,
      base.state.policies,
      base.state.quantizationPolicies,
      [policy, otherCumulativePolicy, otherVersionPolicy, standardLinearPolicy],
      instant("2020-01-01T00:00:00Z"),
    ),
  };
  multiPolicyBook = run(multiPolicyBook, activationCommand());
  multiPolicyBook = run(multiPolicyBook, sealCommand({ ...core(multiPolicyBook.state, "cumulative-source-command"), type: "postJournal", resolved: resolved(sourceJournal) }));
  multiPolicyBook = run(multiPolicyBook, sealCommand({ ...core(multiPolicyBook.state, "multi-create"), type: "createAllocationSchedule", request }));
  multiPolicyBook = run(multiPolicyBook, recognition(multiPolicyBook));
  // 1. Commit valid revision in multi-policy book
  const revCommand = revise(multiPolicyBook);
  const committed = run(multiPolicyBook, revCommand);
  expect(committed.result.disposition).toBe("committed");

  // 1b. Non-cumulative revision commits without requiring cumulative posting plan (kills book.ts:2165 === -> !== occurrence 3)
  const linearSource = journal("linear-source-j");
  multiPolicyBook = run(multiPolicyBook, sealCommand({ ...core(multiPolicyBook.state, "linear-source-command"), type: "postJournal", resolved: resolved(linearSource) }));
  const linearScheduleId = allocationScheduleId("linear-multi-schedule");
  const linearDerivation = { ...derivation, policyId: standardLinearPolicy.id, policyVersion: standardLinearPolicy.version };
  const linearRequest = {
    id: linearScheduleId,
    policyId: standardLinearPolicy.id,
    policyVersion: standardLinearPolicy.version,
    governedAt: at,
    source: postingReference(linearSource, "linear-source-command:journal:0"),
    sourceBasis: R.of(100n, 1n),
    residualValue: R.zero(),
    startsOn: localDate("2026-01-01"),
    endsOn: localDate("2026-03-31"),
    derivation: linearDerivation,
  };
  multiPolicyBook = run(multiPolicyBook, sealCommand({ ...core(multiPolicyBook.state, "linear-multi-create"), type: "createAllocationSchedule", request: linearRequest }));
  multiPolicyBook = run(multiPolicyBook, sealCommand({ ...core(multiPolicyBook.state, "linear-rec-1"), type: "recognizeScheduledAllocation", request: {
    id: allocationRecognitionId("linear-rec-1"), scheduleId: linearScheduleId, ordinal: 1n, governedAt: at, derivation: linearDerivation,
  } }));
  const linearRevCommand = sealCommand({
    ...core(multiPolicyBook.state, "linear-multi-revise"),
    type: "reviseAllocationSchedule" as const,
    request: {
      id: allocationScheduleRevisionId("linear-multi-revise"),
      kind: "estimateChange" as const,
      effectiveOn: localDate("2026-02-01"),
      policyEffectiveAt: at,
      originalScheduleId: linearScheduleId,
      priorRecognitionIds: [allocationRecognitionId("linear-rec-1")],
      policyId: standardLinearPolicy.id,
      policyVersion: standardLinearPolicy.version,
      revisedResidualValue: R.zero(),
      successorScheduleId: allocationScheduleId("linear-successor"),
      revisedEndsOn: localDate("2026-03-31"),
      evidence: derivation.evidence,
      derivation: linearDerivation,
    },
  });
  const linearCommitted = run(multiPolicyBook, linearRevCommand);
  expect(linearCommitted.result.disposition).toBe("committed");

  // 2. Tampered revision effect is detected by validateBookState
  const lastRevision = committed.state.revisions.at(-1)!;
  const eff = lastRevision.effects[0]!;
  if (eff.type !== "allocationScheduleRevision") throw new Error("Expected allocationScheduleRevision");
  const { contentHash: _h, ...body } = eff.value;
  const forgedBody = { ...body, postedRecognizedToDate: R.of(3334n, 100n) };
  const contentHash = hashCanonical({ type: "AllocationScheduleRevision", value: canonicalAccountingValue(forgedBody) });
  const forgedEff = { ...eff, value: { ...forgedBody, contentHash } };
  const damagedState: BookState = {
    ...committed.state,
    revisions: [
      ...committed.state.revisions.slice(0, -1),
      { ...lastRevision, effects: [forgedEff, lastRevision.effects[1]!] },
    ],
  };
  expect(validateBookState(damagedState).some((d) => d.path === "intent.effects.allocationPostingPlan")).toBeTrue();
});

test("cumulative revision rejects tampered intent effects in single-policy book", () => {
  const active = setup();
  const book = run(active, recognition(active));
  const committed = run(book, revise(book));
  expect(committed.result.disposition).toBe("committed");

  const lastRevision = committed.state.revisions.at(-1)!;
  const eff = lastRevision.effects[0]!;
  if (eff.type !== "allocationScheduleRevision") throw new Error("Expected allocationScheduleRevision");
  const { contentHash: _h, ...body } = eff.value;
  const forgedBody = { ...body, postedRecognizedToDate: R.of(3334n, 100n) };
  const contentHash = hashCanonical({ type: "AllocationScheduleRevision", value: canonicalAccountingValue(forgedBody) });
  const forgedEff = { ...eff, value: { ...forgedBody, contentHash } };
  const damagedState: BookState = {
    ...committed.state,
    revisions: [
      ...committed.state.revisions.slice(0, -1),
      { ...lastRevision, effects: [forgedEff, lastRevision.effects[1]!] },
    ],
  };
  expect(validateBookState(damagedState).some((d) => d.path === "intent.effects.allocationPostingPlan")).toBeTrue();
});

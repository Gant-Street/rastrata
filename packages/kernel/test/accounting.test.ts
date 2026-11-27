import { describe, expect, test } from "bun:test";
import {
  ExactRational,
  allocationRecognitionId,
  allocationScheduleId,
  allocationScheduleRevisionId,
  applyAccountingEffect,
  applyInventoryValueAdjustmentToHoldings,
  applySettlement,
  calculateSettlement,
  settlementReadContext,
  calculateInventoryValueAdjustment,
  calculateCurrencyRemeasurement,
  calculateInventoryCost,
  calculateInventoryRecosting,
  canonicalAccountingEffectValue,
  canonicalAccountingStateValue,
  canonicalAccountingValue,
  compileConsolidation,
  consolidationCompilationId,
  createAccountingPolicySnapshot,
  createAllocationSchedule,
  createProvisionalInventoryLayerEffect,
  determineTax,
  emptyAccountingCanonicalState,
  hashAccountingPolicySnapshot,
  immutableAccountingValue,
  inventoryRecostingId,
  inventoryValueAdjustmentId,
  openItemId,
  postingId,
  commodityId,
  provisionalInventoryLayerId,
  recognizeOpenItem,
  recognizeScheduledAllocation,
  reviseAllocationSchedule,
  rejectExternalAccountingAuthority,
  remeasurementResultId,
  remeasurementReversalId,
  settlementAllocationId,
  settlementId,
  validateAccountingEffectHash,
  validateAccountingEffectAdmission,
  type AccountingPolicy,
  type AllocationPolicy,
  type ConsolidationPolicy,
  type CurrencyPolicy,
  type InventoryCostPolicy,
  type InventoryValueAdjustmentPolicy,
  type MonetaryClassificationPolicy,
  type TaxPolicy,
  type TaxRoundingLevel,
  type InventoryValueAdjustmentRequest,
  type AllocationScheduleRevisionRequest,
  quantize,
} from "../src/index.ts";
import { instant, localDate, policyId, semanticVersion } from "../src/index.ts";
import { IDS, quantizationPolicy } from "./fixtures.ts";
import { account, accountingDerivation, accountingOne as one, capability, classificationRule, consolidationElimination, consolidationMapping, consolidationSource, consolidationValuationPolicy, pool, taxComponent, taxableLine, taxRequest, translationRule } from "./accounting-fixtures.ts";

const ten = ExactRational.of(10n, 1n);
const core = (kind: AccountingPolicy["kind"], id: string, method: string, combinations?: Parameters<typeof capability>[2]) => ({ id: policyId(id), version: semanticVersion("1.0.0"), bookId: IDS.book, validFrom: instant("2020-01-01T00:00:00Z"), algorithmVersion: semanticVersion("1.0.0"), quantizationPolicy, capability: capability(kind, method, combinations) });
const inventory = (method: InventoryCostPolicy["method"] = "fifo", shortageTreatment: InventoryCostPolicy["shortageTreatment"] = "reject"): InventoryCostPolicy => Object.freeze({ ...core("inventoryCost", `inventory-${method}-${shortageTreatment}`, method), kind: "inventoryCost", method, pools: Object.freeze([pool(`pool-${method}-${shortageTreatment}`, "inventory")]), shortageTreatment, ...(shortageTreatment === "provisionalNegative" ? { provisionalBasisMethod: "explicitRate" as const, provisionalRate: ExactRational.of(7n, 1n) } : {}) });
const currency: CurrencyPolicy = Object.freeze({ ...core("currencyRemeasurement", "currency", "closingRate"), kind: "currencyRemeasurement", reversalRequired: true, gainAccountId: account("gain"), lossAccountId: account("loss") });
const monetary: MonetaryClassificationPolicy = Object.freeze({ ...core("monetaryClassification", "monetary", "accountRule"), kind: "monetaryClassification", rules: Object.freeze([classificationRule("monetary-ar", "ar", "monetary")]) });
const allocation = (method: AllocationPolicy["method"]): AllocationPolicy => Object.freeze({ ...core("allocationSchedule", `allocation-${method}`, method), kind: "allocationSchedule", method, frequency: method === "unitsOfProduction" ? "eventDriven" : "monthly", convention: method === "unitsOfProduction" ? "usageEvent" : "fullPeriod", ...(method === "decliningBalance" ? { decliningRate: ExactRational.of(1n, 5n) } : {}), ...(method === "unitsOfProduction" ? { expectedUsage: ExactRational.of(3n, 1n) } : {}), allocationAccountId: account("expense"), contraAccountId: account("contra") });
const tax = (components: TaxPolicy["components"], roundingLevel: TaxRoundingLevel = "lineLevel"): TaxPolicy => Object.freeze({ ...core("taxDetermination", "tax", "compound"), kind: "taxDetermination", taxCode: "GST", jurisdiction: "TEST", roundingLevel, components });
const consolidationValuation = consolidationValuationPolicy("consolidation-valuation");
const consolidationDerivation = Object.freeze({ ...accountingDerivation, policyId: policyId("consolidation"), policyVersion: semanticVersion("1.0.0") });
const consolidation: ConsolidationPolicy = Object.freeze({ ...core("consolidation", "consolidation", "full"), kind: "consolidation", supportedMethods: Object.freeze(["full", "equity", "jointOperationShare"] as const), accountMappings: Object.freeze([consolidationMapping("map-target", "source", "target"), consolidationMapping("map-equity", "equity", "equity")]), translationRules: Object.freeze([translationRule("translate-source", "source", "target"), translationRule("translate-equity", "equity", "equity")]), valuationPolicy: consolidationValuation, translationAdjustmentAccountId: account("translation"), parentAttributableEquityAccountId: account("equity"), nonControllingInterestAccountId: account("nci") });
const layers = Object.freeze([
  Object.freeze({ id: "L1", accountId: account("inventory"), acquiredAt: instant("2026-01-01T00:00:00Z"), quantity: ExactRational.of(2n, 1n), totalBasis: ExactRational.of(20n, 1n) }),
  Object.freeze({ id: "L2", accountId: account("inventory"), acquiredAt: instant("2026-01-02T00:00:00Z"), quantity: ExactRational.of(3n, 1n), totalBasis: ExactRational.of(60n, 1n) }),
]);

describe("accounting capability calculators (ACC-039–ACC-047)", () => {
  test("ACC-019/038: tied inventory ordering is Unicode code-unit order, never host collation", () => {
    const cost = inventory();
    const tied = [
      { ...layers[0]!, id: "ä", quantity: one, totalBasis: ten },
      { ...layers[0]!, id: "z", quantity: one, totalBasis: ExactRational.of(20n, 1n) },
    ];
    const request = { policyId: cost.id, policyVersion: cost.version, governedAt: instant("2026-01-15T00:00:00Z"), quantity: one, layers: tied };
    const result = calculateInventoryCost([cost], IDS.book, request);
    expect(result.disposition).toBe("costed");
    if (result.disposition === "costed") {
      expect(result.allocations[0]!.layerId).toBe("z");
      expect(result.ordinaryBasis.equals(ExactRational.of(20n, 1n))).toBeTrue();
    }
    const originalCollation = String.prototype.localeCompare;
    try {
      String.prototype.localeCompare = () => { throw new Error("Ambient collation forbidden in accounting"); };
      expect(calculateInventoryCost([cost], IDS.book, request)).toEqual(result);
      expect(createAccountingPolicySnapshot([cost, allocation("straightLine")]).policies).toHaveLength(2);
    } finally {
      String.prototype.localeCompare = originalCollation;
    }
  });

  test("ACC-044/047: compiled effects own their policy and evidence snapshots", () => {
    const policy = { ...allocation("straightLine") };
    const evidence = { ...accountingDerivation.evidence[0]! };
    const derivation = { ...accountingDerivation, evidence: [evidence] };
    const calculated = createAllocationSchedule([policy], IDS.book, { id: allocationScheduleId("owned-schedule"), policyId: policy.id, policyVersion: policy.version, governedAt: instant("2026-01-01T00:00:00Z"), sourceBasis: ten, residualValue: ExactRational.zero(), startsOn: localDate("2026-01-01"), endsOn: localDate("2026-02-28"), derivation });
    expect(calculated.disposition).toBe("draft");
    if (calculated.disposition !== "draft") return;
    policy.allocationAccountId = account("changed-after-calculation");
    evidence.sourceRecordId = "changed-after-calculation";
    const effect = calculated.draft.effects[0]!;
    expect(validateAccountingEffectHash(effect)).toBeTrue();
    expect(Object.isFrozen(effect.value.derivation.evidence[0])).toBeTrue();
    const mutableProvisionalInput = { ...derivation, evidence: [{ ...evidence }] };
    const provisional = createProvisionalInventoryLayerEffect({ id: provisionalInventoryLayerId("owned-provisional"), bookId: IDS.book, policyId: policy.id, issuePostingId: postingId("owned-issue"), openedAt: instant("2026-01-01T00:00:00Z"), quantity: one, provisionalBasis: ten, derivation: mutableProvisionalInput });
    mutableProvisionalInput.evidence[0]!.sourceRecordId = "changed-again";
    expect(validateAccountingEffectHash(provisional)).toBeTrue();
  });

  test("ACC-039.4/5: adjustment endpoints, zero components, and exact allowance limits", () => {
    const zero = ExactRational.zero();
    const at = instant("2026-01-15T00:00:00Z");
    const cost = { ...inventory(), validFrom: at, validTo: instant("2026-01-16T00:00:00Z") };
    const policy: InventoryValueAdjustmentPolicy = { ...core("inventoryValueAdjustment", "boundary-value", "valueAdjustment"), kind: "inventoryValueAdjustment", inventoryCostPolicyId: cost.id, inventoryCostPolicyVersion: cost.version, allowedKinds: ["directlyAttributableCost", "productionOverhead", "purchaseRebate", "writeDown", "writeDownReversal"], inventoryAccountId: account("inventory"), recognizedCostAccountId: account("expense"), adjustmentAccountId: account("adjustment") };
    const derivation = { ...accountingDerivation, policyId: policy.id };
    const lot = { id: "boundary-lot" as never, bookId: IDS.book, commodityId: IDS.usd, acquiredAt: at, acquisitionQuantity: one, acquisitionTotalBasis: ten, basisCommodityId: IDS.usd, evidenceIds: ["evidence"] };
    const holding = { id: "boundary-holding" as never, lotId: lot.id, bookId: IDS.book, accountId: account("inventory"), commodityId: IDS.usd, basisCommodityId: IDS.usd, remainingQuantity: one, remainingTotalBasis: ten, remainingValuationAllowance: zero, remainingCarryingAmount: ten };
    const base: InventoryValueAdjustmentRequest = { id: inventoryValueAdjustmentId("boundary-adjustment"), kind: "purchaseRebate", effectiveOn: localDate("2026-01-15"), policyEffectiveAt: at, policyId: policy.id, policyVersion: policy.version, generatedEffectKey: "boundary:journal:0" as never, exactSourceAmount: one.negate(), allocations: [{ ordinal: 1n, lotId: lot.id, holdingId: holding.id, remainingBasisChange: one.negate(), recognizedCostChange: zero, remainingValuationAllowanceChange: zero }], evidence: derivation.evidence, derivation };
    const calculate = (request: InventoryValueAdjustmentRequest, h = holding) => calculateInventoryValueAdjustment([cost, policy], IDS.book, IDS.usd, [lot], [h], request);
    const rebate = calculate(base);
    expect(rebate.disposition).toBe("draft");
    if (rebate.disposition === "draft") expect(rebate.draft.journals[0]!.postings.map(p => p.exactBookValue.toString())).toEqual(["-1/1", "1/1"]);
    expect(calculate({ ...base, policyEffectiveAt: cost.validTo }).disposition).toBe("rejected");
    expect(calculateInventoryValueAdjustment([cost, policy], IDS.book, IDS.usd, [{ ...lot, evidenceIds: [] }], [holding], base).disposition).toBe("rejected");
    const { holdingId: _holdingId, ...disposedAllocation } = base.allocations[0]!;
    expect(calculateInventoryValueAdjustment([cost, policy], IDS.book, IDS.usd, [lot], [], { ...base, allocations: [{ ...disposedAllocation, remainingBasisChange: zero, recognizedCostChange: one.negate() }] }).disposition).toBe("draft");
    const writeDown = { ...base, kind: "writeDown" as const, exactSourceAmount: ten.negate(), allocations: [{ ...base.allocations[0]!, remainingBasisChange: zero, remainingValuationAllowanceChange: ten.negate() }] };
    const full = calculate(writeDown);
    expect(full.disposition).toBe("draft");
    const depleted = { ...holding, remainingValuationAllowance: ten.negate(), remainingCarryingAmount: zero };
    const reversal = { ...writeDown, kind: "writeDownReversal" as const, exactSourceAmount: ten, allocations: [{ ...writeDown.allocations[0]!, remainingValuationAllowanceChange: ten }] };
    expect(calculate(reversal, depleted).disposition).toBe("draft");
    for (const request of [writeDown, reversal]) {
      const noOp = { ...request.allocations[0]!, ordinal: 2n, lotId: "other-lot" as never, holdingId: "other-holding" as never, remainingValuationAllowanceChange: zero };
      const h = request.kind === "writeDown" ? holding : depleted;
      expect(calculateInventoryValueAdjustment([cost, policy], IDS.book, IDS.usd, [lot, { ...lot, id: noOp.lotId }], [h, { ...h, id: noOp.holdingId, lotId: noOp.lotId }], { ...request, allocations: [...request.allocations, noOp] }).disposition).toBe("rejected");
    }
    // Zero source amounts are forbidden independently of their sign predicate.
    for (const kind of policy.allowedKinds) expect(calculate({ ...base, kind, exactSourceAmount: zero, allocations: [{ ...base.allocations[0]!, remainingBasisChange: zero }] }).disposition).toBe("rejected");
    const lots = Array.from({ length: 10_000 }, (_, i) => ({ ...lot, id: `limit-lot-${i}` as never }));
    const allocations = lots.map((lot, i) => ({ ordinal: BigInt(i + 1), lotId: lot.id, remainingBasisChange: zero, recognizedCostChange: one, remainingValuationAllowanceChange: zero }));
    const atLimit = calculateInventoryValueAdjustment([cost, policy], IDS.book, IDS.usd, lots, [], { ...base, kind: "productionOverhead", exactSourceAmount: ExactRational.of(10_000n, 1n), allocations });
    expect(atLimit.disposition).toBe("draft");
    if (atLimit.disposition === "draft") expect(atLimit.draft.journals[0]!.postings[0]!.exactBookValue.equals(ExactRational.of(10_000n, 1n))).toBeTrue();
  });

  test("ACC-041.5/6: dated FX settlement quantization is derived, not trusted", () => {
    const amount = ExactRational.of(100n, 1n);
    const opened = recognizeOpenItem(emptyAccountingCanonicalState(), { value: { id: openItemId("boundary-open"), bookId: IDS.book, kind: "receivable", scope: { externalPartyId: "CUSTOMER", controlAccountId: account("ar") }, recognitionPostingId: postingId("boundary-open-posting"), recognizedOn: localDate("2026-01-01"), denominationCommodityId: IDS.usd, denomination: amount, bookValue: amount, derivation: accountingDerivation } });
    expect(opened.disposition).toBe("draft");
    if (opened.disposition !== "draft") return;
    const state = applyAccountingEffect(emptyAccountingCanonicalState(), opened.draft.effects[0]!);
    const settledAt = instant("2026-01-15T00:00:00Z");
    const settlement = { id: settlementId("boundary-settlement"), bookId: IDS.book, kind: "cash" as const, scope: state.openItems[0]!.scope, settlementPostingId: postingId("boundary-settlement-posting"), settledAt, denominationCommodityId: "EUR" as never, denomination: amount, bookValue: ExactRational.of(120n, 1n), derivation: accountingDerivation };
    const edge = { id: settlementAllocationId("boundary-edge"), openItemId: state.openItems[0]!.id, settlementId: settlement.id, allocatedBookValue: amount, allocatedOpenQuantity: amount, allocatedSettlementQuantity: amount, allocatedSettlementBookValue: settlement.bookValue, valuationPath: { fromCommodityId: settlement.denominationCommodityId, toCommodityId: IDS.usd, effectiveAt: settledAt, observedAt: settledAt, rate: ExactRational.of(6n, 5n), evidenceIds: [accountingDerivation.evidence[0]!.id] }, realizedExchangeEffectKey: "boundary:journal:1" as never, derivation: accountingDerivation };
    const input = { settlement, quantizationPolicy, allocations: [edge] };
    const { contentHash: _openHash, ...openBody } = state.openItems[0]!;
    const thirdCurrencyOpen = recognizeOpenItem(emptyAccountingCanonicalState(), { value: { ...openBody, denominationCommodityId: "GBP" as never, denomination: ExactRational.of(80n, 1n) } });
    expect(thirdCurrencyOpen.disposition).toBe("draft");
    if (thirdCurrencyOpen.disposition === "draft") {
      const thirdState = applyAccountingEffect(emptyAccountingCanonicalState(), thirdCurrencyOpen.draft.effects[0]!);
      const threeCurrency = applySettlement(thirdState, { ...input, allocations: [{ ...edge, allocatedOpenQuantity: ExactRational.of(80n, 1n) }] });
      expect(threeCurrency.disposition).toBe("draft");
      if (threeCurrency.disposition === "draft") {
        const allocated = threeCurrency.draft.effects[1]!;
        if (allocated.type !== "settlementAllocation") throw new Error("Missing settlement allocation");
        expect(allocated.value.allocatedOpenItemBookValue?.toString()).toBe("100/1");
        expect(allocated.value.allocatedSettlementBookValue?.toString()).toBe("120/1");
        expect(allocated.value.realizedExchangeDifference?.amount.toRational().toString()).toBe("20/1");
      }
    }
    // Allocating all EUR 100 cannot leave USD 10 of its USD 120 measurement unallocated.
    expect(applySettlement(state, { ...input, allocations: [{ ...edge, allocatedSettlementBookValue: ExactRational.of(110n, 1n), valuationPath: { ...edge.valuationPath, rate: ExactRational.of(11n, 10n) } }] }).disposition).toBe("rejected");
    const result = applySettlement(state, input);
    expect(result.disposition).toBe("draft");
    if (result.disposition === "draft") {
      const allocation = result.draft.effects[1]!;
      expect(allocation.type).toBe("settlementAllocation");
      if (allocation.type === "settlementAllocation") {
        expect(allocation.value.settlementMeasurement).toEqual(quantize(settlement.bookValue, quantizationPolicy));
        expect(allocation.value.realizedExchangeDifference).toEqual(quantize(ExactRational.of(20n, 1n), quantizationPolicy));
      }
    }
    expect(applySettlement(state, { ...input, allocations: [{ ...edge, settlementMeasurement: quantize(settlement.bookValue, quantizationPolicy), realizedExchangeDifference: quantize(ExactRational.of(20n, 1n), quantizationPolicy) }] }).disposition).toBe("draft");
    expect(applySettlement(state, { ...input, allocations: [{ ...edge, valuationPath: { ...edge.valuationPath, evidenceIds: [] } }] }).disposition).toBe("rejected");
    expect(applySettlement(state, { ...input, allocations: [{ ...edge, valuationPath: { ...edge.valuationPath, observedAt: instant("2026-01-15T00:00:01Z") } }] }).disposition).toBe("rejected");
    expect(applySettlement(state, { ...input, allocations: [{ ...edge, settlementMeasurement: quantize(one, quantizationPolicy) }] }).disposition).toBe("rejected");
    expect(applySettlement(state, { ...input, allocations: [{ ...edge, realizedExchangeDifference: quantize(one, quantizationPolicy) }] }).disposition).toBe("rejected");
    expect(applySettlement(state, { settlement, allocations: [{ ...edge, settlementMeasurement: quantize(settlement.bookValue, quantizationPolicy) }] }).disposition).toBe("rejected");
  });

  test("ACC-044.4/5/6: revision cutoff equality and fully impaired residuals", () => {
    const policy = allocation("straightLine");
    const derivation = { ...accountingDerivation, policyId: policy.id };
    const original = createAllocationSchedule([policy], IDS.book, { id: allocationScheduleId("boundary-schedule"), policyId: policy.id, policyVersion: policy.version, governedAt: instant("2026-01-01T00:00:00Z"), sourceBasis: ten, residualValue: ExactRational.zero(), startsOn: localDate("2026-01-01"), endsOn: localDate("2026-02-28"), derivation });
    expect(original.disposition).toBe("draft");
    if (original.disposition !== "draft") return;
    const state = applyAccountingEffect(emptyAccountingCanonicalState(), original.draft.effects[0]!);
    const base: AllocationScheduleRevisionRequest = { id: allocationScheduleRevisionId("boundary-revision"), kind: "impairment", effectiveOn: localDate("2026-01-01"), policyEffectiveAt: instant("2026-01-01T00:00:00Z"), originalScheduleId: allocationScheduleId("boundary-schedule"), priorRecognitionIds: [], policyId: policy.id, policyVersion: policy.version, revisedResidualValue: ExactRational.zero(), exactAdjustmentAmount: ten.negate(), generatedEffectKey: "boundary:journal:0" as never, evidence: derivation.evidence, derivation };
    // January's unrecognized 5 must not be included in a February successor
    // and then remain independently recognizable on the original schedule.
    expect(reviseAllocationSchedule([policy], state, IDS.book, IDS.usd, { ...base, effectiveOn: localDate("2026-02-01"), exactAdjustmentAmount: one.negate(), successorScheduleId: allocationScheduleId("double-count-successor"), revisedEndsOn: localDate("2026-02-28") }).disposition).toBe("rejected");
    const revised = reviseAllocationSchedule([policy], state, IDS.book, IDS.usd, base);
    expect(revised.disposition).toBe("draft");
    if (revised.disposition === "draft") {
      expect(revised.draft.effects.map(e => e.type)).toEqual(["allocationScheduleRevision"]);
      expect(revised.draft.journals[0]!.postings[0]!.exactBookValue.equals(ten)).toBeTrue();
    }
    const terminated = reviseAllocationSchedule([policy], state, IDS.book, IDS.usd, { ...base, kind: "termination", effectiveOn: localDate("2026-02-01") });
    expect(terminated.disposition).toBe("draft");
    if (terminated.disposition === "draft") expect(recognizeScheduledAllocation([policy], applyAccountingEffect(state, terminated.draft.effects[0]!), IDS.usd, { id: allocationRecognitionId("late-terminated-recognition"), scheduleId: base.originalScheduleId, ordinal: 1n, governedAt: instant("2026-02-02T00:00:00Z"), derivation }).disposition).toBe("rejected");
    const partial = { ...base, exactAdjustmentAmount: one.negate(), revisedResidualValue: ExactRational.of(9n, 1n) };
    expect(reviseAllocationSchedule([policy], state, IDS.book, IDS.usd, partial).disposition).toBe("draft");
    const { exactAdjustmentAmount: _amount, generatedEffectKey: _key, ...withoutAdjustment } = base;
    const estimate: AllocationScheduleRevisionRequest = { ...withoutAdjustment, kind: "estimateChange", successorScheduleId: allocationScheduleId("boundary-successor"), revisedEndsOn: base.effectiveOn };
    expect(reviseAllocationSchedule([policy], state, IDS.book, IDS.usd, { ...estimate, effectiveOn: localDate("2026-02-01"), revisedEndsOn: localDate("2026-02-28") }).disposition).toBe("rejected");
    expect(reviseAllocationSchedule([policy], state, IDS.book, IDS.usd, estimate).disposition).toBe("draft");
    expect(reviseAllocationSchedule([policy], state, IDS.book, IDS.usd, { ...estimate, effectiveOn: localDate("2025-12-31") }).disposition).toBe("rejected");
    expect(reviseAllocationSchedule([policy], state, IDS.book, IDS.usd, { ...estimate, revisedResidualValue: ten }).disposition).toBe("rejected");
    const recognized = recognizeScheduledAllocation([policy], state, IDS.usd, { id: allocationRecognitionId("boundary-recognition"), scheduleId: base.originalScheduleId, ordinal: 1n, governedAt: base.policyEffectiveAt, derivation });
    expect(recognized.disposition).toBe("draft");
    if (recognized.disposition === "draft") expect(reviseAllocationSchedule([policy], applyAccountingEffect(state, recognized.draft.effects[0]!), IDS.book, IDS.usd, { ...estimate, priorRecognitionIds: [allocationRecognitionId("boundary-recognition")] }).disposition).toBe("rejected");
    const usagePolicy = allocation("unitsOfProduction");
    const usageDerivation = { ...derivation, policyId: usagePolicy.id };
    const usageOriginal = createAllocationSchedule([usagePolicy], IDS.book, { id: allocationScheduleId("uneven-schedule"), policyId: usagePolicy.id, policyVersion: usagePolicy.version, governedAt: base.policyEffectiveAt, sourcePostingId: postingId("uneven-source"), sourceBasis: ExactRational.of(30n, 1n), residualValue: ExactRational.zero(), startsOn: localDate("2026-01-01"), endsOn: localDate("2026-02-28"), usage: [{ date: localDate("2026-01-01"), value: one }, { date: localDate("2026-02-01"), value: ExactRational.of(2n, 1n) }], derivation: usageDerivation });
    expect(usageOriginal.disposition).toBe("draft");
    if (usageOriginal.disposition !== "draft") return;
    let usageState = applyAccountingEffect(emptyAccountingCanonicalState(), usageOriginal.draft.effects[0]!);
    const usageRecognition = recognizeScheduledAllocation([usagePolicy], usageState, IDS.usd, { id: allocationRecognitionId("uneven-recognition"), scheduleId: allocationScheduleId("uneven-schedule"), ordinal: 1n, governedAt: base.policyEffectiveAt, derivation: usageDerivation });
    expect(usageRecognition.disposition).toBe("draft");
    if (usageRecognition.disposition !== "draft") return;
    usageState = applyAccountingEffect(usageState, usageRecognition.draft.effects[0]!);
    const usageRevision = reviseAllocationSchedule([usagePolicy], usageState, IDS.book, IDS.usd, { ...estimate, policyId: usagePolicy.id, originalScheduleId: allocationScheduleId("uneven-schedule"), priorRecognitionIds: [allocationRecognitionId("uneven-recognition")], effectiveOn: localDate("2026-02-01"), revisedEndsOn: localDate("2026-02-28"), revisedUsage: [{ date: localDate("2026-02-01"), value: ExactRational.of(3n, 1n) }], derivation: usageDerivation });
    expect(usageRevision.disposition).toBe("draft");
    if (usageRevision.disposition === "draft") {
      const schedule = usageRevision.draft.effects[1]!;
      expect(schedule.type).toBe("allocationSchedule");
      if (schedule.type === "allocationSchedule") {
        expect(schedule.value.sourceBasis.equals(ExactRational.of(20n, 1n))).toBeTrue();
        expect(schedule.value.sourcePostingId).toBe(postingId("uneven-source"));
        expect(schedule.value.installments.map(i => i.amount.toString())).toEqual(["20/1"]);
      }
    }
  });
  test("costs every declared inventory method and fails closed on incoherent inputs", () => {
    for (const method of ["fifo", "lifo", "hifo", "weightedAverage"] as const) {
      const result = calculateInventoryCost([inventory(method)], IDS.book, { policyId: policyId(`inventory-${method}-reject`), policyVersion: semanticVersion("1.0.0"), governedAt: instant("2026-01-15T00:00:00Z"), quantity: one, layers });
      expect(result.disposition).toBe("costed");
    }
    const specific = inventory("specificIdentification");
    expect(calculateInventoryCost([specific], IDS.book, { policyId: specific.id, policyVersion: specific.version, governedAt: instant("2026-01-15T00:00:00Z"), quantity: one, layers, specificLayerIds: ["L2"] }).disposition).toBe("costed");
    expect(calculateInventoryCost([specific], IDS.book, { policyId: specific.id, policyVersion: specific.version, governedAt: instant("2026-01-15T00:00:00Z"), quantity: one, layers, specificLayerIds: ["missing"] }).disposition).toBe("rejected");
    expect(calculateInventoryCost([], IDS.book, { policyId: specific.id, policyVersion: specific.version, governedAt: instant("2026-01-15T00:00:00Z"), quantity: one, layers }).disposition).toBe("rejected");
    expect(calculateInventoryCost([specific], IDS.book, { policyId: specific.id, policyVersion: specific.version, governedAt: instant("2026-01-15T00:00:00Z"), quantity: ExactRational.zero(), layers }).disposition).toBe("rejected");
    expect(calculateInventoryCost([inventory()], IDS.book, { policyId: inventory().id, policyVersion: semanticVersion("1.0.0"), governedAt: instant("2026-01-15T00:00:00Z"), quantity: ExactRational.of(9n, 1n), layers }).disposition).toBe("rejected");
    const provisional = inventory("fifo", "provisionalNegative");
    const shortage = calculateInventoryCost([provisional], IDS.book, { policyId: provisional.id, policyVersion: provisional.version, governedAt: instant("2026-01-15T00:00:00Z"), quantity: ExactRational.of(6n, 1n), layers });
    expect(shortage.disposition).toBe("costed");
    if (shortage.disposition === "costed") expect(shortage.provisionalBasis.equals(ExactRational.of(7n, 1n))).toBeTrue();
    for (const provisionalBasisMethod of ["lastReceiptCost", "movingAverage", "standardCost"] as const) {
      const { provisionalRate: _explicitRate, ...provisionalWithoutRate } = provisional;
      const policy: InventoryCostPolicy = Object.freeze({ ...provisionalWithoutRate, id: policyId(`inventory-provisional-${provisionalBasisMethod}`), provisionalBasisMethod, ...(provisionalBasisMethod === "standardCost" ? { provisionalRate: ExactRational.of(9n, 1n) } : {}) });
      const result = calculateInventoryCost([policy], IDS.book, { policyId: policy.id, policyVersion: policy.version, governedAt: instant("2026-01-15T00:00:00Z"), quantity: ExactRational.of(6n, 1n), layers });
      expect(result.disposition, provisionalBasisMethod).toBe("costed");
    }
    const { provisionalRate: _explicitRate, ...provisionalWithoutRate } = provisional;
    const unresolvedMovingAverage: InventoryCostPolicy = Object.freeze({ ...provisionalWithoutRate, id: policyId("inventory-provisional-empty-average"), provisionalBasisMethod: "movingAverage" });
    expect(calculateInventoryCost([unresolvedMovingAverage], IDS.book, { policyId: unresolvedMovingAverage.id, policyVersion: unresolvedMovingAverage.version, governedAt: instant("2026-01-15T00:00:00Z"), quantity: one, layers: [] }).disposition).toBe("rejected");
  });

  test("recosts provisional inventory exactly and applies all immutable effect families", () => {
    const inventoryDerivation = Object.freeze({ ...accountingDerivation, policyId: inventory().id });
    const layer = createProvisionalInventoryLayerEffect({ id: provisionalInventoryLayerId("P1"), bookId: IDS.book, policyId: inventory().id, issuePostingId: postingId("issue"), openedAt: instant("2026-01-15T00:00:00Z"), quantity: ExactRational.of(2n, 1n), provisionalBasis: ExactRational.of(14n, 1n), derivation: inventoryDerivation });
    let state = applyAccountingEffect(emptyAccountingCanonicalState(), layer);
    const result = calculateInventoryRecosting(state, { id: inventoryRecostingId("R1"), layerId: layer.value.id, resolvedAt: instant("2026-01-20T00:00:00Z"), sources: [{ receiptId: "receipt", quantity: one, totalBasis: ten }], derivation: inventoryDerivation });
    expect(result.disposition).toBe("draft");
    if (result.disposition !== "draft") return;
    state = applyAccountingEffect(state, result.draft.effects[0]!);
    expect(calculateInventoryRecosting(state, { id: inventoryRecostingId("R2"), layerId: layer.value.id, resolvedAt: instant("2026-01-21T00:00:00Z"), sources: [{ receiptId: "too-much", quantity: ExactRational.of(2n, 1n), totalBasis: ten }], derivation: inventoryDerivation }).disposition).toBe("rejected");
    expect(calculateInventoryRecosting(state, { id: inventoryRecostingId("R3"), layerId: provisionalInventoryLayerId("missing"), resolvedAt: instant("2026-01-21T00:00:00Z"), sources: [], derivation: inventoryDerivation }).disposition).toBe("rejected");
    expect(validateAccountingEffectHash(layer)).toBeTrue();
    expect(validateAccountingEffectHash({ ...layer, value: { ...layer.value, contentHash: hashAccountingPolicySnapshot([inventory()]) } })).toBeFalse();
    expect(canonicalAccountingEffectValue(layer)).toBeDefined();
    expect(canonicalAccountingStateValue(state)).toBeDefined();
  });

  test("adjusts inventory value immutably across live, disposed, write-down, and rebate paths", () => {
    const costPolicy = inventory("fifo", "reject");
    const valuePolicy: InventoryValueAdjustmentPolicy = Object.freeze({
      ...core("inventoryValueAdjustment", "inventory-value-adjustment", "valueAdjustment"),
      kind: "inventoryValueAdjustment",
      inventoryCostPolicyId: costPolicy.id,
      inventoryCostPolicyVersion: costPolicy.version,
      allowedKinds: Object.freeze(["directlyAttributableCost", "purchaseRebate", "productionOverhead", "writeDown", "writeDownReversal"] as const),
      inventoryAccountId: account("inventory"),
      recognizedCostAccountId: account("expense"),
      adjustmentAccountId: account("adjustment"),
    });
    const valueDerivation = Object.freeze({ ...accountingDerivation, policyId: valuePolicy.id, policyVersion: valuePolicy.version });
    const liveLot = Object.freeze({ id: "value-live-lot" as never, bookId: IDS.book, commodityId: IDS.usd, acquiredAt: instant("2026-01-01T00:00:00Z"), acquisitionQuantity: ExactRational.of(2n, 1n), acquisitionTotalBasis: ExactRational.of(20n, 1n), basisCommodityId: IDS.usd, evidenceIds: ["inventory-evidence"] });
    const disposedLot = Object.freeze({ ...liveLot, id: "value-disposed-lot" as never, acquiredAt: instant("2026-01-02T00:00:00Z") });
    const liveHolding = Object.freeze({ id: "value-live-holding" as never, bookId: IDS.book, lotId: liveLot.id, accountId: account("inventory"), commodityId: IDS.usd, basisCommodityId: IDS.usd, remainingQuantity: ExactRational.of(2n, 1n), remainingTotalBasis: ExactRational.of(20n, 1n), remainingValuationAllowance: ExactRational.zero(), remainingCarryingAmount: ExactRational.of(20n, 1n) });
    const disposedHolding = Object.freeze({ id: "value-disposed-holding" as never, bookId: IDS.book, lotId: disposedLot.id, accountId: account("inventory"), commodityId: IDS.usd, basisCommodityId: IDS.usd, remainingQuantity: ExactRational.zero(), remainingTotalBasis: ExactRational.zero(), remainingValuationAllowance: ExactRational.zero(), remainingCarryingAmount: ExactRational.zero() });
    const policies: readonly AccountingPolicy[] = [costPolicy, valuePolicy];
    const liveAllocation = (change: ExactRational, allowance = ExactRational.zero()) => ({ ordinal: 1n, lotId: liveLot.id, holdingId: liveHolding.id, remainingBasisChange: change, recognizedCostChange: ExactRational.zero(), remainingValuationAllowanceChange: allowance });
    const direct = calculateInventoryValueAdjustment(policies, IDS.book, IDS.usd, [liveLot, disposedLot], [liveHolding, disposedHolding], {
      id: inventoryValueAdjustmentId("value-direct"), kind: "directlyAttributableCost", effectiveOn: localDate("2026-01-15"), policyEffectiveAt: instant("2026-01-15T00:00:00Z"), policyId: valuePolicy.id, policyVersion: valuePolicy.version, generatedEffectKey: "value-direct:journal:0" as never, exactSourceAmount: ExactRational.of(5n, 1n), allocations: [liveAllocation(ExactRational.of(5n, 1n))], evidence: valueDerivation.evidence, derivation: valueDerivation,
    });
    expect(direct.disposition).toBe("draft");
    if (direct.disposition !== "draft") return;
    const directEffect = direct.draft.effects[0]!;
    expect(directEffect.type).toBe("inventoryValueAdjustment");
    if (directEffect.type !== "inventoryValueAdjustment") return;
    expect(directEffect.value.bookedAdjustment.amount.toRational().equals(ExactRational.of(5n, 1n))).toBeTrue();
    const afterDirect = applyInventoryValueAdjustmentToHoldings([liveHolding, disposedHolding], directEffect.value.allocations);
    expect(afterDirect[0]?.remainingTotalBasis.equals(ExactRational.of(25n, 1n))).toBeTrue();

    const writeDown = calculateInventoryValueAdjustment(policies, IDS.book, IDS.usd, [liveLot, disposedLot], afterDirect, {
      id: inventoryValueAdjustmentId("value-write-down"), kind: "writeDown", effectiveOn: localDate("2026-01-16"), policyEffectiveAt: instant("2026-01-16T00:00:00Z"), policyId: valuePolicy.id, policyVersion: valuePolicy.version, generatedEffectKey: "value-write-down:journal:0" as never, exactSourceAmount: ExactRational.of(-3n, 1n), allocations: [liveAllocation(ExactRational.zero(), ExactRational.of(-3n, 1n))], evidence: valueDerivation.evidence, derivation: valueDerivation,
    });
    expect(writeDown.disposition).toBe("draft");
    if (writeDown.disposition === "draft" && writeDown.draft.effects[0]?.type === "inventoryValueAdjustment") {
      const afterWriteDown = applyInventoryValueAdjustmentToHoldings(afterDirect, writeDown.draft.effects[0].value.allocations);
      expect(afterWriteDown[0]?.remainingValuationAllowance.equals(ExactRational.of(-3n, 1n))).toBeTrue();
      const reversal = calculateInventoryValueAdjustment(policies, IDS.book, IDS.usd, [liveLot, disposedLot], afterWriteDown, {
        id: inventoryValueAdjustmentId("value-write-down-reversal"), kind: "writeDownReversal", effectiveOn: localDate("2026-01-17"), policyEffectiveAt: instant("2026-01-17T00:00:00Z"), policyId: valuePolicy.id, policyVersion: valuePolicy.version, generatedEffectKey: "value-write-down-reversal:journal:0" as never, exactSourceAmount: ExactRational.of(3n, 1n), allocations: [liveAllocation(ExactRational.zero(), ExactRational.of(3n, 1n))], evidence: valueDerivation.evidence, derivation: valueDerivation,
      });
      expect(reversal.disposition).toBe("draft");
      if (reversal.disposition === "draft" && reversal.draft.effects[0]?.type === "inventoryValueAdjustment") {
        expect(applyInventoryValueAdjustmentToHoldings(afterWriteDown, reversal.draft.effects[0].value.allocations)[0]?.remainingValuationAllowance.isZero()).toBeTrue();
      }
    }

    const disposed = calculateInventoryValueAdjustment(policies, IDS.book, IDS.usd, [liveLot, disposedLot], [liveHolding, disposedHolding], {
      id: inventoryValueAdjustmentId("value-disposed-cost"), kind: "productionOverhead", effectiveOn: localDate("2026-01-18"), policyEffectiveAt: instant("2026-01-18T00:00:00Z"), policyId: valuePolicy.id, policyVersion: valuePolicy.version, generatedEffectKey: "value-disposed-cost:journal:0" as never, exactSourceAmount: ExactRational.of(2n, 1n), allocations: [{ ordinal: 1n, lotId: disposedLot.id, remainingBasisChange: ExactRational.zero(), recognizedCostChange: ExactRational.of(2n, 1n), remainingValuationAllowanceChange: ExactRational.zero() }], evidence: valueDerivation.evidence, derivation: valueDerivation,
    });
    expect(disposed.disposition).toBe("draft");
    const disposedHoldingTarget = calculateInventoryValueAdjustment(policies, IDS.book, IDS.usd, [liveLot, disposedLot], [liveHolding, disposedHolding], {
      id: inventoryValueAdjustmentId("value-disposed-holding-target"), kind: "productionOverhead", effectiveOn: localDate("2026-01-18"), policyEffectiveAt: instant("2026-01-18T00:00:00Z"), policyId: valuePolicy.id, policyVersion: valuePolicy.version, generatedEffectKey: "value-disposed-holding-target:journal:0" as never, exactSourceAmount: ExactRational.of(2n, 1n), allocations: [{ ordinal: 1n, lotId: disposedLot.id, holdingId: disposedHolding.id, remainingBasisChange: ExactRational.zero(), recognizedCostChange: ExactRational.of(2n, 1n), remainingValuationAllowanceChange: ExactRational.zero() }], evidence: valueDerivation.evidence, derivation: valueDerivation,
    });
    expect(disposedHoldingTarget).toMatchObject({ disposition: "rejected" });

    const rebate = calculateInventoryValueAdjustment(policies, IDS.book, IDS.usd, [liveLot, disposedLot], [liveHolding, disposedHolding], {
      id: inventoryValueAdjustmentId("value-rebate"), kind: "purchaseRebate", effectiveOn: localDate("2026-01-19"), policyEffectiveAt: instant("2026-01-19T00:00:00Z"), policyId: valuePolicy.id, policyVersion: valuePolicy.version, generatedEffectKey: "value-rebate:journal:0" as never, exactSourceAmount: ExactRational.of(-2n, 1n), allocations: [liveAllocation(ExactRational.of(-2n, 1n))], evidence: valueDerivation.evidence, derivation: valueDerivation,
    });
    expect(rebate.disposition).toBe("draft");
    const invalidSign = calculateInventoryValueAdjustment(policies, IDS.book, IDS.usd, [liveLot, disposedLot], [liveHolding, disposedHolding], { id: inventoryValueAdjustmentId("value-invalid-sign"), kind: "writeDown", effectiveOn: localDate("2026-01-20"), policyEffectiveAt: instant("2026-01-20T00:00:00Z"), policyId: valuePolicy.id, policyVersion: valuePolicy.version, generatedEffectKey: "value-invalid-sign:journal:0" as never, exactSourceAmount: ExactRational.of(1n, 1n), allocations: [liveAllocation(ExactRational.zero(), ExactRational.of(1n, 1n))], evidence: valueDerivation.evidence, derivation: valueDerivation });
    expect(invalidSign).toMatchObject({ disposition: "rejected" });
    if (invalidSign.disposition === "rejected") expect(invalidSign.diagnostics[0]?.message).toContain("Write-downs");
    expect(calculateInventoryValueAdjustment(policies, IDS.book, IDS.usd, [liveLot, disposedLot], [liveHolding, disposedHolding], { id: inventoryValueAdjustmentId("value-invalid-negative"), kind: "writeDown", effectiveOn: localDate("2026-01-20"), policyEffectiveAt: instant("2026-01-20T00:00:00Z"), policyId: valuePolicy.id, policyVersion: valuePolicy.version, generatedEffectKey: "value-invalid-negative:journal:0" as never, exactSourceAmount: ExactRational.of(-21n, 1n), allocations: [liveAllocation(ExactRational.zero(), ExactRational.of(-21n, 1n))], evidence: valueDerivation.evidence, derivation: valueDerivation })).toMatchObject({ disposition: "rejected" });
    expect(calculateInventoryValueAdjustment(policies, IDS.book, IDS.usd, [liveLot, disposedLot], [liveHolding, disposedHolding], { id: inventoryValueAdjustmentId("value-invalid-mixed"), kind: "writeDown", effectiveOn: localDate("2026-01-20"), policyEffectiveAt: instant("2026-01-20T00:00:00Z"), policyId: valuePolicy.id, policyVersion: valuePolicy.version, generatedEffectKey: "value-invalid-mixed:journal:0" as never, exactSourceAmount: ExactRational.of(-2n, 1n), allocations: [liveAllocation(ExactRational.of(-1n, 1n), ExactRational.of(-1n, 1n))], evidence: valueDerivation.evidence, derivation: valueDerivation })).toMatchObject({ disposition: "rejected" });
    expect(calculateInventoryValueAdjustment(policies, IDS.book, IDS.usd, [liveLot, disposedLot], [liveHolding, disposedHolding], { id: inventoryValueAdjustmentId("value-invalid"), kind: "writeDown", effectiveOn: localDate("2026-01-20"), policyEffectiveAt: instant("2026-01-20T00:00:00Z"), policyId: valuePolicy.id, policyVersion: valuePolicy.version, generatedEffectKey: "value-invalid:journal:0" as never, exactSourceAmount: ExactRational.of(1n, 1n), allocations: [liveAllocation(ExactRational.of(1n, 1n))], evidence: valueDerivation.evidence, derivation: valueDerivation })).toMatchObject({ disposition: "rejected" });
  });

  test("recognizes open items and conserves settlement allocation edges", () => {
    const openValue = { id: openItemId("O1"), bookId: IDS.book, kind: "receivable" as const, scope: { externalPartyId: "CUSTOMER", controlAccountId: account("ar") }, recognitionPostingId: postingId("ar-posting"), recognizedOn: localDate("2026-01-01"), denominationCommodityId: IDS.usd, denomination: ExactRational.of(100n, 1n), bookValue: ExactRational.of(100n, 1n), derivation: accountingDerivation };
    const opened = recognizeOpenItem(emptyAccountingCanonicalState(), { value: openValue });
    expect(opened.disposition).toBe("draft");
    if (opened.disposition !== "draft") return;
    let state = applyAccountingEffect(emptyAccountingCanonicalState(), opened.draft.effects[0]!);
    expect(recognizeOpenItem(state, { value: openValue }).disposition).toBe("rejected");
    expect(recognizeOpenItem(state, { value: { ...openValue, id: openItemId("ZERO"), bookValue: ExactRational.zero() } }).disposition).toBe("rejected");
    const settlement = { id: settlementId("S1"), bookId: IDS.book, kind: "cash" as const, scope: openValue.scope, settlementPostingId: postingId("cash-posting"), settledAt: instant("2026-01-15T00:00:00Z"), denominationCommodityId: IDS.usd, denomination: ExactRational.of(100n, 1n), bookValue: ExactRational.of(100n, 1n), derivation: accountingDerivation };
    const edge = { id: settlementAllocationId("SA1"), openItemId: openValue.id, settlementId: settlement.id, allocatedBookValue: ExactRational.of(100n, 1n), allocatedOpenQuantity: ExactRational.of(100n, 1n), allocatedSettlementQuantity: ExactRational.of(100n, 1n), derivation: accountingDerivation };
    const settled = applySettlement(state, { settlement, allocations: [edge] });
    const read = settlementReadContext(state);
    const request = { settlement, allocations: [edge] };
    expect(calculateSettlement(read, request)).toEqual(settled);
    expect(() => calculateSettlement({ ...read, settlementIdentity: () => undefined } as never, request)).toThrow("Incomplete settlement identity evidence");
    expect(() => calculateSettlement({ ...read, allocationIdentity: () => undefined } as never, request)).toThrow("Incomplete settlement identity evidence");
    expect(() => calculateSettlement({ ...read, openItem: () => undefined } as never, request)).toThrow("Incomplete open-item evidence");
    expect(() => calculateSettlement({ ...read, allocatedToOpenItem: () => undefined } as never, request)).toThrow("Incomplete settlement totals evidence");
    for (const totals of [
      { bookValue: -1, quantity: one },
      { bookValue: one, quantity: undefined },
      { bookValue: one.negate(), quantity: one },
      { bookValue: one, quantity: one.negate() },
    ])
      expect(() => calculateSettlement({ ...read, allocatedToOpenItem: () => totals } as never, request)).toThrow("Incomplete settlement totals evidence");
    expect(settled.disposition).toBe("draft");
    if (settled.disposition === "draft") for (const effect of settled.draft.effects) state = applyAccountingEffect(state, effect);
    expect(applySettlement(state, { settlement, allocations: [edge] }).disposition).toBe("rejected");
    expect(applySettlement(state, { settlement: { ...settlement, id: settlementId("EMPTY") }, allocations: [] }).disposition).toBe("rejected");
    const foreign = { ...settlement, id: settlementId("FX"), scope: { ...settlement.scope, externalPartyId: "OTHER" } };
    expect(applySettlement(state, { settlement: foreign, allocations: [{ ...edge, id: settlementAllocationId("BAD"), settlementId: foreign.id }] }).disposition).toBe("rejected");

    const otherCommodity = "commodity-EUR" as never;
    const foreignOpen = recognizeOpenItem(emptyAccountingCanonicalState(), { value: { ...openValue, id: openItemId("O-FX"), denominationCommodityId: otherCommodity } });
    expect(foreignOpen.disposition).toBe("draft");
    if (foreignOpen.disposition === "draft") {
      const foreignState = applyAccountingEffect(emptyAccountingCanonicalState(), foreignOpen.draft.effects[0]!);
      const equalCarryingSettlement = { ...settlement, id: settlementId("S-FX-EQUAL"), denominationCommodityId: IDS.usd };
      const equalCarryingEdge = { ...edge, id: settlementAllocationId("SA-FX-EQUAL"), openItemId: openItemId("O-FX"), settlementId: equalCarryingSettlement.id };
      expect(applySettlement(foreignState, { settlement: equalCarryingSettlement, allocations: [equalCarryingEdge] }).disposition).toBe("rejected");
    }
  });

  test("remeasures monetary positions and reverses unrealized effects exactly once", () => {
    const request = { id: remeasurementResultId("FX1"), policyId: currency.id, policyVersion: currency.version, classificationPolicyId: monetary.id, classificationPolicyVersion: monetary.version, governedAt: instant("2026-01-31T00:00:00Z"), kind: "unrealized" as const, classification: "monetary" as const, sourcePostingId: postingId("foreign-position"), effectiveOn: localDate("2026-01-31"), denominationCommodityId: IDS.usd, denomination: ExactRational.of(100n, 1n), carryingBookValue: ExactRational.of(110n, 1n), valuationPath: { fromCommodityId: IDS.usd, toCommodityId: IDS.usd, effectiveAt: instant("2026-01-31T00:00:00Z"), observedAt: instant("2026-01-30T00:00:00Z"), rate: ExactRational.of(6n, 5n), evidenceIds: [accountingDerivation.evidence[0]!.id] }, positionAccountId: account("ar"), derivation: accountingDerivation };
    const calculated = calculateCurrencyRemeasurement([monetary, currency], IDS.book, IDS.usd, request);
    expect(calculated.disposition).toBe("draft");
    if (calculated.disposition !== "draft") return;
    let state = applyAccountingEffect(emptyAccountingCanonicalState(), calculated.draft.effects[0]!);
    const reversal = calculateCurrencyRemeasurement([monetary, currency], IDS.book, IDS.usd, { ...request, id: remeasurementResultId("unused"), governedAt: instant("2026-02-01T00:00:00Z"), effectiveOn: localDate("2026-02-01"), valuationPath: { ...request.valuationPath, effectiveAt: instant("2026-02-01T00:00:00Z") }, reversalOf: request.id, reversalId: remeasurementReversalId("FXR1") }, state);
    expect(reversal.disposition).toBe("draft");
    if (reversal.disposition === "draft") state = applyAccountingEffect(state, reversal.draft.effects[0]!);
    expect(calculateCurrencyRemeasurement([monetary, currency], IDS.book, IDS.usd, { ...request, reversalOf: request.id }, state).disposition).toBe("rejected");
    expect(calculateCurrencyRemeasurement([monetary, currency], IDS.book, IDS.usd, { ...request, classification: "nonMonetary" }).disposition).toBe("rejected");
    expect(calculateCurrencyRemeasurement([monetary, { ...currency, bookId: "other" as never }], IDS.book, IDS.usd, request).disposition).toBe("rejected");

    const observedAtBoundary = calculateCurrencyRemeasurement([monetary, currency], IDS.book, IDS.usd, { ...request, id: remeasurementResultId("FX-OBSERVED-AT"), valuationPath: { ...request.valuationPath, observedAt: request.governedAt } });
    expect(observedAtBoundary.disposition).toBe("draft");

    const zeroRequest = { ...request, id: remeasurementResultId("FX-ZERO"), carryingBookValue: ExactRational.of(120n, 1n) };
    const zeroResult = calculateCurrencyRemeasurement([monetary, currency], IDS.book, IDS.usd, zeroRequest);
    expect(zeroResult.disposition).toBe("draft");
    if (zeroResult.disposition === "draft") {
      const zeroState = applyAccountingEffect(emptyAccountingCanonicalState(), zeroResult.draft.effects[0]!);
      const missingId = calculateCurrencyRemeasurement([monetary, currency], IDS.book, IDS.usd, { ...zeroRequest, id: remeasurementResultId("FX-ZERO-UNUSED"), reversalOf: zeroRequest.id }, zeroState);
      expect(missingId.disposition).toBe("rejected");
      const zeroReversal = calculateCurrencyRemeasurement([monetary, currency], IDS.book, IDS.usd, { ...zeroRequest, id: remeasurementResultId("FX-ZERO-UNUSED"), reversalOf: zeroRequest.id, reversalId: remeasurementReversalId("FX-ZERO-REV") }, zeroState);
      expect(zeroReversal.disposition).toBe("draft");
      if (zeroReversal.disposition === "draft") expect(zeroReversal.draft.journals[0]?.postings[1]?.accountId).toBe(currency.lossAccountId);
    }

    const otherRequest = { ...request, id: remeasurementResultId("FX-OTHER"), sourcePostingId: postingId("foreign-position-other") };
    const otherResult = calculateCurrencyRemeasurement([monetary, currency], IDS.book, IDS.usd, otherRequest);
    if (calculated.disposition === "draft" && otherResult.disposition === "draft") {
      let multiState = applyAccountingEffect(emptyAccountingCanonicalState(), calculated.draft.effects[0]!);
      multiState = applyAccountingEffect(multiState, otherResult.draft.effects[0]!);
      const otherReversal = calculateCurrencyRemeasurement([monetary, currency], IDS.book, IDS.usd, { ...otherRequest, id: remeasurementResultId("FX-OTHER-UNUSED"), reversalOf: otherRequest.id, reversalId: remeasurementReversalId("FX-OTHER-REV") }, multiState);
      expect(otherReversal.disposition).toBe("draft");
      if (otherReversal.disposition === "draft") multiState = applyAccountingEffect(multiState, otherReversal.draft.effects[0]!);
      expect(calculateCurrencyRemeasurement([monetary, currency], IDS.book, IDS.usd, { ...request, id: remeasurementResultId("FX-TARGET-UNUSED"), reversalOf: request.id, reversalId: remeasurementReversalId("FX-TARGET-REV") }, multiState).disposition).toBe("draft");
    }
  });

  test("creates and recognizes straight-line, declining, and usage schedules", () => {
    for (const method of ["straightLine", "decliningBalance", "unitsOfProduction"] as const) {
      const policy = allocation(method);
      const request = { id: allocationScheduleId(`SCH-${method}`), policyId: policy.id, policyVersion: policy.version, governedAt: instant("2026-01-01T00:00:00Z"), sourcePostingId: postingId(`source-${method}`), sourceBasis: ExactRational.of(120n, 1n), residualValue: ExactRational.zero(), startsOn: localDate("2026-01-01"), endsOn: localDate("2026-03-31"), ...(method === "unitsOfProduction" ? { usage: [{ date: localDate("2026-01-31"), value: one }, { date: localDate("2026-02-28"), value: ExactRational.of(2n, 1n) }] } : {}), derivation: accountingDerivation };
      const scheduled = createAllocationSchedule([policy], IDS.book, request);
      expect(scheduled.disposition).toBe("draft");
      if (scheduled.disposition !== "draft") continue;
      let state = applyAccountingEffect(emptyAccountingCanonicalState(), scheduled.draft.effects[0]!);
      const recognized = recognizeScheduledAllocation([policy], state, IDS.usd, { id: allocationRecognitionId(`REC-${method}`), scheduleId: request.id, ordinal: 1n, governedAt: instant("2026-01-31T00:00:00Z"), derivation: accountingDerivation });
      expect(recognized.disposition).toBe("draft");
      if (recognized.disposition === "draft") state = applyAccountingEffect(state, recognized.draft.effects[0]!);
      expect(recognizeScheduledAllocation([policy], state, IDS.usd, { id: allocationRecognitionId(`DUP-${method}`), scheduleId: request.id, ordinal: 1n, governedAt: instant("2026-01-31T00:00:00Z"), derivation: accountingDerivation }).disposition).toBe("rejected");
    }
    const missingRate = { ...allocation("decliningBalance"), decliningRate: undefined } as unknown as AllocationPolicy;
    expect(createAllocationSchedule([missingRate], IDS.book, { id: allocationScheduleId("BAD-RATE"), policyId: missingRate.id, policyVersion: missingRate.version, governedAt: instant("2026-01-01T00:00:00Z"), sourcePostingId: postingId("bad"), sourceBasis: ten, residualValue: ExactRational.zero(), startsOn: localDate("2026-01-01"), endsOn: localDate("2026-02-01"), derivation: accountingDerivation }).disposition).toBe("rejected");
    const usage = allocation("unitsOfProduction");
    expect(createAllocationSchedule([usage], IDS.book, { id: allocationScheduleId("BAD-USAGE"), policyId: usage.id, policyVersion: usage.version, governedAt: instant("2026-01-01T00:00:00Z"), sourcePostingId: postingId("bad-usage"), sourceBasis: ten, residualValue: ExactRational.zero(), startsOn: localDate("2026-01-01"), endsOn: localDate("2026-02-01"), derivation: accountingDerivation }).disposition).toBe("rejected");
    expect(createAllocationSchedule([], IDS.book, { id: allocationScheduleId("BAD"), policyId: policyId("missing"), policyVersion: semanticVersion("1.0.0"), governedAt: instant("2026-01-01T00:00:00Z"), sourcePostingId: postingId("bad-source"), sourceBasis: ten, residualValue: ExactRational.of(11n, 1n), startsOn: localDate("2026-02-01"), endsOn: localDate("2026-01-01"), derivation: accountingDerivation }).disposition).toBe("rejected");
  });

  test("preserves exact allocation endpoints and recognizes a non-first installment", () => {
    const straight = allocation("straightLine");
    const zeroBasis = createAllocationSchedule([straight], IDS.book, { id: allocationScheduleId("SCH-ZERO-BASIS"), policyId: straight.id, policyVersion: straight.version, governedAt: instant("2026-01-01T00:00:00Z"), sourcePostingId: postingId("zero-basis-source"), sourceBasis: ten, residualValue: ten, startsOn: localDate("2026-01-01"), endsOn: localDate("2026-01-01"), derivation: accountingDerivation });
    expect(zeroBasis.disposition).toBe("draft");
    if (zeroBasis.disposition === "draft" && zeroBasis.draft.effects[0]?.type === "allocationSchedule") {
      expect(zeroBasis.draft.effects[0].value.installments).toHaveLength(1);
      expect(zeroBasis.draft.effects[0].value.installments[0]?.amount.isZero()).toBeTrue();
    }

    const declining = Object.freeze({ ...allocation("decliningBalance"), decliningRate: one });
    const exactRate = createAllocationSchedule([declining], IDS.book, { id: allocationScheduleId("SCH-DECLINING-ONE"), policyId: declining.id, policyVersion: declining.version, governedAt: instant("2026-01-01T00:00:00Z"), sourcePostingId: postingId("declining-one-source"), sourceBasis: ExactRational.of(120n, 1n), residualValue: ExactRational.zero(), startsOn: localDate("2026-01-01"), endsOn: localDate("2026-03-31"), derivation: accountingDerivation });
    expect(exactRate.disposition).toBe("draft");
    if (exactRate.disposition === "draft" && exactRate.draft.effects[0]?.type === "allocationSchedule") {
      const scheduleEffect = exactRate.draft.effects[0];
      expect(scheduleEffect.value.installments).toHaveLength(3);
      expect(scheduleEffect.value.installments.map((item) => item.amount.toString())).toEqual(["10/1", "55/6", "605/6"]);
      const state = applyAccountingEffect(emptyAccountingCanonicalState(), scheduleEffect);
      const second = recognizeScheduledAllocation([declining], state, IDS.usd, { id: allocationRecognitionId("REC-SECOND"), scheduleId: scheduleEffect.value.id, ordinal: 2n, governedAt: instant("2026-02-28T00:00:00Z"), derivation: accountingDerivation });
      expect(second.disposition).toBe("draft");
      if (second.disposition === "draft") {
        expect(second.draft.journals[0]?.accountingDate).toBe(localDate("2026-02-01"));
        expect(second.draft.journals[0]?.postings[0]?.exactBookValue.equals(ExactRational.of(55n, 6n))).toBeTrue();
        const recognizedState = applyAccountingEffect(state, second.draft.effects[0]!);
        expect(recognizeScheduledAllocation([declining], recognizedState, IDS.usd, { id: allocationRecognitionId("REC-SECOND-DUP-ORDINAL"), scheduleId: scheduleEffect.value.id, ordinal: 2n, governedAt: instant("2026-02-28T00:00:00Z"), derivation: accountingDerivation }).disposition).toBe("rejected");
        expect(recognizeScheduledAllocation([declining], recognizedState, IDS.usd, { id: allocationRecognitionId("REC-SECOND"), scheduleId: scheduleEffect.value.id, ordinal: 3n, governedAt: instant("2026-03-31T00:00:00Z"), derivation: accountingDerivation }).disposition).toBe("rejected");
      }
    }

    const secondScheduleResult = createAllocationSchedule([straight], IDS.book, { id: allocationScheduleId("SCH-SECOND-INDEPENDENT"), policyId: straight.id, policyVersion: straight.version, governedAt: instant("2026-01-01T00:00:00Z"), sourcePostingId: postingId("second-independent-source"), sourceBasis: ten, residualValue: ExactRational.zero(), startsOn: localDate("2026-01-01"), endsOn: localDate("2026-02-28"), derivation: accountingDerivation });
    const firstScheduleResult = createAllocationSchedule([straight], IDS.book, { id: allocationScheduleId("SCH-FIRST-INDEPENDENT"), policyId: straight.id, policyVersion: straight.version, governedAt: instant("2026-01-01T00:00:00Z"), sourcePostingId: postingId("first-independent-source"), sourceBasis: ten, residualValue: ExactRational.zero(), startsOn: localDate("2026-01-01"), endsOn: localDate("2026-02-28"), derivation: accountingDerivation });
    if (firstScheduleResult.disposition === "draft" && secondScheduleResult.disposition === "draft") {
      let state = applyAccountingEffect(emptyAccountingCanonicalState(), firstScheduleResult.draft.effects[0]!);
      state = applyAccountingEffect(state, secondScheduleResult.draft.effects[0]!);
      const firstRecognition = recognizeScheduledAllocation([straight], state, IDS.usd, { id: allocationRecognitionId("REC-FIRST-SCHEDULE"), scheduleId: allocationScheduleId("SCH-FIRST-INDEPENDENT"), ordinal: 1n, governedAt: instant("2026-01-31T00:00:00Z"), derivation: accountingDerivation });
      expect(firstRecognition.disposition).toBe("draft");
      if (firstRecognition.disposition === "draft") state = applyAccountingEffect(state, firstRecognition.draft.effects[0]!);
      expect(recognizeScheduledAllocation([straight], state, IDS.usd, { id: allocationRecognitionId("REC-SECOND-SCHEDULE"), scheduleId: allocationScheduleId("SCH-SECOND-INDEPENDENT"), ordinal: 1n, governedAt: instant("2026-01-31T00:00:00Z"), derivation: accountingDerivation }).disposition).toBe("draft");
    }
  });

  test("revises allocation schedules prospectively and preserves the prior recognition cutoff", () => {
    const schedulePolicy = allocation("straightLine");
    const scheduleDerivation = Object.freeze({ ...accountingDerivation, policyId: schedulePolicy.id, policyVersion: schedulePolicy.version });
    const originalRequest = { id: allocationScheduleId("revision-original"), policyId: schedulePolicy.id, policyVersion: schedulePolicy.version, governedAt: instant("2026-01-01T00:00:00Z"), sourcePostingId: postingId("revision-source"), sourceBasis: ExactRational.of(120n, 1n), residualValue: ExactRational.zero(), startsOn: localDate("2026-01-01"), endsOn: localDate("2026-03-31"), derivation: accountingDerivation };
    const original = createAllocationSchedule([schedulePolicy], IDS.book, originalRequest);
    expect(original.disposition).toBe("draft");
    if (original.disposition !== "draft") return;
    let state = applyAccountingEffect(emptyAccountingCanonicalState(), original.draft.effects[0]!);
    const recognition = recognizeScheduledAllocation([schedulePolicy], state, IDS.usd, { id: allocationRecognitionId("revision-recognition"), scheduleId: originalRequest.id, ordinal: 1n, governedAt: instant("2026-01-31T00:00:00Z"), derivation: scheduleDerivation });
    expect(recognition.disposition).toBe("draft");
    if (recognition.disposition !== "draft") return;
    state = applyAccountingEffect(state, recognition.draft.effects[0]!);
    const estimate = reviseAllocationSchedule([schedulePolicy], state, IDS.book, IDS.usd, {
      id: allocationScheduleRevisionId("revision-estimate"), kind: "estimateChange", effectiveOn: localDate("2026-02-01"), policyEffectiveAt: instant("2026-02-01T00:00:00Z"), originalScheduleId: originalRequest.id, priorRecognitionIds: [allocationRecognitionId("revision-recognition")], policyId: schedulePolicy.id, policyVersion: schedulePolicy.version, revisedResidualValue: ExactRational.zero(), successorScheduleId: allocationScheduleId("revision-successor"), revisedEndsOn: localDate("2026-03-31"), evidence: scheduleDerivation.evidence, derivation: scheduleDerivation,
    });
    expect(estimate.disposition).toBe("draft");
    if (estimate.disposition !== "draft") return;
    expect(estimate.draft.journals).toHaveLength(0);
    expect(estimate.draft.effects.map((effect) => effect.type)).toEqual(["allocationScheduleRevision", "allocationSchedule"]);
    for (const effect of estimate.draft.effects) state = applyAccountingEffect(state, effect);
    expect(recognizeScheduledAllocation([schedulePolicy], state, IDS.usd, { id: allocationRecognitionId("revision-future-recognition"), scheduleId: originalRequest.id, ordinal: 2n, governedAt: instant("2026-02-28T00:00:00Z"), derivation: scheduleDerivation }).disposition).toBe("rejected");
    expect(reviseAllocationSchedule([schedulePolicy], state, IDS.book, IDS.usd, { id: allocationScheduleRevisionId("revision-duplicate"), kind: "estimateChange", effectiveOn: localDate("2026-02-01"), policyEffectiveAt: instant("2026-02-01T00:00:00Z"), originalScheduleId: originalRequest.id, priorRecognitionIds: [allocationRecognitionId("revision-recognition")], policyId: schedulePolicy.id, policyVersion: schedulePolicy.version, revisedResidualValue: ExactRational.zero(), successorScheduleId: allocationScheduleId("revision-successor-duplicate"), revisedEndsOn: localDate("2026-03-31"), evidence: scheduleDerivation.evidence, derivation: scheduleDerivation }).disposition).toBe("rejected");

    const cutoffOriginal = createAllocationSchedule([schedulePolicy], IDS.book, { ...originalRequest, id: allocationScheduleId("revision-cutoff-original"), sourcePostingId: postingId("revision-cutoff-source") });
    if (cutoffOriginal.disposition === "draft") {
      let cutoffState = applyAccountingEffect(emptyAccountingCanonicalState(), cutoffOriginal.draft.effects[0]!);
      const cutoffRecognition = recognizeScheduledAllocation([schedulePolicy], cutoffState, IDS.usd, { id: allocationRecognitionId("revision-cutoff-recognition"), scheduleId: allocationScheduleId("revision-cutoff-original"), ordinal: 1n, governedAt: instant("2026-01-31T00:00:00Z"), derivation: scheduleDerivation });
      if (cutoffRecognition.disposition === "draft") cutoffState = applyAccountingEffect(cutoffState, cutoffRecognition.draft.effects[0]!);
      expect(reviseAllocationSchedule([schedulePolicy], cutoffState, IDS.book, IDS.usd, { id: allocationScheduleRevisionId("revision-cutoff"), kind: "estimateChange", effectiveOn: localDate("2026-01-01"), policyEffectiveAt: instant("2026-01-31T00:00:00Z"), originalScheduleId: allocationScheduleId("revision-cutoff-original"), priorRecognitionIds: [allocationRecognitionId("revision-cutoff-recognition")], policyId: schedulePolicy.id, policyVersion: schedulePolicy.version, revisedResidualValue: ExactRational.zero(), successorScheduleId: allocationScheduleId("revision-cutoff-successor"), revisedEndsOn: localDate("2026-03-31"), evidence: scheduleDerivation.evidence, derivation: scheduleDerivation })).toMatchObject({ disposition: "rejected" });
    }

    const impairmentSource = createAllocationSchedule([schedulePolicy], IDS.book, { ...originalRequest, id: allocationScheduleId("revision-impairment-original"), sourcePostingId: postingId("revision-impairment-source") });
    expect(impairmentSource.disposition).toBe("draft");
    if (impairmentSource.disposition === "draft") {
      const impairmentState = applyAccountingEffect(emptyAccountingCanonicalState(), impairmentSource.draft.effects[0]!);
      const impairment = reviseAllocationSchedule([schedulePolicy], impairmentState, IDS.book, IDS.usd, { id: allocationScheduleRevisionId("revision-impairment"), kind: "impairment", effectiveOn: localDate("2026-01-01"), policyEffectiveAt: instant("2026-01-15T00:00:00Z"), originalScheduleId: allocationScheduleId("revision-impairment-original"), priorRecognitionIds: [], policyId: schedulePolicy.id, policyVersion: schedulePolicy.version, revisedResidualValue: ExactRational.zero(), exactAdjustmentAmount: ExactRational.of(-20n, 1n), successorScheduleId: allocationScheduleId("revision-impairment-successor"), revisedEndsOn: localDate("2026-03-31"), generatedEffectKey: "revision-impairment:journal:0" as never, evidence: scheduleDerivation.evidence, derivation: scheduleDerivation });
      expect(impairment.disposition).toBe("draft");
      if (impairment.disposition === "draft") expect(impairment.draft.journals[0]?.postings[0]?.exactBookValue.equals(ExactRational.of(20n, 1n))).toBeTrue();
    }

    const disposalSource = createAllocationSchedule([schedulePolicy], IDS.book, { ...originalRequest, id: allocationScheduleId("revision-disposal-original"), sourcePostingId: postingId("revision-disposal-source") });
    if (disposalSource.disposition === "draft") {
      const disposal = reviseAllocationSchedule([schedulePolicy], applyAccountingEffect(emptyAccountingCanonicalState(), disposalSource.draft.effects[0]!), IDS.book, IDS.usd, { id: allocationScheduleRevisionId("revision-disposal"), kind: "disposal", effectiveOn: localDate("2026-01-15"), policyEffectiveAt: instant("2026-01-15T00:00:00Z"), originalScheduleId: allocationScheduleId("revision-disposal-original"), priorRecognitionIds: [], policyId: schedulePolicy.id, policyVersion: schedulePolicy.version, revisedResidualValue: ExactRational.zero(), exactAdjustmentAmount: ExactRational.of(-120n, 1n), generatedEffectKey: "revision-disposal:journal:0" as never, evidence: scheduleDerivation.evidence, derivation: scheduleDerivation });
      expect(disposal.disposition).toBe("draft");
      if (disposal.disposition === "draft") expect(disposal.draft.effects.map((effect) => effect.type)).toEqual(["allocationScheduleRevision"]);
    }

    const zeroSource = createAllocationSchedule([schedulePolicy], IDS.book, { ...originalRequest, id: allocationScheduleId("revision-zero-original"), sourcePostingId: postingId("revision-zero-source"), sourceBasis: ExactRational.zero(), residualValue: ExactRational.zero() });
    if (zeroSource.disposition === "draft") {
      const termination = reviseAllocationSchedule([schedulePolicy], applyAccountingEffect(emptyAccountingCanonicalState(), zeroSource.draft.effects[0]!), IDS.book, IDS.usd, { id: allocationScheduleRevisionId("revision-termination"), kind: "termination", effectiveOn: localDate("2026-01-15"), policyEffectiveAt: instant("2026-01-15T00:00:00Z"), originalScheduleId: allocationScheduleId("revision-zero-original"), priorRecognitionIds: [], policyId: schedulePolicy.id, policyVersion: schedulePolicy.version, revisedResidualValue: ExactRational.zero(), evidence: scheduleDerivation.evidence, derivation: scheduleDerivation });
      expect(termination.disposition).toBe("draft");
    }
  });

  test("determines compound tax across multiple taxable lines with exact inclusive and exclusive arithmetic", () => {
    const components: TaxPolicy["components"] = Object.freeze([
      taxComponent("TAX-A", { rate: ExactRational.of(1n, 10n), treatment: "inputTax", recoverability: "recoverable", recoverableShare: one, compoundOrdinal: 1n, compoundsOn: Object.freeze([]), liabilityAccountId: account("tax-payable"), recoverableAccountId: account("input-tax") }),
      taxComponent("TAX-B", { rate: ExactRational.of(1n, 20n), treatment: "inputTax", recoverability: "partiallyRecoverable", recoverableShare: ExactRational.of(3n, 5n), compoundOrdinal: 2n, compoundsOn: Object.freeze([policyId("TAX-A")]), liabilityAccountId: account("tax-payable"), recoverableAccountId: account("input-tax"), nonRecoverableAccountId: account("expense") }),
    ]);
    const policy = tax(components);
    const request = taxRequest("TD1", [taxableLine("LINE-1", { policyId: policy.id, policyVersion: policy.version, statedAmount: ExactRational.of(10_000n, 1n), sourceAccountId: account("expense"), payableAccountId: account("ap") })], { sourceTransactionId: "TAX-SOURCE-1" });
    const result = determineTax([policy], IDS.book, IDS.usd, { ...request, governedAt: instant("2026-01-01T00:00:00Z") });
    expect(result.disposition).toBe("draft");
    if (result.disposition === "draft") {
      expect(result.draft.journals[0]?.postings).toHaveLength(3);
      applyAccountingEffect(emptyAccountingCanonicalState(), result.draft.effects[0]!);
    }
    const inclusivePolicy = tax(components.map((component) => Object.freeze({ ...component, inclusion: "inclusive" as const })));
    expect(determineTax([inclusivePolicy], IDS.book, IDS.usd, { ...taxRequest("TD2", [taxableLine("LINE-2", { policyId: inclusivePolicy.id, statedAmount: ExactRational.of(11_550n, 1n), amountIncludesTax: true })]), governedAt: instant("2026-01-01T00:00:00Z") }).disposition).toBe("draft");
    expect(determineTax([], IDS.book, IDS.usd, { ...request, governedAt: instant("2026-01-01T00:00:00Z") }).disposition).toBe("rejected");
    expect(determineTax([policy], IDS.book, IDS.usd, { ...taxRequest("TD-DUP", [taxableLine("SAME-LINE", { policyId: policy.id }), taxableLine("SAME-LINE", { policyId: policy.id })]) }).disposition).toBe("rejected");
    expect(determineTax([tax([{ ...components[0]!, compoundsOn: [policyId("missing")] }])], IDS.book, IDS.usd, { ...request, governedAt: instant("2026-01-01T00:00:00Z") }).disposition).toBe("rejected");
    const missingAccount = tax([{ ...components[0]!, recoverableAccountId: undefined } as never]);
    expect(determineTax([missingAccount], IDS.book, IDS.usd, { ...taxRequest("TD3", [taxableLine("LINE-3", { policyId: missingAccount.id })]), governedAt: instant("2026-01-01T00:00:00Z") }).disposition).toBe("rejected");
  });

  test("determines one atomic multi-line transaction with per-line policies and aggregated postings", () => {
    const food = Object.freeze({ ...tax([taxComponent("FOOD-5", { rate: ExactRational.of(1n, 20n), liabilityAccountId: account("tax-payable"), recoverableAccountId: account("input-tax") })]), id: policyId("tax-food") });
    const standard = Object.freeze({ ...tax([taxComponent("STD-10", { rate: ExactRational.of(1n, 10n), liabilityAccountId: account("tax-payable"), recoverableAccountId: account("input-tax") })]), id: policyId("tax-standard") });
    const result = determineTax([food, standard], IDS.book, IDS.usd, {
      ...taxRequest("TD-MULTI", [
        taxableLine("GROCERIES", { policyId: food.id, policyVersion: food.version, statedAmount: ExactRational.of(2000n, 1n) }),
        taxableLine("SUPPLIES", { policyId: standard.id, policyVersion: standard.version, statedAmount: ExactRational.of(3000n, 1n) }),
      ]),
      governedAt: instant("2026-03-01T12:00:00Z"),
    });
    expect(result.disposition).toBe("draft");
    if (result.disposition !== "draft") return;
    const effect = result.draft.effects[0]!;
    if (effect.type !== "taxDetermination") throw new Error("Expected tax determination");
    expect(effect.value.lines).toHaveLength(2);
    const foodLine = effect.value.lines.find((line) => line.lineId === "GROCERIES");
    const suppliesLine = effect.value.lines.find((line) => line.lineId === "SUPPLIES");
    expect(foodLine?.components[0]?.exactTax.equals(ExactRational.of(100n, 1n))).toBeTrue();
    expect(suppliesLine?.components[0]?.exactTax.equals(ExactRational.of(300n, 1n))).toBeTrue();
    const postings = result.draft.journals[0]?.postings ?? [];
    expect(postings).toHaveLength(3);
    const byAccount = new Map(postings.map((posting) => [posting.accountId, posting.exactBookValue]));
    expect(byAccount.get(account("expense"))?.equals(ExactRational.of(5_000n, 1n))).toBeTrue();
    expect(byAccount.get(account("input-tax"))?.equals(ExactRational.of(400n, 1n))).toBeTrue();
    expect(byAccount.get(account("ap"))?.equals(ExactRational.of(-5_400n, 1n))).toBeTrue();
    expect(postings.some((item) => item.id === "GROCERIES-source-posting")).toBeTrue();
    expect(postings.some((item) => item.id === "GROCERIES-counterparty-posting")).toBeTrue();
    expect(validateAccountingEffectHash(effect)).toBeTrue();
    expect(determineTax([food, standard], IDS.book, IDS.usd, { ...taxRequest("TD-EMPTY", []) }).disposition).toBe("rejected");
  });

  test("ACC-038/046: consolidation scopes account and elimination identities to raw source-book tuples", () => {
    const first = consolidationSource("subsidiary:account-b", [
      { sourceAccountId: "c", classification: "asset", amount: ten },
      { sourceAccountId: "equity", classification: "equity", amount: ten.negate() },
    ]);
    const second = consolidationSource("subsidiary", [
      { sourceAccountId: "b:account-c", classification: "asset", amount: ten.add(ten) },
      { sourceAccountId: "equity", classification: "equity", amount: ten.add(ten).negate() },
    ]);
    const selected = { ...consolidation, accountMappings: [
      consolidationMapping("collision-one", "c", "target-one"),
      consolidationMapping("collision-two", "b:account-c", "target-two"),
      consolidationMapping("collision-equity", "equity", "equity"),
    ] };
    const request = { id: consolidationCompilationId("source-tuple-compilation"), policyId: selected.id,
      policyVersion: selected.version, governedAt: instant("2026-01-31T00:00:00Z"), throughOn: localDate("2026-01-31"),
      targetBookId: IDS.book, sources: [first, second], eliminations: [], derivation: consolidationDerivation,
    };
    const compiled = compileConsolidation([selected], IDS.usd, request);
    expect(compiled.disposition).toBe("draft");
    if (compiled.disposition !== "draft") throw new Error(JSON.stringify(compiled.diagnostics));
    const amounts = new Map(compiled.draft.journals[0]!.postings.map(posting => [posting.accountId, posting.exactBookValue.toString()]));
    expect(amounts.get(account("target-one"))).toBe("10/1");
    expect(amounts.get(account("target-two"))).toBe("20/1");
    const eliminations = [
      { ...consolidationElimination(first.bookId, "c", one, "target-one"), sourcePostingIds: [postingId("same-local-posting")] },
      { ...consolidationElimination(second.bookId, "b:account-c", one.negate(), "target-two"), sourcePostingIds: [postingId("same-local-posting")] },
    ];
    const eliminated = compileConsolidation([selected], IDS.usd, { ...request, eliminations });
    expect(eliminated.disposition).toBe("draft");
    expect(canonicalAccountingValue(eliminated)).toEqual(canonicalAccountingValue(compileConsolidation([selected], IDS.usd,
      { ...request, sources: [second, first], eliminations: [...eliminations].reverse() })));
    const duplicate = [...eliminations, { ...eliminations[0]!, id: "duplicate-same-book", amount: one.negate() },
      { ...eliminations[1]!, id: "duplicate-other-book", amount: one }];
    expect(compileConsolidation([selected], IDS.usd, { ...request, eliminations: duplicate }).disposition).toBe("rejected");
  });

  test("consolidation tie ordering is independent of supplied balance order when raw identifiers contain separators", () => {
    const template = consolidationSource("tie-book", [
      { sourceAccountId: "a:commodity-b", classification: "asset", amount: ten, observedRate: one },
      { sourceAccountId: "a", classification: "asset", amount: ten.add(ten), observedRate: one },
      { sourceAccountId: "equity", classification: "equity", amount: ten.add(ten).add(ten).negate() },
    ]);
    const source = { ...template, balances: template.balances.map((balance, index) => {
      if (index === 2) return balance;
      const currency = commodityId(index === 0 ? "commodity-c" : "commodity-b:commodity-c");
      return { ...balance, unitsCommodityId: currency, valuationPaths: balance.valuationPaths.map(path => ({ ...path,
        steps: path.steps.map(step => ({ ...step, fromCommodityId: currency })),
      })) };
    }) };
    const selected = { ...consolidation,
      accountMappings: [consolidationMapping("tie-a", "a:commodity-b", "target-one"), consolidationMapping("tie-b", "a", "target-two"), consolidationMapping("tie-equity", "equity", "equity")],
      translationRules: [translationRule("tie-rate-a", "a:commodity-b", "target-one"), translationRule("tie-rate-b", "a", "target-two")],
    };
    const request = { id: consolidationCompilationId("tuple-order"), policyId: selected.id, policyVersion: selected.version,
      governedAt: instant("2026-01-31T00:00:00Z"), throughOn: localDate("2026-01-31"), targetBookId: IDS.book,
      sources: [source], eliminations: [], derivation: consolidationDerivation,
    };
    const first = compileConsolidation([selected], IDS.usd, request);
    expect(first.disposition).toBe("draft");
    const reversed = compileConsolidation([selected], IDS.usd, { ...request, sources: [{ ...source, balances: [...source.balances].reverse() }] });
    expect(canonicalAccountingValue(reversed)).toEqual(canonicalAccountingValue(first));
  });

  test("compiles pinned consolidation populations with policy-resident mappings and translation", () => {
    const source = consolidationSource("source-book", [
      { sourceAccountId: "source", classification: "asset", amount: ten },
      { sourceAccountId: "equity", classification: "equity", amount: ten.negate() },
    ]);
    const request = { id: consolidationCompilationId("CC1"), policyId: consolidation.id, policyVersion: consolidation.version, governedAt: instant("2026-01-31T00:00:00Z"), throughOn: localDate("2026-01-31"), targetBookId: IDS.book, sources: [source], eliminations: [], derivation: consolidationDerivation };
    const compiled = compileConsolidation([consolidation], IDS.usd, request);
    expect(compiled.disposition).toBe("draft");
    if (compiled.disposition === "draft") applyAccountingEffect(emptyAccountingCanonicalState(), compiled.draft.effects[0]!);
    const nciPolicy = Object.freeze({ ...consolidation, translationRules: Object.freeze([translationRule("nci-translate-source", "source", "target"), translationRule("nci-translate-equity", "equity", "equity")]) });
    const nciSource = consolidationSource("source-book", [
      { sourceAccountId: "source", classification: "asset", amount: ten, observedRate: ExactRational.of(2n, 1n) },
      { sourceAccountId: "equity", classification: "equity", amount: ten.negate() },
    ], { ownershipShare: ExactRational.of(4n, 5n) });
    const nciSourceWithMethod = { ...nciSource, ownershipShare: ExactRational.of(4n, 5n), votingShare: ExactRational.of(4n, 5n), nonControllingInterestMethod: "proportionateNetAssets" as const };
    const nci = compileConsolidation([nciPolicy], IDS.usd, { ...request, id: consolidationCompilationId("CC-NCI"), sources: [nciSourceWithMethod] });
    expect(nci.disposition).toBe("draft");
    if (nci.disposition === "draft") {
      expect(nci.draft.journals[0]?.postings.some((posting) => posting.accountId === consolidation.nonControllingInterestAccountId)).toBeTrue();
      expect(nci.draft.journals[0]?.postings.some((posting) => posting.accountId === consolidation.translationAdjustmentAccountId)).toBeTrue();
    }
    const fairValueSource = {
      ...consolidationSource("source-book", [
        { sourceAccountId: "source", classification: "asset" as const, amount: ExactRational.of(100n, 1n) },
        { sourceAccountId: "equity", classification: "equity" as const, amount: ExactRational.of(-100n, 1n) },
      ], { ownershipShare: ExactRational.of(4n, 5n) }),
      nonControllingInterestMethod: "fairValue" as const,
      nonControllingInterestFairValue: ExactRational.of(-30n, 1n),
    };
    const fairValue = compileConsolidation([consolidation], IDS.usd, { ...request, id: consolidationCompilationId("CC-NCI-FAIR"), sources: [fairValueSource] });
    expect(fairValue.disposition).toBe("draft");
    if (fairValue.disposition === "draft") {
      const values = (accountId: ReturnType<typeof account>) => fairValue.draft.journals[0]!.postings.filter((posting) => posting.accountId === accountId).reduce((total, posting) => total.add(posting.exactBookValue), ExactRational.zero());
      expect(values(account("equity")).equals(ExactRational.of(-70n, 1n))).toBeTrue();
      expect(values(account("nci")).equals(ExactRational.of(-30n, 1n))).toBeTrue();
    }
    const { nonControllingInterestFairValue: _omittedFairValue, ...missingFairValue } = fairValueSource;
    expect(compileConsolidation([consolidation], IDS.usd, { ...request, sources: [missingFairValue] }).disposition).toBe("rejected");
    expect(compileConsolidation([consolidation], IDS.usd, { ...request, sources: [{ ...fairValueSource, nonControllingInterestFairValue: ExactRational.of(30n, 1n) }] }).disposition).toBe("rejected");
    expect(compileConsolidation([consolidation], IDS.usd, { ...request, sources: [{ ...fairValueSource, nonControllingInterestMethod: "proportionateNetAssets" as const }] }).disposition).toBe("rejected");
    expect(compileConsolidation([consolidation], IDS.usd, { ...request, sources: [{ ...source, nonControllingInterestMethod: "proportionateNetAssets" as const }] }).disposition).toBe("rejected");
    const equitySource = consolidationSource("equity-source-book", [
      { sourceAccountId: "source", classification: "asset", amount: ten },
      { sourceAccountId: "equity", classification: "equity", amount: ten.negate() },
    ], { control: "significantInfluence", method: "equity", ownershipShare: ExactRational.of(2n, 5n) });
    expect(compileConsolidation([consolidation], IDS.usd, { ...request, id: consolidationCompilationId("CC-MIXED"), sources: [source, equitySource] }).disposition).toBe("draft");
    expect(compileConsolidation([], IDS.usd, request).disposition).toBe("rejected");
    expect(compileConsolidation([consolidation], IDS.usd, { ...request, sources: [{ ...source, bookId: IDS.book }] }).disposition).toBe("rejected");
    const unmapped = consolidationSource("unmapped-book", [{ sourceAccountId: "unknown-account", classification: "asset", amount: ten }, { sourceAccountId: "unknown-account-neg", classification: "equity", amount: ten.negate() }]);
    expect(compileConsolidation([consolidation], IDS.usd, { ...request, id: consolidationCompilationId("CC-UNMAPPED"), sources: [unmapped] }).disposition).toBe("rejected");
    const unrelatedRate = consolidationPolicyWithoutSourceRule();
    expect(compileConsolidation([unrelatedRate], IDS.usd, { ...request, id: consolidationCompilationId("CC-NORATE") }).disposition).toBe("rejected");
    const eliminationSource = consolidationSource("source-book", [{ sourceAccountId: "source", classification: "asset", amount: ten }, { sourceAccountId: "equity", classification: "equity", amount: ten.negate() }]);
    const unbalancedEliminations = compileConsolidation([consolidation], IDS.usd, { ...request, id: consolidationCompilationId("CC-UNBALANCED"), sources: [eliminationSource], eliminations: [consolidationElimination("source-book", "source", one), consolidationElimination("source-book", "equity", ExactRational.of(-999n, 1000n))] });
    expect(unbalancedEliminations.disposition).toBe("rejected");
    if (unbalancedEliminations.disposition === "rejected") expect(unbalancedEliminations.diagnostics[0]?.code).toBe("consolidation_input_violation");
    expect(compileConsolidation([consolidation], IDS.usd, { ...request, eliminations: [consolidationElimination("source-book", "source", one)], sources: [consolidationSource("other-source", [{ sourceAccountId: "source", classification: "asset", amount: ten }, { sourceAccountId: "equity", classification: "equity", amount: ten.negate() }])] }).disposition).toBe("rejected");
  });

  function consolidationPolicyWithoutSourceRule(): ConsolidationPolicy {
    return Object.freeze({ ...consolidation, id: policyId("consolidation-no-rule"), translationRules: Object.freeze([translationRule("translate-other", "other-account", "other-target")]) });
  }

  test("snapshots and immutably copies complete accounting policies", () => {
    const policies: AccountingPolicy[] = [inventory(), monetary, currency, allocation("straightLine"), tax([taxComponent("SNAP-TAX")]), consolidation];
    const snapshot = createAccountingPolicySnapshot(policies);
    expect(snapshot.contentHash.digest).toBe(hashAccountingPolicySnapshot(policies).digest);
    expect(Object.isFrozen(snapshot.policies)).toBeTrue();
    expect(Object.isFrozen(immutableAccountingValue({ nested: [{ value: one }] }).nested)).toBeTrue();
    expect(canonicalAccountingValue({ rational: one })).toBeDefined();
    expect(() => canonicalAccountingValue(Symbol("unsupported"))).toThrow();
    const damaged = [inventory()] as InventoryCostPolicy[];
    const damagedPolicy = { ...damaged[0]!, pools: [{ ...damaged[0]!.pools[0]!, contentHash: hashAccountingPolicySnapshot([]) }] } as unknown as InventoryCostPolicy;
    expect(() => createAccountingPolicySnapshot([damagedPolicy])).toThrow();
  });

  test("rejects every external accounting-authority escape hatch", () => {
    for (const attempt of ["journalFactory", "policySelection", "bookOrderAssignment", "commitIntentFactory", "directPersistence"] as const) {
      const diagnostics = rejectExternalAccountingAuthority(attempt);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.code).toBe("external_accounting_authority");
      expect(diagnostics[0]?.path).toBe(`external.${attempt}`);
    }
  });

  test("executes output, reverse-charge, and withholding tax destinations", () => {
    const output = tax([taxComponent("TAX-OUT", { treatment: "outputTax", recoverability: "nonRecoverable", recoverableShare: ExactRational.zero(), liabilityAccountId: account("tax-liability") })]);
    expect(determineTax([output], IDS.book, IDS.usd, { ...taxRequest("TD-TREATMENT", [taxableLine("LINE-TREATMENT", { policyId: output.id, sourceAccountId: account("revenue"), payableAccountId: account("ar") })], { direction: "sale", sourceTransactionId: "TAX-TREATMENT-SOURCE" }) }).disposition).toBe("draft");
    const reverse = tax([taxComponent("TAX-REVERSE", { treatment: "reverseCharge", recoverability: "recoverable", recoverableShare: one, recoverableAccountId: account("input-tax") })]);
    expect(determineTax([reverse], IDS.book, IDS.usd, { ...taxRequest("TD-REVERSE", [taxableLine("LINE-REVERSE", { policyId: reverse.id })], { direction: "purchase", sourceTransactionId: "TAX-REVERSE-SOURCE" }) }).disposition).toBe("draft");
    const withholding = tax([taxComponent("TAX-WITHHOLD", { treatment: "withholding", recoverability: "nonRecoverable", recoverableShare: ExactRational.zero(), liabilityAccountId: account("tax-liability") })]);
    expect(determineTax([withholding], IDS.book, IDS.usd, { ...taxRequest("TD-WITHHOLD", [taxableLine("LINE-WITHHOLD", { policyId: withholding.id })], { direction: "purchase", sourceTransactionId: "TAX-WITHHOLD-SOURCE" }) }).disposition).toBe("draft");

    for (const [id, treatment, direction] of [["OUTPUT", "outputTax", "sale"], ["WITHHOLDING", "withholding", "purchase"]] as const) {
      const invalidRecoverability = tax([taxComponent(`TAX-${id}-RECOVERABLE`, { treatment, recoverability: "recoverable", recoverableShare: one, recoverableAccountId: account("input-tax") })]);
      expect(determineTax([invalidRecoverability], IDS.book, IDS.usd, { ...taxRequest(`TD-${id}-RECOVERABLE`, [taxableLine(`LINE-${id}-RECOVERABLE`, { policyId: invalidRecoverability.id })], { direction }) }).disposition).toBe("rejected");
    }

    const inclusiveOutput = tax([taxComponent("TAX-OUTPUT-INCLUSIVE", { inclusion: "inclusive", treatment: "outputTax", recoverability: "nonRecoverable", recoverableShare: ExactRational.zero() })]);
    const inclusiveOutputResult = determineTax([inclusiveOutput], IDS.book, IDS.usd, { ...taxRequest("TD-OUTPUT-INCLUSIVE", [taxableLine("LINE-OUTPUT-INCLUSIVE", { policyId: inclusiveOutput.id, statedAmount: ExactRational.of(110n, 1n), amountIncludesTax: true })], { direction: "sale" }) });
    expect(inclusiveOutputResult.disposition).toBe("draft");
    if (inclusiveOutputResult.disposition === "draft" && inclusiveOutputResult.draft.effects[0]?.type === "taxDetermination") expect(inclusiveOutputResult.draft.effects[0].value.lines[0]?.components[0]?.exactTax.equals(ten)).toBeTrue();

    const sharedAccount = account("shared-reverse-charge");
    const cancellingReverse = tax([taxComponent("TAX-REVERSE-CANCEL", { treatment: "reverseCharge", recoverability: "recoverable", recoverableShare: one, recoverableAccountId: sharedAccount, liabilityAccountId: sharedAccount })]);
    const cancellingResult = determineTax([cancellingReverse], IDS.book, IDS.usd, { ...taxRequest("TD-REVERSE-CANCEL", [taxableLine("LINE-REVERSE-CANCEL", { policyId: cancellingReverse.id })], { direction: "purchase" }) });
    expect(cancellingResult.disposition).toBe("draft");
    if (cancellingResult.disposition === "draft") expect(cancellingResult.draft.journals[0]?.postings.find((posting) => posting.accountId === sharedAccount)?.exactBookValue.isZero()).toBeTrue();
  });

  test("rejects zero and repeated tax compounding ordinals independently", () => {
    const zeroOrdinal = tax([taxComponent("TAX-ORDINAL-ZERO", { compoundOrdinal: 0n, recoverableAccountId: account("input-tax") })]);
    expect(determineTax([zeroOrdinal], IDS.book, IDS.usd, taxRequest("TD-ORDINAL-ZERO", [taxableLine("LINE-ORDINAL-ZERO", { policyId: zeroOrdinal.id })])).disposition).toBe("rejected");
    const repeatedOrdinal = tax([taxComponent("TAX-ORDINAL-A", { compoundOrdinal: 1n, recoverableAccountId: account("input-tax") }), taxComponent("TAX-ORDINAL-B", { compoundOrdinal: 1n, recoverableAccountId: account("input-tax") })]);
    expect(determineTax([repeatedOrdinal], IDS.book, IDS.usd, taxRequest("TD-ORDINAL-REPEATED", [taxableLine("LINE-ORDINAL-REPEATED", { policyId: repeatedOrdinal.id })])).disposition).toBe("rejected");
  });

  test("admits quarterly and annual schedules and detects duplicate canonical effects", () => {
    for (const frequency of ["quarterly", "annual"] as const) {
      const policy = Object.freeze({ ...allocation("straightLine"), id: policyId(`allocation-${frequency}`), frequency });
      const scheduled = createAllocationSchedule([policy], IDS.book, { id: allocationScheduleId(`SCHEDULE-${frequency}`), policyId: policy.id, policyVersion: policy.version, governedAt: instant("2026-01-01T00:00:00Z"), sourcePostingId: postingId(`SOURCE-${frequency}`), sourceBasis: ExactRational.of(120n, 1n), residualValue: ExactRational.zero(), startsOn: localDate("2026-01-01"), endsOn: localDate("2026-12-31"), derivation: accountingDerivation });
      expect(scheduled.disposition).toBe("draft");
      if (scheduled.disposition === "draft") expect((scheduled.draft.effects[0]?.type === "allocationSchedule" ? scheduled.draft.effects[0].value.installments.length : 0)).toBe(frequency === "quarterly" ? 4 : 1);
    }
    const effect = createProvisionalInventoryLayerEffect({ id: provisionalInventoryLayerId("DUPLICATE"), bookId: IDS.book, policyId: inventory().id, issuePostingId: postingId("DUPLICATE-SOURCE"), openedAt: instant("2026-01-01T00:00:00Z"), quantity: one, provisionalBasis: ten, derivation: accountingDerivation });
    const state = applyAccountingEffect(emptyAccountingCanonicalState(), effect);
    expect(validateAccountingEffectAdmission(state, [effect], IDS.book)[0]?.code).toBe("canonical_identity_conflict");
  });

  test("rejects schedule requests that exceed the executable installment bound", () => {
    const policy = allocation("straightLine");
    const result = createAllocationSchedule([policy], IDS.book, { id: allocationScheduleId("SCH-TOO-LONG"), policyId: policy.id, policyVersion: policy.version, governedAt: instant("2026-01-01T00:00:00Z"), sourcePostingId: postingId("long-source"), sourceBasis: ExactRational.of(120n, 1n), residualValue: ExactRational.zero(), startsOn: localDate("2026-01-01"), endsOn: localDate("9999-12-31"), derivation: accountingDerivation });
    expect(result.disposition).toBe("rejected");
    if (result.disposition === "rejected") expect(result.diagnostics[0]?.code).toBe("allocation_schedule_violation");
  });

  test("preserves exact inventory conservation across a bounded rational property domain", () => {
    const policy = inventory("weightedAverage");
    for (let leftQuantity = 1n; leftQuantity <= 8n; leftQuantity += 1n) {
      for (let rightQuantity = 1n; rightQuantity <= 8n; rightQuantity += 1n) {
        const propertyLayers = Object.freeze([
          Object.freeze({ id: "A", accountId: account("inventory"), acquiredAt: instant("2026-01-01T00:00:00Z"), quantity: ExactRational.of(leftQuantity, 1n), totalBasis: ExactRational.of(leftQuantity * 7n, 3n) }),
          Object.freeze({ id: "B", accountId: account("inventory"), acquiredAt: instant("2026-01-02T00:00:00Z"), quantity: ExactRational.of(rightQuantity, 1n), totalBasis: ExactRational.of(rightQuantity * 11n, 5n) }),
        ]);
        const available = ExactRational.of(leftQuantity + rightQuantity, 1n);
        const requested = available.divide(ExactRational.of(2n, 1n));
        const result = calculateInventoryCost([policy], IDS.book, { policyId: policy.id, policyVersion: policy.version, governedAt: instant("2026-01-15T00:00:00Z"), quantity: requested, layers: propertyLayers });
        expect(result.disposition).toBe("costed");
        if (result.disposition !== "costed") continue;
        const allocatedQuantity = result.allocations.reduce((total, item) => total.add(item.quantity), ExactRational.zero());
        const allocatedBasis = result.allocations.reduce((total, item) => total.add(item.basis), ExactRational.zero());
        expect(allocatedQuantity.equals(requested)).toBeTrue();
        expect(allocatedBasis.equals(result.ordinaryBasis)).toBeTrue();
      }
    }
  });

  test("is invariant to permutation of unordered inventory, tax, and consolidation inputs", () => {
    const fifo = inventory("fifo");
    const inventoryRequest = { policyId: fifo.id, policyVersion: fifo.version, governedAt: instant("2026-01-15T00:00:00Z"), quantity: ExactRational.of(3n, 1n), layers };
    const inventoryForward = calculateInventoryCost([fifo], IDS.book, inventoryRequest);
    const inventoryReverse = calculateInventoryCost([fifo], IDS.book, { ...inventoryRequest, layers: [...layers].reverse() });
    expect(canonicalAccountingValue(inventoryForward)).toEqual(canonicalAccountingValue(inventoryReverse));

    const components: TaxPolicy["components"] = Object.freeze([
      taxComponent("PERM-TAX-A", { rate: ExactRational.of(1n, 10n), treatment: "inputTax", recoverability: "recoverable", recoverableShare: one, compoundOrdinal: 1n, compoundsOn: Object.freeze([]), liabilityAccountId: account("tax-payable"), recoverableAccountId: account("input-tax") }),
      taxComponent("PERM-TAX-B", { rate: ExactRational.of(1n, 20n), treatment: "inputTax", recoverability: "nonRecoverable", recoverableShare: ExactRational.zero(), compoundOrdinal: 2n, compoundsOn: Object.freeze([policyId("PERM-TAX-A")]), liabilityAccountId: account("tax-payable"), nonRecoverableAccountId: account("expense") }),
    ]);
    const taxForwardPolicy = tax(components);
    const taxReversePolicy = Object.freeze({ ...taxForwardPolicy, components: Object.freeze([...components].reverse()) });
    const taxRequestBase = taxRequest("PERM-TAX", [taxableLine("PERM-LINE", { policyId: taxForwardPolicy.id })]);
    expect(canonicalAccountingValue(determineTax([taxForwardPolicy], IDS.book, IDS.usd, taxRequestBase))).toEqual(canonicalAccountingValue(determineTax([taxReversePolicy], IDS.book, IDS.usd, taxRequestBase)));

    const sourceA = consolidationSource("source-a", [{ sourceAccountId: "source", classification: "asset", amount: ten }, { sourceAccountId: "equity", classification: "equity", amount: ten.negate() }]);
    const sourceB = consolidationSource("source-b", [{ sourceAccountId: "source", classification: "asset", amount: ExactRational.of(20n, 1n) }, { sourceAccountId: "equity", classification: "equity", amount: ExactRational.of(-20n, 1n) }]);
    const consolidationRequest = { id: consolidationCompilationId("PERM-CONSOLIDATION"), policyId: consolidation.id, policyVersion: consolidation.version, governedAt: instant("2026-01-31T00:00:00Z"), throughOn: localDate("2026-01-31"), targetBookId: IDS.book, sources: [sourceA, sourceB], eliminations: [], derivation: accountingDerivation };
    expect(canonicalAccountingValue(compileConsolidation([consolidation], IDS.usd, consolidationRequest))).toEqual(canonicalAccountingValue(compileConsolidation([consolidation], IDS.usd, { ...consolidationRequest, sources: [sourceB, sourceA] })));
  });

  test("structural document tax groups isolate raw policy/component tuples and policy versions", () => {
    const make = (id: string, componentId: string, version = "1.0.0", structural = true): TaxPolicy => {
      const base = tax([taxComponent(componentId, { rate: ExactRational.of(1n, 200n), recoverableAccountId: account("recoverable") })], "documentLevel");
      return { ...base, id: policyId(id), version: semanticVersion(version),
        ...(structural ? { groupingAlgorithm: "structural-tax-groups-v1", algorithmVersion: semanticVersion("1.1.0"),
          capability: { ...base.capability, implementationVersion: semanticVersion("1.1.0") } } : {}) };
    };
    const run = (policies: readonly TaxPolicy[], selected = policies) => determineTax(policies, IDS.book, IDS.usd,
      taxRequest("raw-tax-groups", selected.map((policy, index) => taxableLine(`raw-line-${index}`, {
        policyId: policy.id, policyVersion: policy.version, statedAmount: ExactRational.of(1n, 1n) }))));
    for (const [policies, amounts] of [
      [[make("a:b", "c"), make("a", "b:c")], ["0.00", "0.00"]],
      [[make("a", "c"), make("a", "c", "2.0.0")], ["0.00", "0.00"]],
      [[make("a:b", "c", "1.0.0", false), make("a", "b:c", "1.0.0", false)], ["0.00", "0.01"]],
      [[make("a:b", "c", "1.0.0", false), make("a", "b:c")], ["0.00", "0.00"]],
      [[make('["structural","a', 'b","1.0.0","c"]', "1.0.0", false), make("a:b", "c")], ["0.00", "0.00"]],
    ] as const) {
      const result = run(policies);
      expect(result.disposition).toBe("draft");
      if (result.disposition !== "draft" || result.draft.effects[0]?.type !== "taxDetermination") throw new Error("Expected document tax result");
      expect(result.draft.effects[0].value.lines.map((line) => line.components[0]!.quantization.amount.toString())).toEqual([...amounts]);
      for (const line of result.draft.effects[0].value.lines) {
        const component = line.components[0]!;
        expect(component.quantization.amount.toRational().add(component.quantization.residual).toString()).toBe("1/200");
      }
      expect(result.draft.journals[0]!.postings.reduce((sum, posting) => sum.add(posting.exactBookValue), ExactRational.zero()).toString()).toBe("0/1");
    }
    const policy = make("shared", "component");
    const same = run([policy], [policy, policy]);
    if (same.disposition !== "draft" || same.draft.effects[0]?.type !== "taxDetermination") throw new Error("Expected same-group tax result");
    expect(same.draft.effects[0].value.lines.map((line) => line.components[0]!.quantization.amount.toString())).toEqual(["0.00", "0.01"]);
    const bad = { ...policy, algorithmVersion: semanticVersion("1.0.0"), capability: { ...policy.capability, implementationVersion: semanticVersion("1.0.0") } };
    const rejected = run([bad]);
    expect(rejected.disposition).toBe("rejected");
    if (rejected.disposition !== "rejected") throw new Error("Unreviewed tax implementation admitted");
    expect(rejected.diagnostics[0]!.path).toBe("command.tax.lines[raw-line-0].policy.groupingAlgorithm");
  });

  test("enforces line-level versus document-level rounding policy reconciliation (permanent 5x$10 @ 8.875% regression)", () => {
    // 8.875% = 8875 / 100000 = 71 / 800
    const taxRate = ExactRational.of(71n, 800n);
    const lineComp = (level: TaxRoundingLevel): TaxPolicy => tax([
      taxComponent("TAX-8875", {
        rate: taxRate,
        treatment: "outputTax",
        recoverability: "nonRecoverable",
        recoverableShare: ExactRational.zero(),
        liabilityAccountId: account("tax-liability"),
      }),
    ], level);

    const make5LineRequest = (p: TaxPolicy, id: string) => taxRequest(
      id,
      [1, 2, 3, 4, 5].map((idx) => taxableLine(`L${idx}`, {
        policyId: p.id,
        policyVersion: p.version,
        statedAmount: ExactRational.of(10n, 1n),
        sourceAccountId: account("revenue"),
        payableAccountId: account("ar"),
      })),
      { direction: "sale", sourceTransactionId: `TX-${id}` },
    );

    // --- Line-level Rounding ---
    // 5 lines of $10 at 8.875% = $0.8875 per line.
    // In lineLevel: each line rounds 0.8875 -> 0.89. Total tax = 5 * $0.89 = $4.45.
    const linePolicy = lineComp("lineLevel");
    const lineResult = determineTax([linePolicy], IDS.book, IDS.usd, {
      ...make5LineRequest(linePolicy, "TD-LINE-5X10"),
      governedAt: instant("2026-03-01T00:00:00Z"),
    });
    expect(lineResult.disposition).toBe("draft");
    if (lineResult.disposition !== "draft") throw new Error("Expected draft");

    const lineEffect = lineResult.draft.effects[0]!;
    if (lineEffect.type !== "taxDetermination") throw new Error("Expected tax determination");
    expect(lineEffect.value.lines).toHaveLength(5);
    for (const l of lineEffect.value.lines) {
      const comp = l.components[0]!;
      expect(comp.quantization.amount.toRational().equals(ExactRational.of(89n, 100n))).toBeTrue();
      // exactTax (71/80) - 89/100 = -1/400 (-0.0025)
      expect(comp.quantization.residual.equals(ExactRational.of(-1n, 400n))).toBeTrue();
      expect(comp.quantization.amount.toRational().add(comp.quantization.residual).equals(comp.exactTax)).toBeTrue();
    }
    const linePostings = lineResult.draft.journals[0]?.postings ?? [];
    const linePostingMap = new Map(linePostings.map((p) => [p.accountId, p.exactBookValue]));
    // AR: Dr $54.45, Revenue: Cr $50.00, Tax Liability: Cr $4.45
    expect(linePostingMap.get(account("ar"))?.equals(ExactRational.of(5445n, 100n))).toBeTrue();
    expect(linePostingMap.get(account("revenue"))?.equals(ExactRational.of(-50n, 1n))).toBeTrue();
    expect(linePostingMap.get(account("tax-liability"))?.equals(ExactRational.of(-445n, 100n))).toBeTrue();
    // Reconciles exactly with zero rounding posting
    expect(linePostings.reduce((sum, p) => sum.add(p.exactBookValue), ExactRational.zero()).isZero()).toBeTrue();
    expect(validateAccountingEffectHash(lineEffect)).toBeTrue();

    // --- Document-level Rounding ---
    // Cumulative exact taxes:
    // L1: 0.8875 -> round(0.8875) = 0.89. Delta = 0.89.
    // L2: 1.7750 -> round(1.7750) = 1.78. Delta = 1.78 - 0.89 = 0.89.
    // L3: 2.6625 -> round(2.6625) = 2.66. Delta = 2.66 - 1.78 = 0.88.
    // L4: 3.5500 -> round(3.5500) = 3.55. Delta = 3.55 - 2.66 = 0.89.
    // L5: 4.4375 -> round(4.4375) = 4.44. Delta = 4.44 - 3.55 = 0.89.
    // Document total tax = $4.44! Allocated sequence = [0.89, 0.89, 0.88, 0.89, 0.89].
    const docPolicy = lineComp("documentLevel");
    const docResult = determineTax([docPolicy], IDS.book, IDS.usd, {
      ...make5LineRequest(docPolicy, "TD-DOC-5X10"),
      governedAt: instant("2026-03-01T00:00:00Z"),
    });
    expect(docResult.disposition).toBe("draft");
    if (docResult.disposition !== "draft") throw new Error("Expected draft");

    const docEffect = docResult.draft.effects[0]!;
    if (docEffect.type !== "taxDetermination") throw new Error("Expected tax determination");
    expect(docEffect.value.lines).toHaveLength(5);

    const expectedDocAmounts = [89n, 89n, 88n, 89n, 89n];
    for (let i = 0; i < 5; i++) {
      const comp = docEffect.value.lines[i]!.components[0]!;
      expect(comp.quantization.amount.toRational().equals(ExactRational.of(expectedDocAmounts[i]!, 100n))).toBeTrue();
      // exactTax conservation: amount + residual === exactTax
      expect(comp.quantization.amount.toRational().add(comp.quantization.residual).equals(comp.exactTax)).toBeTrue();
    }
    // Check line 3 specific residual: 0.8875 - 0.88 = +0.0075 = 3/400
    expect(docEffect.value.lines[2]!.components[0]!.quantization.residual.equals(ExactRational.of(3n, 400n))).toBeTrue();

    const docPostings = docResult.draft.journals[0]?.postings ?? [];
    const docPostingMap = new Map(docPostings.map((p) => [p.accountId, p.exactBookValue]));
    // AR: Dr $54.44, Revenue: Cr $50.00, Tax Liability: Cr $4.44
    expect(docPostingMap.get(account("ar"))?.equals(ExactRational.of(5444n, 100n))).toBeTrue();
    expect(docPostingMap.get(account("revenue"))?.equals(ExactRational.of(-50n, 1n))).toBeTrue();
    expect(docPostingMap.get(account("tax-liability"))?.equals(ExactRational.of(-444n, 100n))).toBeTrue();
    // Reconciles exactly with zero rounding posting
    expect(docPostings.reduce((sum, p) => sum.add(p.exactBookValue), ExactRational.zero()).isZero()).toBeTrue();
    expect(validateAccountingEffectHash(docEffect)).toBeTrue();
  });

  test("determines inclusive and compound taxes under both rounding levels with exact conservation", () => {
    // Inclusive tax: 3 lines of $100 inclusive of 10% tax.
    // Stated amount: 100. Exclusive basis: 100 / 1.1 = 1000/11 = 90.9090...
    // Exact tax per line = 100/11 = 9.09090...
    for (const roundingLevel of ["lineLevel", "documentLevel"] as const) {
      const incPolicy = tax([
        taxComponent("TAX-INC", {
          inclusion: "inclusive",
          rate: ExactRational.of(1n, 10n),
          treatment: "outputTax",
          recoverability: "nonRecoverable",
          recoverableShare: ExactRational.zero(),
          liabilityAccountId: account("tax-liability"),
        }),
      ], roundingLevel);

      const result = determineTax([incPolicy], IDS.book, IDS.usd, {
        ...taxRequest(
          `TD-INC-${roundingLevel}`,
          [1, 2, 3].map((idx) => taxableLine(`IL${idx}`, {
            policyId: incPolicy.id,
            policyVersion: incPolicy.version,
            statedAmount: ExactRational.of(100n, 1n),
            amountIncludesTax: true,
            sourceAccountId: account("revenue"),
            payableAccountId: account("ar"),
          })),
          { direction: "sale", sourceTransactionId: `TX-INC-${roundingLevel}` },
        ),
        governedAt: instant("2026-03-01T00:00:00Z"),
      });

      expect(result.disposition).toBe("draft");
      if (result.disposition !== "draft") continue;
      const effect = result.draft.effects[0]!;
      if (effect.type !== "taxDetermination") throw new Error("Expected tax determination");

      for (const line of effect.value.lines) {
        const comp = line.components[0]!;
        expect(comp.quantization.amount.toRational().add(comp.quantization.residual).equals(comp.exactTax)).toBeTrue();
        // Stated amount = exclusiveBasis + quantized tax amount
        expect(line.exclusiveBasis.add(comp.quantization.amount.toRational()).equals(ExactRational.of(100n, 1n))).toBeTrue();
      }

      const postings = result.draft.journals[0]?.postings ?? [];
      const postingMap = new Map(postings.map((p) => [p.accountId, p.exactBookValue]));
      expect(postingMap.get(account("ar"))?.equals(ExactRational.of(300n, 1n))).toBeTrue();
      expect(postings.reduce((sum, p) => sum.add(p.exactBookValue), ExactRational.zero()).isZero()).toBeTrue();
      expect(validateAccountingEffectHash(effect)).toBeTrue();
    }

    // Compound tax under documentLevel:
    // Comp A: 5% exclusive, Comp B: 3% compounding on Comp A.
    for (const roundingLevel of ["lineLevel", "documentLevel"] as const) {
      const compA = taxComponent("CMP-A", { rate: ExactRational.of(1n, 20n), compoundOrdinal: 1n, treatment: "outputTax", recoverability: "nonRecoverable", recoverableShare: ExactRational.zero(), liabilityAccountId: account("tax-a") });
      const compB = taxComponent("CMP-B", { rate: ExactRational.of(3n, 100n), compoundOrdinal: 2n, compoundsOn: Object.freeze([policyId("CMP-A")]), treatment: "outputTax", recoverability: "nonRecoverable", recoverableShare: ExactRational.zero(), liabilityAccountId: account("tax-b") });
      const compPolicy = tax([compA, compB], roundingLevel);

      const result = determineTax([compPolicy], IDS.book, IDS.usd, {
        ...taxRequest(
          `TD-CMP-${roundingLevel}`,
          [1, 2, 3].map((idx) => taxableLine(`CL${idx}`, {
            policyId: compPolicy.id,
            policyVersion: compPolicy.version,
            statedAmount: ExactRational.of(100n, 1n),
            sourceAccountId: account("revenue"),
            payableAccountId: account("ar"),
          })),
          { direction: "sale", sourceTransactionId: `TX-CMP-${roundingLevel}` },
        ),
        governedAt: instant("2026-03-01T00:00:00Z"),
      });

      expect(result.disposition).toBe("draft");
      if (result.disposition !== "draft") continue;
      const effect = result.draft.effects[0]!;
      if (effect.type !== "taxDetermination") throw new Error("Expected tax determination");

      for (const line of effect.value.lines) {
        expect(line.components).toHaveLength(2);
        for (const comp of line.components) {
          expect(comp.quantization.amount.toRational().add(comp.quantization.residual).equals(comp.exactTax)).toBeTrue();
        }
      }
      const postings = result.draft.journals[0]?.postings ?? [];
      expect(postings.reduce((sum, p) => sum.add(p.exactBookValue), ExactRational.zero()).isZero()).toBeTrue();
      expect(validateAccountingEffectHash(effect)).toBeTrue();
    }
  });

  test("determines multi-rate and credit transactions with recoverable and non-recoverable allocations", () => {
    // Multi-rate under documentLevel: 2 lines @ 5% and 2 lines @ 10%
    const rate5 = Object.freeze({ ...tax([taxComponent("R5", { rate: ExactRational.of(1n, 20n), liabilityAccountId: account("tax-5"), treatment: "outputTax", recoverability: "nonRecoverable", recoverableShare: ExactRational.zero() })], "documentLevel"), id: policyId("pol-r5") });
    const rate10 = Object.freeze({ ...tax([taxComponent("R10", { rate: ExactRational.of(1n, 10n), liabilityAccountId: account("tax-10"), treatment: "outputTax", recoverability: "nonRecoverable", recoverableShare: ExactRational.zero() })], "documentLevel"), id: policyId("pol-r10") });

    const multiRateResult = determineTax([rate5, rate10], IDS.book, IDS.usd, {
      ...taxRequest(
        "TD-MULTI-RATE",
        [
          taxableLine("MR-1", { policyId: rate5.id, policyVersion: rate5.version, statedAmount: ExactRational.of(33n, 1n), sourceAccountId: account("revenue"), payableAccountId: account("ar") }),
          taxableLine("MR-2", { policyId: rate5.id, policyVersion: rate5.version, statedAmount: ExactRational.of(33n, 1n), sourceAccountId: account("revenue"), payableAccountId: account("ar") }),
          taxableLine("MR-3", { policyId: rate10.id, policyVersion: rate10.version, statedAmount: ExactRational.of(47n, 1n), sourceAccountId: account("revenue"), payableAccountId: account("ar") }),
          taxableLine("MR-4", { policyId: rate10.id, policyVersion: rate10.version, statedAmount: ExactRational.of(47n, 1n), sourceAccountId: account("revenue"), payableAccountId: account("ar") }),
        ],
        { direction: "sale", sourceTransactionId: "TX-MULTI-RATE" },
      ),
      governedAt: instant("2026-03-01T00:00:00Z"),
    });
    expect(multiRateResult.disposition).toBe("draft");
    if (multiRateResult.disposition === "draft") {
      const effect = multiRateResult.draft.effects[0]!;
      expect(validateAccountingEffectHash(effect)).toBeTrue();
      const postings = multiRateResult.draft.journals[0]?.postings ?? [];
      expect(postings.reduce((sum, p) => sum.add(p.exactBookValue), ExactRational.zero()).isZero()).toBeTrue();
    }

    // Partially recoverable tax (inputTax 50% recoverable, 50% non-recoverable)
    const partialPolicy = tax([
      taxComponent("TAX-PARTIAL", {
        rate: ExactRational.of(1n, 10n),
        treatment: "inputTax",
        recoverability: "partiallyRecoverable",
        recoverableShare: ExactRational.of(1n, 2n),
        liabilityAccountId: account("tax-payable"),
        recoverableAccountId: account("input-tax-rec"),
        nonRecoverableAccountId: account("input-tax-nonrec"),
      }),
    ], "documentLevel");

    const partialResult = determineTax([partialPolicy], IDS.book, IDS.usd, {
      ...taxRequest(
        "TD-PARTIAL",
        [taxableLine("PR-1", { policyId: partialPolicy.id, policyVersion: partialPolicy.version, statedAmount: ExactRational.of(100n, 1n), sourceAccountId: account("expense"), payableAccountId: account("ap") })],
        { direction: "purchase", sourceTransactionId: "TX-PARTIAL" },
      ),
      governedAt: instant("2026-03-01T00:00:00Z"),
    });
    expect(partialResult.disposition).toBe("draft");
    if (partialResult.disposition === "draft") {
      const postings = partialResult.draft.journals[0]?.postings ?? [];
      const postingMap = new Map(postings.map((p) => [p.accountId, p.exactBookValue]));
      expect(postingMap.get(account("expense"))?.equals(ExactRational.of(100n, 1n))).toBeTrue();
      expect(postingMap.get(account("input-tax-rec"))?.equals(ExactRational.of(5n, 1n))).toBeTrue();
      expect(postingMap.get(account("input-tax-nonrec"))?.equals(ExactRational.of(5n, 1n))).toBeTrue();
      expect(postingMap.get(account("ap"))?.equals(ExactRational.of(-110n, 1n))).toBeTrue();
      expect(postings.reduce((sum, p) => sum.add(p.exactBookValue), ExactRational.zero()).isZero()).toBeTrue();
    }
    // 100% recoverable tax under documentLevel
    const fullRecPolicy = tax([
      taxComponent("TAX-FULL-REC", {
        rate: ExactRational.of(1n, 10n),
        treatment: "inputTax",
        recoverability: "recoverable",
        recoverableShare: ExactRational.of(1n, 1n),
        liabilityAccountId: account("tax-payable"),
        recoverableAccountId: account("input-tax-rec"),
      }),
    ], "documentLevel");

    const fullRecResult = determineTax([fullRecPolicy], IDS.book, IDS.usd, {
      ...taxRequest(
        "TD-FULL-REC",
        [taxableLine("FR-1", { policyId: fullRecPolicy.id, policyVersion: fullRecPolicy.version, statedAmount: ExactRational.of(100n, 1n), sourceAccountId: account("expense"), payableAccountId: account("ap") })],
        { direction: "purchase", sourceTransactionId: "TX-FULL-REC" },
      ),
      governedAt: instant("2026-03-01T00:00:00Z"),
    });
    expect(fullRecResult.disposition).toBe("draft");
    if (fullRecResult.disposition === "draft") {
      const postings = fullRecResult.draft.journals[0]?.postings ?? [];
      const postingMap = new Map(postings.map((p) => [p.accountId, p.exactBookValue]));
      expect(postingMap.get(account("expense"))?.equals(ExactRational.of(100n, 1n))).toBeTrue();
      expect(postingMap.get(account("input-tax-rec"))?.equals(ExactRational.of(10n, 1n))).toBeTrue();
      expect(postingMap.get(account("ap"))?.equals(ExactRational.of(-110n, 1n))).toBeTrue();
      expect(postings.reduce((sum, p) => sum.add(p.exactBookValue), ExactRational.zero()).isZero()).toBeTrue();
    }

    // Credit transactions:
    // 1. saleCredit (Credit Memo / Refund): Dr Revenue $100, Dr Tax Liability $10, Cr AR $110
    const saleCreditPolicy = tax([
      taxComponent("TAX-CREDIT", {
        rate: ExactRational.of(1n, 10n),
        treatment: "outputTax",
        recoverability: "nonRecoverable",
        recoverableShare: ExactRational.zero(),
        liabilityAccountId: account("tax-liability"),
      }),
    ], "documentLevel");

    const creditResult = determineTax([saleCreditPolicy], IDS.book, IDS.usd, {
      ...taxRequest(
        "TD-CREDIT-MEMO",
        [taxableLine("CM-1", { policyId: saleCreditPolicy.id, policyVersion: saleCreditPolicy.version, statedAmount: ExactRational.of(100n, 1n), sourceAccountId: account("revenue"), payableAccountId: account("ar") })],
        { direction: "saleCredit", sourceTransactionId: "TX-CREDIT-MEMO" },
      ),
      governedAt: instant("2026-03-01T00:00:00Z"),
    });
    expect(creditResult.disposition).toBe("draft");
    if (creditResult.disposition === "draft") {
      const postings = creditResult.draft.journals[0]?.postings ?? [];
      const postingMap = new Map(postings.map((p) => [p.accountId, p.exactBookValue]));
      expect(postingMap.get(account("revenue"))?.equals(ExactRational.of(100n, 1n))).toBeTrue();
      expect(postingMap.get(account("tax-liability"))?.equals(ExactRational.of(10n, 1n))).toBeTrue();
      expect(postingMap.get(account("ar"))?.equals(ExactRational.of(-110n, 1n))).toBeTrue();
      expect(postings.reduce((sum, p) => sum.add(p.exactBookValue), ExactRational.zero()).isZero()).toBeTrue();
    }

    // 2. Negative stated amount (Trade discount line on sale invoice)
    const discountResult = determineTax([saleCreditPolicy], IDS.book, IDS.usd, {
      ...taxRequest(
        "TD-INVOICE-DISCOUNT",
        [
          taxableLine("ITEM-1", { policyId: saleCreditPolicy.id, policyVersion: saleCreditPolicy.version, statedAmount: ExactRational.of(100n, 1n), sourceAccountId: account("revenue"), payableAccountId: account("ar") }),
          taxableLine("DISC-1", { policyId: saleCreditPolicy.id, policyVersion: saleCreditPolicy.version, statedAmount: ExactRational.of(-10n, 1n), sourceAccountId: account("revenue"), payableAccountId: account("ar") }),
        ],
        { direction: "sale", sourceTransactionId: "TX-INVOICE-DISCOUNT" },
      ),
      governedAt: instant("2026-03-01T00:00:00Z"),
    });
    expect(discountResult.disposition).toBe("draft");
    if (discountResult.disposition === "draft") {
      const postings = discountResult.draft.journals[0]?.postings ?? [];
      const postingMap = new Map(postings.map((p) => [p.accountId, p.exactBookValue]));
      // Net Revenue: -100 + 10 = -90 (Cr 90)
      expect(postingMap.get(account("revenue"))?.equals(ExactRational.of(-90n, 1n))).toBeTrue();
      // Net Tax: -10 + 1 = -9 (Cr 9)
      expect(postingMap.get(account("tax-liability"))?.equals(ExactRational.of(-9n, 1n))).toBeTrue();
      // Net AR: 110 - 11 = 99 (Dr 99)
      expect(postingMap.get(account("ar"))?.equals(ExactRational.of(99n, 1n))).toBeTrue();
      expect(postings.reduce((sum, p) => sum.add(p.exactBookValue), ExactRational.zero()).isZero()).toBeTrue();
    }
  });

  test("rejects invalid rounding level and quantization configurations", () => {
    const linePolicy = tax([taxComponent("TAX-L", { rate: ExactRational.of(1n, 10n), liabilityAccountId: account("tax-liability") })], "lineLevel");
    const docPolicy = Object.freeze({ ...tax([taxComponent("TAX-D", { rate: ExactRational.of(1n, 10n), liabilityAccountId: account("tax-liability") })], "documentLevel"), id: policyId("tax-doc-pol") });

    // Mixed rounding levels between lines
    const mixedRounding = determineTax([linePolicy, docPolicy], IDS.book, IDS.usd, {
      ...taxRequest("TD-MIXED-ROUNDING", [
        taxableLine("L1", { policyId: linePolicy.id, policyVersion: linePolicy.version }),
        taxableLine("L2", { policyId: docPolicy.id, policyVersion: docPolicy.version }),
      ]),
      governedAt: instant("2026-03-01T00:00:00Z"),
    });
    expect(mixedRounding.disposition).toBe("rejected");
    if (mixedRounding.disposition === "rejected") {
      expect(mixedRounding.diagnostics[0]?.code).toBe("tax_policy_ambiguity");
    }

    // Incompatible quantization policies (different scale)
    const scale3Policy = Object.freeze({
      ...tax([taxComponent("TAX-S3", { rate: ExactRational.of(1n, 10n), liabilityAccountId: account("tax-liability") })], "documentLevel"),
      id: policyId("tax-scale3"),
      quantizationPolicy: Object.freeze({ ...quantizationPolicy, targetScale: 3n }),
    });
    const docPolicy2 = Object.freeze({
      ...tax([taxComponent("TAX-D2", { rate: ExactRational.of(1n, 10n), liabilityAccountId: account("tax-liability") })], "documentLevel"),
      id: policyId("tax-doc2"),
    });
    const mismatchedQuant = determineTax([scale3Policy, docPolicy2], IDS.book, IDS.usd, {
      ...taxRequest("TD-MISMATCHED-QUANT", [
        taxableLine("Q1", { policyId: scale3Policy.id, policyVersion: scale3Policy.version }),
        taxableLine("Q2", { policyId: docPolicy2.id, policyVersion: docPolicy2.version }),
      ]),
      governedAt: instant("2026-03-01T00:00:00Z"),
    });
    expect(mismatchedQuant.disposition).toBe("rejected");
    if (mismatchedQuant.disposition === "rejected") {
      expect(mismatchedQuant.diagnostics[0]?.code).toBe("tax_policy_ambiguity");
    }

    // Invalid roundingLevel value fails closed
    const invalidRoundingPolicy = Object.freeze({
      ...tax([taxComponent("TAX-INV", { rate: ExactRational.of(1n, 10n), liabilityAccountId: account("tax-liability") })], "garbage" as unknown as TaxRoundingLevel),
      id: policyId("tax-invalid-rounding"),
    });
    const invalidRoundingResult = determineTax([invalidRoundingPolicy], IDS.book, IDS.usd, {
      ...taxRequest("TD-INVALID-ROUNDING", [
        taxableLine("INV-1", { policyId: invalidRoundingPolicy.id, policyVersion: invalidRoundingPolicy.version }),
      ]),
      governedAt: instant("2026-03-01T00:00:00Z"),
    });
    expect(invalidRoundingResult.disposition).toBe("rejected");
    if (invalidRoundingResult.disposition === "rejected") {
      expect(invalidRoundingResult.diagnostics[0]?.code).toBe("tax_policy_ambiguity");
      expect(invalidRoundingResult.diagnostics[0]?.path).toContain("roundingLevel");
    }
  });

  test("ACC-045.4: rejects different rounding modes at the same scale without another invalid policy masking the guard", () => {
    const first = tax([taxComponent("MODE-A", { treatment: "outputTax", recoverability: "nonRecoverable", recoverableShare: ExactRational.zero() })], "documentLevel");
    const second = { ...first, id: policyId("mode-second") };
    const request = taxRequest("MODE-COMPATIBILITY", [
      taxableLine("MODE-L1", { policyId: first.id }),
      taxableLine("MODE-L2", { policyId: second.id }),
    ], { direction: "sale" });
    expect(determineTax([first, second], IDS.book, IDS.usd, request).disposition).toBe("draft");
    const mismatched = { ...second, quantizationPolicy: { ...second.quantizationPolicy, roundingMode: "floor" as const } };
    const result = determineTax([first, mismatched], IDS.book, IDS.usd, request);
    expect(result.disposition).toBe("rejected");
    if (result.disposition !== "rejected") throw new Error("Incompatible tax rounding modes were admitted");
    expect(result.diagnostics[0]?.code).toBe("tax_policy_ambiguity");
    expect(result.diagnostics[0]?.path).toBe("command.tax.lines[MODE-L2].policy.quantizationPolicy");
  });

  test("enforces inclusive basis preservation for reverse-charge and withholding taxes", () => {
    // 1. $100 purchase with 10% reverse charge preserves $100 expense basis and $100 AP
    const revChargePolicy = tax([
      taxComponent("RC-COMP", {
        rate: ExactRational.of(1n, 10n),
        inclusion: "inclusive",
        treatment: "reverseCharge",
        recoverability: "recoverable",
        recoverableShare: ExactRational.of(1n, 1n),
        liabilityAccountId: account("tax-liability"),
        recoverableAccountId: account("input-tax-rec"),
      }),
    ], "documentLevel");

    const revChargeResult = determineTax([revChargePolicy], IDS.book, IDS.usd, {
      ...taxRequest(
        "TD-RC-INCLUSIVE",
        [
          taxableLine("RC-LINE-1", {
            policyId: revChargePolicy.id,
            policyVersion: revChargePolicy.version,
            statedAmount: ExactRational.of(100n, 1n),
            amountIncludesTax: true,
            sourceAccountId: account("expense"),
            payableAccountId: account("ap"),
          }),
        ],
        { direction: "purchase", sourceTransactionId: "TX-RC-INCLUSIVE" },
      ),
      governedAt: instant("2026-03-01T00:00:00Z"),
    });

    expect(revChargeResult.disposition).toBe("draft");
    if (revChargeResult.disposition === "draft") {
      const postings = revChargeResult.draft.journals[0]?.postings ?? [];
      const postingMap = new Map(postings.map((p) => [p.accountId, p.exactBookValue]));
      // Expense basis preserved at $100 (not reduced to $90!)
      expect(postingMap.get(account("expense"))?.equals(ExactRational.of(100n, 1n))).toBeTrue();
      // Counterparty AP is $100 (supplier is owed full $100 stated purchase amount)
      expect(postingMap.get(account("ap"))?.equals(ExactRational.of(-100n, 1n))).toBeTrue();
      // Recoverable tax is $10 (debited to input-tax-rec)
      expect(postingMap.get(account("input-tax-rec"))?.equals(ExactRational.of(10n, 1n))).toBeTrue();
      // Reverse charge tax liability is $10 (credited to tax-liability)
      expect(postingMap.get(account("tax-liability"))?.equals(ExactRational.of(-10n, 1n))).toBeTrue();
      // Journal balances: Dr 100 + 10 = Cr 100 + 10 = 110
      expect(postings.reduce((sum, p) => sum.add(p.exactBookValue), ExactRational.zero()).isZero()).toBeTrue();

      // Line results check
      const lineRes = (revChargeResult.draft.effects[0]!.value as { lines: readonly { exclusiveBasis: ExactRational }[] }).lines[0]!;
      expect(lineRes.exclusiveBasis.equals(ExactRational.of(100n, 1n))).toBeTrue();
    }

    // 2. $100 purchase with 10% withholding preserves $100 expense basis and withholds $10 from AP ($90 paid to vendor)
    const withholdingPolicy = tax([
      taxComponent("WH-COMP", {
        rate: ExactRational.of(1n, 10n),
        inclusion: "inclusive",
        treatment: "withholding",
        recoverability: "nonRecoverable",
        recoverableShare: ExactRational.zero(),
        liabilityAccountId: account("tax-liability"),
      }),
    ], "documentLevel");

    const whResult = determineTax([withholdingPolicy], IDS.book, IDS.usd, {
      ...taxRequest(
        "TD-WH-INCLUSIVE",
        [
          taxableLine("WH-LINE-1", {
            policyId: withholdingPolicy.id,
            policyVersion: withholdingPolicy.version,
            statedAmount: ExactRational.of(100n, 1n),
            amountIncludesTax: true,
            sourceAccountId: account("expense"),
            payableAccountId: account("ap"),
          }),
        ],
        { direction: "purchase", sourceTransactionId: "TX-WH-INCLUSIVE" },
      ),
      governedAt: instant("2026-03-01T00:00:00Z"),
    });

    expect(whResult.disposition).toBe("draft");
    if (whResult.disposition === "draft") {
      const postings = whResult.draft.journals[0]?.postings ?? [];
      const postingMap = new Map(postings.map((p) => [p.accountId, p.exactBookValue]));
      // Expense basis preserved at $100 (not reduced to $90!)
      expect(postingMap.get(account("expense"))?.equals(ExactRational.of(100n, 1n))).toBeTrue();
      // Counterparty AP is $90 ($10 withheld for tax authority)
      expect(postingMap.get(account("ap"))?.equals(ExactRational.of(-90n, 1n))).toBeTrue();
      // Withholding tax liability is $10 (credited to tax-liability)
      expect(postingMap.get(account("tax-liability"))?.equals(ExactRational.of(-10n, 1n))).toBeTrue();
      // Journal balances: Dr 100 = Cr 90 + 10 = 100
      expect(postings.reduce((sum, p) => sum.add(p.exactBookValue), ExactRational.zero()).isZero()).toBeTrue();
    }
  });

  test("document-level recoverability allocation guarantees non-negative components for non-zero lines", () => {
    // Reproduction test case: Three positive $0.06 lines, taxed at 10% with 50% recoverability
    // Under previous independent rounding, line 2 produced $0.00 tax, $0.01 rec, -$0.01 non-rec.
    // Under cumulative allocated contract, line 2 produces $0.00 tax, $0.00 rec, $0.00 non-rec.
    const partialPolicy = tax([
      taxComponent("TAX-P50", {
        rate: ExactRational.of(1n, 10n),
        treatment: "inputTax",
        recoverability: "partiallyRecoverable",
        recoverableShare: ExactRational.of(1n, 2n),
        liabilityAccountId: account("tax-liability"),
        recoverableAccountId: account("input-tax-rec"),
        nonRecoverableAccountId: account("input-tax-nonrec"),
      }),
    ], "documentLevel");

    const threeLines = determineTax([partialPolicy], IDS.book, IDS.usd, {
      ...taxRequest(
        "TD-3-LINES",
        [
          taxableLine("L1", { policyId: partialPolicy.id, policyVersion: partialPolicy.version, statedAmount: ExactRational.of(6n, 100n), sourceAccountId: account("expense"), payableAccountId: account("ap") }),
          taxableLine("L2", { policyId: partialPolicy.id, policyVersion: partialPolicy.version, statedAmount: ExactRational.of(6n, 100n), sourceAccountId: account("expense"), payableAccountId: account("ap") }),
          taxableLine("L3", { policyId: partialPolicy.id, policyVersion: partialPolicy.version, statedAmount: ExactRational.of(6n, 100n), sourceAccountId: account("expense"), payableAccountId: account("ap") }),
        ],
        { direction: "purchase", sourceTransactionId: "TX-3-LINES" },
      ),
      governedAt: instant("2026-03-01T00:00:00Z"),
    });

    expect(threeLines.disposition).toBe("draft");
    if (threeLines.disposition === "draft") {
      const effect = threeLines.draft.effects[0]!.value as {
        lines: readonly {
          components: readonly {
            quantization: { amount: { toRational(): ExactRational } };
            recoverable: ExactRational;
            nonRecoverable: ExactRational;
          }[];
        }[];
      };

      // Check all 3 lines: NO line has negative components
      for (const [idx, l] of effect.lines.entries()) {
        const c = l.components[0]!;
        const qAmt = c.quantization.amount.toRational();
        expect(c.recoverable.compare(ExactRational.zero()) >= 0, `Line ${idx + 1} recoverable is negative: ${c.recoverable}`).toBeTrue();
        expect(c.nonRecoverable.compare(ExactRational.zero()) >= 0, `Line ${idx + 1} nonRecoverable is negative: ${c.nonRecoverable}`).toBeTrue();
        expect(c.recoverable.add(c.nonRecoverable).equals(qAmt), `Line ${idx + 1} rec + nonRec does not equal quantized amount`).toBeTrue();
      }

      // Specific line checks:
      // Line 1: tax $0.01 (rec $0.00, nonRec $0.01 under halfEven where 0.005 rounds to even 0.00)
      const c1 = effect.lines[0]!.components[0]!;
      expect(c1.quantization.amount.toRational().equals(ExactRational.of(1n, 100n))).toBeTrue();
      expect(c1.recoverable.isZero()).toBeTrue();
      expect(c1.nonRecoverable.equals(ExactRational.of(1n, 100n))).toBeTrue();

      // Line 2: tax $0.00 (rec $0.00, nonRec $0.00) — NOT $0.01 rec and -$0.01 nonRec!
      const c2 = effect.lines[1]!.components[0]!;
      expect(c2.quantization.amount.toRational().isZero()).toBeTrue();
      expect(c2.recoverable.isZero()).toBeTrue();
      expect(c2.nonRecoverable.isZero()).toBeTrue();

      // Line 3: tax $0.01 (rec $0.01, nonRec $0.00)
      const c3 = effect.lines[2]!.components[0]!;
      expect(c3.quantization.amount.toRational().equals(ExactRational.of(1n, 100n))).toBeTrue();
      expect(c3.recoverable.equals(ExactRational.of(1n, 100n))).toBeTrue();
      expect(c3.nonRecoverable.isZero()).toBeTrue();

      // Document totals: total tax $0.02, rec $0.01, nonRec $0.01
      const totalRec = c1.recoverable.add(c2.recoverable).add(c3.recoverable);
      const totalNonRec = c1.nonRecoverable.add(c2.nonRecoverable).add(c3.nonRecoverable);
      expect(totalRec.equals(ExactRational.of(1n, 100n))).toBeTrue();
      expect(totalNonRec.equals(ExactRational.of(1n, 100n))).toBeTrue();
    }
  });
});

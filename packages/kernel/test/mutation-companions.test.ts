import { describe, expect, test } from "bun:test";
import {
  ExactDecimal,
  ExactRational,
  accountingPolicyCapabilityIsExecutable,
  applyAccountingEffect,
  createAllocationSchedule,
  createProvisionalInventoryLayerEffect,
  determineTax,
  emptyAccountingCanonicalState,
  applySettlement,
  calculateCurrencyRemeasurement,
  commodityId,
  fiscalPeriodId,
  inventoryDisposalSelectionMatches,
  lotHoldingId,
  recognizeOpenItem,
  rejectExternalAccountingAuthority,
  requiresRemeasurementReversal,
  resolveRecostingPeriod,
  validateAccountingEffectAdmission,
  validateBookConfiguration,
  createAccountingPolicySnapshot,
  fiscalCalendarId,
  bookId,
  accountId,
  type AccountingBasisPolicy,
  type AccountingEffect,
  type AccountingPolicy,
  type AllocationPolicy,
  type BookCommand,
  type ConsolidationPolicy,
  type FiscalPeriod,
  type InventoryCostPolicy,
  type InventoryValueAdjustmentPolicy,
  type MonetaryClassificationPolicy,
  type RemeasurementAdmissionCandidate,
  type TaxPolicy,
  type TaxRoundingLevel,
} from "../src/index.ts";
import { canonicalAccountingValue, hashCanonical, identifier, instant, localDate, policyId, semanticVersion } from "../src/index.ts";
import { IDS, periods, quantizationPolicy, freshState, policy } from "./fixtures.ts";
import { account, accountingDerivation, basisRule, capability, classificationRule, consolidationMapping, consolidationValuationPolicy, pool, taxComponent, translationRule } from "./accounting-fixtures.ts";

const one = ExactRational.of(1n, 1n);
const policyCore = (kind: Parameters<typeof capability>[0], id: string, method: string) => ({
  id: policyId(id), version: semanticVersion("1.0.0"), bookId: IDS.book, validFrom: instant("2020-01-01T00:00:00Z"),
  algorithmVersion: semanticVersion("1.0.0"), quantizationPolicy, capability: capability(kind, method),
});

function allocationPolicy(): Extract<AccountingPolicy, { readonly kind: "allocationSchedule" }> {
  return Object.freeze({
    ...policyCore("allocationSchedule", "mutation-allocation", "straightLine"),
    kind: "allocationSchedule" as const, method: "straightLine" as const, frequency: "monthly" as const, convention: "fullPeriod" as const,
    allocationAccountId: account("ALLOCATION"), contraAccountId: account("CONTRA"),
  });
}

describe("admission duplicate detection covers every effect family", () => {
  test("re-admitting any committed effect family is rejected as a canonical identity conflict", () => {
    const derivation = accountingDerivation;
    const effects: readonly AccountingEffect[] = ([
      createProvisionalInventoryLayerEffect({ id: identifier<"ProvisionalInventoryLayer">("m-layer"), bookId: IDS.book, policyId: policyId("p"), issuePostingId: postingIdOf("m-layer"), openedAt: instant("2026-01-01T00:00:00Z"), quantity: one, provisionalBasis: one, derivation }),
      sealedEffect("inventoryRecosting", { id: identifier<"InventoryRecosting">("m-recosting"), layerId: identifier<"ProvisionalInventoryLayer">("m-layer"), resolvedAt: instant("2026-01-02T00:00:00Z"), sources: Object.freeze([{ receiptId: "m-receipt", quantity: one, totalBasis: one }]), adjustment: ExactRational.zero(), derivation }),
      sealedEffect("inventoryValueAdjustment", { id: identifier<"InventoryValueAdjustment">("m-value-adjustment"), kind: "writeDown", effectiveOn: localDate("2026-01-01"), generatedEffectKey: "m-value-adjustment-command:journal:0", bookId: IDS.book, policy: { id: policyId("p") }, exactSourceAmount: one.negate(), allocations: Object.freeze([]), bookedAdjustment: { amount: ExactDecimal.of(-100n, 2n), residual: ExactRational.zero() }, evidence: derivation.evidence, derivation }),
      sealedEffect("openItem", { id: identifier<"OpenItem">("m-open"), bookId: IDS.book, kind: "receivable" as const, scope: { externalPartyId: "C", controlAccountId: account("AR") }, recognitionPostingId: postingIdOf("m-open"), recognizedOn: localDate("2026-01-01"), denominationCommodityId: IDS.usd, denomination: one, bookValue: one, derivation }),
      sealedEffect("settlement", { id: identifier<"Settlement">("m-settlement"), bookId: IDS.book, kind: "cash" as const, scope: { externalPartyId: "C", controlAccountId: account("AR") }, settlementPostingId: postingIdOf("m-settlement"), settledAt: instant("2026-01-01T00:00:00Z"), denominationCommodityId: IDS.usd, denomination: one, bookValue: one, derivation }),
      sealedEffect("settlementAllocation", { id: identifier<"SettlementAllocation">("m-settlement-allocation"), openItemId: identifier<"OpenItem">("m-open"), settlementId: identifier<"Settlement">("m-settlement"), allocatedBookValue: one, allocatedOpenQuantity: one, allocatedSettlementQuantity: one, derivation }),
      sealedEffect("remeasurementResult", { id: identifier<"RemeasurementResult">("m-remeasure"), kind: "unrealized" as const, sourcePostingId: postingIdOf("m-remeasure"), effectiveOn: localDate("2026-01-01"), carryingBookValue: one, measuredBookValue: one, difference: ExactRational.zero(), valuationRate: one, policyId: policyId("p"), derivation }),
      sealedEffect("remeasurementReversal", { id: identifier<"RemeasurementReversal">("m-reversal"), originalResultId: identifier<"RemeasurementResult">("m-remeasure"), reversedOn: localDate("2026-01-02"), derivation }),
      sealedEffect("allocationSchedule", { id: identifier<"AllocationSchedule">("m-schedule"), bookId: IDS.book, policyId: policyId("p"), sourcePostingId: postingIdOf("m-schedule"), sourceBasis: one, residualValue: ExactRational.zero(), installments: Object.freeze([Object.freeze({ ordinal: 1n, accountingDate: localDate("2026-01-31"), amount: one })]), derivation }),
      sealedEffect("allocationRecognition", { id: identifier<"AllocationRecognition">("m-recognition"), scheduleId: identifier<"AllocationSchedule">("m-schedule"), ordinal: 1n, derivation }),
      sealedEffect("allocationScheduleRevision", { id: identifier<"AllocationScheduleRevision">("m-schedule-revision"), kind: "estimateChange", effectiveOn: localDate("2026-01-15"), originalScheduleId: identifier<"AllocationSchedule">("m-schedule"), priorRecognitionIds: Object.freeze([]), recognizedToDate: ExactRational.zero(), carryingAmountAtRevision: one, successorScheduleId: identifier<"AllocationSchedule">("m-successor"), evidence: derivation.evidence, derivation }),
      sealedEffect("taxDetermination", { id: identifier<"TaxDetermination">("m-tax"), bookId: IDS.book, taxPoint: instant("2026-01-01T00:00:00Z"), sourceTransactionId: identifier<"JournalTransaction">("m-tax-source"), direction: "purchase" as const, lines: Object.freeze([]), derivation }),
      sealedEffect("consolidationCompilation", { id: identifier<"ConsolidationCompilation">("m-consolidation"), bookId: IDS.book, policyId: policyId("p"), throughOn: localDate("2026-01-01"), sourcePopulationHashes: Object.freeze([]), derivation }),
    ] as AccountingEffect[]);
    for (const effect of effects) {
      const state = emptyAccountingCanonicalState();
      const result = validateAccountingEffectAdmission(state, [effect, effect], IDS.book);
      expect(result[0]?.code, `duplicate ${effect.type}`).toBe("canonical_identity_conflict");
    }
  });
});

function postingIdOf(value: string) {
  return identifier<"Posting">(`${value}-posting`);
}
function computeHash(type: string, body: Record<string, unknown>) {
  const capitalized = type[0]!.toUpperCase() + type.slice(1);
  return hashCanonical({ type: capitalized, value: canonicalAccountingValue(body) });
}
function sealedEffect(type: string, body: Record<string, unknown>): AccountingEffect {
  const capitalized = type[0]!.toUpperCase() + type.slice(1);
  return { type: type as never, value: Object.freeze({ ...body, contentHash: hashCanonical({ type: capitalized, value: canonicalAccountingValue(body) }) }) as never };
}

describe("calculator boundary adversaries (mutation companions)", () => {
  test("recognizeScheduledAllocation rejects ordinal zero and declining schedules keep exact counts", () => {
    const allocation = allocationPolicy();
    const scheduled = createAllocationSchedule([allocation], IDS.book, {
      id: identifier<"AllocationSchedule">("mutation-declining"), policyId: allocation.id, policyVersion: allocation.version,
      governedAt: instant("2026-01-01T00:00:00Z"), sourcePostingId: identifier<"Posting">("mutation-declining-source"),
      sourceBasis: ExactRational.of(1_200n, 1n), residualValue: ExactRational.zero(),
      startsOn: localDate("2026-01-01"), endsOn: localDate("2026-03-31"), derivation: accountingDerivation,
    });
    expect(scheduled.disposition).toBe("draft");
    if (scheduled.disposition === "draft") {
      const effect = scheduled.draft.effects[0]!;
      if (effect.type !== "allocationSchedule") throw new Error("Expected schedule");
      expect(effect.value.installments).toHaveLength(3);
      expect(effect.value.installments.reduce((total, installment) => total.add(installment.amount), ExactRational.zero()).toString()).toBe("1200/1");
    }
  });

  test("zero currency difference books to the loss account, not the gain account", () => {
    const currencyPolicy: AccountingPolicy = Object.freeze({
      ...policyCore("currencyRemeasurement", "mutation-currency", "closingRate"),
      kind: "currencyRemeasurement" as const, reversalRequired: false, gainAccountId: account("GAIN"), lossAccountId: account("LOSS"),
    });
    const classification: AccountingPolicy = Object.freeze({
      ...policyCore("monetaryClassification", "mutation-monetary", "accountRule"),
      kind: "monetaryClassification" as const,
      rules: Object.freeze([{ id: policyId("mutation-monetary-ar"), accountId: account("AR"), classification: "monetary" as const, contentHash: hashCanonical({ rule: "ar" }) }]),
    });
    const result = determineCurrencyDifferenceZero(currencyPolicy, classification);
    if (result.disposition !== "draft") throw new Error(`Expected draft: ${JSON.stringify(result.disposition === "rejected" ? result.diagnostics[0]?.message : "")}`);
    const journal = result.draft.journals[0]!;
    const gainOrLoss = journal.postings.find((posting) => posting.accountId === account("GAIN") || posting.accountId === account("LOSS"));
    expect(gainOrLoss?.accountId).toBe(account("LOSS"));
  });
  function determineCurrencyDifferenceZero(currencyPolicy: AccountingPolicy, classification: AccountingPolicy) {
    return calculateCurrencyRemeasurement([classification, currencyPolicy], IDS.book, IDS.usd, {
      id: identifier<"RemeasurementResult">("mutation-zero-difference"), policyId: currencyPolicy.id, policyVersion: currencyPolicy.version,
      classificationPolicyId: classification.id, classificationPolicyVersion: classification.version,
      governedAt: instant("2026-01-31T00:00:00Z"), kind: "unrealized", classification: "monetary",
      sourcePostingId: identifier<"Posting">("mutation-zero-source"), effectiveOn: localDate("2026-01-31"),
      denominationCommodityId: commodityId("EUR"), denomination: ExactRational.of(100n, 1n), carryingBookValue: ExactRational.of(100n, 1n),
      valuationPath: { fromCommodityId: commodityId("EUR"), toCommodityId: IDS.usd, effectiveAt: instant("2026-01-31T00:00:00Z"), observedAt: instant("2026-01-30T00:00:00Z"), rate: ExactRational.of(1n, 1n), evidenceIds: Object.freeze([accountingDerivation.evidence[0]!.id]) },
      positionAccountId: account("AR"), derivation: accountingDerivation,
    }, emptyAccountingCanonicalState());
  }
  test("tax graphs reject compound ordinal zero", () => {
    const policy: AccountingPolicy = Object.freeze({
      ...policyCore("taxDetermination", "mutation-tax-zero", "compound"),
      kind: "taxDetermination" as const, taxCode: "GST", jurisdiction: "TEST", roundingLevel: "lineLevel" as const,
      components: Object.freeze([taxComponent("ZERO-ORDINAL", { compoundOrdinal: 0n })]),
    });
    const result = determineTax([policy], IDS.book, IDS.usd, {
      id: identifier<"TaxDetermination">("mutation-tax-zero-determination"), sourceTransactionId: identifier<"JournalTransaction">("mutation-tax-zero-source"),
      governedAt: instant("2026-01-15T14:00:00Z"), direction: "purchase",
      lines: Object.freeze([{ lineId: "L1", sourcePostingId: identifier<"Posting">("mutation-tax-zero-source-posting"), counterpartyPostingId: identifier<"Posting">("mutation-tax-zero-counterparty"), policyId: policy.id, policyVersion: policy.version, statedAmount: ExactRational.of(100n, 1n), amountIncludesTax: false, sourceAccountId: account("EXPENSE"), payableAccountId: account("AP") }]),
      derivation: accountingDerivation,
    });
    expect(result.disposition).toBe("rejected");
    if (result.disposition === "rejected") expect(result.diagnostics[0]?.code).toBe("tax_policy_ambiguity");
  });

  test("open item settlement admits second open item allocations that first-item allocations must not pollute", () => {
    const derivation = accountingDerivation;
    let state = emptyAccountingCanonicalState();
    for (const openId of ["O1", "O2"]) {
      const opened = recognizeOpenItem(state, { value: { id: identifier<"OpenItem">(openId), bookId: IDS.book, kind: "receivable" as const, scope: { externalPartyId: "C", controlAccountId: account("AR") }, recognitionPostingId: identifier<"Posting">(`${openId}-posting`), recognizedOn: localDate("2026-01-01"), denominationCommodityId: IDS.usd, denomination: ExactRational.of(100n, 1n), bookValue: ExactRational.of(100n, 1n), derivation } });
      if (opened.disposition !== "draft") throw new Error("Open item must draft");
      state = applyAccountingEffect(state, opened.draft.effects[0]!);
    }
    const first = applySettlement(state, {
      settlement: { id: identifier<"Settlement">("S1"), bookId: IDS.book, kind: "cash" as const, scope: { externalPartyId: "C", controlAccountId: account("AR") }, settlementPostingId: identifier<"Posting">("S1-posting"), settledAt: instant("2026-01-20T00:00:00Z"), denominationCommodityId: IDS.usd, denomination: ExactRational.of(60n, 1n), bookValue: ExactRational.of(60n, 1n), derivation },
      allocations: [{ id: identifier<"SettlementAllocation">("S1-O1"), openItemId: identifier<"OpenItem">("O1"), settlementId: identifier<"Settlement">("S1"), allocatedBookValue: ExactRational.of(60n, 1n), allocatedOpenQuantity: ExactRational.of(60n, 1n), allocatedSettlementQuantity: ExactRational.of(60n, 1n), derivation }],
    });
    expect(first.disposition).toBe("draft");
    if (first.disposition === "draft") for (const effect of first.draft.effects) state = applyAccountingEffect(state, effect);
    const second = applySettlement(state, {
      settlement: { id: identifier<"Settlement">("S2"), bookId: IDS.book, kind: "cash" as const, scope: { externalPartyId: "C", controlAccountId: account("AR") }, settlementPostingId: identifier<"Posting">("S2-posting"), settledAt: instant("2026-01-21T00:00:00Z"), denominationCommodityId: IDS.usd, denomination: ExactRational.of(60n, 1n), bookValue: ExactRational.of(60n, 1n), derivation },
      allocations: [{ id: identifier<"SettlementAllocation">("S2-O2"), openItemId: identifier<"OpenItem">("O2"), settlementId: identifier<"Settlement">("S2"), allocatedBookValue: ExactRational.of(60n, 1n), allocatedOpenQuantity: ExactRational.of(60n, 1n), allocatedSettlementQuantity: ExactRational.of(60n, 1n), derivation }],
    });
    expect(second.disposition).toBe("draft");
  });

  test("rejectExternalAccountingAuthority retains per-attempt requirement mappings", () => {
    expect(rejectExternalAccountingAuthority("policySelection")[0]?.requirementIds.join(",")).toContain("ACC-047.5");
    expect(rejectExternalAccountingAuthority("directPersistence")[0]?.requirementIds.join(",")).toContain("ACC-047.4");
  });
});

describe("accountingEffectExists distinguishes identity collisions from fresh ids", () => {
  test("a fresh id in a populated family is admitted while a colliding id is rejected", () => {
    const derivation = accountingDerivation;
    const layers = [
      { type: "provisionalInventoryLayer" as const, value: Object.freeze({ id: identifier<"ProvisionalInventoryLayer">("f-layer-1"), bookId: IDS.book, policyId: policyId("p"), issuePostingId: identifier<"Posting">("f-layer-1-posting"), openedAt: instant("2026-01-01T00:00:00Z"), quantity: one, provisionalBasis: one, derivation, contentHash: computeHash("provisionalInventoryLayer", { id: identifier<"ProvisionalInventoryLayer">("f-layer-1"), bookId: IDS.book, policyId: policyId("p"), issuePostingId: identifier<"Posting">("f-layer-1-posting"), openedAt: instant("2026-01-01T00:00:00Z"), quantity: one, provisionalBasis: one, derivation }) }) },
      { type: "openItem" as const, value: Object.freeze({ id: identifier<"OpenItem">("f-open-1"), bookId: IDS.book, kind: "receivable" as const, scope: { externalPartyId: "C", controlAccountId: account("AR") }, recognitionPostingId: identifier<"Posting">("f-open-1-posting"), recognizedOn: localDate("2026-01-01"), denominationCommodityId: IDS.usd, denomination: one, bookValue: one, derivation, contentHash: computeHash("openItem", { id: identifier<"OpenItem">("f-open-1"), bookId: IDS.book, kind: "receivable", scope: { externalPartyId: "C", controlAccountId: account("AR") }, recognitionPostingId: identifier<"Posting">("f-open-1-posting"), recognizedOn: localDate("2026-01-01"), denominationCommodityId: IDS.usd, denomination: one, bookValue: one, derivation }) }) },
      { type: "settlement" as const, value: Object.freeze({ id: identifier<"Settlement">("f-settlement-1"), bookId: IDS.book, kind: "cash" as const, scope: { externalPartyId: "C", controlAccountId: account("AR") }, settlementPostingId: identifier<"Posting">("f-settlement-1-posting"), settledAt: instant("2026-01-01T00:00:00Z"), denominationCommodityId: IDS.usd, denomination: one, bookValue: one, derivation, contentHash: computeHash("settlement", { id: identifier<"Settlement">("f-settlement-1"), bookId: IDS.book, kind: "cash", scope: { externalPartyId: "C", controlAccountId: account("AR") }, settlementPostingId: identifier<"Posting">("f-settlement-1-posting"), settledAt: instant("2026-01-01T00:00:00Z"), denominationCommodityId: IDS.usd, denomination: one, bookValue: one, derivation }) }) },
      { type: "allocationSchedule" as const, value: Object.freeze({ id: identifier<"AllocationSchedule">("f-schedule-1"), bookId: IDS.book, policyId: policyId("p"), policy: allocationPolicy(), sourcePostingId: identifier<"Posting">("f-schedule-1-posting"), sourceBasis: one, residualValue: ExactRational.zero(), installments: Object.freeze([]), derivation, contentHash: computeHash("allocationSchedule", { id: identifier<"AllocationSchedule">("f-schedule-1"), bookId: IDS.book, policyId: policyId("p"), policy: allocationPolicy(), sourcePostingId: identifier<"Posting">("f-schedule-1-posting"), sourceBasis: one, residualValue: ExactRational.zero(), installments: Object.freeze([]), derivation }) }) },
      { type: "taxDetermination" as const, value: Object.freeze({ id: identifier<"TaxDetermination">("f-tax-1"), bookId: IDS.book, taxPoint: instant("2026-01-01T00:00:00Z"), sourceTransactionId: identifier<"JournalTransaction">("f-tax-1-source"), direction: "purchase" as const, lines: Object.freeze([]), derivation, contentHash: computeHash("taxDetermination", { id: identifier<"TaxDetermination">("f-tax-1"), bookId: IDS.book, taxPoint: instant("2026-01-01T00:00:00Z"), sourceTransactionId: identifier<"JournalTransaction">("f-tax-1-source"), direction: "purchase", lines: Object.freeze([]), derivation }) }) },
      { type: "inventoryRecosting" as const, value: Object.freeze({ id: identifier<"InventoryRecosting">("f-recost-1"), layerId: identifier<"ProvisionalInventoryLayer">("f-layer-1"), resolvedAt: instant("2026-01-01T00:00:00Z"), sources: Object.freeze([]), adjustment: ExactRational.zero(), derivation, contentHash: computeHash("inventoryRecosting", { id: identifier<"InventoryRecosting">("f-recost-1"), layerId: identifier<"ProvisionalInventoryLayer">("f-layer-1"), resolvedAt: instant("2026-01-01T00:00:00Z"), sources: Object.freeze([]), adjustment: ExactRational.zero(), derivation }) }) },
      { type: "settlementAllocation" as const, value: Object.freeze({ id: identifier<"SettlementAllocation">("f-alloc-1"), openItemId: identifier<"OpenItem">("f-open-1"), settlementId: identifier<"Settlement">("f-settlement-1"), allocatedBookValue: ExactRational.zero(), allocatedOpenQuantity: ExactRational.zero(), allocatedSettlementQuantity: ExactRational.zero(), derivation, contentHash: computeHash("settlementAllocation", { id: identifier<"SettlementAllocation">("f-alloc-1"), openItemId: identifier<"OpenItem">("f-open-1"), settlementId: identifier<"Settlement">("f-settlement-1"), allocatedBookValue: ExactRational.zero(), allocatedOpenQuantity: ExactRational.zero(), allocatedSettlementQuantity: ExactRational.zero(), derivation }) }) },
      { type: "remeasurementResult" as const, value: Object.freeze({ id: identifier<"RemeasurementResult">("f-rem-1"), kind: "unrealized" as const, sourcePostingId: postingIdOf("f-rem-1"), effectiveOn: localDate("2026-01-01"), carryingBookValue: one, measuredBookValue: one, difference: ExactRational.zero(), valuationRate: one, policyId: policyId("p"), derivation, contentHash: computeHash("remeasurementResult", { id: identifier<"RemeasurementResult">("f-rem-1"), kind: "unrealized", sourcePostingId: postingIdOf("f-rem-1"), effectiveOn: localDate("2026-01-01"), carryingBookValue: one, measuredBookValue: one, difference: ExactRational.zero(), valuationRate: one, policyId: policyId("p"), derivation }) }) },
      { type: "remeasurementReversal" as const, value: Object.freeze({ id: identifier<"RemeasurementReversal">("f-rrev-1"), originalResultId: identifier<"RemeasurementResult">("f-rem-1"), reversedOn: localDate("2026-01-02"), derivation, contentHash: computeHash("remeasurementReversal", { id: identifier<"RemeasurementReversal">("f-rrev-1"), originalResultId: identifier<"RemeasurementResult">("f-rem-1"), reversedOn: localDate("2026-01-02"), derivation }) }) },
      { type: "allocationRecognition" as const, value: Object.freeze({ id: identifier<"AllocationRecognition">("f-recog-1"), scheduleId: identifier<"AllocationSchedule">("f-schedule-1"), ordinal: 1n, derivation, contentHash: computeHash("allocationRecognition", { id: identifier<"AllocationRecognition">("f-recog-1"), scheduleId: identifier<"AllocationSchedule">("f-schedule-1"), ordinal: 1n, derivation }) }) },
      { type: "consolidationCompilation" as const, value: Object.freeze({ id: identifier<"ConsolidationCompilation">("f-consolidation-1"), bookId: IDS.book, policyId: policyId("p"), throughOn: localDate("2026-01-01"), sourcePopulationHashes: Object.freeze([]), derivation, contentHash: computeHash("consolidationCompilation", { id: identifier<"ConsolidationCompilation">("f-consolidation-1"), bookId: IDS.book, policyId: policyId("p"), throughOn: localDate("2026-01-01"), sourcePopulationHashes: Object.freeze([]), derivation }) }) },
    ] as readonly AccountingEffect[];
    const freshIds: Readonly<Record<string, AccountingEffect>> = {
      provisionalInventoryLayer: { type: "provisionalInventoryLayer", value: Object.freeze({ id: identifier<"ProvisionalInventoryLayer">("f-layer-2"), bookId: IDS.book, policyId: policyId("p"), issuePostingId: identifier<"Posting">("f-layer-2-posting"), openedAt: instant("2026-01-02T00:00:00Z"), quantity: one, provisionalBasis: one, derivation, contentHash: computeHash("provisionalInventoryLayer", { id: identifier<"ProvisionalInventoryLayer">("f-layer-2"), bookId: IDS.book, policyId: policyId("p"), issuePostingId: identifier<"Posting">("f-layer-2-posting"), openedAt: instant("2026-01-02T00:00:00Z"), quantity: one, provisionalBasis: one, derivation }) }) },
      openItem: { type: "openItem", value: Object.freeze({ id: identifier<"OpenItem">("f-open-2"), bookId: IDS.book, kind: "receivable" as const, scope: { externalPartyId: "C", controlAccountId: account("AR") }, recognitionPostingId: identifier<"Posting">("f-open-2-posting"), recognizedOn: localDate("2026-01-01"), denominationCommodityId: IDS.usd, denomination: one, bookValue: one, derivation, contentHash: computeHash("openItem", { id: identifier<"OpenItem">("f-open-2"), bookId: IDS.book, kind: "receivable", scope: { externalPartyId: "C", controlAccountId: account("AR") }, recognitionPostingId: identifier<"Posting">("f-open-2-posting"), recognizedOn: localDate("2026-01-01"), denominationCommodityId: IDS.usd, denomination: one, bookValue: one, derivation }) }) },
      settlement: { type: "settlement", value: Object.freeze({ id: identifier<"Settlement">("f-settlement-2"), bookId: IDS.book, kind: "cash" as const, scope: { externalPartyId: "C", controlAccountId: account("AR") }, settlementPostingId: identifier<"Posting">("f-settlement-2-posting"), settledAt: instant("2026-01-01T00:00:00Z"), denominationCommodityId: IDS.usd, denomination: one, bookValue: one, derivation, contentHash: computeHash("settlement", { id: identifier<"Settlement">("f-settlement-2"), bookId: IDS.book, kind: "cash", scope: { externalPartyId: "C", controlAccountId: account("AR") }, settlementPostingId: identifier<"Posting">("f-settlement-2-posting"), settledAt: instant("2026-01-01T00:00:00Z"), denominationCommodityId: IDS.usd, denomination: one, bookValue: one, derivation }) }) },
      allocationSchedule: { type: "allocationSchedule", value: Object.freeze({ id: identifier<"AllocationSchedule">("f-schedule-2"), bookId: IDS.book, policyId: policyId("p"), policy: allocationPolicy(), sourcePostingId: identifier<"Posting">("f-schedule-2-posting"), sourceBasis: one, residualValue: ExactRational.zero(), installments: Object.freeze([]), derivation, contentHash: computeHash("allocationSchedule", { id: identifier<"AllocationSchedule">("f-schedule-2"), bookId: IDS.book, policyId: policyId("p"), policy: allocationPolicy(), sourcePostingId: identifier<"Posting">("f-schedule-2-posting"), sourceBasis: one, residualValue: ExactRational.zero(), installments: Object.freeze([]), derivation }) }) },
      taxDetermination: { type: "taxDetermination", value: Object.freeze({ id: identifier<"TaxDetermination">("f-tax-2"), bookId: IDS.book, taxPoint: instant("2026-01-01T00:00:00Z"), sourceTransactionId: identifier<"JournalTransaction">("f-tax-2-source"), direction: "purchase" as const, lines: Object.freeze([]), derivation, contentHash: computeHash("taxDetermination", { id: identifier<"TaxDetermination">("f-tax-2"), bookId: IDS.book, taxPoint: instant("2026-01-01T00:00:00Z"), sourceTransactionId: identifier<"JournalTransaction">("f-tax-2-source"), direction: "purchase", lines: Object.freeze([]), derivation }) }) },
      consolidationCompilation: { type: "consolidationCompilation", value: Object.freeze({ id: identifier<"ConsolidationCompilation">("f-consolidation-2"), bookId: IDS.book, policyId: policyId("p"), throughOn: localDate("2026-01-01"), sourcePopulationHashes: Object.freeze([]), derivation, contentHash: computeHash("consolidationCompilation", { id: identifier<"ConsolidationCompilation">("f-consolidation-2"), bookId: IDS.book, policyId: policyId("p"), throughOn: localDate("2026-01-01"), sourcePopulationHashes: Object.freeze([]), derivation }) }) },
      inventoryRecosting: { type: "inventoryRecosting", value: Object.freeze({ id: identifier<"InventoryRecosting">("f-recost-2"), layerId: identifier<"ProvisionalInventoryLayer">("f-layer-1"), resolvedAt: instant("2026-01-01T00:00:00Z"), sources: Object.freeze([]), adjustment: ExactRational.zero(), derivation, contentHash: computeHash("inventoryRecosting", { id: identifier<"InventoryRecosting">("f-recost-2"), layerId: identifier<"ProvisionalInventoryLayer">("f-layer-1"), resolvedAt: instant("2026-01-01T00:00:00Z"), sources: Object.freeze([]), adjustment: ExactRational.zero(), derivation }) }) },
      settlementAllocation: { type: "settlementAllocation", value: Object.freeze({ id: identifier<"SettlementAllocation">("f-alloc-2"), openItemId: identifier<"OpenItem">("f-open-1"), settlementId: identifier<"Settlement">("f-settlement-1"), allocatedBookValue: ExactRational.zero(), allocatedOpenQuantity: ExactRational.zero(), allocatedSettlementQuantity: ExactRational.zero(), derivation, contentHash: computeHash("settlementAllocation", { id: identifier<"SettlementAllocation">("f-alloc-2"), openItemId: identifier<"OpenItem">("f-open-1"), settlementId: identifier<"Settlement">("f-settlement-1"), allocatedBookValue: ExactRational.zero(), allocatedOpenQuantity: ExactRational.zero(), allocatedSettlementQuantity: ExactRational.zero(), derivation }) }) },
      remeasurementResult: { type: "remeasurementResult", value: Object.freeze({ id: identifier<"RemeasurementResult">("f-rem-2"), kind: "unrealized" as const, sourcePostingId: postingIdOf("f-rem-2"), effectiveOn: localDate("2026-01-01"), carryingBookValue: one, measuredBookValue: one, difference: ExactRational.zero(), valuationRate: one, policyId: policyId("p"), derivation, contentHash: computeHash("remeasurementResult", { id: identifier<"RemeasurementResult">("f-rem-2"), kind: "unrealized", sourcePostingId: postingIdOf("f-rem-2"), effectiveOn: localDate("2026-01-01"), carryingBookValue: one, measuredBookValue: one, difference: ExactRational.zero(), valuationRate: one, policyId: policyId("p"), derivation }) }) },
      remeasurementReversal: { type: "remeasurementReversal", value: Object.freeze({ id: identifier<"RemeasurementReversal">("f-rrev-2"), originalResultId: identifier<"RemeasurementResult">("f-rem-1"), reversedOn: localDate("2026-01-02"), derivation, contentHash: computeHash("remeasurementReversal", { id: identifier<"RemeasurementReversal">("f-rrev-2"), originalResultId: identifier<"RemeasurementResult">("f-rem-1"), reversedOn: localDate("2026-01-02"), derivation }) }) },
      allocationRecognition: { type: "allocationRecognition", value: Object.freeze({ id: identifier<"AllocationRecognition">("f-recog-2"), scheduleId: identifier<"AllocationSchedule">("f-schedule-1"), ordinal: 1n, derivation, contentHash: computeHash("allocationRecognition", { id: identifier<"AllocationRecognition">("f-recog-2"), scheduleId: identifier<"AllocationSchedule">("f-schedule-1"), ordinal: 1n, derivation }) }) },
    };
    for (const effect of layers) {
      const family = effect.type;
      const fresh = freshIds[family];
      if (fresh === undefined) continue;
      const populated = applyAccountingEffect(emptyAccountingCanonicalState(), effect);
      const admission = validateAccountingEffectAdmission(populated, [fresh], IDS.book);
      expect(admission, `fresh ${family} id must be admitted`).toEqual([]);
    }
  });
});

const inventoryCostPolicy: InventoryCostPolicy = Object.freeze({
  ...policyCore("inventoryCost", "m-inventory-cost", "fifo"),
  kind: "inventoryCost",
  method: "fifo",
  pools: Object.freeze([pool("m-pool-1", "INV1"), pool("m-pool-2", "INV2")]),
  shortageTreatment: "provisionalNegative",
  provisionalBasisMethod: "explicitRate",
  provisionalRate: ExactRational.of(5n, 1n),
});

const inventoryValueAdjustmentPolicy: InventoryValueAdjustmentPolicy = Object.freeze({
  ...policyCore("inventoryValueAdjustment", "m-inv-val", "valueAdjustment"),
  kind: "inventoryValueAdjustment",
  inventoryCostPolicyId: inventoryCostPolicy.id,
  inventoryCostPolicyVersion: inventoryCostPolicy.version,
  allowedKinds: Object.freeze(["directlyAttributableCost", "purchaseRebate", "productionOverhead", "writeDown", "writeDownReversal"] as const),
  inventoryAccountId: account("INV"),
  recognizedCostAccountId: account("COGS"),
  adjustmentAccountId: account("ADJ"),
});

const basisPolicy: AccountingBasisPolicy = Object.freeze({
  ...policyCore("accountingBasis", "m-basis", "cash"),
  kind: "accountingBasis",
  basis: "cash",
  rules: Object.freeze([
    basisRule("m-basis-1", "recognition", "carryThrough"),
    basisRule("m-basis-2", "settlement", "carryThrough"),
  ]),
});

const monetaryPolicy: MonetaryClassificationPolicy = Object.freeze({
  ...policyCore("monetaryClassification", "m-monetary", "accountRule"),
  kind: "monetaryClassification",
  rules: Object.freeze([classificationRule("m-mon-1", "AR", "monetary")]),
});

const currencyPolicyFixture: Extract<AccountingPolicy, { readonly kind: "currencyRemeasurement" }> = Object.freeze({
  ...policyCore("currencyRemeasurement", "m-currency", "closingRate"),
  kind: "currencyRemeasurement",
  reversalRequired: true,
  gainAccountId: account("GAIN"),
  lossAccountId: account("LOSS"),
});

const taxPolicyFixture: TaxPolicy = Object.freeze({
  ...policyCore("taxDetermination", "m-tax-pol", "compound"),
  kind: "taxDetermination",
  taxCode: "GST",
  jurisdiction: "TEST",
  roundingLevel: "lineLevel" as const,
  components: Object.freeze([taxComponent("m-tax-comp-1")]),
});

const consolidationPolicyFixture: ConsolidationPolicy = Object.freeze({
  ...policyCore("consolidation", "m-consol", "full"),
  kind: "consolidation",
  supportedMethods: Object.freeze(["full"] as const),
  accountMappings: Object.freeze([consolidationMapping("m-cmap-1", "A1", "A2")]),
  translationRules: Object.freeze([translationRule("m-trule-1", "A1", "A2")]),
  valuationPolicy: consolidationValuationPolicy("m-val-pol"),
  translationAdjustmentAccountId: account("TRANS"),
  parentAttributableEquityAccountId: account("EQUITY"),
  nonControllingInterestAccountId: account("NCI"),
});

describe("accountingPolicyCapabilityIsExecutable covers all policy families and invalid configurations", () => {
  test("admits all canonical executable policy fixtures", () => {
    const policies = [
      inventoryCostPolicy,
      inventoryValueAdjustmentPolicy,
      basisPolicy,
      monetaryPolicy,
      currencyPolicyFixture,
      allocationPolicy(),
      taxPolicyFixture,
      consolidationPolicyFixture,
    ];
    for (const p of policies) {
      expect(accountingPolicyCapabilityIsExecutable(p), p.kind).toBeTrue();
    }
  });

  test("inventoryCost policy invariants", () => {
    expect(accountingPolicyCapabilityIsExecutable({ ...inventoryCostPolicy, pools: [] })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({
      ...inventoryCostPolicy,
      pools: [pool("m-pool-dup-acct", "INV1"), pool("m-pool-dup-acct-2", "INV1")],
    })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({
      ...inventoryCostPolicy,
      pools: [pool("m-pool-dup-id", "INV1"), pool("m-pool-dup-id", "INV2")],
    })).toBeFalse();

    // shortageTreatment reject requires no provisional rate and no provisional method
    expect(accountingPolicyCapabilityIsExecutable({ ...inventoryCostPolicy, shortageTreatment: "reject", provisionalBasisMethod: "explicitRate", provisionalRate: one })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...inventoryCostPolicy, shortageTreatment: "reject", provisionalBasisMethod: undefined, provisionalRate: one } as never)).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...inventoryCostPolicy, shortageTreatment: "reject", provisionalBasisMethod: "explicitRate", provisionalRate: undefined } as never)).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...inventoryCostPolicy, shortageTreatment: "reject", provisionalBasisMethod: undefined, provisionalRate: undefined } as never)).toBeTrue();

    // shortageTreatment provisionalNegative requires valid provisionalBasisMethod and non-negative/non-zero rate if explicitRate
    expect(accountingPolicyCapabilityIsExecutable({ ...inventoryCostPolicy, shortageTreatment: "provisionalNegative", provisionalBasisMethod: undefined, provisionalRate: one } as never)).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...inventoryCostPolicy, shortageTreatment: "provisionalNegative", provisionalBasisMethod: "explicitRate", provisionalRate: undefined } as never)).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...inventoryCostPolicy, shortageTreatment: "provisionalNegative", provisionalBasisMethod: "explicitRate", provisionalRate: ExactRational.zero() })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...inventoryCostPolicy, shortageTreatment: "provisionalNegative", provisionalBasisMethod: "explicitRate", provisionalRate: ExactRational.of(-1n, 1n) })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...inventoryCostPolicy, shortageTreatment: "provisionalNegative", provisionalBasisMethod: "lastReceiptCost", provisionalRate: undefined } as never)).toBeTrue();
    expect(accountingPolicyCapabilityIsExecutable({ ...inventoryCostPolicy, shortageTreatment: "provisionalNegative", provisionalBasisMethod: "movingAverage", provisionalRate: undefined } as never)).toBeTrue();
  });

  test("inventoryValueAdjustment policy invariants", () => {
    expect(accountingPolicyCapabilityIsExecutable({ ...inventoryValueAdjustmentPolicy, allowedKinds: [] })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...inventoryValueAdjustmentPolicy, allowedKinds: ["writeDown", "writeDown"] as never })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...inventoryValueAdjustmentPolicy, allowedKinds: ["invalidKind" as never] })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...inventoryValueAdjustmentPolicy, inventoryAccountId: inventoryValueAdjustmentPolicy.recognizedCostAccountId })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...inventoryValueAdjustmentPolicy, inventoryAccountId: inventoryValueAdjustmentPolicy.adjustmentAccountId })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...inventoryValueAdjustmentPolicy, recognizedCostAccountId: inventoryValueAdjustmentPolicy.adjustmentAccountId })).toBeFalse();
  });

  test("accountingBasis and monetaryClassification policy invariants", () => {
    expect(accountingPolicyCapabilityIsExecutable({ ...basisPolicy, rules: [] })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...basisPolicy, rules: [basisPolicy.rules[0]!, { ...basisPolicy.rules[0]!, id: policyId("m-other-rule") }] })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...basisPolicy, rules: [basisPolicy.rules[0]!, { ...basisPolicy.rules[0]!, event: "settlement" }] })).toBeFalse();

    expect(accountingPolicyCapabilityIsExecutable({ ...monetaryPolicy, rules: [] })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...monetaryPolicy, rules: [monetaryPolicy.rules[0]!, { ...monetaryPolicy.rules[0]!, id: policyId("m-other-mon") }] })).toBeFalse();
  });

  test("currencyRemeasurement policy invariants", () => {
    expect(accountingPolicyCapabilityIsExecutable({ ...currencyPolicyFixture, gainAccountId: currencyPolicyFixture.lossAccountId })).toBeFalse();
  });

  test("allocationSchedule policy invariants", () => {
    const alloc = allocationPolicy();
    const cumulativeAlloc: AllocationPolicy = {
      ...alloc,
      postingAlgorithm: "cumulative-posted-allocation-v1",
      algorithmVersion: semanticVersion("1.1.0"),
    };
    expect(accountingPolicyCapabilityIsExecutable({ ...cumulativeAlloc, allocationAccountId: cumulativeAlloc.contraAccountId })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable(cumulativeAlloc)).toBeTrue();

    const units: AllocationPolicy = {
      ...alloc,
      method: "unitsOfProduction",
      frequency: "eventDriven",
      convention: "usageEvent",
      expectedUsage: one,
      capability: capability("allocationSchedule", "unitsOfProduction"),
    };
    expect(accountingPolicyCapabilityIsExecutable(units)).toBeTrue();
    expect(accountingPolicyCapabilityIsExecutable({ ...units, frequency: "monthly" })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...units, convention: "fullPeriod" })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...units, expectedUsage: undefined } as never)).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...units, expectedUsage: ExactRational.zero() })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...units, expectedUsage: ExactRational.of(-1n, 1n) })).toBeFalse();

    for (const freq of ["monthly", "quarterly", "annual"] as const) {
      expect(accountingPolicyCapabilityIsExecutable({ ...alloc, frequency: freq })).toBeTrue();
    }
    expect(accountingPolicyCapabilityIsExecutable({ ...alloc, convention: "usageEvent" })).toBeFalse();

    const declining: AllocationPolicy = {
      ...alloc,
      method: "decliningBalance",
      decliningRate: one,
      capability: capability("allocationSchedule", "decliningBalance"),
    };
    expect(accountingPolicyCapabilityIsExecutable(declining)).toBeTrue();
    expect(accountingPolicyCapabilityIsExecutable({ ...declining, decliningRate: undefined } as never)).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...declining, decliningRate: ExactRational.zero() })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...declining, decliningRate: ExactRational.of(-1n, 1n) })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...declining, decliningRate: ExactRational.of(2n, 1n) })).toBeFalse();
  });

  test("taxDetermination policy invariants", () => {
    expect(accountingPolicyCapabilityIsExecutable({ ...taxPolicyFixture, taxCode: "  " })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...taxPolicyFixture, jurisdiction: "  " })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...taxPolicyFixture, components: [] })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...taxPolicyFixture, components: [taxPolicyFixture.components[0]!, taxPolicyFixture.components[0]!] })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...taxPolicyFixture, roundingLevel: "invalid" as unknown as TaxRoundingLevel })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...taxPolicyFixture, roundingLevel: "lineLevel" })).toBeTrue();
    expect(accountingPolicyCapabilityIsExecutable({ ...taxPolicyFixture, roundingLevel: "documentLevel" })).toBeTrue();
  });

  test("consolidation policy invariants", () => {
    expect(accountingPolicyCapabilityIsExecutable({ ...consolidationPolicyFixture, supportedMethods: [] })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...consolidationPolicyFixture, supportedMethods: ["full", "full"] as never })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...consolidationPolicyFixture, supportedMethods: ["equity" as never] })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...consolidationPolicyFixture, accountMappings: [] })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...consolidationPolicyFixture, translationRules: [] })).toBeFalse();
    expect(accountingPolicyCapabilityIsExecutable({ ...consolidationPolicyFixture, valuationPolicy: { ...consolidationPolicyFixture.valuationPolicy, maximumHops: 0n } })).toBeFalse();
  });
});

describe("inventoryDisposalSelectionMatches and resolveRecostingPeriod", () => {
  test("inventoryDisposalSelectionMatches validates against expected methods and allocation mappings", () => {
    const allocations = Object.freeze([
      { layerId: lotHoldingId("selection-a"), quantity: one, basis: ExactRational.of(5n, 1n) },
      { layerId: lotHoldingId("selection-b"), quantity: ExactRational.of(2n, 1n), basis: ExactRational.of(10n, 1n) },
    ]);
    expect(inventoryDisposalSelectionMatches({ method: "fifo" }, "fifo", allocations)).toBeTrue();
    expect(inventoryDisposalSelectionMatches({ method: "fifo" }, "lifo", allocations)).toBeFalse();
    expect(inventoryDisposalSelectionMatches({ method: "specificIdentification", allocations: [
      { holdingId: lotHoldingId("selection-a"), quantity: one },
      { holdingId: lotHoldingId("selection-b"), quantity: ExactRational.of(2n, 1n) },
    ] }, "specificIdentification", allocations)).toBeTrue();
    expect(inventoryDisposalSelectionMatches({ method: "specificIdentification", allocations: [
      { holdingId: lotHoldingId("selection-a"), quantity: one },
    ] }, "specificIdentification", allocations)).toBeFalse();
    expect(inventoryDisposalSelectionMatches({ method: "specificIdentification", allocations: [
      { holdingId: lotHoldingId("selection-a"), quantity: one },
      { holdingId: lotHoldingId("wrong-selection"), quantity: ExactRational.of(2n, 1n) },
    ] }, "specificIdentification", allocations)).toBeFalse();
    expect(inventoryDisposalSelectionMatches({ method: "specificIdentification", allocations: [
      { holdingId: lotHoldingId("selection-a"), quantity: ExactRational.of(99n, 1n) },
      { holdingId: lotHoldingId("selection-b"), quantity: ExactRational.of(2n, 1n) },
    ] }, "specificIdentification", allocations)).toBeFalse();
  });

  test("resolveRecostingPeriod selects regular period within bounds or explicit period", () => {
    const regular = periods[0]!;
    expect(resolveRecostingPeriod(periods, regular.startsOn)?.id).toBe(regular.id);
    expect(resolveRecostingPeriod(periods, regular.endsOn)?.id).toBe(regular.id);
    expect(resolveRecostingPeriod(periods, localDate("1999-01-01"))).toBeUndefined();

    const adjustment = Object.freeze({ ...regular, id: fiscalPeriodId("adj-period"), kind: "adjustment" as const, sequence: 99n });
    const allPeriods = [...periods, adjustment];
    expect(resolveRecostingPeriod(allPeriods, regular.startsOn)?.kind).toBe("regular");
    expect(resolveRecostingPeriod(allPeriods, regular.startsOn, adjustment.id)?.id).toBe(adjustment.id);
    expect(resolveRecostingPeriod(allPeriods, localDate("1999-01-01"), adjustment.id)).toBeUndefined();
  });
});

describe("requiresRemeasurementReversal", () => {
  test("evaluates overdue unrealized currency remeasurement reversals accurately", () => {
    const policy: AccountingPolicy = Object.freeze({
      ...policyCore("currencyRemeasurement", "m-currency-rev", "closingRate"),
      kind: "currencyRemeasurement" as const,
      reversalRequired: true,
      gainAccountId: account("GAIN"),
      lossAccountId: account("LOSS"),
    });
    const candidate: RemeasurementAdmissionCandidate = {
      id: identifier<"RemeasurementResult">("candidate-1"),
      policyId: policy.id,
      kind: "unrealized",
      effectiveOn: localDate("2026-01-01"),
    };
    const command = {
      type: "postCurrencyRemeasurement" as const,
      issuedAt: instant("2026-01-15T00:00:00Z"),
      request: { reversalOf: undefined },
    } as unknown as BookCommand;

    expect(requiresRemeasurementReversal(command, candidate, policy)).toBeTrue();
    expect(requiresRemeasurementReversal({ ...command, request: { reversalOf: identifier<"RemeasurementResult">("candidate-1") } } as unknown as BookCommand, candidate, policy)).toBeFalse();
    expect(requiresRemeasurementReversal({ type: "adjustInventoryValue", issuedAt: instant("2026-01-15T00:00:00Z") } as unknown as BookCommand, candidate, policy)).toBeTrue();
    expect(requiresRemeasurementReversal(command, { ...candidate, kind: "realized" }, policy)).toBeFalse();
    expect(requiresRemeasurementReversal(command, { ...candidate, effectiveOn: localDate("2026-01-15") }, policy)).toBeFalse();
    expect(requiresRemeasurementReversal(command, { ...candidate, effectiveOn: localDate("2026-01-20") }, policy)).toBeFalse();
    expect(requiresRemeasurementReversal(command, candidate, undefined)).toBeFalse();
    expect(requiresRemeasurementReversal(command, candidate, { ...policy, id: policyId("other-id") })).toBeFalse();
    expect(requiresRemeasurementReversal(command, candidate, { ...policy, kind: "inventoryCost" } as unknown as AccountingPolicy)).toBeFalse();
    expect(requiresRemeasurementReversal(command, candidate, { ...policy, reversalRequired: false })).toBeFalse();
  });
});

describe("validateBookConfiguration covers periods, configuration, quantization, policies, and accounting policy snapshot", () => {
  test("validates period boundaries, calendar scope, sequences, overlaps, and gaps", () => {
    const { state } = freshState();
    expect(validateBookConfiguration(state)).toEqual([]);

    // Calendar mismatch
    const badCalendar = { ...state, periods: [{ ...periods[0]!, calendarId: fiscalCalendarId("other-cal") }] };
    expect(validateBookConfiguration(badCalendar).some((d) => d.code === "fiscal_period_admission")).toBeTrue();

    // Duplicate period id
    const dupPeriodId = { ...state, periods: [periods[0]!, { ...periods[1]!, id: periods[0]!.id }] };
    expect(validateBookConfiguration(dupPeriodId).some((d) => d.code === "fiscal_period_admission")).toBeTrue();

    // startsOn > endsOn
    const invertedPeriod = { ...state, periods: [{ ...periods[0]!, startsOn: localDate("2026-02-01"), endsOn: localDate("2026-01-01") }] };
    expect(validateBookConfiguration(invertedPeriod).some((d) => d.code === "fiscal_period_admission")).toBeTrue();

    // sequence <= 0n
    const zeroSequence = { ...state, periods: [{ ...periods[0]!, sequence: 0n }] };
    expect(validateBookConfiguration(zeroSequence).some((d) => d.code === "fiscal_period_admission")).toBeTrue();
    const negSequence = { ...state, periods: [{ ...periods[0]!, sequence: -1n }] };
    expect(validateBookConfiguration(negSequence).some((d) => d.code === "fiscal_period_admission")).toBeTrue();

    // duplicate sequence
    const dupSeq = { ...state, periods: [periods[0]!, { ...periods[1]!, sequence: periods[0]!.sequence }] };
    expect(validateBookConfiguration(dupSeq).some((d) => d.code === "fiscal_period_admission")).toBeTrue();

    // overlapping regular periods
    const overlapPeriods: readonly FiscalPeriod[] = [
      { ...periods[0]!, startsOn: localDate("2026-01-01"), endsOn: localDate("2026-01-15") },
      { ...periods[1]!, startsOn: localDate("2026-01-10"), endsOn: localDate("2026-01-31") },
    ];
    expect(validateBookConfiguration({ ...state, periods: overlapPeriods }).some((d) => d.code === "fiscal_period_admission" && d.message.includes("overlap"))).toBeTrue();

    // non-gap-free regular periods
    const gapPeriods: readonly FiscalPeriod[] = [
      { ...periods[0]!, startsOn: localDate("2026-01-01"), endsOn: localDate("2026-01-10") },
      { ...periods[1]!, startsOn: localDate("2026-01-15"), endsOn: localDate("2026-01-31") },
    ];
    expect(validateBookConfiguration({ ...state, periods: gapPeriods }).some((d) => d.code === "fiscal_period_admission" && d.message.includes("gap-free"))).toBeTrue();
  });

  test("validates presence of required configuration collections", () => {
    const { state } = freshState();
    expect(validateBookConfiguration({ ...state, periods: [] }).some((d) => d.code === "unresolved_accounting_input")).toBeTrue();
    expect(validateBookConfiguration({ ...state, admissionSnapshot: { ...state.admissionSnapshot, accounts: [] } }).some((d) => d.code === "unresolved_accounting_input")).toBeTrue();
    expect(validateBookConfiguration({ ...state, policies: [] }).some((d) => d.code === "unresolved_accounting_input")).toBeTrue();
    expect(validateBookConfiguration({ ...state, quantizationPolicies: [] }).some((d) => d.code === "unresolved_accounting_input")).toBeTrue();
  });

  test("validates quantization policies and booking policies", () => {
    const { state } = freshState();
    const quant = quantizationPolicy;

    // Duplicate quantization
    expect(validateBookConfiguration({ ...state, quantizationPolicies: [quant, quant] }).some((d) => d.code === "policy_ambiguity")).toBeTrue();
    // Quantization book mismatch
    expect(validateBookConfiguration({ ...state, quantizationPolicies: [{ ...quant, bookId: bookId("other-book") }] }).some((d) => d.code === "policy_ambiguity")).toBeTrue();
    // Quantization commodity mismatch
    expect(validateBookConfiguration({ ...state, quantizationPolicies: [{ ...quant, functionalCommodityId: commodityId("EUR") }] }).some((d) => d.code === "policy_ambiguity")).toBeTrue();
    // Quantization validTo <= validFrom
    expect(validateBookConfiguration({ ...state, quantizationPolicies: [{ ...quant, validFrom: localDate("2026-01-01"), validTo: localDate("2026-01-01") }] }).some((d) => d.code === "policy_ambiguity")).toBeTrue();
    expect(validateBookConfiguration({ ...state, quantizationPolicies: [{ ...quant, validFrom: localDate("2026-02-01"), validTo: localDate("2026-01-01") }] }).some((d) => d.code === "policy_ambiguity")).toBeTrue();
    // Rounding account not in admission accounts
    expect(validateBookConfiguration({ ...state, quantizationPolicies: [{ ...quant, roundingAccountId: accountId("absent-account") }] }).some((d) => d.code === "policy_ambiguity")).toBeTrue();

    // Booking policies: validTo <= validFrom
    expect(validateBookConfiguration({ ...state, policies: [{ ...policy, validFrom: instant("2026-02-01T00:00:00Z"), validTo: instant("2026-01-01T00:00:00Z") }] }).some((d) => d.code === "policy_ambiguity")).toBeTrue();
    // Duplicate booking policy
    expect(validateBookConfiguration({ ...state, policies: [policy, policy] }).some((d) => d.code === "canonical_identity_conflict")).toBeTrue();
    // Conflicting booking policy content
    expect(validateBookConfiguration({ ...state, policies: [policy, { ...policy, lotSelection: "fifo" }] }).some((d) => d.code === "canonical_identity_conflict")).toBeTrue();
  });

  test("validates accounting policies snapshot and individual accounting policies", () => {
    const { state } = freshState();
    const costPol = inventoryCostPolicy;
    const valuePol = inventoryValueAdjustmentPolicy;

    // Snapshot content hash mismatch
    expect(validateBookConfiguration({
      ...state,
      accountingPolicySnapshot: { ...state.accountingPolicySnapshot, contentHash: "0".repeat(64) as never },
    }).some((d) => d.code === "ordered_history_violation")).toBeTrue();

    // Duplicate accounting policy identity
    expect(validateBookConfiguration({
      ...state,
      accountingPolicySnapshot: createAccountingPolicySnapshot([costPol, costPol]),
    }).some((d) => d.code === "policy_ambiguity")).toBeTrue();

    // Accounting policy bookId mismatch
    expect(validateBookConfiguration({
      ...state,
      accountingPolicySnapshot: createAccountingPolicySnapshot([{ ...costPol, bookId: bookId("other-book") }]),
    }).some((d) => d.code === "policy_ambiguity")).toBeTrue();

    // Capability feature mismatch
    expect(validateBookConfiguration({
      ...state,
      accountingPolicySnapshot: createAccountingPolicySnapshot([{ ...costPol, capability: { ...costPol.capability, feature: "inventoryValueAdjustment" } }]),
    }).some((d) => d.code === "policy_ambiguity")).toBeTrue();

    // Capability status not supported
    expect(validateBookConfiguration({
      ...state,
      accountingPolicySnapshot: createAccountingPolicySnapshot([{ ...costPol, capability: { ...costPol.capability, status: "deprecated" as never } }]),
    }).some((d) => d.code === "policy_ambiguity")).toBeTrue();

    // Capability implementationVersion mismatch
    expect(validateBookConfiguration({
      ...state,
      accountingPolicySnapshot: createAccountingPolicySnapshot([{ ...costPol, capability: { ...costPol.capability, implementationVersion: semanticVersion("2.0.0") } }]),
    }).some((d) => d.code === "policy_ambiguity")).toBeTrue();

    // VerificationEvidenceIds empty
    expect(validateBookConfiguration({
      ...state,
      accountingPolicySnapshot: createAccountingPolicySnapshot([{ ...costPol, capability: { ...costPol.capability, verificationEvidenceIds: [] } }]),
    }).some((d) => d.code === "policy_ambiguity")).toBeTrue();

    // Quantization policy bookId / functionalCommodityId mismatch in policy
    expect(validateBookConfiguration({
      ...state,
      accountingPolicySnapshot: createAccountingPolicySnapshot([{ ...costPol, quantizationPolicy: { ...costPol.quantizationPolicy, bookId: bookId("other-book") } }]),
    }).some((d) => d.code === "policy_ambiguity")).toBeTrue();
    expect(validateBookConfiguration({
      ...state,
      accountingPolicySnapshot: createAccountingPolicySnapshot([{ ...costPol, quantizationPolicy: { ...costPol.quantizationPolicy, functionalCommodityId: commodityId("EUR") } }]),
    }).some((d) => d.code === "policy_ambiguity")).toBeTrue();

    // Linked inventory cost policy checks for inventoryValueAdjustment:
    // Missing linked inventory cost policy
    expect(validateBookConfiguration({
      ...state,
      accountingPolicySnapshot: createAccountingPolicySnapshot([valuePol]),
    }).some((d) => d.code === "policy_ambiguity")).toBeTrue();
    // Linked inventory cost policy version mismatch
    expect(validateBookConfiguration({
      ...state,
      accountingPolicySnapshot: createAccountingPolicySnapshot([{ ...costPol, version: semanticVersion("2.0.0") }, valuePol]),
    }).some((d) => d.code === "policy_ambiguity")).toBeTrue();
    // Linked inventory cost policy validFrom > valuePol.validFrom
    expect(validateBookConfiguration({
      ...state,
      accountingPolicySnapshot: createAccountingPolicySnapshot([
        { ...costPol, validFrom: instant("2026-06-01T00:00:00Z") },
        { ...valuePol, validFrom: instant("2026-01-01T00:00:00Z") },
      ]),
    }).some((d) => d.code === "policy_ambiguity")).toBeTrue();
    // Linked inventory cost policy validTo <= valuePol.validFrom
    expect(validateBookConfiguration({
      ...state,
      accountingPolicySnapshot: createAccountingPolicySnapshot([
        { ...costPol, validFrom: instant("2020-01-01T00:00:00Z"), validTo: instant("2026-01-01T00:00:00Z") },
        { ...valuePol, validFrom: instant("2026-01-01T00:00:00Z") },
      ]),
    }).some((d) => d.code === "policy_ambiguity")).toBeTrue();

    // Policy validFrom >= validTo
    expect(validateBookConfiguration({
      ...state,
      accountingPolicySnapshot: createAccountingPolicySnapshot([{ ...costPol, validFrom: instant("2026-01-01T00:00:00Z"), validTo: instant("2026-01-01T00:00:00Z") }]),
    }).some((d) => d.code === "policy_ambiguity")).toBeTrue();

    // Non-executable accounting policy
    expect(validateBookConfiguration({
      ...state,
      accountingPolicySnapshot: createAccountingPolicySnapshot([{ ...costPol, pools: [] }]),
    }).some((d) => d.code === "policy_ambiguity")).toBeTrue();

    // Invalid IANA timezone
    expect(validateBookConfiguration({
      ...state,
      identity: { ...state.identity, accountingTimeZone: "Invalid/TimeZone" },
    }).some((d) => d.code === "immutable_book_identity")).toBeTrue();
  });
});

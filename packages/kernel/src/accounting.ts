import {
  compareCanonicalText,
  CANONICALIZATION_VERSION,
  CONTENT_HASH_ALGORITHM,
  contentHashEquals,
  hashCanonical,
  identifier,
  type CanonicalValue,
  type ContentHash,
  type Identifier,
} from "./canonical.ts";
import {
  canonicalJournalValue,
  canonicalPostingValue,
  compareInstants,
  diagnostic,
  journalId,
  type AccountId,
  type BookId,
  type CommodityId,
  type Instant,
  type JournalId,
  type LocalDate,
  type Posting,
  type PostingId,
  type SemanticDiagnostic,
} from "./journal.ts";
import { ExactDecimal, ExactRational } from "./numeric.ts";
import type { DerivationRecord, EvidenceId, PolicyId, SemanticVersion } from "./policy.ts";
import { hashQuantizationPolicy, quantize, type QuantizationPolicy, type QuantizedValue } from "./quantization.ts";
import type { Lot, LotHolding, LotHoldingId, LotId } from "./lots.ts";
import type { BookConfigurationSnapshot, BookedJournal } from "./book.ts";

export type AccountingFeature =
  | "inventoryCost"
  | "inventoryValueAdjustment"
  | "provisionalInventory"
  | "openItemSettlement"
  | "accountingBasis"
  | "monetaryClassification"
  | "currencyRemeasurement"
  | "allocationSchedule"
  | "taxDetermination"
  | "consolidation";

export interface AccountingCapabilityCombination {
  readonly method?: string;
  readonly frequency?: string;
  readonly convention?: string;
}
export interface AccountingCapability {
  readonly feature: AccountingFeature;
  readonly status: "supported" | "experimental" | "unsupported";
  readonly implementationVersion: SemanticVersion;
  readonly verificationEvidenceIds: readonly EvidenceId[];
  readonly admittedCombinations: readonly AccountingCapabilityCombination[];
}
/** A policy is executable only when its kind-specific (method, frequency, convention) tuple is explicitly admitted. */
export function accountingCapabilityAdmits(capability: AccountingCapability, combination: AccountingCapabilityCombination): boolean {
  if (capability.admittedCombinations.length === 0) return false;
  if (combination.method === undefined && combination.frequency === undefined && combination.convention === undefined) return true;
  return capability.admittedCombinations.some((admitted) =>
    (admitted.method === undefined || combination.method === admitted.method) &&
    (admitted.frequency === undefined || combination.frequency === admitted.frequency) &&
    (admitted.convention === undefined || combination.convention === admitted.convention));
}
/** Kind-specific axes a policy declares. Kinds without an axis simply omit it. */
export function accountingPolicyCombination(policy: AccountingPolicy): AccountingCapabilityCombination {
  switch (policy.kind) {
    case "inventoryCost": return Object.freeze({ method: policy.method });
    case "allocationSchedule": return Object.freeze({ method: policy.method, frequency: policy.frequency, convention: policy.convention });
    case "accountingBasis": return Object.freeze({ method: policy.basis });
    default: return Object.freeze({});
  }
}
export interface AccountingPolicyArtifactCore {
  readonly id: PolicyId;
  readonly contentHash: ContentHash;
}
export function hashAccountingPolicyArtifact(type: string, artifact: Omit<AccountingPolicyArtifactCore, "contentHash"> & Record<string, unknown>): ContentHash {
  return accountingHash(type, artifact);
}

interface AccountingPolicyCore {
  readonly id: PolicyId;
  readonly version: SemanticVersion;
  readonly bookId: BookId;
  readonly validFrom: Instant;
  readonly validTo?: Instant;
  readonly algorithmVersion: SemanticVersion;
  readonly quantizationPolicy: QuantizationPolicy;
  readonly capability: AccountingCapability;
}

export type InventoryCostMethod = "specificIdentification" | "fifo" | "lifo" | "hifo" | "weightedAverage";
export interface InventoryPool extends AccountingPolicyArtifactCore {
  readonly accountId: AccountId;
}
export interface InventoryCostPolicy extends AccountingPolicyCore {
  readonly kind: "inventoryCost";
  readonly method: InventoryCostMethod;
  readonly pools: readonly InventoryPool[];
  readonly shortageTreatment: "reject" | "provisionalNegative";
  readonly provisionalBasisMethod?: "lastReceiptCost" | "movingAverage" | "standardCost" | "explicitRate";
  readonly provisionalRate?: ExactRational;
}

export type InventoryValueAdjustmentKind = "directlyAttributableCost" | "purchaseRebate" | "productionOverhead" | "writeDown" | "writeDownReversal";
export interface InventoryValueAdjustmentPolicy extends AccountingPolicyCore {
  readonly kind: "inventoryValueAdjustment";
  readonly inventoryCostPolicyId: PolicyId;
  readonly inventoryCostPolicyVersion: SemanticVersion;
  readonly allowedKinds: readonly InventoryValueAdjustmentKind[];
  readonly inventoryAccountId: AccountId;
  readonly recognizedCostAccountId: AccountId;
  readonly adjustmentAccountId: AccountId;
}

export interface AccountingBasisRule extends AccountingPolicyArtifactCore {
  readonly event: "recognition" | "settlement" | "creditApplication" | "writeOff" | "tax" | "inventoryCost" | "nonCash" | "rounding";
  readonly treatment: "recognizeAtAccountingDate" | "recognizeAtSettlement" | "allocateBySettlementRatio" | "carryThrough" | "exclude";
}
export interface AccountingBasisPolicy extends AccountingPolicyCore {
  readonly kind: "accountingBasis";
  readonly basis: "accrual" | "cash";
  readonly rules: readonly AccountingBasisRule[];
}

export interface CurrencyPolicy extends AccountingPolicyCore {
  readonly kind: "currencyRemeasurement";
  readonly reversalRequired: boolean;
  readonly gainAccountId: AccountId;
  readonly lossAccountId: AccountId;
}

export interface MonetaryClassificationRule extends AccountingPolicyArtifactCore {
  readonly accountId: AccountId;
  readonly classification: "monetary" | "nonMonetary";
}
export interface MonetaryClassificationPolicy extends AccountingPolicyCore {
  readonly kind: "monetaryClassification";
  readonly rules: readonly MonetaryClassificationRule[];
}

export interface AllocationPolicy extends AccountingPolicyCore {
  readonly postingAlgorithm?: "cumulative-posted-allocation-v1";
  readonly kind: "allocationSchedule";
  readonly method: "straightLine" | "decliningBalance" | "unitsOfProduction";
  readonly frequency: "monthly" | "quarterly" | "annual" | "eventDriven";
  readonly convention: "actualDays" | "fullPeriod" | "halfYear" | "midMonth" | "usageEvent";
  readonly decliningRate?: ExactRational;
  readonly expectedUsage?: ExactRational;
  readonly allocationAccountId: AccountId;
  readonly contraAccountId: AccountId;
}

export interface TaxPolicyComponent extends AccountingPolicyArtifactCore {
  readonly rate: ExactRational;
  readonly inclusion: "exclusive" | "inclusive";
  readonly treatment: "outputTax" | "inputTax" | "reverseCharge" | "withholding";
  readonly recoverability: "recoverable" | "nonRecoverable" | "partiallyRecoverable";
  readonly recoverableShare: ExactRational;
  readonly compoundOrdinal: bigint;
  readonly compoundsOn: readonly PolicyId[];
  readonly liabilityAccountId: AccountId;
  readonly recoverableAccountId?: AccountId;
  readonly nonRecoverableAccountId?: AccountId;
}
export type TaxRoundingLevel = "lineLevel" | "documentLevel";

export interface TaxPolicy extends AccountingPolicyCore {
  readonly kind: "taxDetermination";
  readonly taxCode: string;
  readonly jurisdiction: string;
  readonly roundingLevel: TaxRoundingLevel;
  readonly groupingAlgorithm?: "structural-tax-groups-v1";
  readonly components: readonly TaxPolicyComponent[];
}

export interface ConsolidationAccountMapping extends AccountingPolicyArtifactCore {
  readonly sourceBookId?: BookId;
  readonly sourceAccountId: AccountId;
  readonly targetAccountId: AccountId;
  readonly validFrom: Instant;
  readonly validTo?: Instant;
}
export interface ConsolidationValuationPolicy {
  readonly id: PolicyId;
  readonly version: SemanticVersion;
  readonly validFrom: Instant;
  readonly validTo?: Instant;
  readonly maximumHops: bigint;
  readonly allowInverseObservation: boolean;
  readonly preferDirectObservation: boolean;
}
export interface ConsolidationTranslationRule extends AccountingPolicyArtifactCore {
  readonly sourceBookId?: BookId;
  readonly sourceAccountId: AccountId;
  readonly targetAccountId: AccountId;
  readonly validFrom: Instant;
  readonly validTo?: Instant;
  readonly valuationPolicy: ConsolidationValuationPolicy;
}
export interface ConsolidationPolicy extends AccountingPolicyCore {
  readonly kind: "consolidation";
  readonly supportedMethods: readonly ("full" | "equity" | "jointOperationShare")[];
  readonly accountMappings: readonly ConsolidationAccountMapping[];
  readonly translationRules: readonly ConsolidationTranslationRule[];
  readonly valuationPolicy: ConsolidationValuationPolicy;
  readonly translationAdjustmentAccountId: AccountId;
  readonly parentAttributableEquityAccountId: AccountId;
  readonly nonControllingInterestAccountId: AccountId;
}

export type AccountingPolicy = InventoryCostPolicy | InventoryValueAdjustmentPolicy | AccountingBasisPolicy | MonetaryClassificationPolicy | CurrencyPolicy | AllocationPolicy | TaxPolicy | ConsolidationPolicy;

export interface AccountingPolicySnapshot {
  readonly policies: readonly AccountingPolicy[];
  readonly contentHash: ContentHash;
}

export type EffectKey = string & { readonly __effectKey: "EffectKey" };
export type CanonicalPostingReferenceId = Identifier<"CanonicalPostingReference">;

export interface CanonicalPostingReference {
  readonly id: CanonicalPostingReferenceId;
  readonly bookId: BookId;
  readonly journalId: JournalId;
  readonly postingId: PostingId;
  readonly effectKey: EffectKey;
  readonly postingContentHash: ContentHash;
  readonly contentHash: ContentHash;
}

export function effectKey(value: string): EffectKey {
  if (value.trim().length === 0) throw new RangeError("Effect key must not be empty");
  return value as EffectKey;
}

export function canonicalPostingReferenceId(value: string): CanonicalPostingReferenceId {
  return identifier<"CanonicalPostingReference">(value);
}

function canonicalPostingReferenceBody(
  value: Omit<CanonicalPostingReference, "contentHash">,
): CanonicalValue {
  return {
    id: value.id,
    bookId: value.bookId,
    journalId: value.journalId,
    postingId: value.postingId,
    effectKey: value.effectKey,
    postingContentHash: {
      algorithm: value.postingContentHash.algorithm,
      canonicalizationVersion: value.postingContentHash.canonicalizationVersion,
      digest: value.postingContentHash.digest,
    },
  };
}

export function createCanonicalPostingReference(
  id: CanonicalPostingReferenceId,
  bookId: BookId,
  journalId: JournalId,
  posting: Posting,
  sourceEffectKey: EffectKey,
): CanonicalPostingReference {
  const body = Object.freeze({
    id,
    bookId,
    journalId,
    postingId: posting.id,
    effectKey: sourceEffectKey,
    postingContentHash: hashCanonical(canonicalPostingValue(posting)),
  });
  return Object.freeze({ ...body, contentHash: hashCanonical(canonicalPostingReferenceBody(body)) });
}

export function validateCanonicalPostingReferenceHash(reference: CanonicalPostingReference): boolean {
  const postingHash = reference.postingContentHash;
  const contentHash = reference.contentHash;
  return postingHash.algorithm === CONTENT_HASH_ALGORITHM &&
    postingHash.canonicalizationVersion === CANONICALIZATION_VERSION &&
    contentHash.algorithm === CONTENT_HASH_ALGORITHM &&
    contentHash.canonicalizationVersion === CANONICALIZATION_VERSION &&
    contentHashEquals(contentHash, hashCanonical(canonicalPostingReferenceBody(reference)));
}

export interface ExactPreparedPosting {
  readonly id: PostingId;
  readonly accountId: AccountId;
  readonly units: ExactRational;
  readonly unitsCommodityId: CommodityId;
  readonly exactBookValue: ExactRational;
  readonly costBasis?: {
    readonly totalBasis: ExactRational;
    readonly basisCommodityId: CommodityId;
  };
}
export interface ExactPreparedJournal {
  /** A prospective schedule may require an exact pinned policy, never silent rerounding. */
  readonly requiredQuantizationPolicy?: QuantizationPolicy;
  readonly id: JournalId;
  readonly kind: "ordinary" | "adjustment" | "reversing";
  readonly economicAt: Instant;
  readonly accountingDate: LocalDate;
  readonly recordedAt: Instant;
  readonly narration: string;
  readonly postings: readonly ExactPreparedPosting[];
  readonly derivations: readonly DerivationRecord[];
}

export type ProvisionalInventoryLayerId = Identifier<"ProvisionalInventoryLayer">;
export type InventoryRecostingId = Identifier<"InventoryRecosting">;
export type InventoryValueAdjustmentId = Identifier<"InventoryValueAdjustment">;
export type OpenItemId = Identifier<"OpenItem">;
export type SettlementId = Identifier<"Settlement">;
export type SettlementAllocationId = Identifier<"SettlementAllocation">;
export type RemeasurementResultId = Identifier<"RemeasurementResult">;
export type RemeasurementReversalId = Identifier<"RemeasurementReversal">;
export type AllocationScheduleId = Identifier<"AllocationSchedule">;
export type AllocationRecognitionId = Identifier<"AllocationRecognition">;
export type AllocationScheduleRevisionId = Identifier<"AllocationScheduleRevision">;
export type TaxDeterminationId = Identifier<"TaxDetermination">;
export type ConsolidationCompilationId = Identifier<"ConsolidationCompilation">;

export const provisionalInventoryLayerId = (value: string) => identifier<"ProvisionalInventoryLayer">(value);
export const inventoryRecostingId = (value: string) => identifier<"InventoryRecosting">(value);
export const inventoryValueAdjustmentId = (value: string) => identifier<"InventoryValueAdjustment">(value);
export const openItemId = (value: string) => identifier<"OpenItem">(value);
export const settlementId = (value: string) => identifier<"Settlement">(value);
export const settlementAllocationId = (value: string) => identifier<"SettlementAllocation">(value);
export const remeasurementResultId = (value: string) => identifier<"RemeasurementResult">(value);
export const remeasurementReversalId = (value: string) => identifier<"RemeasurementReversal">(value);
export const allocationScheduleId = (value: string) => identifier<"AllocationSchedule">(value);
export const allocationRecognitionId = (value: string) => identifier<"AllocationRecognition">(value);
export const allocationScheduleRevisionId = (value: string) => identifier<"AllocationScheduleRevision">(value);
export const taxDeterminationId = (value: string) => identifier<"TaxDetermination">(value);
export const consolidationCompilationId = (value: string) => identifier<"ConsolidationCompilation">(value);

export interface InventoryLayerInput {
  readonly id: string;
  readonly accountId: AccountId;
  readonly acquiredAt: Instant;
  readonly quantity: ExactRational;
  readonly totalBasis: ExactRational;
}
export interface InventoryAllocationResult {
  readonly layerId: string;
  readonly quantity: ExactRational;
  readonly basis: ExactRational;
}
export interface ProvisionalInventoryLayer {
  readonly id: ProvisionalInventoryLayerId;
  readonly bookId: BookId;
  readonly policyId: PolicyId;
  readonly policy?: InventoryCostPolicy;
  readonly issueSource?: CanonicalPostingReference;
  /** @deprecated use issueSource */
  readonly issuePostingId?: PostingId;
  readonly openedAt: Instant;
  readonly quantity: ExactRational;
  readonly provisionalBasis: ExactRational;
  readonly derivation: DerivationRecord;
  readonly contentHash: ContentHash;
}
export interface InventoryRecostingSource {
  readonly receiptId: string;
  readonly quantity: ExactRational;
  readonly totalBasis: ExactRational;
}
export interface InventoryRecosting {
  readonly id: InventoryRecostingId;
  readonly layerId: ProvisionalInventoryLayerId;
  readonly resolvedAt: Instant;
  readonly sources: readonly InventoryRecostingSource[];
  readonly adjustment: ExactRational;
  readonly derivation: DerivationRecord;
  readonly contentHash: ContentHash;
}

export interface InventoryValueAdjustmentAllocation {
  readonly ordinal: bigint;
  readonly lotId: LotId;
  readonly holdingId?: LotHoldingId;
  readonly remainingBasisChange: ExactRational;
  readonly recognizedCostChange: ExactRational;
  readonly remainingValuationAllowanceChange: ExactRational;
}
export interface InventoryValueAdjustment {
  readonly id: InventoryValueAdjustmentId;
  readonly kind: InventoryValueAdjustmentKind;
  readonly effectiveOn: LocalDate;
  readonly generatedEffectKey: EffectKey;
  readonly bookId: BookId;
  readonly policy: InventoryValueAdjustmentPolicy;
  readonly exactSourceAmount: ExactRational;
  readonly allocations: readonly InventoryValueAdjustmentAllocation[];
  readonly bookedAdjustment: QuantizedValue;
  readonly evidence: DerivationRecord["evidence"];
  readonly derivation: DerivationRecord;
  readonly contentHash: ContentHash;
}

export interface SettlementScope {
  readonly externalPartyId: string;
  readonly controlAccountId: AccountId;
}
export interface OpenItem {
  readonly id: OpenItemId;
  readonly bookId: BookId;
  readonly kind: "receivable" | "payable" | "credit";
  readonly scope: SettlementScope;
  readonly recognitionSource?: CanonicalPostingReference;
  /** @deprecated use recognitionSource */
  readonly recognitionPostingId?: PostingId;
  readonly recognizedOn: LocalDate;
  readonly denominationCommodityId: CommodityId;
  readonly denomination: ExactRational;
  readonly bookValue: ExactRational;
  readonly derivation: DerivationRecord;
  readonly contentHash: ContentHash;
}
export interface Settlement {
  readonly id: SettlementId;
  readonly bookId: BookId;
  readonly kind: "cash" | "creditApplication" | "writeOff";
  readonly scope: SettlementScope;
  readonly settlementSource?: CanonicalPostingReference;
  /** @deprecated use settlementSource */
  readonly settlementPostingId?: PostingId;
  readonly settledAt: Instant;
  readonly denominationCommodityId: CommodityId;
  readonly denomination: ExactRational;
  readonly bookValue: ExactRational;
  readonly derivation: DerivationRecord;
  readonly contentHash: ContentHash;
}
export interface SettlementAllocation {
  readonly id: SettlementAllocationId;
  readonly openItemId: OpenItemId;
  readonly settlementId: SettlementId;
  /** Present for explicit later applications; absent in frozen legacy edges. */
  readonly appliedAt?: Instant;
  readonly allocatedBookValue: ExactRational;
  readonly allocatedOpenQuantity: ExactRational;
  readonly allocatedSettlementQuantity: ExactRational;
  readonly allocatedOpenItemBookValue?: ExactRational;
  readonly allocatedSettlementBookValue?: ExactRational;
  readonly settlementMeasurement?: QuantizedValue;
  readonly realizedExchangeDifference?: QuantizedValue;
  readonly valuationPath?: {
    readonly fromCommodityId: CommodityId;
    readonly toCommodityId: CommodityId;
    readonly effectiveAt: Instant;
    readonly observedAt: Instant;
    readonly rate: ExactRational;
    readonly evidenceIds: readonly EvidenceId[];
  };
  readonly realizedExchangeEffectKey?: EffectKey;
  readonly derivation: DerivationRecord;
  readonly contentHash: ContentHash;
}

export interface RemeasurementResult {
  readonly id: RemeasurementResultId;
  readonly kind: "realized" | "unrealized";
  readonly sourcePostingId?: PostingId;
  readonly source?: CanonicalPostingReference;
  readonly positionAccountId?: AccountId;
  readonly denominationCommodityId?: CommodityId;
  readonly effectiveOn: LocalDate;
  readonly adjustmentEffectKey?: EffectKey;
  readonly carryingBookValue: ExactRational;
  readonly measuredBookValue: ExactRational;
  readonly difference: ExactRational;
  readonly valuationRate: ExactRational;
  readonly policyId: PolicyId;
  readonly policy?: CurrencyPolicy;
  readonly classificationPolicy?: MonetaryClassificationPolicy;
  readonly valuationPath?: CurrencyRemeasurementRequest["valuationPath"];
  readonly derivation: DerivationRecord;
  readonly contentHash: ContentHash;
}

export interface RemeasurementReversal {
  readonly id: RemeasurementReversalId;
  readonly originalResultId: RemeasurementResultId;
  readonly originalJournalId?: JournalId;
  readonly originalEffectKey?: EffectKey;
  readonly reversedOn: LocalDate;
  readonly derivation: DerivationRecord;
  readonly contentHash: ContentHash;
}

export interface ScheduledAllocation {
  readonly ordinal: bigint;
  readonly accountingDate: LocalDate;
  readonly amount: ExactRational;
}

/** Prospective arithmetic only: this plan does not admit a command, select a
 * policy, authenticate posted source amounts, or change legacy schedules. */
export interface AllocationPostingPlan {
  readonly algorithmVersion: "cumulative-posted-allocation-v1";
  readonly exactSourceBasis: ExactRational;
  readonly exactResidualValue: ExactRational;
  readonly postedSourceBasis: ExactDecimal;
  readonly residualQuantization: QuantizedValue;
  readonly quantizationPolicy: QuantizationPolicy;
  readonly installments: readonly {
    readonly ordinal: bigint;
    readonly accountingDate: LocalDate;
    readonly exactAmount: ExactRational;
    readonly cumulativeTarget: ExactRational;
    readonly cumulativeQuantization: QuantizedValue;
    readonly postedAmount: ExactDecimal;
    readonly exactToPostedDifference: ExactRational;
  }[];
  readonly contentHash: ContentHash;
}

/** Allocate the posted allocable basis in the exact schedule's proportions.
 * Differencing quantized cumulative targets telescopes to the exact posted
 * endpoint. Each ordinal's amount is fixed at planning time, never by recognition
 * arrival order. Independent rounding of each installment does not have this
 * conservation property. Callers must authenticate the source and pinned policy. */
export function planAllocationPostings(input: {
  readonly exactSourceBasis: ExactRational;
  readonly exactResidualValue: ExactRational;
  readonly postedSourceBasis: ExactDecimal;
  readonly quantizationPolicy: QuantizationPolicy;
  readonly installments: readonly ScheduledAllocation[];
}): { readonly disposition: "planned"; readonly plan: AllocationPostingPlan } | { readonly disposition: "rejected"; readonly diagnostics: readonly SemanticDiagnostic[] } {
  const policy = immutableAccountingValue(input.quantizationPolicy);
  const residualQuantization = quantize(input.exactResidualValue, policy);
  const postedBasis = input.postedSourceBasis.toRational();
  const exactAllocable = input.exactSourceBasis.subtract(input.exactResidualValue);
  const postedAllocable = postedBasis.subtract(residualQuantization.amount.toRational());
  if (input.installments.length === 0 || input.installments.length > ACCOUNTING_LIMITS.maxScheduleInstallments ||
    input.exactSourceBasis.isNegative() || input.exactResidualValue.isNegative() || exactAllocable.isNegative() ||
    postedBasis.isNegative() || postedAllocable.isNegative() || !quantize(postedBasis, policy).residual.isZero() ||
    input.installments.some((item, index) => item.ordinal !== BigInt(index + 1) || item.amount.isNegative() || (index > 0 && item.accountingDate <= input.installments[index - 1]!.accountingDate)) ||
    !sum(input.installments.map((item) => item.amount)).equals(exactAllocable) ||
    (exactAllocable.isZero() && !postedAllocable.isZero())) {
    return Object.freeze({ disposition: "rejected", diagnostics: Object.freeze([diagnostic(
      "allocation_schedule_violation", "schedule.postingPlan",
      "A bounded ordered exact schedule, nonnegative conserving bases, and representable posted carrying basis are required; a zero exact schedule with a posted remainder requires explicit settlement",
      ["ACC-044.3", "ACC-044.4", "ACC-044.6"],
    )]) });
  }
  let cumulativeExact = ExactRational.zero();
  let previousPostedCoefficient = 0n;
  const installments = input.installments.map((item) => {
    cumulativeExact = cumulativeExact.add(item.amount);
    const cumulativeTarget = exactAllocable.isZero() ? ExactRational.zero() : postedAllocable.multiply(cumulativeExact).divide(exactAllocable);
    const cumulativeQuantization = quantize(cumulativeTarget, policy);
    const postedAmount = ExactDecimal.of(cumulativeQuantization.amount.coefficient - previousPostedCoefficient, policy.targetScale);
    previousPostedCoefficient = cumulativeQuantization.amount.coefficient;
    return Object.freeze({ ordinal: item.ordinal, accountingDate: item.accountingDate, exactAmount: item.amount,
      cumulativeTarget, cumulativeQuantization, postedAmount, exactToPostedDifference: item.amount.subtract(postedAmount.toRational()) });
  });
  const body = Object.freeze({ algorithmVersion: "cumulative-posted-allocation-v1" as const,
    exactSourceBasis: input.exactSourceBasis, exactResidualValue: input.exactResidualValue,
    postedSourceBasis: input.postedSourceBasis, residualQuantization, quantizationPolicy: policy, installments: Object.freeze(installments) });
  return Object.freeze({ disposition: "planned", plan: Object.freeze({ ...body, contentHash: accountingHash("AllocationPostingPlan", body) }) });
}

export interface AllocationSchedule {
  readonly id: AllocationScheduleId;
  readonly bookId: BookId;
  readonly policyId: PolicyId;
  readonly policy: AllocationPolicy;
  readonly source?: CanonicalPostingReference;
  /** @deprecated use source */
  readonly sourcePostingId?: PostingId;
  readonly sourceBasis: ExactRational;
  readonly residualValue: ExactRational;
  readonly installments: readonly ScheduledAllocation[];
  readonly postingPlan?: AllocationPostingPlan;
  readonly derivation: DerivationRecord;
  readonly contentHash: ContentHash;
}
export interface AllocationRecognition {
  readonly id: AllocationRecognitionId;
  readonly scheduleId: AllocationScheduleId;
  readonly ordinal: bigint;
  readonly derivation: DerivationRecord;
  readonly contentHash: ContentHash;
}
export type AllocationScheduleChangeKind = "estimateChange" | "impairment" | "disposal" | "termination";
export interface AllocationScheduleRevision {
  readonly id: AllocationScheduleRevisionId;
  readonly kind: AllocationScheduleChangeKind;
  readonly effectiveOn: LocalDate;
  readonly generatedEffectKey?: EffectKey;
  readonly originalScheduleId: AllocationScheduleId;
  readonly priorRecognitionIds: readonly AllocationRecognitionId[];
  readonly recognizedToDate: ExactRational;
  readonly carryingAmountAtRevision: ExactRational;
  readonly postedRecognizedToDate?: ExactRational;
  readonly postedCarryingAmountAtRevision?: ExactRational;
  readonly revisedResidualValue: ExactRational;
  readonly exactAdjustmentAmount?: ExactRational;
  readonly bookedAdjustment?: QuantizedValue;
  readonly successorScheduleId?: AllocationScheduleId;
  readonly policy: AllocationPolicy;
  readonly evidence: DerivationRecord["evidence"];
  readonly derivation: DerivationRecord;
  readonly contentHash: ContentHash;
}

export interface TaxComponentResult {
  readonly policyId: PolicyId;
  readonly exactTax: ExactRational;
  readonly quantization: QuantizedValue;
  readonly recoverable: ExactRational;
  readonly nonRecoverable: ExactRational;
}
export type TaxDirection = "purchase" | "sale" | "purchaseCredit" | "saleCredit";

export interface TaxLineResult { readonly lineId: string; readonly policyId: PolicyId; readonly exclusiveBasis: ExactRational; readonly components: readonly TaxComponentResult[] }
export interface TaxDetermination {
  readonly id: TaxDeterminationId;
  readonly bookId: BookId;
  readonly taxPoint: Instant;
  readonly sourceTransactionId: JournalId;
  readonly direction: TaxDirection;
  readonly lines: readonly TaxLineResult[];
  readonly derivation: DerivationRecord;
  readonly contentHash: ContentHash;
}

export interface ConsolidationCompilation {
  readonly id: ConsolidationCompilationId;
  readonly bookId: BookId;
  readonly policyId: PolicyId;
  readonly throughOn: LocalDate;
  readonly sourcePopulationHashes: readonly ContentHash[];
  readonly derivation: DerivationRecord;
  readonly contentHash: ContentHash;
}

export interface AccountingCanonicalState {
  readonly provisionalInventoryLayers: readonly ProvisionalInventoryLayer[];
  readonly inventoryRecostings: readonly InventoryRecosting[];
  readonly inventoryValueAdjustments: readonly InventoryValueAdjustment[];
  readonly openItems: readonly OpenItem[];
  readonly settlements: readonly Settlement[];
  readonly settlementAllocations: readonly SettlementAllocation[];
  readonly remeasurementResults: readonly RemeasurementResult[];
  readonly remeasurementReversals: readonly RemeasurementReversal[];
  readonly allocationSchedules: readonly AllocationSchedule[];
  readonly allocationRecognitions: readonly AllocationRecognition[];
  readonly allocationScheduleRevisions: readonly AllocationScheduleRevision[];
  readonly taxDeterminations: readonly TaxDetermination[];
  readonly consolidationCompilations: readonly ConsolidationCompilation[];
}

export type AccountingEffect =
  | { readonly type: "provisionalInventoryLayer"; readonly value: ProvisionalInventoryLayer }
  | { readonly type: "inventoryRecosting"; readonly value: InventoryRecosting }
  | { readonly type: "inventoryValueAdjustment"; readonly value: InventoryValueAdjustment }
  | { readonly type: "openItem"; readonly value: OpenItem }
  | { readonly type: "settlement"; readonly value: Settlement }
  | { readonly type: "settlementAllocation"; readonly value: SettlementAllocation }
  | { readonly type: "remeasurementResult"; readonly value: RemeasurementResult }
  | { readonly type: "remeasurementReversal"; readonly value: RemeasurementReversal }
  | { readonly type: "allocationSchedule"; readonly value: AllocationSchedule }
  | { readonly type: "allocationRecognition"; readonly value: AllocationRecognition }
  | { readonly type: "allocationScheduleRevision"; readonly value: AllocationScheduleRevision }
  | { readonly type: "taxDetermination"; readonly value: TaxDetermination }
  | { readonly type: "consolidationCompilation"; readonly value: ConsolidationCompilation };

export interface AccountingDraft {
  readonly journals: readonly ExactPreparedJournal[];
  readonly effects: readonly AccountingEffect[];
}
export type AccountingCalculation =
  | { readonly disposition: "draft"; readonly draft: AccountingDraft }
  | { readonly disposition: "rejected"; readonly diagnostics: readonly SemanticDiagnostic[] };

const zero = ExactRational.zero();
const sum = (values: readonly ExactRational[]) => values.reduce((total, value) => total.add(value), zero);
const positive = (value: ExactRational) => value.compare(zero) > 0;
const hashValue = (hash: ContentHash): CanonicalValue => ({ algorithm: hash.algorithm, canonicalizationVersion: hash.canonicalizationVersion, digest: hash.digest });
const rationalValue = (value: ExactRational): CanonicalValue => ({ numerator: value.numerator, denominator: value.denominator });

function canonicalize(value: unknown): CanonicalValue {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "bigint") return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ExactRational) return rationalValue(value);
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const result: Record<string, CanonicalValue> = {};
    for (const [key, member] of Object.entries(value)) {
      if (member !== undefined) result[key] = canonicalize(member);
    }
    return result;
  }
  throw new TypeError(`Unsupported accounting canonical value: ${typeof value}`);
}

export function canonicalAccountingValue(value: unknown): CanonicalValue {
  return canonicalize(value);
}

export function immutableAccountingValue<T>(value: T): T {
  if (value === null || typeof value !== "object" || value instanceof ExactRational || value instanceof ExactDecimal || value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(immutableAccountingValue)) as T;
  const result = Object.fromEntries(Object.entries(value).map(([key, member]) => [key, immutableAccountingValue(member)]));
  return Object.freeze(result) as T;
}

function accountingHash(type: string, body: unknown): ContentHash {
  return hashCanonical({ type, value: canonicalize(body) });
}

/** Hard resource bounds. Every collection a single command can traverse is capped and fails closed. */
export const ACCOUNTING_LIMITS: Readonly<{ readonly maxTaxLines: number; readonly maxScheduleInstallments: number; readonly maxUsageEvents: number; readonly maxConsolidationSources: number; readonly maxConsolidationBalancesPerSource: number; readonly maxConsolidationEliminations: number; readonly maxSettlementAllocations: number; readonly maxInventoryLayers: number; readonly maxRecostingSources: number; readonly maxBasisEvents: number }> = Object.freeze({
  maxTaxLines: 100,
  maxScheduleInstallments: 1200,
  maxUsageEvents: 1200,
  maxConsolidationSources: 1000,
  maxConsolidationBalancesPerSource: 10000,
  maxConsolidationEliminations: 10000,
  maxSettlementAllocations: 10000,
  maxInventoryLayers: 10000,
  maxRecostingSources: 10000,
  maxBasisEvents: 10000,
});

function artifactHashValid(type: string, artifact: AccountingPolicyArtifactCore): boolean {
  const { contentHash, ...body } = artifact as AccountingPolicyArtifactCore & Record<string, unknown>;
  return artifactHashValidDigest(type, body as Record<string, unknown>, contentHash);
}
function artifactHashValidDigest(type: string, body: Record<string, unknown>, contentHash: ContentHash): boolean {
  const recomputed = artifactHashDigest(type, body);
  return recomputed.algorithm === contentHash.algorithm && recomputed.canonicalizationVersion === contentHash.canonicalizationVersion && recomputed.digest === contentHash.digest;
}
function artifactHashDigest(type: string, body: Record<string, unknown>): ContentHash {
  return accountingHash(type, body);
}
/** Verifies every nested policy artifact carries its modeled identity and a reproducible content hash. */
export function verifyAccountingPolicyArtifacts(policies: readonly AccountingPolicy[]): boolean {
  for (const policy of policies) {
    switch (policy.kind) {
      case "inventoryCost":
        if (!policy.pools.every((pool) => artifactHashValid("InventoryPool", pool))) return false;
        break;
      case "accountingBasis":
        if (!policy.rules.every((rule) => artifactHashValid("AccountingBasisRule", rule))) return false;
        break;
      case "monetaryClassification":
        if (!policy.rules.every((rule) => artifactHashValid("MonetaryClassificationRule", rule))) return false;
        break;
      case "taxDetermination":
        if (!policy.components.every((component) => artifactHashValid("TaxPolicyComponent", component))) return false;
        break;
      case "consolidation":
        if (!policy.accountMappings.every((mapping) => artifactHashValid("ConsolidationAccountMapping", mapping))) return false;
        if (!policy.translationRules.every((rule) => artifactHashValid("ConsolidationTranslationRule", rule))) return false;
        break;
      case "currencyRemeasurement":
      case "inventoryValueAdjustment":
      case "allocationSchedule":
        break;
    }
  }
  return true;
}

export function hashAccountingPolicySnapshot(policies: readonly AccountingPolicy[]): ContentHash {
  return hashCanonical({
    type: "AccountingPolicySnapshot",
    policyHashes: [...policies]
      .sort((a, b) => compareCanonicalText(`${a.kind}:${a.id}:${a.version}`, `${b.kind}:${b.id}:${b.version}`))
      .map((policy) => hashValue(hashAccountingPolicy(policy))),
  });
}

/** The individual policy hash already used inside AccountingPolicySnapshot. */
export function hashAccountingPolicy(policy: AccountingPolicy): ContentHash {
  return accountingHash(policy.kind, policy);
}

export function createAccountingPolicySnapshot(policies: readonly AccountingPolicy[]): AccountingPolicySnapshot {
  const frozen = immutableAccountingValue(policies);
  if (!verifyAccountingPolicyArtifacts(frozen)) throw new TypeError("Accounting policy artifacts must carry reproducible content hashes");
  return Object.freeze({ policies: frozen, contentHash: hashAccountingPolicySnapshot(frozen) });
}

export function emptyAccountingCanonicalState(): AccountingCanonicalState {
  return Object.freeze({
    provisionalInventoryLayers: Object.freeze([]), inventoryRecostings: Object.freeze([]), inventoryValueAdjustments: Object.freeze([]),
    openItems: Object.freeze([]), settlements: Object.freeze([]), settlementAllocations: Object.freeze([]),
    remeasurementResults: Object.freeze([]), remeasurementReversals: Object.freeze([]), allocationSchedules: Object.freeze([]),
    allocationRecognitions: Object.freeze([]), allocationScheduleRevisions: Object.freeze([]), taxDeterminations: Object.freeze([]),
    consolidationCompilations: Object.freeze([]),
  });
}

export function applyAccountingEffect(state: AccountingCanonicalState, effect: AccountingEffect): AccountingCanonicalState {
  switch (effect.type) {
    case "provisionalInventoryLayer": return Object.freeze({ ...state, provisionalInventoryLayers: Object.freeze([...state.provisionalInventoryLayers, effect.value]) });
    case "inventoryRecosting": return Object.freeze({ ...state, inventoryRecostings: Object.freeze([...state.inventoryRecostings, effect.value]) });
    case "inventoryValueAdjustment": return Object.freeze({ ...state, inventoryValueAdjustments: Object.freeze([...state.inventoryValueAdjustments, effect.value]) });
    case "openItem": return Object.freeze({ ...state, openItems: Object.freeze([...state.openItems, effect.value]) });
    case "settlement": return Object.freeze({ ...state, settlements: Object.freeze([...state.settlements, effect.value]) });
    case "settlementAllocation": return Object.freeze({ ...state, settlementAllocations: Object.freeze([...state.settlementAllocations, effect.value]) });
    case "remeasurementResult": return Object.freeze({ ...state, remeasurementResults: Object.freeze([...state.remeasurementResults, effect.value]) });
    case "remeasurementReversal": return Object.freeze({ ...state, remeasurementReversals: Object.freeze([...state.remeasurementReversals, effect.value]) });
    case "allocationSchedule": return Object.freeze({ ...state, allocationSchedules: Object.freeze([...state.allocationSchedules, effect.value]) });
    case "allocationRecognition": return Object.freeze({ ...state, allocationRecognitions: Object.freeze([...state.allocationRecognitions, effect.value]) });
    case "allocationScheduleRevision": return Object.freeze({ ...state, allocationScheduleRevisions: Object.freeze([...state.allocationScheduleRevisions, effect.value]) });
    case "taxDetermination": return Object.freeze({ ...state, taxDeterminations: Object.freeze([...state.taxDeterminations, effect.value]) });
    case "consolidationCompilation": return Object.freeze({ ...state, consolidationCompilations: Object.freeze([...state.consolidationCompilations, effect.value]) });
  }
}

function reject(code: Parameters<typeof diagnostic>[0], path: string, message: string, requirements: readonly string[]): AccountingCalculation {
  return Object.freeze({ disposition: "rejected", diagnostics: Object.freeze([diagnostic(code, path, message, requirements)]) });
}

function drafted(journals: readonly ExactPreparedJournal[], effects: readonly AccountingEffect[]): AccountingCalculation {
  return immutableAccountingValue({ disposition: "draft", draft: { journals, effects } });
}

export function validAccountingDerivation(derivation: DerivationRecord): boolean {
  return derivation.state === "approved" && derivation.evidence.length > 0 && Number.isFinite(Date.parse(derivation.recordedAt));
}

export type ExternalAccountingAuthorityAttempt = "journalFactory" | "policySelection" | "bookOrderAssignment" | "commitIntentFactory" | "directPersistence";

export function rejectExternalAccountingAuthority(attempt: ExternalAccountingAuthorityAttempt): readonly SemanticDiagnostic[] {
  const requirements: Readonly<Record<ExternalAccountingAuthorityAttempt, readonly string[]>> = {
    journalFactory: ["ACC-047.1", "ACC-047.5"],
    policySelection: ["ACC-047.5"],
    bookOrderAssignment: ["ACC-047.3", "ACC-047.5"],
    commitIntentFactory: ["ACC-047.2"],
    directPersistence: ["ACC-047.4"],
  };
  return Object.freeze([diagnostic("external_accounting_authority", `external.${attempt}`, "External workflows may submit evidence and typed commands, but may not exercise canonical accounting authority", requirements[attempt])]);
}

export const INVENTORY_VALUE_ADJUSTMENT_ALGORITHM_VERSION = "1.0.2" as SemanticVersion;

export function supportsInventoryValueAdjustmentAlgorithm(version: SemanticVersion): boolean {
  return version === "1.0.0" || version === "1.0.1" || version === INVENTORY_VALUE_ADJUSTMENT_ALGORITHM_VERSION;
}

/** Optional marker was not accepted by the legacy policy codec. Its presence,
 * not a formerly unconstrained version number alone, selects new semantics. */
export function usesStructuralTaxGrouping(policy: TaxPolicy): boolean {
  return policy.groupingAlgorithm === "structural-tax-groups-v1" && policy.algorithmVersion === "1.1.0";
}

function policyAt<T extends AccountingPolicy>(policies: readonly AccountingPolicy[], kind: T["kind"], id: PolicyId, version: SemanticVersion, at: Instant): T | readonly SemanticDiagnostic[] {
  const matches = policies.filter((policy): policy is T => policy.kind === kind && policy.id === id && policy.version === version && compareInstants(policy.validFrom, at) <= 0 && (policy.validTo === undefined || compareInstants(at, policy.validTo) < 0));
  const selected = matches[0];
  if (matches.length !== 1 || selected === undefined || selected.capability.feature !== kind || selected.capability.status !== "supported" || selected.capability.implementationVersion !== selected.algorithmVersion || selected.capability.verificationEvidenceIds.length === 0 || !accountingCapabilityAdmits(selected.capability, accountingPolicyCombination(selected)) || (selected.kind === "inventoryValueAdjustment" && !supportsInventoryValueAdjustmentAlgorithm(selected.algorithmVersion)) || (selected.kind === "allocationSchedule" && selected.postingAlgorithm !== undefined && !usesCumulativeAllocation(selected))) {
    return Object.freeze([diagnostic(kind === "inventoryCost" ? "inventory_cost_policy_incoherent" : "unresolved_accounting_input", "command.policy", "Exactly one applicable policy with matching executable capability evidence is required", ["ACC-039.1", "ACC-047.5"])]);
  }
  return selected;
}

export interface InventoryCostRequest {
  readonly policyId: PolicyId;
  readonly policyVersion: SemanticVersion;
  readonly governedAt: Instant;
  readonly quantity: ExactRational;
  readonly layers: readonly InventoryLayerInput[];
  readonly specificLayerIds?: readonly string[];
}

export function createProvisionalInventoryLayerEffect(value: Omit<ProvisionalInventoryLayer, "contentHash">): Extract<AccountingEffect, { readonly type: "provisionalInventoryLayer" }> {
  return immutableAccountingValue({ type: "provisionalInventoryLayer", value: { ...value, contentHash: accountingHash("ProvisionalInventoryLayer", value) } });
}
export type InventoryCostCalculation =
  | { readonly disposition: "costed"; readonly allocations: readonly InventoryAllocationResult[]; readonly ordinaryBasis: ExactRational; readonly provisionalQuantity: ExactRational; readonly provisionalBasis: ExactRational }
  | { readonly disposition: "rejected"; readonly diagnostics: readonly SemanticDiagnostic[] };

export function calculateInventoryCost(policies: readonly AccountingPolicy[], bookId: BookId, request: InventoryCostRequest): InventoryCostCalculation {
  const selected = policyAt<InventoryCostPolicy>(policies, "inventoryCost", request.policyId, request.policyVersion, request.governedAt);
  if (Array.isArray(selected)) return Object.freeze({ disposition: "rejected", diagnostics: selected });
  const policy = selected as InventoryCostPolicy;
  if (
    policy.bookId !== bookId || policy.pools.length === 0 || new Set(policy.pools.map((pool) => pool.id)).size !== policy.pools.length ||
    request.layers.length > ACCOUNTING_LIMITS.maxInventoryLayers ||
    new Set(policy.pools.map((pool) => pool.accountId)).size !== policy.pools.length ||
    new Set(request.layers.map((layer) => layer.id)).size !== request.layers.length ||
    !positive(request.quantity) ||
    request.layers.some((layer) => !positive(layer.quantity) || layer.totalBasis.isNegative() || !policy.pools.some((pool) => pool.accountId === layer.accountId)) ||
    (policy.shortageTreatment === "reject" ? policy.provisionalBasisMethod !== undefined || policy.provisionalRate !== undefined : policy.provisionalBasisMethod === undefined) ||
    ((policy.provisionalBasisMethod === "standardCost" || policy.provisionalBasisMethod === "explicitRate") && (policy.provisionalRate === undefined || !positive(policy.provisionalRate)))
  ) {
    return Object.freeze({ disposition: "rejected", diagnostics: Object.freeze([diagnostic("inventory_cost_policy_incoherent", "command.inventory", "Inventory pool, quantity, and basis must be complete and coherent", ["ACC-039.2", "ACC-039.4", "ACC-039.5"])]) });
  }
  let ordered = [...request.layers];
  if (policy.method === "specificIdentification") {
    const ids = request.specificLayerIds ?? [];
    ordered = ids.map((id) => request.layers.find((layer) => layer.id === id)).filter((layer): layer is InventoryLayerInput => layer !== undefined);
    if (new Set(ids).size !== ids.length || ordered.length !== ids.length) return Object.freeze({ disposition: "rejected", diagnostics: Object.freeze([diagnostic("inventory_cost_policy_incoherent", "command.inventory.specificLayerIds", "Specific inventory selection is unresolved or duplicated", ["ACC-039.3", "ACC-039.6"])]) });
  } else if (policy.method !== "weightedAverage") {
    ordered.sort((a, b) => {
      const comparison = policy.method === "hifo" ? b.totalBasis.divide(b.quantity).compare(a.totalBasis.divide(a.quantity)) : compareCanonicalText(a.acquiredAt, b.acquiredAt);
      const directed = policy.method === "lifo" ? -comparison : comparison;
      return directed === 0 ? compareCanonicalText(a.id, b.id) : directed;
    });
  }
  const available = sum((policy.method === "specificIdentification" ? ordered : request.layers).map((layer) => layer.quantity));
  const ordinaryQuantity = request.quantity.compare(available) > 0 ? available : request.quantity; // mutation-equivalent: both operands are identical at the equality boundary
  const provisionalQuantity = request.quantity.subtract(ordinaryQuantity);
  if (!provisionalQuantity.isZero() && (policy.shortageTreatment === "reject" || policy.provisionalBasisMethod === undefined)) {
    return Object.freeze({ disposition: "rejected", diagnostics: Object.freeze([diagnostic("provisional_inventory_violation", "command.inventory.quantity", "Inventory shortage is not authorized by a complete provisional policy", ["ACC-040.1", "ACC-040.2"])]) });
  }
  const allocations: InventoryAllocationResult[] = [];
  let remaining = ordinaryQuantity;
  if (policy.method === "weightedAverage") {
    const totalBasis = sum(request.layers.map((layer) => layer.totalBasis));
    if (!ordinaryQuantity.isZero()) {
      for (const layer of [...request.layers].sort((left, right) => compareCanonicalText(left.id, right.id))) {
        const quantity = layer.quantity.multiply(ordinaryQuantity).divide(available);
        allocations.push(Object.freeze({ layerId: layer.id, quantity, basis: totalBasis.multiply(quantity).divide(available) }));
      }
    }
  } else {
    for (const layer of ordered) {
      if (remaining.isZero()) break;
      const quantity = remaining.compare(layer.quantity) < 0 ? remaining : layer.quantity; // mutation-equivalent: both operands are identical at the equality boundary
      allocations.push(Object.freeze({ layerId: layer.id, quantity, basis: layer.totalBasis.multiply(quantity).divide(layer.quantity) }));
      remaining = remaining.subtract(quantity);
    }
  }
  const ordinaryBasis = sum(allocations.map((allocation) => allocation.basis));
  const provisionalRate = (() => {
    if (provisionalQuantity.isZero()) return zero;
    if (policy.provisionalBasisMethod === "standardCost" || policy.provisionalBasisMethod === "explicitRate") return policy.provisionalRate;
    if (policy.provisionalBasisMethod === "movingAverage") return ordinaryQuantity.isZero() ? undefined : ordinaryBasis.divide(ordinaryQuantity);
    const last = [...request.layers].sort((left, right) => left.acquiredAt === right.acquiredAt ? compareCanonicalText(left.id, right.id) : compareCanonicalText(right.acquiredAt, left.acquiredAt))[0];
    return last === undefined ? undefined : last.totalBasis.divide(last.quantity);
  })();
  if (provisionalRate === undefined || provisionalRate.isNegative() || !provisionalQuantity.isZero() && provisionalRate.isZero()) {
    return Object.freeze({ disposition: "rejected", diagnostics: Object.freeze([diagnostic("provisional_inventory_violation", "command.inventory.provisionalBasis", "The declared provisional basis method cannot resolve one positive exact rate", ["ACC-040.1", "ACC-040.2"])]) });
  }
  const provisionalBasis = provisionalQuantity.multiply(provisionalRate);
  return Object.freeze({ disposition: "costed", allocations: Object.freeze(allocations), ordinaryBasis, provisionalQuantity, provisionalBasis });
}

export interface RecostInventoryRequest {
  readonly id: InventoryRecostingId;
  readonly layerId: ProvisionalInventoryLayerId;
  readonly resolvedAt: Instant;
  readonly sources: readonly InventoryRecostingSource[];
  readonly derivation: DerivationRecord;
}
export function calculateInventoryRecosting(state: AccountingCanonicalState, request: RecostInventoryRequest): AccountingCalculation {
  const layer = state.provisionalInventoryLayers.find((candidate) => candidate.id === request.layerId);
  const priorQuantity = sum(state.inventoryRecostings.filter((item) => item.layerId === request.layerId).flatMap((item) => item.sources.map((source) => source.quantity)));
  const remaining = layer?.quantity.subtract(priorQuantity);
  const sourceQuantity = sum(request.sources.map((source) => source.quantity));
  if (layer === undefined || remaining === undefined || !validAccountingDerivation(request.derivation) || request.derivation.policyId !== layer.policyId || request.sources.length === 0 || request.sources.length > ACCOUNTING_LIMITS.maxRecostingSources || new Set(request.sources.map((source) => source.receiptId)).size !== request.sources.length || request.sources.some((source) => !positive(source.quantity) || source.totalBasis.isNegative()) || sourceQuantity.compare(remaining) > 0) {
    return reject("provisional_inventory_violation", "command.recosting", "Recosting must resolve an existing layer without quantity over-allocation", ["ACC-040.3"]);
  }
  const finalBasis = sum(request.sources.map((source) => source.totalBasis));
  const provisionalShare = layer.provisionalBasis.multiply(sourceQuantity).divide(layer.quantity);
  const value = { id: request.id, layerId: request.layerId, resolvedAt: request.resolvedAt, sources: Object.freeze([...request.sources]), adjustment: finalBasis.subtract(provisionalShare), derivation: request.derivation };
  const effect: InventoryRecosting = Object.freeze({ ...value, contentHash: accountingHash("InventoryRecosting", value) });
  return drafted([], [{ type: "inventoryRecosting", value: effect }]);
}

export interface InventoryValueAdjustmentRequest {
  readonly id: InventoryValueAdjustmentId;
  readonly kind: InventoryValueAdjustmentKind;
  readonly effectiveOn: LocalDate;
  readonly policyEffectiveAt: Instant;
  readonly policyId: PolicyId;
  readonly policyVersion: SemanticVersion;
  readonly generatedEffectKey: EffectKey;
  readonly exactSourceAmount: ExactRational;
  readonly allocations: readonly InventoryValueAdjustmentAllocation[];
  readonly evidence: DerivationRecord["evidence"];
  readonly derivation: DerivationRecord;
}

export function applyInventoryValueAdjustmentToHoldings(
  holdings: readonly LotHolding[],
  allocations: readonly InventoryValueAdjustmentAllocation[],
): readonly LotHolding[] {
  const byHolding = new Map(allocations.filter((allocation) => allocation.holdingId !== undefined).map((allocation) => [allocation.holdingId!, allocation] as const));
  return Object.freeze(holdings.map((holding) => {
    const allocation = byHolding.get(holding.id);
    if (allocation === undefined) return holding;
    const remainingTotalBasis = holding.remainingTotalBasis.add(allocation.remainingBasisChange);
    const remainingValuationAllowance = holding.remainingValuationAllowance.add(allocation.remainingValuationAllowanceChange);
    return Object.freeze({
      ...holding,
      remainingTotalBasis,
      remainingValuationAllowance,
      remainingCarryingAmount: remainingTotalBasis.add(remainingValuationAllowance),
    });
  }));
}

export function calculateInventoryValueAdjustment(
  policies: readonly AccountingPolicy[],
  bookId: BookId,
  functionalCommodityId: CommodityId,
  lots: readonly Lot[],
  holdings: readonly LotHolding[],
  request: InventoryValueAdjustmentRequest,
): AccountingCalculation {
  const selected = policyAt<InventoryValueAdjustmentPolicy>(policies, "inventoryValueAdjustment", request.policyId, request.policyVersion, request.policyEffectiveAt);
  if (Array.isArray(selected)) return Object.freeze({ disposition: "rejected", diagnostics: selected });
  const policy = selected as InventoryValueAdjustmentPolicy;
  const linkedInventoryPolicies = policies.filter((candidate): candidate is InventoryCostPolicy =>
    candidate.kind === "inventoryCost" &&
    candidate.id === policy.inventoryCostPolicyId &&
    candidate.version === policy.inventoryCostPolicyVersion &&
    compareInstants(candidate.validFrom, request.policyEffectiveAt) <= 0 &&
    (candidate.validTo === undefined || compareInstants(request.policyEffectiveAt, candidate.validTo) < 0),
  );
  const capitalizable = request.kind === "directlyAttributableCost" || request.kind === "purchaseRebate" || request.kind === "productionOverhead";
  const lotById = new Map(lots.map((lot) => [lot.id, lot] as const));
  const holdingById = new Map(holdings.map((holding) => [holding.id, holding] as const));
  const exactAllocated = sum(request.allocations.map((allocation) => allocation.remainingBasisChange.add(allocation.recognizedCostChange).add(allocation.remainingValuationAllowanceChange)));
  const linkedInventoryPolicy = linkedInventoryPolicies[0];
  const lotPopulationValid = lotById.size === lots.length && lots.every((lot) =>
    lot.bookId === bookId && positive(lot.acquisitionQuantity) && !lot.acquisitionTotalBasis.isNegative() &&
    lot.basisCommodityId === functionalCommodityId && lot.evidenceIds.length > 0,
  );
  const holdingPopulationValid = holdingById.size === holdings.length && holdings.every((holding) => {
    const lot = lotById.get(holding.lotId);
    // Preserve old decisions under their pinned algorithm. Current policies scope
    // allocation targets below, without hiding other holdings of a transferred lot.
    return lot !== undefined && holding.bookId === bookId &&
      (policy.algorithmVersion !== "1.0.0" || holding.accountId === policy.inventoryAccountId) &&
      holding.commodityId === lot.commodityId && holding.basisCommodityId === functionalCommodityId &&
      !holding.remainingQuantity.isNegative() && !holding.remainingTotalBasis.isNegative() &&
      holding.remainingValuationAllowance.compare(zero) <= 0 &&
      holding.remainingCarryingAmount.equals(holding.remainingTotalBasis.add(holding.remainingValuationAllowance)) &&
      (!holding.remainingQuantity.isZero() || holding.remainingTotalBasis.isZero() && holding.remainingValuationAllowance.isZero() && holding.remainingCarryingAmount.isZero());
  });
  const allocationSignsValid = request.allocations.every((allocation) => {
    if (capitalizable) {
      const negative = request.kind === "purchaseRebate";
      return negative
        ? allocation.remainingBasisChange.compare(zero) <= 0 && allocation.recognizedCostChange.compare(zero) <= 0 && allocation.remainingValuationAllowanceChange.isZero()
        : !allocation.remainingBasisChange.isNegative() && !allocation.recognizedCostChange.isNegative() && allocation.remainingValuationAllowanceChange.isZero();
    }
    return allocation.remainingBasisChange.isZero() && allocation.recognizedCostChange.isZero();
  });
  if (
    policy.bookId !== bookId || policy.quantizationPolicy.functionalCommodityId !== functionalCommodityId ||
    linkedInventoryPolicies.length !== 1 ||
    linkedInventoryPolicy!.bookId !== bookId ||
    linkedInventoryPolicy!.quantizationPolicy.functionalCommodityId !== functionalCommodityId ||
    !contentHashEquals(hashQuantizationPolicy(policy.quantizationPolicy), hashQuantizationPolicy(linkedInventoryPolicy!.quantizationPolicy)) ||
    !linkedInventoryPolicy!.pools.some((pool) => pool.accountId === policy.inventoryAccountId) ||
    !lotPopulationValid || !holdingPopulationValid ||
    !policy.allowedKinds.includes(request.kind) || request.allocations.length === 0 || request.allocations.length > ACCOUNTING_LIMITS.maxInventoryLayers ||
    request.evidence.length === 0 || !request.evidence.every((item) => request.derivation.evidence.some((evidence) => evidence.id === item.id)) || !validAccountingDerivation(request.derivation) ||
    request.derivation.policyId !== policy.id || request.derivation.policyVersion !== policy.version || request.exactSourceAmount.isZero() ||
    request.generatedEffectKey.trim().length === 0 ||
    !exactAllocated.equals(request.exactSourceAmount) || new Set(request.allocations.map((allocation) => allocation.ordinal.toString())).size !== request.allocations.length ||
    new Set(request.allocations.map((allocation) => policy.algorithmVersion === "1.0.2"
      ? JSON.stringify([allocation.lotId, allocation.holdingId ?? null])
      : `${allocation.lotId}:${allocation.holdingId ?? "disposed"}`)).size !== request.allocations.length ||
    request.allocations.some((allocation, index) => allocation.ordinal !== BigInt(index + 1) || !lotById.has(allocation.lotId) || (allocation.holdingId !== undefined && (holdingById.get(allocation.holdingId)?.lotId !== allocation.lotId || holdingById.get(allocation.holdingId)?.accountId !== policy.inventoryAccountId))) ||
    policy.inventoryAccountId === policy.recognizedCostAccountId || policy.inventoryAccountId === policy.adjustmentAccountId || policy.recognizedCostAccountId === policy.adjustmentAccountId
  ) return reject("inventory_value_adjustment_violation", "command.inventoryValueAdjustment", "Inventory value adjustment identity, policy, evidence, allocation population, and exact conservation must be complete", ["ACC-039.2", "ACC-039.4", "ACC-039.5"]);
  if (
    capitalizable
      ? (request.kind === "purchaseRebate" ? request.exactSourceAmount.compare(zero) >= 0 : request.exactSourceAmount.compare(zero) <= 0)
      : false
  ) return reject("inventory_value_adjustment_violation", "command.inventoryValueAdjustment.exactSourceAmount", "Direct costs and overhead must be positive; purchase rebates must be negative", ["ACC-039.5"]);
  if (!allocationSignsValid) return reject("inventory_value_adjustment_violation", "command.inventoryValueAdjustment.allocations", "Inventory value adjustment allocations must use the component sign required by their kind", ["ACC-039.4", "ACC-039.5"]);
  if (
    capitalizable
      ? request.allocations.some((allocation) => !allocation.remainingValuationAllowanceChange.isZero())
      : request.allocations.some((allocation) => !allocation.remainingBasisChange.isZero() || !allocation.recognizedCostChange.isZero())
  ) return reject("inventory_value_adjustment_violation", "command.inventoryValueAdjustment.allocations", "Historical-basis changes and valuation-allowance changes are distinct and may not be combined", ["ACC-039.4", "ACC-039.5"]);
  if (request.allocations.some((allocation) => {
    const holding = allocation.holdingId === undefined ? undefined : holdingById.get(allocation.holdingId);
    const lotHoldings = holdings.filter((candidate) => candidate.lotId === allocation.lotId);
    if (holding === undefined) {
      // A disposed lot can only receive a recognized-cost catch-up once every
      // retained holding for that lot is depleted. Historical basis and
      // remaining allowance have no live holding to update in this case.
      return lotHoldings.some((candidate) => !candidate.remainingQuantity.isZero()) ||
        !allocation.remainingBasisChange.isZero() ||
        !allocation.remainingValuationAllowanceChange.isZero();
    }
    if (holding.remainingQuantity.isZero()) return true;
    // Remaining holdings change inventory basis/allowance; disposed amounts
    // are the only amounts that may be recognized immediately in cost.
    return !allocation.recognizedCostChange.isZero();
  })) return reject("inventory_value_adjustment_violation", "command.inventoryValueAdjustment.allocations", "Each adjustment allocation must target a live holding or a fully disposed lot with the correct basis/recognition component", ["ACC-039.4", "ACC-039.5"]);
  if (request.kind === "writeDown" && request.exactSourceAmount.compare(zero) >= 0 || request.kind === "writeDownReversal" && request.exactSourceAmount.compare(zero) <= 0) {
    return reject("inventory_value_adjustment_violation", "command.inventoryValueAdjustment.exactSourceAmount", "Write-downs must reduce allowance and reversals must increase it", ["ACC-039.4", "ACC-039.5"]);
  }
  const allowanceDirectionValid = request.allocations.every((allocation) => request.kind === "writeDown"
    ? allocation.remainingValuationAllowanceChange.compare(zero) < 0
    : request.kind === "writeDownReversal"
      ? allocation.remainingValuationAllowanceChange.compare(zero) > 0
      : true);
  if (!allowanceDirectionValid) return reject("inventory_value_adjustment_violation", "command.inventoryValueAdjustment.allocations", "Write-down allocations must reduce allowance and reversals must increase it", ["ACC-039.4", "ACC-039.5"]);
  const resultingHoldings = applyInventoryValueAdjustmentToHoldings(holdings, request.allocations);
  if (resultingHoldings.some((holding) => holding.remainingTotalBasis.isNegative() || holding.remainingCarryingAmount.isNegative() || holding.remainingValuationAllowance.compare(zero) > 0)) {
    return reject("inventory_value_adjustment_violation", "command.inventoryValueAdjustment.allocations", "An adjustment may not create negative historical basis or carrying amount, or reverse beyond accumulated write-downs", ["ACC-039.4", "ACC-039.5"]);
  }
  const inventoryChange = sum(request.allocations.map((allocation) => allocation.remainingBasisChange.add(allocation.remainingValuationAllowanceChange)));
  const recognizedCostChange = sum(request.allocations.map((allocation) => allocation.recognizedCostChange));
  const postings: ExactPreparedPosting[] = [];
  if (!inventoryChange.isZero()) postings.push({ id: identifier<"Posting">(`${request.id}-inventory`), accountId: policy.inventoryAccountId, units: inventoryChange, unitsCommodityId: functionalCommodityId, exactBookValue: inventoryChange });
  if (!recognizedCostChange.isZero()) postings.push({ id: identifier<"Posting">(`${request.id}-recognized-cost`), accountId: policy.recognizedCostAccountId, units: recognizedCostChange, unitsCommodityId: functionalCommodityId, exactBookValue: recognizedCostChange });
  postings.push({ id: identifier<"Posting">(`${request.id}-adjustment`), accountId: policy.adjustmentAccountId, units: request.exactSourceAmount.negate(), unitsCommodityId: functionalCommodityId, exactBookValue: request.exactSourceAmount.negate() });
  const body = Object.freeze({
    id: request.id, kind: request.kind, effectiveOn: request.effectiveOn, generatedEffectKey: request.generatedEffectKey,
    bookId, policy, exactSourceAmount: request.exactSourceAmount, allocations: Object.freeze([...request.allocations]),
    bookedAdjustment: quantize(request.exactSourceAmount, policy.quantizationPolicy), evidence: Object.freeze([...request.evidence]), derivation: request.derivation,
  });
  const effect: InventoryValueAdjustment = Object.freeze({ ...body, contentHash: accountingHash("InventoryValueAdjustment", body) });
  const journal: ExactPreparedJournal = Object.freeze({
    id: identifier<"JournalTransaction">(`${request.id}-journal`), kind: "adjustment", economicAt: request.policyEffectiveAt,
    accountingDate: request.effectiveOn, recordedAt: request.policyEffectiveAt, narration: "Inventory value adjustment",
    postings: Object.freeze(postings.map((posting) => Object.freeze(posting))), derivations: Object.freeze([request.derivation]),
  });
  return drafted([journal], [{ type: "inventoryValueAdjustment", value: effect }]);
}

export interface OpenItemRecognitionRequest {
  readonly value: Omit<OpenItem, "contentHash">;
}
export function recognizeOpenItem(state: Pick<AccountingCanonicalState, "openItems">, request: OpenItemRecognitionRequest): AccountingCalculation {
  return calculateOpenItem(() => state.openItems.some((item) => item.id === request.value.id) ? "present" : "absent", request);
}
export function calculateOpenItem(identity: () => "present" | "absent", request: OpenItemRecognitionRequest): AccountingCalculation {
  if (!validAccountingDerivation(request.value.derivation) || !positive(request.value.bookValue.abs()) || !positive(request.value.denomination.abs()) || settlementIdentityPresent(identity())) return reject("settlement_allocation_violation", "command.openItem", "Open item must have unique identity, approved lineage, and nonzero exact values", ["ACC-041.1"]);
  const value = Object.freeze({ ...request.value, contentHash: accountingHash("OpenItem", request.value) });
  return drafted([], [{ type: "openItem", value }]);
}

interface SettlementRequestCore {
  readonly settlement: Omit<Settlement, "contentHash">;
  readonly allocations: readonly Omit<SettlementAllocation, "contentHash">[];
  /** The quantization policy is retained with the settlement calculation so realized exchange residuals are reproducible. */
  readonly quantizationPolicy?: QuantizationPolicy;
  readonly realizedExchangePolicyId?: PolicyId;
  readonly realizedExchangePolicyVersion?: SemanticVersion;
}
export type SettlementRequest = SettlementRequestCore & (
  | { readonly operation?: never; readonly appliedAt?: never }
  | { readonly operation: "recognizeUnallocated"; readonly appliedAt?: never }
  | { readonly operation: "allocateExisting"; readonly appliedAt: Instant }
);
export interface SettlementReadContext {
  openItem(id: OpenItemId): OpenItem | null;
  settlementIdentity(id: SettlementId): "present" | "absent";
  allocationIdentity(id: SettlementAllocationId): "present" | "absent";
  existingSettlement(id: SettlementId): Settlement | null;
  allocatedFromSettlement(id: SettlementId): { readonly bookValue: ExactRational; readonly quantity: ExactRational };
  /** Exact sum of all canonical prior allocations for this open item: its
   * allocated carrying value and denomination quantity, not the payment's value. */
  allocatedToOpenItem(id: OpenItemId): { readonly bookValue: ExactRational; readonly quantity: ExactRational };
}

export function settlementReadContext(state: Pick<AccountingCanonicalState, "openItems" | "settlements" | "settlementAllocations">): SettlementReadContext {
  const openItems = new Map<OpenItemId, OpenItem>();
  for (const item of state.openItems) if (!openItems.has(item.id)) openItems.set(item.id, item);
  const settlements = new Set(state.settlements.map((item) => item.id));
  const settlementFacts = new Map(state.settlements.map((item) => [item.id, item]));
  const allocationIds = new Set(state.settlementAllocations.map((item) => item.id));
  const allocated = new Map<OpenItemId, { bookValue: ExactRational; quantity: ExactRational }>();
  const paid = new Map<SettlementId, { bookValue: ExactRational; quantity: ExactRational }>();
  for (const item of state.settlementAllocations) {
    const prior = allocated.get(item.openItemId) ?? { bookValue: zero, quantity: zero };
    allocated.set(item.openItemId, {
      bookValue: prior.bookValue.add(item.allocatedOpenItemBookValue ?? item.allocatedBookValue),
      quantity: prior.quantity.add(item.allocatedOpenQuantity),
    });
    const source = paid.get(item.settlementId) ?? { bookValue: zero, quantity: zero };
    const settlement = settlementFacts.get(item.settlementId);
    const measured = item.allocatedSettlementBookValue ?? (settlement === undefined ? item.allocatedBookValue
      : settlement.bookValue.abs().multiply(item.allocatedSettlementQuantity).divide(settlement.denomination.abs()));
    paid.set(item.settlementId, { bookValue: source.bookValue.add(measured), quantity: source.quantity.add(item.allocatedSettlementQuantity) });
  }
  return {
    openItem: (id) => openItems.get(id) ?? null,
    settlementIdentity: (id) => settlements.has(id) ? "present" : "absent",
    existingSettlement: (id) => settlementFacts.get(id) ?? null,
    allocatedFromSettlement: (id) => paid.get(id) ?? { bookValue: zero, quantity: zero },
    allocationIdentity: (id) => allocationIds.has(id) ? "present" : "absent",
    allocatedToOpenItem: (id) => allocated.get(id) ?? { bookValue: zero, quantity: zero },
  };
}
function settlementIdentityPresent(observation: "present" | "absent"): boolean {
  if (observation !== "present" && observation !== "absent") throw new TypeError("Incomplete settlement identity evidence");
  return observation === "present";
}
export function applySettlement(state: AccountingCanonicalState, request: SettlementRequest): AccountingCalculation {
  return calculateSettlement(settlementReadContext(state), request);
}
/** Shared conservation calculation for full canonical history and transaction-bound
 * current projections. Unknown identity or non-exact totals are never absence. */
export function calculateSettlement(state: SettlementReadContext, request: SettlementRequest): AccountingCalculation {
  const existing = request.operation === "allocateExisting";
  const unallocated = request.operation === "recognizeUnallocated";
  if ((request.operation !== undefined && !existing && !unallocated) || (!existing && request.appliedAt !== undefined) ||
    (existing && (!Number.isFinite(Date.parse(request.appliedAt)) || compareInstants(request.appliedAt, request.settlement.settledAt) < 0)) ||
    request.allocations.some((allocation) => allocation.appliedAt !== undefined && (!existing || allocation.appliedAt !== request.appliedAt)))
    return reject("settlement_allocation_violation", "command.settlement.application", "Settlement operation and application time must be explicit and coherent", ["ACC-041.3", "ACC-041.6"]);
  if (!validAccountingDerivation(request.settlement.derivation) || settlementIdentityPresent(state.settlementIdentity(request.settlement.id)) !== existing || (unallocated ? request.allocations.length !== 0 : request.allocations.length === 0) || request.allocations.length > ACCOUNTING_LIMITS.maxSettlementAllocations || new Set(request.allocations.map((item) => item.id)).size !== request.allocations.length || request.allocations.some((item) => settlementIdentityPresent(state.allocationIdentity(item.id))) || !positive(request.settlement.denomination.abs()) || !positive(request.settlement.bookValue.abs()) || request.settlement.scope.externalPartyId.trim().length === 0) return reject("settlement_allocation_violation", "command.settlement", "Settlement identity must be unique, evidenced, and contain positive exact denomination and book value", ["ACC-041.1", "ACC-041.3"]);
  const settlement = Object.freeze({ ...request.settlement, contentHash: accountingHash("Settlement", request.settlement) });
  let previousSettlement = { bookValue: zero, quantity: zero };
  if (existing) {
    const retained = state.existingSettlement(settlement.id);
    if (retained === undefined) throw new TypeError("Incomplete retained settlement evidence");
    if (retained === null || !contentHashEquals(retained.contentHash, settlement.contentHash) || !validateAccountingEffectHash({ type: "settlement", value: retained }))
      return reject("settlement_allocation_violation", "command.settlement", "Later allocation must retain the exact original settlement", ["ACC-041.1", "ACC-041.4"]);
    previousSettlement = state.allocatedFromSettlement(settlement.id);
    if (!(previousSettlement?.bookValue instanceof ExactRational) || !(previousSettlement.quantity instanceof ExactRational) || previousSettlement.bookValue.isNegative() || previousSettlement.quantity.isNegative())
      throw new TypeError("Incomplete prior settlement allocation totals");
  }
  const pendingByOpenItem = new Map<OpenItemId, ExactRational>();
  const pendingOpenQuantity = new Map<OpenItemId, ExactRational>();
  let pendingSettlementQuantity = previousSettlement.quantity;
  for (const allocation of request.allocations) {
    const open = state.openItem(allocation.openItemId);
    if (open === undefined) throw new TypeError("Incomplete open-item evidence");
    const prior = state.allocatedToOpenItem(allocation.openItemId);
    if (!(prior?.bookValue instanceof ExactRational) || !(prior.quantity instanceof ExactRational) || prior.bookValue.isNegative() || prior.quantity.isNegative())
      throw new TypeError("Incomplete settlement totals evidence");
    const pending = pendingByOpenItem.get(allocation.openItemId) ?? zero;
    const priorOpenQuantity = prior.quantity;
    const pendingQuantity = pendingOpenQuantity.get(allocation.openItemId) ?? zero;
    if (existing && open !== null && open.recognizedOn > request.appliedAt.slice(0, 10))
      return reject("settlement_allocation_violation", "command.settlement.application", "Allocation cannot precede its open-item recognition", ["ACC-041.3", "ACC-041.6"]);
    if (open === null || allocation.settlementId !== settlement.id || !validAccountingDerivation(allocation.derivation) || open.bookId !== settlement.bookId || open.scope.externalPartyId !== settlement.scope.externalPartyId || open.scope.controlAccountId !== settlement.scope.controlAccountId || !positive(allocation.allocatedBookValue) || !positive(allocation.allocatedOpenQuantity) || !positive(allocation.allocatedSettlementQuantity) || (allocation.allocatedOpenItemBookValue !== undefined && !allocation.allocatedOpenItemBookValue.equals(allocation.allocatedBookValue)) || prior.bookValue.add(pending).add(allocation.allocatedBookValue).compare(open.bookValue.abs()) > 0 || priorOpenQuantity.add(pendingQuantity).add(allocation.allocatedOpenQuantity).compare(open.denomination.abs()) > 0 || pendingSettlementQuantity.add(allocation.allocatedSettlementQuantity).compare(settlement.denomination.abs()) > 0) {
      return reject("settlement_allocation_violation", "command.settlement.allocations", "Settlement allocation violates scope or exact conservation", ["ACC-041.2", "ACC-041.4"]);
    }
    const allocatedOpenItemBookValue = allocation.allocatedOpenItemBookValue ?? allocation.allocatedBookValue;
    const allocatedSettlementQuantity = allocation.allocatedSettlementQuantity;
    const settlementShare = settlement.bookValue.abs().multiply(allocatedSettlementQuantity).divide(settlement.denomination.abs());
    const allocatedSettlementBookValue = allocation.allocatedSettlementBookValue ?? settlementShare;
    const carryingShare = open.bookValue.abs().multiply(allocation.allocatedOpenQuantity).divide(open.denomination.abs());
    const difference = allocatedSettlementBookValue.subtract(allocatedOpenItemBookValue);
    const path = allocation.valuationPath;
    const pathCoherent = open.denominationCommodityId === settlement.denominationCommodityId
      ? path === undefined
      : path !== undefined && request.quantizationPolicy !== undefined && path.fromCommodityId === settlement.denominationCommodityId && path.toCommodityId === request.quantizationPolicy.functionalCommodityId && positive(path.rate) && path.evidenceIds.length > 0 && compareInstants(path.observedAt, settlement.settledAt) <= 0 && path.effectiveAt.slice(0, 10) === settlement.settledAt.slice(0, 10) && allocatedSettlementBookValue.equals(allocatedSettlementQuantity.multiply(path.rate));
    const expectedSettlementMeasurement = request.quantizationPolicy === undefined ? undefined : quantize(allocatedSettlementBookValue, request.quantizationPolicy);
    const expectedRealizedDifference = request.quantizationPolicy === undefined || difference.isZero() ? undefined : quantize(difference, request.quantizationPolicy);
    const quantizationMatches = (actual: QuantizedValue | undefined, expected: QuantizedValue | undefined) => actual === undefined || expected !== undefined && actual.amount.toRational().equals(expected.amount.toRational()) && actual.residual.equals(expected.residual);
    if (!allocatedOpenItemBookValue.equals(carryingShare) || !allocatedSettlementBookValue.equals(settlementShare) || !positive(allocatedSettlementBookValue) || !pathCoherent || !quantizationMatches(allocation.settlementMeasurement, expectedSettlementMeasurement) || !quantizationMatches(allocation.realizedExchangeDifference, expectedRealizedDifference) || (request.quantizationPolicy === undefined && (allocation.settlementMeasurement !== undefined || allocation.realizedExchangeDifference !== undefined)) || (!difference.isZero() && allocation.realizedExchangeEffectKey === undefined) || (difference.isZero() && allocation.realizedExchangeEffectKey !== undefined)) return reject("settlement_allocation_violation", "command.settlement.allocations", "Settlement allocation must conserve each side's proportional carrying value, derive functional-currency settlement measurement through a dated valuation path, and bind any realized difference to a generated effect", ["ACC-041.2", "ACC-041.5", "ACC-041.6"]);
    pendingByOpenItem.set(allocation.openItemId, pending.add(allocatedOpenItemBookValue));
    pendingOpenQuantity.set(allocation.openItemId, pendingQuantity.add(allocation.allocatedOpenQuantity));
    pendingSettlementQuantity = pendingSettlementQuantity.add(allocation.allocatedSettlementQuantity);
  }
  if (previousSettlement.bookValue.add(sum(request.allocations.map((item) => item.allocatedSettlementBookValue ?? settlement.bookValue.abs().multiply(item.allocatedSettlementQuantity).divide(settlement.denomination.abs())))).compare(settlement.bookValue.abs()) > 0) return reject("settlement_allocation_violation", "command.settlement.allocations", "Settlement is over-allocated", ["ACC-041.4"]);
  const allocations = request.allocations.map((item) => {
    const allocatedOpenItemBookValue = item.allocatedOpenItemBookValue ?? item.allocatedBookValue;
    const allocatedSettlementQuantity = item.allocatedSettlementQuantity;
    const allocatedSettlementBookValue = item.allocatedSettlementBookValue ?? settlement.bookValue.abs().multiply(allocatedSettlementQuantity).divide(settlement.denomination.abs());
    const difference = allocatedSettlementBookValue.subtract(allocatedOpenItemBookValue);
    const settlementMeasurement = request.quantizationPolicy === undefined ? undefined : quantize(allocatedSettlementBookValue, request.quantizationPolicy);
    const realizedExchangeDifference = request.quantizationPolicy === undefined || difference.isZero() ? undefined : quantize(difference, request.quantizationPolicy);
    const body = {
      ...item,
      ...(existing ? { appliedAt: request.appliedAt } : {}),
      allocatedBookValue: allocatedOpenItemBookValue,
      allocatedOpenItemBookValue,
      allocatedSettlementBookValue,
      allocatedSettlementQuantity,
      ...(settlementMeasurement === undefined ? {} : { settlementMeasurement }),
      ...(realizedExchangeDifference === undefined ? {} : { realizedExchangeDifference }),
    };
    return Object.freeze({ ...body, contentHash: accountingHash("SettlementAllocation", body) });
  });
  return drafted([], [...(existing ? [] : [{ type: "settlement" as const, value: settlement }]), ...allocations.map((value) => ({ type: "settlementAllocation" as const, value }))]);
}

export interface BasisSourceEvent {
  readonly id: string;
  readonly event: AccountingBasisRule["event"];
  readonly accountingDate: LocalDate;
  readonly source: CanonicalPostingReference;
  readonly sourcePosting: Posting;
  readonly openItemId?: OpenItemId;
  readonly settlementId?: SettlementId;
  readonly settlementAllocationIds?: readonly SettlementAllocationId[];
}
export interface AccountingReadSnapshot {
  readonly throughBookRevision: bigint;
  readonly throughPostingSequence: bigint;
  readonly policyEffectiveAt: Instant;
  readonly bookStateHash: ContentHash;
  readonly reportPopulationHash: ContentHash;
  readonly sourcePopulationHash: ContentHash;
  readonly configurationSnapshot: BookConfigurationSnapshot;
  readonly journals: readonly BookedJournal[];
  readonly accountingState: AccountingCanonicalState;
  /** Exact report population; every member must have exactly one typed source event. */
  readonly sourcePostingPopulation: readonly CanonicalPostingReference[];
  readonly sourceEvents: readonly BasisSourceEvent[];
  readonly contentHash: ContentHash;
}
export interface AccountingBasisProjectionEntry {
  readonly ordinal: bigint;
  readonly sourceId: string;
  readonly treatment: AccountingBasisRule["treatment"];
  readonly includedExactAmount: ExactRational;
  readonly excludedExactAmount: ExactRational;
  readonly recognizedAmount?: QuantizedValue;
  readonly settlementAllocationIds: readonly SettlementAllocationId[];
  /** @deprecated use includedExactAmount/recognizedAmount. */
  readonly amount: ExactRational;
}
export interface AccountingBasisReconciliation {
  readonly sourceExactTotal: ExactRational;
  readonly includedExactTotal: ExactRational;
  readonly excludedExactTotal: ExactRational;
  readonly projectedExactTotal: ExactRational;
  readonly projectedBookValueTotal: ExactRational;
  readonly quantizationResidualTotal: ExactRational;
  readonly contentHash: ContentHash;
}
export interface AccountingBasisProjection { readonly policyId: PolicyId; readonly sourcePopulationHash: ContentHash; readonly entries: readonly AccountingBasisProjectionEntry[]; readonly reconciliation: AccountingBasisReconciliation; readonly sourceSnapshot: AccountingReadSnapshot; readonly contentHash: ContentHash }
export type BasisProjectionResult = { readonly disposition: "projected"; readonly projection: AccountingBasisProjection } | { readonly disposition: "rejected"; readonly diagnostics: readonly SemanticDiagnostic[] };
export function hashAccountingBasisSourcePopulation(events: readonly BasisSourceEvent[]): ContentHash {
  return hashCanonical({
    type: "AccountingBasisSourcePopulation",
    events: [...events].sort((left, right) => compareCanonicalText(left.id, right.id)).map((event) => canonicalize(event)),
  });
}

export function hashAccountingReadSnapshot(snapshot: Omit<AccountingReadSnapshot, "contentHash"> | AccountingReadSnapshot): ContentHash {
  return accountingHash("AccountingReadSnapshot", {
    throughBookRevision: snapshot.throughBookRevision,
    throughPostingSequence: snapshot.throughPostingSequence,
    policyEffectiveAt: snapshot.policyEffectiveAt,
    bookStateHash: snapshot.bookStateHash,
    reportPopulationHash: snapshot.reportPopulationHash,
    sourcePopulationHash: snapshot.sourcePopulationHash,
    configurationSnapshot: canonicalize(snapshot.configurationSnapshot),
    journals: [...snapshot.journals].sort((left, right) => Number(left.postingSequence - right.postingSequence)).map((journal) => canonicalize(journal)),
    accountingState: canonicalAccountingStateValue(snapshot.accountingState),
    sourcePostingPopulation: [...snapshot.sourcePostingPopulation].sort((left, right) => compareCanonicalText(canonicalPostingSourceKey(left), canonicalPostingSourceKey(right))).map((source) => canonicalize(source)),
    sourceEvents: [...snapshot.sourceEvents].sort((left, right) => compareCanonicalText(left.id, right.id)),
  });
}

export function hashAccountingReadPopulation(snapshot: Omit<AccountingReadSnapshot, "contentHash" | "reportPopulationHash">): ContentHash {
  return accountingHash("AccountingReadPopulation", {
    throughBookRevision: snapshot.throughBookRevision,
    throughPostingSequence: snapshot.throughPostingSequence,
    policyEffectiveAt: snapshot.policyEffectiveAt,
    bookStateHash: snapshot.bookStateHash,
    sourcePopulationHash: snapshot.sourcePopulationHash,
    configurationSnapshot: canonicalize(snapshot.configurationSnapshot),
    journals: [...snapshot.journals].sort((left, right) => Number(left.postingSequence - right.postingSequence)).map((journal) => canonicalize(journal)),
    accountingState: canonicalAccountingStateValue(snapshot.accountingState),
    sourcePostingPopulation: [...snapshot.sourcePostingPopulation].sort((left, right) => compareCanonicalText(canonicalPostingSourceKey(left), canonicalPostingSourceKey(right))).map((source) => canonicalize(source)),
    sourceEvents: [...snapshot.sourceEvents].sort((left, right) => compareCanonicalText(left.id, right.id)),
  });
}

function canonicalPostingSourceKey(source: CanonicalPostingReference): string {
  return `${source.bookId}\u0000${source.journalId}\u0000${source.effectKey}\u0000${source.postingId}`;
}

function accountingStateHashesAreValid(state: AccountingCanonicalState): boolean {
  for (const value of state.provisionalInventoryLayers) if (!validateAccountingEffectHash({ type: "provisionalInventoryLayer", value })) return false;
  for (const value of state.inventoryRecostings) if (!validateAccountingEffectHash({ type: "inventoryRecosting", value })) return false;
  for (const value of state.inventoryValueAdjustments) if (!validateAccountingEffectHash({ type: "inventoryValueAdjustment", value })) return false;
  for (const value of state.openItems) if (!validateAccountingEffectHash({ type: "openItem", value })) return false;
  for (const value of state.settlements) if (!validateAccountingEffectHash({ type: "settlement", value })) return false;
  for (const value of state.settlementAllocations) if (!validateAccountingEffectHash({ type: "settlementAllocation", value })) return false;
  for (const value of state.remeasurementResults) if (!validateAccountingEffectHash({ type: "remeasurementResult", value })) return false;
  for (const value of state.remeasurementReversals) if (!validateAccountingEffectHash({ type: "remeasurementReversal", value })) return false;
  for (const value of state.allocationSchedules) if (!validateAccountingEffectHash({ type: "allocationSchedule", value })) return false;
  for (const value of state.allocationRecognitions) if (!validateAccountingEffectHash({ type: "allocationRecognition", value })) return false;
  for (const value of state.allocationScheduleRevisions) if (!validateAccountingEffectHash({ type: "allocationScheduleRevision", value })) return false;
  for (const value of state.taxDeterminations) if (!validateAccountingEffectHash({ type: "taxDetermination", value })) return false;
  for (const value of state.consolidationCompilations) if (!validateAccountingEffectHash({ type: "consolidationCompilation", value })) return false;
  return true;
}

export function projectAccountingBasis(
  policies: readonly AccountingPolicy[],
  policyIdValue: PolicyId,
  version: SemanticVersion,
  readSnapshot: AccountingReadSnapshot,
): BasisProjectionResult {
  const at = readSnapshot.policyEffectiveAt;
  const populationHash = readSnapshot.sourcePopulationHash;
  const events = readSnapshot.sourceEvents;
  const selected = policyAt<AccountingBasisPolicy>(policies, "accountingBasis", policyIdValue, version, at);
  if (Array.isArray(selected)) return Object.freeze({ disposition: "rejected", diagnostics: Object.freeze([diagnostic("accounting_basis_policy_incomplete", "projection.policy", "Complete basis policy is required", ["ACC-042.3"])]) });
  const policy = selected as AccountingBasisPolicy;
  if (events.length > ACCOUNTING_LIMITS.maxBasisEvents) return Object.freeze({ disposition: "rejected", diagnostics: Object.freeze([diagnostic("accounting_basis_policy_incomplete", "projection.population", "Basis projection population exceeds the executable bound", ["ACC-042.4"])]) });
  if (new Set(events.map((event) => event.id)).size !== events.length || events.some((event) => event.id.trim().length === 0 || event.settlementAllocationIds !== undefined && new Set(event.settlementAllocationIds).size !== event.settlementAllocationIds.length || "amount" in event || "settlementRatio" in event)) return Object.freeze({ disposition: "rejected", diagnostics: Object.freeze([diagnostic("accounting_basis_policy_incomplete", "projection.population", "Basis projection requires one complete pinned source population with unique source identities and no caller-computed amounts or ratios", ["ACC-042.1", "ACC-042.4", "ACC-042.5"])]) });
  {
    const expectedSnapshotHash = hashAccountingReadSnapshot(readSnapshot);
    const { contentHash: _snapshotContentHash, reportPopulationHash: _reportPopulationHash, ...populationBody } = readSnapshot;
    const expectedReportPopulationHash = hashAccountingReadPopulation(populationBody);
    const orderedJournals = [...readSnapshot.journals].sort((left, right) => Number(left.postingSequence - right.postingSequence));
    const journalPopulationValid = BigInt(orderedJournals.length) === readSnapshot.throughPostingSequence && orderedJournals.every((booked, index) =>
      booked.postingSequence === BigInt(index + 1) && booked.bookRevision <= readSnapshot.throughBookRevision && booked.journal.bookId === policy.bookId &&
      contentHashEquals(booked.canonicalHash, hashCanonical(canonicalJournalValue(booked.journal))),
    );
    const bookedBySourceKey = new Map<string, { readonly booked: BookedJournal; readonly postings: ReadonlyMap<PostingId, Posting> }>();
    let uniqueJournalSources = true;
    for (const booked of orderedJournals) {
      const key = `${booked.journal.id}\u0000${booked.effectKey}`;
      if (bookedBySourceKey.has(key)) uniqueJournalSources = false;
      bookedBySourceKey.set(key, { booked, postings: new Map(booked.journal.postings.map((posting) => [posting.id, posting])) });
    }
    const configuredPolicies = readSnapshot.configurationSnapshot.accountingPolicySnapshot.policies.filter((candidate) =>
      candidate.kind === "accountingBasis" && candidate.id === policy.id && candidate.version === policy.version,
    );
    const configuredPolicyMatches = configuredPolicies.length === 1 && contentHashEquals(hashCanonical(canonicalize(configuredPolicies[0]!)), hashCanonical(canonicalize(policy)));
    const postingReferenceCloses = (reference: CanonicalPostingReference, copiedPosting?: Posting, accountingDate?: LocalDate) => {
      if (!validateCanonicalPostingReferenceHash(reference) || reference.bookId !== policy.bookId) return false;
      const source = bookedBySourceKey.get(`${reference.journalId}\u0000${reference.effectKey}`);
      if (source === undefined || source.postings.size !== source.booked.journal.postings.length) return false;
      const posting = source.postings.get(reference.postingId);
      return posting !== undefined && (accountingDate === undefined || accountingDate === source.booked.journal.accountingDate) && contentHashEquals(hashCanonical(canonicalPostingValue(posting)), reference.postingContentHash) &&
        (copiedPosting === undefined || contentHashEquals(hashCanonical(canonicalPostingValue(copiedPosting)), reference.postingContentHash));
    };
    const populationKeys = readSnapshot.sourcePostingPopulation.map(canonicalPostingSourceKey);
    const eventSourceKeys = readSnapshot.sourceEvents.map((event) => canonicalPostingSourceKey(event.source));
    const sortedPopulationKeys = [...populationKeys].sort();
    const sortedEventSourceKeys = [...eventSourceKeys].sort();
    const completeClassification = populationKeys.length === eventSourceKeys.length && new Set(populationKeys).size === populationKeys.length && new Set(eventSourceKeys).size === eventSourceKeys.length && sortedPopulationKeys.every((key, index) => key === sortedEventSourceKeys[index]);
    const populationBySourceKey = new Map(readSnapshot.sourcePostingPopulation.map((source) => [canonicalPostingSourceKey(source), source]));
    const exactReferenceClassification = readSnapshot.sourceEvents.every((event) => {
      const populationSource = populationBySourceKey.get(canonicalPostingSourceKey(event.source));
      return populationSource !== undefined && contentHashEquals(populationSource.contentHash, event.source.contentHash);
    });
    const sourcePopulationCloses = readSnapshot.sourcePostingPopulation.every((source) => postingReferenceCloses(source)) && readSnapshot.sourceEvents.every((event) => postingReferenceCloses(event.source, event.sourcePosting, event.accountingDate));
    if (readSnapshot.throughBookRevision < 0n || readSnapshot.throughPostingSequence < 0n || !configuredPolicyMatches || !journalPopulationValid || !uniqueJournalSources || !completeClassification || !exactReferenceClassification || !sourcePopulationCloses || !accountingStateHashesAreValid(readSnapshot.accountingState) || !contentHashEqual(readSnapshot.reportPopulationHash, expectedReportPopulationHash) || !contentHashEqual(readSnapshot.sourcePopulationHash, hashAccountingBasisSourcePopulation(events)) || !contentHashEqual(readSnapshot.contentHash, expectedSnapshotHash)) return Object.freeze({ disposition: "rejected", diagnostics: Object.freeze([diagnostic("accounting_basis_policy_incomplete", "projection.readSnapshot", "Accounting-basis projection requires a complete content-hashed configuration, journal, accounting-effect, and typed source population at the requested cutoffs", ["ACC-042.1", "ACC-042.2", "ACC-042.4"])]) });
  }
  const orderedEvents = [...events].sort((left, right) => compareCanonicalText(left.id, right.id));
  for (const event of orderedEvents) {
    const posting = event.sourcePosting;
    if (!validateCanonicalPostingReferenceHash(event.source) || posting.id !== event.source.postingId || !contentHashEquals(event.source.postingContentHash, hashCanonical(canonicalPostingValue(posting))) || event.source.bookId !== policy.bookId || posting.bookValue.functionalCommodityId !== policy.quantizationPolicy.functionalCommodityId) return Object.freeze({ disposition: "rejected", diagnostics: Object.freeze([diagnostic("accounting_basis_policy_incomplete", `projection.events[${event.id}]`, "Every source event must close over its exact same-book canonical posting reference and copied posting", ["ACC-042.1", "ACC-042.2"])]) });
  }
  const entries: AccountingBasisProjectionEntry[] = [];
  let sourceExactTotal = zero;
  let includedExactTotal = zero;
  let excludedExactTotal = zero;
  let projectedBookValueTotal = zero;
  let quantizationResidualTotal = zero;
  for (const event of orderedEvents) {
    const rules = policy.rules.filter((rule) => rule.event === event.event);
    if (rules.length !== 1) return Object.freeze({ disposition: "rejected", diagnostics: Object.freeze([diagnostic("accounting_basis_policy_incomplete", "projection.events", "Every source event must resolve exactly one treatment", ["ACC-042.2", "ACC-042.3"])]) });
    const treatment = rules[0]!.treatment;
    let settlementRatio: ExactRational | undefined;
    if (treatment === "allocateBySettlementRatio") {
      const openItem = event.openItemId === undefined ? undefined : readSnapshot.accountingState.openItems.find((candidate) => candidate.id === event.openItemId);
      const allocations = event.openItemId === undefined ? [] : readSnapshot.accountingState.settlementAllocations.filter((candidate) => candidate.openItemId === event.openItemId);
      const suppliedIds = [...(event.settlementAllocationIds ?? [])].sort();
      const retainedIds = allocations.map((allocation) => allocation.id).sort();
      const allocationsClose = suppliedIds.length === retainedIds.length && suppliedIds.every((id, index) => id === retainedIds[index]) && allocations.every((allocation) => readSnapshot.accountingState.settlements.some((settlement) => settlement.id === allocation.settlementId && settlement.bookId === openItem?.bookId && settlement.scope.externalPartyId === openItem?.scope.externalPartyId && settlement.scope.controlAccountId === openItem?.scope.controlAccountId));
      // The allocation graph must belong to this source transaction, not just
      // another receivable/payable in the same book. Journal and effect identity
      // connect the invoice's revenue/tax/cost lines to its control posting.
      const recognition = openItem?.recognitionSource;
      const recognitionCloses = recognition !== undefined && validateCanonicalPostingReferenceHash(recognition) && recognition.bookId === event.source.bookId && recognition.journalId === event.source.journalId && recognition.effectKey === event.source.effectKey;
      if (openItem === undefined || openItem.bookId !== policy.bookId || !positive(openItem.bookValue.abs()) || !allocationsClose || !recognitionCloses) return Object.freeze({ disposition: "rejected", diagnostics: Object.freeze([diagnostic("accounting_basis_policy_incomplete", "projection.events", "Settlement-ratio treatment requires the source transaction's retained open item and complete content-hashed settlement-allocation graph", ["ACC-042.2", "ACC-042.3", "ACC-042.5"])]) });
      settlementRatio = sum(allocations.map((allocation) => allocation.allocatedOpenItemBookValue ?? allocation.allocatedBookValue)).divide(openItem.bookValue.abs());
      if (settlementRatio.compare(zero) < 0 || settlementRatio.compare(ExactRational.of(1n, 1n)) > 0) return Object.freeze({ disposition: "rejected", diagnostics: Object.freeze([diagnostic("accounting_basis_policy_incomplete", "projection.events", "The retained settlement graph must derive an exact ratio between zero and one", ["ACC-042.3", "ACC-042.5"])]) });
    }
    const amount = event.sourcePosting.bookValue.amount.toRational();
    const includedExactAmount = treatment === "exclude" ? zero : treatment === "allocateBySettlementRatio" ? amount.multiply(settlementRatio!) : amount;
    const excludedExactAmount = amount.subtract(includedExactAmount);
    const recognizedAmount = treatment === "exclude" ? undefined : quantize(includedExactAmount, policy.quantizationPolicy);
    sourceExactTotal = sourceExactTotal.add(amount);
    includedExactTotal = includedExactTotal.add(includedExactAmount);
    excludedExactTotal = excludedExactTotal.add(excludedExactAmount);
    if (recognizedAmount !== undefined) {
      projectedBookValueTotal = projectedBookValueTotal.add(recognizedAmount.amount.toRational());
      quantizationResidualTotal = quantizationResidualTotal.add(recognizedAmount.residual);
    }
    entries.push(Object.freeze({ ordinal: BigInt(entries.length + 1), sourceId: event.id, treatment, amount: includedExactAmount, includedExactAmount, excludedExactAmount, ...(recognizedAmount === undefined ? {} : { recognizedAmount }), settlementAllocationIds: Object.freeze([...(event.settlementAllocationIds ?? [])].sort()) }));
  }
  const projectedExactTotal = includedExactTotal;
  const reconciliationBody = { sourceExactTotal, includedExactTotal, excludedExactTotal, projectedExactTotal, projectedBookValueTotal, quantizationResidualTotal };
  const reconciliation = Object.freeze({ ...reconciliationBody, contentHash: accountingHash("AccountingBasisReconciliation", reconciliationBody) });
  if (!sourceExactTotal.equals(includedExactTotal.add(excludedExactTotal)) || !projectedExactTotal.equals(includedExactTotal) || !projectedBookValueTotal.add(quantizationResidualTotal).equals(projectedExactTotal)) return Object.freeze({ disposition: "rejected", diagnostics: Object.freeze([diagnostic("accounting_basis_policy_incomplete", "projection.reconciliation", "Accounting-basis source, inclusion, exclusion, exact projection, booked projection, and quantization residual totals must reconcile exactly", ["ACC-042.5"])]) });
  const sourceSnapshot = immutableAccountingValue({ ...readSnapshot, sourceEvents: Object.freeze([...orderedEvents]), contentHash: hashAccountingReadSnapshot({ ...readSnapshot, sourceEvents: Object.freeze([...orderedEvents]) }) });
  const body = { policyId: policy.id, sourcePopulationHash: populationHash, entries: Object.freeze(entries), reconciliation, sourceSnapshot };
  return Object.freeze({ disposition: "projected", projection: Object.freeze({ ...body, contentHash: accountingHash("AccountingBasisProjection", body) }) });
}

export interface CurrencyRemeasurementRequest {
  readonly id: RemeasurementResultId; readonly policyId: PolicyId; readonly policyVersion: SemanticVersion; readonly classificationPolicyId: PolicyId; readonly classificationPolicyVersion: SemanticVersion; readonly governedAt: Instant;
  readonly kind: "realized" | "unrealized"; readonly classification: "monetary" | "nonMonetary"; readonly sourcePostingId?: PostingId; readonly source?: CanonicalPostingReference;
  readonly generatedEffectKey?: EffectKey;
  readonly effectiveOn: LocalDate; readonly denominationCommodityId: CommodityId; readonly denomination: ExactRational; readonly carryingBookValue: ExactRational;
  readonly valuationPath: { readonly fromCommodityId: CommodityId; readonly toCommodityId: CommodityId; readonly effectiveAt: Instant; readonly observedAt: Instant; readonly rate: ExactRational; readonly evidenceIds: readonly EvidenceId[] };
  readonly positionAccountId: AccountId; readonly derivation: DerivationRecord;
  readonly reversalOf?: RemeasurementResultId;
  readonly reversalId?: RemeasurementReversalId;
}
/** Relevant retained result/reversal observations; the command boundary separately
 * enforces global identities, source authority and overdue reversal admission. */
export type CurrencyAccountingState = Pick<AccountingCanonicalState, "remeasurementResults" | "remeasurementReversals">;
export function calculateCurrencyRemeasurement(policies: readonly AccountingPolicy[], bookId: BookId, commodityId: CommodityId, request: CurrencyRemeasurementRequest, state: CurrencyAccountingState = emptyAccountingCanonicalState()): AccountingCalculation {
  const selected = policyAt<CurrencyPolicy>(policies, "currencyRemeasurement", request.policyId, request.policyVersion, request.governedAt);
  const classificationSelected = policyAt<MonetaryClassificationPolicy>(policies, "monetaryClassification", request.classificationPolicyId, request.classificationPolicyVersion, request.governedAt);
  const classification = Array.isArray(classificationSelected) ? undefined : (classificationSelected as MonetaryClassificationPolicy).rules.filter((rule) => rule.accountId === request.positionAccountId);
  if (Array.isArray(selected) || Array.isArray(classificationSelected) || !validAccountingDerivation(request.derivation) || classification?.length !== 1 || classification[0]?.classification !== request.classification || request.classification !== "monetary" || request.valuationPath.fromCommodityId !== request.denominationCommodityId || request.valuationPath.toCommodityId !== commodityId || request.valuationPath.effectiveAt.slice(0, 10) !== request.effectiveOn || compareInstants(request.valuationPath.observedAt, request.governedAt) > 0 || request.valuationPath.evidenceIds.length === 0 || !positive(request.valuationPath.rate)) return reject("currency_remeasurement_violation", "command.remeasurement", "Monetary classification, approved lineage, and a complete supplied dated valuation path are required", ["ACC-043.1", "ACC-043.2"]);
  const policy = selected as CurrencyPolicy;
  if (policy.bookId !== bookId) return reject("currency_remeasurement_violation", "command.remeasurement.policy", "Currency policy belongs to another book", ["ACC-043.1"]);
  if (request.reversalOf !== undefined) {
    const original = state.remeasurementResults.find((item) => item.id === request.reversalOf);
    if (original === undefined || original.kind !== "unrealized" || request.reversalId === undefined || state.remeasurementReversals.some((item) => item.originalResultId === original.id)) {
      return reject("currency_remeasurement_violation", "command.remeasurement.reversalOf", "An unrealized result may be explicitly reversed exactly once, whether or not its policy mandates reversal", ["ACC-043.4", "ACC-043.6"]);
    }
    const body = { id: request.reversalId, originalResultId: original.id, ...(original.adjustmentEffectKey === undefined ? {} : { originalEffectKey: original.adjustmentEffectKey }), originalJournalId: journalId(`${original.id}-journal`), reversedOn: request.effectiveOn, derivation: request.derivation };
    const effect = Object.freeze({ ...body, contentHash: accountingHash("RemeasurementReversal", body) });
    const difference = original.difference.negate();
    const originalGain = original.difference.compare(zero) > 0;
    const journal: ExactPreparedJournal = Object.freeze({ id: identifier<"JournalTransaction">(`${request.reversalId}-journal`), kind: "reversing", economicAt: request.governedAt, accountingDate: request.effectiveOn, recordedAt: request.governedAt, narration: "Currency remeasurement reversal", derivations: Object.freeze([request.derivation]), postings: Object.freeze([
      Object.freeze({ id: identifier<"Posting">(`${request.reversalId}-position`), accountId: request.positionAccountId, units: difference, unitsCommodityId: commodityId, exactBookValue: difference }),
      Object.freeze({ id: identifier<"Posting">(`${request.reversalId}-gain-loss`), accountId: originalGain ? (original.policy?.gainAccountId ?? policy.gainAccountId) : (original.policy?.lossAccountId ?? policy.lossAccountId), units: difference.negate(), unitsCommodityId: commodityId, exactBookValue: difference.negate() }),
    ]) });
    return drafted([journal], [{ type: "remeasurementReversal", value: effect }]);
  }
  const measured = request.denomination.multiply(request.valuationPath.rate);
  const difference = measured.subtract(request.carryingBookValue);
  const body = { id: request.id, kind: request.kind, ...(request.sourcePostingId === undefined ? {} : { sourcePostingId: request.sourcePostingId }), ...(request.source === undefined ? {} : { source: request.source }), positionAccountId: request.positionAccountId, denominationCommodityId: request.denominationCommodityId, effectiveOn: request.effectiveOn, ...(request.generatedEffectKey === undefined ? {} : { adjustmentEffectKey: request.generatedEffectKey }), carryingBookValue: request.carryingBookValue, measuredBookValue: measured, difference, valuationRate: request.valuationPath.rate, policyId: policy.id, policy, classificationPolicy: classificationSelected as MonetaryClassificationPolicy, valuationPath: request.valuationPath, derivation: request.derivation };
  const effect = Object.freeze({ ...body, contentHash: accountingHash("RemeasurementResult", body) });
  const gain = difference.compare(zero) > 0;
  const journal: ExactPreparedJournal = Object.freeze({ id: identifier<"JournalTransaction">(`${request.id}-journal`), kind: request.kind === "unrealized" ? "adjustment" : "ordinary", economicAt: request.governedAt, accountingDate: request.effectiveOn, recordedAt: request.governedAt, narration: `${request.kind} currency remeasurement`, derivations: Object.freeze([request.derivation]), postings: Object.freeze([
    Object.freeze({ id: identifier<"Posting">(`${request.id}-position`), accountId: request.positionAccountId, units: difference, unitsCommodityId: commodityId, exactBookValue: difference }),
    Object.freeze({ id: identifier<"Posting">(`${request.id}-gain-loss`), accountId: gain ? policy.gainAccountId : policy.lossAccountId, units: difference.negate(), unitsCommodityId: commodityId, exactBookValue: difference.negate() }),
  ]) });
  return drafted([journal], [{ type: "remeasurementResult", value: effect }]);
}

function monthsBetween(start: LocalDate, end: LocalDate): bigint {
  const [sy, sm] = start.split("-").map(Number); const [ey, em] = end.split("-").map(Number);
  return BigInt((ey! - sy!) * 12 + em! - sm! + 1);
}
function addMonths(start: LocalDate, offset: bigint): LocalDate {
  const [year, month] = start.split("-").map(Number); const total = year! * 12 + month! - 1 + Number(offset);
  return `${Math.floor(total / 12).toString().padStart(4, "0")}-${(total % 12 + 1).toString().padStart(2, "0")}-01` as LocalDate;
}
function scheduleStepMonths(frequency: AllocationPolicy["frequency"]): bigint | undefined {
  return frequency === "monthly" ? 1n : frequency === "quarterly" ? 3n : frequency === "annual" ? 12n : undefined;
}
export interface AllocationScheduleRequest { readonly id: AllocationScheduleId; readonly policyId: PolicyId; readonly policyVersion: SemanticVersion; readonly governedAt: Instant; readonly source?: CanonicalPostingReference; /** @deprecated use source */ readonly sourcePostingId?: PostingId; readonly sourceBasis: ExactRational; readonly residualValue: ExactRational; readonly startsOn: LocalDate; readonly endsOn: LocalDate; readonly usage?: readonly { readonly date: LocalDate; readonly value: ExactRational }[]; readonly derivation: DerivationRecord }
export const CUMULATIVE_ALLOCATION_ALGORITHM_VERSION = "1.1.0" as SemanticVersion;
export function usesCumulativeAllocation(policy: AllocationPolicy): boolean {
  return policy?.postingAlgorithm === "cumulative-posted-allocation-v1" && policy.algorithmVersion === CUMULATIVE_ALLOCATION_ALGORITHM_VERSION;
}

/** Legacy effects must remain plan-free; new effects must bind the complete
 * recomputed plan, not merely a caller-asserted plan digest. */
function allocationPlanIsValid(schedule: AllocationSchedule): boolean {
  if (schedule.policy?.postingAlgorithm === undefined) return schedule.postingPlan === undefined;
  if (!usesCumulativeAllocation(schedule.policy) || schedule.policy.allocationAccountId === schedule.policy.contraAccountId) return false;
  const source = quantize(schedule.sourceBasis, schedule.policy.quantizationPolicy);
  if (!source.residual.isZero() || schedule.postingPlan === undefined) return false;
  const expected = planAllocationPostings({ exactSourceBasis: schedule.sourceBasis,
    exactResidualValue: schedule.residualValue, postedSourceBasis: source.amount,
    quantizationPolicy: schedule.policy.quantizationPolicy, installments: schedule.installments });
  return expected.disposition === "planned" && contentHashEquals(
    accountingHash("AllocationPostingPlanValue", schedule.postingPlan), accountingHash("AllocationPostingPlanValue", expected.plan));
}

export function createAllocationSchedule(policies: readonly AccountingPolicy[], bookId: BookId, request: AllocationScheduleRequest): AccountingCalculation {
  const selected = policyAt<AllocationPolicy>(policies, "allocationSchedule", request.policyId, request.policyVersion, request.governedAt);
  if (Array.isArray(selected) || !validAccountingDerivation(request.derivation) || (selected as AllocationPolicy).bookId !== bookId || request.startsOn > request.endsOn || request.residualValue.isNegative() || request.residualValue.compare(request.sourceBasis) > 0) return reject("allocation_schedule_violation", "command.schedule", "Allocation basis, residual, dates, lineage, and policy must be coherent", ["ACC-044.1"]);
  const policy = selected as AllocationPolicy; const allocable = request.sourceBasis.subtract(request.residualValue); let amounts: ExactRational[]; let dates: LocalDate[];
  if (policy.method === "straightLine" || policy.method === "decliningBalance") {
    const step = scheduleStepMonths(policy.frequency);
    if (step === undefined || policy.convention !== "fullPeriod") return reject("allocation_schedule_violation", "command.schedule.policy", "This executable capability requires a monthly, quarterly, or annual full-period convention", ["ACC-044.1", "ACC-044.2"]);
    const months = monthsBetween(request.startsOn, request.endsOn);
    const count = (months + step - 1n) / step;
    if (count > BigInt(ACCOUNTING_LIMITS.maxScheduleInstallments)) return reject("allocation_schedule_violation", "command.schedule.span", "Allocation schedule span exceeds the executable installment bound", ["ACC-044.1"]);
    dates = Array.from({ length: Number(count) }, (_, index) => addMonths(request.startsOn, BigInt(index) * step));
    if (policy.method === "straightLine") amounts = dates.map(() => allocable.divide(ExactRational.of(count, 1n)));
    else {
      if (policy.decliningRate === undefined || !positive(policy.decliningRate) || policy.decliningRate.compare(ExactRational.of(1n, 1n)) > 0) return reject("allocation_schedule_violation", "command.schedule.policy", "Declining balance requires a positive exact annual rate no greater than one", ["ACC-044.2"]);
      let carrying = request.sourceBasis; amounts = [];
      const periodsPerYear = 12n / step;
      for (let index = 0n; index < count; index += 1n) {
        const calculated = carrying.multiply(policy.decliningRate).divide(ExactRational.of(periodsPerYear, 1n));
        const remainingAllocable = carrying.subtract(request.residualValue);
        const amount = index === count - 1n || calculated.compare(remainingAllocable) > 0 ? remainingAllocable : calculated;
        amounts.push(amount); carrying = carrying.subtract(amount);
      }
    }
  } else {
    const usage = request.usage ?? []; const totalUsage = sum(usage.map((item) => item.value));
    if (usage.length > ACCOUNTING_LIMITS.maxUsageEvents) return reject("allocation_schedule_violation", "command.schedule.usage", "Usage-event population exceeds the executable bound", ["ACC-044.2"]);
    if (policy.frequency !== "eventDriven" || policy.convention !== "usageEvent" || policy.expectedUsage === undefined || !positive(policy.expectedUsage) || !totalUsage.equals(policy.expectedUsage) || usage.length === 0 || new Set(usage.map((item) => item.date)).size !== usage.length || usage.some((item) => !positive(item.value) || item.date < request.startsOn || item.date > request.endsOn)) return reject("allocation_schedule_violation", "command.schedule.usage", "Units-of-production requires complete, unique, positive usage facts matching policy expectations", ["ACC-044.2"]);
    amounts = usage.map((item) => allocable.multiply(item.value).divide(totalUsage)); dates = usage.map((item) => item.date);
  }
  if (!sum(amounts).add(request.residualValue).equals(request.sourceBasis)) return reject("allocation_schedule_violation", "command.schedule.installments", "Exact installments plus residual must conserve source basis", ["ACC-044.3"]);
  const installments = Object.freeze(amounts.map((amount, index) => Object.freeze({ ordinal: BigInt(index + 1), accountingDate: dates[index]!, amount })));
  let postingPlan: AllocationPostingPlan | undefined;
  if (usesCumulativeAllocation(policy)) {
    const source = quantize(request.sourceBasis, policy.quantizationPolicy);
    if (!source.residual.isZero() || policy.allocationAccountId === policy.contraAccountId) return reject("allocation_schedule_violation", "command.schedule.postingPlan", "Cumulative schedules require representable posted source basis and distinct recognition accounts", ["ACC-044.3"]);
    const planned = planAllocationPostings({ exactSourceBasis: request.sourceBasis,
      exactResidualValue: request.residualValue, postedSourceBasis: source.amount,
      quantizationPolicy: policy.quantizationPolicy, installments });
    if (planned.disposition === "rejected") return planned;
    postingPlan = planned.plan;
  }
  const body = { id: request.id, bookId, policyId: policy.id, policy,
    ...(request.source === undefined ? {} : { source: request.source }),
    ...(request.sourcePostingId === undefined ? {} : { sourcePostingId: request.sourcePostingId }),
    sourceBasis: request.sourceBasis, residualValue: request.residualValue, installments,
    ...(postingPlan === undefined ? {} : { postingPlan }), derivation: request.derivation };
  const value = Object.freeze({ ...body, contentHash: accountingHash("AllocationSchedule", body) });
  return drafted([], [{ type: "allocationSchedule", value }]);
}

export interface AllocationRecognitionRequest { readonly id: AllocationRecognitionId; readonly scheduleId: AllocationScheduleId; readonly ordinal: bigint; readonly governedAt: Instant; readonly derivation: DerivationRecord }
/** Complete relevant schedule lifecycle observations. For recognition this includes
 * the requested ordinal and any globally conflicting recognition identity; revision
 * requires all recognitions of the original schedule and conflicting revision IDs. */
export type AllocationAccountingState = Pick<AccountingCanonicalState, "allocationSchedules" | "allocationRecognitions" | "allocationScheduleRevisions">;

export function recognizeScheduledAllocation(_policies: readonly AccountingPolicy[], state: AllocationAccountingState, commodityId: CommodityId, request: AllocationRecognitionRequest): AccountingCalculation {
  const schedule = state.allocationSchedules.find((item) => item.id === request.scheduleId); const installment = schedule?.installments.find((item) => item.ordinal === request.ordinal);
  const policy = schedule?.policy;
  const superseded = installment === undefined ? undefined : state.allocationScheduleRevisions.find((revision) => revision.originalScheduleId === request.scheduleId && (revision.kind === "disposal" || revision.kind === "termination" || installment.accountingDate >= revision.effectiveOn));
  if (schedule === undefined || installment === undefined || policy === undefined || superseded !== undefined || !validAccountingDerivation(request.derivation) || state.allocationRecognitions.some((item) => item.id === request.id || item.scheduleId === request.scheduleId && item.ordinal === request.ordinal)) return reject("allocation_schedule_violation", "command.recognition", "Schedule installment must exist, remain unsuperseded, retain approved lineage, and may be recognized once", ["ACC-044.4", "ACC-044.5"]);
  if (!allocationPlanIsValid(schedule)) return reject("allocation_schedule_violation", "command.recognition.postingPlan", "The retained algorithm and complete immutable posting plan must agree", ["ACC-044.3"]);
  const amount = schedule.postingPlan?.installments.find((item) => item.ordinal === request.ordinal)?.postedAmount.toRational() ?? installment.amount;
  const body = { id: request.id, scheduleId: request.scheduleId, ordinal: request.ordinal, derivation: request.derivation }; const effect = Object.freeze({ ...body, contentHash: accountingHash("AllocationRecognition", body) });
  const journal: ExactPreparedJournal = Object.freeze({ id: identifier<"JournalTransaction">(`${request.id}-journal`), kind: "adjustment", economicAt: request.governedAt, accountingDate: installment.accountingDate, recordedAt: request.governedAt, narration: "Scheduled allocation recognition", derivations: Object.freeze([request.derivation]),
    ...(schedule.postingPlan === undefined ? {} : { requiredQuantizationPolicy: policy.quantizationPolicy }), postings: Object.freeze([
    Object.freeze({ id: identifier<"Posting">(`${request.id}-expense`), accountId: policy.allocationAccountId, units: amount, unitsCommodityId: commodityId, exactBookValue: amount }),
    Object.freeze({ id: identifier<"Posting">(`${request.id}-contra`), accountId: policy.contraAccountId, units: amount.negate(), unitsCommodityId: commodityId, exactBookValue: amount.negate() }),
  ]) });
  return drafted([journal], [{ type: "allocationRecognition", value: effect }]);
}

export interface AllocationScheduleRevisionRequest {
  readonly id: AllocationScheduleRevisionId;
  readonly kind: AllocationScheduleChangeKind;
  readonly effectiveOn: LocalDate;
  readonly policyEffectiveAt: Instant;
  readonly generatedEffectKey?: EffectKey;
  readonly originalScheduleId: AllocationScheduleId;
  readonly priorRecognitionIds: readonly AllocationRecognitionId[];
  readonly policyId: PolicyId;
  readonly policyVersion: SemanticVersion;
  readonly revisedResidualValue: ExactRational;
  readonly exactAdjustmentAmount?: ExactRational;
  readonly successorScheduleId?: AllocationScheduleId;
  readonly revisedEndsOn?: LocalDate;
  readonly revisedUsage?: AllocationScheduleRequest["usage"];
  readonly evidence: DerivationRecord["evidence"];
  readonly derivation: DerivationRecord;
}

export function reviseAllocationSchedule(
  policies: readonly AccountingPolicy[],
  state: AllocationAccountingState,
  bookId: BookId,
  commodityId: CommodityId,
  request: AllocationScheduleRevisionRequest,
): AccountingCalculation {
  const original = state.allocationSchedules.find((schedule) => schedule.id === request.originalScheduleId);
  const selected = policyAt<AllocationPolicy>(policies, "allocationSchedule", request.policyId, request.policyVersion, request.policyEffectiveAt);
  if (original === undefined || Array.isArray(selected)) return reject("allocation_schedule_revision_violation", "command.scheduleRevision", "Schedule revision requires one existing schedule and one applicable executable policy", ["ACC-044.4"]);
  const policy = selected as AllocationPolicy;
  const recognitions = state.allocationRecognitions.filter((recognition) => recognition.scheduleId === original.id);
  const cumulative = usesCumulativeAllocation(policy);
  if ((cumulative || original.postingPlan !== undefined) && (!cumulative || original.postingPlan === undefined || !allocationPlanIsValid(original) ||
    recognitions.some((recognition) => !original.installments.some((item) => item.ordinal === recognition.ordinal)) ||
    policy.allocationAccountId !== original.policy.allocationAccountId || policy.contraAccountId !== original.policy.contraAccountId ||
    !contentHashEquals(hashQuantizationPolicy(policy.quantizationPolicy), hashQuantizationPolicy(original.policy.quantizationPolicy)))) {
    return reject("allocation_schedule_revision_violation", "command.scheduleRevision.postingPlan", "Cumulative revisions require a verified cumulative original and unchanged posting accounts/quantization; legacy conversion requires an explicit posted-history transition", ["ACC-044.3", "ACC-044.4"]);
  }
  const suppliedRecognitionIds = [...request.priorRecognitionIds].sort();
  const actualRecognitionIds = recognitions.map((recognition) => recognition.id).sort();
  const recognizedToDate = sum(recognitions.map((recognition) => original.installments.find((installment) => installment.ordinal === recognition.ordinal)?.amount ?? zero));
  const carryingAmountAtRevision = original.sourceBasis.subtract(recognizedToDate);
  const postedRecognizedToDate = cumulative ? sum(recognitions.map((recognition) => original.postingPlan!.installments.find((item) => item.ordinal === recognition.ordinal)!.postedAmount.toRational())) : undefined;
  const postedCarryingAmountAtRevision = postedRecognizedToDate === undefined ? undefined : original.sourceBasis.subtract(postedRecognizedToDate);
  const effectiveCarrying = postedCarryingAmountAtRevision ?? carryingAmountAtRevision;
  const adjustmentRequired = request.kind === "impairment" || (request.kind === "disposal" || request.kind === "termination") && !effectiveCarrying.isZero();
  const exactAdjustmentAmount = request.exactAdjustmentAmount;
  const appliedAdjustment = cumulative && exactAdjustmentAmount !== undefined ? quantize(exactAdjustmentAmount, policy.quantizationPolicy).amount.toRational() : exactAdjustmentAmount;
  const afterAdjustment = effectiveCarrying.add(appliedAdjustment ?? zero);
  const successorRequired = request.kind === "estimateChange" || request.kind === "impairment" && request.revisedResidualValue.compare(afterAdjustment) < 0;
  if (
    policy.bookId !== bookId || request.evidence.length === 0 || !validAccountingDerivation(request.derivation) ||
    request.derivation.policyId !== policy.id || request.derivation.policyVersion !== policy.version ||
    state.allocationScheduleRevisions.some((revision) => revision.id === request.id || revision.originalScheduleId === original.id) ||
    suppliedRecognitionIds.length !== new Set(suppliedRecognitionIds).size || suppliedRecognitionIds.join("\u0000") !== actualRecognitionIds.join("\u0000") ||
    (original.installments[0] !== undefined && request.effectiveOn < original.installments[0].accountingDate) ||
    recognitions.some((recognition) => (original.installments.find((installment) => installment.ordinal === recognition.ordinal)?.accountingDate ?? request.effectiveOn) >= request.effectiveOn) ||
    request.revisedResidualValue.isNegative() || (adjustmentRequired !== (exactAdjustmentAmount !== undefined)) ||
    (exactAdjustmentAmount !== undefined && exactAdjustmentAmount.isZero()) ||
    (request.kind === "estimateChange" && (request.generatedEffectKey !== undefined || exactAdjustmentAmount !== undefined)) ||
    (request.kind === "impairment" && (exactAdjustmentAmount === undefined || exactAdjustmentAmount.compare(zero) >= 0)) ||
    ((request.kind === "disposal" || request.kind === "termination") && exactAdjustmentAmount !== undefined && !exactAdjustmentAmount.equals(effectiveCarrying.negate())) ||
    afterAdjustment.isNegative() || request.revisedResidualValue.compare(afterAdjustment) > 0 ||
    (request.kind === "estimateChange" && request.revisedResidualValue.compare(afterAdjustment) >= 0) ||
    (successorRequired !== (request.successorScheduleId !== undefined)) ||
    (successorRequired && (request.revisedEndsOn === undefined || request.revisedEndsOn < request.effectiveOn)) ||
    (!successorRequired && (request.revisedEndsOn !== undefined || request.revisedUsage !== undefined))
  ) return reject("allocation_schedule_revision_violation", "command.scheduleRevision", "Revision cutoff, prior recognitions, adjustment topology, residual, successor, policy, and evidence must reconcile exactly", ["ACC-044.4", "ACC-044.5", "ACC-044.6"]);
  if ((request.kind === "estimateChange" || request.kind === "impairment") && original.installments.some((installment) => installment.accountingDate < request.effectiveOn && !recognitions.some((recognition) => recognition.ordinal === installment.ordinal))) return reject("allocation_schedule_revision_violation", "command.scheduleRevision.priorRecognitionIds", "Recognize every earlier installment before a prospective revision so its carrying basis cannot be allocated twice", ["ACC-044.4", "ACC-044.5"]);

  let successor: AllocationSchedule | undefined;
  if (successorRequired) {
    const successorCalculation = createAllocationSchedule(policies, bookId, {
      id: request.successorScheduleId!, policyId: policy.id, policyVersion: policy.version, governedAt: request.policyEffectiveAt,
      ...(original.source === undefined ? {} : { source: original.source }),
      ...(original.sourcePostingId === undefined ? {} : { sourcePostingId: original.sourcePostingId }),
      sourceBasis: afterAdjustment, residualValue: request.revisedResidualValue,
      startsOn: request.effectiveOn, endsOn: request.revisedEndsOn!, ...(request.revisedUsage === undefined ? {} : { usage: request.revisedUsage }), derivation: request.derivation,
    });
    if (successorCalculation.disposition === "rejected") return Object.freeze({ disposition: "rejected", diagnostics: successorCalculation.diagnostics });
    const successorEffect = successorCalculation.draft.effects.find((effect) => effect.type === "allocationSchedule");
    if (successorEffect?.type !== "allocationSchedule") throw new Error("Schedule revision omitted its successor effect");
    successor = successorEffect.value;
  }
  const body = Object.freeze({
    id: request.id, kind: request.kind, effectiveOn: request.effectiveOn,
    ...(request.generatedEffectKey === undefined ? {} : { generatedEffectKey: request.generatedEffectKey }),
    originalScheduleId: original.id, priorRecognitionIds: Object.freeze(actualRecognitionIds), recognizedToDate, carryingAmountAtRevision,
    ...(postedRecognizedToDate === undefined ? {} : { postedRecognizedToDate, postedCarryingAmountAtRevision: postedCarryingAmountAtRevision! }),
    revisedResidualValue: request.revisedResidualValue,
    ...(exactAdjustmentAmount === undefined ? {} : { exactAdjustmentAmount, bookedAdjustment: quantize(exactAdjustmentAmount, policy.quantizationPolicy) }),
    ...(successor === undefined ? {} : { successorScheduleId: successor.id }),
    policy, evidence: Object.freeze([...request.evidence]), derivation: request.derivation,
  });
  const revision: AllocationScheduleRevision = Object.freeze({ ...body, contentHash: accountingHash("AllocationScheduleRevision", body) });
  const effects: AccountingEffect[] = [{ type: "allocationScheduleRevision", value: revision }];
  if (successor !== undefined) effects.push({ type: "allocationSchedule", value: successor });
  const journals: ExactPreparedJournal[] = [];
  if (exactAdjustmentAmount !== undefined) journals.push(Object.freeze({
    id: identifier<"JournalTransaction">(`${request.id}-journal`), kind: "adjustment", economicAt: request.policyEffectiveAt,
    accountingDate: request.effectiveOn, recordedAt: request.policyEffectiveAt, narration: `Allocation schedule ${request.kind}`,
    derivations: Object.freeze([request.derivation]),
    ...(cumulative ? { requiredQuantizationPolicy: policy.quantizationPolicy } : {}), postings: Object.freeze([
      Object.freeze({ id: identifier<"Posting">(`${request.id}-allocation`), accountId: policy.allocationAccountId, units: appliedAdjustment!.negate(), unitsCommodityId: commodityId, exactBookValue: appliedAdjustment!.negate() }),
      Object.freeze({ id: identifier<"Posting">(`${request.id}-contra`), accountId: policy.contraAccountId, units: appliedAdjustment!, unitsCommodityId: commodityId, exactBookValue: appliedAdjustment! }),
    ]),
  }));
  return drafted(journals, effects);
}

export interface TaxableLine { readonly lineId: string; readonly sourcePostingId: PostingId; readonly counterpartyPostingId: PostingId; readonly policyId: PolicyId; readonly policyVersion: SemanticVersion; readonly statedAmount: ExactRational; readonly amountIncludesTax: boolean; readonly sourceAccountId: AccountId; readonly payableAccountId: AccountId }
export interface TaxRequest { readonly id: TaxDeterminationId; readonly sourceTransactionId: JournalId; readonly governedAt: Instant; readonly direction: TaxDirection; readonly lines: readonly TaxableLine[]; readonly derivation: DerivationRecord }
interface PreResolvedTaxLine {
  readonly line: TaxableLine;
  readonly policy: TaxPolicy;
  readonly components: readonly TaxPolicyComponent[];
  readonly unroundedExclusive: ExactRational;
  readonly componentExactTaxes: readonly {
    readonly component: TaxPolicyComponent;
    readonly exactTax: ExactRational;
  }[];
}
export function determineTax(policies: readonly AccountingPolicy[], bookId: BookId, commodityId: CommodityId, request: TaxRequest): AccountingCalculation {
  if (!validAccountingDerivation(request.derivation) || request.lines.length === 0 || request.lines.length > ACCOUNTING_LIMITS.maxTaxLines) return reject("tax_policy_ambiguity", "command.tax", "Tax determination requires approved lineage and at least one taxable line within the executable bound", ["ACC-045.1"]);
  const seenLineIds = new Set<string>(); const seenSourcePostings = new Set<string>(); const seenCounterpartyPostings = new Set<string>();
  if (request.lines.some((line) => seenLineIds.has(line.lineId) || seenSourcePostings.has(line.sourcePostingId) || seenCounterpartyPostings.has(line.counterpartyPostingId) || !seenLineIds.add(line.lineId) || !seenSourcePostings.add(line.sourcePostingId) || !seenCounterpartyPostings.add(line.counterpartyPostingId) || line.lineId.trim().length === 0 || line.sourcePostingId === line.counterpartyPostingId || line.statedAmount.isZero())) {
    return reject("tax_policy_ambiguity", "command.tax.lines", "Every taxable line requires a unique identity, distinct postings, and a non-zero stated amount", ["ACC-045.1"]);
  }
  const isSale = request.direction === "sale" || request.direction === "saleCredit";
  const isCredit = request.direction === "purchaseCredit" || request.direction === "saleCredit";
  const sourceSign = (request.direction === "purchase" || request.direction === "saleCredit") ? ExactRational.of(1n, 1n) : ExactRational.of(-1n, 1n);

  const preLines: PreResolvedTaxLine[] = [];
  let commonRoundingLevel: TaxRoundingLevel | undefined;
  let commonQuantizationPolicy: QuantizationPolicy | undefined;

  for (const line of request.lines) {
    const selected = policyAt<TaxPolicy>(policies, "taxDetermination", line.policyId, line.policyVersion, request.governedAt);
    if (Array.isArray(selected)) return Object.freeze({ disposition: "rejected", diagnostics: Object.freeze([diagnostic("tax_policy_ambiguity", `command.tax.lines[${line.lineId}].policy`, "Exactly one applicable tax policy with matching executable capability evidence is required for every taxable line", ["ACC-045.1", "ACC-045.5"])]) });
    const policy = selected as TaxPolicy;
    if (policy.groupingAlgorithm !== undefined && !usesStructuralTaxGrouping(policy)) {
      return reject("tax_policy_ambiguity", `command.tax.lines[${line.lineId}].policy.groupingAlgorithm`, "Structural tax grouping requires its explicit marker and supported implementation version", ["ACC-038", "ACC-045.4"]);
    }
    if (policy.roundingLevel !== "lineLevel" && policy.roundingLevel !== "documentLevel") {
      return reject("tax_policy_ambiguity", `command.tax.lines[${line.lineId}].policy.roundingLevel`, "Tax policy rounding level must be lineLevel or documentLevel", ["ACC-045.1", "ACC-045.4"]);
    }
    if (commonRoundingLevel === undefined) {
      commonRoundingLevel = policy.roundingLevel;
      commonQuantizationPolicy = policy.quantizationPolicy;
    } else if (policy.roundingLevel !== commonRoundingLevel) {
      return reject("tax_policy_ambiguity", `command.tax.lines[${line.lineId}].policy.roundingLevel`, "All taxable lines in a tax determination request must share the same rounding level policy", ["ACC-045.1", "ACC-045.4"]);
    } else if (
      commonQuantizationPolicy !== undefined &&
      (policy.quantizationPolicy.targetScale !== commonQuantizationPolicy.targetScale ||
       policy.quantizationPolicy.roundingMode !== commonQuantizationPolicy.roundingMode)
    ) {
      return reject("tax_policy_ambiguity", `command.tax.lines[${line.lineId}].policy.quantizationPolicy`, "All taxable lines in a tax determination request must share compatible quantization policies", ["ACC-045.1", "ACC-045.4"]);
    }

    const components = [...policy.components].sort((a, b) => Number(a.compoundOrdinal - b.compoundOrdinal));
    if (
      policy.bookId !== bookId || components.length === 0 || new Set(components.map((item) => item.id)).size !== components.length ||
      components.some((component, index) => component.compoundOrdinal <= 0n || index > 0 && component.compoundOrdinal <= components[index - 1]!.compoundOrdinal || !positive(component.rate) || component.inclusion !== (line.amountIncludesTax ? "inclusive" : "exclusive") || component.compoundsOn.some((id) => !components.slice(0, index).some((prior) => prior.id === id))) ||
      components.some((component) => component.recoverableShare.compare(zero) < 0 || component.recoverableShare.compare(ExactRational.of(1n, 1n)) > 0 || ((component.treatment === "outputTax" || component.treatment === "withholding") && !component.recoverableShare.isZero())) ||
      components.some((component) => isSale ? component.treatment !== "outputTax" : component.treatment === "outputTax")
    ) return reject("tax_policy_ambiguity", `command.tax.lines[${line.lineId}].components`, "Tax component graph, direction, inclusion, rate, or recoverability is invalid", ["ACC-045.2", "ACC-045.5"]);

    const coefficients = new Map<PolicyId, ExactRational>();
    for (const component of components) coefficients.set(component.id, ExactRational.of(1n, 1n).add(sum(component.compoundsOn.map((id) => coefficients.get(id) ?? zero))).multiply(component.rate));
    const grossCoefficient = ExactRational.of(1n, 1n).add(sum(components.filter((component) => component.treatment === "inputTax" || component.treatment === "outputTax").map((component) => coefficients.get(component.id)!)));
    if (!positive(grossCoefficient)) return reject("tax_policy_ambiguity", `command.tax.lines[${line.lineId}].inclusive`, "Inclusive tax graph has no positive exact solution", ["ACC-045.3"]);

    const exclusive = line.amountIncludesTax ? line.statedAmount.divide(grossCoefficient) : line.statedAmount;
    const seen = new Map<PolicyId, ExactRational>();
    const componentExactTaxes: { readonly component: TaxPolicyComponent; readonly exactTax: ExactRational }[] = [];

    for (const component of components) {
      const compound = sum(component.compoundsOn.map((id) => seen.get(id) ?? zero));
      const exactTax = exclusive.add(compound).multiply(component.rate);
      seen.set(component.id, exactTax);
      componentExactTaxes.push(Object.freeze({ component, exactTax }));
    }

    const grossTax = sum(componentExactTaxes.filter((item) => item.component.treatment === "inputTax" || item.component.treatment === "outputTax").map((item) => item.exactTax));
    if (line.amountIncludesTax && !exclusive.add(grossTax).equals(line.statedAmount)) return reject("tax_policy_ambiguity", `command.tax.lines[${line.lineId}].inclusive`, "Inclusive tax amount has no exact reconstruction", ["ACC-045.3"]);

    preLines.push(Object.freeze({ line, policy, components: Object.freeze(components), unroundedExclusive: exclusive, componentExactTaxes: Object.freeze(componentExactTaxes) }));
  }

  interface AllocatedComponent {
    readonly policyId: PolicyId;
    readonly exactTax: ExactRational;
    readonly quantizedAmount: ExactRational;
    readonly quantization: QuantizedValue;
    readonly recoverable: ExactRational;
    readonly nonRecoverable: ExactRational;
  }
  const lineAllocatedComponents: AllocatedComponent[][] = [];

  if (commonRoundingLevel === "documentLevel") {
    interface OccurrenceRef {
      readonly lineIdx: number;
      readonly compIdx: number;
      readonly policy: TaxPolicy;
      readonly component: TaxPolicyComponent;
      readonly exactTax: ExactRational;
    }
    const groups = new Map<string, OccurrenceRef[]>();
    for (const [lineIdx, pre] of preLines.entries()) {
      lineAllocatedComponents.push([]);
      for (const [compIdx, item] of pre.componentExactTaxes.entries()) {
        // Disjoint tagged keys keep prospective groups apart from legacy groups,
        // including identifiers containing JSON punctuation or delimiters.
        const key = JSON.stringify(usesStructuralTaxGrouping(pre.policy)
          ? ["structural", pre.policy.id, pre.policy.version, item.component.id]
          : ["legacy", `${pre.policy.id}:${item.component.id}`]);
        const occ: OccurrenceRef = { lineIdx, compIdx, policy: pre.policy, component: item.component, exactTax: item.exactTax };
        const existing = groups.get(key);
        if (existing !== undefined) existing.push(occ);
        else groups.set(key, [occ]);
      }
    }

    for (const occurrences of groups.values()) {
      let cumExact = zero;
      let prevCumCoefficient = 0n;
      let cumAllocated = zero;
      let prevCumRecCoefficient = 0n;

      for (const occ of occurrences) {
        cumExact = cumExact.add(occ.exactTax);
        const qCum = quantize(cumExact, occ.policy.quantizationPolicy);
        const diffCoefficient = qCum.amount.coefficient - prevCumCoefficient;
        prevCumCoefficient = qCum.amount.coefficient;
        const decimalAmount = ExactDecimal.of(diffCoefficient, occ.policy.quantizationPolicy.targetScale);
        const allocatedAmount = decimalAmount.toRational();
        const residual = occ.exactTax.subtract(allocatedAmount);

        let allocatedRec: ExactRational;
        let allocatedNonRec: ExactRational;
        if (occ.component.recoverableShare.equals(ExactRational.of(1n, 1n))) {
          allocatedRec = allocatedAmount;
          allocatedNonRec = zero;
        } else if (occ.component.recoverableShare.isZero()) {
          allocatedRec = zero;
          allocatedNonRec = allocatedAmount;
        } else {
          cumAllocated = cumAllocated.add(allocatedAmount);
          const qCumRec = quantize(cumAllocated.multiply(occ.component.recoverableShare), occ.policy.quantizationPolicy);
          const diffRecCoefficient = qCumRec.amount.coefficient - prevCumRecCoefficient;
          prevCumRecCoefficient = qCumRec.amount.coefficient;
          const decimalRec = ExactDecimal.of(diffRecCoefficient, occ.policy.quantizationPolicy.targetScale);
          allocatedRec = decimalRec.toRational();
          allocatedNonRec = allocatedAmount.subtract(allocatedRec);
        }

        lineAllocatedComponents[occ.lineIdx]![occ.compIdx] = Object.freeze({
          policyId: occ.component.id,
          exactTax: occ.exactTax,
          quantizedAmount: allocatedAmount,
          quantization: Object.freeze({ amount: decimalAmount, residual }),
          recoverable: allocatedRec,
          nonRecoverable: allocatedNonRec,
        });
      }
    }
  } else {
    for (const pre of preLines) {
      const lineComps: AllocatedComponent[] = [];
      for (const item of pre.componentExactTaxes) {
        const q = quantize(item.exactTax, pre.policy.quantizationPolicy);
        const quantizedAmount = q.amount.toRational();
        const residual = item.exactTax.subtract(quantizedAmount);

        let rec: ExactRational;
        let nonRec: ExactRational;
        if (item.component.recoverableShare.equals(ExactRational.of(1n, 1n))) {
          rec = quantizedAmount;
          nonRec = zero;
        } else if (item.component.recoverableShare.isZero()) {
          rec = zero;
          nonRec = quantizedAmount;
        } else {
          rec = quantize(quantizedAmount.multiply(item.component.recoverableShare), pre.policy.quantizationPolicy).amount.toRational();
          nonRec = quantizedAmount.subtract(rec);
        }

        lineComps.push(Object.freeze({
          policyId: item.component.id,
          exactTax: item.exactTax,
          quantizedAmount,
          quantization: Object.freeze({ amount: q.amount, residual }),
          recoverable: rec,
          nonRecoverable: nonRec,
        }));
      }
      lineAllocatedComponents.push(lineComps);
    }
  }

  const entries = new Map<AccountId, { readonly id: PostingId; readonly amount: ExactRational; readonly order: number }>();
  const addPosting = (id: PostingId, accountId: AccountId, amount: ExactRational, order: number) => {
    const prior = entries.get(accountId);
    entries.set(
      accountId,
      prior === undefined
        ? { id, amount, order }
        : order < prior.order
          ? { id, amount: prior.amount.add(amount), order }
          : { id: prior.id, amount: prior.amount.add(amount), order: prior.order },
    );
  };

  const lineResults: TaxLineResult[] = [];

  for (const [lineOrdinal, pre] of preLines.entries()) {
    const allocatedComps = lineAllocatedComponents[lineOrdinal]!;
    const orderBase = lineOrdinal * (pre.components.length * 2 + 4);

    const grossAllocatedTax = sum(
      allocatedComps
        .filter((_, idx) => {
          const t = pre.components[idx]!.treatment;
          return t === "inputTax" || t === "outputTax";
        })
        .map((c) => c.quantizedAmount),
    );

    const lineExclusive = pre.line.amountIncludesTax
      ? pre.line.statedAmount.subtract(grossAllocatedTax)
      : pre.unroundedExclusive;

    addPosting(pre.line.sourcePostingId, pre.line.sourceAccountId, lineExclusive.multiply(sourceSign), orderBase);
    let counterpartyAmount = lineExclusive.multiply(sourceSign).negate();

    for (const [index, allocated] of allocatedComps.entries()) {
      const component = pre.components[index]!;
      if (component.treatment === "inputTax" || component.treatment === "reverseCharge") {
        if (!allocated.recoverable.isZero()) {
          if (component.recoverableAccountId === undefined) return reject("tax_policy_ambiguity", `command.tax.lines[${pre.line.lineId}].components`, "Recoverable tax requires a policy-declared destination", ["ACC-045.4", "ACC-045.5"]);
          const recAmount = isCredit ? allocated.recoverable.negate() : allocated.recoverable;
          addPosting(identifier<"Posting">(`${request.id}-tax-${lineOrdinal + 1}-${index + 1}-recoverable`), component.recoverableAccountId, recAmount, orderBase + index * 2 + 1);
        }
        if (!allocated.nonRecoverable.isZero()) {
          if (component.nonRecoverableAccountId === undefined) return reject("tax_policy_ambiguity", `command.tax.lines[${pre.line.lineId}].components`, "Nonrecoverable tax requires a policy-declared destination", ["ACC-045.4", "ACC-045.5"]);
          const nonRecAmount = isCredit ? allocated.nonRecoverable.negate() : allocated.nonRecoverable;
          addPosting(identifier<"Posting">(`${request.id}-tax-${lineOrdinal + 1}-${index + 1}-nonrecoverable`), component.nonRecoverableAccountId, nonRecAmount, orderBase + index * 2 + 2);
        }
        if (component.treatment === "inputTax") {
          counterpartyAmount = isCredit ? counterpartyAmount.add(allocated.quantizedAmount) : counterpartyAmount.subtract(allocated.quantizedAmount);
        } else {
          const liabAmount = isCredit ? allocated.quantizedAmount : allocated.quantizedAmount.negate();
          addPosting(identifier<"Posting">(`${request.id}-tax-${lineOrdinal + 1}-${index + 1}-liability`), component.liabilityAccountId, liabAmount, orderBase + index * 2 + 1);
        }
      } else {
        const liabAmount = isCredit ? allocated.quantizedAmount : allocated.quantizedAmount.negate();
        addPosting(identifier<"Posting">(`${request.id}-tax-${lineOrdinal + 1}-${index + 1}-liability`), component.liabilityAccountId, liabAmount, orderBase + index * 2 + 1);
        counterpartyAmount = isCredit ? counterpartyAmount.subtract(allocated.quantizedAmount) : counterpartyAmount.add(allocated.quantizedAmount);
      }
    }

    addPosting(pre.line.counterpartyPostingId, pre.line.payableAccountId, counterpartyAmount, orderBase + pre.components.length * 2 + 2);

    const compResults: TaxComponentResult[] = allocatedComps.map((c) => Object.freeze({
      policyId: c.policyId,
      exactTax: c.exactTax,
      quantization: c.quantization,
      recoverable: c.recoverable,
      nonRecoverable: c.nonRecoverable,
    }));

    lineResults.push(Object.freeze({
      lineId: pre.line.lineId,
      policyId: pre.policy.id,
      exclusiveBasis: lineExclusive,
      components: Object.freeze(compResults),
    }));
  }

  const postings: ExactPreparedPosting[] = [...entries.entries()].map(([accountId, entry]) => ({ id: entry.id, accountId, units: entry.amount, unitsCommodityId: commodityId, exactBookValue: entry.amount }));
  if (!sum(postings.map((item) => item.exactBookValue)).isZero()) return reject("tax_policy_ambiguity", "command.tax", "The taxed transaction journal is not balanced", ["ACC-045.4"]);
  const body = { id: request.id, bookId, taxPoint: request.governedAt, sourceTransactionId: request.sourceTransactionId, direction: request.direction, lines: Object.freeze(lineResults), derivation: request.derivation }; const effect = Object.freeze({ ...body, contentHash: accountingHash("TaxDetermination", body) });
  const journal: ExactPreparedJournal = Object.freeze({ id: request.sourceTransactionId, kind: "ordinary", economicAt: request.governedAt, accountingDate: request.governedAt.slice(0, 10) as LocalDate, recordedAt: request.governedAt, narration: "Taxed transaction", derivations: Object.freeze([request.derivation]), postings: Object.freeze(postings.map((item) => Object.freeze(item))) });
  return drafted([journal], [{ type: "taxDetermination", value: effect }]);
}

export interface ConsolidationValuationStep { readonly fromCommodityId: CommodityId; readonly toCommodityId: CommodityId; readonly rate: ExactRational; readonly observedAt: Instant; readonly evidenceIds: readonly string[] }
export interface ConsolidationValuationPath { readonly id: string; readonly effectiveAt: Instant; readonly steps: readonly ConsolidationValuationStep[] }
export interface ConsolidationSource { readonly bookId: BookId; readonly revision: bigint; readonly postingSequence: bigint; readonly populationHash: ContentHash; readonly expectedRevision: bigint; readonly expectedPostingSequence: bigint; readonly expectedPopulationHash: ContentHash; readonly relationshipId: string; readonly relationshipValidFrom: Instant; readonly relationshipValidTo?: Instant; readonly control: "controlled" | "jointlyControlled" | "significantInfluence"; readonly method: "full" | "equity" | "jointOperationShare"; readonly ownershipShare: ExactRational; readonly votingShare: ExactRational; readonly nonControllingInterestMethod?: "proportionateNetAssets" | "fairValue"; readonly nonControllingInterestFairValue?: ExactRational; readonly controlEvidenceIds: readonly string[]; readonly balances: readonly { readonly sourceAccountId: AccountId; readonly unitsCommodityId: CommodityId; readonly classification: "asset" | "liability" | "equity" | "income" | "expense"; readonly amount: ExactRational; readonly valuationPaths: readonly ConsolidationValuationPath[] }[] }
export interface ConsolidationElimination { readonly id: string; readonly sourceBookId: BookId; readonly sourceAccountId: AccountId; readonly targetAccountId: AccountId; readonly amount: ExactRational; readonly evidenceIds: readonly string[]; readonly sourcePostingIds: readonly PostingId[] }
export interface ConsolidationRequest { readonly id: ConsolidationCompilationId; readonly policyId: PolicyId; readonly policyVersion: SemanticVersion; readonly governedAt: Instant; readonly throughOn: LocalDate; readonly targetBookId: BookId; readonly sources: readonly ConsolidationSource[]; readonly eliminations: readonly ConsolidationElimination[]; readonly derivation: DerivationRecord }
export function compileConsolidation(policies: readonly AccountingPolicy[], commodityId: CommodityId, request: ConsolidationRequest): AccountingCalculation {
  const selected = policyAt<ConsolidationPolicy>(policies, "consolidation", request.policyId, request.policyVersion, request.governedAt);
  const unit = ExactRational.of(1n, 1n);
  if (request.sources.length > ACCOUNTING_LIMITS.maxConsolidationSources || request.eliminations.length > ACCOUNTING_LIMITS.maxConsolidationEliminations) return reject("consolidation_input_violation", "command.consolidation", "Consolidation population exceeds the executable bound", ["ACC-046.1"]);
  if (!validAccountingDerivation(request.derivation) || request.derivation.policyId !== request.policyId || request.derivation.policyVersion !== request.policyVersion) return reject("consolidation_input_violation", "command.consolidation.derivation", "Consolidation lineage must be approved and bound to the selected canonical policy version", ["ACC-046.1", "ACC-047.5"]);
  if (Array.isArray(selected) || request.sources.length === 0 || new Set(request.sources.map((source) => source.bookId)).size !== request.sources.length || new Set(request.sources.map((source) => source.relationshipId)).size !== request.sources.length || request.sources.some((source) =>
    source.bookId === request.targetBookId || source.revision <= 0n || source.postingSequence < 0n || source.revision !== source.expectedRevision || source.postingSequence !== source.expectedPostingSequence || !contentHashEqual(source.populationHash, source.expectedPopulationHash) || source.controlEvidenceIds.length === 0 ||
    source.relationshipId.trim().length === 0 || compareInstants(source.relationshipValidFrom, request.governedAt) > 0 || (source.relationshipValidTo !== undefined && compareInstants(request.governedAt, source.relationshipValidTo) >= 0) ||
    source.ownershipShare.compare(zero) < 0 || source.ownershipShare.compare(unit) > 0 || source.votingShare.compare(zero) < 0 || source.votingShare.compare(unit) > 0 ||
    (source.control === "controlled" ? source.method !== "full" : source.control === "significantInfluence" ? source.method !== "equity" : source.method !== "jointOperationShare") ||
    !(selected as ConsolidationPolicy).supportedMethods.includes(source.method) ||
    (source.method === "full" && source.ownershipShare.compare(unit) < 0 && source.nonControllingInterestMethod === undefined) ||
    (source.method === "full" && source.ownershipShare.equals(unit) && (source.nonControllingInterestMethod !== undefined || source.nonControllingInterestFairValue !== undefined)) ||
    (source.method !== "full" && (source.nonControllingInterestMethod !== undefined || source.nonControllingInterestFairValue !== undefined)) ||
    (source.nonControllingInterestMethod === "proportionateNetAssets" && source.nonControllingInterestFairValue !== undefined) ||
    (source.nonControllingInterestMethod === "fairValue" && (source.nonControllingInterestFairValue === undefined || positive(source.nonControllingInterestFairValue))) ||
    source.balances.length === 0 || source.balances.length > ACCOUNTING_LIMITS.maxConsolidationBalancesPerSource || !sum(source.balances.map((balance) => balance.amount)).isZero()
  )) return reject("consolidation_input_violation", "command.consolidation.sources", "Consolidation requires fresh pinned noncircular populations and compatible evidenced relationships and ownership", ["ACC-046.1", "ACC-046.2", "ACC-046.3", "ACC-046.4", "ACC-046.7"]);
  const sourceBookIds = new Set(request.sources.map((source) => source.bookId));
  const eliminationPostingIds = request.eliminations.flatMap(item => item.sourcePostingIds.map(id => JSON.stringify([item.sourceBookId, id])));
  if (new Set(request.eliminations.map((item) => item.id)).size !== request.eliminations.length || new Set(eliminationPostingIds).size !== eliminationPostingIds.length ||
      request.eliminations.some((item) => item.id.trim().length === 0 || !sourceBookIds.has(item.sourceBookId) || item.evidenceIds.length === 0 || item.sourcePostingIds.length === 0 || item.amount.isZero()) ||
      !sum(request.eliminations.map((item) => item.amount)).isZero()) return reject("consolidation_input_violation", "command.consolidation.eliminations", "Eliminations require unique matched source postings, evidence-declared target accounts, and an independently balanced exact set", ["ACC-046.5", "ACC-046.6"]);
  const policy = selected as ConsolidationPolicy;
  const coordinate = (book: BookId, account: AccountId) => JSON.stringify([book, account]);
  // Preserve existing unambiguous output order; raw tuple ties must not depend
  // on caller array order when an identifier itself contains the separator.
  const order = (left: readonly string[], right: readonly string[]) =>
    compareCanonicalText(left.join(":"), right.join(":")) || compareCanonicalText(JSON.stringify(left), JSON.stringify(right));
  const globalValuation = policy.valuationPolicy;
  if (compareInstants(globalValuation.validFrom, request.governedAt) > 0 || (globalValuation.validTo !== undefined && compareInstants(request.governedAt, globalValuation.validTo) >= 0) || globalValuation.maximumHops <= 0n) return reject("consolidation_input_violation", "command.consolidation.valuationPolicy", "The consolidation valuation policy must be effective and executable at the governed instant", ["ACC-046.4"]);
  const mappings = [...policy.accountMappings].sort((left, right) => compareCanonicalText(`${left.sourceBookId ?? ""}:${left.sourceAccountId}`, `${right.sourceBookId ?? ""}:${right.sourceAccountId}`));
  const resolveTarget = (sourceBookId: BookId, sourceAccountId: AccountId): AccountId | readonly SemanticDiagnostic[] => {
    const matches = mappings.filter((mapping) => mapping.sourceAccountId === sourceAccountId && (mapping.sourceBookId === undefined || mapping.sourceBookId === sourceBookId) && compareInstants(mapping.validFrom, request.governedAt) <= 0 && (mapping.validTo === undefined || compareInstants(request.governedAt, mapping.validTo) < 0));
    if (matches.length !== 1) return Object.freeze([diagnostic("consolidation_input_violation", "command.consolidation.mappings", "Every source balance must resolve to exactly one canonical policy account mapping", ["ACC-046.4"])]);
    return matches[0]!.targetAccountId;
  };
  // Translation rules bind one mapped source account to its rate-selection policy.
  const rules = [...policy.translationRules].sort((left, right) => order([left.sourceBookId ?? "", left.sourceAccountId], [right.sourceBookId ?? "", right.sourceAccountId]));
  const resolveRate = (sourceBookId: BookId, balance: ConsolidationSource["balances"][number]): { readonly rate: ExactRational } | readonly SemanticDiagnostic[] => {
    if (balance.unitsCommodityId === commodityId) {
      if (balance.valuationPaths.length !== 0) return Object.freeze([diagnostic("consolidation_input_violation", "command.consolidation.translation", "Same-commodity balances must not present an unnecessary valuation path", ["ACC-046.4"])]);
      return { rate: unit };
    }
    const ruleMatches = rules.filter((rule) => rule.sourceAccountId === balance.sourceAccountId && (rule.sourceBookId === undefined || rule.sourceBookId === sourceBookId) && compareInstants(rule.validFrom, request.governedAt) <= 0 && (rule.validTo === undefined || compareInstants(request.governedAt, rule.validTo) < 0));
    if (ruleMatches.length !== 1) return Object.freeze([diagnostic("consolidation_input_violation", "command.consolidation.translation", "Every translated balance requires exactly one canonical translation rule effective through the consolidation date", ["ACC-046.4"])]);
    const rule = ruleMatches[0]!;
    const targeted = resolvedTargets.get(coordinate(sourceBookId, balance.sourceAccountId));
    if (targeted !== rule.targetAccountId) return Object.freeze([diagnostic("consolidation_input_violation", "command.consolidation.translation", "A translation rule target must agree with the canonical account mapping for its source account", ["ACC-046.4"])]);
    const valuation = rule.valuationPolicy;
    if (compareInstants(valuation.validFrom, request.governedAt) > 0 || (valuation.validTo !== undefined && compareInstants(request.governedAt, valuation.validTo) >= 0) || valuation.maximumHops <= 0n || valuation.maximumHops > globalValuation.maximumHops || valuation.allowInverseObservation && !globalValuation.allowInverseObservation) {
      return Object.freeze([diagnostic("consolidation_input_violation", "command.consolidation.translation", "The translation rule's valuation policy is not effective through the consolidation instant", ["ACC-046.4"])]);
    }
    const candidates: { readonly id: string; readonly effectiveAt: Instant; readonly rate: ExactRational; readonly hops: number; readonly direct: boolean }[] = [];
    for (const path of balance.valuationPaths) {
      if (path.id.trim().length === 0 || path.steps.length === 0 || BigInt(path.steps.length) > valuation.maximumHops || compareInstants(path.effectiveAt, request.governedAt) > 0 || path.effectiveAt.slice(0, 10) !== request.throughOn) continue;
      let current = balance.unitsCommodityId;
      let rate = unit;
      let usedInverse = false;
      const visited = new Set<CommodityId>([current]);
      let admissible = true;
      for (const step of path.steps) {
        if (step.evidenceIds.length === 0 || !positive(step.rate) || compareInstants(step.observedAt, request.governedAt) > 0) { admissible = false; break; }
        let next: CommodityId;
        if (step.fromCommodityId === current) { next = step.toCommodityId; rate = rate.multiply(step.rate); }
        else if (valuation.allowInverseObservation && step.toCommodityId === current && step.fromCommodityId !== step.toCommodityId) { next = step.fromCommodityId; rate = rate.divide(step.rate); usedInverse = true; }
        else { admissible = false; break; }
        if (visited.has(next)) { admissible = false; break; }
        visited.add(next); current = next;
      }
      if (admissible && current === commodityId) candidates.push({ id: path.id, effectiveAt: path.effectiveAt, rate, hops: path.steps.length, direct: path.steps.length === 1 && !usedInverse });
    }
    if (candidates.length === 0) return Object.freeze([diagnostic("consolidation_input_violation", "command.consolidation.translation", "No complete evidence-backed valuation path is admissible under the applicable rule and policy", ["ACC-046.4"])]);
    const preferDirect = globalValuation.preferDirectObservation || valuation.preferDirectObservation;
    const preferred = preferDirect && candidates.some((candidate) => candidate.direct) ? candidates.filter((candidate) => candidate.direct) : candidates;
    preferred.sort((left, right) => left.hops - right.hops || compareInstants(right.effectiveAt, left.effectiveAt) || compareCanonicalText(left.id, right.id));
    const best = preferred[0]!;
    const ambiguous = preferred.some((candidate) => candidate !== best && candidate.hops === best.hops && compareInstants(candidate.effectiveAt, best.effectiveAt) === 0 && !candidate.rate.equals(best.rate));
    if (ambiguous) return Object.freeze([diagnostic("consolidation_input_violation", "command.consolidation.translation", "Equally preferred supplied valuation paths disagree on the exact rate", ["ACC-046.4"])]);
    return { rate: best.rate };
  };
  const resolvedTargets = new Map<string, AccountId>();
  for (const source of request.sources) for (const balance of source.balances) {
    const key = coordinate(source.bookId, balance.sourceAccountId);
    const target = resolveTarget(source.bookId, balance.sourceAccountId);
    if (isAccountingDiagnostics(target)) return Object.freeze({ disposition: "rejected", diagnostics: target });
    resolvedTargets.set(key, target);
  }
  const resolvedRates = new Map<string, ExactRational>();
  for (const source of request.sources) for (const balance of source.balances) {
    const rateKey = coordinate(source.bookId, balance.sourceAccountId);
    if (resolvedRates.has(rateKey)) return Object.freeze({ disposition: "rejected", diagnostics: Object.freeze([diagnostic("consolidation_input_violation", "command.consolidation.sources", "Each source account may present only one balance per consolidation", ["ACC-046.2"])]) });
    const rate = resolveRate(source.bookId, balance);
    if (isAccountingDiagnostics(rate)) return Object.freeze({ disposition: "rejected", diagnostics: rate });
    resolvedRates.set(rateKey, rate.rate);
  }
  const postings: ExactPreparedPosting[] = []; let ordinal = 0;
  const orderedSources = [...request.sources].sort((left, right) => compareCanonicalText(left.bookId, right.bookId));
  for (const source of orderedSources) {
    const factor = source.method === "full" ? unit : source.ownershipShare;
    const sourcePostingStart = postings.length;
    let translatedNetAssets = zero;
    const orderedBalances = [...source.balances].sort((left, right) => order([left.sourceAccountId, left.unitsCommodityId, left.classification], [right.sourceAccountId, right.unitsCommodityId, right.classification]));
    for (const balance of orderedBalances) {
      ordinal += 1;
      const translatedAmount = balance.amount.multiply(resolvedRates.get(coordinate(source.bookId, balance.sourceAccountId))!);
      const amount = translatedAmount.multiply(factor);
      if (balance.classification !== "equity") translatedNetAssets = translatedNetAssets.add(translatedAmount);
      postings.push({ id: identifier<"Posting">(`${request.id}-source-${ordinal}`), accountId: resolvedTargets.get(coordinate(source.bookId, balance.sourceAccountId))!, units: amount, unitsCommodityId: commodityId, exactBookValue: amount });
    }
    if (source.method === "full" && source.ownershipShare.compare(unit) < 0) {
      const nci = source.nonControllingInterestMethod === "fairValue"
        ? source.nonControllingInterestFairValue!
        : translatedNetAssets.multiply(unit.subtract(source.ownershipShare)).negate();
      ordinal += 1;
      postings.push({ id: identifier<"Posting">(`${request.id}-parent-equity-${ordinal}`), accountId: policy.parentAttributableEquityAccountId, units: nci.negate(), unitsCommodityId: commodityId, exactBookValue: nci.negate() });
      ordinal += 1;
      postings.push({ id: identifier<"Posting">(`${request.id}-nci-${ordinal}`), accountId: policy.nonControllingInterestAccountId, units: nci, unitsCommodityId: commodityId, exactBookValue: nci });
    }
    const sourceTranslatedTotal = sum(postings.slice(sourcePostingStart).map((item) => item.exactBookValue));
    if (!sourceTranslatedTotal.isZero()) {
      ordinal += 1;
      postings.push({ id: identifier<"Posting">(`${request.id}-translation-${ordinal}`), accountId: policy.translationAdjustmentAccountId, units: sourceTranslatedTotal.negate(), unitsCommodityId: commodityId, exactBookValue: sourceTranslatedTotal.negate() });
    }
  }
  for (const elimination of [...request.eliminations].sort((left, right) => order([left.sourceBookId, left.sourceAccountId, left.amount.toString()], [right.sourceBookId, right.sourceAccountId, right.amount.toString()]))) {
    ordinal += 1;
    postings.push({ id: identifier<"Posting">(`${request.id}-elimination-${ordinal}`), accountId: elimination.targetAccountId, units: elimination.amount, unitsCommodityId: commodityId, exactBookValue: elimination.amount });
  }
  if (sum(postings.map((item) => item.exactBookValue)).isZero() === false) return reject("consolidation_input_violation", "command.consolidation", "Consolidation draft is not balanced", ["ACC-046.6", "ACC-046.8"]);
  const body = { id: request.id, bookId: request.targetBookId, policyId: policy.id, throughOn: request.throughOn, sourcePopulationHashes: Object.freeze(orderedSources.map((source) => source.populationHash)), derivation: request.derivation }; const effect = Object.freeze({ ...body, contentHash: accountingHash("ConsolidationCompilation", body) });
  const journal: ExactPreparedJournal = Object.freeze({ id: identifier<"JournalTransaction">(`${request.id}-journal`), kind: "adjustment", economicAt: request.governedAt, accountingDate: request.throughOn, recordedAt: request.governedAt, narration: "Consolidation compilation", derivations: Object.freeze([request.derivation]), postings: Object.freeze(postings.map((item) => Object.freeze(item))) });
  return drafted([journal], [{ type: "consolidationCompilation", value: effect }]);
}

function contentHashEqual(left: ContentHash, right: ContentHash): boolean {
  return left.algorithm === right.algorithm && left.canonicalizationVersion === right.canonicalizationVersion && left.digest === right.digest;
}
function isAccountingDiagnostics(value: readonly SemanticDiagnostic[] | unknown): value is readonly SemanticDiagnostic[] {
  return Array.isArray(value);
}

export function canonicalAccountingEffectValue(effect: AccountingEffect): CanonicalValue {
  return { type: effect.type, value: canonicalize(effect.value) };
}

export function canonicalAccountingStateValue(state: AccountingCanonicalState): CanonicalValue {
  return canonicalize(state);
}

export function validateAccountingEffectHash(effect: AccountingEffect): boolean {
  if (effect.type === "allocationSchedule" && !allocationPlanIsValid(effect.value)) return false;
  if (effect.type === "allocationScheduleRevision" && (usesCumulativeAllocation(effect.value.policy)
    ? effect.value.postedRecognizedToDate === undefined || effect.value.postedCarryingAmountAtRevision === undefined
    : effect.value.postedRecognizedToDate !== undefined || effect.value.postedCarryingAmountAtRevision !== undefined)) return false;
  const { contentHash, ...body } = effect.value;
  const type = effect.type[0]!.toUpperCase() + effect.type.slice(1);
  const recomputed = accountingHash(type, body);
  return recomputed.algorithm === contentHash.algorithm && recomputed.canonicalizationVersion === contentHash.canonicalizationVersion && recomputed.digest === contentHash.digest;
}

export function accountingEffectExists(state: AccountingCanonicalState, effect: AccountingEffect): boolean {
  let family: readonly { readonly id: string }[];
  switch (effect.type) {
    case "provisionalInventoryLayer": family = state.provisionalInventoryLayers; break;
    case "inventoryRecosting": family = state.inventoryRecostings; break;
    case "inventoryValueAdjustment": family = state.inventoryValueAdjustments; break;
    case "openItem": family = state.openItems; break;
    case "settlement": family = state.settlements; break;
    case "settlementAllocation": family = state.settlementAllocations; break;
    case "remeasurementResult": family = state.remeasurementResults; break;
    case "remeasurementReversal": family = state.remeasurementReversals; break;
    case "allocationSchedule": family = state.allocationSchedules; break;
    case "allocationRecognition": family = state.allocationRecognitions; break;
    case "allocationScheduleRevision": family = state.allocationScheduleRevisions; break;
    case "taxDetermination": family = state.taxDeterminations; break;
    case "consolidationCompilation": family = state.consolidationCompilations; break;
  }
  for (const existing of family) if (existing.id === effect.value.id) return true;
  return false;
}

export function validateAccountingEffectAdmission(state: AccountingCanonicalState, effects: readonly AccountingEffect[], bookId: BookId): readonly SemanticDiagnostic[] {
  return validateAccountingEffectIdentities(effects, bookId, (effect) => accountingEffectExists(state, effect) ? "present" : "absent");
}

/** Same identity, scope and full-hash admission over transaction-scoped identity
 * observations. Missing evidence must never be substituted with absence. */
export function validateAccountingEffectIdentities(
  effects: readonly AccountingEffect[], bookId: BookId,
  identity: (effect: AccountingEffect) => "present" | "absent",
): readonly SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
  const identities = new Set<string>();
  for (const [index, effect] of effects.entries()) {
    const identityKey = `${effect.type}:${effect.value.id}`;
    const observed = identities.has(identityKey) ? "present" : identity(effect);
    if (observed !== "present" && observed !== "absent") throw new TypeError("Incomplete accounting effect identity evidence");
    const scopedBookId = effect.type === "provisionalInventoryLayer" || effect.type === "inventoryValueAdjustment" || effect.type === "openItem" || effect.type === "settlement" || effect.type === "allocationSchedule" || effect.type === "taxDetermination" || effect.type === "consolidationCompilation" ? effect.value.bookId : bookId;
    if (observed === "present" || scopedBookId !== bookId || !validateAccountingEffectHash(effect)) diagnostics.push(diagnostic("canonical_identity_conflict", `accountingDraft.effects[${index}]`, "Accounting effect identity, book scope, or complete content hash is invalid", ["ACC-038", "ACC-047.2", "ACC-047.5"]));
    identities.add(identityKey);
  }
  return Object.freeze(diagnostics);
}

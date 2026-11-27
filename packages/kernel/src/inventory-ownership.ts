import { contentHashEquals, hashCanonical, compareCanonicalText, CONTENT_HASH_ALGORITHM, CANONICALIZATION_VERSION, type ContentHash, type Identifier } from "./canonical.ts";
import { ACCOUNTING_LIMITS, canonicalAccountingValue, immutableAccountingValue, validateCanonicalPostingReferenceHash, createCanonicalPostingReference, effectKey, calculateInventoryCost, hashAccountingPolicy, validAccountingDerivation, verifyAccountingPolicyArtifacts, type AccountingPolicy, type InventoryCostPolicy, type InventoryCostRequest, type InventoryLayerInput, type CanonicalPostingReference, type CanonicalPostingReferenceId, type EffectKey } from "./accounting.ts";
import { canonicalJournalValue, diagnostic, type AccountId, type BookId, type CommodityId, type DimensionMemberId, type JournalTransaction, type LocalDate, type PostingId, type SemanticDiagnostic } from "./journal.ts";
import type { Lot, LotAllocation, LotHolding, LotHoldingId, LotId } from "./lots.ts";
import { ExactDecimal, ExactRational } from "./numeric.ts";
import type { DerivationRecord, PolicyId, SemanticVersion, SourceEvidence } from "./policy.ts";
import { quantize, quantizeCumulativePostedShare, type CumulativePostedShare, type QuantizationPolicy } from "./quantization.ts";
import { allocateInventoryPostedValue, type InventoryPostedValueBudget, type InventoryPostedValueAllocation } from "./inventory-posted-values.ts";

export interface InventoryPostedCoordinate {
  readonly bookId: BookId;
  readonly holdingId: LotHoldingId;
  readonly lotId: LotId;
  readonly accountId: AccountId;
  readonly unitsCommodityId: CommodityId;
  readonly functionalCommodityId: CommodityId;
  readonly dimensionMemberIds: readonly DimensionMemberId[];
}

export interface InventoryPostedArtifactReference {
  readonly id: string;
  readonly contentHash: ContentHash;
  readonly bookId: BookId;
  readonly effectKey: EffectKey;
  readonly artifactOrdinal: bigint;
  readonly bookRevision: bigint;
}

export interface InventoryPostedAnchorReference extends InventoryPostedArtifactReference {
  readonly id: Identifier<"InventoryPostedAnchor">;
}
export interface InventoryPostedPositionReference extends InventoryPostedArtifactReference {
  readonly id: LotHoldingId;
}
export interface InventoryPostedMovementReference extends InventoryPostedArtifactReference {
  readonly id: Identifier<"InventoryPostedMovement">;
}

/** A supplied historical artifact, NOT authority to create/adopt an anchor.
 * Source resolution, complete attribution and canonical effect verification are
 * command/ledger obligations. A reproducible hash alone proves none of them. */
export interface InventoryPostedAnchor {
  readonly id: Identifier<"InventoryPostedAnchor">;
  readonly algorithm: "cumulativePostedInventoryV1";
  readonly algorithmVersion: SemanticVersion;
  readonly quantity: ExactRational;
  readonly postedBudget: ExactDecimal;
  /** Explicit 1.1.0 component-bearing artifacts only; absent in old bytes. */
  readonly postedValue?: InventoryPostedValueBudget;
  readonly effectKey: EffectKey;
  readonly artifactOrdinal: bigint;
  readonly bookRevision: bigint;
  readonly contentHash: ContentHash;
  readonly coordinate: InventoryPostedCoordinate;
  readonly inventoryPolicy: { readonly policyId: PolicyId; readonly policyVersion: SemanticVersion; readonly policyContentHash: ContentHash };
  readonly quantizationPolicy: QuantizationPolicy;
  readonly predecessorPosition?: InventoryPostedPositionReference;
  readonly sourcePostings: readonly CanonicalPostingReference[];
  readonly incomingMovements: readonly InventoryPostedMovementReference[];
  readonly evidence: readonly SourceEvidence[];
}

export interface InventoryPostedPosition {
  readonly holdingId: LotHoldingId;
  readonly consumedQuantity: ExactRational;
  readonly consumedPosted: ExactDecimal;
  readonly contentHash: ContentHash;
  readonly anchor: InventoryPostedAnchorReference;
  readonly originMovementId: Identifier<"InventoryPostedMovement">;
  readonly originEffectKey: EffectKey;
  readonly originArtifactOrdinal: bigint;
  readonly originBookRevision: bigint;
}

export interface InventoryPostedReductionOrigin {
  readonly movementId: Identifier<"InventoryPostedMovement">;
  readonly effectKey: EffectKey;
  readonly artifactOrdinal: bigint;
  readonly bookRevision: bigint;
}

export function hashInventoryPostedAnchor(anchor: Omit<InventoryPostedAnchor, "contentHash"> & { readonly contentHash?: ContentHash }): ContentHash {
  const { contentHash: _contentHash, ...body } = anchor;
  return hashCanonical({ type: "InventoryPostedAnchor", value: canonicalAccountingValue(body) });
}

export function hashInventoryPostedPosition(position: Omit<InventoryPostedPosition, "contentHash"> & { readonly contentHash?: ContentHash }): ContentHash {
  const { contentHash: _contentHash, ...body } = position;
  return hashCanonical({ type: "InventoryPostedPosition", value: canonicalAccountingValue(body) });
}

export interface InventoryPostedReduction {
  /** Classification for later command assembly, not an admitted movement/effect. */
  readonly monetaryKind: "journalLinked" | "quantityOnly";
  readonly postedAmount: ExactDecimal;
  readonly beforePosition: InventoryPostedPositionReference;
  readonly afterPosition: InventoryPostedPosition;
  readonly afterHolding: LotHolding;
  readonly allocation: LotAllocation;
  readonly reductionProof: CumulativePostedShare;
  /** Positive posted reduction less positive exact economic carrying allocation. */
  readonly postedMinusEconomic: ExactRational;
  readonly postedValue?: InventoryPostedValueAllocation;
}

type OwnershipRejection = { readonly disposition: "rejected"; readonly diagnostics: readonly SemanticDiagnostic[] };
type ReductionResult = { readonly disposition: "prepared"; readonly reduction: InventoryPostedReduction } | OwnershipRejection;

function reject(path: string, message: string): OwnershipRejection {
  return Object.freeze({ disposition: "rejected", diagnostics: Object.freeze([
    diagnostic("lot_overallocation", path, message, ["ACC-039.7", "ACC-039.8", "ACC-039.9"]),
  ]) });
}

function fullHash(hash: ContentHash): boolean {
  return hash.algorithm === CONTENT_HASH_ALGORITHM && hash.canonicalizationVersion === CANONICALIZATION_VERSION && /^[0-9a-f]{64}$/.test(hash.digest);
}

function referenceValid(reference: InventoryPostedArtifactReference, bookId: BookId): boolean {
  return reference.id.length > 0 && reference.effectKey.length > 0 && reference.bookId === bookId && reference.artifactOrdinal > 0n && reference.bookRevision > 0n && fullHash(reference.contentHash);
}

function precedes(before: { readonly effectKey: EffectKey; readonly artifactOrdinal: bigint; readonly bookRevision: bigint }, after: { readonly effectKey: EffectKey; readonly artifactOrdinal: bigint; readonly bookRevision: bigint }): boolean {
  return before.bookRevision < after.bookRevision || (before.bookRevision === after.bookRevision && before.effectKey === after.effectKey && before.artifactOrdinal < after.artifactOrdinal);
}

function postedAnchorVersionValid(anchor: InventoryPostedAnchor): boolean {
  return anchor.algorithmVersion === "1.0.0" ? !Object.hasOwn(anchor, "postedValue")
    : anchor.algorithmVersion === "1.1.0" && anchor.postedValue !== undefined;
}

/** Prepares ONE already-selected disposal/transfer-out reduction. The caller
 * must authenticate the current holding, anchor and position/origin after-image,
 * prove complete lot selection, admit policy/coordinates/date/period/identities,
 * and retain the live read head through atomic publication. This does not create
 * an anchor, select a costing method, authorize a command, emit a journal or
 * persist a movement. Owned-command admission supplies those separate checks.
 * Foreign-basis allocations need separately designed valuation evidence; this
 * primitive never treats a foreign basis amount as a functional book amount. */
export function prepareInventoryPostedReduction(
  anchor: InventoryPostedAnchor,
  position: InventoryPostedPosition,
  holding: LotHolding,
  allocation: LotAllocation,
  origin: InventoryPostedReductionOrigin,
): ReductionResult {
  const coordinate = anchor.coordinate;
  const cap = ACCOUNTING_LIMITS.maxInventoryLayers;
  const sourceCount = anchor.sourcePostings.length + anchor.incomingMovements.length + anchor.evidence.length + (anchor.predecessorPosition === undefined ? 0 : 1);
  if (sourceCount > cap || coordinate.dimensionMemberIds.length > cap) {
    return reject("inventoryOwnership.anchor", "Posted ownership source populations exceed the per-artifact bound");
  }
  if (anchor.algorithm !== "cumulativePostedInventoryV1" || !postedAnchorVersionValid(anchor) ||
    !contentHashEquals(anchor.contentHash, hashInventoryPostedAnchor(anchor)) ||
    !contentHashEquals(position.contentHash, hashInventoryPostedPosition(position))) {
    return reject("inventoryOwnership.hash", "Posted ownership requires the supported algorithm and reproducible full anchor/position hashes");
  }
  const anchorReference: InventoryPostedAnchorReference = {
    id: anchor.id, contentHash: anchor.contentHash, bookId: coordinate.bookId,
    effectKey: anchor.effectKey, artifactOrdinal: anchor.artifactOrdinal, bookRevision: anchor.bookRevision,
  };
  const beforePosition: InventoryPostedPositionReference = {
    id: position.holdingId, contentHash: position.contentHash, bookId: coordinate.bookId,
    effectKey: position.originEffectKey, artifactOrdinal: position.originArtifactOrdinal, bookRevision: position.originBookRevision,
  };
  if (!referenceValid(anchorReference, coordinate.bookId) || !referenceValid(position.anchor, coordinate.bookId) ||
    !referenceValid(beforePosition, coordinate.bookId) || !fullHash(anchor.inventoryPolicy.policyContentHash) ||
    position.originMovementId.length === 0 || origin.movementId.length === 0 || origin.effectKey.length === 0 || origin.artifactOrdinal <= 0n || origin.bookRevision <= 0n ||
    position.originMovementId === origin.movementId || !precedes(anchorReference, beforePosition) || !precedes(beforePosition, origin) ||
    !contentHashEquals(hashCanonical(canonicalAccountingValue(position.anchor)), hashCanonical(canonicalAccountingValue(anchorReference)))) {
    return reject("inventoryOwnership.lineage", "Posted ownership must bind the exact anchor and strictly earlier same-book artifact origins");
  }
  const sourceReferences = [...anchor.incomingMovements, ...(anchor.predecessorPosition === undefined ? [] : [anchor.predecessorPosition])];
  if (sourceCount === 0 ||
    sourceReferences.some((reference) => !referenceValid(reference, coordinate.bookId) || !precedes(reference, anchorReference)) ||
    new Set(anchor.incomingMovements.map((reference) => reference.id)).size !== anchor.incomingMovements.length ||
    anchor.sourcePostings.some((reference) => reference.bookId !== coordinate.bookId || !validateCanonicalPostingReferenceHash(reference)) ||
    new Set(anchor.sourcePostings.map((reference) => reference.postingId)).size !== anchor.sourcePostings.length ||
    anchor.evidence.some((evidence) => !fullHash(evidence.contentHash)) ||
    new Set(anchor.evidence.map((evidence) => evidence.id)).size !== anchor.evidence.length) {
    return reject("inventoryOwnership.sources", "Posted ownership source references must be unique, same-book and structurally coherent; their existence still requires authentication");
  }
  if (coordinate.holdingId !== holding.id || position.holdingId !== holding.id || coordinate.bookId !== holding.bookId ||
    coordinate.lotId !== holding.lotId || coordinate.accountId !== holding.accountId || coordinate.unitsCommodityId !== holding.commodityId ||
    coordinate.functionalCommodityId !== holding.basisCommodityId || anchor.quantizationPolicy.bookId !== coordinate.bookId || anchor.quantizationPolicy.functionalCommodityId !== coordinate.functionalCommodityId ||
    coordinate.dimensionMemberIds.some((id, index, ids) => index > 0 && compareCanonicalText(ids[index - 1]!, id) >= 0)) {
    return reject("inventoryOwnership.coordinate", "Holding and ownership book, lot, account, commodity and canonical dimension coordinates must agree without currency substitution");
  }
  if (anchor.quantity.compare(ExactRational.zero()) <= 0 || position.consumedQuantity.isNegative() || position.consumedQuantity.compare(anchor.quantity) > 0 ||
    !holding.remainingQuantity.equals(anchor.quantity.subtract(position.consumedQuantity)) ||
    allocation.holdingId !== holding.id || allocation.lotId !== holding.lotId || allocation.allocatedQuantity.compare(ExactRational.zero()) <= 0 || allocation.allocatedQuantity.compare(holding.remainingQuantity) > 0) {
    return reject("inventoryOwnership.quantity", "Positive reduction must fit the exact holding and the anchor's cumulative quantity position");
  }
  const consumedQuantity = position.consumedQuantity.add(allocation.allocatedQuantity);
  const planned = quantizeCumulativePostedShare(anchor.postedBudget, position.consumedQuantity.divide(anchor.quantity), consumedQuantity.divide(anchor.quantity), anchor.quantizationPolicy);
  if (planned.disposition === "rejected") return planned;
  if (!position.consumedPosted.toRational().equals(planned.share.beforeQuantization.amount.toRational())) {
    return reject("inventoryOwnership.consumedPosted", "Recorded posted consumption must equal the pinned anchor's cumulative quantized target");
  }
  const fraction = allocation.allocatedQuantity.divide(holding.remainingQuantity);
  const basis = holding.remainingTotalBasis.multiply(fraction);
  const allowance = holding.remainingValuationAllowance.multiply(fraction);
  const carrying = basis.add(allowance);
  if (holding.remainingTotalBasis.isNegative() || !holding.remainingValuationAllowance.isZero() && !holding.remainingValuationAllowance.isNegative() || holding.remainingCarryingAmount.isNegative() ||
    !holding.remainingCarryingAmount.equals(holding.remainingTotalBasis.add(holding.remainingValuationAllowance)) ||
    !allocation.allocatedTotalBasis.equals(basis) || !allocation.allocatedValuationAllowance.equals(allowance) || !allocation.allocatedCarryingAmount.equals(carrying)) {
    return reject("inventoryOwnership.allocation", "Economic allocation must preserve the holding's separate exact basis, allowance and carrying amount");
  }
  const afterBody = {
    holdingId: holding.id, consumedQuantity, consumedPosted: planned.share.afterQuantization.amount,
    anchor: anchorReference, originMovementId: origin.movementId, originEffectKey: origin.effectKey,
    originArtifactOrdinal: origin.artifactOrdinal, originBookRevision: origin.bookRevision,
  };
  let postedValue: InventoryPostedValueAllocation | undefined;
  if (anchor.postedValue !== undefined) {
    const values = allocateInventoryPostedValue(anchor.postedValue, planned.share.beforeFraction, planned.share.afterFraction, anchor.quantizationPolicy);
    if (values.disposition === "rejected") return values;
    if (!values.carryingProof.postedTotal.toRational().equals(anchor.postedBudget.toRational())) {
      return reject("inventoryOwnership.postedValue", "Posted components must equal the authenticated anchor's net budget");
    }
    postedValue = values;
  }
  const reduction: InventoryPostedReduction = {
    monetaryKind: planned.share.postedAmount.isZero() ? "quantityOnly" : "journalLinked",
    postedAmount: ExactDecimal.of(-planned.share.postedAmount.coefficient, planned.share.postedAmount.scale),
    beforePosition, afterPosition: { ...afterBody, contentHash: hashInventoryPostedPosition(afterBody) },
    afterHolding: { ...holding, remainingQuantity: holding.remainingQuantity.subtract(allocation.allocatedQuantity),
      remainingTotalBasis: holding.remainingTotalBasis.subtract(basis), remainingValuationAllowance: holding.remainingValuationAllowance.subtract(allowance), remainingCarryingAmount: holding.remainingCarryingAmount.subtract(carrying) },
    allocation, reductionProof: planned.share,
    postedMinusEconomic: planned.share.postedAmount.toRational().subtract(carrying),
    ...(postedValue === undefined ? {} : { postedValue }),
  };
  return Object.freeze({ disposition: "prepared", reduction: immutableAccountingValue(reduction) });
}

interface InventoryPostedReductionMovementBody {
  readonly id: Identifier<"InventoryPostedMovement">;
  readonly kind: "disposal" | "transferOut";
  readonly effectKey: EffectKey;
  readonly artifactOrdinal: bigint;
  readonly bookRevision: bigint;
  readonly accountingDate: LocalDate;
  readonly fiscalPeriodId: Identifier<"FiscalPeriod">;
  readonly coordinate: InventoryPostedCoordinate;
  readonly postedAmount: ExactDecimal;
  readonly beforePosition: InventoryPostedPositionReference;
  readonly afterPosition: InventoryPostedPosition;
  readonly quantityAllocation: LotAllocation;
  readonly reductionProof: CumulativePostedShare;
  readonly incomingSources: readonly InventoryPostedMovementReference[];
}

export interface JournalLinkedInventoryReductionMovement extends InventoryPostedReductionMovementBody {
  readonly monetaryKind: "journalLinked";
  readonly posting: CanonicalPostingReference;
  readonly contentHash: ContentHash;
}

export interface QuantityOnlyInventoryReductionMovement extends InventoryPostedReductionMovementBody {
  readonly monetaryKind: "quantityOnly";
  readonly posting?: never;
  readonly contentHash: ContentHash;
}

export type InventoryPostedReductionMovement = JournalLinkedInventoryReductionMovement | QuantityOnlyInventoryReductionMovement;
type MovementHashInput = (Omit<JournalLinkedInventoryReductionMovement, "contentHash"> | Omit<QuantityOnlyInventoryReductionMovement, "contentHash">) & { readonly contentHash?: ContentHash };

export function hashInventoryPostedReductionMovement(movement: MovementHashInput): ContentHash {
  const { contentHash: _contentHash, ...body } = movement;
  return hashCanonical({ type: "InventoryPostedMovement", value: canonicalAccountingValue(body) });
}

export interface InventoryPostedReductionEntry {
  readonly movementId: Identifier<"InventoryPostedMovement">;
  readonly anchor: InventoryPostedAnchor;
  readonly position: InventoryPostedPosition;
  readonly holding: LotHolding;
  readonly allocation: LotAllocation;
}

export interface InventoryReductionJournalSource {
  readonly journal: JournalTransaction;
  readonly commandId: Identifier<"BookCommand">;
  readonly effectKey: string;
  readonly bookRevision: bigint;
  readonly fiscalPeriodId: Identifier<"FiscalPeriod">;
  readonly canonicalHash: ContentHash;
}

export interface InventoryPostedReductionGroupContext {
  readonly bookId: BookId;
  readonly commandId: Identifier<"BookCommand">;
  readonly kind: "disposal" | "transferOut";
  readonly effectKey: EffectKey;
  readonly bookRevision: bigint;
  readonly firstArtifactOrdinal: bigint;
  readonly accountingDate: LocalDate;
  readonly fiscalPeriodId: Identifier<"FiscalPeriod">;
}

export interface InventoryPostedReductionGroup {
  readonly movements: readonly InventoryPostedReductionMovement[];
  readonly afterHoldings: readonly LotHolding[];
  readonly postedAmount: ExactRational;
  readonly quantity: ExactRational;
  readonly historicalBasis: ExactRational;
}

interface InventoryPostedAcquisitionMovementBody {
  readonly id: Identifier<"InventoryPostedMovement">;
  readonly kind: "acquisition" | "transferIn" | "legacyAdoption";
  readonly effectKey: EffectKey;
  readonly artifactOrdinal: bigint;
  readonly bookRevision: bigint;
  readonly accountingDate: LocalDate;
  readonly fiscalPeriodId: Identifier<"FiscalPeriod">;
  readonly coordinate: InventoryPostedCoordinate;
  readonly postedAmount: ExactDecimal;
  readonly afterPosition: InventoryPostedPosition;
  readonly acquisitionProof: CumulativePostedShare;
  readonly incomingSources: readonly InventoryPostedMovementReference[];
}
export type InventoryPostedAcquisitionMovement = InventoryPostedAcquisitionMovementBody & (
  { readonly monetaryKind: "journalLinked"; readonly posting: CanonicalPostingReference } |
  { readonly monetaryKind: "quantityOnly"; readonly posting?: never }
) & { readonly contentHash: ContentHash };
export function hashInventoryPostedAcquisitionMovement(movement: Omit<InventoryPostedAcquisitionMovement, "contentHash"> & { readonly contentHash?: ContentHash }): ContentHash {
  const { contentHash: _contentHash, ...body } = movement;
  return hashCanonical({ type: "InventoryPostedMovement", value: canonicalAccountingValue(body) });
}
export interface InventoryPostedAcquisitionEntry {
  readonly anchorId: InventoryPostedAnchor["id"];
  readonly movementId: InventoryPostedPosition["originMovementId"];
  readonly lot: Lot;
  readonly holding: LotHolding;
  readonly evidence: readonly SourceEvidence[];
}
export interface InventoryPostedAcquisitionContext extends Omit<InventoryPostedReductionGroupContext, "kind"> {
  readonly inventoryPolicy: InventoryPostedAnchor["inventoryPolicy"];
  readonly quantizationPolicy: QuantizationPolicy;
  readonly dimensionMemberIds: readonly DimensionMemberId[];
}
export interface InventoryPostedAcquisitionGroup {
  readonly anchors: readonly InventoryPostedAnchor[];
  readonly movements: readonly InventoryPostedAcquisitionMovement[];
  readonly lots: readonly Lot[];
  readonly holdings: readonly LotHolding[];
  readonly postedAmount: ExactDecimal;
}

/** Constructs first anchors and origin movements for ONE complete acquisition
 * posting group. This is a candidate, not policy/evidence authorization or a
 * BookCommand. The caller must prove source admission, full group membership,
 * fresh permanent IDs and same-head atomic publication. No legacy adoption.
 * Actual posting money is distributed by cumulative exact carrying proportions
 * in holding-ID order, never by independently rounding each holding's basis.
 */
export function prepareInventoryPostedAcquisitionGroup(
  context: InventoryPostedAcquisitionContext,
  entries: readonly InventoryPostedAcquisitionEntry[],
  journalLink?: NonNullable<Parameters<typeof prepareInventoryPostedReductionGroup>[2]>,
): { readonly disposition: "prepared"; readonly group: InventoryPostedAcquisitionGroup } | OwnershipRejection {
  const cap = ACCOUNTING_LIMITS.maxInventoryLayers, policy = context.quantizationPolicy;
  if (entries.length === 0 || entries.length > cap || context.dimensionMemberIds.length > cap || (journalLink?.source.journal.postings.length ?? 0) > cap) {
    return reject("inventoryOwnership.acquisition", "Acquisition inputs must fit bounded nonempty group and source populations");
  }
  let evidenceWork = 0;
  for (const entry of entries) {
    evidenceWork += entry.evidence.length + entry.lot.evidenceIds.length;
    if (evidenceWork > cap) return reject("inventoryOwnership.acquisition", "Acquisition evidence exceeds the combined work bound");
  }
  if (context.bookRevision <= 0n || context.firstArtifactOrdinal <= 0n || context.effectKey.length === 0 || context.commandId.length === 0 ||
    context.inventoryPolicy.policyId.length === 0 || context.inventoryPolicy.policyVersion.length === 0 || !fullHash(context.inventoryPolicy.policyContentHash) ||
    policy.bookId !== context.bookId || new Set(entries.map((e) => e.holding.id)).size !== entries.length ||
    new Set(entries.map((e) => e.lot.id)).size !== entries.length || new Set(entries.map((e) => e.anchorId)).size !== entries.length ||
    new Set(entries.map((e) => e.movementId)).size !== entries.length ||
    context.dimensionMemberIds.some((id, i, ids) => i > 0 && compareCanonicalText(ids[i - 1]!, id) >= 0)) {
    return reject("inventoryOwnership.acquisitionIdentity", "Acquisition requires unique local identities, canonical dimensions and pinned policy/origin metadata");
  }
  const zeroCheck = quantizeCumulativePostedShare(ExactDecimal.of(0n, 0n), ExactRational.zero(), ExactRational.zero(), policy);
  if (zeroCheck.disposition === "rejected") return zeroCheck;
  const ordered = [...entries].sort((a, b) => compareCanonicalText(a.holding.id, b.holding.id)), first = ordered[0]!.holding;
  let quantity = ExactRational.zero(), basis = ExactRational.zero(), carrying = ExactRational.zero();
  for (const entry of ordered) {
    const { lot, holding: h, evidence } = entry;
    if (entry.anchorId.length === 0 || entry.movementId.length === 0 || lot.id.length === 0 || h.id.length === 0 ||
      lot.bookId !== context.bookId || h.bookId !== context.bookId || h.lotId !== lot.id ||
      h.accountId !== first.accountId || h.commodityId !== first.commodityId || lot.commodityId !== h.commodityId ||
      h.basisCommodityId !== policy.functionalCommodityId || lot.basisCommodityId !== h.basisCommodityId ||
      lot.acquisitionQuantity.compare(ExactRational.zero()) <= 0 || lot.acquisitionTotalBasis.isNegative() ||
      !h.remainingQuantity.equals(lot.acquisitionQuantity) || !h.remainingTotalBasis.equals(lot.acquisitionTotalBasis) ||
      h.remainingValuationAllowance.compare(ExactRational.zero()) > 0 || h.remainingCarryingAmount.isNegative() ||
      !h.remainingCarryingAmount.equals(h.remainingTotalBasis.add(h.remainingValuationAllowance)) ||
      evidence.length === 0 || evidence.some((item) => item.id.length === 0 || !fullHash(item.contentHash)) ||
      new Set(evidence.map((item) => item.id)).size !== evidence.length ||
      !sameOwnershipValue([...lot.evidenceIds].sort(compareCanonicalText), evidence.map((item) => item.id).sort(compareCanonicalText))) {
      return reject("inventoryOwnership.acquisitionSource", "New lots require coherent positive quantities, same-coordinate exact economic values and complete evidence identities");
    }
    quantity = quantity.add(h.remainingQuantity); basis = basis.add(h.remainingTotalBasis); carrying = carrying.add(h.remainingCarryingAmount);
  }
  let posted = ExactDecimal.of(0n, policy.targetScale), posting: CanonicalPostingReference | undefined;
  if (journalLink === undefined) {
    if (!quantize(carrying, policy).amount.isZero()) return reject("inventoryOwnership.acquisitionPosting", "A nonzero acquisition carrying target requires its actual admitted posting");
  } else {
    const { source } = journalLink;
    if (source.commandId !== context.commandId || source.bookRevision !== context.bookRevision || source.fiscalPeriodId !== context.fiscalPeriodId ||
      source.journal.bookId !== context.bookId || source.journal.functionalCommodityId !== policy.functionalCommodityId || source.journal.accountingDate !== context.accountingDate ||
      source.effectKey.length === 0 || source.effectKey === context.effectKey || !contentHashEquals(source.canonicalHash, hashCanonical(canonicalJournalValue(source.journal)))) {
      return reject("inventoryOwnership.acquisitionJournal", "Acquisition journal must match the candidate's book, origin, date, period and complete hash");
    }
    const matches = source.journal.postings.filter((item) => item.id === journalLink.postingId), actual = matches[0];
    if (matches.length !== 1 || actual === undefined || actual.accountId !== first.accountId || actual.units.commodityId !== first.commodityId ||
      actual.bookValue.functionalCommodityId !== policy.functionalCommodityId || !actual.units.canonicalNumber.equals(quantity) ||
      actual.costBasis?.basisCommodityId !== policy.functionalCommodityId || !actual.costBasis.totalBasis.equals(basis) ||
      !sameOwnershipValue([...actual.dimensionMemberIds].sort(compareCanonicalText), context.dimensionMemberIds) ||
      actual.bookValue.amount.toRational().compare(ExactRational.zero()) <= 0 || carrying.isZero()) {
      return reject("inventoryOwnership.acquisitionPosting", "One actual positive inventory posting must cover the group's full coordinate, units and historical basis");
    }
    posted = actual.bookValue.amount;
    posting = createCanonicalPostingReference(journalLink.referenceId, context.bookId, source.journal.id, actual, effectKey(source.effectKey));
  }
  const anchors: InventoryPostedAnchor[] = [], movements: InventoryPostedAcquisitionMovement[] = [];
  let cumulative = ExactRational.zero();
  const denominator = carrying.isZero() ? quantity : carrying;
  for (const [index, entry] of ordered.entries()) {
    const weight = carrying.isZero() ? entry.holding.remainingQuantity : entry.holding.remainingCarryingAmount;
    const next = cumulative.add(weight), share = quantizeCumulativePostedShare(posted, cumulative.divide(denominator), next.divide(denominator), policy);
    if (share.disposition === "rejected") return share;
    const h = entry.holding, ordinal = context.firstArtifactOrdinal + BigInt(index), movementOrdinal = ordinal + BigInt(ordered.length);
    const anchorBody: Omit<InventoryPostedAnchor, "contentHash"> = {
      id: entry.anchorId, algorithm: "cumulativePostedInventoryV1", algorithmVersion: "1.0.0" as SemanticVersion,
      quantity: h.remainingQuantity, postedBudget: share.share.postedAmount, effectKey: context.effectKey, artifactOrdinal: ordinal, bookRevision: context.bookRevision,
      coordinate: { bookId: context.bookId, holdingId: h.id, lotId: h.lotId, accountId: h.accountId, unitsCommodityId: h.commodityId,
        functionalCommodityId: policy.functionalCommodityId, dimensionMemberIds: context.dimensionMemberIds },
      inventoryPolicy: context.inventoryPolicy, quantizationPolicy: policy, sourcePostings: posting === undefined ? [] : [posting], incomingMovements: [], evidence: entry.evidence,
    };
    const anchor = { ...anchorBody, contentHash: hashInventoryPostedAnchor(anchorBody) };
    const positionBody: Omit<InventoryPostedPosition, "contentHash"> = { holdingId: h.id, consumedQuantity: ExactRational.zero(), consumedPosted: ExactDecimal.of(0n, policy.targetScale),
      anchor: { id: anchor.id, contentHash: anchor.contentHash, bookId: context.bookId, effectKey: anchor.effectKey, artifactOrdinal: ordinal, bookRevision: context.bookRevision },
      originMovementId: entry.movementId, originEffectKey: context.effectKey, originArtifactOrdinal: movementOrdinal, originBookRevision: context.bookRevision };
    const body: InventoryPostedAcquisitionMovementBody = { id: entry.movementId, kind: "acquisition", effectKey: context.effectKey, artifactOrdinal: movementOrdinal,
      bookRevision: context.bookRevision, accountingDate: context.accountingDate, fiscalPeriodId: context.fiscalPeriodId, coordinate: anchor.coordinate,
      postedAmount: anchor.postedBudget, afterPosition: { ...positionBody, contentHash: hashInventoryPostedPosition(positionBody) }, acquisitionProof: share.share, incomingSources: [] };
    const movement = body.postedAmount.isZero() ? { ...body, monetaryKind: "quantityOnly" as const } : { ...body, monetaryKind: "journalLinked" as const, posting: posting! };
    anchors.push(anchor); movements.push({ ...movement, contentHash: hashInventoryPostedAcquisitionMovement(movement) }); cumulative = next;
  }
  return Object.freeze({ disposition: "prepared", group: immutableAccountingValue({ anchors, movements, lots: ordered.map((e) => e.lot), holdings: ordered.map((e) => e.holding), postedAmount: posted }) });
}

/** Assembles ONE complete operation/posting group, in canonical holding-ID order.
 * Recomputes every reduction; supplied prepared results are never authority.
 * Multiple holdings may share a posting only at one book/account/commodity/
 * dimension coordinate. Its units and basis cover ALL group allocations,
 * including zero-money ones. Only nonzero movements carry the actual reference.
 *
 * The caller preserves operation-group order and must prove group completeness, unique posting ownership across all
 * groups, complete source admission and current positions, and supply a journal
 * already admitted for this command/revision/date/period. The journal hash check
 * is integrity, not proof of durable existence or account/policy authorization.
 * This function neither emits/adopts that journal nor commits an ownership effect;
 * BookCommand, source-closure, strict codecs and replay integration remain open. */
export function prepareInventoryPostedReductionGroup(
  context: InventoryPostedReductionGroupContext,
  entries: readonly InventoryPostedReductionEntry[],
  journalLink?: { readonly source: InventoryReductionJournalSource; readonly postingId: PostingId; readonly referenceId: CanonicalPostingReferenceId },
): { readonly disposition: "prepared"; readonly group: InventoryPostedReductionGroup } | OwnershipRejection {
  const cap = ACCOUNTING_LIMITS.maxInventoryLayers;
  if (entries.length === 0 || entries.length > cap || (journalLink !== undefined && journalLink.source.journal.postings.length > cap)) {
    return reject("inventoryOwnership.group", "A reduction group must contain a bounded nonempty allocation population and bounded journal sources");
  }
  let sources = 0;
  for (const { anchor } of entries) {
    sources += anchor.sourcePostings.length + anchor.incomingMovements.length + anchor.evidence.length + (anchor.predecessorPosition === undefined ? 0 : 1);
    if (sources > cap) return reject("inventoryOwnership.group", "Combined reduction-group source populations exceed the operation bound");
  }
  if (!(["disposal", "transferOut"] as const).includes(context.kind) || context.bookRevision <= 0n || context.firstArtifactOrdinal <= 0n || context.effectKey.length === 0 || context.commandId.length === 0 ||
    new Set(entries.map((entry) => entry.holding.id)).size !== entries.length ||
    new Set(entries.map((entry) => entry.anchor.id)).size !== entries.length ||
    new Set(entries.map((entry) => entry.allocation.id)).size !== entries.length ||
    new Set(entries.map((entry) => entry.movementId)).size !== entries.length) {
    return reject("inventoryOwnership.groupIdentity", "A reduction group requires a supported kind, committed origin and distinct holding, anchor, allocation and movement identities");
  }
  const reductions: InventoryPostedReduction[] = [];
  let postedAmount = ExactRational.zero(), quantity = ExactRational.zero(), historicalBasis = ExactRational.zero();
  const ordered = [...entries].sort((left, right) => compareCanonicalText(left.holding.id, right.holding.id));
  const coordinate = ordered[0]!.anchor.coordinate;
  for (const [index, entry] of ordered.entries()) {
    const c = entry.anchor.coordinate;
    if (c.bookId !== context.bookId || c.accountId !== coordinate.accountId || c.unitsCommodityId !== coordinate.unitsCommodityId ||
      c.functionalCommodityId !== coordinate.functionalCommodityId || c.dimensionMemberIds.length !== coordinate.dimensionMemberIds.length ||
      c.dimensionMemberIds.some((id, index) => id !== coordinate.dimensionMemberIds[index])) {
      return reject("inventoryOwnership.groupCoordinate", "One posting group cannot combine different book, account, commodity or dimension coordinates");
    }
    const prepared = prepareInventoryPostedReduction(entry.anchor, entry.position, entry.holding, entry.allocation, {
      movementId: entry.movementId, effectKey: context.effectKey, bookRevision: context.bookRevision,
      artifactOrdinal: context.firstArtifactOrdinal + BigInt(index),
    });
    if (prepared.disposition === "rejected") return prepared;
    reductions.push(prepared.reduction);
    postedAmount = postedAmount.add(prepared.reduction.postedAmount.toRational());
    quantity = quantity.add(entry.allocation.allocatedQuantity);
    historicalBasis = historicalBasis.add(entry.allocation.allocatedTotalBasis);
  }
  let posting: CanonicalPostingReference | undefined;
  if (postedAmount.isZero()) {
    if (journalLink !== undefined) return reject("inventoryOwnership.posting", "An all-zero reduction group has no inventory posting or fabricated posting reference");
  } else {
    if (journalLink === undefined) return reject("inventoryOwnership.posting", "A money-bearing reduction group requires its actual admitted inventory posting");
    const { source } = journalLink;
    if (source.commandId !== context.commandId || source.journal.bookId !== context.bookId || source.journal.functionalCommodityId !== coordinate.functionalCommodityId ||
      source.bookRevision !== context.bookRevision || source.fiscalPeriodId !== context.fiscalPeriodId || source.journal.accountingDate !== context.accountingDate ||
      source.effectKey.length === 0 || source.effectKey === context.effectKey ||
      !contentHashEquals(source.canonicalHash, hashCanonical(canonicalJournalValue(source.journal)))) {
      return reject("inventoryOwnership.journalSource", "The complete journal source must match this book, revision, date, fiscal period and canonical hash");
    }
    const matches = source.journal.postings.filter((p) => p.id === journalLink.postingId);
    if (matches.length !== 1) return reject("inventoryOwnership.posting", "The group must resolve exactly one actual inventory posting");
    const actual = matches[0]!;
    const dimensions = [...actual.dimensionMemberIds].sort(compareCanonicalText);
    if (actual.accountId !== coordinate.accountId || actual.units.commodityId !== coordinate.unitsCommodityId || actual.bookValue.functionalCommodityId !== coordinate.functionalCommodityId ||
      dimensions.length !== coordinate.dimensionMemberIds.length || dimensions.some((id, index) => id !== coordinate.dimensionMemberIds[index]) ||
      !actual.bookValue.amount.toRational().equals(postedAmount) || !actual.units.canonicalNumber.equals(quantity.negate()) ||
      actual.costBasis === undefined || actual.costBasis.basisCommodityId !== coordinate.functionalCommodityId || !actual.costBasis.totalBasis.equals(historicalBasis.negate())) {
      return reject("inventoryOwnership.postingAttribution", "The inventory posting must exactly cover the group's signed money, complete quantity, historical basis and coordinate");
    }
    posting = createCanonicalPostingReference(journalLink.referenceId, context.bookId, source.journal.id, actual, effectKey(source.effectKey));
  }
  const movements = reductions.map((reduction, index): InventoryPostedReductionMovement => {
    const entry = ordered[index]!;
    const body: InventoryPostedReductionMovementBody = {
      id: entry.movementId, kind: context.kind, effectKey: context.effectKey, bookRevision: context.bookRevision,
      artifactOrdinal: context.firstArtifactOrdinal + BigInt(index), accountingDate: context.accountingDate, fiscalPeriodId: context.fiscalPeriodId,
      coordinate: entry.anchor.coordinate, postedAmount: reduction.postedAmount, beforePosition: reduction.beforePosition, afterPosition: reduction.afterPosition,
      quantityAllocation: reduction.allocation, reductionProof: reduction.reductionProof, incomingSources: [],
    };
    const variant: MovementHashInput = reduction.monetaryKind === "quantityOnly"
      ? { ...body, monetaryKind: "quantityOnly" }
      : { ...body, monetaryKind: "journalLinked", posting: posting! };
    return { ...variant, contentHash: hashInventoryPostedReductionMovement(variant) };
  });
  return Object.freeze({ disposition: "prepared", group: immutableAccountingValue({ movements, afterHoldings: reductions.map((reduction) => reduction.afterHolding), postedAmount, quantity, historicalBasis }) });
}

export interface InventoryPostedTransferEntry {
  readonly source: InventoryPostedReductionSource;
  readonly allocation: LotAllocation;
  readonly transferOutMovementId: InventoryPostedPosition["originMovementId"];
  readonly destinationAnchorId: InventoryPostedAnchor["id"];
  readonly destinationMovementId: InventoryPostedPosition["originMovementId"];
  readonly destinationHolding: LotHolding;
  readonly destinationLot: Lot;
  readonly evidence: readonly SourceEvidence[];
}

export interface InventoryPostedTransferGroupContext extends InventoryReductionEffectContext {
  readonly firstArtifactOrdinal: bigint;
  readonly destinationInventoryPolicy: InventoryPostedAnchor["inventoryPolicy"];
  readonly destinationQuantizationPolicy: QuantizationPolicy;
  readonly destinationDimensionMemberIds: readonly DimensionMemberId[];
}

export interface InventoryPostedTransferGroup {
  readonly transferOutMovements: readonly InventoryPostedReductionMovement[];
  readonly destinationAnchors: readonly InventoryPostedAnchor[];
  readonly destinationMovements: readonly InventoryPostedAcquisitionMovement[];
  readonly destinationLots: readonly Lot[];
  readonly destinationHoldings: readonly LotHolding[];
  readonly afterSourceHoldings: readonly LotHolding[];
  readonly afterSourcePositions: readonly InventoryPostedPosition[];
  readonly transferredPostedAmount: ExactDecimal;
  readonly transferredQuantity: ExactRational;
}

/** Constructs complete reduction, anchor and movement artifacts for ONE transfer group.
 * Transferred posted money is taken directly from the source cumulative posted share
 * without rerounding in destination order. */
export function prepareInventoryPostedTransferGroup(
  context: InventoryPostedTransferGroupContext,
  entries: readonly InventoryPostedTransferEntry[],
  sourceJournalLink?: { readonly source: InventoryReductionJournalSource; readonly postingId: PostingId; readonly referenceId: CanonicalPostingReferenceId },
  destinationJournalLink?: { readonly source: InventoryReductionJournalSource; readonly postingId: PostingId; readonly referenceId: CanonicalPostingReferenceId },
): { readonly disposition: "prepared"; readonly group: InventoryPostedTransferGroup } | OwnershipRejection {
  const cap = ACCOUNTING_LIMITS.maxInventoryLayers;
  if (entries.length === 0 || entries.length > cap ||
    (sourceJournalLink !== undefined && sourceJournalLink.source.journal.postings.length > cap) ||
    (destinationJournalLink !== undefined && destinationJournalLink.source.journal.postings.length > cap)) {
    return reject("inventoryOwnership.group", "A transfer group must contain a bounded nonempty allocation population and bounded journal sources");
  }
  let sources = 0;
  for (const { source, evidence } of entries) {
    sources += source.anchor.sourcePostings.length + source.anchor.incomingMovements.length + source.anchor.evidence.length + evidence.length + (source.anchor.predecessorPosition === undefined ? 0 : 1);
    if (sources > cap) return reject("inventoryOwnership.group", "Combined transfer-group source populations exceed the operation bound");
  }
  if (context.bookRevision <= 0n || context.firstArtifactOrdinal <= 0n || context.effectKey.length === 0 || context.commandId.length === 0 ||
    !fullHash(context.destinationInventoryPolicy.policyContentHash) || context.destinationQuantizationPolicy.bookId !== context.bookId ||
    new Set(entries.map((e) => e.source.holding.id)).size !== entries.length ||
    new Set(entries.map((e) => e.destinationHolding.id)).size !== entries.length ||
    new Set(entries.map((e) => e.destinationLot.id)).size !== entries.length ||
    new Set(entries.map((e) => e.destinationAnchorId)).size !== entries.length ||
    new Set(entries.map((e) => e.destinationMovementId)).size !== entries.length ||
    new Set(entries.map((e) => e.transferOutMovementId)).size !== entries.length ||
    new Set(entries.map((e) => e.allocation.id)).size !== entries.length ||
    context.destinationDimensionMemberIds.some((id, i, ids) => i > 0 && compareCanonicalText(ids[i - 1]!, id) >= 0)) {
    return reject("inventoryOwnership.groupIdentity", "A transfer group requires valid policies, canonical dimensions and distinct source/destination identities");
  }
  const ordered = [...entries].sort((left, right) => compareCanonicalText(left.source.holding.id, right.source.holding.id));
  const sourceCoordinate = ordered[0]!.source.anchor.coordinate;
  const firstDest = ordered[0]!.destinationHolding;
  const destPolicy = context.destinationQuantizationPolicy;
  for (const entry of ordered) {
    const sc = entry.source.anchor.coordinate;
    if (sc.bookId !== context.bookId || sc.accountId !== sourceCoordinate.accountId || sc.unitsCommodityId !== sourceCoordinate.unitsCommodityId ||
      sc.functionalCommodityId !== sourceCoordinate.functionalCommodityId || sc.dimensionMemberIds.length !== sourceCoordinate.dimensionMemberIds.length ||
      sc.dimensionMemberIds.some((id, i) => id !== sourceCoordinate.dimensionMemberIds[i])) {
      return reject("inventoryOwnership.groupCoordinate", "Transfer sources must share one book, account, commodity and dimension coordinate");
    }
    const dh = entry.destinationHolding, dl = entry.destinationLot;
    if (dh.bookId !== context.bookId || dl.bookId !== context.bookId || dh.lotId !== dl.id ||
      dh.accountId !== firstDest.accountId || dh.commodityId !== sourceCoordinate.unitsCommodityId || dl.commodityId !== dh.commodityId ||
      dh.basisCommodityId !== destPolicy.functionalCommodityId || dl.basisCommodityId !== dh.basisCommodityId ||
      !dh.remainingQuantity.equals(entry.allocation.allocatedQuantity) || !dh.remainingTotalBasis.equals(entry.allocation.allocatedTotalBasis) ||
      (entry.source.anchor.algorithmVersion === "1.1.0"
        ? !dh.remainingValuationAllowance.equals(entry.allocation.allocatedValuationAllowance) || !dh.remainingCarryingAmount.equals(entry.allocation.allocatedCarryingAmount)
        : !dh.remainingValuationAllowance.isZero() || !dh.remainingCarryingAmount.equals(dh.remainingTotalBasis)) ||
      entry.evidence.length === 0 || entry.evidence.some((item) => item.id.length === 0 || !fullHash(item.contentHash)) ||
      new Set(entry.evidence.map((item) => item.id)).size !== entry.evidence.length) {
      return reject("inventoryOwnership.transferDestination", "Transfer destinations require matching coordinates, positive quantities, exact basis conservation and valid evidence");
    }
  }
  const reductions: InventoryPostedReduction[] = [];
  let totalTransferredPosted = ExactRational.zero(), totalTransferredQuantity = ExactRational.zero(), totalTransferredBasis = ExactRational.zero();
  for (const [index, entry] of ordered.entries()) {
    const prepared = prepareInventoryPostedReduction(entry.source.anchor, entry.source.position, entry.source.holding, entry.allocation, {
      movementId: entry.transferOutMovementId, effectKey: context.effectKey, bookRevision: context.bookRevision,
      artifactOrdinal: context.firstArtifactOrdinal + BigInt(index),
    });
    if (prepared.disposition === "rejected") return prepared;
    reductions.push(prepared.reduction);
    totalTransferredPosted = totalTransferredPosted.add(prepared.reduction.reductionProof.postedAmount.toRational());
    totalTransferredQuantity = totalTransferredQuantity.add(entry.allocation.allocatedQuantity);
    totalTransferredBasis = totalTransferredBasis.add(entry.allocation.allocatedTotalBasis);
  }
  let sourcePosting: CanonicalPostingReference | undefined;
  if (totalTransferredPosted.isZero()) {
    if (sourceJournalLink !== undefined) return reject("inventoryOwnership.posting", "An all-zero transfer group has no source inventory posting");
  } else {
    if (sourceJournalLink === undefined) return reject("inventoryOwnership.posting", "A money-bearing transfer group requires its source inventory posting");
    const { source } = sourceJournalLink;
    if (source.commandId !== context.commandId || source.journal.bookId !== context.bookId || source.journal.functionalCommodityId !== sourceCoordinate.functionalCommodityId ||
      source.bookRevision !== context.bookRevision || source.fiscalPeriodId !== context.fiscalPeriodId || source.journal.accountingDate !== context.accountingDate ||
      source.effectKey.length === 0 || source.effectKey === context.effectKey ||
      !contentHashEquals(source.canonicalHash, hashCanonical(canonicalJournalValue(source.journal)))) {
      return reject("inventoryOwnership.journalSource", "The source journal must match this book, revision, date, fiscal period and canonical hash");
    }
    const matches = source.journal.postings.filter((p) => p.id === sourceJournalLink.postingId);
    if (matches.length !== 1) return reject("inventoryOwnership.posting", "The group must resolve exactly one source inventory posting");
    const actual = matches[0]!;
    const dimensions = [...actual.dimensionMemberIds].sort(compareCanonicalText);
    if (actual.accountId !== sourceCoordinate.accountId || actual.units.commodityId !== sourceCoordinate.unitsCommodityId || actual.bookValue.functionalCommodityId !== sourceCoordinate.functionalCommodityId ||
      dimensions.length !== sourceCoordinate.dimensionMemberIds.length || dimensions.some((id, i) => id !== sourceCoordinate.dimensionMemberIds[i]) ||
      !actual.bookValue.amount.toRational().equals(totalTransferredPosted.negate()) || !actual.units.canonicalNumber.equals(totalTransferredQuantity.negate()) ||
      actual.costBasis === undefined || actual.costBasis.basisCommodityId !== sourceCoordinate.functionalCommodityId || !actual.costBasis.totalBasis.equals(totalTransferredBasis.negate())) {
      return reject("inventoryOwnership.postingAttribution", "The source inventory posting must exactly cover the transferred money, quantity, basis and coordinate");
    }
    sourcePosting = createCanonicalPostingReference(sourceJournalLink.referenceId, context.bookId, source.journal.id, actual, effectKey(source.effectKey));
  }
  let destinationPosting: CanonicalPostingReference | undefined;
  if (totalTransferredPosted.isZero()) {
    if (destinationJournalLink !== undefined) return reject("inventoryOwnership.posting", "An all-zero transfer group has no destination inventory posting");
  } else {
    if (destinationJournalLink === undefined) return reject("inventoryOwnership.posting", "A money-bearing transfer group requires its destination inventory posting");
    const { source } = destinationJournalLink;
    if (source.commandId !== context.commandId || source.journal.bookId !== context.bookId || source.journal.functionalCommodityId !== destPolicy.functionalCommodityId ||
      source.bookRevision !== context.bookRevision || source.fiscalPeriodId !== context.fiscalPeriodId || source.journal.accountingDate !== context.accountingDate ||
      source.effectKey.length === 0 || source.effectKey === context.effectKey ||
      !contentHashEquals(source.canonicalHash, hashCanonical(canonicalJournalValue(source.journal)))) {
      return reject("inventoryOwnership.journalSource", "The destination journal must match this book, revision, date, fiscal period and canonical hash");
    }
    const matches = source.journal.postings.filter((p) => p.id === destinationJournalLink.postingId);
    if (matches.length !== 1) return reject("inventoryOwnership.posting", "The group must resolve exactly one destination inventory posting");
    const actual = matches[0]!;
    const dimensions = [...actual.dimensionMemberIds].sort(compareCanonicalText);
    if (actual.accountId !== firstDest.accountId || actual.units.commodityId !== sourceCoordinate.unitsCommodityId || actual.bookValue.functionalCommodityId !== destPolicy.functionalCommodityId ||
      dimensions.length !== context.destinationDimensionMemberIds.length || dimensions.some((id, i) => id !== context.destinationDimensionMemberIds[i]) ||
      !actual.bookValue.amount.toRational().equals(totalTransferredPosted) || !actual.units.canonicalNumber.equals(totalTransferredQuantity) ||
      actual.costBasis === undefined || actual.costBasis.basisCommodityId !== destPolicy.functionalCommodityId || !actual.costBasis.totalBasis.equals(totalTransferredBasis)) {
      return reject("inventoryOwnership.postingAttribution", "The destination inventory posting must exactly cover the transferred money, quantity, basis and coordinate");
    }
    destinationPosting = createCanonicalPostingReference(destinationJournalLink.referenceId, context.bookId, source.journal.id, actual, effectKey(source.effectKey));
  }
  const N = ordered.length;
  const transferOutMovements: InventoryPostedReductionMovement[] = [];
  const destinationAnchors: InventoryPostedAnchor[] = [];
  const destinationMovements: InventoryPostedAcquisitionMovement[] = [];
  for (const [index, entry] of ordered.entries()) {
    const reduction = reductions[index]!;
    const transferOutOrdinal = context.firstArtifactOrdinal + BigInt(index);
    const anchorOrdinal = context.firstArtifactOrdinal + BigInt(N + index);
    const destMovementOrdinal = context.firstArtifactOrdinal + BigInt(2 * N + index);
    const redBody: InventoryPostedReductionMovementBody = {
      id: entry.transferOutMovementId, kind: "transferOut", effectKey: context.effectKey, bookRevision: context.bookRevision,
      artifactOrdinal: transferOutOrdinal, accountingDate: context.accountingDate, fiscalPeriodId: context.fiscalPeriodId,
      coordinate: entry.source.anchor.coordinate, postedAmount: reduction.postedAmount, beforePosition: reduction.beforePosition, afterPosition: reduction.afterPosition,
      quantityAllocation: reduction.allocation, reductionProof: reduction.reductionProof, incomingSources: [],
    };
    const redVariant: MovementHashInput = reduction.monetaryKind === "quantityOnly"
      ? { ...redBody, monetaryKind: "quantityOnly" }
      : { ...redBody, monetaryKind: "journalLinked", posting: sourcePosting! };
    const transferOut = { ...redVariant, contentHash: hashInventoryPostedReductionMovement(redVariant) };
    transferOutMovements.push(transferOut);

    const transferredBudget = reduction.reductionProof.postedAmount;
    const transferOutRef: InventoryPostedMovementReference = {
      id: transferOut.id, contentHash: transferOut.contentHash, bookId: context.bookId,
      effectKey: context.effectKey, artifactOrdinal: transferOut.artifactOrdinal, bookRevision: context.bookRevision,
    };
    const predecessorRef: InventoryPostedPositionReference = {
      id: entry.source.position.holdingId, contentHash: entry.source.position.contentHash, bookId: context.bookId,
      effectKey: entry.source.position.originEffectKey, artifactOrdinal: entry.source.position.originArtifactOrdinal, bookRevision: entry.source.position.originBookRevision,
    };
    const destHolding = entry.destinationHolding, destLot = entry.destinationLot;
    let postedValue: InventoryPostedValueBudget | undefined;
    if (reduction.postedValue !== undefined) {
      const destination = allocateInventoryPostedValue(reduction.postedValue.consumed, ExactRational.zero(), ExactRational.zero(), destPolicy);
      if (destination.disposition === "rejected") return destination;
      postedValue = destination.remaining;
    }
    const anchorBody: Omit<InventoryPostedAnchor, "contentHash"> = {
      id: entry.destinationAnchorId, algorithm: "cumulativePostedInventoryV1", algorithmVersion: (postedValue === undefined ? "1.0.0" : "1.1.0") as SemanticVersion,
      quantity: entry.allocation.allocatedQuantity, postedBudget: transferredBudget, effectKey: context.effectKey, artifactOrdinal: anchorOrdinal, bookRevision: context.bookRevision,
      ...(postedValue === undefined ? {} : { postedValue }),
      coordinate: { bookId: context.bookId, holdingId: destHolding.id, lotId: destLot.id, accountId: destHolding.accountId, unitsCommodityId: destHolding.commodityId,
        functionalCommodityId: destPolicy.functionalCommodityId, dimensionMemberIds: context.destinationDimensionMemberIds },
      inventoryPolicy: context.destinationInventoryPolicy, quantizationPolicy: destPolicy,
      sourcePostings: destinationPosting === undefined ? [] : [destinationPosting],
      predecessorPosition: predecessorRef, incomingMovements: [transferOutRef], evidence: entry.evidence,
    };
    const destAnchor = { ...anchorBody, contentHash: hashInventoryPostedAnchor(anchorBody) };
    destinationAnchors.push(destAnchor);

    const destPositionBody: Omit<InventoryPostedPosition, "contentHash"> = {
      holdingId: destHolding.id, consumedQuantity: ExactRational.zero(), consumedPosted: ExactDecimal.of(0n, destPolicy.targetScale),
      anchor: { id: destAnchor.id, contentHash: destAnchor.contentHash, bookId: context.bookId, effectKey: destAnchor.effectKey, artifactOrdinal: destAnchor.artifactOrdinal, bookRevision: destAnchor.bookRevision },
      originMovementId: entry.destinationMovementId, originEffectKey: context.effectKey, originArtifactOrdinal: destMovementOrdinal, originBookRevision: context.bookRevision,
    };
    const destPosition = { ...destPositionBody, contentHash: hashInventoryPostedPosition(destPositionBody) };

    const acqProof = quantizeCumulativePostedShare(transferredBudget, ExactRational.zero(), ExactRational.of(1n, 1n), destPolicy);
    if (acqProof.disposition === "rejected") return acqProof;
    const acqBody: InventoryPostedAcquisitionMovementBody = {
      id: entry.destinationMovementId, kind: "transferIn", effectKey: context.effectKey, artifactOrdinal: destMovementOrdinal,
      bookRevision: context.bookRevision, accountingDate: context.accountingDate, fiscalPeriodId: context.fiscalPeriodId,
      coordinate: destAnchor.coordinate, postedAmount: transferredBudget, afterPosition: destPosition,
      acquisitionProof: acqProof.share, incomingSources: [transferOutRef],
    };
    const acqVariant = acqBody.postedAmount.isZero()
      ? { ...acqBody, monetaryKind: "quantityOnly" as const }
      : { ...acqBody, monetaryKind: "journalLinked" as const, posting: destinationPosting! };
    const destMovement = { ...acqVariant, contentHash: hashInventoryPostedAcquisitionMovement(acqVariant) };
    destinationMovements.push(destMovement);
  }
  return Object.freeze({
    disposition: "prepared",
    group: immutableAccountingValue({
      transferOutMovements, destinationAnchors, destinationMovements,
      destinationLots: ordered.map((e) => e.destinationLot),
      destinationHoldings: ordered.map((e) => e.destinationHolding),
      afterSourceHoldings: reductions.map((r) => r.afterHolding),
      afterSourcePositions: reductions.map((r) => r.afterPosition),
      transferredPostedAmount: quantize(totalTransferredPosted, destPolicy).amount,
      transferredQuantity: totalTransferredQuantity,
    }),
  });
}

export interface InventoryPostedAdoptionEntry {
  readonly anchorId: InventoryPostedAnchor["id"];
  readonly movementId: InventoryPostedPosition["originMovementId"];
  readonly holding: LotHolding;
  readonly evidence: readonly SourceEvidence[];
  readonly historicalPostings: readonly CanonicalPostingReference[];
}

export interface InventoryPostedAdoptionContext extends InventoryPostedAcquisitionContext {
  readonly firstArtifactOrdinal: bigint;
}

export interface InventoryPostedAdoptionGroup {
  readonly anchors: readonly InventoryPostedAnchor[];
  readonly movements: readonly InventoryPostedAcquisitionMovement[];
  readonly holdings: readonly LotHolding[];
  readonly positions: readonly InventoryPostedPosition[];
  readonly adoptedPostedBalance: ExactDecimal;
  readonly adoptedQuantity: ExactRational;
}

/** Prospective adoption arithmetic only. Caller-supplied balances/references are
 * not authenticated history, and this candidate is NOT authority for canonical
 * adoption. Book command admission rejects adoption pending a migration proof. */
export function prepareInventoryPostedAdoptionGroup(
  context: InventoryPostedAdoptionContext,
  entries: readonly InventoryPostedAdoptionEntry[],
  postedBalance: ExactRational,
): { readonly disposition: "prepared"; readonly group: InventoryPostedAdoptionGroup } | OwnershipRejection {
  const cap = ACCOUNTING_LIMITS.maxInventoryLayers, policy = context.quantizationPolicy;
  if (entries.length === 0 || entries.length > cap || context.dimensionMemberIds.length > cap) {
    return reject("inventoryOwnership.adoption", "Adoption inputs must fit bounded nonempty group populations");
  }
  let evidenceWork = 0;
  for (const entry of entries) {
    evidenceWork += entry.evidence.length + entry.historicalPostings.length;
    if (evidenceWork > cap) return reject("inventoryOwnership.adoption", "Adoption evidence exceeds the combined work bound");
  }
  if (context.bookRevision <= 0n || context.firstArtifactOrdinal <= 0n || context.effectKey.length === 0 || context.commandId.length === 0 ||
    context.inventoryPolicy.policyId.length === 0 || context.inventoryPolicy.policyVersion.length === 0 || !fullHash(context.inventoryPolicy.policyContentHash) ||
    policy.bookId !== context.bookId || new Set(entries.map((e) => e.holding.id)).size !== entries.length ||
    new Set(entries.map((e) => e.anchorId)).size !== entries.length ||
    new Set(entries.map((e) => e.movementId)).size !== entries.length ||
    context.dimensionMemberIds.some((id, i, ids) => i > 0 && compareCanonicalText(ids[i - 1]!, id) >= 0)) {
    return reject("inventoryOwnership.adoptionIdentity", "Adoption requires unique local identities, canonical dimensions and pinned policy/origin metadata");
  }
  const ordered = [...entries].sort((a, b) => compareCanonicalText(a.holding.id, b.holding.id)), first = ordered[0]!.holding;
  let quantity = ExactRational.zero(), carrying = ExactRational.zero();
  for (const entry of ordered) {
    const h = entry.holding;
    if (entry.anchorId.length === 0 || entry.movementId.length === 0 || h.id.length === 0 ||
      h.bookId !== context.bookId || h.accountId !== first.accountId || h.commodityId !== first.commodityId ||
      h.basisCommodityId !== policy.functionalCommodityId ||
      h.remainingQuantity.compare(ExactRational.zero()) <= 0 || h.remainingTotalBasis.isNegative() ||
      h.remainingValuationAllowance.compare(ExactRational.zero()) > 0 || h.remainingCarryingAmount.isNegative() ||
      !h.remainingCarryingAmount.equals(h.remainingTotalBasis.add(h.remainingValuationAllowance)) ||
      entry.evidence.length === 0 || entry.evidence.some((item) => item.id.length === 0 || !fullHash(item.contentHash)) ||
      new Set(entry.evidence.map((item) => item.id)).size !== entry.evidence.length ||
      entry.historicalPostings.some((p) => p.bookId !== context.bookId || !validateCanonicalPostingReferenceHash(p)) ||
      new Set(entry.historicalPostings.map((p) => p.postingId)).size !== entry.historicalPostings.length) {
      return reject("inventoryOwnership.adoptionSource", "Adopted holdings require coherent positive quantities, same-coordinate economics and complete evidence");
    }
    quantity = quantity.add(h.remainingQuantity);
    carrying = carrying.add(h.remainingCarryingAmount);
  }
  const balanceDecimal = quantize(postedBalance, policy).amount;
  if (!balanceDecimal.toRational().equals(postedBalance) || !postedBalance.equals(carrying)) {
    return reject("inventoryOwnership.adoptionBalance", "The verified posted money balance must equal the complete remaining carrying amount of all adopted holdings in the scope");
  }
  const anchors: InventoryPostedAnchor[] = [], movements: InventoryPostedAcquisitionMovement[] = [], positions: InventoryPostedPosition[] = [];
  let cumulative = ExactRational.zero();
  const denominator = carrying.isZero() ? quantity : carrying;
  for (const [index, entry] of ordered.entries()) {
    const weight = carrying.isZero() ? entry.holding.remainingQuantity : entry.holding.remainingCarryingAmount;
    const next = cumulative.add(weight), share = quantizeCumulativePostedShare(balanceDecimal, cumulative.divide(denominator), next.divide(denominator), policy);
    if (share.disposition === "rejected") return share;
    const h = entry.holding, ordinal = context.firstArtifactOrdinal + BigInt(index), movementOrdinal = ordinal + BigInt(ordered.length);
    const anchorBody: Omit<InventoryPostedAnchor, "contentHash"> = {
      id: entry.anchorId, algorithm: "cumulativePostedInventoryV1", algorithmVersion: "1.0.0" as SemanticVersion,
      quantity: h.remainingQuantity, postedBudget: share.share.postedAmount, effectKey: context.effectKey, artifactOrdinal: ordinal, bookRevision: context.bookRevision,
      coordinate: { bookId: context.bookId, holdingId: h.id, lotId: h.lotId, accountId: h.accountId, unitsCommodityId: h.commodityId,
        functionalCommodityId: policy.functionalCommodityId, dimensionMemberIds: context.dimensionMemberIds },
      inventoryPolicy: context.inventoryPolicy, quantizationPolicy: policy, sourcePostings: entry.historicalPostings, incomingMovements: [], evidence: entry.evidence,
    };
    const anchor = { ...anchorBody, contentHash: hashInventoryPostedAnchor(anchorBody) };
    const positionBody: Omit<InventoryPostedPosition, "contentHash"> = { holdingId: h.id, consumedQuantity: ExactRational.zero(), consumedPosted: ExactDecimal.of(0n, policy.targetScale),
      anchor: { id: anchor.id, contentHash: anchor.contentHash, bookId: context.bookId, effectKey: anchor.effectKey, artifactOrdinal: ordinal, bookRevision: context.bookRevision },
      originMovementId: entry.movementId, originEffectKey: context.effectKey, originArtifactOrdinal: movementOrdinal, originBookRevision: context.bookRevision };
    const position = { ...positionBody, contentHash: hashInventoryPostedPosition(positionBody) };
    const zeroProof = quantizeCumulativePostedShare(ExactDecimal.of(0n, policy.targetScale), ExactRational.zero(), ExactRational.zero(), policy);
    if (zeroProof.disposition === "rejected") return zeroProof;
    const body: InventoryPostedAcquisitionMovementBody = { id: entry.movementId, kind: "legacyAdoption", effectKey: context.effectKey, artifactOrdinal: movementOrdinal,
      bookRevision: context.bookRevision, accountingDate: context.accountingDate, fiscalPeriodId: context.fiscalPeriodId, coordinate: anchor.coordinate,
      postedAmount: ExactDecimal.of(0n, policy.targetScale), afterPosition: position, acquisitionProof: zeroProof.share, incomingSources: [] };
    const movement: InventoryPostedAcquisitionMovement = { ...body, monetaryKind: "quantityOnly" as const, contentHash: hashInventoryPostedAcquisitionMovement({ ...body, monetaryKind: "quantityOnly" }) };
    anchors.push(anchor); movements.push(movement); positions.push(position); cumulative = next;
  }
  return Object.freeze({ disposition: "prepared", group: immutableAccountingValue({ anchors, movements, holdings: ordered.map((e) => e.holding), positions, adoptedPostedBalance: balanceDecimal, adoptedQuantity: quantity }) });
}

export type InventoryPostedMovement = InventoryPostedReductionMovement | InventoryPostedAcquisitionMovement;
export interface InventoryOwnershipEffect {
  readonly effectKey: EffectKey;
  readonly bookRevision: bigint;
  readonly contentHash: ContentHash;
  readonly newAnchors: readonly InventoryPostedAnchor[];
  readonly journalLinkedMovements: readonly Extract<InventoryPostedMovement, { readonly monetaryKind: "journalLinked" }>[];
  readonly quantityOnlyMovements: readonly Extract<InventoryPostedMovement, { readonly monetaryKind: "quantityOnly" }>[];
}
/** Narrow reduction-only API retained without changing its result/codec shape. */
export interface InventoryReductionOwnershipEffect extends InventoryOwnershipEffect {
  readonly newAnchors: readonly [];
  readonly journalLinkedMovements: readonly JournalLinkedInventoryReductionMovement[];
  readonly quantityOnlyMovements: readonly QuantityOnlyInventoryReductionMovement[];
}

export function hashInventoryReductionOwnershipEffect(effect: Omit<InventoryReductionOwnershipEffect, "contentHash"> & { readonly contentHash?: ContentHash }): ContentHash {
  return hashInventoryOwnershipEffect(effect);
}

export function hashInventoryOwnershipEffect(effect: Omit<InventoryOwnershipEffect, "contentHash"> & { readonly contentHash?: ContentHash }): ContentHash {
  const { contentHash: _contentHash, ...body } = effect;
  return hashCanonical({ type: "InventoryOwnershipEffect", value: canonicalAccountingValue(body) });
}

export type InventoryPostedReductionSource = Pick<InventoryPostedReductionEntry, "anchor" | "position" | "holding">;
export interface InventoryPostedPositionOrigin {
  readonly bookId: BookId;
  readonly movementId: Identifier<"InventoryPostedMovement">;
  readonly effectKey: EffectKey;
  readonly artifactOrdinal: bigint;
  readonly bookRevision: bigint;
}

/** Trusted internal read capability, NEVER a client-supplied command payload.
 * All reads must be authenticated against one pinned head, including the current
 * projection and the origin movement's retained after-image. Missing/corrupt
 * storage or invalidation throws; undefined denotes proven absence only.
 * readPositionAfterImage resolves the exact immutable origin, not a current row.
 * Storage must prove membership in an admitted effect; a self-hashed artifact
 * or locator is insufficient. assertCurrent must detect outcome-only head
 * changes too. Publication requires the SAME live head and atomic CAS.
 */
export interface InventoryOwnershipReadContext {
  readonly bookId: BookId;
  readonly bookRevision: bigint;
  assertCurrent(): void;
  readCurrentHolding(id: LotHoldingId): LotHolding | undefined;
  readCurrentPosition(id: LotHoldingId): InventoryPostedPosition | undefined;
  readAnchor(reference: InventoryPostedAnchorReference): InventoryPostedAnchor | undefined;
  readPositionAfterImage(origin: InventoryPostedPositionOrigin): InventoryPostedPosition | undefined;
}

/** Resolves original touched sources through a trusted, pinned read context.
 * Does not select lots, authenticate an arbitrary context implementation, admit
 * accounting policy, or replace historical replay. Storage exceptions propagate:
 * infrastructure failure is not a retained accounting rejection.
 */
export function resolveInventoryOwnershipSources(
  reader: InventoryOwnershipReadContext,
  holdingIds: readonly LotHoldingId[],
): { readonly disposition: "resolved"; readonly sources: readonly InventoryPostedReductionSource[] } | OwnershipRejection {
  reader.assertCurrent();
  const book = reader.bookId, revision = reader.bookRevision;
  if (book.length === 0 || revision <= 0n || holdingIds.length === 0 || holdingIds.length > ACCOUNTING_LIMITS.maxInventoryLayers ||
    new Set(holdingIds).size !== holdingIds.length || holdingIds.some((id) => id.length === 0)) {
    return reject("inventoryOwnership.readSet", "Ownership reads require one bounded distinct holding set at a committed book head");
  }
  const guard = () => {
    reader.assertCurrent();
    if (reader.bookId !== book || reader.bookRevision !== revision) throw new Error("Inventory ownership read scope changed");
  };
  const sources: InventoryPostedReductionSource[] = [];
  let work = 0;
  for (const id of [...holdingIds].sort(compareCanonicalText)) {
    guard();
    const suppliedHolding = reader.readCurrentHolding(id);
    guard();
    if (suppliedHolding === undefined) return reject("inventoryOwnership.currentSource", "Current holding is absent from the pinned book");
    const holding = immutableAccountingValue(suppliedHolding);
    const suppliedPosition = reader.readCurrentPosition(id);
    guard();
    if (suppliedPosition === undefined) return reject("inventoryOwnership.currentSource", "Current posted ownership position is absent; legacy adoption cannot be inferred");
    const position = immutableAccountingValue(suppliedPosition);
    if (holding.id !== id || holding.bookId !== book || position.holdingId !== id || !ownershipPositionValid(position) ||
      position.anchor.bookId !== book || position.originBookRevision > revision) {
      return reject("inventoryOwnership.currentSource", "Current holding and position must match the pinned book and supported exact origin");
    }
    const suppliedAnchor = reader.readAnchor(position.anchor);
    guard();
    if (suppliedAnchor === undefined) return reject("inventoryOwnership.anchorSource", "The exact historical anchor must exist in the pinned source history");
    // Bound combined verification work before copying or hashing source arrays.
    work += suppliedAnchor.sourcePostings.length + suppliedAnchor.incomingMovements.length + suppliedAnchor.evidence.length +
      (suppliedAnchor.predecessorPosition === undefined ? 0 : 1) + suppliedAnchor.coordinate.dimensionMemberIds.length;
    if (work > ACCOUNTING_LIMITS.maxInventoryLayers) return reject("inventoryOwnership.readSet", "Ownership source verification exceeds the combined work bound");
    const anchor = immutableAccountingValue(suppliedAnchor), c = anchor.coordinate;
    if (!ownershipAnchorValid(anchor) || !sameOwnershipValue(position.anchor, {
      id: anchor.id, contentHash: anchor.contentHash, bookId: c.bookId, effectKey: anchor.effectKey, artifactOrdinal: anchor.artifactOrdinal, bookRevision: anchor.bookRevision,
    }) || c.bookId !== book || c.holdingId !== id || c.lotId !== holding.lotId || c.accountId !== holding.accountId ||
      c.unitsCommodityId !== holding.commodityId || c.functionalCommodityId !== holding.basisCommodityId) {
      return reject("inventoryOwnership.anchorSource", "The exact anchor version and complete holding coordinate must agree");
    }
    const origin: InventoryPostedPositionOrigin = Object.freeze({ bookId: book, movementId: position.originMovementId, effectKey: position.originEffectKey,
      artifactOrdinal: position.originArtifactOrdinal, bookRevision: position.originBookRevision });
    const suppliedAfterImage = reader.readPositionAfterImage(origin);
    guard();
    if (suppliedAfterImage === undefined || !sameOwnershipValue(position, suppliedAfterImage)) {
      return reject("inventoryOwnership.positionOrigin", "Current position must equal the complete immutable after-image at its authenticated origin");
    }
    if (position.consumedQuantity.compare(anchor.quantity) > 0 || !holding.remainingQuantity.equals(anchor.quantity.subtract(position.consumedQuantity)) ||
      holding.remainingTotalBasis.isNegative() || holding.remainingValuationAllowance.compare(ExactRational.zero()) > 0 || holding.remainingCarryingAmount.isNegative() ||
      holding.remainingQuantity.isZero() && (!holding.remainingTotalBasis.isZero() || !holding.remainingValuationAllowance.isZero()) ||
      !holding.remainingCarryingAmount.equals(holding.remainingTotalBasis.add(holding.remainingValuationAllowance))) {
      return reject("inventoryOwnership.positionBalance", "Anchor quantity and current exact holding balances must reconcile without negative carrying value");
    }
    const fraction = position.consumedQuantity.divide(anchor.quantity);
    const target = quantizeCumulativePostedShare(anchor.postedBudget, fraction, fraction, anchor.quantizationPolicy);
    if (target.disposition === "rejected" || !position.consumedPosted.toRational().equals(target.share.afterQuantization.amount.toRational())) {
      return reject("inventoryOwnership.positionBalance", "Consumed money must equal the actual anchor budget's pinned cumulative target");
    }
    sources.push({ anchor, position, holding });
  }
  guard();
  return Object.freeze({ disposition: "resolved", sources: immutableAccountingValue(sources) });
}

export type InventoryReductionEffectContext = Omit<InventoryPostedReductionGroupContext, "kind" | "firstArtifactOrdinal">;
export interface InventoryReductionOperation {
  readonly kind: InventoryPostedReductionGroupContext["kind"];
  readonly allocations: readonly Pick<InventoryPostedReductionEntry, "movementId" | "allocation">[];
  readonly journalLink?: NonNullable<Parameters<typeof prepareInventoryPostedReductionGroup>[2]>;
}

export interface InventoryOwnershipSelectionRequest extends Omit<InventoryCostRequest, "layers"> {
  readonly inventoryCommodityId: CommodityId;
  readonly derivation: DerivationRecord;
  readonly identities: readonly { readonly holdingId: LotHoldingId; readonly allocationId: LotAllocation["id"]; readonly movementId: InventoryPostedPosition["originMovementId"] }[];
}
export interface InventoryOwnershipSelection {
  readonly inventoryPolicy: InventoryPostedAnchor["inventoryPolicy"];
  readonly allocations: InventoryReductionOperation["allocations"];
  readonly ordinaryQuantity: ExactRational;
  readonly ordinaryBasis: ExactRational;
  readonly ordinaryValuationAllowance: ExactRational;
  readonly ordinaryCarryingAmount: ExactRational;
  readonly provisionalQuantity: ExactRational;
  readonly provisionalBasis: ExactRational;
}

/** Compiles economic allocations from the complete canonical policy pool.
 * canonicalPool and policies are trusted read-side input, NOT client assertions
 * of completeness. This deliberately accepts no caller-supplied allocation
 * amounts or layer list. The ledger must prove scope/completeness at one head.
 * Ownership anchors, actual posted budgets, IDs against permanent history,
 * journal/period admission and provisional effects remain separate obligations.
 */
export function prepareInventoryOwnershipSelection(
  policies: readonly AccountingPolicy[],
  bookId: BookId,
  canonicalPool: readonly { readonly holding: LotHolding; readonly lot: Lot }[],
  request: InventoryOwnershipSelectionRequest,
): { readonly disposition: "selected"; readonly selection: InventoryOwnershipSelection } | OwnershipRejection {
  const cap = ACCOUNTING_LIMITS.maxInventoryLayers;
  if (policies.length > cap || canonicalPool.length > cap || request.identities.length > cap || request.derivation.evidence.length > cap || (request.specificLayerIds?.length ?? 0) > cap) {
    return reject("inventoryOwnership.selection", "Inventory selection inputs exceed their bounded populations");
  }
  const matches = policies.filter((p): p is InventoryCostPolicy => p.kind === "inventoryCost" && p.id === request.policyId && p.version === request.policyVersion &&
    p.validFrom <= request.governedAt && (p.validTo === undefined || request.governedAt < p.validTo));
  const policy = matches[0];
  if (matches.length !== 1 || policy === undefined || policy.bookId !== bookId || policy.pools.length > cap ||
    policy.algorithmVersion !== "1.0.0" || !["specificIdentification", "fifo", "lifo", "hifo", "weightedAverage"].includes(policy.method) ||
    policy.quantizationPolicy.bookId !== bookId || !verifyAccountingPolicyArtifacts([policy]) ||
    !validAccountingDerivation(request.derivation) || request.derivation.policyId !== policy.id || request.derivation.policyVersion !== policy.version ||
    request.derivation.algorithmVersion !== policy.algorithmVersion || !fullHash(request.derivation.inputHash) ||
    request.derivation.evidence.some((e) => !fullHash(e.contentHash)) || new Set(request.derivation.evidence.map((e) => e.id)).size !== request.derivation.evidence.length) {
    return reject("inventoryOwnership.selectionPolicy", "Selection requires one applicable supported policy, complete artifact hashes and matching approved derivation");
  }
  const layers: InventoryLayerInput[] = [], holdings = new Map<LotHoldingId, LotHolding>(), lots = new Map<string, ContentHash>();
  const poolAccounts = new Set(policy.pools.map((pool) => pool.accountId));
  let evidenceWork = 0;
  for (const { holding: h, lot } of canonicalPool) {
    evidenceWork += lot.evidenceIds.length;
    if (evidenceWork > cap) return reject("inventoryOwnership.selection", "Canonical lot evidence exceeds the selection work bound");
    if (holdings.has(h.id) || h.id.length === 0 || h.bookId !== bookId || lot.bookId !== bookId || h.lotId !== lot.id ||
      !poolAccounts.has(h.accountId) || h.commodityId !== request.inventoryCommodityId || lot.commodityId !== h.commodityId ||
      h.basisCommodityId !== policy.quantizationPolicy.functionalCommodityId || lot.basisCommodityId !== h.basisCommodityId ||
      h.remainingQuantity.isNegative() || h.remainingTotalBasis.isNegative() || h.remainingValuationAllowance.compare(ExactRational.zero()) > 0 || h.remainingCarryingAmount.isNegative() ||
      !h.remainingCarryingAmount.equals(h.remainingTotalBasis.add(h.remainingValuationAllowance)) ||
      h.remainingQuantity.isZero() && (!h.remainingTotalBasis.isZero() || !h.remainingValuationAllowance.isZero())) {
      return reject("inventoryOwnership.selectionPool", "Canonical pool rows must be unique, coherent and match the complete selected book/account/commodity scope");
    }
    const lotHash = hashCanonical(canonicalAccountingValue(lot)), priorLotHash = lots.get(lot.id);
    if (priorLotHash !== undefined && !contentHashEquals(priorLotHash, lotHash)) return reject("inventoryOwnership.selectionPool", "One canonical lot identity cannot have conflicting source content");
    lots.set(lot.id, lotHash); holdings.set(h.id, h);
    if (!h.remainingQuantity.isZero()) layers.push({ id: h.id, accountId: h.accountId, acquiredAt: lot.acquiredAt, quantity: h.remainingQuantity, totalBasis: h.remainingTotalBasis });
  }
  const cost = calculateInventoryCost([policy], bookId, { policyId: request.policyId, policyVersion: request.policyVersion, governedAt: request.governedAt,
    quantity: request.quantity, layers, ...(request.specificLayerIds === undefined ? {} : { specificLayerIds: request.specificLayerIds }) });
  if (cost.disposition === "rejected") return cost;
  if (request.identities.length !== cost.allocations.length || new Set(request.identities.map((i) => i.holdingId)).size !== request.identities.length ||
    new Set(request.identities.map((i) => i.allocationId)).size !== request.identities.length || new Set(request.identities.map((i) => i.movementId)).size !== request.identities.length ||
    request.identities.some((i) => i.allocationId.length === 0 || i.movementId.length === 0)) {
    return reject("inventoryOwnership.selectionIdentity", "Stable allocation and movement identities must exactly cover the computed selected holdings");
  }
  const identityByHolding = new Map(request.identities.map((i) => [i.holdingId, i]));
  const allocations: InventoryReductionOperation["allocations"][number][] = [];
  let ordinaryQuantity = ExactRational.zero(), ordinaryBasis = ExactRational.zero(), allowance = ExactRational.zero();
  for (const selected of cost.allocations) {
    const id = selected.layerId as LotHoldingId, identity = identityByHolding.get(id), h = holdings.get(id)!;
    if (identity === undefined) return reject("inventoryOwnership.selectionIdentity", "Each computed selected holding requires its own supplied stable identities");
    const fraction = selected.quantity.divide(h.remainingQuantity);
    // For weighted average, policy quantities are proportional across the pool.
    // Retain each source's actual economic basis/allowance, not an invented
    // average basis on each individual lot. Their aggregate equals ordinaryBasis.
    const basis = h.remainingTotalBasis.multiply(fraction), valuationAllowance = h.remainingValuationAllowance.multiply(fraction);
    allocations.push({ movementId: identity.movementId, allocation: { id: identity.allocationId, holdingId: h.id, lotId: h.lotId,
      allocatedQuantity: selected.quantity, allocatedTotalBasis: basis, allocatedValuationAllowance: valuationAllowance,
      allocatedCarryingAmount: basis.add(valuationAllowance), derivation: request.derivation } });
    ordinaryQuantity = ordinaryQuantity.add(selected.quantity); ordinaryBasis = ordinaryBasis.add(basis); allowance = allowance.add(valuationAllowance);
  }
  if (!ordinaryQuantity.add(cost.provisionalQuantity).equals(request.quantity) || !ordinaryBasis.equals(cost.ordinaryBasis)) {
    return reject("inventoryOwnership.selectionConservation", "Selected source economics must conserve the requested quantity and computed ordinary basis");
  }
  allocations.sort((a, b) => compareCanonicalText(a.allocation.holdingId, b.allocation.holdingId));
  return Object.freeze({ disposition: "selected", selection: immutableAccountingValue({
    inventoryPolicy: { policyId: policy.id, policyVersion: policy.version, policyContentHash: hashAccountingPolicy(policy) }, allocations,
    ordinaryQuantity, ordinaryBasis, ordinaryValuationAllowance: allowance, ordinaryCarryingAmount: ordinaryBasis.add(allowance),
    provisionalQuantity: cost.provisionalQuantity, provisionalBasis: cost.provisionalBasis,
  }) });
}
export interface InventoryAcquisitionOperation extends Pick<InventoryPostedAcquisitionContext, "inventoryPolicy" | "quantizationPolicy" | "dimensionMemberIds"> {
  readonly kind: "acquisition";
  readonly entries: readonly InventoryPostedAcquisitionEntry[];
  readonly journalLink?: NonNullable<Parameters<typeof prepareInventoryPostedAcquisitionGroup>[2]>;
}
export interface InventoryTransferOperationEntry {
  readonly allocation: LotAllocation;
  readonly transferOutMovementId: InventoryPostedPosition["originMovementId"];
  readonly destinationAnchorId: InventoryPostedAnchor["id"];
  readonly destinationMovementId: InventoryPostedPosition["originMovementId"];
  readonly destinationHolding: LotHolding;
  readonly destinationLot: Lot;
  readonly evidence: readonly SourceEvidence[];
}
export interface InventoryTransferOperation extends Pick<InventoryPostedTransferGroupContext, "destinationInventoryPolicy" | "destinationQuantizationPolicy" | "destinationDimensionMemberIds"> {
  readonly kind: "transfer";
  readonly entries: readonly InventoryTransferOperationEntry[];
  readonly sourceJournalLink?: NonNullable<Parameters<typeof prepareInventoryPostedTransferGroup>[2]>;
  readonly destinationJournalLink?: NonNullable<Parameters<typeof prepareInventoryPostedTransferGroup>[3]>;
}
export interface InventoryAdoptionOperation extends Pick<InventoryPostedAdoptionContext, "inventoryPolicy" | "quantizationPolicy" | "dimensionMemberIds"> {
  readonly kind: "adopt";
  readonly entries: readonly InventoryPostedAdoptionEntry[];
  readonly postedBalance: ExactRational;
}
export type InventoryOwnershipOperation = InventoryReductionOperation | InventoryAcquisitionOperation | InventoryTransferOperation | InventoryAdoptionOperation;

/** Candidate path using original sources resolved from one trusted read head.
 * Operation membership must already come from canonical lot selection. This is
 * not a BookCommand entrypoint or permission to publish without the same-head CAS.
 */
export function prepareInventoryReductionEffectFromReadContext(
  reader: InventoryOwnershipReadContext,
  context: InventoryReductionEffectContext,
  operations: readonly InventoryReductionOperation[],
): ReturnType<typeof prepareInventoryReductionEffect> {
  const result = prepareInventoryOwnershipEffectFromReadContext(reader, context, operations);
  if (result.disposition === "rejected") return result;
  if (result.effect.newAnchors.length !== 0) return reject("inventoryOwnership.groupIdentity", "The reduction-only API cannot admit acquisition effects");
  return Object.freeze({ disposition: "prepared", effect: result.effect as InventoryReductionOwnershipEffect, afterHoldings: result.afterHoldings, afterPositions: result.afterPositions });
}

/** Resolves only externally existing before-state. Acquisitions in earlier
 * operations supply internally constructed successors, never storage stand-ins.
 * Skipping a current-source read is NOT proof that a new permanent ID is unused;
 * complete identity admission and same-head publication remain mandatory. */
export function prepareInventoryOwnershipEffectFromReadContext(
  reader: InventoryOwnershipReadContext,
  context: InventoryReductionEffectContext,
  operations: readonly InventoryOwnershipOperation[],
): ReturnType<typeof prepareInventoryOwnershipEffect> {
  reader.assertCurrent();
  if (context.bookId !== reader.bookId || context.bookRevision !== reader.bookRevision + 1n || operations.length === 0 || operations.length > ACCOUNTING_LIMITS.maxInventoryLayers) {
    return reject("inventoryOwnership.readSet", "Candidate reduction must immediately follow the pinned book revision with bounded operations");
  }
  let allocationWork = 0, journalWork = 0, acquisitionWork = 0;
  const ids = new Set<LotHoldingId>(), created = new Set<LotHoldingId>();
  for (const operation of operations) {
    const count = operation.kind === "acquisition" || operation.kind === "transfer" || operation.kind === "adopt" ? operation.entries.length : operation.allocations.length;
    allocationWork += count;
    journalWork += operation.kind === "transfer"
      ? (operation.sourceJournalLink?.source.journal.postings.length ?? 0) + (operation.destinationJournalLink?.source.journal.postings.length ?? 0)
      : operation.kind === "adopt" ? 0
      : (operation.journalLink?.source.journal.postings.length ?? 0);
    if (count === 0 || allocationWork > ACCOUNTING_LIMITS.maxInventoryLayers || journalWork > ACCOUNTING_LIMITS.maxInventoryLayers) return reject("inventoryOwnership.readSet", "Candidate allocation and journal populations exceed the read-work bound");
    if (operation.kind === "acquisition") {
      for (const entry of operation.entries) {
        acquisitionWork += entry.evidence.length + entry.lot.evidenceIds.length + operation.dimensionMemberIds.length + (operation.journalLink === undefined ? 0 : 1);
        if (acquisitionWork > ACCOUNTING_LIMITS.maxInventoryLayers) return reject("inventoryOwnership.readSet", "Candidate acquisition sources exceed the read-work bound");
        created.add(entry.holding.id);
      }
    } else if (operation.kind === "transfer") {
      for (const entry of operation.entries) {
        acquisitionWork += entry.evidence.length + entry.destinationLot.evidenceIds.length + operation.destinationDimensionMemberIds.length + (operation.destinationJournalLink === undefined ? 0 : 1);
        if (acquisitionWork > ACCOUNTING_LIMITS.maxInventoryLayers) return reject("inventoryOwnership.readSet", "Candidate acquisition sources exceed the read-work bound");
        created.add(entry.destinationHolding.id);
        if (!created.has(entry.allocation.holdingId)) ids.add(entry.allocation.holdingId);
      }
    } else if (operation.kind === "adopt") {
      for (const entry of operation.entries) {
        acquisitionWork += entry.evidence.length + entry.historicalPostings.length + operation.dimensionMemberIds.length;
        if (acquisitionWork > ACCOUNTING_LIMITS.maxInventoryLayers) return reject("inventoryOwnership.readSet", "Candidate adoption sources exceed the read-work bound");
        created.add(entry.holding.id);
      }
    } else {
      for (const item of operation.allocations) if (!created.has(item.allocation.holdingId)) ids.add(item.allocation.holdingId);
    }
  }
  // Callbacks must not be able to alter a caller's candidate while resolving it.
  const candidate = immutableAccountingValue({ context, operations });
  const guardCandidate = () => {
    reader.assertCurrent();
    if (reader.bookId !== candidate.context.bookId || reader.bookRevision + 1n !== candidate.context.bookRevision) throw new Error("Inventory ownership read scope changed");
  };
  const resolved = ids.size === 0 ? { disposition: "resolved" as const, sources: [] } : resolveInventoryOwnershipSources(reader, [...ids]);
  guardCandidate();
  if (resolved.disposition === "rejected") return resolved;
  const result = prepareInventoryOwnershipEffect(candidate.context, resolved.sources, candidate.operations);
  guardCandidate();
  return result;
}

/** Builds a complete touched-set reduction effect in canonical operation order.
 * Sources are the original current rows, supplied ONCE per touched holding; later
 * operations consume internally computed after-images, never caller overlays.
 * Every supplied source must be used. Allocations/movements/reference IDs and
 * actual posting claims are unique across the entire effect. Same-ID journal
 * sources must have identical canonical content and effect metadata.
 *
 * This remains a pure candidate constructor. It does not authenticate source
 * existence/currentness, prove costing selection, authorize date/period/identity
 * use against the whole book, admit the journal, or durably publish an intent.
 * All initial ownership sources must predate this revision: this producer creates
 * no anchors and cannot adopt or invent same-command historical source artifacts. */
export function prepareInventoryReductionEffect(
  context: InventoryReductionEffectContext,
  sources: readonly InventoryPostedReductionSource[],
  operations: readonly InventoryReductionOperation[],
): { readonly disposition: "prepared"; readonly effect: InventoryReductionOwnershipEffect; readonly afterHoldings: readonly LotHolding[]; readonly afterPositions: readonly InventoryPostedPosition[] } | OwnershipRejection {
  if (sources.length === 0 || sources.length > ACCOUNTING_LIMITS.maxInventoryLayers || operations.length > ACCOUNTING_LIMITS.maxInventoryLayers) return reject("inventoryOwnership.effect", "A reduction effect requires bounded nonempty sources/operations and a committed command origin");
  if (operations.some((op) => !["disposal", "transferOut"].includes(op.kind))) return reject("inventoryOwnership.groupIdentity", "The reduction-only API cannot admit another ownership transition kind");
  const result = prepareInventoryOwnershipEffect(context, sources, operations);
  if (result.disposition === "rejected") return result;
  // Only reduction operations enter this typed API; no acquisition can occur.
  return Object.freeze({ disposition: "prepared", effect: result.effect as InventoryReductionOwnershipEffect,
    afterHoldings: result.afterHoldings, afterPositions: result.afterPositions });
}

/** Complete candidate across the currently implemented acquisition/reduction
 * operations. New rows are produced internally in operation order and never
 * accepted as substitute before-state. Incoming transfer, reanchoring/adoption,
 * canonical command admission and durable publication remain separate work. */
export function prepareInventoryOwnershipEffect(
  context: InventoryReductionEffectContext,
  sources: readonly InventoryPostedReductionSource[],
  operations: readonly InventoryOwnershipOperation[],
): { readonly disposition: "prepared"; readonly effect: InventoryOwnershipEffect; readonly newLots: readonly Lot[]; readonly afterHoldings: readonly LotHolding[]; readonly afterPositions: readonly InventoryPostedPosition[] } | OwnershipRejection {
  const cap = ACCOUNTING_LIMITS.maxInventoryLayers;
  if (sources.length > cap || operations.length === 0 || operations.length > cap ||
    context.bookRevision <= 0n || context.effectKey.length === 0 || context.commandId.length === 0) {
    return reject("inventoryOwnership.effect", "An ownership effect requires bounded sources, nonempty operations and a committed command origin");
  }
  let allocationCount = 0, movementCount = 0, journalWork = 0, sourceWork = 0;
  for (const operation of operations) {
    const count = operation.kind === "acquisition" || operation.kind === "transfer" || operation.kind === "adopt" ? operation.entries.length : operation.allocations.length;
    allocationCount += count;
    movementCount += operation.kind === "transfer" ? count * 2 : count;
    journalWork += operation.kind === "transfer"
      ? (operation.sourceJournalLink?.source.journal.postings.length ?? 0) + (operation.destinationJournalLink?.source.journal.postings.length ?? 0)
      : operation.kind === "adopt" ? 0
      : (operation.journalLink?.source.journal.postings.length ?? 0);
    if (count === 0 || allocationCount > cap || movementCount > cap || journalWork > cap) {
      return reject("inventoryOwnership.effect", "The complete effect's allocation and journal-source work must fit the operation bounds");
    }
    if (operation.kind === "acquisition") {
      for (const entry of operation.entries) {
        sourceWork += entry.evidence.length + entry.lot.evidenceIds.length + operation.dimensionMemberIds.length + (operation.journalLink === undefined ? 0 : 1);
        if (sourceWork > cap) return reject("inventoryOwnership.effect", "The complete effect's acquisition source work exceeds its bound");
      }
    } else if (operation.kind === "transfer") {
      for (const entry of operation.entries) {
        sourceWork += entry.evidence.length + entry.destinationLot.evidenceIds.length + operation.destinationDimensionMemberIds.length + (operation.destinationJournalLink === undefined ? 0 : 1);
        if (sourceWork > cap) return reject("inventoryOwnership.effect", "The complete effect's transfer source work exceeds its bound");
      }
    } else if (operation.kind === "adopt") {
      for (const entry of operation.entries) {
        sourceWork += entry.evidence.length + entry.historicalPostings.length + operation.dimensionMemberIds.length;
        if (sourceWork > cap) return reject("inventoryOwnership.effect", "The complete effect's adoption source work exceeds its bound");
      }
    }
  }
  const current = new Map<LotHoldingId, InventoryPostedReductionSource>();
  const anchorIds = new Set<string>(), priorMovementIds = new Set<string>();
  for (const source of sources) {
    const { anchor, position, holding } = source;
    sourceWork += anchor.sourcePostings.length + anchor.incomingMovements.length + anchor.evidence.length + (anchor.predecessorPosition === undefined ? 0 : 1) + anchor.coordinate.dimensionMemberIds.length;
    if (sourceWork > cap) return reject("inventoryOwnership.effect", "The complete effect's original source population exceeds its work bound");
    if (current.has(holding.id) || anchorIds.has(anchor.id) || priorMovementIds.has(position.originMovementId) ||
      holding.bookId !== context.bookId || holding.id !== position.holdingId || holding.id !== anchor.coordinate.holdingId ||
      anchor.bookRevision >= context.bookRevision || position.originBookRevision >= context.bookRevision) {
      return reject("inventoryOwnership.effectSource", "Original touched holdings require unique, matching ownership sources from a prior financial revision");
    }
    current.set(holding.id, source);
    anchorIds.add(anchor.id);
    priorMovementIds.add(position.originMovementId);
  }
  const allocations = new Set<string>(), movementIds = new Set<string>(), postingIds = new Set<string>(), referenceIds = new Set<string>();
  const originalIds = new Set(current.keys()), holdingIds = new Set(current.keys()), lotIds = new Set(sources.map((source) => source.holding.lotId));
  const journalSources = new Map<string, ContentHash>(), journalEffects = new Map<string, string>();
  for (const operation of operations) {
    if (operation.kind === "acquisition") {
      for (const item of operation.entries) {
        if (movementIds.has(item.movementId) || priorMovementIds.has(item.movementId) ||
          anchorIds.has(item.anchorId) || holdingIds.has(item.holding.id) || lotIds.has(item.lot.id)) {
          return reject("inventoryOwnership.effectIdentity", "New acquisition anchors, holdings and lots cannot reuse prior or same-command identities");
        }
        movementIds.add(item.movementId); anchorIds.add(item.anchorId); holdingIds.add(item.holding.id); lotIds.add(item.lot.id);
      }
    } else if (operation.kind === "transfer") {
      for (const item of operation.entries) {
        if (movementIds.has(item.transferOutMovementId) || priorMovementIds.has(item.transferOutMovementId) ||
          movementIds.has(item.destinationMovementId) || priorMovementIds.has(item.destinationMovementId) ||
          anchorIds.has(item.destinationAnchorId) || holdingIds.has(item.destinationHolding.id) || lotIds.has(item.destinationLot.id) ||
          allocations.has(item.allocation.id)) {
          return reject("inventoryOwnership.effectIdentity", "Transfer allocations, movements, anchors, holdings and lots cannot reuse prior or same-command identities");
        }
        movementIds.add(item.transferOutMovementId); movementIds.add(item.destinationMovementId);
        anchorIds.add(item.destinationAnchorId); holdingIds.add(item.destinationHolding.id); lotIds.add(item.destinationLot.id);
        allocations.add(item.allocation.id);
      }
    } else if (operation.kind === "adopt") {
      for (const item of operation.entries) {
        if (movementIds.has(item.movementId) || priorMovementIds.has(item.movementId) || anchorIds.has(item.anchorId) || holdingIds.has(item.holding.id)) {
          return reject("inventoryOwnership.effectIdentity", "Adopted anchors, holdings and movements cannot reuse prior or same-command identities");
        }
        movementIds.add(item.movementId); anchorIds.add(item.anchorId); holdingIds.add(item.holding.id);
      }
    } else {
      for (const item of operation.allocations) {
        if (movementIds.has(item.movementId) || priorMovementIds.has(item.movementId) || allocations.has(item.allocation.id)) {
          return reject("inventoryOwnership.effectIdentity", "Allocation and movement identities must be new and unique across the complete reduction effect");
        }
        movementIds.add(item.movementId); allocations.add(item.allocation.id);
      }
    }
    const checkLink = (link?: NonNullable<Parameters<typeof prepareInventoryPostedReductionGroup>[2]>) => {
      if (link === undefined) return undefined;
      if (postingIds.has(link.postingId) || referenceIds.has(link.referenceId)) {
        return reject("inventoryOwnership.effectPostingIdentity", "An actual posting and its reference identity may be owned by only one complete reduction group");
      }
      postingIds.add(link.postingId);
      referenceIds.add(link.referenceId);
      const source = link.source;
      const sourceHash = hashCanonical({ type: "InventoryReductionJournalSource", value: canonicalAccountingValue({
        journal: canonicalJournalValue(source.journal), commandId: source.commandId, effectKey: source.effectKey,
        bookRevision: source.bookRevision, fiscalPeriodId: source.fiscalPeriodId, canonicalHash: source.canonicalHash,
      }) });
      const previousHash = journalSources.get(source.journal.id), previousJournalId = journalEffects.get(source.effectKey);
      if (previousHash !== undefined && !contentHashEquals(previousHash, sourceHash) || previousJournalId !== undefined && previousJournalId !== source.journal.id) {
        return reject("inventoryOwnership.effectJournalSource", "Every journal identity and effect locator must denote one identical source across the complete effect");
      }
      journalSources.set(source.journal.id, sourceHash);
      journalEffects.set(source.effectKey, source.journal.id);
      return undefined;
    };
    if (operation.kind === "transfer") {
      const srcErr = checkLink(operation.sourceJournalLink);
      if (srcErr) return srcErr;
      const dstErr = checkLink(operation.destinationJournalLink);
      if (dstErr) return dstErr;
    } else if (operation.kind !== "adopt") {
      const linkErr = checkLink(operation.journalLink);
      if (linkErr) return linkErr;
    }
  }
  const used = new Set<LotHoldingId>(), movements: InventoryPostedMovement[] = [], newAnchors: InventoryPostedAnchor[] = [], newLots: Lot[] = [];
  let reductionWork = 0;
  for (const operation of operations) {
    const firstArtifactOrdinal = BigInt(movements.length + newAnchors.length) + 1n;
    if (operation.kind === "acquisition") {
      const prepared = prepareInventoryPostedAcquisitionGroup({ ...context, firstArtifactOrdinal, inventoryPolicy: operation.inventoryPolicy,
        quantizationPolicy: operation.quantizationPolicy, dimensionMemberIds: operation.dimensionMemberIds }, operation.entries, operation.journalLink);
      if (prepared.disposition === "rejected") return prepared;
      for (const [index, movement] of prepared.group.movements.entries()) {
        const holding = prepared.group.holdings[index]!, anchor = prepared.group.anchors[index]!;
        current.set(holding.id, { anchor, holding, position: movement.afterPosition });
      }
      newAnchors.push(...prepared.group.anchors); newLots.push(...prepared.group.lots); movements.push(...prepared.group.movements);
      continue;
    }
    if (operation.kind === "adopt") {
      const prepared = prepareInventoryPostedAdoptionGroup({ ...context, firstArtifactOrdinal, inventoryPolicy: operation.inventoryPolicy,
        quantizationPolicy: operation.quantizationPolicy, dimensionMemberIds: operation.dimensionMemberIds }, operation.entries, operation.postedBalance);
      if (prepared.disposition === "rejected") return prepared;
      for (const [index, movement] of prepared.group.movements.entries()) {
        const holding = prepared.group.holdings[index]!, anchor = prepared.group.anchors[index]!;
        current.set(holding.id, { anchor, holding, position: movement.afterPosition });
      }
      newAnchors.push(...prepared.group.anchors); movements.push(...prepared.group.movements);
      continue;
    }
    if (operation.kind === "transfer") {
      const transferEntries: InventoryPostedTransferEntry[] = [];
      for (const item of operation.entries) {
        const source = current.get(item.allocation.holdingId);
        if (source === undefined) return reject("inventoryOwnership.effectSource", "Every transfer allocation must resolve its original or internally updated current holding");
        const anchor = source.anchor;
        reductionWork += anchor.sourcePostings.length + anchor.incomingMovements.length + anchor.evidence.length + (anchor.predecessorPosition === undefined ? 0 : 1) + anchor.coordinate.dimensionMemberIds.length;
        if (reductionWork > cap) return reject("inventoryOwnership.effect", "Repeated source verification across operations exceeds the effect's work bound");
        transferEntries.push({ ...item, source });
      }
      const prepared = prepareInventoryPostedTransferGroup({ ...context, firstArtifactOrdinal, destinationInventoryPolicy: operation.destinationInventoryPolicy,
        destinationQuantizationPolicy: operation.destinationQuantizationPolicy, destinationDimensionMemberIds: operation.destinationDimensionMemberIds }, transferEntries,
        operation.sourceJournalLink, operation.destinationJournalLink);
      if (prepared.disposition === "rejected") return prepared;
      for (const [index, movement] of prepared.group.transferOutMovements.entries()) {
        const source = current.get(movement.coordinate.holdingId)!;
        current.set(source.holding.id, { anchor: source.anchor, position: movement.afterPosition, holding: prepared.group.afterSourceHoldings[index]! });
        if (originalIds.has(source.holding.id)) used.add(source.holding.id);
        movements.push(movement);
      }
      newAnchors.push(...prepared.group.destinationAnchors);
      newLots.push(...prepared.group.destinationLots);
      for (const [index, movement] of prepared.group.destinationMovements.entries()) {
        const destHolding = prepared.group.destinationHoldings[index]!;
        const destAnchor = prepared.group.destinationAnchors[index]!;
        current.set(destHolding.id, { anchor: destAnchor, holding: destHolding, position: movement.afterPosition });
        movements.push(movement);
      }
      continue;
    }
    const entries: InventoryPostedReductionEntry[] = [];
    for (const item of operation.allocations) {
      const source = current.get(item.allocation.holdingId);
      if (source === undefined) return reject("inventoryOwnership.effectSource", "Every allocation must resolve its original or internally updated current holding");
      const anchor = source.anchor;
      reductionWork += anchor.sourcePostings.length + anchor.incomingMovements.length + anchor.evidence.length + (anchor.predecessorPosition === undefined ? 0 : 1) + anchor.coordinate.dimensionMemberIds.length;
      if (reductionWork > cap) return reject("inventoryOwnership.effect", "Repeated source verification across operations exceeds the effect's work bound");
      entries.push({ ...source, ...item });
    }
    const prepared = prepareInventoryPostedReductionGroup({ ...context, kind: operation.kind, firstArtifactOrdinal }, entries, operation.journalLink);
    if (prepared.disposition === "rejected") return prepared;
    for (const [index, movement] of prepared.group.movements.entries()) {
      const source = current.get(movement.coordinate.holdingId)!;
      current.set(source.holding.id, { anchor: source.anchor, position: movement.afterPosition, holding: prepared.group.afterHoldings[index]! });
      if (originalIds.has(source.holding.id)) used.add(source.holding.id);
      movements.push(movement);
    }
  }
  if (used.size !== sources.length) return reject("inventoryOwnership.effectSource", "An ownership effect's supplied original sources must be exactly its touched holding set");
  const body: Omit<InventoryOwnershipEffect, "contentHash"> = {
    effectKey: context.effectKey, bookRevision: context.bookRevision, newAnchors,
    journalLinkedMovements: movements.filter((movement) => movement.monetaryKind === "journalLinked"),
    quantityOnlyMovements: movements.filter((movement) => movement.monetaryKind === "quantityOnly"),
  };
  const ordered = [...current.values()].sort((left, right) => compareCanonicalText(left.holding.id, right.holding.id));
  return Object.freeze({ disposition: "prepared", effect: immutableAccountingValue({ ...body, contentHash: hashInventoryOwnershipEffect(body) }), newLots: Object.freeze(newLots),
    afterHoldings: Object.freeze(ordered.map((source) => source.holding)), afterPositions: Object.freeze(ordered.map((source) => source.position)) });
}

export interface InventoryOwnershipArtifactTypes {
  readonly anchor: InventoryPostedAnchor;
  readonly position: InventoryPostedPosition;
  readonly reductionMovement: InventoryPostedReductionMovement;
  readonly acquisitionMovement: InventoryPostedAcquisitionMovement;
  readonly reductionEffect: InventoryReductionOwnershipEffect;
  readonly ownershipEffect: InventoryOwnershipEffect;
}
export type InventoryOwnershipArtifactKind = keyof InventoryOwnershipArtifactTypes;

function sameOwnershipValue(left: unknown, right: unknown): boolean {
  return contentHashEquals(hashCanonical(canonicalAccountingValue(left)), hashCanonical(canonicalAccountingValue(right)));
}

function ownershipCoordinateValid(coordinate: InventoryPostedCoordinate): boolean {
  return coordinate.dimensionMemberIds.length <= ACCOUNTING_LIMITS.maxInventoryLayers &&
    coordinate.dimensionMemberIds.every((id, index, ids) => index === 0 || compareCanonicalText(ids[index - 1]!, id) < 0);
}

function ownershipPositionValid(position: InventoryPostedPosition): boolean {
  return contentHashEquals(position.contentHash, hashInventoryPostedPosition(position)) &&
    !position.consumedQuantity.isNegative() && !position.consumedPosted.toRational().isNegative() &&
    referenceValid(position.anchor, position.anchor.bookId) && position.originMovementId.length > 0 && position.originEffectKey.length > 0 &&
    position.originArtifactOrdinal > 0n && position.originBookRevision > 0n &&
    precedes(position.anchor, { effectKey: position.originEffectKey, artifactOrdinal: position.originArtifactOrdinal, bookRevision: position.originBookRevision });
}

function ownershipAnchorValid(anchor: InventoryPostedAnchor): boolean {
  const coordinate = anchor.coordinate;
  if (!contentHashEquals(anchor.contentHash, hashInventoryPostedAnchor(anchor)) || anchor.algorithm !== "cumulativePostedInventoryV1" || !postedAnchorVersionValid(anchor) ||
    anchor.quantity.compare(ExactRational.zero()) <= 0 || anchor.artifactOrdinal <= 0n || anchor.bookRevision <= 0n || anchor.effectKey.length === 0 ||
    !fullHash(anchor.inventoryPolicy.policyContentHash) || !ownershipCoordinateValid(coordinate) ||
    anchor.quantizationPolicy.bookId !== coordinate.bookId || anchor.quantizationPolicy.functionalCommodityId !== coordinate.functionalCommodityId) return false;
  const refs = [...anchor.incomingMovements, ...(anchor.predecessorPosition === undefined ? [] : [anchor.predecessorPosition])];
  const sourceCount = refs.length + anchor.sourcePostings.length + anchor.evidence.length;
  if (sourceCount === 0 || sourceCount > ACCOUNTING_LIMITS.maxInventoryLayers ||
    refs.some((reference) => !referenceValid(reference, coordinate.bookId) || !precedes(reference, anchor)) ||
    new Set(anchor.incomingMovements.map((reference) => reference.id)).size !== anchor.incomingMovements.length ||
    anchor.sourcePostings.some((reference) => reference.bookId !== coordinate.bookId || !validateCanonicalPostingReferenceHash(reference)) ||
    new Set(anchor.sourcePostings.map((reference) => reference.postingId)).size !== anchor.sourcePostings.length ||
    anchor.evidence.some((evidence) => !fullHash(evidence.contentHash)) || new Set(anchor.evidence.map((evidence) => evidence.id)).size !== anchor.evidence.length) return false;
  if (anchor.postedValue !== undefined) {
    const values = allocateInventoryPostedValue(anchor.postedValue, ExactRational.zero(), ExactRational.zero(), anchor.quantizationPolicy);
    if (values.disposition === "rejected" || !values.carryingRemaining.toRational().equals(anchor.postedBudget.toRational())) return false;
  }
  return quantizeCumulativePostedShare(anchor.postedBudget, ExactRational.zero(), ExactRational.zero(), anchor.quantizationPolicy).disposition === "quantized";
}

export function isInventoryPostedReductionMovement(movement: InventoryPostedMovement): movement is InventoryPostedReductionMovement {
  return movement.kind === "disposal" || movement.kind === "transferOut";
}

function ownershipMovementValid(movement: InventoryPostedReductionMovement): boolean {
  const c = movement.coordinate, after = movement.afterPosition, allocation = movement.quantityAllocation, proof = movement.reductionProof;
  if (!contentHashEquals(movement.contentHash, hashInventoryPostedReductionMovement(movement)) ||
    !(["disposal", "transferOut"] as const).includes(movement.kind) || movement.bookRevision <= 0n || movement.artifactOrdinal <= 0n || movement.effectKey.length === 0 ||
    !ownershipCoordinateValid(c) || !ownershipPositionValid(after) || !referenceValid(movement.beforePosition, c.bookId) || !precedes(movement.beforePosition, movement) ||
    movement.beforePosition.id !== c.holdingId || after.holdingId !== c.holdingId || after.anchor.bookId !== c.bookId ||
    after.originMovementId !== movement.id || after.originEffectKey !== movement.effectKey || after.originArtifactOrdinal !== movement.artifactOrdinal || after.originBookRevision !== movement.bookRevision ||
    allocation.holdingId !== c.holdingId || allocation.lotId !== c.lotId || allocation.allocatedQuantity.compare(ExactRational.zero()) <= 0 ||
    allocation.allocatedTotalBasis.isNegative() || allocation.allocatedValuationAllowance.compare(ExactRational.zero()) > 0 || allocation.allocatedCarryingAmount.isNegative() ||
    !allocation.allocatedCarryingAmount.equals(allocation.allocatedTotalBasis.add(allocation.allocatedValuationAllowance)) ||
    movement.incomingSources.length !== 0 || proof.policy.bookId !== c.bookId || proof.policy.functionalCommodityId !== c.functionalCommodityId ||
    proof.afterFraction.compare(proof.beforeFraction) <= 0 || after.consumedQuantity.compare(allocation.allocatedQuantity) < 0 ||
    !after.consumedQuantity.multiply(proof.afterFraction.subtract(proof.beforeFraction)).equals(allocation.allocatedQuantity.multiply(proof.afterFraction))) return false;
  const recomputed = quantizeCumulativePostedShare(proof.postedTotal, proof.beforeFraction, proof.afterFraction, proof.policy);
  if (recomputed.disposition !== "quantized" || !sameOwnershipValue(proof, recomputed.share) ||
    !sameOwnershipValue(after.consumedPosted, proof.afterQuantization.amount) ||
    !sameOwnershipValue(movement.postedAmount, ExactDecimal.of(-proof.postedAmount.coefficient, proof.postedAmount.scale))) return false;
  if (movement.monetaryKind === "quantityOnly") return movement.postedAmount.isZero() && !Object.hasOwn(movement, "posting");
  return movement.monetaryKind === "journalLinked" && movement.postedAmount.toRational().isNegative() &&
    movement.posting.bookId === c.bookId && movement.posting.effectKey !== movement.effectKey && validateCanonicalPostingReferenceHash(movement.posting);
}

function ownershipAcquisitionMovementValid(movement: InventoryPostedAcquisitionMovement): boolean {
  const p = movement.afterPosition, c = movement.coordinate, proof = movement.acquisitionProof;
  if (!contentHashEquals(movement.contentHash, hashInventoryPostedAcquisitionMovement(movement)) ||
    !(["acquisition", "transferIn", "legacyAdoption"] as const).includes(movement.kind) ||
    movement.effectKey.length === 0 || movement.bookRevision <= 0n || movement.artifactOrdinal <= 1n || !ownershipCoordinateValid(c) ||
    !ownershipPositionValid(p) || p.holdingId !== c.holdingId || p.anchor.bookId !== c.bookId ||
    p.anchor.effectKey !== movement.effectKey || p.anchor.bookRevision !== movement.bookRevision || p.anchor.artifactOrdinal >= movement.artifactOrdinal ||
    p.originMovementId !== movement.id || p.originEffectKey !== movement.effectKey || p.originBookRevision !== movement.bookRevision || p.originArtifactOrdinal !== movement.artifactOrdinal ||
    !p.consumedQuantity.isZero() || !p.consumedPosted.isZero() ||
    proof.policy.bookId !== c.bookId || proof.policy.functionalCommodityId !== c.functionalCommodityId) return false;
  if (movement.kind === "transferIn") {
    if (movement.incomingSources.length !== 1) return false;
    const incoming = movement.incomingSources[0]!;
    if (!referenceValid(incoming, c.bookId) || !precedes(incoming, movement)) return false;
  } else {
    if (movement.incomingSources.length !== 0) return false;
  }
  const recomputed = quantizeCumulativePostedShare(proof.postedTotal, proof.beforeFraction, proof.afterFraction, proof.policy);
  if (recomputed.disposition === "rejected" || !sameOwnershipValue(proof, recomputed.share) || !sameOwnershipValue(movement.postedAmount, proof.postedAmount)) return false;
  if (movement.monetaryKind === "quantityOnly") return movement.postedAmount.isZero() && !Object.hasOwn(movement, "posting");
  if (movement.kind === "legacyAdoption") return false;
  return movement.monetaryKind === "journalLinked" && movement.postedAmount.toRational().compare(ExactRational.zero()) > 0 &&
    movement.posting.bookId === c.bookId && movement.posting.effectKey !== movement.effectKey && validateCanonicalPostingReferenceHash(movement.posting);
}

function ownershipReductionEffectValid(effect: InventoryReductionOwnershipEffect): boolean {
  const count = effect.journalLinkedMovements.length + effect.quantityOnlyMovements.length;
  if (effect.newAnchors.length !== 0 || count === 0 || count > ACCOUNTING_LIMITS.maxInventoryLayers || effect.effectKey.length === 0 || effect.bookRevision <= 0n ||
    !contentHashEquals(effect.contentHash, hashInventoryReductionOwnershipEffect(effect))) return false;
  const ids = new Set<string>(), allocations = new Set<string>();
  const all = [...effect.journalLinkedMovements, ...effect.quantityOnlyMovements].sort((a, b) => a.artifactOrdinal < b.artifactOrdinal ? -1 : a.artifactOrdinal > b.artifactOrdinal ? 1 : 0);
  const first = all[0]!;
  const current = new Map<LotHoldingId, InventoryPostedReductionMovement>();
  for (const [index, movement] of all.entries()) {
    if (!ownershipMovementValid(movement) || movement.artifactOrdinal !== BigInt(index + 1) || movement.effectKey !== effect.effectKey || movement.bookRevision !== effect.bookRevision ||
      movement.coordinate.bookId !== first.coordinate.bookId || movement.accountingDate !== first.accountingDate || movement.fiscalPeriodId !== first.fiscalPeriodId ||
      ids.has(movement.id) || allocations.has(movement.quantityAllocation.id) || movement.afterPosition.anchor.bookRevision >= effect.bookRevision) return false;
    ids.add(movement.id);
    allocations.add(movement.quantityAllocation.id);
    const previous = current.get(movement.coordinate.holdingId);
    if (previous === undefined) {
      if (movement.beforePosition.bookRevision >= effect.bookRevision) return false;
    } else {
      const after = previous.afterPosition;
      if (!sameOwnershipValue(movement.coordinate, previous.coordinate) || !sameOwnershipValue(movement.afterPosition.anchor, after.anchor) ||
        !sameOwnershipValue(movement.beforePosition, { id: after.holdingId, contentHash: after.contentHash, bookId: previous.coordinate.bookId,
          effectKey: after.originEffectKey, artifactOrdinal: after.originArtifactOrdinal, bookRevision: after.originBookRevision }) ||
        !movement.afterPosition.consumedQuantity.subtract(after.consumedQuantity).equals(movement.quantityAllocation.allocatedQuantity) ||
        !movement.afterPosition.consumedPosted.toRational().subtract(after.consumedPosted.toRational()).equals(movement.postedAmount.toRational().negate()) ||
        !movement.reductionProof.beforeFraction.equals(previous.reductionProof.afterFraction) ||
        !sameOwnershipValue(movement.reductionProof.postedTotal, previous.reductionProof.postedTotal) || !sameOwnershipValue(movement.reductionProof.policy, previous.reductionProof.policy)) return false;
    }
    current.set(movement.coordinate.holdingId, movement);
  }
  return effect.journalLinkedMovements.every((movement, index, values) => movement.monetaryKind === "journalLinked" && (index === 0 || values[index - 1]!.artifactOrdinal < movement.artifactOrdinal)) &&
    effect.quantityOnlyMovements.every((movement, index, values) => movement.monetaryKind === "quantityOnly" && (index === 0 || values[index - 1]!.artifactOrdinal < movement.artifactOrdinal));
}

function ownershipEffectValid(effect: InventoryOwnershipEffect): boolean {
  const movements = [...effect.journalLinkedMovements, ...effect.quantityOnlyMovements];
  if (effect.newAnchors.length > ACCOUNTING_LIMITS.maxInventoryLayers || movements.length === 0 || movements.length > ACCOUNTING_LIMITS.maxInventoryLayers ||
    effect.effectKey.length === 0 || effect.bookRevision <= 0n || !contentHashEquals(effect.contentHash, hashInventoryOwnershipEffect(effect))) return false;
  const first = movements[0]!;
  const artifacts = [...effect.newAnchors.map((anchor) => ({ kind: "anchor" as const, ordinal: anchor.artifactOrdinal, anchor })),
    ...movements.map((movement) => ({ kind: "movement" as const, ordinal: movement.artifactOrdinal, movement }))].sort((a, b) => a.ordinal < b.ordinal ? -1 : a.ordinal > b.ordinal ? 1 : 0);
  const anchors = new Map<string, InventoryPostedAnchor>(), newHoldings = new Set<string>(), newLots = new Set<string>(), usedAnchors = new Set<string>();
  const current = new Map<string, InventoryPostedMovement>(), ids = new Set<string>(), allocations = new Set<string>();
  for (const [index, artifact] of artifacts.entries()) {
    if (artifact.ordinal !== BigInt(index + 1)) return false;
    if (artifact.kind === "anchor") {
      const anchor = artifact.anchor;
      if (!ownershipAnchorValid(anchor) || anchor.effectKey !== effect.effectKey || anchor.bookRevision !== effect.bookRevision || anchor.coordinate.bookId !== first.coordinate.bookId ||
        anchor.evidence.length === 0 ||
        anchors.has(anchor.id) || newHoldings.has(anchor.coordinate.holdingId) || current.has(anchor.coordinate.holdingId)) return false;
      if (anchor.predecessorPosition !== undefined) {
        if (anchor.incomingMovements.length !== 1 || newLots.has(anchor.coordinate.lotId)) return false;
        newLots.add(anchor.coordinate.lotId);
      } else {
        if (anchor.incomingMovements.length !== 0) return false;
      }
      anchors.set(anchor.id, anchor); newHoldings.add(anchor.coordinate.holdingId);
      continue;
    }
    const movement = artifact.movement, p = movement.afterPosition, previous = current.get(movement.coordinate.holdingId);
    if (movement.effectKey !== effect.effectKey || movement.bookRevision !== effect.bookRevision || movement.coordinate.bookId !== first.coordinate.bookId ||
      movement.accountingDate !== first.accountingDate || movement.fiscalPeriodId !== first.fiscalPeriodId || ids.has(movement.id)) return false;
    ids.add(movement.id);
    const anchor = anchors.get(p.anchor.id);
    if (anchor !== undefined && (!sameOwnershipValue(p.anchor, { id: anchor.id, contentHash: anchor.contentHash, bookId: anchor.coordinate.bookId,
      effectKey: anchor.effectKey, artifactOrdinal: anchor.artifactOrdinal, bookRevision: anchor.bookRevision }) || !sameOwnershipValue(movement.coordinate, anchor.coordinate))) return false;
    if (movement.kind === "acquisition" || movement.kind === "transferIn" || movement.kind === "legacyAdoption") {
      if (!ownershipAcquisitionMovementValid(movement) || previous !== undefined || anchor === undefined || usedAnchors.has(anchor.id) ||
        !sameOwnershipValue(movement.coordinate, anchor.coordinate) ||
        !sameOwnershipValue(movement.acquisitionProof.policy, anchor.quantizationPolicy)) return false;
      if (movement.kind !== "transferIn" && anchor.postedValue !== undefined &&
        (!anchor.postedValue.allowance.isZero() || !anchor.postedValue.basis.toRational().equals(anchor.postedBudget.toRational()))) return false;
      if (movement.kind === "legacyAdoption") {
        if (movement.monetaryKind !== "quantityOnly" || !movement.postedAmount.isZero() ||
          !movement.acquisitionProof.postedTotal.isZero() ||
          anchor.predecessorPosition !== undefined || anchor.incomingMovements.length !== 0) return false;
      } else {
        if (!sameOwnershipValue(movement.postedAmount, anchor.postedBudget) ||
          anchor.sourcePostings.length !== (movement.acquisitionProof.postedTotal.isZero() ? 0 : 1) ||
          movement.monetaryKind === "journalLinked" && !sameOwnershipValue(anchor.sourcePostings[0], movement.posting)) return false;
        if (movement.kind === "transferIn") {
          if (anchor.predecessorPosition === undefined || anchor.incomingMovements.length !== 1 || movement.incomingSources.length !== 1 ||
            !sameOwnershipValue(anchor.incomingMovements[0], movement.incomingSources[0])) return false;
          const transferOut = current.get(anchor.predecessorPosition.id);
          if (transferOut === undefined || transferOut.kind !== "transferOut" || transferOut.id !== movement.incomingSources[0]!.id) return false;
        } else {
          if (anchor.predecessorPosition !== undefined || anchor.incomingMovements.length !== 0 || movement.incomingSources.length !== 0) return false;
        }
      }
      usedAnchors.add(anchor.id);
    } else if (isInventoryPostedReductionMovement(movement)) {
      if (!ownershipMovementValid(movement) || allocations.has(movement.quantityAllocation.id)) return false;
      allocations.add(movement.quantityAllocation.id);
      if (anchor !== undefined && (!sameOwnershipValue(movement.reductionProof.postedTotal, anchor.postedBudget) ||
        !sameOwnershipValue(movement.reductionProof.policy, anchor.quantizationPolicy) ||
        !anchor.quantity.multiply(movement.reductionProof.afterFraction).equals(p.consumedQuantity))) return false;
      if (previous === undefined) {
        if (movement.beforePosition.bookRevision >= effect.bookRevision || p.anchor.bookRevision >= effect.bookRevision) return false;
      } else {
        const before = previous.afterPosition;
        if (!sameOwnershipValue(movement.coordinate, previous.coordinate) || !sameOwnershipValue(p.anchor, before.anchor) ||
          !sameOwnershipValue(movement.beforePosition, { id: before.holdingId, contentHash: before.contentHash, bookId: previous.coordinate.bookId,
            effectKey: before.originEffectKey, artifactOrdinal: before.originArtifactOrdinal, bookRevision: before.originBookRevision }) ||
          !p.consumedQuantity.subtract(before.consumedQuantity).equals(movement.quantityAllocation.allocatedQuantity) ||
          !p.consumedPosted.toRational().subtract(before.consumedPosted.toRational()).equals(movement.postedAmount.toRational().negate()) ||
          !movement.reductionProof.beforeFraction.equals(isInventoryPostedReductionMovement(previous) ? previous.reductionProof.afterFraction : ExactRational.zero())) return false;
        if (isInventoryPostedReductionMovement(previous) && (!sameOwnershipValue(movement.reductionProof.postedTotal, previous.reductionProof.postedTotal) ||
          !sameOwnershipValue(movement.reductionProof.policy, previous.reductionProof.policy))) return false;
      }
    } else {
      return false;
    }
    current.set(movement.coordinate.holdingId, movement);
  }
  return usedAnchors.size === anchors.size &&
    effect.newAnchors.every((anchor, i, values) => i === 0 || values[i - 1]!.artifactOrdinal < anchor.artifactOrdinal) &&
    effect.journalLinkedMovements.every((movement, i, values) => movement.monetaryKind === "journalLinked" && (i === 0 || values[i - 1]!.artifactOrdinal < movement.artifactOrdinal)) &&
    effect.quantityOnlyMovements.every((movement, i, values) => movement.monetaryKind === "quantityOnly" && (i === 0 || values[i - 1]!.artifactOrdinal < movement.artifactOrdinal));
}

/** Typed, source-free integrity checks used AFTER strict shape decoding. These
 * verify hashes and relationships contained in the artifact, not referenced
 * source existence, complete posting attribution, costing policy admission,
 * currentness or command replay. A successful result is not accounting authority. */
export function validateInventoryOwnershipArtifact<K extends InventoryOwnershipArtifactKind>(kind: K, artifact: InventoryOwnershipArtifactTypes[K]): boolean {
  switch (kind) {
    case "anchor": return ownershipAnchorValid(artifact as InventoryPostedAnchor);
    case "position": return ownershipPositionValid(artifact as InventoryPostedPosition);
    case "reductionMovement": return ownershipMovementValid(artifact as InventoryPostedReductionMovement);
    case "acquisitionMovement": return ownershipAcquisitionMovementValid(artifact as InventoryPostedAcquisitionMovement);
    case "reductionEffect": return ownershipReductionEffectValid(artifact as InventoryReductionOwnershipEffect);
    case "ownershipEffect": return ownershipEffectValid(artifact as InventoryOwnershipEffect);
    default: return false;
  }
}

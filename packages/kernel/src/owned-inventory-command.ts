import { contentHashEquals, hashCanonical, compareCanonicalText, type ContentHash, type Identifier } from "./canonical.ts";
import { ACCOUNTING_LIMITS, accountingCapabilityAdmits, canonicalAccountingValue, hashAccountingPolicy, immutableAccountingValue, verifyAccountingPolicyArtifacts, validAccountingDerivation, type AccountingPolicy, type InventoryCostPolicy, type CanonicalPostingReferenceId, type CanonicalPostingReference } from "./accounting.ts";
import { canonicalPolicyValue, selectBookingPolicy, type BookingPolicy, type PolicyId, type SemanticVersion, type DerivationRecord, type ResolvedTransaction, type SourceEvidence } from "./policy.ts";
import { canonicalJournalValue, diagnostic, validateAccountingCoordinate, type AccountId, type BookId, type CommodityId, type DimensionMemberId, type Instant, type LocalDate, type PostingId, type JournalAdmissionSnapshot, type SemanticDiagnostic } from "./journal.ts";
import { quantize, hashQuantizationPolicy, type QuantizationPolicy } from "./quantization.ts";
import { ExactRational } from "./numeric.ts";
import type { BookedJournal } from "./book.ts";
import type { Lot, LotHolding, LotHoldingId, LotAllocation } from "./lots.ts";
import { prepareInventoryOwnershipSelection, prepareInventoryPostedAcquisitionGroup, prepareInventoryPostedReductionGroup, prepareInventoryPostedTransferGroup, prepareInventoryPostedAdoptionGroup, prepareInventoryOwnershipEffect, resolveInventoryOwnershipSources,
  type InventoryPostedAcquisitionEntry, type InventoryOwnershipOperation, type InventoryOwnershipReadContext,
  type InventoryPostedReductionSource, type InventoryReductionEffectContext, type InventoryOwnershipSelectionRequest,
  type InventoryPostedPosition, type InventoryPostedAnchor,
} from "./inventory-ownership.ts";

export interface OwnedInventoryPolicyReference {
  readonly policyId: PolicyId;
  readonly policyVersion: SemanticVersion;
  readonly policyContentHash: ContentHash;
}
export interface OwnedInventoryCoordinateInput {
  readonly accountId: AccountId;
  readonly unitsCommodityId: CommodityId;
  readonly dimensionMemberIds: readonly DimensionMemberId[];
  readonly bookingPolicy: OwnedInventoryPolicyReference;
}
export interface OwnedInventoryPostingLink {
  readonly journalOrdinal: bigint;
  readonly postingId: PostingId;
  readonly referenceId: CanonicalPostingReferenceId;
}
interface OwnedInventoryOperationCore {
  readonly ordinal: bigint;
  readonly id: Identifier<"InventoryOperation">;
  readonly coordinate: OwnedInventoryCoordinateInput;
  readonly inventoryPolicy: OwnedInventoryPolicyReference;
  readonly derivation: DerivationRecord;
  readonly postingLink?: OwnedInventoryPostingLink;
}
export interface OwnedInventoryTransferEntryInput {
  readonly holdingId: LotHoldingId;
  readonly allocationId: LotAllocation["id"];
  readonly transferOutMovementId: InventoryPostedPosition["originMovementId"];
  readonly destinationAnchorId: InventoryPostedAnchor["id"];
  readonly destinationMovementId: InventoryPostedPosition["originMovementId"];
  readonly destinationHoldingId: LotHoldingId;
  readonly destinationLotId: Lot["id"];
  readonly evidence: readonly SourceEvidence[];
}
export interface OwnedInventoryAdoptionEntryInput {
  readonly anchorId: InventoryPostedAnchor["id"];
  readonly movementId: InventoryPostedPosition["originMovementId"];
  readonly holdingId: LotHoldingId;
  readonly evidence: readonly SourceEvidence[];
  readonly historicalPostings: readonly CanonicalPostingReference[];
}
export type OwnedInventoryOperationInput = OwnedInventoryOperationCore & (
  | { readonly kind: "acquisition"; readonly entries: readonly InventoryPostedAcquisitionEntry[] }
  | { readonly kind: "issue"; readonly quantity: ExactRational; readonly specificHoldingIds?: readonly string[];
      readonly identities: InventoryOwnershipSelectionRequest["identities"] }
  | { readonly kind: "transfer";
      readonly destinationCoordinate: OwnedInventoryCoordinateInput;
      readonly destinationInventoryPolicy: OwnedInventoryPolicyReference;
      readonly quantity: ExactRational;
      readonly specificHoldingIds?: readonly string[];
      readonly destinationPostingLink?: OwnedInventoryPostingLink;
      readonly entries: readonly OwnedInventoryTransferEntryInput[];
    }
  | { readonly kind: "adopt";
      readonly entries: readonly OwnedInventoryAdoptionEntryInput[];
      readonly postedBalance: ExactRational;
    }
);
export interface OwnedInventoryTransactionRequest {
  readonly algorithm: string;
  readonly algorithmVersion: SemanticVersion;
  readonly accountingDate: LocalDate;
  readonly governedAt: Instant;
  readonly fiscalPeriodId: Identifier<"FiscalPeriod">;
  readonly operations: readonly OwnedInventoryOperationInput[];
  readonly resolvedJournals: readonly ResolvedTransaction[];
}
export interface InventoryMoneyScope {
  readonly bookId: BookId;
  readonly accountId: AccountId;
  readonly functionalCommodityId: CommodityId;
  readonly dimensionMemberIds: readonly DimensionMemberId[];
}
export type OwnedInventoryIdentityKind = "operation" | "lot" | "holding" | "anchor" | "movement" | "allocation" | "postingReference";

/** Trusted internal inputs AFTER complete command/configuration/opening/period
 * and journal admission. This is not an external command API. All callback
 * answers are authenticated at ownership's one pinned head; unknown evidence
 * throws, never becomes false/absence. Accounting dates remain explicit and
 * separate from economic instants. Journals are already admitted
 * in input order by prepareBookJournal for this exact command origin.
 * This accounting stage creates no intent, revision, receipt or persistence. */
export interface OwnedInventoryAccountingContext extends InventoryReductionEffectContext {
  readonly functionalCommodityId: CommodityId;
  readonly ownerId: string;
  readonly admissionSnapshot: JournalAdmissionSnapshot;
  readonly bookingPolicies: readonly BookingPolicy[];
  readonly accountingPolicies: readonly AccountingPolicy[];
  readonly quantizationPolicies: readonly QuantizationPolicy[];
  readonly journals: readonly BookedJournal[];
  readonly ownership: InventoryOwnershipReadContext;
  /** Version 1.2.0 reads the complete active pool (nonzero quantity); prior
   * versions include depleted rows for their unchanged historical work bounds.
   * Permanent identity conflicts remain independent of selection membership. */
  readPool(policy: InventoryCostPolicy, commodity: CommodityId): readonly { readonly lot: Lot; readonly holding: LotHolding }[];
  identityPresence(kind: OwnedInventoryIdentityKind, id: string): "present" | "absent";
  managedMoneyScope(scope: InventoryMoneyScope): "managed" | "unmanaged";
  latestMovementDate(holdingId: LotHoldingId): LocalDate;
}

function failure(path: string, message: string): { readonly disposition: "rejected"; readonly diagnostics: readonly SemanticDiagnostic[] } {
  return Object.freeze({ disposition: "rejected", diagnostics: Object.freeze([
    diagnostic("inventory_cost_policy_incoherent", path, message, ["ACC-039.7", "ACC-039.8", "ACC-039.9"]),
  ]) });
}
function scopeKey(scope: InventoryMoneyScope): string {
  return JSON.stringify([scope.bookId, scope.accountId, scope.functionalCommodityId, [...scope.dimensionMemberIds].sort(compareCanonicalText)]);
}

/** Compile admitted journal/coordinate inputs and complete policy pools into one
 * immutable ownership candidate. Same-command successors are internal, and all
 * operations fail atomically. Canonical owned-command preparation uses this
 * compiler; protocol/global admission and commit publication remain outside it. */
export function prepareOwnedInventoryAccounting(context: OwnedInventoryAccountingContext, supplied: OwnedInventoryTransactionRequest) {
  const request = immutableAccountingValue(supplied);
  const head = context.ownership.bookRevision;
  const read = <T>(action: () => T): T => {
    context.ownership.assertCurrent();
    if (context.ownership.bookId !== context.bookId || context.ownership.bookRevision !== head) throw new Error("Owned inventory read scope changed");
    const value = action();
    context.ownership.assertCurrent();
    if (context.ownership.bookId !== context.bookId || context.ownership.bookRevision !== head) throw new Error("Owned inventory read scope changed");
    return value;
  };
  read(() => undefined);
  const cap = ACCOUNTING_LIMITS.maxInventoryLayers;
  if (request.algorithm !== "cumulativePostedInventoryV1" || !["1.0.0", "1.1.0", "1.2.0"].includes(request.algorithmVersion) ||
    request.algorithmVersion === "1.0.0" && request.operations.some((operation) => operation.kind !== "acquisition" && operation.kind !== "issue") || context.bookRevision !== head + 1n ||
    request.accountingDate !== context.accountingDate || request.fiscalPeriodId !== context.fiscalPeriodId ||
    request.operations.length === 0 || request.operations.length > cap || context.journals.length !== request.resolvedJournals.length || context.journals.length > cap) {
    return failure("ownedInventory.request", "Unsupported profile, incoherent origin or empty/unbounded operation population");
  }
  let work = context.journals.reduce((total, booked) => total + booked.journal.postings.length, 0);
  for (const [index, booked] of context.journals.entries()) {
    if (booked.commandId !== context.commandId || booked.bookRevision !== context.bookRevision || booked.fiscalPeriodId !== context.fiscalPeriodId ||
      booked.effectKey !== `${context.commandId}:journal:${index}` || booked.journal.accountingDate !== request.accountingDate || booked.journal.economicAt !== request.governedAt ||
      (booked.journal.kind !== "ordinary" && booked.journal.kind !== "adjustment") ||
      !contentHashEquals(booked.canonicalHash, hashCanonical(canonicalJournalValue(request.resolvedJournals[index]!.journal)))) {
      return failure("ownedInventory.journals", "Every admitted journal must bind the exact request, command order, date and period");
    }
  }
  for (const operation of request.operations) {
    work += 1 + operation.coordinate.dimensionMemberIds.length + operation.derivation.evidence.length;
    if (operation.kind === "acquisition") {
      work += operation.entries.length;
      if (work > cap) return failure("ownedInventory.bounds", "Combined command populations exceed the accounting work bound");
      for (const entry of operation.entries) {
        work += entry.evidence.length + entry.lot.evidenceIds.length;
        if (work > cap) return failure("ownedInventory.bounds", "Combined command populations exceed the accounting work bound");
      }
    } else if (operation.kind === "transfer") {
      work += operation.entries.length + operation.destinationCoordinate.dimensionMemberIds.length;
      if (work > cap) return failure("ownedInventory.bounds", "Combined command populations exceed the accounting work bound");
      for (const entry of operation.entries) {
        work += entry.evidence.length;
        if (work > cap) return failure("ownedInventory.bounds", "Combined command populations exceed the accounting work bound");
      }
    } else if (operation.kind === "adopt") {
      work += operation.entries.length;
      if (work > cap) return failure("ownedInventory.bounds", "Combined command populations exceed the accounting work bound");
      for (const entry of operation.entries) {
        work += entry.evidence.length + entry.historicalPostings.length;
        if (work > cap) return failure("ownedInventory.bounds", "Combined command populations exceed the accounting work bound");
      }
    } else work += operation.identities.length + (operation.specificHoldingIds?.length ?? 0);
    if (work > cap) return failure("ownedInventory.bounds", "Combined command populations exceed the accounting work bound");
  }
  const claimed = new Set<string>();
  const claim = (kind: OwnedInventoryIdentityKind, id: string): boolean => {
    const key = JSON.stringify([kind, id]);
    const presence = read(() => context.identityPresence(kind, id));
    if (presence !== "present" && presence !== "absent") throw new Error("Incomplete owned inventory identity evidence");
    if (id.length === 0 || claimed.has(key) || presence === "present") return false;
    claimed.add(key); return true;
  };
  const originals = new Map<LotHoldingId, InventoryPostedReductionSource>();
  const current = new Map<LotHoldingId, InventoryPostedReductionSource>();
  const newLots = new Map<string, Lot>();
  const compiled: InventoryOwnershipOperation[] = [];
  const usedPostings = new Set<PostingId>(), ownedScopes = new Set<string>();
  let artifactOrdinal = 1n;
  for (const [index, operation] of request.operations.entries()) {
    if (operation.ordinal !== BigInt(index) || !claim("operation", operation.id)) return failure("ownedInventory.order", "Operation ordinals must be contiguous and identities permanently new");
    const coordinate = operation.coordinate;
    const bookingMatches = context.bookingPolicies.filter((p) => p.id === coordinate.bookingPolicy.policyId && p.version === coordinate.bookingPolicy.policyVersion);
    const booking = bookingMatches[0];
    if (bookingMatches.length !== 1 || booking === undefined ||
      booking.scope === "account" && booking.scopeKey !== coordinate.accountId ||
      booking.scope === "legalEntity" && booking.scopeKey !== context.ownerId || booking.scope === "jurisdictionPool" ||
      !contentHashEquals(hashCanonical(canonicalPolicyValue(booking)), coordinate.bookingPolicy.policyContentHash)) {
      return failure("ownedInventory.bookingPolicy", "Coordinate policy must resolve its exact hash and actual account/entity scope");
    }
    const selectedBooking = selectBookingPolicy(context.bookingPolicies, { bookId: context.bookId, governedAt: request.governedAt, scopeKey: booking.scopeKey });
    if (selectedBooking.disposition === "rejected") return selectedBooking;
    if (selectedBooking.policy !== booking || coordinate.dimensionMemberIds.some((id, i, ids) => i > 0 && compareCanonicalText(ids[i - 1]!, id) >= 0)) {
      return failure("ownedInventory.coordinate", "Coordinate policy selection or canonical member order is incoherent");
    }
    const diagnostics = validateAccountingCoordinate(context.admissionSnapshot, { ...coordinate, bookId: context.bookId,
      functionalCommodityId: context.functionalCommodityId, accountingDate: request.accountingDate }, booking.requiredDimensionIds);
    if (diagnostics.length > 0) return Object.freeze({ disposition: "rejected" as const, diagnostics });
    const matches = context.accountingPolicies.filter((p): p is InventoryCostPolicy => p.kind === "inventoryCost" && p.id === operation.inventoryPolicy.policyId && p.version === operation.inventoryPolicy.policyVersion);
    const policy = matches[0];
    if (matches.length !== 1 || policy === undefined || policy.bookId !== context.bookId || policy.algorithmVersion !== "1.0.0" ||
      policy.validFrom > request.governedAt || policy.validTo !== undefined && request.governedAt >= policy.validTo ||
      !contentHashEquals(hashAccountingPolicy(policy), operation.inventoryPolicy.policyContentHash) || !verifyAccountingPolicyArtifacts([policy]) ||
      policy.capability.feature !== "inventoryCost" || policy.capability.status !== "supported" || policy.capability.implementationVersion !== policy.algorithmVersion ||
      policy.capability.verificationEvidenceIds.length === 0 || !accountingCapabilityAdmits(policy.capability, { method: policy.method }) ||
      !policy.pools.some((pool) => pool.accountId === coordinate.accountId) ||
      !validAccountingDerivation(operation.derivation) || operation.derivation.policyId !== policy.id || operation.derivation.policyVersion !== policy.version || operation.derivation.algorithmVersion !== policy.algorithmVersion) {
      return failure("ownedInventory.policy", "Inventory policy, capability, pool, full hash and approved derivation must agree");
    }
    const quantization = policy.quantizationPolicy;
    if (quantization.bookId !== context.bookId || quantization.functionalCommodityId !== context.functionalCommodityId ||
      quantization.validFrom > request.accountingDate || quantization.validTo !== undefined && request.accountingDate >= quantization.validTo ||
      context.quantizationPolicies.filter((q) => contentHashEquals(hashQuantizationPolicy(q), hashQuantizationPolicy(quantization))).length !== 1) {
      return failure("ownedInventory.quantization", "Acquisition/selection policy requires one applicable complete quantization policy");
    }
    const scope = { bookId: context.bookId, functionalCommodityId: context.functionalCommodityId, ...coordinate };
    ownedScopes.add(scopeKey(scope));
    const link = operation.postingLink;
    const booked = link === undefined ? undefined : context.journals[Number(link.journalOrdinal)];
    if (link !== undefined && (link.journalOrdinal < 0n || link.journalOrdinal >= BigInt(context.journals.length) || booked === undefined || usedPostings.has(link.postingId) || !claim("postingReference", link.referenceId))) {
      return failure("ownedInventory.postingLink", "Each group requires a unique actual same-command journal posting and reference identity");
    }
    const journalLink = booked === undefined || link === undefined ? undefined : { source: booked, postingId: link.postingId, referenceId: link.referenceId };
    if (link !== undefined) usedPostings.add(link.postingId);
    if (operation.kind === "acquisition") {
      let carrying = ExactRational.zero();
      for (const entry of operation.entries) {
        if (!claim("lot", entry.lot.id) || !claim("holding", entry.holding.id) || !claim("anchor", entry.anchorId) || !claim("movement", entry.movementId) ||
          entry.holding.accountId !== coordinate.accountId || entry.holding.commodityId !== coordinate.unitsCommodityId ||
          !entry.holding.remainingValuationAllowance.isZero() || entry.lot.acquiredAt > request.governedAt) {
          return failure("ownedInventory.acquisition", "Acquisition needs new identities, matching coordinate, no initial allowance and nonfuture acquisition dates");
        }
        carrying = carrying.add(entry.holding.remainingCarryingAmount);
      }
      const expected = quantize(carrying, quantization).amount;
      const actual = booked?.journal.postings.find((p) => p.id === link?.postingId);
      if (journalLink === undefined ? !expected.isZero() : actual === undefined || !actual.bookValue.amount.toRational().equals(expected.toRational())) {
        return failure("ownedInventory.acquisitionMoney", "Actual acquisition posting must equal governed aggregate carrying quantization");
      }
      const prepared = prepareInventoryPostedAcquisitionGroup({ ...context, firstArtifactOrdinal: artifactOrdinal, inventoryPolicy: operation.inventoryPolicy,
        quantizationPolicy: quantization, dimensionMemberIds: coordinate.dimensionMemberIds }, operation.entries, journalLink);
      if (prepared.disposition === "rejected") return prepared;
      for (const [i, movement] of prepared.group.movements.entries()) {
        const holding = prepared.group.holdings[i]!, anchor = prepared.group.anchors[i]!;
        current.set(holding.id, { holding, anchor, position: movement.afterPosition });
        newLots.set(prepared.group.lots[i]!.id, prepared.group.lots[i]!);
      }
      compiled.push({ kind: "acquisition", entries: operation.entries, inventoryPolicy: operation.inventoryPolicy, quantizationPolicy: quantization,
        dimensionMemberIds: coordinate.dimensionMemberIds, ...(journalLink === undefined ? {} : { journalLink }) });
      artifactOrdinal += BigInt(prepared.group.anchors.length + prepared.group.movements.length);
    } else if (operation.kind === "adopt") {
      const adoptionEntries = [];
      let totalCarrying = ExactRational.zero();
      for (const entry of operation.entries) {
        if (!claim("anchor", entry.anchorId) || !claim("movement", entry.movementId)) {
          return failure("ownedInventory.adoptionIdentity", "Adopted anchor and movement identities must be permanently new");
        }
        const holding = read(() => context.ownership.readCurrentHolding(entry.holdingId));
        if (holding === undefined || holding.bookId !== context.bookId || holding.accountId !== coordinate.accountId ||
          holding.commodityId !== coordinate.unitsCommodityId || holding.basisCommodityId !== context.functionalCommodityId ||
          holding.remainingQuantity.compare(ExactRational.zero()) <= 0 || holding.remainingTotalBasis.isNegative() ||
          !holding.remainingCarryingAmount.equals(holding.remainingTotalBasis.add(holding.remainingValuationAllowance))) {
          return failure("ownedInventory.adoptionSource", "Adopted holdings must exist in the pinned book and have valid quantities and carrying values");
        }
        totalCarrying = totalCarrying.add(holding.remainingCarryingAmount);
        adoptionEntries.push({ anchorId: entry.anchorId, movementId: entry.movementId, holding, evidence: entry.evidence, historicalPostings: entry.historicalPostings });
      }
      const prepared = prepareInventoryPostedAdoptionGroup({
        ...context, firstArtifactOrdinal: artifactOrdinal, inventoryPolicy: operation.inventoryPolicy,
        quantizationPolicy: quantization, dimensionMemberIds: coordinate.dimensionMemberIds,
      }, adoptionEntries, operation.postedBalance);
      if (prepared.disposition === "rejected") return prepared;
      for (const [i, movement] of prepared.group.movements.entries()) {
        const holding = prepared.group.holdings[i]!, anchor = prepared.group.anchors[i]!;
        current.set(holding.id, { holding, anchor, position: movement.afterPosition });
      }
      compiled.push({ kind: "adopt", entries: adoptionEntries, inventoryPolicy: operation.inventoryPolicy,
        quantizationPolicy: quantization, dimensionMemberIds: coordinate.dimensionMemberIds, postedBalance: operation.postedBalance });
      artifactOrdinal += BigInt(prepared.group.anchors.length + prepared.group.movements.length);
    } else if (operation.kind === "transfer") {
      const destCoordinate = operation.destinationCoordinate;
      const destBookingMatches = context.bookingPolicies.filter((p) => p.id === destCoordinate.bookingPolicy.policyId && p.version === destCoordinate.bookingPolicy.policyVersion);
      const destBooking = destBookingMatches[0];
      if (destBookingMatches.length !== 1 || destBooking === undefined ||
        destBooking.scope === "account" && destBooking.scopeKey !== destCoordinate.accountId ||
        destBooking.scope === "legalEntity" && destBooking.scopeKey !== context.ownerId || destBooking.scope === "jurisdictionPool" ||
        !contentHashEquals(hashCanonical(canonicalPolicyValue(destBooking)), destCoordinate.bookingPolicy.policyContentHash)) {
        return failure("ownedInventory.bookingPolicy", "Destination coordinate policy must resolve its exact hash and actual account/entity scope");
      }
      const selectedDestBooking = selectBookingPolicy(context.bookingPolicies, { bookId: context.bookId, governedAt: request.governedAt, scopeKey: destBooking.scopeKey });
      if (selectedDestBooking.disposition === "rejected") return selectedDestBooking;
      if (selectedDestBooking.policy !== destBooking || destCoordinate.dimensionMemberIds.some((id, i, ids) => i > 0 && compareCanonicalText(ids[i - 1]!, id) >= 0)) {
        return failure("ownedInventory.coordinate", "Destination coordinate policy selection or canonical member order is incoherent");
      }
      const destDiagnostics = validateAccountingCoordinate(context.admissionSnapshot, { ...destCoordinate, bookId: context.bookId,
        functionalCommodityId: context.functionalCommodityId, accountingDate: request.accountingDate }, destBooking.requiredDimensionIds);
      if (destDiagnostics.length > 0) return Object.freeze({ disposition: "rejected" as const, diagnostics: destDiagnostics });

      const destMatches = context.accountingPolicies.filter((p): p is InventoryCostPolicy => p.kind === "inventoryCost" && p.id === operation.destinationInventoryPolicy.policyId && p.version === operation.destinationInventoryPolicy.policyVersion);
      const destPolicy = destMatches[0];
      if (destMatches.length !== 1 || destPolicy === undefined || destPolicy.bookId !== context.bookId || destPolicy.algorithmVersion !== "1.0.0" ||
        destPolicy.validFrom > request.governedAt || destPolicy.validTo !== undefined && request.governedAt >= destPolicy.validTo ||
        !contentHashEquals(hashAccountingPolicy(destPolicy), operation.destinationInventoryPolicy.policyContentHash) || !verifyAccountingPolicyArtifacts([destPolicy]) ||
        destPolicy.capability.feature !== "inventoryCost" || destPolicy.capability.status !== "supported" || destPolicy.capability.implementationVersion !== destPolicy.algorithmVersion ||
        destPolicy.capability.verificationEvidenceIds.length === 0 || !accountingCapabilityAdmits(destPolicy.capability, { method: destPolicy.method }) ||
        !destPolicy.pools.some((pool) => pool.accountId === destCoordinate.accountId)) {
        return failure("ownedInventory.policy", "Destination inventory policy, capability, pool, and full hash must agree");
      }
      const destQuantization = destPolicy.quantizationPolicy;
      if (destQuantization.bookId !== context.bookId || destQuantization.functionalCommodityId !== context.functionalCommodityId ||
        destQuantization.validFrom > request.accountingDate || destQuantization.validTo !== undefined && request.accountingDate >= destQuantization.validTo ||
        context.quantizationPolicies.filter((q) => contentHashEquals(hashQuantizationPolicy(q), hashQuantizationPolicy(destQuantization))).length !== 1) {
        return failure("ownedInventory.quantization", "Destination policy requires one applicable complete quantization policy");
      }

      const destScope = { bookId: context.bookId, functionalCommodityId: context.functionalCommodityId, ...destCoordinate };
      ownedScopes.add(scopeKey(destScope));

      const destLink = operation.destinationPostingLink;
      const destBooked = destLink === undefined ? undefined : context.journals[Number(destLink.journalOrdinal)];
      if (destLink !== undefined && (destLink.journalOrdinal < 0n || destLink.journalOrdinal >= BigInt(context.journals.length) || destBooked === undefined || usedPostings.has(destLink.postingId) || !claim("postingReference", destLink.referenceId))) {
        return failure("ownedInventory.postingLink", "Destination group requires a unique actual same-command journal posting and reference identity");
      }
      const destJournalLink = destBooked === undefined || destLink === undefined ? undefined : { source: destBooked, postingId: destLink.postingId, referenceId: destLink.referenceId };
      if (destLink !== undefined) usedPostings.add(destLink.postingId);

      const suppliedPool = read(() => immutableAccountingValue(context.readPool(policy, coordinate.unitsCommodityId)));
      work += suppliedPool.length + newLots.size;
      if (work > cap) return failure("ownedInventory.pool", "Complete working pool exceeds the selection bound");
      const pool = suppliedPool.map((entry) => ({ lot: entry.lot, holding: current.get(entry.holding.id)?.holding ?? entry.holding }));
      for (const source of current.values()) if (newLots.has(source.holding.lotId) && policy.pools.some((p) => p.accountId === source.holding.accountId) && source.holding.commodityId === coordinate.unitsCommodityId) {
        pool.push({ lot: newLots.get(source.holding.lotId)!, holding: source.holding });
      }
      const selected = prepareInventoryOwnershipSelection(context.accountingPolicies, context.bookId, pool, {
        policyId: policy.id, policyVersion: policy.version, governedAt: request.governedAt, quantity: operation.quantity,
        inventoryCommodityId: coordinate.unitsCommodityId, derivation: operation.derivation,
        identities: operation.entries.map((e) => ({ holdingId: e.holdingId, allocationId: e.allocationId, movementId: e.transferOutMovementId })),
        ...(operation.specificHoldingIds === undefined ? {} : { specificLayerIds: operation.specificHoldingIds }),
      });
      if (selected.disposition === "rejected") return selected;
      if (!selected.selection.provisionalQuantity.isZero()) return failure("ownedInventory.shortage", "This ownership command cannot synthesize provisional stock");

      const transferEntries = [];
      const entryByHolding = new Map(operation.entries.map((e) => [e.holdingId, e]));
      for (const allocation of selected.selection.allocations) {
        const id = allocation.allocation.holdingId;
        const entry = entryByHolding.get(id);
        if (entry === undefined) return failure("ownedInventory.transferIdentity", "Every selected allocation requires transfer entry identities");
        if (!claim("allocation", entry.allocationId) || !claim("movement", entry.transferOutMovementId) ||
          !claim("movement", entry.destinationMovementId) || !claim("anchor", entry.destinationAnchorId) ||
          !claim("holding", entry.destinationHoldingId) || !claim("lot", entry.destinationLotId)) {
          return failure("ownedInventory.transferIdentity", "Transfer movement, anchor, holding and lot identities must be permanently new");
        }
        if (!current.has(id)) {
          const resolved = resolveInventoryOwnershipSources(context.ownership, [id]);
          if (resolved.disposition === "rejected") return resolved;
          const source = resolved.sources[0]!;
          const poolHolding = pool.find((item) => item.holding.id === id)!.holding;
          if (!contentHashEquals(hashCanonical(canonicalAccountingValue(source.holding)), hashCanonical(canonicalAccountingValue(poolHolding)))) throw new Error("Authenticated pool and holding disagree");
          work += source.anchor.sourcePostings.length + source.anchor.incomingMovements.length + source.anchor.evidence.length + source.anchor.coordinate.dimensionMemberIds.length;
          if (work > cap) return failure("ownedInventory.sources", "Combined authenticated source population exceeds the accounting work bound");
          originals.set(id, source); current.set(id, source);
        }
        const source = current.get(id)!;
        const lot = pool.find((item) => item.holding.id === id)!.lot;
        if (scopeKey(source.anchor.coordinate) !== scopeKey(scope) || source.holding.commodityId !== coordinate.unitsCommodityId ||
          !contentHashEquals(source.anchor.inventoryPolicy.policyContentHash, operation.inventoryPolicy.policyContentHash) ||
          lot.acquiredAt > request.governedAt ||
          originals.has(id) && read(() => context.latestMovementDate(id)) > context.accountingDate) {
          return failure("ownedInventory.transferSource", "Selected ownership must match policy/coordinate and precede the transfer date");
        }
        const destHolding: LotHolding = {
          id: entry.destinationHoldingId, lotId: entry.destinationLotId, bookId: context.bookId, accountId: destCoordinate.accountId,
          commodityId: destCoordinate.unitsCommodityId, basisCommodityId: context.functionalCommodityId,
          remainingQuantity: allocation.allocation.allocatedQuantity, remainingTotalBasis: allocation.allocation.allocatedTotalBasis,
          remainingValuationAllowance: allocation.allocation.allocatedValuationAllowance, remainingCarryingAmount: allocation.allocation.allocatedCarryingAmount,
        };
        const destLot: Lot = {
          id: entry.destinationLotId, bookId: context.bookId, commodityId: destCoordinate.unitsCommodityId, acquiredAt: request.governedAt,
          acquisitionQuantity: allocation.allocation.allocatedQuantity, acquisitionTotalBasis: allocation.allocation.allocatedTotalBasis,
          basisCommodityId: context.functionalCommodityId, evidenceIds: entry.evidence.map((e) => e.id as Identifier<"SourceEvidence">),
        };
        transferEntries.push({
          source, allocation: allocation.allocation, transferOutMovementId: entry.transferOutMovementId,
          destinationAnchorId: entry.destinationAnchorId, destinationMovementId: entry.destinationMovementId,
          destinationHolding: destHolding, destinationLot: destLot, evidence: entry.evidence,
        });
      }
      const prepared = prepareInventoryPostedTransferGroup({
        ...context, firstArtifactOrdinal: artifactOrdinal, destinationInventoryPolicy: operation.destinationInventoryPolicy,
        destinationQuantizationPolicy: destQuantization, destinationDimensionMemberIds: destCoordinate.dimensionMemberIds,
      }, transferEntries, journalLink, destJournalLink);
      if (prepared.disposition === "rejected") return prepared;
      for (const [i, movement] of prepared.group.transferOutMovements.entries()) {
        const source = current.get(movement.coordinate.holdingId)!;
        current.set(source.holding.id, { anchor: source.anchor, position: movement.afterPosition, holding: prepared.group.afterSourceHoldings[i]! });
      }
      for (const [i, movement] of prepared.group.destinationMovements.entries()) {
        const destHolding = prepared.group.destinationHoldings[i]!, destAnchor = prepared.group.destinationAnchors[i]!;
        current.set(destHolding.id, { anchor: destAnchor, holding: destHolding, position: movement.afterPosition });
        newLots.set(prepared.group.destinationLots[i]!.id, prepared.group.destinationLots[i]!);
      }
      compiled.push({
        kind: "transfer", destinationInventoryPolicy: operation.destinationInventoryPolicy,
        destinationQuantizationPolicy: destQuantization, destinationDimensionMemberIds: destCoordinate.dimensionMemberIds,
        entries: transferEntries,
        ...(journalLink === undefined ? {} : { sourceJournalLink: journalLink }),
        ...(destJournalLink === undefined ? {} : { destinationJournalLink: destJournalLink }),
      });
      artifactOrdinal += BigInt(prepared.group.transferOutMovements.length + prepared.group.destinationAnchors.length + prepared.group.destinationMovements.length);
    } else {
      const suppliedPool = read(() => immutableAccountingValue(context.readPool(policy, coordinate.unitsCommodityId)));
      work += suppliedPool.length + newLots.size;
      if (work > cap) return failure("ownedInventory.pool", "Complete working pool exceeds the selection bound");
      const pool = suppliedPool.map((entry) => ({ lot: entry.lot, holding: current.get(entry.holding.id)?.holding ?? entry.holding }));
      for (const source of current.values()) if (newLots.has(source.holding.lotId) && policy.pools.some((p) => p.accountId === source.holding.accountId) && source.holding.commodityId === coordinate.unitsCommodityId) {
        pool.push({ lot: newLots.get(source.holding.lotId)!, holding: source.holding });
      }
      const selected = prepareInventoryOwnershipSelection(context.accountingPolicies, context.bookId, pool, {
        policyId: policy.id, policyVersion: policy.version, governedAt: request.governedAt, quantity: operation.quantity,
        inventoryCommodityId: coordinate.unitsCommodityId, derivation: operation.derivation, identities: operation.identities,
        ...(operation.specificHoldingIds === undefined ? {} : { specificLayerIds: operation.specificHoldingIds }),
      });
      if (selected.disposition === "rejected") return selected;
      if (!selected.selection.provisionalQuantity.isZero()) return failure("ownedInventory.shortage", "This ownership command cannot synthesize provisional stock");
      const entries = [];
      for (const allocation of selected.selection.allocations) {
        const id = allocation.allocation.holdingId;
        if (!claim("allocation", allocation.allocation.id) || !claim("movement", allocation.movementId)) return failure("ownedInventory.issueIdentity", "Issue allocation and movement identities must be permanently new");
        if (!current.has(id)) {
          const resolved = resolveInventoryOwnershipSources(context.ownership, [id]);
          if (resolved.disposition === "rejected") return resolved;
          const source = resolved.sources[0]!;
          const poolHolding = pool.find((entry) => entry.holding.id === id)!.holding;
          if (!contentHashEquals(hashCanonical(canonicalAccountingValue(source.holding)), hashCanonical(canonicalAccountingValue(poolHolding)))) throw new Error("Authenticated pool and holding disagree");
          work += source.anchor.sourcePostings.length + source.anchor.incomingMovements.length + source.anchor.evidence.length + source.anchor.coordinate.dimensionMemberIds.length;
          if (work > cap) return failure("ownedInventory.sources", "Combined authenticated source population exceeds the accounting work bound");
          originals.set(id, source); current.set(id, source);
        }
        const source = current.get(id)!;
        const lot = pool.find((entry) => entry.holding.id === id)!.lot;
        if (scopeKey(source.anchor.coordinate) !== scopeKey(scope) || source.holding.commodityId !== coordinate.unitsCommodityId ||
          !contentHashEquals(source.anchor.inventoryPolicy.policyContentHash, operation.inventoryPolicy.policyContentHash) ||
          lot.acquiredAt > request.governedAt ||
          originals.has(id) && read(() => context.latestMovementDate(id)) > context.accountingDate) {
          return failure("ownedInventory.issueSource", "Selected ownership must match policy/coordinate and precede the issue date");
        }
        entries.push({ ...source, ...allocation });
      }
      const prepared = prepareInventoryPostedReductionGroup({ ...context, kind: "disposal", firstArtifactOrdinal: artifactOrdinal }, entries, journalLink);
      if (prepared.disposition === "rejected") return prepared;
      for (const [i, movement] of prepared.group.movements.entries()) {
        const source = current.get(movement.coordinate.holdingId)!;
        current.set(source.holding.id, { anchor: source.anchor, position: movement.afterPosition, holding: prepared.group.afterHoldings[i]! });
      }
      compiled.push({ kind: "disposal", allocations: selected.selection.allocations, ...(journalLink === undefined ? {} : { journalLink }) });
      artifactOrdinal += BigInt(prepared.group.movements.length);
    }
  }
  for (const booked of context.journals) for (const posting of booked.journal.postings) {
    const scope = { bookId: context.bookId, accountId: posting.accountId, functionalCommodityId: context.functionalCommodityId, dimensionMemberIds: posting.dimensionMemberIds };
    const status = read(() => context.managedMoneyScope(scope));
    if (status !== "managed" && status !== "unmanaged") throw new Error("Incomplete managed inventory scope evidence");
    if ((status === "managed" || ownedScopes.has(scopeKey(scope))) && !usedPostings.has(posting.id)) {
      return failure("ownedInventory.unattributedPosting", "Every posting in a managed money scope requires complete ownership attribution across all units commodities");
    }
  }
  const result = prepareInventoryOwnershipEffect(context, [...originals.values()], compiled);
  read(() => undefined);
  return result;
}

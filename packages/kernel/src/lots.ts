import { compareCanonicalText, identifier, type Identifier } from "./canonical.ts";
import {
  diagnostic,
  type AccountId,
  type BookId,
  type CommodityId,
  type Instant,
  type SemanticDiagnostic,
} from "./journal.ts";
import { ExactRational } from "./numeric.ts";
import type { DerivationRecord, PolicyId, SemanticVersion } from "./policy.ts";

export type LotId = Identifier<"Lot">;
export type LotHoldingId = Identifier<"LotHolding">;
export type LotAllocationId = Identifier<"LotAllocation">;

export const lotId = (value: string): LotId => identifier<"Lot">(value);
export const lotHoldingId = (value: string): LotHoldingId => identifier<"LotHolding">(value);
export const lotAllocationId = (value: string): LotAllocationId =>
  identifier<"LotAllocation">(value);

export interface Lot {
  readonly id: LotId;
  readonly bookId: BookId;
  readonly commodityId: CommodityId;
  readonly acquiredAt: Instant;
  readonly acquisitionQuantity: ExactRational;
  readonly acquisitionTotalBasis: ExactRational;
  readonly basisCommodityId: CommodityId;
  readonly evidenceIds: readonly string[];
}

export interface LotHolding {
  readonly id: LotHoldingId;
  readonly bookId: BookId;
  readonly lotId: LotId;
  readonly accountId: AccountId;
  readonly commodityId: CommodityId;
  readonly basisCommodityId: CommodityId;
  readonly remainingQuantity: ExactRational;
  readonly remainingTotalBasis: ExactRational;
  readonly remainingValuationAllowance: ExactRational;
  readonly remainingCarryingAmount: ExactRational;
}

export interface LotAllocation {
  readonly id: LotAllocationId;
  readonly holdingId: LotHoldingId;
  readonly lotId: LotId;
  readonly allocatedQuantity: ExactRational;
  readonly allocatedTotalBasis: ExactRational;
  readonly allocatedValuationAllowance: ExactRational;
  readonly allocatedCarryingAmount: ExactRational;
  readonly derivation: DerivationRecord;
}

export type LotSelection =
  | {
      readonly method: "specificIdentification";
      readonly allocations: readonly {
        readonly holdingId: LotHoldingId;
        readonly quantity: ExactRational;
      }[];
    }
  | { readonly method: "fifo" | "lifo" | "hifo" | "weightedAverage" };

export type LotAllocationResult =
  | {
      readonly disposition: "allocated";
      readonly allocations: readonly LotAllocation[];
      readonly holdings: readonly LotHolding[];
    }
  | { readonly disposition: "rejected"; readonly diagnostics: readonly SemanticDiagnostic[] };

export interface LotAllocationIdentity {
  readonly holdingId: LotHoldingId;
  readonly allocationId: LotAllocationId;
}

function reject(message: string, path = "lots"): LotAllocationResult {
  return Object.freeze({
    disposition: "rejected",
    diagnostics: Object.freeze([
      diagnostic("lot_overallocation", path, message, ["ACC-008", "ACC-009", "ACC-023"]),
    ]),
  });
}

function compareText(left: string, right: string): number {
  return compareCanonicalText(left, right);
}

function validateHoldings(holdings: readonly LotHolding[]): SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
  const ids = new Set<string>();
  for (const [index, holding] of holdings.entries()) {
    if (holding.remainingQuantity === undefined || holding.remainingTotalBasis === undefined || holding.remainingValuationAllowance === undefined || holding.remainingCarryingAmount === undefined) {
      diagnostics.push(diagnostic("lot_overallocation", `holdings[${index}]`, "A lot holding must retain quantity, historical basis, valuation allowance, and carrying amount", ["ACC-009", "ACC-039", "ACC-038"]));
      continue;
    }
    if (ids.has(holding.id)) {
      diagnostics.push(
        diagnostic(
          "canonical_identity_conflict",
          `holdings[${index}].id`,
          `Holding identifier ${holding.id} is duplicated`,
          ["ACC-008", "ACC-038"],
        ),
      );
    }
    ids.add(holding.id);
    if (holding.remainingQuantity.isNegative() || holding.remainingTotalBasis.isNegative()) {
      diagnostics.push(
        diagnostic(
          "lot_overallocation",
          `holdings[${index}]`,
          "An ordinary lot holding cannot have negative quantity or basis",
          ["ACC-009", "ACC-023"],
        ),
      );
    }
    if (!holding.remainingCarryingAmount.equals(holding.remainingTotalBasis.add(holding.remainingValuationAllowance))) {
      diagnostics.push(
        diagnostic(
          "lot_overallocation",
          `holdings[${index}].remainingCarryingAmount`,
          "A holding's carrying amount must equal historical basis plus its separately retained valuation allowance",
          ["ACC-009", "ACC-039", "ACC-038"],
        ),
      );
    }
    if (
      holding.remainingQuantity.isZero() !== holding.remainingTotalBasis.isZero() ||
      holding.remainingQuantity.isZero() && (!holding.remainingValuationAllowance.isZero() || !holding.remainingCarryingAmount.isZero())
    ) {
      diagnostics.push(
        diagnostic(
          "lot_overallocation",
          `holdings[${index}]`,
          "A depleted holding must have both zero quantity and zero total basis",
          ["ACC-009", "ACC-023"],
        ),
      );
    }
  }
  return diagnostics;
}

export function allocateLots(
  holdings: readonly LotHolding[],
  lots: readonly Lot[],
  requestedQuantity: ExactRational,
  selection: LotSelection,
  derivation: DerivationRecord,
  identities: readonly LotAllocationIdentity[],
): LotAllocationResult {
  const initialDiagnostics = validateHoldings(holdings);
  if (initialDiagnostics.length > 0) {
    return Object.freeze({ disposition: "rejected", diagnostics: Object.freeze(initialDiagnostics) });
  }
  if (requestedQuantity.isZero() || requestedQuantity.isNegative()) {
    return reject("Allocated quantity must be positive", "requestedQuantity");
  }

  const lotById = new Map(lots.map((lot) => [lot.id, lot] as const));
  if (lotById.size !== lots.length) {
    return Object.freeze({
      disposition: "rejected",
      diagnostics: Object.freeze([
        diagnostic("canonical_identity_conflict", "lots", "Lot identifier is duplicated in the supplied canonical scope", ["ACC-008", "ACC-038"]),
      ]),
    });
  }
  let candidates: LotHolding[];
  let specificQuantities: ReadonlyMap<string, ExactRational> | undefined;
  if (selection.method === "specificIdentification") {
    const requested = new Set(selection.allocations.map((item) => item.holdingId));
    if (requested.size !== selection.allocations.length) {
      return reject("Specific identification contains a duplicate holding ID", "selection.allocations");
    }
    if (selection.allocations.some((item) => item.quantity.isZero() || item.quantity.isNegative())) {
      return reject("Every specifically identified quantity must be positive", "selection.allocations");
    }
    const declaredTotal = selection.allocations.reduce(
      (total, item) => total.add(item.quantity),
      ExactRational.zero(),
    );
    if (!declaredTotal.equals(requestedQuantity)) {
      return reject("Specific allocation quantities must exactly equal the requested quantity", "selection.allocations");
    }
    specificQuantities = new Map(selection.allocations.map((item) => [item.holdingId, item.quantity] as const));
    candidates = [...selection.allocations]
      .sort((left, right) => compareText(left.holdingId, right.holdingId))
      .map((item) => holdings.find((holding) => holding.id === item.holdingId)).filter(
      (holding): holding is LotHolding => holding !== undefined,
    );
    if (candidates.length !== selection.allocations.length) {
      return reject("Specific identification must resolve every stable holding ID", "selection.allocations");
    }
  } else {
    candidates = holdings.filter((holding) => !holding.remainingQuantity.isZero());
    candidates.sort((left, right) => {
      const leftLot = lotById.get(left.lotId);
      const rightLot = lotById.get(right.lotId);
      if (leftLot === undefined || rightLot === undefined) return compareText(left.lotId, right.lotId);
      if (selection.method === "hifo") {
        const leftUnit = left.remainingTotalBasis.divide(left.remainingQuantity);
        const rightUnit = right.remainingTotalBasis.divide(right.remainingQuantity);
        const comparison = rightUnit.compare(leftUnit);
        return comparison === 0 ? compareText(left.lotId, right.lotId) : comparison;
      }
      if (selection.method === "weightedAverage") return compareText(left.id, right.id);
      const comparison = compareText(leftLot.acquiredAt, rightLot.acquiredAt);
      const ordered = comparison === 0 ? compareText(left.lotId, right.lotId) : comparison;
      return selection.method === "lifo" ? -ordered : ordered;
    });
  }

  if (candidates.some((holding) => {
    const lot = lotById.get(holding.lotId);
    return lot === undefined ||
      lot.bookId !== holding.bookId ||
      lot.commodityId !== holding.commodityId ||
      lot.basisCommodityId !== holding.basisCommodityId ||
      lot.acquisitionQuantity.isZero() ||
      lot.acquisitionQuantity.isNegative() ||
      lot.acquisitionTotalBasis.isNegative() ||
      lot.evidenceIds.length === 0;
  })) {
    return reject("Every holding must resolve one stable lot identity", "holdings");
  }
  const first = candidates[0];
  if (
    first !== undefined &&
    candidates.some(
      (holding) =>
        holding.bookId !== first.bookId ||
        holding.commodityId !== first.commodityId ||
        holding.basisCommodityId !== first.basisCommodityId,
    )
  ) {
    return reject("A lot allocation cannot combine books or commodities", "holdings");
  }

  let remaining = requestedQuantity;
  const weightedAvailable = selection.method === "weightedAverage"
    ? candidates.reduce((total, holding) => total.add(holding.remainingQuantity), ExactRational.zero())
    : undefined;
  const replacements = new Map<string, LotHolding>();
  const allocations: LotAllocation[] = [];
  for (const holding of candidates) {
    if (remaining.isZero()) break;
    if (holding.remainingQuantity.isZero()) continue;
    const specificallyAllocated = specificQuantities?.get(holding.id);
    const allocated = specificallyAllocated ?? (selection.method === "weightedAverage" && weightedAvailable !== undefined
      ? holding.remainingQuantity.multiply(requestedQuantity).divide(weightedAvailable)
      : holding.remainingQuantity.compare(remaining) <= 0 ? holding.remainingQuantity : remaining);
    if (allocated.compare(holding.remainingQuantity) > 0 || allocated.compare(remaining) > 0) {
      return reject("A specifically identified allocation exceeds its holding", "selection.allocations");
    }
    const basis = allocated.equals(holding.remainingQuantity)
      ? holding.remainingTotalBasis
      : holding.remainingTotalBasis.multiply(allocated).divide(holding.remainingQuantity);
    const valuationAllowance = allocated.equals(holding.remainingQuantity)
      ? holding.remainingValuationAllowance
      : holding.remainingValuationAllowance.multiply(allocated).divide(holding.remainingQuantity);
    const carryingAmount = basis.add(valuationAllowance);
    const nextQuantity = holding.remainingQuantity.subtract(allocated);
    const nextBasis = holding.remainingTotalBasis.subtract(basis);
    const nextValuationAllowance = holding.remainingValuationAllowance.subtract(valuationAllowance);
    replacements.set(
      holding.id,
      Object.freeze({
        ...holding,
        remainingQuantity: nextQuantity,
        remainingTotalBasis: nextBasis,
        remainingValuationAllowance: nextValuationAllowance,
        remainingCarryingAmount: nextBasis.add(nextValuationAllowance),
      }),
    );
    const allocationId = identities.find((identity) => identity.holdingId === holding.id)?.allocationId;
    if (allocationId === undefined) {
      return reject("Every allocated holding requires one explicitly supplied stable allocation identity", "identities");
    }
    if (allocations.some((item) => item.id === allocationId)) {
      return Object.freeze({
        disposition: "rejected",
        diagnostics: Object.freeze([
          diagnostic("canonical_identity_conflict", "allocations", `Allocation identifier ${allocationId} is duplicated`, ["ACC-008", "ACC-038"]),
        ]),
      });
    }
    allocations.push(
      Object.freeze({
        id: allocationId,
        holdingId: holding.id,
        lotId: holding.lotId,
        allocatedQuantity: allocated,
        allocatedTotalBasis: basis,
        allocatedValuationAllowance: valuationAllowance,
        allocatedCarryingAmount: carryingAmount,
        derivation,
      }),
    );
    remaining = remaining.subtract(allocated);
  }
  if (!remaining.isZero()) return reject("Requested quantity exceeds selected holdings");

  return Object.freeze({
    disposition: "allocated",
    allocations: Object.freeze(allocations),
    holdings: Object.freeze(holdings.map((holding) => replacements.get(holding.id) ?? holding)),
  });
}

export interface TransferPolicy {
  readonly id: PolicyId;
  readonly version: SemanticVersion;
  readonly bookId: BookId;
  readonly sourceAccountId: AccountId;
  readonly destinationAccountId: AccountId;
  readonly validFrom: Instant;
  readonly validTo?: Instant;
  readonly treatment: "continuity" | "disposalAndReacquisition";
}

export interface DestinationHoldingIdentity {
  readonly sourceHoldingId: LotHoldingId;
  readonly destinationHoldingId: LotHoldingId;
}

export type LotTransferResult =
  | {
      readonly disposition: "transferred";
      readonly sourceHoldings: readonly LotHolding[];
      readonly destinationHoldings: readonly LotHolding[];
      readonly allocations: readonly LotAllocation[];
    }
  | { readonly disposition: "requiresDisposalAndReacquisition"; readonly policy: TransferPolicy }
  | { readonly disposition: "rejected"; readonly diagnostics: readonly SemanticDiagnostic[] };

export function transferLots(
  sourceHoldings: readonly LotHolding[],
  destinationHoldings: readonly LotHolding[],
  lots: readonly Lot[],
  requestedQuantity: ExactRational,
  selection: LotSelection,
  policies: readonly TransferPolicy[],
  governedAt: Instant,
  destinationAccountId: AccountId,
  derivation: DerivationRecord,
  allocationIdentities: readonly LotAllocationIdentity[],
  destinationIdentities: readonly DestinationHoldingIdentity[],
): LotTransferResult {
  const source = sourceHoldings[0];
  if (source === undefined) {
    return Object.freeze({
      disposition: "rejected",
      diagnostics: Object.freeze([
        diagnostic("lot_overallocation", "sourceHoldings", "No source holding supplied", ["ACC-008", "ACC-009", "ACC-023"]),
      ]),
    });
  }
  if (sourceHoldings.some((holding) => holding.bookId !== source.bookId || holding.accountId !== source.accountId)) {
    return Object.freeze({
      disposition: "rejected",
      diagnostics: Object.freeze([
        diagnostic("book_isolation_violation", "sourceHoldings", "A transfer source must contain one book and account", ["ACC-009", "ACC-010", "ACC-026"]),
      ]),
    });
  }
  const at = Date.parse(governedAt);
  const applicable = policies.filter(
    (policy) =>
      policy.bookId === source.bookId &&
      policy.sourceAccountId === source.accountId &&
      policy.destinationAccountId === destinationAccountId &&
      Date.parse(policy.validFrom) <= at &&
      (policy.validTo === undefined || at < Date.parse(policy.validTo)),
  );
  if (applicable.length !== 1) {
    return Object.freeze({
      disposition: "rejected",
      diagnostics: Object.freeze([
        diagnostic(
          "transfer_policy_missing",
          "policies",
          `Expected exactly one applicable transfer policy; found ${applicable.length}`,
          ["ACC-007", "ACC-010", "ACC-011"],
        ),
      ]),
    });
  }
  const policy = applicable[0]!;
  if (policy.treatment === "disposalAndReacquisition") {
    return Object.freeze({ disposition: "requiresDisposalAndReacquisition", policy });
  }
  if (source.accountId === destinationAccountId) {
    return Object.freeze({ disposition: "rejected", diagnostics: Object.freeze([
      diagnostic("lot_overallocation", "destinationAccountId", "A continuity transfer requires distinct source and destination accounts", ["ACC-009", "ACC-010", "ACC-023"]),
    ]) });
  }

  const allocation = allocateLots(
    sourceHoldings,
    lots,
    requestedQuantity,
    selection,
    derivation,
    allocationIdentities,
  );
  if (allocation.disposition === "rejected") return allocation;

  const destination = [...destinationHoldings];
  if (destination.some((holding) =>
    holding.bookId !== source.bookId ||
    holding.accountId !== destinationAccountId ||
    holding.commodityId !== source.commodityId ||
    holding.basisCommodityId !== source.basisCommodityId
  )) {
    return Object.freeze({
      disposition: "rejected",
      diagnostics: Object.freeze([
        diagnostic("book_isolation_violation", "destinationHoldings", "Destination holdings must use the transfer book, account, commodity, and basis commodity", ["ACC-009", "ACC-010", "ACC-026"]),
      ]),
    });
  }
  if (new Set(destination.map((holding) => holding.id)).size !== destination.length || destination.some((holding) => sourceHoldings.some((item) => item.id === holding.id))) {
    return Object.freeze({
      disposition: "rejected",
      diagnostics: Object.freeze([
        diagnostic("canonical_identity_conflict", "destinationHoldings", "Destination holding identity is duplicated", ["ACC-008", "ACC-038"]),
      ]),
    });
  }
  for (const applied of allocation.allocations) {
    const sourceHolding = sourceHoldings.find((holding) => holding.id === applied.holdingId)!;
    const existingIndex = destination.findIndex(
      (holding) => holding.lotId === sourceHolding.lotId && holding.accountId === destinationAccountId,
    );
    if (existingIndex >= 0) {
      const existing = destination[existingIndex]!;
      destination[existingIndex] = Object.freeze({
        ...existing,
        remainingQuantity: existing.remainingQuantity.add(applied.allocatedQuantity),
        remainingTotalBasis: existing.remainingTotalBasis.add(applied.allocatedTotalBasis),
        remainingValuationAllowance: existing.remainingValuationAllowance.add(applied.allocatedValuationAllowance),
        remainingCarryingAmount: existing.remainingCarryingAmount.add(applied.allocatedCarryingAmount),
      });
    } else {
      const newHoldingId = destinationIdentities.find(
        (identity) => identity.sourceHoldingId === sourceHolding.id,
      )?.destinationHoldingId;
      if (newHoldingId === undefined) {
        return Object.freeze({
          disposition: "rejected",
          diagnostics: Object.freeze([
            diagnostic("canonical_identity_conflict", "destinationIdentities", "Every new destination holding requires one explicitly supplied stable identity", ["ACC-006", "ACC-008", "ACC-038"]),
          ]),
        });
      }
      if (destination.some((holding) => holding.id === newHoldingId) || sourceHoldings.some((holding) => holding.id === newHoldingId)) {
        return Object.freeze({
          disposition: "rejected",
          diagnostics: Object.freeze([
            diagnostic("canonical_identity_conflict", "destinationHoldings", `Destination holding identifier ${newHoldingId} is already assigned`, ["ACC-008", "ACC-038"]),
          ]),
        });
      }
      destination.push(
        Object.freeze({
          id: newHoldingId,
          bookId: sourceHolding.bookId,
          lotId: sourceHolding.lotId,
          accountId: destinationAccountId,
          commodityId: sourceHolding.commodityId,
          basisCommodityId: sourceHolding.basisCommodityId,
          remainingQuantity: applied.allocatedQuantity,
          remainingTotalBasis: applied.allocatedTotalBasis,
          remainingValuationAllowance: applied.allocatedValuationAllowance,
          remainingCarryingAmount: applied.allocatedCarryingAmount,
        }),
      );
    }
  }
  return Object.freeze({
    disposition: "transferred",
    sourceHoldings: allocation.holdings,
    destinationHoldings: Object.freeze(destination),
    allocations: allocation.allocations,
  });
}

import { expect, test } from "bun:test";
import {
  ACCOUNTING_LIMITS, ExactRational as R, identifier, lotId, lotHoldingId, lotAllocationId, commandId, effectKey, localDate, instant,
  hashCanonical, hashInventoryPostedAnchor, hashInventoryPostedPosition, hashInventoryPostedAcquisitionMovement,
  hashInventoryPostedReductionMovement, hashInventoryOwnershipEffect, validateInventoryOwnershipArtifact,
  prepareInventoryPostedAcquisitionGroup, prepareInventoryPostedReductionGroup,
  type InventoryPostedAcquisitionEntry, type InventoryPostedAnchor, type InventoryPostedAcquisitionMovement,
  type QuantityOnlyInventoryReductionMovement,
} from "../src/index.ts";
import { IDS, quantizationPolicy } from "./fixtures.ts";
import { accountingDerivation } from "./accounting-fixtures.ts";

type QuantityOnlyInventoryAcquisitionMovement = Extract<InventoryPostedAcquisitionMovement, { readonly monetaryKind: "quantityOnly" }>;

// The source-free integrity API has per-artifact cardinality bounds. This is
// deliberately not a claim that a 10,000-anchor command fits the stricter
// command work or transport byte limits. Keep this costlier boundary check out
// of the mutation fast companions; the complete fallback suite still runs it.
test("ownership integrity accepts exactly the artifact count cap for creation and reduction", () => {
  const cap = ACCOUNTING_LIMITS.maxInventoryLayers;
  const context = { bookId: IDS.book, commandId: commandId("bounded"), effectKey: effectKey("bounded:ownership:0"), bookRevision: 1n,
    firstArtifactOrdinal: 1n, accountingDate: localDate("2026-01-15"), fiscalPeriodId: IDS.period1,
    inventoryPolicy: { policyId: accountingDerivation.policyId, policyVersion: accountingDerivation.policyVersion, policyContentHash: hashCanonical({ policy: "bounded" }) },
    quantizationPolicy, dimensionMemberIds: [] };
  const lot = { id: lotId("base"), bookId: IDS.book, commodityId: IDS.usd, basisCommodityId: IDS.usd, acquiredAt: instant("2026-01-15T12:00:00Z"),
    acquisitionQuantity: R.of(1n, 1n), acquisitionTotalBasis: R.zero(), evidenceIds: accountingDerivation.evidence.map((e) => e.id) };
  const holding = { id: lotHoldingId("base"), lotId: lot.id, bookId: IDS.book, accountId: IDS.cash, commodityId: IDS.usd, basisCommodityId: IDS.usd,
    remainingQuantity: R.of(1n, 1n), remainingTotalBasis: R.zero(), remainingValuationAllowance: R.zero(), remainingCarryingAmount: R.zero() };
  const entry: InventoryPostedAcquisitionEntry = { anchorId: identifier<"InventoryPostedAnchor">("base"), movementId: identifier<"InventoryPostedMovement">("base"),
    lot, holding, evidence: accountingDerivation.evidence };
  const prepared = prepareInventoryPostedAcquisitionGroup(context, [entry]);
  if (prepared.disposition !== "prepared") throw new Error("Free acquisition fixture rejected");
  const baseAnchor = prepared.group.anchors[0]!, baseMovement = prepared.group.movements[0]!;
  if (baseMovement.monetaryKind !== "quantityOnly") throw new Error("Free stock created money");
  const newAnchors: InventoryPostedAnchor[] = [], quantityOnlyMovements: QuantityOnlyInventoryAcquisitionMovement[] = [];
  for (let i = 0; i < cap; i++) {
    const id = `bounded-${i}`, ordinal = BigInt(i + 1), movementOrdinal = BigInt(cap + i + 1);
    const body = { ...baseAnchor, id: identifier<"InventoryPostedAnchor">(id), artifactOrdinal: ordinal,
      coordinate: { ...baseAnchor.coordinate, holdingId: lotHoldingId(id), lotId: lotId(id) } };
    const anchor = { ...body, contentHash: hashInventoryPostedAnchor(body) };
    const positionBody = { ...baseMovement.afterPosition, holdingId: anchor.coordinate.holdingId,
      anchor: { ...baseMovement.afterPosition.anchor, id: anchor.id, contentHash: anchor.contentHash, artifactOrdinal: ordinal },
      originMovementId: identifier<"InventoryPostedMovement">(id), originArtifactOrdinal: movementOrdinal };
    const afterPosition = { ...positionBody, contentHash: hashInventoryPostedPosition(positionBody) };
    const movementBody = { ...baseMovement, id: afterPosition.originMovementId, coordinate: anchor.coordinate, artifactOrdinal: movementOrdinal, afterPosition };
    newAnchors.push(anchor);
    quantityOnlyMovements.push({ ...movementBody, contentHash: hashInventoryPostedAcquisitionMovement(movementBody) });
  }
  const body = { effectKey: context.effectKey, bookRevision: 1n, newAnchors, journalLinkedMovements: [], quantityOnlyMovements };
  const creation = { ...body, contentHash: hashInventoryOwnershipEffect(body) };
  expect(newAnchors).toHaveLength(cap);
  expect(quantityOnlyMovements).toHaveLength(cap);
  expect(validateInventoryOwnershipArtifact("ownershipEffect", creation)).toBe(true);

  const reductionContext = { ...context, effectKey: effectKey("bounded-reduction:ownership:0"), bookRevision: 2n, kind: "disposal" as const };
  const allocation = { id: lotAllocationId("base"), holdingId: holding.id, lotId: lot.id, allocatedQuantity: R.of(1n, 1n),
    allocatedTotalBasis: R.zero(), allocatedValuationAllowance: R.zero(), allocatedCarryingAmount: R.zero(), derivation: accountingDerivation };
  const reduction = prepareInventoryPostedReductionGroup(reductionContext, [{ anchor: baseAnchor, position: baseMovement.afterPosition, holding, allocation,
    movementId: identifier<"InventoryPostedMovement">("base-reduction") }]);
  if (reduction.disposition !== "prepared") throw new Error("Free reduction fixture rejected");
  const template = reduction.group.movements[0]!;
  if (template.monetaryKind !== "quantityOnly") throw new Error("Free stock created a posting");
  const reductions: QuantityOnlyInventoryReductionMovement[] = [];
  for (let i = 0; i < cap; i++) {
    const anchor = newAnchors[i]!, before = quantityOnlyMovements[i]!.afterPosition, ordinal = BigInt(i + 1);
    const id = identifier<"InventoryPostedMovement">(`reduction-${i}`);
    const positionBody = { ...template.afterPosition, holdingId: before.holdingId, anchor: before.anchor, originMovementId: id, originArtifactOrdinal: ordinal };
    const afterPosition = { ...positionBody, contentHash: hashInventoryPostedPosition(positionBody) };
    const movementBody = { ...template, id, artifactOrdinal: ordinal, coordinate: anchor.coordinate, afterPosition,
      quantityAllocation: { ...allocation, id: lotAllocationId(`reduction-${i}`), holdingId: before.holdingId, lotId: anchor.coordinate.lotId },
      beforePosition: { id: before.holdingId, contentHash: before.contentHash, bookId: IDS.book, effectKey: before.originEffectKey,
        artifactOrdinal: before.originArtifactOrdinal, bookRevision: before.originBookRevision } };
    reductions.push({ ...movementBody, contentHash: hashInventoryPostedReductionMovement(movementBody) });
  }
  const reducedBody = { effectKey: reductionContext.effectKey, bookRevision: 2n, newAnchors: [] as const, journalLinkedMovements: [], quantityOnlyMovements: reductions };
  const reduced = { ...reducedBody, contentHash: hashInventoryOwnershipEffect(reducedBody) };
  expect(reductions).toHaveLength(cap);
  expect(validateInventoryOwnershipArtifact("reductionEffect", reduced)).toBe(true);
  expect(validateInventoryOwnershipArtifact("ownershipEffect", reduced)).toBe(true);
}, 60_000);

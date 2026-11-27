/-
`canonicalize` (`packages/kernel/src/accounting.ts` line 688) of the artifacts of inventory
ownership (`inventory-ownership.ts`): what `canonicalAccountingValue` writes for an anchor, a
position, a reference, a coordinate, a movement, and the values they hold (`Lot`, `LotHolding`,
`LotAllocation`, `CumulativePostedShare`, `InventoryPostedValueBudget`).

`Accounting/Core/Canonical.lean` models `canonicalize` for the types of `Accounting/Types.lean`; it
is read here as it stands and is not edited, and this file follows its conventions to the letter
(see the header of that file): an `interface` is the record of its fields, an optional field that is
absent is left out, a union of string literals is its literal (`text`), a `bigint` is the integer,
an array is the array of its members. A movement is one case of a union discriminated by
`monetaryKind`: its record carries the literal `monetaryKind`, and a journal-linked one its
`posting`; a quantity-only one has no `posting` property at all.

The order of a record's entries is the order of the interface; no reader can tell, because the
encoder sorts the keys (`canonicalEncode_record_perm`). What `Types.lean` says the Lean types cannot
say applies here too: an optional property present with the value `undefined` is written exactly as
an absent one, and a property a JavaScript object carries beyond its type is not here.
-/
import Rastrata.Kernel.InventoryOwnership.Types
import Rastrata.Kernel.Accounting.Core.Canonical
import Rastrata.Kernel.Accounting.Core.Model

namespace Rastrata.Kernel

/-! ## String literals -/

instance : Canonicalize InventoryPostedAnchorAlgorithm := ⟨fun v => .string v.text⟩
instance : Canonicalize InventoryPostedMonetaryKind := ⟨fun v => .string v.text⟩
instance : Canonicalize InventoryPostedReductionKind := ⟨fun v => .string v.text⟩
instance : Canonicalize InventoryPostedAcquisitionKind := ⟨fun v => .string v.text⟩

/-! ## Lots, holdings, allocations, shares and posted values -/

/-- `Lot`. -/
def Lot.canonicalMembers (lot : Lot) : List Member :=
  [member "id" lot.id, member "bookId" lot.bookId, member "commodityId" lot.commodityId,
    member "acquiredAt" lot.acquiredAt, member "acquisitionQuantity" lot.acquisitionQuantity,
    member "acquisitionTotalBasis" lot.acquisitionTotalBasis,
    member "basisCommodityId" lot.basisCommodityId, member "evidenceIds" lot.evidenceIds]

instance : CanonicalObject Lot := ⟨Lot.canonicalMembers⟩

/-- `LotHolding`. -/
def LotHolding.canonicalMembers (holding : LotHolding) : List Member :=
  [member "id" holding.id, member "bookId" holding.bookId, member "lotId" holding.lotId,
    member "accountId" holding.accountId, member "commodityId" holding.commodityId,
    member "basisCommodityId" holding.basisCommodityId,
    member "remainingQuantity" holding.remainingQuantity,
    member "remainingTotalBasis" holding.remainingTotalBasis,
    member "remainingValuationAllowance" holding.remainingValuationAllowance,
    member "remainingCarryingAmount" holding.remainingCarryingAmount]

instance : CanonicalObject LotHolding := ⟨LotHolding.canonicalMembers⟩

/-- `LotAllocation`. -/
def LotAllocation.canonicalMembers (allocation : LotAllocation) : List Member :=
  [member "id" allocation.id, member "holdingId" allocation.holdingId,
    member "lotId" allocation.lotId, member "allocatedQuantity" allocation.allocatedQuantity,
    member "allocatedTotalBasis" allocation.allocatedTotalBasis,
    member "allocatedValuationAllowance" allocation.allocatedValuationAllowance,
    member "allocatedCarryingAmount" allocation.allocatedCarryingAmount,
    member "derivation" allocation.derivation]

instance : CanonicalObject LotAllocation := ⟨LotAllocation.canonicalMembers⟩

/-- `CumulativePostedShare` (with its full policy). -/
def PolicyCumulativePostedShare.canonicalMembers (share : PolicyCumulativePostedShare) :
    List Member :=
  [member "postedTotal" share.postedTotal, member "beforeFraction" share.beforeFraction,
    member "afterFraction" share.afterFraction, member "beforeTarget" share.beforeTarget,
    member "afterTarget" share.afterTarget, member "beforeQuantization" share.beforeQuantization,
    member "afterQuantization" share.afterQuantization, member "postedAmount" share.postedAmount,
    member "policy" share.policy]

instance : CanonicalObject PolicyCumulativePostedShare :=
  ⟨PolicyCumulativePostedShare.canonicalMembers⟩

/-- `InventoryPostedValueBudget`. -/
def InventoryPostedValueBudget.canonicalMembers (budget : InventoryPostedValueBudget) :
    List Member :=
  [member "basis" budget.basis, member "allowance" budget.allowance]

instance : CanonicalObject InventoryPostedValueBudget :=
  ⟨InventoryPostedValueBudget.canonicalMembers⟩

/-! ## Coordinates, references and policies -/

/-- `InventoryPostedCoordinate`. -/
def InventoryPostedCoordinate.canonicalMembers (coordinate : InventoryPostedCoordinate) :
    List Member :=
  [member "bookId" coordinate.bookId, member "holdingId" coordinate.holdingId,
    member "lotId" coordinate.lotId, member "accountId" coordinate.accountId,
    member "unitsCommodityId" coordinate.unitsCommodityId,
    member "functionalCommodityId" coordinate.functionalCommodityId,
    member "dimensionMemberIds" coordinate.dimensionMemberIds]

instance : CanonicalObject InventoryPostedCoordinate :=
  ⟨InventoryPostedCoordinate.canonicalMembers⟩

/-- `InventoryPostedArtifactReference`. -/
def InventoryPostedArtifactReference.canonicalMembers
    (reference : InventoryPostedArtifactReference) : List Member :=
  [member "id" reference.id, member "contentHash" reference.contentHash,
    member "bookId" reference.bookId, member "effectKey" reference.effectKey,
    member "artifactOrdinal" reference.artifactOrdinal,
    member "bookRevision" reference.bookRevision]

instance : CanonicalObject InventoryPostedArtifactReference :=
  ⟨InventoryPostedArtifactReference.canonicalMembers⟩

/-- `InventoryPostedAnchorReference`. -/
def InventoryPostedAnchorReference.canonicalMembers (reference : InventoryPostedAnchorReference) :
    List Member :=
  [member "id" reference.id, member "contentHash" reference.contentHash,
    member "bookId" reference.bookId, member "effectKey" reference.effectKey,
    member "artifactOrdinal" reference.artifactOrdinal,
    member "bookRevision" reference.bookRevision]

instance : CanonicalObject InventoryPostedAnchorReference :=
  ⟨InventoryPostedAnchorReference.canonicalMembers⟩

/-- `InventoryPostedPositionReference`. -/
def InventoryPostedPositionReference.canonicalMembers
    (reference : InventoryPostedPositionReference) : List Member :=
  [member "id" reference.id, member "contentHash" reference.contentHash,
    member "bookId" reference.bookId, member "effectKey" reference.effectKey,
    member "artifactOrdinal" reference.artifactOrdinal,
    member "bookRevision" reference.bookRevision]

instance : CanonicalObject InventoryPostedPositionReference :=
  ⟨InventoryPostedPositionReference.canonicalMembers⟩

/-- `InventoryPostedMovementReference`. -/
def InventoryPostedMovementReference.canonicalMembers
    (reference : InventoryPostedMovementReference) : List Member :=
  [member "id" reference.id, member "contentHash" reference.contentHash,
    member "bookId" reference.bookId, member "effectKey" reference.effectKey,
    member "artifactOrdinal" reference.artifactOrdinal,
    member "bookRevision" reference.bookRevision]

instance : CanonicalObject InventoryPostedMovementReference :=
  ⟨InventoryPostedMovementReference.canonicalMembers⟩

/-- `InventoryPostedAnchor["inventoryPolicy"]`. -/
def InventoryPostedAnchorPolicy.canonicalMembers (policy : InventoryPostedAnchorPolicy) :
    List Member :=
  [member "policyId" policy.policyId, member "policyVersion" policy.policyVersion,
    member "policyContentHash" policy.policyContentHash]

instance : CanonicalObject InventoryPostedAnchorPolicy :=
  ⟨InventoryPostedAnchorPolicy.canonicalMembers⟩

/-! ## Anchors and positions -/

/-- `Omit<InventoryPostedAnchor, "contentHash">`: `postedValue` and `predecessorPosition` left out
when absent. -/
def InventoryPostedAnchorBody.canonicalMembers (anchor : InventoryPostedAnchorBody) :
    List Member :=
  [member "id" anchor.id, member "algorithm" anchor.algorithm,
    member "algorithmVersion" anchor.algorithmVersion, member "quantity" anchor.quantity,
    member "postedBudget" anchor.postedBudget, optMember "postedValue" anchor.postedValue,
    member "effectKey" anchor.effectKey, member "artifactOrdinal" anchor.artifactOrdinal,
    member "bookRevision" anchor.bookRevision, member "coordinate" anchor.coordinate,
    member "inventoryPolicy" anchor.inventoryPolicy,
    member "quantizationPolicy" anchor.quantizationPolicy,
    optMember "predecessorPosition" anchor.predecessorPosition,
    member "sourcePostings" anchor.sourcePostings,
    member "incomingMovements" anchor.incomingMovements, member "evidence" anchor.evidence]

instance : CanonicalObject InventoryPostedAnchorBody := ⟨InventoryPostedAnchorBody.canonicalMembers⟩

/-- `InventoryPostedAnchor`: the body and its `contentHash`. -/
def InventoryPostedAnchor.canonicalMembers (anchor : InventoryPostedAnchor) : List Member :=
  anchor.toInventoryPostedAnchorBody.canonicalMembers ++
    [member "contentHash" anchor.contentHash]

instance : CanonicalObject InventoryPostedAnchor := ⟨InventoryPostedAnchor.canonicalMembers⟩

/-- `Omit<InventoryPostedPosition, "contentHash">`. -/
def InventoryPostedPositionBody.canonicalMembers (position : InventoryPostedPositionBody) :
    List Member :=
  [member "holdingId" position.holdingId, member "consumedQuantity" position.consumedQuantity,
    member "consumedPosted" position.consumedPosted, member "anchor" position.anchor,
    member "originMovementId" position.originMovementId,
    member "originEffectKey" position.originEffectKey,
    member "originArtifactOrdinal" position.originArtifactOrdinal,
    member "originBookRevision" position.originBookRevision]

instance : CanonicalObject InventoryPostedPositionBody :=
  ⟨InventoryPostedPositionBody.canonicalMembers⟩

/-- `InventoryPostedPosition`: the body and its `contentHash`. -/
def InventoryPostedPosition.canonicalMembers (position : InventoryPostedPosition) : List Member :=
  position.toInventoryPostedPositionBody.canonicalMembers ++
    [member "contentHash" position.contentHash]

instance : CanonicalObject InventoryPostedPosition := ⟨InventoryPostedPosition.canonicalMembers⟩

/-! ## Reduction movements -/

/-- `InventoryPostedReductionMovementBody`. -/
def InventoryPostedReductionMovementBody.canonicalMembers
    (body : InventoryPostedReductionMovementBody) : List Member :=
  [member "id" body.id, member "kind" body.kind, member "effectKey" body.effectKey,
    member "artifactOrdinal" body.artifactOrdinal, member "bookRevision" body.bookRevision,
    member "accountingDate" body.accountingDate, member "fiscalPeriodId" body.fiscalPeriodId,
    member "coordinate" body.coordinate, member "postedAmount" body.postedAmount,
    member "beforePosition" body.beforePosition, member "afterPosition" body.afterPosition,
    member "quantityAllocation" body.quantityAllocation,
    member "reductionProof" body.reductionProof,
    member "incomingSources" body.incomingSources]

instance : CanonicalObject InventoryPostedReductionMovementBody :=
  ⟨InventoryPostedReductionMovementBody.canonicalMembers⟩

/-- The journal-linked case without its `contentHash`: the body, `monetaryKind: "journalLinked"`
and the posting. -/
def JournalLinkedInventoryReductionMovementBody.canonicalMembers
    (movement : JournalLinkedInventoryReductionMovementBody) : List Member :=
  movement.toInventoryPostedReductionMovementBody.canonicalMembers ++
    [literalMember "monetaryKind" "journalLinked", member "posting" movement.posting]

instance : CanonicalObject JournalLinkedInventoryReductionMovementBody :=
  ⟨JournalLinkedInventoryReductionMovementBody.canonicalMembers⟩

/-- `JournalLinkedInventoryReductionMovement`. -/
def JournalLinkedInventoryReductionMovement.canonicalMembers
    (movement : JournalLinkedInventoryReductionMovement) : List Member :=
  movement.toJournalLinkedInventoryReductionMovementBody.canonicalMembers ++
    [member "contentHash" movement.contentHash]

instance : CanonicalObject JournalLinkedInventoryReductionMovement :=
  ⟨JournalLinkedInventoryReductionMovement.canonicalMembers⟩

/-- The quantity-only case without its `contentHash`: the body and
`monetaryKind: "quantityOnly"`, no `posting`. -/
def InventoryPostedReductionMovementBody.quantityOnlyMembers
    (body : InventoryPostedReductionMovementBody) : List Member :=
  body.canonicalMembers ++ [literalMember "monetaryKind" "quantityOnly"]

/-- `QuantityOnlyInventoryReductionMovement`. -/
def QuantityOnlyInventoryReductionMovement.canonicalMembers
    (movement : QuantityOnlyInventoryReductionMovement) : List Member :=
  movement.toInventoryPostedReductionMovementBody.quantityOnlyMembers ++
    [member "contentHash" movement.contentHash]

instance : CanonicalObject QuantityOnlyInventoryReductionMovement :=
  ⟨QuantityOnlyInventoryReductionMovement.canonicalMembers⟩

/-- `MovementHashInput`: the case's record without `contentHash`. -/
def MovementHashInput.canonicalMembers : MovementHashInput → List Member
  | .journalLinked body => body.canonicalMembers
  | .quantityOnly body => body.quantityOnlyMembers

instance : CanonicalObject MovementHashInput := ⟨MovementHashInput.canonicalMembers⟩

/-- `InventoryPostedReductionMovement`: the record of its case. -/
def InventoryPostedReductionMovement.canonicalMembers :
    InventoryPostedReductionMovement → List Member
  | .journalLinked movement => movement.canonicalMembers
  | .quantityOnly movement => movement.canonicalMembers

instance : CanonicalObject InventoryPostedReductionMovement :=
  ⟨InventoryPostedReductionMovement.canonicalMembers⟩

/-! ## Acquisition movements -/

/-- `InventoryPostedAcquisitionMovementBody`. -/
def InventoryPostedAcquisitionMovementBody.canonicalMembers
    (body : InventoryPostedAcquisitionMovementBody) : List Member :=
  [member "id" body.id, member "kind" body.kind, member "effectKey" body.effectKey,
    member "artifactOrdinal" body.artifactOrdinal, member "bookRevision" body.bookRevision,
    member "accountingDate" body.accountingDate, member "fiscalPeriodId" body.fiscalPeriodId,
    member "coordinate" body.coordinate, member "postedAmount" body.postedAmount,
    member "afterPosition" body.afterPosition,
    member "acquisitionProof" body.acquisitionProof,
    member "incomingSources" body.incomingSources]

instance : CanonicalObject InventoryPostedAcquisitionMovementBody :=
  ⟨InventoryPostedAcquisitionMovementBody.canonicalMembers⟩

/-- The journal-linked case without its `contentHash`. -/
def JournalLinkedInventoryAcquisitionMovementBody.canonicalMembers
    (movement : JournalLinkedInventoryAcquisitionMovementBody) : List Member :=
  movement.toInventoryPostedAcquisitionMovementBody.canonicalMembers ++
    [literalMember "monetaryKind" "journalLinked", member "posting" movement.posting]

instance : CanonicalObject JournalLinkedInventoryAcquisitionMovementBody :=
  ⟨JournalLinkedInventoryAcquisitionMovementBody.canonicalMembers⟩

/-- The journal-linked case of `InventoryPostedAcquisitionMovement`. -/
def JournalLinkedInventoryAcquisitionMovement.canonicalMembers
    (movement : JournalLinkedInventoryAcquisitionMovement) : List Member :=
  movement.toJournalLinkedInventoryAcquisitionMovementBody.canonicalMembers ++
    [member "contentHash" movement.contentHash]

instance : CanonicalObject JournalLinkedInventoryAcquisitionMovement :=
  ⟨JournalLinkedInventoryAcquisitionMovement.canonicalMembers⟩

/-- The quantity-only case without its `contentHash`. -/
def InventoryPostedAcquisitionMovementBody.quantityOnlyMembers
    (body : InventoryPostedAcquisitionMovementBody) : List Member :=
  body.canonicalMembers ++ [literalMember "monetaryKind" "quantityOnly"]

/-- The quantity-only case of `InventoryPostedAcquisitionMovement`. -/
def QuantityOnlyInventoryAcquisitionMovement.canonicalMembers
    (movement : QuantityOnlyInventoryAcquisitionMovement) : List Member :=
  movement.toInventoryPostedAcquisitionMovementBody.quantityOnlyMembers ++
    [member "contentHash" movement.contentHash]

instance : CanonicalObject QuantityOnlyInventoryAcquisitionMovement :=
  ⟨QuantityOnlyInventoryAcquisitionMovement.canonicalMembers⟩

/-- `Omit<InventoryPostedAcquisitionMovement, "contentHash">`: the case's record. -/
def InventoryPostedAcquisitionMovementHashInput.canonicalMembers :
    InventoryPostedAcquisitionMovementHashInput → List Member
  | .journalLinked body => body.canonicalMembers
  | .quantityOnly body => body.quantityOnlyMembers

instance : CanonicalObject InventoryPostedAcquisitionMovementHashInput :=
  ⟨InventoryPostedAcquisitionMovementHashInput.canonicalMembers⟩

/-- `InventoryPostedAcquisitionMovement`: the record of its case. -/
def InventoryPostedAcquisitionMovement.canonicalMembers :
    InventoryPostedAcquisitionMovement → List Member
  | .journalLinked movement => movement.canonicalMembers
  | .quantityOnly movement => movement.canonicalMembers

instance : CanonicalObject InventoryPostedAcquisitionMovement :=
  ⟨InventoryPostedAcquisitionMovement.canonicalMembers⟩

/-! ## Movements of either kind -/

/-- `InventoryPostedMovement`: the record of the movement it is. -/
def InventoryPostedMovement.canonicalMembers : InventoryPostedMovement → List Member
  | .reduction movement => movement.canonicalMembers
  | .acquisition movement => movement.canonicalMembers

instance : CanonicalObject InventoryPostedMovement := ⟨InventoryPostedMovement.canonicalMembers⟩

/-- A journal-linked movement of either kind: its record. -/
def JournalLinkedInventoryPostedMovement.canonicalMembers :
    JournalLinkedInventoryPostedMovement → List Member
  | .reduction movement => movement.canonicalMembers
  | .acquisition movement => movement.canonicalMembers

instance : CanonicalObject JournalLinkedInventoryPostedMovement :=
  ⟨JournalLinkedInventoryPostedMovement.canonicalMembers⟩

/-- A quantity-only movement of either kind: its record. -/
def QuantityOnlyInventoryPostedMovement.canonicalMembers :
    QuantityOnlyInventoryPostedMovement → List Member
  | .reduction movement => movement.canonicalMembers
  | .acquisition movement => movement.canonicalMembers

instance : CanonicalObject QuantityOnlyInventoryPostedMovement :=
  ⟨QuantityOnlyInventoryPostedMovement.canonicalMembers⟩

end Rastrata.Kernel

/-
The model of `packages/kernel/src/inventory-ownership.ts` lines 544 to 875:
`prepareInventoryPostedTransferGroup` and `prepareInventoryPostedAdoptionGroup`, on the helpers of
`InventoryOwnership/Reduction/Model.lean`, whose conventions this file follows (see its header):
the same checks in the same order, a `||` chain as one `Bool` or, when an operation in it may
throw, an `Except` of a `Bool`; every diagnostic in full; `.error` where the TypeScript throws.

Where the model differs from the TypeScript in form, besides what `Reduction/Model.lean` lists:
`sourcePosting!` (line 708) and `destinationPosting!` (line 758) take `default` where the
TypeScript would have no posting; `InventoryOwnership/Transfer.lean` proves that a prepared
journal-linked movement always carries the actual posting.
-/
import Rastrata.Kernel.InventoryOwnership.Reduction.Model

namespace Rastrata.Kernel

/-! ## Results -/

/-- The result of `prepareInventoryPostedTransferGroup`: `prepared` with the group, or
`rejected`. -/
inductive InventoryPostedTransferGroupResult where
  | prepared (group : InventoryPostedTransferGroup)
  | rejected (rejection : OwnershipRejection)
  deriving DecidableEq, Repr, Inhabited

/-- The result of `prepareInventoryPostedAdoptionGroup`: `prepared` with the group, or
`rejected`. -/
inductive InventoryPostedAdoptionGroupResult where
  | prepared (group : InventoryPostedAdoptionGroup)
  | rejected (rejection : OwnershipRejection)
  deriving DecidableEq, Repr, Inhabited

/-! ## `prepareInventoryPostedTransferGroup` (lines 577 to 774) -/

namespace InventoryOwnership

/-- Line 587. -/
def transferPopulationRejection : OwnershipRejection :=
  reject "inventoryOwnership.group"
    "A transfer group must contain a bounded nonempty allocation population and bounded journal sources"

/-- Line 592. -/
def transferSourcesRejection : OwnershipRejection :=
  reject "inventoryOwnership.group" "Combined transfer-group source populations exceed the operation bound"

/-- Line 604. -/
def transferIdentityRejection : OwnershipRejection :=
  reject "inventoryOwnership.groupIdentity"
    "A transfer group requires valid policies, canonical dimensions and distinct source/destination identities"

/-- Line 615. -/
def transferCoordinateRejection : OwnershipRejection :=
  reject "inventoryOwnership.groupCoordinate"
    "Transfer sources must share one book, account, commodity and dimension coordinate"

/-- Line 627. -/
def transferDestinationRejection : OwnershipRejection :=
  reject "inventoryOwnership.transferDestination"
    "Transfer destinations require matching coordinates, positive quantities, exact basis conservation and valid evidence"

/-- Line 645. -/
def transferZeroSourcePostingRejection : OwnershipRejection :=
  reject "inventoryOwnership.posting" "An all-zero transfer group has no source inventory posting"

/-- Line 647. -/
def transferMissingSourcePostingRejection : OwnershipRejection :=
  reject "inventoryOwnership.posting"
    "A money-bearing transfer group requires its source inventory posting"

/-- Line 653. -/
def transferSourceJournalRejection : OwnershipRejection :=
  reject "inventoryOwnership.journalSource"
    "The source journal must match this book, revision, date, fiscal period and canonical hash"

/-- Line 656. -/
def transferSourcePostingCountRejection : OwnershipRejection :=
  reject "inventoryOwnership.posting" "The group must resolve exactly one source inventory posting"

/-- Line 663. -/
def transferSourceAttributionRejection : OwnershipRejection :=
  reject "inventoryOwnership.postingAttribution"
    "The source inventory posting must exactly cover the transferred money, quantity, basis and coordinate"

/-- Line 669. -/
def transferZeroDestinationPostingRejection : OwnershipRejection :=
  reject "inventoryOwnership.posting"
    "An all-zero transfer group has no destination inventory posting"

/-- Line 671. -/
def transferMissingDestinationPostingRejection : OwnershipRejection :=
  reject "inventoryOwnership.posting"
    "A money-bearing transfer group requires its destination inventory posting"

/-- Line 677. -/
def transferDestinationJournalRejection : OwnershipRejection :=
  reject "inventoryOwnership.journalSource"
    "The destination journal must match this book, revision, date, fiscal period and canonical hash"

/-- Line 680. -/
def transferDestinationPostingCountRejection : OwnershipRejection :=
  reject "inventoryOwnership.posting"
    "The group must resolve exactly one destination inventory posting"

/-- Line 687. -/
def transferDestinationAttributionRejection : OwnershipRejection :=
  reject "inventoryOwnership.postingAttribution"
    "The destination inventory posting must exactly cover the transferred money, quantity, basis and coordinate"

/-- The test of lines 584 to 586. -/
def transferPopulationInvalid (entries : List InventoryPostedTransferEntry)
    (sourceJournalLink destinationJournalLink : Option InventoryPostedJournalLink) : Bool :=
  decide (entries.length = 0) || decide (entries.length > cap) ||
    (match sourceJournalLink with
      | none => false
      | some link => decide (link.source.journal.postings.length > cap)) ||
    (match destinationJournalLink with
      | none => false
      | some link => decide (link.source.journal.postings.length > cap))

/-- What one entry adds to the source count of line 591: its source anchor's postings, movements,
evidence and predecessor, and its own evidence. -/
def transferSourceCount (entry : InventoryPostedTransferEntry) : Nat :=
  entry.source.anchor.sourcePostings.length + entry.source.anchor.incomingMovements.length +
    entry.source.anchor.evidence.length + entry.evidence.length +
    (match entry.source.anchor.predecessorPosition with
      | none => 0
      | some _ => 1)

/-- The loop of lines 589 to 593 from the `sources` counted so far. -/
def transferSourcesExceeded : Nat → List InventoryPostedTransferEntry → Bool
  | _, [] => false
  | sources, entry :: rest =>
    let next := sources + transferSourceCount entry
    decide (next > cap) || transferSourcesExceeded next rest

/-- The test of lines 594 to 603. -/
def transferIdentityInvalid (context : InventoryPostedTransferGroupContext)
    (entries : List InventoryPostedTransferEntry) : Bool :=
  decide (context.bookRevision ≤ 0) || decide (context.firstArtifactOrdinal ≤ 0) ||
    decide (context.effectKey.value.length = 0) || decide (context.commandId.value.length = 0) ||
    !fullHash context.destinationInventoryPolicy.policyContentHash ||
    context.destinationQuantizationPolicy.bookId != context.bookId ||
    hasDuplicates (entries.map (·.source.holding.id)) ||
    hasDuplicates (entries.map (·.destinationHolding.id)) ||
    hasDuplicates (entries.map (·.destinationLot.id)) ||
    hasDuplicates (entries.map (·.destinationAnchorId)) ||
    hasDuplicates (entries.map (·.destinationMovementId)) ||
    hasDuplicates (entries.map (·.transferOutMovementId)) ||
    hasDuplicates (entries.map (·.allocation.id)) ||
    dimensionsOutOfOrder context.destinationDimensionMemberIds

/-- The test of lines 618 to 626 for one entry: the destination holding and lot are not of the
book, of each other, of the group's account, units commodity and currency, do not hold exactly the
allocation's quantity and basis (and, for a component-bearing source anchor, its allowance and
carrying amount; otherwise no allowance and a carrying amount equal to the basis), or the evidence
is not valid. -/
def transferDestinationInvalid (context : InventoryPostedTransferGroupContext)
    (sourceCoordinate : InventoryPostedCoordinate) (firstDest : LotHolding)
    (entry : InventoryPostedTransferEntry) : Bool :=
  let dh := entry.destinationHolding
  let dl := entry.destinationLot
  let destPolicy := context.destinationQuantizationPolicy
  dh.bookId != context.bookId || dl.bookId != context.bookId || dh.lotId != dl.id ||
    dh.accountId != firstDest.accountId || dh.commodityId != sourceCoordinate.unitsCommodityId ||
    dl.commodityId != dh.commodityId || dh.basisCommodityId != destPolicy.functionalCommodityId ||
    dl.basisCommodityId != dh.basisCommodityId ||
    !dh.remainingQuantity.equals entry.allocation.allocatedQuantity ||
    !dh.remainingTotalBasis.equals entry.allocation.allocatedTotalBasis ||
    (if entry.source.anchor.algorithmVersion.value == "1.1.0" then
      !dh.remainingValuationAllowance.equals entry.allocation.allocatedValuationAllowance ||
        !dh.remainingCarryingAmount.equals entry.allocation.allocatedCarryingAmount
    else
      !dh.remainingValuationAllowance.isZero ||
        !dh.remainingCarryingAmount.equals dh.remainingTotalBasis) ||
    evidenceInvalid entry.evidence

/-- The loop of lines 610 to 629: the rejection of the first entry whose source coordinate or
destination does not pass, or none. -/
def transferCheckLoop (context : InventoryPostedTransferGroupContext)
    (sourceCoordinate : InventoryPostedCoordinate) (firstDest : LotHolding) :
    List InventoryPostedTransferEntry → Option OwnershipRejection
  | [] => none
  | entry :: rest =>
    if groupCoordinateMismatch context.bookId sourceCoordinate entry.source.anchor.coordinate then
      some transferCoordinateRejection
    else if transferDestinationInvalid context sourceCoordinate firstDest entry then
      some transferDestinationRejection
    else transferCheckLoop context sourceCoordinate firstDest rest

/-- The loop of lines 632 to 642 from the entry at `index`, with the running transferred posted
amount, quantity and basis: each source reduction prepared, and its share's posted amount, its
allocated quantity and its basis added. -/
def transferReductionLoop (context : InventoryPostedTransferGroupContext) :
    Nat → ExactRational → ExactRational → ExactRational → List InventoryPostedTransferEntry →
      Except QuantizeErr (OwnershipStep
        (List InventoryPostedReduction × ExactRational × ExactRational × ExactRational))
  | _, posted, quantity, basis, [] => .ok (.proceed ([], posted, quantity, basis))
  | index, posted, quantity, basis, entry :: rest =>
    match prepareInventoryPostedReduction entry.source.anchor entry.source.position
        entry.source.holding entry.allocation
        (groupOrigin context.toInventoryPostedGroupContext entry.transferOutMovementId index) with
    | .error e => .error e
    | .ok (.rejected rejection) => .ok (.rejected rejection)
    | .ok (.prepared reduction) =>
      match liftExact reduction.reductionProof.postedAmount.toRational with
      | .error e => .error e
      | .ok amount =>
        match liftExact (posted.add amount) with
        | .error e => .error e
        | .ok posted' =>
          match liftExact (quantity.add entry.allocation.allocatedQuantity) with
          | .error e => .error e
          | .ok quantity' =>
            match liftExact (basis.add entry.allocation.allocatedTotalBasis) with
            | .error e => .error e
            | .ok basis' =>
              match transferReductionLoop context (index + 1) posted' quantity' basis' rest with
              | .error e => .error e
              | .ok (.rejected rejection) => .ok (.rejected rejection)
              | .ok (.proceed (reductions, total, totalQuantity, totalBasis)) =>
                .ok (.proceed (reduction :: reductions, total, totalQuantity, totalBasis))

/-- Lines 643 to 666: the source posting reference. An all-zero group has none and must not be
linked; a money-bearing one must be linked to a matching journal with one matching posting that
takes out exactly the transferred money, quantity and basis at the source coordinate. -/
def transferSourcePosting (context : InventoryPostedTransferGroupContext)
    (sourceCoordinate : InventoryPostedCoordinate) (link : Option InventoryPostedJournalLink)
    (total quantity basis : ExactRational) :
    Except InventoryOwnershipErr (OwnershipStep (Option CanonicalPostingReference)) :=
  if total.isZero then
    match link with
    | some _ => .ok (.rejected transferZeroSourcePostingRejection)
    | none => .ok (.proceed none)
  else
    match link with
    | none => .ok (.rejected transferMissingSourcePostingRejection)
    | some link =>
      if journalSourceMismatch context.toInventoryReductionEffectContext
          sourceCoordinate.functionalCommodityId link.source then
        .ok (.rejected transferSourceJournalRejection)
      else
        match link.source.journal.postings.filter (fun p => p.id == link.postingId) with
        | [actual] =>
          match InventoryOwnershipErr.ofQuantize (postingAttributionInvalid
              sourceCoordinate.accountId sourceCoordinate.unitsCommodityId
              sourceCoordinate.functionalCommodityId sourceCoordinate.dimensionMemberIds actual
              total.negate quantity.negate basis.negate) with
          | .error e => .error e
          | .ok true => .ok (.rejected transferSourceAttributionRejection)
          | .ok false =>
            match effectKey link.source.effectKey with
            | .error e => .error (.effectKey e)
            | .ok key =>
              .ok (.proceed (some (createCanonicalPostingReference link.referenceId
                context.bookId link.source.journal.id actual key)))
        | _ => .ok (.rejected transferSourcePostingCountRejection)

/-- Lines 667 to 690: the destination posting reference, the same tests against the destination's
account, currency and dimensions and the transferred money, quantity and basis brought in. -/
def transferDestinationPosting (context : InventoryPostedTransferGroupContext)
    (sourceCoordinate : InventoryPostedCoordinate) (firstDest : LotHolding)
    (link : Option InventoryPostedJournalLink) (total quantity basis : ExactRational) :
    Except InventoryOwnershipErr (OwnershipStep (Option CanonicalPostingReference)) :=
  let destPolicy := context.destinationQuantizationPolicy
  if total.isZero then
    match link with
    | some _ => .ok (.rejected transferZeroDestinationPostingRejection)
    | none => .ok (.proceed none)
  else
    match link with
    | none => .ok (.rejected transferMissingDestinationPostingRejection)
    | some link =>
      if journalSourceMismatch context.toInventoryReductionEffectContext
          destPolicy.functionalCommodityId link.source then
        .ok (.rejected transferDestinationJournalRejection)
      else
        match link.source.journal.postings.filter (fun p => p.id == link.postingId) with
        | [actual] =>
          match InventoryOwnershipErr.ofQuantize (postingAttributionInvalid firstDest.accountId
              sourceCoordinate.unitsCommodityId destPolicy.functionalCommodityId
              context.destinationDimensionMemberIds actual total quantity basis) with
          | .error e => .error e
          | .ok true => .ok (.rejected transferDestinationAttributionRejection)
          | .ok false =>
            match effectKey link.source.effectKey with
            | .error e => .error (.effectKey e)
            | .ok key =>
              .ok (.proceed (some (createCanonicalPostingReference link.referenceId
                context.bookId link.source.journal.id actual key)))
        | _ => .ok (.rejected transferDestinationPostingCountRejection)

/-- Lines 722 to 727: the destination's posted components, the source's consumed components carried
whole into the destination policy (fractions zero and zero), or none for a source without them. -/
def transferPostedValue (destPolicy : QuantizationPolicy) (reduction : InventoryPostedReduction) :
    Except QuantizeErr (OwnershipStep (Option InventoryPostedValueBudget)) :=
  match reduction.postedValue with
  | none => .ok (.proceed none)
  | some values =>
    match allocateInventoryPostedValue values.consumed ExactRational.zero ExactRational.zero
        destPolicy with
    | .error e => .error e
    | .ok (.rejected rejection) => .ok (.rejected ⟨rejection.diagnostics⟩)
    | .ok (.allocated destination) => .ok (.proceed (some destination.remaining))

/-- `anchorBody` (lines 728 to 737): the destination anchor of an entry. -/
def transferAnchorBody (context : InventoryPostedTransferGroupContext)
    (entry : InventoryPostedTransferEntry) (anchorOrdinal : Int)
    (transferredBudget : ExactDecimal) (postedValue : Option InventoryPostedValueBudget)
    (destinationPosting : Option CanonicalPostingReference)
    (predecessor : InventoryPostedPositionReference)
    (transferOut : InventoryPostedMovementReference) : InventoryPostedAnchorBody :=
  let destHolding := entry.destinationHolding
  let destPolicy := context.destinationQuantizationPolicy
  { id := entry.destinationAnchorId, algorithm := .cumulativePostedInventoryV1,
    algorithmVersion := if postedValue.isNone then ⟨"1.0.0"⟩ else ⟨"1.1.0"⟩,
    quantity := entry.allocation.allocatedQuantity, postedBudget := transferredBudget,
    postedValue, effectKey := context.effectKey, artifactOrdinal := anchorOrdinal,
    bookRevision := context.bookRevision,
    coordinate := { bookId := context.bookId, holdingId := destHolding.id,
                    lotId := entry.destinationLot.id, accountId := destHolding.accountId,
                    unitsCommodityId := destHolding.commodityId,
                    functionalCommodityId := destPolicy.functionalCommodityId,
                    dimensionMemberIds := context.destinationDimensionMemberIds },
    inventoryPolicy := context.destinationInventoryPolicy, quantizationPolicy := destPolicy,
    predecessorPosition := some predecessor, sourcePostings := destinationPosting.toList,
    incomingMovements := [transferOut], evidence := entry.evidence }

/-- The loop of lines 695 to 761 from `index`, with the entry `ordered[index]` beside its
reduction: the transfer-out movement, the destination anchor, position and transfer-in movement.
`count` is `ordered.length`. -/
def transferConstruction (context : InventoryPostedTransferGroupContext)
    (sourcePosting destinationPosting : Option CanonicalPostingReference) (count : Nat) :
    Nat → List InventoryPostedTransferEntry → List InventoryPostedReduction →
      Except QuantizeErr (OwnershipStep (List InventoryPostedReductionMovement ×
        List InventoryPostedAnchor × List InventoryPostedAcquisitionMovement))
  | index, entry :: entries, reduction :: reductions =>
    let destPolicy := context.destinationQuantizationPolicy
    let transferOutOrdinal := context.firstArtifactOrdinal + index
    let anchorOrdinal := context.firstArtifactOrdinal + ((count + index : Nat) : Int)
    let destMovementOrdinal := context.firstArtifactOrdinal + ((2 * count + index : Nat) : Int)
    let transferOut := reductionMovementOf context.toInventoryReductionEffectContext .transferOut
      entry.transferOutMovementId transferOutOrdinal entry.source.anchor.coordinate reduction
      sourcePosting
    let transferredBudget := reduction.reductionProof.postedAmount
    let transferOutRef : InventoryPostedMovementReference :=
      { id := transferOut.id, contentHash := transferOut.contentHash, bookId := context.bookId,
        effectKey := context.effectKey, artifactOrdinal := transferOut.artifactOrdinal,
        bookRevision := context.bookRevision }
    let predecessorRef : InventoryPostedPositionReference :=
      { id := entry.source.position.holdingId, contentHash := entry.source.position.contentHash,
        bookId := context.bookId, effectKey := entry.source.position.originEffectKey,
        artifactOrdinal := entry.source.position.originArtifactOrdinal,
        bookRevision := entry.source.position.originBookRevision }
    match transferPostedValue destPolicy reduction with
    | .error e => .error e
    | .ok (.rejected rejection) => .ok (.rejected rejection)
    | .ok (.proceed postedValue) =>
      let anchorBody := transferAnchorBody context entry anchorOrdinal transferredBudget postedValue
        destinationPosting predecessorRef transferOutRef
      let destAnchor : InventoryPostedAnchor := ⟨anchorBody, hashInventoryPostedAnchor anchorBody⟩
      match liftExact (ExactDecimal.of 0 destPolicy.targetScale) with
      | .error e => .error e
      | .ok zeroPosted =>
        let destPositionBody : InventoryPostedPositionBody :=
          { holdingId := entry.destinationHolding.id, consumedQuantity := ExactRational.zero,
            consumedPosted := zeroPosted, anchor := groupAnchorReference context.bookId destAnchor,
            originMovementId := entry.destinationMovementId, originEffectKey := context.effectKey,
            originArtifactOrdinal := destMovementOrdinal,
            originBookRevision := context.bookRevision }
        let destPosition : InventoryPostedPosition :=
          ⟨destPositionBody, hashInventoryPostedPosition destPositionBody⟩
        match liftExact (ExactRational.of 1 1) with
        | .error e => .error e
        | .ok one =>
          match destPolicy.quantizeCumulativePostedShare transferredBudget ExactRational.zero one with
          | .error e => .error e
          | .ok (.rejected diagnostics) => .ok (.rejected ⟨diagnostics⟩)
          | .ok (.quantized acqProof) =>
            let acqBody : InventoryPostedAcquisitionMovementBody :=
              { id := entry.destinationMovementId, kind := .transferIn,
                effectKey := context.effectKey, artifactOrdinal := destMovementOrdinal,
                bookRevision := context.bookRevision, accountingDate := context.accountingDate,
                fiscalPeriodId := context.fiscalPeriodId, coordinate := destAnchor.coordinate,
                postedAmount := transferredBudget, afterPosition := destPosition,
                acquisitionProof := acqProof, incomingSources := [transferOutRef] }
            match transferConstruction context sourcePosting destinationPosting count (index + 1)
                entries reductions with
            | .error e => .error e
            | .ok (.rejected rejection) => .ok (.rejected rejection)
            | .ok (.proceed (outs, anchors, ins)) =>
              .ok (.proceed (transferOut :: outs, destAnchor :: anchors,
                acquisitionMovementOf acqBody destinationPosting :: ins))
  | _, _, _ => .ok (.proceed ([], [], []))

end InventoryOwnership

open InventoryOwnership in
/-- `prepareInventoryPostedTransferGroup` (line 577): the reductions, the destination anchors and
the movements of one transfer group, in source holding-identifier order; the transferred posted
money is the source share's, carried to the destination without rerounding. -/
def prepareInventoryPostedTransferGroup (context : InventoryPostedTransferGroupContext)
    (entries : List InventoryPostedTransferEntry)
    (sourceJournalLink destinationJournalLink : Option InventoryPostedJournalLink) :
    Except InventoryOwnershipErr InventoryPostedTransferGroupResult :=
  if transferPopulationInvalid entries sourceJournalLink destinationJournalLink then
    .ok (.rejected transferPopulationRejection)
  else if transferSourcesExceeded 0 entries then .ok (.rejected transferSourcesRejection)
  else if transferIdentityInvalid context entries then .ok (.rejected transferIdentityRejection)
  else
    let ordered := sortByText (·.source.holding.id.value) entries
    let sourceCoordinate := (ordered.head?.map (·.source.anchor.coordinate)).getD default
    let firstDest := (ordered.head?.map (·.destinationHolding)).getD default
    match transferCheckLoop context sourceCoordinate firstDest ordered with
    | some rejection => .ok (.rejected rejection)
    | none =>
      match InventoryOwnershipErr.ofQuantize (transferReductionLoop context 0 ExactRational.zero
          ExactRational.zero ExactRational.zero ordered) with
      | .error e => .error e
      | .ok (.rejected rejection) => .ok (.rejected rejection)
      | .ok (.proceed (reductions, total, totalQuantity, totalBasis)) =>
        match transferSourcePosting context sourceCoordinate sourceJournalLink total totalQuantity
            totalBasis with
        | .error e => .error e
        | .ok (.rejected rejection) => .ok (.rejected rejection)
        | .ok (.proceed sourcePosting) =>
          match transferDestinationPosting context sourceCoordinate firstDest
              destinationJournalLink total totalQuantity totalBasis with
          | .error e => .error e
          | .ok (.rejected rejection) => .ok (.rejected rejection)
          | .ok (.proceed destinationPosting) =>
            match InventoryOwnershipErr.ofQuantize (transferConstruction context sourcePosting
                destinationPosting ordered.length 0 ordered reductions) with
            | .error e => .error e
            | .ok (.rejected rejection) => .ok (.rejected rejection)
            | .ok (.proceed (outs, anchors, ins)) =>
              match InventoryOwnershipErr.ofQuantize
                  (quantize total context.destinationQuantizationPolicy.rule) with
              | .error e => .error e
              | .ok transferred =>
                .ok (.prepared
                  { transferOutMovements := outs, destinationAnchors := anchors,
                    destinationMovements := ins,
                    destinationLots := ordered.map (·.destinationLot),
                    destinationHoldings := ordered.map (·.destinationHolding),
                    afterSourceHoldings := reductions.map (·.afterHolding),
                    afterSourcePositions := reductions.map (·.afterPosition),
                    transferredPostedAmount := transferred.amount,
                    transferredQuantity := totalQuantity })

/-! ## `prepareInventoryPostedAdoptionGroup` (lines 800 to 874) -/

namespace InventoryOwnership

/-- Line 807. -/
def adoptionPopulationRejection : OwnershipRejection :=
  reject "inventoryOwnership.adoption" "Adoption inputs must fit bounded nonempty group populations"

/-- Line 812. -/
def adoptionEvidenceRejection : OwnershipRejection :=
  reject "inventoryOwnership.adoption" "Adoption evidence exceeds the combined work bound"

/-- Line 820. -/
def adoptionIdentityRejection : OwnershipRejection :=
  reject "inventoryOwnership.adoptionIdentity"
    "Adoption requires unique local identities, canonical dimensions and pinned policy/origin metadata"

/-- Line 836. -/
def adoptionSourceRejection : OwnershipRejection :=
  reject "inventoryOwnership.adoptionSource"
    "Adopted holdings require coherent positive quantities, same-coordinate economics and complete evidence"

/-- Line 843. -/
def adoptionBalanceRejection : OwnershipRejection :=
  reject "inventoryOwnership.adoptionBalance"
    "The verified posted money balance must equal the complete remaining carrying amount of all adopted holdings in the scope"

/-- The test of line 806. -/
def adoptionPopulationInvalid (context : InventoryPostedAdoptionContext)
    (entries : List InventoryPostedAdoptionEntry) : Bool :=
  decide (entries.length = 0) || decide (entries.length > cap) ||
    decide (context.dimensionMemberIds.length > cap)

/-- The loop of lines 809 to 813 from the `work` counted so far. -/
def adoptionEvidenceExceeded : Nat → List InventoryPostedAdoptionEntry → Bool
  | _, [] => false
  | work, entry :: rest =>
    let next := work + (entry.evidence.length + entry.historicalPostings.length)
    decide (next > cap) || adoptionEvidenceExceeded next rest

/-- The test of lines 814 to 819. -/
def adoptionIdentityInvalid (context : InventoryPostedAdoptionContext)
    (entries : List InventoryPostedAdoptionEntry) : Bool :=
  decide (context.bookRevision ≤ 0) || decide (context.firstArtifactOrdinal ≤ 0) ||
    decide (context.effectKey.value.length = 0) || decide (context.commandId.value.length = 0) ||
    decide (context.inventoryPolicy.policyId.value.length = 0) ||
    decide (context.inventoryPolicy.policyVersion.value.length = 0) ||
    !fullHash context.inventoryPolicy.policyContentHash ||
    context.quantizationPolicy.bookId != context.bookId ||
    hasDuplicates (entries.map (·.holding.id)) || hasDuplicates (entries.map (·.anchorId)) ||
    hasDuplicates (entries.map (·.movementId)) || dimensionsOutOfOrder context.dimensionMemberIds

/-- The test of lines 826 to 835 for one entry, evaluated from the left; the addition of line 831
throws only if it is reached. -/
def adoptionSourceInvalid (context : InventoryPostedAdoptionContext) (first : LotHolding)
    (entry : InventoryPostedAdoptionEntry) : Except QuantizeErr Bool :=
  let h := entry.holding
  let policy := context.quantizationPolicy
  if decide (entry.anchorId.value.length = 0) || decide (entry.movementId.value.length = 0) ||
      decide (h.id.value.length = 0) || h.bookId != context.bookId ||
      h.accountId != first.accountId || h.commodityId != first.commodityId ||
      h.basisCommodityId != policy.functionalCommodityId ||
      h.remainingQuantity.compare ExactRational.zero != .gt || h.remainingTotalBasis.isNegative ||
      h.remainingValuationAllowance.compare ExactRational.zero == .gt ||
      h.remainingCarryingAmount.isNegative then .ok true
  else
    match liftExact (h.remainingTotalBasis.add h.remainingValuationAllowance) with
    | .error e => .error e
    | .ok sum =>
      .ok (!h.remainingCarryingAmount.equals sum || evidenceInvalid entry.evidence ||
        entry.historicalPostings.any (fun p =>
          p.bookId != context.bookId || !validateCanonicalPostingReferenceHash p) ||
        hasDuplicates (entry.historicalPostings.map (·.postingId)))

/-- The loop of lines 824 to 840 with the running `quantity` and `carrying`. -/
def adoptionSourceLoop (context : InventoryPostedAdoptionContext) (first : LotHolding) :
    ExactRational → ExactRational → List InventoryPostedAdoptionEntry →
      Except QuantizeErr (OwnershipStep (ExactRational × ExactRational))
  | quantity, carrying, [] => .ok (.proceed (quantity, carrying))
  | quantity, carrying, entry :: rest =>
    match adoptionSourceInvalid context first entry with
    | .error e => .error e
    | .ok true => .ok (.rejected adoptionSourceRejection)
    | .ok false =>
      match liftExact (quantity.add entry.holding.remainingQuantity) with
      | .error e => .error e
      | .ok quantity' =>
        match liftExact (carrying.add entry.holding.remainingCarryingAmount) with
        | .error e => .error e
        | .ok carrying' => adoptionSourceLoop context first quantity' carrying' rest

/-- `anchorBody` (line 853) of the entry at `index`, with its share. -/
def adoptionAnchorBody (context : InventoryPostedAdoptionContext)
    (entry : InventoryPostedAdoptionEntry) (index : Nat) (share : PolicyCumulativePostedShare) :
    InventoryPostedAnchorBody :=
  let h := entry.holding
  { id := entry.anchorId, algorithm := .cumulativePostedInventoryV1, algorithmVersion := ⟨"1.0.0"⟩,
    quantity := h.remainingQuantity, postedBudget := share.postedAmount, postedValue := none,
    effectKey := context.effectKey, artifactOrdinal := context.firstArtifactOrdinal + index,
    bookRevision := context.bookRevision,
    coordinate := { bookId := context.bookId, holdingId := h.id, lotId := h.lotId,
                    accountId := h.accountId, unitsCommodityId := h.commodityId,
                    functionalCommodityId := context.quantizationPolicy.functionalCommodityId,
                    dimensionMemberIds := context.dimensionMemberIds },
    inventoryPolicy := context.inventoryPolicy, quantizationPolicy := context.quantizationPolicy,
    predecessorPosition := none, sourcePostings := entry.historicalPostings,
    incomingMovements := [], evidence := entry.evidence }

/-- The loop of lines 848 to 872 from the entry at `index`, with the `cumulative` weight so far:
each holding's cumulative share of the adopted balance, its anchor, its position and its
quantity-only adoption movement. `count` is `ordered.length`. -/
def adoptionConstruction (context : InventoryPostedAdoptionContext) (balance : ExactDecimal)
    (carryingZero : Bool) (denominator : ExactRational) (count : Nat) :
    Nat → ExactRational → List InventoryPostedAdoptionEntry →
      Except QuantizeErr (OwnershipStep (List InventoryPostedAnchor ×
        List InventoryPostedAcquisitionMovement × List InventoryPostedPosition))
  | _, _, [] => .ok (.proceed ([], [], []))
  | index, cumulative, entry :: rest =>
    let policy := context.quantizationPolicy
    let weight := if carryingZero then entry.holding.remainingQuantity
      else entry.holding.remainingCarryingAmount
    match liftExact (cumulative.add weight) with
    | .error e => .error e
    | .ok next =>
      match liftExact (cumulative.divide denominator) with
      | .error e => .error e
      | .ok beforeFraction =>
        match liftExact (next.divide denominator) with
        | .error e => .error e
        | .ok afterFraction =>
          match policy.quantizeCumulativePostedShare balance beforeFraction afterFraction with
          | .error e => .error e
          | .ok (.rejected diagnostics) => .ok (.rejected ⟨diagnostics⟩)
          | .ok (.quantized share) =>
            let h := entry.holding
            let ordinal := context.firstArtifactOrdinal + index
            let movementOrdinal := ordinal + count
            let anchorBody := adoptionAnchorBody context entry index share
            let anchor : InventoryPostedAnchor := ⟨anchorBody, hashInventoryPostedAnchor anchorBody⟩
            match liftExact (ExactDecimal.of 0 policy.targetScale) with
            | .error e => .error e
            | .ok zeroPosted =>
              let positionBody : InventoryPostedPositionBody :=
                { holdingId := h.id, consumedQuantity := ExactRational.zero,
                  consumedPosted := zeroPosted,
                  anchor := groupAnchorReference context.bookId anchor,
                  originMovementId := entry.movementId, originEffectKey := context.effectKey,
                  originArtifactOrdinal := movementOrdinal,
                  originBookRevision := context.bookRevision }
              let position : InventoryPostedPosition :=
                ⟨positionBody, hashInventoryPostedPosition positionBody⟩
              match liftExact (ExactDecimal.of 0 policy.targetScale) with
              | .error e => .error e
              | .ok zeroTotal =>
                match policy.quantizeCumulativePostedShare zeroTotal ExactRational.zero
                    ExactRational.zero with
                | .error e => .error e
                | .ok (.rejected diagnostics) => .ok (.rejected ⟨diagnostics⟩)
                | .ok (.quantized zeroProof) =>
                  match liftExact (ExactDecimal.of 0 policy.targetScale) with
                  | .error e => .error e
                  | .ok zeroAmount =>
                    let body : InventoryPostedAcquisitionMovementBody :=
                      { id := entry.movementId, kind := .legacyAdoption,
                        effectKey := context.effectKey, artifactOrdinal := movementOrdinal,
                        bookRevision := context.bookRevision,
                        accountingDate := context.accountingDate,
                        fiscalPeriodId := context.fiscalPeriodId, coordinate := anchor.coordinate,
                        postedAmount := zeroAmount, afterPosition := position,
                        acquisitionProof := zeroProof, incomingSources := [] }
                    let movement : InventoryPostedAcquisitionMovement :=
                      .quantityOnly ⟨body, hashInventoryPostedAcquisitionMovement (.quantityOnly body)⟩
                    match adoptionConstruction context balance carryingZero denominator count
                        (index + 1) next rest with
                    | .error e => .error e
                    | .ok (.rejected rejection) => .ok (.rejected rejection)
                    | .ok (.proceed (anchors, movements, positions)) =>
                      .ok (.proceed (anchor :: anchors, movement :: movements,
                        position :: positions))

end InventoryOwnership

open InventoryOwnership in
/-- `prepareInventoryPostedAdoptionGroup` (line 800): prospective adoption arithmetic, in
holding-identifier order. -/
def prepareInventoryPostedAdoptionGroup (context : InventoryPostedAdoptionContext)
    (entries : List InventoryPostedAdoptionEntry) (postedBalance : ExactRational) :
    Except InventoryOwnershipErr InventoryPostedAdoptionGroupResult :=
  let policy := context.quantizationPolicy
  if adoptionPopulationInvalid context entries then .ok (.rejected adoptionPopulationRejection)
  else if adoptionEvidenceExceeded 0 entries then .ok (.rejected adoptionEvidenceRejection)
  else if adoptionIdentityInvalid context entries then .ok (.rejected adoptionIdentityRejection)
  else
    let ordered := sortByText (·.holding.id.value) entries
    let first := (ordered.head?.map (·.holding)).getD default
    match InventoryOwnershipErr.ofQuantize (adoptionSourceLoop context first ExactRational.zero
        ExactRational.zero ordered) with
    | .error e => .error e
    | .ok (.rejected rejection) => .ok (.rejected rejection)
    | .ok (.proceed (quantity, carrying)) =>
      match InventoryOwnershipErr.ofQuantize (quantize postedBalance policy.rule) with
      | .error e => .error e
      | .ok balance =>
        match InventoryOwnershipErr.ofQuantize (liftExact balance.amount.toRational) with
        | .error e => .error e
        | .ok balanceRational =>
          if !balanceRational.equals postedBalance || !postedBalance.equals carrying then
            .ok (.rejected adoptionBalanceRejection)
          else
            let denominator := if carrying.isZero then quantity else carrying
            match InventoryOwnershipErr.ofQuantize (adoptionConstruction context balance.amount
                carrying.isZero denominator ordered.length 0 ExactRational.zero ordered) with
            | .error e => .error e
            | .ok (.rejected rejection) => .ok (.rejected rejection)
            | .ok (.proceed (anchors, movements, positions)) =>
              .ok (.prepared
                { anchors := anchors, movements := movements,
                  holdings := ordered.map (·.holding), positions := positions,
                  adoptedPostedBalance := balance.amount, adoptedQuantity := quantity })

end Rastrata.Kernel

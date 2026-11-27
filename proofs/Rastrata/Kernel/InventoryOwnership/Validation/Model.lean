/-
The model of `packages/kernel/src/inventory-ownership.ts` lines 1445 to 1677:
`ownershipMovementValid`, `ownershipAcquisitionMovementValid`, `ownershipReductionEffectValid`,
`ownershipEffectValid` and `validateInventoryOwnershipArtifact`. `sameOwnershipValue` (line 1455)
is in `InventoryOwnership/Reduction/Model.lean`; `ownershipCoordinateValid`,
`ownershipPositionValid` and `ownershipAnchorValid` (lines 1459 to 1491) are in
`InventoryOwnership/Effects/Model.lean`, since `resolveInventoryOwnershipSources` calls them;
`isInventoryPostedReductionMovement` (line 1493) is in `InventoryOwnership/Types.lean`.

The conventions are those of `InventoryOwnership/Reduction/Model.lean`. Each predicate returns
`Bool` in the TypeScript, and throws where an exact-number operation in its chain throws
(`ExactDecimal.toRational`, `subtract`, `multiply`, `add`, `ExactDecimal.of`, and
`quantizeCumulativePostedShare` or `allocateInventoryPostedValue` with an inadmissible scale): here
it returns `Except`, its chain evaluated from the left, `.error` only where a throwing operation is
reached. One more throw: `sameOwnershipValue(anchor.sourcePostings[0], movement.posting)` (line
1622) is reached with no source posting only when a journal-linked acquisition movement's posted
total is zero, and `canonicalize(undefined)` throws a `TypeError` (`.undefinedValue`).

Where the model differs from the TypeScript in form, besides what `Reduction/Model.lean` lists:

- The run-time tests the TypeScript types already guarantee always pass: a reduction movement's
  `kind` (line 1500), an acquisition movement's `kind` (line 1522), the `monetaryKind` of a movement
  of a list typed by it (lines 1515, 1540, 1573, 1574, 1659 and 1660) and the `default` of
  `validateInventoryOwnershipArtifact` (line 1675). In `ownershipEffectValid`, a movement is either
  an acquisition movement (`kind` `"acquisition"`, `"transferIn"` or `"legacyAdoption"`) or a
  reduction movement (`isInventoryPostedReductionMovement`), so the branch `else return false`
  (line 1653) is never taken; the model tells the two apart by the constructor, which is the same
  test (`isInventoryPostedReductionMovement` of `.reduction` is `true` and of `.acquisition`
  `false`).
- `Object.hasOwn(movement, "posting")` (lines 1514 and 1538) is `false` for a quantity-only
  movement, which has no `posting` here (`InventoryOwnership/Types.lean`).
- `all[0]!` (line 1550) and `movements[0]!` (line 1581) are read only when the effect has a
  movement, which the test before them ensures; the model returns `false` where there is none, a
  branch never taken.
- Sorting by `artifactOrdinal` with the comparator of lines 1549 and 1583 is `List.mergeSort` with
  `≤` on the ordinals, a stable sort, as `Array.prototype.sort` is.
- `anchor.incomingMovements[0]` and `movement.incomingSources[0]` (line 1625) are read only after
  both lists were found to have one element; the model reads them by matching the one-element
  lists, which is the same test.
-/
import Rastrata.Kernel.InventoryOwnership.Effects.Model

namespace Rastrata.Kernel

/-- What the predicates of `InventoryOwnership/Validation/Model.lean` throw. -/
inductive InventoryOwnershipValidationErr where
  /-- An `ExactNumberError`, or the `RangeError` of `quantize`. -/
  | quantize (error : QuantizeErr)
  /-- The `TypeError` of `canonicalize(undefined)` (line 1622). -/
  | undefinedValue
  deriving DecidableEq, Repr, Inhabited

/-- A `QuantizeErr` as an error of validation. -/
def InventoryOwnershipValidationErr.ofQuantize {α : Type} :
    Except QuantizeErr α → Except InventoryOwnershipValidationErr α
  | .ok value => .ok value
  | .error e => .error (.quantize e)

namespace InventoryOwnershipValidation

open InventoryOwnership

/-! ## `ownershipMovementValid` (line 1497) -/

/-- The test of lines 1499 to 1501 before the after-position (the `kind` test always passes): a
carried hash the content does not reproduce, a revision, ordinal or effect key missing, or an
invalid coordinate. -/
def movementHeaderInvalid (movement : InventoryPostedReductionMovement) : Bool :=
  !contentHashEquals movement.contentHash (hashInventoryPostedReductionMovement movement.hashInput) ||
    decide (movement.bookRevision ≤ 0) || decide (movement.artifactOrdinal ≤ 0) ||
    decide (movement.effectKey.value.length = 0) || !ownershipCoordinateValid movement.coordinate

/-- The test of lines 1501 to 1505 after the after-position: the before-position is not a valid
reference in the coordinate's book, not before the movement or not of its holding; the
after-position is not of its holding, book or origin; the allocation is not of its holding or lot,
not positive, has a negative basis, a positive allowance or a negative carrying amount. -/
def movementLineageInvalid (movement : InventoryPostedReductionMovement) : Bool :=
  let c := movement.coordinate
  let after := movement.afterPosition
  let allocation := movement.quantityAllocation
  !referenceValid movement.beforePosition.toInventoryPostedArtifactReference c.bookId ||
    !precedes movement.beforePosition.artifactOrder movement.artifactOrder ||
    movement.beforePosition.id != c.holdingId || after.holdingId != c.holdingId ||
    after.anchor.bookId != c.bookId || after.originMovementId != movement.id ||
    after.originEffectKey != movement.effectKey ||
    after.originArtifactOrdinal != movement.artifactOrdinal ||
    after.originBookRevision != movement.bookRevision || allocation.holdingId != c.holdingId ||
    allocation.lotId != c.lotId || allocation.allocatedQuantity.compare ExactRational.zero != .gt ||
    allocation.allocatedTotalBasis.isNegative ||
    allocation.allocatedValuationAllowance.compare ExactRational.zero == .gt ||
    allocation.allocatedCarryingAmount.isNegative

/-- The test of lines 1507 and 1508: incoming sources, a proof under a policy of another book or
currency, fractions that do not increase, or less consumed than allocated. -/
def movementProofInvalid (movement : InventoryPostedReductionMovement) : Bool :=
  let c := movement.coordinate
  let proof := movement.reductionProof
  movement.incomingSources.length != 0 || proof.policy.bookId != c.bookId ||
    proof.policy.functionalCommodityId != c.functionalCommodityId ||
    proof.afterFraction.compare proof.beforeFraction != .gt ||
    movement.afterPosition.consumedQuantity.compare movement.quantityAllocation.allocatedQuantity
      == .lt

/-- The test of line 1509, its operations in the TypeScript's order (the subtraction, then the two
multiplications): the consumed quantity times the fraction step is not the allocated quantity times
the after fraction. -/
def movementFractionInvalid (movement : InventoryPostedReductionMovement) :
    Except QuantizeErr Bool :=
  let proof := movement.reductionProof
  match liftExact (proof.afterFraction.subtract proof.beforeFraction) with
  | .error e => .error e
  | .ok step =>
    match liftExact (movement.afterPosition.consumedQuantity.multiply step) with
    | .error e => .error e
    | .ok left =>
      match liftExact (movement.quantityAllocation.allocatedQuantity.multiply proof.afterFraction) with
      | .error e => .error e
      | .ok right => .ok (!left.equals right)

/-- The test of lines 1499 to 1509, evaluated from the left: the header, the after-position (its
validity may throw), the lineage, the allocation's carrying amount (the addition may throw), the
proof, and the fraction step. -/
def movementShapeInvalid (movement : InventoryPostedReductionMovement) : Except QuantizeErr Bool :=
  if movementHeaderInvalid movement then .ok true
  else
    match ownershipPositionValid movement.afterPosition with
    | .error e => .error e
    | .ok false => .ok true
    | .ok true =>
      if movementLineageInvalid movement then .ok true
      else
        let allocation := movement.quantityAllocation
        match liftExact (allocation.allocatedTotalBasis.add allocation.allocatedValuationAllowance) with
        | .error e => .error e
        | .ok sum =>
          if !allocation.allocatedCarryingAmount.equals sum then .ok true
          else if movementProofInvalid movement then .ok true
          else movementFractionInvalid movement

/-- The test of lines 1510 to 1513: the proof's share recomputed is rejected or is not the proof,
the after-position's consumed money is not the proof's quantized after target, or the posted amount
is not the negated share (`ExactDecimal.of` may throw). -/
def movementRecomputedInvalid (movement : InventoryPostedReductionMovement) :
    Except QuantizeErr Bool :=
  let proof := movement.reductionProof
  match proof.policy.quantizeCumulativePostedShare proof.postedTotal proof.beforeFraction
      proof.afterFraction with
  | .error e => .error e
  | .ok (.rejected _) => .ok true
  | .ok (.quantized share) =>
    if !sameOwnershipValue proof share ||
        !sameOwnershipValue movement.afterPosition.consumedPosted proof.afterQuantization.amount then
      .ok true
    else
      match liftExact (ExactDecimal.of (-proof.postedAmount.coefficient) proof.postedAmount.scale) with
      | .error e => .error e
      | .ok negated => .ok (!sameOwnershipValue movement.postedAmount negated)

/-- Lines 1514 to 1516: a quantity-only movement posts nothing; a journal-linked one posts a
negative amount (its conversion may throw) to a posting of its book, of another effect, whose hash
checks. -/
def movementMonetaryValid : InventoryPostedReductionMovement → Except QuantizeErr Bool
  | .quantityOnly movement => .ok movement.postedAmount.isZero
  | .journalLinked movement =>
    match liftExact movement.postedAmount.toRational with
    | .error e => .error e
    | .ok amount =>
      .ok (amount.isNegative && movement.posting.bookId == movement.coordinate.bookId &&
        movement.posting.effectKey != movement.effectKey &&
        validateCanonicalPostingReferenceHash movement.posting)

end InventoryOwnershipValidation

open InventoryOwnershipValidation in
/-- `ownershipMovementValid` (line 1497): the shape, the recomputed proof, then the money. -/
def ownershipMovementValid (movement : InventoryPostedReductionMovement) : Except QuantizeErr Bool :=
  match movementShapeInvalid movement with
  | .error e => .error e
  | .ok true => .ok false
  | .ok false =>
    match movementRecomputedInvalid movement with
    | .error e => .error e
    | .ok true => .ok false
    | .ok false => movementMonetaryValid movement

/-! ## `ownershipAcquisitionMovementValid` (line 1519) -/

namespace InventoryOwnershipValidation

open InventoryOwnership

/-- The test of lines 1521 to 1523 before the after-position (the `kind` test always passes): a
carried hash the content does not reproduce, an effect key or revision missing, an ordinal that
leaves no room for its anchor before it, or an invalid coordinate. -/
def acquisitionHeaderInvalid (movement : InventoryPostedAcquisitionMovement) : Bool :=
  !contentHashEquals movement.contentHash
      (hashInventoryPostedAcquisitionMovement movement.hashInput) ||
    decide (movement.effectKey.value.length = 0) || decide (movement.bookRevision ≤ 0) ||
    decide (movement.artifactOrdinal ≤ 1) || !ownershipCoordinateValid movement.coordinate

/-- The test of lines 1524 to 1528 after the after-position: it is not of the movement's holding,
book, effect, revision or origin, its anchor is not before the movement in the same effect, it has
consumed something, or the proof's policy is of another book or currency. -/
def acquisitionPositionInvalid (movement : InventoryPostedAcquisitionMovement) : Bool :=
  let p := movement.afterPosition
  let c := movement.coordinate
  let proof := movement.acquisitionProof
  p.holdingId != c.holdingId || p.anchor.bookId != c.bookId ||
    p.anchor.effectKey != movement.effectKey || p.anchor.bookRevision != movement.bookRevision ||
    decide (p.anchor.artifactOrdinal ≥ movement.artifactOrdinal) ||
    p.originMovementId != movement.id || p.originEffectKey != movement.effectKey ||
    p.originBookRevision != movement.bookRevision ||
    p.originArtifactOrdinal != movement.artifactOrdinal || !p.consumedQuantity.isZero ||
    !p.consumedPosted.isZero || proof.policy.bookId != c.bookId ||
    proof.policy.functionalCommodityId != c.functionalCommodityId

/-- Lines 1529 to 1535: a transfer in has one incoming source, a valid reference in the
coordinate's book before the movement; any other acquisition has none. -/
def acquisitionIncomingInvalid (movement : InventoryPostedAcquisitionMovement) : Bool :=
  if movement.kind == .transferIn then
    match movement.incomingSources with
    | [incoming] =>
      !referenceValid incoming.toInventoryPostedArtifactReference movement.coordinate.bookId ||
        !precedes incoming.artifactOrder movement.artifactOrder
    | _ => true
  else movement.incomingSources.length != 0

/-- The test of lines 1536 and 1537: the proof's share recomputed is rejected or is not the proof,
or the posted amount is not the proof's. -/
def acquisitionRecomputedInvalid (movement : InventoryPostedAcquisitionMovement) :
    Except QuantizeErr Bool :=
  let proof := movement.acquisitionProof
  match proof.policy.quantizeCumulativePostedShare proof.postedTotal proof.beforeFraction
      proof.afterFraction with
  | .error e => .error e
  | .ok (.rejected _) => .ok true
  | .ok (.quantized share) =>
    .ok (!sameOwnershipValue proof share || !sameOwnershipValue movement.postedAmount proof.postedAmount)

/-- Lines 1538 to 1541: a quantity-only movement posts nothing; a journal-linked legacy adoption is
not valid; any other journal-linked movement posts a positive amount (its conversion may throw) to a
posting of its book, of another effect, whose hash checks. -/
def acquisitionMonetaryValid : InventoryPostedAcquisitionMovement → Except QuantizeErr Bool
  | .quantityOnly movement => .ok movement.postedAmount.isZero
  | .journalLinked movement =>
    if movement.kind == .legacyAdoption then .ok false
    else
      match liftExact movement.postedAmount.toRational with
      | .error e => .error e
      | .ok amount =>
        .ok (amount.compare ExactRational.zero == .gt &&
          movement.posting.bookId == movement.coordinate.bookId &&
          movement.posting.effectKey != movement.effectKey &&
          validateCanonicalPostingReferenceHash movement.posting)

end InventoryOwnershipValidation

open InventoryOwnershipValidation in
/-- `ownershipAcquisitionMovementValid` (line 1519): the header, the after-position (its validity
may throw), its fields, the incoming sources, the recomputed proof, then the money. -/
def ownershipAcquisitionMovementValid (movement : InventoryPostedAcquisitionMovement) :
    Except QuantizeErr Bool :=
  if acquisitionHeaderInvalid movement then .ok false
  else
    match ownershipPositionValid movement.afterPosition with
    | .error e => .error e
    | .ok false => .ok false
    | .ok true =>
      if acquisitionPositionInvalid movement then .ok false
      else if acquisitionIncomingInvalid movement then .ok false
      else
        match acquisitionRecomputedInvalid movement with
        | .error e => .error e
        | .ok true => .ok false
        | .ok false => acquisitionMonetaryValid movement

/-! ## `ownershipReductionEffectValid` (line 1544) -/

namespace InventoryOwnershipValidation

open InventoryOwnership InventoryOwnershipEffects

/-- `[...values].sort((a, b) => a.artifactOrdinal < b.artifactOrdinal ? -1 : ... : 0)` (lines 1549
and 1583): a stable sort by ordinal. -/
def sortByOrdinal {α : Type} (ordinal : α → Int) (values : List α) : List α :=
  values.mergeSort fun a b => decide (ordinal a ≤ ordinal b)

/-- `values.every((value, i) => i === 0 || values[i - 1].artifactOrdinal < value.artifactOrdinal)`
(lines 1573, 1574 and 1658 to 1660): the ordinals strictly increase. -/
def ordinalsIncreasing : List Int → Bool
  | first :: second :: rest => decide (first < second) && ordinalsIncreasing (second :: rest)
  | _ => true

/-- The reference to a position at its origin, in the given book (lines 1564 and 1644). -/
def positionReferenceOf (bookId : BookId) (position : InventoryPostedPosition) :
    InventoryPostedPositionReference :=
  { id := position.holdingId, contentHash := position.contentHash, bookId := bookId,
    effectKey := position.originEffectKey, artifactOrdinal := position.originArtifactOrdinal,
    bookRevision := position.originBookRevision }

/-- The test of lines 1567 and 1647, its operations in the TypeScript's order: the money consumed
between the two positions is not the negated posted amount. -/
def consumedPostedInvalid (after before : InventoryPostedPosition) (postedAmount : ExactDecimal) :
    Except QuantizeErr Bool :=
  match liftExact after.consumedPosted.toRational with
  | .error e => .error e
  | .ok afterPosted =>
    match liftExact before.consumedPosted.toRational with
    | .error e => .error e
    | .ok beforePosted =>
      match liftExact (afterPosted.subtract beforePosted) with
      | .error e => .error e
      | .ok consumed =>
        match liftExact postedAmount.toRational with
        | .error e => .error e
        | .ok amount => .ok (!consumed.equals amount.negate)

/-- The test of lines 1563 to 1569 of a reduction movement that follows another of the same
holding in the effect: another coordinate or anchor, a before-position that is not the previous
after-position, a consumed quantity or money that is not the step, or a proof that does not
continue the previous one. -/
def reductionContinuationInvalid (movement previous : InventoryPostedReductionMovement) :
    Except QuantizeErr Bool :=
  let after := previous.afterPosition
  if !sameOwnershipValue movement.coordinate previous.coordinate ||
      !sameOwnershipValue movement.afterPosition.anchor after.anchor ||
      !sameOwnershipValue movement.beforePosition
        (positionReferenceOf previous.coordinate.bookId after) then .ok true
  else
    match liftExact (movement.afterPosition.consumedQuantity.subtract after.consumedQuantity) with
    | .error e => .error e
    | .ok consumed =>
      if !consumed.equals movement.quantityAllocation.allocatedQuantity then .ok true
      else
        match consumedPostedInvalid movement.afterPosition after movement.postedAmount with
        | .error e => .error e
        | .ok true => .ok true
        | .ok false =>
          .ok (!movement.reductionProof.beforeFraction.equals previous.reductionProof.afterFraction ||
            !sameOwnershipValue movement.reductionProof.postedTotal
              previous.reductionProof.postedTotal ||
            !sameOwnershipValue movement.reductionProof.policy previous.reductionProof.policy)

/-- What the loop of lines 1552 to 1572 carries: the movement and allocation identifiers seen
(newest first), and the last movement of each holding. -/
structure ReductionEffectCheck where
  ids : List InventoryPostedMovementId
  allocations : List LotAllocationId
  current : List (LotHoldingId × InventoryPostedReductionMovement)
  deriving DecidableEq, Repr, Inhabited

/-- The test of lines 1546 and 1547: new anchors, no movement or too many, an effect key or
revision missing, or a carried hash the content does not reproduce. -/
def reductionEffectHeaderInvalid (effect : InventoryReductionOwnershipEffect) : Bool :=
  let count := effect.journalLinkedMovements.length + effect.quantityOnlyMovements.length
  effect.newAnchors.length != 0 || decide (count = 0) || decide (count > cap) ||
    decide (effect.effectKey.value.length = 0) || decide (effect.bookRevision ≤ 0) ||
    !contentHashEquals effect.contentHash
      (hashInventoryReductionOwnershipEffect effect.toInventoryReductionOwnershipEffectBody)

/-- `all` (line 1549): the journal-linked movements, then the quantity-only ones, stably sorted by
ordinal. -/
def reductionEffectMovements (effect : InventoryReductionOwnershipEffect) :
    List InventoryPostedReductionMovement :=
  sortByOrdinal (·.artifactOrdinal)
    (effect.journalLinkedMovements.map .journalLinked ++
      effect.quantityOnlyMovements.map .quantityOnly)

/-- Lines 1553 to 1571 for the movement at `index`: valid (which may throw), at its ordinal, of the
effect, with the first movement's book, date and period, a new movement and allocation, an anchor
from before the effect; then either the first of its holding, with a before-position from before
the effect, or continuing the previous one. `none` is `return false`. -/
def reductionEffectStep (effect : InventoryReductionOwnershipEffect)
    (first : InventoryPostedReductionMovement) (state : ReductionEffectCheck) (index : Nat)
    (movement : InventoryPostedReductionMovement) :
    Except QuantizeErr (Option ReductionEffectCheck) :=
  match ownershipMovementValid movement with
  | .error e => .error e
  | .ok valid =>
    if !valid || movement.artifactOrdinal != ((index + 1 : Nat) : Int) ||
        movement.effectKey != effect.effectKey || movement.bookRevision != effect.bookRevision ||
        movement.coordinate.bookId != first.coordinate.bookId ||
        movement.accountingDate != first.accountingDate ||
        movement.fiscalPeriodId != first.fiscalPeriodId || decide (movement.id ∈ state.ids) ||
        decide (movement.quantityAllocation.id ∈ state.allocations) ||
        decide (movement.afterPosition.anchor.bookRevision ≥ effect.bookRevision) then .ok none
    else
      let next : ReductionEffectCheck :=
        { ids := movement.id :: state.ids,
          allocations := movement.quantityAllocation.id :: state.allocations,
          current := mapSet state.current movement.coordinate.holdingId movement }
      match state.current.lookup movement.coordinate.holdingId with
      | none =>
        if movement.beforePosition.bookRevision ≥ effect.bookRevision then .ok none
        else .ok (some next)
      | some previous =>
        match reductionContinuationInvalid movement previous with
        | .error e => .error e
        | .ok true => .ok none
        | .ok false => .ok (some next)

/-- The loop of lines 1552 to 1572 from the movement at `index`: `true` when every movement
passes. -/
def reductionEffectLoop (effect : InventoryReductionOwnershipEffect)
    (first : InventoryPostedReductionMovement) :
    Nat → ReductionEffectCheck → List InventoryPostedReductionMovement → Except QuantizeErr Bool
  | _, _, [] => .ok true
  | index, state, movement :: rest =>
    match reductionEffectStep effect first state index movement with
    | .error e => .error e
    | .ok none => .ok false
    | .ok (some state') => reductionEffectLoop effect first (index + 1) state' rest

end InventoryOwnershipValidation

open InventoryOwnershipValidation in
/-- `ownershipReductionEffectValid` (line 1544): the header, every movement in ordinal order, then
the ordinals of each list strictly increasing. -/
def ownershipReductionEffectValid (effect : InventoryReductionOwnershipEffect) :
    Except QuantizeErr Bool :=
  if reductionEffectHeaderInvalid effect then .ok false
  else
    match reductionEffectMovements effect with
    | [] => .ok false
    | first :: rest =>
      match reductionEffectLoop effect first 0 { ids := [], allocations := [], current := [] }
          (first :: rest) with
      | .error e => .error e
      | .ok false => .ok false
      | .ok true =>
        .ok (ordinalsIncreasing (effect.journalLinkedMovements.map (·.artifactOrdinal)) &&
          ordinalsIncreasing (effect.quantityOnlyMovements.map (·.artifactOrdinal)))

/-! ## `ownershipEffectValid` (line 1577) -/

/-- An element of `artifacts` (line 1582): an anchor or a movement of the effect. -/
inductive OwnershipEffectArtifact where
  | anchor (anchor : InventoryPostedAnchor)
  | movement (movement : InventoryPostedMovement)
  deriving DecidableEq, Repr, Inhabited

/-- `artifact.ordinal`. -/
def OwnershipEffectArtifact.ordinal : OwnershipEffectArtifact → Int
  | .anchor value => value.artifactOrdinal
  | .movement value => value.artifactOrdinal

namespace InventoryOwnershipValidation

open InventoryOwnership InventoryOwnershipEffects

/-- `movements` (line 1578): the journal-linked movements, then the quantity-only ones. -/
def effectMovements (effect : InventoryOwnershipEffect) : List InventoryPostedMovement :=
  effect.journalLinkedMovements.map (·.toInventoryPostedMovement) ++
    effect.quantityOnlyMovements.map (·.toInventoryPostedMovement)

/-- `artifacts` (lines 1582 and 1583): the anchors, then the movements, stably sorted by
ordinal. -/
def effectArtifacts (effect : InventoryOwnershipEffect) : List OwnershipEffectArtifact :=
  sortByOrdinal OwnershipEffectArtifact.ordinal
    (effect.newAnchors.map .anchor ++ (effectMovements effect).map .movement)

/-- The test of lines 1579 and 1580: too many anchors, no movement or too many, an effect key or
revision missing, or a carried hash the content does not reproduce. -/
def ownershipEffectHeaderInvalid (effect : InventoryOwnershipEffect) : Bool :=
  let count := (effectMovements effect).length
  decide (effect.newAnchors.length > cap) || decide (count = 0) || decide (count > cap) ||
    decide (effect.effectKey.value.length = 0) || decide (effect.bookRevision ≤ 0) ||
    !contentHashEquals effect.contentHash
      (hashInventoryOwnershipEffect effect.toInventoryOwnershipEffectBody)

/-- What the loop of lines 1586 to 1656 carries (lines 1584 and 1585): the anchors by identifier
in insertion order, the new holdings and lots, the anchors used, the last movement of each holding,
and the movement and allocation identifiers seen. A set whose membership alone is read is newest
first. -/
structure OwnershipEffectCheck where
  anchors : List (InventoryPostedAnchorId × InventoryPostedAnchor)
  newHoldings : List LotHoldingId
  newLots : List LotId
  usedAnchors : List InventoryPostedAnchorId
  current : List (LotHoldingId × InventoryPostedMovement)
  ids : List InventoryPostedMovementId
  allocations : List LotAllocationId
  deriving DecidableEq, Repr, Inhabited

/-- Lines 1589 to 1600 for an anchor: valid (which may throw), of the effect, of the first
movement's book, with evidence, new, of a new holding with no movement yet; a successor anchor has
one incoming movement and a lot no other successor has; a first anchor has none. `none` is
`return false`. -/
def effectAnchorStep (effect : InventoryOwnershipEffect) (first : InventoryPostedMovement)
    (state : OwnershipEffectCheck) (anchor : InventoryPostedAnchor) :
    Except QuantizeErr (Option OwnershipEffectCheck) :=
  match ownershipAnchorValid anchor with
  | .error e => .error e
  | .ok valid =>
    if !valid || anchor.effectKey != effect.effectKey || anchor.bookRevision != effect.bookRevision ||
        anchor.coordinate.bookId != first.coordinate.bookId || decide (anchor.evidence.length = 0) ||
        state.anchors.any (fun entry => entry.1 == anchor.id) ||
        decide (anchor.coordinate.holdingId ∈ state.newHoldings) ||
        state.current.any (fun entry => entry.1 == anchor.coordinate.holdingId) then .ok none
    else
      let newLots? : Option (List LotId) :=
        match anchor.predecessorPosition with
        | some _ =>
          if anchor.incomingMovements.length != 1 || decide (anchor.coordinate.lotId ∈ state.newLots)
          then none
          else some (anchor.coordinate.lotId :: state.newLots)
        | none => if anchor.incomingMovements.length != 0 then none else some state.newLots
      match newLots? with
      | none => .ok none
      | some newLots =>
        .ok (some { state with
          newLots := newLots
          anchors := state.anchors ++ [(anchor.id, anchor)]
          newHoldings := anchor.coordinate.holdingId :: state.newHoldings })

/-- The test of lines 1613 and 1614: a component-bearing anchor of an acquisition or adoption must
have no allowance and a basis that is its budget (the conversions may throw). -/
def acquisitionPostedValueInvalid (movement : InventoryPostedAcquisitionMovement)
    (anchor : InventoryPostedAnchor) : Except QuantizeErr Bool :=
  if movement.kind == .transferIn then .ok false
  else
    match anchor.postedValue with
    | none => .ok false
    | some value =>
      if !value.allowance.isZero then .ok true
      else
        match liftExact value.basis.toRational with
        | .error e => .error e
        | .ok basis =>
          match liftExact anchor.postedBudget.toRational with
          | .error e => .error e
          | .ok budget => .ok (!basis.equals budget)

/-- The test of lines 1616 to 1618: a legacy adoption is quantity-only, posts nothing, has a zero
total and a first anchor with no incoming movement. -/
def legacyAdoptionInvalid (movement : InventoryPostedAcquisitionMovement)
    (anchor : InventoryPostedAnchor) : Bool :=
  movement.monetaryKind != .quantityOnly || !movement.postedAmount.isZero ||
    !movement.acquisitionProof.postedTotal.isZero || anchor.predecessorPosition.isSome ||
    anchor.incomingMovements.length != 0

/-- The test of lines 1620 to 1622: the posted amount is not the anchor's budget, the anchor does
not have exactly the one source posting a nonzero total needs (none for a zero total), or a
journal-linked movement's posting is not the anchor's first source posting;
`canonicalize(undefined)` throws when the anchor has none. -/
def acquisitionPostingInvalid (movement : InventoryPostedAcquisitionMovement)
    (anchor : InventoryPostedAnchor) : Except InventoryOwnershipValidationErr Bool :=
  if !sameOwnershipValue movement.postedAmount anchor.postedBudget ||
      anchor.sourcePostings.length !=
        (if movement.acquisitionProof.postedTotal.isZero then 0 else 1) then .ok true
  else
    match movement with
    | .quantityOnly _ => .ok false
    | .journalLinked linked =>
      match anchor.sourcePostings with
      | [] => .error .undefinedValue
      | sourcePosting :: _ => .ok (!sameOwnershipValue sourcePosting linked.posting)

/-- The test of lines 1624 to 1627: a transfer in has a successor anchor with the one incoming
movement that is the movement's one incoming source, and the predecessor holding's last movement in
the effect is that transfer out. -/
def transferInInvalid (current : List (LotHoldingId × InventoryPostedMovement))
    (movement : InventoryPostedAcquisitionMovement) (anchor : InventoryPostedAnchor) : Bool :=
  match anchor.predecessorPosition with
  | none => true
  | some predecessor =>
    match anchor.incomingMovements, movement.incomingSources with
    | [incoming], [source] =>
      !sameOwnershipValue incoming source ||
        (match current.lookup predecessor.id with
          | none => true
          | some transferOut => transferOut.kind != "transferOut" || transferOut.id != source.id)
    | _, _ => true

/-- Lines 1610 to 1632 for an acquisition movement, with the holding's previous movement and the
anchor its after-position names, both in this effect: valid (which may throw), the first of its
holding, of an unused anchor of the same coordinate and policy, then the tests of its kind; then the
anchor is used. `none` is `return false`. -/
def effectAcquisitionStep (state : OwnershipEffectCheck)
    (movement : InventoryPostedAcquisitionMovement) (previous : Option InventoryPostedMovement)
    (anchor? : Option InventoryPostedAnchor) :
    Except InventoryOwnershipValidationErr (Option OwnershipEffectCheck) :=
  match InventoryOwnershipValidationErr.ofQuantize (ownershipAcquisitionMovementValid movement) with
  | .error e => .error e
  | .ok valid =>
    match anchor? with
    | none => .ok none
    | some anchor =>
      if !valid || previous.isSome || decide (anchor.id ∈ state.usedAnchors) ||
          !sameOwnershipValue movement.coordinate anchor.coordinate ||
          !sameOwnershipValue movement.acquisitionProof.policy anchor.quantizationPolicy then
        .ok none
      else
        let next := some { state with usedAnchors := anchor.id :: state.usedAnchors }
        match InventoryOwnershipValidationErr.ofQuantize
            (acquisitionPostedValueInvalid movement anchor) with
        | .error e => .error e
        | .ok true => .ok none
        | .ok false =>
          if movement.kind == .legacyAdoption then
            .ok (if legacyAdoptionInvalid movement anchor then none else next)
          else
            match acquisitionPostingInvalid movement anchor with
            | .error e => .error e
            | .ok true => .ok none
            | .ok false =>
              if movement.kind == .transferIn then
                .ok (if transferInInvalid state.current movement anchor then none else next)
              else
                .ok (if anchor.predecessorPosition.isSome || anchor.incomingMovements.length != 0 ||
                    movement.incomingSources.length != 0 then none else next)

/-- The test of lines 1636 to 1638 of a reduction movement whose anchor is new in this effect: its
proof's total and policy are not the anchor's, or the anchor's quantity times the after fraction
(which may throw) is not the consumed quantity. -/
def reductionAnchorInvalid (movement : InventoryPostedReductionMovement) :
    Option InventoryPostedAnchor → Except QuantizeErr Bool
  | none => .ok false
  | some anchor =>
    let proof := movement.reductionProof
    if !sameOwnershipValue proof.postedTotal anchor.postedBudget ||
        !sameOwnershipValue proof.policy anchor.quantizationPolicy then .ok true
    else
      match liftExact (anchor.quantity.multiply proof.afterFraction) with
      | .error e => .error e
      | .ok consumed => .ok (!consumed.equals movement.afterPosition.consumedQuantity)

/-- The test of lines 1643 to 1650 of a reduction movement that follows another movement of the
same holding in the effect: another coordinate or anchor, a before-position that is not the previous
after-position, a consumed quantity or money that is not the step, or a before fraction that is not
the previous proof's after fraction (zero after an acquisition); after a reduction, the proof's total
and policy are the previous proof's. -/
def effectContinuationInvalid (movement : InventoryPostedReductionMovement)
    (previous : InventoryPostedMovement) : Except QuantizeErr Bool :=
  let before := previous.afterPosition
  let p := movement.afterPosition
  if !sameOwnershipValue movement.coordinate previous.coordinate ||
      !sameOwnershipValue p.anchor before.anchor ||
      !sameOwnershipValue movement.beforePosition
        (positionReferenceOf previous.coordinate.bookId before) then .ok true
  else
    match liftExact (p.consumedQuantity.subtract before.consumedQuantity) with
    | .error e => .error e
    | .ok consumed =>
      if !consumed.equals movement.quantityAllocation.allocatedQuantity then .ok true
      else
        match consumedPostedInvalid p before movement.postedAmount with
        | .error e => .error e
        | .ok true => .ok true
        | .ok false =>
          match previous with
          | .reduction reduction =>
            .ok (!movement.reductionProof.beforeFraction.equals
                reduction.reductionProof.afterFraction ||
              !sameOwnershipValue movement.reductionProof.postedTotal
                reduction.reductionProof.postedTotal ||
              !sameOwnershipValue movement.reductionProof.policy reduction.reductionProof.policy)
          | .acquisition _ =>
            .ok (!movement.reductionProof.beforeFraction.equals ExactRational.zero)

/-- Lines 1634 to 1651 for a reduction movement, with the holding's previous movement and the
anchor its after-position names, both in this effect: valid (which may throw), a new allocation,
the anchor's terms, then either the first of its holding, with a before-position and an anchor from
before the effect, or continuing the previous movement. `none` is `return false`. -/
def effectReductionStep (effect : InventoryOwnershipEffect) (state : OwnershipEffectCheck)
    (movement : InventoryPostedReductionMovement) (previous : Option InventoryPostedMovement)
    (anchor? : Option InventoryPostedAnchor) :
    Except QuantizeErr (Option OwnershipEffectCheck) :=
  match ownershipMovementValid movement with
  | .error e => .error e
  | .ok valid =>
    if !valid || decide (movement.quantityAllocation.id ∈ state.allocations) then .ok none
    else
      let next := { state with allocations := movement.quantityAllocation.id :: state.allocations }
      match reductionAnchorInvalid movement anchor? with
      | .error e => .error e
      | .ok true => .ok none
      | .ok false =>
        match previous with
        | none =>
          if movement.beforePosition.bookRevision ≥ effect.bookRevision ||
              movement.afterPosition.anchor.bookRevision ≥ effect.bookRevision then .ok none
          else .ok (some next)
        | some previous =>
          match effectContinuationInvalid movement previous with
          | .error e => .error e
          | .ok true => .ok none
          | .ok false => .ok (some next)

/-- Lines 1602 to 1655 for a movement: of the effect, with the first movement's book, date and
period, new; agreeing with its anchor when that anchor is new in this effect; then the tests of its
kind; then the last movement of its holding. `none` is `return false`. -/
def effectMovementStep (effect : InventoryOwnershipEffect) (first : InventoryPostedMovement)
    (state : OwnershipEffectCheck) (movement : InventoryPostedMovement) :
    Except InventoryOwnershipValidationErr (Option OwnershipEffectCheck) :=
  let previous := state.current.lookup movement.coordinate.holdingId
  if movement.effectKey != effect.effectKey || movement.bookRevision != effect.bookRevision ||
      movement.coordinate.bookId != first.coordinate.bookId ||
      movement.accountingDate != first.accountingDate ||
      movement.fiscalPeriodId != first.fiscalPeriodId || decide (movement.id ∈ state.ids) then
    .ok none
  else
    let state' := { state with ids := movement.id :: state.ids }
    let anchor? := state.anchors.lookup movement.afterPosition.anchor.id
    if (match anchor? with
        | none => false
        | some anchor => !sameOwnershipValue movement.afterPosition.anchor (anchorReferenceOf anchor) ||
            !sameOwnershipValue movement.coordinate anchor.coordinate) then .ok none
    else
      let step : Except InventoryOwnershipValidationErr (Option OwnershipEffectCheck) :=
        match movement with
        | .acquisition acquisition => effectAcquisitionStep state' acquisition previous anchor?
        | .reduction reduction => InventoryOwnershipValidationErr.ofQuantize
            (effectReductionStep effect state' reduction previous anchor?)
      match step with
      | .error e => .error e
      | .ok none => .ok none
      | .ok (some next) =>
        .ok (some { next with
          current := mapSet next.current movement.coordinate.holdingId movement })

/-- Lines 1587 to 1655 for the artifact at `index`: at its ordinal, then the step of its kind. -/
def effectArtifactStep (effect : InventoryOwnershipEffect) (first : InventoryPostedMovement)
    (state : OwnershipEffectCheck) (index : Nat) (artifact : OwnershipEffectArtifact) :
    Except InventoryOwnershipValidationErr (Option OwnershipEffectCheck) :=
  if artifact.ordinal != ((index + 1 : Nat) : Int) then .ok none
  else
    match artifact with
    | .anchor anchor =>
      InventoryOwnershipValidationErr.ofQuantize (effectAnchorStep effect first state anchor)
    | .movement movement => effectMovementStep effect first state movement

/-- The loop of lines 1586 to 1656 from the artifact at `index`: the state at the end, or `none`
for `return false`. -/
def ownershipEffectLoop (effect : InventoryOwnershipEffect) (first : InventoryPostedMovement) :
    Nat → OwnershipEffectCheck → List OwnershipEffectArtifact →
      Except InventoryOwnershipValidationErr (Option OwnershipEffectCheck)
  | _, state, [] => .ok (some state)
  | index, state, artifact :: rest =>
    match effectArtifactStep effect first state index artifact with
    | .error e => .error e
    | .ok none => .ok none
    | .ok (some state') => ownershipEffectLoop effect first (index + 1) state' rest

/-- The state the loop of line 1586 starts from: everything empty. -/
def ownershipEffectInitial : OwnershipEffectCheck :=
  { anchors := [], newHoldings := [], newLots := [], usedAnchors := [], current := [], ids := [],
    allocations := [] }

end InventoryOwnershipValidation

open InventoryOwnershipValidation in
/-- `ownershipEffectValid` (line 1577): the header, every anchor and movement in ordinal order,
then every anchor used and the ordinals of each list strictly increasing. -/
def ownershipEffectValid (effect : InventoryOwnershipEffect) :
    Except InventoryOwnershipValidationErr Bool :=
  if ownershipEffectHeaderInvalid effect then .ok false
  else
    match effectMovements effect with
    | [] => .ok false
    | first :: _ =>
      match ownershipEffectLoop effect first 0 ownershipEffectInitial (effectArtifacts effect) with
      | .error e => .error e
      | .ok none => .ok false
      | .ok (some state) =>
        .ok (Lots.setSize state.usedAnchors == Lots.setSize (state.anchors.map (·.1)) &&
          ordinalsIncreasing (effect.newAnchors.map (·.artifactOrdinal)) &&
          ordinalsIncreasing (effect.journalLinkedMovements.map
            (·.toInventoryPostedMovement.artifactOrdinal)) &&
          ordinalsIncreasing (effect.quantityOnlyMovements.map
            (·.toInventoryPostedMovement.artifactOrdinal)))

/-! ## `validateInventoryOwnershipArtifact` (line 1667) -/

/-- `validateInventoryOwnershipArtifact` (line 1667): the predicate of the artifact's kind (the
`default` branch is never taken). -/
def validateInventoryOwnershipArtifact :
    (kind : InventoryOwnershipArtifactKind) → InventoryOwnershipArtifactTypes kind →
      Except InventoryOwnershipValidationErr Bool
  | .anchor, artifact =>
    InventoryOwnershipValidationErr.ofQuantize (ownershipAnchorValid artifact)
  | .position, artifact =>
    InventoryOwnershipValidationErr.ofQuantize (ownershipPositionValid artifact)
  | .reductionMovement, artifact =>
    InventoryOwnershipValidationErr.ofQuantize (ownershipMovementValid artifact)
  | .acquisitionMovement, artifact =>
    InventoryOwnershipValidationErr.ofQuantize (ownershipAcquisitionMovementValid artifact)
  | .reductionEffect, artifact =>
    InventoryOwnershipValidationErr.ofQuantize (ownershipReductionEffectValid artifact)
  | .ownershipEffect, artifact => ownershipEffectValid artifact

end Rastrata.Kernel

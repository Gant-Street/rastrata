/-
The model of `packages/kernel/src/inventory-ownership.ts` lines 108 to 543: `reject`, `fullHash`,
`referenceValid`, `precedes`, `postedAnchorVersionValid`, the anchor and position hashes (lines 82
to 91), `prepareInventoryPostedReduction`, the two movement hashes,
`prepareInventoryPostedAcquisitionGroup` and `prepareInventoryPostedReductionGroup`; with
`sameOwnershipValue` (line 1455), which the acquisition group calls and which is therefore here
rather than in `InventoryOwnership/Validation.lean`.

Every definition mirrors one TypeScript member, named in its doc comment, with the same checks in
the same order. A condition the TypeScript writes as one `||` chain is one `Bool` (or, when an
operation in it may throw, an `Except` of a `Bool` that evaluates the chain from the left and
throws only if the throwing operation is reached); the members the TypeScript keeps to itself and
the pieces a loop is cut into are in the namespace `InventoryOwnership`. A diagnostic carries its
code, path, message and requirement identifiers in full. Where the TypeScript throws, the model
returns `.error`: an `ExactNumberError` or the `RangeError` of `quantize` (`QuantizeErr`), or the
`RangeError` of `effectKey` (`EffectKeyErr`) when a journal source's effect key is blank.

Where the model differs from the TypeScript in form:

- `Object.freeze` and `immutableAccountingValue` are not modelled.
- `new Set(values).size` is the length of the deduplicated list (`Lots.setSize`), and
  `Array.prototype.sort` with `compareCanonicalText` is `List.mergeSort` with `jsStringLe`, a stable
  sort by UTF-16 code units.
- `x.length === 0` and `x.length > 0` on a string count UTF-16 code units in the TypeScript and
  characters here; both are zero exactly when the string is empty.
- `/^[0-9a-f]{64}$/.test(digest)` is: 64 characters, each a lower-case hexadecimal digit. A string
  that passes is ASCII, so its UTF-16 length and its character count agree.
- The run-time tests the TypeScript types already guarantee always pass: `anchor.algorithm` is
  `"cumulativePostedInventoryV1"` (line 153) and the group `kind` is one of the two (line 476).
- `Object.hasOwn(anchor, "postedValue")` (line 128) is `postedValue.isSome`: `Option` has one
  `none`, which is the absent property (see the header of `InventoryOwnership/Types.lean`).
- `posting!` (lines 444 and 538) asserts a posting the TypeScript has whenever it is read; where it
  would have none, the model takes `default`. `InventoryOwnership/Reduction.lean` proves that a
  prepared journal-linked movement always carries the actual posting, so the branch is never taken.
-/
import Rastrata.Kernel.InventoryOwnership.Reduction.Canonical

namespace Rastrata.Kernel

/-! ## Errors and results -/

/-- What the functions of this file throw: an `ExactNumberError` of `numeric.ts` or the `RangeError`
of `quantize` (both `QuantizeErr`), or the `RangeError` of `effectKey` (`accounting.ts` line 234) for
a journal source whose effect key is blank. -/
inductive InventoryOwnershipErr where
  | quantize (error : QuantizeErr)
  | effectKey (error : EffectKeyErr)
  deriving DecidableEq, Repr, Inhabited

/-- A `QuantizeErr` as an error of this file. -/
def InventoryOwnershipErr.ofQuantize {α : Type} : Except QuantizeErr α → Except InventoryOwnershipErr α
  | .ok value => .ok value
  | .error e => .error (.quantize e)

/-- The result of `prepareInventoryPostedAcquisitionGroup`: `prepared` with the group, or
`rejected`. -/
inductive InventoryPostedAcquisitionGroupResult where
  | prepared (group : InventoryPostedAcquisitionGroup)
  | rejected (rejection : OwnershipRejection)
  deriving DecidableEq, Repr, Inhabited

/-- The result of `prepareInventoryPostedReductionGroup`: `prepared` with the group, or
`rejected`. -/
inductive InventoryPostedReductionGroupResult where
  | prepared (group : InventoryPostedReductionGroup)
  | rejected (rejection : OwnershipRejection)
  deriving DecidableEq, Repr, Inhabited

namespace InventoryOwnership

/-- A step of a loop or of a stage of a preparation: it goes on with a value, or the function
returns a rejection. -/
inductive OwnershipStep (α : Type) where
  | proceed (value : α)
  | rejected (rejection : OwnershipRejection)
  deriving DecidableEq, Repr, Inhabited

/-! ## Helpers (`inventory-ownership.ts` lines 108 to 130 and 1455) -/

/-- The three requirement identifiers of every rejection of this module. -/
def rejectRequirements : List String := ["ACC-039.7", "ACC-039.8", "ACC-039.9"]

/-- `reject` (line 109): a rejection with one diagnostic, `lot_overallocation`. -/
def reject (path message : String) : OwnershipRejection :=
  ⟨[diagnostic .lot_overallocation path message rejectRequirements]⟩

/-- `fullHash` (line 115): the current algorithm, the current canonicalization, and a digest of
64 lower-case hexadecimal digits. -/
def fullHash (hash : ContentHash) : Bool :=
  hash.algorithm == contentHashAlgorithm &&
    hash.canonicalizationVersion == canonicalizationVersion &&
    hash.digest.length == 64 && hash.digest.toList.all isLowerHexChar

/-- `referenceValid` (line 119). -/
def referenceValid (reference : InventoryPostedArtifactReference) (bookId : BookId) : Bool :=
  decide (reference.id.length > 0) && decide (reference.effectKey.value.length > 0) &&
    reference.bookId == bookId && decide (reference.artifactOrdinal > 0) &&
    decide (reference.bookRevision > 0) && fullHash reference.contentHash

/-- What `precedes` (line 123) reads of an artifact or an origin: `{ effectKey, artifactOrdinal,
bookRevision }`. -/
structure ArtifactOrder where
  effectKey : EffectKey
  artifactOrdinal : Int
  bookRevision : Int
  deriving DecidableEq, Repr, Inhabited

/-- `precedes` (line 123): an earlier revision, or the same revision, the same effect and an
earlier ordinal. -/
def precedes (before after : ArtifactOrder) : Bool :=
  decide (before.bookRevision < after.bookRevision) ||
    (before.bookRevision == after.bookRevision && before.effectKey == after.effectKey &&
      decide (before.artifactOrdinal < after.artifactOrdinal))

/-- `postedAnchorVersionValid` (line 127): version `1.0.0` has no `postedValue`, version `1.1.0` has
one, and no other version is valid. -/
def postedAnchorVersionValid (anchor : InventoryPostedAnchor) : Bool :=
  if anchor.algorithmVersion.value == "1.0.0" then anchor.postedValue.isNone
  else anchor.algorithmVersion.value == "1.1.0" && anchor.postedValue.isSome

/-- `sameOwnershipValue` (line 1455): the two values have the same canonical hash. -/
def sameOwnershipValue {α β : Type} [Canonicalize α] [Canonicalize β] (left : α) (right : β) :
    Bool :=
  contentHashEquals (hashCanonical (canonicalAccountingValue left))
    (hashCanonical (canonicalAccountingValue right))

/-- `new Set(values).size !== values.length`: some value is repeated. -/
def hasDuplicates {α : Type} [DecidableEq α] (values : List α) : Bool :=
  Lots.setSize values != values.length

/-- `ids.some((id, index, ids) => index > 0 && compareCanonicalText(ids[index - 1]!, id) >= 0)`
(lines 186, 377, 603 and 819): some identifier is not after the one before it in UTF-16 order. -/
def dimensionsOutOfOrder : List DimensionMemberId → Bool
  | first :: second :: rest =>
    compareCanonicalText first.value second.value != .lt || dimensionsOutOfOrder (second :: rest)
  | _ => false

/-- `xs.some((x, index) => x !== ys[index])` (lines 491, 521, 614, 660 and 684): at some index of
`xs`, `ys` holds a different value or none (`ys[index]` is then `undefined`). -/
def someDiffersAt {α : Type} [DecidableEq α] : List α → List α → Bool
  | [], _ => false
  | _ :: _, [] => true
  | x :: xs, y :: ys => x != y || someDiffersAt xs ys

/-- `[...values].sort((a, b) => compareCanonicalText(key(a), key(b)))`: a stable sort by the key,
in UTF-16 code unit order. -/
def sortByText {α : Type} (key : α → String) (values : List α) : List α :=
  values.mergeSort fun a b => jsStringLe (key a) (key b)

/-- `[...actual.dimensionMemberIds].sort(compareCanonicalText)` (lines 415, 519, 658 and 682). -/
def sortDimensions (ids : List DimensionMemberId) : List DimensionMemberId :=
  sortByText (·.value) ids

/-- `[...texts].sort(compareCanonicalText)` (line 396). -/
def sortTexts (texts : List String) : List String := sortByText id texts

/-- `ACCOUNTING_LIMITS.maxInventoryLayers`, the bound of every population of this module. -/
abbrev cap : Nat := accountingLimits.maxInventoryLayers

end InventoryOwnership

/-! ## Hashes (`inventory-ownership.ts` lines 82 to 91, 268 and 327) -/

/-- `hashInventoryPostedAnchor` (line 82): `hashCanonical({ type: "InventoryPostedAnchor", value:
canonicalAccountingValue(body) })` of the anchor without its `contentHash`, which is
`accountingHash`. -/
def hashInventoryPostedAnchor (anchor : InventoryPostedAnchorBody) : ContentHash :=
  accountingHash "InventoryPostedAnchor" anchor

/-- `hashInventoryPostedPosition` (line 87). -/
def hashInventoryPostedPosition (position : InventoryPostedPositionBody) : ContentHash :=
  accountingHash "InventoryPostedPosition" position

/-- `hashInventoryPostedReductionMovement` (line 268). -/
def hashInventoryPostedReductionMovement (movement : MovementHashInput) : ContentHash :=
  accountingHash "InventoryPostedMovement" movement

/-- `hashInventoryPostedAcquisitionMovement` (line 327). -/
def hashInventoryPostedAcquisitionMovement (movement : InventoryPostedAcquisitionMovementHashInput) :
    ContentHash :=
  accountingHash "InventoryPostedMovement" movement

/-! ## What `precedes` reads of each artifact -/

/-- The order of a reference. -/
def InventoryPostedArtifactReference.artifactOrder (reference : InventoryPostedArtifactReference) :
    InventoryOwnership.ArtifactOrder :=
  ⟨reference.effectKey, reference.artifactOrdinal, reference.bookRevision⟩

/-- The order of an anchor reference. -/
def InventoryPostedAnchorReference.artifactOrder (reference : InventoryPostedAnchorReference) :
    InventoryOwnership.ArtifactOrder :=
  ⟨reference.effectKey, reference.artifactOrdinal, reference.bookRevision⟩

/-- The order of a position reference. -/
def InventoryPostedPositionReference.artifactOrder (reference : InventoryPostedPositionReference) :
    InventoryOwnership.ArtifactOrder :=
  ⟨reference.effectKey, reference.artifactOrdinal, reference.bookRevision⟩

/-- The order of a movement reference. -/
def InventoryPostedMovementReference.artifactOrder (reference : InventoryPostedMovementReference) :
    InventoryOwnership.ArtifactOrder :=
  ⟨reference.effectKey, reference.artifactOrdinal, reference.bookRevision⟩

/-- The order of a reduction origin. -/
def InventoryPostedReductionOrigin.artifactOrder (origin : InventoryPostedReductionOrigin) :
    InventoryOwnership.ArtifactOrder :=
  ⟨origin.effectKey, origin.artifactOrdinal, origin.bookRevision⟩

/-- The order of an anchor. -/
def InventoryPostedAnchor.artifactOrder (anchor : InventoryPostedAnchor) :
    InventoryOwnership.ArtifactOrder :=
  ⟨anchor.effectKey, anchor.artifactOrdinal, anchor.bookRevision⟩

/-- The order of a reduction movement. -/
def InventoryPostedReductionMovement.artifactOrder (movement : InventoryPostedReductionMovement) :
    InventoryOwnership.ArtifactOrder :=
  ⟨movement.effectKey, movement.artifactOrdinal, movement.bookRevision⟩

/-- The order of an acquisition movement. -/
def InventoryPostedAcquisitionMovement.artifactOrder (movement : InventoryPostedAcquisitionMovement) :
    InventoryOwnership.ArtifactOrder :=
  ⟨movement.effectKey, movement.artifactOrdinal, movement.bookRevision⟩

/-! ## The checks of `prepareInventoryPostedReduction` (lines 147 to 207) -/

namespace InventoryOwnership

/-- `sourceCount` (line 149): the anchor's source postings, incoming movements, evidence, and its
predecessor position if it has one. -/
def anchorSourceCount (anchor : InventoryPostedAnchor) : Nat :=
  anchor.sourcePostings.length + anchor.incomingMovements.length + anchor.evidence.length +
    (match anchor.predecessorPosition with
      | none => 0
      | some _ => 1)

/-- The test of line 150: a population over the bound. -/
def reductionPopulationExceeded (anchor : InventoryPostedAnchor) : Bool :=
  decide (anchorSourceCount anchor > cap) ||
    decide (anchor.coordinate.dimensionMemberIds.length > cap)

/-- The test of lines 153 to 155 (the algorithm test always passes): an unsupported version, or a
carried hash of the anchor or of the position that its content does not reproduce. -/
def reductionHashInvalid (anchor : InventoryPostedAnchor) (position : InventoryPostedPosition) :
    Bool :=
  !postedAnchorVersionValid anchor ||
    !contentHashEquals anchor.contentHash
      (hashInventoryPostedAnchor anchor.toInventoryPostedAnchorBody) ||
    !contentHashEquals position.contentHash
      (hashInventoryPostedPosition position.toInventoryPostedPositionBody)

/-- `anchorReference` (line 158): the reference to the anchor, in the coordinate's book. -/
def anchorReferenceOf (anchor : InventoryPostedAnchor) : InventoryPostedAnchorReference :=
  { id := anchor.id, contentHash := anchor.contentHash, bookId := anchor.coordinate.bookId,
    effectKey := anchor.effectKey, artifactOrdinal := anchor.artifactOrdinal,
    bookRevision := anchor.bookRevision }

/-- `beforePosition` (line 162): the reference to the position, at its origin. -/
def beforePositionOf (anchor : InventoryPostedAnchor) (position : InventoryPostedPosition) :
    InventoryPostedPositionReference :=
  { id := position.holdingId, contentHash := position.contentHash,
    bookId := anchor.coordinate.bookId, effectKey := position.originEffectKey,
    artifactOrdinal := position.originArtifactOrdinal, bookRevision := position.originBookRevision }

/-- The test of lines 166 to 170: the anchor, the position's anchor and the position are not valid
references in the coordinate's book, the policy hash is not full, an origin field is missing, the
origin movement is the position's own, the anchor, the position and the origin are not in order,
or the position does not bind the exact anchor. -/
def reductionLineageInvalid (anchor : InventoryPostedAnchor) (position : InventoryPostedPosition)
    (origin : InventoryPostedReductionOrigin) : Bool :=
  let bookId := anchor.coordinate.bookId
  let anchorReference := anchorReferenceOf anchor
  let beforePosition := beforePositionOf anchor position
  !referenceValid anchorReference.toInventoryPostedArtifactReference bookId ||
    !referenceValid position.anchor.toInventoryPostedArtifactReference bookId ||
    !referenceValid beforePosition.toInventoryPostedArtifactReference bookId ||
    !fullHash anchor.inventoryPolicy.policyContentHash ||
    decide (position.originMovementId.value.length = 0) ||
    decide (origin.movementId.value.length = 0) || decide (origin.effectKey.value.length = 0) ||
    decide (origin.artifactOrdinal ≤ 0) || decide (origin.bookRevision ≤ 0) ||
    position.originMovementId == origin.movementId ||
    !precedes anchorReference.artifactOrder beforePosition.artifactOrder ||
    !precedes beforePosition.artifactOrder origin.artifactOrder ||
    !contentHashEquals (hashCanonical (canonicalAccountingValue position.anchor))
      (hashCanonical (canonicalAccountingValue anchorReference))

/-- `sourceReferences` (line 173): the incoming movements, then the predecessor position. -/
def anchorSourceReferences (anchor : InventoryPostedAnchor) : List InventoryPostedArtifactReference :=
  anchor.incomingMovements.map (·.toInventoryPostedArtifactReference) ++
    (match anchor.predecessorPosition with
      | none => []
      | some reference => [reference.toInventoryPostedArtifactReference])

/-- The test of lines 174 to 180: no source, or a source reference that is not valid in the book
or not before the anchor, a repeated incoming movement, a source posting of another book or with a
hash that does not check, a repeated posting, evidence without a full hash, or repeated evidence. -/
def reductionSourcesInvalid (anchor : InventoryPostedAnchor) : Bool :=
  let bookId := anchor.coordinate.bookId
  decide (anchorSourceCount anchor = 0) ||
    (anchorSourceReferences anchor).any (fun reference =>
      !referenceValid reference bookId ||
        !precedes reference.artifactOrder (anchorReferenceOf anchor).artifactOrder) ||
    hasDuplicates (anchor.incomingMovements.map (·.id)) ||
    anchor.sourcePostings.any (fun reference =>
      reference.bookId != bookId || !validateCanonicalPostingReferenceHash reference) ||
    hasDuplicates (anchor.sourcePostings.map (·.postingId)) ||
    anchor.evidence.any (fun evidence => !fullHash evidence.contentHash) ||
    hasDuplicates (anchor.evidence.map (·.id))

/-- The test of lines 183 to 186: the holding, the position and the coordinate disagree, the policy
is of another book or currency, or the dimensions are not strictly increasing. -/
def reductionCoordinateInvalid (anchor : InventoryPostedAnchor) (position : InventoryPostedPosition)
    (holding : LotHolding) : Bool :=
  let c := anchor.coordinate
  c.holdingId != holding.id || position.holdingId != holding.id || c.bookId != holding.bookId ||
    c.lotId != holding.lotId || c.accountId != holding.accountId ||
    c.unitsCommodityId != holding.commodityId ||
    c.functionalCommodityId != holding.basisCommodityId ||
    anchor.quantizationPolicy.bookId != c.bookId ||
    anchor.quantizationPolicy.functionalCommodityId != c.functionalCommodityId ||
    dimensionsOutOfOrder c.dimensionMemberIds

/-- The test of lines 189 to 191, evaluated from the left: the anchor quantity is not positive, the
consumed quantity is negative or over it, the holding does not hold the rest, the allocation is of
another holding or lot, or it is not positive or over the holding. The subtraction of line 190
throws only if it is reached. -/
def reductionQuantityInvalid (anchor : InventoryPostedAnchor) (position : InventoryPostedPosition)
    (holding : LotHolding) (allocation : LotAllocation) : Except QuantizeErr Bool :=
  if anchor.quantity.compare ExactRational.zero != .gt || position.consumedQuantity.isNegative ||
      position.consumedQuantity.compare anchor.quantity == .gt then .ok true
  else
    match liftExact (anchor.quantity.subtract position.consumedQuantity) with
    | .error e => .error e
    | .ok unconsumed =>
      .ok (!holding.remainingQuantity.equals unconsumed || allocation.holdingId != holding.id ||
        allocation.lotId != holding.lotId ||
        allocation.allocatedQuantity.compare ExactRational.zero != .gt ||
        allocation.allocatedQuantity.compare holding.remainingQuantity == .gt)

/-- The test of lines 204 to 206, evaluated from the left: a negative basis, a positive allowance,
a negative carrying amount, a carrying amount that is not basis plus allowance, or an allocation
whose basis, allowance or carrying amount is not the holding's share. The addition of line 205
throws only if it is reached. -/
def reductionAllocationInvalid (holding : LotHolding) (allocation : LotAllocation)
    (basis allowance carrying : ExactRational) : Except QuantizeErr Bool :=
  if holding.remainingTotalBasis.isNegative ||
      (!holding.remainingValuationAllowance.isZero &&
        !holding.remainingValuationAllowance.isNegative) ||
      holding.remainingCarryingAmount.isNegative then .ok true
  else
    match liftExact (holding.remainingTotalBasis.add holding.remainingValuationAllowance) with
    | .error e => .error e
    | .ok sum =>
      .ok (!holding.remainingCarryingAmount.equals sum ||
        !allocation.allocatedTotalBasis.equals basis ||
        !allocation.allocatedValuationAllowance.equals allowance ||
        !allocation.allocatedCarryingAmount.equals carrying)

/-- `afterBody` (line 209): the position after the reduction, without its hash. -/
def reductionAfterBody (anchor : InventoryPostedAnchor) (holding : LotHolding)
    (origin : InventoryPostedReductionOrigin) (consumedQuantity : ExactRational)
    (planned : PolicyCumulativePostedShare) : InventoryPostedPositionBody :=
  { holdingId := holding.id, consumedQuantity, consumedPosted := planned.afterQuantization.amount,
    anchor := anchorReferenceOf anchor, originMovementId := origin.movementId,
    originEffectKey := origin.effectKey, originArtifactOrdinal := origin.artifactOrdinal,
    originBookRevision := origin.bookRevision }

/-- The record `reduction` (lines 223 to 232), its fields evaluated in the order written:
`postedAmount`, then the four remaining amounts of `afterHolding`, then `postedMinusEconomic`. -/
def reductionRecord (anchor : InventoryPostedAnchor) (position : InventoryPostedPosition)
    (holding : LotHolding) (allocation : LotAllocation) (planned : PolicyCumulativePostedShare)
    (afterBody : InventoryPostedPositionBody) (basis allowance carrying : ExactRational)
    (postedValue : Option InventoryPostedValueAllocation) :
    Except QuantizeErr InventoryPostedReduction :=
  match liftExact (ExactDecimal.of (-planned.postedAmount.coefficient) planned.postedAmount.scale) with
  | .error e => .error e
  | .ok postedAmount =>
    match liftExact (holding.remainingQuantity.subtract allocation.allocatedQuantity) with
    | .error e => .error e
    | .ok remainingQuantity =>
      match liftExact (holding.remainingTotalBasis.subtract basis) with
      | .error e => .error e
      | .ok remainingTotalBasis =>
        match liftExact (holding.remainingValuationAllowance.subtract allowance) with
        | .error e => .error e
        | .ok remainingValuationAllowance =>
          match liftExact (holding.remainingCarryingAmount.subtract carrying) with
          | .error e => .error e
          | .ok remainingCarryingAmount =>
            match liftExact planned.postedAmount.toRational with
            | .error e => .error e
            | .ok posted =>
              match liftExact (posted.subtract carrying) with
              | .error e => .error e
              | .ok postedMinusEconomic =>
                let afterHolding : LotHolding :=
                  { holding with
                    remainingQuantity := remainingQuantity
                    remainingTotalBasis := remainingTotalBasis
                    remainingValuationAllowance := remainingValuationAllowance
                    remainingCarryingAmount := remainingCarryingAmount }
                .ok
                  { monetaryKind := if planned.postedAmount.isZero then .quantityOnly
                      else .journalLinked
                    postedAmount := postedAmount
                    beforePosition := beforePositionOf anchor position
                    afterPosition := ⟨afterBody, hashInventoryPostedPosition afterBody⟩
                    afterHolding := afterHolding
                    allocation := allocation
                    reductionProof := planned
                    postedMinusEconomic := postedMinusEconomic
                    postedValue := postedValue }

/-! ### The rejections of `prepareInventoryPostedReduction`, in the order of the TypeScript -/

/-- Line 151. -/
def reductionAnchorRejection : OwnershipRejection :=
  reject "inventoryOwnership.anchor" "Posted ownership source populations exceed the per-artifact bound"

/-- Line 156. -/
def reductionHashRejection : OwnershipRejection :=
  reject "inventoryOwnership.hash"
    "Posted ownership requires the supported algorithm and reproducible full anchor/position hashes"

/-- Line 171. -/
def reductionLineageRejection : OwnershipRejection :=
  reject "inventoryOwnership.lineage"
    "Posted ownership must bind the exact anchor and strictly earlier same-book artifact origins"

/-- Line 181. -/
def reductionSourcesRejection : OwnershipRejection :=
  reject "inventoryOwnership.sources"
    "Posted ownership source references must be unique, same-book and structurally coherent; their existence still requires authentication"

/-- Line 187. -/
def reductionCoordinateRejection : OwnershipRejection :=
  reject "inventoryOwnership.coordinate"
    "Holding and ownership book, lot, account, commodity and canonical dimension coordinates must agree without currency substitution"

/-- Line 192. -/
def reductionQuantityRejection : OwnershipRejection :=
  reject "inventoryOwnership.quantity"
    "Positive reduction must fit the exact holding and the anchor's cumulative quantity position"

/-- Line 198. -/
def reductionConsumedPostedRejection : OwnershipRejection :=
  reject "inventoryOwnership.consumedPosted"
    "Recorded posted consumption must equal the pinned anchor's cumulative quantized target"

/-- Line 207. -/
def reductionAllocationRejection : OwnershipRejection :=
  reject "inventoryOwnership.allocation"
    "Economic allocation must preserve the holding's separate exact basis, allowance and carrying amount"

/-- Line 219. -/
def reductionPostedValueRejection : OwnershipRejection :=
  reject "inventoryOwnership.postedValue"
    "Posted components must equal the authenticated anchor's net budget"

/-- Lines 214 to 222: the posted components of a component-bearing anchor, allocated over the
planned fractions, whose carrying total must be the anchor's budget; nothing for an anchor without
components. -/
def reductionPostedValue (anchor : InventoryPostedAnchor) (planned : PolicyCumulativePostedShare) :
    Except QuantizeErr (OwnershipStep (Option InventoryPostedValueAllocation)) :=
  match anchor.postedValue with
  | none => .ok (.proceed none)
  | some budget =>
    match allocateInventoryPostedValue budget planned.beforeFraction planned.afterFraction
        anchor.quantizationPolicy with
    | .error e => .error e
    | .ok (.rejected rejection) => .ok (.rejected ⟨rejection.diagnostics⟩)
    | .ok (.allocated values) =>
      match liftExact values.carryingProof.postedTotal.toRational with
      | .error e => .error e
      | .ok carryingTotal =>
        match liftExact anchor.postedBudget.toRational with
        | .error e => .error e
        | .ok budgetTotal =>
          if !carryingTotal.equals budgetTotal then .ok (.rejected reductionPostedValueRejection)
          else .ok (.proceed (some values))

/-- Lines 200 to 233, after the recorded consumption is checked: the holding's exact share of the
allocation, its test, the posted components, and the record. -/
def reductionEconomics (anchor : InventoryPostedAnchor) (position : InventoryPostedPosition)
    (holding : LotHolding) (allocation : LotAllocation) (origin : InventoryPostedReductionOrigin)
    (consumedQuantity : ExactRational) (planned : PolicyCumulativePostedShare) :
    Except QuantizeErr ReductionResult :=
  match liftExact (allocation.allocatedQuantity.divide holding.remainingQuantity) with
  | .error e => .error e
  | .ok fraction =>
    match liftExact (holding.remainingTotalBasis.multiply fraction) with
    | .error e => .error e
    | .ok basis =>
      match liftExact (holding.remainingValuationAllowance.multiply fraction) with
      | .error e => .error e
      | .ok allowance =>
        match liftExact (basis.add allowance) with
        | .error e => .error e
        | .ok carrying =>
          match reductionAllocationInvalid holding allocation basis allowance carrying with
          | .error e => .error e
          | .ok true => .ok (.rejected reductionAllocationRejection)
          | .ok false =>
            let afterBody := reductionAfterBody anchor holding origin consumedQuantity planned
            match reductionPostedValue anchor planned with
            | .error e => .error e
            | .ok (.rejected rejection) => .ok (.rejected rejection)
            | .ok (.proceed postedValue) =>
              match reductionRecord anchor position holding allocation planned afterBody basis
                  allowance carrying postedValue with
              | .error e => .error e
              | .ok reduction => .ok (.prepared reduction)

/-- Lines 194 to 233, after the six tests: the consumed quantity, the planned cumulative share, the
test of the recorded consumption, and the rest. -/
def reductionPlanned (anchor : InventoryPostedAnchor) (position : InventoryPostedPosition)
    (holding : LotHolding) (allocation : LotAllocation) (origin : InventoryPostedReductionOrigin) :
    Except QuantizeErr ReductionResult :=
  match liftExact (position.consumedQuantity.add allocation.allocatedQuantity) with
  | .error e => .error e
  | .ok consumedQuantity =>
    match liftExact (position.consumedQuantity.divide anchor.quantity) with
    | .error e => .error e
    | .ok beforeFraction =>
      match liftExact (consumedQuantity.divide anchor.quantity) with
      | .error e => .error e
      | .ok afterFraction =>
        match anchor.quantizationPolicy.quantizeCumulativePostedShare anchor.postedBudget
            beforeFraction afterFraction with
        | .error e => .error e
        | .ok (.rejected diagnostics) => .ok (.rejected ⟨diagnostics⟩)
        | .ok (.quantized planned) =>
          match liftExact position.consumedPosted.toRational with
          | .error e => .error e
          | .ok recorded =>
            match liftExact planned.beforeQuantization.amount.toRational with
            | .error e => .error e
            | .ok target =>
              if !recorded.equals target then .ok (.rejected reductionConsumedPostedRejection)
              else reductionEconomics anchor position holding allocation origin consumedQuantity
                planned

end InventoryOwnership

open InventoryOwnership in
/-- `prepareInventoryPostedReduction` (line 140): one already-selected reduction of a holding, its
checks in the TypeScript's order, then the planned share and the record. -/
def prepareInventoryPostedReduction (anchor : InventoryPostedAnchor)
    (position : InventoryPostedPosition) (holding : LotHolding) (allocation : LotAllocation)
    (origin : InventoryPostedReductionOrigin) : Except QuantizeErr ReductionResult :=
  if reductionPopulationExceeded anchor then .ok (.rejected reductionAnchorRejection)
  else if reductionHashInvalid anchor position then .ok (.rejected reductionHashRejection)
  else if reductionLineageInvalid anchor position origin then
    .ok (.rejected reductionLineageRejection)
  else if reductionSourcesInvalid anchor then .ok (.rejected reductionSourcesRejection)
  else if reductionCoordinateInvalid anchor position holding then
    .ok (.rejected reductionCoordinateRejection)
  else
    match reductionQuantityInvalid anchor position holding allocation with
    | .error e => .error e
    | .ok true => .ok (.rejected reductionQuantityRejection)
    | .ok false => reductionPlanned anchor position holding allocation origin

/-! ## `prepareInventoryPostedAcquisitionGroup` (lines 358 to 448) -/

namespace InventoryOwnership

/-- `journalLink?.source.journal.postings.length ?? 0`. -/
def linkPostingCount : Option InventoryPostedJournalLink → Nat
  | none => 0
  | some link => link.source.journal.postings.length

/-- The evidence test of lines 394 and 395 (and 625, 626, 832 and 833): no evidence, an item
without an identifier or a full hash, or a repeated identifier. -/
def evidenceInvalid (evidence : List SourceEvidence) : Bool :=
  decide (evidence.length = 0) ||
    evidence.any (fun item => decide (item.id.value.length = 0) || !fullHash item.contentHash) ||
    hasDuplicates (evidence.map (·.id))

/-- Line 365. -/
def acquisitionPopulationRejection : OwnershipRejection :=
  reject "inventoryOwnership.acquisition"
    "Acquisition inputs must fit bounded nonempty group and source populations"

/-- Line 370. -/
def acquisitionEvidenceRejection : OwnershipRejection :=
  reject "inventoryOwnership.acquisition" "Acquisition evidence exceeds the combined work bound"

/-- Line 378. -/
def acquisitionIdentityRejection : OwnershipRejection :=
  reject "inventoryOwnership.acquisitionIdentity"
    "Acquisition requires unique local identities, canonical dimensions and pinned policy/origin metadata"

/-- Line 397. -/
def acquisitionSourceRejection : OwnershipRejection :=
  reject "inventoryOwnership.acquisitionSource"
    "New lots require coherent positive quantities, same-coordinate exact economic values and complete evidence identities"

/-- Line 403. -/
def acquisitionUnpostedRejection : OwnershipRejection :=
  reject "inventoryOwnership.acquisitionPosting"
    "A nonzero acquisition carrying target requires its actual admitted posting"

/-- Line 409. -/
def acquisitionJournalRejection : OwnershipRejection :=
  reject "inventoryOwnership.acquisitionJournal"
    "Acquisition journal must match the candidate's book, origin, date, period and complete hash"

/-- Line 417. -/
def acquisitionPostingRejection : OwnershipRejection :=
  reject "inventoryOwnership.acquisitionPosting"
    "One actual positive inventory posting must cover the group's full coordinate, units and historical basis"

/-- The test of line 364. -/
def acquisitionPopulationInvalid (context : InventoryPostedAcquisitionContext)
    (entries : List InventoryPostedAcquisitionEntry)
    (journalLink : Option InventoryPostedJournalLink) : Bool :=
  decide (entries.length = 0) || decide (entries.length > cap) ||
    decide (context.dimensionMemberIds.length > cap) || decide (linkPostingCount journalLink > cap)

/-- The loop of lines 367 to 371 from the `work` counted so far: the running count of evidence and
lot evidence identifiers passes the bound at some entry. -/
def acquisitionEvidenceExceeded : Nat → List InventoryPostedAcquisitionEntry → Bool
  | _, [] => false
  | work, entry :: rest =>
    let next := work + (entry.evidence.length + entry.lot.evidenceIds.length)
    decide (next > cap) || acquisitionEvidenceExceeded next rest

/-- The test of lines 372 to 377. -/
def acquisitionIdentityInvalid (context : InventoryPostedAcquisitionContext)
    (entries : List InventoryPostedAcquisitionEntry) : Bool :=
  decide (context.bookRevision ≤ 0) || decide (context.firstArtifactOrdinal ≤ 0) ||
    decide (context.effectKey.value.length = 0) || decide (context.commandId.value.length = 0) ||
    decide (context.inventoryPolicy.policyId.value.length = 0) ||
    decide (context.inventoryPolicy.policyVersion.value.length = 0) ||
    !fullHash context.inventoryPolicy.policyContentHash ||
    context.quantizationPolicy.bookId != context.bookId ||
    hasDuplicates (entries.map (·.holding.id)) || hasDuplicates (entries.map (·.lot.id)) ||
    hasDuplicates (entries.map (·.anchorId)) || hasDuplicates (entries.map (·.movementId)) ||
    dimensionsOutOfOrder context.dimensionMemberIds

/-- The test of lines 386 to 396 for one entry, evaluated from the left; the addition of line 393
throws only if it is reached. -/
def acquisitionSourceInvalid (context : InventoryPostedAcquisitionContext) (first : LotHolding)
    (entry : InventoryPostedAcquisitionEntry) : Except QuantizeErr Bool :=
  let lot := entry.lot
  let h := entry.holding
  let policy := context.quantizationPolicy
  if decide (entry.anchorId.value.length = 0) || decide (entry.movementId.value.length = 0) ||
      decide (lot.id.value.length = 0) || decide (h.id.value.length = 0) ||
      lot.bookId != context.bookId || h.bookId != context.bookId || h.lotId != lot.id ||
      h.accountId != first.accountId || h.commodityId != first.commodityId ||
      lot.commodityId != h.commodityId || h.basisCommodityId != policy.functionalCommodityId ||
      lot.basisCommodityId != h.basisCommodityId ||
      lot.acquisitionQuantity.compare ExactRational.zero != .gt ||
      lot.acquisitionTotalBasis.isNegative ||
      !h.remainingQuantity.equals lot.acquisitionQuantity ||
      !h.remainingTotalBasis.equals lot.acquisitionTotalBasis ||
      h.remainingValuationAllowance.compare ExactRational.zero == .gt ||
      h.remainingCarryingAmount.isNegative then .ok true
  else
    match liftExact (h.remainingTotalBasis.add h.remainingValuationAllowance) with
    | .error e => .error e
    | .ok sum =>
      .ok (!h.remainingCarryingAmount.equals sum || evidenceInvalid entry.evidence ||
        !sameOwnershipValue (sortTexts lot.evidenceIds)
          (sortTexts (entry.evidence.map (·.id.value))))

/-- The loop of lines 384 to 400 with the running `quantity`, `basis` and `carrying`: each entry
is tested, then its holding is added. -/
def acquisitionSourceLoop (context : InventoryPostedAcquisitionContext) (first : LotHolding) :
    ExactRational → ExactRational → ExactRational → List InventoryPostedAcquisitionEntry →
      Except QuantizeErr (OwnershipStep (ExactRational × ExactRational × ExactRational))
  | quantity, basis, carrying, [] => .ok (.proceed (quantity, basis, carrying))
  | quantity, basis, carrying, entry :: rest =>
    match acquisitionSourceInvalid context first entry with
    | .error e => .error e
    | .ok true => .ok (.rejected acquisitionSourceRejection)
    | .ok false =>
      match liftExact (quantity.add entry.holding.remainingQuantity) with
      | .error e => .error e
      | .ok quantity' =>
        match liftExact (basis.add entry.holding.remainingTotalBasis) with
        | .error e => .error e
        | .ok basis' =>
          match liftExact (carrying.add entry.holding.remainingCarryingAmount) with
          | .error e => .error e
          | .ok carrying' => acquisitionSourceLoop context first quantity' basis' carrying' rest

/-- The test of lines 406 to 408: the journal source is not this command's, revision's, period's,
book's, currency's or date's, its effect key is empty or the candidate's own, or its hash does not
check. -/
def acquisitionJournalMismatch (context : InventoryPostedAcquisitionContext)
    (source : InventoryReductionJournalSource) : Bool :=
  source.commandId != context.commandId || source.bookRevision != context.bookRevision ||
    source.fiscalPeriodId != context.fiscalPeriodId || source.journal.bookId != context.bookId ||
    source.journal.functionalCommodityId != context.quantizationPolicy.functionalCommodityId ||
    source.journal.accountingDate != context.accountingDate ||
    decide (source.effectKey.length = 0) || source.effectKey == context.effectKey.value ||
    !contentHashEquals source.canonicalHash (hashCanonical (canonicalJournalValue source.journal))

/-- The test of lines 412 to 416 of the one matching posting, evaluated from the left; the
conversion of line 416 throws only if it is reached. (The tests `matches.length !== 1` and
`actual === undefined` are the caller's match.) -/
def acquisitionPostingInvalid (context : InventoryPostedAcquisitionContext) (first : LotHolding)
    (quantity basis carrying : ExactRational) (actual : Posting) : Except QuantizeErr Bool :=
  let policy := context.quantizationPolicy
  if actual.accountId != first.accountId || actual.units.commodityId != first.commodityId ||
      actual.bookValue.functionalCommodityId != policy.functionalCommodityId ||
      !actual.units.canonicalNumber.equals quantity ||
      (match actual.costBasis with
        | none => true
        | some costBasis => costBasis.basisCommodityId != policy.functionalCommodityId ||
            !costBasis.totalBasis.equals basis) ||
      !sameOwnershipValue (sortDimensions actual.dimensionMemberIds) context.dimensionMemberIds then
    .ok true
  else
    match liftExact actual.bookValue.amount.toRational with
    | .error e => .error e
    | .ok amount => .ok (amount.compare ExactRational.zero != .gt || carrying.isZero)

/-- Lines 401 to 421: the posted amount and the posting reference of the group. Without a journal
link the carrying amount must quantize to zero and the posted amount is zero; with one, the journal
and its one matching posting must cover the group, and the posted amount is the posting's. -/
def acquisitionPosting (context : InventoryPostedAcquisitionContext) (first : LotHolding)
    (journalLink : Option InventoryPostedJournalLink) (quantity basis carrying : ExactRational) :
    Except InventoryOwnershipErr (OwnershipStep (ExactDecimal × Option CanonicalPostingReference)) :=
  let policy := context.quantizationPolicy
  match InventoryOwnershipErr.ofQuantize (liftExact (ExactDecimal.of 0 policy.targetScale)) with
  | .error e => .error e
  | .ok zeroPosted =>
    match journalLink with
    | none =>
      match InventoryOwnershipErr.ofQuantize (quantize carrying policy.rule) with
      | .error e => .error e
      | .ok target =>
        if !target.amount.isZero then .ok (.rejected acquisitionUnpostedRejection)
        else .ok (.proceed (zeroPosted, none))
    | some link =>
      if acquisitionJournalMismatch context link.source then
        .ok (.rejected acquisitionJournalRejection)
      else
        match link.source.journal.postings.filter (fun p => p.id == link.postingId) with
        | [actual] =>
          match InventoryOwnershipErr.ofQuantize
              (acquisitionPostingInvalid context first quantity basis carrying actual) with
          | .error e => .error e
          | .ok true => .ok (.rejected acquisitionPostingRejection)
          | .ok false =>
            match effectKey link.source.effectKey with
            | .error e => .error (.effectKey e)
            | .ok key =>
              .ok (.proceed (actual.bookValue.amount,
                some (createCanonicalPostingReference link.referenceId context.bookId
                  link.source.journal.id actual key)))
        | _ => .ok (.rejected acquisitionPostingRejection)

/-- `anchorBody` (line 430) of the entry at `index`, with its share and the group's posting. -/
def acquisitionAnchorBody (context : InventoryPostedAcquisitionContext)
    (entry : InventoryPostedAcquisitionEntry) (index : Nat) (share : PolicyCumulativePostedShare)
    (posting : Option CanonicalPostingReference) : InventoryPostedAnchorBody :=
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
    predecessorPosition := none, sourcePostings := posting.toList, incomingMovements := [],
    evidence := entry.evidence }

/-- The reference to an anchor in the group's book (lines 439, 743 and 862). -/
def groupAnchorReference (bookId : BookId) (anchor : InventoryPostedAnchor) :
    InventoryPostedAnchorReference :=
  { id := anchor.id, contentHash := anchor.contentHash, bookId, effectKey := anchor.effectKey,
    artifactOrdinal := anchor.artifactOrdinal, bookRevision := anchor.bookRevision }

/-- An acquisition movement from its body (lines 444, 756 and 870): quantity-only when its posted
amount is zero, journal-linked to the posting otherwise (`posting!`), and its hash. -/
def acquisitionMovementOf (body : InventoryPostedAcquisitionMovementBody)
    (posting : Option CanonicalPostingReference) : InventoryPostedAcquisitionMovement :=
  if body.postedAmount.isZero then
    .quantityOnly ⟨body, hashInventoryPostedAcquisitionMovement (.quantityOnly body)⟩
  else
    let linked : JournalLinkedInventoryAcquisitionMovementBody := ⟨body, posting.getD default⟩
    .journalLinked ⟨linked, hashInventoryPostedAcquisitionMovement (.journalLinked linked)⟩

/-- The loop of lines 425 to 446 from the entry at `index`, with the `cumulative` weight so far:
each entry's cumulative share of the posted amount, by carrying amount (by quantity when the
group's carrying amount is zero), its first anchor, its first position and its origin movement.
`count` is `ordered.length`. -/
def acquisitionConstruction (context : InventoryPostedAcquisitionContext) (posted : ExactDecimal)
    (posting : Option CanonicalPostingReference) (carryingZero : Bool) (denominator : ExactRational)
    (count : Nat) :
    Nat → ExactRational → List InventoryPostedAcquisitionEntry →
      Except QuantizeErr
        (OwnershipStep (List InventoryPostedAnchor × List InventoryPostedAcquisitionMovement))
  | _, _, [] => .ok (.proceed ([], []))
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
          match policy.quantizeCumulativePostedShare posted beforeFraction afterFraction with
          | .error e => .error e
          | .ok (.rejected diagnostics) => .ok (.rejected ⟨diagnostics⟩)
          | .ok (.quantized share) =>
            let h := entry.holding
            let ordinal := context.firstArtifactOrdinal + index
            let movementOrdinal := ordinal + count
            let anchorBody := acquisitionAnchorBody context entry index share posting
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
              let body : InventoryPostedAcquisitionMovementBody :=
                { id := entry.movementId, kind := .acquisition, effectKey := context.effectKey,
                  artifactOrdinal := movementOrdinal, bookRevision := context.bookRevision,
                  accountingDate := context.accountingDate, fiscalPeriodId := context.fiscalPeriodId,
                  coordinate := anchor.coordinate, postedAmount := anchor.postedBudget,
                  afterPosition := ⟨positionBody, hashInventoryPostedPosition positionBody⟩,
                  acquisitionProof := share, incomingSources := [] }
              match acquisitionConstruction context posted posting carryingZero denominator count
                  (index + 1) next rest with
              | .error e => .error e
              | .ok (.rejected rejection) => .ok (.rejected rejection)
              | .ok (.proceed (anchors, movements)) =>
                .ok (.proceed (anchor :: anchors, acquisitionMovementOf body posting :: movements))

end InventoryOwnership

open InventoryOwnership in
/-- `prepareInventoryPostedAcquisitionGroup` (line 358): first anchors and origin movements for one
complete acquisition posting group, in holding-identifier order. -/
def prepareInventoryPostedAcquisitionGroup (context : InventoryPostedAcquisitionContext)
    (entries : List InventoryPostedAcquisitionEntry)
    (journalLink : Option InventoryPostedJournalLink) :
    Except InventoryOwnershipErr InventoryPostedAcquisitionGroupResult :=
  let policy := context.quantizationPolicy
  if acquisitionPopulationInvalid context entries journalLink then
    .ok (.rejected acquisitionPopulationRejection)
  else if acquisitionEvidenceExceeded 0 entries then .ok (.rejected acquisitionEvidenceRejection)
  else if acquisitionIdentityInvalid context entries then
    .ok (.rejected acquisitionIdentityRejection)
  else
    match InventoryOwnershipErr.ofQuantize (liftExact (ExactDecimal.of 0 0)) with
    | .error e => .error e
    | .ok zeroTotal =>
      match InventoryOwnershipErr.ofQuantize
          (policy.quantizeCumulativePostedShare zeroTotal ExactRational.zero ExactRational.zero) with
      | .error e => .error e
      | .ok (.rejected diagnostics) => .ok (.rejected ⟨diagnostics⟩)
      | .ok (.quantized _) =>
        let ordered := sortByText (·.holding.id.value) entries
        let first := (ordered.head?.map (·.holding)).getD default
        match InventoryOwnershipErr.ofQuantize (acquisitionSourceLoop context first
            ExactRational.zero ExactRational.zero ExactRational.zero ordered) with
        | .error e => .error e
        | .ok (.rejected rejection) => .ok (.rejected rejection)
        | .ok (.proceed (quantity, basis, carrying)) =>
          match acquisitionPosting context first journalLink quantity basis carrying with
          | .error e => .error e
          | .ok (.rejected rejection) => .ok (.rejected rejection)
          | .ok (.proceed (posted, posting)) =>
            let denominator := if carrying.isZero then quantity else carrying
            match InventoryOwnershipErr.ofQuantize (acquisitionConstruction context posted posting
                carrying.isZero denominator ordered.length 0 ExactRational.zero ordered) with
            | .error e => .error e
            | .ok (.rejected rejection) => .ok (.rejected rejection)
            | .ok (.proceed (anchors, movements)) =>
              .ok (.prepared
                { anchors := anchors, movements := movements, lots := ordered.map (·.lot),
                  holdings := ordered.map (·.holding), postedAmount := posted })

/-! ## `prepareInventoryPostedReductionGroup` (lines 462 to 542) -/

namespace InventoryOwnership

/-- Line 469. -/
def reductionGroupPopulationRejection : OwnershipRejection :=
  reject "inventoryOwnership.group"
    "A reduction group must contain a bounded nonempty allocation population and bounded journal sources"

/-- Line 474. -/
def reductionGroupSourcesRejection : OwnershipRejection :=
  reject "inventoryOwnership.group"
    "Combined reduction-group source populations exceed the operation bound"

/-- Line 481. -/
def reductionGroupIdentityRejection : OwnershipRejection :=
  reject "inventoryOwnership.groupIdentity"
    "A reduction group requires a supported kind, committed origin and distinct holding, anchor, allocation and movement identities"

/-- Line 492. -/
def reductionGroupCoordinateRejection : OwnershipRejection :=
  reject "inventoryOwnership.groupCoordinate"
    "One posting group cannot combine different book, account, commodity or dimension coordinates"

/-- Line 506. -/
def reductionGroupZeroPostingRejection : OwnershipRejection :=
  reject "inventoryOwnership.posting"
    "An all-zero reduction group has no inventory posting or fabricated posting reference"

/-- Line 508. -/
def reductionGroupMissingPostingRejection : OwnershipRejection :=
  reject "inventoryOwnership.posting"
    "A money-bearing reduction group requires its actual admitted inventory posting"

/-- Line 514. -/
def reductionGroupJournalSourceRejection : OwnershipRejection :=
  reject "inventoryOwnership.journalSource"
    "The complete journal source must match this book, revision, date, fiscal period and canonical hash"

/-- Line 517. -/
def reductionGroupPostingCountRejection : OwnershipRejection :=
  reject "inventoryOwnership.posting" "The group must resolve exactly one actual inventory posting"

/-- Line 524. -/
def reductionGroupAttributionRejection : OwnershipRejection :=
  reject "inventoryOwnership.postingAttribution"
    "The inventory posting must exactly cover the group's signed money, complete quantity, historical basis and coordinate"

/-- The test of line 468. -/
def reductionGroupPopulationInvalid (entries : List InventoryPostedReductionEntry)
    (journalLink : Option InventoryPostedJournalLink) : Bool :=
  decide (entries.length = 0) || decide (entries.length > cap) ||
    (match journalLink with
      | none => false
      | some link => decide (link.source.journal.postings.length > cap))

/-- The loop of lines 471 to 475 from the `sources` counted so far: the running count of the
anchors' sources passes the bound at some entry. -/
def reductionGroupSourcesExceeded : Nat → List InventoryPostedReductionEntry → Bool
  | _, [] => false
  | sources, entry :: rest =>
    let next := sources + anchorSourceCount entry.anchor
    decide (next > cap) || reductionGroupSourcesExceeded next rest

/-- The test of lines 476 to 480 (the `kind` test always passes). -/
def reductionGroupIdentityInvalid (context : InventoryPostedReductionGroupContext)
    (entries : List InventoryPostedReductionEntry) : Bool :=
  decide (context.bookRevision ≤ 0) || decide (context.firstArtifactOrdinal ≤ 0) ||
    decide (context.effectKey.value.length = 0) || decide (context.commandId.value.length = 0) ||
    hasDuplicates (entries.map (·.holding.id)) || hasDuplicates (entries.map (·.anchor.id)) ||
    hasDuplicates (entries.map (·.allocation.id)) || hasDuplicates (entries.map (·.movementId))

/-- The test of lines 489 to 491 (and 612 to 614): a coordinate of another book, account,
commodity, currency or dimensions than the group's. -/
def groupCoordinateMismatch (bookId : BookId) (coordinate c : InventoryPostedCoordinate) : Bool :=
  c.bookId != bookId || c.accountId != coordinate.accountId ||
    c.unitsCommodityId != coordinate.unitsCommodityId ||
    c.functionalCommodityId != coordinate.functionalCommodityId ||
    c.dimensionMemberIds.length != coordinate.dimensionMemberIds.length ||
    someDiffersAt c.dimensionMemberIds coordinate.dimensionMemberIds

/-- The origin of the reduction of the entry at `index` (lines 494 to 497 and 633 to 636). -/
def groupOrigin (context : InventoryPostedGroupContext) (movementId : InventoryPostedMovementId)
    (index : Nat) : InventoryPostedReductionOrigin :=
  { movementId, effectKey := context.effectKey, artifactOrdinal := context.firstArtifactOrdinal + index,
    bookRevision := context.bookRevision }

/-- The loop of lines 487 to 503 from the entry at `index`, with the running posted amount,
quantity and historical basis: each entry's coordinate is tested, its reduction prepared, and its
amounts added. -/
def reductionGroupLoop (context : InventoryPostedReductionGroupContext)
    (coordinate : InventoryPostedCoordinate) :
    Nat → ExactRational → ExactRational → ExactRational → List InventoryPostedReductionEntry →
      Except QuantizeErr (OwnershipStep
        (List InventoryPostedReduction × ExactRational × ExactRational × ExactRational))
  | _, posted, quantity, basis, [] => .ok (.proceed ([], posted, quantity, basis))
  | index, posted, quantity, basis, entry :: rest =>
    if groupCoordinateMismatch context.bookId coordinate entry.anchor.coordinate then
      .ok (.rejected reductionGroupCoordinateRejection)
    else
      match prepareInventoryPostedReduction entry.anchor entry.position entry.holding
          entry.allocation (groupOrigin context.toInventoryPostedGroupContext entry.movementId index) with
      | .error e => .error e
      | .ok (.rejected rejection) => .ok (.rejected rejection)
      | .ok (.prepared reduction) =>
        match liftExact reduction.postedAmount.toRational with
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
                match reductionGroupLoop context coordinate (index + 1) posted' quantity' basis'
                    rest with
                | .error e => .error e
                | .ok (.rejected rejection) => .ok (.rejected rejection)
                | .ok (.proceed (reductions, total, totalQuantity, totalBasis)) =>
                  .ok (.proceed (reduction :: reductions, total, totalQuantity, totalBasis))

/-- The test of lines 510 to 513 (and 649 to 652 and 673 to 676): the journal source is not this
command's, book's, currency's, revision's, period's or date's, its effect key is empty or the
group's own, or its hash does not check. -/
def journalSourceMismatch (context : InventoryReductionEffectContext)
    (functionalCommodityId : CommodityId) (source : InventoryReductionJournalSource) : Bool :=
  source.commandId != context.commandId || source.journal.bookId != context.bookId ||
    source.journal.functionalCommodityId != functionalCommodityId ||
    source.bookRevision != context.bookRevision || source.fiscalPeriodId != context.fiscalPeriodId ||
    source.journal.accountingDate != context.accountingDate ||
    decide (source.effectKey.length = 0) || source.effectKey == context.effectKey.value ||
    !contentHashEquals source.canonicalHash (hashCanonical (canonicalJournalValue source.journal))

/-- The test of lines 520 to 523 (and 659 to 662 and 683 to 686) of the one matching posting,
against the account, units commodity, currency and dimensions it must have and the signed money,
quantity and basis it must carry; evaluated from the left, the conversion of the posting's money
throws only if it is reached. -/
def postingAttributionInvalid (accountId : AccountId) (unitsCommodityId : CommodityId)
    (functionalCommodityId : CommodityId) (dimensionMemberIds : List DimensionMemberId)
    (actual : Posting) (money quantity basis : ExactRational) : Except QuantizeErr Bool :=
  let dimensions := sortDimensions actual.dimensionMemberIds
  if actual.accountId != accountId || actual.units.commodityId != unitsCommodityId ||
      actual.bookValue.functionalCommodityId != functionalCommodityId ||
      dimensions.length != dimensionMemberIds.length ||
      someDiffersAt dimensions dimensionMemberIds then .ok true
  else
    match liftExact actual.bookValue.amount.toRational with
    | .error e => .error e
    | .ok amount =>
      .ok (!amount.equals money || !actual.units.canonicalNumber.equals quantity ||
        (match actual.costBasis with
          | none => true
          | some costBasis => costBasis.basisCommodityId != functionalCommodityId ||
              !costBasis.totalBasis.equals basis))

/-- Lines 504 to 527: the group's posting reference. An all-zero group has none and must not be
linked; a money-bearing one must be linked to a journal that matches, with one matching posting that
covers the group's signed money, quantity, basis and coordinate. -/
def reductionGroupPosting (context : InventoryPostedReductionGroupContext)
    (coordinate : InventoryPostedCoordinate) (journalLink : Option InventoryPostedJournalLink)
    (postedAmount quantity historicalBasis : ExactRational) :
    Except InventoryOwnershipErr (OwnershipStep (Option CanonicalPostingReference)) :=
  if postedAmount.isZero then
    match journalLink with
    | some _ => .ok (.rejected reductionGroupZeroPostingRejection)
    | none => .ok (.proceed none)
  else
    match journalLink with
    | none => .ok (.rejected reductionGroupMissingPostingRejection)
    | some link =>
      if journalSourceMismatch context.toInventoryReductionEffectContext
          coordinate.functionalCommodityId link.source then
        .ok (.rejected reductionGroupJournalSourceRejection)
      else
        match link.source.journal.postings.filter (fun p => p.id == link.postingId) with
        | [actual] =>
          match InventoryOwnershipErr.ofQuantize (postingAttributionInvalid coordinate.accountId
              coordinate.unitsCommodityId coordinate.functionalCommodityId
              coordinate.dimensionMemberIds actual postedAmount quantity.negate
              historicalBasis.negate) with
          | .error e => .error e
          | .ok true => .ok (.rejected reductionGroupAttributionRejection)
          | .ok false =>
            match effectKey link.source.effectKey with
            | .error e => .error (.effectKey e)
            | .ok key =>
              .ok (.proceed (some (createCanonicalPostingReference link.referenceId
                context.bookId link.source.journal.id actual key)))
        | _ => .ok (.rejected reductionGroupPostingCountRejection)

/-- A reduction movement of a group (lines 530 to 539 and 700 to 709): its body, quantity-only when
the reduction is, journal-linked to the posting otherwise (`posting!`), and its hash. -/
def reductionMovementOf (context : InventoryReductionEffectContext)
    (kind : InventoryPostedReductionKind) (id : InventoryPostedMovementId) (artifactOrdinal : Int)
    (coordinate : InventoryPostedCoordinate) (reduction : InventoryPostedReduction)
    (posting : Option CanonicalPostingReference) : InventoryPostedReductionMovement :=
  let body : InventoryPostedReductionMovementBody :=
    { id, kind, effectKey := context.effectKey, artifactOrdinal,
      bookRevision := context.bookRevision, accountingDate := context.accountingDate,
      fiscalPeriodId := context.fiscalPeriodId, coordinate, postedAmount := reduction.postedAmount,
      beforePosition := reduction.beforePosition, afterPosition := reduction.afterPosition,
      quantityAllocation := reduction.allocation, reductionProof := reduction.reductionProof,
      incomingSources := [] }
  match reduction.monetaryKind with
  | .quantityOnly => .quantityOnly ⟨body, hashInventoryPostedReductionMovement (.quantityOnly body)⟩
  | .journalLinked =>
    let linked : JournalLinkedInventoryReductionMovementBody := ⟨body, posting.getD default⟩
    .journalLinked ⟨linked, hashInventoryPostedReductionMovement (.journalLinked linked)⟩

/-- `reductions.map((reduction, index) => ...)` (lines 528 to 540), from `index`, with the entry
`ordered[index]` beside each reduction. -/
def reductionGroupMovements (context : InventoryPostedReductionGroupContext)
    (posting : Option CanonicalPostingReference) :
    Nat → List InventoryPostedReductionEntry → List InventoryPostedReduction →
      List InventoryPostedReductionMovement
  | index, entry :: entries, reduction :: reductions =>
    reductionMovementOf context.toInventoryReductionEffectContext context.kind entry.movementId
        (context.firstArtifactOrdinal + index) entry.anchor.coordinate reduction posting ::
      reductionGroupMovements context posting (index + 1) entries reductions
  | _, _, _ => []

end InventoryOwnership

open InventoryOwnership in
/-- `prepareInventoryPostedReductionGroup` (line 462): one complete reduction group, in canonical
holding-identifier order, every reduction recomputed. -/
def prepareInventoryPostedReductionGroup (context : InventoryPostedReductionGroupContext)
    (entries : List InventoryPostedReductionEntry)
    (journalLink : Option InventoryPostedJournalLink) :
    Except InventoryOwnershipErr InventoryPostedReductionGroupResult :=
  if reductionGroupPopulationInvalid entries journalLink then
    .ok (.rejected reductionGroupPopulationRejection)
  else if reductionGroupSourcesExceeded 0 entries then
    .ok (.rejected reductionGroupSourcesRejection)
  else if reductionGroupIdentityInvalid context entries then
    .ok (.rejected reductionGroupIdentityRejection)
  else
    let ordered := sortByText (·.holding.id.value) entries
    let coordinate := (ordered.head?.map (·.anchor.coordinate)).getD default
    match InventoryOwnershipErr.ofQuantize (reductionGroupLoop context coordinate 0
        ExactRational.zero ExactRational.zero ExactRational.zero ordered) with
    | .error e => .error e
    | .ok (.rejected rejection) => .ok (.rejected rejection)
    | .ok (.proceed (reductions, postedAmount, quantity, historicalBasis)) =>
      match reductionGroupPosting context coordinate journalLink postedAmount quantity
          historicalBasis with
      | .error e => .error e
      | .ok (.rejected rejection) => .ok (.rejected rejection)
      | .ok (.proceed posting) =>
        .ok (.prepared
          { movements := reductionGroupMovements context posting 0 ordered reductions,
            afterHoldings := reductions.map (·.afterHolding), postedAmount := postedAmount,
            quantity := quantity, historicalBasis := historicalBasis })

end Rastrata.Kernel

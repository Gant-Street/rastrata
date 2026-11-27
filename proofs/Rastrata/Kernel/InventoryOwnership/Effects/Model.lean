/-
The model of `packages/kernel/src/inventory-ownership.ts` lines 876 to 1443: the effect hashes
`hashInventoryReductionOwnershipEffect` and `hashInventoryOwnershipEffect`,
`resolveInventoryOwnershipSources`, `prepareInventoryOwnershipSelection`,
`prepareInventoryReductionEffectFromReadContext`, `prepareInventoryOwnershipEffectFromReadContext`,
`prepareInventoryReductionEffect` and `prepareInventoryOwnershipEffect`; with
`ownershipCoordinateValid`, `ownershipPositionValid` and `ownershipAnchorValid` (lines 1459 to
1491), which `resolveInventoryOwnershipSources` calls and which are therefore here rather than in
`InventoryOwnership/Validation/Model.lean`.

The conventions are those of `InventoryOwnership/Reduction/Model.lean` (see its header): the same
checks in the same order, a `||` chain as one `Bool` or, when an operation in it may throw, an
`Except` that evaluates the chain from the left and throws only if the throwing operation is
reached; every diagnostic in full; `.error` where the TypeScript throws.

What the functions of this file throw (`InventoryOwnershipEffectErr`): what the group functions
throw (`InventoryOwnershipErr`), an `ExactNumberError` or the `RangeError` of `quantize`
(`.ownership (.quantize e)`), a read of the read context (`.read`), and the `TypeError` of reading a
property of `undefined` (`.undefinedValue`), where the TypeScript asserts a value present with `!`
and it is not.

Where the model differs from the TypeScript in form, besides what `Reduction/Model.lean` lists:

- A `Map` is a list of key and value pairs: `get` is `List.lookup`, `set` replaces the value of the
  key in place or appends the pair (`InventoryOwnershipEffects.mapSet`), so the order of `values()`
  is the order of insertion. A `Set` is a list: `has` is membership, and where the size is read
  (`used.size`, line 1434) it is the length of the deduplicated list (`Lots.setSize`).
- The read context is a pure snapshot (`InventoryOwnership/Types.lean`): every read answers the
  same for the same argument, and `bookId` and `bookRevision` cannot change, so the scope tests of
  `guard` (line 946) and `guardCandidate` (line 1198) always pass; `assertCurrent` is still called
  where the TypeScript calls it, and its error is returned.
- The run-time tests the TypeScript types already guarantee always pass: `policy.method` is one of
  the five methods (line 1046; `InventoryCostMethod` has exactly those five), and every operation of
  `prepareInventoryReductionEffect` is a disposal or a transfer out (line 1226; its operations are
  `InventoryReductionOperation`s, whose `kind` is one of the two).
- `holdings.get(id)!` (line 1084), `current.get(...)!` (lines 1401 and 1428) and the indexed reads
  `prepared.group.holdings[index]!`, `anchors[index]!`, `afterSourceHoldings[index]!`,
  `destinationHoldings[index]!`, `destinationAnchors[index]!` and `afterHoldings[index]!` assert a
  value the TypeScript then reads. The model returns `.undefinedValue` at once where the value is
  absent; the TypeScript throws when it reads a property of it (at once for `holdings.get(id)!`,
  `current.get(...)!` and `holdings[index]!`, later or never for the others, which it stores). In
  every run tried the values were present; that a prepared group's lists have equal lengths rests
  on the laws of the group functions and is not proved here.
- The unchecked casts `result.effect as InventoryReductionOwnershipEffect` (lines 1145 and 1230)
  are the partial function `InventoryOwnershipEffect.asReductionEffect?`, defined exactly when every
  movement of the effect is a reduction movement; where it is not, the TypeScript would return the
  effect under a type that does not describe it, and the model returns `.uncheckedCast`. For
  `prepareInventoryReductionEffect` this is proved never to be reached
  (`prepareInventoryReductionEffect_ne_uncheckedCast`); for the read-context form it is not proved
  here.
-/
import Rastrata.Kernel.InventoryOwnership.Transfer.Model
import Rastrata.Kernel.Accounting.Inventory.Model

namespace Rastrata.Kernel

/-! ## Errors -/

/-- What the functions of `InventoryOwnership/Effects/Model.lean` throw. -/
inductive InventoryOwnershipEffectErr where
  /-- What a group function throws, an `ExactNumberError`, or the `RangeError` of `quantize`. -/
  | ownership (error : InventoryOwnershipErr)
  /-- What a read of the read context throws. -/
  | read (error : InventoryOwnershipReadError)
  /-- The `TypeError` of reading a property of a value asserted present with `!` that is absent. -/
  | undefinedValue
  /-- Not a throw of the TypeScript: its unchecked cast `as InventoryReductionOwnershipEffect` on an
  effect that holds an acquisition movement (never reached). -/
  | uncheckedCast
  deriving DecidableEq, Repr, Inhabited

namespace InventoryOwnershipEffectErr

/-- An error of a group function as an error of this file. -/
def ofOwnership {α : Type} : Except InventoryOwnershipErr α → Except InventoryOwnershipEffectErr α
  | .ok value => .ok value
  | .error e => .error (.ownership e)

/-- A `QuantizeErr` as an error of this file. -/
def ofQuantize {α : Type} : Except QuantizeErr α → Except InventoryOwnershipEffectErr α
  | .ok value => .ok value
  | .error e => .error (.ownership (.quantize e))

/-- An `ExactNumberError` as an error of this file. -/
def ofExact {α : Type} : Except NumErr α → Except InventoryOwnershipEffectErr α
  | .ok value => .ok value
  | .error e => .error (.ownership (.quantize (.exactNumber e)))

/-- A read error as an error of this file. -/
def ofRead {α : Type} : Except InventoryOwnershipReadError α → Except InventoryOwnershipEffectErr α
  | .ok value => .ok value
  | .error e => .error (.read e)

end InventoryOwnershipEffectErr

/-! ## The canonical value of an effect -/

/-- `Omit<InventoryOwnershipEffect, "contentHash">`. -/
def InventoryOwnershipEffectBody.canonicalMembers (effect : InventoryOwnershipEffectBody) :
    List Member :=
  [member "effectKey" effect.effectKey, member "bookRevision" effect.bookRevision,
    member "newAnchors" effect.newAnchors,
    member "journalLinkedMovements" effect.journalLinkedMovements,
    member "quantityOnlyMovements" effect.quantityOnlyMovements]

instance : CanonicalObject InventoryOwnershipEffectBody :=
  ⟨InventoryOwnershipEffectBody.canonicalMembers⟩

/-- `InventoryOwnershipEffect`: the body and its `contentHash`. -/
def InventoryOwnershipEffect.canonicalMembers (effect : InventoryOwnershipEffect) : List Member :=
  effect.toInventoryOwnershipEffectBody.canonicalMembers ++
    [member "contentHash" effect.contentHash]

instance : CanonicalObject InventoryOwnershipEffect := ⟨InventoryOwnershipEffect.canonicalMembers⟩

/-! ## The effect hashes (`inventory-ownership.ts` lines 892 to 899) -/

/-- `hashInventoryOwnershipEffect` (line 896): `hashCanonical({ type: "InventoryOwnershipEffect",
value: canonicalAccountingValue(body) })` of the effect without its `contentHash`, which is
`accountingHash`. -/
def hashInventoryOwnershipEffect (effect : InventoryOwnershipEffectBody) : ContentHash :=
  accountingHash "InventoryOwnershipEffect" effect

/-- `hashInventoryReductionOwnershipEffect` (line 892): `hashInventoryOwnershipEffect` of the same
object, each movement as the movement of either kind it is. -/
def hashInventoryReductionOwnershipEffect (effect : InventoryReductionOwnershipEffectBody) :
    ContentHash :=
  hashInventoryOwnershipEffect effect.toInventoryOwnershipEffectBody

/-! ## Helpers -/

namespace InventoryOwnershipEffects

open InventoryOwnership

/-- `map.set(key, value)`: the value of the key replaced in place, or the pair appended. -/
def mapSet {κ α : Type} [DecidableEq κ] (entries : List (κ × α)) (key : κ) (value : α) :
    List (κ × α) :=
  if entries.any (fun entry => entry.1 == key) then
    entries.map fun entry => if entry.1 == key then (key, value) else entry
  else entries ++ [(key, value)]

/-- `set.add(value)` where the insertion order is read later: the value appended if absent. -/
def setAdd {α : Type} [DecidableEq α] (values : List α) (value : α) : List α :=
  if value ∈ values then values else values ++ [value]

/-- The verification work of an anchor (lines 968, 1280, 1392 and 1421): its source postings,
incoming movements, evidence, its predecessor position if it has one, and its dimensions. -/
def anchorWork (anchor : InventoryPostedAnchor) : Nat :=
  anchorSourceCount anchor + anchor.coordinate.dimensionMemberIds.length

/-- The test of lines 1480 to 1485 of `ownershipAnchorValid`: no source or too many, a source
reference that is not valid in the coordinate's book or not before the anchor, a repeated incoming
movement, a source posting of another book or whose hash does not check, a repeated posting,
evidence without a full hash, or repeated evidence. -/
def anchorSourcesInvalid (anchor : InventoryPostedAnchor) : Bool :=
  let bookId := anchor.coordinate.bookId
  let refs := anchorSourceReferences anchor
  let sourceCount := refs.length + anchor.sourcePostings.length + anchor.evidence.length
  decide (sourceCount = 0) || decide (sourceCount > cap) ||
    refs.any (fun reference => !referenceValid reference bookId ||
      !precedes reference.artifactOrder anchor.artifactOrder) ||
    hasDuplicates (anchor.incomingMovements.map (·.id)) ||
    anchor.sourcePostings.any (fun reference =>
      reference.bookId != bookId || !validateCanonicalPostingReferenceHash reference) ||
    hasDuplicates (anchor.sourcePostings.map (·.postingId)) ||
    anchor.evidence.any (fun evidence => !fullHash evidence.contentHash) ||
    hasDuplicates (anchor.evidence.map (·.id))

end InventoryOwnershipEffects

/-! ## Validity of coordinates, positions and anchors (lines 1459 to 1491) -/

open InventoryOwnership InventoryOwnershipEffects in
/-- `ownershipCoordinateValid` (line 1459): at most the bound of dimensions, strictly increasing in
UTF-16 order. -/
def ownershipCoordinateValid (coordinate : InventoryPostedCoordinate) : Bool :=
  decide (coordinate.dimensionMemberIds.length ≤ cap) &&
    !dimensionsOutOfOrder coordinate.dimensionMemberIds

open InventoryOwnership in
/-- `ownershipPositionValid` (line 1464), evaluated from the left: a reproducible hash, a
nonnegative consumed quantity and posted amount (whose conversion throws only if it is reached), a
valid anchor reference in its own book, a complete origin, and the anchor before the origin. -/
def ownershipPositionValid (position : InventoryPostedPosition) : Except QuantizeErr Bool :=
  if !contentHashEquals position.contentHash
        (hashInventoryPostedPosition position.toInventoryPostedPositionBody) ||
      position.consumedQuantity.isNegative then .ok false
  else
    match liftExact position.consumedPosted.toRational with
    | .error e => .error e
    | .ok consumedPosted =>
      .ok (!consumedPosted.isNegative &&
        referenceValid position.anchor.toInventoryPostedArtifactReference position.anchor.bookId &&
        decide (position.originMovementId.value.length > 0) &&
        decide (position.originEffectKey.value.length > 0) &&
        decide (position.originArtifactOrdinal > 0) && decide (position.originBookRevision > 0) &&
        precedes position.anchor.artifactOrder
          ⟨position.originEffectKey, position.originArtifactOrdinal, position.originBookRevision⟩)

namespace InventoryOwnershipEffects

open InventoryOwnership

/-- The test of lines 1474 to 1477 (the algorithm test always passes): a carried hash its content
does not reproduce, an unsupported version, a quantity that is not positive, an ordinal, revision
or effect key missing, a policy hash that is not full, an invalid coordinate, or a quantization
policy of another book or currency. -/
def anchorHeaderInvalid (anchor : InventoryPostedAnchor) : Bool :=
  let coordinate := anchor.coordinate
  !contentHashEquals anchor.contentHash
      (hashInventoryPostedAnchor anchor.toInventoryPostedAnchorBody) ||
    !postedAnchorVersionValid anchor || anchor.quantity.compare ExactRational.zero != .gt ||
    decide (anchor.artifactOrdinal ≤ 0) || decide (anchor.bookRevision ≤ 0) ||
    decide (anchor.effectKey.value.length = 0) || !fullHash anchor.inventoryPolicy.policyContentHash ||
    !ownershipCoordinateValid coordinate ||
    anchor.quantizationPolicy.bookId != coordinate.bookId ||
    anchor.quantizationPolicy.functionalCommodityId != coordinate.functionalCommodityId

/-- Line 1490: the anchor's budget is a share the pinned policy accepts. -/
def anchorBudgetQuantizes (anchor : InventoryPostedAnchor) : Except QuantizeErr Bool :=
  match anchor.quantizationPolicy.quantizeCumulativePostedShare anchor.postedBudget
      ExactRational.zero ExactRational.zero with
  | .error e => .error e
  | .ok (.quantized _) => .ok true
  | .ok (.rejected _) => .ok false

/-- Lines 1486 to 1490: the posted components of a component-bearing anchor, allocated from
nothing, must leave its whole budget; then the budget must quantize. -/
def anchorPostedValueValid (anchor : InventoryPostedAnchor) : Except QuantizeErr Bool :=
  match anchor.postedValue with
  | none => anchorBudgetQuantizes anchor
  | some budget =>
    match allocateInventoryPostedValue budget ExactRational.zero ExactRational.zero
        anchor.quantizationPolicy with
    | .error e => .error e
    | .ok (.rejected _) => .ok false
    | .ok (.allocated values) =>
      match liftExact values.carryingRemaining.toRational with
      | .error e => .error e
      | .ok remaining =>
        match liftExact anchor.postedBudget.toRational with
        | .error e => .error e
        | .ok total => if !remaining.equals total then .ok false else anchorBudgetQuantizes anchor

end InventoryOwnershipEffects

open InventoryOwnershipEffects in
/-- `ownershipAnchorValid` (line 1472): the header, the sources, the posted components and the
budget, in the TypeScript's order. -/
def ownershipAnchorValid (anchor : InventoryPostedAnchor) : Except QuantizeErr Bool :=
  if anchorHeaderInvalid anchor then .ok false
  else if anchorSourcesInvalid anchor then .ok false
  else anchorPostedValueValid anchor

/-! ## `resolveInventoryOwnershipSources` (lines 934 to 1000) -/

/-- The result of `resolveInventoryOwnershipSources`: `resolved` with the sources, or `rejected`. -/
inductive InventoryOwnershipSourceResolution where
  | resolved (sources : List InventoryPostedReductionSource)
  | rejected (rejection : OwnershipRejection)
  deriving DecidableEq, Repr, Inhabited

namespace InventoryOwnershipEffects

open InventoryOwnership

/-- Line 942. -/
def resolveReadSetRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.readSet"
    "Ownership reads require one bounded distinct holding set at a committed book head"

/-- Line 954. -/
def resolveHoldingAbsentRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.currentSource" "Current holding is absent from the pinned book"

/-- Line 958. -/
def resolvePositionAbsentRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.currentSource"
    "Current posted ownership position is absent; legacy adoption cannot be inferred"

/-- Line 962. -/
def resolveCurrentSourceRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.currentSource"
    "Current holding and position must match the pinned book and supported exact origin"

/-- Line 966. -/
def resolveAnchorAbsentRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.anchorSource"
    "The exact historical anchor must exist in the pinned source history"

/-- Line 970. -/
def resolveWorkRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.readSet"
    "Ownership source verification exceeds the combined work bound"

/-- Line 976. -/
def resolveAnchorSourceRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.anchorSource"
    "The exact anchor version and complete holding coordinate must agree"

/-- Line 983. -/
def resolvePositionOriginRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.positionOrigin"
    "Current position must equal the complete immutable after-image at its authenticated origin"

/-- Line 989. -/
def resolvePositionBalanceRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.positionBalance"
    "Anchor quantity and current exact holding balances must reconcile without negative carrying value"

/-- Line 994. -/
def resolveConsumedTargetRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.positionBalance"
    "Consumed money must equal the actual anchor budget's pinned cumulative target"

/-- The test of lines 940 and 941: an empty book, a revision that is not committed, no holding,
more than the bound, a repeated holding, or an empty identifier. -/
def resolveReadSetInvalid (book : BookId) (revision : Int) (holdingIds : List LotHoldingId) :
    Bool :=
  decide (book.value.length = 0) || decide (revision ≤ 0) || decide (holdingIds.length = 0) ||
    decide (holdingIds.length > cap) || hasDuplicates holdingIds ||
    holdingIds.any (fun id => decide (id.value.length = 0))

/-- The test of lines 960 and 961, evaluated from the left (`ownershipPositionValid` throws only if
it is reached): the holding or the position is of another holding or book, the position is not
valid, its anchor is of another book, or its origin is after the pinned revision. -/
def resolveCurrentSourceInvalid (book : BookId) (revision : Int) (id : LotHoldingId)
    (holding : LotHolding) (position : InventoryPostedPosition) : Except QuantizeErr Bool :=
  if holding.id != id || holding.bookId != book || position.holdingId != id then .ok true
  else
    match ownershipPositionValid position with
    | .error e => .error e
    | .ok valid =>
      .ok (!valid || position.anchor.bookId != book || decide (position.originBookRevision > revision))

/-- The test of lines 972 to 975, evaluated from the left: the anchor is not valid, the position
does not bind its exact version, or its coordinate is not the holding's in the pinned book. -/
def resolveAnchorSourceInvalid (book : BookId) (id : LotHoldingId) (holding : LotHolding)
    (position : InventoryPostedPosition) (anchor : InventoryPostedAnchor) :
    Except QuantizeErr Bool :=
  match ownershipAnchorValid anchor with
  | .error e => .error e
  | .ok valid =>
    let c := anchor.coordinate
    .ok (!valid || !sameOwnershipValue position.anchor (anchorReferenceOf anchor) ||
      c.bookId != book || c.holdingId != id || c.lotId != holding.lotId ||
      c.accountId != holding.accountId || c.unitsCommodityId != holding.commodityId ||
      c.functionalCommodityId != holding.basisCommodityId)

/-- The test of lines 985 to 988, evaluated from the left (the subtraction and the addition throw
only if they are reached): more consumed than the anchor holds, a holding that does not hold the
rest, a negative basis, a positive allowance, a negative carrying amount, an empty holding with a
basis or an allowance, or a carrying amount that is not basis plus allowance. -/
def resolveBalanceInvalid (anchor : InventoryPostedAnchor) (position : InventoryPostedPosition)
    (holding : LotHolding) : Except QuantizeErr Bool :=
  if position.consumedQuantity.compare anchor.quantity == .gt then .ok true
  else
    match liftExact (anchor.quantity.subtract position.consumedQuantity) with
    | .error e => .error e
    | .ok unconsumed =>
      if !holding.remainingQuantity.equals unconsumed || holding.remainingTotalBasis.isNegative ||
          holding.remainingValuationAllowance.compare ExactRational.zero == .gt ||
          holding.remainingCarryingAmount.isNegative ||
          (holding.remainingQuantity.isZero &&
            (!holding.remainingTotalBasis.isZero || !holding.remainingValuationAllowance.isZero)) then
        .ok true
      else
        match liftExact (holding.remainingTotalBasis.add holding.remainingValuationAllowance) with
        | .error e => .error e
        | .ok sum => .ok (!holding.remainingCarryingAmount.equals sum)

/-- The test of lines 991 to 993, evaluated from the left: the consumed fraction's cumulative share
of the anchor's budget is rejected, or the consumed money is not its quantized target. -/
def resolveConsumedTargetInvalid (anchor : InventoryPostedAnchor)
    (position : InventoryPostedPosition) : Except QuantizeErr Bool :=
  match liftExact (position.consumedQuantity.divide anchor.quantity) with
  | .error e => .error e
  | .ok fraction =>
    match anchor.quantizationPolicy.quantizeCumulativePostedShare anchor.postedBudget fraction
        fraction with
    | .error e => .error e
    | .ok (.rejected _) => .ok true
    | .ok (.quantized target) =>
      match liftExact position.consumedPosted.toRational with
      | .error e => .error e
      | .ok consumed =>
        match liftExact target.afterQuantization.amount.toRational with
        | .error e => .error e
        | .ok expected => .ok (!consumed.equals expected)

/-- `guard` (line 944): `assertCurrent`; the scope test always passes here. -/
def readGuard (reader : InventoryOwnershipReadContext) : Except InventoryOwnershipEffectErr Unit :=
  InventoryOwnershipEffectErr.ofRead (reader.assertCurrent ())

/-- The origin of a position (line 978): its origin movement, in the pinned book. -/
def positionOrigin (book : BookId) (position : InventoryPostedPosition) :
    InventoryPostedPositionOrigin :=
  { bookId := book, movementId := position.originMovementId, effectKey := position.originEffectKey,
    artifactOrdinal := position.originArtifactOrdinal, bookRevision := position.originBookRevision }

/-- Lines 964 to 996 for one holding, with its holding and position read: its anchor read and
counted against the combined `work` so far, checked, its after-image read and compared, and its
balances and consumed money checked; then the source and the work so far. -/
def resolveAnchorStage (reader : InventoryOwnershipReadContext) (work : Nat) (id : LotHoldingId)
    (holding : LotHolding) (position : InventoryPostedPosition) :
    Except InventoryOwnershipEffectErr (OwnershipStep (Nat × InventoryPostedReductionSource)) :=
  match InventoryOwnershipEffectErr.ofRead (reader.readAnchor position.anchor) with
  | .error e => .error e
  | .ok suppliedAnchor =>
    match readGuard reader with
    | .error e => .error e
    | .ok _ =>
      match suppliedAnchor with
      | none => .ok (.rejected resolveAnchorAbsentRejection)
      | some anchor =>
        let work' := work + anchorWork anchor
        if work' > cap then .ok (.rejected resolveWorkRejection)
        else
          match InventoryOwnershipEffectErr.ofQuantize
              (resolveAnchorSourceInvalid reader.bookId id holding position anchor) with
          | .error e => .error e
          | .ok true => .ok (.rejected resolveAnchorSourceRejection)
          | .ok false =>
            match InventoryOwnershipEffectErr.ofRead
                (reader.readPositionAfterImage (positionOrigin reader.bookId position)) with
            | .error e => .error e
            | .ok suppliedAfterImage =>
              match readGuard reader with
              | .error e => .error e
              | .ok _ =>
                if (match suppliedAfterImage with
                    | none => true
                    | some afterImage => !sameOwnershipValue position afterImage) then
                  .ok (.rejected resolvePositionOriginRejection)
                else
                  match InventoryOwnershipEffectErr.ofQuantize
                      (resolveBalanceInvalid anchor position holding) with
                  | .error e => .error e
                  | .ok true => .ok (.rejected resolvePositionBalanceRejection)
                  | .ok false =>
                    match InventoryOwnershipEffectErr.ofQuantize
                        (resolveConsumedTargetInvalid anchor position) with
                    | .error e => .error e
                    | .ok true => .ok (.rejected resolveConsumedTargetRejection)
                    | .ok false => .ok (.proceed (work', ⟨anchor, position, holding⟩))

/-- Lines 951 to 996 for one holding: `guard`, its holding read, `guard`, its position read,
`guard`, their test, then the anchor stage. -/
def resolveHolding (reader : InventoryOwnershipReadContext) (work : Nat) (id : LotHoldingId) :
    Except InventoryOwnershipEffectErr (OwnershipStep (Nat × InventoryPostedReductionSource)) :=
  match readGuard reader with
  | .error e => .error e
  | .ok _ =>
    match InventoryOwnershipEffectErr.ofRead (reader.readCurrentHolding id) with
    | .error e => .error e
    | .ok suppliedHolding =>
      match readGuard reader with
      | .error e => .error e
      | .ok _ =>
        match suppliedHolding with
        | none => .ok (.rejected resolveHoldingAbsentRejection)
        | some holding =>
          match InventoryOwnershipEffectErr.ofRead (reader.readCurrentPosition id) with
          | .error e => .error e
          | .ok suppliedPosition =>
            match readGuard reader with
            | .error e => .error e
            | .ok _ =>
              match suppliedPosition with
              | none => .ok (.rejected resolvePositionAbsentRejection)
              | some position =>
                match InventoryOwnershipEffectErr.ofQuantize (resolveCurrentSourceInvalid
                    reader.bookId reader.bookRevision id holding position) with
                | .error e => .error e
                | .ok true => .ok (.rejected resolveCurrentSourceRejection)
                | .ok false => resolveAnchorStage reader work id holding position

/-- The loop of lines 950 to 997 from the `work` counted so far: each holding in turn, the
sources in the order of the holdings. -/
def resolveLoop (reader : InventoryOwnershipReadContext) :
    Nat → List LotHoldingId →
      Except InventoryOwnershipEffectErr (OwnershipStep (List InventoryPostedReductionSource))
  | _, [] => .ok (.proceed [])
  | work, id :: rest =>
    match resolveHolding reader work id with
    | .error e => .error e
    | .ok (.rejected rejection) => .ok (.rejected rejection)
    | .ok (.proceed (work', source)) =>
      match resolveLoop reader work' rest with
      | .error e => .error e
      | .ok (.rejected rejection) => .ok (.rejected rejection)
      | .ok (.proceed sources) => .ok (.proceed (source :: sources))

end InventoryOwnershipEffects

open InventoryOwnership InventoryOwnershipEffects in
/-- `resolveInventoryOwnershipSources` (line 934): `assertCurrent`, the test of the read set, the
holdings in UTF-16 order of their identifiers, each resolved through the read context and checked,
and a last `guard`. -/
def resolveInventoryOwnershipSources (reader : InventoryOwnershipReadContext)
    (holdingIds : List LotHoldingId) :
    Except InventoryOwnershipEffectErr InventoryOwnershipSourceResolution :=
  match InventoryOwnershipEffectErr.ofRead (reader.assertCurrent ()) with
  | .error e => .error e
  | .ok _ =>
    if resolveReadSetInvalid reader.bookId reader.bookRevision holdingIds then
      .ok (.rejected resolveReadSetRejection)
    else
      match resolveLoop reader 0 (sortByText (·.value) holdingIds) with
      | .error e => .error e
      | .ok (.rejected rejection) => .ok (.rejected rejection)
      | .ok (.proceed sources) =>
        match readGuard reader with
        | .error e => .error e
        | .ok _ => .ok (.resolved sources)

/-! ## `prepareInventoryOwnershipSelection` (lines 1032 to 1105) -/

/-- The result of `prepareInventoryOwnershipSelection`: `selected` with the selection, or
`rejected`. -/
inductive InventoryOwnershipSelectionResult where
  | selected (selection : InventoryOwnershipSelection)
  | rejected (rejection : OwnershipRejection)
  deriving DecidableEq, Repr, Inhabited

namespace InventoryOwnershipEffects

open InventoryOwnership

/-- Line 1040. -/
def selectionBoundsRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.selection"
    "Inventory selection inputs exceed their bounded populations"

/-- Line 1051. -/
def selectionPolicyRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.selectionPolicy"
    "Selection requires one applicable supported policy, complete artifact hashes and matching approved derivation"

/-- Line 1058. -/
def selectionEvidenceRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.selection"
    "Canonical lot evidence exceeds the selection work bound"

/-- Line 1065. -/
def selectionPoolRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.selectionPool"
    "Canonical pool rows must be unique, coherent and match the complete selected book/account/commodity scope"

/-- Line 1068. -/
def selectionLotConflictRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.selectionPool"
    "One canonical lot identity cannot have conflicting source content"

/-- Line 1078. -/
def selectionIdentityRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.selectionIdentity"
    "Stable allocation and movement identities must exactly cover the computed selected holdings"

/-- Line 1085. -/
def selectionMissingIdentityRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.selectionIdentity"
    "Each computed selected holding requires its own supplied stable identities"

/-- Line 1097. -/
def selectionConservationRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.selectionConservation"
    "Selected source economics must conserve the requested quantity and computed ordinary basis"

/-- The test of line 1039: a population over the bound. -/
def selectionBoundsExceeded (policies : List AccountingPolicy)
    (canonicalPool : List InventoryOwnershipPoolRow) (request : InventoryOwnershipSelectionRequest) :
    Bool :=
  decide (policies.length > cap) || decide (canonicalPool.length > cap) ||
    decide (request.identities.length > cap) || decide (request.derivation.evidence.length > cap) ||
    decide ((request.specificLayerIds.map List.length).getD 0 > cap)

/-- The filter of line 1042: an inventory cost policy of the request's identifier and version in
force at the request's instant, compared as texts (`policyMatches` of `Accounting/Core/Model.lean`,
which is the same test). -/
def selectionMatches (policies : List AccountingPolicy)
    (request : InventoryOwnershipSelectionRequest) : List AccountingPolicy :=
  policies.filter
    (policyMatches .inventoryCost request.policyId request.policyVersion request.governedAt)

/-- The test of lines 1045 to 1050 of the one matching policy (the method test always passes): a
policy of another book, too many pools, another algorithm version, a quantization policy of another
book, artifacts whose hashes do not check, a derivation that is not approved or not this policy's,
or a derivation hash or evidence hash that is not full, or repeated evidence. -/
def selectionPolicyInvalid (bookId : BookId) (policy : InventoryCostPolicy)
    (request : InventoryOwnershipSelectionRequest) : Bool :=
  let derivation := request.derivation
  policy.bookId != bookId || decide (policy.pools.length > cap) ||
    policy.algorithmVersion.value != "1.0.0" || policy.quantizationPolicy.bookId != bookId ||
    !verifyAccountingPolicyArtifacts [.inventoryCost policy] ||
    !validAccountingDerivation derivation || derivation.policyId != policy.id ||
    derivation.policyVersion != policy.version ||
    derivation.algorithmVersion != policy.algorithmVersion || !fullHash derivation.inputHash ||
    derivation.evidence.any (fun evidence => !fullHash evidence.contentHash) ||
    hasDuplicates (derivation.evidence.map (·.id))

/-- The test of lines 1059 to 1064 for one pool row, evaluated from the left (the addition throws
only if it is reached): a holding already seen or without an identifier, a holding or lot of
another book, a holding of another lot, of an account outside the policy's pools, of another
commodity or basis currency, negative quantities or basis, a positive allowance, a negative carrying
amount, a carrying amount that is not basis plus allowance, or an empty holding with a basis or an
allowance. `holdings` are the rows accepted so far. -/
def selectionRowInvalid (bookId : BookId) (policy : InventoryCostPolicy)
    (request : InventoryOwnershipSelectionRequest) (holdings : List LotHolding)
    (row : InventoryOwnershipPoolRow) : Except NumErr Bool :=
  let h := row.holding
  let lot := row.lot
  if holdings.any (fun held => held.id == h.id) || decide (h.id.value.length = 0) ||
      h.bookId != bookId || lot.bookId != bookId || h.lotId != lot.id ||
      !policy.pools.any (fun pool => pool.accountId == h.accountId) ||
      h.commodityId != request.inventoryCommodityId || lot.commodityId != h.commodityId ||
      h.basisCommodityId != policy.quantizationPolicy.functionalCommodityId ||
      lot.basisCommodityId != h.basisCommodityId || h.remainingQuantity.isNegative ||
      h.remainingTotalBasis.isNegative ||
      h.remainingValuationAllowance.compare ExactRational.zero == .gt ||
      h.remainingCarryingAmount.isNegative then .ok true
  else
    match h.remainingTotalBasis.add h.remainingValuationAllowance with
    | .error e => .error e
    | .ok sum =>
      .ok (!h.remainingCarryingAmount.equals sum ||
        (h.remainingQuantity.isZero &&
          (!h.remainingTotalBasis.isZero || !h.remainingValuationAllowance.isZero)))

/-- The layer a held row offers the cost calculation (line 1070). -/
def selectionLayer (row : InventoryOwnershipPoolRow) : InventoryLayerInput :=
  { id := row.holding.id.value, accountId := row.holding.accountId, acquiredAt := row.lot.acquiredAt,
    quantity := row.holding.remainingQuantity, totalBasis := row.holding.remainingTotalBasis }

/-- The loop of lines 1056 to 1071 from the evidence `work` counted so far, the holdings accepted
so far (`holdings`, newest first), the lot hashes seen (`lots`, newest first, so that `lookup` is
`lots.get`) and the layers so far: each row's lot evidence counted, the row tested, its lot's hash
compared with the one seen for the same lot, and its holding a layer when it holds something. -/
def selectionPoolLoop (bookId : BookId) (policy : InventoryCostPolicy)
    (request : InventoryOwnershipSelectionRequest) :
    Nat → List LotHolding → List (LotId × ContentHash) → List InventoryLayerInput →
      List InventoryOwnershipPoolRow →
        Except NumErr (OwnershipStep (List LotHolding × List InventoryLayerInput))
  | _, holdings, _, layers, [] => .ok (.proceed (holdings, layers))
  | work, holdings, lots, layers, row :: rest =>
    let work' := work + row.lot.evidenceIds.length
    if work' > cap then .ok (.rejected selectionEvidenceRejection)
    else
      match selectionRowInvalid bookId policy request holdings row with
      | .error e => .error e
      | .ok true => .ok (.rejected selectionPoolRejection)
      | .ok false =>
        let lotHash := hashCanonical (canonicalAccountingValue row.lot)
        if (match lots.lookup row.lot.id with
            | none => false
            | some prior => !contentHashEquals prior lotHash) then
          .ok (.rejected selectionLotConflictRejection)
        else
          selectionPoolLoop bookId policy request work' (row.holding :: holdings)
            ((row.lot.id, lotHash) :: lots)
            (if row.holding.remainingQuantity.isZero then layers else layers ++ [selectionLayer row])
            rest

/-- The test of lines 1075 to 1077: not one identity per computed allocation, a repeated holding,
allocation or movement identifier, or an empty allocation or movement identifier. -/
def selectionIdentitiesInvalid (request : InventoryOwnershipSelectionRequest)
    (allocations : List InventoryAllocationResult) : Bool :=
  request.identities.length != allocations.length ||
    hasDuplicates (request.identities.map (·.holdingId)) ||
    hasDuplicates (request.identities.map (·.allocationId)) ||
    hasDuplicates (request.identities.map (·.movementId)) ||
    request.identities.any (fun identity => decide (identity.allocationId.value.length = 0) ||
      decide (identity.movementId.value.length = 0))

/-- The loop of lines 1083 to 1095 with the running quantity, basis and allowance: each computed
allocation's identities (`identityByHolding.get`, which is the first identity of the holding: the
holdings of the identities were found distinct just before) and holding (`holdings.get(id)!`), its
fraction of the holding, its share of the holding's basis and allowance, and the totals. -/
def selectionAllocationLoop (request : InventoryOwnershipSelectionRequest)
    (holdings : List LotHolding) :
    ExactRational → ExactRational → ExactRational → List InventoryAllocationResult →
      Except InventoryOwnershipEffectErr (OwnershipStep
        (List InventoryReductionOperationAllocation × ExactRational × ExactRational × ExactRational))
  | quantity, basis, allowance, [] => .ok (.proceed ([], quantity, basis, allowance))
  | quantity, basis, allowance, selected :: rest =>
    let id : LotHoldingId := ⟨selected.layerId⟩
    match request.identities.find? (fun identity => identity.holdingId == id) with
    | none => .ok (.rejected selectionMissingIdentityRejection)
    | some identity =>
      match holdings.find? (fun held => held.id == id) with
      | none => .error .undefinedValue
      | some h =>
        match InventoryOwnershipEffectErr.ofExact (selected.quantity.divide h.remainingQuantity) with
        | .error e => .error e
        | .ok fraction =>
          match InventoryOwnershipEffectErr.ofExact (h.remainingTotalBasis.multiply fraction) with
          | .error e => .error e
          | .ok itemBasis =>
            match InventoryOwnershipEffectErr.ofExact
                (h.remainingValuationAllowance.multiply fraction) with
            | .error e => .error e
            | .ok itemAllowance =>
              match InventoryOwnershipEffectErr.ofExact (itemBasis.add itemAllowance) with
              | .error e => .error e
              | .ok carrying =>
                let allocation : LotAllocation :=
                  { id := identity.allocationId, holdingId := h.id, lotId := h.lotId,
                    allocatedQuantity := selected.quantity, allocatedTotalBasis := itemBasis,
                    allocatedValuationAllowance := itemAllowance,
                    allocatedCarryingAmount := carrying, derivation := request.derivation }
                let item : InventoryReductionOperationAllocation :=
                  { movementId := identity.movementId, allocation := allocation }
                match InventoryOwnershipEffectErr.ofExact (quantity.add selected.quantity) with
                | .error e => .error e
                | .ok quantity' =>
                  match InventoryOwnershipEffectErr.ofExact (basis.add itemBasis) with
                  | .error e => .error e
                  | .ok basis' =>
                    match InventoryOwnershipEffectErr.ofExact (allowance.add itemAllowance) with
                    | .error e => .error e
                    | .ok allowance' =>
                      match selectionAllocationLoop request holdings quantity' basis' allowance'
                          rest with
                      | .error e => .error e
                      | .ok (.rejected rejection) => .ok (.rejected rejection)
                      | .ok (.proceed (items, totals)) => .ok (.proceed (item :: items, totals))

/-- The request `calculateInventoryCost` is given (lines 1072 and 1073): the request's policy,
instant, quantity and specific layers, and the layers of the pool. -/
def selectionCostRequest (request : InventoryOwnershipSelectionRequest)
    (layers : List InventoryLayerInput) : InventoryCostRequest :=
  { policyId := request.policyId, policyVersion := request.policyVersion,
    governedAt := request.governedAt, quantity := request.quantity, layers := layers,
    specificLayerIds := request.specificLayerIds }

/-- Lines 1074 to 1104, after the cost is computed: the identities, the allocations, the
conservation test and the selection. -/
def selectionOfCost (policy : InventoryCostPolicy) (request : InventoryOwnershipSelectionRequest)
    (holdings : List LotHolding) (allocations : List InventoryAllocationResult)
    (ordinaryBasis provisionalQuantity provisionalBasis : ExactRational) :
    Except InventoryOwnershipEffectErr InventoryOwnershipSelectionResult :=
  if selectionIdentitiesInvalid request allocations then .ok (.rejected selectionIdentityRejection)
  else
    match selectionAllocationLoop request holdings ExactRational.zero ExactRational.zero
        ExactRational.zero allocations with
    | .error e => .error e
    | .ok (.rejected rejection) => .ok (.rejected rejection)
    | .ok (.proceed (items, quantity, basis, allowance)) =>
      match InventoryOwnershipEffectErr.ofExact (quantity.add provisionalQuantity) with
      | .error e => .error e
      | .ok total =>
        if !total.equals request.quantity || !basis.equals ordinaryBasis then
          .ok (.rejected selectionConservationRejection)
        else
          match InventoryOwnershipEffectErr.ofExact (basis.add allowance) with
          | .error e => .error e
          | .ok carrying =>
            .ok (.selected
              { inventoryPolicy := { policyId := policy.id, policyVersion := policy.version,
                                     policyContentHash := hashAccountingPolicy (.inventoryCost policy) },
                allocations := sortByText (·.allocation.holdingId.value) items,
                ordinaryQuantity := quantity, ordinaryBasis := basis,
                ordinaryValuationAllowance := allowance, ordinaryCarryingAmount := carrying,
                provisionalQuantity := provisionalQuantity, provisionalBasis := provisionalBasis })

end InventoryOwnershipEffects

open InventoryOwnershipEffects in
/-- `prepareInventoryOwnershipSelection` (line 1032): the bounds, the one applicable policy and the
derivation, the canonical pool, the cost calculation over the pool's layers under that policy alone,
the identities, the allocations of the holdings' exact economics and their conservation. -/
def prepareInventoryOwnershipSelection (policies : List AccountingPolicy) (bookId : BookId)
    (canonicalPool : List InventoryOwnershipPoolRow) (request : InventoryOwnershipSelectionRequest) :
    Except InventoryOwnershipEffectErr InventoryOwnershipSelectionResult :=
  if selectionBoundsExceeded policies canonicalPool request then
    .ok (.rejected selectionBoundsRejection)
  else
    match selectionMatches policies request with
    | [.inventoryCost policy] =>
      if selectionPolicyInvalid bookId policy request then .ok (.rejected selectionPolicyRejection)
      else
        match InventoryOwnershipEffectErr.ofExact
            (selectionPoolLoop bookId policy request 0 [] [] [] canonicalPool) with
        | .error e => .error e
        | .ok (.rejected rejection) => .ok (.rejected rejection)
        | .ok (.proceed (holdings, layers)) =>
          match InventoryOwnershipEffectErr.ofExact (calculateInventoryCost [.inventoryCost policy]
              bookId (selectionCostRequest request layers)) with
          | .error e => .error e
          | .ok (.rejected diagnostics) => .ok (.rejected ⟨diagnostics⟩)
          | .ok (.costed allocations ordinaryBasis provisionalQuantity provisionalBasis) =>
            selectionOfCost policy request holdings allocations ordinaryBasis provisionalQuantity
              provisionalBasis
    | _ => .ok (.rejected selectionPolicyRejection)

/-! ## `prepareInventoryOwnershipEffect` (lines 1238 to 1443) -/

/-- What `prepareInventoryOwnershipEffect` returns `prepared`: the effect, the new lots, and the
holdings and positions after it, in UTF-16 order of the holding identifiers. -/
structure InventoryOwnershipEffectPrepared where
  effect : InventoryOwnershipEffect
  newLots : List Lot
  afterHoldings : List LotHolding
  afterPositions : List InventoryPostedPosition
  deriving DecidableEq, Repr, Inhabited

/-- The result of `prepareInventoryOwnershipEffect` and
`prepareInventoryOwnershipEffectFromReadContext`: `prepared`, or `rejected`. -/
inductive InventoryOwnershipEffectResult where
  | prepared (prepared : InventoryOwnershipEffectPrepared)
  | rejected (rejection : OwnershipRejection)
  deriving DecidableEq, Repr, Inhabited

namespace InventoryOwnershipEffects

/-- Line 1246. -/
def effectBoundsRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.effect"
    "An ownership effect requires bounded sources, nonempty operations and a committed command origin"

/-- Line 1257. -/
def effectWorkRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.effect"
    "The complete effect's allocation and journal-source work must fit the operation bounds"

/-- Line 1262. -/
def effectAcquisitionWorkRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.effect"
    "The complete effect's acquisition source work exceeds its bound"

/-- Line 1267. -/
def effectTransferWorkRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.effect"
    "The complete effect's transfer source work exceeds its bound"

/-- Line 1272. -/
def effectAdoptionWorkRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.effect"
    "The complete effect's adoption source work exceeds its bound"

/-- Line 1281. -/
def effectSourceWorkRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.effect"
    "The complete effect's original source population exceeds its work bound"

/-- Line 1285. -/
def effectSourceRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.effectSource"
    "Original touched holdings require unique, matching ownership sources from a prior financial revision"

/-- Line 1299. -/
def effectAcquisitionIdentityRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.effectIdentity"
    "New acquisition anchors, holdings and lots cannot reuse prior or same-command identities"

/-- Line 1309. -/
def effectTransferIdentityRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.effectIdentity"
    "Transfer allocations, movements, anchors, holdings and lots cannot reuse prior or same-command identities"

/-- Line 1318. -/
def effectAdoptionIdentityRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.effectIdentity"
    "Adopted anchors, holdings and movements cannot reuse prior or same-command identities"

/-- Line 1325. -/
def effectReductionIdentityRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.effectIdentity"
    "Allocation and movement identities must be new and unique across the complete reduction effect"

/-- Line 1333. -/
def effectPostingIdentityRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.effectPostingIdentity"
    "An actual posting and its reference identity may be owned by only one complete reduction group"

/-- Line 1344. -/
def effectJournalSourceRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.effectJournalSource"
    "Every journal identity and effect locator must denote one identical source across the complete effect"

/-- Line 1390. -/
def effectTransferSourceRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.effectSource"
    "Every transfer allocation must resolve its original or internally updated current holding"

/-- Lines 1393 and 1422. -/
def effectRepeatedWorkRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.effect"
    "Repeated source verification across operations exceeds the effect's work bound"

/-- Line 1419. -/
def effectAllocationSourceRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.effectSource"
    "Every allocation must resolve its original or internally updated current holding"

/-- Line 1434. -/
def effectTouchedRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.effectSource"
    "An ownership effect's supplied original sources must be exactly its touched holding set"

open InventoryOwnership

/-- The size of an operation (lines 1164 and 1250): its entries, or its allocations. -/
def operationCount : InventoryOwnershipOperation → Nat
  | .reduction operation => operation.allocations.length
  | .acquisition operation => operation.entries.length
  | .transfer operation => operation.entries.length
  | .adopt operation => operation.entries.length

/-- The journal work of an operation (lines 1166 to 1169 and 1252 to 1255): the postings of its
journal sources; an adoption has none. -/
def operationJournalWork : InventoryOwnershipOperation → Nat
  | .reduction operation => linkPostingCount operation.journalLink
  | .acquisition operation => linkPostingCount operation.journalLink
  | .transfer operation =>
    linkPostingCount operation.sourceJournalLink + linkPostingCount operation.destinationJournalLink
  | .adopt _ => 0

/-- `link === undefined ? 0 : 1`. -/
def linkCount : Option InventoryPostedJournalLink → Nat
  | none => 0
  | some _ => 1

/-- The source work of an acquisition entry (lines 1173 and 1261): its evidence, its lot's
evidence identifiers, the operation's dimensions and its journal link. -/
def acquisitionEntryWork (operation : InventoryAcquisitionOperation)
    (entry : InventoryPostedAcquisitionEntry) : Nat :=
  entry.evidence.length + entry.lot.evidenceIds.length + operation.dimensionMemberIds.length +
    linkCount operation.journalLink

/-- The source work of a transfer entry (lines 1179 and 1266): its evidence, its destination lot's
evidence identifiers, the destination dimensions and the destination journal link. -/
def transferEntryWork (operation : InventoryTransferOperation)
    (entry : InventoryTransferOperationEntry) : Nat :=
  entry.evidence.length + entry.destinationLot.evidenceIds.length +
    operation.destinationDimensionMemberIds.length + linkCount operation.destinationJournalLink

/-- The source work of an adoption entry (lines 1186 and 1271): its evidence, its historical
postings and the operation's dimensions. -/
def adoptionEntryWork (operation : InventoryAdoptionOperation)
    (entry : InventoryPostedAdoptionEntry) : Nat :=
  entry.evidence.length + entry.historicalPostings.length + operation.dimensionMemberIds.length

/-- The source work of each entry of an operation (lines 1261, 1266 and 1271); a reduction counts
none here. -/
def operationEntryWork : InventoryOwnershipOperation → List Nat
  | .reduction _ => []
  | .acquisition operation => operation.entries.map (acquisitionEntryWork operation)
  | .transfer operation => operation.entries.map (transferEntryWork operation)
  | .adopt operation => operation.entries.map (adoptionEntryWork operation)

/-- The rejection of an operation's source work (lines 1262, 1267 and 1272); a reduction has no
entry work, so its case is never given. -/
def effectEntryWorkRejection : InventoryOwnershipOperation → OwnershipRejection
  | .reduction _ => effectWorkRejection
  | .acquisition _ => effectAcquisitionWorkRejection
  | .transfer _ => effectTransferWorkRejection
  | .adopt _ => effectAdoptionWorkRejection

/-- A running count from `work`: each value is added and the count is tested at once, the
rejection given as soon as it passes the bound. -/
def accumulateWork (rejection : OwnershipRejection) : Nat → List Nat → OwnershipStep Nat
  | work, [] => .proceed work
  | work, value :: rest =>
    if work + value > cap then .rejected rejection else accumulateWork rejection (work + value) rest

/-- The loop of lines 1249 to 1275 from the allocation count, journal work and source work so far:
each operation is nonempty and within the bounds, then its entries' source work is counted; the
source work at the end, which line 1280 goes on counting. -/
def effectWorkLoop : Nat → Nat → Nat → List InventoryOwnershipOperation → OwnershipStep Nat
  | _, _, sourceWork, [] => .proceed sourceWork
  | allocationCount, journalWork, sourceWork, operation :: rest =>
    let count := operationCount operation
    let allocationCount' := allocationCount + count
    let journalWork' := journalWork + operationJournalWork operation
    if decide (count = 0) || decide (allocationCount' > cap) || decide (journalWork' > cap) then
      .rejected effectWorkRejection
    else
      match accumulateWork (effectEntryWorkRejection operation) sourceWork
          (operationEntryWork operation) with
      | .rejected rejection => .rejected rejection
      | .proceed sourceWork' => effectWorkLoop allocationCount' journalWork' sourceWork' rest

/-- The test of lines 1282 to 1284 for one source: its holding, anchor or origin movement already
seen, a holding of another book, a position or anchor of another holding, or an anchor or origin
that is not from a revision before the candidate's. -/
def effectSourceInvalid (context : InventoryReductionEffectContext)
    (current : List (LotHoldingId × InventoryPostedReductionSource))
    (anchorIds : List InventoryPostedAnchorId) (priorMovementIds : List InventoryPostedMovementId)
    (source : InventoryPostedReductionSource) : Bool :=
  let anchor := source.anchor
  let position := source.position
  let holding := source.holding
  current.any (fun entry => entry.1 == holding.id) || decide (anchor.id ∈ anchorIds) ||
    decide (position.originMovementId ∈ priorMovementIds) || holding.bookId != context.bookId ||
    holding.id != position.holdingId || holding.id != anchor.coordinate.holdingId ||
    decide (anchor.bookRevision ≥ context.bookRevision) ||
    decide (position.originBookRevision ≥ context.bookRevision)

/-- The loop of lines 1278 to 1290 from the source work so far: each source counted and tested,
then recorded in `current`, with its anchor and its origin movement. -/
def effectSourcesLoop (context : InventoryReductionEffectContext) :
    Nat → List (LotHoldingId × InventoryPostedReductionSource) → List InventoryPostedAnchorId →
      List InventoryPostedMovementId → List InventoryPostedReductionSource →
        OwnershipStep (List (LotHoldingId × InventoryPostedReductionSource) ×
          List InventoryPostedAnchorId × List InventoryPostedMovementId)
  | _, current, anchorIds, priorMovementIds, [] => .proceed (current, anchorIds, priorMovementIds)
  | work, current, anchorIds, priorMovementIds, source :: rest =>
    let work' := work + anchorWork source.anchor
    if work' > cap then .rejected effectSourceWorkRejection
    else if effectSourceInvalid context current anchorIds priorMovementIds source then
      .rejected effectSourceRejection
    else
      effectSourcesLoop context work' (mapSet current source.holding.id source)
        (anchorIds ++ [source.anchor.id]) (priorMovementIds ++ [source.position.originMovementId])
        rest

/-- The sets and maps of lines 1291 to 1293 (with `anchorIds` of line 1277), carried through the
identity loop: a set is a list whose membership alone is read (newest first), and the two maps
are lists of pairs, newest first, so that `lookup` is `get`. -/
structure EffectIdentityState where
  allocations : List LotAllocationId
  movementIds : List InventoryPostedMovementId
  postingIds : List PostingId
  referenceIds : List CanonicalPostingReferenceId
  holdingIds : List LotHoldingId
  lotIds : List LotId
  anchorIds : List InventoryPostedAnchorId
  journalSources : List (JournalId × ContentHash)
  journalEffects : List (String × JournalId)
  deriving DecidableEq, Repr, Inhabited

/-- `sourceHash` (lines 1338 to 1341): `hashCanonical({ type: "InventoryReductionJournalSource",
value: canonicalAccountingValue({ journal: canonicalJournalValue(journal), commandId, effectKey,
bookRevision, fiscalPeriodId, canonicalHash }) })`, which is `accountingHash`. -/
def journalSourceHash (source : InventoryReductionJournalSource) : ContentHash :=
  accountingHash "InventoryReductionJournalSource"
    (object [member "journal" (canonicalJournalValue source.journal),
      member "commandId" source.commandId, member "effectKey" source.effectKey,
      member "bookRevision" source.bookRevision, member "fiscalPeriodId" source.fiscalPeriodId,
      member "canonicalHash" source.canonicalHash])

/-- `checkLink` (lines 1330 to 1349): no link passes; a link's posting and reference must be new,
and its journal must denote the same source as every earlier link to the same journal identifier,
and its effect key the same journal as every earlier link with that key. -/
def effectCheckLink (state : EffectIdentityState) :
    Option InventoryPostedJournalLink → OwnershipStep EffectIdentityState
  | none => .proceed state
  | some link =>
    if decide (link.postingId ∈ state.postingIds) ||
        decide (link.referenceId ∈ state.referenceIds) then
      .rejected effectPostingIdentityRejection
    else
      let source := link.source
      let sourceHash := journalSourceHash source
      if (match state.journalSources.lookup source.journal.id with
          | none => false
          | some previous => !contentHashEquals previous sourceHash) ||
          (match state.journalEffects.lookup source.effectKey with
          | none => false
          | some previousJournalId => previousJournalId != source.journal.id) then
        .rejected effectJournalSourceRejection
      else
        .proceed { state with
          postingIds := link.postingId :: state.postingIds
          referenceIds := link.referenceId :: state.referenceIds
          journalSources := (source.journal.id, sourceHash) :: state.journalSources
          journalEffects := (source.effectKey, source.journal.id) :: state.journalEffects }

/-- Lines 1296 to 1302: each acquisition entry's movement, anchor, holding and lot must be new. -/
def effectIdentityAcquisition (prior : List InventoryPostedMovementId) :
    EffectIdentityState → List InventoryPostedAcquisitionEntry → OwnershipStep EffectIdentityState
  | state, [] => .proceed state
  | state, item :: rest =>
    if decide (item.movementId ∈ state.movementIds) || decide (item.movementId ∈ prior) ||
        decide (item.anchorId ∈ state.anchorIds) || decide (item.holding.id ∈ state.holdingIds) ||
        decide (item.lot.id ∈ state.lotIds) then .rejected effectAcquisitionIdentityRejection
    else
      effectIdentityAcquisition prior { state with
        movementIds := item.movementId :: state.movementIds
        anchorIds := item.anchorId :: state.anchorIds
        holdingIds := item.holding.id :: state.holdingIds
        lotIds := item.lot.id :: state.lotIds } rest

/-- Lines 1304 to 1314: each transfer entry's two movements, destination anchor, holding and lot,
and allocation must be new. -/
def effectIdentityTransfer (prior : List InventoryPostedMovementId) :
    EffectIdentityState → List InventoryTransferOperationEntry → OwnershipStep EffectIdentityState
  | state, [] => .proceed state
  | state, item :: rest =>
    if decide (item.transferOutMovementId ∈ state.movementIds) ||
        decide (item.transferOutMovementId ∈ prior) ||
        decide (item.destinationMovementId ∈ state.movementIds) ||
        decide (item.destinationMovementId ∈ prior) ||
        decide (item.destinationAnchorId ∈ state.anchorIds) ||
        decide (item.destinationHolding.id ∈ state.holdingIds) ||
        decide (item.destinationLot.id ∈ state.lotIds) ||
        decide (item.allocation.id ∈ state.allocations) then
      .rejected effectTransferIdentityRejection
    else
      effectIdentityTransfer prior { state with
        movementIds := item.destinationMovementId :: item.transferOutMovementId :: state.movementIds
        anchorIds := item.destinationAnchorId :: state.anchorIds
        holdingIds := item.destinationHolding.id :: state.holdingIds
        lotIds := item.destinationLot.id :: state.lotIds
        allocations := item.allocation.id :: state.allocations } rest

/-- Lines 1316 to 1321: each adopted entry's movement, anchor and holding must be new. -/
def effectIdentityAdoption (prior : List InventoryPostedMovementId) :
    EffectIdentityState → List InventoryPostedAdoptionEntry → OwnershipStep EffectIdentityState
  | state, [] => .proceed state
  | state, item :: rest =>
    if decide (item.movementId ∈ state.movementIds) || decide (item.movementId ∈ prior) ||
        decide (item.anchorId ∈ state.anchorIds) || decide (item.holding.id ∈ state.holdingIds) then
      .rejected effectAdoptionIdentityRejection
    else
      effectIdentityAdoption prior { state with
        movementIds := item.movementId :: state.movementIds
        anchorIds := item.anchorId :: state.anchorIds
        holdingIds := item.holding.id :: state.holdingIds } rest

/-- Lines 1323 to 1328: each reduction allocation's movement and allocation must be new. -/
def effectIdentityReduction (prior : List InventoryPostedMovementId) :
    EffectIdentityState → List InventoryReductionOperationAllocation →
      OwnershipStep EffectIdentityState
  | state, [] => .proceed state
  | state, item :: rest =>
    if decide (item.movementId ∈ state.movementIds) || decide (item.movementId ∈ prior) ||
        decide (item.allocation.id ∈ state.allocations) then
      .rejected effectReductionIdentityRejection
    else
      effectIdentityReduction prior { state with
        movementIds := item.movementId :: state.movementIds
        allocations := item.allocation.id :: state.allocations } rest

/-- Lines 1295 to 1358 for one operation: its entries' identities, then its journal links (a
transfer's source link before its destination link; an adoption has none). -/
def effectIdentityOperation (prior : List InventoryPostedMovementId) (state : EffectIdentityState) :
    InventoryOwnershipOperation → OwnershipStep EffectIdentityState
  | .acquisition operation =>
    match effectIdentityAcquisition prior state operation.entries with
    | .rejected rejection => .rejected rejection
    | .proceed state' => effectCheckLink state' operation.journalLink
  | .transfer operation =>
    match effectIdentityTransfer prior state operation.entries with
    | .rejected rejection => .rejected rejection
    | .proceed state' =>
      match effectCheckLink state' operation.sourceJournalLink with
      | .rejected rejection => .rejected rejection
      | .proceed state'' => effectCheckLink state'' operation.destinationJournalLink
  | .adopt operation => effectIdentityAdoption prior state operation.entries
  | .reduction operation =>
    match effectIdentityReduction prior state operation.allocations with
    | .rejected rejection => .rejected rejection
    | .proceed state' => effectCheckLink state' operation.journalLink

/-- The loop of lines 1294 to 1359: each operation's identities in turn. -/
def effectIdentityLoop (prior : List InventoryPostedMovementId) :
    EffectIdentityState → List InventoryOwnershipOperation → OwnershipStep EffectIdentityState
  | state, [] => .proceed state
  | state, operation :: rest =>
    match effectIdentityOperation prior state operation with
    | .rejected rejection => .rejected rejection
    | .proceed state' => effectIdentityLoop prior state' rest

/-- What the construction loop (lines 1360 to 1433) carries: `current` (the source of each holding,
original or internally updated), `used`, the movements, new anchors and new lots in the order
pushed, and the repeated verification work. -/
structure EffectConstructionState where
  current : List (LotHoldingId × InventoryPostedReductionSource)
  used : List LotHoldingId
  movements : List InventoryPostedMovement
  newAnchors : List InventoryPostedAnchor
  newLots : List Lot
  reductionWork : Nat
  deriving DecidableEq, Repr, Inhabited

/-- Lines 1368 to 1371, 1379 to 1382 and 1408 to 1413: each new movement's holding and anchor
(`holdings[index]!`, `anchors[index]!`) recorded in `current` with the movement's after-position;
`none` where the holding or the anchor at the movement's index is absent. -/
def registerAcquired :
    List (LotHoldingId × InventoryPostedReductionSource) → List InventoryPostedAcquisitionMovement →
      List LotHolding → List InventoryPostedAnchor →
        Option (List (LotHoldingId × InventoryPostedReductionSource))
  | current, [], _, _ => some current
  | current, movement :: movements, holding :: holdings, anchor :: anchors =>
    registerAcquired
      (mapSet current holding.id
        { anchor := anchor, position := movement.afterPosition, holding := holding })
      movements holdings anchors
  | _, _ :: _, [], _ => none
  | _, _ :: _, _ :: _, [] => none

/-- Lines 1400 to 1405 and 1427 to 1432: each reduction movement's source (`current.get(...)!`)
updated in `current` with the movement's after-position and the group's holding at its index
(`afterHoldings[index]!`), and its holding marked used when it is an original one; `none` where the
source or the holding is absent. -/
def registerReduced (originalIds : List LotHoldingId) :
    List (LotHoldingId × InventoryPostedReductionSource) → List LotHoldingId →
      List InventoryPostedReductionMovement → List LotHolding →
        Option (List (LotHoldingId × InventoryPostedReductionSource) × List LotHoldingId)
  | current, used, [], _ => some (current, used)
  | current, used, movement :: movements, holdings =>
    match current.lookup movement.coordinate.holdingId, holdings with
    | some source, holding :: holdings' =>
      registerReduced originalIds
        (mapSet current source.holding.id
          { anchor := source.anchor, position := movement.afterPosition, holding := holding })
        (if source.holding.id ∈ originalIds then source.holding.id :: used else used)
        movements holdings'
    | _, _ => none

/-- Lines 1417 to 1424 from the repeated `work` so far: each allocation's current source, its
anchor's work counted, and the entry of the source and the allocation. -/
def effectReductionEntries (current : List (LotHoldingId × InventoryPostedReductionSource)) :
    Nat → List InventoryReductionOperationAllocation →
      OwnershipStep (List InventoryPostedReductionEntry × Nat)
  | work, [] => .proceed ([], work)
  | work, item :: rest =>
    match current.lookup item.allocation.holdingId with
    | none => .rejected effectAllocationSourceRejection
    | some source =>
      let work' := work + anchorWork source.anchor
      if work' > cap then .rejected effectRepeatedWorkRejection
      else
        match effectReductionEntries current work' rest with
        | .rejected rejection => .rejected rejection
        | .proceed (entries, total) =>
          .proceed ({ movementId := item.movementId, anchor := source.anchor,
                      position := source.position, holding := source.holding,
                      allocation := item.allocation } :: entries, total)

/-- Lines 1388 to 1395 from the repeated `work` so far: each transfer entry's current source, its
anchor's work counted, and the transfer entry with its source. -/
def effectTransferEntries (current : List (LotHoldingId × InventoryPostedReductionSource)) :
    Nat → List InventoryTransferOperationEntry →
      OwnershipStep (List InventoryPostedTransferEntry × Nat)
  | work, [] => .proceed ([], work)
  | work, item :: rest =>
    match current.lookup item.allocation.holdingId with
    | none => .rejected effectTransferSourceRejection
    | some source =>
      let work' := work + anchorWork source.anchor
      if work' > cap then .rejected effectRepeatedWorkRejection
      else
        match effectTransferEntries current work' rest with
        | .rejected rejection => .rejected rejection
        | .proceed (entries, total) =>
          .proceed ({ source := source, allocation := item.allocation,
                      transferOutMovementId := item.transferOutMovementId,
                      destinationAnchorId := item.destinationAnchorId,
                      destinationMovementId := item.destinationMovementId,
                      destinationHolding := item.destinationHolding,
                      destinationLot := item.destinationLot, evidence := item.evidence } :: entries,
            total)

/-- `{ ...context, firstArtifactOrdinal }` (line 1363): the next ordinal after the movements and
anchors so far. -/
def effectGroupContext (context : InventoryReductionEffectContext)
    (state : EffectConstructionState) : InventoryPostedGroupContext :=
  { toInventoryReductionEffectContext := context,
    firstArtifactOrdinal := ((state.movements.length + state.newAnchors.length : Nat) : Int) + 1 }

/-- Lines 1364 to 1374: an acquisition group prepared at the next ordinal, its new holdings
recorded, its anchors, lots and movements pushed. -/
def effectConstructAcquisition (context : InventoryReductionEffectContext)
    (state : EffectConstructionState) (operation : InventoryAcquisitionOperation) :
    Except InventoryOwnershipEffectErr (OwnershipStep EffectConstructionState) :=
  match InventoryOwnershipEffectErr.ofOwnership (prepareInventoryPostedAcquisitionGroup
      { toInventoryPostedGroupContext := effectGroupContext context state,
        toInventoryPostedAcquisitionTerms := operation.toInventoryPostedAcquisitionTerms }
      operation.entries operation.journalLink) with
  | .error e => .error e
  | .ok (.rejected rejection) => .ok (.rejected rejection)
  | .ok (.prepared group) =>
    match registerAcquired state.current group.movements group.holdings group.anchors with
    | none => .error .undefinedValue
    | some current =>
      .ok (.proceed { state with
        current := current
        newAnchors := state.newAnchors ++ group.anchors
        newLots := state.newLots ++ group.lots
        movements := state.movements ++ group.movements.map .acquisition })

/-- Lines 1375 to 1385: an adoption group prepared at the next ordinal, its holdings recorded,
its anchors and movements pushed. -/
def effectConstructAdoption (context : InventoryReductionEffectContext)
    (state : EffectConstructionState) (operation : InventoryAdoptionOperation) :
    Except InventoryOwnershipEffectErr (OwnershipStep EffectConstructionState) :=
  match InventoryOwnershipEffectErr.ofOwnership (prepareInventoryPostedAdoptionGroup
      { toInventoryPostedAcquisitionContext :=
          { toInventoryPostedGroupContext := effectGroupContext context state,
            toInventoryPostedAcquisitionTerms := operation.toInventoryPostedAcquisitionTerms } }
      operation.entries operation.postedBalance) with
  | .error e => .error e
  | .ok (.rejected rejection) => .ok (.rejected rejection)
  | .ok (.prepared group) =>
    match registerAcquired state.current group.movements group.holdings group.anchors with
    | none => .error .undefinedValue
    | some current =>
      .ok (.proceed { state with
        current := current
        newAnchors := state.newAnchors ++ group.anchors
        movements := state.movements ++ group.movements.map .acquisition })

/-- Lines 1386 to 1415: the transfer entries resolved against `current`, the group prepared at the
next ordinal, its sources updated and marked used, its transfer-out movements pushed, its anchors
and lots pushed, its destination holdings recorded and its destination movements pushed. -/
def effectConstructTransfer (context : InventoryReductionEffectContext)
    (originalIds : List LotHoldingId) (state : EffectConstructionState)
    (operation : InventoryTransferOperation) :
    Except InventoryOwnershipEffectErr (OwnershipStep EffectConstructionState) :=
  match effectTransferEntries state.current state.reductionWork operation.entries with
  | .rejected rejection => .ok (.rejected rejection)
  | .proceed (entries, work) =>
    match InventoryOwnershipEffectErr.ofOwnership (prepareInventoryPostedTransferGroup
        { toInventoryPostedGroupContext := effectGroupContext context state,
          toInventoryPostedTransferDestinationTerms :=
            operation.toInventoryPostedTransferDestinationTerms }
        entries operation.sourceJournalLink operation.destinationJournalLink) with
    | .error e => .error e
    | .ok (.rejected rejection) => .ok (.rejected rejection)
    | .ok (.prepared group) =>
      match registerReduced originalIds state.current state.used group.transferOutMovements
          group.afterSourceHoldings with
      | none => .error .undefinedValue
      | some (current, used) =>
        match registerAcquired current group.destinationMovements group.destinationHoldings
            group.destinationAnchors with
        | none => .error .undefinedValue
        | some current' =>
          .ok (.proceed
            { current := current', used := used,
              movements := state.movements ++ group.transferOutMovements.map .reduction ++
                group.destinationMovements.map .acquisition,
              newAnchors := state.newAnchors ++ group.destinationAnchors,
              newLots := state.newLots ++ group.destinationLots, reductionWork := work })

/-- Lines 1416 to 1432: the allocations resolved against `current`, the group prepared at the next
ordinal, its sources updated and marked used, its movements pushed. -/
def effectConstructReduction (context : InventoryReductionEffectContext)
    (originalIds : List LotHoldingId) (state : EffectConstructionState)
    (operation : InventoryReductionOperation) :
    Except InventoryOwnershipEffectErr (OwnershipStep EffectConstructionState) :=
  match effectReductionEntries state.current state.reductionWork operation.allocations with
  | .rejected rejection => .ok (.rejected rejection)
  | .proceed (entries, work) =>
    match InventoryOwnershipEffectErr.ofOwnership (prepareInventoryPostedReductionGroup
        { toInventoryPostedGroupContext := effectGroupContext context state, kind := operation.kind }
        entries operation.journalLink) with
    | .error e => .error e
    | .ok (.rejected rejection) => .ok (.rejected rejection)
    | .ok (.prepared group) =>
      match registerReduced originalIds state.current state.used group.movements
          group.afterHoldings with
      | none => .error .undefinedValue
      | some (current, used) =>
        .ok (.proceed { state with
          current := current, used := used,
          movements := state.movements ++ group.movements.map .reduction, reductionWork := work })

/-- Lines 1363 to 1432 for one operation, by its kind. -/
def effectConstructOperation (context : InventoryReductionEffectContext)
    (originalIds : List LotHoldingId) (state : EffectConstructionState) :
    InventoryOwnershipOperation →
      Except InventoryOwnershipEffectErr (OwnershipStep EffectConstructionState)
  | .acquisition operation => effectConstructAcquisition context state operation
  | .adopt operation => effectConstructAdoption context state operation
  | .transfer operation => effectConstructTransfer context originalIds state operation
  | .reduction operation => effectConstructReduction context originalIds state operation

/-- The loop of lines 1362 to 1433: each operation constructed in turn. -/
def effectConstructionLoop (context : InventoryReductionEffectContext)
    (originalIds : List LotHoldingId) :
    EffectConstructionState → List InventoryOwnershipOperation →
      Except InventoryOwnershipEffectErr (OwnershipStep EffectConstructionState)
  | state, [] => .ok (.proceed state)
  | state, operation :: rest =>
    match effectConstructOperation context originalIds state operation with
    | .error e => .error e
    | .ok (.rejected rejection) => .ok (.rejected rejection)
    | .ok (.proceed state') => effectConstructionLoop context originalIds state' rest

/-- The test of lines 1244 and 1245: too many sources, no operation or too many, or an origin that
is not committed. -/
def effectBoundsInvalid (context : InventoryReductionEffectContext)
    (sources : List InventoryPostedReductionSource) (operations : List InventoryOwnershipOperation) :
    Bool :=
  decide (sources.length > cap) || decide (operations.length = 0) ||
    decide (operations.length > cap) || decide (context.bookRevision ≤ 0) ||
    decide (context.effectKey.value.length = 0) || decide (context.commandId.value.length = 0)

/-- The identity state the loop of line 1294 starts from: the original holdings and their lots,
and the anchors of the sources. -/
def effectInitialIdentities (sources : List InventoryPostedReductionSource)
    (current : List (LotHoldingId × InventoryPostedReductionSource))
    (anchorIds : List InventoryPostedAnchorId) : EffectIdentityState :=
  { allocations := [], movementIds := [], postingIds := [], referenceIds := [],
    holdingIds := current.map (·.1), lotIds := sources.map (·.holding.lotId),
    anchorIds := anchorIds, journalSources := [], journalEffects := [] }

end InventoryOwnershipEffects

/-- `movement.monetaryKind === "journalLinked"` (line 1437): the movement as a journal-linked one. -/
def InventoryPostedMovement.journalLinked? :
    InventoryPostedMovement → Option JournalLinkedInventoryPostedMovement
  | .reduction (.journalLinked movement) => some (.reduction movement)
  | .acquisition (.journalLinked movement) => some (.acquisition movement)
  | _ => none

/-- `movement.monetaryKind === "quantityOnly"` (line 1438): the movement as a quantity-only one. -/
def InventoryPostedMovement.quantityOnly? :
    InventoryPostedMovement → Option QuantityOnlyInventoryPostedMovement
  | .reduction (.quantityOnly movement) => some (.reduction movement)
  | .acquisition (.quantityOnly movement) => some (.acquisition movement)
  | _ => none

namespace InventoryOwnershipEffects

/-- Lines 1434 to 1442, after the construction loop: the touched-set test, then the effect and the
holdings and positions after it, sorted by holding identifier. -/
def effectOfConstruction (context : InventoryReductionEffectContext)
    (sources : List InventoryPostedReductionSource) (state : EffectConstructionState) :
    InventoryOwnershipEffectResult :=
  if Lots.setSize state.used != sources.length then .rejected effectTouchedRejection
  else
    let body : InventoryOwnershipEffectBody :=
      { effectKey := context.effectKey, bookRevision := context.bookRevision,
        newAnchors := state.newAnchors,
        journalLinkedMovements := state.movements.filterMap InventoryPostedMovement.journalLinked?,
        quantityOnlyMovements := state.movements.filterMap InventoryPostedMovement.quantityOnly? }
    let ordered := InventoryOwnership.sortByText (·.holding.id.value) (state.current.map (·.2))
    .prepared
      { effect := { toInventoryOwnershipEffectBody := body,
                    contentHash := hashInventoryOwnershipEffect body },
        newLots := state.newLots, afterHoldings := ordered.map (·.holding),
        afterPositions := ordered.map (·.position) }

end InventoryOwnershipEffects

open InventoryOwnershipEffects in
/-- `prepareInventoryOwnershipEffect` (line 1238): the bounds, the work of the operations, the
original sources, the identities and journal sources of the whole effect, each operation's group
prepared in order on the sources as the earlier operations left them, the touched-set test, and the
effect with its hash. -/
def prepareInventoryOwnershipEffect (context : InventoryReductionEffectContext)
    (sources : List InventoryPostedReductionSource) (operations : List InventoryOwnershipOperation) :
    Except InventoryOwnershipEffectErr InventoryOwnershipEffectResult :=
  if effectBoundsInvalid context sources operations then .ok (.rejected effectBoundsRejection)
  else
    match effectWorkLoop 0 0 0 operations with
    | .rejected rejection => .ok (.rejected rejection)
    | .proceed sourceWork =>
      match effectSourcesLoop context sourceWork [] [] [] sources with
      | .rejected rejection => .ok (.rejected rejection)
      | .proceed (current, anchorIds, priorMovementIds) =>
        match effectIdentityLoop priorMovementIds
            (effectInitialIdentities sources current anchorIds) operations with
        | .rejected rejection => .ok (.rejected rejection)
        | .proceed _ =>
          match effectConstructionLoop context (current.map (·.1))
              { current := current, used := [], movements := [], newAnchors := [], newLots := [],
                reductionWork := 0 } operations with
          | .error e => .error e
          | .ok (.rejected rejection) => .ok (.rejected rejection)
          | .ok (.proceed state) => .ok (effectOfConstruction context sources state)

/-! ## `prepareInventoryOwnershipEffectFromReadContext` (lines 1152 to 1206) -/

namespace InventoryOwnershipEffects

open InventoryOwnership

/-- Line 1159. -/
def readContextScopeRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.readSet"
    "Candidate reduction must immediately follow the pinned book revision with bounded operations"

/-- Line 1170. -/
def readContextWorkRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.readSet"
    "Candidate allocation and journal populations exceed the read-work bound"

/-- Lines 1174 and 1180. -/
def readContextAcquisitionRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.readSet"
    "Candidate acquisition sources exceed the read-work bound"

/-- Line 1187. -/
def readContextAdoptionRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.readSet"
    "Candidate adoption sources exceed the read-work bound"

/-- Lines 1172 to 1176 and 1185 to 1189 from the acquisition `work` so far and the holdings
`created` so far (newest first): each entry's work counted and tested, then its new holding
created. -/
def readContextCreate (rejection : OwnershipRejection) :
    Nat → List LotHoldingId → List (Nat × LotHoldingId) → OwnershipStep (Nat × List LotHoldingId)
  | work, created, [] => .proceed (work, created)
  | work, created, (entryWork, id) :: rest =>
    if work + entryWork > cap then .rejected rejection
    else readContextCreate rejection (work + entryWork) (id :: created) rest

/-- Lines 1178 to 1183 from the acquisition `work`, the holdings to read (`ids`, in insertion
order) and the holdings created so far: each entry's work counted and tested, its destination
created, and its source holding read unless created in this candidate. -/
def readContextTransfer :
    Nat → List LotHoldingId → List LotHoldingId → List (Nat × LotHoldingId × LotHoldingId) →
      OwnershipStep (Nat × List LotHoldingId × List LotHoldingId)
  | work, ids, created, [] => .proceed (work, ids, created)
  | work, ids, created, (entryWork, destination, source) :: rest =>
    if work + entryWork > cap then .rejected readContextAcquisitionRejection
    else
      let created' := destination :: created
      readContextTransfer (work + entryWork)
        (if source ∈ created' then ids else setAdd ids source) created' rest

/-- Line 1191: each allocation's holding read unless created in this candidate. -/
def readContextReads (created : List LotHoldingId) :
    List LotHoldingId → List LotHoldingId → List LotHoldingId
  | ids, [] => ids
  | ids, id :: rest => readContextReads created (if id ∈ created then ids else setAdd ids id) rest

/-- The loop of lines 1163 to 1193 from the allocation, journal and acquisition work so far, the
holdings to read and the holdings created: the holdings this candidate reads, in the order first
named. -/
def readContextLoop :
    Nat → Nat → Nat → List LotHoldingId → List LotHoldingId → List InventoryOwnershipOperation →
      OwnershipStep (List LotHoldingId)
  | _, _, _, ids, _, [] => .proceed ids
  | allocationWork, journalWork, acquisitionWork, ids, created, operation :: rest =>
    let count := operationCount operation
    let allocationWork' := allocationWork + count
    let journalWork' := journalWork + operationJournalWork operation
    if decide (count = 0) || decide (allocationWork' > cap) || decide (journalWork' > cap) then
      .rejected readContextWorkRejection
    else
      match operation with
      | .acquisition op =>
        match readContextCreate readContextAcquisitionRejection acquisitionWork created
            (op.entries.map fun entry => (acquisitionEntryWork op entry, entry.holding.id)) with
        | .rejected rejection => .rejected rejection
        | .proceed (work, created') =>
          readContextLoop allocationWork' journalWork' work ids created' rest
      | .transfer op =>
        match readContextTransfer acquisitionWork ids created
            (op.entries.map fun entry => (transferEntryWork op entry,
              entry.destinationHolding.id, entry.allocation.holdingId)) with
        | .rejected rejection => .rejected rejection
        | .proceed (work, ids', created') =>
          readContextLoop allocationWork' journalWork' work ids' created' rest
      | .adopt op =>
        match readContextCreate readContextAdoptionRejection acquisitionWork created
            (op.entries.map fun entry => (adoptionEntryWork op entry, entry.holding.id)) with
        | .rejected rejection => .rejected rejection
        | .proceed (work, created') =>
          readContextLoop allocationWork' journalWork' work ids created' rest
      | .reduction op =>
        readContextLoop allocationWork' journalWork' acquisitionWork
          (readContextReads created ids (op.allocations.map (·.allocation.holdingId))) created rest

/-- The test of line 1158: the candidate is not of the pinned book, not the revision right after
the pinned one, or has no operation or too many. -/
def readContextScopeInvalid (reader : InventoryOwnershipReadContext)
    (context : InventoryReductionEffectContext) (operations : List InventoryOwnershipOperation) :
    Bool :=
  context.bookId != reader.bookId || context.bookRevision != reader.bookRevision + 1 ||
    decide (operations.length = 0) || decide (operations.length > cap)

/-- Lines 1200 to 1205, after the holdings to read are known: they are resolved (none when there
is none), `guardCandidate`, the rejection, the effect, and `guardCandidate`. -/
def readContextPrepare (reader : InventoryOwnershipReadContext)
    (context : InventoryReductionEffectContext) (operations : List InventoryOwnershipOperation)
    (ids : List LotHoldingId) :
    Except InventoryOwnershipEffectErr InventoryOwnershipEffectResult :=
  let resolved : Except InventoryOwnershipEffectErr InventoryOwnershipSourceResolution :=
    if ids.isEmpty then .ok (.resolved []) else resolveInventoryOwnershipSources reader ids
  match resolved with
  | .error e => .error e
  | .ok resolution =>
    match readGuard reader with
    | .error e => .error e
    | .ok _ =>
      match resolution with
      | .rejected rejection => .ok (.rejected rejection)
      | .resolved sources =>
        match prepareInventoryOwnershipEffect context sources operations with
        | .error e => .error e
        | .ok result =>
          match readGuard reader with
          | .error e => .error e
          | .ok _ => .ok result

end InventoryOwnershipEffects

open InventoryOwnershipEffects in
/-- `prepareInventoryOwnershipEffectFromReadContext` (line 1152): `assertCurrent`, the scope, the
work bounds and the holdings to read (those no earlier operation of the candidate creates), their
resolution through the read context, and the effect of `prepareInventoryOwnershipEffect` on them;
`immutableAccountingValue` of the candidate is the candidate here. -/
def prepareInventoryOwnershipEffectFromReadContext (reader : InventoryOwnershipReadContext)
    (context : InventoryReductionEffectContext) (operations : List InventoryOwnershipOperation) :
    Except InventoryOwnershipEffectErr InventoryOwnershipEffectResult :=
  match InventoryOwnershipEffectErr.ofRead (reader.assertCurrent ()) with
  | .error e => .error e
  | .ok _ =>
    if readContextScopeInvalid reader context operations then
      .ok (.rejected readContextScopeRejection)
    else
      match readContextLoop 0 0 0 [] [] operations with
      | .rejected rejection => .ok (.rejected rejection)
      | .proceed ids => readContextPrepare reader context operations ids

/-! ## The reduction-only API (lines 1137 to 1146 and 1220 to 1232) -/

/-- A journal-linked movement as a reduction movement, when it is one. -/
def JournalLinkedInventoryPostedMovement.asReduction? :
    JournalLinkedInventoryPostedMovement → Option JournalLinkedInventoryReductionMovement
  | .reduction movement => some movement
  | .acquisition _ => none

/-- A quantity-only movement as a reduction movement, when it is one. -/
def QuantityOnlyInventoryPostedMovement.asReduction? :
    QuantityOnlyInventoryPostedMovement → Option QuantityOnlyInventoryReductionMovement
  | .reduction movement => some movement
  | .acquisition _ => none

/-- Every movement of a list as a reduction movement, when every one is. -/
def journalLinkedReductions? :
    List JournalLinkedInventoryPostedMovement → Option (List JournalLinkedInventoryReductionMovement)
  | [] => some []
  | movement :: rest =>
    match movement.asReduction?, journalLinkedReductions? rest with
    | some reduction, some reductions => some (reduction :: reductions)
    | _, _ => none

/-- Every movement of a list as a reduction movement, when every one is. -/
def quantityOnlyReductions? :
    List QuantityOnlyInventoryPostedMovement → Option (List QuantityOnlyInventoryReductionMovement)
  | [] => some []
  | movement :: rest =>
    match movement.asReduction?, quantityOnlyReductions? rest with
    | some reduction, some reductions => some (reduction :: reductions)
    | _, _ => none

/-- The unchecked cast `effect as InventoryReductionOwnershipEffect` (lines 1145 and 1230), as a
partial function: the same effect with its movements as reduction movements, defined exactly when
every movement is one. Where some movement is an acquisition movement, the TypeScript cast would
return the effect under a type that does not describe it. -/
def InventoryOwnershipEffect.asReductionEffect? (effect : InventoryOwnershipEffect) :
    Option InventoryReductionOwnershipEffect :=
  match journalLinkedReductions? effect.journalLinkedMovements,
      quantityOnlyReductions? effect.quantityOnlyMovements with
  | some journalLinked, some quantityOnly =>
    some { effectKey := effect.effectKey, bookRevision := effect.bookRevision,
           newAnchors := effect.newAnchors, journalLinkedMovements := journalLinked,
           quantityOnlyMovements := quantityOnly, contentHash := effect.contentHash }
  | _, _ => none

/-- What the reduction-only API returns `prepared`: the effect, and the holdings and positions after
it (no new lots). -/
structure InventoryReductionEffectPrepared where
  effect : InventoryReductionOwnershipEffect
  afterHoldings : List LotHolding
  afterPositions : List InventoryPostedPosition
  deriving DecidableEq, Repr, Inhabited

/-- The result of `prepareInventoryReductionEffect` and
`prepareInventoryReductionEffectFromReadContext`: `prepared`, or `rejected`. -/
inductive InventoryReductionEffectResult where
  | prepared (prepared : InventoryReductionEffectPrepared)
  | rejected (rejection : OwnershipRejection)
  deriving DecidableEq, Repr, Inhabited

namespace InventoryOwnershipEffects

/-- Line 1144. -/
def reductionOnlyAcquisitionRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.groupIdentity"
    "The reduction-only API cannot admit acquisition effects"

/-- Line 1225. -/
def reductionEffectBoundsRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.effect"
    "A reduction effect requires bounded nonempty sources/operations and a committed command origin"

/-- Line 1226: never given here, since every operation of the reduction-only API is a disposal or
a transfer out. -/
def reductionOnlyKindRejection : OwnershipRejection :=
  InventoryOwnership.reject "inventoryOwnership.groupIdentity"
    "The reduction-only API cannot admit another ownership transition kind"

/-- The test of line 1225: no source, or too many sources or operations. -/
def reductionEffectBoundsInvalid (sources : List InventoryPostedReductionSource)
    (operations : List InventoryReductionOperation) : Bool :=
  decide (sources.length = 0) || decide (sources.length > InventoryOwnership.cap) ||
    decide (operations.length > InventoryOwnership.cap)

/-- The prepared ownership effect through the cast of lines 1145 and 1230. -/
def narrowPrepared (prepared : InventoryOwnershipEffectPrepared) :
    Except InventoryOwnershipEffectErr InventoryReductionEffectResult :=
  match prepared.effect.asReductionEffect? with
  | none => .error .uncheckedCast
  | some effect =>
    .ok (.prepared { effect := effect, afterHoldings := prepared.afterHoldings,
                     afterPositions := prepared.afterPositions })

end InventoryOwnershipEffects

open InventoryOwnershipEffects in
/-- `prepareInventoryReductionEffect` (line 1220): the bounds (the kind test always passes), then
`prepareInventoryOwnershipEffect` of the same operations, its effect cast to a reduction effect and
its new lots dropped. -/
def prepareInventoryReductionEffect (context : InventoryReductionEffectContext)
    (sources : List InventoryPostedReductionSource) (operations : List InventoryReductionOperation) :
    Except InventoryOwnershipEffectErr InventoryReductionEffectResult :=
  if reductionEffectBoundsInvalid sources operations then
    .ok (.rejected reductionEffectBoundsRejection)
  else
    match prepareInventoryOwnershipEffect context sources (operations.map .reduction) with
    | .error e => .error e
    | .ok (.rejected rejection) => .ok (.rejected rejection)
    | .ok (.prepared prepared) => narrowPrepared prepared

open InventoryOwnershipEffects in
/-- `prepareInventoryReductionEffectFromReadContext` (line 1137): the effect of
`prepareInventoryOwnershipEffectFromReadContext` of the same operations, rejected when it has new
anchors, cast to a reduction effect, its new lots dropped. -/
def prepareInventoryReductionEffectFromReadContext (reader : InventoryOwnershipReadContext)
    (context : InventoryReductionEffectContext) (operations : List InventoryReductionOperation) :
    Except InventoryOwnershipEffectErr InventoryReductionEffectResult :=
  match prepareInventoryOwnershipEffectFromReadContext reader context (operations.map .reduction) with
  | .error e => .error e
  | .ok (.rejected rejection) => .ok (.rejected rejection)
  | .ok (.prepared prepared) =>
    if prepared.effect.newAnchors.length != 0 then .ok (.rejected reductionOnlyAcquisitionRejection)
    else narrowPrepared prepared

end Rastrata.Kernel

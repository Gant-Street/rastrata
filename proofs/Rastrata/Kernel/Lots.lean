/-
Lots: the Lean model of `packages/kernel/src/lots.ts` and the proofs of its laws.

Every exported member of the TypeScript has a definition of the same name in `Rastrata.Kernel`.
The members the TypeScript keeps to itself (`reject`, `compareText`, `validateHoldings`) and the
pieces a loop or a closure is cut into are in `Rastrata.Kernel.Lots`, so that they cannot meet a
member of the same name in another file.

What is assumed about JavaScript, and what is not modelled:

- A `Map` built from entries answers `get` with the value of the last entry that has the key, and a
  `Set` counts each value once (`Lots.mapGet`, `Lots.setSize`).
- `Array.prototype.sort` is stable and, for a comparator that is a consistent order, returns the one
  stable arrangement. It is modelled as an insertion sort (`Lots.stableSort`). Which pairs the engine
  compares is its own business, and it shows in one place only: see `Lots.compareCandidates`.
- `Date.parse` on an `Instant` is `dateParse` of the vocabulary; a text it does not read is `NaN`
  there, and a comparison with `NaN` is false (`Lots.dateParseLe`, `Lots.dateParseLt`).
- The run-time test `holding.remainingQuantity === undefined || ...` at the head of
  `validateHoldings` (`lots.ts` line 97) is on four fields the type `LotHolding` already guarantees,
  so it always passes here and its diagnostic is never produced.
- `Object.freeze` and the identity of objects are not modelled.
- Message texts are carried in full, as the TypeScript writes them.
-/
import Rastrata.Prelude
import Rastrata.Kernel.Numeric
import Rastrata.Kernel.NumericLimits
import Rastrata.Kernel.Canonical
import Rastrata.Kernel.Journal.Types
import Rastrata.Kernel.Policy.Types
import Std.Data.String.ToNat

namespace Rastrata.Kernel

/-! ## Types (`lots.ts` lines 13 to 78) -/

/-- `LotId`. -/
abbrev LotId := Identifier "Lot"

/-- `LotHoldingId`. -/
abbrev LotHoldingId := Identifier "LotHolding"

/-- `LotAllocationId`. -/
abbrev LotAllocationId := Identifier "LotAllocation"

/-- `lotId`. -/
def lotId (value : String) : Except CanonicalErr LotId := identifier "Lot" value

/-- `lotHoldingId`. -/
def lotHoldingId (value : String) : Except CanonicalErr LotHoldingId :=
  identifier "LotHolding" value

/-- `lotAllocationId`. -/
def lotAllocationId (value : String) : Except CanonicalErr LotAllocationId :=
  identifier "LotAllocation" value

/-- `Lot`. -/
structure Lot where
  id : LotId
  bookId : BookId
  commodityId : CommodityId
  acquiredAt : Instant
  acquisitionQuantity : ExactRational
  acquisitionTotalBasis : ExactRational
  basisCommodityId : CommodityId
  evidenceIds : List String
  deriving DecidableEq, Repr, Inhabited

/-- `LotHolding`. -/
structure LotHolding where
  id : LotHoldingId
  bookId : BookId
  lotId : LotId
  accountId : AccountId
  commodityId : CommodityId
  basisCommodityId : CommodityId
  remainingQuantity : ExactRational
  remainingTotalBasis : ExactRational
  remainingValuationAllowance : ExactRational
  remainingCarryingAmount : ExactRational
  deriving DecidableEq, Repr, Inhabited

/-- `LotAllocation`. -/
structure LotAllocation where
  id : LotAllocationId
  holdingId : LotHoldingId
  lotId : LotId
  allocatedQuantity : ExactRational
  allocatedTotalBasis : ExactRational
  allocatedValuationAllowance : ExactRational
  allocatedCarryingAmount : ExactRational
  derivation : DerivationRecord
  deriving DecidableEq, Repr, Inhabited

/-- The element type of `LotSelection.allocations`, unnamed in the TypeScript. -/
structure SpecificAllocation where
  holdingId : LotHoldingId
  quantity : ExactRational
  deriving DecidableEq, Repr, Inhabited

/-- `LotSelection`. -/
inductive LotSelection where
  | specificIdentification (allocations : List SpecificAllocation)
  | fifo
  | lifo
  | hifo
  | weightedAverage
  deriving DecidableEq, Repr, Inhabited

/-- `selection.method`. -/
def LotSelection.method : LotSelection → LotSelectionMethod
  | .specificIdentification _ => .specificIdentification
  | .fifo => .fifo
  | .lifo => .lifo
  | .hifo => .hifo
  | .weightedAverage => .weightedAverage

/-- `LotAllocationResult`: the two dispositions, `allocated` and `rejected`. -/
inductive LotAllocationResult where
  | allocated (allocations : List LotAllocation) (holdings : List LotHolding)
  | rejected (diagnostics : List SemanticDiagnostic)
  deriving DecidableEq, Repr, Inhabited

/-- `LotAllocationIdentity`. -/
structure LotAllocationIdentity where
  holdingId : LotHoldingId
  allocationId : LotAllocationId
  deriving DecidableEq, Repr, Inhabited

namespace Lots

/-! ## What the TypeScript takes from JavaScript -/

/-- `new Set(values).size`: the number of different values. -/
def setSize {α : Type} [DecidableEq α] (values : List α) : Nat := values.dedup.length

/-- `new Map(entries).get(key)`, and `map.get(key)` after a `map.set` of each entry in turn: the
value of the last entry with the key. -/
def mapGet {κ ν : Type} [DecidableEq κ] (entries : List (κ × ν)) (key : κ) : Option ν :=
  (entries.reverse.find? (fun entry => entry.1 == key)).map (·.2)

/-- One step of `stableSort`: `item`, which stood before every element of the sorted list, goes
before the first element it is not above. -/
def insertSorted {α ε : Type} (compare : α → α → Except ε Ordering) (item : α) :
    List α → Except ε (List α)
  | [] => .ok [item]
  | next :: rest =>
    match compare item next with
    | .error e => .error e
    | .ok .gt =>
      match insertSorted compare item rest with
      | .error e => .error e
      | .ok placed => .ok (next :: placed)
    | .ok _ => .ok (item :: next :: rest)

/-- `Array.prototype.sort(compare)`: a stable sort, with a comparator that may throw. -/
def stableSort {α ε : Type} (compare : α → α → Except ε Ordering) : List α → Except ε (List α)
  | [] => .ok []
  | item :: rest =>
    match stableSort compare rest with
    | .error e => .error e
    | .ok sorted => insertSorted compare item sorted

/-! ## `reject`, `compareText`, `validateHoldings` (`lots.ts` lines 80 to 147) -/

/-- `reject` (`lots.ts` line 80). -/
def reject (message : String) (path : String := "lots") : LotAllocationResult :=
  .rejected [diagnostic .lot_overallocation path message ["ACC-008", "ACC-009", "ACC-023"]]

/-- `compareText` (`lots.ts` line 89). -/
def compareText (left right : String) : Ordering := compareCanonicalText left right

/-- The body of the loop of `validateHoldings` for one holding: `seen` is the set `ids` before it.
The test for `undefined` at its head always passes (see the head of this file). -/
def validateHolding (index : Nat) (seen : List LotHoldingId) (holding : LotHolding) :
    Except NumErr (List SemanticDiagnostic) :=
  match holding.remainingTotalBasis.add holding.remainingValuationAllowance with
  | .error e => .error e
  | .ok carrying =>
    .ok (
      (if seen.contains holding.id then
        [diagnostic .canonical_identity_conflict s!"holdings[{index}].id"
          s!"Holding identifier {holding.id.value} is duplicated" ["ACC-008", "ACC-038"]]
      else []) ++
      (if holding.remainingQuantity.isNegative || holding.remainingTotalBasis.isNegative then
        [diagnostic .lot_overallocation s!"holdings[{index}]"
          "An ordinary lot holding cannot have negative quantity or basis" ["ACC-009", "ACC-023"]]
      else []) ++
      (if !holding.remainingCarryingAmount.equals carrying then
        [diagnostic .lot_overallocation s!"holdings[{index}].remainingCarryingAmount"
          "A holding's carrying amount must equal historical basis plus its separately retained valuation allowance"
          ["ACC-009", "ACC-039", "ACC-038"]]
      else []) ++
      (if holding.remainingQuantity.isZero != holding.remainingTotalBasis.isZero ||
          holding.remainingQuantity.isZero &&
            (!holding.remainingValuationAllowance.isZero || !holding.remainingCarryingAmount.isZero) then
        [diagnostic .lot_overallocation s!"holdings[{index}]"
          "A depleted holding must have both zero quantity and zero total basis" ["ACC-009", "ACC-023"]]
      else []))

/-- The loop of `validateHoldings` from position `index`, with the identifiers already seen. -/
def validateHoldingsFrom (index : Nat) (seen : List LotHoldingId) :
    List LotHolding → Except NumErr (List SemanticDiagnostic)
  | [] => .ok []
  | holding :: rest =>
    match validateHolding index seen holding with
    | .error e => .error e
    | .ok here =>
      match validateHoldingsFrom (index + 1) (holding.id :: seen) rest with
      | .error e => .error e
      | .ok later => .ok (here ++ later)

/-- `validateHoldings` (`lots.ts` line 93). -/
def validateHoldings (holdings : List LotHolding) : Except NumErr (List SemanticDiagnostic) :=
  validateHoldingsFrom 0 [] holdings

/-! ## The pieces of `allocateLots` (`lots.ts` lines 149 to 314) -/

/-- `lotById.get(id)` (`lots.ts` line 165). -/
def lotById (lots : List Lot) (id : LotId) : Option Lot :=
  mapGet (lots.map fun lot => (lot.id, lot)) id

/-- The comparator of `candidates.sort` (`lots.ts` lines 202 to 216), `.lt` for a negative number,
`.gt` for a positive one. The engine decides which pairs it compares. That shows only when the
division of the highest-cost order exceeds the size limit for a holding: the TypeScript then throws
if the engine compares that holding with another whose lot is known, and here `stableSort` decides
the same question for its own comparisons. With one candidate nothing is compared in either. -/
def compareCandidates (method : LotSelectionMethod) (lots : List Lot) (left right : LotHolding) :
    Except NumErr Ordering :=
  match lotById lots left.lotId, lotById lots right.lotId with
  | some leftLot, some rightLot =>
    match method with
    | .hifo =>
      match left.remainingTotalBasis.divide left.remainingQuantity with
      | .error e => .error e
      | .ok leftUnit =>
        match right.remainingTotalBasis.divide right.remainingQuantity with
        | .error e => .error e
        | .ok rightUnit =>
          let comparison := rightUnit.compare leftUnit
          .ok (if comparison = .eq then compareText left.lotId.value right.lotId.value
            else comparison)
    | .weightedAverage => .ok (compareText left.id.value right.id.value)
    | method =>
      let comparison := compareText leftLot.acquiredAt.value rightLot.acquiredAt.value
      let ordered :=
        if comparison = .eq then compareText left.lotId.value right.lotId.value else comparison
      .ok (if method = .lifo then ordered.swap else ordered)
  | _, _ => .ok (compareText left.lotId.value right.lotId.value)

/-- The test of `candidates.some` at `lots.ts` line 219: the holding does not resolve one usable
lot. -/
def lotUnresolved (lots : List Lot) (holding : LotHolding) : Bool :=
  match lotById lots holding.lotId with
  | none => true
  | some lot =>
    lot.bookId != holding.bookId ||
    lot.commodityId != holding.commodityId ||
    lot.basisCommodityId != holding.basisCommodityId ||
    lot.acquisitionQuantity.isZero ||
    lot.acquisitionQuantity.isNegative ||
    lot.acquisitionTotalBasis.isNegative ||
    lot.evidenceIds.length == 0

/-- The test of `candidates.some` at `lots.ts` line 235: the holding is of another book or
commodity than the first candidate. -/
def mixesScope (first holding : LotHolding) : Bool :=
  holding.bookId != first.bookId ||
  holding.commodityId != first.commodityId ||
  holding.basisCommodityId != first.basisCommodityId

/-- `quantities.reduce((total, item) => total.add(item), total)`. -/
def addAll (total : ExactRational) : List ExactRational → Except NumErr ExactRational
  | [] => .ok total
  | quantity :: rest =>
    match total.add quantity with
    | .error e => .error e
    | .ok next => addAll next rest

/-- What the choice of candidates (`lots.ts` lines 174 to 217) ends with: a rejection, or the
candidates in the order the loop visits them and the map `specificQuantities`. -/
inductive Selected where
  | rejected (result : LotAllocationResult)
  | candidates (candidates : List LotHolding)
      (specificQuantities : Option (List (LotHoldingId × ExactRational)))
  deriving DecidableEq, Repr, Inhabited

/-- The choice of candidates (`lots.ts` lines 174 to 217). -/
def selectCandidates (holdings : List LotHolding) (lots : List Lot)
    (requestedQuantity : ExactRational) (selection : LotSelection) : Except NumErr Selected :=
  match selection with
  | .specificIdentification allocations =>
    if setSize (allocations.map (·.holdingId)) ≠ allocations.length then
      .ok (.rejected (reject "Specific identification contains a duplicate holding ID"
        "selection.allocations"))
    else if allocations.any (fun item => item.quantity.isZero || item.quantity.isNegative) then
      .ok (.rejected (reject "Every specifically identified quantity must be positive"
        "selection.allocations"))
    else
      match addAll ExactRational.zero (allocations.map (·.quantity)) with
      | .error e => .error e
      | .ok declaredTotal =>
        if !declaredTotal.equals requestedQuantity then
          .ok (.rejected (reject
            "Specific allocation quantities must exactly equal the requested quantity"
            "selection.allocations"))
        else
          match stableSort
              (fun left right => .ok (compareText left.holdingId.value right.holdingId.value))
              allocations with
          | .error e => .error e
          | .ok sorted =>
            let candidates := sorted.filterMap fun item =>
              holdings.find? (fun holding => holding.id == item.holdingId)
            if candidates.length ≠ allocations.length then
              .ok (.rejected (reject "Specific identification must resolve every stable holding ID"
                "selection.allocations"))
            else
              .ok (.candidates candidates
                (some (allocations.map fun item => (item.holdingId, item.quantity))))
  | selection =>
    match stableSort (compareCandidates selection.method lots)
        (holdings.filter fun holding => !holding.remainingQuantity.isZero) with
    | .error e => .error e
    | .ok candidates => .ok (.candidates candidates none)

/-- What the loop of `allocateLots` reads and never changes. -/
structure LoopInputs where
  method : LotSelectionMethod
  requestedQuantity : ExactRational
  specificQuantities : Option (List (LotHoldingId × ExactRational))
  weightedAvailable : Option ExactRational
  derivation : DerivationRecord
  identities : List LotAllocationIdentity

/-- What the loop of `allocateLots` changes: `remaining`, `replacements` (the entries in the order
they were set) and `allocations`. -/
structure LoopState where
  remaining : ExactRational
  replacements : List (LotHoldingId × LotHolding)
  allocations : List LotAllocation
  deriving DecidableEq, Repr, Inhabited

/-- How the loop of `allocateLots` ends: with a `return` of a rejection, or by running out. -/
inductive LoopResult where
  | rejected (result : LotAllocationResult)
  | finished (state : LoopState)
  deriving DecidableEq, Repr, Inhabited

/-- `allocated` (`lots.ts` lines 254 to 257): the quantity named for the holding; or its share of
the request by weighted average; or the whole holding, or what is still asked when that is less. -/
def chooseAllocated (inputs : LoopInputs) (holding : LotHolding) (remaining : ExactRational) :
    Except NumErr ExactRational :=
  match inputs.specificQuantities.bind (fun quantities => mapGet quantities holding.id) with
  | some specificallyAllocated => .ok specificallyAllocated
  | none =>
    match (if inputs.method = .weightedAverage then inputs.weightedAvailable else none) with
    | some available =>
      match holding.remainingQuantity.multiply inputs.requestedQuantity with
      | .error e => .error e
      | .ok product => product.divide available
    | none =>
      .ok (if holding.remainingQuantity.compare remaining ≠ .gt then holding.remainingQuantity
        else remaining)

/-- `allocated.equals(quantity) ? whole : whole.multiply(allocated).divide(quantity)`
(`lots.ts` lines 261 to 266): the part of an amount of the holding that goes with the quantity
taken. -/
def shareOf (whole allocated quantity : ExactRational) : Except NumErr ExactRational :=
  if allocated.equals quantity then .ok whole
  else
    match whole.multiply allocated with
    | .error e => .error e
    | .ok product => product.divide quantity

/-- The seven amounts one turn of the loop computes (`lots.ts` lines 261 to 278). -/
structure Take where
  basis : ExactRational
  valuationAllowance : ExactRational
  carryingAmount : ExactRational
  nextQuantity : ExactRational
  nextBasis : ExactRational
  nextValuationAllowance : ExactRational
  nextCarryingAmount : ExactRational
  deriving DecidableEq, Repr, Inhabited

/-- The arithmetic of one turn of the loop (`lots.ts` lines 261 to 278), in its order. -/
def take (holding : LotHolding) (allocated : ExactRational) : Except NumErr Take :=
  match shareOf holding.remainingTotalBasis allocated holding.remainingQuantity with
  | .error e => .error e
  | .ok basis =>
  match shareOf holding.remainingValuationAllowance allocated holding.remainingQuantity with
  | .error e => .error e
  | .ok valuationAllowance =>
  match basis.add valuationAllowance with
  | .error e => .error e
  | .ok carryingAmount =>
  match holding.remainingQuantity.subtract allocated with
  | .error e => .error e
  | .ok nextQuantity =>
  match holding.remainingTotalBasis.subtract basis with
  | .error e => .error e
  | .ok nextBasis =>
  match holding.remainingValuationAllowance.subtract valuationAllowance with
  | .error e => .error e
  | .ok nextValuationAllowance =>
  match nextBasis.add nextValuationAllowance with
  | .error e => .error e
  | .ok nextCarryingAmount =>
    .ok { basis, valuationAllowance, carryingAmount, nextQuantity, nextBasis,
          nextValuationAllowance, nextCarryingAmount }

/-- The holding that replaces `holding` after a take (`lots.ts` lines 273 to 279). -/
def replacementOf (holding : LotHolding) (taken : Take) : LotHolding :=
  { holding with
    remainingQuantity := taken.nextQuantity
    remainingTotalBasis := taken.nextBasis
    remainingValuationAllowance := taken.nextValuationAllowance
    remainingCarryingAmount := taken.nextCarryingAmount }

/-- The allocation pushed after a take (`lots.ts` lines 294 to 303). -/
def allocationOf (allocationId : LotAllocationId) (holding : LotHolding)
    (allocated : ExactRational) (taken : Take) (derivation : DerivationRecord) : LotAllocation :=
  { id := allocationId
    holdingId := holding.id
    lotId := holding.lotId
    allocatedQuantity := allocated
    allocatedTotalBasis := taken.basis
    allocatedValuationAllowance := taken.valuationAllowance
    allocatedCarryingAmount := taken.carryingAmount
    derivation }

/-- One turn of the loop for a holding that is taken from (`lots.ts` lines 254 to 305): a `return`
of a rejection, or the state after the turn. -/
def allocateStep (inputs : LoopInputs) (holding : LotHolding) (state : LoopState) :
    Except NumErr LoopResult :=
  match chooseAllocated inputs holding state.remaining with
  | .error e => .error e
  | .ok allocated =>
    if allocated.compare holding.remainingQuantity = .gt ∨
        allocated.compare state.remaining = .gt then
      .ok (.rejected (reject "A specifically identified allocation exceeds its holding"
        "selection.allocations"))
    else
      match take holding allocated with
      | .error e => .error e
      | .ok taken =>
        match inputs.identities.find? (fun identity => identity.holdingId == holding.id) with
        | none =>
          .ok (.rejected (reject
            "Every allocated holding requires one explicitly supplied stable allocation identity"
            "identities"))
        | some identity =>
          if state.allocations.any (fun item => item.id == identity.allocationId) then
            .ok (.rejected (.rejected [diagnostic .canonical_identity_conflict "allocations"
              s!"Allocation identifier {identity.allocationId.value} is duplicated"
              ["ACC-008", "ACC-038"]]))
          else
            match state.remaining.subtract allocated with
            | .error e => .error e
            | .ok remaining =>
              .ok (.finished
                { remaining
                  replacements := state.replacements ++ [(holding.id, replacementOf holding taken)]
                  allocations := state.allocations ++
                    [allocationOf identity.allocationId holding allocated taken inputs.derivation] })

/-- The loop of `allocateLots` (`lots.ts` lines 251 to 306). -/
def allocateLoop (inputs : LoopInputs) : List LotHolding → LoopState → Except NumErr LoopResult
  | [], state => .ok (.finished state)
  | holding :: rest, state =>
    if state.remaining.isZero then .ok (.finished state)
    else if holding.remainingQuantity.isZero then allocateLoop inputs rest state
    else
      match allocateStep inputs holding state with
      | .error e => .error e
      | .ok (.rejected result) => .ok (.rejected result)
      | .ok (.finished next) => allocateLoop inputs rest next

/-- `weightedAvailable` (`lots.ts` line 246): the total of the candidates for the weighted average,
`undefined` for every other method. -/
def weightedAvailable (method : LotSelectionMethod) (candidates : List LotHolding) :
    Except NumErr (Option ExactRational) :=
  if method = .weightedAverage then
    match addAll ExactRational.zero (candidates.map (·.remainingQuantity)) with
    | .error e => .error e
    | .ok total => .ok (some total)
  else .ok none

/-- `holdings.map((holding) => replacements.get(holding.id) ?? holding)` (`lots.ts` line 312). -/
def applyReplacements (replacements : List (LotHoldingId × LotHolding))
    (holdings : List LotHolding) : List LotHolding :=
  holdings.map fun holding => (mapGet replacements holding.id).getD holding

end Lots

/-- `allocateLots` (`lots.ts` line 149). -/
def allocateLots (holdings : List LotHolding) (lots : List Lot) (requestedQuantity : ExactRational)
    (selection : LotSelection) (derivation : DerivationRecord)
    (identities : List LotAllocationIdentity) : Except NumErr LotAllocationResult :=
  match Lots.validateHoldings holdings with
  | .error e => .error e
  | .ok initialDiagnostics =>
    if initialDiagnostics.length > 0 then .ok (.rejected initialDiagnostics)
    else if requestedQuantity.isZero || requestedQuantity.isNegative then
      .ok (Lots.reject "Allocated quantity must be positive" "requestedQuantity")
    else if Lots.setSize (lots.map (·.id)) ≠ lots.length then
      .ok (.rejected [diagnostic .canonical_identity_conflict "lots"
        "Lot identifier is duplicated in the supplied canonical scope" ["ACC-008", "ACC-038"]])
    else
      match Lots.selectCandidates holdings lots requestedQuantity selection with
      | .error e => .error e
      | .ok (.rejected result) => .ok result
      | .ok (.candidates candidates specificQuantities) =>
        if candidates.any (Lots.lotUnresolved lots) then
          .ok (Lots.reject "Every holding must resolve one stable lot identity" "holdings")
        else if (match candidates.head? with
            | some first => candidates.any (Lots.mixesScope first)
            | none => false) then
          .ok (Lots.reject "A lot allocation cannot combine books or commodities" "holdings")
        else
          match Lots.weightedAvailable selection.method candidates with
          | .error e => .error e
          | .ok weightedAvailable =>
            match Lots.allocateLoop
                { method := selection.method, requestedQuantity, specificQuantities,
                  weightedAvailable, derivation, identities }
                candidates
                { remaining := requestedQuantity, replacements := [], allocations := [] } with
            | .error e => .error e
            | .ok (.rejected result) => .ok result
            | .ok (.finished state) =>
              if !state.remaining.isZero then
                .ok (Lots.reject "Requested quantity exceeds selected holdings")
              else
                .ok (.allocated state.allocations
                  (Lots.applyReplacements state.replacements holdings))

/-! ## `transferLots` (`lots.ts` lines 316 to 492) -/

/-- The type of `TransferPolicy.treatment`, unnamed in the TypeScript. -/
inductive TransferTreatment where
  | continuity
  | disposalAndReacquisition
  deriving DecidableEq, Repr, Inhabited

/-- `TransferPolicy`. -/
structure TransferPolicy where
  id : PolicyId
  version : SemanticVersion
  bookId : BookId
  sourceAccountId : AccountId
  destinationAccountId : AccountId
  validFrom : Instant
  validTo : Option Instant
  treatment : TransferTreatment
  deriving DecidableEq, Repr, Inhabited

/-- `DestinationHoldingIdentity`. -/
structure DestinationHoldingIdentity where
  sourceHoldingId : LotHoldingId
  destinationHoldingId : LotHoldingId
  deriving DecidableEq, Repr, Inhabited

/-- `LotTransferResult`: the three dispositions. -/
inductive LotTransferResult where
  | transferred (sourceHoldings destinationHoldings : List LotHolding)
      (allocations : List LotAllocation)
  | requiresDisposalAndReacquisition (policy : TransferPolicy)
  | rejected (diagnostics : List SemanticDiagnostic)
  deriving DecidableEq, Repr, Inhabited

/-- What `transferLots` can throw: an `ExactNumberError`, or the `TypeError` of reading a field of
`sourceHoldings.find(...)!` when nothing was found (`lots.ts` line 437). The second never happens:
`transferLots_sourceHolding_found`. -/
inductive LotsErr where
  | exactNumber (code : NumErr)
  | sourceHoldingAbsent
  deriving DecidableEq, Repr, Inhabited

namespace Lots

/-- `Date.parse(left) <= Date.parse(right)`: false when either is `NaN`. -/
def dateParseLe (left right : Instant) : Bool :=
  match dateParse left.value, dateParse right.value with
  | some leftMillis, some rightMillis => decide (leftMillis ≤ rightMillis)
  | _, _ => false

/-- `Date.parse(left) < Date.parse(right)`: false when either is `NaN`. -/
def dateParseLt (left right : Instant) : Bool :=
  match dateParse left.value, dateParse right.value with
  | some leftMillis, some rightMillis => decide (leftMillis < rightMillis)
  | _, _ => false

/-- The test of `policies.filter` (`lots.ts` lines 374 to 379). -/
def policyApplies (source : LotHolding) (destinationAccountId : AccountId) (governedAt : Instant)
    (policy : TransferPolicy) : Bool :=
  policy.bookId == source.bookId &&
  policy.sourceAccountId == source.accountId &&
  policy.destinationAccountId == destinationAccountId &&
  dateParseLe policy.validFrom governedAt &&
  (match policy.validTo with
    | none => true
    | some validTo => dateParseLt governedAt validTo)

/-- The test of `destination.some` at `lots.ts` line 415. -/
def destinationOutOfScope (source : LotHolding) (destinationAccountId : AccountId)
    (holding : LotHolding) : Bool :=
  holding.bookId != source.bookId ||
  holding.accountId != destinationAccountId ||
  holding.commodityId != source.commodityId ||
  holding.basisCommodityId != source.basisCommodityId

/-- How the loop over the allocations ends: with a `return` of a rejection, or by running out. -/
inductive ArrivalResult where
  | rejected (diagnostics : List SemanticDiagnostic)
  | finished (destination : List LotHolding)
  deriving DecidableEq, Repr, Inhabited

/-- `existing` with the allocation added (`lots.ts` lines 443 to 449). -/
def addArrival (existing : LotHolding) (applied : LotAllocation) : Except NumErr LotHolding :=
  match existing.remainingQuantity.add applied.allocatedQuantity with
  | .error e => .error e
  | .ok remainingQuantity =>
  match existing.remainingTotalBasis.add applied.allocatedTotalBasis with
  | .error e => .error e
  | .ok remainingTotalBasis =>
  match existing.remainingValuationAllowance.add applied.allocatedValuationAllowance with
  | .error e => .error e
  | .ok remainingValuationAllowance =>
  match existing.remainingCarryingAmount.add applied.allocatedCarryingAmount with
  | .error e => .error e
  | .ok remainingCarryingAmount =>
    .ok { existing with
          remainingQuantity, remainingTotalBasis, remainingValuationAllowance,
          remainingCarryingAmount }

/-- The holding pushed for an allocation that has none at the destination yet
(`lots.ts` lines 471 to 482). -/
def newArrival (newHoldingId : LotHoldingId) (sourceHolding : LotHolding)
    (destinationAccountId : AccountId) (applied : LotAllocation) : LotHolding :=
  { id := newHoldingId
    bookId := sourceHolding.bookId
    lotId := sourceHolding.lotId
    accountId := destinationAccountId
    commodityId := sourceHolding.commodityId
    basisCommodityId := sourceHolding.basisCommodityId
    remainingQuantity := applied.allocatedQuantity
    remainingTotalBasis := applied.allocatedTotalBasis
    remainingValuationAllowance := applied.allocatedValuationAllowance
    remainingCarryingAmount := applied.allocatedCarryingAmount }

/-- One turn of the loop over the allocations (`lots.ts` lines 437 to 484). -/
def arriveStep (sourceHoldings : List LotHolding) (destinationAccountId : AccountId)
    (destinationIdentities : List DestinationHoldingIdentity) (destination : List LotHolding)
    (applied : LotAllocation) : Except LotsErr ArrivalResult :=
  match sourceHoldings.find? (fun holding => holding.id == applied.holdingId) with
  | none => .error .sourceHoldingAbsent
  | some sourceHolding =>
    let isExisting := fun (holding : LotHolding) =>
      holding.lotId == sourceHolding.lotId && holding.accountId == destinationAccountId
    match destination.find? isExisting with
    | some existing =>
      match addArrival existing applied with
      | .error e => .error (.exactNumber e)
      | .ok replaced => .ok (.finished (destination.set (destination.findIdx isExisting) replaced))
    | none =>
      match destinationIdentities.find?
          (fun identity => identity.sourceHoldingId == sourceHolding.id) with
      | none =>
        .ok (.rejected [diagnostic .canonical_identity_conflict "destinationIdentities"
          "Every new destination holding requires one explicitly supplied stable identity"
          ["ACC-006", "ACC-008", "ACC-038"]])
      | some identity =>
        if destination.any (fun holding => holding.id == identity.destinationHoldingId) ||
            sourceHoldings.any (fun holding => holding.id == identity.destinationHoldingId) then
          .ok (.rejected [diagnostic .canonical_identity_conflict "destinationHoldings"
            s!"Destination holding identifier {identity.destinationHoldingId.value} is already assigned"
            ["ACC-008", "ACC-038"]])
        else
          .ok (.finished (destination ++
            [newArrival identity.destinationHoldingId sourceHolding destinationAccountId applied]))

/-- The loop over the allocations (`lots.ts` lines 436 to 485). -/
def arriveLoop (sourceHoldings : List LotHolding) (destinationAccountId : AccountId)
    (destinationIdentities : List DestinationHoldingIdentity) :
    List LotAllocation → List LotHolding → Except LotsErr ArrivalResult
  | [], destination => .ok (.finished destination)
  | applied :: rest, destination =>
    match arriveStep sourceHoldings destinationAccountId destinationIdentities destination
        applied with
    | .error e => .error e
    | .ok (.rejected diagnostics) => .ok (.rejected diagnostics)
    | .ok (.finished next) =>
      arriveLoop sourceHoldings destinationAccountId destinationIdentities rest next

end Lots

/-- `transferLots` (`lots.ts` line 342). -/
def transferLots (sourceHoldings destinationHoldings : List LotHolding) (lots : List Lot)
    (requestedQuantity : ExactRational) (selection : LotSelection)
    (policies : List TransferPolicy) (governedAt : Instant) (destinationAccountId : AccountId)
    (derivation : DerivationRecord) (allocationIdentities : List LotAllocationIdentity)
    (destinationIdentities : List DestinationHoldingIdentity) : Except LotsErr LotTransferResult :=
  match sourceHoldings.head? with
  | none =>
    .ok (.rejected [diagnostic .lot_overallocation "sourceHoldings" "No source holding supplied"
      ["ACC-008", "ACC-009", "ACC-023"]])
  | some source =>
    if sourceHoldings.any (fun holding =>
        holding.bookId != source.bookId || holding.accountId != source.accountId) then
      .ok (.rejected [diagnostic .book_isolation_violation "sourceHoldings"
        "A transfer source must contain one book and account" ["ACC-009", "ACC-010", "ACC-026"]])
    else
      match policies.filter (Lots.policyApplies source destinationAccountId governedAt) with
      | [policy] =>
        if policy.treatment = .disposalAndReacquisition then
          .ok (.requiresDisposalAndReacquisition policy)
        else if source.accountId == destinationAccountId then
          .ok (.rejected [diagnostic .lot_overallocation "destinationAccountId"
            "A continuity transfer requires distinct source and destination accounts"
            ["ACC-009", "ACC-010", "ACC-023"]])
        else
          match allocateLots sourceHoldings lots requestedQuantity selection derivation
              allocationIdentities with
          | .error e => .error (.exactNumber e)
          | .ok (.rejected diagnostics) => .ok (.rejected diagnostics)
          | .ok (.allocated allocations holdings) =>
            if destinationHoldings.any
                (Lots.destinationOutOfScope source destinationAccountId) then
              .ok (.rejected [diagnostic .book_isolation_violation "destinationHoldings"
                "Destination holdings must use the transfer book, account, commodity, and basis commodity"
                ["ACC-009", "ACC-010", "ACC-026"]])
            else if Lots.setSize (destinationHoldings.map (·.id)) ≠ destinationHoldings.length ∨
                destinationHoldings.any (fun holding =>
                  sourceHoldings.any (fun item => item.id == holding.id)) = true then
              .ok (.rejected [diagnostic .canonical_identity_conflict "destinationHoldings"
                "Destination holding identity is duplicated" ["ACC-008", "ACC-038"]])
            else
              match Lots.arriveLoop sourceHoldings destinationAccountId destinationIdentities
                  allocations destinationHoldings with
              | .error e => .error e
              | .ok (.rejected diagnostics) => .ok (.rejected diagnostics)
              | .ok (.finished destination) => .ok (.transferred holdings destination allocations)
      | applicable =>
        .ok (.rejected [diagnostic .transfer_policy_missing "policies"
          s!"Expected exactly one applicable transfer policy; found {applicable.length}"
          ["ACC-007", "ACC-010", "ACC-011"]])

/-! ## Laws of what is taken from JavaScript -/

namespace Lots

/-- A set built from a list has as many members as the list exactly when no value is repeated. -/
theorem setSize_eq_length_iff {α : Type} [DecidableEq α] (values : List α) :
    setSize values = values.length ↔ values.Nodup := by
  unfold setSize
  constructor
  · intro h
    have := (List.dedup_sublist values).eq_of_length h
    rw [← this]
    exact List.nodup_dedup values
  · intro h
    rw [h.dedup]

/-- A map answers nothing for a key exactly when no entry has the key. -/
theorem mapGet_eq_none_iff {κ ν : Type} [DecidableEq κ] (entries : List (κ × ν)) (key : κ) :
    mapGet entries key = none ↔ ∀ entry ∈ entries, entry.1 ≠ key := by
  simp [mapGet]

/-- In a list whose keys are all different, the first entry with a key is the only one. -/
theorem find?_key_of_nodup {κ ν : Type} [DecidableEq κ] {entries : List (κ × ν)}
    (h : (entries.map (·.1)).Nodup) {key : κ} {value : ν} (hm : (key, value) ∈ entries) :
    entries.find? (fun entry => entry.1 == key) = some (key, value) := by
  induction entries with
  | nil => cases hm
  | cons entry rest ih =>
    rw [List.map_cons, List.nodup_cons] at h
    rcases List.mem_cons.mp hm with he | he
    · subst he
      simp
    · have hne : entry.1 ≠ key := by
        intro heq
        exact h.1 (heq ▸ List.mem_map_of_mem (f := (·.1)) he)
      rw [List.find?_cons_of_neg (by simpa using hne)]
      exact ih h.2 he

/-- A map whose entries have different keys answers a key with the value of its entry. -/
theorem mapGet_eq_some_iff {κ ν : Type} [DecidableEq κ] {entries : List (κ × ν)}
    (h : (entries.map (·.1)).Nodup) (key : κ) (value : ν) :
    mapGet entries key = some value ↔ (key, value) ∈ entries := by
  constructor
  · intro hg
    unfold mapGet at hg
    rcases hfind : entries.reverse.find? (fun entry => entry.1 == key) with _ | found
    · simp [hfind] at hg
    · rw [hfind] at hg
      have hmem := List.mem_of_find?_eq_some hfind
      have hkey := List.find?_some hfind
      simp only [Option.map_some, Option.some.injEq] at hg
      simp only [beq_iff_eq] at hkey
      rw [List.mem_reverse] at hmem
      rcases found with ⟨k, v⟩
      simp only at hg hkey
      subst hg hkey
      exact hmem
  · intro hm
    unfold mapGet
    rw [find?_key_of_nodup (by rw [List.map_reverse]; exact List.nodup_reverse.mpr h)
      (List.mem_reverse.mpr hm)]
    rfl

/-- A strict order of keys in which any two different keys are ordered. -/
structure StrictTotal {κ : Type} (lt : κ → κ → Prop) : Prop where
  irrefl : ∀ a, ¬ lt a a
  trans : ∀ {a b c}, lt a b → lt b c → lt a c
  total : ∀ a b, lt a b ∨ a = b ∨ lt b a

/-- `x` comes before `y` in a stable sort of `original` by `key`: its key is lower, or the keys are
the same and `x` stood before `y` in `original`. -/
def Before {α κ : Type} (lt : κ → κ → Prop) (key : α → κ) (original : List α) (x y : α) : Prop :=
  lt (key x) (key y) ∨ (key x = key y ∧ [x, y].Sublist original)

theorem Before.mono {α κ : Type} {lt : κ → κ → Prop} {key : α → κ} {original : List α} {x y : α}
    (item : α) (h : Before lt key original x y) : Before lt key (item :: original) x y := by
  rcases h with h | ⟨h1, h2⟩
  · exact Or.inl h
  · exact Or.inr ⟨h1, h2.cons item⟩

/-- A sort returns the elements it was given, each as many times. -/
theorem insertSorted_perm {α ε : Type} (cmp : α → α → Except ε Ordering) (item : α) :
    ∀ (sorted result : List α), insertSorted cmp item sorted = .ok result →
      result.Perm (item :: sorted) := by
  intro sorted
  induction sorted with
  | nil =>
    intro result h
    simp only [insertSorted, Except.ok.injEq] at h
    subst h
    exact List.Perm.refl _
  | cons next rest ih =>
    intro result h
    rw [insertSorted] at h
    cases hc : cmp item next with
    | error e => simp [hc] at h
    | ok o =>
      cases o with
      | gt =>
        simp only [hc] at h
        cases hp : insertSorted cmp item rest with
        | error e => simp [hp] at h
        | ok placed =>
          simp only [hp, Except.ok.injEq] at h
          subst h
          exact ((ih placed hp).cons next).trans (List.Perm.swap item next rest)
      | lt =>
        simp only [hc, Except.ok.injEq] at h
        subst h
        exact List.Perm.refl _
      | eq =>
        simp only [hc, Except.ok.injEq] at h
        subst h
        exact List.Perm.refl _

/-- A sort returns the elements it was given, each as many times. -/
theorem stableSort_perm {α ε : Type} (cmp : α → α → Except ε Ordering) :
    ∀ (list result : List α), stableSort cmp list = .ok result → result.Perm list := by
  intro list
  induction list with
  | nil =>
    intro result h
    simp only [stableSort, Except.ok.injEq] at h
    subst h
    exact List.Perm.refl _
  | cons item rest ih =>
    intro result h
    rw [stableSort] at h
    cases hs : stableSort cmp rest with
    | error e => simp [hs] at h
    | ok sorted =>
      simp only [hs] at h
      exact (insertSorted_perm cmp item sorted result h).trans ((ih sorted hs).cons item)

/-- Placing one more element keeps the list sorted and stable. -/
theorem insertSorted_sorted {α ε κ : Type} {cmp : α → α → Except ε Ordering}
    {lt : κ → κ → Prop} (hlt : StrictTotal lt) (key : α → κ) (original : List α) (item : α) :
    ∀ (sorted result : List α),
      (∀ y ∈ sorted, ∀ o, cmp item y = .ok o → (o = .gt ↔ lt (key y) (key item))) →
      sorted.Pairwise (Before lt key original) → (∀ y ∈ sorted, y ∈ original) →
      insertSorted cmp item sorted = .ok result →
      result.Pairwise (Before lt key (item :: original)) := by
  intro sorted
  induction sorted with
  | nil =>
    intro result _ _ _ h
    simp only [insertSorted, Except.ok.injEq] at h
    subst h
    exact List.pairwise_singleton _ _
  | cons next rest ih =>
    intro result hcmp hsorted hmem h
    rw [insertSorted] at h
    have hsorted' := List.pairwise_cons.mp hsorted
    have hmono : (next :: rest).Pairwise (Before lt key (item :: original)) :=
      hsorted.imp (fun hb => hb.mono item)
    have hfirst : ∀ o, cmp item next = .ok o → o ≠ .gt →
        ∀ y ∈ next :: rest, Before lt key (item :: original) item y := by
      intro o hc hne y hy
      have hnext : ¬ lt (key next) (key item) := fun hl =>
        hne ((hcmp next (List.mem_cons_self) o hc).mpr hl)
      have hy' : ¬ lt (key y) (key item) := by
        rcases List.mem_cons.mp hy with hy | hy
        · rw [hy]; exact hnext
        · intro hl
          rcases hsorted'.1 y hy with hb | ⟨hb, _⟩
          · exact hnext (hlt.trans hb hl)
          · exact hnext (hb ▸ hl)
      rcases hlt.total (key item) (key y) with ht | ht | ht
      · exact Or.inl ht
      · exact Or.inr ⟨ht, List.Sublist.cons_cons item (List.singleton_sublist.mpr (hmem y hy))⟩
      · exact absurd ht hy'
    cases hc : cmp item next with
    | error e => simp [hc] at h
    | ok o =>
      cases o with
      | gt =>
        simp only [hc] at h
        cases hp : insertSorted cmp item rest with
        | error e => simp [hp] at h
        | ok placed =>
          simp only [hp, Except.ok.injEq] at h
          subst h
          have hrec := ih placed (fun y hy => hcmp y (List.mem_cons_of_mem _ hy)) hsorted'.2
            (fun y hy => hmem y (List.mem_cons_of_mem _ hy)) hp
          refine List.pairwise_cons.mpr ⟨fun z hz => ?_, hrec⟩
          rcases List.mem_cons.mp ((insertSorted_perm cmp item rest placed hp).mem_iff.mp hz) with
            hz | hz
          · rw [hz]
            exact Or.inl ((hcmp next List.mem_cons_self .gt hc).mp rfl)
          · exact (hsorted'.1 z hz).mono item
      | lt =>
        have hf := hfirst .lt hc (by decide)
        simp only [hc, Except.ok.injEq] at h
        subst h
        exact List.pairwise_cons.mpr ⟨hf, hmono⟩
      | eq =>
        have hf := hfirst .eq hc (by decide)
        simp only [hc, Except.ok.injEq] at h
        subst h
        exact List.pairwise_cons.mpr ⟨hf, hmono⟩

/-- A sort by a comparator that follows an order of keys returns the list in that order, and
elements with the same key in the order they were given. -/
theorem stableSort_sorted {α ε κ : Type} {cmp : α → α → Except ε Ordering}
    {lt : κ → κ → Prop} (hlt : StrictTotal lt) (key : α → κ) :
    ∀ (list result : List α),
      (∀ x ∈ list, ∀ y ∈ list, ∀ o, cmp x y = .ok o → (o = .gt ↔ lt (key y) (key x))) →
      stableSort cmp list = .ok result → result.Pairwise (Before lt key list) := by
  intro list
  induction list with
  | nil =>
    intro result _ h
    simp only [stableSort, Except.ok.injEq] at h
    subst h
    exact List.Pairwise.nil
  | cons item rest ih =>
    intro result hcmp h
    rw [stableSort] at h
    cases hs : stableSort cmp rest with
    | error e => simp [hs] at h
    | ok sorted =>
      simp only [hs] at h
      have hperm := stableSort_perm cmp rest sorted hs
      exact insertSorted_sorted hlt key rest item sorted result
        (fun y hy o ho => hcmp item List.mem_cons_self y
          (List.mem_cons_of_mem _ (hperm.mem_iff.mp hy)) o ho)
        (ih sorted (fun x hx y hy o ho =>
          hcmp x (List.mem_cons_of_mem _ hx) y (List.mem_cons_of_mem _ hy) o ho) hs)
        (fun y hy => hperm.mem_iff.mp hy) h

/-- A running total of constructible quantities that does not exceed the size limit is their sum. -/
theorem addAll_ok : ∀ (quantities : List ExactRational) (total result : ExactRational),
    total.WF → (∀ quantity ∈ quantities, quantity.WF) → addAll total quantities = .ok result →
    result.WF ∧ result.toRat = total.toRat + (quantities.map (·.toRat)).sum := by
  intro quantities
  induction quantities with
  | nil =>
    intro total result ht _ h
    simp only [addAll, Except.ok.injEq] at h
    subst h
    exact ⟨ht, by simp⟩
  | cons quantity rest ih =>
    intro total result ht hq h
    rw [addAll] at h
    cases ha : total.add quantity with
    | error e => simp [ha] at h
    | ok next =>
      simp only [ha] at h
      obtain ⟨hw, hr⟩ := ExactRational.add_ok ht (hq quantity List.mem_cons_self) ha
      obtain ⟨hw', hr'⟩ := ih next result hw (fun q hm => hq q (List.mem_cons_of_mem _ hm)) h
      refine ⟨hw', ?_⟩
      rw [hr', hr, List.map_cons, List.sum_cons]
      ring

end Lots

/-! ## Meaning: constructible and valid holdings -/

/-- A holding whose four amounts are numbers the TypeScript can construct. -/
structure LotHolding.WF (holding : LotHolding) : Prop where
  remainingQuantity : holding.remainingQuantity.WF
  remainingTotalBasis : holding.remainingTotalBasis.WF
  remainingValuationAllowance : holding.remainingValuationAllowance.WF
  remainingCarryingAmount : holding.remainingCarryingAmount.WF

/-- An allocation whose four amounts are numbers the TypeScript can construct. -/
structure LotAllocation.WF (allocation : LotAllocation) : Prop where
  allocatedQuantity : allocation.allocatedQuantity.WF
  allocatedTotalBasis : allocation.allocatedTotalBasis.WF
  allocatedValuationAllowance : allocation.allocatedValuationAllowance.WF
  allocatedCarryingAmount : allocation.allocatedCarryingAmount.WF

/-- What `validateHoldings` demands of one holding, as numbers: quantity and basis are not negative,
the carrying amount is the basis plus the valuation allowance, the quantity is zero exactly when
the basis is, and a holding with no quantity carries nothing. -/
structure LotHolding.Valid (holding : LotHolding) : Prop where
  quantity_nonneg : 0 ≤ holding.remainingQuantity.toRat
  basis_nonneg : 0 ≤ holding.remainingTotalBasis.toRat
  carrying : holding.remainingCarryingAmount.toRat =
    holding.remainingTotalBasis.toRat + holding.remainingValuationAllowance.toRat
  depleted_iff : holding.remainingQuantity.toRat = 0 ↔ holding.remainingTotalBasis.toRat = 0
  depleted_allowance : holding.remainingQuantity.toRat = 0 →
    holding.remainingValuationAllowance.toRat = 0
  depleted_carrying : holding.remainingQuantity.toRat = 0 →
    holding.remainingCarryingAmount.toRat = 0

/-! ## Laws of `validateHoldings` -/

namespace Lots

/-- A test the TypeScript makes, said as the statement it tests. -/
theorem ite_bool_prop {α : Type} {c : Bool} {p : Prop} [Decidable p] (h : c = true ↔ p)
    (x y : α) : (if c then x else y) = if p then x else y := by
  by_cases hp : p
  · simp [hp, h.mpr hp]
  · have hc : c = false := by
      cases c
      · rfl
      · exact absurd (h.mp rfl) hp
    simp [hp, hc]

/-- A test that fails takes the second branch. -/
theorem ite_not_holds {α : Type} {p : Prop} [Decidable p] (h : ¬ p) (x y : α) :
    (if p then x else y) = y := by
  simp [h]

/-- A test that holds takes the first branch. -/
theorem ite_holds {α : Type} {p : Prop} [Decidable p] (h : p) (x y : α) :
    (if p then x else y) = x := by
  simp [h]

/-- `validateHoldings` throws for a holding exactly when its basis plus its valuation allowance
exceeds the size limit. -/
theorem validateHolding_error_iff (index : Nat) (seen : List LotHoldingId) (holding : LotHolding)
    (e : NumErr) :
    validateHolding index seen holding = .error e ↔
      holding.remainingTotalBasis.add holding.remainingValuationAllowance = .error e := by
  unfold validateHolding
  cases holding.remainingTotalBasis.add holding.remainingValuationAllowance <;> simp

/-- The diagnostics of one holding, each with the exact condition that produces it: a repeated
identifier; a negative quantity or basis; a carrying amount that is not basis plus valuation
allowance; and a quantity that is zero without the basis, or a holding with no quantity that still
carries an allowance or an amount. -/
theorem validateHolding_ok {index : Nat} {seen : List LotHoldingId} {holding : LotHolding}
    {diagnostics : List SemanticDiagnostic} (hw : holding.WF)
    (h : validateHolding index seen holding = .ok diagnostics) :
    diagnostics =
      (if holding.id ∈ seen then
        [diagnostic .canonical_identity_conflict s!"holdings[{index}].id"
          s!"Holding identifier {holding.id.value} is duplicated" ["ACC-008", "ACC-038"]]
      else []) ++
      (if holding.remainingQuantity.toRat < 0 ∨ holding.remainingTotalBasis.toRat < 0 then
        [diagnostic .lot_overallocation s!"holdings[{index}]"
          "An ordinary lot holding cannot have negative quantity or basis" ["ACC-009", "ACC-023"]]
      else []) ++
      (if holding.remainingCarryingAmount.toRat ≠
          holding.remainingTotalBasis.toRat + holding.remainingValuationAllowance.toRat then
        [diagnostic .lot_overallocation s!"holdings[{index}].remainingCarryingAmount"
          "A holding's carrying amount must equal historical basis plus its separately retained valuation allowance"
          ["ACC-009", "ACC-039", "ACC-038"]]
      else []) ++
      (if ¬ (holding.remainingQuantity.toRat = 0 ↔ holding.remainingTotalBasis.toRat = 0) ∨
          (holding.remainingQuantity.toRat = 0 ∧
            (holding.remainingValuationAllowance.toRat ≠ 0 ∨
              holding.remainingCarryingAmount.toRat ≠ 0)) then
        [diagnostic .lot_overallocation s!"holdings[{index}]"
          "A depleted holding must have both zero quantity and zero total basis" ["ACC-009", "ACC-023"]]
      else []) := by
  unfold validateHolding at h
  cases ha : holding.remainingTotalBasis.add holding.remainingValuationAllowance with
  | error e => simp [ha] at h
  | ok carrying =>
    simp only [ha, Except.ok.injEq] at h
    obtain ⟨hcw, hcr⟩ :=
      ExactRational.add_ok hw.remainingTotalBasis hw.remainingValuationAllowance ha
    have h1 : seen.contains holding.id = true ↔ holding.id ∈ seen := by simp
    have h2 : (holding.remainingQuantity.isNegative || holding.remainingTotalBasis.isNegative) = true ↔
        (holding.remainingQuantity.toRat < 0 ∨ holding.remainingTotalBasis.toRat < 0) := by
      rw [Bool.or_eq_true, ExactRational.isNegative_iff hw.remainingQuantity,
        ExactRational.isNegative_iff hw.remainingTotalBasis]
    have h3 : (!holding.remainingCarryingAmount.equals carrying) = true ↔
        holding.remainingCarryingAmount.toRat ≠
          holding.remainingTotalBasis.toRat + holding.remainingValuationAllowance.toRat := by
      rw [← hcr, Ne, ← ExactRational.equals_iff hw.remainingCarryingAmount hcw]
      simp
    have h4 : (holding.remainingQuantity.isZero != holding.remainingTotalBasis.isZero ||
          holding.remainingQuantity.isZero &&
            (!holding.remainingValuationAllowance.isZero || !holding.remainingCarryingAmount.isZero)) = true ↔
        (¬ (holding.remainingQuantity.toRat = 0 ↔ holding.remainingTotalBasis.toRat = 0) ∨
          (holding.remainingQuantity.toRat = 0 ∧
            (holding.remainingValuationAllowance.toRat ≠ 0 ∨
              holding.remainingCarryingAmount.toRat ≠ 0))) := by
      simp only [Ne, ← ExactRational.isZero_iff hw.remainingQuantity,
        ← ExactRational.isZero_iff hw.remainingTotalBasis,
        ← ExactRational.isZero_iff hw.remainingValuationAllowance,
        ← ExactRational.isZero_iff hw.remainingCarryingAmount]
      cases holding.remainingQuantity.isZero <;> cases holding.remainingTotalBasis.isZero <;>
        cases holding.remainingValuationAllowance.isZero <;>
        cases holding.remainingCarryingAmount.isZero <;> decide
    rw [← h, ite_bool_prop h1, ite_bool_prop h2, ite_bool_prop h3, ite_bool_prop h4]

/-- A holding draws no diagnostic exactly when its identifier is new, its amounts are valid, and
its basis plus its valuation allowance is within the size limit. -/
theorem validateHolding_nil_iff {index : Nat} {seen : List LotHoldingId} {holding : LotHolding}
    (hw : holding.WF) :
    validateHolding index seen holding = .ok [] ↔
      (∃ carrying, holding.remainingTotalBasis.add holding.remainingValuationAllowance =
        .ok carrying) ∧ holding.id ∉ seen ∧ holding.Valid := by
  constructor
  · intro h
    have hadd : ∃ carrying,
        holding.remainingTotalBasis.add holding.remainingValuationAllowance = .ok carrying := by
      cases ha : holding.remainingTotalBasis.add holding.remainingValuationAllowance with
      | error e => rw [(validateHolding_error_iff index seen holding e).mpr ha] at h; cases h
      | ok carrying => exact ⟨carrying, rfl⟩
    have hd := validateHolding_ok hw h
    by_cases h1 : holding.id ∈ seen
    · simp [h1] at hd
    by_cases h2 : holding.remainingQuantity.toRat < 0 ∨ holding.remainingTotalBasis.toRat < 0
    · simp [h2] at hd
    by_cases h3 : holding.remainingCarryingAmount.toRat ≠
        holding.remainingTotalBasis.toRat + holding.remainingValuationAllowance.toRat
    · simp [h3] at hd
    by_cases h4 : ¬ (holding.remainingQuantity.toRat = 0 ↔ holding.remainingTotalBasis.toRat = 0) ∨
        (holding.remainingQuantity.toRat = 0 ∧
          (holding.remainingValuationAllowance.toRat ≠ 0 ∨
            holding.remainingCarryingAmount.toRat ≠ 0))
    · simp [h4] at hd
    push Not at h2 h3 h4
    exact ⟨hadd, h1, ⟨h2.1, h2.2, h3, h4.1, fun hq => (h4.2 hq).1, fun hq => (h4.2 hq).2⟩⟩
  · rintro ⟨⟨carrying, ha⟩, h1, hv⟩
    have hsome : ∃ diagnostics, validateHolding index seen holding = .ok diagnostics := by
      unfold validateHolding
      rw [ha]
      exact ⟨_, rfl⟩
    obtain ⟨diagnostics, hd⟩ := hsome
    have := validateHolding_ok hw hd
    have h2 : ¬ (holding.remainingQuantity.toRat < 0 ∨ holding.remainingTotalBasis.toRat < 0) := by
      have := hv.quantity_nonneg
      have := hv.basis_nonneg
      rintro (h | h) <;> linarith
    have h4 : ¬ (¬ (holding.remainingQuantity.toRat = 0 ↔ holding.remainingTotalBasis.toRat = 0) ∨
        (holding.remainingQuantity.toRat = 0 ∧
          (holding.remainingValuationAllowance.toRat ≠ 0 ∨
            holding.remainingCarryingAmount.toRat ≠ 0))) := by
      rintro (h | ⟨hq, h | h⟩)
      · exact h hv.depleted_iff
      · exact h (hv.depleted_allowance hq)
      · exact h (hv.depleted_carrying hq)
    rw [ite_not_holds h1, ite_not_holds h2, ite_not_holds (not_not.mpr hv.carrying),
      ite_not_holds h4] at this
    rw [hd, this]
    rfl

/-- From any position: no diagnostic exactly when every holding has a new identifier, valid
amounts, and a basis plus valuation allowance within the size limit. -/
theorem validateHoldingsFrom_nil_iff : ∀ (holdings : List LotHolding) (index : Nat)
    (seen : List LotHoldingId), (∀ holding ∈ holdings, holding.WF) →
    (validateHoldingsFrom index seen holdings = .ok [] ↔
      (holdings.map (·.id)).Nodup ∧ ∀ holding ∈ holdings, holding.id ∉ seen ∧ holding.Valid ∧
        ∃ carrying, holding.remainingTotalBasis.add holding.remainingValuationAllowance =
          .ok carrying) := by
  intro holdings
  induction holdings with
  | nil => intro index seen _; simp [validateHoldingsFrom]
  | cons holding rest ih =>
    intro index seen hw
    have hwh := hw holding List.mem_cons_self
    have hwr : ∀ h ∈ rest, h.WF := fun h hm => hw h (List.mem_cons_of_mem _ hm)
    rw [validateHoldingsFrom]
    constructor
    · intro h
      cases hv : validateHolding index seen holding with
      | error e => simp [hv] at h
      | ok here =>
        simp only [hv] at h
        cases hr : validateHoldingsFrom (index + 1) (holding.id :: seen) rest with
        | error e => simp [hr] at h
        | ok later =>
          simp only [hr, Except.ok.injEq, List.append_eq_nil_iff] at h
          obtain ⟨hhere, hlater⟩ := h
          subst hhere hlater
          obtain ⟨hadd, hnew, hvalid⟩ := (validateHolding_nil_iff hwh).mp hv
          obtain ⟨hnodup, hrest⟩ := (ih (index + 1) (holding.id :: seen) hwr).mp hr
          refine ⟨?_, ?_⟩
          · rw [List.map_cons, List.nodup_cons]
            refine ⟨fun hm => ?_, hnodup⟩
            obtain ⟨other, hother, hid⟩ := List.mem_map.mp hm
            exact (hrest other hother).1 (hid ▸ List.mem_cons_self)
          · intro other hother
            rcases List.mem_cons.mp hother with ho | ho
            · subst ho
              exact ⟨hnew, hvalid, hadd⟩
            · obtain ⟨h1, h2, h3⟩ := hrest other ho
              exact ⟨fun hm => h1 (List.mem_cons_of_mem _ hm), h2, h3⟩
    · rintro ⟨hnodup, hall⟩
      rw [List.map_cons, List.nodup_cons] at hnodup
      obtain ⟨h1, h2, h3⟩ := hall holding List.mem_cons_self
      rw [(validateHolding_nil_iff hwh).mpr ⟨h3, h1, h2⟩]
      have hr : validateHoldingsFrom (index + 1) (holding.id :: seen) rest = .ok [] := by
        refine (ih (index + 1) (holding.id :: seen) hwr).mpr ⟨hnodup.2, fun other ho => ?_⟩
        obtain ⟨g1, g2, g3⟩ := hall other (List.mem_cons_of_mem _ ho)
        refine ⟨fun hm => ?_, g2, g3⟩
        rcases List.mem_cons.mp hm with hm | hm
        · exact hnodup.1 (hm ▸ List.mem_map_of_mem (f := (·.id)) ho)
        · exact g1 hm
      rw [hr]
      rfl

/-- `validateHoldings` finds nothing exactly when no identifier is repeated and every holding is
valid, with a basis plus valuation allowance within the size limit. -/
theorem validateHoldings_nil_iff {holdings : List LotHolding}
    (hw : ∀ holding ∈ holdings, holding.WF) :
    validateHoldings holdings = .ok [] ↔
      (holdings.map (·.id)).Nodup ∧ ∀ holding ∈ holdings, holding.Valid ∧
        ∃ carrying, holding.remainingTotalBasis.add holding.remainingValuationAllowance =
          .ok carrying := by
  unfold validateHoldings
  rw [validateHoldingsFrom_nil_iff holdings 0 [] hw]
  simp

end Lots

/-! ## Laws of one take -/

namespace Lots

/-- A map answers only with the value of one of its entries. -/
theorem mem_of_mapGet {κ ν : Type} [DecidableEq κ] {entries : List (κ × ν)} {key : κ} {value : ν}
    (h : mapGet entries key = some value) : (key, value) ∈ entries := by
  unfold mapGet at h
  rcases hfind : entries.reverse.find? (fun entry => entry.1 == key) with _ | found
  · simp [hfind] at h
  · rw [hfind] at h
    have hmem := List.mem_of_find?_eq_some hfind
    have hkey := List.find?_some hfind
    simp only [Option.map_some, Option.some.injEq] at h
    simp only [beq_iff_eq] at hkey
    rw [List.mem_reverse] at hmem
    rcases found with ⟨k, v⟩
    simp only at h hkey
    subst h hkey
    exact hmem

/-- The part of an amount that goes with a quantity taken is the amount times the quantity taken
over the quantity held, with no rounding: the part times the quantity held is the amount times the
quantity taken. -/
theorem shareOf_ok {whole allocated quantity share : ExactRational} (hw : whole.WF)
    (ha : allocated.WF) (hq : quantity.WF) (h : shareOf whole allocated quantity = .ok share) :
    share.WF ∧ share.toRat * quantity.toRat = whole.toRat * allocated.toRat := by
  unfold shareOf at h
  by_cases hfull : allocated.equals quantity = true
  · simp only [hfull, ↓reduceIte, Except.ok.injEq] at h
    subst h
    exact ⟨hw, by rw [(ExactRational.equals_iff ha hq).mp hfull]⟩
  · simp only [hfull, Bool.false_eq_true, ↓reduceIte] at h
    cases hm : whole.multiply allocated with
    | error e => simp [hm] at h
    | ok product =>
      simp only [hm] at h
      obtain ⟨hpw, hpr⟩ := ExactRational.multiply_ok hw ha hm
      obtain ⟨hsw, hne, hsr⟩ := ExactRational.divide_ok hpw hq h
      refine ⟨hsw, ?_⟩
      rw [hsr, hpr]
      field_simp

/-- What the seven amounts of a take mean. -/
structure TakeSpec (holding : LotHolding) (allocated : ExactRational) (taken : Take) : Prop where
  basis_wf : taken.basis.WF
  valuationAllowance_wf : taken.valuationAllowance.WF
  carryingAmount_wf : taken.carryingAmount.WF
  nextQuantity_wf : taken.nextQuantity.WF
  nextBasis_wf : taken.nextBasis.WF
  nextValuationAllowance_wf : taken.nextValuationAllowance.WF
  nextCarryingAmount_wf : taken.nextCarryingAmount.WF
  basis : taken.basis.toRat * holding.remainingQuantity.toRat =
    holding.remainingTotalBasis.toRat * allocated.toRat
  valuationAllowance : taken.valuationAllowance.toRat * holding.remainingQuantity.toRat =
    holding.remainingValuationAllowance.toRat * allocated.toRat
  carryingAmount : taken.carryingAmount.toRat = taken.basis.toRat + taken.valuationAllowance.toRat
  nextQuantity : taken.nextQuantity.toRat = holding.remainingQuantity.toRat - allocated.toRat
  nextBasis : taken.nextBasis.toRat = holding.remainingTotalBasis.toRat - taken.basis.toRat
  nextValuationAllowance : taken.nextValuationAllowance.toRat =
    holding.remainingValuationAllowance.toRat - taken.valuationAllowance.toRat
  nextCarryingAmount : taken.nextCarryingAmount.toRat =
    taken.nextBasis.toRat + taken.nextValuationAllowance.toRat

/-- The arithmetic of a take is exact: what is allocated and what is left add up to what was
held, for the quantity, the basis and the valuation allowance. -/
theorem take_ok {holding : LotHolding} {allocated : ExactRational} {taken : Take}
    (hw : holding.WF) (ha : allocated.WF) (h : take holding allocated = .ok taken) :
    TakeSpec holding allocated taken := by
  unfold take at h
  cases h1 : shareOf holding.remainingTotalBasis allocated holding.remainingQuantity with
  | error e => simp [h1] at h
  | ok basis =>
  simp only [h1] at h
  cases h2 : shareOf holding.remainingValuationAllowance allocated holding.remainingQuantity with
  | error e => simp [h2] at h
  | ok valuationAllowance =>
  simp only [h2] at h
  cases h3 : basis.add valuationAllowance with
  | error e => simp [h3] at h
  | ok carryingAmount =>
  simp only [h3] at h
  cases h4 : holding.remainingQuantity.subtract allocated with
  | error e => simp [h4] at h
  | ok nextQuantity =>
  simp only [h4] at h
  cases h5 : holding.remainingTotalBasis.subtract basis with
  | error e => simp [h5] at h
  | ok nextBasis =>
  simp only [h5] at h
  cases h6 : holding.remainingValuationAllowance.subtract valuationAllowance with
  | error e => simp [h6] at h
  | ok nextValuationAllowance =>
  simp only [h6] at h
  cases h7 : nextBasis.add nextValuationAllowance with
  | error e => simp [h7] at h
  | ok nextCarryingAmount =>
  simp only [h7, Except.ok.injEq] at h
  subst h
  obtain ⟨w1, r1⟩ := shareOf_ok hw.remainingTotalBasis ha hw.remainingQuantity h1
  obtain ⟨w2, r2⟩ := shareOf_ok hw.remainingValuationAllowance ha hw.remainingQuantity h2
  obtain ⟨w3, r3⟩ := ExactRational.add_ok w1 w2 h3
  obtain ⟨w4, r4⟩ := ExactRational.subtract_ok hw.remainingQuantity ha h4
  obtain ⟨w5, r5⟩ := ExactRational.subtract_ok hw.remainingTotalBasis w1 h5
  obtain ⟨w6, r6⟩ := ExactRational.subtract_ok hw.remainingValuationAllowance w2 h6
  obtain ⟨w7, r7⟩ := ExactRational.add_ok w5 w6 h7
  exact ⟨w1, w2, w3, w4, w5, w6, w7, r1, r2, r3, r4, r5, r6, r7⟩

/-- What `allocateLots` has made sure of before its loop starts: the request is positive, every
quantity named for a holding is positive, and the total for the weighted average is not negative. -/
structure LoopInputs.WF (inputs : LoopInputs) : Prop where
  requestedQuantity : inputs.requestedQuantity.WF
  requested_pos : 0 < inputs.requestedQuantity.toRat
  specific : ∀ quantities, inputs.specificQuantities = some quantities →
    ∀ entry ∈ quantities, entry.2.WF ∧ 0 < entry.2.toRat
  weighted : ∀ available, inputs.weightedAvailable = some available →
    available.WF ∧ 0 ≤ available.toRat

/-- The quantity the loop decides to take from a holding that has some, while some is still asked
for, is a positive number. -/
theorem chooseAllocated_pos {inputs : LoopInputs} {holding : LotHolding}
    {remaining allocated : ExactRational} (hi : inputs.WF) (hh : holding.WF)
    (hq : 0 < holding.remainingQuantity.toRat) (hr : remaining.WF) (hrp : 0 < remaining.toRat)
    (h : chooseAllocated inputs holding remaining = .ok allocated) :
    allocated.WF ∧ 0 < allocated.toRat := by
  unfold chooseAllocated at h
  cases hs : inputs.specificQuantities.bind (fun quantities => mapGet quantities holding.id) with
  | some named =>
    simp only [hs, Except.ok.injEq] at h
    subst h
    obtain ⟨quantities, hsome, hget⟩ := Option.bind_eq_some_iff.mp hs
    exact hi.specific quantities hsome _ (mem_of_mapGet hget)
  | none =>
    simp only [hs] at h
    cases hw : (if inputs.method = .weightedAverage then inputs.weightedAvailable else none) with
    | some available =>
      simp only [hw] at h
      have hav : inputs.weightedAvailable = some available := by
        by_cases hm : inputs.method = .weightedAverage
        · simpa [hm] using hw
        · simp [hm] at hw
      obtain ⟨haw, hanonneg⟩ := hi.weighted available hav
      cases hm : holding.remainingQuantity.multiply inputs.requestedQuantity with
      | error e => simp [hm] at h
      | ok product =>
        simp only [hm] at h
        obtain ⟨hpw, hpr⟩ := ExactRational.multiply_ok hh.remainingQuantity hi.requestedQuantity hm
        obtain ⟨hw', hne, hrat⟩ := ExactRational.divide_ok hpw haw h
        refine ⟨hw', ?_⟩
        rw [hrat, hpr]
        have := hi.requested_pos
        have hapos : 0 < available.toRat := lt_of_le_of_ne hanonneg (Ne.symm hne)
        positivity
    | none =>
      simp only [hw, Except.ok.injEq] at h
      subst h
      split_ifs
      · exact ⟨hh.remainingQuantity, hq⟩
      · exact ⟨hr, hrp⟩

/-- What it is for `allocation` to have been taken from `holding`, leaving `after`: the allocation
names the holding and its lot; it takes a positive quantity, no more than is held; its basis and
valuation allowance are those of the holding in proportion to the quantity; `after` is the same
holding with exactly that much less of each. -/
structure Took (holding : LotHolding) (allocation : LotAllocation) (after : LotHolding) : Prop where
  holdingId : allocation.holdingId = holding.id
  lotId : allocation.lotId = holding.lotId
  after_id : after.id = holding.id
  after_bookId : after.bookId = holding.bookId
  after_lotId : after.lotId = holding.lotId
  after_accountId : after.accountId = holding.accountId
  after_commodityId : after.commodityId = holding.commodityId
  after_basisCommodityId : after.basisCommodityId = holding.basisCommodityId
  allocation_wf : allocation.WF
  after_wf : after.WF
  quantity_pos : 0 < allocation.allocatedQuantity.toRat
  quantity_le : allocation.allocatedQuantity.toRat ≤ holding.remainingQuantity.toRat
  basis : allocation.allocatedTotalBasis.toRat =
    holding.remainingTotalBasis.toRat * allocation.allocatedQuantity.toRat /
      holding.remainingQuantity.toRat
  valuationAllowance : allocation.allocatedValuationAllowance.toRat =
    holding.remainingValuationAllowance.toRat * allocation.allocatedQuantity.toRat /
      holding.remainingQuantity.toRat
  carryingAmount : allocation.allocatedCarryingAmount.toRat =
    allocation.allocatedTotalBasis.toRat + allocation.allocatedValuationAllowance.toRat
  after_quantity : after.remainingQuantity.toRat =
    holding.remainingQuantity.toRat - allocation.allocatedQuantity.toRat
  after_basis : after.remainingTotalBasis.toRat =
    holding.remainingTotalBasis.toRat - allocation.allocatedTotalBasis.toRat
  after_valuationAllowance : after.remainingValuationAllowance.toRat =
    holding.remainingValuationAllowance.toRat - allocation.allocatedValuationAllowance.toRat
  after_carryingAmount : after.remainingCarryingAmount.toRat =
    after.remainingTotalBasis.toRat + after.remainingValuationAllowance.toRat

/-- One turn of the loop that does not reject: one allocation is pushed and one replacement set,
they are what was taken from the holding, and what is still asked for falls by the quantity. -/
theorem allocateStep_finished {inputs : LoopInputs} {holding : LotHolding} {state next : LoopState}
    (hi : inputs.WF) (hh : holding.WF) (hq : 0 < holding.remainingQuantity.toRat)
    (hr : state.remaining.WF) (hrp : 0 < state.remaining.toRat)
    (h : allocateStep inputs holding state = .ok (.finished next)) :
    ∃ allocation after,
      next.allocations = state.allocations ++ [allocation] ∧
      next.replacements = state.replacements ++ [(holding.id, after)] ∧
      Took holding allocation after ∧
      next.remaining.WF ∧ 0 ≤ next.remaining.toRat ∧
      next.remaining.toRat = state.remaining.toRat - allocation.allocatedQuantity.toRat ∧
      chooseAllocated inputs holding state.remaining = .ok allocation.allocatedQuantity ∧
      (∀ earlier ∈ state.allocations, earlier.id ≠ allocation.id) ∧
      allocation.derivation = inputs.derivation ∧
      ∃ identity, inputs.identities.find? (fun identity => identity.holdingId == holding.id) =
        some identity ∧ allocation.id = identity.allocationId := by
  unfold allocateStep at h
  cases hc : chooseAllocated inputs holding state.remaining with
  | error e => simp [hc] at h
  | ok allocated =>
  simp only [hc] at h
  obtain ⟨haw, hapos⟩ := chooseAllocated_pos hi hh hq hr hrp hc
  by_cases hex : allocated.compare holding.remainingQuantity = .gt ∨
      allocated.compare state.remaining = .gt
  · simp [hex] at h
  simp only [hex, ↓reduceIte] at h
  cases ht : take holding allocated with
  | error e => simp [ht] at h
  | ok taken =>
  simp only [ht] at h
  cases hf : inputs.identities.find? (fun identity => identity.holdingId == holding.id) with
  | none => simp [hf] at h
  | some identity =>
  simp only [hf] at h
  by_cases hdup : state.allocations.any (fun item => item.id == identity.allocationId) = true
  · simp [hdup] at h
  simp only [hdup, Bool.false_eq_true, ↓reduceIte] at h
  cases hs : state.remaining.subtract allocated with
  | error e => simp [hs] at h
  | ok remaining =>
  simp only [hs, Except.ok.injEq, LoopResult.finished.injEq] at h
  subst h
  have spec := take_ok hh haw ht
  obtain ⟨hrw, hrr⟩ := ExactRational.subtract_ok hr haw hs
  have hle : allocated.toRat ≤ holding.remainingQuantity.toRat := by
    by_contra hlt
    exact hex (Or.inl ((ExactRational.compare_gt_iff haw hh.remainingQuantity).mpr
      (not_le.mp hlt)))
  have hle' : allocated.toRat ≤ state.remaining.toRat := by
    by_contra hlt
    exact hex (Or.inr ((ExactRational.compare_gt_iff haw hr).mpr (not_le.mp hlt)))
  have hqne : holding.remainingQuantity.toRat ≠ 0 := ne_of_gt hq
  refine ⟨allocationOf identity.allocationId holding allocated taken inputs.derivation,
    replacementOf holding taken, rfl, rfl, ?_, hrw, ?_, hrr, rfl, ?_, rfl, identity, rfl, rfl⟩
  · exact
      { holdingId := rfl, lotId := rfl, after_id := rfl, after_bookId := rfl, after_lotId := rfl,
        after_accountId := rfl, after_commodityId := rfl, after_basisCommodityId := rfl,
        allocation_wf := ⟨haw, spec.basis_wf, spec.valuationAllowance_wf, spec.carryingAmount_wf⟩,
        after_wf := ⟨spec.nextQuantity_wf, spec.nextBasis_wf, spec.nextValuationAllowance_wf,
          spec.nextCarryingAmount_wf⟩,
        quantity_pos := hapos, quantity_le := hle,
        basis := eq_div_of_mul_eq hqne spec.basis,
        valuationAllowance := eq_div_of_mul_eq hqne spec.valuationAllowance,
        carryingAmount := spec.carryingAmount, after_quantity := spec.nextQuantity,
        after_basis := spec.nextBasis, after_valuationAllowance := spec.nextValuationAllowance,
        after_carryingAmount := spec.nextCarryingAmount }
  · rw [hrr]; linarith
  · intro earlier hmem heq
    apply hdup
    rw [List.any_eq_true]
    exact ⟨earlier, hmem, by simpa [allocationOf] using heq⟩

end Lots

/-! ## Laws of the loop of `allocateLots` -/

namespace Lots

/-- One take of the loop: the holding taken from, the allocation pushed, and the holding that
replaces it. -/
structure Taking where
  holding : LotHolding
  allocation : LotAllocation
  after : LotHolding

/-- What a run of the loop that does not reject has done, as the list of its takes in order. -/
structure LoopTrace (inputs : LoopInputs) (candidates : List LotHolding)
    (state final : LoopState) (takes : List Taking) : Prop where
  sublist : (takes.map (·.holding)).Sublist candidates
  allocations : final.allocations = state.allocations ++ takes.map (·.allocation)
  replacements : final.replacements =
    state.replacements ++ takes.map (fun t => (t.holding.id, t.after))
  took : ∀ t ∈ takes, Took t.holding t.allocation t.after
  remaining_wf : final.remaining.WF
  remaining_nonneg : 0 ≤ final.remaining.toRat
  remaining : final.remaining.toRat =
    state.remaining.toRat - (takes.map (·.allocation.allocatedQuantity.toRat)).sum
  chosen : ∀ t ∈ takes, ∃ remaining,
    chooseAllocated inputs t.holding remaining = .ok t.allocation.allocatedQuantity
  ids_fresh : ∀ t ∈ takes, ∀ earlier ∈ state.allocations, earlier.id ≠ t.allocation.id
  ids_nodup : (takes.map (·.allocation.id)).Nodup
  derivation : ∀ t ∈ takes, t.allocation.derivation = inputs.derivation
  identity : ∀ t ∈ takes, ∃ identity,
    inputs.identities.find? (fun identity => identity.holdingId == t.holding.id) = some identity ∧
      t.allocation.id = identity.allocationId
  taken_prefix : (∀ c ∈ candidates, c.remainingQuantity.isZero = false) →
    (takes.map (·.holding)).IsPrefix candidates
  greedy : inputs.specificQuantities = none → inputs.method ≠ .weightedAverage →
    takes.Pairwise (fun t _ => t.allocation.allocatedQuantity = t.holding.remainingQuantity)

/-- A run that takes nothing. -/
theorem LoopTrace.none (inputs : LoopInputs) (candidates : List LotHolding) {state : LoopState}
    (hr : state.remaining.WF) (hn : 0 ≤ state.remaining.toRat) :
    LoopTrace inputs candidates state state [] :=
  { sublist := List.nil_sublist _, allocations := by simp, replacements := by simp,
    took := by simp, remaining_wf := hr, remaining_nonneg := hn, remaining := by simp,
    chosen := by simp, ids_fresh := by simp, ids_nodup := by simp, derivation := by simp,
    identity := by simp, taken_prefix := fun _ => List.nil_prefix, greedy := fun _ _ => by simp }

/-- Once nothing is asked for any more, the loop ends where it is. -/
theorem allocateLoop_of_isZero (inputs : LoopInputs) (candidates : List LotHolding)
    {state : LoopState} (hz : state.remaining.isZero = true) :
    allocateLoop inputs candidates state = .ok (.finished state) := by
  cases candidates with
  | nil => rfl
  | cons holding rest => rw [allocateLoop]; simp [hz]

/-- For first in, last in and highest cost the quantity taken is the whole holding, or what is
still asked for when that is less. -/
theorem chooseAllocated_greedy {inputs : LoopInputs} (hs : inputs.specificQuantities = none)
    (hm : inputs.method ≠ .weightedAverage) (holding : LotHolding) (remaining : ExactRational) :
    chooseAllocated inputs holding remaining =
      .ok (if holding.remainingQuantity.compare remaining ≠ .gt then holding.remainingQuantity
        else remaining) := by
  simp [chooseAllocated, hs, hm]

/-- A run of the loop that does not reject is a list of takes, in the order of the candidates. -/
theorem allocateLoop_finished {inputs : LoopInputs} (hi : inputs.WF) :
    ∀ (candidates : List LotHolding) (state final : LoopState),
      (∀ c ∈ candidates, c.WF ∧ 0 ≤ c.remainingQuantity.toRat) →
      state.remaining.WF → 0 ≤ state.remaining.toRat →
      allocateLoop inputs candidates state = .ok (.finished final) →
      ∃ takes, LoopTrace inputs candidates state final takes := by
  intro candidates
  induction candidates with
  | nil =>
    intro state final _ hr hn h
    simp only [allocateLoop, Except.ok.injEq, LoopResult.finished.injEq] at h
    subst h
    exact ⟨[], LoopTrace.none inputs [] hr hn⟩
  | cons holding rest ih =>
    intro state final hc hr hn h
    have hcr : ∀ c ∈ rest, c.WF ∧ 0 ≤ c.remainingQuantity.toRat :=
      fun c hm => hc c (List.mem_cons_of_mem _ hm)
    rw [allocateLoop] at h
    by_cases hz : state.remaining.isZero = true
    · simp only [hz, ↓reduceIte, Except.ok.injEq, LoopResult.finished.injEq] at h
      subst h
      exact ⟨[], LoopTrace.none inputs _ hr hn⟩
    simp only [hz, Bool.false_eq_true, ↓reduceIte] at h
    by_cases hqz : holding.remainingQuantity.isZero = true
    · simp only [hqz, ↓reduceIte] at h
      obtain ⟨takes, tr⟩ := ih state final hcr hr hn h
      exact ⟨takes,
        { tr with
          sublist := tr.sublist.cons holding
          taken_prefix := fun hall => by
            have := hall holding List.mem_cons_self
            rw [hqz] at this
            cases this }⟩
    simp only [hqz, Bool.false_eq_true, ↓reduceIte] at h
    obtain ⟨hhw, hhn⟩ := hc holding List.mem_cons_self
    have hq : 0 < holding.remainingQuantity.toRat :=
      lt_of_le_of_ne hhn (fun h0 => hqz ((ExactRational.isZero_iff hhw.remainingQuantity).mpr h0.symm))
    have hrp : 0 < state.remaining.toRat :=
      lt_of_le_of_ne hn (fun h0 => hz ((ExactRational.isZero_iff hr).mpr h0.symm))
    cases hs : allocateStep inputs holding state with
    | error e => simp [hs] at h
    | ok stepped =>
    cases stepped with
    | rejected result => simp [hs] at h
    | finished next =>
    simp only [hs] at h
    obtain ⟨allocation, after, hallocs, hreps, htook, hnw, hnn, hnr, hchosen, hfresh, hder, hident⟩ :=
      allocateStep_finished hi hhw hq hr hrp hs
    obtain ⟨takes, tr⟩ := ih next final hcr hnw hnn h
    refine ⟨⟨holding, allocation, after⟩ :: takes, ?_⟩
    exact
      { sublist := by simpa using tr.sublist.cons_cons holding
        allocations := by rw [tr.allocations, hallocs]; simp
        replacements := by rw [tr.replacements, hreps]; simp
        took := by
          intro t ht
          rcases List.mem_cons.mp ht with ht | ht
          · subst ht; exact htook
          · exact tr.took t ht
        remaining_wf := tr.remaining_wf
        remaining_nonneg := tr.remaining_nonneg
        remaining := by rw [tr.remaining, hnr]; simp; ring
        chosen := by
          intro t ht
          rcases List.mem_cons.mp ht with ht | ht
          · subst ht; exact ⟨_, hchosen⟩
          · exact tr.chosen t ht
        ids_fresh := by
          intro t ht earlier he
          rcases List.mem_cons.mp ht with ht | ht
          · subst ht; exact hfresh earlier he
          · exact tr.ids_fresh t ht earlier (by rw [hallocs]; exact List.mem_append_left _ he)
        ids_nodup := by
          rw [List.map_cons, List.nodup_cons]
          refine ⟨fun hm => ?_, tr.ids_nodup⟩
          obtain ⟨t, ht, hid⟩ := List.mem_map.mp hm
          exact tr.ids_fresh t ht allocation (by rw [hallocs]; simp) hid.symm
        derivation := by
          intro t ht
          rcases List.mem_cons.mp ht with ht | ht
          · subst ht; exact hder
          · exact tr.derivation t ht
        identity := by
          intro t ht
          rcases List.mem_cons.mp ht with ht | ht
          · subst ht; exact hident
          · exact tr.identity t ht
        taken_prefix := fun hall => by
          have := tr.taken_prefix (fun c hm => hall c (List.mem_cons_of_mem _ hm))
          simpa using (List.cons_prefix_cons (a := holding) (b := holding)).mpr ⟨rfl, this⟩
        greedy := fun hsq hm => by
          refine List.pairwise_cons.mpr ⟨fun t ht => ?_, tr.greedy hsq hm⟩
          rw [chooseAllocated_greedy hsq hm] at hchosen
          by_cases hcmp : holding.remainingQuantity.compare state.remaining ≠ .gt
          · rw [ite_holds hcmp, Except.ok.injEq] at hchosen
            exact hchosen.symm
          · rw [ite_not_holds hcmp, Except.ok.injEq] at hchosen
            exfalso
            have hzero : next.remaining.isZero = true := by
              rw [ExactRational.isZero_iff hnw, hnr, ← hchosen]
              ring
            have hsame := allocateLoop_of_isZero inputs rest hzero
            rw [hsame] at h
            simp only [Except.ok.injEq, LoopResult.finished.injEq] at h
            have hl := tr.allocations
            rw [← h] at hl
            have : takes.map (·.allocation) = [] := by simpa using hl
            rw [List.map_eq_nil_iff] at this
            rw [this] at ht
            cases ht }

end Lots

/-! ## What an allocation went through -/

namespace Lots

/-- The choice of candidates rejects only a specific identification, and always at the path
`selection.allocations`. -/
theorem selectCandidates_rejected {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection} {result : LotAllocationResult}
    (h : selectCandidates holdings lots requestedQuantity selection = .ok (.rejected result)) :
    (∃ message, result = reject message "selection.allocations") ∧
      selection.method = .specificIdentification := by
  cases selection with
  | specificIdentification allocations =>
    refine ⟨?_, rfl⟩
    simp only [selectCandidates] at h
    by_cases h1 : setSize (allocations.map (·.holdingId)) ≠ allocations.length
    · simp only [ne_eq, h1, not_false_eq_true, ↓reduceIte, Except.ok.injEq,
        Selected.rejected.injEq] at h
      exact ⟨_, h.symm⟩
    simp only [h1, ↓reduceIte] at h
    by_cases h2 : allocations.any
        (fun item => item.quantity.isZero || item.quantity.isNegative) = true
    · simp only [h2, ↓reduceIte, Except.ok.injEq, Selected.rejected.injEq] at h
      exact ⟨_, h.symm⟩
    simp only [h2, Bool.false_eq_true, ↓reduceIte] at h
    cases h3 : addAll ExactRational.zero (allocations.map (·.quantity)) with
    | error e => simp [h3] at h
    | ok declaredTotal =>
    simp only [h3] at h
    by_cases h4 : (!declaredTotal.equals requestedQuantity) = true
    · simp only [h4, ↓reduceIte, Except.ok.injEq, Selected.rejected.injEq] at h
      exact ⟨_, h.symm⟩
    simp only [h4, Bool.false_eq_true, ↓reduceIte] at h
    cases h5 : stableSort
        (fun left right => (.ok (compareText left.holdingId.value right.holdingId.value) :
          Except NumErr Ordering)) allocations with
    | error e => simp [h5] at h
    | ok sorted =>
    simp only [h5] at h
    by_cases h6 : (sorted.filterMap fun item =>
        holdings.find? (fun holding => holding.id == item.holdingId)).length ≠ allocations.length
    · simp only [ne_eq, h6, not_false_eq_true, ↓reduceIte, Except.ok.injEq,
        Selected.rejected.injEq] at h
      exact ⟨_, h.symm⟩
    simp [h6] at h
  | fifo =>
    simp only [selectCandidates] at h
    cases hs : stableSort (compareCandidates LotSelection.fifo.method lots)
        (holdings.filter fun holding => !holding.remainingQuantity.isZero) <;> simp [hs] at h
  | lifo =>
    simp only [selectCandidates] at h
    cases hs : stableSort (compareCandidates LotSelection.lifo.method lots)
        (holdings.filter fun holding => !holding.remainingQuantity.isZero) <;> simp [hs] at h
  | hifo =>
    simp only [selectCandidates] at h
    cases hs : stableSort (compareCandidates LotSelection.hifo.method lots)
        (holdings.filter fun holding => !holding.remainingQuantity.isZero) <;> simp [hs] at h
  | weightedAverage =>
    simp only [selectCandidates] at h
    cases hs : stableSort (compareCandidates LotSelection.weightedAverage.method lots)
        (holdings.filter fun holding => !holding.remainingQuantity.isZero) <;> simp [hs] at h

/-- The three rejections a turn of the loop can return. -/
def StepRejection (result : LotAllocationResult) : Prop :=
  result = reject "A specifically identified allocation exceeds its holding"
    "selection.allocations" ∨
  result = reject
    "Every allocated holding requires one explicitly supplied stable allocation identity"
    "identities" ∨
  ∃ allocationId : LotAllocationId,
    result = .rejected [diagnostic .canonical_identity_conflict "allocations"
      s!"Allocation identifier {allocationId.value} is duplicated" ["ACC-008", "ACC-038"]]

/-- A turn of the loop rejects in one of three ways. -/
theorem allocateStep_rejected {inputs : LoopInputs} {holding : LotHolding} {state : LoopState}
    {result : LotAllocationResult}
    (h : allocateStep inputs holding state = .ok (.rejected result)) : StepRejection result := by
  unfold allocateStep at h
  cases hc : chooseAllocated inputs holding state.remaining with
  | error e => simp [hc] at h
  | ok allocated =>
  simp only [hc] at h
  by_cases hex : allocated.compare holding.remainingQuantity = .gt ∨
      allocated.compare state.remaining = .gt
  · simp only [hex, ↓reduceIte, Except.ok.injEq, LoopResult.rejected.injEq] at h
    exact Or.inl h.symm
  simp only [hex, ↓reduceIte] at h
  cases ht : take holding allocated with
  | error e => simp [ht] at h
  | ok taken =>
  simp only [ht] at h
  cases hf : inputs.identities.find? (fun identity => identity.holdingId == holding.id) with
  | none =>
    simp only [hf, Except.ok.injEq, LoopResult.rejected.injEq] at h
    exact Or.inr (Or.inl h.symm)
  | some identity =>
  simp only [hf] at h
  by_cases hdup : state.allocations.any (fun item => item.id == identity.allocationId) = true
  · simp only [hdup, ↓reduceIte, Except.ok.injEq, LoopResult.rejected.injEq] at h
    exact Or.inr (Or.inr ⟨identity.allocationId, h.symm⟩)
  simp only [hdup, Bool.false_eq_true, ↓reduceIte] at h
  cases hs : state.remaining.subtract allocated <;> simp [hs] at h

/-- The loop rejects in one of three ways. -/
theorem allocateLoop_rejected {inputs : LoopInputs} :
    ∀ (candidates : List LotHolding) (state : LoopState) (result : LotAllocationResult),
      allocateLoop inputs candidates state = .ok (.rejected result) → StepRejection result := by
  intro candidates
  induction candidates with
  | nil => intro state result h; simp [allocateLoop] at h
  | cons holding rest ih =>
    intro state result h
    rw [allocateLoop] at h
    by_cases hz : state.remaining.isZero = true
    · simp [hz] at h
    simp only [hz, Bool.false_eq_true, ↓reduceIte] at h
    by_cases hqz : holding.remainingQuantity.isZero = true
    · simp only [hqz, ↓reduceIte] at h
      exact ih state result h
    simp only [hqz, Bool.false_eq_true, ↓reduceIte] at h
    cases hs : allocateStep inputs holding state with
    | error e => simp [hs] at h
    | ok stepped =>
    cases stepped with
    | rejected stepResult =>
      simp only [hs, Except.ok.injEq, LoopResult.rejected.injEq] at h
      subst h
      exact allocateStep_rejected hs
    | finished next =>
      simp only [hs] at h
      exact ih next result h

/-- The inputs of the loop as `allocateLots` sets them. -/
def loopInputs (requestedQuantity : ExactRational) (selection : LotSelection)
    (derivation : DerivationRecord) (identities : List LotAllocationIdentity)
    (specificQuantities : Option (List (LotHoldingId × ExactRational)))
    (weightedAvailable : Option ExactRational) : LoopInputs :=
  { method := selection.method, requestedQuantity, specificQuantities, weightedAvailable,
    derivation, identities }

/-- The state of the loop as `allocateLots` starts it. -/
def startState (requestedQuantity : ExactRational) : LoopState :=
  { remaining := requestedQuantity, replacements := [], allocations := [] }

/-- An allocation is returned only after every check has passed, in this order: the holdings are
valid, the request is positive, no lot identifier is repeated, candidates were chosen, each resolves
a usable lot, they are of one book and commodity, and the loop ran out with nothing left to take. -/
theorem allocateLots_allocated_inv {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection} {derivation : DerivationRecord}
    {identities : List LotAllocationIdentity} {allocations : List LotAllocation}
    {after : List LotHolding}
    (h : allocateLots holdings lots requestedQuantity selection derivation identities =
      .ok (.allocated allocations after)) :
    validateHoldings holdings = .ok [] ∧
    requestedQuantity.isZero = false ∧ requestedQuantity.isNegative = false ∧
    (lots.map (·.id)).Nodup ∧
    ∃ candidates specificQuantities available final,
      selectCandidates holdings lots requestedQuantity selection =
        .ok (.candidates candidates specificQuantities) ∧
      candidates.any (lotUnresolved lots) = false ∧
      (∀ first, candidates.head? = some first → candidates.any (mixesScope first) = false) ∧
      weightedAvailable selection.method candidates = .ok available ∧
      allocateLoop
        (loopInputs requestedQuantity selection derivation identities specificQuantities available)
        candidates (startState requestedQuantity) = .ok (.finished final) ∧
      final.remaining.isZero = true ∧
      allocations = final.allocations ∧
      after = applyReplacements final.replacements holdings := by
  unfold allocateLots at h
  cases hv : validateHoldings holdings with
  | error e => simp [hv] at h
  | ok initialDiagnostics =>
  simp only [hv] at h
  by_cases hlen : initialDiagnostics.length > 0
  · simp [hlen] at h
  simp only [hlen, ↓reduceIte] at h
  have hnil : initialDiagnostics = [] := List.length_eq_zero_iff.mp (by omega)
  by_cases hreq : (requestedQuantity.isZero || requestedQuantity.isNegative) = true
  · simp [hreq, reject] at h
  simp only [hreq, Bool.false_eq_true, ↓reduceIte] at h
  rw [Bool.or_eq_true, not_or] at hreq
  by_cases hlots : setSize (lots.map (·.id)) ≠ lots.length
  · simp [hlots] at h
  simp only [hlots, ↓reduceIte] at h
  have hlots' : (lots.map (·.id)).Nodup := by
    rw [← setSize_eq_length_iff]
    simpa using hlots
  cases hsel : selectCandidates holdings lots requestedQuantity selection with
  | error e => simp [hsel] at h
  | ok selected =>
  cases selected with
  | rejected result =>
    simp only [hsel, Except.ok.injEq] at h
    obtain ⟨⟨message, hm⟩, -⟩ := selectCandidates_rejected hsel
    rw [hm] at h
    simp [reject] at h
  | candidates candidates specificQuantities =>
  simp only [hsel] at h
  by_cases hun : candidates.any (lotUnresolved lots) = true
  · simp [hun, reject] at h
  simp only [hun, Bool.false_eq_true, ↓reduceIte] at h
  by_cases hmix : (match candidates.head? with
      | some first => candidates.any (mixesScope first)
      | none => false) = true
  · simp [hmix, reject] at h
  simp only [hmix, Bool.false_eq_true, ↓reduceIte] at h
  cases hwa : weightedAvailable selection.method candidates with
  | error e => simp [hwa] at h
  | ok available =>
  simp only [hwa] at h
  cases hloop : allocateLoop
      (loopInputs requestedQuantity selection derivation identities specificQuantities available)
      candidates (startState requestedQuantity) with
  | error e =>
    simp only [loopInputs, startState] at hloop
    simp [hloop] at h
  | ok looped =>
  have hloop' := hloop
  simp only [loopInputs, startState] at hloop
  cases looped with
  | rejected result =>
    simp only [hloop, Except.ok.injEq] at h
    rcases allocateLoop_rejected _ _ _ hloop' with hr | hr | ⟨allocationId, hr⟩ <;>
      · rw [hr] at h
        simp [reject] at h
  | finished final =>
  simp only [hloop] at h
  by_cases hrem : (!final.remaining.isZero) = true
  · simp [hrem, reject] at h
  simp only [hrem, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq,
    LotAllocationResult.allocated.injEq] at h
  refine ⟨by rw [hnil], by simpa using hreq.1, by simpa using hreq.2, hlots', candidates,
    specificQuantities, available, final, rfl, by simpa using hun, ?_, hwa, hloop',
    by simpa using hrem, h.1.symm, h.2.symm⟩
  intro first hfirst
  rw [hfirst] at hmix
  simpa using hmix

/-- Candidates of a specific identification: no holding is named twice, every named quantity is
positive, the named quantities add up to the request, and the candidates are the named holdings
that exist, in the order of their identifiers, none missing. -/
theorem selectCandidates_specific {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {allocations : List SpecificAllocation}
    {candidates : List LotHolding} {specificQuantities : Option (List (LotHoldingId × ExactRational))}
    (h : selectCandidates holdings lots requestedQuantity (.specificIdentification allocations) =
      .ok (.candidates candidates specificQuantities)) :
    (allocations.map (·.holdingId)).Nodup ∧
    (∀ item ∈ allocations, item.quantity.isZero = false ∧ item.quantity.isNegative = false) ∧
    (∃ declaredTotal, addAll ExactRational.zero (allocations.map (·.quantity)) = .ok declaredTotal ∧
      declaredTotal.equals requestedQuantity = true) ∧
    (∃ sorted, stableSort
        (fun left right => (.ok (compareText left.holdingId.value right.holdingId.value) :
          Except NumErr Ordering)) allocations = .ok sorted ∧
      candidates = sorted.filterMap fun item =>
        holdings.find? (fun holding => holding.id == item.holdingId)) ∧
    candidates.length = allocations.length ∧
    specificQuantities = some (allocations.map fun item => (item.holdingId, item.quantity)) := by
  simp only [selectCandidates] at h
  by_cases h1 : setSize (allocations.map (·.holdingId)) ≠ allocations.length
  · simp [h1] at h
  simp only [h1, ↓reduceIte] at h
  by_cases h2 : allocations.any
      (fun item => item.quantity.isZero || item.quantity.isNegative) = true
  · simp [h2] at h
  simp only [h2, Bool.false_eq_true, ↓reduceIte] at h
  cases h3 : addAll ExactRational.zero (allocations.map (·.quantity)) with
  | error e => simp [h3] at h
  | ok declaredTotal =>
  simp only [h3] at h
  by_cases h4 : (!declaredTotal.equals requestedQuantity) = true
  · simp [h4] at h
  simp only [h4, Bool.false_eq_true, ↓reduceIte] at h
  cases h5 : stableSort
      (fun left right => (.ok (compareText left.holdingId.value right.holdingId.value) :
        Except NumErr Ordering)) allocations with
  | error e => simp [h5] at h
  | ok sorted =>
  simp only [h5] at h
  by_cases h6 : (sorted.filterMap fun item =>
      holdings.find? (fun holding => holding.id == item.holdingId)).length ≠ allocations.length
  · simp [h6] at h
  simp only [h6, ↓reduceIte, Except.ok.injEq, Selected.candidates.injEq] at h
  obtain ⟨hc, hq⟩ := h
  refine ⟨?_, ?_, ⟨declaredTotal, rfl, by simpa using h4⟩, ⟨sorted, rfl, hc.symm⟩, ?_, hq.symm⟩
  · rw [← setSize_eq_length_iff]
    simpa using h1
  · intro item hitem
    have := h2
    rw [List.any_eq_true] at this
    constructor
    · by_contra hz
      exact this ⟨item, hitem, by rw [Bool.or_eq_true]; exact Or.inl (by simpa using hz)⟩
    · by_contra hn
      exact this ⟨item, hitem, by rw [Bool.or_eq_true]; exact Or.inr (by simpa using hn)⟩
  · rw [← hc]
    simpa using h6

/-- Candidates of every other method: the holdings that have some quantity, sorted by the method. -/
theorem selectCandidates_ordered {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {candidates : List LotHolding} {specificQuantities : Option (List (LotHoldingId × ExactRational))}
    (hm : selection.method ≠ .specificIdentification)
    (h : selectCandidates holdings lots requestedQuantity selection =
      .ok (.candidates candidates specificQuantities)) :
    stableSort (compareCandidates selection.method lots)
      (holdings.filter fun holding => !holding.remainingQuantity.isZero) = .ok candidates ∧
    specificQuantities = none := by
  cases selection with
  | specificIdentification allocations => exact absurd rfl hm
  | fifo =>
    simp only [selectCandidates] at h
    cases hs : stableSort (compareCandidates LotSelection.fifo.method lots)
        (holdings.filter fun holding => !holding.remainingQuantity.isZero) with
    | error e => simp [hs] at h
    | ok sorted => simp only [hs, Except.ok.injEq, Selected.candidates.injEq] at h; simp [h]
  | lifo =>
    simp only [selectCandidates] at h
    cases hs : stableSort (compareCandidates LotSelection.lifo.method lots)
        (holdings.filter fun holding => !holding.remainingQuantity.isZero) with
    | error e => simp [hs] at h
    | ok sorted => simp only [hs, Except.ok.injEq, Selected.candidates.injEq] at h; simp [h]
  | hifo =>
    simp only [selectCandidates] at h
    cases hs : stableSort (compareCandidates LotSelection.hifo.method lots)
        (holdings.filter fun holding => !holding.remainingQuantity.isZero) with
    | error e => simp [hs] at h
    | ok sorted => simp only [hs, Except.ok.injEq, Selected.candidates.injEq] at h; simp [h]
  | weightedAverage =>
    simp only [selectCandidates] at h
    cases hs : stableSort (compareCandidates LotSelection.weightedAverage.method lots)
        (holdings.filter fun holding => !holding.remainingQuantity.isZero) with
    | error e => simp [hs] at h
    | ok sorted => simp only [hs, Except.ok.injEq, Selected.candidates.injEq] at h; simp [h]

end Lots

/-- A selection whose named quantities are numbers the TypeScript can construct. -/
def LotSelection.WF : LotSelection → Prop
  | .specificIdentification allocations => ∀ item ∈ allocations, item.quantity.WF
  | _ => True

namespace Lots

/-- Keeping some elements and renaming them gives part of the renamed list. -/
theorem map_filterMap_sublist {α β γ : Type} (f : α → Option β) (g : β → γ) (k : α → γ)
    (h : ∀ x y, f x = some y → g y = k x) :
    ∀ l : List α, ((l.filterMap f).map g).Sublist (l.map k) := by
  intro l
  induction l with
  | nil => simp
  | cons x rest ih =>
    cases hx : f x with
    | none =>
      rw [List.filterMap_cons_none hx, List.map_cons]
      exact ih.cons _
    | some y =>
      rw [List.filterMap_cons_some hx, List.map_cons, List.map_cons, h x y hx]
      exact ih.cons_cons _

/-- The candidates are holdings that were given, and no two of them have the same identifier. -/
theorem selectCandidates_candidates {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {candidates : List LotHolding} {specificQuantities : Option (List (LotHoldingId × ExactRational))}
    (hn : (holdings.map (·.id)).Nodup)
    (h : selectCandidates holdings lots requestedQuantity selection =
      .ok (.candidates candidates specificQuantities)) :
    (∀ c ∈ candidates, c ∈ holdings) ∧ (candidates.map (·.id)).Nodup := by
  by_cases hm : selection.method = .specificIdentification
  · cases selection with
    | specificIdentification allocations =>
      obtain ⟨hnodup, -, -, ⟨sorted, hsorted, hc⟩, -, -⟩ := selectCandidates_specific h
      subst hc
      constructor
      · intro c hmem
        obtain ⟨item, -, hfind⟩ := List.mem_filterMap.mp hmem
        exact List.mem_of_find?_eq_some hfind
      · have hsub := map_filterMap_sublist
          (fun item : SpecificAllocation =>
            holdings.find? (fun holding => holding.id == item.holdingId))
          (·.id) (·.holdingId)
          (fun item found hfind => by simpa using List.find?_some hfind) sorted
        have hperm := (stableSort_perm _ _ _ hsorted).map (·.holdingId)
        exact (hperm.nodup_iff.mpr hnodup).sublist hsub
    | fifo => cases hm
    | lifo => cases hm
    | hifo => cases hm
    | weightedAverage => cases hm
  · obtain ⟨hsorted, -⟩ := selectCandidates_ordered hm h
    have hperm := stableSort_perm _ _ _ hsorted
    constructor
    · intro c hmem
      exact List.mem_of_mem_filter (hperm.mem_iff.mp hmem)
    · exact ((hperm.map (·.id)).nodup_iff).mpr
        (hn.sublist (List.filter_sublist.map _))

/-- The holding returned in the place of `holding` after the takes of a run. -/
def afterOf (takes : List Taking) (holding : LotHolding) : LotHolding :=
  (mapGet (takes.map fun t => (t.holding.id, t.after)) holding.id).getD holding

/-- Everything that is known of a call of `allocateLots` that returned an allocation. -/
structure Run (holdings : List LotHolding) (lots : List Lot) (requestedQuantity : ExactRational)
    (selection : LotSelection) (derivation : DerivationRecord)
    (identities : List LotAllocationIdentity) (allocations : List LotAllocation)
    (after : List LotHolding) (candidates : List LotHolding)
    (specificQuantities : Option (List (LotHoldingId × ExactRational)))
    (available : Option ExactRational) (final : LoopState) (takes : List Taking) : Prop where
  lots_nodup : (lots.map (·.id)).Nodup
  holdings_nodup : (holdings.map (·.id)).Nodup
  holdings_valid : ∀ holding ∈ holdings, holding.Valid
  requested_pos : 0 < requestedQuantity.toRat
  selected : selectCandidates holdings lots requestedQuantity selection =
    .ok (.candidates candidates specificQuantities)
  resolved : candidates.any (lotUnresolved lots) = false
  one_scope : ∀ first, candidates.head? = some first →
    candidates.any (mixesScope first) = false
  available_eq : weightedAvailable selection.method candidates = .ok available
  candidates_mem : ∀ c ∈ candidates, c ∈ holdings
  candidates_nodup : (candidates.map (·.id)).Nodup
  inputs_wf :
    (loopInputs requestedQuantity selection derivation identities specificQuantities available).WF
  trace : LoopTrace
    (loopInputs requestedQuantity selection derivation identities specificQuantities available)
    candidates (startState requestedQuantity) final takes
  allocations_eq : allocations = takes.map (·.allocation)
  after_eq : after = holdings.map (afterOf takes)
  total : (takes.map (·.allocation.allocatedQuantity.toRat)).sum = requestedQuantity.toRat

/-- A constructible number that is neither zero nor negative is positive. -/
theorem pos_of_not_zero_not_negative {value : ExactRational} (hw : value.WF)
    (hz : value.isZero = false) (hn : value.isNegative = false) : 0 < value.toRat := by
  have h1 : value.toRat ≠ 0 := fun h0 => by
    rw [(ExactRational.isZero_iff hw).mpr h0] at hz
    cases hz
  have h2 : ¬ value.toRat < 0 := fun hlt => by
    rw [(ExactRational.isNegative_iff hw).mpr hlt] at hn
    cases hn
  exact lt_of_le_of_ne (not_lt.mp h2) (Ne.symm h1)

/-- What the loop reads is as `LoopInputs.WF` says, once the choice of candidates has passed. -/
theorem loopInputs_wf {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {candidates : List LotHolding} {specificQuantities : Option (List (LotHoldingId × ExactRational))}
    {available : Option ExactRational} (derivation : DerivationRecord)
    (identities : List LotAllocationIdentity)
    (hr : requestedQuantity.WF) (hs : selection.WF) (hpos : 0 < requestedQuantity.toRat)
    (hc : ∀ c ∈ candidates, c.WF ∧ 0 ≤ c.remainingQuantity.toRat)
    (hsel : selectCandidates holdings lots requestedQuantity selection =
      .ok (.candidates candidates specificQuantities))
    (hwa : weightedAvailable selection.method candidates = .ok available) :
    (loopInputs requestedQuantity selection derivation identities specificQuantities
      available).WF := by
  refine ⟨hr, hpos, ?_, ?_⟩
  · intro quantities hq entry hentry
    simp only [loopInputs] at hq
    by_cases hm : selection.method = .specificIdentification
    · cases selection with
      | specificIdentification allocations =>
        obtain ⟨-, hquant, -, -, -, hsq⟩ := selectCandidates_specific hsel
        rw [hsq, Option.some.injEq] at hq
        subst hq
        obtain ⟨item, hitem, rfl⟩ := List.mem_map.mp hentry
        exact ⟨hs item hitem,
          pos_of_not_zero_not_negative (hs item hitem) (hquant item hitem).1 (hquant item hitem).2⟩
      | fifo => cases hm
      | lifo => cases hm
      | hifo => cases hm
      | weightedAverage => cases hm
    · rw [(selectCandidates_ordered hm hsel).2] at hq
      cases hq
  · intro total htotal
    simp only [loopInputs] at htotal
    unfold weightedAvailable at hwa
    by_cases hm : selection.method = .weightedAverage
    · simp only [hm, ↓reduceIte] at hwa
      cases ha : addAll ExactRational.zero (candidates.map (·.remainingQuantity)) with
      | error e => simp [ha] at hwa
      | ok sum =>
        simp only [ha, Except.ok.injEq] at hwa
        rw [← hwa, Option.some.injEq] at htotal
        subst htotal
        obtain ⟨hw, hrat⟩ := addAll_ok _ _ _ ExactRational.zero_wf
          (fun q hq => by
            obtain ⟨c, hcm, rfl⟩ := List.mem_map.mp hq
            exact (hc c hcm).1.remainingQuantity) ha
        refine ⟨hw, ?_⟩
        rw [hrat, ExactRational.zero_toRat, zero_add]
        apply List.sum_nonneg
        intro x hx
        simp only [List.map_map, List.mem_map, Function.comp] at hx
        obtain ⟨c, hcm, rfl⟩ := hx
        exact (hc c hcm).2
    · simp only [hm, ↓reduceIte, Except.ok.injEq] at hwa
      rw [← hwa] at htotal
      cases htotal

/-- A returned allocation is the record of a run of takes over the candidates. -/
theorem allocateLots_run {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection} {derivation : DerivationRecord}
    {identities : List LotAllocationIdentity} {allocations : List LotAllocation}
    {after : List LotHolding}
    (hw : ∀ holding ∈ holdings, holding.WF) (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : allocateLots holdings lots requestedQuantity selection derivation identities =
      .ok (.allocated allocations after)) :
    ∃ candidates specificQuantities available final takes,
      Run holdings lots requestedQuantity selection derivation identities allocations after
        candidates specificQuantities available final takes := by
  obtain ⟨hvalid, hz, hn, hlots, candidates, specificQuantities, available, final, hsel, hres,
    hscope, hwa, hloop, hrem, hallocs, hafter⟩ := allocateLots_allocated_inv h
  obtain ⟨hnodup, hval⟩ := (validateHoldings_nil_iff hw).mp hvalid
  have hpos := pos_of_not_zero_not_negative hr hz hn
  obtain ⟨hmem, hcn⟩ := selectCandidates_candidates hnodup hsel
  have hc : ∀ c ∈ candidates, c.WF ∧ 0 ≤ c.remainingQuantity.toRat :=
    fun c hcm => ⟨hw c (hmem c hcm), (hval c (hmem c hcm)).1.quantity_nonneg⟩
  have hi := loopInputs_wf derivation identities hr hs hpos hc hsel hwa
  obtain ⟨takes, tr⟩ := allocateLoop_finished hi candidates (startState requestedQuantity) final hc
    hr (le_of_lt hpos) hloop
  refine ⟨candidates, specificQuantities, available, final, takes,
    { lots_nodup := hlots, holdings_nodup := hnodup, holdings_valid := fun x hx => (hval x hx).1,
      requested_pos := hpos, selected := hsel, resolved := hres, one_scope := hscope,
      available_eq := hwa, candidates_mem := hmem, candidates_nodup := hcn, inputs_wf := hi,
      trace := tr, allocations_eq := ?_, after_eq := ?_, total := ?_ }⟩
  · rw [hallocs, tr.allocations]
    simp [startState]
  · rw [hafter, tr.replacements]
    simp [startState, applyReplacements, afterOf]
  · have := tr.remaining
    rw [(ExactRational.isZero_iff tr.remaining_wf).mp hrem] at this
    simp only [startState] at this
    linarith

/-- A sum of differences is the difference of the sums. -/
theorem sum_map_sub_of {α : Type} (l : List α) (f g d : α → ℚ) (h : ∀ x ∈ l, f x = g x - d x) :
    (l.map f).sum = (l.map g).sum - (l.map d).sum := by
  induction l with
  | nil => simp
  | cons x rest ih =>
    simp only [List.map_cons, List.sum_cons]
    rw [ih (fun y hy => h y (List.mem_cons_of_mem _ hy)), h x List.mem_cons_self]
    ring

namespace Run

variable {holdings : List LotHolding} {lots : List Lot} {requestedQuantity : ExactRational}
  {selection : LotSelection} {derivation : DerivationRecord}
  {identities : List LotAllocationIdentity} {allocations : List LotAllocation}
  {after : List LotHolding} {candidates : List LotHolding}
  {specificQuantities : Option (List (LotHoldingId × ExactRational))}
  {available : Option ExactRational} {final : LoopState} {takes : List Taking}

/-- No holding is taken from twice. -/
theorem taken_nodup
    (run : Run holdings lots requestedQuantity selection derivation identities allocations after
      candidates specificQuantities available final takes) :
    (takes.map (·.holding.id)).Nodup := by
  have := run.candidates_nodup.sublist (run.trace.sublist.map (·.id))
  rw [List.map_map] at this
  exact this

/-- Every holding taken from is one of the holdings given. -/
theorem taken_mem
    (run : Run holdings lots requestedQuantity selection derivation identities allocations after
      candidates specificQuantities available final takes) :
    ∀ t ∈ takes, t.holding ∈ holdings := fun t ht =>
  run.candidates_mem _ (run.trace.sublist.subset (List.mem_map_of_mem (f := (·.holding)) ht))

/-- A holding taken from is returned as what the take left. -/
theorem afterOf_taken
    (run : Run holdings lots requestedQuantity selection derivation identities allocations after
      candidates specificQuantities available final takes) :
    ∀ t ∈ takes, afterOf takes t.holding = t.after := by
  intro t ht
  unfold afterOf
  have hkeys : ((takes.map fun t => (t.holding.id, t.after)).map (·.1)).Nodup := by
    rw [List.map_map]
    exact run.taken_nodup
  rw [(mapGet_eq_some_iff hkeys t.holding.id t.after).mpr
    (List.mem_map.mpr ⟨t, ht, rfl⟩)]
  rfl

/-- A holding not taken from is returned as it was. -/
theorem afterOf_untouched (takes : List Taking) (holding : LotHolding)
    (h : ∀ t ∈ takes, t.holding.id ≠ holding.id) : afterOf takes holding = holding := by
  unfold afterOf
  rw [(mapGet_eq_none_iff _ _).mpr (by
    intro entry hentry
    obtain ⟨t, ht, rfl⟩ := List.mem_map.mp hentry
    exact h t ht)]
  rfl

/-- Among the holdings given, the identifier tells which holding a take was from. -/
theorem taken_eq
    (run : Run holdings lots requestedQuantity selection derivation identities allocations after
      candidates specificQuantities available final takes)
    {t : Taking} (ht : t ∈ takes) {holding : LotHolding} (hh : holding ∈ holdings)
    (hid : t.holding.id = holding.id) : t.holding = holding :=
  List.inj_on_of_nodup_map run.holdings_nodup (run.taken_mem t ht) hh hid

/-- The holdings given are the holdings taken from and the others. -/
theorem holdings_perm
    (run : Run holdings lots requestedQuantity selection derivation identities allocations after
      candidates specificQuantities available final takes) :
    holdings.Perm (takes.map (·.holding) ++
      holdings.filter (fun holding => !decide (holding.id ∈ takes.map (·.holding.id)))) := by
  refine (List.filter_append_perm
    (fun holding => decide (holding.id ∈ takes.map (·.holding.id))) holdings).symm.trans
    (List.Perm.append_right _ ?_)
  have hn1 : (holdings.filter
      (fun holding => decide (holding.id ∈ takes.map (·.holding.id)))).Nodup :=
    (List.Nodup.of_map _ run.holdings_nodup).sublist List.filter_sublist
  have hn2 : (takes.map (·.holding)).Nodup := by
    apply List.Nodup.of_map (·.id)
    rw [List.map_map]
    exact run.taken_nodup
  refine (List.perm_ext_iff_of_nodup hn1 hn2).mpr (fun holding => ?_)
  simp only [List.mem_filter, decide_eq_true_eq, List.mem_map]
  constructor
  · rintro ⟨hh, t, ht, hid⟩
    exact ⟨t, ht, run.taken_eq ht hh hid⟩
  · rintro ⟨t, ht, rfl⟩
    exact ⟨run.taken_mem t ht, t, ht, rfl⟩

/-- For any amount of a holding that a take lowers by an amount of its allocation, the total over
the holdings returned is the total over the holdings given less the total over the allocations. -/
theorem sum_after
    (run : Run holdings lots requestedQuantity selection derivation identities allocations after
      candidates specificQuantities available final takes)
    (g : LotHolding → ℚ) (d : LotAllocation → ℚ)
    (hg : ∀ t ∈ takes, g t.after = g t.holding - d t.allocation) :
    (after.map g).sum = (holdings.map g).sum - (allocations.map d).sum := by
  have hperm := run.holdings_perm
  have e1 := ((hperm.map (fun holding => g (afterOf takes holding))).sum_eq)
  have e2 := ((hperm.map g).sum_eq)
  rw [List.map_append, List.sum_append, List.map_map] at e1 e2
  have e3 : (takes.map ((fun holding => g (afterOf takes holding)) ∘ fun t => t.holding)).sum =
      (takes.map (g ∘ fun t => t.holding)).sum - (takes.map (fun t => d t.allocation)).sum := by
    apply sum_map_sub_of
    intro t ht
    simp only [Function.comp]
    rw [run.afterOf_taken t ht]
    exact hg t ht
  have e4 : ((holdings.filter
        (fun holding => !decide (holding.id ∈ takes.map (·.holding.id)))).map
        (fun holding => g (afterOf takes holding))) =
      (holdings.filter
        (fun holding => !decide (holding.id ∈ takes.map (·.holding.id)))).map g := by
    apply List.map_congr_left
    intro holding hmem
    rw [List.mem_filter] at hmem
    rw [afterOf_untouched takes holding (fun t ht hid => by
      have := hmem.2
      simp only [Bool.not_eq_true', decide_eq_false_iff_not, List.mem_map, not_exists,
        not_and] at this
      exact this t ht hid)]
  rw [run.after_eq, run.allocations_eq, List.map_map, List.map_map]
  simp only [Function.comp_def] at e1 e2 e3 ⊢
  rw [e1, e2, e3, e4]
  ring

end Run

end Lots

/-! ## Laws of `allocateLots`: what an allocation conserves -/

/-- The quantities allocated add up to exactly the quantity requested. -/
theorem allocateLots_quantity {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection} {derivation : DerivationRecord}
    {identities : List LotAllocationIdentity} {allocations : List LotAllocation}
    {after : List LotHolding}
    (hw : ∀ holding ∈ holdings, holding.WF) (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : allocateLots holdings lots requestedQuantity selection derivation identities =
      .ok (.allocated allocations after)) :
    (allocations.map (·.allocatedQuantity.toRat)).sum = requestedQuantity.toRat := by
  obtain ⟨candidates, specificQuantities, available, final, takes, run⟩ :=
    Lots.allocateLots_run hw hr hs h
  rw [run.allocations_eq, List.map_map]
  exact run.total

/-- The holdings returned are the holdings given, one for one and in the same order: a holding
that no allocation names is returned unchanged, and a holding that an allocation names is returned
with exactly what that allocation took removed from it (`Lots.Took`: a positive quantity, no more
than it held, with the basis and the valuation allowance in proportion). -/
theorem allocateLots_holdings {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection} {derivation : DerivationRecord}
    {identities : List LotAllocationIdentity} {allocations : List LotAllocation}
    {after : List LotHolding}
    (hw : ∀ holding ∈ holdings, holding.WF) (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : allocateLots holdings lots requestedQuantity selection derivation identities =
      .ok (.allocated allocations after)) :
    List.Forall₂ (fun before left =>
      (left = before ∧ ∀ allocation ∈ allocations, allocation.holdingId ≠ before.id) ∨
      (∃ allocation ∈ allocations, Lots.Took before allocation left)) holdings after := by
  obtain ⟨candidates, specificQuantities, available, final, takes, run⟩ :=
    Lots.allocateLots_run hw hr hs h
  rw [run.after_eq, List.forall₂_map_right_iff, List.forall₂_same]
  intro holding hh
  by_cases htaken : ∃ t ∈ takes, t.holding.id = holding.id
  · obtain ⟨t, ht, hid⟩ := htaken
    have heq := run.taken_eq ht hh hid
    right
    refine ⟨t.allocation, by rw [run.allocations_eq]; exact List.mem_map_of_mem ht, ?_⟩
    rw [← heq, run.afterOf_taken t ht]
    exact run.trace.took t ht
  · left
    refine ⟨Lots.Run.afterOf_untouched takes holding (fun t ht hid => htaken ⟨t, ht, hid⟩), ?_⟩
    intro allocation hmem hid
    rw [run.allocations_eq] at hmem
    obtain ⟨t, ht, rfl⟩ := List.mem_map.mp hmem
    exact htaken ⟨t, ht, (run.trace.took t ht).holdingId.symm.trans hid⟩

/-- Lot by lot (`w` weighs each lot; take it 1 on one lot and 0 elsewhere): what the holdings
returned hold of quantity, of basis, of valuation allowance and of carrying amount is what the
holdings given held less what the allocations carry, exactly. -/
theorem allocateLots_conserves_by_lot {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection} {derivation : DerivationRecord}
    {identities : List LotAllocationIdentity} {allocations : List LotAllocation}
    {after : List LotHolding}
    (hw : ∀ holding ∈ holdings, holding.WF) (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : allocateLots holdings lots requestedQuantity selection derivation identities =
      .ok (.allocated allocations after)) (w : LotId → ℚ) :
    (after.map fun x => w x.lotId * x.remainingQuantity.toRat).sum =
      (holdings.map fun x => w x.lotId * x.remainingQuantity.toRat).sum -
        (allocations.map fun a => w a.lotId * a.allocatedQuantity.toRat).sum ∧
    (after.map fun x => w x.lotId * x.remainingTotalBasis.toRat).sum =
      (holdings.map fun x => w x.lotId * x.remainingTotalBasis.toRat).sum -
        (allocations.map fun a => w a.lotId * a.allocatedTotalBasis.toRat).sum ∧
    (after.map fun x => w x.lotId * x.remainingValuationAllowance.toRat).sum =
      (holdings.map fun x => w x.lotId * x.remainingValuationAllowance.toRat).sum -
        (allocations.map fun a => w a.lotId * a.allocatedValuationAllowance.toRat).sum ∧
    (after.map fun x => w x.lotId * x.remainingCarryingAmount.toRat).sum =
      (holdings.map fun x => w x.lotId * x.remainingCarryingAmount.toRat).sum -
        (allocations.map fun a => w a.lotId * a.allocatedCarryingAmount.toRat).sum := by
  obtain ⟨candidates, specificQuantities, available, final, takes, run⟩ :=
    Lots.allocateLots_run hw hr hs h
  refine ⟨run.sum_after _ _ ?_, run.sum_after _ _ ?_, run.sum_after _ _ ?_, run.sum_after _ _ ?_⟩
  · intro t ht
    have k := run.trace.took t ht
    rw [k.after_lotId, k.lotId, k.after_quantity]
    ring
  · intro t ht
    have k := run.trace.took t ht
    rw [k.after_lotId, k.lotId, k.after_basis]
    ring
  · intro t ht
    have k := run.trace.took t ht
    rw [k.after_lotId, k.lotId, k.after_valuationAllowance]
    ring
  · intro t ht
    have k := run.trace.took t ht
    have v := run.holdings_valid _ (run.taken_mem t ht)
    rw [k.after_lotId, k.lotId, k.after_carryingAmount, k.after_basis, k.after_valuationAllowance,
      k.carryingAmount, v.carrying]
    ring

/-- The total quantity across the holdings falls by exactly the quantity requested. -/
theorem allocateLots_total_quantity {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection} {derivation : DerivationRecord}
    {identities : List LotAllocationIdentity} {allocations : List LotAllocation}
    {after : List LotHolding}
    (hw : ∀ holding ∈ holdings, holding.WF) (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : allocateLots holdings lots requestedQuantity selection derivation identities =
      .ok (.allocated allocations after)) :
    (after.map (·.remainingQuantity.toRat)).sum =
      (holdings.map (·.remainingQuantity.toRat)).sum - requestedQuantity.toRat := by
  have := (allocateLots_conserves_by_lot hw hr hs h (fun _ => 1)).1
  simp only [one_mul] at this
  rw [this, allocateLots_quantity hw hr hs h]

/-- The cost basis removed from the holdings is exactly the cost basis the allocations carry: what
the holdings returned hold plus what was allocated is what the holdings given held. -/
theorem allocateLots_basis_conserved {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection} {derivation : DerivationRecord}
    {identities : List LotAllocationIdentity} {allocations : List LotAllocation}
    {after : List LotHolding}
    (hw : ∀ holding ∈ holdings, holding.WF) (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : allocateLots holdings lots requestedQuantity selection derivation identities =
      .ok (.allocated allocations after)) :
    (after.map (·.remainingTotalBasis.toRat)).sum +
        (allocations.map (·.allocatedTotalBasis.toRat)).sum =
      (holdings.map (·.remainingTotalBasis.toRat)).sum := by
  have := (allocateLots_conserves_by_lot hw hr hs h (fun _ => 1)).2.1
  simp only [one_mul] at this
  rw [this]
  ring

/-- The valuation allowance removed from the holdings is exactly what the allocations carry. -/
theorem allocateLots_valuationAllowance_conserved {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection} {derivation : DerivationRecord}
    {identities : List LotAllocationIdentity} {allocations : List LotAllocation}
    {after : List LotHolding}
    (hw : ∀ holding ∈ holdings, holding.WF) (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : allocateLots holdings lots requestedQuantity selection derivation identities =
      .ok (.allocated allocations after)) :
    (after.map (·.remainingValuationAllowance.toRat)).sum +
        (allocations.map (·.allocatedValuationAllowance.toRat)).sum =
      (holdings.map (·.remainingValuationAllowance.toRat)).sum := by
  have := (allocateLots_conserves_by_lot hw hr hs h (fun _ => 1)).2.2.1
  simp only [one_mul] at this
  rw [this]
  ring

/-- The carrying amount removed from the holdings is exactly what the allocations carry. -/
theorem allocateLots_carryingAmount_conserved {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection} {derivation : DerivationRecord}
    {identities : List LotAllocationIdentity} {allocations : List LotAllocation}
    {after : List LotHolding}
    (hw : ∀ holding ∈ holdings, holding.WF) (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : allocateLots holdings lots requestedQuantity selection derivation identities =
      .ok (.allocated allocations after)) :
    (after.map (·.remainingCarryingAmount.toRat)).sum +
        (allocations.map (·.allocatedCarryingAmount.toRat)).sum =
      (holdings.map (·.remainingCarryingAmount.toRat)).sum := by
  have := (allocateLots_conserves_by_lot hw hr hs h (fun _ => 1)).2.2.2
  simp only [one_mul] at this
  rw [this]
  ring

/-- Each allocation names a holding that was given and its lot, no holding is named by two
allocations, no two allocations have the same identifier, the identifier is the first one supplied
for the holding, and the derivation is the one given. -/
theorem allocateLots_allocations {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection} {derivation : DerivationRecord}
    {identities : List LotAllocationIdentity} {allocations : List LotAllocation}
    {after : List LotHolding}
    (hw : ∀ holding ∈ holdings, holding.WF) (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : allocateLots holdings lots requestedQuantity selection derivation identities =
      .ok (.allocated allocations after)) :
    (allocations.map (·.holdingId)).Nodup ∧ (allocations.map (·.id)).Nodup ∧
    ∀ allocation ∈ allocations,
      (∃ holding ∈ holdings, allocation.holdingId = holding.id ∧
        allocation.lotId = holding.lotId) ∧
      allocation.derivation = derivation ∧
      ∃ identity, identities.find? (fun identity => identity.holdingId == allocation.holdingId) =
        some identity ∧ allocation.id = identity.allocationId := by
  obtain ⟨candidates, specificQuantities, available, final, takes, run⟩ :=
    Lots.allocateLots_run hw hr hs h
  rw [run.allocations_eq]
  refine ⟨?_, ?_, ?_⟩
  · have : takes.map (·.allocation.holdingId) = takes.map (·.holding.id) :=
      List.map_congr_left (fun t ht => (run.trace.took t ht).holdingId)
    rw [List.map_map]
    exact this ▸ run.taken_nodup
  · rw [List.map_map]
    exact run.trace.ids_nodup
  · intro allocation hmem
    obtain ⟨t, ht, rfl⟩ := List.mem_map.mp hmem
    have k := run.trace.took t ht
    refine ⟨⟨t.holding, run.taken_mem t ht, k.holdingId, k.lotId⟩, run.trace.derivation t ht, ?_⟩
    rw [k.holdingId]
    exact run.trace.identity t ht

namespace Lots

/-- A valid holding that is taken from is still valid: nothing goes negative, and it is empty of
basis, allowance and carrying amount exactly when it is empty of quantity. -/
theorem Took.after_valid {before left : LotHolding} {allocation : LotAllocation}
    (v : before.Valid) (k : Took before allocation left) : left.Valid := by
  have hpos := k.quantity_pos
  have hle := k.quantity_le
  have hq : 0 < before.remainingQuantity.toRat := lt_of_lt_of_le hpos hle
  have hqne : before.remainingQuantity.toRat ≠ 0 := ne_of_gt hq
  have hB : left.remainingTotalBasis.toRat =
      before.remainingTotalBasis.toRat *
        (before.remainingQuantity.toRat - allocation.allocatedQuantity.toRat) /
        before.remainingQuantity.toRat := by
    rw [k.after_basis, k.basis]
    field_simp
  have hVA : left.remainingValuationAllowance.toRat =
      before.remainingValuationAllowance.toRat *
        (before.remainingQuantity.toRat - allocation.allocatedQuantity.toRat) /
        before.remainingQuantity.toRat := by
    rw [k.after_valuationAllowance, k.valuationAllowance]
    field_simp
  have hBne : before.remainingTotalBasis.toRat ≠ 0 := fun h0 => hqne (v.depleted_iff.mpr h0)
  refine ⟨?_, ?_, k.after_carryingAmount, ?_, ?_, ?_⟩
  · rw [k.after_quantity]; linarith
  · rw [hB]
    exact div_nonneg (mul_nonneg v.basis_nonneg (by linarith)) (le_of_lt hq)
  · rw [hB, k.after_quantity]
    constructor
    · intro h0
      rw [h0]
      simp
    · intro h0
      rcases div_eq_zero_iff.mp h0 with h1 | h1
      · rcases mul_eq_zero.mp h1 with h2 | h2
        · exact absurd h2 hBne
        · exact h2
      · exact absurd h1 hqne
  · intro h0
    rw [k.after_quantity] at h0
    rw [hVA, h0]
    simp
  · intro h0
    rw [k.after_quantity] at h0
    rw [k.after_carryingAmount, hB, hVA, h0]
    simp

end Lots

/-- Every holding returned is again a valid holding of constructible numbers: none is left with a
negative quantity or basis. -/
theorem allocateLots_after_valid {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection} {derivation : DerivationRecord}
    {identities : List LotAllocationIdentity} {allocations : List LotAllocation}
    {after : List LotHolding}
    (hw : ∀ holding ∈ holdings, holding.WF) (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : allocateLots holdings lots requestedQuantity selection derivation identities =
      .ok (.allocated allocations after)) :
    (after.map (·.id)) = holdings.map (·.id) ∧ ∀ left ∈ after, left.WF ∧ left.Valid := by
  obtain ⟨candidates, specificQuantities, available, final, takes, run⟩ :=
    Lots.allocateLots_run hw hr hs h
  have hpoint : ∀ holding ∈ holdings,
      (Lots.afterOf takes holding).id = holding.id ∧ (Lots.afterOf takes holding).WF ∧
        (Lots.afterOf takes holding).Valid := by
    intro holding hh
    by_cases htaken : ∃ t ∈ takes, t.holding.id = holding.id
    · obtain ⟨t, ht, hid⟩ := htaken
      have heq := run.taken_eq ht hh hid
      have k := run.trace.took t ht
      rw [← heq, run.afterOf_taken t ht]
      exact ⟨k.after_id, k.after_wf, k.after_valid (run.holdings_valid _ (run.taken_mem t ht))⟩
    · rw [Lots.Run.afterOf_untouched takes holding (fun t ht hid => htaken ⟨t, ht, hid⟩)]
      exact ⟨rfl, hw holding hh, run.holdings_valid holding hh⟩
  rw [run.after_eq]
  constructor
  · rw [List.map_map]
    exact List.map_congr_left (fun holding hh => (hpoint holding hh).1)
  · intro left hleft
    obtain ⟨holding, hh, rfl⟩ := List.mem_map.mp hleft
    exact (hpoint holding hh).2

/-! ## The order each method visits the holdings in -/

namespace Lots

/-- `left` sorts before `right` as JavaScript compares strings: by UTF-16 code unit. -/
def TextLt (left right : String) : Prop := compareCanonicalText left right = .lt

/-- The order by a first key, and by a second key where the first keys are the same. -/
def LexLt {κ₁ κ₂ : Type} (lt₁ : κ₁ → κ₁ → Prop) (lt₂ : κ₂ → κ₂ → Prop) (a b : κ₁ × κ₂) : Prop :=
  lt₁ a.1 b.1 ∨ (a.1 = b.1 ∧ lt₂ a.2 b.2)

theorem textLt_strictTotal : StrictTotal TextLt where
  irrefl a h := by
    unfold TextLt at h
    rw [(compareCanonicalText_eq_iff a a).mpr rfl] at h
    cases h
  trans h1 h2 := compareCanonicalText_trans _ _ _ h1 h2
  total a b := by
    unfold TextLt
    cases h : compareCanonicalText a b with
    | lt => exact Or.inl rfl
    | eq => exact Or.inr (Or.inl ((compareCanonicalText_eq_iff a b).mp h))
    | gt => exact Or.inr (Or.inr ((compareCanonicalText_antisymm b a).mpr h))

theorem ratGt_strictTotal : StrictTotal (fun a b : ℚ => b < a) where
  irrefl a := lt_irrefl a
  trans h1 h2 := lt_trans h2 h1
  total a b := by
    rcases lt_trichotomy a b with h | h | h
    · exact Or.inr (Or.inr h)
    · exact Or.inr (Or.inl h)
    · exact Or.inl h

theorem StrictTotal.flip {κ : Type} {lt : κ → κ → Prop} (h : StrictTotal lt) :
    StrictTotal (fun a b => lt b a) where
  irrefl a := h.irrefl a
  trans h1 h2 := h.trans h2 h1
  total a b := by
    rcases h.total a b with t | t | t
    · exact Or.inr (Or.inr t)
    · exact Or.inr (Or.inl t)
    · exact Or.inl t

theorem StrictTotal.lex {κ₁ κ₂ : Type} {lt₁ : κ₁ → κ₁ → Prop} {lt₂ : κ₂ → κ₂ → Prop}
    (h₁ : StrictTotal lt₁) (h₂ : StrictTotal lt₂) : StrictTotal (LexLt lt₁ lt₂) where
  irrefl a h := by
    rcases h with h | ⟨-, h⟩
    · exact h₁.irrefl _ h
    · exact h₂.irrefl _ h
  trans := by
    rintro a b c (hab | ⟨hab, hab'⟩) (hbc | ⟨hbc, hbc'⟩)
    · exact Or.inl (h₁.trans hab hbc)
    · exact Or.inl (hbc ▸ hab)
    · exact Or.inl (hab ▸ hbc)
    · exact Or.inr ⟨hab.trans hbc, h₂.trans hab' hbc'⟩
  total a b := by
    rcases h₁.total a.1 b.1 with t | t | t
    · exact Or.inl (Or.inl t)
    · rcases h₂.total a.2 b.2 with u | u | u
      · exact Or.inl (Or.inr ⟨t, u⟩)
      · exact Or.inr (Or.inl (Prod.ext t u))
      · exact Or.inr (Or.inr (Or.inr ⟨t.symm, u⟩))
    · exact Or.inr (Or.inr (Or.inl t))

/-- The text of the acquisition instant of the lot of a holding (empty when no lot resolves). -/
def acquiredText (lots : List Lot) (holding : LotHolding) : String :=
  ((lotById lots holding.lotId).map (·.acquiredAt.value)).getD ""

/-- What first in and last in sort by: the text of the acquisition instant, then the lot
identifier. -/
def acquisitionKey (lots : List Lot) (holding : LotHolding) : String × String :=
  (acquiredText lots holding, holding.lotId.value)

/-- The cost of one unit of a holding: its basis over its quantity. -/
def unitCost (holding : LotHolding) : ℚ :=
  holding.remainingTotalBasis.toRat / holding.remainingQuantity.toRat

/-- What highest cost sorts by: the unit cost, then the lot identifier. -/
def costKey (holding : LotHolding) : ℚ × String := (unitCost holding, holding.lotId.value)

theorem ordered_gt_iff (c t : Ordering) :
    (if c = .eq then t else c) = .gt ↔ c = .gt ∨ (c = .eq ∧ t = .gt) := by
  cases c <;> simp

theorem ordered_swap_gt_iff (c t : Ordering) :
    (if c = .eq then t else c).swap = .gt ↔ c = .lt ∨ (c = .eq ∧ t = .lt) := by
  cases c <;> cases t <;> simp

theorem textLt_iff_gt (a b : String) : TextLt a b ↔ compareText b a = .gt :=
  compareCanonicalText_antisymm a b

theorem textLt_iff_lt (a b : String) : TextLt a b ↔ compareText a b = .lt := Iff.rfl

theorem compareText_eq_iff (a b : String) : compareText a b = .eq ↔ a = b :=
  compareCanonicalText_eq_iff a b

/-- First in: the comparator puts `x` after `y` exactly when `y` has the earlier acquisition text,
or the same text and the lower lot identifier. -/
theorem compareCandidates_fifo {lots : List Lot} {x y : LotHolding} {o : Ordering}
    {xLot yLot : Lot} (hx : lotById lots x.lotId = some xLot)
    (hy : lotById lots y.lotId = some yLot)
    (h : compareCandidates .fifo lots x y = .ok o) :
    o = .gt ↔ LexLt TextLt TextLt (acquisitionKey lots y) (acquisitionKey lots x) := by
  simp only [compareCandidates, hx, hy, reduceCtorEq, ↓reduceIte, Except.ok.injEq] at h
  subst h
  simp only [LexLt, acquisitionKey, acquiredText, hx, hy, Option.map_some, Option.getD_some,
    textLt_iff_gt]
  rw [ordered_gt_iff, eq_comm (a := yLot.acquiredAt.value), ← compareText_eq_iff]

/-- Last in: the comparator puts `x` after `y` exactly when `y` has the later acquisition text, or
the same text and the higher lot identifier. -/
theorem compareCandidates_lifo {lots : List Lot} {x y : LotHolding} {o : Ordering}
    {xLot yLot : Lot} (hx : lotById lots x.lotId = some xLot)
    (hy : lotById lots y.lotId = some yLot)
    (h : compareCandidates .lifo lots x y = .ok o) :
    o = .gt ↔ LexLt TextLt TextLt (acquisitionKey lots x) (acquisitionKey lots y) := by
  simp only [compareCandidates, hx, hy, ↓reduceIte, Except.ok.injEq] at h
  subst h
  simp only [LexLt, acquisitionKey, acquiredText, hx, hy, Option.map_some, Option.getD_some,
    textLt_iff_lt]
  rw [ordered_swap_gt_iff, ← compareText_eq_iff]

/-- Weighted average: the comparator puts `x` after `y` exactly when `y` has the lower holding
identifier. -/
theorem compareCandidates_weightedAverage {lots : List Lot} {x y : LotHolding} {o : Ordering}
    {xLot yLot : Lot} (hx : lotById lots x.lotId = some xLot)
    (hy : lotById lots y.lotId = some yLot)
    (h : compareCandidates .weightedAverage lots x y = .ok o) :
    o = .gt ↔ TextLt y.id.value x.id.value := by
  simp only [compareCandidates, hx, hy, Except.ok.injEq] at h
  subst h
  rw [textLt_iff_gt]

/-- Highest cost: the comparator puts `x` after `y` exactly when `y` has the higher unit cost, or
the same unit cost and the lower lot identifier. -/
theorem compareCandidates_hifo {lots : List Lot} {x y : LotHolding} {o : Ordering}
    {xLot yLot : Lot} (hx : lotById lots x.lotId = some xLot)
    (hy : lotById lots y.lotId = some yLot) (hxw : x.WF) (hyw : y.WF)
    (h : compareCandidates .hifo lots x y = .ok o) :
    o = .gt ↔ LexLt (fun a b : ℚ => b < a) TextLt (costKey y) (costKey x) := by
  simp only [compareCandidates, hx, hy] at h
  cases hl : x.remainingTotalBasis.divide x.remainingQuantity with
  | error e => simp [hl] at h
  | ok leftUnit =>
  simp only [hl] at h
  cases hr : y.remainingTotalBasis.divide y.remainingQuantity with
  | error e => simp [hr] at h
  | ok rightUnit =>
  simp only [hr, Except.ok.injEq] at h
  subst h
  obtain ⟨hlw, -, hlr⟩ := ExactRational.divide_ok hxw.remainingTotalBasis hxw.remainingQuantity hl
  obtain ⟨hrw, -, hrr⟩ := ExactRational.divide_ok hyw.remainingTotalBasis hyw.remainingQuantity hr
  simp only [LexLt, costKey, unitCost, textLt_iff_gt]
  rw [ordered_gt_iff, ExactRational.compare_gt_iff hrw hlw, ExactRational.compare_eq_iff hrw hlw,
    hlr, hrr]

/-- Two different members of a list stand in it in one order or the other. -/
theorem pair_sublist_or {α : Type} {l : List α} {x y : α} (hx : x ∈ l) (hy : y ∈ l)
    (hne : x ≠ y) : [x, y].Sublist l ∨ [y, x].Sublist l := by
  induction l with
  | nil => cases hx
  | cons a rest ih =>
    rcases List.mem_cons.mp hx with hxa | hxr
    · rcases List.mem_cons.mp hy with hya | hyr
      · exact absurd (hxa.trans hya.symm) hne
      · rw [hxa]
        exact Or.inl (List.Sublist.cons_cons a (List.singleton_sublist.mpr hyr))
    · rcases List.mem_cons.mp hy with hya | hyr
      · rw [hya]
        exact Or.inr (List.Sublist.cons_cons a (List.singleton_sublist.mpr hxr))
      · rcases ih hxr hyr with h | h
        · exact Or.inl (h.cons a)
        · exact Or.inr (h.cons a)

/-- In a list without repeats two members do not stand in both orders. -/
theorem not_both_sublist {α : Type} : ∀ {l : List α} {x y : α}, l.Nodup →
    [x, y].Sublist l → [y, x].Sublist l → False := by
  intro l
  induction l with
  | nil => intro x y _ h _; cases h
  | cons a rest ih =>
    intro x y hn h1 h2
    rw [List.nodup_cons] at hn
    rcases List.sublist_cons_iff.mp h1 with h1' | ⟨r1, hr1, h1'⟩
    · rcases List.sublist_cons_iff.mp h2 with h2' | ⟨r2, hr2, h2'⟩
      · exact ih hn.2 h1' h2'
      · have : a = y := by simpa using (List.cons.inj hr2).1.symm
        exact hn.1 (h1'.subset (by simp [this]))
    · have hxa : a = x := by simpa using (List.cons.inj hr1).1.symm
      rcases List.sublist_cons_iff.mp h2 with h2' | ⟨r2, hr2, h2'⟩
      · exact hn.1 (h2'.subset (by simp [hxa]))
      · have hya : a = y := by simpa using (List.cons.inj hr2).1.symm
        have : r1 = [y] := by simpa using (List.cons.inj hr1).2.symm
        rw [this] at h1'
        exact hn.1 (h1'.subset (by simp [hya]))

/-- A pair in order in a list without repeats, whose second member is in a first part of the list,
is in order in that first part. -/
theorem pair_sublist_prefix {α : Type} {front back : List α} {x y : α}
    (hn : (front ++ back).Nodup) (hy : y ∈ front) (h : [x, y].Sublist (front ++ back)) :
    [x, y].Sublist front := by
  obtain ⟨l1, l2, heq, h1, h2⟩ := List.sublist_append_iff.mp h
  have hyb : y ∉ back := fun hb => (List.nodup_append.mp hn).2.2 y hy y hb rfl
  rcases l1 with _ | ⟨a, _ | ⟨b, _ | ⟨c, r⟩⟩⟩
  · simp only [List.nil_append] at heq
    exact absurd (h2.subset (by simp [← heq])) hyb
  · simp only [List.cons_append, List.nil_append, List.cons.injEq] at heq
    exact absurd (h2.subset (by simp [← heq.2])) hyb
  · simp only [List.cons_append, List.nil_append, List.cons.injEq] at heq
    obtain ⟨rfl, rfl, -⟩ := heq
    exact h1
  · simp at heq

/-- The methods that take whole holdings in order: when the candidates are sorted by a key and a
holding is taken from, every holding the order puts before it has been taken whole. -/
theorem Run.greedy_order {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection} {derivation : DerivationRecord}
    {identities : List LotAllocationIdentity} {allocations : List LotAllocation}
    {after : List LotHolding} {candidates : List LotHolding}
    {specificQuantities : Option (List (LotHoldingId × ExactRational))}
    {available : Option ExactRational} {final : LoopState} {takes : List Taking}
    (run : Run holdings lots requestedQuantity selection derivation identities allocations after
      candidates specificQuantities available final takes)
    (hsq : specificQuantities = none) (hm : selection.method ≠ .weightedAverage)
    {κ : Type} {lt : κ → κ → Prop} (hlt : StrictTotal lt) (key : LotHolding → κ)
    (hsorted : candidates.Pairwise
      (Before lt key (holdings.filter fun holding => !holding.remainingQuantity.isZero)))
    (hcands : ∀ c, c ∈ candidates ↔ c ∈ holdings ∧ c.remainingQuantity.isZero = false)
    {x y : LotHolding} (hx : x ∈ holdings) (hxq : x.remainingQuantity.isZero = false)
    (hy : y ∈ holdings) (hbefore : Before lt key holdings x y)
    (htaken : ∃ allocation ∈ allocations, allocation.holdingId = y.id) :
    ∃ allocation ∈ allocations, allocation.holdingId = x.id ∧
      allocation.allocatedQuantity = x.remainingQuantity := by
  have hnodup : holdings.Nodup := List.Nodup.of_map _ run.holdings_nodup
  have hcn : candidates.Nodup := List.Nodup.of_map _ run.candidates_nodup
  obtain ⟨allocation, hmem, hid⟩ := htaken
  rw [run.allocations_eq] at hmem
  obtain ⟨t, ht, rfl⟩ := List.mem_map.mp hmem
  have hty : t.holding = y :=
    run.taken_eq ht hy ((run.trace.took t ht).holdingId.symm.trans hid)
  have hyP : y ∈ takes.map (·.holding) := hty ▸ List.mem_map_of_mem (f := (·.holding)) ht
  obtain ⟨back, hback⟩ := run.trace.taken_prefix (fun c hc => ((hcands c).mp hc).2)
  have hxc : x ∈ candidates := (hcands x).mpr ⟨hx, hxq⟩
  have hyc : y ∈ candidates := run.trace.sublist.subset hyP
  have hne : x ≠ y := by
    rintro rfl
    rcases hbefore with hb | ⟨-, hb⟩
    · exact hlt.irrefl _ hb
    · exact not_both_sublist hnodup hb hb
  have horder : [x, y].Sublist candidates := by
    rcases pair_sublist_or hxc hyc hne with h | h
    · exact h
    · exfalso
      rcases List.pairwise_iff_forall_sublist.mp hsorted h with hb | ⟨hk, hb⟩
      · rcases hbefore with hb' | ⟨hk', -⟩
        · exact hlt.irrefl _ (hlt.trans hb hb')
        · exact hlt.irrefl _ (hk' ▸ hb)
      · rcases hbefore with hb' | ⟨-, hb'⟩
        · exact hlt.irrefl _ (hk ▸ hb')
        · exact not_both_sublist hnodup hb' (hb.trans List.filter_sublist)
  have hfront : [x, y].Sublist (takes.map (·.holding)) :=
    pair_sublist_prefix (hback ▸ hcn) hyP (hback ▸ horder)
  obtain ⟨sub, hsub, hmap⟩ := List.sublist_map_iff.mp hfront
  rcases sub with _ | ⟨tx, _ | ⟨ty, _ | ⟨tz, r⟩⟩⟩
  · simp at hmap
  · simp at hmap
  · simp only [List.map_cons, List.map_nil, List.cons.injEq, and_true] at hmap
    have hfull := List.pairwise_iff_forall_sublist.mp
      (run.trace.greedy (by simp [loopInputs, hsq]) (by simpa [loopInputs] using hm)) hsub
    have htx : tx ∈ takes := hsub.subset (by simp)
    refine ⟨tx.allocation, by rw [run.allocations_eq]; exact List.mem_map_of_mem htx, ?_, ?_⟩
    · rw [(run.trace.took tx htx).holdingId, ← hmap.1]
    · rw [hfull, ← hmap.1]
  · simp at hmap

end Lots

/-! ## Laws of `transferLots`: one turn of the loop over the allocations -/

/-- What makes a holding the holding it is, as opposed to what it holds: its identifier, book, lot,
account, commodity and basis commodity. -/
def LotHolding.identity (holding : LotHolding) :
    LotHoldingId × BookId × LotId × AccountId × CommodityId × CommodityId :=
  (holding.id, holding.bookId, holding.lotId, holding.accountId, holding.commodityId,
    holding.basisCommodityId)

namespace Lots

/-- The first holding that a test picks is replaced in place. -/
theorem set_findIdx {α : Type} (p : α → Bool) (x : α) :
    ∀ (D : List α) (e : α), D.find? p = some e →
      ∃ pre post, D = pre ++ e :: post ∧ (∀ y ∈ pre, p y = false) ∧ p e = true ∧
        D.set (D.findIdx p) x = pre ++ x :: post := by
  intro D
  induction D with
  | nil => intro e h; simp at h
  | cons a rest ih =>
    intro e h
    by_cases ha : p a = true
    · rw [List.find?_cons_of_pos ha] at h
      simp only [Option.some.injEq] at h
      subst h
      refine ⟨[], rest, rfl, by simp, ha, ?_⟩
      simp [List.findIdx_cons, ha]
    · have ha' : p a = false := by simpa using ha
      rw [List.find?_cons_of_neg (by simpa using ha')] at h
      obtain ⟨pre, post, hD, hpre, hpe, hset⟩ := ih e h
      refine ⟨a :: pre, post, by simp [hD], ?_, hpe, ?_⟩
      · intro y hy
        rcases List.mem_cons.mp hy with rfl | hy
        · exact ha'
        · exact hpre y hy
      · simp [List.findIdx_cons, ha', hset]

/-- Adding an allocation to a holding that is already there changes only what it holds, by exactly
the amounts of the allocation. -/
theorem addArrival_ok {existing : LotHolding} {applied : LotAllocation} {replaced : LotHolding}
    (he : existing.WF) (ha : applied.WF) (h : addArrival existing applied = .ok replaced) :
    replaced.WF ∧ replaced.identity = existing.identity ∧
    replaced.remainingQuantity.toRat =
      existing.remainingQuantity.toRat + applied.allocatedQuantity.toRat ∧
    replaced.remainingTotalBasis.toRat =
      existing.remainingTotalBasis.toRat + applied.allocatedTotalBasis.toRat ∧
    replaced.remainingValuationAllowance.toRat =
      existing.remainingValuationAllowance.toRat + applied.allocatedValuationAllowance.toRat ∧
    replaced.remainingCarryingAmount.toRat =
      existing.remainingCarryingAmount.toRat + applied.allocatedCarryingAmount.toRat := by
  unfold addArrival at h
  cases h1 : existing.remainingQuantity.add applied.allocatedQuantity with
  | error e => simp [h1] at h
  | ok q =>
  simp only [h1] at h
  cases h2 : existing.remainingTotalBasis.add applied.allocatedTotalBasis with
  | error e => simp [h2] at h
  | ok b =>
  simp only [h2] at h
  cases h3 : existing.remainingValuationAllowance.add applied.allocatedValuationAllowance with
  | error e => simp [h3] at h
  | ok v =>
  simp only [h3] at h
  cases h4 : existing.remainingCarryingAmount.add applied.allocatedCarryingAmount with
  | error e => simp [h4] at h
  | ok c =>
  simp only [h4, Except.ok.injEq] at h
  subst h
  obtain ⟨w1, r1⟩ := ExactRational.add_ok he.remainingQuantity ha.allocatedQuantity h1
  obtain ⟨w2, r2⟩ := ExactRational.add_ok he.remainingTotalBasis ha.allocatedTotalBasis h2
  obtain ⟨w3, r3⟩ :=
    ExactRational.add_ok he.remainingValuationAllowance ha.allocatedValuationAllowance h3
  obtain ⟨w4, r4⟩ := ExactRational.add_ok he.remainingCarryingAmount ha.allocatedCarryingAmount h4
  exact ⟨⟨w1, w2, w3, w4⟩, rfl, r1, r2, r3, r4⟩

/-- The holding founded for an allocation is the allocation's holding in the destination account,
holding exactly what the allocation carries. -/
theorem newArrival_spec (newHoldingId : LotHoldingId) (sourceHolding : LotHolding)
    (destinationAccountId : AccountId) (applied : LotAllocation) (ha : applied.WF) :
    (newArrival newHoldingId sourceHolding destinationAccountId applied).WF ∧
    (newArrival newHoldingId sourceHolding destinationAccountId applied).identity =
      (newHoldingId, sourceHolding.bookId, sourceHolding.lotId, destinationAccountId,
        sourceHolding.commodityId, sourceHolding.basisCommodityId) := by
  exact ⟨⟨ha.allocatedQuantity, ha.allocatedTotalBasis, ha.allocatedValuationAllowance,
    ha.allocatedCarryingAmount⟩, rfl⟩

/-- A turn of the loop over the allocations that does not reject either adds the allocation to the
first holding of its lot at the destination, or founds a holding there under a new identifier that
was supplied and is not in use. -/
theorem arriveStep_finished {S : List LotHolding} {da : AccountId}
    {di : List DestinationHoldingIdentity} {D : List LotHolding} {a : LotAllocation}
    {D' : List LotHolding} (h : arriveStep S da di D a = .ok (.finished D')) :
    ∃ s, S.find? (fun holding => holding.id == a.holdingId) = some s ∧
      ((∃ pre existing post replaced, D = pre ++ existing :: post ∧
          (∀ x ∈ pre, ¬ (x.lotId = s.lotId ∧ x.accountId = da)) ∧
          existing.lotId = s.lotId ∧ existing.accountId = da ∧
          addArrival existing a = .ok replaced ∧ D' = pre ++ replaced :: post) ∨
       (∃ identity, (∀ x ∈ D, ¬ (x.lotId = s.lotId ∧ x.accountId = da)) ∧
          di.find? (fun identity => identity.sourceHoldingId == s.id) = some identity ∧
          (∀ x ∈ D, x.id ≠ identity.destinationHoldingId) ∧
          (∀ x ∈ S, x.id ≠ identity.destinationHoldingId) ∧
          D' = D ++ [newArrival identity.destinationHoldingId s da a])) := by
  unfold arriveStep at h
  cases hs : S.find? (fun holding => holding.id == a.holdingId) with
  | none => simp [hs] at h
  | some s =>
  simp only [hs] at h
  refine ⟨s, rfl, ?_⟩
  cases he : D.find? (fun holding => holding.lotId == s.lotId && holding.accountId == da) with
  | some existing =>
    simp only [he] at h
    cases hr : addArrival existing a with
    | error e => simp [hr] at h
    | ok replaced =>
      simp only [hr, Except.ok.injEq, ArrivalResult.finished.injEq] at h
      obtain ⟨pre, post, hD, hpre, hpe, hset⟩ := set_findIdx _ replaced D existing he
      left
      have hpe' : existing.lotId = s.lotId ∧ existing.accountId = da := by simpa using hpe
      refine ⟨pre, existing, post, replaced, hD, ?_, hpe'.1, hpe'.2, hr, ?_⟩
      · intro y hy hc
        have := hpre y hy
        simp [hc.1, hc.2] at this
      · rw [← h, hset]
  | none =>
    simp only [he] at h
    cases hf : di.find? (fun identity => identity.sourceHoldingId == s.id) with
    | none => simp [hf] at h
    | some identity =>
      simp only [hf] at h
      by_cases hc : (D.any (fun holding => holding.id == identity.destinationHoldingId) ||
          S.any (fun holding => holding.id == identity.destinationHoldingId)) = true
      · simp [hc] at h
      · simp only [hc, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq,
          ArrivalResult.finished.injEq] at h
        right
        refine ⟨identity, ?_, rfl, ?_, ?_, h.symm⟩
        · intro y hy hc'
          have := List.find?_eq_none.mp he y hy
          simp [hc'.1, hc'.2] at this
        · intro y hy heq
          apply hc
          simp only [Bool.or_eq_true, List.any_eq_true]
          exact Or.inl ⟨y, hy, by simp [heq]⟩
        · intro y hy heq
          apply hc
          simp only [Bool.or_eq_true, List.any_eq_true]
          exact Or.inr ⟨y, hy, by simp [heq]⟩

/-- The diagnostic for a new destination holding that has no identity supplied. -/
def missingIdentityDiagnostic : SemanticDiagnostic :=
  diagnostic .canonical_identity_conflict "destinationIdentities"
    "Every new destination holding requires one explicitly supplied stable identity"
    ["ACC-006", "ACC-008", "ACC-038"]

/-- The diagnostic for a new destination holding whose identifier is already in use. -/
def assignedIdentityDiagnostic (identifier : LotHoldingId) : SemanticDiagnostic :=
  diagnostic .canonical_identity_conflict "destinationHoldings"
    s!"Destination holding identifier {identifier.value} is already assigned"
    ["ACC-008", "ACC-038"]

/-- A turn of the loop over the allocations rejects exactly when the allocation's lot is not yet
held at the destination and either no identity was supplied for its source holding, or the one
supplied is already the identifier of a holding at the destination or of a source holding. -/
theorem arriveStep_rejected_iff {S : List LotHolding} {da : AccountId}
    {di : List DestinationHoldingIdentity} {D : List LotHolding} {a : LotAllocation}
    {ds : List SemanticDiagnostic} :
    arriveStep S da di D a = .ok (.rejected ds) ↔
      ∃ s, S.find? (fun holding => holding.id == a.holdingId) = some s ∧
        (∀ x ∈ D, ¬ (x.lotId = s.lotId ∧ x.accountId = da)) ∧
        ((di.find? (fun identity => identity.sourceHoldingId == s.id) = none ∧
            ds = [missingIdentityDiagnostic]) ∨
          (∃ identity, di.find? (fun identity => identity.sourceHoldingId == s.id) = some identity ∧
            ((∃ x ∈ D, x.id = identity.destinationHoldingId) ∨
              ∃ x ∈ S, x.id = identity.destinationHoldingId) ∧
            ds = [assignedIdentityDiagnostic identity.destinationHoldingId])) := by
  constructor
  · intro h
    unfold arriveStep at h
    cases hs : S.find? (fun holding => holding.id == a.holdingId) with
    | none => simp [hs] at h
    | some s =>
    simp only [hs] at h
    refine ⟨s, rfl, ?_⟩
    cases he : D.find? (fun holding => holding.lotId == s.lotId && holding.accountId == da) with
    | some existing =>
      simp only [he] at h
      cases hr : addArrival existing a <;> simp [hr] at h
    | none =>
      simp only [he] at h
      refine ⟨fun y hy hc => ?_, ?_⟩
      · have := List.find?_eq_none.mp he y hy
        simp [hc.1, hc.2] at this
      cases hf : di.find? (fun identity => identity.sourceHoldingId == s.id) with
      | none =>
        simp only [hf, Except.ok.injEq, ArrivalResult.rejected.injEq] at h
        exact Or.inl ⟨rfl, h.symm⟩
      | some identity =>
        simp only [hf] at h
        by_cases hc : (D.any (fun holding => holding.id == identity.destinationHoldingId) ||
            S.any (fun holding => holding.id == identity.destinationHoldingId)) = true
        · simp only [hc, ↓reduceIte, Except.ok.injEq, ArrivalResult.rejected.injEq] at h
          refine Or.inr ⟨identity, rfl, ?_, h.symm⟩
          simp only [Bool.or_eq_true, List.any_eq_true, beq_iff_eq] at hc
          rcases hc with ⟨x, hx, hxe⟩ | ⟨x, hx, hxe⟩
          · exact Or.inl ⟨x, hx, hxe⟩
          · exact Or.inr ⟨x, hx, hxe⟩
        · simp [hc] at h
  · rintro ⟨s, hs, hnone, hcase⟩
    unfold arriveStep
    rw [hs]
    have he : D.find? (fun holding => holding.lotId == s.lotId && holding.accountId == da) = none := by
      rw [List.find?_eq_none]
      intro y hy
      have := hnone y hy
      simpa using this
    simp only [he]
    rcases hcase with ⟨hf, hds⟩ | ⟨identity, hf, hused, hds⟩
    · simp [hf, hds, missingIdentityDiagnostic]
    · simp only [hf]
      have hc : (D.any (fun holding => holding.id == identity.destinationHoldingId) ||
          S.any (fun holding => holding.id == identity.destinationHoldingId)) = true := by
        simp only [Bool.or_eq_true, List.any_eq_true, beq_iff_eq]
        rcases hused with ⟨x, hx, hxe⟩ | ⟨x, hx, hxe⟩
        · exact Or.inl ⟨x, hx, hxe⟩
        · exact Or.inr ⟨x, hx, hxe⟩
      simp [hc, hds, assignedIdentityDiagnostic]

/-- A turn of the loop over the allocations throws exactly when the allocation's source holding is
missing (which the TypeScript meets as a `TypeError`), or when adding it to the holding it joins
exceeds the size limit of the exact numbers. -/
theorem arriveStep_error_iff {S : List LotHolding} {da : AccountId}
    {di : List DestinationHoldingIdentity} {D : List LotHolding} {a : LotAllocation}
    {e : LotsErr} :
    arriveStep S da di D a = .error e ↔
      (S.find? (fun holding => holding.id == a.holdingId) = none ∧ e = .sourceHoldingAbsent) ∨
      (∃ s existing code, S.find? (fun holding => holding.id == a.holdingId) = some s ∧
        D.find? (fun holding => holding.lotId == s.lotId && holding.accountId == da) =
          some existing ∧ addArrival existing a = .error code ∧ e = .exactNumber code) := by
  constructor
  · intro h
    unfold arriveStep at h
    cases hs : S.find? (fun holding => holding.id == a.holdingId) with
    | none =>
      simp only [hs, Except.error.injEq] at h
      exact Or.inl ⟨rfl, h.symm⟩
    | some s =>
    simp only [hs] at h
    right
    cases he : D.find? (fun holding => holding.lotId == s.lotId && holding.accountId == da) with
    | some existing =>
      simp only [he] at h
      cases hr : addArrival existing a with
      | error code =>
        simp only [hr, Except.error.injEq] at h
        exact ⟨s, existing, code, rfl, he, hr, h.symm⟩
      | ok replaced => simp [hr] at h
    | none =>
      simp only [he] at h
      cases hf : di.find? (fun identity => identity.sourceHoldingId == s.id) with
      | none => simp [hf] at h
      | some identity =>
        simp only [hf] at h
        by_cases hc : (D.any (fun holding => holding.id == identity.destinationHoldingId) ||
            S.any (fun holding => holding.id == identity.destinationHoldingId)) = true <;>
          simp [hc] at h
  · rintro (⟨hs, he⟩ | ⟨s, existing, code, hs, hex, hr, he⟩)
    · unfold arriveStep
      simp [hs, he]
    · unfold arriveStep
      simp [hs, hex, hr, he]

end Lots

/-! ## Laws of `transferLots`: the loop over the allocations -/

namespace Lots

/-- Adding an allocation to a holding leaves it the same holding. -/
theorem addArrival_identity {existing : LotHolding} {applied : LotAllocation}
    {replaced : LotHolding} (h : addArrival existing applied = .ok replaced) :
    replaced.identity = existing.identity := by
  unfold addArrival at h
  cases h1 : existing.remainingQuantity.add applied.allocatedQuantity with
  | error e => simp [h1] at h
  | ok q =>
  simp only [h1] at h
  cases h2 : existing.remainingTotalBasis.add applied.allocatedTotalBasis with
  | error e => simp [h2] at h
  | ok b =>
  simp only [h2] at h
  cases h3 : existing.remainingValuationAllowance.add applied.allocatedValuationAllowance with
  | error e => simp [h3] at h
  | ok v =>
  simp only [h3] at h
  cases h4 : existing.remainingCarryingAmount.add applied.allocatedCarryingAmount with
  | error e => simp [h4] at h
  | ok c =>
  simp only [h4, Except.ok.injEq] at h
  subst h
  rfl

/-- The same holding has the same lot, account and identifier. -/
theorem identity_eq {x y : LotHolding} (h : x.identity = y.identity) :
    x.id = y.id ∧ x.lotId = y.lotId ∧ x.accountId = y.accountId := by
  simp only [LotHolding.identity, Prod.mk.injEq] at h
  exact ⟨h.1, h.2.2.1, h.2.2.2.1⟩

/-- A property of the loop over the allocations that holds when no allocation is left, and is passed
back over a turn that does not reject, holds of every run of the loop that finishes. -/
theorem arriveLoop_finished_induction {S : List LotHolding} {da : AccountId}
    {di : List DestinationHoldingIdentity}
    (P : List LotHolding → List LotAllocation → List LotHolding → Prop)
    (hnil : ∀ D, P D [] D)
    (hcons : ∀ D a rest D1 D', arriveStep S da di D a = .ok (.finished D1) →
      P D1 rest D' → P D (a :: rest) D') :
    ∀ (allocs : List LotAllocation) (D D' : List LotHolding),
      arriveLoop S da di allocs D = .ok (.finished D') → P D allocs D' := by
  intro allocs
  induction allocs with
  | nil =>
    intro D D' h
    simp only [arriveLoop, Except.ok.injEq, ArrivalResult.finished.injEq] at h
    subst h
    exact hnil D
  | cons a rest ih =>
    intro D D' h
    rw [arriveLoop] at h
    cases hs : arriveStep S da di D a with
    | error e => simp [hs] at h
    | ok stepped =>
      cases stepped with
      | rejected ds => simp [hs] at h
      | finished D1 =>
        simp only [hs] at h
        exact hcons D a rest D1 D' hs (ih D1 D' h)

/-- The loop over the allocations stops, other than by finishing, exactly at a turn that stops: the
turns before it finish. -/
theorem arriveLoop_stop_iff {S : List LotHolding} {da : AccountId}
    {di : List DestinationHoldingIdentity} {r : Except LotsErr ArrivalResult}
    (hr : ∀ D', r ≠ .ok (.finished D')) :
    ∀ (allocs : List LotAllocation) (D : List LotHolding),
      arriveLoop S da di allocs D = r ↔
        ∃ done a rest D1, allocs = done ++ a :: rest ∧
          arriveLoop S da di done D = .ok (.finished D1) ∧ arriveStep S da di D1 a = r := by
  intro allocs
  induction allocs with
  | nil =>
    intro D
    constructor
    · intro h
      exact absurd h.symm (hr D)
    · rintro ⟨done, a, rest, D1, h, -⟩
      simp at h
  | cons a rest ih =>
    intro D
    constructor
    · intro h
      rw [arriveLoop] at h
      cases hs : arriveStep S da di D a with
      | error e =>
        simp only [hs] at h
        exact ⟨[], a, rest, D, rfl, rfl, by rw [hs, h]⟩
      | ok stepped =>
        cases stepped with
        | rejected ds =>
          simp only [hs] at h
          exact ⟨[], a, rest, D, rfl, rfl, by rw [hs, h]⟩
        | finished D1 =>
          simp only [hs] at h
          obtain ⟨done, b, rest', D2, hall, hfin, hstep⟩ := (ih D1).mp h
          refine ⟨a :: done, b, rest', D2, by rw [hall]; rfl, ?_, hstep⟩
          rw [arriveLoop, hs]
          exact hfin
    · rintro ⟨done, b, rest', D2, hall, hfin, hstep⟩
      cases done with
      | nil =>
        simp only [List.nil_append, List.cons.injEq] at hall
        obtain ⟨rfl, rfl⟩ := hall
        simp only [arriveLoop, Except.ok.injEq, ArrivalResult.finished.injEq] at hfin
        subst hfin
        rw [arriveLoop, hstep]
        cases r with
        | error e => rfl
        | ok r' =>
          cases r' with
          | rejected ds => rfl
          | finished D' => exact absurd rfl (hr D')
      | cons c done' =>
        simp only [List.cons_append, List.cons.injEq] at hall
        obtain ⟨rfl, hall⟩ := hall
        rw [arriveLoop] at hfin ⊢
        cases hs : arriveStep S da di D a with
        | error e => simp [hs] at hfin
        | ok stepped =>
          cases stepped with
          | rejected ds => simp [hs] at hfin
          | finished D1 =>
            simp only [hs] at hfin ⊢
            exact (ih D1).mpr ⟨done', b, rest', D2, hall, hfin, hstep⟩

/-- A run of the loop over the allocations that finishes keeps every holding at the destination as
it was, in the same place, and adds the holdings it founds at the end: each is founded for one
allocation whose lot no holding at the destination had, under the identifier supplied for the
allocation's source holding. -/
theorem arriveLoop_layout {S : List LotHolding} {da : AccountId}
    {di : List DestinationHoldingIdentity} :
    ∀ (allocs : List LotAllocation) (D D' : List LotHolding),
      arriveLoop S da di allocs D = .ok (.finished D') →
      ∃ news : List LotHolding,
        D'.map LotHolding.identity = D.map LotHolding.identity ++ news.map LotHolding.identity ∧
        ∀ n ∈ news, ∃ a ∈ allocs, ∃ s identity,
          S.find? (fun holding => holding.id == a.holdingId) = some s ∧
          di.find? (fun identity => identity.sourceHoldingId == s.id) = some identity ∧
          n = newArrival identity.destinationHoldingId s da a ∧
          ∀ x ∈ D, ¬ (x.lotId = s.lotId ∧ x.accountId = da) := by
  apply arriveLoop_finished_induction
    (fun D allocs D' => ∃ news : List LotHolding,
      D'.map LotHolding.identity = D.map LotHolding.identity ++ news.map LotHolding.identity ∧
        ∀ n ∈ news, ∃ a ∈ allocs, ∃ s identity,
          S.find? (fun holding => holding.id == a.holdingId) = some s ∧
          di.find? (fun identity => identity.sourceHoldingId == s.id) = some identity ∧
          n = newArrival identity.destinationHoldingId s da a ∧
          ∀ x ∈ D, ¬ (x.lotId = s.lotId ∧ x.accountId = da))
  · intro D
    exact ⟨[], by simp, by simp⟩
  · intro D a rest D1 D' hstep ⟨news2, hlay2, hnew2⟩
    obtain ⟨s, hs, hcase⟩ := arriveStep_finished hstep
    rcases hcase with ⟨pre, existing, post, replaced, hD, -, -, -, hadd, hD1⟩ |
      ⟨identity, hnone, hf, -, -, hD1⟩
    · refine ⟨news2, ?_, ?_⟩
      · rw [hlay2, hD1, hD, List.map_append, List.map_append, List.map_cons, List.map_cons,
          addArrival_identity hadd]
      · intro n hn
        obtain ⟨b, hb, s2, id2, hfs2, hfi2, hn2, hnone2⟩ := hnew2 n hn
        refine ⟨b, List.mem_cons_of_mem _ hb, s2, id2, hfs2, hfi2, hn2, ?_⟩
        intro x hx hc
        have hrep := identity_eq (addArrival_identity hadd)
        rw [hD] at hx
        simp only [List.mem_append, List.mem_cons] at hx
        rcases hx with hx | rfl | hx
        · exact hnone2 x (by rw [hD1]; simp [hx]) hc
        · exact hnone2 replaced (by rw [hD1]; simp) ⟨hrep.2.1.trans hc.1, hrep.2.2.trans hc.2⟩
        · exact hnone2 x (by rw [hD1]; simp [hx]) hc
    · refine ⟨newArrival identity.destinationHoldingId s da a :: news2, ?_, ?_⟩
      · rw [hlay2, hD1]
        simp
      · intro n hn
        rcases List.mem_cons.mp hn with rfl | hn
        · exact ⟨a, List.mem_cons_self, s, identity, hs, hf, rfl, hnone⟩
        · obtain ⟨b, hb, s2, id2, hfs2, hfi2, hn2, hnone2⟩ := hnew2 n hn
          refine ⟨b, List.mem_cons_of_mem _ hb, s2, id2, hfs2, hfi2, hn2, ?_⟩
          intro x hx hc
          exact hnone2 x (by rw [hD1]; exact List.mem_append_left _ hx) hc

/-- A turn of the loop over the allocations that does not reject leaves every holding at the
destination constructible. -/
theorem arriveStep_finished_wf {S : List LotHolding} {da : AccountId}
    {di : List DestinationHoldingIdentity} {D : List LotHolding} {a : LotAllocation}
    {D' : List LotHolding} (h : arriveStep S da di D a = .ok (.finished D'))
    (hD : ∀ x ∈ D, x.WF) (ha : a.WF) : ∀ x ∈ D', x.WF := by
  obtain ⟨s, hs, hcase⟩ := arriveStep_finished h
  rcases hcase with ⟨pre, existing, post, replaced, hDeq, -, -, -, hadd, hD1⟩ |
    ⟨identity, -, -, -, -, hD1⟩
  · rw [hD1]
    intro x hx
    rw [hDeq] at hD
    simp only [List.mem_append, List.mem_cons] at hx
    rcases hx with hx | rfl | hx
    · exact hD x (by simp [hx])
    · exact (addArrival_ok (hD existing (by simp)) ha hadd).1
    · exact hD x (by simp [hx])
  · rw [hD1]
    intro x hx
    rcases List.mem_append.mp hx with hx | hx
    · exact hD x hx
    · rw [List.mem_singleton] at hx
      subst hx
      exact (newArrival_spec _ _ _ _ ha).1

/-- A run of the loop over the allocations that finishes leaves every holding at the destination
constructible. -/
theorem arriveLoop_wf {S : List LotHolding} {da : AccountId}
    {di : List DestinationHoldingIdentity} :
    ∀ (allocs : List LotAllocation) (D D' : List LotHolding),
      arriveLoop S da di allocs D = .ok (.finished D') →
      (∀ x ∈ D, x.WF) → (∀ a ∈ allocs, a.WF) → ∀ x ∈ D', x.WF := by
  apply arriveLoop_finished_induction
    (fun D allocs D' => (∀ x ∈ D, x.WF) → (∀ a ∈ allocs, a.WF) → ∀ x ∈ D', x.WF)
  · intro D hD _
    exact hD
  · intro D a rest D1 D' hstep ih hD ha
    exact ih (arriveStep_finished_wf hstep hD (ha a List.mem_cons_self))
      (fun b hb => ha b (List.mem_cons_of_mem _ hb))

end Lots

/-! ## Laws of `transferLots`: what the loop over the allocations conserves and keeps -/

namespace Lots

/-- A turn of the loop over the allocations adds exactly what the allocation carries, weighted by
the lot of the allocation, to what the holdings at the destination hold, weighted by their lots. -/
theorem arriveStep_sum {S : List LotHolding} {da : AccountId}
    {di : List DestinationHoldingIdentity} {D : List LotHolding} {a : LotAllocation}
    {D' : List LotHolding} (w : LotId → ℚ) (f : LotHolding → ℚ) (g : LotAllocation → ℚ)
    (hmerge : ∀ existing applied replaced, existing.WF → applied.WF →
      addArrival existing applied = .ok replaced → f replaced = f existing + g applied)
    (hnew : ∀ identifier s account applied, f (newArrival identifier s account applied) = g applied)
    (h : arriveStep S da di D a = .ok (.finished D')) (hD : ∀ x ∈ D, x.WF) (ha : a.WF)
    (hsrc : ∀ s, S.find? (fun holding => holding.id == a.holdingId) = some s →
      s.lotId = a.lotId) :
    (D'.map fun x => w x.lotId * f x).sum =
      (D.map fun x => w x.lotId * f x).sum + w a.lotId * g a := by
  obtain ⟨s, hs, hcase⟩ := arriveStep_finished h
  have hsl := hsrc s hs
  rcases hcase with ⟨pre, existing, post, replaced, hDeq, -, hl, -, hadd, hD1⟩ |
    ⟨identity, -, -, -, -, hD1⟩
  · have hlot : replaced.lotId = existing.lotId :=
      (identity_eq (addArrival_identity hadd)).2.1
    have hf := hmerge existing a replaced
      (hD existing (by rw [hDeq]; simp)) ha hadd
    rw [hD1, hDeq]
    simp only [List.map_append, List.map_cons, List.sum_append, List.sum_cons]
    rw [hlot, hf, hl, hsl]
    ring
  · rw [hD1]
    simp only [List.map_append, List.sum_append, List.map_cons, List.map_nil, List.sum_cons,
      List.sum_nil]
    rw [hnew]
    have : (newArrival identity.destinationHoldingId s da a).lotId = a.lotId := hsl
    rw [this]
    ring

/-- A run of the loop over the allocations that finishes adds to the holdings at the destination,
lot by lot, exactly what the allocations carry: for any amount of a holding that an allocation
adds to. -/
theorem arriveLoop_sum {S : List LotHolding} {da : AccountId}
    {di : List DestinationHoldingIdentity} (w : LotId → ℚ) (f : LotHolding → ℚ)
    (g : LotAllocation → ℚ)
    (hmerge : ∀ existing applied replaced, existing.WF → applied.WF →
      addArrival existing applied = .ok replaced → f replaced = f existing + g applied)
    (hnew : ∀ identifier s account applied, f (newArrival identifier s account applied) = g applied) :
    ∀ (allocs : List LotAllocation) (D D' : List LotHolding),
      arriveLoop S da di allocs D = .ok (.finished D') →
      (∀ x ∈ D, x.WF) → (∀ a ∈ allocs, a.WF) →
      (∀ a ∈ allocs, ∀ s, S.find? (fun holding => holding.id == a.holdingId) = some s →
        s.lotId = a.lotId) →
      (D'.map fun x => w x.lotId * f x).sum =
        (D.map fun x => w x.lotId * f x).sum + (allocs.map fun a => w a.lotId * g a).sum := by
  apply arriveLoop_finished_induction
    (fun D allocs D' => (∀ x ∈ D, x.WF) → (∀ a ∈ allocs, a.WF) →
      (∀ a ∈ allocs, ∀ s, S.find? (fun holding => holding.id == a.holdingId) = some s →
        s.lotId = a.lotId) →
      (D'.map fun x => w x.lotId * f x).sum =
        (D.map fun x => w x.lotId * f x).sum + (allocs.map fun a => w a.lotId * g a).sum)
  · intro D _ _ _
    simp
  · intro D a rest D1 D' hstep ih hD ha hsrc
    have h1 := arriveStep_sum w f g hmerge hnew hstep hD (ha a List.mem_cons_self)
      (hsrc a List.mem_cons_self)
    have h2 := ih (arriveStep_finished_wf hstep hD (ha a List.mem_cons_self))
      (fun b hb => ha b (List.mem_cons_of_mem _ hb))
      (fun b hb => hsrc b (List.mem_cons_of_mem _ hb))
    rw [h2, h1]
    simp only [List.map_cons, List.sum_cons]
    ring

/-- For each of the quantity, the basis, the valuation allowance and the carrying amount: what the
holdings at the destination hold afterwards, lot by lot, is what they held plus what the
allocations carry. -/
theorem arriveLoop_sums {S : List LotHolding} {da : AccountId}
    {di : List DestinationHoldingIdentity} {allocs : List LotAllocation}
    {D D' : List LotHolding} (w : LotId → ℚ)
    (h : arriveLoop S da di allocs D = .ok (.finished D'))
    (hD : ∀ x ∈ D, x.WF) (ha : ∀ a ∈ allocs, a.WF)
    (hsrc : ∀ a ∈ allocs, ∀ s, S.find? (fun holding => holding.id == a.holdingId) = some s →
      s.lotId = a.lotId) :
    (D'.map fun x => w x.lotId * x.remainingQuantity.toRat).sum =
      (D.map fun x => w x.lotId * x.remainingQuantity.toRat).sum +
        (allocs.map fun a => w a.lotId * a.allocatedQuantity.toRat).sum ∧
    (D'.map fun x => w x.lotId * x.remainingTotalBasis.toRat).sum =
      (D.map fun x => w x.lotId * x.remainingTotalBasis.toRat).sum +
        (allocs.map fun a => w a.lotId * a.allocatedTotalBasis.toRat).sum ∧
    (D'.map fun x => w x.lotId * x.remainingValuationAllowance.toRat).sum =
      (D.map fun x => w x.lotId * x.remainingValuationAllowance.toRat).sum +
        (allocs.map fun a => w a.lotId * a.allocatedValuationAllowance.toRat).sum ∧
    (D'.map fun x => w x.lotId * x.remainingCarryingAmount.toRat).sum =
      (D.map fun x => w x.lotId * x.remainingCarryingAmount.toRat).sum +
        (allocs.map fun a => w a.lotId * a.allocatedCarryingAmount.toRat).sum := by
  refine ⟨arriveLoop_sum w (·.remainingQuantity.toRat) (·.allocatedQuantity.toRat)
      (fun e a r he hw hadd => (addArrival_ok he hw hadd).2.2.1) (fun _ _ _ _ => rfl)
      allocs D D' h hD ha hsrc,
    arriveLoop_sum w (·.remainingTotalBasis.toRat) (·.allocatedTotalBasis.toRat)
      (fun e a r he hw hadd => (addArrival_ok he hw hadd).2.2.2.1) (fun _ _ _ _ => rfl)
      allocs D D' h hD ha hsrc,
    arriveLoop_sum w (·.remainingValuationAllowance.toRat) (·.allocatedValuationAllowance.toRat)
      (fun e a r he hw hadd => (addArrival_ok he hw hadd).2.2.2.2.1) (fun _ _ _ _ => rfl)
      allocs D D' h hD ha hsrc,
    arriveLoop_sum w (·.remainingCarryingAmount.toRat) (·.allocatedCarryingAmount.toRat)
      (fun e a r he hw hadd => (addArrival_ok he hw hadd).2.2.2.2.2) (fun _ _ _ _ => rfl)
      allocs D D' h hD ha hsrc⟩

/-- A turn of the loop over the allocations leaves alone every holding at the destination whose lot
is not the lot of the allocation (and adds none of them). -/
theorem arriveStep_unchanged {S : List LotHolding} {da : AccountId}
    {di : List DestinationHoldingIdentity} {D : List LotHolding} {a : LotAllocation}
    {D' : List LotHolding} (L : List LotId) (haL : a.lotId ∈ L)
    (h : arriveStep S da di D a = .ok (.finished D'))
    (hsrc : ∀ s, S.find? (fun holding => holding.id == a.holdingId) = some s →
      s.lotId = a.lotId) :
    D'.filter (fun x => decide (x.lotId ∉ L)) = D.filter (fun x => decide (x.lotId ∉ L)) := by
  obtain ⟨s, hs, hcase⟩ := arriveStep_finished h
  have hsl := hsrc s hs
  rcases hcase with ⟨pre, existing, post, replaced, hDeq, -, hl, -, hadd, hD1⟩ |
    ⟨identity, -, -, -, -, hD1⟩
  · have hlot : replaced.lotId = existing.lotId :=
      (identity_eq (addArrival_identity hadd)).2.1
    have hmem : existing.lotId ∈ L := by rw [hl, hsl]; exact haL
    have hmem' : replaced.lotId ∈ L := by rw [hlot]; exact hmem
    rw [hD1, hDeq]
    simp only [List.filter_append, List.filter_cons, hmem, hmem', decide_not, decide_true,
      Bool.not_true, Bool.false_eq_true, ↓reduceIte]
  · rw [hD1]
    have hmem : (newArrival identity.destinationHoldingId s da a).lotId ∈ L := by
      show s.lotId ∈ L
      rw [hsl]; exact haL
    simp only [List.filter_append, List.filter_cons, hmem, decide_not, decide_true, Bool.not_true,
      Bool.false_eq_true, ↓reduceIte, List.filter_nil, List.append_nil]

/-- A run of the loop over the allocations that finishes leaves alone, in the same order, every
holding at the destination whose lot is not the lot of an allocation, and adds none of them. -/
theorem arriveLoop_unchanged {S : List LotHolding} {da : AccountId}
    {di : List DestinationHoldingIdentity} :
    ∀ (allocs : List LotAllocation) (D D' : List LotHolding),
      arriveLoop S da di allocs D = .ok (.finished D') →
      (∀ a ∈ allocs, ∀ s, S.find? (fun holding => holding.id == a.holdingId) = some s →
        s.lotId = a.lotId) →
      ∀ L : List LotId, (∀ a ∈ allocs, a.lotId ∈ L) →
        D'.filter (fun x => decide (x.lotId ∉ L)) = D.filter (fun x => decide (x.lotId ∉ L)) := by
  apply arriveLoop_finished_induction
    (fun D allocs D' => (∀ a ∈ allocs, ∀ s,
        S.find? (fun holding => holding.id == a.holdingId) = some s → s.lotId = a.lotId) →
      ∀ L : List LotId, (∀ a ∈ allocs, a.lotId ∈ L) →
        D'.filter (fun x => decide (x.lotId ∉ L)) = D.filter (fun x => decide (x.lotId ∉ L)))
  · intro D _ _ _
    rfl
  · intro D a rest D1 D' hstep ih hsrc L hL
    rw [ih (fun b hb => hsrc b (List.mem_cons_of_mem _ hb)) L
      (fun b hb => hL b (List.mem_cons_of_mem _ hb))]
    exact arriveStep_unchanged L (hL a List.mem_cons_self) hstep (hsrc a List.mem_cons_self)

/-- A run of the loop over the allocations that finishes leaves the identifiers at the destination
all different, and none the identifier of a source holding, if they were so before. -/
theorem arriveLoop_ids {S : List LotHolding} {da : AccountId}
    {di : List DestinationHoldingIdentity} :
    ∀ (allocs : List LotAllocation) (D D' : List LotHolding),
      arriveLoop S da di allocs D = .ok (.finished D') →
      (D.map (·.id)).Nodup → (∀ x ∈ D, ∀ s ∈ S, x.id ≠ s.id) →
      (D'.map (·.id)).Nodup ∧ ∀ x ∈ D', ∀ s ∈ S, x.id ≠ s.id := by
  apply arriveLoop_finished_induction
    (fun D allocs D' => (D.map (·.id)).Nodup → (∀ x ∈ D, ∀ s ∈ S, x.id ≠ s.id) →
      (D'.map (·.id)).Nodup ∧ ∀ x ∈ D', ∀ s ∈ S, x.id ≠ s.id)
  · intro D hn hd
    exact ⟨hn, hd⟩
  · intro D a rest D1 D' hstep ih hn hd
    obtain ⟨s, hs, hcase⟩ := arriveStep_finished hstep
    rcases hcase with ⟨pre, existing, post, replaced, hDeq, -, -, -, hadd, hD1⟩ |
      ⟨identity, -, -, hfresh, hsfresh, hD1⟩
    · have hid : replaced.id = existing.id := (identity_eq (addArrival_identity hadd)).1
      apply ih
      · rw [hD1]
        rw [hDeq] at hn
        simpa [hid] using hn
      · intro x hx t ht
        rw [hD1] at hx
        rw [hDeq] at hd
        simp only [List.mem_append, List.mem_cons] at hx
        rcases hx with hx | rfl | hx
        · exact hd x (by simp [hx]) t ht
        · rw [hid]; exact hd existing (by simp) t ht
        · exact hd x (by simp [hx]) t ht
    · apply ih
      · rw [hD1]
        simp only [List.map_append, List.map_cons, List.map_nil]
        refine List.nodup_append.mpr ⟨hn, List.nodup_singleton _, ?_⟩
        intro x hx y hy
        obtain ⟨z, hz, rfl⟩ := List.mem_map.mp hx
        rw [List.mem_singleton] at hy
        subst hy
        exact hfresh z hz
      · intro x hx t ht
        rw [hD1] at hx
        rcases List.mem_append.mp hx with hx | hx
        · exact hd x hx t ht
        · rw [List.mem_singleton] at hx
          subst hx
          exact fun heq => hsfresh t ht heq.symm

/-- A run of the loop over the allocations that finishes keeps every holding at the destination as
a holding with the same identity, and leaves a holding of the lot of each allocation, in the
destination account. -/
theorem arriveLoop_covers {S : List LotHolding} {da : AccountId}
    {di : List DestinationHoldingIdentity} :
    ∀ (allocs : List LotAllocation) (D D' : List LotHolding),
      arriveLoop S da di allocs D = .ok (.finished D') →
      (∀ a ∈ allocs, ∀ s, S.find? (fun holding => holding.id == a.holdingId) = some s →
        s.lotId = a.lotId) →
      (∀ x ∈ D, ∃ y ∈ D', y.identity = x.identity) ∧
      ∀ a ∈ allocs, ∃ y ∈ D', y.lotId = a.lotId ∧ y.accountId = da := by
  apply arriveLoop_finished_induction
    (fun D allocs D' => (∀ a ∈ allocs, ∀ s,
        S.find? (fun holding => holding.id == a.holdingId) = some s → s.lotId = a.lotId) →
      (∀ x ∈ D, ∃ y ∈ D', y.identity = x.identity) ∧
      ∀ a ∈ allocs, ∃ y ∈ D', y.lotId = a.lotId ∧ y.accountId = da)
  · intro D _
    exact ⟨fun x hx => ⟨x, hx, rfl⟩, by simp⟩
  · intro D a rest D1 D' hstep ih hsrc
    obtain ⟨ihp, ihc⟩ := ih (fun b hb => hsrc b (List.mem_cons_of_mem _ hb))
    obtain ⟨s, hs, hcase⟩ := arriveStep_finished hstep
    have hsl := hsrc a List.mem_cons_self s hs
    have key : (∀ x ∈ D, ∃ y ∈ D1, y.identity = x.identity) ∧
        ∃ y ∈ D1, y.lotId = a.lotId ∧ y.accountId = da := by
      rcases hcase with ⟨pre, existing, post, replaced, hDeq, -, hl, hacc, hadd, hD1⟩ |
        ⟨identity, -, -, -, -, hD1⟩
      · have hid := addArrival_identity hadd
        refine ⟨fun x hx => ?_, replaced, by rw [hD1]; simp, ?_, ?_⟩
        · rw [hDeq] at hx
          simp only [List.mem_append, List.mem_cons] at hx
          rcases hx with hx | rfl | hx
          · exact ⟨x, by rw [hD1]; simp [hx], rfl⟩
          · exact ⟨replaced, by rw [hD1]; simp, hid⟩
          · exact ⟨x, by rw [hD1]; simp [hx], rfl⟩
        · rw [(identity_eq hid).2.1, hl, hsl]
        · rw [(identity_eq hid).2.2, hacc]
      · refine ⟨fun x hx => ⟨x, by rw [hD1]; simp [hx], rfl⟩,
          newArrival identity.destinationHoldingId s da a, by rw [hD1]; simp, ?_, rfl⟩
        exact hsl
    refine ⟨fun x hx => ?_, ?_⟩
    · obtain ⟨y1, hy1, hy1id⟩ := key.1 x hx
      obtain ⟨y, hy, hyid⟩ := ihp y1 hy1
      exact ⟨y, hy, hyid.trans hy1id⟩
    · intro b hb
      rcases List.mem_cons.mp hb with rfl | hb
      · obtain ⟨y1, hy1, hl1, ha1⟩ := key.2
        obtain ⟨y, hy, hyid⟩ := ihp y1 hy1
        obtain ⟨-, hl, hacc⟩ := identity_eq hyid
        exact ⟨y, hy, hl.trans hl1, hacc.trans ha1⟩
      · exact ihc b hb

end Lots

/-! ## Laws of `transferLots`: the ways a call ends -/

namespace Lots

/-- The diagnostic for a call without a source holding. -/
def noSourceDiagnostic : SemanticDiagnostic :=
  diagnostic .lot_overallocation "sourceHoldings" "No source holding supplied"
    ["ACC-008", "ACC-009", "ACC-023"]

/-- The diagnostic for source holdings of more than one book or account. -/
def mixedSourceDiagnostic : SemanticDiagnostic :=
  diagnostic .book_isolation_violation "sourceHoldings"
    "A transfer source must contain one book and account" ["ACC-009", "ACC-010", "ACC-026"]

/-- The diagnostic for a count of applicable policies other than one. -/
def transferPolicyCountDiagnostic (found : Nat) : SemanticDiagnostic :=
  diagnostic .transfer_policy_missing "policies"
    s!"Expected exactly one applicable transfer policy; found {found}"
    ["ACC-007", "ACC-010", "ACC-011"]

/-- The diagnostic for a continuity transfer between one account and itself. -/
def sameAccountDiagnostic : SemanticDiagnostic :=
  diagnostic .lot_overallocation "destinationAccountId"
    "A continuity transfer requires distinct source and destination accounts"
    ["ACC-009", "ACC-010", "ACC-023"]

/-- The diagnostic for a destination holding of another book, account, commodity or basis
commodity. -/
def destinationScopeDiagnostic : SemanticDiagnostic :=
  diagnostic .book_isolation_violation "destinationHoldings"
    "Destination holdings must use the transfer book, account, commodity, and basis commodity"
    ["ACC-009", "ACC-010", "ACC-026"]

/-- The diagnostic for destination holdings with a repeated identifier, or one that a source holding
has. -/
def destinationDuplicateDiagnostic : SemanticDiagnostic :=
  diagnostic .canonical_identity_conflict "destinationHoldings"
    "Destination holding identity is duplicated" ["ACC-008", "ACC-038"]

/-- The policies that apply to a transfer out of the account of `source` into `account` at an
instant. -/
def applicableTransferPolicies (policies : List TransferPolicy) (source : LotHolding)
    (account : AccountId) (governedAt : Instant) : List TransferPolicy :=
  policies.filter (policyApplies source account governedAt)

/-- A policy applies to a transfer exactly when it is for the book and source account of the
transfer and for its destination account, and the instant is not before the policy begins and is
before it ends when it ends, each comparison being false for a text that `Date.parse` does not
read. -/
theorem policyApplies_iff (source : LotHolding) (account : AccountId) (governedAt : Instant)
    (policy : TransferPolicy) :
    policyApplies source account governedAt policy = true ↔
      policy.bookId = source.bookId ∧ policy.sourceAccountId = source.accountId ∧
      policy.destinationAccountId = account ∧
      (∃ begins moment, dateParse policy.validFrom.value = some begins ∧
        dateParse governedAt.value = some moment ∧ begins ≤ moment) ∧
      (∀ validTo, policy.validTo = some validTo →
        ∃ ends moment, dateParse validTo.value = some ends ∧
          dateParse governedAt.value = some moment ∧ moment < ends) := by
  unfold policyApplies dateParseLe dateParseLt
  simp only [Bool.and_eq_true, beq_iff_eq]
  constructor
  · rintro ⟨⟨⟨⟨h1, h2⟩, h3⟩, h4⟩, h5⟩
    refine ⟨h1, h2, h3, ?_, ?_⟩
    · cases hf : dateParse policy.validFrom.value with
      | none => simp [hf] at h4
      | some begins =>
        cases hg : dateParse governedAt.value with
        | none => simp [hf, hg] at h4
        | some moment =>
          simp only [hf, hg, decide_eq_true_eq] at h4
          exact ⟨begins, moment, rfl, rfl, h4⟩
    · intro validTo hv
      rw [hv] at h5
      cases hg : dateParse governedAt.value with
      | none => simp [hg] at h5
      | some moment =>
        cases he : dateParse validTo.value with
        | none => simp [hg, he] at h5
        | some ends =>
          simp only [hg, he, decide_eq_true_eq] at h5
          exact ⟨ends, moment, rfl, rfl, h5⟩
  · rintro ⟨h1, h2, h3, ⟨begins, moment, hb, ha, hle⟩, h5⟩
    refine ⟨⟨⟨⟨h1, h2⟩, h3⟩, ?_⟩, ?_⟩
    · simp [hb, ha, hle]
    · cases hv : policy.validTo with
      | none => rfl
      | some validTo =>
        obtain ⟨ends, moment', he, ha', hlt⟩ := h5 validTo hv
        simp only [ha', he, decide_eq_true_eq]
        have : moment' = moment := by rw [ha] at ha'; exact (Option.some.inj ha').symm
        subst this
        exact hlt

end Lots

namespace Lots

/-- A holding is of a book and account other than those of `source` exactly when it is not both. -/
theorem any_mixed_iff (S : List LotHolding) (source : LotHolding) :
    S.any (fun holding => holding.bookId != source.bookId ||
      holding.accountId != source.accountId) = true ↔
      ∃ holding ∈ S, holding.bookId ≠ source.bookId ∨ holding.accountId ≠ source.accountId := by
  simp [List.any_eq_true, Bool.or_eq_true, bne_iff_ne]

/-- A destination holding is of the book, account, commodity and basis commodity of the
transfer. -/
def DestinationInScope (source : LotHolding) (account : AccountId) (holding : LotHolding) : Prop :=
  holding.bookId = source.bookId ∧ holding.accountId = account ∧
    holding.commodityId = source.commodityId ∧ holding.basisCommodityId = source.basisCommodityId

/-- A destination holding is out of scope exactly when it is not of the book, account, commodity and
basis commodity of the transfer. -/
theorem destinationOutOfScope_iff (source : LotHolding) (account : AccountId)
    (holding : LotHolding) :
    destinationOutOfScope source account holding = true ↔
      ¬ DestinationInScope source account holding := by
  unfold destinationOutOfScope DestinationInScope
  simp only [Bool.or_eq_true, bne_iff_ne, ne_eq]
  tauto

/-- The destination holdings have different identifiers, and none has the identifier of a source
holding. -/
def DestinationIdsFree (S D : List LotHolding) : Prop :=
  (D.map (·.id)).Nodup ∧ ∀ holding ∈ D, ∀ item ∈ S, item.id ≠ holding.id

/-- The test for a repeated destination identifier, or one that a source holding has, fails exactly
when the identifiers are free. -/
theorem destinationConflict_iff (S D : List LotHolding) :
    (setSize (D.map (·.id)) ≠ D.length ∨
      D.any (fun holding => S.any (fun item => item.id == holding.id)) = true) ↔
      ¬ DestinationIdsFree S D := by
  have h1 : setSize (D.map (·.id)) = D.length ↔ (D.map (·.id)).Nodup := by
    have := setSize_eq_length_iff (D.map (·.id))
    rwa [List.length_map] at this
  unfold DestinationIdsFree
  rw [not_and_or, ← h1]
  simp only [List.any_eq_true, beq_iff_eq, not_forall, not_not]
  constructor
  · rintro (h | ⟨holding, hD, item, hS, hid⟩)
    · exact Or.inl h
    · exact Or.inr ⟨holding, hD, item, hS, hid⟩
  · rintro (h | ⟨holding, hD, item, hS, hid⟩)
    · exact Or.inl h
    · exact Or.inr ⟨holding, hD, item, hS, hid⟩

/-- What `transferLots` has checked before it allocates: the first source holding, that every
source holding is of its book and account, that exactly one policy applies and asks for a
continuity transfer, and that the accounts differ. -/
structure Front (S : List LotHolding) (policies : List TransferPolicy) (governedAt : Instant)
    (account : AccountId) (source : LotHolding) (policy : TransferPolicy) : Prop where
  head : S.head? = some source
  oneScope : ∀ holding ∈ S, holding.bookId = source.bookId ∧ holding.accountId = source.accountId
  governing : applicableTransferPolicies policies source account governedAt = [policy]
  continuity : policy.treatment = .continuity
  distinct : source.accountId ≠ account

/-- The ways a call of `transferLots` can end, each with the exact conditions that lead to it and
the result it gives: the stages of the function in order, each reached only when the stages before
it passed. -/
def TransferExit (S D : List LotHolding) (lots : List Lot) (requestedQuantity : ExactRational)
    (selection : LotSelection) (policies : List TransferPolicy) (governedAt : Instant)
    (da : AccountId) (derivation : DerivationRecord)
    (allocationIdentities : List LotAllocationIdentity)
    (destinationIdentities : List DestinationHoldingIdentity)
    (r : Except LotsErr LotTransferResult) : Prop :=
  -- no source holding
  (S = [] ∧ r = .ok (.rejected [noSourceDiagnostic])) ∨
  -- source holdings of more than one book or account
  (∃ source, S.head? = some source ∧
    (∃ holding ∈ S, holding.bookId ≠ source.bookId ∨ holding.accountId ≠ source.accountId) ∧
    r = .ok (.rejected [mixedSourceDiagnostic])) ∨
  -- the number of policies that apply is not one
  (∃ source, S.head? = some source ∧
    (∀ holding ∈ S, holding.bookId = source.bookId ∧ holding.accountId = source.accountId) ∧
    (∀ policy, applicableTransferPolicies policies source da governedAt ≠ [policy]) ∧
    r = .ok (.rejected
      [transferPolicyCountDiagnostic (applicableTransferPolicies policies source da governedAt).length])) ∨
  -- the one policy that applies asks for disposal and reacquisition
  (∃ source policy, S.head? = some source ∧
    (∀ holding ∈ S, holding.bookId = source.bookId ∧ holding.accountId = source.accountId) ∧
    applicableTransferPolicies policies source da governedAt = [policy] ∧
    policy.treatment = .disposalAndReacquisition ∧
    r = .ok (.requiresDisposalAndReacquisition policy)) ∨
  -- a continuity transfer from an account to itself
  (∃ source policy, S.head? = some source ∧
    (∀ holding ∈ S, holding.bookId = source.bookId ∧ holding.accountId = source.accountId) ∧
    applicableTransferPolicies policies source da governedAt = [policy] ∧
    policy.treatment = .continuity ∧ source.accountId = da ∧
    r = .ok (.rejected [sameAccountDiagnostic])) ∨
  -- the allocation throws
  (∃ source policy e, Front S policies governedAt da source policy ∧
    allocateLots S lots requestedQuantity selection derivation allocationIdentities = .error e ∧
    r = .error (.exactNumber e)) ∨
  -- the allocation rejects
  (∃ source policy diagnostics, Front S policies governedAt da source policy ∧
    allocateLots S lots requestedQuantity selection derivation allocationIdentities =
      .ok (.rejected diagnostics) ∧
    r = .ok (.rejected diagnostics)) ∨
  -- a destination holding is of another book, account, commodity or basis commodity
  (∃ source policy allocations holdings, Front S policies governedAt da source policy ∧
    allocateLots S lots requestedQuantity selection derivation allocationIdentities =
      .ok (.allocated allocations holdings) ∧
    (∃ holding ∈ D, ¬ DestinationInScope source da holding) ∧
    r = .ok (.rejected [destinationScopeDiagnostic])) ∨
  -- destination identifiers are repeated, or a source holding has one
  (∃ source policy allocations holdings, Front S policies governedAt da source policy ∧
    allocateLots S lots requestedQuantity selection derivation allocationIdentities =
      .ok (.allocated allocations holdings) ∧
    (∀ holding ∈ D, DestinationInScope source da holding) ∧ ¬ DestinationIdsFree S D ∧
    r = .ok (.rejected [destinationDuplicateDiagnostic])) ∨
  -- the loop over the allocations throws
  (∃ source policy allocations holdings e, Front S policies governedAt da source policy ∧
    allocateLots S lots requestedQuantity selection derivation allocationIdentities =
      .ok (.allocated allocations holdings) ∧
    (∀ holding ∈ D, DestinationInScope source da holding) ∧ DestinationIdsFree S D ∧
    arriveLoop S da destinationIdentities allocations D = .error e ∧ r = .error e) ∨
  -- the loop over the allocations rejects
  (∃ source policy allocations holdings diagnostics, Front S policies governedAt da source policy ∧
    allocateLots S lots requestedQuantity selection derivation allocationIdentities =
      .ok (.allocated allocations holdings) ∧
    (∀ holding ∈ D, DestinationInScope source da holding) ∧ DestinationIdsFree S D ∧
    arriveLoop S da destinationIdentities allocations D = .ok (.rejected diagnostics) ∧
    r = .ok (.rejected diagnostics)) ∨
  -- the transfer is made
  (∃ source policy allocations holdings destination, Front S policies governedAt da source policy ∧
    allocateLots S lots requestedQuantity selection derivation allocationIdentities =
      .ok (.allocated allocations holdings) ∧
    (∀ holding ∈ D, DestinationInScope source da holding) ∧ DestinationIdsFree S D ∧
    arriveLoop S da destinationIdentities allocations D = .ok (.finished destination) ∧
    r = .ok (.transferred holdings destination allocations))

end Lots

namespace Lots

/-- Every call of `transferLots` ends in one of the ways that `TransferExit` lists. -/
theorem transferLots_exit (S D : List LotHolding) (lots : List Lot)
    (requestedQuantity : ExactRational) (selection : LotSelection)
    (policies : List TransferPolicy) (governedAt : Instant) (da : AccountId)
    (derivation : DerivationRecord) (allocationIdentities : List LotAllocationIdentity)
    (destinationIdentities : List DestinationHoldingIdentity) :
    TransferExit S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities
      (transferLots S D lots requestedQuantity selection policies governedAt da derivation
        allocationIdentities destinationIdentities) := by
  unfold TransferExit
  cases S with
  | nil =>
    refine Or.inl ⟨rfl, ?_⟩
    simp [transferLots, noSourceDiagnostic]
  | cons source rest =>
    have hhead : (source :: rest).head? = some source := rfl
    by_cases hmix : (source :: rest).any (fun holding =>
        holding.bookId != source.bookId || holding.accountId != source.accountId) = true
    · refine Or.inr (Or.inl ⟨source, hhead, (any_mixed_iff _ _).mp hmix, ?_⟩)
      unfold transferLots
      simp only [List.head?_cons, hmix, ↓reduceIte, mixedSourceDiagnostic]
    · have hmix' : (source :: rest).any (fun holding =>
          holding.bookId != source.bookId || holding.accountId != source.accountId) = false :=
        Bool.eq_false_iff.mpr hmix
      have hscope : ∀ holding ∈ source :: rest,
          holding.bookId = source.bookId ∧ holding.accountId = source.accountId := by
        intro holding hh
        by_contra hc
        apply hmix
        rw [any_mixed_iff]
        exact ⟨holding, hh, by tauto⟩
      rcases hf : applicableTransferPolicies policies source da governedAt with
        _ | ⟨policy, _ | ⟨second, more⟩⟩
      · refine Or.inr (Or.inr (Or.inl ⟨source, hhead, hscope,
          fun policy => by rw [hf]; simp, ?_⟩))
        have hf' : List.filter (policyApplies source da governedAt) policies = [] := hf
        rw [hf]
        unfold transferLots
        simp only [List.head?_cons, hmix', hf', Bool.false_eq_true, ↓reduceIte,
          List.length_nil, transferPolicyCountDiagnostic]
      · have hf' : List.filter (policyApplies source da governedAt) policies = [policy] := hf
        by_cases htreat : policy.treatment = .disposalAndReacquisition
        · refine Or.inr (Or.inr (Or.inr (Or.inl ⟨source, policy, hhead, hscope, hf, htreat, ?_⟩)))
          unfold transferLots
          simp only [List.head?_cons, hmix', hf', htreat, Bool.false_eq_true, ↓reduceIte]
        have hcont : policy.treatment = .continuity := by
          cases h : policy.treatment
          · rfl
          · exact absurd h htreat
        by_cases hacc : source.accountId = da
        · refine Or.inr (Or.inr (Or.inr (Or.inr (Or.inl
            ⟨source, policy, hhead, hscope, hf, hcont, hacc, ?_⟩))))
          have hbeq : (source.accountId == da) = true := by simp [hacc]
          unfold transferLots
          simp only [List.head?_cons, hmix', hf', htreat, hbeq, Bool.false_eq_true, ↓reduceIte,
            sameAccountDiagnostic]
        have hbeq : (source.accountId == da) = false := by simpa using hacc
        have front : Front (source :: rest) policies governedAt da source policy :=
          ⟨hhead, hscope, hf, hcont, hacc⟩
        cases hA : allocateLots (source :: rest) lots requestedQuantity selection derivation
            allocationIdentities with
        | error e =>
          refine Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inl
            ⟨source, policy, e, front, rfl, ?_⟩)))))
          unfold transferLots
          simp only [List.head?_cons, hmix', hf', htreat, hbeq, Bool.false_eq_true, ↓reduceIte, hA]
        | ok result =>
          cases result with
          | rejected diagnostics =>
            refine Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inl
              ⟨source, policy, diagnostics, front, rfl, ?_⟩))))))
            unfold transferLots
            simp only [List.head?_cons, hmix', hf', htreat, hbeq, Bool.false_eq_true, ↓reduceIte,
              hA]
          | allocated allocations holdings =>
            by_cases hsc : D.any (destinationOutOfScope source da) = true
            · refine Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inl
                ⟨source, policy, allocations, holdings, front, rfl, ?_, ?_⟩)))))))
              · obtain ⟨holding, hm, hh⟩ := List.any_eq_true.mp hsc
                exact ⟨holding, hm, (destinationOutOfScope_iff _ _ _).mp hh⟩
              · unfold transferLots
                simp only [List.head?_cons, hmix', hf', htreat, hbeq, Bool.false_eq_true,
                  ↓reduceIte, hA, hsc, destinationScopeDiagnostic]
            have hin : ∀ holding ∈ D, DestinationInScope source da holding := by
              intro holding hm
              by_contra hh
              apply hsc
              rw [List.any_eq_true]
              exact ⟨holding, hm, (destinationOutOfScope_iff _ _ _).mpr hh⟩
            by_cases hdup : (setSize (D.map (·.id)) ≠ D.length ∨
                D.any (fun holding => (source :: rest).any (fun item => item.id == holding.id)) =
                  true)
            · refine Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inl
                ⟨source, policy, allocations, holdings, front, rfl, hin,
                  (destinationConflict_iff _ _).mp hdup, ?_⟩))))))))
              unfold transferLots
              simp only [List.head?_cons, hmix', hf', htreat, hbeq, Bool.false_eq_true,
                ↓reduceIte, hA, hsc, hdup, destinationDuplicateDiagnostic]
            have hfree : DestinationIdsFree (source :: rest) D := by
              by_contra hh
              exact hdup ((destinationConflict_iff _ _).mpr hh)
            cases hl : arriveLoop (source :: rest) da destinationIdentities allocations D with
            | error e =>
              refine Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr
                (Or.inl ⟨source, policy, allocations, holdings, e, front, rfl, hin, hfree,
                  hl, ?_⟩)))))))))
              unfold transferLots
              simp only [List.head?_cons, hmix', hf', htreat, hbeq, Bool.false_eq_true,
                ↓reduceIte, hA, hsc, hdup, hl]
            | ok result2 =>
              cases result2 with
              | rejected diagnostics =>
                refine Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr
                  (Or.inr (Or.inl ⟨source, policy, allocations, holdings, diagnostics, front,
                    rfl, hin, hfree, hl, ?_⟩))))))))))
                unfold transferLots
                simp only [List.head?_cons, hmix', hf', htreat, hbeq, Bool.false_eq_true,
                  ↓reduceIte, hA, hsc, hdup, hl]
              | finished destination =>
                refine Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr
                  (Or.inr (Or.inr ⟨source, policy, allocations, holdings, destination, front,
                    rfl, hin, hfree, hl, ?_⟩))))))))))
                unfold transferLots
                simp only [List.head?_cons, hmix', hf', htreat, hbeq, Bool.false_eq_true,
                  ↓reduceIte, hA, hsc, hdup, hl]
      · refine Or.inr (Or.inr (Or.inl ⟨source, hhead, hscope,
          fun policy => by rw [hf]; simp, ?_⟩))
        have hf' : List.filter (policyApplies source da governedAt) policies =
            policy :: second :: more := hf
        rw [hf]
        unfold transferLots
        simp only [List.head?_cons, hmix', hf', Bool.false_eq_true, ↓reduceIte,
          transferPolicyCountDiagnostic]

end Lots

namespace Lots

/-- A test that does not fail is true. -/
theorem bool_true_of_ne_false {b : Bool} (h : ¬ b = false) : b = true := by
  cases b
  · exact absurd rfl h
  · rfl

/-- Source holdings that are all of one book and account do not trip the test for mixed source
holdings. -/
theorem any_mixed_false {S : List LotHolding} {source : LotHolding}
    (h : ∀ holding ∈ S, holding.bookId = source.bookId ∧ holding.accountId = source.accountId) :
    S.any (fun holding => holding.bookId != source.bookId ||
      holding.accountId != source.accountId) = false := by
  by_contra hc
  obtain ⟨holding, hm, hne⟩ := (any_mixed_iff S source).mp (bool_true_of_ne_false hc)
  exact hne.elim (fun h1 => h1 (h holding hm).1) (fun h2 => h2 (h holding hm).2)

/-- What `Front` says, in the form the function tests it. -/
theorem Front.facts {S : List LotHolding} {policies : List TransferPolicy} {governedAt : Instant}
    {da : AccountId} {source : LotHolding} {policy : TransferPolicy}
    (front : Front S policies governedAt da source policy) :
    S.head? = some source ∧
    S.any (fun holding => holding.bookId != source.bookId ||
      holding.accountId != source.accountId) = false ∧
    List.filter (policyApplies source da governedAt) policies = [policy] ∧
    ¬ policy.treatment = .disposalAndReacquisition ∧ (source.accountId == da) = false := by
  refine ⟨front.head, any_mixed_false front.oneScope, front.governing, ?_, ?_⟩
  · rw [front.continuity]
    exact fun h => by cases h
  · simpa using front.distinct

/-- A call of `transferLots` gives a result exactly when one of the ways that `TransferExit` lists
leads to it. -/
theorem transferLots_eq_iff (S D : List LotHolding) (lots : List Lot)
    (requestedQuantity : ExactRational) (selection : LotSelection)
    (policies : List TransferPolicy) (governedAt : Instant) (da : AccountId)
    (derivation : DerivationRecord) (allocationIdentities : List LotAllocationIdentity)
    (destinationIdentities : List DestinationHoldingIdentity)
    (r : Except LotsErr LotTransferResult) :
    transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities = r ↔
    TransferExit S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities r := by
  constructor
  · intro h
    subst h
    exact transferLots_exit S D lots requestedQuantity selection policies governedAt da
      derivation allocationIdentities destinationIdentities
  · unfold TransferExit
    rintro (⟨hS, hr⟩ | ⟨source, hhead, hmix, hr⟩ |
      ⟨source, hhead, hscope, hpol, hr⟩ | ⟨source, policy, hhead, hscope, hgov, htreat, hr⟩ |
      ⟨source, policy, hhead, hscope, hgov, hcont, hacc, hr⟩ |
      ⟨source, policy, e, front, hA, hr⟩ | ⟨source, policy, diagnostics, front, hA, hr⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hout, hr⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hin, hdup, hr⟩ |
      ⟨source, policy, allocations, holdings, e, front, hA, hin, hfree, hl, hr⟩ |
      ⟨source, policy, allocations, holdings, diagnostics, front, hA, hin, hfree, hl, hr⟩ |
      ⟨source, policy, allocations, holdings, destination, front, hA, hin, hfree, hl, hr⟩)
    · subst hr hS
      simp [transferLots, noSourceDiagnostic]
    · subst hr
      obtain ⟨holding, hm, hne⟩ := hmix
      have hmix' : S.any (fun holding => holding.bookId != source.bookId ||
          holding.accountId != source.accountId) = true := (any_mixed_iff _ _).mpr ⟨holding, hm, hne⟩
      unfold transferLots
      simp only [hhead, hmix', ↓reduceIte, mixedSourceDiagnostic]
    · subst hr
      have hmix' := any_mixed_false hscope
      have hnot : ∀ policy, List.filter (policyApplies source da governedAt) policies ≠ [policy] :=
        hpol
      unfold transferLots
      simp only [hhead, hmix', Bool.false_eq_true, ↓reduceIte]
      rcases hf : List.filter (policyApplies source da governedAt) policies with
        _ | ⟨p1, _ | ⟨p2, more⟩⟩
      · simp [transferPolicyCountDiagnostic, applicableTransferPolicies, hf]
      · exact absurd hf (hnot p1)
      · simp [transferPolicyCountDiagnostic, applicableTransferPolicies, hf]
    · subst hr
      have hmix' := any_mixed_false hscope
      have hf' : List.filter (policyApplies source da governedAt) policies = [policy] := hgov
      unfold transferLots
      simp only [hhead, hmix', hf', htreat, Bool.false_eq_true, ↓reduceIte]
    · subst hr
      have hmix' := any_mixed_false hscope
      have hf' : List.filter (policyApplies source da governedAt) policies = [policy] := hgov
      have hbeq : (source.accountId == da) = true := by simp [hacc]
      have htreat : ¬ policy.treatment = .disposalAndReacquisition := by
        rw [hcont]; exact fun h => by cases h
      unfold transferLots
      simp only [hhead, hmix', hf', htreat, hbeq, Bool.false_eq_true, ↓reduceIte,
        sameAccountDiagnostic]
    · subst hr
      obtain ⟨hhead, hmix', hf', htreat, hbeq⟩ := front.facts
      unfold transferLots
      simp only [hhead, hmix', hf', htreat, hbeq, Bool.false_eq_true, ↓reduceIte, hA]
    · subst hr
      obtain ⟨hhead, hmix', hf', htreat, hbeq⟩ := front.facts
      unfold transferLots
      simp only [hhead, hmix', hf', htreat, hbeq, Bool.false_eq_true, ↓reduceIte, hA]
    · subst hr
      obtain ⟨hhead, hmix', hf', htreat, hbeq⟩ := front.facts
      obtain ⟨holding, hm, hh⟩ := hout
      have hsc : D.any (destinationOutOfScope source da) = true :=
        List.any_eq_true.mpr ⟨holding, hm, (destinationOutOfScope_iff _ _ _).mpr hh⟩
      unfold transferLots
      simp only [hhead, hmix', hf', htreat, hbeq, Bool.false_eq_true, ↓reduceIte, hA, hsc,
        destinationScopeDiagnostic]
    · subst hr
      obtain ⟨hhead, hmix', hf', htreat, hbeq⟩ := front.facts
      have hsc : D.any (destinationOutOfScope source da) = false := by
        by_contra hc
        obtain ⟨holding, hm, hh⟩ := List.any_eq_true.mp (bool_true_of_ne_false hc)
        exact (destinationOutOfScope_iff _ _ _).mp hh (hin holding hm)
      have hdup' := (destinationConflict_iff S D).mpr hdup
      unfold transferLots
      simp only [hhead, hmix', hf', htreat, hbeq, Bool.false_eq_true, ↓reduceIte, hA, hsc,
        hdup', destinationDuplicateDiagnostic]
    all_goals
      subst hr
      obtain ⟨hhead, hmix', hf', htreat, hbeq⟩ := front.facts
      have hsc : D.any (destinationOutOfScope source da) = false := by
        by_contra hc
        obtain ⟨holding, hm, hh⟩ := List.any_eq_true.mp (bool_true_of_ne_false hc)
        exact (destinationOutOfScope_iff _ _ _).mp hh (hin holding hm)
      have hdup' : ¬ (setSize (D.map (·.id)) ≠ D.length ∨
          D.any (fun holding => S.any (fun item => item.id == holding.id)) = true) := by
        rw [destinationConflict_iff]
        exact not_not.mpr hfree
      unfold transferLots
      simp only [hhead, hmix', hf', htreat, hbeq, Bool.false_eq_true, ↓reduceIte, hA, hsc,
        hdup', hl]

end Lots

/-! ## Laws of `transferLots`: what a transfer went through and what it conserves -/

namespace Lots

/-- A transfer is returned only after every check has passed, in this order: the source holdings
are of one book and account, exactly one policy applies and it asks for a continuity transfer
between different accounts, the source holdings were allocated, the destination holdings are of the
book, account, commodity and basis commodity of the transfer and have identifiers of their own, and
the allocations arrived at the destination. -/
theorem transferLots_transferred_inv {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {S' D' : List LotHolding}
    {allocations : List LotAllocation}
    (h : transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities = .ok (.transferred S' D' allocations)) :
    ∃ source policy, Front S policies governedAt da source policy ∧
      allocateLots S lots requestedQuantity selection derivation allocationIdentities =
        .ok (.allocated allocations S') ∧
      (∀ holding ∈ D, DestinationInScope source da holding) ∧ DestinationIdsFree S D ∧
      arriveLoop S da destinationIdentities allocations D = .ok (.finished D') := by
  have hexit := (transferLots_eq_iff S D lots requestedQuantity selection policies governedAt da
    derivation allocationIdentities destinationIdentities _).mp h
  unfold TransferExit at hexit
  rcases hexit with ⟨-, hr⟩ | ⟨-, -, -, hr⟩ | ⟨src, -, -, -, hr⟩ | ⟨-, pol, -, -, -, -, hr⟩ |
    ⟨-, -, -, -, -, -, -, hr⟩ | ⟨-, -, err, -, -, hr⟩ | ⟨-, -, ds, -, -, hr⟩ |
    ⟨-, -, -, -, -, -, -, hr⟩ | ⟨-, -, -, -, -, -, -, -, hr⟩ |
    ⟨-, -, -, -, err, -, -, -, -, -, hr⟩ | ⟨-, -, -, -, ds, -, -, -, -, -, hr⟩ |
    ⟨source, policy, allocations', holdings, destination, front, hA, hin, hfree, hl, hr⟩
  · simp at hr
  · simp at hr
  · simp at hr
  · simp at hr
  · simp at hr
  · simp at hr
  · simp at hr
  · simp at hr
  · simp at hr
  · simp at hr
  · simp at hr
  · simp only [Except.ok.injEq, LotTransferResult.transferred.injEq] at hr
    obtain ⟨rfl, rfl, rfl⟩ := hr
    exact ⟨source, policy, front, hA, hin, hfree, hl⟩

/-- Every allocation that a call of `allocateLots` returns is of constructible numbers, and names
the one holding that the source holdings have under its identifier, which is of the allocation's
lot. -/
theorem allocateLots_allocations_lots {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection} {derivation : DerivationRecord}
    {identities : List LotAllocationIdentity} {allocations : List LotAllocation}
    {after : List LotHolding}
    (hw : ∀ holding ∈ holdings, holding.WF) (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : allocateLots holdings lots requestedQuantity selection derivation identities =
      .ok (.allocated allocations after)) :
    (∀ allocation ∈ allocations, allocation.WF) ∧
    (∀ allocation ∈ allocations, ∃ s,
      holdings.find? (fun holding => holding.id == allocation.holdingId) = some s ∧
        s.lotId = allocation.lotId) := by
  obtain ⟨candidates, specificQuantities, available, final, takes, run⟩ :=
    allocateLots_run hw hr hs h
  refine ⟨?_, ?_⟩
  · intro allocation hmem
    rw [run.allocations_eq] at hmem
    obtain ⟨t, ht, rfl⟩ := List.mem_map.mp hmem
    exact (run.trace.took t ht).allocation_wf
  · intro allocation hmem
    rw [run.allocations_eq] at hmem
    obtain ⟨t, ht, rfl⟩ := List.mem_map.mp hmem
    have k := run.trace.took t ht
    have hex : ∃ s, holdings.find? (fun holding => holding.id == t.allocation.holdingId) =
        some s := by
      cases hf : holdings.find? (fun holding => holding.id == t.allocation.holdingId) with
      | some s => exact ⟨s, rfl⟩
      | none =>
        exfalso
        have := List.find?_eq_none.mp hf t.holding (run.taken_mem t ht)
        simp [k.holdingId] at this
    obtain ⟨s, hs'⟩ := hex
    refine ⟨s, hs', ?_⟩
    have hsmem := List.mem_of_find?_eq_some hs'
    have hsid : s.id = t.allocation.holdingId := by simpa using List.find?_some hs'
    have : s = t.holding := List.inj_on_of_nodup_map run.holdings_nodup hsmem (run.taken_mem t ht)
      (hsid.trans k.holdingId)
    rw [this, k.lotId]

end Lots

/-! ## Laws of `transferLots`: conservation -/

/-- The allocations of a transfer are exactly the ones `allocateLots` gives for the source
holdings, and the source holdings after are the ones it returns. -/
theorem transferLots_allocations {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {S' D' : List LotHolding}
    {allocations : List LotAllocation}
    (h : transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities = .ok (.transferred S' D' allocations)) :
    allocateLots S lots requestedQuantity selection derivation allocationIdentities =
      .ok (.allocated allocations S') := by
  obtain ⟨source, policy, front, halloc, -⟩ := Lots.transferLots_transferred_inv h
  exact halloc

namespace Lots

/-- Lot by lot (`w` weighs each lot; take it 1 on one lot and 0 elsewhere), what the source and
destination holdings hold afterwards of quantity, of basis, of valuation allowance and of carrying
amount is, together, exactly what they held before. -/
theorem transferLots_conserves_by_lot_aux {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {S' D' : List LotHolding}
    {allocations : List LotAllocation}
    (hS : ∀ holding ∈ S, holding.WF) (hD : ∀ holding ∈ D, holding.WF)
    (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities = .ok (.transferred S' D' allocations))
    (w : LotId → ℚ) :
    (S'.map fun x => w x.lotId * x.remainingQuantity.toRat).sum +
        (D'.map fun x => w x.lotId * x.remainingQuantity.toRat).sum =
      (S.map fun x => w x.lotId * x.remainingQuantity.toRat).sum +
        (D.map fun x => w x.lotId * x.remainingQuantity.toRat).sum ∧
    (S'.map fun x => w x.lotId * x.remainingTotalBasis.toRat).sum +
        (D'.map fun x => w x.lotId * x.remainingTotalBasis.toRat).sum =
      (S.map fun x => w x.lotId * x.remainingTotalBasis.toRat).sum +
        (D.map fun x => w x.lotId * x.remainingTotalBasis.toRat).sum ∧
    (S'.map fun x => w x.lotId * x.remainingValuationAllowance.toRat).sum +
        (D'.map fun x => w x.lotId * x.remainingValuationAllowance.toRat).sum =
      (S.map fun x => w x.lotId * x.remainingValuationAllowance.toRat).sum +
        (D.map fun x => w x.lotId * x.remainingValuationAllowance.toRat).sum ∧
    (S'.map fun x => w x.lotId * x.remainingCarryingAmount.toRat).sum +
        (D'.map fun x => w x.lotId * x.remainingCarryingAmount.toRat).sum =
      (S.map fun x => w x.lotId * x.remainingCarryingAmount.toRat).sum +
        (D.map fun x => w x.lotId * x.remainingCarryingAmount.toRat).sum := by
  obtain ⟨source, policy, front, halloc, hin, hfree, harr⟩ := transferLots_transferred_inv h
  obtain ⟨hwa, hsrc⟩ := allocateLots_allocations_lots hS hr hs halloc
  have hsrc' : ∀ a ∈ allocations, ∀ s,
      S.find? (fun holding => holding.id == a.holdingId) = some s → s.lotId = a.lotId := by
    intro a ha s hs'
    obtain ⟨s2, hs2, hl⟩ := hsrc a ha
    rw [hs2] at hs'
    cases hs'
    exact hl
  obtain ⟨q1, b1, v1, c1⟩ := allocateLots_conserves_by_lot hS hr hs halloc w
  obtain ⟨q2, b2, v2, c2⟩ := arriveLoop_sums w harr hD hwa hsrc'
  refine ⟨?_, ?_, ?_, ?_⟩ <;> linarith

end Lots

/-- Lot by lot: the quantity, the basis, the valuation allowance and the carrying amount that the
source and destination holdings hold together are the same after a transfer as before. -/
theorem transferLots_conserves_by_lot {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {S' D' : List LotHolding}
    {allocations : List LotAllocation}
    (hS : ∀ holding ∈ S, holding.WF) (hD : ∀ holding ∈ D, holding.WF)
    (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities = .ok (.transferred S' D' allocations))
    (w : LotId → ℚ) :
    (S'.map fun x => w x.lotId * x.remainingQuantity.toRat).sum +
        (D'.map fun x => w x.lotId * x.remainingQuantity.toRat).sum =
      (S.map fun x => w x.lotId * x.remainingQuantity.toRat).sum +
        (D.map fun x => w x.lotId * x.remainingQuantity.toRat).sum ∧
    (S'.map fun x => w x.lotId * x.remainingTotalBasis.toRat).sum +
        (D'.map fun x => w x.lotId * x.remainingTotalBasis.toRat).sum =
      (S.map fun x => w x.lotId * x.remainingTotalBasis.toRat).sum +
        (D.map fun x => w x.lotId * x.remainingTotalBasis.toRat).sum ∧
    (S'.map fun x => w x.lotId * x.remainingValuationAllowance.toRat).sum +
        (D'.map fun x => w x.lotId * x.remainingValuationAllowance.toRat).sum =
      (S.map fun x => w x.lotId * x.remainingValuationAllowance.toRat).sum +
        (D.map fun x => w x.lotId * x.remainingValuationAllowance.toRat).sum ∧
    (S'.map fun x => w x.lotId * x.remainingCarryingAmount.toRat).sum +
        (D'.map fun x => w x.lotId * x.remainingCarryingAmount.toRat).sum =
      (S.map fun x => w x.lotId * x.remainingCarryingAmount.toRat).sum +
        (D.map fun x => w x.lotId * x.remainingCarryingAmount.toRat).sum :=
  Lots.transferLots_conserves_by_lot_aux hS hD hr hs h w

/-- The total quantity of the source and destination holdings is the same after a transfer as
before, exactly. -/
theorem transferLots_quantity_conserved {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {S' D' : List LotHolding}
    {allocations : List LotAllocation}
    (hS : ∀ holding ∈ S, holding.WF) (hD : ∀ holding ∈ D, holding.WF)
    (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities = .ok (.transferred S' D' allocations)) :
    (S'.map (·.remainingQuantity.toRat)).sum + (D'.map (·.remainingQuantity.toRat)).sum =
      (S.map (·.remainingQuantity.toRat)).sum + (D.map (·.remainingQuantity.toRat)).sum := by
  have := (transferLots_conserves_by_lot hS hD hr hs h (fun _ => 1)).1
  simpa only [one_mul] using this

/-- The total cost basis of the source and destination holdings is the same after a transfer as
before, exactly. -/
theorem transferLots_basis_conserved {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {S' D' : List LotHolding}
    {allocations : List LotAllocation}
    (hS : ∀ holding ∈ S, holding.WF) (hD : ∀ holding ∈ D, holding.WF)
    (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities = .ok (.transferred S' D' allocations)) :
    (S'.map (·.remainingTotalBasis.toRat)).sum + (D'.map (·.remainingTotalBasis.toRat)).sum =
      (S.map (·.remainingTotalBasis.toRat)).sum + (D.map (·.remainingTotalBasis.toRat)).sum := by
  have := (transferLots_conserves_by_lot hS hD hr hs h (fun _ => 1)).2.1
  simpa only [one_mul] using this

/-- The total valuation allowance of the source and destination holdings is the same after a
transfer as before, exactly. -/
theorem transferLots_valuationAllowance_conserved {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {S' D' : List LotHolding}
    {allocations : List LotAllocation}
    (hS : ∀ holding ∈ S, holding.WF) (hD : ∀ holding ∈ D, holding.WF)
    (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities = .ok (.transferred S' D' allocations)) :
    (S'.map (·.remainingValuationAllowance.toRat)).sum +
        (D'.map (·.remainingValuationAllowance.toRat)).sum =
      (S.map (·.remainingValuationAllowance.toRat)).sum +
        (D.map (·.remainingValuationAllowance.toRat)).sum := by
  have := (transferLots_conserves_by_lot hS hD hr hs h (fun _ => 1)).2.2.1
  simpa only [one_mul] using this

/-- The total carrying amount of the source and destination holdings is the same after a transfer
as before, exactly. -/
theorem transferLots_carryingAmount_conserved {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {S' D' : List LotHolding}
    {allocations : List LotAllocation}
    (hS : ∀ holding ∈ S, holding.WF) (hD : ∀ holding ∈ D, holding.WF)
    (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities = .ok (.transferred S' D' allocations)) :
    (S'.map (·.remainingCarryingAmount.toRat)).sum +
        (D'.map (·.remainingCarryingAmount.toRat)).sum =
      (S.map (·.remainingCarryingAmount.toRat)).sum +
        (D.map (·.remainingCarryingAmount.toRat)).sum := by
  have := (transferLots_conserves_by_lot hS hD hr hs h (fun _ => 1)).2.2.2
  simpa only [one_mul] using this

/-! ## Laws of `transferLots`: the acquisition identity that arrives -/

/-- A transfer happens only under the one policy that applies, and only when that policy asks for
continuity: the policy is for the book of the source holdings, for their account and for the
destination account, and the accounts differ. -/
theorem transferLots_policy {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {S' D' : List LotHolding}
    {allocations : List LotAllocation}
    (h : transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities = .ok (.transferred S' D' allocations)) :
    ∃ source policy, S.head? = some source ∧
      (∀ holding ∈ S, holding.bookId = source.bookId ∧ holding.accountId = source.accountId) ∧
      Lots.applicableTransferPolicies policies source da governedAt = [policy] ∧
      policy ∈ policies ∧ policy.treatment = .continuity ∧
      policy.bookId = source.bookId ∧ policy.sourceAccountId = source.accountId ∧
      policy.destinationAccountId = da ∧ source.accountId ≠ da := by
  obtain ⟨source, policy, front, -⟩ := Lots.transferLots_transferred_inv h
  have hmem : policy ∈ Lots.applicableTransferPolicies policies source da governedAt := by
    rw [front.governing]; exact List.mem_singleton_self policy
  have hmem' := List.mem_filter.mp hmem
  obtain ⟨h1, h2, h3, -⟩ := (Lots.policyApplies_iff source da governedAt policy).mp hmem'.2
  exact ⟨source, policy, front.head, front.oneScope, front.governing, hmem'.1, front.continuity,
    h1, h2, h3, front.distinct⟩

/-- A policy that asks for disposal and reacquisition moves nothing: the call answers with the
policy exactly when the source holdings are of one book and account and the one policy that applies
asks for it. -/
theorem transferLots_disposal_iff {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {policy : TransferPolicy} :
    transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities =
        .ok (.requiresDisposalAndReacquisition policy) ↔
      ∃ source, S.head? = some source ∧
        (∀ holding ∈ S, holding.bookId = source.bookId ∧ holding.accountId = source.accountId) ∧
        Lots.applicableTransferPolicies policies source da governedAt = [policy] ∧
        policy.treatment = .disposalAndReacquisition := by
  rw [Lots.transferLots_eq_iff]
  unfold Lots.TransferExit
  constructor
  · rintro (⟨-, hr⟩ | ⟨-, -, -, hr⟩ | ⟨src, -, -, -, hr⟩ | ⟨source, pol, hhead, hscope, hgov, htreat, hr⟩ |
      ⟨-, -, -, -, -, -, -, hr⟩ | ⟨-, -, err, -, -, hr⟩ | ⟨-, -, ds, -, -, hr⟩ |
      ⟨-, -, -, -, -, -, -, hr⟩ | ⟨-, -, -, -, -, -, -, -, hr⟩ |
      ⟨-, -, -, -, err, -, -, -, -, -, hr⟩ | ⟨-, -, -, -, ds, -, -, -, -, -, hr⟩ |
      ⟨-, -, al, ho, de, -, -, -, -, -, hr⟩)
    all_goals try (exfalso; simp at hr; done)
    simp only [Except.ok.injEq, LotTransferResult.requiresDisposalAndReacquisition.injEq] at hr
    subst hr
    exact ⟨source, hhead, hscope, hgov, htreat⟩
  · rintro ⟨source, hhead, hscope, hgov, htreat⟩
    exact Or.inr (Or.inr (Or.inr (Or.inl ⟨source, policy, hhead, hscope, hgov, htreat, rfl⟩)))

namespace Lots

/-- What is known of a call that returned a transfer, with the allocations made constructible: the
checks it passed, the allocations are of constructible numbers, and each names the source holding
that has its identifier, which is of the allocation's lot. -/
theorem transferLots_facts {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {S' D' : List LotHolding}
    {allocations : List LotAllocation}
    (hS : ∀ holding ∈ S, holding.WF) (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities = .ok (.transferred S' D' allocations)) :
    ∃ source policy, Front S policies governedAt da source policy ∧
      allocateLots S lots requestedQuantity selection derivation allocationIdentities =
        .ok (.allocated allocations S') ∧
      (∀ holding ∈ D, DestinationInScope source da holding) ∧ DestinationIdsFree S D ∧
      arriveLoop S da destinationIdentities allocations D = .ok (.finished D') ∧
      (∀ a ∈ allocations, a.WF) ∧
      (∀ a ∈ allocations, ∃ s, S.find? (fun holding => holding.id == a.holdingId) = some s ∧
        s.lotId = a.lotId) ∧
      (∀ a ∈ allocations, ∀ s, S.find? (fun holding => holding.id == a.holdingId) = some s →
        s.lotId = a.lotId) := by
  obtain ⟨source, policy, front, halloc, hin, hfree, harr⟩ := transferLots_transferred_inv h
  obtain ⟨hwa, hsrc⟩ := allocateLots_allocations_lots hS hr hs halloc
  refine ⟨source, policy, front, halloc, hin, hfree, harr, hwa, hsrc, ?_⟩
  intro a ha s hs'
  obtain ⟨s2, hs2, hl⟩ := hsrc a ha
  rw [hs2] at hs'
  cases hs'
  exact hl

end Lots

/-- No holding at the destination is lost or changed into another, and the holdings the transfer
founds come after them: each is founded for one allocation, under the first identifier supplied for
the allocation's source holding, and is of that source holding's book, lot, commodity and basis
commodity, in the destination account. -/
theorem transferLots_destination_kept {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {S' D' : List LotHolding}
    {allocations : List LotAllocation}
    (hS : ∀ holding ∈ S, holding.WF) (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities = .ok (.transferred S' D' allocations)) :
    ∃ news : List LotHolding,
      D'.map LotHolding.identity = D.map LotHolding.identity ++ news.map LotHolding.identity ∧
      ∀ n ∈ news, ∃ a ∈ allocations, ∃ s ∈ S, ∃ identity ∈ destinationIdentities,
        s.id = a.holdingId ∧ identity.sourceHoldingId = s.id ∧
        n.id = identity.destinationHoldingId ∧ n.bookId = s.bookId ∧ n.lotId = a.lotId ∧
        n.accountId = da ∧ n.commodityId = s.commodityId ∧
        n.basisCommodityId = s.basisCommodityId := by
  obtain ⟨source, policy, front, halloc, hin, hfree, harr, hwa, hsrc, hsrc'⟩ :=
    Lots.transferLots_facts hS hr hs h
  obtain ⟨news, hlay, hnew⟩ := Lots.arriveLoop_layout allocations D D' harr
  refine ⟨news, hlay, ?_⟩
  intro n hn
  obtain ⟨a, ha, s, identity, hfs, hfi, rfl, -⟩ := hnew n hn
  have hsid : s.id = a.holdingId := by simpa using List.find?_some hfs
  have hiid : identity.sourceHoldingId = s.id := by simpa using List.find?_some hfi
  exact ⟨a, ha, s, List.mem_of_find?_eq_some hfs, identity, List.mem_of_find?_eq_some hfi,
    hsid, hiid, rfl, rfl, hsrc' a ha s hfs, rfl, rfl, rfl⟩

/-- Every holding the destination had is still there as the same holding, and every lot that was
allocated is held at the destination, in the destination account: the destination holding that
receives an allocation is of the allocation's lot. -/
theorem transferLots_destination_lots {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {S' D' : List LotHolding}
    {allocations : List LotAllocation}
    (hS : ∀ holding ∈ S, holding.WF) (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities = .ok (.transferred S' D' allocations)) :
    (∀ x ∈ D, ∃ y ∈ D', y.identity = x.identity) ∧
    ∀ a ∈ allocations, ∃ y ∈ D', y.lotId = a.lotId ∧ y.accountId = da := by
  obtain ⟨source, policy, front, halloc, hin, hfree, harr, hwa, hsrc, hsrc'⟩ :=
    Lots.transferLots_facts hS hr hs h
  exact Lots.arriveLoop_covers allocations D D' harr hsrc'

/-- The holdings at the destination whose lots no allocation carries are exactly as they were, in
the same order, and the transfer adds none of them. -/
theorem transferLots_destination_untouched {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {S' D' : List LotHolding}
    {allocations : List LotAllocation}
    (hS : ∀ holding ∈ S, holding.WF) (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities = .ok (.transferred S' D' allocations)) :
    D'.filter (fun x => decide (x.lotId ∉ allocations.map (·.lotId))) =
      D.filter (fun x => decide (x.lotId ∉ allocations.map (·.lotId))) := by
  obtain ⟨source, policy, front, halloc, hin, hfree, harr, hwa, hsrc, hsrc'⟩ :=
    Lots.transferLots_facts hS hr hs h
  exact Lots.arriveLoop_unchanged allocations D D' harr hsrc' _
    (fun a ha => List.mem_map_of_mem (f := (·.lotId)) ha)

/-- After a transfer no two holdings at the destination share an identifier, and none shares one
with a source holding. -/
theorem transferLots_destination_identifiers {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {S' D' : List LotHolding}
    {allocations : List LotAllocation}
    (hS : ∀ holding ∈ S, holding.WF) (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities = .ok (.transferred S' D' allocations)) :
    (D'.map (·.id)).Nodup ∧ ∀ x ∈ D', ∀ s ∈ S, x.id ≠ s.id := by
  obtain ⟨source, policy, front, halloc, hin, hfree, harr, hwa, hsrc, hsrc'⟩ :=
    Lots.transferLots_facts hS hr hs h
  exact Lots.arriveLoop_ids allocations D D' harr hfree.1
    (fun x hx s hs' => (hfree.2 x hx s hs').symm)

/-- The source holdings after a transfer are the source holdings given, one for one and in the same
order: one that no allocation names is as it was, and one that an allocation names has exactly what
that allocation took removed from it. -/
theorem transferLots_source_holdings {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {S' D' : List LotHolding}
    {allocations : List LotAllocation}
    (hS : ∀ holding ∈ S, holding.WF) (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities = .ok (.transferred S' D' allocations)) :
    List.Forall₂ (fun before left =>
      (left = before ∧ ∀ allocation ∈ allocations, allocation.holdingId ≠ before.id) ∨
      (∃ allocation ∈ allocations, Lots.Took before allocation left)) S S' :=
  allocateLots_holdings hS hr hs (transferLots_allocations h)

/-! ## Laws of `transferLots`: the diagnostics of the allocation, told apart from the transfer's own -/

namespace Lots

/-- The paths that a diagnostic of `allocateLots` has. -/
def AllocatePath (path : String) : Prop :=
  path = "requestedQuantity" ∨ path = "lots" ∨ path = "selection.allocations" ∨
    path = "holdings" ∨ path = "identities" ∨ path = "allocations" ∨
    ∃ i : Nat, path = s!"holdings[{i}]" ∨ path = s!"holdings[{i}].id" ∨
      path = s!"holdings[{i}].remainingCarryingAmount"

/-- What a diagnostic of `allocateLots` looks like: one of two codes, and one of the paths. -/
def AllocateDiagnostic (d : SemanticDiagnostic) : Prop :=
  (d.code = .lot_overallocation ∨ d.code = .canonical_identity_conflict) ∧ AllocatePath d.path

/-- A text that opens with `holdings[` starts with an `h`. -/
theorem holdings_head (x y : String) : ("holdings[" ++ x ++ y).toList.head? = some 'h' := by
  simp only [String.toList_append]
  have : "holdings[".toList = ['h', 'o', 'l', 'd', 'i', 'n', 'g', 's', '['] := by decide
  rw [this]
  rfl

/-- A text that does not start with an `h` and is none of the literal paths is not a path of
`allocateLots`. -/
theorem not_allocatePath_of (p : String) (hp : p.toList.head? ≠ some 'h')
    (h1 : p ≠ "requestedQuantity") (h2 : p ≠ "lots") (h3 : p ≠ "selection.allocations")
    (h4 : p ≠ "holdings") (h5 : p ≠ "identities") (h6 : p ≠ "allocations") : ¬ AllocatePath p := by
  rintro (h | h | h | h | h | h | ⟨i, h | h | h⟩)
  · exact h1 h
  · exact h2 h
  · exact h3 h
  · exact h4 h
  · exact h5 h
  · exact h6 h
  all_goals
    apply hp
    rw [h]
    simp only [toString]
    exact holdings_head _ _

/-- `sourceHoldings` is not a path of `allocateLots`. -/
theorem sourceHoldings_not_allocate : ¬ AllocatePath "sourceHoldings" :=
  not_allocatePath_of _ (by decide) (by decide) (by decide) (by decide) (by decide) (by decide)
    (by decide)

/-- `destinationAccountId` is not a path of `allocateLots`. -/
theorem destinationAccountId_not_allocate : ¬ AllocatePath "destinationAccountId" :=
  not_allocatePath_of _ (by decide) (by decide) (by decide) (by decide) (by decide) (by decide)
    (by decide)

/-- `destinationHoldings` is not a path of `allocateLots`. -/
theorem destinationHoldings_not_allocate : ¬ AllocatePath "destinationHoldings" :=
  not_allocatePath_of _ (by decide) (by decide) (by decide) (by decide) (by decide) (by decide)
    (by decide)

/-- `destinationIdentities` is not a path of `allocateLots`. -/
theorem destinationIdentities_not_allocate : ¬ AllocatePath "destinationIdentities" :=
  not_allocatePath_of _ (by decide) (by decide) (by decide) (by decide) (by decide) (by decide)
    (by decide)

/-- The diagnostics of one holding. -/
theorem validateHolding_diagnostics {index : Nat} {seen : List LotHoldingId}
    {holding : LotHolding} {diagnostics : List SemanticDiagnostic}
    (h : validateHolding index seen holding = .ok diagnostics) :
    ∀ d ∈ diagnostics, (d.code = .lot_overallocation ∨ d.code = .canonical_identity_conflict) ∧
      (d.path = s!"holdings[{index}]" ∨ d.path = s!"holdings[{index}].id" ∨
        d.path = s!"holdings[{index}].remainingCarryingAmount") := by
  unfold validateHolding at h
  cases ha : holding.remainingTotalBasis.add holding.remainingValuationAllowance with
  | error e => simp [ha] at h
  | ok carrying =>
    simp only [ha, Except.ok.injEq] at h
    subst h
    intro d hd
    simp only [List.mem_append] at hd
    rcases hd with ((hd | hd) | hd) | hd <;> split at hd <;>
      first
        | (simp at hd; done)
        | (simp only [List.mem_singleton] at hd; subst hd; simp [diagnostic])

/-- The diagnostics of `validateHoldings`, from any position. -/
theorem validateHoldingsFrom_diagnostics : ∀ (holdings : List LotHolding) (index : Nat)
    (seen : List LotHoldingId) (diagnostics : List SemanticDiagnostic),
    validateHoldingsFrom index seen holdings = .ok diagnostics →
      ∀ d ∈ diagnostics, AllocateDiagnostic d := by
  intro holdings
  induction holdings with
  | nil =>
    intro index seen diagnostics h d hd
    simp only [validateHoldingsFrom, Except.ok.injEq] at h
    subst h
    simp at hd
  | cons holding rest ih =>
    intro index seen diagnostics h d hd
    rw [validateHoldingsFrom] at h
    cases hv : validateHolding index seen holding with
    | error e => simp [hv] at h
    | ok here =>
      simp only [hv] at h
      cases hr : validateHoldingsFrom (index + 1) (holding.id :: seen) rest with
      | error e => simp [hr] at h
      | ok later =>
        simp only [hr, Except.ok.injEq] at h
        subst h
        rcases List.mem_append.mp hd with hd | hd
        · obtain ⟨hc, hp⟩ := validateHolding_diagnostics hv d hd
          exact ⟨hc, Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr ⟨index, hp⟩)))))⟩
        · exact ih (index + 1) (holding.id :: seen) later hr d hd

/-- A rejection by `allocateLots` carries only diagnostics of the kinds `AllocateDiagnostic`
describes. -/
theorem allocateLots_rejected_diagnostics {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection} {derivation : DerivationRecord}
    {identities : List LotAllocationIdentity} {ds : List SemanticDiagnostic}
    (h : allocateLots holdings lots requestedQuantity selection derivation identities =
      .ok (.rejected ds)) : ∀ d ∈ ds, AllocateDiagnostic d := by
  have hreject : ∀ (message path : String), (path = "requestedQuantity" ∨ path = "lots" ∨
      path = "selection.allocations" ∨ path = "holdings" ∨ path = "identities" ∨
      path = "allocations") → ∀ d ∈ [diagnostic .lot_overallocation path message
        ["ACC-008", "ACC-009", "ACC-023"]], AllocateDiagnostic d := by
    intro message path hp d hd
    simp only [List.mem_singleton] at hd
    subst hd
    refine ⟨Or.inl rfl, ?_⟩
    rcases hp with hp | hp | hp | hp | hp | hp
    · exact Or.inl hp
    · exact Or.inr (Or.inl hp)
    · exact Or.inr (Or.inr (Or.inl hp))
    · exact Or.inr (Or.inr (Or.inr (Or.inl hp)))
    · exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inl hp))))
    · exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inl hp)))))
  unfold allocateLots at h
  cases hv : validateHoldings holdings with
  | error e => simp [hv] at h
  | ok initialDiagnostics =>
  simp only [hv] at h
  by_cases hlen : initialDiagnostics.length > 0
  · simp only [hlen, ↓reduceIte, Except.ok.injEq, LotAllocationResult.rejected.injEq] at h
    subst h
    exact validateHoldingsFrom_diagnostics holdings 0 [] _ hv
  simp only [hlen, ↓reduceIte] at h
  by_cases hreq : (requestedQuantity.isZero || requestedQuantity.isNegative) = true
  · simp [hreq, reject] at h
    subst h
    exact hreject _ _ (Or.inl rfl)
  simp only [hreq, Bool.false_eq_true, ↓reduceIte] at h
  by_cases hlots : setSize (lots.map (·.id)) ≠ lots.length
  · simp [hlots] at h
    subst h
    intro d hd
    simp only [List.mem_singleton] at hd
    subst hd
    exact ⟨Or.inr rfl, Or.inr (Or.inl rfl)⟩
  simp only [hlots, ↓reduceIte] at h
  cases hsel : selectCandidates holdings lots requestedQuantity selection with
  | error e => simp [hsel] at h
  | ok selected =>
  cases selected with
  | rejected result =>
    simp only [hsel, Except.ok.injEq] at h
    obtain ⟨⟨message, hm⟩, -⟩ := selectCandidates_rejected hsel
    rw [hm] at h
    simp only [reject, LotAllocationResult.rejected.injEq] at h
    subst h
    exact hreject _ _ (Or.inr (Or.inr (Or.inl rfl)))
  | candidates candidates specificQuantities =>
  simp only [hsel] at h
  by_cases hun : candidates.any (lotUnresolved lots) = true
  · simp [hun, reject] at h
    subst h
    exact hreject _ _ (Or.inr (Or.inr (Or.inr (Or.inl rfl))))
  simp only [hun, Bool.false_eq_true, ↓reduceIte] at h
  by_cases hmix : (match candidates.head? with
      | some first => candidates.any (mixesScope first)
      | none => false) = true
  · simp [hmix, reject] at h
    subst h
    exact hreject _ _ (Or.inr (Or.inr (Or.inr (Or.inl rfl))))
  simp only [hmix, Bool.false_eq_true, ↓reduceIte] at h
  cases hwa : weightedAvailable selection.method candidates with
  | error e => simp [hwa] at h
  | ok available =>
  simp only [hwa] at h
  cases hloop : allocateLoop
      (loopInputs requestedQuantity selection derivation identities specificQuantities available)
      candidates (startState requestedQuantity) with
  | error e =>
    simp only [loopInputs, startState] at hloop
    simp [hloop] at h
  | ok looped =>
  have hloop' := hloop
  simp only [loopInputs, startState] at hloop
  cases looped with
  | rejected result =>
    simp only [hloop, Except.ok.injEq] at h
    subst h
    rcases allocateLoop_rejected _ _ _ hloop' with hr | hr | ⟨allocationId, hr⟩
    · simp only [reject, LotAllocationResult.rejected.injEq] at hr
      subst hr
      exact hreject _ _ (Or.inr (Or.inr (Or.inl rfl)))
    · simp only [reject, LotAllocationResult.rejected.injEq] at hr
      subst hr
      exact hreject _ _ (Or.inr (Or.inr (Or.inr (Or.inr (Or.inl rfl)))))
    · simp only [LotAllocationResult.rejected.injEq] at hr
      subst hr
      intro d hd
      simp only [List.mem_singleton] at hd
      subst hd
      exact ⟨Or.inr rfl, Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inl rfl)))))⟩
  | finished final =>
  simp only [hloop] at h
  by_cases hrem : (!final.remaining.isZero) = true
  · simp [hrem, reject] at h
    subst h
    exact hreject _ _ (Or.inr (Or.inl rfl))
  · simp [hrem] at h

end Lots

/-! ## Laws of `transferLots`: why a call rejects -/

namespace Lots

/-- Every rejection by `transferLots` is for one of nine reasons, each with the exact conditions
that lead to it and the diagnostics it gives: there is no source holding; the source holdings are
of more than one book or account; the number of policies that apply is not one; a continuity
transfer is between one account and itself; `allocateLots` rejects, and its diagnostics are the
ones returned; a destination holding is of another book, account, commodity or basis commodity;
destination identifiers are repeated or a source holding has one; or the loop over the allocations
reaches an allocation whose lot is not yet held at the destination and for which no identity was
supplied, or for which the identity supplied is already in use. -/
theorem transferLots_rejected_cases {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {ds : List SemanticDiagnostic}
    (h : transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities = .ok (.rejected ds)) :
    (S = [] ∧ ds = [noSourceDiagnostic]) ∨
    (∃ source, S.head? = some source ∧
      (∃ holding ∈ S, holding.bookId ≠ source.bookId ∨ holding.accountId ≠ source.accountId) ∧
      ds = [mixedSourceDiagnostic]) ∨
    (∃ source, S.head? = some source ∧
      (∀ holding ∈ S, holding.bookId = source.bookId ∧ holding.accountId = source.accountId) ∧
      (∀ policy, applicableTransferPolicies policies source da governedAt ≠ [policy]) ∧
      ds = [transferPolicyCountDiagnostic (applicableTransferPolicies policies source da governedAt).length]) ∨
    (∃ source policy, S.head? = some source ∧
      (∀ holding ∈ S, holding.bookId = source.bookId ∧ holding.accountId = source.accountId) ∧
      applicableTransferPolicies policies source da governedAt = [policy] ∧
      policy.treatment = .continuity ∧ source.accountId = da ∧ ds = [sameAccountDiagnostic]) ∨
    (∃ source policy, Front S policies governedAt da source policy ∧
      allocateLots S lots requestedQuantity selection derivation allocationIdentities =
        .ok (.rejected ds)) ∨
    (∃ source policy allocations holdings, Front S policies governedAt da source policy ∧
      allocateLots S lots requestedQuantity selection derivation allocationIdentities =
        .ok (.allocated allocations holdings) ∧
      (∃ holding ∈ D, ¬ DestinationInScope source da holding) ∧
      ds = [destinationScopeDiagnostic]) ∨
    (∃ source policy allocations holdings, Front S policies governedAt da source policy ∧
      allocateLots S lots requestedQuantity selection derivation allocationIdentities =
        .ok (.allocated allocations holdings) ∧
      (∀ holding ∈ D, DestinationInScope source da holding) ∧ ¬ DestinationIdsFree S D ∧
      ds = [destinationDuplicateDiagnostic]) ∨
    (∃ source policy allocations holdings, Front S policies governedAt da source policy ∧
      allocateLots S lots requestedQuantity selection derivation allocationIdentities =
        .ok (.allocated allocations holdings) ∧
      (∀ holding ∈ D, DestinationInScope source da holding) ∧ DestinationIdsFree S D ∧
      ∃ done a rest D1 s, allocations = done ++ a :: rest ∧
        arriveLoop S da destinationIdentities done D = .ok (.finished D1) ∧
        S.find? (fun holding => holding.id == a.holdingId) = some s ∧
        (∀ x ∈ D1, ¬ (x.lotId = s.lotId ∧ x.accountId = da)) ∧
        destinationIdentities.find? (fun identity => identity.sourceHoldingId == s.id) = none ∧
        ds = [missingIdentityDiagnostic]) ∨
    (∃ source policy allocations holdings, Front S policies governedAt da source policy ∧
      allocateLots S lots requestedQuantity selection derivation allocationIdentities =
        .ok (.allocated allocations holdings) ∧
      (∀ holding ∈ D, DestinationInScope source da holding) ∧ DestinationIdsFree S D ∧
      ∃ done a rest D1 s identity, allocations = done ++ a :: rest ∧
        arriveLoop S da destinationIdentities done D = .ok (.finished D1) ∧
        S.find? (fun holding => holding.id == a.holdingId) = some s ∧
        (∀ x ∈ D1, ¬ (x.lotId = s.lotId ∧ x.accountId = da)) ∧
        destinationIdentities.find? (fun identity => identity.sourceHoldingId == s.id) =
          some identity ∧
        ((∃ x ∈ D1, x.id = identity.destinationHoldingId) ∨
          ∃ x ∈ S, x.id = identity.destinationHoldingId) ∧
        ds = [assignedIdentityDiagnostic identity.destinationHoldingId]) := by
  have hexit := (transferLots_eq_iff S D lots requestedQuantity selection policies governedAt da
    derivation allocationIdentities destinationIdentities _).mp h
  unfold TransferExit at hexit
  rcases hexit with ⟨hS, hr⟩ | ⟨source, hhead, hmix, hr⟩ | ⟨source, hhead, hscope, hpol, hr⟩ |
    ⟨-, pol, -, -, -, -, hr⟩ | ⟨source, policy, hhead, hscope, hgov, hcont, hacc, hr⟩ |
    ⟨-, -, err, -, -, hr⟩ | ⟨source, policy, diagnostics, front, hA, hr⟩ |
    ⟨source, policy, allocations, holdings, front, hA, hout, hr⟩ |
    ⟨source, policy, allocations, holdings, front, hA, hin, hdup, hr⟩ |
    ⟨-, -, -, -, err, -, -, -, -, -, hr⟩ |
    ⟨source, policy, allocations, holdings, diagnostics, front, hA, hin, hfree, hl, hr⟩ |
    ⟨-, -, al, ho, de, -, -, -, -, -, hr⟩
  · simp only [Except.ok.injEq, LotTransferResult.rejected.injEq] at hr
    exact Or.inl ⟨hS, hr⟩
  · simp only [Except.ok.injEq, LotTransferResult.rejected.injEq] at hr
    exact Or.inr (Or.inl ⟨source, hhead, hmix, hr⟩)
  · simp only [Except.ok.injEq, LotTransferResult.rejected.injEq] at hr
    exact Or.inr (Or.inr (Or.inl ⟨source, hhead, hscope, hpol, hr⟩))
  · simp at hr
  · simp only [Except.ok.injEq, LotTransferResult.rejected.injEq] at hr
    exact Or.inr (Or.inr (Or.inr (Or.inl ⟨source, policy, hhead, hscope, hgov, hcont, hacc, hr⟩)))
  · simp at hr
  · simp only [Except.ok.injEq, LotTransferResult.rejected.injEq] at hr
    rw [hr]
    exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inl ⟨source, policy, front, hA⟩))))
  · simp only [Except.ok.injEq, LotTransferResult.rejected.injEq] at hr
    exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inl
      ⟨source, policy, allocations, holdings, front, hA, hout, hr⟩)))))
  · simp only [Except.ok.injEq, LotTransferResult.rejected.injEq] at hr
    exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inl
      ⟨source, policy, allocations, holdings, front, hA, hin, hdup, hr⟩))))))
  · simp at hr
  · simp only [Except.ok.injEq, LotTransferResult.rejected.injEq] at hr
    obtain ⟨done, a, rest, D1, hall, hfin, hstep⟩ :=
      (arriveLoop_stop_iff (S := S) (da := da) (di := destinationIdentities)
        (r := .ok (.rejected diagnostics)) (by intro D'; simp) allocations D).mp hl
    obtain ⟨s, hs, hnone, hcase⟩ := arriveStep_rejected_iff.mp hstep
    rw [hr]
    rcases hcase with ⟨hf, hds⟩ | ⟨identity, hf, hused, hds⟩
    · exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inl
        ⟨source, policy, allocations, holdings, front, hA, hin, hfree, done, a, rest, D1, s,
          hall, hfin, hs, hnone, hf, hds⟩)))))))
    · exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr
        ⟨source, policy, allocations, holdings, front, hA, hin, hfree, done, a, rest, D1, s,
          identity, hall, hfin, hs, hnone, hf, hused, hds⟩)))))))
  · simp at hr

end Lots

/-! ## Laws of `transferLots`: one theorem for each diagnostic -/

namespace Lots

/-- None of the diagnostics that `transferLots` raises itself is one that `allocateLots` raises. -/
theorem own_not_allocate :
    ¬ AllocateDiagnostic noSourceDiagnostic ∧ ¬ AllocateDiagnostic mixedSourceDiagnostic ∧
    (∀ n, ¬ AllocateDiagnostic (transferPolicyCountDiagnostic n)) ∧
    ¬ AllocateDiagnostic sameAccountDiagnostic ∧ ¬ AllocateDiagnostic destinationScopeDiagnostic ∧
    ¬ AllocateDiagnostic destinationDuplicateDiagnostic ∧
    ¬ AllocateDiagnostic missingIdentityDiagnostic ∧
    (∀ identifier, ¬ AllocateDiagnostic (assignedIdentityDiagnostic identifier)) := by
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩
  · rintro ⟨-, hp⟩
    exact sourceHoldings_not_allocate hp
  · rintro ⟨hc, -⟩
    simp [mixedSourceDiagnostic, diagnostic] at hc
  · intro n
    rintro ⟨hc, -⟩
    simp [transferPolicyCountDiagnostic, diagnostic] at hc
  · rintro ⟨-, hp⟩
    exact destinationAccountId_not_allocate hp
  · rintro ⟨hc, -⟩
    simp [destinationScopeDiagnostic, diagnostic] at hc
  · rintro ⟨-, hp⟩
    exact destinationHoldings_not_allocate hp
  · rintro ⟨-, hp⟩
    exact destinationIdentities_not_allocate hp
  · intro identifier
    rintro ⟨-, hp⟩
    exact destinationHoldings_not_allocate hp

/-- A rejection by `allocateLots` that is a single one of the transfer's own diagnostics cannot
happen. -/
theorem allocate_not_own {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection} {derivation : DerivationRecord}
    {identities : List LotAllocationIdentity} {X : SemanticDiagnostic}
    (hX : ¬ AllocateDiagnostic X)
    (hA : allocateLots holdings lots requestedQuantity selection derivation identities =
      .ok (.rejected [X])) : False :=
  hX (allocateLots_rejected_diagnostics hA X (List.mem_singleton_self X))

/-- The diagnostic for a count of policies says which count. -/
theorem transferPolicyCountDiagnostic_injective {a b : Nat}
    (h : transferPolicyCountDiagnostic a = transferPolicyCountDiagnostic b) : a = b := by
  have hm := congrArg (fun d : SemanticDiagnostic => d.message) h
  simp only [transferPolicyCountDiagnostic, diagnostic, toString] at hm
  exact Nat.repr_injective ((String.append_right_inj _).mp hm)

/-- The diagnostic for an identifier already in use says which identifier. -/
theorem assignedIdentityDiagnostic_injective {a b : LotHoldingId}
    (h : assignedIdentityDiagnostic a = assignedIdentityDiagnostic b) : a = b := by
  have hm := congrArg (fun d : SemanticDiagnostic => d.message) h
  simp only [assignedIdentityDiagnostic, diagnostic, toString] at hm
  have h1 := (String.append_left_inj _).mp hm
  have h2 := (String.append_right_inj _).mp h1
  cases a
  cases b
  simp only at h2
  rw [h2]

/-- The diagnostic for an identifier already in use is not the one for repeated identifiers. -/
theorem assignedIdentityDiagnostic_ne_duplicate (identifier : LotHoldingId) :
    assignedIdentityDiagnostic identifier ≠ destinationDuplicateDiagnostic := by
  intro h
  have hm := congrArg (fun d : SemanticDiagnostic => d.message.length) h
  simp only [assignedIdentityDiagnostic, destinationDuplicateDiagnostic, diagnostic, toString,
    String.length_append] at hm
  have h1 : ("Destination holding identifier ").length = 31 := by decide
  have h2 : (" is already assigned").length = 20 := by decide
  have h3 : ("Destination holding identity is duplicated").length = 42 := by decide
  omega

end Lots

/-- A call rejects for want of a source holding exactly when none is supplied. -/
theorem transferLots_rejects_no_source {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} :
    transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities =
      .ok (.rejected [Lots.noSourceDiagnostic]) ↔
    S = [] := by
  constructor
  · intro h
    rcases Lots.transferLots_rejected_cases h with
      ⟨hS, hds⟩ | ⟨source, hhead, hmix, hds⟩ | ⟨source, hhead, hscope, hpol, hds⟩ |
      ⟨source, policy, hhead, hscope, hgov, hcont, hacc, hds⟩ | ⟨source, policy, front, hA⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hout, hds⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hin, hdup, hds⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hin, hfree, done, a, rest, D1, s, hall,
        hfin, hs, hnone, hf, hds⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hin, hfree, done, a, rest, D1, s,
        identity, hall, hfin, hs, hnone, hf, hused, hds⟩
    · exact hS
    · exfalso
      simp [Lots.noSourceDiagnostic, Lots.mixedSourceDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.noSourceDiagnostic, Lots.transferPolicyCountDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.noSourceDiagnostic, Lots.sameAccountDiagnostic, diagnostic] at hds
    · exact (Lots.allocate_not_own Lots.own_not_allocate.1 hA).elim
    · exfalso
      simp [Lots.noSourceDiagnostic, Lots.destinationScopeDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.noSourceDiagnostic, Lots.destinationDuplicateDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.noSourceDiagnostic, Lots.missingIdentityDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.noSourceDiagnostic, Lots.assignedIdentityDiagnostic, diagnostic] at hds
  · intro hS
    rw [Lots.transferLots_eq_iff]
    exact Or.inl ⟨hS, rfl⟩

/-- A call rejects source holdings of more than one book or account exactly when some source holding is of another book or account than the first. -/
theorem transferLots_rejects_mixed_source {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} :
    transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities =
      .ok (.rejected [Lots.mixedSourceDiagnostic]) ↔
    ∃ source, S.head? = some source ∧
      ∃ holding ∈ S, holding.bookId ≠ source.bookId ∨ holding.accountId ≠ source.accountId := by
  constructor
  · intro h
    rcases Lots.transferLots_rejected_cases h with
      ⟨hS, hds⟩ | ⟨source, hhead, hmix, hds⟩ | ⟨source, hhead, hscope, hpol, hds⟩ |
      ⟨source, policy, hhead, hscope, hgov, hcont, hacc, hds⟩ | ⟨source, policy, front, hA⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hout, hds⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hin, hdup, hds⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hin, hfree, done, a, rest, D1, s, hall,
        hfin, hs, hnone, hf, hds⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hin, hfree, done, a, rest, D1, s,
        identity, hall, hfin, hs, hnone, hf, hused, hds⟩
    · exfalso
      simp [Lots.mixedSourceDiagnostic, Lots.noSourceDiagnostic, diagnostic] at hds
    · exact ⟨source, hhead, hmix⟩
    · exfalso
      simp [Lots.mixedSourceDiagnostic, Lots.transferPolicyCountDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.mixedSourceDiagnostic, Lots.sameAccountDiagnostic, diagnostic] at hds
    · exact (Lots.allocate_not_own Lots.own_not_allocate.2.1 hA).elim
    · exfalso
      simp [Lots.mixedSourceDiagnostic, Lots.destinationScopeDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.mixedSourceDiagnostic, Lots.destinationDuplicateDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.mixedSourceDiagnostic, Lots.missingIdentityDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.mixedSourceDiagnostic, Lots.assignedIdentityDiagnostic, diagnostic] at hds
  · rintro ⟨source, hhead, hmix⟩
    rw [Lots.transferLots_eq_iff]
    exact Or.inr (Or.inl ⟨source, hhead, hmix, rfl⟩)

/-- A call rejects with the count of the policies that apply, and the count is not one, exactly when the source holdings are of one book and account and that many policies apply. -/
theorem transferLots_rejects_policy_count {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} (n : Nat) :
    transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities =
      .ok (.rejected [Lots.transferPolicyCountDiagnostic n]) ↔
    ∃ source, S.head? = some source ∧ (∀ holding ∈ S, holding.bookId = source.bookId ∧ holding.accountId = source.accountId) ∧
      (Lots.applicableTransferPolicies policies source da governedAt).length = n ∧ n ≠ 1 := by
  constructor
  · intro h
    rcases Lots.transferLots_rejected_cases h with
      ⟨hS, hds⟩ | ⟨source, hhead, hmix, hds⟩ | ⟨source, hhead, hscope, hpol, hds⟩ |
      ⟨source, policy, hhead, hscope, hgov, hcont, hacc, hds⟩ | ⟨source, policy, front, hA⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hout, hds⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hin, hdup, hds⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hin, hfree, done, a, rest, D1, s, hall,
        hfin, hs, hnone, hf, hds⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hin, hfree, done, a, rest, D1, s,
        identity, hall, hfin, hs, hnone, hf, hused, hds⟩
    · exfalso
      simp [Lots.transferPolicyCountDiagnostic, Lots.noSourceDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.transferPolicyCountDiagnostic, Lots.mixedSourceDiagnostic, diagnostic] at hds
    · have hn := Lots.transferPolicyCountDiagnostic_injective (List.singleton_inj.mp hds)
      refine ⟨source, hhead, hscope, hn.symm, ?_⟩
      intro hn1
      obtain ⟨p, hp⟩ := List.length_eq_one_iff.mp (hn.symm.trans hn1)
      exact hpol p hp
    · exfalso
      simp [Lots.transferPolicyCountDiagnostic, Lots.sameAccountDiagnostic, diagnostic] at hds
    · exact (Lots.allocate_not_own (Lots.own_not_allocate.2.2.1 n) hA).elim
    · exfalso
      simp [Lots.transferPolicyCountDiagnostic, Lots.destinationScopeDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.transferPolicyCountDiagnostic, Lots.destinationDuplicateDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.transferPolicyCountDiagnostic, Lots.missingIdentityDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.transferPolicyCountDiagnostic, Lots.assignedIdentityDiagnostic, diagnostic] at hds
  · rintro ⟨source, hhead, hscope, hlen, hne⟩
    rw [Lots.transferLots_eq_iff]
    refine Or.inr (Or.inr (Or.inl ⟨source, hhead, hscope, ?_, ?_⟩))
    · intro policy hp
      apply hne
      rw [← hlen, hp]
      rfl
    · rw [hlen]

/-- A continuity transfer between an account and itself is rejected exactly when the source holdings are of one book and account and the one policy that applies asks for continuity, and the destination is the source account. -/
theorem transferLots_rejects_same_account {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} :
    transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities =
      .ok (.rejected [Lots.sameAccountDiagnostic]) ↔
    ∃ source policy, S.head? = some source ∧ (∀ holding ∈ S, holding.bookId = source.bookId ∧ holding.accountId = source.accountId) ∧
      Lots.applicableTransferPolicies policies source da governedAt = [policy] ∧
      policy.treatment = .continuity ∧ source.accountId = da := by
  constructor
  · intro h
    rcases Lots.transferLots_rejected_cases h with
      ⟨hS, hds⟩ | ⟨source, hhead, hmix, hds⟩ | ⟨source, hhead, hscope, hpol, hds⟩ |
      ⟨source, policy, hhead, hscope, hgov, hcont, hacc, hds⟩ | ⟨source, policy, front, hA⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hout, hds⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hin, hdup, hds⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hin, hfree, done, a, rest, D1, s, hall,
        hfin, hs, hnone, hf, hds⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hin, hfree, done, a, rest, D1, s,
        identity, hall, hfin, hs, hnone, hf, hused, hds⟩
    · exfalso
      simp [Lots.sameAccountDiagnostic, Lots.noSourceDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.sameAccountDiagnostic, Lots.mixedSourceDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.sameAccountDiagnostic, Lots.transferPolicyCountDiagnostic, diagnostic] at hds
    · exact ⟨source, policy, hhead, hscope, hgov, hcont, hacc⟩
    · exact (Lots.allocate_not_own Lots.own_not_allocate.2.2.2.1 hA).elim
    · exfalso
      simp [Lots.sameAccountDiagnostic, Lots.destinationScopeDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.sameAccountDiagnostic, Lots.destinationDuplicateDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.sameAccountDiagnostic, Lots.missingIdentityDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.sameAccountDiagnostic, Lots.assignedIdentityDiagnostic, diagnostic] at hds
  · rintro ⟨source, policy, hhead, hscope, hgov, hcont, hacc⟩
    rw [Lots.transferLots_eq_iff]
    exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inl ⟨source, policy, hhead, hscope, hgov, hcont, hacc, rfl⟩))))

/-- A destination holding of another book, account, commodity or basis commodity is rejected exactly when the source holdings were allocated and some destination holding is not of the book, account, commodity and basis commodity of the transfer. -/
theorem transferLots_rejects_destination_scope {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} :
    transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities =
      .ok (.rejected [Lots.destinationScopeDiagnostic]) ↔
    ∃ source policy allocations holdings, Lots.Front S policies governedAt da source policy ∧
      allocateLots S lots requestedQuantity selection derivation allocationIdentities =
        .ok (.allocated allocations holdings) ∧
      ∃ holding ∈ D, ¬ Lots.DestinationInScope source da holding := by
  constructor
  · intro h
    rcases Lots.transferLots_rejected_cases h with
      ⟨hS, hds⟩ | ⟨source, hhead, hmix, hds⟩ | ⟨source, hhead, hscope, hpol, hds⟩ |
      ⟨source, policy, hhead, hscope, hgov, hcont, hacc, hds⟩ | ⟨source, policy, front, hA⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hout, hds⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hin, hdup, hds⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hin, hfree, done, a, rest, D1, s, hall,
        hfin, hs, hnone, hf, hds⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hin, hfree, done, a, rest, D1, s,
        identity, hall, hfin, hs, hnone, hf, hused, hds⟩
    · exfalso
      simp [Lots.destinationScopeDiagnostic, Lots.noSourceDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.destinationScopeDiagnostic, Lots.mixedSourceDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.destinationScopeDiagnostic, Lots.transferPolicyCountDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.destinationScopeDiagnostic, Lots.sameAccountDiagnostic, diagnostic] at hds
    · exact (Lots.allocate_not_own Lots.own_not_allocate.2.2.2.2.1 hA).elim
    · exact ⟨source, policy, allocations, holdings, front, hA, hout⟩
    · exfalso
      simp [Lots.destinationScopeDiagnostic, Lots.destinationDuplicateDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.destinationScopeDiagnostic, Lots.missingIdentityDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.destinationScopeDiagnostic, Lots.assignedIdentityDiagnostic, diagnostic] at hds
  · rintro ⟨source, policy, allocations, holdings, front, hA, hout⟩
    rw [Lots.transferLots_eq_iff]
    exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inl
      ⟨source, policy, allocations, holdings, front, hA, hout, rfl⟩)))))))

/-- Repeated destination identifiers, or one that a source holding has, are rejected exactly when the source holdings were allocated, every destination holding is in scope, and the identifiers are not free. -/
theorem transferLots_rejects_destination_duplicate {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} :
    transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities =
      .ok (.rejected [Lots.destinationDuplicateDiagnostic]) ↔
    ∃ source policy allocations holdings, Lots.Front S policies governedAt da source policy ∧
      allocateLots S lots requestedQuantity selection derivation allocationIdentities =
        .ok (.allocated allocations holdings) ∧
      (∀ holding ∈ D, Lots.DestinationInScope source da holding) ∧ ¬ Lots.DestinationIdsFree S D := by
  constructor
  · intro h
    rcases Lots.transferLots_rejected_cases h with
      ⟨hS, hds⟩ | ⟨source, hhead, hmix, hds⟩ | ⟨source, hhead, hscope, hpol, hds⟩ |
      ⟨source, policy, hhead, hscope, hgov, hcont, hacc, hds⟩ | ⟨source, policy, front, hA⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hout, hds⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hin, hdup, hds⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hin, hfree, done, a, rest, D1, s, hall,
        hfin, hs, hnone, hf, hds⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hin, hfree, done, a, rest, D1, s,
        identity, hall, hfin, hs, hnone, hf, hused, hds⟩
    · exfalso
      simp [Lots.destinationDuplicateDiagnostic, Lots.noSourceDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.destinationDuplicateDiagnostic, Lots.mixedSourceDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.destinationDuplicateDiagnostic, Lots.transferPolicyCountDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.destinationDuplicateDiagnostic, Lots.sameAccountDiagnostic, diagnostic] at hds
    · exact (Lots.allocate_not_own Lots.own_not_allocate.2.2.2.2.2.1 hA).elim
    · exfalso
      simp [Lots.destinationDuplicateDiagnostic, Lots.destinationScopeDiagnostic, diagnostic] at hds
    · exact ⟨source, policy, allocations, holdings, front, hA, hin, hdup⟩
    · exfalso
      simp [Lots.destinationDuplicateDiagnostic, Lots.missingIdentityDiagnostic, diagnostic] at hds
    · exact (Lots.assignedIdentityDiagnostic_ne_duplicate _ (List.singleton_inj.mp hds).symm).elim
  · rintro ⟨source, policy, allocations, holdings, front, hA, hin, hdup⟩
    rw [Lots.transferLots_eq_iff]
    exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inl
      ⟨source, policy, allocations, holdings, front, hA, hin, hdup, rfl⟩))))))))

/-- A new destination holding with no identity supplied is rejected exactly when the transfer passed every earlier check and the loop over the allocations reaches an allocation whose lot is not yet held at the destination and whose source holding has no identity among those supplied. -/
theorem transferLots_rejects_identity_missing {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} :
    transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities =
      .ok (.rejected [Lots.missingIdentityDiagnostic]) ↔
    ∃ source policy allocations holdings, Lots.Front S policies governedAt da source policy ∧
      allocateLots S lots requestedQuantity selection derivation allocationIdentities =
        .ok (.allocated allocations holdings) ∧
      (∀ holding ∈ D, Lots.DestinationInScope source da holding) ∧ Lots.DestinationIdsFree S D ∧
      ∃ done a rest D1 s, allocations = done ++ a :: rest ∧
        Lots.arriveLoop S da destinationIdentities done D = .ok (.finished D1) ∧
        S.find? (fun holding => holding.id == a.holdingId) = some s ∧
        (∀ x ∈ D1, ¬ (x.lotId = s.lotId ∧ x.accountId = da)) ∧
        destinationIdentities.find? (fun identity => identity.sourceHoldingId == s.id) = none := by
  constructor
  · intro h
    rcases Lots.transferLots_rejected_cases h with
      ⟨hS, hds⟩ | ⟨source, hhead, hmix, hds⟩ | ⟨source, hhead, hscope, hpol, hds⟩ |
      ⟨source, policy, hhead, hscope, hgov, hcont, hacc, hds⟩ | ⟨source, policy, front, hA⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hout, hds⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hin, hdup, hds⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hin, hfree, done, a, rest, D1, s, hall,
        hfin, hs, hnone, hf, hds⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hin, hfree, done, a, rest, D1, s,
        identity, hall, hfin, hs, hnone, hf, hused, hds⟩
    · exfalso
      simp [Lots.missingIdentityDiagnostic, Lots.noSourceDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.missingIdentityDiagnostic, Lots.mixedSourceDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.missingIdentityDiagnostic, Lots.transferPolicyCountDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.missingIdentityDiagnostic, Lots.sameAccountDiagnostic, diagnostic] at hds
    · exact (Lots.allocate_not_own Lots.own_not_allocate.2.2.2.2.2.2.1 hA).elim
    · exfalso
      simp [Lots.missingIdentityDiagnostic, Lots.destinationScopeDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.missingIdentityDiagnostic, Lots.destinationDuplicateDiagnostic, diagnostic] at hds
    · exact ⟨source, policy, allocations, holdings, front, hA, hin, hfree, done, a, rest, D1, s, hall, hfin, hs, hnone, hf⟩
    · exfalso
      simp [Lots.missingIdentityDiagnostic, Lots.assignedIdentityDiagnostic, diagnostic] at hds
  · rintro ⟨source, policy, allocations, holdings, front, hA, hin, hfree, done, a, rest, D1, s,
      hall, hfin, hs, hnone, hf⟩
    rw [Lots.transferLots_eq_iff]
    have hl : Lots.arriveLoop S da destinationIdentities allocations D =
        .ok (.rejected [Lots.missingIdentityDiagnostic]) :=
      (Lots.arriveLoop_stop_iff (by intro D'; simp) allocations D).mpr
        ⟨done, a, rest, D1, hall, hfin,
          Lots.arriveStep_rejected_iff.mpr ⟨s, hs, hnone, Or.inl ⟨hf, rfl⟩⟩⟩
    exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr
      (Or.inl ⟨source, policy, allocations, holdings, _, front, hA, hin, hfree, hl, rfl⟩))))))))))

/-- A new destination holding whose supplied identifier is already in use is rejected, naming that identifier, exactly when the transfer passed every earlier check and the loop over the allocations reaches an allocation whose lot is not yet held at the destination and whose source holding has that identifier supplied, which a destination holding reached so far, or a source holding, already has. -/
theorem transferLots_rejects_identity_assigned {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} (identifier : LotHoldingId) :
    transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities =
      .ok (.rejected [Lots.assignedIdentityDiagnostic identifier]) ↔
    ∃ source policy allocations holdings, Lots.Front S policies governedAt da source policy ∧
      allocateLots S lots requestedQuantity selection derivation allocationIdentities =
        .ok (.allocated allocations holdings) ∧
      (∀ holding ∈ D, Lots.DestinationInScope source da holding) ∧ Lots.DestinationIdsFree S D ∧
      ∃ done a rest D1 s identity, allocations = done ++ a :: rest ∧
        Lots.arriveLoop S da destinationIdentities done D = .ok (.finished D1) ∧
        S.find? (fun holding => holding.id == a.holdingId) = some s ∧
        (∀ x ∈ D1, ¬ (x.lotId = s.lotId ∧ x.accountId = da)) ∧
        destinationIdentities.find? (fun identity => identity.sourceHoldingId == s.id) =
          some identity ∧
        identity.destinationHoldingId = identifier ∧
        ((∃ x ∈ D1, x.id = identifier) ∨ ∃ x ∈ S, x.id = identifier) := by
  constructor
  · intro h
    rcases Lots.transferLots_rejected_cases h with
      ⟨hS, hds⟩ | ⟨source, hhead, hmix, hds⟩ | ⟨source, hhead, hscope, hpol, hds⟩ |
      ⟨source, policy, hhead, hscope, hgov, hcont, hacc, hds⟩ | ⟨source, policy, front, hA⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hout, hds⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hin, hdup, hds⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hin, hfree, done, a, rest, D1, s, hall,
        hfin, hs, hnone, hf, hds⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hin, hfree, done, a, rest, D1, s,
        identity, hall, hfin, hs, hnone, hf, hused, hds⟩
    · exfalso
      simp [Lots.assignedIdentityDiagnostic, Lots.noSourceDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.assignedIdentityDiagnostic, Lots.mixedSourceDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.assignedIdentityDiagnostic, Lots.transferPolicyCountDiagnostic, diagnostic] at hds
    · exfalso
      simp [Lots.assignedIdentityDiagnostic, Lots.sameAccountDiagnostic, diagnostic] at hds
    · exact (Lots.allocate_not_own (Lots.own_not_allocate.2.2.2.2.2.2.2 identifier) hA).elim
    · exfalso
      simp [Lots.assignedIdentityDiagnostic, Lots.destinationScopeDiagnostic, diagnostic] at hds
    · exact (Lots.assignedIdentityDiagnostic_ne_duplicate _ (List.singleton_inj.mp hds)).elim
    · exfalso
      simp [Lots.assignedIdentityDiagnostic, Lots.missingIdentityDiagnostic, diagnostic] at hds
    · have hid := Lots.assignedIdentityDiagnostic_injective (List.singleton_inj.mp hds)
      subst hid
      exact ⟨source, policy, allocations, holdings, front, hA, hin, hfree, done, a, rest, D1, s,
        identity, hall, hfin, hs, hnone, hf, rfl, hused⟩
  · rintro ⟨source, policy, allocations, holdings, front, hA, hin, hfree, done, a, rest, D1, s,
      identity, hall, hfin, hs, hnone, hf, hid, hused⟩
    subst hid
    rw [Lots.transferLots_eq_iff]
    have hl : Lots.arriveLoop S da destinationIdentities allocations D =
        .ok (.rejected [Lots.assignedIdentityDiagnostic identity.destinationHoldingId]) :=
      (Lots.arriveLoop_stop_iff (by intro D'; simp) allocations D).mpr
        ⟨done, a, rest, D1, hall, hfin,
          Lots.arriveStep_rejected_iff.mpr ⟨s, hs, hnone, Or.inr ⟨identity, hf, hused, rfl⟩⟩⟩
    exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr
      (Or.inl ⟨source, policy, allocations, holdings, _, front, hA, hin, hfree, hl, rfl⟩))))))))))

/-- When the source holdings pass the checks that come first, `allocateLots` rejecting is the whole
reason for the transfer to reject with the diagnostics it gave: a rejection whose diagnostics are
all of the kinds `allocateLots` raises comes from `allocateLots` exactly. -/
theorem transferLots_rejects_allocation {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {ds : List SemanticDiagnostic}
    (hds : ∀ d ∈ ds, Lots.AllocateDiagnostic d) :
    transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities = .ok (.rejected ds) ↔
    ∃ source policy, Lots.Front S policies governedAt da source policy ∧
      allocateLots S lots requestedQuantity selection derivation allocationIdentities =
        .ok (.rejected ds) := by
  constructor
  · intro h
    rcases Lots.transferLots_rejected_cases h with
      ⟨hS, he⟩ | ⟨source, hhead, hmix, he⟩ | ⟨source, hhead, hscope, hpol, he⟩ |
      ⟨source, policy, hhead, hscope, hgov, hcont, hacc, he⟩ | ⟨source, policy, front, hA⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hout, he⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hin, hdup, he⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hin, hfree, done, a, rest, D1, s, hall,
        hfin, hs, hnone, hf, he⟩ |
      ⟨source, policy, allocations, holdings, front, hA, hin, hfree, done, a, rest, D1, s,
        identity, hall, hfin, hs, hnone, hf, hused, he⟩
    · exact absurd (hds _ (by rw [he]; exact List.mem_singleton_self _))
        Lots.own_not_allocate.1
    · exact absurd (hds _ (by rw [he]; exact List.mem_singleton_self _))
        Lots.own_not_allocate.2.1
    · exact absurd (hds _ (by rw [he]; exact List.mem_singleton_self _))
        (Lots.own_not_allocate.2.2.1 _)
    · exact absurd (hds _ (by rw [he]; exact List.mem_singleton_self _))
        Lots.own_not_allocate.2.2.2.1
    · exact ⟨source, policy, front, hA⟩
    · exact absurd (hds _ (by rw [he]; exact List.mem_singleton_self _))
        Lots.own_not_allocate.2.2.2.2.1
    · exact absurd (hds _ (by rw [he]; exact List.mem_singleton_self _))
        Lots.own_not_allocate.2.2.2.2.2.1
    · exact absurd (hds _ (by rw [he]; exact List.mem_singleton_self _))
        Lots.own_not_allocate.2.2.2.2.2.2.1
    · exact absurd (hds _ (by rw [he]; exact List.mem_singleton_self _))
        (Lots.own_not_allocate.2.2.2.2.2.2.2 _)
  · rintro ⟨source, policy, front, hA⟩
    rw [Lots.transferLots_eq_iff]
    exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inl
      ⟨source, policy, ds, front, hA, rfl⟩))))))

/-- A call rejects for want of any applicable policy exactly when the source holdings are of one
book and account and no policy applies. -/
theorem transferLots_rejects_no_policy {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} :
    transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities =
        .ok (.rejected [Lots.transferPolicyCountDiagnostic 0]) ↔
    ∃ source, S.head? = some source ∧
      (∀ holding ∈ S, holding.bookId = source.bookId ∧ holding.accountId = source.accountId) ∧
      Lots.applicableTransferPolicies policies source da governedAt = [] := by
  rw [transferLots_rejects_policy_count]
  constructor
  · rintro ⟨source, hhead, hscope, hlen, -⟩
    exact ⟨source, hhead, hscope, List.length_eq_zero_iff.mp hlen⟩
  · rintro ⟨source, hhead, hscope, hnil⟩
    exact ⟨source, hhead, hscope, by rw [hnil]; rfl, by decide⟩

/-- A call rejects for ambiguity exactly when the source holdings are of one book and account and
more than one policy applies: the diagnostic is the one for a missing policy, with the count. -/
theorem transferLots_rejects_ambiguous_policy {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {n : Nat} (hn : 2 ≤ n) :
    transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities =
        .ok (.rejected [Lots.transferPolicyCountDiagnostic n]) ↔
    ∃ source, S.head? = some source ∧
      (∀ holding ∈ S, holding.bookId = source.bookId ∧ holding.accountId = source.accountId) ∧
      (Lots.applicableTransferPolicies policies source da governedAt).length = n := by
  rw [transferLots_rejects_policy_count]
  constructor
  · rintro ⟨source, hhead, hscope, hlen, -⟩
    exact ⟨source, hhead, hscope, hlen⟩
  · rintro ⟨source, hhead, hscope, hlen⟩
    exact ⟨source, hhead, hscope, hlen, by omega⟩

/-! ## Laws of `transferLots`: when it throws, and when it must transfer -/

/-- A call throws exactly when the allocation throws, which gives its code, or when the loop over
the allocations throws. -/
theorem transferLots_error_iff {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {e : LotsErr} :
    transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities = .error e ↔
    (∃ source policy code, Lots.Front S policies governedAt da source policy ∧
      allocateLots S lots requestedQuantity selection derivation allocationIdentities =
        .error code ∧ e = .exactNumber code) ∨
    (∃ source policy allocations holdings, Lots.Front S policies governedAt da source policy ∧
      allocateLots S lots requestedQuantity selection derivation allocationIdentities =
        .ok (.allocated allocations holdings) ∧
      (∀ holding ∈ D, Lots.DestinationInScope source da holding) ∧ Lots.DestinationIdsFree S D ∧
      Lots.arriveLoop S da destinationIdentities allocations D = .error e) := by
  rw [Lots.transferLots_eq_iff]
  unfold Lots.TransferExit
  constructor
  · rintro (⟨-, hr⟩ | ⟨-, -, -, hr⟩ | ⟨src, -, -, -, hr⟩ | ⟨-, pol, -, -, -, -, hr⟩ |
      ⟨-, -, -, -, -, -, -, hr⟩ | ⟨source, policy, code, front, hA, hr⟩ |
      ⟨-, -, ds, -, -, hr⟩ | ⟨-, -, -, -, -, -, -, hr⟩ | ⟨-, -, -, -, -, -, -, -, hr⟩ |
      ⟨source, policy, allocations, holdings, e', front, hA, hin, hfree, hl, hr⟩ |
      ⟨-, -, -, -, ds, -, -, -, -, -, hr⟩ | ⟨-, -, al, ho, de, -, -, -, -, -, hr⟩)
    all_goals try (exfalso; simp at hr; done)
    · simp only [Except.error.injEq] at hr
      exact Or.inl ⟨source, policy, code, front, hA, hr⟩
    · simp only [Except.error.injEq] at hr
      subst hr
      exact Or.inr ⟨source, policy, allocations, holdings, front, hA, hin, hfree, hl⟩
  · rintro (⟨source, policy, code, front, hA, he⟩ | ⟨source, policy, allocations, holdings, front,
      hA, hin, hfree, hl⟩)
    · exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inl
        ⟨source, policy, code, front, hA, by rw [he]⟩)))))
    · exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr
        (Or.inl ⟨source, policy, allocations, holdings, e, front, hA, hin, hfree, hl, rfl⟩)))))))))

namespace Lots

/-- The loop over the allocations never fails to find a source holding: every allocation names one,
so it never throws the `TypeError` of reading a missing one. -/
theorem arriveLoop_not_absent {S : List LotHolding} {da : AccountId}
    {di : List DestinationHoldingIdentity} {allocations : List LotAllocation}
    {D : List LotHolding}
    (hsrc : ∀ a ∈ allocations, ∃ s, S.find? (fun holding => holding.id == a.holdingId) = some s) :
    arriveLoop S da di allocations D ≠ .error .sourceHoldingAbsent := by
  intro hl
  obtain ⟨done, a, rest, D1, hall, -, hstep⟩ :=
    (arriveLoop_stop_iff (r := .error LotsErr.sourceHoldingAbsent) (by intro D'; simp)
      allocations D).mp hl
  rcases arriveStep_error_iff.mp hstep with ⟨hnone, -⟩ | ⟨s, existing, code, -, -, -, he⟩
  · obtain ⟨s, hs'⟩ := hsrc a (by rw [hall]; simp)
    rw [hs'] at hnone
    cases hnone
  · cases he

end Lots

/-- The `TypeError` of reading a missing source holding (`lots.ts` line 437) never happens: the
holding of every allocation is among the source holdings. -/
theorem transferLots_sourceHolding_found {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity}
    (hS : ∀ holding ∈ S, holding.WF) (hr : requestedQuantity.WF) (hs : selection.WF) :
    transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities ≠ .error .sourceHoldingAbsent := by
  intro h
  rcases transferLots_error_iff.mp h with ⟨-, -, code, -, -, he⟩ |
    ⟨source, policy, allocations, holdings, front, hA, hin, hfree, hl⟩
  · cases he
  · exact Lots.arriveLoop_not_absent
      (fun a ha => (Lots.allocateLots_allocations_lots hS hr hs hA).2 a ha |>.imp
        fun s hs' => hs'.1) hl

/-- The only error a call of `transferLots` throws is the one of the exact numbers: a number past
their size limit. -/
theorem transferLots_error_exactNumber {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {e : LotsErr}
    (hS : ∀ holding ∈ S, holding.WF) (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities = .error e) :
    ∃ code, e = .exactNumber code := by
  cases e with
  | exactNumber code => exact ⟨code, rfl⟩
  | sourceHoldingAbsent => exact absurd h (transferLots_sourceHolding_found hS hr hs)

/-- A call throws an exact-number error exactly when the allocation throws it, or when adding an
allocation to the holding at the destination that it joins goes past the size limit. -/
theorem transferLots_error_addition_iff {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {code : NumErr} :
    transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities = .error (.exactNumber code) ↔
    (∃ source policy, Lots.Front S policies governedAt da source policy ∧
      allocateLots S lots requestedQuantity selection derivation allocationIdentities =
        .error code) ∨
    (∃ source policy allocations holdings, Lots.Front S policies governedAt da source policy ∧
      allocateLots S lots requestedQuantity selection derivation allocationIdentities =
        .ok (.allocated allocations holdings) ∧
      (∀ holding ∈ D, Lots.DestinationInScope source da holding) ∧ Lots.DestinationIdsFree S D ∧
      ∃ done a rest D1 s existing, allocations = done ++ a :: rest ∧
        Lots.arriveLoop S da destinationIdentities done D = .ok (.finished D1) ∧
        S.find? (fun holding => holding.id == a.holdingId) = some s ∧
        D1.find? (fun holding => holding.lotId == s.lotId && holding.accountId == da) =
          some existing ∧ Lots.addArrival existing a = .error code) := by
  rw [transferLots_error_iff]
  constructor
  · rintro (⟨source, policy, code', front, hA, he⟩ | ⟨source, policy, allocations, holdings, front,
      hA, hin, hfree, hl⟩)
    · simp only [LotsErr.exactNumber.injEq] at he
      subst he
      exact Or.inl ⟨source, policy, front, hA⟩
    · obtain ⟨done, a, rest, D1, hall, hfin, hstep⟩ :=
        (Lots.arriveLoop_stop_iff (r := .error (LotsErr.exactNumber code)) (by intro D'; simp)
          allocations D).mp hl
      rcases Lots.arriveStep_error_iff.mp hstep with ⟨-, he⟩ | ⟨s, existing, code', hs, hex, hadd, he⟩
      · cases he
      · simp only [LotsErr.exactNumber.injEq] at he
        subst he
        exact Or.inr ⟨source, policy, allocations, holdings, front, hA, hin, hfree, done, a, rest,
          D1, s, existing, hall, hfin, hs, hex, hadd⟩
  · rintro (⟨source, policy, front, hA⟩ | ⟨source, policy, allocations, holdings, front, hA, hin,
      hfree, done, a, rest, D1, s, existing, hall, hfin, hs, hex, hadd⟩)
    · exact Or.inl ⟨source, policy, code, front, hA, rfl⟩
    · refine Or.inr ⟨source, policy, allocations, holdings, front, hA, hin, hfree, ?_⟩
      exact (Lots.arriveLoop_stop_iff (r := .error (LotsErr.exactNumber code))
        (by intro D'; simp) allocations D).mpr
        ⟨done, a, rest, D1, hall, hfin,
          Lots.arriveStep_error_iff.mpr (Or.inr ⟨s, existing, code, hs, hex, hadd, rfl⟩)⟩

/-- A call that passes every check the function makes, with the loop over the allocations
reaching no allocation it must reject, transfers, or throws an error of the exact numbers: nothing
else can happen. -/
theorem transferLots_complete {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {source : LotHolding}
    {policy : TransferPolicy} {allocations : List LotAllocation} {holdings : List LotHolding}
    (hS : ∀ holding ∈ S, holding.WF) (hr : requestedQuantity.WF) (hs : selection.WF)
    (front : Lots.Front S policies governedAt da source policy)
    (hA : allocateLots S lots requestedQuantity selection derivation allocationIdentities =
      .ok (.allocated allocations holdings))
    (hin : ∀ holding ∈ D, Lots.DestinationInScope source da holding)
    (hfree : Lots.DestinationIdsFree S D)
    (hno : ¬ ∃ done a rest D1 s, allocations = done ++ a :: rest ∧
      Lots.arriveLoop S da destinationIdentities done D = .ok (.finished D1) ∧
      S.find? (fun holding => holding.id == a.holdingId) = some s ∧
      (∀ x ∈ D1, ¬ (x.lotId = s.lotId ∧ x.accountId = da)) ∧
      (destinationIdentities.find? (fun identity => identity.sourceHoldingId == s.id) = none ∨
        ∃ identity, destinationIdentities.find?
            (fun identity => identity.sourceHoldingId == s.id) = some identity ∧
          ((∃ x ∈ D1, x.id = identity.destinationHoldingId) ∨
            ∃ x ∈ S, x.id = identity.destinationHoldingId))) :
    (∃ destination, transferLots S D lots requestedQuantity selection policies governedAt da
      derivation allocationIdentities destinationIdentities =
        .ok (.transferred holdings destination allocations)) ∨
    ∃ code, transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities = .error (.exactNumber code) := by
  cases hl : Lots.arriveLoop S da destinationIdentities allocations D with
  | error e =>
    have hsrc := (Lots.allocateLots_allocations_lots hS hr hs hA).2
    cases e with
    | exactNumber code =>
      refine Or.inr ⟨code, ?_⟩
      rw [Lots.transferLots_eq_iff]
      exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr
        (Or.inl ⟨source, policy, allocations, holdings, _, front, hA, hin, hfree, hl, rfl⟩)))))))))
    | sourceHoldingAbsent =>
      exact absurd hl (Lots.arriveLoop_not_absent
        (fun a ha => (hsrc a ha).imp fun s hs' => hs'.1))
  | ok result =>
    cases result with
    | rejected ds =>
      exfalso
      obtain ⟨done, a, rest, D1, hall, hfin, hstep⟩ :=
        (Lots.arriveLoop_stop_iff (r := .ok (.rejected ds)) (by intro D'; simp) allocations D).mp hl
      obtain ⟨s, hs', hnone, hcase⟩ := Lots.arriveStep_rejected_iff.mp hstep
      refine hno ⟨done, a, rest, D1, s, hall, hfin, hs', hnone, ?_⟩
      rcases hcase with ⟨hf, -⟩ | ⟨identity, hf, hused, -⟩
      · exact Or.inl hf
      · exact Or.inr ⟨identity, hf, hused⟩
    | finished destination =>
      refine Or.inl ⟨destination, ?_⟩
      rw [Lots.transferLots_eq_iff]
      exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr (Or.inr
        (Or.inr ⟨source, policy, allocations, holdings, destination, front, hA, hin, hfree, hl,
          rfl⟩))))))))))

/-! ## Laws of `transferLots`: what is moved, and what stays valid -/

/-- What the transfer moves, and nothing else: the source holdings lose, and the destination
holdings gain, exactly the quantity requested, and exactly the basis, the valuation allowance and
the carrying amount that the allocations carry. -/
theorem transferLots_moved {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {S' D' : List LotHolding}
    {allocations : List LotAllocation}
    (hS : ∀ holding ∈ S, holding.WF) (hD : ∀ holding ∈ D, holding.WF)
    (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities = .ok (.transferred S' D' allocations)) :
    (S'.map (·.remainingQuantity.toRat)).sum =
        (S.map (·.remainingQuantity.toRat)).sum - requestedQuantity.toRat ∧
    (D'.map (·.remainingQuantity.toRat)).sum =
        (D.map (·.remainingQuantity.toRat)).sum + requestedQuantity.toRat ∧
    (S'.map (·.remainingTotalBasis.toRat)).sum =
        (S.map (·.remainingTotalBasis.toRat)).sum -
          (allocations.map (·.allocatedTotalBasis.toRat)).sum ∧
    (D'.map (·.remainingTotalBasis.toRat)).sum =
        (D.map (·.remainingTotalBasis.toRat)).sum +
          (allocations.map (·.allocatedTotalBasis.toRat)).sum ∧
    (S'.map (·.remainingValuationAllowance.toRat)).sum =
        (S.map (·.remainingValuationAllowance.toRat)).sum -
          (allocations.map (·.allocatedValuationAllowance.toRat)).sum ∧
    (D'.map (·.remainingValuationAllowance.toRat)).sum =
        (D.map (·.remainingValuationAllowance.toRat)).sum +
          (allocations.map (·.allocatedValuationAllowance.toRat)).sum ∧
    (S'.map (·.remainingCarryingAmount.toRat)).sum =
        (S.map (·.remainingCarryingAmount.toRat)).sum -
          (allocations.map (·.allocatedCarryingAmount.toRat)).sum ∧
    (D'.map (·.remainingCarryingAmount.toRat)).sum =
        (D.map (·.remainingCarryingAmount.toRat)).sum +
          (allocations.map (·.allocatedCarryingAmount.toRat)).sum := by
  have halloc := transferLots_allocations h
  have hq := allocateLots_quantity hS hr hs halloc
  have hq' := allocateLots_total_quantity hS hr hs halloc
  have hb := allocateLots_basis_conserved hS hr hs halloc
  have hv := allocateLots_valuationAllowance_conserved hS hr hs halloc
  have hc := allocateLots_carryingAmount_conserved hS hr hs halloc
  have cq := transferLots_quantity_conserved hS hD hr hs h
  have cb := transferLots_basis_conserved hS hD hr hs h
  have cv := transferLots_valuationAllowance_conserved hS hD hr hs h
  have cc := transferLots_carryingAmount_conserved hS hD hr hs h
  refine ⟨hq', ?_, by linarith, ?_, by linarith, ?_, by linarith, ?_⟩ <;> linarith

/-- Every holding at the destination after a transfer is of constructible numbers. -/
theorem transferLots_destination_wf {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {S' D' : List LotHolding}
    {allocations : List LotAllocation}
    (hS : ∀ holding ∈ S, holding.WF) (hD : ∀ holding ∈ D, holding.WF)
    (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities = .ok (.transferred S' D' allocations)) :
    ∀ x ∈ D', x.WF := by
  obtain ⟨source, policy, front, halloc, hin, hfree, harr, hwa, hsrc, hsrc'⟩ :=
    Lots.transferLots_facts hS hr hs h
  exact Lots.arriveLoop_wf allocations D D' harr hD hwa

namespace Lots

/-- What `allocateLots` makes of every allocation it returns: it takes a positive quantity, and a
positive basis, and its carrying amount is its basis plus its valuation allowance. -/
def AllocationFits (allocation : LotAllocation) : Prop :=
  0 < allocation.allocatedQuantity.toRat ∧ 0 < allocation.allocatedTotalBasis.toRat ∧
    allocation.allocatedCarryingAmount.toRat =
      allocation.allocatedTotalBasis.toRat + allocation.allocatedValuationAllowance.toRat

/-- Every allocation that a call of `allocateLots` returns fits. -/
theorem allocateLots_allocations_fit {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection} {derivation : DerivationRecord}
    {identities : List LotAllocationIdentity} {allocations : List LotAllocation}
    {after : List LotHolding}
    (hw : ∀ holding ∈ holdings, holding.WF) (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : allocateLots holdings lots requestedQuantity selection derivation identities =
      .ok (.allocated allocations after)) :
    ∀ allocation ∈ allocations, AllocationFits allocation := by
  obtain ⟨candidates, specificQuantities, available, final, takes, run⟩ :=
    allocateLots_run hw hr hs h
  intro allocation hmem
  rw [run.allocations_eq] at hmem
  obtain ⟨t, ht, rfl⟩ := List.mem_map.mp hmem
  have k := run.trace.took t ht
  have v := run.holdings_valid _ (run.taken_mem t ht)
  have hq : 0 < t.holding.remainingQuantity.toRat := lt_of_lt_of_le k.quantity_pos k.quantity_le
  have hBpos : 0 < t.holding.remainingTotalBasis.toRat :=
    lt_of_le_of_ne v.basis_nonneg (fun h0 => ne_of_gt hq (v.depleted_iff.mpr h0.symm))
  refine ⟨k.quantity_pos, ?_, k.carryingAmount⟩
  rw [k.basis]
  have := k.quantity_pos
  positivity

/-- A turn of the loop over the allocations leaves every valid holding at the destination valid,
when the allocation fits. -/
theorem arriveStep_valid {S : List LotHolding} {da : AccountId}
    {di : List DestinationHoldingIdentity} {D : List LotHolding} {a : LotAllocation}
    {D' : List LotHolding} (h : arriveStep S da di D a = .ok (.finished D'))
    (hD : ∀ x ∈ D, x.WF) (hv : ∀ x ∈ D, x.Valid) (ha : a.WF) (hf : AllocationFits a) :
    ∀ x ∈ D', x.Valid := by
  obtain ⟨s, hs, hcase⟩ := arriveStep_finished h
  rcases hcase with ⟨pre, existing, post, replaced, hDeq, -, -, -, hadd, hD1⟩ |
    ⟨identity, -, -, -, -, hD1⟩
  · rw [hD1]
    intro x hx
    rw [hDeq] at hv hD
    simp only [List.mem_append, List.mem_cons] at hx
    rcases hx with hx | rfl | hx
    · exact hv x (by simp [hx])
    · obtain ⟨-, -, rq, rb, rv, rc⟩ := addArrival_ok (hD existing (by simp)) ha hadd
      have ve := hv existing (by simp)
      obtain ⟨hq, hb, hc⟩ := hf
      have hbq : 0 < x.remainingQuantity.toRat := by rw [rq]; linarith [ve.quantity_nonneg]
      have hbb : 0 < x.remainingTotalBasis.toRat := by rw [rb]; linarith [ve.basis_nonneg]
      exact ⟨le_of_lt hbq, le_of_lt hbb, by rw [rc, rb, rv, ve.carrying, hc]; ring,
        ⟨fun h0 => absurd h0 (ne_of_gt hbq), fun h0 => absurd h0 (ne_of_gt hbb)⟩,
        fun h0 => absurd h0 (ne_of_gt hbq), fun h0 => absurd h0 (ne_of_gt hbq)⟩
    · exact hv x (by simp [hx])
  · rw [hD1]
    intro x hx
    rcases List.mem_append.mp hx with hx | hx
    · exact hv x hx
    · rw [List.mem_singleton] at hx
      subst hx
      obtain ⟨hq, hb, hc⟩ := hf
      exact ⟨le_of_lt hq, le_of_lt hb, hc,
        ⟨fun h0 => absurd h0 (ne_of_gt hq), fun h0 => absurd h0 (ne_of_gt hb)⟩,
        fun h0 => absurd h0 (ne_of_gt hq), fun h0 => absurd h0 (ne_of_gt hq)⟩

/-- A run of the loop over the allocations that finishes leaves every holding at the destination
valid, when each holding there was valid and each allocation fits. -/
theorem arriveLoop_valid {S : List LotHolding} {da : AccountId}
    {di : List DestinationHoldingIdentity} :
    ∀ (allocs : List LotAllocation) (D D' : List LotHolding),
      arriveLoop S da di allocs D = .ok (.finished D') →
      (∀ x ∈ D, x.WF) → (∀ x ∈ D, x.Valid) → (∀ a ∈ allocs, a.WF) →
      (∀ a ∈ allocs, AllocationFits a) → ∀ x ∈ D', x.Valid := by
  apply arriveLoop_finished_induction
    (fun D allocs D' => (∀ x ∈ D, x.WF) → (∀ x ∈ D, x.Valid) → (∀ a ∈ allocs, a.WF) →
      (∀ a ∈ allocs, AllocationFits a) → ∀ x ∈ D', x.Valid)
  · intro D _ hv _ _
    exact hv
  · intro D a rest D1 D' hstep ih hD hv ha hf
    exact ih (arriveStep_finished_wf hstep hD (ha a List.mem_cons_self))
      (arriveStep_valid hstep hD hv (ha a List.mem_cons_self) (hf a List.mem_cons_self))
      (fun b hb => ha b (List.mem_cons_of_mem _ hb))
      (fun b hb => hf b (List.mem_cons_of_mem _ hb))

end Lots

/-- A valid destination stays valid, and the source holdings are left valid: when every holding at
the destination was valid, no holding at the destination after a transfer has a negative quantity or
basis, its carrying amount is its basis plus its valuation allowance, and it is empty of basis
exactly when it is empty of quantity. -/
theorem transferLots_after_valid {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {S' D' : List LotHolding}
    {allocations : List LotAllocation}
    (hS : ∀ holding ∈ S, holding.WF) (hD : ∀ holding ∈ D, holding.WF)
    (hr : requestedQuantity.WF) (hs : selection.WF) (hDv : ∀ holding ∈ D, holding.Valid)
    (h : transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities = .ok (.transferred S' D' allocations)) :
    (∀ x ∈ S', x.WF ∧ x.Valid) ∧ ∀ x ∈ D', x.WF ∧ x.Valid := by
  obtain ⟨source, policy, front, halloc, hin, hfree, harr, hwa, hsrc, hsrc'⟩ :=
    Lots.transferLots_facts hS hr hs h
  refine ⟨(allocateLots_after_valid hS hr hs halloc).2, fun x hx => ⟨?_, ?_⟩⟩
  · exact Lots.arriveLoop_wf allocations D D' harr hD hwa x hx
  · exact Lots.arriveLoop_valid allocations D D' harr hD hDv hwa
      (Lots.allocateLots_allocations_fit hS hr hs halloc) x hx

namespace Lots

/-- A holding that does not trip the test for an unresolved lot has one lot among those given,
under its lot identifier, of its book, commodity and basis commodity, with evidence. -/
theorem lotUnresolved_false {lots : List Lot} {holding : LotHolding}
    (h : lotUnresolved lots holding = false) :
    ∃ lot ∈ lots, lot.id = holding.lotId ∧ lot.bookId = holding.bookId ∧
      lot.commodityId = holding.commodityId ∧ lot.basisCommodityId = holding.basisCommodityId ∧
      lot.evidenceIds ≠ [] := by
  unfold lotUnresolved at h
  cases hl : lotById lots holding.lotId with
  | none => simp [hl] at h
  | some lot =>
    simp only [hl] at h
    have hmem := mem_of_mapGet (show mapGet (lots.map fun lot => (lot.id, lot)) holding.lotId =
      some lot from hl)
    obtain ⟨l, hlm, hpair⟩ := List.mem_map.mp hmem
    simp only [Prod.mk.injEq] at hpair
    obtain ⟨hid, rfl⟩ := hpair
    simp only [Bool.or_eq_false_iff, bne_eq_false_iff_eq] at h
    obtain ⟨⟨⟨⟨⟨⟨hb, hc⟩, hbc⟩, -⟩, -⟩, -⟩, hev⟩ := h
    refine ⟨l, hlm, hid, hb, hc, hbc, ?_⟩
    intro hnil
    simp [hnil] at hev

end Lots

/-- A transfer moves holdings of lots that are among the lots given, each of the book, commodity
and basis commodity of its source holding: the lot of every allocation is a lot of `lots`, which a
transfer neither changes nor returns, so the acquisition date and the acquisition basis of what
arrives at the destination are the ones recorded for the lot. -/
theorem transferLots_lots_resolve {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {S' D' : List LotHolding}
    {allocations : List LotAllocation}
    (hS : ∀ holding ∈ S, holding.WF) (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities = .ok (.transferred S' D' allocations)) :
    ∀ a ∈ allocations, ∃ s ∈ S, ∃ lot ∈ lots, s.id = a.holdingId ∧ s.lotId = a.lotId ∧
      lot.id = a.lotId ∧ lot.bookId = s.bookId ∧ lot.commodityId = s.commodityId ∧
      lot.basisCommodityId = s.basisCommodityId := by
  have halloc := transferLots_allocations h
  obtain ⟨candidates, specificQuantities, available, final, takes, run⟩ :=
    Lots.allocateLots_run hS hr hs halloc
  intro a ha
  rw [run.allocations_eq] at ha
  obtain ⟨t, ht, rfl⟩ := List.mem_map.mp ha
  have k := run.trace.took t ht
  have hcand : t.holding ∈ candidates :=
    run.trace.sublist.subset (List.mem_map_of_mem (f := (·.holding)) ht)
  have hres : Lots.lotUnresolved lots t.holding = false := by
    have := run.resolved
    rw [List.any_eq_false] at this
    simpa using this t.holding hcand
  obtain ⟨lot, hlot, hid, hb, hc, hbc, -⟩ := Lots.lotUnresolved_false hres
  refine ⟨t.holding, run.taken_mem t ht, lot, hlot, k.holdingId.symm, k.lotId.symm, ?_, hb, hc, hbc⟩
  rw [hid, k.lotId]

/-! ## Laws of `transferLots`: nothing is moved that was not held -/

/-- A transfer never moves more than the source holdings hold: the quantity requested is at most the
quantity they held, and what they hold afterwards is not negative. -/
theorem transferLots_not_overdrawn {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {S' D' : List LotHolding}
    {allocations : List LotAllocation}
    (hS : ∀ holding ∈ S, holding.WF) (hr : requestedQuantity.WF) (hs : selection.WF)
    (h : transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities = .ok (.transferred S' D' allocations)) :
    requestedQuantity.toRat ≤ (S.map (·.remainingQuantity.toRat)).sum ∧
    0 ≤ (S'.map (·.remainingQuantity.toRat)).sum := by
  have halloc := transferLots_allocations h
  have htotal := allocateLots_total_quantity hS hr hs halloc
  have hnonneg : 0 ≤ (S'.map (·.remainingQuantity.toRat)).sum := by
    apply List.sum_nonneg
    intro x hx
    obtain ⟨y, hy, rfl⟩ := List.mem_map.mp hx
    exact (allocateLots_after_valid hS hr hs halloc).2 y hy |>.2.quantity_nonneg
  exact ⟨by linarith, hnonneg⟩

/-- A request for more than the source holdings hold is never transferred: the call rejects it or
throws. -/
theorem transferLots_overdraw_not_transferred {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity}
    (hS : ∀ holding ∈ S, holding.WF) (hr : requestedQuantity.WF) (hs : selection.WF)
    (hover : (S.map (·.remainingQuantity.toRat)).sum < requestedQuantity.toRat)
    (S' D' : List LotHolding) (allocations : List LotAllocation) :
    transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities ≠ .ok (.transferred S' D' allocations) := by
  intro h
  have := (transferLots_not_overdrawn hS hr hs h).1
  linarith

/-! ## Laws of `allocateLots`: each selection method is honoured -/

namespace Lots

/-- A holding that does not trip the test for an unresolved lot has a lot among those given. -/
theorem lotUnresolved_false_some {lots : List Lot} {holding : LotHolding}
    (h : lotUnresolved lots holding = false) : ∃ lot, lotById lots holding.lotId = some lot := by
  unfold lotUnresolved at h
  cases hl : lotById lots holding.lotId with
  | none => simp [hl] at h
  | some lot => exact ⟨lot, rfl⟩

/-- For the methods that sort, a returned allocation is the record of a loop over the holdings that
have some quantity, sorted by the comparator of the method, and every one of them has a lot. -/
theorem Run.ordered_facts {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection} {derivation : DerivationRecord}
    {identities : List LotAllocationIdentity} {allocations : List LotAllocation}
    {after : List LotHolding} {candidates : List LotHolding}
    {specificQuantities : Option (List (LotHoldingId × ExactRational))}
    {available : Option ExactRational} {final : LoopState} {takes : List Taking}
    (run : Run holdings lots requestedQuantity selection derivation identities allocations after
      candidates specificQuantities available final takes)
    (hm : selection.method ≠ .specificIdentification) :
    specificQuantities = none ∧
    (∀ c, c ∈ candidates ↔ c ∈ holdings ∧ c.remainingQuantity.isZero = false) ∧
    (∀ c ∈ holdings, c.remainingQuantity.isZero = false → ∃ lot, lotById lots c.lotId = some lot) ∧
    stableSort (compareCandidates selection.method lots)
      (holdings.filter fun holding => !holding.remainingQuantity.isZero) = .ok candidates := by
  obtain ⟨hsorted, hsq⟩ := selectCandidates_ordered hm run.selected
  have hperm := stableSort_perm _ _ _ hsorted
  have hcands : ∀ c, c ∈ candidates ↔ c ∈ holdings ∧ c.remainingQuantity.isZero = false := by
    intro c
    rw [hperm.mem_iff, List.mem_filter]
    simp
  refine ⟨hsq, hcands, ?_, hsorted⟩
  intro c hc hz
  have hcm := (hcands c).mpr ⟨hc, hz⟩
  have hres := run.resolved
  rw [List.any_eq_false] at hres
  exact lotUnresolved_false_some (by simpa using hres c hcm)

end Lots

/-- First in first out: when a holding is taken from, every holding with some quantity that comes
before it in the TypeScript's order, which is the text of the acquisition instant, then the text of
the lot identifier, then the order in which the holdings were given, has been taken whole. -/
theorem allocateLots_fifo {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {derivation : DerivationRecord}
    {identities : List LotAllocationIdentity} {allocations : List LotAllocation}
    {after : List LotHolding}
    (hw : ∀ holding ∈ holdings, holding.WF) (hr : requestedQuantity.WF)
    (h : allocateLots holdings lots requestedQuantity .fifo derivation identities =
      .ok (.allocated allocations after))
    {x y : LotHolding} (hx : x ∈ holdings) (hxq : x.remainingQuantity.isZero = false)
    (hy : y ∈ holdings)
    (hbefore : Lots.Before (Lots.LexLt Lots.TextLt Lots.TextLt) (Lots.acquisitionKey lots)
      holdings x y)
    (htaken : ∃ allocation ∈ allocations, allocation.holdingId = y.id) :
    ∃ allocation ∈ allocations, allocation.holdingId = x.id ∧
      allocation.allocatedQuantity = x.remainingQuantity := by
  obtain ⟨candidates, specificQuantities, available, final, takes, run⟩ :=
    Lots.allocateLots_run hw hr (show LotSelection.WF .fifo from trivial) h
  obtain ⟨hsq, hcands, hres, hsorted⟩ := Lots.Run.ordered_facts run (by simp [LotSelection.method])
  have hlt := Lots.textLt_strictTotal.lex Lots.textLt_strictTotal
  have hcmp : ∀ a ∈ holdings.filter (fun holding => !holding.remainingQuantity.isZero),
      ∀ b ∈ holdings.filter (fun holding => !holding.remainingQuantity.isZero), ∀ o,
      Lots.compareCandidates LotSelection.fifo.method lots a b = .ok o →
        (o = .gt ↔ Lots.LexLt Lots.TextLt Lots.TextLt (Lots.acquisitionKey lots b)
          (Lots.acquisitionKey lots a)) := by
    intro a ha b hb o ho
    obtain ⟨ha1, ha2⟩ := List.mem_filter.mp ha
    obtain ⟨hb1, hb2⟩ := List.mem_filter.mp hb
    obtain ⟨la, hla⟩ := hres a ha1 (by simpa using ha2)
    obtain ⟨lb, hlb⟩ := hres b hb1 (by simpa using hb2)
    exact Lots.compareCandidates_fifo hla hlb ho
  have hsortedP := Lots.stableSort_sorted hlt (Lots.acquisitionKey lots) _ candidates hcmp hsorted
  exact Lots.Run.greedy_order run hsq (by simp [LotSelection.method]) hlt
    (Lots.acquisitionKey lots) hsortedP hcands hx hxq hy hbefore htaken

/-- Last in first out: when a holding is taken from, every holding with some quantity that comes
before it in the TypeScript's order, which is the later text of the acquisition instant first, then
the later text of the lot identifier first, then the order in which the holdings were given, has
been taken whole. -/
theorem allocateLots_lifo {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {derivation : DerivationRecord}
    {identities : List LotAllocationIdentity} {allocations : List LotAllocation}
    {after : List LotHolding}
    (hw : ∀ holding ∈ holdings, holding.WF) (hr : requestedQuantity.WF)
    (h : allocateLots holdings lots requestedQuantity .lifo derivation identities =
      .ok (.allocated allocations after))
    {x y : LotHolding} (hx : x ∈ holdings) (hxq : x.remainingQuantity.isZero = false)
    (hy : y ∈ holdings)
    (hbefore : Lots.Before (fun a b => Lots.LexLt Lots.TextLt Lots.TextLt b a)
      (Lots.acquisitionKey lots) holdings x y)
    (htaken : ∃ allocation ∈ allocations, allocation.holdingId = y.id) :
    ∃ allocation ∈ allocations, allocation.holdingId = x.id ∧
      allocation.allocatedQuantity = x.remainingQuantity := by
  obtain ⟨candidates, specificQuantities, available, final, takes, run⟩ :=
    Lots.allocateLots_run hw hr (show LotSelection.WF .lifo from trivial) h
  obtain ⟨hsq, hcands, hres, hsorted⟩ := Lots.Run.ordered_facts run (by simp [LotSelection.method])
  have hlt := (Lots.textLt_strictTotal.lex Lots.textLt_strictTotal).flip
  have hcmp : ∀ a ∈ holdings.filter (fun holding => !holding.remainingQuantity.isZero),
      ∀ b ∈ holdings.filter (fun holding => !holding.remainingQuantity.isZero), ∀ o,
      Lots.compareCandidates LotSelection.lifo.method lots a b = .ok o →
        (o = .gt ↔ (fun a b => Lots.LexLt Lots.TextLt Lots.TextLt b a) (Lots.acquisitionKey lots b)
          (Lots.acquisitionKey lots a)) := by
    intro a ha b hb o ho
    obtain ⟨ha1, ha2⟩ := List.mem_filter.mp ha
    obtain ⟨hb1, hb2⟩ := List.mem_filter.mp hb
    obtain ⟨la, hla⟩ := hres a ha1 (by simpa using ha2)
    obtain ⟨lb, hlb⟩ := hres b hb1 (by simpa using hb2)
    exact Lots.compareCandidates_lifo hla hlb ho
  have hsortedP := Lots.stableSort_sorted hlt (Lots.acquisitionKey lots) _ candidates hcmp hsorted
  exact Lots.Run.greedy_order run hsq (by simp [LotSelection.method]) hlt
    (Lots.acquisitionKey lots) hsortedP hcands hx hxq hy hbefore htaken

/-- Highest cost first: when a holding is taken from, every holding with some quantity that comes
before it in the TypeScript's order, which is the higher basis per unit first, then the lower text
of the lot identifier, then the order in which the holdings were given, has been taken whole. -/
theorem allocateLots_hifo {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {derivation : DerivationRecord}
    {identities : List LotAllocationIdentity} {allocations : List LotAllocation}
    {after : List LotHolding}
    (hw : ∀ holding ∈ holdings, holding.WF) (hr : requestedQuantity.WF)
    (h : allocateLots holdings lots requestedQuantity .hifo derivation identities =
      .ok (.allocated allocations after))
    {x y : LotHolding} (hx : x ∈ holdings) (hxq : x.remainingQuantity.isZero = false)
    (hy : y ∈ holdings)
    (hbefore : Lots.Before (Lots.LexLt (fun a b : ℚ => b < a) Lots.TextLt) Lots.costKey holdings x y)
    (htaken : ∃ allocation ∈ allocations, allocation.holdingId = y.id) :
    ∃ allocation ∈ allocations, allocation.holdingId = x.id ∧
      allocation.allocatedQuantity = x.remainingQuantity := by
  obtain ⟨candidates, specificQuantities, available, final, takes, run⟩ :=
    Lots.allocateLots_run hw hr (show LotSelection.WF .hifo from trivial) h
  obtain ⟨hsq, hcands, hres, hsorted⟩ := Lots.Run.ordered_facts run (by simp [LotSelection.method])
  have hlt := Lots.ratGt_strictTotal.lex Lots.textLt_strictTotal
  have hcmp : ∀ a ∈ holdings.filter (fun holding => !holding.remainingQuantity.isZero),
      ∀ b ∈ holdings.filter (fun holding => !holding.remainingQuantity.isZero), ∀ o,
      Lots.compareCandidates LotSelection.hifo.method lots a b = .ok o →
        (o = .gt ↔ Lots.LexLt (fun a b : ℚ => b < a) Lots.TextLt (Lots.costKey b)
          (Lots.costKey a)) := by
    intro a ha b hb o ho
    obtain ⟨ha1, ha2⟩ := List.mem_filter.mp ha
    obtain ⟨hb1, hb2⟩ := List.mem_filter.mp hb
    obtain ⟨la, hla⟩ := hres a ha1 (by simpa using ha2)
    obtain ⟨lb, hlb⟩ := hres b hb1 (by simpa using hb2)
    exact Lots.compareCandidates_hifo hla hlb (hw a ha1) (hw b hb1) ho
  have hsortedP := Lots.stableSort_sorted hlt Lots.costKey _ candidates hcmp hsorted
  exact Lots.Run.greedy_order run hsq (by simp [LotSelection.method]) hlt Lots.costKey hsortedP
    hcands hx hxq hy hbefore htaken

/-! ## Laws of `allocateLots`: specific identification takes what is named -/

namespace Lots

/-- A list of different items inside another list of different items, with the same total of
positive amounts, is the whole of it. -/
theorem sum_covers {α : Type} [DecidableEq α] (A B : List α) (v : α → ℚ) (hA : A.Nodup)
    (hB : B.Nodup) (hsub : ∀ a ∈ A, a ∈ B) (hpos : ∀ b ∈ B, 0 < v b)
    (hsum : (A.map v).sum = (B.map v).sum) : ∀ b ∈ B, b ∈ A := by
  intro b hb
  by_contra hbA
  have h1 : (A.map v).sum = ∑ a ∈ A.toFinset, v a := (List.sum_toFinset v hA).symm
  have h2 : (B.map v).sum = ∑ a ∈ B.toFinset, v a := (List.sum_toFinset v hB).symm
  have hlt : ∑ a ∈ A.toFinset, v a < ∑ a ∈ B.toFinset, v a :=
    Finset.sum_lt_sum_of_subset
      (fun a ha => List.mem_toFinset.mpr (hsub a (List.mem_toFinset.mp ha)))
      (List.mem_toFinset.mpr hb) (by simpa using hbA) (hpos b hb)
      (fun j hj _ => le_of_lt (hpos j (List.mem_toFinset.mp hj)))
  linarith

/-- Each take of a specific identification takes exactly the quantity named for its holding, and
the holding is a named one. -/
theorem Run.specific_takes {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {named : List SpecificAllocation}
    {derivation : DerivationRecord} {identities : List LotAllocationIdentity}
    {allocations : List LotAllocation} {after : List LotHolding} {candidates : List LotHolding}
    {specificQuantities : Option (List (LotHoldingId × ExactRational))}
    {available : Option ExactRational} {final : LoopState} {takes : List Taking}
    (run : Run holdings lots requestedQuantity (.specificIdentification named) derivation
      identities allocations after candidates specificQuantities available final takes) :
    ∀ t ∈ takes, ∃ item ∈ named, item.holdingId = t.holding.id ∧
      t.allocation.allocatedQuantity = item.quantity := by
  intro t ht
  obtain ⟨hnodupN, -, -, ⟨sorted, hsorted, hc⟩, -, hsq⟩ := selectCandidates_specific run.selected
  obtain ⟨rem, hch⟩ := run.trace.chosen t ht
  have hcand : t.holding ∈ candidates :=
    run.trace.sublist.subset (List.mem_map_of_mem (f := (·.holding)) ht)
  have hnamed : ∃ item ∈ named, item.holdingId = t.holding.id := by
    rw [hc] at hcand
    obtain ⟨item, hitem, hfind⟩ := List.mem_filterMap.mp hcand
    have hid : t.holding.id = item.holdingId := by simpa using List.find?_some hfind
    exact ⟨item, (stableSort_perm _ _ _ hsorted).mem_iff.mp hitem, hid.symm⟩
  obtain ⟨item, hitem, hid⟩ := hnamed
  have hkeys : ((named.map fun it => (it.holdingId, it.quantity)).map (·.1)).Nodup := by
    rw [List.map_map]
    exact hnodupN
  have hq : mapGet (named.map fun it => (it.holdingId, it.quantity)) t.holding.id =
      some item.quantity := by
    rw [mapGet_eq_some_iff hkeys]
    exact List.mem_map.mpr ⟨item, hitem, by rw [hid]⟩
  unfold chooseAllocated at hch
  simp only [loopInputs, hsq, Option.bind_some, hq, Except.ok.injEq] at hch
  exact ⟨item, hitem, hid, hch.symm⟩

end Lots

/-- Specific identification takes exactly what is named: every named holding is taken from, by
exactly the quantity named for it, and nothing is taken from any other holding. -/
theorem allocateLots_specific {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {named : List SpecificAllocation}
    {derivation : DerivationRecord} {identities : List LotAllocationIdentity}
    {allocations : List LotAllocation} {after : List LotHolding}
    (hw : ∀ holding ∈ holdings, holding.WF) (hr : requestedQuantity.WF)
    (hs : ∀ item ∈ named, item.quantity.WF)
    (h : allocateLots holdings lots requestedQuantity (.specificIdentification named) derivation
      identities = .ok (.allocated allocations after)) :
    (∀ item ∈ named, ∃ allocation ∈ allocations, allocation.holdingId = item.holdingId ∧
      allocation.allocatedQuantity = item.quantity) ∧
    (∀ allocation ∈ allocations, ∃ item ∈ named, item.holdingId = allocation.holdingId ∧
      allocation.allocatedQuantity = item.quantity) := by
  obtain ⟨candidates, specificQuantities, available, final, takes, run⟩ :=
    Lots.allocateLots_run hw hr (show LotSelection.WF (.specificIdentification named) from hs) h
  have hspec := Lots.Run.specific_takes run
  obtain ⟨hnodupN, hquant, ⟨declaredTotal, hadd, heq⟩, -, -, -⟩ :=
    Lots.selectCandidates_specific run.selected
  have second : ∀ allocation ∈ allocations, ∃ item ∈ named, item.holdingId = allocation.holdingId ∧
      allocation.allocatedQuantity = item.quantity := by
    intro allocation hmem
    rw [run.allocations_eq] at hmem
    obtain ⟨t, ht, rfl⟩ := List.mem_map.mp hmem
    obtain ⟨item, hitem, hid, hq⟩ := hspec t ht
    exact ⟨item, hitem, hid.trans (run.trace.took t ht).holdingId.symm, hq⟩
  refine ⟨?_, second⟩
  -- the value named for an identifier
  let entries : List (LotHoldingId × ℚ) := named.map fun it => (it.holdingId, it.quantity.toRat)
  have hkeys : (entries.map (·.1)).Nodup := by
    simp only [entries, List.map_map]
    exact hnodupN
  let v : LotHoldingId → ℚ := fun id => (Lots.mapGet entries id).getD 0
  have hv : ∀ item ∈ named, v item.holdingId = item.quantity.toRat := by
    intro item hitem
    have : Lots.mapGet entries item.holdingId = some item.quantity.toRat := by
      rw [Lots.mapGet_eq_some_iff hkeys]
      exact List.mem_map.mpr ⟨item, hitem, rfl⟩
    simp only [v, this, Option.getD_some]
  have hpos : ∀ b ∈ named.map (·.holdingId), 0 < v b := by
    intro b hb
    obtain ⟨item, hitem, rfl⟩ := List.mem_map.mp hb
    rw [hv item hitem]
    exact Lots.pos_of_not_zero_not_negative (hs item hitem) (hquant item hitem).1
      (hquant item hitem).2
  have hvt : ∀ t ∈ takes, v t.holding.id = t.allocation.allocatedQuantity.toRat := by
    intro t ht
    obtain ⟨item, hitem, hid, hq⟩ := hspec t ht
    rw [← hid, hv item hitem, hq]
  have hsub : ∀ a ∈ takes.map (·.holding.id), a ∈ named.map (·.holdingId) := by
    intro a ha
    obtain ⟨t, ht, rfl⟩ := List.mem_map.mp ha
    obtain ⟨item, hitem, hid, -⟩ := hspec t ht
    exact List.mem_map.mpr ⟨item, hitem, hid⟩
  have hsumA : ((takes.map (·.holding.id)).map v).sum = requestedQuantity.toRat := by
    rw [List.map_map, ← run.total]
    congr 1
    exact List.map_congr_left (fun t ht => hvt t ht)
  have hsumB : ((named.map (·.holdingId)).map v).sum = requestedQuantity.toRat := by
    obtain ⟨-, hrat⟩ := Lots.addAll_ok (named.map (·.quantity)) ExactRational.zero declaredTotal
      ExactRational.zero_wf (fun q hq => by
        obtain ⟨item, hitem, rfl⟩ := List.mem_map.mp hq
        exact hs item hitem) hadd
    have hdw : declaredTotal.WF :=
      (Lots.addAll_ok (named.map (·.quantity)) ExactRational.zero declaredTotal
        ExactRational.zero_wf (fun q hq => by
          obtain ⟨item, hitem, rfl⟩ := List.mem_map.mp hq
          exact hs item hitem) hadd).1
    have h1 := (ExactRational.equals_iff hdw hr).mp heq
    rw [List.map_map]
    rw [h1, ExactRational.zero_toRat, zero_add, List.map_map] at hrat
    rw [hrat]
    congr 1
    exact List.map_congr_left (fun item hitem => hv item hitem)
  have hcover := Lots.sum_covers (takes.map (·.holding.id)) (named.map (·.holdingId)) v
    run.taken_nodup hnodupN hsub hpos (hsumA.trans hsumB.symm)
  intro item hitem
  obtain ⟨t, ht, htid⟩ := List.mem_map.mp (hcover item.holdingId
    (List.mem_map.mpr ⟨item, hitem, rfl⟩))
  obtain ⟨item', hitem', hid', hq'⟩ := hspec t ht
  have hsame : item' = item :=
    List.inj_on_of_nodup_map hnodupN hitem' hitem (hid'.trans htid)
  subst hsame
  exact ⟨t.allocation, by rw [run.allocations_eq]; exact List.mem_map_of_mem ht,
    (run.trace.took t ht).holdingId.trans htid, hq'⟩

/-! ## Laws of `transferLots`: when the identifiers are supplied, it must transfer -/

namespace Lots

/-- In a list with no repeated value after a filter and a map, an element passing the filter before
another that passes it has a different image. -/
theorem distinct_before {α β : Type} [DecidableEq β] (p : α → Bool) (f : α → β)
    (done rest : List α) (a b : α) (hb : b ∈ done) (hpb : p b = true) (hpa : p a = true)
    (hnodup : (((done ++ a :: rest).filter p).map f).Nodup) : f b ≠ f a := by
  rw [List.filter_append, List.filter_cons_of_pos hpa, List.map_append, List.map_cons] at hnodup
  exact (List.nodup_append.mp hnodup).2.2 (f b)
    (List.mem_map.mpr ⟨b, List.mem_filter.mpr ⟨hb, hpb⟩, rfl⟩) (f a) (by simp)

end Lots

/-- When the destination holdings are in scope and have identifiers of their own, and every lot of
an allocation that no destination holding has comes with an identifier supplied for its source
holding that no destination or source holding has, the identifiers supplied being all different,
the call transfers, or throws an error of the exact numbers: nothing else can happen. -/
theorem transferLots_complete_supplied {S D : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection}
    {policies : List TransferPolicy} {governedAt : Instant} {da : AccountId}
    {derivation : DerivationRecord} {allocationIdentities : List LotAllocationIdentity}
    {destinationIdentities : List DestinationHoldingIdentity} {source : LotHolding}
    {policy : TransferPolicy} {allocations : List LotAllocation} {holdings : List LotHolding}
    (hS : ∀ holding ∈ S, holding.WF) (hr : requestedQuantity.WF) (hs : selection.WF)
    (front : Lots.Front S policies governedAt da source policy)
    (hA : allocateLots S lots requestedQuantity selection derivation allocationIdentities =
      .ok (.allocated allocations holdings))
    (hin : ∀ holding ∈ D, Lots.DestinationInScope source da holding)
    (hfree : Lots.DestinationIdsFree S D)
    (hsupplied : ∀ a ∈ allocations, a.lotId ∉ D.map (·.lotId) →
      ∃ identity, destinationIdentities.find?
          (fun identity => identity.sourceHoldingId == a.holdingId) = some identity ∧
        (∀ x ∈ D, x.id ≠ identity.destinationHoldingId) ∧
        (∀ x ∈ S, x.id ≠ identity.destinationHoldingId))
    (hdistinct : (((allocations.filter fun a => decide (a.lotId ∉ D.map (·.lotId))).map fun a =>
      (destinationIdentities.find? (fun identity => identity.sourceHoldingId == a.holdingId)).map
        (·.destinationHoldingId))).Nodup) :
    (∃ destination, transferLots S D lots requestedQuantity selection policies governedAt da
      derivation allocationIdentities destinationIdentities =
        .ok (.transferred holdings destination allocations)) ∨
    ∃ code, transferLots S D lots requestedQuantity selection policies governedAt da derivation
      allocationIdentities destinationIdentities = .error (.exactNumber code) := by
  refine transferLots_complete hS hr hs front hA hin hfree ?_
  rintro ⟨done, a, rest, D1, s, hall, hfin, hs', hnone, hcase⟩
  obtain ⟨-, hsrc⟩ := Lots.allocateLots_allocations_lots hS hr hs hA
  have hsrc' : ∀ b ∈ allocations, ∀ t,
      S.find? (fun holding => holding.id == b.holdingId) = some t → t.lotId = b.lotId := by
    intro b hb t ht
    obtain ⟨t2, ht2, hl⟩ := hsrc b hb
    rw [ht2] at ht
    cases ht
    exact hl
  have hdone : ∀ b ∈ done, b ∈ allocations := fun b hb => by rw [hall]; simp [hb]
  have ha : a ∈ allocations := by rw [hall]; simp
  have hsl : s.lotId = a.lotId := hsrc' a ha s hs'
  have hsid : s.id = a.holdingId := by simpa using List.find?_some hs'
  -- the lot of the allocation is not held at the destination to begin with
  have hcov := (Lots.arriveLoop_covers done D D1 hfin
    (fun b hb => hsrc' b (hdone b hb))).1
  have hnotin : a.lotId ∉ D.map (·.lotId) := by
    intro hmem
    obtain ⟨x, hx, hxl⟩ := List.mem_map.mp hmem
    obtain ⟨y, hy, hyid⟩ := hcov x hx
    obtain ⟨-, hl, hacc⟩ := Lots.identity_eq hyid
    exact hnone y hy ⟨hl.trans (hxl.trans hsl.symm), hacc.trans (hin x hx).2.1⟩
  obtain ⟨ida, hfa, hDfresh, hSfresh⟩ := hsupplied a ha hnotin
  rw [hsid] at hcase
  rcases hcase with hf | ⟨identity, hf, hused⟩
  · rw [hfa] at hf
    cases hf
  · rw [hfa] at hf
    have hident : ida = identity := Option.some.inj hf
    subst hident
    rcases hused with ⟨x, hx, hxid⟩ | ⟨x, hx, hxid⟩
    · obtain ⟨news, hlay, hnews⟩ := Lots.arriveLoop_layout done D D1 hfin
      have hxmem : x.identity ∈ D.map LotHolding.identity ++ news.map LotHolding.identity := by
        rw [← hlay]
        exact List.mem_map_of_mem (f := LotHolding.identity) hx
      rcases List.mem_append.mp hxmem with hxD | hxN
      · obtain ⟨z, hz, hzid⟩ := List.mem_map.mp hxD
        exact hDfresh z hz (((Lots.identity_eq hzid).1).trans hxid)
      · obtain ⟨n, hn, hnid⟩ := List.mem_map.mp hxN
        obtain ⟨b, hb, sb, idb, hfsb, hfib, rfl, hnoneb⟩ := hnews n hn
        have hbmem : b ∈ done := hb
        have hsbid : sb.id = b.holdingId := by simpa using List.find?_some hfsb
        have hbnotin : b.lotId ∉ D.map (·.lotId) := by
          intro hmem
          obtain ⟨y, hy, hyl⟩ := List.mem_map.mp hmem
          exact hnoneb y hy ⟨hyl.trans (hsrc' b (hdone b hbmem) sb hfsb).symm, (hin y hy).2.1⟩
        have hxn : idb.destinationHoldingId = ida.destinationHoldingId :=
          ((Lots.identity_eq hnid).1).trans hxid
        rw [hall] at hdistinct
        have hfb : (destinationIdentities.find?
            (fun i => i.sourceHoldingId == b.holdingId)).map (·.destinationHoldingId) =
            some idb.destinationHoldingId := by
          rw [← hsbid, hfib]
          rfl
        have hfa' : (destinationIdentities.find?
            (fun i => i.sourceHoldingId == a.holdingId)).map (·.destinationHoldingId) =
            some ida.destinationHoldingId := by
          rw [hfa]
          rfl
        exact Lots.distinct_before
          (fun c => decide (c.lotId ∉ D.map (·.lotId)))
          (fun c => (destinationIdentities.find?
            (fun i => i.sourceHoldingId == c.holdingId)).map (·.destinationHoldingId))
          done rest a b hbmem (by simpa using hbnotin) (by simpa using hnotin) hdistinct
          (by simp only [hfb, hfa', hxn])
    · exact hSfresh x hx hxid

/-! ## Laws of `allocateLots`: the loop of the sorted methods never rejects, and takes what is there -/

namespace Lots

/-- The quantity a turn of the loop takes for the sorted methods is the whole holding, or what is
still asked for when that is less, and it is a positive constructible number. -/
theorem chooseAllocated_greedy_spec {inputs : LoopInputs} (hs : inputs.specificQuantities = none)
    (hm : inputs.method ≠ .weightedAverage) {holding : LotHolding} {remaining : ExactRational}
    (hh : holding.WF) (hq : 0 < holding.remainingQuantity.toRat) (hr : remaining.WF)
    (hrp : 0 < remaining.toRat) :
    ∃ a, chooseAllocated inputs holding remaining = .ok a ∧ a.WF ∧ 0 < a.toRat ∧
      a.toRat ≤ holding.remainingQuantity.toRat ∧ a.toRat ≤ remaining.toRat ∧
      (a.toRat = holding.remainingQuantity.toRat ∨ a.toRat = remaining.toRat) := by
  rw [chooseAllocated_greedy hs hm]
  by_cases hcmp : holding.remainingQuantity.compare remaining ≠ .gt
  · refine ⟨holding.remainingQuantity, by rw [ite_holds hcmp], hh.remainingQuantity, hq,
      le_refl _, ?_, Or.inl rfl⟩
    by_contra hlt
    exact hcmp ((ExactRational.compare_gt_iff hh.remainingQuantity hr).mpr (not_le.mp hlt))
  · refine ⟨remaining, by rw [ite_not_holds hcmp], hr, hrp, ?_, le_refl _, Or.inr rfl⟩
    by_contra hle
    apply hcmp
    intro hgt
    exact hle (le_of_lt ((ExactRational.compare_gt_iff hh.remainingQuantity hr).mp hgt))

/-- A turn of the loop for the sorted methods, at a holding with some quantity while some is still
asked for, whose allocation identifier is supplied and not yet used, never rejects: it throws, or it
takes the whole holding or what is still asked for, whichever is less, and adds one allocation
under the identifier. -/
theorem allocateStep_greedy {inputs : LoopInputs} (hs : inputs.specificQuantities = none)
    (hm : inputs.method ≠ .weightedAverage) {holding : LotHolding} {state : LoopState}
    (hh : holding.WF) (hq : 0 < holding.remainingQuantity.toRat) (hr : state.remaining.WF)
    (hrp : 0 < state.remaining.toRat) {identity : LotAllocationIdentity}
    (hf : inputs.identities.find? (fun item => item.holdingId == holding.id) = some identity)
    (hfresh : ∀ x ∈ state.allocations, x.id ≠ identity.allocationId) :
    (∃ e, allocateStep inputs holding state = .error e) ∨
    ∃ next, allocateStep inputs holding state = .ok (.finished next) ∧ next.remaining.WF ∧
      next.remaining.toRat =
        state.remaining.toRat - min holding.remainingQuantity.toRat state.remaining.toRat ∧
      ∀ x ∈ next.allocations, x ∈ state.allocations ∨ x.id = identity.allocationId := by
  obtain ⟨a, hch, haw, hapos, hale_q, hale_r, hrel⟩ :=
    chooseAllocated_greedy_spec hs hm hh hq hr hrp
  have hex : ¬ (a.compare holding.remainingQuantity = .gt ∨ a.compare state.remaining = .gt) := by
    rintro (h | h)
    · exact absurd ((ExactRational.compare_gt_iff haw hh.remainingQuantity).mp h) (not_lt.mpr hale_q)
    · exact absurd ((ExactRational.compare_gt_iff haw hr).mp h) (not_lt.mpr hale_r)
  have hmin : a.toRat = min holding.remainingQuantity.toRat state.remaining.toRat := by
    refine le_antisymm (le_min hale_q hale_r) ?_
    rcases hrel with h | h
    · rw [h]; exact min_le_left _ _
    · rw [h]; exact min_le_right _ _
  unfold allocateStep
  rw [hch]
  simp only [hex, ↓reduceIte]
  cases ht : take holding a with
  | error e => exact Or.inl ⟨e, rfl⟩
  | ok taken =>
    simp only [hf]
    have hdup : ¬ (state.allocations.any (fun item => item.id == identity.allocationId) = true) := by
      rw [List.any_eq_true]
      rintro ⟨x, hx, hxid⟩
      exact hfresh x hx (by simpa using hxid)
    simp only [hdup, Bool.false_eq_true, ↓reduceIte]
    cases hsub : state.remaining.subtract a with
    | error e => exact Or.inl ⟨e, rfl⟩
    | ok remaining' =>
      obtain ⟨hw', hr'⟩ := ExactRational.subtract_ok hr haw hsub
      refine Or.inr ⟨_, rfl, hw', by rw [hr', hmin], ?_⟩
      intro x hx
      simp only [List.mem_append, List.mem_singleton] at hx
      rcases hx with hx | hx
      · exact Or.inl hx
      · exact Or.inr (by rw [hx]; rfl)

/-- The loop for the sorted methods, over holdings that have some quantity and whose allocation
identifiers are supplied and all different, never rejects: it throws, or it ends having taken the
holdings whole in turn until what is asked for is met, and what is still asked for at the end is
what the holdings did not cover. -/
theorem allocateLoop_greedy {inputs : LoopInputs} (hs : inputs.specificQuantities = none)
    (hm : inputs.method ≠ .weightedAverage) :
    ∀ (candidates : List LotHolding) (state : LoopState),
      (∀ c ∈ candidates, c.WF ∧ 0 < c.remainingQuantity.toRat) →
      state.remaining.WF → 0 ≤ state.remaining.toRat →
      (∀ c ∈ candidates, ∃ identity,
        inputs.identities.find? (fun item => item.holdingId == c.id) = some identity) →
      (candidates.map fun c =>
        (inputs.identities.find? (fun item => item.holdingId == c.id)).map (·.allocationId)).Nodup →
      (∀ x ∈ state.allocations, ∀ c ∈ candidates, ∀ identity,
        inputs.identities.find? (fun item => item.holdingId == c.id) = some identity →
          x.id ≠ identity.allocationId) →
      (∃ e, allocateLoop inputs candidates state = .error e) ∨
      ∃ final, allocateLoop inputs candidates state = .ok (.finished final) ∧
        final.remaining.WF ∧
        final.remaining.toRat =
          max 0 (state.remaining.toRat - (candidates.map (·.remainingQuantity.toRat)).sum) := by
  intro candidates
  induction candidates with
  | nil =>
    intro state _ hr hn _ _ _
    refine Or.inr ⟨state, by simp [allocateLoop], hr, ?_⟩
    simp only [List.map_nil, List.sum_nil, sub_zero]
    exact (max_eq_right hn).symm
  | cons c rest ih =>
    intro state hc hr hn hid hnodup hfresh
    have hsum : 0 ≤ (rest.map (·.remainingQuantity.toRat)).sum := by
      apply List.sum_nonneg
      intro x hx
      obtain ⟨y, hy, rfl⟩ := List.mem_map.mp hx
      exact le_of_lt (hc y (List.mem_cons_of_mem _ hy)).2
    by_cases hz : state.remaining.isZero = true
    · refine Or.inr ⟨state, allocateLoop_of_isZero inputs _ hz, hr, ?_⟩
      have h0 : state.remaining.toRat = 0 := (ExactRational.isZero_iff hr).mp hz
      have hcq := (hc c List.mem_cons_self).2
      rw [h0, List.map_cons, List.sum_cons]
      exact (max_eq_left (by linarith)).symm
    · have hrp : 0 < state.remaining.toRat :=
        lt_of_le_of_ne hn (fun h0 => hz ((ExactRational.isZero_iff hr).mpr h0.symm))
      obtain ⟨hcw, hcq⟩ := hc c List.mem_cons_self
      have hqz : c.remainingQuantity.isZero = false := by
        by_contra hne
        have := (ExactRational.isZero_iff hcw.remainingQuantity).mp (by simpa using hne)
        linarith
      obtain ⟨identity, hf⟩ := hid c List.mem_cons_self
      rcases allocateStep_greedy hs hm hcw hcq hr hrp hf
        (fun x hx => hfresh x hx c List.mem_cons_self identity hf) with
        ⟨e, he⟩ | ⟨next, hstep, hnw, hnr, hnids⟩
      · refine Or.inl ⟨e, ?_⟩
        rw [allocateLoop]
        simp [hz, hqz, he]
      · have hnn : 0 ≤ next.remaining.toRat := by
          rw [hnr]
          have := min_le_right c.remainingQuantity.toRat state.remaining.toRat
          linarith
        have hnodup' := (List.nodup_cons.mp hnodup)
        rcases ih next (fun c' hc' => hc c' (List.mem_cons_of_mem _ hc')) hnw hnn
          (fun c' hc' => hid c' (List.mem_cons_of_mem _ hc')) hnodup'.2
          (by
            intro x hx c' hc' identity' hf'
            rcases hnids x hx with hx | hx
            · exact hfresh x hx c' (List.mem_cons_of_mem _ hc') identity' hf'
            · rw [hx]
              intro heq
              apply hnodup'.1
              exact List.mem_map.mpr ⟨c', hc', by simp only [hf', hf, heq, Option.map_some]⟩) with
          ⟨e, he⟩ | ⟨final, hfin, hfw, hfr⟩
        · refine Or.inl ⟨e, ?_⟩
          rw [allocateLoop]
          simp [hz, hqz, hstep, he]
        · refine Or.inr ⟨final, ?_, hfw, ?_⟩
          · rw [allocateLoop]
            simp [hz, hqz, hstep, hfin]
          · rw [hfr, hnr, List.map_cons, List.sum_cons]
            rcases le_total c.remainingQuantity.toRat state.remaining.toRat with h | h
            · rw [min_eq_left h]
              congr 1
              ring
            · rw [min_eq_right h, max_eq_left (by linarith), max_eq_left (by linarith)]

end Lots

/-! ## Laws of `allocateLots`: a request for more than is held, and a request that can be met -/

/-- A request for more than the holdings hold is never allocated: the call rejects it or throws. -/
theorem allocateLots_overrequest_not_allocated {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection} {derivation : DerivationRecord}
    {identities : List LotAllocationIdentity}
    (hw : ∀ holding ∈ holdings, holding.WF) (hr : requestedQuantity.WF) (hs : selection.WF)
    (hover : (holdings.map (·.remainingQuantity.toRat)).sum < requestedQuantity.toRat)
    (allocations : List LotAllocation) (after : List LotHolding) :
    allocateLots holdings lots requestedQuantity selection derivation identities ≠
      .ok (.allocated allocations after) := by
  intro h
  have htotal := allocateLots_total_quantity hw hr hs h
  have hnonneg : 0 ≤ (after.map (·.remainingQuantity.toRat)).sum := by
    apply List.sum_nonneg
    intro x hx
    obtain ⟨y, hy, rfl⟩ := List.mem_map.mp hx
    exact (allocateLots_after_valid hw hr hs h).2 y hy |>.2.quantity_nonneg
  linarith

namespace Lots

/-- Leaving out the holdings that have no quantity leaves the total quantity as it was. -/
theorem sum_filter_nonzero (holdings : List LotHolding)
    (hw : ∀ holding ∈ holdings, holding.WF) :
    ((holdings.filter fun c => !c.remainingQuantity.isZero).map
      (·.remainingQuantity.toRat)).sum = (holdings.map (·.remainingQuantity.toRat)).sum := by
  induction holdings with
  | nil => simp
  | cons h rest ih =>
    have ih' := ih (fun x hx => hw x (List.mem_cons_of_mem _ hx))
    by_cases hz : h.remainingQuantity.isZero = true
    · have h0 : h.remainingQuantity.toRat = 0 :=
        (ExactRational.isZero_iff (hw h List.mem_cons_self).remainingQuantity).mp hz
      rw [List.filter_cons_of_neg (by simp [hz]), List.map_cons, List.sum_cons, h0, zero_add, ih']
    · rw [List.filter_cons_of_pos (by simpa using hz), List.map_cons, List.map_cons,
        List.sum_cons, List.sum_cons, ih']

end Lots

/-- For first in, last in and highest cost, with the holdings valid, the lots resolved and in one
scope, and an identifier supplied for the allocation of every holding with some quantity, all of
them different: whatever the call returns without throwing is an allocation when the request is at
most what is held, and is the one rejection of a request for more than is held when it is not. -/
theorem allocateLots_ordered_outcome {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection} {derivation : DerivationRecord}
    {identities : List LotAllocationIdentity} {result : LotAllocationResult}
    (hw : ∀ holding ∈ holdings, holding.WF) (hr : requestedQuantity.WF)
    (hsel : selection = .fifo ∨ selection = .lifo ∨ selection = .hifo)
    (hvalid : Lots.validateHoldings holdings = .ok [])
    (hpos : 0 < requestedQuantity.toRat) (hlots : (lots.map (·.id)).Nodup)
    (hres : ∀ c ∈ holdings, c.remainingQuantity.isZero = false →
      Lots.lotUnresolved lots c = false)
    (hscope : ∀ c ∈ holdings, ∀ d ∈ holdings, c.remainingQuantity.isZero = false →
      d.remainingQuantity.isZero = false → Lots.mixesScope c d = false)
    (hident : ∀ c ∈ holdings, c.remainingQuantity.isZero = false → ∃ identity,
      identities.find? (fun item => item.holdingId == c.id) = some identity)
    (hdistinct : ((holdings.filter fun c => !c.remainingQuantity.isZero).map fun c =>
      (identities.find? (fun item => item.holdingId == c.id)).map (·.allocationId)).Nodup)
    (h : allocateLots holdings lots requestedQuantity selection derivation identities =
      .ok result) :
    (requestedQuantity.toRat ≤ (holdings.map (·.remainingQuantity.toRat)).sum ∧
      ∃ allocations after, result = .allocated allocations after) ∨
    ((holdings.map (·.remainingQuantity.toRat)).sum < requestedQuantity.toRat ∧
      result = Lots.reject "Requested quantity exceeds selected holdings") := by
  have hm : selection.method ≠ .specificIdentification := by
    rcases hsel with rfl | rfl | rfl <;> simp [LotSelection.method]
  have hmw : selection.method ≠ .weightedAverage := by
    rcases hsel with rfl | rfl | rfl <;> simp [LotSelection.method]
  obtain ⟨hnodup, hval⟩ := (Lots.validateHoldings_nil_iff hw).mp hvalid
  have hrz : requestedQuantity.isZero = false := by
    by_contra hne
    have := (ExactRational.isZero_iff hr).mp (by simpa using hne)
    linarith
  have hrn : requestedQuantity.isNegative = false := by
    by_contra hne
    have := (ExactRational.isNegative_iff hr).mp (by simpa using hne)
    linarith
  have hlotsOk : Lots.setSize (lots.map (·.id)) = lots.length := by
    have := (Lots.setSize_eq_length_iff (lots.map (·.id))).mpr hlots
    rwa [List.length_map] at this
  unfold allocateLots at h
  rw [hvalid] at h
  simp only [List.length_nil, gt_iff_lt, lt_self_iff_false, ↓reduceIte, hrz, hrn, Bool.or_self,
    Bool.false_eq_true, hlotsOk, ne_eq, not_true_eq_false] at h
  cases hsc : Lots.selectCandidates holdings lots requestedQuantity selection with
  | error e => simp [hsc] at h
  | ok selected =>
    cases selected with
    | rejected rejection =>
      exact absurd (Lots.selectCandidates_rejected hsc).2 hm
    | candidates candidates specificQuantities =>
      simp only [hsc] at h
      obtain ⟨hsorted, hsq⟩ := Lots.selectCandidates_ordered hm hsc
      have hperm := Lots.stableSort_perm _ _ _ hsorted
      have hcands : ∀ c, c ∈ candidates ↔ c ∈ holdings ∧ c.remainingQuantity.isZero = false := by
        intro c
        rw [hperm.mem_iff, List.mem_filter]
        simp
      have hun : candidates.any (Lots.lotUnresolved lots) = false := by
        rw [List.any_eq_false]
        intro c hc
        have := (hcands c).mp hc
        simpa using hres c this.1 this.2
      have hmix : (match candidates.head? with
          | some first => candidates.any (Lots.mixesScope first)
          | none => false) = false := by
        cases hhead : candidates.head? with
        | none => rfl
        | some first =>
          have hfirst : first ∈ candidates := List.mem_of_mem_head? hhead
          rw [List.any_eq_false]
          intro d hd
          have h1 := (hcands first).mp hfirst
          have h2 := (hcands d).mp hd
          simpa using hscope first h1.1 d h2.1 h1.2 h2.2
      simp only [hun, hmix, Bool.false_eq_true, ↓reduceIte] at h
      have hwa : Lots.weightedAvailable selection.method candidates = .ok none := by
        unfold Lots.weightedAvailable
        simp [hmw]
      simp only [hwa] at h
      -- the loop
      have hcw : ∀ c ∈ candidates, c.WF ∧ 0 < c.remainingQuantity.toRat := by
        intro c hc
        obtain ⟨hch, hcz⟩ := (hcands c).mp hc
        refine ⟨hw c hch, ?_⟩
        have hv := (hval c hch).1
        refine lt_of_le_of_ne hv.quantity_nonneg (fun h0 => ?_)
        have := (ExactRational.isZero_iff (hw c hch).remainingQuantity).mpr h0.symm
        rw [hcz] at this
        cases this
      have hloop := Lots.allocateLoop_greedy
        (inputs := Lots.loopInputs requestedQuantity selection derivation identities
          specificQuantities none)
        (by simpa [Lots.loopInputs] using hsq) (by simpa [Lots.loopInputs] using hmw)
        candidates (Lots.startState requestedQuantity) hcw hr (le_of_lt hpos)
        (fun c hc => by
          obtain ⟨hch, hcz⟩ := (hcands c).mp hc
          exact hident c hch hcz)
        (by
          have := (hperm.map (fun c => (identities.find? (fun item => item.holdingId == c.id)).map
            (·.allocationId))).nodup_iff.mpr hdistinct
          simpa [Lots.loopInputs] using this)
        (by simp [Lots.startState])
      have hsum : (candidates.map (·.remainingQuantity.toRat)).sum =
          (holdings.map (·.remainingQuantity.toRat)).sum := by
        rw [(hperm.map (·.remainingQuantity.toRat)).sum_eq]
        exact Lots.sum_filter_nonzero holdings hw
      rcases hloop with ⟨e, he⟩ | ⟨final, hfin, hfw, hfr⟩
      · simp only [Lots.loopInputs, Lots.startState] at he
        simp [he] at h
      · simp only [Lots.loopInputs, Lots.startState] at hfin hfr
        simp only [hfin] at h
        rw [hsum] at hfr
        by_cases hz : final.remaining.isZero = true
        · have h0 := (ExactRational.isZero_iff hfw).mp hz
          have hle : requestedQuantity.toRat ≤ (holdings.map (·.remainingQuantity.toRat)).sum := by
            rw [h0] at hfr
            have := le_max_right 0 (requestedQuantity.toRat -
              (holdings.map (·.remainingQuantity.toRat)).sum)
            rw [← hfr] at this
            linarith
          simp only [hz, Bool.not_true, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq] at h
          exact Or.inl ⟨hle, _, _, h.symm⟩
        · have hne : final.remaining.toRat ≠ 0 := fun h0 =>
            hz ((ExactRational.isZero_iff hfw).mpr h0)
          have hgt : (holdings.map (·.remainingQuantity.toRat)).sum < requestedQuantity.toRat := by
            by_contra hnot
            apply hne
            rw [hfr]
            exact max_eq_left (by linarith)
          simp only [hz, Bool.not_false, ↓reduceIte, Except.ok.injEq] at h
          exact Or.inr ⟨hgt, h.symm⟩

/-- For first in, last in and highest cost, with the holdings valid, the lots resolved and in one
scope, and an identifier supplied for the allocation of every holding with some quantity, all of
them different, a request for at most what is held is allocated: the call throws an error of the
exact numbers or returns an allocation, and nothing else can happen. -/
theorem allocateLots_complete_ordered {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection} {derivation : DerivationRecord}
    {identities : List LotAllocationIdentity}
    (hw : ∀ holding ∈ holdings, holding.WF) (hr : requestedQuantity.WF)
    (hsel : selection = .fifo ∨ selection = .lifo ∨ selection = .hifo)
    (hvalid : Lots.validateHoldings holdings = .ok [])
    (hpos : 0 < requestedQuantity.toRat) (hlots : (lots.map (·.id)).Nodup)
    (hres : ∀ c ∈ holdings, c.remainingQuantity.isZero = false →
      Lots.lotUnresolved lots c = false)
    (hscope : ∀ c ∈ holdings, ∀ d ∈ holdings, c.remainingQuantity.isZero = false →
      d.remainingQuantity.isZero = false → Lots.mixesScope c d = false)
    (hident : ∀ c ∈ holdings, c.remainingQuantity.isZero = false → ∃ identity,
      identities.find? (fun item => item.holdingId == c.id) = some identity)
    (hdistinct : ((holdings.filter fun c => !c.remainingQuantity.isZero).map fun c =>
      (identities.find? (fun item => item.holdingId == c.id)).map (·.allocationId)).Nodup)
    (henough : requestedQuantity.toRat ≤ (holdings.map (·.remainingQuantity.toRat)).sum) :
    (∃ e, allocateLots holdings lots requestedQuantity selection derivation identities =
      .error e) ∨
    ∃ allocations after, allocateLots holdings lots requestedQuantity selection derivation
      identities = .ok (.allocated allocations after) := by
  cases hcall : allocateLots holdings lots requestedQuantity selection derivation identities with
  | error e => exact Or.inl ⟨e, rfl⟩
  | ok result =>
    refine Or.inr ?_
    rcases allocateLots_ordered_outcome hw hr hsel hvalid hpos hlots hres hscope hident hdistinct
      hcall with ⟨-, allocations, after, rfl⟩ | ⟨hlt, -⟩
    · exact ⟨allocations, after, rfl⟩
    · exact absurd henough (not_le.mpr hlt)

/-- For first in, last in and highest cost, with the holdings valid, the lots resolved and in one
scope, and an identifier supplied for the allocation of every holding with some quantity, all of
them different, a request for more than is held is rejected as an over-allocation and nothing
else: the call throws an error of the exact numbers or returns the one `lot_overallocation`
diagnostic that says the request exceeds the selected holdings. -/
theorem allocateLots_overrequest_rejected {holdings : List LotHolding} {lots : List Lot}
    {requestedQuantity : ExactRational} {selection : LotSelection} {derivation : DerivationRecord}
    {identities : List LotAllocationIdentity}
    (hw : ∀ holding ∈ holdings, holding.WF) (hr : requestedQuantity.WF)
    (hsel : selection = .fifo ∨ selection = .lifo ∨ selection = .hifo)
    (hvalid : Lots.validateHoldings holdings = .ok [])
    (hpos : 0 < requestedQuantity.toRat) (hlots : (lots.map (·.id)).Nodup)
    (hres : ∀ c ∈ holdings, c.remainingQuantity.isZero = false →
      Lots.lotUnresolved lots c = false)
    (hscope : ∀ c ∈ holdings, ∀ d ∈ holdings, c.remainingQuantity.isZero = false →
      d.remainingQuantity.isZero = false → Lots.mixesScope c d = false)
    (hident : ∀ c ∈ holdings, c.remainingQuantity.isZero = false → ∃ identity,
      identities.find? (fun item => item.holdingId == c.id) = some identity)
    (hdistinct : ((holdings.filter fun c => !c.remainingQuantity.isZero).map fun c =>
      (identities.find? (fun item => item.holdingId == c.id)).map (·.allocationId)).Nodup)
    (hover : (holdings.map (·.remainingQuantity.toRat)).sum < requestedQuantity.toRat) :
    (∃ e, allocateLots holdings lots requestedQuantity selection derivation identities =
      .error e) ∨
    allocateLots holdings lots requestedQuantity selection derivation identities =
      .ok (.rejected [diagnostic .lot_overallocation "lots"
        "Requested quantity exceeds selected holdings" ["ACC-008", "ACC-009", "ACC-023"]]) := by
  cases hcall : allocateLots holdings lots requestedQuantity selection derivation identities with
  | error e => exact Or.inl ⟨e, rfl⟩
  | ok result =>
    refine Or.inr ?_
    rcases allocateLots_ordered_outcome hw hr hsel hvalid hpos hlots hres hscope hident hdistinct
      hcall with ⟨hle, -⟩ | ⟨-, rfl⟩
    · exact absurd hover (not_lt.mpr hle)
    · rfl

end Rastrata.Kernel

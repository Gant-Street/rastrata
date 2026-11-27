/-
The model of `packages/kernel/src/accounting.ts` lines 866 to 1129: `calculateInventoryCost`,
`calculateInventoryRecosting`, `applyInventoryValueAdjustmentToHoldings`,
`calculateInventoryValueAdjustment` and `createProvisionalInventoryLayerEffect`, with the request
and result types of those lines. The head of `Accounting/Inventory.lean` says how it was modelled.
-/
import Rastrata.Kernel.Accounting.Core.Model

namespace Rastrata.Kernel

/-! ## Requests and results (`accounting.ts` lines 866 to 983) -/

/-- `InventoryCostRequest`. `specificLayerIds` is optional. -/
structure InventoryCostRequest where
  policyId : PolicyId
  policyVersion : SemanticVersion
  governedAt : Instant
  quantity : ExactRational
  layers : List InventoryLayerInput
  specificLayerIds : Option (List String)
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryCostCalculation`: the two dispositions, `costed` and `rejected`. -/
inductive InventoryCostCalculation where
  | costed (allocations : List InventoryAllocationResult) (ordinaryBasis : ExactRational)
      (provisionalQuantity : ExactRational) (provisionalBasis : ExactRational)
  | rejected (diagnostics : List SemanticDiagnostic)
  deriving DecidableEq, Repr, Inhabited

/-- `RecostInventoryRequest`. -/
structure RecostInventoryRequest where
  id : InventoryRecostingId
  layerId : ProvisionalInventoryLayerId
  resolvedAt : Instant
  sources : List InventoryRecostingSource
  derivation : DerivationRecord
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryValueAdjustmentRequest`. `evidence` is `DerivationRecord["evidence"]`. -/
structure InventoryValueAdjustmentRequest where
  id : InventoryValueAdjustmentId
  kind : InventoryValueAdjustmentKind
  effectiveOn : LocalDate
  policyEffectiveAt : Instant
  policyId : PolicyId
  policyVersion : SemanticVersion
  generatedEffectKey : EffectKey
  exactSourceAmount : ExactRational
  allocations : List InventoryValueAdjustmentAllocation
  evidence : List SourceEvidence
  derivation : DerivationRecord
  deriving DecidableEq, Repr, Inhabited

/-- What `calculateInventoryValueAdjustment` can throw: an `ExactNumberError` or the `RangeError` of
`quantize` (`QuantizeErr`), or the identity conflict of `identifier<...>` when a posting or journal
identifier is formed from the request's identifier. -/
inductive InventoryAdjustmentErr where
  | quantize (error : QuantizeErr)
  | identity (error : CanonicalErr)
  deriving DecidableEq, Repr, Inhabited

/-! ## Meaning: constructible requests -/

/-- A constructible cost request: its quantity and its layers are. -/
structure InventoryCostRequest.WF (request : InventoryCostRequest) : Prop where
  policyId : request.policyId.WF
  quantity : request.quantity.WF
  layers : ∀ layer ∈ request.layers, layer.WF

/-- A constructible recosting request. -/
structure RecostInventoryRequest.WF (request : RecostInventoryRequest) : Prop where
  id : request.id.WF
  layerId : request.layerId.WF
  sources : ∀ source ∈ request.sources, source.WF
  derivation : request.derivation.WF

/-- A constructible value adjustment request. -/
structure InventoryValueAdjustmentRequest.WF (request : InventoryValueAdjustmentRequest) : Prop where
  id : request.id.WF
  policyId : request.policyId.WF
  exactSourceAmount : request.exactSourceAmount.WF
  allocations : ∀ allocation ∈ request.allocations, allocation.WF
  evidence : ∀ item ∈ request.evidence, item.WF
  derivation : request.derivation.WF

/-! ## The pieces of `calculateInventoryCost` (`accounting.ts` lines 882 to 947) -/

namespace Inventory

/-- `Array.prototype.sort` with a comparator that does not throw, `.gt` for a positive number: an
insertion sort, which is stable (`Lots.stableSort` for a comparator that may throw). -/
def insertBy {α : Type} (cmp : α → α → Ordering) (item : α) : List α → List α
  | [] => [item]
  | next :: rest =>
    match cmp item next with
    | .gt => next :: insertBy cmp item rest
    | _ => item :: next :: rest

/-- The stable sort by a comparator that does not throw. -/
def sortBy {α : Type} (cmp : α → α → Ordering) : List α → List α
  | [] => []
  | item :: rest => insertBy cmp item (sortBy cmp rest)

/-- `directed === 0 ? compareCanonicalText(a.id, b.id) : directed` (line 907). -/
def tieBreakById (a b : InventoryLayerInput) (directed : Ordering) : Ordering :=
  if directed = .eq then compareCanonicalText a.id b.id else directed

/-- The comparator of `ordered.sort` (lines 904 to 908), `.gt` for a positive number: the unit cost
of the highest-cost method (the division can exceed the size limit), the acquisition time otherwise,
reversed for last in first out, and the identifiers break a tie. -/
def costCompare (method : InventoryCostMethod) (a b : InventoryLayerInput) :
    Except NumErr Ordering :=
  match method with
  | .hifo =>
    match b.totalBasis.divide b.quantity with
    | .error e => .error e
    | .ok bUnit =>
      match a.totalBasis.divide a.quantity with
      | .error e => .error e
      | .ok aUnit => .ok (tieBreakById a b (bUnit.compare aUnit))
  | .lifo =>
    .ok (tieBreakById a b (compareCanonicalText a.acquiredAt.value b.acquiredAt.value).swap)
  | _ => .ok (tieBreakById a b (compareCanonicalText a.acquiredAt.value b.acquiredAt.value))

/-- The test of lines 886 to 895: `true` is the rejection `inventory_cost_policy_incoherent` at
`command.inventory`, with the clauses in the TypeScript's order. -/
def costIncoherent (policy : InventoryCostPolicy) (bookId : BookId)
    (request : InventoryCostRequest) : Bool :=
  policy.bookId != bookId || policy.pools.length == 0 ||
  Lots.setSize (policy.pools.map (·.id)) != policy.pools.length ||
  decide (request.layers.length > accountingLimits.maxInventoryLayers) ||
  Lots.setSize (policy.pools.map (·.accountId)) != policy.pools.length ||
  Lots.setSize (request.layers.map (·.id)) != request.layers.length ||
  !positive request.quantity ||
  request.layers.any (fun layer => !positive layer.quantity || layer.totalBasis.isNegative ||
    !policy.pools.any (fun pool => pool.accountId == layer.accountId)) ||
  (if policy.shortageTreatment == .reject then
      policy.provisionalBasisMethod.isSome || policy.provisionalRate.isSome
    else policy.provisionalBasisMethod.isNone) ||
  ((policy.provisionalBasisMethod == some .standardCost ||
      policy.provisionalBasisMethod == some .explicitRate) &&
    (match policy.provisionalRate with
      | none => true
      | some rate => !positive rate))

/-- `ids.map((id) => layers.find((layer) => layer.id === id)).filter(defined)` (line 901). -/
def specificOrdered (layers : List InventoryLayerInput) (ids : List String) :
    List InventoryLayerInput :=
  ids.filterMap fun id => layers.find? fun layer => layer.id == id

/-- The test of line 902: the identifiers repeat, or one names no layer. -/
def specificRejected (layers : List InventoryLayerInput) (ids : List String) : Bool :=
  Lots.setSize ids != ids.length || (specificOrdered layers ids).length != ids.length

/-- Lines 898 to 909: the layers in the order they are consumed, or `none` for the rejection of
line 902. Specific identification takes the named layers in the order named, weighted average keeps
the request's order (it sorts by identifier later), and the others sort. -/
def costOrder (method : InventoryCostMethod) (request : InventoryCostRequest) :
    Except NumErr (Option (List InventoryLayerInput)) :=
  match method with
  | .specificIdentification =>
    let ids := request.specificLayerIds.getD []
    if specificRejected request.layers ids then .ok none
    else .ok (some (specificOrdered request.layers ids))
  | .weightedAverage => .ok (some request.layers)
  | method =>
    match Lots.stableSort (costCompare method) request.layers with
    | .error e => .error e
    | .ok sorted => .ok (some sorted)

/-- Line 910: the quantity the layers hold, summed in the order the TypeScript sums them (the named
layers for specific identification, the request's layers otherwise). -/
def costAvailable (method : InventoryCostMethod) (ordered : List InventoryLayerInput)
    (request : InventoryCostRequest) : Except NumErr ExactRational :=
  accountingSum ((if method = .specificIdentification then ordered else request.layers).map
    (·.quantity))

/-- Line 911: the request, or what is held when that is less. -/
def ordinaryQuantityOf (requested available : ExactRational) : ExactRational :=
  if requested.compare available = .gt then available else requested

/-- The loop of lines 927 to 932: from what is still asked, layer by layer in the order given, each
taking what is asked or the whole layer when that is less; a layer's basis is its total basis times
the quantity taken, divided by its quantity. The loop stops when nothing is asked. -/
def takeLayers : ExactRational → List InventoryLayerInput →
    Except NumErr (List InventoryAllocationResult)
  | _, [] => .ok []
  | remaining, layer :: rest =>
    if remaining.isZero then .ok []
    else
      let quantity := if remaining.compare layer.quantity = .lt then remaining else layer.quantity
      match layer.totalBasis.multiply quantity with
      | .error e => .error e
      | .ok product =>
        match product.divide layer.quantity with
        | .error e => .error e
        | .ok basis =>
          match remaining.subtract quantity with
          | .error e => .error e
          | .ok next =>
            match takeLayers next rest with
            | .error e => .error e
            | .ok later => .ok ({ layerId := layer.id, quantity, basis } :: later)

/-- The loop of lines 921 to 924 for the weighted average: each layer, in the order given, gives
its share of the quantity (its quantity times the quantity taken, over the quantity held) and the
same share of the total basis of every layer. -/
def averageShares (totalBasis ordinaryQuantity available : ExactRational) :
    List InventoryLayerInput → Except NumErr (List InventoryAllocationResult)
  | [] => .ok []
  | layer :: rest =>
    match layer.quantity.multiply ordinaryQuantity with
    | .error e => .error e
    | .ok product =>
      match product.divide available with
      | .error e => .error e
      | .ok quantity =>
        match totalBasis.multiply quantity with
        | .error e => .error e
        | .ok total =>
          match total.divide available with
          | .error e => .error e
          | .ok basis =>
            match averageShares totalBasis ordinaryQuantity available rest with
            | .error e => .error e
            | .ok later => .ok ({ layerId := layer.id, quantity, basis } :: later)

/-- The allocations (lines 916 to 933): for the weighted average, the total basis of every layer is
summed first (even when nothing is taken) and the layers are sorted by identifier; for every other
method the layers are taken in the order consumed. -/
def costAllocations (method : InventoryCostMethod) (request : InventoryCostRequest)
    (ordered : List InventoryLayerInput) (available ordinaryQuantity : ExactRational) :
    Except NumErr (List InventoryAllocationResult) :=
  if method = .weightedAverage then
    match accountingSum (request.layers.map (·.totalBasis)) with
    | .error e => .error e
    | .ok totalBasis =>
      if ordinaryQuantity.isZero then .ok []
      else
        averageShares totalBasis ordinaryQuantity available
          (sortBy (fun left right => compareCanonicalText left.id right.id) request.layers)
  else takeLayers ordinaryQuantity ordered

/-- The comparator of line 939 for the most recent receipt: later acquisition first, identifiers
breaking a tie. -/
def recentFirst (left right : InventoryLayerInput) : Ordering :=
  if left.acquiredAt = right.acquiredAt then compareCanonicalText left.id right.id
  else compareCanonicalText right.acquiredAt.value left.acquiredAt.value

/-- `[...layers].sort(...)[0]` (line 939): the most recent receipt. -/
def lastReceipt (layers : List InventoryLayerInput) : Option InventoryLayerInput :=
  (sortBy recentFirst layers).head?

/-- The rate of lines 935 to 941: zero when nothing is short; the policy's rate for the standard
cost and the explicit rate; for the moving average the average cost of what was taken, none when
nothing was; otherwise the unit cost of the most recent receipt, none when there is none. -/
def provisionalRateOf (policy : InventoryCostPolicy) (request : InventoryCostRequest)
    (provisionalQuantity ordinaryQuantity ordinaryBasis : ExactRational) :
    Except NumErr (Option ExactRational) :=
  if provisionalQuantity.isZero then .ok (some ExactRational.zero)
  else
    match policy.provisionalBasisMethod with
    | some .standardCost => .ok policy.provisionalRate
    | some .explicitRate => .ok policy.provisionalRate
    | some .movingAverage =>
      if ordinaryQuantity.isZero then .ok none
      else
        match ordinaryBasis.divide ordinaryQuantity with
        | .error e => .error e
        | .ok rate => .ok (some rate)
    | _ =>
      match lastReceipt request.layers with
      | none => .ok none
      | some last =>
        match last.totalBasis.divide last.quantity with
        | .error e => .error e
        | .ok rate => .ok (some rate)

/-- The test of line 942: no rate, a negative rate, or a zero rate for a shortage. -/
def rateRejected (provisionalQuantity : ExactRational) : Option ExactRational → Bool
  | none => true
  | some rate => rate.isNegative || (!provisionalQuantity.isZero && rate.isZero)

/-- The diagnostic of line 896. -/
def incoherentDiagnostic : SemanticDiagnostic :=
  diagnostic .inventory_cost_policy_incoherent "command.inventory"
    "Inventory pool, quantity, and basis must be complete and coherent"
    ["ACC-039.2", "ACC-039.4", "ACC-039.5"]

/-- The diagnostic of line 902. -/
def specificDiagnostic : SemanticDiagnostic :=
  diagnostic .inventory_cost_policy_incoherent "command.inventory.specificLayerIds"
    "Specific inventory selection is unresolved or duplicated" ["ACC-039.3", "ACC-039.6"]

/-- The diagnostic of line 914. -/
def shortageDiagnostic : SemanticDiagnostic :=
  diagnostic .provisional_inventory_violation "command.inventory.quantity"
    "Inventory shortage is not authorized by a complete provisional policy"
    ["ACC-040.1", "ACC-040.2"]

/-- The diagnostic of line 943. -/
def rateDiagnostic : SemanticDiagnostic :=
  diagnostic .provisional_inventory_violation "command.inventory.provisionalBasis"
    "The declared provisional basis method cannot resolve one positive exact rate"
    ["ACC-040.1", "ACC-040.2"]

end Inventory

/-- `calculateInventoryCost` (`accounting.ts` line 882). The first exact operation that throws ends
it with its error. -/
def calculateInventoryCost (policies : List AccountingPolicy) (bookId : BookId)
    (request : InventoryCostRequest) : Except NumErr InventoryCostCalculation :=
  match policyAt InventoryCostPolicy policies request.policyId request.policyVersion
      request.governedAt with
  | .rejected diagnostics => .ok (.rejected diagnostics)
  | .selected policy =>
    if Inventory.costIncoherent policy bookId request then
      .ok (.rejected [Inventory.incoherentDiagnostic])
    else
      match Inventory.costOrder policy.method request with
      | .error e => .error e
      | .ok none => .ok (.rejected [Inventory.specificDiagnostic])
      | .ok (some ordered) =>
        match Inventory.costAvailable policy.method ordered request with
        | .error e => .error e
        | .ok available =>
          let ordinaryQuantity := Inventory.ordinaryQuantityOf request.quantity available
          match request.quantity.subtract ordinaryQuantity with
          | .error e => .error e
          | .ok provisionalQuantity =>
            if !provisionalQuantity.isZero &&
                (policy.shortageTreatment == .reject || policy.provisionalBasisMethod.isNone) then
              .ok (.rejected [Inventory.shortageDiagnostic])
            else
              match Inventory.costAllocations policy.method request ordered available
                  ordinaryQuantity with
              | .error e => .error e
              | .ok allocations =>
                match accountingSum (allocations.map (·.basis)) with
                | .error e => .error e
                | .ok ordinaryBasis =>
                  match Inventory.provisionalRateOf policy request provisionalQuantity
                      ordinaryQuantity ordinaryBasis with
                  | .error e => .error e
                  | .ok rate =>
                    if Inventory.rateRejected provisionalQuantity rate then
                      .ok (.rejected [Inventory.rateDiagnostic])
                    else
                      match provisionalQuantity.multiply (rate.getD ExactRational.zero) with
                      | .error e => .error e
                      | .ok provisionalBasis =>
                        .ok (.costed allocations ordinaryBasis provisionalQuantity provisionalBasis)

/-! ## `calculateInventoryRecosting` (`accounting.ts` lines 956 to 969) -/

namespace Inventory

/-- The quantities of line 958: every source of every recosting of the layer, in the order of the
state. -/
def priorQuantities (state : AccountingCanonicalState) (layerId : ProvisionalInventoryLayerId) :
    List ExactRational :=
  (state.inventoryRecostings.filter fun item => item.layerId == layerId).flatMap fun item =>
    item.sources.map (·.quantity)

/-- The test of line 961 after the layer is found: the derivation is not approved with evidence and
a time, or is of another policy than the layer's; there is no source, or more than the limit, or a
receipt twice; a source has no quantity or a negative basis; the sources resolve more than is left. -/
def recostingRejected (request : RecostInventoryRequest) (layer : ProvisionalInventoryLayer)
    (sourceQuantity remaining : ExactRational) : Bool :=
  !validAccountingDerivation request.derivation || request.derivation.policyId != layer.policyId ||
  request.sources.length == 0 ||
  decide (request.sources.length > accountingLimits.maxRecostingSources) ||
  Lots.setSize (request.sources.map (·.receiptId)) != request.sources.length ||
  request.sources.any (fun source => !positive source.quantity || source.totalBasis.isNegative) ||
  sourceQuantity.compare remaining == .gt

/-- The diagnostic of line 962. -/
def recostingDiagnostic : SemanticDiagnostic :=
  diagnostic .provisional_inventory_violation "command.recosting"
    "Recosting must resolve an existing layer without quantity over-allocation" ["ACC-040.3"]

/-- The rejection of line 962. -/
def recostingRejection : AccountingCalculation :=
  reject .provisional_inventory_violation "command.recosting"
    "Recosting must resolve an existing layer without quantity over-allocation" ["ACC-040.3"]

/-- The rejection of line 962 holds the one diagnostic. -/
theorem recostingRejection_eq : recostingRejection = .rejected [recostingDiagnostic] := rfl

/-- The recosting of lines 966 and 967 without its hash: the request's identifier, layer, time,
sources and derivation, and the adjustment. -/
def recostingBody (request : RecostInventoryRequest) (adjustment : ExactRational) :
    InventoryRecosting :=
  { id := request.id, layerId := request.layerId, resolvedAt := request.resolvedAt,
    sources := request.sources, adjustment, derivation := request.derivation,
    contentHash := default }

/-- The recosting of lines 966 and 967: the body, with the `accountingHash` of the body as its
hash. -/
def recostingEffect (request : RecostInventoryRequest) (adjustment : ExactRational) :
    InventoryRecosting :=
  let body := recostingBody request adjustment
  { body with contentHash := accountingBodyHash "InventoryRecosting" body }

end Inventory

/-- `calculateInventoryRecosting` (`accounting.ts` line 956). The prior quantity is summed before the
layer is looked at, and the quantity of the sources before any test, so a sum that throws ends the
function even for a request that is then rejected. -/
def calculateInventoryRecosting (state : AccountingCanonicalState)
    (request : RecostInventoryRequest) : Except NumErr AccountingCalculation :=
  match accountingSum (Inventory.priorQuantities state request.layerId) with
  | .error e => .error e
  | .ok prior =>
    match state.provisionalInventoryLayers.find? (fun candidate => candidate.id == request.layerId)
    with
    | none =>
      match accountingSum (request.sources.map (·.quantity)) with
      | .error e => .error e
      | .ok _ => .ok Inventory.recostingRejection
    | some layer =>
      match layer.quantity.subtract prior with
      | .error e => .error e
      | .ok remaining =>
        match accountingSum (request.sources.map (·.quantity)) with
        | .error e => .error e
        | .ok sourceQuantity =>
          if Inventory.recostingRejected request layer sourceQuantity remaining then
            .ok Inventory.recostingRejection
          else
            match accountingSum (request.sources.map (·.totalBasis)) with
            | .error e => .error e
            | .ok finalBasis =>
              match layer.provisionalBasis.multiply sourceQuantity with
              | .error e => .error e
              | .ok product =>
                match product.divide layer.quantity with
                | .error e => .error e
                | .ok provisionalShare =>
                  match finalBasis.subtract provisionalShare with
                  | .error e => .error e
                  | .ok adjustment =>
                    .ok (drafted [] [.inventoryRecosting (Inventory.recostingEffect request adjustment)])

/-! ## `applyInventoryValueAdjustmentToHoldings` (`accounting.ts` lines 985 to 1002) -/

namespace Inventory

/-- The callback of `holdings.map` (lines 991 to 1000): a holding with no allocation is itself; a
holding with one has its total basis and its valuation allowance changed, and its carrying amount
is their sum. `byHolding` is the map of line 989, whose last entry for a key wins. -/
def adjustHolding (byHolding : List (LotHoldingId × InventoryValueAdjustmentAllocation))
    (holding : LotHolding) : Except NumErr LotHolding :=
  match Lots.mapGet byHolding holding.id with
  | none => .ok holding
  | some allocation =>
    match holding.remainingTotalBasis.add allocation.remainingBasisChange with
    | .error e => .error e
    | .ok remainingTotalBasis =>
      match holding.remainingValuationAllowance.add allocation.remainingValuationAllowanceChange
      with
      | .error e => .error e
      | .ok remainingValuationAllowance =>
        match remainingTotalBasis.add remainingValuationAllowance with
        | .error e => .error e
        | .ok carrying =>
          .ok { holding with
                  remainingTotalBasis := remainingTotalBasis
                  remainingValuationAllowance := remainingValuationAllowance
                  remainingCarryingAmount := carrying }

/-- `holdings.map(callback)`: the holdings in order, the first that throws ends it. -/
def adjustHoldings (byHolding : List (LotHoldingId × InventoryValueAdjustmentAllocation)) :
    List LotHolding → Except NumErr (List LotHolding)
  | [] => .ok []
  | holding :: rest =>
    match adjustHolding byHolding holding with
    | .error e => .error e
    | .ok adjusted =>
      match adjustHoldings byHolding rest with
      | .error e => .error e
      | .ok later => .ok (adjusted :: later)

/-- The map of line 989: the allocations that name a holding, keyed by it. -/
def allocationsByHolding (allocations : List InventoryValueAdjustmentAllocation) :
    List (LotHoldingId × InventoryValueAdjustmentAllocation) :=
  allocations.filterMap fun allocation => allocation.holdingId.map fun id => (id, allocation)

end Inventory

/-- `applyInventoryValueAdjustmentToHoldings` (`accounting.ts` line 985). -/
def applyInventoryValueAdjustmentToHoldings (holdings : List LotHolding)
    (allocations : List InventoryValueAdjustmentAllocation) : Except NumErr (List LotHolding) :=
  Inventory.adjustHoldings (Inventory.allocationsByHolding allocations) holdings

/-! ## The pieces of `calculateInventoryValueAdjustment` (`accounting.ts` lines 1004 to 1129) -/

namespace Inventory

/-- `capitalizable` (line 1022): the three kinds that change the historical basis. -/
def capitalizable (kind : InventoryValueAdjustmentKind) : Bool :=
  kind == .directlyAttributableCost || kind == .purchaseRebate || kind == .productionOverhead

/-- `linkedInventoryPolicies` (line 1015): the inventory cost policies the value adjustment policy
names, in force at the effective time (instants compared as texts). -/
def linkedInventoryPolicies (policies : List AccountingPolicy)
    (policy : InventoryValueAdjustmentPolicy) (at_ : Instant) : List InventoryCostPolicy :=
  policies.filterMap fun candidate =>
    match candidate with
    | .inventoryCost cost =>
      if cost.id == policy.inventoryCostPolicyId && cost.version == policy.inventoryCostPolicyVersion &&
          jsStringLe cost.validFrom.value at_.value &&
          (match cost.validTo with
            | none => true
            | some validTo => jsStringLt at_.value validTo.value) then some cost
      else none
    | _ => none

/-- `values.map(f)` for a function that can throw: in order, the first that throws ends it. -/
def mapAll {α : Type} (f : α → Except NumErr ExactRational) :
    List α → Except NumErr (List ExactRational)
  | [] => .ok []
  | value :: rest =>
    match f value with
    | .error e => .error e
    | .ok mappedValue =>
      match mapAll f rest with
      | .error e => .error e
      | .ok later => .ok (mappedValue :: later)

/-- `sum(values.map(f))` for a function that can throw: every value is mapped first, in order,
then the results are summed from the left. -/
def sumMapped {α : Type} (f : α → Except NumErr ExactRational) (values : List α) :
    Except NumErr ExactRational :=
  match mapAll f values with
  | .error e => .error e
  | .ok totals => accountingSum totals

/-- What one allocation adds up to (line 1025): `basis.add(recognized).add(allowance)`. -/
def allocationTotal (allocation : InventoryValueAdjustmentAllocation) :
    Except NumErr ExactRational :=
  match allocation.remainingBasisChange.add allocation.recognizedCostChange with
  | .error e => .error e
  | .ok sofar => sofar.add allocation.remainingValuationAllowanceChange

/-- `exactAllocated` (line 1025). -/
def exactAllocated (allocations : List InventoryValueAdjustmentAllocation) :
    Except NumErr ExactRational :=
  sumMapped allocationTotal allocations

/-- The test of one lot in `lotPopulationValid` (lines 1028 and 1029). -/
def lotValid (bookId : BookId) (functionalCommodityId : CommodityId) (lot : Lot) : Bool :=
  lot.bookId == bookId && positive lot.acquisitionQuantity &&
  !lot.acquisitionTotalBasis.isNegative && lot.basisCommodityId == functionalCommodityId &&
  decide (lot.evidenceIds.length > 0)

/-- `lotPopulationValid` (line 1027): the lots have distinct identifiers (the size of the map is the
length of the list) and each is valid. -/
def lotPopulationValid (bookId : BookId) (functionalCommodityId : CommodityId) (lots : List Lot) :
    Bool :=
  Lots.setSize (lots.map (·.id)) == lots.length && lots.all (lotValid bookId functionalCommodityId)

/-- The test of one holding in `holdingPopulationValid` (lines 1032 to 1041), clause by clause as the
TypeScript's `&&` reads: the sum of basis and allowance is computed only if every clause before it
holds, and can throw. -/
def holdingValid (policy : InventoryValueAdjustmentPolicy) (bookId : BookId)
    (functionalCommodityId : CommodityId) (lots : List Lot) (holding : LotHolding) :
    Except NumErr Bool :=
  match Lots.lotById lots holding.lotId with
  | none => .ok false
  | some lot =>
    if holding.bookId == bookId &&
        (policy.algorithmVersion.value != "1.0.0" || holding.accountId == policy.inventoryAccountId) &&
        holding.commodityId == lot.commodityId && holding.basisCommodityId == functionalCommodityId &&
        !holding.remainingQuantity.isNegative && !holding.remainingTotalBasis.isNegative &&
        holding.remainingValuationAllowance.compare ExactRational.zero != .gt then
      match holding.remainingTotalBasis.add holding.remainingValuationAllowance with
      | .error e => .error e
      | .ok carrying =>
        .ok (holding.remainingCarryingAmount.equals carrying &&
          (!holding.remainingQuantity.isZero ||
            (holding.remainingTotalBasis.isZero && holding.remainingValuationAllowance.isZero &&
              holding.remainingCarryingAmount.isZero)))
    else .ok false

/-- `holdings.every(...)`: it stops at the first holding that fails, or throws. -/
def holdingsAllValid (policy : InventoryValueAdjustmentPolicy) (bookId : BookId)
    (functionalCommodityId : CommodityId) (lots : List Lot) :
    List LotHolding → Except NumErr Bool
  | [] => .ok true
  | holding :: rest =>
    match holdingValid policy bookId functionalCommodityId lots holding with
    | .error e => .error e
    | .ok false => .ok false
    | .ok true => holdingsAllValid policy bookId functionalCommodityId lots rest

/-- `holdingPopulationValid` (line 1031): the holdings have distinct identifiers and each is valid. -/
def holdingPopulationValid (policy : InventoryValueAdjustmentPolicy) (bookId : BookId)
    (functionalCommodityId : CommodityId) (lots : List Lot) (holdings : List LotHolding) :
    Except NumErr Bool :=
  if Lots.setSize (holdings.map (·.id)) == holdings.length then
    holdingsAllValid policy bookId functionalCommodityId lots holdings
  else .ok false

/-- `allocationSignsValid` (line 1043): a purchase rebate lowers basis and cost (not above zero), the
other two capitalized kinds raise them (not below zero), none touches the allowance; a write-down or
reversal touches neither basis nor cost. -/
def allocationSignsValid (kind : InventoryValueAdjustmentKind)
    (allocations : List InventoryValueAdjustmentAllocation) : Bool :=
  allocations.all fun allocation =>
    if capitalizable kind then
      if kind == .purchaseRebate then
        allocation.remainingBasisChange.compare ExactRational.zero != .gt &&
          allocation.recognizedCostChange.compare ExactRational.zero != .gt &&
          allocation.remainingValuationAllowanceChange.isZero
      else
        !allocation.remainingBasisChange.isNegative && !allocation.recognizedCostChange.isNegative &&
          allocation.remainingValuationAllowanceChange.isZero
    else allocation.remainingBasisChange.isZero && allocation.recognizedCostChange.isZero

/-- What line 1065 compares to find two allocations of one target: for the current algorithm the
pair, which `JSON.stringify([lotId, holdingId ?? null])` encodes without loss; for the two earlier
algorithms the text `lotId:holdingId`, with `disposed` for none, which can coincide for different
pairs. -/
inductive AllocationKey where
  | pair (lotId : LotId) (holdingId : Option LotHoldingId)
  | text (text : String)
  deriving DecidableEq, Repr, Inhabited

/-- The key of an allocation under the policy's algorithm version (lines 1065 to 1067). -/
def allocationKey (version : SemanticVersion) (allocation : InventoryValueAdjustmentAllocation) :
    AllocationKey :=
  if version.value == "1.0.2" then .pair allocation.lotId allocation.holdingId
  else .text (allocation.lotId.value ++ ":" ++ (allocation.holdingId.map (·.value)).getD "disposed")

/-- `holdingById` (line 1024): the map of the holdings by identifier, as the list of its entries. -/
def holdingEntries (holdings : List LotHolding) : List (LotHoldingId × LotHolding) :=
  holdings.map fun holding => (holding.id, holding)

/-- The callback of `request.allocations.some` at line 1068 for the allocation at `index`, clause by
clause: the ordinal is not `index + 1`, no lot has the identifier, or the named holding is not of
that lot and the policy's inventory account. -/
def allocationMisplaced (policy : InventoryValueAdjustmentPolicy) (lots : List Lot)
    (holdings : List LotHolding) (index : Nat) (allocation : InventoryValueAdjustmentAllocation) :
    Bool :=
  allocation.ordinal != ((index + 1 : Nat) : Int) ||
  !lots.any (fun lot => lot.id == allocation.lotId) ||
  (match allocation.holdingId with
    | none => false
    | some holdingId =>
      ((Lots.mapGet (holdingEntries holdings) holdingId).map (·.lotId)) != some allocation.lotId ||
      ((Lots.mapGet (holdingEntries holdings) holdingId).map (·.accountId)) !=
        some policy.inventoryAccountId)

/-- `request.allocations.some((allocation, index) => ...)` from position `index`. -/
def anyMisplaced (policy : InventoryValueAdjustmentPolicy) (lots : List Lot)
    (holdings : List LotHolding) :
    Nat → List InventoryValueAdjustmentAllocation → Bool
  | _, [] => false
  | index, allocation :: rest =>
    allocationMisplaced policy lots holdings index allocation ||
      anyMisplaced policy lots holdings (index + 1) rest

/-- The test of lines 1053 to 1069, every clause in the TypeScript's order; `true` is the rejection of
line 1070. `linked` is `linkedInventoryPolicies`, `allocated` is `exactAllocated`. The clauses about
the one linked policy are read only when there is exactly one. -/
def identityRejected (policy : InventoryValueAdjustmentPolicy) (linked : List InventoryCostPolicy)
    (bookId : BookId) (functionalCommodityId : CommodityId) (lots : List Lot)
    (holdings : List LotHolding) (request : InventoryValueAdjustmentRequest)
    (lotPopulation holdingPopulation : Bool) (allocated : ExactRational) : Bool :=
  policy.bookId != bookId || policy.quantizationPolicy.functionalCommodityId != functionalCommodityId ||
  linked.length != 1 ||
  (match linked with
    | [linkedPolicy] =>
      linkedPolicy.bookId != bookId ||
      linkedPolicy.quantizationPolicy.functionalCommodityId != functionalCommodityId ||
      !contentHashEquals (hashQuantizationPolicy policy.quantizationPolicy)
        (hashQuantizationPolicy linkedPolicy.quantizationPolicy) ||
      !linkedPolicy.pools.any (fun pool => pool.accountId == policy.inventoryAccountId)
    | _ => false) ||
  !lotPopulation || !holdingPopulation ||
  !policy.allowedKinds.contains request.kind || request.allocations.length == 0 ||
  decide (request.allocations.length > accountingLimits.maxInventoryLayers) ||
  request.evidence.length == 0 ||
  !request.evidence.all (fun item =>
    request.derivation.evidence.any (fun evidence => evidence.id == item.id)) ||
  !validAccountingDerivation request.derivation ||
  request.derivation.policyId != policy.id || request.derivation.policyVersion != policy.version ||
  request.exactSourceAmount.isZero ||
  (jsTrim request.generatedEffectKey.value).length == 0 ||
  !allocated.equals request.exactSourceAmount ||
  Lots.setSize (request.allocations.map (·.ordinal)) != request.allocations.length ||
  Lots.setSize (request.allocations.map (allocationKey policy.algorithmVersion)) !=
    request.allocations.length ||
  anyMisplaced policy lots holdings 0 request.allocations ||
  policy.inventoryAccountId == policy.recognizedCostAccountId ||
  policy.inventoryAccountId == policy.adjustmentAccountId ||
  policy.recognizedCostAccountId == policy.adjustmentAccountId

/-- The test of lines 1071 to 1075: a direct cost or overhead whose amount is not above zero, or a
purchase rebate whose amount is not below zero. -/
def sourceSignRejected (kind : InventoryValueAdjustmentKind) (amount : ExactRational) : Bool :=
  if capitalizable kind then
    (if kind == .purchaseRebate then amount.compare ExactRational.zero != .lt
      else amount.compare ExactRational.zero != .gt)
  else false

/-- The test of lines 1077 to 1080. -/
def combinedRejected (kind : InventoryValueAdjustmentKind)
    (allocations : List InventoryValueAdjustmentAllocation) : Bool :=
  if capitalizable kind then
    allocations.any fun allocation => !allocation.remainingValuationAllowanceChange.isZero
  else
    allocations.any fun allocation =>
      !allocation.remainingBasisChange.isZero || !allocation.recognizedCostChange.isZero

/-- The callback of `request.allocations.some` at line 1082: the allocation does not target a live
holding, or a lot whose holdings are all depleted, with the component that target allows. -/
def targetRejected (holdings : List LotHolding)
    (allocation : InventoryValueAdjustmentAllocation) : Bool :=
  match allocation.holdingId.bind (fun id => Lots.mapGet (holdingEntries holdings) id) with
  | none =>
    (holdings.filter fun candidate => candidate.lotId == allocation.lotId).any
        (fun candidate => !candidate.remainingQuantity.isZero) ||
      !allocation.remainingBasisChange.isZero || !allocation.remainingValuationAllowanceChange.isZero
  | some holding =>
    if holding.remainingQuantity.isZero then true else !allocation.recognizedCostChange.isZero

/-- The test of line 1098: a write-down whose amount is not below zero, or a reversal whose amount
is not above zero. -/
def amountDirectionRejected (kind : InventoryValueAdjustmentKind) (amount : ExactRational) : Bool :=
  (kind == .writeDown && amount.compare ExactRational.zero != .lt) ||
    (kind == .writeDownReversal && amount.compare ExactRational.zero != .gt)

/-- `allowanceDirectionValid` (line 1101): every allocation of a write-down lowers the allowance,
every allocation of a reversal raises it. -/
def allowanceDirectionValid (kind : InventoryValueAdjustmentKind)
    (allocations : List InventoryValueAdjustmentAllocation) : Bool :=
  allocations.all fun allocation =>
    match kind with
    | .writeDown => allocation.remainingValuationAllowanceChange.compare ExactRational.zero == .lt
    | .writeDownReversal =>
      allocation.remainingValuationAllowanceChange.compare ExactRational.zero == .gt
    | _ => true

/-- The test of line 1108 on the holdings after the adjustment: one has a negative total basis or
carrying amount, or an allowance above zero. -/
def resultingRejected (resulting : List LotHolding) : Bool :=
  resulting.any fun holding =>
    holding.remainingTotalBasis.isNegative || holding.remainingCarryingAmount.isNegative ||
      holding.remainingValuationAllowance.compare ExactRational.zero == .gt

/-- The diagnostic of line 1070. -/
def identityDiagnostic : SemanticDiagnostic :=
  diagnostic .inventory_value_adjustment_violation "command.inventoryValueAdjustment"
    "Inventory value adjustment identity, policy, evidence, allocation population, and exact conservation must be complete"
    ["ACC-039.2", "ACC-039.4", "ACC-039.5"]

/-- The diagnostic of line 1075. -/
def sourceSignDiagnostic : SemanticDiagnostic :=
  diagnostic .inventory_value_adjustment_violation
    "command.inventoryValueAdjustment.exactSourceAmount"
    "Direct costs and overhead must be positive; purchase rebates must be negative" ["ACC-039.5"]

/-- The diagnostic of line 1076. -/
def signsDiagnostic : SemanticDiagnostic :=
  diagnostic .inventory_value_adjustment_violation "command.inventoryValueAdjustment.allocations"
    "Inventory value adjustment allocations must use the component sign required by their kind"
    ["ACC-039.4", "ACC-039.5"]

/-- The diagnostic of line 1081. -/
def combinedDiagnostic : SemanticDiagnostic :=
  diagnostic .inventory_value_adjustment_violation "command.inventoryValueAdjustment.allocations"
    "Historical-basis changes and valuation-allowance changes are distinct and may not be combined"
    ["ACC-039.4", "ACC-039.5"]

/-- The diagnostic of line 1097. -/
def targetDiagnostic : SemanticDiagnostic :=
  diagnostic .inventory_value_adjustment_violation "command.inventoryValueAdjustment.allocations"
    "Each adjustment allocation must target a live holding or a fully disposed lot with the correct basis/recognition component"
    ["ACC-039.4", "ACC-039.5"]

/-- The diagnostic of line 1099. -/
def amountDirectionDiagnostic : SemanticDiagnostic :=
  diagnostic .inventory_value_adjustment_violation
    "command.inventoryValueAdjustment.exactSourceAmount"
    "Write-downs must reduce allowance and reversals must increase it" ["ACC-039.4", "ACC-039.5"]

/-- The diagnostic of line 1106. -/
def allowanceDirectionDiagnostic : SemanticDiagnostic :=
  diagnostic .inventory_value_adjustment_violation "command.inventoryValueAdjustment.allocations"
    "Write-down allocations must reduce allowance and reversals must increase it"
    ["ACC-039.4", "ACC-039.5"]

/-- The diagnostic of line 1109. -/
def resultingDiagnostic : SemanticDiagnostic :=
  diagnostic .inventory_value_adjustment_violation "command.inventoryValueAdjustment.allocations"
    "An adjustment may not create negative historical basis or carrying amount, or reverse beyond accumulated write-downs"
    ["ACC-039.4", "ACC-039.5"]

/-- The rejection, if there is one, of lines 1025 to 1110, in the TypeScript's order: the sum of
the allocations and the population of holdings are computed first (either can throw), then the tests
of lines 1052 to 1109 one after another, the last on the holdings after the adjustment (which can
throw). `none` means that none rejects. -/
def adjustmentRejection (policies : List AccountingPolicy) (bookId : BookId)
    (functionalCommodityId : CommodityId) (lots : List Lot) (holdings : List LotHolding)
    (request : InventoryValueAdjustmentRequest) (policy : InventoryValueAdjustmentPolicy) :
    Except NumErr (Option SemanticDiagnostic) :=
  match exactAllocated request.allocations with
  | .error e => .error e
  | .ok allocated =>
    match holdingPopulationValid policy bookId functionalCommodityId lots holdings with
    | .error e => .error e
    | .ok holdingPopulation =>
      if identityRejected policy (linkedInventoryPolicies policies policy request.policyEffectiveAt)
          bookId functionalCommodityId lots holdings request
          (lotPopulationValid bookId functionalCommodityId lots) holdingPopulation allocated then
        .ok (some identityDiagnostic)
      else if sourceSignRejected request.kind request.exactSourceAmount then
        .ok (some sourceSignDiagnostic)
      else if !allocationSignsValid request.kind request.allocations then
        .ok (some signsDiagnostic)
      else if combinedRejected request.kind request.allocations then
        .ok (some combinedDiagnostic)
      else if request.allocations.any (targetRejected holdings) then
        .ok (some targetDiagnostic)
      else if amountDirectionRejected request.kind request.exactSourceAmount then
        .ok (some amountDirectionDiagnostic)
      else if !allowanceDirectionValid request.kind request.allocations then
        .ok (some allowanceDirectionDiagnostic)
      else
        match applyInventoryValueAdjustmentToHoldings holdings request.allocations with
        | .error e => .error e
        | .ok resulting =>
          if resultingRejected resulting then .ok (some resultingDiagnostic) else .ok none

/-- An exact-number error as an error of `calculateInventoryValueAdjustment`. -/
def liftNum {α : Type} : Except NumErr α → Except InventoryAdjustmentErr α
  | .ok value => .ok value
  | .error e => .error (.quantize (.exactNumber e))

/-- An identity conflict as an error of `calculateInventoryValueAdjustment`. -/
def liftId {α : Type} : Except CanonicalErr α → Except InventoryAdjustmentErr α
  | .ok value => .ok value
  | .error e => .error (.identity e)

/-- A posting of the adjustment's journal (lines 1114 to 1116): its units and its book value are one
amount in the functional commodity, with no cost basis. -/
def adjustmentPosting (id : PostingId) (accountId : AccountId) (functionalCommodityId : CommodityId)
    (amount : ExactRational) : ExactPreparedPosting :=
  { id, accountId, units := amount, unitsCommodityId := functionalCommodityId,
    exactBookValue := amount, costBasis := none }

/-- The postings of lines 1113 to 1116: the inventory posting when the change is not zero, the
posting of the recognized cost when it is not zero, and the posting of the adjustment account, which
carries the amount with its sign changed. Each identifier is formed from the request's (`identifier`
can throw), in this order. -/
def adjustmentPostings (request : InventoryValueAdjustmentRequest)
    (policy : InventoryValueAdjustmentPolicy) (functionalCommodityId : CommodityId)
    (inventoryChange recognizedCostChange : ExactRational) :
    Except CanonicalErr (List ExactPreparedPosting) :=
  match (if inventoryChange.isZero then (Except.ok [] : Except CanonicalErr (List ExactPreparedPosting))
      else
        match postingId (request.id.value ++ "-inventory") with
        | .error e => .error e
        | .ok id =>
          .ok [adjustmentPosting id policy.inventoryAccountId functionalCommodityId inventoryChange])
  with
  | .error e => .error e
  | .ok inventoryPostings =>
    match (if recognizedCostChange.isZero then
        (Except.ok [] : Except CanonicalErr (List ExactPreparedPosting))
      else
        match postingId (request.id.value ++ "-recognized-cost") with
        | .error e => .error e
        | .ok id =>
          .ok [adjustmentPosting id policy.recognizedCostAccountId functionalCommodityId
            recognizedCostChange])
    with
    | .error e => .error e
    | .ok costPostings =>
      match postingId (request.id.value ++ "-adjustment") with
      | .error e => .error e
      | .ok adjustmentId =>
        .ok (inventoryPostings ++ costPostings ++
          [adjustmentPosting adjustmentId policy.adjustmentAccountId functionalCommodityId
            request.exactSourceAmount.negate])

/-- The effect of lines 1117 to 1122, without its hash. -/
def adjustmentBody (bookId : BookId) (policy : InventoryValueAdjustmentPolicy)
    (request : InventoryValueAdjustmentRequest) (bookedAdjustment : QuantizedValue) :
    InventoryValueAdjustment :=
  { id := request.id, kind := request.kind, effectiveOn := request.effectiveOn,
    generatedEffectKey := request.generatedEffectKey, bookId, policy,
    exactSourceAmount := request.exactSourceAmount, allocations := request.allocations,
    bookedAdjustment, evidence := request.evidence, derivation := request.derivation,
    contentHash := default }

/-- The effect of lines 1117 to 1122: the body, with the `accountingHash` of the body as its hash. -/
def adjustmentEffect (bookId : BookId) (policy : InventoryValueAdjustmentPolicy)
    (request : InventoryValueAdjustmentRequest) (bookedAdjustment : QuantizedValue) :
    InventoryValueAdjustment :=
  let body := adjustmentBody bookId policy request bookedAdjustment
  { body with contentHash := accountingBodyHash "InventoryValueAdjustment" body }

/-- The journal of lines 1123 to 1127. -/
def adjustmentJournal (request : InventoryValueAdjustmentRequest) (id : JournalId)
    (postings : List ExactPreparedPosting) : ExactPreparedJournal :=
  { requiredQuantizationPolicy := none, id, kind := .adjustment,
    economicAt := request.policyEffectiveAt, accountingDate := request.effectiveOn,
    recordedAt := request.policyEffectiveAt, narration := "Inventory value adjustment",
    postings, derivations := [request.derivation] }

/-- Lines 1111 to 1128, after every test has passed: the inventory change and the recognized cost
change are summed, the postings and the booked adjustment are made, then the effect and the
journal, each step able to throw. -/
def adjustmentDraft (bookId : BookId) (functionalCommodityId : CommodityId)
    (policy : InventoryValueAdjustmentPolicy) (request : InventoryValueAdjustmentRequest) :
    Except InventoryAdjustmentErr AccountingCalculation :=
  match liftNum (sumMapped
      (fun allocation => allocation.remainingBasisChange.add allocation.remainingValuationAllowanceChange)
      request.allocations) with
  | .error e => .error e
  | .ok inventoryChange =>
    match liftNum (accountingSum (request.allocations.map (·.recognizedCostChange))) with
    | .error e => .error e
    | .ok recognizedCostChange =>
      match liftId (adjustmentPostings request policy functionalCommodityId inventoryChange
          recognizedCostChange) with
      | .error e => .error e
      | .ok postings =>
        match quantize request.exactSourceAmount policy.quantizationPolicy.rule with
        | .error e => .error (.quantize e)
        | .ok bookedAdjustment =>
          match liftId (journalId (request.id.value ++ "-journal")) with
          | .error e => .error e
          | .ok id =>
            .ok (drafted [adjustmentJournal request id postings]
              [.inventoryValueAdjustment (adjustmentEffect bookId policy request bookedAdjustment)])

end Inventory

/-- `calculateInventoryValueAdjustment` (`accounting.ts` line 1004). -/
def calculateInventoryValueAdjustment (policies : List AccountingPolicy) (bookId : BookId)
    (functionalCommodityId : CommodityId) (lots : List Lot) (holdings : List LotHolding)
    (request : InventoryValueAdjustmentRequest) :
    Except InventoryAdjustmentErr AccountingCalculation :=
  match policyAt InventoryValueAdjustmentPolicy policies request.policyId request.policyVersion
      request.policyEffectiveAt with
  | .rejected diagnostics => .ok (.rejected diagnostics)
  | .selected policy =>
    match Inventory.liftNum (Inventory.adjustmentRejection policies bookId functionalCommodityId
        lots holdings request policy) with
    | .error e => .error e
    | .ok (some rejection) => .ok (.rejected [rejection])
    | .ok none => Inventory.adjustmentDraft bookId functionalCommodityId policy request

/-- `createProvisionalInventoryLayerEffect` (`accounting.ts` line 875): the layer, with the
`accountingHash` of the layer as its hash. -/
def createProvisionalInventoryLayerEffect (value : ProvisionalInventoryLayerBody) :
    AccountingEffect :=
  .provisionalInventoryLayer
    { toProvisionalInventoryLayerBody := value,
      contentHash := accountingHash "ProvisionalInventoryLayer" value }

end Rastrata.Kernel

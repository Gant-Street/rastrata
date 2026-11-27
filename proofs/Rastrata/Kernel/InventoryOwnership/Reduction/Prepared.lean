/-
What a prepared reduction is made of: `prepareInventoryPostedReduction` returns `prepared` exactly
through the six tests passing, every exact operation returning, the planned share quantized, the
recorded consumption matching, the allocation test passing and the posted components (if any)
allocated; `ReductionView` names every value it computed on the way. The laws of a reduction
(`Reduction/Laws.lean`) are read off this view.
-/
import Rastrata.Kernel.InventoryOwnership.Reduction.Basic

namespace Rastrata.Kernel

namespace InventoryOwnership

/-- `liftExact` returns a value exactly when the operation does. -/
theorem liftExact_eq_ok_iff {α : Type} {result : Except NumErr α} {value : α} :
    liftExact result = .ok value ↔ result = .ok value := by
  cases result <;> simp [liftExact]

/-- `ofQuantize` returns a value exactly when the computation does. -/
theorem ofQuantize_eq_ok_iff {α : Type} {result : Except QuantizeErr α} {value : α} :
    InventoryOwnershipErr.ofQuantize result = .ok value ↔ result = .ok value := by
  cases result <;> simp [InventoryOwnershipErr.ofQuantize]

/-- `ofQuantize` throws exactly what the computation throws. -/
theorem ofQuantize_eq_error_iff {α : Type} {result : Except QuantizeErr α}
    {e : InventoryOwnershipErr} :
    InventoryOwnershipErr.ofQuantize result = .error e ↔
      ∃ inner, result = .error inner ∧ e = .quantize inner := by
  cases result <;> simp [InventoryOwnershipErr.ofQuantize, eq_comm]

/-- The values `reductionRecord` computes, when it returns the reduction. -/
structure RecordView (holding : LotHolding) (allocation : LotAllocation)
    (planned : PolicyCumulativePostedShare) (basis allowance carrying : ExactRational)
    (reduction : InventoryPostedReduction) : Prop where
  postedAmount : ExactDecimal.of (-planned.postedAmount.coefficient) planned.postedAmount.scale =
    .ok reduction.postedAmount
  remainingQuantity : holding.remainingQuantity.subtract allocation.allocatedQuantity =
    .ok reduction.afterHolding.remainingQuantity
  remainingTotalBasis : holding.remainingTotalBasis.subtract basis =
    .ok reduction.afterHolding.remainingTotalBasis
  remainingValuationAllowance : holding.remainingValuationAllowance.subtract allowance =
    .ok reduction.afterHolding.remainingValuationAllowance
  remainingCarryingAmount : holding.remainingCarryingAmount.subtract carrying =
    .ok reduction.afterHolding.remainingCarryingAmount
  posted : ∃ posted, planned.postedAmount.toRational = .ok posted ∧
    posted.subtract carrying = .ok reduction.postedMinusEconomic

/-- A record `reductionRecord` returns: its computed values, and every field the TypeScript copies
in unchanged. -/
theorem reductionRecord_ok {anchor : InventoryPostedAnchor} {position : InventoryPostedPosition}
    {holding : LotHolding} {allocation : LotAllocation} {planned : PolicyCumulativePostedShare}
    {afterBody : InventoryPostedPositionBody} {basis allowance carrying : ExactRational}
    {postedValue : Option InventoryPostedValueAllocation} {reduction : InventoryPostedReduction}
    (h : reductionRecord anchor position holding allocation planned afterBody basis allowance
      carrying postedValue = .ok reduction) :
    RecordView holding allocation planned basis allowance carrying reduction ∧
      reduction.monetaryKind = (if planned.postedAmount.isZero then .quantityOnly
        else .journalLinked) ∧
      reduction.beforePosition = beforePositionOf anchor position ∧
      reduction.afterPosition = ⟨afterBody, hashInventoryPostedPosition afterBody⟩ ∧
      reduction.afterHolding.id = holding.id ∧ reduction.afterHolding.bookId = holding.bookId ∧
      reduction.afterHolding.lotId = holding.lotId ∧
      reduction.afterHolding.accountId = holding.accountId ∧
      reduction.afterHolding.commodityId = holding.commodityId ∧
      reduction.afterHolding.basisCommodityId = holding.basisCommodityId ∧
      reduction.allocation = allocation ∧ reduction.reductionProof = planned ∧
      reduction.postedValue = postedValue := by
  unfold reductionRecord at h
  split at h
  · cases h
  rename_i postedAmount h1
  split at h
  · cases h
  rename_i q h2
  split at h
  · cases h
  rename_i b h3
  split at h
  · cases h
  rename_i a h4
  split at h
  · cases h
  rename_i c h5
  split at h
  · cases h
  rename_i p h6
  split at h
  · cases h
  rename_i d h7
  cases h
  rw [liftExact_eq_ok_iff] at h1 h2 h3 h4 h5 h6 h7
  exact ⟨⟨h1, h2, h3, h4, h5, ⟨p, h6, h7⟩⟩, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl,
    rfl⟩

/-- Every value a prepared reduction was computed from, and how (lines 147 to 233). -/
structure ReductionView (anchor : InventoryPostedAnchor) (position : InventoryPostedPosition)
    (holding : LotHolding) (allocation : LotAllocation) (origin : InventoryPostedReductionOrigin)
    (reduction : InventoryPostedReduction) where
  consumedQuantity : ExactRational
  beforeFraction : ExactRational
  afterFraction : ExactRational
  planned : PolicyCumulativePostedShare
  recorded : ExactRational
  target : ExactRational
  fraction : ExactRational
  basis : ExactRational
  allowance : ExactRational
  carrying : ExactRational
  postedValue : Option InventoryPostedValueAllocation
  population : reductionPopulationExceeded anchor = false
  hash : reductionHashInvalid anchor position = false
  lineage : reductionLineageInvalid anchor position origin = false
  sources : reductionSourcesInvalid anchor = false
  coordinate : reductionCoordinateInvalid anchor position holding = false
  quantity : reductionQuantityInvalid anchor position holding allocation = .ok false
  consumed_eq : position.consumedQuantity.add allocation.allocatedQuantity = .ok consumedQuantity
  before_eq : position.consumedQuantity.divide anchor.quantity = .ok beforeFraction
  after_eq : consumedQuantity.divide anchor.quantity = .ok afterFraction
  share_eq : anchor.quantizationPolicy.quantizeCumulativePostedShare anchor.postedBudget
    beforeFraction afterFraction = .ok (.quantized planned)
  recorded_eq : position.consumedPosted.toRational = .ok recorded
  target_eq : planned.beforeQuantization.amount.toRational = .ok target
  recorded_matches : recorded.equals target = true
  fraction_eq : allocation.allocatedQuantity.divide holding.remainingQuantity = .ok fraction
  basis_eq : holding.remainingTotalBasis.multiply fraction = .ok basis
  allowance_eq : holding.remainingValuationAllowance.multiply fraction = .ok allowance
  carrying_eq : basis.add allowance = .ok carrying
  allocationTest : reductionAllocationInvalid holding allocation basis allowance carrying = .ok false
  postedValue_eq : reductionPostedValue anchor planned = .ok (.proceed postedValue)
  record_eq : reductionRecord anchor position holding allocation planned
    (reductionAfterBody anchor holding origin consumedQuantity planned) basis allowance carrying
    postedValue = .ok reduction

end InventoryOwnership

open InventoryOwnership in
/-- A prepared reduction passed every test and was computed as the TypeScript computes it. -/
theorem prepareInventoryPostedReduction_prepared {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    {origin : InventoryPostedReductionOrigin} {reduction : InventoryPostedReduction}
    (h : prepareInventoryPostedReduction anchor position holding allocation origin =
      .ok (.prepared reduction)) :
    Nonempty (ReductionView anchor position holding allocation origin reduction) := by
  unfold prepareInventoryPostedReduction at h
  split at h
  · cases h
  rename_i hpop
  split at h
  · cases h
  rename_i hhash
  split at h
  · cases h
  rename_i hlin
  split at h
  · cases h
  rename_i hsrc
  split at h
  · cases h
  rename_i hcoord
  split at h
  · cases h
  · cases h
  rename_i hqty
  unfold reductionPlanned at h
  split at h
  · cases h
  rename_i consumedQuantity hconsumed
  split at h
  · cases h
  rename_i beforeFraction hbefore
  split at h
  · cases h
  rename_i afterFraction hafter
  split at h
  · cases h
  · cases h
  rename_i planned hshare
  split at h
  · cases h
  rename_i recorded hrecorded
  split at h
  · cases h
  rename_i target htarget
  split at h
  · cases h
  rename_i hmatch
  unfold reductionEconomics at h
  split at h
  · cases h
  rename_i fraction hfraction
  split at h
  · cases h
  rename_i basis hbasis
  split at h
  · cases h
  rename_i allowance hallowance
  split at h
  · cases h
  rename_i carrying hcarrying
  split at h
  · cases h
  · cases h
  rename_i halloc
  split at h
  · cases h
  · cases h
  rename_i postedValue hposted
  dsimp only at h
  split at h
  · cases h
  rename_i record hrecord
  cases h
  rw [liftExact_eq_ok_iff] at hconsumed hbefore hafter hrecorded htarget
  rw [liftExact_eq_ok_iff] at hfraction hbasis hallowance hcarrying
  exact ⟨⟨consumedQuantity, beforeFraction, afterFraction, planned, recorded, target, fraction,
    basis, allowance, carrying, postedValue, by simpa using hpop, by simpa using hhash,
    by simpa using hlin, by simpa using hsrc, by simpa using hcoord, hqty, hconsumed, hbefore,
    hafter, hshare, hrecorded, htarget, by simpa using hmatch, hfraction, hbasis, hallowance,
    hcarrying, halloc, hposted, hrecord⟩⟩

end Rastrata.Kernel

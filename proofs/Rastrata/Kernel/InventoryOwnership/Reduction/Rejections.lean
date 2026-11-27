/-
When `prepareInventoryPostedReduction` (`inventory-ownership.ts` line 140) rejects, and with which
diagnostic: one theorem a diagnostic, as an `iff` over the model's own tests in the order of the
TypeScript. Its own rejections carry the code `lot_overallocation`; the rejections it passes through
from the planned share (`quantizeCumulativePostedShare`) and the posted components
(`allocateInventoryPostedValue`) carry other codes (`Inner`), so no rejection can be mistaken for
another.
-/
import Rastrata.Kernel.InventoryOwnership.Reduction.Laws

namespace Rastrata.Kernel

/-- A rejection passed through from the arithmetic of shares or posted values: none of its
diagnostics is `lot_overallocation`. -/
def OwnershipRejection.Inner (rejection : OwnershipRejection) : Prop :=
  ∀ d ∈ rejection.diagnostics, d.code ≠ .lot_overallocation

namespace InventoryOwnership

/-- A rejection of this module is never an inner one. -/
theorem reject_not_inner (path message : String) : ¬ (reject path message).Inner := by
  intro h
  exact h (diagnostic .lot_overallocation path message rejectRequirements) (by simp [reject]) rfl

/-- A rejection of a share is an inner one. -/
theorem share_rejection_inner {total : ExactDecimal} {before after : ExactRational}
    {policy : QuantizationPolicy} {diagnostics : List SemanticDiagnostic}
    (h : policy.quantizeCumulativePostedShare total before after = .ok (.rejected diagnostics)) :
    (⟨diagnostics⟩ : OwnershipRejection).Inner := by
  intro d hd
  rcases QuantizationPolicy.quantizeCumulativePostedShare_rejected_diagnostic h with hd' | hd' <;>
    simp only [hd', List.mem_singleton] at hd <;> subst hd <;> decide

/-- A rejection of posted components is an inner one. -/
theorem value_rejection_inner {budget : InventoryPostedValueBudget} {before after : ExactRational}
    {policy : QuantizationPolicy} {rejection : ValueRejection} (hS : budget.WF) (hb : before.WF)
    (ha : after.WF)
    (h : allocateInventoryPostedValue budget before after policy = .ok (.rejected rejection)) :
    (⟨rejection.diagnostics⟩ : OwnershipRejection).Inner := by
  intro d hd
  rcases allocateInventoryPostedValue_rejected_diagnostic hS hb ha h with hd' | hd' | hd' <;>
    simp only [hd', List.mem_singleton] at hd <;> subst hd <;> decide

/-- Two rejections of this module with different paths are different. -/
theorem reject_ne_of_path {path₁ message₁ path₂ message₂ : String} (h : path₁ ≠ path₂) :
    reject path₁ message₁ ≠ reject path₂ message₂ := fun he => h (reject_inj.mp he).1

/-- Two rejections of this module with different messages are different. -/
theorem reject_ne_of_message {path₁ message₁ path₂ message₂ : String} (h : message₁ ≠ message₂) :
    reject path₁ message₁ ≠ reject path₂ message₂ := fun he => h (reject_inj.mp he).2

/-- After the six tests, a reduction that is rejected is rejected by the test of the recorded
consumption, of the allocation or of the posted components, or by the arithmetic of the planned
share or of the posted components. -/
theorem reductionPlanned_rejected {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    {origin : InventoryPostedReductionOrigin} {rejection : OwnershipRejection}
    (hA : anchor.WF) (hP : position.WF) (hL : allocation.WF)
    (h : reductionPlanned anchor position holding allocation origin = .ok (.rejected rejection)) :
    rejection = reductionConsumedPostedRejection ∨ rejection = reductionAllocationRejection ∨
      rejection = reductionPostedValueRejection ∨ rejection.Inner := by
  have hq : anchor.quantity.WF := hA.quantity
  have hc : position.consumedQuantity.WF := hP.consumedQuantity
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
  rw [liftExact_eq_ok_iff] at hconsumed hbefore hafter
  obtain ⟨hcqwf, -⟩ := ExactRational.add_ok hc hL.allocatedQuantity hconsumed
  obtain ⟨hbfwf, -⟩ := ExactRational.divide_ok hc hq hbefore
  obtain ⟨hafwf, -⟩ := ExactRational.divide_ok hcqwf hq hafter
  split at h
  · cases h
  · rename_i diagnostics hshare
    cases h
    exact Or.inr (Or.inr (Or.inr (share_rejection_inner hshare)))
  rename_i planned hshare
  obtain ⟨hsb, hsa, -⟩ := share_facts hA.postedBudget hbfwf hafwf hshare
  split at h
  · cases h
  split at h
  · cases h
  split at h
  · cases h
    exact Or.inl rfl
  unfold reductionEconomics at h
  split at h
  · cases h
  split at h
  · cases h
  split at h
  · cases h
  split at h
  · cases h
  split at h
  · cases h
  · cases h
    exact Or.inr (Or.inl rfl)
  dsimp only at h
  split at h
  · cases h
  · rename_i inner hpv
    cases h
    unfold reductionPostedValue at hpv
    split at hpv
    · cases hpv
    rename_i budget hbudget
    have hbw : budget.WF := hA.postedValue budget hbudget
    split at hpv
    · cases hpv
    · rename_i valueRejection halloc
      cases hpv
      rw [hsb, hsa] at halloc
      exact Or.inr (Or.inr (Or.inr (value_rejection_inner hbw hbfwf hafwf halloc)))
    split at hpv
    · cases hpv
    split at hpv
    · cases hpv
    split at hpv
    · cases hpv
      exact Or.inr (Or.inr (Or.inl rfl))
    · cases hpv
  split at h
  · cases h
  · cases h

/-- Two different rejections are two different results. -/
theorem rejected_ne {a b : OwnershipRejection} (hab : a ≠ b) :
    (Except.ok (ReductionResult.rejected a) : Except QuantizeErr ReductionResult) ≠
      .ok (.rejected b) := by
  intro h
  apply hab
  simpa using h

/-- The six tests of lines 150 to 191 pass. -/
def reductionChecksPass (anchor : InventoryPostedAnchor) (position : InventoryPostedPosition)
    (holding : LotHolding) (allocation : LotAllocation) (origin : InventoryPostedReductionOrigin) :
    Prop :=
  reductionPopulationExceeded anchor = false ∧ reductionHashInvalid anchor position = false ∧
    reductionLineageInvalid anchor position origin = false ∧
    reductionSourcesInvalid anchor = false ∧
    reductionCoordinateInvalid anchor position holding = false ∧
    reductionQuantityInvalid anchor position holding allocation = .ok false

end InventoryOwnership

open InventoryOwnership

/-- When the six tests pass, the reduction is what follows them. -/
theorem prepareInventoryPostedReduction_of_checks {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    {origin : InventoryPostedReductionOrigin}
    (h : reductionChecksPass anchor position holding allocation origin) :
    prepareInventoryPostedReduction anchor position holding allocation origin =
      reductionPlanned anchor position holding allocation origin := by
  obtain ⟨h1, h2, h3, h4, h5, h6⟩ := h
  unfold prepareInventoryPostedReduction
  simp only [h1, h2, h3, h4, h5, Bool.false_eq_true, ↓reduceIte, h6]

/-- What follows the six tests never returns one of their rejections. -/
theorem reductionPlanned_ne_checks {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    {origin : InventoryPostedReductionOrigin} (hA : anchor.WF) (hP : position.WF)
    (hL : allocation.WF) {path message : String}
    (hpath : path ∈ ["inventoryOwnership.anchor", "inventoryOwnership.hash",
      "inventoryOwnership.lineage", "inventoryOwnership.sources", "inventoryOwnership.coordinate",
      "inventoryOwnership.quantity"]) :
    reductionPlanned anchor position holding allocation origin ≠
      .ok (.rejected (InventoryOwnership.reject path message)) := by
  intro h
  rcases reductionPlanned_rejected hA hP hL h with h' | h' | h' | h'
  · unfold reductionConsumedPostedRejection at h'
    obtain ⟨hp, -⟩ := reject_inj.mp h'
    subst hp
    revert hpath
    decide
  · unfold reductionAllocationRejection at h'
    obtain ⟨hp, -⟩ := reject_inj.mp h'
    subst hp
    revert hpath
    decide
  · unfold reductionPostedValueRejection at h'
    obtain ⟨hp, -⟩ := reject_inj.mp h'
    subst hp
    revert hpath
    decide
  · exact reject_not_inner path message h'


/-- A reduction is rejected for its populations exactly when the anchor's sources or its dimensions are more than the bound (line 150). -/
theorem prepareInventoryPostedReduction_anchor_iff {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    {origin : InventoryPostedReductionOrigin} (hA : anchor.WF) (hP : position.WF)
    (hL : allocation.WF) :
    prepareInventoryPostedReduction anchor position holding allocation origin =
        .ok (.rejected reductionAnchorRejection) ↔
      reductionPopulationExceeded anchor = true := by
  constructor
  · intro h
    unfold prepareInventoryPostedReduction at h
    split at h
    · rename_i h0
      exact h0
    split at h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    split at h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    split at h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    split at h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    split at h
    · cases h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    · exact absurd h (reductionPlanned_ne_checks hA hP hL (by decide))
  · intro h
    unfold prepareInventoryPostedReduction
    simp only [h, ↓reduceIte]

/-- A reduction is rejected for its hashes exactly when the populations fit and the anchor's version is not supported or the anchor's or the position's carried hash is not the hash of its content (lines 153 to 155). -/
theorem prepareInventoryPostedReduction_hash_iff {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    {origin : InventoryPostedReductionOrigin} (hA : anchor.WF) (hP : position.WF)
    (hL : allocation.WF) :
    prepareInventoryPostedReduction anchor position holding allocation origin =
        .ok (.rejected reductionHashRejection) ↔
      reductionPopulationExceeded anchor = false ∧
      reductionHashInvalid anchor position = true := by
  constructor
  · intro h
    unfold prepareInventoryPostedReduction at h
    split at h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    rename_i h0
    split at h
    · rename_i h1
      exact ⟨by simpa using h0, h1⟩
    split at h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    split at h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    split at h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    split at h
    · cases h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    · exact absurd h (reductionPlanned_ne_checks hA hP hL (by decide))
  · intro h
    unfold prepareInventoryPostedReduction
    obtain ⟨h0, h1⟩ := h
    simp only [h0, h1, Bool.false_eq_true, ↓reduceIte]

/-- A reduction is rejected for its lineage exactly when the earlier tests pass and the anchor, the position and the origin are not valid, in order and bound to the exact anchor (lines 166 to 170). -/
theorem prepareInventoryPostedReduction_lineage_iff {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    {origin : InventoryPostedReductionOrigin} (hA : anchor.WF) (hP : position.WF)
    (hL : allocation.WF) :
    prepareInventoryPostedReduction anchor position holding allocation origin =
        .ok (.rejected reductionLineageRejection) ↔
      reductionPopulationExceeded anchor = false ∧
      reductionHashInvalid anchor position = false ∧
      reductionLineageInvalid anchor position origin = true := by
  constructor
  · intro h
    unfold prepareInventoryPostedReduction at h
    split at h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    rename_i h0
    split at h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    rename_i h1
    split at h
    · rename_i h2
      exact ⟨by simpa using h0, by simpa using h1, h2⟩
    split at h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    split at h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    split at h
    · cases h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    · exact absurd h (reductionPlanned_ne_checks hA hP hL (by decide))
  · intro h
    unfold prepareInventoryPostedReduction
    obtain ⟨h0, h1, h2⟩ := h
    simp only [h0, h1, h2, Bool.false_eq_true, ↓reduceIte]

/-- A reduction is rejected for its sources exactly when the earlier tests pass and the anchor has no source or its sources are not unique, of the book, in order and of full hashes (lines 174 to 180). -/
theorem prepareInventoryPostedReduction_sources_iff {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    {origin : InventoryPostedReductionOrigin} (hA : anchor.WF) (hP : position.WF)
    (hL : allocation.WF) :
    prepareInventoryPostedReduction anchor position holding allocation origin =
        .ok (.rejected reductionSourcesRejection) ↔
      reductionPopulationExceeded anchor = false ∧
      reductionHashInvalid anchor position = false ∧
      reductionLineageInvalid anchor position origin = false ∧
      reductionSourcesInvalid anchor = true := by
  constructor
  · intro h
    unfold prepareInventoryPostedReduction at h
    split at h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    rename_i h0
    split at h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    rename_i h1
    split at h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    rename_i h2
    split at h
    · rename_i h3
      exact ⟨by simpa using h0, by simpa using h1, by simpa using h2, h3⟩
    split at h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    split at h
    · cases h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    · exact absurd h (reductionPlanned_ne_checks hA hP hL (by decide))
  · intro h
    unfold prepareInventoryPostedReduction
    obtain ⟨h0, h1, h2, h3⟩ := h
    simp only [h0, h1, h2, h3, Bool.false_eq_true, ↓reduceIte]

/-- A reduction is rejected for its coordinate exactly when the earlier tests pass and the holding, the position, the coordinate and the policy disagree or the dimensions are out of order (lines 183 to 186). -/
theorem prepareInventoryPostedReduction_coordinate_iff {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    {origin : InventoryPostedReductionOrigin} (hA : anchor.WF) (hP : position.WF)
    (hL : allocation.WF) :
    prepareInventoryPostedReduction anchor position holding allocation origin =
        .ok (.rejected reductionCoordinateRejection) ↔
      reductionPopulationExceeded anchor = false ∧
      reductionHashInvalid anchor position = false ∧
      reductionLineageInvalid anchor position origin = false ∧
      reductionSourcesInvalid anchor = false ∧
      reductionCoordinateInvalid anchor position holding = true := by
  constructor
  · intro h
    unfold prepareInventoryPostedReduction at h
    split at h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    rename_i h0
    split at h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    rename_i h1
    split at h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    rename_i h2
    split at h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    rename_i h3
    split at h
    · rename_i h4
      exact ⟨by simpa using h0, by simpa using h1, by simpa using h2, by simpa using h3, h4⟩
    split at h
    · cases h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    · exact absurd h (reductionPlanned_ne_checks hA hP hL (by decide))
  · intro h
    unfold prepareInventoryPostedReduction
    obtain ⟨h0, h1, h2, h3, h4⟩ := h
    simp only [h0, h1, h2, h3, h4, Bool.false_eq_true, ↓reduceIte]

/-- A reduction is rejected for its quantities exactly when the five tests before pass and the
quantity test fails: the anchor quantity is not positive, the consumed quantity is negative or over
it, the holding does not hold the unconsumed rest, or the allocation is not a positive part of this
holding and lot that the holding can give (lines 189 to 191). -/
theorem prepareInventoryPostedReduction_quantity_iff {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    {origin : InventoryPostedReductionOrigin} (hA : anchor.WF) (hP : position.WF)
    (hL : allocation.WF) :
    prepareInventoryPostedReduction anchor position holding allocation origin =
        .ok (.rejected reductionQuantityRejection) ↔
      reductionPopulationExceeded anchor = false ∧ reductionHashInvalid anchor position = false ∧
      reductionLineageInvalid anchor position origin = false ∧
      reductionSourcesInvalid anchor = false ∧
      reductionCoordinateInvalid anchor position holding = false ∧
      reductionQuantityInvalid anchor position holding allocation = .ok true := by
  constructor
  · intro h
    unfold prepareInventoryPostedReduction at h
    split at h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    rename_i h0
    split at h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    rename_i h1
    split at h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    rename_i h2
    split at h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    rename_i h3
    split at h
    · exact absurd h (rejected_ne (reject_ne_of_path (by decide)))
    rename_i h4
    split at h
    · cases h
    · rename_i h5
      exact ⟨by simpa using h0, by simpa using h1, by simpa using h2, by simpa using h3,
        by simpa using h4, h5⟩
    · exact absurd h (reductionPlanned_ne_checks hA hP hL (by decide))
  · rintro ⟨h0, h1, h2, h3, h4, h5⟩
    unfold prepareInventoryPostedReduction
    simp only [h0, h1, h2, h3, h4, h5, Bool.false_eq_true, ↓reduceIte]

/-- A result that is none of the rejections of the six tests is the result of what follows them
exactly when the six tests pass. -/
theorem prepareInventoryPostedReduction_eq_planned_iff {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    {origin : InventoryPostedReductionOrigin} {result : ReductionResult}
    (hr : result ≠ .rejected reductionAnchorRejection ∧ result ≠ .rejected reductionHashRejection ∧
      result ≠ .rejected reductionLineageRejection ∧
      result ≠ .rejected reductionSourcesRejection ∧
      result ≠ .rejected reductionCoordinateRejection ∧
      result ≠ .rejected reductionQuantityRejection) :
    prepareInventoryPostedReduction anchor position holding allocation origin = .ok result ↔
      reductionChecksPass anchor position holding allocation origin ∧
        reductionPlanned anchor position holding allocation origin = .ok result := by
  obtain ⟨r0, r1, r2, r3, r4, r5⟩ := hr
  constructor
  · intro h
    unfold prepareInventoryPostedReduction at h
    split at h
    · exact absurd (by simpa using h.symm) r0
    rename_i h0
    split at h
    · exact absurd (by simpa using h.symm) r1
    rename_i h1
    split at h
    · exact absurd (by simpa using h.symm) r2
    rename_i h2
    split at h
    · exact absurd (by simpa using h.symm) r3
    rename_i h3
    split at h
    · exact absurd (by simpa using h.symm) r4
    rename_i h4
    split at h
    · cases h
    · exact absurd (by simpa using h.symm) r5
    rename_i h5
    exact ⟨⟨by simpa using h0, by simpa using h1, by simpa using h2, by simpa using h3,
      by simpa using h4, h5⟩, h⟩
  · rintro ⟨hc, h⟩
    rw [prepareInventoryPostedReduction_of_checks hc, h]

/-- After the recorded consumption, a reduction that is rejected is rejected by the test of the
allocation or of the posted components, or by the arithmetic of the posted components. -/
theorem reductionEconomics_rejected {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    {origin : InventoryPostedReductionOrigin} {consumedQuantity : ExactRational}
    {planned : PolicyCumulativePostedShare} {rejection : OwnershipRejection} (hA : anchor.WF)
    (hb : planned.beforeFraction.WF) (ha : planned.afterFraction.WF)
    (h : reductionEconomics anchor position holding allocation origin consumedQuantity planned =
      .ok (.rejected rejection)) :
    rejection = reductionAllocationRejection ∨ rejection = reductionPostedValueRejection ∨
      rejection.Inner := by
  unfold reductionEconomics at h
  split at h
  · cases h
  split at h
  · cases h
  split at h
  · cases h
  split at h
  · cases h
  split at h
  · cases h
  · cases h
    exact Or.inl rfl
  dsimp only at h
  split at h
  · cases h
  · rename_i inner hpv
    cases h
    unfold reductionPostedValue at hpv
    split at hpv
    · cases hpv
    rename_i budget hbudget
    have hbw : budget.WF := hA.postedValue budget hbudget
    split at hpv
    · cases hpv
    · rename_i valueRejection halloc
      cases hpv
      exact Or.inr (Or.inr (value_rejection_inner hbw hb ha halloc))
    split at hpv
    · cases hpv
    split at hpv
    · cases hpv
    split at hpv
    · cases hpv
      exact Or.inr (Or.inl rfl)
    · cases hpv
  split at h
  · cases h
  · cases h

/-- The rejections of the arithmetic are never the module's own. -/
theorem inner_ne_reject {rejection : OwnershipRejection} (h : rejection.Inner) (path message : String) :
    rejection ≠ InventoryOwnership.reject path message := fun he =>
  reject_not_inner path message (he ▸ h)

/-- A reduction is rejected for its recorded consumption exactly when the six tests pass, the
consumed quantity, the two fractions and the planned share are computed, and the recorded posted
consumption is not the share's rounded target before (line 197). -/
theorem prepareInventoryPostedReduction_consumedPosted_iff {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    {origin : InventoryPostedReductionOrigin} (hA : anchor.WF) (hP : position.WF)
    (hL : allocation.WF) :
    prepareInventoryPostedReduction anchor position holding allocation origin =
        .ok (.rejected reductionConsumedPostedRejection) ↔
      reductionChecksPass anchor position holding allocation origin ∧
      ∃ consumedQuantity beforeFraction afterFraction planned recorded target,
        position.consumedQuantity.add allocation.allocatedQuantity = .ok consumedQuantity ∧
        position.consumedQuantity.divide anchor.quantity = .ok beforeFraction ∧
        consumedQuantity.divide anchor.quantity = .ok afterFraction ∧
        anchor.quantizationPolicy.quantizeCumulativePostedShare anchor.postedBudget
          beforeFraction afterFraction = .ok (.quantized planned) ∧
        position.consumedPosted.toRational = .ok recorded ∧
        planned.beforeQuantization.amount.toRational = .ok target ∧
        recorded.equals target = false := by
  rw [prepareInventoryPostedReduction_eq_planned_iff (by
    refine ⟨?_, ?_, ?_, ?_, ?_, ?_⟩ <;> intro he <;> injection he with he <;>
      exact reject_ne_of_path (by decide) he)]
  apply and_congr_right
  intro _
  have hq : anchor.quantity.WF := hA.quantity
  have hc : position.consumedQuantity.WF := hP.consumedQuantity
  constructor
  · intro h
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
    rw [liftExact_eq_ok_iff] at hconsumed hbefore hafter
    obtain ⟨hcqwf, -⟩ := ExactRational.add_ok hc hL.allocatedQuantity hconsumed
    obtain ⟨hbfwf, -⟩ := ExactRational.divide_ok hc hq hbefore
    obtain ⟨hafwf, -⟩ := ExactRational.divide_ok hcqwf hq hafter
    split at h
    · cases h
    · rename_i diagnostics hshare
      exact absurd (show (⟨diagnostics⟩ : OwnershipRejection) = reductionConsumedPostedRejection
        by simpa using h) (inner_ne_reject (share_rejection_inner hshare) _ _)
    rename_i planned hshare
    obtain ⟨hsb, hsa, -⟩ := share_facts hA.postedBudget hbfwf hafwf hshare
    split at h
    · cases h
    rename_i recorded hrecorded
    split at h
    · cases h
    rename_i target htarget
    rw [liftExact_eq_ok_iff] at hrecorded htarget
    split at h
    · rename_i hmatch
      exact ⟨consumedQuantity, beforeFraction, afterFraction, planned, recorded, target, hconsumed,
        hbefore, hafter, hshare, hrecorded, htarget, by simpa using hmatch⟩
    · rcases reductionEconomics_rejected hA (hsb ▸ hbfwf) (hsa ▸ hafwf) h with h' | h' | h'
      · exact absurd h' (reject_ne_of_path (by decide))
      · exact absurd h' (reject_ne_of_path (by decide))
      · exact absurd rfl (inner_ne_reject h' _ _)
  · rintro ⟨consumedQuantity, beforeFraction, afterFraction, planned, recorded, target, hconsumed,
      hbefore, hafter, hshare, hrecorded, htarget, hmatch⟩
    unfold reductionPlanned
    simp only [liftExact, hconsumed, hbefore, hafter, hshare, hrecorded, htarget, hmatch,
      Bool.not_false, ↓reduceIte]

namespace InventoryOwnership

/-- Lines 194 to 198 run through with these values: the consumed quantity and the two fractions are
computed, the planned share is quantized, and the recorded posted consumption matches its rounded
target before. -/
def ReductionPlanReached (anchor : InventoryPostedAnchor) (position : InventoryPostedPosition)
    (allocation : LotAllocation) (consumedQuantity : ExactRational)
    (planned : PolicyCumulativePostedShare) : Prop :=
  position.consumedQuantity.add allocation.allocatedQuantity = .ok consumedQuantity ∧
    ∃ beforeFraction afterFraction recorded target,
      position.consumedQuantity.divide anchor.quantity = .ok beforeFraction ∧
      consumedQuantity.divide anchor.quantity = .ok afterFraction ∧
      anchor.quantizationPolicy.quantizeCumulativePostedShare anchor.postedBudget
        beforeFraction afterFraction = .ok (.quantized planned) ∧
      position.consumedPosted.toRational = .ok recorded ∧
      planned.beforeQuantization.amount.toRational = .ok target ∧
      recorded.equals target = true

/-- Lines 200 to 203 run through with these values: the allocation's fraction of the holding, and
the holding's basis, allowance and carrying amount in that fraction. -/
def ReductionShareComputed (holding : LotHolding) (allocation : LotAllocation)
    (basis allowance carrying : ExactRational) : Prop :=
  ∃ fraction, allocation.allocatedQuantity.divide holding.remainingQuantity = .ok fraction ∧
    holding.remainingTotalBasis.multiply fraction = .ok basis ∧
    holding.remainingValuationAllowance.multiply fraction = .ok allowance ∧
    basis.add allowance = .ok carrying

/-- After the six tests, the rest of a reduction is the economics, once the plan is reached. -/
theorem reductionPlanned_of_reached {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    {origin : InventoryPostedReductionOrigin} {consumedQuantity : ExactRational}
    {planned : PolicyCumulativePostedShare}
    (h : ReductionPlanReached anchor position allocation consumedQuantity planned) :
    reductionPlanned anchor position holding allocation origin =
      reductionEconomics anchor position holding allocation origin consumedQuantity planned := by
  obtain ⟨hconsumed, beforeFraction, afterFraction, recorded, target, hbefore, hafter, hshare,
    hrecorded, htarget, hmatch⟩ := h
  unfold reductionPlanned
  simp only [liftExact, hconsumed, hbefore, hafter, hshare, hrecorded, htarget, hmatch,
    Bool.not_true, Bool.false_eq_true, ↓reduceIte]

/-- After the six tests, a reduction is rejected by a test after the recorded consumption only
once the plan is reached. -/
theorem reductionPlanned_economics {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    {origin : InventoryPostedReductionOrigin} {result : ReductionResult} (hA : anchor.WF)
    (hP : position.WF) (hL : allocation.WF)
    (hr : ∀ diagnostics, result = .rejected ⟨diagnostics⟩ →
      result ≠ .rejected reductionConsumedPostedRejection ∧ ¬ (⟨diagnostics⟩ : OwnershipRejection).Inner)
    (h : reductionPlanned anchor position holding allocation origin = .ok result) :
    ∃ consumedQuantity planned, ReductionPlanReached anchor position allocation consumedQuantity planned ∧
      planned.beforeFraction.WF ∧ planned.afterFraction.WF ∧
      reductionEconomics anchor position holding allocation origin consumedQuantity planned =
        .ok result := by
  have hq : anchor.quantity.WF := hA.quantity
  have hc : position.consumedQuantity.WF := hP.consumedQuantity
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
  rw [liftExact_eq_ok_iff] at hconsumed hbefore hafter
  obtain ⟨hcqwf, -⟩ := ExactRational.add_ok hc hL.allocatedQuantity hconsumed
  obtain ⟨hbfwf, -⟩ := ExactRational.divide_ok hc hq hbefore
  obtain ⟨hafwf, -⟩ := ExactRational.divide_ok hcqwf hq hafter
  split at h
  · cases h
  · rename_i diagnostics hshare
    cases h
    exact absurd (share_rejection_inner hshare) (hr _ rfl).2
  rename_i planned hshare
  obtain ⟨hsb, hsa, -⟩ := share_facts hA.postedBudget hbfwf hafwf hshare
  split at h
  · cases h
  rename_i recorded hrecorded
  split at h
  · cases h
  rename_i target htarget
  rw [liftExact_eq_ok_iff] at hrecorded htarget
  split at h
  · cases h
    exact absurd rfl (hr _ rfl).1
  rename_i hmatch
  exact ⟨consumedQuantity, planned, ⟨hconsumed, beforeFraction, afterFraction, recorded, target,
    hbefore, hafter, hshare, hrecorded, htarget, by simpa using hmatch⟩, hsb ▸ hbfwf, hsa ▸ hafwf,
    h⟩

end InventoryOwnership

/-- The posted components of a reduction are rejected by the test of their carrying total, or by
their own arithmetic. -/
theorem reductionPostedValue_rejected {anchor : InventoryPostedAnchor}
    {planned : PolicyCumulativePostedShare} {rejection : OwnershipRejection} (hA : anchor.WF)
    (hb : planned.beforeFraction.WF) (ha : planned.afterFraction.WF)
    (h : reductionPostedValue anchor planned = .ok (.rejected rejection)) :
    rejection = reductionPostedValueRejection ∨ rejection.Inner := by
  unfold reductionPostedValue at h
  split at h
  · cases h
  rename_i budget hbudget
  have hbw : budget.WF := hA.postedValue budget hbudget
  split at h
  · cases h
  · rename_i valueRejection halloc
    cases h
    exact Or.inr (value_rejection_inner hbw hb ha halloc)
  split at h
  · cases h
  split at h
  · cases h
  split at h
  · cases h
    exact Or.inl rfl
  · cases h

/-- A rejection of this module, as a result, is none of the six first rejections when its path is
not theirs. -/
theorem rejected_ne_checks {path message : String}
    (hpath : path ∉ ["inventoryOwnership.anchor", "inventoryOwnership.hash",
      "inventoryOwnership.lineage", "inventoryOwnership.sources", "inventoryOwnership.coordinate",
      "inventoryOwnership.quantity"]) :
    ReductionResult.rejected (InventoryOwnership.reject path message) ≠
        .rejected reductionAnchorRejection ∧
      ReductionResult.rejected (InventoryOwnership.reject path message) ≠
        .rejected reductionHashRejection ∧
      ReductionResult.rejected (InventoryOwnership.reject path message) ≠
        .rejected reductionLineageRejection ∧
      ReductionResult.rejected (InventoryOwnership.reject path message) ≠
        .rejected reductionSourcesRejection ∧
      ReductionResult.rejected (InventoryOwnership.reject path message) ≠
        .rejected reductionCoordinateRejection ∧
      ReductionResult.rejected (InventoryOwnership.reject path message) ≠
        .rejected reductionQuantityRejection := by
  simp only [List.mem_cons, List.not_mem_nil, or_false, not_or] at hpath
  obtain ⟨h0, h1, h2, h3, h4, h5⟩ := hpath
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_⟩ <;> intro he <;> injection he with he
  · exact h0 (reject_inj.mp he).1
  · exact h1 (reject_inj.mp he).1
  · exact h2 (reject_inj.mp he).1
  · exact h3 (reject_inj.mp he).1
  · exact h4 (reject_inj.mp he).1
  · exact h5 (reject_inj.mp he).1

/-- A reduction is rejected for its allocation exactly when the six tests pass, the plan is reached
with the recorded consumption matching, the holding's share of the allocation is computed, and the
allocation test fails: a negative basis, a positive allowance, a negative carrying amount, a carrying
amount that is not basis plus allowance, or an allocation that does not carry exactly the holding's
share of basis, allowance and carrying amount (lines 204 to 206). -/
theorem prepareInventoryPostedReduction_allocation_iff {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    {origin : InventoryPostedReductionOrigin} (hA : anchor.WF) (hP : position.WF)
    (hL : allocation.WF) :
    prepareInventoryPostedReduction anchor position holding allocation origin =
        .ok (.rejected reductionAllocationRejection) ↔
      reductionChecksPass anchor position holding allocation origin ∧
      ∃ consumedQuantity planned,
        ReductionPlanReached anchor position allocation consumedQuantity planned ∧
        ∃ basis allowance carrying, ReductionShareComputed holding allocation basis allowance carrying ∧
          reductionAllocationInvalid holding allocation basis allowance carrying = .ok true := by
  rw [prepareInventoryPostedReduction_eq_planned_iff (by
    refine ⟨?_, ?_, ?_, ?_, ?_, ?_⟩ <;> intro he <;> injection he with he <;>
      exact reject_ne_of_path (by decide) he)]
  apply and_congr_right
  intro _
  constructor
  · intro h
    obtain ⟨consumedQuantity, planned, hreach, hb, ha, he⟩ := reductionPlanned_economics hA hP hL
      (fun d hd => ⟨fun he => by
          injection he with he
          exact reject_ne_of_path (by decide) he,
        fun hi => by
          injection hd with hd
          rw [← hd] at hi
          exact reject_not_inner _ _ hi⟩) h
    refine ⟨consumedQuantity, planned, hreach, ?_⟩
    unfold reductionEconomics at he
    split at he
    · cases he
    rename_i fraction hfraction
    split at he
    · cases he
    rename_i basis hbasis
    split at he
    · cases he
    rename_i allowance hallowance
    split at he
    · cases he
    rename_i carrying hcarrying
    rw [liftExact_eq_ok_iff] at hfraction hbasis hallowance hcarrying
    split at he
    · cases he
    · rename_i htest
      exact ⟨basis, allowance, carrying, ⟨fraction, hfraction, hbasis, hallowance, hcarrying⟩,
        htest⟩
    dsimp only at he
    split at he
    · cases he
    · rename_i inner hpv
      have he' : inner = reductionAllocationRejection := by
        injection he with he
        injection he
      rcases reductionPostedValue_rejected hA hb ha hpv with h' | h'
      · exact absurd (he'.symm.trans h') (reject_ne_of_path (by decide))
      · exact (reject_not_inner _ _ (he' ▸ h')).elim
    split at he
    · cases he
    · cases he
  · rintro ⟨consumedQuantity, planned, hreach, basis, allowance, carrying,
      ⟨fraction, hfraction, hbasis, hallowance, hcarrying⟩, htest⟩
    rw [reductionPlanned_of_reached hreach]
    unfold reductionEconomics
    simp only [liftExact, hfraction, hbasis, hallowance, hcarrying, htest]

/-- The posted components are rejected for their total exactly when the anchor carries them, they
are allocated, and their carrying total is not the anchor's budget (line 218). -/
theorem reductionPostedValue_rejected_iff {anchor : InventoryPostedAnchor}
    {planned : PolicyCumulativePostedShare} (hA : anchor.WF) (hb : planned.beforeFraction.WF)
    (ha : planned.afterFraction.WF) :
    reductionPostedValue anchor planned = .ok (.rejected reductionPostedValueRejection) ↔
      ∃ budget values carryingTotal budgetTotal, anchor.postedValue = some budget ∧
        allocateInventoryPostedValue budget planned.beforeFraction planned.afterFraction
          anchor.quantizationPolicy = .ok (.allocated values) ∧
        values.carryingProof.postedTotal.toRational = .ok carryingTotal ∧
        anchor.postedBudget.toRational = .ok budgetTotal ∧
        carryingTotal.equals budgetTotal = false := by
  constructor
  · intro h
    unfold reductionPostedValue at h
    split at h
    · cases h
    rename_i budget hbudget
    have hbw : budget.WF := hA.postedValue budget hbudget
    split at h
    · cases h
    · rename_i valueRejection halloc
      exfalso
      have he : (⟨valueRejection.diagnostics⟩ : OwnershipRejection) =
          reductionPostedValueRejection := by
        injection h with h
        injection h
      exact reject_not_inner _ _ (he ▸ value_rejection_inner hbw hb ha halloc)
    rename_i values halloc
    split at h
    · cases h
    rename_i carryingTotal hct
    split at h
    · cases h
    rename_i budgetTotal hbt
    rw [liftExact_eq_ok_iff] at hct hbt
    split at h
    · rename_i hmatch
      exact ⟨budget, values, carryingTotal, budgetTotal, hbudget, halloc, hct, hbt,
        by simpa using hmatch⟩
    · cases h
  · rintro ⟨budget, values, carryingTotal, budgetTotal, hbudget, halloc, hct, hbt, hmatch⟩
    unfold reductionPostedValue
    simp only [hbudget, halloc, liftExact, hct, hbt, hmatch, Bool.not_false, ↓reduceIte]

/-- A reduction is rejected for its posted components exactly when the six tests pass, the plan is
reached, the holding's share is computed, the allocation test passes, and the anchor's posted
components are allocated with a carrying total that is not the anchor's budget
(`reductionPostedValue_rejected_iff`, line 218). -/
theorem prepareInventoryPostedReduction_postedValue_iff {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    {origin : InventoryPostedReductionOrigin} (hA : anchor.WF) (hP : position.WF)
    (hL : allocation.WF) :
    prepareInventoryPostedReduction anchor position holding allocation origin =
        .ok (.rejected reductionPostedValueRejection) ↔
      reductionChecksPass anchor position holding allocation origin ∧
      ∃ consumedQuantity planned,
        ReductionPlanReached anchor position allocation consumedQuantity planned ∧
        ∃ basis allowance carrying, ReductionShareComputed holding allocation basis allowance carrying ∧
          reductionAllocationInvalid holding allocation basis allowance carrying = .ok false ∧
          reductionPostedValue anchor planned = .ok (.rejected reductionPostedValueRejection) := by
  rw [prepareInventoryPostedReduction_eq_planned_iff (by
    refine ⟨?_, ?_, ?_, ?_, ?_, ?_⟩ <;> intro he <;> injection he with he <;>
      exact reject_ne_of_path (by decide) he)]
  apply and_congr_right
  intro _
  constructor
  · intro h
    obtain ⟨consumedQuantity, planned, hreach, hb, ha, he⟩ := reductionPlanned_economics hA hP hL
      (fun d hd => ⟨fun he => by
          injection he with he
          exact reject_ne_of_path (by decide) he,
        fun hi => by
          injection hd with hd
          rw [← hd] at hi
          exact reject_not_inner _ _ hi⟩) h
    refine ⟨consumedQuantity, planned, hreach, ?_⟩
    unfold reductionEconomics at he
    split at he
    · cases he
    rename_i fraction hfraction
    split at he
    · cases he
    rename_i basis hbasis
    split at he
    · cases he
    rename_i allowance hallowance
    split at he
    · cases he
    rename_i carrying hcarrying
    rw [liftExact_eq_ok_iff] at hfraction hbasis hallowance hcarrying
    split at he
    · cases he
    · exact absurd (by injection he with he; injection he) (reject_ne_of_path (by decide))
    rename_i htest
    dsimp only at he
    split at he
    · cases he
    · rename_i inner hpv
      have he' : inner = reductionPostedValueRejection := by
        injection he with he
        injection he
      exact ⟨basis, allowance, carrying, ⟨fraction, hfraction, hbasis, hallowance, hcarrying⟩,
        htest, he' ▸ hpv⟩
    split at he
    · cases he
    · cases he
  · rintro ⟨consumedQuantity, planned, hreach, basis, allowance, carrying,
      ⟨fraction, hfraction, hbasis, hallowance, hcarrying⟩, htest, hpv⟩
    rw [reductionPlanned_of_reached hreach]
    unfold reductionEconomics
    simp only [liftExact, hfraction, hbasis, hallowance, hcarrying, htest, hpv]

end Rastrata.Kernel

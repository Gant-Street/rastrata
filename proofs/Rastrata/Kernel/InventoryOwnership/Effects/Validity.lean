/-
The laws of `ownershipCoordinateValid`, `ownershipPositionValid` and `ownershipAnchorValid`
(`inventory-ownership.ts` lines 1459 to 1491), each characterised over the model's own conditions,
stated through the meaning of the numbers where a number is read.
-/
import Rastrata.Kernel.InventoryOwnership.Effects.Hashes
import Rastrata.Kernel.NumericLimits

namespace Rastrata.Kernel

set_option linter.unusedSimpArgs false

open InventoryOwnership InventoryOwnershipEffects


/-- A coordinate is valid exactly when it has at most the bound of dimensions, each before the next
in UTF-16 order. -/
theorem ownershipCoordinateValid_iff (coordinate : InventoryPostedCoordinate) :
    ownershipCoordinateValid coordinate = true ↔
      coordinate.dimensionMemberIds.length ≤ cap ∧
        coordinate.dimensionMemberIds.IsChain
          (fun a b => compareCanonicalText a.value b.value = .lt) := by
  rw [← dimensionsOutOfOrder_eq_false_iff]
  simp [ownershipCoordinateValid]

/-- What a valid position is: its hash reproduces, it has consumed a nonnegative quantity and a
nonnegative amount, its anchor reference is valid in its own book, its origin is complete, and its
anchor precedes its origin. -/
def InventoryPostedPosition.Valid (position : InventoryPostedPosition) : Prop :=
  position.contentHash = hashInventoryPostedPosition position.toInventoryPostedPositionBody ∧
    0 ≤ position.consumedQuantity.toRat ∧ 0 ≤ position.consumedPosted.toRat ∧
    referenceValid position.anchor.toInventoryPostedArtifactReference position.anchor.bookId = true ∧
    position.originMovementId.value ≠ "" ∧ position.originEffectKey.value ≠ "" ∧
    0 < position.originArtifactOrdinal ∧ 0 < position.originBookRevision ∧
    precedes position.anchor.artifactOrder
      ⟨position.originEffectKey, position.originArtifactOrdinal, position.originBookRevision⟩ = true

/-- A constructible position never makes `ownershipPositionValid` throw, and it is accepted exactly
when it is valid. -/
theorem ownershipPositionValid_wf {position : InventoryPostedPosition} (h : position.WF) :
    ∃ valid, ownershipPositionValid position = .ok valid ∧ (valid = true ↔ position.Valid) := by
  obtain ⟨r, hr, hrwf, hrrat⟩ := ExactDecimal.toRational_isOk h.consumedPosted
  have hq := ExactRational.isNegative_iff h.consumedQuantity
  have hp := ExactRational.isNegative_iff hrwf
  unfold ownershipPositionValid InventoryPostedPosition.Valid
  rw [hr]
  simp only [liftExact]
  by_cases hh : contentHashEquals position.contentHash (hashInventoryPostedPosition position.toInventoryPostedPositionBody) = true
  · by_cases hn : position.consumedQuantity.isNegative = true
    · refine ⟨false, by simp [hh, hn], ?_⟩
      simp only [Bool.false_eq_true, false_iff, not_and]
      intro _ h0; exact absurd (hq.mp hn) (not_lt.mpr h0)
    · refine ⟨_, by simp [hh, hn]; rfl, ?_⟩
      rw [contentHashEquals_iff] at hh
      simp only [Bool.and_eq_true, Bool.not_eq_true', decide_eq_true_eq,
        string_length_pos_iff, ne_eq]
      have hn' : 0 ≤ position.consumedQuantity.toRat := not_lt.mp (fun hlt => hn (hq.mpr hlt))
      rw [← hrrat]
      constructor
      · rintro ⟨⟨⟨⟨⟨⟨hneg, hrv⟩, hm⟩, he⟩, ho⟩, hb⟩, hpr⟩
        refine ⟨hh, hn', not_lt.mp (fun hlt => by simp [hp.mpr hlt] at hneg), hrv, hm, he, ho, hb, hpr⟩
      · rintro ⟨-, -, hpos, hrv, hm, he, ho, hb, hpr⟩
        exact ⟨⟨⟨⟨⟨⟨Bool.eq_false_iff.mpr (fun hx => absurd (hp.mp hx) (not_lt.mpr hpos)), hrv⟩,
          hm⟩, he⟩, ho⟩, hb⟩, hpr⟩
  · refine ⟨false, by simp [hh], ?_⟩
    rw [contentHashEquals_iff] at hh
    simp only [Bool.false_eq_true, false_iff, not_and]
    intro h'; exact absurd h' hh

/-- A constructible value compares above zero exactly when it is positive. -/
private theorem ownership_compare_zero_gt_iff {r : ExactRational} (h : r.WF) :
    r.compare ExactRational.zero = .gt ↔ 0 < r.toRat := by
  rw [ExactRational.compare_eq_compare_toRat h ExactRational.zero_wf, ExactRational.zero_toRat,
    compare_gt_iff_gt]

/-- The header of a constructible anchor passes exactly when its hash reproduces, its version is
supported, its quantity is positive, its ordinal, revision and effect key are present, its policy
hash is full, its coordinate is valid, and its quantization policy is of its book and currency. -/
theorem anchorHeaderInvalid_eq_false_iff {anchor : InventoryPostedAnchor} (h : anchor.WF) :
    anchorHeaderInvalid anchor = false ↔
      anchor.contentHash = hashInventoryPostedAnchor anchor.toInventoryPostedAnchorBody ∧
        postedAnchorVersionValid anchor = true ∧ 0 < anchor.quantity.toRat ∧
        0 < anchor.artifactOrdinal ∧ 0 < anchor.bookRevision ∧ anchor.effectKey.value ≠ "" ∧
        anchor.inventoryPolicy.policyContentHash.WF ∧
        ownershipCoordinateValid anchor.coordinate = true ∧
        anchor.quantizationPolicy.bookId = anchor.coordinate.bookId ∧
        anchor.quantizationPolicy.functionalCommodityId = anchor.coordinate.functionalCommodityId := by
  have hq := ownership_compare_zero_gt_iff h.quantity
  simp only [anchorHeaderInvalid, Bool.or_eq_false_iff, Bool.not_eq_false', contentHashEquals_iff,
    bne_eq_false_iff_eq, decide_eq_false_iff_not, not_le, ← fullHash_iff, hq, string_length_eq_zero_iff,
    and_assoc]

/-- An anchor's sources pass exactly when it has at least one and at most the bound, each source
reference is valid in its book and precedes it, its incoming movements, postings and evidence are
not repeated, each posting is of its book with a hash that checks, and each evidence hash is full. -/
theorem anchorSourcesInvalid_eq_false_iff (anchor : InventoryPostedAnchor) :
    anchorSourcesInvalid anchor = false ↔
      0 < (anchorSourceReferences anchor).length + anchor.sourcePostings.length +
          anchor.evidence.length ∧
        (anchorSourceReferences anchor).length + anchor.sourcePostings.length +
          anchor.evidence.length ≤ cap ∧
        (∀ reference ∈ anchorSourceReferences anchor,
          referenceValid reference anchor.coordinate.bookId = true ∧
            precedes reference.artifactOrder anchor.artifactOrder = true) ∧
        (anchor.incomingMovements.map (·.id)).Nodup ∧
        (∀ posting ∈ anchor.sourcePostings, posting.bookId = anchor.coordinate.bookId ∧
          validateCanonicalPostingReferenceHash posting = true) ∧
        (anchor.sourcePostings.map (·.postingId)).Nodup ∧
        (∀ evidence ∈ anchor.evidence, evidence.contentHash.WF) ∧
        (anchor.evidence.map (·.id)).Nodup := by
  simp only [anchorSourcesInvalid, Bool.or_eq_false_iff, decide_eq_false_iff_not,
    hasDuplicates_eq_false_iff, List.any_eq_false, Bool.not_eq_false', bne_eq_false_iff_eq,
    Bool.not_eq_true, fullHash_iff, gt_iff_lt, not_lt, Nat.pos_iff_ne_zero, ne_eq, and_assoc]

/-- The budget test passes exactly when the anchor's policy accepts the budget as a share. -/
theorem anchorBudgetQuantizes_eq_ok_true_iff (anchor : InventoryPostedAnchor) :
    anchorBudgetQuantizes anchor = .ok true ↔
      ∃ share, anchor.quantizationPolicy.quantizeCumulativePostedShare anchor.postedBudget
        ExactRational.zero ExactRational.zero = .ok (.quantized share) := by
  unfold anchorBudgetQuantizes
  split <;> simp_all

/-- The posted-value test passes exactly when, for a component-bearing anchor, its components
allocated from nothing leave a carrying amount equal to its budget, and the budget quantizes. -/
theorem anchorPostedValueValid_eq_ok_true_iff (anchor : InventoryPostedAnchor) :
    anchorPostedValueValid anchor = .ok true ↔
      (∀ budget, anchor.postedValue = some budget →
        ∃ values remaining total,
          allocateInventoryPostedValue budget ExactRational.zero ExactRational.zero
              anchor.quantizationPolicy = .ok (.allocated values) ∧
            values.carryingRemaining.toRational = .ok remaining ∧
            anchor.postedBudget.toRational = .ok total ∧ remaining.equals total = true) ∧
        anchorBudgetQuantizes anchor = .ok true := by
  unfold anchorPostedValueValid
  cases hv : anchor.postedValue with
  | none => simp
  | some budget =>
    simp only [Option.some.injEq, forall_eq']
    cases ha : allocateInventoryPostedValue budget ExactRational.zero ExactRational.zero
        anchor.quantizationPolicy with
    | error e => simp
    | ok result =>
      cases result with
      | rejected r => simp
      | allocated values =>
        simp only [Except.ok.injEq, InventoryPostedValueAllocationResult.allocated.injEq,
          exists_eq_left']
        cases hr : values.carryingRemaining.toRational with
        | error e => simp [liftExact, hr]
        | ok remaining =>
          cases ht : anchor.postedBudget.toRational with
          | error e => simp [liftExact, hr, ht]
          | ok total =>
            by_cases he : remaining.equals total = true <;> simp [liftExact, hr, ht, he]

/-- `ownershipAnchorValid` accepts exactly the anchors whose header, sources and posted value pass,
in that order. -/
theorem ownershipAnchorValid_eq_ok_true_iff (anchor : InventoryPostedAnchor) :
    ownershipAnchorValid anchor = .ok true ↔
      anchorHeaderInvalid anchor = false ∧ anchorSourcesInvalid anchor = false ∧
        anchorPostedValueValid anchor = .ok true := by
  unfold ownershipAnchorValid
  cases anchorHeaderInvalid anchor <;> cases anchorSourcesInvalid anchor <;> simp

end Rastrata.Kernel

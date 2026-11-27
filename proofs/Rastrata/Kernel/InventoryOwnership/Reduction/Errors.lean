/-
When `prepareInventoryPostedReduction` throws: with constructible inputs, only for size
(`ExactNumberError` `representation_limit_exceeded`), never for a scale, a sign or a division by
zero (`prepareInventoryPostedReduction_error`); and a prepared reduction group without a posting
reference has only quantity-only reductions, so the `default` the model takes for `posting!` is
never used there (`prepareInventoryPostedReductionGroup_unlinked`).
-/
import Rastrata.Kernel.InventoryOwnership.Reduction.Acquisition

namespace Rastrata.Kernel

namespace InventoryOwnership

/-- The error of size. -/
abbrev sizeError : QuantizeErr := .exactNumber .representationLimitExceeded

/-- An operation that, when it fails, fails for size, fails for size through `liftExact`. -/
theorem liftExact_error_size {α : Type} {result : Except NumErr α} {e : QuantizeErr}
    (hr : ∀ code, result = .error code → code = .representationLimitExceeded)
    (h : liftExact result = .error e) : e = sizeError := by
  cases hres : result with
  | ok v => rw [hres] at h; cases h
  | error code =>
    rw [hres] at h
    simp only [liftExact, Except.error.injEq] at h
    rw [← h, hr code hres]

theorem add_error_size {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    ∀ code, a.add b = .error code → code = .representationLimitExceeded := by
  intro code h
  rcases ExactRational.add_ok_or_limit ha hb with ⟨c, hc⟩ | hl
  · rw [hc] at h; cases h
  · rw [hl] at h; cases h; rfl

theorem subtract_error_size {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    ∀ code, a.subtract b = .error code → code = .representationLimitExceeded := by
  intro code h
  rcases ExactRational.subtract_ok_or_limit ha hb with ⟨c, hc⟩ | hl
  · rw [hc] at h; cases h
  · rw [hl] at h; cases h; rfl

theorem multiply_error_size {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    ∀ code, a.multiply b = .error code → code = .representationLimitExceeded := by
  intro code h
  rcases ExactRational.multiply_ok_or_limit ha hb with ⟨c, hc⟩ | hl
  · rw [hc] at h; cases h
  · rw [hl] at h; cases h; rfl

theorem divide_error_size {a b : ExactRational} (ha : a.WF) (hb : b.toRat ≠ 0) :
    ∀ code, a.divide b = .error code → code = .representationLimitExceeded := by
  intro code h
  have hbn : b.numerator ≠ 0 := by
    intro h0
    apply hb
    simp [ExactRational.toRat, h0]
  rcases ExactRational.divide_ok_or_error (b := b) ha with ⟨c, hc⟩ | ⟨h0, -⟩ | ⟨-, hl⟩
  · rw [hc] at h; cases h
  · exact absurd h0 hbn
  · rw [hl] at h; cases h; rfl

theorem toRational_error_size (d : ExactDecimal) :
    ∀ code, d.toRational = .error code → code = .representationLimitExceeded := by
  intro code h
  rcases ExactRational.of_error h with rfl | rfl
  · exfalso
    unfold ExactDecimal.toRational at h
    rw [ExactRational.of_eq_invalidRational_iff] at h
    have : (0 : Int) < 10 ^ d.scale.toNat := by positivity
    omega
  · rfl

end InventoryOwnership


namespace InventoryOwnership

/-- A constructible decimal negated is constructible at its scale. -/
theorem decimal_of_neg_ok {d : ExactDecimal} (hd : d.WF) :
    ExactDecimal.of (-d.coefficient) d.scale = .ok d.negate := by
  unfold ExactDecimal.of scaleError
  have h1 : ¬ d.scale < 0 := by have := hd.scale_nonneg; omega
  have h2 : ¬ d.scale > maxDecimalScale := by have := hd.scale_le; omega
  have hw : withinMagnitude (-d.coefficient) = true := by
    rw [withinMagnitude_neg]; exact hd.coefficient_within
  simp only [h1, h2, ↓reduceIte, hw, Bool.not_true, Bool.false_eq_true]
  rfl

/-- After the recorded consumption, a reduction of constructible inputs throws only for size. -/
theorem reductionEconomics_error {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    {origin : InventoryPostedReductionOrigin} {consumedQuantity : ExactRational}
    {planned : PolicyCumulativePostedShare} {e : QuantizeErr} (hA : anchor.WF) (hH : holding.WF)
    (hL : allocation.WF) (hq : holding.remainingQuantity.toRat ≠ 0)
    (hb : planned.beforeFraction.WF) (ha : planned.afterFraction.WF)
    (hp : planned.postedAmount.WF)
    (h : reductionEconomics anchor position holding allocation origin consumedQuantity planned =
      .error e) : e = sizeError := by
  unfold reductionEconomics at h
  split at h
  · rename_i e' he'
    cases h
    exact liftExact_error_size (divide_error_size hL.allocatedQuantity hq) he'
  rename_i fraction hfraction
  rw [liftExact_eq_ok_iff] at hfraction
  obtain ⟨hfwf, -⟩ := ExactRational.divide_ok hL.allocatedQuantity hH.remainingQuantity hfraction
  split at h
  · rename_i e' he'
    cases h
    exact liftExact_error_size (multiply_error_size hH.remainingTotalBasis hfwf) he'
  rename_i basis hbasis
  rw [liftExact_eq_ok_iff] at hbasis
  obtain ⟨hbwf, -⟩ := ExactRational.multiply_ok hH.remainingTotalBasis hfwf hbasis
  split at h
  · rename_i e' he'
    cases h
    exact liftExact_error_size (multiply_error_size hH.remainingValuationAllowance hfwf) he'
  rename_i allowance hallowance
  rw [liftExact_eq_ok_iff] at hallowance
  obtain ⟨hawf, -⟩ := ExactRational.multiply_ok hH.remainingValuationAllowance hfwf hallowance
  split at h
  · rename_i e' he'
    cases h
    exact liftExact_error_size (add_error_size hbwf hawf) he'
  rename_i carrying hcarrying
  rw [liftExact_eq_ok_iff] at hcarrying
  obtain ⟨hcwf, -⟩ := ExactRational.add_ok hbwf hawf hcarrying
  split at h
  · rename_i e' he'
    cases h
    unfold reductionAllocationInvalid at he'
    split at he'
    · cases he'
    split at he'
    · rename_i e'' he''
      cases he'
      exact liftExact_error_size (add_error_size hH.remainingTotalBasis
        hH.remainingValuationAllowance) he''
    · cases he'
  · cases h
  dsimp only at h
  split at h
  · rename_i e' he'
    cases h
    unfold reductionPostedValue at he'
    split at he'
    · cases he'
    rename_i budget hbudget
    split at he'
    · rename_i e'' he''
      cases he'
      exact allocateInventoryPostedValue_error (hA.postedValue budget hbudget) hb ha he''
    · cases he'
    split at he'
    · rename_i e'' he''
      cases he'
      exact liftExact_error_size (toRational_error_size _) he''
    split at he'
    · rename_i e'' he''
      cases he'
      exact liftExact_error_size (toRational_error_size _) he''
    split at he'
    · cases he'
    · cases he'
  · cases h
  split at h
  · rename_i e' he'
    cases h
    unfold reductionRecord at he'
    rw [decimal_of_neg_ok hp] at he'
    simp only [liftExact] at he'
    split at he'
    · rename_i e'' he''
      cases he'
      exact liftExact_error_size (subtract_error_size hH.remainingQuantity hL.allocatedQuantity)
        (by simp only [liftExact, he''])
    rename_i q hq'
    split at he'
    · rename_i e'' he''
      cases he'
      exact liftExact_error_size (subtract_error_size hH.remainingTotalBasis hbwf)
        (by simp only [liftExact, he''])
    split at he'
    · rename_i e'' he''
      cases he'
      exact liftExact_error_size (subtract_error_size hH.remainingValuationAllowance hawf)
        (by simp only [liftExact, he''])
    split at he'
    · rename_i e'' he''
      cases he'
      exact liftExact_error_size (subtract_error_size hH.remainingCarryingAmount hcwf)
        (by simp only [liftExact, he''])
    split at he'
    · rename_i e'' he''
      cases he'
      exact liftExact_error_size (toRational_error_size planned.postedAmount)
        (by simp only [liftExact, he''])
    rename_i posted hposted
    have hposted' : planned.postedAmount.toRational = .ok posted := liftExact_eq_ok_iff.mp hposted
    obtain ⟨hpwf, -⟩ := ExactDecimal.toRational_ok hp hposted'
    split at he'
    · rename_i e'' he''
      cases he'
      exact liftExact_error_size (subtract_error_size hpwf hcwf) he''
    · cases he'
  · cases h


end InventoryOwnership

open InventoryOwnership in
/-- A reduction of constructible inputs throws only for size: every exact operation it reaches is
of constructible numbers, its divisions are by quantities its tests made positive, and its shares
and posted components throw only for size; so it never throws for a scale, a sign or a division by
zero. -/
theorem prepareInventoryPostedReduction_error {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    {origin : InventoryPostedReductionOrigin} {e : QuantizeErr} (hA : anchor.WF)
    (hP : position.WF) (hH : holding.WF) (hL : allocation.WF)
    (h : prepareInventoryPostedReduction anchor position holding allocation origin = .error e) :
    e = .exactNumber .representationLimitExceeded := by
  have hq : anchor.quantity.WF := hA.quantity
  have hc : position.consumedQuantity.WF := hP.consumedQuantity
  unfold prepareInventoryPostedReduction at h
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
  split at h
  · rename_i e' he'
    cases h
    unfold reductionQuantityInvalid at he'
    split at he'
    · cases he'
    split at he'
    · rename_i e'' he''
      cases he'
      exact liftExact_error_size (subtract_error_size hq hc) he''
    · cases he'
  · cases h
  rename_i hqty
  obtain ⟨hqpos, -, -, -, -, -, hapos, hale⟩ := reductionQuantityInvalid_false hA hP hH hL hqty
  have hq0 : anchor.quantity.toRat ≠ 0 := ne_of_gt hqpos
  have hr0 : holding.remainingQuantity.toRat ≠ 0 := by
    intro h0; rw [h0] at hale; linarith
  unfold reductionPlanned at h
  split at h
  · rename_i e' he'
    cases h
    exact liftExact_error_size (add_error_size hc hL.allocatedQuantity) he'
  rename_i consumedQuantity hconsumed
  rw [liftExact_eq_ok_iff] at hconsumed
  obtain ⟨hcqwf, -⟩ := ExactRational.add_ok hc hL.allocatedQuantity hconsumed
  split at h
  · rename_i e' he'
    cases h
    exact liftExact_error_size (divide_error_size hc hq0) he'
  rename_i beforeFraction hbefore
  rw [liftExact_eq_ok_iff] at hbefore
  obtain ⟨hbfwf, -⟩ := ExactRational.divide_ok hc hq hbefore
  split at h
  · rename_i e' he'
    cases h
    exact liftExact_error_size (divide_error_size hcqwf hq0) he'
  rename_i afterFraction hafter
  rw [liftExact_eq_ok_iff] at hafter
  obtain ⟨hafwf, -⟩ := ExactRational.divide_ok hcqwf hq hafter
  split at h
  · rename_i e' he'
    cases h
    exact quantizeCumulativePostedShare_error hA.postedBudget hbfwf hafwf
      (QuantizationPolicy.quantizeCumulativePostedShare_error_iff.mp he')
  · cases h
  rename_i planned hshare
  obtain ⟨hsb, hsa, -, hpwf, -⟩ := share_facts hA.postedBudget hbfwf hafwf hshare
  split at h
  · rename_i e' he'
    cases h
    exact liftExact_error_size (toRational_error_size _) he'
  split at h
  · rename_i e' he'
    cases h
    exact liftExact_error_size (toRational_error_size _) he'
  split at h
  · cases h
  exact reductionEconomics_error hA hH hL hr0 (hsb ▸ hbfwf) (hsa ▸ hafwf) hpwf h

namespace InventoryOwnership

/-- A member of the right list of a one-by-one relation is related to a member of the left. -/
theorem forall₂_exists_left {α β : Type} {R : α → β → Prop} :
    ∀ {as : List α} {bs : List β}, List.Forall₂ R as bs → ∀ b ∈ bs, ∃ a ∈ as, R a b
  | [], [], _, _, hb => by simp at hb
  | a :: as, b' :: bs, .cons hab hrest, b, hb => by
    simp only [List.mem_cons] at hb
    rcases hb with rfl | hb
    · exact ⟨a, by simp, hab⟩
    · obtain ⟨a', ha', h'⟩ := forall₂_exists_left hrest b hb
      exact ⟨a', List.mem_cons_of_mem _ ha', h'⟩

/-- Numbers that are not negative and add up to zero are each zero. -/
theorem eq_zero_of_sum_nonneg {α : Type} (f : α → ℚ) :
    ∀ {xs : List α}, (∀ x ∈ xs, 0 ≤ f x) → (xs.map f).sum = 0 → ∀ x ∈ xs, f x = 0
  | [], _, _, x, hx => by simp at hx
  | y :: ys, hnn, hsum, x, hx => by
    simp only [List.map_cons, List.sum_cons] at hsum
    have hy := hnn y (by simp)
    have hys : 0 ≤ (ys.map f).sum := List.sum_nonneg (by
      intro z hz
      simp only [List.mem_map] at hz
      obtain ⟨w, hw, rfl⟩ := hz
      exact hnn w (List.mem_cons_of_mem _ hw))
    simp only [List.mem_cons] at hx
    rcases hx with rfl | hx
    · linarith
    · exact eq_zero_of_sum_nonneg f (fun z hz => hnn z (List.mem_cons_of_mem _ hz)) (by linarith)
        x hx

end InventoryOwnership

open InventoryOwnership in
/-- A prepared reduction group without a posting reference has only quantity-only reductions: the
`posting!` of line 538 is read only when the group has its posting, so the model's `default` there
is never used. -/
theorem prepareInventoryPostedReductionGroup_unlinked
    {context : InventoryPostedReductionGroupContext} {entries : List InventoryPostedReductionEntry}
    {journalLink : Option InventoryPostedJournalLink} {group : InventoryPostedReductionGroup}
    (hE : ∀ entry ∈ entries, entry.WF)
    (h : prepareInventoryPostedReductionGroup context entries journalLink = .ok (.prepared group))
    (view : ReductionGroupView context entries journalLink group) (hnone : view.posting = none) :
    ∀ reduction ∈ view.reductions, reduction.monetaryKind = .quantityOnly := by
  have hperm := sortByText_perm (·.holding.id.value) entries
  have hEo : ∀ entry ∈ reductionGroupOrdered entries, entry.WF := fun e he =>
    hE e (hperm.subset he)
  obtain ⟨hprep, -, -, -, -, ht, -, -⟩ := reductionGroupLoop_proceed ExactRational.zero_wf
    ExactRational.zero_wf ExactRational.zero_wf (fun e he => (hEo e he).allocation) view.loop
  -- the group posts nothing
  have hz : group.postedAmount.isZero = true := by
    by_contra hnz
    simp only [Bool.not_eq_true] at hnz
    have hstep := view.postingStep
    rw [hnone] at hstep
    unfold reductionGroupPosting at hstep
    simp only [hnz, Bool.false_eq_true, ↓reduceIte] at hstep
    cases journalLink with
    | none => simp at hstep
    | some link =>
      simp only at hstep
      split at hstep
      · simp at hstep
      split at hstep
      · split at hstep
        · simp at hstep
        · simp at hstep
        · split at hstep
          · simp at hstep
          · simp at hstep
      · simp at hstep
  have hsum0 : (view.reductions.map (·.reductionProof.postedAmount.toRat)).sum = 0 := by
    have h1 := (ExactRational.isZero_iff (reductionGroupLoop_proceed ExactRational.zero_wf
      ExactRational.zero_wf ExactRational.zero_wf (fun e he => (hEo e he).allocation)
      view.loop).2.2.1).mp hz
    rw [ht, ExactRational.zero_toRat, zero_add, sum_postedAmount_eq_neg hprep.forall₂ hEo] at h1
    linarith
  have hnonneg : ∀ reduction ∈ view.reductions, 0 ≤ reduction.reductionProof.postedAmount.toRat := by
    intro r hr
    obtain ⟨entry, hentry, origin, hprepr⟩ : ∃ entry ∈ reductionGroupOrdered entries, ∃ origin,
        prepareInventoryPostedReduction entry.anchor entry.position entry.holding
          entry.allocation origin = .ok (.prepared r) := by
      obtain ⟨e, he, origin, hrel⟩ := forall₂_exists_left hprep.forall₂ r hr
      exact ⟨e, he, origin, hrel⟩
    have hW := hEo entry hentry
    exact (prepareInventoryPostedReduction_posted hW.anchor hW.position hW.holding
      hW.allocation hprepr).2.2.2.2.2.2.2.2.2.1
  intro r hr
  have hzero : r.reductionProof.postedAmount.toRat = 0 :=
    eq_zero_of_sum_nonneg (fun x : InventoryPostedReduction => x.reductionProof.postedAmount.toRat)
      hnonneg hsum0 r hr
  obtain ⟨entry, hentry, origin, hprepr⟩ : ∃ entry ∈ reductionGroupOrdered entries, ∃ origin,
      prepareInventoryPostedReduction entry.anchor entry.position entry.holding
        entry.allocation origin = .ok (.prepared r) := by
    obtain ⟨e, he, origin, hrel⟩ := forall₂_exists_left hprep.forall₂ r hr
    exact ⟨e, he, origin, hrel⟩
  exact ((prepareInventoryPostedReduction_monetaryKind hprepr).1).mpr hzero

end Rastrata.Kernel

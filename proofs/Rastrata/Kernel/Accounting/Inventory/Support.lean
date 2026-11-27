/-
What the laws of `Accounting/Inventory.lean` use more than once: the sums of exact numbers, the
meaning of the tests `positive` and `compare`, the stable sort, and the policy that `policyAt`
selects.
-/
import Rastrata.Kernel.Accounting.Inventory.Model

namespace Rastrata.Kernel

namespace Inventory

/-! ## Sums and tests of exact numbers -/

/-- When a sum of constructible values returns, it is constructible and means their sum. -/
theorem accountingSum_ok {values : List ExactRational} {result : ExactRational}
    (hv : ∀ v ∈ values, v.WF) (h : accountingSum values = .ok result) :
    result.WF ∧ result.toRat = (values.map ExactRational.toRat).sum := by
  obtain ⟨hw, hr⟩ := addExactValues_ok ExactRational.zero_wf hv h
  refine ⟨hw, ?_⟩
  rw [hr, ExactRational.zero_toRat, zero_add]
  rfl

/-- When a sum of constructible values throws, it is for size. -/
theorem accountingSum_error {values : List ExactRational} {code : NumErr}
    (hv : ∀ v ∈ values, v.WF) (h : accountingSum values = .error code) :
    code = .representationLimitExceeded :=
  addExactValues_error ExactRational.zero_wf hv h

/-- `positive` of a constructible value says that it is above zero. -/
theorem positive_iff {v : ExactRational} (hv : v.WF) : positive v = true ↔ 0 < v.toRat := by
  unfold positive
  rw [beq_iff_eq, ExactRational.compare_gt_iff hv ExactRational.zero_wf,
    ExactRational.zero_toRat]

/-- `positive` is false exactly when a constructible value is not above zero. -/
theorem positive_eq_false_iff {v : ExactRational} (hv : v.WF) :
    positive v = false ↔ ¬ 0 < v.toRat := by
  rw [← positive_iff hv]; simp

/-- `!positive v` says that a constructible value is not above zero. -/
theorem not_positive_iff {v : ExactRational} (hv : v.WF) :
    (!positive v) = true ↔ ¬ 0 < v.toRat := by
  rw [Bool.not_eq_true', positive_eq_false_iff hv]

/-- Adding two constructible values throws only for size. -/
theorem add_error {a b : ExactRational} {code : NumErr} (ha : a.WF) (hb : b.WF)
    (h : a.add b = .error code) : code = .representationLimitExceeded := by
  rcases ExactRational.add_ok_or_limit ha hb with ⟨c, hc⟩ | hl
  · rw [hc] at h; cases h
  · rw [hl] at h; cases h; rfl

/-- Subtracting two constructible values throws only for size. -/
theorem subtract_error {a b : ExactRational} {code : NumErr} (ha : a.WF) (hb : b.WF)
    (h : a.subtract b = .error code) : code = .representationLimitExceeded := by
  rcases ExactRational.subtract_ok_or_limit ha hb with ⟨c, hc⟩ | hl
  · rw [hc] at h; cases h
  · rw [hl] at h; cases h; rfl

/-- Multiplying two constructible values throws only for size. -/
theorem multiply_error {a b : ExactRational} {code : NumErr} (ha : a.WF) (hb : b.WF)
    (h : a.multiply b = .error code) : code = .representationLimitExceeded := by
  rcases ExactRational.multiply_ok_or_limit ha hb with ⟨c, hc⟩ | hl
  · rw [hc] at h; cases h
  · rw [hl] at h; cases h; rfl

/-- Dividing a constructible value by one that is not zero throws only for size. -/
theorem divide_error {a b : ExactRational} {code : NumErr} (ha : a.WF) (hb : b.WF)
    (hne : b.toRat ≠ 0) (h : a.divide b = .error code) : code = .representationLimitExceeded := by
  have hnum : b.numerator ≠ 0 := fun h0 => hne ((ExactRational.isZero_iff hb).mp (by
    simp [ExactRational.isZero, h0]))
  rcases ExactRational.divide_ok_or_error (b := b) ha with ⟨c, hc⟩ | ⟨hb0, -⟩ | ⟨-, hl⟩
  · rw [hc] at h; cases h
  · exact absurd hb0 hnum
  · rw [hl] at h; cases h; rfl

/-- Every member of the right list of two related lists is related to a member of the left. -/
theorem forall₂_right_mem {α β : Type} {R : α → β → Prop} :
    ∀ {l : List α} {a : List β}, List.Forall₂ R l a → ∀ y ∈ a, ∃ x ∈ l, R x y
  | _, _, .nil => fun y hy => by cases hy
  | _, _, .cons hxy hrest => fun y hy => by
    rcases List.mem_cons.mp hy with rfl | hy
    · exact ⟨_, List.mem_cons_self, hxy⟩
    · obtain ⟨x, hx, hr⟩ := forall₂_right_mem hrest y hy
      exact ⟨x, List.mem_cons_of_mem _ hx, hr⟩

/-! ## The stable sort -/

/-- A comparator that does not throw sorts the same way in `Lots.stableSort` and in `sortBy`: placing
one more element. -/
theorem insertSorted_pure {α ε : Type} (cmp : α → α → Ordering) (item : α) :
    ∀ l : List α, Lots.insertSorted (ε := ε) (fun a b => .ok (cmp a b)) item l =
      .ok (insertBy cmp item l)
  | [] => rfl
  | next :: rest => by
    simp only [Lots.insertSorted, insertBy]
    cases cmp item next
    · simp
    · simp
    · simp [insertSorted_pure cmp item rest]

/-- A comparator that does not throw sorts the same way in `Lots.stableSort` and in `sortBy`. -/
theorem stableSort_pure {α ε : Type} (cmp : α → α → Ordering) :
    ∀ l : List α, Lots.stableSort (ε := ε) (fun a b => .ok (cmp a b)) l = .ok (sortBy cmp l)
  | [] => rfl
  | item :: rest => by
    simp only [Lots.stableSort, sortBy, stableSort_pure cmp rest]
    exact insertSorted_pure cmp item (sortBy cmp rest)

/-- `sortBy` returns the elements it was given, each as many times. -/
theorem sortBy_perm {α : Type} (cmp : α → α → Ordering) (l : List α) : (sortBy cmp l).Perm l :=
  Lots.stableSort_perm (ε := NumErr) (fun a b => .ok (cmp a b)) l (sortBy cmp l)
    (stableSort_pure cmp l)

/-- `sortBy` by a comparator that follows a strict total order of keys returns the list in that
order, and elements with the same key in the order they were given. -/
theorem sortBy_sorted {α κ : Type} {cmp : α → α → Ordering} {lt : κ → κ → Prop}
    (hlt : Lots.StrictTotal lt) (key : α → κ) (l : List α)
    (hcmp : ∀ x ∈ l, ∀ y ∈ l, cmp x y = .gt ↔ lt (key y) (key x)) :
    (sortBy cmp l).Pairwise (Lots.Before lt key l) :=
  Lots.stableSort_sorted (ε := NumErr) (cmp := fun a b => .ok (cmp a b)) hlt key l (sortBy cmp l)
    (fun x hx y hy o ho => by
      cases ho
      exact hcmp x hx y hy) (stableSort_pure cmp l)

/-! ## The policy `policyAt` selects -/

/-- The policy `policyAt` selects is one of the policies, of the kind asked for. -/
theorem policyAt_selected_mem {T : Type} [AccountingPolicyKind T] {policies : List AccountingPolicy}
    {id : PolicyId} {version : SemanticVersion} {at_ : Instant} {p : T}
    (h : policyAt T policies id version at_ = .selected p) :
    ∃ q ∈ policies, AccountingPolicyKind.ofPolicy? q = some p := by
  unfold policyAt at h
  dsimp only at h
  split at h
  · rename_i selected hsel
    split at h
    · split at h
      · rename_i policy hp
        cases h
        exact ⟨selected, (List.mem_filter.mp (by rw [hsel]; exact List.mem_singleton_self _)).1, hp⟩
      · cases h
    · cases h
  · cases h

/-- The inventory cost policy `policyAt` selects is one of the policies. -/
theorem policyAt_inventoryCost_mem {policies : List AccountingPolicy} {id : PolicyId}
    {version : SemanticVersion} {at_ : Instant} {p : InventoryCostPolicy}
    (h : policyAt InventoryCostPolicy policies id version at_ = .selected p) :
    AccountingPolicy.inventoryCost p ∈ policies := by
  obtain ⟨q, hq, hp⟩ := policyAt_selected_mem h
  cases q <;> simp [AccountingPolicyKind.ofPolicy?] at hp
  subst hp
  exact hq

/-- The value adjustment policy `policyAt` selects is one of the policies. -/
theorem policyAt_inventoryValueAdjustment_mem {policies : List AccountingPolicy} {id : PolicyId}
    {version : SemanticVersion} {at_ : Instant} {p : InventoryValueAdjustmentPolicy}
    (h : policyAt InventoryValueAdjustmentPolicy policies id version at_ = .selected p) :
    AccountingPolicy.inventoryValueAdjustment p ∈ policies := by
  obtain ⟨q, hq, hp⟩ := policyAt_selected_mem h
  cases q <;> simp [AccountingPolicyKind.ofPolicy?] at hp
  subst hp
  exact hq

/-- `policyAt` rejects with the one diagnostic of its kind. -/
theorem policyAt_rejected_eq {T : Type} [AccountingPolicyKind T] {policies : List AccountingPolicy}
    {id : PolicyId} {version : SemanticVersion} {at_ : Instant} {ds : List SemanticDiagnostic}
    (h : policyAt T policies id version at_ = .rejected ds) :
    ds = [policyAtDiagnostic (AccountingPolicyKind.kind T)] := by
  unfold policyAt at h
  dsimp only at h
  split at h
  · split at h
    · split at h
      · cases h
      · cases h; rfl
    · cases h; rfl
  · cases h; rfl

end Inventory

end Rastrata.Kernel

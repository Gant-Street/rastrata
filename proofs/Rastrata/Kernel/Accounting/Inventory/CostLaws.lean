/-
The laws of `calculateInventoryCost`: what the loops that assign quantity and cost to layers
guarantee, the order the layers are consumed in, the rate of a shortage, and the rejections.
The head of `Accounting/Inventory.lean` lists the laws by name.
-/
import Rastrata.Kernel.Accounting.Inventory.Support

namespace Rastrata.Kernel

set_option linter.unusedSimpArgs false

namespace Inventory

/-! ## The loop that takes layers in order (`takeLayers`) -/

/-- The allocation `a` was taken from the layer `l`: it names it, takes a positive quantity of it, no
more than it holds, and its basis is the layer's total basis times the quantity taken, over the
layer's quantity, exactly. -/
structure TakenFrom (l : InventoryLayerInput) (a : InventoryAllocationResult) : Prop where
  layerId : a.layerId = l.id
  quantity_pos : 0 < a.quantity.toRat
  quantity_le : a.quantity.toRat ≤ l.quantity.toRat
  quantity_wf : a.quantity.WF
  basis_wf : a.basis.WF
  basis : a.basis.toRat = l.totalBasis.toRat * a.quantity.toRat / l.quantity.toRat

/-- `Greedy layers allocations`: the allocations are taken from the first layers, one each, in order,
and every one but the last takes its whole layer. -/
def Greedy : List InventoryLayerInput → List InventoryAllocationResult → Prop
  | _, [] => True
  | [], _ :: _ => False
  | l :: ls, a :: rest => TakenFrom l a ∧ (rest ≠ [] → a.quantity = l.quantity) ∧ Greedy ls rest

/-- Nothing is taken when nothing is asked. -/
theorem takeLayers_of_isZero {remaining : ExactRational} (h : remaining.isZero = true) :
    ∀ layers : List InventoryLayerInput, takeLayers remaining layers = .ok []
  | [] => rfl
  | _ :: _ => by simp [takeLayers, h]

/-- What the loop does: for constructible layers of positive quantity, and a request that is not
negative and no more than the layers hold, the allocations are taken from the first layers in order
(`Greedy`) and their quantities add up to the request exactly. -/
theorem takeLayers_ok :
    ∀ (layers : List InventoryLayerInput) (remaining : ExactRational)
      (allocs : List InventoryAllocationResult),
      (∀ l ∈ layers, l.WF) → (∀ l ∈ layers, 0 < l.quantity.toRat) → remaining.WF →
      0 ≤ remaining.toRat → remaining.toRat ≤ (layers.map (·.quantity.toRat)).sum →
      takeLayers remaining layers = .ok allocs →
      Greedy layers allocs ∧ (allocs.map (·.quantity.toRat)).sum = remaining.toRat := by
  intro layers
  induction layers with
  | nil =>
    intro remaining allocs _ _ hr h0 hle h
    simp only [takeLayers, Except.ok.injEq] at h
    subst h
    refine ⟨trivial, ?_⟩
    simp only [List.map_nil, List.sum_nil] at hle ⊢
    linarith
  | cons l ls ih =>
    intro remaining allocs hwf hpos hr h0 hle h
    by_cases hz : remaining.isZero = true
    · rw [takeLayers_of_isZero hz] at h
      cases h
      refine ⟨trivial, ?_⟩
      simp [(ExactRational.isZero_iff hr).mp hz]
    · have hlq := hwf l List.mem_cons_self
      have hlpos := hpos l List.mem_cons_self
      have hzr : remaining.toRat ≠ 0 := fun h0' => hz ((ExactRational.isZero_iff hr).mpr h0')
      have hrpos : 0 < remaining.toRat := lt_of_le_of_ne h0 (Ne.symm hzr)
      have hz' : remaining.isZero = false := by simpa using hz
      rw [takeLayers] at h
      simp only [hz', Bool.false_eq_true, ↓reduceIte] at h
      generalize hq : (if remaining.compare l.quantity = .lt then remaining else l.quantity) =
        quantity at h
      have hlt_iff := ExactRational.compare_lt_iff hr hlq.quantity
      have hqfacts : quantity.WF ∧ 0 < quantity.toRat ∧ quantity.toRat ≤ l.quantity.toRat ∧
          quantity.toRat ≤ remaining.toRat ∧
          ((remaining.toRat < l.quantity.toRat ∧ quantity = remaining) ∨
            (¬ remaining.toRat < l.quantity.toRat ∧ quantity = l.quantity)) := by
        by_cases hlt : remaining.compare l.quantity = .lt
        · simp only [hlt, ↓reduceIte] at hq
          subst hq
          have hlt' := hlt_iff.mp hlt
          exact ⟨hr, hrpos, hlt'.le, le_refl _, Or.inl ⟨hlt', rfl⟩⟩
        · simp only [hlt, ↓reduceIte] at hq
          subst hq
          have hlt' : ¬ remaining.toRat < l.quantity.toRat := fun hh => hlt (hlt_iff.mpr hh)
          exact ⟨hlq.quantity, hlpos, le_refl _, not_lt.mp hlt', Or.inr ⟨hlt', rfl⟩⟩
      obtain ⟨hqw, hqpos, hqle, hqr, hqcases⟩ := hqfacts
      cases hm : l.totalBasis.multiply quantity with
      | error e => simp [hm] at h
      | ok product =>
        simp only [hm] at h
        cases hd : product.divide l.quantity with
        | error e => simp [hd] at h
        | ok basis =>
          simp only [hd] at h
          cases hs : remaining.subtract quantity with
          | error e => simp [hs] at h
          | ok next =>
            simp only [hs] at h
            cases hrec : takeLayers next ls with
            | error e => simp [hrec] at h
            | ok later =>
              simp only [hrec, Except.ok.injEq] at h
              subst h
              obtain ⟨hpw, hpr⟩ := ExactRational.multiply_ok hlq.totalBasis hqw hm
              obtain ⟨hbw, -, hbr⟩ := ExactRational.divide_ok hpw hlq.quantity hd
              obtain ⟨hnw, hnr⟩ := ExactRational.subtract_ok hr hqw hs
              have hsum_nonneg : 0 ≤ (ls.map (·.quantity.toRat)).sum :=
                List.sum_nonneg (fun x hx => by
                  obtain ⟨l', hl', rfl⟩ := List.mem_map.mp hx
                  exact (hpos l' (List.mem_cons_of_mem _ hl')).le)
              have hn0 : 0 ≤ next.toRat := by rw [hnr]; linarith
              have hnle : next.toRat ≤ (ls.map (·.quantity.toRat)).sum := by
                rw [hnr]
                rcases hqcases with ⟨-, hqe⟩ | ⟨-, hqe⟩
                · rw [hqe]; linarith
                · rw [hqe]
                  simp only [List.map_cons, List.sum_cons] at hle
                  linarith
              obtain ⟨ihg, ihsum⟩ := ih next later (fun l' hl' => hwf l' (List.mem_cons_of_mem _ hl'))
                (fun l' hl' => hpos l' (List.mem_cons_of_mem _ hl')) hnw hn0 hnle hrec
              refine ⟨⟨⟨rfl, hqpos, hqle, hqw, hbw, by rw [hbr, hpr]⟩, ?_, ihg⟩, ?_⟩
              · intro hne
                rcases hqcases with ⟨-, hqe⟩ | ⟨-, hqe⟩
                · exfalso
                  have hnz : next.isZero = true := (ExactRational.isZero_iff hnw).mpr (by
                    rw [hnr, hqe]; ring)
                  rw [takeLayers_of_isZero hnz ls] at hrec
                  cases hrec
                  exact hne rfl
                · exact hqe
              · simp only [List.map_cons, List.sum_cons]
                rw [ihsum, hnr]
                ring

/-- When the loop throws, for constructible layers of positive quantity, it is for size. -/
theorem takeLayers_error :
    ∀ (layers : List InventoryLayerInput) (remaining : ExactRational) (code : NumErr),
      (∀ l ∈ layers, l.WF) → (∀ l ∈ layers, 0 < l.quantity.toRat) → remaining.WF →
      takeLayers remaining layers = .error code → code = .representationLimitExceeded := by
  intro layers
  induction layers with
  | nil =>
    intro remaining code _ _ _ h
    simp [takeLayers] at h
  | cons l ls ih =>
    intro remaining code hwf hpos hr h
    by_cases hz : remaining.isZero = true
    · rw [takeLayers_of_isZero hz] at h
      cases h
    · have hlq := hwf l List.mem_cons_self
      have hlpos := hpos l List.mem_cons_self
      have hz' : remaining.isZero = false := by simpa using hz
      rw [takeLayers] at h
      simp only [hz', Bool.false_eq_true, ↓reduceIte] at h
      generalize hq : (if remaining.compare l.quantity = .lt then remaining else l.quantity) =
        quantity at h
      have hqw : quantity.WF := by
        by_cases hlt : remaining.compare l.quantity = .lt
        · simp only [hlt, ↓reduceIte] at hq
          subst hq
          exact hr
        · simp only [hlt, ↓reduceIte] at hq
          subst hq
          exact hlq.quantity
      have hlne : l.quantity.toRat ≠ 0 := hlpos.ne'
      cases hm : l.totalBasis.multiply quantity with
      | error e =>
        simp only [hm] at h
        cases h
        exact multiply_error hlq.totalBasis hqw hm
      | ok product =>
        simp only [hm] at h
        obtain ⟨hpw, -⟩ := ExactRational.multiply_ok hlq.totalBasis hqw hm
        cases hd : product.divide l.quantity with
        | error e =>
          simp only [hd] at h
          cases h
          exact divide_error hpw hlq.quantity hlne hd
        | ok basis =>
          simp only [hd] at h
          cases hs : remaining.subtract quantity with
          | error e =>
            simp only [hs] at h
            cases h
            exact subtract_error hr hqw hs
          | ok next =>
            simp only [hs] at h
            obtain ⟨hnw, -⟩ := ExactRational.subtract_ok hr hqw hs
            cases hrec : takeLayers next ls with
            | error e =>
              simp only [hrec] at h
              cases h
              exact ih next _ (fun l' hl' => hwf l' (List.mem_cons_of_mem _ hl'))
                (fun l' hl' => hpos l' (List.mem_cons_of_mem _ hl')) hnw hrec
            | ok later =>
              simp only [hrec] at h
              cases h

/-! ## The loop of the weighted average (`averageShares`) -/

/-- The allocation `a` is the share of layer `l` in a weighted average: its quantity is the layer's
quantity times the quantity taken, over the quantity held; its basis is the same share of the total
basis of every layer. -/
structure ShareOf (totalBasis ordinaryQuantity available : ExactRational)
    (l : InventoryLayerInput) (a : InventoryAllocationResult) : Prop where
  layerId : a.layerId = l.id
  quantity_wf : a.quantity.WF
  basis_wf : a.basis.WF
  quantity : a.quantity.toRat = l.quantity.toRat * ordinaryQuantity.toRat / available.toRat
  basis : a.basis.toRat = totalBasis.toRat * a.quantity.toRat / available.toRat

/-- What the loop of the weighted average does: one allocation a layer, in the order given, each the
layer's share. -/
theorem averageShares_ok (totalBasis ordinaryQuantity available : ExactRational) :
    ∀ (layers : List InventoryLayerInput) (allocs : List InventoryAllocationResult),
      totalBasis.WF → ordinaryQuantity.WF → available.WF → available.toRat ≠ 0 →
      (∀ l ∈ layers, l.WF) →
      averageShares totalBasis ordinaryQuantity available layers = .ok allocs →
      List.Forall₂ (ShareOf totalBasis ordinaryQuantity available) layers allocs := by
  intro layers
  induction layers with
  | nil =>
    intro allocs _ _ _ _ _ h
    simp only [averageShares, Except.ok.injEq] at h
    subst h
    exact List.Forall₂.nil
  | cons l ls ih =>
    intro allocs htb hoq hav hne hwf h
    have hlq := hwf l List.mem_cons_self
    rw [averageShares] at h
    cases hm : l.quantity.multiply ordinaryQuantity with
    | error e => simp [hm] at h
    | ok product =>
      simp only [hm] at h
      obtain ⟨hpw, hpr⟩ := ExactRational.multiply_ok hlq.quantity hoq hm
      cases hd : product.divide available with
      | error e => simp [hd] at h
      | ok quantity =>
        simp only [hd] at h
        obtain ⟨hqw, -, hqr⟩ := ExactRational.divide_ok hpw hav hd
        cases hm2 : totalBasis.multiply quantity with
        | error e => simp [hm2] at h
        | ok total =>
          simp only [hm2] at h
          obtain ⟨htw, htr⟩ := ExactRational.multiply_ok htb hqw hm2
          cases hd2 : total.divide available with
          | error e => simp [hd2] at h
          | ok basis =>
            simp only [hd2] at h
            obtain ⟨hbw, -, hbr⟩ := ExactRational.divide_ok htw hav hd2
            cases hrec : averageShares totalBasis ordinaryQuantity available ls with
            | error e => simp [hrec] at h
            | ok later =>
              simp only [hrec, Except.ok.injEq] at h
              subst h
              exact List.Forall₂.cons ⟨rfl, hqw, hbw, by rw [hqr, hpr], by rw [hbr, htr]⟩
                (ih later htb hoq hav hne (fun l' hl' => hwf l' (List.mem_cons_of_mem _ hl')) hrec)

/-- When the loop of the weighted average throws, for constructible layers and a quantity held that
is not zero, it is for size. -/
theorem averageShares_error (totalBasis ordinaryQuantity available : ExactRational) :
    ∀ (layers : List InventoryLayerInput) (code : NumErr),
      totalBasis.WF → ordinaryQuantity.WF → available.WF → available.toRat ≠ 0 →
      (∀ l ∈ layers, l.WF) →
      averageShares totalBasis ordinaryQuantity available layers = .error code →
      code = .representationLimitExceeded := by
  intro layers
  induction layers with
  | nil =>
    intro code _ _ _ _ _ h
    simp [averageShares] at h
  | cons l ls ih =>
    intro code htb hoq hav hne hwf h
    have hlq := hwf l List.mem_cons_self
    rw [averageShares] at h
    cases hm : l.quantity.multiply ordinaryQuantity with
    | error e =>
      simp only [hm] at h
      cases h
      exact multiply_error hlq.quantity hoq hm
    | ok product =>
      simp only [hm] at h
      obtain ⟨hpw, -⟩ := ExactRational.multiply_ok hlq.quantity hoq hm
      cases hd : product.divide available with
      | error e =>
        simp only [hd] at h
        cases h
        exact divide_error hpw hav hne hd
      | ok quantity =>
        simp only [hd] at h
        obtain ⟨hqw, -, -⟩ := ExactRational.divide_ok hpw hav hd
        cases hm2 : totalBasis.multiply quantity with
        | error e =>
          simp only [hm2] at h
          cases h
          exact multiply_error htb hqw hm2
        | ok total =>
          simp only [hm2] at h
          obtain ⟨htw, -⟩ := ExactRational.multiply_ok htb hqw hm2
          cases hd2 : total.divide available with
          | error e =>
            simp only [hd2] at h
            cases h
            exact divide_error htw hav hne hd2
          | ok basis =>
            simp only [hd2] at h
            cases hrec : averageShares totalBasis ordinaryQuantity available ls with
            | error e =>
              simp only [hrec] at h
              cases h
              exact ih _ htb hoq hav hne (fun l' hl' => hwf l' (List.mem_cons_of_mem _ hl')) hrec
            | ok later =>
              simp only [hrec] at h
              cases h

/-! ## The order in which layers are taken -/

/-- Every allocation of a greedy run is of one of the layers. -/
theorem greedy_mem : ∀ (ordered : List InventoryLayerInput) (allocs : List InventoryAllocationResult),
    Greedy ordered allocs → ∀ a ∈ allocs, ∃ l ∈ ordered, a.layerId = l.id
  | _, [], _ => fun a ha => by cases ha
  | [], _ :: _, h => by simp [Greedy] at h
  | l :: ls, a :: rest, h => by
    obtain ⟨ht, -, hg⟩ := h
    intro b hb
    rcases List.mem_cons.mp hb with rfl | hb
    · exact ⟨l, List.mem_cons_self, ht.layerId⟩
    · obtain ⟨l', hl', hid⟩ := greedy_mem ls rest hg b hb
      exact ⟨l', List.mem_cons_of_mem _ hl', hid⟩

/-- A later layer is never taken from while an earlier one has quantity left: in a list whose layers
are ordered by a relation `R` that no layer bears to itself or in both directions, and have distinct
identifiers, if a layer that `R` puts after `x` is taken from then `x` is taken whole. -/
theorem greedy_before {R : InventoryLayerInput → InventoryLayerInput → Prop}
    (hirr : ∀ x, ¬ R x x) (hasym : ∀ x y, R x y → ¬ R y x) :
    ∀ (ordered : List InventoryLayerInput) (allocs : List InventoryAllocationResult),
      (ordered.map (·.id)).Nodup → ordered.Pairwise R → Greedy ordered allocs →
      ∀ x ∈ ordered, ∀ y ∈ ordered, R x y → (∃ a ∈ allocs, a.layerId = y.id) →
        ∃ a ∈ allocs, a.layerId = x.id ∧ a.quantity = x.quantity := by
  intro ordered
  induction ordered with
  | nil =>
    intro allocs _ _ _ x hx
    cases hx
  | cons l ls ih =>
    intro allocs hnd hpw hg x hx y hy hxy hy'
    cases allocs with
    | nil =>
      obtain ⟨b, hb, -⟩ := hy'
      cases hb
    | cons a rest =>
      obtain ⟨ht, hfull, hg'⟩ := hg
      rw [List.map_cons, List.nodup_cons] at hnd
      rw [List.pairwise_cons] at hpw
      obtain ⟨b, hb, hby⟩ := hy'
      -- the layer `l` is not in the rest of the list, so a layer with its identifier is `l`
      have hid_l : ∀ z ∈ ls, z.id ≠ l.id := fun z hz h' => hnd.1 (h' ▸ List.mem_map_of_mem hz)
      rcases List.mem_cons.mp hb with hba | hbr
      · -- the allocation is the first: `y` is `l`
        have hyl : y = l := by
          rcases List.mem_cons.mp hy with h' | h'
          · exact h'
          · exact absurd (by rw [← hby, hba, ht.layerId]) (hid_l y h')
        subst hyl
        rcases List.mem_cons.mp hx with hxy' | hxs
        · subst hxy'
          exact absurd hxy (hirr _)
        · exact absurd hxy (hasym _ _ (hpw.1 x hxs))
      · obtain ⟨l', hl', hid⟩ := greedy_mem ls rest hg' b hbr
        have hyls : y ∈ ls := by
          rcases List.mem_cons.mp hy with h' | h'
          · exfalso
            subst h'
            exact hid_l l' hl' (by rw [← hid, hby])
          · exact h'
        rcases List.mem_cons.mp hx with hxl | hxs
        · subst hxl
          exact ⟨a, List.mem_cons_self, ht.layerId, hfull (fun h0 => by rw [h0] at hbr; cases hbr)⟩
        · obtain ⟨c, hc, hcx⟩ := ih rest hnd.2 hpw.2 hg' x hxs y hyls hxy ⟨b, hbr, hby⟩
          exact ⟨c, List.mem_cons_of_mem _ hc, hcx⟩

/-- First in first out: `x` is consumed before `y` when its acquisition instant is earlier (as
JavaScript compares the texts), or the same and its identifier is lower. -/
def fifoBefore (x y : InventoryLayerInput) : Prop :=
  Lots.LexLt Lots.TextLt Lots.TextLt (x.acquiredAt.value, x.id) (y.acquiredAt.value, y.id)

/-- Last in first out: `x` is consumed before `y` when its acquisition instant is later, or the same
and its identifier is lower (the identifiers still break a tie in ascending order). -/
def lifoBefore (x y : InventoryLayerInput) : Prop :=
  Lots.LexLt (fun a b => Lots.TextLt b a) Lots.TextLt (x.acquiredAt.value, x.id)
    (y.acquiredAt.value, y.id)

/-- Highest cost first: `x` is consumed before `y` when its unit cost (total basis over quantity) is
higher, or the same and its identifier is lower. -/
def hifoBefore (x y : InventoryLayerInput) : Prop :=
  Lots.LexLt (fun a b : ℚ => b < a) Lots.TextLt (x.totalBasis.toRat / x.quantity.toRat, x.id)
    (y.totalBasis.toRat / y.quantity.toRat, y.id)

/-- The tie-break of the comparator: the identifiers decide when the first comparison is a tie. -/
theorem tieBreak_gt_iff (a b : InventoryLayerInput) (c : Ordering) :
    tieBreakById a b c = .gt ↔ c = .gt ∨ (c = .eq ∧ Lots.TextLt b.id a.id) := by
  unfold tieBreakById
  rw [Lots.ordered_gt_iff]
  exact or_congr Iff.rfl (and_congr Iff.rfl (Lots.textLt_iff_gt b.id a.id).symm)

/-- The text order, as the comparison of two texts. -/
theorem compare_gt_iff_textLt (a b : String) :
    compareCanonicalText a b = .gt ↔ Lots.TextLt b a := (compareCanonicalText_antisymm b a).symm

/-- The comparator of first in first out puts `x` after `y` exactly when `y` is consumed before `x`. -/
theorem costCompare_fifo {x y : InventoryLayerInput} {o : Ordering}
    (h : costCompare .fifo x y = .ok o) : o = .gt ↔ fifoBefore y x := by
  simp only [costCompare, Except.ok.injEq] at h
  subst h
  rw [tieBreak_gt_iff]
  unfold fifoBefore Lots.LexLt
  have h2 : compareCanonicalText x.acquiredAt.value y.acquiredAt.value = .eq ↔
      y.acquiredAt.value = x.acquiredAt.value := by
    rw [compareCanonicalText_eq_iff]; exact eq_comm
  simp only [compare_gt_iff_textLt, h2]

/-- The comparator of last in first out puts `x` after `y` exactly when `y` is consumed before `x`. -/
theorem costCompare_lifo {x y : InventoryLayerInput} {o : Ordering}
    (h : costCompare .lifo x y = .ok o) : o = .gt ↔ lifoBefore y x := by
  simp only [costCompare, Except.ok.injEq] at h
  subst h
  rw [tieBreak_gt_iff]
  unfold lifoBefore Lots.LexLt
  have hs : ∀ c : Ordering, (c.swap = .gt ↔ c = .lt) ∧ (c.swap = .eq ↔ c = .eq) := by
    intro c; cases c <;> simp
  have h2 : compareCanonicalText x.acquiredAt.value y.acquiredAt.value = .eq ↔
      y.acquiredAt.value = x.acquiredAt.value := by
    rw [compareCanonicalText_eq_iff]; exact eq_comm
  simp only [(hs _).1, (hs _).2, h2]
  rfl

/-- The comparator of highest cost first puts `x` after `y` exactly when `y` is consumed before `x`
(it throws, for constructible layers, only when a division exceeds the size limit). -/
theorem costCompare_hifo {x y : InventoryLayerInput} {o : Ordering} (hx : x.WF) (hy : y.WF)
    (h : costCompare .hifo x y = .ok o) : o = .gt ↔ hifoBefore y x := by
  simp only [costCompare] at h
  cases hl : y.totalBasis.divide y.quantity with
  | error e => simp [hl] at h
  | ok bUnit =>
    simp only [hl] at h
    cases hr : x.totalBasis.divide x.quantity with
    | error e => simp [hr] at h
    | ok aUnit =>
      simp only [hr, Except.ok.injEq] at h
      subst h
      obtain ⟨hbw, -, hbr⟩ := ExactRational.divide_ok hy.totalBasis hy.quantity hl
      obtain ⟨haw, -, har⟩ := ExactRational.divide_ok hx.totalBasis hx.quantity hr
      rw [tieBreak_gt_iff]
      unfold hifoBefore Lots.LexLt
      simp only [ExactRational.compare_gt_iff hbw haw, ExactRational.compare_eq_iff hbw haw, hbr,
        har]

/-- In the stable sort of a list of layers with distinct identifiers by a strict total order of keys
that tell the layers apart, one layer comes before another when its key is lower. -/
theorem before_lt {κ : Type} {lt : κ → κ → Prop} {key : InventoryLayerInput → κ}
    {original : List InventoryLayerInput} (hnd : (original.map (·.id)).Nodup)
    (hkey : ∀ x y, key x = key y → x.id = y.id) {x y : InventoryLayerInput} (hx : x ∈ original)
    (hy : y ∈ original) (h : Lots.Before lt key original x y) : lt (key x) (key y) := by
  rcases h with h | ⟨hk, hs⟩
  · exact h
  · have hxy : x = y := List.inj_on_of_nodup_map hnd hx hy (hkey x y hk)
    subst hxy
    exact absurd hs (fun hs' => Lots.not_both_sublist (List.Nodup.of_map _ hnd) hs' hs')

/-- A stable sort of layers with distinct identifiers by a comparator that follows a strict total
order of keys returns the same layers, each before every later one in the order. -/
theorem stableSort_layers {κ : Type} {cmp : InventoryLayerInput → InventoryLayerInput →
      Except NumErr Ordering} {lt : κ → κ → Prop} {key : InventoryLayerInput → κ}
    (hlt : Lots.StrictTotal lt) (hkey : ∀ x y, key x = key y → x.id = y.id)
    {list sorted : List InventoryLayerInput} (hnd : (list.map (·.id)).Nodup)
    (hcmp : ∀ x ∈ list, ∀ y ∈ list, ∀ o, cmp x y = .ok o → (o = .gt ↔ lt (key y) (key x)))
    (h : Lots.stableSort cmp list = .ok sorted) :
    sorted.Perm list ∧ sorted.Pairwise (fun x y => lt (key x) (key y)) := by
  have hperm := Lots.stableSort_perm cmp list sorted h
  refine ⟨hperm, ?_⟩
  have hs := Lots.stableSort_sorted hlt key list sorted hcmp h
  exact hs.imp_of_mem (fun {a b} ha hb hab =>
    before_lt hnd hkey (hperm.mem_iff.mp ha) (hperm.mem_iff.mp hb) hab)

/-- First in first out sorts the layers by acquisition instant, then identifier. -/
theorem costOrder_fifo {request : InventoryCostRequest} {ordered : List InventoryLayerInput}
    (hnd : (request.layers.map (·.id)).Nodup)
    (h : costOrder .fifo request = .ok (some ordered)) :
    ordered.Perm request.layers ∧ ordered.Pairwise fifoBefore := by
  simp only [costOrder] at h
  cases hs : Lots.stableSort (costCompare .fifo) request.layers with
  | error e => simp [hs] at h
  | ok sorted =>
    simp only [hs, Except.ok.injEq, Option.some.injEq] at h
    subst h
    exact stableSort_layers (key := fun z => (z.acquiredAt.value, z.id))
      (Lots.StrictTotal.lex Lots.textLt_strictTotal Lots.textLt_strictTotal)
      (fun x y hk => congrArg Prod.snd hk) hnd
      (fun x _ y _ o ho => costCompare_fifo ho) hs

/-- Last in first out sorts the layers by acquisition instant, latest first, then identifier. -/
theorem costOrder_lifo {request : InventoryCostRequest} {ordered : List InventoryLayerInput}
    (hnd : (request.layers.map (·.id)).Nodup)
    (h : costOrder .lifo request = .ok (some ordered)) :
    ordered.Perm request.layers ∧ ordered.Pairwise lifoBefore := by
  simp only [costOrder] at h
  cases hs : Lots.stableSort (costCompare .lifo) request.layers with
  | error e => simp [hs] at h
  | ok sorted =>
    simp only [hs, Except.ok.injEq, Option.some.injEq] at h
    subst h
    exact stableSort_layers (key := fun z => (z.acquiredAt.value, z.id))
      (Lots.StrictTotal.lex Lots.textLt_strictTotal.flip Lots.textLt_strictTotal)
      (fun x y hk => congrArg Prod.snd hk) hnd
      (fun x _ y _ o ho => costCompare_lifo ho) hs

/-- Highest cost first sorts the layers by unit cost, highest first, then identifier. -/
theorem costOrder_hifo {request : InventoryCostRequest} {ordered : List InventoryLayerInput}
    (hw : ∀ l ∈ request.layers, l.WF) (hnd : (request.layers.map (·.id)).Nodup)
    (h : costOrder .hifo request = .ok (some ordered)) :
    ordered.Perm request.layers ∧ ordered.Pairwise hifoBefore := by
  simp only [costOrder] at h
  cases hs : Lots.stableSort (costCompare .hifo) request.layers with
  | error e => simp [hs] at h
  | ok sorted =>
    simp only [hs, Except.ok.injEq, Option.some.injEq] at h
    subst h
    exact stableSort_layers
      (key := fun z => (z.totalBasis.toRat / z.quantity.toRat, z.id))
      (Lots.StrictTotal.lex Lots.ratGt_strictTotal Lots.textLt_strictTotal)
      (fun x y hk => congrArg Prod.snd hk) hnd
      (fun x hx y hy o ho => costCompare_hifo (hw x hx) (hw y hy) ho) hs

/-! ## What a costed result is made of -/

/-- When `calculateInventoryCost` costs a request, every step of it returned and none of the tests
rejected: the policy was selected, the layers were ordered, the quantity held summed, the quantity
short found, the allocations made and summed, the rate resolved, and the shortage priced. -/
theorem calculateInventoryCost_costed_inv {policies : List AccountingPolicy} {bookId : BookId}
    {request : InventoryCostRequest} {allocations : List InventoryAllocationResult}
    {ordinaryBasis provisionalQuantity provisionalBasis : ExactRational}
    (h : calculateInventoryCost policies bookId request =
      .ok (.costed allocations ordinaryBasis provisionalQuantity provisionalBasis)) :
    ∃ (policy : InventoryCostPolicy) (ordered : List InventoryLayerInput)
      (available rate : ExactRational),
      policyAt InventoryCostPolicy policies request.policyId request.policyVersion
        request.governedAt = .selected policy ∧
      costIncoherent policy bookId request = false ∧
      costOrder policy.method request = .ok (some ordered) ∧
      costAvailable policy.method ordered request = .ok available ∧
      request.quantity.subtract (ordinaryQuantityOf request.quantity available) =
        .ok provisionalQuantity ∧
      (!provisionalQuantity.isZero &&
        (policy.shortageTreatment == .reject || policy.provisionalBasisMethod.isNone)) = false ∧
      costAllocations policy.method request ordered available
        (ordinaryQuantityOf request.quantity available) = .ok allocations ∧
      accountingSum (allocations.map (·.basis)) = .ok ordinaryBasis ∧
      provisionalRateOf policy request provisionalQuantity
        (ordinaryQuantityOf request.quantity available) ordinaryBasis = .ok (some rate) ∧
      rateRejected provisionalQuantity (some rate) = false ∧
      provisionalQuantity.multiply rate = .ok provisionalBasis := by
  unfold calculateInventoryCost at h
  cases hp : policyAt InventoryCostPolicy policies request.policyId request.policyVersion
      request.governedAt with
  | rejected ds => simp [hp] at h
  | selected policy =>
    simp only [hp] at h
    by_cases hinc : costIncoherent policy bookId request = true
    · simp [hinc] at h
    · have hinc' : costIncoherent policy bookId request = false := Bool.eq_false_iff.mpr hinc
      simp only [hinc', Bool.false_eq_true, ↓reduceIte] at h
      cases ho : costOrder policy.method request with
      | error e => simp [ho] at h
      | ok o =>
        cases o with
        | none => simp [ho] at h
        | some ordered =>
          simp only [ho] at h
          cases ha : costAvailable policy.method ordered request with
          | error e => simp [ha] at h
          | ok available =>
            simp only [ha] at h
            cases hs : request.quantity.subtract (ordinaryQuantityOf request.quantity available) with
            | error e => simp [hs] at h
            | ok pq =>
              simp only [hs] at h
              by_cases hsh : (!pq.isZero &&
                  (policy.shortageTreatment == .reject || policy.provisionalBasisMethod.isNone)) = true
              · simp [hsh] at h
              · have hsh' : (!pq.isZero &&
                    (policy.shortageTreatment == .reject || policy.provisionalBasisMethod.isNone)) =
                    false := Bool.eq_false_iff.mpr hsh
                simp only [hsh', Bool.false_eq_true, ↓reduceIte] at h
                cases hal : costAllocations policy.method request ordered available
                    (ordinaryQuantityOf request.quantity available) with
                | error e => simp [hal] at h
                | ok allocs =>
                  simp only [hal] at h
                  cases hsum : accountingSum (allocs.map (·.basis)) with
                  | error e => simp [hsum] at h
                  | ok ob =>
                    simp only [hsum] at h
                    cases hr : provisionalRateOf policy request pq
                        (ordinaryQuantityOf request.quantity available) ob with
                    | error e => simp [hr] at h
                    | ok rate? =>
                      simp only [hr] at h
                      by_cases hrr : rateRejected pq rate? = true
                      · simp [hrr] at h
                      · have hrr' : rateRejected pq rate? = false := Bool.eq_false_iff.mpr hrr
                        simp only [hrr', Bool.false_eq_true, ↓reduceIte] at h
                        cases rate? with
                        | none => simp [rateRejected] at hrr'
                        | some rate =>
                          simp only [Option.getD_some] at h
                          cases hm : pq.multiply rate with
                          | error e => simp [hm] at h
                          | ok pb =>
                            simp only [hm, Except.ok.injEq, InventoryCostCalculation.costed.injEq] at h
                            obtain ⟨rfl, rfl, rfl, rfl⟩ := h
                            exact ⟨policy, ordered, available, rate, rfl, hinc', ho, ha, hs, hsh', hal,
                              hsum, hr, hrr', hm⟩

/-! ## The rejections of `calculateInventoryCost` -/

/-- The conditions of lines 886 to 895 under which a request is incoherent, as plain statements about
constructible values: the policy is for another book, has no pool or two pools with one identifier
or one account; there are more layers than the limit or two with one identifier; the quantity is not
above zero; a layer has no quantity, a negative basis, or an account that is no pool's; a policy that
rejects shortages names a provisional method or rate, or one that allows them names no method; a
standard cost or explicit rate is missing or not above zero. -/
def CostIncoherent (policy : InventoryCostPolicy) (bookId : BookId)
    (request : InventoryCostRequest) : Prop :=
  policy.bookId ≠ bookId ∨ policy.pools = [] ∨ ¬ (policy.pools.map (·.id)).Nodup ∨
  accountingLimits.maxInventoryLayers < request.layers.length ∨
  ¬ (policy.pools.map (·.accountId)).Nodup ∨ ¬ (request.layers.map (·.id)).Nodup ∨
  ¬ 0 < request.quantity.toRat ∨
  (∃ l ∈ request.layers, ¬ 0 < l.quantity.toRat ∨ l.totalBasis.toRat < 0 ∨
    ∀ pool ∈ policy.pools, pool.accountId ≠ l.accountId) ∨
  (if policy.shortageTreatment = .reject then
      policy.provisionalBasisMethod ≠ none ∨ policy.provisionalRate ≠ none
    else policy.provisionalBasisMethod = none) ∨
  ((policy.provisionalBasisMethod = some .standardCost ∨
      policy.provisionalBasisMethod = some .explicitRate) ∧
    (policy.provisionalRate = none ∨ ∃ rate, policy.provisionalRate = some rate ∧
      ¬ 0 < rate.toRat))

/-- The test of the coherence of a request is exactly these conditions. -/
theorem costIncoherent_iff {policy : InventoryCostPolicy} {bookId : BookId}
    {request : InventoryCostRequest} (hr : request.WF)
    (hrate : ∀ rate, policy.provisionalRate = some rate → rate.WF) :
    costIncoherent policy bookId request = true ↔ CostIncoherent policy bookId request := by
  have hlayer : ∀ l ∈ request.layers, (!positive l.quantity || l.totalBasis.isNegative ||
      !policy.pools.any (fun pool => pool.accountId == l.accountId)) = true ↔
      (¬ 0 < l.quantity.toRat ∨ l.totalBasis.toRat < 0 ∨
        ∀ pool ∈ policy.pools, pool.accountId ≠ l.accountId) := by
    intro l hl
    have hw := hr.layers l hl
    rw [Bool.or_eq_true, Bool.or_eq_true, or_assoc, not_positive_iff hw.quantity,
      ExactRational.isNegative_iff hw.totalBasis]
    refine or_congr Iff.rfl (or_congr Iff.rfl ?_)
    simp
  unfold costIncoherent CostIncoherent
  simp only [Bool.or_eq_true, or_assoc]
  have hset : ∀ {α β : Type} [DecidableEq β] (l : List α) (f : α → β),
      (Lots.setSize (l.map f) != l.length) = true ↔ ¬ (l.map f).Nodup := by
    intro α β _ l f
    rw [bne_iff_ne, ne_eq, ← List.length_map (f := f) (as := l), Lots.setSize_eq_length_iff]
  refine or_congr bne_iff_ne (or_congr ?_ (or_congr (hset _ _) (or_congr ?_ (or_congr (hset _ _)
    (or_congr (hset _ _) (or_congr (not_positive_iff hr.quantity) (or_congr ?_
      (or_congr ?_ ?_))))))))
  · simp
  · simp
  · rw [List.any_eq_true]
    constructor
    · rintro ⟨l, hl, h⟩
      exact ⟨l, hl, (hlayer l hl).mp h⟩
    · rintro ⟨l, hl, h⟩
      exact ⟨l, hl, (hlayer l hl).mpr h⟩
  · by_cases h : policy.shortageTreatment = .reject
    · simp only [h, beq_self_eq_true, ↓reduceIte, Bool.or_eq_true]
      exact or_congr Option.isSome_iff_ne_none Option.isSome_iff_ne_none
    · simp [h]
  · cases hpr : policy.provisionalRate with
    | none => simp
    | some rate =>
      have := not_positive_iff (hrate rate hpr)
      simp [this]

/-! ## The layers a request is costed from -/

/-- Every method but specific identification costs from the request's layers: the layers it orders
are the layers it was given, each as many times. -/
theorem costOrder_perm {method : InventoryCostMethod} {request : InventoryCostRequest}
    {ordered : List InventoryLayerInput} (hm : method ≠ .specificIdentification)
    (h : costOrder method request = .ok (some ordered)) : ordered.Perm request.layers := by
  cases method with
  | specificIdentification => exact absurd rfl hm
  | weightedAverage =>
    simp only [costOrder, Except.ok.injEq, Option.some.injEq] at h
    subst h
    exact List.Perm.refl _
  | fifo =>
    simp only [costOrder] at h
    cases hs : Lots.stableSort (costCompare .fifo) request.layers with
    | error e => simp [hs] at h
    | ok sorted =>
      simp only [hs, Except.ok.injEq, Option.some.injEq] at h
      subst h
      exact Lots.stableSort_perm _ _ _ hs
  | lifo =>
    simp only [costOrder] at h
    cases hs : Lots.stableSort (costCompare .lifo) request.layers with
    | error e => simp [hs] at h
    | ok sorted =>
      simp only [hs, Except.ok.injEq, Option.some.injEq] at h
      subst h
      exact Lots.stableSort_perm _ _ _ hs
  | hifo =>
    simp only [costOrder] at h
    cases hs : Lots.stableSort (costCompare .hifo) request.layers with
    | error e => simp [hs] at h
    | ok sorted =>
      simp only [hs, Except.ok.injEq, Option.some.injEq] at h
      subst h
      exact Lots.stableSort_perm _ _ _ hs

/-- Specific identification costs from the layers the request names, in the order it names them:
every identifier is named once and finds a layer. -/
theorem costOrder_specific {request : InventoryCostRequest} {ordered : List InventoryLayerInput}
    (h : costOrder .specificIdentification request = .ok (some ordered)) :
    ordered = specificOrdered request.layers (request.specificLayerIds.getD []) ∧
      specificRejected request.layers (request.specificLayerIds.getD []) = false := by
  simp only [costOrder] at h
  by_cases hr : specificRejected request.layers (request.specificLayerIds.getD []) = true
  · simp [hr] at h
  · have hr' : specificRejected request.layers (request.specificLayerIds.getD []) = false :=
      Bool.eq_false_iff.mpr hr
    simp only [hr', Bool.false_eq_true, ↓reduceIte, Except.ok.injEq, Option.some.injEq] at h
    exact ⟨h.symm, hr'⟩

/-- The layers a specific selection finds are the request's layers named, in the order named. -/
theorem specificOrdered_spec (layers : List InventoryLayerInput) :
    ∀ ids : List String, (specificOrdered layers ids).length = ids.length →
      (specificOrdered layers ids).map (·.id) = ids ∧
        ∀ l ∈ specificOrdered layers ids, l ∈ layers
  | [] => fun _ => ⟨rfl, fun l hl => by simp [specificOrdered] at hl⟩
  | id :: rest => by
    intro hlen
    cases hf : layers.find? (fun layer => layer.id == id) with
    | none =>
      exfalso
      have hle := List.length_filterMap_le (fun id => layers.find? fun layer => layer.id == id) rest
      simp only [specificOrdered, List.filterMap_cons, hf] at hlen
      simp only [List.length_cons] at hlen
      omega
    | some l =>
      simp only [specificOrdered, List.filterMap_cons, hf, List.length_cons,
        Nat.add_right_cancel_iff] at hlen
      obtain ⟨hmap, hmem⟩ := specificOrdered_spec layers rest hlen
      have hid : l.id = id := by
        have := List.find?_some hf
        simpa using this
      refine ⟨?_, ?_⟩
      · simp only [specificOrdered, List.filterMap_cons, hf, List.map_cons]
        simp only [specificOrdered] at hmap
        rw [hmap, hid]
      · intro x hx
        simp only [specificOrdered, List.filterMap_cons, hf, List.mem_cons] at hx
        rcases hx with rfl | hx
        · exact List.mem_of_find?_eq_some hf
        · exact hmem x hx

/-- What a coherent request guarantees, for the laws that follow: the policy is of the book, the
layers have distinct identifiers and a positive quantity, no negative basis, and an account that is a
pool's; the quantity is above zero, and the shortage treatment and the provisional method agree. -/
structure CostCoherent (policy : InventoryCostPolicy) (bookId : BookId)
    (request : InventoryCostRequest) : Prop where
  book : policy.bookId = bookId
  pools : policy.pools ≠ []
  poolIds : (policy.pools.map (·.id)).Nodup
  limit : request.layers.length ≤ accountingLimits.maxInventoryLayers
  poolAccounts : (policy.pools.map (·.accountId)).Nodup
  layerIds : (request.layers.map (·.id)).Nodup
  quantity : 0 < request.quantity.toRat
  layers : ∀ l ∈ request.layers, 0 < l.quantity.toRat ∧ 0 ≤ l.totalBasis.toRat ∧
    ∃ pool ∈ policy.pools, pool.accountId = l.accountId
  rejects : policy.shortageTreatment = .reject →
    policy.provisionalBasisMethod = none ∧ policy.provisionalRate = none
  allows : policy.shortageTreatment ≠ .reject → policy.provisionalBasisMethod ≠ none
  rate : (policy.provisionalBasisMethod = some .standardCost ∨
      policy.provisionalBasisMethod = some .explicitRate) →
    ∃ rate, policy.provisionalRate = some rate ∧ 0 < rate.toRat

/-- A request is coherent exactly when none of the conditions of incoherence holds. -/
theorem costCoherent_iff {policy : InventoryCostPolicy} {bookId : BookId}
    {request : InventoryCostRequest} :
    ¬ CostIncoherent policy bookId request ↔ CostCoherent policy bookId request := by
  constructor
  · intro h
    refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩
    · by_contra hn
      exact h (.inl hn)
    · intro hp
      exact h (.inr (.inl hp))
    · by_contra hn
      refine h ?_
      iterate 2 right
      exact .inl hn
    · by_contra hn
      refine h ?_
      iterate 3 right
      exact .inl (not_le.mp hn)
    · by_contra hn
      refine h ?_
      iterate 4 right
      exact .inl hn
    · by_contra hn
      refine h ?_
      iterate 5 right
      exact .inl hn
    · by_contra hn
      refine h ?_
      iterate 6 right
      exact .inl hn
    · intro l hl
      refine ⟨?_, ?_, ?_⟩
      · by_contra hn
        refine h ?_
        iterate 7 right
        exact .inl ⟨l, hl, .inl hn⟩
      · by_contra hn
        refine h ?_
        iterate 7 right
        exact .inl ⟨l, hl, .inr (.inl (not_le.mp hn))⟩
      · by_contra hn
        refine h ?_
        iterate 7 right
        exact .inl ⟨l, hl, .inr (.inr (fun pool hpool heq => hn ⟨pool, hpool, heq⟩))⟩
    · intro hrej
      by_contra hn
      refine h ?_
      iterate 8 right
      refine .inl ?_
      simp only [hrej, ↓reduceIte]
      by_cases hm : policy.provisionalBasisMethod = none
      · exact .inr (fun hr => hn ⟨hm, hr⟩)
      · exact .inl hm
    · intro hne
      by_contra hn
      refine h ?_
      iterate 8 right
      refine .inl ?_
      simp only [hne, ↓reduceIte]
      exact hn
    · intro hm
      by_contra hn
      refine h ?_
      iterate 9 right
      refine ⟨hm, ?_⟩
      cases hr : policy.provisionalRate with
      | none => exact .inl rfl
      | some r =>
        exact .inr ⟨r, rfl, fun hpos => hn ⟨r, hr, hpos⟩⟩
  · rintro ⟨h1, h2, h3, h4, h5, h6, h7, h8, h9, h10, h11⟩ hinc
    rcases hinc with d | d | d | d | d | d | d | d | d | d
    · exact d h1
    · exact h2 d
    · exact d h3
    · exact absurd h4 (not_le.mpr d)
    · exact d h5
    · exact d h6
    · exact d h7
    · obtain ⟨l, hl, d | d | d⟩ := d
      · exact d (h8 l hl).1
      · exact absurd (h8 l hl).2.1 (not_le.mpr d)
      · obtain ⟨pool, hpool, heq⟩ := (h8 l hl).2.2
        exact d pool hpool heq
    · by_cases hrej : policy.shortageTreatment = .reject
      · simp only [hrej, ↓reduceIte] at d
        obtain ⟨hm, hr⟩ := h9 hrej
        rcases d with d | d
        · exact d hm
        · exact d hr
      · simp only [hrej, ↓reduceIte] at d
        exact h10 hrej d
    · obtain ⟨hm, d⟩ := d
      obtain ⟨r, hr, hpos⟩ := h11 hm
      rcases d with d | ⟨r', hr', hnpos⟩
      · rw [hr] at d; cases d
      · rw [hr] at hr'
        cases hr'
        exact hnpos hpos

/-- A specific selection that is not rejected names every layer once and finds each. -/
theorem specificRejected_false {layers : List InventoryLayerInput} {ids : List String}
    (h : specificRejected layers ids = false) :
    ids.Nodup ∧ (specificOrdered layers ids).length = ids.length := by
  unfold specificRejected at h
  simp only [Bool.or_eq_false_iff, bne_eq_false_iff_eq] at h
  exact ⟨(Lots.setSize_eq_length_iff ids).mp h.1, h.2⟩

/-- Every layer a request is costed from is one of the request's layers. -/
theorem costOrder_mem {method : InventoryCostMethod} {request : InventoryCostRequest}
    {ordered : List InventoryLayerInput} (h : costOrder method request = .ok (some ordered)) :
    ∀ l ∈ ordered, l ∈ request.layers := by
  by_cases hm : method = .specificIdentification
  · subst hm
    obtain ⟨he, hr⟩ := costOrder_specific h
    obtain ⟨-, hlen⟩ := specificRejected_false hr
    intro l hl
    rw [he] at hl
    exact (specificOrdered_spec _ _ hlen).2 l hl
  · intro l hl
    exact (costOrder_perm hm h).mem_iff.mp hl

/-- The quantity the layers hold sums the quantities of the layers costed from. -/
theorem costAvailable_spec {method : InventoryCostMethod} {request : InventoryCostRequest}
    {ordered : List InventoryLayerInput} {available : ExactRational}
    (hw : ∀ l ∈ request.layers, l.WF)
    (ho : costOrder method request = .ok (some ordered))
    (h : costAvailable method ordered request = .ok available) :
    available.WF ∧ available.toRat = (ordered.map (·.quantity.toRat)).sum := by
  unfold costAvailable at h
  by_cases hm : method = .specificIdentification
  · simp only [hm, ↓reduceIte] at h
    obtain ⟨hwf, hr⟩ := accountingSum_ok (fun v hv => by
      obtain ⟨l, hl, rfl⟩ := List.mem_map.mp hv
      exact (hw l (costOrder_mem (hm ▸ ho) l hl)).quantity) h
    exact ⟨hwf, by rw [hr, List.map_map]; rfl⟩
  · simp only [hm, ↓reduceIte] at h
    obtain ⟨hwf, hr⟩ := accountingSum_ok (fun v hv => by
      obtain ⟨l, hl, rfl⟩ := List.mem_map.mp hv
      exact (hw l hl).quantity) h
    refine ⟨hwf, ?_⟩
    rw [hr, List.map_map]
    exact ((costOrder_perm hm ho).map _).sum_eq.symm

/-! ## The quantity costed and the quantity short -/

/-- The quantity costed from the layers is the request, or what is held when that is less. -/
theorem ordinaryQuantityOf_spec {requested available : ExactRational} (hq : requested.WF)
    (ha : available.WF) :
    (ordinaryQuantityOf requested available).WF ∧
      (ordinaryQuantityOf requested available).toRat = min requested.toRat available.toRat := by
  unfold ordinaryQuantityOf
  by_cases h : requested.compare available = .gt
  · simp only [h, ↓reduceIte]
    exact ⟨ha, (min_eq_right ((ExactRational.compare_gt_iff hq ha).mp h).le).symm⟩
  · simp only [h, ↓reduceIte]
    refine ⟨hq, (min_eq_left ?_).symm⟩
    exact not_lt.mp (fun hlt => h ((ExactRational.compare_gt_iff hq ha).mpr hlt))

/-- The loop that takes layers in order (every method but the weighted average): the allocations are
taken from the first layers in order, and add up to the quantity costed. -/
theorem costAllocations_greedy {method : InventoryCostMethod} {request : InventoryCostRequest}
    {ordered : List InventoryLayerInput} {available oq : ExactRational}
    {allocs : List InventoryAllocationResult} (hm : method ≠ .weightedAverage)
    (hw : ∀ l ∈ request.layers, l.WF) (hpos : ∀ l ∈ request.layers, 0 < l.quantity.toRat)
    (ho : costOrder method request = .ok (some ordered))
    (hav : available.toRat = (ordered.map (·.quantity.toRat)).sum) (hoq : oq.WF)
    (hoq0 : 0 ≤ oq.toRat) (hoqle : oq.toRat ≤ available.toRat)
    (h : costAllocations method request ordered available oq = .ok allocs) :
    Greedy ordered allocs ∧ (allocs.map (·.quantity.toRat)).sum = oq.toRat := by
  unfold costAllocations at h
  simp only [hm, ↓reduceIte] at h
  exact takeLayers_ok ordered oq allocs (fun l hl => hw l (costOrder_mem ho l hl))
    (fun l hl => hpos l (costOrder_mem ho l hl)) hoq hoq0 (hav ▸ hoqle) h

/-- A sum of shares of a list: the quantity each layer gives, added up. -/
theorem sum_map_share (l : List InventoryLayerInput) (c d : ℚ) :
    (l.map (fun x => x.quantity.toRat * c / d)).sum = (l.map (·.quantity.toRat)).sum * c / d := by
  induction l with
  | nil => simp
  | cons x xs ih =>
    simp only [List.map_cons, List.sum_cons, ih]
    ring

/-- A sum over two lists whose members stand in a relation that fixes the value. -/
theorem forall₂_sum {α β : Type} {R : α → β → Prop} {f : β → ℚ} {g : α → ℚ} :
    ∀ {l : List α} {a : List β}, List.Forall₂ R l a → (∀ x y, R x y → f y = g x) →
      (a.map f).sum = (l.map g).sum
  | _, _, .nil, _ => rfl
  | _, _, .cons hxy hrest, hfg => by
    simp only [List.map_cons, List.sum_cons]
    rw [hfg _ _ hxy, forall₂_sum hrest hfg]

/-- A sum of bases that are each a share of the quantity taken. -/
theorem sum_basis_share (tb d : ℚ) :
    ∀ allocs : List InventoryAllocationResult,
      (∀ a ∈ allocs, a.basis.toRat = tb * a.quantity.toRat / d) →
      (allocs.map (·.basis.toRat)).sum = tb * (allocs.map (·.quantity.toRat)).sum / d
  | [], _ => by simp
  | a :: rest, h => by
    simp only [List.map_cons, List.sum_cons]
    rw [h a List.mem_cons_self, sum_basis_share tb d rest (fun b hb => h b (List.mem_cons_of_mem _ hb))]
    ring

/-- The weighted average: nothing is taken when nothing is asked; otherwise every layer, sorted by
identifier, gives its share of the quantity and of the total basis of every layer, and the shares add
up to the quantity costed and to its share of the total basis. -/
theorem costAllocations_average {request : InventoryCostRequest}
    {ordered : List InventoryLayerInput} {available oq : ExactRational}
    {allocs : List InventoryAllocationResult}
    (hw : ∀ l ∈ request.layers, l.WF) (hnd : (request.layers.map (·.id)).Nodup)
    (ho : costOrder .weightedAverage request = .ok (some ordered)) (hav : available.WF)
    (havsum : available.toRat = (ordered.map (·.quantity.toRat)).sum) (hoq : oq.WF)
    (hoq0 : 0 ≤ oq.toRat) (hoqle : oq.toRat ≤ available.toRat)
    (h : costAllocations .weightedAverage request ordered available oq = .ok allocs) :
    ∃ totalBasis : ExactRational, totalBasis.WF ∧
      totalBasis.toRat = (request.layers.map (·.totalBasis.toRat)).sum ∧
      (allocs.map (·.quantity.toRat)).sum = oq.toRat ∧
      (allocs.map (·.basis.toRat)).sum = totalBasis.toRat * oq.toRat / available.toRat ∧
      (∀ a ∈ allocs, a.quantity.WF ∧ a.basis.WF) ∧ (oq.toRat = 0 → allocs = []) ∧
      (oq.toRat ≠ 0 → ∃ sorted : List InventoryLayerInput, sorted.Perm request.layers ∧
        sorted.Pairwise (fun x y => Lots.TextLt x.id y.id) ∧
        List.Forall₂ (ShareOf totalBasis oq available) sorted allocs) := by
  have hord : ordered = request.layers := by
    simpa [costOrder] using ho.symm
  subst hord
  unfold costAllocations at h
  simp only [↓reduceIte] at h
  cases hs : accountingSum (request.layers.map (·.totalBasis)) with
  | error e => simp [hs] at h
  | ok totalBasis =>
    simp only [hs] at h
    obtain ⟨htw, htr⟩ := accountingSum_ok (fun v hv => by
      obtain ⟨l, hl, rfl⟩ := List.mem_map.mp hv
      exact (hw l hl).totalBasis) hs
    have htr' : totalBasis.toRat = (request.layers.map (·.totalBasis.toRat)).sum := by
      rw [htr, List.map_map]; rfl
    by_cases hz : oq.isZero = true
    · simp only [hz, ↓reduceIte, Except.ok.injEq] at h
      subst h
      have h0 : oq.toRat = 0 := (ExactRational.isZero_iff hoq).mp hz
      refine ⟨totalBasis, htw, htr', by simp [h0], by simp [h0], fun a ha => absurd ha (by simp),
        fun _ => rfl, fun hne => absurd h0 hne⟩
    · have hz' : oq.isZero = false := Bool.eq_false_iff.mpr hz
      simp only [hz', Bool.false_eq_true, ↓reduceIte] at h
      have h0 : oq.toRat ≠ 0 := fun h0 => hz ((ExactRational.isZero_iff hoq).mpr h0)
      have hpos : 0 < oq.toRat := lt_of_le_of_ne hoq0 (Ne.symm h0)
      have havpos : 0 < available.toRat := lt_of_lt_of_le hpos hoqle
      have hsorted_wf : ∀ l ∈ sortBy (fun left right => compareCanonicalText left.id right.id)
          request.layers, l.WF := fun l hl => hw l ((sortBy_perm _ _).mem_iff.mp hl)
      have hfa := averageShares_ok totalBasis oq available _ allocs htw hoq hav havpos.ne'
        hsorted_wf h
      have hperm := sortBy_perm (fun left right => compareCanonicalText left.id right.id) request.layers
      have hsum : (allocs.map (·.quantity.toRat)).sum = oq.toRat := by
        rw [forall₂_sum hfa (fun x y hxy => hxy.quantity) |>.trans (sum_map_share _ _ _)]
        rw [(hperm.map _).sum_eq, ← havsum]
        field_simp
      have hmem : ∀ a ∈ allocs, a.quantity.WF ∧ a.basis.WF := fun a ha => by
        obtain ⟨x, -, hx⟩ := forall₂_right_mem hfa a ha
        exact ⟨hx.quantity_wf, hx.basis_wf⟩
      refine ⟨totalBasis, htw, htr', hsum, ?_, hmem, fun h' => absurd h' h0, fun _ => ?_⟩
      · rw [sum_basis_share _ _ allocs (fun a ha => by
          obtain ⟨x, -, hx⟩ := forall₂_right_mem hfa a ha
          exact hx.basis), hsum]
      · refine ⟨_, hperm, ?_, hfa⟩
        have hs := sortBy_sorted (cmp := fun left right => compareCanonicalText left.id right.id)
          (lt := Lots.TextLt) Lots.textLt_strictTotal (fun l => l.id) request.layers
          (fun x _ y _ => (compare_gt_iff_textLt x.id y.id).trans Iff.rfl)
        exact hs.imp_of_mem (fun {a b} ha hb hab =>
          before_lt hnd (fun x y hk => hk) ((sortBy_perm _ _).mem_iff.mp ha)
            ((sortBy_perm _ _).mem_iff.mp hb) hab)

/-! ## The rate of a shortage -/

/-- The comparator of the most recent receipt puts `x` after `y` exactly when `y` comes first in the
order of last in first out. -/
theorem recentFirst_gt_iff (x y : InventoryLayerInput) :
    recentFirst x y = .gt ↔ lifoBefore y x := by
  unfold recentFirst lifoBefore Lots.LexLt
  by_cases h : x.acquiredAt = y.acquiredAt
  · simp only [h, ↓reduceIte, compare_gt_iff_textLt]
    have hxy : ¬ Lots.TextLt y.acquiredAt.value y.acquiredAt.value := Lots.textLt_strictTotal.irrefl _
    simp [hxy]
  · have hv : x.acquiredAt.value ≠ y.acquiredAt.value := fun hv => h (by
      cases hx : x.acquiredAt; cases hy : y.acquiredAt
      simp only [hx, hy] at hv ⊢
      exact congrArg Instant.mk hv)
    simp only [h, ↓reduceIte, compare_gt_iff_textLt]
    constructor
    · intro hl; exact Or.inl hl
    · rintro (hl | ⟨he, -⟩)
      · exact hl
      · exact absurd he.symm hv

/-- The most recent receipt comes first in the order of last in first out: it is a layer, and every
other layer is consumed after it in that order. -/
theorem lastReceipt_spec {layers : List InventoryLayerInput} {last : InventoryLayerInput}
    (hnd : (layers.map (·.id)).Nodup) (h : lastReceipt layers = some last) :
    last ∈ layers ∧ ∀ other ∈ layers, other ≠ last → lifoBefore last other := by
  unfold lastReceipt at h
  have hperm := sortBy_perm recentFirst layers
  have hs := sortBy_sorted (cmp := recentFirst) (lt := Lots.LexLt (fun a b => Lots.TextLt b a)
    Lots.TextLt) (Lots.StrictTotal.lex Lots.textLt_strictTotal.flip Lots.textLt_strictTotal)
    (fun z => (z.acquiredAt.value, z.id)) layers
    (fun x _ y _ => recentFirst_gt_iff x y)
  have hsorted : (sortBy recentFirst layers).Pairwise lifoBefore :=
    hs.imp_of_mem (fun {a b} ha hb hab =>
      before_lt hnd (fun x y hk => congrArg Prod.snd hk) (hperm.mem_iff.mp ha)
        (hperm.mem_iff.mp hb) hab)
  cases hl : sortBy recentFirst layers with
  | nil => simp [hl] at h
  | cons first rest =>
    simp only [hl, List.head?_cons, Option.some.injEq] at h
    subst h
    rw [hl] at hsorted hperm
    refine ⟨hperm.mem_iff.mp List.mem_cons_self, fun other hother hne => ?_⟩
    have hmem : other ∈ first :: rest := hperm.mem_iff.mpr hother
    rcases List.mem_cons.mp hmem with h' | h'
    · exact absurd h' hne
    · exact (List.pairwise_cons.mp hsorted).1 other h'

/-- What the rate of a shortage is, by method: zero when nothing is short; the policy's rate for the
standard cost and the explicit rate; for the moving average the average cost of what was taken, over
the quantity taken (which is not zero); and for the last receipt cost the unit cost of the most
recent layer, which every other layer follows in the order of last in first out. -/
theorem provisionalRateOf_spec {policy : InventoryCostPolicy} {request : InventoryCostRequest}
    {pq oq ob rate : ExactRational} (hpw : policy.WF) (hw : ∀ l ∈ request.layers, l.WF)
    (hnd : (request.layers.map (·.id)).Nodup) (hoq : oq.WF) (hob : ob.WF)
    (h : provisionalRateOf policy request pq oq ob = .ok (some rate)) :
    rate.WF ∧
      ((pq.isZero = true ∧ rate = ExactRational.zero) ∨
        (pq.isZero = false ∧ (policy.provisionalBasisMethod = some .standardCost ∨
          policy.provisionalBasisMethod = some .explicitRate) ∧ policy.provisionalRate = some rate) ∨
        (pq.isZero = false ∧ policy.provisionalBasisMethod = some .movingAverage ∧
          oq.isZero = false ∧ rate.toRat = ob.toRat / oq.toRat) ∨
        (pq.isZero = false ∧ (policy.provisionalBasisMethod = none ∨
          policy.provisionalBasisMethod = some .lastReceiptCost) ∧
          ∃ last ∈ request.layers, (∀ other ∈ request.layers, other ≠ last →
            lifoBefore last other) ∧ rate.toRat = last.totalBasis.toRat / last.quantity.toRat)) := by
  unfold provisionalRateOf at h
  by_cases hz : pq.isZero = true
  · simp only [hz, ↓reduceIte, Except.ok.injEq, Option.some.injEq] at h
    subst h
    exact ⟨ExactRational.zero_wf, Or.inl ⟨hz, rfl⟩⟩
  · have hz' : pq.isZero = false := Bool.eq_false_iff.mpr hz
    simp only [hz', Bool.false_eq_true, ↓reduceIte] at h
    cases hm : policy.provisionalBasisMethod with
    | none =>
      simp only [hm] at h
      cases hl : lastReceipt request.layers with
      | none => simp [hl] at h
      | some last =>
        simp only [hl] at h
        cases hd : last.totalBasis.divide last.quantity with
        | error e => simp [hd] at h
        | ok r =>
          simp only [hd, Except.ok.injEq, Option.some.injEq] at h
          subst h
          obtain ⟨hlm, hlo⟩ := lastReceipt_spec hnd hl
          obtain ⟨hrw, -, hrr⟩ := ExactRational.divide_ok (hw last hlm).totalBasis
            (hw last hlm).quantity hd
          exact ⟨hrw, Or.inr (Or.inr (Or.inr ⟨hz', Or.inl rfl, last, hlm, hlo, hrr⟩))⟩
    | some m =>
      cases m with
      | standardCost =>
        simp only [hm, Except.ok.injEq] at h
        exact ⟨hpw.provisionalRate rate h, Or.inr (Or.inl ⟨hz', Or.inl rfl, h⟩)⟩
      | explicitRate =>
        simp only [hm, Except.ok.injEq] at h
        exact ⟨hpw.provisionalRate rate h, Or.inr (Or.inl ⟨hz', Or.inr rfl, h⟩)⟩
      | movingAverage =>
        simp only [hm] at h
        by_cases ho : oq.isZero = true
        · simp [ho] at h
        · have ho' : oq.isZero = false := Bool.eq_false_iff.mpr ho
          simp only [ho', Bool.false_eq_true, ↓reduceIte] at h
          cases hd : ob.divide oq with
          | error e => simp [hd] at h
          | ok r =>
            simp only [hd, Except.ok.injEq, Option.some.injEq] at h
            subst h
            obtain ⟨hrw, -, hrr⟩ := ExactRational.divide_ok hob hoq hd
            exact ⟨hrw, Or.inr (Or.inr (Or.inl ⟨hz', rfl, ho', hrr⟩))⟩
      | lastReceiptCost =>
        simp only [hm] at h
        cases hl : lastReceipt request.layers with
        | none => simp [hl] at h
        | some last =>
          simp only [hl] at h
          cases hd : last.totalBasis.divide last.quantity with
          | error e => simp [hd] at h
          | ok r =>
            simp only [hd, Except.ok.injEq, Option.some.injEq] at h
            subst h
            obtain ⟨hlm, hlo⟩ := lastReceipt_spec hnd hl
            obtain ⟨hrw, -, hrr⟩ := ExactRational.divide_ok (hw last hlm).totalBasis
              (hw last hlm).quantity hd
            exact ⟨hrw, Or.inr (Or.inr (Or.inr ⟨hz', Or.inr rfl, last, hlm, hlo, hrr⟩))⟩

/-! ## What every costed result satisfies -/

/-- Everything a costed result rests on, for constructible policies and a constructible request: the
policy that governed, a coherent request, the layers costed from and the quantity they hold, the
quantity costed and the quantity short (not zero only if the policy allows a shortage), the
allocations and their total, and the rate and the price of the shortage. -/
theorem calculateInventoryCost_costed_context {policies : List AccountingPolicy} {bookId : BookId}
    {request : InventoryCostRequest} {allocs : List InventoryAllocationResult}
    {ob pq pb : ExactRational} (hp : ∀ p ∈ policies, p.WF) (hr : request.WF)
    (h : calculateInventoryCost policies bookId request = .ok (.costed allocs ob pq pb)) :
    ∃ (policy : InventoryCostPolicy) (ordered : List InventoryLayerInput)
      (available oq rate : ExactRational),
      policyAt InventoryCostPolicy policies request.policyId request.policyVersion
        request.governedAt = .selected policy ∧
      AccountingPolicy.inventoryCost policy ∈ policies ∧ policy.WF ∧
      CostCoherent policy bookId request ∧
      costOrder policy.method request = .ok (some ordered) ∧
      available.WF ∧ available.toRat = (ordered.map (·.quantity.toRat)).sum ∧
      oq = ordinaryQuantityOf request.quantity available ∧ oq.WF ∧
      oq.toRat = min request.quantity.toRat available.toRat ∧
      pq.WF ∧ pq.toRat = request.quantity.toRat - oq.toRat ∧
      (pq.isZero = true ∨
        (policy.shortageTreatment ≠ .reject ∧ policy.provisionalBasisMethod ≠ none)) ∧
      costAllocations policy.method request ordered available oq = .ok allocs ∧
      accountingSum (allocs.map (·.basis)) = .ok ob ∧
      provisionalRateOf policy request pq oq ob = .ok (some rate) ∧
      pq.multiply rate = .ok pb ∧ rateRejected pq (some rate) = false := by
  obtain ⟨policy, ordered, available, rate, hpol, hinc, ho, ha, hs, hsh, hal, hsum, hrt, hrr, hm⟩ :=
    calculateInventoryCost_costed_inv h
  have hmem := policyAt_inventoryCost_mem hpol
  have hpw : policy.WF := hp _ hmem
  have hcoh : CostCoherent policy bookId request := costCoherent_iff.mp (fun hc => by
    have := (costIncoherent_iff hr (fun r hr' => hpw.provisionalRate r hr')).mpr hc
    rw [hinc] at this
    cases this)
  obtain ⟨hawf, havsum⟩ := costAvailable_spec hr.layers ho ha
  obtain ⟨hoqwf, hoqval⟩ := ordinaryQuantityOf_spec hr.quantity hawf
  obtain ⟨hpqwf, hpqval⟩ := ExactRational.subtract_ok hr.quantity hoqwf hs
  refine ⟨policy, ordered, available, ordinaryQuantityOf request.quantity available, rate, hpol,
    hmem, hpw, hcoh, ho, hawf, havsum, rfl, hoqwf, hoqval, hpqwf, ?_, ?_, hal, hsum, hrt, hm, hrr⟩
  · rw [hpqval, hoqval]
  · by_cases hz : pq.isZero = true
    · exact Or.inl hz
    · have hz' : pq.isZero = false := Bool.eq_false_iff.mpr hz
      simp only [hz', Bool.not_false, Bool.true_and, Bool.or_eq_false_iff, beq_eq_false_iff_ne,
        ne_eq] at hsh
      exact Or.inr ⟨hsh.1, fun h0 => by have := hsh.2; rw [h0] at this; simp at this⟩

/-- A greedy run names the first layers, in order: its layer identifiers are a prefix of the layers'. -/
theorem greedy_prefix : ∀ (ordered : List InventoryLayerInput)
    (allocs : List InventoryAllocationResult), Greedy ordered allocs →
    (allocs.map (·.layerId)).IsPrefix (ordered.map (·.id))
  | _, [], _ => List.nil_prefix
  | [], _ :: _, h => by simp [Greedy] at h
  | l :: ls, a :: rest, h => by
    obtain ⟨ht, -, hg⟩ := h
    simp only [List.map_cons, ht.layerId]
    exact List.cons_prefix_cons.mpr ⟨rfl, greedy_prefix ls rest hg⟩

/-- The layers costed from have distinct identifiers when the request's layers do. -/
theorem costOrder_ids_nodup {method : InventoryCostMethod} {request : InventoryCostRequest}
    {ordered : List InventoryLayerInput} (hnd : (request.layers.map (·.id)).Nodup)
    (ho : costOrder method request = .ok (some ordered)) : (ordered.map (·.id)).Nodup := by
  by_cases hm : method = .specificIdentification
  · subst hm
    obtain ⟨he, hr⟩ := costOrder_specific ho
    obtain ⟨hids, hlen⟩ := specificRejected_false hr
    rw [he, (specificOrdered_spec _ _ hlen).1]
    exact hids
  · exact ((costOrder_perm hm ho).map _).nodup_iff.mpr hnd

/-- The quantity the layers hold that a method costs from (line 910): the layers a specific selection
names, or every layer. -/
def heldQuantity (method : InventoryCostMethod) (request : InventoryCostRequest) : ℚ :=
  match method with
  | .specificIdentification =>
    ((specificOrdered request.layers (request.specificLayerIds.getD [])).map
      (·.quantity.toRat)).sum
  | _ => (request.layers.map (·.quantity.toRat)).sum

/-- The quantity the layers hold, as `calculateInventoryCost` sums it, is `heldQuantity`. -/
theorem costOrder_held {method : InventoryCostMethod} {request : InventoryCostRequest}
    {ordered : List InventoryLayerInput} (ho : costOrder method request = .ok (some ordered)) :
    (ordered.map (·.quantity.toRat)).sum = heldQuantity method request := by
  by_cases hm : method = .specificIdentification
  · subst hm
    obtain ⟨he, -⟩ := costOrder_specific ho
    rw [he]
    rfl
  · cases method with
    | specificIdentification => exact absurd rfl hm
    | _ => exact ((costOrder_perm hm ho).map _).sum_eq

/-! ## The laws of a costed result -/

/-- The bounds that let the loops run: what the layers hold is not negative, and the quantity costed
is between nothing and what they hold. -/
theorem costed_bounds {request : InventoryCostRequest} {policy : InventoryCostPolicy}
    {bookId : BookId} {ordered : List InventoryLayerInput} {available oq : ExactRational}
    (hcoh : CostCoherent policy bookId request)
    (ho : costOrder policy.method request = .ok (some ordered))
    (havsum : available.toRat = (ordered.map (·.quantity.toRat)).sum)
    (hoqval : oq.toRat = min request.quantity.toRat available.toRat) :
    0 ≤ available.toRat ∧ 0 ≤ oq.toRat ∧ oq.toRat ≤ available.toRat := by
  have hav0 : 0 ≤ available.toRat := by
    rw [havsum]
    exact List.sum_nonneg (fun x hx => by
      obtain ⟨l, hl, rfl⟩ := List.mem_map.mp hx
      exact (hcoh.layers l (costOrder_mem ho l hl)).1.le)
  exact ⟨hav0, by rw [hoqval]; exact le_min hcoh.quantity.le hav0, by
    rw [hoqval]; exact min_le_right _ _⟩

/-- The quantity taken from the layers plus the quantity short is the quantity requested, exactly. -/
theorem calculateInventoryCost_quantity {policies : List AccountingPolicy} {bookId : BookId}
    {request : InventoryCostRequest} {allocs : List InventoryAllocationResult}
    {ob pq pb : ExactRational} (hp : ∀ p ∈ policies, p.WF) (hr : request.WF)
    (h : calculateInventoryCost policies bookId request = .ok (.costed allocs ob pq pb)) :
    (allocs.map (·.quantity.toRat)).sum + pq.toRat = request.quantity.toRat := by
  obtain ⟨policy, ordered, available, oq, rate, hpol, -, hpw, hcoh, ho, hawf, havsum, -, hoqwf,
    hoqval, hpqwf, hpqval, -, hal, -, -, -⟩ := calculateInventoryCost_costed_context hp hr h
  obtain ⟨-, hoq0, hoqle⟩ := costed_bounds hcoh ho havsum hoqval
  have hsum : (allocs.map (·.quantity.toRat)).sum = oq.toRat := by
    by_cases hm : policy.method = .weightedAverage
    · rw [hm] at ho hal
      obtain ⟨tb, -, -, hq, -⟩ := costAllocations_average hr.layers hcoh.layerIds ho hawf havsum
        hoqwf hoq0 hoqle hal
      exact hq
    · exact (costAllocations_greedy hm hr.layers (fun l hl => (hcoh.layers l hl).1) ho havsum
        hoqwf hoq0 hoqle hal).2
  rw [hsum, hpqval]
  ring

/-- The quantity short is what the request asks beyond what the layers hold, and nothing otherwise;
it is not zero only for a policy that allows a shortage and names how to price it. -/
theorem calculateInventoryCost_shortage {policies : List AccountingPolicy} {bookId : BookId}
    {request : InventoryCostRequest} {allocs : List InventoryAllocationResult}
    {ob pq pb : ExactRational} (hp : ∀ p ∈ policies, p.WF) (hr : request.WF)
    (h : calculateInventoryCost policies bookId request = .ok (.costed allocs ob pq pb)) :
    ∃ policy : InventoryCostPolicy,
      policyAt InventoryCostPolicy policies request.policyId request.policyVersion
        request.governedAt = .selected policy ∧
      pq.toRat = request.quantity.toRat - min request.quantity.toRat (heldQuantity policy.method request) ∧
      (0 < pq.toRat ↔ heldQuantity policy.method request < request.quantity.toRat) ∧
      (pq.toRat ≠ 0 → policy.shortageTreatment ≠ .reject ∧ policy.provisionalBasisMethod ≠ none) := by
  obtain ⟨policy, ordered, available, oq, rate, hpol, -, hpw, hcoh, ho, hawf, havsum, -, hoqwf,
    hoqval, hpqwf, hpqval, hshort, -, -, -, -⟩ := calculateInventoryCost_costed_context hp hr h
  have hheld := costOrder_held ho
  rw [← havsum] at hheld
  refine ⟨policy, hpol, ?_⟩
  rw [← hheld]
  refine ⟨by rw [hpqval, hoqval], ?_, ?_⟩
  · rw [hpqval, hoqval]
    constructor
    · intro hpos
      by_contra hnot
      rw [min_eq_left (not_lt.mp hnot)] at hpos
      simp at hpos
    · intro hlt
      rw [min_eq_right hlt.le]
      linarith
  · intro hne
    rcases hshort with hz | hok
    · exact absurd ((ExactRational.isZero_iff hpqwf).mp hz) hne
    · exact hok

/-- The layers of the shares of a weighted average, in order, are the layers named by the
allocations. -/
theorem shares_layerIds {tb oq av : ExactRational} :
    ∀ {sorted : List InventoryLayerInput} {allocs : List InventoryAllocationResult},
      List.Forall₂ (ShareOf tb oq av) sorted allocs → allocs.map (·.layerId) = sorted.map (·.id)
  | _, _, .nil => rfl
  | _, _, .cons hxy hrest => by
    simp only [List.map_cons, hxy.layerId, shares_layerIds hrest]

/-- The allocations of a costed result name distinct layers of the request, and no other layer: every
layer that is not named is left as it was. -/
theorem calculateInventoryCost_layers {policies : List AccountingPolicy} {bookId : BookId}
    {request : InventoryCostRequest} {allocs : List InventoryAllocationResult}
    {ob pq pb : ExactRational} (hp : ∀ p ∈ policies, p.WF) (hr : request.WF)
    (h : calculateInventoryCost policies bookId request = .ok (.costed allocs ob pq pb)) :
    (allocs.map (·.layerId)).Nodup ∧ ∀ a ∈ allocs, ∃ l ∈ request.layers, a.layerId = l.id := by
  obtain ⟨policy, ordered, available, oq, rate, hpol, -, hpw, hcoh, ho, hawf, havsum, -, hoqwf,
    hoqval, hpqwf, hpqval, -, hal, -, -, -⟩ := calculateInventoryCost_costed_context hp hr h
  obtain ⟨-, hoq0, hoqle⟩ := costed_bounds hcoh ho havsum hoqval
  by_cases hm : policy.method = .weightedAverage
  · rw [hm] at ho hal
    obtain ⟨tb, -, -, -, -, -, hz, hne⟩ := costAllocations_average hr.layers hcoh.layerIds ho hawf
      havsum hoqwf hoq0 hoqle hal
    by_cases h0 : oq.toRat = 0
    · rw [hz h0]
      exact ⟨List.nodup_nil, fun a ha => by cases ha⟩
    · obtain ⟨sorted, hperm, -, hfa⟩ := hne h0
      rw [shares_layerIds hfa]
      exact ⟨(hperm.map _).nodup_iff.mpr hcoh.layerIds, fun a ha => by
        obtain ⟨x, hx, hax⟩ := forall₂_right_mem hfa a ha
        exact ⟨x, hperm.mem_iff.mp hx, hax.layerId⟩⟩
  · obtain ⟨hg, -⟩ := costAllocations_greedy hm hr.layers (fun l hl => (hcoh.layers l hl).1) ho
      havsum hoqwf hoq0 hoqle hal
    refine ⟨(greedy_prefix ordered allocs hg).sublist.nodup (costOrder_ids_nodup hcoh.layerIds ho),
      fun a ha => ?_⟩
    obtain ⟨l, hl, hal'⟩ := greedy_mem ordered allocs hg a ha
    exact ⟨l, costOrder_mem ho l hl, hal'⟩

/-- `policyAt` selects one policy. -/
theorem policyAt_unique {T : Type} [AccountingPolicyKind T] {policies : List AccountingPolicy}
    {id : PolicyId} {version : SemanticVersion} {at_ : Instant} {p q : T}
    (hp : policyAt T policies id version at_ = .selected p)
    (hq : policyAt T policies id version at_ = .selected q) : p = q := by
  rw [hp] at hq
  exact AccountingPolicySelection.selected.inj hq

/-- A key that tells layers apart under a strict total order gives a relation no layer bears to
itself or in both directions. -/
theorem strict_irrefl_asymm {κ : Type} {lt : κ → κ → Prop} (h : Lots.StrictTotal lt)
    (key : InventoryLayerInput → κ) :
    (∀ x, ¬ lt (key x) (key x)) ∧ (∀ x y, lt (key x) (key y) → ¬ lt (key y) (key x)) :=
  ⟨fun _ => h.irrefl _, fun _ _ hxy hyx => h.irrefl _ (h.trans hxy hyx)⟩

/-- First in first out never takes from a later layer while an earlier one has quantity left: when a
layer is taken from, every layer acquired before it (earlier instant, or the same and a lower
identifier) is taken whole. -/
theorem calculateInventoryCost_fifo {policies : List AccountingPolicy} {bookId : BookId}
    {request : InventoryCostRequest} {allocs : List InventoryAllocationResult}
    {ob pq pb : ExactRational} {policy : InventoryCostPolicy} (hp : ∀ p ∈ policies, p.WF)
    (hr : request.WF)
    (h : calculateInventoryCost policies bookId request = .ok (.costed allocs ob pq pb))
    (hpol : policyAt InventoryCostPolicy policies request.policyId request.policyVersion
      request.governedAt = .selected policy) (hm : policy.method = .fifo) :
    ∀ x ∈ request.layers, ∀ y ∈ request.layers, fifoBefore x y →
      (∃ a ∈ allocs, a.layerId = y.id) →
        ∃ a ∈ allocs, a.layerId = x.id ∧ a.quantity = x.quantity := by
  obtain ⟨policy', ordered, available, oq, rate, hpol', -, hpw, hcoh, ho, hawf, havsum, -, hoqwf,
    hoqval, hpqwf, hpqval, -, hal, -, -, -⟩ := calculateInventoryCost_costed_context hp hr h
  have e := policyAt_unique hpol hpol'
  subst e
  obtain ⟨-, hoq0, hoqle⟩ := costed_bounds hcoh ho havsum hoqval
  rw [hm] at ho hal
  obtain ⟨hperm, hsorted⟩ := costOrder_fifo hcoh.layerIds ho
  obtain ⟨hg, -⟩ := costAllocations_greedy (by decide) hr.layers
    (fun l hl => (hcoh.layers l hl).1) ho havsum hoqwf hoq0 hoqle hal
  obtain ⟨hirr, hasym⟩ := strict_irrefl_asymm
    (Lots.StrictTotal.lex Lots.textLt_strictTotal Lots.textLt_strictTotal)
    (fun z : InventoryLayerInput => (z.acquiredAt.value, z.id))
  intro x hx y hy hxy hy'
  exact greedy_before (R := fifoBefore) hirr hasym ordered allocs
    (costOrder_ids_nodup hcoh.layerIds ho) hsorted hg x (hperm.mem_iff.mpr hx) y
    (hperm.mem_iff.mpr hy) hxy hy'

/-- Last in first out never takes from a later layer while an earlier one has quantity left: when a
layer is taken from, every layer acquired after it (later instant, or the same and a lower
identifier) is taken whole. -/
theorem calculateInventoryCost_lifo {policies : List AccountingPolicy} {bookId : BookId}
    {request : InventoryCostRequest} {allocs : List InventoryAllocationResult}
    {ob pq pb : ExactRational} {policy : InventoryCostPolicy} (hp : ∀ p ∈ policies, p.WF)
    (hr : request.WF)
    (h : calculateInventoryCost policies bookId request = .ok (.costed allocs ob pq pb))
    (hpol : policyAt InventoryCostPolicy policies request.policyId request.policyVersion
      request.governedAt = .selected policy) (hm : policy.method = .lifo) :
    ∀ x ∈ request.layers, ∀ y ∈ request.layers, lifoBefore x y →
      (∃ a ∈ allocs, a.layerId = y.id) →
        ∃ a ∈ allocs, a.layerId = x.id ∧ a.quantity = x.quantity := by
  obtain ⟨policy', ordered, available, oq, rate, hpol', -, hpw, hcoh, ho, hawf, havsum, -, hoqwf,
    hoqval, hpqwf, hpqval, -, hal, -, -, -⟩ := calculateInventoryCost_costed_context hp hr h
  have e := policyAt_unique hpol hpol'
  subst e
  obtain ⟨-, hoq0, hoqle⟩ := costed_bounds hcoh ho havsum hoqval
  rw [hm] at ho hal
  obtain ⟨hperm, hsorted⟩ := costOrder_lifo hcoh.layerIds ho
  obtain ⟨hg, -⟩ := costAllocations_greedy (by decide) hr.layers
    (fun l hl => (hcoh.layers l hl).1) ho havsum hoqwf hoq0 hoqle hal
  obtain ⟨hirr, hasym⟩ := strict_irrefl_asymm
    (Lots.StrictTotal.lex Lots.textLt_strictTotal.flip Lots.textLt_strictTotal)
    (fun z : InventoryLayerInput => (z.acquiredAt.value, z.id))
  intro x hx y hy hxy hy'
  exact greedy_before (R := lifoBefore) hirr hasym ordered allocs
    (costOrder_ids_nodup hcoh.layerIds ho) hsorted hg x (hperm.mem_iff.mpr hx) y
    (hperm.mem_iff.mpr hy) hxy hy'

/-- Highest cost first never takes from a cheaper layer while a dearer one has quantity left: when a
layer is taken from, every layer of higher unit cost (or the same unit cost and a lower identifier)
is taken whole. -/
theorem calculateInventoryCost_hifo {policies : List AccountingPolicy} {bookId : BookId}
    {request : InventoryCostRequest} {allocs : List InventoryAllocationResult}
    {ob pq pb : ExactRational} {policy : InventoryCostPolicy} (hp : ∀ p ∈ policies, p.WF)
    (hr : request.WF)
    (h : calculateInventoryCost policies bookId request = .ok (.costed allocs ob pq pb))
    (hpol : policyAt InventoryCostPolicy policies request.policyId request.policyVersion
      request.governedAt = .selected policy) (hm : policy.method = .hifo) :
    ∀ x ∈ request.layers, ∀ y ∈ request.layers, hifoBefore x y →
      (∃ a ∈ allocs, a.layerId = y.id) →
        ∃ a ∈ allocs, a.layerId = x.id ∧ a.quantity = x.quantity := by
  obtain ⟨policy', ordered, available, oq, rate, hpol', -, hpw, hcoh, ho, hawf, havsum, -, hoqwf,
    hoqval, hpqwf, hpqval, -, hal, -, -, -⟩ := calculateInventoryCost_costed_context hp hr h
  have e := policyAt_unique hpol hpol'
  subst e
  obtain ⟨-, hoq0, hoqle⟩ := costed_bounds hcoh ho havsum hoqval
  rw [hm] at ho hal
  obtain ⟨hperm, hsorted⟩ := costOrder_hifo hr.layers hcoh.layerIds ho
  obtain ⟨hg, -⟩ := costAllocations_greedy (by decide) hr.layers
    (fun l hl => (hcoh.layers l hl).1) ho havsum hoqwf hoq0 hoqle hal
  obtain ⟨hirr, hasym⟩ := strict_irrefl_asymm
    (Lots.StrictTotal.lex Lots.ratGt_strictTotal Lots.textLt_strictTotal)
    (fun z : InventoryLayerInput => (z.totalBasis.toRat / z.quantity.toRat, z.id))
  intro x hx y hy hxy hy'
  exact greedy_before (R := hifoBefore) hirr hasym ordered allocs
    (costOrder_ids_nodup hcoh.layerIds ho) hsorted hg x (hperm.mem_iff.mpr hx) y
    (hperm.mem_iff.mpr hy) hxy hy'

/-- Specific identification takes the layers the request names, in the order it names them: every
name finds a layer, the allocations are of the first of them, and each but the last takes its layer
whole. -/
theorem calculateInventoryCost_specific {policies : List AccountingPolicy} {bookId : BookId}
    {request : InventoryCostRequest} {allocs : List InventoryAllocationResult}
    {ob pq pb : ExactRational} {policy : InventoryCostPolicy} (hp : ∀ p ∈ policies, p.WF)
    (hr : request.WF)
    (h : calculateInventoryCost policies bookId request = .ok (.costed allocs ob pq pb))
    (hpol : policyAt InventoryCostPolicy policies request.policyId request.policyVersion
      request.governedAt = .selected policy) (hm : policy.method = .specificIdentification) :
    (∀ id ∈ request.specificLayerIds.getD [], ∃ l ∈ request.layers, l.id = id) ∧
      (allocs.map (·.layerId)).IsPrefix (request.specificLayerIds.getD []) ∧
      Greedy (specificOrdered request.layers (request.specificLayerIds.getD [])) allocs := by
  obtain ⟨policy', ordered, available, oq, rate, hpol', -, hpw, hcoh, ho, hawf, havsum, -, hoqwf,
    hoqval, hpqwf, hpqval, -, hal, -, -, -⟩ := calculateInventoryCost_costed_context hp hr h
  have e := policyAt_unique hpol hpol'
  subst e
  obtain ⟨-, hoq0, hoqle⟩ := costed_bounds hcoh ho havsum hoqval
  rw [hm] at ho hal
  obtain ⟨he, hrej⟩ := costOrder_specific ho
  obtain ⟨-, hlen⟩ := specificRejected_false hrej
  obtain ⟨hmap, hmem⟩ := specificOrdered_spec request.layers _ hlen
  obtain ⟨hg, -⟩ := costAllocations_greedy (by decide) hr.layers
    (fun l hl => (hcoh.layers l hl).1) ho havsum hoqwf hoq0 hoqle hal
  rw [he] at hg
  refine ⟨fun id hid => ?_, ?_, hg⟩
  · rw [← hmap] at hid
    obtain ⟨l, hl, rfl⟩ := List.mem_map.mp hid
    exact ⟨l, hmem l hl, rfl⟩
  · have := greedy_prefix _ allocs hg
    rwa [hmap] at this

/-- The weighted average takes every layer in proportion: with `held` the quantity all the layers
hold, `total` the total basis of all the layers, and `taken` the quantity costed, each layer, in the
order of its identifier, gives `taken / held` of its quantity and the same share of the total basis;
the shares of the cost add up to `taken / held` of the total basis. -/
theorem calculateInventoryCost_weightedAverage {policies : List AccountingPolicy}
    {bookId : BookId} {request : InventoryCostRequest} {allocs : List InventoryAllocationResult}
    {ob pq pb : ExactRational} {policy : InventoryCostPolicy} (hp : ∀ p ∈ policies, p.WF)
    (hr : request.WF)
    (h : calculateInventoryCost policies bookId request = .ok (.costed allocs ob pq pb))
    (hpol : policyAt InventoryCostPolicy policies request.policyId request.policyVersion
      request.governedAt = .selected policy) (hm : policy.method = .weightedAverage) :
    ∃ (total taken held : ExactRational),
      total.toRat = (request.layers.map (·.totalBasis.toRat)).sum ∧
      held.toRat = (request.layers.map (·.quantity.toRat)).sum ∧
      taken.toRat = min request.quantity.toRat held.toRat ∧
      ob.toRat = total.toRat * taken.toRat / held.toRat ∧
      ((taken.toRat = 0 ∧ allocs = []) ∨
        (taken.toRat ≠ 0 ∧ ∃ sorted : List InventoryLayerInput, sorted.Perm request.layers ∧
          sorted.Pairwise (fun x y => Lots.TextLt x.id y.id) ∧
          List.Forall₂ (ShareOf total taken held) sorted allocs)) := by
  obtain ⟨policy', ordered, available, oq, rate, hpol', -, hpw, hcoh, ho, hawf, havsum, -, hoqwf,
    hoqval, hpqwf, hpqval, -, hal, hsum, -, -⟩ := calculateInventoryCost_costed_context hp hr h
  have e := policyAt_unique hpol hpol'
  subst e
  obtain ⟨-, hoq0, hoqle⟩ := costed_bounds hcoh ho havsum hoqval
  rw [hm] at ho hal
  have hord : ordered = request.layers := by simpa [costOrder] using ho.symm
  subst hord
  obtain ⟨tb, htbw, htbr, hq, hb, hwf, hz, hne⟩ := costAllocations_average hr.layers hcoh.layerIds
    ho hawf havsum hoqwf hoq0 hoqle hal
  obtain ⟨-, hobr⟩ := accountingSum_ok (fun v hv => by
    obtain ⟨a, ha, rfl⟩ := List.mem_map.mp hv
    exact (hwf a ha).2) hsum
  refine ⟨tb, oq, available, htbr, ?_, hoqval, ?_, ?_⟩
  · exact havsum
  · rw [hobr, List.map_map, ← hb]; rfl
  · by_cases h0 : oq.toRat = 0
    · exact Or.inl ⟨h0, hz h0⟩
    · exact Or.inr ⟨h0, hne h0⟩

/-- Every allocation of a greedy run was taken from one of the layers. -/
theorem greedy_taken : ∀ (ordered : List InventoryLayerInput)
    (allocs : List InventoryAllocationResult), Greedy ordered allocs →
    ∀ a ∈ allocs, ∃ l ∈ ordered, TakenFrom l a
  | _, [], _ => fun a ha => by cases ha
  | [], _ :: _, h => by simp [Greedy] at h
  | l :: ls, a :: rest, h => by
    obtain ⟨ht, -, hg⟩ := h
    intro b hb
    rcases List.mem_cons.mp hb with rfl | hb
    · exact ⟨l, List.mem_cons_self, ht⟩
    · obtain ⟨l', hl', hl''⟩ := greedy_taken ls rest hg b hb
      exact ⟨l', List.mem_cons_of_mem _ hl', hl''⟩

/-- A layer taken whole gives up its total basis, exactly. -/
theorem takenFrom_whole {l : InventoryLayerInput} {a : InventoryAllocationResult}
    (hl : 0 < l.quantity.toRat) (ht : TakenFrom l a) (hq : a.quantity = l.quantity) :
    a.basis.toRat = l.totalBasis.toRat := by
  rw [ht.basis, hq]
  field_simp

/-- The cost taken from the layers is the cost assigned: the ordinary basis is the sum of the bases of
the allocations, exactly. For every method but the weighted average each allocation is of one layer
and its basis is that layer's total basis times the quantity taken over the layer's quantity (the
whole total basis for a layer taken whole). -/
theorem calculateInventoryCost_ordinaryBasis {policies : List AccountingPolicy}
    {bookId : BookId} {request : InventoryCostRequest} {allocs : List InventoryAllocationResult}
    {ob pq pb : ExactRational} (hp : ∀ p ∈ policies, p.WF) (hr : request.WF)
    (h : calculateInventoryCost policies bookId request = .ok (.costed allocs ob pq pb)) :
    ob.toRat = (allocs.map (·.basis.toRat)).sum ∧
      ∃ policy : InventoryCostPolicy,
        policyAt InventoryCostPolicy policies request.policyId request.policyVersion
          request.governedAt = .selected policy ∧
        (policy.method ≠ .weightedAverage → ∀ a ∈ allocs, ∃ l ∈ request.layers,
          a.layerId = l.id ∧ 0 < a.quantity.toRat ∧ a.quantity.toRat ≤ l.quantity.toRat ∧
          a.basis.toRat = l.totalBasis.toRat * a.quantity.toRat / l.quantity.toRat ∧
          (a.quantity = l.quantity → a.basis.toRat = l.totalBasis.toRat)) := by
  obtain ⟨policy, ordered, available, oq, rate, hpol, -, hpw, hcoh, ho, hawf, havsum, -, hoqwf,
    hoqval, hpqwf, hpqval, -, hal, hsum, -, -⟩ := calculateInventoryCost_costed_context hp hr h
  obtain ⟨-, hoq0, hoqle⟩ := costed_bounds hcoh ho havsum hoqval
  by_cases hm : policy.method = .weightedAverage
  · rw [hm] at ho hal
    obtain ⟨tb, -, -, -, -, hwf, -, -⟩ := costAllocations_average hr.layers hcoh.layerIds ho hawf
      havsum hoqwf hoq0 hoqle hal
    obtain ⟨-, hobr⟩ := accountingSum_ok (fun v hv => by
      obtain ⟨a, ha, rfl⟩ := List.mem_map.mp hv
      exact (hwf a ha).2) hsum
    refine ⟨by rw [hobr, List.map_map]; rfl, policy, hpol, fun hne => absurd hm hne⟩
  · obtain ⟨hg, -⟩ := costAllocations_greedy hm hr.layers (fun l hl => (hcoh.layers l hl).1) ho
      havsum hoqwf hoq0 hoqle hal
    obtain ⟨-, hobr⟩ := accountingSum_ok (fun v hv => by
      obtain ⟨a, ha, rfl⟩ := List.mem_map.mp hv
      obtain ⟨l, -, hl⟩ := greedy_taken ordered allocs hg a ha
      exact hl.basis_wf) hsum
    refine ⟨by rw [hobr, List.map_map]; rfl, policy, hpol, fun _ a ha => ?_⟩
    obtain ⟨l, hl, ht⟩ := greedy_taken ordered allocs hg a ha
    have hlm := costOrder_mem ho l hl
    exact ⟨l, hlm, ht.layerId, ht.quantity_pos, ht.quantity_le, ht.basis,
      takenFrom_whole (hcoh.layers l hlm).1 ht⟩

/-- The allocations of a costed result, and their total, are constructible. -/
theorem calculateInventoryCost_wf {policies : List AccountingPolicy} {bookId : BookId}
    {request : InventoryCostRequest} {allocs : List InventoryAllocationResult}
    {ob pq pb : ExactRational} (hp : ∀ p ∈ policies, p.WF) (hr : request.WF)
    (h : calculateInventoryCost policies bookId request = .ok (.costed allocs ob pq pb)) :
    (∀ a ∈ allocs, a.quantity.WF ∧ a.basis.WF) ∧ ob.WF ∧ pq.WF ∧ pb.WF := by
  obtain ⟨policy, ordered, available, oq, rate, hpol, -, hpw, hcoh, ho, hawf, havsum, -, hoqwf,
    hoqval, hpqwf, hpqval, -, hal, hsum, hrt, hm, -⟩ := calculateInventoryCost_costed_context hp hr h
  obtain ⟨-, hoq0, hoqle⟩ := costed_bounds hcoh ho havsum hoqval
  have hallwf : ∀ a ∈ allocs, a.quantity.WF ∧ a.basis.WF := by
    by_cases hmeth : policy.method = .weightedAverage
    · rw [hmeth] at ho hal
      obtain ⟨-, -, -, -, -, hwf, -, -⟩ := costAllocations_average hr.layers hcoh.layerIds ho hawf
        havsum hoqwf hoq0 hoqle hal
      exact hwf
    · obtain ⟨hg, -⟩ := costAllocations_greedy hmeth hr.layers
        (fun l hl => (hcoh.layers l hl).1) ho havsum hoqwf hoq0 hoqle hal
      intro a ha
      obtain ⟨l, -, hl⟩ := greedy_taken ordered allocs hg a ha
      exact ⟨hl.quantity_wf, hl.basis_wf⟩
  obtain ⟨hobwf, -⟩ := accountingSum_ok (fun v hv => by
    obtain ⟨a, ha, rfl⟩ := List.mem_map.mp hv
    exact (hallwf a ha).2) hsum
  obtain ⟨hratewf, -⟩ := provisionalRateOf_spec hpw hr.layers hcoh.layerIds hoqwf hobwf hrt
  exact ⟨hallwf, hobwf, hpqwf, (ExactRational.multiply_ok hpqwf hratewf hm).1⟩

/-- What a shortage adds to the cost: nothing when nothing is short; otherwise the quantity short
times a rate above zero, which the method fixes. The standard cost and the explicit rate are the
policy's rate; the moving average is the average cost of what was taken from the layers; the last
receipt cost is the unit cost of the most recent layer, which every other layer follows in the order
of last in first out. -/
theorem calculateInventoryCost_provisionalBasis {policies : List AccountingPolicy}
    {bookId : BookId} {request : InventoryCostRequest} {allocs : List InventoryAllocationResult}
    {ob pq pb : ExactRational} (hp : ∀ p ∈ policies, p.WF) (hr : request.WF)
    (h : calculateInventoryCost policies bookId request = .ok (.costed allocs ob pq pb)) :
    ∃ policy : InventoryCostPolicy,
      policyAt InventoryCostPolicy policies request.policyId request.policyVersion
        request.governedAt = .selected policy ∧
      (pq.toRat = 0 → pb.toRat = 0) ∧
      (pq.toRat ≠ 0 → ∃ rate : ℚ, 0 < rate ∧ pb.toRat = pq.toRat * rate ∧
        ((∃ r : ExactRational, policy.provisionalRate = some r ∧ r.toRat = rate ∧
            (policy.provisionalBasisMethod = some .standardCost ∨
              policy.provisionalBasisMethod = some .explicitRate)) ∨
          (policy.provisionalBasisMethod = some .movingAverage ∧
            request.quantity.toRat - pq.toRat ≠ 0 ∧
            rate = ob.toRat / (request.quantity.toRat - pq.toRat)) ∨
          (policy.provisionalBasisMethod = some .lastReceiptCost ∧
            ∃ last ∈ request.layers, (∀ other ∈ request.layers, other ≠ last →
              lifoBefore last other) ∧ rate = last.totalBasis.toRat / last.quantity.toRat))) := by
  obtain ⟨hallwf, hobwf, hpqwf, hpbwf⟩ := calculateInventoryCost_wf hp hr h
  obtain ⟨policy, ordered, available, oq, rate, hpol, -, hpw, hcoh, ho, hawf, havsum, -, hoqwf,
    hoqval, -, hpqval, hshort, hal, hsum, hrt, hm, hrr⟩ :=
    calculateInventoryCost_costed_context hp hr h
  obtain ⟨hratewf, hspec⟩ := provisionalRateOf_spec hpw hr.layers hcoh.layerIds hoqwf hobwf hrt
  obtain ⟨hmulwf, hmulval⟩ := ExactRational.multiply_ok hpqwf hratewf hm
  refine ⟨policy, hpol, fun hz => ?_, fun hne => ?_⟩
  · rw [hmulval, hz]; ring
  · have hpz : pq.isZero = false := by
      by_contra hc
      exact hne ((ExactRational.isZero_iff hpqwf).mp (Bool.not_eq_false _ |>.mp hc))
    have hpos : 0 < rate.toRat := by
      simp only [rateRejected, Bool.or_eq_false_iff, hpz, Bool.not_false, Bool.true_and] at hrr
      have hnn : ¬ rate.toRat < 0 := fun hl => by
        have := (ExactRational.isNegative_iff hratewf).mpr hl
        rw [hrr.1] at this; cases this
      have hnz : rate.toRat ≠ 0 := fun h0 => by
        have := (ExactRational.isZero_iff hratewf).mpr h0
        rw [hrr.2] at this; cases this
      exact lt_of_le_of_ne (not_lt.mp hnn) (Ne.symm hnz)
    refine ⟨rate.toRat, hpos, hmulval, ?_⟩
    rcases hspec with ⟨hz, -⟩ | ⟨-, hmeth, hpr⟩ | ⟨-, hmeth, hoz, hrv⟩ | ⟨-, hmeth, last, hl, hlo, hrv⟩
    · rw [hpz] at hz; cases hz
    · exact Or.inl ⟨rate, hpr, rfl, hmeth⟩
    · have hoq' : request.quantity.toRat - pq.toRat = oq.toRat := by rw [hpqval]; ring
      have hne' : oq.toRat ≠ 0 := fun h0 => by
        have := (ExactRational.isZero_iff hoqwf).mpr h0
        rw [hoz] at this; cases this
      refine Or.inr (Or.inl ⟨hmeth, by rw [hoq']; exact hne', by rw [hoq']; exact hrv⟩)
    · have hmeth' : policy.provisionalBasisMethod = some .lastReceiptCost := by
        rcases hmeth with h0 | h0
        · rcases hshort with hz | ⟨-, hne0⟩
          · rw [hpz] at hz; cases hz
          · exact absurd h0 hne0
        · exact h0
      exact Or.inr (Or.inr ⟨hmeth', last, hl, hlo, hrv⟩)

/-! ## Every way `calculateInventoryCost` rejects -/

/-- Only specific identification can fail to order its layers. -/
theorem costOrder_none_iff {method : InventoryCostMethod} {request : InventoryCostRequest} :
    costOrder method request = .ok none ↔ method = .specificIdentification ∧
      specificRejected request.layers (request.specificLayerIds.getD []) = true := by
  cases method with
  | specificIdentification =>
    simp only [costOrder]
    by_cases hr : specificRejected request.layers (request.specificLayerIds.getD []) = true
    · simp [hr]
    · simp [hr]
  | weightedAverage => simp [costOrder]
  | fifo =>
    simp only [costOrder]
    cases Lots.stableSort (costCompare .fifo) request.layers <;> simp
  | lifo =>
    simp only [costOrder]
    cases Lots.stableSort (costCompare .lifo) request.layers <;> simp
  | hifo =>
    simp only [costOrder]
    cases Lots.stableSort (costCompare .hifo) request.layers <;> simp

/-- Every way the request is rejected, with its diagnostic: the policy is not selected; the request is
incoherent; a specific selection repeats a layer or names none; a shortage is not authorized; the rate
of a shortage cannot be resolved. Each holds exactly when every earlier step returned and passed. -/
theorem calculateInventoryCost_rejected_iff {policies : List AccountingPolicy} {bookId : BookId}
    {request : InventoryCostRequest} {ds : List SemanticDiagnostic} :
    calculateInventoryCost policies bookId request = .ok (.rejected ds) ↔
      (policyAt InventoryCostPolicy policies request.policyId request.policyVersion
          request.governedAt = .rejected ds) ∨
      (∃ policy : InventoryCostPolicy,
        policyAt InventoryCostPolicy policies request.policyId request.policyVersion
          request.governedAt = .selected policy ∧
        costIncoherent policy bookId request = true ∧ ds = [incoherentDiagnostic]) ∨
      (∃ policy : InventoryCostPolicy,
        policyAt InventoryCostPolicy policies request.policyId request.policyVersion
          request.governedAt = .selected policy ∧
        costIncoherent policy bookId request = false ∧ costOrder policy.method request = .ok none ∧
        ds = [specificDiagnostic]) ∨
      (∃ (policy : InventoryCostPolicy) (ordered : List InventoryLayerInput)
          (available pq : ExactRational),
        policyAt InventoryCostPolicy policies request.policyId request.policyVersion
          request.governedAt = .selected policy ∧
        costIncoherent policy bookId request = false ∧
        costOrder policy.method request = .ok (some ordered) ∧
        costAvailable policy.method ordered request = .ok available ∧
        request.quantity.subtract (ordinaryQuantityOf request.quantity available) = .ok pq ∧
        (!pq.isZero &&
          (policy.shortageTreatment == .reject || policy.provisionalBasisMethod.isNone)) = true ∧
        ds = [shortageDiagnostic]) ∨
      (∃ (policy : InventoryCostPolicy) (ordered : List InventoryLayerInput)
          (available pq ob : ExactRational) (allocs : List InventoryAllocationResult)
          (rate : Option ExactRational),
        policyAt InventoryCostPolicy policies request.policyId request.policyVersion
          request.governedAt = .selected policy ∧
        costIncoherent policy bookId request = false ∧
        costOrder policy.method request = .ok (some ordered) ∧
        costAvailable policy.method ordered request = .ok available ∧
        request.quantity.subtract (ordinaryQuantityOf request.quantity available) = .ok pq ∧
        (!pq.isZero &&
          (policy.shortageTreatment == .reject || policy.provisionalBasisMethod.isNone)) = false ∧
        costAllocations policy.method request ordered available
          (ordinaryQuantityOf request.quantity available) = .ok allocs ∧
        accountingSum (allocs.map (·.basis)) = .ok ob ∧
        provisionalRateOf policy request pq (ordinaryQuantityOf request.quantity available) ob =
          .ok rate ∧
        rateRejected pq rate = true ∧ ds = [rateDiagnostic]) := by
  constructor
  · intro h
    unfold calculateInventoryCost at h
    cases hp : policyAt InventoryCostPolicy policies request.policyId request.policyVersion
        request.governedAt with
    | rejected ds' =>
      simp only [hp, Except.ok.injEq, InventoryCostCalculation.rejected.injEq] at h
      subst h
      exact Or.inl rfl
    | selected policy =>
      simp only [hp] at h
      by_cases hinc : costIncoherent policy bookId request = true
      · simp only [hinc, ↓reduceIte, Except.ok.injEq, InventoryCostCalculation.rejected.injEq] at h
        subst h
        exact Or.inr (Or.inl ⟨policy, rfl, hinc, rfl⟩)
      · have hinc' : costIncoherent policy bookId request = false := Bool.eq_false_iff.mpr hinc
        simp only [hinc', Bool.false_eq_true, ↓reduceIte] at h
        cases ho : costOrder policy.method request with
        | error e => simp [ho] at h
        | ok o =>
          cases o with
          | none =>
            simp only [ho, Except.ok.injEq, InventoryCostCalculation.rejected.injEq] at h
            subst h
            exact Or.inr (Or.inr (Or.inl ⟨policy, rfl, hinc', ho, rfl⟩))
          | some ordered =>
            simp only [ho] at h
            cases ha : costAvailable policy.method ordered request with
            | error e => simp [ha] at h
            | ok available =>
              simp only [ha] at h
              cases hs : request.quantity.subtract
                  (ordinaryQuantityOf request.quantity available) with
              | error e => simp [hs] at h
              | ok pq =>
                simp only [hs] at h
                by_cases hsh : (!pq.isZero &&
                    (policy.shortageTreatment == .reject ||
                      policy.provisionalBasisMethod.isNone)) = true
                · simp only [hsh, ↓reduceIte, Except.ok.injEq,
                    InventoryCostCalculation.rejected.injEq] at h
                  subst h
                  exact Or.inr (Or.inr (Or.inr (Or.inl ⟨policy, ordered, available, pq, rfl, hinc',
                    ho, ha, hs, hsh, rfl⟩)))
                · have hsh' : (!pq.isZero &&
                      (policy.shortageTreatment == .reject ||
                        policy.provisionalBasisMethod.isNone)) = false :=
                    Bool.eq_false_iff.mpr hsh
                  simp only [hsh', Bool.false_eq_true, ↓reduceIte] at h
                  cases hal : costAllocations policy.method request ordered available
                      (ordinaryQuantityOf request.quantity available) with
                  | error e => simp [hal] at h
                  | ok allocs =>
                    simp only [hal] at h
                    cases hsum : accountingSum (allocs.map (·.basis)) with
                    | error e => simp [hsum] at h
                    | ok ob =>
                      simp only [hsum] at h
                      cases hr : provisionalRateOf policy request pq
                          (ordinaryQuantityOf request.quantity available) ob with
                      | error e => simp [hr] at h
                      | ok rate =>
                        simp only [hr] at h
                        by_cases hrr : rateRejected pq rate = true
                        · simp only [hrr, ↓reduceIte, Except.ok.injEq,
                            InventoryCostCalculation.rejected.injEq] at h
                          subst h
                          exact Or.inr (Or.inr (Or.inr (Or.inr ⟨policy, ordered, available, pq, ob,
                            allocs, rate, rfl, hinc', ho, ha, hs, hsh', hal, hsum, hr, hrr, rfl⟩)))
                        · have hrr' : rateRejected pq rate = false := Bool.eq_false_iff.mpr hrr
                          simp only [hrr', Bool.false_eq_true, ↓reduceIte] at h
                          cases rate with
                          | none => simp [rateRejected] at hrr'
                          | some r =>
                            simp only [Option.getD_some] at h
                            cases hm : pq.multiply r with
                            | error e => simp [hm] at h
                            | ok pb => simp [hm] at h
  · rintro (h | ⟨policy, hp, hinc, rfl⟩ | ⟨policy, hp, hinc, ho, rfl⟩ |
      ⟨policy, ordered, available, pq, hp, hinc, ho, ha, hs, hsh, rfl⟩ |
      ⟨policy, ordered, available, pq, ob, allocs, rate, hp, hinc, ho, ha, hs, hsh, hal, hsum, hr,
        hrr, rfl⟩)
    · simp [calculateInventoryCost, h]
    · simp [calculateInventoryCost, hp, hinc]
    · simp [calculateInventoryCost, hp, hinc, ho]
    · simp [calculateInventoryCost, hp, hinc, ho, ha, hs, hsh]
    · simp [calculateInventoryCost, hp, hinc, ho, ha, hs, hsh, hal, hsum, hr, hrr]

/-- The five diagnostics of `calculateInventoryCost` differ. -/
theorem costDiagnostics_ne :
    policyAtDiagnostic .inventoryCost ≠ incoherentDiagnostic ∧
    policyAtDiagnostic .inventoryCost ≠ specificDiagnostic ∧
    policyAtDiagnostic .inventoryCost ≠ shortageDiagnostic ∧
    policyAtDiagnostic .inventoryCost ≠ rateDiagnostic ∧
    incoherentDiagnostic ≠ specificDiagnostic ∧ incoherentDiagnostic ≠ shortageDiagnostic ∧
    incoherentDiagnostic ≠ rateDiagnostic ∧ specificDiagnostic ≠ shortageDiagnostic ∧
    specificDiagnostic ≠ rateDiagnostic ∧ shortageDiagnostic ≠ rateDiagnostic := by
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;> decide

/-- A request is rejected as incoherent exactly when the policy governing it is selected and one of the
conditions of incoherence holds. -/
theorem calculateInventoryCost_incoherent_iff {policies : List AccountingPolicy} {bookId : BookId}
    {request : InventoryCostRequest} (hp : ∀ p ∈ policies, p.WF) (hr : request.WF) :
    calculateInventoryCost policies bookId request = .ok (.rejected [incoherentDiagnostic]) ↔
      ∃ policy : InventoryCostPolicy,
        policyAt InventoryCostPolicy policies request.policyId request.policyVersion
          request.governedAt = .selected policy ∧ CostIncoherent policy bookId request := by
  obtain ⟨n12, n13, n14, n15, n23, n24, n25, n34, n35, n45⟩ := costDiagnostics_ne
  rw [calculateInventoryCost_rejected_iff]
  constructor
  · rintro (h | ⟨policy, hpol, hinc, -⟩ | ⟨policy, hpol, hinc, ho, hds⟩ |
      ⟨policy, ordered, available, pq, hpol, hinc, ho, ha, hs, hsh, hds⟩ |
      ⟨policy, ordered, available, pq, ob, allocs, rate, hpol, hinc, ho, ha, hs, hsh, hal, hsum,
        hrt, hrr, hds⟩)
    · exact absurd (List.singleton_inj.mp ((policyAt_rejected_eq h).symm)) n12
    · have hpw : policy.WF := hp _ (policyAt_inventoryCost_mem hpol)
      exact ⟨policy, hpol, (costIncoherent_iff hr (fun r hr' => hpw.provisionalRate r hr')).mp hinc⟩
    · exact absurd (List.singleton_inj.mp hds) n23
    · exact absurd (List.singleton_inj.mp hds) n24
    · exact absurd (List.singleton_inj.mp hds) n25
  · rintro ⟨policy, hpol, hc⟩
    have hpw : policy.WF := hp _ (policyAt_inventoryCost_mem hpol)
    exact Or.inr (Or.inl ⟨policy, hpol,
      (costIncoherent_iff hr (fun r hr' => hpw.provisionalRate r hr')).mpr hc, rfl⟩)

/-- A selection finds a layer for every name exactly when it is as long as the names. -/
theorem specificOrdered_length_eq_iff (layers : List InventoryLayerInput) :
    ∀ ids : List String, (specificOrdered layers ids).length = ids.length ↔
      ∀ id ∈ ids, ∃ l ∈ layers, l.id = id
  | [] => by simp [specificOrdered]
  | id :: rest => by
    constructor
    · intro hlen id' hid'
      obtain ⟨hmap, hmem⟩ := specificOrdered_spec layers (id :: rest) hlen
      rw [← hmap] at hid'
      obtain ⟨l, hl, rfl⟩ := List.mem_map.mp hid'
      exact ⟨l, hmem l hl, rfl⟩
    · intro hall
      obtain ⟨l0, hl0, hid0⟩ := hall id List.mem_cons_self
      have hsome : (layers.find? fun layer => layer.id == id).isSome = true := by
        rw [List.find?_isSome]
        exact ⟨l0, hl0, by simp [hid0]⟩
      obtain ⟨l, hl⟩ := Option.isSome_iff_exists.mp hsome
      have ih := (specificOrdered_length_eq_iff layers rest).mpr
        (fun x hx => hall x (List.mem_cons_of_mem _ hx))
      simp only [specificOrdered, List.filterMap_cons, hl, List.length_cons] at ih ⊢
      omega

/-- A specific selection is rejected exactly when it names a layer twice or names none. -/
theorem specificRejected_iff (layers : List InventoryLayerInput) (ids : List String) :
    specificRejected layers ids = true ↔ ¬ ids.Nodup ∨ ∃ id ∈ ids, ∀ l ∈ layers, l.id ≠ id := by
  unfold specificRejected
  rw [Bool.or_eq_true, bne_iff_ne, bne_iff_ne, ne_eq, ne_eq, Lots.setSize_eq_length_iff,
    specificOrdered_length_eq_iff]
  refine or_congr Iff.rfl ?_
  constructor
  · intro h
    by_contra hno
    exact h (fun id hid => by
      by_contra hn
      exact hno ⟨id, hid, fun l hl hl' => hn ⟨l, hl, hl'⟩⟩)
  · rintro ⟨id, hid, hno⟩ hall
    obtain ⟨l, hl, hl'⟩ := hall id hid
    exact hno l hl hl'

/-- A specific selection is rejected exactly when the policy selects layers by identification, the
request is coherent, and the selection names a layer twice or names none. -/
theorem calculateInventoryCost_specific_iff {policies : List AccountingPolicy} {bookId : BookId}
    {request : InventoryCostRequest} (hp : ∀ p ∈ policies, p.WF) (hr : request.WF) :
    calculateInventoryCost policies bookId request = .ok (.rejected [specificDiagnostic]) ↔
      ∃ policy : InventoryCostPolicy,
        policyAt InventoryCostPolicy policies request.policyId request.policyVersion
          request.governedAt = .selected policy ∧ ¬ CostIncoherent policy bookId request ∧
        policy.method = .specificIdentification ∧
        (¬ (request.specificLayerIds.getD []).Nodup ∨
          ∃ id ∈ request.specificLayerIds.getD [], ∀ l ∈ request.layers, l.id ≠ id) := by
  obtain ⟨n12, n13, n14, n15, n23, n24, n25, n34, n35, n45⟩ := costDiagnostics_ne
  rw [calculateInventoryCost_rejected_iff]
  constructor
  · rintro (h | ⟨policy, hpol, hinc, hds⟩ | ⟨policy, hpol, hinc, ho, -⟩ |
      ⟨policy, ordered, available, pq, hpol, hinc, ho, ha, hs, hsh, hds⟩ |
      ⟨policy, ordered, available, pq, ob, allocs, rate, hpol, hinc, ho, ha, hs, hsh, hal, hsum,
        hrt, hrr, hds⟩)
    · exact absurd (List.singleton_inj.mp ((policyAt_rejected_eq h).symm)) n13
    · exact absurd (List.singleton_inj.mp hds).symm n23
    · have hpw : policy.WF := hp _ (policyAt_inventoryCost_mem hpol)
      obtain ⟨hm, hrej⟩ := costOrder_none_iff.mp ho
      refine ⟨policy, hpol, fun hc => ?_, hm, (specificRejected_iff _ _).mp hrej⟩
      have := (costIncoherent_iff hr (fun r hr' => hpw.provisionalRate r hr')).mpr hc
      rw [hinc] at this
      cases this
    · exact absurd (List.singleton_inj.mp hds) n34
    · exact absurd (List.singleton_inj.mp hds) n35
  · rintro ⟨policy, hpol, hnc, hm, hrej⟩
    have hpw : policy.WF := hp _ (policyAt_inventoryCost_mem hpol)
    have hinc : costIncoherent policy bookId request = false := by
      by_contra hc
      exact hnc ((costIncoherent_iff hr (fun r hr' => hpw.provisionalRate r hr')).mp
        (Bool.eq_true_of_not_eq_false hc))
    exact Or.inr (Or.inr (Or.inl ⟨policy, hpol, hinc,
      costOrder_none_iff.mpr ⟨hm, (specificRejected_iff _ _).mpr hrej⟩, rfl⟩))

/-- The test that refuses a shortage, for constructible quantities: something is short, and the policy
rejects shortages or names no method to price one. -/
theorem shortageRefused_iff {pq : ExactRational} {policy : InventoryCostPolicy} (hpq : pq.WF) :
    (!pq.isZero && (policy.shortageTreatment == .reject || policy.provisionalBasisMethod.isNone)) =
        true ↔
      pq.toRat ≠ 0 ∧ (policy.shortageTreatment = .reject ∨ policy.provisionalBasisMethod = none) := by
  simp only [Bool.and_eq_true, Bool.not_eq_true', Bool.or_eq_true, beq_iff_eq,
    Option.isNone_iff_eq_none]
  have h0 : pq.isZero = false ↔ pq.toRat ≠ 0 := by
    rw [Bool.eq_false_iff, ne_eq, ne_eq, ExactRational.isZero_iff hpq]
  exact and_congr h0 Iff.rfl

/-- A shortage is refused exactly when the request is coherent, something is short, and the policy
rejects shortages or names no method to price one. -/
theorem calculateInventoryCost_shortage_iff {policies : List AccountingPolicy} {bookId : BookId}
    {request : InventoryCostRequest} (hp : ∀ p ∈ policies, p.WF) (hr : request.WF) :
    calculateInventoryCost policies bookId request = .ok (.rejected [shortageDiagnostic]) ↔
      ∃ (policy : InventoryCostPolicy) (ordered : List InventoryLayerInput)
          (available pq : ExactRational),
        policyAt InventoryCostPolicy policies request.policyId request.policyVersion
          request.governedAt = .selected policy ∧ ¬ CostIncoherent policy bookId request ∧
        costOrder policy.method request = .ok (some ordered) ∧
        costAvailable policy.method ordered request = .ok available ∧
        request.quantity.subtract (ordinaryQuantityOf request.quantity available) = .ok pq ∧
        pq.toRat ≠ 0 ∧ (policy.shortageTreatment = .reject ∨ policy.provisionalBasisMethod = none) := by
  obtain ⟨n12, n13, n14, n15, n23, n24, n25, n34, n35, n45⟩ := costDiagnostics_ne
  rw [calculateInventoryCost_rejected_iff]
  have hwf : ∀ {policy : InventoryCostPolicy} {ordered : List InventoryLayerInput}
      {available pq : ExactRational}, costOrder policy.method request = .ok (some ordered) →
      costAvailable policy.method ordered request = .ok available →
      request.quantity.subtract (ordinaryQuantityOf request.quantity available) = .ok pq →
      pq.WF := by
    intro policy ordered available pq ho ha hs
    obtain ⟨hawf, -⟩ := costAvailable_spec hr.layers ho ha
    exact (ExactRational.subtract_ok hr.quantity (ordinaryQuantityOf_spec hr.quantity hawf).1 hs).1
  constructor
  · rintro (h | ⟨policy, hpol, hinc, hds⟩ | ⟨policy, hpol, hinc, ho, hds⟩ |
      ⟨policy, ordered, available, pq, hpol, hinc, ho, ha, hs, hsh, -⟩ |
      ⟨policy, ordered, available, pq, ob, allocs, rate, hpol, hinc, ho, ha, hs, hsh, hal, hsum,
        hrt, hrr, hds⟩)
    · exact absurd (List.singleton_inj.mp ((policyAt_rejected_eq h).symm)) n14.symm.symm
    · exact absurd (List.singleton_inj.mp hds) n24.symm
    · exact absurd (List.singleton_inj.mp hds) n34.symm
    · have hpw : policy.WF := hp _ (policyAt_inventoryCost_mem hpol)
      refine ⟨policy, ordered, available, pq, hpol, fun hc => ?_, ho, ha, hs,
        (shortageRefused_iff (hwf ho ha hs)).mp hsh⟩
      have := (costIncoherent_iff hr (fun r hr' => hpw.provisionalRate r hr')).mpr hc
      rw [hinc] at this; cases this
    · exact absurd (List.singleton_inj.mp hds) n45
  · rintro ⟨policy, ordered, available, pq, hpol, hnc, ho, ha, hs, hne, hrej⟩
    have hpw : policy.WF := hp _ (policyAt_inventoryCost_mem hpol)
    have hinc : costIncoherent policy bookId request = false := by
      by_contra hc
      exact hnc ((costIncoherent_iff hr (fun r hr' => hpw.provisionalRate r hr')).mp
        (Bool.eq_true_of_not_eq_false hc))
    exact Or.inr (Or.inr (Or.inr (Or.inl ⟨policy, ordered, available, pq, hpol, hinc, ho, ha, hs,
      (shortageRefused_iff (hwf ho ha hs)).mpr ⟨hne, hrej⟩, rfl⟩)))

/-! ## What the exact operations of `calculateInventoryCost` can throw -/

/-- A placement that throws does so in a comparison of the placed element with one in the list. -/
theorem insertSorted_error {α ε : Type} {cmp : α → α → Except ε Ordering} {item : α} {e : ε} :
    ∀ {sorted : List α}, Lots.insertSorted cmp item sorted = .error e →
      ∃ y ∈ sorted, cmp item y = .error e
  | [], h => by simp [Lots.insertSorted] at h
  | next :: rest, h => by
    rw [Lots.insertSorted] at h
    cases hc : cmp item next with
    | error e' =>
      simp only [hc, Except.error.injEq] at h
      subst h
      exact ⟨next, List.mem_cons_self, hc⟩
    | ok o =>
      cases o with
      | gt =>
        simp only [hc] at h
        cases hp : Lots.insertSorted cmp item rest with
        | error e' =>
          simp only [hp, Except.error.injEq] at h
          subst h
          obtain ⟨y, hy, hcy⟩ := insertSorted_error hp
          exact ⟨y, List.mem_cons_of_mem _ hy, hcy⟩
        | ok placed => simp [hp] at h
      | lt => simp [hc] at h
      | eq => simp [hc] at h

/-- A stable sort that throws does so in a comparison of two of its elements. -/
theorem stableSort_error {α ε : Type} {cmp : α → α → Except ε Ordering} {e : ε} :
    ∀ {list : List α}, Lots.stableSort cmp list = .error e →
      ∃ x ∈ list, ∃ y ∈ list, cmp x y = .error e
  | [], h => by simp [Lots.stableSort] at h
  | item :: rest, h => by
    rw [Lots.stableSort] at h
    cases hs : Lots.stableSort cmp rest with
    | error e' =>
      simp only [hs, Except.error.injEq] at h
      subst h
      obtain ⟨x, hx, y, hy, hxy⟩ := stableSort_error hs
      exact ⟨x, List.mem_cons_of_mem _ hx, y, List.mem_cons_of_mem _ hy, hxy⟩
    | ok sorted =>
      simp only [hs] at h
      obtain ⟨y, hy, hxy⟩ := insertSorted_error h
      exact ⟨item, List.mem_cons_self, y,
        List.mem_cons_of_mem _ ((Lots.stableSort_perm cmp rest sorted hs).mem_iff.mp hy), hxy⟩

/-- The comparators throw only for size, for layers of constructible values and a quantity that is not
zero: only the highest-cost comparator can throw, in a division. -/
theorem costCompare_error {method : InventoryCostMethod} {x y : InventoryLayerInput} {e : NumErr}
    (hx : x.WF) (hy : y.WF) (hxq : x.quantity.toRat ≠ 0) (hyq : y.quantity.toRat ≠ 0)
    (h : costCompare method x y = .error e) : e = .representationLimitExceeded := by
  cases method with
  | hifo =>
    simp only [costCompare] at h
    cases hl : y.totalBasis.divide y.quantity with
    | error e' =>
      simp only [hl, Except.error.injEq] at h
      subst h
      exact divide_error hy.totalBasis hy.quantity hyq hl
    | ok bUnit =>
      simp only [hl] at h
      cases hr : x.totalBasis.divide x.quantity with
      | error e' =>
        simp only [hr, Except.error.injEq] at h
        subst h
        exact divide_error hx.totalBasis hx.quantity hxq hr
      | ok aUnit => simp [hr] at h
  | _ => simp [costCompare] at h

/-- Ordering the layers throws only for size, for layers of constructible values and a quantity that is
not zero. -/
theorem costOrder_error {method : InventoryCostMethod} {request : InventoryCostRequest}
    {e : NumErr} (hw : ∀ l ∈ request.layers, l.WF)
    (hpos : ∀ l ∈ request.layers, l.quantity.toRat ≠ 0)
    (h : costOrder method request = .error e) : e = .representationLimitExceeded := by
  cases method with
  | specificIdentification =>
    simp only [costOrder] at h
    by_cases hr : specificRejected request.layers (request.specificLayerIds.getD []) = true <;>
      simp [hr] at h
  | weightedAverage => simp [costOrder] at h
  | fifo =>
    simp only [costOrder] at h
    cases hs : Lots.stableSort (costCompare .fifo) request.layers with
    | error e' =>
      simp only [hs, Except.error.injEq] at h
      subst h
      obtain ⟨x, hx, y, hy, hxy⟩ := stableSort_error hs
      exact costCompare_error (hw x hx) (hw y hy) (hpos x hx) (hpos y hy) hxy
    | ok sorted => simp [hs] at h
  | lifo =>
    simp only [costOrder] at h
    cases hs : Lots.stableSort (costCompare .lifo) request.layers with
    | error e' =>
      simp only [hs, Except.error.injEq] at h
      subst h
      obtain ⟨x, hx, y, hy, hxy⟩ := stableSort_error hs
      exact costCompare_error (hw x hx) (hw y hy) (hpos x hx) (hpos y hy) hxy
    | ok sorted => simp [hs] at h
  | hifo =>
    simp only [costOrder] at h
    cases hs : Lots.stableSort (costCompare .hifo) request.layers with
    | error e' =>
      simp only [hs, Except.error.injEq] at h
      subst h
      obtain ⟨x, hx, y, hy, hxy⟩ := stableSort_error hs
      exact costCompare_error (hw x hx) (hw y hy) (hpos x hx) (hpos y hy) hxy
    | ok sorted => simp [hs] at h

/-- Resolving the rate of a shortage throws only for size, for constructible layers and totals. -/
theorem provisionalRateOf_error {policy : InventoryCostPolicy} {request : InventoryCostRequest}
    {pq oq ob : ExactRational} {e : NumErr} (hw : ∀ l ∈ request.layers, l.WF)
    (hnd : (request.layers.map (·.id)).Nodup) (hpos : ∀ l ∈ request.layers, l.quantity.toRat ≠ 0)
    (hoq : oq.WF) (hob : ob.WF) (h : provisionalRateOf policy request pq oq ob = .error e) :
    e = .representationLimitExceeded := by
  unfold provisionalRateOf at h
  by_cases hz : pq.isZero = true
  · simp [hz] at h
  · have hz' : pq.isZero = false := Bool.eq_false_iff.mpr hz
    simp only [hz', Bool.false_eq_true, ↓reduceIte] at h
    have hlast : ∀ last, lastReceipt request.layers = some last →
        ∀ e', last.totalBasis.divide last.quantity = .error e' → e' = .representationLimitExceeded :=
      fun last hl e' hd => by
        obtain ⟨hlm, -⟩ := lastReceipt_spec hnd hl
        exact divide_error (hw last hlm).totalBasis (hw last hlm).quantity (hpos last hlm) hd
    cases hm : policy.provisionalBasisMethod with
    | none =>
      simp only [hm] at h
      cases hl : lastReceipt request.layers with
      | none => simp [hl] at h
      | some last =>
        simp only [hl] at h
        cases hd : last.totalBasis.divide last.quantity with
        | error e' =>
          simp only [hd, Except.error.injEq] at h
          subst h
          exact hlast last hl _ hd
        | ok r => simp [hd] at h
    | some m =>
      cases m with
      | standardCost => simp [hm] at h
      | explicitRate => simp [hm] at h
      | movingAverage =>
        simp only [hm] at h
        by_cases ho : oq.isZero = true
        · simp [ho] at h
        · have ho' : oq.isZero = false := Bool.eq_false_iff.mpr ho
          simp only [ho', Bool.false_eq_true, ↓reduceIte] at h
          cases hd : ob.divide oq with
          | error e' =>
            simp only [hd, Except.error.injEq] at h
            subst h
            exact divide_error hob hoq (fun h0 => ho ((ExactRational.isZero_iff hoq).mpr h0)) hd
          | ok r => simp [hd] at h
      | lastReceiptCost =>
        simp only [hm] at h
        cases hl : lastReceipt request.layers with
        | none => simp [hl] at h
        | some last =>
          simp only [hl] at h
          cases hd : last.totalBasis.divide last.quantity with
          | error e' =>
            simp only [hd, Except.error.injEq] at h
            subst h
            exact hlast last hl _ hd
          | ok r => simp [hd] at h

/-- Making the allocations throws only for size: the weighted average sums the total basis of every
layer, and divides by a quantity held that is not zero when something is taken; the other methods take
layers of positive quantity. -/
theorem costAllocations_error {method : InventoryCostMethod} {request : InventoryCostRequest}
    {ordered : List InventoryLayerInput} {available oq : ExactRational} {e : NumErr}
    (hw : ∀ l ∈ request.layers, l.WF) (hpos : ∀ l ∈ request.layers, 0 < l.quantity.toRat)
    (ho : costOrder method request = .ok (some ordered)) (hav : available.WF) (hoq : oq.WF)
    (hoq0 : 0 ≤ oq.toRat) (hoqle : oq.toRat ≤ available.toRat)
    (h : costAllocations method request ordered available oq = .error e) :
    e = .representationLimitExceeded := by
  unfold costAllocations at h
  by_cases hm : method = .weightedAverage
  · simp only [hm, ↓reduceIte] at h
    cases hs : accountingSum (request.layers.map (·.totalBasis)) with
    | error e' =>
      simp only [hs, Except.error.injEq] at h
      subst h
      exact accountingSum_error (fun v hv => by
        obtain ⟨l, hl, rfl⟩ := List.mem_map.mp hv
        exact (hw l hl).totalBasis) hs
    | ok totalBasis =>
      simp only [hs] at h
      obtain ⟨htw, -⟩ := accountingSum_ok (fun v hv => by
        obtain ⟨l, hl, rfl⟩ := List.mem_map.mp hv
        exact (hw l hl).totalBasis) hs
      by_cases hz : oq.isZero = true
      · simp [hz] at h
      · have hz' : oq.isZero = false := Bool.eq_false_iff.mpr hz
        simp only [hz', Bool.false_eq_true, ↓reduceIte] at h
        have h0 : oq.toRat ≠ 0 := fun h0 => hz ((ExactRational.isZero_iff hoq).mpr h0)
        have havpos : 0 < available.toRat := lt_of_lt_of_le (lt_of_le_of_ne hoq0 (Ne.symm h0)) hoqle
        exact averageShares_error totalBasis oq available _ e htw hoq hav havpos.ne'
          (fun l hl => hw l ((sortBy_perm _ _).mem_iff.mp hl)) h
  · simp only [hm, Bool.false_eq_true, ↓reduceIte] at h
    exact takeLayers_error ordered oq e (fun l hl => hw l (costOrder_mem ho l hl))
      (fun l hl => hpos l (costOrder_mem ho l hl)) hoq h

/-- The allocations made from a coherent request are constructible. -/
theorem costAllocations_wf {policy : InventoryCostPolicy} {bookId : BookId}
    {request : InventoryCostRequest} {ordered : List InventoryLayerInput}
    {available oq : ExactRational} {allocs : List InventoryAllocationResult}
    (hr : request.WF) (hcoh : CostCoherent policy bookId request)
    (ho : costOrder policy.method request = .ok (some ordered)) (hawf : available.WF)
    (havsum : available.toRat = (ordered.map (·.quantity.toRat)).sum) (hoqwf : oq.WF)
    (hoq0 : 0 ≤ oq.toRat) (hoqle : oq.toRat ≤ available.toRat)
    (hal : costAllocations policy.method request ordered available oq = .ok allocs) :
    ∀ a ∈ allocs, a.quantity.WF ∧ a.basis.WF := by
  by_cases hmeth : policy.method = .weightedAverage
  · rw [hmeth] at ho hal
    obtain ⟨-, -, -, -, -, hwf, -, -⟩ := costAllocations_average hr.layers hcoh.layerIds ho hawf
      havsum hoqwf hoq0 hoqle hal
    exact hwf
  · obtain ⟨hg, -⟩ := costAllocations_greedy hmeth hr.layers
      (fun l hl => (hcoh.layers l hl).1) ho havsum hoqwf hoq0 hoqle hal
    intro a ha
    obtain ⟨l, -, hl⟩ := greedy_taken ordered allocs hg a ha
    exact ⟨hl.quantity_wf, hl.basis_wf⟩

/-- `calculateInventoryCost` throws only for the size limit: for constructible policies and a
constructible request, every division it makes is by a quantity that is not zero. -/
theorem calculateInventoryCost_error {policies : List AccountingPolicy} {bookId : BookId}
    {request : InventoryCostRequest} {e : NumErr} (hp : ∀ p ∈ policies, p.WF) (hr : request.WF)
    (h : calculateInventoryCost policies bookId request = .error e) :
    e = .representationLimitExceeded := by
  unfold calculateInventoryCost at h
  cases hpol : policyAt InventoryCostPolicy policies request.policyId request.policyVersion
      request.governedAt with
  | rejected ds => simp [hpol] at h
  | selected policy =>
    simp only [hpol] at h
    have hpw : policy.WF := hp _ (policyAt_inventoryCost_mem hpol)
    by_cases hinc : costIncoherent policy bookId request = true
    · simp [hinc] at h
    · have hinc' : costIncoherent policy bookId request = false := Bool.eq_false_iff.mpr hinc
      have hcoh : CostCoherent policy bookId request := costCoherent_iff.mp (fun hc => by
        have := (costIncoherent_iff hr (fun r hr' => hpw.provisionalRate r hr')).mpr hc
        rw [hinc'] at this
        cases this)
      have hposl : ∀ l ∈ request.layers, 0 < l.quantity.toRat := fun l hl => (hcoh.layers l hl).1
      simp only [hinc', Bool.false_eq_true, ↓reduceIte] at h
      cases ho : costOrder policy.method request with
      | error e' =>
        simp only [ho, Except.error.injEq] at h
        subst h
        exact costOrder_error hr.layers (fun l hl => (hposl l hl).ne') ho
      | ok o =>
        cases o with
        | none => simp [ho] at h
        | some ordered =>
          simp only [ho] at h
          cases ha : costAvailable policy.method ordered request with
          | error e' =>
            simp only [ha, Except.error.injEq] at h
            subst h
            unfold costAvailable at ha
            exact accountingSum_error (fun v hv => by
              obtain ⟨l, hl, rfl⟩ := List.mem_map.mp hv
              by_cases hm : policy.method = .specificIdentification
              · simp only [hm, ↓reduceIte] at hl
                exact (hr.layers l (costOrder_mem (hm ▸ ho) l hl)).quantity
              · simp only [hm, Bool.false_eq_true, ↓reduceIte] at hl
                exact (hr.layers l hl).quantity) ha
          | ok available =>
            simp only [ha] at h
            obtain ⟨hawf, havsum⟩ := costAvailable_spec hr.layers ho ha
            obtain ⟨hoqwf, hoqval⟩ := ordinaryQuantityOf_spec hr.quantity hawf
            obtain ⟨-, hoq0, hoqle⟩ := costed_bounds hcoh ho havsum hoqval
            cases hs : request.quantity.subtract
                (ordinaryQuantityOf request.quantity available) with
            | error e' =>
              simp only [hs, Except.error.injEq] at h
              subst h
              exact subtract_error hr.quantity hoqwf hs
            | ok pq =>
              simp only [hs] at h
              obtain ⟨hpqwf, -⟩ := ExactRational.subtract_ok hr.quantity hoqwf hs
              by_cases hsh : (!pq.isZero &&
                  (policy.shortageTreatment == .reject || policy.provisionalBasisMethod.isNone)) =
                    true
              · simp [hsh] at h
              · have hsh' : (!pq.isZero &&
                    (policy.shortageTreatment == .reject || policy.provisionalBasisMethod.isNone)) =
                    false := Bool.eq_false_iff.mpr hsh
                simp only [hsh', Bool.false_eq_true, ↓reduceIte] at h
                cases hal : costAllocations policy.method request ordered available
                    (ordinaryQuantityOf request.quantity available) with
                | error e' =>
                  simp only [hal, Except.error.injEq] at h
                  subst h
                  exact costAllocations_error hr.layers hposl ho hawf hoqwf hoq0 hoqle hal
                | ok allocs =>
                  simp only [hal] at h
                  have hallwf := costAllocations_wf hr hcoh ho hawf havsum hoqwf hoq0 hoqle hal
                  cases hsum : accountingSum (allocs.map (·.basis)) with
                  | error e' =>
                    simp only [hsum, Except.error.injEq] at h
                    subst h
                    exact accountingSum_error (fun v hv => by
                      obtain ⟨a, ha', rfl⟩ := List.mem_map.mp hv
                      exact (hallwf a ha').2) hsum
                  | ok ob =>
                    simp only [hsum] at h
                    obtain ⟨hobwf, -⟩ := accountingSum_ok (fun v hv => by
                      obtain ⟨a, ha', rfl⟩ := List.mem_map.mp hv
                      exact (hallwf a ha').2) hsum
                    cases hrt : provisionalRateOf policy request pq
                        (ordinaryQuantityOf request.quantity available) ob with
                    | error e' =>
                      simp only [hrt, Except.error.injEq] at h
                      subst h
                      exact provisionalRateOf_error hr.layers hcoh.layerIds
                        (fun l hl => (hposl l hl).ne') hoqwf hobwf hrt
                    | ok rate? =>
                      simp only [hrt] at h
                      by_cases hrr : rateRejected pq rate? = true
                      · simp [hrr] at h
                      · have hrr' : rateRejected pq rate? = false := Bool.eq_false_iff.mpr hrr
                        simp only [hrr', Bool.false_eq_true, ↓reduceIte] at h
                        cases rate? with
                        | none => simp [rateRejected] at hrr'
                        | some rate =>
                          simp only [Option.getD_some] at h
                          obtain ⟨hratewf, -⟩ := provisionalRateOf_spec hpw hr.layers
                            hcoh.layerIds hoqwf hobwf hrt
                          cases hm : pq.multiply rate with
                          | error e' =>
                            simp only [hm, Except.error.injEq] at h
                            subst h
                            exact multiply_error hpqwf hratewf hm
                          | ok pb => simp [hm] at h


/-! ## The rejection of the rate of a shortage -/

/-- The test of the rate of a shortage, for constructible numbers: no rate, a rate below zero, or a rate
of zero for a quantity that is short. -/
theorem rateRejected_iff {pq : ExactRational} {rate : Option ExactRational} (hpq : pq.WF)
    (hr : ∀ r, rate = some r → r.WF) :
    rateRejected pq rate = true ↔
      rate = none ∨ ∃ r, rate = some r ∧ (r.toRat < 0 ∨ (pq.toRat ≠ 0 ∧ r.toRat = 0)) := by
  cases hrate : rate with
  | none => simp [rateRejected]
  | some r =>
    have hw : r.WF := hr r hrate
    simp only [rateRejected, Bool.or_eq_true, Bool.and_eq_true, Bool.not_eq_true', reduceCtorEq,
      false_or, Option.some.injEq, exists_eq_left']
    rw [ExactRational.isNegative_iff hw, ExactRational.isZero_iff hw]
    refine or_congr Iff.rfl (and_congr ?_ Iff.rfl)
    rw [Bool.eq_false_iff, ne_eq, ExactRational.isZero_iff hpq]

/-- The rate of a shortage is refused exactly when every step before it returned, nothing earlier
rejected, and the test of the rate holds. -/
theorem calculateInventoryCost_rate_iff {policies : List AccountingPolicy} {bookId : BookId}
    {request : InventoryCostRequest} :
    calculateInventoryCost policies bookId request = .ok (.rejected [rateDiagnostic]) ↔
      ∃ (policy : InventoryCostPolicy) (ordered : List InventoryLayerInput)
          (available pq ob : ExactRational) (allocs : List InventoryAllocationResult)
          (rate : Option ExactRational),
        policyAt InventoryCostPolicy policies request.policyId request.policyVersion
          request.governedAt = .selected policy ∧
        costIncoherent policy bookId request = false ∧
        costOrder policy.method request = .ok (some ordered) ∧
        costAvailable policy.method ordered request = .ok available ∧
        request.quantity.subtract (ordinaryQuantityOf request.quantity available) = .ok pq ∧
        (!pq.isZero &&
          (policy.shortageTreatment == .reject || policy.provisionalBasisMethod.isNone)) = false ∧
        costAllocations policy.method request ordered available
          (ordinaryQuantityOf request.quantity available) = .ok allocs ∧
        accountingSum (allocs.map (·.basis)) = .ok ob ∧
        provisionalRateOf policy request pq (ordinaryQuantityOf request.quantity available) ob =
          .ok rate ∧
        rateRejected pq rate = true := by
  obtain ⟨n12, n13, n14, n15, n23, n24, n25, n34, n35, n45⟩ := costDiagnostics_ne
  rw [calculateInventoryCost_rejected_iff]
  constructor
  · rintro (h | ⟨policy, hpol, hinc, hds⟩ | ⟨policy, hpol, hinc, ho, hds⟩ |
      ⟨policy, ordered, available, pq, hpol, hinc, ho, ha, hs, hsh, hds⟩ |
      ⟨policy, ordered, available, pq, ob, allocs, rate, hpol, hinc, ho, ha, hs, hsh, hal, hsum,
        hrt, hrr, -⟩)
    · exact absurd (List.singleton_inj.mp ((policyAt_rejected_eq h).symm)) n15
    · exact absurd (List.singleton_inj.mp hds).symm n25
    · exact absurd (List.singleton_inj.mp hds).symm n35
    · exact absurd (List.singleton_inj.mp hds).symm n45
    · exact ⟨policy, ordered, available, pq, ob, allocs, rate, hpol, hinc, ho, ha, hs, hsh, hal,
        hsum, hrt, hrr⟩
  · rintro ⟨policy, ordered, available, pq, ob, allocs, rate, hpol, hinc, ho, ha, hs, hsh, hal,
      hsum, hrt, hrr⟩
    exact Or.inr (Or.inr (Or.inr (Or.inr ⟨policy, ordered, available, pq, ob, allocs, rate, hpol,
      hinc, ho, ha, hs, hsh, hal, hsum, hrt, hrr, rfl⟩)))


/-! ## No layer is over-drawn -/

/-- No layer is over-drawn: for every method but the weighted average, an allocation takes no more
than its layer holds, of quantity and of cost, and no negative amount of either; for the weighted
average, an allocation takes no more quantity than its layer holds. -/
theorem calculateInventoryCost_remaining {policies : List AccountingPolicy} {bookId : BookId}
    {request : InventoryCostRequest} {allocs : List InventoryAllocationResult}
    {ob pq pb : ExactRational} (hp : ∀ p ∈ policies, p.WF) (hr : request.WF)
    (h : calculateInventoryCost policies bookId request = .ok (.costed allocs ob pq pb)) :
    ∃ policy : InventoryCostPolicy,
      policyAt InventoryCostPolicy policies request.policyId request.policyVersion
        request.governedAt = .selected policy ∧
      (policy.method ≠ .weightedAverage → ∀ a ∈ allocs, ∃ l ∈ request.layers,
        a.layerId = l.id ∧ 0 ≤ l.quantity.toRat - a.quantity.toRat ∧ 0 ≤ a.basis.toRat ∧
        a.basis.toRat ≤ l.totalBasis.toRat) ∧
      (policy.method = .weightedAverage → ∀ a ∈ allocs, ∃ l ∈ request.layers,
        a.layerId = l.id ∧ 0 ≤ l.quantity.toRat - a.quantity.toRat) := by
  obtain ⟨policy, ordered, available, oq, rate, hpol, -, hpw, hcoh, ho, hawf, havsum, -, hoqwf,
    hoqval, hpqwf, hpqval, -, hal, hsum, -, -⟩ := calculateInventoryCost_costed_context hp hr h
  obtain ⟨-, hoq0, hoqle⟩ := costed_bounds hcoh ho havsum hoqval
  refine ⟨policy, hpol, fun hm a ha => ?_, fun hm a ha => ?_⟩
  · obtain ⟨hg, -⟩ := costAllocations_greedy hm hr.layers (fun l hl => (hcoh.layers l hl).1) ho
      havsum hoqwf hoq0 hoqle hal
    obtain ⟨l, hl, ht⟩ := greedy_taken ordered allocs hg a ha
    have hlm := costOrder_mem ho l hl
    obtain ⟨hlq, htb, -⟩ := hcoh.layers l hlm
    refine ⟨l, hlm, ht.layerId, by linarith [ht.quantity_le], ?_, ?_⟩
    · rw [ht.basis]
      exact div_nonneg (mul_nonneg htb ht.quantity_pos.le) hlq.le
    · rw [ht.basis, div_le_iff₀ hlq]
      exact mul_le_mul_of_nonneg_left ht.quantity_le htb
  · rw [hm] at ho hal
    obtain ⟨tb, -, -, -, -, -, hz, hne⟩ := costAllocations_average hr.layers hcoh.layerIds ho hawf
      havsum hoqwf hoq0 hoqle hal
    by_cases h0 : oq.toRat = 0
    · rw [hz h0] at ha
      exact absurd ha (by simp)
    · obtain ⟨sorted, hperm, -, hfa⟩ := hne h0
      obtain ⟨x, hx, hax⟩ := forall₂_right_mem hfa a ha
      have hxm := hperm.mem_iff.mp hx
      have havpos : 0 < available.toRat :=
        lt_of_lt_of_le (lt_of_le_of_ne hoq0 (Ne.symm h0)) hoqle
      refine ⟨x, hxm, hax.layerId, ?_⟩
      rw [hax.quantity]
      have hxq := (hcoh.layers x hxm).1
      have : x.quantity.toRat * oq.toRat / available.toRat ≤ x.quantity.toRat := by
        rw [div_le_iff₀ havpos]
        exact mul_le_mul_of_nonneg_left hoqle hxq.le
      linarith


end Inventory

end Rastrata.Kernel

/-
The laws of `calculateInventoryRecosting`: the difference between the actual cost and the provisional
cost, the quantity a layer can be recosted for, what is produced, and the rejections.
-/
import Rastrata.Kernel.Accounting.Inventory.Support

namespace Rastrata.Kernel

set_option linter.unusedSimpArgs false

namespace Inventory

/-! ## What a recosting is made of -/

/-- When `calculateInventoryRecosting` drafts a recosting, every step of it returned and the test did
not reject: the prior quantity was summed, the layer found, what is left of it computed, the quantity
and the basis of the sources summed, and the provisional share and the adjustment computed. The draft
holds no journal and the one effect. -/
theorem calculateInventoryRecosting_draft_inv {state : AccountingCanonicalState}
    {request : RecostInventoryRequest} {d : AccountingDraft}
    (h : calculateInventoryRecosting state request = .ok (.draft d)) :
    ∃ (prior : ExactRational) (layer : ProvisionalInventoryLayer)
      (remaining sourceQuantity finalBasis product provisionalShare adjustment : ExactRational),
      accountingSum (priorQuantities state request.layerId) = .ok prior ∧
      state.provisionalInventoryLayers.find? (fun candidate => candidate.id == request.layerId) =
        some layer ∧
      layer.quantity.subtract prior = .ok remaining ∧
      accountingSum (request.sources.map (·.quantity)) = .ok sourceQuantity ∧
      recostingRejected request layer sourceQuantity remaining = false ∧
      accountingSum (request.sources.map (·.totalBasis)) = .ok finalBasis ∧
      layer.provisionalBasis.multiply sourceQuantity = .ok product ∧
      product.divide layer.quantity = .ok provisionalShare ∧
      finalBasis.subtract provisionalShare = .ok adjustment ∧
      d = { journals := [],
            effects := [.inventoryRecosting (recostingEffect request adjustment)] } := by
  unfold calculateInventoryRecosting at h
  cases hp : accountingSum (priorQuantities state request.layerId) with
  | error e => simp [hp] at h
  | ok prior =>
    simp only [hp] at h
    cases hl : state.provisionalInventoryLayers.find?
        (fun candidate => candidate.id == request.layerId) with
    | none =>
      simp only [hl] at h
      cases hq : accountingSum (request.sources.map (·.quantity)) with
      | error e => simp [hq] at h
      | ok q => simp [hq, recostingRejection, reject] at h
    | some layer =>
      simp only [hl] at h
      cases hr : layer.quantity.subtract prior with
      | error e => simp [hr] at h
      | ok remaining =>
        simp only [hr] at h
        cases hq : accountingSum (request.sources.map (·.quantity)) with
        | error e => simp [hq] at h
        | ok sourceQuantity =>
          simp only [hq] at h
          by_cases hrej : recostingRejected request layer sourceQuantity remaining = true
          · simp [hrej, recostingRejection, reject] at h
          · have hrej' : recostingRejected request layer sourceQuantity remaining = false :=
              Bool.eq_false_iff.mpr hrej
            simp only [hrej', Bool.false_eq_true, ↓reduceIte] at h
            cases hb : accountingSum (request.sources.map (·.totalBasis)) with
            | error e => simp [hb] at h
            | ok finalBasis =>
              simp only [hb] at h
              cases hm : layer.provisionalBasis.multiply sourceQuantity with
              | error e => simp [hm] at h
              | ok product =>
                simp only [hm] at h
                cases hd : product.divide layer.quantity with
                | error e => simp [hd] at h
                | ok provisionalShare =>
                  simp only [hd] at h
                  cases hs : finalBasis.subtract provisionalShare with
                  | error e => simp [hs] at h
                  | ok adjustment =>
                    simp only [hs, Except.ok.injEq] at h
                    exact ⟨prior, layer, remaining, sourceQuantity, finalBasis, product,
                      provisionalShare, adjustment, rfl, rfl, hr, rfl, hrej', rfl, hm, hd, hs,
                      AccountingCalculation.draft.inj h.symm⟩

/-- The quantities of the earlier recostings of a layer are constructible when the state is. -/
theorem priorQuantities_wf {state : AccountingCanonicalState} (hs : state.WF)
    (layerId : ProvisionalInventoryLayerId) : ∀ q ∈ priorQuantities state layerId, q.WF := by
  intro q hq
  unfold priorQuantities at hq
  obtain ⟨item, hitem, hq⟩ := List.mem_flatMap.mp hq
  obtain ⟨source, hsource, rfl⟩ := List.mem_map.mp hq
  exact ((hs.inventoryRecostings item (List.mem_filter.mp hitem).1).sources source hsource).quantity

/-- The recosting difference is the actual cost less the provisional cost, exactly: the total basis of
the sources less the layer's provisional basis times the quantity recosted over the layer's quantity.
The draft holds no journal and the one effect, which carries the request's identifier, layer, time,
sources and derivation. -/
theorem calculateInventoryRecosting_adjustment {state : AccountingCanonicalState}
    {request : RecostInventoryRequest} {d : AccountingDraft} (hs : state.WF) (hr : request.WF)
    (h : calculateInventoryRecosting state request = .ok (.draft d)) :
    ∃ (layer : ProvisionalInventoryLayer) (adjustment : ExactRational),
      layer ∈ state.provisionalInventoryLayers ∧ layer.id = request.layerId ∧
      d.journals = [] ∧
      d.effects = [.inventoryRecosting (recostingEffect request adjustment)] ∧
      adjustment.WF ∧
      adjustment.toRat = (request.sources.map (·.totalBasis.toRat)).sum -
        layer.provisionalBasis.toRat * (request.sources.map (·.quantity.toRat)).sum /
          layer.quantity.toRat := by
  obtain ⟨prior, layer, remaining, sourceQuantity, finalBasis, product, provisionalShare, adjustment,
    hp, hl, hrem, hq, hrej, hb, hm, hd, hsub, hdraft⟩ := calculateInventoryRecosting_draft_inv h
  have hmem := List.mem_of_find?_eq_some hl
  have hid : layer.id = request.layerId := by simpa using List.find?_some hl
  have hlw := hs.provisionalInventoryLayers layer hmem
  obtain ⟨hqw, hqr⟩ := accountingSum_ok (fun v hv => by
    obtain ⟨src, hsrc, rfl⟩ := List.mem_map.mp hv
    exact (hr.sources src hsrc).quantity) hq
  obtain ⟨hbw, hbr⟩ := accountingSum_ok (fun v hv => by
    obtain ⟨src, hsrc, rfl⟩ := List.mem_map.mp hv
    exact (hr.sources src hsrc).totalBasis) hb
  obtain ⟨hpw, hpr⟩ := ExactRational.multiply_ok hlw.provisionalBasis hqw hm
  obtain ⟨hshw, -, hshr⟩ := ExactRational.divide_ok hpw hlw.quantity hd
  obtain ⟨haw, har⟩ := ExactRational.subtract_ok hbw hshw hsub
  refine ⟨layer, adjustment, hmem, hid, ?_, ?_, haw, ?_⟩
  · rw [hdraft]
  · rw [hdraft]
  · rw [har, hbr, hshr, hpr, hqr, List.map_map, List.map_map]
    rfl

/-- A layer is recosted once: the quantity of every recosting of it, this one included, never exceeds
the quantity of the layer. -/
theorem calculateInventoryRecosting_settledOnce {state : AccountingCanonicalState}
    {request : RecostInventoryRequest} {d : AccountingDraft} (hs : state.WF) (hr : request.WF)
    (h : calculateInventoryRecosting state request = .ok (.draft d)) :
    ∃ layer : ProvisionalInventoryLayer, layer ∈ state.provisionalInventoryLayers ∧
      layer.id = request.layerId ∧
      state.provisionalInventoryLayers.find? (fun candidate => candidate.id == request.layerId) =
        some layer ∧
      0 < (request.sources.map (·.quantity.toRat)).sum ∧
      ((priorQuantities state request.layerId).map ExactRational.toRat).sum +
        (request.sources.map (·.quantity.toRat)).sum ≤ layer.quantity.toRat := by
  obtain ⟨prior, layer, remaining, sourceQuantity, finalBasis, product, provisionalShare, adjustment,
    hp, hl, hrem, hq, hrej, hb, hm, hd, hsub, hdraft⟩ := calculateInventoryRecosting_draft_inv h
  have hmem := List.mem_of_find?_eq_some hl
  have hid : layer.id = request.layerId := by simpa using List.find?_some hl
  have hlw := hs.provisionalInventoryLayers layer hmem
  obtain ⟨hpw, hpr⟩ := accountingSum_ok (priorQuantities_wf hs request.layerId) hp
  obtain ⟨hrw, hrr⟩ := ExactRational.subtract_ok hlw.quantity hpw hrem
  obtain ⟨hqw, hqr⟩ := accountingSum_ok (fun v hv => by
    obtain ⟨src, hsrc, rfl⟩ := List.mem_map.mp hv
    exact (hr.sources src hsrc).quantity) hq
  unfold recostingRejected at hrej
  simp only [Bool.or_eq_false_iff, Bool.not_eq_false', beq_eq_false_iff_ne, ne_eq,
    decide_eq_false_iff_not, not_lt] at hrej
  obtain ⟨⟨⟨⟨⟨⟨-, -⟩, hne⟩, -⟩, -⟩, hF⟩, hG⟩ := hrej
  have hall : ∀ src ∈ request.sources, 0 < src.quantity.toRat := by
    intro src hsrc
    by_contra hn
    have hpos : positive src.quantity = false :=
      (positive_eq_false_iff (hr.sources src hsrc).quantity).mpr hn
    have hany : (request.sources.any fun source =>
        !positive source.quantity || source.totalBasis.isNegative) = true :=
      List.any_eq_true.mpr ⟨src, hsrc, by simp [hpos]⟩
    rw [hF] at hany
    cases hany
  have hsum_pos : 0 < (request.sources.map (·.quantity.toRat)).sum := by
    apply List.sum_pos
    · intro x hx
      obtain ⟨src, hsrc, rfl⟩ := List.mem_map.mp hx
      exact hall src hsrc
    · intro hnil
      apply hne
      cases hs : request.sources with
      | nil => rfl
      | cons a t => simp [hs] at hnil
  have hle : sourceQuantity.toRat ≤ remaining.toRat :=
    not_lt.mp (fun hlt => hG ((ExactRational.compare_gt_iff hqw hrw).mpr hlt))
  refine ⟨layer, hmem, hid, hl, hsum_pos, ?_⟩
  have hqr' : sourceQuantity.toRat = (request.sources.map (·.quantity.toRat)).sum := by
    rw [hqr, List.map_map]; rfl
  rw [hpr] at hrr
  rw [hqr', hrr] at hle
  have hpr' : prior.toRat = ((priorQuantities state request.layerId).map ExactRational.toRat).sum :=
    hpr
  rw [← hpr']
  linarith

/-- A layer that is fully recosted is not recosted again: when the quantity of its earlier recostings
is the quantity of the layer, no request is drafted. -/
theorem calculateInventoryRecosting_full {state : AccountingCanonicalState}
    {request : RecostInventoryRequest} (hs : state.WF) (hr : request.WF)
    {layer : ProvisionalInventoryLayer}
    (hl : state.provisionalInventoryLayers.find?
      (fun candidate => candidate.id == request.layerId) = some layer)
    (hfull : ((priorQuantities state request.layerId).map ExactRational.toRat).sum =
      layer.quantity.toRat) (d : AccountingDraft) :
    calculateInventoryRecosting state request ≠ .ok (.draft d) := by
  intro h
  obtain ⟨layer', -, -, hl', hpos, hle⟩ := calculateInventoryRecosting_settledOnce hs hr h
  rw [hl] at hl'
  cases hl'
  linarith

/-- The tests of a recosting after its layer is found, for constructible values: the derivation is not
approved with evidence and a time, or is of another policy than the layer's; there is no source, more
than the limit, or one receipt twice; a source has no quantity or a negative basis; the sources
recost more than is left. -/
theorem recostingRejected_iff {request : RecostInventoryRequest} {layer : ProvisionalInventoryLayer}
    {sourceQuantity remaining : ExactRational} (hr : request.WF) (hq : sourceQuantity.WF)
    (hrem : remaining.WF) :
    recostingRejected request layer sourceQuantity remaining = true ↔
      ¬ validAccountingDerivation request.derivation = true ∨
      request.derivation.policyId ≠ layer.policyId ∨ request.sources = [] ∨
      accountingLimits.maxRecostingSources < request.sources.length ∨
      ¬ (request.sources.map (·.receiptId)).Nodup ∨
      (∃ src ∈ request.sources, ¬ 0 < src.quantity.toRat ∨ src.totalBasis.toRat < 0) ∨
      remaining.toRat < sourceQuantity.toRat := by
  unfold recostingRejected
  simp only [Bool.or_eq_true, or_assoc, Bool.not_eq_true', bne_iff_ne, beq_iff_eq,
    decide_eq_true_eq, List.any_eq_true]
  have hset : (Lots.setSize (request.sources.map (·.receiptId)) != request.sources.length) = true ↔
      ¬ (request.sources.map (·.receiptId)).Nodup := by
    rw [bne_iff_ne, ne_eq, ← List.length_map (f := (·.receiptId)) (as := request.sources),
      Lots.setSize_eq_length_iff]
  refine or_congr (by simp) (or_congr Iff.rfl (or_congr List.length_eq_zero_iff
    (or_congr Iff.rfl (or_congr ?_ (or_congr ?_ ?_)))))
  · simpa using hset
  · constructor
    · rintro ⟨src, hsrc, h⟩
      refine ⟨src, hsrc, ?_⟩
      have hw := hr.sources src hsrc
      rcases h with h | h
      · exact Or.inl ((positive_eq_false_iff hw.quantity).mp h)
      · exact Or.inr ((ExactRational.isNegative_iff hw.totalBasis).mp h)
    · rintro ⟨src, hsrc, h⟩
      refine ⟨src, hsrc, ?_⟩
      have hw := hr.sources src hsrc
      rcases h with h | h
      · exact Or.inl ((positive_eq_false_iff hw.quantity).mpr h)
      · exact Or.inr ((ExactRational.isNegative_iff hw.totalBasis).mpr h)
  · rw [← ExactRational.compare_gt_iff hq hrem]

/-- A recosting is rejected, with its one diagnostic, exactly when the sums of the prior and the
sources returned and either no layer has the identifier or the tests reject. -/
theorem calculateInventoryRecosting_rejected_iff {state : AccountingCanonicalState}
    {request : RecostInventoryRequest} {ds : List SemanticDiagnostic} :
    calculateInventoryRecosting state request = .ok (.rejected ds) ↔
      ds = [recostingDiagnostic] ∧
      ((∃ prior sourceQuantity : ExactRational,
          accountingSum (priorQuantities state request.layerId) = .ok prior ∧
          state.provisionalInventoryLayers.find?
            (fun candidate => candidate.id == request.layerId) = none ∧
          accountingSum (request.sources.map (·.quantity)) = .ok sourceQuantity) ∨
        (∃ (prior : ExactRational) (layer : ProvisionalInventoryLayer)
            (remaining sourceQuantity : ExactRational),
          accountingSum (priorQuantities state request.layerId) = .ok prior ∧
          state.provisionalInventoryLayers.find?
            (fun candidate => candidate.id == request.layerId) = some layer ∧
          layer.quantity.subtract prior = .ok remaining ∧
          accountingSum (request.sources.map (·.quantity)) = .ok sourceQuantity ∧
          recostingRejected request layer sourceQuantity remaining = true)) := by
  constructor
  · intro h
    unfold calculateInventoryRecosting at h
    cases hp : accountingSum (priorQuantities state request.layerId) with
    | error e => simp [hp] at h
    | ok prior =>
      simp only [hp] at h
      cases hl : state.provisionalInventoryLayers.find?
          (fun candidate => candidate.id == request.layerId) with
      | none =>
        simp only [hl] at h
        cases hq : accountingSum (request.sources.map (·.quantity)) with
        | error e => simp [hq] at h
        | ok q =>
          simp only [hq, Except.ok.injEq, recostingRejection_eq,
            AccountingCalculation.rejected.injEq] at h
          subst h
          exact ⟨rfl, Or.inl ⟨prior, q, rfl, rfl, rfl⟩⟩
      | some layer =>
        simp only [hl] at h
        cases hr : layer.quantity.subtract prior with
        | error e => simp [hr] at h
        | ok remaining =>
          simp only [hr] at h
          cases hq : accountingSum (request.sources.map (·.quantity)) with
          | error e => simp [hq] at h
          | ok sourceQuantity =>
            simp only [hq] at h
            by_cases hrej : recostingRejected request layer sourceQuantity remaining = true
            · simp only [hrej, ↓reduceIte, Except.ok.injEq, recostingRejection_eq,
                AccountingCalculation.rejected.injEq] at h
              subst h
              exact ⟨rfl, Or.inr ⟨prior, layer, remaining, sourceQuantity, rfl, rfl, hr, rfl, hrej⟩⟩
            · have hrej' : recostingRejected request layer sourceQuantity remaining = false :=
                Bool.eq_false_iff.mpr hrej
              simp only [hrej', Bool.false_eq_true, ↓reduceIte] at h
              cases hb : accountingSum (request.sources.map (·.totalBasis)) with
              | error e => simp [hb] at h
              | ok finalBasis =>
                simp only [hb] at h
                cases hm : layer.provisionalBasis.multiply sourceQuantity with
                | error e => simp [hm] at h
                | ok product =>
                  simp only [hm] at h
                  cases hd : product.divide layer.quantity with
                  | error e => simp [hd] at h
                  | ok provisionalShare =>
                    simp only [hd] at h
                    cases hs : finalBasis.subtract provisionalShare with
                    | error e => simp [hs] at h
                    | ok adjustment =>
                      simp [hs, drafted, immutableAccountingValue] at h
  · rintro ⟨rfl, ⟨prior, q, hp, hl, hq⟩ | ⟨prior, layer, remaining, sourceQuantity, hp, hl, hr, hq, hrej⟩⟩
    · simp [calculateInventoryRecosting, hp, hl, hq, recostingRejection_eq]
    · simp [calculateInventoryRecosting, hp, hl, hr, hq, hrej, recostingRejection_eq]

/-- A recosting throws only for the size limit, or for a layer whose quantity is zero (which a layer
made by the kernel never has). -/
theorem calculateInventoryRecosting_error {state : AccountingCanonicalState}
    {request : RecostInventoryRequest} {e : NumErr} (hs : state.WF) (hr : request.WF)
    (h : calculateInventoryRecosting state request = .error e) :
    e = .representationLimitExceeded ∨
      (e = .invalidRational ∧ ∃ layer ∈ state.provisionalInventoryLayers,
        layer.id = request.layerId ∧ layer.quantity.toRat = 0) := by
  have hsrcq : ∀ v ∈ request.sources.map (·.quantity), v.WF := fun v hv => by
    obtain ⟨src, hsrc, rfl⟩ := List.mem_map.mp hv
    exact (hr.sources src hsrc).quantity
  have hsrcb : ∀ v ∈ request.sources.map (·.totalBasis), v.WF := fun v hv => by
    obtain ⟨src, hsrc, rfl⟩ := List.mem_map.mp hv
    exact (hr.sources src hsrc).totalBasis
  unfold calculateInventoryRecosting at h
  cases hp : accountingSum (priorQuantities state request.layerId) with
  | error e' =>
    simp only [hp, Except.error.injEq] at h
    subst h
    exact Or.inl (accountingSum_error (priorQuantities_wf hs request.layerId) hp)
  | ok prior =>
    simp only [hp] at h
    obtain ⟨hpw, -⟩ := accountingSum_ok (priorQuantities_wf hs request.layerId) hp
    cases hl : state.provisionalInventoryLayers.find?
        (fun candidate => candidate.id == request.layerId) with
    | none =>
      simp only [hl] at h
      cases hq : accountingSum (request.sources.map (·.quantity)) with
      | error e' =>
        simp only [hq, Except.error.injEq] at h
        subst h
        exact Or.inl (accountingSum_error hsrcq hq)
      | ok q => simp [hq, recostingRejection, reject] at h
    | some layer =>
      simp only [hl] at h
      have hmem := List.mem_of_find?_eq_some hl
      have hid : layer.id = request.layerId := by simpa using List.find?_some hl
      have hlw := hs.provisionalInventoryLayers layer hmem
      cases hrem : layer.quantity.subtract prior with
      | error e' =>
        simp only [hrem, Except.error.injEq] at h
        subst h
        exact Or.inl (subtract_error hlw.quantity hpw hrem)
      | ok remaining =>
        simp only [hrem] at h
        cases hq : accountingSum (request.sources.map (·.quantity)) with
        | error e' =>
          simp only [hq, Except.error.injEq] at h
          subst h
          exact Or.inl (accountingSum_error hsrcq hq)
        | ok sourceQuantity =>
          simp only [hq] at h
          obtain ⟨hqw, -⟩ := accountingSum_ok hsrcq hq
          by_cases hrej : recostingRejected request layer sourceQuantity remaining = true
          · simp [hrej, recostingRejection, reject] at h
          · have hrej' : recostingRejected request layer sourceQuantity remaining = false :=
              Bool.eq_false_iff.mpr hrej
            simp only [hrej', Bool.false_eq_true, ↓reduceIte] at h
            cases hb : accountingSum (request.sources.map (·.totalBasis)) with
            | error e' =>
              simp only [hb, Except.error.injEq] at h
              subst h
              exact Or.inl (accountingSum_error hsrcb hb)
            | ok finalBasis =>
              simp only [hb] at h
              obtain ⟨hbw, -⟩ := accountingSum_ok hsrcb hb
              cases hm : layer.provisionalBasis.multiply sourceQuantity with
              | error e' =>
                simp only [hm, Except.error.injEq] at h
                subst h
                exact Or.inl (multiply_error hlw.provisionalBasis hqw hm)
              | ok product =>
                simp only [hm] at h
                obtain ⟨hprw, -⟩ := ExactRational.multiply_ok hlw.provisionalBasis hqw hm
                cases hd : product.divide layer.quantity with
                | error e' =>
                  simp only [hd, Except.error.injEq] at h
                  subst h
                  rcases ExactRational.divide_ok_or_error (b := layer.quantity) hprw with
                    ⟨c, hc⟩ | ⟨hb0, he⟩ | ⟨-, he⟩
                  · rw [hc] at hd; cases hd
                  · rw [he] at hd
                    cases hd
                    refine Or.inr ⟨rfl, layer, hmem, hid, ?_⟩
                    have : layer.quantity.isZero = true := by simp [ExactRational.isZero, hb0]
                    exact (ExactRational.isZero_iff hlw.quantity).mp this
                  · rw [he] at hd; cases hd; exact Or.inl rfl
                | ok provisionalShare =>
                  simp only [hd] at h
                  obtain ⟨hshw, -, -⟩ := ExactRational.divide_ok hprw hlw.quantity hd
                  cases hsub : finalBasis.subtract provisionalShare with
                  | error e' =>
                    simp only [hsub, Except.error.injEq] at h
                    subst h
                    exact Or.inl (subtract_error hbw hshw hsub)
                  | ok adjustment => simp [hsub, drafted, immutableAccountingValue] at h

end Inventory

end Rastrata.Kernel

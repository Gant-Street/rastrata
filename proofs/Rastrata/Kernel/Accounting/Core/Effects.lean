/-
Laws of the accounting state and of effect admission (laws 3 and 5 of the brief of
`Accounting/Core.lean`): `applyAccountingEffect`, `accountingEffectExists`,
`validateAccountingEffectHash`, `validateAccountingEffectIdentities` and
`validateAccountingEffectAdmission`.

- `applyAccountingEffect` appends the effect to exactly the collection its type names; every
  other collection is unchanged, and the earlier members of that one are unchanged and keep their
  order (`AccountingCanonicalState.familyEffects_apply`, and one equation for each type).
- `accountingEffectExists` answers whether the collection the effect's type names has a member
  with its identifier (`accountingEffectExists_iff`); after an effect is applied it is found, and
  what was found before still is (`accountingEffectExists_apply`).
-/
import Rastrata.Kernel.Accounting.Core.Hashes

namespace Rastrata.Kernel

set_option linter.unusedSimpArgs false

/-! ## The collections of the state -/

/-- The members of the collection an effect's type names, each as an effect of that type. -/
def AccountingCanonicalState.familyEffects (state : AccountingCanonicalState) :
    AccountingEffect → List AccountingEffect
  | .provisionalInventoryLayer _ => state.provisionalInventoryLayers.map .provisionalInventoryLayer
  | .inventoryRecosting _ => state.inventoryRecostings.map .inventoryRecosting
  | .inventoryValueAdjustment _ => state.inventoryValueAdjustments.map .inventoryValueAdjustment
  | .openItem _ => state.openItems.map .openItem
  | .settlement _ => state.settlements.map .settlement
  | .settlementAllocation _ => state.settlementAllocations.map .settlementAllocation
  | .remeasurementResult _ => state.remeasurementResults.map .remeasurementResult
  | .remeasurementReversal _ => state.remeasurementReversals.map .remeasurementReversal
  | .allocationSchedule _ => state.allocationSchedules.map .allocationSchedule
  | .allocationRecognition _ => state.allocationRecognitions.map .allocationRecognition
  | .allocationScheduleRevision _ => state.allocationScheduleRevisions.map .allocationScheduleRevision
  | .taxDetermination _ => state.taxDeterminations.map .taxDetermination
  | .consolidationCompilation _ => state.consolidationCompilations.map .consolidationCompilation

/-- The effect itself, when it is of the type `kind` names, else nothing. -/
def AccountingEffect.ifSameType (effect kind : AccountingEffect) : List AccountingEffect :=
  if effect.type = kind.type then [effect] else []

/-- Applying an effect of type `provisionalInventoryLayer` appends its value to `provisionalInventoryLayers` and changes nothing
else. -/
@[simp] theorem applyAccountingEffect_provisionalInventoryLayer (state : AccountingCanonicalState) value :
    applyAccountingEffect state (.provisionalInventoryLayer value) =
      { state with provisionalInventoryLayers := state.provisionalInventoryLayers ++ [value] } := rfl

/-- Applying an effect of type `inventoryRecosting` appends its value to `inventoryRecostings` and changes nothing
else. -/
@[simp] theorem applyAccountingEffect_inventoryRecosting (state : AccountingCanonicalState) value :
    applyAccountingEffect state (.inventoryRecosting value) =
      { state with inventoryRecostings := state.inventoryRecostings ++ [value] } := rfl

/-- Applying an effect of type `inventoryValueAdjustment` appends its value to `inventoryValueAdjustments` and changes nothing
else. -/
@[simp] theorem applyAccountingEffect_inventoryValueAdjustment (state : AccountingCanonicalState) value :
    applyAccountingEffect state (.inventoryValueAdjustment value) =
      { state with inventoryValueAdjustments := state.inventoryValueAdjustments ++ [value] } := rfl

/-- Applying an effect of type `openItem` appends its value to `openItems` and changes nothing
else. -/
@[simp] theorem applyAccountingEffect_openItem (state : AccountingCanonicalState) value :
    applyAccountingEffect state (.openItem value) =
      { state with openItems := state.openItems ++ [value] } := rfl

/-- Applying an effect of type `settlement` appends its value to `settlements` and changes nothing
else. -/
@[simp] theorem applyAccountingEffect_settlement (state : AccountingCanonicalState) value :
    applyAccountingEffect state (.settlement value) =
      { state with settlements := state.settlements ++ [value] } := rfl

/-- Applying an effect of type `settlementAllocation` appends its value to `settlementAllocations` and changes nothing
else. -/
@[simp] theorem applyAccountingEffect_settlementAllocation (state : AccountingCanonicalState) value :
    applyAccountingEffect state (.settlementAllocation value) =
      { state with settlementAllocations := state.settlementAllocations ++ [value] } := rfl

/-- Applying an effect of type `remeasurementResult` appends its value to `remeasurementResults` and changes nothing
else. -/
@[simp] theorem applyAccountingEffect_remeasurementResult (state : AccountingCanonicalState) value :
    applyAccountingEffect state (.remeasurementResult value) =
      { state with remeasurementResults := state.remeasurementResults ++ [value] } := rfl

/-- Applying an effect of type `remeasurementReversal` appends its value to `remeasurementReversals` and changes nothing
else. -/
@[simp] theorem applyAccountingEffect_remeasurementReversal (state : AccountingCanonicalState) value :
    applyAccountingEffect state (.remeasurementReversal value) =
      { state with remeasurementReversals := state.remeasurementReversals ++ [value] } := rfl

/-- Applying an effect of type `allocationSchedule` appends its value to `allocationSchedules` and changes nothing
else. -/
@[simp] theorem applyAccountingEffect_allocationSchedule (state : AccountingCanonicalState) value :
    applyAccountingEffect state (.allocationSchedule value) =
      { state with allocationSchedules := state.allocationSchedules ++ [value] } := rfl

/-- Applying an effect of type `allocationRecognition` appends its value to `allocationRecognitions` and changes nothing
else. -/
@[simp] theorem applyAccountingEffect_allocationRecognition (state : AccountingCanonicalState) value :
    applyAccountingEffect state (.allocationRecognition value) =
      { state with allocationRecognitions := state.allocationRecognitions ++ [value] } := rfl

/-- Applying an effect of type `allocationScheduleRevision` appends its value to `allocationScheduleRevisions` and changes nothing
else. -/
@[simp] theorem applyAccountingEffect_allocationScheduleRevision (state : AccountingCanonicalState) value :
    applyAccountingEffect state (.allocationScheduleRevision value) =
      { state with allocationScheduleRevisions := state.allocationScheduleRevisions ++ [value] } := rfl

/-- Applying an effect of type `taxDetermination` appends its value to `taxDeterminations` and changes nothing
else. -/
@[simp] theorem applyAccountingEffect_taxDetermination (state : AccountingCanonicalState) value :
    applyAccountingEffect state (.taxDetermination value) =
      { state with taxDeterminations := state.taxDeterminations ++ [value] } := rfl

/-- Applying an effect of type `consolidationCompilation` appends its value to `consolidationCompilations` and changes nothing
else. -/
@[simp] theorem applyAccountingEffect_consolidationCompilation (state : AccountingCanonicalState) value :
    applyAccountingEffect state (.consolidationCompilation value) =
      { state with consolidationCompilations := state.consolidationCompilations ++ [value] } := rfl

/-- Applying an effect appends it to the collection its type names, after every earlier member
(which are unchanged and keep their order), and leaves every other collection as it was. -/
theorem AccountingCanonicalState.familyEffects_apply (state : AccountingCanonicalState)
    (effect kind : AccountingEffect) :
    (applyAccountingEffect state effect).familyEffects kind =
      state.familyEffects kind ++ effect.ifSameType kind := by
  cases effect <;> cases kind <;>
    simp [AccountingCanonicalState.familyEffects, AccountingEffect.ifSameType,
      AccountingEffect.type]

/-- The identifiers `accountingEffectExists` searches are those of the collection's members. -/
theorem AccountingCanonicalState.familyIds_eq (state : AccountingCanonicalState)
    (effect : AccountingEffect) :
    state.familyIds effect = (state.familyEffects effect).map AccountingEffect.id := by
  cases effect <;>
    simp [AccountingCanonicalState.familyIds, AccountingCanonicalState.familyEffects,
      AccountingEffect.id, Function.comp_def]

/-- `accountingEffectExists` answers whether a member of the collection the effect's type names
has the effect's identifier. -/
theorem accountingEffectExists_iff (state : AccountingCanonicalState) (effect : AccountingEffect) :
    accountingEffectExists state effect = true ↔
      ∃ member ∈ state.familyEffects effect, member.id = effect.id := by
  simp [accountingEffectExists, AccountingCanonicalState.familyIds_eq]

/-- After an effect is applied, an effect is found exactly when it was found before or it has the
applied effect's type and identifier. -/
theorem accountingEffectExists_apply (state : AccountingCanonicalState)
    (effect kind : AccountingEffect) :
    accountingEffectExists (applyAccountingEffect state effect) kind = true ↔
      accountingEffectExists state kind = true ∨
        (effect.type = kind.type ∧ effect.id = kind.id) := by
  rw [accountingEffectExists_iff, accountingEffectExists_iff,
    AccountingCanonicalState.familyEffects_apply]
  simp only [List.mem_append, AccountingEffect.ifSameType]
  constructor
  · rintro ⟨member, hmember | hmember, hid⟩
    · exact Or.inl ⟨member, hmember, hid⟩
    · split at hmember
      · simp only [List.mem_singleton] at hmember
        subst hmember
        exact Or.inr ⟨by assumption, hid⟩
      · simp at hmember
  · rintro (⟨member, hmember, hid⟩ | ⟨htype, hid⟩)
    · exact ⟨member, Or.inl hmember, hid⟩
    · exact ⟨effect, Or.inr (by simp [htype]), hid⟩

/-- An effect is found after it is applied. -/
theorem accountingEffectExists_apply_self (state : AccountingCanonicalState)
    (effect : AccountingEffect) :
    accountingEffectExists (applyAccountingEffect state effect) effect = true :=
  (accountingEffectExists_apply state effect effect).mpr (Or.inr ⟨rfl, rfl⟩)

/-- An effect found before an effect is applied is still found after. -/
theorem accountingEffectExists_apply_of_exists {state : AccountingCanonicalState}
    {kind : AccountingEffect} (h : accountingEffectExists state kind = true)
    (effect : AccountingEffect) :
    accountingEffectExists (applyAccountingEffect state effect) kind = true :=
  (accountingEffectExists_apply state effect kind).mpr (Or.inl h)

/-- Nothing is found in the empty state. -/
theorem accountingEffectExists_empty (effect : AccountingEffect) :
    accountingEffectExists emptyAccountingCanonicalState effect = false := by
  cases effect <;> rfl

/-! ## `validateAccountingEffectHash` -/

/-- The check of line 2201: the posting plan of an allocation schedule (`allocationPlanIsValid`);
every other effect passes it. -/
def AccountingEffect.planCheck : AccountingEffect → Except QuantizeErr Bool
  | .allocationSchedule schedule => allocationPlanIsValid schedule
  | _ => .ok true

/-- The check of line 2202: the posted amounts of a schedule revision against its algorithm; no
other effect fails it. -/
def AccountingEffect.revisionInconsistent : AccountingEffect → Bool
  | .allocationScheduleRevision revision => revisionPostedAmountsInconsistent revision
  | _ => false

/-- The three comparisons of line 2208 hold exactly when the carried hash is the recomputed one. -/
theorem contentHash_fields_beq_iff (recomputed carried : ContentHash) :
    (recomputed.algorithm == carried.algorithm &&
      recomputed.canonicalizationVersion == carried.canonicalizationVersion &&
      recomputed.digest == carried.digest) = true ↔ carried = recomputed := by
  rw [ContentHash.ext_iff]
  simp only [Bool.and_eq_true, beq_iff_eq]
  constructor
  · rintro ⟨⟨h1, h2⟩, h3⟩
    exact ⟨h1.symm, h2.symm, h3.symm⟩
  · rintro ⟨h1, h2, h3⟩
    exact ⟨⟨h1.symm, h2.symm⟩, h3.symm⟩

/-- `validateAccountingEffectHash` is the plan check, then the revision check, then the
comparison of the carried hash with the hash of the body under the capitalised type name. -/
theorem validateAccountingEffectHash_eq (effect : AccountingEffect) :
    validateAccountingEffectHash effect =
      match effect.planCheck with
      | .error e => .error e
      | .ok false => .ok false
      | .ok true =>
        .ok (!effect.revisionInconsistent &&
          decide (effect.contentHash = accountingHash effect.typeName effect.bodyValue)) := by
  have key : ∀ (r c : ContentHash), (r.algorithm == c.algorithm &&
      r.canonicalizationVersion == c.canonicalizationVersion && r.digest == c.digest) =
        decide (c = r) := by
    intro r c
    rw [Bool.eq_iff_iff, contentHash_fields_beq_iff, decide_eq_true_iff]
  cases effect with
  | allocationSchedule schedule =>
    simp only [validateAccountingEffectHash, AccountingEffect.planCheck,
      AccountingEffect.revisionInconsistent, key]
    rcases allocationPlanIsValid schedule with e | _ | _ <;> rfl
  | allocationScheduleRevision revision =>
    simp only [validateAccountingEffectHash, AccountingEffect.planCheck,
      AccountingEffect.revisionInconsistent, key]
    cases revisionPostedAmountsInconsistent revision <;> rfl
  | _ =>
    simp only [validateAccountingEffectHash, AccountingEffect.planCheck,
      AccountingEffect.revisionInconsistent, Bool.not_false, Bool.true_and, Bool.false_eq_true,
      ↓reduceIte, key]

/-- `validateAccountingEffectHash` accepts exactly when the plan check passes, the revision check
passes, and the carried content hash is the hash of the effect's body (everything but its content
hash) under the capitalised type name. -/
theorem validateAccountingEffectHash_true_iff (effect : AccountingEffect) :
    validateAccountingEffectHash effect = .ok true ↔
      effect.planCheck = .ok true ∧ effect.revisionInconsistent = false ∧
        effect.contentHash = accountingHash effect.typeName effect.bodyValue := by
  rw [validateAccountingEffectHash_eq]
  rcases h : effect.planCheck with e | _ | _ <;> simp

/-- `validateAccountingEffectHash` throws exactly when the effect is an allocation schedule whose
plan check throws. -/
theorem validateAccountingEffectHash_error_iff (effect : AccountingEffect) (err : QuantizeErr) :
    validateAccountingEffectHash effect = .error err ↔
      ∃ schedule, effect = .allocationSchedule schedule ∧
        allocationPlanIsValid schedule = .error err := by
  rw [validateAccountingEffectHash_eq]
  constructor
  · intro h
    cases effect <;> simp_all [AccountingEffect.planCheck]
    rename_i schedule
    rcases hp : allocationPlanIsValid schedule with e | _ | _ <;> simp_all
  · rintro ⟨schedule, rfl, hp⟩
    simp [AccountingEffect.planCheck, hp]

/-- The capitalised type name is the effect's type with its first letter in capitals (line
2206). -/
theorem AccountingEffect.typeName_eq_capitalize (effect : AccountingEffect) :
    effect.typeName = effect.type.capitalize := by
  cases effect <;> simp only [AccountingEffect.typeName, AccountingEffect.type] <;> decide

/-- The body of an effect is a well-formed canonical value. -/
theorem AccountingEffect.bodyValue_wf (effect : AccountingEffect) : effect.bodyValue.WF := by
  cases effect <;> exact Rastrata.Kernel.bodyValue_wf _

/-- Two effects that both pass `validateAccountingEffectHash` and carry the same content hash are
the same effect (same type, every field the same), or a collision of SHA-256 is in hand. -/
theorem eq_of_validateAccountingEffectHash {e f : AccountingEffect}
    (he : validateAccountingEffectHash e = .ok true)
    (hf : validateAccountingEffectHash f = .ok true) (h : e.contentHash = f.contentHash) :
    e = f ∨ HashCollision := by
  have he' := ((validateAccountingEffectHash_true_iff e).mp he).2.2
  have hf' := ((validateAccountingEffectHash_true_iff f).mp hf).2.2
  clear he hf
  rcases accountingHash_canonicalValue_inj_or_collision e.bodyValue_wf f.bodyValue_wf
    (he'.symm.trans (h.trans hf')) with ⟨ht, hb⟩ | hc
  · left
    cases e <;> cases f <;> simp [AccountingEffect.typeName] at ht <;> rename_i a b <;>
      first
      | exact congrArg _ (Eq.trans
          (by rw [show b.contentHash = a.contentHash from h.symm]) (ProvisionalInventoryLayer.bodyValue_equiv hb))
      | exact congrArg _ (Eq.trans
          (by rw [show b.contentHash = a.contentHash from h.symm]) (InventoryRecosting.bodyValue_equiv hb))
      | exact congrArg _ (Eq.trans
          (by rw [show b.contentHash = a.contentHash from h.symm]) (InventoryValueAdjustment.bodyValue_equiv hb))
      | exact congrArg _ (Eq.trans
          (by rw [show b.contentHash = a.contentHash from h.symm]) (OpenItem.bodyValue_equiv hb))
      | exact congrArg _ (Eq.trans
          (by rw [show b.contentHash = a.contentHash from h.symm]) (Settlement.bodyValue_equiv hb))
      | exact congrArg _ (Eq.trans
          (by rw [show b.contentHash = a.contentHash from h.symm]) (SettlementAllocation.bodyValue_equiv hb))
      | exact congrArg _ (Eq.trans
          (by rw [show b.contentHash = a.contentHash from h.symm]) (RemeasurementResult.bodyValue_equiv hb))
      | exact congrArg _ (Eq.trans
          (by rw [show b.contentHash = a.contentHash from h.symm]) (RemeasurementReversal.bodyValue_equiv hb))
      | exact congrArg _ (Eq.trans
          (by rw [show b.contentHash = a.contentHash from h.symm]) (AllocationSchedule.bodyValue_equiv hb))
      | exact congrArg _ (Eq.trans
          (by rw [show b.contentHash = a.contentHash from h.symm]) (AllocationRecognition.bodyValue_equiv hb))
      | exact congrArg _ (Eq.trans
          (by rw [show b.contentHash = a.contentHash from h.symm]) (AllocationScheduleRevision.bodyValue_equiv hb))
      | exact congrArg _ (Eq.trans
          (by rw [show b.contentHash = a.contentHash from h.symm]) (TaxDetermination.bodyValue_equiv hb))
      | exact congrArg _ (Eq.trans
          (by rw [show b.contentHash = a.contentHash from h.symm]) (ConsolidationCompilation.bodyValue_equiv hb))
  · exact Or.inr hc

/-! ## `validateAccountingEffectIdentities` -/

/-- Whether the effect at `index` of a batch is flagged, the keys `seen` coming before the batch
and `valid` the answer of each effect's hash check: its identity key is the key of an earlier
effect, or the callback answers `"present"`, or it is scoped to another book, or its hash does not
check. -/
def effectConflictFrom (bookId : BookId) (identity : AccountingEffect → IdentityObservation)
    (valid : AccountingEffect → Bool) (seen : List String) (effects : List AccountingEffect)
    (index : Nat) : Bool :=
  match effects[index]? with
  | none => false
  | some effect =>
    (seen ++ (effects.take index).map AccountingEffect.identityKey).contains effect.identityKey ||
      identity effect == .present || effect.scopedBookId.getD bookId != bookId || !valid effect

/-- The test of line 2244 on one effect, when its hash check answers. -/
theorem effectIdentityFlagged_eq {bookId : BookId} {identity : AccountingEffect → IdentityObservation}
    {seen : List String} {effect : AccountingEffect} {valid : Bool}
    (h : validateAccountingEffectHash effect = .ok valid) :
    effectIdentityFlagged bookId identity seen effect =
      .ok (seen.contains effect.identityKey || identity effect == .present ||
        effect.scopedBookId.getD bookId != bookId || !valid) := by
  unfold effectIdentityFlagged
  cases hs : seen.contains effect.identityKey <;> cases hi : identity effect <;>
    cases hb : (effect.scopedBookId.getD bookId != bookId) <;> simp [hs, hi, hb, h]

/-- The loop of `validateAccountingEffectIdentities`, from any position, when every hash check
answers: one diagnostic for each flagged effect, in the order of the batch. -/
theorem validateAccountingEffectIdentitiesFrom_eq (bookId : BookId)
    (identity : AccountingEffect → IdentityObservation) (valid : AccountingEffect → Bool) :
    ∀ (effects : List AccountingEffect) (start : Nat) (seen : List String),
      (∀ e ∈ effects, validateAccountingEffectHash e = .ok (valid e)) →
      validateAccountingEffectIdentitiesFrom bookId identity start seen effects =
        .ok (((List.range effects.length).filter
          (effectConflictFrom bookId identity valid seen effects)).map
            fun i => effectIdentityDiagnostic (start + i))
  | [], _, _, _ => rfl
  | effect :: rest, start, seen, hvalid => by
    have ih := validateAccountingEffectIdentitiesFrom_eq bookId identity valid rest (start + 1)
      (seen ++ [effect.identityKey]) (fun e he => hvalid e (List.mem_cons_of_mem _ he))
    have hfirst : effectConflictFrom bookId identity valid seen (effect :: rest) 0 =
        (seen.contains effect.identityKey || identity effect == .present ||
          effect.scopedBookId.getD bookId != bookId || !valid effect) := by
      simp [effectConflictFrom]
    have hnext : (fun i => effectConflictFrom bookId identity valid seen (effect :: rest) (i + 1)) =
        effectConflictFrom bookId identity valid (seen ++ [effect.identityKey]) rest := by
      funext i
      simp [effectConflictFrom, List.take_succ_cons]
    simp only [validateAccountingEffectIdentitiesFrom,
      effectIdentityFlagged_eq (hvalid effect (by simp)), ih, List.length_cons,
      List.range_succ_eq_map, List.filter_cons, hfirst, List.filter_map, Function.comp_def,
      hnext, List.map_map]
    have hdiag : (fun i => effectIdentityDiagnostic (start + (i + 1))) =
        fun i => effectIdentityDiagnostic (start + 1 + i) := by
      funext i
      rw [Nat.add_assoc, Nat.add_comm i 1]
    split <;> simp [Function.comp_def, hdiag]

/-- `validateAccountingEffectIdentities`, when every hash check answers: the diagnostic of each
position whose effect is flagged (`effectConflictFrom` with nothing seen before the batch), in the
order of the batch, and nothing else. -/
theorem validateAccountingEffectIdentities_eq {effects : List AccountingEffect} {bookId : BookId}
    {identity : AccountingEffect → IdentityObservation} (valid : AccountingEffect → Bool)
    (hvalid : ∀ e ∈ effects, validateAccountingEffectHash e = .ok (valid e)) :
    validateAccountingEffectIdentities effects bookId identity =
      .ok (((List.range effects.length).filter
        (effectConflictFrom bookId identity valid [] effects)).map effectIdentityDiagnostic) := by
  unfold validateAccountingEffectIdentities
  rw [validateAccountingEffectIdentitiesFrom_eq bookId identity valid effects 0 [] hvalid]
  simp

/-- A position is reported exactly when it is in the batch and its effect is flagged. -/
theorem mem_effectConflicts_iff {bookId : BookId} {identity : AccountingEffect → IdentityObservation}
    {valid : AccountingEffect → Bool} {effects : List AccountingEffect} (index : Nat) :
    index ∈ (List.range effects.length).filter
        (effectConflictFrom bookId identity valid [] effects) ↔
      ∃ effect, effects[index]? = some effect ∧
        (effect.identityKey ∈ (effects.take index).map AccountingEffect.identityKey ∨
          identity effect = .present ∨ effect.scopedBookId.getD bookId ≠ bookId ∨
          valid effect = false) := by
  simp only [List.mem_filter, List.mem_range]
  constructor
  · rintro ⟨hlt, hc⟩
    unfold effectConflictFrom at hc
    split at hc
    · simp at hc
    · rename_i effect heffect
      refine ⟨effect, heffect, ?_⟩
      simpa [or_assoc] using hc
  · rintro ⟨effect, heffect, hc⟩
    refine ⟨(List.getElem?_eq_some_iff.mp heffect).1, ?_⟩
    unfold effectConflictFrom
    rw [heffect]
    simpa [or_assoc] using hc

/-- The test of one effect throws only what its hash check throws. -/
theorem effectIdentityFlagged_error {bookId : BookId}
    {identity : AccountingEffect → IdentityObservation} {seen : List String}
    {effect : AccountingEffect} {err : QuantizeErr}
    (h : effectIdentityFlagged bookId identity seen effect = .error err) :
    validateAccountingEffectHash effect = .error err := by
  unfold effectIdentityFlagged at h
  rcases hv : validateAccountingEffectHash effect with e' | v
  · rw [hv] at h
    by_cases hc : ((if seen.contains effect.identityKey = true then IdentityObservation.present
        else identity effect) == .present ||
        effect.scopedBookId.getD bookId != bookId) = true
    · simp only [hc, ↓reduceIte] at h
      cases h
    · simp only [hc, Bool.false_eq_true, ↓reduceIte] at h
      cases h
      rfl
  · rw [hv] at h
    by_cases hc : ((if seen.contains effect.identityKey = true then IdentityObservation.present
        else identity effect) == .present ||
        effect.scopedBookId.getD bookId != bookId) = true
    · simp only [hc, ↓reduceIte] at h
      cases h
    · simp only [hc, Bool.false_eq_true, ↓reduceIte] at h
      cases h

/-- `validateAccountingEffectIdentities` throws only what the hash check of one of the effects
throws. -/
theorem validateAccountingEffectIdentitiesFrom_error {bookId : BookId}
    {identity : AccountingEffect → IdentityObservation} :
    ∀ {effects : List AccountingEffect} {start : Nat} {seen : List String} {err : QuantizeErr},
      validateAccountingEffectIdentitiesFrom bookId identity start seen effects = .error err →
      ∃ e ∈ effects, validateAccountingEffectHash e = .error err
  | [], _, _, _, h => by cases h
  | effect :: rest, start, seen, err, h => by
    unfold validateAccountingEffectIdentitiesFrom at h
    rcases hf : effectIdentityFlagged bookId identity seen effect with e | flagged
    · rw [hf] at h
      cases h
      exact ⟨effect, by simp, effectIdentityFlagged_error hf⟩
    · rw [hf] at h
      rcases hr : validateAccountingEffectIdentitiesFrom bookId identity (start + 1)
        (seen ++ [effect.identityKey]) rest with e | ds
      · rw [hr] at h
        cases h
        obtain ⟨e, he, hv⟩ := validateAccountingEffectIdentitiesFrom_error hr
        exact ⟨e, List.mem_cons_of_mem _ he, hv⟩
      · rw [hr] at h
        cases h

/-- `validateAccountingEffectIdentities` throws only what the hash check of one of the effects
throws; so it never throws for a batch with no allocation schedule. -/
theorem validateAccountingEffectIdentities_error {effects : List AccountingEffect}
    {bookId : BookId} {identity : AccountingEffect → IdentityObservation} {err : QuantizeErr}
    (h : validateAccountingEffectIdentities effects bookId identity = .error err) :
    ∃ schedule, .allocationSchedule schedule ∈ effects ∧
      allocationPlanIsValid schedule = .error err := by
  obtain ⟨e, he, hv⟩ := validateAccountingEffectIdentitiesFrom_error h
  obtain ⟨schedule, rfl, hp⟩ := (validateAccountingEffectHash_error_iff e err).mp hv
  exact ⟨schedule, he, hp⟩

/-- The result depends on the identity callback only through its answers on the batch's
effects. -/
theorem validateAccountingEffectIdentitiesFrom_congr {bookId : BookId}
    {identity₁ identity₂ : AccountingEffect → IdentityObservation} :
    ∀ {effects : List AccountingEffect} {start : Nat} {seen : List String},
      (∀ e ∈ effects, identity₁ e = identity₂ e) →
      validateAccountingEffectIdentitiesFrom bookId identity₁ start seen effects =
        validateAccountingEffectIdentitiesFrom bookId identity₂ start seen effects
  | [], _, _, _ => rfl
  | effect :: rest, start, seen, h => by
    have hflag : effectIdentityFlagged bookId identity₁ seen effect =
        effectIdentityFlagged bookId identity₂ seen effect := by
      simp only [effectIdentityFlagged, h effect (by simp)]
    simp only [validateAccountingEffectIdentitiesFrom, hflag,
      validateAccountingEffectIdentitiesFrom_congr (fun e he => h e (List.mem_cons_of_mem _ he))]

/-- The key of the set `identities` determines the type and the identifier: the type is one of
thirteen literals with no colon. -/
theorem AccountingEffect.identityKey_eq_iff (e f : AccountingEffect) :
    e.identityKey = f.identityKey ↔ e.type = f.type ∧ e.id = f.id := by
  have nocolon : ∀ g : AccountingEffect, ':' ∉ g.type.toList := by
    intro g
    cases g <;> simp only [AccountingEffect.type] <;> decide
  have split : ∀ (a b x y : List Char), ':' ∉ a → ':' ∉ b →
      a ++ ':' :: x = b ++ ':' :: y → a = b ∧ x = y := by
    intro a
    induction a with
    | nil =>
      intro b x y _ hb h
      cases b with
      | nil => simpa using h
      | cons c b =>
        simp only [List.nil_append, List.cons_append, List.cons.injEq] at h
        exact absurd (h.1 ▸ List.mem_cons_self) hb
    | cons c a ih =>
      intro b x y ha hb h
      cases b with
      | nil =>
        simp only [List.nil_append, List.cons_append, List.cons.injEq] at h
        exact absurd (h.1.symm ▸ List.mem_cons_self) ha
      | cons d b =>
        simp only [List.cons_append, List.cons.injEq] at h
        obtain ⟨hcd, hrest⟩ := h
        have := ih b x y (fun hm => ha (List.mem_cons_of_mem _ hm))
          (fun hm => hb (List.mem_cons_of_mem _ hm)) hrest
        exact ⟨by rw [hcd, this.1], this.2⟩
  unfold AccountingEffect.identityKey
  constructor
  · intro h
    have hl := congrArg String.toList h
    simp only [String.toList_append] at hl
    have hl' : e.type.toList ++ ':' :: e.id.toList = f.type.toList ++ ':' :: f.id.toList := by
      simpa using hl
    obtain ⟨ht, hi⟩ := split _ _ _ _ (nocolon e) (nocolon f) hl'
    exact ⟨String.toList_inj.mp ht, String.toList_inj.mp hi⟩
  · rintro ⟨ht, hi⟩
    rw [ht, hi]

/-! ## `validateAccountingEffectAdmission` -/

/-- `validateAccountingEffectAdmission`, when every hash check answers: the identities check with
"present" exactly for the effects the state already holds. -/
theorem validateAccountingEffectAdmission_eq {state : AccountingCanonicalState}
    {effects : List AccountingEffect} {bookId : BookId} (valid : AccountingEffect → Bool)
    (hvalid : ∀ e ∈ effects, validateAccountingEffectHash e = .ok (valid e)) :
    validateAccountingEffectAdmission state effects bookId =
      .ok (((List.range effects.length).filter
        (effectConflictFrom bookId
          (fun effect => if accountingEffectExists state effect then .present else .absent)
          valid [] effects)).map effectIdentityDiagnostic) :=
  validateAccountingEffectIdentities_eq valid hvalid

/-- An effect the state already holds is rejected when it is admitted alone, whatever its hash:
the hash is not checked. -/
theorem validateAccountingEffectAdmission_of_exists {state : AccountingCanonicalState}
    {effect : AccountingEffect} (h : accountingEffectExists state effect = true) (bookId : BookId) :
    validateAccountingEffectAdmission state [effect] bookId = .ok [effectIdentityDiagnostic 0] := by
  simp [validateAccountingEffectAdmission, validateAccountingEffectIdentities,
    validateAccountingEffectIdentitiesFrom, effectIdentityFlagged, h]

/-- An effect that has been applied is rejected when it is admitted again. -/
theorem validateAccountingEffectAdmission_apply_self (state : AccountingCanonicalState)
    (effect : AccountingEffect) (bookId : BookId) :
    validateAccountingEffectAdmission (applyAccountingEffect state effect) [effect] bookId =
      .ok [effectIdentityDiagnostic 0] :=
  validateAccountingEffectAdmission_of_exists (accountingEffectExists_apply_self state effect) bookId

/-- An effect rejected as present stays rejected after any effect is applied. -/
theorem validateAccountingEffectAdmission_apply_of_exists {state : AccountingCanonicalState}
    {kind : AccountingEffect} (h : accountingEffectExists state kind = true)
    (effect : AccountingEffect) (bookId : BookId) :
    validateAccountingEffectAdmission (applyAccountingEffect state effect) [kind] bookId =
      .ok [effectIdentityDiagnostic 0] :=
  validateAccountingEffectAdmission_of_exists (accountingEffectExists_apply_of_exists h effect)
    bookId

end Rastrata.Kernel

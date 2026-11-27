/-
The laws of `accountingStateHashesAreValid` and `canonicalPostingSourceKey`
(`packages/kernel/src/accounting.ts` lines 1367 to 1386).
-/
import Rastrata.Kernel.Accounting.Basis.Model

namespace Rastrata.Kernel

/-! ## `accountingStateHashesAreValid`: exactly when it is true, false, or throws -/

/-- The loops over the effects answer `true` exactly when every effect's hash checks. -/
theorem effectHashesAreValid_true_iff :
    ∀ effects : List AccountingEffect,
      effectHashesAreValid effects = .ok true ↔
        ∀ effect ∈ effects, validateAccountingEffectHash effect = .ok true
  | [] => by simp [effectHashesAreValid]
  | effect :: rest => by
    have ih := effectHashesAreValid_true_iff rest
    simp only [effectHashesAreValid, List.mem_cons, forall_eq_or_imp]
    cases h : validateAccountingEffectHash effect with
    | error e => simp
    | ok b => cases b <;> simp [ih]

/-- The loops answer `false` exactly at the first effect whose hash does not check, when no earlier
effect throws and none fails first. -/
theorem effectHashesAreValid_false_iff :
    ∀ effects : List AccountingEffect,
      effectHashesAreValid effects = .ok false ↔
        ∃ pre effect suf, effects = pre ++ effect :: suf ∧
          (∀ earlier ∈ pre, validateAccountingEffectHash earlier = .ok true) ∧
          validateAccountingEffectHash effect = .ok false
  | [] => by simp [effectHashesAreValid]
  | effect :: rest => by
    have ih := effectHashesAreValid_false_iff rest
    constructor
    · intro h
      simp only [effectHashesAreValid] at h
      cases hv : validateAccountingEffectHash effect with
      | error e => simp [hv] at h
      | ok b =>
        cases b with
        | false => exact ⟨[], effect, rest, rfl, by simp, hv⟩
        | true =>
          simp only [hv] at h
          obtain ⟨pre, e, suf, hsplit, hpre, he⟩ := ih.mp h
          exact ⟨effect :: pre, e, suf, by simp [hsplit], fun a ha => by
            rcases List.mem_cons.mp ha with rfl | ha
            · exact hv
            · exact hpre a ha, he⟩
    · rintro ⟨pre, e, suf, hsplit, hpre, he⟩
      cases pre with
      | nil =>
        simp only [List.nil_append, List.cons.injEq] at hsplit
        obtain ⟨rfl, -⟩ := hsplit
        simp [effectHashesAreValid, he]
      | cons first pre' =>
        simp only [List.cons_append, List.cons.injEq] at hsplit
        obtain ⟨rfl, hrest⟩ := hsplit
        have hfirst := hpre effect (by simp)
        simp only [effectHashesAreValid, hfirst]
        exact ih.mpr ⟨pre', e, suf, hrest, fun earlier h => hpre earlier (by simp [h]), he⟩

/-- The loops throw exactly at the first effect that throws, when none before it fails or throws. -/
theorem effectHashesAreValid_error_iff (code : QuantizeErr) :
    ∀ effects : List AccountingEffect,
      effectHashesAreValid effects = .error code ↔
        ∃ pre effect suf, effects = pre ++ effect :: suf ∧
          (∀ earlier ∈ pre, validateAccountingEffectHash earlier = .ok true) ∧
          validateAccountingEffectHash effect = .error code
  | [] => by simp [effectHashesAreValid]
  | effect :: rest => by
    have ih := effectHashesAreValid_error_iff code rest
    constructor
    · intro h
      simp only [effectHashesAreValid] at h
      cases hv : validateAccountingEffectHash effect with
      | error e =>
        simp only [hv, Except.error.injEq] at h
        subst h
        exact ⟨[], effect, rest, rfl, by simp, hv⟩
      | ok b =>
        cases b with
        | false => simp [hv] at h
        | true =>
          simp only [hv] at h
          obtain ⟨pre, e, suf, hsplit, hpre, he⟩ := ih.mp h
          exact ⟨effect :: pre, e, suf, by simp [hsplit], fun a ha => by
            rcases List.mem_cons.mp ha with rfl | ha
            · exact hv
            · exact hpre a ha, he⟩
    · rintro ⟨pre, e, suf, hsplit, hpre, he⟩
      cases pre with
      | nil =>
        simp only [List.nil_append, List.cons.injEq] at hsplit
        obtain ⟨rfl, -⟩ := hsplit
        simp [effectHashesAreValid, he]
      | cons first pre' =>
        simp only [List.cons_append, List.cons.injEq] at hsplit
        obtain ⟨rfl, hrest⟩ := hsplit
        have hfirst := hpre effect (by simp)
        simp only [effectHashesAreValid, hfirst]
        exact ih.mpr ⟨pre', e, suf, hrest, fun earlier h => hpre earlier (by simp [h]), he⟩

/-- The loops throw only for an effect that throws: if none of the effects does, they answer. -/
theorem effectHashesAreValid_isOk :
    ∀ effects : List AccountingEffect,
      (∀ effect ∈ effects, ∃ b, validateAccountingEffectHash effect = .ok b) →
        ∃ b, effectHashesAreValid effects = .ok b
  | [], _ => ⟨true, rfl⟩
  | effect :: rest, h => by
    obtain ⟨b, hb⟩ := h effect (by simp)
    have ih := effectHashesAreValid_isOk rest fun e he => h e (by simp [he])
    cases b with
    | false => exact ⟨false, by simp [effectHashesAreValid, hb]⟩
    | true => simpa [effectHashesAreValid, hb] using ih

/-- Only an allocation schedule can make `validateAccountingEffectHash` throw (its plan is
recomputed with `planAllocationPostings`); every other effect is answered with a Boolean. -/
theorem validateAccountingEffectHash_isOk_of_not_schedule (effect : AccountingEffect)
    (h : ∀ schedule, effect ≠ .allocationSchedule schedule) :
    ∃ b, validateAccountingEffectHash effect = .ok b := by
  cases effect with
  | allocationSchedule schedule => exact absurd rfl (h schedule)
  | allocationScheduleRevision revision =>
    unfold validateAccountingEffectHash
    simp only
    split <;> simp
  | _ =>
    unfold validateAccountingEffectHash
    simp

/-- `accountingStateHashesAreValid` is `true` exactly when the hash of every value of the thirteen
collections of the state checks: a provisional inventory layer, a recosting, a value adjustment, an
open item, a settlement, a settlement allocation, a remeasurement result and reversal, an allocation
schedule, recognition and revision, a tax determination and a consolidation compilation. -/
theorem accountingStateHashesAreValid_true_iff (state : AccountingCanonicalState) :
    accountingStateHashesAreValid state = .ok true ↔
      (∀ v ∈ state.provisionalInventoryLayers,
        validateAccountingEffectHash (.provisionalInventoryLayer v) = .ok true) ∧
      (∀ v ∈ state.inventoryRecostings,
        validateAccountingEffectHash (.inventoryRecosting v) = .ok true) ∧
      (∀ v ∈ state.inventoryValueAdjustments,
        validateAccountingEffectHash (.inventoryValueAdjustment v) = .ok true) ∧
      (∀ v ∈ state.openItems, validateAccountingEffectHash (.openItem v) = .ok true) ∧
      (∀ v ∈ state.settlements, validateAccountingEffectHash (.settlement v) = .ok true) ∧
      (∀ v ∈ state.settlementAllocations,
        validateAccountingEffectHash (.settlementAllocation v) = .ok true) ∧
      (∀ v ∈ state.remeasurementResults,
        validateAccountingEffectHash (.remeasurementResult v) = .ok true) ∧
      (∀ v ∈ state.remeasurementReversals,
        validateAccountingEffectHash (.remeasurementReversal v) = .ok true) ∧
      (∀ v ∈ state.allocationSchedules,
        validateAccountingEffectHash (.allocationSchedule v) = .ok true) ∧
      (∀ v ∈ state.allocationRecognitions,
        validateAccountingEffectHash (.allocationRecognition v) = .ok true) ∧
      (∀ v ∈ state.allocationScheduleRevisions,
        validateAccountingEffectHash (.allocationScheduleRevision v) = .ok true) ∧
      (∀ v ∈ state.taxDeterminations,
        validateAccountingEffectHash (.taxDetermination v) = .ok true) ∧
      (∀ v ∈ state.consolidationCompilations,
        validateAccountingEffectHash (.consolidationCompilation v) = .ok true) := by
  unfold accountingStateHashesAreValid
  rw [effectHashesAreValid_true_iff]
  simp only [accountingStateEffects, List.forall_mem_append, List.forall_mem_map, and_assoc]

/-- `accountingStateHashesAreValid` is `false` exactly at the first effect, in the order of the
thirteen loops, whose hash does not check, when none before it fails or throws. -/
theorem accountingStateHashesAreValid_false_iff (state : AccountingCanonicalState) :
    accountingStateHashesAreValid state = .ok false ↔
      ∃ pre effect suf, accountingStateEffects state = pre ++ effect :: suf ∧
        (∀ earlier ∈ pre, validateAccountingEffectHash earlier = .ok true) ∧
        validateAccountingEffectHash effect = .ok false :=
  effectHashesAreValid_false_iff _

/-- `accountingStateHashesAreValid` throws exactly at the first effect that throws, when none
before it fails or throws. -/
theorem accountingStateHashesAreValid_error_iff (state : AccountingCanonicalState)
    (code : QuantizeErr) :
    accountingStateHashesAreValid state = .error code ↔
      ∃ pre effect suf, accountingStateEffects state = pre ++ effect :: suf ∧
        (∀ earlier ∈ pre, validateAccountingEffectHash earlier = .ok true) ∧
        validateAccountingEffectHash effect = .error code :=
  effectHashesAreValid_error_iff code _

/-- A state with no allocation schedule is always answered: only a schedule can throw. -/
theorem accountingStateHashesAreValid_isOk_of_no_schedules (state : AccountingCanonicalState)
    (h : state.allocationSchedules = []) : ∃ b, accountingStateHashesAreValid state = .ok b := by
  apply effectHashesAreValid_isOk
  intro effect hmem
  apply validateAccountingEffectHash_isOk_of_not_schedule
  intro schedule heq
  subst heq
  simp [accountingStateEffects, h] at hmem

/-- The empty state has valid hashes. -/
theorem accountingStateHashesAreValid_empty :
    accountingStateHashesAreValid emptyAccountingCanonicalState = .ok true := by
  simp [accountingStateHashesAreValid, accountingStateEffects, emptyAccountingCanonicalState,
    effectHashesAreValid]

/-! ## `canonicalPostingSourceKey` -/

/-- Two lists split at the first occurrence of a character that neither first part holds agree on
both sides of it. -/
theorem append_cons_inj {c : Char} :
    ∀ {x x' y y' : List Char}, c ∉ x → c ∉ x' → x ++ c :: y = x' ++ c :: y' → x = x' ∧ y = y'
  | [], [], y, y', _, _, h => by simpa using h
  | [], a :: x', y, y', _, hx', h => by
    simp only [List.nil_append, List.cons_append, List.cons.injEq] at h
    exact absurd (by simp [h.1]) hx'
  | a :: x, [], y, y', hx, _, h => by
    simp only [List.nil_append, List.cons_append, List.cons.injEq] at h
    exact absurd (by simp [← h.1]) hx
  | a :: x, b :: x', y, y', hx, hx', h => by
    simp only [List.cons_append, List.cons.injEq] at h
    have ih := append_cons_inj (fun hm => hx (List.mem_cons_of_mem a hm))
      (fun hm => hx' (List.mem_cons_of_mem b hm)) h.2
    exact ⟨by rw [h.1, ih.1], ih.2⟩

/-- The same, from the last occurrence: the second parts hold no such character. -/
theorem append_cons_inj_last {c : Char} {x x' y y' : List Char} (hy : c ∉ y) (hy' : c ∉ y')
    (h : x ++ c :: y = x' ++ c :: y') : x = x' ∧ y = y' := by
  have h' : y.reverse ++ c :: x.reverse = y'.reverse ++ c :: x'.reverse := by
    have := congrArg List.reverse h
    simpa using this
  have := append_cons_inj (by simpa using hy) (by simpa using hy') h'
  exact ⟨by simpa using congrArg List.reverse this.2, by simpa using congrArg List.reverse this.1⟩

/-- The characters of a valid identifier hold no NUL. -/
theorem Identifier.WF.not_nul {Kind : String} {id : Identifier Kind} (h : id.WF) :
    '\x00' ∉ id.value.toList := by
  intro hm
  have := h.no_control_chars '\x00' hm
  revert this
  decide

/-- Two identifiers with the same characters are the same. -/
theorem identifier_eq_of_toList {Kind : String} {x y : Identifier Kind}
    (h : x.value.toList = y.value.toList) : x = y := by
  cases x
  cases y
  simp only [String.toList_inj] at h
  subst h
  rfl

/-- Two effect keys with the same characters are the same. -/
theorem effectKey_eq_of_toList {x y : EffectKey} (h : x.value.toList = y.value.toList) :
    x = y := by
  cases x
  cases y
  simp only [String.toList_inj] at h
  subst h
  rfl

/-- The characters of `canonicalPostingSourceKey`: the four parts, a NUL between each two. -/
theorem canonicalPostingSourceKey_toList (source : CanonicalPostingReference) :
    (canonicalPostingSourceKey source).toList =
      source.bookId.value.toList ++ '\x00' :: (source.journalId.value.toList ++ '\x00' ::
        (source.effectKey.value.toList ++ '\x00' :: source.postingId.value.toList)) := by
  simp [canonicalPostingSourceKey, String.toList_append]

/-- The source key names the book, the journal, the effect key and the posting, and nothing else:
two references with valid identifiers have the same key exactly when those four agree. -/
theorem canonicalPostingSourceKey_eq_iff {a b : CanonicalPostingReference} (ha : a.WF)
    (hb : b.WF) :
    canonicalPostingSourceKey a = canonicalPostingSourceKey b ↔
      a.bookId = b.bookId ∧ a.journalId = b.journalId ∧ a.effectKey = b.effectKey ∧
        a.postingId = b.postingId := by
  obtain ⟨-, hab, haj, hap⟩ := ha
  obtain ⟨-, hbb, hbj, hbp⟩ := hb
  constructor
  · intro h
    have h := congrArg String.toList h
    rw [canonicalPostingSourceKey_toList, canonicalPostingSourceKey_toList] at h
    obtain ⟨h1, h2⟩ := append_cons_inj hab.not_nul hbb.not_nul h
    obtain ⟨h3, h4⟩ := append_cons_inj haj.not_nul hbj.not_nul h2
    obtain ⟨h5, h6⟩ := append_cons_inj_last hap.not_nul hbp.not_nul h4
    exact ⟨identifier_eq_of_toList h1, identifier_eq_of_toList h3, effectKey_eq_of_toList h5,
      identifier_eq_of_toList h6⟩
  · rintro ⟨h1, h2, h3, h4⟩
    unfold canonicalPostingSourceKey
    rw [h1, h2, h3, h4]

/-- A reference whose content hash is the hash of its body, with a posting hash of the current
algorithm and canonicalization, is valid. -/
theorem validateCanonicalPostingReferenceHash_of_body (body : CanonicalPostingReferenceBody)
    (h1 : body.postingContentHash.algorithm = contentHashAlgorithm)
    (h2 : body.postingContentHash.canonicalizationVersion = canonicalizationVersion) :
    validateCanonicalPostingReferenceHash
      { toCanonicalPostingReferenceBody := body,
        contentHash := hashCanonical (canonicalPostingReferenceBody body) } = true := by
  simp [validateCanonicalPostingReferenceHash, h1, h2, hashCanonical,
    (contentHashEquals_iff _ _).mpr rfl]

/-- A valid reference carries the hash of its own body. -/
theorem CanonicalPostingReference.contentHash_eq_of_valid {a : CanonicalPostingReference}
    (h : validateCanonicalPostingReferenceHash a = true) :
    a.contentHash = hashCanonical (canonicalPostingReferenceBody a.toCanonicalPostingReferenceBody) := by
  simp only [validateCanonicalPostingReferenceHash, Bool.and_eq_true] at h
  exact (contentHashEquals_iff _ _).mp h.2

/-- Two valid references with valid identifiers that have the same source key, the same identifier
and the same posting hash are the same reference: the key covers the book, the journal, the effect
key and the posting; the identifier and the posting hash are what it leaves out. -/
theorem canonicalPostingSourceKey_inj_of_valid {a b : CanonicalPostingReference} (ha : a.WF)
    (hb : b.WF) (hva : validateCanonicalPostingReferenceHash a = true)
    (hvb : validateCanonicalPostingReferenceHash b = true)
    (hkey : canonicalPostingSourceKey a = canonicalPostingSourceKey b) (hid : a.id = b.id)
    (hhash : a.postingContentHash = b.postingContentHash) : a = b := by
  obtain ⟨hbook, hjournal, heffect, hposting⟩ := (canonicalPostingSourceKey_eq_iff ha hb).mp hkey
  have hbody : a.toCanonicalPostingReferenceBody = b.toCanonicalPostingReferenceBody := by
    cases a
    cases b
    rename_i bodyA hashA bodyB hashB
    cases bodyA
    cases bodyB
    simp_all
  have hc : a.contentHash = b.contentHash := by
    rw [CanonicalPostingReference.contentHash_eq_of_valid hva,
      CanonicalPostingReference.contentHash_eq_of_valid hvb, hbody]
  cases a
  cases b
  simp_all

/-- The identifier `a` is valid. -/
theorem identifier_wf_a (Kind : String) : (⟨"a"⟩ : Identifier Kind).WF :=
  ⟨show "a" ≠ "" by decide, show jsTrim "a" = "a" by decide,
    show isNFC "a" = true from ascii_isNFC "a" (by intro c hc; simp at hc; subst hc; decide),
    show ∀ c ∈ "a".toList, isControlChar c = false by intro c hc; simp at hc; subst hc; decide⟩

/-- The identifier `b` is valid. -/
theorem identifier_wf_b (Kind : String) : (⟨"b"⟩ : Identifier Kind).WF :=
  ⟨show "b" ≠ "" by decide, show jsTrim "b" = "b" by decide,
    show isNFC "b" = true from ascii_isNFC "b" (by intro c hc; simp at hc; subst hc; decide),
    show ∀ c ∈ "b".toList, isControlChar c = false by intro c hc; simp at hc; subst hc; decide⟩

/-- A reference with the book, journal, posting and effect key `a`, a posting hash of `null`, the
given identifier, and the hash of its body. -/
def sampleReference (id : String) : CanonicalPostingReference :=
  let body : CanonicalPostingReferenceBody :=
    { id := ⟨id⟩, bookId := ⟨"a"⟩, journalId := ⟨"a"⟩, postingId := ⟨"a"⟩, effectKey := ⟨"a"⟩,
      postingContentHash := hashCanonical .null }
  { toCanonicalPostingReferenceBody := body,
    contentHash := hashCanonical (canonicalPostingReferenceBody body) }

/-- The source key is not injective on valid references: the identifier and the posting hash are
not in it. Two references with the same book, journal, effect key and posting, that differ in their
identifier, are both valid. -/
theorem canonicalPostingSourceKey_not_injective :
    ∃ a b : CanonicalPostingReference, a.WF ∧ b.WF ∧
      validateCanonicalPostingReferenceHash a = true ∧
      validateCanonicalPostingReferenceHash b = true ∧
      canonicalPostingSourceKey a = canonicalPostingSourceKey b ∧ a ≠ b := by
  refine ⟨sampleReference "a", sampleReference "b",
    ⟨identifier_wf_a _, identifier_wf_a _, identifier_wf_a _, identifier_wf_a _⟩,
    ⟨identifier_wf_b _, identifier_wf_a _, identifier_wf_a _, identifier_wf_a _⟩,
    validateCanonicalPostingReferenceHash_of_body _ rfl rfl,
    validateCanonicalPostingReferenceHash_of_body _ rfl rfl, rfl, ?_⟩
  intro h
  have := congrArg (fun r : CanonicalPostingReference => r.id.value) h
  exact absurd this (by decide)

end Rastrata.Kernel

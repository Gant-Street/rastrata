/-
What `projectAccountingBasis` can throw. Over constructible input every exact-number step throws the
size limit and nothing else, and `quantize` throws its `RangeError` for a scale outside 0 to 1,000;
the checks of the snapshot throw only through an allocation schedule whose plan check throws.
-/
import Rastrata.Kernel.Accounting.Basis.Laws11
import Rastrata.Kernel.Accounting.Core.Effects

namespace Rastrata.Kernel

/-! ## What the projection can throw -/

/-- A step that succeeds or is refused for size, lifted, throws only for size. -/
theorem liftExact_error_limit {α : Type} {result : Except NumErr α} {e : QuantizeErr}
    (hr : (∃ c, result = .ok c) ∨ result = .error .representationLimitExceeded)
    (h : liftExact result = .error e) : e = .exactNumber .representationLimitExceeded := by
  rcases hr with ⟨c, hc⟩ | hl
  · rw [hc] at h
    cases h
  · rw [hl] at h
    cases h
    rfl

/-- Adding to the totals throws only for size, over constructible values. -/
theorem addBasisTotals_error {totals : BasisTotals} {amount included excluded : ExactRational}
    {recognized : Option QuantizedValue} {e : QuantizeErr} (ht : totals.WF) (ha : amount.WF)
    (hi : included.WF) (he : excluded.WF) (hq : ∀ value, recognized = some value → value.WF)
    (h : addBasisTotals totals amount included excluded recognized = .error e) :
    e = .exactNumber .representationLimitExceeded := by
  cases recognized with
  | none =>
    unfold addBasisTotals at h
    split at h
    · rename_i e' hs
      cases h
      exact liftExact_error_limit (ExactRational.add_ok_or_limit ht.source ha) hs
    · rename_i source hs
      obtain ⟨hsw, -⟩ := ExactRational.add_ok ht.source ha (liftExact_eq_ok' hs)
      split at h
      · rename_i e' hi'
        cases h
        exact liftExact_error_limit (ExactRational.add_ok_or_limit ht.included hi) hi'
      · rename_i includedTotal hi'
        obtain ⟨hiw, -⟩ := ExactRational.add_ok ht.included hi (liftExact_eq_ok' hi')
        split at h
        · rename_i e' he'
          cases h
          exact liftExact_error_limit (ExactRational.add_ok_or_limit ht.excluded he) he'
        · cases h
  | some value =>
    have hvq := hq value rfl
    unfold addBasisTotals at h
    split at h
    · rename_i e' hs
      cases h
      exact liftExact_error_limit (ExactRational.add_ok_or_limit ht.source ha) hs
    · rename_i source hs
      split at h
      · rename_i e' hi'
        cases h
        exact liftExact_error_limit (ExactRational.add_ok_or_limit ht.included hi) hi'
      · rename_i includedTotal hi'
        split at h
        · rename_i e' he'
          cases h
          exact liftExact_error_limit (ExactRational.add_ok_or_limit ht.excluded he) he'
        · rename_i excludedTotal he'
          dsimp only at h
          split at h
          · rename_i e' hva
            cases h
            exact liftExact_error_limit
              (Or.inl (ExactDecimal.toRational_isOk hvq.amount |>.imp fun r hr => hr.1)) hva
          · rename_i valueAmount hva
            obtain ⟨hvaw, -⟩ := ExactDecimal.toRational_ok hvq.amount (liftExact_eq_ok' hva)
            split at h
            · rename_i e' hb
              cases h
              exact liftExact_error_limit (ExactRational.add_ok_or_limit ht.projectedBookValue hvaw) hb
            · rename_i bookedTotal hb
              split at h
              · rename_i e' hr
                cases h
                exact liftExact_error_limit
                  (ExactRational.add_ok_or_limit ht.residual hvq.residual) hr
              · cases h


/-- The errors the steps of the projection can throw over constructible input: the size limit, or the
`RangeError` of `quantize` for a scale of the policy's rule outside 0 to 1,000. -/
def BasisThrows (policy : AccountingBasisPolicy) (e : QuantizeErr) : Prop :=
  e = .exactNumber .representationLimitExceeded ∨
    (e = .scaleOutOfRange ∧ (policy.quantizationPolicy.targetScale < 0 ∨
      policy.quantizationPolicy.targetScale > maxDecimalScale))

/-- The included amount throws only for size. -/
theorem includedExactAmountOf_error {treatment : AccountingBasisTreatment}
    {ratio amount : ExactRational} {e : QuantizeErr} (hr : ratio.WF) (ha : amount.WF)
    (h : includedExactAmountOf treatment ratio amount = .error e) :
    e = .exactNumber .representationLimitExceeded := by
  unfold includedExactAmountOf at h
  cases treatment with
  | allocateBySettlementRatio =>
    exact liftExact_error_limit (ExactRational.multiply_ok_or_limit ha hr) h
  | exclude => cases h
  | recognizeAtAccountingDate => cases h
  | recognizeAtSettlement => cases h
  | carryThrough => cases h

/-- The recognized amount throws the size limit, or the range error of a scale outside 0 to 1,000. -/
theorem recognizedAmountOf_error {policy : AccountingBasisPolicy}
    {treatment : AccountingBasisTreatment} {included : ExactRational} {e : QuantizeErr}
    (hi : included.WF) (h : recognizedAmountOf policy treatment included = .error e) :
    BasisThrows policy e := by
  have key : quantize included policy.quantizationPolicy.rule = .error e → BasisThrows policy e := by
    intro hq
    by_cases hs : policy.quantizationPolicy.targetScale < 0 ∨
        policy.quantizationPolicy.targetScale > maxDecimalScale
    · have : quantize included policy.quantizationPolicy.rule = .error .scaleOutOfRange := by
        simp [quantize, QuantizationPolicy.rule, hs]
      rw [this] at hq
      cases hq
      exact Or.inr ⟨rfl, hs⟩
    · have h0 : 0 ≤ policy.quantizationPolicy.rule.targetScale := by
        have := hs; simp only [QuantizationPolicy.rule, not_or, not_lt] at this ⊢; exact this.1
      have h1 : policy.quantizationPolicy.rule.targetScale ≤ maxDecimalScale := by
        have := hs; simp only [QuantizationPolicy.rule, not_or, not_lt] at this ⊢; exact this.2
      exact Or.inl (quantize_error hi h0 h1 hq)
  cases treatment <;> simp only [recognizedAmountOf] at h <;>
  first
  | (cases h)
  | (rcases hq : quantize included policy.quantizationPolicy.rule with e' | value
     · simp only [hq, Except.error.injEq] at h
       subst h
       exact key hq
     · simp [hq] at h)


/-- One entry throws only the size limit, or the range error of a scale outside 0 to 1,000, over a
constructible posting amount, settlement ratio and totals. -/
theorem basisEntryOf_error {policy : AccountingBasisPolicy} {event : BasisSourceEvent}
    {treatment : AccountingBasisTreatment} {ratio : ExactRational} {count : Nat}
    {totals : BasisTotals} {e : QuantizeErr} (hev : event.sourcePosting.bookValue.amount.WF)
    (hr : ratio.WF) (ht : totals.WF)
    (h : basisEntryOf policy event treatment ratio count totals = .error e) :
    BasisThrows policy e := by
  unfold basisEntryOf at h
  split at h
  · rename_i e' hamount
    cases h
    exact Or.inl (liftExact_error_limit (Or.inl (ExactDecimal.toRational_isOk hev |>.imp
      fun r hr => hr.1)) hamount)
  · rename_i amount hamount
    obtain ⟨haw, -⟩ := ExactDecimal.toRational_ok hev (liftExact_eq_ok' hamount)
    split at h
    · rename_i e' hincl
      cases h
      exact Or.inl (includedExactAmountOf_error hr haw hincl)
    · rename_i included hincl
      obtain ⟨hiw, -⟩ := includedExactAmountOf_spec hr haw hincl
      split at h
      · rename_i e' hexcl
        cases h
        exact Or.inl (liftExact_error_limit (ExactRational.subtract_ok_or_limit haw hiw) hexcl)
      · rename_i excluded hexcl
        obtain ⟨hew, -⟩ := ExactRational.subtract_ok haw hiw (liftExact_eq_ok' hexcl)
        split at h
        · rename_i e' hrec
          cases h
          exact recognizedAmountOf_error hiw hrec
        · rename_i recognized hrec
          obtain ⟨hnone, hsome⟩ := recognizedAmountOf_spec hrec
          have hrecWF : ∀ value, recognized = some value → value.WF := by
            intro value hv
            by_cases hx : treatment = .exclude
            · rw [hnone hx] at hv; cases hv
            · obtain ⟨v, hv', hq⟩ := hsome hx
              rw [hv'] at hv
              cases hv
              obtain ⟨hwa, hwr, -⟩ := quantize_ok hiw hq
              exact ⟨hwa, hwr⟩
          split at h
          · rename_i e' hadd
            cases h
            exact Or.inl (addBasisTotals_error ht haw hiw hew hrecWF hadd)
          · cases h


/-- A positive constructible number has a numerator that is not zero. -/
theorem positive_numerator_ne {r : ExactRational} (hr : r.WF) (h : positive r = true) :
    r.numerator ≠ 0 := by
  have := (ExactRational.compare_gt_iff hr ExactRational.zero_wf).mp (by simpa [positive] using h)
  rw [ExactRational.zero_toRat] at this
  intro hn
  simp [ExactRational.toRat, hn] at this

/-- The settlement-ratio step throws only for size, over a constructible state. -/
theorem settlementRatioOf_error {policy : AccountingBasisPolicy}
    {snapshot : AccountingReadSnapshot} {event : BasisSourceEvent} {e : QuantizeErr}
    (hS : snapshot.accountingState.WF)
    (h : settlementRatioOf policy snapshot event = .error e) :
    e = .exactNumber .representationLimitExceeded := by
  unfold settlementRatioOf at h
  dsimp only at h
  generalize hO : basisOpenItem snapshot event = openItem at h
  cases openItem with
  | none => simp at h
  | some item =>
    simp only at h
    split at h
    · cases h
    · rename_i hc
      have hitem : item.WF := hS.openItems item (basisOpenItem_mem hO)
      have hvalues : ∀ value ∈ ratioValues snapshot event, value.WF := by
        intro value hv
        unfold ratioValues at hv
        obtain ⟨allocation, hmem, rfl⟩ := List.mem_map.mp hv
        have hw : allocation.WF := hS.settlementAllocations allocation (basisAllocations_mem hmem)
        cases hopt : allocation.allocatedOpenItemBookValue with
        | none => exact hw.allocatedBookValue
        | some value => exact hw.allocatedOpenItemBookValue value hopt
      have habs := ExactRational.abs_wf (hitem : OpenItemBody.WF _).bookValue
      have hpos : positive item.bookValue.abs = true := by
        simp only [Bool.not_eq_true, Bool.or_eq_false_iff, bne_eq_false_iff_eq,
          Bool.not_eq_false'] at hc
        exact hc.1.1.2
      split at h
      · rename_i e' hs
        cases h
        change liftExact (accountingSum (ratioValues snapshot event)) = _ at hs
        unfold accountingSum at hs
        cases hsum : addExactValues ExactRational.zero (ratioValues snapshot event) with
        | error code =>
          simp only [liftExact, hsum, Except.error.injEq] at hs
          have := addExactValues_error ExactRational.zero_wf hvalues hsum
          rw [← hs, this]
        | ok v => simp [liftExact, hsum] at hs
      · rename_i total hs
        obtain ⟨htw, -⟩ := addExactValues_spec _ ExactRational.zero_wf hvalues (liftExact_eq_ok' hs)
        split at h
        · rename_i e' hd
          cases h
          rcases ExactRational.divide_ok_or_error (b := item.bookValue.abs) htw with
            ⟨c, hc'⟩ | ⟨hz, -⟩ | ⟨-, hl⟩
          · rw [hc'] at hd; cases hd
          · exact absurd hz (positive_numerator_ne habs hpos)
          · rw [hl] at hd; cases hd; rfl
        · split at h <;> cases h


/-- One event's step throws only the size limit, or the range error of a scale outside 0 to 1,000,
over a constructible state, posting amount and totals. -/
theorem processBasisEvent_error {policy : AccountingBasisPolicy}
    {snapshot : AccountingReadSnapshot} {event : BasisSourceEvent} {count : Nat}
    {totals : BasisTotals} {e : QuantizeErr} (hS : snapshot.accountingState.WF)
    (hev : event.sourcePosting.bookValue.amount.WF) (ht : totals.WF)
    (h : processBasisEvent policy snapshot event count totals = .error e) :
    BasisThrows policy e := by
  unfold processBasisEvent at h
  split at h
  · rename_i rule hrule
    split at h
    · rename_i e' hratio
      cases h
      split at hratio
      · exact Or.inl (settlementRatioOf_error hS hratio)
      · cases hratio
    · cases h
    · rename_i ratio hratio
      split at h
      · rename_i e' hentry
        cases h
        have hrw : ratio.WF := by
          by_cases hx : (rule.treatment == .allocateBySettlementRatio) = true
          · simp only [hx, ite_true] at hratio
            obtain ⟨item, hO, -, -, -, hrw, -⟩ := settlementRatioOf_ratio_spec hS hratio
            exact hrw
          · simp only [hx, Bool.false_eq_true, ite_false, Except.ok.injEq,
              SettlementRatioOutcome.ratio.injEq] at hratio
            subst hratio
            exact ExactRational.zero_wf
        exact basisEntryOf_error hev hrw ht hentry
      · cases h
  · cases h

/-- The loop throws only the size limit, or the range error of a scale outside 0 to 1,000, over a
constructible state, events with constructible posting amounts and constructible starting totals. -/
theorem basisLoop_error {policy : AccountingBasisPolicy} {snapshot : AccountingReadSnapshot}
    {e : QuantizeErr} (hS : snapshot.accountingState.WF) :
    ∀ (events : List BasisSourceEvent) (count : Nat) (totals : BasisTotals),
      (∀ event ∈ events, event.sourcePosting.bookValue.amount.WF) → totals.WF →
      basisLoop policy snapshot count totals events = .error e → BasisThrows policy e
  | [], count, totals, _, _, h => by simp [basisLoop] at h
  | event :: rest, count, totals, hev, ht, h => by
    unfold basisLoop at h
    split at h
    · rename_i e' hp
      cases h
      exact processBasisEvent_error hS (hev event (by simp)) ht hp
    · cases h
    · rename_i entry totals' hp
      obtain ⟨rule, hrule, hmeans, hstep, hgraph⟩ :=
        processBasisEvent_spec hS (hev event (by simp)) ht hp
      split at h
      · rename_i e' hl
        cases h
        exact basisLoop_error hS rest (count + 1) totals' (fun x hx => hev x (by simp [hx]))
          hstep.wf hl
      · cases h
      · cases h

/-- The reconciliation throws only for size, over constructible totals. -/
theorem reconciliationFails_error {totals : BasisTotals} {e : QuantizeErr} (hw : totals.WF)
    (h : reconciliationFails totals = .error e) : e = .exactNumber .representationLimitExceeded := by
  unfold reconciliationFails at h
  split at h
  · rename_i e' hsum
    cases h
    exact liftExact_error_limit (ExactRational.add_ok_or_limit hw.included hw.excluded) hsum
  · rename_i sum hsum
    split at h
    · cases h
    · split at h
      · cases h
      · split at h
        · rename_i e' hbooked
          cases h
          exact liftExact_error_limit
            (ExactRational.add_ok_or_limit hw.projectedBookValue hw.residual) hbooked
        · cases h

/-- The checks of the snapshot throw exactly when no check before the state fails and the hashes of
the effects of the state throw. -/
theorem readSnapshotRejects_error_iff (policy : AccountingBasisPolicy)
    (snapshot : AccountingReadSnapshot) (e : QuantizeErr) :
    readSnapshotRejects policy snapshot = .error e ↔
      snapshotFailsBeforeState policy snapshot (sortBookedJournals snapshot.journals) = false ∧
        accountingStateHashesAreValid snapshot.accountingState = .error e := by
  unfold readSnapshotRejects
  cases hf : snapshotFailsBeforeState policy snapshot (sortBookedJournals snapshot.journals) with
  | true => simp
  | false =>
    simp only [Bool.false_eq_true, ite_false, true_and]
    cases hs : accountingStateHashesAreValid snapshot.accountingState with
    | error e' => simp
    | ok b => cases b <;> simp

/-- Over a constructible snapshot, `projectAccountingBasis` throws only when the snapshot's state holds
an allocation schedule whose plan check throws (the checks of the snapshot), or when the loop or the
reconciliation throws the size limit, or the range error of a scale of the policy outside 0 to 1,000. -/
theorem projectAccountingBasis_error_class {policies : List AccountingPolicy}
    {policyIdValue : PolicyId} {version : SemanticVersion} {snapshot : AccountingReadSnapshot}
    {e : QuantizeErr} (hW : snapshot.WF)
    (h : projectAccountingBasis policies policyIdValue version snapshot = .error e) :
    (∃ schedule ∈ snapshot.accountingState.allocationSchedules,
        allocationPlanIsValid schedule = .error e) ∨
      ∃ policy, policyAt AccountingBasisPolicy policies policyIdValue version
          snapshot.policyEffectiveAt = .selected policy ∧ BasisThrows policy e := by
  obtain ⟨policy, ⟨⟨hp, hb, hi⟩, hs⟩ | ⟨⟨⟨⟨hp, hb, hi⟩, hs⟩, hc⟩, hl | ⟨entries, totals, hl, hr⟩⟩⟩ :=
    (projectAccountingBasis_error_iff e).mp h
  · left
    obtain ⟨-, hstate⟩ := (readSnapshotRejects_error_iff _ _ _).mp hs
    obtain ⟨pre, effect, suf, hsplit, -, hv⟩ := (accountingStateHashesAreValid_error_iff _ _).mp hstate
    obtain ⟨schedule, rfl, hplan⟩ := (validateAccountingEffectHash_error_iff _ _).mp hv
    refine ⟨schedule, ?_, hplan⟩
    have hmem : AccountingEffect.allocationSchedule schedule ∈ accountingStateEffects snapshot.accountingState := by
      rw [hsplit]; simp
    simpa [accountingStateEffects] using hmem
  · right
    have hevents : ∀ event ∈ sortBasisEventsById snapshot.sourceEvents,
        event.sourcePosting.bookValue.amount.WF := fun event he =>
      (hW.sourceEvents' event (mem_sortBasisEventsById.mp he)).sourcePosting.amount
    exact ⟨policy, hp, basisLoop_error hW.accountingState' _ 0 BasisTotals.empty hevents
      BasisTotals.empty_wf hl⟩
  · right
    have hevents : ∀ event ∈ sortBasisEventsById snapshot.sourceEvents,
        event.sourcePosting.bookValue.amount.WF := fun event he =>
      (hW.sourceEvents' event (mem_sortBasisEventsById.mp he)).sourcePosting.amount
    have hmeans := basisLoop_done_spec hW.accountingState' _ 0 BasisTotals.empty totals entries
      hevents BasisTotals.empty_wf hl
    exact ⟨policy, hp, Or.inl (reconciliationFails_error hmeans.wf hr)⟩

/-- Once the snapshot is accepted, three of the five tests of line 1446 cannot fail: the event's
reference is valid, of the policy's book, and names the hash of the event's copied posting (the
snapshot's checks of line 1440 have shown it). Only the posting's identifier and its commodity are
left to fail. -/
theorem eventDoesNotClose_of_accepted {policy : AccountingBasisPolicy}
    {snapshot : AccountingReadSnapshot} (h : readSnapshotRejects policy snapshot = .ok false)
    {event : BasisSourceEvent} (he : event ∈ snapshot.sourceEvents) :
    eventDoesNotClose policy event = true ↔
      event.sourcePosting.id ≠ event.source.postingId ∨
        event.sourcePosting.bookValue.functionalCommodityId ≠
          policy.quantizationPolicy.functionalCommodityId := by
  have hclose := sourcePopulationCloses_of_accepted h
  unfold sourcePopulationCloses at hclose
  simp only [Bool.and_eq_true, List.all_eq_true] at hclose
  obtain ⟨hvalid, hbook, -, -, -, -, -, -, -, hcopy⟩ :=
    (postingReferenceCloses_true_iff _ _ _ _ _).mp (hclose.2 event he)
  have hhash := hcopy _ rfl
  have hch : contentHashEquals event.source.postingContentHash
      (hashCanonical (canonicalPostingValue event.sourcePosting)) = true :=
    (contentHashEquals_iff _ _).mpr hhash.symm
  unfold eventDoesNotClose
  simp only [hvalid, hbook, hch, bne_self_eq_false, Bool.not_true, Bool.false_or, Bool.or_eq_true,
    bne_iff_ne, ne_eq]
  tauto


/-- The event diagnostic (line 1446) is given only for an event whose copied posting has another
identifier than its reference names, or is not in the policy's functional commodity: the other three
tests of the line are settled by the checks of the snapshot. -/
theorem projectAccountingBasis_event_only_id_or_commodity {policies : List AccountingPolicy}
    {policyIdValue : PolicyId} {version : SemanticVersion} {snapshot : AccountingReadSnapshot}
    {event : BasisSourceEvent}
    (h : projectAccountingBasis policies policyIdValue version snapshot =
      .ok (.rejected [basisEventDiagnostic event])) :
    ∃ (policy : AccountingBasisPolicy) (first : BasisSourceEvent), first ∈ snapshot.sourceEvents ∧
      first.id = event.id ∧
      (first.sourcePosting.id ≠ first.source.postingId ∨
        first.sourcePosting.bookValue.functionalCommodityId ≠
          policy.quantizationPolicy.functionalCommodityId) := by
  obtain ⟨policy, first, hadm, hfind, hid⟩ := (projectAccountingBasis_event_iff event).mp h
  have hmem : first ∈ snapshot.sourceEvents :=
    mem_sortBasisEventsById.mp (List.mem_of_find?_eq_some hfind)
  have hfails := List.find?_some hfind
  exact ⟨policy, first, hmem, hid, (eventDoesNotClose_of_accepted hadm.accepted hmem).mp hfails⟩

end Rastrata.Kernel

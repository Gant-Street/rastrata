/-
The laws of `reviseAllocationSchedule` (`accounting.ts` line 1665): what a revision conserves of
what was recognised, the successor schedule it plans for the remainder, the journal of its
adjustment, the hashes of its effects, and every rejection with its diagnostic.
-/
import Rastrata.Kernel.Accounting.Schedules.Recognize

namespace Rastrata.Kernel

set_option linter.unusedSimpArgs false


namespace Schedules

/-- The recognitions of a schedule: those of the state that name it (line 1676). -/
def revisionRecognitions (state : AllocationAccountingState) (original : AllocationSchedule) :
    List AllocationRecognition :=
  state.allocationRecognitions.filter (·.scheduleId == original.id)

/-- The first steps of a revision passed: the original schedule was found, a policy was selected,
the posting-plan gate let the revision go on, and the totals were computed. -/
structure ReviseReached (policies : List AccountingPolicy) (state : AllocationAccountingState)
    (bookId : BookId) (request : AllocationScheduleRevisionRequest) (original : AllocationSchedule)
    (policy : AllocationPolicy) (totals : Schedules.RevisionTotals) : Prop where
  found : state.allocationSchedules.find? (·.id == request.originalScheduleId) = some original
  selected : policyAt AllocationPolicy policies request.policyId request.policyVersion
    request.policyEffectiveAt = .selected policy
  gate : planGate policy original (revisionRecognitions state original) = .ok true
  totals : revisionTotals policy (usesCumulativeAllocation policy) original
    (revisionRecognitions state original) request.exactAdjustmentAmount = .ok totals

end Schedules

namespace Schedules

/-- A successor that is refused is refused with a rejection: the one `createAllocationSchedule`
returned. -/
theorem revisionSuccessor_inl {policies : List AccountingPolicy} {bookId : BookId}
    {policy : AllocationPolicy} {original : AllocationSchedule}
    {request : AllocationScheduleRevisionRequest} {totals : RevisionTotals}
    {x : AccountingCalculation}
    (h : revisionSuccessor policies bookId policy original request totals = .ok (.inl x)) :
    ∃ diagnostics, x = .rejected diagnostics := by
  unfold revisionSuccessor at h
  by_cases hreq : successorRequired request totals.afterAdjustment = true
  · simp only [hreq, ↓reduceIte] at h
    rcases hid : request.successorScheduleId with _ | successorId
    · simp [hid] at h
    rcases hend : request.revisedEndsOn with _ | revisedEndsOn
    · simp [hid, hend] at h
    simp only [hid, hend] at h
    rcases hc : createAllocationSchedule policies bookId
        { id := successorId, policyId := policy.id, policyVersion := policy.version,
          governedAt := request.policyEffectiveAt, source := original.source,
          sourcePostingId := original.sourcePostingId, sourceBasis := totals.afterAdjustment,
          residualValue := request.revisedResidualValue, startsOn := request.effectiveOn,
          endsOn := revisedEndsOn, usage := request.revisedUsage,
          derivation := request.derivation } with e | created
    · rw [hc] at h; cases h
    rcases created with draft | diagnostics
    · simp only [hc] at h
      split at h <;> simp at h
    · simp only [hc, Except.ok.injEq, Sum.inl.injEq] at h
      exact ⟨diagnostics, h.symm⟩
  · simp [hreq] at h

end Schedules

/-- The steps of a call that produced a draft. -/
theorem reviseAllocationSchedule_draft_inv {policies : List AccountingPolicy}
    {state : AllocationAccountingState} {bookId : BookId} {commodityId : CommodityId}
    {request : AllocationScheduleRevisionRequest} {d : AccountingDraft}
    (h : reviseAllocationSchedule policies state bookId commodityId request = .ok (.draft d)) :
    ∃ (original : AllocationSchedule) (policy : AllocationPolicy) (totals : Schedules.RevisionTotals)
      (successor : Option AllocationSchedule) (bookedAdjustment : Option QuantizedValue),
      Schedules.ReviseReached policies state bookId request original policy totals ∧
      Schedules.revisionIncoherent policy bookId state original
        (Schedules.revisionRecognitions state original) request totals = false ∧
      Schedules.earlierUnrecognized original (Schedules.revisionRecognitions state original)
        request = false ∧
      Schedules.revisionSuccessor policies bookId policy original request totals =
        .ok (.inr successor) ∧
      (request.exactAdjustmentAmount = none ∧ bookedAdjustment = none ∨
        ∃ adjustment quantized, request.exactAdjustmentAmount = some adjustment ∧
          quantize adjustment policy.quantizationPolicy.rule = .ok quantized ∧
          bookedAdjustment = some quantized) ∧
      d.effects = [.allocationScheduleRevision (Schedules.revisionEffect policy original request
          (Schedules.revisionRecognitions state original) totals successor bookedAdjustment)] ++
        (match successor with
          | none => []
          | some schedule => [.allocationSchedule schedule]) ∧
      (request.exactAdjustmentAmount = none ∧ d.journals = [] ∨
        ∃ adjustment jid pidAllocation pidContra,
          request.exactAdjustmentAmount = some adjustment ∧
          journalId (request.id.value ++ "-journal") = .ok jid ∧
          postingId (request.id.value ++ "-allocation") = .ok pidAllocation ∧
          postingId (request.id.value ++ "-contra") = .ok pidContra ∧
          d.journals = [Schedules.adjustmentJournal policy (usesCumulativeAllocation policy) request
            commodityId (totals.appliedAdjustment.getD ExactRational.zero) jid pidAllocation
            pidContra]) := by
  unfold reviseAllocationSchedule at h
  rcases hf : state.allocationSchedules.find? (·.id == request.originalScheduleId) with _ | original
  · simp [hf, Schedules.revisionMissingRejection, reject_eq] at h
  rcases hpa : policyAt AllocationPolicy policies request.policyId request.policyVersion
      request.policyEffectiveAt with policy | diagnostics
  swap
  · simp [hf, hpa, Schedules.revisionMissingRejection, reject_eq] at h
  simp only [hf, hpa] at h
  rcases hg : Schedules.planGate policy original
      (state.allocationRecognitions.filter (·.scheduleId == original.id)) with e | gate
  · rw [hg] at h; cases h
  cases gate
  · simp [hg, Schedules.revisionPostingPlanRejection, reject_eq] at h
  rcases ht : Schedules.revisionTotals policy (usesCumulativeAllocation policy) original
      (state.allocationRecognitions.filter (·.scheduleId == original.id))
      request.exactAdjustmentAmount with e | totals
  · simp only [hg, ht] at h; cases h
  simp only [hg, ht] at h
  by_cases hinc : Schedules.revisionIncoherent policy bookId state original
      (state.allocationRecognitions.filter (·.scheduleId == original.id)) request totals = true
  · simp [hinc, Schedules.revisionCoherenceRejection, reject_eq] at h
  have hinc' := Bool.eq_false_iff.mpr hinc
  simp only [hinc, Bool.false_eq_true, ↓reduceIte] at h
  by_cases hearly : Schedules.earlierUnrecognized original
      (state.allocationRecognitions.filter (·.scheduleId == original.id)) request = true
  · simp [hearly, Schedules.revisionPriorRecognitionsRejection, reject_eq] at h
  have hearly' := Bool.eq_false_iff.mpr hearly
  simp only [hearly, Bool.false_eq_true, ↓reduceIte] at h
  rcases hs : Schedules.revisionSuccessor policies bookId policy original request totals with
    e | succ
  · rw [hs] at h; cases h
  rcases succ with rejection | successor
  · simp only [hs, Except.ok.injEq] at h
    -- rejection is a rejection: it came from `.rejected`
    obtain ⟨ds, hds⟩ := Schedules.revisionSuccessor_inl hs
    rw [hds] at h; cases h
  simp only [hs] at h
  have hreach : Schedules.ReviseReached policies state bookId request original policy totals :=
    ⟨hf, hpa, hg, ht⟩
  rcases hadj : request.exactAdjustmentAmount with _ | adjustment
  · simp only [hadj, drafted_eq, Except.ok.injEq, AccountingCalculation.draft.injEq] at h
    subst h
    exact ⟨original, policy, totals, successor, none, hreach, hinc', hearly', hs,
      Or.inl ⟨rfl, rfl⟩, rfl, Or.inl ⟨rfl, rfl⟩⟩
  · simp only [hadj] at h
    rcases hq : Schedules.liftQuantize (quantize adjustment policy.quantizationPolicy.rule) with
      e | quantized
    · rw [hq] at h; cases h
    simp only [hq] at h
    rcases hj : Schedules.liftCanonical (journalId (request.id.value ++ "-journal")) with e | jid
    · rw [hj] at h; cases h
    simp only [hj] at h
    rcases hpa' : Schedules.liftCanonical (postingId (request.id.value ++ "-allocation")) with
      e | pidAllocation
    · rw [hpa'] at h; cases h
    simp only [hpa'] at h
    rcases hc : Schedules.liftCanonical (postingId (request.id.value ++ "-contra")) with e | pidContra
    · rw [hc] at h; cases h
    simp only [hc, drafted_eq, Except.ok.injEq, AccountingCalculation.draft.injEq] at h
    subst h
    exact ⟨original, policy, totals, successor, some quantized, hreach, hinc', hearly', hs,
      Or.inr ⟨adjustment, quantized, rfl, Schedules.liftQuantize_ok hq, rfl⟩, rfl,
      Or.inr ⟨adjustment, jid, pidAllocation, pidContra, rfl, Schedules.liftCanonical_ok hj,
        Schedules.liftCanonical_ok hpa', Schedules.liftCanonical_ok hc, rfl⟩⟩

namespace Schedules

/-- The posted amounts of the recognitions are as many as the recognitions, each constructible and
equal to the posted amount the plan holds for the recognition's ordinal. -/
theorem postedRecognitionAmounts_spec (plan : AllocationPostingPlan) :
    ∀ {recognitions : List AllocationRecognition} {parts : List ExactRational},
      postedRecognitionAmounts plan recognitions = .ok parts →
        (∀ p ∈ parts, p.WF) ∧
          parts.map ExactRational.toRat =
            recognitions.map (fun r =>
              ((plan.installments.find? (·.ordinal == r.ordinal)).map
                (·.postedAmount.toRat)).getD 0) ∧
          ∀ r ∈ recognitions, (plan.installments.find? (·.ordinal == r.ordinal)).isSome = true
  | [], parts, h => by
    simp only [postedRecognitionAmounts, Except.ok.injEq] at h
    subst h
    simp
  | recognition :: rest, parts, h => by
    unfold postedRecognitionAmounts at h
    rcases hf : plan.installments.find? (·.ordinal == recognition.ordinal) with _ | item
    · simp [hf] at h
    simp only [hf] at h
    rcases hn : liftNum item.postedAmount.toRational with e | amt
    · rw [hn] at h; cases h
    simp only [hn] at h
    rcases ht : postedRecognitionAmounts plan rest with e | tail
    · rw [ht] at h; cases h
    simp only [ht, Except.ok.injEq] at h
    subst h
    obtain ⟨hw, hrat, hsome⟩ := postedRecognitionAmounts_spec plan ht
    have hr := liftNum_ok hn
    unfold ExactDecimal.toRational at hr
    obtain ⟨hwf, hval, -⟩ := ExactRational.of_ok hr
    have hamt : amt.toRat = item.postedAmount.toRat := by
      unfold ExactDecimal.toRat
      push_cast at hval ⊢
      exact hval
    refine ⟨?_, ?_, ?_⟩
    · intro p hp
      rcases List.mem_cons.mp hp with rfl | hp
      · exact hwf
      · exact hw p hp
    · simp only [List.map_cons, hrat, hf, Option.map_some, Option.getD_some, hamt]
    · intro r hr'
      rcases List.mem_cons.mp hr' with rfl | hr'
      · simp [hf]
      · exact hsome r hr'

/-- What `postedTotals` returns: nothing for a schedule that is not cumulative; for a cumulative one,
the posted amount recognized to date (the posted amounts the plan holds for the recognitions, added)
and the posted carrying amount (the source basis less it), with every recognition having an entry in
the plan. -/
theorem postedTotals_spec {cumulative : Bool} {original : AllocationSchedule}
    {recognitions : List AllocationRecognition} {pr pc : Option ExactRational}
    (hbasis : original.sourceBasis.WF)
    (h : postedTotals cumulative original recognitions = .ok (pr, pc)) :
    (cumulative = false ∧ pr = none ∧ pc = none) ∨
      (cumulative = true ∧ ∃ (plan : AllocationPostingPlan) (P C : ExactRational),
        original.postingPlan = some plan ∧ pr = some P ∧ pc = some C ∧ P.WF ∧ C.WF ∧
        P.toRat = (recognitions.map (fun r =>
          ((plan.installments.find? (·.ordinal == r.ordinal)).map
            (·.postedAmount.toRat)).getD 0)).sum ∧
        C.toRat = original.sourceBasis.toRat - P.toRat ∧
        ∀ r ∈ recognitions, (plan.installments.find? (·.ordinal == r.ordinal)).isSome = true) := by
  unfold postedTotals at h
  by_cases hc : cumulative = true
  · simp only [hc, ↓reduceIte] at h
    refine Or.inr ⟨hc, ?_⟩
    rcases hp : original.postingPlan with _ | plan
    · simp [hp] at h
    simp only [hp] at h
    rcases hpa : postedRecognitionAmounts plan recognitions with e | parts
    · rw [hpa] at h; cases h
    simp only [hpa] at h
    obtain ⟨hpw, hprat, hsome⟩ := postedRecognitionAmounts_spec plan hpa
    rcases hs : liftNum (accountingSum parts) with e | P
    · rw [hs] at h; cases h
    simp only [hs] at h
    obtain ⟨hPw, hPrat⟩ := accountingSum_ok hpw (liftNum_ok hs)
    rcases hsub : liftNum (original.sourceBasis.subtract P) with e | C
    · rw [hsub] at h; cases h
    simp only [hsub, Except.ok.injEq, Prod.mk.injEq] at h
    obtain ⟨rfl, rfl⟩ := h
    obtain ⟨hCw, hCrat⟩ := ExactRational.subtract_ok hbasis hPw (liftNum_ok hsub)
    refine ⟨plan, P, C, rfl, rfl, rfl, hPw, hCw, ?_, hCrat, hsome⟩
    rw [hPrat, hprat]
  · have hc' : cumulative = false := by simpa using hc
    simp only [hc, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq, Prod.mk.injEq] at h
    exact Or.inl ⟨hc', h.1.symm, h.2.symm⟩

/-- What `appliedAdjustmentOf` returns: under the cumulative algorithm, an adjustment that is given
is the whole number of units of the policy's scale it rounds to (constructible, with that value);
otherwise it is the adjustment as given. -/
theorem appliedAdjustmentOf_spec {cumulative : Bool} {policy : AllocationPolicy}
    {adjustment : Option ExactRational} {applied : Option ExactRational}
    (h : appliedAdjustmentOf cumulative policy adjustment = .ok applied) :
    (cumulative = true ∧ ∃ (a : ExactRational) (q : QuantizedValue) (r : ExactRational),
        adjustment = some a ∧ quantize a policy.quantizationPolicy.rule = .ok q ∧
        applied = some r ∧ r.WF ∧ r.toRat = q.amount.toRat) ∨
      (applied = adjustment ∧ ¬ (cumulative = true ∧ adjustment.isSome = true)) := by
  unfold appliedAdjustmentOf at h
  cases cumulative with
  | false =>
    cases adjustment <;> simp at h <;> exact Or.inr ⟨h.symm, by simp⟩
  | true =>
    cases adjustment with
    | none => simp at h; exact Or.inr ⟨h.symm, by simp⟩
    | some a =>
      simp only at h
      rcases hq : liftQuantize (quantize a policy.quantizationPolicy.rule) with e | q
      · rw [hq] at h; cases h
      simp only [hq] at h
      rcases hr : liftNum q.amount.toRational with e | r
      · rw [hr] at h; cases h
      simp only [hr, Except.ok.injEq] at h
      subst h
      have hr' := liftNum_ok hr
      unfold ExactDecimal.toRational at hr'
      obtain ⟨hwf, hval, -⟩ := ExactRational.of_ok hr'
      refine Or.inl ⟨rfl, a, q, r, rfl, liftQuantize_ok hq, rfl, hwf, ?_⟩
      unfold ExactDecimal.toRat
      push_cast at hval ⊢
      exact hval

/-- The exact amounts of the recognized installments are constructible when the schedule is. -/
theorem recognizedParts_wf {original : AllocationSchedule}
    {recognitions : List AllocationRecognition} (hwf : original.WF) :
    ∀ p ∈ recognizedParts original recognitions, p.WF := by
  intro p hp
  unfold recognizedParts at hp
  obtain ⟨r, -, rfl⟩ := List.mem_map.mp hp
  rcases hf : original.installments.find? (·.ordinal == r.ordinal) with _ | installment
  · simp only [hf, Option.map_none, Option.getD_none]
    exact ExactRational.zero_wf
  · simp only [hf, Option.map_some, Option.getD_some]
    exact (hwf.installments installment (List.mem_of_find?_eq_some hf)).amount

/-- What `revisionTotals` returns for a constructible original and adjustment: the exact amount
recognized to date is the sum of the exact amounts of the recognized installments, the carrying
amount is the source basis less it, the posted and applied figures are those of `postedTotals` and
`appliedAdjustmentOf`, and the carrying amount after the adjustment is the carrying amount the
revision works from (the posted one when there is one) plus the applied adjustment. -/
theorem revisionTotals_spec {policy : AllocationPolicy} {cumulative : Bool}
    {original : AllocationSchedule} {recognitions : List AllocationRecognition}
    {adjustment : Option ExactRational} {totals : RevisionTotals}
    (hwf : original.WF) (hadj : ∀ a, adjustment = some a → a.WF)
    (h : revisionTotals policy cumulative original recognitions adjustment = .ok totals) :
    totals.recognizedToDate.WF ∧ totals.carryingAmountAtRevision.WF ∧
      totals.recognizedToDate.toRat =
        ((recognizedParts original recognitions).map ExactRational.toRat).sum ∧
      totals.carryingAmountAtRevision.toRat =
        original.sourceBasis.toRat - totals.recognizedToDate.toRat ∧
      postedTotals cumulative original recognitions =
        .ok (totals.postedRecognizedToDate, totals.postedCarryingAmountAtRevision) ∧
      appliedAdjustmentOf cumulative policy adjustment = .ok totals.appliedAdjustment ∧
      (∀ r, totals.appliedAdjustment = some r → r.WF) ∧
      totals.effectiveCarrying.WF ∧ totals.afterAdjustment.WF ∧
      totals.afterAdjustment.toRat =
        totals.effectiveCarrying.toRat + (totals.appliedAdjustment.getD ExactRational.zero).toRat := by
  unfold revisionTotals at h
  rcases hs : liftNum (accountingSum (recognizedParts original recognitions)) with e | recognized
  · rw [hs] at h; cases h
  simp only [hs] at h
  obtain ⟨hrw, hrrat⟩ := accountingSum_ok (recognizedParts_wf hwf) (liftNum_ok hs)
  rcases hc : liftNum (original.sourceBasis.subtract recognized) with e | carrying
  · rw [hc] at h; cases h
  simp only [hc] at h
  obtain ⟨hcw, hcrat⟩ := ExactRational.subtract_ok hwf.sourceBasis hrw (liftNum_ok hc)
  rcases hp : postedTotals cumulative original recognitions with e | posted
  · rw [hp] at h; cases h
  obtain ⟨pr, pc⟩ := posted
  simp only [hp] at h
  rcases ha : appliedAdjustmentOf cumulative policy adjustment with e | applied
  · rw [ha] at h; cases h
  simp only [ha] at h
  rcases hn : liftNum ((pc.getD carrying).add (applied.getD ExactRational.zero)) with e | after
  · rw [hn] at h; cases h
  simp only [hn, Except.ok.injEq] at h
  subst h
  have hpt := postedTotals_spec hwf.sourceBasis hp
  have heff : (pc.getD carrying).WF := by
    rcases hpt with ⟨-, -, rfl⟩ | ⟨-, plan, P, C, -, -, rfl, -, hCw, -⟩
    · simpa using hcw
    · simpa using hCw
  have happ : ∀ r, applied = some r → r.WF := by
    intro r hr
    rcases appliedAdjustmentOf_spec ha with ⟨-, a, q, r', ha', -, rfl, hr'w, -⟩ | ⟨rfl, -⟩
    · cases hr; exact hr'w
    · exact hadj r hr
  have hzero : (applied.getD ExactRational.zero).WF := by
    cases hap : applied with
    | none => exact ExactRational.zero_wf
    | some r => exact happ r hap
  obtain ⟨hAw, hArat⟩ := ExactRational.add_ok heff hzero (liftNum_ok hn)
  exact ⟨hrw, hcw, hrrat, hcrat, rfl, rfl, happ, heff, hAw, hArat⟩

end Schedules

namespace Schedules

/-- What a revision that passed the test of `revisionIncoherent` satisfies: the derivation is approved
with evidence and names the policy and its version, the policy is of this book, the request carries
evidence, no revision of this schedule and none of this identity exists, the identifiers the request
names are the schedule's recognitions (as the joined texts the function compares), every recognized
installment is dated before the effective date, the residual value and the carrying amount after the
adjustment are not negative with the residual not above it, an adjustment is given exactly when one
is required, and a successor is named exactly when one is required. -/
theorem revisionIncoherent_false {policy : AllocationPolicy} {bookId : BookId}
    {state : AllocationAccountingState} {original : AllocationSchedule}
    {recognitions : List AllocationRecognition} {request : AllocationScheduleRevisionRequest}
    {totals : RevisionTotals}
    (h : revisionIncoherent policy bookId state original recognitions request totals = false) :
    policy.bookId = bookId ∧ request.evidence ≠ [] ∧
      validAccountingDerivation request.derivation = true ∧
      request.derivation.policyId = policy.id ∧ request.derivation.policyVersion = policy.version ∧
      (∀ revision ∈ state.allocationScheduleRevisions,
        revision.id ≠ request.id ∧ revision.originalScheduleId ≠ original.id) ∧
      "\x00".intercalate (sortRecognitionStrings (request.priorRecognitionIds.map (·.value))) =
        "\x00".intercalate ((sortRecognitionIds (recognitions.map (·.id))).map (·.value)) ∧
      (∀ r ∈ recognitions, ∀ installment,
        original.installments.find? (·.ordinal == r.ordinal) = some installment →
          installment.accountingDate < request.effectiveOn) ∧
      request.revisedResidualValue.isNegative = false ∧ totals.afterAdjustment.isNegative = false ∧
      request.revisedResidualValue.compare totals.afterAdjustment ≠ .gt ∧
      adjustmentRequired request.kind totals.effectiveCarrying = request.exactAdjustmentAmount.isSome ∧
      successorRequired request totals.afterAdjustment = request.successorScheduleId.isSome := by
  unfold revisionIncoherent at h
  simp only [Bool.or_eq_false_iff, and_assoc] at h
  obtain ⟨hbook, hev, hder, hdp, hdv, hrev, -, hids, -, hcut, hresid, hreq, -, -, -, -, hafter, hgt,
    -, hsucc, -, -⟩ := h
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, hresid, hafter, ?_, ?_, ?_⟩
  · simpa using hbook
  · simpa using hev
  · simpa using hder
  · simpa using hdp
  · simpa using hdv
  · intro revision hmem
    have := (List.any_eq_false.mp hrev) revision hmem
    simp only [Bool.or_eq_true, beq_iff_eq, not_or] at this
    exact this
  · simpa using hids
  · intro r hr installment hfind
    have := (List.any_eq_false.mp hcut) r hr
    simp only [hfind, Option.map_some, Option.getD_some, decide_eq_true_eq] at this
    have h2 := (jsStringLe_iff_not_lt request.effectiveOn.value installment.accountingDate.value)
    by_contra hnot
    exact this (h2.mpr hnot)
  · simpa using hgt
  · simpa using hreq
  · simpa using hsucc

/-- The exact amounts of the recognized installments, as numbers. -/
theorem recognizedParts_toRat (original : AllocationSchedule)
    (recognitions : List AllocationRecognition) :
    (recognizedParts original recognitions).map ExactRational.toRat =
      recognitions.map (fun r =>
        ((original.installments.find? (·.ordinal == r.ordinal)).map (·.amount.toRat)).getD 0) := by
  unfold recognizedParts
  rw [List.map_map]
  apply List.map_congr_left
  intro r _
  rcases hf : original.installments.find? (·.ordinal == r.ordinal) with _ | installment
  · simp [hf, ExactRational.zero_toRat]
  · simp [hf]

end Schedules

/-- **A revision conserves what was recognised**: the exact amount recognised to date with the
carrying amount at the revision makes the source basis again (and so do the posted amounts under
the cumulative algorithm), every recognised installment is dated before the effective date, and
the effects added are the revision and at most one successor schedule, so no recognition and no
existing schedule changes. -/
theorem reviseAllocationSchedule_conserves {policies : List AccountingPolicy}
    {state : AllocationAccountingState} {bookId : BookId} {commodityId : CommodityId}
    {request : AllocationScheduleRevisionRequest} {d : AccountingDraft}
    (hstate : state.WF) (hreq : request.WF)
    (h : reviseAllocationSchedule policies state bookId commodityId request = .ok (.draft d)) :
    ∃ (original : AllocationSchedule) (policy : AllocationPolicy)
      (revision : AllocationScheduleRevision) (successor : Option AllocationSchedule),
      state.allocationSchedules.find? (·.id == request.originalScheduleId) = some original ∧
      policyAt AllocationPolicy policies request.policyId request.policyVersion
        request.policyEffectiveAt = .selected policy ∧
      d.effects = [.allocationScheduleRevision revision] ++
        successor.toList.map AccountingEffect.allocationSchedule ∧
      revision.originalScheduleId = original.id ∧
      revision.priorRecognitionIds =
        Schedules.sortRecognitionIds
          ((state.allocationRecognitions.filter (·.scheduleId == original.id)).map (·.id)) ∧
      revision.recognizedToDate.toRat =
        ((state.allocationRecognitions.filter (·.scheduleId == original.id)).map (fun r =>
          ((original.installments.find? (·.ordinal == r.ordinal)).map
            (·.amount.toRat)).getD 0)).sum ∧
      revision.recognizedToDate.toRat + revision.carryingAmountAtRevision.toRat =
        original.sourceBasis.toRat ∧
      ((usesCumulativeAllocation policy = false ∧ revision.postedRecognizedToDate = none ∧
          revision.postedCarryingAmountAtRevision = none) ∨
        (usesCumulativeAllocation policy = true ∧
          ∃ (plan : AllocationPostingPlan) (P C : ExactRational),
            original.postingPlan = some plan ∧ revision.postedRecognizedToDate = some P ∧
            revision.postedCarryingAmountAtRevision = some C ∧
            P.toRat = ((state.allocationRecognitions.filter (·.scheduleId == original.id)).map
              (fun r => ((plan.installments.find? (·.ordinal == r.ordinal)).map
                (·.postedAmount.toRat)).getD 0)).sum ∧
            P.toRat + C.toRat = original.sourceBasis.toRat)) ∧
      (∀ r ∈ state.allocationRecognitions.filter (·.scheduleId == original.id),
        ∀ installment, original.installments.find? (·.ordinal == r.ordinal) = some installment →
          installment.accountingDate < request.effectiveOn) ∧
      (∀ other ∈ state.allocationScheduleRevisions, other.originalScheduleId ≠ original.id) := by
  obtain ⟨original, policy, totals, successor, booked, hreach, hinc, -, -, -, hdeffects, -⟩ :=
    reviseAllocationSchedule_draft_inv h
  have horig : original ∈ state.allocationSchedules := List.mem_of_find?_eq_some hreach.found
  have hwf : original.WF := hstate.allocationSchedules original horig
  obtain ⟨hrw, hcw, hrrat, hcrat, hposted, -, -, -, -, -⟩ :=
    Schedules.revisionTotals_spec hwf hreq.exactAdjustmentAmount hreach.totals
  obtain ⟨-, -, -, -, -, hother, -, hcut, -, -, -, -, -⟩ := Schedules.revisionIncoherent_false hinc
  refine ⟨original, policy, Schedules.revisionEffect policy original request
    (Schedules.revisionRecognitions state original) totals successor booked, successor,
    hreach.found, hreach.selected, ?_, rfl, rfl, ?_, ?_, ?_, hcut,
    fun other hmem => (hother other hmem).2⟩
  · rw [hdeffects]
    cases successor <;> rfl
  · show totals.recognizedToDate.toRat = _
    rw [hrrat, Schedules.recognizedParts_toRat]
    rfl
  · show totals.recognizedToDate.toRat + totals.carryingAmountAtRevision.toRat = _
    rw [hcrat]; ring
  · show (usesCumulativeAllocation policy = false ∧ totals.postedRecognizedToDate = none ∧
        totals.postedCarryingAmountAtRevision = none) ∨ _
    rcases Schedules.postedTotals_spec hwf.sourceBasis hposted with ⟨hc, h1, h2⟩ |
      ⟨hc, plan, P, C, hplan, h1, h2, -, -, hP, hC, -⟩
    · exact Or.inl ⟨hc, h1, h2⟩
    · refine Or.inr ⟨hc, plan, P, C, hplan, h1, h2, hP, ?_⟩
      rw [hC]; ring

namespace Schedules

/-- The request the successor schedule is created from (lines 1718 to 1724). -/
def successorRequest (policy : AllocationPolicy) (original : AllocationSchedule)
    (request : AllocationScheduleRevisionRequest) (afterAdjustment : ExactRational)
    (successorId : AllocationScheduleId) (revisedEndsOn : LocalDate) : AllocationScheduleRequest :=
  { id := successorId, policyId := policy.id, policyVersion := policy.version,
    governedAt := request.policyEffectiveAt, source := original.source,
    sourcePostingId := original.sourcePostingId, sourceBasis := afterAdjustment,
    residualValue := request.revisedResidualValue, startsOn := request.effectiveOn,
    endsOn := revisedEndsOn, usage := request.revisedUsage, derivation := request.derivation }

/-- A revision that has no successor did not require one. -/
theorem revisionSuccessor_none {policies : List AccountingPolicy} {bookId : BookId}
    {policy : AllocationPolicy} {original : AllocationSchedule}
    {request : AllocationScheduleRevisionRequest} {totals : RevisionTotals}
    (h : revisionSuccessor policies bookId policy original request totals = .ok (.inr none)) :
    successorRequired request totals.afterAdjustment = false := by
  unfold revisionSuccessor at h
  by_cases hreq : successorRequired request totals.afterAdjustment = true
  · exfalso
    simp only [hreq, ↓reduceIte] at h
    rcases hid : request.successorScheduleId with _ | successorId
    · simp [hid] at h
    rcases hend : request.revisedEndsOn with _ | revisedEndsOn
    · simp [hid, hend] at h
    simp only [hid, hend] at h
    rcases hc : createAllocationSchedule policies bookId
        (successorRequest policy original request totals.afterAdjustment successorId
          revisedEndsOn) with e | created
    · simp only [successorRequest] at hc
      rw [hc] at h; cases h
    rcases created with draft | diagnostics
    · simp only [successorRequest] at hc
      simp only [hc] at h
      split at h <;> simp at h
    · simp only [successorRequest] at hc
      simp only [hc] at h
      cases h
  · simpa using hreq

/-- A revision that has a successor required one, named it and an end for it, and made it with
`createAllocationSchedule` from the carrying amount after the adjustment. -/
theorem revisionSuccessor_some {policies : List AccountingPolicy} {bookId : BookId}
    {policy : AllocationPolicy} {original : AllocationSchedule}
    {request : AllocationScheduleRevisionRequest} {totals : RevisionTotals}
    {successor : AllocationSchedule}
    (h : revisionSuccessor policies bookId policy original request totals =
      .ok (.inr (some successor))) :
    successorRequired request totals.afterAdjustment = true ∧
      ∃ successorId revisedEndsOn, request.successorScheduleId = some successorId ∧
        request.revisedEndsOn = some revisedEndsOn ∧
        createAllocationSchedule policies bookId
          (successorRequest policy original request totals.afterAdjustment successorId
            revisedEndsOn) = .ok (drafted [] [.allocationSchedule successor]) := by
  unfold revisionSuccessor at h
  by_cases hreq : successorRequired request totals.afterAdjustment = true
  · simp only [hreq, ↓reduceIte] at h
    refine ⟨hreq, ?_⟩
    rcases hid : request.successorScheduleId with _ | successorId
    · simp [hid] at h
    rcases hend : request.revisedEndsOn with _ | revisedEndsOn
    · simp [hid, hend] at h
    simp only [hid, hend] at h
    refine ⟨successorId, revisedEndsOn, rfl, rfl, ?_⟩
    rcases hc : createAllocationSchedule policies bookId
        (successorRequest policy original request totals.afterAdjustment successorId
          revisedEndsOn) with e | created
    · simp only [successorRequest] at hc
      rw [hc] at h; cases h
    rcases created with draft | diagnostics
    · simp only [successorRequest] at hc ⊢
      obtain ⟨policy', allocable, amountsSum, totalBasis, amounts, dates, postingPlan, -, -, -, -, -, -,
        -, -, hd⟩ := createAllocationSchedule_draft_inv hc
      subst hd
      simp only [hc, List.find?_cons, List.find?_nil, Except.ok.injEq, Sum.inr.injEq,
        Option.some.injEq] at h
      subst h
      rfl
    · simp only [successorRequest] at hc
      simp only [hc] at h
      cases h
  · simp [hreq] at h

end Schedules

/-- **A revision re-plans only the remainder**: it makes a successor schedule exactly when
`successorRequired` says so (an estimate change, or an impairment that leaves more than the revised
residual to allocate), and then the successor is what `createAllocationSchedule` makes from the
carrying amount after the adjustment, the revised residual value and the revised end: its source
basis is that carrying amount (what the recognitions left, plus the applied adjustment), its
instalments add up to that carrying amount less the revised residual value, it keeps the original's
source and lineage, and the kernel's own hash check accepts it. -/
theorem reviseAllocationSchedule_successor {policies : List AccountingPolicy}
    {state : AllocationAccountingState} {bookId : BookId} {commodityId : CommodityId}
    {request : AllocationScheduleRevisionRequest} {d : AccountingDraft}
    (hpol : ∀ p ∈ policies, p.WF) (hstate : state.WF) (hreq : request.WF)
    (h : reviseAllocationSchedule policies state bookId commodityId request = .ok (.draft d)) :
    ∃ (original : AllocationSchedule) (policy : AllocationPolicy)
      (totals : Schedules.RevisionTotals),
      Schedules.ReviseReached policies state bookId request original policy totals ∧
      totals.afterAdjustment.toRat =
        totals.effectiveCarrying.toRat + (totals.appliedAdjustment.getD ExactRational.zero).toRat ∧
      ((Schedules.successorRequired request totals.afterAdjustment = false ∧
          ∀ e ∈ d.effects, ∀ s, e ≠ .allocationSchedule s) ∨
        (Schedules.successorRequired request totals.afterAdjustment = true ∧
          ∃ (successorId : AllocationScheduleId) (revisedEndsOn : LocalDate)
            (successor : AllocationSchedule),
            request.successorScheduleId = some successorId ∧
            request.revisedEndsOn = some revisedEndsOn ∧
            createAllocationSchedule policies bookId
              (Schedules.successorRequest policy original request totals.afterAdjustment
                successorId revisedEndsOn) = .ok (drafted [] [.allocationSchedule successor]) ∧
            AccountingEffect.allocationSchedule successor ∈ d.effects ∧
            successor.id = successorId ∧ successor.sourceBasis = totals.afterAdjustment ∧
            successor.residualValue = request.revisedResidualValue ∧
            successor.source = original.source ∧
            successor.sourcePostingId = original.sourcePostingId ∧
            (successor.installments.map (·.amount.toRat)).sum =
              totals.afterAdjustment.toRat - request.revisedResidualValue.toRat ∧
            validateAccountingEffectHash (.allocationSchedule successor) = .ok true)) := by
  obtain ⟨original, policy, totals, successor, booked, hreach, -, -, hs, -, hdeffects, -⟩ :=
    reviseAllocationSchedule_draft_inv h
  have horig : original ∈ state.allocationSchedules := List.mem_of_find?_eq_some hreach.found
  have hwf : original.WF := hstate.allocationSchedules original horig
  obtain ⟨-, -, -, -, -, -, -, -, hafterw, hafter⟩ :=
    Schedules.revisionTotals_spec hwf hreq.exactAdjustmentAmount hreach.totals
  refine ⟨original, policy, totals, hreach, hafter, ?_⟩
  cases successor with
  | none =>
    refine Or.inl ⟨Schedules.revisionSuccessor_none hs, ?_⟩
    intro e he s hes
    rw [hdeffects] at he
    simp only [List.mem_append, List.mem_singleton, Option.toList_none] at he
    rcases he with rfl | he
    · cases hes
    · simp at he
  | some successor =>
    obtain ⟨hreqd, successorId, revisedEndsOn, hid, hend, hcreate⟩ :=
      Schedules.revisionSuccessor_some hs
    refine Or.inr ⟨hreqd, successorId, revisedEndsOn, successor, hid, hend, hcreate, ?_, ?_⟩
    · rw [hdeffects]
      simp
    · obtain ⟨hpolwf, -, hpid, hpver⟩ := policyAt_allocation_selected hpol hreach.selected
      have hsreq : (Schedules.successorRequest policy original request totals.afterAdjustment
          successorId revisedEndsOn).WF :=
        ⟨hreq.successorScheduleId successorId hid, hpolwf.core.id, hreq.effectiveOn,
          hreq.revisedEndsOn revisedEndsOn hend, hwf.source, hwf.sourcePostingId, hafterw,
          hreq.revisedResidualValue, hreq.revisedUsage, hreq.derivation⟩
      have hsel : policyAt AllocationPolicy policies
          (Schedules.successorRequest policy original request totals.afterAdjustment successorId
            revisedEndsOn).policyId
          (Schedules.successorRequest policy original request totals.afterAdjustment successorId
            revisedEndsOn).policyVersion
          (Schedules.successorRequest policy original request totals.afterAdjustment successorId
            revisedEndsOn).governedAt = .selected policy := by
        show policyAt AllocationPolicy policies policy.id policy.version request.policyEffectiveAt = _
        rw [hpid, hpver]
        exact hreach.selected
      obtain ⟨policy', allocable, amountsSum, totalBasis, amounts, dates, postingPlan, -, -, -, -, -,
        -, -, -, hsch⟩ := createAllocationSchedule_schedule_inv hcreate
      refine ⟨by rw [hsch]; rfl, by rw [hsch]; rfl, by rw [hsch]; rfl, by rw [hsch]; rfl,
        by rw [hsch]; rfl, ?_, ?_⟩
      · exact createAllocationSchedule_exact_sum hpol hsreq hsel hcreate
      · exact createAllocationSchedule_valid hpol hsreq hsel hcreate

/-- **The adjustment journal is balanced**: a revision that gives an adjustment makes one journal
whose two postings are equal and opposite in units and in exact book value (the adjustment as
given, or rounded to the policy's scale under the cumulative algorithm), and one that gives none
makes no journal. -/
theorem reviseAllocationSchedule_journal {policies : List AccountingPolicy}
    {state : AllocationAccountingState} {bookId : BookId} {commodityId : CommodityId}
    {request : AllocationScheduleRevisionRequest} {d : AccountingDraft}
    (hstate : state.WF) (hreq : request.WF)
    (h : reviseAllocationSchedule policies state bookId commodityId request = .ok (.draft d)) :
    (request.exactAdjustmentAmount = none ∧ d.journals = []) ∨
      ∃ (adjustment : ExactRational) (policy : AllocationPolicy) (journal : ExactPreparedJournal)
        (a : ExactRational),
        request.exactAdjustmentAmount = some adjustment ∧ d.journals = [journal] ∧
        journal.postings.map (·.exactBookValue) = [a.negate, a] ∧
        journal.postings.map (·.units) = [a.negate, a] ∧
        (journal.postings.map (·.exactBookValue.toRat)).sum = 0 ∧
        (journal.postings.map (·.units.toRat)).sum = 0 ∧
        journal.postings.map (·.accountId) =
          [policy.allocationAccountId, policy.contraAccountId] ∧
        journal.accountingDate = request.effectiveOn ∧ journal.kind = .adjustment ∧
        journal.derivations = [request.derivation] ∧
        (usesCumulativeAllocation policy = false → a = adjustment ∧
          journal.requiredQuantizationPolicy = none) ∧
        (usesCumulativeAllocation policy = true → ∃ q : QuantizedValue,
          quantize adjustment policy.quantizationPolicy.rule = .ok q ∧ a.toRat = q.amount.toRat ∧
            journal.requiredQuantizationPolicy = some policy.quantizationPolicy) := by
  obtain ⟨original, policy, totals, successor, booked, hreach, -, -, -, -, -, hdj⟩ :=
    reviseAllocationSchedule_draft_inv h
  rcases hdj with ⟨hnone, hj⟩ | ⟨adjustment, jid, pidAllocation, pidContra, hadj, -, -, -, hj⟩
  · exact Or.inl ⟨hnone, hj⟩
  · refine Or.inr ⟨adjustment, policy, _, totals.appliedAdjustment.getD ExactRational.zero, hadj, hj,
      rfl, rfl, ?_, ?_, rfl, rfl, rfl, rfl, ?_, ?_⟩
    · simp [Schedules.adjustmentJournal, ExactRational.negate_toRat]
    · simp [Schedules.adjustmentJournal, ExactRational.negate_toRat]
    · intro hc
      have horig : original ∈ state.allocationSchedules := List.mem_of_find?_eq_some hreach.found
      have hwf := hstate.allocationSchedules original horig
      obtain ⟨-, -, -, -, -, ha, -, -, -, -⟩ :=
        Schedules.revisionTotals_spec hwf hreq.exactAdjustmentAmount hreach.totals
      rw [hadj] at ha
      rcases Schedules.appliedAdjustmentOf_spec ha with ⟨hcum, -⟩ | ⟨happ, hnot⟩
      · rw [hc] at hcum; cases hcum
      · rw [happ]
        refine ⟨rfl, ?_⟩
        simp [Schedules.adjustmentJournal, hc]
    · intro hc
      have horig : original ∈ state.allocationSchedules := List.mem_of_find?_eq_some hreach.found
      have hwf := hstate.allocationSchedules original horig
      obtain ⟨-, -, -, -, -, ha, -, -, -, -⟩ :=
        Schedules.revisionTotals_spec hwf hreq.exactAdjustmentAmount hreach.totals
      rw [hadj] at ha
      rcases Schedules.appliedAdjustmentOf_spec ha with ⟨-, a, q, r, ha', hq, happ, -, hr⟩ | ⟨-, hnot⟩
      · cases ha'
        refine ⟨q, hq, ?_, ?_⟩
        · rw [happ]; simpa using hr
        · simp [Schedules.adjustmentJournal, hc]
      · exact absurd ⟨hc, rfl⟩ hnot


/-- **The revision has the hash of its body**: the revision effect's content hash is
`accountingHash("AllocationScheduleRevision", body)` of the revision without it, its posted amounts are
present exactly when the policy is cumulative, and the kernel's own hash check accepts the effect. -/
theorem reviseAllocationSchedule_hash {policies : List AccountingPolicy}
    {state : AllocationAccountingState} {bookId : BookId} {commodityId : CommodityId}
    {request : AllocationScheduleRevisionRequest} {d : AccountingDraft}
    (hstate : state.WF) (hreq : request.WF)
    (h : reviseAllocationSchedule policies state bookId commodityId request = .ok (.draft d)) :
    ∃ revision : AllocationScheduleRevision,
      AccountingEffect.allocationScheduleRevision revision ∈ d.effects ∧
      revision.contentHash = accountingBodyHash "AllocationScheduleRevision" revision ∧
      validateAccountingEffectHash (.allocationScheduleRevision revision) = .ok true := by
  obtain ⟨original, policy, totals, successor, booked, hreach, -, -, -, -, hdeffects, -⟩ :=
    reviseAllocationSchedule_draft_inv h
  have horig : original ∈ state.allocationSchedules := List.mem_of_find?_eq_some hreach.found
  have hwf := hstate.allocationSchedules original horig
  obtain ⟨-, -, -, -, hposted, -, -, -, -, -⟩ :=
    Schedules.revisionTotals_spec hwf hreq.exactAdjustmentAmount hreach.totals
  have hhash := AllocationScheduleRevision.contentHash_of_body
    { id := request.id, kind := request.kind, effectiveOn := request.effectiveOn,
      generatedEffectKey := request.generatedEffectKey, originalScheduleId := original.id,
      priorRecognitionIds := Schedules.sortRecognitionIds
        ((Schedules.revisionRecognitions state original).map (·.id)),
      recognizedToDate := totals.recognizedToDate,
      carryingAmountAtRevision := totals.carryingAmountAtRevision,
      postedRecognizedToDate := totals.postedRecognizedToDate,
      postedCarryingAmountAtRevision := totals.postedCarryingAmountAtRevision,
      revisedResidualValue := request.revisedResidualValue,
      exactAdjustmentAmount := request.exactAdjustmentAmount, bookedAdjustment := booked,
      successorScheduleId := successor.map (·.id), policy := policy, evidence := request.evidence,
      derivation := request.derivation, contentHash := default }
  refine ⟨Schedules.revisionEffect policy original request
    (Schedules.revisionRecognitions state original) totals successor booked, ?_, hhash, ?_⟩
  · rw [hdeffects]; simp
  · rw [validateAccountingEffectHash_true_iff]
    refine ⟨rfl, ?_, hhash⟩
    show revisionPostedAmountsInconsistent
      (Schedules.revisionEffect policy original request
        (Schedules.revisionRecognitions state original) totals successor booked) = false
    unfold revisionPostedAmountsInconsistent
    rcases Schedules.postedTotals_spec hwf.sourceBasis hposted with ⟨hc, h1, h2⟩ |
      ⟨hc, plan, P, C, -, h1, h2, -⟩
    · show (if usesCumulativeAllocation policy = true then _ else _) = false
      simp [hc, h1, h2, Schedules.revisionEffect]
    · simp [Schedules.revisionEffect, hc, h1, h2]

namespace Schedules

/-- **The posting-plan gate** (lines 1677 to 1683): it refuses (`.ok false`) exactly when the policy
is cumulative or the original carries a plan, and then the policy is not cumulative, or the original
carries no plan, or its plan is not valid (`allocationPlanIsValid`), or the plan is valid and a
recognition names an installment the schedule does not have, a posting account changed, or the
quantization policy changed. -/
theorem planGate_false_iff {policy : AllocationPolicy} {original : AllocationSchedule}
    {recognitions : List AllocationRecognition} :
    planGate policy original recognitions = .ok false ↔
      (usesCumulativeAllocation policy = true ∨ original.postingPlan.isSome = true) ∧
        (usesCumulativeAllocation policy = false ∨ original.postingPlan.isSome = false ∨
          allocationPlanIsValid original = .ok false ∨
          (allocationPlanIsValid original = .ok true ∧
            planChanged policy original recognitions = true)) := by
  constructor
  · intro h
    unfold planGate at h
    by_cases hout : (usesCumulativeAllocation policy || original.postingPlan.isSome) = true
    · have hout' : usesCumulativeAllocation policy = true ∨ original.postingPlan.isSome = true := by
        simpa using hout
      refine ⟨hout', ?_⟩
      simp only [hout, ↓reduceIte] at h
      by_cases hin : (!usesCumulativeAllocation policy || original.postingPlan.isNone) = true
      · have hin' : usesCumulativeAllocation policy = false ∨ original.postingPlan.isNone = true := by
          simpa using hin
        rcases hin' with h1 | h1
        · exact Or.inl h1
        · exact Or.inr (Or.inl (by simpa using h1))
      · simp only [hin, Bool.false_eq_true, ↓reduceIte] at h
        rcases hv : liftQuantize (allocationPlanIsValid original) with e | valid
        · rw [hv] at h; cases h
        cases valid
        · exact Or.inr (Or.inr (Or.inl (liftQuantize_ok hv)))
        · simp only [hv, Except.ok.injEq, Bool.not_eq_eq_eq_not, Bool.not_true] at h
          exact Or.inr (Or.inr (Or.inr ⟨liftQuantize_ok hv, by simpa using h⟩))
    · simp [hout] at h
  · rintro ⟨hout', hrest⟩
    unfold planGate
    have hout : (usesCumulativeAllocation policy || original.postingPlan.isSome) = true := by
      simpa using hout'
    simp only [hout, ↓reduceIte]
    by_cases hin : (!usesCumulativeAllocation policy || original.postingPlan.isNone) = true
    · simp [hin]
    · simp only [hin, Bool.false_eq_true, ↓reduceIte]
      rcases hrest with h1 | h1 | h1 | ⟨h1, h2⟩
      · exfalso; apply hin; simp [h1]
      · exfalso; apply hin; simp [Option.isNone_iff_eq_none, Option.isSome_iff_ne_none] at h1 ⊢; simp [h1]
      · simp [liftQuantize, h1]
      · simp [liftQuantize, h1, h2]

/-- A successor that is refused was required, named and given an end, and the call of
`createAllocationSchedule` that made it returned a rejection, which is the revision's. -/
theorem revisionSuccessor_rejected {policies : List AccountingPolicy} {bookId : BookId}
    {policy : AllocationPolicy} {original : AllocationSchedule}
    {request : AllocationScheduleRevisionRequest} {totals : RevisionTotals}
    {x : AccountingCalculation}
    (h : revisionSuccessor policies bookId policy original request totals = .ok (.inl x)) :
    successorRequired request totals.afterAdjustment = true ∧
      ∃ successorId revisedEndsOn diagnostics,
        request.successorScheduleId = some successorId ∧
        request.revisedEndsOn = some revisedEndsOn ∧
        createAllocationSchedule policies bookId
          (successorRequest policy original request totals.afterAdjustment successorId
            revisedEndsOn) = .ok (.rejected diagnostics) ∧ x = .rejected diagnostics := by
  unfold revisionSuccessor at h
  by_cases hreq : successorRequired request totals.afterAdjustment = true
  · simp only [hreq, ↓reduceIte] at h
    refine ⟨hreq, ?_⟩
    rcases hid : request.successorScheduleId with _ | successorId
    · simp [hid] at h
    rcases hend : request.revisedEndsOn with _ | revisedEndsOn
    · simp [hid, hend] at h
    simp only [hid, hend] at h
    rcases hc : createAllocationSchedule policies bookId
        (successorRequest policy original request totals.afterAdjustment successorId
          revisedEndsOn) with e | created
    · simp only [successorRequest] at hc
      rw [hc] at h; cases h
    rcases created with draft | diagnostics
    · simp only [successorRequest] at hc
      simp only [hc] at h
      split at h <;> simp at h
    · simp only [successorRequest] at hc
      simp only [hc, Except.ok.injEq, Sum.inl.injEq] at h
      exact ⟨successorId, revisedEndsOn, diagnostics, rfl, rfl, hc, h.symm⟩
  · simp [hreq] at h

/-- A required, named successor whose creation is rejected makes the revision return that
rejection. -/
theorem revisionSuccessor_of_rejected {policies : List AccountingPolicy} {bookId : BookId}
    {policy : AllocationPolicy} {original : AllocationSchedule}
    {request : AllocationScheduleRevisionRequest} {totals : RevisionTotals}
    {successorId : AllocationScheduleId} {revisedEndsOn : LocalDate}
    {diagnostics : List SemanticDiagnostic}
    (hreq : successorRequired request totals.afterAdjustment = true)
    (hid : request.successorScheduleId = some successorId)
    (hend : request.revisedEndsOn = some revisedEndsOn)
    (hc : createAllocationSchedule policies bookId
      (successorRequest policy original request totals.afterAdjustment successorId
        revisedEndsOn) = .ok (.rejected diagnostics)) :
    revisionSuccessor policies bookId policy original request totals =
      .ok (.inl (.rejected diagnostics)) := by
  unfold revisionSuccessor
  simp only [successorRequest] at hc
  simp [hreq, hid, hend, hc]

end Schedules

namespace Schedules

/-- Why `reviseAllocationSchedule` refuses with this rejection, stage by stage in the order of the
function; the conditions of each stage are the ones the function tests. -/
inductive ReviseRefusal (policies : List AccountingPolicy) (state : AllocationAccountingState)
    (bookId : BookId) (request : AllocationScheduleRevisionRequest) :
    AccountingCalculation → Prop
  /-- The original schedule is not in the state (line 1674). -/
  | noOriginal
      (h : state.allocationSchedules.find? (·.id == request.originalScheduleId) = none) :
      ReviseRefusal policies state bookId request revisionMissingRejection
  /-- `policyAt` selects no policy (line 1674). -/
  | noPolicy {diagnostics : List SemanticDiagnostic}
      (h : policyAt AllocationPolicy policies request.policyId request.policyVersion
        request.policyEffectiveAt = .rejected diagnostics) :
      ReviseRefusal policies state bookId request revisionMissingRejection
  /-- The posting-plan gate refuses (line 1682). -/
  | planGate {original : AllocationSchedule} {policy : AllocationPolicy}
      (hf : state.allocationSchedules.find? (·.id == request.originalScheduleId) = some original)
      (hs : policyAt AllocationPolicy policies request.policyId request.policyVersion
        request.policyEffectiveAt = .selected policy)
      (hg : Schedules.planGate policy original (revisionRecognitions state original) = .ok false) :
      ReviseRefusal policies state bookId request revisionPostingPlanRejection
  /-- The revision's cutoff, prior recognitions, adjustment topology, residual, successor, policy or
  evidence do not reconcile (line 1713). -/
  | incoherent {original : AllocationSchedule} {policy : AllocationPolicy} {totals : RevisionTotals}
      (hr : ReviseReached policies state bookId request original policy totals)
      (hinc : revisionIncoherent policy bookId state original
        (revisionRecognitions state original) request totals = true) :
      ReviseRefusal policies state bookId request revisionCoherenceRejection
  /-- A prospective revision with an earlier installment that no recognition covers (line 1714). -/
  | earlier {original : AllocationSchedule} {policy : AllocationPolicy} {totals : RevisionTotals}
      (hr : ReviseReached policies state bookId request original policy totals)
      (hinc : revisionIncoherent policy bookId state original
        (revisionRecognitions state original) request totals = false)
      (hearly : earlierUnrecognized original (revisionRecognitions state original) request = true) :
      ReviseRefusal policies state bookId request revisionPriorRecognitionsRejection
  /-- The successor schedule is required and its creation is rejected: the revision returns that
  rejection (line 1725). -/
  | successor {original : AllocationSchedule} {policy : AllocationPolicy} {totals : RevisionTotals}
      {successorId : AllocationScheduleId} {revisedEndsOn : LocalDate}
      {diagnostics : List SemanticDiagnostic}
      (hr : ReviseReached policies state bookId request original policy totals)
      (hinc : revisionIncoherent policy bookId state original
        (revisionRecognitions state original) request totals = false)
      (hearly : earlierUnrecognized original (revisionRecognitions state original) request = false)
      (hreq : successorRequired request totals.afterAdjustment = true)
      (hid : request.successorScheduleId = some successorId)
      (hend : request.revisedEndsOn = some revisedEndsOn)
      (hc : createAllocationSchedule policies bookId
        (successorRequest policy original request totals.afterAdjustment successorId
          revisedEndsOn) = .ok (.rejected diagnostics)) :
      ReviseRefusal policies state bookId request (.rejected diagnostics)

end Schedules

/-- Every stage that refuses makes `reviseAllocationSchedule` return its rejection. -/
theorem Schedules.ReviseRefusal.result {policies : List AccountingPolicy}
    {state : AllocationAccountingState} {bookId : BookId} {commodityId : CommodityId}
    {request : AllocationScheduleRevisionRequest} {r : AccountingCalculation}
    (h : Schedules.ReviseRefusal policies state bookId request r) :
    reviseAllocationSchedule policies state bookId commodityId request = .ok r := by
  cases h with
  | noOriginal h => unfold reviseAllocationSchedule; simp [h]
  | noPolicy h => unfold reviseAllocationSchedule; simp [h]
  | planGate hf hs hg =>
    unfold reviseAllocationSchedule
    simp only [Schedules.revisionRecognitions] at hg
    simp [hf, hs, hg]
  | incoherent hr hinc =>
    unfold reviseAllocationSchedule
    obtain ⟨hf, hs, hg, ht⟩ := hr
    simp only [Schedules.revisionRecognitions] at hg ht hinc
    simp [hf, hs, hg, ht, hinc]
  | earlier hr hinc hearly =>
    unfold reviseAllocationSchedule
    obtain ⟨hf, hs, hg, ht⟩ := hr
    simp only [Schedules.revisionRecognitions] at hg ht hinc hearly
    simp [hf, hs, hg, ht, hinc, hearly]
  | successor hr hinc hearly hreq hid hend hc =>
    unfold reviseAllocationSchedule
    obtain ⟨hf, hs, hg, ht⟩ := hr
    simp only [Schedules.revisionRecognitions] at hg ht hinc hearly
    have hsucc := Schedules.revisionSuccessor_of_rejected (policies := policies) (bookId := bookId)
      (policy := _) (original := _) hreq hid hend hc
    simp [hf, hs, hg, ht, hinc, hearly, hsucc]


/-- Whatever `reviseAllocationSchedule` returns without throwing is a rejection for one of the stated
reasons, stage by stage, or a draft. -/
theorem reviseAllocationSchedule_cases {policies : List AccountingPolicy}
    {state : AllocationAccountingState} {bookId : BookId} {commodityId : CommodityId}
    {request : AllocationScheduleRevisionRequest} {r : AccountingCalculation}
    (h : reviseAllocationSchedule policies state bookId commodityId request = .ok r) :
    Schedules.ReviseRefusal policies state bookId request r ∨ ∃ d, r = .draft d := by
  unfold reviseAllocationSchedule at h
  rcases hf : state.allocationSchedules.find? (·.id == request.originalScheduleId) with _ | original
  · simp only [hf, Except.ok.injEq] at h
    subst h
    exact Or.inl (.noOriginal hf)
  rcases hpa : policyAt AllocationPolicy policies request.policyId request.policyVersion
      request.policyEffectiveAt with policy | diagnostics
  swap
  · simp only [hf, hpa, Except.ok.injEq] at h
    subst h
    exact Or.inl (.noPolicy hpa)
  simp only [hf, hpa] at h
  rcases hg : Schedules.planGate policy original
      (state.allocationRecognitions.filter (·.scheduleId == original.id)) with e | gate
  · rw [hg] at h; cases h
  cases gate
  · simp only [hg, Except.ok.injEq] at h
    subst h
    exact Or.inl (.planGate hf hpa hg)
  rcases ht : Schedules.revisionTotals policy (usesCumulativeAllocation policy) original
      (state.allocationRecognitions.filter (·.scheduleId == original.id))
      request.exactAdjustmentAmount with e | totals
  · simp only [hg, ht] at h; cases h
  simp only [hg, ht] at h
  have hreach : Schedules.ReviseReached policies state bookId request original policy totals :=
    ⟨hf, hpa, hg, ht⟩
  by_cases hinc : Schedules.revisionIncoherent policy bookId state original
      (state.allocationRecognitions.filter (·.scheduleId == original.id)) request totals = true
  · simp only [hinc, ↓reduceIte, Except.ok.injEq] at h
    subst h
    exact Or.inl (.incoherent hreach hinc)
  have hinc' := Bool.eq_false_iff.mpr hinc
  simp only [hinc, Bool.false_eq_true, ↓reduceIte] at h
  by_cases hearly : Schedules.earlierUnrecognized original
      (state.allocationRecognitions.filter (·.scheduleId == original.id)) request = true
  · simp only [hearly, ↓reduceIte, Except.ok.injEq] at h
    subst h
    exact Or.inl (.earlier hreach hinc' hearly)
  have hearly' := Bool.eq_false_iff.mpr hearly
  simp only [hearly, Bool.false_eq_true, ↓reduceIte] at h
  rcases hs : Schedules.revisionSuccessor policies bookId policy original request totals with
    e | succ
  · rw [hs] at h; cases h
  rcases succ with rejection | successor
  · simp only [hs, Except.ok.injEq] at h
    subst h
    obtain ⟨hreq, successorId, revisedEndsOn, diagnostics, hid, hend, hc, rfl⟩ :=
      Schedules.revisionSuccessor_rejected hs
    exact Or.inl (.successor hreach hinc' hearly' hreq hid hend hc)
  simp only [hs] at h
  right
  rcases hadj : request.exactAdjustmentAmount with _ | adjustment
  · simp only [hadj, drafted_eq, Except.ok.injEq] at h
    exact ⟨_, h.symm⟩
  · simp only [hadj] at h
    rcases hq : Schedules.liftQuantize (quantize adjustment policy.quantizationPolicy.rule) with
      e | quantized
    · rw [hq] at h; cases h
    simp only [hq] at h
    rcases hj : Schedules.liftCanonical (journalId (request.id.value ++ "-journal")) with e | jid
    · rw [hj] at h; cases h
    simp only [hj] at h
    rcases hpa' : Schedules.liftCanonical (postingId (request.id.value ++ "-allocation")) with
      e | pidAllocation
    · rw [hpa'] at h; cases h
    simp only [hpa'] at h
    rcases hc : Schedules.liftCanonical (postingId (request.id.value ++ "-contra")) with e | pidContra
    · rw [hc] at h; cases h
    simp only [hc, drafted_eq, Except.ok.injEq] at h
    exact ⟨_, h.symm⟩


/-- A rejection of `reviseAllocationSchedule` is not a draft. -/
theorem Schedules.reviseRejections_ne_draft {d : AccountingDraft} :
    Schedules.revisionMissingRejection ≠ .draft d ∧
    Schedules.revisionPostingPlanRejection ≠ .draft d ∧
    Schedules.revisionCoherenceRejection ≠ .draft d ∧
    Schedules.revisionPriorRecognitionsRejection ≠ .draft d := by
  simp [Schedules.revisionMissingRejection, Schedules.revisionPostingPlanRejection,
    Schedules.revisionCoherenceRejection, Schedules.revisionPriorRecognitionsRejection, reject_eq]

/-- Every rejection of `createAllocationSchedule` carries the code `allocation_schedule_violation`. -/
theorem createAllocationSchedule_rejected_code {policies : List AccountingPolicy} {bookId : BookId}
    {request : AllocationScheduleRequest} {diagnostics : List SemanticDiagnostic}
    (h : createAllocationSchedule policies bookId request = .ok (.rejected diagnostics)) :
    ∀ d ∈ diagnostics, d.code = .allocation_schedule_violation := by
  rcases createAllocationSchedule_cases h with hr | ⟨schedule, hs⟩
  · generalize hx : AccountingCalculation.rejected diagnostics = x at hr
    cases hr <;>
      (simp only [Schedules.createCoherenceRejection, Schedules.createPolicyRejection,
        Schedules.createSpanRejection, Schedules.createDecliningRateRejection,
        Schedules.createUsageBoundRejection, Schedules.createUsageFactsRejection,
        Schedules.createInstallmentsConservationRejection, Schedules.createPostingPlanRejection,
        reject_eq, allocationPlanDiagnostic, AccountingCalculation.rejected.injEq] at hx
       subst hx
       simp [diagnostic])
  · simp [drafted_eq] at hs

/-- A rejection with the code `allocation_schedule_violation` is none of the revision's own. -/
theorem Schedules.violation_ne_revision {diagnostics : List SemanticDiagnostic}
    (hcode : ∀ d ∈ diagnostics, d.code = .allocation_schedule_violation) :
    AccountingCalculation.rejected diagnostics ≠ Schedules.revisionMissingRejection ∧
    AccountingCalculation.rejected diagnostics ≠ Schedules.revisionPostingPlanRejection ∧
    AccountingCalculation.rejected diagnostics ≠ Schedules.revisionCoherenceRejection ∧
    AccountingCalculation.rejected diagnostics ≠ Schedules.revisionPriorRecognitionsRejection := by
  refine ⟨?_, ?_, ?_, ?_⟩ <;>
    (intro hh
     simp only [Schedules.revisionMissingRejection, Schedules.revisionPostingPlanRejection,
       Schedules.revisionCoherenceRejection, Schedules.revisionPriorRecognitionsRejection,
       reject_eq, AccountingCalculation.rejected.injEq] at hh
     subst hh
     simp at hcode)

/-- **The missing rejection** (`command.scheduleRevision`, `ACC-044.4`; line 1674): the call returns
it exactly when the original schedule is not in the state or no policy is selected. -/
theorem reviseAllocationSchedule_missing_iff {policies : List AccountingPolicy}
    {state : AllocationAccountingState} {bookId : BookId} {commodityId : CommodityId}
    {request : AllocationScheduleRevisionRequest} :
    reviseAllocationSchedule policies state bookId commodityId request =
        .ok Schedules.revisionMissingRejection ↔
      state.allocationSchedules.find? (·.id == request.originalScheduleId) = none ∨
        ∃ diagnostics, policyAt AllocationPolicy policies request.policyId request.policyVersion
          request.policyEffectiveAt = .rejected diagnostics := by
  constructor
  · intro h
    rcases reviseAllocationSchedule_cases h with hr | ⟨d, hd⟩
    · generalize hx : Schedules.revisionMissingRejection = x at hr
      cases hr with
      | noOriginal hh => exact Or.inl hh
      | noPolicy hh => exact Or.inr ⟨_, hh⟩
      | successor _ _ _ _ _ _ hc =>
        exact absurd hx (Schedules.violation_ne_revision
          (createAllocationSchedule_rejected_code hc)).1.symm
      | _ =>
        exfalso
        simp [Schedules.revisionMissingRejection, Schedules.revisionPostingPlanRejection,
          Schedules.revisionCoherenceRejection, Schedules.revisionPriorRecognitionsRejection,
          reject_eq] at hx
    · exact absurd hd Schedules.reviseRejections_ne_draft.1
  · rintro (hf | ⟨diagnostics, hp⟩)
    · exact (Schedules.ReviseRefusal.noOriginal hf).result
    · exact (Schedules.ReviseRefusal.noPolicy hp).result

/-- **The posting-plan rejection** (`command.scheduleRevision.postingPlan`, `ACC-044.3`,
`ACC-044.4`; line 1682): once the original is found and a policy selected, the call returns it
exactly when the gate refuses (`planGate_false_iff` says when). -/
theorem reviseAllocationSchedule_postingPlan_iff {policies : List AccountingPolicy}
    {state : AllocationAccountingState} {bookId : BookId} {commodityId : CommodityId}
    {request : AllocationScheduleRevisionRequest} :
    reviseAllocationSchedule policies state bookId commodityId request =
        .ok Schedules.revisionPostingPlanRejection ↔
      ∃ (original : AllocationSchedule) (policy : AllocationPolicy),
        state.allocationSchedules.find? (·.id == request.originalScheduleId) = some original ∧
        policyAt AllocationPolicy policies request.policyId request.policyVersion
          request.policyEffectiveAt = .selected policy ∧
        Schedules.planGate policy original (Schedules.revisionRecognitions state original) =
          .ok false := by
  constructor
  · intro h
    rcases reviseAllocationSchedule_cases h with hr | ⟨d, hd⟩
    · generalize hx : Schedules.revisionPostingPlanRejection = x at hr
      cases hr with
      | planGate hf hs hg => exact ⟨_, _, hf, hs, hg⟩
      | successor _ _ _ _ _ _ hc =>
        exact absurd hx (Schedules.violation_ne_revision
          (createAllocationSchedule_rejected_code hc)).2.1.symm
      | _ =>
        exfalso
        simp [Schedules.revisionMissingRejection, Schedules.revisionPostingPlanRejection,
          Schedules.revisionCoherenceRejection, Schedules.revisionPriorRecognitionsRejection,
          reject_eq] at hx
    · exact absurd hd Schedules.reviseRejections_ne_draft.2.1
  · rintro ⟨original, policy, hf, hs, hg⟩
    exact (Schedules.ReviseRefusal.planGate hf hs hg).result

/-- **The coherence rejection** (`command.scheduleRevision`, `ACC-044.4`, `ACC-044.5`, `ACC-044.6`;
line 1713): once the gate and the totals passed, the call returns it exactly when
`revisionIncoherent` holds: the policy is of another book, the evidence is missing, the derivation is
not approved or names another policy or version, a revision of this schedule or of this identity
exists, the identifiers named are not the schedule's recognitions, the effective date precedes the
first installment or does not follow every recognized installment, the residual value or the
carrying amount after the adjustment is negative or the residual exceeds it, the adjustment or the
successor is given when it is not required (or not given when it is), or the successor ends before
the effective date. -/
theorem reviseAllocationSchedule_coherence_iff {policies : List AccountingPolicy}
    {state : AllocationAccountingState} {bookId : BookId} {commodityId : CommodityId}
    {request : AllocationScheduleRevisionRequest} :
    reviseAllocationSchedule policies state bookId commodityId request =
        .ok Schedules.revisionCoherenceRejection ↔
      ∃ (original : AllocationSchedule) (policy : AllocationPolicy)
        (totals : Schedules.RevisionTotals),
        Schedules.ReviseReached policies state bookId request original policy totals ∧
        Schedules.revisionIncoherent policy bookId state original
          (Schedules.revisionRecognitions state original) request totals = true := by
  constructor
  · intro h
    rcases reviseAllocationSchedule_cases h with hr | ⟨d, hd⟩
    · generalize hx : Schedules.revisionCoherenceRejection = x at hr
      cases hr with
      | incoherent hh hinc => exact ⟨_, _, _, hh, hinc⟩
      | successor _ _ _ _ _ _ hc =>
        exact absurd hx (Schedules.violation_ne_revision
          (createAllocationSchedule_rejected_code hc)).2.2.1.symm
      | _ =>
        exfalso
        simp [Schedules.revisionMissingRejection, Schedules.revisionPostingPlanRejection,
          Schedules.revisionCoherenceRejection, Schedules.revisionPriorRecognitionsRejection,
          reject_eq] at hx
    · exact absurd hd Schedules.reviseRejections_ne_draft.2.2.1
  · rintro ⟨original, policy, totals, hr, hinc⟩
    exact (Schedules.ReviseRefusal.incoherent hr hinc).result

/-- **The prior-recognitions rejection** (`command.scheduleRevision.priorRecognitionIds`,
`ACC-044.4`, `ACC-044.5`; line 1714): once the revision is coherent, an estimate change or an
impairment is refused exactly when an installment dated before the effective date has no
recognition, so that its carrying basis could be allocated twice. -/
theorem reviseAllocationSchedule_earlier_iff {policies : List AccountingPolicy}
    {state : AllocationAccountingState} {bookId : BookId} {commodityId : CommodityId}
    {request : AllocationScheduleRevisionRequest} :
    reviseAllocationSchedule policies state bookId commodityId request =
        .ok Schedules.revisionPriorRecognitionsRejection ↔
      ∃ (original : AllocationSchedule) (policy : AllocationPolicy)
        (totals : Schedules.RevisionTotals),
        Schedules.ReviseReached policies state bookId request original policy totals ∧
        Schedules.revisionIncoherent policy bookId state original
          (Schedules.revisionRecognitions state original) request totals = false ∧
        Schedules.earlierUnrecognized original (Schedules.revisionRecognitions state original)
          request = true := by
  constructor
  · intro h
    rcases reviseAllocationSchedule_cases h with hr | ⟨d, hd⟩
    · generalize hx : Schedules.revisionPriorRecognitionsRejection = x at hr
      cases hr with
      | earlier hh hinc hearly => exact ⟨_, _, _, hh, hinc, hearly⟩
      | successor _ _ _ _ _ _ hc =>
        exact absurd hx (Schedules.violation_ne_revision
          (createAllocationSchedule_rejected_code hc)).2.2.2.symm
      | _ =>
        exfalso
        simp [Schedules.revisionMissingRejection, Schedules.revisionPostingPlanRejection,
          Schedules.revisionCoherenceRejection, Schedules.revisionPriorRecognitionsRejection,
          reject_eq] at hx
    · exact absurd hd Schedules.reviseRejections_ne_draft.2.2.2
  · rintro ⟨original, policy, totals, hr, hinc, hearly⟩
    exact (Schedules.ReviseRefusal.earlier hr hinc hearly).result

/-- **A rejected successor is the revision's rejection** (line 1725): when everything before the
successor passed and it is required, named and given an end, and `createAllocationSchedule` rejects
it, the revision returns exactly that rejection, diagnostics unchanged. -/
theorem reviseAllocationSchedule_successor_rejected {policies : List AccountingPolicy}
    {state : AllocationAccountingState} {bookId : BookId} {commodityId : CommodityId}
    {request : AllocationScheduleRevisionRequest} {original : AllocationSchedule}
    {policy : AllocationPolicy} {totals : Schedules.RevisionTotals}
    {successorId : AllocationScheduleId} {revisedEndsOn : LocalDate}
    {diagnostics : List SemanticDiagnostic}
    (hr : Schedules.ReviseReached policies state bookId request original policy totals)
    (hinc : Schedules.revisionIncoherent policy bookId state original
      (Schedules.revisionRecognitions state original) request totals = false)
    (hearly : Schedules.earlierUnrecognized original
      (Schedules.revisionRecognitions state original) request = false)
    (hreq : Schedules.successorRequired request totals.afterAdjustment = true)
    (hid : request.successorScheduleId = some successorId)
    (hend : request.revisedEndsOn = some revisedEndsOn)
    (hc : createAllocationSchedule policies bookId
      (Schedules.successorRequest policy original request totals.afterAdjustment successorId
        revisedEndsOn) = .ok (.rejected diagnostics)) :
    reviseAllocationSchedule policies state bookId commodityId request =
      .ok (.rejected diagnostics) :=
  (Schedules.ReviseRefusal.successor hr hinc hearly hreq hid hend hc).result

namespace Schedules

/-- The errors that come from an exact-number operation or from `quantize`: the size error, or the
`RangeError` for a scale outside 0 to 1,000. -/
def NumericError (e : ScheduleErr) : Prop :=
  ∃ qe, e = .quantize qe ∧ (qe = .scaleOutOfRange ∨ qe = .exactNumber .representationLimitExceeded)

/-- The size error is a numeric error. -/
theorem limitError_numeric : NumericError limitError := ⟨_, rfl, Or.inr rfl⟩

/-- When the posting-plan gate lets a revision go on: the policy is not cumulative and the original
carries no plan; or it is cumulative, the original carries a valid plan, and nothing changed. -/
theorem planGate_true {policy : AllocationPolicy} {original : AllocationSchedule}
    {recognitions : List AllocationRecognition}
    (h : planGate policy original recognitions = .ok true) :
    (usesCumulativeAllocation policy = false ∧ original.postingPlan = none) ∨
      (usesCumulativeAllocation policy = true ∧ original.postingPlan.isSome = true ∧
        allocationPlanIsValid original = .ok true ∧
        planChanged policy original recognitions = false) := by
  unfold planGate at h
  by_cases hout : (usesCumulativeAllocation policy || original.postingPlan.isSome) = true
  · simp only [hout, ↓reduceIte] at h
    by_cases hin : (!usesCumulativeAllocation policy || original.postingPlan.isNone) = true
    · simp [hin] at h
    · simp only [hin, Bool.false_eq_true, ↓reduceIte] at h
      have hin' : (!usesCumulativeAllocation policy || original.postingPlan.isNone) = false :=
        Bool.eq_false_iff.mpr hin
      simp only [Bool.or_eq_false_iff, Bool.not_eq_false'] at hin'
      obtain ⟨hcum, hnone⟩ := hin'
      have hsome : original.postingPlan.isSome = true := by
        cases hpl : original.postingPlan with
        | none => simp [hpl] at hnone
        | some _ => rfl
      rcases hv : liftQuantize (allocationPlanIsValid original) with e | valid
      · rw [hv] at h; cases h
      cases valid
      · simp [hv] at h
      · simp only [hv, Except.ok.injEq, Bool.not_eq_eq_eq_not, Bool.not_true] at h
        exact Or.inr ⟨hcum, hsome, liftQuantize_ok hv, by simpa using h⟩
  · simp only [hout, Bool.false_eq_true, ↓reduceIte] at h
    have hc : usesCumulativeAllocation policy = false := by
      simp only [Bool.or_eq_true, not_or] at hout; simpa using hout.1
    have hp : original.postingPlan = none := by
      simp only [Bool.or_eq_true, not_or] at hout
      cases hpl : original.postingPlan with
      | none => rfl
      | some _ => simp [hpl] at hout
    exact Or.inl ⟨hc, hp⟩

/-- Applying an adjustment throws only the size error or the `RangeError` of `quantize`. -/
theorem appliedAdjustmentOf_error {cumulative : Bool} {policy : AllocationPolicy}
    {adjustment : Option ExactRational} {e : ScheduleErr}
    (hadj : ∀ a, adjustment = some a → a.WF)
    (h : appliedAdjustmentOf cumulative policy adjustment = .error e) : NumericError e := by
  unfold appliedAdjustmentOf at h
  cases cumulative with
  | false => cases adjustment <;> simp at h
  | true =>
    cases adjustment with
    | none => simp at h
    | some a =>
      simp only at h
      rcases hq : liftQuantize (quantize a policy.quantizationPolicy.rule) with e' | q
      · simp only [hq, Except.error.injEq] at h
        subst h
        obtain ⟨qe, hqe, rfl⟩ := liftQuantize_error hq
        rcases quantize_error_cases (hadj a rfl) hqe with ⟨rfl, -⟩ | ⟨rfl, -, -⟩
        · exact ⟨_, rfl, Or.inl rfl⟩
        · exact ⟨_, rfl, Or.inr rfl⟩
      · simp only [hq] at h
        obtain ⟨hqw, -⟩ := quantize_ok (hadj a rfl) (liftQuantize_ok hq)
        rcases hr : liftNum q.amount.toRational with e' | r
        · exact absurd hr (by
            intro hh
            obtain ⟨code, hcode, -⟩ := liftNum_error hh
            exact ExactDecimal.toRational_ne_error hqw code hcode)
        · simp [hr] at h

/-- The posted amounts of the recognitions fail only for the missing entry of the plan. -/
theorem postedRecognitionAmounts_error (plan : AllocationPostingPlan) (hplan : plan.WF) :
    ∀ {recognitions : List AllocationRecognition} {e : ScheduleErr},
      postedRecognitionAmounts plan recognitions = .error e →
        e = .missingPlanInstallment ∧ ∃ r ∈ recognitions,
          plan.installments.find? (·.ordinal == r.ordinal) = none
  | [], _, h => by simp [postedRecognitionAmounts] at h
  | recognition :: rest, e, h => by
    unfold postedRecognitionAmounts at h
    rcases hf : plan.installments.find? (·.ordinal == recognition.ordinal) with _ | item
    · simp only [hf, Except.error.injEq] at h
      subst h
      exact ⟨rfl, recognition, by simp, hf⟩
    simp only [hf] at h
    have hmem := List.mem_of_find?_eq_some hf
    have hiw := hplan.installments item hmem
    rcases hn : liftNum item.postedAmount.toRational with e' | amt
    · exfalso
      obtain ⟨code, hcode, -⟩ := liftNum_error hn
      exact ExactDecimal.toRational_ne_error hiw.postedAmount code hcode
    simp only [hn] at h
    rcases ht : postedRecognitionAmounts plan rest with e' | tail
    · simp only [ht, Except.error.injEq] at h
      subst h
      obtain ⟨h1, r, hr, hfr⟩ := postedRecognitionAmounts_error plan hplan ht
      exact ⟨h1, r, by simp [hr], hfr⟩
    · simp [ht] at h

/-- Adding up the posted amounts of the recognitions throws only the size error, or the missing
entry of the plan for a recognition's ordinal. -/
theorem postedTotals_error {cumulative : Bool} {original : AllocationSchedule}
    {recognitions : List AllocationRecognition} {e : ScheduleErr}
    (hwf : original.WF) (hplan : cumulative = true → original.postingPlan.isSome = true)
    (h : postedTotals cumulative original recognitions = .error e) :
    NumericError e ∨ (e = .missingPlanInstallment ∧ ∃ (plan : AllocationPostingPlan)
      (r : AllocationRecognition), original.postingPlan = some plan ∧ r ∈ recognitions ∧
        plan.installments.find? (·.ordinal == r.ordinal) = none) := by
  unfold postedTotals at h
  by_cases hc : cumulative = true
  · simp only [hc, ↓reduceIte] at h
    rcases hp : original.postingPlan with _ | plan
    · have := hplan hc
      simp [hp] at this
    simp only [hp] at h
    have hplanwf := hwf.postingPlan plan hp
    rcases hpa : postedRecognitionAmounts plan recognitions with e' | parts
    · simp only [hpa, Except.error.injEq] at h
      subst h
      obtain ⟨h1, r, hr, hfr⟩ := postedRecognitionAmounts_error plan hplanwf hpa
      exact Or.inr ⟨h1, plan, r, rfl, hr, hfr⟩
    obtain ⟨hpw, -, -⟩ := postedRecognitionAmounts_spec plan hpa
    simp only [hpa] at h
    rcases hs : liftNum (accountingSum parts) with e' | P
    · simp only [hs, Except.error.injEq] at h
      subst h
      exact Or.inl (liftNum_limit (fun code hc' => accountingSum_error hpw hc') hs ▸ limitError_numeric)
    obtain ⟨hPw, -⟩ := accountingSum_ok hpw (liftNum_ok hs)
    simp only [hs] at h
    rcases hsub : liftNum (original.sourceBasis.subtract P) with e' | C
    · simp only [hsub, Except.error.injEq] at h
      subst h
      exact Or.inl (liftNum_limit (subtract_error_limit hwf.sourceBasis hPw) hsub ▸ limitError_numeric)
    · simp [hsub] at h
  · simp [hc] at h

/-- The totals of a revision throw only the size error, the `RangeError` of `quantize`, or the missing
entry of the plan for a recognition's ordinal. -/
theorem revisionTotals_error {policy : AllocationPolicy} {cumulative : Bool}
    {original : AllocationSchedule} {recognitions : List AllocationRecognition}
    {adjustment : Option ExactRational} {e : ScheduleErr}
    (hwf : original.WF) (hadj : ∀ a, adjustment = some a → a.WF)
    (hplan : cumulative = true → original.postingPlan.isSome = true)
    (h : revisionTotals policy cumulative original recognitions adjustment = .error e) :
    NumericError e ∨ (e = .missingPlanInstallment ∧ ∃ (plan : AllocationPostingPlan)
      (r : AllocationRecognition), original.postingPlan = some plan ∧ r ∈ recognitions ∧
        plan.installments.find? (·.ordinal == r.ordinal) = none) := by
  unfold revisionTotals at h
  rcases hs : liftNum (accountingSum (recognizedParts original recognitions)) with e' | recognized
  · simp only [hs, Except.error.injEq] at h
    subst h
    exact Or.inl (liftNum_limit
      (fun code hc => accountingSum_error (recognizedParts_wf hwf) hc) hs ▸ limitError_numeric)
  obtain ⟨hrw, -⟩ := accountingSum_ok (recognizedParts_wf hwf) (liftNum_ok hs)
  simp only [hs] at h
  rcases hc : liftNum (original.sourceBasis.subtract recognized) with e' | carrying
  · simp only [hc, Except.error.injEq] at h
    subst h
    exact Or.inl (liftNum_limit (subtract_error_limit hwf.sourceBasis hrw) hc ▸ limitError_numeric)
  obtain ⟨hcw, -⟩ := ExactRational.subtract_ok hwf.sourceBasis hrw (liftNum_ok hc)
  simp only [hc] at h
  rcases hp : postedTotals cumulative original recognitions with e' | posted
  · simp only [hp, Except.error.injEq] at h
    subst h
    exact postedTotals_error hwf hplan hp
  obtain ⟨pr, pc⟩ := posted
  simp only [hp] at h
  have hpt := postedTotals_spec hwf.sourceBasis hp
  rcases ha : appliedAdjustmentOf cumulative policy adjustment with e' | applied
  · simp only [ha, Except.error.injEq] at h
    subst h
    exact Or.inl (appliedAdjustmentOf_error hadj ha)
  simp only [ha] at h
  have heff : (pc.getD carrying).WF := by
    rcases hpt with ⟨-, -, rfl⟩ | ⟨-, plan, P, C, -, -, rfl, -, hCw, -⟩
    · simpa using hcw
    · simpa using hCw
  have happ : ∀ r, applied = some r → r.WF := by
    intro r hr
    rcases appliedAdjustmentOf_spec ha with ⟨-, a, q, r', ha', -, rfl, hr'w, -⟩ | ⟨rfl, -⟩
    · cases hr; exact hr'w
    · exact hadj r hr
  have hzero : (applied.getD ExactRational.zero).WF := by
    cases hap : applied with
    | none => exact ExactRational.zero_wf
    | some r => exact happ r hap
  rcases hn : liftNum ((pc.getD carrying).add (applied.getD ExactRational.zero)) with e' | after
  · simp only [hn, Except.error.injEq] at h
    subst h
    exact Or.inl (liftNum_limit (add_error_limit heff hzero) hn ▸ limitError_numeric)
  · simp [hn] at h

/-- A revision whose successor is required has it named and given an end, once the test of
`revisionIncoherent` passed. -/
theorem revisionIncoherent_false_successor {policy : AllocationPolicy} {bookId : BookId}
    {state : AllocationAccountingState} {original : AllocationSchedule}
    {recognitions : List AllocationRecognition} {request : AllocationScheduleRevisionRequest}
    {totals : RevisionTotals}
    (h : revisionIncoherent policy bookId state original recognitions request totals = false) :
    successorRequired request totals.afterAdjustment = true →
      request.revisedEndsOn.isSome = true := by
  intro hreq
  unfold revisionIncoherent at h
  simp only [Bool.or_eq_false_iff, and_assoc] at h
  obtain ⟨-, -, -, -, -, -, -, -, -, -, -, -, -, -, -, -, -, -, -, -, hends, -⟩ := h
  simp only [hreq, Bool.true_and] at hends
  cases hend : request.revisedEndsOn with
  | none => simp [hend] at hends
  | some _ => rfl

/-- A revision whose successor is required and named does not return a missing successor effect,
and what it throws is what the creation of the successor throws. -/
theorem revisionSuccessor_error {policies : List AccountingPolicy} {bookId : BookId}
    {policy : AllocationPolicy} {original : AllocationSchedule}
    {request : AllocationScheduleRevisionRequest} {totals : RevisionTotals} {e : ScheduleErr}
    (hpol : ∀ p ∈ policies, p.WF)
    (hsucc : successorRequired request totals.afterAdjustment = request.successorScheduleId.isSome)
    (hends : successorRequired request totals.afterAdjustment = true →
      request.revisedEndsOn.isSome = true)
    (hsreq : ∀ successorId revisedEndsOn, request.successorScheduleId = some successorId →
      request.revisedEndsOn = some revisedEndsOn →
        (successorRequest policy original request totals.afterAdjustment successorId
          revisedEndsOn).WF)
    (h : revisionSuccessor policies bookId policy original request totals = .error e) :
    NumericError e := by
  unfold revisionSuccessor at h
  by_cases hreq : successorRequired request totals.afterAdjustment = true
  · simp only [hreq, ↓reduceIte] at h
    rcases hid : request.successorScheduleId with _ | successorId
    · simp [hreq, hid] at hsucc
    rcases hend : request.revisedEndsOn with _ | revisedEndsOn
    · have := hends hreq
      simp [hend] at this
    simp only [hid, hend] at h
    have hwf := hsreq successorId revisedEndsOn hid hend
    rcases hc : createAllocationSchedule policies bookId
        (successorRequest policy original request totals.afterAdjustment successorId
          revisedEndsOn) with e' | created
    · simp only [successorRequest] at hc hwf
      simp only [hc, Except.error.injEq] at h
      subst h
      rcases createAllocationSchedule_error hpol hwf hc with rfl | rfl
      · exact limitError_numeric
      · exact ⟨_, rfl, Or.inl rfl⟩
    · rcases created with draft | diagnostics
      · simp only [successorRequest] at hc
        simp only [hc] at h
        obtain ⟨policy', allocable, amountsSum, totalBasis, amounts, dates, postingPlan, -, -, -, -,
          -, -, -, -, hd⟩ := createAllocationSchedule_draft_inv hc
        subst hd
        simp at h
      · simp only [successorRequest] at hc
        simp only [hc] at h
        cases h
  · simp [hreq] at h

end Schedules

/-- **The only errors of `reviseAllocationSchedule` are the size error and the `RangeError` of
`quantize`, the failure of `identifier` for one of the three identifiers it derives, and the
missing plan entry of a recognition's ordinal** (which `allocationPlanIsValid` rules out unless
two different plans have the same hash), never the missing successor effect. -/
theorem reviseAllocationSchedule_error {policies : List AccountingPolicy}
    {state : AllocationAccountingState} {bookId : BookId} {commodityId : CommodityId}
    {request : AllocationScheduleRevisionRequest} {e : ScheduleErr}
    (hpol : ∀ p ∈ policies, p.WF) (hstate : state.WF) (hreq : request.WF)
    (h : reviseAllocationSchedule policies state bookId commodityId request = .error e) :
    Schedules.NumericError e ∨
      (e = .identity .canonicalIdentityConflict ∧
        (journalId (request.id.value ++ "-journal") = .error .canonicalIdentityConflict ∨
          postingId (request.id.value ++ "-allocation") = .error .canonicalIdentityConflict ∨
          postingId (request.id.value ++ "-contra") = .error .canonicalIdentityConflict)) ∨
      (e = .missingPlanInstallment ∧ ∃ (original : AllocationSchedule)
        (plan : AllocationPostingPlan) (r : AllocationRecognition),
        state.allocationSchedules.find? (·.id == request.originalScheduleId) = some original ∧
        original.postingPlan = some plan ∧
        r ∈ state.allocationRecognitions.filter (·.scheduleId == original.id) ∧
        plan.installments.find? (·.ordinal == r.ordinal) = none) := by
  unfold reviseAllocationSchedule at h
  rcases hf : state.allocationSchedules.find? (·.id == request.originalScheduleId) with _ | original
  · simp [hf] at h
  have hwf : original.WF := hstate.allocationSchedules original (List.mem_of_find?_eq_some hf)
  rcases hpa : policyAt AllocationPolicy policies request.policyId request.policyVersion
      request.policyEffectiveAt with policy | diagnostics
  swap
  · simp [hf, hpa] at h
  simp only [hf, hpa] at h
  obtain ⟨hpolwf, -, hpid, hpver⟩ := policyAt_allocation_selected hpol hpa
  rcases hg : Schedules.planGate policy original
      (state.allocationRecognitions.filter (·.scheduleId == original.id)) with e' | gate
  · simp only [hg, Except.error.injEq] at h
    subst h
    -- the gate threw: `allocationPlanIsValid` threw
    unfold Schedules.planGate at hg
    by_cases hout : (usesCumulativeAllocation policy || original.postingPlan.isSome) = true
    · simp only [hout, ↓reduceIte] at hg
      by_cases hin : (!usesCumulativeAllocation policy || original.postingPlan.isNone) = true
      · simp [hin] at hg
      · simp only [hin, Bool.false_eq_true, ↓reduceIte] at hg
        rcases hv : Schedules.liftQuantize (allocationPlanIsValid original) with e'' | valid
        · simp only [hv, Except.error.injEq] at hg
          subst hg
          obtain ⟨qe, hqe, rfl⟩ := Schedules.liftQuantize_error hv
          exact Or.inl ⟨qe, rfl, allocationPlanIsValid_error hwf hqe⟩
        · cases valid <;> simp [hv] at hg
    · simp [hout] at hg
  cases gate
  · simp [hg] at h
  have hgate := Schedules.planGate_true hg
  have hplan : usesCumulativeAllocation policy = true → original.postingPlan.isSome = true := by
    intro hc
    rcases hgate with ⟨hc', -⟩ | ⟨-, hs, -⟩
    · rw [hc] at hc'; cases hc'
    · exact hs
  rcases ht : Schedules.revisionTotals policy (usesCumulativeAllocation policy) original
      (state.allocationRecognitions.filter (·.scheduleId == original.id))
      request.exactAdjustmentAmount with e' | totals
  · simp only [hg, ht, Except.error.injEq] at h
    subst h
    rcases Schedules.revisionTotals_error hwf hreq.exactAdjustmentAmount hplan ht with hne |
      ⟨he, plan, r, hp, hr, hfr⟩
    · exact Or.inl hne
    · exact Or.inr (Or.inr ⟨he, original, plan, r, hf, hp, hr, hfr⟩)
  simp only [hg, ht] at h
  obtain ⟨hrw, hcw, -, -, hposted, happlied, happ, heffw, hafterw, hafter⟩ :=
    Schedules.revisionTotals_spec hwf hreq.exactAdjustmentAmount ht
  by_cases hinc : Schedules.revisionIncoherent policy bookId state original
      (state.allocationRecognitions.filter (·.scheduleId == original.id)) request totals = true
  · simp [hinc] at h
  have hinc' := Bool.eq_false_iff.mpr hinc
  simp only [hinc, Bool.false_eq_true, ↓reduceIte] at h
  by_cases hearly : Schedules.earlierUnrecognized original
      (state.allocationRecognitions.filter (·.scheduleId == original.id)) request = true
  · simp [hearly] at h
  simp only [hearly, Bool.false_eq_true, ↓reduceIte] at h
  obtain ⟨-, -, -, -, -, -, -, -, -, -, -, -, hsucc⟩ := Schedules.revisionIncoherent_false hinc'
  have hends := Schedules.revisionIncoherent_false_successor hinc'
  rcases hs : Schedules.revisionSuccessor policies bookId policy original request totals with
    e' | succ
  · simp only [hs, Except.error.injEq] at h
    subst h
    refine Or.inl (Schedules.revisionSuccessor_error hpol hsucc hends ?_ hs)
    intro successorId revisedEndsOn hid hend
    exact ⟨hreq.successorScheduleId successorId hid, hpolwf.core.id, hreq.effectiveOn,
      hreq.revisedEndsOn revisedEndsOn hend, hwf.source, hwf.sourcePostingId, hafterw,
      hreq.revisedResidualValue, hreq.revisedUsage, hreq.derivation⟩
  rcases succ with rejection | successor
  · simp [hs] at h
  simp only [hs] at h
  rcases hadj : request.exactAdjustmentAmount with _ | adjustment
  · simp [hadj] at h
  · simp only [hadj] at h
    rcases hq : Schedules.liftQuantize (quantize adjustment policy.quantizationPolicy.rule) with
      e' | quantized
    · simp only [hq, Except.error.injEq] at h
      subst h
      obtain ⟨qe, hqe, rfl⟩ := Schedules.liftQuantize_error hq
      rcases Schedules.quantize_error_cases (hreq.exactAdjustmentAmount adjustment hadj) hqe with
        ⟨rfl, -⟩ | ⟨rfl, -, -⟩
      · exact Or.inl ⟨_, rfl, Or.inl rfl⟩
      · exact Or.inl ⟨_, rfl, Or.inr rfl⟩
    simp only [hq] at h
    rcases hj : Schedules.liftCanonical (journalId (request.id.value ++ "-journal")) with e' | jid
    · simp only [hj, Except.error.injEq] at h
      subst h
      obtain ⟨ce, hce, rfl⟩ := Schedules.liftCanonical_error hj
      have := identifier_error_conflict hce
      subst this
      exact Or.inr (Or.inl ⟨rfl, Or.inl hce⟩)
    simp only [hj] at h
    rcases hpa' : Schedules.liftCanonical (postingId (request.id.value ++ "-allocation")) with
      e' | pidAllocation
    · simp only [hpa', Except.error.injEq] at h
      subst h
      obtain ⟨ce, hce, rfl⟩ := Schedules.liftCanonical_error hpa'
      have := identifier_error_conflict hce
      subst this
      exact Or.inr (Or.inl ⟨rfl, Or.inr (Or.inl hce)⟩)
    simp only [hpa'] at h
    rcases hc : Schedules.liftCanonical (postingId (request.id.value ++ "-contra")) with e' | pidContra
    · simp only [hc, Except.error.injEq] at h
      subst h
      obtain ⟨ce, hce, rfl⟩ := Schedules.liftCanonical_error hc
      have := identifier_error_conflict hce
      subst this
      exact Or.inr (Or.inl ⟨rfl, Or.inr (Or.inr hce)⟩)
    simp [hc] at h

end Rastrata.Kernel

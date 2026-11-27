/-
The laws of `recognizeScheduledAllocation` (`accounting.ts` line 1630): the journal it produces is
balanced and for the planned amount, an instalment is recognised once, the effect has the hash of its
body, and every rejection with its diagnostic.
-/
import Rastrata.Kernel.Accounting.Schedules.Create

namespace Rastrata.Kernel

set_option linter.unusedSimpArgs false


/-- What `allocationPlanIsValid` accepting a schedule means: the policy names no posting algorithm and
the schedule has no plan; or the policy is cumulative with two distinct accounts, the posted basis is
exact, and the plan the schedule carries has the same hash as the plan `planAllocationPostings`
recomputes from it. -/
theorem allocationPlanIsValid_true {schedule : AllocationSchedule}
    (h : allocationPlanIsValid schedule = .ok true) :
    (schedule.policy.postingAlgorithm = none ∧ schedule.postingPlan = none) ∨
      (schedule.policy.postingAlgorithm ≠ none ∧ usesCumulativeAllocation schedule.policy = true ∧
        schedule.policy.allocationAccountId ≠ schedule.policy.contraAccountId ∧
        ∃ (source : QuantizedValue) (carried recomputed : AllocationPostingPlan),
          quantize schedule.sourceBasis schedule.policy.quantizationPolicy.rule = .ok source ∧
          source.residual.isZero = true ∧ schedule.postingPlan = some carried ∧
          planAllocationPostings
              { exactSourceBasis := schedule.sourceBasis,
                exactResidualValue := schedule.residualValue, postedSourceBasis := source.amount,
                quantizationPolicy := schedule.policy.quantizationPolicy,
                installments := schedule.installments } = .ok (.planned recomputed) ∧
          accountingHash "AllocationPostingPlanValue" carried =
            accountingHash "AllocationPostingPlanValue" recomputed) := by
  unfold allocationPlanIsValid at h
  by_cases hnone : schedule.policy.postingAlgorithm = none
  · simp only [hnone, ↓reduceIte, Except.ok.injEq] at h
    exact Or.inl ⟨hnone, by simpa using h⟩
  · simp only [hnone, ↓reduceIte] at h
    by_cases hbad : (!usesCumulativeAllocation schedule.policy ||
        schedule.policy.allocationAccountId == schedule.policy.contraAccountId) = true
    · simp [hbad] at h
    simp only [hbad, Bool.false_eq_true, ↓reduceIte] at h
    simp only [Bool.or_eq_true, Bool.not_eq_true', beq_iff_eq, not_or] at hbad
    rcases hq : quantize schedule.sourceBasis schedule.policy.quantizationPolicy.rule with e | source
    · rw [hq] at h; cases h
    simp only [hq] at h
    by_cases hres : (!source.residual.isZero) = true
    · simp [hres] at h
    simp only [hres, Bool.false_eq_true, ↓reduceIte] at h
    rcases hp : schedule.postingPlan with _ | carried
    · simp [hp] at h
    simp only [hp] at h
    rcases hpl : planAllocationPostings
        { exactSourceBasis := schedule.sourceBasis, exactResidualValue := schedule.residualValue,
          postedSourceBasis := source.amount, quantizationPolicy := schedule.policy.quantizationPolicy,
          installments := schedule.installments } with e | result
    · rw [hpl] at h; cases h
    rcases result with recomputed | diagnostics
    · simp only [hpl, Except.ok.injEq] at h
      refine Or.inr ⟨hnone, (by simpa using hbad.1), hbad.2, source, carried, recomputed, rfl, ?_, rfl, hpl, ?_⟩
      · simpa using hres
      · have := (contentHashEquals_iff _ _).mp h
        exact this
    · simp [hpl] at h


/-- The steps of a call that produced a draft: the schedule and the installment exist, the
recognition is not refused, the plan check passes, the planned amount and the three identifiers are
made. -/
theorem recognizeScheduledAllocation_draft_inv {policies : List AccountingPolicy}
    {state : AllocationAccountingState} {commodityId : CommodityId}
    {request : AllocationRecognitionRequest} {d : AccountingDraft}
    (h : recognizeScheduledAllocation policies state commodityId request = .ok (.draft d)) :
    ∃ (schedule : AllocationSchedule) (installment : ScheduledAllocation) (amount : ExactRational)
      (jid : JournalId) (pidExpense pidContra : PostingId),
      state.allocationSchedules.find? (·.id == request.scheduleId) = some schedule ∧
      schedule.installments.find? (·.ordinal == request.ordinal) = some installment ∧
      Schedules.recognitionRefused state request installment = false ∧
      allocationPlanIsValid schedule = .ok true ∧
      Schedules.plannedAmount schedule installment request.ordinal = .ok amount ∧
      journalId (request.id.value ++ "-journal") = .ok jid ∧
      postingId (request.id.value ++ "-expense") = .ok pidExpense ∧
      postingId (request.id.value ++ "-contra") = .ok pidContra ∧
      d = { journals := [Schedules.recognitionJournal request schedule installment commodityId
              amount jid pidExpense pidContra],
            effects := [.allocationRecognition (Schedules.recognitionEffect request)] } := by
  unfold recognizeScheduledAllocation at h
  rcases hs : state.allocationSchedules.find? (·.id == request.scheduleId) with _ | schedule
  · simp [hs, Schedules.recognitionRejection, reject_eq] at h
  rcases hi : schedule.installments.find? (·.ordinal == request.ordinal) with _ | installment
  · simp [hs, hi, Schedules.recognitionRejection, reject_eq] at h
  simp only [hs, hi, Option.bind_some] at h
  by_cases hrefused : Schedules.recognitionRefused state request installment = true
  · simp [hrefused, Schedules.recognitionRejection, reject_eq] at h
  have hrefused' : Schedules.recognitionRefused state request installment = false :=
    Bool.eq_false_iff.mpr hrefused
  simp only [hrefused, Bool.false_eq_true, ↓reduceIte] at h
  rcases hv : Schedules.liftQuantize (allocationPlanIsValid schedule) with e | valid
  · rw [hv] at h; cases h
  cases valid
  · simp [hv, Schedules.recognitionPostingPlanRejection, reject_eq] at h
  simp only [hv] at h
  rcases ha : Schedules.plannedAmount schedule installment request.ordinal with e | amount
  · rw [ha] at h; cases h
  simp only [ha] at h
  rcases hj : Schedules.liftCanonical (journalId (request.id.value ++ "-journal")) with e | jid
  · rw [hj] at h; cases h
  simp only [hj] at h
  rcases he : Schedules.liftCanonical (postingId (request.id.value ++ "-expense")) with e | pidExpense
  · rw [he] at h; cases h
  simp only [he] at h
  rcases hc : Schedules.liftCanonical (postingId (request.id.value ++ "-contra")) with e | pidContra
  · rw [hc] at h; cases h
  simp only [hc, drafted_eq, Except.ok.injEq, AccountingCalculation.draft.injEq] at h
  exact ⟨schedule, installment, amount, jid, pidExpense, pidContra, hs, hi, hrefused',
    Schedules.liftQuantize_ok hv, ha, Schedules.liftCanonical_ok hj, Schedules.liftCanonical_ok he,
    Schedules.liftCanonical_ok hc, h.symm⟩


/-- **The recognition produces a balanced journal for exactly the planned amount**: the journal has
two postings, the allocation account debited and the contra account credited by the same amount, in
units and in exact book value, so the exact book values add up to zero; the amount is the posted
amount the schedule's plan holds for the ordinal, or the instalment's exact amount when the schedule
has no plan entry for it; and the journal is dated on the instalment's date. -/
theorem recognizeScheduledAllocation_journal {policies : List AccountingPolicy}
    {state : AllocationAccountingState} {commodityId : CommodityId}
    {request : AllocationRecognitionRequest} {journal : ExactPreparedJournal}
    {effect : AllocationRecognition}
    (h : recognizeScheduledAllocation policies state commodityId request =
      .ok (drafted [journal] [.allocationRecognition effect])) :
    ∃ (schedule : AllocationSchedule) (installment : ScheduledAllocation) (amount : ExactRational),
      state.allocationSchedules.find? (·.id == request.scheduleId) = some schedule ∧
      schedule.installments.find? (·.ordinal == request.ordinal) = some installment ∧
      Schedules.plannedAmount schedule installment request.ordinal = .ok amount ∧
      journal.postings.map (·.exactBookValue) = [amount, amount.negate] ∧
      journal.postings.map (·.units) = [amount, amount.negate] ∧
      journal.postings.map (·.accountId) =
        [schedule.policy.allocationAccountId, schedule.policy.contraAccountId] ∧
      (journal.postings.map (·.exactBookValue.toRat)).sum = 0 ∧
      (journal.postings.map (·.units.toRat)).sum = 0 ∧
      journal.accountingDate = installment.accountingDate ∧ journal.kind = .adjustment ∧
      journal.economicAt = request.governedAt ∧ journal.recordedAt = request.governedAt ∧
      journal.derivations = [request.derivation] ∧
      (schedule.postingPlan = none → amount = installment.amount) ∧
      (∀ plan planInstallment, schedule.postingPlan = some plan →
        plan.installments.find? (·.ordinal == request.ordinal) = some planInstallment →
          amount.toRat = planInstallment.postedAmount.toRat) := by
  obtain ⟨schedule, installment, amount, jid, pidExpense, pidContra, hs, hi, -, -, ha, -, -, -, hd⟩ :=
    recognizeScheduledAllocation_draft_inv
      (d := { journals := [journal], effects := [.allocationRecognition effect] }) h
  simp only [AccountingDraft.mk.injEq, List.cons.injEq, and_true] at hd
  obtain ⟨hj, -⟩ := hd
  subst hj
  refine ⟨schedule, installment, amount, hs, hi, ha, rfl, rfl, rfl, ?_, ?_, rfl, rfl, rfl, rfl, rfl,
    ?_, ?_⟩
  · simp [Schedules.recognitionJournal, ExactRational.negate_toRat]
  · simp [Schedules.recognitionJournal, ExactRational.negate_toRat]
  · intro hnone
    unfold Schedules.plannedAmount at ha
    simp [hnone] at ha
    exact ha.symm
  · intro plan planInstallment hplan hfind
    unfold Schedules.plannedAmount at ha
    simp only [hplan, hfind, Option.bind_some] at ha
    have hr := Schedules.liftNum_ok ha
    unfold ExactDecimal.toRational at hr
    have hrat := (ExactRational.of_ok hr).2.1
    unfold ExactDecimal.toRat
    push_cast at hrat ⊢
    exact hrat


/-- **An instalment is recognised once**: when a call recognised an instalment, no recognition of
that identity or of that instalment of that schedule existed; and once the recognition is in the
state, a request for the same instalment of the same schedule, whatever its identity, is refused
with the recognition rejection. -/
theorem recognizeScheduledAllocation_once {policies : List AccountingPolicy}
    {state : AllocationAccountingState} {commodityId : CommodityId}
    {request : AllocationRecognitionRequest} {journal : ExactPreparedJournal}
    {effect : AllocationRecognition}
    (h : recognizeScheduledAllocation policies state commodityId request =
      .ok (drafted [journal] [.allocationRecognition effect])) :
    (∀ item ∈ state.allocationRecognitions, item.id ≠ request.id ∧
        ¬ (item.scheduleId = request.scheduleId ∧ item.ordinal = request.ordinal)) ∧
      ∀ request' : AllocationRecognitionRequest, request'.scheduleId = request.scheduleId →
        request'.ordinal = request.ordinal →
          recognizeScheduledAllocation policies
            { state with allocationRecognitions := state.allocationRecognitions ++ [effect] }
            commodityId request' = .ok Schedules.recognitionRejection := by
  obtain ⟨schedule, installment, amount, jid, pidExpense, pidContra, hs, hi, hnot, -, -, -, -, -,
    hd⟩ := recognizeScheduledAllocation_draft_inv
      (d := { journals := [journal], effects := [.allocationRecognition effect] }) h
  simp only [AccountingDraft.mk.injEq, List.cons.injEq, AccountingEffect.allocationRecognition.injEq,
    and_true] at hd
  obtain ⟨-, rfl⟩ := hd
  constructor
  · intro item hitem
    unfold Schedules.recognitionRefused Schedules.alreadyRecognized at hnot
    simp only [Bool.or_eq_false_iff, List.any_eq_false] at hnot
    have := hnot.2 item hitem
    simp only [Bool.or_eq_true, Bool.and_eq_true, beq_iff_eq, not_or, not_and] at this
    exact ⟨this.1, fun hh => this.2 hh.1 hh.2⟩
  · intro request' hsched hord
    unfold recognizeScheduledAllocation
    have hs' : List.find? (fun x => x.id == request'.scheduleId) state.allocationSchedules =
        some schedule := by rw [hsched]; exact hs
    have hi' : List.find? (fun x => x.ordinal == request'.ordinal) schedule.installments =
        some installment := by rw [hord]; exact hi
    simp only [hs', hi', Option.bind_some]
    have href : Schedules.recognitionRefused
        { state with allocationRecognitions :=
          state.allocationRecognitions ++ [Schedules.recognitionEffect request] } request'
        installment = true := by
      unfold Schedules.recognitionRefused Schedules.alreadyRecognized
      simp [Schedules.recognitionEffect, hsched, hord]
    simp [href]


/-- **The recognition rejection** (`command.recognition`, `ACC-044.4`, `ACC-044.5`; line 1634): the
call returns it exactly when the schedule is not in the state, or it has no installment of that
ordinal, or the recognition is refused (`recognitionRefused`: the installment is superseded by a
revision that disposes of the schedule, terminates it or takes effect on or before the
installment's date; the derivation is not approved with evidence; or a recognition of that identity
or of that installment of that schedule exists). -/
theorem recognizeScheduledAllocation_refused_iff {policies : List AccountingPolicy}
    {state : AllocationAccountingState} {commodityId : CommodityId}
    {request : AllocationRecognitionRequest} :
    recognizeScheduledAllocation policies state commodityId request =
        .ok Schedules.recognitionRejection ↔
      state.allocationSchedules.find? (·.id == request.scheduleId) = none ∨
        (∃ schedule, state.allocationSchedules.find? (·.id == request.scheduleId) = some schedule ∧
          schedule.installments.find? (·.ordinal == request.ordinal) = none) ∨
        ∃ schedule installment,
          state.allocationSchedules.find? (·.id == request.scheduleId) = some schedule ∧
          schedule.installments.find? (·.ordinal == request.ordinal) = some installment ∧
          Schedules.recognitionRefused state request installment = true := by
  constructor
  · intro h
    unfold recognizeScheduledAllocation at h
    rcases hs : state.allocationSchedules.find? (·.id == request.scheduleId) with _ | schedule
    · exact Or.inl hs
    rcases hi : schedule.installments.find? (·.ordinal == request.ordinal) with _ | installment
    · exact Or.inr (Or.inl ⟨schedule, hs, hi⟩)
    simp only [hs, hi, Option.bind_some] at h
    by_cases hr : Schedules.recognitionRefused state request installment = true
    · exact Or.inr (Or.inr ⟨schedule, installment, hs, hi, hr⟩)
    · exfalso
      simp only [hr, Bool.false_eq_true, ↓reduceIte] at h
      rcases hv : Schedules.liftQuantize (allocationPlanIsValid schedule) with e | valid
      · rw [hv] at h; cases h
      cases valid
      · simp [hv, Schedules.recognitionPostingPlanRejection, Schedules.recognitionRejection,
          reject_eq] at h
      · simp only [hv] at h
        rcases ha : Schedules.plannedAmount schedule installment request.ordinal with e | amount
        · rw [ha] at h; cases h
        simp only [ha] at h
        rcases hj : Schedules.liftCanonical (journalId (request.id.value ++ "-journal")) with e | jid
        · rw [hj] at h; cases h
        simp only [hj] at h
        rcases he : Schedules.liftCanonical (postingId (request.id.value ++ "-expense")) with
          e | pidExpense
        · rw [he] at h; cases h
        simp only [he] at h
        rcases hc : Schedules.liftCanonical (postingId (request.id.value ++ "-contra")) with
          e | pidContra
        · rw [hc] at h; cases h
        simp [hc, Schedules.recognitionRejection, reject_eq, drafted_eq] at h
  · rintro (hnone | ⟨schedule, hs, hnone⟩ | ⟨schedule, installment, hs, hi, hr⟩)
    · unfold recognizeScheduledAllocation
      simp [hnone]
    · unfold recognizeScheduledAllocation
      simp [hs, hnone]
    · unfold recognizeScheduledAllocation
      simp [hs, hi, hr]


/-- **The posting-plan rejection** (`command.recognition.postingPlan`, `ACC-044.3`; line 1635): once
the schedule and the installment are found and the recognition is not refused, the call returns it
exactly when `allocationPlanIsValid` says the schedule's retained algorithm and posting plan do not
agree. -/
theorem recognizeScheduledAllocation_planRejected_iff {policies : List AccountingPolicy}
    {state : AllocationAccountingState} {commodityId : CommodityId}
    {request : AllocationRecognitionRequest} :
    recognizeScheduledAllocation policies state commodityId request =
        .ok Schedules.recognitionPostingPlanRejection ↔
      ∃ schedule installment,
        state.allocationSchedules.find? (·.id == request.scheduleId) = some schedule ∧
        schedule.installments.find? (·.ordinal == request.ordinal) = some installment ∧
        Schedules.recognitionRefused state request installment = false ∧
        allocationPlanIsValid schedule = .ok false := by
  constructor
  · intro h
    unfold recognizeScheduledAllocation at h
    rcases hs : state.allocationSchedules.find? (·.id == request.scheduleId) with _ | schedule
    · simp [hs, Schedules.recognitionPostingPlanRejection, Schedules.recognitionRejection,
        reject_eq] at h
    rcases hi : schedule.installments.find? (·.ordinal == request.ordinal) with _ | installment
    · simp [hs, hi, Schedules.recognitionPostingPlanRejection, Schedules.recognitionRejection,
        reject_eq] at h
    simp only [hs, hi, Option.bind_some] at h
    by_cases hr : Schedules.recognitionRefused state request installment = true
    · simp [hr, Schedules.recognitionPostingPlanRejection, Schedules.recognitionRejection,
        reject_eq] at h
    have hr' : Schedules.recognitionRefused state request installment = false :=
      Bool.eq_false_iff.mpr hr
    simp only [hr, Bool.false_eq_true, ↓reduceIte] at h
    rcases hv : Schedules.liftQuantize (allocationPlanIsValid schedule) with e | valid
    · rw [hv] at h; cases h
    cases valid
    · exact ⟨schedule, installment, hs, hi, hr', Schedules.liftQuantize_ok hv⟩
    · simp only [hv] at h
      rcases ha : Schedules.plannedAmount schedule installment request.ordinal with e | amount
      · rw [ha] at h; cases h
      simp only [ha] at h
      rcases hj : Schedules.liftCanonical (journalId (request.id.value ++ "-journal")) with e | jid
      · rw [hj] at h; cases h
      simp only [hj] at h
      rcases he : Schedules.liftCanonical (postingId (request.id.value ++ "-expense")) with
        e | pidExpense
      · rw [he] at h; cases h
      simp only [he] at h
      rcases hc : Schedules.liftCanonical (postingId (request.id.value ++ "-contra")) with
        e | pidContra
      · rw [hc] at h; cases h
      simp [hc, Schedules.recognitionPostingPlanRejection, reject_eq, drafted_eq] at h
  · rintro ⟨schedule, installment, hs, hi, hr, hv⟩
    unfold recognizeScheduledAllocation
    simp [hs, hi, hr, Schedules.liftQuantize, hv]

/-- **The recognition has the hash of its body**: the effect's content hash is
`accountingHash("AllocationRecognition", body)` of the recognition without it, and the kernel's own
hash check accepts the effect. -/
theorem recognizeScheduledAllocation_hash {policies : List AccountingPolicy}
    {state : AllocationAccountingState} {commodityId : CommodityId}
    {request : AllocationRecognitionRequest} {journal : ExactPreparedJournal}
    {effect : AllocationRecognition}
    (h : recognizeScheduledAllocation policies state commodityId request =
      .ok (drafted [journal] [.allocationRecognition effect])) :
    effect.contentHash = accountingBodyHash "AllocationRecognition" effect ∧
      validateAccountingEffectHash (.allocationRecognition effect) = .ok true := by
  obtain ⟨schedule, installment, amount, jid, pidExpense, pidContra, -, -, -, -, -, -, -, -, hd⟩ :=
    recognizeScheduledAllocation_draft_inv
      (d := { journals := [journal], effects := [.allocationRecognition effect] }) h
  simp only [AccountingDraft.mk.injEq, List.cons.injEq, AccountingEffect.allocationRecognition.injEq,
    and_true] at hd
  obtain ⟨-, rfl⟩ := hd
  have hhash : (Schedules.recognitionEffect request).contentHash =
      accountingBodyHash "AllocationRecognition" (Schedules.recognitionEffect request) :=
    AllocationRecognition.contentHash_of_body _
  refine ⟨hhash, ?_⟩
  rw [validateAccountingEffectHash_true_iff]
  exact ⟨rfl, rfl, hhash⟩

/-- `identifier` fails only with the identity conflict. -/
theorem identifier_error_conflict {Kind : String} {s : String} {ce : CanonicalErr}
    (h : identifier Kind s = .error ce) : ce = .canonicalIdentityConflict := by
  unfold identifier at h
  split_ifs at h <;> cases h <;> rfl

/-- `allocationPlanIsValid` throws, on a constructible schedule, only the `RangeError` of `quantize` or
the size error. -/
theorem allocationPlanIsValid_error {schedule : AllocationSchedule} {qe : QuantizeErr}
    (hwf : schedule.WF) (h : allocationPlanIsValid schedule = .error qe) :
    qe = .scaleOutOfRange ∨ qe = .exactNumber .representationLimitExceeded := by
  unfold allocationPlanIsValid at h
  by_cases hnone : schedule.policy.postingAlgorithm = none
  · simp [hnone] at h
  simp only [hnone, ↓reduceIte] at h
  by_cases hbad : (!usesCumulativeAllocation schedule.policy ||
      schedule.policy.allocationAccountId == schedule.policy.contraAccountId) = true
  · simp [hbad] at h
  simp only [hbad, Bool.false_eq_true, ↓reduceIte] at h
  rcases hq : quantize schedule.sourceBasis schedule.policy.quantizationPolicy.rule with e | source
  · simp only [hq, Except.error.injEq] at h
    subst h
    rcases Schedules.quantize_error_cases hwf.sourceBasis hq with ⟨rfl, -⟩ | ⟨rfl, -, -⟩
    · exact Or.inl rfl
    · exact Or.inr rfl
  obtain ⟨hsrcw, -⟩ := quantize_ok hwf.sourceBasis hq
  simp only [hq] at h
  by_cases hres : (!source.residual.isZero) = true
  · simp [hres] at h
  simp only [hres, Bool.false_eq_true, ↓reduceIte] at h
  rcases hp : schedule.postingPlan with _ | carried
  · simp [hp] at h
  simp only [hp] at h
  rcases hpl : planAllocationPostings
      { exactSourceBasis := schedule.sourceBasis, exactResidualValue := schedule.residualValue,
        postedSourceBasis := source.amount, quantizationPolicy := schedule.policy.quantizationPolicy,
        installments := schedule.installments } with e | result
  · simp only [hpl, Except.error.injEq] at h
    subst h
    have hw : (AllocationPostingPlanInput.mk schedule.sourceBasis schedule.residualValue source.amount
        schedule.policy.quantizationPolicy schedule.installments).WF :=
      ⟨hwf.sourceBasis, hwf.residualValue, hsrcw, hwf.policy.core.quantizationPolicy,
        hwf.installments⟩
    rcases planAllocationPostings_error hw hpl with ⟨rfl, -⟩ | rfl
    · exact Or.inl rfl
    · exact Or.inr rfl
  · rcases result with plan | diagnostics <;> simp [hpl] at h


/-- The planned amount of a constructible schedule never fails to convert. -/
theorem Schedules.plannedAmount_ne_error {schedule : AllocationSchedule}
    {installment : ScheduledAllocation} {ordinal : Int} {e : ScheduleErr}
    (hwf : schedule.WF) : Schedules.plannedAmount schedule installment ordinal ≠ .error e := by
  intro h
  unfold Schedules.plannedAmount at h
  rcases hf : schedule.postingPlan.bind
      (fun plan => plan.installments.find? (·.ordinal == ordinal)) with _ | planInstallment
  · simp [hf] at h
  · simp only [hf] at h
    obtain ⟨plan, hplan, hfind⟩ : ∃ plan, schedule.postingPlan = some plan ∧
        plan.installments.find? (·.ordinal == ordinal) = some planInstallment := by
      cases hp : schedule.postingPlan with
      | none => simp [hp] at hf
      | some plan => simp [hp] at hf; exact ⟨plan, rfl, hf⟩
    have hmem := List.mem_of_find?_eq_some hfind
    have hpw := (hwf.postingPlan plan hplan).installments planInstallment hmem
    obtain ⟨code, hcode, -⟩ := Schedules.liftNum_error h
    exact ExactDecimal.toRational_ne_error hpw.postedAmount code hcode

/-- **The only errors of `recognizeScheduledAllocation` are the `RangeError` of `quantize` or the
size error in the plan check, and the failure of `identifier` for one of the three identifiers
it derives from the recognition's identity.** -/
theorem recognizeScheduledAllocation_error {policies : List AccountingPolicy}
    {state : AllocationAccountingState} {commodityId : CommodityId}
    {request : AllocationRecognitionRequest} {e : ScheduleErr}
    (hstate : state.WF)
    (h : recognizeScheduledAllocation policies state commodityId request = .error e) :
    (∃ qe, e = .quantize qe ∧ (qe = .scaleOutOfRange ∨ qe = .exactNumber .representationLimitExceeded)) ∨
      (e = .identity .canonicalIdentityConflict ∧
        (journalId (request.id.value ++ "-journal") = .error .canonicalIdentityConflict ∨
          postingId (request.id.value ++ "-expense") = .error .canonicalIdentityConflict ∨
          postingId (request.id.value ++ "-contra") = .error .canonicalIdentityConflict)) := by
  unfold recognizeScheduledAllocation at h
  rcases hs : state.allocationSchedules.find? (·.id == request.scheduleId) with _ | schedule
  · simp [hs] at h
  have hwf : schedule.WF := hstate.allocationSchedules schedule (List.mem_of_find?_eq_some hs)
  rcases hi : schedule.installments.find? (·.ordinal == request.ordinal) with _ | installment
  · simp [hs, hi] at h
  simp only [hs, hi, Option.bind_some] at h
  by_cases hr : Schedules.recognitionRefused state request installment = true
  · simp [hr] at h
  simp only [hr, Bool.false_eq_true, ↓reduceIte] at h
  rcases hv : Schedules.liftQuantize (allocationPlanIsValid schedule) with e' | valid
  · simp only [hv, Except.error.injEq] at h
    subst h
    obtain ⟨qe, hqe, rfl⟩ := Schedules.liftQuantize_error hv
    exact Or.inl ⟨qe, rfl, allocationPlanIsValid_error hwf hqe⟩
  cases valid
  · simp [hv] at h
  simp only [hv] at h
  rcases ha : Schedules.plannedAmount schedule installment request.ordinal with e' | amount
  · exact absurd ha (Schedules.plannedAmount_ne_error hwf)
  simp only [ha] at h
  rcases hj : Schedules.liftCanonical (journalId (request.id.value ++ "-journal")) with e' | jid
  · simp only [hj, Except.error.injEq] at h
    subst h
    obtain ⟨ce, hce, rfl⟩ := Schedules.liftCanonical_error hj
    have := identifier_error_conflict hce
    subst this
    exact Or.inr ⟨rfl, Or.inl hce⟩
  simp only [hj] at h
  rcases he : Schedules.liftCanonical (postingId (request.id.value ++ "-expense")) with e' | pidExpense
  · simp only [he, Except.error.injEq] at h
    subst h
    obtain ⟨ce, hce, rfl⟩ := Schedules.liftCanonical_error he
    have := identifier_error_conflict hce
    subst this
    exact Or.inr ⟨rfl, Or.inr (Or.inl hce)⟩
  simp only [he] at h
  rcases hc : Schedules.liftCanonical (postingId (request.id.value ++ "-contra")) with e' | pidContra
  · simp only [hc, Except.error.injEq] at h
    subst h
    obtain ⟨ce, hce, rfl⟩ := Schedules.liftCanonical_error hc
    have := identifier_error_conflict hce
    subst this
    exact Or.inr ⟨rfl, Or.inr (Or.inr hce)⟩
  simp [hc] at h

end Rastrata.Kernel

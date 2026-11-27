/-
The laws of `createAllocationSchedule` (`accounting.ts` line 1574): what a schedule it produces
satisfies, why it rejects, and what it throws.
-/
import Rastrata.Kernel.Accounting.Schedules.Generate

namespace Rastrata.Kernel

namespace Schedules

/-- The input `createPlan` hands to `planAllocationPostings` (lines 1609 to 1611). -/
def planInput (policy : AllocationPolicy) (request : AllocationScheduleRequest)
    (source : QuantizedValue) (installments : List ScheduledAllocation) :
    AllocationPostingPlanInput :=
  { exactSourceBasis := request.sourceBasis, exactResidualValue := request.residualValue,
    postedSourceBasis := source.amount, quantizationPolicy := policy.quantizationPolicy,
    installments := installments }

end Schedules

/-- A schedule is refused its posting plan for exactly one of two reasons, once the policy is
cumulative and its posted basis rounded: the posted source basis is not exact or the two
recognition accounts are one; or `planAllocationPostings` rejects the schedule. -/
theorem createPlan_inl {policy : AllocationPolicy} {request : AllocationScheduleRequest}
    {installments : List ScheduledAllocation} {x : AccountingCalculation}
    (h : Schedules.createPlan policy request installments = .ok (.inl x)) :
    usesCumulativeAllocation policy = true ∧
      ∃ source, quantize request.sourceBasis policy.quantizationPolicy.rule = .ok source ∧
        ((!source.residual.isZero || policy.allocationAccountId == policy.contraAccountId) = true ∧
            x = Schedules.createPostingPlanRejection ∨
          (!source.residual.isZero || policy.allocationAccountId == policy.contraAccountId) = false ∧
            ∃ diagnostics, planAllocationPostings
              (Schedules.planInput policy request source installments) =
                .ok (.rejected diagnostics) ∧ x = .rejected diagnostics) := by
  unfold Schedules.createPlan at h
  by_cases hc : usesCumulativeAllocation policy = true
  · simp only [hc, ↓reduceIte] at h
    refine ⟨hc, ?_⟩
    rcases hq : Schedules.liftQuantize (quantize request.sourceBasis policy.quantizationPolicy.rule)
      with e | source
    · rw [hq] at h
      cases h
    refine ⟨source, Schedules.liftQuantize_ok hq, ?_⟩
    simp only [hq] at h
    by_cases hbad : (!source.residual.isZero || policy.allocationAccountId == policy.contraAccountId) = true
    · simp only [hbad, ↓reduceIte, Except.ok.injEq, Sum.inl.injEq] at h
      subst h
      exact Or.inl ⟨hbad, rfl⟩
    simp only [hbad, Bool.false_eq_true, ↓reduceIte] at h
    have hbad' := Bool.eq_false_iff.mpr hbad
    rcases hp : Schedules.liftQuantize (planAllocationPostings
        (Schedules.planInput policy request source installments)) with e | result
    · simp only [Schedules.planInput] at hp
      rw [hp] at h
      cases h
    rcases result with plan | diagnostics
    · simp only [Schedules.planInput] at hp
      rw [hp] at h
      cases h
    · refine Or.inr ⟨hbad', diagnostics, Schedules.liftQuantize_ok hp, ?_⟩
      simp only [Schedules.planInput] at hp
      rw [hp] at h
      simp only [Except.ok.injEq, Sum.inl.injEq] at h
      exact h.symm
  · simp [hc] at h

/-- When `createPlan` returns a plan, or none, the policy is cumulative with a plan that
`planAllocationPostings` made from an exact posted basis and two distinct accounts; or it is not
cumulative and there is none. -/
theorem createPlan_inr {policy : AllocationPolicy} {request : AllocationScheduleRequest}
    {installments : List ScheduledAllocation} {postingPlan : Option AllocationPostingPlan}
    (h : Schedules.createPlan policy request installments = .ok (.inr postingPlan)) :
    (usesCumulativeAllocation policy = false ∧ postingPlan = none) ∨
      (usesCumulativeAllocation policy = true ∧
        ∃ source plan, quantize request.sourceBasis policy.quantizationPolicy.rule = .ok source ∧
          source.residual.isZero = true ∧ policy.allocationAccountId ≠ policy.contraAccountId ∧
          planAllocationPostings (Schedules.planInput policy request source installments) =
            .ok (.planned plan) ∧ postingPlan = some plan) := by
  unfold Schedules.createPlan at h
  by_cases hc : usesCumulativeAllocation policy = true
  · simp only [hc, ↓reduceIte] at h
    refine Or.inr ⟨hc, ?_⟩
    rcases hq : Schedules.liftQuantize (quantize request.sourceBasis policy.quantizationPolicy.rule)
      with e | source
    · rw [hq] at h
      cases h
    simp only [hq] at h
    by_cases hbad : (!source.residual.isZero || policy.allocationAccountId == policy.contraAccountId) = true
    · simp [hbad] at h
    simp only [hbad, Bool.false_eq_true, ↓reduceIte] at h
    rcases hp : Schedules.liftQuantize (planAllocationPostings
        (Schedules.planInput policy request source installments)) with e | result
    · simp only [Schedules.planInput] at hp
      rw [hp] at h
      cases h
    rcases result with plan | diagnostics
    · have hp' := Schedules.liftQuantize_ok hp
      simp only [Schedules.planInput] at hp
      rw [hp] at h
      simp only [Except.ok.injEq, Sum.inr.injEq] at h
      subst h
      simp only [Bool.or_eq_true, Bool.not_eq_true', beq_iff_eq, not_or] at hbad
      refine ⟨source, plan, Schedules.liftQuantize_ok hq, ?_, hbad.2, hp', rfl⟩
      simpa using hbad.1
    · simp only [Schedules.planInput] at hp
      rw [hp] at h
      cases h
  · refine Or.inl ⟨by simpa using hc, ?_⟩
    simp only [hc, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq, Sum.inr.injEq] at h
    exact h.symm

/-- A cumulative policy whose posted source basis is not exact, or whose two accounts are one, is
refused its plan. -/
theorem createPlan_basis_rejected {policy : AllocationPolicy}
    {request : AllocationScheduleRequest} {installments : List ScheduledAllocation}
    {source : QuantizedValue} (hc : usesCumulativeAllocation policy = true)
    (hq : quantize request.sourceBasis policy.quantizationPolicy.rule = .ok source)
    (hbad : (!source.residual.isZero || policy.allocationAccountId == policy.contraAccountId) = true) :
    Schedules.createPlan policy request installments =
      .ok (.inl Schedules.createPostingPlanRejection) := by
  unfold Schedules.createPlan
  simp [hc, Schedules.liftQuantize, hq, hbad]

/-- A cumulative policy whose posted basis is exact and whose accounts differ is refused its plan
exactly when `planAllocationPostings` rejects the schedule, with that rejection's diagnostics. -/
theorem createPlan_planner_rejected {policy : AllocationPolicy}
    {request : AllocationScheduleRequest} {installments : List ScheduledAllocation}
    {source : QuantizedValue} {diagnostics : List SemanticDiagnostic}
    (hc : usesCumulativeAllocation policy = true)
    (hq : quantize request.sourceBasis policy.quantizationPolicy.rule = .ok source)
    (hok : (!source.residual.isZero || policy.allocationAccountId == policy.contraAccountId) = false)
    (hp : planAllocationPostings (Schedules.planInput policy request source installments) =
      .ok (.rejected diagnostics)) :
    Schedules.createPlan policy request installments = .ok (.inl (.rejected diagnostics)) := by
  unfold Schedules.createPlan
  simp only [hc, ↓reduceIte, Schedules.liftQuantize, hq, hok, Bool.false_eq_true]
  simp only [Schedules.planInput] at hp
  rw [hp]

/-- A call that is not cumulative has no plan. -/
theorem createPlan_none {policy : AllocationPolicy} {request : AllocationScheduleRequest}
    {installments : List ScheduledAllocation} (hc : usesCumulativeAllocation policy = false) :
    Schedules.createPlan policy request installments = .ok (.inr none) := by
  unfold Schedules.createPlan
  simp [hc]

/-- Every constant rejection is a rejection, never a draft. -/
theorem Schedules.rejection_ne_draft {x : AccountingCalculation} {d : AccountingDraft}
    (h : x = Schedules.createPolicyRejection ∨ x = Schedules.createSpanRejection ∨
      x = Schedules.createDecliningRateRejection ∨ x = Schedules.createUsageBoundRejection ∨
      x = Schedules.createUsageFactsRejection) : x ≠ .draft d := by
  rcases h with rfl | rfl | rfl | rfl | rfl <;>
    simp [Schedules.createPolicyRejection, Schedules.createSpanRejection,
      Schedules.createDecliningRateRejection, Schedules.createUsageBoundRejection,
      Schedules.createUsageFactsRejection, reject_eq]

/-- The steps of a call that produced a draft: every check passed and every computation returned. -/
theorem createAllocationSchedule_draft_inv {policies : List AccountingPolicy} {bookId : BookId}
    {request : AllocationScheduleRequest} {d : AccountingDraft}
    (h : createAllocationSchedule policies bookId request = .ok (.draft d)) :
    ∃ (policy : AllocationPolicy) (allocable amountsSum totalBasis : ExactRational)
      (amounts : List ExactRational) (dates : List LocalDate)
      (postingPlan : Option AllocationPostingPlan),
      policyAt AllocationPolicy policies request.policyId request.policyVersion
        request.governedAt = .selected policy ∧
      Schedules.createIncoherent policy bookId request = false ∧
      request.sourceBasis.subtract request.residualValue = .ok allocable ∧
      Schedules.generate policy request allocable = .ok (.inr (amounts, dates)) ∧
      accountingSum amounts = .ok amountsSum ∧
      amountsSum.add request.residualValue = .ok totalBasis ∧
      totalBasis.equals request.sourceBasis = true ∧
      Schedules.createPlan policy request (Schedules.buildInstallments 1 amounts dates) =
        .ok (.inr postingPlan) ∧
      d = { journals := [],
            effects := [.allocationSchedule (Schedules.assembleSchedule bookId policy request
              (Schedules.buildInstallments 1 amounts dates) postingPlan)] } := by
  unfold createAllocationSchedule at h
  rcases hpa : policyAt AllocationPolicy policies request.policyId request.policyVersion
      request.governedAt with policy | diagnostics
  swap
  · simp [hpa, Schedules.createCoherenceRejection, reject_eq] at h
  simp only [hpa] at h
  by_cases hinc : Schedules.createIncoherent policy bookId request = true
  · simp [hinc, Schedules.createCoherenceRejection, reject_eq] at h
  have hinc' : Schedules.createIncoherent policy bookId request = false :=
    Bool.eq_false_iff.mpr hinc
  simp only [hinc, Bool.false_eq_true, ↓reduceIte] at h
  rcases hal : Schedules.liftNum (request.sourceBasis.subtract request.residualValue) with
    e | allocable
  · rw [hal] at h; cases h
  simp only [hal] at h
  rcases hg : Schedules.generate policy request allocable with e | generated
  · rw [hg] at h; cases h
  simp only [hg] at h
  rcases generated with rejection | ⟨amounts, dates⟩
  · exact absurd (Except.ok.inj h) (Schedules.rejection_ne_draft (generate_inl hg))
  dsimp only at h
  rcases hs : Schedules.liftNum (accountingSum amounts) with e | amountsSum
  · rw [hs] at h; cases h
  simp only [hs] at h
  rcases ht : Schedules.liftNum (amountsSum.add request.residualValue) with e | totalBasis
  · rw [ht] at h; cases h
  simp only [ht] at h
  by_cases heq : (!totalBasis.equals request.sourceBasis) = true
  · simp [heq, Schedules.createInstallmentsConservationRejection, reject_eq] at h
  have heq' : totalBasis.equals request.sourceBasis = true := by simpa using heq
  simp only [heq, Bool.false_eq_true, ↓reduceIte] at h
  rcases hp : Schedules.createPlan policy request (Schedules.buildInstallments 1 amounts dates) with
    e | planned
  · rw [hp] at h; cases h
  simp only [hp] at h
  rcases planned with rejection | postingPlan
  · obtain ⟨-, source, -, ⟨-, rfl⟩ | ⟨-, diagnostics, -, rfl⟩⟩ := createPlan_inl hp
    · simp [Schedules.createPostingPlanRejection, reject_eq] at h
    · simp at h
  · simp only [drafted_eq, Except.ok.injEq, AccountingCalculation.draft.injEq] at h
    exact ⟨policy, allocable, amountsSum, totalBasis, amounts, dates, postingPlan, rfl, hinc',
      Schedules.liftNum_ok hal, hg, Schedules.liftNum_ok hs, Schedules.liftNum_ok ht, heq', hp,
      h.symm⟩

/-- The steps of a call that produced exactly this schedule. -/
theorem createAllocationSchedule_schedule_inv {policies : List AccountingPolicy} {bookId : BookId}
    {request : AllocationScheduleRequest} {schedule : AllocationSchedule}
    (h : createAllocationSchedule policies bookId request =
      .ok (drafted [] [.allocationSchedule schedule])) :
    ∃ (policy : AllocationPolicy) (allocable amountsSum totalBasis : ExactRational)
      (amounts : List ExactRational) (dates : List LocalDate)
      (postingPlan : Option AllocationPostingPlan),
      policyAt AllocationPolicy policies request.policyId request.policyVersion
        request.governedAt = .selected policy ∧
      Schedules.createIncoherent policy bookId request = false ∧
      request.sourceBasis.subtract request.residualValue = .ok allocable ∧
      Schedules.generate policy request allocable = .ok (.inr (amounts, dates)) ∧
      accountingSum amounts = .ok amountsSum ∧
      amountsSum.add request.residualValue = .ok totalBasis ∧
      totalBasis.equals request.sourceBasis = true ∧
      Schedules.createPlan policy request (Schedules.buildInstallments 1 amounts dates) =
        .ok (.inr postingPlan) ∧
      schedule = Schedules.assembleSchedule bookId policy request
        (Schedules.buildInstallments 1 amounts dates) postingPlan := by
  obtain ⟨policy, allocable, amountsSum, totalBasis, amounts, dates, postingPlan, h1, h2, h3, h4,
    h5, h6, h7, h8, hd⟩ := createAllocationSchedule_draft_inv h
  refine ⟨policy, allocable, amountsSum, totalBasis, amounts, dates, postingPlan, h1, h2, h3, h4,
    h5, h6, h7, h8, ?_⟩
  simp only [AccountingDraft.mk.injEq, List.cons.injEq, AccountingEffect.allocationSchedule.injEq,
    and_true, true_and] at hd
  exact hd

/-- What a plan that `createPlan` made satisfies: the policy is cumulative, the posted source basis
is the source basis itself rounded with nothing left over, the plan is the one
`planAllocationPostings` makes of the schedule, its instalments are the schedule's (ordinal, date
and exact amount), the dates are in strictly increasing order (`scheduleMisordered` accepted
them), its posted amounts add up to exactly the source basis less the rounded residual value, and
its hash is the hash of its body. -/
theorem createPlan_facts {policy : AllocationPolicy} {request : AllocationScheduleRequest}
    {installments : List ScheduledAllocation} {plan : AllocationPostingPlan}
    (hpolwf : policy.WF) (hsb : request.sourceBasis.WF) (hres : request.residualValue.WF)
    (hinst : ∀ i ∈ installments, i.WF)
    (h : Schedules.createPlan policy request installments = .ok (.inr (some plan))) :
    usesCumulativeAllocation policy = true ∧
      ∃ source rq, quantize request.sourceBasis policy.quantizationPolicy.rule = .ok source ∧
        quantize request.residualValue policy.quantizationPolicy.rule = .ok rq ∧
        source.residual.isZero = true ∧ source.amount.toRat = request.sourceBasis.toRat ∧
        plan.residualQuantization = rq ∧
        planAllocationPostings (Schedules.planInput policy request source installments) =
          .ok (.planned plan) ∧
        (plan.installments.map (·.postedAmount.toRat)).sum =
          request.sourceBasis.toRat - rq.amount.toRat ∧
        plan.installments.map (fun i => (i.ordinal, i.accountingDate, i.exactAmount)) =
          installments.map (fun i => (i.ordinal, i.accountingDate, i.amount)) ∧
        scheduleMisordered 0 none installments = false ∧
        plan.contentHash = accountingBodyHash "AllocationPostingPlan" plan := by
  rcases createPlan_inr h with ⟨-, hnone⟩ | ⟨hc, source, plan', hq, hz, -, hp, hplan⟩
  · simp at hnone
  have hplan' : plan' = plan := by simpa using hplan.symm
  subst hplan'
  obtain ⟨hsrcwf, hsrcreswf, -, -, hsrcres⟩ := quantize_ok hsb hq
  have hw : (Schedules.planInput policy request source installments).WF :=
    ⟨hsb, hres, hsrcwf, hpolwf.core.quantizationPolicy, hinst⟩
  obtain ⟨rq, pb, ea, ra, pa, hrq, -, -, -, -, hrej, -, -, -, -, -, hrqeq, -, -⟩ :=
    planAllocationPostings_planned_steps hp
  refine ⟨hc, source, rq, hq, hrq, hz, ?_, hrqeq, hp, ?_, ?_, ?_, ?_⟩
  · have hz0 : source.residual.toRat = 0 := (ExactRational.isZero_iff hsrcreswf).mp hz
    have := quantize_amount_add_residual hsb hq
    rw [hz0, add_zero] at this
    exact this
  · have hsum := planAllocationPostings_posted_sum hw hp
    have hz0 : source.residual.toRat = 0 := (ExactRational.isZero_iff hsrcreswf).mp hz
    have hq' := quantize_amount_add_residual hsb hq
    rw [hz0, add_zero] at hq'
    rw [hsum, hrqeq]
    simp only [Schedules.planInput]
    rw [hq']
  · exact planAllocationPostings_installments_schedule hw hp
  · have := (planRejects_eq_false hrej)
    exact this.2.2.2.2.2.2.2.2.1
  · exact planAllocationPostings_contentHash hp

/-- The request's usage facts are constructible. -/
theorem AllocationScheduleRequest.WF.usage_getD {request : AllocationScheduleRequest}
    (hreq : request.WF) : ∀ u ∈ request.usage.getD [], u.WF := by
  intro u hu
  cases hus : request.usage with
  | none => simp [hus] at hu
  | some l => simp only [hus, Option.getD_some] at hu; exact hreq.usage l hus u hu

/-- A schedule that passed the coherence test has its dates in order. -/
theorem Schedules.createIncoherent_false {policy : AllocationPolicy} {bookId : BookId}
    {request : AllocationScheduleRequest} (h : Schedules.createIncoherent policy bookId request = false) :
    validAccountingDerivation request.derivation = true ∧ policy.bookId = bookId ∧
      request.startsOn ≤ request.endsOn ∧ request.residualValue.isNegative = false ∧
      request.residualValue.compare request.sourceBasis ≠ .gt := by
  unfold Schedules.createIncoherent at h
  simp only [Bool.or_eq_false_iff, Bool.not_eq_false', bne_eq_false_iff_eq, decide_eq_false_iff_not,
    beq_eq_false_iff_ne, ne_eq] at h
  obtain ⟨⟨⟨⟨hd, hb⟩, hdates⟩, hneg⟩, hgt⟩ := h
  exact ⟨hd, hb, (jsStringLe_iff_not_lt request.startsOn.value request.endsOn.value).mpr hdates,
    hneg, hgt⟩


/-- What a call that produced `schedule` computed and checked, as facts about the schedule: its
instalments are as many as the exact amounts, numbered from one, every one constructible; the exact
amounts add up to the source basis less the residual value; the dates are in strictly increasing
order for the periodic methods and for a cumulative schedule, and are the usage dates in the order
given for units of production; and the plan is absent for a policy that is not cumulative. -/
theorem createAllocationSchedule_facts {policies : List AccountingPolicy} {bookId : BookId}
    {request : AllocationScheduleRequest} {schedule : AllocationSchedule}
    {policy : AllocationPolicy} (hpol : ∀ p ∈ policies, p.WF) (hreq : request.WF)
    (hsel : policyAt AllocationPolicy policies request.policyId request.policyVersion
      request.governedAt = .selected policy)
    (h : createAllocationSchedule policies bookId request =
      .ok (drafted [] [.allocationSchedule schedule])) :
    (schedule.installments.map (·.amount.toRat)).sum =
        request.sourceBasis.toRat - request.residualValue.toRat ∧
      (∀ i ∈ schedule.installments, i.WF) ∧
      1 ≤ schedule.installments.length ∧
      schedule.installments.length ≤ accountingLimits.maxScheduleInstallments ∧
      schedule.installments.map (·.ordinal) =
        (List.range schedule.installments.length).map (fun i => ((1 + i : Nat) : Int)) ∧
      (policy.method ≠ .unitsOfProduction →
        (schedule.installments.map (·.accountingDate)).Pairwise (· < ·)) ∧
      (policy.method = .unitsOfProduction →
        schedule.installments.map (·.accountingDate) = (request.usage.getD []).map (·.date)) := by
  obtain ⟨policy', allocable, amountsSum, totalBasis, amounts, dates, postingPlan, hsel', hinc, hal,
    hgen, hsum, hadd, heq, hplan, rfl⟩ := createAllocationSchedule_schedule_inv h
  have hpp : policy' = policy := by
    rw [hsel] at hsel'; exact (AccountingPolicySelection.selected.inj hsel').symm
  subst hpp
  obtain ⟨hpolwf, -, -, -⟩ := policyAt_allocation_selected hpol hsel
  obtain ⟨-, -, hle, -, -⟩ := Schedules.createIncoherent_false hinc
  obtain ⟨halwf, -⟩ := ExactRational.subtract_ok hreq.sourceBasis hreq.residualValue hal
  obtain ⟨hlen, h1, h2, hw, hper, huse⟩ := generate_spec hreq.startsOn hreq.endsOn hle halwf
    hreq.residualValue hreq.sourceBasis hpolwf.decliningRate
    (fun u hu => (hreq.usage_getD u hu).value) hgen
  obtain ⟨hsumwf, hsumrat⟩ := Schedules.accountingSum_ok hw hsum
  obtain ⟨htotwf, htotrat⟩ := ExactRational.add_ok hsumwf hreq.residualValue hadd
  have hteq := (ExactRational.equals_iff htotwf hreq.sourceBasis).mp heq
  obtain ⟨hm1, hm2, hm3⟩ := buildInstallments_spec 1 amounts dates hlen
  have hinst : (Schedules.assembleSchedule bookId policy' request
      (Schedules.buildInstallments 1 amounts dates) postingPlan).installments =
        Schedules.buildInstallments 1 amounts dates := rfl
  rw [hinst]
  have hlen' : (Schedules.buildInstallments 1 amounts dates).length = amounts.length := by
    have := congrArg List.length hm1
    simpa using this
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_⟩
  · have : ((Schedules.buildInstallments 1 amounts dates).map (·.amount.toRat)) =
        amounts.map ExactRational.toRat := by
      calc ((Schedules.buildInstallments 1 amounts dates).map (·.amount.toRat))
          = ((Schedules.buildInstallments 1 amounts dates).map (·.amount)).map
              ExactRational.toRat := by simp [List.map_map, Function.comp_def]
        _ = amounts.map ExactRational.toRat := by rw [hm1]
    rw [this]
    linarith
  · intro i hi
    have hmem : i.amount ∈ (Schedules.buildInstallments 1 amounts dates).map (·.amount) :=
      List.mem_map.mpr ⟨i, hi, rfl⟩
    rw [hm1] at hmem
    exact ⟨hw _ hmem⟩
  · rw [hlen']; omega
  · rw [hlen']; omega
  · rw [hm3, hlen']
  · intro hne
    rw [hm2]
    exact (hper hne).2
  · intro hu
    rw [hm2]
    exact (huse hu).1

namespace Schedules

/-- The first steps of a call passed: a policy was selected, the request is coherent with it, and
the allocable amount was computed. -/
structure CreateReached (policies : List AccountingPolicy) (bookId : BookId)
    (request : AllocationScheduleRequest) (policy : AllocationPolicy)
    (allocable : ExactRational) : Prop where
  selected : policyAt AllocationPolicy policies request.policyId request.policyVersion
    request.governedAt = .selected policy
  coherent : createIncoherent policy bookId request = false
  computed : request.sourceBasis.subtract request.residualValue = .ok allocable

/-- The steps of lines 1603 to 1621, from the exact amounts and dates: the conservation check, the
posting plan, and the schedule. It is `createAllocationSchedule` after `generate`
(`createAllocationSchedule_of_generated`), named to state the laws of those steps. -/
def createFinish (bookId : BookId) (policy : AllocationPolicy) (request : AllocationScheduleRequest)
    (amounts : List ExactRational) (dates : List LocalDate) :
    Except ScheduleErr AccountingCalculation :=
  match liftNum (accountingSum amounts) with
  | .error e => .error e
  | .ok amountsSum =>
    match liftNum (amountsSum.add request.residualValue) with
    | .error e => .error e
    | .ok totalBasis =>
      if !totalBasis.equals request.sourceBasis then
        .ok createInstallmentsConservationRejection
      else
        match createPlan policy request (buildInstallments 1 amounts dates) with
        | .error e => .error e
        | .ok (.inl rejection) => .ok rejection
        | .ok (.inr postingPlan) =>
          .ok (drafted []
            [.allocationSchedule
              (assembleSchedule bookId policy request (buildInstallments 1 amounts dates)
                postingPlan)])

end Schedules

/-- Once `generate` returned amounts and dates, `createAllocationSchedule` is `createFinish`. -/
theorem createAllocationSchedule_of_generated {policies : List AccountingPolicy} {bookId : BookId}
    {request : AllocationScheduleRequest} {policy : AllocationPolicy} {allocable : ExactRational}
    {amounts : List ExactRational} {dates : List LocalDate}
    (hr : Schedules.CreateReached policies bookId request policy allocable)
    (hgen : Schedules.generate policy request allocable = .ok (.inr (amounts, dates))) :
    createAllocationSchedule policies bookId request =
      Schedules.createFinish bookId policy request amounts dates := by
  unfold createAllocationSchedule
  have hal : Schedules.liftNum (request.sourceBasis.subtract request.residualValue) =
      .ok allocable := by simp [Schedules.liftNum, hr.computed]
  simp only [hr.selected, hr.coherent, Bool.false_eq_true, ↓reduceIte, hal, hgen]
  rfl


namespace Schedules

/-- The amounts and dates `generate` returned, after the first steps passed. -/
structure CreateGenerated (policies : List AccountingPolicy) (bookId : BookId)
    (request : AllocationScheduleRequest) (policy : AllocationPolicy) (allocable : ExactRational)
    (amounts : List ExactRational) (dates : List LocalDate) : Prop extends
    CreateReached policies bookId request policy allocable where
  generated : generate policy request allocable = .ok (.inr (amounts, dates))

/-- Why `createAllocationSchedule` refuses with this rejection, stage by stage in the order of the
function; the conditions of each stage are the ones the function tests. -/
inductive CreateRefusal (policies : List AccountingPolicy) (bookId : BookId)
    (request : AllocationScheduleRequest) : AccountingCalculation → Prop
  /-- `policyAt` selects no policy (line 1576). -/
  | noPolicy {diagnostics : List SemanticDiagnostic}
      (h : policyAt AllocationPolicy policies request.policyId request.policyVersion
        request.governedAt = .rejected diagnostics) :
      CreateRefusal policies bookId request createCoherenceRejection
  /-- The derivation, book, dates, residual or basis are not coherent (line 1576). -/
  | incoherent {policy : AllocationPolicy}
      (h : policyAt AllocationPolicy policies request.policyId request.policyVersion
        request.governedAt = .selected policy)
      (hinc : createIncoherent policy bookId request = true) :
      CreateRefusal policies bookId request createCoherenceRejection
  /-- A straight-line or declining-balance policy that is not monthly, quarterly or annual, or
  whose convention is not full period (line 1580). -/
  | policyShape {policy : AllocationPolicy} {allocable : ExactRational}
      (hr : CreateReached policies bookId request policy allocable)
      (hm : (policy.method == .straightLine || policy.method == .decliningBalance) = true)
      (hs : policy.frequency = .eventDriven ∨ policy.convention ≠ .fullPeriod) :
      CreateRefusal policies bookId request createPolicyRejection
  /-- A span that needs more than 1,200 instalments (line 1583). -/
  | span {policy : AllocationPolicy} {allocable : ExactRational} {step : Int}
      (hr : CreateReached policies bookId request policy allocable)
      (hm : (policy.method == .straightLine || policy.method == .decliningBalance) = true)
      (hstep : scheduleStepMonths policy.frequency = some step)
      (hconv : policy.convention = .fullPeriod)
      (hspan : jsDiv (monthsBetween request.startsOn request.endsOn + step - 1) step >
        (accountingLimits.maxScheduleInstallments : Int)) :
      CreateRefusal policies bookId request createSpanRejection
  /-- A declining-balance policy with no rate, a rate that is not positive, or one above one
  (line 1587). -/
  | decliningRate {policy : AllocationPolicy} {allocable : ExactRational} {step : Int}
      (hr : CreateReached policies bookId request policy allocable)
      (hm : (policy.method == .straightLine || policy.method == .decliningBalance) = true)
      (hstep : scheduleStepMonths policy.frequency = some step)
      (hconv : policy.convention = .fullPeriod)
      (hspan : ¬ jsDiv (monthsBetween request.startsOn request.endsOn + step - 1) step >
        (accountingLimits.maxScheduleInstallments : Int))
      (hmethod : (policy.method == .straightLine) = false)
      (hrate : policy.decliningRate = none ∨ ∃ rate, policy.decliningRate = some rate ∧
        (!positive rate || rate.compare ⟨1, 1⟩ == .gt) = true) :
      CreateRefusal policies bookId request createDecliningRateRejection
  /-- More than 1,200 usage facts (line 1599). -/
  | usageBound {policy : AllocationPolicy} {allocable totalUsage : ExactRational}
      (hr : CreateReached policies bookId request policy allocable)
      (hm : ¬ (policy.method == .straightLine || policy.method == .decliningBalance) = true)
      (hsum : liftNum (accountingSum ((request.usage.getD []).map (·.value))) = .ok totalUsage)
      (hbound : (request.usage.getD []).length > accountingLimits.maxUsageEvents) :
      CreateRefusal policies bookId request createUsageBoundRejection
  /-- Usage facts that are not complete, unique, positive and in the span, or do not match the
  policy's expected usage (line 1600). -/
  | usageFacts {policy : AllocationPolicy} {allocable totalUsage : ExactRational}
      (hr : CreateReached policies bookId request policy allocable)
      (hm : ¬ (policy.method == .straightLine || policy.method == .decliningBalance) = true)
      (hsum : liftNum (accountingSum ((request.usage.getD []).map (·.value))) = .ok totalUsage)
      (hbound : ¬ (request.usage.getD []).length > accountingLimits.maxUsageEvents)
      (hbad : usageFactsBad policy request totalUsage (request.usage.getD []) = true) :
      CreateRefusal policies bookId request createUsageFactsRejection
  /-- The exact instalments plus the residual do not make the source basis (line 1603). -/
  | conservation {policy : AllocationPolicy} {allocable amountsSum totalBasis : ExactRational}
      {amounts : List ExactRational} {dates : List LocalDate}
      (hg : CreateGenerated policies bookId request policy allocable amounts dates)
      (hs : accountingSum amounts = .ok amountsSum)
      (ha : amountsSum.add request.residualValue = .ok totalBasis)
      (hn : totalBasis.equals request.sourceBasis = false) :
      CreateRefusal policies bookId request createInstallmentsConservationRejection
  /-- A cumulative schedule whose posted source basis is not exact, or whose two recognition
  accounts are one (line 1608). -/
  | postingBasis {policy : AllocationPolicy} {allocable amountsSum totalBasis : ExactRational}
      {amounts : List ExactRational} {dates : List LocalDate} {source : QuantizedValue}
      (hg : CreateGenerated policies bookId request policy allocable amounts dates)
      (hs : accountingSum amounts = .ok amountsSum)
      (ha : amountsSum.add request.residualValue = .ok totalBasis)
      (hn : totalBasis.equals request.sourceBasis = true)
      (hcum : usesCumulativeAllocation policy = true)
      (hq : quantize request.sourceBasis policy.quantizationPolicy.rule = .ok source)
      (hbad : (!source.residual.isZero ||
        policy.allocationAccountId == policy.contraAccountId) = true) :
      CreateRefusal policies bookId request createPostingPlanRejection
  /-- `planAllocationPostings` rejects the schedule (line 1612). -/
  | planner {policy : AllocationPolicy} {allocable amountsSum totalBasis : ExactRational}
      {amounts : List ExactRational} {dates : List LocalDate} {source : QuantizedValue}
      (hg : CreateGenerated policies bookId request policy allocable amounts dates)
      (hs : accountingSum amounts = .ok amountsSum)
      (ha : amountsSum.add request.residualValue = .ok totalBasis)
      (hn : totalBasis.equals request.sourceBasis = true)
      (hcum : usesCumulativeAllocation policy = true)
      (hq : quantize request.sourceBasis policy.quantizationPolicy.rule = .ok source)
      (hok : (!source.residual.isZero ||
        policy.allocationAccountId == policy.contraAccountId) = false)
      (hp : planAllocationPostings
        (planInput policy request source (buildInstallments 1 amounts dates)) =
          .ok (.rejected [allocationPlanDiagnostic])) :
      CreateRefusal policies bookId request (.rejected [allocationPlanDiagnostic])

end Schedules

/-- `planAllocationPostings` has one rejection, with one diagnostic. -/
theorem planAllocationPostings_rejected_diagnostics {input : AllocationPostingPlanInput}
    {diagnostics : List SemanticDiagnostic}
    (h : planAllocationPostings input = .ok (.rejected diagnostics)) :
    diagnostics = [allocationPlanDiagnostic] := by
  obtain ⟨-, -, -, -, -, rejects, -, -, -, -, -, -, htrue, hfalse⟩ :=
    planAllocationPostings_ok_steps h
  cases rejects
  · obtain ⟨plan, hp⟩ := hfalse rfl
    cases hp
  · simpa using htrue rfl

/-- When `generate` refuses, so does `createAllocationSchedule`, with the same rejection. -/
theorem createAllocationSchedule_of_refused {policies : List AccountingPolicy} {bookId : BookId}
    {request : AllocationScheduleRequest} {policy : AllocationPolicy} {allocable : ExactRational}
    {x : AccountingCalculation} (hr : Schedules.CreateReached policies bookId request policy allocable)
    (hgen : Schedules.generate policy request allocable = .ok (.inl x)) :
    createAllocationSchedule policies bookId request = .ok x := by
  unfold createAllocationSchedule
  have hal : Schedules.liftNum (request.sourceBasis.subtract request.residualValue) =
      .ok allocable := by simp [Schedules.liftNum, hr.computed]
  simp only [hr.selected, hr.coherent, Bool.false_eq_true, ↓reduceIte, hal, hgen]


/-- Every stage that refuses makes `createAllocationSchedule` return its rejection. -/
theorem Schedules.CreateRefusal.result {policies : List AccountingPolicy} {bookId : BookId}
    {request : AllocationScheduleRequest} {r : AccountingCalculation}
    (h : Schedules.CreateRefusal policies bookId request r) :
    createAllocationSchedule policies bookId request = .ok r := by
  cases h with
  | noPolicy h => unfold createAllocationSchedule; simp [h]
  | incoherent h hinc => unfold createAllocationSchedule; simp [h, hinc]
  | policyShape hr hm hs =>
    refine createAllocationSchedule_of_refused hr ?_
    unfold Schedules.generate
    simp only [hm, ↓reduceIte]
    exact periodicSchedule_policy_rejected hs
  | span hr hm hstep hconv hspan =>
    refine createAllocationSchedule_of_refused hr ?_
    unfold Schedules.generate
    simp only [hm, ↓reduceIte]
    exact periodicSchedule_span_rejected hstep hconv hspan
  | decliningRate hr hm hstep hconv hspan hmethod hrate =>
    refine createAllocationSchedule_of_refused hr ?_
    unfold Schedules.generate
    simp only [hm, ↓reduceIte]
    exact periodicSchedule_rate_rejected hstep hconv hspan hmethod hrate
  | usageBound hr hm hsum hbound =>
    refine createAllocationSchedule_of_refused hr ?_
    unfold Schedules.generate
    simp only [hm, Bool.false_eq_true, ↓reduceIte]
    exact usageSchedule_bound_rejected hsum hbound
  | usageFacts hr hm hsum hbound hbad =>
    refine createAllocationSchedule_of_refused hr ?_
    unfold Schedules.generate
    simp only [hm, Bool.false_eq_true, ↓reduceIte]
    exact usageSchedule_facts_rejected hsum hbound hbad
  | conservation hg hs ha hn =>
    rw [createAllocationSchedule_of_generated hg.toCreateReached hg.generated]
    simp [Schedules.createFinish, Schedules.liftNum, hs, ha, hn]
  | postingBasis hg hs ha hn hcum hq hbad =>
    rw [createAllocationSchedule_of_generated hg.toCreateReached hg.generated]
    simp [Schedules.createFinish, Schedules.liftNum, hs, ha, hn,
      createPlan_basis_rejected hcum hq hbad]
  | planner hg hs ha hn hcum hq hok hp =>
    rw [createAllocationSchedule_of_generated hg.toCreateReached hg.generated]
    simp [Schedules.createFinish, Schedules.liftNum, hs, ha, hn,
      createPlan_planner_rejected hcum hq hok hp]


/-- When `generate` refuses, it is for one of the stated reasons of `CreateRefusal`. -/
theorem generate_refusal {policies : List AccountingPolicy} {bookId : BookId}
    {request : AllocationScheduleRequest} {policy : AllocationPolicy} {allocable : ExactRational}
    {x : AccountingCalculation} (hr : Schedules.CreateReached policies bookId request policy allocable)
    (hg : Schedules.generate policy request allocable = .ok (.inl x)) :
    Schedules.CreateRefusal policies bookId request x := by
  unfold Schedules.generate at hg
  by_cases hm : (policy.method == .straightLine || policy.method == .decliningBalance) = true
  · simp only [hm, ↓reduceIte] at hg
    rcases periodicSchedule_inl hg with ⟨rfl, hs⟩ | ⟨rfl, hfreq, hconv, step, hstep, hspan⟩ |
      ⟨rfl, hfreq, hconv, hmethod, ⟨step, hstep, hspan⟩, hrate⟩
    · exact .policyShape hr hm hs
    · exact .span hr hm hstep hconv hspan
    · exact .decliningRate hr hm hstep hconv hspan hmethod hrate
  · simp only [hm, Bool.false_eq_true, ↓reduceIte] at hg
    obtain ⟨totalUsage, hsum, ⟨hbound, rfl⟩ | ⟨hbound, hbad, rfl⟩⟩ := usageSchedule_inl hg
    · exact .usageBound hr hm hsum hbound
    · exact .usageFacts hr hm hsum hbound hbad

/-- What `createFinish` returns is a refusal for one of the stated reasons, or a schedule. -/
theorem Schedules.createFinish_cases {policies : List AccountingPolicy} {bookId : BookId}
    {request : AllocationScheduleRequest} {policy : AllocationPolicy} {allocable : ExactRational}
    {amounts : List ExactRational} {dates : List LocalDate} {r : AccountingCalculation}
    (hg : Schedules.CreateGenerated policies bookId request policy allocable amounts dates)
    (h : Schedules.createFinish bookId policy request amounts dates = .ok r) :
    Schedules.CreateRefusal policies bookId request r ∨
      ∃ schedule, r = drafted [] [.allocationSchedule schedule] := by
  unfold Schedules.createFinish at h
  rcases hs : Schedules.liftNum (accountingSum amounts) with e | amountsSum
  · rw [hs] at h; cases h
  simp only [hs] at h
  rcases ha : Schedules.liftNum (amountsSum.add request.residualValue) with e | totalBasis
  · rw [ha] at h; cases h
  simp only [ha] at h
  by_cases hn : (!totalBasis.equals request.sourceBasis) = true
  · simp only [hn, ↓reduceIte, Except.ok.injEq] at h
    subst h
    exact Or.inl (.conservation hg (Schedules.liftNum_ok hs) (Schedules.liftNum_ok ha)
      (by simpa using hn))
  have hn' : totalBasis.equals request.sourceBasis = true := by simpa using hn
  simp only [hn, Bool.false_eq_true, ↓reduceIte] at h
  rcases hp : Schedules.createPlan policy request (Schedules.buildInstallments 1 amounts dates) with
    e | planned
  · rw [hp] at h; cases h
  simp only [hp] at h
  rcases planned with x | postingPlan
  · simp only [Except.ok.injEq] at h
    subst h
    obtain ⟨hcum, source, hq, ⟨hbad, rfl⟩ | ⟨hok, diagnostics, hpl, rfl⟩⟩ := createPlan_inl hp
    · exact Or.inl (.postingBasis hg (Schedules.liftNum_ok hs) (Schedules.liftNum_ok ha) hn' hcum
        hq hbad)
    · have hd := planAllocationPostings_rejected_diagnostics hpl
      subst hd
      exact Or.inl (.planner hg (Schedules.liftNum_ok hs) (Schedules.liftNum_ok ha) hn' hcum hq
        hok hpl)
  · simp only [Except.ok.injEq] at h
    exact Or.inr ⟨_, h.symm⟩

/-- Whatever `createAllocationSchedule` returns without throwing is either a rejection for one of
the stated reasons, stage by stage, or exactly one schedule. -/
theorem createAllocationSchedule_cases {policies : List AccountingPolicy} {bookId : BookId}
    {request : AllocationScheduleRequest} {r : AccountingCalculation}
    (h : createAllocationSchedule policies bookId request = .ok r) :
    Schedules.CreateRefusal policies bookId request r ∨
      ∃ schedule, r = drafted [] [.allocationSchedule schedule] := by
  have h0 := h
  unfold createAllocationSchedule at h
  rcases hpa : policyAt AllocationPolicy policies request.policyId request.policyVersion
      request.governedAt with policy | diagnostics
  swap
  · simp only [hpa, Except.ok.injEq] at h
    subst h
    exact Or.inl (.noPolicy hpa)
  simp only [hpa] at h
  by_cases hinc : Schedules.createIncoherent policy bookId request = true
  · simp only [hinc, ↓reduceIte, Except.ok.injEq] at h
    subst h
    exact Or.inl (.incoherent hpa hinc)
  have hinc' : Schedules.createIncoherent policy bookId request = false :=
    Bool.eq_false_iff.mpr hinc
  simp only [hinc, Bool.false_eq_true, ↓reduceIte] at h
  rcases hal : Schedules.liftNum (request.sourceBasis.subtract request.residualValue) with
    e | allocable
  · rw [hal] at h; cases h
  simp only [hal] at h
  have hr : Schedules.CreateReached policies bookId request policy allocable :=
    ⟨hpa, hinc', Schedules.liftNum_ok hal⟩
  rcases hg : Schedules.generate policy request allocable with e | generated
  · rw [hg] at h; cases h
  rcases generated with x | ⟨amounts, dates⟩
  · simp only [hg, Except.ok.injEq] at h
    subst h
    exact Or.inl (generate_refusal hr hg)
  · have hgen : Schedules.CreateGenerated policies bookId request policy allocable amounts dates :=
      ⟨hr, hg⟩
    rw [createAllocationSchedule_of_generated hr hg] at h0
    exact Schedules.createFinish_cases hgen h0

/-- A rejection of `createAllocationSchedule` is not a draft. -/
theorem Schedules.createRejections_ne_drafted {schedule : AllocationSchedule} :
    Schedules.createCoherenceRejection ≠ drafted [] [.allocationSchedule schedule] ∧
    Schedules.createPolicyRejection ≠ drafted [] [.allocationSchedule schedule] ∧
    Schedules.createSpanRejection ≠ drafted [] [.allocationSchedule schedule] ∧
    Schedules.createDecliningRateRejection ≠ drafted [] [.allocationSchedule schedule] ∧
    Schedules.createUsageBoundRejection ≠ drafted [] [.allocationSchedule schedule] ∧
    Schedules.createUsageFactsRejection ≠ drafted [] [.allocationSchedule schedule] ∧
    Schedules.createInstallmentsConservationRejection ≠ drafted [] [.allocationSchedule schedule] ∧
    Schedules.createPostingPlanRejection ≠ drafted [] [.allocationSchedule schedule] ∧
    (AccountingCalculation.rejected [allocationPlanDiagnostic]) ≠
      drafted [] [.allocationSchedule schedule] := by
  simp [Schedules.createCoherenceRejection, Schedules.createPolicyRejection,
    Schedules.createSpanRejection, Schedules.createDecliningRateRejection,
    Schedules.createUsageBoundRejection, Schedules.createUsageFactsRejection,
    Schedules.createInstallmentsConservationRejection, Schedules.createPostingPlanRejection,
    reject_eq, drafted_eq]

/-- **The coherence rejection** (`command.schedule`, `ACC-044.1`; `accounting.ts` line 1576): the
call returns it exactly when no policy is selected, or the selected policy fails the test of
`createIncoherent` (an unapproved derivation, a policy of another book, an end before the start, a
negative residual, or a residual above the basis). -/
theorem createAllocationSchedule_coherence_iff {policies : List AccountingPolicy} {bookId : BookId}
    {request : AllocationScheduleRequest} :
    createAllocationSchedule policies bookId request = .ok Schedules.createCoherenceRejection ↔
      (∃ diagnostics, policyAt AllocationPolicy policies request.policyId request.policyVersion
          request.governedAt = .rejected diagnostics) ∨
        ∃ policy, policyAt AllocationPolicy policies request.policyId request.policyVersion
            request.governedAt = .selected policy ∧
          Schedules.createIncoherent policy bookId request = true := by
  constructor
  · intro h
    rcases createAllocationSchedule_cases h with hr | ⟨schedule, hs⟩
    · generalize hx : Schedules.createCoherenceRejection = x at hr
      cases hr with
      | noPolicy hh => exact Or.inl ⟨_, hh⟩
      | incoherent hh hinc => exact Or.inr ⟨_, hh, hinc⟩
      | _ => exact absurd hx (by decide)
    · exact absurd hs Schedules.createRejections_ne_drafted.1
  · rintro (⟨diagnostics, hd⟩ | ⟨policy, hs, hinc⟩)
    · exact (Schedules.CreateRefusal.noPolicy hd).result
    · exact (Schedules.CreateRefusal.incoherent hs hinc).result

/-- **The policy rejection** (`command.schedule.policy`, `ACC-044.1`, `ACC-044.2`; line 1580): once
the first steps passed, a straight-line or declining-balance schedule is refused exactly when the
frequency is event driven or the convention is not full period. -/
theorem createAllocationSchedule_policy_iff {policies : List AccountingPolicy} {bookId : BookId}
    {request : AllocationScheduleRequest} :
    createAllocationSchedule policies bookId request = .ok Schedules.createPolicyRejection ↔
      ∃ policy allocable, Schedules.CreateReached policies bookId request policy allocable ∧
        (policy.method == .straightLine || policy.method == .decliningBalance) = true ∧
        (policy.frequency = .eventDriven ∨ policy.convention ≠ .fullPeriod) := by
  constructor
  · intro h
    rcases createAllocationSchedule_cases h with hr | ⟨schedule, hs⟩
    · generalize hx : Schedules.createPolicyRejection = x at hr
      cases hr with
      | policyShape hh hm hs => exact ⟨_, _, hh, hm, hs⟩
      | _ => exact absurd hx (by decide)
    · exact absurd hs Schedules.createRejections_ne_drafted.2.1
  · rintro ⟨policy, allocable, hr, hm, hs⟩
    exact (Schedules.CreateRefusal.policyShape hr hm hs).result


/-- **The span rejection** (`command.schedule.span`, `ACC-044.1`; line 1583): a straight-line or
declining-balance schedule of a monthly, quarterly or annual full-period policy is refused exactly
when its months, in steps of the frequency, make more than 1,200 instalments. -/
theorem createAllocationSchedule_span_iff {policies : List AccountingPolicy} {bookId : BookId}
    {request : AllocationScheduleRequest} :
    createAllocationSchedule policies bookId request = .ok Schedules.createSpanRejection ↔
      ∃ (policy : AllocationPolicy) (allocable : ExactRational) (step : Int),
        Schedules.CreateReached policies bookId request policy allocable ∧
        (policy.method == .straightLine || policy.method == .decliningBalance) = true ∧
        Schedules.scheduleStepMonths policy.frequency = some step ∧
        policy.convention = .fullPeriod ∧
        jsDiv (Schedules.monthsBetween request.startsOn request.endsOn + step - 1) step >
          (accountingLimits.maxScheduleInstallments : Int) := by
  constructor
  · intro h
    rcases createAllocationSchedule_cases h with hr | ⟨schedule, hs⟩
    · generalize hx : Schedules.createSpanRejection = x at hr
      cases hr with
      | span hh hm hstep hconv hspan => exact ⟨_, _, _, hh, hm, hstep, hconv, hspan⟩
      | _ => exact absurd hx (by decide)
    · exact absurd hs Schedules.createRejections_ne_drafted.2.2.1
  · rintro ⟨policy, allocable, step, hr, hm, hstep, hconv, hspan⟩
    exact (Schedules.CreateRefusal.span hr hm hstep hconv hspan).result

/-- **The declining-rate rejection** (`command.schedule.policy`, `ACC-044.2`; line 1587): a
declining-balance schedule whose span is within the bound is refused exactly when its policy has no
rate, a rate that is not positive, or a rate above one. -/
theorem createAllocationSchedule_decliningRate_iff {policies : List AccountingPolicy}
    {bookId : BookId} {request : AllocationScheduleRequest} :
    createAllocationSchedule policies bookId request =
        .ok Schedules.createDecliningRateRejection ↔
      ∃ (policy : AllocationPolicy) (allocable : ExactRational) (step : Int),
        Schedules.CreateReached policies bookId request policy allocable ∧
        (policy.method == .straightLine || policy.method == .decliningBalance) = true ∧
        Schedules.scheduleStepMonths policy.frequency = some step ∧
        policy.convention = .fullPeriod ∧
        ¬ jsDiv (Schedules.monthsBetween request.startsOn request.endsOn + step - 1) step >
          (accountingLimits.maxScheduleInstallments : Int) ∧
        (policy.method == .straightLine) = false ∧
        (policy.decliningRate = none ∨ ∃ rate, policy.decliningRate = some rate ∧
          (!positive rate || rate.compare ⟨1, 1⟩ == .gt) = true) := by
  constructor
  · intro h
    rcases createAllocationSchedule_cases h with hr | ⟨schedule, hs⟩
    · generalize hx : Schedules.createDecliningRateRejection = x at hr
      cases hr with
      | decliningRate hh hm hstep hconv hspan hmethod hrate =>
        exact ⟨_, _, _, hh, hm, hstep, hconv, hspan, hmethod, hrate⟩
      | _ => exact absurd hx (by decide)
    · exact absurd hs Schedules.createRejections_ne_drafted.2.2.2.1
  · rintro ⟨policy, allocable, step, hr, hm, hstep, hconv, hspan, hmethod, hrate⟩
    exact (Schedules.CreateRefusal.decliningRate hr hm hstep hconv hspan hmethod hrate).result

/-- **The usage-bound rejection** (`command.schedule.usage`, `ACC-044.2`; line 1599): a
units-of-production schedule is refused exactly when it has more than 1,200 usage facts. -/
theorem createAllocationSchedule_usageBound_iff {policies : List AccountingPolicy}
    {bookId : BookId} {request : AllocationScheduleRequest} :
    createAllocationSchedule policies bookId request = .ok Schedules.createUsageBoundRejection ↔
      ∃ (policy : AllocationPolicy) (allocable totalUsage : ExactRational),
        Schedules.CreateReached policies bookId request policy allocable ∧
        ¬ (policy.method == .straightLine || policy.method == .decliningBalance) = true ∧
        Schedules.liftNum (accountingSum ((request.usage.getD []).map (·.value))) =
          .ok totalUsage ∧
        (request.usage.getD []).length > accountingLimits.maxUsageEvents := by
  constructor
  · intro h
    rcases createAllocationSchedule_cases h with hr | ⟨schedule, hs⟩
    · generalize hx : Schedules.createUsageBoundRejection = x at hr
      cases hr with
      | usageBound hh hm hsum hbound => exact ⟨_, _, _, hh, hm, hsum, hbound⟩
      | _ => exact absurd hx (by decide)
    · exact absurd hs Schedules.createRejections_ne_drafted.2.2.2.2.1
  · rintro ⟨policy, allocable, totalUsage, hr, hm, hsum, hbound⟩
    exact (Schedules.CreateRefusal.usageBound hr hm hsum hbound).result

/-- **The usage-facts rejection** (`command.schedule.usage`, `ACC-044.2`; line 1600): a
units-of-production schedule within the bound is refused exactly when `usageFactsBad` holds: the
frequency is not event driven, the convention is not usage event, the policy's expected usage is
missing, not positive or not the total of the facts, there are no facts, two share a date, or one
has a value that is not positive or a date outside the span. -/
theorem createAllocationSchedule_usageFacts_iff {policies : List AccountingPolicy}
    {bookId : BookId} {request : AllocationScheduleRequest} :
    createAllocationSchedule policies bookId request = .ok Schedules.createUsageFactsRejection ↔
      ∃ (policy : AllocationPolicy) (allocable totalUsage : ExactRational),
        Schedules.CreateReached policies bookId request policy allocable ∧
        ¬ (policy.method == .straightLine || policy.method == .decliningBalance) = true ∧
        Schedules.liftNum (accountingSum ((request.usage.getD []).map (·.value))) =
          .ok totalUsage ∧
        ¬ (request.usage.getD []).length > accountingLimits.maxUsageEvents ∧
        Schedules.usageFactsBad policy request totalUsage (request.usage.getD []) = true := by
  constructor
  · intro h
    rcases createAllocationSchedule_cases h with hr | ⟨schedule, hs⟩
    · generalize hx : Schedules.createUsageFactsRejection = x at hr
      cases hr with
      | usageFacts hh hm hsum hbound hbad => exact ⟨_, _, _, hh, hm, hsum, hbound, hbad⟩
      | _ => exact absurd hx (by decide)
    · exact absurd hs Schedules.createRejections_ne_drafted.2.2.2.2.2.1
  · rintro ⟨policy, allocable, totalUsage, hr, hm, hsum, hbound, hbad⟩
    exact (Schedules.CreateRefusal.usageFacts hr hm hsum hbound hbad).result

/-- **The conservation rejection** (`command.schedule.installments`, `ACC-044.3`; line 1603): once
the amounts and dates are made, the schedule is refused exactly when the exact instalments plus the
residual do not make the source basis. -/
theorem createAllocationSchedule_conservation_iff {policies : List AccountingPolicy}
    {bookId : BookId} {request : AllocationScheduleRequest} :
    createAllocationSchedule policies bookId request =
        .ok Schedules.createInstallmentsConservationRejection ↔
      ∃ (policy : AllocationPolicy) (allocable amountsSum totalBasis : ExactRational)
        (amounts : List ExactRational) (dates : List LocalDate),
        Schedules.CreateGenerated policies bookId request policy allocable amounts dates ∧
        accountingSum amounts = .ok amountsSum ∧
        amountsSum.add request.residualValue = .ok totalBasis ∧
        totalBasis.equals request.sourceBasis = false := by
  constructor
  · intro h
    rcases createAllocationSchedule_cases h with hr | ⟨schedule, hs⟩
    · generalize hx : Schedules.createInstallmentsConservationRejection = x at hr
      cases hr with
      | conservation hg hs ha hn => exact ⟨_, _, _, _, _, _, hg, hs, ha, hn⟩
      | _ => exact absurd hx (by decide)
    · exact absurd hs Schedules.createRejections_ne_drafted.2.2.2.2.2.2.1
  · rintro ⟨policy, allocable, amountsSum, totalBasis, amounts, dates, hg, hs, ha, hn⟩
    exact (Schedules.CreateRefusal.conservation hg hs ha hn).result

/-- **The posting-plan rejection** (`command.schedule.postingPlan`, `ACC-044.3`; line 1608): a
cumulative schedule is refused its plan exactly when its source basis is not a whole number of
units of the policy's scale (the rounding leaves something over) or its two recognition accounts
are one. -/
theorem createAllocationSchedule_postingBasis_iff {policies : List AccountingPolicy}
    {bookId : BookId} {request : AllocationScheduleRequest} :
    createAllocationSchedule policies bookId request = .ok Schedules.createPostingPlanRejection ↔
      ∃ (policy : AllocationPolicy) (allocable amountsSum totalBasis : ExactRational)
        (amounts : List ExactRational) (dates : List LocalDate) (source : QuantizedValue),
        Schedules.CreateGenerated policies bookId request policy allocable amounts dates ∧
        accountingSum amounts = .ok amountsSum ∧
        amountsSum.add request.residualValue = .ok totalBasis ∧
        totalBasis.equals request.sourceBasis = true ∧
        usesCumulativeAllocation policy = true ∧
        quantize request.sourceBasis policy.quantizationPolicy.rule = .ok source ∧
        (!source.residual.isZero || policy.allocationAccountId == policy.contraAccountId) =
          true := by
  constructor
  · intro h
    rcases createAllocationSchedule_cases h with hr | ⟨schedule, hs⟩
    · generalize hx : Schedules.createPostingPlanRejection = x at hr
      cases hr with
      | postingBasis hg hs ha hn hcum hq hbad => exact ⟨_, _, _, _, _, _, _, hg, hs, ha, hn, hcum, hq, hbad⟩
      | _ => exact absurd hx (by decide)
    · exact absurd hs Schedules.createRejections_ne_drafted.2.2.2.2.2.2.2.1
  · rintro ⟨policy, allocable, amountsSum, totalBasis, amounts, dates, source, hg, hs, ha, hn, hcum,
      hq, hbad⟩
    exact (Schedules.CreateRefusal.postingBasis hg hs ha hn hcum hq hbad).result

/-- **The planner rejection** (`schedule.postingPlan`, `ACC-044.3`, `ACC-044.4`, `ACC-044.6`;
line 548, reached from line 1612): a cumulative schedule with an exact posted basis and two
distinct accounts is refused exactly when `planAllocationPostings` rejects it, which it does for a
schedule that is empty, longer than 1,200, with a negative basis, residual or amount, out of order,
not adding up to the allocable basis, or whose posted basis is not a whole number of units
(`PlanConditions` of `Core/Plan.lean` says it in numbers). -/
theorem createAllocationSchedule_planner_iff {policies : List AccountingPolicy}
    {bookId : BookId} {request : AllocationScheduleRequest} :
    createAllocationSchedule policies bookId request =
        .ok (.rejected [allocationPlanDiagnostic]) ↔
      ∃ (policy : AllocationPolicy) (allocable amountsSum totalBasis : ExactRational)
        (amounts : List ExactRational) (dates : List LocalDate) (source : QuantizedValue),
        Schedules.CreateGenerated policies bookId request policy allocable amounts dates ∧
        accountingSum amounts = .ok amountsSum ∧
        amountsSum.add request.residualValue = .ok totalBasis ∧
        totalBasis.equals request.sourceBasis = true ∧
        usesCumulativeAllocation policy = true ∧
        quantize request.sourceBasis policy.quantizationPolicy.rule = .ok source ∧
        (!source.residual.isZero || policy.allocationAccountId == policy.contraAccountId) =
          false ∧
        planAllocationPostings
          (Schedules.planInput policy request source (Schedules.buildInstallments 1 amounts dates)) =
            .ok (.rejected [allocationPlanDiagnostic]) := by
  constructor
  · intro h
    rcases createAllocationSchedule_cases h with hr | ⟨schedule, hs⟩
    · generalize hx : AccountingCalculation.rejected [allocationPlanDiagnostic] = x at hr
      cases hr with
      | planner hg hs ha hn hcum hq hok hp =>
        exact ⟨_, _, _, _, _, _, _, hg, hs, ha, hn, hcum, hq, hok, hp⟩
      | _ => exact absurd hx (by decide)
    · exact absurd hs Schedules.createRejections_ne_drafted.2.2.2.2.2.2.2.2
  · rintro ⟨policy, allocable, amountsSum, totalBasis, amounts, dates, source, hg, hs, ha, hn, hcum,
      hq, hok, hp⟩
    exact (Schedules.CreateRefusal.planner hg hs ha hn hcum hq hok hp).result

/-- What a call that produced `schedule` computed: its exact amounts and dates (as many of each,
every amount constructible), the plan decision it made of them, and the schedule it assembled. -/
theorem createAllocationSchedule_trace {policies : List AccountingPolicy} {bookId : BookId}
    {request : AllocationScheduleRequest} {schedule : AllocationSchedule}
    {policy : AllocationPolicy} (hpol : ∀ p ∈ policies, p.WF) (hreq : request.WF)
    (hsel : policyAt AllocationPolicy policies request.policyId request.policyVersion
      request.governedAt = .selected policy)
    (h : createAllocationSchedule policies bookId request =
      .ok (drafted [] [.allocationSchedule schedule])) :
    ∃ (amounts : List ExactRational) (dates : List LocalDate) (postingPlan : Option AllocationPostingPlan),
      policy.WF ∧ amounts.length = dates.length ∧ (∀ a ∈ amounts, a.WF) ∧
      (∀ i ∈ Schedules.buildInstallments 1 amounts dates, i.WF) ∧
      Schedules.createPlan policy request (Schedules.buildInstallments 1 amounts dates) =
        .ok (.inr postingPlan) ∧
      schedule = Schedules.assembleSchedule bookId policy request
        (Schedules.buildInstallments 1 amounts dates) postingPlan := by
  obtain ⟨policy', allocable, amountsSum, totalBasis, amounts, dates, postingPlan, hsel', hinc, hal,
    hgen, hsum, hadd, heq, hplan, rfl⟩ := createAllocationSchedule_schedule_inv h
  have hpp : policy' = policy := by
    rw [hsel] at hsel'; exact (AccountingPolicySelection.selected.inj hsel').symm
  subst hpp
  obtain ⟨hpolwf, -, -, -⟩ := policyAt_allocation_selected hpol hsel
  obtain ⟨-, -, hle, -, -⟩ := Schedules.createIncoherent_false hinc
  obtain ⟨halwf, -⟩ := ExactRational.subtract_ok hreq.sourceBasis hreq.residualValue hal
  obtain ⟨hlen, -, -, hw, -, -⟩ := generate_spec hreq.startsOn hreq.endsOn hle halwf
    hreq.residualValue hreq.sourceBasis hpolwf.decliningRate
    (fun u hu => (hreq.usage_getD u hu).value) hgen
  obtain ⟨hm1, -, -⟩ := buildInstallments_spec 1 amounts dates hlen
  refine ⟨amounts, dates, postingPlan, hpolwf, hlen, hw, ?_, hplan, rfl⟩
  intro i hi
  have hmem : i.amount ∈ (Schedules.buildInstallments 1 amounts dates).map (·.amount) :=
    List.mem_map.mpr ⟨i, hi, rfl⟩
  rw [hm1] at hmem
  exact ⟨hw _ hmem⟩


/-- **A schedule of a policy that is not cumulative has no plan, and a cumulative one has the plan
`planAllocationPostings` makes of it, whose posted amounts add up to exactly the source basis
less the residual value rounded to the policy's scale** (the plan's instalments are the
schedule's and its hash is the hash of its body). -/
theorem createAllocationSchedule_plan {policies : List AccountingPolicy} {bookId : BookId}
    {request : AllocationScheduleRequest} {schedule : AllocationSchedule}
    {policy : AllocationPolicy} (hpol : ∀ p ∈ policies, p.WF) (hreq : request.WF)
    (hsel : policyAt AllocationPolicy policies request.policyId request.policyVersion
      request.governedAt = .selected policy)
    (h : createAllocationSchedule policies bookId request =
      .ok (drafted [] [.allocationSchedule schedule])) :
    (usesCumulativeAllocation policy = false ∧ schedule.postingPlan = none) ∨
      (usesCumulativeAllocation policy = true ∧
        ∃ (source rq : QuantizedValue) (plan : AllocationPostingPlan),
          schedule.postingPlan = some plan ∧
          quantize request.sourceBasis policy.quantizationPolicy.rule = .ok source ∧
          quantize request.residualValue policy.quantizationPolicy.rule = .ok rq ∧
          source.residual.isZero = true ∧ plan.postedSourceBasis = source.amount ∧
          plan.postedSourceBasis.toRat = request.sourceBasis.toRat ∧
          plan.residualQuantization = rq ∧ plan.exactSourceBasis = request.sourceBasis ∧
          plan.exactResidualValue = request.residualValue ∧
          plan.quantizationPolicy = policy.quantizationPolicy ∧
          (plan.installments.map (·.postedAmount.toRat)).sum =
            plan.postedSourceBasis.toRat - plan.residualQuantization.amount.toRat ∧
          plan.installments.map (fun i => (i.ordinal, i.accountingDate, i.exactAmount)) =
            schedule.installments.map (fun i => (i.ordinal, i.accountingDate, i.amount)) ∧
          (schedule.installments.map (·.accountingDate)).Pairwise (· < ·) ∧
          plan.contentHash = accountingBodyHash "AllocationPostingPlan" plan) := by
  obtain ⟨amounts, dates, postingPlan, hpolwf, hlen, hw, hinst, hplan, rfl⟩ :=
    createAllocationSchedule_trace hpol hreq hsel h
  rcases createPlan_inr hplan with ⟨hc, hnone⟩ | ⟨hc, source, plan, hq, hz, -, hp, hsome⟩
  · exact Or.inl ⟨hc, by simp [Schedules.assembleSchedule, hnone]⟩
  · subst hsome
    obtain ⟨-, source', rq, hq', hrq, hz', hsrc, hrqeq, hp', hsum, hsched, hmis, hhash⟩ :=
      createPlan_facts hpolwf hreq.sourceBasis hreq.residualValue hinst hplan
    have hss : source' = source := by
      rw [hq] at hq'; exact (Except.ok.inj hq').symm
    subst hss
    obtain ⟨-, -, -, -, -, -, -, -, -, -, -, -, -, hES, hER, hPB, -, hQP, -⟩ :=
      planAllocationPostings_planned_steps hp
    have hPB' : plan.postedSourceBasis = source'.amount := hPB
    refine Or.inr ⟨hc, source', rq, plan, by simp [Schedules.assembleSchedule], hq', hrq, hz',
      hPB', by rw [hPB']; exact hsrc, hrqeq, hES, hER, hQP, ?_, ?_, ?_, hhash⟩
    · rw [hsum, hPB', hsrc, hrqeq]
    · simpa [Schedules.assembleSchedule] using hsched
    · simpa [Schedules.assembleSchedule] using
        (Schedules.scheduleMisordered_false_dates 0 none _ hmis).1

/-- **The exact instalments add up to the allocable amount, to the cent**: the exact amounts of the
schedule's instalments sum to the source basis less the residual value. -/
theorem createAllocationSchedule_exact_sum {policies : List AccountingPolicy} {bookId : BookId}
    {request : AllocationScheduleRequest} {schedule : AllocationSchedule}
    {policy : AllocationPolicy} (hpol : ∀ p ∈ policies, p.WF) (hreq : request.WF)
    (hsel : policyAt AllocationPolicy policies request.policyId request.policyVersion
      request.governedAt = .selected policy)
    (h : createAllocationSchedule policies bookId request =
      .ok (drafted [] [.allocationSchedule schedule])) :
    (schedule.installments.map (·.amount.toRat)).sum =
      request.sourceBasis.toRat - request.residualValue.toRat :=
  (createAllocationSchedule_facts hpol hreq hsel h).1

/-- **The instalments are in strictly increasing date order for a straight-line or declining-balance
schedule and for any cumulative one, and for units of production they are the usage dates in the
order given**, so a legacy schedule built from usage facts out of date order keeps that order. -/
theorem createAllocationSchedule_dates {policies : List AccountingPolicy} {bookId : BookId}
    {request : AllocationScheduleRequest} {schedule : AllocationSchedule}
    {policy : AllocationPolicy} (hpol : ∀ p ∈ policies, p.WF) (hreq : request.WF)
    (hsel : policyAt AllocationPolicy policies request.policyId request.policyVersion
      request.governedAt = .selected policy)
    (h : createAllocationSchedule policies bookId request =
      .ok (drafted [] [.allocationSchedule schedule])) :
    ((policy.method ≠ .unitsOfProduction ∨ usesCumulativeAllocation policy = true) →
        (schedule.installments.map (·.accountingDate)).Pairwise (· < ·)) ∧
      (policy.method = .unitsOfProduction →
        schedule.installments.map (·.accountingDate) = (request.usage.getD []).map (·.date)) := by
  obtain ⟨-, -, -, -, -, hper, huse⟩ := createAllocationSchedule_facts hpol hreq hsel h
  refine ⟨?_, huse⟩
  rintro (hne | hcum)
  · exact hper hne
  · rcases createAllocationSchedule_plan hpol hreq hsel h with ⟨hc, -⟩ | ⟨-, source, rq, plan, -, -, -, -, -, -, -, -, -, -, -, -, hpair, -⟩
    · rw [hcum] at hc; cases hc
    · exact hpair

/-- A schedule whose content hash is set to the hash of its body carries the hash of its own
body. -/
theorem AllocationSchedule.contentHash_of_body (body : AllocationSchedule) :
    ({ body with contentHash := accountingBodyHash "AllocationSchedule" body } :
        AllocationSchedule).contentHash =
      accountingBodyHash "AllocationSchedule"
        { body with contentHash := accountingBodyHash "AllocationSchedule" body } :=
  congrArg (accountingHash "AllocationSchedule")
    (AllocationSchedule.bodyValue_contentHash body
      (accountingBodyHash "AllocationSchedule" body)).symm

/-- A recognition whose content hash is set to the hash of its body carries the hash of its own
body. -/
theorem AllocationRecognition.contentHash_of_body (body : AllocationRecognition) :
    ({ body with contentHash := accountingBodyHash "AllocationRecognition" body } :
        AllocationRecognition).contentHash =
      accountingBodyHash "AllocationRecognition"
        { body with contentHash := accountingBodyHash "AllocationRecognition" body } :=
  congrArg (accountingHash "AllocationRecognition")
    (AllocationRecognition.bodyValue_contentHash body
      (accountingBodyHash "AllocationRecognition" body)).symm

/-- A schedule revision whose content hash is set to the hash of its body carries the hash of its
own body. -/
theorem AllocationScheduleRevision.contentHash_of_body (body : AllocationScheduleRevision) :
    ({ body with contentHash := accountingBodyHash "AllocationScheduleRevision" body } :
        AllocationScheduleRevision).contentHash =
      accountingBodyHash "AllocationScheduleRevision"
        { body with contentHash := accountingBodyHash "AllocationScheduleRevision" body } :=
  congrArg (accountingHash "AllocationScheduleRevision")
    (AllocationScheduleRevision.bodyValue_contentHash body
      (accountingBodyHash "AllocationScheduleRevision" body)).symm

/-- **A created schedule carries the hash of its body**: its `contentHash` is
`accountingHash("AllocationSchedule", body)` of the schedule without its content hash. -/
theorem createAllocationSchedule_hash {policies : List AccountingPolicy} {bookId : BookId}
    {request : AllocationScheduleRequest} {schedule : AllocationSchedule}
    (h : createAllocationSchedule policies bookId request =
      .ok (drafted [] [.allocationSchedule schedule])) :
    schedule.contentHash = accountingBodyHash "AllocationSchedule" schedule := by
  obtain ⟨policy, allocable, amountsSum, totalBasis, amounts, dates, postingPlan, -, -, -, -, -, -, -,
    -, rfl⟩ := createAllocationSchedule_schedule_inv h
  exact AllocationSchedule.contentHash_of_body _


/-- The plan check of the kernel's own hash validation (`allocationPlanIsValid`) accepts a schedule
that `createAllocationSchedule` produced: a policy that names no posting algorithm has no plan, and a
cumulative schedule carries exactly the plan `planAllocationPostings` recomputes from it. -/
theorem createAllocationSchedule_planCheck {policies : List AccountingPolicy} {bookId : BookId}
    {request : AllocationScheduleRequest} {schedule : AllocationSchedule}
    {policy : AllocationPolicy} (hpol : ∀ p ∈ policies, p.WF) (hreq : request.WF)
    (hsel : policyAt AllocationPolicy policies request.policyId request.policyVersion
      request.governedAt = .selected policy)
    (h : createAllocationSchedule policies bookId request =
      .ok (drafted [] [.allocationSchedule schedule])) :
    allocationPlanIsValid schedule = .ok true := by
  obtain ⟨amounts, dates, postingPlan, hpolwf, hlen, hw, hinst, hplan, hsch⟩ :=
    createAllocationSchedule_trace hpol hreq hsel h
  obtain ⟨-, hexec, -, -⟩ := policyAt_allocation_selected hpol hsel
  have hpolicy : schedule.policy = policy := by rw [hsch]; rfl
  have hbasis : schedule.sourceBasis = request.sourceBasis := by rw [hsch]; rfl
  have hresid : schedule.residualValue = request.residualValue := by rw [hsch]; rfl
  have hinstl : schedule.installments = Schedules.buildInstallments 1 amounts dates := by
    rw [hsch]; rfl
  rcases createPlan_inr hplan with ⟨hc, hnone⟩ | ⟨hc, source, plan, hq, hz, hne, hp, hsome⟩
  · have hnoalg : policy.postingAlgorithm = none := by
      cases hpa : policy.postingAlgorithm with
      | none => rfl
      | some a => exact absurd (hexec (by simp [hpa])) (by simp [hc])
    have hnop : schedule.postingPlan = none := by rw [hsch]; simp [Schedules.assembleSchedule, hnone]
    unfold allocationPlanIsValid
    simp [hpolicy, hnoalg, hnop]
  · have hsomep : schedule.postingPlan = some plan := by
      rw [hsch]; simp [Schedules.assembleSchedule, hsome]
    have hcum := (usesCumulativeAllocation_iff policy).mp hc
    have hpa : ¬ policy.postingAlgorithm = none := by rw [hcum.1]; simp
    simp only [Schedules.planInput] at hp
    unfold allocationPlanIsValid
    simp [hpolicy, hbasis, hresid, hinstl, hsomep, hpa, hc, hne, hq, hz, hp, contentHashEquals]


/-- **The kernel's own hash check accepts the effect**: `validateAccountingEffectHash` returns `true`
for the schedule effect a call produced (its plan is the recomputed one, and its content hash is the
hash of its body). -/
theorem createAllocationSchedule_valid {policies : List AccountingPolicy} {bookId : BookId}
    {request : AllocationScheduleRequest} {schedule : AllocationSchedule}
    {policy : AllocationPolicy} (hpol : ∀ p ∈ policies, p.WF) (hreq : request.WF)
    (hsel : policyAt AllocationPolicy policies request.policyId request.policyVersion
      request.governedAt = .selected policy)
    (h : createAllocationSchedule policies bookId request =
      .ok (drafted [] [.allocationSchedule schedule])) :
    validateAccountingEffectHash (.allocationSchedule schedule) = .ok true := by
  rw [validateAccountingEffectHash_true_iff]
  exact ⟨createAllocationSchedule_planCheck hpol hreq hsel h, rfl, createAllocationSchedule_hash h⟩

namespace Schedules

/-- A small positive whole number is a constructible rational with a nonzero numerator. -/
theorem of_small_ok {n : Int} (h1 : 1 ≤ n) (h2 : n ≤ 1200) :
    ∃ r, ExactRational.of n 1 = .ok r ∧ r.WF ∧ r.numerator ≠ 0 := by
  have hw : ∀ m : Int, 0 ≤ m → m ≤ 1200 → withinMagnitude m = true := by
    intro m hm0 hm1
    rw [withinMagnitude_iff]
    have : m.natAbs ≤ 1200 := by omega
    have h11 : (1200 : Nat) < 2 ^ 11 := by norm_num
    have hle : 2 ^ 11 ≤ 2 ^ maxExactIntegerBits :=
      Nat.pow_le_pow_right (by norm_num) (by decide)
    omega
  have hn := hw n (by omega) h2
  have h1w := hw 1 (by omega) (by omega)
  obtain ⟨r, hr⟩ := (ExactRational.of_isOk_iff n 1).mpr ⟨by omega, Or.inr ⟨hn, h1w⟩⟩
  obtain ⟨hwf, hrat, -⟩ := ExactRational.of_ok hr
  refine ⟨r, hr, hwf, ?_⟩
  intro hz
  have : r.toRat = 0 := by simp [ExactRational.toRat, hz]
  rw [hrat] at this
  simp at this
  omega

/-- The size-limit error, as a `ScheduleErr`. -/
def limitError : ScheduleErr := .quantize (.exactNumber .representationLimitExceeded)

/-- A `liftNum` of a failing operation whose only error is the size limit. -/
theorem liftNum_limit {α : Type} {r : Except NumErr α} {e : ScheduleErr}
    (hr : ∀ code, r = .error code → code = .representationLimitExceeded)
    (h : liftNum r = .error e) : e = limitError := by
  obtain ⟨code, hc, rfl⟩ := liftNum_error h
  rw [hr code hc]
  rfl

/-- Adding, subtracting or multiplying constructible values throws only the size error. -/
theorem add_error_limit {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    ∀ code, a.add b = .error code → code = .representationLimitExceeded := by
  intro code h
  rcases ExactRational.add_ok_or_limit ha hb with ⟨c, hc⟩ | hl
  · rw [hc] at h; cases h
  · rw [hl] at h; cases h; rfl

/-- Subtracting constructible values throws only the size error. -/
theorem subtract_error_limit {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    ∀ code, a.subtract b = .error code → code = .representationLimitExceeded := by
  intro code h
  rcases ExactRational.subtract_ok_or_limit ha hb with ⟨c, hc⟩ | hl
  · rw [hc] at h; cases h
  · rw [hl] at h; cases h; rfl

/-- Multiplying constructible values throws only the size error. -/
theorem multiply_error_limit {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    ∀ code, a.multiply b = .error code → code = .representationLimitExceeded := by
  intro code h
  rcases ExactRational.multiply_ok_or_limit ha hb with ⟨c, hc⟩ | hl
  · rw [hc] at h; cases h
  · rw [hl] at h; cases h; rfl

/-- Dividing a constructible value by a divisor with a nonzero numerator throws only the size
error. -/
theorem divide_error_limit {a b : ExactRational} (ha : a.WF) (hb : b.numerator ≠ 0) :
    ∀ code, a.divide b = .error code → code = .representationLimitExceeded := by
  intro code h
  rcases ExactRational.divide_ok_or_error ha (b := b) with ⟨c, hc⟩ | ⟨h0, -⟩ | ⟨-, hl⟩
  · rw [hc] at h; cases h
  · exact absurd h0 hb
  · rw [hl] at h; cases h; rfl

/-- The straight-line amounts of a span of one to 1,200 instalments throw only the size error. -/
theorem straightLineAmounts_error {allocable : ExactRational} {count : Int}
    (hal : allocable.WF) (hc1 : 1 ≤ count) (hc2 : count ≤ 1200) :
    ∀ {dates : List LocalDate} {e : ScheduleErr},
      straightLineAmounts allocable count dates = .error e → e = limitError
  | [], _, h => by simp [straightLineAmounts] at h
  | _ :: rest, e, h => by
    unfold straightLineAmounts at h
    obtain ⟨divisor, hdiv, hdw, hdn⟩ := of_small_ok hc1 hc2
    have hd : liftNum (ExactRational.of count 1) = .ok divisor := by simp [liftNum, hdiv]
    simp only [hd] at h
    rcases hq : liftNum (allocable.divide divisor) with e' | amount
    · rw [hq] at h; cases h
      exact liftNum_limit (divide_error_limit hal hdn) hq
    simp only [hq] at h
    rcases ht : straightLineAmounts allocable count rest with e' | tail
    · rw [ht] at h; cases h
      exact straightLineAmounts_error hal hc1 hc2 ht
    simp [ht] at h

/-- The declining-balance amounts throw only the size error, for a number of periods a year between
one and twelve. -/
theorem decliningBalanceAmounts_error {rate residual : ExactRational} {periodsPerYear : Int}
    (hrate : rate.WF) (hres : residual.WF) (hp1 : 1 ≤ periodsPerYear) (hp2 : periodsPerYear ≤ 12) :
    ∀ {n : Nat} {carrying : ExactRational} {e : ScheduleErr}, carrying.WF →
      decliningBalanceAmounts rate residual periodsPerYear n carrying = .error e → e = limitError
  | 0, _, e, _, h => by simp [decliningBalanceAmounts] at h
  | remaining + 1, carrying, e, hcar, h => by
    unfold decliningBalanceAmounts at h
    rcases hp : liftNum (carrying.multiply rate) with e' | prod
    · rw [hp] at h; cases h
      exact liftNum_limit (multiply_error_limit hcar hrate) hp
    obtain ⟨hprodw, -⟩ := ExactRational.multiply_ok hcar hrate (liftNum_ok hp)
    simp only [hp] at h
    obtain ⟨divisor, hdiv, hdw, hdn⟩ := of_small_ok (n := periodsPerYear) hp1 (by omega)
    have hd : liftNum (ExactRational.of periodsPerYear 1) = .ok divisor := by
      simp [liftNum, hdiv]
    simp only [hd] at h
    rcases hc : liftNum (prod.divide divisor) with e' | calculated
    · rw [hc] at h; cases h
      exact liftNum_limit (divide_error_limit hprodw hdn) hc
    obtain ⟨hcalcw, -⟩ := ExactRational.divide_ok hprodw hdw (liftNum_ok hc)
    simp only [hc] at h
    rcases hr : liftNum (carrying.subtract residual) with e' | remainingAllocable
    · rw [hr] at h; cases h
      exact liftNum_limit (subtract_error_limit hcar hres) hr
    obtain ⟨hremw, -⟩ := ExactRational.subtract_ok hcar hres (liftNum_ok hr)
    simp only [hr] at h
    have hamount : (decliningAmount remaining calculated remainingAllocable).WF := by
      unfold decliningAmount
      split
      · exact hremw
      · exact hcalcw
    rcases hn : liftNum (carrying.subtract (decliningAmount remaining calculated remainingAllocable))
        with e' | next
    · rw [hn] at h; cases h
      exact liftNum_limit (subtract_error_limit hcar hamount) hn
    obtain ⟨hnextw, -⟩ := ExactRational.subtract_ok hcar hamount (liftNum_ok hn)
    simp only [hn] at h
    rcases ht : decliningBalanceAmounts rate residual periodsPerYear remaining next with e' | tail
    · rw [ht] at h; cases h
      exact decliningBalanceAmounts_error hrate hres hp1 hp2 hnextw ht
    simp [ht] at h

/-- The usage amounts throw only the size error, for a total usage with a nonzero numerator. -/
theorem usageAmounts_error {allocable totalUsage : ExactRational} (hal : allocable.WF)
    (htot : totalUsage.WF) (htn : totalUsage.numerator ≠ 0) :
    ∀ {usage : List AllocationUsageFact} {e : ScheduleErr}, (∀ u ∈ usage, u.value.WF) →
      usageAmounts allocable totalUsage usage = .error e → e = limitError
  | [], _, _, h => by simp [usageAmounts] at h
  | item :: rest, e, hvals, h => by
    unfold usageAmounts at h
    rcases hp : liftNum (allocable.multiply item.value) with e' | prod
    · rw [hp] at h; cases h
      exact liftNum_limit (multiply_error_limit hal (hvals item (by simp))) hp
    obtain ⟨hprodw, -⟩ := ExactRational.multiply_ok hal (hvals item (by simp)) (liftNum_ok hp)
    simp only [hp] at h
    rcases hq : liftNum (prod.divide totalUsage) with e' | amount
    · rw [hq] at h; cases h
      exact liftNum_limit (divide_error_limit hprodw htn) hq
    simp only [hq] at h
    rcases ht : usageAmounts allocable totalUsage rest with e' | tail
    · rw [ht] at h; cases h
      exact usageAmounts_error hal htot htn (fun u hu => hvals u (by simp [hu])) ht
    simp [ht] at h

/-- A step is one, three or twelve months. -/
theorem scheduleStepMonths_cases {frequency : AllocationFrequency} {step : Int}
    (h : scheduleStepMonths frequency = some step) : step = 1 ∨ step = 3 ∨ step = 12 := by
  cases frequency <;> simp [scheduleStepMonths] at h <;> omega

/-- A periodic schedule throws only the size error. -/
theorem periodicSchedule_error {policy : AllocationPolicy} {request : AllocationScheduleRequest}
    {allocable : ExactRational} {e : ScheduleErr}
    (hs : request.startsOn.WF) (he : request.endsOn.WF) (hle : request.startsOn ≤ request.endsOn)
    (hal : allocable.WF) (hres : request.residualValue.WF) (hsb : request.sourceBasis.WF)
    (hrate : ∀ r, policy.decliningRate = some r → r.WF)
    (h : periodicSchedule policy request allocable = .error e) : e = limitError := by
  unfold periodicSchedule at h
  rcases hstep : scheduleStepMonths policy.frequency with _ | step
  · simp [hstep] at h
  have hstep' := scheduleStepMonths_cases hstep
  have hstep1 := scheduleStepMonths_pos hstep
  simp only [hstep] at h
  by_cases hconv : policy.convention != .fullPeriod
  · simp [hconv] at h
  simp only [hconv, Bool.false_eq_true, ↓reduceIte] at h
  obtain ⟨hc1, -, -, -⟩ := scheduleDates_spec hs he hle hstep1
  by_cases hspan : (jsDiv (monthsBetween request.startsOn request.endsOn + step - 1) step) >
      (accountingLimits.maxScheduleInstallments : Int)
  · simp [hspan] at h
  simp only [hspan, ↓reduceIte] at h
  have hc2 : jsDiv (monthsBetween request.startsOn request.endsOn + step - 1) step ≤ 1200 := by
    have : ¬ jsDiv (monthsBetween request.startsOn request.endsOn + step - 1) step > 1200 := hspan
    omega
  by_cases hmethod : policy.method == .straightLine
  · simp only [hmethod, ↓reduceIte] at h
    rcases hsl : straightLineAmounts allocable
        (jsDiv (monthsBetween request.startsOn request.endsOn + step - 1) step)
        (scheduleDates request.startsOn step
          (jsDiv (monthsBetween request.startsOn request.endsOn + step - 1) step).toNat)
        with e' | amounts
    · rw [hsl] at h; cases h
      exact straightLineAmounts_error hal hc1 hc2 hsl
    simp [hsl] at h
  · simp only [hmethod, Bool.false_eq_true, ↓reduceIte] at h
    rcases hdr : policy.decliningRate with _ | rate
    · simp [hdr] at h
    simp only [hdr] at h
    by_cases hbad : (!positive rate || rate.compare ⟨1, 1⟩ == .gt) = true
    · simp [hbad] at h
    simp only [hbad, Bool.false_eq_true, ↓reduceIte] at h
    have hp : 1 ≤ jsDiv 12 step ∧ jsDiv 12 step ≤ 12 := by
      rcases hstep' with rfl | rfl | rfl <;> decide
    rcases hdb : decliningBalanceAmounts rate request.residualValue (jsDiv 12 step)
        (jsDiv (monthsBetween request.startsOn request.endsOn + step - 1) step).toNat
        request.sourceBasis with e' | amounts
    · rw [hdb] at h; cases h
      exact decliningBalanceAmounts_error (hrate rate hdr) hres hp.1 hp.2 hsb hdb
    simp [hdb] at h

/-- A units-of-production schedule throws only the size error. -/
theorem usageSchedule_error {policy : AllocationPolicy} {request : AllocationScheduleRequest}
    {allocable : ExactRational} {e : ScheduleErr}
    (hpolwf : policy.WF) (hal : allocable.WF)
    (hvals : ∀ u ∈ request.usage.getD [], u.value.WF)
    (h : usageSchedule policy request allocable = .error e) : e = limitError := by
  unfold usageSchedule at h
  have hsumwf : ∀ v ∈ (request.usage.getD []).map (·.value), v.WF := by
    intro v hv
    obtain ⟨u, hu, rfl⟩ := List.mem_map.mp hv
    exact hvals u hu
  rcases hsum : liftNum (accountingSum ((request.usage.getD []).map (·.value))) with e' | total
  · simp only [hsum, Except.error.injEq] at h
    subst h
    exact liftNum_limit (fun code hc => accountingSum_error hsumwf hc) hsum
  obtain ⟨htotw, -⟩ := accountingSum_ok hsumwf (liftNum_ok hsum)
  simp only [hsum] at h
  by_cases hbound : (request.usage.getD []).length > accountingLimits.maxUsageEvents
  · simp [hbound] at h
  simp only [hbound, ↓reduceIte] at h
  by_cases hbad : usageFactsBad policy request total (request.usage.getD []) = true
  · simp [hbad] at h
  simp only [hbad, Bool.false_eq_true, ↓reduceIte] at h
  have hgood : usageFactsBad policy request total (request.usage.getD []) = false :=
    Bool.eq_false_iff.mpr hbad
  unfold usageFactsBad at hgood
  simp only [Bool.or_eq_false_iff, and_assoc] at hgood
  obtain ⟨-, -, hexp, -⟩ := hgood
  have htn : total.numerator ≠ 0 := by
    intro hz
    rcases hex : policy.expectedUsage with _ | expected
    · simp [hex] at hexp
    · simp only [hex, Bool.or_eq_false_iff, Bool.not_eq_false'] at hexp
      obtain ⟨hpos, heq⟩ := hexp
      have hew := hpolwf.expectedUsage expected hex
      have heq' := (ExactRational.equals_iff htotw hew).mp heq
      have hgt : (positive expected) = true := by simpa using hpos
      unfold positive at hgt
      have hgt' := (ExactRational.compare_gt_iff hew ExactRational.zero_wf).mp (by simpa using hgt)
      rw [ExactRational.zero_toRat, ← heq'] at hgt'
      have : total.toRat = 0 := by simp [ExactRational.toRat, hz]
      linarith
  rcases hua : usageAmounts allocable total (request.usage.getD []) with e' | amounts
  · rw [hua] at h; cases h
    exact usageAmounts_error hal htotw htn hvals hua
  simp [hua] at h

/-- The posting plan of a schedule throws only the size error or the `RangeError` of `quantize` for a
scale outside 0 to 1,000. -/
theorem createPlan_error {policy : AllocationPolicy} {request : AllocationScheduleRequest}
    {installments : List ScheduledAllocation} {e : ScheduleErr}
    (hpolwf : policy.WF) (hsb : request.sourceBasis.WF) (hres : request.residualValue.WF)
    (hinst : ∀ i ∈ installments, i.WF)
    (h : createPlan policy request installments = .error e) :
    e = limitError ∨ e = .quantize .scaleOutOfRange := by
  unfold createPlan at h
  by_cases hc : usesCumulativeAllocation policy = true
  · simp only [hc, ↓reduceIte] at h
    rcases hq : liftQuantize (quantize request.sourceBasis policy.quantizationPolicy.rule) with
      e' | source
    · simp only [hq, Except.error.injEq] at h
      subst h
      obtain ⟨qe, hqe, rfl⟩ := liftQuantize_error hq
      rcases quantize_error_cases hsb hqe with ⟨rfl, -⟩ | ⟨rfl, -, -⟩
      · exact Or.inr rfl
      · exact Or.inl rfl
    obtain ⟨hsrcw, -⟩ := quantize_ok hsb (liftQuantize_ok hq)
    simp only [hq] at h
    by_cases hbad : (!source.residual.isZero || policy.allocationAccountId == policy.contraAccountId) = true
    · simp [hbad] at h
    simp only [hbad, Bool.false_eq_true, ↓reduceIte] at h
    rcases hp : liftQuantize (planAllocationPostings (planInput policy request source installments))
      with e' | result
    · simp only [planInput] at hp
      simp only [hp, Except.error.injEq] at h
      subst h
      obtain ⟨qe, hqe, rfl⟩ := liftQuantize_error hp
      have hw : (planInput policy request source installments).WF :=
        ⟨hsb, hres, hsrcw, hpolwf.core.quantizationPolicy, hinst⟩
      rcases planAllocationPostings_error hw hqe with ⟨rfl, -⟩ | rfl
      · exact Or.inr rfl
      · exact Or.inl rfl
    rcases result with plan | diagnostics
    · simp only [planInput] at hp
      simp [hp] at h
    · simp only [planInput] at hp
      simp [hp] at h
  · simp [hc] at h

/-- The straight-line amounts are each the allocable amount over the number of instalments. -/
theorem straightLineAmounts_values {allocable : ExactRational} {count : Int}
    (hal : allocable.WF) (hc1 : 1 ≤ count) (hc2 : count ≤ 1200) :
    ∀ {dates : List LocalDate} {amounts : List ExactRational},
      straightLineAmounts allocable count dates = .ok amounts →
        amounts.map ExactRational.toRat = dates.map (fun _ => allocable.toRat / (count : ℚ))
  | [], amounts, h => by
    simp only [straightLineAmounts, Except.ok.injEq] at h
    subst h
    simp
  | _ :: rest, amounts, h => by
    unfold straightLineAmounts at h
    obtain ⟨divisor, hdiv, hdw, hdn⟩ := of_small_ok hc1 hc2
    have hd : liftNum (ExactRational.of count 1) = .ok divisor := by simp [liftNum, hdiv]
    simp only [hd] at h
    rcases hq : liftNum (allocable.divide divisor) with e | amount
    · rw [hq] at h; cases h
    simp only [hq] at h
    rcases ht : straightLineAmounts allocable count rest with e | tail
    · rw [ht] at h; cases h
    simp only [ht, Except.ok.injEq] at h
    subst h
    obtain ⟨-, hdrat, -⟩ := ExactRational.of_ok hdiv
    obtain ⟨-, -, hamt⟩ := ExactRational.divide_ok hal hdw (liftNum_ok hq)
    have hdiv' : divisor.toRat = (count : ℚ) := by rw [hdrat]; simp
    simp only [List.map_cons, hamt, hdiv', straightLineAmounts_values hal hc1 hc2 ht]

/-- The declining-balance amounts of one or more periods add up to the carrying amount less the
residual value. -/
theorem decliningBalanceAmounts_sum {rate residual : ExactRational} {periodsPerYear : Int}
    (hrate : rate.WF) (hres : residual.WF) (hp1 : 1 ≤ periodsPerYear) (hp2 : periodsPerYear ≤ 12) :
    ∀ {n : Nat} {carrying : ExactRational} {amounts : List ExactRational}, carrying.WF → 1 ≤ n →
      decliningBalanceAmounts rate residual periodsPerYear n carrying = .ok amounts →
        (amounts.map ExactRational.toRat).sum = carrying.toRat - residual.toRat
  | 0, _, _, _, hn, _ => by omega
  | remaining + 1, carrying, amounts, hcar, _, h => by
    unfold decliningBalanceAmounts at h
    rcases hp : liftNum (carrying.multiply rate) with e | prod
    · rw [hp] at h; cases h
    obtain ⟨hprodw, -⟩ := ExactRational.multiply_ok hcar hrate (liftNum_ok hp)
    simp only [hp] at h
    obtain ⟨divisor, hdiv, hdw, hdn⟩ := of_small_ok (n := periodsPerYear) hp1 (by omega)
    have hd : liftNum (ExactRational.of periodsPerYear 1) = .ok divisor := by simp [liftNum, hdiv]
    simp only [hd] at h
    rcases hc : liftNum (prod.divide divisor) with e | calculated
    · rw [hc] at h; cases h
    obtain ⟨hcalcw, -⟩ := ExactRational.divide_ok hprodw hdw (liftNum_ok hc)
    simp only [hc] at h
    rcases hr : liftNum (carrying.subtract residual) with e | remainingAllocable
    · rw [hr] at h; cases h
    obtain ⟨hremw, hremrat⟩ := ExactRational.subtract_ok hcar hres (liftNum_ok hr)
    simp only [hr] at h
    have hamount : (decliningAmount remaining calculated remainingAllocable).WF := by
      unfold decliningAmount
      split
      · exact hremw
      · exact hcalcw
    rcases hn : liftNum (carrying.subtract (decliningAmount remaining calculated remainingAllocable))
        with e | next
    · rw [hn] at h; cases h
    obtain ⟨hnextw, hnextrat⟩ := ExactRational.subtract_ok hcar hamount (liftNum_ok hn)
    simp only [hn] at h
    rcases ht : decliningBalanceAmounts rate residual periodsPerYear remaining next with e | tail
    · rw [ht] at h; cases h
    simp only [ht, Except.ok.injEq] at h
    subst h
    cases remaining with
    | zero =>
      simp only [decliningBalanceAmounts, Except.ok.injEq] at ht
      subst ht
      have : decliningAmount 0 calculated remainingAllocable = remainingAllocable := by
        simp [decliningAmount]
      simp [this, hremrat]
    | succ r =>
      have ih := decliningBalanceAmounts_sum hrate hres hp1 hp2 hnextw (by omega) ht
      simp only [List.map_cons, List.sum_cons]
      rw [ih, hnextrat]
      ring

/-- The usage amounts are each the allocable amount times the usage over the total usage. -/
theorem usageAmounts_values {allocable totalUsage : ExactRational} (hal : allocable.WF)
    (htot : totalUsage.WF) (htn : totalUsage.numerator ≠ 0) :
    ∀ {usage : List AllocationUsageFact} {amounts : List ExactRational},
      (∀ u ∈ usage, u.value.WF) → usageAmounts allocable totalUsage usage = .ok amounts →
        amounts.map ExactRational.toRat =
          usage.map (fun u => allocable.toRat * u.value.toRat / totalUsage.toRat)
  | [], amounts, _, h => by
    simp only [usageAmounts, Except.ok.injEq] at h
    subst h
    simp
  | item :: rest, amounts, hvals, h => by
    unfold usageAmounts at h
    rcases hp : liftNum (allocable.multiply item.value) with e | prod
    · rw [hp] at h; cases h
    obtain ⟨hprodw, hprodrat⟩ := ExactRational.multiply_ok hal (hvals item (by simp)) (liftNum_ok hp)
    simp only [hp] at h
    rcases hq : liftNum (prod.divide totalUsage) with e | amount
    · rw [hq] at h; cases h
    obtain ⟨-, -, hamt⟩ := ExactRational.divide_ok hprodw htot (liftNum_ok hq)
    simp only [hq] at h
    rcases ht : usageAmounts allocable totalUsage rest with e | tail
    · rw [ht] at h; cases h
    simp only [ht, Except.ok.injEq] at h
    subst h
    simp only [List.map_cons, hamt, hprodrat,
      usageAmounts_values hal htot htn (fun u hu => hvals u (by simp [hu])) ht]

/-- A periodic schedule's exact amounts add up to the allocable amount. -/
theorem periodicSchedule_sum {policy : AllocationPolicy} {request : AllocationScheduleRequest}
    {allocable : ExactRational} {amounts : List ExactRational} {dates : List LocalDate}
    (hs : request.startsOn.WF) (he : request.endsOn.WF) (hle : request.startsOn ≤ request.endsOn)
    (hal : allocable.WF) (hres : request.residualValue.WF) (hsb : request.sourceBasis.WF)
    (hrate : ∀ r, policy.decliningRate = some r → r.WF)
    (hA : allocable.toRat = request.sourceBasis.toRat - request.residualValue.toRat)
    (h : periodicSchedule policy request allocable = .ok (.inr (amounts, dates))) :
    (amounts.map ExactRational.toRat).sum = allocable.toRat := by
  unfold periodicSchedule at h
  rcases hstep : scheduleStepMonths policy.frequency with _ | step
  · simp [hstep] at h
  have hstep' := scheduleStepMonths_cases hstep
  have hstep1 := scheduleStepMonths_pos hstep
  simp only [hstep] at h
  by_cases hconv : policy.convention != .fullPeriod
  · simp [hconv] at h
  simp only [hconv, Bool.false_eq_true, ↓reduceIte] at h
  obtain ⟨hc1, hlen, -, -⟩ := scheduleDates_spec hs he hle hstep1
  by_cases hspan : (jsDiv (monthsBetween request.startsOn request.endsOn + step - 1) step) >
      (accountingLimits.maxScheduleInstallments : Int)
  · simp [hspan] at h
  simp only [hspan, ↓reduceIte] at h
  have hc2 : jsDiv (monthsBetween request.startsOn request.endsOn + step - 1) step ≤ 1200 := by
    have : ¬ jsDiv (monthsBetween request.startsOn request.endsOn + step - 1) step > 1200 := hspan
    omega
  by_cases hmethod : policy.method == .straightLine
  · simp only [hmethod, ↓reduceIte] at h
    rcases hsl : straightLineAmounts allocable
        (jsDiv (monthsBetween request.startsOn request.endsOn + step - 1) step)
        (scheduleDates request.startsOn step
          (jsDiv (monthsBetween request.startsOn request.endsOn + step - 1) step).toNat)
        with e' | amounts'
    · simp [hsl] at h
    simp only [hsl, Except.ok.injEq, Sum.inr.injEq, Prod.mk.injEq] at h
    obtain ⟨rfl, rfl⟩ := h
    rw [straightLineAmounts_values hal hc1 hc2 hsl]
    simp only [List.map_const', List.sum_replicate, hlen]
    have hcast : (((jsDiv (monthsBetween request.startsOn request.endsOn + step - 1) step).toNat : Nat) : ℚ) =
        ((jsDiv (monthsBetween request.startsOn request.endsOn + step - 1) step : Int) : ℚ) := by
      exact_mod_cast Int.toNat_of_nonneg (by omega)
    have hne : ((jsDiv (monthsBetween request.startsOn request.endsOn + step - 1) step : Int) : ℚ) ≠ 0 := by
      exact_mod_cast (by omega : jsDiv (monthsBetween request.startsOn request.endsOn + step - 1) step ≠ 0)
    rw [nsmul_eq_mul, hcast]
    field_simp
  · simp only [hmethod, Bool.false_eq_true, ↓reduceIte] at h
    rcases hdr : policy.decliningRate with _ | rate
    · simp [hdr] at h
    simp only [hdr] at h
    by_cases hbad : (!positive rate || rate.compare ⟨1, 1⟩ == .gt) = true
    · simp [hbad] at h
    simp only [hbad, Bool.false_eq_true, ↓reduceIte] at h
    have hp : 1 ≤ jsDiv 12 step ∧ jsDiv 12 step ≤ 12 := by
      rcases hstep' with rfl | rfl | rfl <;> decide
    rcases hdb : decliningBalanceAmounts rate request.residualValue (jsDiv 12 step)
        (jsDiv (monthsBetween request.startsOn request.endsOn + step - 1) step).toNat
        request.sourceBasis with e' | amounts'
    · simp [hdb] at h
    simp only [hdb, Except.ok.injEq, Sum.inr.injEq, Prod.mk.injEq] at h
    obtain ⟨rfl, rfl⟩ := h
    rw [decliningBalanceAmounts_sum (hrate rate hdr) hres hp.1 hp.2 hsb (by omega) hdb, hA]

/-- A sum of terms with a common divisor is the sum of the numerators over it. -/
theorem sum_map_mul_div (A T : ℚ) (f : AllocationUsageFact → ℚ) :
    ∀ l : List AllocationUsageFact,
      (l.map (fun u => A * f u / T)).sum = A * (l.map f).sum / T
  | [] => by simp
  | x :: xs => by
    simp only [List.map_cons, List.sum_cons, sum_map_mul_div A T f xs]
    ring

/-- A units-of-production schedule's exact amounts add up to the allocable amount. -/
theorem usageSchedule_sum {policy : AllocationPolicy} {request : AllocationScheduleRequest}
    {allocable : ExactRational} {amounts : List ExactRational} {dates : List LocalDate}
    (hpolwf : policy.WF) (hal : allocable.WF)
    (hvals : ∀ u ∈ request.usage.getD [], u.value.WF)
    (h : usageSchedule policy request allocable = .ok (.inr (amounts, dates))) :
    (amounts.map ExactRational.toRat).sum = allocable.toRat := by
  unfold usageSchedule at h
  have hsumwf : ∀ v ∈ (request.usage.getD []).map (·.value), v.WF := by
    intro v hv
    obtain ⟨u, hu, rfl⟩ := List.mem_map.mp hv
    exact hvals u hu
  rcases hsum : liftNum (accountingSum ((request.usage.getD []).map (·.value))) with e' | total
  · simp [hsum] at h
  obtain ⟨htotw, htotrat⟩ := accountingSum_ok hsumwf (liftNum_ok hsum)
  simp only [hsum] at h
  by_cases hbound : (request.usage.getD []).length > accountingLimits.maxUsageEvents
  · simp [hbound] at h
  simp only [hbound, ↓reduceIte] at h
  by_cases hbad : usageFactsBad policy request total (request.usage.getD []) = true
  · simp [hbad] at h
  simp only [hbad, Bool.false_eq_true, ↓reduceIte] at h
  have hgood : usageFactsBad policy request total (request.usage.getD []) = false :=
    Bool.eq_false_iff.mpr hbad
  unfold usageFactsBad at hgood
  simp only [Bool.or_eq_false_iff, and_assoc] at hgood
  obtain ⟨-, -, hexp, -⟩ := hgood
  have htn : total.numerator ≠ 0 := by
    intro hz
    rcases hex : policy.expectedUsage with _ | expected
    · simp [hex] at hexp
    · simp only [hex, Bool.or_eq_false_iff, Bool.not_eq_false'] at hexp
      obtain ⟨hpos, heq⟩ := hexp
      have hew := hpolwf.expectedUsage expected hex
      have heq' := (ExactRational.equals_iff htotw hew).mp heq
      have hgt : (positive expected) = true := by simpa using hpos
      unfold positive at hgt
      have hgt' := (ExactRational.compare_gt_iff hew ExactRational.zero_wf).mp (by simpa using hgt)
      rw [ExactRational.zero_toRat, ← heq'] at hgt'
      have : total.toRat = 0 := by simp [ExactRational.toRat, hz]
      linarith
  have htne : total.toRat ≠ 0 := by
    intro hz
    have : (total.numerator : ℚ) = 0 := by
      have hden : (total.denominator : ℚ) ≠ 0 := ExactRational.den_ne htotw
      simpa [ExactRational.toRat, hden] using hz
    exact htn (by exact_mod_cast this)
  rcases hua : usageAmounts allocable total (request.usage.getD []) with e' | amounts'
  · simp [hua] at h
  simp only [hua, Except.ok.injEq, Sum.inr.injEq, Prod.mk.injEq] at h
  obtain ⟨rfl, rfl⟩ := h
  rw [usageAmounts_values hal htotw htn hvals hua, sum_map_mul_div]
  have hsum' : ((request.usage.getD []).map (·.value.toRat)).sum = total.toRat := by
    rw [htotrat, List.map_map]
    rfl
  rw [hsum']
  field_simp

/-- The exact amounts of a schedule add up to the allocable amount, whichever method made them. -/
theorem generate_sum {policy : AllocationPolicy} {request : AllocationScheduleRequest}
    {allocable : ExactRational} {amounts : List ExactRational} {dates : List LocalDate}
    (hpolwf : policy.WF) (hs : request.startsOn.WF) (he : request.endsOn.WF)
    (hle : request.startsOn ≤ request.endsOn) (hal : allocable.WF)
    (hres : request.residualValue.WF) (hsb : request.sourceBasis.WF)
    (hvals : ∀ u ∈ request.usage.getD [], u.value.WF)
    (hA : allocable.toRat = request.sourceBasis.toRat - request.residualValue.toRat)
    (h : generate policy request allocable = .ok (.inr (amounts, dates))) :
    (amounts.map ExactRational.toRat).sum = allocable.toRat := by
  unfold generate at h
  by_cases hm : (policy.method == .straightLine || policy.method == .decliningBalance) = true
  · simp only [hm, ↓reduceIte] at h
    exact periodicSchedule_sum hs he hle hal hres hsb hpolwf.decliningRate hA h
  · simp only [hm, Bool.false_eq_true, ↓reduceIte] at h
    exact usageSchedule_sum hpolwf hal hvals h

end Schedules

/-- **The only errors of `createAllocationSchedule` are the size limit and the scale range**
(`representation_limit_exceeded` and the `RangeError` of `quantize`), and it builds no date from
text and no identifier, so none can fail. -/
theorem createAllocationSchedule_error {policies : List AccountingPolicy} {bookId : BookId}
    {request : AllocationScheduleRequest} {e : ScheduleErr}
    (hpol : ∀ p ∈ policies, p.WF) (hreq : request.WF)
    (h : createAllocationSchedule policies bookId request = .error e) :
    e = Schedules.limitError ∨ e = .quantize .scaleOutOfRange := by
  unfold createAllocationSchedule at h
  rcases hpa : policyAt AllocationPolicy policies request.policyId request.policyVersion
      request.governedAt with policy | diagnostics
  swap
  · simp [hpa] at h
  simp only [hpa] at h
  obtain ⟨hpolwf, -, -, -⟩ := policyAt_allocation_selected hpol hpa
  by_cases hinc : Schedules.createIncoherent policy bookId request = true
  · simp [hinc] at h
  have hinc' : Schedules.createIncoherent policy bookId request = false :=
    Bool.eq_false_iff.mpr hinc
  obtain ⟨-, -, hle, -, -⟩ := Schedules.createIncoherent_false hinc'
  simp only [hinc, Bool.false_eq_true, ↓reduceIte] at h
  rcases hal : Schedules.liftNum (request.sourceBasis.subtract request.residualValue) with
    e' | allocable
  · simp only [hal, Except.error.injEq] at h
    subst h
    exact Or.inl (Schedules.liftNum_limit
      (Schedules.subtract_error_limit hreq.sourceBasis hreq.residualValue) hal)
  obtain ⟨halwf, -⟩ := ExactRational.subtract_ok hreq.sourceBasis hreq.residualValue
    (Schedules.liftNum_ok hal)
  simp only [hal] at h
  rcases hg : Schedules.generate policy request allocable with e' | gen
  · simp only [hg, Except.error.injEq] at h
    subst h
    refine Or.inl ?_
    unfold Schedules.generate at hg
    by_cases hm : (policy.method == .straightLine || policy.method == .decliningBalance) = true
    · simp only [hm, ↓reduceIte] at hg
      exact Schedules.periodicSchedule_error hreq.startsOn hreq.endsOn hle halwf hreq.residualValue
        hreq.sourceBasis hpolwf.decliningRate hg
    · simp only [hm, Bool.false_eq_true, ↓reduceIte] at hg
      exact Schedules.usageSchedule_error hpolwf halwf
        (fun u hu => (hreq.usage_getD u hu).value) hg
  rcases gen with rejection | ⟨amounts, dates⟩
  · simp [hg] at h
  obtain ⟨hlen, -, -, hw, -, -⟩ := generate_spec hreq.startsOn hreq.endsOn hle halwf
    hreq.residualValue hreq.sourceBasis hpolwf.decliningRate
    (fun u hu => (hreq.usage_getD u hu).value) hg
  simp only [hg] at h
  rcases hs : Schedules.liftNum (accountingSum amounts) with e' | amountsSum
  · simp only [hs, Except.error.injEq] at h
    subst h
    exact Or.inl (Schedules.liftNum_limit
      (fun code hc => Schedules.accountingSum_error hw hc) hs)
  obtain ⟨hsw, -⟩ := Schedules.accountingSum_ok hw (Schedules.liftNum_ok hs)
  simp only [hs] at h
  rcases ht : Schedules.liftNum (amountsSum.add request.residualValue) with e' | totalBasis
  · simp only [ht, Except.error.injEq] at h
    subst h
    exact Or.inl (Schedules.liftNum_limit
      (Schedules.add_error_limit hsw hreq.residualValue) ht)
  simp only [ht] at h
  by_cases hn : (!totalBasis.equals request.sourceBasis) = true
  · simp [hn] at h
  simp only [hn, Bool.false_eq_true, ↓reduceIte] at h
  obtain ⟨hm1, -, -⟩ := buildInstallments_spec 1 amounts dates hlen
  have hinst : ∀ i ∈ Schedules.buildInstallments 1 amounts dates, i.WF := by
    intro i hi
    have hmem : i.amount ∈ (Schedules.buildInstallments 1 amounts dates).map (·.amount) :=
      List.mem_map.mpr ⟨i, hi, rfl⟩
    rw [hm1] at hmem
    exact ⟨hw _ hmem⟩
  rcases hp : Schedules.createPlan policy request (Schedules.buildInstallments 1 amounts dates) with
    e' | planned
  · simp only [hp, Except.error.injEq] at h
    subst h
    exact Schedules.createPlan_error hpolwf hreq.sourceBasis hreq.residualValue hinst hp
  · simp only [hp] at h
    rcases planned with rejection | postingPlan <;> simp at h

/-- **The conservation check never fires**: the exact instalments always add up to the allocable
amount, so a schedule is never refused for not conserving the source basis. -/
theorem createAllocationSchedule_conservation_unreachable {policies : List AccountingPolicy}
    {bookId : BookId} {request : AllocationScheduleRequest}
    (hpol : ∀ p ∈ policies, p.WF) (hreq : request.WF) :
    createAllocationSchedule policies bookId request ≠
      .ok Schedules.createInstallmentsConservationRejection := by
  intro h
  obtain ⟨policy, allocable, amountsSum, totalBasis, amounts, dates, hg, hs, ha, hn⟩ :=
    createAllocationSchedule_conservation_iff.mp h
  obtain ⟨hpolwf, -, -, -⟩ := policyAt_allocation_selected hpol hg.selected
  obtain ⟨-, -, hle, -, -⟩ := Schedules.createIncoherent_false hg.coherent
  obtain ⟨halwf, hArat⟩ :=
    ExactRational.subtract_ok hreq.sourceBasis hreq.residualValue hg.computed
  obtain ⟨-, -, -, hw, -, -⟩ := generate_spec hreq.startsOn hreq.endsOn hle halwf
    hreq.residualValue hreq.sourceBasis hpolwf.decliningRate
    (fun u hu => (hreq.usage_getD u hu).value) hg.generated
  have hsumA := Schedules.generate_sum hpolwf hreq.startsOn hreq.endsOn hle halwf
    hreq.residualValue hreq.sourceBasis (fun u hu => (hreq.usage_getD u hu).value) hArat
    hg.generated
  obtain ⟨hsumwf, hsumrat⟩ := Schedules.accountingSum_ok hw hs
  obtain ⟨htotwf, htotrat⟩ := ExactRational.add_ok hsumwf hreq.residualValue ha
  have heq : totalBasis.equals request.sourceBasis = true :=
    (ExactRational.equals_iff htotwf hreq.sourceBasis).mpr (by
      rw [htotrat, hsumrat, hsumA, hArat]
      ring)
  rw [hn] at heq
  cases heq

end Rastrata.Kernel

/-
What the exact amounts and dates of a schedule satisfy (`accounting.ts` lines 1578 to 1602):
`straightLineAmounts`, `decliningBalanceAmounts` and `usageAmounts` return as many amounts as there
are dates, usage facts or periods, and every amount is constructible; the periodic dates are first
of month dates in strictly increasing order; the dates of a units-of-production schedule are the
usage dates in the order given.
-/
import Rastrata.Kernel.Accounting.Schedules.Basics
import Rastrata.Kernel.Accounting.Schedules.Calendar

namespace Rastrata.Kernel

namespace Schedules

/-- A step of a schedule is a whole number of months, at least one. -/
theorem scheduleStepMonths_pos {frequency : AllocationFrequency} {step : Int}
    (h : scheduleStepMonths frequency = some step) : 1 ≤ step := by
  cases frequency <;> simp [scheduleStepMonths] at h <;> omega

/-- The straight-line amounts are as many as the dates, and constructible when the allocable amount
is. -/
theorem straightLineAmounts_spec {allocable : ExactRational} {count : Int} :
    ∀ {dates : List LocalDate} {amounts : List ExactRational},
      straightLineAmounts allocable count dates = .ok amounts →
        amounts.length = dates.length ∧ (allocable.WF → ∀ a ∈ amounts, a.WF)
  | [], amounts, h => by
    simp only [straightLineAmounts, Except.ok.injEq] at h
    subst h
    simp
  | _ :: rest, amounts, h => by
    unfold straightLineAmounts at h
    rcases hd : liftNum (ExactRational.of count 1) with e | divisor
    · simp [hd] at h
    rcases hq : liftNum (allocable.divide divisor) with e | amount
    · simp [hd, hq] at h
    rcases ht : straightLineAmounts allocable count rest with e | tail
    · simp [hd, hq, ht] at h
    simp only [hd, hq, ht, Except.ok.injEq] at h
    subst h
    obtain ⟨hlen, hwf⟩ := straightLineAmounts_spec ht
    refine ⟨by simp [hlen], fun hal a ha => ?_⟩
    rcases List.mem_cons.mp ha with rfl | ha
    · obtain ⟨hdw, -⟩ := ExactRational.of_ok (liftNum_ok hd)
      exact (ExactRational.divide_ok hal hdw (liftNum_ok hq)).1
    · exact hwf hal a ha

/-- The declining-balance amounts are as many as the periods left, and constructible when the rate,
the residual value and the carrying amount are. -/
theorem decliningBalanceAmounts_spec {rate residual : ExactRational} {periodsPerYear : Int} :
    ∀ {n : Nat} {carrying : ExactRational} {amounts : List ExactRational},
      decliningBalanceAmounts rate residual periodsPerYear n carrying = .ok amounts →
        amounts.length = n ∧
          (rate.WF → residual.WF → carrying.WF → ∀ a ∈ amounts, a.WF)
  | 0, _, amounts, h => by
    simp only [decliningBalanceAmounts, Except.ok.injEq] at h
    subst h
    simp
  | remaining + 1, carrying, amounts, h => by
    unfold decliningBalanceAmounts at h
    rcases hp : liftNum (carrying.multiply rate) with e | prod
    · simp [hp] at h
    rcases hd : liftNum (ExactRational.of periodsPerYear 1) with e | divisor
    · simp [hp, hd] at h
    rcases hc : liftNum (prod.divide divisor) with e | calculated
    · simp [hp, hd, hc] at h
    rcases hr : liftNum (carrying.subtract residual) with e | remainingAllocable
    · simp [hp, hd, hc, hr] at h
    rcases hn : liftNum (carrying.subtract (decliningAmount remaining calculated remainingAllocable))
        with e | next
    · simp [hp, hd, hc, hr, hn] at h
    rcases ht : decliningBalanceAmounts rate residual periodsPerYear remaining next with e | tail
    · simp [hp, hd, hc, hr, hn, ht] at h
    simp only [hp, hd, hc, hr, hn, ht, Except.ok.injEq] at h
    subst h
    obtain ⟨hlen, hwf⟩ := decliningBalanceAmounts_spec ht
    refine ⟨by simp [hlen], fun hrate hres hcar a ha => ?_⟩
    have hprod := ExactRational.multiply_ok hcar hrate (liftNum_ok hp)
    have hdiv := ExactRational.of_ok (liftNum_ok hd)
    have hcalc := ExactRational.divide_ok hprod.1 hdiv.1 (liftNum_ok hc)
    have hrem := ExactRational.subtract_ok hcar hres (liftNum_ok hr)
    have hamount : (decliningAmount remaining calculated remainingAllocable).WF := by
      unfold decliningAmount
      split
      · exact hrem.1
      · exact hcalc.1
    have hnext := ExactRational.subtract_ok hcar hamount (liftNum_ok hn)
    rcases List.mem_cons.mp ha with rfl | ha
    · simpa using hamount
    · exact hwf hrate hres hnext.1 a ha

/-- One amount for each usage fact, constructible when the allocable amount, the total usage and
the values are. -/
theorem usageAmounts_spec {allocable totalUsage : ExactRational} :
    ∀ {usage : List AllocationUsageFact} {amounts : List ExactRational},
      usageAmounts allocable totalUsage usage = .ok amounts →
        amounts.length = usage.length ∧
          (allocable.WF → totalUsage.WF → (∀ u ∈ usage, u.value.WF) → ∀ a ∈ amounts, a.WF)
  | [], amounts, h => by
    simp only [usageAmounts, Except.ok.injEq] at h
    subst h
    simp
  | item :: rest, amounts, h => by
    unfold usageAmounts at h
    rcases hp : liftNum (allocable.multiply item.value) with e | prod
    · simp [hp] at h
    rcases hq : liftNum (prod.divide totalUsage) with e | amount
    · simp [hp, hq] at h
    rcases ht : usageAmounts allocable totalUsage rest with e | tail
    · simp [hp, hq, ht] at h
    simp only [hp, hq, ht, Except.ok.injEq] at h
    subst h
    obtain ⟨hlen, hwf⟩ := usageAmounts_spec ht
    refine ⟨by simp [hlen], fun hal htot hvals a ha => ?_⟩
    rcases List.mem_cons.mp ha with rfl | ha
    · have hprod := ExactRational.multiply_ok hal (hvals item (by simp)) (liftNum_ok hp)
      exact (ExactRational.divide_ok hprod.1 htot (liftNum_ok hq)).1
    · exact hwf hal htot (fun u hu => hvals u (by simp [hu])) a ha

end Schedules

/-- The periodic methods produce as many amounts as dates, between one and 1,200 of them, every
amount constructible, the dates first of month dates in strictly increasing order, and the policy
a monthly, quarterly or annual full-period one. -/
theorem periodicSchedule_spec {policy : AllocationPolicy} {request : AllocationScheduleRequest}
    {allocable : ExactRational} {amounts : List ExactRational} {dates : List LocalDate}
    (hs : request.startsOn.WF) (he : request.endsOn.WF) (hle : request.startsOn ≤ request.endsOn)
    (hal : allocable.WF) (hres : request.residualValue.WF) (hsb : request.sourceBasis.WF)
    (hrate : ∀ r, policy.decliningRate = some r → r.WF)
    (h : Schedules.periodicSchedule policy request allocable = .ok (.inr (amounts, dates))) :
    amounts.length = dates.length ∧ 1 ≤ dates.length ∧
      dates.length ≤ accountingLimits.maxScheduleInstallments ∧ (∀ a ∈ amounts, a.WF) ∧
      (∀ d ∈ dates, d.WF ∧ d.toCalendarDate.day = 1) ∧ dates.Pairwise (· < ·) ∧
      policy.frequency ≠ .eventDriven ∧ policy.convention = .fullPeriod := by
  unfold Schedules.periodicSchedule at h
  rcases hstep : Schedules.scheduleStepMonths policy.frequency with _ | step
  · simp [hstep] at h
  have hstep1 := Schedules.scheduleStepMonths_pos hstep
  simp only [hstep] at h
  by_cases hconv : policy.convention != .fullPeriod
  · simp [hconv] at h
  have hconv' : policy.convention = .fullPeriod := by simpa using hconv
  simp only [hconv, Bool.false_eq_true, ↓reduceIte] at h
  have hfreq : policy.frequency ≠ .eventDriven := by
    intro hf; rw [hf] at hstep; simp [Schedules.scheduleStepMonths] at hstep
  obtain ⟨hc1, hlen, hdwf, hpair⟩ := scheduleDates_spec hs he hle hstep1
  by_cases hspan : (jsDiv (Schedules.monthsBetween request.startsOn request.endsOn + step - 1) step) >
      (accountingLimits.maxScheduleInstallments : Int)
  · simp [hspan] at h
  simp only [hspan, ↓reduceIte] at h
  have hcount_le : (jsDiv (Schedules.monthsBetween request.startsOn request.endsOn + step - 1) step).toNat ≤
      accountingLimits.maxScheduleInstallments := by omega
  by_cases hmethod : policy.method == .straightLine
  · simp only [hmethod, ↓reduceIte] at h
    rcases hsl : Schedules.straightLineAmounts allocable
        (jsDiv (Schedules.monthsBetween request.startsOn request.endsOn + step - 1) step)
        (Schedules.scheduleDates request.startsOn step
          (jsDiv (Schedules.monthsBetween request.startsOn request.endsOn + step - 1) step).toNat)
        with e | amounts'
    · simp [hsl] at h
    simp only [hsl, Except.ok.injEq, Sum.inr.injEq, Prod.mk.injEq] at h
    obtain ⟨rfl, rfl⟩ := h
    obtain ⟨hl, hw⟩ := Schedules.straightLineAmounts_spec hsl
    exact ⟨hl, by omega, by omega, hw hal, hdwf, hpair, hfreq, hconv'⟩
  · simp only [hmethod, Bool.false_eq_true, ↓reduceIte] at h
    rcases hdr : policy.decliningRate with _ | rate
    · simp [hdr] at h
    simp only [hdr] at h
    by_cases hbad : (!positive rate || rate.compare ⟨1, 1⟩ == .gt) = true
    · simp [hbad] at h
    simp only [hbad, Bool.false_eq_true, ↓reduceIte] at h
    rcases hdb : Schedules.decliningBalanceAmounts rate request.residualValue (jsDiv 12 step)
        (jsDiv (Schedules.monthsBetween request.startsOn request.endsOn + step - 1) step).toNat
        request.sourceBasis with e | amounts'
    · simp [hdb] at h
    simp only [hdb, Except.ok.injEq, Sum.inr.injEq, Prod.mk.injEq] at h
    obtain ⟨rfl, rfl⟩ := h
    obtain ⟨hl, hw⟩ := Schedules.decliningBalanceAmounts_spec hdb
    exact ⟨by omega, by omega, by omega, hw (hrate rate hdr) hres hsb, hdwf, hpair, hfreq, hconv'⟩

/-- A units-of-production schedule has one amount for each usage fact, in the order the facts were
given, so its dates are the usage dates in that order; between one and 1,200 of them, distinct and
within the span of the schedule, every amount constructible. -/
theorem usageSchedule_spec {policy : AllocationPolicy} {request : AllocationScheduleRequest}
    {allocable : ExactRational} {amounts : List ExactRational} {dates : List LocalDate}
    (hal : allocable.WF) (hvals : ∀ u ∈ request.usage.getD [], u.value.WF)
    (h : Schedules.usageSchedule policy request allocable = .ok (.inr (amounts, dates))) :
    amounts.length = dates.length ∧ dates = (request.usage.getD []).map (·.date) ∧
      1 ≤ dates.length ∧ dates.length ≤ accountingLimits.maxUsageEvents ∧
      (∀ a ∈ amounts, a.WF) ∧ dates.Nodup ∧
      (∀ d ∈ dates, request.startsOn ≤ d ∧ d ≤ request.endsOn) ∧
      policy.frequency = .eventDriven ∧ policy.convention = .usageEvent := by
  unfold Schedules.usageSchedule at h
  rcases hsum : Schedules.liftNum (accountingSum ((request.usage.getD []).map (·.value))) with
    e | totalUsage
  · simp [hsum] at h
  simp only [hsum] at h
  by_cases hbound : (request.usage.getD []).length > accountingLimits.maxUsageEvents
  · simp [hbound] at h
  simp only [hbound, ↓reduceIte] at h
  by_cases hbad : Schedules.usageFactsBad policy request totalUsage (request.usage.getD []) = true
  · simp [hbad] at h
  simp only [hbad, Bool.false_eq_true, ↓reduceIte] at h
  rcases hua : Schedules.usageAmounts allocable totalUsage (request.usage.getD []) with e | amounts'
  · simp [hua] at h
  simp only [hua, Except.ok.injEq, Sum.inr.injEq, Prod.mk.injEq] at h
  obtain ⟨rfl, rfl⟩ := h
  have hgood : Schedules.usageFactsBad policy request totalUsage (request.usage.getD []) = false :=
    Bool.eq_false_iff.mpr hbad
  unfold Schedules.usageFactsBad at hgood
  simp only [Bool.or_eq_false_iff, bne_eq_false_iff_eq, Bool.not_eq_false', decide_eq_true_eq,
    List.any_eq_false, Bool.or_eq_false_iff, Bool.not_eq_false'] at hgood
  obtain ⟨⟨⟨⟨⟨hfreq, hconv⟩, hexp⟩, hempty⟩, hnodup⟩, hrange⟩ := hgood
  have hsumwf : ∀ v ∈ (request.usage.getD []).map (·.value), v.WF := by
    intro v hv
    obtain ⟨u, hu, rfl⟩ := List.mem_map.mp hv
    exact hvals u hu
  obtain ⟨htotwf, -⟩ := Schedules.accountingSum_ok hsumwf (Schedules.liftNum_ok hsum)
  obtain ⟨hl, hw⟩ := Schedules.usageAmounts_spec hua
  refine ⟨by simpa using hl, rfl, ?_, ?_, hw hal htotwf hvals, hnodup, ?_, hfreq, hconv⟩
  · simp only [List.length_map]
    rcases hlist : request.usage.getD [] with _ | ⟨x, xs⟩
    · simp [hlist] at hempty
    · simp
  · simpa using Nat.le_of_not_lt hbound
  · intro d hd
    obtain ⟨u, hu, rfl⟩ := List.mem_map.mp hd
    have key := hrange u hu
    simp only [Bool.or_eq_true, decide_eq_true_eq, not_or] at key
    have h1 : request.startsOn ≤ u.date ↔ ¬ u.date < request.startsOn :=
      jsStringLe_iff_not_lt request.startsOn.value u.date.value
    have h2 : u.date ≤ request.endsOn ↔ ¬ request.endsOn < u.date :=
      jsStringLe_iff_not_lt u.date.value request.endsOn.value
    exact ⟨h1.mpr key.1.2, h2.mpr key.2⟩

/-- A periodic schedule is refused for exactly one of three reasons, each with its own condition:
the frequency is event driven or the convention is not full period; the span needs more than 1,200
instalments; or a declining-balance policy has no rate, a rate that is not positive, or one above
one. -/
theorem periodicSchedule_inl {policy : AllocationPolicy} {request : AllocationScheduleRequest}
    {allocable : ExactRational} {x : AccountingCalculation}
    (h : Schedules.periodicSchedule policy request allocable = .ok (.inl x)) :
    (x = Schedules.createPolicyRejection ∧
        (policy.frequency = .eventDriven ∨ policy.convention ≠ .fullPeriod)) ∨
      (x = Schedules.createSpanRejection ∧ policy.frequency ≠ .eventDriven ∧
        policy.convention = .fullPeriod ∧
        ∃ step, Schedules.scheduleStepMonths policy.frequency = some step ∧
          jsDiv (Schedules.monthsBetween request.startsOn request.endsOn + step - 1) step >
            (accountingLimits.maxScheduleInstallments : Int)) ∨
      (x = Schedules.createDecliningRateRejection ∧ policy.frequency ≠ .eventDriven ∧
        policy.convention = .fullPeriod ∧ (policy.method == .straightLine) = false ∧
        (∃ step, Schedules.scheduleStepMonths policy.frequency = some step ∧
          ¬ jsDiv (Schedules.monthsBetween request.startsOn request.endsOn + step - 1) step >
            (accountingLimits.maxScheduleInstallments : Int)) ∧
        (policy.decliningRate = none ∨ ∃ rate, policy.decliningRate = some rate ∧
          (!positive rate || rate.compare ⟨1, 1⟩ == .gt) = true)) := by
  unfold Schedules.periodicSchedule at h
  rcases hstep : Schedules.scheduleStepMonths policy.frequency with _ | step
  · simp only [hstep, Except.ok.injEq, Sum.inl.injEq] at h
    subst h
    have : policy.frequency = .eventDriven := by
      cases hf : policy.frequency <;> simp_all [Schedules.scheduleStepMonths]
    exact Or.inl ⟨rfl, Or.inl this⟩
  have hfreq : policy.frequency ≠ .eventDriven := by
    intro hf; rw [hf] at hstep; simp [Schedules.scheduleStepMonths] at hstep
  simp only [hstep] at h
  by_cases hconv : policy.convention != .fullPeriod
  · simp only [hconv, ↓reduceIte, Except.ok.injEq, Sum.inl.injEq] at h
    subst h
    exact Or.inl ⟨rfl, Or.inr (by simpa using hconv)⟩
  have hconv' : policy.convention = .fullPeriod := by simpa using hconv
  simp only [hconv, Bool.false_eq_true, ↓reduceIte] at h
  by_cases hspan : (jsDiv (Schedules.monthsBetween request.startsOn request.endsOn + step - 1) step) >
      (accountingLimits.maxScheduleInstallments : Int)
  · simp only [hspan, ↓reduceIte, Except.ok.injEq, Sum.inl.injEq] at h
    subst h
    exact Or.inr (Or.inl ⟨rfl, hfreq, hconv', step, rfl, hspan⟩)
  simp only [hspan, ↓reduceIte] at h
  by_cases hmethod : policy.method == .straightLine
  · simp only [hmethod, ↓reduceIte] at h
    rcases hsl : Schedules.straightLineAmounts allocable
        (jsDiv (Schedules.monthsBetween request.startsOn request.endsOn + step - 1) step)
        (Schedules.scheduleDates request.startsOn step
          (jsDiv (Schedules.monthsBetween request.startsOn request.endsOn + step - 1) step).toNat)
        with e | amounts'
    · simp [hsl] at h
    · simp [hsl] at h
  · simp only [hmethod, Bool.false_eq_true, ↓reduceIte] at h
    rcases hdr : policy.decliningRate with _ | rate
    · simp only [hdr, Except.ok.injEq, Sum.inl.injEq] at h
      subst h
      exact Or.inr (Or.inr ⟨rfl, hfreq, hconv', by simpa using hmethod, ⟨step, rfl, hspan⟩,
        Or.inl rfl⟩)
    simp only [hdr] at h
    by_cases hbad : (!positive rate || rate.compare ⟨1, 1⟩ == .gt) = true
    · simp only [hbad, ↓reduceIte, Except.ok.injEq, Sum.inl.injEq] at h
      subst h
      exact Or.inr (Or.inr ⟨rfl, hfreq, hconv', by simpa using hmethod, ⟨step, rfl, hspan⟩,
        Or.inr ⟨rate, rfl, hbad⟩⟩)
    simp only [hbad, Bool.false_eq_true, ↓reduceIte] at h
    rcases hdb : Schedules.decliningBalanceAmounts rate request.residualValue (jsDiv 12 step)
        (jsDiv (Schedules.monthsBetween request.startsOn request.endsOn + step - 1) step).toNat
        request.sourceBasis with e | amounts'
    · simp [hdb] at h
    · simp [hdb] at h

/-- An event-driven frequency, or a convention that is not full period, makes a periodic schedule
refuse its policy's shape. -/
theorem periodicSchedule_policy_rejected {policy : AllocationPolicy}
    {request : AllocationScheduleRequest} {allocable : ExactRational}
    (h : policy.frequency = .eventDriven ∨ policy.convention ≠ .fullPeriod) :
    Schedules.periodicSchedule policy request allocable = .ok (.inl Schedules.createPolicyRejection) := by
  unfold Schedules.periodicSchedule
  rcases hstep : Schedules.scheduleStepMonths policy.frequency with _ | step
  · simp
  · have hconv : policy.convention ≠ .fullPeriod := by
      rcases h with hf | hc
      · rw [hf] at hstep; simp [Schedules.scheduleStepMonths] at hstep
      · exact hc
    simp [hconv]

/-- A span that needs more than 1,200 instalments is refused. -/
theorem periodicSchedule_span_rejected {policy : AllocationPolicy}
    {request : AllocationScheduleRequest} {allocable : ExactRational} {step : Int}
    (hstep : Schedules.scheduleStepMonths policy.frequency = some step)
    (hconv : policy.convention = .fullPeriod)
    (hspan : jsDiv (Schedules.monthsBetween request.startsOn request.endsOn + step - 1) step >
      (accountingLimits.maxScheduleInstallments : Int)) :
    Schedules.periodicSchedule policy request allocable = .ok (.inl Schedules.createSpanRejection) := by
  unfold Schedules.periodicSchedule
  simp [hstep, hconv, hspan]

/-- A declining-balance policy with no rate, a rate that is not positive, or a rate above one is
refused. -/
theorem periodicSchedule_rate_rejected {policy : AllocationPolicy}
    {request : AllocationScheduleRequest} {allocable : ExactRational} {step : Int}
    (hstep : Schedules.scheduleStepMonths policy.frequency = some step)
    (hconv : policy.convention = .fullPeriod)
    (hspan : ¬ jsDiv (Schedules.monthsBetween request.startsOn request.endsOn + step - 1) step >
      (accountingLimits.maxScheduleInstallments : Int))
    (hmethod : (policy.method == .straightLine) = false)
    (hrate : policy.decliningRate = none ∨ ∃ rate, policy.decliningRate = some rate ∧
      (!positive rate || rate.compare ⟨1, 1⟩ == .gt) = true) :
    Schedules.periodicSchedule policy request allocable =
      .ok (.inl Schedules.createDecliningRateRejection) := by
  unfold Schedules.periodicSchedule
  simp only [hstep, hconv, bne_self_eq_false, Bool.false_eq_true, ↓reduceIte, hspan, hmethod]
  rcases hrate with hnone | ⟨rate, hr, hbad⟩
  · simp [hnone]
  · simp [hr, hbad]

/-- A units-of-production schedule is refused for exactly one of two reasons: more than 1,200
usage facts, or usage facts that fail the test of `usageFactsBad` (the usage population is within
the bound). -/
theorem usageSchedule_inl {policy : AllocationPolicy} {request : AllocationScheduleRequest}
    {allocable : ExactRational} {x : AccountingCalculation}
    (h : Schedules.usageSchedule policy request allocable = .ok (.inl x)) :
    ∃ totalUsage, Schedules.liftNum (accountingSum ((request.usage.getD []).map (·.value))) =
        .ok totalUsage ∧
      ((request.usage.getD []).length > accountingLimits.maxUsageEvents ∧
          x = Schedules.createUsageBoundRejection ∨
        ¬ (request.usage.getD []).length > accountingLimits.maxUsageEvents ∧
          Schedules.usageFactsBad policy request totalUsage (request.usage.getD []) = true ∧
          x = Schedules.createUsageFactsRejection) := by
  unfold Schedules.usageSchedule at h
  rcases hsum : Schedules.liftNum (accountingSum ((request.usage.getD []).map (·.value))) with
    e | totalUsage
  · simp [hsum] at h
  simp only [hsum] at h
  refine ⟨totalUsage, hsum, ?_⟩
  by_cases hbound : (request.usage.getD []).length > accountingLimits.maxUsageEvents
  · simp only [hbound, ↓reduceIte, Except.ok.injEq, Sum.inl.injEq] at h
    subst h
    exact Or.inl ⟨hbound, rfl⟩
  simp only [hbound, ↓reduceIte] at h
  by_cases hbad : Schedules.usageFactsBad policy request totalUsage (request.usage.getD []) = true
  · simp only [hbad, ↓reduceIte, Except.ok.injEq, Sum.inl.injEq] at h
    subst h
    exact Or.inr ⟨hbound, hbad, rfl⟩
  simp only [hbad, Bool.false_eq_true, ↓reduceIte] at h
  rcases hua : Schedules.usageAmounts allocable totalUsage (request.usage.getD []) with e | amounts'
  · simp [hua] at h
  · simp [hua] at h

/-- More than 1,200 usage facts are refused. -/
theorem usageSchedule_bound_rejected {policy : AllocationPolicy}
    {request : AllocationScheduleRequest} {allocable totalUsage : ExactRational}
    (hsum : Schedules.liftNum (accountingSum ((request.usage.getD []).map (·.value))) =
      .ok totalUsage)
    (hbound : (request.usage.getD []).length > accountingLimits.maxUsageEvents) :
    Schedules.usageSchedule policy request allocable =
      .ok (.inl Schedules.createUsageBoundRejection) := by
  unfold Schedules.usageSchedule
  simp [hsum, hbound]

/-- Usage facts that fail the test of `usageFactsBad` are refused. -/
theorem usageSchedule_facts_rejected {policy : AllocationPolicy}
    {request : AllocationScheduleRequest} {allocable totalUsage : ExactRational}
    (hsum : Schedules.liftNum (accountingSum ((request.usage.getD []).map (·.value))) =
      .ok totalUsage)
    (hbound : ¬ (request.usage.getD []).length > accountingLimits.maxUsageEvents)
    (hbad : Schedules.usageFactsBad policy request totalUsage (request.usage.getD []) = true) :
    Schedules.usageSchedule policy request allocable =
      .ok (.inl Schedules.createUsageFactsRejection) := by
  unfold Schedules.usageSchedule
  simp [hsum, hbound, hbad]

/-- A schedule that is refused is refused with a rejection, one of five. -/
theorem generate_inl {policy : AllocationPolicy} {request : AllocationScheduleRequest}
    {allocable : ExactRational} {x : AccountingCalculation}
    (h : Schedules.generate policy request allocable = .ok (.inl x)) :
    x = Schedules.createPolicyRejection ∨ x = Schedules.createSpanRejection ∨
      x = Schedules.createDecliningRateRejection ∨ x = Schedules.createUsageBoundRejection ∨
      x = Schedules.createUsageFactsRejection := by
  unfold Schedules.generate at h
  by_cases hm : (policy.method == .straightLine || policy.method == .decliningBalance) = true
  · simp only [hm, ↓reduceIte] at h
    rcases periodicSchedule_inl h with ⟨rfl, -⟩ | ⟨rfl, -⟩ | ⟨rfl, -⟩
    · exact Or.inl rfl
    · exact Or.inr (Or.inl rfl)
    · exact Or.inr (Or.inr (Or.inl rfl))
  · simp only [hm, Bool.false_eq_true, ↓reduceIte] at h
    obtain ⟨-, -, ⟨-, rfl⟩ | ⟨-, -, rfl⟩⟩ := usageSchedule_inl h
    · exact Or.inr (Or.inr (Or.inr (Or.inl rfl)))
    · exact Or.inr (Or.inr (Or.inr (Or.inr rfl)))

/-- What the exact amounts and dates of a schedule satisfy, for whichever method made them: as many
amounts as dates, between one and 1,200, every amount constructible; and, by the method, either the
dates are first of month dates in strictly increasing order (straight line and declining balance),
or they are the usage dates in the order given, distinct and within the schedule's span
(units of production). -/
theorem generate_spec {policy : AllocationPolicy} {request : AllocationScheduleRequest}
    {allocable : ExactRational} {amounts : List ExactRational} {dates : List LocalDate}
    (hs : request.startsOn.WF) (he : request.endsOn.WF) (hle : request.startsOn ≤ request.endsOn)
    (hal : allocable.WF) (hres : request.residualValue.WF) (hsb : request.sourceBasis.WF)
    (hrate : ∀ r, policy.decliningRate = some r → r.WF)
    (hvals : ∀ u ∈ request.usage.getD [], u.value.WF)
    (h : Schedules.generate policy request allocable = .ok (.inr (amounts, dates))) :
    amounts.length = dates.length ∧ 1 ≤ dates.length ∧
      dates.length ≤ accountingLimits.maxScheduleInstallments ∧ (∀ a ∈ amounts, a.WF) ∧
      (policy.method ≠ .unitsOfProduction →
        (∀ d ∈ dates, d.WF ∧ d.toCalendarDate.day = 1) ∧ dates.Pairwise (· < ·)) ∧
      (policy.method = .unitsOfProduction →
        dates = (request.usage.getD []).map (·.date) ∧ dates.Nodup ∧
          ∀ d ∈ dates, request.startsOn ≤ d ∧ d ≤ request.endsOn) := by
  unfold Schedules.generate at h
  by_cases hm : (policy.method == .straightLine || policy.method == .decliningBalance) = true
  · simp only [hm, ↓reduceIte] at h
    obtain ⟨hl, h1, h2, hw, hd, hp, -, -⟩ := periodicSchedule_spec hs he hle hal hres hsb hrate h
    have hne : policy.method ≠ .unitsOfProduction := by
      intro hu; rw [hu] at hm; simp at hm
    exact ⟨hl, h1, h2, hw, fun _ => ⟨hd, hp⟩, fun hu => absurd hu hne⟩
  · simp only [hm, Bool.false_eq_true, ↓reduceIte] at h
    obtain ⟨hl, hd, h1, h2, hw, hn, hr, -, -⟩ := usageSchedule_spec hal hvals h
    have hu : policy.method = .unitsOfProduction := by
      cases hmethod : policy.method <;> simp_all
    exact ⟨hl, h1, h2, hw, fun hne => absurd hu hne, fun _ => ⟨hd, hn, hr⟩⟩

/-- The instalments `buildInstallments` makes from as many amounts as dates are those amounts, on
those dates, numbered from the first ordinal. -/
theorem buildInstallments_spec :
    ∀ (k : Nat) (amounts : List ExactRational) (dates : List LocalDate),
      amounts.length = dates.length →
        (Schedules.buildInstallments k amounts dates).map (·.amount) = amounts ∧
          (Schedules.buildInstallments k amounts dates).map (·.accountingDate) = dates ∧
          (Schedules.buildInstallments k amounts dates).map (·.ordinal) =
            (List.range amounts.length).map (fun i => ((k + i : Nat) : Int))
  | _, [], [], _ => by simp [Schedules.buildInstallments]
  | _, [], _ :: _, h => by simp at h
  | _, _ :: _, [], h => by simp at h
  | k, a :: amounts, d :: dates, h => by
    have hl : amounts.length = dates.length := by simpa using h
    obtain ⟨h1, h2, h3⟩ := buildInstallments_spec (k + 1) amounts dates hl
    simp only [Schedules.buildInstallments, List.map_cons, h1, h2, List.length_cons, h3,
      List.range_succ_eq_map, List.map_map, true_and]
    refine congrArg₂ List.cons rfl (List.map_congr_left fun i _ => ?_)
    simp only [Function.comp, Nat.succ_eq_add_one]
    congr 1
    omega

end Rastrata.Kernel

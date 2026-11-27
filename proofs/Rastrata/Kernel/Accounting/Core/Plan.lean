/-
Laws of `planAllocationPostings` (`accounting.ts` line 527; law 4 of the brief of
`Accounting/Core.lean`): the cumulative posted allocation plan.

Write `A` for the exact allocable basis (`exactSourceBasis − exactResidualValue`), `P` for the
posted allocable basis (`postedSourceBasis − quantize(exactResidualValue)`), and `u` for one unit
of the policy's scale. When the plan is `planned`:

- the posted amounts of the instalments add up to exactly `P` (`planAllocationPostings_posted_sum`);
- the exact amounts add up to exactly `A` (`planAllocationPostings_exact_sum`);
- each posted amount is at least zero, and within one unit `u` of the instalment's exact share of
  `P`, `P × amount / A` (`planAllocationPostings_installment`); each cumulative rounding is less
  than one unit from its cumulative target;
- the instalments keep the schedule's ordinals, dates and amounts, in its order.

Rejections and errors are characterised at the end of the file.
-/
import Rastrata.Kernel.Accounting.Core.Hashes

namespace Rastrata.Kernel

set_option linter.unusedSimpArgs false

private theorem liftExact_ok' {α : Type} {result : Except NumErr α} {value : α}
    (h : liftExact result = .ok value) : result = .ok value := by
  cases result with
  | error code => cases h
  | ok v => cases h; rfl

/-! ## The meaning of a cumulative target -/

/-- The target of line 557 as a number: the posted allocable basis `posted` times the cumulative
exact amount `cumulative` over the exact allocable basis `exact`, or zero when `exact` is zero. -/
def allocationTarget (exact posted cumulative : ℚ) : ℚ :=
  if exact = 0 then 0 else posted * cumulative / exact

/-- A target is additive in the cumulative amount: the target of an instalment's amount is the
step between two cumulative targets. -/
theorem allocationTarget_add (exact posted c a : ℚ) :
    allocationTarget exact posted (c + a) =
      allocationTarget exact posted c + allocationTarget exact posted a := by
  unfold allocationTarget
  split
  · simp
  · ring

/-- A target is not negative for bases and amounts that are not negative. -/
theorem allocationTarget_nonneg {exact posted c : ℚ} (he : 0 ≤ exact) (hp : 0 ≤ posted)
    (hc : 0 ≤ c) : 0 ≤ allocationTarget exact posted c := by
  unfold allocationTarget
  split
  · exact le_rfl
  · exact div_nonneg (mul_nonneg hp hc) he

/-- What `cumulativeTargetOf` returns, as a number. -/
theorem cumulativeTargetOf_ok {exact posted cumulative target : ExactRational}
    (he : exact.WF) (hp : posted.WF) (hc : cumulative.WF)
    (h : cumulativeTargetOf exact posted cumulative = .ok target) :
    target.WF ∧ target.toRat = allocationTarget exact.toRat posted.toRat cumulative.toRat := by
  unfold cumulativeTargetOf at h
  by_cases hz : exact.isZero = true
  · simp only [hz, ↓reduceIte, Except.ok.injEq] at h
    subst h
    refine ⟨ExactRational.zero_wf, ?_⟩
    simp [allocationTarget, (ExactRational.isZero_iff he).mp hz, ExactRational.zero_toRat]
  · simp only [hz, Bool.false_eq_true, ↓reduceIte] at h
    have he0 : exact.toRat ≠ 0 := fun h0 => hz ((ExactRational.isZero_iff he).mpr h0)
    rcases hm : posted.multiply cumulative with e | product
    · rw [hm] at h
      cases h
    · rw [hm] at h
      obtain ⟨hpw, hpr⟩ := ExactRational.multiply_ok hp hc hm
      obtain ⟨htw, -, htr⟩ := ExactRational.divide_ok hpw he h
      exact ⟨htw, by rw [htr, hpr]; simp [allocationTarget, he0]⟩

/-- Zero rounds to zero in every mode. -/
theorem rounds_zero (mode : RoundingMode) : Rounds mode 0 0 := by
  cases mode <;> norm_num [Rounds]

/-- The coefficient of the last cumulative rounding of a list of instalments, `start` for none. -/
def lastCoefficient (start : Int) : List AllocationPostingInstallment → Int
  | [] => start
  | installment :: rest => lastCoefficient installment.cumulativeQuantization.amount.coefficient rest

/-- What one instalment of the plan satisfies: its numbers are constructible, its posted amount
is at the policy's scale, at least zero, and within one unit of its exact share of the posted
allocable basis; its cumulative rounding is less than one unit from its cumulative target; and its
difference is its exact amount less its posted amount. -/
structure InstallmentFacts (policy : QuantizationPolicy) (exact posted : ExactRational)
    (installment : AllocationPostingInstallment) : Prop where
  wf : installment.WF
  scale : installment.postedAmount.scale = policy.targetScale
  nonneg : 0 ≤ installment.postedAmount.toRat
  share : |installment.postedAmount.toRat -
    allocationTarget exact.toRat posted.toRat installment.exactAmount.toRat| ≤ policy.rule.unit
  cumulative : |installment.cumulativeQuantization.amount.toRat -
    installment.cumulativeTarget.toRat| < policy.rule.unit
  difference : installment.exactToPostedDifference.toRat =
    installment.exactAmount.toRat - installment.postedAmount.toRat

/-- The loop of `planAllocationPostings`, from a cumulative exact amount `start` whose target
rounds to `startCoefficient`: the instalments keep the schedule's ordinals, dates and amounts;
each satisfies `InstallmentFacts`; their posted amounts add up to the last cumulative rounding less
the first, in units; and the last cumulative rounding is the rounding of the target of `start` plus
every amount. -/
theorem planInstallments_spec {policy : QuantizationPolicy} {exact posted : ExactRational}
    (he : exact.WF) (hp : posted.WF) (he0 : 0 ≤ exact.toRat) (hp0 : 0 ≤ posted.toRat) :
    ∀ (items : List ScheduledAllocation) (start : ExactRational) (startCoefficient : Int)
      (installments : List AllocationPostingInstallment),
      start.WF → 0 ≤ start.toRat → (∀ item ∈ items, item.amount.WF ∧ 0 ≤ item.amount.toRat) →
      Rounds policy.roundingMode (allocationTarget exact.toRat posted.toRat start.toRat *
        10 ^ policy.targetScale.toNat) startCoefficient →
      planInstallments policy exact posted start startCoefficient items = .ok installments →
      installments.map (fun i => (i.ordinal, i.accountingDate, i.exactAmount)) =
          items.map (fun i => (i.ordinal, i.accountingDate, i.amount)) ∧
        (∀ installment ∈ installments, InstallmentFacts policy exact posted installment) ∧
        (installments.map (·.postedAmount.toRat)).sum =
          ((lastCoefficient startCoefficient installments : ℚ) - startCoefficient) *
            policy.rule.unit ∧
        Rounds policy.roundingMode (allocationTarget exact.toRat posted.toRat
            (start.toRat + (items.map (·.amount.toRat)).sum) * 10 ^ policy.targetScale.toNat)
          (lastCoefficient startCoefficient installments)
  | [], start, startCoefficient, installments, _, _, _, hround, h => by
    simp only [planInstallments, Except.ok.injEq] at h
    subst h
    simpa [lastCoefficient] using hround
  | item :: rest, start, startCoefficient, installments, hs, hs0, hitems, hround, h => by
    obtain ⟨hiw, hi0⟩ := hitems item (by simp)
    have hrest : ∀ i ∈ rest, i.amount.WF ∧ 0 ≤ i.amount.toRat :=
      fun i hi => hitems i (List.mem_cons_of_mem _ hi)
    rcases h1 : liftExact (start.add item.amount) with e | cumulative
    · simp [planInstallments, h1] at h
    rcases h2 : liftExact (cumulativeTargetOf exact posted cumulative) with e | target
    · simp [planInstallments, h1, h2] at h
    rcases h3 : quantize target policy.rule with e | q
    · simp [planInstallments, h1, h2, h3] at h
    rcases h4 : liftExact (ExactDecimal.of (q.amount.coefficient - startCoefficient)
      policy.targetScale) with e | postedAmount
    · simp [planInstallments, h1, h2, h3, h4] at h
    rcases h5 : liftExact postedAmount.toRational with e | postedRational
    · simp [planInstallments, h1, h2, h3, h4, h5] at h
    rcases h6 : liftExact (item.amount.subtract postedRational) with e | difference
    · simp [planInstallments, h1, h2, h3, h4, h5, h6] at h
    rcases h7 : planInstallments policy exact posted cumulative q.amount.coefficient rest with
      e | tail
    · simp [planInstallments, h1, h2, h3, h4, h5, h6, h7] at h
    simp only [planInstallments, h1, h2, h3, h4, h5, h6, h7, Except.ok.injEq] at h
    subst h
    obtain ⟨hcw, hcr⟩ := ExactRational.add_ok hs hiw (liftExact_ok' h1)
    obtain ⟨htw, htr⟩ := cumulativeTargetOf_ok he hp hcw (liftExact_ok' h2)
    obtain ⟨hqaw, hqrw, -, hqround, -⟩ := quantize_ok htw h3
    obtain ⟨hpw, hpc, hps⟩ := ExactDecimal.of_ok (liftExact_ok' h4)
    obtain ⟨hprw, hprr⟩ := ExactDecimal.toRational_ok hpw (liftExact_ok' h5)
    obtain ⟨hdw, hdr⟩ := ExactRational.subtract_ok hiw hprw (liftExact_ok' h6)
    have hc0 : 0 ≤ cumulative.toRat := by rw [hcr]; linarith
    have hround' : Rounds policy.roundingMode (allocationTarget exact.toRat posted.toRat
        cumulative.toRat * 10 ^ policy.targetScale.toNat) q.amount.coefficient := by
      rw [← htr]
      exact hqround
    obtain ⟨ih1, ih2, ih3, ih4⟩ := planInstallments_spec he hp he0 hp0 rest cumulative
      q.amount.coefficient tail hcw hc0 hrest hround' h7
    have hu : (10 : ℚ) ^ policy.targetScale.toNat * policy.rule.unit = 1 := by
      unfold QuantizationRule.unit QuantizationPolicy.rule
      field_simp
    have hposted : postedAmount.toRat =
        ((q.amount.coefficient : ℚ) - startCoefficient) * policy.rule.unit := by
      unfold ExactDecimal.toRat QuantizationRule.unit QuantizationPolicy.rule
      rw [hpc, hps]
      push_cast
      ring
    have hxs : 0 ≤ allocationTarget exact.toRat posted.toRat start.toRat *
        10 ^ policy.targetScale.toNat :=
      mul_nonneg (allocationTarget_nonneg he0 hp0 hs0) (by positivity)
    have hxc : 0 ≤ allocationTarget exact.toRat posted.toRat cumulative.toRat *
        10 ^ policy.targetScale.toNat :=
      mul_nonneg (allocationTarget_nonneg he0 hp0 hc0) (by positivity)
    have hstep : allocationTarget exact.toRat posted.toRat cumulative.toRat *
          10 ^ policy.targetScale.toNat -
        allocationTarget exact.toRat posted.toRat start.toRat * 10 ^ policy.targetScale.toNat =
        allocationTarget exact.toRat posted.toRat item.amount.toRat *
          10 ^ policy.targetScale.toNat := by
      rw [hcr, allocationTarget_add]
      ring
    have hle : allocationTarget exact.toRat posted.toRat start.toRat *
          10 ^ policy.targetScale.toNat ≤
        allocationTarget exact.toRat posted.toRat cumulative.toRat *
          10 ^ policy.targetScale.toNat := by
      have := mul_nonneg (allocationTarget_nonneg he0 hp0 hi0)
        (show (0 : ℚ) ≤ 10 ^ policy.targetScale.toNat by positivity)
      linarith
    have hmono := hround.mono hround' hle
    have hsub := hround.sub_sub_le_one hround' hxs hxc
    refine ⟨?_, ?_, ?_, ?_⟩
    · simp [ih1]
    · intro installment hinstallment
      rcases List.mem_cons.mp hinstallment with rfl | hinstallment
      · refine ⟨⟨hiw, htw, ⟨hqaw, hqrw⟩, hpw, hdw⟩, hps, ?_, ?_,
          quantize_within_one_unit htw h3, ?_⟩
        · simp only
          rw [hposted]
          have : (startCoefficient : ℚ) ≤ q.amount.coefficient := by exact_mod_cast hmono
          exact mul_nonneg (by linarith) (QuantizationRule.unit_pos _).le
        · simp only
          have key : postedAmount.toRat -
              allocationTarget exact.toRat posted.toRat item.amount.toRat =
              (((q.amount.coefficient : ℚ) - startCoefficient) -
                (allocationTarget exact.toRat posted.toRat cumulative.toRat *
                    10 ^ policy.targetScale.toNat -
                  allocationTarget exact.toRat posted.toRat start.toRat *
                    10 ^ policy.targetScale.toNat)) * policy.rule.unit := by
            rw [hposted, hstep]
            have h' : allocationTarget exact.toRat posted.toRat item.amount.toRat *
                10 ^ policy.targetScale.toNat * policy.rule.unit =
                allocationTarget exact.toRat posted.toRat item.amount.toRat := by
              rw [mul_assoc, hu, mul_one]
            calc ((q.amount.coefficient : ℚ) - startCoefficient) * policy.rule.unit -
                  allocationTarget exact.toRat posted.toRat item.amount.toRat =
                ((q.amount.coefficient : ℚ) - startCoefficient) * policy.rule.unit -
                  allocationTarget exact.toRat posted.toRat item.amount.toRat *
                    10 ^ policy.targetScale.toNat * policy.rule.unit := by rw [h']
              _ = _ := by ring
          rw [key, abs_mul, abs_of_pos (QuantizationRule.unit_pos _)]
          calc _ ≤ 1 * policy.rule.unit :=
                mul_le_mul_of_nonneg_right hsub (QuantizationRule.unit_pos _).le
            _ = _ := one_mul _
        · simp only
          rw [hdr, hprr]
      · exact ih2 installment hinstallment
    · simp only [List.map_cons, List.sum_cons, lastCoefficient, ih3, hposted]
      ring
    · simp only [lastCoefficient, List.map_cons, List.sum_cons]
      rw [hcr, add_assoc] at ih4
      exact ih4

/-! ## The steps of a plan -/

/-- What passing the checks of lines 543 to 547 means: every clause of the `||` was false, and the
two computations in it returned. -/
theorem planRejects_eq_false {input : AllocationPostingPlanInput} {policy : QuantizationPolicy}
    {postedBasis exactAllocable postedAllocable : ExactRational}
    (h : planRejects input policy postedBasis exactAllocable postedAllocable = .ok false) :
    input.installments.length ≠ 0 ∧
      input.installments.length ≤ accountingLimits.maxScheduleInstallments ∧
      input.exactSourceBasis.isNegative = false ∧ input.exactResidualValue.isNegative = false ∧
      exactAllocable.isNegative = false ∧ postedBasis.isNegative = false ∧
      postedAllocable.isNegative = false ∧
      (∃ normalized, quantize postedBasis policy.rule = .ok normalized ∧
        normalized.residual.isZero = true) ∧
      scheduleMisordered 0 none input.installments = false ∧
      (∃ total, accountingSum (input.installments.map (·.amount)) = .ok total ∧
        total.equals exactAllocable = true) ∧
      (exactAllocable.isZero && !postedAllocable.isZero) = false := by
  unfold planRejects at h
  split at h
  · cases h
  rename_i hc
  simp only [Bool.or_eq_true, beq_iff_eq, decide_eq_true_eq, not_or, Bool.not_eq_true,
    not_lt] at hc
  obtain ⟨⟨⟨⟨⟨⟨h1, h2⟩, h3⟩, h4⟩, h5⟩, h6⟩, h7⟩ := hc
  rcases hq : quantize postedBasis policy.rule with e | normalized
  · rw [hq] at h
    cases h
  rw [hq] at h
  simp only at h
  split at h
  · cases h
  rename_i hz
  split at h
  · cases h
  rename_i hm
  rcases hs : liftExact (accountingSum (input.installments.map (·.amount))) with e | total
  · rw [hs] at h
    cases h
  rw [hs] at h
  simp only at h
  split at h
  · cases h
  rename_i he
  simp only [Except.ok.injEq] at h
  refine ⟨by omega, h2, h3, h4, h5, h6, h7, ⟨normalized, rfl, by simpa using hz⟩,
    by simpa using hm, ⟨total, liftExact_ok' hs, by simpa using he⟩, h⟩

/-- A plan whose content hash is set to the hash of its body carries the hash of its own body. -/
theorem AllocationPostingPlan.contentHash_of_body (body : AllocationPostingPlan) :
    ({ body with contentHash := accountingBodyHash "AllocationPostingPlan" body } :
        AllocationPostingPlan).contentHash =
      accountingBodyHash "AllocationPostingPlan"
        { body with contentHash := accountingBodyHash "AllocationPostingPlan" body } := by
  exact congrArg (accountingHash "AllocationPostingPlan")
    (AllocationPostingPlan.bodyValue_contentHash body
      (accountingBodyHash "AllocationPostingPlan" body)).symm

/-- The steps of a plan that was made: every computation returned, the checks passed, and the
plan holds the inputs, the residual's rounding, the instalments of the loop, and the hash of its
own body. -/
theorem planAllocationPostings_planned_steps {input : AllocationPostingPlanInput}
    {plan : AllocationPostingPlan}
    (h : planAllocationPostings input = .ok (.planned plan)) :
    ∃ residualQuantization postedBasis exactAllocable residualAmount postedAllocable,
      quantize input.exactResidualValue input.quantizationPolicy.rule =
          .ok residualQuantization ∧
        input.postedSourceBasis.toRational = .ok postedBasis ∧
        input.exactSourceBasis.subtract input.exactResidualValue = .ok exactAllocable ∧
        residualQuantization.amount.toRational = .ok residualAmount ∧
        postedBasis.subtract residualAmount = .ok postedAllocable ∧
        planRejects input input.quantizationPolicy postedBasis exactAllocable postedAllocable =
          .ok false ∧
        planInstallments input.quantizationPolicy exactAllocable postedAllocable
          ExactRational.zero 0 input.installments = .ok plan.installments ∧
        plan.algorithmVersion = .cumulativePostedAllocationV1 ∧
        plan.exactSourceBasis = input.exactSourceBasis ∧
        plan.exactResidualValue = input.exactResidualValue ∧
        plan.postedSourceBasis = input.postedSourceBasis ∧
        plan.residualQuantization = residualQuantization ∧
        plan.quantizationPolicy = input.quantizationPolicy ∧
        plan.contentHash = accountingBodyHash "AllocationPostingPlan" plan := by
  unfold planAllocationPostings immutableAccountingValue at h
  rcases h1 : quantize input.exactResidualValue input.quantizationPolicy.rule with e | rq
  · simp [h1] at h
  rcases h2 : liftExact input.postedSourceBasis.toRational with e | pb
  · simp [h1, h2] at h
  rcases h3 : liftExact (input.exactSourceBasis.subtract input.exactResidualValue) with e | ea
  · simp [h1, h2, h3] at h
  rcases h4 : liftExact rq.amount.toRational with e | ra
  · simp [h1, h2, h3, h4] at h
  rcases h5 : liftExact (pb.subtract ra) with e | pa
  · simp [h1, h2, h3, h4, h5] at h
  rcases h6 : planRejects input input.quantizationPolicy pb ea pa with e | rejects
  · simp [h1, h2, h3, h4, h5, h6] at h
  cases rejects
  · rcases h7 : planInstallments input.quantizationPolicy ea pa ExactRational.zero 0
      input.installments with e | installments
    · simp [h1, h2, h3, h4, h5, h6, h7] at h
    simp only [h1, h2, h3, h4, h5, h6, h7, Except.ok.injEq,
      AllocationPostingPlanResult.planned.injEq] at h
    subst h
    exact ⟨rq, pb, ea, ra, pa, rfl, liftExact_ok' h2, liftExact_ok' h3, liftExact_ok' h4,
      liftExact_ok' h5, h6, h7, rfl, rfl, rfl, rfl, rfl, rfl,
      AllocationPostingPlan.contentHash_of_body
        { algorithmVersion := .cumulativePostedAllocationV1,
          exactSourceBasis := input.exactSourceBasis,
          exactResidualValue := input.exactResidualValue,
          postedSourceBasis := input.postedSourceBasis, residualQuantization := rq,
          quantizationPolicy := input.quantizationPolicy, installments := installments,
          contentHash := default }⟩
  · simp [h1, h2, h3, h4, h5, h6] at h

/-! ## What a plan that was made satisfies -/

/-- A constructible input: its numbers are constructible and its identifiers valid. -/
structure AllocationPostingPlanInput.WF (input : AllocationPostingPlanInput) : Prop where
  exactSourceBasis : input.exactSourceBasis.WF
  exactResidualValue : input.exactResidualValue.WF
  postedSourceBasis : input.postedSourceBasis.WF
  quantizationPolicy : input.quantizationPolicy.WF
  installments : ∀ item ∈ input.installments, item.WF

/-- A schedule that is not misordered has no negative amount. -/
theorem scheduleMisordered_false_nonneg :
    ∀ {index : Nat} {previous : Option LocalDate} {items : List ScheduledAllocation},
      scheduleMisordered index previous items = false →
      ∀ item ∈ items, item.amount.isNegative = false
  | _, _, [], _ => by simp
  | index, previous, item :: rest, h => by
    simp only [scheduleMisordered, Bool.or_eq_false_iff] at h
    intro i hi
    rcases List.mem_cons.mp hi with rfl | hi
    · exact h.1.1.2
    · exact scheduleMisordered_false_nonneg h.2 i hi

/-- An amount at the policy's scale is its coefficient in units. -/
private theorem toRat_eq_coefficient_mul_unit {amount : ExactDecimal} {policy : QuantizationPolicy}
    (h : amount.scale = policy.targetScale) :
    amount.toRat = amount.coefficient * policy.rule.unit := by
  unfold ExactDecimal.toRat QuantizationRule.unit QuantizationPolicy.rule
  rw [h]
  ring

/-- The numbers behind a plan that was made: the exact allocable basis `A` and the posted one `P`,
both at least zero; `P` a whole number of units; `A` the total of the exact amounts; `P` zero when
`A` is; and the loop that made the instalments. -/
theorem planAllocationPostings_planned_core {input : AllocationPostingPlanInput}
    {plan : AllocationPostingPlan} (hw : input.WF)
    (h : planAllocationPostings input = .ok (.planned plan)) :
    ∃ exactAllocable postedAllocable : ExactRational,
      exactAllocable.WF ∧ postedAllocable.WF ∧
      exactAllocable.toRat = input.exactSourceBasis.toRat - input.exactResidualValue.toRat ∧
      postedAllocable.toRat =
        input.postedSourceBasis.toRat - plan.residualQuantization.amount.toRat ∧
      0 ≤ exactAllocable.toRat ∧ 0 ≤ postedAllocable.toRat ∧
      (input.installments.map (·.amount.toRat)).sum = exactAllocable.toRat ∧
      (exactAllocable.toRat = 0 → postedAllocable.toRat = 0) ∧
      (∃ c : Int, postedAllocable.toRat = c * input.quantizationPolicy.rule.unit) ∧
      (∀ item ∈ input.installments, item.amount.WF ∧ 0 ≤ item.amount.toRat) ∧
      planInstallments input.quantizationPolicy exactAllocable postedAllocable
        ExactRational.zero 0 input.installments = .ok plan.installments := by
  obtain ⟨rq, pb, ea, ra, pa, h1, h2, h3, h4, h5, h6, h7, -, -, -, -, hrq, -, -⟩ :=
    planAllocationPostings_planned_steps h
  obtain ⟨-, -, -, -, -, -, -, ⟨normalized, hn, hnz⟩, hmis, ⟨total, htot, hteq⟩, hlast⟩ :=
    planRejects_eq_false h6
  obtain ⟨_, _, _, _, hea0, hpb0, hpa0, -⟩ := planRejects_eq_false h6
  obtain ⟨hrqa, -, hrqs, -, -⟩ := quantize_ok hw.exactResidualValue h1
  obtain ⟨hpbw, hpbr⟩ := ExactDecimal.toRational_ok hw.postedSourceBasis h2
  obtain ⟨heaw, hear⟩ := ExactRational.subtract_ok hw.exactSourceBasis hw.exactResidualValue h3
  obtain ⟨hraw, hrar⟩ := ExactDecimal.toRational_ok hrqa h4
  obtain ⟨hpaw, hpar⟩ := ExactRational.subtract_ok hpbw hraw h5
  obtain ⟨hna, hnrw, hns, -, hnres⟩ := quantize_ok hpbw hn
  have hitems : ∀ item ∈ input.installments, item.amount.WF ∧ 0 ≤ item.amount.toRat := by
    intro item hitem
    have hiw : item.amount.WF := (hw.installments item hitem).amount
    refine ⟨hiw, ?_⟩
    have := scheduleMisordered_false_nonneg hmis item hitem
    by_contra hneg
    have : item.amount.isNegative = true := (ExactRational.isNegative_iff hiw).mpr (by linarith)
    simp_all
  have hamounts : ∀ value ∈ input.installments.map (·.amount), value.WF := by
    intro value hvalue
    obtain ⟨item, hitem, rfl⟩ := List.mem_map.mp hvalue
    exact (hitems item hitem).1
  obtain ⟨htw, httr⟩ := addExactValues_ok ExactRational.zero_wf hamounts htot
  have htotal : (input.installments.map (·.amount.toRat)).sum = ea.toRat := by
    rw [← (ExactRational.equals_iff htw heaw).mp hteq, httr, ExactRational.zero_toRat, zero_add]
    simp [exactTotalRat, Function.comp_def]
  refine ⟨ea, pa, heaw, hpaw, hear, ?_, ?_, ?_, htotal, ?_, ?_, hitems, h7⟩
  · rw [hpar, hpbr, hrar, hrq]
  · by_contra hneg
    have : ea.isNegative = true := (ExactRational.isNegative_iff heaw).mpr (by linarith)
    simp_all
  · by_contra hneg
    have : pa.isNegative = true := (ExactRational.isNegative_iff hpaw).mpr (by linarith)
    simp_all
  · intro hz
    have hz' : ea.isZero = true := (ExactRational.isZero_iff heaw).mpr hz
    rw [hz'] at hlast
    simp only [Bool.true_and, Bool.not_eq_false'] at hlast
    exact (ExactRational.isZero_iff hpaw).mp (by simpa using hlast)
  · refine ⟨normalized.amount.coefficient - rq.amount.coefficient, ?_⟩
    have hres0 : normalized.residual.toRat = 0 := (ExactRational.isZero_iff hnrw).mp hnz
    have hpbn : pb.toRat = normalized.amount.toRat := by linarith
    rw [hpar, hrar, hpbn, toRat_eq_coefficient_mul_unit hns, toRat_eq_coefficient_mul_unit hrqs]
    push_cast
    ring

/-- The loop of a plan that was made, read through `planInstallments_spec`. -/
private theorem planned_loop {input : AllocationPostingPlanInput} {plan : AllocationPostingPlan}
    (hw : input.WF) (h : planAllocationPostings input = .ok (.planned plan)) :
    ∃ exactAllocable postedAllocable : ExactRational,
      exactAllocable.toRat = input.exactSourceBasis.toRat - input.exactResidualValue.toRat ∧
      postedAllocable.toRat =
        input.postedSourceBasis.toRat - plan.residualQuantization.amount.toRat ∧
      (input.installments.map (·.amount.toRat)).sum = exactAllocable.toRat ∧
      (exactAllocable.toRat = 0 → postedAllocable.toRat = 0) ∧
      (∃ c : Int, postedAllocable.toRat = c * input.quantizationPolicy.rule.unit) ∧
      plan.installments.map (fun i => (i.ordinal, i.accountingDate, i.exactAmount)) =
          input.installments.map (fun i => (i.ordinal, i.accountingDate, i.amount)) ∧
      (∀ installment ∈ plan.installments,
        InstallmentFacts input.quantizationPolicy exactAllocable postedAllocable installment) ∧
      (plan.installments.map (·.postedAmount.toRat)).sum =
        (lastCoefficient 0 plan.installments : ℚ) * input.quantizationPolicy.rule.unit ∧
      Rounds input.quantizationPolicy.roundingMode
        (allocationTarget exactAllocable.toRat postedAllocable.toRat exactAllocable.toRat *
          10 ^ input.quantizationPolicy.targetScale.toNat)
        (lastCoefficient 0 plan.installments) := by
  obtain ⟨ea, pa, heaw, hpaw, hear, hpar, hea0, hpa0, htotal, hzero, hunits, hitems, hloop⟩ :=
    planAllocationPostings_planned_core hw h
  have hstart : Rounds input.quantizationPolicy.roundingMode
      (allocationTarget ea.toRat pa.toRat ExactRational.zero.toRat *
        10 ^ input.quantizationPolicy.targetScale.toNat) 0 := by
    have : allocationTarget ea.toRat pa.toRat ExactRational.zero.toRat = 0 := by
      simp [allocationTarget, ExactRational.zero_toRat]
    rw [this, zero_mul]
    exact_mod_cast rounds_zero _
  obtain ⟨hmap, hfacts, hsum, hround⟩ := planInstallments_spec heaw hpaw hea0 hpa0
    input.installments ExactRational.zero 0 plan.installments ExactRational.zero_wf
    (by rw [ExactRational.zero_toRat]) hitems hstart hloop
  refine ⟨ea, pa, hear, hpar, htotal, hzero, hunits, hmap, hfacts, by simpa using hsum, ?_⟩
  rw [ExactRational.zero_toRat, zero_add, htotal] at hround
  exact hround

/-- **The posted amounts of the instalments add up to exactly the posted allocable basis**: the
posted source basis less the rounded residual value. -/
theorem planAllocationPostings_posted_sum {input : AllocationPostingPlanInput}
    {plan : AllocationPostingPlan} (hw : input.WF)
    (h : planAllocationPostings input = .ok (.planned plan)) :
    (plan.installments.map (·.postedAmount.toRat)).sum =
      input.postedSourceBasis.toRat - plan.residualQuantization.amount.toRat := by
  obtain ⟨ea, pa, -, hpar, -, hzero, ⟨c, hc⟩, -, -, hsum, hround⟩ := planned_loop hw h
  rw [hsum, ← hpar]
  by_cases hz : ea.toRat = 0
  · have hpz := hzero hz
    have : allocationTarget ea.toRat pa.toRat ea.toRat = 0 := by simp [allocationTarget, hz]
    rw [this, zero_mul] at hround
    have hk := (show Rounds input.quantizationPolicy.roundingMode ((0 : Int) : ℚ)
      (lastCoefficient 0 plan.installments) by exact_mod_cast hround).eq_of_int
    rw [hk, hpz]
    simp
  · have : allocationTarget ea.toRat pa.toRat ea.toRat = pa.toRat := by
      simp [allocationTarget, hz]
    rw [this, hc] at hround
    have hu : (c : ℚ) * input.quantizationPolicy.rule.unit *
        10 ^ input.quantizationPolicy.targetScale.toNat = (c : ℚ) := by
      unfold QuantizationRule.unit QuantizationPolicy.rule
      field_simp
    rw [hu] at hround
    rw [hround.eq_of_int, hc]

/-- The exact amounts of the instalments add up to exactly the exact allocable basis: the exact
source basis less the exact residual value. -/
theorem planAllocationPostings_exact_sum {input : AllocationPostingPlanInput}
    {plan : AllocationPostingPlan} (hw : input.WF)
    (h : planAllocationPostings input = .ok (.planned plan)) :
    (plan.installments.map (·.exactAmount.toRat)).sum =
      input.exactSourceBasis.toRat - input.exactResidualValue.toRat := by
  obtain ⟨ea, pa, hear, -, htotal, -, -, hmap, -⟩ := planned_loop hw h
  have : plan.installments.map (·.exactAmount.toRat) =
      input.installments.map (·.amount.toRat) := by
    have := congrArg (List.map fun x : Int × LocalDate × ExactRational => x.2.2.toRat) hmap
    simpa [Function.comp_def] using this
  rw [this, htotal, hear]

/-- The instalments keep the schedule's ordinals, dates and exact amounts, in its order. -/
theorem planAllocationPostings_installments_schedule {input : AllocationPostingPlanInput}
    {plan : AllocationPostingPlan} (hw : input.WF)
    (h : planAllocationPostings input = .ok (.planned plan)) :
    plan.installments.map (fun i => (i.ordinal, i.accountingDate, i.exactAmount)) =
      input.installments.map (fun i => (i.ordinal, i.accountingDate, i.amount)) :=
  (planned_loop hw h).choose_spec.choose_spec.2.2.2.2.2.1

/-- Each instalment of a plan that was made: its numbers are constructible; its posted amount is at
the policy's scale, at least zero, and within one unit of its exact share of the posted allocable
basis (the posted allocable basis times its exact amount over the exact allocable basis); its
cumulative rounding is less than one unit from its cumulative target; and its difference is its
exact amount less its posted amount. -/
theorem planAllocationPostings_installment {input : AllocationPostingPlanInput}
    {plan : AllocationPostingPlan} (hw : input.WF)
    (h : planAllocationPostings input = .ok (.planned plan))
    {installment : AllocationPostingInstallment} (hinstallment : installment ∈ plan.installments) :
    installment.WF ∧ installment.postedAmount.scale = input.quantizationPolicy.targetScale ∧
      0 ≤ installment.postedAmount.toRat ∧
      |installment.postedAmount.toRat -
          allocationTarget (input.exactSourceBasis.toRat - input.exactResidualValue.toRat)
            (input.postedSourceBasis.toRat - plan.residualQuantization.amount.toRat)
            installment.exactAmount.toRat| ≤ input.quantizationPolicy.rule.unit ∧
      |installment.cumulativeQuantization.amount.toRat - installment.cumulativeTarget.toRat| <
        input.quantizationPolicy.rule.unit ∧
      installment.exactToPostedDifference.toRat =
        installment.exactAmount.toRat - installment.postedAmount.toRat := by
  obtain ⟨ea, pa, hear, hpar, -, -, -, -, hfacts, -⟩ := planned_loop hw h
  obtain ⟨hwf, hscale, hnonneg, hshare, hcum, hdiff⟩ := hfacts installment hinstallment
  rw [hear, hpar] at hshare
  exact ⟨hwf, hscale, hnonneg, hshare, hcum, hdiff⟩

/-- A plan that was made carries the hash of its own body. -/
theorem planAllocationPostings_contentHash {input : AllocationPostingPlanInput}
    {plan : AllocationPostingPlan} (h : planAllocationPostings input = .ok (.planned plan)) :
    plan.contentHash = accountingBodyHash "AllocationPostingPlan" plan :=
  (planAllocationPostings_planned_steps h).choose_spec.choose_spec.choose_spec.choose_spec.choose_spec.2.2.2.2.2.2.2.2.2.2.2.2.2

/-! ## The order of a schedule -/

/-- `scheduleMisordered` answers `false` exactly when the ordinals count up from `index + 1`, no
amount is negative, and the dates, after `previous` when there is one, strictly increase by UTF-16
code unit. -/
theorem scheduleMisordered_eq_false_iff : ∀ (index : Nat) (previous : Option LocalDate)
    (items : List ScheduledAllocation),
    scheduleMisordered index previous items = false ↔
      items.map (·.ordinal) = (List.range items.length).map (fun i => ((index + i + 1 : Nat) : Int)) ∧
        (∀ item ∈ items, item.amount.isNegative = false) ∧
        List.IsChain (fun a b => jsStringLt a.value b.value = true)
          (previous.toList ++ items.map (·.accountingDate))
  | index, previous, [] => by
    cases previous <;> simp [scheduleMisordered]
  | index, previous, item :: rest => by
    have ih := scheduleMisordered_eq_false_iff (index + 1) (some item.accountingDate) rest
    have hstep : scheduleMisordered index previous (item :: rest) = false ↔
        item.ordinal = ((index + 1 : Nat) : Int) ∧ item.amount.isNegative = false ∧
          (∀ date, previous = some date →
            jsStringLt date.value item.accountingDate.value = true) ∧
          scheduleMisordered (index + 1) (some item.accountingDate) rest = false := by
      cases previous with
      | none =>
        simp only [scheduleMisordered, Bool.or_eq_false_iff, bne_eq_false_iff_eq, and_true,
          reduceCtorEq, IsEmpty.forall_iff, implies_true, true_and, and_assoc]
      | some date =>
        simp only [scheduleMisordered, Bool.or_eq_false_iff, bne_eq_false_iff_eq,
          Option.some.injEq, forall_eq']
        rw [← Bool.not_eq_true (jsStringLe _ _), jsStringLe_iff_not_lt, not_not]
        simp only [and_assoc]
    have hrange : (List.range (rest.length + 1)).map
          (fun i => ((index + i + 1 : Nat) : Int)) =
        ((index + 1 : Nat) : Int) ::
          (List.range rest.length).map (fun i => ((index + 1 + i + 1 : Nat) : Int)) := by
      rw [List.range_succ_eq_map, List.map_cons, List.map_map]
      congr 1
      apply List.map_congr_left
      intro i _
      simp only [Function.comp_apply]
      congr 1
      omega
    have hchain : List.IsChain (fun a b : LocalDate => jsStringLt a.value b.value = true)
          (previous.toList ++ (item :: rest).map (·.accountingDate)) ↔
        (∀ date, previous = some date →
          jsStringLt date.value item.accountingDate.value = true) ∧
        List.IsChain (fun a b : LocalDate => jsStringLt a.value b.value = true)
          ((some item.accountingDate).toList ++ rest.map (·.accountingDate)) := by
      cases previous with
      | none => simp
      | some date => simp [List.isChain_cons_cons]
    rw [hstep, ih, List.length_cons, hrange, hchain]
    simp only [List.map_cons, List.cons.injEq, List.mem_cons, forall_eq_or_imp]
    constructor
    · rintro ⟨hord, hneg, hd, hords, hnegs, hc⟩
      exact ⟨⟨hord, hords⟩, ⟨hneg, hnegs⟩, hd, hc⟩
    · rintro ⟨⟨hord, hords⟩, ⟨hneg, hnegs⟩, hd, hc⟩
      exact ⟨hord, hneg, hd, hords, hnegs, hc⟩

/-! ## Rejections -/

/-- What `planAllocationPostings` asks of its input before it plans (lines 543 to 547), in
numbers, given the residual value rounded to the policy's scale: a schedule of one to 1,200
instalments; exact source basis, exact residual value and their difference not negative; a posted
source basis not negative, not less than the rounded residual, and a whole number of units; the
ordinals `1, 2, …`, no negative amount and dates strictly increasing (`scheduleMisordered`); the
exact amounts adding up to the exact allocable basis; and a posted remainder only when the exact
allocable basis is not zero. -/
structure PlanConditions (input : AllocationPostingPlanInput) (roundedResidual : ExactDecimal) :
    Prop where
  nonempty : input.installments.length ≠ 0
  bounded : input.installments.length ≤ accountingLimits.maxScheduleInstallments
  source : 0 ≤ input.exactSourceBasis.toRat
  residual : 0 ≤ input.exactResidualValue.toRat
  allocable : input.exactResidualValue.toRat ≤ input.exactSourceBasis.toRat
  posted : 0 ≤ input.postedSourceBasis.toRat
  postedAllocable : roundedResidual.toRat ≤ input.postedSourceBasis.toRat
  representable :
    ∃ c : Int, input.postedSourceBasis.toRat = c * input.quantizationPolicy.rule.unit
  ordered : scheduleMisordered 0 none input.installments = false
  conserving : (input.installments.map (·.amount.toRat)).sum =
    input.exactSourceBasis.toRat - input.exactResidualValue.toRat
  zeroSchedule : input.exactSourceBasis.toRat = input.exactResidualValue.toRat →
    input.postedSourceBasis.toRat = roundedResidual.toRat

/-- The steps of a call that returned: the first computations returned, and the checks answered;
`true` rejects with the one diagnostic, `false` plans. -/
theorem planAllocationPostings_ok_steps {input : AllocationPostingPlanInput}
    {result : AllocationPostingPlanResult} (h : planAllocationPostings input = .ok result) :
    ∃ rq pb ea ra pa rejects,
      quantize input.exactResidualValue input.quantizationPolicy.rule = .ok rq ∧
        input.postedSourceBasis.toRational = .ok pb ∧
        input.exactSourceBasis.subtract input.exactResidualValue = .ok ea ∧
        rq.amount.toRational = .ok ra ∧ pb.subtract ra = .ok pa ∧
        planRejects input input.quantizationPolicy pb ea pa = .ok rejects ∧
        (rejects = true → result = .rejected [allocationPlanDiagnostic]) ∧
        (rejects = false → ∃ plan, result = .planned plan) := by
  unfold planAllocationPostings immutableAccountingValue at h
  rcases h1 : quantize input.exactResidualValue input.quantizationPolicy.rule with e | rq
  · simp [h1] at h
  rcases h2 : liftExact input.postedSourceBasis.toRational with e | pb
  · simp [h1, h2] at h
  rcases h3 : liftExact (input.exactSourceBasis.subtract input.exactResidualValue) with e | ea
  · simp [h1, h2, h3] at h
  rcases h4 : liftExact rq.amount.toRational with e | ra
  · simp [h1, h2, h3, h4] at h
  rcases h5 : liftExact (pb.subtract ra) with e | pa
  · simp [h1, h2, h3, h4, h5] at h
  rcases h6 : planRejects input input.quantizationPolicy pb ea pa with e | rejects
  · simp [h1, h2, h3, h4, h5, h6] at h
  refine ⟨rq, pb, ea, ra, pa, rejects, rfl, liftExact_ok' h2, liftExact_ok' h3, liftExact_ok' h4,
    liftExact_ok' h5, h6, ?_, ?_⟩
  · rintro rfl
    simp only [h1, h2, h3, h4, h5, h6, Except.ok.injEq] at h
    exact h.symm
  · rintro rfl
    rcases h7 : planInstallments input.quantizationPolicy ea pa ExactRational.zero 0
      input.installments with e | installments
    · simp [h1, h2, h3, h4, h5, h6, h7] at h
    simp only [h1, h2, h3, h4, h5, h6, h7, Except.ok.injEq] at h
    exact ⟨_, h.symm⟩

/-- Under constructible inputs, the checks of lines 543 to 547 pass exactly when the conditions
hold. -/
theorem planRejects_false_iff {input : AllocationPostingPlanInput} (hw : input.WF)
    {rq : QuantizedValue} {pb ea ra pa : ExactRational} {rejects : Bool}
    (h1 : quantize input.exactResidualValue input.quantizationPolicy.rule = .ok rq)
    (h2 : input.postedSourceBasis.toRational = .ok pb)
    (h3 : input.exactSourceBasis.subtract input.exactResidualValue = .ok ea)
    (h4 : rq.amount.toRational = .ok ra) (h5 : pb.subtract ra = .ok pa)
    (h6 : planRejects input input.quantizationPolicy pb ea pa = .ok rejects) :
    rejects = false ↔ PlanConditions input rq.amount := by
  obtain ⟨hrqa, -, hrqs, -, -⟩ := quantize_ok hw.exactResidualValue h1
  obtain ⟨hpbw, hpbr⟩ := ExactDecimal.toRational_ok hw.postedSourceBasis h2
  obtain ⟨heaw, hear⟩ := ExactRational.subtract_ok hw.exactSourceBasis hw.exactResidualValue h3
  obtain ⟨hraw, hrar⟩ := ExactDecimal.toRational_ok hrqa h4
  obtain ⟨hpaw, hpar⟩ := ExactRational.subtract_ok hpbw hraw h5
  have neg : ∀ {x : ExactRational}, x.WF → (x.isNegative = false ↔ 0 ≤ x.toRat) := by
    intro x hx
    rw [← Bool.not_eq_true, ExactRational.isNegative_iff hx, not_lt]
  have hamounts : ∀ value ∈ input.installments.map (·.amount), value.WF := by
    intro value hvalue
    obtain ⟨item, hitem, rfl⟩ := List.mem_map.mp hvalue
    exact (hw.installments item hitem).amount
  have hsumrat : ∀ total, accountingSum (input.installments.map (·.amount)) = .ok total →
      total.WF ∧ total.toRat = (input.installments.map (·.amount.toRat)).sum := by
    intro total htot
    obtain ⟨htw, httr⟩ := addExactValues_ok ExactRational.zero_wf hamounts htot
    refine ⟨htw, ?_⟩
    rw [httr, ExactRational.zero_toRat, zero_add]
    simp [exactTotalRat, Function.comp_def]
  have hrepr : ∀ normalized, quantize pb input.quantizationPolicy.rule = .ok normalized →
      (normalized.residual.isZero = true ↔
        ∃ c : Int, input.postedSourceBasis.toRat = c * input.quantizationPolicy.rule.unit) := by
    intro normalized hn
    obtain ⟨-, hnrw, hns, -, hnres⟩ := quantize_ok hpbw hn
    constructor
    · intro hz
      have h0 := (ExactRational.isZero_iff hnrw).mp hz
      refine ⟨normalized.amount.coefficient, ?_⟩
      rw [← hpbr, ← toRat_eq_coefficient_mul_unit hns]
      linarith
    · rintro ⟨c, hc⟩
      have := quantize_representable hpbw hn (c := c) (by
        rw [hpbr, hc]
        unfold QuantizationRule.unit QuantizationPolicy.rule
        ring)
      rw [this.2.2.2]
      rfl
  have hzero : (ea.isZero && !pa.isZero) = false ↔
      (input.exactSourceBasis.toRat = input.exactResidualValue.toRat →
        input.postedSourceBasis.toRat = rq.amount.toRat) := by
    rw [← Bool.not_eq_true, Bool.and_eq_true, Bool.not_eq_true', ← Bool.not_eq_true,
      ExactRational.isZero_iff heaw, ExactRational.isZero_iff hpaw, hear, hpar, hpbr, hrar]
    constructor
    · intro hn he
      by_contra hp
      exact hn ⟨by linarith, fun h => hp (by linarith)⟩
    · rintro hi ⟨he, hp⟩
      exact hp (by rw [hi (by linarith)]; ring)
  constructor
  · intro hfalse
    subst hfalse
    obtain ⟨hn0, hbound, hsrc, hres, hea, hpb, hpa, ⟨normalized, hn, hnz⟩, hmis,
      ⟨total, htot, hteq⟩, hlast⟩ := planRejects_eq_false h6
    obtain ⟨htw, httr⟩ := hsumrat total htot
    refine ⟨hn0, hbound, (neg hw.exactSourceBasis).mp hsrc, (neg hw.exactResidualValue).mp hres,
      ?_, ?_, ?_, (hrepr normalized hn).mp hnz, hmis, ?_, hzero.mp hlast⟩
    · have := (neg heaw).mp hea
      rw [hear] at this
      linarith
    · rw [← hpbr]
      exact (neg hpbw).mp hpb
    · have := (neg hpaw).mp hpa
      rw [hpar, hpbr, hrar] at this
      linarith
    · rw [← httr, (ExactRational.equals_iff htw heaw).mp hteq, hear]
  · intro hc
    unfold planRejects at h6
    have hcond : (input.installments.length == 0 ||
        decide (input.installments.length > accountingLimits.maxScheduleInstallments) ||
        input.exactSourceBasis.isNegative || input.exactResidualValue.isNegative ||
        ea.isNegative || pb.isNegative || pa.isNegative) = false := by
      simp only [Bool.or_eq_false_iff, beq_eq_false_iff_ne, decide_eq_false_iff_not, not_lt]
      refine ⟨⟨⟨⟨⟨⟨hc.nonempty, hc.bounded⟩, (neg hw.exactSourceBasis).mpr hc.source⟩,
        (neg hw.exactResidualValue).mpr hc.residual⟩, (neg heaw).mpr ?_⟩, (neg hpbw).mpr ?_⟩,
        (neg hpaw).mpr ?_⟩
      · rw [hear]; linarith [hc.allocable]
      · rw [hpbr]; exact hc.posted
      · rw [hpar, hpbr, hrar]; linarith [hc.postedAllocable]
    rw [hcond] at h6
    simp only [Bool.false_eq_true, ↓reduceIte] at h6
    rcases hn : quantize pb input.quantizationPolicy.rule with e | normalized
    · rw [hn] at h6
      cases h6
    rw [hn] at h6
    simp only at h6
    rw [(hrepr normalized hn).mpr hc.representable, hc.ordered] at h6
    simp only [Bool.not_true, Bool.false_eq_true, ↓reduceIte] at h6
    rcases ht : liftExact (accountingSum (input.installments.map (·.amount))) with e | total
    · rw [ht] at h6
      cases h6
    rw [ht] at h6
    simp only at h6
    obtain ⟨htw, httr⟩ := hsumrat total (liftExact_ok' ht)
    have heq : total.equals ea = true := by
      rw [ExactRational.equals_iff htw heaw, httr, hc.conserving, hear]
    rw [heq, hzero.mpr hc.zeroSchedule] at h6
    simp only [Bool.not_true, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq] at h6
    exact h6.symm

/-- **Every rejection is for a stated reason**: a call that returned rejects exactly when the
input fails `PlanConditions`, and then with the one diagnostic of line 548. -/
theorem planAllocationPostings_rejected_iff {input : AllocationPostingPlanInput}
    {result : AllocationPostingPlanResult} (hw : input.WF)
    (h : planAllocationPostings input = .ok result) :
    ∃ rq, quantize input.exactResidualValue input.quantizationPolicy.rule = .ok rq ∧
      (result = .rejected [allocationPlanDiagnostic] ↔ ¬ PlanConditions input rq.amount) ∧
      (∀ diagnostics, result = .rejected diagnostics →
        diagnostics = [allocationPlanDiagnostic]) := by
  obtain ⟨rq, pb, ea, ra, pa, rejects, h1, h2, h3, h4, h5, h6, htrue, hfalse⟩ :=
    planAllocationPostings_ok_steps h
  have hiff := planRejects_false_iff hw h1 h2 h3 h4 h5 h6
  refine ⟨rq, h1, ⟨fun hr hc => ?_, fun hn => htrue ?_⟩, fun diagnostics hd => ?_⟩
  · obtain ⟨plan, hp⟩ := hfalse (hiff.mpr hc)
    rw [hp] at hr
    cases hr
  · cases rejects
    · exact absurd (hiff.mp rfl) hn
    · rfl
  · cases rejects
    · obtain ⟨plan, hp⟩ := hfalse rfl
      rw [hp] at hd
      cases hd
    · rw [htrue rfl] at hd
      cases hd
      rfl

/-- A plan is made exactly when the conditions hold, for a call that returned. -/
theorem planAllocationPostings_planned_iff {input : AllocationPostingPlanInput}
    {result : AllocationPostingPlanResult} (hw : input.WF)
    (h : planAllocationPostings input = .ok result) :
    ∃ rq, quantize input.exactResidualValue input.quantizationPolicy.rule = .ok rq ∧
      ((∃ plan, result = .planned plan) ↔ PlanConditions input rq.amount) := by
  obtain ⟨rq, pb, ea, ra, pa, rejects, h1, h2, h3, h4, h5, h6, htrue, hfalse⟩ :=
    planAllocationPostings_ok_steps h
  have hiff := planRejects_false_iff hw h1 h2 h3 h4 h5 h6
  refine ⟨rq, h1, fun ⟨plan, hp⟩ => hiff.mp ?_, fun hc => hfalse (hiff.mpr hc)⟩
  cases rejects
  · rfl
  · rw [htrue rfl] at hp
    cases hp

/-! ## Errors -/

/-- A step that returns or is refused for size, lifted, throws only for size. -/
private theorem liftExact_error_of_ok_or_limit {α : Type} {result : Except NumErr α}
    {e : QuantizeErr} (hr : (∃ c, result = .ok c) ∨ result = .error .representationLimitExceeded)
    (h : liftExact result = .error e) : e = .exactNumber .representationLimitExceeded := by
  rcases hr with ⟨c, hc⟩ | hl
  · rw [hc] at h
    cases h
  · rw [hl] at h
    cases h
    rfl

/-- At an admitted scale, `ExactDecimal.of` returns or is refused for size. -/
private theorem decimal_of_ok_or_limit (c : Int) {scale : Int} (h0 : 0 ≤ scale)
    (h1 : scale ≤ maxDecimalScale) :
    (∃ d, ExactDecimal.of c scale = .ok d) ∨
      ExactDecimal.of c scale = .error .representationLimitExceeded := by
  by_cases hw : withinMagnitude c = true
  · exact Or.inl ⟨⟨c, scale⟩, (ExactDecimal.of_eq_ok_iff c scale _).mpr ⟨h0, h1, hw, rfl⟩⟩
  · exact Or.inr ((ExactDecimal.of_eq_limit_iff c scale).mpr ⟨h0, h1, hw⟩)

/-- The target of line 557 returns or is refused for size. -/
private theorem cumulativeTargetOf_ok_or_limit {exact posted cumulative : ExactRational}
    (_he : exact.WF) (hp : posted.WF) (hc : cumulative.WF) :
    (∃ t, cumulativeTargetOf exact posted cumulative = .ok t) ∨
      cumulativeTargetOf exact posted cumulative = .error .representationLimitExceeded := by
  unfold cumulativeTargetOf
  by_cases hz : exact.isZero = true
  · simp [hz]
  · simp only [hz, Bool.false_eq_true, ↓reduceIte]
    rcases ExactRational.multiply_ok_or_limit hp hc with ⟨product, hm⟩ | hm
    · rw [hm]
      obtain ⟨hpw, -⟩ := ExactRational.multiply_ok hp hc hm
      rcases ExactRational.divide_ok_or_error (b := exact) hpw with ⟨t, ht⟩ | ⟨hn, -⟩ | ⟨-, hl⟩
      · exact Or.inl ⟨t, ht⟩
      · exact absurd (by simp [ExactRational.isZero, hn]) hz
      · exact Or.inr hl
    · rw [hm]
      exact Or.inr rfl

/-- The loop of `planAllocationPostings` throws only for size, at an admitted scale. -/
theorem planInstallments_error {policy : QuantizationPolicy} {exact posted : ExactRational}
    (he : exact.WF) (hp : posted.WF) (h0 : 0 ≤ policy.targetScale)
    (h1 : policy.targetScale ≤ maxDecimalScale) :
    ∀ (items : List ScheduledAllocation) (start : ExactRational) (startCoefficient : Int)
      {e : QuantizeErr}, start.WF → (∀ item ∈ items, item.amount.WF) →
      planInstallments policy exact posted start startCoefficient items = .error e →
      e = .exactNumber .representationLimitExceeded
  | [], _, _, _, _, _, h => by cases h
  | item :: rest, start, startCoefficient, e, hs, hitems, h => by
    have hiw := hitems item (by simp)
    rcases h1' : liftExact (start.add item.amount) with e' | cumulative
    · simp only [planInstallments, h1'] at h
      cases h
      exact liftExact_error_of_ok_or_limit (ExactRational.add_ok_or_limit hs hiw) h1'
    obtain ⟨hcw, -⟩ := ExactRational.add_ok hs hiw (liftExact_ok' h1')
    rcases h2 : liftExact (cumulativeTargetOf exact posted cumulative) with e' | target
    · simp only [planInstallments, h1', h2] at h
      cases h
      exact liftExact_error_of_ok_or_limit (cumulativeTargetOf_ok_or_limit he hp hcw) h2
    obtain ⟨htw, -⟩ := cumulativeTargetOf_ok he hp hcw (liftExact_ok' h2)
    rcases h3 : quantize target policy.rule with e' | q
    · simp only [planInstallments, h1', h2, h3] at h
      cases h
      exact quantize_error htw h0 h1 h3
    rcases h4 : liftExact (ExactDecimal.of (q.amount.coefficient - startCoefficient)
      policy.targetScale) with e' | postedAmount
    · simp only [planInstallments, h1', h2, h3, h4] at h
      cases h
      exact liftExact_error_of_ok_or_limit (decimal_of_ok_or_limit _ h0 h1) h4
    obtain ⟨hpw, -, -⟩ := ExactDecimal.of_ok (liftExact_ok' h4)
    rcases h5 : liftExact postedAmount.toRational with e' | postedRational
    · obtain ⟨code, hcode, -⟩ : ∃ code, postedAmount.toRational = .error code ∧ True := by
        cases hr : postedAmount.toRational with
        | error code => exact ⟨code, rfl, trivial⟩
        | ok v => rw [hr] at h5; cases h5
      exact absurd hcode (ExactDecimal.toRational_ne_error hpw code)
    obtain ⟨hprw, -⟩ := ExactDecimal.toRational_ok hpw (liftExact_ok' h5)
    rcases h6 : liftExact (item.amount.subtract postedRational) with e' | difference
    · simp only [planInstallments, h1', h2, h3, h4, h5, h6] at h
      cases h
      exact liftExact_error_of_ok_or_limit (ExactRational.subtract_ok_or_limit hiw hprw) h6
    rcases h7 : planInstallments policy exact posted cumulative q.amount.coefficient rest with
      e' | tail
    · simp only [planInstallments, h1', h2, h3, h4, h5, h6, h7] at h
      cases h
      exact planInstallments_error he hp h0 h1 rest cumulative q.amount.coefficient hcw
        (fun i hi => hitems i (List.mem_cons_of_mem _ hi)) h7
    · simp [planInstallments, h1', h2, h3, h4, h5, h6, h7] at h

/-- The checks of lines 543 to 547 throw only for size, at an admitted scale. -/
theorem planRejects_error {input : AllocationPostingPlanInput} (hw : input.WF)
    {pb ea pa : ExactRational} (hpb : pb.WF) (h0 : 0 ≤ input.quantizationPolicy.targetScale)
    (h1 : input.quantizationPolicy.targetScale ≤ maxDecimalScale) {e : QuantizeErr}
    (h : planRejects input input.quantizationPolicy pb ea pa = .error e) :
    e = .exactNumber .representationLimitExceeded := by
  unfold planRejects at h
  split at h
  · cases h
  rcases hq : quantize pb input.quantizationPolicy.rule with e' | normalized
  · rw [hq] at h
    cases h
    exact quantize_error hpb h0 h1 hq
  rw [hq] at h
  simp only at h
  split at h
  · cases h
  split at h
  · cases h
  rcases hs : liftExact (accountingSum (input.installments.map (·.amount))) with e' | total
  · obtain ⟨code, hcode, hcode'⟩ : ∃ code, accountingSum (input.installments.map (·.amount)) =
        .error code ∧ e' = .exactNumber code := by
      cases hr : accountingSum (input.installments.map (·.amount)) with
      | error code => rw [hr] at hs; cases hs; exact ⟨code, rfl, rfl⟩
      | ok v => rw [hr] at hs; cases hs
    rw [hs] at h
    cases h
    rw [hcode', addExactValues_error ExactRational.zero_wf (fun value hvalue => by
      obtain ⟨item, hitem, rfl⟩ := List.mem_map.mp hvalue
      exact (hw.installments item hitem).amount) hcode]
  · rw [hs] at h
    simp only at h
    split at h <;> cases h

/-- `planAllocationPostings` throws exactly two things on constructible input: the `RangeError` of
`quantize`, for a policy scale outside 0 to 1,000, which it throws before any check; and
`representation_limit_exceeded`, for a computation beyond the size limit. -/
theorem planAllocationPostings_error {input : AllocationPostingPlanInput} (hw : input.WF)
    {e : QuantizeErr} (h : planAllocationPostings input = .error e) :
    (e = .scaleOutOfRange ∧ (input.quantizationPolicy.targetScale < 0 ∨
        input.quantizationPolicy.targetScale > maxDecimalScale)) ∨
      e = .exactNumber .representationLimitExceeded := by
  by_cases hscale : input.quantizationPolicy.targetScale < 0 ∨
      input.quantizationPolicy.targetScale > maxDecimalScale
  · left
    have hq : quantize input.exactResidualValue input.quantizationPolicy.rule =
        .error .scaleOutOfRange := by
      simp [quantize, QuantizationPolicy.rule, hscale]
    simp only [planAllocationPostings, immutableAccountingValue, hq] at h
    cases h
    exact ⟨rfl, hscale⟩
  right
  have h0 : 0 ≤ input.quantizationPolicy.targetScale := by omega
  have h1 : input.quantizationPolicy.targetScale ≤ maxDecimalScale := by omega
  simp only [planAllocationPostings, immutableAccountingValue] at h
  rcases hq : quantize input.exactResidualValue input.quantizationPolicy.rule with e' | rq
  · rw [hq] at h
    cases h
    exact quantize_error hw.exactResidualValue h0 h1 hq
  obtain ⟨hrqa, -, -, -, -⟩ := quantize_ok hw.exactResidualValue hq
  obtain ⟨pb, hpb, hpbw, -⟩ := ExactDecimal.toRational_isOk hw.postedSourceBasis
  obtain ⟨ra, hra, hraw, -⟩ := ExactDecimal.toRational_isOk hrqa
  simp only [hq, hpb, liftExact, hra] at h
  rcases h3 : input.exactSourceBasis.subtract input.exactResidualValue with e' | ea
  · rw [h3] at h
    cases h
    exact liftExact_error_of_ok_or_limit
      (ExactRational.subtract_ok_or_limit hw.exactSourceBasis hw.exactResidualValue) (by
        simp [liftExact, h3])
  rw [h3] at h
  obtain ⟨heaw, -⟩ := ExactRational.subtract_ok hw.exactSourceBasis hw.exactResidualValue h3
  rcases h5 : pb.subtract ra with e' | pa
  · rw [h5] at h
    cases h
    exact liftExact_error_of_ok_or_limit (ExactRational.subtract_ok_or_limit hpbw hraw)
      (by simp [liftExact, h5])
  rw [h5] at h
  obtain ⟨hpaw, -⟩ := ExactRational.subtract_ok hpbw hraw h5
  simp only at h
  rcases h6 : planRejects input input.quantizationPolicy pb ea pa with e' | rejects
  · rw [h6] at h
    cases h
    exact planRejects_error hw hpbw h0 h1 h6
  rw [h6] at h
  cases rejects
  · simp only at h
    rcases h7 : planInstallments input.quantizationPolicy ea pa ExactRational.zero 0
      input.installments with e' | installments
    · rw [h7] at h
      cases h
      exact planInstallments_error heaw hpaw h0 h1 input.installments ExactRational.zero 0
        ExactRational.zero_wf (fun item hitem => (hw.installments item hitem).amount) h7
    · rw [h7] at h
      cases h
  · cases h

/-- A policy scale outside 0 to 1,000 makes `planAllocationPostings` throw the `RangeError` of
`quantize`, whatever the schedule: it is not one of the stated rejections. -/
theorem planAllocationPostings_scale_error {input : AllocationPostingPlanInput}
    (hscale : input.quantizationPolicy.targetScale < 0 ∨
      input.quantizationPolicy.targetScale > maxDecimalScale) :
    planAllocationPostings input = .error .scaleOutOfRange := by
  have hq : quantize input.exactResidualValue input.quantizationPolicy.rule =
      .error .scaleOutOfRange := by
    simp [quantize, QuantizationPolicy.rule, hscale]
  simp only [planAllocationPostings, immutableAccountingValue, hq]

/-! ## `allocationPlanIsValid` (line 1562) -/

/-- A legacy schedule (its policy names no posting algorithm) passes exactly when it carries no
posting plan, and nothing is computed. -/
theorem allocationPlanIsValid_legacy {schedule : AllocationSchedule}
    (h : schedule.policy.postingAlgorithm = none) :
    allocationPlanIsValid schedule = .ok schedule.postingPlan.isNone := by
  simp [allocationPlanIsValid, h]

/-- A schedule whose policy names a posting algorithm passes exactly when the policy uses the
cumulative algorithm, its two accounts differ, the source basis is a whole number of units, the
schedule carries a plan, `planAllocationPostings` plans for the schedule, and the two plans hash
the same under `AllocationPostingPlanValue`. -/
theorem allocationPlanIsValid_true_iff {schedule : AllocationSchedule}
    (h : schedule.policy.postingAlgorithm ≠ none) :
    allocationPlanIsValid schedule = .ok true ↔
      usesCumulativeAllocation schedule.policy = true ∧
        schedule.policy.allocationAccountId ≠ schedule.policy.contraAccountId ∧
        ∃ source carried expected,
          quantize schedule.sourceBasis schedule.policy.quantizationPolicy.rule = .ok source ∧
          source.residual.isZero = true ∧ schedule.postingPlan = some carried ∧
          planAllocationPostings
              { exactSourceBasis := schedule.sourceBasis,
                exactResidualValue := schedule.residualValue, postedSourceBasis := source.amount,
                quantizationPolicy := schedule.policy.quantizationPolicy,
                installments := schedule.installments } = .ok (.planned expected) ∧
          accountingHash "AllocationPostingPlanValue" carried =
            accountingHash "AllocationPostingPlanValue" expected := by
  have hcond : ∀ (b : Bool), (!usesCumulativeAllocation schedule.policy ||
      schedule.policy.allocationAccountId == schedule.policy.contraAccountId) = b →
      (b = false ↔ usesCumulativeAllocation schedule.policy = true ∧
        schedule.policy.allocationAccountId ≠ schedule.policy.contraAccountId) := by
    intro b hb
    subst hb
    simp [Bool.or_eq_false_iff]
  constructor
  · intro hvalid
    unfold allocationPlanIsValid at hvalid
    simp only [h, ↓reduceIte] at hvalid
    rcases hb : (!usesCumulativeAllocation schedule.policy ||
      schedule.policy.allocationAccountId == schedule.policy.contraAccountId) with _ | _
    · rw [hb] at hvalid
      simp only [Bool.false_eq_true, ↓reduceIte] at hvalid
      obtain ⟨huses, hne⟩ := (hcond false hb).mp rfl
      refine ⟨huses, hne, ?_⟩
      rcases hq : quantize schedule.sourceBasis schedule.policy.quantizationPolicy.rule with
        e | source
      · rw [hq] at hvalid
        cases hvalid
      rw [hq] at hvalid
      simp only at hvalid
      rcases hz : source.residual.isZero with _ | _
      · rw [hz] at hvalid
        simp at hvalid
      rw [hz] at hvalid
      simp only [Bool.not_true, Bool.false_eq_true, ↓reduceIte] at hvalid
      rcases hp : schedule.postingPlan with _ | carried
      · rw [hp] at hvalid
        cases hvalid
      rw [hp] at hvalid
      simp only at hvalid
      rcases hpl : planAllocationPostings
          { exactSourceBasis := schedule.sourceBasis,
            exactResidualValue := schedule.residualValue, postedSourceBasis := source.amount,
            quantizationPolicy := schedule.policy.quantizationPolicy,
            installments := schedule.installments } with e | result
      · rw [hpl] at hvalid
        cases hvalid
      rw [hpl] at hvalid
      cases result with
      | rejected ds => cases hvalid
      | planned expected =>
        simp only [Except.ok.injEq] at hvalid
        exact ⟨source, carried, expected, rfl, hz, rfl, hpl,
          (contentHashEquals_iff _ _).mp hvalid⟩
    · rw [hb] at hvalid
      simp at hvalid
  · rintro ⟨huses, hne, source, carried, expected, hq, hz, hp, hpl, heq⟩
    have hb : (!usesCumulativeAllocation schedule.policy ||
        schedule.policy.allocationAccountId == schedule.policy.contraAccountId) = false := by
      rcases hb : (!usesCumulativeAllocation schedule.policy ||
        schedule.policy.allocationAccountId == schedule.policy.contraAccountId) with _ | _
      · rfl
      · exact absurd ((hcond true hb).mpr ⟨huses, hne⟩) (by simp)
    unfold allocationPlanIsValid
    simp only [h, ↓reduceIte, hb, Bool.false_eq_true, hq, hz, Bool.not_true, hp, hpl]
    exact congrArg Except.ok ((contentHashEquals_iff _ _).mpr heq)

/-- A schedule that passes carries the plan `planAllocationPostings` recomputes, every field the
same, or a collision of SHA-256 is in hand. -/
theorem allocationPlanIsValid_carried_eq {schedule : AllocationSchedule}
    (h : schedule.policy.postingAlgorithm ≠ none) (hvalid : allocationPlanIsValid schedule = .ok true) :
    ∃ source carried expected,
      quantize schedule.sourceBasis schedule.policy.quantizationPolicy.rule = .ok source ∧
      schedule.postingPlan = some carried ∧
      planAllocationPostings
          { exactSourceBasis := schedule.sourceBasis,
            exactResidualValue := schedule.residualValue, postedSourceBasis := source.amount,
            quantizationPolicy := schedule.policy.quantizationPolicy,
            installments := schedule.installments } = .ok (.planned expected) ∧
      (carried = expected ∨ HashCollision) := by
  obtain ⟨-, -, source, carried, expected, hq, -, hc, hp, heq⟩ :=
    (allocationPlanIsValid_true_iff h).mp hvalid
  exact ⟨source, carried, expected, hq, hc, hp,
    (accountingHash_inj_or_collision heq).imp (fun h => h.2) _root_.id⟩

/-! ## What the TypeScript does that a caller may not expect -/

/-- An allocation schedule whose policy uses the cumulative algorithm, with two accounts, and has
a scale outside 0 to 1,000 makes `validateAccountingEffectHash` throw the `RangeError` of `quantize`
(`accounting.ts` line 1565) instead of answering `false`. -/
theorem validateAccountingEffectHash_scale_error {schedule : AllocationSchedule}
    (halgorithm : schedule.policy.postingAlgorithm = some .cumulativePostedAllocationV1)
    (hversion : schedule.policy.algorithmVersion = cumulativeAllocationAlgorithmVersion)
    (haccounts : schedule.policy.allocationAccountId ≠ schedule.policy.contraAccountId)
    (hscale : schedule.policy.quantizationPolicy.targetScale < 0 ∨
      schedule.policy.quantizationPolicy.targetScale > maxDecimalScale) :
    validateAccountingEffectHash (.allocationSchedule schedule) = .error .scaleOutOfRange := by
  have hq : quantize schedule.sourceBasis schedule.policy.quantizationPolicy.rule =
      .error .scaleOutOfRange := by
    simp [quantize, QuantizationPolicy.rule, hscale]
  simp [validateAccountingEffectHash, allocationPlanIsValid, usesCumulativeAllocation, halgorithm,
    hversion, haccounts, hq]

/-- So admitting such a schedule, new and in its own book, throws instead of reporting
`canonical_identity_conflict`. -/
theorem validateAccountingEffectIdentities_scale_error {schedule : AllocationSchedule}
    {bookId : BookId} {identity : AccountingEffect → IdentityObservation}
    (halgorithm : schedule.policy.postingAlgorithm = some .cumulativePostedAllocationV1)
    (hversion : schedule.policy.algorithmVersion = cumulativeAllocationAlgorithmVersion)
    (haccounts : schedule.policy.allocationAccountId ≠ schedule.policy.contraAccountId)
    (hscale : schedule.policy.quantizationPolicy.targetScale < 0 ∨
      schedule.policy.quantizationPolicy.targetScale > maxDecimalScale)
    (hbook : schedule.bookId = bookId) (habsent : identity (.allocationSchedule schedule) = .absent) :
    validateAccountingEffectIdentities [.allocationSchedule schedule] bookId identity =
      .error .scaleOutOfRange := by
  simp [validateAccountingEffectIdentities, validateAccountingEffectIdentitiesFrom,
    effectIdentityFlagged, habsent, hbook, AccountingEffect.scopedBookId,
    validateAccountingEffectHash_scale_error halgorithm hversion haccounts hscale]

end Rastrata.Kernel

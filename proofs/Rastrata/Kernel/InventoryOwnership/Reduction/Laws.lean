/-
The laws of `prepareInventoryPostedReduction` (`inventory-ownership.ts` line 140) for a prepared
reduction: what the tests guarantee, what is conserved, and how the posted money moves.

Hypotheses are only that the inputs are constructible (`WF`) and that the call returned
`prepared`; the rest is read off `ReductionView`.
-/
import Rastrata.Kernel.InventoryOwnership.Reduction.Prepared

namespace Rastrata.Kernel

namespace InventoryOwnership

/-! ## A quantized share -/

/-- What a quantized cumulative share is, as numbers: its fractions and policy are the ones given,
its exact targets are the total times each fraction, its posted amount is the difference of its two
rounded targets, and every number in it is constructible. -/
theorem share_facts {total : ExactDecimal} {before after : ExactRational}
    {policy : QuantizationPolicy} {share : PolicyCumulativePostedShare} (hT : total.WF)
    (hb : before.WF) (ha : after.WF)
    (h : policy.quantizeCumulativePostedShare total before after = .ok (.quantized share)) :
    share.beforeFraction = before ∧ share.afterFraction = after ∧ share.policy = policy ∧
      share.postedAmount.WF ∧ share.beforeQuantization.amount.WF ∧
      share.afterQuantization.amount.WF ∧ share.beforeTarget.WF ∧ share.afterTarget.WF ∧
      share.beforeTarget.toRat = total.toRat * before.toRat ∧
      share.afterTarget.toRat = total.toRat * after.toRat ∧
      share.postedAmount.toRat =
        share.afterQuantization.amount.toRat - share.beforeQuantization.amount.toRat ∧
      share.postedTotal.toRat = total.toRat := by
  obtain ⟨hrule, hpolicy⟩ := QuantizationPolicy.quantizeCumulativePostedShare_quantized_iff.mp h
  obtain ⟨t, one, normalized, htotal, -, -, -, -, -, -, -, hbt, hat, hbq, haq, hposted, -, hbf,
    haf, -⟩ := quantizeCumulativePostedShare_quantized hrule
  obtain ⟨htwf, httr⟩ := ExactDecimal.toRational_ok hT htotal
  obtain ⟨hbtwf, hbttr⟩ := ExactRational.multiply_ok htwf hb hbt
  obtain ⟨hatwf, hattr⟩ := ExactRational.multiply_ok htwf ha hat
  obtain ⟨hbqwf, -, hbqs, -, -⟩ := quantize_ok hbtwf hbq
  obtain ⟨haqwf, -, haqs, -, -⟩ := quantize_ok hatwf haq
  obtain ⟨hpwf, hpc, hps⟩ := ExactDecimal.of_ok hposted
  have htot := (QuantizationPolicy.cumulativeShare_policy_and_total hT hb ha h).2
  refine ⟨hbf, haf, hpolicy, hpwf, hbqwf, haqwf, hbtwf, hatwf, hbttr.trans (by rw [httr]),
    hattr.trans (by rw [httr]), ?_, htot⟩
  simp only [PolicyCumulativePostedShare.toShare] at hbqs haqs hpc hps
  unfold ExactDecimal.toRat
  rw [hpc, hps, hbqs, haqs]
  push_cast
  ring

/-- The rounded cumulative target after a share never exceeds the total, and equals it when the
share runs to the end (the fraction after is one): the last share consumes the last cent. -/
theorem share_after_bounds {total : ExactDecimal} {before after : ExactRational}
    {policy : QuantizationPolicy} {share : PolicyCumulativePostedShare} (hT : total.WF)
    (ha : after.WF)
    (h : policy.quantizeCumulativePostedShare total before after = .ok (.quantized share)) :
    share.afterQuantization.amount.toRat ≤ total.toRat ∧
      (after.toRat = 1 → share.afterQuantization.amount.toRat = total.toRat) := by
  obtain ⟨hrule, -⟩ := QuantizationPolicy.quantizeCumulativePostedShare_quantized_iff.mp h
  obtain ⟨t, one, normalized, htotal, hone, hneg, -, -, hle1, hnorm, hres, -, hat, -, haq, -,
    -, -, haf, -⟩ := quantizeCumulativePostedShare_quantized hrule
  obtain ⟨htwf, httr⟩ := ExactDecimal.toRational_ok hT htotal
  obtain ⟨hatwf, hattr⟩ := ExactRational.multiply_ok htwf ha hat
  obtain ⟨-, hreswf, hns, -, hnres⟩ := quantize_ok htwf hnorm
  have hres0 := (ExactRational.isZero_iff hreswf).mp hres
  have hnt : normalized.amount.toRat = t.toRat := by linarith
  have hone' : one.toRat = 1 := by
    obtain ⟨-, h1, -⟩ := ExactRational.of_ok hone
    rw [h1]; norm_num
  have hlt1 : after.toRat ≤ 1 := by
    have := (ExactRational.compare_gt_iff ha (ExactRational.of_ok hone).1).not.mp hle1
    linarith
  have ht0 : 0 ≤ t.toRat := by
    have := (ExactRational.isNegative_iff htwf).not.mp (by simp [hneg])
    linarith
  constructor
  · have hle : share.toShare.afterTarget.toRat ≤ t.toRat := by
      rw [hattr]
      nlinarith
    have := quantize_monotone hatwf htwf haq hnorm hle
    rw [← httr, ← hnt]
    exact this
  · intro h1
    have heq : share.toShare.afterTarget.toRat = t.toRat := by rw [hattr, h1, mul_one]
    have hc : share.toShare.afterTarget.toRat =
        (normalized.amount.coefficient : ℚ) / 10 ^ policy.rule.targetScale.toNat := by
      rw [heq, ← hnt]
      unfold ExactDecimal.toRat
      rw [hns]
    have := (quantize_representable hatwf haq hc).2.1
    rw [← httr]
    exact this.trans heq

/-- The rational a decimal converts to means the decimal's number. -/
theorem decimal_toRational_toRat {d : ExactDecimal} {r : ExactRational}
    (h : d.toRational = .ok r) : r.toRat = d.toRat := by
  obtain ⟨-, hrat, -⟩ := ExactRational.of_ok h
  rw [hrat]
  simp only [ExactDecimal.toRat]
  push_cast
  rfl

/-! ## What the tests of a reduction guarantee -/

/-- When the quantity test passes: the anchor's quantity is positive, the consumed quantity lies
between zero and it, the holding holds exactly the unconsumed rest, and the allocation is a positive
part of this holding and lot that the holding can give. -/
theorem reductionQuantityInvalid_false {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    (hA : anchor.WF) (hP : position.WF) (hH : holding.WF) (hL : allocation.WF)
    (h : reductionQuantityInvalid anchor position holding allocation = .ok false) :
    0 < anchor.quantity.toRat ∧ 0 ≤ position.consumedQuantity.toRat ∧
      position.consumedQuantity.toRat ≤ anchor.quantity.toRat ∧
      holding.remainingQuantity.toRat = anchor.quantity.toRat - position.consumedQuantity.toRat ∧
      allocation.holdingId = holding.id ∧ allocation.lotId = holding.lotId ∧
      0 < allocation.allocatedQuantity.toRat ∧
      allocation.allocatedQuantity.toRat ≤ holding.remainingQuantity.toRat := by
  have hq : anchor.quantity.WF := hA.quantity
  have hc : position.consumedQuantity.WF := hP.consumedQuantity
  unfold reductionQuantityInvalid at h
  split at h
  · cases h
  rename_i hcond
  split at h
  · cases h
  rename_i unconsumed hsub
  rw [liftExact_eq_ok_iff] at hsub
  obtain ⟨huwf, hutr⟩ := ExactRational.subtract_ok hq hc hsub
  simp only [Bool.or_eq_true, bne_iff_ne, ne_eq, beq_iff_eq, not_or, Decidable.not_not,
    Bool.not_eq_true] at hcond
  obtain ⟨⟨hpos, hneg⟩, hle⟩ := hcond
  simp only [Except.ok.injEq, Bool.or_eq_false_iff, Bool.not_eq_false', bne_eq_false_iff_eq,
    beq_eq_false_iff_ne, ne_eq] at h
  obtain ⟨⟨⟨⟨hrem, hhid⟩, hlot⟩, hapos⟩, hale⟩ := h
  have hz := ExactRational.zero_wf
  refine ⟨?_, ?_, ?_, ?_, hhid, hlot, ?_, ?_⟩
  · have := (ExactRational.compare_gt_iff hq hz).mp hpos
    rwa [ExactRational.zero_toRat] at this
  · have := (ExactRational.isNegative_iff hc).not.mp (by simpa using hneg)
    linarith
  · have := (ExactRational.compare_gt_iff hc hq).not.mp hle
    linarith
  · rw [(ExactRational.equals_iff hH.remainingQuantity huwf).mp hrem, hutr]
  · have := (ExactRational.compare_gt_iff hL.allocatedQuantity hz).mp hapos
    rwa [ExactRational.zero_toRat] at this
  · have := (ExactRational.compare_gt_iff hL.allocatedQuantity hH.remainingQuantity).not.mp hale
    linarith

/-- `equals` is the equality of the two values. -/
theorem exactRational_equals_iff_eq (a b : ExactRational) : a.equals b = true ↔ a = b := by
  cases a; cases b
  simp [ExactRational.equals]

/-- When the allocation test passes: the holding's basis and carrying amount are not negative, its
allowance is not positive, its carrying amount is its basis plus its allowance, and the allocation
carries exactly the computed basis, allowance and carrying amount. -/
theorem reductionAllocationInvalid_false {holding : LotHolding} {allocation : LotAllocation}
    {basis allowance carrying : ExactRational} (hH : holding.WF)
    (h : reductionAllocationInvalid holding allocation basis allowance carrying = .ok false) :
    0 ≤ holding.remainingTotalBasis.toRat ∧ holding.remainingValuationAllowance.toRat ≤ 0 ∧
      0 ≤ holding.remainingCarryingAmount.toRat ∧
      holding.remainingCarryingAmount.toRat =
        holding.remainingTotalBasis.toRat + holding.remainingValuationAllowance.toRat ∧
      allocation.allocatedTotalBasis = basis ∧ allocation.allocatedValuationAllowance = allowance ∧
      allocation.allocatedCarryingAmount = carrying := by
  unfold reductionAllocationInvalid at h
  split at h
  · cases h
  rename_i hcond
  split at h
  · cases h
  rename_i sum hsum
  rw [liftExact_eq_ok_iff] at hsum
  obtain ⟨hswf, hstr⟩ := ExactRational.add_ok hH.remainingTotalBasis
    hH.remainingValuationAllowance hsum
  simp only [Bool.or_eq_true, Bool.and_eq_true, Bool.not_eq_true', not_or, not_and,
    Bool.not_eq_false] at hcond
  obtain ⟨⟨hbneg, hall⟩, hcneg⟩ := hcond
  simp only [Except.ok.injEq, Bool.or_eq_false_iff, Bool.not_eq_false',
    exactRational_equals_iff_eq] at h
  obtain ⟨⟨⟨hcar, hb⟩, ha⟩, hc⟩ := h
  refine ⟨?_, ?_, ?_, ?_, hb, ha, hc⟩
  · have := (ExactRational.isNegative_iff hH.remainingTotalBasis).not.mp (by simp [hbneg])
    linarith
  · by_cases hz : holding.remainingValuationAllowance.isZero = true
    · rw [(ExactRational.isZero_iff hH.remainingValuationAllowance).mp hz]
    · have := (ExactRational.isNegative_iff hH.remainingValuationAllowance).mp
        (hall (by simpa using hz))
      linarith
  · have := (ExactRational.isNegative_iff hH.remainingCarryingAmount).not.mp (by simp [hcneg])
    linarith
  · rw [hcar, hstr]

end InventoryOwnership

/-! ## Conservation in a prepared reduction -/

open InventoryOwnership in
/-- The economics of a prepared reduction, exactly: the allocation is the holding's proportional
share of basis and allowance by quantity, its carrying amount is the two together, and the holding
after the reduction plus the allocation is the holding before, in quantity, basis, allowance and
carrying amount; the holding after still carries its basis plus its allowance. -/
theorem prepareInventoryPostedReduction_holding_conserved {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    {origin : InventoryPostedReductionOrigin} {reduction : InventoryPostedReduction}
    (hH : holding.WF) (hL : allocation.WF)
    (h : prepareInventoryPostedReduction anchor position holding allocation origin =
      .ok (.prepared reduction)) :
    allocation.allocatedTotalBasis.toRat = holding.remainingTotalBasis.toRat *
        (allocation.allocatedQuantity.toRat / holding.remainingQuantity.toRat) ∧
      allocation.allocatedValuationAllowance.toRat = holding.remainingValuationAllowance.toRat *
        (allocation.allocatedQuantity.toRat / holding.remainingQuantity.toRat) ∧
      allocation.allocatedCarryingAmount.toRat =
        allocation.allocatedTotalBasis.toRat + allocation.allocatedValuationAllowance.toRat ∧
      reduction.afterHolding.remainingQuantity.toRat + allocation.allocatedQuantity.toRat =
        holding.remainingQuantity.toRat ∧
      reduction.afterHolding.remainingTotalBasis.toRat + allocation.allocatedTotalBasis.toRat =
        holding.remainingTotalBasis.toRat ∧
      reduction.afterHolding.remainingValuationAllowance.toRat +
          allocation.allocatedValuationAllowance.toRat =
        holding.remainingValuationAllowance.toRat ∧
      reduction.afterHolding.remainingCarryingAmount.toRat +
          allocation.allocatedCarryingAmount.toRat =
        holding.remainingCarryingAmount.toRat ∧
      reduction.afterHolding.remainingCarryingAmount.toRat =
        reduction.afterHolding.remainingTotalBasis.toRat +
          reduction.afterHolding.remainingValuationAllowance.toRat ∧
      reduction.afterHolding.WF := by
  obtain ⟨v⟩ := prepareInventoryPostedReduction_prepared h
  obtain ⟨hrec, -, -, -, hid, hbook, hlot, hacct, hcomm, hbc, -, -, -⟩ := reductionRecord_ok v.record_eq
  obtain ⟨hfwf, -, hftr⟩ := ExactRational.divide_ok hL.allocatedQuantity hH.remainingQuantity
    v.fraction_eq
  obtain ⟨hbwf, hbtr⟩ := ExactRational.multiply_ok hH.remainingTotalBasis hfwf v.basis_eq
  obtain ⟨hawf, hatr⟩ := ExactRational.multiply_ok hH.remainingValuationAllowance hfwf
    v.allowance_eq
  obtain ⟨hcwf, hctr⟩ := ExactRational.add_ok hbwf hawf v.carrying_eq
  obtain ⟨-, -, -, hsum, hb, ha, hc⟩ := reductionAllocationInvalid_false hH v.allocationTest
  obtain ⟨hq1, hq2⟩ := ExactRational.subtract_ok hH.remainingQuantity hL.allocatedQuantity
    hrec.remainingQuantity
  obtain ⟨hb1, hb2⟩ := ExactRational.subtract_ok hH.remainingTotalBasis hbwf
    hrec.remainingTotalBasis
  obtain ⟨ha1, ha2⟩ := ExactRational.subtract_ok hH.remainingValuationAllowance hawf
    hrec.remainingValuationAllowance
  obtain ⟨hc1, hc2⟩ := ExactRational.subtract_ok hH.remainingCarryingAmount hcwf
    hrec.remainingCarryingAmount
  rw [hb, ha, hc]
  refine ⟨by rw [hbtr, hftr], by rw [hatr, hftr], hctr, by rw [hq2]; ring, by rw [hb2]; ring,
    by rw [ha2]; ring, by rw [hc2]; ring, ?_, ⟨hq1, hb1, ha1, hc1⟩⟩
  rw [hc2, hb2, ha2, hsum, hctr]
  ring

open InventoryOwnership in
/-- The quantity and the posted money of a prepared reduction: the consumed quantity after is the
consumed quantity before plus the allocation; the planned share runs from the fraction consumed
before to the fraction consumed after, of the anchor's budget under the anchor's policy; the
recorded posted consumption before is the share's rounded target before, the one after is its
rounded target after, so the posted consumption grows by exactly the share's posted amount, which
is not negative, is at most one unit away from the exact share of the budget, and is what the
reduction posts, negated; and the difference from the economic carrying amount is reported
exactly. -/
theorem prepareInventoryPostedReduction_posted {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    {origin : InventoryPostedReductionOrigin} {reduction : InventoryPostedReduction}
    (hA : anchor.WF) (hP : position.WF) (hH : holding.WF) (hL : allocation.WF)
    (h : prepareInventoryPostedReduction anchor position holding allocation origin =
      .ok (.prepared reduction)) :
    reduction.afterPosition.consumedQuantity.toRat =
        position.consumedQuantity.toRat + allocation.allocatedQuantity.toRat ∧
      reduction.reductionProof.beforeFraction.toRat =
        position.consumedQuantity.toRat / anchor.quantity.toRat ∧
      reduction.reductionProof.afterFraction.toRat =
        reduction.afterPosition.consumedQuantity.toRat / anchor.quantity.toRat ∧
      reduction.reductionProof.policy = anchor.quantizationPolicy ∧
      reduction.reductionProof.postedTotal.toRat = anchor.postedBudget.toRat ∧
      position.consumedPosted.toRat = reduction.reductionProof.beforeQuantization.amount.toRat ∧
      reduction.afterPosition.consumedPosted = reduction.reductionProof.afterQuantization.amount ∧
      reduction.afterPosition.consumedPosted.toRat =
        position.consumedPosted.toRat + reduction.reductionProof.postedAmount.toRat ∧
      reduction.postedAmount.toRat = -reduction.reductionProof.postedAmount.toRat ∧
      0 ≤ reduction.reductionProof.postedAmount.toRat ∧
      |reduction.reductionProof.postedAmount.toRat -
          (reduction.reductionProof.afterFraction.toRat -
            reduction.reductionProof.beforeFraction.toRat) * anchor.postedBudget.toRat| ≤
        anchor.quantizationPolicy.rule.unit ∧
      reduction.postedMinusEconomic.toRat =
        reduction.reductionProof.postedAmount.toRat - allocation.allocatedCarryingAmount.toRat := by
  obtain ⟨v⟩ := prepareInventoryPostedReduction_prepared h
  obtain ⟨hrec, -, -, hafter, -, -, -, -, -, -, -, hproof, -⟩ := reductionRecord_ok v.record_eq
  have hq : anchor.quantity.WF := hA.quantity
  have hc : position.consumedQuantity.WF := hP.consumedQuantity
  have hbudget : anchor.postedBudget.WF := hA.postedBudget
  obtain ⟨hcqwf, hcqtr⟩ := ExactRational.add_ok hc hL.allocatedQuantity v.consumed_eq
  obtain ⟨hbfwf, -, hbftr⟩ := ExactRational.divide_ok hc hq v.before_eq
  obtain ⟨hafwf, -, haftr⟩ := ExactRational.divide_ok hcqwf hq v.after_eq
  obtain ⟨hsb, hsa, hsp, hpwf, hbqwf, haqwf, -, -, -, -, hpost, htot⟩ :=
    share_facts hbudget hbfwf hafwf v.share_eq
  obtain ⟨hnonneg, hunit⟩ :=
    QuantizationPolicy.cumulativeShare_nonneg_and_within_one_unit hbudget hbfwf hafwf v.share_eq
  have hrecwf := ExactDecimal.toRational_ok hP.consumedPosted v.recorded_eq
  have htgwf := ExactDecimal.toRational_ok hbqwf v.target_eq
  have hmatch := (ExactRational.equals_iff hrecwf.1 htgwf.1).mp v.recorded_matches
  have hcp : position.consumedPosted.toRat = v.planned.beforeQuantization.amount.toRat := by
    rw [← hrecwf.2, hmatch, htgwf.2]
  obtain ⟨-, hpm⟩ := hrec.posted
  obtain ⟨posted, hp1, hp2⟩ := hrec.posted
  have hpr := ExactDecimal.toRational_ok hpwf hp1
  obtain ⟨-, hdtr⟩ := ExactRational.subtract_ok hpr.1
    (ExactRational.add_ok (ExactRational.multiply_ok hH.remainingTotalBasis
      (ExactRational.divide_ok hL.allocatedQuantity hH.remainingQuantity v.fraction_eq).1
      v.basis_eq).1 (ExactRational.multiply_ok hH.remainingValuationAllowance
      (ExactRational.divide_ok hL.allocatedQuantity hH.remainingQuantity v.fraction_eq).1
      v.allowance_eq).1 v.carrying_eq).1 hp2
  obtain ⟨-, -, -, -, -, -, hcarry⟩ := reductionAllocationInvalid_false hH v.allocationTest
  obtain ⟨hpdwf, hpdc, hpds⟩ := ExactDecimal.of_ok hrec.postedAmount
  rw [hproof, hafter]
  refine ⟨hcqtr, by rw [hsb, hbftr], by rw [hsa, haftr]; rfl, hsp, htot, hcp, rfl, ?_, ?_, hnonneg,
    by rw [hsa, hsb]; exact hunit, ?_⟩
  · show v.planned.afterQuantization.amount.toRat = _
    rw [hcp, hpost]; ring
  · unfold ExactDecimal.toRat
    rw [hpdc, hpds]
    push_cast
    ring
  · rw [hdtr, hpr.2, hcarry]

open InventoryOwnership in
/-- A prepared reduction never consumes more posted money than the anchor's budget, and the
reduction that consumes the anchor's last unit consumes its last cent: the posted consumption after
it is then the budget exactly. -/
theorem prepareInventoryPostedReduction_budget {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    {origin : InventoryPostedReductionOrigin} {reduction : InventoryPostedReduction}
    (hA : anchor.WF) (hP : position.WF) (hL : allocation.WF)
    (h : prepareInventoryPostedReduction anchor position holding allocation origin =
      .ok (.prepared reduction)) :
    reduction.afterPosition.consumedPosted.toRat ≤ anchor.postedBudget.toRat ∧
      (reduction.afterPosition.consumedQuantity.toRat = anchor.quantity.toRat →
        reduction.afterPosition.consumedPosted.toRat = anchor.postedBudget.toRat) := by
  obtain ⟨v⟩ := prepareInventoryPostedReduction_prepared h
  obtain ⟨-, -, -, hafter, -, -, -, -, -, -, -, -, -⟩ := reductionRecord_ok v.record_eq
  have hq : anchor.quantity.WF := hA.quantity
  have hc : position.consumedQuantity.WF := hP.consumedQuantity
  obtain ⟨hcqwf, -⟩ := ExactRational.add_ok hc hL.allocatedQuantity v.consumed_eq
  obtain ⟨hafwf, hq0, haftr⟩ := ExactRational.divide_ok hcqwf hq v.after_eq
  obtain ⟨hle, hone⟩ := share_after_bounds hA.postedBudget hafwf v.share_eq
  rw [hafter]
  refine ⟨hle, fun hfull => hone ?_⟩
  rw [haftr]
  exact (div_eq_one_iff_eq hq0).mpr hfull

open InventoryOwnership in
/-- A prepared reduction is quantity-only exactly when its share posts nothing; otherwise it is
journal-linked. -/
theorem prepareInventoryPostedReduction_monetaryKind {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    {origin : InventoryPostedReductionOrigin} {reduction : InventoryPostedReduction}
    (h : prepareInventoryPostedReduction anchor position holding allocation origin =
      .ok (.prepared reduction)) :
    (reduction.monetaryKind = .quantityOnly ↔ reduction.reductionProof.postedAmount.toRat = 0) ∧
      (reduction.monetaryKind = .journalLinked ↔
        reduction.reductionProof.postedAmount.toRat ≠ 0) := by
  obtain ⟨v⟩ := prepareInventoryPostedReduction_prepared h
  obtain ⟨-, hkind, -, -, -, -, -, -, -, -, -, hproof, -⟩ := reductionRecord_ok v.record_eq
  rw [hkind, hproof]
  rcases hz : v.planned.postedAmount.isZero with _ | _
  · have hne : v.planned.postedAmount.toRat ≠ 0 := fun h0 => by
      rw [(ExactDecimal.isZero_iff _).mpr h0] at hz
      cases hz
    simp [hne]
  · have h0 : v.planned.postedAmount.toRat = 0 := (ExactDecimal.isZero_iff _).mp hz
    simp [h0]

open InventoryOwnership in
/-- The posted components of a prepared reduction: none for an anchor without them; for a
component-bearing anchor, the allocation of its components over the same cumulative fractions as
the share, whose carrying total is the anchor's budget, and in which what was consumed before, what
this reduction consumes and what remains add up to the anchor's basis, allowance and carrying amount
exactly, basis plus allowance being carrying in what is consumed and in what remains. -/
theorem prepareInventoryPostedReduction_postedValue {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    {origin : InventoryPostedReductionOrigin} {reduction : InventoryPostedReduction}
    (hA : anchor.WF) (hP : position.WF) (hL : allocation.WF)
    (h : prepareInventoryPostedReduction anchor position holding allocation origin =
      .ok (.prepared reduction)) :
    (anchor.postedValue = none → reduction.postedValue = none) ∧
      ∀ budget, anchor.postedValue = some budget → ∃ values,
        reduction.postedValue = some values ∧
        allocateInventoryPostedValue budget reduction.reductionProof.beforeFraction
          reduction.reductionProof.afterFraction anchor.quantizationPolicy =
            .ok (.allocated values) ∧
        values.carryingProof.postedTotal.toRat = anchor.postedBudget.toRat ∧
        (values.carryingProof.beforeQuantization.amount.toRat +
            values.allowanceProof.beforeQuantization.amount.toRat) +
            values.consumed.basis.toRat + values.remaining.basis.toRat = budget.basis.toRat ∧
        (-values.allowanceProof.beforeQuantization.amount.toRat) +
            values.consumed.allowance.toRat + values.remaining.allowance.toRat =
          budget.allowance.toRat ∧
        values.carryingProof.beforeQuantization.amount.toRat + values.carryingConsumed.toRat +
            values.carryingRemaining.toRat = budget.carryingRat ∧
        values.consumed.carryingRat = values.carryingConsumed.toRat ∧
        values.remaining.carryingRat = values.carryingRemaining.toRat := by
  obtain ⟨v⟩ := prepareInventoryPostedReduction_prepared h
  obtain ⟨-, -, -, -, -, -, -, -, -, -, -, hproof, hpv⟩ := reductionRecord_ok v.record_eq
  have hq : anchor.quantity.WF := hA.quantity
  have hc : position.consumedQuantity.WF := hP.consumedQuantity
  obtain ⟨hcqwf, -⟩ := ExactRational.add_ok hc hL.allocatedQuantity v.consumed_eq
  obtain ⟨hbfwf, -, -⟩ := ExactRational.divide_ok hc hq v.before_eq
  obtain ⟨hafwf, -, -⟩ := ExactRational.divide_ok hcqwf hq v.after_eq
  obtain ⟨hsb, hsa, -⟩ := share_facts hA.postedBudget hbfwf hafwf v.share_eq
  have hpost := v.postedValue_eq
  rw [hpv, hproof]
  unfold reductionPostedValue at hpost
  constructor
  · intro hnone
    rw [hnone] at hpost
    simp only [Except.ok.injEq, OwnershipStep.proceed.injEq] at hpost
    exact hpost.symm
  · intro budget hsome
    rw [hsome] at hpost
    simp only at hpost
    have hbw : budget.WF := hA.postedValue budget hsome
    split at hpost
    · cases hpost
    · cases hpost
    rename_i values halloc
    split at hpost
    · cases hpost
    rename_i carryingTotal hct
    split at hpost
    · cases hpost
    rename_i budgetTotal hbt
    split at hpost
    · cases hpost
    rename_i hmatch
    simp only [Except.ok.injEq, OwnershipStep.proceed.injEq] at hpost
    rw [← hpost]
    rw [liftExact_eq_ok_iff] at hct hbt
    have hm : carryingTotal = budgetTotal := by
      rcases hb : carryingTotal.equals budgetTotal with _ | _
      · rw [hb] at hmatch
        exact absurd rfl hmatch
      · exact (exactRational_equals_iff_eq _ _).mp hb
    rw [hsb, hsa]
    rw [hsb, hsa] at halloc
    obtain ⟨hc1, hc2, hc3⟩ := allocateInventoryPostedValue_conservation_from_before hbw hbfwf
      hafwf halloc
    obtain ⟨hk1, hk2⟩ := allocateInventoryPostedValue_carrying_eq hbw hbfwf hafwf halloc
    refine ⟨values, rfl, halloc, ?_, hc1, hc2, hc3, hk1, hk2⟩
    rw [← decimal_toRational_toRat hct, ← decimal_toRational_toRat hbt, hm]

end Rastrata.Kernel

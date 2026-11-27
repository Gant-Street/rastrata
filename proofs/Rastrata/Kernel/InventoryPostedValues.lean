/-
Inventory posted values: the Lean model of `packages/kernel/src/inventory-posted-values.ts`
(`InventoryPostedValueBudget`, `InventoryPostedValueAllocation`, `allocateInventoryPostedValue`,
`InventoryAllowanceChange`, and `adjustInventoryPostedAllowance`).

Three layers, as everywhere in this project:

1. Model: every definition mirrors one TypeScript member, named in its doc comment, with the same
   checks in the same order, `.error` where the TypeScript throws, and the exact same rejection
   diagnostics (code, path, message text, and requirement identifiers).
2. Meaning: `ExactDecimal.toRat` and `ExactRational.toRat` for the monetary values and fractions,
   with `WF` on `InventoryPostedValueBudget` and `InventoryEconomicValue`.
3. Laws: conservation, `basis + allowance = carrying`, sign and nonnegativity bounds, terminal
   depletion and zero-width slices, cumulative fraction chains, one-unit rounding bounds, exact
   rejection characterizations, and size-only errors — together with counterexamples and
   documentation where the TypeScript diverges from naive expectations.

Where the model differs from the TypeScript in form:

- `Object.freeze` and the shallow copies `{ ...suppliedPolicy }` and `{ ...supplied }` (line 60)
  are not modelled.
- The TypeScript's run-time guard `kind !== "writeDown" && kind !== "writeDownReversal"` (line 118)
  always passes for a value of `InventoryAllowanceChangeKind`.
- The unexported `share` helper returns `Except QuantizeErr PolicyCumulativePostedShare` because
  the underlying arithmetic operations can throw `representation_limit_exceeded`.
- Message texts are carried in full, as the TypeScript writes them.

Where the TypeScript does something a naive law would not expect (`inventory-posted-values.ts`):

- Lines 70 to 77: `remaining` is the total less the cumulative amount through `afterFraction`, not less
  what was consumed, so `consumed + remaining = supplied` only when `beforeFraction` rounds to zero
  (`allocateInventoryPostedValue_conservation_iff`). Supplied basis 100.00 and allowance -20.00,
  fractions 1/2 and 1, scale 2: consumed basis 50.00, remaining basis 0.00. The consumed amounts of
  consecutive slices of the ORIGINAL budget add up to it exactly (`allocateInventoryPostedValue_chain_sum`);
  given the remaining budget and the same fractions they do not (10.00, fractions 0 to 1/2 then 1/2 to 1:
  5.00 and 2.50).
- Line 61: the share of the basis is computed only to validate, yet it can throw the size limit when the
  two shares actually used cannot (basis 0.7, allowance -0.2, `beforeFraction` 1/2^16381, scale 1).
- Lines 63 to 65 and 114 to 119: sums are computed before the checks, so an input that would be rejected
  can throw instead (positive allowance 2^16383 with basis 2^16383; economic basis -1 with an allowance and
  a change that overflow); the rejection characterizations therefore require every sum to have been computed.
- Line 73: the consumed basis is the net share plus the allowance-magnitude share, each within one unit, so
  it is within two units of the exact share, and two is reached (basis 4, allowance -2, fractions 1/4 and
  3/4, scale 0, half even). In half even a share can be a whole unit from the exact one (a tie), so the
  strict bounds hold only for the other four modes.
- Lines 112 to 126: the economics are never compared with the posted budget, so any economics are accepted;
  a nonzero economic change posts zero when the posted total is zero.
- Lines 122 to 129: `before` is the budget written at the policy's scale (the same numbers), so its
  decimals have the policy's scale and not the budget's.
- Line 118 and `quantization.ts` line 71 test strings that the Lean types exclude: a `kind` that is
  neither is rejected with the allowance diagnostic, and a rounding mode that is none of the five with the
  share diagnostic.
-/
import Rastrata.Kernel.Numeric
import Rastrata.Kernel.NumericLimits
import Rastrata.Kernel.Canonical
import Rastrata.Kernel.Journal.Types
import Rastrata.Kernel.Quantization
import Rastrata.Kernel.QuantizationBalanced

namespace Rastrata.Kernel

/-! ## Types and helpers (`inventory-posted-values.ts` lines 9 to 32) -/

/-- `InventoryPostedValueBudget`. -/
structure InventoryPostedValueBudget where
  basis : ExactDecimal
  allowance : ExactDecimal
  deriving DecidableEq, Repr, Inhabited

/-- `ValueRejection`. -/
structure ValueRejection where
  diagnostics : List SemanticDiagnostic
  deriving DecidableEq, Repr, Inhabited

/-- `reject` (`inventory-posted-values.ts` line 19). -/
private def reject (path message : String) : ValueRejection :=
  { diagnostics :=
      [diagnostic .inventory_value_adjustment_violation path message
        ["ACC-039.5", "ACC-039.7", "ACC-039.9"]] }

/-- The diagnostic of the budget rejection of `allocateInventoryPostedValue` (line 66). -/
def budgetRejectionDiagnostic : SemanticDiagnostic :=
  diagnostic .inventory_value_adjustment_violation "inventoryPostedValue.budget"
    "Posted basis and non-positive allowance must be representable in one pinned policy, with nonnegative net carrying value"
    ["ACC-039.5", "ACC-039.7", "ACC-039.9"]

/-- The diagnostic of the allowance rejection of `adjustInventoryPostedAllowance` (line 120). -/
def allowanceRejectionDiagnostic : SemanticDiagnostic :=
  diagnostic .inventory_value_adjustment_violation "inventoryPostedValue.allowance"
    "Allowance changes must have the declared sign, preserve nonnegative economic carrying value, and never reverse more than remaining write-downs"
    ["ACC-039.5", "ACC-039.7", "ACC-039.9"]

/-- `share` (`inventory-posted-values.ts` line 26). -/
private def share (total : ExactDecimal) (before after : ExactRational)
    (policy : QuantizationPolicy) : Except QuantizeErr PolicyCumulativePostedShare :=
  match liftExact total.toRational with
  | .error e => .error e
  | .ok totalBefore =>
    match liftExact (totalBefore.multiply before) with
    | .error e => .error e
    | .ok beforeTarget =>
      match liftExact total.toRational with
      | .error e => .error e
      | .ok totalAfter =>
        match liftExact (totalAfter.multiply after) with
        | .error e => .error e
        | .ok afterTarget =>
          match quantize beforeTarget policy.rule with
          | .error e => .error e
          | .ok beforeQuantization =>
            match quantize afterTarget policy.rule with
            | .error e => .error e
            | .ok afterQuantization =>
              match liftExact (ExactDecimal.of
                (afterQuantization.amount.coefficient - beforeQuantization.amount.coefficient)
                policy.targetScale) with
              | .error e => .error e
              | .ok postedAmount =>
                .ok
                  { postedTotal := total
                    beforeFraction := before
                    afterFraction := after
                    beforeTarget := beforeTarget
                    afterTarget := afterTarget
                    beforeQuantization := beforeQuantization
                    afterQuantization := afterQuantization
                    postedAmount := postedAmount
                    policy := policy }

/-- `InventoryPostedValueAllocation`. -/
structure InventoryPostedValueAllocation where
  consumed : InventoryPostedValueBudget
  remaining : InventoryPostedValueBudget
  carryingConsumed : ExactDecimal
  carryingRemaining : ExactDecimal
  allowanceProof : PolicyCumulativePostedShare
  carryingProof : PolicyCumulativePostedShare
  deriving DecidableEq, Repr, Inhabited

/-- The result of `allocateInventoryPostedValue` when it does not throw: `allocated` or
`rejected`. -/
inductive InventoryPostedValueAllocationResult where
  | allocated (allocation : InventoryPostedValueAllocation)
  | rejected (rejection : ValueRejection)
  deriving DecidableEq, Repr, Inhabited

/-- `allocateInventoryPostedValue` (`inventory-posted-values.ts` line 54). -/
def allocateInventoryPostedValue (supplied : InventoryPostedValueBudget)
    (beforeFraction afterFraction : ExactRational) (suppliedPolicy : QuantizationPolicy) :
    Except QuantizeErr InventoryPostedValueAllocationResult :=
  match suppliedPolicy.quantizeCumulativePostedShare supplied.basis beforeFraction afterFraction with
  | .error e => .error e
  | .ok (.rejected diagnostics) => .ok (.rejected ⟨diagnostics⟩)
  | .ok (.quantized _) =>
    match liftExact supplied.allowance.toRational with
    | .error e => .error e
    | .ok allowanceRational =>
      match quantize allowanceRational suppliedPolicy.rule with
      | .error e => .error e
      | .ok allowance =>
        match liftExact supplied.basis.toRational with
        | .error e => .error e
        | .ok basisRational =>
          match liftExact supplied.allowance.toRational with
          | .error e => .error e
          | .ok allowanceRational2 =>
            match liftExact (basisRational.add allowanceRational2) with
            | .error e => .error e
            | .ok carryingRational =>
              match quantize carryingRational suppliedPolicy.rule with
              | .error e => .error e
              | .ok carrying =>
                if supplied.allowance.coefficient > 0 ∨ allowance.residual.isZero = false ∨
                    carrying.residual.isZero = false ∨ carrying.amount.coefficient < 0 then
                  .ok (.rejected (reject "inventoryPostedValue.budget"
                    "Posted basis and non-positive allowance must be representable in one pinned policy, with nonnegative net carrying value"))
                else
                  match share allowance.amount.negate beforeFraction afterFraction
                      suppliedPolicy with
                  | .error e => .error e
                  | .ok allowanceProof =>
                    match share carrying.amount beforeFraction afterFraction suppliedPolicy with
                    | .error e => .error e
                    | .ok carryingProof =>
                      let allowanceRemaining :=
                        -allowance.amount.coefficient -
                          allowanceProof.afterQuantization.amount.coefficient
                      let carryingRemaining :=
                        carrying.amount.coefficient -
                          carryingProof.afterQuantization.amount.coefficient
                      match liftExact (ExactDecimal.of
                          (carryingProof.postedAmount.coefficient +
                            allowanceProof.postedAmount.coefficient)
                          suppliedPolicy.targetScale) with
                      | .error e => .error e
                      | .ok consumedBasis =>
                        match liftExact (ExactDecimal.of
                            (carryingRemaining + allowanceRemaining)
                            suppliedPolicy.targetScale) with
                        | .error e => .error e
                        | .ok remainingBasis =>
                          match liftExact (ExactDecimal.of (-allowanceRemaining)
                              suppliedPolicy.targetScale) with
                          | .error e => .error e
                          | .ok remainingAllowance =>
                            match liftExact (ExactDecimal.of carryingRemaining
                                suppliedPolicy.targetScale) with
                            | .error e => .error e
                            | .ok carryingRemainingDecimal =>
                              .ok (.allocated
                                { consumed :=
                                    { basis := consumedBasis
                                      allowance := allowanceProof.postedAmount.negate }
                                  remaining :=
                                    { basis := remainingBasis
                                      allowance := remainingAllowance }
                                  carryingConsumed := carryingProof.postedAmount
                                  carryingRemaining := carryingRemainingDecimal
                                  allowanceProof := allowanceProof
                                  carryingProof := carryingProof })

/-! ## `adjustInventoryPostedAllowance` (`inventory-posted-values.ts` lines 80 to 132) -/

/-- The `kind` union of `InventoryAllowanceChange` and `adjustInventoryPostedAllowance`. -/
inductive InventoryAllowanceChangeKind where
  | writeDown
  | writeDownReversal
  deriving DecidableEq, Repr, Inhabited

/-- The exact-rational `economics` argument of `adjustInventoryPostedAllowance`, unnamed in the
TypeScript. -/
structure InventoryEconomicValue where
  basis : ExactRational
  allowance : ExactRational
  deriving DecidableEq, Repr, Inhabited

/-- `InventoryAllowanceChange`. -/
structure InventoryAllowanceChange where
  kind : InventoryAllowanceChangeKind
  before : InventoryPostedValueBudget
  after : InventoryPostedValueBudget
  economicChange : ExactRational
  postedChange : ExactDecimal
  postedMinusEconomic : ExactRational
  proof : PolicyCumulativePostedShare
  deriving DecidableEq, Repr, Inhabited

/-- The result of `adjustInventoryPostedAllowance` when it does not throw: `adjusted` or
`rejected`. -/
inductive InventoryAllowanceChangeResult where
  | adjusted (change : InventoryAllowanceChange)
  | rejected (rejection : ValueRejection)
  deriving DecidableEq, Repr, Inhabited

/-- `adjustInventoryPostedAllowance` (`inventory-posted-values.ts` line 104). -/
def adjustInventoryPostedAllowance (budget : InventoryPostedValueBudget)
    (economics : InventoryEconomicValue) (kind : InventoryAllowanceChangeKind)
    (economicChange : ExactRational) (policy : QuantizationPolicy) :
    Except QuantizeErr InventoryAllowanceChangeResult :=
  let zero := ExactRational.zero
  match allocateInventoryPostedValue budget zero zero policy with
  | .error e => .error e
  | .ok (.rejected rejection) => .ok (.rejected rejection)
  | .ok (.allocated current) =>
    match liftExact (economics.basis.add economics.allowance) with
    | .error e => .error e
    | .ok economicCarrying =>
      match liftExact (economics.allowance.add economicChange) with
      | .error e => .error e
      | .ok afterAllowance =>
        if economics.basis.isNegative = true ∨ economics.allowance.compare zero = .gt ∨
            economicCarrying.isNegative = true then
          .ok (.rejected (reject "inventoryPostedValue.allowance"
            "Allowance changes must have the declared sign, preserve nonnegative economic carrying value, and never reverse more than remaining write-downs"))
        else
          match liftExact (economics.basis.add afterAllowance) with
          | .error e => .error e
          | .ok afterCarrying =>
            if afterCarrying.isNegative = true ∨ afterAllowance.compare zero = .gt ∨
                (kind = .writeDown ∧ economicChange.compare zero ≠ .lt) ∨
                (kind = .writeDownReversal ∧ economicChange.compare zero ≠ .gt) then
              .ok (.rejected (reject "inventoryPostedValue.allowance"
                "Allowance changes must have the declared sign, preserve nonnegative economic carrying value, and never reverse more than remaining write-downs"))
            else
              let before := current.remaining
              let fractionRes :=
                if kind = .writeDown then economicChange.negate.divide economicCarrying
                else economicChange.divide economics.allowance.negate
              match liftExact fractionRes with
              | .error e => .error e
              | .ok fraction =>
                let total :=
                  if kind = .writeDown then current.carryingRemaining else before.allowance.negate
                match share total zero fraction current.carryingProof.policy with
                | .error e => .error e
                | .ok proof =>
                  let postedChange :=
                    if kind = .writeDown then proof.postedAmount.negate else proof.postedAmount
                  match liftExact (ExactDecimal.of
                      (before.allowance.coefficient + postedChange.coefficient)
                      before.allowance.scale) with
                  | .error e => .error e
                  | .ok afterAllowanceDecimal =>
                    let after : InventoryPostedValueBudget :=
                      { basis := before.basis, allowance := afterAllowanceDecimal }
                    match liftExact postedChange.toRational with
                    | .error e => .error e
                    | .ok postedChangeRat =>
                      match liftExact (postedChangeRat.subtract economicChange) with
                      | .error e => .error e
                      | .ok postedMinusEconomic =>
                        .ok (.adjusted
                          { kind := kind
                            before := before
                            after := after
                            economicChange := economicChange
                            postedChange := postedChange
                            postedMinusEconomic := postedMinusEconomic
                            proof := proof })

/-! ## Meaning -/

/-- What every `InventoryPostedValueBudget` built from `ExactDecimal` makers satisfies. -/
structure InventoryPostedValueBudget.WF (budget : InventoryPostedValueBudget) : Prop where
  basis_wf : budget.basis.WF
  allowance_wf : budget.allowance.WF

/-- The net carrying amount of an inventory posted-value budget, as a rational number. -/
def InventoryPostedValueBudget.carryingRat (budget : InventoryPostedValueBudget) : ℚ :=
  budget.basis.toRat + budget.allowance.toRat

/-- What every `InventoryEconomicValue` built from `ExactRational` makers satisfies. -/
structure InventoryEconomicValue.WF (economics : InventoryEconomicValue) : Prop where
  basis_wf : economics.basis.WF
  allowance_wf : economics.allowance.WF

/-- The net carrying amount of an economic inventory value, as a rational number. -/
def InventoryEconomicValue.carryingRat (economics : InventoryEconomicValue) : ℚ :=
  economics.basis.toRat + economics.allowance.toRat

/-! ## Helpers -/

private theorem liftExact_eq_ok {α : Type} {result : Except NumErr α} {value : α}
    (h : liftExact result = .ok value) : result = .ok value := by
  cases result with
  | error code => cases h
  | ok v => cases h; rfl

private theorem liftExact_eq_error {α : Type} {result : Except NumErr α} {e : QuantizeErr}
    (h : liftExact result = .error e) : ∃ code, result = .error code ∧ e = .exactNumber code := by
  cases result with
  | error code => cases h; exact ⟨code, rfl, rfl⟩
  | ok _ => cases h

private theorem decimal_of_error {coefficient scale : Int} {code : NumErr} (h0 : 0 ≤ scale)
    (h1 : scale ≤ maxDecimalScale) (h : ExactDecimal.of coefficient scale = .error code) :
    code = .representationLimitExceeded := by
  by_cases hw : withinMagnitude coefficient = true
  · rw [(ExactDecimal.of_eq_ok_iff coefficient scale ⟨coefficient, scale⟩).mpr
      ⟨h0, h1, hw, rfl⟩] at h
    cases h
  · rw [(ExactDecimal.of_eq_limit_iff coefficient scale).mpr ⟨h0, h1, hw⟩] at h
    cases h
    rfl

private theorem toRat_eq_mul_unit {amount : ExactDecimal} {rule : QuantizationRule}
    (h : amount.scale = rule.targetScale) : amount.toRat = amount.coefficient * rule.unit := by
  unfold ExactDecimal.toRat QuantizationRule.unit
  rw [h]
  ring

private theorem rounds_of_int (mode : RoundingMode) (c : Int) : Rounds mode (c : ℚ) c := by
  cases mode <;> simp [Rounds]

private theorem rounds_between_zero_and_int {mode : RoundingMode} {x : ℚ} {k c : Int}
    (h : Rounds mode x k) (hx0 : 0 ≤ x) (hxc : x ≤ c) : 0 ≤ k ∧ k ≤ c :=
  ⟨(rounds_of_int mode 0).mono h (by simpa using hx0), h.mono (rounds_of_int mode c) hxc⟩

private theorem share_ok {total : ExactDecimal} {before after : ExactRational}
    {policy : QuantizationPolicy} {sh : PolicyCumulativePostedShare}
    (hT : total.WF) (hb : before.WF) (ha : after.WF)
    (h : share total before after policy = .ok sh) :
    sh.postedTotal = total ∧ sh.beforeFraction = before ∧ sh.afterFraction = after ∧
      sh.policy = policy ∧
      sh.beforeTarget.WF ∧ sh.beforeTarget.toRat = total.toRat * before.toRat ∧
      sh.afterTarget.WF ∧ sh.afterTarget.toRat = total.toRat * after.toRat ∧
      quantize sh.beforeTarget policy.rule = .ok sh.beforeQuantization ∧
      quantize sh.afterTarget policy.rule = .ok sh.afterQuantization ∧
      sh.beforeQuantization.amount.WF ∧ sh.beforeQuantization.amount.scale = policy.targetScale ∧
      sh.afterQuantization.amount.WF ∧ sh.afterQuantization.amount.scale = policy.targetScale ∧
      sh.postedAmount.WF ∧ sh.postedAmount.scale = policy.targetScale ∧
      sh.postedAmount.coefficient =
        sh.afterQuantization.amount.coefficient - sh.beforeQuantization.amount.coefficient ∧
      sh.postedAmount.toRat =
        sh.afterQuantization.amount.toRat - sh.beforeQuantization.amount.toRat := by
  unfold share at h
  split at h
  · cases h
  · rename_i t1 ht1
    split at h
    · cases h
    · rename_i bt hbt
      split at h
      · cases h
      · rename_i t2 ht2
        split at h
        · cases h
        · rename_i at' hat
          split at h
          · cases h
          · rename_i bq hbq
            split at h
            · cases h
            · rename_i aq haq
              split at h
              · cases h
              · rename_i pa hpa
                cases h
                obtain ⟨ht1wf, ht1tr⟩ := ExactDecimal.toRational_ok hT (liftExact_eq_ok ht1)
                obtain ⟨ht2wf, ht2tr⟩ := ExactDecimal.toRational_ok hT (liftExact_eq_ok (by rw [← ht2]; exact ht1))
                obtain ⟨hbtwf, hbttr⟩ := ExactRational.multiply_ok ht1wf hb (liftExact_eq_ok hbt)
                obtain ⟨hatwf, hattr⟩ := ExactRational.multiply_ok ht2wf ha (liftExact_eq_ok hat)
                obtain ⟨hbqwf, -, hbqs, -, -⟩ := quantize_ok hbtwf hbq
                obtain ⟨haqwf, -, haqs, -, -⟩ := quantize_ok hatwf haq
                obtain ⟨hpawf, hpac, hpas⟩ := ExactDecimal.of_ok (liftExact_eq_ok hpa)
                refine ⟨rfl, rfl, rfl, rfl, hbtwf, by rw [hbttr, ht1tr], hatwf,
                  by rw [hattr, ht2tr], hbq, haq, hbqwf, hbqs, haqwf, haqs, hpawf, hpas, hpac,
                  ?_⟩
                rw [toRat_eq_mul_unit (rule := policy.rule) hpas,
                  toRat_eq_mul_unit (rule := policy.rule) haqs,
                  toRat_eq_mul_unit (rule := policy.rule) hbqs, hpac]
                push_cast
                ring

private theorem share_eq_quantizeCumulativePostedShare {total : ExactDecimal}
    {before after : ExactRational} {policy : QuantizationPolicy}
    {sh : PolicyCumulativePostedShare}
    (hT : total.WF) (hs : total.scale = policy.targetScale) (hb : before.WF) (ha : after.WF)
    (h0 : 0 ≤ policy.targetScale) (h1 : policy.targetScale ≤ maxDecimalScale)
    (ht0 : 0 ≤ total.toRat) (hb0 : 0 ≤ before.toRat) (hba : before.toRat ≤ after.toRat)
    (ha1 : after.toRat ≤ 1) (h : share total before after policy = .ok sh) :
    policy.quantizeCumulativePostedShare total before after = .ok (.quantized sh) := by
  obtain ⟨totalRat, htot, htwf, httr⟩ := ExactDecimal.toRational_isOk hT
  have hone : ExactRational.of 1 1 = .ok ⟨1, 1⟩ :=
    ExactRational.of_eq_reduced (by decide) (by decide) withinMagnitude_one withinMagnitude_one
  have honewf : (⟨1, 1⟩ : ExactRational).WF := (ExactRational.of_ok hone).1
  have honetr : (⟨1, 1⟩ : ExactRational).toRat = 1 := by simp [ExactRational.toRat]
  have hnot : ¬ (policy.rule.targetScale < 0 ∨ policy.rule.targetScale > maxDecimalScale ∨
      totalRat.isNegative = true ∨ before.isNegative = true ∨
      after.compare before = .lt ∨ after.compare ⟨1, 1⟩ = .gt) := by
    rw [ExactRational.isNegative_iff htwf, ExactRational.isNegative_iff hb,
      ExactRational.compare_lt_iff ha hb, ExactRational.compare_gt_iff ha honewf, httr, honetr]
    rintro (h' | h' | h' | h' | h' | h')
    · exact absurd h' (not_lt.mpr h0)
    · exact absurd h' (not_lt.mpr h1)
    · exact absurd h' (not_lt.mpr ht0)
    · exact absurd h' (not_lt.mpr hb0)
    · exact absurd h' (not_lt.mpr hba)
    · exact absurd h' (not_lt.mpr ha1)
  obtain ⟨norm, hnorm⟩ := quantize_isOk_of_units (rule := policy.rule) htwf h0 h1
    (c := total.coefficient) (by rw [httr]; unfold ExactDecimal.toRat; rw [hs]; rfl)
    hT.coefficient_within
  obtain ⟨hnormAmt, hnormRes⟩ := quantize_decimal hT hs htot hnorm
  unfold share at h
  rw [htot] at h
  change (match liftExact (totalRat.multiply before) with
    | Except.error e => Except.error e
    | Except.ok bt => _) = Except.ok sh at h
  split at h
  · cases h
  · rename_i bt hbt
    change (match liftExact (totalRat.multiply after) with
      | Except.error e => Except.error e
      | Except.ok at' => _) = Except.ok sh at h
    split at h
    · cases h
    · rename_i at' hat
      split at h
      · cases h
      · rename_i bq hbq
        split at h
        · cases h
        · rename_i aq haq
          split at h
          · cases h
          · rename_i pa hpa
            cases h
            unfold QuantizationPolicy.quantizeCumulativePostedShare
              Rastrata.Kernel.quantizeCumulativePostedShare
            rw [htot]
            simp only [liftExact]
            rw [hone]
            simp only []
            rw [ite_eq_right hnot, hnorm]
            simp only [hnormRes, show ExactRational.zero.isZero = true by rfl,
              Bool.true_eq_false, ↓reduceIte, liftExact_eq_ok hbt, liftExact_eq_ok hat, hbq, haq,
              show policy.rule.targetScale = policy.targetScale from rfl, liftExact_eq_ok hpa,
              CumulativePostedShare.withPolicy, hnormAmt]

private theorem share_error {total : ExactDecimal} {before after : ExactRational}
    {policy : QuantizationPolicy} {e : QuantizeErr}
    (hT : total.WF) (hb : before.WF) (ha : after.WF)
    (h0 : 0 ≤ policy.targetScale) (h1 : policy.targetScale ≤ maxDecimalScale)
    (h : share total before after policy = .error e) :
    e = .exactNumber .representationLimitExceeded := by
  unfold share at h
  obtain ⟨totalRat, htot, htwf, -⟩ := ExactDecimal.toRational_isOk hT
  rw [htot] at h
  simp only [liftExact] at h
  split at h
  · rename_i e' hm
    cases h
    obtain ⟨code, hcode, rfl⟩ := liftExact_eq_error hm
    rcases ExactRational.multiply_ok_or_limit htwf hb with ⟨c, hc⟩ | hlimit
    · rw [hc] at hcode; cases hcode
    · rw [hlimit] at hcode; cases hcode; rfl
  · rename_i bt hbt
    obtain ⟨hbtwf, -⟩ := ExactRational.multiply_ok htwf hb (liftExact_eq_ok hbt)
    split at h
    · rename_i e' hm
      cases h
      obtain ⟨code, hcode, rfl⟩ := liftExact_eq_error hm
      rcases ExactRational.multiply_ok_or_limit htwf ha with ⟨c, hc⟩ | hlimit
      · rw [hc] at hcode; cases hcode
      · rw [hlimit] at hcode; cases hcode; rfl
    · rename_i at' hat
      obtain ⟨hatwf, -⟩ := ExactRational.multiply_ok htwf ha (liftExact_eq_ok hat)
      split at h
      · cases h; exact quantize_error hbtwf h0 h1 (by assumption)
      · split at h
        · cases h; exact quantize_error hatwf h0 h1 (by assumption)
        · split at h
          · rename_i e' hof
            cases h
            obtain ⟨code, hcode, rfl⟩ := liftExact_eq_error hof
            rw [decimal_of_error h0 h1 hcode]
          · cases h

private structure AllocatedView (supplied : InventoryPostedValueBudget)
    (beforeFraction afterFraction : ExactRational) (policy : QuantizationPolicy)
    (alloc : InventoryPostedValueAllocation) : Prop where
  scale_nonneg : 0 ≤ policy.targetScale
  scale_le : policy.targetScale ≤ maxDecimalScale
  basis_nonneg : 0 ≤ supplied.basis.toRat
  allowance_nonpos : supplied.allowance.toRat ≤ 0
  carrying_nonneg : 0 ≤ supplied.carryingRat
  before_nonneg : 0 ≤ beforeFraction.toRat
  before_le_after : beforeFraction.toRat ≤ afterFraction.toRat
  after_le_one : afterFraction.toRat ≤ 1
  basis_rat : supplied.basis.toRat =
    (alloc.carryingProof.postedTotal.coefficient + alloc.allowanceProof.postedTotal.coefficient : Int) /
      10 ^ policy.targetScale.toNat
  allowance_rat : supplied.allowance.toRat =
    (-alloc.allowanceProof.postedTotal.coefficient : Int) / 10 ^ policy.targetScale.toNat
  carrying_rat : supplied.carryingRat =
    (alloc.carryingProof.postedTotal.coefficient : Int) / 10 ^ policy.targetScale.toNat
  allowance_share : policy.quantizeCumulativePostedShare alloc.allowanceProof.postedTotal
    beforeFraction afterFraction = .ok (.quantized alloc.allowanceProof)
  carrying_share : policy.quantizeCumulativePostedShare alloc.carryingProof.postedTotal
    beforeFraction afterFraction = .ok (.quantized alloc.carryingProof)
  allowanceProof_total_wf : alloc.allowanceProof.postedTotal.WF
  allowanceProof_total_scale : alloc.allowanceProof.postedTotal.scale = policy.targetScale
  allowanceProof_total_rat : alloc.allowanceProof.postedTotal.toRat = -supplied.allowance.toRat
  allowanceProof_total_nonneg : 0 ≤ alloc.allowanceProof.postedTotal.coefficient
  carryingProof_total_wf : alloc.carryingProof.postedTotal.WF
  carryingProof_total_scale : alloc.carryingProof.postedTotal.scale = policy.targetScale
  carryingProof_total_rat : alloc.carryingProof.postedTotal.toRat = supplied.carryingRat
  carryingProof_total_nonneg : 0 ≤ alloc.carryingProof.postedTotal.coefficient
  allowance_policy : alloc.allowanceProof.policy = policy
  carrying_policy : alloc.carryingProof.policy = policy
  allowance_before : alloc.allowanceProof.beforeFraction = beforeFraction
  allowance_after : alloc.allowanceProof.afterFraction = afterFraction
  carrying_before : alloc.carryingProof.beforeFraction = beforeFraction
  carrying_after : alloc.carryingProof.afterFraction = afterFraction
  consumed_wf : alloc.consumed.WF
  remaining_wf : alloc.remaining.WF
  carryingConsumed_wf : alloc.carryingConsumed.WF
  carryingRemaining_wf : alloc.carryingRemaining.WF
  consumed_basis_scale : alloc.consumed.basis.scale = policy.targetScale
  consumed_allowance_scale : alloc.consumed.allowance.scale = policy.targetScale
  remaining_basis_scale : alloc.remaining.basis.scale = policy.targetScale
  remaining_allowance_scale : alloc.remaining.allowance.scale = policy.targetScale
  carryingConsumed_scale : alloc.carryingConsumed.scale = policy.targetScale
  carryingRemaining_scale : alloc.carryingRemaining.scale = policy.targetScale
  a0_wf : alloc.allowanceProof.beforeQuantization.amount.WF
  a0_scale : alloc.allowanceProof.beforeQuantization.amount.scale = policy.targetScale
  a1_wf : alloc.allowanceProof.afterQuantization.amount.WF
  a1_scale : alloc.allowanceProof.afterQuantization.amount.scale = policy.targetScale
  c0_wf : alloc.carryingProof.beforeQuantization.amount.WF
  c0_scale : alloc.carryingProof.beforeQuantization.amount.scale = policy.targetScale
  c1_wf : alloc.carryingProof.afterQuantization.amount.WF
  c1_scale : alloc.carryingProof.afterQuantization.amount.scale = policy.targetScale
  a_bounds : 0 ≤ alloc.allowanceProof.beforeQuantization.amount.coefficient ∧
    alloc.allowanceProof.beforeQuantization.amount.coefficient ≤
      alloc.allowanceProof.afterQuantization.amount.coefficient ∧
    alloc.allowanceProof.afterQuantization.amount.coefficient ≤
      alloc.allowanceProof.postedTotal.coefficient
  c_bounds : 0 ≤ alloc.carryingProof.beforeQuantization.amount.coefficient ∧
    alloc.carryingProof.beforeQuantization.amount.coefficient ≤
      alloc.carryingProof.afterQuantization.amount.coefficient ∧
    alloc.carryingProof.afterQuantization.amount.coefficient ≤
      alloc.carryingProof.postedTotal.coefficient
  consumed_basis_coeff : alloc.consumed.basis.coefficient =
    (alloc.carryingProof.afterQuantization.amount.coefficient -
      alloc.carryingProof.beforeQuantization.amount.coefficient) +
    (alloc.allowanceProof.afterQuantization.amount.coefficient -
      alloc.allowanceProof.beforeQuantization.amount.coefficient)
  consumed_allowance_coeff : alloc.consumed.allowance.coefficient =
    -(alloc.allowanceProof.afterQuantization.amount.coefficient -
      alloc.allowanceProof.beforeQuantization.amount.coefficient)
  carryingConsumed_coeff : alloc.carryingConsumed.coefficient =
    alloc.carryingProof.afterQuantization.amount.coefficient -
      alloc.carryingProof.beforeQuantization.amount.coefficient
  remaining_basis_coeff : alloc.remaining.basis.coefficient =
    (alloc.carryingProof.postedTotal.coefficient -
      alloc.carryingProof.afterQuantization.amount.coefficient) +
    (alloc.allowanceProof.postedTotal.coefficient -
      alloc.allowanceProof.afterQuantization.amount.coefficient)
  remaining_allowance_coeff : alloc.remaining.allowance.coefficient =
    -(alloc.allowanceProof.postedTotal.coefficient -
      alloc.allowanceProof.afterQuantization.amount.coefficient)
  carryingRemaining_coeff : alloc.carryingRemaining.coefficient =
    alloc.carryingProof.postedTotal.coefficient -
      alloc.carryingProof.afterQuantization.amount.coefficient
  carryingConsumed_eq : alloc.carryingConsumed = alloc.carryingProof.postedAmount
  consumed_allowance_eq : alloc.consumed.allowance = alloc.allowanceProof.postedAmount.negate

private theorem share_bounds {total : ExactDecimal} {before after : ExactRational}
    {policy : QuantizationPolicy} {sh : PolicyCumulativePostedShare}
    (hT : total.WF) (hs : total.scale = policy.targetScale) (hb : before.WF) (ha : after.WF)
    (ht0 : 0 ≤ total.toRat) (hb0 : 0 ≤ before.toRat) (hba : before.toRat ≤ after.toRat)
    (ha1 : after.toRat ≤ 1) (h : share total before after policy = .ok sh) :
    0 ≤ sh.beforeQuantization.amount.coefficient ∧
      sh.beforeQuantization.amount.coefficient ≤ sh.afterQuantization.amount.coefficient ∧
      sh.afterQuantization.amount.coefficient ≤ total.coefficient := by
  obtain ⟨-, -, -, -, hbtwf, hbttr, hatwf, hattr, hbq, haq, -, hbqs, -, haqs, -, -, -, -⟩ :=
    share_ok hT hb ha h
  obtain ⟨-, -, -, hrb, -⟩ := quantize_ok hbtwf hbq
  obtain ⟨-, -, -, hra, -⟩ := quantize_ok hatwf haq
  have htunit : total.toRat * 10 ^ policy.targetScale.toNat = total.coefficient := by
    rw [toRat_eq_mul_unit (rule := policy.rule) hs]
    unfold QuantizationRule.unit
    field_simp
    rfl
  have hbt0 : 0 ≤ sh.beforeTarget.toRat * 10 ^ policy.rule.targetScale.toNat := by
    rw [hbttr]
    exact mul_nonneg (mul_nonneg ht0 hb0) (by positivity)
  have hbtle : sh.beforeTarget.toRat * 10 ^ policy.rule.targetScale.toNat ≤ total.coefficient := by
    rw [hbttr]
    calc total.toRat * before.toRat * 10 ^ policy.rule.targetScale.toNat
        ≤ total.toRat * 1 * 10 ^ policy.rule.targetScale.toNat := by
          have := mul_le_mul_of_nonneg_left (hba.trans ha1) ht0
          exact mul_le_mul_of_nonneg_right this (by positivity)
      _ = total.coefficient := by rw [mul_one]; exact htunit
  have hat0 : 0 ≤ sh.afterTarget.toRat * 10 ^ policy.rule.targetScale.toNat := by
    rw [hattr]
    exact mul_nonneg (mul_nonneg ht0 (hb0.trans hba)) (by positivity)
  have hatle : sh.afterTarget.toRat * 10 ^ policy.rule.targetScale.toNat ≤ total.coefficient := by
    rw [hattr]
    calc total.toRat * after.toRat * 10 ^ policy.rule.targetScale.toNat
        ≤ total.toRat * 1 * 10 ^ policy.rule.targetScale.toNat := by
          have := mul_le_mul_of_nonneg_left ha1 ht0
          exact mul_le_mul_of_nonneg_right this (by positivity)
      _ = total.coefficient := by rw [mul_one]; exact htunit
  have hbnd := rounds_between_zero_and_int hrb hbt0 hbtle
  have hand := rounds_between_zero_and_int hra hat0 hatle
  have hmono := quantize_monotone hbtwf hatwf hbq haq
    (by rw [hbttr, hattr]; exact mul_le_mul_of_nonneg_left hba ht0)
  rw [toRat_eq_mul_unit (rule := policy.rule) hbqs,
    toRat_eq_mul_unit (rule := policy.rule) haqs] at hmono
  have hcoeff : (sh.beforeQuantization.amount.coefficient : ℚ) ≤
      sh.afterQuantization.amount.coefficient :=
    le_of_mul_le_mul_right hmono policy.rule.unit_pos
  exact ⟨hbnd.1, by exact_mod_cast hcoeff, hand.2⟩

private theorem basis_share_facts {postedTotal : ExactDecimal}
    {beforeFraction afterFraction : ExactRational} {policy : QuantizationPolicy}
    {sh : PolicyCumulativePostedShare}
    (hT : postedTotal.WF) (hb : beforeFraction.WF) (ha : afterFraction.WF)
    (h : policy.quantizeCumulativePostedShare postedTotal beforeFraction afterFraction =
      .ok (.quantized sh)) :
    0 ≤ policy.targetScale ∧ policy.targetScale ≤ maxDecimalScale ∧
      0 ≤ postedTotal.toRat ∧ 0 ≤ beforeFraction.toRat ∧
      beforeFraction.toRat ≤ afterFraction.toRat ∧ afterFraction.toRat ≤ 1 ∧
      ∃ c : Int, postedTotal.toRat = c / 10 ^ policy.targetScale.toNat := by
  obtain ⟨hrule, -⟩ := QuantizationPolicy.quantizeCumulativePostedShare_quantized_iff.mp h
  obtain ⟨total, one, norm, htot, hone, c1, c2, c3, c4, hnorm, hz, -⟩ :=
    quantizeCumulativePostedShare_quantized hrule
  obtain ⟨htwf, httr⟩ := ExactDecimal.toRational_ok hT htot
  obtain ⟨honewf, honetr, -⟩ := ExactRational.of_ok hone
  obtain ⟨hnwf, hnreswf, hns, -, hnrestr⟩ := quantize_ok htwf hnorm
  have h0 : 0 ≤ policy.targetScale := by rw [← show norm.amount.scale = policy.targetScale from hns]; exact hnwf.scale_nonneg
  have h1 : policy.targetScale ≤ maxDecimalScale := by rw [← show norm.amount.scale = policy.targetScale from hns]; exact hnwf.scale_le
  have ht0 : 0 ≤ postedTotal.toRat := by
    rw [← httr]
    by_contra hc
    have t := (ExactRational.isNegative_iff htwf).mpr (not_le.mp hc)
    rw [c1] at t; cases t
  have hb0 : 0 ≤ beforeFraction.toRat := by
    by_contra hc
    have t := (ExactRational.isNegative_iff hb).mpr (not_le.mp hc)
    rw [c2] at t; cases t
  have hba : beforeFraction.toRat ≤ afterFraction.toRat := by
    by_contra hc
    exact c3 ((ExactRational.compare_lt_iff ha hb).mpr (not_le.mp hc))
  have ha1 : afterFraction.toRat ≤ 1 := by
    by_contra hc
    refine c4 ((ExactRational.compare_gt_iff ha honewf).mpr ?_)
    rw [honetr]; push_cast; linarith [not_le.mp hc]
  have hzero : norm.residual.toRat = 0 := (ExactRational.isZero_iff hnreswf).mp hz
  have hnamt : norm.amount.toRat = total.toRat := by linarith
  refine ⟨h0, h1, ht0, hb0, hba, ha1, norm.amount.coefficient, ?_⟩
  rw [← httr, ← hnamt]
  unfold ExactDecimal.toRat
  rw [show norm.amount.scale = policy.targetScale from hns]

private theorem allocated_view {supplied : InventoryPostedValueBudget}
    {beforeFraction afterFraction : ExactRational} {policy : QuantizationPolicy}
    {alloc : InventoryPostedValueAllocation}
    (hS : supplied.WF) (hb : beforeFraction.WF) (ha : afterFraction.WF)
    (h : allocateInventoryPostedValue supplied beforeFraction afterFraction policy =
      .ok (.allocated alloc)) :
    AllocatedView supplied beforeFraction afterFraction policy alloc := by
  unfold allocateInventoryPostedValue at h
  split at h
  · cases h
  · cases h
  · rename_i basisShare hbasis
    split at h
    · cases h
    · rename_i allowRat har
      split at h
      · cases h
      · rename_i allowanceQ haq
        split at h
        · cases h
        · rename_i basisRat hbr
          split at h
          · rename_i har2; cases har2
          · rename_i allowRat2 har2
            split at h
            · cases h
            · rename_i carryRat hcr
              split at h
              · cases h
              · rename_i carryingQ hcq
                split at h
                · cases h
                · rename_i hchk
                  split at h
                  · cases h
                  · rename_i allowanceProof hap
                    split at h
                    · cases h
                    · rename_i carryingProof hcp
                      split at h
                      · cases h
                      · rename_i consumedBasis hcb
                        dsimp only at h
                        split at h
                        · cases h
                        · rename_i remainingBasis hrb
                          split at h
                          · cases h
                          · rename_i remainingAllowance hra
                            split at h
                            · cases h
                            · rename_i carryingRemainingDecimal hcrm
                              cases h
                              cases har2
                              obtain ⟨h0, h1, hbt0, hb0, hba, ha1, -⟩ :=
                                basis_share_facts hS.basis_wf hb ha hbasis
                              simp only [not_or, not_lt] at hchk
                              obtain ⟨hcoeffLe0, hallowRes, hcarryRes, hcarryCoeff0⟩ := hchk
                              have hallowResT : allowanceQ.residual.isZero = true :=
                                Bool.eq_true_of_not_eq_false hallowRes
                              have hcarryResT : carryingQ.residual.isZero = true :=
                                Bool.eq_true_of_not_eq_false hcarryRes
                              obtain ⟨harwf, hartr⟩ := ExactDecimal.toRational_ok hS.allowance_wf (liftExact_eq_ok har)
                              obtain ⟨hawf, harwf', has, -, harestr⟩ := quantize_ok harwf haq
                              have hallowRat : allowanceQ.amount.toRat = supplied.allowance.toRat := by
                                have hz := (ExactRational.isZero_iff harwf').mp hallowResT
                                linarith
                              have hallowNegWf := ExactDecimal.negate_wf hawf
                              have hallowNegScale : allowanceQ.amount.negate.scale = policy.targetScale := has
                              have hallowNonpos : supplied.allowance.toRat ≤ 0 := by
                                unfold ExactDecimal.toRat
                                rw [div_nonpos_iff]
                                exact Or.inr ⟨by exact_mod_cast hcoeffLe0, by positivity⟩
                              have hallowNegNonneg : 0 ≤ allowanceQ.amount.negate.toRat := by
                                rw [ExactDecimal.negate_toRat, hallowRat]; linarith
                              obtain ⟨hbrwf, hbrtr⟩ := ExactDecimal.toRational_ok hS.basis_wf (liftExact_eq_ok hbr)
                              obtain ⟨hcrwf, hcrtr⟩ := ExactRational.add_ok hbrwf harwf (liftExact_eq_ok hcr)
                              obtain ⟨hcwf, hcrwf', hcs, -, hcrestr⟩ := quantize_ok hcrwf hcq
                              have hcarryRat : carryingQ.amount.toRat = supplied.carryingRat := by
                                have hz := (ExactRational.isZero_iff hcrwf').mp hcarryResT
                                unfold InventoryPostedValueBudget.carryingRat
                                linarith
                              have hcarryNonneg : 0 ≤ supplied.carryingRat := by
                                rw [← hcarryRat]
                                unfold ExactDecimal.toRat
                                exact div_nonneg (by exact_mod_cast hcarryCoeff0) (by positivity)
                              have hcarryAmtNonneg : 0 ≤ carryingQ.amount.toRat := by
                                rw [hcarryRat]; exact hcarryNonneg
                              obtain ⟨-, -, -, -, -, -, -, -, -, -, _, ha0s, _, ha1s, hapawf, hapas, hapac, -⟩ :=
                                share_ok hallowNegWf hb ha hap
                              obtain ⟨-, -, -, -, -, -, -, -, -, -, _, hc0s, _, hc1s, hcpawf, hcpas, hcpac, -⟩ :=
                                share_ok hcwf hb ha hcp
                              obtain ⟨hcbwf, hcbc, hcbs⟩ := ExactDecimal.of_ok (liftExact_eq_ok hcb)
                              obtain ⟨hrbwf, hrbc, hrbs⟩ := ExactDecimal.of_ok (liftExact_eq_ok hrb)
                              obtain ⟨hrawf, hrac, hras⟩ := ExactDecimal.of_ok (liftExact_eq_ok hra)
                              obtain ⟨hcrmwf, hcrmc, hcrmcs⟩ := ExactDecimal.of_ok (liftExact_eq_ok hcrm)
                              have hA_share := share_eq_quantizeCumulativePostedShare
                                hallowNegWf hallowNegScale hb ha h0 h1 hallowNegNonneg hb0 hba ha1 hap
                              have hC_share := share_eq_quantizeCumulativePostedShare
                                hcwf hcs hb ha h0 h1 hcarryAmtNonneg hb0 hba ha1 hcp
                              have haBnd := share_bounds hallowNegWf hallowNegScale hb ha hallowNegNonneg hb0 hba ha1 hap
                              have hcBnd := share_bounds hcwf hcs hb ha hcarryAmtNonneg hb0 hba ha1 hcp
                              have hallowAmtCoeffNonneg : 0 ≤ allowanceQ.amount.negate.coefficient := by
                                have hrat := hallowNegNonneg
                                unfold ExactDecimal.toRat at hrat
                                exact_mod_cast (div_nonneg_iff.mp hrat |>.elim (fun p => p.1) (fun p => by
                                  have : (0 : ℚ) < (10 : ℚ) ^ allowanceQ.amount.negate.scale.toNat := by positivity
                                  linarith [p.2]))
                              refine
                                { scale_nonneg := h0
                                  scale_le := h1
                                  basis_nonneg := hbt0
                                  allowance_nonpos := hallowNonpos
                                  carrying_nonneg := hcarryNonneg
                                  before_nonneg := hb0
                                  before_le_after := hba
                                  after_le_one := ha1
                                  basis_rat := ?_
                                  allowance_rat := ?_
                                  carrying_rat := ?_
                                  allowance_share := by simpa [show allowanceProof.postedTotal = allowanceQ.amount.negate from (share_ok hallowNegWf hb ha hap).1] using hA_share
                                  carrying_share := by simpa [show carryingProof.postedTotal = carryingQ.amount from (share_ok hcwf hb ha hcp).1] using hC_share
                                  allowanceProof_total_wf := by rw [(share_ok hallowNegWf hb ha hap).1]; exact hallowNegWf
                                  allowanceProof_total_scale := by rw [(share_ok hallowNegWf hb ha hap).1]; exact hallowNegScale
                                  allowanceProof_total_rat := by rw [(share_ok hallowNegWf hb ha hap).1, ExactDecimal.negate_toRat, hallowRat]
                                  allowanceProof_total_nonneg := by rw [(share_ok hallowNegWf hb ha hap).1]; exact hallowAmtCoeffNonneg
                                  carryingProof_total_wf := by rw [(share_ok hcwf hb ha hcp).1]; exact hcwf
                                  carryingProof_total_scale := by rw [(share_ok hcwf hb ha hcp).1]; exact hcs
                                  carryingProof_total_rat := by rw [(share_ok hcwf hb ha hcp).1]; exact hcarryRat
                                  carryingProof_total_nonneg := by rw [(share_ok hcwf hb ha hcp).1]; exact hcarryCoeff0
                                  allowance_policy := (share_ok hallowNegWf hb ha hap).2.2.2.1
                                  carrying_policy := (share_ok hcwf hb ha hcp).2.2.2.1
                                  allowance_before := (share_ok hallowNegWf hb ha hap).2.1
                                  allowance_after := (share_ok hallowNegWf hb ha hap).2.2.1
                                  carrying_before := (share_ok hcwf hb ha hcp).2.1
                                  carrying_after := (share_ok hcwf hb ha hcp).2.2.1
                                  consumed_wf := ⟨hcbwf, ExactDecimal.negate_wf hapawf⟩
                                  remaining_wf := ⟨hrbwf, hrawf⟩
                                  carryingConsumed_wf := hcpawf
                                  carryingRemaining_wf := hcrmwf
                                  consumed_basis_scale := hcbs
                                  consumed_allowance_scale := hapas
                                  remaining_basis_scale := hrbs
                                  remaining_allowance_scale := hras
                                  carryingConsumed_scale := hcpas
                                  carryingRemaining_scale := hcrmcs
                                  a0_wf := by
                                    obtain ⟨_, _, _, _, _, _, _, _, _, _, h0wf, -⟩ := share_ok hallowNegWf hb ha hap
                                    exact h0wf
                                  a0_scale := ha0s
                                  a1_wf := by
                                    obtain ⟨_, _, _, _, _, _, _, _, _, _, _, _, h1wf, -⟩ := share_ok hallowNegWf hb ha hap
                                    exact h1wf
                                  a1_scale := ha1s
                                  c0_wf := by
                                    obtain ⟨_, _, _, _, _, _, _, _, _, _, h0wf, -⟩ := share_ok hcwf hb ha hcp
                                    exact h0wf
                                  c0_scale := hc0s
                                  c1_wf := by
                                    obtain ⟨_, _, _, _, _, _, _, _, _, _, _, _, h1wf, -⟩ := share_ok hcwf hb ha hcp
                                    exact h1wf
                                  c1_scale := hc1s
                                  a_bounds := by
                                    rw [(share_ok hallowNegWf hb ha hap).1]
                                    exact haBnd
                                  c_bounds := by
                                    rw [(share_ok hcwf hb ha hcp).1]
                                    exact hcBnd
                                  consumed_basis_coeff := by rw [hcbc, hcpac, hapac]
                                  consumed_allowance_coeff := by
                                    change -allowanceProof.postedAmount.coefficient = _
                                    rw [hapac]
                                  carryingConsumed_coeff := hcpac
                                  remaining_basis_coeff := by
                                    rw [hrbc, (share_ok hcwf hb ha hcp).1, (share_ok hallowNegWf hb ha hap).1]
                                    rfl
                                  remaining_allowance_coeff := by
                                    rw [hrac, (share_ok hallowNegWf hb ha hap).1]
                                    rfl
                                  carryingRemaining_coeff := by
                                    rw [hcrmc, (share_ok hcwf hb ha hcp).1]
                                  carryingConsumed_eq := rfl
                                  consumed_allowance_eq := rfl }
                              · rw [(share_ok hcwf hb ha hcp).1, (share_ok hallowNegWf hb ha hap).1]
                                have hbdef : supplied.basis.toRat =
                                    supplied.carryingRat - supplied.allowance.toRat := by
                                  unfold InventoryPostedValueBudget.carryingRat; ring
                                rw [hbdef, ← hcarryRat, ← hallowRat]
                                unfold ExactDecimal.toRat ExactDecimal.negate
                                rw [hcs, has, show policy.rule.targetScale = policy.targetScale from rfl]
                                push_cast
                                ring
                              · rw [(share_ok hallowNegWf hb ha hap).1, ← hallowRat]
                                unfold ExactDecimal.toRat ExactDecimal.negate
                                rw [has, show policy.rule.targetScale = policy.targetScale from rfl]
                                push_cast
                                ring
                              · rw [(share_ok hcwf hb ha hcp).1, ← hcarryRat]
                                unfold ExactDecimal.toRat
                                rw [hcs, show policy.rule.targetScale = policy.targetScale from rfl]

/-! ## Laws of `allocateInventoryPostedValue` -/

/-- Every decimal returned by an allocation is constructible and at the policy's scale. -/
theorem allocateInventoryPostedValue_wf {supplied : InventoryPostedValueBudget}
    {beforeFraction afterFraction : ExactRational} {policy : QuantizationPolicy}
    {alloc : InventoryPostedValueAllocation}
    (hS : supplied.WF) (hb : beforeFraction.WF) (ha : afterFraction.WF)
    (h : allocateInventoryPostedValue supplied beforeFraction afterFraction policy =
      .ok (.allocated alloc)) :
    alloc.consumed.WF ∧ alloc.remaining.WF ∧ alloc.carryingConsumed.WF ∧
      alloc.carryingRemaining.WF ∧
      alloc.consumed.basis.scale = policy.targetScale ∧
      alloc.consumed.allowance.scale = policy.targetScale ∧
      alloc.remaining.basis.scale = policy.targetScale ∧
      alloc.remaining.allowance.scale = policy.targetScale ∧
      alloc.carryingConsumed.scale = policy.targetScale ∧
      alloc.carryingRemaining.scale = policy.targetScale := by
  have v := allocated_view hS hb ha h
  exact ⟨v.consumed_wf, v.remaining_wf, v.carryingConsumed_wf, v.carryingRemaining_wf,
    v.consumed_basis_scale, v.consumed_allowance_scale, v.remaining_basis_scale,
    v.remaining_allowance_scale, v.carryingConsumed_scale, v.carryingRemaining_scale⟩

/-- Basis plus allowance equals carrying value for both the consumed movement and the remaining
budget. -/
theorem allocateInventoryPostedValue_carrying_eq {supplied : InventoryPostedValueBudget}
    {beforeFraction afterFraction : ExactRational} {policy : QuantizationPolicy}
    {alloc : InventoryPostedValueAllocation}
    (hS : supplied.WF) (hb : beforeFraction.WF) (ha : afterFraction.WF)
    (h : allocateInventoryPostedValue supplied beforeFraction afterFraction policy =
      .ok (.allocated alloc)) :
    alloc.consumed.carryingRat = alloc.carryingConsumed.toRat ∧
      alloc.remaining.carryingRat = alloc.carryingRemaining.toRat := by
  have v := allocated_view hS hb ha h
  constructor
  · unfold InventoryPostedValueBudget.carryingRat
    rw [toRat_eq_mul_unit (rule := policy.rule) v.consumed_basis_scale,
      toRat_eq_mul_unit (rule := policy.rule) v.consumed_allowance_scale,
      toRat_eq_mul_unit (rule := policy.rule) v.carryingConsumed_scale,
      v.consumed_basis_coeff, v.consumed_allowance_coeff, v.carryingConsumed_coeff]
    push_cast; ring
  · unfold InventoryPostedValueBudget.carryingRat
    rw [toRat_eq_mul_unit (rule := policy.rule) v.remaining_basis_scale,
      toRat_eq_mul_unit (rule := policy.rule) v.remaining_allowance_scale,
      toRat_eq_mul_unit (rule := policy.rule) v.carryingRemaining_scale,
      v.remaining_basis_coeff, v.remaining_allowance_coeff, v.carryingRemaining_coeff]
    push_cast; ring

/-- The cumulative amounts already consumed before `beforeFraction`, the consumed movement, and
the remaining budget add up to the supplied basis, allowance, and carrying value. -/
theorem allocateInventoryPostedValue_conservation_from_before
    {supplied : InventoryPostedValueBudget} {beforeFraction afterFraction : ExactRational}
    {policy : QuantizationPolicy} {alloc : InventoryPostedValueAllocation}
    (hS : supplied.WF) (hb : beforeFraction.WF) (ha : afterFraction.WF)
    (h : allocateInventoryPostedValue supplied beforeFraction afterFraction policy =
      .ok (.allocated alloc)) :
    (alloc.carryingProof.beforeQuantization.amount.toRat +
        alloc.allowanceProof.beforeQuantization.amount.toRat) +
        alloc.consumed.basis.toRat + alloc.remaining.basis.toRat = supplied.basis.toRat ∧
      (-alloc.allowanceProof.beforeQuantization.amount.toRat) +
        alloc.consumed.allowance.toRat + alloc.remaining.allowance.toRat =
        supplied.allowance.toRat ∧
      alloc.carryingProof.beforeQuantization.amount.toRat +
        alloc.carryingConsumed.toRat + alloc.carryingRemaining.toRat = supplied.carryingRat := by
  have v := allocated_view hS hb ha h
  refine ⟨?_, ?_, ?_⟩
  · rw [toRat_eq_mul_unit (rule := policy.rule) v.c0_scale,
      toRat_eq_mul_unit (rule := policy.rule) v.a0_scale,
      toRat_eq_mul_unit (rule := policy.rule) v.consumed_basis_scale,
      toRat_eq_mul_unit (rule := policy.rule) v.remaining_basis_scale,
      v.consumed_basis_coeff, v.remaining_basis_coeff, v.basis_rat]
    unfold QuantizationRule.unit
    rw [show policy.rule.targetScale = policy.targetScale from rfl]
    push_cast; ring
  · rw [toRat_eq_mul_unit (rule := policy.rule) v.a0_scale,
      toRat_eq_mul_unit (rule := policy.rule) v.consumed_allowance_scale,
      toRat_eq_mul_unit (rule := policy.rule) v.remaining_allowance_scale,
      v.consumed_allowance_coeff, v.remaining_allowance_coeff, v.allowance_rat]
    unfold QuantizationRule.unit
    rw [show policy.rule.targetScale = policy.targetScale from rfl]
    push_cast; ring
  · rw [toRat_eq_mul_unit (rule := policy.rule) v.c0_scale,
      toRat_eq_mul_unit (rule := policy.rule) v.carryingConsumed_scale,
      toRat_eq_mul_unit (rule := policy.rule) v.carryingRemaining_scale,
      v.carryingConsumed_coeff, v.carryingRemaining_coeff, v.carrying_rat]
    unfold QuantizationRule.unit
    rw [show policy.rule.targetScale = policy.targetScale from rfl]
    push_cast; ring

/-- Consumed plus remaining equals supplied if and only if both before-fraction cumulative
quantizations are zero (so it can fail when `beforeFraction` is positive). -/
theorem allocateInventoryPostedValue_conservation_iff
    {supplied : InventoryPostedValueBudget} {beforeFraction afterFraction : ExactRational}
    {policy : QuantizationPolicy} {alloc : InventoryPostedValueAllocation}
    (hS : supplied.WF) (hb : beforeFraction.WF) (ha : afterFraction.WF)
    (h : allocateInventoryPostedValue supplied beforeFraction afterFraction policy =
      .ok (.allocated alloc)) :
    (alloc.consumed.basis.toRat + alloc.remaining.basis.toRat = supplied.basis.toRat ∧
        alloc.consumed.allowance.toRat + alloc.remaining.allowance.toRat =
          supplied.allowance.toRat) ↔
      (alloc.carryingProof.beforeQuantization.amount.coefficient = 0 ∧
        alloc.allowanceProof.beforeQuantization.amount.coefficient = 0) := by
  have v := allocated_view hS hb ha h
  obtain ⟨hc1, hc2, -⟩ := allocateInventoryPostedValue_conservation_from_before hS hb ha h
  rw [toRat_eq_mul_unit (rule := policy.rule) v.c0_scale,
    toRat_eq_mul_unit (rule := policy.rule) v.a0_scale] at hc1
  rw [toRat_eq_mul_unit (rule := policy.rule) v.a0_scale] at hc2
  have hu := policy.rule.unit_pos
  have hcb := v.c_bounds.1
  have hab := v.a_bounds.1
  constructor
  · rintro ⟨h1, h2⟩
    have hsum0 : ((alloc.carryingProof.beforeQuantization.amount.coefficient : ℚ) +
        alloc.allowanceProof.beforeQuantization.amount.coefficient) * policy.rule.unit = 0 := by
      linarith
    have h0q : (alloc.carryingProof.beforeQuantization.amount.coefficient : ℚ) +
        alloc.allowanceProof.beforeQuantization.amount.coefficient = 0 :=
      (mul_eq_zero.mp hsum0).resolve_right hu.ne'
    have h0z : alloc.carryingProof.beforeQuantization.amount.coefficient +
        alloc.allowanceProof.beforeQuantization.amount.coefficient = 0 := by
      exact_mod_cast h0q
    exact ⟨by omega, by omega⟩
  · rintro ⟨hc0, ha0⟩
    rw [hc0, ha0] at hc1
    rw [ha0] at hc2
    simp only [Int.cast_zero, zero_mul, add_zero, neg_zero, zero_add] at hc1 hc2
    exact ⟨hc1, hc2⟩

/-- When the before-fraction is zero, consumed plus remaining equals supplied for basis,
allowance, and carrying value. -/
theorem allocateInventoryPostedValue_conservation_of_zero_before
    {supplied : InventoryPostedValueBudget} {beforeFraction afterFraction : ExactRational}
    {policy : QuantizationPolicy} {alloc : InventoryPostedValueAllocation}
    (hS : supplied.WF) (hb : beforeFraction.WF) (ha : afterFraction.WF)
    (hb0 : beforeFraction.toRat = 0)
    (h : allocateInventoryPostedValue supplied beforeFraction afterFraction policy =
      .ok (.allocated alloc)) :
    alloc.consumed.basis.toRat + alloc.remaining.basis.toRat = supplied.basis.toRat ∧
      alloc.consumed.allowance.toRat + alloc.remaining.allowance.toRat = supplied.allowance.toRat ∧
      alloc.carryingConsumed.toRat + alloc.carryingRemaining.toRat = supplied.carryingRat := by
  have v := allocated_view hS hb ha h
  obtain ⟨hca, hcc, hc3⟩ := allocateInventoryPostedValue_conservation_from_before hS hb ha h
  obtain ⟨hruleA, -⟩ := QuantizationPolicy.quantizeCumulativePostedShare_quantized_iff.mp v.allowance_share
  obtain ⟨hruleC, -⟩ := QuantizationPolicy.quantizeCumulativePostedShare_quantized_iff.mp v.carrying_share
  obtain ⟨tA, -, -, htA, -, -, -, -, -, -, -, hbtA, -, hbqA, -⟩ :=
    quantizeCumulativePostedShare_quantized hruleA
  obtain ⟨tC, -, -, htC, -, -, -, -, -, -, -, hbtC, -, hbqC, -⟩ :=
    quantizeCumulativePostedShare_quantized hruleC
  obtain ⟨htAwf, -⟩ := ExactDecimal.toRational_ok v.allowanceProof_total_wf htA
  obtain ⟨htCwf, -⟩ := ExactDecimal.toRational_ok v.carryingProof_total_wf htC
  obtain ⟨hbtAwf, hbtAtr⟩ := ExactRational.multiply_ok htAwf hb hbtA
  obtain ⟨hbtCwf, hbtCtr⟩ := ExactRational.multiply_ok htCwf hb hbtC
  have hqA := quantize_representable hbtAwf hbqA (c := 0) (by rw [hbtAtr, hb0, mul_zero]; simp)
  have hqC := quantize_representable hbtCwf hbqC (c := 0) (by rw [hbtCtr, hb0, mul_zero]; simp)
  have ha0 : alloc.allowanceProof.beforeQuantization.amount.toRat = 0 :=
    hqA.2.1.trans (by rw [hbtAtr, hb0, mul_zero])
  have hc0 : alloc.carryingProof.beforeQuantization.amount.toRat = 0 :=
    hqC.2.1.trans (by rw [hbtCtr, hb0, mul_zero])
  rw [ha0, hc0] at hca
  rw [hc0] at hc3
  rw [ha0] at hcc
  exact ⟨by linarith, by linarith, by linarith⟩

/-- Allowance parts are nonpositive, and consumed and remaining basis and carrying amounts are
nonnegative. -/
theorem allocateInventoryPostedValue_signs {supplied : InventoryPostedValueBudget}
    {beforeFraction afterFraction : ExactRational} {policy : QuantizationPolicy}
    {alloc : InventoryPostedValueAllocation}
    (hS : supplied.WF) (hb : beforeFraction.WF) (ha : afterFraction.WF)
    (h : allocateInventoryPostedValue supplied beforeFraction afterFraction policy =
      .ok (.allocated alloc)) :
    alloc.consumed.allowance.toRat ≤ 0 ∧ alloc.remaining.allowance.toRat ≤ 0 ∧
      0 ≤ alloc.consumed.basis.toRat ∧ 0 ≤ alloc.remaining.basis.toRat ∧
      0 ≤ alloc.carryingConsumed.toRat ∧ 0 ≤ alloc.carryingRemaining.toRat := by
  have v := allocated_view hS hb ha h
  obtain ⟨ha0, ha1, hale⟩ := v.a_bounds
  obtain ⟨hc0, hc1, hcle⟩ := v.c_bounds
  have hu := policy.rule.unit_pos.le
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_⟩
  · rw [toRat_eq_mul_unit (rule := policy.rule) v.consumed_allowance_scale, v.consumed_allowance_coeff]
    exact mul_nonpos_of_nonpos_of_nonneg (by exact_mod_cast (by omega : -(alloc.allowanceProof.afterQuantization.amount.coefficient - alloc.allowanceProof.beforeQuantization.amount.coefficient) ≤ 0)) hu
  · rw [toRat_eq_mul_unit (rule := policy.rule) v.remaining_allowance_scale, v.remaining_allowance_coeff]
    exact mul_nonpos_of_nonpos_of_nonneg (by exact_mod_cast (by omega : -(alloc.allowanceProof.postedTotal.coefficient - alloc.allowanceProof.afterQuantization.amount.coefficient) ≤ 0)) hu
  · rw [toRat_eq_mul_unit (rule := policy.rule) v.consumed_basis_scale, v.consumed_basis_coeff]
    exact mul_nonneg (by exact_mod_cast (by omega : 0 ≤ (alloc.carryingProof.afterQuantization.amount.coefficient - alloc.carryingProof.beforeQuantization.amount.coefficient) + (alloc.allowanceProof.afterQuantization.amount.coefficient - alloc.allowanceProof.beforeQuantization.amount.coefficient))) hu
  · rw [toRat_eq_mul_unit (rule := policy.rule) v.remaining_basis_scale, v.remaining_basis_coeff]
    exact mul_nonneg (by exact_mod_cast (by omega : 0 ≤ (alloc.carryingProof.postedTotal.coefficient - alloc.carryingProof.afterQuantization.amount.coefficient) + (alloc.allowanceProof.postedTotal.coefficient - alloc.allowanceProof.afterQuantization.amount.coefficient))) hu
  · rw [toRat_eq_mul_unit (rule := policy.rule) v.carryingConsumed_scale, v.carryingConsumed_coeff]
    exact mul_nonneg (by exact_mod_cast (by omega : 0 ≤ alloc.carryingProof.afterQuantization.amount.coefficient - alloc.carryingProof.beforeQuantization.amount.coefficient)) hu
  · rw [toRat_eq_mul_unit (rule := policy.rule) v.carryingRemaining_scale, v.carryingRemaining_coeff]
    exact mul_nonneg (by exact_mod_cast (by omega : 0 ≤ alloc.carryingProof.postedTotal.coefficient - alloc.carryingProof.afterQuantization.amount.coefficient)) hu

/-- At terminal depletion (`afterFraction = 1`), the remaining basis, allowance, and carrying
amounts are all zero. -/
theorem allocateInventoryPostedValue_terminal {supplied : InventoryPostedValueBudget}
    {beforeFraction afterFraction : ExactRational} {policy : QuantizationPolicy}
    {alloc : InventoryPostedValueAllocation}
    (hS : supplied.WF) (hb : beforeFraction.WF) (ha : afterFraction.WF)
    (ha1 : afterFraction.toRat = 1)
    (h : allocateInventoryPostedValue supplied beforeFraction afterFraction policy =
      .ok (.allocated alloc)) :
    alloc.remaining.basis.toRat = 0 ∧ alloc.remaining.allowance.toRat = 0 ∧
      alloc.carryingRemaining.toRat = 0 := by
  have v := allocated_view hS hb ha h
  obtain ⟨hruleA, -⟩ := QuantizationPolicy.quantizeCumulativePostedShare_quantized_iff.mp v.allowance_share
  obtain ⟨hruleC, -⟩ := QuantizationPolicy.quantizeCumulativePostedShare_quantized_iff.mp v.carrying_share
  obtain ⟨tA, -, -, htA, -, -, -, -, -, -, -, -, hatA, -, haqA, -⟩ :=
    quantizeCumulativePostedShare_quantized hruleA
  obtain ⟨tC, -, -, htC, -, -, -, -, -, -, -, -, hatC, -, haqC, -⟩ :=
    quantizeCumulativePostedShare_quantized hruleC
  obtain ⟨htAwf, htAtr⟩ := ExactDecimal.toRational_ok v.allowanceProof_total_wf htA
  obtain ⟨htCwf, htCtr⟩ := ExactDecimal.toRational_ok v.carryingProof_total_wf htC
  obtain ⟨hatAwf, hatAtr⟩ := ExactRational.multiply_ok htAwf ha hatA
  obtain ⟨hatCwf, hatCtr⟩ := ExactRational.multiply_ok htCwf ha hatC
  have hcA : alloc.allowanceProof.toShare.afterTarget.toRat =
      alloc.allowanceProof.postedTotal.coefficient / 10 ^ policy.rule.targetScale.toNat := by
    rw [hatAtr, ha1, mul_one, htAtr]
    unfold ExactDecimal.toRat
    rw [show alloc.allowanceProof.postedTotal.scale = policy.rule.targetScale from v.allowanceProof_total_scale]
  have hcC : alloc.carryingProof.toShare.afterTarget.toRat =
      alloc.carryingProof.postedTotal.coefficient / 10 ^ policy.rule.targetScale.toNat := by
    rw [hatCtr, ha1, mul_one, htCtr]
    unfold ExactDecimal.toRat
    rw [show alloc.carryingProof.postedTotal.scale = policy.rule.targetScale from v.carryingProof_total_scale]
  have hqa1 := (quantize_representable hatAwf haqA hcA).1
  have hqc1 := (quantize_representable hatCwf haqC hcC).1
  refine ⟨?_, ?_, ?_⟩
  · rw [toRat_eq_mul_unit (rule := policy.rule) v.remaining_basis_scale, v.remaining_basis_coeff]
    change (((alloc.carryingProof.postedTotal.coefficient - alloc.carryingProof.toShare.afterQuantization.amount.coefficient) +
      (alloc.allowanceProof.postedTotal.coefficient - alloc.allowanceProof.toShare.afterQuantization.amount.coefficient) : Int) : ℚ) * policy.rule.unit = 0
    rw [hqc1, hqa1]; simp
  · rw [toRat_eq_mul_unit (rule := policy.rule) v.remaining_allowance_scale, v.remaining_allowance_coeff]
    change (-((alloc.allowanceProof.postedTotal.coefficient - alloc.allowanceProof.toShare.afterQuantization.amount.coefficient : Int)) : ℚ) * policy.rule.unit = 0
    rw [hqa1]; simp
  · rw [toRat_eq_mul_unit (rule := policy.rule) v.carryingRemaining_scale, v.carryingRemaining_coeff]
    change (((alloc.carryingProof.postedTotal.coefficient - alloc.carryingProof.toShare.afterQuantization.amount.coefficient : Int)) : ℚ) * policy.rule.unit = 0
    rw [hqc1]; simp

/-- Full single-step depletion (`beforeFraction = 0` and `afterFraction = 1`) consumes each posted
component exactly and leaves zero remaining. -/
theorem allocateInventoryPostedValue_terminal_from_zero {supplied : InventoryPostedValueBudget}
    {beforeFraction afterFraction : ExactRational} {policy : QuantizationPolicy}
    {alloc : InventoryPostedValueAllocation}
    (hS : supplied.WF) (hb : beforeFraction.WF) (ha : afterFraction.WF)
    (hb0 : beforeFraction.toRat = 0) (ha1 : afterFraction.toRat = 1)
    (h : allocateInventoryPostedValue supplied beforeFraction afterFraction policy =
      .ok (.allocated alloc)) :
    alloc.consumed.basis.toRat = supplied.basis.toRat ∧
      alloc.consumed.allowance.toRat = supplied.allowance.toRat ∧
      alloc.carryingConsumed.toRat = supplied.carryingRat ∧
      alloc.remaining.basis.toRat = 0 ∧ alloc.remaining.allowance.toRat = 0 ∧
      alloc.carryingRemaining.toRat = 0 := by
  obtain ⟨hc1, hc2, hc3⟩ := allocateInventoryPostedValue_conservation_of_zero_before hS hb ha hb0 h
  obtain ⟨hr1, hr2, hr3⟩ := allocateInventoryPostedValue_terminal hS hb ha ha1 h
  exact ⟨by linarith, by linarith, by linarith, hr1, hr2, hr3⟩

/-- An empty fraction interval (`beforeFraction = afterFraction`) consumes nothing. -/
theorem allocateInventoryPostedValue_empty_slice {supplied : InventoryPostedValueBudget}
    {beforeFraction afterFraction : ExactRational} {policy : QuantizationPolicy}
    {alloc : InventoryPostedValueAllocation}
    (hS : supplied.WF) (hb : beforeFraction.WF) (ha : afterFraction.WF)
    (heq : beforeFraction.toRat = afterFraction.toRat)
    (h : allocateInventoryPostedValue supplied beforeFraction afterFraction policy =
      .ok (.allocated alloc)) :
    alloc.consumed.basis.toRat = 0 ∧ alloc.consumed.allowance.toRat = 0 ∧
      alloc.carryingConsumed.toRat = 0 := by
  have v := allocated_view hS hb ha h
  obtain ⟨hruleA, -⟩ := QuantizationPolicy.quantizeCumulativePostedShare_quantized_iff.mp v.allowance_share
  obtain ⟨hruleC, -⟩ := QuantizationPolicy.quantizeCumulativePostedShare_quantized_iff.mp v.carrying_share
  obtain ⟨tA, -, -, htA, -, -, -, -, -, -, -, hbtA, hatA, hbqA, haqA, -⟩ :=
    quantizeCumulativePostedShare_quantized hruleA
  obtain ⟨tC, -, -, htC, -, -, -, -, -, -, -, hbtC, hatC, hbqC, haqC, -⟩ :=
    quantizeCumulativePostedShare_quantized hruleC
  obtain ⟨htAwf, -⟩ := ExactDecimal.toRational_ok v.allowanceProof_total_wf htA
  obtain ⟨htCwf, -⟩ := ExactDecimal.toRational_ok v.carryingProof_total_wf htC
  obtain ⟨hbtAwf, hbtAtr⟩ := ExactRational.multiply_ok htAwf hb hbtA
  obtain ⟨hatAwf, hatAtr⟩ := ExactRational.multiply_ok htAwf ha hatA
  obtain ⟨hbtCwf, hbtCtr⟩ := ExactRational.multiply_ok htCwf hb hbtC
  obtain ⟨hatCwf, hatCtr⟩ := ExactRational.multiply_ok htCwf ha hatC
  have hAtarg : alloc.allowanceProof.toShare.beforeTarget = alloc.allowanceProof.toShare.afterTarget :=
    ExactRational.eq_of_toRat_eq hbtAwf hatAwf (by rw [hbtAtr, hatAtr, heq])
  have hCtarg : alloc.carryingProof.toShare.beforeTarget = alloc.carryingProof.toShare.afterTarget :=
    ExactRational.eq_of_toRat_eq hbtCwf hatCwf (by rw [hbtCtr, hatCtr, heq])
  rw [hAtarg] at hbqA
  rw [hCtarg] at hbqC
  have hAq : alloc.allowanceProof.toShare.beforeQuantization = alloc.allowanceProof.toShare.afterQuantization :=
    Except.ok.inj (hbqA.symm.trans haqA)
  have hCq : alloc.carryingProof.toShare.beforeQuantization = alloc.carryingProof.toShare.afterQuantization :=
    Except.ok.inj (hbqC.symm.trans haqC)
  have hAcoeff : alloc.allowanceProof.afterQuantization.amount.coefficient =
      alloc.allowanceProof.beforeQuantization.amount.coefficient := by
    have := congrArg (fun q => q.amount.coefficient) hAq; exact this.symm
  have hCcoeff : alloc.carryingProof.afterQuantization.amount.coefficient =
      alloc.carryingProof.beforeQuantization.amount.coefficient := by
    have := congrArg (fun q => q.amount.coefficient) hCq; exact this.symm
  refine ⟨?_, ?_, ?_⟩
  · rw [toRat_eq_mul_unit (rule := policy.rule) v.consumed_basis_scale, v.consumed_basis_coeff, hCcoeff, hAcoeff]
    simp
  · rw [toRat_eq_mul_unit (rule := policy.rule) v.consumed_allowance_scale, v.consumed_allowance_coeff, hAcoeff]
    simp
  · rw [toRat_eq_mul_unit (rule := policy.rule) v.carryingConsumed_scale, v.carryingConsumed_coeff, hCcoeff]
    simp

/-- The consumed carrying amount and the posted share of the allowance magnitude are each within
one unit of the policy's scale of their exact fraction shares (and consumed basis is within two
units). -/
theorem allocateInventoryPostedValue_within_one_unit
    {supplied : InventoryPostedValueBudget} {beforeFraction afterFraction : ExactRational}
    {policy : QuantizationPolicy} {alloc : InventoryPostedValueAllocation}
    (hS : supplied.WF) (hb : beforeFraction.WF) (ha : afterFraction.WF)
    (h : allocateInventoryPostedValue supplied beforeFraction afterFraction policy =
      .ok (.allocated alloc)) :
    |alloc.carryingConsumed.toRat -
        (afterFraction.toRat - beforeFraction.toRat) * supplied.carryingRat| ≤ policy.rule.unit ∧
      |alloc.allowanceProof.postedAmount.toRat -
          (afterFraction.toRat - beforeFraction.toRat) * (-supplied.allowance.toRat)| ≤
        policy.rule.unit ∧
      |alloc.consumed.allowance.toRat -
          (afterFraction.toRat - beforeFraction.toRat) * supplied.allowance.toRat| ≤
        policy.rule.unit ∧
      |alloc.consumed.basis.toRat -
          (afterFraction.toRat - beforeFraction.toRat) * supplied.basis.toRat| ≤
        2 * policy.rule.unit := by
  have v := allocated_view hS hb ha h
  have hC := (QuantizationPolicy.cumulativeShare_nonneg_and_within_one_unit
    v.carryingProof_total_wf hb ha v.carrying_share).2
  have hA := (QuantizationPolicy.cumulativeShare_nonneg_and_within_one_unit
    v.allowanceProof_total_wf hb ha v.allowance_share).2
  rw [v.carryingProof_total_rat] at hC
  rw [v.allowanceProof_total_rat] at hA
  have hcc : alloc.carryingConsumed.toRat = alloc.carryingProof.postedAmount.toRat := by
    rw [v.carryingConsumed_eq]
  have hca : alloc.consumed.allowance.toRat = -alloc.allowanceProof.postedAmount.toRat := by
    rw [v.consumed_allowance_eq, ExactDecimal.negate_toRat]
  have hc_eq := (allocateInventoryPostedValue_carrying_eq hS hb ha h).1
  have hcb_eq : alloc.consumed.basis.toRat = alloc.carryingConsumed.toRat - alloc.consumed.allowance.toRat := by
    unfold InventoryPostedValueBudget.carryingRat at hc_eq; linarith
  have hsb_eq : supplied.basis.toRat = supplied.carryingRat - supplied.allowance.toRat := by
    unfold InventoryPostedValueBudget.carryingRat; ring
  rw [← hcc] at hC
  have hA' : |alloc.consumed.allowance.toRat -
      (afterFraction.toRat - beforeFraction.toRat) * supplied.allowance.toRat| ≤ policy.rule.unit := by
    rw [hca, ← abs_neg]
    convert hA using 2
    ring
  refine ⟨hC, hA, hA', ?_⟩
  rw [hcb_eq, hsb_eq]
  have h1 := abs_le.mp hC
  have h2 := abs_le.mp hA'
  exact abs_le.mpr ⟨by linarith [h1.1, h2.2], by linarith [h1.2, h2.1]⟩

/-- In every mode other than half-even, the consumed carrying amount and allowance magnitude share
are strictly less than one unit from their exact shares (and consumed basis is strictly less than
two units). -/
theorem allocateInventoryPostedValue_lt_one_unit
    {supplied : InventoryPostedValueBudget} {beforeFraction afterFraction : ExactRational}
    {policy : QuantizationPolicy} {alloc : InventoryPostedValueAllocation}
    (hS : supplied.WF) (hb : beforeFraction.WF) (ha : afterFraction.WF)
    (hm : policy.roundingMode ≠ .halfEven)
    (h : allocateInventoryPostedValue supplied beforeFraction afterFraction policy =
      .ok (.allocated alloc)) :
    |alloc.carryingConsumed.toRat -
        (afterFraction.toRat - beforeFraction.toRat) * supplied.carryingRat| < policy.rule.unit ∧
      |alloc.allowanceProof.postedAmount.toRat -
          (afterFraction.toRat - beforeFraction.toRat) * (-supplied.allowance.toRat)| <
        policy.rule.unit ∧
      |alloc.consumed.allowance.toRat -
          (afterFraction.toRat - beforeFraction.toRat) * supplied.allowance.toRat| <
        policy.rule.unit ∧
      |alloc.consumed.basis.toRat -
          (afterFraction.toRat - beforeFraction.toRat) * supplied.basis.toRat| <
        2 * policy.rule.unit := by
  have v := allocated_view hS hb ha h
  have hC := cumulativeShare_lt_one_unit v.carryingProof_total_wf hb ha
    (QuantizationPolicy.quantizeCumulativePostedShare_quantized_iff.mp v.carrying_share).1 hm
  have hA := cumulativeShare_lt_one_unit v.allowanceProof_total_wf hb ha
    (QuantizationPolicy.quantizeCumulativePostedShare_quantized_iff.mp v.allowance_share).1 hm
  rw [v.carryingProof_total_rat] at hC
  rw [v.allowanceProof_total_rat] at hA
  change |alloc.carryingProof.postedAmount.toRat - _| < _ at hC
  change |alloc.allowanceProof.postedAmount.toRat - _| < _ at hA
  rw [← v.carryingConsumed_eq] at hC
  have hA' : |alloc.consumed.allowance.toRat -
      (afterFraction.toRat - beforeFraction.toRat) * supplied.allowance.toRat| < policy.rule.unit := by
    rw [v.consumed_allowance_eq, ExactDecimal.negate_toRat, ← abs_neg]
    convert hA using 2; ring
  have hc_eq := (allocateInventoryPostedValue_carrying_eq hS hb ha h).1
  have hcb_eq : alloc.consumed.basis.toRat = alloc.carryingConsumed.toRat - alloc.consumed.allowance.toRat := by
    unfold InventoryPostedValueBudget.carryingRat at hc_eq; linarith
  have hsb_eq : supplied.basis.toRat = supplied.carryingRat - supplied.allowance.toRat := by
    unfold InventoryPostedValueBudget.carryingRat; ring
  refine ⟨hC, hA, hA', ?_⟩
  rw [hcb_eq, hsb_eq]
  have h1 := abs_lt.mp hC
  have h2 := abs_lt.mp hA'
  exact abs_lt.mpr ⟨by linarith [h1.1, h2.2], by linarith [h1.2, h2.1]⟩

private theorem decimal_eq_of_toRat_scale {a b : ExactDecimal} (hr : a.toRat = b.toRat)
    (hs : a.scale = b.scale) : a = b := by
  unfold ExactDecimal.toRat at hr
  rw [hs] at hr
  have hpos : (0 : ℚ) < (10 : ℚ) ^ b.scale.toNat := by positivity
  have hq : (a.coefficient : ℚ) = (b.coefficient : ℚ) := (div_left_inj₀ hpos.ne').mp hr
  have hc : a.coefficient = b.coefficient := by exact_mod_cast hq
  cases a; cases b; simp_all

private theorem sum_map_neg {α : Type} (l : List α) (f : α → ℚ) :
    (l.map fun x => -f x).sum = -(l.map f).sum := by
  induction l with
  | nil => simp
  | cons x xs ih => simp [ih]; ring

private theorem sum_map_sub {α : Type} (l : List α) (f g : α → ℚ) :
    (l.map fun x => f x - g x).sum = (l.map f).sum - (l.map g).sum := by
  induction l with
  | nil => simp
  | cons x xs ih => simp [ih]; ring

/-- For cumulative fractions from zero through one passed with the original supplied budget, the
consumed carrying, allowance, and basis amounts across all steps add up to the supplied budget
exactly. -/
theorem allocateInventoryPostedValue_chain_sum {supplied : InventoryPostedValueBudget}
    {policy : QuantizationPolicy} (hS : supplied.WF) (fraction : Nat → ExactRational)
    (alloc : Nat → InventoryPostedValueAllocation) (n : Nat)
    (hf : ∀ i, i ≤ n → (fraction i).WF) (h0 : (fraction 0).toRat = 0)
    (h1 : (fraction n).toRat = 1)
    (h : ∀ i, i < n →
      allocateInventoryPostedValue supplied (fraction i) (fraction (i + 1)) policy =
        .ok (.allocated (alloc i))) :
    ((List.range n).map fun i => (alloc i).carryingConsumed.toRat).sum = supplied.carryingRat ∧
      ((List.range n).map fun i => (alloc i).consumed.allowance.toRat).sum =
        supplied.allowance.toRat ∧
      ((List.range n).map fun i => (alloc i).consumed.basis.toRat).sum = supplied.basis.toRat := by
  cases n with
  | zero => exact absurd (h0.symm.trans h1) (by norm_num)
  | succ m =>
    have v0 := allocated_view hS (hf 0 (by omega)) (hf 1 (by omega)) (h 0 (by omega))
    have hC_eq : ∀ i, i < m + 1 →
        (alloc i).carryingProof.postedTotal = (alloc 0).carryingProof.postedTotal := by
      intro i hi
      have vi := allocated_view hS (hf i (by omega)) (hf (i + 1) (by omega)) (h i hi)
      exact decimal_eq_of_toRat_scale (vi.carryingProof_total_rat.trans v0.carryingProof_total_rat.symm)
        (vi.carryingProof_total_scale.trans v0.carryingProof_total_scale.symm)
    have hA_eq : ∀ i, i < m + 1 →
        (alloc i).allowanceProof.postedTotal = (alloc 0).allowanceProof.postedTotal := by
      intro i hi
      have vi := allocated_view hS (hf i (by omega)) (hf (i + 1) (by omega)) (h i hi)
      exact decimal_eq_of_toRat_scale (vi.allowanceProof_total_rat.trans v0.allowanceProof_total_rat.symm)
        (vi.allowanceProof_total_scale.trans v0.allowanceProof_total_scale.symm)
    have hsumC := QuantizationPolicy.cumulativeShares_sum v0.carryingProof_total_wf fraction
      (fun i => (alloc i).carryingProof) (m + 1) hf h0 h1 fun i hi => by
        rw [← hC_eq i hi]
        exact (allocated_view hS (hf i (by omega)) (hf (i + 1) (by omega)) (h i hi)).carrying_share
    have hsumA := QuantizationPolicy.cumulativeShares_sum v0.allowanceProof_total_wf fraction
      (fun i => (alloc i).allowanceProof) (m + 1) hf h0 h1 fun i hi => by
        rw [← hA_eq i hi]
        exact (allocated_view hS (hf i (by omega)) (hf (i + 1) (by omega)) (h i hi)).allowance_share
    rw [v0.carryingProof_total_rat] at hsumC
    rw [v0.allowanceProof_total_rat] at hsumA
    have hcCons : ((List.range (m + 1)).map fun i => (alloc i).carryingConsumed.toRat) =
        (List.range (m + 1)).map fun i => (alloc i).carryingProof.postedAmount.toRat :=
      List.map_congr_left fun i hi => by
        have hi' := List.mem_range.mp hi
        have vi := allocated_view hS (hf i (by omega)) (hf (i + 1) (by omega)) (h i hi')
        rw [vi.carryingConsumed_eq]
    have haCons : ((List.range (m + 1)).map fun i => (alloc i).consumed.allowance.toRat) =
        (List.range (m + 1)).map fun i => -(alloc i).allowanceProof.postedAmount.toRat :=
      List.map_congr_left fun i hi => by
        have hi' := List.mem_range.mp hi
        have vi := allocated_view hS (hf i (by omega)) (hf (i + 1) (by omega)) (h i hi')
        rw [vi.consumed_allowance_eq, ExactDecimal.negate_toRat]
    have hbCons : ((List.range (m + 1)).map fun i => (alloc i).consumed.basis.toRat) =
        (List.range (m + 1)).map fun i =>
          (alloc i).carryingConsumed.toRat - (alloc i).consumed.allowance.toRat :=
      List.map_congr_left fun i hi => by
        have hi' := List.mem_range.mp hi
        have hc := (allocateInventoryPostedValue_carrying_eq hS (hf i (by omega))
          (hf (i + 1) (by omega)) (h i hi')).1
        unfold InventoryPostedValueBudget.carryingRat at hc
        linarith
    have h1' : ((List.range (m + 1)).map fun i => (alloc i).carryingConsumed.toRat).sum =
        supplied.carryingRat := by rw [hcCons, hsumC]
    have h2' : ((List.range (m + 1)).map fun i => (alloc i).consumed.allowance.toRat).sum =
        supplied.allowance.toRat := by
      rw [haCons, sum_map_neg, hsumA, neg_neg]
    have h3' : ((List.range (m + 1)).map fun i => (alloc i).consumed.basis.toRat).sum =
        supplied.basis.toRat := by
      rw [hbCons, sum_map_sub, h1', h2']
      unfold InventoryPostedValueBudget.carryingRat; ring
    exact ⟨h1', h2', h3'⟩

/-- At every step `k` along a cumulative fraction chain starting at zero, the consumed amounts
through step `k` plus step `k`'s remaining amounts equal the supplied budget. -/
theorem allocateInventoryPostedValue_chain_prefix {supplied : InventoryPostedValueBudget}
    {policy : QuantizationPolicy} (hS : supplied.WF) (fraction : Nat → ExactRational)
    (alloc : Nat → InventoryPostedValueAllocation) (n k : Nat) (hk : k < n)
    (hf : ∀ i, i ≤ n → (fraction i).WF) (h0 : (fraction 0).toRat = 0)
    (h : ∀ i, i < n →
      allocateInventoryPostedValue supplied (fraction i) (fraction (i + 1)) policy =
        .ok (.allocated (alloc i))) :
    ((List.range (k + 1)).map fun i => (alloc i).carryingConsumed.toRat).sum +
        (alloc k).carryingRemaining.toRat = supplied.carryingRat ∧
      ((List.range (k + 1)).map fun i => (alloc i).consumed.allowance.toRat).sum +
        (alloc k).remaining.allowance.toRat = supplied.allowance.toRat ∧
      ((List.range (k + 1)).map fun i => (alloc i).consumed.basis.toRat).sum +
        (alloc k).remaining.basis.toRat = supplied.basis.toRat := by
  induction k with
  | zero =>
    rw [show List.range (0 + 1) = [0] from rfl]
    simp only [List.map_cons, List.map_nil, List.sum_cons, List.sum_nil, add_zero]
    have hcons := allocateInventoryPostedValue_conservation_of_zero_before hS
      (hf 0 (by omega)) (hf 1 (by omega)) h0 (h 0 hk)
    exact ⟨hcons.2.2, hcons.2.1, hcons.1⟩
  | succ j ih =>
    obtain ⟨ihC, ihA, ihB⟩ := ih (by omega)
    have vj := allocated_view hS (hf j (by omega)) (hf (j + 1) (by omega)) (h j (by omega))
    have vs := allocated_view hS (hf (j + 1) (by omega)) (hf (j + 2) (by omega)) (h (j + 1) hk)
    have hC_eq : (alloc (j + 1)).carryingProof.postedTotal = (alloc j).carryingProof.postedTotal :=
      decimal_eq_of_toRat_scale (vs.carryingProof_total_rat.trans vj.carryingProof_total_rat.symm)
        (vs.carryingProof_total_scale.trans vj.carryingProof_total_scale.symm)
    have hA_eq : (alloc (j + 1)).allowanceProof.postedTotal = (alloc j).allowanceProof.postedTotal :=
      decimal_eq_of_toRat_scale (vs.allowanceProof_total_rat.trans vj.allowanceProof_total_rat.symm)
        (vs.allowanceProof_total_scale.trans vj.allowanceProof_total_scale.symm)
    have hqC_j := (QuantizationPolicy.quantizeCumulativePostedShare_quantized_iff.mp vj.carrying_share).1
    have hqC_s := (QuantizationPolicy.quantizeCumulativePostedShare_quantized_iff.mp vs.carrying_share).1
    rw [hC_eq] at hqC_s
    obtain ⟨tC1, -, -, htC1, -, -, -, -, -, -, -, -, hatC1, -, haqC1, -⟩ :=
      quantizeCumulativePostedShare_quantized hqC_j
    obtain ⟨tC2, -, -, htC2, -, -, -, -, -, -, -, hbtC2, -, hbqC2, -⟩ :=
      quantizeCumulativePostedShare_quantized hqC_s
    have htCeq : tC2 = tC1 := Except.ok.inj (htC2.symm.trans htC1)
    rw [htCeq] at hbtC2
    have hCtarg : (alloc (j + 1)).carryingProof.toShare.beforeTarget =
        (alloc j).carryingProof.toShare.afterTarget := Except.ok.inj (hbtC2.symm.trans hatC1)
    rw [hCtarg] at hbqC2
    have hCq : (alloc (j + 1)).carryingProof.beforeQuantization =
        (alloc j).carryingProof.afterQuantization := Except.ok.inj (hbqC2.symm.trans haqC1)
    have hqA_j := (QuantizationPolicy.quantizeCumulativePostedShare_quantized_iff.mp vj.allowance_share).1
    have hqA_s := (QuantizationPolicy.quantizeCumulativePostedShare_quantized_iff.mp vs.allowance_share).1
    rw [hA_eq] at hqA_s
    obtain ⟨tA1, -, -, htA1, -, -, -, -, -, -, -, -, hatA1, -, haqA1, -⟩ :=
      quantizeCumulativePostedShare_quantized hqA_j
    obtain ⟨tA2, -, -, htA2, -, -, -, -, -, -, -, hbtA2, -, hbqA2, -⟩ :=
      quantizeCumulativePostedShare_quantized hqA_s
    have htAeq : tA2 = tA1 := Except.ok.inj (htA2.symm.trans htA1)
    rw [htAeq] at hbtA2
    have hAtarg : (alloc (j + 1)).allowanceProof.toShare.beforeTarget =
        (alloc j).allowanceProof.toShare.afterTarget := Except.ok.inj (hbtA2.symm.trans hatA1)
    rw [hAtarg] at hbqA2
    have hAq : (alloc (j + 1)).allowanceProof.beforeQuantization =
        (alloc j).allowanceProof.afterQuantization := Except.ok.inj (hbqA2.symm.trans haqA1)
    obtain ⟨hsB, hsA, hsC⟩ := allocateInventoryPostedValue_conservation_from_before hS
      (hf (j + 1) (by omega)) (hf (j + 2) (by omega)) (h (j + 1) hk)
    have hlinkC : (alloc j).carryingRemaining.toRat +
        (alloc (j + 1)).carryingProof.beforeQuantization.amount.toRat = supplied.carryingRat := by
      rw [hCq, toRat_eq_mul_unit (rule := policy.rule) vj.carryingRemaining_scale,
        toRat_eq_mul_unit (rule := policy.rule) vj.c1_scale, vj.carryingRemaining_coeff,
        vj.carrying_rat]
      unfold QuantizationRule.unit
      rw [show policy.rule.targetScale = policy.targetScale from rfl]
      push_cast; ring
    have hlinkA : (alloc j).remaining.allowance.toRat +
        (-((alloc (j + 1)).allowanceProof.beforeQuantization.amount.toRat)) =
        supplied.allowance.toRat := by
      rw [hAq, toRat_eq_mul_unit (rule := policy.rule) vj.remaining_allowance_scale,
        toRat_eq_mul_unit (rule := policy.rule) vj.a1_scale, vj.remaining_allowance_coeff,
        vj.allowance_rat]
      unfold QuantizationRule.unit
      rw [show policy.rule.targetScale = policy.targetScale from rfl]
      push_cast; ring
    have hlinkB : (alloc j).remaining.basis.toRat +
        ((alloc (j + 1)).carryingProof.beforeQuantization.amount.toRat +
          (alloc (j + 1)).allowanceProof.beforeQuantization.amount.toRat) = supplied.basis.toRat := by
      rw [hCq, hAq, toRat_eq_mul_unit (rule := policy.rule) vj.remaining_basis_scale,
        toRat_eq_mul_unit (rule := policy.rule) vj.c1_scale,
        toRat_eq_mul_unit (rule := policy.rule) vj.a1_scale, vj.remaining_basis_coeff,
        vj.basis_rat]
      unfold QuantizationRule.unit
      rw [show policy.rule.targetScale = policy.targetScale from rfl]
      push_cast; ring
    rw [List.range_succ (n := j + 1)]
    simp only [List.map_append, List.map_cons, List.map_nil, List.sum_append, List.sum_cons,
      List.sum_nil, add_zero]
    exact ⟨by linarith, by linarith, by linarith⟩

private theorem budget_cond_iff {supplied : InventoryPostedValueBudget}
    {beforeFraction afterFraction : ExactRational} {policy : QuantizationPolicy}
    {basisShare : PolicyCumulativePostedShare}
    {allowRat basisRat carryRat : ExactRational} {allowanceQ carryingQ : QuantizedValue}
    (hS : supplied.WF) (hb : beforeFraction.WF) (ha : afterFraction.WF)
    (hbasis : policy.quantizeCumulativePostedShare supplied.basis beforeFraction afterFraction =
      .ok (.quantized basisShare))
    (har : supplied.allowance.toRational = .ok allowRat)
    (haq : quantize allowRat policy.rule = .ok allowanceQ)
    (hbr : supplied.basis.toRational = .ok basisRat)
    (hcr : basisRat.add allowRat = .ok carryRat)
    (hcq : quantize carryRat policy.rule = .ok carryingQ) :
    (supplied.allowance.coefficient > 0 ∨ allowanceQ.residual.isZero = false ∨
        carryingQ.residual.isZero = false ∨ carryingQ.amount.coefficient < 0) ↔
      (0 < supplied.allowance.toRat ∨
        ¬ (∃ c : Int, supplied.allowance.toRat = c / 10 ^ policy.targetScale.toNat) ∨
        supplied.carryingRat < 0) := by
  obtain ⟨-, -, -, -, -, -, cB, hB⟩ := basis_share_facts hS.basis_wf hb ha hbasis
  obtain ⟨harwf, hartr⟩ := ExactDecimal.toRational_ok hS.allowance_wf har
  obtain ⟨hawf, harwf', has, -, harestr⟩ := quantize_ok harwf haq
  obtain ⟨hbrwf, hbrtr⟩ := ExactDecimal.toRational_ok hS.basis_wf hbr
  obtain ⟨hcrwf, hcrtr⟩ := ExactRational.add_ok hbrwf harwf hcr
  obtain ⟨hcwf, hcrwf', hcs, -, hcrestr⟩ := quantize_ok hcrwf hcq
  have hpos_iff : supplied.allowance.coefficient > 0 ↔ 0 < supplied.allowance.toRat := by
    unfold ExactDecimal.toRat
    rw [lt_div_iff₀ (by positivity), zero_mul]
    exact_mod_cast Iff.rfl
  have hrep_iff : allowanceQ.residual.isZero = false ↔
      ¬ (∃ c : Int, supplied.allowance.toRat = c / 10 ^ policy.targetScale.toNat) := by
    constructor
    · intro hnz ⟨c, hc⟩
      have hq := (quantize_representable harwf haq (c := c) (by rw [hartr]; exact hc)).2.2.2
      rw [hq] at hnz
      cases hnz
    · intro hnot
      by_contra hz
      have hzt : allowanceQ.residual.isZero = true := Bool.eq_true_of_not_eq_false hz
      have hzr := (ExactRational.isZero_iff harwf').mp hzt
      apply hnot
      refine ⟨allowanceQ.amount.coefficient, ?_⟩
      have haeq : allowanceQ.amount.toRat = supplied.allowance.toRat := by linarith
      rw [← haeq]
      unfold ExactDecimal.toRat
      rw [show allowanceQ.amount.scale = policy.targetScale from has]
  constructor
  · rintro (hp | hnr | hcrnz | hcn)
    · exact Or.inl (hpos_iff.mp hp)
    · exact Or.inr (Or.inl (hrep_iff.mp hnr))
    · by_cases hrz : allowanceQ.residual.isZero = false
      · exact Or.inr (Or.inl (hrep_iff.mp hrz))
      · exfalso
        obtain ⟨cA, hcA⟩ := not_not.mp ((not_congr hrep_iff).mp hrz)
        have hsum : carryRat.toRat = (cB + cA : Int) / 10 ^ policy.rule.targetScale.toNat := by
          rw [hcrtr, hbrtr, hartr, hB, hcA, show policy.rule.targetScale = policy.targetScale from rfl]
          push_cast; ring
        have hq := (quantize_representable hcrwf hcq hsum).2.2.2
        rw [hq] at hcrnz; cases hcrnz
    · by_cases hrz : allowanceQ.residual.isZero = false
      · exact Or.inr (Or.inl (hrep_iff.mp hrz))
      · right; right
        obtain ⟨cA, hcA⟩ := not_not.mp ((not_congr hrep_iff).mp hrz)
        have hsum : carryRat.toRat = (cB + cA : Int) / 10 ^ policy.rule.targetScale.toNat := by
          rw [hcrtr, hbrtr, hartr, hB, hcA, show policy.rule.targetScale = policy.targetScale from rfl]
          push_cast; ring
        have hq := (quantize_representable hcrwf hcq hsum).2.1
        have hct : carryingQ.amount.toRat < 0 := by
          unfold ExactDecimal.toRat
          exact div_neg_of_neg_of_pos (by exact_mod_cast hcn) (by positivity)
        unfold InventoryPostedValueBudget.carryingRat
        linarith
  · rintro (hp | hnot | hneg)
    · exact Or.inl (hpos_iff.mpr hp)
    · exact Or.inr (Or.inl (hrep_iff.mpr hnot))
    · by_cases hrz : allowanceQ.residual.isZero = false
      · exact Or.inr (Or.inl hrz)
      · right; right; right
        obtain ⟨cA, hcA⟩ := not_not.mp ((not_congr hrep_iff).mp hrz)
        have hsum : carryRat.toRat = (cB + cA : Int) / 10 ^ policy.rule.targetScale.toNat := by
          rw [hcrtr, hbrtr, hartr, hB, hcA, show policy.rule.targetScale = policy.targetScale from rfl]
          push_cast; ring
        have hq := (quantize_representable hcrwf hcq hsum).2.1
        have hct : carryingQ.amount.toRat < 0 := by
          unfold InventoryPostedValueBudget.carryingRat at hneg
          linarith
        unfold ExactDecimal.toRat at hct
        have : (carryingQ.amount.coefficient : ℚ) < 0 := by
          by_contra hc
          have hnn : 0 ≤ carryingQ.amount.toRat := by
            unfold ExactDecimal.toRat
            exact div_nonneg (not_lt.mp hc) (by positivity)
          linarith [show carryingQ.amount.toRat = (carryingQ.amount.coefficient : ℚ) / 10 ^ carryingQ.amount.scale.toNat from rfl]
        exact_mod_cast this

/-- An allocation is rejected exactly when the cumulative basis share is rejected, or when the
basis share and budget quantizations succeed and the allowance is positive, the allowance is not
representable in the policy, or the net carrying value is negative. -/
theorem allocateInventoryPostedValue_rejected_iff {supplied : InventoryPostedValueBudget}
    {beforeFraction afterFraction : ExactRational} {policy : QuantizationPolicy}
    {rejection : ValueRejection}
    (hS : supplied.WF) (hb : beforeFraction.WF) (ha : afterFraction.WF) :
    allocateInventoryPostedValue supplied beforeFraction afterFraction policy =
        .ok (.rejected rejection) ↔
      ((policy.targetScale < 0 ∨ maxDecimalScale < policy.targetScale ∨
          supplied.basis.toRat < 0 ∨ beforeFraction.toRat < 0 ∨
          afterFraction.toRat < beforeFraction.toRat ∨ 1 < afterFraction.toRat) ∧
        rejection.diagnostics = [shareInvalidDiagnostic]) ∨
      (0 ≤ policy.targetScale ∧ policy.targetScale ≤ maxDecimalScale ∧
        0 ≤ supplied.basis.toRat ∧ 0 ≤ beforeFraction.toRat ∧
        beforeFraction.toRat ≤ afterFraction.toRat ∧ afterFraction.toRat ≤ 1 ∧
        (∃ total normalizedTotal, supplied.basis.toRational = .ok total ∧
          quantize total policy.rule = .ok normalizedTotal) ∧
        ¬ (∃ c : Int, supplied.basis.toRat = c / 10 ^ policy.targetScale.toNat) ∧
        rejection.diagnostics = [shareTotalDiagnostic]) ∨
      ((∃ basisShare, policy.quantizeCumulativePostedShare supplied.basis beforeFraction
          afterFraction = .ok (.quantized basisShare)) ∧
        (∃ allowRat allowanceQ basisRat carryRat carryingQ,
          supplied.allowance.toRational = .ok allowRat ∧
          quantize allowRat policy.rule = .ok allowanceQ ∧
          supplied.basis.toRational = .ok basisRat ∧
          basisRat.add allowRat = .ok carryRat ∧
          quantize carryRat policy.rule = .ok carryingQ) ∧
        (0 < supplied.allowance.toRat ∨
          ¬ (∃ c : Int, supplied.allowance.toRat = c / 10 ^ policy.targetScale.toNat) ∨
          supplied.carryingRat < 0) ∧
        rejection.diagnostics = [budgetRejectionDiagnostic]) := by
  constructor
  · intro h
    unfold allocateInventoryPostedValue at h
    split at h
    · cases h
    · rename_i diagnostics hrej
      cases h
      rcases QuantizationPolicy.quantizeCumulativePostedShare_rejected_diagnostic hrej with
        rfl | rfl
      · exact Or.inl ⟨(QuantizationPolicy.quantizeCumulativePostedShare_invalid_iff
          hS.basis_wf hb ha).mp hrej, rfl⟩
      · exact Or.inr (Or.inl ⟨(QuantizationPolicy.quantizeCumulativePostedShare_total_iff
          hS.basis_wf hb ha).mp hrej |>.1,
          (QuantizationPolicy.quantizeCumulativePostedShare_total_iff hS.basis_wf hb ha).mp hrej |>.2.1,
          (QuantizationPolicy.quantizeCumulativePostedShare_total_iff hS.basis_wf hb ha).mp hrej |>.2.2.1,
          (QuantizationPolicy.quantizeCumulativePostedShare_total_iff hS.basis_wf hb ha).mp hrej |>.2.2.2.1,
          (QuantizationPolicy.quantizeCumulativePostedShare_total_iff hS.basis_wf hb ha).mp hrej |>.2.2.2.2.1,
          (QuantizationPolicy.quantizeCumulativePostedShare_total_iff hS.basis_wf hb ha).mp hrej |>.2.2.2.2.2.1,
          (QuantizationPolicy.quantizeCumulativePostedShare_total_iff hS.basis_wf hb ha).mp hrej |>.2.2.2.2.2.2.1,
          (QuantizationPolicy.quantizeCumulativePostedShare_total_iff hS.basis_wf hb ha).mp hrej |>.2.2.2.2.2.2.2,
          rfl⟩)
    · rename_i basisShare hbasis
      split at h
      · cases h
      · rename_i allowRat har
        split at h
        · cases h
        · rename_i allowanceQ haq
          split at h
          · cases h
          · rename_i basisRat hbr
            split at h
            · cases h
            · rename_i allowRat2 har2
              split at h
              · cases h
              · rename_i carryRat hcr
                split at h
                · cases h
                · rename_i carryingQ hcq
                  split at h
                  · rename_i hchk
                    cases h
                    cases har2
                    have hiff := (budget_cond_iff hS hb ha hbasis (liftExact_eq_ok har) haq
                      (liftExact_eq_ok hbr) (liftExact_eq_ok hcr) hcq).mp hchk
                    exact Or.inr (Or.inr ⟨⟨basisShare, hbasis⟩,
                      ⟨allowRat, allowanceQ, basisRat, carryRat, carryingQ,
                        liftExact_eq_ok har, haq, liftExact_eq_ok hbr, liftExact_eq_ok hcr, hcq⟩,
                      hiff, rfl⟩)
                  · split at h
                    · cases h
                    · split at h
                      · cases h
                      · split at h
                        · cases h
                        · dsimp only at h
                          split at h
                          · cases h
                          · split at h
                            · cases h
                            · split at h
                              · cases h
                              · cases h
  · rintro (⟨hc, hd⟩ | ⟨h0, h1, h2, h3, h4, h5, h6, h7, hd⟩ |
      ⟨⟨basisShare, hbasis⟩, ⟨allowRat, allowanceQ, basisRat, carryRat, carryingQ,
        har, haq, hbr, hcr, hcq⟩, hcond, hd⟩)
    · have hrej := (QuantizationPolicy.quantizeCumulativePostedShare_invalid_iff
        hS.basis_wf hb ha).mpr hc
      unfold allocateInventoryPostedValue
      rw [hrej]
      cases rejection; simp only at hd; simp [hd]
    · have hrej := (QuantizationPolicy.quantizeCumulativePostedShare_total_iff
        hS.basis_wf hb ha).mpr ⟨h0, h1, h2, h3, h4, h5, h6, h7⟩
      unfold allocateInventoryPostedValue
      rw [hrej]
      cases rejection; simp only at hd; simp [hd]
    · have hchk := (budget_cond_iff hS hb ha hbasis har haq hbr hcr hcq).mpr hcond
      unfold allocateInventoryPostedValue
      rw [hbasis]
      dsimp only
      rw [show liftExact supplied.allowance.toRational = .ok allowRat by rw [har]; rfl]
      dsimp only
      rw [haq]
      dsimp only
      rw [show liftExact supplied.basis.toRational = .ok basisRat by rw [hbr]; rfl]
      dsimp only
      rw [show liftExact (basisRat.add allowRat) = .ok carryRat by rw [hcr]; rfl]
      dsimp only
      rw [hcq]
      dsimp only
      rw [ite_eq_left hchk]
      cases rejection; simp only at hd; simp [hd, reject, budgetRejectionDiagnostic]

/-- Every rejection from `allocateInventoryPostedValue` carries exactly one diagnostic, for one
of the three stated reasons. -/
theorem allocateInventoryPostedValue_rejected_diagnostic {supplied : InventoryPostedValueBudget}
    {beforeFraction afterFraction : ExactRational} {policy : QuantizationPolicy}
    {rejection : ValueRejection}
    (hS : supplied.WF) (hb : beforeFraction.WF) (ha : afterFraction.WF)
    (h : allocateInventoryPostedValue supplied beforeFraction afterFraction policy =
      .ok (.rejected rejection)) :
    rejection.diagnostics = [shareInvalidDiagnostic] ∨
      rejection.diagnostics = [shareTotalDiagnostic] ∨
      rejection.diagnostics = [budgetRejectionDiagnostic] := by
  rcases (allocateInventoryPostedValue_rejected_iff hS hb ha).mp h with
    ⟨-, hd⟩ | ⟨-, -, -, -, -, -, -, -, hd⟩ | ⟨-, -, -, hd⟩
  · exact Or.inl hd
  · exact Or.inr (Or.inl hd)
  · exact Or.inr (Or.inr hd)

/-- When allocating constructible numbers throws, it is only for exceeding the size limit. -/
theorem allocateInventoryPostedValue_error {supplied : InventoryPostedValueBudget}
    {beforeFraction afterFraction : ExactRational} {policy : QuantizationPolicy}
    {e : QuantizeErr}
    (hS : supplied.WF) (hb : beforeFraction.WF) (ha : afterFraction.WF)
    (h : allocateInventoryPostedValue supplied beforeFraction afterFraction policy = .error e) :
    e = .exactNumber .representationLimitExceeded := by
  unfold allocateInventoryPostedValue at h
  split at h
  · rename_i e' hq
    cases h
    exact quantizeCumulativePostedShare_error hS.basis_wf hb ha
      (QuantizationPolicy.quantizeCumulativePostedShare_error_iff.mp hq)
  · cases h
  · rename_i basisShare hbasis
    obtain ⟨h0, h1, -⟩ := basis_share_facts hS.basis_wf hb ha hbasis
    split at h
    · rename_i e' har
      cases h
      obtain ⟨code, hcode, -⟩ := liftExact_eq_error har
      exact absurd hcode (ExactDecimal.toRational_ne_error hS.allowance_wf code)
    · rename_i allowRat har
      obtain ⟨harwf, -⟩ := ExactDecimal.toRational_ok hS.allowance_wf (liftExact_eq_ok har)
      split at h
      · rename_i e' haq
        cases h
        exact quantize_error harwf h0 h1 haq
      · rename_i allowanceQ haq
        obtain ⟨hawf, -, has, -, -⟩ := quantize_ok harwf haq
        split at h
        · rename_i e' hbr
          cases h
          obtain ⟨code, hcode, -⟩ := liftExact_eq_error hbr
          exact absurd hcode (ExactDecimal.toRational_ne_error hS.basis_wf code)
        · rename_i basisRat hbr
          obtain ⟨hbrwf, -⟩ := ExactDecimal.toRational_ok hS.basis_wf (liftExact_eq_ok hbr)
          split at h
          · rename_i har2; cases har2
          · rename_i allowRat2 har2
            cases har2
            split at h
            · rename_i e' hcr
              cases h
              obtain ⟨code, hcode, rfl⟩ := liftExact_eq_error hcr
              rcases ExactRational.add_ok_or_limit hbrwf harwf with ⟨c, hc⟩ | hlim
              · rw [hc] at hcode; cases hcode
              · rw [hlim] at hcode; cases hcode; rfl
            · rename_i carryRat hcr
              obtain ⟨hcrwf, -⟩ := ExactRational.add_ok hbrwf harwf (liftExact_eq_ok hcr)
              split at h
              · rename_i e' hcq
                cases h
                exact quantize_error hcrwf h0 h1 hcq
              · rename_i carryingQ hcq
                obtain ⟨hcwf, -, -, -, -⟩ := quantize_ok hcrwf hcq
                split at h
                · cases h
                · split at h
                  · rename_i e' hsh
                    cases h
                    exact share_error (ExactDecimal.negate_wf hawf) hb ha h0 h1 hsh
                  · split at h
                    · rename_i e' hsh
                      cases h
                      exact share_error hcwf hb ha h0 h1 hsh
                    · split at h
                      · rename_i e' hof
                        cases h
                        obtain ⟨code, hcode, rfl⟩ := liftExact_eq_error hof
                        rw [decimal_of_error h0 h1 hcode]
                      · dsimp only at h
                        split at h
                        · rename_i e' hof
                          cases h
                          obtain ⟨code, hcode, rfl⟩ := liftExact_eq_error hof
                          rw [decimal_of_error h0 h1 hcode]
                        · split at h
                          · rename_i e' hof
                            cases h
                            obtain ⟨code, hcode, rfl⟩ := liftExact_eq_error hof
                            rw [decimal_of_error h0 h1 hcode]
                          · split at h
                            · rename_i e' hof
                              cases h
                              obtain ⟨code, hcode, rfl⟩ := liftExact_eq_error hof
                              rw [decimal_of_error h0 h1 hcode]
                            · cases h

/-! ## Helpers for `adjustInventoryPostedAllowance` -/

private theorem allowance_guard1_iff {economics : InventoryEconomicValue}
    {economicCarrying : ExactRational}
    (hE : economics.WF) (hEC : economics.basis.add economics.allowance = .ok economicCarrying) :
    (economics.basis.isNegative = true ∨
        economics.allowance.compare ExactRational.zero = .gt ∨
        economicCarrying.isNegative = true) ↔
      (economics.basis.toRat < 0 ∨ 0 < economics.allowance.toRat ∨ economics.carryingRat < 0) := by
  obtain ⟨hecwf, hectr⟩ := ExactRational.add_ok hE.basis_wf hE.allowance_wf hEC
  rw [ExactRational.isNegative_iff hE.basis_wf,
    ExactRational.compare_gt_iff hE.allowance_wf ExactRational.zero_wf,
    ExactRational.isNegative_iff hecwf, ExactRational.zero_toRat, hectr]
  rfl

private theorem allowance_guard2_iff {economics : InventoryEconomicValue}
    {kind : InventoryAllowanceChangeKind} {economicChange afterAllowance afterCarrying : ExactRational}
    (hE : economics.WF) (hChange : economicChange.WF)
    (hAA : economics.allowance.add economicChange = .ok afterAllowance)
    (hAC : economics.basis.add afterAllowance = .ok afterCarrying) :
    (afterCarrying.isNegative = true ∨ afterAllowance.compare ExactRational.zero = .gt ∨
        (kind = .writeDown ∧ economicChange.compare ExactRational.zero ≠ .lt) ∨
        (kind = .writeDownReversal ∧ economicChange.compare ExactRational.zero ≠ .gt)) ↔
      (economics.carryingRat + economicChange.toRat < 0 ∨
        0 < economics.allowance.toRat + economicChange.toRat ∨
        (kind = .writeDown ∧ 0 ≤ economicChange.toRat) ∨
        (kind = .writeDownReversal ∧ economicChange.toRat ≤ 0)) := by
  obtain ⟨haawf, haatr⟩ := ExactRational.add_ok hE.allowance_wf hChange hAA
  obtain ⟨hacwf, hactr⟩ := ExactRational.add_ok hE.basis_wf haawf hAC
  simp only [ne_eq]
  rw [ExactRational.isNegative_iff hacwf,
    ExactRational.compare_gt_iff haawf ExactRational.zero_wf,
    ExactRational.compare_lt_iff hChange ExactRational.zero_wf,
    ExactRational.compare_gt_iff hChange ExactRational.zero_wf,
    ExactRational.zero_toRat, hactr, haatr]
  simp only [InventoryEconomicValue.carryingRat, add_assoc, not_lt]

/-! ## The share of `adjustInventoryPostedAllowance`: a share from zero -/

/-- A share from zero of a nonnegative total, under a fraction from zero through one: it is the
cumulative share of the total from zero to that fraction, its posted amount is between zero and
the total, within one unit of the exact share, and the whole total when the fraction is one. -/
private theorem share_from_zero {total : ExactDecimal} {fraction : ExactRational}
    {policy : QuantizationPolicy} {sh : PolicyCumulativePostedShare}
    (hT : total.WF) (hs : total.scale = policy.targetScale) (hf : fraction.WF)
    (h0 : 0 ≤ policy.targetScale) (h1 : policy.targetScale ≤ maxDecimalScale)
    (ht0 : 0 ≤ total.toRat) (hf0 : 0 ≤ fraction.toRat) (hf1 : fraction.toRat ≤ 1)
    (h : share total ExactRational.zero fraction policy = .ok sh) :
    sh.postedAmount.WF ∧ sh.postedAmount.scale = policy.targetScale ∧
      sh.postedTotal = total ∧ sh.beforeFraction = ExactRational.zero ∧
      sh.afterFraction = fraction ∧ sh.policy = policy ∧
      policy.quantizeCumulativePostedShare total ExactRational.zero fraction =
        .ok (.quantized sh) ∧
      0 ≤ sh.postedAmount.toRat ∧ sh.postedAmount.toRat ≤ total.toRat ∧
      |sh.postedAmount.toRat - fraction.toRat * total.toRat| ≤ policy.rule.unit ∧
      (policy.roundingMode ≠ .halfEven →
        |sh.postedAmount.toRat - fraction.toRat * total.toRat| < policy.rule.unit) ∧
      (fraction.toRat = 1 → sh.postedAmount.toRat = total.toRat) := by
  obtain ⟨hpt, hbf, haf, hpp, hbtwf, hbttr, hatwf, hattr, hbq, haq, -, -, -, -, hpwf, hps, hpc, -⟩ :=
    share_ok hT ExactRational.zero_wf hf h
  have hb0 : (0 : ℚ) ≤ ExactRational.zero.toRat := by rw [ExactRational.zero_toRat]
  have hf0' : ExactRational.zero.toRat ≤ fraction.toRat := by
    rw [ExactRational.zero_toRat]; exact hf0
  have hbd := share_bounds hT hs ExactRational.zero_wf hf ht0 hb0 hf0' hf1 h
  have hq := share_eq_quantizeCumulativePostedShare hT hs ExactRational.zero_wf hf h0 h1 ht0 hb0
    hf0' hf1 h
  obtain ⟨hnn, hone⟩ := QuantizationPolicy.cumulativeShare_nonneg_and_within_one_unit hT
    ExactRational.zero_wf hf hq
  rw [ExactRational.zero_toRat, sub_zero] at hone
  have hu := policy.rule.unit_pos
  have hpa : sh.postedAmount.toRat = sh.postedAmount.coefficient * policy.rule.unit :=
    toRat_eq_mul_unit (rule := policy.rule) hps
  have htt : total.toRat = total.coefficient * policy.rule.unit :=
    toRat_eq_mul_unit (rule := policy.rule) hs
  have hle : sh.postedAmount.coefficient ≤ total.coefficient := by omega
  refine ⟨hpwf, hps, hpt, hbf, haf, hpp, hq, hnn, ?_, hone, ?_, ?_⟩
  · rw [hpa, htt]
    exact mul_le_mul_of_nonneg_right (by exact_mod_cast hle) hu.le
  · intro hm
    have hlt := cumulativeShare_lt_one_unit hT ExactRational.zero_wf hf
      (QuantizationPolicy.quantizeCumulativePostedShare_quantized_iff.mp hq).1 hm
    rw [ExactRational.zero_toRat, sub_zero] at hlt
    exact hlt
  · intro hf1'
    have hbq0 := (quantize_representable hbtwf hbq (c := 0)
      (by rw [hbttr, ExactRational.zero_toRat, mul_zero]; simp)).1
    have haq1 := (quantize_representable hatwf haq (c := total.coefficient)
      (by
        rw [hattr, hf1', mul_one]
        unfold ExactDecimal.toRat
        rw [hs]
        rfl)).1
    have hfull : sh.postedAmount.coefficient = total.coefficient := by
      rw [hpc, hbq0, haq1]
      simp
    rw [hpa, htt, hfull]

/-! ## What a successful `adjustInventoryPostedAllowance` was computed from -/

/-- The signed posted change of a share, as the model tests `kind = .writeDown`: a write-down
posts the negative of the share, a reversal the share. -/
private def InventoryAllowanceChangeKind.signed (kind : InventoryAllowanceChangeKind)
    (amount : ExactDecimal) : ExactDecimal :=
  if kind = .writeDown then amount.negate else amount

/-- An adjustment that was not rejected and did not throw: every step returned, and neither
rejection test fired. -/
private theorem adjusted_destruct {budget : InventoryPostedValueBudget}
    {economics : InventoryEconomicValue} {kind : InventoryAllowanceChangeKind}
    {economicChange : ExactRational} {policy : QuantizationPolicy}
    {change : InventoryAllowanceChange}
    (h : adjustInventoryPostedAllowance budget economics kind economicChange policy =
      .ok (.adjusted change)) :
    ∃ (cur : InventoryPostedValueAllocation) (economicCarrying afterAllowance afterCarrying
        fraction : ExactRational) (proof : PolicyCumulativePostedShare)
      (afterAllowanceDecimal : ExactDecimal) (postedChangeRat postedMinusEconomic : ExactRational),
      allocateInventoryPostedValue budget ExactRational.zero ExactRational.zero policy =
        .ok (.allocated cur) ∧
      economics.basis.add economics.allowance = .ok economicCarrying ∧
      economics.allowance.add economicChange = .ok afterAllowance ∧
      ¬ (economics.basis.isNegative = true ∨ economics.allowance.compare ExactRational.zero = .gt ∨
        economicCarrying.isNegative = true) ∧
      economics.basis.add afterAllowance = .ok afterCarrying ∧
      ¬ (afterCarrying.isNegative = true ∨ afterAllowance.compare ExactRational.zero = .gt ∨
        (kind = .writeDown ∧ economicChange.compare ExactRational.zero ≠ .lt) ∨
        (kind = .writeDownReversal ∧ economicChange.compare ExactRational.zero ≠ .gt)) ∧
      (if kind = .writeDown then economicChange.negate.divide economicCarrying
        else economicChange.divide economics.allowance.negate) = .ok fraction ∧
      share (if kind = .writeDown then cur.carryingRemaining else cur.remaining.allowance.negate)
        ExactRational.zero fraction cur.carryingProof.policy = .ok proof ∧
      ExactDecimal.of (cur.remaining.allowance.coefficient + (kind.signed proof.postedAmount).coefficient)
        cur.remaining.allowance.scale = .ok afterAllowanceDecimal ∧
      (kind.signed proof.postedAmount).toRational = .ok postedChangeRat ∧
      postedChangeRat.subtract economicChange = .ok postedMinusEconomic ∧
      change = { kind := kind, before := cur.remaining,
                 after := { basis := cur.remaining.basis, allowance := afterAllowanceDecimal },
                 economicChange := economicChange, postedChange := kind.signed proof.postedAmount,
                 postedMinusEconomic := postedMinusEconomic, proof := proof } := by
  unfold adjustInventoryPostedAllowance at h
  dsimp only at h
  split at h
  · cases h
  · cases h
  · rename_i cur hcur
    split at h
    · cases h
    · rename_i EC hEC
      split at h
      · cases h
      · rename_i AA hAA
        split at h
        · cases h
        · rename_i hg1
          split at h
          · cases h
          · rename_i AC hAC
            split at h
            · cases h
            · rename_i hg2
              split at h
              · cases h
              · rename_i fraction hfr
                split at h
                · cases h
                · rename_i proof hpr
                  split at h
                  · cases h
                  · rename_i ad had
                    split at h
                    · cases h
                    · rename_i pcr hpcr
                      split at h
                      · cases h
                      · rename_i pme hpme
                        cases h
                        exact ⟨cur, EC, AA, AC, fraction, proof, ad, pcr, pme, hcur,
                          liftExact_eq_ok hEC, liftExact_eq_ok hAA, hg1, liftExact_eq_ok hAC, hg2,
                          liftExact_eq_ok hfr, hpr, liftExact_eq_ok had, liftExact_eq_ok hpcr,
                          liftExact_eq_ok hpme, rfl⟩

/-! ## The fraction of an adjustment, and the allocation at the zero fraction -/

/-- A write-down's fraction: after the checks, the carrying value is positive, so the division is
by a positive number, and the fraction is the part of the economic carrying value written down,
which is more than zero and at most one. -/
private theorem adjust_down_fraction {economics : InventoryEconomicValue}
    {economicChange economicCarrying fraction : ExactRational}
    (hE : economics.WF) (hC : economicChange.WF)
    (hEC : economics.basis.add economics.allowance = .ok economicCarrying)
    (hneg : economicChange.toRat < 0)
    (hafter : 0 ≤ economics.carryingRat + economicChange.toRat)
    (hfr : economicChange.negate.divide economicCarrying = .ok fraction) :
    fraction.WF ∧ fraction.toRat = -economicChange.toRat / economics.carryingRat ∧
      0 < fraction.toRat ∧ fraction.toRat ≤ 1 := by
  obtain ⟨hECwf, hECtr⟩ := ExactRational.add_ok hE.basis_wf hE.allowance_wf hEC
  obtain ⟨hfwf, -, hftr⟩ := ExactRational.divide_ok (ExactRational.negate_wf hC) hECwf hfr
  rw [ExactRational.negate_toRat, hECtr] at hftr
  have hcar : economics.carryingRat = economics.basis.toRat + economics.allowance.toRat := rfl
  have hpos : 0 < economics.carryingRat := by linarith
  rw [← hcar] at hftr
  refine ⟨hfwf, hftr, ?_, ?_⟩
  · rw [hftr]
    exact div_pos (by linarith) hpos
  · rw [hftr, div_le_one hpos]
    linarith

/-- A reversal's fraction: after the checks, the remaining allowance is negative, so the division is
by a positive number, and the fraction is the part of it restored, which is more than zero and at
most one. -/
private theorem adjust_up_fraction {economics : InventoryEconomicValue}
    {economicChange fraction : ExactRational}
    (hE : economics.WF) (hC : economicChange.WF) (hpos : 0 < economicChange.toRat)
    (hafter : economics.allowance.toRat + economicChange.toRat ≤ 0)
    (hfr : economicChange.divide economics.allowance.negate = .ok fraction) :
    fraction.WF ∧ fraction.toRat = economicChange.toRat / -economics.allowance.toRat ∧
      0 < fraction.toRat ∧ fraction.toRat ≤ 1 := by
  obtain ⟨hfwf, -, hftr⟩ :=
    ExactRational.divide_ok hC (ExactRational.negate_wf hE.allowance_wf) hfr
  rw [ExactRational.negate_toRat] at hftr
  have hd : 0 < -economics.allowance.toRat := by linarith
  refine ⟨hfwf, hftr, ?_, ?_⟩
  · rw [hftr]
    exact div_pos hpos hd
  · rw [hftr, div_le_one hd]
    linarith

/-- Allocating a budget from the zero fraction to the zero fraction consumes nothing and leaves the
whole budget: the remaining basis, allowance and carrying value mean the supplied ones. -/
theorem allocateInventoryPostedValue_zero_fractions {supplied : InventoryPostedValueBudget}
    {policy : QuantizationPolicy} {alloc : InventoryPostedValueAllocation}
    (hS : supplied.WF)
    (h : allocateInventoryPostedValue supplied ExactRational.zero ExactRational.zero policy =
      .ok (.allocated alloc)) :
    alloc.consumed.basis.toRat = 0 ∧ alloc.consumed.allowance.toRat = 0 ∧
      alloc.carryingConsumed.toRat = 0 ∧ alloc.remaining.basis.toRat = supplied.basis.toRat ∧
      alloc.remaining.allowance.toRat = supplied.allowance.toRat ∧
      alloc.carryingRemaining.toRat = supplied.carryingRat := by
  obtain ⟨hc1, hc2, hc3⟩ := allocateInventoryPostedValue_conservation_of_zero_before hS
    ExactRational.zero_wf ExactRational.zero_wf ExactRational.zero_toRat h
  obtain ⟨he1, he2, he3⟩ := allocateInventoryPostedValue_empty_slice hS ExactRational.zero_wf
    ExactRational.zero_wf rfl h
  exact ⟨he1, he2, he3, by linarith, by linarith, by linarith⟩

/-- The signed posted change of a share is constructible at the share's scale, and is the negative
of the share for a write-down and the share for a reversal. -/
private theorem signed_facts (kind : InventoryAllowanceChangeKind) {amount : ExactDecimal}
    (h : amount.WF) :
    (kind.signed amount).WF ∧ (kind.signed amount).scale = amount.scale ∧
      (kind = .writeDown → (kind.signed amount).toRat = -amount.toRat) ∧
      (kind = .writeDownReversal → (kind.signed amount).toRat = amount.toRat) := by
  cases kind
  · exact ⟨ExactDecimal.negate_wf h, rfl, fun _ => ExactDecimal.negate_toRat amount,
      fun hk => absurd hk (by decide)⟩
  · exact ⟨h, rfl, fun hk => absurd hk (by decide), fun _ => rfl⟩

/-! ## Helpers for the laws of `adjustInventoryPostedAllowance` -/

private theorem kind_cases (kind : InventoryAllowanceChangeKind) :
    kind = .writeDown ∨ kind = .writeDownReversal := by
  cases kind
  · exact Or.inl rfl
  · exact Or.inr rfl

/-- The checks of an adjustment that did not fire, as meanings. -/
private theorem adjust_guard_facts {economics : InventoryEconomicValue}
    {kind : InventoryAllowanceChangeKind} {economicChange EC AA AC : ExactRational}
    (hE : economics.WF) (hC : economicChange.WF)
    (hEC : economics.basis.add economics.allowance = .ok EC)
    (hAA : economics.allowance.add economicChange = .ok AA)
    (hAC : economics.basis.add AA = .ok AC)
    (hg1 : ¬ (economics.basis.isNegative = true ∨
      economics.allowance.compare ExactRational.zero = .gt ∨ EC.isNegative = true))
    (hg2 : ¬ (AC.isNegative = true ∨ AA.compare ExactRational.zero = .gt ∨
      (kind = .writeDown ∧ economicChange.compare ExactRational.zero ≠ .lt) ∨
      (kind = .writeDownReversal ∧ economicChange.compare ExactRational.zero ≠ .gt))) :
    0 ≤ economics.basis.toRat ∧ economics.allowance.toRat ≤ 0 ∧ 0 ≤ economics.carryingRat ∧
      0 ≤ economics.carryingRat + economicChange.toRat ∧
      economics.allowance.toRat + economicChange.toRat ≤ 0 ∧
      (kind = .writeDown → economicChange.toRat < 0) ∧
      (kind = .writeDownReversal → 0 < economicChange.toRat) := by
  have hg1' := (not_congr (allowance_guard1_iff hE hEC)).mp hg1
  have hg2' := (not_congr (allowance_guard2_iff hE hC hAA hAC)).mp hg2
  push Not at hg1' hg2'
  exact ⟨hg1'.1, hg1'.2.1, hg1'.2.2, hg2'.1, hg2'.2.1, hg2'.2.2.1, hg2'.2.2.2⟩

/-- The division of an adjustment is never by zero once the checks have passed, so when it throws,
it is for size. -/
private theorem adjust_fraction_error {economics : InventoryEconomicValue}
    {kind : InventoryAllowanceChangeKind} {economicChange EC : ExactRational} {code : NumErr}
    (hE : economics.WF) (hC : economicChange.WF)
    (hEC : economics.basis.add economics.allowance = .ok EC)
    (hAc : 0 ≤ economics.carryingRat + economicChange.toRat)
    (hAa : economics.allowance.toRat + economicChange.toRat ≤ 0)
    (hdown : kind = .writeDown → economicChange.toRat < 0)
    (hup : kind = .writeDownReversal → 0 < economicChange.toRat)
    (h : (if kind = .writeDown then economicChange.negate.divide EC
      else economicChange.divide economics.allowance.negate) = .error code) :
    code = .representationLimitExceeded := by
  rcases kind_cases kind with hk | hk
  · subst hk
    have h' : economicChange.negate.divide EC = .error code := h
    obtain ⟨hECwf, hECtr⟩ := ExactRational.add_ok hE.basis_wf hE.allowance_wf hEC
    have hneg := hdown rfl
    have hpos : 0 < EC.toRat := by
      rw [hECtr]
      unfold InventoryEconomicValue.carryingRat at hAc
      linarith
    rcases ExactRational.divide_ok_or_error (ExactRational.negate_wf hC) (b := EC) with
      ⟨c, hc⟩ | ⟨hz, hc⟩ | ⟨-, hc⟩
    · rw [hc] at h'; cases h'
    · exact absurd (show EC.toRat = 0 by simp [ExactRational.toRat, hz]) hpos.ne'
    · rw [hc] at h'; cases h'; rfl
  · subst hk
    have h' : economicChange.divide economics.allowance.negate = .error code := h
    have hpos := hup rfl
    have hd : 0 < economics.allowance.negate.toRat := by
      rw [ExactRational.negate_toRat]
      linarith
    rcases ExactRational.divide_ok_or_error hC (b := economics.allowance.negate) with
      ⟨c, hc⟩ | ⟨hz, hc⟩ | ⟨-, hc⟩
    · rw [hc] at h'; cases h'
    · exact absurd (show economics.allowance.negate.toRat = 0 by simp [ExactRational.toRat, hz])
        hd.ne'
    · rw [hc] at h'; cases h'; rfl

/-- The total and the fraction of an adjustment's share, once the checks have passed: the total is
the posted carrying value (write-down) or the posted allowance made positive (reversal), and the
fraction is more than zero and at most one. -/
private theorem adjust_total_fraction {budget : InventoryPostedValueBudget}
    {economics : InventoryEconomicValue} {kind : InventoryAllowanceChangeKind}
    {economicChange EC fraction : ExactRational} {policy : QuantizationPolicy}
    {cur : InventoryPostedValueAllocation} {total : ExactDecimal}
    (hE : economics.WF) (hC : economicChange.WF)
    (v : AllocatedView budget ExactRational.zero ExactRational.zero policy cur)
    (hra : cur.remaining.allowance.toRat = budget.allowance.toRat)
    (hrc : cur.carryingRemaining.toRat = budget.carryingRat)
    (hEC : economics.basis.add economics.allowance = .ok EC)
    (hAc : 0 ≤ economics.carryingRat + economicChange.toRat)
    (hAa : economics.allowance.toRat + economicChange.toRat ≤ 0)
    (hdown : kind = .writeDown → economicChange.toRat < 0)
    (hup : kind = .writeDownReversal → 0 < economicChange.toRat)
    (htot : total =
      if kind = .writeDown then cur.carryingRemaining else cur.remaining.allowance.negate)
    (hfr : (if kind = .writeDown then economicChange.negate.divide EC
      else economicChange.divide economics.allowance.negate) = .ok fraction) :
    total.WF ∧ total.scale = policy.targetScale ∧ 0 ≤ total.toRat ∧
      fraction.WF ∧ 0 < fraction.toRat ∧ fraction.toRat ≤ 1 ∧
      (kind = .writeDown → total.toRat = budget.carryingRat ∧
        fraction.toRat = -economicChange.toRat / economics.carryingRat) ∧
      (kind = .writeDownReversal → total.toRat = -budget.allowance.toRat ∧
        fraction.toRat = economicChange.toRat / -economics.allowance.toRat) := by
  rcases kind_cases kind with hk | hk
  · subst hk
    have htot' : total = cur.carryingRemaining := htot
    have hfr' : economicChange.negate.divide EC = .ok fraction := hfr
    obtain ⟨hfwf, hfrat, hfpos, hfle⟩ := adjust_down_fraction hE hC hEC (hdown rfl) hAc hfr'
    subst htot'
    refine ⟨v.carryingRemaining_wf, v.carryingRemaining_scale, ?_, hfwf, hfpos, hfle,
      fun _ => ⟨hrc, hfrat⟩, fun hk => absurd hk (by decide)⟩
    rw [hrc]
    exact v.carrying_nonneg
  · subst hk
    have htot' : total = cur.remaining.allowance.negate := htot
    have hfr' : economicChange.divide economics.allowance.negate = .ok fraction := hfr
    obtain ⟨hfwf, hfrat, hfpos, hfle⟩ := adjust_up_fraction hE hC (hup rfl) hAa hfr'
    have hrw : cur.remaining.allowance.negate.toRat = -budget.allowance.toRat := by
      rw [ExactDecimal.negate_toRat, hra]
    subst htot'
    refine ⟨ExactDecimal.negate_wf v.remaining_wf.allowance_wf, v.remaining_allowance_scale, ?_,
      hfwf, hfpos, hfle, fun hk => absurd hk (by decide), fun _ => ⟨hrw, hfrat⟩⟩
    rw [hrw]
    linarith [v.allowance_nonpos]

/-! ## What every adjustment satisfies -/

/-- Everything the laws of `adjustInventoryPostedAllowance` need, about an adjustment that was not
rejected and did not throw. -/
private structure AdjustedView (budget : InventoryPostedValueBudget)
    (economics : InventoryEconomicValue) (kind : InventoryAllowanceChangeKind)
    (economicChange : ExactRational) (policy : QuantizationPolicy)
    (change : InventoryAllowanceChange) : Prop where
  scale_nonneg : 0 ≤ policy.targetScale
  scale_le : policy.targetScale ≤ maxDecimalScale
  kind_eq : change.kind = kind
  economicChange_eq : change.economicChange = economicChange
  basis_eq : change.after.basis = change.before.basis
  before_wf : change.before.WF
  before_basis_scale : change.before.basis.scale = policy.targetScale
  before_allowance_scale : change.before.allowance.scale = policy.targetScale
  before_basis_rat : change.before.basis.toRat = budget.basis.toRat
  before_allowance_rat : change.before.allowance.toRat = budget.allowance.toRat
  after_wf : change.after.WF
  after_allowance_scale : change.after.allowance.scale = policy.targetScale
  after_allowance_rat :
    change.after.allowance.toRat = change.before.allowance.toRat + change.postedChange.toRat
  postedChange_wf : change.postedChange.WF
  postedChange_scale : change.postedChange.scale = policy.targetScale
  postedMinusEconomic_wf : change.postedMinusEconomic.WF
  postedMinusEconomic_rat :
    change.postedMinusEconomic.toRat = change.postedChange.toRat - economicChange.toRat
  budget_basis_nonneg : 0 ≤ budget.basis.toRat
  budget_allowance_nonpos : budget.allowance.toRat ≤ 0
  budget_carrying_nonneg : 0 ≤ budget.carryingRat
  economic_basis_nonneg : 0 ≤ economics.basis.toRat
  economic_allowance_nonpos : economics.allowance.toRat ≤ 0
  economic_carrying_nonneg : 0 ≤ economics.carryingRat
  economic_after_carrying_nonneg : 0 ≤ economics.carryingRat + economicChange.toRat
  economic_after_allowance_nonpos : economics.allowance.toRat + economicChange.toRat ≤ 0
  down_sign : kind = .writeDown → economicChange.toRat < 0
  up_sign : kind = .writeDownReversal → 0 < economicChange.toRat
  proof_before : change.proof.beforeFraction = ExactRational.zero
  proof_policy : change.proof.policy = policy
  proof_total_wf : change.proof.postedTotal.WF
  proof_fraction_wf : change.proof.afterFraction.WF
  proof_share : policy.quantizeCumulativePostedShare change.proof.postedTotal
    ExactRational.zero change.proof.afterFraction = .ok (.quantized change.proof)
  proof_amount_nonneg : 0 ≤ change.proof.postedAmount.toRat
  proof_amount_le : change.proof.postedAmount.toRat ≤ change.proof.postedTotal.toRat
  proof_fraction_pos : 0 < change.proof.afterFraction.toRat
  proof_fraction_le : change.proof.afterFraction.toRat ≤ 1
  proof_within : |change.proof.postedAmount.toRat -
      change.proof.afterFraction.toRat * change.proof.postedTotal.toRat| ≤ policy.rule.unit
  proof_within_lt : policy.roundingMode ≠ .halfEven →
    |change.proof.postedAmount.toRat -
      change.proof.afterFraction.toRat * change.proof.postedTotal.toRat| < policy.rule.unit
  proof_full : change.proof.afterFraction.toRat = 1 →
    change.proof.postedAmount.toRat = change.proof.postedTotal.toRat
  down_data : kind = .writeDown →
    change.postedChange.toRat = -change.proof.postedAmount.toRat ∧
      change.proof.postedTotal.toRat = budget.carryingRat ∧
      change.proof.afterFraction.toRat = -economicChange.toRat / economics.carryingRat
  up_data : kind = .writeDownReversal →
    change.postedChange.toRat = change.proof.postedAmount.toRat ∧
      change.proof.postedTotal.toRat = -budget.allowance.toRat ∧
      change.proof.afterFraction.toRat = economicChange.toRat / -economics.allowance.toRat

/-- An adjustment that was not rejected and did not throw satisfies everything in its view. -/
private theorem adjusted_view {budget : InventoryPostedValueBudget}
    {economics : InventoryEconomicValue} {kind : InventoryAllowanceChangeKind}
    {economicChange : ExactRational} {policy : QuantizationPolicy}
    {change : InventoryAllowanceChange}
    (hB : budget.WF) (hE : economics.WF) (hC : economicChange.WF)
    (h : adjustInventoryPostedAllowance budget economics kind economicChange policy =
      .ok (.adjusted change)) :
    AdjustedView budget economics kind economicChange policy change := by
  obtain ⟨cur, EC, AA, AC, fraction, proof, ad, pcr, pme, hcur, hEC, hAA, hg1, hAC, hg2, hfr, hpr,
    had, hpcr, hpme, hchange⟩ := adjusted_destruct h
  subst hchange
  have v := allocated_view hB ExactRational.zero_wf ExactRational.zero_wf hcur
  obtain ⟨-, -, -, hrb, hra, hrc⟩ := allocateInventoryPostedValue_zero_fractions hB hcur
  rw [v.carrying_policy] at hpr
  obtain ⟨hEb, hEa, hEc, hAc, hAa, hdown, hup⟩ := adjust_guard_facts hE hC hEC hAA hAC hg1 hg2
  obtain ⟨htwf, hts, ht0, hfwf, hfpos, hfle, hdk, huk⟩ :=
    adjust_total_fraction hE hC v hra hrc hEC hAc hAa hdown hup rfl hfr
  obtain ⟨hpawf, hpas, hpt, hpb, hpa, hpp, hpq, hpnn, hple, hpw, hpwl, hpf⟩ :=
    share_from_zero htwf hts hfwf v.scale_nonneg v.scale_le ht0 hfpos.le hfle hpr
  obtain ⟨hscwf, hscs, hscd, hscu⟩ := signed_facts kind hpawf
  obtain ⟨hadwf, hadc, hads⟩ := ExactDecimal.of_ok had
  obtain ⟨hpcrwf, hpcrtr⟩ := ExactDecimal.toRational_ok hscwf hpcr
  obtain ⟨hpmewf, hpmetr⟩ := ExactRational.subtract_ok hpcrwf hC hpme
  have hadrat : ad.toRat =
      cur.remaining.allowance.toRat + (kind.signed proof.postedAmount).toRat := by
    rw [toRat_eq_mul_unit (rule := policy.rule) (hads.trans v.remaining_allowance_scale),
      toRat_eq_mul_unit (rule := policy.rule) v.remaining_allowance_scale,
      toRat_eq_mul_unit (rule := policy.rule) (hscs.trans hpas), hadc]
    push_cast
    ring
  have ftw : proof.postedTotal.WF := by rw [hpt]; exact htwf
  have ffw : proof.afterFraction.WF := by rw [hpa]; exact hfwf
  have fsh : policy.quantizeCumulativePostedShare proof.postedTotal ExactRational.zero
      proof.afterFraction = .ok (.quantized proof) := by rw [hpt, hpa]; exact hpq
  have fle : proof.postedAmount.toRat ≤ proof.postedTotal.toRat := by rw [hpt]; exact hple
  have ffp : 0 < proof.afterFraction.toRat := by rw [hpa]; exact hfpos
  have ffl : proof.afterFraction.toRat ≤ 1 := by rw [hpa]; exact hfle
  have fwi : |proof.postedAmount.toRat - proof.afterFraction.toRat * proof.postedTotal.toRat| ≤
      policy.rule.unit := by rw [hpt, hpa]; exact hpw
  have fwl : policy.roundingMode ≠ .halfEven →
      |proof.postedAmount.toRat - proof.afterFraction.toRat * proof.postedTotal.toRat| <
        policy.rule.unit := fun hm => by rw [hpt, hpa]; exact hpwl hm
  have ffu : proof.afterFraction.toRat = 1 → proof.postedAmount.toRat = proof.postedTotal.toRat :=
    fun h1 => by rw [hpt]; rw [hpa] at h1; exact hpf h1
  exact
    { scale_nonneg := v.scale_nonneg
      scale_le := v.scale_le
      kind_eq := rfl
      economicChange_eq := rfl
      basis_eq := rfl
      before_wf := v.remaining_wf
      before_basis_scale := v.remaining_basis_scale
      before_allowance_scale := v.remaining_allowance_scale
      before_basis_rat := hrb
      before_allowance_rat := hra
      after_wf := ⟨v.remaining_wf.basis_wf, hadwf⟩
      after_allowance_scale := hads.trans v.remaining_allowance_scale
      after_allowance_rat := hadrat
      postedChange_wf := hscwf
      postedChange_scale := hscs.trans hpas
      postedMinusEconomic_wf := hpmewf
      postedMinusEconomic_rat := by rw [hpmetr, hpcrtr]
      budget_basis_nonneg := v.basis_nonneg
      budget_allowance_nonpos := v.allowance_nonpos
      budget_carrying_nonneg := v.carrying_nonneg
      economic_basis_nonneg := hEb
      economic_allowance_nonpos := hEa
      economic_carrying_nonneg := hEc
      economic_after_carrying_nonneg := hAc
      economic_after_allowance_nonpos := hAa
      down_sign := hdown
      up_sign := hup
      proof_before := hpb
      proof_policy := hpp
      proof_total_wf := ftw
      proof_fraction_wf := ffw
      proof_share := fsh
      proof_amount_nonneg := hpnn
      proof_amount_le := fle
      proof_fraction_pos := ffp
      proof_fraction_le := ffl
      proof_within := fwi
      proof_within_lt := fwl
      proof_full := ffu
      down_data := fun hk => ⟨hscd hk, by rw [hpt]; exact (hdk hk).1,
        by rw [hpa]; exact (hdk hk).2⟩
      up_data := fun hk => ⟨hscu hk, by rw [hpt]; exact (huk hk).1,
        by rw [hpa]; exact (huk hk).2⟩ }

/-! ## Laws of `adjustInventoryPostedAllowance` -/

/-- After an adjustment, the carrying value is the supplied carrying value plus the posted change. -/
private theorem AdjustedView.after_carrying {budget : InventoryPostedValueBudget}
    {economics : InventoryEconomicValue} {kind : InventoryAllowanceChangeKind}
    {economicChange : ExactRational} {policy : QuantizationPolicy}
    {change : InventoryAllowanceChange}
    (v : AdjustedView budget economics kind economicChange policy change) :
    change.after.carryingRat = budget.carryingRat + change.postedChange.toRat := by
  unfold InventoryPostedValueBudget.carryingRat
  rw [v.basis_eq, v.after_allowance_rat, v.before_basis_rat, v.before_allowance_rat]
  ring

/-- Every amount of an adjustment is constructible and at the policy's scale. -/
theorem adjustInventoryPostedAllowance_wf {budget : InventoryPostedValueBudget}
    {economics : InventoryEconomicValue} {kind : InventoryAllowanceChangeKind}
    {economicChange : ExactRational} {policy : QuantizationPolicy}
    {change : InventoryAllowanceChange}
    (hB : budget.WF) (hE : economics.WF) (hC : economicChange.WF)
    (h : adjustInventoryPostedAllowance budget economics kind economicChange policy =
      .ok (.adjusted change)) :
    change.before.WF ∧ change.after.WF ∧ change.postedChange.WF ∧ change.postedMinusEconomic.WF ∧
      change.before.basis.scale = policy.targetScale ∧
      change.before.allowance.scale = policy.targetScale ∧
      change.after.basis.scale = policy.targetScale ∧
      change.after.allowance.scale = policy.targetScale ∧
      change.postedChange.scale = policy.targetScale := by
  have v := adjusted_view hB hE hC h
  exact ⟨v.before_wf, v.after_wf, v.postedChange_wf, v.postedMinusEconomic_wf,
    v.before_basis_scale, v.before_allowance_scale, by rw [v.basis_eq]; exact v.before_basis_scale,
    v.after_allowance_scale, v.postedChange_scale⟩

/-- An adjustment records the kind and the economic change it was given, changes only the
allowance, and does so exactly: the basis after is the basis before, the allowance after is the
allowance before plus the posted change, and the posted difference from the economic change is the
posted change less the economic change. -/
theorem adjustInventoryPostedAllowance_exact {budget : InventoryPostedValueBudget}
    {economics : InventoryEconomicValue} {kind : InventoryAllowanceChangeKind}
    {economicChange : ExactRational} {policy : QuantizationPolicy}
    {change : InventoryAllowanceChange}
    (hB : budget.WF) (hE : economics.WF) (hC : economicChange.WF)
    (h : adjustInventoryPostedAllowance budget economics kind economicChange policy =
      .ok (.adjusted change)) :
    change.kind = kind ∧ change.economicChange = economicChange ∧
      change.after.basis = change.before.basis ∧
      change.after.allowance.toRat = change.before.allowance.toRat + change.postedChange.toRat ∧
      change.postedMinusEconomic.toRat = change.postedChange.toRat - economicChange.toRat := by
  have v := adjusted_view hB hE hC h
  exact ⟨v.kind_eq, v.economicChange_eq, v.basis_eq, v.after_allowance_rat,
    v.postedMinusEconomic_rat⟩

/-- An adjustment starts from the supplied budget: its basis and allowance before mean the supplied
basis and allowance. -/
theorem adjustInventoryPostedAllowance_before {budget : InventoryPostedValueBudget}
    {economics : InventoryEconomicValue} {kind : InventoryAllowanceChangeKind}
    {economicChange : ExactRational} {policy : QuantizationPolicy}
    {change : InventoryAllowanceChange}
    (hB : budget.WF) (hE : economics.WF) (hC : economicChange.WF)
    (h : adjustInventoryPostedAllowance budget economics kind economicChange policy =
      .ok (.adjusted change)) :
    change.before.basis.toRat = budget.basis.toRat ∧
      change.before.allowance.toRat = budget.allowance.toRat := by
  have v := adjusted_view hB hE hC h
  exact ⟨v.before_basis_rat, v.before_allowance_rat⟩

/-- The posted change goes the way its kind says and never further than what is there: a write-down
is not positive and never writes down more than the carrying value, and a reversal is not negative
and never restores more than the remaining allowance. -/
theorem adjustInventoryPostedAllowance_posted_change_bounds
    {budget : InventoryPostedValueBudget} {economics : InventoryEconomicValue}
    {kind : InventoryAllowanceChangeKind} {economicChange : ExactRational}
    {policy : QuantizationPolicy} {change : InventoryAllowanceChange}
    (hB : budget.WF) (hE : economics.WF) (hC : economicChange.WF)
    (h : adjustInventoryPostedAllowance budget economics kind economicChange policy =
      .ok (.adjusted change)) :
    (kind = .writeDown →
      -budget.carryingRat ≤ change.postedChange.toRat ∧ change.postedChange.toRat ≤ 0) ∧
    (kind = .writeDownReversal →
      0 ≤ change.postedChange.toRat ∧ change.postedChange.toRat ≤ -budget.allowance.toRat) := by
  have v := adjusted_view hB hE hC h
  refine ⟨fun hk => ?_, fun hk => ?_⟩
  · obtain ⟨hpc, hpt, -⟩ := v.down_data hk
    have h1 := v.proof_amount_nonneg
    have h2 := v.proof_amount_le
    rw [hpt] at h2
    constructor <;> linarith
  · obtain ⟨hpc, hpt, -⟩ := v.up_data hk
    have h1 := v.proof_amount_nonneg
    have h2 := v.proof_amount_le
    rw [hpt] at h2
    constructor <;> linarith

/-- After an adjustment the allowance is never positive and the net carrying value is never
negative: a write-down never takes the allowance above zero, and a reversal never restores more than
the remaining allowance. -/
theorem adjustInventoryPostedAllowance_signs {budget : InventoryPostedValueBudget}
    {economics : InventoryEconomicValue} {kind : InventoryAllowanceChangeKind}
    {economicChange : ExactRational} {policy : QuantizationPolicy}
    {change : InventoryAllowanceChange}
    (hB : budget.WF) (hE : economics.WF) (hC : economicChange.WF)
    (h : adjustInventoryPostedAllowance budget economics kind economicChange policy =
      .ok (.adjusted change)) :
    change.after.allowance.toRat ≤ 0 ∧ 0 ≤ change.after.basis.toRat ∧
      0 ≤ change.after.carryingRat := by
  have v := adjusted_view hB hE hC h
  obtain ⟨hd, hu⟩ := adjustInventoryPostedAllowance_posted_change_bounds hB hE hC h
  have hcar := v.after_carrying
  have hbasis : change.after.basis.toRat = budget.basis.toRat := by
    rw [v.basis_eq]; exact v.before_basis_rat
  have hal : change.after.allowance.toRat = budget.allowance.toRat + change.postedChange.toRat := by
    rw [v.after_allowance_rat, v.before_allowance_rat]
  refine ⟨?_, by rw [hbasis]; exact v.budget_basis_nonneg, ?_⟩
  · rcases kind_cases kind with hk | hk
    · linarith [(hd hk).2, v.budget_allowance_nonpos]
    · linarith [(hu hk).2]
  · rcases kind_cases kind with hk | hk
    · linarith [(hd hk).1]
    · linarith [(hu hk).1, v.budget_carrying_nonneg]

/-- A write-down of the whole economic carrying value (the economic change is minus that value)
takes the posted net carrying value to exactly zero. -/
theorem adjustInventoryPostedAllowance_full_writeDown {budget : InventoryPostedValueBudget}
    {economics : InventoryEconomicValue} {kind : InventoryAllowanceChangeKind}
    {economicChange : ExactRational} {policy : QuantizationPolicy}
    {change : InventoryAllowanceChange}
    (hB : budget.WF) (hE : economics.WF) (hC : economicChange.WF)
    (h : adjustInventoryPostedAllowance budget economics kind economicChange policy =
      .ok (.adjusted change))
    (hk : kind = .writeDown) (hfull : economicChange.toRat = -economics.carryingRat) :
    change.after.carryingRat = 0 := by
  have v := adjusted_view hB hE hC h
  obtain ⟨hpc, hpt, hfr⟩ := v.down_data hk
  have hneg := v.down_sign hk
  have hpos : 0 < economics.carryingRat := by linarith
  have hone : change.proof.afterFraction.toRat = 1 := by
    rw [hfr, hfull, neg_neg, div_self hpos.ne']
  have hfp := v.proof_full hone
  rw [hpt] at hfp
  rw [v.after_carrying, hpc, hfp]
  ring

/-- A reversal of the whole economic allowance (the economic change is minus the allowance) takes
the posted allowance to exactly zero, so the carrying value is the posted basis. -/
theorem adjustInventoryPostedAllowance_full_reversal {budget : InventoryPostedValueBudget}
    {economics : InventoryEconomicValue} {kind : InventoryAllowanceChangeKind}
    {economicChange : ExactRational} {policy : QuantizationPolicy}
    {change : InventoryAllowanceChange}
    (hB : budget.WF) (hE : economics.WF) (hC : economicChange.WF)
    (h : adjustInventoryPostedAllowance budget economics kind economicChange policy =
      .ok (.adjusted change))
    (hk : kind = .writeDownReversal) (hfull : economicChange.toRat = -economics.allowance.toRat) :
    change.after.allowance.toRat = 0 ∧ change.after.carryingRat = budget.basis.toRat := by
  have v := adjusted_view hB hE hC h
  obtain ⟨hpc, hpt, hfr⟩ := v.up_data hk
  have hpos := v.up_sign hk
  have hd : 0 < -economics.allowance.toRat := by linarith
  have hone : change.proof.afterFraction.toRat = 1 := by
    rw [hfr, hfull, div_self hd.ne']
  have hfp := v.proof_full hone
  rw [hpt] at hfp
  have hal : change.after.allowance.toRat = 0 := by
    rw [v.after_allowance_rat, v.before_allowance_rat, hpc, hfp]
    ring
  refine ⟨hal, ?_⟩
  unfold InventoryPostedValueBudget.carryingRat
  rw [v.basis_eq, hal, v.before_basis_rat]
  ring

/-- The posted change is within one unit of the policy's scale of the exact fraction of the posted
carrying value (write-down) or of the posted allowance (reversal) that the economic change is of
the economic carrying value or allowance. -/
theorem adjustInventoryPostedAllowance_within_one_unit {budget : InventoryPostedValueBudget}
    {economics : InventoryEconomicValue} {kind : InventoryAllowanceChangeKind}
    {economicChange : ExactRational} {policy : QuantizationPolicy}
    {change : InventoryAllowanceChange}
    (hB : budget.WF) (hE : economics.WF) (hC : economicChange.WF)
    (h : adjustInventoryPostedAllowance budget economics kind economicChange policy =
      .ok (.adjusted change)) :
    (kind = .writeDown →
      |change.postedChange.toRat -
          economicChange.toRat / economics.carryingRat * budget.carryingRat| ≤ policy.rule.unit) ∧
    (kind = .writeDownReversal →
      |change.postedChange.toRat -
          economicChange.toRat / -economics.allowance.toRat * -budget.allowance.toRat| ≤
        policy.rule.unit) := by
  have v := adjusted_view hB hE hC h
  have hw := v.proof_within
  refine ⟨fun hk => ?_, fun hk => ?_⟩
  · obtain ⟨hpc, hpt, hfr⟩ := v.down_data hk
    rw [hfr, hpt] at hw
    have e : change.postedChange.toRat - economicChange.toRat / economics.carryingRat *
        budget.carryingRat = -(change.proof.postedAmount.toRat -
          -economicChange.toRat / economics.carryingRat * budget.carryingRat) := by
      rw [hpc]; ring
    rw [e, abs_neg]
    exact hw
  · obtain ⟨hpc, hpt, hfr⟩ := v.up_data hk
    rw [hfr, hpt] at hw
    rw [hpc]
    exact hw

/-- In every rounding mode but half even, the posted change is strictly less than one unit of the
policy's scale from the exact fraction of the posted carrying value or allowance. -/
theorem adjustInventoryPostedAllowance_lt_one_unit {budget : InventoryPostedValueBudget}
    {economics : InventoryEconomicValue} {kind : InventoryAllowanceChangeKind}
    {economicChange : ExactRational} {policy : QuantizationPolicy}
    {change : InventoryAllowanceChange}
    (hB : budget.WF) (hE : economics.WF) (hC : economicChange.WF)
    (h : adjustInventoryPostedAllowance budget economics kind economicChange policy =
      .ok (.adjusted change))
    (hm : policy.roundingMode ≠ .halfEven) :
    (kind = .writeDown →
      |change.postedChange.toRat -
          economicChange.toRat / economics.carryingRat * budget.carryingRat| < policy.rule.unit) ∧
    (kind = .writeDownReversal →
      |change.postedChange.toRat -
          economicChange.toRat / -economics.allowance.toRat * -budget.allowance.toRat| <
        policy.rule.unit) := by
  have v := adjusted_view hB hE hC h
  have hw := v.proof_within_lt hm
  refine ⟨fun hk => ?_, fun hk => ?_⟩
  · obtain ⟨hpc, hpt, hfr⟩ := v.down_data hk
    rw [hfr, hpt] at hw
    have e : change.postedChange.toRat - economicChange.toRat / economics.carryingRat *
        budget.carryingRat = -(change.proof.postedAmount.toRat -
          -economicChange.toRat / economics.carryingRat * budget.carryingRat) := by
      rw [hpc]; ring
    rw [e, abs_neg]
    exact hw
  · obtain ⟨hpc, hpt, hfr⟩ := v.up_data hk
    rw [hfr, hpt] at hw
    rw [hpc]
    exact hw

/-- The proof an adjustment carries is the cumulative share, from the zero fraction to the fraction
of the change, of the posted carrying value (write-down) or of the posted allowance (reversal); the
posted change is minus that share for a write-down and that share for a reversal. -/
theorem adjustInventoryPostedAllowance_proof {budget : InventoryPostedValueBudget}
    {economics : InventoryEconomicValue} {kind : InventoryAllowanceChangeKind}
    {economicChange : ExactRational} {policy : QuantizationPolicy}
    {change : InventoryAllowanceChange}
    (hB : budget.WF) (hE : economics.WF) (hC : economicChange.WF)
    (h : adjustInventoryPostedAllowance budget economics kind economicChange policy =
      .ok (.adjusted change)) :
    change.proof.beforeFraction = ExactRational.zero ∧ change.proof.policy = policy ∧
      policy.quantizeCumulativePostedShare change.proof.postedTotal ExactRational.zero
        change.proof.afterFraction = .ok (.quantized change.proof) ∧
      0 < change.proof.afterFraction.toRat ∧ change.proof.afterFraction.toRat ≤ 1 ∧
      (kind = .writeDown →
        change.postedChange.toRat = -change.proof.postedAmount.toRat ∧
          change.proof.postedTotal.toRat = budget.carryingRat ∧
          change.proof.afterFraction.toRat = -economicChange.toRat / economics.carryingRat) ∧
      (kind = .writeDownReversal →
        change.postedChange.toRat = change.proof.postedAmount.toRat ∧
          change.proof.postedTotal.toRat = -budget.allowance.toRat ∧
          change.proof.afterFraction.toRat = economicChange.toRat / -economics.allowance.toRat) := by
  have v := adjusted_view hB hE hC h
  exact ⟨v.proof_before, v.proof_policy, v.proof_share, v.proof_fraction_pos, v.proof_fraction_le,
    v.down_data, v.up_data⟩

/-- An adjustment is rejected exactly when the allocation of the budget at the zero fraction is
rejected, or when that allocation succeeds, the economic sums are computed, and the economics break
a rule: the basis is negative, the allowance is positive, the carrying value is negative, or (once
the sum after the change is computed) the carrying value after the change is negative, the
allowance after it is positive, a write-down's change is not negative, or a reversal's is not
positive; a rejection for the economics carries the one allowance diagnostic. -/
theorem adjustInventoryPostedAllowance_rejected_iff {budget : InventoryPostedValueBudget}
    {economics : InventoryEconomicValue} {kind : InventoryAllowanceChangeKind}
    {economicChange : ExactRational} {policy : QuantizationPolicy} {rejection : ValueRejection}
    (hE : economics.WF) (hC : economicChange.WF) :
    adjustInventoryPostedAllowance budget economics kind economicChange policy =
        .ok (.rejected rejection) ↔
      allocateInventoryPostedValue budget ExactRational.zero ExactRational.zero policy =
          .ok (.rejected rejection) ∨
        (∃ current economicCarrying afterAllowance,
          allocateInventoryPostedValue budget ExactRational.zero ExactRational.zero policy =
            .ok (.allocated current) ∧
          economics.basis.add economics.allowance = .ok economicCarrying ∧
          economics.allowance.add economicChange = .ok afterAllowance ∧
          rejection.diagnostics = [allowanceRejectionDiagnostic] ∧
          (economics.basis.toRat < 0 ∨ 0 < economics.allowance.toRat ∨ economics.carryingRat < 0 ∨
            ∃ afterCarrying, economics.basis.add afterAllowance = .ok afterCarrying ∧
              (economics.carryingRat + economicChange.toRat < 0 ∨
                0 < economics.allowance.toRat + economicChange.toRat ∨
                (kind = .writeDown ∧ 0 ≤ economicChange.toRat) ∨
                (kind = .writeDownReversal ∧ economicChange.toRat ≤ 0)))) := by
  constructor
  · intro h
    unfold adjustInventoryPostedAllowance at h
    dsimp only at h
    split at h
    · cases h
    · rename_i r hcur
      cases h
      exact Or.inl hcur
    · rename_i cur hcur
      split at h
      · cases h
      · rename_i EC hEC
        split at h
        · cases h
        · rename_i AA hAA
          split at h
          · rename_i hg1
            cases h
            refine Or.inr ⟨cur, EC, AA, hcur, liftExact_eq_ok hEC, liftExact_eq_ok hAA, rfl, ?_⟩
            rcases (allowance_guard1_iff hE (liftExact_eq_ok hEC)).mp hg1 with a | b | c
            · exact Or.inl a
            · exact Or.inr (Or.inl b)
            · exact Or.inr (Or.inr (Or.inl c))
          · rename_i hg1
            split at h
            · cases h
            · rename_i AC hAC
              split at h
              · rename_i hg2
                cases h
                refine Or.inr ⟨cur, EC, AA, hcur, liftExact_eq_ok hEC, liftExact_eq_ok hAA, rfl, ?_⟩
                exact Or.inr (Or.inr (Or.inr ⟨AC, liftExact_eq_ok hAC,
                  (allowance_guard2_iff hE hC (liftExact_eq_ok hAA) (liftExact_eq_ok hAC)).mp hg2⟩))
              · split at h
                · cases h
                · split at h
                  · cases h
                  · split at h
                    · cases h
                    · split at h
                      · cases h
                      · split at h
                        · cases h
                        · cases h
  · rintro (hrej | ⟨cur, EC, AA, hcur, hEC, hAA, hd, hcond⟩)
    · unfold adjustInventoryPostedAllowance
      dsimp only
      rw [hrej]
    · unfold adjustInventoryPostedAllowance
      dsimp only
      rw [hcur]
      dsimp only
      rw [show liftExact (economics.basis.add economics.allowance) = .ok EC by rw [hEC]; rfl]
      dsimp only
      rw [show liftExact (economics.allowance.add economicChange) = .ok AA by rw [hAA]; rfl]
      dsimp only
      by_cases hg1 : (economics.basis.isNegative = true ∨
          economics.allowance.compare ExactRational.zero = .gt ∨ EC.isNegative = true)
      · rw [ite_eq_left hg1]
        cases rejection
        simp only at hd
        simp [hd, reject, allowanceRejectionDiagnostic]
      · rw [ite_eq_right hg1]
        rcases hcond with hm1 | hm1 | hm1 | ⟨AC, hAC, hm2⟩
        · exact absurd ((allowance_guard1_iff hE hEC).mpr (Or.inl hm1)) hg1
        · exact absurd ((allowance_guard1_iff hE hEC).mpr (Or.inr (Or.inl hm1))) hg1
        · exact absurd ((allowance_guard1_iff hE hEC).mpr (Or.inr (Or.inr hm1))) hg1
        · rw [show liftExact (economics.basis.add AA) = .ok AC by rw [hAC]; rfl]
          dsimp only
          rw [ite_eq_left ((allowance_guard2_iff hE hC hAA hAC).mpr hm2)]
          cases rejection
          simp only at hd
          simp [hd, reject, allowanceRejectionDiagnostic]

/-- Every rejection of an adjustment carries exactly one diagnostic, for one of four reasons: the
three of the allocation of the budget, or the economics. -/
theorem adjustInventoryPostedAllowance_rejected_diagnostic {budget : InventoryPostedValueBudget}
    {economics : InventoryEconomicValue} {kind : InventoryAllowanceChangeKind}
    {economicChange : ExactRational} {policy : QuantizationPolicy} {rejection : ValueRejection}
    (hB : budget.WF) (hE : economics.WF) (hC : economicChange.WF)
    (h : adjustInventoryPostedAllowance budget economics kind economicChange policy =
      .ok (.rejected rejection)) :
    rejection.diagnostics = [shareInvalidDiagnostic] ∨
      rejection.diagnostics = [shareTotalDiagnostic] ∨
      rejection.diagnostics = [budgetRejectionDiagnostic] ∨
      rejection.diagnostics = [allowanceRejectionDiagnostic] := by
  rcases (adjustInventoryPostedAllowance_rejected_iff hE hC).mp h with hrej | ⟨-, -, -, -, -, -, hd, -⟩
  · rcases allocateInventoryPostedValue_rejected_diagnostic hB ExactRational.zero_wf
      ExactRational.zero_wf hrej with hd | hd | hd
    · exact Or.inl hd
    · exact Or.inr (Or.inl hd)
    · exact Or.inr (Or.inr (Or.inl hd))
  · exact Or.inr (Or.inr (Or.inr hd))

/-- When adjusting constructible numbers throws, it is only for exceeding the size limit: a division
by zero never happens, because the checks that come first keep the divisor positive. -/
theorem adjustInventoryPostedAllowance_error {budget : InventoryPostedValueBudget}
    {economics : InventoryEconomicValue} {kind : InventoryAllowanceChangeKind}
    {economicChange : ExactRational} {policy : QuantizationPolicy} {e : QuantizeErr}
    (hB : budget.WF) (hE : economics.WF) (hC : economicChange.WF)
    (h : adjustInventoryPostedAllowance budget economics kind economicChange policy = .error e) :
    e = .exactNumber .representationLimitExceeded := by
  unfold adjustInventoryPostedAllowance at h
  dsimp only at h
  split at h
  · rename_i e' hcur
    cases h
    exact allocateInventoryPostedValue_error hB ExactRational.zero_wf ExactRational.zero_wf hcur
  · cases h
  · rename_i cur hcur
    have v := allocated_view hB ExactRational.zero_wf ExactRational.zero_wf hcur
    obtain ⟨-, -, -, -, hra, hrc⟩ := allocateInventoryPostedValue_zero_fractions hB hcur
    split at h
    · rename_i e' hEC
      cases h
      obtain ⟨code, hcode, rfl⟩ := liftExact_eq_error hEC
      rcases ExactRational.add_ok_or_limit hE.basis_wf hE.allowance_wf with ⟨c, hc⟩ | hlim
      · rw [hc] at hcode; cases hcode
      · rw [hlim] at hcode; cases hcode; rfl
    · rename_i EC hEC
      split at h
      · rename_i e' hAA
        cases h
        obtain ⟨code, hcode, rfl⟩ := liftExact_eq_error hAA
        rcases ExactRational.add_ok_or_limit hE.allowance_wf hC with ⟨c, hc⟩ | hlim
        · rw [hc] at hcode; cases hcode
        · rw [hlim] at hcode; cases hcode; rfl
      · rename_i AA hAA
        obtain ⟨hAAwf, -⟩ := ExactRational.add_ok hE.allowance_wf hC (liftExact_eq_ok hAA)
        split at h
        · cases h
        · rename_i hg1
          split at h
          · rename_i e' hAC
            cases h
            obtain ⟨code, hcode, rfl⟩ := liftExact_eq_error hAC
            rcases ExactRational.add_ok_or_limit hE.basis_wf hAAwf with ⟨c, hc⟩ | hlim
            · rw [hc] at hcode; cases hcode
            · rw [hlim] at hcode; cases hcode; rfl
          · rename_i AC hAC
            split at h
            · cases h
            · rename_i hg2
              obtain ⟨-, -, -, hAc, hAa, hdown, hup⟩ := adjust_guard_facts hE hC
                (liftExact_eq_ok hEC) (liftExact_eq_ok hAA) (liftExact_eq_ok hAC) hg1 hg2
              split at h
              · rename_i e' hfr
                cases h
                obtain ⟨code, hcode, rfl⟩ := liftExact_eq_error hfr
                rw [adjust_fraction_error hE hC (liftExact_eq_ok hEC) hAc hAa hdown hup hcode]
              · rename_i fraction hfr
                obtain ⟨htwf, hts, ht0, hfwf, hfpos, hfle, -⟩ := adjust_total_fraction hE hC v hra
                  hrc (liftExact_eq_ok hEC) hAc hAa hdown hup rfl (liftExact_eq_ok hfr)
                split at h
                · rename_i e' hsh
                  cases h
                  rw [v.carrying_policy] at hsh
                  exact share_error htwf ExactRational.zero_wf hfwf v.scale_nonneg v.scale_le hsh
                · rename_i proof hpr
                  rw [v.carrying_policy] at hpr
                  obtain ⟨hpawf, -⟩ := share_from_zero htwf hts hfwf v.scale_nonneg v.scale_le ht0
                    hfpos.le hfle hpr
                  split at h
                  · rename_i e' had
                    cases h
                    obtain ⟨code, hcode, rfl⟩ := liftExact_eq_error had
                    rw [decimal_of_error
                      (by rw [v.remaining_allowance_scale]; exact v.scale_nonneg)
                      (by rw [v.remaining_allowance_scale]; exact v.scale_le) hcode]
                  · rename_i ad had
                    split at h
                    · rename_i e' hpcr
                      cases h
                      obtain ⟨code, hcode, rfl⟩ := liftExact_eq_error hpcr
                      exact absurd hcode
                        (ExactDecimal.toRational_ne_error (signed_facts kind hpawf).1 code)
                    · rename_i pcr hpcr
                      obtain ⟨hpcrwf, -⟩ := ExactDecimal.toRational_ok (signed_facts kind hpawf).1
                        (liftExact_eq_ok hpcr)
                      split at h
                      · rename_i e' hpme
                        cases h
                        obtain ⟨code, hcode, rfl⟩ := liftExact_eq_error hpme
                        rcases ExactRational.subtract_ok_or_limit hpcrwf hC with ⟨c, hc⟩ | hlim
                        · rw [hc] at hcode; cases hcode
                        · rw [hlim] at hcode; cases hcode; rfl
                      · cases h

/-! ## What the doc comment of `allocateInventoryPostedValue` claims -/

/-- The allocation preserves the cumulative net carrying share exactly and allocates the allowance
magnitude cumulatively under the same fractions: its two proofs are the cumulative shares of the
net carrying value and of the allowance magnitude, the basis consumed is the net carrying amount
consumed plus the allowance magnitude consumed (never a third rounded counter), and each remainder
is the total less the cumulative amount through the second fraction. -/
theorem allocateInventoryPostedValue_components {supplied : InventoryPostedValueBudget}
    {beforeFraction afterFraction : ExactRational} {policy : QuantizationPolicy}
    {alloc : InventoryPostedValueAllocation}
    (hS : supplied.WF) (hb : beforeFraction.WF) (ha : afterFraction.WF)
    (h : allocateInventoryPostedValue supplied beforeFraction afterFraction policy =
      .ok (.allocated alloc)) :
    policy.quantizeCumulativePostedShare alloc.carryingProof.postedTotal beforeFraction
        afterFraction = .ok (.quantized alloc.carryingProof) ∧
      policy.quantizeCumulativePostedShare alloc.allowanceProof.postedTotal beforeFraction
        afterFraction = .ok (.quantized alloc.allowanceProof) ∧
      alloc.carryingProof.postedTotal.toRat = supplied.carryingRat ∧
      alloc.allowanceProof.postedTotal.toRat = -supplied.allowance.toRat ∧
      alloc.carryingConsumed = alloc.carryingProof.postedAmount ∧
      alloc.consumed.allowance = alloc.allowanceProof.postedAmount.negate ∧
      alloc.consumed.basis.toRat =
        alloc.carryingConsumed.toRat + alloc.allowanceProof.postedAmount.toRat ∧
      alloc.carryingRemaining.toRat =
        alloc.carryingProof.postedTotal.toRat - alloc.carryingProof.afterQuantization.amount.toRat ∧
      alloc.remaining.allowance.toRat =
        -(alloc.allowanceProof.postedTotal.toRat -
          alloc.allowanceProof.afterQuantization.amount.toRat) := by
  have v := allocated_view hS hb ha h
  have hc := (allocateInventoryPostedValue_carrying_eq hS hb ha h).1
  unfold InventoryPostedValueBudget.carryingRat at hc
  refine ⟨v.carrying_share, v.allowance_share, v.carryingProof_total_rat,
    v.allowanceProof_total_rat, v.carryingConsumed_eq, v.consumed_allowance_eq, ?_, ?_, ?_⟩
  · have hca : alloc.consumed.allowance.toRat = -alloc.allowanceProof.postedAmount.toRat := by
      rw [v.consumed_allowance_eq, ExactDecimal.negate_toRat]
    linarith
  · rw [toRat_eq_mul_unit (rule := policy.rule) v.carryingRemaining_scale,
      toRat_eq_mul_unit (rule := policy.rule) v.carryingProof_total_scale,
      toRat_eq_mul_unit (rule := policy.rule) v.c1_scale, v.carryingRemaining_coeff]
    push_cast
    ring
  · rw [toRat_eq_mul_unit (rule := policy.rule) v.remaining_allowance_scale,
      toRat_eq_mul_unit (rule := policy.rule) v.allowanceProof_total_scale,
      toRat_eq_mul_unit (rule := policy.rule) v.a1_scale, v.remaining_allowance_coeff]
    push_cast
    ring

/-- Rounding the basis and the net carrying value independently can give a positive allowance
share: at scale 0 and half even, a basis of 2 and a net carrying value of 1 (an allowance magnitude
of 1), taken between the fractions 1/3 and 2/3, are rounded cumulatively to the shares 0 and 1, so
the allowance share they leave (the net share less the basis share) is positive, although the exact
allowance share is minus one third. (`quantize` takes the coefficient `roundedCoefficient
(numerator * 10 ^ scale) denominator mode`, and each cumulative counter is monotonic by
`quantize_monotone`.) -/
theorem independent_rounding_positive_allowance_share :
    roundedCoefficient (2 * 2) 3 .halfEven - roundedCoefficient (2 * 1) 3 .halfEven = 0 ∧
      roundedCoefficient (1 * 2) 3 .halfEven - roundedCoefficient (1 * 1) 3 .halfEven = 1 := by
  decide

end Rastrata.Kernel

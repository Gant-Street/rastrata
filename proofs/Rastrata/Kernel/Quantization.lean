/-
Rounding: the Lean model of the arithmetic of `packages/kernel/src/quantization.ts`.

Every definition mirrors one TypeScript member, named in its doc comment, with the same checks
in the same order. The policy record of the TypeScript carries identifiers, a version and
dates; the arithmetic reads only its scale and its rounding mode, so the model is written over
`QuantizationRule`, and the next wave puts the full policy over it.

`Rounds` is the meaning of a rounding mode as mathematics. The laws at the end are stated
through `toRat` and assume only that the inputs are constructible and that the calls returned
`.ok`.

Not modelled here: `hashQuantizationPolicy` and `quantizeBalancedBookValues`, which need the
full policy and the journal types.
-/
import Rastrata.Kernel.Numeric

namespace Rastrata.Kernel

/-- `RoundingMode`. -/
inductive RoundingMode where
  | halfEven
  | halfAwayFromZero
  | towardZero
  | floor
  | ceiling
  deriving DecidableEq, Repr, Inhabited

/-- The two fields of `QuantizationPolicy` that its arithmetic reads. -/
structure QuantizationRule where
  targetScale : Int
  roundingMode : RoundingMode
  deriving DecidableEq, Repr, Inhabited

/-- `QuantizedValue`. -/
structure QuantizedValue where
  amount : ExactDecimal
  residual : ExactRational
  deriving DecidableEq, Repr, Inhabited

/-- What `quantize` and `quantizeCumulativePostedShare` throw: the `RangeError` of `quantize`
for a scale outside the admitted range, or an `ExactNumberError` of `numeric.ts`. -/
inductive QuantizeErr where
  | scaleOutOfRange
  | exactNumber (code : NumErr)
  deriving DecidableEq, Repr, Inhabited

/-- `CumulativePostedShare`, with the rule in place of the policy. -/
structure CumulativePostedShare where
  postedTotal : ExactDecimal
  beforeFraction : ExactRational
  afterFraction : ExactRational
  beforeTarget : ExactRational
  afterTarget : ExactRational
  beforeQuantization : QuantizedValue
  afterQuantization : QuantizedValue
  postedAmount : ExactDecimal
  rule : QuantizationRule
  deriving DecidableEq, Repr, Inhabited

/-- The two rejections of `quantizeCumulativePostedShare`, in the order it tests them. Both
carry the diagnostic code `invalid_exact_number`; the first has the path
`cumulativePostedShare`, the second `cumulativePostedShare.postedTotal`. -/
inductive ShareRejection where
  | invalidShare
  | totalNotRepresentable
  deriving DecidableEq, Repr, Inhabited

/-- The result of `quantizeCumulativePostedShare` when it does not throw. -/
inductive ShareResult where
  | quantized (share : CumulativePostedShare)
  | rejected (reason : ShareRejection)
  deriving DecidableEq, Repr, Inhabited

/-- `roundedCoefficient`. -/
def roundedCoefficient (numerator denominator : Int) (mode : RoundingMode) : Int :=
  let quotient := jsDiv numerator denominator
  let remainder := jsMod numerator denominator
  if remainder = 0 then quotient
  else
    let sign : Int := if numerator < 0 then -1 else 1
    let magnitude : Int := if remainder < 0 then -remainder else remainder
    match mode with
    | .towardZero => quotient
    | .floor => if sign < 0 then quotient - 1 else quotient
    | .ceiling => if sign > 0 then quotient + 1 else quotient
    | .halfAwayFromZero => if magnitude * 2 ≥ denominator then quotient + sign else quotient
    | .halfEven =>
      let comparison := magnitude * 2 - denominator
      if comparison > 0 ∨
          (comparison = 0 ∧ jsMod (if quotient < 0 then -quotient else quotient) 2 = 1) then
        quotient + sign
      else quotient

/-- Carries an `ExactNumberError` out of `numeric.ts` unchanged. -/
def liftExact {α : Type} (result : Except NumErr α) : Except QuantizeErr α :=
  match result with
  | .ok value => .ok value
  | .error code => .error (.exactNumber code)

/-- `quantize`. -/
def quantize (value : ExactRational) (rule : QuantizationRule) : Except QuantizeErr QuantizedValue :=
  if rule.targetScale < 0 ∨ rule.targetScale > maxDecimalScale then .error .scaleOutOfRange
  else
    let factor : Int := 10 ^ rule.targetScale.toNat
    let coefficient :=
      roundedCoefficient (value.numerator * factor) value.denominator rule.roundingMode
    match liftExact (ExactDecimal.of coefficient rule.targetScale) with
    | .error e => .error e
    | .ok amount =>
      match liftExact amount.toRational with
      | .error e => .error e
      | .ok amountRational =>
        match liftExact (value.subtract amountRational) with
        | .error e => .error e
        | .ok residual => .ok ⟨amount, residual⟩

/-- `quantizeCumulativePostedShare`. The TypeScript also rejects a rounding mode outside the
five; the type `RoundingMode` has no such value. -/
def quantizeCumulativePostedShare (postedTotal : ExactDecimal)
    (beforeFraction afterFraction : ExactRational) (rule : QuantizationRule) :
    Except QuantizeErr ShareResult :=
  match liftExact postedTotal.toRational with
  | .error e => .error e
  | .ok total =>
    match liftExact (ExactRational.of 1 1) with
    | .error e => .error e
    | .ok one =>
      if rule.targetScale < 0 ∨ rule.targetScale > maxDecimalScale ∨
          total.isNegative = true ∨ beforeFraction.isNegative = true ∨
          afterFraction.compare beforeFraction = .lt ∨ afterFraction.compare one = .gt then
        .ok (.rejected .invalidShare)
      else
        match quantize total rule with
        | .error e => .error e
        | .ok normalizedTotal =>
          if normalizedTotal.residual.isZero = false then .ok (.rejected .totalNotRepresentable)
          else
            match liftExact (total.multiply beforeFraction) with
            | .error e => .error e
            | .ok beforeTarget =>
              match liftExact (total.multiply afterFraction) with
              | .error e => .error e
              | .ok afterTarget =>
                match quantize beforeTarget rule with
                | .error e => .error e
                | .ok beforeQuantization =>
                  match quantize afterTarget rule with
                  | .error e => .error e
                  | .ok afterQuantization =>
                    match liftExact (ExactDecimal.of
                      (afterQuantization.amount.coefficient -
                        beforeQuantization.amount.coefficient) rule.targetScale) with
                    | .error e => .error e
                    | .ok postedAmount =>
                      .ok (.quantized
                        { postedTotal := normalizedTotal.amount
                          beforeFraction := beforeFraction
                          afterFraction := afterFraction
                          beforeTarget := beforeTarget
                          afterTarget := afterTarget
                          beforeQuantization := beforeQuantization
                          afterQuantization := afterQuantization
                          postedAmount := postedAmount
                          rule := rule })

/-! ## The meaning of a rounding mode -/

/-- What it means for the whole number `k` to be the number `x` rounded in a mode. -/
def Rounds (mode : RoundingMode) (x : ℚ) (k : Int) : Prop :=
  match mode with
  | .floor => (k : ℚ) ≤ x ∧ x < k + 1
  | .ceiling => x ≤ k ∧ (k : ℚ) - 1 < x
  | .towardZero => (0 ≤ x → (k : ℚ) ≤ x ∧ x < k + 1) ∧ (x < 0 → x ≤ k ∧ (k : ℚ) - 1 < x)
  | .halfAwayFromZero => |x - k| ≤ 1 / 2 ∧ (|x - k| = 1 / 2 → |x| < |(k : ℚ)|)
  | .halfEven => |x - k| ≤ 1 / 2 ∧ (|x - k| = 1 / 2 → 2 ∣ k)

/-- One unit of the rule's scale: 0.01 at scale 2. -/
def QuantizationRule.unit (rule : QuantizationRule) : ℚ := 1 / 10 ^ rule.targetScale.toNat

/-! ## Whole-number facts about `roundedCoefficient` -/

/-- BigInt division by a positive number: the remainder is smaller than the divisor and has the
sign of the dividend. -/
private theorem tdiv_tmod_facts (n d : Int) (hd : 0 < d) :
    n = Int.tdiv n d * d + Int.tmod n d ∧
      ((0 ≤ n ∧ 0 ≤ Int.tmod n d ∧ Int.tmod n d < d ∧ (0 < n ∨ Int.tmod n d = 0)) ∨
        (n < 0 ∧ -d < Int.tmod n d ∧ Int.tmod n d ≤ 0)) := by
  refine ⟨?_, ?_⟩
  · have h := Int.tmod_add_tdiv_mul n d
    omega
  · rcases lt_or_ge n 0 with hn | hn
    · refine Or.inr ⟨hn, Int.lt_tmod_of_pos n hd, ?_⟩
      have h := Int.tmod_nonneg d (show 0 ≤ -n by omega)
      rw [Int.neg_tmod] at h
      omega
    · refine Or.inl ⟨hn, Int.tmod_nonneg d hn, Int.tmod_lt_of_pos n hd, ?_⟩
      rcases eq_or_lt_of_le hn with h0 | h0
      · exact Or.inr (by rw [← h0]; exact Int.zero_tmod d)
      · exact Or.inl h0

/-- Floor, in whole numbers: what is left of `n` after `k` denominators is from zero up to, not
including, one denominator. -/
private theorem rc_floor_int (n d : Int) (hd : 0 < d) :
    0 ≤ n - roundedCoefficient n d .floor * d ∧ n - roundedCoefficient n d .floor * d < d := by
  rcases tdiv_tmod_facts n d hd with ⟨hqr, hr⟩
  simp only [roundedCoefficient, jsDiv, jsMod]
  generalize Int.tdiv n d = q at hqr ⊢
  generalize Int.tmod n d = r at hqr hr ⊢
  split_ifs <;> (try simp only [sub_mul, one_mul]) <;> omega

/-- Ceiling, in whole numbers: `k` denominators overshoot `n` by less than one denominator. -/
private theorem rc_ceiling_int (n d : Int) (hd : 0 < d) :
    -d < n - roundedCoefficient n d .ceiling * d ∧ n - roundedCoefficient n d .ceiling * d ≤ 0 := by
  rcases tdiv_tmod_facts n d hd with ⟨hqr, hr⟩
  simp only [roundedCoefficient, jsDiv, jsMod]
  generalize Int.tdiv n d = q at hqr ⊢
  generalize Int.tmod n d = r at hqr hr ⊢
  split_ifs <;> (try simp only [add_mul, one_mul]) <;> omega

/-- Toward zero, in whole numbers: floor for a numerator that is not negative, ceiling for a
negative one. -/
private theorem rc_towardZero_int (n d : Int) (hd : 0 < d) :
    (0 ≤ n → 0 ≤ n - roundedCoefficient n d .towardZero * d ∧
        n - roundedCoefficient n d .towardZero * d < d) ∧
      (n < 0 → -d < n - roundedCoefficient n d .towardZero * d ∧
        n - roundedCoefficient n d .towardZero * d ≤ 0) := by
  rcases tdiv_tmod_facts n d hd with ⟨hqr, hr⟩
  simp only [roundedCoefficient, jsDiv, jsMod]
  generalize Int.tdiv n d = q at hqr ⊢
  generalize Int.tmod n d = r at hqr hr ⊢
  split_ifs <;> omega

/-- Half away from zero, in whole numbers: `k` denominators are at most half a denominator
from `n`, and at exactly half they are on the far side of `n` from zero. -/
private theorem rc_halfAway_int (n d : Int) (hd : 0 < d) :
    -d ≤ 2 * (n - roundedCoefficient n d .halfAwayFromZero * d) ∧
      2 * (n - roundedCoefficient n d .halfAwayFromZero * d) ≤ d ∧
      (2 * (n - roundedCoefficient n d .halfAwayFromZero * d) = d → n < 0) ∧
      (2 * (n - roundedCoefficient n d .halfAwayFromZero * d) = -d → 0 < n) := by
  rcases tdiv_tmod_facts n d hd with ⟨hqr, hr⟩
  simp only [roundedCoefficient, jsDiv, jsMod]
  generalize Int.tdiv n d = q at hqr ⊢
  generalize Int.tmod n d = r at hqr hr ⊢
  split_ifs <;> (try simp only [add_mul, one_mul, neg_mul]) <;> omega

/-- The TypeScript's test that the magnitude of the quotient is odd says that the quotient is
odd. -/
private theorem tmod_two_abs (q : Int) :
    Int.tmod (if q < 0 then -q else q) 2 = 1 ↔ q % 2 = 1 := by
  rw [Int.tmod_eq_emod_of_nonneg (by split_ifs <;> omega)]
  split_ifs <;> omega

/-- Half even, in whole numbers: `k` denominators are at most half a denominator from `n`, and
at exactly half `k` is even. -/
private theorem rc_halfEven_int (n d : Int) (hd : 0 < d) :
    -d ≤ 2 * (n - roundedCoefficient n d .halfEven * d) ∧
      2 * (n - roundedCoefficient n d .halfEven * d) ≤ d ∧
      (2 * (n - roundedCoefficient n d .halfEven * d) = d ∨
          2 * (n - roundedCoefficient n d .halfEven * d) = -d →
        2 ∣ roundedCoefficient n d .halfEven) := by
  rcases tdiv_tmod_facts n d hd with ⟨hqr, hr⟩
  simp only [roundedCoefficient, jsDiv, jsMod, tmod_two_abs]
  generalize Int.tdiv n d = q at hqr ⊢
  generalize Int.tmod n d = r at hqr hr ⊢
  split_ifs <;> (try simp only [add_mul, one_mul, neg_mul]) <;> omega

/-! ## `roundedCoefficient` is rounding -/

/-- For a positive denominator, `roundedCoefficient` gives the fraction rounded in the mode. -/
theorem roundedCoefficient_rounds (n d : Int) (hd : 0 < d) (mode : RoundingMode) :
    Rounds mode ((n : ℚ) / d) (roundedCoefficient n d mode) := by
  have hdq : (0 : ℚ) < d := by exact_mod_cast hd
  have hx : (n : ℚ) = (n : ℚ) / d * d := (div_mul_cancel₀ _ hdq.ne').symm
  have hneg : n < 0 → (n : ℚ) / d < 0 := fun h =>
    div_neg_of_neg_of_pos (by exact_mod_cast h) hdq
  have hpos : 0 < n → 0 < (n : ℚ) / d := fun h => div_pos (by exact_mod_cast h) hdq
  have hnn : 0 ≤ n → 0 ≤ (n : ℚ) / d := fun h => div_nonneg (by exact_mod_cast h) hdq.le
  generalize (n : ℚ) / d = x at hx hneg hpos hnn ⊢
  cases mode
  · obtain ⟨h1, h2, h3⟩ := rc_halfEven_int n d hd
    generalize roundedCoefficient n d .halfEven = k at h1 h2 h3 ⊢
    have h1q : -(d : ℚ) ≤ 2 * (n - k * d) := by exact_mod_cast h1
    have h2q : 2 * ((n : ℚ) - k * d) ≤ d := by exact_mod_cast h2
    show |x - k| ≤ 1 / 2 ∧ (|x - k| = 1 / 2 → 2 ∣ k)
    constructor
    · rw [hx] at h1q h2q
      exact abs_le.mpr ⟨by nlinarith, by nlinarith⟩
    · intro ht
      apply h3
      rcases (abs_eq (by norm_num)).mp ht with h | h
      · left
        have e : (2 : ℚ) * (n - k * d) = d := by
          rw [hx, show x = k + 1 / 2 by linarith]; ring
        exact_mod_cast e
      · right
        have e : (2 : ℚ) * (n - k * d) = -d := by
          rw [hx, show x = k - 1 / 2 by linarith]; ring
        exact_mod_cast e
  · obtain ⟨h1, h2, h3, h4⟩ := rc_halfAway_int n d hd
    generalize roundedCoefficient n d .halfAwayFromZero = k at h1 h2 h3 h4 ⊢
    have h1q : -(d : ℚ) ≤ 2 * (n - k * d) := by exact_mod_cast h1
    have h2q : 2 * ((n : ℚ) - k * d) ≤ d := by exact_mod_cast h2
    show |x - k| ≤ 1 / 2 ∧ (|x - k| = 1 / 2 → |x| < |(k : ℚ)|)
    constructor
    · rw [hx] at h1q h2q
      exact abs_le.mpr ⟨by nlinarith, by nlinarith⟩
    · intro ht
      rcases (abs_eq (by norm_num)).mp ht with h | h
      · have e : (2 : ℚ) * (n - k * d) = d := by
          rw [hx, show x = k + 1 / 2 by linarith]; ring
        have hn := hneg (h3 (by exact_mod_cast e))
        rw [abs_of_neg hn, abs_of_neg (by linarith)]
        linarith
      · have e : (2 : ℚ) * (n - k * d) = -d := by
          rw [hx, show x = k - 1 / 2 by linarith]; ring
        have hn := hpos (h4 (by exact_mod_cast e))
        rw [abs_of_pos hn, abs_of_pos (by linarith)]
        linarith
  · obtain ⟨h1, h2⟩ := rc_towardZero_int n d hd
    generalize roundedCoefficient n d .towardZero = k at h1 h2 ⊢
    show (0 ≤ x → (k : ℚ) ≤ x ∧ x < k + 1) ∧ (x < 0 → x ≤ k ∧ (k : ℚ) - 1 < x)
    constructor
    · intro h0
      have hn : 0 ≤ n := by
        by_contra hc
        exact absurd (hneg (by omega)) (not_lt.mpr h0)
      have h1q : (0 : ℚ) ≤ n - k * d ∧ (n : ℚ) - k * d < d := by exact_mod_cast h1 hn
      rw [hx] at h1q
      exact ⟨by nlinarith [h1q.1], by nlinarith [h1q.2]⟩
    · intro h0
      have hn : n < 0 := by
        by_contra hc
        exact absurd (hnn (by omega)) (not_le.mpr h0)
      have h1q : -(d : ℚ) < n - k * d ∧ (n : ℚ) - k * d ≤ 0 := by exact_mod_cast h2 hn
      rw [hx] at h1q
      exact ⟨by nlinarith [h1q.2], by nlinarith [h1q.1]⟩
  · obtain ⟨h1, h2⟩ := rc_floor_int n d hd
    generalize roundedCoefficient n d .floor = k at h1 h2 ⊢
    have h1q : (0 : ℚ) ≤ n - k * d := by exact_mod_cast h1
    have h2q : (n : ℚ) - k * d < d := by exact_mod_cast h2
    rw [hx] at h1q h2q
    show (k : ℚ) ≤ x ∧ x < k + 1
    exact ⟨by nlinarith, by nlinarith⟩
  · obtain ⟨h1, h2⟩ := rc_ceiling_int n d hd
    generalize roundedCoefficient n d .ceiling = k at h1 h2 ⊢
    have h1q : -(d : ℚ) < n - k * d := by exact_mod_cast h1
    have h2q : (n : ℚ) - k * d ≤ 0 := by exact_mod_cast h2
    rw [hx] at h1q h2q
    show x ≤ k ∧ (k : ℚ) - 1 < x
    exact ⟨by nlinarith, by nlinarith⟩

/-! ## What rounding guarantees -/

/-- A rounded number is less than one whole away from the number. -/
theorem Rounds.abs_sub_lt_one {mode : RoundingMode} {x : ℚ} {k : Int} (h : Rounds mode x k) :
    |x - k| < 1 := by
  cases mode
  · obtain ⟨a, -⟩ := h
    linarith
  · obtain ⟨a, -⟩ := h
    linarith
  · obtain ⟨a, b⟩ := h
    rcases le_or_gt 0 x with h0 | h0
    · obtain ⟨c, e⟩ := a h0
      exact abs_lt.mpr ⟨by linarith, by linarith⟩
    · obtain ⟨c, e⟩ := b h0
      exact abs_lt.mpr ⟨by linarith, by linarith⟩
  · obtain ⟨a, b⟩ := h
    exact abs_lt.mpr ⟨by linarith, by linarith⟩
  · obtain ⟨a, b⟩ := h
    exact abs_lt.mpr ⟨by linarith, by linarith⟩

/-- Rounding keeps the order: a larger number never rounds to a smaller whole number. -/
theorem Rounds.mono {mode : RoundingMode} {x₁ x₂ : ℚ} {k₁ k₂ : Int}
    (h₁ : Rounds mode x₁ k₁) (h₂ : Rounds mode x₂ k₂) (hle : x₁ ≤ x₂) : k₁ ≤ k₂ := by
  by_contra hc
  have hk : (k₂ : ℚ) + 1 ≤ k₁ := by exact_mod_cast (show k₂ + 1 ≤ k₁ by omega)
  cases mode
  · obtain ⟨a₁, e₁⟩ := h₁
    obtain ⟨a₂, e₂⟩ := h₂
    have b₁ := abs_le.mp a₁
    have b₂ := abs_le.mp a₂
    have t₁ : x₁ - k₁ = -(1 / 2) := by linarith [b₁.1, b₂.2]
    have t₂ : x₂ - k₂ = 1 / 2 := by linarith [b₁.1, b₂.2]
    have d₁ := e₁ (by rw [t₁, abs_neg, abs_of_pos (by norm_num)])
    have d₂ := e₂ (by rw [t₂, abs_of_pos (by norm_num)])
    have hkk : (k₁ : ℚ) = k₂ + 1 := by linarith [b₁.1, b₂.2]
    have hkk' : k₁ = k₂ + 1 := by exact_mod_cast hkk
    omega
  · obtain ⟨a₁, e₁⟩ := h₁
    obtain ⟨a₂, e₂⟩ := h₂
    have b₁ := abs_le.mp a₁
    have b₂ := abs_le.mp a₂
    have t₁ : x₁ - k₁ = -(1 / 2) := by linarith [b₁.1, b₂.2]
    have t₂ : x₂ - k₂ = 1 / 2 := by linarith [b₁.1, b₂.2]
    have d₁ := e₁ (by rw [t₁, abs_neg, abs_of_pos (by norm_num)])
    have d₂ := e₂ (by rw [t₂, abs_of_pos (by norm_num)])
    have s₁ := sq_lt_sq.mpr d₁
    have s₂ := sq_lt_sq.mpr d₂
    rw [show (k₁ : ℚ) = x₁ + 1 / 2 by linarith] at s₁
    rw [show (k₂ : ℚ) = x₂ - 1 / 2 by linarith] at s₂
    have u₁ : -(1 / 4) < x₁ := by nlinarith
    have u₂ : x₂ < 1 / 4 := by nlinarith
    have e₃ : (0 : ℚ) < k₁ := by linarith
    have e₄ : (k₁ : ℚ) < 1 := by linarith
    have e₅ : (0 : Int) < k₁ := by exact_mod_cast e₃
    have e₆ : k₁ < 1 := by exact_mod_cast e₄
    omega
  · obtain ⟨a₁, b₁⟩ := h₁
    obtain ⟨a₂, b₂⟩ := h₂
    rcases le_or_gt 0 x₁ with h0 | h0
    · have c₁ := a₁ h0
      have c₂ := a₂ (h0.trans hle)
      linarith [c₁.1, c₂.2]
    · have c₁ := b₁ h0
      rcases le_or_gt 0 x₂ with h0' | h0'
      · have c₂ := a₂ h0'
        have e₁ : (0 : ℚ) < k₂ + 1 := by linarith [c₂.2]
        have e₂ : (k₂ : ℚ) + 1 < 1 := by linarith [c₁.2]
        have e₃ : (0 : Int) < k₂ + 1 := by exact_mod_cast e₁
        have e₄ : k₂ + 1 < 1 := by exact_mod_cast e₂
        omega
      · have c₂ := b₂ h0'
        linarith [c₁.2, c₂.1]
  · obtain ⟨a₁, b₁⟩ := h₁
    obtain ⟨a₂, b₂⟩ := h₂
    linarith
  · obtain ⟨a₁, b₁⟩ := h₁
    obtain ⟨a₂, b₂⟩ := h₂
    linarith

/-- A number has one rounding in a mode. -/
theorem Rounds.unique {mode : RoundingMode} {x : ℚ} {k₁ k₂ : Int}
    (h₁ : Rounds mode x k₁) (h₂ : Rounds mode x k₂) : k₁ = k₂ :=
  le_antisymm (h₁.mono h₂ le_rfl) (h₂.mono h₁ le_rfl)

/-- A whole number rounds to itself in every mode. -/
theorem Rounds.eq_of_int {mode : RoundingMode} {c k : Int} (h : Rounds mode (c : ℚ) k) :
    k = c := by
  have b := abs_lt.mp h.abs_sub_lt_one
  have e₁ : -1 < c - k := by exact_mod_cast b.1
  have e₂ : c - k < 1 := by exact_mod_cast b.2
  omega

/-- Half even and half away from zero give different whole numbers only on an exact tie. -/
theorem Rounds.half_modes_agree {x : ℚ} {k₁ k₂ : Int} (h₁ : Rounds .halfEven x k₁)
    (h₂ : Rounds .halfAwayFromZero x k₂) :
    k₁ = k₂ ∨ (|x - k₁| = 1 / 2 ∧ |x - k₂| = 1 / 2) := by
  obtain ⟨a₁, -⟩ := h₁
  obtain ⟨a₂, -⟩ := h₂
  have b₁ := abs_le.mp a₁
  have b₂ := abs_le.mp a₂
  rcases lt_trichotomy k₁ k₂ with hlt | heq | hgt
  · right
    have hk : (k₁ : ℚ) + 1 ≤ k₂ := by exact_mod_cast (show k₁ + 1 ≤ k₂ by omega)
    constructor
    · rw [show x - k₁ = 1 / 2 by linarith [b₁.2, b₂.1], abs_of_pos (by norm_num)]
    · rw [show x - k₂ = -(1 / 2) by linarith [b₁.2, b₂.1], abs_neg, abs_of_pos (by norm_num)]
  · exact Or.inl heq
  · right
    have hk : (k₂ : ℚ) + 1 ≤ k₁ := by exact_mod_cast (show k₂ + 1 ≤ k₁ by omega)
    constructor
    · rw [show x - k₁ = -(1 / 2) by linarith [b₁.1, b₂.2], abs_neg, abs_of_pos (by norm_num)]
    · rw [show x - k₂ = 1 / 2 by linarith [b₁.1, b₂.2], abs_of_pos (by norm_num)]

/-- Rounding toward zero never gives a whole number larger in magnitude than the number. -/
theorem Rounds.towardZero_abs_le {x : ℚ} {k : Int} (h : Rounds .towardZero x k) :
    |(k : ℚ)| ≤ |x| := by
  obtain ⟨a, b⟩ := h
  rcases le_or_gt 0 x with h0 | h0
  · obtain ⟨c, e⟩ := a h0
    have e₁ : (0 : ℚ) < k + 1 := by linarith
    have e₂ : (0 : Int) < k + 1 := by exact_mod_cast e₁
    have e₃ : (0 : ℚ) ≤ k := by exact_mod_cast (show (0 : Int) ≤ k by omega)
    rw [abs_of_nonneg e₃, abs_of_nonneg h0]
    exact c
  · obtain ⟨c, e⟩ := b h0
    have e₁ : (k : ℚ) - 1 < 0 := by linarith
    have e₂ : k - 1 < 0 := by exact_mod_cast e₁
    have e₃ : (k : ℚ) ≤ 0 := by exact_mod_cast (show k ≤ 0 by omega)
    rw [abs_of_nonpos e₃, abs_of_neg h0]
    linarith

/-- Half away from zero rounds a number that is not negative down only when it is less than
half above the whole number. -/
private theorem Rounds.halfAway_of_nonneg {x : ℚ} {k : Int} (h : Rounds .halfAwayFromZero x k)
    (n : 0 ≤ x) : x - k < 1 / 2 ∧ (k : ℚ) - x ≤ 1 / 2 := by
  obtain ⟨a, e⟩ := h
  have b := abs_le.mp a
  refine ⟨?_, by linarith [b.1]⟩
  by_contra hc
  have t : x - k = 1 / 2 := by linarith [b.2]
  have d := e (by rw [t, abs_of_pos (by norm_num)])
  rw [abs_of_nonneg n] at d
  rcases le_or_gt 0 k with hk | hk
  · have hkq : (0 : ℚ) ≤ k := by exact_mod_cast hk
    rw [abs_of_nonneg hkq] at d
    linarith
  · have hkq : (k : ℚ) ≤ -1 := by exact_mod_cast (show k ≤ -1 by omega)
    linarith

/-- Two numbers that are not negative, rounded in one mode other than half even: the whole
numbers differ by less than one more or less than the numbers do. -/
theorem Rounds.sub_sub_lt_one {mode : RoundingMode} {x₁ x₂ : ℚ} {k₁ k₂ : Int}
    (h₁ : Rounds mode x₁ k₁) (h₂ : Rounds mode x₂ k₂) (n₁ : 0 ≤ x₁) (n₂ : 0 ≤ x₂)
    (hm : mode ≠ .halfEven) : |((k₂ : ℚ) - k₁) - (x₂ - x₁)| < 1 := by
  cases mode
  · exact absurd rfl hm
  · have c₁ := h₁.halfAway_of_nonneg n₁
    have c₂ := h₂.halfAway_of_nonneg n₂
    exact abs_lt.mpr ⟨by linarith [c₁.2, c₂.1], by linarith [c₁.1, c₂.2]⟩
  · have c₁ := h₁.1 n₁
    have c₂ := h₂.1 n₂
    exact abs_lt.mpr ⟨by linarith [c₁.1, c₂.2], by linarith [c₁.2, c₂.1]⟩
  · obtain ⟨a₁, b₁⟩ := h₁
    obtain ⟨a₂, b₂⟩ := h₂
    exact abs_lt.mpr ⟨by linarith, by linarith⟩
  · obtain ⟨a₁, b₁⟩ := h₁
    obtain ⟨a₂, b₂⟩ := h₂
    exact abs_lt.mpr ⟨by linarith, by linarith⟩

/-- Two numbers that are not negative, rounded in one mode: the whole numbers differ by at most
one more or less than the numbers do. -/
theorem Rounds.sub_sub_le_one {mode : RoundingMode} {x₁ x₂ : ℚ} {k₁ k₂ : Int}
    (h₁ : Rounds mode x₁ k₁) (h₂ : Rounds mode x₂ k₂) (n₁ : 0 ≤ x₁) (n₂ : 0 ≤ x₂) :
    |((k₂ : ℚ) - k₁) - (x₂ - x₁)| ≤ 1 := by
  by_cases hm : mode = .halfEven
  · subst hm
    have b₁ := abs_le.mp h₁.1
    have b₂ := abs_le.mp h₂.1
    exact abs_le.mpr ⟨by linarith [b₁.1, b₂.2], by linarith [b₁.2, b₂.1]⟩
  · exact (h₁.sub_sub_lt_one h₂ n₁ n₂ hm).le

/-! ## What `quantize` returns -/

/-- `liftExact` returns exactly when the operation of `numeric.ts` returned. -/
private theorem liftExact_ok {α : Type} {result : Except NumErr α} {value : α}
    (h : liftExact result = .ok value) : result = .ok value := by
  cases result with
  | error code => cases h
  | ok v => cases h; rfl

/-- What `quantize` returns: the amount's coefficient is the value, counted in units of the
scale, rounded in the rule's mode, and the residual is the value less the amount. -/
theorem quantize_ok {value : ExactRational} {rule : QuantizationRule} {qv : QuantizedValue}
    (hv : value.WF) (h : quantize value rule = .ok qv) :
    qv.amount.WF ∧ qv.residual.WF ∧ qv.amount.scale = rule.targetScale ∧
      Rounds rule.roundingMode (value.toRat * 10 ^ rule.targetScale.toNat)
        qv.amount.coefficient ∧
      qv.residual.toRat = value.toRat - qv.amount.toRat := by
  simp only [quantize] at h
  split at h
  · cases h
  · split at h
    · cases h
    · split at h
      · cases h
      · split at h
        · cases h
        · rename_i hs _ amount ha _ ar har _ res hres
          cases h
          obtain ⟨hwf, hc, hsc⟩ := ExactDecimal.of_ok (liftExact_ok ha)
          obtain ⟨harwf, hartr⟩ := ExactDecimal.toRational_ok hwf (liftExact_ok har)
          obtain ⟨hreswf, hrestr⟩ := ExactRational.subtract_ok hv harwf (liftExact_ok hres)
          refine ⟨hwf, hreswf, hsc, ?_, by rw [hrestr, hartr]⟩
          show Rounds rule.roundingMode _ amount.coefficient
          rw [hc]
          have hr := roundedCoefficient_rounds (value.numerator * 10 ^ rule.targetScale.toNat)
            value.denominator hv.denominator_pos rule.roundingMode
          have e : ((value.numerator * 10 ^ rule.targetScale.toNat : Int) : ℚ) / value.denominator =
              value.toRat * 10 ^ rule.targetScale.toNat := by
            unfold ExactRational.toRat
            push_cast
            ring
          rw [e] at hr
          exact hr

/-- An amount at the rule's scale is its coefficient times the rule's unit. -/
private theorem toRat_eq_mul_unit {amount : ExactDecimal} {rule : QuantizationRule}
    (h : amount.scale = rule.targetScale) : amount.toRat = amount.coefficient * rule.unit := by
  unfold ExactDecimal.toRat QuantizationRule.unit
  rw [h]
  ring

/-- A value is itself counted in units of the scale, times the unit. -/
private theorem value_eq_mul_unit (x : ℚ) (rule : QuantizationRule) :
    x = x * 10 ^ rule.targetScale.toNat * rule.unit := by
  unfold QuantizationRule.unit
  field_simp

/-- A unit of a scale is more than nothing. -/
theorem QuantizationRule.unit_pos (rule : QuantizationRule) : 0 < rule.unit := by
  unfold QuantizationRule.unit
  positivity

/-- The rounding seen in units of the scale: the value is `x` units, the amount is the whole
number of units `x` rounds to. -/
private theorem quantize_view {value : ExactRational} {rule : QuantizationRule}
    {qv : QuantizedValue} (hv : value.WF) (h : quantize value rule = .ok qv) :
    ∃ x : ℚ, x = value.toRat * 10 ^ rule.targetScale.toNat ∧
      Rounds rule.roundingMode x qv.amount.coefficient ∧
      value.toRat = x * rule.unit ∧ qv.amount.toRat = qv.amount.coefficient * rule.unit := by
  obtain ⟨-, -, hs, hr, -⟩ := quantize_ok hv h
  exact ⟨_, rfl, hr, value_eq_mul_unit _ rule, toRat_eq_mul_unit hs⟩

/-! ## The laws of rounding -/

/-- The rounded amount plus the residual is exactly the value. -/
theorem quantize_amount_add_residual {value : ExactRational} {rule : QuantizationRule}
    {qv : QuantizedValue} (hv : value.WF) (h : quantize value rule = .ok qv) :
    qv.amount.toRat + qv.residual.toRat = value.toRat := by
  obtain ⟨-, -, -, -, hres⟩ := quantize_ok hv h
  rw [hres]
  ring

/-- The rounded amount is less than one unit of the scale away from the value. -/
theorem quantize_within_one_unit {value : ExactRational} {rule : QuantizationRule}
    {qv : QuantizedValue} (hv : value.WF) (h : quantize value rule = .ok qv) :
    |qv.amount.toRat - value.toRat| < rule.unit := by
  obtain ⟨x, -, hr, hx, ha⟩ := quantize_view hv h
  rw [ha, hx, ← sub_mul, abs_mul, abs_of_pos rule.unit_pos, abs_sub_comm]
  have b := mul_lt_mul_of_pos_right hr.abs_sub_lt_one rule.unit_pos
  linarith

/-- In the two half modes the rounded amount is at most half a unit away from the value. -/
theorem quantize_within_half_unit {value : ExactRational} {rule : QuantizationRule}
    {qv : QuantizedValue} (hv : value.WF) (h : quantize value rule = .ok qv)
    (hm : rule.roundingMode = .halfEven ∨ rule.roundingMode = .halfAwayFromZero) :
    |qv.amount.toRat - value.toRat| ≤ rule.unit / 2 := by
  obtain ⟨x, -, hr, hx, ha⟩ := quantize_view hv h
  rw [ha, hx, ← sub_mul, abs_mul, abs_of_pos rule.unit_pos, abs_sub_comm]
  have a : |x - qv.amount.coefficient| ≤ 1 / 2 := by
    rcases hm with hm | hm <;> rw [hm] at hr <;> exact hr.1
  have b := mul_le_mul_of_nonneg_right a rule.unit_pos.le
  linarith

/-- Rounding down never gives more than the value. -/
theorem quantize_floor_le {value : ExactRational} {rule : QuantizationRule}
    {qv : QuantizedValue} (hv : value.WF) (h : quantize value rule = .ok qv)
    (hm : rule.roundingMode = .floor) : qv.amount.toRat ≤ value.toRat := by
  obtain ⟨x, -, hr, hx, ha⟩ := quantize_view hv h
  rw [hm] at hr
  rw [ha, hx]
  exact mul_le_mul_of_nonneg_right hr.1 rule.unit_pos.le

/-- Rounding up never gives less than the value. -/
theorem quantize_ceiling_ge {value : ExactRational} {rule : QuantizationRule}
    {qv : QuantizedValue} (hv : value.WF) (h : quantize value rule = .ok qv)
    (hm : rule.roundingMode = .ceiling) : value.toRat ≤ qv.amount.toRat := by
  obtain ⟨x, -, hr, hx, ha⟩ := quantize_view hv h
  rw [hm] at hr
  rw [ha, hx]
  exact mul_le_mul_of_nonneg_right hr.1 rule.unit_pos.le

/-- Rounding toward zero never gives an amount larger in magnitude than the value. -/
theorem quantize_towardZero_abs_le {value : ExactRational} {rule : QuantizationRule}
    {qv : QuantizedValue} (hv : value.WF) (h : quantize value rule = .ok qv)
    (hm : rule.roundingMode = .towardZero) : |qv.amount.toRat| ≤ |value.toRat| := by
  obtain ⟨x, -, hr, hx, ha⟩ := quantize_view hv h
  rw [hm] at hr
  rw [ha, hx, abs_mul, abs_mul]
  exact mul_le_mul_of_nonneg_right hr.towardZero_abs_le (abs_nonneg _)

/-- With half even, a value exactly halfway between two amounts rounds to the one whose
coefficient is even. -/
theorem quantize_halfEven_tie_even {value : ExactRational} {rule : QuantizationRule}
    {qv : QuantizedValue} (hv : value.WF) (h : quantize value rule = .ok qv)
    (hm : rule.roundingMode = .halfEven)
    (htie : |qv.amount.toRat - value.toRat| = rule.unit / 2) : 2 ∣ qv.amount.coefficient := by
  obtain ⟨x, -, hr, hx, ha⟩ := quantize_view hv h
  rw [hm] at hr
  rw [ha, hx, ← sub_mul, abs_mul, abs_of_pos rule.unit_pos, abs_sub_comm] at htie
  exact hr.2 (mul_right_cancel₀ rule.unit_pos.ne' (htie.trans (by ring)))

/-- With half away from zero, a value exactly halfway between two amounts rounds to the one
larger in magnitude. -/
theorem quantize_halfAway_tie_away {value : ExactRational} {rule : QuantizationRule}
    {qv : QuantizedValue} (hv : value.WF) (h : quantize value rule = .ok qv)
    (hm : rule.roundingMode = .halfAwayFromZero)
    (htie : |qv.amount.toRat - value.toRat| = rule.unit / 2) :
    |value.toRat| < |qv.amount.toRat| := by
  obtain ⟨x, -, hr, hx, ha⟩ := quantize_view hv h
  rw [hm] at hr
  rw [ha, hx, ← sub_mul, abs_mul, abs_of_pos rule.unit_pos, abs_sub_comm] at htie
  have b := hr.2 (mul_right_cancel₀ rule.unit_pos.ne' (htie.trans (by ring)))
  rw [ha, hx, abs_mul, abs_mul, abs_of_pos rule.unit_pos]
  exact mul_lt_mul_of_pos_right b rule.unit_pos

/-- Two decimals with the same coefficient and the same scale are the same decimal. -/
private theorem decimal_ext {a b : ExactDecimal} (hc : a.coefficient = b.coefficient)
    (hs : a.scale = b.scale) : a = b := by
  cases a
  cases b
  simp_all

/-- Half even and half away from zero round a value to different amounts only when the value
is exactly halfway between the two. -/
theorem quantize_half_modes_agree {value : ExactRational} {scale : Int}
    {even away : QuantizedValue} (hv : value.WF)
    (he : quantize value ⟨scale, .halfEven⟩ = .ok even)
    (ha : quantize value ⟨scale, .halfAwayFromZero⟩ = .ok away) :
    even.amount = away.amount ∨
      (|even.amount.toRat - value.toRat| = (QuantizationRule.mk scale .halfEven).unit / 2 ∧
        |away.amount.toRat - value.toRat| =
          (QuantizationRule.mk scale .halfAwayFromZero).unit / 2) := by
  obtain ⟨-, -, hs₁, -, -⟩ := quantize_ok hv he
  obtain ⟨-, -, hs₂, -, -⟩ := quantize_ok hv ha
  obtain ⟨x₁, e₁, hr₁, hx₁, ha₁⟩ := quantize_view hv he
  obtain ⟨x₂, e₂, hr₂, hx₂, ha₂⟩ := quantize_view hv ha
  have hxx : x₂ = x₁ := e₂.trans e₁.symm
  rw [hxx] at hr₂ hx₂
  rcases Rounds.half_modes_agree hr₁ hr₂ with hk | ⟨t₁, t₂⟩
  · exact Or.inl (decimal_ext hk (hs₁.trans hs₂.symm))
  · right
    constructor
    · rw [ha₁, hx₁, ← sub_mul, abs_mul, abs_of_pos (QuantizationRule.unit_pos _), abs_sub_comm,
        t₁]
      ring
    · rw [ha₂, hx₂, ← sub_mul, abs_mul, abs_of_pos (QuantizationRule.unit_pos _), abs_sub_comm,
        t₂]
      ring

/-- A value that is already a whole number of units of the scale comes back unchanged, with
nothing left over. -/
theorem quantize_representable {value : ExactRational} {rule : QuantizationRule}
    {qv : QuantizedValue} (hv : value.WF) (h : quantize value rule = .ok qv) {c : Int}
    (hc : value.toRat = c / 10 ^ rule.targetScale.toNat) :
    qv.amount.coefficient = c ∧ qv.amount.toRat = value.toRat ∧ qv.residual.toRat = 0 ∧
      qv.residual = ExactRational.zero := by
  obtain ⟨-, hreswf, -, -, hres⟩ := quantize_ok hv h
  obtain ⟨x, e, hr, hx, ha⟩ := quantize_view hv h
  have hxc : x = c := by
    rw [e, hc]
    field_simp
  rw [hxc] at hr hx
  have hk := hr.eq_of_int
  have hav : qv.amount.toRat = value.toRat := by rw [ha, hx, hk]
  have hz : qv.residual.toRat = 0 := by rw [hres, hav]; ring
  exact ⟨hk, hav, hz, ExactRational.eq_of_toRat_eq hreswf ExactRational.zero_wf
    (hz.trans ExactRational.zero_toRat.symm)⟩

/-- An amount already at the rule's scale rounds to itself, with nothing left over. -/
theorem quantize_decimal {amount : ExactDecimal} {value : ExactRational}
    {rule : QuantizationRule} {qv : QuantizedValue} (hd : amount.WF)
    (hs : amount.scale = rule.targetScale) (hr : amount.toRational = .ok value)
    (h : quantize value rule = .ok qv) :
    qv.amount = amount ∧ qv.residual = ExactRational.zero := by
  obtain ⟨hv, hvt⟩ := ExactDecimal.toRational_ok hd hr
  obtain ⟨-, -, hqs, -, -⟩ := quantize_ok hv h
  obtain ⟨hc, -, -, hz⟩ := quantize_representable hv h (c := amount.coefficient)
    (by rw [hvt]; unfold ExactDecimal.toRat; rw [hs])
  exact ⟨decimal_ext hc (hqs.trans hs.symm), hz⟩

/-- Rounding keeps the order: a larger value never rounds to a smaller amount. -/
theorem quantize_monotone {value₁ value₂ : ExactRational} {rule : QuantizationRule}
    {qv₁ qv₂ : QuantizedValue} (hv₁ : value₁.WF) (hv₂ : value₂.WF)
    (h₁ : quantize value₁ rule = .ok qv₁) (h₂ : quantize value₂ rule = .ok qv₂)
    (hle : value₁.toRat ≤ value₂.toRat) : qv₁.amount.toRat ≤ qv₂.amount.toRat := by
  obtain ⟨x₁, e₁, hr₁, -, ha₁⟩ := quantize_view hv₁ h₁
  obtain ⟨x₂, e₂, hr₂, -, ha₂⟩ := quantize_view hv₂ h₂
  have hxx : x₁ ≤ x₂ := by
    rw [e₁, e₂]
    exact mul_le_mul_of_nonneg_right hle (by positivity)
  have hk : (qv₁.amount.coefficient : ℚ) ≤ qv₂.amount.coefficient := by
    exact_mod_cast hr₁.mono hr₂ hxx
  rw [ha₁, ha₂]
  exact mul_le_mul_of_nonneg_right hk rule.unit_pos.le

/-! ## Cumulative shares -/

/-- What a share that was not rejected was computed from: every check passed and every step
returned. -/
theorem quantizeCumulativePostedShare_quantized {postedTotal : ExactDecimal}
    {beforeFraction afterFraction : ExactRational} {rule : QuantizationRule}
    {share : CumulativePostedShare}
    (h : quantizeCumulativePostedShare postedTotal beforeFraction afterFraction rule =
      .ok (.quantized share)) :
    ∃ total one normalizedTotal,
      postedTotal.toRational = .ok total ∧ ExactRational.of 1 1 = .ok one ∧
      total.isNegative = false ∧ beforeFraction.isNegative = false ∧
      afterFraction.compare beforeFraction ≠ .lt ∧ afterFraction.compare one ≠ .gt ∧
      quantize total rule = .ok normalizedTotal ∧ normalizedTotal.residual.isZero = true ∧
      total.multiply beforeFraction = .ok share.beforeTarget ∧
      total.multiply afterFraction = .ok share.afterTarget ∧
      quantize share.beforeTarget rule = .ok share.beforeQuantization ∧
      quantize share.afterTarget rule = .ok share.afterQuantization ∧
      ExactDecimal.of (share.afterQuantization.amount.coefficient -
        share.beforeQuantization.amount.coefficient) rule.targetScale = .ok share.postedAmount ∧
      share.postedTotal = normalizedTotal.amount ∧ share.beforeFraction = beforeFraction ∧
      share.afterFraction = afterFraction ∧ share.rule = rule := by
  unfold quantizeCumulativePostedShare at h
  split at h
  · cases h
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
            · split at h
              · cases h
              · split at h
                · cases h
                · split at h
                  · cases h
                  · split at h
                    · cases h
                    · rename_i _ total htot _ one hone hchk _ norm hnorm hz _ bt hbt _ at' hat _ bq
                        hbq _ aq haq _ pa hpa
                      cases h
                      simp only [not_or] at hchk
                      obtain ⟨-, -, c₁, c₂, c₃, c₄⟩ := hchk
                      exact ⟨total, one, norm, liftExact_ok htot, liftExact_ok hone,
                        (Bool.not_eq_true _).mp c₁, (Bool.not_eq_true _).mp c₂, c₃, c₄, hnorm,
                        (Bool.not_eq_false _).mp hz, liftExact_ok hbt, liftExact_ok hat, hbq, haq,
                        liftExact_ok hpa, rfl, rfl, rfl, rfl⟩

/-- A share that was not rejected, as numbers: the total is not negative and is a whole number
of units, the fractions are in order between zero and one, the two targets are the total times
the fractions, and the posted amount is the difference of the two rounded targets. -/
private theorem share_facts {postedTotal : ExactDecimal}
    {beforeFraction afterFraction : ExactRational} {rule : QuantizationRule}
    {share : CumulativePostedShare} (hT : postedTotal.WF) (hb : beforeFraction.WF)
    (ha : afterFraction.WF)
    (h : quantizeCumulativePostedShare postedTotal beforeFraction afterFraction rule =
      .ok (.quantized share)) :
    0 ≤ postedTotal.toRat ∧ 0 ≤ beforeFraction.toRat ∧
      beforeFraction.toRat ≤ afterFraction.toRat ∧ afterFraction.toRat ≤ 1 ∧
      share.beforeTarget.WF ∧
      share.beforeTarget.toRat = postedTotal.toRat * beforeFraction.toRat ∧
      share.afterTarget.WF ∧
      share.afterTarget.toRat = postedTotal.toRat * afterFraction.toRat ∧
      quantize share.beforeTarget rule = .ok share.beforeQuantization ∧
      quantize share.afterTarget rule = .ok share.afterQuantization ∧
      share.postedAmount.toRat =
        share.afterQuantization.amount.toRat - share.beforeQuantization.amount.toRat ∧
      (∃ c : Int, postedTotal.toRat = c / 10 ^ rule.targetScale.toNat) ∧
      share.postedTotal.toRat = postedTotal.toRat := by
  obtain ⟨total, one, norm, htot, hone, c₁, c₂, c₃, c₄, hnorm, hz, hbt, hat, hbq, haq, hpa, hpt,
    -, -, -⟩ := quantizeCumulativePostedShare_quantized h
  obtain ⟨htwf, httr⟩ := ExactDecimal.toRational_ok hT htot
  obtain ⟨honewf, honetr, -⟩ := ExactRational.of_ok hone
  obtain ⟨hbtwf, hbttr⟩ := ExactRational.multiply_ok htwf hb hbt
  obtain ⟨hatwf, hattr⟩ := ExactRational.multiply_ok htwf ha hat
  obtain ⟨hpawf, hpac, hpas⟩ := ExactDecimal.of_ok hpa
  obtain ⟨-, hnres, hns, -, hnrestr⟩ := quantize_ok htwf hnorm
  obtain ⟨-, -, hbqs, -, -⟩ := quantize_ok hbtwf hbq
  obtain ⟨-, -, haqs, -, -⟩ := quantize_ok hatwf haq
  have e₁ : 0 ≤ total.toRat := by
    by_contra hc
    have t := (ExactRational.isNegative_iff htwf).mpr (not_le.mp hc)
    rw [c₁] at t
    cases t
  have e₂ : 0 ≤ beforeFraction.toRat := by
    by_contra hc
    have t := (ExactRational.isNegative_iff hb).mpr (not_le.mp hc)
    rw [c₂] at t
    cases t
  have e₃ : beforeFraction.toRat ≤ afterFraction.toRat := by
    by_contra hc
    exact c₃ ((ExactRational.compare_lt_iff ha hb).mpr (not_le.mp hc))
  have e₄ : afterFraction.toRat ≤ 1 := by
    by_contra hc
    refine c₄ ((ExactRational.compare_gt_iff ha honewf).mpr ?_)
    rw [honetr]
    push_cast
    linarith [not_le.mp hc]
  have hzero : norm.residual.toRat = 0 := (ExactRational.isZero_iff hnres).mp hz
  have hnamt : norm.amount.toRat = total.toRat := by linarith
  refine ⟨by rw [← httr]; exact e₁, e₂, e₃, e₄, hbtwf, by rw [hbttr, httr], hatwf,
    by rw [hattr, httr], hbq, haq, ?_, ?_, ?_⟩
  · rw [toRat_eq_mul_unit hpas, toRat_eq_mul_unit haqs, toRat_eq_mul_unit hbqs, hpac]
    push_cast
    ring
  · refine ⟨norm.amount.coefficient, ?_⟩
    rw [← httr, ← hnamt, toRat_eq_mul_unit hns]
    unfold QuantizationRule.unit
    ring
  · rw [hpt, hnamt, httr]

/-- The total a share carries is the posted total it was given, as a number. -/
theorem cumulativeShare_postedTotal {postedTotal : ExactDecimal}
    {beforeFraction afterFraction : ExactRational} {rule : QuantizationRule}
    {share : CumulativePostedShare} (hT : postedTotal.WF) (hb : beforeFraction.WF)
    (ha : afterFraction.WF)
    (h : quantizeCumulativePostedShare postedTotal beforeFraction afterFraction rule =
      .ok (.quantized share)) : share.postedTotal.toRat = postedTotal.toRat :=
  (share_facts hT hb ha h).2.2.2.2.2.2.2.2.2.2.2.2

/-- The posted amount of a share is never negative. -/
theorem cumulativeShare_nonneg {postedTotal : ExactDecimal}
    {beforeFraction afterFraction : ExactRational} {rule : QuantizationRule}
    {share : CumulativePostedShare} (hT : postedTotal.WF) (hb : beforeFraction.WF)
    (ha : afterFraction.WF)
    (h : quantizeCumulativePostedShare postedTotal beforeFraction afterFraction rule =
      .ok (.quantized share)) : 0 ≤ share.postedAmount.toRat := by
  obtain ⟨t0, b0, hba, a1, hbtwf, hbttr, hatwf, hattr, hbq, haq, hpost, -, -⟩ :=
    share_facts hT hb ha h
  have m := quantize_monotone hbtwf hatwf hbq haq
    (by rw [hbttr, hattr]; exact mul_le_mul_of_nonneg_left hba t0)
  rw [hpost]
  linarith

/-- The two rounded targets of a share, counted in units of the scale. -/
private theorem share_view {postedTotal : ExactDecimal}
    {beforeFraction afterFraction : ExactRational} {rule : QuantizationRule}
    {share : CumulativePostedShare} (hT : postedTotal.WF) (hb : beforeFraction.WF)
    (ha : afterFraction.WF)
    (h : quantizeCumulativePostedShare postedTotal beforeFraction afterFraction rule =
      .ok (.quantized share)) :
    ∃ (xb xa : ℚ) (kb ka : Int), Rounds rule.roundingMode xb kb ∧
      Rounds rule.roundingMode xa ka ∧ 0 ≤ xb ∧ 0 ≤ xa ∧
      share.postedAmount.toRat -
          (afterFraction.toRat - beforeFraction.toRat) * postedTotal.toRat =
        (((ka : ℚ) - kb) - (xa - xb)) * rule.unit := by
  obtain ⟨t0, b0, hba, a1, hbtwf, hbttr, hatwf, hattr, hbq, haq, hpost, -, -⟩ :=
    share_facts hT hb ha h
  obtain ⟨xb, eb, rb, hxb, hab⟩ := quantize_view hbtwf hbq
  obtain ⟨xa, ea, ra, hxa, haa⟩ := quantize_view hatwf haq
  refine ⟨xb, xa, _, _, rb, ra, ?_, ?_, ?_⟩
  · rw [eb, hbttr]
    exact mul_nonneg (mul_nonneg t0 b0) (by positivity)
  · rw [ea, hattr]
    exact mul_nonneg (mul_nonneg t0 (b0.trans hba)) (by positivity)
  · have e : (afterFraction.toRat - beforeFraction.toRat) * postedTotal.toRat =
        share.afterTarget.toRat - share.beforeTarget.toRat := by
      rw [hattr, hbttr]
      ring
    rw [e, hpost, haa, hab, hxa, hxb]
    ring

/-- The posted amount of a share is at most one unit of the scale away from the exact share of
the total. -/
theorem cumulativeShare_within_one_unit {postedTotal : ExactDecimal}
    {beforeFraction afterFraction : ExactRational} {rule : QuantizationRule}
    {share : CumulativePostedShare} (hT : postedTotal.WF) (hb : beforeFraction.WF)
    (ha : afterFraction.WF)
    (h : quantizeCumulativePostedShare postedTotal beforeFraction afterFraction rule =
      .ok (.quantized share)) :
    |share.postedAmount.toRat -
        (afterFraction.toRat - beforeFraction.toRat) * postedTotal.toRat| ≤ rule.unit := by
  obtain ⟨xb, xa, kb, ka, rb, ra, nb, na, e⟩ := share_view hT hb ha h
  rw [e, abs_mul, abs_of_pos rule.unit_pos]
  have m := mul_le_mul_of_nonneg_right (rb.sub_sub_le_one ra nb na) rule.unit_pos.le
  linarith

/-- In every mode but half even, the posted amount of a share is less than one unit of the
scale away from the exact share of the total. -/
theorem cumulativeShare_lt_one_unit {postedTotal : ExactDecimal}
    {beforeFraction afterFraction : ExactRational} {rule : QuantizationRule}
    {share : CumulativePostedShare} (hT : postedTotal.WF) (hb : beforeFraction.WF)
    (ha : afterFraction.WF)
    (h : quantizeCumulativePostedShare postedTotal beforeFraction afterFraction rule =
      .ok (.quantized share)) (hm : rule.roundingMode ≠ .halfEven) :
    |share.postedAmount.toRat -
        (afterFraction.toRat - beforeFraction.toRat) * postedTotal.toRat| < rule.unit := by
  obtain ⟨xb, xa, kb, ka, rb, ra, nb, na, e⟩ := share_view hT hb ha h
  rw [e, abs_mul, abs_of_pos rule.unit_pos]
  have m := mul_lt_mul_of_pos_right (rb.sub_sub_lt_one ra nb na hm) rule.unit_pos
  linarith

/-- Half even can post exactly one unit more than the exact share. Of a total of 2 at scale 0,
the share between the fractions 1/4 and 3/4 is 1; the targets 1/2 and 3/2 round to 0 and 2, so
2 is posted. -/
example : roundedCoefficient 3 2 .halfEven - roundedCoefficient 1 2 .halfEven = 2 := by decide

/-- Where one share ends the next begins: the same fraction of the same total rounds to the
same amount in both. -/
private theorem share_before_eq_after {postedTotal : ExactDecimal}
    {f₀ f₁ f₂ : ExactRational} {rule : QuantizationRule} {s₁ s₂ : CumulativePostedShare}
    (h₁ : quantizeCumulativePostedShare postedTotal f₀ f₁ rule = .ok (.quantized s₁))
    (h₂ : quantizeCumulativePostedShare postedTotal f₁ f₂ rule = .ok (.quantized s₂)) :
    s₂.beforeQuantization = s₁.afterQuantization := by
  obtain ⟨t₁, -, -, ht₁, -, -, -, -, -, -, -, -, hat₁, -, haq₁, -⟩ :=
    quantizeCumulativePostedShare_quantized h₁
  obtain ⟨t₂, -, -, ht₂, -, -, -, -, -, -, -, hbt₂, -, hbq₂, -⟩ :=
    quantizeCumulativePostedShare_quantized h₂
  have ht : t₂ = t₁ := Except.ok.inj (ht₂.symm.trans ht₁)
  rw [ht] at hbt₂
  have htarget : s₂.beforeTarget = s₁.afterTarget := Except.ok.inj (hbt₂.symm.trans hat₁)
  rw [htarget] at hbq₂
  exact Except.ok.inj (hbq₂.symm.trans haq₁)

/-- The differences of successive terms add up to the last term less the first. -/
private theorem sum_range_telescope (A : Nat → ℚ) (n : Nat) :
    ((List.range n).map fun i => A (i + 1) - A i).sum = A n - A 0 := by
  induction n with
  | zero => simp
  | succ m ih =>
    rw [List.range_succ, List.map_append, List.sum_append, ih]
    simp

/-- The rounded amounts at the boundaries of successive shares: before the first share, then
after each. -/
private def boundary (share : Nat → CumulativePostedShare) : Nat → ℚ
  | 0 => (share 0).beforeQuantization.amount.toRat
  | i + 1 => (share i).afterQuantization.amount.toRat

/-- For cumulative fractions that start at zero and end at one, the posted amounts of the
successive shares add up to the posted total exactly. -/
theorem cumulativeShares_sum {postedTotal : ExactDecimal} {rule : QuantizationRule}
    (hT : postedTotal.WF) (fraction : Nat → ExactRational)
    (share : Nat → CumulativePostedShare) (n : Nat) (hf : ∀ i, i ≤ n → (fraction i).WF)
    (h0 : (fraction 0).toRat = 0) (h1 : (fraction n).toRat = 1)
    (h : ∀ i, i < n →
      quantizeCumulativePostedShare postedTotal (fraction i) (fraction (i + 1)) rule =
        .ok (.quantized (share i))) :
    ((List.range n).map fun i => (share i).postedAmount.toRat).sum = postedTotal.toRat := by
  have hstep : ∀ i, i < n →
      (share i).postedAmount.toRat = boundary share (i + 1) - boundary share i := by
    intro i hi
    obtain ⟨-, -, -, -, -, -, -, -, -, -, hpost, -, -⟩ :=
      share_facts hT (hf i (by omega)) (hf (i + 1) (by omega)) (h i hi)
    rw [hpost]
    cases i with
    | zero => rfl
    | succ j =>
      have e := share_before_eq_after (h j (by omega)) (h (j + 1) hi)
      show _ - _ = (share (j + 1)).afterQuantization.amount.toRat -
        (share j).afterQuantization.amount.toRat
      rw [e]
  have hsum : ((List.range n).map fun i => (share i).postedAmount.toRat) =
      (List.range n).map fun i => boundary share (i + 1) - boundary share i :=
    List.map_congr_left fun i hi => hstep i (List.mem_range.mp hi)
  rw [hsum, sum_range_telescope]
  cases n with
  | zero => exact absurd (h0.symm.trans h1) (by norm_num)
  | succ m =>
    obtain ⟨-, -, -, -, -, -, hatwf, hattr, -, haq, -, ⟨c, hc⟩, -⟩ :=
      share_facts hT (hf m (by omega)) (hf (m + 1) le_rfl) (h m (by omega))
    have hlast : boundary share (m + 1) = postedTotal.toRat := by
      show (share m).afterQuantization.amount.toRat = _
      rw [(quantize_representable hatwf haq (c := c) (by rw [hattr, h1, mul_one, hc])).2.1,
        hattr, h1, mul_one]
    obtain ⟨-, -, -, -, hbtwf, hbttr, -, -, hbq, -, -, -, -⟩ :=
      share_facts hT (hf 0 (by omega)) (hf (0 + 1) (by omega)) (h 0 (by omega))
    have hfirst : boundary share 0 = 0 := by
      show (share 0).beforeQuantization.amount.toRat = 0
      rw [(quantize_representable hbtwf hbq (c := 0) (by rw [hbttr, h0]; simp)).2.1,
        hbttr, h0, mul_zero]
    rw [hlast, hfirst, sub_zero]

/-! ## What the TypeScript does that a caller may not expect

Each is the behaviour of `packages/kernel/src/quantization.ts`, kept by the model; the laws
above hold whenever the calls return.

- `quantize` throws a `RangeError`, which has no `ExactNumberErrorCode`, for a scale outside
  0 to 1000 (lines 123-125): `QuantizeErr.scaleOutOfRange`. `quantizeCumulativePostedShare`
  rejects the same scale instead (line 70).
- `quantize` throws `representation_limit_exceeded` when the rounded coefficient is beyond
  the size limit (line 132), or when the subtraction that makes the residual multiplies the
  two denominators beyond it (line 133): the value 1/2^16383 at scale 2, rounded up.
- `quantizeCumulativePostedShare` throws `representation_limit_exceeded`, and does not
  reject, when the total times a fraction has a denominator beyond the size limit before it
  is reduced (lines 85-86): the total 0.5 at scale 1 with the fraction 1/2^16383.
- With half even a posted amount can be exactly one unit from its exact share, as the example
  above shows; in the other four modes it is always less than one unit.
- `quantizeCumulativePostedShare` does not test that the first fraction is zero or the last
  is one; `cumulativeShares_sum` assumes both.
-/

end Rastrata.Kernel

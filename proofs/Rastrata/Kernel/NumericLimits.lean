/-
Exact numbers: when the operations of `packages/kernel/src/numeric.ts` fail, and the order.

The model and its contract are in `Rastrata/Kernel/Numeric.lean`. This file says exactly when
`add`, `subtract`, `multiply` and `divide` are refused and with which error, gives a plain
sufficient condition for success, pins down that the size is checked before a fraction is
reduced, proves that `compare` is a total order on constructible values, and that a
constructible decimal always converts to a fraction.

No proof here evaluates `2 ^ maxExactIntegerBits`: the limit stays a name.
-/
import Rastrata.Kernel.Numeric

namespace Rastrata.Kernel

namespace ExactRational

/-! ## What `of` answers -/

/-- `of` refuses for the denominator exactly when the denominator is not positive. -/
theorem of_eq_invalidRational_iff (n d : Int) :
    of n d = .error .invalidRational ↔ d ≤ 0 := by
  unfold of
  by_cases hd : d ≤ 0
  · simp [hd]
  · by_cases hn : n = 0
    · simp [hd, hn]
    · by_cases hwn : withinMagnitude n = true
      · by_cases hwd : withinMagnitude d = true
        · simp [hd, hn, hwn, hwd]
        · simp [hd, hn, hwn, hwd]
      · simp [hd, hn, hwn]

/-- `of` refuses for size exactly when the denominator is positive, the numerator is not zero
and one of the two parts, as given and before any reduction, is beyond the admitted size. -/
theorem of_eq_limit_iff (n d : Int) :
    of n d = .error .representationLimitExceeded ↔
      0 < d ∧ n ≠ 0 ∧ ¬ (withinMagnitude n = true ∧ withinMagnitude d = true) := by
  unfold of
  by_cases hd : d ≤ 0
  · simp [hd]
  · have hd' : 0 < d := by omega
    by_cases hn : n = 0
    · simp [hd, hn]
    · by_cases hwn : withinMagnitude n = true
      · by_cases hwd : withinMagnitude d = true
        · simp [hd, hd', hn, hwn, hwd]
        · simp [hd, hd', hn, hwn, hwd]
      · simp [hd, hd', hn, hwn]

/-- `of` never answers with an error other than the denominator error and the size error. -/
theorem of_error {n d : Int} {e : NumErr} (h : of n d = .error e) :
    e = .invalidRational ∨ e = .representationLimitExceeded := by
  unfold of at h
  split_ifs at h <;> simp_all

/-- With a positive denominator `of` either succeeds or refuses for size. -/
theorem of_ok_or_limit {n d : Int} (hd : 0 < d) :
    (∃ r, of n d = .ok r) ∨ of n d = .error .representationLimitExceeded := by
  by_cases h : n = 0 ∨ (withinMagnitude n = true ∧ withinMagnitude d = true)
  · exact Or.inl ((of_isOk_iff n d).mpr ⟨hd, h⟩)
  · right
    rw [of_eq_limit_iff]
    exact ⟨hd, fun hn => h (Or.inl hn), fun hw => h (Or.inr hw)⟩

/-! ## When each operation succeeds, and which error it gives when it does not -/

/-- A constructible value added to another succeeds exactly when the unreduced numerator is
zero or both unreduced parts are within the admitted size. -/
theorem add_isOk_iff {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    (∃ c, a.add b = .ok c) ↔
      (a.numerator * b.denominator + b.numerator * a.denominator = 0 ∨
        (withinMagnitude (a.numerator * b.denominator + b.numerator * a.denominator) = true ∧
          withinMagnitude (a.denominator * b.denominator) = true)) := by
  unfold add
  rw [of_isOk_iff]
  have : 0 < a.denominator * b.denominator := Int.mul_pos ha.denominator_pos hb.denominator_pos
  exact ⟨fun h => h.2, fun h => ⟨this, h⟩⟩

/-- When adding two constructible values does not succeed, the error is the size error. -/
theorem add_ok_or_limit {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    (∃ c, a.add b = .ok c) ∨ a.add b = .error .representationLimitExceeded :=
  of_ok_or_limit (Int.mul_pos ha.denominator_pos hb.denominator_pos)

/-- Adding two constructible values is refused for size exactly when the unreduced numerator
is not zero and one of the unreduced parts is beyond the admitted size. -/
theorem add_eq_limit_iff {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    a.add b = .error .representationLimitExceeded ↔
      (a.numerator * b.denominator + b.numerator * a.denominator ≠ 0 ∧
        ¬ (withinMagnitude (a.numerator * b.denominator + b.numerator * a.denominator) = true ∧
          withinMagnitude (a.denominator * b.denominator) = true)) := by
  unfold add
  rw [of_eq_limit_iff]
  have : 0 < a.denominator * b.denominator := Int.mul_pos ha.denominator_pos hb.denominator_pos
  exact ⟨fun h => h.2, fun h => ⟨this, h⟩⟩

/-- A constructible value less another succeeds exactly when the unreduced numerator is zero
or both unreduced parts are within the admitted size. -/
theorem subtract_isOk_iff {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    (∃ c, a.subtract b = .ok c) ↔
      (a.numerator * b.denominator + -b.numerator * a.denominator = 0 ∨
        (withinMagnitude (a.numerator * b.denominator + -b.numerator * a.denominator) = true ∧
          withinMagnitude (a.denominator * b.denominator) = true)) :=
  add_isOk_iff ha (negate_wf hb)

/-- When subtracting two constructible values does not succeed, the error is the size error. -/
theorem subtract_ok_or_limit {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    (∃ c, a.subtract b = .ok c) ∨ a.subtract b = .error .representationLimitExceeded :=
  add_ok_or_limit ha (negate_wf hb)

/-- Subtracting two constructible values is refused for size exactly when the unreduced
numerator is not zero and one of the unreduced parts is beyond the admitted size. -/
theorem subtract_eq_limit_iff {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    a.subtract b = .error .representationLimitExceeded ↔
      (a.numerator * b.denominator + -b.numerator * a.denominator ≠ 0 ∧
        ¬ (withinMagnitude (a.numerator * b.denominator + -b.numerator * a.denominator) = true ∧
          withinMagnitude (a.denominator * b.denominator) = true)) :=
  add_eq_limit_iff ha (negate_wf hb)

/-- A constructible value less itself always succeeds, whatever its size. -/
theorem subtract_self {a : ExactRational} (ha : a.WF) : a.subtract a = .ok zero := by
  unfold subtract add negate of
  have h0 : a.numerator * a.denominator + -a.numerator * a.denominator = 0 := by ring
  have hd : ¬ a.denominator * a.denominator ≤ 0 := by
    have := Int.mul_pos ha.denominator_pos ha.denominator_pos
    omega
  simp only [h0, hd, ↓reduceIte, zero]

/-- A constructible value times another succeeds exactly when the unreduced numerator is zero
or both unreduced parts are within the admitted size. -/
theorem multiply_isOk_iff {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    (∃ c, a.multiply b = .ok c) ↔
      (a.numerator * b.numerator = 0 ∨
        (withinMagnitude (a.numerator * b.numerator) = true ∧
          withinMagnitude (a.denominator * b.denominator) = true)) := by
  unfold multiply
  rw [of_isOk_iff]
  have : 0 < a.denominator * b.denominator := Int.mul_pos ha.denominator_pos hb.denominator_pos
  exact ⟨fun h => h.2, fun h => ⟨this, h⟩⟩

/-- When multiplying two constructible values does not succeed, the error is the size error. -/
theorem multiply_ok_or_limit {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    (∃ c, a.multiply b = .ok c) ∨ a.multiply b = .error .representationLimitExceeded :=
  of_ok_or_limit (Int.mul_pos ha.denominator_pos hb.denominator_pos)

/-- Multiplying two constructible values is refused for size exactly when the unreduced
numerator is not zero and one of the unreduced parts is beyond the admitted size. -/
theorem multiply_eq_limit_iff {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    a.multiply b = .error .representationLimitExceeded ↔
      (a.numerator * b.numerator ≠ 0 ∧
        ¬ (withinMagnitude (a.numerator * b.numerator) = true ∧
          withinMagnitude (a.denominator * b.denominator) = true)) := by
  unfold multiply
  rw [of_eq_limit_iff]
  have : 0 < a.denominator * b.denominator := Int.mul_pos ha.denominator_pos hb.denominator_pos
  exact ⟨fun h => h.2, fun h => ⟨this, h⟩⟩

/-- `divide`, with its two branches written as one: the sign of the unreduced denominator is
moved to the numerator. -/
theorem divide_def (a : ExactRational) {b : ExactRational} (hb : b.numerator ≠ 0) :
    a.divide b =
      if a.denominator * b.numerator < 0
      then of (-(a.numerator * b.denominator)) (-(a.denominator * b.numerator))
      else of (a.numerator * b.denominator) (a.denominator * b.numerator) := by
  simp only [divide, hb, ↓reduceIte]

/-- A constructible value divided by any value succeeds exactly when the divisor is not zero
and the unreduced numerator is zero or both unreduced parts are within the admitted size. -/
theorem divide_isOk_iff {a b : ExactRational} (ha : a.WF) :
    (∃ c, a.divide b = .ok c) ↔
      b.numerator ≠ 0 ∧
        (a.numerator * b.denominator = 0 ∨
          (withinMagnitude (a.numerator * b.denominator) = true ∧
            withinMagnitude (a.denominator * b.numerator) = true)) := by
  by_cases hbn : b.numerator = 0
  · simp [divide, hbn]
  · have hne : a.denominator * b.numerator ≠ 0 :=
      Int.mul_ne_zero (by have := ha.denominator_pos; omega) hbn
    rw [divide_def a hbn]
    split_ifs with hneg
    · rw [of_isOk_iff, withinMagnitude_neg, withinMagnitude_neg, Int.neg_eq_zero]
      exact ⟨fun h => ⟨hbn, h.2⟩, fun h => ⟨by omega, h.2⟩⟩
    · rw [of_isOk_iff]
      exact ⟨fun h => ⟨hbn, h.2⟩, fun h => ⟨by omega, h.2⟩⟩

/-- Dividing a constructible value is refused as an invalid fraction exactly when the
divisor is zero. -/
theorem divide_eq_invalidRational_iff {a b : ExactRational} (ha : a.WF) :
    a.divide b = .error .invalidRational ↔ b.numerator = 0 := by
  by_cases hbn : b.numerator = 0
  · simp [divide, hbn]
  · have hne : a.denominator * b.numerator ≠ 0 :=
      Int.mul_ne_zero (by have := ha.denominator_pos; omega) hbn
    rw [divide_def a hbn]
    split_ifs with hneg
    · rw [of_eq_invalidRational_iff]
      exact ⟨fun h => by omega, fun h => absurd h hbn⟩
    · rw [of_eq_invalidRational_iff]
      exact ⟨fun h => by omega, fun h => absurd h hbn⟩

/-- Dividing a constructible value is refused for size exactly when the divisor is not
zero, the unreduced numerator is not zero and one of the unreduced parts is beyond the
admitted size. -/
theorem divide_eq_limit_iff {a b : ExactRational} (ha : a.WF) :
    a.divide b = .error .representationLimitExceeded ↔
      b.numerator ≠ 0 ∧ a.numerator * b.denominator ≠ 0 ∧
        ¬ (withinMagnitude (a.numerator * b.denominator) = true ∧
          withinMagnitude (a.denominator * b.numerator) = true) := by
  by_cases hbn : b.numerator = 0
  · simp [divide, hbn]
  · have hne : a.denominator * b.numerator ≠ 0 :=
      Int.mul_ne_zero (by have := ha.denominator_pos; omega) hbn
    rw [divide_def a hbn]
    split_ifs with hneg
    · rw [of_eq_limit_iff, withinMagnitude_neg, withinMagnitude_neg, Ne, Int.neg_eq_zero]
      exact ⟨fun h => ⟨hbn, h.2⟩, fun h => ⟨by omega, h.2⟩⟩
    · rw [of_eq_limit_iff]
      exact ⟨fun h => ⟨hbn, h.2⟩, fun h => ⟨by omega, h.2⟩⟩

/-- When dividing a constructible value does not succeed, the divisor is zero and the
error says so, or the error is the size error. -/
theorem divide_ok_or_error {a b : ExactRational} (ha : a.WF) :
    (∃ c, a.divide b = .ok c) ∨
      (b.numerator = 0 ∧ a.divide b = .error .invalidRational) ∨
      (b.numerator ≠ 0 ∧ a.divide b = .error .representationLimitExceeded) := by
  by_cases hbn : b.numerator = 0
  · exact Or.inr (Or.inl ⟨hbn, (divide_eq_invalidRational_iff ha).mpr hbn⟩)
  · by_cases h : a.numerator * b.denominator = 0 ∨
        (withinMagnitude (a.numerator * b.denominator) = true ∧
          withinMagnitude (a.denominator * b.numerator) = true)
    · exact Or.inl ((divide_isOk_iff ha).mpr ⟨hbn, h⟩)
    · exact Or.inr (Or.inr ⟨hbn, (divide_eq_limit_iff ha).mpr
        ⟨hbn, fun h0 => h (Or.inl h0), fun hw => h (Or.inr hw)⟩⟩)

/-! ## A plain sufficient condition

Stated with the limit as a name. The two helpers are about any exponent `k`, so nothing here
looks at the digits of the limit. -/

/-- A product of two numbers below `2 ^ k` in absolute value is below `2 ^ (k + k)`. -/
private theorem natAbs_mul_lt {p q : Int} {k : Nat}
    (hp : p.natAbs < 2 ^ k) (hq : q.natAbs < 2 ^ k) : (p * q).natAbs < 2 ^ (k + k) := by
  rw [Int.natAbs_mul, pow_add]
  exact Nat.mul_lt_mul'' hp hq

/-- A sum of two such products is below `2 ^ (k + k + 1)`. -/
private theorem natAbs_cross_lt {p q r s : Int} {k : Nat}
    (hp : p.natAbs < 2 ^ k) (hq : q.natAbs < 2 ^ k) (hr : r.natAbs < 2 ^ k)
    (hs : s.natAbs < 2 ^ k) : (p * q + r * s).natAbs < 2 ^ (k + k + 1) := by
  have h1 := natAbs_mul_lt hp hq
  have h2 := natAbs_mul_lt hr hs
  have h3 := Int.natAbs_add_le (p * q) (r * s)
  rw [pow_succ]
  generalize 2 ^ (k + k) = B at *
  omega

/-- Twice one less than half the bit limit, plus one, is within the bit limit. -/
private theorem half_less_one_twice : maxExactIntegerBits / 2 - 1 + (maxExactIntegerBits / 2 - 1) + 1 ≤
    maxExactIntegerBits := by
  have h : 0 < maxExactIntegerBits := by decide
  omega

/-- Two constructible values whose four parts are all below `2 ^ (maxExactIntegerBits / 2 - 1)`
in absolute value can always be added. -/
theorem add_isOk_of_small {a b : ExactRational} (ha : a.WF) (hb : b.WF)
    (han : a.numerator.natAbs < 2 ^ (maxExactIntegerBits / 2 - 1))
    (had : a.denominator.natAbs < 2 ^ (maxExactIntegerBits / 2 - 1))
    (hbn : b.numerator.natAbs < 2 ^ (maxExactIntegerBits / 2 - 1))
    (hbd : b.denominator.natAbs < 2 ^ (maxExactIntegerBits / 2 - 1)) :
    ∃ c, a.add b = .ok c := by
  rw [add_isOk_iff ha hb]
  right
  rw [withinMagnitude_iff, withinMagnitude_iff]
  constructor
  · exact Nat.lt_of_lt_of_le (natAbs_cross_lt han hbd hbn had)
      (Nat.pow_le_pow_right (by decide) half_less_one_twice)
  · exact Nat.lt_of_lt_of_le (natAbs_mul_lt had hbd)
      (Nat.pow_le_pow_right (by decide) (Nat.le_of_succ_le half_less_one_twice))

/-- Two constructible values whose four parts are all below `2 ^ (maxExactIntegerBits / 2 - 1)`
in absolute value can always be subtracted. -/
theorem subtract_isOk_of_small {a b : ExactRational} (ha : a.WF) (hb : b.WF)
    (han : a.numerator.natAbs < 2 ^ (maxExactIntegerBits / 2 - 1))
    (had : a.denominator.natAbs < 2 ^ (maxExactIntegerBits / 2 - 1))
    (hbn : b.numerator.natAbs < 2 ^ (maxExactIntegerBits / 2 - 1))
    (hbd : b.denominator.natAbs < 2 ^ (maxExactIntegerBits / 2 - 1)) :
    ∃ c, a.subtract b = .ok c :=
  add_isOk_of_small ha (negate_wf hb) han had
    (by rw [negate, Int.natAbs_neg]; exact hbn) hbd

/-- Two constructible values whose four parts are all below `2 ^ (maxExactIntegerBits / 2)` in
absolute value can always be multiplied. -/
theorem multiply_isOk_of_small {a b : ExactRational} (ha : a.WF) (hb : b.WF)
    (han : a.numerator.natAbs < 2 ^ (maxExactIntegerBits / 2))
    (had : a.denominator.natAbs < 2 ^ (maxExactIntegerBits / 2))
    (hbn : b.numerator.natAbs < 2 ^ (maxExactIntegerBits / 2))
    (hbd : b.denominator.natAbs < 2 ^ (maxExactIntegerBits / 2)) :
    ∃ c, a.multiply b = .ok c := by
  have hle : maxExactIntegerBits / 2 + maxExactIntegerBits / 2 ≤ maxExactIntegerBits := by omega
  rw [multiply_isOk_iff ha hb]
  right
  rw [withinMagnitude_iff, withinMagnitude_iff]
  exact ⟨Nat.lt_of_lt_of_le (natAbs_mul_lt han hbn) (Nat.pow_le_pow_right (by decide) hle),
    Nat.lt_of_lt_of_le (natAbs_mul_lt had hbd) (Nat.pow_le_pow_right (by decide) hle)⟩

/-- A constructible value can always be divided by a constructible value that is not zero when
all four parts are below `2 ^ (maxExactIntegerBits / 2)` in absolute value. -/
theorem divide_isOk_of_small {a b : ExactRational} (ha : a.WF) (hb : b.numerator ≠ 0)
    (han : a.numerator.natAbs < 2 ^ (maxExactIntegerBits / 2))
    (had : a.denominator.natAbs < 2 ^ (maxExactIntegerBits / 2))
    (hbn : b.numerator.natAbs < 2 ^ (maxExactIntegerBits / 2))
    (hbd : b.denominator.natAbs < 2 ^ (maxExactIntegerBits / 2)) :
    ∃ c, a.divide b = .ok c := by
  have hle : maxExactIntegerBits / 2 + maxExactIntegerBits / 2 ≤ maxExactIntegerBits := by omega
  rw [divide_isOk_iff ha]
  refine ⟨hb, Or.inr ?_⟩
  rw [withinMagnitude_iff, withinMagnitude_iff]
  exact ⟨Nat.lt_of_lt_of_le (natAbs_mul_lt han hbd) (Nat.pow_le_pow_right (by decide) hle),
    Nat.lt_of_lt_of_le (natAbs_mul_lt had hbn) (Nat.pow_le_pow_right (by decide) hle)⟩

/-! ## The size is checked before the fraction is reduced

`of` looks at the two parts as they are given (`numeric.ts`, lines 137 and 138) and only then
divides them by their greatest common divisor (lines 140 and 141). So it refuses a fraction
whose reduced form fits, and `add` refuses a sum that fits. The helpers are about any
exponent, so nothing here looks at the digits of the limit. -/

/-- The absolute value of a power of two is that power of two. -/
private theorem natAbs_two_pow (m : Nat) : ((2 : Int) ^ m).natAbs = 2 ^ m := by
  rw [Int.natAbs_pow]
  rfl

/-- A power of two below the bit limit is within the admitted size. -/
private theorem within_two_pow {m : Nat} (h : m < maxExactIntegerBits) :
    withinMagnitude ((2 : Int) ^ m) = true := by
  rw [withinMagnitude_iff, natAbs_two_pow]
  exact Nat.pow_lt_pow_right (by decide) h

/-- A power of two at or above the bit limit is beyond the admitted size. -/
private theorem not_within_two_pow {m : Nat} (h : maxExactIntegerBits ≤ m) :
    ¬ withinMagnitude ((2 : Int) ^ m) = true := by
  rw [withinMagnitude_iff, natAbs_two_pow]
  exact Nat.not_lt.mpr (Nat.pow_le_pow_right (by decide) h)

/-- A whole number within the admitted size is a constructible value. -/
private theorem whole_wf {n : Int} (h : withinMagnitude n = true) :
    (⟨n, 1⟩ : ExactRational).WF :=
  ⟨Int.one_pos, Int.gcd_one_right .., h, withinMagnitude_one⟩

/-- One over a positive number within the admitted size is a constructible value. -/
private theorem unit_fraction_wf {d : Int} (hd : 0 < d) (h : withinMagnitude d = true) :
    (⟨1, d⟩ : ExactRational).WF :=
  ⟨hd, Int.gcd_one_left .., withinMagnitude_one, h⟩

/-- A power of two is the next power of two over two. -/
private theorem two_pow_toRat (k : Nat) :
    (⟨2 ^ k, 1⟩ : ExactRational).toRat = (((2 : Int) ^ (k + 1) : Int) : ℚ) / ((2 : Int) : ℚ) := by
  simp only [toRat]
  push_cast
  rw [pow_succ]
  field_simp

/-- `of` refuses `2 ^ maxExactIntegerBits` over `2`. -/
theorem of_two_pow_limit :
    of (2 ^ maxExactIntegerBits) 2 = .error .representationLimitExceeded := by
  rw [of_eq_limit_iff]
  exact ⟨by decide, pow_ne_zero _ (by decide), fun h => not_within_two_pow (Nat.le_refl _) h.1⟩

/-- `2 ^ (maxExactIntegerBits - 1)` is a constructible value. -/
theorem two_pow_pred_wf : (⟨2 ^ (maxExactIntegerBits - 1), 1⟩ : ExactRational).WF :=
  whole_wf (within_two_pow (by decide))

/-- `2 ^ (maxExactIntegerBits - 1)` is the number `2 ^ maxExactIntegerBits` over `2`. -/
theorem two_pow_pred_toRat :
    (⟨2 ^ (maxExactIntegerBits - 1), 1⟩ : ExactRational).toRat =
      (((2 : Int) ^ maxExactIntegerBits : Int) : ℚ) / ((2 : Int) : ℚ) := by
  obtain ⟨k, hk⟩ : ∃ k, maxExactIntegerBits = k + 1 := ⟨maxExactIntegerBits - 1, by decide⟩
  have hk' : maxExactIntegerBits - 1 = k := by omega
  rw [hk', hk]
  exact two_pow_toRat k

/-- The size is checked before the fraction is reduced: `of` refuses a fraction with a positive
denominator although a constructible value means the same number. -/
theorem of_refuses_a_value_that_fits :
    ∃ n d : Int, 0 < d ∧ of n d = .error .representationLimitExceeded ∧
      ∃ r : ExactRational, r.WF ∧ r.toRat = (n : ℚ) / (d : ℚ) :=
  ⟨2 ^ maxExactIntegerBits, 2, by decide, of_two_pow_limit,
    ⟨2 ^ (maxExactIntegerBits - 1), 1⟩, two_pow_pred_wf, two_pow_pred_toRat⟩

/-- One over a power of two at least half the bit limit cannot be added to itself. -/
private theorem unit_fraction_add_limit {k : Nat} (hk : k < maxExactIntegerBits)
    (h : maxExactIntegerBits ≤ k + k) :
    (⟨1, 2 ^ k⟩ : ExactRational).add ⟨1, 2 ^ k⟩ = .error .representationLimitExceeded := by
  have hwf : (⟨1, 2 ^ k⟩ : ExactRational).WF :=
    unit_fraction_wf (by positivity) (within_two_pow hk)
  rw [add_eq_limit_iff hwf hwf]
  dsimp only
  refine ⟨by positivity, fun hw => ?_⟩
  have h2 := hw.2
  rw [← pow_add] at h2
  exact not_within_two_pow h h2

/-- One over a power of two is twice one over the next power of two. -/
private theorem unit_fraction_double (k : Nat) :
    (⟨1, 2 ^ k⟩ : ExactRational).toRat =
      (⟨1, 2 ^ (k + 1)⟩ : ExactRational).toRat + (⟨1, 2 ^ (k + 1)⟩ : ExactRational).toRat := by
  simp only [toRat]
  push_cast
  rw [pow_succ]
  field_simp
  ring

/-- One over `2 ^ (maxExactIntegerBits / 2)` cannot be added to itself. -/
theorem add_half_limit_unit_fraction :
    (⟨1, 2 ^ (maxExactIntegerBits / 2)⟩ : ExactRational).add ⟨1, 2 ^ (maxExactIntegerBits / 2)⟩ =
      .error .representationLimitExceeded :=
  unit_fraction_add_limit (by decide) (by decide)

/-- The size is checked before the sum is reduced: `add` refuses two constructible values
although a constructible value means their exact sum. -/
theorem add_refuses_a_sum_that_fits :
    ∃ a b : ExactRational, a.WF ∧ b.WF ∧ a.add b = .error .representationLimitExceeded ∧
      ∃ r : ExactRational, r.WF ∧ r.toRat = a.toRat + b.toRat := by
  obtain ⟨k, hk⟩ : ∃ k, maxExactIntegerBits / 2 = k + 1 := ⟨maxExactIntegerBits / 2 - 1, by decide⟩
  have hlt : k + 1 < maxExactIntegerBits := by omega
  have hwf : (⟨1, 2 ^ (k + 1)⟩ : ExactRational).WF :=
    unit_fraction_wf (by positivity) (within_two_pow hlt)
  refine ⟨⟨1, 2 ^ (k + 1)⟩, ⟨1, 2 ^ (k + 1)⟩, hwf, hwf, ?_, ⟨1, 2 ^ k⟩, ?_, unit_fraction_double k⟩
  · have h := add_half_limit_unit_fraction
    rw [hk] at h
    exact h
  · exact unit_fraction_wf (by positivity) (within_two_pow (by omega))

/-- Two constructible values whose denominators both reach `2 ^ (maxExactIntegerBits / 2)`
cannot be added unless their sum is zero, even when the denominators are the same. -/
theorem add_eq_limit_of_large_denominators {a b : ExactRational} (ha : a.WF) (hb : b.WF)
    (had : 2 ^ (maxExactIntegerBits / 2) ≤ a.denominator.natAbs)
    (hbd : 2 ^ (maxExactIntegerBits / 2) ≤ b.denominator.natAbs)
    (hn : a.numerator * b.denominator + b.numerator * a.denominator ≠ 0) :
    a.add b = .error .representationLimitExceeded := by
  rw [add_eq_limit_iff ha hb]
  refine ⟨hn, fun hw => ?_⟩
  have h2 := hw.2
  rw [withinMagnitude_iff, Int.natAbs_mul] at h2
  have h3 : 2 ^ maxExactIntegerBits ≤ 2 ^ (maxExactIntegerBits / 2 + maxExactIntegerBits / 2) :=
    Nat.pow_le_pow_right (by decide) (by decide)
  rw [pow_add] at h3
  exact Nat.lt_irrefl _ (Nat.lt_of_lt_of_le h2 (Nat.le_trans h3 (Nat.mul_le_mul had hbd)))

/-! ## `compare` is a total order on constructible values -/

/-- A value compares equal to itself. -/
theorem compare_self (a : ExactRational) : a.compare a = .eq := by
  rw [compare_def]
  simp

/-- Two constructible values compare equal exactly when they are the same value. -/
theorem compare_eq_iff_eq {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    a.compare b = .eq ↔ a = b := by
  rw [compare_eq_iff ha hb]
  exact ⟨eq_of_toRat_eq ha hb, fun h => by rw [h]⟩

/-- The first value is below the second exactly when the second is above the first. -/
theorem compare_lt_iff_gt (a b : ExactRational) : a.compare b = .lt ↔ b.compare a = .gt := by
  rw [compare_def, compare_def]
  constructor
  · intro h
    split_ifs at h with h1
    · simp only [show ¬ b.numerator * a.denominator - a.numerator * b.denominator < 0 from by omega,
        show b.numerator * a.denominator - a.numerator * b.denominator > 0 from by omega, ↓reduceIte]
  · intro h
    split_ifs at h with h1 h2
    · simp only [show a.numerator * b.denominator - b.numerator * a.denominator < 0 from by omega,
        ↓reduceIte]

/-- The first value equals the second exactly when the second equals the first. -/
theorem compare_eq_comm (a b : ExactRational) : a.compare b = .eq ↔ b.compare a = .eq := by
  rw [compare_def, compare_def]
  constructor
  · intro h
    split_ifs at h with h1 h2
    · simp only [show ¬ b.numerator * a.denominator - a.numerator * b.denominator < 0 from by omega,
        show ¬ b.numerator * a.denominator - a.numerator * b.denominator > 0 from by omega, ↓reduceIte]
  · intro h
    split_ifs at h with h1 h2
    · simp only [show ¬ a.numerator * b.denominator - b.numerator * a.denominator < 0 from by omega,
        show ¬ a.numerator * b.denominator - b.numerator * a.denominator > 0 from by omega, ↓reduceIte]

/-- Swapping the two values swaps below and above and keeps equal. -/
theorem compare_swap (a b : ExactRational) : b.compare a = (a.compare b).swap := by
  cases h : a.compare b
  · exact (compare_lt_iff_gt a b).mp h
  · exact (compare_eq_comm a b).mp h
  · exact (compare_lt_iff_gt b a).mpr h

/-- Below is transitive: if the first is below the second and the second below the third,
the first is below the third. -/
theorem compare_lt_trans {a b c : ExactRational} (ha : a.WF) (hb : b.WF) (hc : c.WF)
    (hab : a.compare b = .lt) (hbc : b.compare c = .lt) : a.compare c = .lt := by
  rw [compare_lt_iff ha hc]
  exact lt_trans ((compare_lt_iff ha hb).mp hab) ((compare_lt_iff hb hc).mp hbc)

/-- Above is transitive: if the first is above the second and the second above the third,
the first is above the third. -/
theorem compare_gt_trans {a b c : ExactRational} (ha : a.WF) (hb : b.WF) (hc : c.WF)
    (hab : a.compare b = .gt) (hbc : b.compare c = .gt) : a.compare c = .gt := by
  rw [compare_gt_iff ha hc]
  exact lt_trans ((compare_gt_iff hb hc).mp hbc) ((compare_gt_iff ha hb).mp hab)

/-- Of two constructible values exactly one holds: the first is below the second, they are
the same value, or the first is above the second. -/
theorem compare_trichotomy {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    (a.compare b = .lt ∧ a ≠ b ∧ b.compare a = .gt) ∨
    (a.compare b = .eq ∧ a = b ∧ b.compare a = .eq) ∨
    (a.compare b = .gt ∧ a ≠ b ∧ b.compare a = .lt) := by
  cases h : a.compare b
  · refine Or.inl ⟨rfl, fun he => ?_, (compare_lt_iff_gt a b).mp h⟩
    rw [(compare_eq_iff_eq ha hb).mpr he] at h
    cases h
  · exact Or.inr (Or.inl ⟨rfl, (compare_eq_iff_eq ha hb).mp h, (compare_eq_comm a b).mp h⟩)
  · refine Or.inr (Or.inr ⟨rfl, fun he => ?_, (compare_lt_iff_gt b a).mpr h⟩)
    rw [(compare_eq_iff_eq ha hb).mpr he] at h
    cases h

/-- `compare` orders constructible values as the numbers they mean. -/
theorem compare_eq_compare_toRat {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    a.compare b = Ord.compare a.toRat b.toRat := by
  rcases lt_trichotomy a.toRat b.toRat with h | h | h
  · rw [(compare_lt_iff ha hb).mpr h, eq_comm, compare_lt_iff_lt]
    exact h
  · rw [(compare_eq_iff ha hb).mpr h, eq_comm, _root_.compare_eq_iff_eq]
    exact h
  · rw [(compare_gt_iff ha hb).mpr h, eq_comm, compare_gt_iff_gt]
    exact h

end ExactRational

namespace ExactDecimal

/-! ## What `ExactDecimal.of` answers

The scale is checked before the coefficient (`numeric.ts`, lines 66 and 67), so a decimal that
is wrong in both ways is refused for its scale. -/

/-- `of` makes a decimal exactly when the scale is from zero to `maxDecimalScale` and the
coefficient is within the admitted size, and then the decimal has those two parts. -/
theorem of_eq_ok_iff (c s : Int) (d : ExactDecimal) :
    of c s = .ok d ↔
      0 ≤ s ∧ s ≤ maxDecimalScale ∧ withinMagnitude c = true ∧ d = ⟨c, s⟩ := by
  unfold of scaleError
  by_cases h1 : s < 0
  · simp only [h1, ↓reduceIte]
    exact ⟨fun h => (nomatch h), fun h => absurd h.1 (Int.not_le.mpr h1)⟩
  · by_cases h2 : s > maxDecimalScale
    · simp only [h1, h2, ↓reduceIte]
      exact ⟨fun h => (nomatch h), fun h => absurd h.2.1 (Int.not_le.mpr h2)⟩
    · by_cases hw : withinMagnitude c = true
      · simp only [h1, h2, hw, ↓reduceIte, Bool.not_true, Bool.false_eq_true]
        constructor
        · intro h
          cases h
          exact ⟨Int.not_lt.mp h1, Int.not_lt.mp h2, trivial, rfl⟩
        · rintro ⟨-, -, -, rfl⟩
          rfl
      · constructor
        · intro h
          simp [h1, h2, hw] at h
        · intro h
          exact absurd h.2.2.1 hw

/-- `of` refuses a decimal as invalid exactly when the scale is negative. -/
theorem of_eq_invalidDecimal_iff (c s : Int) : of c s = .error .invalidDecimal ↔ s < 0 := by
  unfold of scaleError
  by_cases h1 : s < 0
  · simp [h1]
  · by_cases h2 : s > maxDecimalScale
    · simp [h1, h2]
    · by_cases hw : withinMagnitude c = true
      · simp [h1, h2, hw]
      · simp [h1, h2, hw]

/-- `of` refuses a decimal for its scale exactly when the scale is above `maxDecimalScale`,
whatever the size of the coefficient. -/
theorem of_eq_scaleLimit_iff (c s : Int) :
    of c s = .error .scaleLimitExceeded ↔ maxDecimalScale < s := by
  have hmax : (0 : Int) ≤ maxDecimalScale := by decide
  unfold of scaleError
  by_cases h1 : s < 0
  · have h2 : ¬ maxDecimalScale < s := by omega
    simp [h1, h2]
  · by_cases h2 : s > maxDecimalScale
    · simp [h1, h2]
    · by_cases hw : withinMagnitude c = true
      · simp [h1, h2, hw]
      · simp [h1, h2, hw]

/-- `of` refuses a decimal for size exactly when the scale is from zero to `maxDecimalScale`
and the coefficient is beyond the admitted size. -/
theorem of_eq_limit_iff (c s : Int) :
    of c s = .error .representationLimitExceeded ↔
      0 ≤ s ∧ s ≤ maxDecimalScale ∧ ¬ withinMagnitude c = true := by
  unfold of scaleError
  by_cases h1 : s < 0
  · have h0 : ¬ 0 ≤ s := by omega
    simp [h1, h0]
  · by_cases h2 : s > maxDecimalScale
    · have h3 : ¬ s ≤ maxDecimalScale := by omega
      simp [h1, h2, h3]
    · have h0 : 0 ≤ s := by omega
      have h3 : s ≤ maxDecimalScale := by omega
      by_cases hw : withinMagnitude c = true
      · simp [h1, h2, hw]
      · simp [h1, h2, h0, h3, hw]

/-! ## A constructible decimal always converts to a fraction

The largest denominator is `10 ^ maxDecimalScale`. It is below `2 ^ maxExactIntegerBits`
because `10 < 2 ^ 4` and four times the scale limit is below the bit limit; neither power is
evaluated. -/

/-- A power of ten is below any power of two with more than four times its exponent. -/
private theorem ten_pow_lt_two_pow {k m : Nat} (h : 4 * k < m) : 10 ^ k < 2 ^ m := by
  have h1 : 10 ^ k ≤ (2 ^ 4) ^ k := Nat.pow_le_pow_left (by decide) k
  rw [← pow_mul] at h1
  exact Nat.lt_of_le_of_lt h1 (Nat.pow_lt_pow_right (by decide) h)

/-- The denominator a constructible decimal converts to is within the admitted size. -/
theorem ten_pow_scale_within {d : ExactDecimal} (hd : d.WF) :
    withinMagnitude ((10 : Int) ^ d.scale.toNat) = true := by
  have hs : d.scale ≤ 1000 := hd.scale_le
  have hM : 4 * 1000 < maxExactIntegerBits := by decide
  have h10 : (10 : Int).natAbs = 10 := rfl
  rw [withinMagnitude_iff, Int.natAbs_pow, h10]
  exact ten_pow_lt_two_pow (by omega)

/-- A constructible decimal always converts to a fraction; the fraction is constructible and
means the same number. -/
theorem toRational_isOk {d : ExactDecimal} (hd : d.WF) :
    ∃ r, d.toRational = .ok r ∧ r.WF ∧ r.toRat = d.toRat := by
  have h : ∃ r, d.toRational = .ok r := by
    unfold toRational
    rw [ExactRational.of_isOk_iff]
    exact ⟨by positivity, Or.inr ⟨hd.coefficient_within, ten_pow_scale_within hd⟩⟩
  obtain ⟨r, hr⟩ := h
  exact ⟨r, hr, toRational_ok hd hr⟩

/-- Converting a constructible decimal to a fraction never fails. -/
theorem toRational_ne_error {d : ExactDecimal} (hd : d.WF) (e : NumErr) :
    d.toRational ≠ .error e := by
  obtain ⟨r, hr, -⟩ := toRational_isOk hd
  rw [hr]
  exact fun h => by cases h

end ExactDecimal

end Rastrata.Kernel

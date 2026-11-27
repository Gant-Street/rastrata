/-
Exact numbers: the Lean model of `packages/kernel/src/numeric.ts`.

Every definition mirrors one TypeScript member, named in its doc comment. The model is
executable (it is run against the TypeScript on the same inputs) and keeps the limits the
TypeScript enforces, so an operation that throws there returns `.error` here.

`toRat` is the meaning of a value as a rational number. The laws of the kernel are stated
about meanings, and the lemmas at the end of this file carry a law from the meaning back to
the executable model.
-/
import Rastrata.Prelude

namespace Rastrata.Kernel

/-- `ExactNumberErrorCode`. -/
inductive NumErr where
  | invalidDecimal
  | invalidRational
  | representationLimitExceeded
  | scaleLimitExceeded
  deriving DecidableEq, Repr, Inhabited

/-- `MAX_DECIMAL_SCALE`. -/
def maxDecimalScale : Int := 1000

/-- `MAX_EXACT_INTEGER_BITS`. -/
def maxExactIntegerBits : Nat := 16384

/-- BigInt `/`: division that truncates toward zero. -/
abbrev jsDiv (a b : Int) : Int := Int.tdiv a b

/-- BigInt `%`: the remainder of `jsDiv`, with the sign of the dividend. -/
abbrev jsMod (a b : Int) : Int := Int.tmod a b

/-- `requireMagnitude` does not throw: zero, or at most `MAX_EXACT_INTEGER_BITS` binary digits. -/
def withinMagnitude (v : Int) : Bool := decide (v.natAbs < 2 ^ maxExactIntegerBits)

/-- `requireScale` does not throw. -/
def scaleError (scale : Int) : Option NumErr :=
  if scale < 0 then some .invalidDecimal
  else if scale > maxDecimalScale then some .scaleLimitExceeded
  else none

/-- `ExactRational`. Built only by `of`, `zero` and `negate`, as in the TypeScript. -/
structure ExactRational where
  numerator : Int
  denominator : Int
  deriving DecidableEq, Repr, Inhabited

/-- `ExactDecimal`. Built only by `of`, `parse` and `negate`, as in the TypeScript. -/
structure ExactDecimal where
  coefficient : Int
  scale : Int
  deriving DecidableEq, Repr, Inhabited

namespace ExactRational

/-- `ExactRational.of`. -/
def of (numerator denominator : Int) : Except NumErr ExactRational :=
  if denominator ≤ 0 then .error .invalidRational
  else if numerator = 0 then .ok ⟨0, 1⟩
  else if !withinMagnitude numerator then .error .representationLimitExceeded
  else if !withinMagnitude denominator then .error .representationLimitExceeded
  else
    let divisor : Int := (Int.gcd numerator denominator : Nat)
    .ok ⟨jsDiv numerator divisor, jsDiv denominator divisor⟩

/-- `ExactRational.zero`. -/
def zero : ExactRational := ⟨0, 1⟩

/-- `negate`. -/
def negate (r : ExactRational) : ExactRational := ⟨-r.numerator, r.denominator⟩

/-- `add`. -/
def add (a b : ExactRational) : Except NumErr ExactRational :=
  of (a.numerator * b.denominator + b.numerator * a.denominator) (a.denominator * b.denominator)

/-- `subtract`. -/
def subtract (a b : ExactRational) : Except NumErr ExactRational := a.add b.negate

/-- `multiply`. -/
def multiply (a b : ExactRational) : Except NumErr ExactRational :=
  of (a.numerator * b.numerator) (a.denominator * b.denominator)

/-- `divide`. -/
def divide (a b : ExactRational) : Except NumErr ExactRational :=
  if b.numerator = 0 then .error .invalidRational
  else
    let numerator := a.numerator * b.denominator
    let denominator := a.denominator * b.numerator
    if denominator < 0 then of (-numerator) (-denominator) else of numerator denominator

/-- `compare`: `.lt`, `.eq`, `.gt` for the TypeScript's `-1`, `0`, `1`. -/
def compare (a b : ExactRational) : Ordering :=
  let difference := a.numerator * b.denominator - b.numerator * a.denominator
  if difference < 0 then .lt else if difference > 0 then .gt else .eq

/-- `isNegative`. -/
def isNegative (r : ExactRational) : Bool := decide (r.numerator < 0)

/-- `abs`. -/
def abs (r : ExactRational) : ExactRational := if r.numerator < 0 then r.negate else r

/-- `equals`. -/
def equals (a b : ExactRational) : Bool :=
  decide (a.numerator = b.numerator ∧ a.denominator = b.denominator)

/-- `isZero`. -/
def isZero (r : ExactRational) : Bool := decide (r.numerator = 0)

/-- The meaning of a value. -/
def toRat (r : ExactRational) : ℚ := (r.numerator : ℚ) / (r.denominator : ℚ)

/-- What every value the TypeScript can construct satisfies: lowest terms, a positive
denominator, and both parts within the admitted size. -/
structure WF (r : ExactRational) : Prop where
  denominator_pos : 0 < r.denominator
  coprime : Int.gcd r.numerator r.denominator = 1
  numerator_within : withinMagnitude r.numerator = true
  denominator_within : withinMagnitude r.denominator = true

end ExactRational

namespace ExactDecimal

/-- `ExactDecimal.of`. -/
def of (coefficient scale : Int) : Except NumErr ExactDecimal :=
  match scaleError scale with
  | some e => .error e
  | none =>
    if !withinMagnitude coefficient then .error .representationLimitExceeded
    else .ok ⟨coefficient, scale⟩

/-- `isZero`. -/
def isZero (d : ExactDecimal) : Bool := decide (d.coefficient = 0)

/-- `negate`. -/
def negate (d : ExactDecimal) : ExactDecimal := ⟨-d.coefficient, d.scale⟩

/-- `toRational`. -/
def toRational (d : ExactDecimal) : Except NumErr ExactRational :=
  ExactRational.of d.coefficient (10 ^ d.scale.toNat)

/-- The meaning of a value. -/
def toRat (d : ExactDecimal) : ℚ := (d.coefficient : ℚ) / (10 : ℚ) ^ d.scale.toNat

/-- What every value the TypeScript can construct satisfies. -/
structure WF (d : ExactDecimal) : Prop where
  scale_nonneg : 0 ≤ d.scale
  scale_le : d.scale ≤ maxDecimalScale
  coefficient_within : withinMagnitude d.coefficient = true

end ExactDecimal

/-! ## The contract the rest of the kernel relies on

Statements are fixed. Other modules use them as they stand. -/


/-- `withinMagnitude` as a statement about the size of the value. -/
theorem withinMagnitude_iff (v : Int) :
    withinMagnitude v = true ↔ v.natAbs < 2 ^ maxExactIntegerBits := by
  simp [withinMagnitude]

theorem withinMagnitude_neg (v : Int) : withinMagnitude (-v) = withinMagnitude v := by
  simp [withinMagnitude]

theorem withinMagnitude_of_natAbs_le {a b : Int} (h : a.natAbs ≤ b.natAbs)
    (hb : withinMagnitude b = true) : withinMagnitude a = true := by
  rw [withinMagnitude_iff] at *
  omega

theorem withinMagnitude_zero : withinMagnitude 0 = true := by
  rw [withinMagnitude_iff]
  exact Nat.two_pow_pos _

theorem withinMagnitude_one : withinMagnitude 1 = true := by
  rw [withinMagnitude_iff]
  exact Nat.one_lt_two_pow (by decide)

namespace ExactRational

theorem zero_wf : zero.WF :=
  ⟨by decide, by decide, withinMagnitude_zero, withinMagnitude_one⟩

theorem zero_toRat : zero.toRat = 0 := by
  simp [zero, toRat]

/-- What `of` returns once its checks have passed: the two parts divided by their gcd. -/
theorem of_eq_reduced {n d : Int} (hd : 0 < d) (hn : n ≠ 0)
    (hwn : withinMagnitude n = true) (hwd : withinMagnitude d = true) :
    of n d = .ok ⟨n / (Int.gcd n d : Int), d / (Int.gcd n d : Int)⟩ := by
  unfold of
  simp only [show ¬ d ≤ 0 from by omega, hn, hwn, hwd, ↓reduceIte, Bool.not_true, Bool.false_eq_true, jsDiv]
  rw [Int.tdiv_eq_ediv_of_dvd (Int.gcd_dvd_left n d), Int.tdiv_eq_ediv_of_dvd (Int.gcd_dvd_right n d)]

theorem reduced_wf {n d : Int} (hd : 0 < d)
    (hwn : withinMagnitude n = true) (hwd : withinMagnitude d = true) :
    (⟨n / (Int.gcd n d : Int), d / (Int.gcd n d : Int)⟩ : ExactRational).WF := by
  have hg : 0 < Int.gcd n d := Int.gcd_pos_of_ne_zero_right n (by omega)
  refine ⟨?_, ?_, ?_, ?_⟩
  · exact Int.ediv_pos_of_pos_of_dvd hd (by omega) (Int.gcd_dvd_right n d)
  · exact Int.gcd_ediv_gcd_ediv_gcd hg
  · exact withinMagnitude_of_natAbs_le (Int.natAbs_ediv_le_natAbs n _) hwn
  · exact withinMagnitude_of_natAbs_le (Int.natAbs_ediv_le_natAbs d _) hwd

theorem reduced_toRat {n d : Int} (hd : 0 < d) :
    (⟨n / (Int.gcd n d : Int), d / (Int.gcd n d : Int)⟩ : ExactRational).toRat = (n : ℚ) / (d : ℚ) := by
  have hg : 0 < Int.gcd n d := Int.gcd_pos_of_ne_zero_right n (by omega)
  have hgq : ((Int.gcd n d : Int) : ℚ) ≠ 0 := by exact_mod_cast (by omega : (Int.gcd n d : Int) ≠ 0)
  have hdq : (d : ℚ) ≠ 0 := by exact_mod_cast (by omega : d ≠ 0)
  have h1 : ((n / (Int.gcd n d : Int) : Int) : ℚ) * ((Int.gcd n d : Int) : ℚ) = (n : ℚ) := by
    exact_mod_cast Int.ediv_mul_cancel (Int.gcd_dvd_left n d)
  have h2 : ((d / (Int.gcd n d : Int) : Int) : ℚ) * ((Int.gcd n d : Int) : ℚ) = (d : ℚ) := by
    exact_mod_cast Int.ediv_mul_cancel (Int.gcd_dvd_right n d)
  have hq : ((d / (Int.gcd n d : Int) : Int) : ℚ) ≠ 0 := by
    intro h0; rw [h0, zero_mul] at h2; exact hdq h2.symm
  simp only [toRat]
  rw [div_eq_div_iff hq hdq, ← h1, ← h2]
  ring

theorem of_ok {n d : Int} {r : ExactRational} (h : of n d = .ok r) :
    r.WF ∧ r.toRat = (n : ℚ) / (d : ℚ) ∧ 0 < d := by
  by_cases hd : d ≤ 0
  · simp [of, hd] at h
  have hdpos : 0 < d := by omega
  by_cases hn : n = 0
  · subst hn
    have : r = ⟨0, 1⟩ := by simpa [of, hd] using h.symm
    subst this
    exact ⟨zero_wf, by simp [toRat], hdpos⟩
  by_cases hwn : withinMagnitude n = true
  · by_cases hwd : withinMagnitude d = true
    · rw [of_eq_reduced hdpos hn hwn hwd] at h
      cases h
      exact ⟨reduced_wf hdpos hwn hwd, reduced_toRat hdpos, hdpos⟩
    · simp [of, hd, hn, hwn, hwd] at h
  · simp [of, hd, hn, hwn] at h

/-- `of` fails only on a non-positive denominator or a part beyond the admitted size. -/
theorem of_isOk_iff (n d : Int) :
    (∃ r, of n d = .ok r) ↔ 0 < d ∧ (n = 0 ∨ (withinMagnitude n = true ∧ withinMagnitude d = true)) := by
  constructor
  · rintro ⟨r, h⟩
    refine ⟨(of_ok h).2.2, ?_⟩
    by_cases hn : n = 0
    · exact Or.inl hn
    · right
      have hd : ¬ d ≤ 0 := by have := (of_ok h).2.2; omega
      by_cases hwn : withinMagnitude n = true
      · by_cases hwd : withinMagnitude d = true
        · exact ⟨hwn, hwd⟩
        · simp [of, hd, hn, hwn, hwd] at h
      · simp [of, hd, hn, hwn] at h
  · rintro ⟨hd, h⟩
    rcases h with hn | ⟨hwn, hwd⟩
    · exact ⟨⟨0, 1⟩, by simp [of, hn, show ¬ d ≤ 0 by omega]⟩
    · by_cases hn : n = 0
      · exact ⟨⟨0, 1⟩, by simp [of, hn, show ¬ d ≤ 0 by omega]⟩
      · exact ⟨_, of_eq_reduced hd hn hwn hwd⟩

theorem den_ne {r : ExactRational} (h : r.WF) : (r.denominator : ℚ) ≠ 0 := by
  exact_mod_cast (by have := h.denominator_pos; omega : r.denominator ≠ 0)

theorem den_pos_rat {r : ExactRational} (h : r.WF) : (0 : ℚ) < (r.denominator : ℚ) := by
  exact_mod_cast h.denominator_pos

theorem negate_wf {r : ExactRational} (h : r.WF) : r.negate.WF :=
  ⟨h.denominator_pos, by simpa [negate] using h.coprime,
    by simpa [negate, withinMagnitude_neg] using h.numerator_within, h.denominator_within⟩

theorem negate_toRat (r : ExactRational) : r.negate.toRat = -r.toRat := by
  simp [negate, toRat, neg_div]

theorem add_ok {a b c : ExactRational} (ha : a.WF) (hb : b.WF) (h : a.add b = .ok c) :
    c.WF ∧ c.toRat = a.toRat + b.toRat := by
  obtain ⟨hwf, hrat, -⟩ := of_ok h
  refine ⟨hwf, ?_⟩
  rw [hrat]
  simp only [toRat]
  push_cast
  rw [div_add_div _ _ (den_ne ha) (den_ne hb)]
  ring

theorem subtract_ok {a b c : ExactRational} (ha : a.WF) (hb : b.WF) (h : a.subtract b = .ok c) :
    c.WF ∧ c.toRat = a.toRat - b.toRat := by
  obtain ⟨hwf, hrat⟩ := add_ok ha (negate_wf hb) h
  exact ⟨hwf, by rw [hrat, negate_toRat, sub_eq_add_neg]⟩

theorem multiply_ok {a b c : ExactRational} (ha : a.WF) (hb : b.WF) (h : a.multiply b = .ok c) :
    c.WF ∧ c.toRat = a.toRat * b.toRat := by
  obtain ⟨hwf, hrat, -⟩ := of_ok h
  refine ⟨hwf, ?_⟩
  rw [hrat]
  simp only [toRat]
  push_cast
  rw [div_mul_div_comm]

theorem divide_ok {a b c : ExactRational} (ha : a.WF) (hb : b.WF) (h : a.divide b = .ok c) :
    c.WF ∧ b.toRat ≠ 0 ∧ c.toRat = a.toRat / b.toRat := by
  have had := den_ne ha
  have hbd := den_ne hb
  by_cases hbn : b.numerator = 0
  · simp [divide, hbn] at h
  have hbnq : (b.numerator : ℚ) ≠ 0 := by exact_mod_cast hbn
  have hbne : b.toRat ≠ 0 := by
    simp only [toRat]; exact div_ne_zero hbnq hbd
  by_cases hneg : a.denominator * b.numerator < 0
  · have h' : of (-(a.numerator * b.denominator)) (-(a.denominator * b.numerator)) = .ok c := by
      simpa [divide, hbn, hneg] using h
    obtain ⟨hwf, hrat, -⟩ := of_ok h'
    refine ⟨hwf, hbne, ?_⟩
    rw [hrat]
    simp only [toRat]
    push_cast
    field_simp
  · have h' : of (a.numerator * b.denominator) (a.denominator * b.numerator) = .ok c := by
      simpa [divide, hbn, hneg] using h
    obtain ⟨hwf, hrat, -⟩ := of_ok h'
    refine ⟨hwf, hbne, ?_⟩
    rw [hrat]
    simp only [toRat]
    push_cast
    field_simp

/-- The order of two values is the order of the cross products of their parts. -/
theorem toRat_lt_iff {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    a.toRat < b.toRat ↔ a.numerator * b.denominator < b.numerator * a.denominator := by
  simp only [toRat]
  rw [div_lt_div_iff₀ (den_pos_rat ha) (den_pos_rat hb)]
  exact_mod_cast Iff.rfl

theorem toRat_eq_iff {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    a.toRat = b.toRat ↔ a.numerator * b.denominator = b.numerator * a.denominator := by
  simp only [toRat]
  rw [div_eq_div_iff (den_ne ha) (den_ne hb)]
  exact_mod_cast Iff.rfl

/-- `compare`, with its local name unfolded. -/
theorem compare_def (a b : ExactRational) :
    a.compare b = if a.numerator * b.denominator - b.numerator * a.denominator < 0 then .lt
      else if a.numerator * b.denominator - b.numerator * a.denominator > 0 then .gt else .eq := rfl

theorem compare_lt_iff {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    a.compare b = .lt ↔ a.toRat < b.toRat := by
  rw [toRat_lt_iff ha hb]
  rw [compare_def]
  constructor
  · intro h
    by_contra hc
    split_ifs at h <;> omega
  · intro h
    simp only [show a.numerator * b.denominator - b.numerator * a.denominator < 0 from by omega, ↓reduceIte]

theorem compare_gt_iff {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    a.compare b = .gt ↔ b.toRat < a.toRat := by
  rw [toRat_lt_iff hb ha]
  rw [compare_def]
  constructor
  · intro h
    by_contra hc
    split_ifs at h <;> omega
  · intro h
    simp only [show ¬ a.numerator * b.denominator - b.numerator * a.denominator < 0 from by omega,
      show a.numerator * b.denominator - b.numerator * a.denominator > 0 from by omega, ↓reduceIte]

theorem compare_eq_iff {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    a.compare b = .eq ↔ a.toRat = b.toRat := by
  rw [toRat_eq_iff ha hb]
  rw [compare_def]
  constructor
  · intro h
    by_contra hc
    split_ifs at h <;> omega
  · intro h
    simp only [show ¬ a.numerator * b.denominator - b.numerator * a.denominator < 0 from by omega,
      show ¬ a.numerator * b.denominator - b.numerator * a.denominator > 0 from by omega, ↓reduceIte]

/-- Two constructible values that mean the same number are the same value. -/
theorem eq_of_toRat_eq {a b : ExactRational} (ha : a.WF) (hb : b.WF) (h : a.toRat = b.toRat) :
    a = b := by
  have hx := (toRat_eq_iff ha hb).mp h
  have hapos := ha.denominator_pos
  have hbpos := hb.denominator_pos
  have h1 : a.denominator ∣ b.denominator := by
    have : a.denominator ∣ b.denominator * a.numerator := ⟨b.numerator, by rw [mul_comm b.denominator, hx]; ring⟩
    exact Int.dvd_of_dvd_mul_left_of_gcd_one this (by rw [Int.gcd_comm]; exact ha.coprime)
  have h2 : b.denominator ∣ a.denominator := by
    have : b.denominator ∣ a.denominator * b.numerator := ⟨a.numerator, by rw [mul_comm a.denominator, ← hx]; ring⟩
    exact Int.dvd_of_dvd_mul_left_of_gcd_one this (by rw [Int.gcd_comm]; exact hb.coprime)
  have hden : a.denominator = b.denominator := Int.dvd_antisymm (by omega) (by omega) h1 h2
  have hnum : a.numerator = b.numerator := by
    rw [hden] at hx
    have := Int.eq_of_mul_eq_mul_right (by omega : b.denominator ≠ 0) hx
    exact this
  cases a; cases b; simp_all

/-- Two constructible values are the same value exactly when they mean the same number. -/
theorem equals_iff {a b : ExactRational} (ha : a.WF) (hb : b.WF) :
    a.equals b = true ↔ a.toRat = b.toRat := by
  constructor
  · intro h
    have : a = b := by
      cases a; cases b
      simp only [equals, decide_eq_true_eq] at h
      simp [h.1, h.2]
    rw [this]
  · intro h
    have := eq_of_toRat_eq ha hb h
    subst this
    simp [equals]

theorem isZero_iff {r : ExactRational} (h : r.WF) : r.isZero = true ↔ r.toRat = 0 := by
  simp only [isZero, decide_eq_true_eq, toRat]
  rw [div_eq_zero_iff]
  constructor
  · intro h0; left; exact_mod_cast h0
  · rintro (h0 | h0)
    · exact_mod_cast h0
    · exact absurd h0 (den_ne h)

theorem isNegative_iff {r : ExactRational} (h : r.WF) : r.isNegative = true ↔ r.toRat < 0 := by
  simp only [isNegative, decide_eq_true_eq, toRat]
  rw [div_lt_iff₀ (den_pos_rat h), zero_mul]
  exact_mod_cast Iff.rfl

theorem abs_wf {r : ExactRational} (h : r.WF) : r.abs.WF := by
  unfold abs
  split_ifs
  · exact negate_wf h
  · exact h

theorem abs_toRat {r : ExactRational} (h : r.WF) : r.abs.toRat = |r.toRat| := by
  unfold abs
  split_ifs with hn
  · have : r.toRat < 0 := (isNegative_iff h).mp (by simp [isNegative, hn])
    rw [negate_toRat, abs_of_neg this]
  · have : ¬ r.toRat < 0 := fun hlt => hn (by simpa [isNegative] using (isNegative_iff h).mpr hlt)
    rw [abs_of_nonneg (not_lt.mp this)]

end ExactRational

namespace ExactDecimal

theorem of_ok {c s : Int} {d : ExactDecimal} (h : of c s = .ok d) :
    d.WF ∧ d.coefficient = c ∧ d.scale = s := by
  unfold of at h
  by_cases h1 : s < 0
  · simp [scaleError, h1] at h
  by_cases h2 : s > maxDecimalScale
  · simp [scaleError, h1, h2] at h
  by_cases hw : withinMagnitude c = true
  · have : d = ⟨c, s⟩ := by simpa [scaleError, h1, h2, hw] using h.symm
    subst this
    exact ⟨⟨show 0 ≤ s by omega, show s ≤ maxDecimalScale by omega, hw⟩, rfl, rfl⟩
  · simp [scaleError, h1, h2, hw] at h

theorem negate_wf {d : ExactDecimal} (h : d.WF) : d.negate.WF :=
  ⟨h.scale_nonneg, h.scale_le, by simpa [negate, withinMagnitude_neg] using h.coefficient_within⟩

theorem negate_toRat (d : ExactDecimal) : d.negate.toRat = -d.toRat := by
  simp [negate, toRat, neg_div]

theorem toRational_ok {d : ExactDecimal} {r : ExactRational} (hd : d.WF)
    (h : d.toRational = .ok r) : r.WF ∧ r.toRat = d.toRat := by
  obtain ⟨hwf, hrat, -⟩ := ExactRational.of_ok h
  refine ⟨hwf, ?_⟩
  rw [hrat]
  simp only [toRat]
  push_cast
  rfl

theorem isZero_iff (d : ExactDecimal) : d.isZero = true ↔ d.toRat = 0 := by
  simp only [isZero, decide_eq_true_eq, toRat]
  rw [div_eq_zero_iff]
  constructor
  · intro h0; left; exact_mod_cast h0
  · rintro (h0 | h0)
    · exact_mod_cast h0
    · exact absurd h0 (by positivity)

end ExactDecimal

end Rastrata.Kernel

/-
Exact numbers as text: the Lean model of `ExactDecimal.parse`, `ExactDecimal.toString` and
`ExactRational.toString` in `packages/kernel/src/numeric.ts`, and their laws.

A JavaScript string is a sequence of UTF-16 code units and a Lean `String` a sequence of code
points. For these functions the difference does not show: the regular expression has no `u`
flag, so `\d` is the ten ASCII digits and nothing else, every character it can match is one
code unit, and a string holding anything else is refused in both.

The decimal digits of a non-negative bigint (`toString()`) are `Nat.toDigits 10`, and the
bigint of a string of ASCII digits (`BigInt(...)`) is `Nat.ofDigitChars 10 · 0`; both are
Lean's own and come with the law that the second undoes the first.
-/
import Rastrata.Kernel.Numeric

namespace Rastrata.Kernel

/-- Group 1 of the regular expression, `([+-]?)`, at the start of the source: whether it is
`"-"`, and what follows it. -/
def splitSign : List Char → Bool × List Char
  | [] => (false, [])
  | c :: rest => if c = '-' then (true, rest) else if c = '+' then (false, rest) else (false, c :: rest)

/-- `/^([+-]?)(\d+)(?:\.(\d+))?$/.exec(source)` on the characters of the source: whether
group 1 is `"-"`, group 2, and group 3 (empty when it took no part, the TypeScript's
`match[3] ?? ""`). `none` is the TypeScript's `null`.

`\d+` is greedy and what follows it must be the end or a point, so group 2 is the longest run
of digits; `$` has no `m` flag and so matches only at the very end. -/
def decimalMatch (source : List Char) : Option (Bool × List Char × List Char) :=
  let negative := (splitSign source).1
  let rest := (splitSign source).2
  let whole := rest.takeWhile Char.isDigit
  if whole = [] then none
  else
    match rest.dropWhile Char.isDigit with
    | [] => some (negative, whole, [])
    | c :: fraction =>
      if c = '.' ∧ fraction ≠ [] ∧ fraction.all Char.isDigit = true then some (negative, whole, fraction)
      else none

/-- `ExactDecimal.parse` on the characters of the source. The TypeScript's second
`invalid_decimal` (group 2 undefined) cannot happen: group 2 takes part in every match. -/
def parseChars (source : List Char) : Except NumErr ExactDecimal :=
  match decimalMatch source with
  | none => .error .invalidDecimal
  | some (negative, whole, fraction) =>
    let scale : Int := (fraction.length : Nat)
    match scaleError scale with
    | some e => .error e
    | none =>
      let sign : Int := if negative then -1 else 1
      let coefficient : Int := sign * (Nat.ofDigitChars 10 (whole ++ fraction) 0 : Nat)
      if !withinMagnitude coefficient then .error .representationLimitExceeded
      else .ok ⟨coefficient, scale⟩

/-- `ExactDecimal.toString` as characters. `padStart` is the `List.replicate`, the two `slice`s
are `take` and `drop`. `Number(this.scale)` is exact for every constructible decimal (the scale
is at most `MAX_DECIMAL_SCALE`); a negative scale, which no constructible decimal has, prints
as the TypeScript prints it (no padding, everything before the point). -/
def exactDecimalChars (d : ExactDecimal) : List Char :=
  let magnitude := Nat.toDigits 10 (if d.coefficient < 0 then -d.coefficient else d.coefficient).toNat
  let sign := if d.coefficient < 0 then ['-'] else []
  if d.scale = 0 then sign ++ magnitude
  else
    let scale := d.scale.toNat
    let padded := List.replicate (scale + 1 - magnitude.length) '0' ++ magnitude
    let splitAt := padded.length - scale
    sign ++ padded.take splitAt ++ '.' :: padded.drop splitAt

/-- A bigint in a template string: its decimal digits, after a `-` when it is negative. -/
def bigintChars (v : Int) : List Char :=
  if v < 0 then '-' :: Nat.toDigits 10 (-v).toNat else Nat.toDigits 10 v.toNat

namespace ExactDecimal

/-- `ExactDecimal.parse`. -/
def parse (source : String) : Except NumErr ExactDecimal := parseChars source.toList

/-- `toString`. -/
def toString (d : ExactDecimal) : String := String.ofList (exactDecimalChars d)

end ExactDecimal

namespace ExactRational

/-- `toString`. -/
def toString (r : ExactRational) : String :=
  String.ofList (bigintChars r.numerator ++ '/' :: bigintChars r.denominator)

end ExactRational

/-! ## The shape `parse` accepts -/

/-- The shape of a decimal in text: `sign`, then `whole`, then, unless `fraction` is empty, a
point and `fraction`. The sign is nothing, `+` or `-`; `whole` is one or more ASCII digits and
`fraction` is ASCII digits. An empty `fraction` says there is no point: a point with no digit
after it is not of the shape. -/
structure DecimalShape (source sign whole fraction : List Char) : Prop where
  sign_eq : sign = [] ∨ sign = ['+'] ∨ sign = ['-']
  whole_ne : whole ≠ []
  whole_digits : ∀ c ∈ whole, c.isDigit = true
  fraction_digits : ∀ c ∈ fraction, c.isDigit = true
  source_eq : source = sign ++ whole ++ (if fraction = [] then [] else '.' :: fraction)

/-- A digit is not the minus sign. -/
private theorem digit_ne_minus {c : Char} (h : c.isDigit = true) : c ≠ '-' := by
  rintro rfl
  exact absurd h (by decide)

/-- A digit is not the plus sign. -/
private theorem digit_ne_plus {c : Char} (h : c.isDigit = true) : c ≠ '+' := by
  rintro rfl
  exact absurd h (by decide)

/-- A sign followed by a digit is split into that sign and the rest. -/
private theorem splitSign_of_sign {sign : List Char} {c : Char} {t : List Char}
    (hs : sign = [] ∨ sign = ['+'] ∨ sign = ['-']) (hc : c.isDigit = true) :
    splitSign (sign ++ c :: t) = (decide (sign = ['-']), c :: t) := by
  rcases hs with rfl | rfl | rfl
  · simp [splitSign, digit_ne_minus hc, digit_ne_plus hc]
  · simp [splitSign]
  · simp [splitSign]

/-- Every source is a sign (nothing, `+` or `-`) followed by what `splitSign` leaves. -/
private theorem splitSign_spec (source : List Char) :
    ∃ sign, (sign = [] ∨ sign = ['+'] ∨ sign = ['-']) ∧ source = sign ++ (splitSign source).2 ∧
      (splitSign source).1 = decide (sign = ['-']) := by
  cases source with
  | nil => exact ⟨[], Or.inl rfl, rfl, by simp [splitSign]⟩
  | cons c t =>
    by_cases h1 : c = '-'
    · exact ⟨['-'], Or.inr (Or.inr rfl), by simp [splitSign, h1], by simp [splitSign, h1]⟩
    · by_cases h2 : c = '+'
      · exact ⟨['+'], Or.inr (Or.inl rfl), by simp [splitSign, h2], by simp [splitSign, h2]⟩
      · exact ⟨[], Or.inl rfl, by simp [splitSign, h1, h2], by simp [splitSign, h1, h2]⟩

/-- A source of the shape is matched, and the match gives back its parts. -/
theorem decimalMatch_of_shape {source sign whole fraction : List Char}
    (h : DecimalShape source sign whole fraction) :
    decimalMatch source = some (decide (sign = ['-']), whole, fraction) := by
  obtain ⟨c, t, hw⟩ := List.exists_cons_of_ne_nil h.whole_ne
  have hc : c.isDigit = true := h.whole_digits c (by rw [hw]; exact List.mem_cons_self)
  have hsplit : splitSign source =
      (decide (sign = ['-']), whole ++ (if fraction = [] then [] else '.' :: fraction)) := by
    rw [h.source_eq, List.append_assoc, hw, List.cons_append]
    exact splitSign_of_sign h.sign_eq hc
  unfold decimalMatch
  rw [hsplit]
  dsimp only
  rw [List.takeWhile_append_of_pos h.whole_digits, List.dropWhile_append_of_pos h.whole_digits]
  by_cases hf : fraction = []
  · subst hf
    simp [h.whole_ne]
  · have hall : fraction.all Char.isDigit = true := List.all_eq_true.mpr h.fraction_digits
    have hpoint : ('.' : Char).isDigit = false := by decide
    simp [hf, h.whole_ne, hall, hpoint]

/-- What is matched is of the shape, and the match gives its parts. -/
theorem shape_of_decimalMatch {source whole fraction : List Char} {negative : Bool}
    (h : decimalMatch source = some (negative, whole, fraction)) :
    ∃ sign, DecimalShape source sign whole fraction ∧ negative = decide (sign = ['-']) := by
  obtain ⟨sign, hsign, hsrc, hneg⟩ := splitSign_spec source
  have hsplit := (List.takeWhile_append_dropWhile (p := Char.isDigit) (l := (splitSign source).2)).symm
  have hdig : ∀ c ∈ (splitSign source).2.takeWhile Char.isDigit, c.isDigit = true :=
    List.all_eq_true.mp List.all_takeWhile
  unfold decimalMatch at h
  dsimp only at h
  split_ifs at h with hwhole
  split at h
  · rename_i htail
    simp only [Option.some.injEq, Prod.mk.injEq] at h
    obtain ⟨h1, h2, h3⟩ := h
    refine ⟨sign, ⟨hsign, by rw [← h2]; exact hwhole, by rw [← h2]; exact hdig, by simp [← h3], ?_⟩,
      by rw [← h1, hneg]⟩
    rw [hsrc, hsplit, htail, ← h2, ← h3]
    simp
  · rename_i c fraction' htail
    split_ifs at h with hcond
    simp only [Option.some.injEq, Prod.mk.injEq] at h
    obtain ⟨h1, h2, h3⟩ := h
    obtain ⟨hc, hne, hall⟩ := hcond
    subst h3
    refine ⟨sign, ⟨hsign, by rw [← h2]; exact hwhole, by rw [← h2]; exact hdig,
      List.all_eq_true.mp hall, ?_⟩, by rw [← h1, hneg]⟩
    rw [hsrc, hsplit, htail, ← h2, hc]
    simp [hne]

/-- A source is matched exactly when it is of the shape. -/
theorem decimalMatch_isSome_iff (source : List Char) :
    (decimalMatch source).isSome = true ↔
      ∃ sign whole fraction, DecimalShape source sign whole fraction := by
  constructor
  · intro h
    obtain ⟨⟨negative, whole, fraction⟩, hm⟩ := Option.isSome_iff_exists.mp h
    obtain ⟨sign, hs, -⟩ := shape_of_decimalMatch hm
    exact ⟨sign, whole, fraction, hs⟩
  · rintro ⟨sign, whole, fraction, hs⟩
    rw [decimalMatch_of_shape hs]
    rfl

/-- A source has one whole part and one fraction: two readings of it as the shape agree. -/
theorem DecimalShape.unique {source sign₁ whole₁ fraction₁ sign₂ whole₂ fraction₂ : List Char}
    (h₁ : DecimalShape source sign₁ whole₁ fraction₁)
    (h₂ : DecimalShape source sign₂ whole₂ fraction₂) :
    whole₁ = whole₂ ∧ fraction₁ = fraction₂ ∧ (sign₁ = ['-'] ↔ sign₂ = ['-']) := by
  have h := (decimalMatch_of_shape h₁).symm.trans (decimalMatch_of_shape h₂)
  simp only [Option.some.injEq, Prod.mk.injEq, decide_eq_decide] at h
  exact ⟨h.2.1, h.2.2, h.1⟩

/-! ## What `parse` returns -/

/-- After the match, `parse` does what `ExactDecimal.of` does with the coefficient and the
scale it read: the scale is checked first, then the size of the coefficient. -/
theorem parseChars_eq_of (source : List Char) :
    parseChars source =
      match decimalMatch source with
      | none => .error .invalidDecimal
      | some (negative, whole, fraction) =>
        ExactDecimal.of ((if negative then -1 else 1) * (Nat.ofDigitChars 10 (whole ++ fraction) 0 : Nat))
          (fraction.length : Nat) := by
  unfold parseChars ExactDecimal.of
  rfl

/-- A source of the shape is read as its digits, whole part then fraction, with the sign, and
as many decimal places as the fraction has digits, under the limits of `ExactDecimal.of`. -/
theorem parseChars_of_shape {source sign whole fraction : List Char}
    (h : DecimalShape source sign whole fraction) :
    parseChars source =
      ExactDecimal.of ((if sign = ['-'] then -1 else 1) * (Nat.ofDigitChars 10 (whole ++ fraction) 0 : Nat))
        (fraction.length : Nat) := by
  rw [parseChars_eq_of, decimalMatch_of_shape h]
  simp only [decide_eq_true_eq]

/-- What `parse` returns is constructible. -/
theorem parseChars_ok_wf {source : List Char} {d : ExactDecimal} (h : parseChars source = .ok d) :
    d.WF := by
  rw [parseChars_eq_of] at h
  split at h
  · cases h
  · exact (ExactDecimal.of_ok h).1

/-- `ExactDecimal.of` with a scale that is a count: the scale limit first, then the size. -/
private theorem of_natScale (c : Int) (n : Nat) :
    ExactDecimal.of c (n : Nat) =
      if maxDecimalScale < (n : Int) then .error .scaleLimitExceeded
      else if withinMagnitude c = true then .ok ⟨c, (n : Nat)⟩
      else .error .representationLimitExceeded := by
  have h0 : ¬ ((n : Int) < 0) := by omega
  unfold ExactDecimal.of scaleError
  by_cases h1 : (n : Int) > maxDecimalScale
  · simp [h0, h1]
  · by_cases h2 : withinMagnitude c = true
    · simp [h0, h1, h2]
    · simp [h0, h1, h2]

/-- With a scale that is a count, `ExactDecimal.of` succeeds exactly within both limits. -/
private theorem of_natScale_isOk_iff (c : Int) (n : Nat) :
    (∃ d, ExactDecimal.of c (n : Nat) = .ok d) ↔
      (n : Int) ≤ maxDecimalScale ∧ withinMagnitude c = true := by
  rw [of_natScale]
  by_cases h1 : maxDecimalScale < (n : Int)
  · simp [h1]
  · by_cases h2 : withinMagnitude c = true
    · simp [h1, h2, Int.not_lt.mp h1]
    · simp [h1, h2]

/-- With a scale that is a count, `ExactDecimal.of` never says the decimal is invalid. -/
private theorem of_natScale_ne_invalidDecimal (c : Int) (n : Nat) :
    ExactDecimal.of c (n : Nat) ≠ .error .invalidDecimal := by
  rw [of_natScale]
  split_ifs <;> simp

/-- With a scale that is a count, `ExactDecimal.of` refuses for scale exactly above the limit. -/
private theorem of_natScale_eq_scaleLimit_iff (c : Int) (n : Nat) :
    ExactDecimal.of c (n : Nat) = .error .scaleLimitExceeded ↔ maxDecimalScale < (n : Int) := by
  rw [of_natScale]
  split_ifs <;> simp [*]

/-- With a scale that is a count, `ExactDecimal.of` refuses for size exactly when the scale is
allowed and the coefficient is too large. -/
private theorem of_natScale_eq_limit_iff (c : Int) (n : Nat) :
    ExactDecimal.of c (n : Nat) = .error .representationLimitExceeded ↔
      (n : Int) ≤ maxDecimalScale ∧ ¬ withinMagnitude c = true := by
  rw [of_natScale]
  by_cases h1 : maxDecimalScale < (n : Int)
  · simp [h1]
  · by_cases h2 : withinMagnitude c = true
    · simp [h1, h2]
    · simp [h1, h2, Int.not_lt.mp h1]

/-- A whole number with a sign is within the admitted size exactly when the number is. -/
private theorem within_signed (negative : Prop) [Decidable negative] (v : Nat) :
    withinMagnitude ((if negative then -1 else 1) * (v : Int)) = true ↔
      v < 2 ^ maxExactIntegerBits := by
  rw [withinMagnitude_iff, Int.natAbs_mul, Int.natAbs_natCast]
  generalize 2 ^ maxExactIntegerBits = bound
  split_ifs <;> simp

/-- `parse` succeeds exactly on a source of the shape whose fraction has at most
`maxDecimalScale` digits and whose digits, read as one whole number, are within the admitted
size. -/
theorem parseChars_isOk_iff (source : List Char) :
    (∃ d, parseChars source = .ok d) ↔
      ∃ sign whole fraction, DecimalShape source sign whole fraction ∧
        (fraction.length : Int) ≤ maxDecimalScale ∧
        Nat.ofDigitChars 10 (whole ++ fraction) 0 < 2 ^ maxExactIntegerBits := by
  constructor
  · rintro ⟨d, h⟩
    rw [parseChars_eq_of] at h
    split at h
    · cases h
    · rename_i negative whole fraction hm
      obtain ⟨sign, hs, -⟩ := shape_of_decimalMatch hm
      obtain ⟨h1, h2⟩ := (of_natScale_isOk_iff _ _).mp ⟨d, h⟩
      exact ⟨sign, whole, fraction, hs, h1, (within_signed _ _).mp h2⟩
  · rintro ⟨sign, whole, fraction, hs, h1, h2⟩
    rw [parseChars_of_shape hs]
    exact (of_natScale_isOk_iff _ _).mpr ⟨h1, (within_signed _ _).mpr h2⟩

/-- `parse` refuses a source as not a decimal exactly when it is not of the shape. -/
theorem parseChars_eq_invalidDecimal_iff (source : List Char) :
    parseChars source = .error .invalidDecimal ↔
      ¬ ∃ sign whole fraction, DecimalShape source sign whole fraction := by
  constructor
  · rintro h ⟨sign, whole, fraction, hs⟩
    rw [parseChars_of_shape hs] at h
    exact of_natScale_ne_invalidDecimal _ _ h
  · intro h
    rw [← decimalMatch_isSome_iff] at h
    rw [parseChars_eq_of]
    split
    · rfl
    · rename_i hm
      rw [hm] at h
      exact absurd rfl h

/-- `parse` refuses a source for its scale exactly when it is of the shape and its fraction
has more than `maxDecimalScale` digits, whatever the size of its digits. -/
theorem parseChars_eq_scaleLimit_iff (source : List Char) :
    parseChars source = .error .scaleLimitExceeded ↔
      ∃ sign whole fraction, DecimalShape source sign whole fraction ∧
        maxDecimalScale < (fraction.length : Int) := by
  constructor
  · intro h
    rw [parseChars_eq_of] at h
    split at h
    · cases h
    · rename_i negative whole fraction hm
      obtain ⟨sign, hs, -⟩ := shape_of_decimalMatch hm
      exact ⟨sign, whole, fraction, hs, (of_natScale_eq_scaleLimit_iff _ _).mp h⟩
  · rintro ⟨sign, whole, fraction, hs, h1⟩
    rw [parseChars_of_shape hs]
    exact (of_natScale_eq_scaleLimit_iff _ _).mpr h1

/-- `parse` refuses a source for size exactly when it is of the shape, its fraction has at
most `maxDecimalScale` digits, and its digits read as one whole number are beyond the admitted
size. -/
theorem parseChars_eq_limit_iff (source : List Char) :
    parseChars source = .error .representationLimitExceeded ↔
      ∃ sign whole fraction, DecimalShape source sign whole fraction ∧
        (fraction.length : Int) ≤ maxDecimalScale ∧
        2 ^ maxExactIntegerBits ≤ Nat.ofDigitChars 10 (whole ++ fraction) 0 := by
  constructor
  · intro h
    rw [parseChars_eq_of] at h
    split at h
    · cases h
    · rename_i negative whole fraction hm
      obtain ⟨sign, hs, -⟩ := shape_of_decimalMatch hm
      obtain ⟨h1, h2⟩ := (of_natScale_eq_limit_iff _ _).mp h
      exact ⟨sign, whole, fraction, hs, h1,
        Nat.le_of_not_lt (fun hlt => h2 ((within_signed _ _).mpr hlt))⟩
  · rintro ⟨sign, whole, fraction, hs, h1, h2⟩
    rw [parseChars_of_shape hs]
    exact (of_natScale_eq_limit_iff _ _).mpr
      ⟨h1, fun hw => Nat.not_lt.mpr h2 ((within_signed _ _).mp hw)⟩

/-! ## Writing a decimal and reading it back -/

/-- The decimal digits of a number are ASCII digits. -/
private theorem digits_isDigit (n : Nat) : ∀ c ∈ Nat.toDigits 10 n, c.isDigit = true :=
  fun _ hc => Nat.isDigit_of_mem_toDigits (by decide) (by decide) hc

/-- Zeros followed by the decimal digits of a number are ASCII digits. -/
private theorem padded_isDigit (k n : Nat) :
    ∀ c ∈ List.replicate k '0' ++ Nat.toDigits 10 n, c.isDigit = true := by
  intro c hc
  rcases List.mem_append.mp hc with h | h
  · rw [(List.mem_replicate.mp h).2]
    decide
  · exact digits_isDigit n c h

/-- Leading zeros do not change the number its digits are read as. -/
private theorem padded_value (k n : Nat) :
    Nat.ofDigitChars 10 (List.replicate k '0' ++ Nat.toDigits 10 n) 0 = n := by
  rw [Nat.ofDigitChars_append, Nat.ofDigitChars_replicate_zero, Nat.mul_zero,
    Nat.ofDigitChars_ten_toDigits]

/-- The TypeScript's `negative ? -c : c` is the absolute value. -/
private theorem magnitude_eq (c : Int) : (if c < 0 then -c else c).toNat = c.natAbs := by
  split_ifs <;> omega

/-- What `toString` writes is of the shape: its digits read as one whole number are the size of
the coefficient, its sign is `-` exactly for a negative coefficient, and its fraction has as
many digits as the scale. -/
theorem exactDecimalChars_shape {d : ExactDecimal} (hs : 0 ≤ d.scale) :
    ∃ whole fraction,
      DecimalShape (exactDecimalChars d) (if d.coefficient < 0 then ['-'] else []) whole fraction ∧
        Nat.ofDigitChars 10 (whole ++ fraction) 0 = d.coefficient.natAbs ∧
        ((fraction.length : Nat) : Int) = d.scale := by
  have hsign : (if d.coefficient < 0 then ['-'] else []) = [] ∨
      (if d.coefficient < 0 then ['-'] else []) = ['+'] ∨
      (if d.coefficient < 0 then ['-'] else []) = ['-'] := by
    split_ifs
    · exact Or.inr (Or.inr rfl)
    · exact Or.inl rfl
  unfold exactDecimalChars
  dsimp only
  rw [magnitude_eq]
  by_cases h0 : d.scale = 0
  · refine ⟨Nat.toDigits 10 d.coefficient.natAbs, [],
      ⟨hsign, Nat.toDigits_ne_nil, digits_isDigit _, by simp, by simp [h0]⟩, ?_, by simp [h0]⟩
    rw [List.append_nil, Nat.ofDigitChars_ten_toDigits]
  · simp only [h0, ↓reduceIte]
    generalize hp : List.replicate
      (d.scale.toNat + 1 - (Nat.toDigits 10 d.coefficient.natAbs).length) '0' ++
        Nat.toDigits 10 d.coefficient.natAbs = padded
    have hpd : ∀ c ∈ padded, c.isDigit = true := by
      rw [← hp]
      exact padded_isDigit _ _
    have hpv : Nat.ofDigitChars 10 padded 0 = d.coefficient.natAbs := by
      rw [← hp]
      exact padded_value _ _
    have hpl : d.scale.toNat + 1 ≤ padded.length := by
      rw [← hp, List.length_append, List.length_replicate]
      omega
    have hfl : (padded.drop (padded.length - d.scale.toNat)).length = d.scale.toNat := by
      rw [List.length_drop]
      omega
    have hfne : padded.drop (padded.length - d.scale.toNat) ≠ [] := by
      intro h
      rw [h, List.length_nil] at hfl
      omega
    have hwne : padded.take (padded.length - d.scale.toNat) ≠ [] := by
      intro h
      have hl := congrArg List.length h
      rw [List.length_take, List.length_nil] at hl
      omega
    refine ⟨padded.take (padded.length - d.scale.toNat), padded.drop (padded.length - d.scale.toNat),
      ⟨hsign, hwne, fun c hc => hpd c (List.mem_of_mem_take hc),
        fun c hc => hpd c (List.mem_of_mem_drop hc), by simp only [hfne, ↓reduceIte]⟩, ?_, ?_⟩
    · rw [List.take_append_drop]
      exact hpv
    · rw [hfl]
      omega

/-- The sign that is written, times the absolute value, is the coefficient. -/
private theorem signed_natAbs (c : Int) :
    (if (if c < 0 then ['-'] else []) = ['-'] then (-1 : Int) else 1) * (c.natAbs : Int) = c := by
  by_cases h : c < 0
  · simp only [h, ↓reduceIte]
    omega
  · have hne : ¬ (([] : List Char) = ['-']) := by simp
    simp only [h, hne, ↓reduceIte]
    omega

/-- A constructible decimal written as characters and read back is the same decimal. -/
theorem parseChars_exactDecimalChars {d : ExactDecimal} (hd : d.WF) :
    parseChars (exactDecimalChars d) = .ok d := by
  obtain ⟨whole, fraction, hs, hv, hl⟩ := exactDecimalChars_shape hd.scale_nonneg
  rw [parseChars_of_shape hs, hv, signed_natAbs, hl]
  have h1 : ¬ d.scale < 0 := Int.not_lt.mpr hd.scale_nonneg
  have h2 : ¬ d.scale > maxDecimalScale := Int.not_lt.mpr hd.scale_le
  unfold ExactDecimal.of scaleError
  simp only [h1, h2, hd.coefficient_within, ↓reduceIte, Bool.not_true, Bool.false_eq_true]

namespace ExactDecimal

/-- `parse` succeeds exactly on text of the shape whose fraction has at most `maxDecimalScale`
digits and whose digits, read as one whole number, are within the admitted size. -/
theorem parse_isOk_iff (source : String) :
    (∃ d, parse source = .ok d) ↔
      ∃ sign whole fraction, DecimalShape source.toList sign whole fraction ∧
        (fraction.length : Int) ≤ maxDecimalScale ∧
        Nat.ofDigitChars 10 (whole ++ fraction) 0 < 2 ^ maxExactIntegerBits :=
  parseChars_isOk_iff source.toList

/-- `parse` refuses text as not a decimal exactly when it is not of the shape. -/
theorem parse_eq_invalidDecimal_iff (source : String) :
    parse source = .error .invalidDecimal ↔
      ¬ ∃ sign whole fraction, DecimalShape source.toList sign whole fraction :=
  parseChars_eq_invalidDecimal_iff source.toList

/-- `parse` refuses text for its scale exactly when it is of the shape and its fraction has
more than `maxDecimalScale` digits, whatever the size of its digits. -/
theorem parse_eq_scaleLimit_iff (source : String) :
    parse source = .error .scaleLimitExceeded ↔
      ∃ sign whole fraction, DecimalShape source.toList sign whole fraction ∧
        maxDecimalScale < (fraction.length : Int) :=
  parseChars_eq_scaleLimit_iff source.toList

/-- `parse` refuses text for size exactly when it is of the shape, its fraction has at most
`maxDecimalScale` digits, and its digits read as one whole number are beyond the admitted
size. -/
theorem parse_eq_limit_iff (source : String) :
    parse source = .error .representationLimitExceeded ↔
      ∃ sign whole fraction, DecimalShape source.toList sign whole fraction ∧
        (fraction.length : Int) ≤ maxDecimalScale ∧
        2 ^ maxExactIntegerBits ≤ Nat.ofDigitChars 10 (whole ++ fraction) 0 :=
  parseChars_eq_limit_iff source.toList

/-- Text of the shape is read as its digits, whole part then fraction, with the sign, and as
many decimal places as the fraction has digits, under the limits of `ExactDecimal.of`. -/
theorem parse_of_shape {source : String} {sign whole fraction : List Char}
    (h : DecimalShape source.toList sign whole fraction) :
    parse source =
      ExactDecimal.of ((if sign = ['-'] then -1 else 1) * (Nat.ofDigitChars 10 (whole ++ fraction) 0 : Nat))
        (fraction.length : Nat) :=
  parseChars_of_shape h

/-- What `parse` returns is constructible. -/
theorem parse_ok_wf {source : String} {d : ExactDecimal} (h : parse source = .ok d) : d.WF :=
  parseChars_ok_wf h

/-- A constructible decimal written as text and read back is the same decimal. -/
theorem parse_toString {d : ExactDecimal} (hd : d.WF) : parse (toString d) = .ok d := by
  unfold parse toString
  rw [String.toList_ofList]
  exact parseChars_exactDecimalChars hd

/-- Two constructible decimals that are written as the same text are the same decimal. -/
theorem toString_injective {a b : ExactDecimal} (ha : a.WF) (hb : b.WF)
    (h : toString a = toString b) : a = b := by
  have h1 := parse_toString ha
  rw [h, parse_toString hb] at h1
  cases h1
  rfl

end ExactDecimal

/-! ## Reading is not one to one

`toString` after `parse` is not always the text that was read: a `+`, leading zeros and the
sign of zero are not kept. The smallest case is stated here. -/

/-- `-0` and `0` are read as the same decimal, and that decimal is written `0`. -/
theorem parseChars_minus_zero :
    parseChars ['-', '0'] = .ok ⟨0, 0⟩ ∧ parseChars ['0'] = .ok ⟨0, 0⟩ ∧
      exactDecimalChars ⟨0, 0⟩ = ['0'] := by
  have hdigit : ∀ c ∈ ['0'], c.isDigit = true := by
    intro c hc
    rw [List.mem_singleton.mp hc]
    decide
  have hs1 : DecimalShape ['-', '0'] ['-'] ['0'] [] :=
    ⟨Or.inr (Or.inr rfl), by simp, hdigit, by simp, by simp⟩
  have hs2 : DecimalShape ['0'] [] ['0'] [] := ⟨Or.inl rfl, by simp, hdigit, by simp, by simp⟩
  have hv : Nat.ofDigitChars 10 (['0'] ++ []) 0 = 0 := by decide
  have hof : ExactDecimal.of 0 ((0 : Nat) : Int) = .ok ⟨0, 0⟩ := by
    have hmax : ¬ maxDecimalScale < (0 : Int) := by decide
    rw [of_natScale]
    simp only [Int.natCast_zero, hmax, withinMagnitude_zero, ↓reduceIte]
  refine ⟨?_, ?_, ?_⟩
  · rw [parseChars_of_shape hs1, hv, List.length_nil, Int.natCast_zero, Int.mul_zero]
    exact hof
  · rw [parseChars_of_shape hs2, hv, List.length_nil, Int.natCast_zero, Int.mul_zero]
    exact hof
  · simp [exactDecimalChars]

/-! ## Writing a fraction -/

/-- A whole number is written without a `/`. -/
private theorem slash_not_mem_bigintChars (v : Int) : '/' ∉ bigintChars v := by
  unfold bigintChars
  intro h
  split_ifs at h
  · rcases List.mem_cons.mp h with h | h
    · exact absurd h (by decide)
    · exact absurd (digits_isDigit _ _ h) (by decide)
  · exact absurd (digits_isDigit _ _ h) (by decide)

/-- Two numbers with the same decimal digits are the same number. -/
private theorem toDigits_injective {m n : Nat} (h : Nat.toDigits 10 m = Nat.toDigits 10 n) :
    m = n := by
  rw [← Nat.ofDigitChars_ten_toDigits (n := m), h, Nat.ofDigitChars_ten_toDigits]

/-- Two whole numbers that are written with the same characters are the same number. -/
theorem bigintChars_injective {a b : Int} (h : bigintChars a = bigintChars b) : a = b := by
  unfold bigintChars at h
  split_ifs at h with ha hb hb
  · have := toDigits_injective (List.cons.inj h).2
    omega
  · have hmem : '-' ∈ Nat.toDigits 10 b.toNat := by
      rw [← h]
      exact List.mem_cons_self
    exact absurd (digits_isDigit _ _ hmem) (by decide)
  · have hmem : '-' ∈ Nat.toDigits 10 a.toNat := by
      rw [h]
      exact List.mem_cons_self
    exact absurd (digits_isDigit _ _ hmem) (by decide)
  · have := toDigits_injective h
    omega

namespace ExactRational

/-- Two fractions that are written as the same text have the same numerator and the same
denominator. -/
theorem toString_injective {a b : ExactRational} (h : a.toString = b.toString) : a = b := by
  unfold toString at h
  have h1 := String.ofList_injective h
  rw [List.append_cons_inj_of_notMem (slash_not_mem_bigintChars _)
    (slash_not_mem_bigintChars _)] at h1
  cases a
  cases b
  simp only [ExactRational.mk.injEq]
  exact ⟨bigintChars_injective h1.1, bigintChars_injective h1.2.2⟩

end ExactRational

end Rastrata.Kernel

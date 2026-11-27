/-
The calendar laws of `Accounting/Schedules.lean`: `monthsBetween` and `addMonths`
(`accounting.ts` lines 1543 to 1550) are the calendar arithmetic they name, which dates `addMonths`
produces that are real dates and which are not (with witnesses), and the dates a schedule generates
are first-of-month dates in strictly increasing order.
-/
import Rastrata.Kernel.Accounting.Schedules.Model

namespace Rastrata.Kernel

/-! ## Group 1: Calendar arithmetic (`monthsBetween`, `addMonths`) -/

namespace Schedules

/-- Splitting a text with no dash gives that text. -/
private theorem splitDash_noDash : ∀ (c : List Char), (∀ ch ∈ c, ch ≠ '-') →
    ∀ acc, splitDash c acc = [acc.reverse ++ c]
  | [], _, acc => by simp [splitDash]
  | ch :: cs, hc, acc => by
    have hne : (ch == '-') = false := beq_false_of_ne (hc ch (by simp))
    simp only [splitDash, hne, Bool.false_eq_true, ↓reduceIte]
    rw [splitDash_noDash cs (fun x hx => hc x (by simp [hx])) (ch :: acc)]
    simp [List.reverse_cons, List.append_assoc]

/-- Splitting a text with one dash gives the part before it and the part after it. -/
private theorem splitDash_oneDash (c : List Char) (hc : ∀ ch ∈ c, ch ≠ '-') :
    ∀ (b : List Char), (∀ ch ∈ b, ch ≠ '-') →
      ∀ acc, splitDash (b ++ '-' :: c) acc = [acc.reverse ++ b, c]
  | [], _, acc => by
    simp only [List.nil_append, splitDash, beq_self_eq_true, ↓reduceIte,
      splitDash_noDash c hc [], List.reverse_nil, List.nil_append, List.append_nil]
  | ch :: bs, hb, acc => by
    have hne : (ch == '-') = false := beq_false_of_ne (hb ch (by simp))
    simp only [List.cons_append, splitDash, hne, Bool.false_eq_true, ↓reduceIte]
    rw [splitDash_oneDash c hc bs (fun x hx => hb x (by simp [hx])) (ch :: acc)]
    simp [List.reverse_cons, List.append_assoc]

/-- Splitting a text with two dashes gives its three parts. -/
private theorem splitDash_append_dash (b c : List Char)
    (hb : ∀ ch ∈ b, ch ≠ '-') (hc : ∀ ch ∈ c, ch ≠ '-') :
    ∀ (a : List Char), (∀ ch ∈ a, ch ≠ '-') →
      ∀ acc, splitDash (a ++ '-' :: b ++ '-' :: c) acc = [acc.reverse ++ a, b, c]
  | [], _, acc => by
    rw [List.nil_append, List.cons_append, splitDash]
    simp [splitDash_oneDash c hc b hb []]
  | ch :: as, ha, acc => by
    have hne : (ch == '-') = false := beq_false_of_ne (ha ch (by simp))
    simp only [List.cons_append, splitDash, hne, Bool.false_eq_true, ↓reduceIte]
    rw [splitDash_append_dash b c hb hc as (fun x hx => ha x (by simp [hx])) (ch :: acc)]
    simp [List.reverse_cons, List.append_assoc]

/-- An ASCII digit is not a dash. -/
private theorem isAsciiDigit_ne_dash {c : Char} (h : isAsciiDigit c = true) : c ≠ '-' := by
  intro heq
  subst heq
  simp [isAsciiDigit] at h

/-- On any valid `LocalDate`, `parseYearMonth` reads its exact calendar year and month. -/
theorem parseYearMonth_of_wf {d : LocalDate} (hd : d.WF) :
    parseYearMonth d = ((d.toCalendarDate.year : Int), (d.toCalendarDate.month : Int)) := by
  obtain ⟨hcv, hfmt⟩ := hd.toCalendarDate_spec
  have h1 := hcv.year_le
  have h2 := hcv.month_le_99
  have h3 := hcv.day_le_31
  set c := d.toCalendarDate
  have hchars : d.value.toList =
      [digitChar (c.year / 1000 % 10), digitChar (c.year / 100 % 10),
       digitChar (c.year / 10 % 10), digitChar (c.year % 10)] ++
      '-' :: [digitChar (c.month / 10 % 10), digitChar (c.month % 10)] ++
      '-' :: [digitChar (c.day / 10 % 10), digitChar (c.day % 10)] := by
    rw [← hfmt, CalendarDate.format, String.toList_ofList, CalendarDate.chars]
    rfl
  have ha : ∀ ch ∈ [digitChar (c.year / 1000 % 10), digitChar (c.year / 100 % 10),
      digitChar (c.year / 10 % 10), digitChar (c.year % 10)], ch ≠ '-' := by
    intro ch hmem
    rcases by simpa using hmem with rfl | rfl | rfl | rfl <;>
      exact isAsciiDigit_ne_dash (isAsciiDigit_digitChar_mod _)
  have hb : ∀ ch ∈ [digitChar (c.month / 10 % 10), digitChar (c.month % 10)], ch ≠ '-' := by
    intro ch hmem
    rcases by simpa using hmem with rfl | rfl <;>
      exact isAsciiDigit_ne_dash (isAsciiDigit_digitChar_mod _)
  have hc : ∀ ch ∈ [digitChar (c.day / 10 % 10), digitChar (c.day % 10)], ch ≠ '-' := by
    intro ch hmem
    rcases by simpa using hmem with rfl | rfl <;>
      exact isAsciiDigit_ne_dash (isAsciiDigit_digitChar_mod _)
  unfold parseYearMonth
  rw [hchars, splitDash_append_dash _ _ hb hc _ ha []]
  simp only [List.reverse_nil, List.nil_append, List.isEmpty_cons, List.all_cons,
    isAsciiDigit_digitChar_mod, List.all_nil, Bool.not_false, Bool.and_self, ↓reduceIte,
    digitsToNat, List.foldl_cons, List.foldl_nil, digitValue_digitChar_mod]
  refine Prod.ext ?_ ?_ <;> exact_mod_cast (by omega : _)

/-- A year from 0 to 9999 padded to four digits is its four decimal digits. -/
private theorem padZero4_eq_digits {n : Nat} (hn : n ≤ 9999) :
    padZero 4 (toString (n : Int)) =
      String.ofList [digitChar (n / 1000 % 10), digitChar (n / 100 % 10),
        digitChar (n / 10 % 10), digitChar (n % 10)] := by
  have hts : toString (n : Int) = String.ofList (Nat.toDigits 10 n) := by
    change Int.repr (n : Int) = String.ofList (Nat.toDigits 10 n)
    rfl
  have h10 : ∀ d, d < 10 → Nat.digitChar d = digitChar d := fun d hd => by
    have : d = 0 ∨ d = 1 ∨ d = 2 ∨ d = 3 ∨ d = 4 ∨ d = 5 ∨ d = 6 ∨ d = 7 ∨ d = 8 ∨ d = 9 := by
      omega
    rcases this with rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl <;> rfl
  have hlen : List.replicate (4 - (Nat.toDigits 10 n).length) '0' ++ Nat.toDigits 10 n =
        [digitChar (n / 1000 % 10), digitChar (n / 100 % 10),
          digitChar (n / 10 % 10), digitChar (n % 10)] := by
    by_cases h1 : n < 10
    · rw [Nat.toDigits_of_lt_base h1, h10 n h1]
      have hd0 : digitChar 0 = '0' := rfl
      simp [show n / 1000 % 10 = 0 by omega, show n / 100 % 10 = 0 by omega,
        show n / 10 % 10 = 0 by omega, show n % 10 = n by omega, hd0]
    · by_cases h2 : n < 100
      · rw [Nat.toDigits_of_base_le (by decide) (by omega),
          Nat.toDigits_of_lt_base (by omega), h10 _ (by omega), h10 _ (Nat.mod_lt _ (by decide))]
        have hd0 : digitChar 0 = '0' := rfl
        simp [show n / 1000 % 10 = 0 by omega, show n / 100 % 10 = 0 by omega,
          show n / 10 % 10 = n / 10 by omega, hd0]
      · by_cases h3 : n < 1000
        · rw [Nat.toDigits_of_base_le (by decide) (by omega),
            Nat.toDigits_of_base_le (by decide) (by omega),
            Nat.toDigits_of_lt_base (by omega), h10 _ (by omega),
            h10 _ (Nat.mod_lt _ (by decide)), h10 _ (Nat.mod_lt _ (by decide))]
          have hd0 : digitChar 0 = '0' := rfl
          simp
          exact ⟨by rw [show n / 1000 % 10 = 0 by omega, hd0],
            congrArg digitChar (by omega)⟩
        · rw [Nat.toDigits_of_base_le (by decide) (by omega),
            Nat.toDigits_of_base_le (by decide) (by omega),
            Nat.toDigits_of_base_le (by decide) (by omega),
            Nat.toDigits_of_lt_base (by omega), h10 _ (by omega),
            h10 _ (Nat.mod_lt _ (by decide)), h10 _ (Nat.mod_lt _ (by decide)),
            h10 _ (Nat.mod_lt _ (by decide))]
          simp
          exact ⟨congrArg digitChar (by omega), congrArg digitChar (by omega)⟩
  unfold padZero
  rw [hts, String.length_ofList, ← String.ofList_append]
  exact congrArg String.ofList hlen

/-- A month from 1 to 12 padded to two digits is its two decimal digits. -/
private theorem padZero2_eq_digits {m : Nat} (hm1 : 1 ≤ m) (hm2 : m ≤ 12) :
    padZero 2 (toString (m : Int)) =
      String.ofList [digitChar (m / 10 % 10), digitChar (m % 10)] := by
  have cases : m = 1 ∨ m = 2 ∨ m = 3 ∨ m = 4 ∨ m = 5 ∨ m = 6 ∨
      m = 7 ∨ m = 8 ∨ m = 9 ∨ m = 10 ∨ m = 11 ∨ m = 12 := by omega
  rcases cases with rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl <;>
    decide

end Schedules

/-- `monthsBetween` counts inclusive calendar months from `start`'s month to `endDate`'s month,
ignoring days (including month-end days). -/
theorem monthsBetween_spec {start endDate : LocalDate} (hs : start.WF) (he : endDate.WF) :
    Schedules.monthsBetween start endDate =
      ((endDate.toCalendarDate.year : Int) - (start.toCalendarDate.year : Int)) * 12 +
        (endDate.toCalendarDate.month : Int) - (start.toCalendarDate.month : Int) + 1 := by
  unfold Schedules.monthsBetween
  rw [Schedules.parseYearMonth_of_wf hs, Schedules.parseYearMonth_of_wf he]

/-- For valid `start ≤ endDate`, `monthsBetween` lies between `1` and `120000`. -/
theorem monthsBetween_bounds_of_le {start endDate : LocalDate} (hs : start.WF) (he : endDate.WF)
    (hle : start ≤ endDate) :
    1 ≤ Schedules.monthsBetween start endDate ∧ Schedules.monthsBetween start endDate ≤ 120000 := by
  rw [monthsBetween_spec hs he]
  have h1 := hs.toCalendarDate_spec.1
  have h2 := he.toCalendarDate_spec.1
  have hle' : start.toCalendarDate.dayNumber ≤ endDate.toCalendarDate.dayNumber :=
    (LocalDate.WF.le_iff hs he).mp hle
  have hnb : ¬ endDate.toCalendarDate.Before start.toCalendarDate := by
    intro hb
    have := (h2.before_iff_dayNumber_lt h1).mp hb
    omega
  unfold CalendarDate.Before at hnb
  have hy1 := h1.year_le
  have hm1 := h1.month_pos
  have hm1' := h1.month_le
  have hy2 := h2.year_le
  have hm2 := h2.month_pos
  have hm2' := h2.month_le
  omega

/-- `addMonths` produces a valid calendar date on the first of the target month whenever the
shifted total month index lies in `[0, 119999]` (years 0000 to 9999). -/
theorem addMonths_spec {start : LocalDate} (hs : start.WF) (offset : Int)
    (h0 : 0 ≤ (start.toCalendarDate.year : Int) * 12 + (start.toCalendarDate.month : Int) - 1 + offset)
    (hmax : (start.toCalendarDate.year : Int) * 12 + (start.toCalendarDate.month : Int) - 1 + offset < 120000) :
    let total := ((start.toCalendarDate.year : Int) * 12 + (start.toCalendarDate.month : Int) - 1 + offset).toNat
    let target : CalendarDate := ⟨total / 12, total % 12 + 1, 1⟩
    (Schedules.addMonths start offset).WF ∧
      Schedules.addMonths start offset = ⟨target.format⟩ ∧
      (Schedules.addMonths start offset).toCalendarDate = target := by
  intro total target
  have htotal_eq : (start.toCalendarDate.year : Int) * 12 + (start.toCalendarDate.month : Int) - 1 + offset =
      (total : Int) :=
    (Int.toNat_of_nonneg h0).symm
  have htotal_lt : total < 120000 := by omega
  have hy : total / 12 ≤ 9999 := by omega
  have hm1 : 1 ≤ total % 12 + 1 := by omega
  have hm2 : total % 12 + 1 ≤ 12 := by omega
  have hvalid : target.Valid := by
    refine ⟨hy, hm1, hm2, by simp [target], ?_⟩
    simp only [target, CalendarDate.monthLength]
    split_ifs <;> decide
  have heq : Schedules.addMonths start offset = ⟨target.format⟩ := by
    unfold Schedules.addMonths
    rw [Schedules.parseYearMonth_of_wf hs]
    dsimp only
    rw [htotal_eq]
    have hediv : Int.ediv (total : Int) 12 = ((total / 12 : Nat) : Int) := rfl
    have hmod : jsMod (total : Int) 12 + 1 = ((total % 12 + 1 : Nat) : Int) := by
      change Int.tmod (total : Int) 12 + 1 = ((total % 12 + 1 : Nat) : Int)
      rw [Int.tmod_eq_emod_of_nonneg (by omega)]
      rfl
    rw [hediv, hmod, Schedules.padZero4_eq_digits hy, Schedules.padZero2_eq_digits hm1 hm2]
    apply congrArg LocalDate.mk
    apply String.ext
    simp only [CalendarDate.format, CalendarDate.chars, String.toList_append, String.toList_ofList,
      List.append_assoc, List.cons_append, List.nil_append, target]
    have h0' : digitChar (1 / 10 % 10) = '0' := rfl
    have h1' : digitChar (1 % 10) = '1' := rfl
    rw [h0', h1']
    rfl
  have hwf : (Schedules.addMonths start offset).WF := by
    rw [heq]
    exact ⟨target, hvalid, rfl⟩
  refine ⟨hwf, heq, ?_⟩
  rw [heq]
  unfold LocalDate.toCalendarDate
  rw [parseLocalDate_format hvalid]
  rfl

/-- Padding never makes a text shorter than the width. -/
private theorem padZero_length_ge (w : Nat) (s : String) : w ≤ (Schedules.padZero w s).length := by
  unfold Schedules.padZero
  rw [String.length_append, String.length_ofList, List.length_replicate]
  omega

/-- A number of at least 10,000 has at least five decimal digits. -/
private theorem toDigits_length_ge_5 {n : Nat} (hn : 10000 ≤ n) :
    5 ≤ (Nat.toDigits 10 n).length := by
  rw [Nat.toDigits_of_base_le (by decide) (by omega),
    Nat.toDigits_of_base_le (by decide) (by omega),
    Nat.toDigits_of_base_le (by decide) (by omega),
    Nat.toDigits_of_base_le (by decide) (by omega)]
  simp only [List.length_append, List.length_singleton]
  have hpos : 1 ≤ (Nat.toDigits 10 (n / 10 / 10 / 10 / 10)).length := by
    by_cases hlt : n / 10 / 10 / 10 / 10 < 10
    · rw [Nat.toDigits_of_lt_base hlt]; simp
    · rw [Nat.toDigits_of_base_le (by decide) (by omega)]; simp
  omega

/-- The text of a negative number contains a dash. -/
private theorem dash_mem_toString_neg {q : Int} (hq : q < 0) : '-' ∈ (toString q).toList := by
  cases q with
  | ofNat _ => exact absurd hq (Int.not_lt_of_ge (Int.natCast_nonneg _))
  | negSucc n =>
    change '-' ∈ ("-" ++ toString (n + 1)).toList
    simp

/-- `addMonths` produces a real `LocalDate` (`LocalDate.WF`) if and only if the shifted month index
is non-negative and stays within years 0000 to 9999. -/
theorem addMonths_wf_iff {start : LocalDate} (hs : start.WF) (offset : Int) :
    (Schedules.addMonths start offset).WF ↔
      0 ≤ (start.toCalendarDate.year : Int) * 12 + (start.toCalendarDate.month : Int) - 1 + offset ∧
        (start.toCalendarDate.year : Int) * 12 + (start.toCalendarDate.month : Int) - 1 + offset < 120000 := by
  refine ⟨fun hwf => ?_, fun ⟨h0, hmax⟩ => (addMonths_spec hs offset h0 hmax).1⟩
  obtain ⟨c, hc, hfmt⟩ := hwf
  have hlen10 : (Schedules.addMonths start offset).value.length = 10 := by
    rw [hfmt, CalendarDate.format, String.length_ofList]
    rfl
  unfold Schedules.addMonths at hlen10 hfmt
  rw [Schedules.parseYearMonth_of_wf hs] at hlen10 hfmt
  dsimp only at hlen10 hfmt
  set total := (start.toCalendarDate.year : Int) * 12 + (start.toCalendarDate.month : Int) - 1 + offset
  set yStr := Schedules.padZero 4 (toString (Int.ediv total 12))
  set mStr := Schedules.padZero 2 (toString (jsMod total 12 + 1))
  have hy_ge : 4 ≤ yStr.length := padZero_length_ge 4 _
  have hm_ge : 2 ≤ mStr.length := padZero_length_ge 2 _
  have hy4 : yStr.length = 4 := by
    have hadd_len : (yStr ++ "-" ++ mStr ++ "-01").length = yStr.length + 1 + mStr.length + 3 := by
      simp only [String.length_append]
      rw [show ("-" : String).length = 1 from rfl, show ("-01" : String).length = 3 from rfl]
    have h10 : (yStr ++ "-" ++ mStr ++ "-01").length = 10 := hlen10
    omega
  constructor
  · by_contra hlt
    have hq_neg : Int.ediv total 12 < 0 := Int.ediv_neg_of_neg_of_pos (not_le.mp hlt) (by decide)
    have hdash : '-' ∈ yStr.toList := by
      have hm := dash_mem_toString_neg hq_neg
      simp only [yStr, Schedules.padZero, String.toList_append, String.toList_ofList, List.mem_append]
      exact Or.inr hm
    have hc4 : (c.format.toList.take 4).all isAsciiDigit = true := by
      rw [CalendarDate.format, String.toList_ofList, CalendarDate.chars]
      simp [isAsciiDigit_digitChar_mod]
    have hylist : yStr.toList.length = 4 := by
      rw [← String.length_toList] at hy4
      exact hy4
    have htake : (yStr ++ "-" ++ mStr ++ "-01").toList.take 4 = yStr.toList := by
      simp only [String.toList_append, List.append_assoc]
      rw [List.take_left' hylist]
    have hy_digits : yStr.toList.all isAsciiDigit = true := by
      rw [← htake, hfmt]
      exact hc4
    have hmem := (List.all_eq_true.mp hy_digits) '-' hdash
    simp [isAsciiDigit] at hmem
  · by_contra hge
    have hq_ge : 10000 ≤ Int.ediv total 12 :=
      Int.le_ediv_of_mul_le (by decide) (by omega)
    have hq_nat : 10000 ≤ (Int.ediv total 12).toNat := by omega
    have hdig : 5 ≤ (toString (Int.ediv total 12)).length := by
      have hrep : Int.ediv total 12 = ((Int.ediv total 12).toNat : Int) := (Int.toNat_of_nonneg (by omega)).symm
      rw [hrep]
      change 5 ≤ (String.ofList (Nat.toDigits 10 (Int.ediv total 12).toNat)).length
      rw [String.length_ofList]
      exact toDigits_length_ge_5 hq_nat
    have hy5 : 5 ≤ yStr.length := by
      unfold yStr Schedules.padZero
      rw [String.length_append]
      omega
    omega

/-- `addMonths` can produce a year beyond `9999` (not a real `LocalDate`), witnessed by
`"9999-12-31"` plus 1 month giving `"10000-01-01"`. -/
theorem addMonths_overflow_witness :
    Schedules.addMonths ⟨"9999-12-31"⟩ 1 = ⟨"10000-01-01"⟩ ∧
      ¬ (Schedules.addMonths ⟨"9999-12-31"⟩ 1).WF ∧
      localDate "10000-01-01" = .error (.invalidLocalDate "10000-01-01") := by
  refine ⟨by decide, ?_, by decide⟩
  intro hwf
  have h1 := (localDate_ok_iff "9999-12-31" ⟨"9999-12-31"⟩).mp (by decide)
  have h2 := (addMonths_wf_iff h1.2 1).mp hwf
  have hc : (LocalDate.mk "9999-12-31").toCalendarDate = ⟨9999, 12, 31⟩ := by decide
  rw [hc] at h2
  dsimp only at h2
  omega

/-- `addMonths` can produce a negative shifted year and month `00` (not a real `LocalDate`),
witnessed by `"0000-01-01"` plus `-1` month giving `"00-1-00-01"`. -/
theorem addMonths_underflow_witness :
    Schedules.addMonths ⟨"0000-01-01"⟩ (-1) = ⟨"00-1-00-01"⟩ ∧
      ¬ (Schedules.addMonths ⟨"0000-01-01"⟩ (-1)).WF ∧
      localDate "00-1-00-01" = .error (.invalidLocalDate "00-1-00-01") := by
  refine ⟨by decide, ?_, by decide⟩
  intro hwf
  have h1 := (localDate_ok_iff "0000-01-01" ⟨"0000-01-01"⟩).mp (by decide)
  have h2 := (addMonths_wf_iff h1.2 (-1)).mp hwf
  have hc : (LocalDate.mk "0000-01-01").toCalendarDate = ⟨0, 1, 1⟩ := by decide
  rw [hc] at h2
  dsimp only at h2
  omega

/-- On month-end dates, `addMonths` always lands on day `01` (even for offset `0`), and
`monthsBetween` counts inclusive calendar months ignoring the day of month. -/
theorem monthEnd_examples :
    Schedules.addMonths ⟨"2024-01-31"⟩ 1 = ⟨"2024-02-01"⟩ ∧
      Schedules.addMonths ⟨"2024-01-31"⟩ 0 = ⟨"2024-01-01"⟩ ∧
      Schedules.monthsBetween ⟨"2024-01-31"⟩ ⟨"2024-02-01"⟩ = 2 ∧
      Schedules.monthsBetween ⟨"2024-01-31"⟩ ⟨"2024-01-31"⟩ = 1 := by
  decide

/-- Every generated date is `addMonths` of the start by a whole number of steps. -/
private theorem mem_scheduleDates {startsOn : LocalDate} {step : Int} {count : Nat} {d : LocalDate}
    (hd : d ∈ Schedules.scheduleDates startsOn step count) :
    ∃ i : Nat, i < count ∧ d = Schedules.addMonths startsOn ((i : Int) * step) := by
  unfold Schedules.scheduleDates at hd
  rw [List.mem_map] at hd
  rcases hd with ⟨i, hi, rfl⟩
  exact ⟨i, List.mem_range.mp hi, rfl⟩

/-- The generated date at an index is `addMonths` of the start by that many steps. -/
private theorem getElem_scheduleDates {startsOn : LocalDate} {step : Int} {count i : Nat}
    (hi : i < (Schedules.scheduleDates startsOn step count).length) :
    (Schedules.scheduleDates startsOn step count)[i] =
      Schedules.addMonths startsOn ((i : Int) * step) := by
  simp only [Schedules.scheduleDates, List.getElem_map, List.getElem_range]
  rfl

/-- The dates generated by `scheduleDates` from valid `startsOn ≤ endsOn` with positive `step` and
`count = ceil(months / step)` are nonempty, valid `LocalDate`s on the first of each month, and
strictly increasing in calendar/string order. -/
theorem scheduleDates_spec {startsOn endsOn : LocalDate} (hs : startsOn.WF) (he : endsOn.WF)
    (hle : startsOn ≤ endsOn) {step : Int} (hstep : 1 ≤ step) :
    let months := Schedules.monthsBetween startsOn endsOn
    let count := jsDiv (months + step - 1) step
    let dates := Schedules.scheduleDates startsOn step count.toNat
    1 ≤ count ∧
      dates.length = count.toNat ∧
      (∀ d ∈ dates, d.WF ∧ d.toCalendarDate.day = 1) ∧
      dates.Pairwise (· < ·) := by
  intro months count dates
  obtain ⟨hm1, hm2⟩ := monthsBetween_bounds_of_le hs he hle
  have hnum_pos : 0 < months + step - 1 := by omega
  have hcount_eq : count = Int.ediv (months + step - 1) step := by
    simp only [count, jsDiv]
    exact Int.tdiv_eq_ediv_of_nonneg (by omega)
  have hcount_ge1 : 1 ≤ count := by
    rw [hcount_eq]
    have : 1 * step ≤ months + step - 1 := by omega
    exact Int.le_ediv_of_mul_le (by omega) this
  have hcount_mul : (count - 1) * step ≤ months - 1 := by
    have hle1 : count * step - step ≤ months - 1 := by
      have : count * step ≤ months + step - 1 := by
        rw [hcount_eq]
        exact Int.ediv_mul_le (months + step - 1) (by omega)
      omega
    linarith
  have hsy := hs.toCalendarDate_spec.1
  have hey := he.toCalendarDate_spec.1
  have hstart_nonneg : 0 ≤ (startsOn.toCalendarDate.year : Int) * 12 +
      (startsOn.toCalendarDate.month : Int) - 1 := by
    have := hsy.month_pos; omega
  have hend_lt : (endsOn.toCalendarDate.year : Int) * 12 +
      (endsOn.toCalendarDate.month : Int) - 1 < 120000 := by
    have := hey.year_le; have := hey.month_le; omega
  have hbound : ∀ i : Nat, i < count.toNat →
      0 ≤ (startsOn.toCalendarDate.year : Int) * 12 + (startsOn.toCalendarDate.month : Int) - 1 +
          (i : Int) * step ∧
        (startsOn.toCalendarDate.year : Int) * 12 + (startsOn.toCalendarDate.month : Int) - 1 +
          (i : Int) * step < 120000 := by
    intro i hi
    have hi_le : (i : Int) ≤ count - 1 := by omega
    have his_le : (i : Int) * step ≤ (count - 1) * step := Int.mul_le_mul_of_nonneg_right hi_le (by omega)
    have hms := monthsBetween_spec hs he
    have : (startsOn.toCalendarDate.year : Int) * 12 + (startsOn.toCalendarDate.month : Int) - 1 +
        (months - 1) =
        (endsOn.toCalendarDate.year : Int) * 12 + (endsOn.toCalendarDate.month : Int) - 1 := by
      change (startsOn.toCalendarDate.year : Int) * 12 + (startsOn.toCalendarDate.month : Int) - 1 +
          (Schedules.monthsBetween startsOn endsOn - 1) = _
      rw [hms]
      ring
    have h0 : 0 ≤ (i : Int) * step := Int.mul_nonneg (by omega) (by omega)
    omega
  refine ⟨hcount_ge1, ?_, ?_, ?_⟩
  · simp [dates, Schedules.scheduleDates]
  · intro d hd
    obtain ⟨i, hi, rfl⟩ := mem_scheduleDates hd
    obtain ⟨h0, hmax⟩ := hbound i hi
    obtain ⟨hwf, _, hcd⟩ := addMonths_spec hs ((i : Int) * step) h0 hmax
    exact ⟨hwf, by rw [hcd]⟩
  · rw [List.pairwise_iff_getElem]
    intro i j hi hj hlt
    have hlen : dates.length = count.toNat := by simp [dates, Schedules.scheduleDates]
    have hi' : i < count.toNat := hlen ▸ hi
    have hj' : j < count.toNat := hlen ▸ hj
    rw [getElem_scheduleDates hi, getElem_scheduleDates hj]
    obtain ⟨h0i, hmaxi⟩ := hbound i hi'
    obtain ⟨h0j, hmaxj⟩ := hbound j hj'
    obtain ⟨hwfi, _, hcdi⟩ := addMonths_spec hs ((i : Int) * step) h0i hmaxi
    obtain ⟨hwfj, _, hcdj⟩ := addMonths_spec hs ((j : Int) * step) h0j hmaxj
    rw [LocalDate.WF.lt_iff hwfi hwfj]
    have hbi : (Schedules.addMonths startsOn ((i : Int) * step)).toCalendarDate.Before
        (Schedules.addMonths startsOn ((j : Int) * step)).toCalendarDate := by
      rw [hcdi, hcdj]
      have htot_lt :
          ((startsOn.toCalendarDate.year : Int) * 12 + (startsOn.toCalendarDate.month : Int) - 1 +
            (i : Int) * step).toNat <
          ((startsOn.toCalendarDate.year : Int) * 12 + (startsOn.toCalendarDate.month : Int) - 1 +
            (j : Int) * step).toNat := by
        have hstep_lt : (i : Int) * step < (j : Int) * step :=
          Int.mul_lt_mul_of_pos_right (by exact_mod_cast hlt) (by omega)
        omega
      unfold CalendarDate.Before
      dsimp only
      omega
    exact (hwfi.toCalendarDate_spec.1.before_iff_dayNumber_lt hwfj.toCalendarDate_spec.1).mp hbi

end Rastrata.Kernel

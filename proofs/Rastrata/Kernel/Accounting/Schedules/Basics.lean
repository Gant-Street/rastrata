/-
Helpers for the laws of `Accounting/Schedules.lean`: what the lifts of the numeric errors do, the
size-limit errors of `accountingSum` and `quantize`, the order of dates, a schedule that
`scheduleMisordered` accepts, and what `policyAt` hands over for an allocation policy.
-/
import Rastrata.Kernel.Accounting.Schedules.Model

namespace Rastrata.Kernel

namespace Schedules

/-- A lifted exact-number result that is `.ok` was `.ok` before the lift. -/
theorem liftNum_ok {α : Type} {r : Except NumErr α} {v : α}
    (h : liftNum r = .ok v) : r = .ok v := by
  cases r with
  | error e => cases h
  | ok x => cases h; rfl

/-- A lifted `quantize` result that is `.ok` was `.ok` before the lift. -/
theorem liftQuantize_ok {α : Type} {r : Except QuantizeErr α} {v : α}
    (h : liftQuantize r = .ok v) : r = .ok v := by
  cases r with
  | error e => cases h
  | ok x => cases h; rfl

/-- A lifted identifier result that is `.ok` was `.ok` before the lift. -/
theorem liftCanonical_ok {α : Type} {r : Except CanonicalErr α} {v : α}
    (h : liftCanonical r = .ok v) : r = .ok v := by
  cases r with
  | error e => cases h
  | ok x => cases h; rfl

/-- A result carried out of `numeric.ts` that is `.ok` was `.ok` before it was carried. -/
theorem liftExact_ok {α : Type} {r : Except NumErr α} {v : α}
    (h : liftExact r = .ok v) : r = .ok v := by
  cases r with
  | error e => cases h
  | ok x => cases h; rfl

/-- A lifted exact-number result that is an error was that error before the lift. -/
theorem liftNum_error {α : Type} {r : Except NumErr α} {e : ScheduleErr}
    (h : liftNum r = .error e) : ∃ code, r = .error code ∧ e = .quantize (.exactNumber code) := by
  cases r with
  | error code => cases h; exact ⟨code, rfl, rfl⟩
  | ok _ => cases h

/-- A lifted `quantize` result that is an error was that error before the lift. -/
theorem liftQuantize_error {α : Type} {r : Except QuantizeErr α} {e : ScheduleErr}
    (h : liftQuantize r = .error e) : ∃ qe, r = .error qe ∧ e = .quantize qe := by
  cases r with
  | error qe => cases h; exact ⟨qe, rfl, rfl⟩
  | ok _ => cases h

/-- A lifted identifier result that is an error was that error before the lift. -/
theorem liftCanonical_error {α : Type} {r : Except CanonicalErr α} {e : ScheduleErr}
    (h : liftCanonical r = .error e) : ∃ ce, r = .error ce ∧ e = .identity ce := by
  cases r with
  | error ce => cases h; exact ⟨ce, rfl, rfl⟩
  | ok _ => cases h

/-- Adding up constructible values that returns gives a constructible value that means their sum. -/
theorem accountingSum_ok {values : List ExactRational} {res : ExactRational}
    (hv : ∀ v ∈ values, v.WF) (h : accountingSum values = .ok res) :
    res.WF ∧ res.toRat = (values.map ExactRational.toRat).sum := by
  have ⟨hwf, hrat⟩ := addExactValues_ok ExactRational.zero_wf hv h
  rw [ExactRational.zero_toRat, zero_add] at hrat
  exact ⟨hwf, hrat⟩

/-- Adding up constructible values throws only the size error. -/
theorem accountingSum_error {values : List ExactRational} {code : NumErr}
    (hv : ∀ v ∈ values, v.WF) (h : accountingSum values = .error code) :
    code = .representationLimitExceeded :=
  addExactValues_error ExactRational.zero_wf hv h

/-- `quantize` of a constructible value throws the `RangeError` exactly when the scale is outside 0 to 1,000. -/
theorem quantize_error_scale_iff {value : ExactRational} {rule : QuantizationRule}
    (hv : value.WF) :
    quantize value rule = .error .scaleOutOfRange ↔
      rule.targetScale < 0 ∨ rule.targetScale > maxDecimalScale := by
  constructor
  · intro h
    by_contra hn
    have hnot : ¬ (rule.targetScale < 0 ∨ rule.targetScale > maxDecimalScale) := hn
    have h1 : 0 ≤ rule.targetScale := by omega
    have h2 : rule.targetScale ≤ maxDecimalScale := by omega
    have he := quantize_error hv h1 h2 h
    cases he
  · intro hs
    simp [quantize, hs]

/-- `quantize` of a constructible value throws only the `RangeError` for the scale or the size error. -/
theorem quantize_error_cases {value : ExactRational} {rule : QuantizationRule}
    {e : QuantizeErr} (hv : value.WF) (h : quantize value rule = .error e) :
    (e = .scaleOutOfRange ∧ (rule.targetScale < 0 ∨ rule.targetScale > maxDecimalScale)) ∨
      (e = .exactNumber .representationLimitExceeded ∧
        0 ≤ rule.targetScale ∧ rule.targetScale ≤ maxDecimalScale) := by
  by_cases hs : rule.targetScale < 0 ∨ rule.targetScale > maxDecimalScale
  · left
    have hscale : quantize value rule = .error .scaleOutOfRange :=
      (quantize_error_scale_iff hv).mpr hs
    rw [hscale] at h
    cases h
    exact ⟨rfl, hs⟩
  · right
    have h1 : 0 ≤ rule.targetScale := by omega
    have h2 : rule.targetScale ≤ maxDecimalScale := by omega
    exact ⟨quantize_error hv h1 h2 h, h1, h2⟩

/-- The order of two local dates as strings is transitive. -/
theorem localDate_lt_trans {a b c : LocalDate} (hab : a < b) (hbc : b < c) : a < c := by
  change jsStringLt a.value c.value = true
  change jsStringLt a.value b.value = true at hab
  change jsStringLt b.value c.value = true at hbc
  simp only [jsStringLt, beq_iff_eq] at hab hbc ⊢
  exact compareCanonicalText_trans a.value b.value c.value hab hbc

/-- A schedule that `scheduleMisordered` accepts has its dates strictly increasing, and every one of
them after the date it was told to follow. -/
theorem scheduleMisordered_false_dates :
    ∀ (idx : Nat) (prev : Option LocalDate) (items : List ScheduledAllocation),
      scheduleMisordered idx prev items = false →
        ((items.map (·.accountingDate)).Pairwise (· < ·)) ∧
          ∀ d, prev = some d → ∀ item ∈ items, d < item.accountingDate
  | _, _, [], _ => ⟨List.Pairwise.nil, fun _ _ _ hx => by simp at hx⟩
  | idx, prev, item :: rest, h => by
    have hrec := fun hh => scheduleMisordered_false_dates (idx + 1) (some item.accountingDate) rest hh
    cases prev with
    | none =>
      simp only [scheduleMisordered, Bool.or_eq_false_iff] at h
      obtain ⟨hp, hrp⟩ := hrec h.2
      refine ⟨?_, fun d hd => by cases hd⟩
      simp only [List.map_cons, List.pairwise_cons, List.mem_map]
      exact ⟨by rintro _ ⟨x, hx, rfl⟩; exact hrp item.accountingDate rfl x hx, hp⟩
    | some d =>
      simp only [scheduleMisordered, Bool.or_eq_false_iff] at h
      obtain ⟨hp, hrp⟩ := hrec h.2
      have hd : d < item.accountingDate := by
        have h1 : jsStringLe item.accountingDate.value d.value = false := h.1.2
        have h2 := (jsStringLe_iff_not_lt item.accountingDate.value d.value).not
        simp only [not_not] at h2
        exact h2.mp (by simp [h1])
      refine ⟨?_, fun d' hd' x hx => ?_⟩
      · simp only [List.map_cons, List.pairwise_cons, List.mem_map]
        exact ⟨by rintro _ ⟨x, hx, rfl⟩; exact hrp item.accountingDate rfl x hx, hp⟩
      · cases hd'
        rcases List.mem_cons.mp hx with rfl | hx
        · exact hd
        · exact localDate_lt_trans hd (hrp item.accountingDate rfl x hx)

end Schedules

/-- The policy `policyAt` selects for an allocation schedule is constructible when the policies
are, has the identifier and version asked for, and if it names a posting algorithm it is the
cumulative one. -/
theorem policyAt_allocation_selected {policies : List AccountingPolicy} {id : PolicyId}
    {version : SemanticVersion} {at_ : Instant} {policy : AllocationPolicy}
    (hpol : ∀ p ∈ policies, p.WF)
    (h : policyAt AllocationPolicy policies id version at_ = .selected policy) :
    policy.WF ∧ (policy.postingAlgorithm.isSome = true → usesCumulativeAllocation policy = true) ∧
      policy.id = id ∧ policy.version = version := by
  obtain ⟨selected, hf, hex, hof⟩ := (policyAt_selected_iff AllocationPolicy policies id version at_
    policy).mp h
  have hmem : selected ∈ policies.filter
      (policyMatches (AccountingPolicyKind.kind AllocationPolicy) id version at_) := by
    rw [hf]; simp
  obtain ⟨hmem', hmatch⟩ := List.mem_filter.mp hmem
  have hsel : selected = .allocationSchedule policy := by
    cases selected <;> simp [AccountingPolicyKind.ofPolicy?] at hof ⊢
    exact hof
  subst hsel
  have hwf : (AccountingPolicy.allocationSchedule policy).WF := hpol _ hmem'
  obtain ⟨-, hid, hver, -⟩ := (policyMatches_iff _ id version at_ _).mp hmatch
  refine ⟨hwf, ?_, hid, hver⟩
  intro hsome
  unfold policyExecutable at hex
  simp only [Bool.and_eq_true, Bool.not_eq_true'] at hex
  simpa [hsome] using hex.2

end Rastrata.Kernel

/-
The loop over the events of `projectAccountingBasis`: what one event does, and what the loop does.
-/
import Rastrata.Kernel.Accounting.Basis.Laws2

namespace Rastrata.Kernel

/-! ## What the loop can reject with -/

/-- The settlement-ratio step rejects with one of two diagnostics. -/
theorem settlementRatioOf_rejected {policy : AccountingBasisPolicy}
    {snapshot : AccountingReadSnapshot} {event : BasisSourceEvent} {d : SemanticDiagnostic}
    (h : settlementRatioOf policy snapshot event = .ok (.rejected d)) :
    d = basisGraphDiagnostic ∨ d = basisRatioDiagnostic := by
  unfold settlementRatioOf at h
  dsimp only at h
  split at h
  · cases h
    exact Or.inl rfl
  · split at h
    · cases h
      exact Or.inl rfl
    · split at h
      · cases h
      · split at h
        · cases h
        · split at h
          · cases h
            exact Or.inr rfl
          · cases h

/-- One event is rejected with the rule diagnostic or one of the ratio diagnostics. -/
theorem processBasisEvent_rejected {policy : AccountingBasisPolicy}
    {snapshot : AccountingReadSnapshot} {event : BasisSourceEvent} {count : Nat}
    {totals : BasisTotals} {d : SemanticDiagnostic}
    (h : processBasisEvent policy snapshot event count totals = .ok (.rejected d)) :
    d = basisRuleDiagnostic ∨ d = basisGraphDiagnostic ∨ d = basisRatioDiagnostic := by
  unfold processBasisEvent at h
  split at h
  · split at h
    · cases h
    · rename_i diagnostic hd
      cases h
      split at hd
      · exact Or.inr (settlementRatioOf_rejected hd)
      · cases hd
    · split at h
      · cases h
      · cases h
  · cases h
    exact Or.inl rfl

/-- The loop rejects with the rule diagnostic or one of the ratio diagnostics. -/
theorem basisLoop_rejected {policy : AccountingBasisPolicy} {snapshot : AccountingReadSnapshot}
    {d : SemanticDiagnostic} :
    ∀ {events : List BasisSourceEvent} {count : Nat} {totals : BasisTotals},
      basisLoop policy snapshot count totals events = .ok (.rejected d) →
        d = basisRuleDiagnostic ∨ d = basisGraphDiagnostic ∨ d = basisRatioDiagnostic
  | [], _, _, h => by simp [basisLoop] at h
  | event :: rest, count, totals, h => by
    unfold basisLoop at h
    split at h
    · cases h
    · rename_i diagnostic hp
      cases h
      exact processBasisEvent_rejected hp
    · rename_i entry totals' hp
      split at h
      · cases h
      · rename_i diagnostic hl
        cases h
        exact basisLoop_rejected hl
      · cases h

/-! ## When one event is rejected -/

/-- The test of line 1470: the event has no open item, or its open item is of another book, or has
no positive absolute value, or the allocations or the recognition do not close. -/
def settlementGraphFails (policy : AccountingBasisPolicy) (snapshot : AccountingReadSnapshot)
    (event : BasisSourceEvent) : Bool :=
  match basisOpenItem snapshot event with
  | none => true
  | some item =>
    item.bookId != policy.bookId || !positive item.bookValue.abs ||
      !allocationsClose snapshot event (basisOpenItem snapshot event) ||
      !recognitionCloses event (basisOpenItem snapshot event)

/-- The settlement-ratio step rejects with the graph diagnostic exactly when the test of line 1470
holds. -/
theorem settlementRatioOf_graph_iff (policy : AccountingBasisPolicy)
    (snapshot : AccountingReadSnapshot) (event : BasisSourceEvent) :
    settlementRatioOf policy snapshot event = .ok (.rejected basisGraphDiagnostic) ↔
      settlementGraphFails policy snapshot event = true := by
  unfold settlementRatioOf settlementGraphFails
  dsimp only
  generalize basisOpenItem snapshot event = openItem
  cases openItem with
  | none => simp
  | some item =>
    by_cases hc : (item.bookId != policy.bookId || !positive item.bookValue.abs ||
        !allocationsClose snapshot event (some item) ||
        !recognitionCloses event (some item)) = true
    · simp [hc]
    · simp only [hc, if_false, Bool.false_eq_true, iff_false]
      split
      · simp
      · split
        · simp
        · split <;> simp [basisRatioDiagnostic, basisGraphDiagnostic, diagnostic]
/-- The values the settlement ratio adds up (line 1471): for each allocation of the open item,
`allocatedOpenItemBookValue ?? allocatedBookValue`. -/
def ratioValues (snapshot : AccountingReadSnapshot) (event : BasisSourceEvent) :
    List ExactRational :=
  (basisAllocations snapshot event).map fun allocation =>
    allocation.allocatedOpenItemBookValue.getD allocation.allocatedBookValue

/-- The settlement-ratio step rejects with the range diagnostic exactly when the graph closes and the
ratio, the sum of the allocations over the open item's absolute book value, is below zero or above
one. -/
theorem settlementRatioOf_range_iff (policy : AccountingBasisPolicy)
    (snapshot : AccountingReadSnapshot) (event : BasisSourceEvent) :
    settlementRatioOf policy snapshot event = .ok (.rejected basisRatioDiagnostic) ↔
      settlementGraphFails policy snapshot event = false ∧
        ∃ item total ratio, basisOpenItem snapshot event = some item ∧
          liftExact (accountingSum (ratioValues snapshot event)) = .ok total ∧
          liftExact (total.divide item.bookValue.abs) = .ok ratio ∧
          (ratio.compare ExactRational.zero = .lt ∨ ratio.compare basisOne = .gt) := by
  unfold settlementRatioOf settlementGraphFails ratioValues
  dsimp only
  generalize hO : basisOpenItem snapshot event = openItem
  constructor
  · intro h
    cases openItem with
    | none => simp [basisGraphDiagnostic, basisRatioDiagnostic, diagnostic] at h
    | some item =>
      simp only at h
      split at h
      · simp [basisGraphDiagnostic, basisRatioDiagnostic, diagnostic] at h
      · rename_i hc
        split at h
        · cases h
        · rename_i total hs
          split at h
          · cases h
          · rename_i ratio hd
            split at h
            · rename_i hrange
              refine ⟨by simpa using hc, item, total, ratio, rfl, hs, hd, by simpa using hrange⟩
            · cases h
  · rintro ⟨hg, item, total, ratio, hitem, hs, hd, hr⟩
    cases openItem with
    | none => simp at hitem
    | some item' =>
      simp only [Option.some.injEq] at hitem
      subst hitem
      simp only at hg ⊢
      have hc : ¬ (item'.bookId != policy.bookId || !positive item'.bookValue.abs ||
          !allocationsClose snapshot event (some item') ||
          !recognitionCloses event (some item')) = true := by simpa using hg
      rw [if_neg hc]
      rw [hs]
      simp only
      rw [hd]
      simp only
      rw [if_pos (by simpa using hr)]
/-- The rules of the policy for an event's kind (line 1455). -/
def basisRulesFor (policy : AccountingBasisPolicy) (event : BasisSourceEvent) :
    List AccountingBasisRule :=
  policy.rules.filter fun rule => rule.event == event.event

/-- One event is rejected with a diagnostic exactly when its kind has no rule or more than one (the
rule diagnostic), or its rule allocates by the settlement ratio and that step rejects with it. -/
theorem processBasisEvent_rejected_iff (policy : AccountingBasisPolicy)
    (snapshot : AccountingReadSnapshot) (event : BasisSourceEvent) (count : Nat)
    (totals : BasisTotals) (d : SemanticDiagnostic) :
    processBasisEvent policy snapshot event count totals = .ok (.rejected d) ↔
      ((basisRulesFor policy event).length ≠ 1 ∧ d = basisRuleDiagnostic) ∨
      ∃ rule, basisRulesFor policy event = [rule] ∧
        rule.treatment = .allocateBySettlementRatio ∧
        settlementRatioOf policy snapshot event = .ok (.rejected d) := by
  unfold basisRulesFor
  constructor
  · intro h
    unfold processBasisEvent at h
    split at h
    · rename_i rule hrule
      split at h
      · cases h
      · rename_i diagnostic hd
        cases h
        right
        refine ⟨rule, hrule, ?_⟩
        split at hd
        · rename_i htr
          exact ⟨by simpa using htr, hd⟩
        · cases hd
      · split at h
        · cases h
        · cases h
    · rename_i hother
      cases h
      left
      refine ⟨?_, rfl⟩
      intro hlen
      obtain ⟨rule, hl⟩ := List.length_eq_one_iff.mp hlen
      exact hother rule hl
  · rintro (⟨hlen, rfl⟩ | ⟨rule, hrule, htr, hs⟩)
    · unfold processBasisEvent
      split
      · rename_i rule hrule
        rw [hrule] at hlen
        exact absurd rfl hlen
      · rfl
    · unfold processBasisEvent
      rw [hrule]
      simp only [htr, beq_self_eq_true, ite_true, hs]
/-! ## What the loop does -/

/-- The loop rejects exactly at the first event the step rejects, after the events before it have
all been taken: some split of the events has a first part the loop completes and a next event the
step rejects, at the entry count and totals the first part leaves. -/
theorem basisLoop_rejects_iff (policy : AccountingBasisPolicy) (snapshot : AccountingReadSnapshot)
    (d : SemanticDiagnostic) :
    ∀ (events : List BasisSourceEvent) (count : Nat) (totals : BasisTotals),
      basisLoop policy snapshot count totals events = .ok (.rejected d) ↔
        ∃ pre event suf entries totals', events = pre ++ event :: suf ∧
          basisLoop policy snapshot count totals pre = .ok (.done entries totals') ∧
          processBasisEvent policy snapshot event (count + pre.length) totals' =
            .ok (.rejected d)
  | [], count, totals => by simp [basisLoop]
  | event :: rest, count, totals => by
    have ih := basisLoop_rejects_iff policy snapshot d rest
    constructor
    · intro h
      unfold basisLoop at h
      split at h
      · cases h
      · rename_i diagnostic hp
        cases h
        exact ⟨[], event, rest, [], totals, rfl, by simp [basisLoop], by simpa using hp⟩
      · rename_i entry totals' hp
        split at h
        · cases h
        · rename_i diagnostic hl
          cases h
          obtain ⟨pre, e, suf, es, t, hsplit, hdone, hrej⟩ := (ih (count + 1) totals').mp hl
          refine ⟨event :: pre, e, suf, entry :: es, t, by simp [hsplit], ?_, ?_⟩
          · simp only [basisLoop, hp, hdone]
          · simpa [Nat.add_assoc, Nat.add_comm 1] using hrej
        · cases h
    · rintro ⟨pre, e, suf, es, t, hsplit, hdone, hrej⟩
      cases pre with
      | nil =>
        simp only [List.nil_append, List.cons.injEq] at hsplit
        obtain ⟨rfl, -⟩ := hsplit
        simp only [basisLoop, Except.ok.injEq, BasisLoopOutcome.done.injEq] at hdone
        obtain ⟨-, rfl⟩ := hdone
        simp only [List.length_nil, Nat.add_zero] at hrej
        unfold basisLoop
        rw [hrej]
      | cons first pre' =>
        simp only [List.cons_append, List.cons.injEq] at hsplit
        obtain ⟨rfl, hrest⟩ := hsplit
        unfold basisLoop at hdone
        split at hdone
        · cases hdone
        · cases hdone
        · rename_i entry totals' hp
          split at hdone
          · cases hdone
          · cases hdone
          · rename_i es' final hl
            simp only [Except.ok.injEq, BasisLoopOutcome.done.injEq] at hdone
            obtain ⟨-, rfl⟩ := hdone
            have hrej' : processBasisEvent policy snapshot e (count + 1 + pre'.length) final =
                .ok (.rejected d) := by
              have : count + (event :: pre').length = count + 1 + pre'.length := by
                simp only [List.length_cons]
                omega
              rwa [this] at hrej
            have hl' := (ih (count + 1) totals').mpr ⟨pre', e, suf, es', final, hrest, hl, hrej'⟩
            unfold basisLoop
            rw [hp]
            simp only
            rw [hl']

end Rastrata.Kernel

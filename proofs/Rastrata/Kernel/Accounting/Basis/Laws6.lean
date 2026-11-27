/-
The reconciliation of the basis projection: the totals are exact, and the reconciliation diagnostic
(`accounting.ts` line 1490) is never given.
-/
import Rastrata.Kernel.Accounting.Basis.Laws5

namespace Rastrata.Kernel

/-! ## What the entries say about the totals -/

/-- The posting amounts of the events are the included plus the excluded amounts of their entries:
an entry excludes exactly what it does not include. -/
theorem basisEntriesMean_amount {policy : AccountingBasisPolicy}
    {snapshot : AccountingReadSnapshot} :
    ∀ {count : Nat} {events : List BasisSourceEvent}
      {entries : List AccountingBasisProjectionEntry},
      BasisEntriesMean policy snapshot count events entries →
        (events.map fun event => event.sourcePosting.bookValue.amount.toRat).sum =
          (entries.map fun entry => entry.includedExactAmount.toRat).sum +
            (entries.map fun entry => entry.excludedExactAmount.toRat).sum
  | _, [], [], _ => by simp
  | _, [], _ :: _, h => by simp [BasisEntriesMean] at h
  | _, _ :: _, [], h => by simp [BasisEntriesMean] at h
  | count, event :: events, entry :: entries, h => by
    obtain ⟨⟨rule, -, hmeans, -⟩, hrest⟩ := h
    have ih := basisEntriesMean_amount hrest
    simp only [List.map_cons, List.sum_cons]
    rw [ih, hmeans.excluded]
    ring

/-- The booked and residual totals add up to the included total, entry by entry: an excluded entry
has nothing included and nothing recognized, and any other holds an amount and a residual that add
up to what it includes. -/
theorem basisEntriesMean_recognized {policy : AccountingBasisPolicy}
    {snapshot : AccountingReadSnapshot} :
    ∀ {count : Nat} {events : List BasisSourceEvent}
      {entries : List AccountingBasisProjectionEntry},
      BasisEntriesMean policy snapshot count events entries →
        (entries.map fun entry => recognizedAmountValue entry.recognizedAmount).sum +
          (entries.map fun entry => recognizedResidualValue entry.recognizedAmount).sum =
            (entries.map fun entry => entry.includedExactAmount.toRat).sum
  | _, [], [], _ => by simp
  | _, [], _ :: _, h => by simp [BasisEntriesMean] at h
  | _, _ :: _, [], h => by simp [BasisEntriesMean] at h
  | count, event :: events, entry :: entries, h => by
    obtain ⟨⟨rule, -, hmeans, -⟩, hrest⟩ := h
    have ih := basisEntriesMean_recognized hrest
    simp only [List.map_cons, List.sum_cons]
    have hone : recognizedAmountValue entry.recognizedAmount +
        recognizedResidualValue entry.recognizedAmount = entry.includedExactAmount.toRat := by
      by_cases hx : rule.treatment = .exclude
      · have hnone := hmeans.recognizedNone hx
        rw [hmeans.included, hx]
        simp [hnone, recognizedAmountValue, recognizedResidualValue, basisIncluded]
      · obtain ⟨value, hv, -, hsum, -⟩ := hmeans.recognizedSome hx
        simp only [hv, recognizedAmountValue, recognizedResidualValue]
        exact hsum
    linarith

/-! ## The reconciliation -/

/-- The totals reconcile as meanings: the source total is the included plus the excluded total,
and the booked plus the residual total is the included total. -/
structure BasisTotals.Reconciles (totals : BasisTotals) : Prop where
  source : totals.sourceExactTotal.toRat =
    totals.includedExactTotal.toRat + totals.excludedExactTotal.toRat
  booked : totals.projectedBookValueTotal.toRat + totals.quantizationResidualTotal.toRat =
    totals.includedExactTotal.toRat

/-- A loop that completes from the empty totals leaves totals that reconcile exactly. -/
theorem BasisLoopMeans.reconciles {policy : AccountingBasisPolicy}
    {snapshot : AccountingReadSnapshot} {events : List BasisSourceEvent}
    {entries : List AccountingBasisProjectionEntry} {final : BasisTotals}
    (h : BasisLoopMeans policy snapshot events 0 BasisTotals.empty entries final) :
    final.Reconciles := by
  refine ⟨?_, ?_⟩
  · rw [h.source, h.included, h.excluded, basisEntriesMean_amount h.means]
    simp [BasisTotals.empty, ExactRational.zero_toRat]
  · rw [h.booked, h.residual, h.included]
    simp only [BasisTotals.empty, ExactRational.zero_toRat, zero_add]
    exact basisEntriesMean_recognized h.means

/-- The test of line 1490 never holds for constructible totals that reconcile: the diagnostic of
the reconciliation is never given. (It can throw, below.) -/
theorem reconciliationFails_ne_true {totals : BasisTotals} (hw : totals.WF)
    (hr : totals.Reconciles) : reconciliationFails totals ≠ .ok true := by
  unfold reconciliationFails
  split
  · intro h
    cases h
  · rename_i sum hsum
    obtain ⟨hsw, hsr⟩ := ExactRational.add_ok hw.included hw.excluded (liftExact_eq_ok' hsum)
    have h1 : totals.sourceExactTotal.equals sum = true :=
      (ExactRational.equals_iff hw.source hsw).mpr (by rw [hsr, hr.source])
    have h2 : totals.projectedExactTotal.equals totals.includedExactTotal = true :=
      (ExactRational.equals_iff hw.included hw.included).mpr rfl
    simp only [h1, h2, Bool.not_true, Bool.false_eq_true, ite_false]
    split
    · intro h
      cases h
    · rename_i booked hbooked
      obtain ⟨hbw, hbr⟩ :=
        ExactRational.add_ok hw.projectedBookValue hw.residual (liftExact_eq_ok' hbooked)
      have h3 : booked.equals totals.projectedExactTotal = true :=
        (ExactRational.equals_iff hbw hw.included).mpr (by rw [hbr, hr.booked])
      simp [h3]

end Rastrata.Kernel

/-
What the loop over the events computes: the entry of each event and the totals, as meanings.
-/
import Rastrata.Kernel.Accounting.Basis.Laws4

namespace Rastrata.Kernel

/-! ## The totals -/

/-- Constructible totals: each of the five is a constructible exact number. -/
structure BasisTotals.WF (totals : BasisTotals) : Prop where
  source : totals.sourceExactTotal.WF
  included : totals.includedExactTotal.WF
  excluded : totals.excludedExactTotal.WF
  projectedBookValue : totals.projectedBookValueTotal.WF
  residual : totals.quantizationResidualTotal.WF

/-- The totals before the first event are constructible. -/
theorem BasisTotals.empty_wf : BasisTotals.empty.WF :=
  ⟨ExactRational.zero_wf, ExactRational.zero_wf, ExactRational.zero_wf, ExactRational.zero_wf,
    ExactRational.zero_wf⟩

/-- The value a recognized amount adds to the booked total: its amount, or nothing when there is
none. -/
def recognizedAmountValue (recognized : Option QuantizedValue) : ℚ :=
  match recognized with
  | none => 0
  | some value => value.amount.toRat

/-- The value a recognized amount adds to the residual total: its residual, or nothing. -/
def recognizedResidualValue (recognized : Option QuantizedValue) : ℚ :=
  match recognized with
  | none => 0
  | some value => value.residual.toRat

/-- A lifted result that is `ok` is the result itself. -/
theorem liftExact_eq_ok' {α : Type} {result : Except NumErr α} {value : α}
    (h : liftExact result = .ok value) : result = .ok value := by
  cases result with
  | error code => cases h
  | ok v => cases h; rfl

/-- Adding to the totals adds the meanings: the source total takes the amount, the included and
excluded totals take the included and excluded amounts, and the booked and residual totals take the
recognized amount and its residual; and every total stays constructible. -/
theorem addBasisTotals_spec {totals totals' : BasisTotals} {amount included excluded : ExactRational}
    {recognized : Option QuantizedValue} (ht : totals.WF) (ha : amount.WF) (hi : included.WF)
    (he : excluded.WF) (hq : ∀ value, recognized = some value → value.WF)
    (h : addBasisTotals totals amount included excluded recognized = .ok totals') :
    totals'.WF ∧
      totals'.sourceExactTotal.toRat = totals.sourceExactTotal.toRat + amount.toRat ∧
      totals'.includedExactTotal.toRat = totals.includedExactTotal.toRat + included.toRat ∧
      totals'.excludedExactTotal.toRat = totals.excludedExactTotal.toRat + excluded.toRat ∧
      totals'.projectedBookValueTotal.toRat =
        totals.projectedBookValueTotal.toRat + recognizedAmountValue recognized ∧
      totals'.quantizationResidualTotal.toRat =
        totals.quantizationResidualTotal.toRat + recognizedResidualValue recognized := by
  cases recognized with
  | none =>
    unfold addBasisTotals at h
    split at h
    · cases h
    · rename_i source hs
      obtain ⟨hsw, hsr⟩ := ExactRational.add_ok ht.source ha (liftExact_eq_ok' hs)
      split at h
      · cases h
      · rename_i includedTotal hi'
        obtain ⟨hiw, hir⟩ := ExactRational.add_ok ht.included hi (liftExact_eq_ok' hi')
        split at h
        · cases h
        · rename_i excludedTotal he'
          obtain ⟨hew, her⟩ := ExactRational.add_ok ht.excluded he (liftExact_eq_ok' he')
          cases h
          exact ⟨⟨hsw, hiw, hew, ht.projectedBookValue, ht.residual⟩, hsr, hir, her,
            by simp [recognizedAmountValue], by simp [recognizedResidualValue]⟩
  | some value =>
    have hvq := hq value rfl
    unfold addBasisTotals at h
    split at h
    · cases h
    · rename_i source hs
      obtain ⟨hsw, hsr⟩ := ExactRational.add_ok ht.source ha (liftExact_eq_ok' hs)
      split at h
      · cases h
      · rename_i includedTotal hi'
        obtain ⟨hiw, hir⟩ := ExactRational.add_ok ht.included hi (liftExact_eq_ok' hi')
        split at h
        · cases h
        · rename_i excludedTotal he'
          obtain ⟨hew, her⟩ := ExactRational.add_ok ht.excluded he (liftExact_eq_ok' he')
          dsimp only at h
          split at h
          · cases h
          · rename_i valueAmount hva
            obtain ⟨hvaw, hvar⟩ := ExactDecimal.toRational_ok hvq.amount (liftExact_eq_ok' hva)
            split at h
            · cases h
            · rename_i bookedTotal hb
              obtain ⟨hbw, hbr⟩ :=
                ExactRational.add_ok ht.projectedBookValue hvaw (liftExact_eq_ok' hb)
              split at h
              · cases h
              · rename_i residualTotal hr
                obtain ⟨hrw, hrr⟩ :=
                  ExactRational.add_ok ht.residual hvq.residual (liftExact_eq_ok' hr)
                cases h
                exact ⟨⟨hsw, hiw, hew, hbw, hrw⟩, hsr, hir, her,
                  by simp [recognizedAmountValue, hbr, hvar],
                  by simp [recognizedResidualValue, hrr]⟩

/-! ## One entry -/

/-- What an entry includes, as a meaning (line 1475): nothing for `exclude`, the amount times the
settlement ratio for `allocateBySettlementRatio`, and the whole amount for the other treatments. -/
def basisIncluded (treatment : AccountingBasisTreatment) (amount ratio : ℚ) : ℚ :=
  match treatment with
  | .exclude => 0
  | .allocateBySettlementRatio => amount * ratio
  | _ => amount

/-- `includedExactAmountOf` gives a constructible number that means `basisIncluded`. -/
theorem includedExactAmountOf_spec {treatment : AccountingBasisTreatment}
    {ratio amount included : ExactRational} (hr : ratio.WF) (ha : amount.WF)
    (h : includedExactAmountOf treatment ratio amount = .ok included) :
    included.WF ∧ included.toRat = basisIncluded treatment amount.toRat ratio.toRat := by
  unfold includedExactAmountOf at h
  cases treatment with
  | exclude =>
    cases h
    exact ⟨ExactRational.zero_wf, ExactRational.zero_toRat⟩
  | allocateBySettlementRatio =>
    obtain ⟨hw, hv⟩ := ExactRational.multiply_ok ha hr (liftExact_eq_ok' h)
    exact ⟨hw, hv⟩
  | recognizeAtAccountingDate => cases h; exact ⟨ha, rfl⟩
  | recognizeAtSettlement => cases h; exact ⟨ha, rfl⟩
  | carryThrough => cases h; exact ⟨ha, rfl⟩

/-- `recognizedAmountOf` gives nothing for `exclude`, and otherwise the quantization of the included
amount in the policy's rule. -/
theorem recognizedAmountOf_spec {policy : AccountingBasisPolicy}
    {treatment : AccountingBasisTreatment} {included : ExactRational}
    {recognized : Option QuantizedValue}
    (h : recognizedAmountOf policy treatment included = .ok recognized) :
    (treatment = .exclude → recognized = none) ∧
      (treatment ≠ .exclude → ∃ value, recognized = some value ∧
        quantize included policy.quantizationPolicy.rule = .ok value) := by
  cases treatment <;> simp only [recognizedAmountOf] at h <;>
  first
  | (cases h; exact ⟨fun _ => rfl, fun hne => absurd rfl hne⟩)
  | (rcases hq : quantize included policy.quantizationPolicy.rule with e | value
     · simp [hq] at h
     · simp only [hq, Except.ok.injEq] at h
       subst h
       exact ⟨fun hc => (by cases hc), fun _ => ⟨value, rfl, rfl⟩⟩)

/-- What one entry means (lines 1474 to 1485): its ordinal is one more than the entries before it; its
source is the event; its included amount is `basisIncluded` of the posting's amount and the
settlement ratio; its excluded amount is the rest; the deprecated `amount` is the included amount;
it holds a recognized amount unless the treatment is `exclude`, which is the included amount rounded
in the policy's rule (the two parts add up to the included amount exactly, the amount is at the
rule's scale and less than a unit from the included amount); and its allocation identifiers are the
event's, sorted. -/
structure BasisEntryMeans (policy : AccountingBasisPolicy) (event : BasisSourceEvent)
    (treatment : AccountingBasisTreatment) (ratio : ℚ) (count : Nat)
    (entry : AccountingBasisProjectionEntry) : Prop where
  ordinal : entry.ordinal = ((count + 1 : Nat) : Int)
  sourceId : entry.sourceId = event.id
  treatmentEq : entry.treatment = treatment
  includedWF : entry.includedExactAmount.WF
  excludedWF : entry.excludedExactAmount.WF
  included : entry.includedExactAmount.toRat =
    basisIncluded treatment event.sourcePosting.bookValue.amount.toRat ratio
  excluded : entry.excludedExactAmount.toRat =
    event.sourcePosting.bookValue.amount.toRat - entry.includedExactAmount.toRat
  amount : entry.amount = entry.includedExactAmount
  recognizedNone : treatment = .exclude → entry.recognizedAmount = none
  recognizedSome : treatment ≠ .exclude → ∃ value, entry.recognizedAmount = some value ∧
    value.WF ∧ value.amount.toRat + value.residual.toRat = entry.includedExactAmount.toRat ∧
    value.amount.scale = policy.quantizationPolicy.targetScale ∧
    |value.amount.toRat - entry.includedExactAmount.toRat| < policy.quantizationPolicy.rule.unit
  settlementAllocationIds : entry.settlementAllocationIds =
    sortIdentifiers (event.settlementAllocationIds.getD [])

/-- What one step does to the totals: each takes what the entry carries. -/
structure BasisStepMeans (totals totals' : BasisTotals) (entry : AccountingBasisProjectionEntry)
    (amount : ℚ) : Prop where
  wf : totals'.WF
  source : totals'.sourceExactTotal.toRat = totals.sourceExactTotal.toRat + amount
  included : totals'.includedExactTotal.toRat =
    totals.includedExactTotal.toRat + entry.includedExactAmount.toRat
  excluded : totals'.excludedExactTotal.toRat =
    totals.excludedExactTotal.toRat + entry.excludedExactAmount.toRat
  booked : totals'.projectedBookValueTotal.toRat =
    totals.projectedBookValueTotal.toRat + recognizedAmountValue entry.recognizedAmount
  residual : totals'.quantizationResidualTotal.toRat =
    totals.quantizationResidualTotal.toRat + recognizedResidualValue entry.recognizedAmount

/-- One entry and the new totals mean what `BasisEntryMeans` and `BasisStepMeans` say, for an event
whose posting amount is constructible, a constructible settlement ratio and constructible totals. -/
theorem basisEntryOf_spec {policy : AccountingBasisPolicy} {event : BasisSourceEvent}
    {treatment : AccountingBasisTreatment} {ratio : ExactRational} {count : Nat}
    {totals totals' : BasisTotals} {entry : AccountingBasisProjectionEntry}
    (hev : event.sourcePosting.bookValue.amount.WF) (hr : ratio.WF) (ht : totals.WF)
    (h : basisEntryOf policy event treatment ratio count totals = .ok (entry, totals')) :
    BasisEntryMeans policy event treatment ratio.toRat count entry ∧
      BasisStepMeans totals totals' entry event.sourcePosting.bookValue.amount.toRat := by
  unfold basisEntryOf at h
  split at h
  · cases h
  · rename_i amount hamount
    obtain ⟨haw, hav⟩ := ExactDecimal.toRational_ok hev (liftExact_eq_ok' hamount)
    split at h
    · cases h
    · rename_i included hincl
      obtain ⟨hiw, hiv⟩ := includedExactAmountOf_spec hr haw hincl
      split at h
      · cases h
      · rename_i excluded hexcl
        obtain ⟨hew, hev'⟩ := ExactRational.subtract_ok haw hiw (liftExact_eq_ok' hexcl)
        split at h
        · cases h
        · rename_i recognized hrec
          obtain ⟨hnone, hsome⟩ := recognizedAmountOf_spec hrec
          have hrecWF : ∀ value, recognized = some value → value.WF := by
            intro value hv
            by_cases hx : treatment = .exclude
            · rw [hnone hx] at hv; cases hv
            · obtain ⟨v, hv', hq⟩ := hsome hx
              rw [hv'] at hv
              cases hv
              obtain ⟨hwa, hwr, -⟩ := quantize_ok hiw hq
              exact ⟨hwa, hwr⟩
          split at h
          · cases h
          · rename_i totalsNew hadd
            cases h
            obtain ⟨hwf, hs, hi, he, hb, hres⟩ :=
              addBasisTotals_spec ht haw hiw hew hrecWF hadd
            refine ⟨⟨rfl, rfl, rfl, hiw, hew, ?_, ?_, rfl, hnone, ?_, rfl⟩,
              ⟨hwf, ?_, hi, he, hb, hres⟩⟩
            · rw [hiv, hav]
            · rw [hev', hav]
            · intro hx
              obtain ⟨v, hv', hq⟩ := hsome hx
              obtain ⟨hwa, hwr, hsc, -⟩ := quantize_ok hiw hq
              refine ⟨v, hv', ⟨hwa, hwr⟩, quantize_amount_add_residual hiw hq, hsc, ?_⟩
              exact quantize_within_one_unit hiw hq
            · rw [hs, hav]

/-! ## The settlement ratio -/

/-- `ExactRational.of(1n, 1n)` never throws, and is `basisOne`. -/
theorem of_one_one : ExactRational.of 1 1 = .ok basisOne :=
  ExactRational.of_eq_reduced (by decide) (by decide) withinMagnitude_one withinMagnitude_one

/-- `basisOne` is constructible. -/
theorem basisOne_wf : basisOne.WF :=
  (ExactRational.of_ok of_one_one).1

/-- `basisOne` means one. -/
theorem basisOne_toRat : basisOne.toRat = 1 := by
  simp [basisOne, ExactRational.toRat]

/-- Adding a list of constructible numbers to a constructible total adds their meanings. -/
theorem addExactValues_spec :
    ∀ (values : List ExactRational) {total total' : ExactRational}, total.WF →
      (∀ value ∈ values, value.WF) → addExactValues total values = .ok total' →
        total'.WF ∧ total'.toRat = total.toRat + (values.map ExactRational.toRat).sum
  | [], total, total', ht, _, h => by
    simp only [addExactValues, Except.ok.injEq] at h
    subst h
    simp [ht]
  | value :: rest, total, total', ht, hv, h => by
    simp only [addExactValues] at h
    split at h
    · cases h
    · rename_i next hnext
      obtain ⟨hw, hr⟩ := ExactRational.add_ok ht (hv value (by simp)) hnext
      obtain ⟨hw', hr'⟩ := addExactValues_spec rest hw (fun x hx => hv x (by simp [hx])) h
      refine ⟨hw', ?_⟩
      rw [hr', hr]
      simp only [List.map_cons, List.sum_cons]
      ring

/-- An open item the event finds is one of the state's. -/
theorem basisOpenItem_mem {snapshot : AccountingReadSnapshot} {event : BasisSourceEvent}
    {item : OpenItem} (h : basisOpenItem snapshot event = some item) :
    item ∈ snapshot.accountingState.openItems := by
  unfold basisOpenItem at h
  cases hid : event.openItemId with
  | none => simp [hid] at h
  | some id =>
    simp only [hid, Option.bind_some] at h
    exact List.mem_of_find?_eq_some h

/-- An allocation of an event is one of the state's. -/
theorem basisAllocations_mem {snapshot : AccountingReadSnapshot} {event : BasisSourceEvent}
    {allocation : SettlementAllocation} (h : allocation ∈ basisAllocations snapshot event) :
    allocation ∈ snapshot.accountingState.settlementAllocations := by
  unfold basisAllocations at h
  cases hid : event.openItemId with
  | none => simp [hid] at h
  | some id =>
    simp only [hid] at h
    exact (List.mem_filter.mp h).1

/-- The settlement ratio of an event as a meaning (line 1471): the book values of its allocations
(`allocatedOpenItemBookValue ?? allocatedBookValue`) added up, over the absolute book value of its
open item. -/
def basisRatioMeaning (snapshot : AccountingReadSnapshot) (event : BasisSourceEvent)
    (item : OpenItem) : ℚ :=
  ((ratioValues snapshot event).map ExactRational.toRat).sum / |item.bookValue.toRat|

/-- The ratio step gives the ratio the open item and the allocations mean, between zero and one,
for an open item of the policy's book whose book value is not zero, over a constructible state. -/
theorem settlementRatioOf_ratio_spec {policy : AccountingBasisPolicy}
    {snapshot : AccountingReadSnapshot} {event : BasisSourceEvent} {ratio : ExactRational}
    (hS : snapshot.accountingState.WF)
    (h : settlementRatioOf policy snapshot event = .ok (.ratio ratio)) :
    ∃ item, basisOpenItem snapshot event = some item ∧
      settlementGraphFails policy snapshot event = false ∧ item.bookId = policy.bookId ∧
      0 < |item.bookValue.toRat| ∧ ratio.WF ∧
      ratio.toRat = basisRatioMeaning snapshot event item ∧ 0 ≤ ratio.toRat ∧ ratio.toRat ≤ 1 := by
  unfold settlementRatioOf at h
  dsimp only at h
  generalize hO : basisOpenItem snapshot event = openItem at h
  cases openItem with
  | none => simp at h
  | some item =>
    simp only at h
    split at h
    · cases h
    · rename_i hc
      split at h
      · cases h
      · rename_i total hs
        split at h
        · cases h
        · rename_i r hd
          split at h
          · cases h
          · rename_i hrange
            cases h
            have hitem : item.WF := hS.openItems item (basisOpenItem_mem hO)
            have hvalues : ∀ value ∈ ratioValues snapshot event, value.WF := by
              intro value hv
              unfold ratioValues at hv
              obtain ⟨allocation, hmem, rfl⟩ := List.mem_map.mp hv
              have hw : allocation.WF := hS.settlementAllocations allocation
                (basisAllocations_mem hmem)
              cases hopt : allocation.allocatedOpenItemBookValue with
              | none => exact hw.allocatedBookValue
              | some value => exact hw.allocatedOpenItemBookValue value hopt
            obtain ⟨htw, htr⟩ := addExactValues_spec _ ExactRational.zero_wf hvalues
              (liftExact_eq_ok' hs)
            have habs := ExactRational.abs_wf (hitem : OpenItemBody.WF _).bookValue
            obtain ⟨hrw, -, hrv⟩ := ExactRational.divide_ok htw habs (liftExact_eq_ok' hd)
            have hc' : item.bookId = policy.bookId ∧ positive item.bookValue.abs = true := by
              simp only [Bool.not_eq_true, Bool.or_eq_false_iff, bne_eq_false_iff_eq,
                Bool.not_eq_false'] at hc
              exact ⟨hc.1.1.1, hc.1.1.2⟩
            have hpos : 0 < |item.bookValue.toRat| := by
              have := (ExactRational.compare_gt_iff habs ExactRational.zero_wf).mp
                (by simpa [positive] using hc'.2)
              rwa [ExactRational.abs_toRat (hitem : OpenItemBody.WF _).bookValue,
                ExactRational.zero_toRat] at this
            have hfalse : settlementGraphFails policy snapshot event = false := by
              unfold settlementGraphFails
              rw [hO]
              simpa using hc
            refine ⟨item, rfl, hfalse, hc'.1, hpos, hrw, ?_, ?_, ?_⟩
            · rw [hrv, htr, ExactRational.abs_toRat (hitem : OpenItemBody.WF _).bookValue]
              simp [basisRatioMeaning, ExactRational.zero_toRat]
            · have : ¬ ratio.compare ExactRational.zero = .lt := by
                intro hlt
                exact hrange (by simp [hlt])
              rw [ExactRational.compare_lt_iff hrw ExactRational.zero_wf,
                ExactRational.zero_toRat] at this
              exact not_lt.mp this
            · have : ¬ ratio.compare basisOne = .gt := by
                intro hgt
                exact hrange (by simp [hgt])
              rw [ExactRational.compare_gt_iff hrw basisOne_wf, basisOne_toRat] at this
              exact not_lt.mp this

/-! ## One event -/

/-- The settlement ratio of an event as a meaning: that of its open item, or zero when it has none. -/
def basisEventRatio (snapshot : AccountingReadSnapshot) (event : BasisSourceEvent) : ℚ :=
  match basisOpenItem snapshot event with
  | none => 0
  | some item => basisRatioMeaning snapshot event item

/-- The ratio does not matter to a treatment that does not allocate by it. -/
theorem basisIncluded_ratio {treatment : AccountingBasisTreatment} (amount ratio ratio' : ℚ)
    (h : treatment ≠ .allocateBySettlementRatio) :
    basisIncluded treatment amount ratio = basisIncluded treatment amount ratio' := by
  cases treatment <;> simp_all [basisIncluded]

/-- What an event's step produces when it makes an entry: its single rule, the entry and the totals
of `BasisEntryMeans` and `BasisStepMeans` with the event's settlement ratio, and, for a rule that
allocates by the ratio, a graph that closes and a ratio from zero to one. -/
theorem processBasisEvent_spec {policy : AccountingBasisPolicy}
    {snapshot : AccountingReadSnapshot} {event : BasisSourceEvent} {count : Nat}
    {totals totals' : BasisTotals} {entry : AccountingBasisProjectionEntry}
    (hS : snapshot.accountingState.WF) (hev : event.sourcePosting.bookValue.amount.WF)
    (ht : totals.WF)
    (h : processBasisEvent policy snapshot event count totals = .ok (.entry entry totals')) :
    ∃ rule, basisRulesFor policy event = [rule] ∧
      BasisEntryMeans policy event rule.treatment (basisEventRatio snapshot event) count entry ∧
      BasisStepMeans totals totals' entry event.sourcePosting.bookValue.amount.toRat ∧
      (rule.treatment = .allocateBySettlementRatio →
        settlementGraphFails policy snapshot event = false ∧
          0 ≤ basisEventRatio snapshot event ∧ basisEventRatio snapshot event ≤ 1) := by
  unfold processBasisEvent at h
  split at h
  · rename_i rule hrule
    refine ⟨rule, hrule, ?_⟩
    split at h
    · cases h
    · cases h
    · rename_i ratio hratio
      split at h
      · cases h
      · rename_i pair hentry
        cases h
        by_cases hx : (rule.treatment == .allocateBySettlementRatio) = true
        · have hx' : rule.treatment = .allocateBySettlementRatio := by simpa using hx
          simp only [hx, ite_true] at hratio
          obtain ⟨item, hO, hfalse, -, -, hrw, hrv, h0, h1⟩ :=
            settlementRatioOf_ratio_spec hS hratio
          obtain ⟨hmeans, hstep⟩ := basisEntryOf_spec hev hrw ht hentry
          have hbe : basisEventRatio snapshot event = ratio.toRat := by
            unfold basisEventRatio
            rw [hO, hrv]
          rw [hbe]
          exact ⟨hmeans, hstep, fun _ => ⟨hfalse, h0, h1⟩⟩
        · have hx' : ¬ rule.treatment = .allocateBySettlementRatio := by simpa using hx
          simp only [hx, Bool.false_eq_true, ite_false, Except.ok.injEq,
            SettlementRatioOutcome.ratio.injEq] at hratio
          subst hratio
          obtain ⟨hmeans, hstep⟩ := basisEntryOf_spec hev ExactRational.zero_wf ht hentry
          refine ⟨⟨hmeans.ordinal, hmeans.sourceId, hmeans.treatmentEq, hmeans.includedWF,
            hmeans.excludedWF, ?_, hmeans.excluded, hmeans.amount, hmeans.recognizedNone,
            hmeans.recognizedSome, hmeans.settlementAllocationIds⟩, hstep, fun hc => absurd hc hx'⟩
          rw [hmeans.included]
          exact basisIncluded_ratio _ _ _ hx'
  · cases h

/-! ## The loop -/

/-- The entries mean their events, from the position `count`: one entry for each event, in order,
the entry of the event at position `count + i` having ordinal `count + i + 1`, and each as
`processBasisEvent_spec` says. -/
def BasisEntriesMean (policy : AccountingBasisPolicy) (snapshot : AccountingReadSnapshot) :
    Nat → List BasisSourceEvent → List AccountingBasisProjectionEntry → Prop
  | _, [], [] => True
  | count, event :: events, entry :: entries =>
    (∃ rule, basisRulesFor policy event = [rule] ∧
      BasisEntryMeans policy event rule.treatment (basisEventRatio snapshot event) count entry ∧
      (rule.treatment = .allocateBySettlementRatio →
        settlementGraphFails policy snapshot event = false ∧
          0 ≤ basisEventRatio snapshot event ∧ basisEventRatio snapshot event ≤ 1)) ∧
      BasisEntriesMean policy snapshot (count + 1) events entries
  | _, _, _ => False

/-- What the loop over the events computes: constructible totals; one entry for each event, in order;
and each total is the starting total plus the sum, over the events or over their entries, of what
the entry says (the source total takes the posting amounts, the included and excluded totals the
included and excluded amounts, the booked and residual totals the recognized amounts and their
residuals). -/
structure BasisLoopMeans (policy : AccountingBasisPolicy) (snapshot : AccountingReadSnapshot)
    (events : List BasisSourceEvent) (count : Nat) (totals : BasisTotals)
    (entries : List AccountingBasisProjectionEntry) (final : BasisTotals) : Prop where
  wf : final.WF
  means : BasisEntriesMean policy snapshot count events entries
  source : final.sourceExactTotal.toRat = totals.sourceExactTotal.toRat +
    (events.map fun event => event.sourcePosting.bookValue.amount.toRat).sum
  included : final.includedExactTotal.toRat = totals.includedExactTotal.toRat +
    (entries.map fun entry => entry.includedExactAmount.toRat).sum
  excluded : final.excludedExactTotal.toRat = totals.excludedExactTotal.toRat +
    (entries.map fun entry => entry.excludedExactAmount.toRat).sum
  booked : final.projectedBookValueTotal.toRat = totals.projectedBookValueTotal.toRat +
    (entries.map fun entry => recognizedAmountValue entry.recognizedAmount).sum
  residual : final.quantizationResidualTotal.toRat = totals.quantizationResidualTotal.toRat +
    (entries.map fun entry => recognizedResidualValue entry.recognizedAmount).sum

/-- The loop, when it completes, computes `BasisLoopMeans`, over a constructible state, events with
constructible posting amounts and constructible starting totals. -/
theorem basisLoop_done_spec {policy : AccountingBasisPolicy} {snapshot : AccountingReadSnapshot}
    (hS : snapshot.accountingState.WF) :
    ∀ (events : List BasisSourceEvent) (count : Nat) (totals final : BasisTotals)
      (entries : List AccountingBasisProjectionEntry),
      (∀ event ∈ events, event.sourcePosting.bookValue.amount.WF) → totals.WF →
      basisLoop policy snapshot count totals events = .ok (.done entries final) →
      BasisLoopMeans policy snapshot events count totals entries final
  | [], count, totals, final, entries, _, ht, h => by
    simp only [basisLoop, Except.ok.injEq, BasisLoopOutcome.done.injEq] at h
    obtain ⟨rfl, rfl⟩ := h
    exact ⟨ht, trivial, by simp, by simp, by simp, by simp, by simp⟩
  | event :: rest, count, totals, final, entries, hev, ht, h => by
    unfold basisLoop at h
    split at h
    · cases h
    · cases h
    · rename_i entry totals' hp
      split at h
      · cases h
      · cases h
      · rename_i es final' hl
        simp only [Except.ok.injEq, BasisLoopOutcome.done.injEq] at h
        obtain ⟨rfl, rfl⟩ := h
        obtain ⟨rule, hrule, hmeans, hstep, hgraph⟩ :=
          processBasisEvent_spec hS (hev event (by simp)) ht hp
        have ih := basisLoop_done_spec hS rest (count + 1) totals' final' es
          (fun e he => hev e (by simp [he])) hstep.wf hl
        refine ⟨ih.wf, ⟨⟨rule, hrule, hmeans, hgraph⟩, ih.means⟩, ?_, ?_, ?_, ?_, ?_⟩
        · rw [ih.source, hstep.source]
          simp only [List.map_cons, List.sum_cons]
          ring
        · rw [ih.included, hstep.included]
          simp only [List.map_cons, List.sum_cons]
          ring
        · rw [ih.excluded, hstep.excluded]
          simp only [List.map_cons, List.sum_cons]
          ring
        · rw [ih.booked, hstep.booked]
          simp only [List.map_cons, List.sum_cons]
          ring
        · rw [ih.residual, hstep.residual]
          simp only [List.map_cons, List.sum_cons]
          ring

end Rastrata.Kernel

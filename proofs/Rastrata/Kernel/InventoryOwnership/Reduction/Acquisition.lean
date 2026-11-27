/-
The laws of `prepareInventoryPostedAcquisitionGroup` (`inventory-ownership.ts` line 358): a
prepared group's first anchors take exactly what its posting posts. The budgets are cumulative
shares of the posted amount over the entries in holding order, by carrying amount (by quantity when
the group carries nothing); successive shares meet (`share_chain`), so the budgets telescope from
the first share's rounded target before, zero, to the last share's rounded target after, the posted
amount itself (`acquisitionConstruction_proceed`).
-/
import Rastrata.Kernel.InventoryOwnership.Reduction.ReductionGroup

namespace Rastrata.Kernel

namespace InventoryOwnership

/-- `ordered` (line 382): the entries in holding-identifier order. -/
def acquisitionOrdered (entries : List InventoryPostedAcquisitionEntry) :
    List InventoryPostedAcquisitionEntry :=
  sortByText (·.holding.id.value) entries

/-- `first` (line 382): the first ordered holding. -/
def acquisitionFirst (entries : List InventoryPostedAcquisitionEntry) : LotHolding :=
  ((acquisitionOrdered entries).head?.map (·.holding)).getD default

/-- Every value a prepared acquisition group was computed from, and how (lines 363 to 447). -/
structure AcquisitionGroupView (context : InventoryPostedAcquisitionContext)
    (entries : List InventoryPostedAcquisitionEntry)
    (journalLink : Option InventoryPostedJournalLink) (group : InventoryPostedAcquisitionGroup) where
  quantity : ExactRational
  basis : ExactRational
  carrying : ExactRational
  posting : Option CanonicalPostingReference
  population : acquisitionPopulationInvalid context entries journalLink = false
  evidence : acquisitionEvidenceExceeded 0 entries = false
  identity : acquisitionIdentityInvalid context entries = false
  zeroCheck : ∃ zeroTotal zeroShare, ExactDecimal.of 0 0 = .ok zeroTotal ∧
    context.quantizationPolicy.quantizeCumulativePostedShare zeroTotal ExactRational.zero
      ExactRational.zero = .ok (.quantized zeroShare)
  sources : acquisitionSourceLoop context (acquisitionFirst entries) ExactRational.zero
    ExactRational.zero ExactRational.zero (acquisitionOrdered entries) =
      .ok (.proceed (quantity, basis, carrying))
  postingStep : acquisitionPosting context (acquisitionFirst entries) journalLink quantity basis
    carrying = .ok (.proceed (group.postedAmount, posting))
  construction : acquisitionConstruction context group.postedAmount posting carrying.isZero
    (if carrying.isZero then quantity else carrying) (acquisitionOrdered entries).length 0
    ExactRational.zero (acquisitionOrdered entries) =
      .ok (.proceed (group.anchors, group.movements))
  lots : group.lots = (acquisitionOrdered entries).map (·.lot)
  holdings : group.holdings = (acquisitionOrdered entries).map (·.holding)

end InventoryOwnership

open InventoryOwnership in
/-- A prepared acquisition group passed every test and was computed as the TypeScript computes
it. -/
theorem prepareInventoryPostedAcquisitionGroup_prepared
    {context : InventoryPostedAcquisitionContext} {entries : List InventoryPostedAcquisitionEntry}
    {journalLink : Option InventoryPostedJournalLink} {group : InventoryPostedAcquisitionGroup}
    (h : prepareInventoryPostedAcquisitionGroup context entries journalLink =
      .ok (.prepared group)) :
    Nonempty (AcquisitionGroupView context entries journalLink group) := by
  unfold prepareInventoryPostedAcquisitionGroup at h
  dsimp only at h
  split at h
  · cases h
  rename_i hpop
  split at h
  · cases h
  rename_i hev
  split at h
  · cases h
  rename_i hid
  split at h
  · cases h
  rename_i zeroTotal hzero
  split at h
  · cases h
  · cases h
  rename_i zeroShare hzshare
  split at h
  · cases h
  · cases h
  rename_i quantity basis carrying hsrc
  split at h
  · cases h
  · cases h
  rename_i posted posting hposting
  split at h
  · cases h
  · cases h
  rename_i anchors movements hcons
  simp only [Except.ok.injEq, InventoryPostedAcquisitionGroupResult.prepared.injEq] at h
  subst h
  rw [ofQuantize_eq_ok_iff, liftExact_eq_ok_iff] at hzero
  rw [ofQuantize_eq_ok_iff] at hzshare hsrc hcons
  exact ⟨⟨quantity, basis, carrying, posting, by simpa using hpop, by simpa using hev,
    by simpa using hid, ⟨zeroTotal, zeroShare, hzero, hzshare⟩, hsrc, hposting, hcons, rfl, rfl⟩⟩


namespace InventoryOwnership

/-- Two shares of one total under one policy, the second starting where the first ends: the first's
rounded target after is the second's rounded target before. -/
theorem share_chain {total : ExactDecimal} {before after before' after' : ExactRational}
    {policy : QuantizationPolicy} {share share' : PolicyCumulativePostedShare}
    (h : policy.quantizeCumulativePostedShare total before after = .ok (.quantized share))
    (h' : policy.quantizeCumulativePostedShare total before' after' = .ok (.quantized share'))
    (heq : after = before') : share.afterQuantization = share'.beforeQuantization := by
  obtain ⟨hrule, -⟩ := QuantizationPolicy.quantizeCumulativePostedShare_quantized_iff.mp h
  obtain ⟨hrule', -⟩ := QuantizationPolicy.quantizeCumulativePostedShare_quantized_iff.mp h'
  obtain ⟨t, -, -, ht, -, -, -, -, -, -, -, -, hat, -, haq, -⟩ :=
    quantizeCumulativePostedShare_quantized hrule
  obtain ⟨t', -, -, ht', -, -, -, -, -, -, -, hbt', -, hbq', -⟩ :=
    quantizeCumulativePostedShare_quantized hrule'
  have htt : t = t' := by
    rw [ht] at ht'
    exact Except.ok.inj ht'
  subst htt heq
  have htarget : share.toShare.afterTarget = share'.toShare.beforeTarget := by
    rw [hat] at hbt'
    exact Except.ok.inj hbt'
  rw [htarget] at haq
  rw [haq] at hbq'
  exact Except.ok.inj hbq'

/-- The weight of an acquisition or adoption entry: its quantity when the group carries nothing,
its carrying amount otherwise (lines 426 and 849). -/
def entryWeight (carryingZero : Bool) (holding : LotHolding) : ExactRational :=
  if carryingZero then holding.remainingQuantity else holding.remainingCarryingAmount

/-- The construction loop of an acquisition group, when it goes through: one anchor and one
movement per entry, each anchor of its holding's quantity and each movement posting its anchor's
budget; and the budgets telescope: they add up to the last share's rounded target after less the
first share's rounded target before, the first share starting at the running weight and the last
ending at the running weight plus every entry's weight, over the denominator. -/
theorem acquisitionConstruction_proceed {context : InventoryPostedAcquisitionContext}
    {posted : ExactDecimal} {posting : Option CanonicalPostingReference} {carryingZero : Bool}
    {denominator : ExactRational} {count : Nat} (hposted : posted.WF) (hden : denominator.WF) :
    ∀ {entries : List InventoryPostedAcquisitionEntry} {index : Nat} {cumulative : ExactRational}
      {anchors : List InventoryPostedAnchor} {movements : List InventoryPostedAcquisitionMovement},
      cumulative.WF → (∀ entry ∈ entries, entry.holding.WF) →
      acquisitionConstruction context posted posting carryingZero denominator count index
        cumulative entries = .ok (.proceed (anchors, movements)) →
      anchors.length = entries.length ∧ movements.length = entries.length ∧
        anchors.map (·.quantity) = entries.map (·.holding.remainingQuantity) ∧
        movements.map (·.postedAmount) = anchors.map (·.postedBudget) ∧
        (entries ≠ [] → ∃ before first last,
          cumulative.divide denominator = .ok before ∧
          (∃ after, context.quantizationPolicy.quantizeCumulativePostedShare posted before after =
            .ok (.quantized first)) ∧
          (∃ before', context.quantizationPolicy.quantizeCumulativePostedShare posted before'
            last.afterFraction = .ok (.quantized last)) ∧
          last.afterFraction.WF ∧
          last.afterFraction.toRat = (cumulative.toRat +
            (entries.map fun entry => (entryWeight carryingZero entry.holding).toRat).sum) /
              denominator.toRat ∧
          (anchors.map (·.postedBudget.toRat)).sum =
            last.afterQuantization.amount.toRat - first.beforeQuantization.amount.toRat)
  | [], index, cumulative, anchors, movements, _, _, h => by
    simp only [acquisitionConstruction, Except.ok.injEq, OwnershipStep.proceed.injEq,
      Prod.mk.injEq] at h
    obtain ⟨rfl, rfl⟩ := h
    simp
  | entry :: rest, index, cumulative, anchors, movements, hc, hH, h => by
    have hW : entry.holding.WF := hH entry (by simp)
    have hw : (entryWeight carryingZero entry.holding).WF := by
      unfold entryWeight; split
      · exact hW.remainingQuantity
      · exact hW.remainingCarryingAmount
    unfold acquisitionConstruction at h
    dsimp only at h
    split at h
    · cases h
    rename_i next hnext
    split at h
    · cases h
    rename_i before hbefore
    split at h
    · cases h
    rename_i after hafter
    rw [liftExact_eq_ok_iff] at hnext hbefore hafter
    split at h
    · cases h
    · cases h
    rename_i share hshare
    split at h
    · cases h
    rename_i zeroPosted hzero
    split at h
    · cases h
    · cases h
    rename_i anchors' movements' hrest
    simp only [Except.ok.injEq, OwnershipStep.proceed.injEq, Prod.mk.injEq] at h
    obtain ⟨rfl, rfl⟩ := h
    have hnext' : cumulative.add (entryWeight carryingZero entry.holding) = .ok next := hnext
    obtain ⟨hnwf, hntr⟩ := ExactRational.add_ok hc hw hnext'
    obtain ⟨hbwf, -, hbtr⟩ := ExactRational.divide_ok hc hden hbefore
    obtain ⟨hawf, -, hatr⟩ := ExactRational.divide_ok hnwf hden hafter
    obtain ⟨hsb, hsa, -, -, -, -, -, -, -, -, hpost, -⟩ := share_facts hposted hbwf hawf hshare
    obtain ⟨hl1, hl2, hl3, hl4, hl5⟩ := acquisitionConstruction_proceed hposted hden hnwf
      (fun e he => hH e (List.mem_cons_of_mem _ he)) hrest
    refine ⟨by simp [hl1], by simp [hl2], ?_, ?_, fun _ => ?_⟩
    · simp only [List.map_cons, hl3]
      rfl
    · simp only [List.map_cons, hl4, List.cons.injEq, and_true]
      unfold acquisitionMovementOf
      split <;> rfl
    · cases rest with
      | nil =>
        refine ⟨before, share, share, hbefore, ⟨after, hshare⟩, ⟨before, hsa ▸ hshare⟩,
          hsa ▸ hawf, ?_, ?_⟩
        · rw [hsa, hatr, hntr]
          simp
        · have : anchors' = [] := List.eq_nil_of_length_eq_zero (by simpa using hl1)
          subst this
          simp only [List.map_cons, List.map_nil, List.sum_cons, List.sum_nil, add_zero]
          exact hpost
      | cons entry' rest' =>
        obtain ⟨before', first', last', hbefore', ⟨after', hfirst'⟩, hlast', hlwf, hltr, hsum'⟩ :=
          hl5 (by simp)
        have hbb : before' = after := by
          rw [hafter] at hbefore'
          exact (Except.ok.inj hbefore').symm
        have hchain := share_chain hshare hfirst' hbb.symm
        refine ⟨before, share, last', hbefore, ⟨after, hshare⟩, hlast', hlwf, ?_, ?_⟩
        · rw [hltr, hntr]
          simp only [List.map_cons, List.sum_cons]
          ring
        · simp only [List.map_cons, List.sum_cons]
          rw [hsum', ← hchain]
          show share.postedAmount.toRat + _ = _
          rw [hpost]
          ring

end InventoryOwnership


namespace InventoryOwnership

/-- When the source test of an acquisition entry passes, its holding's quantity is the lot's,
which is positive. -/
theorem acquisitionSourceInvalid_false_quantity {context : InventoryPostedAcquisitionContext}
    {first : LotHolding} {entry : InventoryPostedAcquisitionEntry} (hL : entry.lot.WF)
    (h : acquisitionSourceInvalid context first entry = .ok false) :
    0 < entry.holding.remainingQuantity.toRat := by
  unfold acquisitionSourceInvalid at h
  dsimp only at h
  split_ifs at h with hcond
  · cases h
  simp only [Bool.or_eq_true, bne_iff_ne, ne_eq, not_or, Bool.not_eq_true,
    decide_eq_false_iff_not, beq_iff_eq, Bool.not_eq_false', exactRational_equals_iff_eq] at hcond
  obtain ⟨⟨⟨⟨⟨⟨-, hpos⟩, -⟩, hq⟩, -⟩, -⟩, -⟩ := hcond
  rw [hq]
  have := (ExactRational.compare_gt_iff hL.acquisitionQuantity ExactRational.zero_wf).mp
    (by simpa using hpos)
  rwa [ExactRational.zero_toRat] at this

/-- The source loop of an acquisition group, when it goes through: every entry passes its source
test, and the running quantity, basis and carrying amount grow by exactly the holdings'. -/
theorem acquisitionSourceLoop_proceed {context : InventoryPostedAcquisitionContext}
    {first : LotHolding} :
    ∀ {entries : List InventoryPostedAcquisitionEntry} {quantity basis carrying : ExactRational}
      {totalQuantity totalBasis totalCarrying : ExactRational},
      quantity.WF → basis.WF → carrying.WF → (∀ entry ∈ entries, entry.holding.WF) →
      acquisitionSourceLoop context first quantity basis carrying entries =
        .ok (.proceed (totalQuantity, totalBasis, totalCarrying)) →
      (∀ entry ∈ entries, acquisitionSourceInvalid context first entry = .ok false) ∧
        totalQuantity.WF ∧ totalBasis.WF ∧ totalCarrying.WF ∧
        totalQuantity.toRat =
          quantity.toRat + (entries.map (·.holding.remainingQuantity.toRat)).sum ∧
        totalBasis.toRat = basis.toRat + (entries.map (·.holding.remainingTotalBasis.toRat)).sum ∧
        totalCarrying.toRat =
          carrying.toRat + (entries.map (·.holding.remainingCarryingAmount.toRat)).sum
  | [], quantity, basis, carrying, totalQuantity, totalBasis, totalCarrying, hq, hb, hc, _, h => by
    simp only [acquisitionSourceLoop, Except.ok.injEq, OwnershipStep.proceed.injEq,
      Prod.mk.injEq] at h
    obtain ⟨rfl, rfl, rfl⟩ := h
    simp [hq, hb, hc]
  | entry :: rest, quantity, basis, carrying, totalQuantity, totalBasis, totalCarrying, hq, hb, hc,
      hH, h => by
    have hW : entry.holding.WF := hH entry (by simp)
    unfold acquisitionSourceLoop at h
    split at h
    · cases h
    · cases h
    rename_i htest
    split at h
    · cases h
    rename_i quantity' hq'
    split at h
    · cases h
    rename_i basis' hb'
    split at h
    · cases h
    rename_i carrying' hc'
    rw [liftExact_eq_ok_iff] at hq' hb' hc'
    obtain ⟨hq1, hq2⟩ := ExactRational.add_ok hq hW.remainingQuantity hq'
    obtain ⟨hb1, hb2⟩ := ExactRational.add_ok hb hW.remainingTotalBasis hb'
    obtain ⟨hc1, hc2⟩ := ExactRational.add_ok hc hW.remainingCarryingAmount hc'
    obtain ⟨htests, hqwf, hbwf, hcwf, hqt, hbt, hct⟩ := acquisitionSourceLoop_proceed hq1 hb1 hc1
      (fun e he => hH e (List.mem_cons_of_mem _ he)) h
    refine ⟨?_, hqwf, hbwf, hcwf, ?_, ?_, ?_⟩
    · intro e he
      simp only [List.mem_cons] at he
      rcases he with rfl | he
      · exact htest
      · exact htests e he
    · rw [hqt, hq2]; simp only [List.map_cons, List.sum_cons]; ring
    · rw [hbt, hb2]; simp only [List.map_cons, List.sum_cons]; ring
    · rw [hct, hc2]; simp only [List.map_cons, List.sum_cons]; ring

end InventoryOwnership


namespace InventoryOwnership

/-- What the posting step of an acquisition group gives: without a journal link the posted amount is
zero at the policy's scale and there is no posting reference; with one, the posted amount is the
one matching posting's money, which passed the journal and posting tests. -/
theorem acquisitionPosting_proceed {context : InventoryPostedAcquisitionContext}
    {first : LotHolding} {journalLink : Option InventoryPostedJournalLink}
    {quantity basis carrying : ExactRational} {posted : ExactDecimal}
    {posting : Option CanonicalPostingReference}
    (h : acquisitionPosting context first journalLink quantity basis carrying =
      .ok (.proceed (posted, posting))) :
    (journalLink = none → ExactDecimal.of 0 context.quantizationPolicy.targetScale = .ok posted ∧
      posting = none ∧ ∃ target, quantize carrying context.quantizationPolicy.rule = .ok target ∧
        target.amount.isZero = true) ∧
      ∀ link, journalLink = some link → ∃ actual key,
        link.source.journal.postings.filter (fun p => p.id == link.postingId) = [actual] ∧
        acquisitionJournalMismatch context link.source = false ∧
        acquisitionPostingInvalid context first quantity basis carrying actual = .ok false ∧
        posted = actual.bookValue.amount ∧ effectKey link.source.effectKey = .ok key ∧
        posting = some (createCanonicalPostingReference link.referenceId context.bookId
          link.source.journal.id actual key) := by
  unfold acquisitionPosting at h
  dsimp only at h
  split at h
  · cases h
  rename_i zeroPosted hzero
  rw [ofQuantize_eq_ok_iff, liftExact_eq_ok_iff] at hzero
  cases journalLink with
  | none =>
    simp only at h
    split at h
    · cases h
    rename_i target htarget
    rw [ofQuantize_eq_ok_iff] at htarget
    split at h
    · cases h
    rename_i hz
    simp only [Except.ok.injEq, OwnershipStep.proceed.injEq, Prod.mk.injEq] at h
    obtain ⟨rfl, rfl⟩ := h
    constructor
    · intro _
      exact ⟨hzero, rfl, target, htarget, by simpa using hz⟩
    · intro _ hl
      exact nomatch hl
  | some link =>
    simp only at h
    split at h
    · cases h
    rename_i hmismatch
    split at h
    · rename_i actual hfilter
      split at h
      · cases h
      · cases h
      rename_i htest
      rw [ofQuantize_eq_ok_iff] at htest
      split at h
      · cases h
      rename_i key hkey
      simp only [Except.ok.injEq, OwnershipStep.proceed.injEq, Prod.mk.injEq] at h
      obtain ⟨rfl, rfl⟩ := h
      refine ⟨(fun hl => nomatch hl), fun l hl => ?_⟩
      cases hl
      exact ⟨actual, key, hfilter, by simpa using hmismatch, htest, rfl, hkey, rfl⟩
    · cases h

end InventoryOwnership


namespace InventoryOwnership

/-- A share that starts at zero has a rounded target before of zero. -/
theorem share_before_zero {total : ExactDecimal} {before after : ExactRational}
    {policy : QuantizationPolicy} {share : PolicyCumulativePostedShare} (hT : total.WF)
    (hb : before.WF) (h0 : before.toRat = 0)
    (h : policy.quantizeCumulativePostedShare total before after = .ok (.quantized share)) :
    share.beforeQuantization.amount.toRat = 0 := by
  obtain ⟨hrule, -⟩ := QuantizationPolicy.quantizeCumulativePostedShare_quantized_iff.mp h
  obtain ⟨t, -, -, ht, -, -, -, -, -, -, -, hbt, -, hbq, -⟩ :=
    quantizeCumulativePostedShare_quantized hrule
  obtain ⟨htwf, -⟩ := ExactDecimal.toRational_ok hT ht
  obtain ⟨hbtwf, hbttr⟩ := ExactRational.multiply_ok htwf hb hbt
  have hzero : share.toShare.beforeTarget.toRat = 0 := by rw [hbttr, h0, mul_zero]
  have := quantize_representable (c := 0) hbtwf hbq (by rw [hzero]; simp)
  exact this.2.1.trans hzero

end InventoryOwnership

open InventoryOwnership in
/-- A prepared acquisition group's first anchors take exactly what its posting posts: one anchor
and one origin movement per entry, each anchor of its holding's quantity and each movement posting
its anchor's budget, and the budgets, cumulative shares of the posted amount by carrying amount (by
quantity when nothing is carried), add up to the posted amount exactly, nothing lost to rounding. -/
theorem prepareInventoryPostedAcquisitionGroup_conserved
    {context : InventoryPostedAcquisitionContext} {entries : List InventoryPostedAcquisitionEntry}
    {journalLink : Option InventoryPostedJournalLink} {group : InventoryPostedAcquisitionGroup}
    (hE : ∀ entry ∈ entries, entry.WF) (hJ : ∀ link, journalLink = some link → link.WF)
    (h : prepareInventoryPostedAcquisitionGroup context entries journalLink =
      .ok (.prepared group)) :
    group.anchors.length = entries.length ∧ group.movements.length = entries.length ∧
      (group.anchors.map (·.quantity.toRat)).sum =
        (entries.map (·.holding.remainingQuantity.toRat)).sum ∧
      group.movements.map (·.postedAmount) = group.anchors.map (·.postedBudget) ∧
      (group.anchors.map (·.postedBudget.toRat)).sum = group.postedAmount.toRat := by
  obtain ⟨v⟩ := prepareInventoryPostedAcquisitionGroup_prepared h
  have hperm := sortByText_perm (·.holding.id.value) entries
  have hEo : ∀ entry ∈ acquisitionOrdered entries, entry.WF := fun e he =>
    hE e (hperm.subset he)
  have hordlen : (acquisitionOrdered entries).length = entries.length := hperm.length_eq
  obtain ⟨htests, hqwf, -, hcwf, hqt, -, hct⟩ := acquisitionSourceLoop_proceed
    ExactRational.zero_wf ExactRational.zero_wf ExactRational.zero_wf
    (fun e he => (hEo e he).holding) v.sources
  have hpp := acquisitionPosting_proceed v.postingStep
  have hpwf : group.postedAmount.WF := by
    cases hjl : journalLink with
    | none => exact (ExactDecimal.of_ok (hpp.1 hjl).1).1
    | some link =>
      obtain ⟨actual, key, hfilter, -, -, hposted, -⟩ := hpp.2 link hjl
      have hmem : actual ∈ link.source.journal.postings := by
        have : actual ∈ link.source.journal.postings.filter (fun p => p.id == link.postingId) := by
          rw [hfilter]; simp
        exact List.mem_of_mem_filter this
      rw [hposted]
      exact ((hJ link hjl).source.journal actual hmem).amount
  have hdenwf : (if v.carrying.isZero then v.quantity else v.carrying).WF := by
    split
    · exact hqwf
    · exact hcwf
  obtain ⟨hl1, hl2, hl3, hl4, hl5⟩ := acquisitionConstruction_proceed hpwf hdenwf
    ExactRational.zero_wf (fun e he => (hEo e he).holding) v.construction
  have hlen0 : entries.length ≠ 0 := by
    have := v.population
    simp only [acquisitionPopulationInvalid, Bool.or_eq_false_iff, decide_eq_false_iff_not] at this
    exact this.1.1.1
  have hne : acquisitionOrdered entries ≠ [] := by
    intro hnil
    rw [hnil] at hordlen
    exact hlen0 hordlen.symm
  refine ⟨by rw [hl1, hordlen], by rw [hl2, hordlen], ?_, hl4, ?_⟩
  · have := congrArg (List.map ExactRational.toRat) hl3
    simp only [List.map_map, Function.comp_def] at this
    rw [this]
    exact (hperm.map _).sum_eq
  · obtain ⟨before, first, last, hbefore, ⟨after, hfirst⟩, ⟨before', hlast⟩, hlwf, hltr, hsum⟩ :=
      hl5 hne
    obtain ⟨hbwf, -, hbtr⟩ := ExactRational.divide_ok ExactRational.zero_wf hdenwf hbefore
    have hb0 : before.toRat = 0 := by rw [hbtr, ExactRational.zero_toRat, zero_div]
    have hfirst0 := share_before_zero hpwf hbwf hb0 hfirst
    -- the weights add up to the denominator, which is not zero
    have hweights : ((acquisitionOrdered entries).map fun entry =>
        (entryWeight v.carrying.isZero entry.holding).toRat).sum =
          (if v.carrying.isZero then v.quantity else v.carrying).toRat := by
      unfold entryWeight
      split
      · rw [hqt, ExactRational.zero_toRat, zero_add]
      · rw [hct, ExactRational.zero_toRat, zero_add]
    have hden0 : (if v.carrying.isZero then v.quantity else v.carrying).toRat ≠ 0 := by
      split
      · rename_i hz
        rw [hqt, ExactRational.zero_toRat, zero_add]
        apply ne_of_gt
        obtain ⟨e, es, hes⟩ := List.exists_cons_of_ne_nil hne
        rw [hes, List.map_cons, List.sum_cons]
        have hpos := acquisitionSourceInvalid_false_quantity (hEo e (by rw [hes]; simp)).lot
          (htests e (by rw [hes]; simp))
        have hrest : 0 ≤ (es.map (·.holding.remainingQuantity.toRat)).sum := by
          apply List.sum_nonneg
          intro x hx
          simp only [List.mem_map] at hx
          obtain ⟨e', he', rfl⟩ := hx
          exact (acquisitionSourceInvalid_false_quantity (hEo e' (by rw [hes]; simp [he'])).lot
            (htests e' (by rw [hes]; simp [he']))).le
        linarith
      · rename_i hz
        intro h0
        exact hz ((ExactRational.isZero_iff hcwf).mpr h0)
    have hlast1 : last.afterFraction.toRat = 1 := by
      rw [hltr, ExactRational.zero_toRat, zero_add, hweights, div_self hden0]
    have hlastT := (share_after_bounds hpwf hlwf hlast).2 hlast1
    rw [hsum, hlastT, hfirst0, sub_zero]

namespace InventoryOwnership

/-- When the posting test of an acquisition passes: the posting is of the group's account,
commodity and currency, carries exactly the group's quantity and a cost basis in that currency of
exactly the group's basis, carries positive money, and the group carries something. -/
theorem acquisitionPostingInvalid_false {context : InventoryPostedAcquisitionContext}
    {first : LotHolding} {quantity basis carrying : ExactRational} {actual : Posting}
    (h : acquisitionPostingInvalid context first quantity basis carrying actual = .ok false) :
    actual.accountId = first.accountId ∧ actual.units.commodityId = first.commodityId ∧
      actual.bookValue.functionalCommodityId = context.quantizationPolicy.functionalCommodityId ∧
      actual.units.canonicalNumber = quantity ∧
      (∃ costBasis, actual.costBasis = some costBasis ∧
        costBasis.basisCommodityId = context.quantizationPolicy.functionalCommodityId ∧
        costBasis.totalBasis = basis) ∧
      0 < actual.bookValue.amount.toRat ∧ carrying.isZero = false := by
  unfold acquisitionPostingInvalid at h
  dsimp only at h
  split_ifs at h with hcond
  · cases h
  simp only [Bool.or_eq_true, bne_iff_ne, ne_eq, not_or, not_not, Bool.not_eq_true,
    Bool.not_eq_false', exactRational_equals_iff_eq] at hcond
  obtain ⟨⟨⟨⟨⟨hacct, hunits⟩, hcur⟩, hqty⟩, hcb⟩, -⟩ := hcond
  split at h
  · cases h
  rename_i amount hamount
  rw [liftExact_eq_ok_iff] at hamount
  simp only [Except.ok.injEq, Bool.or_eq_false_iff] at h
  obtain ⟨hpos, hz⟩ := h
  refine ⟨hacct, hunits, hcur, hqty, ?_, ?_, hz⟩
  · revert hcb
    cases hc : actual.costBasis with
    | none => intro hcb; simp at hcb
    | some costBasis =>
      intro hcb
      simp only [Bool.or_eq_false_iff, bne_eq_false_iff_eq, Bool.not_eq_false',
        exactRational_equals_iff_eq] at hcb
      exact ⟨costBasis, rfl, hcb.1, hcb.2⟩
  · rw [← decimal_toRational_toRat hamount]
    have hawf : amount.WF := (ExactRational.of_ok hamount).1
    simp only [bne_eq_false_iff_eq] at hpos
    have := (ExactRational.compare_gt_iff hawf ExactRational.zero_wf).mp hpos
    rwa [ExactRational.zero_toRat] at this

end InventoryOwnership


open InventoryOwnership in
/-- The posting of a prepared acquisition group: without a journal link it posts nothing (and its
carrying amount rounds to zero); with one, it posts exactly the money of the one matching posting of
a journal that matches its command, revision, period, book, currency and date, and that posting is
positive and carries exactly the group's whole quantity and historical basis. -/
theorem prepareInventoryPostedAcquisitionGroup_posting
    {context : InventoryPostedAcquisitionContext} {entries : List InventoryPostedAcquisitionEntry}
    {journalLink : Option InventoryPostedJournalLink} {group : InventoryPostedAcquisitionGroup}
    (hE : ∀ entry ∈ entries, entry.WF)
    (h : prepareInventoryPostedAcquisitionGroup context entries journalLink =
      .ok (.prepared group)) :
    (journalLink = none → group.postedAmount.toRat = 0) ∧
      ∀ link, journalLink = some link → ∃ actual,
        link.source.journal.postings.filter (fun p => p.id == link.postingId) = [actual] ∧
        acquisitionJournalMismatch context link.source = false ∧
        group.postedAmount = actual.bookValue.amount ∧ 0 < actual.bookValue.amount.toRat ∧
        actual.units.canonicalNumber.toRat =
          (entries.map (·.holding.remainingQuantity.toRat)).sum ∧
        ∃ costBasis, actual.costBasis = some costBasis ∧
          costBasis.basisCommodityId = context.quantizationPolicy.functionalCommodityId ∧
          costBasis.totalBasis.toRat = (entries.map (·.holding.remainingTotalBasis.toRat)).sum := by
  obtain ⟨v⟩ := prepareInventoryPostedAcquisitionGroup_prepared h
  have hperm := sortByText_perm (·.holding.id.value) entries
  have hEo : ∀ entry ∈ acquisitionOrdered entries, entry.WF := fun e he =>
    hE e (hperm.subset he)
  obtain ⟨-, -, -, -, hqt, hbt, -⟩ := acquisitionSourceLoop_proceed
    ExactRational.zero_wf ExactRational.zero_wf ExactRational.zero_wf
    (fun e he => (hEo e he).holding) v.sources
  have hpp := acquisitionPosting_proceed v.postingStep
  constructor
  · intro hnone
    obtain ⟨hzero, -⟩ := hpp.1 hnone
    obtain ⟨-, hc, -⟩ := ExactDecimal.of_ok hzero
    unfold ExactDecimal.toRat
    rw [hc]
    simp
  · intro link hlink
    obtain ⟨actual, key, hfilter, hmismatch, htest, hposted, -, -⟩ := hpp.2 link hlink
    obtain ⟨-, -, -, hqty, ⟨costBasis, hcb, hcbc, hcbt⟩, hpos, -⟩ :=
      acquisitionPostingInvalid_false htest
    refine ⟨actual, hfilter, hmismatch, hposted, hpos, ?_, costBasis, hcb, hcbc, ?_⟩
    · rw [hqty, hqt, ExactRational.zero_toRat, zero_add]
      exact (hperm.map _).sum_eq
    · rw [hcbt, hbt, ExactRational.zero_toRat, zero_add]
      exact (hperm.map _).sum_eq

end Rastrata.Kernel

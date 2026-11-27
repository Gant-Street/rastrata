/-
The laws of `prepareInventoryPostedAdoptionGroup` (`inventory-ownership.ts` line 800): a prepared
adoption adopts exactly the supplied balance and quantities, with budgets that telescope to the
balance as an acquisition's do (`Reduction/Acquisition.lean`).
-/
import Rastrata.Kernel.InventoryOwnership.Transfer.Laws

namespace Rastrata.Kernel

namespace InventoryOwnership

/-- `ordered` (line 822): the entries in holding-identifier order. -/
def adoptionOrdered (entries : List InventoryPostedAdoptionEntry) :
    List InventoryPostedAdoptionEntry :=
  sortByText (·.holding.id.value) entries

/-- `first` (line 822). -/
def adoptionFirst (entries : List InventoryPostedAdoptionEntry) : LotHolding :=
  ((adoptionOrdered entries).head?.map (·.holding)).getD default

/-- Every value a prepared adoption group was computed from, and how (lines 805 to 873). -/
structure AdoptionGroupView (context : InventoryPostedAdoptionContext)
    (entries : List InventoryPostedAdoptionEntry) (postedBalance : ExactRational)
    (group : InventoryPostedAdoptionGroup) where
  carrying : ExactRational
  balance : QuantizedValue
  balanceRational : ExactRational
  population : adoptionPopulationInvalid context entries = false
  evidence : adoptionEvidenceExceeded 0 entries = false
  identity : adoptionIdentityInvalid context entries = false
  sources : adoptionSourceLoop context (adoptionFirst entries) ExactRational.zero
    ExactRational.zero (adoptionOrdered entries) = .ok (.proceed (group.adoptedQuantity, carrying))
  quantized : quantize postedBalance context.quantizationPolicy.rule = .ok balance
  balance_eq : balance.amount.toRational = .ok balanceRational
  balanceMatches : balanceRational.equals postedBalance = true
  carryingMatches : postedBalance.equals carrying = true
  construction : adoptionConstruction context balance.amount carrying.isZero
    (if carrying.isZero then group.adoptedQuantity else carrying) (adoptionOrdered entries).length 0
    ExactRational.zero (adoptionOrdered entries) =
      .ok (.proceed (group.anchors, group.movements, group.positions))
  adoptedPostedBalance : group.adoptedPostedBalance = balance.amount
  holdings : group.holdings = (adoptionOrdered entries).map (·.holding)

end InventoryOwnership

open InventoryOwnership in
/-- A prepared adoption group passed every test and was computed as the TypeScript computes it. -/
theorem prepareInventoryPostedAdoptionGroup_prepared
    {context : InventoryPostedAdoptionContext} {entries : List InventoryPostedAdoptionEntry}
    {postedBalance : ExactRational} {group : InventoryPostedAdoptionGroup}
    (h : prepareInventoryPostedAdoptionGroup context entries postedBalance =
      .ok (.prepared group)) :
    Nonempty (AdoptionGroupView context entries postedBalance group) := by
  unfold prepareInventoryPostedAdoptionGroup at h
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
  · cases h
  rename_i quantity carrying hsrc
  split at h
  · cases h
  rename_i balance hbal
  split at h
  · cases h
  rename_i balanceRational hbr
  split at h
  · cases h
  rename_i hmatch
  split at h
  · cases h
  · cases h
  rename_i anchors movements positions hcons
  simp only [Except.ok.injEq, InventoryPostedAdoptionGroupResult.prepared.injEq] at h
  subst h
  rw [ofQuantize_eq_ok_iff] at hsrc hbal hcons
  rw [ofQuantize_eq_ok_iff, liftExact_eq_ok_iff] at hbr
  simp only [Bool.or_eq_true, Bool.not_eq_true', not_or, Bool.not_eq_false] at hmatch
  exact ⟨⟨carrying, balance, balanceRational, by simpa using hpop, by simpa using hev,
    by simpa using hid, hsrc, hbal, hbr, hmatch.1, hmatch.2, hcons, rfl, rfl⟩⟩


namespace InventoryOwnership

/-- When the source test of an adoption entry passes, its holding's quantity is positive and its
carrying amount is not negative. -/
theorem adoptionSourceInvalid_false {context : InventoryPostedAdoptionContext}
    {first : LotHolding} {entry : InventoryPostedAdoptionEntry} (hH : entry.holding.WF)
    (h : adoptionSourceInvalid context first entry = .ok false) :
    0 < entry.holding.remainingQuantity.toRat := by
  unfold adoptionSourceInvalid at h
  dsimp only at h
  split_ifs at h with hcond
  · cases h
  simp only [Bool.or_eq_true, bne_iff_ne, ne_eq, not_or, Bool.not_eq_true,
    decide_eq_false_iff_not, beq_iff_eq] at hcond
  have hpos := hcond.1.1.1.2
  have := (ExactRational.compare_gt_iff hH.remainingQuantity ExactRational.zero_wf).mp
    (by simpa using hpos)
  rwa [ExactRational.zero_toRat] at this

/-- The source loop of an adoption group, when it goes through: every entry passes its source test,
and the running quantity and carrying amount grow by exactly the holdings'. -/
theorem adoptionSourceLoop_proceed {context : InventoryPostedAdoptionContext}
    {first : LotHolding} :
    ∀ {entries : List InventoryPostedAdoptionEntry} {quantity carrying : ExactRational}
      {totalQuantity totalCarrying : ExactRational},
      quantity.WF → carrying.WF → (∀ entry ∈ entries, entry.holding.WF) →
      adoptionSourceLoop context first quantity carrying entries =
        .ok (.proceed (totalQuantity, totalCarrying)) →
      (∀ entry ∈ entries, adoptionSourceInvalid context first entry = .ok false) ∧
        totalQuantity.WF ∧ totalCarrying.WF ∧
        totalQuantity.toRat =
          quantity.toRat + (entries.map (·.holding.remainingQuantity.toRat)).sum ∧
        totalCarrying.toRat =
          carrying.toRat + (entries.map (·.holding.remainingCarryingAmount.toRat)).sum
  | [], quantity, carrying, totalQuantity, totalCarrying, hq, hc, _, h => by
    simp only [adoptionSourceLoop, Except.ok.injEq, OwnershipStep.proceed.injEq,
      Prod.mk.injEq] at h
    obtain ⟨rfl, rfl⟩ := h
    simp [hq, hc]
  | entry :: rest, quantity, carrying, totalQuantity, totalCarrying, hq, hc, hH, h => by
    have hW : entry.holding.WF := hH entry (by simp)
    unfold adoptionSourceLoop at h
    split at h
    · cases h
    · cases h
    rename_i htest
    split at h
    · cases h
    rename_i quantity' hq'
    split at h
    · cases h
    rename_i carrying' hc'
    rw [liftExact_eq_ok_iff] at hq' hc'
    obtain ⟨hq1, hq2⟩ := ExactRational.add_ok hq hW.remainingQuantity hq'
    obtain ⟨hc1, hc2⟩ := ExactRational.add_ok hc hW.remainingCarryingAmount hc'
    obtain ⟨htests, hqwf, hcwf, hqt, hct⟩ := adoptionSourceLoop_proceed hq1 hc1
      (fun e he => hH e (List.mem_cons_of_mem _ he)) h
    refine ⟨?_, hqwf, hcwf, ?_, ?_⟩
    · intro e he
      simp only [List.mem_cons] at he
      rcases he with rfl | he
      · exact htest
      · exact htests e he
    · rw [hqt, hq2]; simp only [List.map_cons, List.sum_cons]; ring
    · rw [hct, hc2]; simp only [List.map_cons, List.sum_cons]; ring

/-- The construction loop of an adoption group, when it goes through: one anchor, one movement and
one position per entry, each anchor of its holding's quantity, each movement quantity-only and
posting nothing; and the budgets telescope as in an acquisition (`acquisitionConstruction_proceed`). -/
theorem adoptionConstruction_proceed {context : InventoryPostedAdoptionContext}
    {balance : ExactDecimal} {carryingZero : Bool} {denominator : ExactRational} {count : Nat}
    (hbalance : balance.WF) (hden : denominator.WF) :
    ∀ {entries : List InventoryPostedAdoptionEntry} {index : Nat} {cumulative : ExactRational}
      {anchors : List InventoryPostedAnchor} {movements : List InventoryPostedAcquisitionMovement}
      {positions : List InventoryPostedPosition},
      cumulative.WF → (∀ entry ∈ entries, entry.holding.WF) →
      adoptionConstruction context balance carryingZero denominator count index cumulative
        entries = .ok (.proceed (anchors, movements, positions)) →
      anchors.length = entries.length ∧ movements.length = entries.length ∧
        positions.length = entries.length ∧
        anchors.map (·.quantity) = entries.map (·.holding.remainingQuantity) ∧
        (∀ movement ∈ movements, movement.monetaryKind = .quantityOnly ∧
          movement.postedAmount.toRat = 0) ∧
        (entries ≠ [] → ∃ before first last,
          cumulative.divide denominator = .ok before ∧
          (∃ after, context.quantizationPolicy.quantizeCumulativePostedShare balance before after =
            .ok (.quantized first)) ∧
          (∃ before', context.quantizationPolicy.quantizeCumulativePostedShare balance before'
            last.afterFraction = .ok (.quantized last)) ∧
          last.afterFraction.WF ∧
          last.afterFraction.toRat = (cumulative.toRat +
            (entries.map fun entry => (entryWeight carryingZero entry.holding).toRat).sum) /
              denominator.toRat ∧
          (anchors.map (·.postedBudget.toRat)).sum =
            last.afterQuantization.amount.toRat - first.beforeQuantization.amount.toRat)
  | [], index, cumulative, anchors, movements, positions, _, _, h => by
    simp only [adoptionConstruction, Except.ok.injEq, OwnershipStep.proceed.injEq,
      Prod.mk.injEq] at h
    obtain ⟨rfl, rfl, rfl⟩ := h
    simp
  | entry :: rest, index, cumulative, anchors, movements, positions, hc, hH, h => by
    have hW : entry.holding.WF := hH entry (by simp)
    have hw : (entryWeight carryingZero entry.holding).WF := by
      unfold entryWeight; split
      · exact hW.remainingQuantity
      · exact hW.remainingCarryingAmount
    unfold adoptionConstruction at h
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
    rename_i zeroTotal hzeroTotal
    split at h
    · cases h
    · cases h
    rename_i zeroProof hzeroProof
    split at h
    · cases h
    rename_i zeroAmount hzeroAmount
    split at h
    · cases h
    · cases h
    rename_i anchors' movements' positions' hrest
    simp only [Except.ok.injEq, OwnershipStep.proceed.injEq, Prod.mk.injEq] at h
    obtain ⟨rfl, rfl, rfl⟩ := h
    rw [liftExact_eq_ok_iff] at hzero
    have hza : zeroAmount = zeroPosted :=
      ((Except.ok.inj hzeroTotal).trans (Except.ok.inj hzeroAmount)).symm
    have hnext' : cumulative.add (entryWeight carryingZero entry.holding) = .ok next := hnext
    obtain ⟨hnwf, hntr⟩ := ExactRational.add_ok hc hw hnext'
    obtain ⟨hbwf, -, hbtr⟩ := ExactRational.divide_ok hc hden hbefore
    obtain ⟨hawf, -, hatr⟩ := ExactRational.divide_ok hnwf hden hafter
    obtain ⟨hsb, hsa, -, -, -, -, -, -, -, -, hpost, -⟩ := share_facts hbalance hbwf hawf hshare
    obtain ⟨hl1, hl2, hl3, hl4, hl5, hl6⟩ := adoptionConstruction_proceed hbalance hden hnwf
      (fun e he => hH e (List.mem_cons_of_mem _ he)) hrest
    refine ⟨by simp [hl1], by simp [hl2], by simp [hl3], ?_, ?_, fun _ => ?_⟩
    · simp only [List.map_cons, hl4]
      rfl
    · intro m hm
      simp only [List.mem_cons] at hm
      rcases hm with rfl | hm
      · refine ⟨rfl, ?_⟩
        show zeroAmount.toRat = 0
        rw [hza]
        obtain ⟨-, hc0, -⟩ := ExactDecimal.of_ok hzero
        unfold ExactDecimal.toRat
        rw [hc0]
        simp
      · exact hl5 m hm
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
          hl6 (by simp)
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


open InventoryOwnership in
/-- A prepared adoption group adopts exactly the supplied balance and quantities: one anchor, one
position and one quantity-only movement posting nothing per holding; the adopted quantity is the
holdings' quantity and each anchor holds its holding's; the adopted posted balance is the supplied
one, which is the holdings' complete carrying amount; and the anchors' budgets, cumulative shares of
it, add up to it exactly. -/
theorem prepareInventoryPostedAdoptionGroup_conserved
    {context : InventoryPostedAdoptionContext} {entries : List InventoryPostedAdoptionEntry}
    {postedBalance : ExactRational} {group : InventoryPostedAdoptionGroup}
    (hE : ∀ entry ∈ entries, entry.WF) (hB : postedBalance.WF)
    (h : prepareInventoryPostedAdoptionGroup context entries postedBalance =
      .ok (.prepared group)) :
    group.anchors.length = entries.length ∧ group.movements.length = entries.length ∧
      group.positions.length = entries.length ∧
      group.adoptedQuantity.toRat = (entries.map (·.holding.remainingQuantity.toRat)).sum ∧
      (group.anchors.map (·.quantity.toRat)).sum = group.adoptedQuantity.toRat ∧
      group.adoptedPostedBalance.toRat = postedBalance.toRat ∧
      postedBalance.toRat = (entries.map (·.holding.remainingCarryingAmount.toRat)).sum ∧
      (group.anchors.map (·.postedBudget.toRat)).sum = group.adoptedPostedBalance.toRat ∧
      ∀ movement ∈ group.movements,
        movement.monetaryKind = .quantityOnly ∧ movement.postedAmount.toRat = 0 := by
  obtain ⟨v⟩ := prepareInventoryPostedAdoptionGroup_prepared h
  have hperm := sortByText_perm (·.holding.id.value) entries
  have hEo : ∀ entry ∈ adoptionOrdered entries, entry.WF := fun e he =>
    hE e (hperm.subset he)
  have hordlen : (adoptionOrdered entries).length = entries.length := hperm.length_eq
  obtain ⟨htests, hqwf, hcwf, hqt, hct⟩ := adoptionSourceLoop_proceed ExactRational.zero_wf
    ExactRational.zero_wf (fun e he => (hEo e he).holding) v.sources
  obtain ⟨hbalwf, -, -, -, -⟩ := quantize_ok hB v.quantized
  have hbr : v.balanceRational = postedBalance := (exactRational_equals_iff_eq _ _).mp
    v.balanceMatches
  have hpc : postedBalance = v.carrying := (exactRational_equals_iff_eq _ _).mp v.carryingMatches
  have hbal : v.balance.amount.toRat = postedBalance.toRat := by
    rw [← decimal_toRational_toRat v.balance_eq, hbr]
  have hdenwf : (if v.carrying.isZero then group.adoptedQuantity else v.carrying).WF := by
    split
    · exact hqwf
    · exact hcwf
  obtain ⟨hl1, hl2, hl3, hl4, hl5, hl6⟩ := adoptionConstruction_proceed hbalwf hdenwf
    ExactRational.zero_wf (fun e he => (hEo e he).holding) v.construction
  have hlen0 : entries.length ≠ 0 := by
    have := v.population
    simp only [adoptionPopulationInvalid, Bool.or_eq_false_iff, decide_eq_false_iff_not] at this
    exact this.1.1
  have hne : adoptionOrdered entries ≠ [] := by
    intro hnil
    rw [hnil] at hordlen
    exact hlen0 hordlen.symm
  have hQ : group.adoptedQuantity.toRat = (entries.map (·.holding.remainingQuantity.toRat)).sum := by
    rw [hqt, ExactRational.zero_toRat, zero_add]
    exact (hperm.map _).sum_eq
  refine ⟨by rw [hl1, hordlen], by rw [hl2, hordlen], by rw [hl3, hordlen], hQ, ?_, ?_, ?_, ?_,
    hl5⟩
  · have := congrArg (List.map ExactRational.toRat) hl4
    simp only [List.map_map, Function.comp_def] at this
    rw [this, hQ]
    exact (hperm.map _).sum_eq
  · rw [v.adoptedPostedBalance, hbal]
  · rw [hpc, hct, ExactRational.zero_toRat, zero_add]
    exact (hperm.map _).sum_eq
  · obtain ⟨before, first, last, hbefore, ⟨after, hfirst⟩, ⟨before', hlast⟩, hlwf, hltr, hsum⟩ :=
      hl6 hne
    obtain ⟨hbwf, -, hbtr⟩ := ExactRational.divide_ok ExactRational.zero_wf hdenwf hbefore
    have hb0 : before.toRat = 0 := by rw [hbtr, ExactRational.zero_toRat, zero_div]
    have hfirst0 := share_before_zero hbalwf hbwf hb0 hfirst
    have hweights : ((adoptionOrdered entries).map fun entry =>
        (entryWeight v.carrying.isZero entry.holding).toRat).sum =
          (if v.carrying.isZero then group.adoptedQuantity else v.carrying).toRat := by
      unfold entryWeight
      split
      · rw [hqt, ExactRational.zero_toRat, zero_add]
      · rw [hct, ExactRational.zero_toRat, zero_add]
    have hden0 : (if v.carrying.isZero then group.adoptedQuantity else v.carrying).toRat ≠ 0 := by
      split
      · rw [hqt, ExactRational.zero_toRat, zero_add]
        apply ne_of_gt
        obtain ⟨e, es, hes⟩ := List.exists_cons_of_ne_nil hne
        rw [hes, List.map_cons, List.sum_cons]
        have hpos := adoptionSourceInvalid_false (hEo e (by rw [hes]; simp)).holding
          (htests e (by rw [hes]; simp))
        have hrest : 0 ≤ (es.map (·.holding.remainingQuantity.toRat)).sum := by
          apply List.sum_nonneg
          intro x hx
          simp only [List.mem_map] at hx
          obtain ⟨e', he', rfl⟩ := hx
          exact (adoptionSourceInvalid_false (hEo e' (by rw [hes]; simp [he'])).holding
            (htests e' (by rw [hes]; simp [he']))).le
        linarith
      · rename_i hz
        intro h0
        exact hz ((ExactRational.isZero_iff hcwf).mpr h0)
    have hlast1 : last.afterFraction.toRat = 1 := by
      rw [hltr, ExactRational.zero_toRat, zero_add, hweights, div_self hden0]
    have hlastT := (share_after_bounds hbalwf hlwf hlast).2 hlast1
    rw [hsum, hlastT, hfirst0, sub_zero, v.adoptedPostedBalance]

end Rastrata.Kernel

/-
The laws of `prepareInventoryPostedReductionGroup` (`inventory-ownership.ts` line 462): a prepared
group is its entries' reductions, each prepared as `prepareInventoryPostedReduction` prepares it, in
holding-identifier order with consecutive ordinals; its money, quantity and basis are the sums of
theirs; and a money-bearing group is linked to exactly one actual posting that carries that money,
the quantity taken out and the basis taken out.
-/
import Rastrata.Kernel.InventoryOwnership.Reduction.Rejections

namespace Rastrata.Kernel

namespace InventoryOwnership

/-- The entries' reductions, from the entry at `index`: each is the reduction
`prepareInventoryPostedReduction` prepares for its entry, with the origin of its ordinal. -/
def ReductionsPrepared (context : InventoryPostedGroupContext) :
    Nat → List InventoryPostedReductionEntry → List InventoryPostedReduction → Prop
  | _, [], [] => True
  | index, entry :: entries, reduction :: reductions =>
    prepareInventoryPostedReduction entry.anchor entry.position entry.holding entry.allocation
        (groupOrigin context entry.movementId index) = .ok (.prepared reduction) ∧
      ReductionsPrepared context (index + 1) entries reductions
  | _, _, _ => False

/-- A prepared reduction posts a constructible amount. -/
theorem prepared_postedAmount_wf {anchor : InventoryPostedAnchor}
    {position : InventoryPostedPosition} {holding : LotHolding} {allocation : LotAllocation}
    {origin : InventoryPostedReductionOrigin} {reduction : InventoryPostedReduction}
    (h : prepareInventoryPostedReduction anchor position holding allocation origin =
      .ok (.prepared reduction)) : reduction.postedAmount.WF := by
  obtain ⟨v⟩ := prepareInventoryPostedReduction_prepared h
  exact (ExactDecimal.of_ok (reductionRecord_ok v.record_eq).1.postedAmount).1

/-- The loop of a reduction group, when it goes through: one reduction per entry, each prepared for
its entry with its ordinal and each entry of the group's coordinate, and the running money,
quantity and basis grown by exactly the reductions' posted amounts and the allocations' quantities
and bases. -/
theorem reductionGroupLoop_proceed {context : InventoryPostedReductionGroupContext}
    {coordinate : InventoryPostedCoordinate} :
    ∀ {entries : List InventoryPostedReductionEntry} {index : Nat}
      {posted quantity basis : ExactRational} {reductions : List InventoryPostedReduction}
      {total totalQuantity totalBasis : ExactRational},
      posted.WF → quantity.WF → basis.WF → (∀ entry ∈ entries, entry.allocation.WF) →
      reductionGroupLoop context coordinate index posted quantity basis entries =
        .ok (.proceed (reductions, total, totalQuantity, totalBasis)) →
      ReductionsPrepared context.toInventoryPostedGroupContext index entries reductions ∧
        (∀ entry ∈ entries,
          groupCoordinateMismatch context.bookId coordinate entry.anchor.coordinate = false) ∧
        total.WF ∧ totalQuantity.WF ∧ totalBasis.WF ∧
        total.toRat = posted.toRat + (reductions.map (·.postedAmount.toRat)).sum ∧
        totalQuantity.toRat =
          quantity.toRat + (entries.map (·.allocation.allocatedQuantity.toRat)).sum ∧
        totalBasis.toRat =
          basis.toRat + (entries.map (·.allocation.allocatedTotalBasis.toRat)).sum
  | [], _, posted, quantity, basis, reductions, total, totalQuantity, totalBasis, hp, hq, hb, _,
      h => by
    simp only [reductionGroupLoop, Except.ok.injEq, OwnershipStep.proceed.injEq,
      Prod.mk.injEq] at h
    obtain ⟨rfl, rfl, rfl, rfl⟩ := h
    simp [ReductionsPrepared, hp, hq, hb]
  | entry :: entries, index, posted, quantity, basis, reductions, total, totalQuantity,
      totalBasis, hp, hq, hb, hL, h => by
    have hLe : entry.allocation.WF := hL entry (by simp)
    unfold reductionGroupLoop at h
    split at h
    · cases h
    rename_i hcoord
    split at h
    · cases h
    · cases h
    rename_i reduction hprep
    split at h
    · cases h
    rename_i amount hamount
    split at h
    · cases h
    rename_i posted' hposted
    split at h
    · cases h
    rename_i quantity' hquantity
    split at h
    · cases h
    rename_i basis' hbasis
    rw [liftExact_eq_ok_iff] at hamount hposted hquantity hbasis
    have hpa := ExactDecimal.toRational_ok (prepared_postedAmount_wf hprep) hamount
    obtain ⟨hp', hptr⟩ := ExactRational.add_ok hp hpa.1 hposted
    obtain ⟨hq', hqtr⟩ := ExactRational.add_ok hq hLe.allocatedQuantity hquantity
    obtain ⟨hb', hbtr⟩ := ExactRational.add_ok hb hLe.allocatedTotalBasis hbasis
    split at h
    · cases h
    · cases h
    rename_i reductions' total' totalQuantity' totalBasis' hrest
    simp only [Except.ok.injEq, OwnershipStep.proceed.injEq, Prod.mk.injEq] at h
    obtain ⟨rfl, rfl, rfl, rfl⟩ := h
    obtain ⟨hprepared, hcoords, htwf, hqwf, hbwf, ht, hqt, hbt⟩ :=
      reductionGroupLoop_proceed hp' hq' hb' (fun e he => hL e (by simp [he])) hrest
    refine ⟨⟨hprep, hprepared⟩, ?_, htwf, hqwf, hbwf, ?_, ?_, ?_⟩
    · intro e he
      simp only [List.mem_cons] at he
      rcases he with rfl | he
      · simpa using hcoord
      · exact hcoords e he
    · rw [ht, hptr, hpa.2]
      simp only [List.map_cons, List.sum_cons]
      ring
    · rw [hqt, hqtr]
      simp only [List.map_cons, List.sum_cons]
      ring
    · rw [hbt, hbtr]
      simp only [List.map_cons, List.sum_cons]
      ring

end InventoryOwnership

namespace InventoryOwnership

/-- `ordered` (line 485): the entries in holding-identifier order. -/
def reductionGroupOrdered (entries : List InventoryPostedReductionEntry) :
    List InventoryPostedReductionEntry :=
  sortByText (·.holding.id.value) entries

/-- `coordinate` (line 486): the first ordered entry's coordinate. -/
def reductionGroupCoordinate (entries : List InventoryPostedReductionEntry) :
    InventoryPostedCoordinate :=
  ((reductionGroupOrdered entries).head?.map (·.anchor.coordinate)).getD default

/-- Every value a prepared reduction group was computed from, and how (lines 467 to 541). -/
structure ReductionGroupView (context : InventoryPostedReductionGroupContext)
    (entries : List InventoryPostedReductionEntry)
    (journalLink : Option InventoryPostedJournalLink) (group : InventoryPostedReductionGroup) where
  reductions : List InventoryPostedReduction
  posting : Option CanonicalPostingReference
  population : reductionGroupPopulationInvalid entries journalLink = false
  sources : reductionGroupSourcesExceeded 0 entries = false
  identity : reductionGroupIdentityInvalid context entries = false
  loop : reductionGroupLoop context (reductionGroupCoordinate entries) 0 ExactRational.zero
    ExactRational.zero ExactRational.zero (reductionGroupOrdered entries) =
      .ok (.proceed (reductions, group.postedAmount, group.quantity, group.historicalBasis))
  postingStep : reductionGroupPosting context (reductionGroupCoordinate entries) journalLink
    group.postedAmount group.quantity group.historicalBasis = .ok (.proceed posting)
  movements : group.movements =
    reductionGroupMovements context posting 0 (reductionGroupOrdered entries) reductions
  afterHoldings : group.afterHoldings = reductions.map (·.afterHolding)

end InventoryOwnership

open InventoryOwnership in
/-- A prepared reduction group passed every test and was computed as the TypeScript computes it. -/
theorem prepareInventoryPostedReductionGroup_prepared
    {context : InventoryPostedReductionGroupContext} {entries : List InventoryPostedReductionEntry}
    {journalLink : Option InventoryPostedJournalLink} {group : InventoryPostedReductionGroup}
    (h : prepareInventoryPostedReductionGroup context entries journalLink = .ok (.prepared group)) :
    Nonempty (ReductionGroupView context entries journalLink group) := by
  unfold prepareInventoryPostedReductionGroup at h
  split at h
  · cases h
  rename_i hpop
  split at h
  · cases h
  rename_i hsrc
  split at h
  · cases h
  rename_i hid
  dsimp only at h
  split at h
  · cases h
  · cases h
  rename_i reductions postedAmount quantity historicalBasis hloop
  split at h
  · cases h
  · cases h
  rename_i posting hposting
  simp only [Except.ok.injEq, InventoryPostedReductionGroupResult.prepared.injEq] at h
  subst h
  rw [ofQuantize_eq_ok_iff] at hloop
  exact ⟨⟨reductions, posting, by simpa using hpop, by simpa using hsrc, by simpa using hid, hloop,
    hposting, rfl, rfl⟩⟩

namespace InventoryOwnership

/-- The reductions of a group are one for each entry, each prepared for its entry. -/
theorem ReductionsPrepared.forall₂ {context : InventoryPostedGroupContext} :
    ∀ {index : Nat} {entries : List InventoryPostedReductionEntry}
      {reductions : List InventoryPostedReduction},
      ReductionsPrepared context index entries reductions →
      List.Forall₂ (fun entry reduction => ∃ origin,
        prepareInventoryPostedReduction entry.anchor entry.position entry.holding
          entry.allocation origin = .ok (.prepared reduction)) entries reductions
  | _, [], [], _ => .nil
  | _, [], _ :: _, h => h.elim
  | _, _ :: _, [], h => h.elim
  | _, _ :: _, _ :: _, h => .cons ⟨_, h.1⟩ (ReductionsPrepared.forall₂ h.2)

/-- Sums over two lists related one by one, of values that agree one by one, agree. -/
theorem forall₂_sum_eq {α β : Type} {R : α → β → Prop} {f : α → ℚ} {g : β → ℚ}
    (hfg : ∀ a b, R a b → f a = g b) :
    ∀ {as : List α} {bs : List β}, List.Forall₂ R as bs → (as.map f).sum = (bs.map g).sum
  | [], [], _ => rfl
  | _ :: _, _ :: _, .cons hab hrest => by
    simp only [List.map_cons, List.sum_cons, hfg _ _ hab, forall₂_sum_eq hfg hrest]

/-- The movements of a group are as many as its entries and reductions. -/
theorem reductionGroupMovements_length (context : InventoryPostedReductionGroupContext)
    (posting : Option CanonicalPostingReference) :
    ∀ (index : Nat) (entries : List InventoryPostedReductionEntry)
      (reductions : List InventoryPostedReduction),
      (reductionGroupMovements context posting index entries reductions).length =
        min entries.length reductions.length
  | _, [], _ => by simp [reductionGroupMovements]
  | _, _ :: _, [] => by simp [reductionGroupMovements]
  | index, _ :: entries, _ :: reductions => by
    simp [reductionGroupMovements, reductionGroupMovements_length context posting (index + 1)
      entries reductions, Nat.succ_min_succ]

/-- What prepared reductions post is minus what their shares post, summed. -/
theorem sum_postedAmount_eq_neg {entries : List InventoryPostedReductionEntry}
    {reductions : List InventoryPostedReduction}
    (h : List.Forall₂ (fun entry reduction => ∃ origin,
      prepareInventoryPostedReduction entry.anchor entry.position entry.holding
        entry.allocation origin = .ok (.prepared reduction)) entries reductions)
    (hE : ∀ entry ∈ entries, entry.WF) :
    (reductions.map (·.postedAmount.toRat)).sum =
      -(reductions.map (·.reductionProof.postedAmount.toRat)).sum := by
  induction h with
  | nil => simp
  | @cons entry reduction entries reductions hhead _ ih =>
    obtain ⟨origin, hprep⟩ := hhead
    have hW := hE entry (by simp)
    obtain ⟨-, -, -, -, -, -, -, -, hr, -⟩ := prepareInventoryPostedReduction_posted hW.anchor
      hW.position hW.holding hW.allocation hprep
    have hrest := ih (fun e he => hE e (List.mem_cons_of_mem _ he))
    simp only [List.map_cons, List.sum_cons]
    rw [hr, hrest]
    ring

end InventoryOwnership

open InventoryOwnership in
/-- A prepared reduction group conserves exactly: it is one reduction per entry, in holding order,
each prepared for its entry and each entry of the group's one coordinate; the group's money is the
sum of the reductions' posted amounts, which is minus the sum of their shares' posted amounts; its
quantity and historical basis are the sums of the allocations'; and it has one movement and one
holding after for each entry. -/
theorem prepareInventoryPostedReductionGroup_conserved
    {context : InventoryPostedReductionGroupContext} {entries : List InventoryPostedReductionEntry}
    {journalLink : Option InventoryPostedJournalLink} {group : InventoryPostedReductionGroup}
    (hE : ∀ entry ∈ entries, entry.WF)
    (h : prepareInventoryPostedReductionGroup context entries journalLink = .ok (.prepared group)) :
    ∃ reductions,
      ReductionsPrepared context.toInventoryPostedGroupContext 0 (reductionGroupOrdered entries)
        reductions ∧
      group.afterHoldings = reductions.map (·.afterHolding) ∧
      group.movements.length = entries.length ∧ group.afterHoldings.length = entries.length ∧
      (∀ entry ∈ entries, groupCoordinateMismatch context.bookId (reductionGroupCoordinate entries)
        entry.anchor.coordinate = false) ∧
      group.postedAmount.toRat = (reductions.map (·.postedAmount.toRat)).sum ∧
      group.postedAmount.toRat = -(reductions.map (·.reductionProof.postedAmount.toRat)).sum ∧
      group.quantity.toRat = (entries.map (·.allocation.allocatedQuantity.toRat)).sum ∧
      group.historicalBasis.toRat = (entries.map (·.allocation.allocatedTotalBasis.toRat)).sum := by
  obtain ⟨v⟩ := prepareInventoryPostedReductionGroup_prepared h
  have hperm := sortByText_perm (·.holding.id.value) entries
  have hEo : ∀ entry ∈ reductionGroupOrdered entries, entry.WF := fun e he =>
    hE e (hperm.subset he)
  obtain ⟨hprep, hcoord, -, -, -, ht, hq, hb⟩ := reductionGroupLoop_proceed ExactRational.zero_wf
    ExactRational.zero_wf ExactRational.zero_wf (fun e he => (hEo e he).allocation) v.loop
  have h2 := hprep.forall₂
  have hlen := h2.length_eq
  have hordlen : (reductionGroupOrdered entries).length = entries.length := hperm.length_eq
  refine ⟨v.reductions, hprep, v.afterHoldings, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩
  · rw [v.movements, reductionGroupMovements_length, ← hlen, Nat.min_self, hordlen]
  · rw [v.afterHoldings, List.length_map, ← hlen, hordlen]
  · intro e he
    exact hcoord e (hperm.symm.subset he)
  · rw [ht, ExactRational.zero_toRat, zero_add]
  · rw [ht, ExactRational.zero_toRat, zero_add]
    exact sum_postedAmount_eq_neg h2 hEo
  · rw [hq, ExactRational.zero_toRat, zero_add]
    exact (hperm.map _).sum_eq
  · rw [hb, ExactRational.zero_toRat, zero_add]
    exact (hperm.map _).sum_eq

namespace InventoryOwnership

/-- When the attribution test of a posting passes: the posting is of the account, units commodity
and currency asked for, its dimensions sorted are the ones asked for, it carries the money asked
for, exactly the quantity asked for, and a cost basis in that currency of exactly the basis asked
for. -/
theorem postingAttributionInvalid_false {accountId : AccountId} {unitsCommodityId : CommodityId}
    {functionalCommodityId : CommodityId} {dimensionMemberIds : List DimensionMemberId}
    {actual : Posting} {money quantity basis : ExactRational}
    (h : postingAttributionInvalid accountId unitsCommodityId functionalCommodityId
      dimensionMemberIds actual money quantity basis = .ok false) :
    actual.accountId = accountId ∧ actual.units.commodityId = unitsCommodityId ∧
      actual.bookValue.functionalCommodityId = functionalCommodityId ∧
      sortDimensions actual.dimensionMemberIds = dimensionMemberIds ∧
      actual.bookValue.amount.toRat = money.toRat ∧ actual.units.canonicalNumber = quantity ∧
      ∃ costBasis, actual.costBasis = some costBasis ∧
        costBasis.basisCommodityId = functionalCommodityId ∧ costBasis.totalBasis = basis := by
  unfold postingAttributionInvalid at h
  dsimp only at h
  split_ifs at h with hcond
  · cases h
  simp only [Bool.or_eq_true, bne_iff_ne, ne_eq, not_or, not_not, Bool.not_eq_true] at hcond
  obtain ⟨⟨⟨⟨hacct, hunits⟩, hcur⟩, hlen⟩, hdiff⟩ := hcond
  have hdims := (someDiffersAt_eq_false_iff hlen).mp hdiff
  split at h
  · cases h
  rename_i amount hamount
  rw [liftExact_eq_ok_iff] at hamount
  simp only [Except.ok.injEq, Bool.or_eq_false_iff, Bool.not_eq_false',
    exactRational_equals_iff_eq] at h
  obtain ⟨⟨hmoney, hqty⟩, hcb⟩ := h
  refine ⟨hacct, hunits, hcur, hdims, ?_, hqty, ?_⟩
  · rw [← decimal_toRational_toRat hamount, hmoney]
  · revert hcb
    cases hc : actual.costBasis with
    | none => intro hcb; cases hcb
    | some costBasis =>
      intro hcb
      simp only [Bool.or_eq_false_iff, bne_eq_false_iff_eq, Bool.not_eq_false',
        exactRational_equals_iff_eq] at hcb
      exact ⟨costBasis, rfl, hcb.1, hcb.2⟩

end InventoryOwnership

open InventoryOwnership in
/-- The posting of a prepared reduction group: an all-zero group has no journal link; a
money-bearing group is linked to a journal source that matches its command, book, currency,
revision, period and date with a reproducible hash, with exactly one posting of the given
identifier, which is of the group's account, units commodity, currency and dimensions and carries
the group's signed money, the quantity taken out and the historical basis taken out, and the group's
posting reference is the reference to that posting. -/
theorem prepareInventoryPostedReductionGroup_posting
    {context : InventoryPostedReductionGroupContext} {entries : List InventoryPostedReductionEntry}
    {journalLink : Option InventoryPostedJournalLink} {group : InventoryPostedReductionGroup}
    (h : prepareInventoryPostedReductionGroup context entries journalLink = .ok (.prepared group)) :
    let c := reductionGroupCoordinate entries
    (group.postedAmount.isZero = true → journalLink = none) ∧
      (group.postedAmount.isZero = false → ∃ link actual key,
        journalLink = some link ∧
        link.source.journal.postings.filter (fun p => p.id == link.postingId) = [actual] ∧
        journalSourceMismatch context.toInventoryReductionEffectContext c.functionalCommodityId
          link.source = false ∧
        actual.accountId = c.accountId ∧ actual.units.commodityId = c.unitsCommodityId ∧
        actual.bookValue.functionalCommodityId = c.functionalCommodityId ∧
        sortDimensions actual.dimensionMemberIds = c.dimensionMemberIds ∧
        actual.bookValue.amount.toRat = group.postedAmount.toRat ∧
        actual.units.canonicalNumber.toRat = -group.quantity.toRat ∧
        (∃ costBasis, actual.costBasis = some costBasis ∧
          costBasis.basisCommodityId = c.functionalCommodityId ∧
          costBasis.totalBasis.toRat = -group.historicalBasis.toRat) ∧
        effectKey link.source.effectKey = .ok key ∧
        ∀ (view : ReductionGroupView context entries journalLink group),
          view.posting = some (createCanonicalPostingReference link.referenceId context.bookId
            link.source.journal.id actual key)) := by
  intro c
  constructor
  · intro hz
    cases journalLink with
    | none => rfl
    | some link =>
      exfalso
      obtain ⟨v⟩ := prepareInventoryPostedReductionGroup_prepared h
      have hstep := v.postingStep
      unfold reductionGroupPosting at hstep
      simp only [hz, ↓reduceIte, Except.ok.injEq, reduceCtorEq] at hstep
  · intro hz
    cases journalLink with
    | none =>
      exfalso
      obtain ⟨v⟩ := prepareInventoryPostedReductionGroup_prepared h
      have hstep := v.postingStep
      unfold reductionGroupPosting at hstep
      simp only [hz, Bool.false_eq_true, ↓reduceIte, Except.ok.injEq, reduceCtorEq] at hstep
    | some link =>
      obtain ⟨v⟩ := prepareInventoryPostedReductionGroup_prepared h
      have hstep := v.postingStep
      unfold reductionGroupPosting at hstep
      simp only [hz, Bool.false_eq_true, ↓reduceIte] at hstep
      split at hstep
      · simp at hstep
      rename_i hmismatch
      split at hstep
      · rename_i actual hfilter
        split at hstep
        · simp at hstep
        · simp at hstep
        rename_i hattr
        rw [ofQuantize_eq_ok_iff] at hattr
        split at hstep
        · simp at hstep
        rename_i key hkey
        obtain ⟨hacct, hunits, hcur, hdims, hmoney, hqty, costBasis, hcb, hcbc, hcbt⟩ :=
          postingAttributionInvalid_false hattr
        refine ⟨link, actual, key, rfl, hfilter, by simpa using hmismatch, hacct, hunits, hcur,
          hdims, hmoney, by rw [hqty, ExactRational.negate_toRat], ⟨costBasis, hcb, hcbc,
          by rw [hcbt, ExactRational.negate_toRat]⟩, hkey, ?_⟩
        intro view
        have hview := view.postingStep
        unfold reductionGroupPosting at hview
        simp only [hz, Bool.false_eq_true, ↓reduceIte, hfilter, hkey] at hview
        simp only [show journalSourceMismatch context.toInventoryReductionEffectContext
          (reductionGroupCoordinate entries).functionalCommodityId link.source = false by
            simpa using hmismatch, Bool.false_eq_true, ↓reduceIte] at hview
        rw [show InventoryOwnershipErr.ofQuantize (postingAttributionInvalid
          (reductionGroupCoordinate entries).accountId
          (reductionGroupCoordinate entries).unitsCommodityId
          (reductionGroupCoordinate entries).functionalCommodityId
          (reductionGroupCoordinate entries).dimensionMemberIds actual group.postedAmount
          group.quantity.negate group.historicalBasis.negate) = .ok false by
            rw [ofQuantize_eq_ok_iff]; exact hattr] at hview
        simp only [Except.ok.injEq, OwnershipStep.proceed.injEq] at hview
        exact hview.symm
      · simp at hstep

end Rastrata.Kernel
